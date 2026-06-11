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
// incumbent sensor level, the daisy clock between).
const PRI_SENSOR = 300;
const PRI_CLOCK = 400;
const PRI_LOCAL_UI = 700;

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

module.exports = function attachBusAdapter({ bus, inputBus }) {
  for (const m of Object.values(MAP)) {
    bus.registerPath(m.path, { shape: 'state', type: m.type, staleAfterMs: m.staleAfterMs });
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
  const last = new Map(); // path -> { value, atMs, opts, staleAfterMs }
  const send = (path, v, opts, staleAfterMs, force = false) => {
    const prev = last.get(path);
    if (!force && prev && prev.value === v) return;
    bus.publishState(path, v, opts);
    last.set(path, { value: v, atMs: Date.now(), opts, staleAfterMs });
  };

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
    let v = value;
    if (m.type === 'bool') v = value === true || value === 1;
    else if (m.type === 'float' && typeof v === 'number' && Number.isInteger(v)) v = v + 0; // toValue picks integer; float decl accepts it
    send(m.path, v, { sourceId: m.source, priority: m.priority }, m.staleAfterMs);
  };

  const keepalive = setInterval(() => {
    const now = Date.now();
    for (const [path, rec] of last) {
      if (rec.staleAfterMs > 0 && now - rec.atMs >= rec.staleAfterMs / 2) {
        send(path, rec.value, rec.opts, rec.staleAfterMs, true);
      }
    }
  }, KEEPALIVE_TICK_MS);
  if (keepalive.unref) keepalive.unref();

  inputBus.on('change', onChange);
  return {
    stop: () => { inputBus.off('change', onChange); clearInterval(keepalive); },
    MAP, TOUCH,
  };
};
