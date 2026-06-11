// mood_expander.v1 (PROCMUSIC.md §5): the expansion math, the production
// anchors file, and the plugin's host-contract conduct (emit-on-change,
// snapshot/restore, untouched PRNG under replay).
// Run: cd server && node --test

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { OrreryBus } = require('../src/bus');
const { createPluginHost } = require('../src/plugin-host');
const { expand, loadAnchors, GENES, MOODS_PATH, manifest } = require('../src/plugins/mood-expander');

function makeBus() {
  let now = 0;
  const bus = new OrreryBus({
    nowMono: () => now,
    bootEpochFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-test-')), 'epoch'),
  });
  bus.stop();
  bus.advance = (ms) => { now += ms; };
  return bus;
}

const ROLES = new Map([
  ['plugin_host', { name: 'plugin_host', canPublish: ['seq.*', 'music.genome.*'], cannotPublish: ['fx.*'], maxPriority: 300 }],
]);

const MOOD = (over = {}) => ({
  instance: 'mood',
  seed: 2,
  authorityRole: 'plugin_host',
  priority: 300,
  binding: { asset: 'mood_expander.v1', inputs: {}, params: { mood_x: 0.2, mood_y: 0.5 } },
  ...over,
});

function makeHost(bus, bindings, opts = {}) {
  return createPluginHost({
    bus,
    bindings: bindings.map((json, i) => ({ file: `b${i}.json`, json })),
    roles: ROLES,
    scheduleRepeating: () => () => {},
    ...opts,
  });
}

// ── the anchors file is the contract's data half ────────────────────────────

test('production moods.json loads, is complete, and covers every gene', () => {
  const anchors = loadAnchors(MOODS_PATH);
  assert.ok(anchors.length >= 2, 'at least ambient + techno');
  assert.ok(anchors.some((a) => a.name === 'ambient'));
  assert.ok(anchors.some((a) => a.name === 'techno'));
  // GENES tracks dsp::procgen::Genome — output ports must match 1:1.
  assert.deepStrictEqual(manifest.outputs.map((o) => o.name), GENES);
});

test('incomplete or out-of-range anchors are a loud load error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moods-test-'));
  const write = (obj) => {
    const p = path.join(dir, 'moods.json');
    fs.writeFileSync(p, JSON.stringify(obj));
    return p;
  };
  const full = Object.fromEntries(GENES.map((g) => [g, 0.5]));
  const base = { schema: 'moods.v1', anchors: [{ name: 'a', pos: [0, 0], genome: full }] };

  assert.throws(() => loadAnchors(write({ ...base, schema: 'nope' })), /moods.v1/);
  assert.throws(() => loadAnchors(write({ schema: 'moods.v1', anchors: [] })), /at least one/);
  const missing = { ...base, anchors: [{ name: 'a', pos: [0, 0], genome: { ...full, density: undefined } }] };
  assert.throws(() => loadAnchors(write(missing)), /missing or outside/);
  const oob = { ...base, anchors: [{ name: 'a', pos: [0, 0], genome: { ...full, tension: 1.5 } }] };
  assert.throws(() => loadAnchors(write(oob)), /missing or outside/);
  const unknown = { ...base, anchors: [{ name: 'a', pos: [0, 0], genome: { ...full, bogus: 0.5 } }] };
  assert.throws(() => loadAnchors(write(unknown)), /unknown gene/);
});

// ── the expansion math ──────────────────────────────────────────────────────

