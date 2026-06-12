# Backlog — future improvements

Canonical, version-controlled backlog for ambient_viz. Captured 2026-06-06 from a
design session + a sweep of all repo docs and notes. The live Claude Code task
list mirrors this but is session-scoped; **this file is the permanent home** —
update it here.

Each item links its source doc/memory. Dependencies noted inline. Completed
verification checklists from already-shipped work (USB composite Phases A–D, tape
failure live control, SAI audio path) are intentionally excluded.

## Platform / modularization

The umbrella epic: generalize from the single Pain Material installation into the
modular A/V platform defined in **`ARCHITECTURE.md`**. Ordered roughly by
dependency.

**Items elsewhere in this backlog that are already facets of this design**
(cross-referenced, not duplicated here):

- *Rust `dasp` DSP/analysis sidecar* (Audio capture/transport) — the external
  `audio.*` **source** form of audio analysis.
- *Sequencer event → visualizer feed* + *`StepEvent`-emitter as the generator
  abstraction* (Symbolic event stream) — the `seq.*` **source** and its
  producer contract. `seq.*` and `audio.*` are **both routable sources**;
  route/blend/fallback between them is a DSL decision, not a host hardcode.
- *MIDI output* (Symbolic event stream), *Phase E inbound sensor→MIDI over CDC*
  + *Tempo Pi→Daisy* (Firmware/DSP) — **transport** / clock-distribution edges.
- *Multi-project support* (Infra) — the **router config** / project manifest +
  selector + project-aware bridge/sidecar.
- *Addressable LED strip/array output* (Kiosk hardware) — an **emitter on the
  render plane** (Tier-B), a member of an **emitter group**; see that item for
  the WS2812/SK6812 + Pi-SPI/ESP32/Daisy detail. Generalizes to **distributed
  ESP32 render nodes** (the mirror of the sensor mesh — LED strips room-wide,
  each rendering its slice locally from shared control + position; no central
  wiring). Laser/ILDA and multi-projector are render-plane groups too. — see
  `ARCHITECTURE.md` (The render plane).
- *Proximity→effect direction config flag* (Visualizer features) — a
  **router-as-data** concern (mapping direction belongs in config).
- *Software-switched analog FX blocks* + *Modular FX backplane* (Analog FX
  hardware) — the hardware **audio router** + **audio processors**; their
  crosspoint selection and block params are **control-plane sinks**, and the
  per-card EEPROM is the **capability-enumeration** precedent.
- *ESP32 wireless sensor network* + *Multi-MPR121 touch expansion* (Sensors) —
  **distributed `sensor.*` sources** over a multi-hop transport. Extends to
  **edge audio analysis**: an ESP32 with a mic running local DSP and emitting
  derived `audio.<node>.*` control signals (level/onset/bands) — never shipping
  audio. See `ARCHITECTURE.md` (Why the edge tap matters).
- *Multichannel I/O (4×stereo TDM)* + *Synth/sampler Engine path* (Firmware/DSP)
  — the multi-channel **audio plane** substrate (live-musician / multi-speaker)
  and a non-exhibit **audio source**.

The new foundational items below are the ones that don't exist yet:

- [ ] **Formalize the control bus** — promote `window.AMBIENT_INPUTS` to a
  namespaced, typed signal registry (`sensor.*`, `clock.*`, `audio.*`, `seq.*`)
  with declared range/units **and the transport shapes + time semantics** (see
  Runtime contracts below: state / event / bundle, `TimePoint`). *Foundation for
  everything else.* — `ARCHITECTURE.md` (control bus, Runtime contracts)
- [ ] **Capability registry (`manifest.v1`)** — the supervisor collects module
  manifests (identity + publishes/subscribes + per-signal stale/failsafe +
  emitter group/geometry) and the project policy (authority ladder + roles +
  allowlist) into the registry the router/UI/inspector read. **Draft schema
  written: `MANIFEST_PROTOCOL.md`.** Next: implement the registry + manifest read
  path alongside `bus.v1`. — `MANIFEST_PROTOCOL.md`, `ARCHITECTURE.md` (Runtime
  contracts → Identity / Failure / Geometry / Authority)
- [ ] **Router as a typed graph IR** — extract the hardcoded mappings in
  `applyAutomation()` (e.g. `distance_cm → x²-ease → twistGain`) into a **compiled
  typed graph IR**, not a text DSL. Nodes (input/curve/smooth/select/blend/output)
  each declare a **`rate_domain`**; supports `domain.instance.field` + **compile-
  time wildcards** (`audio.*.bass` w/ a wildcard_policy), **select/blend/fallback**,
  and **emitter-group definitions** (membership + position + choreography). No
  hidden state; explicit delay nodes for cycles. Becomes the core of the project
  manifest. **Draft schema written: `ROUTER_IR.md` (`router.v1`)** — node set,
  compile/validation rules, `match_against: EXPECTED` wildcards, ZOH/`ONE_EURO`
  resampling, `Replicated` (groups + wildcard fan-out), `PluginBinding`. Next:
  build the compiler (manifests + RouterGraph → validated runtime graph),
  replacing `applyAutomation()`. The plugin side is drafted: **`PLUGIN_CONTRACT.md`
  (`plugin.v1`)** — versioned asset interface + compiler validation + the plugin
  registry. **Shared vocab extracted to `COMMON_PROTO.md` (`common.v1`)** — the
  five schemas (`common`/`bus`/`manifest`/`router`/`plugin`) are spec-complete;
  remaining is implementation only (stand up the `.proto`s, the router compiler,
  the plugin registry). — `COMMON_PROTO.md`, `ROUTER_IR.md`, `PLUGIN_CONTRACT.md`,
  `BUS_PROTOCOL.md`, `MANIFEST_PROTOCOL.md`, `ARCHITECTURE.md`, `SENSOR_MAPPING.md`
