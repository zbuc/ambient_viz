# Router IR (`router.v1`)

> **Status: draft spec.** The project's routing layer as a **compiled, typed
> graph** — *not* a text DSL. It reads **`manifest.v1`** (the namespace, each
> signal's type/range/rate, group members + geometry, and the authorization
> policy) and processes **`bus.v1`** packets at runtime, emitting writes back to
> the bus. The project manifest's routing section *is* a `RouterGraph`.
>
> This is the home of the accumulated router requirements: `domain.instance.field`
> + wildcards, select/blend/fallback, per-edge `rate_domain`, and emitter-group
> definitions. Same toolchain + staging doctrine as the other schemas.

## Core principle — wire & shape, don't compute

The IR **routes and shapes** control signals (gate, curve, scale, smooth,
envelope/trigger/latch shape-conversion, blend, select) and **wires them into
sinks and into plugins**. It is deliberately
**not a generative-math language**: no trig, no oscillators, no free expressions,
no hidden state. Anything heavier than per-edge shaping — a wave across strips, a
scene's render, an FX choreography — is a **versioned plugin** (Houdini-HDA
style; see `ARCHITECTURE.md` *render plane*), and the IR just **binds inputs to
it**. This is what stops the manifest from becoming an untestable mini-Max/MSP.

State lives only in the **declared stateful nodes**: `Smooth` (filter memory),
`Delay` (explicit delay line), and the shape converters `Envelope` (follower
memory), `Latch` (held value), `Trigger` (its arm flag). Every other node is a
**pure function of its inputs**.

## The IDL

