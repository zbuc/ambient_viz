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

const { compileGraph } = require('../src/router-graph');
const { GraphEngine } = require('../src/router-engine');
const { OrreryBus } = require('../src/bus');
const { midiAdapterModel } = require('../../tools/sim/validate-tape');
const attachBusAdapter = require('../src/bus-adapter');
const { EventEmitter } = require('events');

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

test('engine tap fires per accepted publish (the bus_tx capture hook)', () => {
  const compiled = compileGraph({
    schema: 'router.v1',
    nodes: [IN('x', 's.x'), OUT('o', 'x')],
  }, { roles: ROLES });
  const bus = new OrreryBus({ bootEpochFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tap-')), 'epoch') });
  bus.stop();
  const taps = [];
  const engine = new GraphEngine({ compiled, bus, sourceId: SRC, tap: (t, v) => taps.push([t, v]) });
  engine.start();
  bus.publishState('s.x', 1, { sourceId: 'spiffe://test/pump', priority: 300 });
  bus.publishState('s.x', 2, { sourceId: 'spiffe://test/pump', priority: 300 });
  engine.stop();
  assert.deepStrictEqual(taps, [['fx.test.out', 1], ['fx.test.out', 2]]);
});

test('engine reads the arbitrated RESOLVED value, not the packet payload', () => {
  const compiled = compileGraph({
    schema: 'router.v1',
    nodes: [IN('x', 's.x'), OUT('o', 'x')],
  }, { roles: ROLES });
  const bus = new OrreryBus({ bootEpochFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'res-')), 'epoch') });
  bus.stop();
  const out = [];
  const engine = new GraphEngine({ compiled, bus, sourceId: SRC, tap: (t, v) => out.push(v) });
  engine.start();
  bus.publishState('s.x', 170, { sourceId: 'spiffe://test/sensor', priority: 300 });
  // A low-priority keepalive must NOT drag the graph back to the shadowed value.
  bus.publishState('s.x', 130, { sourceId: 'spiffe://test/defaults', priority: 100 });
  engine.stop();
  assert.deepStrictEqual(out, [170, 170]);
});

