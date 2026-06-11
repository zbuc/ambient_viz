// Arrival-driven RouterGraph engine (phase 4A, MIGRATION_PLAN.md).
//
// RATE_CONTROL execution semantics from ROUTER_IR.md: an accepted bus STATE
// packet immediately evaluates its downstream nodes, in the compiled
// topological order. Everything outside the declared stateful set (rule 4 —
// here, phase 5's Smooth) is a pure function, so the re-entrant evaluation
// is hazard-free; Smooth holds its filter memory in the engine's node-state
// store and is timestamp-driven (no control tick).
//
// One rule the spec implies but the implementation must state: the engine
// NEVER reacts to its own writes (source_id match). In-process, a graph whose
// Output targets a path one of its Inputs reads would otherwise recurse at
// zero delay — the same hazard rule 2 bans inside the graph. The rule-10
// bus-cycle lint still flags such graphs when it lands (4B+); skipping
// self-sourced packets is what makes the deliberate identity-echo loop of the
// 4A gate well-defined: each external packet evaluates the graph exactly once.

'use strict';

const { fromValue } = require('./bus');

// op -> evaluation (the 4B set + phase-5 Smooth; extended alongside graph.js
// DEPS). `output` is handled in _evaluate (it is a side effect, not a value).
// Contract shared by every evaluator: any undefined operand -> undefined
// (the value hasn't arrived; Outputs stay silent), and rule 13 (ROUTER_IR.md)
// — never emit NaN/Inf; degenerate parameterizations step, they don't poison.
// Evaluators receive (node, values, ctx); ctx carries the engine clock and
// the declared-stateful-node store (rule 4: state lives ONLY there).

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// Smooth's Δt clamp (ROUTER_IR.md "Execution semantics": a late, reordered,
// or bad-clock packet must not produce a negative or ten-minute filter
// step). 500 ms matches the legacy browser EMA's per-frame dt clamp, so the
// migrated filter degrades the same way across stalls.
const SMOOTH_DT_MAX_MS = 500;

// Curve easings over normalized u in [0,1].
const EASE = {
  1: (u) => u,                                            // LINEAR
  2: (u) => u * u,                                        // EASE_IN_QUAD
  3: (u) => 1 - (1 - u) * (1 - u),                        // EASE_OUT_QUAD
  4: (u) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u)), // EASE_IN_OUT
  5: (u) => (u >= 1 ? 1 : 0),                             // STEP (at in_max)
};

const COMBINE = {
  1: (xs) => xs.reduce((a, b) => a + b, 0),               // SUM
  2: (xs) => xs.reduce((a, b) => a * b, 1),               // MUL
  3: (xs) => Math.min(...xs),                             // MIN
  4: (xs) => Math.max(...xs),                             // MAX
  5: (xs) => xs.reduce((a, b) => a + b, 0) / xs.length,   // AVG
};

const EVAL = {
  input: (node, values) => values.get(node.id), // ZOH store, written on packet arrival

  // const is seeded into the value store at engine start; evaluating it (only
  // possible via a future dirty-marking bug) just returns the seeded value.
  const: (node, values) => values.get(node.id),

  scale: (node, values) => {
    const x = values.get(node.def.input);
    if (x === undefined) return undefined;
    return node.def.mul * x + node.def.add;
  },

  // (x - lo) / (hi - lo) clamped 0..1; lo/hi are NODE values (live signals —
  // the learned-calibration ramp). Degenerate span (hi <= lo): step at lo —
  // 0 below, 1 at/past — mirroring the legacy guard, never NaN (rule 13).
  normalize: (node, values) => {
    const x = values.get(node.def.input);
    const lo = values.get(node.def.lo);
    const hi = values.get(node.def.hi);
    if (x === undefined || lo === undefined || hi === undefined) return undefined;
    const span = hi - lo;
    const r = span > 0 ? clamp01((x - lo) / span) : (x >= lo ? 1 : 0);
    return node.def.invert ? 1 - r : r;
  },

  curve: (node, values) => {
    const x = values.get(node.def.input);
    if (x === undefined) return undefined;
    const { inMin, inMax, outMin, outMax, kind, lut, clamp: doClamp } = node.def;
    const inSpan = inMax - inMin;
    // Degenerate input range: step at in_min (rule 13 — never NaN).
    let u = inSpan !== 0 ? (x - inMin) / inSpan : (x >= inMin ? 1 : 0);
    if (doClamp) u = clamp01(u);
    let e;
    if (kind === 6) { // LUT: N equally-spaced points over [in_min, in_max], linear between
      const pos = clamp01(u) * (lut.length - 1);
      const i = Math.min(Math.floor(pos), lut.length - 2);
      e = lut[i] + (lut[i + 1] - lut[i]) * (pos - i);
    } else {
      e = EASE[kind](u);
    }
    return outMin + (outMax - outMin) * e;
  },

  // Smooth ONE_POLE in RATE_CONTROL is TIMESTAMP-DRIVEN (ROUTER_IR.md,
  // "Execution semantics"): no tick means no fixed dt, so the coefficient is
  // the dt-aware α = 1 − e^(−Δt/τ), Δt taken from the engine clock at
  // evaluation (== the triggering packet's arrival; virtual time in the sim).
  // The first sample SEEDS the filter (no step up from a phantom zero), and
  // Δt = 0 (a same-millisecond burst) is a no-op rather than the legacy
  // browser's snap-to-raw — bursts smooth through instead of teleporting.
  // Between packets the filter HOLDS: arrival-driven semantics, stated in the
  // phase-5 plan entry (the legacy per-frame EMA keeps converging on a still
  // signal; the bounded divergence is the comparator's lag/eps allowance).
  smooth: (node, values, ctx) => {
    const x = values.get(node.def.input);
    if (x === undefined) return undefined;
    const now = ctx.now();
    let st = ctx.state.get(node.id);
    if (!st) {
      st = { y: x, t: now };
      ctx.state.set(node.id, st);
      return st.y;
    }
    const dt = Math.min(SMOOTH_DT_MAX_MS, Math.max(0, now - st.t));
    st.t = now;
    if (dt > 0) {
      // Rule 13 structural guard: commit only a finite step, so one poisoned
      // computation can never corrupt the filter memory permanently.
      const y2 = st.y + (x - st.y) * (1 - Math.exp(-dt / node.def.timeConstantMs));
      if (Number.isFinite(y2)) st.y = y2;
    }
    return st.y;
  },

  combine: (node, values) => {
    const xs = [];
    for (const id of node.def.inputs) {
      const v = values.get(id);
      if (v === undefined) return undefined; // strict: blend waits for all inputs
      xs.push(v);
    }
    if (node.def.mode === 6) { // WEIGHTED
      let acc = 0;
      for (let i = 0; i < xs.length; i++) acc += xs[i] * node.def.weights[i];
      return acc;
    }
    return COMBINE[node.def.mode](xs);
  },
};

