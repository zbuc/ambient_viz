#!/usr/bin/env node
// Phase-6.0 plugin-host gate (MIGRATION_PLAN.md): prove REPLAY and
// SNAPSHOT/RESTORE for the hosted plugin instances under the graph
// simulator's virtual clock, with the production manifests + policy live.
//
// Three legs over one golden capture's timeline:
//
//   A. REPLAY — run the full timeline twice from scratch (fresh bus, fresh
//      host, same bindings/seeds). PASS = the two emission logs are
//      BYTE-IDENTICAL (same fires, same payloads, same virtual timestamps).
//      Stochastic choreography that doesn't reproduce under the recorded
//      seed is exactly the bug class this gate exists to block before 6.1.
//
//   B. RESUME — run leg A's timeline again, but at the midpoint snapshot
//      every instance, THROW THE HOST AWAY, build a fresh one (deliberately
//      booted with a wrong seed), restore the snapshots, and continue. PASS
//      = the tail emissions equal leg A's tail exactly: the snapshot carries
//      the full state, PRNG stream included. (The host tick keeps its phase
//      across the swap — the timer belongs to the harness, not the host —
//      so this isolates state capture from scheduling.)
//
//   C. HYGIENE — across all legs: zero binding failures, zero crashes, zero
//      publish rejects, zero policy WARNs, zero event-queue drops on the
//      plugins' output paths.
//
// The golden's captured inputs are pumped through the production bus-adapter
// while the host runs, so the bus carries a real session's traffic — the
// gate proves the host alongside everything else, not in a vacuum.
//
// Usage: node tools/sim/validate-plugin.js <golden-session-dir> [--out DIR] [--quiet]
// Exit:  0 MATCH, 1 REGRESSION, 2 harness error.

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { loadSession } = require('../replay/capture-io');
const { OrreryBus } = require('../../server/src/bus');
const { loadRegistry, applyRegistry } = require('../../server/src/registry');
const attachBusAdapter = require('../../server/src/bus-adapter');
const { createPluginHost, loadBindingDir, HOST_TICK_MS } = require('../../server/src/plugin-host');
const { VirtualClock, Scheduler } = require('./scheduler');
const { inputEntries, makePump } = require('./pump');

const MANIFEST_DIR = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest');
const META_TICK_MS = 1000;

function parseArgs(argv) {
  const args = { dir: null, out: null, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (!args.dir) args.dir = a;
    else throw new Error(`unexpected arg: ${a}`);
  }
  if (!args.dir) throw new Error('usage: validate-plugin.js <golden-session-dir> [--out DIR] [--quiet]');
  return args;
}

// One full virtual-time pass over the golden. opts.swapAtMs: snapshot every
// instance at that virtual time, rebuild the host (seed deliberately
// perturbed), restore, continue — the leg-B resume. Returns
// { emissions, hygiene } where emissions are [{t, instance, path, payload}].
function runLeg({ golden, entries, startT, bindings, swapAtMs = null }) {
  const clock = new VirtualClock(startT);
  const scheduler = new Scheduler(clock);
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'plugin-gate-'));
  const bus = new OrreryBus({ nowMono: () => clock.now(), bootEpochFile: path.join(tmp, 'epoch') });
  bus.stop(); // _meta runs on the scheduler, in virtual time

  const registry = loadRegistry(MANIFEST_DIR);
  applyRegistry(registry, bus);
  const declared = new Map();
  for (const rec of registry.bySourceId.values()) for (const [p, d] of rec.declared) declared.set(p, d);
  const roles = new Map(registry.policy.roles.map((r) => [r.name, r]));

  const emissions = [];
  const rejects = [];
  bus.on('packet', (rec) => {
    if (!rec.accepted) {
      const body = rec.pkt.state || rec.pkt.event || {};
      if ((body.path || '').startsWith('seq.')) rejects.push({ t: clock.now(), path: body.path, reasons: rec.reasons });
    }
  });

  // The tick timer belongs to the HARNESS, through a mutable ref, so a leg-B
  // host swap keeps the tick phase — resume must prove state capture, not
  // accidental re-phasing.
  const hostRef = { current: null };
  scheduler.addRepeating(() => { if (hostRef.current) hostRef.current.tickOnce(); }, HOST_TICK_MS);
  scheduler.addRepeating(() => bus._publishMeta(), META_TICK_MS);

  const makeHost = (bnds) => createPluginHost({
    bus, bindings: bnds, declared, roles,
    scheduleRepeating: () => () => {}, // driven by the harness timer above
    tap: (instance, p, payload) => emissions.push({ t: clock.now(), instance, path: p, payload }),
  });
  hostRef.current = makeHost(bindings);
  if (hostRef.current.failures.length) {
    throw new Error(`bindings failed to load: ${JSON.stringify(hostRef.current.failures)}`);
  }

  const inputBus = new EventEmitter();
  const adapter = attachBusAdapter({
    bus, inputBus,
    now: () => clock.now(),
    scheduleRepeating: (fn, ms) => scheduler.addRepeating(fn, ms),
  });
  const pump = makePump({ inputBus, clock });

  const timeline = entries.map((e) => ({ t: e.t, run: () => pump.emit(e.name, e.value) }));
  let swapped = null;
  if (swapAtMs !== null) {
    const before = timeline.filter((e) => e.t <= swapAtMs);
    const after = timeline.filter((e) => e.t > swapAtMs);
    scheduler.run(before);
    // Snapshot, discard the host, rebuild with WRONG seeds, restore.
    const snaps = hostRef.current.instances.map((i) => hostRef.current.snapshotInstance(i.name));
    hostRef.current.stop();
    const perturbed = bindings.map((b) => ({ ...b, json: { ...b.json, seed: (b.json.seed + 1) >>> 0 } }));
    hostRef.current = makeHost(perturbed);
    for (const s of snaps) hostRef.current.restoreInstance(s.instance, s);
    swapped = { at: clock.now(), instances: snaps.map((s) => s.instance) };
    scheduler.run(after);
  } else {
    scheduler.run(timeline);
  }

  const views = hostRef.current.inspect();
  const queueDrops = {};
  for (const inst of hostRef.current.instances) {
    for (const [, out] of inst.outputs) {
      const entry = bus.paths.get(out.path);
      if (entry && entry.shape === 'event') queueDrops[out.path] = entry.drops;
    }
  }
  hostRef.current.stop();
  adapter.stop();

  return {
    emissions,
    swapped,
    hygiene: {
      failures: 0,
      crashes: views.filter((v) => v.crashed).map((v) => v.instance),
      publish_rejects: views.reduce((a, v) => a + v.publish_rejects, 0),
      nonfinite: views.reduce((a, v) => a + v.nonfinite_quarantined, 0),
      seq_rejects: rejects,
      policy_warns: bus.warnsTotal,
      queue_drops: queueDrops,
      ticks: views.map((v) => ({ instance: v.instance, ticks: v.ticks, emitted: v.emitted })),
    },
  };
}

