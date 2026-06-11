// Phase-1 dual-write adapter (MIGRATION_PLAN.md): mirrors every legacy
// inputBus event onto the orrery bus as a namespaced bus.v1 signal, per the
// path map in projects/pain-material/manifest/IR_SKETCH.md. Pure shadow —
// nothing consumes these yet; the legacy SSE path is untouched (PM impact
// zero). Phase 2 rebinds the browser feed to the bus; phase 4+ adds candidate
// writers at lower priority on these same paths.
//
// Source identity: the legacy stream collapses provenance (everything funnels
// through publish()), so the adapter re-derives it from the signal name —
// sidecar sensors vs daisy serial vs browser UI. Honest enough for phase 1;
// real per-node identity arrives with manifests (phase 3).

'use strict';

const SPIFFE = 'spiffe://pain-material.local';

// Authority ladder (IR_SKETCH.md notes local_ui at 700; sensors sit at the
// incumbent sensor level, the daisy clock between; defaults at the idle rung).
const PRI_SENSOR = 300;
const PRI_CLOCK = 400;
const PRI_LOCAL_UI = 700;
const PRI_IDLE = 100;

// ── Ingest-boundary endpoint conditioning (phase 4C, MIGRATION_PLAN.md) ──
// Legacy validates near/far claims CONSUMER-side (daisy-position and the
// browser each guard independently); the bus carries ONE effective value,
// conditioned once, here, at the sidecar's ingest boundary. Both real
// goldens contained invalid far claims (far=50, then far=75==near) that every
// legacy consumer silently rejected — without this hoist the bus diverges
// from legacy-effective and the 4C live shadow cannot compare.
//
//   - a near claim is valid iff 0 <= near < effective far;
//   - a far claim is valid iff far > effective near;
//   - invalid claims are NOT published (previous effective value holds — the
//     legacy semantic: reject, never clamp), counted, and logged.
//
// The boot defaults (mirror of daisy-position NEAR_DEFAULT_CM/FAR_DEFAULT_CM;
// the bridge's config, so published under the bridge's own identity, not the
// sidecar's) are a standing low-priority writer at the idle rung: any live,
// valid sidecar claim out-arbitrates them, and when the sidecar is silent the
// bus still resolves the values every consumer would actually use.
const NEAR_DEFAULT_CM = 75;
const FAR_DEFAULT_CM = 130;
const DEFAULTS_SOURCE = `${SPIFFE}/bridge/defaults`;

// legacy name -> bus signal contract. stale_after_ms reflects each signal's
// nominal cadence (flag-only HOLD in phase 1, so generous is safe).
const MAP = {
  distance_cm: { path: 'sensor.door.distance_cm', type: 'float', source: `${SPIFFE}/sidecar/tof-door`, priority: PRI_SENSOR, staleAfterMs: 2000 },
  distance_velocity_cm_s: { path: 'sensor.door.velocity_cm_s', type: 'float', source: `${SPIFFE}/sidecar/tof-door`, priority: PRI_SENSOR, staleAfterMs: 2000 },
  distance_near_cm: { path: 'sensor.door.near_cm', type: 'float', source: `${SPIFFE}/sidecar/tof-door`, priority: PRI_SENSOR, staleAfterMs: 10000 },
  distance_far_cm: { path: 'sensor.door.far_cm', type: 'float', source: `${SPIFFE}/sidecar/tof-door`, priority: PRI_SENSOR, staleAfterMs: 10000 },
  motion: { path: 'sensor.room.motion', type: 'bool', source: `${SPIFFE}/sidecar/am312-room`, priority: PRI_SENSOR, staleAfterMs: 0 },
  breath_detected: { path: 'sensor.breath.detected', type: 'int', source: `${SPIFFE}/sidecar/hr202-breath`, priority: PRI_SENSOR, staleAfterMs: 0 },
  freeze: { path: 'ui.browser.freeze', type: 'float', source: `${SPIFFE}/browser/ui`, priority: PRI_LOCAL_UI, staleAfterMs: 0 },
  song_position: { path: 'clock.daisy.position', type: 'float', source: `${SPIFFE}/daisy/serial`, priority: PRI_CLOCK, staleAfterMs: 1000 },
};

// touch_mask fans out to twelve explicit electrode signals (IR_SKETCH.md:
// touch.pad0.e0 … e11 — no wildcards until something needs them).
const TOUCH = {
  source: `${SPIFFE}/sidecar/mpr121-pad0`,
  priority: PRI_SENSOR,
  paths: Array.from({ length: 12 }, (_, i) => `touch.pad0.e${i}`),
};

// Keepalive sweep cadence. Each stale-declared path republishes (unchanged)
// once it has gone staleAfterMs/2 without a send — the writer-side keepalive
// obligation from BUS_PROTOCOL.md, at the lowest rate that can't go stale.
const KEEPALIVE_TICK_MS = 250;

// Time is injectable so the graph simulator (tools/sim, phase 4) can run this
// exact writer discipline under its virtual clock: `now` stamps sends, and
// `scheduleRepeating(fn, ms)` owns the keepalive cadence (returns a cancel).
// Defaults preserve live behavior byte-for-byte.
const defaultScheduleRepeating = (fn, ms) => {
  const t = setInterval(fn, ms);
  if (t.unref) t.unref();
  return () => clearInterval(t);
};

