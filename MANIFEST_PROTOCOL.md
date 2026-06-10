# Capability manifest & policy (`manifest.v1`)

> **Status: draft spec.** The **static, per-module** declaration that
> `BUS_PROTOCOL.md` keeps deferring to — what a module *is*, what it
> publishes/subscribes, and (for emitters) where it sits. Where `bus.v1` is the
> per-packet runtime envelope, `manifest.v1` is the once-per-module registry
> entry the router/UI/supervisor build the system from.
>
> It concretizes several runtime contracts (`ARCHITECTURE.md`): the **identity /
> capability / authorization** three layers, the **per-signal stale/failsafe**
> contract, the **group geometry** contract, and the **authority ladder**.
> Same toolchain and staging doctrine as `bus.v1` (proto-as-IDL; fields present,
> enforcement staged).

Two scopes, related but authored by different parties:

- **`ModuleManifest`** — *module-scoped*, shipped **by** the module (its firmware
  / its config). Capabilities here are **claims**.
- **`ProjectPolicy`** — *project-scoped*, authored by the **operator**. Decides
  which claims are **permitted**, and the authority ladder. (May later split to
  its own `policy.v1`.)

## The IDL

```proto
syntax = "proto3";
package orrery.manifest.v1;

import "common.proto";  // orrery.common.v1.{Value, ValueType, Shape, Range}

// ════════════════════════════════════════════════════════════════
//  MODULE-SCOPED — "what I am; what I publish/subscribe; where I sit."
//  Capabilities are CLAIMS; ProjectPolicy decides what's permitted.
// ════════════════════════════════════════════════════════════════

message ModuleManifest {
  string   schema   = 1;            // "manifest.v1"
  Identity identity = 2;
  string   role     = 3;            // CLAIMED role name → resolved in ProjectPolicy

  repeated SignalDecl publishes  = 4;  // AUTHORITATIVE declaration of each published signal
  repeated SignalDecl subscribes = 5;  // EXPECTATIONS, not declarations — only path /
                                       // value_type / shape are meaningful here (see
                                       // modeling notes); other fields are ignored

  optional GroupMembership group    = 6;  // render-plane emitter members only
  optional Geometry        geometry = 7;  // render-plane emitter members only
}

message Identity {
  string stable_id        = 1;  // "spiffe://pain-material.local/sensor/door-01" — durable, key/cert-backed
  string instance_id      = 2;  // the `instance` segment in this module's paths ("door","ch3","led07")
  string human_label      = 3;  // "Door distance sensor"
  string type             = 4;  // "vl53l1x-distance-node"
  string firmware_version = 5;
  string schema_version   = 6;  // schema this module was built against (compat gate)
  optional string cert_fingerprint = 7;  // enrolled-cert tie; present, unverified while OFF
  optional bytes  manifest_sig     = 8;  // signs THIS manifest (HMAC or signature); present, unverified while OFF
}

message SignalDecl {
  string        path            = 1;  // concrete domain.instance.field, e.g. "sensor.door.distance_cm"
  orrery.common.v1.ValueType value_type = 2;
  orrery.common.v1.Shape     shape      = 3;  // STATE | EVENT
  string        unit            = 4;  // from the PROJECT-PINNED token list ("cm",
                                      // "ratio", "hz", "") — free strings drift
                                      // (cm/centimeter/cms); registry rejects
                                      // tokens outside the project's list
  optional orrery.common.v1.Range range = 5;  // lets the router scale/curve generically
  float         nominal_rate_hz = 6;
  float         max_rate_hz     = 7;
  Interpolation interpolation   = 8;  // how the router fills between samples

  // per-signal failure contract (ARCHITECTURE → Runtime contracts → Failure):
  uint32        stale_after_ms  = 9;   // 0 = never stale, no keepalive obligation (bus.v1 → Retained state)
  OnStale       on_stale        = 10;
  optional orrery.common.v1.Value failsafe = 11;  // value used by DEFAULT / FAIL_SAFE

  bool          dedupe          = 12;  // EVENT signals: receivers dedupe by (source.id, boot_epoch, seq)/dedupe_key

  bool          cyclic          = 13;  // value wraps range.max → range.min (phase-like).
                                       // Interpolation / Smooth / curves must wrap across
                                       // the seam, never traverse the interior (0.95→0.05
                                       // is a step of +0.10, not −0.90)
  Reliability   reliability     = 14;  // delivery class over lossy transports
  string        blob_schema     = 15;  // REQUIRED when value_type = BLOB: the schema id the
                                       // payload decodes as (e.g. "waveparams.v1") — this is
                                       // the declaration bus.v1's `Value.blob` defers to

  // EVENT queue contract — bounded, never SILENTLY lossy (bus.v1 → Event delivery):
  uint32         max_queue        = 16;  // 0 = impl default (64); overflow → overflow_policy
  uint32         max_event_age_ms = 17;  // 0 = no age bound; older-than → late_policy
  OverflowPolicy overflow_policy  = 18;
  LatePolicy     late_policy      = 19;

  uint32        vec_dim          = 20;  // REQUIRED when value_type = VEC — a vec3
                                        // position must not route into an RGB port

  // semantic metadata — manifest/tooling-side, NEVER in packets (keep Value lean).
  // vec_dim makes a position and a color the same shape; semantic tells them apart.
  Semantic      semantic         = 21;  // optional; compiler warns on mismatched routes
  CoordFrame    coord_frame      = 22;  // for positional semantics: relative to what?
}
enum Semantic {
  SEMANTIC_UNSPECIFIED = 0;             // fine for plain scalars
  SEMANTIC_COLOR_RGB        = 1;
  SEMANTIC_POSITION_M       = 2;        // metres, in coord_frame
  SEMANTIC_PHASE            = 3;        // cyclic 0..1 (pair with `cyclic`)
  SEMANTIC_NORMALIZED_RATIO = 4;        // 0..1 gain/amount
  SEMANTIC_MIDI_7BIT        = 5;        // 0..127 quantized at the adapter
}
enum CoordFrame {
  COORD_FRAME_UNSPECIFIED = 0;
  COORD_ROOM = 1;  COORD_GROUP = 2;  COORD_MEMBER = 3;  COORD_SCREEN = 4;
}

// ValueType, Shape, Range → common.proto (orrery.common.v1).
// Interpolation / OnStale are manifest-specific (stay here):
enum Interpolation {
  INTERPOLATION_UNSPECIFIED = 0;
  INTERPOLATION_STEP   = 1;  // hold — integer-count params (e.g. kicksPerTwist)
  INTERPOLATION_LINEAR = 2;  // smooth ramps (e.g. the bpm lane) — the usual default
}
enum OnStale {
  ON_STALE_UNSPECIFIED  = 0;
  ON_STALE_HOLD         = 1;  // keep last value
  ON_STALE_NULL         = 2;  // mark unavailable
  ON_STALE_DEFAULT      = 3;  // snap to `failsafe`
  ON_STALE_DECAY        = 4;  // ramp toward `failsafe`
  ON_STALE_FREEZE_ROUTE = 5;  // freeze the downstream route
  ON_STALE_FAIL_SAFE    = 6;  // assert the safety value (lasers / audio)
}
enum OverflowPolicy {         // queue full — every drop is COUNTED into _meta, never silent
  OVERFLOW_POLICY_UNSPECIFIED = 0;  // → DROP_OLDEST
  OVERFLOW_DROP_OLDEST = 1;         // ring buffer (newest events are the show)
  OVERFLOW_DROP_NEWEST = 2;
  OVERFLOW_FAIL_ROUTE  = 3;         // treat the signal as stale → its on_stale path
}
enum LatePolicy {             // event older than max_event_age_ms at delivery time
  LATE_POLICY_UNSPECIFIED = 0;      // → DROP
  LATE_DROP           = 1;          // a 5 s burst of stale triggers after a reconnect
                                    // is worse than a visible, counted drop
  LATE_FIRE           = 2;          // deliver anyway (OSC's late-bundle rule)
  LATE_COMPRESS_COUNT = 3;          // deliver ONE event whose payload = dropped count
}
enum Reliability {            // DDS/ROS QoS in miniature; transports honor per signal
  RELIABILITY_UNSPECIFIED = 0;  // → BEST_EFFORT
  RELIABILITY_BEST_EFFORT = 1;  // fire-and-forget; loss stays VISIBLE via
                                // (boot_epoch, seq) gap counters → the inspector
  RELIABILITY_ACKED       = 2;  // the transport adapter acks + retransmits
                                // (app-level over ESP-NOW). NOTE: safety-critical
                                // paths should be STATE-shaped (level-triggered,
                                // retained, kept alive) — not ACKED events; a
                                // blackout is a level, not an edge
}

// ── render-plane emitter placement ──────────────────────────────

message GroupMembership {
  string group = 1;             // emitter-group id ("wave", "raster", "laser-array")
  uint32 index = 2;             // member index within the group (strip 3 of 4)
  optional uint32 count = 3;    // total members — for f(phase, index, count) local render
}

// "position is not one number" — ARCHITECTURE → Runtime contracts → Group geometry.
message Geometry {
  Topology topology           = 1;
  optional Vec3  position_m    = 2;                  // physical, metres in room
  repeated float logical       = 3 [packed = true];  // member's span on the group's normalized
                                                     // axes — LINE/RING: [begin, end];
                                                     // GRID: [u0, v0, u1, v1]; POINT: [u, v]
  optional Vec3  orientation   = 4;                  // facing / rotation
  repeated float calibration   = 5 [packed = true];  // row-major transform; length disambiguates:
                                                     // 9 = 3×3 homography (2-D warp), 16 = 4×4
  uint32 latency_offset_ms     = 6;                  // this member's output-pipeline LAG vs the
                                                     // group reference; schedulers lead it to match
  string color_profile         = 7;                  // "srgb" | "ws2812-grb" | gamma id
  optional float brightness_limit = 8;               // 0..1 hard cap
  optional SafeEnvelope safe    = 9;
}
message Vec3 { float x = 1; float y = 2; float z = 3; }
// ENFORCED NODE-LOCAL, LAST IN THE CHAIN. The envelope is a property of the
// device, applied after every bus-driven input — no packet at any priority can
// exceed it. Upstream (router) clamping is an optimization, never the safety.
message SafeEnvelope {
  optional float max_brightness  = 1;  // 0..1 hard cap
  optional float scan_min_deg    = 2;  // laser scan-angle limits
  optional float scan_max_deg    = 3;
  optional bool  require_blanking = 4; // blank when outside envelope
  optional float max_flash_hz    = 5;  // photosensitivity guard
}
enum Topology {
  TOPOLOGY_UNSPECIFIED = 0;
  TOPOLOGY_POINT = 1;  TOPOLOGY_LINE = 2;  TOPOLOGY_RING = 3;
  TOPOLOGY_GRID  = 4;  TOPOLOGY_GRAPH = 5;
}

// ════════════════════════════════════════════════════════════════
//  PROJECT-SCOPED — authored by the operator; decides which claims
//  are permitted, and the authority ladder.
// ════════════════════════════════════════════════════════════════

message ProjectPolicy {
  string schema  = 1;                        // "policy.v1"
  string project = 2;                        // installation name
  map<string, uint32> authority_ladder = 3;  // name → priority (safety:1000 … idle:100)
  repeated Role      roles = 4;
  repeated TrustedId allow = 5;              // enrolled-id → role binding (the allowlist)
  repeated GroupDef  groups = 6;             // the PROJECT defines groups; members only claim
  RuntimeModes runtime_modes = 7;            // staging state as LIVE CONFIG, runtime-visible
}
message GroupDef {
  string group = 1;                          // id ("wave")
  uint32 count = 2;                          // expected member count — registry validates claims
}
// The enforcement-off matrix (bus.v1) as config, not doc convention. The
// inspector BANNERS any show running a permissive mode — staged enforcement
// must never *look* enforced.
message RuntimeModes {
  Mode auth      = 1;                        // OFF | WARN | ENFORCE (authorization checks)
  Sig  signature = 2;                        // NONE | HMAC | MTLS
  Mode priority  = 3;                        // OFF = last-writer-wins | WARN | ENFORCE (full ladder)
  Mode time_sync = 4;                        // OFF = local-only | WARN = offset-estimated | ENFORCE = required
  // safety has NO field on purpose: SafeEnvelope enforcement is unconditional,
  // node-local, on from day one. There is no permissive mode to declare.
  enum Mode { MODE_UNSPECIFIED = 0; OFF = 1; WARN = 2; ENFORCE = 3; }
  enum Sig  { SIG_UNSPECIFIED = 0; NONE = 1; HMAC = 2; MTLS = 3; }
}
message Role {
  string name = 1;
  repeated string can_publish    = 2;  // path globs; ${instance} expands to the module's instance_id
  repeated string cannot_publish = 3;  // explicit denials (clock.* / safety.* / laser.* …)
  repeated string can_subscribe  = 4;
  uint32 max_priority = 5;             // ceiling this role may assert on a packet
}
message TrustedId {
  string stable_id   = 1;  // spiffe://…
  string role        = 2;
  string instance_id = 3;  // expected instance for this id
}
```

