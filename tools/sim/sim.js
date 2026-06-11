#!/usr/bin/env node
// Graph simulator (MIGRATION_PLAN.md phase 4 — replay maturity level 2).
//
// manifests + policy + graph -> output + _meta logs, all under VIRTUAL time:
// the capture's t_mono_ms timeline drives the bus clock, the production
// bus-adapter writer discipline (injected clock), and the bus _meta cadence,
// so a 63-minute golden simulates in seconds and two runs produce
// byte-identical logs.
//
// 4A gate (--identity, the default): every mapped path gets an Input->Output
// echo chain publishing back to the same path at incumbent-1 priority. PASS =
// echo stream == input stream packet-for-packet, arbitration keeps every
// incumbent winning, zero rejects, zero policy WARNs.
//
// Usage: node tools/sim/sim.js <golden-session-dir> [--graph FILE] [--out DIR] [--quiet]
// Exit:  0 pass / report-only, 1 gate fail, 2 harness error.

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { loadSession } = require('../replay/capture-io');
const { OrreryBus, fromValue } = require('../../server/src/bus');
const { loadRegistry, applyRegistry } = require('../../server/src/registry');
const attachBusAdapter = require('../../server/src/bus-adapter');
const { VirtualClock, Scheduler } = require('./scheduler');
const { inputEntries, makePump } = require('./pump');
const { compileGraph } = require('./graph');
const { GraphEngine } = require('./engine');
const { identityGraph, injectSimWriter, SIM_SOURCE } = require('./identity');

const MANIFEST_DIR = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest');
const META_TICK_MS = 1000;

function parseArgs(argv) {
  const args = { dir: null, graph: null, out: null, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--graph') args.graph = argv[++i];
    else if (a === '--identity') args.graph = null; // explicit default
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (!args.dir) args.dir = a;
    else throw new Error(`unexpected arg: ${a}`);
  }
  if (!args.dir) throw new Error('usage: sim.js <golden-session-dir> [--graph FILE] [--out DIR] [--quiet]');
  return args;
}

