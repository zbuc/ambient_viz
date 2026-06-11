// orrery bus.v1 semantics tests (phase 1). Run: cd server && node --test
// Covers the contracts BUS_PROTOCOL.md states and the inspector relies on:
// retention, (boot_epoch, seq) ordering, priority arbitration + release,
// stale HOLD, bounded event queues with counted drops, type enforcement
// truth values, and the generated codec round-trip.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { OrreryBus } = require('../src/bus');
const busGen = require('../src/gen/bus');

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

test('retained state replays to late joiners', () => {
  const bus = makeBus();
  bus.publishState('sensor.door.distance_cm', 92.4, { sourceId: 'a', priority: 300 });
  bus.publishState('sensor.room.motion', true, { sourceId: 'b', priority: 300 });
  const retained = bus.retained();
  assert.deepEqual(
    Object.fromEntries(retained.map((r) => [r.path, r.value])),
    { 'sensor.door.distance_cm': 92.4, 'sensor.room.motion': true },
  );
  bus.stop();
});

test('(boot_epoch, seq) ordering: regressions rejected, gaps counted, reboot accepted', () => {
  const bus = makeBus();
  const pkt = (epoch, seq, v) => ({
    schema: 'bus.v1',
    source: { sourceId: 's', seq, bootEpoch: epoch },
    priority: 1,
    state: { path: 'p.x.f', value: { number: v } },
  });
  assert.equal(bus.publish(pkt(5, 1, 1)).accepted, true);
  assert.equal(bus.publish(pkt(5, 1, 2)).accepted, false); // same seq -> dup/out of order
  assert.equal(bus.publish(pkt(4, 99, 3)).accepted, false); // older epoch loses
  assert.equal(bus.publish(pkt(5, 4, 4)).accepted, true);  // gap of 2, counted
  assert.equal(bus.publish(pkt(6, 1, 5)).accepted, true);  // reboot: fresh epoch, seq restarts
  const snap = bus.snapshot()['p.x.f'];
  assert.equal(snap.writer_candidates[0].seq_gaps, 2);
  assert.equal(snap.rejected.order, 2);
  assert.equal(snap.current_resolved_value, 5);
  bus.stop();
});

test('priority arbitration: highest wins, ties resolve by arrival, release relinquishes', () => {
  const bus = makeBus();
  bus.publishState('p.x.f', 'legacy', { sourceId: 'legacy', priority: 500 });
  bus.publishState('p.x.f', 'candidate', { sourceId: 'cand', priority: 400 });
  assert.equal(bus.snapshot()['p.x.f'].current_resolved_value, 'legacy');

  const st = bus.snapshot()['p.x.f'];
  const cand = st.writer_candidates.find((c) => c.source_id === 'cand');
  assert.equal(cand.status, 'would_win_if_priority_ge_legacy'); // the shadow-diff view

  // equal priority: arrival order (last arrival wins)
  bus.publishState('p.x.f', 'cand2', { sourceId: 'cand', priority: 500 });
  assert.equal(bus.snapshot()['p.x.f'].current_resolved_value, 'cand2');

  // release: the winner relinquishes NOW; the other live writer takes over
  bus.publishState('p.x.f', 'cand2', { sourceId: 'cand', priority: 500, release: true });
  assert.equal(bus.snapshot()['p.x.f'].current_resolved_value, 'legacy');
  bus.stop();
});

test('stale HOLD: stale writer flagged + loses to live writer; all-stale holds value', () => {
  const bus = makeBus();
  bus.registerPath('p.x.f', { shape: 'state', type: 'float', staleAfterMs: 1000 });
  bus.publishState('p.x.f', 10, { sourceId: 'high', priority: 500 });
  bus.advance(2000); // high goes stale
  bus.publishState('p.x.f', 20, { sourceId: 'low', priority: 100 });
  let snap = bus.snapshot()['p.x.f'];
  assert.equal(snap.current_resolved_value, 20, 'live low-priority beats stale high-priority');
  assert.equal(snap.writer_candidates.find((c) => c.source_id === 'high').stale, true);

  bus.advance(2000); // now everyone is stale -> HOLD last resolved
  // trigger a resolve pass via an unrelated publish on the path? No — snapshot reflects holding.
  snap = bus.snapshot()['p.x.f'];
  assert.equal(snap.current_resolved_value, 20, 'HOLD keeps last value when all writers stale');
  assert.equal(snap.resolved_holding_stale, true);
  bus.stop();
});