## Modeling notes

- **Claims vs. permissions.** `ModuleManifest.publishes/subscribes` is what a
  module *wants*; `ProjectPolicy.roles` is what it *may*. The resolver intersects
  them — a sensor manifest claiming `clock.tempo` is simply denied. This is why
  the manifest can be shipped by (untrusted) firmware safely.
- **`failsafe` reuses `orrery.common.v1.Value`** (the import) — the value snapped to
  on `DEFAULT`/`FAIL_SAFE` is the same type carried on the wire. One value model.
- **Geometry is emitter-only and optional** — a sensor has no `group`/`geometry`;
  an LED strip member carries both. `index`+`count` are what make a group's
  `f(phase, index, count)` render locally (the distributed-render principle).
- **`manifest_sig`** signs the manifest itself; like `bus.v1`'s `sig` it is
  `bytes` (HMAC or signature) and **present-but-unverified** until enforcement is
  enabled — same staging doctrine.
- **Lifecycle is runtime, not here.** The manifest is the static declaration; the
  `discovered→…→removed` FSM lives in the supervisor.
- **`subscribes` are expectations, not declarations.** The publisher's
  `SignalDecl` is authoritative for a signal's type/shape/unit/range/rates/
  staleness. A subscribe entry claims only *path + value_type + shape*, which
  the registry checks for compatibility: a mismatch is an error; an
  expected-but-absent publisher is a **health condition** (lifecycle), not
  silent absence. All other fields on a subscribe entry are ignored.
