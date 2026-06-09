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
