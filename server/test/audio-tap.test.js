// Phase-8A analysis tap: the band math (static/audio-tap.js computeBands —
// the formulas the page delegated to in the 8A extraction) and the tap
// publisher's writer discipline (decimation, quantized dedupe, keepalive,
// boot epoch, failure posture), ending with the end-to-end leg: the
// publisher's literal packets accepted policy-clean by a real OrreryBus
// under the real project registry. Run: cd server && node --test

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { computeBands, createTapPublisher, nextBootEpoch, PATHS, SOURCE_ID } = require('../../static/audio-tap');
const { OrreryBus } = require('../src/bus');
const { loadRegistry, applyRegistry } = require('../src/registry');

const MANIFEST_DIR = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest');

// ── computeBands ─────────────────────────────────────────────────────────────

const SR = 48000; // nyquist 24000
function freq(n, fill) { const a = new Uint8Array(n); if (fill) fill(a); return a; }
function timeFlat(n, byte) { return new Uint8Array(n).fill(byte); }

test('bands: silence is zero everywhere', () => {
  const b = computeBands({
    freqData: freq(1024),
    timeData: timeFlat(2048, 128), // 128 = zero crossing
    transientFreqData: freq(512),
    sampleRate: SR,
  });
  assert.deepEqual(b, { bass: 0, mid: 0, treble: 0, level: 0, levelDb: 0, peak: 0, bassFast: 0 });
});

test('bands: flat full-scale spectrum saturates the band averages', () => {
  const b = computeBands({
    freqData: freq(1024, (a) => a.fill(255)),
    timeData: timeFlat(2048, 128),
    transientFreqData: null,
    sampleRate: SR,
  });
  assert.equal(b.bass, 1);
  assert.equal(b.mid, 1);
  assert.equal(b.treble, 1);
  assert.equal(b.levelDb, 1);
  assert.equal(b.bassFast, 0); // no transient analyser -> 0, the legacy shape
});

test('bands: band isolation matches the bin mapping (floor/ceil over nyquist)', () => {
  // n=1024, nyq=24000: bass bins [floor(20/24000*1024), ceil(200/24000*1024)) = [0, 9).
  // Energy only in bins 0..7 (bin 8 straddles the bass/mid seam by the
  // floor/ceil construction): bass averages 8 full bins over 9, mid gets 0/78.
  const b = computeBands({
    freqData: freq(1024, (a) => { for (let i = 0; i < 8; i++) a[i] = 255; }),
    timeData: timeFlat(2048, 128),
    transientFreqData: null,
    sampleRate: SR,
  });
  assert.ok(Math.abs(b.bass - 8 / 9) < 1e-12);
  assert.equal(b.mid, 0);
  assert.equal(b.treble, 0);
});

test('bands: level is linear time-domain RMS, peak the max |sample|', () => {
  // Alternating 0/255 bytes: samples -1 and 127/128.
  const td = freq(2048, (a) => { for (let i = 0; i < a.length; i++) a[i] = i % 2 ? 255 : 0; });
  const b = computeBands({ freqData: freq(1024), timeData: td, transientFreqData: null, sampleRate: SR });
  const expected = Math.sqrt((1 + (127 / 128) ** 2) / 2);
  assert.ok(Math.abs(b.level - expected) < 1e-12);
  assert.equal(b.peak, 1);
});

test('bands: bassFast reads the transient analyser, same band mapping', () => {
  // n=512, nyq=24000: bass bins [0, ceil(200/24000*512)) = [0, 5).
  const b = computeBands({
    freqData: freq(1024),
    timeData: timeFlat(2048, 128),
    transientFreqData: freq(512, (a) => { for (let i = 0; i < 5; i++) a[i] = 255; }),
    sampleRate: SR,
  });
  assert.equal(b.bassFast, 1);
});

// ── boot epoch ───────────────────────────────────────────────────────────────

function memStore(initial) {
  let v = initial;
  return { get: () => v, set: (x) => { v = x; }, peek: () => v };
}

test('epoch: increments a persisted counter, seeds from time when empty', () => {
  const s = memStore('41');
  assert.equal(nextBootEpoch(s, 1234567), 42);
  assert.equal(s.peek(), '42');
  const empty = memStore(null);
  assert.equal(nextBootEpoch(empty, 1234567), 1234567);
  assert.equal(empty.peek(), '1234567');
});

