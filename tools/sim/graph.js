// RouterGraph loader + compile skeleton (phase 4A, MIGRATION_PLAN.md).
//
// Parses a router.v1 graph (proto-JSON through the generated codec — the
// schema-of-record) and validates the subset the 4A engine executes. The
// validation rule numbers reference ROUTER_IR.md "Compile & validation rules".
//
// 4A scope, stated rather than implied:
//   - ops: Input and Output only. The 4B compiler adds Const / Normalize /
//     Curve / Scale / Combine; everything else stays a compile error until the
//     phase that needs it.
//   - rate domains: RATE_CONTROL only (arrival-driven). Tick domains arrive
//     with the first mapping that needs one.
//   - no Replicated, no wildcards, STATE outputs only (EVENT sinks are
//     phase 6).
// A graph using an unimplemented feature is REJECTED loudly at compile — the
// engine never sees a node it can't honestly execute.

'use strict';

const routerGen = require('../../server/src/gen/router');
const { globToRegex } = require('../../server/src/registry');

const RATE_CONTROL = 1; // orrery.common.v1.RateDomain.RATE_CONTROL
const SHAPE_STATE = 1;  // router.v1 Output.Shape.STATE

const OP_KEYS = ['input', 'const', 'curve', 'scale', 'smooth', 'gate', 'combine', 'select',
  'delay', 'member', 'output', 'envelope', 'trigger', 'latch', 'normalize'];
// The 4B compiler surface (MIGRATION_PLAN.md): the tape-failure mapping's op
// set. Stateful/temporal nodes and Select/Gate stay compile errors until the
// phase that needs them.
const IMPLEMENTED = new Set(['input', 'const', 'curve', 'scale', 'combine', 'normalize', 'output']);

const COMBINE_ARITY_CAP = 16; // rule 6: bounded fan-in, over-cap is an error

// op -> node ids it reads (the graph's dependency edges). Extended per phase
// alongside the engine's evaluator.
const DEPS = {
  input: () => [],
  const: () => [],
  scale: (op) => [op.input],
  curve: (op) => [op.input],
  normalize: (op) => [op.input, op.lo, op.hi],
  combine: (op) => op.inputs || [],
  output: (op) => [op.input],
};

