const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pathToFileURL } = require('url');
const { EventEmitter } = require('events');

const STATIC_ROOT = path.resolve(__dirname, '..', '..', 'static');
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MOCK = process.env.MOCK === '1' || process.env.MOCK === 'true';
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const INGEST_MAX_BYTES = 65536;

// --- Saved patch presets (the audio editors' "Save preset") -----------------
// The ONLY writable surface on this server. Hardened against the obvious risks
// for a local dev write endpoint (the server binds 0.0.0.0 for the LAN-facing
// visualizer, so writes are gated hard):
//   - loopback-only (like /ingest) — never writable from the LAN;
//   - fixed root: files only ever land under static/audio/presets/<type>/;
//   - type whitelist + strict filename charset (no '.'/'/'/traversal);
//   - request body capped small (a patch is ~1-2 KB);
//   - the JSON must validate against the real patch schema (shared/patch-schema.js)
//     — every field present, correct type/range/enum, no unknown keys;
//   - atomic write (tmp + rename), refuse to follow a symlink, cap file count.
const PRESETS_ROOT = path.resolve(STATIC_ROOT, 'audio', 'presets');
const PRESET_TYPES = new Set(['fm', 'bass', 'wt']);
const PRESET_MAX_BYTES = 16384;                       // ~10× a real patch
const PRESET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/; // no dots/slashes
const PRESET_WTID_RE = /^[A-Za-z0-9_-]{1,32}$/;       // wavetable-id field
const MAX_PRESETS_PER_TYPE = 200;                     // disk/inode DOS cap

const inputBus = new EventEmitter();
const inputState = Object.create(null);

function publish(name, value) {
  if (typeof name !== 'string' || !name) return;
  const prev = inputState[name];
  if (prev && prev.value === value) return;
  const entry = { name, value, ts: Date.now() };
  inputState[name] = entry;
  inputBus.emit('change', entry);
}

if (MOCK) {
  require('./inputs/mock')({ publish });
  console.log('mock source: enabled');
}

// Daisy song-position tail (PLAN_USB_COMPOSITE Phase D). Enable with DAISY=1
// (defaults to /dev/ttyACM0) or by setting DAISY_SERIAL to the port path.
const DAISY = process.env.DAISY === '1' || process.env.DAISY === 'true' || !!process.env.DAISY_SERIAL;
if (DAISY) {
  // `bus` lets it tail distance_cm / freeze and write them back to the Daisy as
  // CC frames on the same port (Phase E).
  require('./inputs/daisy-position')({ publish, bus: inputBus });
  console.log('daisy-position source: enabled');
}

const sseClients = new Set();
inputBus.on('change', (entry) => {
  const payload = `event: change\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* client gone */ }
  }
});

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  for (const entry of Object.values(inputState)) {
    res.write(`event: change\ndata: ${JSON.stringify(entry)}\n\n`);
  }
  res.write(`event: ready\ndata: {}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch { /* */ }
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

// POST /ingest — accepts publications from the Python sensor sidecar.
// Restricted to loopback connections; optionally requires INGEST_TOKEN.
// Body: either a single {name, value} or an array of those.
function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1'
      || a === '::1'
      || a === '::ffff:127.0.0.1'
      || a.startsWith('127.');
}

function handleIngest(req, res) {
  if (!isLoopback(req)) {
    res.writeHead(403); res.end('localhost only'); return;
  }
  if (INGEST_TOKEN && req.headers['x-ingest-token'] !== INGEST_TOKEN) {
    res.writeHead(401); res.end('bad token'); return;
  }
  let total = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > INGEST_MAX_BYTES) {
      res.writeHead(413); res.end('payload too large');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { res.writeHead(400); res.end('bad json'); return; }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    let accepted = 0;
    for (const item of items) {
      if (item && typeof item === 'object' && typeof item.name === 'string') {
        publish(item.name, item.value);
        accepted++;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted }));
  });
}