- **The project defines groups; members only claim membership.**
  `ProjectPolicy.groups` is the authority. The registry validates claims
  against it: a duplicate `index`, an `index ≥ count`, or a member `count`
  disagreeing with the `GroupDef` **rejects the manifest**; an expected index
  with no enrolled member is a **health condition** — mirroring the router's
  `match_against: EXPECTED` (deterministic, boot-order-independent).

## Reliability recipes (semantic profiles — informative, not wire schema)

The delivery primitives (`shape`, `dedupe`, `stale_after_ms`/`on_stale`,
`max_queue`/`max_event_age_ms`/`overflow_policy`/`late_policy`, `reliability`,
retention) are deliberately **orthogonal** — no profile enum on the wire. But
the *compositions* recur, and they deserve names: docs, golden traces, and the
inspector use these to say what a signal's effective behavior **is** without
reciting six fields. Authoring tools MAY carry `semantic_profile:` as an
annotation that compiles away; it never appears in a packet.

| Profile | shape | Key fields | Effective behavior / use |
|---|---|---|---|
| `retained_keepalive_state` | STATE | `stale_after_ms > 0`, BEST_EFFORT | The default continuous signal (sensor reading, level): republished within the stale window, retained for late joiners, `on_stale` decides failure. |
| `safety_asserted_state` | STATE | short `stale_after_ms`, `on_stale: FAIL_SAFE` + `failsafe`, BEST_EFFORT | The blackout / laser-enable pattern: **a level, not an edge** — continuously asserted; silence itself trips the failsafe. Acks add nothing a heartbeat doesn't. |
| `static_config_state` | STATE | `stale_after_ms = 0`, BEST_EFFORT | Palette, params: publish-on-change only, never stale, retention alone serves late joiners. |
| `bounded_deduped_event` | EVENT | `dedupe`, `max_event_age_ms ≈ 100`, `LATE_DROP`, `OVERFLOW_DROP_OLDEST`, BEST_EFFORT | Performance triggers (touch onset, kick): a late trigger is worse than a missing one; drops are counted, never silent. |
| `acked_command_event` | EVENT | `dedupe`, `max_event_age_ms ≈ 1000`, `LATE_FIRE`, ACKED | Transactional commands (preset load, route change): must arrive, may arrive late, never twice. |
| `counted_burst_event` | EVENT | small `max_queue`, `LATE_COMPRESS_COUNT`, BEST_EFFORT | High-rate countable triggers where *how many* matters more than *which* (grain/particle spawns): overflow degrades to a count, not a stall. |