function attachBusAdapter({ bus, inputBus, now = Date.now, scheduleRepeating = defaultScheduleRepeating }) {
  // registerPath is idempotent: when the manifest registry loaded first
  // (phase 3), the manifest's declaration wins and the values below are
  // fallbacks for registry-less runs (tests). The keepalive obligation always
  // follows the EFFECTIVE stale window, whichever source declared it.
  const staleFor = new Map();
  for (const m of Object.values(MAP)) {
    const entry = bus.registerPath(m.path, { shape: 'state', type: m.type, staleAfterMs: m.staleAfterMs });
    staleFor.set(m.path, entry.staleAfterMs);
  }
  for (const p of TOUCH.paths) {
    bus.registerPath(p, { shape: 'state', type: 'bool', staleAfterMs: 0 });
  }

  // Writer discipline (BUS_PROTOCOL.md): publish on CHANGE; signals that
  // declare stale_after_ms keepalive within the window; everything else relies
  // on bus retention. Without this, every legacy event fans out as packets
  // with fresh seqs and unchanged values (the 12-electrode burst per
  // touch_mask change was the worst), which no constrained remote link
  // (ESP-NOW, phase 9) could carry.
  // Keyed by writer AND path: the defaults writer and the sidecar share the
  // near/far paths, and each keeps its own change-dedupe + keepalive track.
  const last = new Map(); // `${sourceId}|${path}` -> { path, value, atMs, opts, staleAfterMs }
  const send = (path, v, opts, staleAfterMs, force = false) => {
    const key = `${opts.sourceId}|${path}`;
    const prev = last.get(key);
    if (!force && prev && prev.value === v) return;
    bus.publishState(path, v, opts);
    last.set(key, { path, value: v, atMs: now(), opts, staleAfterMs });
  };

  // Endpoint conditioning state + the standing defaults writer.
  const eff = { near: NEAR_DEFAULT_CM, far: FAR_DEFAULT_CM };
  const endpointRejects = [];
  send(MAP.distance_near_cm.path, NEAR_DEFAULT_CM + 0.0, { sourceId: DEFAULTS_SOURCE, priority: PRI_IDLE }, staleFor.get(MAP.distance_near_cm.path));
  send(MAP.distance_far_cm.path, FAR_DEFAULT_CM + 0.0, { sourceId: DEFAULTS_SOURCE, priority: PRI_IDLE }, staleFor.get(MAP.distance_far_cm.path));

  const onChange = (entry) => {
    const { name, value } = entry;
    if (name === 'touch_mask') {
      const mask = Number(value) >>> 0;
      for (let i = 0; i < 12; i++) {
        send(TOUCH.paths[i], !!(mask & (1 << i)), { sourceId: TOUCH.source, priority: TOUCH.priority }, 0);
      }
      return;
    }
    const m = MAP[name];
    if (!m) return; // unmapped legacy names stay legacy-only (visible by absence)
    // Endpoint validity conditioning (see header): invalid claims never reach
    // the bus; the effective value (or the defaults writer) holds.
    if (name === 'distance_near_cm') {
      if (!(typeof value === 'number' && value >= 0 && value < eff.far)) {
        endpointRejects.push({ name, value, effective: { ...eff } });
        console.warn(`bus-adapter: rejected ${name}=${value} (effective near=${eff.near}, far=${eff.far})`);
        return;
      }
      eff.near = value;
    } else if (name === 'distance_far_cm') {
      if (!(typeof value === 'number' && value > eff.near)) {
        endpointRejects.push({ name, value, effective: { ...eff } });
        console.warn(`bus-adapter: rejected ${name}=${value} (effective near=${eff.near}, far=${eff.far})`);
        return;
      }
      eff.far = value;
    }
    let v = value;
    if (m.type === 'bool') v = value === true || value === 1;
    else if (m.type === 'float' && typeof v === 'number' && Number.isInteger(v)) v = v + 0; // toValue picks integer; float decl accepts it
    send(m.path, v, { sourceId: m.source, priority: m.priority }, staleFor.get(m.path));
  };

  const cancelKeepalive = scheduleRepeating(() => {
    const t = now();
    for (const rec of last.values()) {
      if (rec.staleAfterMs > 0 && t - rec.atMs >= rec.staleAfterMs / 2) {
        send(rec.path, rec.value, rec.opts, rec.staleAfterMs, true);
      }
    }
  }, KEEPALIVE_TICK_MS);

  inputBus.on('change', onChange);
  return {
    stop: () => { inputBus.off('change', onChange); cancelKeepalive(); },
    MAP, TOUCH,
    conditioning: { effective: () => ({ ...eff }), rejects: endpointRejects },
  };
}

module.exports = attachBusAdapter;
module.exports.MAP = MAP;
module.exports.TOUCH = TOUCH;
module.exports.PRIORITIES = { PRI_SENSOR, PRI_CLOCK, PRI_LOCAL_UI, PRI_IDLE };
module.exports.DEFAULTS = { NEAR_DEFAULT_CM, FAR_DEFAULT_CM, DEFAULTS_SOURCE };