test('4C ingest-boundary conditioning: defaults writer + invalid claims never reach the bus', () => {
  const bus = new OrreryBus({ bootEpochFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cond-')), 'epoch') });
  bus.stop();
  const inputBus = new EventEmitter();
  const adapter = attachBusAdapter({ bus, inputBus });

  // The standing defaults writer is on the bus at attach, at the idle rung.
  const farPath = 'sensor.door.far_cm';
  const nearPath = 'sensor.door.near_cm';
  assert.strictEqual(bus.paths.get(farPath).resolved.value, 130);
  assert.strictEqual(bus.paths.get(nearPath).resolved.value, 75);
  assert.strictEqual(bus.paths.get(farPath).resolved.sourceId, attachBusAdapter.DEFAULTS.DEFAULTS_SOURCE);

  // The goldens' real cases: far=50 then far=75(==near) — refused, bus holds defaults.
  inputBus.emit('change', { name: 'distance_far_cm', value: 50 });
  inputBus.emit('change', { name: 'distance_far_cm', value: 75 });
  inputBus.emit('change', { name: 'distance_near_cm', value: -5 });
  assert.strictEqual(bus.paths.get(farPath).resolved.value, 130);
  assert.strictEqual(adapter.conditioning.rejects.length, 3);

  // A valid claim out-arbitrates the defaults (sensor 300 > idle 100)...
  inputBus.emit('change', { name: 'distance_far_cm', value: 170 });
  assert.strictEqual(bus.paths.get(farPath).resolved.value, 170);
  assert.deepStrictEqual(adapter.conditioning.effective(), { near: 75, far: 170 });
  // ...and the guards track the EFFECTIVE values: near must stay under 170.
  inputBus.emit('change', { name: 'distance_near_cm', value: 200 });
  assert.strictEqual(adapter.conditioning.rejects.length, 4);
  inputBus.emit('change', { name: 'distance_near_cm', value: 100 });
  assert.strictEqual(bus.paths.get(nearPath).resolved.value, 100);

  adapter.stop(); bus.stop();
});

// ── phase 5: Smooth (ONE_POLE) — timestamp-driven in RATE_CONTROL ───────────

const { loadGraphDir } = require('../src/router-graph');

// run() with a controllable engine clock: feeds are [path, value, tMs] and
// the bus's injected nowMono (the one clock the engine reads) follows them.
function runClocked(nodes, feeds) {
  const compiled = compileGraph({ schema: 'router.v1', nodes }, { roles: ROLES });
  assert.ok(compiled.ok, compiled.errors.join('; '));
  const clock = { t: 0 };
  const bus = new OrreryBus({
    nowMono: () => clock.t,
    bootEpochFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smooth-')), 'epoch'),
  });
  bus.stop();
  const out = [];
  bus.on('packet', (rec) => {
    if (rec.accepted && rec.pkt.state && rec.pkt.source.sourceId === SRC) {
      out.push(require('../src/bus').fromValue(rec.pkt.state.value));
    }
  });
  const engine = new GraphEngine({ compiled, bus, sourceId: SRC });
  engine.start();
  for (const [p, v, t] of feeds) {
    clock.t = t;
    bus.publishState(p, v, { sourceId: 'spiffe://test/pump', priority: 300 });
  }
  engine.stop();
  return out;
}

const SMOOTH = (id, input, tau) => ({ id, rateDomain: 'RATE_CONTROL', smooth: { input, kind: 'ONE_POLE', timeConstantMs: tau } });

test('smooth: seeds on first sample, then dt-aware one-pole steps', () => {
  const nodes = [IN('d', 's.d'), SMOOTH('sm', 'd', 250), OUT('o', 'sm')];
  const out = runClocked(nodes, [['s.d', 100, 0], ['s.d', 200, 100], ['s.d', 200, 200]]);
  const a = 1 - Math.exp(-100 / 250);
  const y1 = 100 + (200 - 100) * a;
  const y2 = y1 + (200 - y1) * a;
  assert.strictEqual(out[0], 100); // seed, no step up from a phantom zero
  assert.ok(Math.abs(out[1] - y1) < 1e-12, `${out[1]} != ${y1}`);
  assert.ok(Math.abs(out[2] - y2) < 1e-12, `${out[2]} != ${y2}`);
});

test('smooth: two steps toward a held target compose exactly like one (exp additivity)', () => {
  const nodes = [IN('d', 's.d'), SMOOTH('sm', 'd', 250), OUT('o', 'sm')];
  const twoSteps = runClocked(nodes, [['s.d', 0, 0], ['s.d', 100, 50], ['s.d', 100, 100]]);
  const oneStep = runClocked(nodes, [['s.d', 0, 0], ['s.d', 100, 100]]);
  // Stepping 0->100 at t=50 then holding to t=100 must land exactly where a
  // single 100 ms step lands — divergence from the per-frame browser EMA
  // comes only from VALUE changes mid-interval, never from step partitioning.
  assert.ok(Math.abs(twoSteps[2] - oneStep[1]) < 1e-12, `${twoSteps[2]} != ${oneStep[1]}`);
});

test('smooth: dt clamps at 500 ms (a stale gap is one bounded step, not a snap)', () => {
  const nodes = [IN('d', 's.d'), SMOOTH('sm', 'd', 250), OUT('o', 'sm')];
  const out = runClocked(nodes, [['s.d', 0, 0], ['s.d', 100, 10000]]);
  const expected = 100 * (1 - Math.exp(-500 / 250)); // dt 10 s -> clamped 500 ms
  assert.ok(Math.abs(out[1] - expected) < 1e-12, `${out[1]} != ${expected}`);
});

test('smooth: a same-millisecond burst is a no-op step, not the legacy snap', () => {
  const nodes = [IN('d', 's.d'), SMOOTH('sm', 'd', 250), OUT('o', 'sm')];
  const out = runClocked(nodes, [['s.d', 0, 0], ['s.d', 50, 100], ['s.d', 100, 100]]);
  // The dt=0 packet updates the input store but must not teleport the filter.
  assert.strictEqual(out[2], out[1]);
});

test('smooth: rule-13 ingress quarantine holds filter memory across a poisoned sample', () => {
  const nodes = [IN('d', 's.d'), SMOOTH('sm', 'd', 250), OUT('o', 'sm')];
  const out = runClocked(nodes, [['s.d', 100, 0], ['s.d', NaN, 100], ['s.d', 100, 200]]);
  // NaN never enters the graph (engine ingress drops it); the next good
  // sample steps from intact memory toward an unchanged target.
  assert.strictEqual(out[0], 100);
  assert.strictEqual(out[out.length - 1], 100);
  assert.ok(out.every(Number.isFinite));
});

test('smooth: compile gates — ONE_POLE only, real time constant required', () => {
  const bad1 = compileGraph({ schema: 'router.v1', nodes: [IN('d', 's.d'),
    { id: 'sm', rateDomain: 'RATE_CONTROL', smooth: { input: 'd', kind: 'SLEW', slewPerS: 10 } }, OUT('o', 'sm')] }, { roles: ROLES });
  assert.ok(!bad1.ok && bad1.errors.some((e) => e.includes('only ONE_POLE')));
  const bad2 = compileGraph({ schema: 'router.v1', nodes: [IN('d', 's.d'),
    { id: 'sm', rateDomain: 'RATE_CONTROL', smooth: { input: 'd', kind: 'ONE_POLE' } }, OUT('o', 'sm')] }, { roles: ROLES });
  assert.ok(!bad2.ok && bad2.errors.some((e) => e.includes('time_constant_ms')));
});

// ── phase 5: the viz-twist graph end-to-end + the per-mapping graph dir ─────

const MANIFEST_DIR = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest');

test('viz-twist graph: legacy reversed quadratic ramp, live endpoints, smoothed', () => {
  const graphJson = JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, 'graphs', 'viz-twist.json'), 'utf8'));
  const compiled = compileGraph(graphJson, {
    roles: new Map([['router', { name: 'router', canPublish: ['fx.*'], cannotPublish: [], maxPriority: 300 }]]),
  });
  assert.ok(compiled.ok, compiled.errors.join('; '));

  const clock = { t: 0 };
  const bus = new OrreryBus({ nowMono: () => clock.t, bootEpochFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'twist-')), 'epoch') });
  bus.stop();
  const out = [];
  bus.on('packet', (rec) => {
    if (rec.accepted && rec.pkt.state && rec.pkt.state.path === 'fx.viz.twist_gain') {
      out.push(require('../src/bus').fromValue(rec.pkt.state.value));
    }
  });
  const engine = new GraphEngine({ compiled, bus, sourceId: SRC });
  engine.start();
  const feed = (name, v, t) => { clock.t = t; bus.publishState(name, v, { sourceId: 'spiffe://test/pump', priority: 300 }); };
  feed('sensor.door.near_cm', 75, 0);
  feed('sensor.door.far_cm', 170, 0);
  feed('sensor.door.distance_cm', 122.5, 0);   // seed: exactly mid-span
  feed('sensor.door.distance_cm', 122.5, 1000); // converged (held target)
  feed('sensor.door.distance_cm', 75, 2000);    // long gap -> clamped step toward near
  // Legacy formula: x=(d-near)/(far-near); gain=(1-x)^2. Mid-span -> 0.25.
  assert.ok(Math.abs(out[0] - 0.25) < 1e-12, `seed gain ${out[0]} != 0.25`);
  assert.ok(Math.abs(out[1] - 0.25) < 1e-12, 'held target must not drift');
  // d=75 after a clamped 500 ms step: smoothed = 122.5 + (75-122.5)*(1-e^-2)
  const sm = 122.5 + (75 - 122.5) * (1 - Math.exp(-500 / 250));
  const x = (sm - 75) / 95;
  const expected = (1 - x) * (1 - x);
  assert.ok(Math.abs(out[2] - expected) < 1e-12, `${out[2]} != ${expected}`);
  engine.stop();
});

