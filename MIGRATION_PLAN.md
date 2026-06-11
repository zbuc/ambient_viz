# Migration plan — Pain Material onto the orrery architecture

> **Status: the implementation plan (v2 — incorporates the plan review,
> 2026-06-10).** Phased vertical slices that re-implement Pain Material on the
> new contracts (`bus.v1` … `plugin.v1`) while **keeping the installation
> functional at every step** — strangler-fig, not rewrite. Each phase
> refactors one piece, leaves everything else in place, and ends with the
> kiosk running a full session. Supersedes the bare MVP cut in `BACKLOG.md` →
> *Implementation plan*.
>
> Spec freeze holds (2026-06-10): if a phase reveals a contract bug, fix the
> contract minimally; **no new abstractions**. Nothing in this plan requires a
> schema change — capture rigor, comparators, and inspector behavior are all
> runtime/tooling concerns.

## Phase −1 — Invariant lock

The decisions every later phase leans on, stated once so they can't be
re-litigated mid-migration:

1. **Bridge receive order is canonical for replay.** Whatever order the bridge
   observed is *the* order; equal-priority ties resolve by that observed
   arrival order (already `bus.v1` semantics — replay preserves it by
   construction).
2. **Every runtime flag introduced by a phase is deleted by that phase's
   cleanup PR.** Flags are `migration_flag`s with an owner and a `delete_by`
   (see *Migration flags*); no permanent `USE_NEW_X` fossils.
3. **Every shadow candidate is visible pre-resolution in the inspector.** The
   resolver must never hide the thing the migration is trying to diff (see
   *Shadow visibility*).
4. **Every cutover has two named rollback classes** — pre-delete: runtime
   (priority swap / flag flip); post-delete: **artifact-level** (redeploy the
   previous release). Deletion is safe *because* artifact rollback exists;
   that is what keeps the no-dead-flags doctrine honest under show pressure.
5. **Every comparator has explicit tolerance by signal shape/type** and emits
   a four-way verdict (see *The comparator*). "≈ 0" is never vibes.
6. **Replay tooling has two maturity levels** — the **replay harness**
   (phases 0–3: re-inject captured inputs, compare outputs; no graph) and the
   **graph simulator** (phase 4+: manifests + policy + graph → output +
   `_meta` logs). Exit criteria name which one they mean.

## The migration doctrine

**Shadow → compare → cut over → delete.** Every replacement runs *alongside*
the legacy code first, observably, then takes over atomically, then the legacy
code is deleted.

- **Shadow via priority arbitration (STATE sinks).** Legacy and candidate
  publish the *same path* — legacy at the incumbent priority, candidate one
  step lower. The resolver picks the incumbent; the inspector diffs the
  writers. Cutover = swap the two priorities (one `ProjectPolicy` edit);
  pre-delete rollback = swap back.
- **Shadow visibility (the detail that makes it work):** the inspector renders
  **two layers per path** — `current_resolved_value`, and
  `writer_candidates[source_id, priority, value, age, stale, status]`, where a
  candidate's status is one of `shadowed_by_higher_priority |
  would_win_if_priority_ge_legacy | stale | type_rejected |
  policy_rejected_warn_only`. The migration tool thereby *proves* the
  resolver instead of being blinded by it.
- **Shadow via parallel paths (EVENT sinks).** Events interleave (no
  arbitration), so candidates publish `*.candidate` paths the adapters
  ignore; the inspector correlates candidate vs legacy streams. Cutover = the
  adapter rebinds.
- **One writer per output, always.** Each physical output (a CC number, a note
  channel, a visualizer param) has exactly one *effective* owner at all times,
  selected by priority or adapter binding.
- **The recorded session is the regression suite.** Phase-0 captures replay
  through every later phase; re-record a fresh golden after each cutover.
- **The Daisy firmware and the Python sidecar don't change** until late
  phases. The Node bridge is the strangulation point.

### Migration flags

Per-phase runtime flags are declared, not ambient:

```yaml
migration_flag:
  owner: phase-5-distance-twist
  allowed_states: legacy | bus
  delete_by: same PR as legacy mapping removal   # phase exit criterion
```

### Cutover quality gates

A cutover is **allowed when**, per phase (concrete numbers set per phase, the
shape is fixed):

```yaml
cutover_allowed_when:
  live_diff_duration: ">= 1 full session"
  replay_diff: pass
  max_abs_error: <per-signal, from the comparator table>
  max_latency_ms: <per-signal>
  stale_behavior_match: true
  new_WARNs: 0
