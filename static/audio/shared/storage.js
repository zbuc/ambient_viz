// storage.js — loading and saving for the audio tools.
//
// The Node server (server/src/index.js) currently serves static files
// read-only — there is no write endpoint. So:
//   - LOAD  reads files served out of static/ via fetch().
//   - SAVE  triggers a browser download of the serialized text; the user drops
//           the file back into static/ by hand. When a write route is added,
//           swap saveText() for a fetch(POST) — callers don't change.
//   - DRAFTS autosave to localStorage so an in-progress edit survives a reload.

/** Fetch a text asset served from static/ (path relative to this tool page). */
export async function loadText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`load ${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

/** Trigger a download of `text` as `filename`. Stand-in for a server write. */
export function saveText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has grabbed the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Read a file the user picks from disk (e.g. a .pat or .json). */
export function openFile(accept = '') {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) { reject(new Error('no file chosen')); return; }
      const reader = new FileReader();
      reader.onload = () => resolve({ name: f.name, text: String(reader.result) });
      reader.onerror = () => reject(reader.error);
      reader.readAsText(f);
    };
    input.click();
  });
}

// --- localStorage drafts -------------------------------------------------
const DRAFT_PREFIX = 'ambient_audio_draft:';

export function saveDraft(key, obj) {
  try { localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify(obj)); } catch (_) {}
}
export function loadDraft(key) {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}
export function clearDraft(key) {
  try { localStorage.removeItem(DRAFT_PREFIX + key); } catch (_) {}
}

// --- saved presets (server-backed) ---------------------------------------
// Persisted as files under static/audio/presets/<type>/ via the Node server's
// loopback-only write API. Same-origin, so this only works when the page is
// served by that server (not a bare static file server). All calls degrade
// gracefully: listPresets returns {} if the API is absent, so the editor still
// shows its built-in presets. `type` is one of 'fm' | 'bass' | 'wt'.
const PRESET_API = '/api/presets';

/** Fetch all saved presets for a type as `{ name: patch }` (empty on failure). */
export async function listPresets(type) {
  try {
    const r = await fetch(`${PRESET_API}/${type}`, { cache: 'no-store' });
    return r.ok ? await r.json() : {};
  } catch { return {}; }
}

/** Save (or overwrite) a named preset. Throws with the server's reason on error. */
export async function savePreset(type, name, patch) {
  const r = await fetch(`${PRESET_API}/${type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, patch }),
  });
  if (!r.ok) throw new Error((await r.text()) || `save failed (${r.status})`);
  return r.json();
}

/** Delete a saved preset by name. */
export async function deletePreset(type, name) {
  const r = await fetch(`${PRESET_API}/${type}/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.text()) || `delete failed (${r.status})`);
}