function main() {
  const args = parseArgs(process.argv);
  const goldenDir = path.resolve(args.dir);
  const golden = loadSession(goldenDir);
  const entries = inputEntries(golden.events);
  if (!entries.length) throw new Error('golden capture contains no replayable inputs');
  const startT = Math.min(golden.meta.boot_mono_ms || entries[0].t, entries[0].t);
  const endT = entries[entries.length - 1].t;
  const midT = startT + (endT - startT) / 2;

  const { bindings, failures } = loadBindingDir(path.join(MANIFEST_DIR, 'plugins'));
  if (failures.length) throw new Error(`plugin dir failures: ${JSON.stringify(failures)}`);
  if (!bindings.length) throw new Error('no plugin bindings to validate');

  const legA1 = runLeg({ golden, entries, startT, bindings });
  const legA2 = runLeg({ golden, entries, startT, bindings });
  const legB = runLeg({ golden, entries, startT, bindings, swapAtMs: midT });

  const key = (e) => JSON.stringify(e);
  const replayIdentical = JSON.stringify(legA1.emissions) === JSON.stringify(legA2.emissions);
  const tailA = legA1.emissions.filter((e) => e.t > midT).map(key);
  const tailB = legB.emissions.filter((e) => e.t > midT).map(key);
  const resumeIdentical = JSON.stringify(tailA) === JSON.stringify(tailB);

  const hygieneOk = [legA1, legA2, legB].every((l) =>
    l.hygiene.crashes.length === 0
    && l.hygiene.publish_rejects === 0
    && l.hygiene.nonfinite === 0
    && l.hygiene.seq_rejects.length === 0
    && l.hygiene.policy_warns === 0
    && Object.values(l.hygiene.queue_drops).every((d) => d === 0));
  // A gate over a session with zero plugin traffic proves nothing — fail loud.
  const trafficOk = legA1.emissions.length > 0 && tailA.length > 0;

  const verdict = replayIdentical && resumeIdentical && hygieneOk && trafficOk ? 'MATCH' : 'REGRESSION';

  const report = {
    schema: 'plugin-gate.v1',
    golden: { dir: golden.dir, session_id: golden.meta.session_id, git_sha: golden.meta.git_sha },
    bindings: bindings.map((b) => ({ file: b.file, instance: b.json.instance, asset: b.json.binding.asset, seed: b.json.seed })),
    virtual_duration_s: Math.round((endT - startT) / 100) / 10,
    replay: {
      runs: 2,
      emissions: legA1.emissions.length,
      identical: replayIdentical,
    },
    resume: {
      swap_at_virtual_ms: midT,
      swapped: legB.swapped,
      tail_emissions: tailA.length,
      identical: resumeIdentical,
    },
    hygiene: { a1: legA1.hygiene, a2: legA2.hygiene, b: legB.hygiene, ok: hygieneOk },
    traffic_ok: trafficOk,
    verdict,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const outDir = path.resolve(args.out || path.join(goldenDir, 'sims', `plugin-gate-${stamp}`));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'emissions.jsonl'),
    legA1.emissions.map((e) => JSON.stringify(e)).join('\n') + '\n');

  if (!args.quiet) {
    console.log(`plugin gate: ${entries.length} golden inputs over ${report.virtual_duration_s}s virtual; `
      + `${legA1.emissions.length} emissions from ${bindings.length} instance(s)`);
    console.log(`  replay:  2 runs ${replayIdentical ? 'BYTE-IDENTICAL' : 'DIVERGED'}`);
    console.log(`  resume:  host swapped at ${Math.round(midT - startT) / 1000}s, tail ${tailA.length} emissions `
      + `${resumeIdentical ? 'IDENTICAL' : 'DIVERGED'}`);
    console.log(`  hygiene: crashes/rejects/WARNs/drops ${hygieneOk ? 'all zero' : 'VIOLATED — see report'}`);
    console.log(`\nplugin gate verdict: ${verdict}  (report: ${path.join(outDir, 'report.json')})`);
  }
  process.exit(verdict === 'MATCH' ? 0 : 1);
}

try { main(); } catch (e) { console.error(`validate-plugin: ${e.message}`); process.exit(2); }
