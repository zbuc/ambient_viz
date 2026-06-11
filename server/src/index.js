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

// Phase-0 baseline capture (MIGRATION_PLAN.md) — read-only boundary tap,
// enabled by CAPTURE=1 / CAPTURE_DIR. No-ops entirely when off.
const capture = require('./capture');

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

// orrery bus.v1 (phase 1, pure shadow): every legacy event is dual-written as
// a namespaced bus signal; nothing consumes the bus yet. The inspector at
// /inspector renders it. Legacy SSE below is untouched — PM impact zero.
const { OrreryBus, toValue } = require('./bus');
const attachBusAdapter = require('./bus-adapter');
const orreryBus = new OrreryBus();
let busAdapter = null; // set after capture.init; holds the legacy->path MAP

function publish(name, value) {
  if (typeof name !== 'string' || !name) return;
  const prev = inputState[name];
  if (prev && prev.value === value) return;
  const entry = { name, value, ts: Date.now() };
  inputState[name] = entry;
  inputBus.emit('change', entry);
}

capture.init({
  config: { port: PORT, host: HOST, mock: MOCK, ingest_token: INGEST_TOKEN ? '<set>' : '' },
});

// Manifest registry + ProjectPolicy, WARN mode (phase 3). Loaded BEFORE the
// adapter so manifests are the authoritative declaration for every path the
// adapter writes. A missing/broken manifest dir degrades to phase-1 behavior
// (no policy), loudly.
const { loadRegistry, applyRegistry } = require('./registry');
let registry = null;
try {
  registry = loadRegistry(path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest'));
  applyRegistry(registry, orreryBus);
  console.log(`orrery registry: ${registry.bySourceId.size} modules for "${registry.project}" `
    + `(modes auth:${registry.modes.auth} sig:${registry.modes.signature} `
    + `pri:${registry.modes.priority} time:${registry.modes.time_sync})`);
  for (const w of registry.warnings) console.warn(`orrery registry WARN: ${w}`);
} catch (e) {
  console.warn(`orrery registry: NOT LOADED (${e.message}) — bus runs without policy`);
}

// The compiled router graphs (phase 4 tape cutover, phase 5 visualizer
// mappings): ONE GRAPH FILE PER MAPPING under manifest/graphs/, each running
// as its own engine over the shared bus, so a mapping ships, rolls back, and
// is deleted independently.
//   - tape-failure.json OWNS fx.tape.failure @300 — CC 23 IS its output (the
//     legacy ramp died in 4F; rollback is artifact-level).
//   - viz-twist.json / viz-bitmap.json publish fx.viz.twist_gain /
//     fx.viz.bitmap_x @300 (sole writers) — since the phase-5 cutover the
//     kiosk page consumes them unconditionally (legacy in-page ramps and
//     flags deleted; rollback is artifact-level).
//   - occupancy.json (phase 6.1 SHADOW) publishes derived.room.occupied @300
//     under its OWN module identity (bridge/router-occupancy, role
//     occupancy_router — least authority per writer). NOTHING consumes it:
//     legacy computeOccupancy in daisy-position stays authoritative until a
//     gate session shows the lanes MATCH (tools/sim/validate-occupancy.js);
//     only then does legacy rebind (the approved 6.1 two-step).
// Every engine's writes are tapped into the capture stream (`bus_tx`) so a
// recorded session carries each live graph output for offline diffing
// (tools/sim/validate-tape.js, validate-twist.js). A graph that fails to
// compile degrades loudly to not-running WITHOUT taking the other graphs
// down — same doctrine as the registry above.
const routerEngines = [];
try {
  const { loadGraphDir } = require('./router-graph');
  const { GraphEngine } = require('./router-engine');
  const graphsDir = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest', 'graphs');
  const compileOpts = { instanceId: 'main' };
  if (registry) {
    compileOpts.declaredPaths = new Set();
    for (const rec of registry.bySourceId.values()) {
      for (const p of rec.declared.keys()) compileOpts.declaredPaths.add(p);
    }
    compileOpts.roles = new Map(registry.policy.roles.map((r) => [r.name, r]));
  }
  const { graphs, failures } = loadGraphDir(graphsDir, compileOpts);
  for (const f of failures) {
    console.error(`orrery router: ${f.file} NOT RUNNING (${f.errors.join('; ')})`
      + (f.file === 'tape-failure.json'
        ? ' — CC 23 (tape failure) WILL NOT MOVE; no legacy fallback since 4F.'
        : ' — its output paths stay silent.')
      + ' Fix the graph/manifests or redeploy the previous release.');
  }
  // Per-graph writer identity: each engine publishes under the module that
  // declared its outputs (default: the fx router). The occupancy graph gets
  // its own identity so policy can scope it to derived.room.* and the
  // inspector shows it as its own writer.
  const GRAPH_IDENTITY = {
    'occupancy.json': 'spiffe://pain-material.local/bridge/router-occupancy',
  };
  for (const g of graphs) {
    for (const w of g.compiled.warnings) console.warn(`orrery router WARN [${g.file}]: ${w}`);
    const engine = new GraphEngine({
      compiled: g.compiled,
      bus: orreryBus,
      sourceId: GRAPH_IDENTITY[g.file] || 'spiffe://pain-material.local/bridge/router',
      tap: (target, value) => capture.event('bus_tx', { path: target, value }),
    });
    engine.start();
    routerEngines.push({ file: g.file, engine });
    const sinks = g.compiled.outputs
      .map((id) => { const o = g.compiled.nodes.get(id).def; return `${o.target}@${o.priority || 0}`; })
      .join(', ');
    console.log(`orrery router: LIVE — ${g.compiled.nodes.size} nodes from ${g.file} -> ${sinks}`);
  }
  if (!graphs.length) {
    console.error('orrery router: NO GRAPHS RUNNING — every graph-driven mapping (CC 23 tape, viz twist) is silent.');
  }
} catch (e) {
  console.error(`orrery router: NOT RUNNING (${e.message}) — CC 23 (tape failure) WILL NOT MOVE; `
    + 'no legacy fallback since 4F. Fix the graph/manifests or redeploy the previous release.');
}

// The adapter attaches AFTER the engines start (the order the simulator has
// always used): its boot-time defaults claims (near/far, and since 6.1 the
// motion=false baseline) are real packets the graphs must SEE. motion
// declares no stale window, so its one boot claim is never keepalive-resent —
// an engine that started late would wait on it forever (found by the 6.1
// occupancy graph's silent boot on a sidecar-less machine).
busAdapter = attachBusAdapter({ bus: orreryBus, inputBus });
console.log(`orrery bus: shadow dual-write on (boot_epoch ${orreryBus.bootEpoch})`);

// Plugin host (phase 6.0, MIGRATION_PLAN.md): plugin.v1 code assets hosted in
// the bridge, instantiated from manifest/plugins/ (one file per instance —
// ship/cut/delete independently, same doctrine as graphs/). Phase 6.0 hosts
// only the toy_timer prove-out: a seeded random-interval pulse on
// seq.toy.pulse that nothing consumes — it exists to soak host tick, seeded
// PRNG, snapshot/restore, replay, and candidate-path inspection before the
// 6.1 trigger-stack port. Emissions are tapped into the capture (`plugin_tx`)
// so recorded sessions carry the candidate stream for offline diffing; seeds
// are recorded at boot (`plugin_init`) — a fixture without its seed is not
// replayable. A broken binding degrades loudly to that instance not running.
let pluginHost = null;
try {
  const { createPluginHost, loadBindingDir } = require('./plugin-host');
  const pluginsDir = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest', 'plugins');
  const { bindings, failures: loadFailures } = loadBindingDir(pluginsDir);
  const declared = new Map();
  if (registry) {
    for (const rec of registry.bySourceId.values()) {
      for (const [p, d] of rec.declared) declared.set(p, d);
    }
  }
  pluginHost = createPluginHost({
    bus: orreryBus,
    bindings,
    declared: registry ? declared : null,
    roles: registry ? new Map(registry.policy.roles.map((r) => [r.name, r])) : null,
    tap: (instance, sigPath, payload) => capture.event('plugin_tx', { instance, path: sigPath, payload }),
  });
  for (const f of [...loadFailures, ...pluginHost.failures]) {
    console.error(`orrery plugin-host: ${f.file} NOT RUNNING (${f.errors.join('; ')}) — its outputs stay silent.`);
  }
  for (const w of pluginHost.warnings) console.warn(`orrery plugin-host WARN: ${w}`);
  for (const inst of pluginHost.instances) {
    capture.event('plugin_init', { instance: inst.name, asset: inst.assetKey, seed: inst.seed, params: inst.params });
    console.log(`orrery plugin-host: LIVE — "${inst.name}" (${inst.assetKey}, seed ${inst.seed}) -> `
      + [...inst.outputs.values()].map((o) => o.path).join(', '));
  }
  if (!pluginHost.instances.length) console.warn('orrery plugin-host: no instances running');
} catch (e) {
  console.error(`orrery plugin-host: NOT RUNNING (${e.message}) — plugin outputs stay silent.`);
}

// ── bus-over-SSE (phase 2): the browser feed's transport ────────────────────
// GET /bus/events — retained-state replay on connect (the late-joiner
// contract, BUS_PROTOCOL.md), then live accepted packets. `_meta.*` stays off
// this wire (the inspector polls /inspector/state; the kiosk page doesn't
// need 60 diagnostic packets/s).
const busClients = new Set();
orreryBus.on('packet', (rec) => {
  if (!rec.accepted || busClients.size === 0) return;
  const body = rec.pkt.state || rec.pkt.event;
  if (!body || body.path.startsWith('_meta.')) return;
  // packetFrame annotates STATE packets with the arbitrated RESOLVED value —
  // feed consumers read state through arbitration, never packet payloads
  // (a shadowed writer's keepalive must not flap the derived state).
  const payload = `event: packet\ndata: ${JSON.stringify(orreryBus.packetFrame(rec))}\n\n`;
  for (const res of busClients) {
    try { res.write(payload); } catch { /* client gone */ }
  }
});

function handleBusSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  for (const r of orreryBus.retained()) {
    if (r.path.startsWith('_meta.')) continue;
    const pkt = {
      schema: 'bus.v1',
      source: { sourceId: r.sourceId, seq: 0, bootEpoch: orreryBus.bootEpoch },
      priority: 0,
      state: { path: r.path, value: toValue(r.value) },
    };
    res.write(`event: retained\ndata: ${JSON.stringify(pkt)}\n\n`);
  }
  // `capture` tells the kiosk page to start POSTing snapshots (it rode the
  // legacy /events ready frame until the phase-2 cutover deleted that
  // reader from the page).
  res.write(`event: ready\ndata: {"boot_epoch":${orreryBus.bootEpoch},"capture":${capture.enabled}}\n\n`);
  busClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch { /* */ }
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    busClients.delete(res);
  });
}

