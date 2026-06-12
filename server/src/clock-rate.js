// Song-clock rate estimator (migration phase 7 — clock as a contract).
//
// The clock contract (ARCHITECTURE.md → "Clock distribution: extrapolate,
// don't sample"): the clock source publishes a (position, rate) TUPLE and
// every consumer extrapolates locally. The Daisy plays at a nominal 1.0; the
// published rate makes that explicit and absorbs Daisy-sample-clock vs
// Pi-wall-clock skew. A future driver (varispeed, a sequencer clock) is just
// a different published rate — no consumer change.
//
// WHY A WINDOWED BASELINE, NOT A PER-REPORT EMA: POS lines arrive over
// USB-CDC with heavy delivery jitter (measured on the phase-6 golden:
// inter-line dt 0.6..99 ms around a 50 ms cadence — serial batching bursts
// then gaps). A per-report Δpos/Δt EMA chases that jitter into ±50% rate
// swings. The endpoint ratio over a multi-second window amortizes it:
// ±25 ms of delivery jitter over a 6 s baseline is ±0.4%.
//
//   rate = (pos_newest − pos_oldest) / (t_newest − t_oldest)
//
// over a sliding ~6 s ring, valid once the span reaches 1.5 s. Hazards, each
// handled by REJECTION (rule-13 posture), never clamping:
//   - a BACKWARD report (the loop-wrap RESET, a Daisy reboot) clears the
//     baseline and resets to nominal — `wrapped` is reported so the
//     publisher/validator can treat it as the cyclic re-anchor;
//   - a report gap over 1 s (stall/unplug) clears the baseline (the old
//     anchors are from a different playback episode); the rate HOLDS;
//   - a report that would make the windowed rate implausible (outside
//     [0.25, 4]) is dropped from the baseline entirely — one corrupt POS
//     line must not poison the next six seconds of estimates;
//   - non-finite inputs are ignored.
//
// Shared by the live publisher (daisy-position) and the offline gate
// (tools/sim/validate-songclock.js): the rate the validator reasons about is
// re-derived by THIS code from the captured POS stream — production code,
// not a model.

'use strict';

const NOMINAL_RATE = 1.0;
const WINDOW_MS = 6000;   // baseline length
const MIN_SPAN_MS = 1500; // no estimate below this span (warmup -> nominal)
const MAX_GAP_MS = 1000;  // a longer silence re-baselines
const MIN_RATE = 0.25;
const MAX_RATE = 4;

function createRateEstimator() {
  const ring = []; // {pos, atMs}, oldest first
  let rate = NOMINAL_RATE;

  return {
    // Feed one position report; returns { rate, wrapped }.
    onPosition(pos, atMs) {
      if (!Number.isFinite(pos) || !Number.isFinite(atMs)) return { rate, wrapped: false };
      let wrapped = false;
      const last = ring.length ? ring[ring.length - 1] : null;
      if (last) {
        if (pos < last.pos) {
          // Loop wrap / reboot: new playback episode, forget the baseline.
          ring.length = 0;
          rate = NOMINAL_RATE;
          wrapped = true;
        } else if (atMs - last.atMs > MAX_GAP_MS) {
          ring.length = 0; // stall: re-baseline, the estimate HOLDS
        }
      }
      ring.push({ pos, atMs });
      while (ring.length > 2 && ring[ring.length - 1].atMs - ring[0].atMs > WINDOW_MS) ring.shift();
      const span = ring[ring.length - 1].atMs - ring[0].atMs;
      if (span >= MIN_SPAN_MS) {
        const raw = (ring[ring.length - 1].pos - ring[0].pos) / (span / 1000);
        if (Number.isFinite(raw) && raw >= MIN_RATE && raw <= MAX_RATE) rate = raw;
        else ring.pop(); // implausible: this report never enters the baseline
      }
      return { rate, wrapped };
    },
    rate: () => rate,
  };
}

module.exports = { createRateEstimator, NOMINAL_RATE };