The **simulator and inspector render the effective behavior** — derived from
the actual fields, with the matching profile name shown as a tag when a
signal's fields equal a known recipe. A near-miss (five fields of
`safety_asserted_state` but `on_stale: HOLD`) is exactly the kind of thing the
inspector should surface as a "did you mean" — the recipes are lint
vocabulary, not law.

## Normative device signals

Two conventions every module follows (the lifecycle FSM and install-day
tooling depend on them):

- **`device.<instance>.health`** (BOOL, STATE) — modules **MUST** publish it;
  its `stale_after_ms` is the module's heartbeat interval and is what drives
  the supervisor's `active → degraded → stale` transitions.
- **`device.<instance>.identify`** (BOOL, STATE) — emitter/sensor nodes
  **SHOULD** subscribe; while true the device makes itself visible (blink the
  strip, pulse the status LED). Art-Net/RDM's *identify device*: with thirty
  nodes in a dark room, this is how you find strip 7.
- Edge/wireless nodes **SHOULD** also publish the link-health set —
  `_meta.<instance>.{rssi, retries, battery_v, boot_count, uptime_s,
  queue_depth}` — the fields that turn "strip 7 is flaky" from a vibe into a
  diagnosis (brownout loops show as climbing `boot_count`; RF trouble as
  `retries`; a stuck consumer as `queue_depth`).

