#!/usr/bin/env node
// Phase 4B gate (MIGRATION_PLAN.md): the compiled nearness graph, validated
// OFFLINE against the golden's captured CC 23 trace.
//
//   capture inputs -> sim (manifests + policy + tape-failure graph)
//     -> fx.tape.failure trajectory
//     -> MIDI transport adapter model (the part that stays OUT of the graph:
//        0..127 quantize, on-change dedupe, 33 ms per-CC rate cap — exactly
//        server/src/inputs/daisy-position.js writeCc)
//     -> predicted CC 23 events
//   compared against the golden's serial_tx CC 23 stream with the phase-0
//   comparator's step-function rules + declared tolerances (cc 23: eps 1,
//   window 250 ms — the same gates the replay harness passes).
//
// Seeds: the legacy bridge boots with NEAR_DEFAULT_CM=75 / FAR_DEFAULT_CM=130
// until the sidecar publishes endpoints. The sim restores those as
// session-start seeds — the simulator analog of the replay harness restoring
// trigger env from meta.json. Both seeds are declared in the report.
//
// Source conditioning (a 4B DISCOVERY, see MIGRATION_PLAN.md phase-4 status):
// legacy guards endpoint updates CONSUMER-side — daisy-position ignores a
// `distance_far_cm` claim unless it exceeds the effective near (and a near
// claim unless 0 <= near < effective far). The mock golden actually contains
// an invalid far=50 claim that legacy rejected (130 stayed in effect), while
// the phase-1 bus adapter forwards raw claims — so the bus's far_cm and the
// legacy-effective far diverge. Until that conditioning is hoisted to the
// bridge ingest boundary (4C, when the graph goes live), this validator
// applies a mirror of the legacy guards to the input timeline, and counts
// what it drops.
//
// Usage: node tools/sim/validate-tape.js <golden-session-dir> [--graph FILE] [--out DIR] [--quiet]
// Exit:  0 = MATCH, 1 = blocked (REGRESSION/UNKNOWN), 2 = harness error.

'use strict';

const fs = require('fs');
const path = require('path');

const { runSim } = require('./sim');
const { compareCc } = require('../replay/comparator');
const { loadSession } = require('../replay/capture-io');
const tolerances = require('../replay/tolerances');

const DEFAULT_GRAPH = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest', 'graphs', 'tape-failure.json');
const ROUTER_SOURCE = 'spiffe://pain-material.local/bridge/router';
const TAPE_PATH = 'fx.tape.failure';
const CC_TAPE = 23;

// Legacy bridge constants in effect when near/far are never published
// (daisy-position.js NEAR_DEFAULT_CM / FAR_DEFAULT_CM).
const SEEDS = [
  { name: 'distance_near_cm', value: 75 },
  { name: 'distance_far_cm', value: 130 },
];

// The MIDI transport adapter model — writeCc, verbatim semantics:
// round+clamp to 0..127, write only on change, skip (without updating state)
// inside the 33 ms per-CC window. Times are the trajectory's virtual times,
// which sit on the same t_mono timeline as the golden's serial_tx events.
// The legacy endpoint validity guards (daisy-position.js onChange), mirrored
// over the input timeline as a stateful filter: a near claim must satisfy
// 0 <= near < effective far; a far claim must exceed effective near; invalid
// claims are dropped (the previous effective value holds — NOT clamped).
function conditionEndpoints(defaults = { near: 75, far: 130 }) {
  let effNear = defaults.near;
  let effFar = defaults.far;
  const dropped = [];
  const fn = (entries) => entries.filter((e) => {
    if (e.name === 'distance_near_cm') {
      if (e.value >= 0 && e.value < effFar) { effNear = e.value; return true; }
      dropped.push({ t: e.t, name: e.name, value: e.value, effective: { near: effNear, far: effFar } });
      return false;
    }
    if (e.name === 'distance_far_cm') {
      if (e.value > effNear) { effFar = e.value; return true; }
      dropped.push({ t: e.t, name: e.name, value: e.value, effective: { near: effNear, far: effFar } });
      return false;
    }
    return true;
  });
  fn.dropped = dropped;
  return fn;
}

const MIN_WRITE_MS = 33;
function midiAdapterModel(trajectory) {
  const events = [];
  let lastV;
  let lastWriteAt = -Infinity;
  for (const { t, value } of trajectory) {
    const v = Math.min(127, Math.max(0, Math.round(value * 127)));
    if (v === lastV) continue;
    if (t - lastWriteAt < MIN_WRITE_MS) continue;
    events.push({ t_mono_ms: t, v });
    lastV = v;
    lastWriteAt = t;
  }
  return events;
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
  if (!args.dir) throw new Error('usage: validate-tape.js <golden-session-dir> [--graph FILE] [--out DIR] [--quiet]');
  return args;
}

