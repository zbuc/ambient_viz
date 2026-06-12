// mood_expander.v1 — the mood layer's expansion stage (PROCMUSIC.md §5).
//
// A mood is a named anchor in parameter space, authored as project data
// (manifest/moods.json). This plugin is the deterministic expansion: a mood
// position (x, y) → inverse-distance² weights over all anchors → one blended
// genome, published as music.genome.* STATE for the P2 CC transport to carry
// to the Daisy. The algorithm never moves between "ambient" and "techno" —
// it moves the position; every reachable point is on a path between
// aesthetics the artist authored.
//
// Position source, in priority order:
//   - bound STATE inputs `x`/`y` (music.mood.* — timeline lane, sensor
//     graph, or the P6 optimizer; none exist yet, ports are optional);
//   - else the instantiation params mood_x/mood_y (the static-mood case).
//
// Contract posture:
//   - REPLAYABLE trivially — a pure function of inputs; ctx.rand is never
//     drawn, so the PRNG stream stays untouched under replay.
//   - SNAPSHOTTABLE — state is only the emit-on-change dedupe cache (last
//     emitted per gene), captured so replay-resume re-emits identically.
//   - Anchors are loaded once at create() and must be COMPLETE: every anchor
//     carries every gene, finite, in [0,1] — a loud load error, never a
//     silent default (the host-side serde(default) grace is for hand-edited
//     audition files; the production path forces anchors to keep up with the
//     gene table).
//   - FX values in anchors are NOT published here: their bus topics / CC
//     bindings land in P2, and fx.tape.failure is the door graph's (sole
//     writer). Until then the Mac host's audition rig is the FX consumer.
//
// Smoothing is deliberately absent: slew belongs to the mood WRITERS (a
// Smooth node on the graph that drives music.mood.*), so the expander stays
// a pure function and different writers can choose different time constants.

'use strict';

const fs = require('fs');
const path = require('path');

// Gene order = the PROCMUSIC.md §4 table = dsp::procgen::Genome::to_array().
// Keep all three in sync when a gene is added.
const GENES = [
  'density',
  'tension',
  'kick_fill',
  'hat_fill',
  'markov_temp',
  'brightness',
  'bass_activity',
  'harmonic_rate',
  'register',
  'stab_color',
  'note_length',
  'bass_style',
  'recall',
  'arc_depth',
  'wander',
  'swing',
  'dropout',
  'color',
  'freeze_punct',
];

// The anchors are led_room project data (the mood plane belongs to the
// incubating generative-music project, not Pain Material — ruling
// 2026-06-12; projects/led_room/PROJECT.md). The plugin CODE stays a
// platform asset; only the binding + data live with the project. A
// per-project data path rides the multi-project-bridge backlog item;
// until then this constant points at the one project that binds it.
const MOODS_PATH = path.resolve(
  __dirname, '..', '..', '..', 'projects', 'led_room', 'manifest', 'moods.json',
);

const EMIT_EPS = 1e-6;

const manifest = {
  asset: 'mood_expander',
  version: 1,
  kind: 'GENERATOR',
  humanLabel: 'Mood → genome expansion (PROCMUSIC.md §5)',
  schemaVersion: 'plugin.v1',
  inputs: [
    { name: 'x', valueType: 'VALUE_TYPE_FLOAT', shape: 'SHAPE_STATE', unit: 'ratio', required: false },
    { name: 'y', valueType: 'VALUE_TYPE_FLOAT', shape: 'SHAPE_STATE', unit: 'ratio', required: false },
  ],
  params: [
    { name: 'mood_x', valueType: 'VALUE_TYPE_FLOAT', default: { number: 0.2 }, range: { min: 0, max: 1 } },
    { name: 'mood_y', valueType: 'VALUE_TYPE_FLOAT', default: { number: 0.5 }, range: { min: 0, max: 1 } },
  ],
  outputs: GENES.map((gene) => ({
    name: gene,
    valueType: 'VALUE_TYPE_FLOAT',
    shape: 'SHAPE_STATE',
    unit: 'ratio',
    required: true,
    dest: 'BUS',
    media: 'SIGNAL',
    busPath: `music.genome.${gene}`,
  })),
  memberNeeds: [],
  rateDomain: 'RATE_CONTROL',
  requiresHostTick: true,
  determinism: 'REPLAYABLE',
  stateModel: 'SNAPSHOTTABLE',
};

function loadAnchors(moodsPath) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(moodsPath, 'utf8'));
  } catch (e) {
    throw new Error(`moods file unreadable at ${moodsPath}: ${e.message}`);
  }
  if (json.schema !== 'moods.v1') throw new Error(`moods schema "${json.schema}" != "moods.v1"`);
  const anchors = json.anchors;
  if (!Array.isArray(anchors) || anchors.length === 0) throw new Error('moods.v1 needs at least one anchor');
  for (const a of anchors) {
    if (!a.name || typeof a.name !== 'string') throw new Error('anchor without a name');
    if (!Array.isArray(a.pos) || a.pos.length !== 2 || !a.pos.every(Number.isFinite)) {
      throw new Error(`anchor "${a.name}": pos must be [x, y]`);
    }
    for (const gene of GENES) {
      const v = a.genome && a.genome[gene];
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error(`anchor "${a.name}": gene "${gene}" missing or outside [0,1] — anchors must be complete (gene table moved? update moods.json)`);
      }
    }
    for (const k of Object.keys(a.genome)) {
      if (!GENES.includes(k)) throw new Error(`anchor "${a.name}": unknown gene "${k}"`);
    }
  }
  return anchors;
}

// Inverse-distance² blend at (x, y). Exported for the unit tests — this IS
// the mood layer's math; the host audition rig mirrors it in Rust.
function expand(anchors, x, y) {
  const weights = anchors.map((a) => {
    const dx = x - a.pos[0];
    const dy = y - a.pos[1];
    return 1 / (dx * dx + dy * dy + 1e-6);
  });
  const total = weights.reduce((s, w) => s + w, 0);
  const genome = {};
  for (const gene of GENES) {
    let v = 0;
    for (let i = 0; i < anchors.length; i++) v += (weights[i] / total) * anchors[i].genome[gene];
    genome[gene] = Math.min(1, Math.max(0, v));
  }
  return genome;
}

function create({ params }) {
  const anchors = loadAnchors(MOODS_PATH); // throws loud -> binding load failure
  let last = {}; // gene -> last emitted value (the emit-on-change cache)

  return {
    tick({ state, emit }) {
      const x = typeof state('x') === 'number' ? state('x') : params.mood_x;
      const y = typeof state('y') === 'number' ? state('y') : params.mood_y;
      const genome = expand(anchors, x, y);
      for (const gene of GENES) {
        const v = genome[gene];
        if (last[gene] === undefined || Math.abs(v - last[gene]) > EMIT_EPS) {
          emit(gene, v);
          last[gene] = v;
        }
      }
    },
    snapshot() { return { last: { ...last } }; },
    restore(s) { last = (s && s.last) ? { ...s.last } : {}; },
  };
}

module.exports = { manifest, create, expand, loadAnchors, GENES, MOODS_PATH };