## Pairing registry (supervisor-side; sketch)

`ModuleManifest` is what a module *claims*; `ProjectPolicy` is what the
operator *permits*; the **pairing registry** is what the supervisor
*remembers* — the operational identity state neither of the others can hold.
One entry per enrolled `stable_id` (a future `pairing.v1`; sketched here so
the questions it answers have a home):

```proto
message PairingState {
  string stable_id        = 1;
  bytes  session_key      = 2;  // current HMAC key (established at pairing)
  uint32 last_boot_epoch  = 3;  // + last_seq = the high-water mark:
  uint64 last_seq         = 4;  //   clone/replay detection (see below)
  uint64 last_seen_ms     = 5;
  string firmware_hash    = 6;
  Trust  trust            = 7;  // operator-visible
  enum Trust { TRUST_UNSPECIFIED = 0; ENROLLED = 1; QUARANTINED = 2; REVOKED = 3; }
}
```

This is what answers the operational questions the manifests can't:
**duplicate `stable_id`** → the second claimant is QUARANTINED (first-enrolled
wins until the operator decides); **duplicate `instance_id`** → rejected at
enrollment (the `TrustedId` binding is one-to-one); **revocation** → flip to
REVOKED, drop at ingress; **key rotation** → re-pair (the
asymmetric-at-pairing handshake exists precisely so rotation is cheap);
**"rebooted" vs "cloned"** → a real reboot raises `boot_epoch` *above* the
high-water mark, a clone replays *at or below* it. The registry is persisted
by the supervisor and backed up with the project — losing it means re-pairing
the fleet, not a corrupted show.

The fields are half the system; the **operator ceremony is the other half**,
and it gets documented as a **runbook, not a schema** (required before the
first enforced install): how the operator confirms the physical device in
hand is the one claiming `door-01` (identify-blink during enrollment);
registry-lost-five-minutes-before-doors recovery; an emergency
"trust all local devices tonight" mode that is **loudly unsafe** in the
inspector; and whether `firmware_hash` is advisory or pinned per project.

## Examples (illustrative, shown as YAML)

A distance sensor node — pure **source**:

