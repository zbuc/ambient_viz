#!/usr/bin/env node
// Phase 6.1 step-two gate (MIGRATION_PLAN.md): the presence_choreography.v1
// plugin, validated OFFLINE over a golden's timeline. Two lanes:
//
//   A. SEEDED EQUIVALENCE (the strong one — "compare decisions, not dice"):
//      the plugin (hosted: arrival-driven inputs + 250 ms tick + host PRNG)
//      against the FROZEN-SPEC MODEL (tools/sim/presence-legacy-model.js, an
//      independent port of daisy-position's trigger stack), both driven from
//      the SAME bus packets, the same scheduler ticks, the same occupancy
//      graph output, and the same seed. PASS = the note_on decision
//      sequences are EXACTLY equal — same strikes, same channels/notes
//      (timbre + phrase rolls draw from aligned PRNG streams), same virtual
//      times. Any porting slip in either implementation breaks alignment.
//
//   B. CAPTURE LANES (legacy faithfulness): the plugin's fires, classified
//      by reason, against the golden's captured `trigger` events.
//      Deterministic classes — entry bells and exit voices — must correspond
//      in order within ±2500 ms (occupancy edge lag 1500 + legacy tick 500 +
//      slack). Toll/murmur timing is unseeded Math.random in the capture —
//      the stochastic lanes phase 0 declared — so lane B reports their
//      counts as EXPECTED_DIFFERENCE, never gates on them.
//
// The capture's MOTION_PRESENCE mode is auto-detected from entry reasons
// ('entry (motion…' vs 'entry at …cm') and applied to BOTH sides, so lane B
// compares like against like; the kiosk production config is motion ON.
//
// Mode-mismatch declaration: the occupancy GRAPH bakes in the production
// config (motion fusion ON — graphs aren't env-flagged). A capture whose
// legacy ran MOTION_PRESENCE=off used distance-only occupancy, so lane B
// classes that ride bus occupancy (exit_voice; murmur already stochastic)
// diverge BY CONFIG, not by porting — declared EXPECTED_DIFFERENCE when the
// capture has motion traffic legacy ignored (the 63-min mock golden's case:
// legacy cycled ~150 visits, the fused graph held occupied through the
// mock's short motion gaps). Distance-mode entry bells never read occupancy
// and still gate. The ON-mode goldens and the kiosk session carry the
// binding occupancy-dependent proof.
//
// Usage: node tools/sim/validate-presence.js <golden-session-dir> [--out DIR] [--quiet]
// Exit:  0 = MATCH, 1 = blocked (REGRESSION/UNKNOWN), 2 = harness error.

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { loadSession } = require('../replay/capture-io');
const { OrreryBus } = require('../../server/src/bus');
const { loadRegistry, applyRegistry } = require('../../server/src/registry');
const attachBusAdapter = require('../../server/src/bus-adapter');
const { compileGraph } = require('../../server/src/router-graph');
const { GraphEngine } = require('../../server/src/router-engine');
const { createPluginHost, mulberry32 } = require('../../server/src/plugin-host');
const { VirtualClock, Scheduler } = require('./scheduler');
const { inputEntries, makePump } = require('./pump');
const { createPresenceModel } = require('./presence-legacy-model');

const MANIFEST_DIR = path.resolve(__dirname, '..', '..', 'projects', 'pain-material', 'manifest');
const OCC_SOURCE = 'spiffe://pain-material.local/bridge/router-occupancy';
const HOST_TICK_MS = 250;
const META_TICK_MS = 1000;
const LANE_B_WINDOW_MS = 2500; // declared: occupancy edge lag 1500 + legacy tick 500 + slack

const INPUT_PATHS = {
  occupied: 'derived.room.occupied',
  distance_cm: 'sensor.door.distance_cm',
  velocity_cm_s: 'sensor.door.velocity_cm_s',
  far_cm: 'sensor.door.far_cm',
  motion: 'sensor.room.motion',
};

