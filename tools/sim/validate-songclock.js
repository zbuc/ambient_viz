#!/usr/bin/env node
// Phase-7 gate (MIGRATION_PLAN.md — clock as a contract): extrapolation +
// cyclic handling, validated over a golden's REAL POS/RESET stream.
//
// From the capture's serial_rx timeline (the bridge's receive-stamped POS
// reports, including every loop-wrap RESET):
//
//   - the PRODUCTION rate estimator (server/src/clock-rate.js) re-derives
//     the clock.daisy.rate stream — sanity lane: after warmup the estimate
//     stays inside [0.95, 1.05] except at declared wrap resets;
//   - the REAL SongClock module (static/song-clock.js) consumes the
//     (position, rate) tuple — anchors at the capture stamps, rates from the
//     estimator — exactly the page's tuple path;
//   - the LEGACY reader (frozen spec: anchor every report, hardcoded rate
//     1.0, stale-rewind to the raw anchor) is the comparison lane.
//
// Both clocks are sampled on a 50 ms grid. PASS =
//   - outside stalls, |tuple − legacy| <= EPS_S (the rate deviation over one
//     report gap — sub-ms for a sane Daisy; 10 ms allowed);
//   - STALL windows (report gap > staleMs) are the ONE declared
//     EXPECTED_DIFFERENCE: tuple freezes at the stale boundary, legacy
//     rewinds to the anchor — counted, never silently excused;
//   - at every wrap (backward anchor), both clocks snap to the new position
//     at the SAME report, and the tuple clock never decreases between
//     anchors (cyclic handling: the seam is crossed by re-anchor, never by
//     extrapolation);
//   - when the capture carries browser snapshots with the phase-7
//     `song_clock` A/B (post-deploy sessions), the live lane: per snapshot,
//     |rebase − tuple| <= EPS_S unless the page was inside a stall window.
//
// Usage: node tools/sim/validate-songclock.js <golden-session-dir> [--out DIR] [--quiet]
// Exit:  0 = MATCH, 1 = blocked, 2 = harness error.

'use strict';

const fs = require('fs');
const path = require('path');

const { loadSession } = require('../replay/capture-io');
const { createRateEstimator } = require('../../server/src/clock-rate');
const { createSongClock } = require('../../static/song-clock');

const GRID_MS = 50;
const STALE_MS = 2000;
const EPS_S = 0.010;          // tuple-vs-legacy outside stalls (rate dev over one gap)
const RATE_LO = 0.95;
const RATE_HI = 1.05;
const WARMUP_REPORTS = 40;    // ~2 s of POS before the rate lane gates

function parseArgs(argv) {
  const args = { dir: null, out: null, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (!args.dir) args.dir = a;
    else throw new Error(`unexpected arg: ${a}`);
  }
  if (!args.dir) throw new Error('usage: validate-songclock.js <golden-session-dir> [--out DIR] [--quiet]');
  return args;
}

