#!/usr/bin/env node
// Phase 6.1 step-one gate (MIGRATION_PLAN.md, the approved two-step): the
// compiled occupancy graph, validated OFFLINE against the legacy occupancy.
//
//   capture inputs -> sim (manifests + policy + occupancy graph)
//     -> derived.room.occupied trajectory (the SHADOW candidate)
//   compared, as a binary EDGE sequence, against the legacy lane:
//     - captures recorded after the 6.1 tap carry `legacy_occupancy` events
//       (daisy-position's actual roomOccupied edges) — the authoritative lane;
//     - older goldens get the FROZEN-SPEC MODEL of computeOccupancy /
//       motionPresent (verbatim: distance hysteresis at 0.85/0.92 of the
//       guarded live far, motion forcing occupancy with the 20 s hold,
//       evaluated on every distance/motion arrival and the 500 ms tick).
//
// Comparator: ordered edge correspondence — same directions, same order,
// each edge pair within EDGE_LAG_MS. The declared lag class, bounded by
// mechanism: the legacy tick quantizes expiry edges by <= 500 ms, and the
// graph's motion-hold expiry advances on graph packet arrivals (time only
// arrives with packets — the distance keepalive's 1 s cadence is the floor
// when the room is still), so 1500 ms covers tick + keepalive + skew.
// Distance-driven edges ride the SAME packets on both sides and align to ms.
//
// MOTION_PRESENCE: the graph models the kiosk production config (fusion ON).
// The model follows --motion on|off (default: auto — ON when the capture
// shows motion-mode trigger reasons or any motion traffic; flag-OFF captures
// with motion traffic would diverge BY DESIGN, so the report says which
// config was modeled).
//
// A live lane (capture `bus_tx` for derived.room.occupied, present once the
// shadow deploys) is judged like validate-tape's: live value-change sequence
// == simulated, pointwise.
//
// Usage: node tools/sim/validate-occupancy.js <golden-session-dir> [--motion on|off|auto] [--out DIR] [--quiet]
// Exit:  0 = MATCH, 1 = blocked (REGRESSION/UNKNOWN), 2 = harness error.

'use strict';

const fs = require('fs');
const path = require('path');

const { runSim } = require('./sim');
const { loadSession } = require('../replay/capture-io');
const { inputEntries } = require('./pump');

const DEFAULT_GRAPH = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest', 'graphs', 'occupancy.json');
const OCC_SOURCE = 'spiffe://pain-material.local/bridge/router-occupancy';
const OCC_PATH = 'derived.room.occupied';

const EDGE_LAG_MS = 1500; // declared: legacy 500 ms tick + 1 s keepalive packet-time floor

// ── the frozen-spec legacy model (daisy-position.js verbatim) ───────────────
const NEAR_DEFAULT_CM = 75;
const FAR_DEFAULT_CM = 130;
const BELL_ENTER_FRACTION = 0.15;
const BELL_EMPTY_FRACTION = 0.08;
const MOTION_HOLD_MS = 20000;
const BELL_TICK_MS = 500;

