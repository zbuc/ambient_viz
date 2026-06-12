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
>
> **Status (2026-06-11): CUTOVER ACCEPTED + CLEANUP DONE — PHASE 2
> COMPLETE.** The gate: the mechanical full-session feed-ab pass over the
> replayed cutover golden (below) plus the accepted live gate session
> (`feed=bus` end-to-end, snapshots' inputs/inputs_bus agreeing) — called
> by the gate owner. Cleanup: the page's legacy `/events` reader, the
> `feed` migration_flag, and the `AMBIENT_INPUTS_BUS` shadow alias are
> deleted; `window.AMBIENT_INPUTS` is derived from bus-over-SSE only, the
> song clock rides `clock.daisy.position`, and the capture-on signal moved
> to the `/bus/events` ready frame. Snapshots now carry `inputs` (the one
> state) + `inputs_fx`. A failed `/bus/map` fetch now means NO inputs —
> degrade-loudly, artifact rollback (invariant 4). feed-ab retired (header
> notes it; still runs for forensics — both server endpoints survive until
> phase 9, which owns deleting the legacy SSE topics themselves).
> `?feed=` in the kiosk URL is now inert.
>
> **Status (2026-06-11): FEED BUG FOUND BY THE PHASE-5 LIVE A/B — fixed,
> resolved-value wire.** The first `feed=bus` kiosk session (run with the
> phase-5 flags stacked) failed viz-ab with ~5 s-periodic divergences; root
> cause was *this phase's* feed, not the graphs: the page assembled
> `busState` from **packet payloads**, so the 4C defaults writer's shadowed
> `near/far` keepalives (75/130 @100, losing to the live 75/170 claim @300)
> flapped the derived endpoints ~2 s of every keepalive cycle — the exact
> shadowed-keepalive hazard the engine (4C) and the CC binding (4D) already
> guard against, unfixed in the third consumer. The graphs, reading
> RESOLVED, were correct all session. Fix: `bus.packetFrame()` annotates
> every live STATE frame on `/bus/events` with the arbitrated resolved
> value; the page and feed-ab consume `pkt.resolved`, never payloads
> (retained frames always were resolved). feed-ab also gained the declared
> **bus-resolved-while-legacy-blank** class (the standing defaults writer
> resolves `near/far` before the sidecar's first claim — same improvement
> family as reload retention). Gate run mechanically: feed-ab over a
> speed-1 replay of the cutover golden (sidecar joins at +135 s, live
> far=170 claim + defaults keepalives) — the kiosk soak still completes the
> cutover, but the comparator now has a clean full-session pass shape.

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
>
> **Status (2026-06-10): 4B COMPLETE.** Op set `Const / Normalize / Curve /
> Scale / Combine` in compiler + engine (rule-13 finite quarantine, degenerate
> spans step); first real artifacts: `manifest/graphs/tape-failure.json`
> (live near/far endpoints) + `modules/router.json` + `router` policy role
> (fx.* only, ≤300). Gate (`tools/sim/validate-tape.js`): graph →
> `fx.tape.failure` → MIDI-adapter model (quantize/dedupe/33 ms cap =
> `writeCc` verbatim) vs the golden's CC 23: **15,205 predicted = 15,205
> captured, exact, MATCH**; 34/34 tests. **Discovery:** legacy guards
> endpoint claims consumer-side (`far > near`, `0 ≤ near < far`) and the
> golden contains a real far=50 claim legacy rejected — but the phase-1
> adapter forwards raw claims, so bus `far_cm` diverges from legacy-effective.
> The validator mirrors the guards (counted, declared); **4C must hoist this
> conditioning to the bridge ingest boundary** (effective values on the bus,
> defaults as a low-priority writer) before the live shadow can compare.
>
> **Status (2026-06-11): real-sensor golden recorded + verified.**
> `fixtures/golden-real-2026-06-11T03-15-13Z-pid6205/` (3.6 min directed
> choreography, real VL53L5CX + AM312s + Daisy, config `d720648` near 75 /
> far 170): replay at speed 1 all MATCH (incl. CC 23, 3 entry bells, 2 exit
> voices), identity sim MATCH, 4B tape validation MATCH with
> `conditioned_drops: []` — the far=170 claim is valid, so this golden is the
> first to exercise Normalize's LIVE learned endpoints rather than defaults.
> The phase-0 "re-record on real sensors" caveat is satisfied; 4E tolerance
> tuning draws from this capture. (Two earlier takes failed usefully: one
> caught a disconnected Daisy via zero CC 23; one caught `VL53L5CX_FAR_CM=75`
> == near, rejected consumer-side everywhere — the second real-hardware
> invalid-far claim, reinforcing the 4C conditioning hoist.)
>
> **Status (2026-06-11): 4C IMPLEMENTATION COMPLETE — kiosk soak pending.**
> Landed: (1) the **ingest-boundary conditioning hoist** — `bus-adapter`
> refuses invalid endpoint claims (`0 ≤ near < eff far`, `far > eff near`,
> reject-not-clamp, counted + logged) and runs a standing **defaults writer**
> (75/130, `bridge/defaults`, idle priority 100) so the bus always resolves
> the effective values; (2) the **live router** — the bridge compiles
> `graphs/tape-failure.json` at boot and publishes `fx.tape.failure` as a
> shadow (nothing consumes it; degrades loudly to no-router on failure), its
> writes tapped into the capture as `bus_tx`; (3) compiler/engine moved to
> `server/src/router-{graph,engine}.js` (production code; the sim imports
> them). Two discoveries en route: **the engine must read the arbitrated
> RESOLVED value, not packet payloads** (the defaults writer's keepalives
> otherwise drag the graph back to shadowed values — caught by the staging,
> fixed + tested); and the real sensor's burst cadence produces **cap-dropped
> one-sample transients** the CC comparator couldn't excuse — now a declared,
> bounded tolerance (`transient_max_ms: 150`, budget 5/CC/session).
> **Proof:** replay of the real golden through the live-router bridge:
> legacy lanes MATCH/EXPECTED (2 transients excused), and the live lane —
> capture `bus_tx` vs simulated graph — **1,701 = 1,701 value changes,
> exact**. Legacy CC == sim graph == live graph on real-sensor data.
> Remaining for 4C exit: one full kiosk session with the inspector showing
> the candidate (doubles as a fresh golden with `bus_tx` aboard); then 4D.
>
> **Status (2026-06-11): 4D IMPLEMENTATION COMPLETE — rides the same pending
> kiosk soak as 4C.** The MIDI adapter is a formal transport adapter: (1) the
> legacy ramp in `daisy-position.js` now PUBLISHES its value as the incumbent
> bus writer (`bridge/legacy-tape`, sensor rung 300, on-change, new
> `legacy_ramp` role + manifest — the whole module is 4F's deletion target);
> (2) the candidate graph moved to **299 (incumbent−1)** — the doctrine's
> pre-cutover shadow shape, now real on the kiosk inspector
> (`would_win_if_priority_ge_legacy`); (3) CC 23 is driven by a
> resolved-value binding (`server/src/cc-binding.js`): on every
> `fx.tape.failure` packet it reads the bus's arbitrated RESOLVED value —
> never the packet payload, same rule as the engine — and feeds `writeCc`
> (quantize/dedupe/cap unchanged, same synchronous tick). `daisy-serial`'s
> manifest declares the subscription. `migration_flag: tape_cc (bus |
> legacy)` — env `TAPE_CC=legacy` restores the direct call; owner phase-4d,
> delete_by the 4F cleanup PR. **Proof (real golden replayed through the 4D
> bridge at speed 1):** all 12 lanes MATCH, including **CC 23: 1220 golden =
> 1220 replay writes** — the adapter reading arbitration is byte-identical to
> the direct call — and the live lane still exact (**1701 = 1701** value
> changes, capture `bus_tx` vs sim, candidate at 299); offline validator
> MATCH; 42/42 tests (6 new on the binding: shadowed-candidate suppression,
> lone-candidate boot, release handover, stale flip, rule-13 quarantine,
> detach). **4E cutover is now literally the priority swap** (graph 299→300,
> legacy 300→299) after the soak session passes the quality gate.
>
> **Status (2026-06-11): 4E CUTOVER LANDED — soak session pending (the gate's
> `live_diff_duration: >= 1 full session` is the one criterion only the kiosk
> can supply).** The swap, exactly as scripted: graph output 299→300
> (`graphs/tape-failure.json`), legacy ramp 300→299 (`PRI_TAPE_LEGACY` in
> daisy-position — still published every sample, so the inspector now diffs
> the *legacy* shadow against the winning graph). CC 23 is the router graph's
> output for the first time. Pre-delete rollback = swap the two numbers back;
> `TAPE_CC=legacy` remains the full bypass. **Replay through the cut-over
> bridge (real golden, speed 1):** every lane MATCH except the pre-declared
> stochastic toll (EXPECTED_DIFFERENCE — a Math.random toll fired; declared
> lane since phase 0). The CC 23 lane is now genuinely graph-driven: 1190
> replay writes vs 1220 legacy-driven golden writes, **MATCH under the
> declared step-function rules, 1 cap-boundary transient excused (budget
> 5)** — the same ±30-write cap-phase envelope the offline model has
> predicted for the graph stream since 4B (1170–1218 across runs). Live lane
> still exact: **1701 = 1701** value changes, capture `bus_tx` vs sim, now at
> priority 300. 42/42 tests. Remaining for 4E exit: one full kiosk session
> (soaks 4C visibility + 4D consumption + this cutover at once, and doubles
> as the post-cutover golden re-record the doctrine requires); then **4F:
> delete the legacy ramp, the `legacy-tape` module/role, the `tape_cc` flag,
> and the `ce577ea` reversed-hardcode debt** (direction then lives only in
> the graph's `invert: true` — flip it there, one artifact).
>
> **Status (2026-06-11): SOAK ACCEPTED + 4F COMPLETE — PHASE 4 DONE.** The
> soak: a 5.4 min live kiosk session (real sensors, touch + freeze traffic,
> entry bell + toll), accepted by Chris as the gate session. Its verdicts:
> replay all MATCH except two pre-declared stochastic lanes (industrial
> timbre roll, toll interval); tape validation MATCH with the live lane
> exact (**1344 = 1344** changes, `bus_tx` vs sim) — graph == sim == Daisy
> during a real session. Promoted as
> `fixtures/golden-cutover-2026-06-11T14-08-29Z-pid2793/`, the first
> post-cutover golden (CC 23 in it is the graph's output) and the canonical
> trace for phase 5+. **4F (pure deletion):** the in-process ramp in
> daisy-position, the `bridge/legacy-tape` identity + `legacy_ramp`
> role/manifest, and the `tape_cc` flag are gone; the `ce577ea` reversal for
> CC 23 now lives only in the graph's `invert: true` (the visualizer's two
> reversed ramps go with their phase-5 mappings). `fx.tape.failure` has one
> producer (graph @300) and one consumer (the resolved-value binding);
> near/far locals in daisy-position survive only as trigger-threshold
> parameters. A router load failure now silences the tape effect — the boot
> degrade message says so loudly; rollback is artifact-level from here
> (invariant 4). Re-proof post-deletion: soak golden replayed through the
> ramp-less bridge — CC 23 MATCH 750/747, CC 24 exact 44/44, live lane
> MATCH; 42/42 tests. **Next: phase 5** (distance→twist, then
> distance→bitmap, then the MPR121 tint envelopes — shadow-by-priority per
> mapping, each its own `migration_flag`).

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
if its absence actually hurts — *resolved 2026-06-11: presentation layer, no
chains; see the status block below*). Each mapping is a `migration_flag` with
`delete_by` its own cleanup PR. `applyAutomation()` shrinks until empty.

> **Status (2026-06-11): distance→twist SHADOW LANDED — kiosk A/B session
> pending.** Design decisions, stated for the record:
>
> - **Shadow shape.** For visualizer mappings the legacy side lives *inside
>   the consumer* (applyAutomation) and never publishes, so shadow-by-priority
>   degenerates to the phase-2 pattern: the graph is the **sole writer** of a
>   new path (`fx.viz.twist_gain` @300, role `router` — no policy change) and
>   the **browser holds the A/B**: both gains are computed every tick, a
>   `migration_flag: twist (legacy | bus)` (`?twist=bus`, default legacy)
>   picks which one multiplies `maxTwistDeg`, and every capture snapshot
>   carries paired `twist_trace` samples (`{t, d, legacy, bus}`, on-change
>   ≤ 4 Hz). Invariant 3 is honored by the inspector (sole-writer status) +
>   the trace.
> - **Boundary.** The graph owns the *mapping* — Smooth(ONE_POLE 250 ms) →
>   Normalize(live near/far, `invert: true` — the visualizer's half of the
>   `ce577ea` reversal debt now lives in the graph artifact) →
>   Curve(EASE_IN_QUAD) — i.e. gain 0..1. The multiply by the *authored*
>   `maxTwistDeg` stays in the browser host (adapter conduct, like writeCc's
>   quantize): no `timeline.*` publish needed for this mapping, so the
>   `Combine MUL` directorial clamp waits for the mapping that actually
>   needs timeline values on the bus.
> - **Smooth is the phase-5 op addition** (spec'd in ROUTER_IR.md; ONE_POLE
>   only, SLEW/ONE_EURO stay compile errors). RATE_CONTROL Smooth is
>   timestamp-driven per the spec (α = 1−e^(−Δt/τ), Δt clamped [0, 500 ms],
>   seed on first sample) off the bus clock — virtual-clock deterministic in
>   the sim. Consequence, measured and declared: when the bridge dedupes a
>   stilled sensor the graph filter HOLDS mid-convergence while the legacy
>   per-frame EMA settles — the SETTLE-HOLD transient class in
>   `tolerances.js → derived` (eps 0.05 + 250 ms lag; transient runs
>   ≤ 400 ms at err ≤ 0.15, ≤ 1% of grid points; observed on the cutover
>   golden: 6 runs, ≤ 150 ms, max 0.109, 0.33%).
> - **One graph file per mapping** (`manifest/graphs/*.json`, bridge scans
>   the dir, one engine per graph): ship/cut/delete each mapping
>   independently; a broken graph degrades loudly alone.
>
> **Proof so far (offline gate, `tools/sim/validate-twist.js`):** capture
> inputs → sim (manifests + policy + viz-twist graph) → `fx.viz.twist_gain`
> trajectory, compared against a frame-clocked model of the legacy browser
> math over the capture's `sse_out` stream — **MATCH on all three goldens**
> (cutover: lag-max err 0.062–0.109 within the declared class; mock 63-min:
> MATCH incl. the far=50 conditioning reject). Bridge replay of the cutover
> golden through the two-graph boot: all phase-4 lanes unchanged. 50/50
> tests.
>
> **Status (2026-06-11): distance→bitmap SHADOW LANDED — same template,
> same pending kiosk session.** `graphs/viz-bitmap.json` publishes
> `fx.viz.bitmap_x` @300: the reversed LINEAR nearness x (Smooth 250 ms →
> Normalize invert — no curve; bitmap's half of the `ce577ea` debt is now
> graph `invert: true`). **The graph publishes the x ONLY**: the harmonic
> blend with the *authored* resolution ceiling (1/height interp), the 12 px
> quantize, and setLive/resize stay in the browser host — the ceiling is an
> authored param that is not on the bus, and the IR has no reciprocal of a
> live signal by design (rules out in-graph harmonic until/unless the
> ceiling becomes a bus value). `migration_flag: bitmapx (legacy | bus)` —
> `?bitmapx=bus` (`?bitmap=<px>` was taken by the resolution override);
> under the bus flag an absent bus value means full-res (sensor-absent
> semantics), never a silent legacy fallback. Snapshots carry
> `bitmap_trace`; the A/B judge generalized to `tools/replay/viz-ab.js`
> (judges all per-mapping traces; supersedes twist-ab.js before anyone ran
> it). Gate machinery shared in `tools/sim/viz-gate.js` (validate-twist /
> validate-bitmap are thin per-mapping shapes). **Offline gates: 6/6 MATCH**
> (both mappings × three goldens; bitmap lag-max 0.016–0.056, twist
> unchanged post-refactor — the extraction is behavior-preserving). 51/51
> tests.
>
> **Remaining for twist + bitmap (one kiosk session covers both):** (1) a
> session with the shadows live — judge `bus_tx` via each validator's live
> lane and the browser A/B via `tools/replay/viz-ab.js` (all MATCH
> required); (2) cutover = `&twist=bus&bitmapx=bus` on the kiosk URL, soak
> one full session; (3) each mapping's cleanup PR deletes its legacy
> in-browser ramp + flag (the shared distance EMA state dies with the LAST
> in-page consumer — twist's cleanup keeps it if bitmap hasn't cut over
> yet).
>
> **First kiosk A/B (2026-06-11, flags stacked with `feed=bus`): viz-ab
> REGRESSION — and the candidates were innocent.** The violations (~0.10–0.42,
> ~2 s runs every ~5 s) traced to the phase-2 feed's packet-payload
> assembly flapping the *legacy* sides' endpoints (see the phase-2 status
> block); the graphs read RESOLVED and were right the whole session — the
> live A/B caught a real transport bug the never-run phase-2 gate had left
> latent.
>
> **Second kiosk A/B (2026-06-11, post-fix, ~40 s smoke): ALL GATES MATCH.**
> The session exercised three comparator gaps, each resolved by a declared,
> mechanism-bounded rule (tolerances.js → derived): (1) **live lanes for
> stateful graphs get `live_eps_abs: 0.02`** — wall-vs-virtual dt jitter
> (≤ 8 ms measured) through Smooth's α leaves filter-memory residue, so
> live-vs-sim matches in count/order/time but not bit-exactly (measured max
> 0.0087, p99 0.004; the stateless tape lane stays exact); (2) **the trace
> domain gets `trace_lag_ms: 600` + the CC comparator's TRAVERSED rule** —
> the ≤ 4 Hz on-change trace can't resolve a one-sample cliff (d 140→42 cm:
> both sides mid-flight at different phases), so a bus sample inside the
> legacy ±window min..max span passes; plateaus still discriminate (spans
> collapse), and the dense offline grid guards the shape independently;
> (3) **the trace transient budget is wall-time-fraction**, not
> sample-fraction (on-change samples cluster during motion and overcount).
> Verdicts after declaration: viz-ab MATCH ×2 traces, validate-twist MATCH
> (incl. live lane 384=384), validate-bitmap MATCH (384=384), goldens
> unchanged.
>
> **Status (2026-06-11): CUTOVER ACCEPTED + CLEANUP DONE — PHASE 5
> COMPLETE.** Chris accepted the second session as the cutover gate
> (duration waived — gate owner's call; the session ran with
> `twist=bus&bitmapx=bus&feed=bus`, so it soaked the applied candidates).
> Promoted as `fixtures/golden-viz-cutover-2026-06-11T17-41-44Z-pid3792/`
> — the first golden carrying `fx.viz.*` bus_tx and the browser A/B
> traces; all gates re-verified against the promoted gzip. **Cleanup
> (browser-only):** the in-page twist ramp, bitmap ramp, shared distance
> EMA, both migration_flags, and the A/B trace machinery are deleted —
> `AMBIENT_FX` (resolved bus values) is the sole source of the twist gain
> and bitmap x; absent values degrade like an unwired sensor. The kiosk
> URL's `twist=`/`bitmapx=` params are now inert (harmless to keep, fine
> to drop). viz-ab retired with the flags it judged (header notes it;
> still runs against pre-cleanup fixtures). **The standing regression
> gates for the mappings are validate-twist/validate-bitmap** — their
> frame-clocked legacy model is now the frozen spec of the deleted
> in-page math. `applyAutomation()` retains only lane evaluation + host
> conduct (the harmonic blend/quantize, the gain multiply), as promised.
> Rollback is artifact-level from here (invariant 4). Phase 2's own
> cleanup (legacy reader + `feed` flag) remains phase 2's, not ours.
> **Next: phase 6** (the plugin host; 6.0 toy plugin first).
>
> **Status (2026-06-11): tint envelopes RESOLVED BY DECISION — presentation
> layer, no graph.** Chris's call: the 12 AR envelopes (rise 8 s / fall
> 18 s), the electrode→color blend, and the saturation floor are render-rate
> visual conduct, not signal routing. Consequence: **mapping 3 has no
> router-graph component and no phase-5 flag.** The signal transport is
> already bus-native — `touch.pad0.e0..e11` declared since phase 3, fanned
> into the legacy `touch_mask` by the phase-2 browser feed — so the tint
> path cuts over with the `feed` flag, and the envelope state +
> `TOUCH_COLORS` table stay in the visualizer until phase 8 formalizes them
> as typed plugin params (rise/fall taus, palette). **The precedent this
> sets:** router graphs own *sensor signal shaping* (ramps, filters,
> normalization against learned endpoints); render-rate aesthetic conduct
> (envelopes against the frame clock, color blending, quantize/realloc
> discipline) belongs to the consuming host/plugin. Phase 5's mapping list
> therefore closes with **twist + bitmap**: once they cut over and their
> cleanup PRs land, `applyAutomation()` retains only timeline lane
> evaluation — phase 7/8 scope, exactly the boundary this phase promised
> not to cross.

