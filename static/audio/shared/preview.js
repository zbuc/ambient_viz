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

  /** GET + parse JSON (null on failure). */
  async function get(path) {
    try {
      const r = await fetch(`${server}${path}`, { cache: 'no-store' });
      setOnline(true);
      return r.ok ? await r.json() : null;
    } catch {
      setOnline(false);
      return null;
    }
  }

  /** POST + parse the JSON response (null on failure). */
  async function postJson(path, body) {
    try {
      const r = await fetch(`${server}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      setOnline(true);
      return r.ok ? await r.json() : null;
    } catch {
      setOnline(false);
      return null;
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

  // --- FX chain (composite instrument) -------------------------------------
  const fxParamDebounce = new Map(); // `${index}:${name}` -> timer

  const fx = {
    catalog: () => get('/fx/catalog'),                  // [{kind, params:[{name,default,min,max}]}]
    chain: () => get('/fx/chain'),                      // [{kind, params:{..}}]
    setChain: (nodes) => post('/fx/chain', nodes),
    add: (kind, index) => post('/fx/add', index == null ? { kind } : { kind, index }),
    remove: (index) => post('/fx/remove', { index }),
    move: (from, to) => post('/fx/move', { from, to }),
    /** Tweak one effect param, coalescing rapid slider moves per (index,name). */
    setParam(index, name, value) {
      const key = `${index}:${name}`;
      const prev = fxParamDebounce.get(key);
      if (prev) clearTimeout(prev);
      fxParamDebounce.set(key, setTimeout(() => {
        fxParamDebounce.delete(key);
        post('/fx/param', { index, name, value });
      }, 40));
    },
  };

  // --- presets (fx + instrument live on patch_server) ----------------------
  const fxPresets = {
    list: () => get('/fx/presets'),
    save: (name) => post('/fx/preset/save', { name }),
    load: (name) => post('/fx/preset/load', { name }),
    remove: (name) => post('/fx/preset/delete', { name }),
  };
  const instruments = {
    list: () => get('/instrument/presets'),
    save: (name) => post('/instrument/save', { name }),
    load: (name) => postJson('/instrument/load', { name }), // returns the loaded Instrument
    remove: (name) => post('/instrument/delete', { name }),
  };

  return {
    server,
    probe,
    sendPatch,
    trigger,
    panic,
    fx,
    fxPresets,
    instruments,
    get online() { return online; },
  };
}