const classify = (what, reason) => {
  if ((what === 'bell' || what === 'industrial') && /^entry/.test(reason || '')) return 'entry';
  if (what === 'voice' && /^room emptied/.test(reason || '')) return 'exit_voice';
  if (/^toll/.test(reason || '')) return 'toll';
  if (reason === 'active room') return 'murmur';
  return 'other';
};

function parseArgs(argv) {
  const args = { dir: null, out: null, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (!args.dir) args.dir = a;
    else throw new Error(`unexpected arg: ${a}`);
  }
  if (!args.dir) throw new Error('usage: validate-presence.js <golden-session-dir> [--out DIR] [--quiet]');
  return args;
}

function validatePresence({ goldenDir, outDir, quiet = false }) {
  const golden = loadSession(goldenDir);
  const entries = inputEntries(golden.events);
  if (!entries.length) throw new Error('golden capture contains no replayable inputs');
  const startT = Math.min(golden.meta.boot_mono_ms || entries[0].t, entries[0].t);

  // Capture-side mode detection: which bell path did legacy run?
  const capTriggers = golden.events.filter((e) => e.kind === 'trigger')
    .map((e) => ({ t: e.t_mono_ms, what: e.what, reason: e.reason || '', class: classify(e.what, e.reason || '') }));
  const sawMotionEntry = capTriggers.some((e) => /^entry \(motion/.test(e.reason));
  const sawDistanceEntry = capTriggers.some((e) => /^entry at /.test(e.reason));
  const bindingJson = JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, 'plugins', 'presence.json'), 'utf8'));
  let motionPresence = (bindingJson.binding.params.motion_presence ?? 1) >= 0.5;
  if (sawDistanceEntry && !sawMotionEntry) motionPresence = false;
  else if (sawMotionEntry) motionPresence = true;
  const seed = bindingJson.seed;

  // ── harness: clock, bus, registry, occupancy graph, host, model, adapter ──
  const clock = new VirtualClock(startT);
  const scheduler = new Scheduler(clock);
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'presence-gate-'));
  const bus = new OrreryBus({ nowMono: () => clock.now(), bootEpochFile: path.join(tmp, 'epoch') });
  bus.stop();
  const registry = loadRegistry(MANIFEST_DIR);
  applyRegistry(registry, bus);
  const declared = new Map();
  for (const rec of registry.bySourceId.values()) for (const [p, d] of rec.declared) declared.set(p, d);
  const roles = new Map(registry.policy.roles.map((r) => [r.name, r]));

  // The occupancy graph feeds BOTH sides (the post-rebind world).
  const occJson = JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, 'graphs', 'occupancy.json'), 'utf8'));
  const occCompiled = compileGraph(occJson, { declaredPaths: new Set(declared.keys()), roles, instanceId: 'occupancy' });
  if (!occCompiled.ok) throw new Error(`occupancy graph does not compile: ${occCompiled.errors.join('; ')}`);
  const occEngine = new GraphEngine({ compiled: occCompiled, bus, sourceId: OCC_SOURCE });
  occEngine.start();

  // Plugin under test — the real binding file, with the capture-matched
  // motion_presence and the recorded seed.
  const pluginFires = []; // {t, ch, note, vel} from note_on; what/reason joined from debug
  const pluginDebug = [];
  const host = createPluginHost({
    bus,
    bindings: [{
      file: 'presence.json',
      json: { ...bindingJson, binding: { ...bindingJson.binding, params: { ...bindingJson.binding.params, motion_presence: motionPresence ? 1 : 0 } } },
    }],
    declared, roles,
    tickMs: HOST_TICK_MS,
    scheduleRepeating: (fn, ms) => scheduler.addRepeating(fn, ms),
    tap: (instance, p, payload) => {
      if (p === 'seq.presence.note_on') pluginFires.push({ t: clock.now(), ch: payload[0], note: payload[1], vel: payload[2] });
      else if (p === 'seq.presence.debug') pluginDebug.push({ t: clock.now(), ...JSON.parse(payload) });
    },
  });
  if (host.failures.length) throw new Error(`presence binding failed: ${JSON.stringify(host.failures)}`);

  // Frozen-spec model: same packets, same resolved values, same tick cadence,
  // same seed, own PRNG stream.
  const modelFires = [];
  const model = createPresenceModel({
    rand: mulberry32(seed).rand,
    emit: (e) => modelFires.push(e),
    motionPresence,
  });
  const pathToPort = new Map(Object.entries(INPUT_PATHS).map(([port, p]) => [p, port]));
  bus.on('packet', (rec) => {
    if (!rec.accepted || !rec.pkt.state) return;
    const port = pathToPort.get(rec.pkt.state.path);
    if (!port) return;
    const entry = bus.paths.get(rec.pkt.state.path);
    if (!entry || !entry.resolved) return;
    model.onState(port, entry.resolved.value, clock.now());
  });
  // Mirror the host's late-joiner priming (path-sorted retained delivery).
  for (const p of [...pathToPort.keys()].sort()) {
    const entry = bus.paths.get(p);
    if (entry && entry.shape === 'state' && entry.resolved) model.onState(pathToPort.get(p), entry.resolved.value, clock.now());
  }
  scheduler.addRepeating(() => model.tick(clock.now()), HOST_TICK_MS);
  scheduler.addRepeating(() => bus._publishMeta(), META_TICK_MS);

  const inputBus = new EventEmitter();
  const adapter = attachBusAdapter({
    bus, inputBus,
    now: () => clock.now(),
    scheduleRepeating: (fn, ms) => scheduler.addRepeating(fn, ms),
  });
  const pump = makePump({ inputBus, clock });
  scheduler.run(entries.map((e) => ({ t: e.t, run: () => pump.emit(e.name, e.value) })));
  const hostView = host.inspect()[0];
  host.stop();
  occEngine.stop();
  adapter.stop();

  // ── lane A: exact seeded equivalence, plugin vs model ──────────────────
  const fires = pluginDebug.filter((d) => d.kind === 'fire');
  const laneAMismatches = [];
  const nA = Math.max(modelFires.length, pluginFires.length);
  for (let i = 0; i < nA && laneAMismatches.length < 10; i++) {
    const m = modelFires[i];
    const p = pluginFires[i];
    const d = fires[i];
    if (!m || !p || m.t !== p.t || m.ch !== p.ch || m.note !== p.note || m.vel !== p.vel
        || !d || d.what !== m.what) {
      laneAMismatches.push({ index: i, model: m || null, plugin: p ? { ...p, what: d && d.what } : null });
    }
  }
  const laneA = {
    model_fires: modelFires.length,
    plugin_fires: pluginFires.length,
    mismatches: laneAMismatches,
    pass: modelFires.length === pluginFires.length && laneAMismatches.length === 0,
  };

  // ── lane B: deterministic classes vs the capture ───────────────────────
  const pluginByClass = (cls) => fires.filter((f) => classify(f.what, f.reason) === cls);
  const capByClass = (cls) => capTriggers.filter((e) => e.class === cls);
  // Occupancy-mode mismatch (see header): legacy ran distance-only while the
  // graph fuses motion the capture carried — occupancy-dependent classes are
  // declared, not gated.
  const hasMotionTraffic = entries.some((e) => e.name === 'motion');
  const occupancyModeMismatch = !motionPresence && hasMotionTraffic;
  const laneB = { window_ms: LANE_B_WINDOW_MS, occupancy_mode_mismatch: occupancyModeMismatch, classes: {}, pass: true };
  for (const cls of ['entry', 'exit_voice']) {
    const cap = capByClass(cls);
    const plg = pluginByClass(cls);
    if (cls === 'exit_voice' && occupancyModeMismatch) {
      laneB.classes[cls] = {
        capture: cap.length, plugin: plg.length,
        verdict: 'EXPECTED_DIFFERENCE',
        note: 'capture legacy ran MOTION_PRESENCE=off (distance-only occupancy); the graph fuses motion — config mismatch, declared',
      };
      continue;
    }
    const mismatches = [];
    const n = Math.max(cap.length, plg.length);
    for (let i = 0; i < n && mismatches.length < 10; i++) {
      const a = cap[i];
      const b = plg[i];
      if (!a || !b || Math.abs(a.t - b.t) > LANE_B_WINDOW_MS) mismatches.push({ index: i, capture: a || null, plugin: b || null });
    }
    const pass = cap.length === plg.length && mismatches.length === 0;
    laneB.classes[cls] = { capture: cap.length, plugin: plg.length, mismatches, verdict: pass ? 'MATCH' : 'REGRESSION' };
    if (!pass) laneB.pass = false;
  }
  for (const cls of ['toll', 'murmur']) {
    laneB.classes[cls] = {
      capture: capByClass(cls).length,
      plugin: pluginByClass(cls).length,
      verdict: 'EXPECTED_DIFFERENCE', // unseeded Math.random in the capture (phase-0 declared lanes)
    };
  }

  const hygiene = {
    crashed: hostView.crashed,
    publish_rejects: hostView.publish_rejects,
    nonfinite: hostView.nonfinite_quarantined,
    policy_warns: bus.warnsTotal,
    arrivals: hostView.arrivals,
    ok: !hostView.crashed && hostView.publish_rejects === 0 && hostView.nonfinite_quarantined === 0 && bus.warnsTotal === 0,
  };

  const verdict = laneA.pass && laneB.pass && hygiene.ok ? 'MATCH' : 'REGRESSION';
  const validation = {
    schema: 'presence-validation.v1',
    phase: '6.1-step-2',
    seed,
    motion_presence: motionPresence,
    mode_detection: { sawMotionEntry, sawDistanceEntry },
    lane_a_seeded_equivalence: laneA,
    lane_b_capture: laneB,
    hygiene,
    debug_events: pluginDebug.length,
    verdict,
    blocks: verdict !== 'MATCH',
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'presence-validation.json'), JSON.stringify(validation, null, 2));
  fs.writeFileSync(path.join(outDir, 'fires.jsonl'),
    fires.map((f, i) => JSON.stringify({ ...pluginFires[i], what: f.what, reason: f.reason })).join('\n') + '\n');

  if (!quiet) {
    console.log(`presence plugin: ${pluginFires.length} fires (${hostView.arrivals} arrivals, ${pluginDebug.length} debug events), `
      + `motion_presence ${motionPresence ? 'ON' : 'OFF'} (detected), seed ${seed}`);
    console.log(`  ${(laneA.pass ? 'MATCH' : 'REGRESSION').padEnd(20)} lane A seeded equivalence: `
      + `${laneA.plugin_fires} plugin = ${laneA.model_fires} model fires`
      + (laneAMismatches.length ? `  first: ${JSON.stringify(laneAMismatches[0])}` : ', draw-for-draw'));
    for (const [cls, r] of Object.entries(laneB.classes)) {
      console.log(`  ${r.verdict.padEnd(20)} lane B ${cls.padEnd(11)} capture ${r.capture} vs plugin ${r.plugin}`
        + (r.mismatches && r.mismatches.length ? `  first: ${JSON.stringify(r.mismatches[0])}` : ''));
    }
    console.log(`  ${(hygiene.ok ? 'OK' : 'VIOLATED').padEnd(20)} hygiene: rejects ${hygiene.publish_rejects}, warns ${hygiene.policy_warns}, crashed ${!!hygiene.crashed}`);
    console.log(`\nverdict: ${verdict}  (report: ${path.join(outDir, 'presence-validation.json')})`);
  }
  return { validation };
}

function main() {
  const args = parseArgs(process.argv);
  const goldenDir = path.resolve(args.dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const outDir = path.resolve(args.out || path.join(goldenDir, 'sims', `presence-${stamp}`));
  const { validation } = validatePresence({ goldenDir, outDir, quiet: args.quiet });
  process.exit(validation.blocks ? 1 : 0);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`validate-presence: ${e.message}`); process.exit(2); }
}

module.exports = { validatePresence };
