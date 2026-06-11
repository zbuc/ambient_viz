// Plugin host (MIGRATION_PLAN.md phase 6.0) — the bridge-side runtime for
// plugin.v1 code assets.
//
// plugin.v1 (PLUGIN_CONTRACT.md, proto/plugin.proto) is the WIRING contract;
// runtime lifecycle is explicitly a host-API concern. This file is that host
// API for the bridge (the JS execution target). What it provides — the five
// things the phase-6.0 toy plugin must prove end to end:
//
//   - HOST TICK: one scheduler (injectable, like bus-adapter's keepalive) at
//     HOST_TICK_MS drives every instance whose manifest declares
//     requires_host_tick. Time comes from bus.nowMono() — the one clock the
//     simulator already drives virtually, so plugin time is deterministic
//     under replay for free (same trick as the graph engine's Smooth).
//   - SEEDED PRNG: each instance gets a host-owned mulberry32 stream, seeded
//     from its binding file. Plugins take randomness ONLY from ctx.rand —
//     never wall-clock or Math.random (the contract's replayability clause).
//     The PRNG state is part of the host snapshot, so replay-resume continues
//     the random stream bit-exactly.
//   - SNAPSHOT/RESTORE: snapshotInstance() captures {plugin state, PRNG
//     state}; restoreInstance() rebuilds both on a fresh instance. Valid
//     within one clock domain (plugin timers hold host-clock timestamps);
//     cross-boot restore is reinit — plugin.v1 promises nothing more.
//   - REPLAY: with a virtual clock + scheduler (tools/sim), same bindings +
//     same seed + same timeline -> byte-identical emissions. The gate is
//     tools/sim/validate-plugin.js.
//   - CANDIDATE-PATH INSPECTION: every emission is published as an ordinary
//     bus packet (visible on /bus/events and in the bus snapshot), tapped to
//     the capture (`plugin_tx`), and kept in a per-instance ring served by
//     /plugins/state. Until a real consumer binds (the 6.1 comparator, then
//     the cutover adapter), the host's inspection ring is the DECLARED
//     drainer of its own EVENT output queues — bus queues are
//     single-consumer, and leaving them undrained would count overflow drops
//     that read as faults. When 6.1 attaches a real consumer, it takes the
//     drain over and the ring switches to recording emissions only.
//
// Instantiation config: one JSON file per instance under
// manifest/plugins/ (the per-mapping ship/cut/delete doctrine, same as
// graphs/). Each file carries a router.v1 PluginBinding — validated through
// the generated codec — wrapped in the host's instantiation envelope
// (instance name, seed, authority role, publish priority): the fields the
// contract assigns to instantiation, not to the schema.
//
// Scope, stated rather than implied (each limit is a loud error, never a
// silent fallback):
//   - execution target is the bridge: outputs must be dest=BUS (no emitter,
//     no member outputs until a render host exists);
//   - rate_domain must be RATE_CONTROL — requires_host_tick is exactly the
//     "autonomous time without a tick domain" case ROUTER_IR.md routes to a
//     plugin's host tick; render/audio/musical domains arrive with the hosts
//     that have those clocks;
//   - determinism must be REPLAYABLE (or unspecified, which defaults to it):
//     REALTIME_ONLY/EXTERNAL_IO assets are quarantined from this host until
//     a phase needs them;
//   - member_needs must be empty (no groups yet);
//   - STATE inputs read the bus's arbitrated RESOLVED value (the 4C/4D rule:
//     never packet payloads); EVENT inputs receive the drained queue since
//     the last invocation — possibly empty, possibly several, never a
//     collapsed latest (the contract's no-coalescing clause).
//   - ARRIVAL-DRIVEN DELIVERY (phase 6.1, Chris's ruling): a plugin that
//     implements onInput(port, value, ctx) is additionally invoked
//     SYNCHRONOUSLY on every accepted STATE packet for a bound input port,
//     in bus arrival order, with the post-packet RESOLVED value — the same
//     activation rule as the graph engine. This exists because choreography
//     like the bell's consecutive-fresh-sample approach gate counts SAMPLES;
//     a 250 ms ZOH tick would collapse sensor bursts and count differently
//     than the legacy onChange path. The tick still drives self-scheduled
//     time; onInput never fires for the host's own publishes.
//
// Crash discipline (contract: a crash drops outputs to failsafe): a throwing
// tick disables the instance — EVENT outputs simply stop; STATE outputs are
// RELEASED so arbitration falls to other writers/HOLD (the closest honest
// approximation until manifests carry per-sink failsafe values). Non-finite
// numeric emissions are quarantined and counted (rule-13 posture), not
// published. Stall/overrun watchdogs are meaningless under a virtual clock
// and arrive with the render host's frame budgets (phase 8).