- [ ] **Clock abstraction** — a clock source publishing `clock.*` with a
  swappable driver (bpm-timeline / sequencer / MIDI-clock / tap / free-run);
  define the three sync tiers (tempo / frame-coherent / genlock). — `ARCHITECTURE.md`
- [ ] **OSC / MIDI transports** — bridges that marshal the bus namespace across
  machine boundaries (external gear, faders, TouchOSC, a second render node).
  MIDI where native (clock, notes). Generalizes the SSE bridge. — `ARCHITECTURE.md`
- [ ] **Visualizer host/plugin split** — carve `static/index.html` into a thin
  host (canvas/compositor + audio analysis + bus + clock + UI) and swappable
  visualizer plugins; Pain Material's pipeline becomes plugin #1. — `ARCHITECTURE.md`
- [ ] **Config-driven visualizer engine** — a data-driven plugin (scenes /
  palette / SVG silhouette / lane automation as config) so simple projects ship
  as data, not a code fork. *Depends on the host/plugin split.* — `ARCHITECTURE.md`
  > LED sink renderer (Pi/ESP32 process subscribing to `clock.*` + chosen
  > signals, standalone or mirroring a downscaled visualizer region; Tier-B
  > sync) is tracked under **Kiosk hardware → Addressable LED strip/array
  > output** — the bus framing here, the hardware/data-source detail there.
- [ ] **Multi-projector (research)** — edge-blended compositing + genlock across
  outputs; needs multi-output GPU / genlock hardware or a render-node cluster fed
  one clock. Tier-C, not single-Pi. *Far future.* — `ARCHITECTURE.md`

- [ ] **Inspector UI library (decide at phase 3)** — `/inspector` is vanilla JS
  with a hand-rolled keyed renderer; fine for read-only diagnostics. When phase 3
  gives it real interaction (policy/manifest views, WARN triage), pick a
  buildless, vendored library — **Preact + htm** (plain ESM, no compiler) or
  **lit-html** — rather than React-with-a-bundler; the repo's no-build rule is
  load-bearing on the Pi. Decide once, for the platform UI surface as a whole
  (phase 8 host UI inherits it). — `static/inspector.html`, `MIGRATION_PLAN.md`
- [ ] **Inspector timeline view** — a secondary `/inspector` view showing
  events over time (today's view is a point-in-time snapshot; diffing writers
  or spotting a transient means eyeballing live churn). Configurable lookback
  window to bound memory consumption: dropdown defaulting to **10m**, options
  1m / 5m / 10m / 30m / 1h, plus freeform text entry for arbitrary durations.
  Retention should be enforced where the history is buffered (ring buffer /
  time-pruned, sized by the selected window) — not just hidden in the render —
  so a day-long kiosk session can't grow it unbounded. Pairs naturally with
  the bus's `_meta.*` 1 Hz stream and the two-layer writer-candidates view
  (e.g. plot resolved value + per-writer values per path).
  — `static/inspector.html`, `server/src/bus.js`, `MIGRATION_PLAN.md` (shadow
  visibility)

#### Extraction & layout

- [ ] **Extract Pain Material to `projects/pain-material/`** — migrate the
  installation-specific content out of the engine, in dependency order: assets
  (now-ish, pure data) → manifest (timeline/palettes/mappings, needs the router
  IR) → the raster scene (needs the host/plugin split) → patches (needs a
  project-aware loader). **Directory scaffolded** (`projects/pain-material/` with
  README + subdirs); files not moved yet — do it *after* the engine/project
  boundary is stable. Split to a separate repo only at the 2nd real installation.
  — `ARCHITECTURE.md` (Repository layout), `projects/pain-material/README.md`

## Implementation plan (MVP cut — spec frozen 2026-06-10)

The schemas went through three review passes (two external) on 2026-06-10 and
both reviewers converged on the same instruction: **stop adding spec; make the
contracts executable.** The spec is frozen pending implementation — no new
conceptual surface until every existing abstraction has survived the trace
simulator and one real Pain Material migration.

**Canonical: [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md)** — the same cut,
re-sequenced as strangler-fig vertical slices that keep Pain Material live
throughout (shadow-by-priority, per-phase cutover/rollback, golden-trace
validation). *Phase 0 tooling landed 2026-06-10 (capture tap + replay harness,
`tools/replay/`); next: ≥ 1 h kiosk capture, then phase 1.* The capability
summary below is retained for orientation:

1. **Schemas + inspector, no router compiler.** `common.v1` + `bus.v1` codegen
   (ts-proto / prost+serde), proto-JSON logging, retained state, event-queue
   drain, `_meta` (rates / staleness / seq gaps / queue drops), and the
   **signal inspector**. No priority, signatures, or stale modes beyond HOLD —
   but every skipped enforcement displayed honestly (per-field truth values).
2. **Manifest registry + policy, minimal enforcement.** Module manifests,
   project allowlist, path/type/range validation, role `max_priority` check,
   duplicate `stable_id`/`instance_id` handling, visible `runtime_modes`.
3. **Offline trace simulator.** `input packet log + manifests + policy + tiny
   graph → output packet log + _meta log`. Golden traces: stale source, event
   burst, out-of-order seq, reboot epoch, priority handoff, wildcard
   unexpected-match, reload ramp; plugin seeded randomness once plugins exist.
4. **Tiny router compiler.** Only `Input / Const / Normalize / Curve / Scale /
   Combine / Output` (+ `Trigger`/`Envelope` if the first mapping needs them).
   No `Delay`, `Select`, wildcards, groups, or plugin bindings until a real
   mapping drives them. First real mapping: the Pain Material nearness chain
   (`projects/pain-material/manifest/IR_SKETCH.md`).
5. **One plugin: `presence_choreography.v1`.** It proves event queues, the
   seeded PRNG, `requires_host_tick`, and BUS outputs in one artifact (the
   raster scene comes after). Plugin host API spec lands here, not before.

Then — and only then — ESP bridge, render groups/LED nodes, OSC/MIDI adapters.

