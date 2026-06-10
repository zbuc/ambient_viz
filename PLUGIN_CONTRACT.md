# Plugin contract (`plugin.v1`)

> **Status: draft spec.** The **stable interface a versioned code asset exposes**
> — its inputs, params, and outputs — so the router's `PluginBinding`
> (`ROUTER_IR.md`) can wire it and the compiler can validate the wiring. This is
> the Houdini-HDA idea: a plugin packages arbitrary internal logic (the wave
> math, a raster render pipeline, a laser tracer) behind a **declared, versioned
> parameter interface**; the rest of the system binds to the interface, never the
> internals.
>
> It closes the one remaining hole in the data model: the IR deliberately is
> *not* a generative-math language (`ROUTER_IR.md` → *wire & shape, don't
> compute*), so anything generative is a plugin — and this is the contract those
> plugins satisfy.

A plugin is **not** a module (`manifest.v1` is a *device's* self-declaration);
it's a **code asset** that consumes bound inputs + params and produces outputs.
The contract is **language-agnostic**: one `plugin.v1` manifest may have several
implementations (JS for the browser host, Rust for an ESP render node) that all
satisfy it — the binding targets the *contract*, the registry picks the impl per
node.

## The IDL

```proto
syntax = "proto3";
package orrery.plugin.v1;

import "common.proto";  // orrery.common.v1.{Value, ValueType, Shape, Range, RateDomain, MemberParam}

message PluginManifest {
  string asset          = 1;   // "wave" — stable asset name; bind target is "<asset>.v<version>"
  uint32 version        = 2;   // major version = contract-compatibility boundary
  Kind   kind           = 3;
  string human_label    = 4;
  string schema_version = 5;   // "plugin.v1"

  repeated Port  inputs  = 6;   // bound by PluginBinding.inputs
  repeated Param params  = 7;   // set  by PluginBinding.params
  repeated Port  outputs = 8;   // where results go (emitter / bus / per-member)

  // per-member context the runtime supplies automatically (choreographies):
  repeated orrery.common.v1.MemberParam member_needs = 9;  // MEMBER_INDEX/COUNT/LOGICAL/POSITION
  orrery.common.v1.RateDomain rate_domain = 10;

  // execution contract — what the host must provide and the simulator can prove:
  bool requires_host_tick = 11;  // plugin has self-scheduled behavior (timers,
                                 // cooldowns, random intervals): the host MUST
                                 // drive it on a tick even with no input packets.
                                 // false = purely input/frame-reactive.
  Determinism determinism = 12;
  StateModel  state_model = 13;

  enum Determinism {
    DETERMINISM_UNSPECIFIED = 0;  // → REPLAYABLE (the default obligation)
    REPLAYABLE       = 1;  // same seed + input trace → same outputs; golden-traceable
    REALTIME_ONLY    = 2;  // depends on real timing (live audio callback); simulator
                           // can check invariants but not exact outputs
    EXTERNAL_IO      = 3;  // touches the world (filesystem/network/devices) —
                           // not replayable; quarantined from golden traces
  }
  enum StateModel {
    STATE_MODEL_UNSPECIFIED = 0;  // → OPAQUE
    STATELESS     = 1;  // pure f(inputs, member ctx) — trivially reloadable
    SNAPSHOTTABLE = 2;  // host can snapshot/restore state (reload/replay-resume)
    OPAQUE        = 3;  // state exists but can't be captured — reload = reinit + ramp
  }

  enum Kind {
    KIND_UNSPECIFIED = 0;
    SCENE_RASTER = 1;  // raster scene → screen emitter (+ optional abstract field)
    CHOREOGRAPHY = 2;  // per-member render (the wave) → emitter-group members
    VECTOR_LASER = 3;  // field/frame → ILDA vector path
    FX           = 4;  // audio-plane FX choreography
    GENERATOR    = 5;  // emits seq.*/control back onto the bus
  }
}

message Port {
  string name = 1;                                    // local port name = the binding key
  orrery.common.v1.ValueType value_type = 2;
  orrery.common.v1.Shape     shape      = 3;         // STATE | EVENT
  string unit = 4;
  optional orrery.common.v1.Range range = 5;
  bool   required = 6;                                 // input: must be bound; output: always produced

  // outputs only:
  Dest   dest  = 7;                                   // EMITTER | BUS | MEMBER
  Media  media = 8;                                   // what kind of thing this output is
  optional string bus_path = 9;                       // dest=BUS → published path (may use ${group})

  enum Dest  { DEST_UNSPECIFIED=0; EMITTER=1; BUS=2; MEMBER=3; }
  enum Media { MEDIA_UNSPECIFIED=0; RASTER_FRAME=1; ABSTRACT_FIELD=2; VECTOR_PATH=3; PER_MEMBER_VALUE=4; SIGNAL=5; }
}

message Param {
  string name = 1;
  orrery.common.v1.ValueType value_type = 2;
  optional orrery.common.v1.Value default = 3;       // absent default → required
  optional orrery.common.v1.Range range = 4;
  repeated string enum_values = 5;                     // for enumerated params
}
```

> **Shared-vocab note.** `Value`/`ValueType`/`Shape`/`Range`/`RateDomain`/
> `MemberParam` live in [`COMMON_PROTO.md`](COMMON_PROTO.md) (`orrery.common.v1`)
> — this schema imports only `common`. (`member_needs` reuses `MemberParam`, which
> was previously mis-referenced as `manifest.v1.Member.Which`; the extraction fixes
> that.) Import graph is a clean star — see `COMMON_PROTO.md`.

## How a binding resolves

In the router, a `Replicated` (or a future node) carries a `PluginBinding`:

```yaml
plugin:
  asset: wave.v1                                   # → PluginManifest{asset:wave, version:1}
  inputs: { phase: clock.main.beat_phase,          # port name → bus path OR router node id
            energy: audio.main.bass }
  params: { width: 0.25 }                          # port name → value
```

The compiler resolves `wave.v1` against the **plugin registry**, then checks the
binding against the manifest (next section). At runtime the host feeds the bound
inputs + member context into the plugin instance and routes its outputs.

### Randomness (seeded, replayable)

A plugin that wants randomness — skip probabilities, random intervals, timbre
rolls, phrase picks; the irregular-recurrence aesthetic runs on these — MUST
take it from the **host-supplied seeded PRNG**, never wall-clock or an ambient
RNG. The seed is part of instantiation and is recorded in golden fixtures and
the trace simulator, so stochastic choreography stays **replayable**: same
seed + same input trace → the same strikes, every run. Fixture tolerances
exist for float drift across impls, not to excuse nondeterminism a test can't
reproduce.

### Event delivery (no coalescing)

A port whose `shape` is **EVENT** receives, per invocation, the **drained queue
of events since the last invocation** — possibly empty, possibly several — never
a collapsed latest-value. This mirrors `bus.v1` event delivery and the router's
queue-crossing rule (`ROUTER_IR.md` → *Execution semantics*): a plugin ticking
at `RATE_RENDER_FRAME` that saw only "the latest" `kick` would silently miss
double-triggers — the bug class the EVENT shape exists to kill. **STATE** ports
receive the ZOH-sampled latest value.

## Compiler validation (the contract is enforced)

1. **Inputs** — every `PluginBinding.inputs` key matches a declared input `Port`;
   the bound source's `value_type`/`shape` match the port; **all `required`
   inputs are bound**; extra keys are an error.
2. **Params** — every key matches a declared `Param`; value within `range`/
   `enum_values`; params with no `default` must be set.
3. **Member context** — if `member_needs` is non-empty, the binding must sit in a
   `Replicated over: GROUP:*` whose members supply that geometry/index (else
   error).
4. **Outputs** — `EMITTER` outputs require the binding be attached to an
   emitter/group; `BUS` outputs are published at `bus_path` (and must pass
   `ProjectPolicy` like any writer); `MEMBER` outputs require a group context.
5. **Version** — `asset.vN` resolves to a registered manifest with matching
   `asset` + `version`; a missing/incompatible version is a compile error, not a
   runtime surprise.
6. **Placement & rate** — the binding's execution target must have a registered
   impl for this asset, and the asset's `rate_domain` must be schedulable
   there: a `RATE_AUDIO_SAMPLE` or tick-accurate `RATE_MUSICAL` plugin (a
   `GENERATOR` emitting sample-accurate `seq.*`) can only be placed on a host
   with that clock (the Daisy host, an audio sidecar) — never a browser
   `frame()` loop. Missing impl-for-target or unschedulable rate = compile
   error.

## Output kinds (`Media`) and where they go

| `Media` | `Dest` | Consumed by |
|---|---|---|
| `RASTER_FRAME` | EMITTER | the screen compositor (Chromium host) |
| `PER_MEMBER_VALUE` | MEMBER | the calling member's emitter (an LED's color) — runs *on* the node when distributed |
| `VECTOR_PATH` | EMITTER | a laser/ILDA DAC node |
| `ABSTRACT_FIELD` | BUS | published (e.g. `render.${group}.field`) for *other* groups' cross-group coherence |
| `SIGNAL` | BUS | a `GENERATOR` emitting `seq.*`/control back onto the bus |

