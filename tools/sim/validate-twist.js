#!/usr/bin/env node
// Phase 5 gate (MIGRATION_PLAN.md): the compiled viz-twist graph, validated
// OFFLINE against the legacy in-browser distance→twist math. All shared
// machinery — the frame-clocked legacy model, the derived/smoothed
// comparator with the SETTLE-HOLD transient class, the live bus_tx lane —
// lives in viz-gate.js; this file is only the mapping's shape:
//
//   REVERSED quadratic ramp (static/index.html applyAutomation): gain 1
//   at/within NEAR (max twist), 0 at/beyond FAR, (1-x)² between, over the
//   live-guarded near/far endpoints; gain 1 while no distance has been seen
//   (sensor-offline semantics).
//
// The browser-side A/B (legacy vs consumed gain, snapshot `twist_trace`) is
// the live cutover gate, judged by tools/replay/viz-ab.js, not here.
//
// Usage: node tools/sim/validate-twist.js <golden-session-dir> [--graph FILE] [--out DIR] [--quiet]
// Exit:  0 = MATCH, 1 = blocked (REGRESSION/UNKNOWN), 2 = harness error.

'use strict';

const path = require('path');

const { runGateCli } = require('./viz-gate');

const DEFAULT_GRAPH = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest', 'graphs', 'viz-twist.json');

function twistShape(smoothed, nearCm, farCm) {
  if (typeof smoothed !== 'number') return 1; // sensor absent -> full authored twist
  if (smoothed <= nearCm) return 1;
  if (smoothed >= farCm) return 0;
  const x = (smoothed - nearCm) / (farCm - nearCm);
  return (1 - x) * (1 - x);
}

try {
  runGateCli({
    argv: process.argv,
    defaultGraph: DEFAULT_GRAPH,
    busPath: 'fx.viz.twist_gain',
    label: 'twist',
    shapeFn: twistShape,
    usage: 'usage: validate-twist.js <golden-session-dir> [--graph FILE] [--out DIR] [--quiet]',
  });
} catch (e) {
  console.error(`validate-twist: ${e.message}`);
  process.exit(2);
}
