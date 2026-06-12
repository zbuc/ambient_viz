// AudioTap — the host's audio analysis tap (migration phase 8A).
//
// Two halves, one module:
//
//   computeBands()      — the pure band math extracted from the page's
//                         bands() (static/index.html). The page fills the
//                         analyser byte arrays (the impure Web Audio part)
//                         and delegates the arithmetic here, so the formulas
//                         exist ONCE and are pinned by node tests.
//   createTapPublisher() — the control-plane half: publishes the tap's
//                         product as `audio.main.*` bus.v1 STATE packets
//                         over POST /bus/publish (the first bus-native
//                         ingress — the page as a real bus node, per
//                         ARCHITECTURE.md "Audio analysis: one tap per thing
//                         you listen to"). Decimates the 60 Hz frame loop to
//                         the declared control rate, dedupes on a quantized
//                         value, and keeps stale-declared paths alive — the
//                         same writer discipline as the bridge's bus-adapter.
//
// SHADOW (8A): nothing consumes audio.main.* yet. The render path keeps
// reading the same in-page values it always has (the bus hop is for graphs,
// the inspector, and capture — ARCHITECTURE.md: same-process paths don't
// round-trip the server).
//
// One file, three runtimes: a <script> tag (window.AudioTap), node tests
// (server/test/audio-tap.test.js), and the offline gate
// (tools/sim/validate-audiotap.js drives THIS publisher in its soak harness).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AudioTap = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA = 'bus.v1';
  const SOURCE_ID = 'spiffe://pain-material.local/browser/audio-tap';
  const EPOCH_KEY = 'orrery-audio-tap-boot-epoch';

  // field -> bus path. The manifest (manifest/modules/audio-tap.json) is the
  // schema of record; validate-audiotap.js cross-checks captures against it,
  // so drift between this table and the manifest fails the gate.
  const PATHS = {
    bass: 'audio.main.bass',
    mid: 'audio.main.mid',
    treble: 'audio.main.treble',
    level: 'audio.main.level',
    bassFast: 'audio.main.bass_fast',
    peak: 'audio.main.peak',
  };

  // Slice-aggregated paths (stage 2, the time-slice lesson): a point
  // sample at the publish tick is blind to anything that rose and fell
  // inside the gap, so these publish the MAX seen since their last
  // published packet — every frame's value feeds the accumulator even
  // when decimation drops the frame.
  const AGGREGATE_MAX = new Set([PATHS.peak]);

  // ── the band math (verbatim semantics of the legacy in-page bands()) ──────
  //
  // freqData / transientFreqData: Uint8Array from getByteFrequencyData —
  // analyser bins map linearly to 0..nyquist (bin = index/n * nyquist).
  // timeData: Uint8Array from getByteTimeDomainData (128 = zero crossing).
  //
  //   bass/mid/treble — 0..1 averaged byte energy over coarse Hz bands.
  //   levelDb         — spectral mean of the dB-mapped bytes. Diagnostic only:
  //                     it's logarithmic and clamped to the analyser's
  //                     [minDecibels,maxDecibels] window, so it reads on/off
  //                     for quiet inputs and a linear input gain barely moves
  //                     it.
  //   level/peak      — LINEAR time-domain RMS / max |sample|: scales
  //                     proportionally with the signal (so ?micgain actually
  //                     works) and tracks the music smoothly instead of
  //                     snapping between silence and saturation.
  //   bassFast        — the bass band off the low-smoothing transient
  //                     analyser (kick attacks the 0.85-smoothed main
  //                     analyser flattens).
  function avgRange(data, dataN, loHz, hiHz, nyq) {
    const lo = Math.max(0, Math.floor(loHz / nyq * dataN));
    const hi = Math.min(dataN, Math.ceil(hiHz / nyq * dataN));
    let s = 0, c = 0;
    for (let i = lo; i < hi; i++) { s += data[i]; c++; }
    return c ? s / c / 255 : 0;
  }

  function computeBands({ freqData, timeData, transientFreqData, sampleRate }) {
    const n = freqData.length;
    const nyq = sampleRate / 2;
    const bass = avgRange(freqData, n, 20, 200, nyq);
    const mid = avgRange(freqData, n, 200, 2000, nyq);
    const treble = avgRange(freqData, n, 2000, 12000, nyq);
    let levelDb = 0;
    for (let i = 0; i < n; i++) levelDb += freqData[i];
    levelDb = levelDb / n / 255;
    let level = 0, peak = 0;
    for (let i = 0; i < timeData.length; i++) {
      const s = (timeData[i] - 128) / 128;
      level += s * s;
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }
    level = Math.sqrt(level / timeData.length);
    let bassFast = 0;
    if (transientFreqData) {
      bassFast = avgRange(transientFreqData, transientFreqData.length, 20, 200, nyq);
    }
    return { bass, mid, treble, level, levelDb, peak, bassFast };
  }

  // ── boot epoch (BUS_PROTOCOL.md ordering key, page edition) ───────────────
  // The bridge persists its counter in a file; the page's equivalent is
  // localStorage. Seeded from wall-clock seconds when the store is empty (or
  // cleared), so the value stays monotonic across storage loss as long as a
  // second has passed — the same self-healing posture as the spec's
  // re-randomize fallback. Two tabs in one profile resolve deterministically:
  // the later load takes epoch+1 and the bus rejects the older writer.
  function nextBootEpoch(store, nowSec) {
    let prev = null;
    try {
      const s = store.get();
      const p = s == null ? NaN : parseInt(s, 10);
      if (Number.isFinite(p)) prev = p;
    } catch { /* no storage — fall through to the time seed */ }
    const n = (prev !== null ? Math.max(prev + 1, 1) : Math.max(nowSec, 1)) >>> 0;
    try { store.set(String(n)); } catch { /* best effort */ }
    return n;
  }

  function defaultEpochStore() {
    return {
      get: () => (typeof localStorage !== 'undefined' ? localStorage.getItem(EPOCH_KEY) : null),
      set: (v) => { if (typeof localStorage !== 'undefined') localStorage.setItem(EPOCH_KEY, v); },
    };
  }

  function defaultPost(body) {
    return fetch('/bus/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // ── the publisher ─────────────────────────────────────────────────────────
  //
  //   periodMs    — control-rate decimation of the rAF loop (50 ms ≈ 20 Hz,
  //                 the manifest's nominal; maxRateHz 30 leaves headroom for
  //                 rAF jitter).
  //   keepaliveMs — unchanged values republish inside the declared
  //                 staleAfterMs (1000 ms) window: staleAfterMs/2 with margin,
  //                 the bus-adapter's writer obligation.
  //   quant       — values are rounded to 3 decimals before the change check,
  //                 so analyser noise in near-silence can't defeat the dedupe.
  //
  // Failure posture: a 403 means this page has no business publishing (a
  // remote/laptop view of the kiosk URL — /bus/publish is loopback-only) and
  // disables the tap for the page's lifetime. Transient failures (bridge
  // restart) back off and retry; the EventSource feed has the same rhythm.
  function createTapPublisher(opts = {}) {
    const post = opts.post || defaultPost;
    const sourceId = opts.sourceId || SOURCE_ID;
    const priority = opts.priority != null ? opts.priority : 300; // sensor rung
    const periodMs = opts.periodMs != null ? opts.periodMs : 50;
    const keepaliveMs = opts.keepaliveMs != null ? opts.keepaliveMs : 450;
    const errorBackoffMs = opts.errorBackoffMs != null ? opts.errorBackoffMs : 2000;
    const quant = opts.quant != null ? opts.quant : 1000; // 3 decimals
    const bootEpoch = nextBootEpoch(
      opts.epochStore || defaultEpochStore(),
      Math.floor(Date.now() / 1000),
    );

    let seq = 0;
    let disabled = false;
    let lastTickAt = -Infinity;
    let blockedUntil = -Infinity;
    let posts = 0, errors = 0;
    const lastSent = Object.create(null);   // path -> quantized value
    const lastSentAt = Object.create(null); // path -> atMs
    const lastSeq = Object.create(null);    // path -> seq of last packet
    const sliceMax = Object.create(null);   // path -> running max since last publish

    function frame(bands, atMs) {
      if (disabled || !bands || typeof atMs !== 'number' || !isFinite(atMs)) return;
      // Aggregates accumulate on EVERY frame — before any decimation gate —
      // so values inside a dropped frame still reach the next packet.
      for (const field of Object.keys(PATHS)) {
        const p = PATHS[field];
        if (!AGGREGATE_MAX.has(p)) continue;
        const raw = bands[field];
        if (typeof raw !== 'number' || !isFinite(raw)) continue;
        const c = Math.min(1, Math.max(0, raw));
        if (!(p in sliceMax) || c > sliceMax[p]) sliceMax[p] = c;
      }
      if (atMs - lastTickAt < periodMs) return;
      if (atMs < blockedUntil) return;
      lastTickAt = atMs;

      const packets = [];
      for (const field of Object.keys(PATHS)) {
        const p = PATHS[field];
        const raw = AGGREGATE_MAX.has(p) && p in sliceMax ? sliceMax[p] : bands[field];
        if (typeof raw !== 'number' || !isFinite(raw)) continue; // rule-13: never publish non-finite
        const v = Math.round(Math.min(1, Math.max(0, raw)) * quant) / quant;
        const changed = lastSent[p] !== v;
        const due = !(p in lastSentAt) || atMs - lastSentAt[p] >= keepaliveMs;
        if (!changed && !due) continue;
        seq += 1;
        packets.push({
          schema: SCHEMA,
          source: { sourceId, seq, bootEpoch },
          time: { monotonic: { device: 'browser', nanos: Math.round(atMs * 1e6) } },
          priority,
          state: { path: p, value: { number: v } },
        });
        lastSent[p] = v;
        lastSentAt[p] = atMs;
        lastSeq[p] = seq;
        if (AGGREGATE_MAX.has(p)) delete sliceMax[p]; // the slice restarts at publish
      }
      if (!packets.length) return;

      posts += 1;
      try {
        Promise.resolve(post(packets)).then((res) => {
          if (res && res.ok === false) {
            if (res.status === 403) {
              disabled = true;
              try { console.warn('audio-tap: /bus/publish refused (403) — tap disabled for this page'); } catch { /* */ }
            } else {
              errors += 1;
              blockedUntil = atMs + errorBackoffMs;
            }
          }
        }, () => {
          errors += 1;
          blockedUntil = atMs + errorBackoffMs;
        });
      } catch {
        errors += 1;
        blockedUntil = atMs + errorBackoffMs;
      }
    }

    // The snapshot/inspector view: enough for the offline gate to join each
    // snapshot to the exact captured packets (boot_epoch + per-path seq) and
    // assert end-to-end value equality.
    function inspect() {
      return {
        source_id: sourceId,
        boot_epoch: bootEpoch,
        seq,
        disabled,
        posts,
        errors,
        last: { ...lastSent },
        last_seq: { ...lastSeq },
      };
    }

    return { frame, inspect };
  }

  return { computeBands, createTapPublisher, nextBootEpoch, PATHS, SOURCE_ID };
}));
