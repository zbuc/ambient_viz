// Phase-6.0 plugin host (plugin-host.js): the five proofs the toy plugin
// exists to give — host tick, seeded PRNG, snapshot/restore, replay
// determinism, candidate-path inspection — plus the contract enforcement
// the host mirrors from PLUGIN_CONTRACT.md "Compiler validation".
// Run: cd server && node --test

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { OrreryBus } = require('../src/bus');
const { createPluginHost, builtinAssets, validateBinding, mulberry32 } = require('../src/plugin-host');

function makeBus() {
  let now = 0;
  const bus = new OrreryBus({
    nowMono: () => now,
    bootEpochFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-test-')), 'epoch'),
  });
  bus.stop(); // no wall-clock _meta in tests
  bus.advance = (ms) => { now += ms; };
  return bus;
}

const TOY = (over = {}) => ({
  instance: 'toy',
  seed: 12345,
  authorityRole: 'plugin_host',
  priority: 300,
  binding: { asset: 'toy_timer.v1', inputs: {}, params: { min_interval_s: 1, max_interval_s: 2, skip_prob: 0.25 } },
  ...over,
});

const ROLES = new Map([
  ['plugin_host', { name: 'plugin_host', canPublish: ['seq.*'], cannotPublish: ['fx.*'], maxPriority: 300 }],
]);

// Host under a manual clock: no scheduler — tests drive tickOnce() and
// advance the bus clock explicitly (the same injection seam the sim uses).
function makeHost(bus, bindings, opts = {}) {
  return createPluginHost({
    bus,
    bindings: bindings.map((json, i) => ({ file: `b${i}.json`, json })),
    roles: ROLES,
    scheduleRepeating: () => () => {}, // ticks are driven by hand
    ...opts,
  });
}

// Drive n ticks at a fixed cadence, collecting taps.
function run(bus, host, n, stepMs = 250) {
  for (let i = 0; i < n; i++) {
    bus.advance(stepMs);
    host.tickOnce();
  }
}

// ── binding validation (the contract is enforced) ───────────────────────────

