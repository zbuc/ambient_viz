// SongClock — the consumer half of the clock contract (migration phase 7).
//
// Consumes the (position, rate) tuple — `clock.daisy.position` anchors,
// `clock.daisy.rate` the locally-measured playback rate — and extrapolates:
//
//     position(t) = pos₀ + rate · (t − t₀) / 1000
//
// per ARCHITECTURE.md → "Clock distribution: extrapolate, don't sample".
// Semantics, stated:
//
//   - ANCHOR on every position report (t₀ = local receipt time — in-process
//     over localhost SSE the receipt-vs-publish skew is sub-ms, the coarse
//     offset estimate the distributed contract needs). A backward anchor IS
//     the loop-wrap/reconnect hard snap; extrapolation itself never jumps
//     backward, and between reports it may overrun the loop seam by at most
//     one report interval — the next anchor snaps it, exactly as the legacy
//     rebase did.
//   - RATE updates change the slope from the next now() on; absent a rate
//     the nominal 1.0 applies (the tuple's rate half is retained on the bus,
//     so this is a first-connect transient only).
//   - STALE: when no anchor has arrived for staleMs, the clock FREEZES at
//     the stale-boundary value (pos₀ + rate · staleMs). The legacy reader
//     instead fell back to the raw anchor — a 2 s REWIND at the moment of
//     going stale. Freezing is the declared improvement (the phase-7
//     comparator's one EXPECTED_DIFFERENCE class); a frozen lane holds
//     still, it does not step backward.
//
// One file, three runtimes: a <script> tag (window.SongClock), node tests,
// and the offline gate (tools/sim/validate-songclock.js) — the validator
// drives THIS code over captured POS timelines, not a model of it.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SongClock = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NOMINAL_RATE = 1.0;

  function createSongClock({ staleMs = 2000 } = {}) {
    let pos0 = null;   // last anchored position (seconds)
    let t0 = 0;        // local receipt time of the anchor (ms)
    let rate = NOMINAL_RATE;

    return {
      onPosition(pos, atMs) {
        if (typeof pos !== 'number' || !isFinite(pos)
          || typeof atMs !== 'number' || !isFinite(atMs)) return;
        pos0 = pos;
        t0 = atMs;
      },
      onRate(r, atMs) { // eslint-disable-line no-unused-vars
        // Rate sanity at the consumer boundary (rule-13 posture): a
        // non-finite or implausible rate never becomes a slope.
        if (typeof r !== 'number' || !isFinite(r) || r < 0 || r > 4) return;
        rate = r;
      },
      // The extrapolated position (seconds), or null before the first anchor.
      now(atMs) {
        if (pos0 === null) return null;
        const age = Math.max(0, atMs - t0);
        return pos0 + rate * Math.min(age, staleMs) / 1000;
      },
      stale(atMs) { return pos0 !== null && atMs - t0 > staleMs; },
      state() { return { pos0, t0, rate }; },
    };
  }

  return { createSongClock, NOMINAL_RATE };
}));