'use strict';

const fs = require('fs');
const path = require('path');

const pluginGen = require('./gen/plugin');
const routerGen = require('./gen/router');
const { fromValue } = require('./bus');
const { globToRegex } = require('./registry');

const HOST_TICK_MS = 250;
const EMIT_RING_MAX = 20;

// generated enum numbers (gen/common, gen/plugin)
const RATE_CONTROL = 1;
const SHAPE_STATE = 1;
const SHAPE_EVENT = 2;
const DEST_BUS = 2;
const DETERMINISM_OK = new Set([0, 1]); // UNSPECIFIED (-> REPLAYABLE) | REPLAYABLE

// ── seeded PRNG (mulberry32) ────────────────────────────────────────────────
// 32-bit state, fully capturable: state() / setState() are what make
// snapshot/restore continue the random stream bit-exactly.
function mulberry32(seed) {
  let s = seed >>> 0;
  return {
    rand() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    state: () => s,
    setState(v) { s = v >>> 0; },
  };
}

// ── asset registry ──────────────────────────────────────────────────────────
// asset.vN -> { manifest (codec-validated), create }. One contract, many
// impls is the eventual shape; this registry holds the bridge's JS impls.
function builtinAssets() {
  const modules = [require('./plugins/toy-timer'), require('./plugins/presence-choreography')];
  const assets = new Map();
  for (const mod of modules) {
    const manifest = pluginGen.PluginManifest.fromJSON(mod.manifest); // schema-of-record validation
    if (manifest.schemaVersion !== 'plugin.v1') {
      throw new Error(`asset ${manifest.asset}: schema_version "${manifest.schemaVersion}" != "plugin.v1"`);
    }
    if (typeof mod.create !== 'function') throw new Error(`asset ${manifest.asset}: no create()`);
    assets.set(`${manifest.asset}.v${manifest.version}`, { manifest, create: mod.create });
  }
  return assets;
}

// One instantiation file per instance (manifest/plugins/*.json), sorted —
// deterministic load and tick order, one broken file never blocks the rest.
function loadBindingDir(dir) {
  const bindings = [];
  const failures = [];
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (e) {
    return { bindings, failures: [{ file: path.basename(dir), errors: [`plugin dir unreadable: ${e.message}`] }] };
  }
  for (const file of files) {
    try {
      bindings.push({ file, json: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) });
    } catch (e) {
      failures.push({ file, errors: [e.message] });
    }
  }
  return { bindings, failures };
}

