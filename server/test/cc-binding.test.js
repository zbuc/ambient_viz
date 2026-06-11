// Phase-4D transport-adapter binding (cc-binding.js): the CC sink consumes
// the bus's arbitrated RESOLVED value, never a packet payload. Run:
// cd server && node --test
//
// The shadow shape under test is exactly the live one: legacy incumbent at
// 300, candidate router graph at 299 (incumbent−1).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { OrreryBus } = require('../src/bus');
const { attachResolvedBinding } = require('../src/cc-binding');

function makeBus(opts = {}) {
  let now = 0;
  const bus = new OrreryBus({
    nowMono: () => now,
    bootEpochFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-test-')), 'epoch'),
    ...opts,
  });
  bus.advance = (ms) => { now += ms; };
  return bus;
}

const PATH = 'fx.tape.failure';
const LEGACY = { sourceId: 'spiffe://test/legacy-tape', priority: 300 };
const CANDIDATE = { sourceId: 'spiffe://test/router', priority: 299 };

function attach(bus) {
  const seen = [];
  const detach = attachResolvedBinding({ bus, path: PATH, onResolved: (v) => seen.push(v) });
  return { seen, detach };
}

test('reads RESOLVED, not the payload: a shadowed candidate write surfaces the incumbent value', () => {
  const bus = makeBus();
  const { seen } = attach(bus);
  bus.publishState(PATH, 0.5, LEGACY);
  bus.publishState(PATH, 0.7, CANDIDATE); // shadowed — 0.7 must never reach the sink
  assert.deepEqual(seen, [0.5, 0.5]);
  bus.stop();
});

test('a lone candidate resolves and reaches the sink (boot before the incumbent ever wrote)', () => {
  const bus = makeBus();
  const { seen } = attach(bus);
  bus.publishState(PATH, 0.7, CANDIDATE);
  assert.deepEqual(seen, [0.7]);
  bus.stop();
});

test('other paths are ignored; detach stops delivery', () => {
  const bus = makeBus();
  const { seen, detach } = attach(bus);
  bus.publishState('fx.other.thing', 1, LEGACY);
  assert.deepEqual(seen, []);
  bus.publishState(PATH, 0.25, LEGACY);
  detach();
  bus.publishState(PATH, 0.75, LEGACY);
  assert.deepEqual(seen, [0.25]);
  bus.stop();
});

test('incumbent release hands the sink to the candidate', () => {
  const bus = makeBus();
  const { seen } = attach(bus);
  bus.publishState(PATH, 0.5, LEGACY);
  bus.publishState(PATH, 0.7, CANDIDATE);
  bus.publishState(PATH, 0.5, { ...LEGACY, release: true }); // 4E/4F shape: legacy steps away
  assert.deepEqual(seen, [0.5, 0.5, 0.7]);
  bus.stop();
});

test('a stale incumbent loses to a live candidate on the next packet (equal values live)', () => {
  const bus = makeBus();
  bus.registerPath(PATH, { shape: 'state', type: 'float', staleAfterMs: 2000 });
  const { seen } = attach(bus);
  bus.publishState(PATH, 0.5, LEGACY);
  bus.advance(3000); // still room: the incumbent's last write goes stale
  bus.publishState(PATH, 0.5, CANDIDATE); // keepalive-driven re-publish, same value
  assert.deepEqual(seen, [0.5, 0.5]); // sink sees the same value either way
  bus.stop();
});

test('non-finite resolved values are quarantined at the hardware boundary', () => {
  const bus = makeBus();
  const { seen } = attach(bus);
  bus.publishState(PATH, NaN, LEGACY);
  assert.deepEqual(seen, []);
  bus.publishState(PATH, 0.5, LEGACY);
  assert.deepEqual(seen, [0.5]);
  bus.stop();
});