test('epoch: a throwing store still yields a usable epoch', () => {
  const broken = { get: () => { throw new Error('no storage'); }, set: () => { throw new Error('no storage'); } };
  assert.equal(nextBootEpoch(broken, 99), 99);
});

// ── tap publisher ────────────────────────────────────────────────────────────

const N_PATHS = Object.keys(PATHS).length;

function harness(opts = {}) {
  const posts = [];
  let reply = { ok: true, status: 200 };
  const pub = createTapPublisher({
    epochStore: memStore('100'),
    post: (body) => { posts.push(body); return Promise.resolve(reply); },
    ...opts,
  });
  return { pub, posts, setReply: (r) => { reply = r; } };
}

const BANDS = { bass: 0.5, mid: 0.25, treble: 0.125, level: 0.75, bassFast: 0.0625, levelDb: 0.3, peak: 0.9 };

test('publisher: first frame posts one packet per declared field, well-formed', () => {
  const { pub, posts } = harness();
  pub.frame(BANDS, 1000);
  assert.equal(posts.length, 1);
  const pkts = posts[0];
  assert.equal(pkts.length, N_PATHS);
  const byPath = new Map(pkts.map((p) => [p.state.path, p]));
  assert.equal(byPath.get('audio.main.bass').state.value.number, 0.5);
  assert.equal(byPath.get('audio.main.bass_fast').state.value.number, 0.063); // quantized to 3 decimals
  for (const p of pkts) {
    assert.equal(p.schema, 'bus.v1');
    assert.equal(p.source.sourceId, SOURCE_ID);
    assert.equal(p.source.bootEpoch, 101);
    assert.equal(p.priority, 300);
  }
  // seq strictly increasing across the batch (one per-source counter)
  const seqs = pkts.map((p) => p.source.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
});

test('publisher: decimates the frame loop to periodMs', () => {
  const { pub, posts } = harness();
  for (let t = 1000; t < 1200; t += 16) pub.frame({ ...BANDS, bass: Math.random() }, t);
  // 200 ms of 16 ms frames through a 50 ms gate -> at most 5 posts
  assert.ok(posts.length <= 5, `expected <=5 posts, got ${posts.length}`);
});

test('publisher: unchanged values dedupe, then keepalive inside the stale window', () => {
  const { pub, posts } = harness();
  pub.frame(BANDS, 1000);
  assert.equal(posts.length, 1);
  // unchanged for 400 ms: no traffic
  for (let t = 1050; t <= 1400; t += 50) pub.frame(BANDS, t);
  assert.equal(posts.length, 1);
  // 1450: 450 ms since last send -> keepalive resends every field
  pub.frame(BANDS, 1450);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].length, N_PATHS);
});

test('publisher: sub-quantum wiggle does not defeat the dedupe', () => {
  const { pub, posts } = harness();
  pub.frame(BANDS, 1000);
  pub.frame({ ...BANDS, bass: 0.5002 }, 1050); // rounds to 0.5, unchanged
  assert.equal(posts.length, 1);
  pub.frame({ ...BANDS, bass: 0.502 }, 1100); // rounds to 0.502 -> change
  assert.equal(posts.length, 2);
  assert.equal(posts[1].length, 1);
  assert.equal(posts[1][0].state.path, 'audio.main.bass');
});

test('publisher: aggregate path (peak) publishes slice max, resets at publish', () => {
  const { pub, posts } = harness();
  pub.frame({ peak: 0.2 }, 1000); // tick 1
  pub.frame({ peak: 0.9 }, 1016); // decimated, hottest — must reach the next packet
  pub.frame({ peak: 0.3 }, 1032); // decimated
  pub.frame({ peak: 0.1 }, 1060); // tick 2
  assert.equal(posts.length, 2);
  assert.equal(posts[0][0].state.value.number, 0.2);
  assert.equal(posts[1][0].state.value.number, 0.9);
  // slice restarted at the 0.9 publish: next tick sees only what came after
  pub.frame({ peak: 0.15 }, 1120);
  assert.equal(posts.length, 3);
  assert.equal(posts[2][0].state.value.number, 0.15);
});

