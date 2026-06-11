#!/usr/bin/env node
// Phase-5 twist A/B judge (MIGRATION_PLAN.md): the LIVE cutover gate for the
// distance→twist mapping, run over a captured kiosk session.
//
// The kiosk page computes BOTH gains every applyAutomation tick — the legacy
// in-browser ramp and the router graph's fx.viz.twist_gain from the bus
// shadow feed — and records paired on-change samples (<= 4 Hz) into each
// capture snapshot as `twist_trace` (static/index.html). This tool replays
// those pairs and issues the comparator verdict:
//   - per sample, |legacy - bus| <= eps_abs, or a neighboring sample within
//     +-lag_ms agrees (transport + arrival-driven-hold phase allowance);
//   - violating runs pass through the declared SETTLE-HOLD transient class
//     (tolerances.js → derived['fx.viz.twist_gain']), same as the offline
//     gate (tools/sim/validate-twist.js);
//   - `bus: null` means the router had published NOTHING yet (absent ≠ 1 —
//     availability semantics). Leading nulls while legacy sits at the
//     sensor-absent default (gain 1) are the expected boot window; a null
//     after the bus side has been live is the router dying mid-session and
//     blocks.
// All page loads in the capture are judged; the session verdict is the worst.
//
// Usage: node tools/replay/twist-ab.js <capture-session-dir>
// Exit:  0 = MATCH/EXPECTED, 1 = blocked (REGRESSION/UNKNOWN), 2 = harness error.

'use strict';

const path = require('path');

const { loadSession } = require('./capture-io');
const tolerances = require('./tolerances');

const TOL = tolerances.derived['fx.viz.twist_gain'];

function judgePage(samples, tol) {
  // Split off the boot window: leading bus-null samples are expected while
  // the graph has not yet published (page just loaded / no distance yet).
  let firstLive = samples.findIndex((s) => typeof s.bus === 'number');
  if (firstLive < 0) firstLive = samples.length;
  const boot = samples.slice(0, firstLive);
  const live = samples.slice(firstLive);
  const bootBad = boot.filter((s) => s.legacy !== 1).length; // legacy moved while bus absent
  const midNull = live.filter((s) => typeof s.bus !== 'number').length;

  // Pointwise errors with the lag allowance over neighboring samples.
  const errs = [];
  for (let i = 0; i < live.length; i++) {
    const s = live[i];
    if (typeof s.bus !== 'number') { errs.push(null); continue; } // judged via midNull
    let best = Math.abs(s.legacy - s.bus);
    for (let j = i - 1; j >= 0 && s.t - live[j].t <= tol.lag_ms; j--) {
      best = Math.min(best, Math.abs(live[j].legacy - s.bus));
    }
    for (let j = i + 1; j < live.length && live[j].t - s.t <= tol.lag_ms; j++) {
      best = Math.min(best, Math.abs(live[j].legacy - s.bus));
    }
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
  const excusedPts = runs.filter((r) => r.excused).reduce((a, r) => a + r.points, 0);
  const overBudget = live.length > 0 && excusedPts > live.length * tol.transient_grid_frac_max;
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
    excused_points: excusedPts,
    over_budget: overBudget,
    violations: blocking.slice(0, 10),
  };
}

function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: twist-ab.js <capture-session-dir>');
  const golden = loadSession(path.resolve(dir));

  // twist_trace per page load, in capture order (t is page-relative).
  const pages = new Map();
  let snapshots = 0;
  let withFlag = null;
  for (const ev of golden.events) {
    if (ev.kind !== 'browser_snapshot' || !ev.snapshot) continue;
    snapshots += 1;
    const s = ev.snapshot;
    if (typeof s.twist === 'string') withFlag = s.twist;
    if (!Array.isArray(s.twist_trace)) continue;
    if (!pages.has(s.page_load_id)) pages.set(s.page_load_id, []);
    pages.get(s.page_load_id).push(...s.twist_trace);
  }

  if (!pages.size) {
    console.log(`twist-ab: ${snapshots} snapshots, none carry twist_trace `
      + '(captured before the phase-5 browser tap) — UNKNOWN, blocks');
    process.exit(1);
  }

  const order = ['MATCH', 'EXPECTED_DIFFERENCE', 'UNKNOWN', 'REGRESSION'];
  let worst = 'MATCH';
  console.log(`twist-ab: ${pages.size} page load(s), flag twist=${withFlag || '?'} during capture\n`);
  for (const [pageId, samples] of pages) {
    samples.sort((a, b) => a.t - b.t);
    const r = judgePage(samples, TOL);
    if (order.indexOf(r.verdict) > order.indexOf(worst)) worst = r.verdict;
    console.log(`  ${r.verdict.padEnd(20)} page ${pageId}  ${r.samples} samples, `
      + `max |err| ${r.max_abs_err_after_lag} after ±${TOL.lag_ms}ms `
      + `(eps ${TOL.eps_abs}), ${r.excused_runs} transient run(s) excused`
      + (r.boot_bad ? `, BOOT-BAD ${r.boot_bad}` : '')
      + (r.mid_session_nulls ? `, MID-SESSION NULLS ${r.mid_session_nulls}` : ''));
    for (const v of r.violations) {
      console.log(`      violation t=${v.t}ms dur=${v.duration_ms}ms max_err=${v.max_err}`);
    }
  }
  console.log(`\nverdict: ${worst}`);
  process.exit(worst === 'MATCH' || worst === 'EXPECTED_DIFFERENCE' ? 0 : 1);
}

try { main(); } catch (e) { console.error(`twist-ab: ${e.message}`); process.exit(2); }
