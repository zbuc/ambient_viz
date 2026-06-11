// Arrival-driven RouterGraph engine (phase 4A, MIGRATION_PLAN.md).
//
// RATE_CONTROL execution semantics from ROUTER_IR.md: an accepted bus STATE
// packet immediately evaluates its downstream nodes, in the compiled
// topological order; everything in the 4A op set is a pure function, so the
// re-entrant evaluation is hazard-free.
//
// One rule the spec implies but the implementation must state: the engine
// NEVER reacts to its own writes (source_id match). In-process, a graph whose
// Output targets a path one of its Inputs reads would otherwise recurse at
// zero delay — the same hazard rule 2 bans inside the graph. The rule-10
// bus-cycle lint still flags such graphs when it lands (4B+); skipping
// self-sourced packets is what makes the deliberate identity-echo loop of the
// 4A gate well-defined: each external packet evaluates the graph exactly once.

'use strict';

const { fromValue } = require('../../server/src/bus');

// op -> pure evaluation (the 4B set; extended alongside graph.js DEPS).
// `output` is handled in _evaluate (it is a side effect, not a value).
// Contract shared by every evaluator: any undefined operand -> undefined
// (the value hasn't arrived; Outputs stay silent), and rule 13 (ROUTER_IR.md)
// — never emit NaN/Inf; degenerate parameterizations step, they don't poison.

const clamp01 = (x) => Math.min(1, Math.max(0, x));

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
  constructor({ compiled, bus, sourceId }) {
    this.compiled = compiled;
    this.bus = bus;
    this.sourceId = sourceId;
    this.values = new Map(); // node id -> latest value (ZOH)
    this.published = 0;
    this.publishRejects = 0;
    this.nonfiniteDropped = 0; // rule 13: poisoned samples quarantined, counted
    // Const nodes are value sources with no arrival: seed them up front so
    // they are readable the moment a live dep fires their consumers.
    const { fromValue: fv } = require('../../server/src/bus');
    for (const node of compiled.nodes.values()) {
      if (node.op === 'const') this.values.set(node.id, fv(node.def.value));
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
    const v = fromValue(rec.pkt.state.value);
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
      } else {
        const v = EVAL[node.op](node, this.values);
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