// GET /bus/map — the legacy-name <-> bus-path mapping, served from the one
// table in bus-adapter.js so the browser adapter can't drift from the bridge.
function handleBusMap(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify({ map: busAdapter.MAP, touch: busAdapter.TOUCH }));
}

// GET /inspector/state — the signal inspector's data: per path the resolved
// value plus every pre-resolution writer candidate and the enforcement truth
// values (read-only; LAN-readable on purpose — a remote inspector is the
// point of bus-native diagnostics).
function handleInspectorState(req, res) {
  const body = JSON.stringify({
    boot_epoch: orreryBus.bootEpoch,
    now_mono_ms: Math.round(orreryBus.nowMono() * 1000) / 1000,
    policy: registry ? {
      project: registry.project,
      modes: registry.modes,
      load_warnings: registry.warnings,
      warns_total: orreryBus.warnsTotal,
      recent_warns: orreryBus.warns.slice(-20),
    } : null,
    paths: orreryBus.snapshot(),
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(body);
}

// GET /plugins/state — the plugin host's inspection view: per instance the
// execution-contract truth values, seed + PRNG state, tick/emit/quarantine
// counters, the recent-emission ring (the candidate stream), and a live state
// snapshot. Read-only, LAN-readable like /inspector/state.
function handlePluginsState(req, res) {
  const body = JSON.stringify({
    running: !!pluginHost,
    instances: pluginHost ? pluginHost.inspect() : [],
    failures: pluginHost ? pluginHost.failures : [],
    warnings: pluginHost ? pluginHost.warnings : [],
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(body);
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
  // CC frames on the same port (Phase E). `orreryBus` makes it a formal
  // transport adapter: CC 23 consumes the bus's arbitrated RESOLVED
  // fx.tape.failure, owned solely by the router graph (4F deleted the ramp).
  require('./inputs/daisy-position')({ publish, bus: inputBus, orreryBus });
  console.log('daisy-position source: enabled');
}

const sseClients = new Set();
inputBus.on('change', (entry) => {
  const payload = `event: change\ndata: ${JSON.stringify(entry)}\n\n`;
  // The logical output stream: one event per broadcast, regardless of how
  // many clients (or none) were listening at that moment.
  capture.event('sse_out', { entry, n_clients: sseClients.size });
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* client gone */ }
  }
});

let sseClientSeq = 0;
function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const clientId = ++sseClientSeq;
  const initEntries = Object.values(inputState);
  capture.event('sse_connect', {
    client: clientId,
    remote: req.socket.remoteAddress || '',
    ua: req.headers['user-agent'] || '',
    init_entries: initEntries,
  });
  for (const entry of initEntries) {
    res.write(`event: change\ndata: ${JSON.stringify(entry)}\n\n`);
  }
  // `capture` tells the kiosk page to start POSTing AMBIENT_INPUTS snapshots.
  res.write(`event: ready\ndata: {"capture":${capture.enabled}}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch { /* */ }
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    capture.event('sse_disconnect', { client: clientId });
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
    capture.event('ingest_drop', { reason: 'non_loopback', remote: req.socket.remoteAddress || '' });
    res.writeHead(403); res.end('localhost only'); return;
  }
  if (INGEST_TOKEN && req.headers['x-ingest-token'] !== INGEST_TOKEN) {
    capture.event('ingest_drop', { reason: 'bad_token', remote: req.socket.remoteAddress || '' });
    res.writeHead(401); res.end('bad token'); return;
  }
  let total = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > INGEST_MAX_BYTES) {
      capture.event('ingest_drop', { reason: 'payload_too_large', bytes_seen: total, ...capture.rawField(Buffer.concat(chunks)) });
      res.writeHead(413); res.end('payload too large');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    const body = Buffer.concat(chunks);
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8')); }
    catch {
      capture.event('ingest_drop', { reason: 'bad_json', ...capture.rawField(body) });
      res.writeHead(400); res.end('bad json'); return;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    let accepted = 0;
    for (const item of items) {
      if (item && typeof item === 'object' && typeof item.name === 'string') {
        publish(item.name, item.value);
        accepted++;
      }
    }
    // Raw bytes AND decoded form, so a decode bug is discoverable from the
    // capture alone. Malformed items inside an otherwise-good batch are
    // counted here and visible in `raw`.
    capture.event('ingest', {
      ...capture.rawField(body),
      items,
      accepted,
      items_rejected: items.length - accepted,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted }));
  });
}

// POST /capture/snapshot — periodic window.AMBIENT_INPUTS snapshots from the
// kiosk page while capture is on (the page only POSTs when the SSE `ready`
// frame says capture is enabled). Loopback-only like /ingest; a 204 no-op when
// capture is off so a stale tab can't error-spam.
function handleCaptureSnapshot(req, res) {
  if (!isLoopback(req)) { res.writeHead(403); res.end('localhost only'); return; }
  let total = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > INGEST_MAX_BYTES) { res.writeHead(413); res.end('payload too large'); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    if (capture.enabled) {
      const body = Buffer.concat(chunks);
      let parsed = null;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { /* keep raw only */ }
      capture.event('browser_snapshot', { ...capture.rawField(body), snapshot: parsed });
    }
    res.writeHead(204); res.end();
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
  if (req.url === '/capture/snapshot' && req.method === 'POST') return handleCaptureSnapshot(req, res);
  if (req.url === '/inspector/state' && req.method === 'GET') return handleInspectorState(req, res);
  if (req.url === '/inspector' && req.method === 'GET') { req.url = '/inspector.html'; return serveStatic(req, res); }
  if (req.url === '/plugins/state' && req.method === 'GET') return handlePluginsState(req, res);
  if (req.url === '/bus/events' && req.method === 'GET') return handleBusSSE(req, res);
  if (req.url === '/bus/map' && req.method === 'GET') return handleBusMap(req, res);

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