## Examples

**`wave.v1`** — the strip wave (a `CHOREOGRAPHY`):

```yaml
asset: wave
version: 1
kind: CHOREOGRAPHY
human_label: Strip wave
inputs:
  - { name: phase,  value_type: FLOAT, shape: STATE, required: true }
  - { name: energy, value_type: FLOAT, shape: STATE, required: false }
params:
  - { name: width, value_type: FLOAT, default: 0.25, range: { min: 0, max: 1 } }
member_needs: [INDEX, COUNT]                         # runtime injects each strip's index/count
outputs:
  - { name: rgb, value_type: VEC, media: PER_MEMBER_VALUE, dest: MEMBER, required: true }
rate_domain: RATE_RENDER_FRAME
```

**`laser.edge_tracer.v1`** — trace the on-screen silhouette (a `VECTOR_LASER`):

```yaml
asset: edge_tracer
version: 1
kind: VECTOR_LASER
inputs:
  - { name: field, value_type: BLOB,  shape: STATE, required: true }   # the abstract scene field
  - { name: phase, value_type: FLOAT, shape: STATE, required: false }
params:
  - { name: scan_rate,         value_type: FLOAT, default: 20000 }
  - { name: intensity,         value_type: FLOAT, default: 0.7, range: { min: 0, max: 1 } }
  - { name: simplify_tolerance, value_type: FLOAT, default: 0.01 }
outputs:
  - { name: path, value_type: BLOB, media: VECTOR_PATH, dest: EMITTER, required: true }
rate_domain: RATE_RENDER_FRAME
```