// opts.seeds: [{name, value}] — legacy config values in effect during the
//   capture (e.g. the bridge's near/far defaults the mock sidecar never
//   published), injected as the first pump entries at session start and
//   recorded in the report. The replay-harness analog is goldenEnv().
// opts.collect: [bus paths] -> returned as { collected: { path: [{t, value}] } }
//   so validators get trajectories without re-parsing signals.jsonl.
// opts.graphSourceId: the engine's writer identity (default: the sim identity
//   echo writer; the tape validator passes the real router stableId).
// opts.conditionEntries: optional transform over the input timeline (e.g. the
//   tape validator's source-conditioning mirror of legacy validity guards).
function runSim({ goldenDir, graphJson, identityCheck, outDir, quiet = false,
  seeds = [], collect = [], graphSourceId = SIM_SOURCE, conditionEntries = null }) {
  const golden = loadSession(goldenDir);
  if (golden.badLines) console.warn(`warning: ${golden.badLines} unparseable lines in golden events.jsonl`);
  let entries = inputEntries(golden.events);
  if (conditionEntries) entries = conditionEntries(entries);
  if (!entries.length) throw new Error('golden capture contains no replayable inputs (ingest items / serial_rx pos)');
  fs.mkdirSync(outDir, { recursive: true });

  // Virtual time starts where the capture's monotonic clock did.
  const startT = Math.min(golden.meta.boot_mono_ms || entries[0].t, entries[0].t);
  const clock = new VirtualClock(startT);
  const scheduler = new Scheduler(clock);

  const bus = new OrreryBus({
    nowMono: () => clock.now(),
    bootEpochFile: path.join(outDir, '.boot-epoch'), // fresh per run dir -> deterministic epoch 1
  });
  bus.stop(); // kill the wall-clock _meta interval; the scheduler drives _meta in virtual time

  // Manifests + policy, exactly as the bridge loads them. The identity mode
  // additionally gets the sim-scoped writer overlay (in memory only, reported
  // below); a real graph (e.g. tape-failure) authorizes via the project's own
  // router role — no overlay.
  const registry = loadRegistry(MANIFEST_DIR);
  const overlay = identityCheck ? injectSimWriter(registry) : null;
  applyRegistry(registry, bus);

  const declaredPaths = new Set();
  for (const rec of registry.bySourceId.values()) for (const p of rec.declared.keys()) declaredPaths.add(p);
  const roles = new Map(registry.policy.roles.map((r) => [r.name, r]));

  const compiled = compileGraph(graphJson, { declaredPaths, roles, instanceId: 'sim' });
  if (!compiled.ok) {
    throw new Error(`graph does not compile:\n  - ${compiled.errors.join('\n  - ')}`);
  }

  // ── logging + the identity comparator ────────────────────────────────
  // Subscribed BEFORE the engine so the log preserves bus arrival order
  // (the engine's synchronous echo then lands right after its trigger).
  const signalLines = [];
  const metaLines = [];
  const rejects = { count: 0, sample: [] };
  const pendingEcho = []; // accepted graph-covered inputs awaiting their echo
  const identity = { compared: 0, mismatches: [], extraEchoes: 0 };
  const collectSet = new Set(collect);
  const collected = {};
  for (const p of collectSet) collected[p] = [];

  bus.on('packet', (rec) => {
    const body = rec.pkt.state || rec.pkt.event || {};
    const srcId = rec.pkt.source ? rec.pkt.source.sourceId : '?';
    if (!rec.accepted) {
      rejects.count += 1;
      if (rejects.sample.length < 5) rejects.sample.push({ path: body.path, source: srcId, reasons: rec.reasons });
      return;
    }
    const isMeta = srcId === 'spiffe://pain-material.local/bridge/bus-meta' || (body.path || '').startsWith('_meta.');
    const line = JSON.stringify({
      t: Math.round(clock.now() * 1000) / 1000,
      path: body.path,
      value: fromValue(rec.pkt.state ? body.value : body.payload),
      source: srcId,
      priority: rec.pkt.priority || 0,
      seq: rec.pkt.source ? rec.pkt.source.seq : 0,
    });
    if (isMeta) { metaLines.push(line); return; }
    signalLines.push(line);
    if (rec.pkt.state && collectSet.has(body.path)) {
      collected[body.path].push({ t: clock.now(), value: fromValue(body.value) });
    }

    if (!identityCheck || !rec.pkt.state) return;
    const v = fromValue(body.value);
    if (srcId === graphSourceId) {
      const expected = pendingEcho.shift();
      if (!expected) { identity.extraEchoes += 1; return; }
      identity.compared += 1;
      if (expected.path !== body.path || expected.value !== v) {
        if (identity.mismatches.length < 10) {
          identity.mismatches.push({ t: clock.now(), expected, got: { path: body.path, value: v } });
        } else identity.mismatches.push(null); // count overflow without storing
      }
    } else if (compiled.inputsByPath.has(body.path)) {
      pendingEcho.push({ path: body.path, value: v });
    }
  });

  // ── engine + adapter + pump, wired in bridge order ────────────────────
  const engine = new GraphEngine({ compiled, bus, sourceId: graphSourceId });
  engine.start();

  const inputBus = new EventEmitter();
  const adapter = attachBusAdapter({
    bus,
    inputBus,
    now: () => clock.now(),
    scheduleRepeating: (fn, ms) => scheduler.addRepeating(fn, ms),
  });
  const pump = makePump({ inputBus, clock });

  // Arbitration watch (identity mode): at every virtual-second tick (and once
  // at the end), no resolved STATE winner may be the echo writer while a live
  // incumbent exists — the shadow must shadow. Not meaningful for a real
  // graph, whose sinks (fx.*) have no rival writer to lose to.
  const arbitration = { checks: 0, violations: [] };
  const checkArbitration = () => {
    if (!identityCheck) return;
    for (const [p, entry] of bus.paths) {
      if (p.startsWith('_meta.') || entry.shape !== 'state' || !entry.resolved) continue;
      arbitration.checks += 1;
      if (entry.resolved.sourceId === graphSourceId && arbitration.violations.length < 10) {
        arbitration.violations.push({ t: clock.now(), path: p });
      }
    }
  };
  scheduler.addRepeating(() => { bus._publishMeta(); checkArbitration(); }, META_TICK_MS);

  // ── run ────────────────────────────────────────────────────────────────
  // Seeds fire first, at session start, before any captured entry.
  const t0 = Date.now();
  scheduler.run([
    ...seeds.map((s) => ({ t: startT, run: () => pump.emit(s.name, s.value) })),
    ...entries.map((e) => ({ t: e.t, run: () => pump.emit(e.name, e.value) })),
  ]);
  checkArbitration();
  const wallMs = Date.now() - t0;
  engine.stop();
  adapter.stop();

  // End-of-run shadow visibility: the echo candidates' two-layer status, the
  // exact view the inspector renders for a pre-cutover shadow (doctrine).
  const endStatus = {};
  if (identityCheck) {
    const snap = bus.snapshot();
    for (const [p, view] of Object.entries(snap)) {
      if (p.startsWith('_meta.')) continue;
      const echo = (view.writer_candidates || []).find((c) => c.source_id === graphSourceId);
      if (echo) endStatus[p] = echo.status;
    }
  }

  fs.writeFileSync(path.join(outDir, 'signals.jsonl'), signalLines.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'meta.jsonl'), metaLines.join('\n') + '\n');

  const pumpCounts = pump.counts();
  const identityPass = identityCheck
    && identity.mismatches.length === 0
    && identity.extraEchoes === 0
    && pendingEcho.length === 0
    && rejects.count === 0
    && bus.warnsTotal === 0
    && arbitration.violations.length === 0;

  const report = {
    schema: 'sim-report.v1',
    phase: '4A',
    golden: { dir: golden.dir, session_id: golden.meta.session_id, git_sha: golden.meta.git_sha },
    graph: identityCheck ? 'identity' : 'file',
    graph_nodes: compiled.nodes.size,
    compile_warnings: compiled.warnings,
    registry: {
      modules: registry.bySourceId.size,
      load_warnings: registry.warnings,
      sim_overlay: overlay, // the in-memory role/allowlist grant, declared not hidden
    },
    inputs: {
      capture_events: golden.events.length,
      input_entries: entries.length,
      seeds, // legacy config restored at session start, declared not hidden
      pump_emitted: pumpCounts.emitted,
      pump_deduped: pumpCounts.deduped,
    },
    packets: {
      signals_logged: signalLines.length,
      meta_logged: metaLines.length,
      graph_published: engine.published,
      rejected: rejects.count,
      reject_sample: rejects.sample,
      policy_warns: bus.warnsTotal,
    },
    identity: identityCheck ? {
      compared: identity.compared,
      mismatches: identity.mismatches.filter(Boolean),
      mismatch_count: identity.mismatches.length,
      extra_echoes: identity.extraEchoes,
      missing_echoes: pendingEcho.length,
      pass: identityPass,
    } : null,
    arbitration: {
      checks: arbitration.checks,
      violations: arbitration.violations,
      echo_candidate_status: endStatus,
    },
    virtual_duration_s: Math.round((clock.now() - startT) / 100) / 10,
    wall_ms: wallMs,
    verdict: identityCheck ? (identityPass ? 'MATCH' : 'REGRESSION') : 'REPORT_ONLY',
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  if (!quiet) {
    console.log(`sim: ${entries.length} input entries -> ${pumpCounts.emitted} pump packets `
      + `(${pumpCounts.deduped} deduped), ${engine.published} graph writes, `
      + `${metaLines.length} _meta packets over ${report.virtual_duration_s}s virtual in ${wallMs}ms wall`);
    if (identityCheck) {
      console.log(`  identity: compared ${identity.compared}, mismatches ${identity.mismatches.length}, `
        + `extra ${identity.extraEchoes}, missing ${pendingEcho.length}`);
      console.log(`  arbitration: ${arbitration.checks} checks, ${arbitration.violations.length} violations; `
        + `rejects ${rejects.count}, policy WARNs ${bus.warnsTotal}`);
    }
    console.log(`\nsim verdict: ${report.verdict}  (report: ${path.join(outDir, 'report.json')})`);
  }
  return { report, collected };
}

function main() {
  const args = parseArgs(process.argv);
  const goldenDir = path.resolve(args.dir);
  const identityCheck = !args.graph;
  const graphJson = args.graph
    ? JSON.parse(fs.readFileSync(args.graph, 'utf8'))
    : identityGraph();
  const label = args.graph ? path.basename(args.graph).replace(/\.json$/, '') : 'identity';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const outDir = path.resolve(args.out || path.join(goldenDir, 'sims', `${label}-${stamp}`));

  const { report } = runSim({ goldenDir, graphJson, identityCheck, outDir, quiet: args.quiet });
  process.exit(report.verdict === 'REGRESSION' ? 1 : 0);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`sim: ${e.message}`); process.exit(2); }
}

module.exports = { runSim };
