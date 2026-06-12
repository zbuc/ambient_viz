#!/usr/bin/env node
// Phase-8A gate (MIGRATION_PLAN.md — the analysis tap): judge a captured
// session's audio.main.* stream from the fixture alone.
//
// The capture carries two boundaries the bridge taps for this stream:
//   `bus_rx`           — every /bus/publish POST: the decoded packets plus the
//                        bus's own acceptance verdicts (the ingest doctrine);
//   `browser_snapshot` — the page's periodic snapshot, now carrying the tap
//                        publisher's self-view (boot_epoch, per-path last
//                        seq + quantized value).
//
// Lanes:
//   DRIFT    — the module's path table (static/audio-tap.js PATHS) must equal
//              the manifest's declared publishes (audio-tap.json), and every
//              captured packet must carry the allowlisted source identity.
//   HYGIENE  — zero rejected packets, zero policy WARNs across the session.
//   CONTRACT — per path: values in [0,1] at the declared quantization; seq
//              strictly increasing per boot_epoch; the keepalive obligation
//              (inter-packet gap <= staleAfterMs + margin, a page
//              reload/new-epoch boundary excuses the gap it spans); rate
//              under the declared maxRateHz over the active span.
//   JOIN     — every snapshot's per-path (seq, value) resolves to a captured
//              packet with that exact seq and value: what the page believes
//              it sent IS what the bridge accepted, end to end.
//
// A capture with no audio.main.* traffic (pre-8A goldens, or a session where
// the audio context never ran) reports ABSENT and does not block.
//
// Usage: node tools/sim/validate-audiotap.js <golden-session-dir> [--out DIR] [--quiet]
// Exit:  0 = MATCH / ABSENT, 1 = blocked, 2 = harness error.

'use strict';

const fs = require('fs');
const path = require('path');

const { loadSession } = require('../replay/capture-io');
const { PATHS, SOURCE_ID } = require('../../static/audio-tap');

const MANIFEST_FILE = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest', 'modules', 'audio-tap.json');
const SIDECAR_MANIFEST_FILE = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest', 'modules', 'audio-tap-sidecar.json');
// audio.main.* is a multi-writer surface since the sidecar scaffold
// (AUDIO_ANALYSIS_SIDECAR.md): the gate accepts any allowlisted tap
// identity and judges each writer's stream independently (order/gap/rate
// are per-writer properties; one writer's reload must not look like
// another's seq regression). The two-writer A/B value lane is still
// future work — this only generalizes identity + keying.
const TAP_SOURCES = new Set([
  SOURCE_ID, // browser tap (static/audio-tap.js)
  'spiffe://pain-material.local/analysis/audio-tap', // Rust sidecar (analysis/)
]);
const GAP_MARGIN_MS = 500;  // scheduling slack on top of the declared staleAfterMs
const QUANT = 1000;         // 3 decimals — the publisher's declared quantization

function parseArgs(argv) {
  const args = { dir: null, out: null, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (!args.dir) args.dir = a;
    else throw new Error(`unexpected arg: ${a}`);
  }
  if (!args.dir) throw new Error('usage: validate-audiotap.js <golden-session-dir> [--out DIR] [--quiet]');
  return args;
}