test('publisher: non-finite and out-of-range values never reach a packet (rule 13)', () => {
  const { pub, posts } = harness();
  pub.frame({ ...BANDS, bass: NaN, level: 1.7 }, 1000);
  const pkts = posts[0];
  assert.equal(pkts.length, N_PATHS - 1); // bass skipped this tick
  const byPath = new Map(pkts.map((p) => [p.state.path, p]));
  assert.ok(!byPath.has('audio.main.bass'));
  assert.equal(byPath.get('audio.main.level').state.value.number, 1); // clamped into the declared range
});

test('publisher: a 403 disables the tap for good', async () => {
  const { pub, posts, setReply } = harness();
  setReply({ ok: false, status: 403 });
  pub.frame(BANDS, 1000);
  await Promise.resolve(); // let the response handler run
  pub.frame({ ...BANDS, bass: 0.9 }, 1100);
  assert.equal(posts.length, 1);
  assert.equal(pub.inspect().disabled, true);
});

test('publisher: transient failure backs off, then resumes', async () => {
  const posts = [];
  let fail = true;
  const pub = createTapPublisher({
    epochStore: memStore('1'),
    post: (body) => { posts.push(body); return fail ? Promise.reject(new Error('down')) : Promise.resolve({ ok: true, status: 200 }); },
  });
  pub.frame(BANDS, 1000);
  await Promise.resolve();
  assert.equal(pub.inspect().errors, 1);
  pub.frame({ ...BANDS, bass: 0.9 }, 1500); // inside the 2 s backoff -> suppressed
  assert.equal(posts.length, 1);
  fail = false;
  pub.frame({ ...BANDS, bass: 0.9 }, 3100); // past the backoff -> resumes
  assert.equal(posts.length, 2);
  assert.equal(pub.inspect().disabled, false);
});

test('publisher: inspect() carries the per-path seq/value join keys', () => {
  const { pub } = harness();
  pub.frame(BANDS, 1000);
  const ins = pub.inspect();
  assert.equal(ins.boot_epoch, 101);
  assert.equal(ins.seq, N_PATHS);
  assert.equal(ins.last['audio.main.mid'], 0.25);
  assert.ok(ins.last_seq['audio.main.mid'] >= 1 && ins.last_seq['audio.main.mid'] <= N_PATHS);
});

// ── end to end: the publisher's packets through a real bus + registry ───────

test('e2e: tap packets are accepted policy-clean under the project registry', () => {
  const bus = new OrreryBus({ bootEpochFile: path.join(__dirname, '.tmp-audiotap-epoch') });
  try {
    const registry = loadRegistry(MANIFEST_DIR);
    applyRegistry(registry, bus);
    // The new module must not introduce load warnings of its own.
    const tapWarnings = registry.warnings.filter((w) => w.includes('audio-tap') || w.includes('audio.main'));
    assert.deepEqual(tapWarnings, []);

    const recs = [];
    const pub = createTapPublisher({
      epochStore: memStore('7'),
      post: (pkts) => { for (const p of pkts) recs.push(bus.publish(p)); return Promise.resolve({ ok: true, status: 200 }); },
    });
    pub.frame(BANDS, 1000);
    pub.frame({ ...BANDS, bass: 0.9 }, 1060);

    assert.equal(recs.length, N_PATHS + 1);
    for (const rec of recs) {
      assert.equal(rec.accepted, true, rec.reasons.join('; '));
      assert.equal(rec.enforcement.policy, 'OK (WARN mode)');
      assert.equal(rec.enforcement.type, 'OK (float)');
      assert.ok(!rec.enforcement.range.startsWith('WARN'), rec.enforcement.range);
    }
    // The bus resolves what the tap last sent.
    const snap = bus.snapshot();
    assert.equal(snap['audio.main.bass'].current_resolved_value, 0.9);
    assert.equal(snap['audio.main.level'].current_resolved_value, 0.75);
    assert.equal(snap['audio.main.bass'].declared_type, 'float');
    assert.equal(snap['audio.main.bass'].stale_after_ms, 1000);
  } finally {
    bus.stop();
    try { require('fs').unlinkSync(path.join(__dirname, '.tmp-audiotap-epoch')); } catch { /* */ }
  }
});