test('loadGraphDir: every project graph compiles; one broken file degrades alone', () => {
  const declaredPaths = new Set([
    'sensor.door.distance_cm', 'sensor.door.near_cm', 'sensor.door.far_cm',
    'fx.tape.failure', 'fx.viz.twist_gain', 'fx.viz.bitmap_x',
  ]);
  const roles = new Map([['router', { name: 'router', canPublish: ['fx.*'], cannotPublish: [], maxPriority: 300 }]]);
  const real = loadGraphDir(path.join(MANIFEST_DIR, 'graphs'), { declaredPaths, roles });
  assert.deepStrictEqual(real.failures, []);
  assert.deepStrictEqual(real.graphs.map((g) => g.file), ['tape-failure.json', 'viz-bitmap.json', 'viz-twist.json']);
  for (const g of real.graphs) assert.deepStrictEqual(g.compiled.warnings, []);

  // A directory where one graph is broken: the rest still compile.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphdir-'));
  fs.copyFileSync(path.join(MANIFEST_DIR, 'graphs', 'viz-twist.json'), path.join(dir, 'b-good.json'));
  fs.writeFileSync(path.join(dir, 'a-broken.json'), '{"schema":"router.v1","nodes":[{"id":"x","rateDomain":"RATE_CONTROL","delay":{"input":"x","frames":1}}]}');
  const mixed = loadGraphDir(dir, { roles });
  assert.strictEqual(mixed.failures.length, 1);
  assert.strictEqual(mixed.failures[0].file, 'a-broken.json');
  assert.deepStrictEqual(mixed.graphs.map((g) => g.file), ['b-good.json']);
});

