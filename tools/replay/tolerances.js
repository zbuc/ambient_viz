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
    humidity:               { type: 'float', eps_abs: 1e-9, eps_rel: 1e-12, latency_ms: 250 },
    // MPR121 touch channels arrive as touch_0..touch_11 (booleans).
    'touch_*':              { type: 'bool',  latency_ms: 250 },
  },

  // --- Daisy serial CC output (the `serial_tx` stream, type 'cc') -----------
  // CC value sequences are deterministic transforms of the inputs, but the
  // 33 ms per-CC rate cap samples on wall time, so replay may keep/drop
  // different intermediate samples near the cap. Compared as step functions:
  // at every change point in either run, the other run's value within
  // ±window_ms must agree within eps_value; final values within eps_value.
  cc: {
    23: { name: 'tape_failure', eps_value: 1, window_ms: 250 }, // ±1 absorbs rounding at sample boundaries
    24: { name: 'freeze',       eps_value: 1, window_ms: 250 },
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
  },
};