```proto
syntax = "proto3";
package orrery.router.v1;

import "common.proto";  // orrery.common.v1.{Value, RateDomain, MemberParam}
// manifest.v1 is read by the COMPILER (validation/authorization), not the runtime graph

message RouterGraph {
  string   schema           = 1;  // "router.v1"
  repeated Node nodes       = 2;  // main control-plane DAG
  repeated Replicated reps  = 3;  // per-group / per-wildcard-match subgraphs
  WildcardPolicy wildcard_policy = 4;
  optional uint32 reload_ramp_ms = 5;  // crossfade STATE outputs on reload (anti-discontinuity).
                                       // EVENT outputs never ramp: queued events survive the
                                       // swap, deduped by (source, boot_epoch, seq) — no
                                       // drops, no replays (rule 9)
}

message Node {
  string id = 1;                  // unique within its (sub)graph
  orrery.common.v1.RateDomain rate_domain = 2;
  oneof op {
    Input   input   = 10;
    Const   const   = 11;
    Curve   curve   = 12;
    Scale   scale   = 13;
    Smooth  smooth  = 14;  // HOLDS STATE (filter memory)
    Gate    gate    = 15;
    Combine combine = 16;  // blend
    Select  select  = 17;  // fallback / pick
    Delay   delay   = 18;  // HOLDS STATE — the only legal way to make a cycle
    Member  member  = 19;  // Replicated-only: this instance's params
    Output  output  = 20;  // writer to a sink
    Envelope envelope = 21; // HOLDS STATE — EVENT/STATE → STATE (follower)
    Trigger  trigger  = 22; // HOLDS STATE (arm flag) — STATE → EVENT (edge detect)
    Latch    latch    = 23; // HOLDS STATE — EVENT → STATE (hold/toggle/count)
    Normalize normalize = 24; // pure — signal-parameterized (value-lo)/(hi-lo)
  }
}

// ── sources ──
message Input {
  string path = 1;             // bus SignalPath; may be a wildcard (REDUCE) feeding a Combine/Select
  bool   wildcard_reduce = 2;  // true → emits the matched set for a downstream reducer
}
message Const  { orrery.common.v1.Value value = 1; }
message Member {                          // valid only inside a Replicated subgraph
  orrery.common.v1.MemberParam which = 1;  // MEMBER_INDEX / COUNT / LOGICAL / POSITION
}

// ── pure scalar/transfer ops ──
message Curve {
  string input = 1;
  Kind   kind  = 2;                       // LINEAR | EASE_IN_QUAD | EASE_OUT_QUAD | EASE_IN_OUT | STEP | LUT
  repeated float lut = 3;                 // when kind = LUT: N equally-spaced points over
                                          // [in_min, in_max], linear between entries
  double in_min=4; double in_max=5; double out_min=6; double out_max=7;
  bool   clamp = 8;
  enum Kind { KIND_UNSPECIFIED=0; LINEAR=1; EASE_IN_QUAD=2; EASE_OUT_QUAD=3; EASE_IN_OUT=4; STEP=5; LUT=6; }
}
message Scale { string input=1; double mul=2; double add=3; }
message Normalize {                       // (value − lo) / (hi − lo), clamped 0..1
  string input=1;
  string lo=2; string hi=3;               // NODE IDS, not constants — the endpoints are
                                          // live signals. This is how LEARNED CALIBRATION
                                          // (the empty-room distance_far_cm) parameterizes
                                          // a graph; Curve's static in_min/in_max can't.
  bool invert=4;                          // emit 1 − result (near = hot: the reversed ramp)
  // degenerate span (hi ≈ lo): step at lo (0 below, 1 at/past) — never NaN (rule 13)
}
message Gate  {
  string input=1; string control=2; double threshold=3;
  Mode mode=4; optional orrery.common.v1.Value blocked_value=5;
  enum Mode { MODE_UNSPECIFIED=0; ABOVE=1; BELOW=2; }
}

// ── temporal (HOLD STATE) ──
message Smooth {
  string input=1; Kind kind=2;
  double time_constant_ms=3;              // ONE_POLE — interpreted IN THIS NODE'S rate_domain
  double slew_per_s=4;                    // SLEW
  double min_cutoff_hz=5;                 // ONE_EURO — cutoff at rest (lower = smoother/laggier when still)
  double beta=6;                          // ONE_EURO — speed coefficient (higher = snappier on fast moves)
  enum Kind { KIND_UNSPECIFIED=0; ONE_POLE=1; SLEW=2; ONE_EURO=3; }
}
message Delay { string input=1; uint32 frames=2; } // explicit delay; breaks cycles.
                                                   // frames are counted IN THIS NODE'S
                                                   // rate_domain (same rule as Smooth's
                                                   // time params) — so TICK DOMAINS ONLY:
                                                   // RATE_CONTROL has no tick to count,
                                                   // rejected there (rule 11).

// ── shape conversion (EVENT ↔ STATE; all HOLD STATE) ──
// The explicit bridges between the two shapes — the reference visualizer's
// envelope followers (bassPulse) and edge detectors (onset) live here, not
// in hidden per-edge behavior.
message Envelope {                         // EVENT or STATE in → STATE out
  string input=1;
  Mode   mode=2;
  double attack_ms=3;                      // AR only; time params interpreted in
  double release_ms=4;                     //   this node's rate_domain (cf. Smooth)
  enum Mode { MODE_UNSPECIFIED=0;
              PEAK_FOLLOW=1;               // instant attack, exponential release (bassPulse)
              AR=2; }                      // attack/release ramp (gate-style)
}
message Trigger {                          // STATE in → EVENT out on threshold crossing
  string input=1;
  double threshold=2;
  double hysteresis=3;                     // value-domain band to re-arm (anti-chatter)
  Edge   edge=4;
  enum Edge { EDGE_UNSPECIFIED=0; RISING=1; FALLING=2; BOTH=3; }
}
message Latch {                            // EVENT in → STATE out
  string input=1;                          // the event stream
  optional string reset=2;                 // optional second event stream → back to `idle`
  Mode   mode=3;
  optional orrery.common.v1.Value idle=4;  // value before first event / after reset
  enum Mode { MODE_UNSPECIFIED=0;
              HOLD_PAYLOAD=1;              // sample-and-hold the event payload
              TOGGLE=2;                    // bool flip per event
              COUNT=3; }                   // monotonic event counter
}

// ── multi-input ──
message Combine {                          // BLEND
  repeated string inputs=1;                // fixed order = deterministic for non-commutative modes
  Mode mode=2; repeated double weights=3;  // weights parallel to inputs for WEIGHTED
  enum Mode { MODE_UNSPECIFIED=0; SUM=1; MUL=2; MIN=3; MAX=4; AVG=5; WEIGHTED=6; }
}
message Select {                           // FALLBACK / pick
  repeated string inputs=1; Mode mode=2;
  optional string index_input=3;           // for BY_INDEX
  uint32 hysteresis_ms=4;                  // anti-thrash when switching sources; interpreted in
                                           // this node's rate_domain (dt-aware in RATE_CONTROL,
                                           // same rule as Smooth's time params)
  enum Mode { MODE_UNSPECIFIED=0; FIRST_LIVE=1; HIGHEST_PRIORITY=2; BY_INDEX=3; }
}

// ── sink writer ──
message Output {
  string input=1;
  string target=2;                         // bus SignalPath; may use ${member}/${instance} inside a Replicated
  Shape  shape=3;                          // STATE | EVENT
  uint32 priority=4;                       // authority value; ≤ role.max_priority (checked vs ProjectPolicy)
  optional string authority_role=5;        // role asserting this write
  enum Shape { SHAPE_UNSPECIFIED=0; STATE=1; EVENT=2; }
}

// ── replication: groups & wildcard fan-out, unified ──
message Replicated {
  Over   over = 1;                         // GROUP:<id>  or  MATCH:<wildcard path>
  string bind = 2;                         // substitution var: "${member}" or "${instance}"
  orrery.common.v1.RateDomain rate_domain = 3;
  oneof body {
    NodeGraph     graph  = 4;              // simple shaping, expressed in nodes
    PluginBinding plugin = 5;              // heavy/generative logic → a versioned plugin
  }
  message Over { oneof of { string group = 1; string match = 2; } }
}
message NodeGraph { repeated Node nodes = 1; string output_node = 2; }
message PluginBinding {
  string asset = 1;                        // versioned plugin, e.g. "wave.v1" / "laser.edge_tracer.v1"
  map<string, string> inputs = 2;          // plugin input name → node id or bus path
  map<string, double> params = 3;          // static params (scan_rate, intensity, …)
}

message WildcardPolicy {
  Expansion  expansion   = 1;              // COMPILE_TIME (default) | DYNAMIC
  repeated string require_tag = 2;
  repeated string exclude_tag = 3;         // e.g. ["debug","calibration"]
  OnNewMatch on_new_match = 4;             // IGNORE_UNTIL_RELOAD (default) | ADD
  uint32     max_matches  = 5;             // bounded fan-out guard
  MatchAgainst match_against = 6;          // EXPECTED (default) | DISCOVERED — what the snapshot resolves against
  enum Expansion    { EXPANSION_UNSPECIFIED=0; COMPILE_TIME=1; DYNAMIC=2; }
  enum OnNewMatch   { ON_NEW_MATCH_UNSPECIFIED=0; IGNORE_UNTIL_RELOAD=1; ADD=2; }
  enum MatchAgainst { MATCH_AGAINST_UNSPECIFIED=0; EXPECTED=1; DISCOVERED=2; } // UNSPECIFIED → EXPECTED
}

// RateDomain → common.proto (orrery.common.v1); MemberParam too (was Member.Which).
```

