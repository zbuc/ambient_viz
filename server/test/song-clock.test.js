// Phase-7 clock contract: the rate estimator (server/src/clock-rate.js, the
// publisher half) and the SongClock module (static/song-clock.js, the
// consumer half — one file, three runtimes). Run: cd server && node --test

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createRateEstimator, NOMINAL_RATE } = require('../src/clock-rate');
const { createSongClock } = require('../../static/song-clock');

// ── rate estimator ───────────────────────────────────────────────────────────

test('estimator: converges on a steady measured rate, seeds nominal', () => {
  const e = createRateEstimator();
  assert.equal(e.rate(), NOMINAL_RATE);
  // POS every 50 ms advancing 0.0505 s -> true rate 1.01
  let t = 0; let p = 0;
  for (let i = 0; i < 200; i++) { t += 50; p += 0.0505; e.onPosition(p, t); }
  assert.ok(Math.abs(e.rate() - 1.01) < 0.001, `rate ${e.rate()}`);
});

test('estimator: a loop wrap resets to nominal and reports wrapped', () => {
  const e = createRateEstimator();
  let t = 0;
  for (let i = 1; i <= 50; i++) { t += 50; e.onPosition(i * 0.0505, t); }
  const r = e.onPosition(0.01, t + 50); // RESET: backward jump
  assert.equal(r.wrapped, true);
  assert.equal(r.rate, NOMINAL_RATE);
});

test('estimator: outliers and stalls are rejected, never enter the baseline', () => {
  const e = createRateEstimator();
  let t = 0; let p = 0;
  for (let i = 0; i < 100; i++) { t += 50; p += 0.05; e.onPosition(p, t); }
  const before = e.rate();
  // A corrupt forward POS jump: the windowed rate would be implausible ->
  // the report is dropped from the baseline; rate holds AND the next sane
  // reports keep estimating from the clean window.
  e.onPosition(p + 100, t + 50);
  assert.equal(e.rate(), before);
  for (let i = 0; i < 10; i++) { t += 50; p += 0.05; e.onPosition(p, t); }
  assert.ok(Math.abs(e.rate() - 1.0) < 0.01, `poisoned baseline: ${e.rate()}`);
  // A 5 s stall re-baselines: the estimate HOLDS until the new window spans.
  const heldAt = e.rate();
  e.onPosition(p + 0.05, t + 5000);
  assert.equal(e.rate(), heldAt);
  e.onPosition(NaN, t + 5050); // rule 13
  assert.equal(e.rate(), heldAt);
});

test('estimator: delivery jitter around a steady cadence stays inside ±1%', () => {
  // POS every 50 ms of song time, delivered with bursty wall jitter (the
  // measured USB-CDC pattern: dt 0.6..99 ms) — the windowed baseline must
  // not chase it. Deterministic pseudo-jitter (no Math.random in tests).
  const e = createRateEstimator();
  let wall = 0;
  let lo = Infinity; let hi = -Infinity;
  for (let i = 1; i <= 400; i++) {
    const jitter = 24 * Math.sin(i * 1.7) * Math.sin(i * 0.31); // ±24 ms, zero-mean-ish
    const at = i * 50 + jitter;
    if (at <= wall) continue; // keep wall time monotone like a real stream
    wall = at;
    const { rate } = e.onPosition(i * 0.05, at);
    if (i > 60) { lo = Math.min(lo, rate); hi = Math.max(hi, rate); }
  }
  assert.ok(lo > 0.99 && hi < 1.01, `rate excursion ${lo}..${hi}`);
});

// ── SongClock (the real page module, required from static/) ─────────────────

test('song clock: null before the first anchor; extrapolates with the published rate', () => {
  const c = createSongClock();
  assert.equal(c.now(1000), null);
  c.onPosition(10, 1000);
  assert.equal(c.now(1000), 10);
  assert.ok(Math.abs(c.now(1500) - 10.5) < 1e-9); // nominal 1.0
  c.onRate(0.5);
  assert.ok(Math.abs(c.now(1500) - 10.25) < 1e-9); // slope follows the tuple
});

test('song clock: a backward anchor IS the wrap snap; extrapolation alone never steps back', () => {
  const c = createSongClock();
  c.onPosition(1079.9, 0);
  const beforeWrap = c.now(80); // overruns the seam by ~80 ms — allowed
  assert.ok(beforeWrap > 1079.9);
  c.onPosition(0.05, 100); // RESET anchor
  assert.ok(Math.abs(c.now(100) - 0.05) < 1e-9, 'hard snap at the anchor');
  // monotone between anchors
  assert.ok(c.now(150) > c.now(100));
});

test('song clock: stale FREEZES at the boundary (the legacy reader rewound to the anchor)', () => {
  const c = createSongClock({ staleMs: 2000 });
  c.onPosition(100, 0);
  assert.ok(Math.abs(c.now(1999) - 101.999) < 1e-9);
  // 10 s stall: frozen at pos0 + rate*staleMs — NOT rewound to 100,
  // and NOT extrapolated off the end.
  assert.ok(Math.abs(c.now(10000) - 102) < 1e-9);
  assert.equal(c.stale(10000), true);
  // legacy comparison documented: legacy would read 100 here (a 2 s rewind).
});

test('song clock: implausible rates are rejected at the consumer boundary', () => {
  const c = createSongClock();
  c.onPosition(5, 0);
  c.onRate(NaN); c.onRate(-1); c.onRate(99);
  assert.ok(Math.abs(c.now(1000) - 6) < 1e-9); // still nominal
});
