// Capture -> legacy inputBus pump (phase 4 graph simulator).
//
// Replays a phase-0 capture's INPUTS as legacy `inputBus` change events, so
// the production bus-adapter (writer discipline included) does the
// legacy-name -> bus-path mapping exactly as the live bridge does.
//
// Layer choice, by design: the pump consumes the capture's DECODED forms
// (`items` on ingest, `decoded` on serial_rx). Raw-byte fidelity (same bytes
// parse/drop the same way) is the REPLAY HARNESS's job (tools/replay, maturity
// level 1); the simulator trusts the captured decode and exercises everything
// from the input bus down. ingest_drop events produced no inputBus traffic in
// the live run, so they are correctly absent here.
//
// publish() semantics are mirrored from server/src/index.js: per-name
// dedupe on strict value equality — the input bus only ever carries changes.

'use strict';

// The capture's replayable input entries, flattened to {t, name, value} in
// capture order. POS and RESET both publish song_position, as the bridge does.
function inputEntries(events) {
  const out = [];
  for (const ev of events) {
    if (ev.kind === 'ingest' && Array.isArray(ev.items)) {
      for (const item of ev.items) {
        if (item && typeof item.name === 'string' && item.name) {
          out.push({ t: ev.t_mono_ms, name: item.name, value: item.value });
        }
      }
    } else if (ev.kind === 'serial_rx' && ev.decoded
        && (ev.decoded.type === 'pos' || ev.decoded.type === 'reset')) {
      out.push({ t: ev.t_mono_ms, name: 'song_position', value: ev.decoded.sec });
    }
  }
  return out;
}

// Stateful emitter mirroring the legacy publish(): drops unchanged values.
function makePump({ inputBus, clock }) {
  const state = new Map();
  let emitted = 0;
  let deduped = 0;
  return {
    emit(name, value) {
      const prev = state.get(name);
      if (state.has(name) && prev === value) { deduped += 1; return false; }
      state.set(name, value);
      emitted += 1;
      inputBus.emit('change', { name, value, ts: clock.now() });
      return true;
    },
    counts: () => ({ emitted, deduped }),
  };
}

module.exports = { inputEntries, makePump };
