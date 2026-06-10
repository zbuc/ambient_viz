// preview.js — client for the native `patch_server` (daisy host bin) that
// auditions patches against the REAL Rust DSP on the Mac's audio output.
//
//   cargo run -p host --bin patch_server
//
// The editor stays fully usable with no server running (export-only); when the
// server is reachable, edits stream to it live. Override the address with
// localStorage 'ambient_preview_server' (e.g. for a server on another host).

const DEFAULT_SERVER = 'http://127.0.0.1:8765';

export function createPreview({ onStatus = () => {} } = {}) {
  const server = (() => {
    try { return localStorage.getItem('ambient_preview_server') || DEFAULT_SERVER; }
    catch { return DEFAULT_SERVER; }
  })();

  let online = false;
  let debounce = null;
  let pending = null;

  // `force` re-fires the status callback even when the state is unchanged — used
  // by an explicit probe() so a manual "click to reconnect" always re-renders
  // the pill (otherwise re-probing while already online would leave it stuck on
  // a transient "connecting…" label). The frequent post()→setOnline(true) path
  // stays change-guarded so it doesn't spam the callback.
  function setOnline(v, force = false) { if (force || v !== online) { online = v; onStatus(online); } }

  /** Check whether the server is up. Safe to call repeatedly. */
  async function probe() {
    try {
      const r = await fetch(`${server}/health`, { cache: 'no-store' });
      setOnline(r.ok, true);
    } catch { setOnline(false, true); }
    return online;
  }

  async function post(path, body) {
    try {
      const r = await fetch(`${server}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      setOnline(true);
      return r.ok;
    } catch {
      setOnline(false);
      return false;
    }
  }

  /** Stream a patch edit, coalescing rapid slider moves (~40 ms). */
  function sendPatch(kind, patch) {
    pending = { kind, patch: { ...patch } };
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      const p = pending; pending = null;
      if (p) post(`/${p.kind}/patch`, p.patch);
    }, 40);
  }

  /** Strike the voice. `note` omitted → server's configured default note. */
  function trigger(kind, note) {
    return post(`/${kind}/trigger`, note != null ? { note } : {});
  }

  /** Kill all audio on the server (bass sustain, FM tail, delay ring). */
  function panic() {
    return post('/panic', {});
  }

  return {
    server,
    probe,
    sendPatch,
    trigger,
    panic,
    get online() { return online; },
  };
}
