# Shared schema vocabulary (`common.proto`)

> **Status: draft spec.** The small set of types reused across `bus.v1` /
> `manifest.v1` / `router.v1` / `plugin.v1`. Extracting them here makes the import
> graph a clean **star** — every schema imports `common`, none import each other —
> which removes the cross-package references (and one latent import cycle) that
> had crept in while the schemas were drafted independently.

```
            common.proto
           ╱    │    │    ╲
        bus  manifest router plugin     (each imports common; none import each other)
```

## The IDL

```proto
syntax = "proto3";
package orrery.common.v1;

// ── values ──────────────────────────────────────────────────
message Value {
  oneof v {
    double number  = 1;
    sint64 integer = 2;
    bool   boolean = 3;
    string text    = 4;
    Vec    vec     = 5;  // colors / positions / vectors
    bytes  blob    = 6;  // typed payload, schema-per-path
  }
}
message Vec { repeated float elems = 1 [packed = true]; }

// ── signal typing ───────────────────────────────────────────
enum ValueType {
  VALUE_TYPE_UNSPECIFIED = 0;
  VALUE_TYPE_FLOAT = 1;  VALUE_TYPE_INT  = 2;  VALUE_TYPE_BOOL = 3;
  VALUE_TYPE_TEXT  = 4;  VALUE_TYPE_VEC  = 5;  VALUE_TYPE_BLOB = 6;
}
enum Shape {
  SHAPE_UNSPECIFIED = 0;
  SHAPE_STATE = 1;  // latest-replaces
  SHAPE_EVENT = 2;  // append-only, ordered
}
message Range { double min = 1; double max = 2; }

// ── rate domains (a node's / signal's tick rate) ────────────
enum RateDomain {
  RATE_DOMAIN_UNSPECIFIED = 0;
  RATE_CONTROL      = 1;  // arrival-driven / async, low rate — NO tick.
                          // Activation semantics: ROUTER_IR.md → Execution semantics
  RATE_RENDER_FRAME = 2;  // per visual frame
  RATE_AUDIO_SAMPLE = 3;  // sample-rate
  RATE_MUSICAL      = 4;  // per musical subdivision; tick granularity is declared
                          // by the clock driver (default 24 ticks/beat — MIDI precedent)
}

// ── per-member context selector (render-plane groups) ───────
enum MemberParam {
  MEMBER_PARAM_UNSPECIFIED = 0;
  MEMBER_INDEX = 1; MEMBER_COUNT = 2; MEMBER_LOGICAL = 3; MEMBER_POSITION = 4;
}
```

## What moved here, and who uses it

| Type | Was in | Now used by |
|---|---|---|
| `Value`, `Vec` | `bus.v1` | bus (packet values), manifest (failsafe), plugin (param defaults) |
| `ValueType`, `Shape`, `Range` | `manifest.v1` | manifest (signal decls), plugin (ports/params) |
| `RateDomain` | `router.v1` | router (per-node), plugin (rate_domain) |
| `MemberParam` | *(was `router.v1`'s `Member.Which` + a bad `manifest.v1.Member.Which` ref)* | router (`Member` node), plugin (`member_needs`) — **the reference bug this fixes** |

## What stays put (single-consumer, schema-specific)

- `bus.v1`: `TimePoint`, `Source`, `SignalPacket`, `State`/`Event`/`Bundle` —
  the packet shapes (only bus uses them). `RateDomain` ≠ `TimePoint.domain`:
  rate-domain is a *tick rate*; `TimePoint` is a *timestamp* (and carries
  `monotonic`/`wall` references a rate doesn't).
- `manifest.v1`: `Identity`, `SignalDecl`, `GroupMembership`, `Geometry`
  (incl. `Vec3` — 3-D position, distinct from the packed `Vec`), `SafeEnvelope`,
  `Topology`, `ProjectPolicy`, `Role`, `TrustedId`.
- `router.v1`: the node ops, `Replicated`, `WildcardPolicy`, `PluginBinding`.
- `plugin.v1`: `PluginManifest`, `Port`, `Param`.

After the extraction each schema's IDL begins with `import "common.proto";` and
qualifies these as `orrery.common.v1.<Type>`.

## Versioning

`common.v1` is the most stable schema (pure vocabulary). Treat additions as
cheap; a breaking change here ripples to all four, so it bumps last. Pre-1.0,
churn freely. Eventually the four schema docs and this one are five `.proto`
files in one directory; this doc is the human-readable index for the shared one.