function validateSongClock({ goldenDir, outDir, quiet = false }) {
  const golden = loadSession(goldenDir);
  const reports = golden.events
    .filter((e) => e.kind === 'serial_rx' && e.decoded && (e.decoded.type === 'pos' || e.decoded.type === 'reset'))
    .map((e) => ({ t: e.t_mono_ms, sec: e.decoded.sec, reset: e.decoded.type === 'reset' }));
  if (reports.length < 10) throw new Error(`golden has only ${reports.length} POS reports — nothing to validate`);

  // ── drive estimator + both consumers over the report timeline ──────────
  const est = createRateEstimator();
  const tuple = createSongClock({ staleMs: STALE_MS });
  const legacy = { pos: 0, wall: 0, have: false };
  const legacyNow = (atMs) => {
    if (!legacy.have) return null;
    const age = atMs - legacy.wall;
    return age <= STALE_MS ? legacy.pos + age / 1000 : legacy.pos; // the rewind quirk, verbatim
  };

  const rateLane = { violations: [], wraps: 0, resets_seen: 0, min: Infinity, max: -Infinity };
  const wrapLane = { wraps: [], violations: [] };
  const gridLane = { points: 0, stall_points: 0, max_abs_s: 0, violations: [] };

  let reportIdx = 0;
  let prevTupleVal = null;
  let prevAnchorT = -Infinity;
  for (let i = 0; i < reports.length; i++) {
    const r = reports[i];
    // grid samples between the previous report and this one
    if (i > 0) {
      for (let t = reports[i - 1].t + GRID_MS; t < r.t; t += GRID_MS) {
        const a = tuple.now(t);
        const b = legacyNow(t);
        if (a === null || b === null) continue;
        gridLane.points += 1;
        const inStall = t - prevAnchorT > STALE_MS;
        if (inStall) { gridLane.stall_points += 1; }
        else {
          const d = Math.abs(a - b);
          if (d > gridLane.max_abs_s) gridLane.max_abs_s = d;
          if (d > EPS_S && gridLane.violations.length < 10) {
            gridLane.violations.push({ t, tuple: a, legacy: b, diff: d });
          }
        }
        // cyclic: the tuple clock never decreases BETWEEN anchors
        if (prevTupleVal !== null && a < prevTupleVal - 1e-9 && wrapLane.violations.length < 10) {
          wrapLane.violations.push({ t, kind: 'backward_between_anchors', from: prevTupleVal, to: a });
        }
        prevTupleVal = a;
      }
    }
    // the report itself: estimator -> rate -> tuple anchor; legacy anchor
    const { rate, wrapped } = est.onPosition(r.sec, r.t);
    if (wrapped) { rateLane.wraps += 1; wrapLane.wraps.push({ t: r.t, to: r.sec }); }
    if (r.reset) rateLane.resets_seen += 1;
    tuple.onRate(rate, r.t);
    const before = tuple.now(r.t);
    tuple.onPosition(r.sec, r.t);
    legacy.pos = r.sec; legacy.wall = r.t; legacy.have = true;
    prevAnchorT = r.t;
    // wrap snap: immediately after a backward anchor both clocks read the new pos
    if (wrapped) {
      const a = tuple.now(r.t);
      const b = legacyNow(r.t);
      if (Math.abs(a - r.sec) > 1e-9 || Math.abs(b - r.sec) > 1e-9) {
        wrapLane.violations.push({ t: r.t, kind: 'no_snap', tuple: a, legacy: b, expected: r.sec, before });
      }
    }
    prevTupleVal = tuple.now(r.t);
    reportIdx += 1;
    if (reportIdx > WARMUP_REPORTS) {
      rateLane.min = Math.min(rateLane.min, rate);
      rateLane.max = Math.max(rateLane.max, rate);
      if ((rate < RATE_LO || rate > RATE_HI) && !wrapped && rateLane.violations.length < 10) {
        rateLane.violations.push({ t: r.t, rate });
      }
    }
  }

  // ── snapshot live lane (post-deploy captures) ───────────────────────────
  // Since the phase-7 cleanup the page runs the tuple clock only; snapshots
  // carry its value. The lane compares each snapshot's page-side tuple value
  // against the validator's own re-derivation at the snapshot's BRIDGE
  // timestamp — live module == re-derived module, within the page-receipt /
  // snapshot-POST latency (generous 50 ms of song time at rate ~1).
  const LIVE_EPS_S = 0.05;
  const snaps = golden.events
    .filter((e) => e.kind === 'browser_snapshot' && e.snapshot && e.snapshot.song_clock
      && typeof e.snapshot.song_clock.tuple === 'number')
    .map((e) => ({ t: e.t_mono_ms, ...e.snapshot.song_clock }));
  let live = { present: false, note: 'capture has no song_clock snapshots (recorded before phase 7)' };
  if (snaps.length) {
    // Replay the reports into a fresh estimator+clock so we can sample the
    // re-derived value at arbitrary snapshot times, in capture order.
    const est2 = createRateEstimator();
    const clock2 = createSongClock({ staleMs: STALE_MS });
    let ri = 0;
    const mismatches = [];
    let maxAbs = 0;
    for (const s of snaps) {
      for (; ri < reports.length && reports[ri].t <= s.t; ri++) {
        const { rate } = est2.onPosition(reports[ri].sec, reports[ri].t);
        clock2.onRate(rate, reports[ri].t);
        clock2.onPosition(reports[ri].sec, reports[ri].t);
      }
      const rederived = clock2.now(s.t);
      if (rederived === null) continue; // snapshot before the first POS
      const d = Math.abs(s.tuple - rederived);
      if (d > maxAbs) maxAbs = d;
      if (d > LIVE_EPS_S && mismatches.length < 10) mismatches.push({ t: s.t, tuple: s.tuple, rederived, diff: d });
    }
    live = { present: true, snapshots: snaps.length, eps_s: LIVE_EPS_S, max_abs_s: maxAbs, mismatches, pass: mismatches.length === 0 };
  }

  // Note: wraps and RESET lines are reported separately, not equated — a
  // RESET as the stream's FIRST report (the Daisy was mid-loop when the
  // bridge connected; the phase-6 golden's case) is an anchor, not a wrap.
  const pass = rateLane.violations.length === 0
    && wrapLane.violations.length === 0
    && gridLane.violations.length === 0
    && (!live.present || live.pass);

  const validation = {
    schema: 'songclock-validation.v1',
    phase: '7',
    reports: reports.length,
    rate_lane: {
      ...rateLane,
      min: rateLane.min === Infinity ? null : rateLane.min,
      max: rateLane.max === -Infinity ? null : rateLane.max,
      bounds: [RATE_LO, RATE_HI],
    },
    wrap_lane: wrapLane,
    grid_lane: { ...gridLane, eps_s: EPS_S, grid_ms: GRID_MS,
      note: 'stall_points are the declared freeze-vs-rewind EXPECTED_DIFFERENCE class' },
    live_snapshots: live,
    verdict: pass ? 'MATCH' : 'REGRESSION',
    blocks: !pass,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'songclock-validation.json'), JSON.stringify(validation, null, 2));

  if (!quiet) {
    console.log(`song clock: ${reports.length} POS reports, ${rateLane.wraps} wraps (${rateLane.resets_seen} RESET lines)`);
    console.log(`  ${(rateLane.violations.length ? 'REGRESSION' : 'MATCH').padEnd(20)} rate lane  `
      + `est ${validation.rate_lane.min === null ? '—' : validation.rate_lane.min.toFixed(4)}..${validation.rate_lane.max === null ? '—' : validation.rate_lane.max.toFixed(4)} within [${RATE_LO}, ${RATE_HI}]`);
    console.log(`  ${(wrapLane.violations.length ? 'REGRESSION' : 'MATCH').padEnd(20)} wrap lane  `
      + `${wrapLane.wraps.length} wraps all hard-snap; monotone between anchors`);
    console.log(`  ${(gridLane.violations.length ? 'REGRESSION' : 'MATCH').padEnd(20)} grid lane  `
      + `${gridLane.points} samples, max |tuple-legacy| ${gridLane.max_abs_s.toFixed(4)}s outside stalls `
      + `(${gridLane.stall_points} stall samples declared)`);
    if (live.present) {
      console.log(`  ${(live.pass ? 'MATCH' : 'REGRESSION').padEnd(20)} live A/B   ${live.snapshots} snapshots, max ${live.max_abs_s.toFixed(4)}s`);
    } else {
      console.log(`  ${'ABSENT'.padEnd(20)} live A/B   ${live.note}`);
    }
    console.log(`\nverdict: ${validation.verdict}  (report: ${path.join(outDir, 'songclock-validation.json')})`);
  }
  return { validation };
}

function main() {
  const args = parseArgs(process.argv);
  const goldenDir = path.resolve(args.dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const outDir = path.resolve(args.out || path.join(goldenDir, 'sims', `songclock-${stamp}`));
  const { validation } = validateSongClock({ goldenDir, outDir, quiet: args.quiet });
  process.exit(validation.blocks ? 1 : 0);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`validate-songclock: ${e.message}`); process.exit(2); }
}

module.exports = { validateSongClock };
