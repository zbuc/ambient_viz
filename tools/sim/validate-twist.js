#!/usr/bin/env node
// Phase 5 gate (MIGRATION_PLAN.md): the compiled viz-twist graph, validated
// OFFLINE against the legacy in-browser distance→twist math.
//
// Unlike the tape gate (validate-tape.js), the legacy mapping never crossed a
// tapped boundary — it lived inside applyAutomation(), multiplying the
// authored maxTwistDeg before the worker post — so the capture holds no
// output trace to diff against. The reference side is therefore a
// FRAME-CLOCKED MODEL of the legacy browser math (static/index.html:
// dt-clamped EMA, tau 250 ms, then the reversed quadratic ramp over the
// live-guarded near/far endpoints), driven by the capture's `sse_out`
// stream — exactly the entries the page received. The candidate side is the
// real pipeline: capture inputs -> sim (manifests + policy + viz-twist
// graph) -> fx.viz.twist_gain trajectory.
//
// The two sides legitimately differ in sampling discipline (browser EMA
// converges every frame; the arrival-driven graph Smooth steps per packet
// and HOLDS between packets — ROUTER_IR.md execution semantics), so the
// comparison is the comparator's "derived/smoothed value" row: both
// trajectories resampled onto a grid, each point passing on eps_abs at the
// same instant OR within the declared lag window. Declared in
// tools/replay/tolerances.js → derived['fx.viz.twist_gain'].
//
// Once the graph runs live on the kiosk, captures additionally carry
// `bus_tx` fx.viz.twist_gain — the live lane below then demands the exact
// value-change sequence the sim produces (same rule as the tape gate). The
// browser-side A/B (legacy vs consumed gain, snapshot `twist_trace`) is the
// live cutover gate and is judged by tools/replay/twist-ab.js, not here.
//
// Usage: node tools/sim/validate-twist.js <golden-session-dir> [--graph FILE] [--out DIR] [--quiet]
// Exit:  0 = MATCH, 1 = blocked (REGRESSION/UNKNOWN), 2 = harness error.

'use strict';

const fs = require('fs');
const path = require('path');

const { runSim } = require('./sim');
const { loadSession } = require('../replay/capture-io');
const tolerances = require('../replay/tolerances');

const DEFAULT_GRAPH = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest', 'graphs', 'viz-twist.json');
const ROUTER_SOURCE = 'spiffe://pain-material.local/bridge/router';
const TWIST_PATH = 'fx.viz.twist_gain';
const FRAME_MS = 1000 / 60; // the model's render-frame cadence

// The legacy browser model — applyAutomation()'s twist path, verbatim
// semantics: per-frame dt-clamped EMA over the latest distance ([0, 500] ms,
// seed on first sample), endpoint guards (near >= 0, far > effective near,
// defaults 75/130), then 1 at/within NEAR, 0 at/beyond FAR, (1-x)² between.
// Gain is 1 until a distance has been seen (sensor-offline semantics).
function legacyTwistModel(events, { tauS = 0.25 } = {}) {
  const entries = [];
  for (const ev of events) {
    if (ev.kind === 'sse_out' && ev.entry && typeof ev.entry.name === 'string') {
      entries.push({ t: ev.t_mono_ms, name: ev.entry.name, value: ev.entry.value });
    }
  }
  if (!entries.length) return [];

  let dRaw; let near; let far;
  let smoothed = null;
  let lastSmoothT = 0;
  const out = [];
  let lastGain;

  const t0 = entries[0].t;
  const tEnd = entries[entries.length - 1].t;
  let i = 0;
  for (let t = t0; t <= tEnd + FRAME_MS; t += FRAME_MS) {
    while (i < entries.length && entries[i].t <= t) {
      const e = entries[i++];
      if (e.name === 'distance_cm') dRaw = e.value;
      else if (e.name === 'distance_near_cm') near = e.value;
      else if (e.name === 'distance_far_cm') far = e.value;
    }
    if (typeof dRaw === 'number') {
      const dtS = (lastSmoothT > 0) ? Math.max(0, Math.min(0.5, (t - lastSmoothT) / 1000)) : 0;
      lastSmoothT = t;
      if (smoothed === null || dtS === 0) smoothed = dRaw;
      else {
        const a = 1 - Math.exp(-dtS / tauS);
        smoothed = a * dRaw + (1 - a) * smoothed;
      }
    }
    const nearCm = (typeof near === 'number' && near >= 0) ? near : 75;
    const farCm = (typeof far === 'number' && far > nearCm) ? far : 130;
    let gain = 1;
    if (typeof smoothed === 'number') {
      if (smoothed <= nearCm) gain = 1;
      else if (smoothed >= farCm) gain = 0;
      else {
        const x = (smoothed - nearCm) / (farCm - nearCm);
        gain = (1 - x) * (1 - x);
      }
    }
    if (gain !== lastGain) { out.push({ t, value: gain }); lastGain = gain; }
  }
  return out;
}

