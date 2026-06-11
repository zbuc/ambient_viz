# Procedural music — sensor-driven generation in the orrery architecture

> Canonical design for **procedural music generation on the Daisy Seed, steered
> by room sensors**, as an orrery platform capability. Like `ARCHITECTURE.md`,
> this defines target contracts and is honest about what exists vs. what is
> aspirational; like `ANALOG_FX_RACK.md`, it is a design doc — nothing in it is
> built yet beyond the primitives it composes. Pain Material's voices and
> sensors are the **first testbed**, not the scope.
>
> Provenance: the musical/algorithmic model below was settled in a design
> conversation (2026-06-11, "Procedural music generation for embedded systems")
> and is treated as **normative** here; this document's job is mapping it onto
> the platform's real components. It subsumes the BACKLOG item
> *"`StepEvent`-emitter as the generator abstraction"* and resolves the parked
> *"Tempo Pi→Daisy"* question (onboard `bpm_at` wins — §6).

**Thesis: the Pi sends slow musical intentions; the Daisy makes every note.**

```
sensors (bus, exists)
  → room-feature graphs              derived.room.*        (1–10 Hz)
  → baseline EMA + deviation         (existing graph ops)
  → derived.room.reward              ← THE PLUGGABLE OBJECTIVE (stub: Const 0)
  → optimizer plugin ((1+1)-ES)      music.mood.*          (2-D, minutes)
  → mood expansion (anchors as data) music.genome.* + fx   (per-project moods.json)
  → resolved-value CC bindings       CC 70–85 over USB-CDC MIDI
  → dsp::procgen conductor           (bar clock, chord FSM, density/tension)
  → per-instrument generators        (Euclidean drums, Markov melody, bass rules)
  → StepEvent → voices               (kick / hats / FM stab / bass) → audio
  ↘ per-bar MUS telemetry over CDC   music.conductor.*     (viz, inspection)
```

---

## 1. The musical model (normative)

Two layers, separated because coherence between parts is a
constraint-satisfaction problem, not an emergent property of running the same
algorithm N times:

**The conductor** — one shared global musical state on a bar clock:

- **Harmonic state**: current chord/scale, driven by a small weighted FSM /
  first-order Markov chain over *chord functions* (a transition matrix is a
  few hundred bytes, `const` in flash). Advances per bar or slower.
- **Density / tension**: continuous params that modulate every generator
  (transition temperatures, Euclidean fill, velocity ranges) so the ensemble
  breathes together.
- **Bar clock**: derived from the same sample-accurate `step_phase` + `bpm_at`
  machinery the grid `Sequencer` already uses.

**Per-instrument generators** — modules that read conductor state plus their
own role and emit notes:

| Role | Technique | Why |
|---|---|---|
| Percussion (kick, hats) | **Euclidean rhythms** (Bjorklund) | two integers → musically interlocking patterns; complementary patterns interlock nearly for free |
| Melody / stab lead | **Constrained Markov**, order 2 over scale degrees, conditioned on current chord; chord-tone snapping on strong beats, leap limits | best cost/quality on an MCU; a few KB of tables |
| Bass | **Rule-based**, locked to chord roots on a rhythmic grid | predictability is the point |
| Pads / texture | stochastic voice-leading over the shared chord | *(deferred — no pad voice exists yet, §11)* |
| Percussion texture | light cellular automata | *(deferred, §11)* |

**The evolutionary loop** — sensor-as-fitness, but **not** a population GA.
Each fitness evaluation costs real wall-clock time in the room (play a
candidate, watch the room for tens of seconds) and yields one noisy sample, so
population/crossover machinery can't get selection pressure. Instead:

- **(1+1)-ES** (build first): one incumbent genome playing; periodically
  mutate, play the candidate for an evaluation window, keep or revert on the
  smoothed room response. One knob (mutation scale), trivially snapshottable.