// Validate one instantiation envelope + its PluginBinding against the asset
// manifest — the host-side mirror of PLUGIN_CONTRACT.md "Compiler validation"
// (inputs / params / member context / outputs / version / placement & rate).
// declared: Map(bus path -> SignalDeclaration) from the module registry;
// roles: Map(name -> policy role). Returns { errors, warnings, resolved }.
function validateBinding(json, { assets, declared = null, roles = null, instanceId = '' }) {
  const errors = [];
  const warnings = [];

  const instance = json.instance;
  if (!instance || typeof instance !== 'string') errors.push('missing "instance" name');
  const seed = json.seed;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    errors.push('seed must be an integer in [0, 2^32) — the seed is part of instantiation and lands in golden fixtures');
  }

  let binding;
  try {
    binding = routerGen.PluginBinding.fromJSON(json.binding || {});
  } catch (e) {
    return { errors: [`binding does not parse as router.v1 PluginBinding: ${e.message}`], warnings };
  }

  // rule 5 — version resolution: a missing/incompatible asset is a load
  // error, not a runtime surprise.
  const asset = assets.get(binding.asset);
  if (!asset) {
    errors.push(`asset "${binding.asset}" is not registered on this host (known: ${[...assets.keys()].join(', ') || 'none'})`);
    return { errors, warnings };
  }
  const m = asset.manifest;

  // placement & rate (rule 6).
  if (m.rateDomain !== RATE_CONTROL) {
    errors.push(`asset ${binding.asset}: rate_domain ${m.rateDomain} is not schedulable on the bridge host (RATE_CONTROL only; tick-clock hosts arrive with the phase that needs them)`);
  }
  if (!DETERMINISM_OK.has(m.determinism)) {
    errors.push(`asset ${binding.asset}: determinism ${m.determinism} is quarantined from this host (REPLAYABLE only — golden traces are the regression suite)`);
  }
  // member context (rule 3): no groups exist yet.
  if (m.memberNeeds && m.memberNeeds.length) {
    errors.push(`asset ${binding.asset}: member_needs requires a Replicated group context (not implemented)`);
  }

  // inputs (rule 1): every key declared, types/shapes match, required bound,
  // extra keys are an error. Host bindings bind BUS PATHS (node ids only
  // exist inside a router graph).
  const inputPorts = new Map(m.inputs.map((p) => [p.name, p]));
  for (const [name, src] of Object.entries(binding.inputs || {})) {
    const port = inputPorts.get(name);
    if (!port) { errors.push(`input "${name}" is not a declared port of ${binding.asset}`); continue; }
    if (declared) {
      const d = declared.get(src);
      if (!d) warnings.push(`input "${name}": path ${src} is not declared in any module manifest`);
      else {
        if (d.valueType && port.valueType && d.valueType !== port.valueType) {
          errors.push(`input "${name}": path ${src} valueType ${d.valueType} != port ${port.valueType}`);
        }
        if (d.shape && port.shape && d.shape !== port.shape) {
          errors.push(`input "${name}": path ${src} shape ${d.shape} != port ${port.shape}`);
        }
      }
    }
    if (src.startsWith('_meta.')) errors.push(`input "${name}": the _meta domain is never a plugin source`);
  }
  for (const port of m.inputs) {
    if (port.required && !(binding.inputs && binding.inputs[port.name])) {
      errors.push(`required input "${port.name}" is not bound`);
    }
  }

  // params (rule 2): every key declared, within range, no-default params set.
  // (router.v1 PluginBinding params are doubles; enum/text params are
  // un-bindable through it by design — a contract gap to revisit only if an
  // asset ever needs one.)
  const paramDecls = new Map(m.params.map((p) => [p.name, p]));
  const params = {};
  for (const [name, v] of Object.entries(binding.params || {})) {
    const decl = paramDecls.get(name);
    if (!decl) { errors.push(`param "${name}" is not declared by ${binding.asset}`); continue; }
    if (!Number.isFinite(v)) errors.push(`param "${name}" must be finite`);
    else if (decl.range && (v < decl.range.min || v > decl.range.max)) {
      errors.push(`param "${name}"=${v} outside [${decl.range.min}, ${decl.range.max}]`);
    }
    params[name] = v;
  }
  for (const decl of m.params) {
    if (params[decl.name] !== undefined) continue;
    const dflt = decl.default ? fromValue(decl.default) : undefined;
    if (dflt === undefined) errors.push(`param "${decl.name}" has no default and is not set`);
    else params[decl.name] = dflt;
  }

  // outputs (rule 4): bridge host = BUS outputs only, authorized like any
  // writer (the graph compiler's rule-8 analog: role + priority ceiling).
  const priority = json.priority || 0;
  const role = roles ? roles.get(json.authorityRole) : null;
  if (roles) {
    if (!json.authorityRole) errors.push('missing "authorityRole" (outputs publish like any writer)');
    else if (!role) errors.push(`authorityRole "${json.authorityRole}" is not a known policy role`);
    else if (priority > role.maxPriority) {
      errors.push(`priority ${priority} exceeds role "${role.name}" ceiling ${role.maxPriority}`);
    }
  }
  const outputs = new Map(); // port name -> { path, shape }
  for (const port of m.outputs) {
    if (port.dest !== DEST_BUS) {
      errors.push(`output "${port.name}": only dest=BUS is hostable on the bridge (emitter/member outputs need a render host)`);
      continue;
    }
    if (!port.busPath) { errors.push(`output "${port.name}": dest=BUS but no bus_path`); continue; }
    if (port.busPath.includes('${')) { errors.push(`output "${port.name}": ${port.busPath} — substitution vars need a group context (not implemented)`); continue; }
    if (role) {
      const can = (role.canPublish || []).some((g) => globToRegex(g, instanceId).test(port.busPath));
      const cannot = (role.cannotPublish || []).some((g) => globToRegex(g, instanceId).test(port.busPath));
      if (!can) errors.push(`output "${port.name}": ${port.busPath} not in role "${role.name}" can_publish`);
      if (cannot) errors.push(`output "${port.name}": ${port.busPath} matches role "${role.name}" cannot_publish`);
    }
    if (declared && !declared.has(port.busPath)) {
      warnings.push(`output "${port.name}": ${port.busPath} is not declared in any module manifest`);
    }
    outputs.set(port.name, { path: port.busPath, shape: port.shape });
  }

  return {
    errors, warnings,
    resolved: errors.length ? null : { instance, seed, asset, binding, params, outputs, priority },
  };
}