**Boundary (keeps clock work out of this phase):** phase 5 consumes
`timeline.*` as **ordinary STATE only** (the `Combine MUL` directorial clamp
needs values, not time semantics). It must **not** depend on `clock.*`
extrapolation or cyclic semantics — those are phase 7. If a mapping turns out
to need real clock semantics, it *waits* for phase 7 rather than dragging the
clock contract in early.

## Phase 6 — `presence_choreography.v1` (the plugin host arrives)

> **Status (2026-06-11): 6.0 COMPLETE — toy plugin live, all five proofs
> green.** `proto/plugin.proto` (verbatim from PLUGIN_CONTRACT.md) + codegen;
> the **plugin host** (`server/src/plugin-host.js`) runs plugin.v1 assets in
> the bridge, instantiated one-file-per-instance from `manifest/plugins/`
> (the graphs-dir ship/cut/delete doctrine). Design decisions, stated for
> the record:
>
> - **Instantiation is host config, not new schema.** Each file carries a
>   router.v1 `PluginBinding` (codec-validated) in a host envelope
>   {instance, seed, authorityRole, priority} — the fields PLUGIN_CONTRACT.md
>   explicitly assigns to instantiation/host-API. `Replicated`-sited bindings
>   stay unbuilt until something needs groups. Binding validation mirrors the
>   contract's compiler-validation list: inputs (declared/required/typed),
>   params (range + defaults), version resolution, member_needs rejected,
>   BUS-only outputs authorized rule-8-style (role globs + priority ceiling).
>   Scope errors are loud: RATE_CONTROL only, REPLAYABLE only, no emitter.
> - **The host owns time and randomness.** One injectable tick
>   (250 ms, bus.nowMono — the clock the sim already drives virtually);
>   per-instance seeded mulberry32 whose 32-bit state is part of the host
>   snapshot, so replay-resume continues the random stream bit-exactly. Seeds
>   are recorded at boot (`plugin_init` capture event) — a fixture without
>   its seed is not replayable. STATE inputs read the arbitrated RESOLVED
>   value (the 4C/4D rule, third consumer); EVENT inputs get the full drain
>   since last tick, never coalesced. Crash = instance disabled loudly,
>   EVENT outputs fall silent, STATE outputs released (failsafe
>   approximation until manifests carry per-sink failsafe values);
>   non-finite emissions quarantined + counted (rule 13).
> - **The toy** (`server/src/plugins/toy-timer.js`, `toy_timer.v1`,
>   GENERATOR): seeded random-interval pulse with a skip roll — the toll's
>   irregular-recurrence shape, zero installation logic — emitting
>   `seq.toy.pulse` (EVENT int, new `plugin_host` role/manifest/allowlist
>   entry, "count" unit token) that nothing consumes. Emissions are tapped
>   into the capture (`plugin_tx`) and ride /bus/events; until a real
>   consumer binds (6.1), the host's inspection ring is the declared drainer
>   of its own output queues (drop counters stay honest).
> - **Inspection:** `/plugins/state` + an inspector panel (instance status,
>   seed/PRNG state, tick/emit/quarantine counters, recent emissions, live
>   state snapshot). En route fix: bus.snapshot() now labels EVENT writers
>   `event_writer` — the STATE shadow vocabulary ("shadowed", "would win")
>   was a lie on event paths.
>
> **Proof (`tools/sim/validate-plugin.js`, three legs × three goldens, all
> MATCH):** replay — two from-scratch virtual-time runs byte-identical
> (mock 63-min: 93 emissions; cutover: 7; viz-cutover: 1); resume — host
> snapshotted mid-timeline, DISCARDED, rebuilt with wrong seeds, restored:
> tails exactly equal the straight runs'; hygiene — zero crashes/rejects/
> WARNs/drops everywhere. 65/65 server tests (13 new); tape/twist/bitmap
> gates + identity sim re-verified MATCH post-change; live bridge soak
> showed a real pulse on the bus, type-checked, policy-clean. **Next: 6.1**
> — port the trigger stack (bell/toll/voice/murmur) onto this host;
> occupancy conditioning into the router graph; decision-level comparison
> via the debug-event instrumentation below.
>
> **Status (2026-06-11): 6.1 STEP ONE LANDED — occupancy graph in shadow,
> offline gate MATCH ×4 goldens; kiosk gate session pending.** Chris's three
> rulings for 6.1, recorded: (1) the host will gain **arrival-driven input
> delivery** alongside the tick (the bell's consecutive-fresh-sample gate
> can't ride a 250 ms ZOH); (2) occupancy publishes **`derived.room.occupied`
> under its own module identity** (`bridge/router-occupancy`, new
> `occupancy_router` role scoped to `derived.room.*` — least authority per
> writer, per-graph sourceId in the bridge); (3) **two-step sequencing** —
> the occupancy graph shadows and gates against legacy `computeOccupancy`
> FIRST; legacy rebinds to the bus value only after that lane is MATCH; only
> then does the trigger-plugin decision comparison run, with both sides on
> one occupancy.
>
> Landed: the **Trigger / Latch / Envelope ops** (compiler + engine; Latch
> COUNT set/reset and Envelope AR only — the rest stay compile errors):
> in-graph EVENT edges exist solely on trigger→latch (typed at compile);
> triggers carry fire-level + re-arm-band hysteresis and seed at the armed
> side (a session opening on an occupied room claims it); latches seed idle
> so occupancy resolves false from boot; **Envelope is timestamp-driven with
> UNCLAMPED Δt and re-evaluates on every packet the graph receives** — time
> only arrives with packets, and a 20 s motion hold must expire on whatever
> traffic carries time (the distance keepalive's 1 s cadence is the floor;
> Smooth keeps its phase-5 input-driven semantics + 500 ms clamp,
> deliberately). The envelope also advances against the ZOH-held PREVIOUS
> input (decay starts at the fall edge, not back-dated to the rise — caught
> by test). `graphs/occupancy.json`: ratio = d/far → enter/empty triggers
> (0.85/0.92, mirroring legacy's ≤/≥) → COUNT latch → STEP, MAX with the
> 20 s motion-hold envelope. Supporting moves: the bus-adapter runs a
> standing **motion=false defaults claim** (idle rung — sensor-absent must
> mean distance-only occupancy, not a silent strict Combine; `defaults` role
> widened); the **bridge now starts engines BEFORE the adapter attaches**
> (the sim's order all along — motion declares no stale window, so its one
> boot claim is never keepalive-resent and a late-starting engine would wait
> forever; found by the occupancy graph's silent boot); the identity
> harness's echo joins motion to the defaults-backed set (echo at idle−1).
> Legacy tap: daisy-position captures `legacy_occupancy` edges (read-only).
>
> **Gate (`tools/sim/validate-occupancy.js`):** legacy lane = capture tap
> when present, else the frozen-spec model of `computeOccupancy` /
> `motionPresent` (verbatim guards, 500 ms tick, MOTION_PRESENCE
> auto-detected, modeled ON by default — the kiosk config); graph lane = sim
> trajectory → binary edges; ordered edge correspondence within a declared
> 1500 ms lag class (legacy tick 500 ms + keepalive packet-time floor 1 s).
> **MATCH on all four goldens** (cutover 1 edge, real 5, viz-cutover 1,
> mock 5; occupied fractions identical to 3 decimals). 70/70 tests; all
> standing gates re-verified (tape offline 743 predicted writes — confirmed
> byte-identical to the pre-6.1 baseline via stash). **Remaining for step
> one's exit:** a kiosk session with the shadow live (its capture then
> carries `legacy_occupancy` + `bus_tx` — the validator's live lanes), then
> legacy rebinds. **Then step two:** host arrival-driven delivery + the
> `presence_choreography.v1` port + debug-event decision comparison.
>
> **Status (2026-06-11): 6.1 STEP TWO LANDED — trigger stack ported, both
> offline lanes MATCH ×4 goldens; ONE kiosk session is the cutover gate
> (Chris waived the multi-day correlation — gate owner's call, recorded).**
> The host gained **arrival-driven delivery** (ruling 1): a plugin
> implementing `onInput(port, value, ctx)` is invoked synchronously on every
> accepted STATE packet for a bound port, in bus arrival order, with the
> RESOLVED value, plus **late-joiner priming** (retained values delivered
> once at host creation, path-sorted — the host attaches after the adapter's
> one-shot boot claims). `presence_choreography.v1`
> (`server/src/plugins/presence-choreography.js`) is the verbatim port of
> bell/toll/voice/murmur: occupancy is an INPUT (`derived.room.occupied` —
> the graph engine's synchronous publish reaches onInput before the
> distance/motion packet that caused it, preserving legacy's
> compute-occupancy-first ordering); every Math.random became ctx.rand with
> the legacy draw order preserved; outputs are `seq.presence.note_on`
> ([ch, note, vel] — nothing consumes it until cutover) and
> `seq.presence.debug` (armed/fire/suppressed/scheduled instrumentation,
> inspector-only). Eval sites are legacy's exactly: fresh distance sample
> (the only site advancing the approach-sustain counter), motion edge, tick.
> One port bug found by the gate: legacy's `lastBellMs = 0` means "never"
> against epoch wall-clock but is RECENT on the monotonic timeline — the
> literal port cooldown-blocked the session's first bell; ported the intent
> (−Infinity).
>
> **Gate (`tools/sim/validate-presence.js`), two lanes — compare decisions,
> not dice:** lane A, seeded equivalence — the hosted plugin vs an
> INDEPENDENT frozen-spec model (`presence-legacy-model.js`), same packets,
> same ticks, same occupancy graph, same seed: note_on sequences EXACTLY
> equal, draw-for-draw (cutover 2=2, real 5=5, viz 1=1, mock 85=85). Lane B,
> capture faithfulness — plugin fires classified by reason vs the goldens'
> captured trigger events: deterministic classes (entry bells, exit voices)
> within ±2500 ms (real golden: 3=3 entries, 2=2 exit voices; mock: 76=76
> distance-mode entries — the arrival-driven approach gate reproducing real
> legacy decisions); toll/murmur are the phase-0-declared stochastic lanes
> (unseeded Math.random in the capture), reported EXPECTED. One declared
> config class: the mock golden ran MOTION_PRESENCE=off while the occupancy
> graph bakes the production fusion ON, so its exit-voice lane is an
> occupancy-mode mismatch (EXPECTED_DIFFERENCE), with the ON-mode goldens
> carrying that proof. 73/73 tests; all standing gates re-verified; live
> boot shows presence armed with primed inputs. **The single kiosk session
> now gates everything at once:** occupancy live lanes (validate-occupancy)
> + presence decision correlation (validate-presence over the new capture)
> + the standing gates. After it passes: the cutover PR — MIDI adapter
> rebinds strike/speak to `seq.presence.note_on`, daisy-position's trigger
> stack + `legacy_occupancy` tap deleted (it shrinks to serial owner + MIDI
> adapter + POS reader), occupancy rebind folded in, fresh golden recorded.
>
> **Status (2026-06-11): the rebind mechanism landed —
> `migration_flag: presence_cc (legacy | bus)`** (env `PRESENCE_CC`, owner
> phase-6.1, delete_by the 6.1 cleanup PR). Under `bus` the plugin's
> `seq.presence.note_on` events drive the serial note-ons (a packet-reactive
> EVENT binding, `cc-binding.js → attachEventBinding`) while the legacy
> stack keeps deciding and capturing `trigger` events without touching the
> wire — legacy becomes the shadow, the phase-5 applied-candidate gate
> shape. Default `legacy` is byte-identical to before.
>
> **The gate session (runbook — one session gates everything, per Chris):**
> on the Pi, from a pulled main:
>
> ```sh
> CAPTURE=1 PRESENCE_CC=bus MOTION_PRESENCE=1 ./run_kiosk.sh
> ```
>
> The audience hears the candidate; if anything misbehaves, restarting with
> `PRESENCE_CC=legacy` is the whole rollback. Run a normal session (a few
> entries/exits, dwell long enough for a toll, touch + freeze traffic),
> then judge the new capture dir:
>
> ```sh
> node tools/sim/validate-occupancy.js <SESSION>  # occupancy live lanes
> node tools/sim/validate-presence.js  <SESSION>  # decision correlation
> node tools/sim/validate-tape.js      <SESSION>  # standing gates
> node tools/sim/validate-twist.js     <SESSION>
> node tools/sim/validate-bitmap.js    <SESSION>
> node tools/sim/validate-plugin.js    <SESSION>
> ```
>
> All MATCH → accept: the cleanup PR deletes the legacy trigger stack, the
> `legacy_occupancy` tap, and the `presence_cc` flag (rollback becomes
> artifact-level, invariant 4), and the session is promoted as the phase-6
> golden.
>
> **Status (2026-06-12): GATE SESSION ACCEPTED + CLEANUP DONE — PHASE 6
> COMPLETE.** The session (5.2 min on the kiosk, `PRESENCE_CC=bus` — the
> plugin struck the room live, legacy decided silently as the shadow),
> accepted by Chris. Its verdicts, after two comparator-side fixes the
> session itself surfaced (the `legacy_occupancy` tap's boot-baseline record
> is not an edge; one live-vs-sim Smooth point per viz mapping at
> 0.021 vs the declared 0.02 — same phase-5 jitter class, eps re-measured
> to 0.03 and the engine now clocks timestamp-driven nodes off the
> TRIGGERING PACKET'S stamp per ROUTER_IR, which collapses that class for
> future captures): occupancy live lanes MATCH (1=1 edges, fraction
> 0.955=0.955), presence lane A 2=2 draw-for-draw + entry 1=1, tape live
> exact 1129=1129, viz live 1135=1135 each, plugin gate MATCH, identity
> MATCH. Promoted as
> `fixtures/golden-presence-cutover-2026-06-12T02-45-58Z-pid7487/` — the
> canonical golden for phase 7+ (its trigger decisions are the seeded
> plugin's).
>
> **Cleanup (the deletion):** daisy-position.js is now ONLY serial owner +
> MIDI adapter + POS reader (584 → ~190 lines): the bell/toll/voice/murmur
> stack, `computeOccupancy`/`motionPresent`, every trigger env knob, the
> trigger tick, the `legacy_occupancy` tap, and the `presence_cc` flag are
> gone — the note_on event binding is unconditional, `sendNoteOn` the one
> path to the wire. The knobs live on as plugin params
> (`manifest/plugins/presence.json`) and the occupancy graph's envelope;
> server/README + INSTALL_DAY updated (old env vars inert). The bridge
> re-emits the plugin's `fire` debug events as capture `trigger` events, so
> the capture vocabulary survives the cutover and validate-presence lane B
> becomes a live-vs-sim decision lane on post-cutover captures. Dead
> `motionPresent` removed from plugin + model (occupancy fusion is the
> graph's). Re-proof post-deletion: replay of the promoted golden through
> the trigger-less bridge — all lanes MATCH/EXPECTED (CC 23 726/722, CC 24
> 110/110 exact, entry strike 1=1, toll declared); all seven sim gates
> MATCH; 82/82 tests. Rollback is artifact-level from here (invariant 4).
> **Phase 6 standing exit criteria: all six met. Next: phase 7** (clock as
> a contract — `clock.daisy.position` as (position, rate), local
> extrapolation behind a flag, retiring the 20 Hz rebase hack).

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

> **Status (2026-06-12): IMPLEMENTATION LANDED — tuple in shadow behind
> `migration_flag: songclock (rebase | tuple)`; kiosk session pending.**
> Design decisions, stated for the record:
>
> - **The tuple.** `clock.daisy.position` stays the position half
>   (unchanged, cyclic, declared since phase 3); `clock.daisy.rate` is new,
>   published by daisy-position under the daisy identity (clock_source role
>   covers `clock.daisy.*`) on meaningful change (±0.005), seeded 1.0 at
>   boot. The rate is MEASURED — a windowed endpoint estimate
>   (`server/src/clock-rate.js`): POS lines arrive with heavy USB-CDC
>   delivery jitter (measured 0.6–99 ms around the 50 ms cadence), so a
>   per-report EMA chases batching noise into ±50% swings (caught by the
>   gate's first run); the 6 s baseline amortizes it to ±1%. Wrap → baseline
>   cleared, nominal 1.0; stalls re-baseline; implausible reports never
>   enter the window (rule-13 posture).
> - **The consumer module.** `static/song-clock.js` — one file, three
>   runtimes (page `<script>`, node tests, the offline gate, which drives
>   the REAL module over captured POS timelines, not a model). Semantics:
>   anchor on every position report (the per-packet rebase IS the contract's
>   re-anchor; extrapolation never steps backward on its own — the wrap is
>   crossed by re-anchor, exactly the cyclic rule); slope = the published
>   rate; STALE freezes at the boundary value — the legacy reader instead
>   REWOUND 2 s to the raw anchor at the stall boundary, the one declared
>   EXPECTED_DIFFERENCE class. This module is the phase-7 slice of "timeline
>   player formalized": the CLOCK leaves applyAutomation; lane evaluation
>   stays for phase 8's typed param surface (the boundary phase 5 promised).
> - **The flag.** `?songclock=tuple` on the kiosk URL applies the module;
>   default `rebase` is byte-identical legacy. Both clocks are computed
>   every session and every capture snapshot carries the pair
>   (`song_clock: {impl, rebase, tuple}`) — the offline A/B, phase-5 trace
>   style.
>
> **Gate (`tools/sim/validate-songclock.js`), four lanes over the captured
> POS/RESET stream:** rate sanity (estimator inside [0.95, 1.05] after
> warmup), wrap handling (every backward anchor hard-snaps both clocks; the
> tuple clock is monotone between anchors), a 50 ms grid of
> |tuple − legacy| ≤ 10 ms outside stalls, and the snapshot A/B when a
> capture carries it. **MATCH on all five goldens** — mock (63 min, all 4
> real loop wraps): rate 0.998–1.002, grid max 0.1 ms; presence-cutover:
> rate 0.991–1.009 (the actual Daisy-vs-Pi skew, visible at last), grid max
> 0.4 ms; the session-start RESET correctly classified as an anchor, not a
> wrap. 90/90 tests (8 new); all standing gates re-verified; boot seeds
> `clock.daisy.rate` 1.0 under the daisy identity, policy-clean.
>
> **The gate session:** add `&songclock=tuple` to the kiosk URL, run one
> normal session with capture on (lane sync rides the tuple live), then
> `node tools/sim/validate-songclock.js <SESSION>` — the live A/B lane
> lights up from the snapshots — plus the standing gates. On acceptance the
> cleanup PR deletes the legacy `daisyPosRebase` reader and the flag; the
> module becomes the sole lane clock.
>
> **Status (2026-06-12): ACCEPTED + CLEANUP DONE — PHASE 7 COMPLETE.**
> Chris accepted on the offline evidence with the live session WAIVED (gate
> owner's call, recorded): the offline gate ran the REAL consumer module
> over five real captured POS streams including all four genuine loop
> wraps, and the only behavioral deltas from legacy are the measured slope
> (±1%) and the declared stall-freeze improvement — the anchoring mechanics
> are identical. The first live exposure of the tuple as sole clock is the
> next kiosk run; rollback is artifact-level (invariant 4). Cleanup: the
> legacy rebase reader and the `songclock` migration_flag are deleted
> (`?songclock=` inert); the SongClock module is the sole lane clock;
> snapshots carry the tuple value + state, and the validator's live lane
> now compares each snapshot's page-side value against a re-derivation at
> the bridge timestamp (live module == re-derived module, ≤ 50 ms) — a
> standing regression lane on every future capture. Re-verified post-
> cleanup: songclock gate MATCH ×5 goldens, 90/90 tests. **Next: phase 8**
> (host/plugin split of the visualizer — the long arc).

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