function compileGraph(graphJson, { declaredPaths = null, roles = null, instanceId = '' } = {}) {
  const errors = [];
  const warnings = [];
  let graph;
  try {
    graph = routerGen.RouterGraph.fromJSON(graphJson);
  } catch (e) {
    return { ok: false, errors: [`graph does not parse as router.v1: ${e.message}`], warnings };
  }

  if (graph.schema !== 'router.v1') errors.push(`schema "${graph.schema}" != "router.v1"`);
  if (graph.reps && graph.reps.length) errors.push('Replicated subgraphs are not implemented in 4A');

  // Node table: unique ids, exactly one op, supported rate domain + op.
  const nodes = new Map(); // id -> { id, op, def, deps }
  for (const n of graph.nodes || []) {
    if (!n.id) { errors.push('node with empty id'); continue; }
    if (nodes.has(n.id)) { errors.push(`duplicate node id "${n.id}"`); continue; }
    const ops = OP_KEYS.filter((k) => n[k] !== undefined);
    if (ops.length !== 1) {
      errors.push(`node "${n.id}" must have exactly one op (has ${ops.length ? ops.join(',') : 'none'})`);
      continue;
    }
    const op = ops[0];
    if (n.rateDomain !== RATE_CONTROL) {
      errors.push(`node "${n.id}": only RATE_CONTROL is implemented in 4A (tick domains arrive with the first mapping that needs one)`);
    }
    if (!IMPLEMENTED.has(op)) {
      errors.push(`node "${n.id}": op "${op}" is not implemented in 4A (engine implements: ${[...IMPLEMENTED].join(', ')})`);
      continue;
    }
    nodes.set(n.id, { id: n.id, op, def: n[op], deps: [] });
  }

  // Per-op structural checks + dependency edges.
  const inputsByPath = new Map(); // bus path -> [input node ids]
  const outputs = [];
  for (const node of nodes.values()) {
    if (node.op === 'input') {
      const p = node.def.path;
      if (!p) errors.push(`input "${node.id}": empty path`);
      else if (p.includes('*') || node.def.wildcardReduce) errors.push(`input "${node.id}": wildcards are not implemented in 4A`);
      else if (p.startsWith('_meta.')) errors.push(`input "${node.id}": the _meta domain is never a graph source (ROUTER_IR.md)`);
      else {
        if (!inputsByPath.has(p)) inputsByPath.set(p, []);
        inputsByPath.get(p).push(node.id);
        if (declaredPaths && !declaredPaths.has(p)) {
          warnings.push(`input "${node.id}": path ${p} is not declared in any module manifest`);
        }
      }
    } else if (node.op === 'const') {
      const v = node.def.value;
      if (!v || !['number', 'integer', 'boolean', 'text', 'vec'].some((k) => v[k] !== undefined)) {
        errors.push(`const "${node.id}": value must be a populated common.v1.Value`);
      }
    } else if (node.op === 'scale') {
      if (!Number.isFinite(node.def.mul) || !Number.isFinite(node.def.add)) {
        errors.push(`scale "${node.id}": mul/add must be finite`);
      }
    } else if (node.op === 'curve') {
      const c = node.def;
      if (!(c.kind >= 1 && c.kind <= 6)) errors.push(`curve "${node.id}": unknown kind ${c.kind}`);
      if (c.kind === 6 && (!c.lut || c.lut.length < 2)) errors.push(`curve "${node.id}": LUT needs >= 2 points`);
      if (![c.inMin, c.inMax, c.outMin, c.outMax].every(Number.isFinite)) {
        errors.push(`curve "${node.id}": in/out range must be finite`);
      }
    } else if (node.op === 'normalize') {
      for (const ref of ['input', 'lo', 'hi']) {
        if (!node.def[ref]) errors.push(`normalize "${node.id}": missing ${ref} (lo/hi are node ids — live signals)`);
      }
    } else if (node.op === 'combine') {
      const c = node.def;
      if (!c.inputs || c.inputs.length < 1) errors.push(`combine "${node.id}": needs >= 1 input`);
      else if (c.inputs.length > COMBINE_ARITY_CAP) errors.push(`combine "${node.id}": ${c.inputs.length} inputs exceeds the rule-6 cap (${COMBINE_ARITY_CAP})`);
      if (!(c.mode >= 1 && c.mode <= 6)) errors.push(`combine "${node.id}": unknown mode ${c.mode}`);
      if (c.mode === 6 && (!c.weights || c.weights.length !== (c.inputs || []).length || !c.weights.every(Number.isFinite))) {
        errors.push(`combine "${node.id}": WEIGHTED needs one finite weight per input`);
      }
    } else if (node.op === 'output') {
      const o = node.def;
      if (!o.target) errors.push(`output "${node.id}": empty target`);
      if (o.shape !== SHAPE_STATE) errors.push(`output "${node.id}": only STATE outputs are implemented in 4A (EVENT sinks are phase 6)`);
      if (declaredPaths && o.target && !declaredPaths.has(o.target)) {
        warnings.push(`output "${node.id}": target ${o.target} is not declared in any module manifest`);
      }
      // Rule 8 — authorization against ProjectPolicy (+ any sim-scoped roles).
      if (roles) {
        const role = roles.get(o.authorityRole);
        if (!o.authorityRole) errors.push(`output "${node.id}": missing authority_role (rule 8)`);
        else if (!role) errors.push(`output "${node.id}": authority_role "${o.authorityRole}" is not a known role (rule 8)`);
        else {
          if ((o.priority || 0) > role.maxPriority) {
            errors.push(`output "${node.id}": priority ${o.priority} exceeds role "${role.name}" ceiling ${role.maxPriority} (rule 8)`);
          }
          const can = (role.canPublish || []).some((g) => globToRegex(g, instanceId).test(o.target));
          const cannot = (role.cannotPublish || []).some((g) => globToRegex(g, instanceId).test(o.target));
          if (!can) errors.push(`output "${node.id}": target ${o.target} not in role "${role.name}" can_publish (rule 8)`);
          if (cannot) errors.push(`output "${node.id}": target ${o.target} matches role "${role.name}" cannot_publish (rule 8)`);
        }
      }
      outputs.push(node.id);
    }
    const deps = (DEPS[node.op] || (() => []))(node.def);
    for (const d of deps) {
      if (!nodes.has(d)) errors.push(`node "${node.id}": references unknown node "${d}"`);
    }
    node.deps = deps;
  }

  // Rule 2 — acyclic (Delay, the only legal cycle-breaker, is not in the 4A
  // op set, so any cycle is an error). Kahn's algorithm; the surviving order
  // is the engine's evaluation order.
  const indeg = new Map();
  const dependents = new Map(); // id -> ids that read it
  for (const node of nodes.values()) {
    indeg.set(node.id, 0);
    if (!dependents.has(node.id)) dependents.set(node.id, []);
  }
  for (const node of nodes.values()) {
    for (const d of node.deps) {
      if (!nodes.has(d)) continue;
      indeg.set(node.id, indeg.get(node.id) + 1);
      dependents.get(d).push(node.id);
    }
  }
  const queue = [...nodes.keys()].filter((id) => indeg.get(id) === 0);
  const topo = [];
  while (queue.length) {
    const id = queue.shift();
    topo.push(id);
    for (const dep of dependents.get(id)) {
      indeg.set(dep, indeg.get(dep) - 1);
      if (indeg.get(dep) === 0) queue.push(dep);
    }
  }
  if (topo.length !== nodes.size && !errors.length) {
    const stuck = [...nodes.keys()].filter((id) => !topo.includes(id));
    errors.push(`cycle without a Delay (rule 2): {${stuck.join(', ')}}`);
  }

  return { ok: errors.length === 0, errors, warnings, nodes, topo, inputsByPath, outputs, dependents };
}

module.exports = { compileGraph, RATE_CONTROL, SHAPE_STATE };
