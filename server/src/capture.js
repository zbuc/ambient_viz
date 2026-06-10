// Phase-0 baseline capture (MIGRATION_PLAN.md). A read-only tap: when enabled
// it observes the bridge's boundaries and appends them, in the exact order the
// bridge observed them, to one JSONL stream. It never alters what it taps —
// PM impact must stay zero, so every entry point is wrapped in try/catch and a
// capture failure only disables capture, never the bridge.
//
// Enable with CAPTURE=1 (sessions land in projects/pain-material/fixtures/)
// or CAPTURE_DIR=/path (sessions land there instead — smoke tests use this).
//
// Layout per session:  <root>/<session_id>/meta.json    config/env/git SHA
//                      <root>/<session_id>/events.jsonl ordered boundary events
//
// Every event line carries:
//   seq        capture-order sequence number — THE ordering boundary. Replay
//              treats this order as canonical (invariant lock #1).
//   t_mono_ms  monotonic receive time at the bridge (perf_hooks, ms float)
//   t_wall_ms  wall clock (Date.now) — for humans; never used for ordering
//   kind       boundary event type (ingest / sse_out / serial_tx / ...)
// plus kind-specific fields. Raw payloads ride along as `raw` (utf8) or
// `raw_b64` (bytes that don't survive a utf8 round-trip) so decode bugs stay
// discoverable from the capture alone.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { performance } = require('perf_hooks');

const FORMAT_VERSION = 1;
const FLUSH_MS = 250;
const COUNTERS_MS = 60000;

const enabled = process.env.CAPTURE === '1' || process.env.CAPTURE === 'true' || !!process.env.CAPTURE_DIR;

let sessionDir = null;
let eventsPath = null;
let seq = 0;
let dead = false;            // a capture I/O failure flips this; bridge unaffected
let pending = [];            // batched lines awaiting flush
let flushing = false;
const counters = Object.create(null);

function nowMono() { return performance.now(); }

function bump(name, by = 1) { counters[name] = (counters[name] || 0) + by; }

// Raw payload field: utf8 when the bytes round-trip, else base64.
function rawField(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  const s = b.toString('utf8');
  if (Buffer.from(s, 'utf8').equals(b)) return { raw: s };
  return { raw_b64: b.toString('base64') };
}

function flush() {
  if (dead || flushing || pending.length === 0) return;
  flushing = true;
  const batch = pending.join('');
  pending = [];
  fs.appendFile(eventsPath, batch, (err) => {
    flushing = false;
    if (err) {
      dead = true;
      console.error(`capture: write failed, capture disabled: ${err.message}`);
      return;
    }
    if (pending.length) flush();
  });
}

function event(kind, fields) {
  if (!enabled || dead || !sessionDir) return;
  try {
    seq += 1;
    bump(`kind.${kind}`);
    const line = JSON.stringify({
      seq,
      t_mono_ms: Math.round(nowMono() * 1000) / 1000,
      t_wall_ms: Date.now(),
      kind,
      ...fields,
    });
    pending.push(line + '\n');
  } catch (e) {
    bump('capture_serialize_error');
  }
}

function gitSha(repoRoot) {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8', timeout: 2000 }).trim();
  } catch { return null; }
}

// Env in effect during capture: everything that shapes bridge behavior.
// INGEST_TOKEN is recorded as set/unset only — never the value.
const ENV_PREFIXES = ['PORT', 'HOST', 'MOCK', 'DAISY', 'MOTION_', 'BELL_', 'TOLL_', 'VOICE_', 'CAPTURE'];
function envSnapshot() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'INGEST_TOKEN') { out.INGEST_TOKEN = v ? '<set>' : ''; continue; }
    if (ENV_PREFIXES.some((p) => k === p || k.startsWith(p))) out[k] = v;
  }
  return out;
}

function init(extraMeta = {}) {
  if (!enabled) return;
  try {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const root = process.env.CAPTURE_DIR
      ? path.resolve(process.env.CAPTURE_DIR)
      : path.join(repoRoot, 'projects', 'pain-material', 'fixtures');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
    const sessionId = `${stamp}-pid${process.pid}`;
    sessionDir = path.join(root, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    eventsPath = path.join(sessionDir, 'events.jsonl');

    const meta = {
      format_version: FORMAT_VERSION,
      session_id: sessionId,
      boot_epoch_ms: Date.now(),
      boot_mono_ms: Math.round(nowMono() * 1000) / 1000,
      pid: process.pid,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      git_sha: gitSha(repoRoot),
      env: envSnapshot(),
      ...extraMeta,
    };
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));

    const flushTimer = setInterval(flush, FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();
    const countersTimer = setInterval(() => { event('counters', { counters: { ...counters } }); }, COUNTERS_MS);
    if (countersTimer.unref) countersTimer.unref();

    // Final synchronous drain — 'exit' allows no async work. SIGINT/SIGTERM get
    // explicit handlers because installing none means default-kill (fine) but
    // installing the 'exit' hook alone wouldn't run on a signal. Re-exit with
    // the conventional code so process semantics stay what the kiosk expects.
    const finalize = () => {
      if (dead || !sessionDir) return;
      try {
        pending.push(JSON.stringify({
          seq: ++seq, t_mono_ms: Math.round(nowMono() * 1000) / 1000, t_wall_ms: Date.now(),
          kind: 'counters', final: true, counters: { ...counters },
        }) + '\n');
        fs.appendFileSync(eventsPath, pending.join(''));
        pending = [];
      } catch { /* nothing left to do */ }
    };
    process.on('exit', finalize);
    process.on('SIGINT', () => { finalize(); dead = true; process.exit(130); });
    process.on('SIGTERM', () => { finalize(); dead = true; process.exit(143); });

    console.log(`capture: ON -> ${sessionDir}`);
  } catch (e) {
    dead = true;
    console.error(`capture: init failed, capture disabled: ${e.message}`);
  }
}

module.exports = { enabled, init, event, rawField, bump };