class GraphEngine {
  // opts.tap — called after every accepted Output publish (target, value):
  // the bridge wires this into the phase-0 capture (`bus_tx` events) so a
  // recorded session carries the live graph's output for offline diffing.
  constructor({ compiled, bus, sourceId, tap = null }) {
    this.compiled = compiled;
    this.bus = bus;
    this.sourceId = sourceId;
    this.tap = tap;
    this.values = new Map(); // node id -> latest value (ZOH)
    this.published = 0;
    this.publishRejects = 0;
    this.nonfiniteDropped = 0; // rule 13: poisoned samples quarantined, counted
    // The declared-stateful-node store (rule 4) + the engine clock the
    // timestamp-driven evaluators read. bus.nowMono is the ONE clock the
    // bridge already injects virtually in the sim — borrowing it keeps every
    // stateful node deterministic under replay for free.
    this.nodeState = new Map();
    this._ctx = { now: () => this.bus.nowMono(), state: this.nodeState };
    // Const nodes are value sources with no arrival: seed them up front so
    // they are readable the moment a live dep fires their consumers.
    for (const node of compiled.nodes.values()) {
      if (node.op === 'const') this.values.set(node.id, fromValue(node.def.value));
    }
    this._onPacket = this._onPacket.bind(this);
  }

  start() { this.bus.on('packet', this._onPacket); }
  stop() { this.bus.off('packet', this._onPacket); }

  _onPacket(rec) {
    if (!rec.accepted || !rec.pkt.state) return; // 4A: STATE inputs only
    const src = rec.pkt.source;
    if (src && src.sourceId === this.sourceId) return; // no zero-delay self-feedback
    const path = rec.pkt.state.path;
    const inputIds = this.compiled.inputsByPath.get(path);
    if (!inputIds) return;
    // An Input node reads the SIGNAL, not the writer: the value entering the
    // graph is the bus's arbitrated RESOLVED state after this packet, never
    // the packet's own payload. On a multi-writer path (a sensor claim over
    // the standing defaults writer, 4C) a low-priority keepalive must not
    // drag the graph back to a shadowed value. Arrival still drives
    // evaluation — that half of the RATE_CONTROL contract is unchanged.
    const entry = this.bus.paths.get(path);
    if (!entry || !entry.resolved) return;
    const v = entry.resolved.value;
    // Rule 13 ingress quarantine: a non-finite number never enters the graph —
    // treated as missing, the previous good ZOH value holds.
    if (typeof v === 'number' && !Number.isFinite(v)) { this.nonfiniteDropped += 1; return; }
    for (const id of inputIds) this.values.set(id, v);
    this._evaluate(new Set(inputIds));
  }

  // Recompute everything downstream of the changed inputs, in topo order.
  _evaluate(dirty) {
    for (const id of this.compiled.topo) {
      const node = this.compiled.nodes.get(id);
      if (node.op === 'input') continue;
      if (!node.deps.some((d) => dirty.has(d))) continue;
      if (node.op === 'output') {
        const v = this.values.get(node.def.input);
        if (v === undefined) continue; // upstream has never produced a value
        const rec = this.bus.publishState(node.def.target, v, {
          sourceId: this.sourceId,
          priority: node.def.priority || 0,
        });
        this.published += 1;
        if (!rec.accepted) this.publishRejects += 1;
        else if (this.tap) this.tap(node.def.target, v);
      } else {
        const v = EVAL[node.op](node, this.values, this._ctx);
        // Rule 13 egress: a node must emit finite values; a poisoned result is
        // quarantined (previous value holds) rather than propagated.
        if (typeof v === 'number' && !Number.isFinite(v)) { this.nonfiniteDropped += 1; continue; }
        this.values.set(id, v);
        dirty.add(id);
      }
    }
  }
}

module.exports = { GraphEngine };