```yaml
identity:
  stable_id: spiffe://pain-material.local/sensor/door-01
  instance_id: door
  human_label: Door distance sensor
  type: vl53l1x-distance-node
  firmware_version: "1.4.2"
  schema_version: manifest.v1
role: sensor_node
publishes:
  - path: sensor.door.distance_cm
    value_type: FLOAT
    shape: STATE
    unit: cm
    range: { min: 0, max: 400 }
    nominal_rate_hz: 30
    max_rate_hz: 60
    interpolation: LINEAR
    stale_after_ms: 250
    on_stale: HOLD          # then NULL — modeled as HOLD with a short window upstream
  - path: device.door.health
    value_type: BOOL
    shape: STATE
    stale_after_ms: 3000
    on_stale: NULL
subscribes: []
```

An LED strip render node — **emitter** (a group member, mostly subscribes):

```yaml
identity:
  stable_id: spiffe://pain-material.local/render/led-07
  instance_id: led07
  type: ws2812-strip-node
  schema_version: manifest.v1
role: render_node
subscribes:
  # clock arrives as a (beat, tempo) tuple; PHASE IS EXTRAPOLATED LOCALLY —
  # never shipped sampled (ARCHITECTURE → Clock distribution)
  - { path: clock.main.beat,       value_type: FLOAT, shape: STATE }
  - { path: clock.main.tempo,      value_type: FLOAT, shape: STATE }
  - { path: audio.main.bass,       value_type: FLOAT, shape: STATE }
  - { path: render.wave.params,    value_type: BLOB,  shape: STATE, blob_schema: waveparams.v1 }
publishes:
  - { path: device.led07.health,   value_type: BOOL,  shape: STATE, stale_after_ms: 2000, on_stale: NULL }
group:   { group: wave, index: 2, count: 4 }     # strip 3 of 4 → renders its slice locally
geometry:
  topology: LINE
  position_m: { x: 2.4, y: 1.8, z: 0.0 }
  logical: [0.5, 0.75]
  color_profile: ws2812-grb
  brightness_limit: 0.8
  safe: { max_brightness: 0.9, max_flash_hz: 3.0 }   # photosensitivity guard
```

The installation's **ProjectPolicy** (operator-authored):

```yaml
schema: policy.v1
project: pain-material
authority_ladder:
  safety: 1000
  manual_blackout: 900
  local_ui: 700
  timeline: 500
  generative: 400
  sensor: 300
  idle: 100
roles:
  - name: sensor_node
    can_publish:    ["sensor.${instance}.*", "device.${instance}.*", "audio.${instance}.level"]
    cannot_publish: ["clock.*", "safety.*", "laser.*", "transport.*"]
    max_priority: 300
  - name: render_node
    can_subscribe:  ["clock.*", "audio.*", "render.*", "palette.*", "device.${instance}.identify"]
    can_publish:    ["device.${instance}.*"]
    max_priority: 100
  - name: supervisor
    can_publish:    ["clock.*", "project.*", "safety.*"]
    max_priority: 1000
groups:
  - { group: wave, count: 4 }
allow:
  - { stable_id: spiffe://pain-material.local/sensor/door-01, role: sensor_node, instance_id: door }
  - { stable_id: spiffe://pain-material.local/render/led-07,  role: render_node, instance_id: led07 }
```

## Relationship to other schemas / contracts

- **`bus.v1`** (`BUS_PROTOCOL.md`) — runtime packets; the manifest declares the
  *static* properties (`unit`/`range`/`rate`/`stale`/`on_stale`/`failsafe`) the
  packet stays lean by omitting, plus the identity the packet's `source_id`
  refers to.
- **Router IR** (`BACKLOG.md` *Router as a typed graph IR*) — consumes manifests
  to know the routable namespace, each signal's `range`/`interpolation` (for
  scale/curve nodes) and `rate` (for `rate_domain` discipline), and the group
  definitions to wire emitter members.
- **Runtime contracts** (`ARCHITECTURE.md`) — this file *is* the concrete form of
  Identity/Capability/Authorization, the per-signal Failure contract, the Group
  geometry contract, and the Authority ladder.

## Where this lives / next

Sibling `.proto` to `bus.proto`, same codegen (`ts-proto` / `prost`+serde /
`nanopb`-or-`femtopb`). Manifests are emitted by modules (firmware/config) and
collected by the supervisor into the **capability registry** the router/UI/
inspector read. Next: stand up the registry + the manifest read path alongside
the `bus.v1` work — see `BACKLOG.md` *Capability registry*. Pre-1.0, field
numbers churn freely.