**The Pain Material raster scene** — `SCENE_RASTER`; its contract **formalizes
[`PARAMETERS.md`](PARAMETERS.md)** (the visualizer's parameter surface becomes the
plugin's typed inputs/params):

```yaml
asset: pain_material_raster
version: 1
kind: SCENE_RASTER
inputs:                                              # the per-frame signal surface
  - { name: maxTwistDeg, value_type: FLOAT, shape: STATE, unit: deg }
  - { name: bass,        value_type: FLOAT, shape: STATE }
  - { name: kick,        value_type: FLOAT, shape: EVENT }
  # … the rest of PARAMETERS.md, typed
params:                                              # the tunables (constants today)
  - { name: latticeSpacing, value_type: INT,   default: 24 }
  - { name: grainRes,       value_type: INT,   default: 320 }
outputs:
  - { name: frame, value_type: BLOB, media: RASTER_FRAME,   dest: EMITTER, required: true }
  - { name: field, value_type: BLOB, media: ABSTRACT_FIELD, dest: BUS, bus_path: "render.raster.field", required: false }
rate_domain: RATE_RENDER_FRAME
```

The optional `field` output is the **Tier-2 abstract scene** (`ARCHITECTURE.md` →
render plane): this raster scene stays screen-local *and* optionally emits a small
field so a laser/LED group can stay geometrically coherent with it.

## Versioning & implementations

- **Version = contract boundary.** Adding an optional input/param is compatible;
  removing/retyping/making-required is a **major bump** (`wave.v1` → `wave.v2`). A
  project binds to a specific major; the registry refuses an incompatible swap.
- **One contract, many impls.** `wave.v1` may ship a JS impl (browser preview /
  Chromium-driven LEDs) and a Rust impl (ESP render node) — both satisfy the same
  manifest. The registry maps `asset.version → {manifest, impls-per-target}`; the
  binding never names an implementation.
- **Same major version = behaviorally compatible, across every impl.** The
  interface match is checkable; the *behavior* match is the asset's
  responsibility — two strips on the Rust impl and a browser preview on the JS
  impl must render the same wave. Ship **golden fixtures** with the asset
  (canonical input traces → reference outputs, with tolerances); the registry
  runs them against each impl. (Houdini HDAs have exactly this failure mode:
  same interface, drifted internals.)

## Runtime lifecycle (deliberately not in `plugin.v1`)

Instantiation, `init/resize/frame/dispose` signatures, state across hot-reload,
and state migration on a major-version swap are **host-API concerns**, defined
per host implementation — not in this schema. `plugin.v1` is the *wiring*
contract. Three things are normative now: a plugin's internal state does
**not** survive a major-version swap (no migration promise); EVENT input
queues follow *Event delivery* above across reloads (drained, never coalesced,
never replayed); and a **plugin crash drops its outputs to each bound sink's
manifest `failsafe`**, applied under the node-local `SafeEnvelope` — a crashed
wave never strobes a strip. "Crash" includes the watchdog cases: a **stall**
(frame budget blown), a **non-finite output**, or an **overrun** is treated by
the host exactly like a panic — same failsafe path, counted into `_meta`. The
rest lands with the host refactor (`BACKLOG.md` → plugin boundary).

## Relationship to the other schemas

- **`router.v1`** — `PluginBinding` is the call site; the compiler validates it
  against the `PluginManifest`. The IR wires/shapes; the plugin computes.
- **`common.v1`** — ports/params reuse `ValueType`/`Shape`/`Range`/`Value` and
  `member_needs` reuses `MemberParam`. **`manifest.v1`** — a plugin's
  `member_needs` are satisfied from the bound group members' geometry.
- **`bus.v1`** — `BUS`/`SIGNAL` outputs publish packets; `SIGNAL` (`GENERATOR`
  plugins) is how generative logic re-enters the control plane as `seq.*`.

## Where this lives / next

Sibling `.proto` to `bus`/`manifest`/`router`, same codegen. With it the data
model is complete: `bus.v1` (runtime packets) · `manifest.v1` (static capability)
· `router.v1` (compiled graph) · `plugin.v1` (code-asset interface). Next is the
**`common.proto` extraction** (shared vocab) and then the shift from spec to
implementation (stand up the `.proto`s + the router compiler + a plugin registry).
See `BACKLOG.md` *Router as a typed graph IR*.
