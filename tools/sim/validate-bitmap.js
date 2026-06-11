#!/usr/bin/env node
// Phase 5 gate (MIGRATION_PLAN.md): the compiled viz-bitmap graph, validated
// OFFLINE against the legacy in-browser distance→bitmap math. Shared
// machinery in viz-gate.js; this file is only the mapping's shape:
//
//   REVERSED linear nearness x (static/index.html applyAutomation): 1
//   at/within NEAR (minimum resolution), 0 at/beyond FAR (full authored
//   resolution), linear between, over the live-guarded near/far endpoints;
//   x 0 while no distance has been seen (legacy skips the harmonic blend —
//   full res — when distance is absent).
//
// The graph publishes the X ONLY. The harmonic blend with the *authored*
// resolution ceiling (1/height interpolation), the 12 px quantize, and the
// setLive/resize conduct stay in the browser host: the ceiling is an
// authored timeline/manual param that is not on the bus, and the IR is
// deliberately not a generative-math language (no reciprocal of a live
// signal) — the blend is the host's application of the mapping, like the
// MIDI adapter's quantize/dedupe/cap.
//
// The browser-side A/B (snapshot `bitmap_trace`) is the live cutover gate,
// judged by tools/replay/viz-ab.js, not here.
//
// Usage: node tools/sim/validate-bitmap.js <golden-session-dir> [--graph FILE] [--out DIR] [--quiet]
// Exit:  0 = MATCH, 1 = blocked (REGRESSION/UNKNOWN), 2 = harness error.

'use strict';

const path = require('path');

const { runGateCli } = require('./viz-gate');

const DEFAULT_GRAPH = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest', 'graphs', 'viz-bitmap.json');

function bitmapShape(smoothed, nearCm, farCm) {
  if (typeof smoothed !== 'number') return 0; // sensor absent -> full res (no blend)
  if (smoothed <= nearCm) return 1;
  if (smoothed >= farCm) return 0;
  return 1 - (smoothed - nearCm) / (farCm - nearCm);
}

try {
  runGateCli({
    argv: process.argv,
    defaultGraph: DEFAULT_GRAPH,
    busPath: 'fx.viz.bitmap_x',
    label: 'bitmap',
    shapeFn: bitmapShape,
    usage: 'usage: validate-bitmap.js <golden-session-dir> [--graph FILE] [--out DIR] [--quiet]',
  });
} catch (e) {
  console.error(`validate-bitmap: ${e.message}`);
  process.exit(2);
}