# EVENT candidates additionally:
  candidate_decisions_match: true
  candidate_events_within_ms: <window>
  suppressed_reason_distribution_reviewed: true
```

## Phase 0 — Baseline capture (no refactor)

> **Status (2026-06-10): COMPLETE.** Tap (`server/src/capture.js` + boundary
> hooks), browser snapshots, replay harness + four-verdict comparator
> (`tools/replay/`). Deliverable 1: `fixtures/golden-mock-2026-06-10T20-28-44Z-
> pid3067/` — 63.3 min on the Pi, real Daisy, all sensors via sidecar mocks
> (no hardware attached; `--mock`). Deliverable 2: that golden replays to
> 12 MATCH + 1 declared EXPECTED_DIFFERENCE (random industrial timbre roll),
> 0 REGRESSION/UNKNOWN. Re-record on real sensors before phase 4B tunes
> tolerances. Next: phase 1.

Tap, don't modify. **Captured per input/output, exactly:**

- monotonic receive time at the bridge, for every input;
- the original source timestamp where one exists;
- process boot/session id (the capture's own `boot_epoch`);
- **raw payload bytes plus decoded form** (decode bugs must be discoverable);
- the ordering boundary: events logged in the exact order the bridge observed;
- browser connect/disconnect/reload events;
- Daisy serial **write ordering** and any flush/write errors;
- dropped/malformed input frames (counted *and* logged raw);
- the config/env/git SHA in effect during capture.

Boundaries tapped: `/ingest` POSTs, SSE frames out, every serial byte
(CC + note, timestamped), periodic `window.AMBIENT_INPUTS` snapshots.

- **Deliverable 1:** ≥1 h of session logs in `projects/pain-material/fixtures/`.
- **Deliverable 2 — the bar for "replayable":** a **replay harness** feeds the
  captured `/ingest`/serial/timeline inputs into the *legacy* bridge and
  **reproduces the captured SSE/Daisy outputs within declared tolerances.**
  Until that closes the loop, the logs are evidence, not a regression suite.
- **PM impact:** zero (read-only tap).

## The comparator (used by every shadow phase)

Per-type comparison rules — never a bare numeric diff:

| Signal type | Comparator |
|---|---|
| bool / state flag | exact |
| int / enum | exact |
| float sensor | epsilon: absolute **and** relative |
| timestamped retained state | value equality **plus** freshness semantics |
| event | ordered correspondence within a time window |
| derived/smoothed value | tolerance **plus** phase/latency bound |
| missing/unavailable | exact availability semantics (absent ≠ zero) |

Every comparison yields one of four verdicts:

- **MATCH** — within tolerance.
- **EXPECTED_DIFFERENCE** — declared, intentional improvement (e.g. retained
  state makes browser reload behave *better* than legacy in phase 2; the
  comparator knows this difference is the point, so it neither fails the gate
  nor gets hand-waved).
- **REGRESSION** — blocks cutover.
- **UNKNOWN** — also blocks; an undiagnosed difference is not a pass.

## Phase 1 — `bus.v1` inside the bridge + the inspector (pure shadow)

> **Status (2026-06-10): COMPLETE.** `proto/{common,bus}.proto` (verbatim from
> the spec docs) + ts-proto codegen (committed CJS in `server/src/gen/`);
> in-process bus (`server/src/bus.js`: retention, `(boot_epoch, seq)` ordering,
> priority arbitration + release, stale HOLD, bounded event queues, 1 Hz
> `_meta`); dual-write adapter (`server/src/bus-adapter.js`, IR_SKETCH paths);
> inspector at `/inspector` (two-layer resolved/candidates, honest enforcement
> truth values). Validated: 10/10 semantics tests, live traffic, and the
> phase-0 golden replays clean with the bus on. Next: phase 2.

Codegen `common.v1` + `bus.v1` (ts-proto only — defer the Rust mirror until a
non-JS node speaks bus; the sidecar keeps POSTing JSON, the bridge ingest
adapter translates). In-process bus in the bridge: dual-write legacy events as
namespaced signals; retained state; event-queue drain; `(boot_epoch, seq)`
ordering; `_meta` counters. Serve the **signal inspector** — including the
two-layer resolved/candidates view and per-field enforcement truth values.

- **Validates:** bus semantics on live traffic + phase-0 replay (harness).
- **PM impact:** zero — legacy SSE untouched.

## Phase 2 — Cut over the browser feed (smallest real cutover)

> **Status (2026-06-10): SHADOW LANDED, cutover pending soak.** `/bus/events`
> (retained replay + live packets) + `/bus/map`; the page always derives the
> bus shadow (`AMBIENT_INPUTS_BUS`), `?feed=bus` assigns it as
> `window.AMBIENT_INPUTS` (default legacy); snapshots carry both states.
> Gate tool: `node tools/replay/feed-ab.js --url http://<pi>:8080
> --duration-s 3600` against a live session — all MATCH/EXPECTED required,
> then flip the kiosk URL to `&feed=bus`, soak one full session, and the
> cleanup PR deletes the legacy reader + the flag.

The visualizer keeps reading `window.AMBIENT_INPUTS`; a browser adapter
derives it from bus-over-SSE. `migration_flag: feed (legacy | bus)`.

- **Validates:** transport + retention end to end. Comparator runs the
  full-session A/B; browser-reload divergence is pre-declared
  **EXPECTED_DIFFERENCE** (retained state replays where legacy showed blanks).
- **Cutover gate:** comparator table verdicts all MATCH/EXPECTED, one full
  session. Rollback: flag (pre-delete) → artifact (post-delete).

## Phase 3 — Manifest registry + policy (WARN mode)

> **Status (2026-06-10): COMPLETE.** `proto/manifest.proto` (verbatim);
> manifests for the six PM modules + `policy.json` (ladder, roles, allowlist,
> `runtime_modes` all WARN/OFF) under `projects/pain-material/manifest/`;
> registry (`server/src/registry.js`) registers manifest declarations on the
> bus (type/stale/range now manifest-driven) and installs the WARN-only
> policy check (allowlist, role globs, priority ceiling, declared-path);
> duplicate-id/unit/role hygiene at load. Inspector banners permissive modes
> + warn triage. Validated: zero WARNs on a clean session, rogue publisher
> flagged-not-rejected, golden replay MATCH, 20/20 tests.

Manifests for sidecar (via bridge adapter), bridge, browser host; registry +
`ProjectPolicy` with `runtime_modes` all WARN; duplicate-id handling; visible
modes. **Validates:** zero WARNs on a clean session; an injected rogue
publisher is flagged. **PM impact:** zero.

## Phase 4 — Simulator + first compiled mapping: tape failure

> **Status (2026-06-10): 4A COMPLETE.** `proto/router.proto` (verbatim from
> ROUTER_IR.md) + codegen; graph simulator `tools/sim/` (maturity level 2:
> manifests + policy + graph → output + `_meta` logs, virtual-clock
> deterministic — 63 min simulates in ~1 s, runs byte-identical);
> `bus-adapter` clock made injectable so the sim drives the *production*
> writer discipline. Gate: identity graph (Input→Output echo per mapped path
> at incumbent−1 — the 4C shadow shape) over the mock golden: 281,353 in =
> 281,353 echoed, 0 mismatches, 72,096 arbitration checks 0 violations, all
> echo candidates `would_win_if_priority_ge_legacy`, 0 WARNs/rejects, 25/25
> tests. Note: real-sensor golden re-record is needed before the 4E gate
> numbers are tuned (a 4C shadow session doubles as the recording); 4B
> compiler correctness validates fine against the mock golden.

The public phase is one phase; **internally it lands as six gated
milestones**, so simulator, compiler, adapter, and arbitration bugs are never
being hunted simultaneously:

- **4A** — graph simulator replays phase-0 captures through an
  **identity/no-op graph**; output log equals input log. (Simulator maturity
  level 2 begins here.)
- **4B** — tiny compiler (`Input / Const / Normalize / Curve / Scale /
  Combine / Output`) emits the nearness graph's output **offline only**,
  validated against captured CC 23 traces.
- **4C** — the graph runs live and publishes `fx.tape.failure` **shadow**
  (candidate priority); nothing consumes it; inspector diffs writers.
- **4D** — the MIDI adapter (now a formal transport adapter) consumes the
  *resolved* value — legacy still winning. Proves the adapter reads
  arbitration without behavior change.
- **4E** — priority swap (cutover). Soak one full session against the quality
  gate.
- **4F** — delete the legacy ramp (and the `ce577ea` reversed-hardcode debt).
  Artifact rollback only, from here on.

## Phase 5 — Visualizer mappings, one at a time

Shadow-by-priority per mapping: **distance→twist**, then **distance→bitmap**,
then the **MPR121 tint envelopes** (twelve explicit chains; `Replicated` only
if its absence actually hurts). Each mapping is a `migration_flag` with
`delete_by` its own cleanup PR. `applyAutomation()` shrinks until empty.

**Boundary (keeps clock work out of this phase):** phase 5 consumes
`timeline.*` as **ordinary STATE only** (the `Combine MUL` directorial clamp
needs values, not time semantics). It must **not** depend on `clock.*`
extrapolation or cyclic semantics — those are phase 7. If a mapping turns out
to need real clock semantics, it *waits* for phase 7 rather than dragging the
clock contract in early.

## Phase 6 — `presence_choreography.v1` (the plugin host arrives)

The riskiest phase; it gets a de-risking precursor:

- **6.0 — toy plugin first.** Before porting anything: a trivial plugin that
  emits a harmless candidate event from a seeded timer. It must prove **host
  tick, seeded PRNG, state snapshot/restore, replay, and candidate-path
  inspection** end to end. The first plugin-host bug hunt happens here, not
  inside the most complex logic in the installation.
- **6.1 — port the trigger stack** (bell/toll/voice/murmur, knobs verbatim)
  with `requires_host_tick: true`, `determinism: REPLAYABLE`,
  `state_model: SNAPSHOTTABLE`. Occupancy conditioning (Trigger×2 → Latch,
  motion Envelope, `Combine MAX`) moves into the router graph, feeding both
  legacy and candidate.
- **Instrumentation — compare decisions, not dice.** The plugin emits
  inspector-only debug events (not part of the stable signal surface):
  `…debug.{armed, eligible, cooldown_started, cooldown_remaining,
  roll_requested, fire_decision, suppressed_reason}`. The live comparison
  correlates arm/disarm transitions, fire-eligibility windows, cooldown
  observance, and the `suppressed_reason` distribution between legacy and
  candidate over multiple days; the simulator asserts exact state-machine
  equivalence on seeded golden traces.
- **Cutover:** adapter rebinds strike/speak to the real paths; legacy trigger
  code deleted after one soaked session. `daisy-position.js` is then only:
  serial owner + MIDI adapter + POS reader.

## Phase 7 — Clock as a contract

The MIDI adapter publishes `clock.daisy.position` as the (position, rate)
tuple; the visualizer's lane sync consumes locally-extrapolated position
behind a `migration_flag`, replacing the 20 Hz rebase hack. Timeline player
formalized as an engine module. **Validates:** extrapolation + cyclic handling
on the real loop wrap (`RESET`). (Phase 5's boundary guaranteed nothing
upstream already depends on this.)

## Phase 8 — Host/plugin split of the visualizer (the long arc)

The ~7k-line IIFE becomes host + `pain_material_raster.v1`, incrementally:
analysis tap first (publishes `audio.main.*`), then the param surface
(PARAMETERS.md as typed inputs), then the render pipeline as the plugin body.

**Validation is deterministic render capture, not just screenshots:** fixed
viewport + DPR + seed, mocked/fixed `audio.main.*` frames and timeline/clock,
captures at frames N / N+1 / N+60, **perceptual-diff threshold** (the renderer
is not promised bit-deterministic). **Plus performance budgets as gates:**
host frame time p95, plugin render time p95, dropped frames, visible GC
pauses — a split that preserves pixels but tanks frame time is a REGRESSION.

## Phase 9 — Retirement + hardening

Delete `window.AMBIENT_INPUTS` + legacy SSE topics; env-var knobs → manifest/
policy; `runtime_modes` WARN → ENFORCE where warranted; pairing runbook when
the first wireless node ships. Only now: ESP bridge, render groups, OSC
adapters, Rust codegen mirror — each pulled by a concrete need.

## What this plan deliberately does not build

`Delay`, `Select`, wildcards/`Replicated`, distributed groups, ESP-NOW
transport, OSC/MIDI-external adapters, the abstract scene/field, real crypto —
until a phase above *needs* one or a second installation pulls it.

## Standing exit criteria (every phase)

1. A full kiosk session runs end-to-end with no regression an observer would
   notice.
2. The inspector shows the new component's behavior, its enforcement truth
   values, and (for shadows) its pre-resolution candidate status.
3. Golden traces replay clean — through the **replay harness** (phases 0–3)
   or the **graph simulator** (phase 4+).
4. The comparator's verdicts are all MATCH / EXPECTED_DIFFERENCE; any
   REGRESSION or UNKNOWN blocks.
5. The legacy code the phase replaced is **deleted**, and every
   `migration_flag` the phase introduced is deleted with it (post-delete
   rollback = artifact redeploy).
6. Memory/docs updated: what cut over, what died, what the next phase needs.