test('viz-bitmap graph: reversed LINEAR nearness x, live endpoints, smoothed', () => {
  const graphJson = JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, 'graphs', 'viz-bitmap.json'), 'utf8'));
  const compiled = compileGraph(graphJson, {
    roles: new Map([['router', { name: 'router', canPublish: ['fx.*'], cannotPublish: [], maxPriority: 300 }]]),
  });
  assert.ok(compiled.ok, compiled.errors.join('; '));

  const clock = { t: 0 };
  const bus = new OrreryBus({ nowMono: () => clock.t, bootEpochFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bmx-')), 'epoch') });
  bus.stop();
  const out = [];
  bus.on('packet', (rec) => {
    if (rec.accepted && rec.pkt.state && rec.pkt.state.path === 'fx.viz.bitmap_x') {
      out.push(require('../src/bus').fromValue(rec.pkt.state.value));
    }
  });
  const engine = new GraphEngine({ compiled, bus, sourceId: SRC });
  engine.start();
  const feed = (name, v, t) => { clock.t = t; bus.publishState(name, v, { sourceId: 'spiffe://test/pump', priority: 300 }); };
  feed('sensor.door.near_cm', 75, 0);
  feed('sensor.door.far_cm', 170, 0);
  feed('sensor.door.distance_cm', 122.5, 0); // seed: exactly mid-span
  // Legacy formula: x = 1 - (d-near)/(far-near). Mid-span -> 0.5 — LINEAR,
  // unlike the twist gain's quadratic 0.25 from the same inputs.
  assert.ok(Math.abs(out[0] - 0.5) < 1e-12, `seed x ${out[0]} != 0.5`);
  feed('sensor.door.distance_cm', 75, 1000); // long hold then step toward near
  const sm = 122.5 + (75 - 122.5) * (1 - Math.exp(-500 / 250)); // dt clamped at 500 ms
  const expected = 1 - (sm - 75) / 95;
  assert.ok(Math.abs(out[1] - expected) < 1e-12, `${out[1]} != ${expected}`);
  engine.stop();
});
