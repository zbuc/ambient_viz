// Phase-3 registry + WARN-mode policy tests (MIGRATION_PLAN.md): the real
// pain-material manifests load clean, clean adapter traffic produces ZERO
// warns, and a rogue publisher is flagged (but never rejected — WARN mode).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const { OrreryBus } = require('../src/bus');
const attachBusAdapter = require('../src/bus-adapter');
const { loadRegistry, applyRegistry } = require('../src/registry');

const MANIFEST_DIR = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest');

function setup() {
  const bus = new OrreryBus({
    bootEpochFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-test-')), 'epoch'),
  });
  const registry = loadRegistry(MANIFEST_DIR);
  applyRegistry(registry, bus);
  const inputBus = new EventEmitter();
  const adapter = attachBusAdapter({ bus, inputBus });
  return { bus, registry, inputBus, adapter };
}

test('the real pain-material manifests + policy load with zero warnings', () => {
  const registry = loadRegistry(MANIFEST_DIR);
  assert.deepEqual(registry.warnings, []);
  assert.equal(registry.project, 'pain-material');
  assert.equal(registry.bySourceId.size, 9); // 6 phase-3 modules + router + bridge defaults + the 4D legacy-tape incumbent
  assert.deepEqual(registry.modes, { auth: 'WARN', signature: 'NONE', priority: 'WARN', time_sync: 'OFF' });
});

test('manifest declarations drive the bus contracts (registry loads before adapter)', () => {
  const { bus, adapter } = setup();
  const dist = bus.paths.get('sensor.door.distance_cm');
  assert.equal(dist.declaredType, 'float');
  assert.equal(dist.staleAfterMs, 2000);
  assert.deepEqual(dist.range, { min: 0, max: 400 });
  adapter.stop(); bus.stop();
});

test('a clean session produces ZERO warns', () => {
  const { bus, inputBus, adapter } = setup();
  inputBus.emit('change', { name: 'distance_cm', value: 92.4 });
  inputBus.emit('change', { name: 'distance_velocity_cm_s', value: -14.2 });
  inputBus.emit('change', { name: 'motion', value: true });
  inputBus.emit('change', { name: 'touch_mask', value: 0b101 });
  inputBus.emit('change', { name: 'song_position', value: 42.5 });
  inputBus.emit('change', { name: 'freeze', value: 0.5 });
  inputBus.emit('change', { name: 'breath_detected', value: 1781119692409 });
  bus._publishMeta(); // _meta is exempt, must not warn either
  assert.equal(bus.warnsTotal, 0, `expected zero warns, got: ${JSON.stringify(bus.warns)}`);
  adapter.stop(); bus.stop();
});

test('a rogue publisher is flagged — and still accepted (WARN, not ENFORCE)', () => {
  const { bus, adapter } = setup();
  const rec = bus.publishState('sensor.door.distance_cm', 50, {
    sourceId: 'spiffe://evil.local/imposter', priority: 9000,
  });
  assert.equal(rec.accepted, true, 'WARN mode never rejects');
  assert.match(rec.enforcement.policy, /^WARN: .*not on the project allowlist/);
  assert.equal(bus.warnsTotal, 1);
  assert.equal(bus.snapshot()['sensor.door.distance_cm'].warned.policy, 1);
  // and with priority WARN-not-enforced, the rogue's 9000 wins arbitration —
  // visible in the inspector, exactly what WARN mode is supposed to surface
  assert.equal(bus.warns[0].kind, 'policy');
  adapter.stop(); bus.stop();
});

test('a trusted module is flagged for paths/priorities outside its role', () => {
  const { bus, adapter } = setup();
  // tof-door publishing into clock.* (cannot_publish + undeclared)
  const r1 = bus.publishState('clock.daisy.position', 1, {
    sourceId: 'spiffe://pain-material.local/sidecar/tof-door', priority: 300,
  });
  assert.equal(r1.accepted, true);
  assert.match(r1.enforcement.policy, /WARN/);
  assert.match(r1.enforcement.policy, /can_publish|cannot_publish/);
  // over the role's priority ceiling on its own declared path
  const r2 = bus.publishState('sensor.door.distance_cm', 10, {
    sourceId: 'spiffe://pain-material.local/sidecar/tof-door', priority: 999,
  });
  assert.match(r2.enforcement.policy, /priority 999 exceeds role ceiling 300/);
  adapter.stop(); bus.stop();
});

test('declared range is checked WARN-only', () => {
  const { bus, adapter } = setup();
  const rec = bus.publishState('sensor.door.distance_cm', 999, {
    sourceId: 'spiffe://pain-material.local/sidecar/tof-door', priority: 300,
  });
  assert.equal(rec.accepted, true);
  assert.match(rec.enforcement.range, /^WARN: 999 outside \[0, 400\]/);
  assert.equal(bus.snapshot()['sensor.door.distance_cm'].warned.range, 1);
  assert.equal(bus.snapshot()['sensor.door.distance_cm'].current_resolved_value, 999, 'WARN mode: value still lands');
  adapter.stop(); bus.stop();
});

test('duplicate stable_id / unknown role / bad unit are load warnings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-reg-'));
  fs.mkdirSync(path.join(dir, 'modules'));
  fs.writeFileSync(path.join(dir, 'units.json'), '["cm"]');
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({
    schema: 'policy.v1', project: 'test',
    authorityLadder: { sensor: 300 },
    roles: [{ name: 'sensor_node', canPublish: ['sensor.${instance}.*'], cannotPublish: [], canSubscribe: [], maxPriority: 300 }],
    allow: [
      { stableId: 'spiffe://t/a', role: 'sensor_node', instanceId: 'a' },
      { stableId: 'spiffe://t/b', role: 'ghost_role', instanceId: 'b' },
    ],
    groups: [],
    runtimeModes: { auth: 'WARN', signature: 'NONE', priority: 'WARN', timeSync: 'OFF' },
  }));
  const mod = (stableId, instanceId, unit) => JSON.stringify({
    schema: 'manifest.v1',
    identity: { stableId, instanceId, humanLabel: 'x', type: 'x', firmwareVersion: 'x', schemaVersion: 'manifest.v1' },
    role: 'sensor_node',
    publishes: [{ path: `sensor.${instanceId}.v`, valueType: 'VALUE_TYPE_FLOAT', shape: 'SHAPE_STATE', unit, nominalRateHz: 1, maxRateHz: 1, interpolation: 'INTERPOLATION_LINEAR', staleAfterMs: 0, onStale: 'ON_STALE_HOLD' }],
    subscribes: [],
  });
  fs.writeFileSync(path.join(dir, 'modules', '1-a.json'), mod('spiffe://t/a', 'a', 'cm'));
  fs.writeFileSync(path.join(dir, 'modules', '2-a-dup.json'), mod('spiffe://t/a', 'a2', 'cm'));
  fs.writeFileSync(path.join(dir, 'modules', '3-b.json'), mod('spiffe://t/b', 'b', 'parsecs'));
  const reg = loadRegistry(dir);
  assert.ok(reg.warnings.some((w) => /duplicate stable_id/.test(w)), JSON.stringify(reg.warnings));
  assert.ok(reg.warnings.some((w) => /role "ghost_role" not defined/.test(w)));
  assert.ok(reg.warnings.some((w) => /unit "parsecs"/.test(w)));
});
