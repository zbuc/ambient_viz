// Declared replay tolerances (phase 0). "≈ 0 is never vibes": every
// comparison the harness makes is governed by an entry here, per signal
// shape/type (MIGRATION_PLAN.md, "The comparator"). Anything NOT covered by
// this table comes back UNKNOWN, which blocks — an undiagnosed difference is
// not a pass.
//
// Replay validity: these gates are declared for --speed 1 only. The bridge's
// rate caps (MIN_WRITE_MS) and trigger state machines run on wall time, so a
// time-scaled replay legitimately diverges.

'use strict';

module.exports = {
  // --- SSE state signals (the `sse_out` stream), keyed by signal name -------
  // Replay re-POSTs the captured raw bytes, so values pass through the same
  // decode; eps only absorbs JSON float round-tripping. latency_ms bounds the
  // signal's time-of-arrival relative to the session anchor (pacing jitter +
  // event-loop scheduling).
  signals: {
    distance_cm:            { type: 'float', eps_abs: 1e-9, eps_rel: 1e-12, latency_ms: 250 },
    distance_velocity_cm_s: { type: 'float', eps_abs: 1e-9, eps_rel: 1e-12, latency_ms: 250 },
    distance_near_cm:       { type: 'float', eps_abs: 1e-9, eps_rel: 1e-12, latency_ms: 250 },
    distance_far_cm:        { type: 'float', eps_abs: 1e-9, eps_rel: 1e-12, latency_ms: 250 },
    song_position:          { type: 'float', eps_abs: 1e-9, eps_rel: 1e-12, latency_ms: 250 },
    freeze:                 { type: 'float', eps_abs: 1e-9, eps_rel: 1e-12, latency_ms: 250 },
    motion:                 { type: 'bool',  latency_ms: 250 },
    // MPR121 electrodes arrive as one 12-bit bitmask.
    touch_mask:             { type: 'int',   latency_ms: 250 },
    // HR202 breath events: the value is a sidecar-side ms timestamp, but it
    // crosses /ingest as opaque payload, so replay reproduces it exactly.
    breath_detected:        { type: 'int',   latency_ms: 250 },
  },

  // --- Daisy serial CC output (the `serial_tx` stream, type 'cc') -----------
  // CC value sequences are deterministic transforms of the inputs, but the
  // 33 ms per-CC rate cap samples on wall time, so replay may keep/drop
  // different intermediate samples near the cap (the sidecar publishes at up
  // to 50 Hz — faster than the cap — so this happens on every fast ramp).
  // Compared as step functions: at every change point in either run, the
  // other run within ±window_ms must have HELD the value (within eps_value)
  // or TRAVERSED it (value inside the window's min..max span ± eps_value);
  // final values within eps_value.
  // transient_max_ms / transient_budget: the cap-dropped TRANSIENT class
  // (discovered on the first real-sensor golden, 2026-06-11). A one-sample
  // sensor spike is one CC write wide; when the other run's wall-clock cap
  // lands a few ms differently, that write is swallowed whole and its value
  // lies outside the traversal span by definition. A write that lived
  // <= transient_max_ms (~1.5 real-sensor sample periods) with both
  // neighbors explained is excused, up to transient_budget per CC per
  // session. Sustained divergence (a logic difference) blows through the
  // budget immediately.
  cc: {
    23: { name: 'tape_failure', eps_value: 1, window_ms: 250, transient_max_ms: 150, transient_budget: 5 }, // ±1 absorbs rounding at sample boundaries
    24: { name: 'freeze',       eps_value: 1, window_ms: 250, transient_max_ms: 150, transient_budget: 5 },
  },

  // --- Router-graph candidate trajectories (phase 5) ------------------------
  // The "derived/smoothed value" comparator row: tolerance PLUS a phase/
  // latency bound. The candidate is the bridge-hosted graph; the reference is
  // the legacy in-browser math reconstructed frame-clocked from the capture.
  // The two legitimately differ in sampling discipline — the browser EMA
  // keeps converging every frame (and holds through SSE transport delay),
  // the arrival-driven graph filter steps once per packet and HOLDS between
  // packets (ROUTER_IR.md execution semantics) — so a grid point passes if
  // the values agree within eps_abs at the same instant OR within lag_ms
  // (phase allowance). Sustained divergence beyond both is a REGRESSION.
  // transient_*: the SETTLE-HOLD class (measured on the cutover golden,
  // 2026-06-11). When the bridge dedupes a stilled sensor, packets stop: the
  // graph's arrival-driven Smooth freezes mid-convergence while the
  // browser's per-frame EMA settles to the held target, so a brief
  // boundary-sized residual (legacy 1.0 vs graph 0.95 at the near endpoint)
  // persists until the next packet. Observed: runs <= 150 ms, err <= 0.109,
  // 0.33% of grid points. A violating run is excused if it lasts <=
  // transient_max_ms with err <= transient_eps_abs, and the excused total
  // stays under transient_grid_frac_max — sustained divergence (a logic
  // difference) blows through all three immediately.
  // trace_lag_ms: the lag/traversal window for the BROWSER TRACE domain
  // (viz-ab). The snapshot traces sample on-change at >= 250 ms spacing, so
  // the grid's 250 ms window reaches zero neighbors there; 600 ms reaches
  // two sample spacings plus SSE transport, which is what the traversal
  // rule (the CC comparator's TRAVERSED class) needs to resolve a
  // one-sample cliff. The dense offline grid keeps the tighter 250 ms.
  // live_eps_abs: the live-vs-sim lane allowance for STATEFUL graphs. The
  // timestamp-driven Smooth clocks dt off wall-time packet arrival live but
  // off the capture's stamped ingest times in the sim; the <= ~8 ms jitter
  // passes through 1-e^(-dt/tau) and leaves residue in filter state, so the
  // value-change sequences match in count and order but not bit-exactly
  // (measured 2026-06-11 kiosk session: max 0.0087, p99 0.004). The
  // stateless tape lane keeps demanding exact values.
  derived: {
    'fx.viz.twist_gain': {
      eps_abs: 0.05, lag_ms: 250, grid_ms: 50,
      transient_eps_abs: 0.15, transient_max_ms: 400, transient_grid_frac_max: 0.01,
      live_eps_abs: 0.02, trace_lag_ms: 600,
    },
    // bitmap x is the PRE-quantize linear nearness (the harmonic blend +
    // 12 px quantize happen in the browser host); same declared class as the
    // twist gain — the shape is gentler (linear vs quadratic), the
    // settle-hold mechanism identical.
    'fx.viz.bitmap_x': {
      eps_abs: 0.05, lag_ms: 250, grid_ms: 50,
      transient_eps_abs: 0.15, transient_max_ms: 400, transient_grid_frac_max: 0.01,
      live_eps_abs: 0.02, trace_lag_ms: 600,
    },
  },

  // --- Daisy note events (the `serial_tx` stream, type 'note_on') -----------
  // Classified via the adjacent capture `trigger` event (reason recorded at
  // strike time). Deterministic classes must correspond 1:1 within window_ms;
  // stochastic classes are scheduled/selected by Math.random in the legacy
  // code, so their presence/absence across runs is a DECLARED
  // EXPECTED_DIFFERENCE (counts are still reported for eyeballing).
  notes: {
    classes: {
      strike_entry: { deterministic: true,  window_ms: 1500 },
      voice_exit:   { deterministic: true,  window_ms: 2500 }, // confirm-empty runs on the 500 ms tick
      strike_toll:  { deterministic: false, reason: 'Math.random interval + skip roll' },
      voice_murmur: { deterministic: false, reason: 'Math.random interval + skip roll + motion gating' },
    },
    // Within a matched strike pair: the bell/industrial timbre (MIDI channel)
    // is a Math.random roll, and the voice phrase (note number on ch2) is
    // picked at random. Both are declared EXPECTED_DIFFERENCE when they vary.
    ignore_fields: { strike: ['ch'], voice: ['note'] },
  },

  // --- Declared out of scope (not compared, with reasons) -------------------
  not_compared: {
    sse_connect: 'replay runs without a browser; client lifecycle is not an output',
    sse_disconnect: 'same',
    browser_snapshot: 'browser-side observation, not bridge output',
    counters: 'capture bookkeeping',
    trigger: 'used to classify note events, not compared directly',
    serial_open: 'transport lifecycle differs between tty and fake daisy',
    serial_close: 'same',
    ingest: 'replay input, not output',
    ingest_drop: 'compared only as drop-reason counts',
    serial_rx: 'replay input, not output',
    bus_tx: 'live router shadow output (4C); compared by tools/sim/validate-tape.js live lane, not here',
  },
};