// Lazily import the shared ESM patch schema so server-side validation uses the
// exact same field/range/enum definitions the editor and Rust DSP do. Cached.
let schemaModPromise = null;
function loadSchemas() {
  if (!schemaModPromise) {
    const url = pathToFileURL(path.resolve(STATIC_ROOT, 'audio', 'shared', 'patch-schema.js'));
    schemaModPromise = import(url.href).catch((e) => { schemaModPromise = null; throw e; });
  }
  return schemaModPromise;
}
function schemaForType(mod, type) {
  return ({ fm: mod.FM_PATCH, bass: mod.BASS_PATCH, wt: mod.WT_PATCH })[type];
}

// Validate a candidate patch against a schema. Returns null if OK, else a
// short reason. Requires every schema field, correct types/ranges/enums, and
// rejects unknown keys — so a saved file is always a well-formed patch.
function validatePatch(schema, obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not an object';
  const extra = new Set(Object.keys(obj));
  for (const p of schema.params) {
    if (!(p.key in obj)) return `missing ${p.key}`;
    extra.delete(p.key);
    const v = obj[p.key];
    if (p.widget === 'wavetable') {
      if (typeof v !== 'string' || !PRESET_WTID_RE.test(v)) return `bad ${p.key}`;
    } else if (p.widget === 'wavepos') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return `bad ${p.key}`;
    } else if (p.options) {
      if (!p.options.includes(v)) return `bad enum ${p.key}`;
    } else {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `bad ${p.key}`;
      const eps = Math.abs(p.max - p.min) * 1e-6 + 1e-9;
      if (v < p.min - eps || v > p.max + eps) return `${p.key} out of range`;
    }
  }
  if (extra.size) return `unknown field(s): ${[...extra].slice(0, 5).join(',')}`;
  return null;
}

// Resolve <root>/<type>/<name>.json, re-checking it can't escape the type dir.
function presetPath(type, name) {
  const dir = path.join(PRESETS_ROOT, type);
  const file = path.join(dir, `${name}.json`);
  if (file !== path.join(dir, `${name}.json`) || !file.startsWith(dir + path.sep)) return null;
  return { dir, file };
}

// POST /api/presets/:type  body {name, patch}  -> writes a validated preset.
function handlePresetSave(req, res, type) {
  if (!isLoopback(req)) { res.writeHead(403); res.end('localhost only'); return; }
  let total = 0;
  const chunks = [];
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    total += chunk.length;
    if (total > PRESET_MAX_BYTES) { aborted = true; res.writeHead(413); res.end('payload too large'); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted || res.writableEnded) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { res.writeHead(400); res.end('bad json'); return; }
    const name = (body && typeof body.name === 'string') ? body.name.trim() : '';
    if (!PRESET_NAME_RE.test(name)) { res.writeHead(400); res.end('bad preset name'); return; }
    const loc = presetPath(type, name);
    if (!loc) { res.writeHead(400); res.end('bad path'); return; }

    loadSchemas().then(async (mod) => {
      const err = validatePatch(schemaForType(mod, type), body.patch);
      if (err) { res.writeHead(422); res.end(`invalid patch: ${err}`); return; }
      await fsp.mkdir(loc.dir, { recursive: true });
      const files = (await fsp.readdir(loc.dir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
      if (!files.includes(`${name}.json`) && files.length >= MAX_PRESETS_PER_TYPE) {
        res.writeHead(507); res.end('too many presets'); return;
      }
      // Never write *through* a pre-existing symlink (could escape the root).
      try { if ((await fsp.lstat(loc.file)).isSymbolicLink()) { res.writeHead(409); res.end('refusing symlink'); return; } }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const tmp = path.join(loc.dir, `.tmp-${process.pid}-${Date.now()}`);
      await fsp.writeFile(tmp, JSON.stringify(body.patch, null, 2), { encoding: 'utf8', mode: 0o644 });
      await fsp.rename(tmp, loc.file);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ saved: name }));
    }).catch(() => { if (!res.writableEnded) { res.writeHead(500); res.end('save failed'); } });
  });
}