test('event queues: append-only, drained in order, bounded with counted drops, deduped', () => {
  const bus = makeBus();
  bus.registerPath('ev.x.s', { shape: 'event', maxQueue: 3 });
  for (let i = 1; i <= 5; i++) bus.publishEvent('ev.x.s', i, { sourceId: 'e' });
  let snap = bus.snapshot()['ev.x.s'];
  assert.equal(snap.queue_depth, 3);
  assert.equal(snap.drops, 2); // drop-oldest, counted — "no silent loss"
  assert.deepEqual(bus.drainEvents('ev.x.s').map((e) => e.payload), [3, 4, 5]);
  assert.equal(bus.snapshot()['ev.x.s'].queue_depth, 0);

  // dedupe by explicit key
  bus.publishEvent('ev.x.s', 'a', { sourceId: 'e', dedupeKey: 'k1' });
  const dup = bus.publishEvent('ev.x.s', 'a', { sourceId: 'e', dedupeKey: 'k1' });
  assert.equal(dup.accepted, false);
  assert.equal(bus.drainEvents('ev.x.s').length, 1);
  bus.stop();
});

test('type enforcement: declared type rejects mismatches with honest truth values', () => {
  const bus = makeBus();
  bus.registerPath('p.x.f', { shape: 'state', type: 'float' });
  const ok = bus.publishState('p.x.f', 1.5, { sourceId: 's' });
  assert.equal(ok.accepted, true);
  assert.match(ok.enforcement.type, /^OK/);
  assert.match(ok.enforcement.signature, /^SKIPPED/); // skipped is SAID, not greenwashed
  const bad = bus.publishState('p.x.f', 'nope', { sourceId: 's' });
  assert.equal(bad.accepted, false);
  assert.match(bad.enforcement.type, /^REJECTED/);
  const snap = bus.snapshot()['p.x.f'];
  assert.equal(snap.rejected.type, 1);
  assert.equal(snap.current_resolved_value, 1.5, 'rejected packet never lands');
  bus.stop();
});

test('shape mismatch rejected: a path is STATE or EVENT, never both', () => {
  const bus = makeBus();
  bus.publishState('p.x.f', 1, { sourceId: 's' });
  const r = bus.publishEvent('p.x.f', 1, { sourceId: 's' });
  assert.equal(r.accepted, false);
  assert.match(r.reasons[0], /shape mismatch/);
  bus.stop();
});

test('boot_epoch persists and increments across bus instances', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-test-')), 'epoch');
  const a = new OrreryBus({ bootEpochFile: file });
  const b = new OrreryBus({ bootEpochFile: file });
  assert.equal(b.bootEpoch, a.bootEpoch + 1);
  a.stop(); b.stop();
});

test('generated codec round-trips a bus packet (binary + proto-JSON)', () => {
  const bus = makeBus();
  let captured;
  bus.on('packet', (rec) => { captured = rec.pkt; });
  bus.publishState('sensor.door.distance_cm', 92.4, {
    sourceId: 'spiffe://pain-material.local/sidecar/tof-door', priority: 300,
  });
  const bin = busGen.SignalPacket.encode(busGen.SignalPacket.fromPartial(captured)).finish();
  const back = busGen.SignalPacket.decode(bin);
  assert.equal(back.state.path, 'sensor.door.distance_cm');
  assert.equal(back.state.value.number, 92.4);
  assert.equal(back.source.bootEpoch, bus.bootEpoch);
  const json = busGen.SignalPacket.toJSON(back);
  assert.equal(json.state.value.number, 92.4);
  bus.stop();
});

test('_meta counters publish as ordinary bus signals', () => {
  const bus = makeBus();
  bus.publishState('sensor.door.distance_cm', 1, { sourceId: 'a', priority: 300 });
  bus._publishMeta();
  const snap = bus.snapshot();
  assert.ok('_meta.sensor.door.distance_cm.rate_hz' in snap);
  assert.equal(snap['_meta.sensor.door.distance_cm.last_writer'].current_resolved_value, 'a');
  bus.stop();
});

test('packetFrame: a shadowed keepalive frame carries the RESOLVED value (the feed flap, fixed)', () => {
  const bus = makeBus();
  const frames = [];
  bus.on('packet', (rec) => { if (rec.accepted) frames.push(bus.packetFrame(rec)); });
  // The live kiosk shape: sensor claim far=170 @300, then the standing
  // defaults writer's keepalive far=130 @100 — shadowed, but still an
  // accepted packet on the wire.
  bus.publishState('sensor.door.far_cm', 170, { sourceId: 'spiffe://t/claim', priority: 300 });
  bus.publishState('sensor.door.far_cm', 130, { sourceId: 'spiffe://t/defaults', priority: 100 });
  assert.equal(frames.length, 2);
  // The payload says 130; the annotation says what a consumer must read.
  assert.equal(frames[1].state.value.number ?? frames[1].state.value.integer, 130);
  assert.equal(frames[1].resolved.number ?? frames[1].resolved.integer, 170);
  // Single-writer paths annotate too (payload == resolved).
  assert.equal(frames[0].resolved.number ?? frames[0].resolved.integer, 170);
  bus.stop();
});
