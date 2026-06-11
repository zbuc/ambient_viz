// Adapter writer-discipline tests (BUS_PROTOCOL.md): publish on change only,
// touch electrodes at bit granularity, keepalive within the stale window.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const { OrreryBus } = require('../src/bus');
const attachBusAdapter = require('../src/bus-adapter');

function setup() {
  const bus = new OrreryBus({
    bootEpochFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-test-')), 'epoch'),
  });
  const inputBus = new EventEmitter();
  const counts = new Map(); // path -> accepted packet count
  bus.on('packet', (rec) => {
    if (!rec.accepted) return;
    const p = rec.pkt.state.path;
    counts.set(p, (counts.get(p) || 0) + 1);
  });
  const adapter = attachBusAdapter({ bus, inputBus });
  return { bus, inputBus, counts, adapter };
}

test('adapter publishes on change only — identical legacy events do not refan', () => {
  const { bus, inputBus, counts, adapter } = setup();
  inputBus.emit('change', { name: 'distance_cm', value: 92.4 });
  inputBus.emit('change', { name: 'distance_cm', value: 92.4 }); // duplicate
  inputBus.emit('change', { name: 'distance_cm', value: 93.1 });
  assert.equal(counts.get('sensor.door.distance_cm'), 2);
  adapter.stop(); bus.stop();
});

test('touch_mask fans out at bit granularity: full set once, then changed bits only', () => {
  const { bus, inputBus, counts, adapter } = setup();
  inputBus.emit('change', { name: 'touch_mask', value: 0b000000000001 });
  let total = 0;
  for (const [p, n] of counts) if (p.startsWith('touch.')) total += n;
  assert.equal(total, 12, 'first mask publishes every electrode (retained baseline)');

  inputBus.emit('change', { name: 'touch_mask', value: 0b000000000011 }); // e1 flips
  total = 0;
  for (const [p, n] of counts) if (p.startsWith('touch.')) total += n;
  assert.equal(total, 13, 'subsequent mask change publishes ONLY the changed bit');
  assert.equal(counts.get('touch.pad0.e1'), 2);
  assert.equal(counts.get('touch.pad0.e11'), 1);
  adapter.stop(); bus.stop();
});

test('stale-declared paths keepalive within their window; others stay silent', async () => {
  const { bus, inputBus, counts, adapter } = setup();
  inputBus.emit('change', { name: 'song_position', value: 12.5 }); // staleAfterMs 1000
  inputBus.emit('change', { name: 'motion', value: true });        // staleAfterMs 0
  await new Promise((r) => setTimeout(r, 1300));
  assert.ok(counts.get('clock.daisy.position') >= 2, `keepalive republished (got ${counts.get('clock.daisy.position')})`);
  // 2 = the 6.1 boot motion=false baseline (defaults writer) + the live claim;
  // staleAfterMs 0 means NO keepalives ever follow.
  assert.equal(counts.get('sensor.room.motion'), 2, 'no-stale-window signal relies on retention, never keepalives');
  // and the keepalive keeps the writer live, not stale, in the inspector
  const snap = bus.snapshot()['clock.daisy.position'];
  assert.equal(snap.writer_candidates[0].stale, false);
  adapter.stop(); bus.stop();
});
