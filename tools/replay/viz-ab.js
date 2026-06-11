#!/usr/bin/env node
// Phase-5 visualizer-mapping A/B judge (MIGRATION_PLAN.md): the LIVE cutover
// gate for the browser-consumed mappings, run over a captured kiosk session.
//
// The kiosk page computes BOTH sides of every mapping each applyAutomation
// tick — the legacy in-browser ramp and the router graph's bus output — and
// records paired on-change samples (<= 4 Hz) into each capture snapshot
// (static/index.html): `twist_trace` for fx.viz.twist_gain, `bitmap_trace`
// for fx.viz.bitmap_x. This tool replays those pairs and issues the
// comparator verdict per mapping, per page load:
//   - per sample, |legacy - bus| <= eps_abs, or a neighboring sample within
//     +-lag_ms agrees (transport + arrival-driven-hold phase allowance);
//   - violating runs pass through the declared SETTLE-HOLD transient class
//     (tolerances.js → derived), same as the offline gates
//     (tools/sim/validate-twist.js / validate-bitmap.js);
//   - `bus: null` means the router had published NOTHING yet (absent ≠
//     default — availability semantics). Leading nulls while legacy sits at
//     the mapping's sensor-absent default are the expected boot window; a
//     null after the bus side has been live is the router dying mid-session
//     and blocks.
// The session verdict is the worst across mappings and page loads. A capture
// recorded before a mapping's browser tap simply has no trace for it — that
// mapping reports UNKNOWN and blocks (an unjudged cutover is not a pass).
//
// Usage: node tools/replay/viz-ab.js <capture-session-dir>
// Exit:  0 = MATCH/EXPECTED, 1 = blocked (REGRESSION/UNKNOWN), 2 = harness error.

'use strict';

const path = require('path');

const { loadSession } = require('./capture-io');
const tolerances = require('./tolerances');

// One entry per browser-consumed mapping: the snapshot trace key, the bus
// path whose declared tolerance judges it, the snapshot flag field, and the
// mapping's sensor-absent default (what legacy shows while the bus side is
// expected to be silent).
const MAPPINGS = [
  { trace: 'twist_trace', path: 'fx.viz.twist_gain', flag: 'twist', absentDefault: 1 },
  { trace: 'bitmap_trace', path: 'fx.viz.bitmap_x', flag: 'bitmapx', absentDefault: 0 },
];

function judgePage(samples, tol, absentDefault) {
  // Split off the boot window: leading bus-null samples are expected while
  // the graph has not yet published (page just loaded / no distance yet).
  let firstLive = samples.findIndex((s) => typeof s.bus === 'number');
  if (firstLive < 0) firstLive = samples.length;
  const boot = samples.slice(0, firstLive);
  const live = samples.slice(firstLive);
  const bootBad = boot.filter((s) => s.legacy !== absentDefault).length; // legacy moved while bus absent
  const midNull = live.filter((s) => typeof s.bus !== 'number').length;

  // Pointwise errors with the lag allowance over neighboring samples, plus
  // the TRAVERSAL rule from the CC step comparator: the trace samples at
  // <= 4 Hz, so on a fast edge (a visitor lunging 140 -> 40 cm in one
  // sample) both sides are mid-flight at different phases and no neighbor
  // value matches — but the bus value lying INSIDE the legacy side's
  // min..max span over the lag window means legacy traversed it. Sustained
  // wrongness still fails: at plateaus the span collapses to a point, and
  // the dense offline grid gate guards the shape independently.
  const lagMs = tol.trace_lag_ms || tol.lag_ms;
  const errs = [];
  for (let i = 0; i < live.length; i++) {
    const s = live[i];
    if (typeof s.bus !== 'number') { errs.push(null); continue; } // judged via midNull
    let best = Math.abs(s.legacy - s.bus);
    let lo = s.legacy;
    let hi = s.legacy;
    for (let j = i - 1; j >= 0 && s.t - live[j].t <= lagMs; j--) {
      best = Math.min(best, Math.abs(live[j].legacy - s.bus));
      lo = Math.min(lo, live[j].legacy); hi = Math.max(hi, live[j].legacy);
    }
    for (let j = i + 1; j < live.length && live[j].t - s.t <= lagMs; j++) {
      best = Math.min(best, Math.abs(live[j].legacy - s.bus));
      lo = Math.min(lo, live[j].legacy); hi = Math.max(hi, live[j].legacy);
    }
    if (s.bus >= lo - tol.eps_abs && s.bus <= hi + tol.eps_abs) best = 0; // traversed
    errs.push(best);
  }

  // Violating runs vs the transient class (durations from sample timestamps).
  const runs = [];
  for (let i = 0; i < live.length; i++) {
    if (errs[i] === null || errs[i] <= tol.eps_abs) continue;
    const start = i;
    let maxErr = 0;
    while (i < live.length && errs[i] !== null && errs[i] > tol.eps_abs) {
      maxErr = Math.max(maxErr, errs[i]);
      i++;
    }
    const durMs = (i < live.length ? live[i].t : live[i - 1].t) - live[start].t;
    runs.push({
      t: live[start].t,
      duration_ms: durMs,
      points: i - start,
      max_err: Math.round(maxErr * 1e4) / 1e4,
      excused: durMs <= tol.transient_max_ms && maxErr <= tol.transient_eps_abs,
    });
  }
  // Transient budget by WALL TIME, not sample count: the trace is on-change,
  // so its samples cluster during motion — exactly where settle-hold
  // transients live — and a sample-count fraction would overcount them.
  // Same declared fraction as the offline grid (whose 50 ms points ARE
  // wall-time-proportional).
  const excusedMs = runs.filter((r) => r.excused).reduce((a, r) => a + r.duration_ms, 0);
  const windowMs = live.length > 1 ? live[live.length - 1].t - live[0].t : 0;
  const overBudget = windowMs > 0 && excusedMs > windowMs * tol.transient_grid_frac_max;
  const blocking = runs.filter((r) => !r.excused);
  const maxErr = Math.max(0, ...errs.filter((e) => e !== null));

  let verdict = 'MATCH';
  if (!samples.length) verdict = 'UNKNOWN';
  else if (blocking.length || overBudget || bootBad || midNull) verdict = 'REGRESSION';
  return {
    verdict,
    samples: samples.length,
    boot_window: boot.length,
    boot_bad: bootBad,
    mid_session_nulls: midNull,
    max_abs_err_after_lag: Math.round(maxErr * 1e4) / 1e4,
    excused_runs: runs.filter((r) => r.excused).length,
    excused_ms: excusedMs,
    window_ms: windowMs,
    over_budget: overBudget,
    violations: blocking.slice(0, 10),
  };
}

