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

  // ── DRIFT: module table == manifest declarations ────────────────────────
  const moduleSet = new Set(Object.values(PATHS));
  const drift = [];
  for (const p of moduleSet) if (!declared.has(p)) drift.push(`module publishes ${p}: not in the manifest`);
  for (const p of declared.keys()) if (!moduleSet.has(p)) drift.push(`manifest declares ${p}: not in the module table`);

  const golden = loadSession(goldenDir);
  const rx = golden.events.filter((e) => e.kind === 'bus_rx');
  const packets = [];
  let rejected = 0;
  let policyWarns = 0;
  for (const e of rx) {
    rejected += e.rejected || 0;
    policyWarns += e.policy_warns || 0;
    for (const pkt of e.packets || []) {
      const st = pkt && pkt.state;
      if (st && moduleSet.has(st.path)) {
        packets.push({
          t: e.t_mono_ms,
          path: st.path,
          value: st.value && typeof st.value.number === 'number' ? st.value.number : st.value && st.value.integer,
          seq: pkt.source ? pkt.source.seq : null,
          epoch: pkt.source ? pkt.source.bootEpoch : null,
          source: pkt.source ? pkt.source.sourceId : null,
        });
      }
    }
  }

  if (!packets.length) {
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
  const byPath = new Map();
  for (const p of packets) {
    if (p.source !== SOURCE_ID) contract.identity.push({ t: p.t, source: p.source });
    if (typeof p.value !== 'number' || p.value < 0 || p.value > 1
      || Math.abs(p.value * QUANT - Math.round(p.value * QUANT)) > 1e-6) {
      if (contract.values.length < 10) contract.values.push({ t: p.t, path: p.path, value: p.value });
    }
    if (!byPath.has(p.path)) byPath.set(p.path, []);
    byPath.get(p.path).push(p);
  }
  // seq strictly increasing per epoch (across all paths — one counter per page load)
  const byEpoch = new Map();
  for (const p of packets) {
    if (!byEpoch.has(p.epoch)) byEpoch.set(p.epoch, []);
    byEpoch.get(p.epoch).push(p);
  }
  for (const [epoch, list] of byEpoch) {
    let last = -Infinity;
    for (const p of list) {
      if (p.seq <= last && contract.order.length < 10) contract.order.push({ epoch, t: p.t, seq: p.seq, after: last });
      last = Math.max(last, p.seq);
    }
  }
  // keepalive gaps + rate, per path
  const maxGapStats = {};
  for (const [p, list] of byPath) {
    const staleMs = declared.get(p).staleAfterMs || 1000;
    const maxRate = declared.get(p).maxRateHz || 30;
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
    maxGapStats[p] = { packets: list.length, max_gap_ms: Math.round(maxGap), rate_hz: Math.round(hz * 10) / 10 };
  }

  // ── JOIN: snapshots' self-view vs captured packets ──────────────────────
  const idx = new Map(); // `${epoch}#${seq}` -> packet
  for (const p of packets) idx.set(`${p.epoch}#${p.seq}`, p);
  const snaps = golden.events.filter((e) => e.kind === 'browser_snapshot'
    && e.snapshot && e.snapshot.audio_tap && e.snapshot.audio_tap.last_seq);
  const join = { snapshots: snaps.length, checked: 0, mismatches: [] };
  for (const s of snaps) {
    const at = s.snapshot.audio_tap;
    for (const [p, seq] of Object.entries(at.last_seq)) {
      const pkt = idx.get(`${at.boot_epoch}#${seq}`);
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
  const pass = drift.length === 0 && hygieneOk && contractOk && join.mismatches.length === 0;

  const validation = {
    schema: 'audiotap-validation.v1',
    phase: '8A',
    packets: packets.length,
    epochs: byEpoch.size,
    per_path: maxGapStats,
    drift,
    hygiene: { rejected, policy_warns: policyWarns, ok: hygieneOk },
    contract,
    join,
    verdict: pass ? 'MATCH' : 'REGRESSION',
    blocks: !pass,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'audiotap-validation.json'), JSON.stringify(validation, null, 2));

  if (!quiet) {
    console.log(`audio tap: ${packets.length} packets over ${byEpoch.size} page epoch(s)`);
    console.log(`  ${(drift.length ? 'REGRESSION' : 'MATCH').padEnd(20)} drift     module table == manifest declarations`);
    console.log(`  ${(hygieneOk ? 'MATCH' : 'REGRESSION').padEnd(20)} hygiene   rejected ${rejected}, policy warns ${policyWarns}`);
    console.log(`  ${(contractOk ? 'MATCH' : 'REGRESSION').padEnd(20)} contract  values/identity/order/gaps/rate `
      + `(${Object.entries(maxGapStats).map(([p, s]) => `${p.split('.').pop()}@${s.rate_hz}Hz`).join(' ')})`);
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