## Node catalog

| Op | Inputs → out | State? | Notes |
|---|---|---|---|
| `Input` | bus path → value | — | source; wildcard (REDUCE) feeds a reducer |
| `Const` | — → value | — | literal `common.v1.Value` |
| `Member` | — → value | — | `INDEX/COUNT/LOGICAL/POSITION` (Replicated only) |
| `Curve` | 1 → 1 | — | transfer curve + in/out range + clamp |
| `Scale` | 1 → 1 | — | affine `mul·x + add` |
| `Normalize` | val + lo + hi → 1 | — | signal-parameterized `(x−lo)/(hi−lo)` clamp, optional invert — learned-calibration ramps |
| `Gate` | val + control → 1 | — | pass/block by threshold |
| `Smooth` | 1 → 1 | **yes** | one-pole / slew / one-euro (adaptive); time params in node's `rate_domain` |
| `Delay` | 1 → 1 | **yes** | the only legal cycle-breaker; `frames` counted in this node's `rate_domain` — tick domains only (rule 11) |
| `Envelope` | EVENT/STATE → STATE | **yes** | follower: peak-follow / attack-release (the `bassPulse` primitive) |
| `Trigger` | STATE → EVENT | **yes** (arm flag) | edge detect on threshold crossing + hysteresis (the onset primitive) |
| `Latch` | EVENT → STATE | **yes** | hold payload / toggle / count; optional reset stream |

**Anticipated (not yet specified):** `Merge` (N EVENT → 1 EVENT, interleaved —
needed the moment two trigger sources share one sink/strike path) and
`Cooldown` (EVENT → EVENT, refractory min-gap — universal in interaction
design). Deferred until a graph needs them *outside* a plugin; today the one
consumer (the Pain Material bell/toll shared cooldown) lives inside its
choreography plugin.
| `Combine` | N → 1 | — | **blend** (sum/mul/min/max/avg/weighted) |
| `Select` | N → 1 | — | **fallback** (first-live/priority/index) + hysteresis |
| `Output` | 1 → sink | — | **writer** to a sink path at a priority |

## Replication — groups & wildcards, one construct

`Replicated` instantiates a subgraph **per item of a set**:

- **`over: GROUP:wave`** → once per member of emitter-group `wave`; the subgraph
  may read `Member` params (`INDEX/COUNT/LOGICAL/POSITION`, resolved from each
  member's `manifest.v1` geometry). This is how a member renders its slice
  **locally** from `f(shared control, index, count)`.
- **`over: MATCH:audio.*.bass`** → once per signal matching the wildcard, with
  `${instance}` bound to each match — the "map every `audio.chN.bass` to region N"
  case. Subject to `WildcardPolicy`.

**Membership change mid-show** mirrors the wildcard policy: a `GROUP`
replication instantiates at compile time against the **expected** member set
(`ProjectPolicy.groups` + enrolled manifests — the group analog of
`match_against: EXPECTED`). An expected member that boots late binds to its
already-instantiated slot; an unexpected member (index outside the `GroupDef`)
is ignored until reload; a member that drops out leaves its slot running into a
stale sink for the lifecycle FSM to flag. The graph shape never changes at
runtime.

Each `Replicated` is either a **`NodeGraph`** (simple per-item shaping) **or** a
**`PluginBinding`** — the escape hatch for anything generative. A wave across
strips is `plugin: wave.v1` with `inputs: {phase: clock.main.beat_phase}` and the
`Member` index/count supplied automatically; the IR wires it, the plugin computes
it. The asset's declared input/param/output interface is its **`plugin.v1`**
contract — see [`PLUGIN_CONTRACT.md`](PLUGIN_CONTRACT.md).

## Wildcard policy (a new device can't silently join the show)

Wildcards resolve at **compile time** (the project load/reload event runs the
compiler once and **freezes** the expansion) — `require_tag`/`exclude_tag` filter
matches (a `debug` or `calibration` tap never joins); `on_new_match:
IGNORE_UNTIL_RELOAD` means a node appearing at runtime is *not* auto-wired until
an explicit reload; `max_matches` bounds fan-out. The reserved **`_meta` domain
never matches a wildcard** — diagnostics (`ARCHITECTURE.md` → *Observability*)
are addressed explicitly or not at all.

**`match_against: EXPECTED` (default), not `DISCOVERED`.** The snapshot resolves
against the **declared** set — the `manifest.v1` modules plus the
`ProjectPolicy.allow[]` allowlist — *not* whichever nodes happen to have booted.
This makes expansion **deterministic and boot-order-independent**: the show is
identical whether the `ch3` node booted before or after load, and a node that's
expected-but-absent surfaces as a **health** condition (lifecycle FSM) rather
than silently shrinking the graph. `DISCOVERED` (resolve against currently-
enrolled nodes) is the opt-in for ad-hoc setups that accept boot-timing
nondeterminism.

## Compile & validation rules (the discipline)

The compiler reads the manifests and **rejects** a graph that violates:

1. **Typecheck** — input/output `ValueType`s match (manifest-declared); an
   `Output` to a `BOOL` sink needs a bool-producing chain. Curve in/out ranges
   default from the signal's manifest `range`.
2. **Acyclic except through `Delay`** — any cycle not broken by a `Delay` node is
   an error (no implicit feedback).
3. **Rate-domain coherence** — every node samples its inputs at its *own*
   `rate_domain` by **zero-order hold** (latest value), which is legal and zero-
   latency. The asymmetric rule: **upsampling** (slow→fast, e.g. control→render)
   is fine as bare ZOH; **downsampling** (fast→slow) *must* pass through a
   `Smooth`/decimate to avoid aliasing. `Smooth.time_constant_ms` is interpreted
   in the node's `rate_domain` (TouchDesigner *Time Slicing* — smoothing holds its
   wall-clock feel across frame-rate drops). See *Resampling & reactivity*.
4. **No hidden state** — only the declared stateful nodes (`Smooth`, `Delay`,
   `Envelope`, `Latch`, `Trigger`) hold state; enforced structurally.
5. **Determinism** — `Combine` inputs are a fixed list; commutative modes are
   order-free, `WEIGHTED` uses list order. Same graph + inputs → same output.
6. **Bounded fan-out** — `Select`/`Combine` arity and `Replicated` match counts
   are capped (`max_matches`); over-cap is an error, not a silent truncation.
7. **Anti-thrash** — `Select` carries `hysteresis_ms`; switching sources faster is
   rejected.
8. **Authorization** — every `Output.target` + `authority_role`/`priority` is
   checked against `ProjectPolicy`: the role must be allowed to publish that path
   and `priority ≤ role.max_priority`. A sensor graph cannot emit `clock.*`.
9. **Reload safety** — STATE outputs crossfade over `reload_ramp_ms` on graph
   swap; EVENT outputs pass through — in-flight/queued events are preserved and
   deduped by `(source, boot_epoch, seq)` across the swap (never dropped, never
   replayed). Stateful nodes (`Smooth`/`Envelope`/`Latch`/`Trigger`/`Delay`)
   **carry their memory across the swap when their definition is unchanged**
   (keyed by node id — the longest-unchanged-prefix idea); a changed or new
   node reinitializes, and the ramp absorbs the discontinuity.