function legacyModel(entries, startT, motionPresence) {
  let nearCm = NEAR_DEFAULT_CM;
  let farCm = FAR_DEFAULT_CM;
  let lastDistanceCm = null;
  let motionActive = false;
  let lastMotionMs = -Infinity;
  let occupied = false;
  const edges = [];

  const evalOccupancy = (nowMs) => {
    // computeOccupancy, verbatim: distance hysteresis owns the baseline;
    // motion (flag-gated) only ever ADDS presence.
    if (lastDistanceCm !== null && farCm > 0) {
      const enterThresh = farCm * (1 - BELL_ENTER_FRACTION);
      const emptyThresh = farCm * (1 - BELL_EMPTY_FRACTION);
      if (lastDistanceCm <= enterThresh) occupied = true;
      else if (lastDistanceCm >= emptyThresh) occupied = false;
    }
    if (motionPresence && (motionActive || nowMs - lastMotionMs <= MOTION_HOLD_MS)) occupied = true;
    const prev = edges.length ? edges[edges.length - 1].to : false;
    if (occupied !== prev) edges.push({ t: nowMs, to: occupied });
  };

  // The 500 ms trigger tick interleaves with arrivals; a tick due at an
  // arrival's timestamp runs first (the scheduler's tie rule).
  let nextTick = startT + BELL_TICK_MS;
  const tickTo = (untilMs) => {
    for (; nextTick <= untilMs; nextTick += BELL_TICK_MS) evalOccupancy(nextTick);
  };

  for (const e of entries) {
    tickTo(e.t);
    if (e.name === 'motion') {
      motionActive = e.value === true || e.value === 1;
      lastMotionMs = e.t; // stamped on EVERY motion message (onChange verbatim)
      evalOccupancy(e.t);
    } else if (typeof e.value !== 'number') {
      continue;
    } else if (e.name === 'distance_near_cm') {
      if (e.value >= 0 && e.value < farCm) nearCm = e.value;
    } else if (e.name === 'distance_far_cm') {
      if (e.value > nearCm) farCm = e.value;
    } else if (e.name === 'distance_cm') {
      lastDistanceCm = e.value;
      evalOccupancy(e.t);
    }
  }
  if (entries.length) tickTo(entries[entries.length - 1].t);
  return edges;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const dedupeChanges = (seq) => seq.filter((p, i) => i === 0 || p.value !== seq[i - 1].value);

// Trajectory (0/1 floats, first point is the boot state) -> edge list.
function trajectoryEdges(traj) {
  const changes = dedupeChanges(traj);
  const edges = [];
  let prev = false; // both worlds start unoccupied
  for (const p of changes) {
    const to = p.value >= 0.5;
    if (to !== prev) { edges.push({ t: p.t, to }); prev = to; }
  }
  return edges;
}

function compareEdges(a, b) {
  // a = legacy (reference), b = graph (candidate)
  const mismatches = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && mismatches.length < 10; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x.to !== y.to || Math.abs(x.t - y.t) > EDGE_LAG_MS) {
      mismatches.push({ index: i, legacy: x || null, graph: y || null });
    }
  }
  return { count_match: a.length === b.length, mismatches, pass: a.length === b.length && mismatches.length === 0 };
}

const occupiedFraction = (edges, startT, endT) => {
  let acc = 0;
  let since = null;
  for (const e of edges) {
    if (e.to && since === null) since = e.t;
    if (!e.to && since !== null) { acc += e.t - since; since = null; }
  }
  if (since !== null) acc += endT - since;
  return endT > startT ? acc / (endT - startT) : 0;
};

function parseArgs(argv) {
  const args = { dir: null, graph: DEFAULT_GRAPH, motion: 'auto', out: null, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--graph') args.graph = argv[++i];
    else if (a === '--motion') args.motion = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (!args.dir) args.dir = a;
    else throw new Error(`unexpected arg: ${a}`);
  }
  if (!args.dir) throw new Error('usage: validate-occupancy.js <golden-session-dir> [--motion on|off|auto] [--out DIR] [--quiet]');
  if (!['on', 'off', 'auto'].includes(args.motion)) throw new Error(`--motion must be on|off|auto, got ${args.motion}`);
  return args;
}