// GET /api/presets/:type -> { name: patch, ... } for the editor dropdown.
function handlePresetList(req, res, type) {
  if (!isLoopback(req)) { res.writeHead(403); res.end('localhost only'); return; }
  const dir = path.join(PRESETS_ROOT, type);
  (async () => {
    let names;
    try { names = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('.')); }
    catch (e) { if (e.code === 'ENOENT') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; } throw e; }
    const out = {};
    for (const f of names.slice(0, MAX_PRESETS_PER_TYPE)) {
      try {
        const txt = await fsp.readFile(path.join(dir, f), 'utf8');
        if (txt.length <= PRESET_MAX_BYTES) out[f.replace(/\.json$/, '')] = JSON.parse(txt);
      } catch { /* skip unreadable/corrupt */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  })().catch(() => { if (!res.writableEnded) { res.writeHead(500); res.end('list failed'); } });
}

// DELETE /api/presets/:type/:name -> removes one saved preset.
function handlePresetDelete(req, res, type, name) {
  if (!isLoopback(req)) { res.writeHead(403); res.end('localhost only'); return; }
  if (!PRESET_NAME_RE.test(name)) { res.writeHead(400); res.end('bad preset name'); return; }
  const loc = presetPath(type, name);
  if (!loc) { res.writeHead(400); res.end('bad path'); return; }
  (async () => {
    try { if ((await fsp.lstat(loc.file)).isSymbolicLink()) { res.writeHead(409); res.end('refusing symlink'); return; } }
    catch (e) { if (e.code === 'ENOENT') { res.writeHead(404); res.end('not found'); return; } throw e; }
    await fsp.unlink(loc.file);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: name }));
  })().catch(() => { if (!res.writableEnded) { res.writeHead(500); res.end('delete failed'); } });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.mp3':  'audio/mpeg',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
};

function safeJoin(root, urlPath) {
  const clean = urlPath.split('?')[0].split('#')[0];
  let decoded;
  try { decoded = decodeURIComponent(clean); }
  catch { return null; }
  const resolved = path.resolve(root, '.' + decoded);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function serveStatic(req, res) {
  let urlPath = (req.url || '/').split('?')[0].split('#')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = safeJoin(STATIC_ROOT, urlPath);
  if (!filePath) { res.writeHead(403); res.end('forbidden'); return; }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const ctype = MIME[ext] || 'application/octet-stream';
    const range = req.headers.range;
    // Range support — iOS Safari requires it for <audio>.
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] === '' ? Math.max(0, st.size - parseInt(m[2], 10)) : parseInt(m[1], 10);
        let end = m[2] === '' ? st.size - 1 : Math.min(parseInt(m[2], 10), st.size - 1);
        if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && end < st.size) {
          res.writeHead(206, {
            'Content-Type': ctype,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${st.size}`,
            'Accept-Ranges': 'bytes',
          });
          fs.createReadStream(filePath, { start, end }).pipe(res);
          return;
        }
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
    }
    res.writeHead(200, {
      'Content-Type': ctype,
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/events' && req.method === 'GET') return handleSSE(req, res);
  if (req.url === '/ingest' && req.method === 'POST') return handleIngest(req, res);

  // Saved-preset API. The type/name regex is itself a guard: type is whitelisted
  // and name is a single non-slash segment (no path traversal in the URL).
  const presetMatch = /^\/api\/presets\/(fm|bass|wt)(?:\/([^/]+))?$/.exec((req.url || '').split('?')[0]);
  if (presetMatch) {
    const type = presetMatch[1];
    let name = null;
    if (presetMatch[2] != null) {
      try { name = decodeURIComponent(presetMatch[2]); } catch { res.writeHead(400); res.end('bad name'); return; }
    }
    if (req.method === 'GET' && name == null) return handlePresetList(req, res, type);
    if (req.method === 'POST' && name == null) return handlePresetSave(req, res, type);
    if (req.method === 'DELETE' && name != null) return handlePresetDelete(req, res, type, name);
    res.writeHead(405); res.end('method not allowed'); return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('method not allowed'); return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  const hostShown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`ambient_viz server listening on http://${hostShown}:${PORT}`);
  console.log(`static root: ${STATIC_ROOT}`);
  console.log(`ingest token: ${INGEST_TOKEN ? 'required' : 'disabled (localhost-only)'}`);
});