const defaultScheduleRepeating = (fn, ms) => {
  const t = setInterval(fn, ms);
  if (t.unref) t.unref();
  return () => clearInterval(t);
};

function createPluginHost({
  bus,
  bindings, // [{file, json}] from loadBindingDir (or inline in tests)
  assets = builtinAssets(),
  declared = null,
  roles = null,
  instanceId = 'main',
  sourceId = 'spiffe://pain-material.local/bridge/plugin-host',
  tickMs = HOST_TICK_MS,
  scheduleRepeating = defaultScheduleRepeating,
  tap = null, // (instance, path, payload) after every accepted publish — the capture hook
  drainOutputs = true, // host ring is the declared EVENT-queue drainer until a real consumer binds (6.1)
}) {
  const failures = [];
  const warnings = [];
  const instances = []; // tick order = binding-file order = deterministic

  for (const { file, json } of bindings) {
    const v = validateBinding(json, { assets, declared, roles, instanceId });
    for (const w of v.warnings) warnings.push(`[${file}] ${w}`);
    if (!v.resolved) { failures.push({ file, errors: v.errors }); continue; }
    if (instances.some((i) => i.name === v.resolved.instance)) {
      failures.push({ file, errors: [`duplicate instance "${v.resolved.instance}"`] });
      continue;
    }
    const prng = mulberry32(v.resolved.seed);
    let impl;
    try {
      impl = v.resolved.asset.create({ params: v.resolved.params });
    } catch (e) {
      failures.push({ file, errors: [`create() threw: ${e.message}`] });
      continue;
    }
    instances.push({
      file,
      name: v.resolved.instance,
      assetKey: v.resolved.binding.asset,
      manifest: v.resolved.asset.manifest,
      inputs: Object.entries(v.resolved.binding.inputs || {}), // [port, busPath]
      outputs: v.resolved.outputs,
      params: v.resolved.params,
      priority: v.resolved.priority,
      seed: v.resolved.seed,
      prng,
      impl,
      crashed: null,
      ticks: 0,
      emitted: 0,
      publishRejects: 0,
      nonfiniteQuarantined: 0,
      ring: [], // last EMIT_RING_MAX emissions — the candidate-stream inspection view
    });
  }

  // STATE inputs: arbitrated RESOLVED value, never a packet payload (absent
  // path -> undefined; absent ≠ zero). EVENT inputs: full drain since the
  // last invocation, never coalesced.
  function gatherInputs(inst) {
    const state = {};
    const events = {};
    for (const [port, p] of inst.inputs) {
      const portDecl = inst.manifest.inputs.find((d) => d.name === port);
      if (portDecl && portDecl.shape === SHAPE_EVENT) events[port] = bus.drainEvents(p);
      else {
        const entry = bus.paths.get(p);
        state[port] = entry && entry.resolved ? entry.resolved.value : undefined;
      }
    }
    return { state, events };
  }

  function crash(inst, err) {
    inst.crashed = { at: bus.nowMono(), message: err && err.message ? err.message : String(err) };
    // Failsafe: EVENT outputs fall silent by construction; STATE outputs are
    // released so arbitration falls to other writers / HOLD.
    for (const [port, out] of inst.outputs) {
      if (out.shape === SHAPE_STATE) {
        bus.publishState(out.path, 0, { sourceId, priority: inst.priority, release: true });
      }
    }
    console.error(`plugin-host: instance "${inst.name}" (${inst.assetKey}) CRASHED — ${inst.crashed.message}. `
      + 'Its outputs are silenced (failsafe); restart the bridge or fix the asset.');
  }

  function makeEmit(inst, now) {
    return (portName, payload) => {
      const out = inst.outputs.get(portName);
      if (!out) throw new Error(`emit to undeclared output port "${portName}"`); // a plugin bug -> crash path
      if (typeof payload === 'number' && !Number.isFinite(payload)) {
        inst.nonfiniteQuarantined += 1; // rule-13 posture: quarantined + counted, never published
        return;
      }
      // Publishes carry the HOST's module identity (the allowlisted stableId);
      // instances are host-internal — per-instance identity would need its own
      // manifest/allowlist entry, which nothing requires yet.
      // Vec payloads (e.g. a note_on [ch, note, vel]) get the same rule-13
      // quarantine, element-wise.
      if (Array.isArray(payload) && payload.some((x) => typeof x === 'number' && !Number.isFinite(x))) {
        inst.nonfiniteQuarantined += 1;
        return;
      }
      const opts = { sourceId, priority: inst.priority };
      const rec = out.shape === SHAPE_EVENT
        ? bus.publishEvent(out.path, payload, opts)
        : bus.publishState(out.path, payload, opts);
      if (!rec.accepted) { inst.publishRejects += 1; return; }
      inst.emitted += 1;
      if (drainOutputs && out.shape === SHAPE_EVENT) bus.drainEvents(out.path);
      inst.ring.push({ t: now, port: portName, path: out.path, payload });
      if (inst.ring.length > EMIT_RING_MAX) inst.ring.shift();
      if (tap) tap(inst.name, out.path, payload);
    };
  }

  function makeCtx(inst, now) {
    const { state, events } = gatherInputs(inst);
    return {
      now,
      rand: inst.prng.rand,
      emit: makeEmit(inst, now),
      state: (port) => state[port],
      events: (port) => events[port] || [],
    };
  }

  function tickOnce() {
    const now = bus.nowMono();
    for (const inst of instances) {
      if (inst.crashed || !inst.manifest.requiresHostTick) continue;
      try {
        inst.impl.tick(makeCtx(inst, now));
        inst.ticks += 1;
      } catch (e) {
        crash(inst, e);
      }
    }
  }

  const cancelTick = scheduleRepeating(tickOnce, tickMs);

  // Arrival-driven delivery (see header): path -> [{inst, port}] for plugins
  // that implement onInput, STATE ports only (EVENT inputs stay tick-drained
  // until something needs per-arrival events).
  const arrivalRoutes = new Map();
  for (const inst of instances) {
    if (typeof inst.impl.onInput !== 'function') continue;
    for (const [port, p] of inst.inputs) {
      const decl = inst.manifest.inputs.find((d) => d.name === port);
      if (decl && decl.shape === SHAPE_EVENT) continue;
      if (!arrivalRoutes.has(p)) arrivalRoutes.set(p, []);
      arrivalRoutes.get(p).push({ inst, port });
    }
  }
  const deliver = (path, v) => {
    const now = bus.nowMono();
    for (const { inst, port } of arrivalRoutes.get(path)) {
      if (inst.crashed) continue;
      try {
        inst.impl.onInput(port, v, makeCtx(inst, now));
        inst.arrivals = (inst.arrivals || 0) + 1;
      } catch (e) {
        crash(inst, e);
      }
    }
  };
  const onPacket = (rec) => {
    if (!rec.accepted || !rec.pkt.state) return;
    const src = rec.pkt.source;
    if (src && src.sourceId === sourceId) return; // never our own publishes
    if (!arrivalRoutes.has(rec.pkt.state.path)) return;
    const entry = bus.paths.get(rec.pkt.state.path);
    if (!entry || !entry.resolved) return;
    deliver(rec.pkt.state.path, entry.resolved.value); // arbitrated, never the payload
  };
  if (arrivalRoutes.size) {
    bus.on('packet', onPacket);
    // Late-joiner priming (the bus retained contract, BUS_PROTOCOL.md): the
    // host may attach after writers already claimed state (the adapter's
    // boot defaults, a graph's seeded occupancy) — deliver the current
    // resolved values once at creation, in path-sorted order (deterministic),
    // so an onInput plugin never starts blind to retained state.
    for (const path of [...arrivalRoutes.keys()].sort()) {
      const entry = bus.paths.get(path);
      if (entry && entry.shape === 'state' && entry.resolved) deliver(path, entry.resolved.value);
    }
  }

  function find(name) {
    const inst = instances.find((i) => i.name === name);
    if (!inst) throw new Error(`no plugin instance "${name}"`);
    return inst;
  }

  return {
    instances, failures, warnings,
    tickOnce, // tests drive ticks directly

    // The replay-resume pair. A snapshot is {plugin state, PRNG state} —
    // both halves, or the restored instance's random stream diverges (the
    // exact bug class 6.0 exists to catch before 6.1).
    snapshotInstance(name) {
      const inst = find(name);
      return {
        asset: inst.assetKey,
        instance: inst.name,
        seed: inst.seed,
        prng_state: inst.prng.state(),
        plugin_state: inst.impl.snapshot(),
      };
    },
    restoreInstance(name, snap) {
      const inst = find(name);
      if (snap.asset !== inst.assetKey) {
        throw new Error(`snapshot is ${snap.asset}, instance runs ${inst.assetKey} — state never survives a version swap (plugin.v1)`);
      }
      inst.prng.setState(snap.prng_state);
      inst.impl.restore(snap.plugin_state);
    },

    // /plugins/state — instance status, execution-contract truth values, the
    // emission ring, and the live state snapshot (the inspection half of the
    // phase-6.0 proof).
    inspect() {
      return instances.map((inst) => {
        let state = null;
        try { state = inst.impl.snapshot(); } catch (e) { state = { snapshot_error: e.message }; }
        return {
          instance: inst.name,
          asset: inst.assetKey,
          file: inst.file,
          seed: inst.seed,
          params: inst.params,
          priority: inst.priority,
          requires_host_tick: inst.manifest.requiresHostTick,
          determinism: 'REPLAYABLE',
          state_model: inst.manifest.stateModel === 2 ? 'SNAPSHOTTABLE' : String(inst.manifest.stateModel),
          crashed: inst.crashed,
          ticks: inst.ticks,
          arrivals: inst.arrivals || 0,
          emitted: inst.emitted,
          publish_rejects: inst.publishRejects,
          nonfinite_quarantined: inst.nonfiniteQuarantined,
          prng_state: inst.prng.state(),
          recent_emits: inst.ring.slice(),
          state,
        };
      });
    },

    stop() {
      cancelTick();
      if (arrivalRoutes.size) bus.off('packet', onPacket);
    },
  };
}

module.exports = { createPluginHost, loadBindingDir, builtinAssets, validateBinding, mulberry32, HOST_TICK_MS };