function validateAudioTap({ goldenDir, outDir, quiet = false }) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  const declared = new Map(manifest.publishes.map((d) => [d.path, d]));
  // The sidecar manifest declares a SUPERSET (detector states + onset
  // EVENTs, stage 1) — its paths join the declared set so sidecar-only
  // signals are validated, not silently skipped.
  const sidecar = JSON.parse(fs.readFileSync(SIDECAR_MANIFEST_FILE, 'utf8'));
  const declaredAll = new Map(declared);
  for (const d of sidecar.publishes) {
    if (!declaredAll.has(d.path)) declaredAll.set(d.path, d);
  }
  const stateSet = new Set([...declaredAll.entries()]
    .filter(([, d]) => d.shape !== 'SHAPE_EVENT').map(([p]) => p));
  const eventSet = new Set([...declaredAll.entries()]
    .filter(([, d]) => d.shape === 'SHAPE_EVENT').map(([p]) => p));

  // ── DRIFT: browser module table == browser manifest declarations ────────
  const moduleSet = new Set(Object.values(PATHS));
  const drift = [];
  for (const p of moduleSet) if (!declared.has(p)) drift.push(`module publishes ${p}: not in the manifest`);
  for (const p of declared.keys()) if (!moduleSet.has(p)) drift.push(`manifest declares ${p}: not in the module table`);

  const golden = loadSession(goldenDir);
  const rx = golden.events.filter((e) => e.kind === 'bus_rx');
  const packets = [];
  const events = [];
  const eventViolations = [];
  let rejected = 0;
  let policyWarns = 0;
  for (const e of rx) {
    rejected += e.rejected || 0;
    policyWarns += e.policy_warns || 0;
    for (const pkt of e.packets || []) {
      const st = pkt && pkt.state;
      if (st && stateSet.has(st.path)) {
        packets.push({
          t: e.t_mono_ms,
          path: st.path,
          value: st.value && typeof st.value.number === 'number' ? st.value.number : st.value && st.value.integer,
          seq: pkt.source ? pkt.source.seq : null,
          epoch: pkt.source ? pkt.source.bootEpoch : null,
          source: pkt.source ? pkt.source.sourceId : null,
        });
        continue;
      }
      const ev = pkt && pkt.event;
      if (ev && ev.path && ev.path.startsWith('audio.main.')) {
        if (!eventSet.has(ev.path)) {
          if (eventViolations.length < 10) eventViolations.push({ t: e.t_mono_ms, kind: 'undeclared_event_path', path: ev.path });
          continue;
        }
        const payload = ev.payload && (typeof ev.payload.number === 'number' ? ev.payload.number : ev.payload.integer);
        if (typeof payload !== 'number' || !isFinite(payload) || payload < 0 || payload > 1) {
          if (eventViolations.length < 10) eventViolations.push({ t: e.t_mono_ms, kind: 'bad_event_payload', path: ev.path, payload });
        }
        events.push({ t: e.t_mono_ms, path: ev.path });
      }
    }
  }

  if (!packets.length && !events.length) {
    const validation = {
      schema: 'audiotap-validation.v1', phase: '8A',
      verdict: 'ABSENT', blocks: false,
      note: 'capture has no audio.main.* bus_rx traffic (pre-8A capture, or the audio context never ran)',
      drift,
    };
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'audiotap-validation.json'), JSON.stringify(validation, null, 2));
    if (!quiet) console.log(`audio tap: ABSENT — ${validation.note}\n\nverdict: ABSENT`);
    return { validation };
  }

  // ── CONTRACT ────────────────────────────────────────────────────────────
  const contract = { values: [], identity: [], order: [], gaps: [], rate: [] };
  const byPath = new Map(); // keyed `${source}|${path}` — per-writer streams
  for (const p of packets) {
    if (!TAP_SOURCES.has(p.source)) contract.identity.push({ t: p.t, source: p.source });
    if (typeof p.value !== 'number' || p.value < 0 || p.value > 1
      || Math.abs(p.value * QUANT - Math.round(p.value * QUANT)) > 1e-6) {
      if (contract.values.length < 10) contract.values.push({ t: p.t, path: p.path, value: p.value });
    }
    const pk = `${p.source}|${p.path}`;
    if (!byPath.has(pk)) byPath.set(pk, []);
    byPath.get(pk).push(p);
  }
  // seq strictly increasing per (writer, epoch) — one counter per writer boot
  const byEpoch = new Map();
  for (const p of packets) {
    const ek = `${p.source}#${p.epoch}`;
    if (!byEpoch.has(ek)) byEpoch.set(ek, []);
    byEpoch.get(ek).push(p);
  }
  for (const [epoch, list] of byEpoch) {
    let last = -Infinity;
    for (const p of list) {
      if (p.seq <= last && contract.order.length < 10) contract.order.push({ epoch, t: p.t, seq: p.seq, after: last });
      last = Math.max(last, p.seq);
    }
  }
  // keepalive gaps + rate, per (writer, path)
  const maxGapStats = {};
  for (const [pk, list] of byPath) {
    const p = list[0].path;
    const staleMs = declaredAll.get(p).staleAfterMs || 1000;
    const maxRate = declaredAll.get(p).maxRateHz || 30;
    let maxGap = 0;
    for (let i = 1; i < list.length; i++) {
      const gap = list[i].t - list[i - 1].t;
      const epochBoundary = list[i].epoch !== list[i - 1].epoch; // page reload
      if (gap > maxGap && !epochBoundary) maxGap = gap;
      if (gap > staleMs + GAP_MARGIN_MS && !epochBoundary && contract.gaps.length < 10) {
        contract.gaps.push({ path: p, t: list[i].t, gap_ms: Math.round(gap) });
      }
    }
    const span = (list[list.length - 1].t - list[0].t) / 1000;
    const hz = span > 1 ? (list.length - 1) / span : 0;
    if (hz > maxRate && contract.rate.length < 10) contract.rate.push({ path: p, hz: Math.round(hz * 10) / 10, max: maxRate });
    maxGapStats[pk] = { packets: list.length, max_gap_ms: Math.round(maxGap), rate_hz: Math.round(hz * 10) / 10 };
  }

  // ── A/B: two writers on one compat path (the cutover's evidence lane) ───
  // When a capture carries BOTH taps (browser + sidecar) on a shared path,
  // ZOH-resample each writer's stream onto a common grid over their
  // overlap (minus warmup: analyser smoothing + envelope state + page-load
  // skew) and demand the values agree — the sidecar's AnalyserNode
  // emulation is supposed to be the browser's NUMBERS, and this is where
  // that claim is tested. Single-writer captures skip the lane (ABSENT).
  const AB_GRID_MS = 100;
  const AB_WARMUP_MS = 3000;
  const AB_EPS_P95 = 0.05; // |a-b| at p95 over the overlap, per path
  // Transient-flavored paths get wider allowances — comparison noise,
  // each measured in a dual-writer soak and set at ~1.2x the observed p95:
  //   bass_fast — low-smoothing transient band; two ~60 Hz tickers'
  //     3-decimal samples on a 100 ms grid smear its attacks (soak #2:
  //     mean 0.036, p95 0.099, fit ~identity) -> 0.12.
  //   peak — slice-max aggregate; a spike near a slice boundary lands in
  //     ADJACENT packets across writers, so the instantaneous diff is the
  //     spike height even when both saw it (soak #3: mean 0.028,
  //     p95 0.125) -> 0.15.
  const AB_EPS_BY_PATH = { 'audio.main.bass_fast': 0.12, 'audio.main.peak': 0.15 };
  const ab = { paths: {}, compared: 0, violations: [] };
  {
    // path -> source -> [{t, value}]
    const perPath = new Map();
    for (const [pk, list] of byPath) {
      const p = list[0].path;
      if (!perPath.has(p)) perPath.set(p, new Map());
      perPath.get(p).set(pk.split('|')[0], list);
    }
    const zoh = (list, t) => {
      // list is t-ordered (capture order); last sample at or before t
      let v = null;
      for (const s of list) {
        if (s.t > t) break;
        v = s.value;
      }
      return v;
    };
    // The two writers may sit up to their seek thresholds apart in SONG
    // time (each re-syncs to the clock independently) — sub-second skew
    // is sync slack, not emulation error. Search a WIDE lag range so a
    // misaligned writer is diagnosed (the first soak found a 5.2 s
    // VBR-seek error this way), but alignment is part of the contract:
    // the verdict requires the best lag itself within AB_LAG_PASS_MS.
    const AB_LAG_MAX_MS = 3000;
    const AB_LAG_PASS_MS = 1000;
    const AB_LAG_STEP_MS = 50;
    const diffsAtLag = (lists, t0, t1, lag) => {
      const out = [];
      for (let t = t0; t <= t1; t += AB_GRID_MS) {
        const a = zoh(lists[0], t);
        const b = zoh(lists[1], t + lag);
        if (typeof a !== 'number' || typeof b !== 'number') continue;
        out.push(Math.abs(a - b));
      }
      return out;
    };
    for (const [p, bySource] of perPath) {
      if (bySource.size < 2) continue;
      const lists = [...bySource.values()];
      const t0 = Math.max(...lists.map((l) => l[0].t)) + AB_WARMUP_MS;
      const t1 = Math.min(...lists.map((l) => l[l.length - 1].t)) - AB_LAG_MAX_MS;
      if (t1 - t0 < 5000) {
        ab.paths[p] = { note: `overlap too short (${Math.round(t1 - t0)} ms)` };
        continue;
      }
      let best = null;
      for (let lag = -AB_LAG_MAX_MS; lag <= AB_LAG_MAX_MS; lag += AB_LAG_STEP_MS) {
        const diffs = diffsAtLag(lists, t0, t1, lag);
        if (!diffs.length) continue;
        const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
        if (!best || mean < best.mean) best = { lag, mean, diffs };
      }
      if (!best) {
        ab.paths[p] = { note: 'no comparable grid points' };
        continue;
      }
      best.diffs.sort((a, b) => a - b);
      const eps = AB_EPS_BY_PATH[p] || AB_EPS_P95;
      const p95 = best.diffs[Math.floor(best.diffs.length * 0.95)];
      const stat = {
        points: best.diffs.length,
        lag_ms: best.lag,
        mean: Math.round(best.mean * 10000) / 10000,
        p95,
        max: best.diffs[best.diffs.length - 1],
        eps_p95: eps,
        lag_pass_ms: AB_LAG_PASS_MS,
        pass: p95 <= eps && Math.abs(best.lag) <= AB_LAG_PASS_MS,
      };
      ab.paths[p] = stat;
      ab.compared += 1;
      if (!stat.pass) ab.violations.push({ path: p, p95: stat.p95, max: stat.max, lag_ms: stat.lag_ms });
    }
  }

  // ── JOIN: snapshots' self-view vs captured packets ──────────────────────
  const idx = new Map(); // `${source}#${epoch}#${seq}` -> packet
  for (const p of packets) idx.set(`${p.source}#${p.epoch}#${p.seq}`, p);
  const snaps = golden.events.filter((e) => e.kind === 'browser_snapshot'
    && e.snapshot && e.snapshot.audio_tap && e.snapshot.audio_tap.last_seq);
  const join = { snapshots: snaps.length, checked: 0, mismatches: [] };
  for (const s of snaps) {
    const at = s.snapshot.audio_tap;
    const snapSource = at.source_id || SOURCE_ID; // snapshots come from the browser tap
    for (const [p, seq] of Object.entries(at.last_seq)) {
      const pkt = idx.get(`${snapSource}#${at.boot_epoch}#${seq}`);
      join.checked += 1;
      if (!pkt || pkt.path !== p || Math.abs(pkt.value - at.last[p]) > 1e-9) {
        if (join.mismatches.length < 10) {
          join.mismatches.push({ t: s.t_mono_ms, path: p, seq, snapshot_value: at.last[p], packet: pkt || null });
        }
      }
    }
  }

  const hygieneOk = rejected === 0 && policyWarns === 0;
  const contractOk = !contract.values.length && !contract.identity.length
    && !contract.order.length && !contract.gaps.length && !contract.rate.length;
  const eventsOk = eventViolations.length === 0;
  const abOk = ab.violations.length === 0;
  const pass = drift.length === 0 && hygieneOk && contractOk && eventsOk
    && abOk && join.mismatches.length === 0;

  const validation = {
    schema: 'audiotap-validation.v1',
    phase: '8A',
    packets: packets.length,
    epochs: byEpoch.size,
    per_path: maxGapStats,
    drift,
    hygiene: { rejected, policy_warns: policyWarns, ok: hygieneOk },
    contract,
    events: { fired: events.length, violations: eventViolations },
    ab,
    join,
    verdict: pass ? 'MATCH' : 'REGRESSION',
    blocks: !pass,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'audiotap-validation.json'), JSON.stringify(validation, null, 2));

  if (!quiet) {
    console.log(`audio tap: ${packets.length} packets over ${byEpoch.size} writer epoch segment(s)`);
    console.log(`  ${(drift.length ? 'REGRESSION' : 'MATCH').padEnd(20)} drift     module table == manifest declarations`);
    console.log(`  ${(hygieneOk ? 'MATCH' : 'REGRESSION').padEnd(20)} hygiene   rejected ${rejected}, policy warns ${policyWarns}`);
    console.log(`  ${(contractOk ? 'MATCH' : 'REGRESSION').padEnd(20)} contract  values/identity/order/gaps/rate `
      + `(${Object.entries(maxGapStats).map(([p, s]) => `${p.split('.').pop()}@${s.rate_hz}Hz`).join(' ')})`);
    if (events.length || eventViolations.length) {
      console.log(`  ${(eventsOk ? 'MATCH' : 'REGRESSION').padEnd(20)} events    ${events.length} fired, ${eventViolations.length} violations`);
    }
    if (ab.compared) {
      console.log(`  ${(abOk ? 'MATCH' : 'REGRESSION').padEnd(20)} A/B       ${ab.compared} shared path(s): `
        + Object.entries(ab.paths).filter(([, s]) => s.p95 != null)
          .map(([p, s]) => `${p.split('.').pop()} p95=${s.p95.toFixed(3)}@${s.lag_ms}ms`).join(' '));
    } else {
      console.log(`  ${'ABSENT'.padEnd(20)} A/B       single writer in this capture`);
    }
    console.log(`  ${(join.mismatches.length ? 'REGRESSION' : 'MATCH').padEnd(20)} join      ${join.checked} snapshot pairs -> packets`);
    console.log(`\nverdict: ${validation.verdict}  (report: ${path.join(outDir, 'audiotap-validation.json')})`);
  }
  return { validation };
}

function main() {
  const args = parseArgs(process.argv);
  const goldenDir = path.resolve(args.dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const outDir = path.resolve(args.out || path.join(goldenDir, 'sims', `audiotap-${stamp}`));
  const { validation } = validateAudioTap({ goldenDir, outDir, quiet: args.quiet });
  process.exit(validation.blocks ? 1 : 0);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`validate-audiotap: ${e.message}`); process.exit(2); }
}

module.exports = { validateAudioTap };