function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: viz-ab.js <capture-session-dir>');
  const golden = loadSession(path.resolve(dir));

  // Traces per mapping per page load, in capture order (t is page-relative).
  const pages = new Map(); // trace key -> Map(page_load_id -> samples)
  for (const m of MAPPINGS) pages.set(m.trace, new Map());
  const flags = {};
  let snapshots = 0;
  for (const ev of golden.events) {
    if (ev.kind !== 'browser_snapshot' || !ev.snapshot) continue;
    snapshots += 1;
    const s = ev.snapshot;
    for (const m of MAPPINGS) {
      if (typeof s[m.flag] === 'string') flags[m.flag] = s[m.flag];
      if (!Array.isArray(s[m.trace])) continue;
      const byPage = pages.get(m.trace);
      if (!byPage.has(s.page_load_id)) byPage.set(s.page_load_id, []);
      byPage.get(s.page_load_id).push(...s[m.trace]);
    }
  }

  const order = ['MATCH', 'EXPECTED_DIFFERENCE', 'UNKNOWN', 'REGRESSION'];
  let worst = 'MATCH';
  console.log(`viz-ab: ${snapshots} snapshots, flags ${MAPPINGS.map((m) => `${m.flag}=${flags[m.flag] || '?'}`).join(' ')}\n`);
  for (const m of MAPPINGS) {
    const byPage = pages.get(m.trace);
    const tol = tolerances.derived[m.path];
    if (!byPage.size) {
      console.log(`  ${'UNKNOWN'.padEnd(20)} ${m.trace.padEnd(14)} no snapshots carry it `
        + '(captured before this mapping\'s browser tap) — blocks');
      worst = order[Math.max(order.indexOf(worst), order.indexOf('UNKNOWN'))];
      continue;
    }
    for (const [pageId, samples] of byPage) {
      samples.sort((a, b) => a.t - b.t);
      const r = judgePage(samples, tol, m.absentDefault);
      if (order.indexOf(r.verdict) > order.indexOf(worst)) worst = r.verdict;
      console.log(`  ${r.verdict.padEnd(20)} ${m.trace.padEnd(14)} page ${pageId}  ${r.samples} samples, `
        + `max |err| ${r.max_abs_err_after_lag} after ±${tol.trace_lag_ms || tol.lag_ms}ms+traversal `
        + `(eps ${tol.eps_abs}), ${r.excused_runs} transient run(s) excused`
        + (r.boot_bad ? `, BOOT-BAD ${r.boot_bad}` : '')
        + (r.mid_session_nulls ? `, MID-SESSION NULLS ${r.mid_session_nulls}` : ''));
      for (const v of r.violations) {
        console.log(`      violation t=${v.t}ms dur=${v.duration_ms}ms max_err=${v.max_err}`);
      }
    }
  }
  console.log(`\nverdict: ${worst}`);
  process.exit(worst === 'MATCH' || worst === 'EXPECTED_DIFFERENCE' ? 0 : 1);
}

try { main(); } catch (e) { console.error(`viz-ab: ${e.message}`); process.exit(2); }