10. **Bus-cycle lint (warn, not error)** — rule 2 sees only the graph; a cycle
    *through the bus* doesn't trip it. An `Output.target` that some `Input` in
    the same compiled project also reads (directly, or via a wildcard
    expansion of either side) is a feedback loop whose "delay" is transport
    latency — implicit, timing-dependent, and the concrete mechanism behind
    the fallback-thrashing / UI-fighting-automation hazards. The compiler
    cross-checks every resolved `Output.target` against every resolved
    `Input.path` and **warns** on overlap. A warning rather than an error
    because a deliberate bus loop can be legitimate (the transport hop is a
    real delay); the lint exists so no loop is *invisible*.
11. **`Delay` needs a tick** — a `Delay` node in `RATE_CONTROL` is rejected:
    with no tick, `frames` is undefined (see *Execution semantics*). Feedback
    around arrival-driven logic must pass through a tick domain (or a plugin).
12. **Shape typecheck** — `Shape` flows through the graph like `ValueType` does.
    Per-value transforms (`Curve`/`Scale`/`Gate`) are **shape-preserving**
    (STATE→STATE, or EVENT→EVENT operating on the payload). `Smooth`, `Delay`,
    and `Combine` accept **STATE only**. `Select` accepts either, but all its
    inputs must share one shape. Conversions are **explicit nodes only**:
    `Envelope`/`Latch` (EVENT→STATE), `Trigger` (STATE→EVENT). An EVENT feeding
    a state-only node is a compile error, and `Output.shape` must match the
    shape its chain produces.