- **Contextual bandit** (deferred alternative): discrete "moves" (raise
  density, thin percussion, shift harmony) with per-context value estimates.
  Switch criterion: if ES steps feel directionless once a real objective
  lands, the move-vocabulary framing gives the search more structure.

**Three invariants** (theme- and objective-independent):

1. **The genome parameterizes the conductor, never raw notes.** The optimizer
   chooses musical intentions; the conductor + generators guarantee musicality
   below it. Smaller search space, and the clamp works at the intention level.
2. **Respond to deviations, not absolutes.** A baseline model of "normal" room
   behavior (slow EMA) feeds the objective deviations, so the system reacts to
   change (a cluster forming, the room emptying) and auto-adapts to a busy
   opening vs. a dead Tuesday.
3. **The objective is a pluggable block, deliberately open.** Everything
   upstream (sensing, smoothing) and downstream (optimizer, clamp, conductor)
   is objective-agnostic. Stub it at constant 0 — pure random drift — and the
   whole loop must already animate the music plausibly. Engagement-seeking,
   adversarial, homeostatic, or non-valenced mappings are *swappable data*
   (§7), auditioned in the actual room later.

## 2. Placement: what runs where, and why

| Decision rate | Where | What |
|---|---|---|
| Sample/step rate (notes) | **Daisy** (`dsp::procgen`) | conductor, generators, voices |
| Minutes rate (intentions) | **Pi** (plugin host + graphs) | features, baseline, objective, optimizer |

The note-rate layer lives on the Daisy because that's where sample-accurate
timing lives (`step_phase` accumulator, zero drift against the SAI clock), and
because it makes **degrade-to-autonomous a feature**: if the bridge or Pi dies,
the conductor keeps playing on its last genome indefinitely — the music never
stops, it just stops evolving. The minutes-rate layer lives on the Pi because
that's where the sensors, the bus, replayable determinism, and cheap iteration
live. The wire between them is ~10 CC values changing on a minutes clock —
well inside the existing transport's envelope.

Boundary rule (standing): `daisy/` is **audio-plane-on-Daisy code only**. The
optimizer, features, and objective are control-plane and live in the bridge
(plugin host + router graphs). A future Rust control-plane runtime would be a
separate root workspace, not a `daisy/` crate.

## 3. Bus contracts & namespaces

Who writes what. Each writer is the **sole writer** of its topics (the
`fx.tape.failure` precedent from migration phase 4).