## Runtime contracts (harden before scale)

- [ ] **Firmware pinning + manifest-driven flashing** (2026-06-11, phase-4C
  conversation). Two halves of one loop — the manifest as the single source
  of truth for what a node must be running:
  1. **Pin at enrollment** — ProjectPolicy gains per-`stable_id` expected
     firmware (version tag first, WARN-mode mismatch as a registry load
     warning — catches "flashed the wrong build on strip 3" before doors;
     later the measured `firmware_hash` + trust FSM QUARANTINE per
     MANIFEST_PROTOCOL's open question, WARN→ENFORCE per staging doctrine).
     The point is FEATURE correctness, not just security: a node missing a
     feature its manifest claims (plugin asset, shaping slots) must surface
     before the show, loudly. Cheap precursor available any time:
     `schema_version` compat-gate check in registry.js (currently unchecked).
  2. **Flash from the manifest** — build/flash tooling reads the module
     manifests to select featureset + target per node (the Daisy's modular
     per-install builds — feature-gated cargo aliases, ITCM knapsack — are
     already per-build; manifests give that selection a declared source, and
     the same applies to future ESP edge nodes). Declared capabilities →
     build features → flashed image → enrollment verifies the loop closed.


The operational layer surfaced by the external architecture review (2026-06-09,
`Modular AV Architecture Design` PDF). Staging doctrine: **parameters present,
enforcement staged** — each contract's *fields* ship in the schema/wire format
now; the *checking* is a no-op until needed, so turning it on later is a config
flip, not a schema migration. The order roughly tracks blast radius. Detail in
`ARCHITECTURE.md` *Runtime contracts → Staging doctrine*.

- [ ] **Transport shapes + time** — bus packets as **state / event / bundle**
  (event = append-only, ordered, never collapsed/dropped between frames; bundle =
  atomic w/ execution timetag) and a **`TimePoint`** tagging each packet's
  timebase (`audio_sample | musical | monotonic | wall | render_frame`). *Do this
  before the router IR.* **Draft schema written: `BUS_PROTOCOL.md` (`bus.v1`)** —
  next: implement the `bus.v1` registry/types (TS + Rust serde mirror) replacing
  the flat `AMBIENT_INPUTS` snapshot. — review §1–2, `BUS_PROTOCOL.md`
- [ ] **Failure contracts** — per-signal `stale_after_ms` / `on_stale`
  (hold|null|default|decay|freeze_route|fail_safe) / confidence; and a **module
  lifecycle FSM** (discovered→configured→warming→active→degraded→stale→failed→
  removed) for the supervisor. — review §A–B
- [ ] **Authority / conflict resolution** — a numeric **priority ladder**
  (safety > manual > local-UI > timeline > generative > sensor > idle, à la sACN)
  + per-path publish/subscribe permissions; safety/blackout can always seize a
  sink. — review §D-conflict
- [ ] **Identity / capability / authorization** — split durable **identity**
  (key/cert, SPIFFE-style) from the routing path; **capability manifest**
  (stable_id/instance/type/fw/schema + per-signal unit/rate/stale); **project
  authorization** policy (capabilities are claims, not permissions). *Staged
  (parameters present, enforcement off):* ship `source_id`/`cert_fingerprint`/
  `sig`/`seq` fields now and **trust claimed identity** (no verification); later
  flip on a local project CA + mTLS/HMAC. Config flip, not a schema migration;
  not Web PKI. — review §4 + identity follow-up
- [ ] **Observability** — a **signal inspector** (who writes each signal, value/
  rate/staleness, drops, clock drift) + **route inspector** (compiled graph), as
  core tools, not debug extras (TouchDesigner CHOP-viewer lesson). — review §I
- [ ] **Group geometry contract** — member `geometry`: physical/logical coords,
  topology (ring/line/grid/graph), orientation, calibration, latency offset,
  color profile, brightness/safe envelope. "A ring of strips is not a line." —
  review §E
- [ ] **Analog FX transactional/safe route changes** — crosspoint switch as a
  transactional op (mute→ramp-down→switch→ramp-up) with forbidden states
  (feedback-without-limiter, output-to-input-same-card); route changes are
  privileged. — review §H, `ANALOG_FX_RACK.md`
- [ ] **Edge adapters (confirmed)** — OSCQuery (discovery export), DMX/sACN/
  Art-Net adapter (LED/lighting fixture semantics, don't reinvent), Ableton Link
  (clock-driver option for live/jam), Houdini-HDA-style versioned plugin/
  choreography assets (`laser.edge_tracer.v1`). — review prior-art table

## Audio capture / transport

- [ ] **Run the USB-capture diagnostic** — flash `debug-uart`, briefly revive
  `getUserMedia` capture, read `usb_drop`/`usb_pktmax` on the `diag:` heartbeat to
  decide Daisy-side (missed polls) vs Pi-side (PipeWire clocking) failure. *Gates
  the two below.* — `daisy/PLAN_USB_CAPTURE.md`
- [ ] **Pi-side capture quick wins** *(only if failure is Pi-side; needs diagnostic
  first)* — USB autosuspend off → PipeWire quantum/clock config → RT priority/affinity
  on PipeWire+Chromium. Skip RT kernel + static IP. — `daisy/PLAN_USB_CAPTURE.md`
- [ ] **WebUSB vendor-BULK capture spike** *(needs diagnostic first)* — expose audio
  over a class-0xFF bulk IN endpoint, read via `navigator.usb`→`transferIn`→AudioWorklet;
  bypasses the PipeWire/Chromium capture graph and makes SD stalls benign. Measure
  flash delta vs the UAC code. — `daisy/PLAN_USB_CAPTURE.md`, mem `daisy-usb-capture-revival`
- [ ] **Rust `dasp` DSP/analysis sidecar** — *design accepted 2026-06-12, see
  `AUDIO_ANALYSIS_SIDECAR.md` (DSP plan, dual-source build flags, bus contract,
  shadow→A/B→cutover migration, two-projector test planned-not-gated).* Publishes
  `audio.main.*` through the phase-8A `/bus/publish` ingress under its own identity;
  new root workspace `analysis/`, not `daisy/`. —
  `ARCHITECTURE.md` (Audio analysis sources), conversations 2026-06-06 / 2026-06-12

## Firmware / DSP (Daisy)

- [ ] **Grain-delay / granular send** — a granular FX send the mood layer can
  parameterize (mood anchors gain a granular fx key when it lands). Explicitly
  excluded from the mood-layer build (Chris, 2026-06-11); the freeze/Stutter
  machinery is adjacent but is not this. — `PROCMUSIC.md` (§11)
- [ ] **Multi-layer field-recording sampler bank** — today's `Sampler` is one
  buffer; the mood layer wants several layers with per-layer gains it can blend
  ("more field recordings" in ambient moods). Also explicitly excluded from the
  mood-layer build. — `PROCMUSIC.md` (§11), mem `exhibit-composition-structure`
- [ ] **async/DMA SD reads** — non-blocking SDMMC the audio task can `await` +
  double-buffering, so SD reads stop freezing the embassy executor (root cause of the
  USB iso clicks). Interim: contiguous-sector reads to make each read uniform <1 ms.
  *Partial:* the `sd-sdmmc` feature now drives SDMMC1 (`crates/firmware/src/sd.rs`), but
  via a `block_on` adapter into the **sync** `embedded-sdmmc` stack — so it still blocks
  the executor exactly like SPI. The real win needs an **async** FAT/block layer
  (`block-device-driver` + an async FS) so the audio task can `await` reads. Also needs
  the SDMMC1 socket wired (4-bit, D1–D6 — see "KiCad PCB design" under Hardware / PCB).
  — mem `daisy-uac-async-sd-future`, `daisy-usb-capture-clicks`, `daisy-sd-connector-roadmap`
- [x] **Bootloader + QSPI XIP** — DONE (2026-06-09). Runs from external QSPI (app @
  `0x90040000`) via the Daisy bootloader behind the `qspi` feature; `cargo flash-qspi-uac` /
  `flash-qspi-debug` build+flash via dfu on a USB power-cycle. Lifts the 128 KB ceiling →
  full `bell+voice` (which no longer fits internal flash) runs at opt-s. Benchmarked:
  +26 % on `tape` (I-cache contention) but `SAI_ERR≈0` → real-time-viable. Internal flash
  is now PARED (`flash-spi-bell`/`flash-spi-voice`); the opt-z workaround still applies
  to the internal-flash builds, dropped for QSPI. Future: ITCM-ramfunc `tape` if DSP load
  grows. — `daisy/BENCH_QSPI.md`, `daisy/PLAN_QSPI_BOOTLOADER.md`, mem `daisy-qspi-flash-future`
- [ ] **SAI RX `Overrun` restarts (startup-only, low priority)** — the audio loop
  restarts (`daisy-embassy audio.rs:169` "enter audio callback loop") on SAI **RX
  Overruns**, all clustered in the first ~1.3 s of boot: 2 at the SAI-start→loop-start
  gap, then one ~5-restart burst as the USB UAC stream comes up (variable timing across
  runs: 1.3 s / 3.7 s / 5.8 s). Steady state is glitch-free (`sai_err=0`, `cb_full=366µs`).
  The input is UNUSED (`|_input, output|` — `codec.read()` only paces the loop), so an
  Overrun = a brief loop stall (likely a `critical_section` IRQ-mask during USB/heap
  setup) that drops one ~0.67 ms output block before re-syncing → a faint boot click.
  Options if ever worth it: (a) trim startup critical-section stalls; (b) vendor
  `daisy-embassy` to continue (not `?`-bail + tear down output) on a benign RX overrun on
  an unused input. Diagnosed via the `bin-qspi-debug` SAI-restart error log (`main.rs`
  ~921). The separate boot SD-underrun (`sd_under=832`) is already FIXED by the ring
  pre-fill (`main.rs`, before the audio spawn). — mem `daisy-dsp-realtime`, conversation
  2026-06-09 (new)
- [ ] **Patch SD overlay (JSON) — GATED ON QSPI** — read `/PATCHES/BELL.JSON` +
  `STAB.JSON` at boot via `embedded-sdmmc` + `FmPatch::from_json` (serde-json-core),
  falling back to the compiled `FmPatch::bell()`/`industrial()` on any error. Threading
  is trivial (patches → `audio_task` args → the note-on patch swap). **Blocked:** the
  `serde_json_core` *deserialize* codegen for the patch structs is ~30 KB of flash and
  the internal-flash image is already full — measured a 30 KB overflow on the
  `bell,voice` prod build. Revisit once QSPI XIP lands. The shared serde schema
  (`FmPatch`/`BassPatch`/`Shaper` derive serde in `dsp`) and the browser/host live
  preview (`static/audio/patches` ↔ `host` `patch_server`) are **already done**; only
  the firmware read is deferred. If on-site editability is wanted sooner, a compact
  fixed-layout `.bin` overlay (hand-parsed, ~0 flash) is the pre-QSPI alternative. —
  conversation 2026-06-08 (new), mem `daisy-qspi-flash-future`
- [ ] **Phase E: inbound sensor→MIDI over CDC** — host→device sensor data as MIDI CC so
  a sensor drives Daisy audio (TapeFailure) in lockstep with the visual. Deferred at
  `usb_cdc.rs:16`. *A MIDI **transport** edge in the platform model: routing `sensor.*`
  to a Daisy sink.* — `daisy/PLAN_USB_COMPOSITE.md` Phase E, `ARCHITECTURE.md` (Transports)
- [ ] **Tempo Pi→Daisy (or onboard `bpm_at`)** for the dsp Sequencer — parked until the
  sequencer is instantiated; prefer onboard `bpm_at(own POS)` over a tempo CC. *Clock
  distribution across a transport edge — see the clock abstraction under Platform.*
  **Resolution designed**: `PROCMUSIC.md` P3 instantiates the sequencer clock on-device
  and picks onboard `bpm_at` (no tempo CC) — this item closes when P3 lands. —
  mem `daisy-tempo-sequencer-future`, `ARCHITECTURE.md` (Clock), `PROCMUSIC.md` (§5, P3)
- [ ] **Tape model quality** — oversampling (hysteresis, chew shaper), FIR crossfade on
  loss-filter changes, DC blocker, bypass smoothing, head-bump↔speed coupling, pre-tape
  EQ, mid/side, bias param, decorrelated stereo hiss, JA f32 audit. — `daisy/TAPE_SIMULATION.md`
- [ ] **Tape DSP unit tests** — regression tests on the Mac host (no-op `set_failure(0)`,
  monotonic brokenness, loss-FIR correctness, JA precision branch). — `daisy/TAPE_SIMULATION.md`
- [ ] **Multichannel I/O (4×stereo TDM)** *(speculative)* — AK5558/AK4458 availability,
  SAI pin routing, 8-slot TDM config, I²C init. — `daisy/MULTICHANNEL_IO.md`
- [ ] **Synth/sampler Engine path** *(optional, non-exhibit)* — `Engine::handle_midi`
  (currently a sine stub), dsp sampler, host MIDI input. Confirm it's wanted first. —
  `daisy/README.md` roadmap

### Waldorf wavetable oscillator (voice BUILT on host, conversation 2026-06-09)

Decoded the Waldorf Microwave II/XT user-wave dumps in
`patches/wavetables/*.mid` (215 waves, UW1035–UW1249) — SMF-wrapped SysEx
(`F0 3E 0E dd 12 hh ll <64 nibble-pair samples> cc F7`; 8-bit antisymmetric
half-waves, checksum `sum&0x7F`). Parser/exporter at
`patches/wavetables/waldorf_wavetable.py`.

**DONE:** a Microwave II-style wavetable voice now runs in the `dsp` core and
auditions live in the browser editor (`static/audio/wavetable`) through
`patch_server`, exactly like the FM/bass patches.

- [x] **Native `i8` bank, pre-mirrored to 128-sample cycles, flash-resident** —
  generated by `waldorf_wavetable.py rustbin` → `crates/dsp/src/wavetables.bin`
  (27_520 bytes), `include_bytes!`'d by `crates/dsp/src/wavetable_bank.rs` with
  table id/name/offset metadata (kept in lockstep with the editor's
  `wavetables.json`). Normalize is one `× (1/128)` in `wavetable_bank::sample`.
- [x] **`WtPatch` + `WtSynth` voice** (`crates/dsp/src/wavetable.rs`) — 2 morphing
  wavetable oscillators, mixer (osc1/osc2/ring/noise), multimode `Svf` filter,
  filter + amp ADSRs, osc2 sync + FM; 8-voice poly bank like `FmStab`. serde
  schema mirrors the editor `WT_PATCH` (string wavetable ids, enum filter type);
  round-trips via `serde_json_core`. Wired into `host::rigs::PreviewRig` +
  `patch_server` (`/wt/patch`, `/wt/trigger`).
- [ ] **Firmware build + flash placement** *(not yet on the Daisy)* — the host
  build `include_bytes!`s the blob into `.rodata`; for `qspi` firmware that lands
  in external flash and per-sample reads eat the +26% XIP penalty. Either
  `#[link_section]` the bank into internal flash (the `.itcm` knapsack trick) or
  `memcpy` the active wave (128 B) into AXI SRAM on wave-change so the inner loop
  hits cached SRAM. Prefer the copy. Also: instantiate `WtSynth` in the firmware
  audio task + the SD-overlay JSON path (gated on QSPI, same as `FmPatch`). See
  mem `daisy-qspi-flash-future`, `daisy-modular-itcm-perbuild`.
- [ ] **Aliasing (deferred)** — raw single-cycle 8-bit waves alias if pitched up;
  fine for slow low-register ambient pads. If it bites, add octave **mip-maps**
  (bandlimited variants), which multiplies storage — a deliberate follow-up.
- [ ] **Editor parity polish** *(nice-to-have)* — `glide` is in the schema but the
  poly `WtSynth` ignores it (mono/legato only); wire it if a mono mode is added.
  The Rust export tab still emits a "planned struct" placeholder — it can now emit
  a real `dsp::WtPatch` literal.

### Cortex-M7 utilization (audit, conversation 2026-06-08)

Audit of how well the firmware exploits the STM32H750's M7. Already good: FZ+DN
denormal flush, I/D-cache on, MPU for SDRAM, DSP heap in cached AXI SRAM,
stack/`.bss` in single-cycle DTCM. Four gaps found, in priority order. Key fact
to keep straight: the M7 has **scalar** double-precision FP **and integer** DSP-SIMD
(`SMLAD`/dual-16 MAC), but **no float SIMD** (NEON is Cortex-A; MVE/Helium is
M55/M85) — proven by disassembly (a 4-lane f32 multiply lowers to 4 scalar
`vmul.f32` even at `-O3 -C target-cpu=cortex-m7`).

- [ ] **Add `-C target-cpu=cortex-m7` to the firmware build** *(validated; one-line,
  highest ROI)* — the default `thumbv7em-none-eabihf` is Cortex-M4-class codegen with a
  **single-precision-only** FPU, so all on-device `f64` runs in **soft-float**. The
  `Sampler` playback position (`position += step`/sample; f64 is justified — f32's
  24-bit mantissa drifts over a 50 M-frame sample) and the resample ratio are the
  consumers. Measured: baseline binary has `__aeabi_dmul`×35 / `__adddf3`×34 and zero
  `.f64`; with the flag those soft-float helpers vanish, **178 hardware `.f64`
  instructions** appear, **and text shrinks ~4.7 KB** (122048→117340 — eases the 128 KB
  ceiling). No source or numeric change. Flag is currently applied in
  `daisy/.cargo/config.toml` but **not committed** — needs an on-hardware smoke test
  (`CB_FULL_US`/`SAI_ERR`) first, then commit. — conversation 2026-06-08 (new)
- [ ] **Place the hottest DSP / audio-ISR code in ITCM** — the 64 KB ITCM (`0x0000_0000`)
  is unused; the audio FX run in the UART4 interrupt executor fetching from cached flash.
  I-cache helps steady-state but ITCM gives deterministic zero-wait fetch with no eviction
  jitter — directly targets the worst-case block time tracked by `CB_FULL_US`. Needs a
  linker section in `memory.x` (`> ITCMRAM`), `#[link_section]` on the hot fns, and a
  startup copy. Medium effort. — conversation 2026-06-08 (new)
- [ ] **Explicit FMA (`mul_add`) in the hottest inner loops** — zero `mul_add` in the
  codebase today, and without fast-math LLVM won't fuse `a*b + c` across statements, so
  biquad/SVF/comb/FIR loops emit separate `VMUL`+`VADD` instead of single-cycle `VFMA`.
  Adding explicit `.mul_add()` cuts instructions and improves accuracy, but it's a per-site
  numeric change (single vs double rounding) — apply only to measured-hot loops with
  before/after `CB_FULL_US`. — conversation 2026-06-08 (new)
- [ ] **Integer DSP-SIMD for the i16 reverb combs** *(speculative, high effort)* — the
  low-mem reverb stores combs as `i16` with 2× downsampling, which is exactly the layout
  the M7's integer DSP-SIMD (`SMLAD`/dual-16 MAC, `SADD16`) is built for — the one place
  real M7 SIMD applies. Rust/LLVM won't auto-emit these; needs hand asm or unstable
  `core::arch::arm` DSP intrinsics. Narrow payoff. Also: fix the vendored reverb comment
  (`daisy/vendor/.../reverb_low_mem.rs`) "no hardware SIMD on the Daisy's Cortex-M7" →
  "no *float* SIMD" — it has integer DSP-SIMD, just not for f32. — conversation 2026-06-08
  (new), mem `daisy-dsp-realtime`

## Sensors

- [ ] **ESP32 wireless sensor network** — ESP-NOW satellites (ESP32-C3) → ESP32-S3 host →
  Pi over USB CDC. Prototype one node→host→Pi; measure real in-enclosure ESP-NOW range;
  decide detection-logic split + battery vs wired; deterministic USB enumeration. —
  `ESP32_SENSOR_NETWORK.md`, `TOUCH_EXPANSION.md` Option B
- [ ] **Multi-MPR121 wired touch expansion** — extend `touch.py` to multiple boards over
  extended I²C; grow TOUCH_COLORS/TOUCH_ENV + worker mapping. Wired alternative to ESP32
  satellites. — `TOUCH_EXPANSION.md` Option A, mem `kiosk-mpr121-mapping`

## Rendering / performance

- [ ] **Measure the render bottleneck** — `?bitmap=N` FPS sweep (scaling ⇒ upload-bound)
  + direct-scanout check (`WLR_SCENE_DISABLE_DIRECT_SCANOUT=1` A/B; `labwc -d | grep scan`;
  `sudo cat /sys/kernel/debug/dri/<vc4>/state`). *Gates native eval.* —
  `PI_PERFORMANCE.md`, conversation 2026-06-06
- [ ] **Eliminate per-frame `texImage2D(canvas)` upload** — migrate remaining Canvas2D
  compositing to FBO/WebGL-resident rendering (the dominant Pi-4 GPU-bandwidth cost). The
  higher-ROI alternative to a native rewrite. — `PI_PERFORMANCE.md`
- [ ] **Evaluate a native wgpu renderer** *(only if still GPU-bound after FBO work +
  measurement)* — gain is GPU-residency + dropping Chromium's command-buffer tax, NOT
  fewer compositor ops; it's a full renderer rewrite. — mem `viz-native-wgpu-tradeoff`
- [ ] **Remaining Canvas2D micro-optimizations** — the unchecked `[ ]` items in
  `OPTIMIZATIONS.md` (#3,4,6–14: lattice integer coords, grain pre-bake, gradient cache,
  Float32Array, globalAlpha, save/restore trim, etc.).
- [ ] **Runtime-tunable render knobs** — expose FLYOUT_COUNT, SCANLINE_PERIOD (const today),
  wire up ED_TOOLBAR_H. — `PI_PERFORMANCE.md`, `static/index.html`

## Kiosk hardware

- [ ] **Addressable LED strip/array output** — drive WS2812/SK6812 from audio/visual state
  (Pi SPI vs ESP32 node vs Daisy); define layout + data source (palette/levels via SSE or
  the dasp sidecar). *In the platform model this is the LED **sink** (Tier-B sync),
  subscribing to `clock.*` + chosen signals; standalone or mirroring a downscaled
  visualizer region.* — `ARCHITECTURE.md` (LED strips/panels), conversation 2026-06-06 (new)
- [ ] **Finalize cursor hiding on labwc** — transparent XCURSOR_THEME for the compositor
  default (mouseless case), plus the USB-mouse + page-cursor sources; verify on hardware. —
  `PI_KIOSK_BRINGUP.md`, mem `kiosk-hide-cursor-wayland`
- [ ] **Enclosure: measurements + print fixes** — board/jack/USB/cable/Dupont measurements;
  fix undersized holes, snap-fit, edge stringing. — `ENCLOSURE.md`, `MODEL_NOTES.md`

## Hardware / PCB (Pain Material breakout)

- [ ] **KiCad PCB design (post-prototype)** — once the perfboard breakout (Board A,
  `BREAKOUT.md`) is validated, lay out proper PCBs in KiCad to replace the hand-wired
  prototype. Folds in the MIDI/opto/audio-jack blocks plus the **SD connector
  productionization**: drop the prototype Adafruit #4682 / WWZMDiB SPI module for the bare
  **GCT MEM2075-00-140-01-A** push-push spring socket — fine-pitch SMT (1.09 mm, *not*
  0.1"-compatible), so it needs a custom land pattern from `gct.co/files/drawings/mem2075.pdf`
  (DM3AT-SF-PEJM5 = footprint-different fallback) — wired to **SDMMC1** (D1–D6) for 4-bit
  mode. Pairs with the firmware **async/DMA SD** migration (SPI1 `embedded-sdmmc` → embassy
  `Sdmmc`). — `daisy/BREAKOUT.md` §4.3, conversation 2026-06-08 (new), mem
  `daisy-sd-connector-roadmap`

## Test equipment / tooling

- [ ] **Investigate a logic analyzer** — for debugging the digital buses on the Daisy
  breakout and the analog-FX control plane (SDMMC1 4-bit timing, SPI1 SD, MIDI UART,
  I²C sensor/digipot/crosspoint traffic, USB-CDC/UAC enumeration sanity). Would have
  directly shortened the SDMMC bring-up and the marginal-SD-breakout debugging (mem
  `daisy-sdmmc-dtcm-dma`, `daisy-sd-marginal-breakout`). Candidates, roughly in
  decreasing capability/cost:
  - **Saleae Logic 8** — best-in-class software (live protocol decoders for SPI/I²C/
    UART/USB), 8ch, 100 MS/s digital / 10 MS/s analog. Expensive (~$400+). The "just
    works" option; cross-platform, scriptable.
  - **Digilent Analog Discovery 3** ([ref](https://digilent.com/reference/test-and-measurement/analog-discovery-3/start)) —
    not just a logic analyzer: 2ch 125 MS/s scope + 2ch AWG + 16-pin digital
    (logic-analyzer **and** pattern-generator) + power supplies, all in one USB pod via
    WaveForms. ~$400. The most *versatile* pick — covers the analog-FX-rack work (scope
    the buffered audio bus, generate test tones, characterize digipot/VCA response) as
    well as digital-bus decode. Strong candidate given the analog-FX direction.
  - **Bus Pirate** — cheap (~$30–50, esp. the v5/v6 RP2040 generation), great as an
    *interactive bus probe / sniffer / injector* (talk to an I²C/SPI device by hand,
    sniff a few lines) but **not** a real multi-channel, timing-accurate logic analyzer.
    Complementary to, not a replacement for, the above.
  - **Cheap Amazon clones** (~$10–15 "USB Logic Analyzer 24 MHz 8CH", Cypress FX2-based)
    — work with **sigrok/PulseView** (open-source) and decode SPI/I²C/UART fine at low
    rates; 24 MS/s is marginal for 4-bit SDMMC but adequate for MIDI/I²C/slow-SPI. The
    pragmatic "buy one today to unblock bring-up" option; many spoof the Saleae VID/PID,
    so drive them with sigrok rather than Saleae's software.

  **Lean:** an FX2 clone + sigrok now for immediate bus debug (~$12), and seriously
  weigh the **Analog Discovery 3** as the real purchase since its scope + AWG also serve
  the analog FX rack — a plain logic analyzer (even the Saleae) doesn't. —
  conversation 2026-06-09 (new)

## Analog FX hardware (speculative)

- [ ] **Software-switched / parameterized / reroutable analog FX blocks** — build discrete
  analog effects (e.g. analog distortion, analog reverb) as modular blocks the Daisy/Pi can
  control digitally. **(A) Routing** — feasible: analog crosspoint/switch ICs (`MT8816`,
  `ADG1414`, `DG409`, `CD4053`) over SPI/I²C for series/parallel/swap/bypass, *or* latching
  signal relays for cleaner true-bypass when routing changes infrequently (no charge-injection
  clicks). **(B) Params** — mix/drive/tone via digital pots (`MCP41xxx`, `AD5252`, `X9C`) or
  VCAs/OTAs (`THAT2180`, `LM13700`; VCAs preferred for click-free slow swells, no zipper noise).
  **Caveat — reverb "room size"**: a real spring/plate has *fixed* decay (only mix/damping/regen
  are tweakable); for continuous software size control the topology must be **PT2399-based**
  (delay-time resistor → digipot; cheap, lo-fi, pragmatic) or **BBD-based** (`MN3005`/Coolaudio
  `V3205`, clock-frequency = time; scarce/pricey). Controller = Daisy (spare I²C/SPI/GPIO + USB
  link to Pi), so the existing sensor/SSE plumbing can drive params. Gotchas: digital-line noise
  coupling into analog audio (opto-isolate/layout), switch clicks (relays/zero-cross/crossfade).
  — `ANALOG_FX_RACK.md` §1, conversation 2026-06-08 (new)
- [ ] **Modular FX backplane — common slot connector + breakout cards** — make the above blocks
  swappable daughtercards on a motherboard with N identical keyed slots. **One connector spec**
  (~16–20-pin keyed IDC/card-edge) per slot carries: buffered audio I/O (single-ended + ground
  guards, or differential for noise immunity), analog power (`±12V`/`AGND`), digital power
  (`+5V`/`+3V3`/`DGND`), a shared `SDA`/`SCL` control bus, slot-select, and a `CARD_PRESENT` +
  EEPROM ID. **Key decisions:** (1) bus each slot's audio back to a **central crosspoint** on the
  motherboard (NOT slot→slot chaining) so routing stays software-arbitrary regardless of which
  cards are present; (2) **buffer audio at every card's in/out** so harness impedance/contact
  resistance stop mattering — the #1 reliability move; (3) solve "indexable slots" with a per-slot
  **I²C mux (`TCA9548A`)** so cards can be built identically and addresses repeat without collision
  (alt: 3 address-strap pins → max 8 slots; or SPI w/ per-slot `CS`); (4) put a tiny **`24Cxx`
  EEPROM on each card** holding type/param-map so the controller **auto-enumerates the rack on
  boot** → genuinely plug-and-play, software-defined. Gotchas: key/polarize the connector (no
  reverse insertion), interleave ground guards, per-slot PTC fuse + decoupling, current budget per
  slot. Precedent: Eurorack/modular backplanes, PC expansion slots. Connector choice (IDC vs
  card-edge vs DIN 41612), Eurorack A-100 bus reference, and the buffered+guarded+differential
  shared-bus signal-integrity analysis are written up in `ANALOG_FX_RACK.md` §§2–4. —
  `ANALOG_FX_RACK.md`, conversation 2026-06-08 (new)

## Visualizer features / interaction

- [ ] **Proximity→effect direction config flag** — replace the hardcoded reversal (near =
  distorted, ce577ea, 3 ramps/2 files) with one flag; share with the Phase E audio leg.
  *A concrete instance of **router-as-data**: the mapping's direction belongs in the
  project config, not hardcoded.* — mem `distance-reverse-flag-future`, `ARCHITECTURE.md`
  (Router)
- [ ] **Build out unbuilt EXHIBIT interactions** — B dwell-destabilizes, D buzzer/touch
  stabs, E humidity→reverb, F floor-pad beats, G spatial zones, H eavesdropping cone; plus
  catch-delay tap + SVF bloom bank. Suggested first build A+C+D. — `EXHIBIT.md`

## Symbolic event stream (visuals + algorithmic music)

High-level design from a 2026-06-08 session that started as "convert `.pat` → MIDI"
and reframed: the leverage isn't the *file format*, it's a symbolic **event stream**.
The host sequencer already emits a fully-resolved `StepEvent` per sample
(`daisy/crates/dsp/src/sequencer.rs` — kick velocity, hats, `stab: Option<StabHit>`
with chord **and** `stabtone` already resolved, bass gate). That struct is the
low-bandwidth, sample-accurate, *richer-than-MIDI* signal we want — chord identity
and the tone float ride as native fields where MIDI would force GM-drum-note mapping
+ a CC convention and lose fidelity. So: **don't port `.pat` to `.mid`.** Keep `.pat`
as the human-editable loop source; build the stream layer instead.

- [ ] **Sequencer event → visualizer feed** — tap `Sequencer::advance()` in the host
  per-sample loop, serialize each non-empty `StepEvent` to a JSON event
  (`{t, kick, hats, stab:{chord, tone}, bass:{on, note}}`), and push it over the
  **existing Node SSE bridge** (same path as sensor data). Expose this symbolic feed
  as a `seq.*` source the visualizer can consume — but make `seq.*` vs FFT `audio.*`
  a **routing choice** (route/blend/fallback per project, e.g. symbolic for sequenced
  sections, FFT for the ambient bed / 4 distant songs), **not** a hardcoded preference.
  Pairs with the `dasp` analysis sidecar item above. *Needs the router's multi-source
  select/blend primitives.* — `ARCHITECTURE.md` (Symbolic and analysis sources are both
  routable), conversation 2026-06-08 (new)
- [ ] **`StepEvent`-emitter as the generator abstraction** *(foundation for the next
  project: directorially-guided algorithmic ambient)* — define the serializable event
  as the contract and put today's `Sequencer` behind it as one implementation, so an
  algorithmic generator can be a second producer of the *same* stream. Both producers
  feed the audio engine **and** the visualizer identically; "directorial intent" =
  choosing/blending/swapping producers per timeline section (some lanes from `.pat`
  loops, others generated on the fly). The visualizer never knows which. *This is
  the bus **source-producer contract** in the architecture.* **Now elaborated by
  `PROCMUSIC.md`** (producer enum `Grid(Sequencer) | Conductor(ProcGen)`, sensor-driven
  evolutionary loop, phased plan); child items below track its build phases. —
  `ARCHITECTURE.md` (module taxonomy / Symbolic sources), conversation 2026-06-08 (new),
  mem `exhibit-composition-structure`, `PROCMUSIC.md`
  - [ ] **P1: `dsp::procgen` on the Mac host** — conductor (chord FSM, density/tension,
    bar clock) + Euclidean drums + constrained-Markov melody + bass rules, hardcoded
    genome, `Producer` enum behind `Engine`, host rig flag; golden `StepEvent` traces +
    musical-constraint tests + listening time. — `PROCMUSIC.md` (§5, P1)
  - [ ] **P3: firmware procgen build** — `procgen` feature instantiating the synth
    voices + producer on the Daisy for the first time (today's firmware is the SD
    player); riskiest phase — heap/CPU budget against 504 KB AXI + 667 µs SAI block. —
    `PROCMUSIC.md` (P3)
  - [ ] **P6: `music_optimizer.v1` plugin** — (1+1)-ES on the plugin host
    (REPLAYABLE/SNAPSHOTTABLE), `derived.room.reward` in, `music.genome.*` out,
    genome→CC 70–85 bindings via the resolved-binding pattern. — `PROCMUSIC.md` (§7, P6)
- [ ] **MIDI output (parallel, optional, later)** — *only* if external gear/DAW enters
  the loop (hardware synth voicing the stabs, recording the generative output). The
  host already links `midir`; add a MIDI *out* alongside the JSON event stream — an
  IO/export concern, never a replacement for `.pat` or the visualizer feed. *A MIDI
  **transport** edge exporting `seq.*` to external gear.* — `ARCHITECTURE.md`
  (Transports), conversation 2026-06-08 (new)

## Infra

- [ ] **Multi-project support** — generalize from the single hardcoded arrangement to a
  project manifest (audio, timeline/lanes, sensor mappings, palettes, localaudio source) +
  a selector; make the bridge + Python sidecar project-aware. *This manifest **is** the
  platform's router config + assets; pairs with "Router as data" under Platform.* —
  `ARCHITECTURE.md` (Router), conversation 2026-06-06 (new)
