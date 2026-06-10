# Control-bus packet protocol (`bus.v1`)

> **Status: draft spec.** The canonical wire/struct format for the control plane
> — the packet envelope every runtime contract's fields hang off. Foundation
> item from `BACKLOG.md` (Runtime contracts); per `ARCHITECTURE.md` *Runtime
> contracts → Transport shapes* it must be pinned down **before** the router IR
> gets elaborate.

## Format decision — Protobuf as the schema of record

**Decided: a `.proto` IDL is the single source of truth**, codegen'd to every
language in the fleet. Rationale (full CBOR/TS/proto trade in conversation
2026-06-10):

- **One schema → TS + Rust + C**, eliminating the hand-mirror drift across a
  genuinely multi-language fleet (browser JS, Pi/host Rust, Daisy firmware Rust,
  ESP nodes Rust/C).
- **Compact binary wire** for the constrained, radio-bound edges (ESP-NOW ≈250 B
  frames); proto's integer field tags + varints beat self-describing CBOR on
  both size and decode CPU for fixed-schema messages.
- **Readability is *not* sacrificed:** `prost` + **`protoc-gen-prost-serde`**
  give the Rust types `serde` derives, so the host emits/*reads* **proto-JSON**
  too — readable logs, the signal/route inspector, hand-authored fixtures —
  from the same `.proto`. (`protoc-gen-prost-serde` on crates.io.)
- **Real schema evolution** (field numbers + `reserved` + `optional` presence)
  for field-deployed nodes that can't be reflashed at 2 a.m.
- **Decouples the ESP node language** from the wire: proto-as-IDL means the
  contract is the wire, so a node can be **Rust *or* C** and still speak
  `bus.v1` — C+nanopb stays a clean fallback if the Rust radio stack disappoints
  (see `ESP32_SENSOR_NETWORK.md`).

CBOR was the runner-up (lighter toolchain, self-describing, mature `no_std` Rust
via `minicbor`) — rejected because we *want* the codegen + evolution discipline
and don't need schemaless flexibility. *Considered and not chosen: TS-types-as-
schema* (no cross-language codegen, no binary wire for ESP).

**Staging doctrine still holds** (`ARCHITECTURE.md`): every field below ships
now; signature verification / cross-domain time conversion / full priority
arbitration are no-ops until needed. See *Enforcement-off matrix*. Pre-1.0 we
churn field numbers freely (nobody depends on the wire yet); the discipline
starts at `v1` freeze.

## The IDL

```proto
syntax = "proto3";
package orrery.bus.v1;
import "common.proto";  // orrery.common.v1.Value

// ─────────────────────────────────────────────────────────────
//  Routing address vs. identity (deliberately separate)
//    SignalPath  = `domain.instance.field` — WHERE a value goes (a string field
//                  below); instance ALWAYS explicit, no collapse to flat names.
//    SourceId    = durable publisher identity (SPIFFE-style), survives renames.
// ─────────────────────────────────────────────────────────────

message Source {
  string source_id        = 1;  // "spiffe://pain-material.local/sensor/door-01"
  uint64 seq              = 2;  // monotonic per source WITHIN one boot_epoch —
                                // ordering + dedup even with enforcement OFF
  optional bytes  sig             = 3;  // signature/HMAC; ignored while OFF
  optional string cert_fingerprint = 4; // enrolled-cert tie; ignored while OFF
  uint32 boot_epoch       = 5;  // increments (persisted counter) or re-randomizes
                                // each boot. Ordering key = (boot_epoch, seq):
                                // without it, a rebooted node's fresh seq=1 loses
                                // to its own pre-reboot packets and the node goes
                                // silent from the bus's point of view.
}

// A timestamp tagged with its timebase. Domains are NOT interchangeable;
// cross-domain conversion is an explicit (initially no-op) step.
message TimePoint {
  oneof domain {
    AudioSample audio_sample = 1;
    Musical     musical      = 2;
    Monotonic   monotonic    = 3;
    Wall        wall         = 4;
    RenderFrame render_frame = 5;
  }
  message AudioSample { string device = 1; uint64 sample = 2; uint32 sample_rate = 3; }
  message Musical     { double beat = 1; optional uint32 bar = 2; optional double tempo = 3; }
  message Monotonic   { string device = 1; uint64 nanos = 2; }
  message Wall        { uint64 unix_nanos = 1; }
  message RenderFrame { string group = 1; uint64 frame = 2; }
}

// Value / Vec moved to common.proto (orrery.common.v1) — shared with manifest +
// plugin. Compact, MCU-friendly: scalars + vectors cover almost everything;
// `blob` carries a structured/typed payload decoded per the path's schema.

// ─────────────────────────────────────────────────────────────
//  The packet: shared envelope + one of three transport shapes
// ─────────────────────────────────────────────────────────────

message SignalPacket {
  // envelope — on every packet
  string    schema   = 1;  // "bus.v1" (mirrors the package version; runtime-checkable across encodings)
  Source    source   = 2;
  TimePoint time     = 3;  // when this packet's content is timestamped
  uint32    priority = 4;  // authority-ladder value; resolver picks highest live writer per sink

  oneof body {
    State  state  = 10;  // latest value replaces previous
    Event  event  = 11;  // append-only, ordered, never collapsed/dropped
    Bundle bundle = 12;  // atomic group, one execution time
  }
}

message State {
  string path = 1;
  orrery.common.v1.Value value = 2;
  optional TimePoint valid_until = 3;  // explicit staleness horizon; else manifest stale_after_ms
  bool release = 4;                    // writer relinquishes this path NOW (sACN "stream
                                       // terminated"): leave arbitration immediately,
                                       // don't wait out the writer timeout
}

message Event {
  string path = 1;
  optional orrery.common.v1.Value payload = 2;
  optional string    dedupe_key  = 3;  // dedupe replays by (source.id, seq) or this
  optional TimePoint target_time = 4;  // single scheduled event ("fire at beat 32.0")
}

message Bundle {
  repeated Item     items       = 1;  // applied together; inherit the parent SignalPacket's source/time/priority
  optional TimePoint target_time = 2;
  bool              atomic      = 3;  // true = apply all at target_time, or none
  message Item { oneof item { State state = 1; Event event = 2; } }  // sub-items are state/event only (never nested bundles)
}
```

### Modeling notes

- **`oneof body`** gives the State/Event/Bundle discrimination; **`oneof
  domain`** does TimePoint. `prost` lowers both to clean Rust `enum`s; `ts-proto`
  to TS discriminated unions — the union model survives codegen.
- **Bundle items are bare `State`/`Event`** (not full packets): one atomic action
  from one source at one time, so sub-items inherit the parent's
  `source`/`time`/`priority` — more compact and semantically correct.
- **`Value.blob`** is the escape hatch for structured event payloads; the
  consumer decodes it per the path's declared schema (in the capability
  manifest). Keeps the core compact and MCU-cheap. (Heavier alt for the readable
  core path: `google.protobuf.Struct`.)
- **`bigint` → `uint64`/`sint64`**: native in proto; `ts-proto` surfaces them as
  `string`/`bigint`, `prost` as `u64`/`i64`. No JSON-bigint papercut.
- **`source.sig` is `bytes`** so it holds *either* an **HMAC tag** (constrained
  ESP nodes — per-node key, established at pairing; truncate to 8–16 B to save
  ESP-NOW frame bytes) *or* an **asymmetric signature** (richer edges). Mix per
  node, upgrade later — no schema change. Per-packet HMAC is ~free on these MCUs;
  per-packet asymmetric is not (so it's confined to the pairing handshake). See
  `ARCHITECTURE.md` *Runtime contracts → Identity* (Edge auth).

## Toolchain (one `.proto`, per language)

| Target | Codegen | Notes |
|---|---|---|
| Browser (visualizer host) | **`ts-proto`** | idiomatic TS, discriminated unions for `oneof` |
| Node SSE/WS bridge | `ts-proto` / `protobufjs` | transcodes edge ↔ core |
| Pi / host (Rust `std`) | **`prost` + `protoc-gen-prost-serde`** | binary **and** proto-JSON (serde) — the readable wire + inspector live here |
| Daisy firmware (Rust `no_std`) | **`nanopb`** (C, FFI) *or* `femtopb`/`micropb` (no_std, no-alloc Rust) | heap-free; decode in the comms task, off the audio path |
| ESP nodes (Rust *or* C) | `femtopb`/`micropb` (Rust) *or* `nanopb` (C) | binary over ESP-NOW; see runtime table |

`protoc-gen-prost-serde` is the keystone: it adds `serde` to the prost structs so
the **same generated Rust types do both binary protobuf and JSON**, giving the
readable core/inspector wire without a second schema.

## Per-node runtime

| Node | Language | Proto runtime | On-wire encoding | Why |
|---|---|---|---|---|
| **Browser host** | TS | `ts-proto` | proto-JSON over WS (binary optional) | readable on the core; no perf pressure |
| **Node bridge** | JS/TS | `ts-proto` | JSON in ↔ binary/JSON out | transcodes constrained edges to core |
| **Pi / host** | Rust `std` | `prost` + serde | binary + JSON | hub; inspector decodes here; not constrained |
| **Daisy firmware** | Rust `no_std` | `nanopb` (C/FFI) or `femtopb`/`micropb` | binary | zero-/low-alloc; off audio path |
| **ESP sensor/render** | Rust (`esp-hal`) **or** C (ESP-IDF) | `femtopb`/`micropb` or `nanopb` | binary over ESP-NOW | smallest frames; proto-as-IDL keeps C fallback open |

## Field length budget (constrained codegen)

`nanopb`/`femtopb` allocate statically and require a max size per `string`/
`bytes` field; an ESP-NOW frame is ~250 B. The budget (generator options, not
schema — but normative so every target agrees):

| Field | Max bytes | Note |
|---|---|---|
| `source_id` | 64 | SPIFFE URIs fit; intern on constrained links (backlog) |
| `path` / `bus_path` | 48 | `domain.instance.field` |
| `schema` | 16 | `"bus.v1"` |
| `dedupe_key` | 32 | |
| `sig` | 16 | truncated HMAC tag (8–16 B) on ESP nodes |
| `Value.text` | 64 | control-plane strings are labels, not prose |
| `Value.blob` | 160 | must fit one frame alongside the envelope |

A single-scalar packet's envelope (URI + path + schema + sig + TimePoint + ints)
runs ~110–130 B of the 250 — workable, >50 % overhead. Batch via
`Bundle{atomic: false}` (below). **String interning lives in the link-layer
framing, not in `bus.v1`:** at pairing, a constrained link MAY negotiate a
per-link alias table (`uint16` ↔ `source_id`/`path`); aliased frames carry the
int and the aggregator re-expands to full `bus.v1` before forwarding. Because
the alias never appears in the core schema, turning interning on later is a
framing change on one link, not a schema migration.

## Semantics (encoding-independent)

**Ordering & dedup.** The per-source ordering key is **`(boot_epoch, seq)`** —
a higher epoch always supersedes a lower one, `seq` orders within an epoch.
Receivers order a source's events by that key; **dedupe** by
`(source.id, boot_epoch, seq)` (or `dedupe_key`); **drop a `State` whose key is
older than the one applied** — kills the stale-latest-after-the-event bug
without silencing a rebooted node.

**State staleness.** Hold until `valid_until` (if set) else
`arrival + manifest.stale_after_ms`; on expiry apply the signal's `on_stale`
policy (`hold|null|default|decay|freeze_route|fail_safe`) — a property of the
**signal** (manifest), not the packet. `stale_after_ms = 0` means **never
stale** (and carries no keepalive obligation).

**Retained state & keepalive (late joiners).** The bus (hub; aggregators for
their ESP subtrees) **retains the last post-arbitration `State` per path and
replays it on subscribe** — MQTT retained messages / ROS latched topics. A
node (re)joining mid-show gets the current palette, clock tuple, and params
immediately instead of waiting for the next change. Complement on the publisher
side: a `State` signal with `stale_after_ms > 0` **must republish within that
window even when unchanged** (the keepalive obligation), or it will go stale by
construction; publish-on-change signals should either declare
`stale_after_ms = 0` and rely on retention, or keepalive.

**Event delivery.** Append-only, **never coalesced**. A frame-rate receiver must
drain *all* pending events per frame or it misses touches/triggers. The full
guarantee is **no *silent* loss**, not "never dropped": every event queue is
**bounded** by the signal's `max_queue` / `max_event_age_ms` (manifest), with
overflow and lateness following its declared `overflow_policy` / `late_policy`,
and **every drop counted into `_meta`**. Unbounded queue growth and a
five-second burst of stale triggers after a node reconnects are both worse
than a visible, counted drop.

The drop accounting is first-class, named: ingress validates against the
manifest `max_rate_hz` and excess increments `_meta.<source>.rate_limit_drops`;
every event queue reports `queue_depth` / `dropped_oldest` / `dropped_newest` /
`dropped_late`; a path whose drop rate exceeds a threshold is marked
**degraded** (lifecycle FSM), so a flooding touch source becomes a supervisor
state, not a mystery. **Backpressure is advisory only** — over
wireless/UDP-ish links there is no reliable flow control to pretend with; the
publisher *learns* about drops through `_meta`, it is not throttled by magic.

**Bundle atomicity.** `atomic` + `target_time` → buffer, apply as a unit at
`target_time` (or immediately if unset); all-or-none where the sink supports it.
`Bundle{atomic: false}` doubles as the **batch container**: one node's
multi-field update (a 16-zone ToF frame) is one Bundle, not 16 packets.

**Scheduled time & lateness.** A `target_time` must be in a domain the
**executing node can evaluate**: `musical` (via the extrapolated clock —
`ARCHITECTURE.md` → *Clock distribution*), or the executor's own
`monotonic`/`render_frame`. A `target_time` in another device's monotonic is
unevaluable — rejected where checkable, treated as "immediate" otherwise. A
packet arriving **after** its `target_time` executes immediately (OSC's rule);
receivers MAY drop it if it is later than the signal's `stale_after_ms`.

**Priority (authority).** Per sink, among currently-live writers the highest
`priority` wins; a `safety`/blackout packet sits at the top and always wins.
Ties at equal priority: within one source, `(boot_epoch, seq)` last-writer;
**across sources, receiver arrival order** — declared arbitrary on purpose,
because `TimePoint`s from different sources/domains are not comparable (don't
pretend otherwise; give the two writers different priorities if it matters).
Distinct from **select/blend/fallback**, which compose *within* one writer's
router graph — priority arbitrates *between* writers at a sink. (Ladder values
live in the authorization policy: `safety 1000 … manual 900 … local_ui 700 …
timeline 500 … generative 400 … sensor 300 … idle 100`.)

Priority arbitrates **STATE sinks only. EVENT streams are not arbitrated —
they interleave** (dedupe still applies). Events are deltas, not levels;
"suppress the lower-priority writer" is ill-defined for sparse streams whose
liveness would expire between firings. Exclusivity between event sources is a
*routing* decision (`Select` in the consuming graph) — and anything
safety-shaped is a STATE level, never an event (manifest → `Reliability`).

**Writer liveness & handover.** A writer is **live** at a sink until it is
silent for `writer_timeout_ms` (default **2500 ms**, sACN's source timeout;
projects may derive it from the signal's `stale_after_ms`) or until it sends
`State{release: true}` — the clean exit that skips the wait. When the winning
writer expires or releases, the sink falls to the next-highest live writer;
the resolver SHOULD ramp across the handover (`reload_ramp_ms`-style) rather
than step, since the two writers' values are in general discontinuous.

The per-`(sink, path)` ownership FSM, explicitly:

```
unclaimed ──packet─────────────────► owned(W)        W = highest-priority live writer
owned(W)  ──higher-priority packet─► owned(W')       preempted; ramp
owned(W)  ──W release──────────────► owned(next live) or unclaimed   immediate; ramp
owned(W)  ──W silent > timeout─────► owned(next live) or unclaimed   demoted; ramp
owned(W)  ──W stale, no other live─► owned(W) + the signal's on_stale policy
```

Two cases fall out by construction: a **stale high-priority writer cannot
shadow a healthy lower-priority one** (the timeout demotes it), and a
**disconnected UI holding a manual override releases by timeout** even when it
never sent a clean `release`.

Three scoping rules, explicit: **`release` is self-only** — it relinquishes
the *sender's* writership (keyed by `source_id`); no packet can release
another writer's ownership. **Priority is per-packet, so a writer can
downgrade itself** — its current claim is its latest packet's `priority`
(an UI dropping from `manual 900` back to `local_ui 700` is just its next
write). **Writer-timeout and staleness are independent axes** — arbitration
decides *who owns the sink*, staleness decides *what the owner's value means*
(`on_stale`); either can fire first, and a sink can simultaneously be owned by
W and rendering W's `on_stale` policy.

## Enforcement-off matrix (live on day one)

| Field | Day one (enforcement off) | When hardened |
|---|---|---|
| `source.source_id` | **Honored** — routing, dedup, last-writer, observability. *Trusted, not verified.* | Verified vs enrolled cert |
| `source.seq` | **Honored** — ordering + dedup + replay guard | (unchanged) |
| `source.boot_epoch` | **Honored** — reboot-survival half of the ordering key | (unchanged) |
| `source.sig` | **No-op** — present, ignored | Verified (mTLS / HMAC) |
| `source.cert_fingerprint` | **No-op** — present | Checked vs allowlist/CA |
| `time` | **Recorded + used** for ordering; cross-domain conversion **no-op** | Real per-domain conversion |
| `priority` | Honored where resolver exists; may start **last-writer-wins** | Full ladder + safety overrides |
| `valid_until` / staleness | Minimal (`hold`) acceptable first | Full `on_stale` set |

Turning any right-column behavior on is a **config flip, not a schema
migration** — the fields were already on the wire. The mode in force is
**config, not convention**: `manifest.v1 → ProjectPolicy.runtime_modes`
declares each contract's `OFF | WARN | ENFORCE` state, and the inspector
banners any show running permissive — staged enforcement must never *look*
enforced. (Safety has no mode: `SafeEnvelope` is node-local and always on.)

## Schema evolution

Field numbers are the compatibility contract: never reuse a retired number
(`reserved`), add with new numbers, use `optional` for presence. **Pre-1.0 these
rules are relaxed** — churn freely while designing; the discipline begins at the
`bus.v1` freeze. The `schema` string + package version are the runtime gate.

## Per-packet vs. per-signal (manifest)

Packet stays lean; the static declaration lives **once** in the module's
capability manifest:

| On every packet | Declared once per signal (manifest) |
|---|---|
| `value`/`payload`, `source`, `seq`, `time`, `priority` | `value_type`, `unit`, `range` |
| `valid_until`, `dedupe_key`, `target_time` (when used) | `nominal_rate_hz`, `max_rate_hz`, `interpolation` |
| `sig`, `cert_fingerprint` (present, unverified) | `stale_after_ms`, `on_stale`, `default`/`failsafe` |
| | publisher `stable_id`, `cert_fingerprint`, `schema_version` |

The capability manifest is the sibling `.proto` **`manifest.v1`** —
see [`MANIFEST_PROTOCOL.md`](MANIFEST_PROTOCOL.md).

## Where this lives / next

The `.proto` becomes the canonical artifact; `protoc` + the plugins above
generate per-language types. Today's `window.AMBIENT_INPUTS` flat snapshot is the
pre-`bus.v1` prototype this replaces. Next: stand up the `.proto`, wire
`prost`+serde on the host and `ts-proto` in the browser, and replace the snapshot
read — see `BACKLOG.md` *Transport shapes + time*. Related: `ARCHITECTURE.md`
*The control bus*, *Runtime contracts*; `ESP32_SENSOR_NETWORK.md` (node language).
