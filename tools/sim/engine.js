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

// op -> pure evaluation. Extended in 4B (const/normalize/curve/scale/combine)
// alongside graph.js DEPS. `output` is handled in _evaluate (it is a side
// effect, not a value).
const EVAL = {
  input: (node, values) => values.get(node.id), // ZOH store, written on packet arrival
};

class GraphEngine {
  constructor({ compiled, bus, sourceId }) {
    this.compiled = compiled;
    this.bus = bus;
    this.sourceId = sourceId;
    this.values = new Map(); // node id -> latest value (ZOH)
    this.published = 0;
    this.publishRejects = 0;
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
        this.values.set(id, EVAL[node.op](node, this.values));
        dirty.add(id);
      }
    }
  }
}

module.exports = { GraphEngine };