function validateTape({ goldenDir, graphFile = DEFAULT_GRAPH, outDir, quiet = false }) {
  const graphJson = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  const condition = conditionEndpoints({ near: SEEDS[0].value, far: SEEDS[1].value });
  const { report, collected } = runSim({
    goldenDir,
    graphJson,
    identityCheck: false,
    outDir,
    quiet: true,
    seeds: SEEDS,
    collect: [TAPE_PATH],
    graphSourceId: ROUTER_SOURCE,
    conditionEntries: condition,
  });

  const trajectory = collected[TAPE_PATH] || [];
  const predicted = midiAdapterModel(trajectory);

  // The comparator consumes capture-shaped {events}; the predicted stream
  // becomes a pseudo-capture on the SAME t_mono timeline, with one anchor
  // event so rel() aligns both sides identically.
  const golden = loadSession(goldenDir);
  const anchor = golden.events.find((e) => e.kind === 'ingest' || e.kind === 'serial_rx');
  const pseudo = {
    dir: '<predicted from graph>',
    events: [
      { seq: 0, t_mono_ms: anchor.t_mono_ms, kind: 'serial_rx', raw: '<anchor>' },
      ...predicted.map((e, i) => ({
        seq: i + 1, t_mono_ms: e.t_mono_ms, kind: 'serial_tx',
        decoded: { type: 'cc', cc: CC_TAPE, value: e.v },
      })),
    ],
  };

  const results = [];
  compareCc(golden, pseudo, tolerances, results);
  // Only CC 23 is the tape mapping's output; CC 24 (freeze) is not this
  // graph's sink. The golden contains no CC 24 traffic, but filter defensively
  // so an unrelated CC never gates this validator.
  const ccResults = results.filter((r) => r.id.startsWith(`cc:${CC_TAPE}`));
  const verdict = ccResults.length ? ccResults.reduce(
    (v, r) => (['MATCH', 'EXPECTED_DIFFERENCE', 'UNKNOWN', 'REGRESSION'].indexOf(r.verdict)
      > ['MATCH', 'EXPECTED_DIFFERENCE', 'UNKNOWN', 'REGRESSION'].indexOf(v) ? r.verdict : v),
    'MATCH',
  ) : 'UNKNOWN';

  const goldenCcCount = golden.events.filter(
    (e) => e.kind === 'serial_tx' && e.decoded && e.decoded.type === 'cc' && e.decoded.cc === CC_TAPE,
  ).length;

  const validation = {
    schema: 'tape-validation.v1',
    phase: '4B',
    graph: graphFile,
    seeds: SEEDS,
    // Legacy-guard mirror: endpoint claims legacy would have ignored, dropped
    // from the bus inputs too (pending the 4C hoist to the ingest boundary).
    conditioned_drops: condition.dropped,
    trajectory_points: trajectory.length,
    predicted_cc_events: predicted.length,
    golden_cc_events: goldenCcCount,
    results: ccResults,
    verdict,
    blocks: verdict === 'REGRESSION' || verdict === 'UNKNOWN',
  };
  fs.writeFileSync(path.join(outDir, 'tape-validation.json'), JSON.stringify(validation, null, 2));

  if (!quiet) {
    console.log(`tape graph: ${trajectory.length} fx.tape.failure points -> `
      + `${predicted.length} predicted CC ${CC_TAPE} writes vs ${goldenCcCount} captured`);
    for (const r of ccResults) console.log(`  ${r.verdict.padEnd(20)} ${r.id.padEnd(22)} ${r.detail}`);
    console.log(`\n4B verdict: ${verdict}  (report: ${path.join(outDir, 'tape-validation.json')})`);
  }
  return { validation, simReport: report };
}

function main() {
  const args = parseArgs(process.argv);
  const goldenDir = path.resolve(args.dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const outDir = path.resolve(args.out || path.join(goldenDir, 'sims', `tape-${stamp}`));
  const { validation } = validateTape({ goldenDir, graphFile: args.graph, outDir, quiet: args.quiet });
  process.exit(validation.blocks ? 1 : 0);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`validate-tape: ${e.message}`); process.exit(2); }
}

module.exports = { validateTape, midiAdapterModel, conditionEndpoints, SEEDS };