13. **Non-finite quarantine** — NaN/±Inf never enters the graph: an ingress
    value that is not finite is treated as **missing** (the staleness path —
    the signal's `on_stale` decides what the sink sees), and stateful nodes
    (`Smooth`/`Envelope`) are structurally guarded so one poisoned sample
    cannot corrupt filter memory permanently. Nodes must emit finite values.
    f32 sensor math *will* produce a NaN eventually; this rule decides whether
    that costs a frame or a show.

Outputs are **writers**; when several target one sink, the **bus resolver**
arbitrates by `priority` (see `BUS_PROTOCOL.md` *Priority*). `Select`/`Combine`
compose *within* one writer; priority arbitrates *between* writers.

## Execution semantics (when a node computes)

Rule 3 defines what value a node *sees* (ZOH at its own rate); this section
defines when a node *runs*. Two activation models, selected by `rate_domain`:

- **Tick domains** (`RATE_RENDER_FRAME`, `RATE_AUDIO_SAMPLE`, `RATE_MUSICAL`) —
  the domain's scheduler evaluates its nodes **once per tick, in topological
  order**. One pass per tick makes the diamond glitch impossible (two paths from
  one upstream change reconverging at a `Combine` can never expose a
  half-updated transient) and keeps rule 5 determinism trivially true.
- **`RATE_CONTROL` is arrival-driven** — there is no control tick. An incoming
  packet (STATE *or* EVENT) immediately evaluates its downstream `RATE_CONTROL`
  nodes. Safe precisely because of rule 4: everything outside the declared
  stateful set is a pure function, so re-entrant evaluation of a
  `Gate → Curve → Scale → Output` chain has no hazard.

**Crossing into a tick domain enqueues.** An arrival-driven path reaching a
tick-domain node does not evaluate it; it queues for that domain's next tick.
STATE crossings collapse to latest (that's just ZOH, rule 3); **EVENT crossings
drain in full at the tick, never coalesced** — the same law as `bus.v1` event
delivery ("a frame-rate receiver must drain *all* pending events per frame").
One queue discipline, bus and router.

Two consequences, enforced/lowered by the compiler:

- **`Smooth` (and `Envelope`) in `RATE_CONTROL` are timestamp-driven.** No tick
  means no fixed dt, so the compiler lowers control-rate filter coefficients to
  the dt-aware form (`α = 1 − e^(−Δt/τ)`, Δt from packet `TimePoint`s) instead
  of fixed per-tick values. Same declared time constants, same wall-clock feel.
  **Δt is clamped to `[0, max]`** (a late, reordered, or bad-clock packet must
  not produce a negative or ten-minute filter step).
- **A multi-writer `Combine` belongs in a tick domain.** In `RATE_CONTROL`, two
  sources alternating packets into one `Combine` re-emit per arrival —
  transient chatter at the sum of their rates. That's inherent to
  arrival-driven evaluation, not a bug; when the chatter isn't acceptable, put
  the `Combine` at a tick rate and let ZOH coalesce its inputs.
- **`Delay` requires a tick** — rule 11.

**Determinism & replay.** Tick domains stay deterministic per rule 5.
Arrival-driven paths are deterministic *given the packet log*: `(source_id,
seq)` + `TimePoint` totally order each source's packets, so replaying a
captured log reproduces the run. The inspector records at the bus, so replay
comes free.

**Storm guard.** Arrival-driven evaluation runs at the publisher's rate, so a
chatty source spends router CPU directly. The manifest's declared
`nominal_rate_hz`/`max_rate_hz` bound the worst case at compile time; the
runtime may rate-limit a source exceeding its declared `max_rate_hz` (staging
doctrine: warn first, enforce when an install needs it).

**Time only arrives with packets** in `RATE_CONTROL`. An arrival-driven graph
experiences time at packet arrival: the keepalive obligation (`bus.v1` →
*Retained state & keepalive*) keeps dwell-style conditions progressing even on
a still signal, but **self-scheduled behavior** — a toll due at minute 47, a
cooldown expiring, a random interval elapsing — has no packet to ride and
needs a tick domain or a plugin's host tick (declared:
`plugin.v1 → requires_host_tick`). Don't build schedulers out of control-rate
stateful nodes; that's choreography, and choreography is a plugin.

### Motivating example — why EVENT paths skip the ticks

The full distributed round trip — VL53L5CX ToF on a remote ESP32 → ESP-NOW →
aggregator → USB → Pi router → USB → ESP-NOW → edge node → WS2812 strip — has
three potential fixed-rate stages in series (sensor period, router tick, node
render loop), each costing up to one full period of waiting:

| Stage | Tick-everywhere | These semantics |
|---|---|---|
| Sensor acquire + I²C read (4×4 @ 60 Hz, lean readout) | ~10–20 ms | ~10–20 ms (physics) |
| Radio + USB hops (×2 each) + conditioning | ~5–8 ms | ~5–8 ms (physics) |
| Router tick | 0–16 ms | **~0** (arrival-driven, both shapes) |
| Node frame wait | 0–16 ms | **~0** for EVENT (apply + render immediately); 0–16 ms for STATE — the strip's own loop is the one intrinsic tick |
| Strip wire time (60 LEDs) | ~2 ms | ~2 ms (physics) |

Net: an EVENT-mapped interaction (presence onset → flash) drops from ~25–45 ms
to **~18–28 ms typical (~15 ms floor)** motion-to-light — at which point the
sensor is 60–70 % of the total and the architecture is no longer the bottleneck
anywhere. A continuous STATE mapping (distance → brightness) keeps the node's
render-loop quantization, as it should: the strip push *is* a frame.

Two corollaries. **Where the EVENT is born is a free choice** — deriving
onset-from-distance in the edge node's conditioning chain or in a Pi-side
`Trigger` node costs the same (<1 ms), since neither waits on a tick; place the
threshold wherever it's easiest to configure. And **EVENT paths inherit
transport jitter directly** — an ESP-NOW retry shows up as a 5–10 ms P99
excursion on the flash timing, where a tick system would have absorbed it into
its (larger, constant) quantization. Invisible for one-shot reactions; for
anything rhythmic, schedule ahead with `Bundle.target_time` ("fire at beat
32.0") and execute on the node's clock — the jitter disappears into the lead
time.

## Resampling & reactivity (latency is a per-mapping choice)

**The platform is not assumed to be slow/atmospheric.** Reactivity ↔ smoothness
↔ latency is a three-way trade made **per mapping**, not globally — some effects
want zero-latency snap, others want inertia. The IR's base behavior is the
*reactive* one; smoothing is an opt-in tool you add when a mapping wants it.

| Want | How (per edge) | Latency |
|---|---|---|
| **Max reactive, continuous** | ZOH straight through — **no `Smooth`** | none |
| **Reactive impulse** | an **EVENT** signal (kick/touch), not smoothed STATE | none |
| **Smooth, inertia OK** | causal `Smooth` (`ONE_POLE`/`SLEW`) | lags ~time-constant |
| **Smooth *and* reactive** | `Smooth` kind **`ONE_EURO`** (adaptive — see below) | low |
| **Smoothest, latency OK** | buffer + true linear interpolation (declared latency) | ~1 sample |

Why bare ZOH (not interpolation) on the reactive path: a live source has **no
future sample** to interpolate toward, so real-time interpolation costs latency
(buffer the source by a sample). ZOH is the zero-latency choice; a causal
`Smooth` *is* the interpolator when you want one, paying its cost as lag rather
than look-ahead. (Authored sources — timeline lanes — are the exception: their
future keyframes are known, so they interpolate truly and latency-free.)

**One Euro filter (`ONE_EURO`) — the "smooth *and* reactive" answer.** An
adaptive low-pass whose cutoff **rises with the signal's speed**: heavy smoothing
at rest (kills sensor jitter when nothing's moving), light smoothing during fast
motion (so a quick gesture comes through with low latency). Two knobs:
`min_cutoff_hz` — the cutoff at rest (lower = smoother but laggier when still);
and `beta` — the speed coefficient (higher = snappier on fast moves). It's cheap
(a pair of one-pole filters + a derivative estimate), so MCU-fine, and it's the
canonical low-jitter/low-latency filter for noisy interactive input (Casiez,
Roussel & Vogel, 2012). Reach for it when a fixed `ONE_POLE` forces you to choose
between "jittery at rest" and "laggy on motion" — `ONE_EURO` gives both ends.

**Default = ZOH / no smoothing** (faithful, zero latency). Don't default mappings
to smoothing; reach for it where inertia is wanted.

## Placement & partitioning (where the graph runs)

There is **one logical project graph, compiled centrally, partitioned across
execution domains** — the hub (Pi), the browser host, and edge (ESP32) nodes.
The IR itself is placement-agnostic; placement is a compiler concern.

- **Hub by default; edge nodes never run an IR interpreter.** What an edge node
  receives at project load is *config, not a graph*: a **binding table** (which
  bus paths feed which plugin inputs — the wiring half of `PluginBinding`) plus
  parameters for the **fixed-function shaping slots** it declares per
  subscribed input (optional curve / scale / smooth). The node's `manifest.v1`
  capability entry enumerates its slots and the plugin assets baked into its
  firmware; the compiler maps a terminal chain (`Curve → Scale → Smooth →`
  plugin input / `Output`) onto those slots and **rejects** anything the node
  can't host — the error pushes that logic back to the hub, never silently
  degrades it.
- **Terminal shaping is inherently node-side** because the rate-domain boundary
  lives on the device: shared control arrives over the radio at control rate,
  while the LED/galvo loop runs at `RATE_RENDER_FRAME`. A member's final
  `Smooth`, its ZOH upsampling, and per-member calibration (gamma, brightness
  limit, color profile — the geometry contract) can only execute where that
  boundary is.
- **Members compute locally** because shipping finished per-member values would
  mean N unicast streams at frame rate; broadcasting the *shared* signals once
  keeps radio traffic O(1) in member count ("no pixels shipped" generalizes to
  "no per-member param streams"). A `Replicated` body *describes* each member's
  slice; for smart members it *executes* on them.
- **Device ≠ member.** One physical node may host several members across
  several groups (two `wave` strips + a `trace` laser on one ESP32): its
  manifest enumerates each member with its own binding + shaping slots.
- **Co-located loops** — when an edge's source and sink live on the same device
  (a touch sensor and a strip on one ESP32), the partitioner may place that
  edge node-side to cut the two radio hops. Same mechanism as the shaping
  slots, motivated by latency instead of bandwidth.

## Examples

**Canonical distance → twist** (the hardcoded `applyAutomation` mapping, as IR):

```yaml
nodes:
  - { id: door,   rate_domain: RATE_CONTROL,      input:  { path: sensor.door.distance_cm } }
  - { id: near,   rate_domain: RATE_RENDER_FRAME, curve:  { input: door, kind: EASE_IN_QUAD, in_min: 75, in_max: 10, out_min: 0, out_max: 1, clamp: true } }
  - { id: smooth, rate_domain: RATE_RENDER_FRAME, smooth: { input: near, kind: ONE_POLE, time_constant_ms: 120 } }
  - { id: out,    rate_domain: RATE_RENDER_FRAME, output: { input: smooth, target: render.raster.maxTwistDeg, shape: STATE, priority: 300, authority_role: sensor } }
```
(`door` is `RATE_CONTROL`; the edge into `near` resamples to render rate — rule 3.
Note `out_max: 1` makes `near`/`smooth` a 0..1 **gain**; the next example composes
it with an authored ceiling to land in degrees.)

**Directorial clamp — timeline × sensor** (multi-source `Combine`): the authored
maxTwistDeg lane bounds the sensor-driven twist, as in Pain Material. The
**timeline is a source** (a "timeline player" engine module advances the project's
authored lane as `clock.*`/section moves and publishes `timeline.maxTwistDeg`,
*truly interpolated between keyframes* — see *Resampling & reactivity*); the clamp
is a `Combine[MUL]` edge:

```yaml
nodes:
  # sensor → 0..1 nearness GAIN (door/near/gain as above)
  - { id: door, rate_domain: RATE_CONTROL,      input:  { path: sensor.door.distance_cm } }
  - { id: near, rate_domain: RATE_RENDER_FRAME, curve:  { input: door, kind: EASE_IN_QUAD, in_min: 75, in_max: 10, out_min: 0, out_max: 1, clamp: true } }
  - { id: gain, rate_domain: RATE_RENDER_FRAME, smooth: { input: near, kind: ONE_POLE, time_constant_ms: 120 } }
  # timeline-authored ceiling, in DEGREES, interpolated between keyframes
  - { id: ceil, rate_domain: RATE_RENDER_FRAME, input:  { path: timeline.maxTwistDeg } }
  # directorial clamp = gain × ceiling  → degrees
  - { id: twist, rate_domain: RATE_RENDER_FRAME, combine: { inputs: [gain, ceil], mode: MUL } }
  - { id: out,   rate_domain: RATE_RENDER_FRAME, output:  { input: twist, target: render.raster.maxTwistDeg, shape: STATE, priority: 300, authority_role: sensor } }
```
A section authoring `maxTwistDeg = 0` disables the sensor twist entirely (×0); a
section authoring 35° lets it scale within 0..35. This is `Combine` (the timeline
*bounds* the sensor), **not** priority (which would *override* it) — and it stays
in the router, so the visualizer just applies the final `maxTwistDeg`.

**Per-channel audio → per-region energy** (wildcard fan-out):

```yaml
reps:
  - over: { match: "audio.*.bass" }
    bind: "${instance}"
    rate_domain: RATE_RENDER_FRAME
    graph:
      nodes:
        - { id: b,   input:  { path: "audio.${instance}.bass" } }
        - { id: out, output: { input: b, target: "render.raster.region_${instance}.energy", shape: STATE, priority: 300 } }
      output_node: out
```

**The wave across the strips** (group choreography → plugin):

```yaml
reps:
  - over: { group: wave }
    bind: "${member}"
    rate_domain: RATE_RENDER_FRAME
    plugin:
      asset: wave.v1
      inputs: { phase: clock.main.beat_phase, energy: audio.main.bass }
      params: { width: 0.25 }
      # Member INDEX/COUNT/POSITION are supplied to the plugin automatically per strip
```

**The reference visualizer's envelope, as IR** (shape conversion — `bassPulse`
is a peak follower over kick events; the onset trigger is the reverse trip):

```yaml
nodes:
  - { id: kick,  rate_domain: RATE_CONTROL,      input:    { path: seq.main.kick } }   # EVENT
  - { id: pulse, rate_domain: RATE_RENDER_FRAME, envelope: { input: kick, mode: PEAK_FOLLOW, release_ms: 75 } }
  - { id: out,   rate_domain: RATE_RENDER_FRAME, output:   { input: pulse, target: render.raster.bassPulse, shape: STATE, priority: 300 } }
  # and STATE → EVENT, the other direction:
  - { id: bass,  rate_domain: RATE_CONTROL,      input:    { path: audio.main.bass } } # STATE
  - { id: onset, rate_domain: RATE_CONTROL,      trigger:  { input: bass, threshold: 0.5, hysteresis: 0.1, edge: RISING } }
  - { id: tear,  rate_domain: RATE_CONTROL,      output:   { input: onset, target: render.raster.sliceTear, shape: EVENT, priority: 300 } }
```

## Relationship to other schemas

- **`manifest.v1`** — the compiler's input: validates paths/types, pulls each
  signal's `range`/`interpolation`/`rate`, resolves group members + geometry for
  `Replicated`, and enforces `ProjectPolicy` on every `Output`.
- **`bus.v1`** — the runtime: `Input` reads packets, `Output` writes them; rate
  domains map onto `TimePoint` domains.
- **Runtime contracts** (`ARCHITECTURE.md`) — this realizes *Router as a typed
  graph IR*; staleness/`on_stale` (from the manifest) governs how `Input`
  behaves when a source goes stale (a `Select FIRST_LIVE` skips stale inputs).

## Where this lives / next

Sibling `.proto` to `bus.proto`/`manifest.proto`, same codegen. The compiler
(manifests + `RouterGraph` → a validated runtime graph) is the first real
consumer to build, replacing `applyAutomation()`. The plugin contract
(`PluginBinding` ↔ a versioned asset's declared input/param interface) is
defined in **[`PLUGIN_CONTRACT.md`](PLUGIN_CONTRACT.md) (`plugin.v1`)**. See
`BACKLOG.md` *Router as a typed graph IR*.