| Topic(s) | Writer (role) | Shape / rate | Notes |
|---|---|---|---|
| `derived.room.activity`, `derived.room.baseline_*`, `derived.room.deviation` | router graphs — `graphs/room-features.json` (role `room_features_router`, pattern of `occupancy_router`) | STATE, 1–10 Hz | extends the **existing** `derived.room.*` namespace (`derived.room.occupied` already ships) |
| `derived.room.reward` | the objective — v1 is a stub graph (`Const 0` → `Output`) | STATE, slow | **the pluggable seam**: replacing the objective = replacing this graph (or later a plugin) — config, not code |
| `music.mood.x`, `music.mood.y` | timeline mood lane / sensor graphs / optimizer plugin (none yet — the expander's params carry a static position until a writer lands) | STATE, minutes | the low-dimensional control surface (§5) |
| `music.genome.<gene>` | mood-expander plugin (plugin host) | STATE, minutes | policy edit: `plugin_host.canPublish` += `music.genome.*` |
| `music.conductor.bar`, `.chord`, `.scale`, `.density` | daisy-serial bridge module (parsed from `MUS` CDC lines) | EVENT (bar) / STATE | role extension on the daisy identity (today `clock_source`); per-bar, low rate |

Policy changes are two allow-entries plus one role extension in
`projects/<project>/manifest/policy.json`; all new writers sit at the standard
non-timeline priority (300), so a timeline or manual layer can always override
a genome value through normal arbitration.

## 4. The genome

12 genes, one CC each. **CC 70–85** (current bindings occupy 12–24 only —
`daisy/crates/dsp/src/midi_map.rs`; 70+ stays clear of both the existing knob
range and the 0–63 14-bit-LSB convention). 7-bit resolution is sufficient:
genes are slow intentions and the conductor interpolates/smooths internally.
14-bit CC pairs are the documented upgrade path if a gene ever needs it.

| Gene | CC | `Param` variant | Range (bind_cc) | Meaning |
|---|---|---|---|---|
| density | 70 | `ProcDensity` | 0..1 | global note probability / busyness |
| tension | 71 | `ProcTension` | 0..1 | harmonic FSM bias toward tense functions; velocity spread |
| kick_fill | 72 | `ProcKickFill` | 0..1 | Euclidean pulses for kick (scaled to steps) |
| hat_fill | 73 | `ProcHatFill` | 0..1 | Euclidean pulses for hats |
| markov_temp | 74 | `ProcMarkovTemp` | 0..1 | melody transition temperature (0 = greedy, 1 = uniform-ish) |
| brightness | 75 | `ProcBrightness` | 0..1 | stab tone / filter target |
| bass_activity | 76 | `ProcBassActivity` | 0..1 | bass gate density / hold lengths |
| harmonic_rate | 77 | `ProcHarmonicRate` | 0..1 | bars per chord change (quantized internally) |
| register | 78 | `ProcRegister` | 0..1 | melody octave center |
| stab_color | 79 | `ProcStabColor` | 0..1 | per-hit tone variance (existing `stabtone` axis) |
| note_length | 80 | `ProcNoteLength` | 0..1 | bass gate hold length (2–14 steps); phrasing hook for melody durations later |
| bass_style | 81 | `ProcBassStyle` | 0..1 | bass archetype axis: 0 = drone (pedal per chord), 0.5 = pulse (downbeat anchor), 1 = stab (Euclidean shorts); triangle weights drawn per chord boundary |
| recall | 82 | `ProcRecall` | 0..1 | motif memory: probability a phrase replays the stored melody motif (snapped to the current harmony) instead of wandering |
| arc_depth | 83 | `ProcArcDepth` | 0..1 | phrase arc: sine over each phrase (2× chord period) modulating density/note_length/velocity ±depth/2 |
| wander | 84 | `ProcWander` | 0..1 | key drift: pivot transposition (±fifth/whole-step, same mode) probability per chord change |
| swing | 85 | `ProcSwing` | 0..1 | odd 16ths delayed up to a third of a step |
| dropout | 86 | `ProcDropout` | 0..1 | per-bar voice dropouts (kick/hats/melody independent; all = ensemble rest) |
| color | 87 | `ProcColor` | 0..1 | harmonic color: weight toward diatonic 7th/9th extensions, drawn per chord |
| freeze_punct | 88 | `ProcFreezePunct` | 0..1 | freeze punctuation: short master-freeze hits at chord arrivals |

(89+ free for genes discovered during listening. `note_length` was the
first such gene — the duration discussion promoted it out of `bass_activity`
so "sparser but longer" is expressible. The stab voice is **gated** (P1m+):
ADSR *shape* lives in the patch, note *duration* belongs to the trigger —
`StabHit { gate: true }` sustains until a `stab_off` releases it into the
patch's decay, the same contract the bass lane always had. `note_length`
drives both bass holds and the drawn melody/chord gate durations.)

**The clamp is structural, in two places — no clamp graph needed:**

1. `MidiMap::bind_cc(cc, param, min, max)` ranges *are* the firmware envelope —
   a 7-bit value cannot land outside `[min, max]`, and the conductor's
   internal quantizers (scale tables, leap limits, chord-tone snapping)
   guarantee musicality below the parameter level. No genome, however the
   optimizer drifts, escapes the intentional envelope.
2. The optimizer mutates in clamped genome space (per-gene `[0,1]` with
   declared bounds), so candidates are valid by construction.

Per-project *reshaping* of a gene (e.g. a softer density ceiling for a quiet
room) is a standard `Curve` graph between `music.genome.*` and the CC binding —
deferred until a project needs it.

**Transport**: one `attachResolvedBinding` per gene in
`server/src/inputs/daisy-position.js` — the proven `fx.tape.failure` → CC 23
pattern, inheriting its on-change dedupe and 33 ms rate cap (idle cost ~zero:
genes change on a minutes clock).

## 5. The mood layer

A **mood** ("a more ambient piece", "a techno piece") is a named point in
parameter space, authored as project data — never code. The algorithm does
not move between ambient and techno; it moves a **low-dimensional mood
vector**, and a deterministic expansion turns that into the genome and FX
values. One level above the genome, same philosophy: intentions parameterize
intentions.

```
mood vector (music.mood.x/y, minutes)        ← what moves over time
  → expansion against authored mood anchors  ← the artistic content, as data
    → music.genome.* + fx params             ← the existing CC surface (§4)
      → conductor → generators → notes       ← §6
```

**Anchors as data.** `projects/<project>/manifest/moods.json` (`moods.v1`),
peer of `graphs/`. Each anchor is a complete aesthetic snapshot — a position
on the mood plane, a full genome, and FX params by `Param` name:

```json
{ "schema": "moods.v1",
  "anchors": [
    { "name": "ambient", "pos": [0.2, 0.5],
      "genome": { "density": 0.18, "harmonic_rate": 0.05, "note_length": 0.85, … },
      "fx": { "ReverbWet": 0.55, "StabDecay": 0.85, "StabDelayWet": 0.65 } },
    { "name": "techno", "pos": [0.85, 0.5],
      "genome": { "density": 0.7, "kick_fill": 0.7, "note_length": 0.15, … },
      "fx": { "ReverbWet": 0.15, "StabDecay": 0.2 } } ] }
```

The plane has no fixed semantics — it is a map you arrange anchors on, and
distance is the only meaning. Authoring anchors is by-ear preset-making: the
P1 listening pass produces them naturally (save the genomes you like).

**Expansion = inverse-distance² blend.** Weights `wᵢ = 1/(dᵢ² + ε)`
normalized over all anchors; genome and FX values are the weighted sums. At
an anchor you hear exactly that anchor; between anchors you get a continuous
morph. This generalizes the conductor's proven CALM↔TENSE matrix blend —
continuous params lerp, and structural character is reached through genes
that are already continuous (a 4/4 kick *is* `kick_fill ≈ 0.7` → E(4,16);
"hold chords forever" *is* `harmonic_rate → 0`; drone-ness *is* a
self-weighted transition matrix). Truly discrete assets (which FM patch,
which field recordings) are **selected, not blended** — nearest anchor,
switched at phrase boundaries with hysteresis — and are deferred until the
asset channel exists (§11).

**Where it runs.** The production expansion is the `mood_expander.v1` plugin
on the plugin host (pure function of `music.mood.x/y`, falling back to its
instantiation params while no mood writer exists), publishing
`music.genome.*`. The Mac host carries a parallel audition implementation
(`--mood` / `--mood-sweep`) reading the **same** `moods.json`, applying both
genome and FX locally — so moods are hearable before any Pi plumbing.
Anchor *FX* values reach the Daisy only in P2 with the CC transport (and
`fx.tape.failure` stays the door graph's — the anchors' `TapeFailure` is
audition-only until that arbitration is designed).

**The systemic win: the optimizer walks mood space.** (1+1)-ES over a 10-D
genome on one noisy sample per minutes-long evaluation was the design's
weakest assumption. Optimizing 2 mood dimensions instead is a far easier
search — the room pushes the piece between *aesthetics you authored*, and
the expansion guarantees every point on the path is intentional. Sensors,
the timeline, and the optimizer all write `music.mood.*` through normal bus
arbitration (a composed arc = a timeline mood lane at 500; a room-emptying
graph nudge at 300). Slew-limiting mood movement (minutes-scale Smooth on
the writers, not in the expander) keeps transitions reading as drift, not
preset switching.

**Explicitly out of scope for the mood layer itself** (it parameterizes
them once they exist, §11): the granular/grain-delay send and the
multi-layer field-recording sampler bank.

## 6. `dsp::procgen` design

```
daisy/crates/dsp/src/procgen/
  mod.rs        — Genome struct, Producer enum, public surface
  conductor.rs  — bar clock, chord-function FSM, density/tension state
  euclid.rs     — Bjorklund pattern gen (pure fn → heapless::Vec<bool, MAX_STEPS>)
  markov.rs     — MarkovChain<const N>: const transition tables, temperature sampling
  bassgen.rs    — root-locked gate/hold rules
```

- **Producer abstraction is an enum selector, not a trait object** (no
  vtables in the audio path): the engine owns both producers and a
  `ProducerSel { Grid, Procgen }` chooses which `advance()` the audio path
  consults, both yielding one `StepEvent` per sample at the existing
  `Engine::process()` call site. Keeping both constructed makes the deferred
  runtime mode-switch (§9) a field write, and the host auditions either mode
  from one binary. The voices, the master chain, and any downstream `seq.*`
  consumer never know which producer is playing — this is the BACKLOG
  source-producer contract, realized.
- **Compiled unconditionally in `dsp`** (it's small and the Mac host needs it);
  the **firmware** gains a `procgen` cargo feature gating voice + producer
  instantiation, with `flash-*/bin-*` aliases following the
  `<flash|bin>-<sd>-<usb>-<prod>` scheme (alias pairs carry identical flags —
  standing rule).
- **Tempo**: reuse `timeline::bpm_at()` over the device's own position —
  onboard, no Pi round-trip (this resolves the parked Tempo-Pi→Daisy item).
- **Determinism**: PCG32 (or equivalent small PRNG) seeded via constructor.
  Fixed seed + fixed genome trajectory → **byte-identical `StepEvent`
  stream** — the dsp-side mirror of the plugin host's REPLAYABLE contract,
  and the basis for golden-trace tests. The seed also **draws the musical
  start** (key root, mode, opening chord degree, fixed draw order leading
  the stream), so different seeds start in different places rather than
  merely diverging later; the host rolls a fresh seed per launch and prints
  it (`PROCGEN_SEED` pins a roll).
- **Real-time discipline** (standing constraints): no alloc in the callback —
  all pattern storage `heapless`, transition tables `const` in flash (hundreds
  of bytes to a few KB; negligible against the 504 KB AXI heap, whose real
  pressure is the voices, §10 P3). Per-sample work is a phase increment;
  table lookups and regeneration happen on step/bar boundaries only. No
  per-sample transcendentals.

## 7. Sensor → room-state → reward pipeline (Pi)

**v1 is router graphs only — no new ops, no plugin.** The graph engine already
has everything needed (`Smooth ONE_POLE`, `Envelope AR`, `Combine WEIGHTED`
with negative weights, `Normalize`, `Trigger`, `Latch`):

- `derived.room.activity` — `Envelope(AR)` over `sensor.room.motion` (+
  `WEIGHTED` blend with `sensor.door.velocity_cm_s` magnitude), the pattern
  already proven by the occupancy graph.
- `derived.room.baseline_activity` — `Smooth` with a **minutes-scale** time
  constant over activity: the "normal for right now" estimate.
- `derived.room.deviation` — `Combine WEIGHTED [1, -1]` of the two: respond to
  change, not absolutes (invariant 2).
- `derived.room.reward` — **v1 stub**: `Const 0` → `Output`. The optimizer
  random-walks; the loop is exercised end-to-end before any objective exists.

A stateful `room_features.v1` plugin is the documented escape hatch for
features graphs can't express (dwell-time distributions, spatial clustering
across multiple ToF zones) — same `derived.room.*` topics, swapped writer.

## 8. The optimizer plugin

Asset `music_optimizer.v1`, a `plugin.v1` **GENERATOR** on the existing plugin
host — which already provides exactly what the loop needs: seeded PRNG
(replayable), 250 ms host tick, snapshot/restore, and the
`tools/sim/validate-plugin.js` determinism gate.

**It optimizes in mood space, not genome space** (§5): the search is over
`(x, y)` on the mood plane — 2 dimensions instead of 11, which is what makes
one-noisy-sample-per-minutes-long-evaluation viable — and the mood expander
turns the walk into genomes, so every point the optimizer can reach is on a
path between authored aesthetics.

- **Manifest**: `requiresHostTick: true`, `RATE_CONTROL`, `REPLAYABLE`,
  `SNAPSHOTTABLE`. Inputs: `reward` ← `derived.room.reward` (STATE),
  `occupied` ← `derived.room.occupied` (STATE, optional eval gate — don't
  burn evaluations on an empty room). Outputs: `music.mood.x`, `music.mood.y`
  (FLOAT STATE), consumed by the mood expander.
- **Params**: `sigma` (mutation scale on the plane), `settle_s` (let the room
  hear the candidate before measuring), `eval_window_s` (reward
  accumulation), `step_period_s` (generational clock, minutes-ish), plane
  bounds.
- **Tick state machine**: `INCUMBENT` (emit incumbent, accumulate its reward
  baseline) → mutate the position via `ctx.rand` → `SETTLE` → `EVALUATE`
  (accumulate candidate reward mean) → compare → keep or revert → repeat.
- **Snapshot** = incumbent + candidate + accumulators + phase (+ PRNG state,
  which the host already captures): a gallery-day restart resumes the walk
  instead of resetting it.

Design requirements recorded for the build (proposed 2026-06-11, no code
until P6 exists):

- **Novelty pressure** — a small reward penalty for camping in one region of
  the plane (e.g. distance-weighted against a slow EMA of recent positions):
  drift insurance against a degenerate objective.
- **Per-axis mutation scales** — `sigma_x`/`sigma_y` params; the plane need
  not be isotropic once anchors cluster unevenly.
- **Persistent region statistics** — long-run mean reward per plane region
  kept in the plugin snapshot, so accumulated room response survives
  restarts and can warm-start the walk.

## 9. Modes & coexistence with backing-track projects

Backing-track playback (today's SD-player firmware) and procgen are **separate
firmware images**, selected per project/exhibit through the existing cargo
alias scheme — the internal-flash image is already full, so co-residence waits
for a QSPI build, and a runtime mode-switch (timeline-driven
`Producer::Grid` ↔ `Producer::Conductor`, or generative interludes inside a
composed piece) is explicitly **deferred** until then. On the Mac host, a rig
flag selects the producer, so both modes stay auditioned from one binary.

## 10. Phased implementation plan

Ordered by risk-retirement; every phase independently verifiable, exploiting
the platform's replay machinery (golden traces on the dsp side, plugin
validator + captured sensor sessions on the Pi side).

- **P1 — `dsp::procgen` on the Mac host** *(first build)*. Conductor +
  Euclidean drums + Markov melody + bass rules; **hardcoded genome struct**;
  `Producer` enum behind `Engine`; host rig flag.
  *Verify:* `cargo test -p dsp` golden `StepEvent` traces (fixed seed+genome →
  exact event sequence over N bars); musical-constraint tests (all notes ∈
  scale, chord tones on strong beats, Euclidean pulse counts, leap limits);
  audition via the cpal host / `patch_server` browser editor. **This phase is
  where the music gets good or doesn't — budget listening time, not just
  tests.**
- **P1m — the mood layer** *(follows P1's listening pass — anchors are its
  artifacts)*. `moods.json` anchors; the `mood_expander.v1` plugin publishing
  `music.genome.*` (static position from params until a mood writer lands);
  host `--mood` / `--mood-sweep` audition reading the same anchors file.
  *Verify:* expander unit tests (anchor-exact at anchors, blend continuity,
  emit-on-change dedupe, snapshot/restore); host blend tests; audible A/B of
  the anchors and a sweep between them.
- **P2 — genome surface + CC plumbing (host)**. `Param` variants, `bind_cc`
  per the §4 table in `install_kiosk_bindings`, `apply_param` → conductor
  setters.
  *Verify:* sweep each CC end-to-end via midir; assert clamping at range edges
  and audible intent change; binding log matches the §4 table.
- **P3 — firmware procgen build** *(riskiest: first time the synth voices run
  on hardware — today's firmware is the SD player; kick/hats/stab/bass exist
  only in the host Engine)*. `procgen` feature instantiating voices +
  producer; aliases; heap + `bench` instrumentation.
  *Verify:* heap high-water under 504 KB with margin; per-stage cycle timings
  inside the 667 µs SAI block; CC 70–85 reception on hardware; `POS` telemetry
  unaffected.
- **P4 — conductor telemetry back**. `MUS <bar> <chord> <scale> <density>`
  CDC lines (per bar, beside `POS`); parse in `daisy-position.js`; publish
  `music.conductor.*`; module manifest + policy entries.
  *Verify:* `/bus/events` shows per-bar packets; a captured session contains
  them.
- **P5 — room-feature graphs + reward stub**. `graphs/room-features.json`,
  `derived.room.reward` Const-0 stub, policy role.
  *Verify:* replay a captured sensor session through `tools/sim` → golden
  feature trajectories (the validate-occupancy pattern).
- **P6 — optimizer plugin (mood-space walk) + genome→CC bindings**.
  *Verify:* `tools/sim/validate-plugin.js` replay determinism (same seed +
  trace → byte-identical mood/genome emissions); snapshot/restore resume
  test; multi-hour Mac-host soak against a replayed sensor trace confirming
  the walk stays on the mood plane and the expansion inside the clamp
  envelope.
- **P7 — exhibit integration**. Plugin instance JSON, policy allow-entries,
  golden session, install-day checklist addition.
  *Verify:* full-stack golden session; **degrade test** — kill the bridge
  mid-session, Daisy keeps playing on the last genome.

## 11. Deferred / open

- **The objective function** — deliberately open (invariant 3). Audition
  candidates as data (reward graphs / a reward plugin) in the real room after
  P7.
- **Contextual bandit** — alternative optimizer; switch criterion in §1.
- **14-bit CC pairs** — only if a gene proves resolution-starved.
- **CA percussion texture**, **multi-zone spatial features** (needs added
  ToF hardware; the `room_features.v1` plugin escape hatch). (The pad role
  is now covered by the bloom bank retuning to the announced harmony —
  `BloomAmount` + `StepEvent.chord`; a dedicated pad *synth* voice remains
  open if the resonator texture proves insufficient.)
- **Runtime producer switching / generative interludes** — post-QSPI (§9).
- **Visualizer consumption of `music.conductor.*` / `seq.*`** — the BACKLOG
  "Sequencer event → visualizer feed" item; P4 makes the signals exist.
- **Genome A/B or multi-armed audition tooling** — compare objective
  candidates against logged sessions.
- **Grain-delay / granular send** — explicitly excluded from the mood-layer
  build (Chris, 2026-06-11); the freeze/Stutter machinery is adjacent but is
  not this. Mood anchors gain a granular fx key when it lands.
- **Multi-layer field-recording sampler bank** — per-layer gains the mood
  layer can blend; today's `Sampler` is one buffer. Also explicitly excluded
  from the mood-layer build.
- **Mood writers** — timeline mood lane, sensor→mood graphs (need a policy
  role for `music.mood.*`), and the P6 optimizer; until one lands, the
  expander's instantiation params hold the static position.
- **Mood-driven asset selection** — nearest-anchor patch/sample switching at
  phrase boundaries with hysteresis; needs the asset channel (patch select,
  sampler bank) to exist first.
