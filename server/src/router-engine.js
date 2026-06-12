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

  // Trigger: STATE in -> in-graph EVENT edge out. Holds an armed/side flag
  // (rule 4 state). The first sample SEEDS the side at the ARMED position
  // (FALLING seeds 'above', RISING seeds 'below'), so a session that opens
  // already past the threshold fires immediately — matching the legacy
  // hysteresis init (occupancy false until proven, then the first reading
  // claims it). Fires into ctx.fired (per-evaluation-pass event channel);
  // the node has no STATE value.
  trigger: (node, values, ctx) => {
    const raw = values.get(node.def.input);
    if (raw === undefined) return undefined;
    const x = raw === true ? 1 : raw === false ? 0 : raw;
    if (typeof x !== 'number' || !Number.isFinite(x)) return undefined;
    const { threshold, hysteresis, edge } = node.def;
    let st = ctx.state.get(node.id);
    if (!st) {
      // Seed at the armed side; evaluate this very sample against it below.
      st = { side: edge === 2 ? 'above' : 'below' }; // FALLING arms above, RISING/BOTH below
      ctx.state.set(node.id, st);
    }
    // threshold is the FIRE level; hysteresis is the band to RE-ARM
    // (ROUTER_IR.md). FALLING fires on x <= threshold (matching the legacy
    // `<=` comparisons) and re-arms only past threshold + hysteresis; RISING
    // mirrors it. Inside the band the side HOLDS — no chatter, no re-fire.
    // BOTH uses a one-sided deadband above (nothing uses BOTH yet; declared,
    // not hidden).
    let newSide = st.side;
    if (edge === 2) {        // FALLING
      if (x <= threshold) newSide = 'below';
      else if (x > threshold + hysteresis) newSide = 'above';
    } else if (edge === 1) { // RISING
      if (x >= threshold) newSide = 'above';
      else if (x < threshold - hysteresis) newSide = 'below';
    } else {                 // BOTH
      if (x >= threshold + hysteresis) newSide = 'above';
      else if (x < threshold) newSide = 'below';
    }
    const was = st.side;
    st.side = newSide;
    if (was === newSide) return undefined;
    const fell = newSide === 'below';
    if ((edge === 2 && fell) || (edge === 1 && !fell) || edge === 3) {
      ctx.fired.set(node.id, [{ payload: x }]);
    }
    return undefined;
  },

  // Latch COUNT: in-graph events in -> STATE out. Setting events increment;
  // a reset event returns to idle. Reset wins a same-pass tie (deterministic,
  // documented; the occupancy triggers can never tie — their thresholds
  // bracket a band one sample can't legally straddle in both directions).
  latch: (node, values, ctx) => {
    let st = ctx.state.get(node.id);
    if (!st) {
      st = { count: fromValue(node.def.idle) || 0 };
      ctx.state.set(node.id, st);
    }
    const set = ctx.fired.get(node.def.input);
    if (set) st.count += set.length;
    if (node.def.reset && ctx.fired.get(node.def.reset)) st.count = fromValue(node.def.idle) || 0;
    return st.count;
  },

  // Envelope AR in RATE_CONTROL: timestamp-driven like Smooth (ROUTER_IR.md),
  // gate-style on a 0..1 scale — attack ramps 1.0 per attack_ms toward the
  // input (attack_ms 0 snaps), release ramps 1.0 per release_ms away. Two
  // deliberate differences from Smooth, both because an envelope is a
  // HOLD-against-real-time, not an input filter:
  //   - Δt is NOT clamped at 500 ms — a 20 s motion hold must expire after a
  //     20 s quiet stretch, however few packets carried the time;
  //   - the engine re-evaluates envelopes on EVERY packet the graph receives
  //     (see _onPacket): time only arrives with packets (ROUTER_IR.md), and
  //     any packet carries time for the whole graph — without this, a decay
  //     would freeze the moment its own input went quiet (a still room's
  //     deduped motion=false would hold the envelope at 1 forever).
  envelope: (node, values, ctx) => {
    const raw = values.get(node.def.input);
    if (raw === undefined) {
      const held = ctx.state.get(node.id);
      return held ? held.y : undefined;
    }
    const x = raw === true ? 1 : raw === false ? 0 : raw;
    if (typeof x !== 'number' || !Number.isFinite(x)) return undefined;
    const now = ctx.now();
    let st = ctx.state.get(node.id);
    if (!st) {
      st = { y: x, x, t: now };
      ctx.state.set(node.id, st);
      return st.y;
    }
    // Advance the elapsed span against the ZOH-HELD previous input (between
    // packets the input held st.x — decay must start when motion FELL, not
    // be back-dated to when it rose), then adopt the new input. A zero
    // attack additionally snaps at this instant.
    const dt = Math.max(0, now - st.t);
    st.t = now;
    let y2 = st.y;
    if (st.x > st.y) y2 = node.def.attackMs <= 0 ? st.x : Math.min(st.x, st.y + dt / node.def.attackMs);
    else if (st.x < st.y) y2 = Math.max(st.x, st.y - dt / node.def.releaseMs);
    if (Number.isFinite(y2)) st.y = y2; // rule 13 structural guard
    st.x = x;
    if (node.def.attackMs <= 0 && x > st.y) st.y = x;
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
    // The engine clock for timestamp-driven nodes (Smooth, Envelope) is the
    // TRIGGERING PACKET'S stamp, exactly as ROUTER_IR.md states ("Δt taken
    // from the engine clock at evaluation == the triggering packet's
    // arrival; virtual time in the sim"). Live, wall-time-at-evaluation only
    // approximates that — every engine/plugin handler ahead of this one adds
    // microseconds, and that skew (absent in the sim, which freezes virtual
    // time within a stamp) is the whole live-vs-sim filter-memory residue
    // class the phase-5 comparator tolerates. Clocking off the stamp makes
    // live dt == the inter-arrival times the capture records — the residue
    // collapses. Outside a packet evaluation (the seeding pass) the bus
    // clock stands in.
    this._evalNow = null;
    this._ctx = {
      now: () => (this._evalNow !== null ? this._evalNow : this.bus.nowMono()),
      state: this.nodeState,
      fired: new Map(),
    };
    // Const nodes are value sources with no arrival: seed them up front so
    // they are readable the moment a live dep fires their consumers. Latches
    // likewise seed their idle value (phase 6.1) — a latch that has never
    // fired is at idle, not absent, so downstream of the latch can resolve
    // before the first crossing (the legacy occupancy starts false, not
    // unknown).
    const seeded = new Set();
    for (const node of compiled.nodes.values()) {
      if (node.op === 'const') { this.values.set(node.id, fromValue(node.def.value)); seeded.add(node.id); }
      else if (node.op === 'latch') { this.values.set(node.id, fromValue(node.def.idle) || 0); seeded.add(node.id); }
    }
    // One seeding pass so pure chains hanging off consts/latches hold values
    // from t0 (anything needing a live input stays undefined and silent).
    if (seeded.size) this._evaluate(seeded);
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
    const nanos = rec.pkt.time && rec.pkt.time.monotonic ? rec.pkt.time.monotonic.nanos : null;
    this._evalNow = typeof nanos === 'number' ? nanos / 1e6 : null;
    try {
      this._evaluate(new Set(inputIds), true);
    } finally {
      this._evalNow = null;
    }
  }

  // Recompute everything downstream of the changed inputs, in topo order.
  // advanceTime: a real packet arrival also re-evaluates every Envelope —
  // time only arrives with packets, and any packet carries time for the
  // whole graph (a decay must not freeze because its own input went quiet).
  // The seeding pass passes false (no time has passed at construction).
  _evaluate(dirty, advanceTime = false) {
    this._ctx.fired = new Map(); // per-pass in-graph event channel
    for (const id of this.compiled.topo) {
      const node = this.compiled.nodes.get(id);
      if (node.op === 'input') continue;
      const forced = advanceTime && node.op === 'envelope';
      if (!node.deps.some((d) => dirty.has(d)) && !forced) continue;
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
      } else if (node.op === 'trigger') {
        // Event-shaped: no STATE value. Downstream (latch only, by compile
        // rule) is dirtied ONLY by a firing — an unfired crossing check must
        // not ripple.
        EVAL.trigger(node, this.values, this._ctx);
        if (this._ctx.fired.has(id)) dirty.add(id);
      } else {
        const v = EVAL[node.op](node, this.values, this._ctx);
        // Rule 13 egress: a node must emit finite values; a poisoned result is
        // quarantined (previous value holds) rather than propagated.
        if (typeof v === 'number' && !Number.isFinite(v)) { this.nonfiniteDropped += 1; continue; }
        // Change-gated ripple for the stateful 6.1 ops: a forced
        // (time-advance) envelope holding its value, or a latch hit by a
        // same-state set/reset, must not republish the graph downstream.
        if ((forced || node.op === 'latch') && v === this.values.get(id)) continue;
        this.values.set(id, v);
        dirty.add(id);
      }
    }
  }
}

module.exports = { GraphEngine };