// ZOH-resample a {t, value} change list onto a regular grid.
function gridSample(trajectory, t0, t1, gridMs) {
  const n = Math.floor((t1 - t0) / gridMs) + 1;
  const out = new Float64Array(n);
  let i = 0;
  let v = trajectory[0].value;
  for (let k = 0; k < n; k++) {
    const t = t0 + k * gridMs;
    while (i < trajectory.length && trajectory[i].t <= t) v = trajectory[i++].value;
    out[k] = v;
  }
  return out;
}

// The derived/smoothed comparator: per grid point, |L-G| <= eps at the same
// instant, or some legacy value within +-lag_ms matches G within eps.
// Violating points then pass through the declared SETTLE-HOLD transient
// class (see tolerances.js → derived): a consecutive violating run is
// EXCUSED if it lasts <= transient_max_ms with every error <=
// transient_eps_abs, and the excused total stays under
// transient_grid_frac_max of all grid points. Anything past that is a
// REGRESSION.
function compareDerived(legacy, graph, tol) {
  const { eps_abs, lag_ms, grid_ms } = tol;
  if (!legacy.length || !graph.length) {
    return { verdict: 'UNKNOWN', reason: 'one side produced no trajectory' };
  }
  const t0 = Math.max(legacy[0].t, graph[0].t);
  const t1 = Math.min(legacy[legacy.length - 1].t, graph[graph.length - 1].t);
  if (t1 - t0 < grid_ms) return { verdict: 'UNKNOWN', reason: 'trajectories do not overlap' };
  const L = gridSample(legacy, t0, t1, grid_ms);
  const G = gridSample(graph, t0, t1, grid_ms);
  const lagPts = Math.round(lag_ms / grid_ms);
  let rawMax = 0;
  let slackMax = 0;
  const errs = new Float64Array(G.length);
  for (let k = 0; k < G.length; k++) {
    const raw = Math.abs(L[k] - G[k]);
    if (raw > rawMax) rawMax = raw;
    let best = raw;
    for (let j = Math.max(0, k - lagPts); j <= Math.min(L.length - 1, k + lagPts) && best > eps_abs; j++) {
      const e = Math.abs(L[j] - G[k]);
      if (e < best) best = e;
    }
    errs[k] = best;
    if (best > slackMax) slackMax = best;
  }

  // Group violating points into consecutive runs; judge each run against the
  // transient class.
  const maxRunPts = Math.round((tol.transient_max_ms || 0) / grid_ms);
  const runs = [];
  for (let k = 0; k < G.length; k++) {
    if (errs[k] <= eps_abs) continue;
    const start = k;
    let runMaxErr = 0;
    while (k < G.length && errs[k] > eps_abs) { runMaxErr = Math.max(runMaxErr, errs[k]); k++; }
    runs.push({
      t: t0 + start * grid_ms,
      duration_ms: (k - start) * grid_ms,
      points: k - start,
      max_err: Math.round(runMaxErr * 1e4) / 1e4,
      legacy: L[start],
      graph: G[start],
      excused: (k - start) <= maxRunPts && runMaxErr <= (tol.transient_eps_abs || 0),
    });
  }
  const excusedPts = runs.filter((r) => r.excused).reduce((a, r) => a + r.points, 0);
  const overBudget = excusedPts > G.length * (tol.transient_grid_frac_max || 0);
  const blockingRuns = runs.filter((r) => !r.excused);
  return {
    verdict: (blockingRuns.length || overBudget) ? 'REGRESSION' : 'MATCH',
    grid_points: G.length,
    overlap_s: Math.round((t1 - t0) / 100) / 10,
    raw_max_abs_err: Math.round(rawMax * 1e4) / 1e4,
    lag_max_abs_err: Math.round(slackMax * 1e4) / 1e4,
    eps_abs,
    lag_ms,
    transient: {
      eps_abs: tol.transient_eps_abs,
      max_ms: tol.transient_max_ms,
      grid_frac_max: tol.transient_grid_frac_max,
      excused_runs: runs.filter((r) => r.excused).length,
      excused_points: excusedPts,
      excused_frac: Math.round((excusedPts / G.length) * 1e4) / 1e4,
      over_budget: overBudget,
    },
    violations: blockingRuns.slice(0, 10),
    excused: runs.filter((r) => r.excused).slice(0, 20),
  };
}