function validateOccupancy({ goldenDir, graphFile = DEFAULT_GRAPH, motion = 'auto', outDir, quiet = false }) {
  const graphJson = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  const { report, collected } = runSim({
    goldenDir,
    graphJson,
    identityCheck: false,
    outDir,
    quiet: true,
    collect: [OCC_PATH],
    graphSourceId: OCC_SOURCE,
  });

  const golden = loadSession(goldenDir);
  const entries = inputEntries(golden.events);
  const startT = Math.min(golden.meta.boot_mono_ms || entries[0].t, entries[0].t);
  const endT = entries[entries.length - 1].t;

  // MOTION_PRESENCE for the legacy model.
  const hasMotion = entries.some((e) => e.name === 'motion');
  const motionModeSeen = golden.events.some((e) => e.kind === 'trigger' && /\(motion/.test(e.reason || ''));
  const motionPresence = motion === 'auto' ? (motionModeSeen || hasMotion) : motion === 'on';

  // Legacy lane: tapped edges when the capture has them, else the model.
  const tapped = golden.events.filter((e) => e.kind === 'legacy_occupancy')
    .map((e) => ({ t: e.t_mono_ms, to: !!e.occupied }));
  const legacyLane = tapped.length ? tapped : legacyModel(entries, startT, motionPresence);
  const legacySource = tapped.length ? 'capture legacy_occupancy tap' : `frozen-spec model (motion ${motionPresence ? 'ON' : 'OFF'})`;

  const trajectory = collected[OCC_PATH] || [];
  const graphLane = trajectoryEdges(trajectory);
  const comparison = compareEdges(legacyLane, graphLane);

  // Live lane: the in-bridge shadow's own writes, once deployed captures carry them.
  const busTx = golden.events.filter((e) => e.kind === 'bus_tx' && e.path === OCC_PATH)
    .map((e) => ({ t: e.t_mono_ms, value: e.value }));
  let live = { present: false, note: 'capture has no bus_tx for derived.room.occupied (recorded before the 6.1 shadow)' };
  if (busTx.length) {
    const liveEdges = trajectoryEdges(busTx);
    const liveCmp = compareEdges(liveEdges, graphLane);
    live = { present: true, live_publishes: busTx.length, live_edges: liveEdges.length, sim_edges: graphLane.length, ...liveCmp };
  }

  const hygieneOk = report.packets.policy_warns === 0 && report.packets.rejected === 0;
  const verdict = comparison.pass && hygieneOk && (!live.present || live.pass) ? 'MATCH' : 'REGRESSION';

  const validation = {
    schema: 'occupancy-validation.v1',
    phase: '6.1-step-1',
    graph: graphFile,
    legacy_lane: legacySource,
    motion_presence_modeled: motionPresence,
    edge_lag_ms: EDGE_LAG_MS,
    legacy_edges: legacyLane.length,
    graph_edges: graphLane.length,
    trajectory_points: trajectory.length,
    occupied_fraction: {
      legacy: Math.round(occupiedFraction(legacyLane, startT, endT) * 1000) / 1000,
      graph: Math.round(occupiedFraction(graphLane, startT, endT) * 1000) / 1000,
    },
    mismatches: comparison.mismatches,
    live_graph: live,
    hygiene: { policy_warns: report.packets.policy_warns, rejected: report.packets.rejected, ok: hygieneOk },
    verdict,
    blocks: verdict !== 'MATCH',
  };
  fs.writeFileSync(path.join(outDir, 'occupancy-validation.json'), JSON.stringify(validation, null, 2));

  if (!quiet) {
    console.log(`occupancy graph: ${trajectory.length} ${OCC_PATH} points -> ${graphLane.length} edges `
      + `vs ${legacyLane.length} legacy edges (${legacySource})`);
    console.log(`  occupied fraction: legacy ${validation.occupied_fraction.legacy} vs graph ${validation.occupied_fraction.graph}`);
    console.log(`  ${(comparison.pass ? 'MATCH' : 'REGRESSION').padEnd(20)} edges`
      + (comparison.mismatches.length ? `  first mismatch: ${JSON.stringify(comparison.mismatches[0])}` : '  all within ±' + EDGE_LAG_MS + ' ms'));
    if (live.present) {
      console.log(`  ${(live.pass ? 'MATCH' : 'REGRESSION').padEnd(20)} live:${OCC_PATH}  ${live.live_edges} live edges vs ${live.sim_edges} sim`);
    } else {
      console.log(`  ${'ABSENT'.padEnd(20)} live:${OCC_PATH}  ${live.note}`);
    }
    console.log(`\nverdict: ${validation.verdict}  (report: ${path.join(outDir, 'occupancy-validation.json')})`);
  }
  return { validation, simReport: report };
}

function main() {
  const args = parseArgs(process.argv);
  const goldenDir = path.resolve(args.dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const outDir = path.resolve(args.out || path.join(goldenDir, 'sims', `occupancy-${stamp}`));
  const { validation } = validateOccupancy({ goldenDir, graphFile: args.graph, motion: args.motion, outDir, quiet: args.quiet });
  process.exit(validation.blocks ? 1 : 0);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`validate-occupancy: ${e.message}`); process.exit(2); }
}

module.exports = { validateOccupancy, legacyModel };
