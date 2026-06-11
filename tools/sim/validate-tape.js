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
// Endpoint conditioning + boot defaults moved INTO the bus adapter at 4C
// (the ingest-boundary hoist this validator's 4B mirror anticipated): the
// adapter now publishes near=75/far=130 from a standing idle-priority
// defaults writer and refuses invalid claims (far <= effective near, etc.),
// so the sim needs no seeds and no entry filtering — the production writer
// discipline does it all. Rejected claims surface in the report.
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

// The MIDI transport adapter model — writeCc, verbatim semantics:
// round+clamp to 0..127, write only on change, skip (without updating state)
// inside the 33 ms per-CC window. Times are the trajectory's virtual times,
// which sit on the same t_mono timeline as the golden's serial_tx events.
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
  const { report, collected } = runSim({
    goldenDir,
    graphJson,
    identityCheck: false,
    outDir,
    quiet: true,
    collect: [TAPE_PATH],
    graphSourceId: ROUTER_SOURCE,
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

  // ── live lane (4C) ──────────────────────────────────────────────────────
  // When the capture was recorded with the live router running, it carries
  // `bus_tx` events — the in-bridge graph's actual output. Same inputs, same
  // code, same timeline => the live VALUE-CHANGE sequence must equal the
  // simulated one exactly (publish counts differ legitimately: wall-clock
  // keepalive cadence re-evaluates at slightly different times, emitting
  // duplicate values; changes are the invariant). Time skew bound: the live
  // tap stamps at processing time, sub-ms after the input the sim stamps at.
  const dedupeChanges = (seq) => seq.filter((p, i) => i === 0 || p.value !== seq[i - 1].value);
  const busTx = golden.events.filter((e) => e.kind === 'bus_tx' && e.path === TAPE_PATH)
    .map((e) => ({ t: e.t_mono_ms, value: e.value }));
  let live = { present: false, note: 'capture has no bus_tx (recorded before 4C, or router not running)' };
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

  const validation = {
    schema: 'tape-validation.v1',
    phase: '4B',
    graph: graphFile,
    // Ingest-boundary conditioning (4C, in the production adapter): claims
    // refused at the bus boundary + the effective endpoints at session end.
    conditioning: report.conditioning,
    trajectory_points: trajectory.length,
    predicted_cc_events: predicted.length,
    golden_cc_events: goldenCcCount,
    results: ccResults,
    live_graph: live,
    verdict: (live.present && !live.pass) ? 'REGRESSION' : verdict,
    blocks: verdict === 'REGRESSION' || verdict === 'UNKNOWN' || (live.present && !live.pass),
  };
  fs.writeFileSync(path.join(outDir, 'tape-validation.json'), JSON.stringify(validation, null, 2));

  if (!quiet) {
    console.log(`tape graph: ${trajectory.length} fx.tape.failure points -> `
      + `${predicted.length} predicted CC ${CC_TAPE} writes vs ${goldenCcCount} captured`);
    for (const r of ccResults) console.log(`  ${r.verdict.padEnd(20)} ${r.id.padEnd(22)} ${r.detail}`);
    if (live.present) {
      console.log(`  ${(live.pass ? 'MATCH' : 'REGRESSION').padEnd(20)} live:fx.tape.failure   `
        + `${live.live_changes} live changes vs ${live.sim_changes} sim (${live.live_publishes} live publishes)`);
    } else {
      console.log(`  ${'ABSENT'.padEnd(20)} live:fx.tape.failure   ${live.note}`);
    }
    console.log(`\nverdict: ${validation.verdict}  (report: ${path.join(outDir, 'tape-validation.json')})`);
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

module.exports = { validateTape, midiAdapterModel };
