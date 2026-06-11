// Phase-4B op evaluators (tools/sim: Const/Normalize/Curve/Scale/Combine),
// the MIDI transport adapter model, and the legacy endpoint-guard mirror.
// The 63-min golden gate runs via tools/sim/validate-tape.js; these keep each
// op honest in isolation.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { compileGraph } = require('../../tools/sim/graph');
const { GraphEngine } = require('../../tools/sim/engine');
const { OrreryBus } = require('../src/bus');
const { midiAdapterModel, conditionEndpoints } = require('../../tools/sim/validate-tape');

const ROLES = new Map([['r', { name: 'r', canPublish: ['*'], cannotPublish: [], maxPriority: 500 }]]);
const SRC = 'spiffe://test/graph';

// Compile a graph, feed it packets, return every value the graph published.
function run(nodes, feeds) {
  const compiled = compileGraph({ schema: 'router.v1', nodes }, { roles: ROLES });
  assert.ok(compiled.ok, compiled.errors.join('; '));
  const bus = new OrreryBus({ bootEpochFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-')), 'epoch') });
  bus.stop();
  const out = [];
  bus.on('packet', (rec) => {
    if (rec.accepted && rec.pkt.state && rec.pkt.source.sourceId === SRC) {
      out.push({ path: rec.pkt.state.path, value: require('../src/bus').fromValue(rec.pkt.state.value) });
    }
  });
  const engine = new GraphEngine({ compiled, bus, sourceId: SRC });
  engine.start();
  for (const [p, v] of feeds) bus.publishState(p, v, { sourceId: 'spiffe://test/pump', priority: 300 });
  engine.stop();
  return { out, engine };
}

const IN = (id, p) => ({ id, rateDomain: 'RATE_CONTROL', input: { path: p } });
const OUT = (id, input) => ({ id, rateDomain: 'RATE_CONTROL', output: { input, target: 'fx.test.out', shape: 'STATE', priority: 100, authorityRole: 'r' } });

test('normalize: live endpoints, clamp, invert (the nearness ramp)', () => {
  const nodes = [IN('d', 's.d'), IN('lo', 's.lo'), IN('hi', 's.hi'),
    { id: 'n', rateDomain: 'RATE_CONTROL', normalize: { input: 'd', lo: 'lo', hi: 'hi', invert: true } },
    OUT('o', 'n')];
  // No output until every operand has arrived.
  const a = run(nodes, [['s.d', 100]]);
  assert.deepStrictEqual(a.out, []);
  const { out } = run(nodes, [['s.lo', 75], ['s.hi', 130], ['s.d', 102.5], ['s.d', 130], ['s.d', 200], ['s.d', 75], ['s.d', 0]]);
  // d=102.5 -> (102.5-75)/55 = 0.5 -> invert 0.5; d>=hi -> 0; clamped beyond -> 0; d<=lo -> 1.
  assert.deepStrictEqual(out.map((o) => o.value), [0.5, 0, 0, 1, 1]);
});

test('normalize: degenerate span steps at lo, never NaN (rule 13)', () => {
  const nodes = [IN('d', 's.d'), IN('lo', 's.lo'), IN('hi', 's.hi'),
    { id: 'n', rateDomain: 'RATE_CONTROL', normalize: { input: 'd', lo: 'lo', hi: 'hi' } },
    OUT('o', 'n')];
  const { out } = run(nodes, [['s.lo', 20], ['s.hi', 20], ['s.d', 19.9], ['s.d', 20], ['s.d', 25]]);
  assert.deepStrictEqual(out.map((o) => o.value), [0, 1, 1]);
});

test('curve: kinds, clamp, reversed range, LUT', () => {
  const mk = (curve) => [IN('x', 's.x'), { id: 'c', rateDomain: 'RATE_CONTROL', curve }, OUT('o', 'c')];
  const lin = run(mk({ input: 'x', kind: 'LINEAR', inMin: 0, inMax: 10, outMin: 0, outMax: 1, clamp: true }), [['s.x', 5], ['s.x', 15]]);
  assert.deepStrictEqual(lin.out.map((o) => o.value), [0.5, 1]);
  const quad = run(mk({ input: 'x', kind: 'EASE_IN_QUAD', inMin: 0, inMax: 10, outMin: 0, outMax: 1, clamp: true }), [['s.x', 5]]);
  assert.deepStrictEqual(quad.out.map((o) => o.value), [0.25]);
  // The legacy twist shape: reversed input range (75 -> far, 10 -> near).
  const rev = run(mk({ input: 'x', kind: 'LINEAR', inMin: 75, inMax: 10, outMin: 0, outMax: 1, clamp: true }), [['s.x', 75], ['s.x', 10], ['s.x', 42.5]]);
  assert.deepStrictEqual(rev.out.map((o) => o.value), [0, 1, 0.5]);
  const lut = run(mk({ input: 'x', kind: 'LUT', lut: [0, 1, 0], inMin: 0, inMax: 4, outMin: 0, outMax: 2, clamp: true }), [['s.x', 1], ['s.x', 2], ['s.x', 3]]);
  assert.deepStrictEqual(lut.out.map((o) => o.value), [1, 2, 1]);
});

test('scale and const-fed combine (the directorial clamp shape)', () => {
  const { out } = run([
    IN('x', 's.x'),
    { id: 'g', rateDomain: 'RATE_CONTROL', scale: { input: 'x', mul: 2, add: 1 } },
    { id: 'ceil', rateDomain: 'RATE_CONTROL', const: { value: { number: 0.5 } } },
    { id: 'mul', rateDomain: 'RATE_CONTROL', combine: { inputs: ['g', 'ceil'], mode: 'MUL' } },
    OUT('o', 'mul'),
  ], [['s.x', 2]]);
  assert.deepStrictEqual(out.map((o) => o.value), [2.5]); // (2*2+1) * 0.5
});

test('combine modes', () => {
  const mk = (mode, weights) => [IN('a', 's.a'), IN('b', 's.b'),
    { id: 'c', rateDomain: 'RATE_CONTROL', combine: { inputs: ['a', 'b'], mode, weights } },
    OUT('o', 'c')];
  const feeds = [['s.a', 4], ['s.b', 6]];
  assert.deepStrictEqual(run(mk('SUM'), feeds).out.pop().value, 10);
  assert.deepStrictEqual(run(mk('MIN'), feeds).out.pop().value, 4);
  assert.deepStrictEqual(run(mk('MAX'), feeds).out.pop().value, 6);
  assert.deepStrictEqual(run(mk('AVG'), feeds).out.pop().value, 5);
  assert.deepStrictEqual(run(mk('WEIGHTED', [0.25, 0.5]), feeds).out.pop().value, 4);
});

test('rule 13: non-finite ingress is quarantined, previous value holds', () => {
  const nodes = [IN('x', 's.x'), { id: 's2', rateDomain: 'RATE_CONTROL', scale: { input: 'x', mul: 1, add: 0 } }, OUT('o', 's2')];
  const { out, engine } = run(nodes, [['s.x', 1], ['s.x', NaN], ['s.x', 2]]);
  assert.deepStrictEqual(out.map((o) => o.value), [1, 2]);
  assert.strictEqual(engine.nonfiniteDropped, 1);
});

test('4B compile rejections', () => {
  const cases = [
    [[{ id: 'c', rateDomain: 'RATE_CONTROL', combine: { inputs: [], mode: 'SUM' } }, OUT('o', 'c')], /needs >= 1 input/],
    [[IN('a', 's.a'), { id: 'c', rateDomain: 'RATE_CONTROL', combine: { inputs: ['a'], mode: 'WEIGHTED', weights: [] } }, OUT('o', 'c')], /one finite weight per input/],
    [[IN('a', 's.a'), { id: 'c', rateDomain: 'RATE_CONTROL', curve: { input: 'a', kind: 'LUT', lut: [1], inMin: 0, inMax: 1, outMin: 0, outMax: 1 } }, OUT('o', 'c')], /LUT needs/],
    [[IN('a', 's.a'), { id: 'n', rateDomain: 'RATE_CONTROL', normalize: { input: 'a', lo: '', hi: 'a' } }, OUT('o', 'n')], /missing lo/],
    [[{ id: 'k', rateDomain: 'RATE_CONTROL', const: {} }, OUT('o', 'k')], /populated common.v1.Value/],
  ];
  for (const [nodes, re] of cases) {
    const c = compileGraph({ schema: 'router.v1', nodes }, { roles: ROLES });
    assert.ok(!c.ok && c.errors.some((e) => re.test(e)), `expected /${re.source}/, got: ${c.errors.join(' | ')}`);
  }
});

test('midi adapter model: round/clamp, on-change dedupe, 33 ms cap without state update', () => {
  const ev = midiAdapterModel([
    { t: 0, value: 0 },        // -> 0, written
    { t: 10, value: 0.004 },   // -> 1, but inside 33 ms window: skipped, state NOT updated
    { t: 40, value: 0.004 },   // -> 1, written (state was still 0)
    { t: 80, value: 0.0041 },  // -> 1, deduped
    { t: 120, value: 2 },      // -> clamp 127
    { t: 160, value: -1 },     // -> clamp 0
  ]);
  assert.deepStrictEqual(ev, [
    { t_mono_ms: 0, v: 0 }, { t_mono_ms: 40, v: 1 }, { t_mono_ms: 120, v: 127 }, { t_mono_ms: 160, v: 0 },
  ]);
});

test('endpoint guard mirror: invalid claims drop, effective values evolve', () => {
  const cond = conditionEndpoints({ near: 75, far: 130 });
  const kept = cond([
    { t: 1, name: 'distance_far_cm', value: 50 },    // 50 <= near 75: DROP (the golden's real case)
    { t: 2, name: 'distance_near_cm', value: -5 },   // negative: DROP
    { t: 3, name: 'distance_far_cm', value: 400 },   // valid: far -> 400
    { t: 4, name: 'distance_near_cm', value: 200 },  // valid now (far is 400): near -> 200
    { t: 5, name: 'distance_far_cm', value: 150 },   // 150 <= near 200: DROP
    { t: 6, name: 'distance_cm', value: 99 },        // passthrough
  ]);
  assert.deepStrictEqual(kept.map((e) => e.t), [3, 4, 6]);
  assert.strictEqual(cond.dropped.length, 3);
  assert.deepStrictEqual(cond.dropped[0].effective, { near: 75, far: 130 });
});