function parseArgs(argv) {
  const args = { dir: null, graph: DEFAULT_GRAPH, out: null, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--graph') args.graph = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (!args.dir) args.dir = a;
    else throw new Error(`unexpected arg: ${a}`);
  }
  if (!args.dir) throw new Error('usage: validate-twist.js <golden-session-dir> [--graph FILE] [--out DIR] [--quiet]');
  return args;
}

function validateTwist({ goldenDir, graphFile = DEFAULT_GRAPH, outDir, quiet = false }) {
  const graphJson = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  const { report, collected } = runSim({
    goldenDir,
    graphJson,
    identityCheck: false,
    outDir,
    quiet: true,
    collect: [TWIST_PATH],
    graphSourceId: ROUTER_SOURCE,
  });

  const trajectory = collected[TWIST_PATH] || [];
  const golden = loadSession(goldenDir);
  const legacy = legacyTwistModel(golden.events);
  const tol = tolerances.derived[TWIST_PATH];
  const model = compareDerived(legacy, trajectory, tol);

  // ── live lane ───────────────────────────────────────────────────────────
  // Captures recorded with the live viz-twist graph carry its bus_tx writes.
  // Same inputs, same code, same timeline => the live VALUE-CHANGE sequence
  // must equal the simulated one exactly (same rule as the tape gate).
  const dedupeChanges = (seq) => seq.filter((p, i) => i === 0 || p.value !== seq[i - 1].value);
  const busTx = golden.events.filter((e) => e.kind === 'bus_tx' && e.path === TWIST_PATH)
    .map((e) => ({ t: e.t_mono_ms, value: e.value }));
  let live = { present: false, note: 'capture has no bus_tx for fx.viz.twist_gain (recorded before the phase-5 graph ran live)' };
  if (busTx.length) {
    const liveChanges = dedupeChanges(busTx);
    const simChanges = dedupeChanges(trajectory);
    const mismatches = [];
    const n = Math.max(liveChanges.length, simChanges.length);
    for (let i = 0; i < n && mismatches.length < 10; i++) {
      const a = liveChanges[i];
      const b = simChanges[i];
      if (!a || !b || a.value !== b.value || Math.abs(a.t - b.t) > 250) {
        mismatches.push({ index: i, live: a || null, sim: b || null });
      }
    }
    live = {
      present: true,
      live_publishes: busTx.length,
      live_changes: liveChanges.length,
      sim_changes: simChanges.length,
      mismatches,
      pass: mismatches.length === 0 && liveChanges.length === simChanges.length,
    };
  }

  const blocked = model.verdict === 'REGRESSION' || model.verdict === 'UNKNOWN' || (live.present && !live.pass);
  const validation = {
    schema: 'twist-validation.v1',
    phase: '5',
    graph: graphFile,
    conditioning: report.conditioning,
    trajectory_points: trajectory.length,
    legacy_model_changes: legacy.length,
    model_vs_graph: model,
    live_graph: live,
    verdict: (live.present && !live.pass) ? 'REGRESSION' : model.verdict,
    blocks: blocked,
  };
  fs.writeFileSync(path.join(outDir, 'twist-validation.json'), JSON.stringify(validation, null, 2));

  if (!quiet) {
    console.log(`twist graph: ${trajectory.length} fx.viz.twist_gain points vs `
      + `${legacy.length} legacy-model changes`);
    console.log(`  ${model.verdict.padEnd(20)} model:${TWIST_PATH}  `
      + (model.reason || `raw max |err| ${model.raw_max_abs_err}, after ±${model.lag_ms}ms lag ${model.lag_max_abs_err} `
      + `(eps ${model.eps_abs}, ${model.grid_points} grid points over ${model.overlap_s}s)`));
    if (live.present) {
      console.log(`  ${(live.pass ? 'MATCH' : 'REGRESSION').padEnd(20)} live:${TWIST_PATH}  `
        + `${live.live_changes} live changes vs ${live.sim_changes} sim (${live.live_publishes} live publishes)`);
    } else {
      console.log(`  ${'ABSENT'.padEnd(20)} live:${TWIST_PATH}  ${live.note}`);
    }
    console.log(`\nverdict: ${validation.verdict}  (report: ${path.join(outDir, 'twist-validation.json')})`);
  }
  return { validation, simReport: report };
}

function main() {
  const args = parseArgs(process.argv);
  const goldenDir = path.resolve(args.dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const outDir = path.resolve(args.out || path.join(goldenDir, 'sims', `twist-${stamp}`));
  const { validation } = validateTwist({ goldenDir, graphFile: args.graph, outDir, quiet: args.quiet });
  process.exit(validation.blocks ? 1 : 0);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`validate-twist: ${e.message}`); process.exit(2); }
}

module.exports = { validateTwist, legacyTwistModel, compareDerived };