test('unknown asset, bad seed, unknown/out-of-range params, undeclared port inputs all reject', () => {
  const assets = builtinAssets();
  const cases = [
    [TOY({ binding: { asset: 'nope.v1', inputs: {}, params: {} } }), /not registered/],
    [TOY({ seed: -1 }), /seed must be an integer/],
    [TOY({ seed: 1.5 }), /seed must be an integer/],
    [TOY({ binding: { asset: 'toy_timer.v1', inputs: {}, params: { bogus: 1 } } }), /not declared by/],
    [TOY({ binding: { asset: 'toy_timer.v1', inputs: {}, params: { skip_prob: 2 } } }), /outside \[0, 1\]/],
    [TOY({ binding: { asset: 'toy_timer.v1', inputs: { nope: 'sensor.door.distance_cm' }, params: {} } }), /not a declared port/],
  ];
  for (const [json, re] of cases) {
    const v = validateBinding(json, { assets, roles: ROLES });
    assert.ok(v.errors.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(v.errors)}`);
  }
});

test('role authorization mirrors rule 8: priority ceiling and can_publish govern outputs', () => {
  const assets = builtinAssets();
  const over = validateBinding(TOY({ priority: 999 }), { assets, roles: ROLES });
  assert.ok(over.errors.some((e) => /exceeds role/.test(e)));
  const wrongRole = validateBinding(TOY({ authorityRole: 'nope' }), { assets, roles: ROLES });
  assert.ok(wrongRole.errors.some((e) => /not a known policy role/.test(e)));
  const narrow = new Map([['plugin_host', { name: 'plugin_host', canPublish: ['other.*'], cannotPublish: [], maxPriority: 300 }]]);
  const noGlob = validateBinding(TOY(), { assets, roles: narrow });
  assert.ok(noGlob.errors.some((e) => /not in role/.test(e)));
});

test('defaults fill unset params; a valid binding resolves them merged', () => {
  const assets = builtinAssets();
  const v = validateBinding(TOY({ binding: { asset: 'toy_timer.v1', inputs: {}, params: { min_interval_s: 3 } } }),
    { assets, roles: ROLES });
  assert.deepEqual(v.errors, []);
  assert.equal(v.resolved.params.min_interval_s, 3);
  assert.equal(v.resolved.params.max_interval_s, 5);    // manifest default
  assert.equal(v.resolved.params.skip_prob, 0.25);      // manifest default
});

// ── host tick + seeded PRNG (replay determinism) ─────────────────────────────

test('same seed + same tick timeline -> identical emissions; different seed diverges', () => {
  const emissionsFor = (seed, n = 2000) => {
    const bus = makeBus();
    const out = [];
    const host = makeHost(bus, [TOY({ seed })], { tap: (inst, p, payload) => out.push({ t: bus.nowMono(), payload }) });
    assert.deepEqual(host.failures, []);
    run(bus, host, n);
    host.stop();
    return out;
  };
  const a = emissionsFor(42);
  const b = emissionsFor(42);
  const c = emissionsFor(43);
  assert.ok(a.length > 10, `expected real traffic, got ${a.length} pulses`);
  assert.deepEqual(a, b); // byte-identical replay
  assert.notDeepEqual(a.map((e) => e.t), c.map((e) => e.t)); // the seed is load-bearing
  // payloads are the fire count — gap/repeat-free by construction
  assert.deepEqual(a.map((e) => e.payload), a.map((_, i) => i + 1));
});

test('a stalled host tick means silence, not catch-up bursts', () => {
  const bus = makeBus();
  const out = [];
  const host = makeHost(bus, [TOY()], { tap: (i, p, v) => out.push(v) });
  run(bus, host, 100);
  const before = out.length;
  bus.advance(60000); // one minute with NO ticks — the host stalled
  assert.equal(out.length, before);
  host.tickOnce(); // first tick after the stall: at most one due fire
  assert.ok(out.length <= before + 1);
  host.stop();
});

// ── snapshot/restore (replay-resume) ─────────────────────────────────────────

test('snapshot at T, restore onto a fresh instance, continue -> identical tail (PRNG state included)', () => {
  const N = 4000; const HALF = 2000;
  // Uninterrupted reference run.
  const busA = makeBus();
  const refAll = [];
  const hostA = makeHost(busA, [TOY({ seed: 7 })], { tap: (i, p, v) => refAll.push({ t: busA.nowMono(), v }) });
  run(busA, hostA, N);
  hostA.stop();

  // Run B: half, snapshot, REBUILD the host (fresh instance), restore, finish.
  const busB = makeBus();
  const tailB = [];
  let hostB = makeHost(busB, [TOY({ seed: 7 })], { tap: () => {} });
  run(busB, hostB, HALF);
  const snap = hostB.snapshotInstance('toy');
  hostB.stop();
  hostB = makeHost(busB, [TOY({ seed: 999 })], { tap: (i, p, v) => tailB.push({ t: busB.nowMono(), v }) });
  hostB.restoreInstance('toy', snap); // snapshot beats the (wrong) boot seed
  run(busB, hostB, N - HALF);
  hostB.stop();

  const refTail = refAll.filter((e) => e.t > HALF * 250);
  assert.ok(refTail.length > 5, `expected tail traffic, got ${refTail.length}`);
  assert.deepEqual(tailB, refTail);
});

test('restore refuses a snapshot from a different asset (no cross-version state promise)', () => {
  const bus = makeBus();
  const host = makeHost(bus, [TOY()]);
  const snap = host.snapshotInstance('toy');
  assert.throws(() => host.restoreInstance('toy', { ...snap, asset: 'toy_timer.v2' }), /never survives a version swap/);
  host.stop();
});

// ── candidate-path inspection + bus integration ──────────────────────────────

test('emissions are real bus packets on the declared path; the host ring drains the queue', () => {
  const bus = makeBus();
  bus.registerPath('seq.toy.pulse', { shape: 'event', type: 'int' });
  const packets = [];
  bus.on('packet', (rec) => { if (rec.accepted && rec.pkt.event) packets.push(rec.pkt.event); });
  const host = makeHost(bus, [TOY()]);
  run(bus, host, 1000);
  const view = host.inspect()[0];
  assert.ok(view.emitted > 0);
  assert.equal(packets.length, view.emitted); // every emission was an accepted EVENT packet
  assert.equal(packets[0].path, 'seq.toy.pulse');
  // ring = the candidate stream view; queue stays drained (no phantom overflow)
  assert.ok(view.recent_emits.length > 0 && view.recent_emits.length <= 20);
  assert.equal(bus.paths.get('seq.toy.pulse').queue.length, 0);
  assert.equal(bus.paths.get('seq.toy.pulse').drops, 0);
  assert.equal(view.prng_state >>> 0, view.prng_state); // capturable 32-bit PRNG state
  host.stop();
});

test('a throwing tick crashes ONLY that instance; the other keeps running', () => {
  const bus = makeBus();
  const boom = {
    manifest: {
      asset: 'boom', version: 1, kind: 'GENERATOR', humanLabel: 'throws', schemaVersion: 'plugin.v1',
      inputs: [], params: [],
      outputs: [{ name: 'out', valueType: 'VALUE_TYPE_FLOAT', shape: 'SHAPE_EVENT', unit: '', required: true, dest: 'BUS', media: 'SIGNAL', busPath: 'seq.boom.out' }],
      memberNeeds: [], rateDomain: 'RATE_CONTROL', requiresHostTick: true, determinism: 'REPLAYABLE', stateModel: 'STATELESS',
    },
    create: () => ({ tick() { throw new Error('kaboom'); }, snapshot: () => ({}), restore() {} }),
  };
  const assets = builtinAssets();
  const pluginGen = require('../src/gen/plugin');
  assets.set('boom.v1', { manifest: pluginGen.PluginManifest.fromJSON(boom.manifest), create: boom.create });
  const out = [];
  const host = makeHost(bus, [
    TOY(),
    { instance: 'bad', seed: 1, authorityRole: 'plugin_host', priority: 300, binding: { asset: 'boom.v1', inputs: {}, params: {} } },
  ], { assets, tap: (inst) => out.push(inst) });
  run(bus, host, 50);
  const [toy, bad] = host.inspect();
  assert.equal(bad.crashed && /kaboom/.test(bad.crashed.message), true);
  assert.equal(bad.ticks, 0); // never completed a tick
  assert.equal(toy.crashed, null);
  assert.equal(toy.ticks, 50); // unharmed neighbor
  host.stop();
});

test('non-finite emissions are quarantined and counted, never published (rule-13 posture)', () => {
  const bus = makeBus();
  const pluginGen = require('../src/gen/plugin');
  const nan = {
    manifest: {
      asset: 'nan', version: 1, kind: 'GENERATOR', humanLabel: 'poison', schemaVersion: 'plugin.v1',
      inputs: [], params: [],
      outputs: [{ name: 'out', valueType: 'VALUE_TYPE_FLOAT', shape: 'SHAPE_EVENT', unit: '', required: true, dest: 'BUS', media: 'SIGNAL', busPath: 'seq.nan.out' }],
      memberNeeds: [], rateDomain: 'RATE_CONTROL', requiresHostTick: true, determinism: 'REPLAYABLE', stateModel: 'STATELESS',
    },
    create: () => ({ tick({ emit }) { emit('out', NaN); }, snapshot: () => ({}), restore() {} }),
  };
  const assets = builtinAssets();
  assets.set('nan.v1', { manifest: pluginGen.PluginManifest.fromJSON(nan.manifest), create: nan.create });
  const host = makeHost(bus, [{ instance: 'p', seed: 1, authorityRole: 'plugin_host', priority: 300, binding: { asset: 'nan.v1', inputs: {}, params: {} } }], { assets });
  run(bus, host, 5);
  const view = host.inspect()[0];
  assert.equal(view.nonfinite_quarantined, 5);
  assert.equal(view.emitted, 0);
  assert.equal(view.crashed, null); // quarantine, not crash
  host.stop();
});

// ── input plumbing (the 6.1 shape, proven now) ───────────────────────────────

test('STATE inputs read the arbitrated RESOLVED value; EVENT inputs drain since last tick, never coalesced', () => {
  const bus = makeBus();
  bus.registerPath('sensor.x.level', { shape: 'state', type: 'float' });
  bus.registerPath('sensor.x.kick', { shape: 'event', type: 'int' });
  const pluginGen = require('../src/gen/plugin');
  const seen = [];
  const probe = {
    manifest: {
      asset: 'probe', version: 1, kind: 'GENERATOR', humanLabel: 'input probe', schemaVersion: 'plugin.v1',
      inputs: [
        { name: 'level', valueType: 'VALUE_TYPE_FLOAT', shape: 'SHAPE_STATE', unit: '', required: true },
        { name: 'kick', valueType: 'VALUE_TYPE_INT', shape: 'SHAPE_EVENT', unit: '', required: false },
      ],
      params: [],
      outputs: [{ name: 'out', valueType: 'VALUE_TYPE_FLOAT', shape: 'SHAPE_EVENT', unit: '', required: true, dest: 'BUS', media: 'SIGNAL', busPath: 'seq.probe.out' }],
      memberNeeds: [], rateDomain: 'RATE_CONTROL', requiresHostTick: true, determinism: 'REPLAYABLE', stateModel: 'STATELESS',
    },
    create: () => ({
      tick({ state, events }) { seen.push({ level: state('level'), kicks: events('kick').map((e) => e.payload) }); },
      snapshot: () => ({}), restore() {},
    }),
  };
  const assets = builtinAssets();
  assets.set('probe.v1', { manifest: pluginGen.PluginManifest.fromJSON(probe.manifest), create: probe.create });
  const host = makeHost(bus, [{
    instance: 'p', seed: 1, authorityRole: 'plugin_host', priority: 300,
    binding: { asset: 'probe.v1', inputs: { level: 'sensor.x.level', kick: 'sensor.x.kick' }, params: {} },
  }], { assets });

  // Tick 1: nothing published — absent ≠ zero.
  bus.advance(250); host.tickOnce();
  // Multi-writer STATE: high-priority claim, then a shadowed keepalive — the
  // plugin must see the RESOLVED 0.9, never the payload 0.1.
  bus.publishState('sensor.x.level', 0.9, { sourceId: 'spiffe://t/live', priority: 300 });
  bus.publishState('sensor.x.level', 0.1, { sourceId: 'spiffe://t/defaults', priority: 100 });
  // Three kick events between ticks: ALL delivered on the next tick.
  for (let i = 1; i <= 3; i++) bus.publishEvent('sensor.x.kick', i, { sourceId: 'spiffe://t/live' });
  bus.advance(250); host.tickOnce();
  bus.advance(250); host.tickOnce(); // queue drained -> empty, state held (ZOH)

  assert.deepEqual(seen, [
    { level: undefined, kicks: [] },
    { level: 0.9, kicks: [1, 2, 3] },
    { level: 0.9, kicks: [] },
  ]);
  host.stop();
});

test('required unbound input is a load error', () => {
  const pluginGen = require('../src/gen/plugin');
  const assets = builtinAssets();
  const probe = {
    asset: 'probe2', version: 1, kind: 'GENERATOR', humanLabel: '', schemaVersion: 'plugin.v1',
    inputs: [{ name: 'level', valueType: 'VALUE_TYPE_FLOAT', shape: 'SHAPE_STATE', unit: '', required: true }],
    params: [],
    outputs: [{ name: 'out', valueType: 'VALUE_TYPE_FLOAT', shape: 'SHAPE_EVENT', unit: '', required: true, dest: 'BUS', media: 'SIGNAL', busPath: 'seq.p2.out' }],
    memberNeeds: [], rateDomain: 'RATE_CONTROL', requiresHostTick: true, determinism: 'REPLAYABLE', stateModel: 'STATELESS',
  };
  assets.set('probe2.v1', { manifest: pluginGen.PluginManifest.fromJSON(probe), create: () => ({ tick() {}, snapshot: () => ({}), restore() {} }) });
  const v = validateBinding(
    { instance: 'p', seed: 1, authorityRole: 'plugin_host', priority: 300, binding: { asset: 'probe2.v1', inputs: {}, params: {} } },
    { assets, roles: ROLES },
  );
  assert.ok(v.errors.some((e) => /required input "level" is not bound/.test(e)));
});

// ── PRNG unit sanity ─────────────────────────────────────────────────────────

test('mulberry32: deterministic per seed, state round-trips', () => {
  const a = mulberry32(99); const b = mulberry32(99);
  const seqA = [a.rand(), a.rand(), a.rand()];
  assert.deepEqual(seqA, [b.rand(), b.rand(), b.rand()]);
  const mid = a.state();
  const tail = [a.rand(), a.rand()];
  const c = mulberry32(0); c.setState(mid);
  assert.deepEqual([c.rand(), c.rand()], tail);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});