test('expansion is anchor-exact at anchors and a continuous blend between', () => {
  const anchors = loadAnchors(MOODS_PATH);
  const ambient = anchors.find((a) => a.name === 'ambient');
  const techno = anchors.find((a) => a.name === 'techno');

  // On an anchor, that anchor dominates (within the epsilon regularizer).
  const atAmbient = expand(anchors, ambient.pos[0], ambient.pos[1]);
  for (const gene of GENES) {
    assert.ok(Math.abs(atAmbient[gene] - ambient.genome[gene]) < 1e-3,
      `${gene} at ambient anchor: ${atAmbient[gene]} != ${ambient.genome[gene]}`);
  }

  // Midpoint between two equidistant anchors = the mean of their genes.
  const mid = expand([ambient, techno], (ambient.pos[0] + techno.pos[0]) / 2, (ambient.pos[1] + techno.pos[1]) / 2);
  for (const gene of GENES) {
    const mean = (ambient.genome[gene] + techno.genome[gene]) / 2;
    assert.ok(Math.abs(mid[gene] - mean) < 1e-6, `${gene} midpoint ${mid[gene]} != mean ${mean}`);
  }

  // Continuity: a small move changes no gene by a jump.
  const a = expand(anchors, 0.5, 0.5);
  const b = expand(anchors, 0.51, 0.5);
  for (const gene of GENES) {
    assert.ok(Math.abs(a[gene] - b[gene]) < 0.1, `${gene} jumped on a small move`);
  }
});

// ── host conduct ────────────────────────────────────────────────────────────

test('instance boots, publishes the full genome once, then stays quiet (emit-on-change)', () => {
  const bus = makeBus();
  const taps = [];
  const host = makeHost(bus, [MOOD()], { tap: (inst, p, v) => taps.push([p, v]) });
  assert.deepStrictEqual(host.failures, []);

  bus.advance(250); host.tickOnce();
  assert.strictEqual(taps.length, GENES.length, 'first tick emits every gene');
  assert.ok(taps.every(([p]) => p.startsWith('music.genome.')));

  const after = taps.length;
  for (let i = 0; i < 8; i++) { bus.advance(250); host.tickOnce(); }
  assert.strictEqual(taps.length, after, 'static mood -> no further emissions');

  // The published STATE is readable as the arbitrated resolved value.
  const entry = bus.paths.get('music.genome.density');
  assert.ok(entry && entry.resolved && typeof entry.resolved.value === 'number');
});

test('bound mood inputs override the static params', () => {
  const bus = makeBus();
  const taps = [];
  const host = makeHost(
    bus,
    [MOOD({ binding: { asset: 'mood_expander.v1', inputs: { x: 'music.mood.x', y: 'music.mood.y' }, params: {} } })],
    { tap: (inst, p, v) => taps.push([p, v]) },
  );
  assert.deepStrictEqual(host.failures, []);

  bus.advance(250); host.tickOnce(); // params default position
  const firstDensity = taps.find(([p]) => p === 'music.genome.density')[1];

  // Drive the mood to the techno anchor; the expansion must follow.
  bus.publishState('music.mood.x', 0.85, { sourceId: 'test', priority: 300 });
  bus.publishState('music.mood.y', 0.5, { sourceId: 'test', priority: 300 });
  taps.length = 0;
  bus.advance(250); host.tickOnce();
  const movedDensity = taps.find(([p]) => p === 'music.genome.density')[1];
  assert.ok(movedDensity > firstDensity, `density should rise toward techno (${firstDensity} -> ${movedDensity})`);
});

test('snapshot/restore carries the dedupe cache so a resumed instance does not re-emit', () => {
  const bus = makeBus();
  const taps = [];
  const host = makeHost(bus, [MOOD()], { tap: (inst, p, v) => taps.push([p, v]) });
  bus.advance(250); host.tickOnce();
  const snap = host.snapshotInstance('mood');
  assert.strictEqual(Object.keys(snap.plugin_state.last).length, GENES.length);

  // Fresh host (same bindings), restore, tick: nothing re-emits.
  const taps2 = [];
  const host2 = makeHost(bus, [MOOD()], { tap: (inst, p, v) => taps2.push([p, v]) });
  host2.restoreInstance('mood', snap);
  bus.advance(250); host2.tickOnce();
  assert.strictEqual(taps2.length, 0, 'restored dedupe cache suppresses identical re-emissions');
});

test('the expander never draws from the PRNG (replay posture)', () => {
  const bus = makeBus();
  const host = makeHost(bus, [MOOD()]);
  const before = host.instances[0].prng.state();
  for (let i = 0; i < 5; i++) { bus.advance(250); host.tickOnce(); }
  assert.strictEqual(host.instances[0].prng.state(), before);
});
