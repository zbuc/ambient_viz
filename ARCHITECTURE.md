# Architecture — a modular A/V platform

> Canonical high-level map of where this project is going. This repo began as
> a single browser visualizer for the **Pain Material** installation; the goal
> now is a **modular system for A/V projects** — synthesis, sampling,
> sequencing, sensing, visuals (Chromium + LEDs + eventually projectors), all
> bound together by a configurable clock and a uniform way of routing signals
> between them.
>
> This document defines the **target model and contracts**. It is honest about
> what exists today vs. what is still aspirational — see *Current state vs.
> target* at the end. Subsystem docs (`README.md`, `EXHIBIT.md`,
> `SENSOR_MAPPING.md`, `PARAMETERS.md`, the `daisy/` docs) describe concrete
> instances and implementations; this is the frame they hang on.

## Goal

A **reusable framework** — not a one-off. Each show/piece is built as a
*project* (data + a few plugins) on top of stable module contracts, rather than
forked from a hardcoded arrangement. Pain Material is the **first / reference
project**, not the product.

## Module taxonomy

Everything in the system is one of a small number of roles. Modules don't know
about each other directly — they only know the **bus** and the **signal names**
they read or write.

| Role | What it is | Examples (today / planned) |
|---|---|---|
| **Source** | Publishes named signals onto the bus | Sensors, audio-analysis, the **clock**, the **sequencer / generator** |
| **Sink** | Subscribes to signals | Synth/FX params; and media-plane **emitters** when driven parametrically (a visualizer, LED array, laser) — see *Three planes* |
| **Router** | The *project definition* — a declarative graph mapping sources → sinks with curves/scaling/smoothing/combination | Today's `applyAutomation()` + the planned project manifest |
| **Clock** | A special source publishing tempo/beat/phase; its **driver** is swappable | bpm-timeline lane (today), sequencer, MIDI clock, tap, free-run |
| **Transport** | Marshals signals across a process/machine boundary | In-browser bus object, the Node **SSE bridge** (today), **OSC**/MIDI bridges (planned) |
| **Host** | A container that hosts sinks/sources and a render surface | The visualizer host (browser); a future LED host |

### Three planes: one control plane, two media planes

The roles above are the **control plane** — low-bandwidth named signals
(params, events, clock) on the bus. It does **not** carry the actual content;
it *parameterizes* the content. The content lives on two **media planes** —
real-time, high-bandwidth, device-bound output substrates that each have their
own internal routing and timing:

- **Audio plane** — sample streams flowing through devices → speakers.
- **Render plane** — frames / visual descriptions flowing through devices →
  **screens, projectors, LED arrays, laser emitters**.

Conflating any of the three is the easiest way to get the architecture wrong,
so they are named separately. The control plane sits above both media planes
and steers them; **visualization is a full media plane, not a control-plane
sink.** That is the key correction the diverse visual targets (Chromium on Pi,
multi-projector, arbitrary addressable LEDs, lasers) force.

Each media plane mirrors the control-plane roles but carries content, not
signals:

| Role | Audio plane | Render plane |
|---|---|---|
| **Source** | Daisy ADC (live in), synth engines, file/Pi playback, external interface/DAW | A **scene** — a visualizer plugin, media file, or generative content producing frames / an abstract visual description |
| **Processor** | Daisy DSP FX (tape, reverb), **analog FX rack** blocks | Compositor / warp / edge-blend / color-match; **map** a scene to a target (downscale to an LED layout, trace a frame's outline to a laser path) |
| **Router** | In-DSP mix/route (Daisy/Pi) **or** analog backplane crosspoint (hardware) | Distribute one scene to many emitters; multi-projector tiling; LED-layout mapping |
| **Sink (emitter)** | DAC → PA / multi-speaker, USB to the visualizer, the analysis tap | Chromium canvas/projector, LED controller, laser DAC |

**How the planes interact:**

- **Control parameterizes both** — a sensor/clock/UI signal routed to an FX
  param *or* to a scene param is the same kind of edge.
- **Audio feeds control** — analysis taps the audio plane and publishes
  `audio.*` back onto the bus (see *Audio analysis: one tap per thing you listen
  to*).
- **The render plane is largely terminal** — it consumes; it does not normally
  feed back. (A camera is *not* render feedback: it's a high-rate **input media
  stream** that computer vision reduces to `sensor.*` on the control plane — see
  *Are sensors "just control-plane sources"?*.)

**Both media planes are device-swappable.** Just as the audio source can be the
Daisy or swapped out for a Pi/external source, the render target can be Chromium,
LEDs, a laser, a projector array, or several at once. No module assumes a
particular device is the audio origin or the visual output — each is *one
implementation* of a plane role, steered over the bus like anything else.

## The control bus (the core contract)

The single most important design decision: **modules communicate through a bus
of named, typed signals**, not through direct calls.

A **signal** is:

- a **name**, `domain.instance.field` — a **domain** (`sensor`, `audio`,
  `clock`, `seq`, `touch`), an **instance** naming *which one*, and a **field**.
  Examples: `audio.mix.bass`, `audio.ch3.level`, `sensor.door.distance_cm`,
  `touch.pad2.e0`, `seq.bass.step`. The instance is **always present, even when
  there is only one** — no collapsing to flat names. A lone audio tap is
  `audio.main.bass`, not `audio.bass`. Keeping it explicit means tooling,
  wildcards (`audio.*.bass`), and routing UIs never special-case the
  single-instance shape, and adding a second instance never renames the first.
  (Today's flat `window.AMBIENT_INPUTS` names — `distance_cm`, `audio.bass` —
  are pre-namespace and get migrated to explicit instances.);
- a **value** — scalar or small vector;
- a **kind** — *continuous* (a level sampled each frame, e.g. distance, bass)
  or *event* (a discrete fire with optional payload, e.g. a sequencer step, a
  touch onset);
- a **declared range / units**, so routers can scale and curve generically.

The **instance** segment is what makes multiplicity work — multiple audio
channels, distributed sensor nodes (the ESP `node_id`), several touch boards,
parallel sequencer lanes. Without it, a second source of the same kind has
nowhere to live. (For audio specifically, see *Audio analysis: one tap per
thing you listen to* — each analysis **tap** is an instance.)

`window.AMBIENT_INPUTS` in `static/index.html` is today's prototype of this — a
live snapshot keyed by wire name (`distance_cm`, `motion`, `touch_mask`,
`breath_detected`) that the visualizer reads opportunistically. The target
formalizes the namespace, the kind/range metadata, and makes audio analysis,
the clock, and the sequencer first-class publishers alongside sensors.

### Why a bus + OSC at the edges (not OSC everywhere, not per-project wiring)

- **Internally, signals are just bus values** — no serialization, no network
  hop for same-process paths (browser audio-analysis → browser visualizer).
- **At boundaries, transports marshal the same namespace.** The existing
  Pi→browser **SSE bridge** is one transport. **OSC** is the planned transport
  for external hardware, other machines, and tools (TouchOSC, faders, a second
  rendering node); **MIDI** where it is native (clock, notes). Because every
  transport exposes the *same signal names*, an external OSC source and an
  in-browser source are interchangeable to a sink.
- **Per-project wiring still exists — as the router config**, not as forked
  code. We standardize the *signal namespace* and the *curve/scale primitives*
  so a new project is data.

### Router (the project, as data)

The router maps sources to sinks. Each edge is roughly:

```
source signal → [gate] → [curve] → [scale/offset] → [smooth] → [combine] → sink param
```

A sink param may be fed by **more than one source**, so the DSL also needs
multi-source primitives: **blend** (mix/sum/max several sources into one param),
**select / fallback** (choose a source by availability or activity — e.g.
`seq.*` when a generator is running, else `audio.*`), and a notion of source
**availability/activity** to drive that selection. These are what make "prefer
the symbolic stream, fall back to FFT" a *config* expression rather than a host
hardcode (see *Symbolic and analysis sources are both routable* below).

Today this lives as hardcoded JS. The canonical example is
`distance_cm → (x² ease-in from 75cm) → twistGain → maxTwistDeg`
(`SENSOR_MAPPING.md`). The target makes the edge a config entry so the same
primitives (ease curves, smoothing time-constants, min/max, combine modes)
compose into any mapping without touching visualizer code. The
**multi-project manifest** in `BACKLOG.md` (audio + timeline/lanes + sensor
mappings + palettes + localaudio source) is this router config plus its assets.

## Clock

A configurable master clock is a **source** publishing `clock.tempo`,
`clock.beat_phase`, `clock.bar`, etc. The **driver** behind it is swappable per
project:

- **bpm-timeline lane** — today's mechanism; the `bpm` lane in the track's
  `.timeline.json` drives all beat-locked visuals (twist cycle, color/shape
  cycling). Good when the clock follows a composed arrangement.
- **sequencer** — the Daisy host `Sequencer` already emits a fully-resolved,
  sample-accurate `StepEvent`; that can *be* the clock source (see the
  symbolic-event-stream work in `BACKLOG.md`).
- **external** — MIDI clock in, or a tap-tempo / free-run for non-composed
  material.

### Clock distribution: extrapolate, don't sample

How `clock.*` reaches distributed consumers is a **contract**, not an
implementation detail — and the contract is: **never ship sampled
`beat_phase`.** A phase float updated at radio rate (~20 Hz) ZOH-steps a
60 fps strip wave; live linear interpolation is impossible (no future sample —
`ROUTER_IR.md` → *Resampling*); and phase wraps 0→1, which breaks naive
interpolation and smoothing regardless.

Instead the clock source publishes a **(beat, tempo) tuple** —
`clock.<inst>.beat` (beat number, anchored by the packet's `TimePoint`) and
`clock.<inst>.tempo` (BPM) — and every consumer **extrapolates locally**:
`beat(t) = beat₀ + tempo · (t − t₀) / 60`, deriving phase by wrapping.
Continuous at any frame rate, robust to low update rates and packet loss; a
tempo change is simply a new tuple. (**Ableton Link** is the prior art — and
remains a *driver*-level adapter for jam sessions.) Non-beat sections (the
ambient bed, per *Resolved decisions → #3*) publish the same way:
`clock.<inst>.section` plus a slow section-phase analog of the tuple.

The honest dependency: extrapolating from another device's anchor needs a
**coarse monotonic-offset estimate** between hub and node — a ping exchange at
pairing, refreshed occasionally. Staged like everything else: a rough offset
is fine for Tier A/B; Tier C sample-lock never rides this path anyway.

Sync quality is **observable and self-enforcing**: the offset estimator
publishes `_meta.clock.<inst>.{offset_ms, rtt_ms, jitter_ms, quality}`
(`quality: unlocked | estimating | good | degraded`), and a **Tier-B emitter
refuses its frame-coherent claim while quality is below `good`** — it degrades
to Tier-A behavior rather than rendering confidently wrong phase. Error
budgets are per-tier config defaults (Tier A ~±10 ms phase, Tier B ~±2 ms
inter-node skew), not new schema.

### Sync tiers (the "mixed by component" reality)

Not everything needs the same tightness; spending genlock-grade effort
everywhere is wasted. Each **media-plane sink/emitter declares a tier**; most of
the control plane is Tier A. Three explicit tiers:

- **Tier A — tempo / beat.** Most sinks: synth params, the visualizer's pulse,
  the sequencer. Sub-frame jitter is fine. This is everything today.
- **Tier B — frame-coherent.** LED panels/strips, laser emitters: need a steady
  frame cadence and correct beat phase; tolerant of ~ms.
- **Tier C — genlock / sample-locked.** The hard timing edges of the media
  planes — **multi-projector** frame genlock (render) and **converter sample
  lock** (audio, the shared AKM word clock). Requires dedicated hardware, **not
  feasible on a single Pi** for the projector case. A future tier — see
  *The render plane → Emitters* and *The audio plane → Two clock domains*.

## The render plane (visual output)

Visualization is a media plane (see *Three planes*), not a single device. The
Chromium visualizer is today's only emitter, but the plane carries content to
LED arrays, lasers, and projector walls too — and the right unit for organizing
that is neither one global scene nor a pile of independent devices.

### The unit is the emitter group (ensemble)

A **group** is a set of emitters coordinated in one medium-native way: *12
lasers firing in sequence*, *4 LED strips doing a room-wide wave*, *the raster
on screen*. A project runs **several groups at once**, each with its own
**choreography** (how its members coordinate) over its own **members** (the
physical emitters, each with a known **position / index** in the group). This is
the visual mirror of grouping on the audio plane.

Three rules make it work:

- **All groups read the same control plane.** Clock/phase, audio taps
  (`audio.<tap>.*`), palette, params — every group subscribes to the same
  signals. **Coherence *between* groups comes from shared inputs**, not a shared
  scene: the raster, the lasers, and the strips pulse on the same
  `audio.main.bass` and clock phase, so they read as related without being the
  same image.
- **Within a group, coordination is `f(shared control, member position)`.** A
  wave across 4 strips is a function of the shared phase and *which* strip you
  are. So each member can compute **its own slice locally** — *strip 3 of 4 at
  room-position P* derives its part from the shared clock with **no pixels
  shipped**. This is the render-plane form of the *media-local, control-federates*
  principle (and the visual mirror of the edge audio tap).
- **Cross-group geometric coherence is opt-in.** When a group genuinely must
  match another's *geometry* (a laser tracing the on-screen silhouette), it
  consumes the optional **abstract scene/field** (below). Most groups never need
  this — shared control is enough.

**Honest boundary:** local `f(phase, position)` rendering covers *procedural*
choreographies (waves, sequences, fields) — most of what LEDs and lasers want.
It cannot reproduce *arbitrary raster content* from position alone (you can't
compute "frame 200 of a video" locally). Mirroring exact raster across nodes is
the **pixel-streaming fallback** (see *Resolved decisions → #6*); the group model
makes the cheap local path the common case and the expensive stream the
exception.

### The optional abstract scene/field

For the opt-in cross-group case, a scene may publish a small **medium-independent
description** — positioned shapes/strokes, palette, an energy field — that
coherence-needing groups derive from (a laser traces an edge; a mapped-LED group
samples the field). Raster-only effects (dither, grain, slice tears) stay
**screen-local** and are simply not part of this description. So the abstract
layer is a *coherence aid*, not the totality of what any group draws.

### Chromium visualizer: host + plugins (layered)

The browser visualizer is a **scene source fused with a screen emitter**.
Target structure splits today's monolithic `static/index.html` into:

- **Host** — the render-plane orchestrator for the browser emitter: owns the
  canvas/compositor, audio analysis (`bands()` → bass/mid/treble/level +
  envelope followers) *as the default in-host tap* (see *Audio analysis: one tap
  per thing you listen to* — it can move to an external sidecar), the **bus**
  subscription, the
  **clock**, the UI panel, and timeline/automation playback. Exposes a
  render-context + signal API to plugins.
- **Plugin (scene)** — a visualizer implementing `init / resize /
  frame(ctx, signals)`. The current Pain Material render pipeline (lattice,
  slice tears, flyout silhouettes, freeze/shuffle, dither/grain/scanlines)
  becomes **scene #1** — the choreography of the *raster group*. Its rich raster
  effects stay screen-local; it may *optionally* also publish the abstract
  scene/field for other groups to derive from (see *The unit is the emitter
  group*).
- **Config-driven engine** — itself one scene plugin, but *data-driven*: it
  takes scenes/palette/SVG silhouette/lane automation as config so simple
  projects ship as data, not code. Bespoke pieces write a code plugin instead.

Large refactor of a ~7k-line IIFE; the **doc defines the boundary now**, the
code migration is backlog. Until then, `README.md`'s "High-level architecture"
section documents the reference visualizer (= host + scene #1 fused).

### Emitters

Each emitter is a render-plane sink, a **member of a group**, that declares a
**sync tier** (see *Clock → Sync tiers*):

- **Chromium canvas / single projector** — the screen emitter above. Tier-A/B.
- **Addressable LED arrays** — a renderer (Pi/ESP32) driving a strip/panel as a
  group member: it computes its slice from shared control + its position, or (the
  exception) maps a downscaled scene region. Arbitrary counts/layouts. Tier-B.
- **Laser / ILDA emitters** — a galvo emitter driven by a **vector-path
  choreography** (a firing sequence, or tracing an edge from the abstract field).
  A different idiom than rasterized media. Tier-B/C.
- **Multi-projector walls** — multiple projectors over one surface: a
  render-plane **router + compositor** doing edge-blended tiling (overlap, warp,
  per-projector color match) plus **genlock** (Tier-C). Effectively impossible on
  a single Pi — needs a multi-output GPU + genlock hardware, or a **cluster of
  render nodes** each fed clock + the abstract scene over the bus, rendering its
  own tile. A direction, not a near-term target.

### Distributed render nodes (the mirror of the sensor mesh)

Emitters need not be wired to a central controller. **ESP32 render nodes are the
render-plane mirror of the ESP32 sensor network** (`ESP32_SENSOR_NETWORK.md`) —
the same wireless mesh, with the **control plane flowing *outward* to emitters**
instead of signals flowing in from sensors. LED strips can sit all over a room,
each an ESP32 that receives shared control (clock/phase, audio taps, palette,
group params) and **renders its member's output locally** from that plus its
position — no pixel streaming, no home-run wiring.

This reuses the **capability-enumeration** layer (see *Modules announce what they
offer*): a render node announces its **type, geometry, position, and group
membership** ("RGB strip, length 60, room-position P, member of group `wave`")
exactly as a sensor node announces `node_id`. One enumeration layer, both planes.

## The audio plane (signal path)

The `daisy/` workspace provides the synthesis/sampling/sequencing side as a
coprocessor world (see `daisy/` docs and the Daisy memories):

- **Synthesis** — FM, wavetable, and voice engines (`dsp` core, shared by the
  Mac `host` and the embedded `firmware`).
- **Sample playback** — SD-backed sample streaming on the Daisy.
- **Sequencer** — the host `Sequencer` emitting sample-accurate `StepEvent`s.

In control-plane terms these are **sources** (the sequencer/generator publishes
`seq.*`; analysis publishes `audio.*`) and **sinks** (synth/FX params subscribe
to routed signals). But the Daisy is also where most of the **audio plane**
lives today — and the platform treats every part of it as swappable.

### Audio sources: synth, live input, or neither (Daisy swappable)

The audio origin is an abstraction with several realizations, chosen per
project:

- **Synthesized on the Daisy** — FM/wavetable/voice + samples (today).
- **Live input via the Daisy ADC** — instruments/mics for **working with live
  musicians**; the same `audio.*` analysis that drives visuals off playback now
  drives them off the performers, with no special-casing.
- **A blend** — live input processed alongside synthesized material.
- **Off the Daisy entirely** — audio originates on the Pi or an external
  interface/DAW, with the Daisy doing FX-only or dropped from the path.

**Multi-channel I/O** (`daisy/MULTICHANNEL_IO.md` — AK5558/AK4458 TDM, 4× stereo
in / out) is the physical substrate that makes the multi-musician /
multi-speaker case real: per-musician input channels, per-source processing,
multi-speaker output. It does **not** change the model — it widens the audio
plane.

### Audio-plane routing: software or hardware

Routing/mixing streams between audio nodes is an **audio router** role with two
realizations, both driven uniformly from the control plane:

- **In software** — a DSP mix/route matrix on the Daisy or Pi.
- **In hardware** — the **analog FX rack** (`ANALOG_FX_RACK.md`): a modular
  backplane of discrete analog FX blocks behind an analog **crosspoint**
  (`MT8816`/relays) with per-block params via digipots/VCAs. Here the
  **crosspoint selection and every block param are control-plane sinks** — a
  sensor, LFO, clock, or UI fader routed to an FX param or a routing change is
  exactly the same kind of edge as a sensor→visualizer mapping. The rack is an
  audio-plane subsystem; the *control* of it is bus-native.

  Architecture intent worth confirming: the backplane's **central crosspoint**
  design means the rack is best treated as a **shared audio-plane resource** any
  source (Daisy synth, live input, Pi) can route through — not a fixed insert in
  the Daisy's chain. (See *Resolved decisions → #4*.)

### Two clock domains

Live audio surfaces a distinction the playback-only system could blur:

- **Sample clock** — the converter word clock (the AKM parts share one MCLK/
  BCLK/FS; the STM32 is master). This locks the *audio plane* sample-for-sample
  and is unrelated to musical tempo.
- **Musical clock** — `clock.*` on the control plane (tempo / beat / phase).

With live musicians these can pull apart: either the players follow the master
musical clock (a click/cue derived from `clock.*`), or the system follows the
players (tap/beat-detection becomes a `clock.*` *driver*). Which way the arrow
points is a per-project clock-driver choice. (See *Resolved decisions → #3*.)

### Transports out of the audio engine

The current link to the browser is the SSE bridge for control signals + USB
audio for the stream; the OSC/MIDI transports generalize the **control** side so
external gear or a second machine can join. How **audio** moves *between
devices* when the source/FX/synth are split across boxes (analog patch vs. USB
audio vs. TDM/ADAT). (See *Resolved decisions → #2*.)

### Audio analysis: one tap per thing you listen to

`audio.*` is not one global stream. **Analysis is a *tap*** — a node that sits at
a specific point on the audio plane (an audio-plane **sink**, consuming a
stream) and **emits onto the control plane** (a control-plane **source**). A tap
is the bridge between the two planes. Each tap is an **instance**, so it
publishes a namespaced group `audio.<tap>.{bass,mid,treble,level,onset,…}`.

**"How many `audio.*` sources" = "how many taps you place."** You can tap
anywhere on the audio graph: the full mixdown, one output channel, a stem / voice
bus, a pre-mix FX send, or a standalone mic input. This answers both cases:

- **Multi-channel, per-channel processing** — N channels (stems/tracks of one
  piece, or separate sources — the split is project-defined, deliberately
  flexible) each get a tap: `audio.ch1.bass … audio.chN.bass`. The router maps
  each to different visual targets, so e.g. a bass stem and a hat stem drive
  different behaviors (cf. the [`EXHIBIT.md`](EXHIBIT.md) position-aware idea).
  Tap pre- or post-mix — wherever the node is.
- **Mic as a control-only sensor** — a tap on a mic **input** that is **not
  routed to any output sink** (never heard) still publishes `audio.mic.*` (or
  reduced semantic fields like `audio.mic.onset` / a `present` flag). It drives
  visual/audio params and nothing else. Crucially, **"heard vs. not heard" is an
  audio-plane *routing* property** (does this source reach an output?), **not a
  naming one** — the mic is "a sensor" because of how it's wired, not because it
  lives in a different namespace. (This is the concrete form of the mic from
  *Are sensors "just control-plane sources"?*.)

A separate, **orthogonal** axis is *where each tap runs*:

- **In-host** — the browser `AnalyserNode` + `bands()`, as today. Simple, but
  tied to Chromium's audio stack.
- **External sidecar** — a native **Rust `dasp` process** doing FFT/envelope/
  transient analysis, publishing over a transport (SSE/WebSocket), decoupled
  from Chromium and pairing with the WebUSB capture path. (Backlog: *Rust `dasp`
  DSP/analysis sidecar*.)
- **At the edge, co-located with the source** — the analysis runs **on the
  device the audio originates on** (e.g. an **ESP32** with a mic), and **only the
  derived control-plane signals leave the node** — `audio.door.level`,
  `audio.door.onset` — never the audio itself. This is the **preferred topology
  for distributed audio sensing** (see below) and is just the *Sources can be
  smart* principle applied to an audio tap.

A given tap publishes the **same `audio.<tap>.*` names** wherever it runs, so a
sink doesn't know or care — the interchangeability is the point of the bus.

#### Why the edge tap matters: don't ship audio, ship signals

Two costs blow up with many audio instances: **transport bandwidth** (raw audio
is orders of magnitude heavier than control packets — fatal over ESP-NOW) and
**central CPU** (N FFTs on the Pi). Pushing the tap to the edge cuts both: each
node spends its own cycles producing a handful of derived fields, and the wire
carries tiny `audio.<tap>.*` packets — the same cheap payloads as any
`sensor.*` reading. So **yes, an ESP32 doing local DSP and emitting derived
control signals is directly supported** — it's a tap whose *run-location* is the
edge node.

Two practical notes:

- **Edge DSP is capability-bounded.** An ESP32-C3/S3 can do envelope/RMS
  level, a few biquad band energies, and onset/transient detection cheaply; a
  large per-node FFT is possible (ESP-DSP) but is the expensive end. A node
  publishes whatever derived fields it can afford — the bus accepts a coarse tap
  (`level`, `onset`) and a rich tap (`bass/mid/treble/…`) identically.
- **Compute only what's subscribed.** Because routing + capability enumeration
  reveal which fields a project actually consumes, a tap can produce *only*
  those (skip the FFT if only `level` is routed). This is the other lever
  against the "many FFTs are expensive" problem, independent of where the tap
  runs.

This generalizes to a principle: **the media planes (audio, render) tend to stay
local or short-haul** — audio is heavy and latency-critical — **while the
control plane is the low-bandwidth fabric that federates across devices.** An
edge node can hold an entire little audio plane (mic → local DSP) wholly on the
node, and only its control-plane output crosses the network.

### Symbolic and analysis sources are both routable

A **sequencer or generator** publishes a **symbolic `seq.*` event stream** (the
host `StepEvent` — kick velocity, hats, resolved chord + `stabtone`, bass gate),
sample-accurate and *richer than MIDI*. Derived **`audio.*`** analysis
(FFT/envelopes) is a separate source. **Both are first-class, routable sources
— the host hardcodes no preference between them.** Which one drives a given
sink (or whether they blend) is a **routing decision expressed in the project's
DSL/UI**:

- route a sink purely from `seq.*` (tight, symbolic), or purely from `audio.*`
  (works for non-sequenced material — the ambient bed, the four distant songs);
- **blend** them (e.g. `audio.bass` for continuous amplitude + `seq.kick` for
  discrete triggers); or
- **select with fallback** — "use `seq.*` when a generator is active, else
  `audio.*`" — as an *explicit routing pattern*, not a baked-in rule.

So the routing DSL needs **source select / blend / availability** primitives,
not just per-edge curves (see *Router* above). The producer behind `seq.*` is
itself an abstraction — today's `Sequencer` is one implementation, an
algorithmic generator another — feeding audio and visuals identically.
(Backlog: *Symbolic event stream*.)

## Distributed sources & capability discovery

### Are sensors "just control-plane sources"?

Mostly — but not by virtue of being *sensors*. The dividing line is
**bandwidth/semantics, not the word "sensor."** The architecture already proves
this: a **microphone is a sensor, but live mic input sits on the *audio plane***
(an audio-plane source), not the control plane — it only becomes a control
signal once analysis reduces it to `audio.*`.

So sensors split by data rate:

- **Low-rate transducers** — distance (VL53L1X), motion (AM312), touch
  (MPR121), humidity. These **are control-plane sources**: they emit a small
  named value directly.
- **High-rate transducers** — mic, **camera**, depth cam. These are **input
  media streams**, not control-plane sources. They reach the control plane only
  through an **analysis/reduction** stage: a mic → `audio.*` via FFT/envelope
  analysis (audio plane); a camera → `sensor.*` (presence / pose / position) via
  computer vision. This is the **input-side mirror** of the `audio.*` analysis
  tap — the same "media stream, analyzed down to control signals" pattern,
  pointed inward. (A camera entering as `sensor.*` is why the render plane stays
  terminal — the feedback is a *new input source*, not render feeding back.)

### Even a low-rate source is a chain, not a point

A `sensor.*` source is really **transduce → condition → publish**: calibration,
smoothing, debounce, thresholding, and cross-sensor **fusion** sit between the
raw reading and the clean, typed, range-declared signal the bus carries. The raw
ADC count and the published signal are different points in that chain.

### Sources can be remote and smart

*Where* that chain runs is a deployment choice, not an architecture one. The
**ESP32 sensor network** (`ESP32_SENSOR_NETWORK.md`) is a mesh of ESP-NOW
satellites → an aggregator ESP32 → the Pi over USB-CDC, every payload tagged
`node_id` + `seq`. In the model it's just **distributed `sensor.*` sources over
a multi-hop transport** — everything downstream of `POST /ingest` is unchanged.

- **Sources can be remote**, across a room, not wired to one perfboard.
- **Sources can be smart** — the condition/fusion step can run at the satellite,
  the aggregator, or the Pi. A source isn't a dumb wire.

### Modules announce what they offer (enumeration)

For a *reusable* framework, the set of available signals and params can't be a
hardcoded list — it depends on what's plugged in. The analog FX rack already
points the way: each card carries a small **EEPROM with its type + param-map**
so the controller **auto-enumerates the rack on boot**. Generalize that: a
module should **announce the sources it publishes and the sinks it exposes**, so
the router/UI **discovers** the routable namespace rather than assuming it. The
ESP32 `node_id` tagging and the FX-card EEPROM are two concrete instances of the
same idea — a capability/enumeration layer the bus can build a routing UI from.

## Resolved decisions (was: open questions)

These fell out of the live-musician / multi-device / multi-emitter cases and are
now **decided** (working decisions — revisit if an install contradicts them).
The throughline: most collapse onto two prior decisions — the analog rack's
**central crosspoint** and the **"media planes stay local, control plane
federates"** principle.

1. **Audio-plane hub** — **a declared per-project role, with *no* presumed
   defaults.** Every project states explicitly which node owns the central audio
   router/mix (Daisy, a host + interface, etc.); the architecture binds nothing
   implicitly. The hub owns the **master-mix tap**, but per-channel / edge taps
   live wherever they run (taps aren't bound to the hub).
2. **Inter-device audio transport** — **minimize cross-box audio** (the
   *media-local* principle). Get channel count on-board via **TDM** (chip-to-
   chip). Cross a box boundary only when a processor in another box must touch
   the signal — then **analog line** or **class-compliant USB**, **ADAT** only
   for 8ch box-to-box. Network audio (Dante/AES67) out of scope. Because analysis
   can be edge-side, you rarely ship audio *for analysis* at all.
3. **Clock direction** — a **clock-driver selection, per timeline section.**
   Default for the ambient bed: **no beat clock at all** (`clock.*` carries
   section/phase, not beat — the bed is an 18-min piece with no single tempo, see
   [`EXHIBIT.md`](EXHIBIT.md)). Internal clock for sequenced sections;
   beat-detect-follow or click for live-band sections. Caveat: beat-detect-follow
   has inherent latency (fine for slow material).
4. **Analog FX rack scope** — **a shared audio-plane resource.** The backplane's
   **central crosspoint** (`ANALOG_FX_RACK.md`) makes routing software-arbitrary
   regardless of which cards are present. Any source routed to the hub can be
   sent through it; the controller drives the crosspoint over SPI/I²C, the
   *audio* can originate anywhere. Only bound: the audio must physically
   **reach** the rack's inputs (ties to #2).
5. **Scene ↔ multiple media** — **the emitter group (ensemble) is the unit.**
   Not one global scene, not isolated devices. A project runs several **groups**
   (the raster, a laser array, LED strips), each with a medium-native
   **choreography** over **members** that carry a **position/index**. All groups
   read the **same control plane** (coherence between groups = shared inputs);
   within a group, coordination is **`f(shared control, member position)`**, so
   members render their slice **locally**. An **optional abstract scene/field**
   provides opt-in cross-group geometric coherence (a laser tracing the raster);
   rich raster effects stay screen-local. (See *The render plane → The unit is
   the emitter group*. Supersedes the earlier tier-1/tier-2 framing — groups
   subsume it.)
6. **Render-plane distribution** — **control-plane distribution + render-local,
   via distributed (ESP32) render nodes** — the mirror of the sensor mesh. Each
   node receives shared control + its group membership/position and renders
   locally; **no pixels shipped**. Reserve **framebuffer/pixel streaming** for the
   one case `f(phase, position)` can't express — mirroring exact raster across
   nodes (e.g. tiling the existing visualizer across a projector wall), which
   then needs real bandwidth + genlock. A multi-projector cluster is N render
   nodes each fed clock + the abstract scene.

### Still genuinely open

- **Router surface** — direction set and **node set/schema drafted in
  [`ROUTER_IR.md`](ROUTER_IR.md) (`router.v1`)** (addressing + wildcards,
  select/blend/fallback, group definitions, per-node `rate_domain`); the plugin
  side is drafted in **[`PLUGIN_CONTRACT.md`](PLUGIN_CONTRACT.md) (`plugin.v1`)**.
  The data model is now complete (`common`/`bus`/`manifest`/`router`/`plugin` —
  shared vocab extracted to [`COMMON_PROTO.md`](COMMON_PROTO.md)); next is
  implementation (compiler, registry). See `BACKLOG.md` *Router as a typed graph
  IR*.
- **Abstract scene/field schema** — the concrete primitives of the optional
  cross-group description (shapes/strokes/palette/energy-field) are undefined;
  only needed when the first coherence-requiring group (laser-tracing-raster) is
  built.

## Runtime contracts (the operational layer)

The sections above define the **structure** (planes, taps, groups, routing). This
section defines the **boring operational contracts** that decide whether an
install survives a real night — time, failure, authority, identity, lifecycle,
observability. They were under-specified; an external architecture review
(another model, cross-checked against TouchDesigner, OSC/OSCQuery,
DMX/sACN/Art-Net/RDM, MIDI 2.0-CI, Max/MSP, Houdini, Ableton Link, SPIFFE)
surfaced them, and they're folded in here.

Reframed thesis: the bus does not carry "named typed signals." It **routes
versioned, timestamped, capability-described state and event streams across
explicit rate and clock domains.**

**Staging doctrine — parameters present, enforcement staged.** Every contract
below ships its **fields in the schema and wire format from day one**; the
**checking/enforcement is a no-op pass-through** until an install needs it.
Turning a contract "on" later is a **config flip, not a schema migration** — no
field is added retroactively. Concretely:

- **Identity** — packets carry `source_id` (SPIFFE-style URI), `cert_fingerprint`,
  `sig`, `seq` from the start; the verifier **trusts the claimed identity** and
  skips the crypto (dummy/empty sigs) until enforcement is enabled.
- **Time** — packets carry a full `TimePoint` (domain + value); cross-domain
  conversion can be a no-op until distributed sync matters.
- **Authority** — every writer carries `priority` / `authority`; the resolver may
  start as last-writer-wins before full arbitration lands.
- **Router IR** — nodes carry `rate_domain`; the executor may ignore it initially.

This avoids the trap where "stage it" means *omit the field and bolt it on
later* — which forces a migration exactly when you're hardening a live install.
The architecture serves the artistic outcome — slow/atmospheric or
zero-latency reactive, per piece — not the reverse (see `ROUTER_IR.md` →
*Resampling & reactivity*: latency is a per-mapping choice).

The staging state itself is **runtime-visible, never ambient**:
`ProjectPolicy.runtime_modes` (`manifest.v1`) declares each contract's
`OFF | WARN | ENFORCE` mode and the inspector banners any show running
permissive — the false-security failure mode of staging is packets that *look*
authenticated and prioritized while nothing checks them. One exception by
construction: **safety has no mode** — `SafeEnvelope` is enforced node-locally
from day one, unconditionally.

The banner is necessary but not sufficient: **every enforcement-off field must
carry an inspector-visible truth value, per field** — not one global "dev
mode." The inspector never renders "signed" when it means "signature present,
verification OFF"; never "priority 700" when it means "priority carried,
arbitration OFF"; never "on_stale: FAIL_SAFE" when the runtime is HOLD-only.
Display the declared contract *and* the enforced reality, side by side, or
bringup will be spent believing the former.

### Transport shapes & time

`continuous | event` is too coarse. A live system needs three shapes:

- **State** — latest value replaces previous (`sensor.door.distance_cm = 42`).
- **Event** — **append-only, ordered, must not be collapsed or dropped between
  frames** (`touch.pad2.onset`, a sequencer step). The classic bug class:
  missed touches, collapsed triggers, out-of-order application.
- **Bundle / scheduled** — atomic group with an intended execution **timetag**
  ("fire these 8 at beat 32.0"). OSC bundles + timetags are the prior art.

Every packet carries a **timestamp tagged with its timebase** — a `TimePoint`
that is one of `audio_sample | musical | monotonic | wall | render_frame`. These
are **not interchangeable**; if `clock.beat_phase` is "just the latest float,"
distributed nodes drift and disagree on *now* (extends *Clock → Two clock
domains*). Define this **before** the router IR gets elaborate.

→ **Concrete packet/envelope schema: [`BUS_PROTOCOL.md`](BUS_PROTOCOL.md)
(`bus.v1`)** — the `State`/`Event`/`Bundle` shapes, `TimePoint`, identity, and
priority fields, with the enforcement-off matrix.

### Failure contracts (stale / null / lifecycle)

- **Per-signal staleness** — every signal declares `stale_after_ms`,
  `on_stale: hold | null | default | decay | freeze_route | fail_safe`,
  optional `confidence`, and `last_seq` / `last_update_time`. Replaces the
  hand-waved "availability." Critical for ESP / edge / sensor nodes.
- **Module lifecycle FSM** — `discovered → configured → warming → active →
  degraded → stale → failed → removed`. Installs fail in boring ways (an ESP
  boots late, a tab reloads, an OSC app opens after the show, an LED node
  reconnects mid-scene); the supervisor needs these states to react.

### Authority & conflict resolution

Multiple writers will target one param (sensor, timeline, TouchOSC, generative
router, failsafe, **safety**). Select/blend/fallback handles *combination*;
this handles *who wins*. Steal **sACN's priority** model: a numeric authority
ladder (e.g. `safety:1000, manual_blackout:900, local_ui:700, timeline:500,
generative:400, sensor:300, default_idle:100`) plus **per-path publish/subscribe
permissions** by role. A safety/blackout override must always be able to seize a
sink. Without this, a sensor, a timeline, a fader, and a failsafe all fight for
the same param.

### Identity, capability, authorization (three layers)

`domain.instance.field` is a **routing address, not durable identity.** Split
into three:

- **Identity (who)** — a stable id, ideally a key/cert (SPIFFE-style
  `spiffe://pain-material.local/render/led-node-03`), distinct from the routing
  path. Survives renames and replacements.
- **Capability (what it claims)** — a signed manifest: `stable_id`,
  `instance_id`, `human_label`, `type`, `firmware_version`, `schema_version`,
  and per-signal `unit / rate / interpolation / stale / failsafe`. Capabilities
  are **claims, not permissions**.
- **Authorization (what policy allows)** — the project decides which paths a role
  may publish/subscribe; even a valid sensor cannot publish `clock.*` or
  `laser.master_enable`.

**Staged (parameters present, enforcement off):** the `source_id` /
`cert_fingerprint` / `sig` / `seq` fields exist on every manifest and packet from
day one, but the bus **trusts the claimed `source_id` and does not verify** —
dummy/empty sigs pass. When an install needs real security, enable verification
behind a **local project CA** (not Web PKI): mTLS at the richer edges, lighter
per-node HMAC + sequence numbers for constrained ESP-NOW nodes, an allowlist of
expected ids + a physical pairing mode. PKI that every ESP/tab/laptop must renew
is itself a footgun — turning it *on* is a config flip; the fields were already
there. Keep to the "minimum viable secure" ladder until the threat model demands
more.

**Edge auth: HMAC per packet + asymmetric at pairing (decided 2026-06-10).**
Constrained nodes (ESP) authenticate with **per-node HMAC + sequence numbers**,
*not* per-packet signatures. What HMAC-only gives up vs. X.509/SPIFFE: the
verifier (aggregator) holds every node's key (its compromise → fleet
impersonation); no non-repudiation; no clean revocation/rotation/expiry; an
opaque rather than cryptographically-named identity. Most of that is theoretical
for a single-operator, physically-enclosed install — and the loss is **bought
back by doing asymmetric *once at pairing*** (the node proves it holds a private
key, establishes a per-session HMAC key), the mTLS handshake/record split adapted
for constrained nodes. The `sig` field is `bytes`, so an HMAC tag and a signature
share the same slot — **mix per node, upgrade later, no schema change**; truncate
the HMAC tag to 8–16 B to save ESP-NOW frame bytes.

The choice is also a **performance** one, not just key-management: **HMAC is
effectively free** on these MCUs (ESP SHA hardware → single-digit µs; software
SHA-256 ≈10µs on the H7, **off the audio callback** in the comms task; the
ESP-NOW radio hop dominates by orders of magnitude). **Per-packet asymmetric is
not** — Ed25519/ECDSA verify is ~1–2M cycles (~1–4ms H7, ~6–10ms ESP) → too slow
at control rates, which is *why* per-packet work is HMAC and asymmetric is
confined to the handshake. (ESP-NOW's built-in AES-CCM link encryption is
available nearly free in hardware for the radio hop if defense-in-depth is
wanted.)

### Router as a typed graph IR (not a text DSL)

Resolves the "the router is becoming a mini-language" risk. Don't start with a
clever textual DSL; start with a **small typed graph IR** — nodes
(`input/curve/smooth/select/blend/output`) each declaring an explicit
**`rate_domain`**, compiled from the project manifest. Discipline:

- **no hidden state** in router expressions;
- **explicit delay nodes** for any cycle (no implicit feedback);
- **smoothing declares its rate domain** (a smooth at `render_frame` ≠ at
  `audio_sample`; TouchDesigner *Time Slicing* is the prior art for keeping
  control smooth under frame drops);
- **wildcards resolve at compile time by default** (`audio.*.bass`), with a
  `wildcard_policy` (`expansion: compile_time | dynamic`, `require_tag`,
  `exclude_tags: [debug, calibration]`, `on_new_match: ignore_until_reload`) so
  a new mic or a debug tap can't silently join the show;
- watch unbounded fanout, combine-order dependence, fallback thrashing, UI
  overrides fighting automation, and reload discontinuities.

Treat the manifest as a **compiled graph, not arbitrary script.** (Folds the
accumulated router requirements — instance/wildcard addressing, select/blend/
fallback, group definitions — into one disciplined IR.)

→ **Drafted: [`ROUTER_IR.md`](ROUTER_IR.md) (`router.v1`)** — the node set
(`Input/Curve/Scale/Smooth/Gate/Combine/Select/Delay/Output` + `Replicated` for
groups & wildcard fan-out, `PluginBinding` for generative logic), the compile/
validation rules, wildcard `match_against: EXPECTED`, and the resampling/
reactivity model (ZOH default, `ONE_EURO` for smooth-and-reactive).

### Observability (a core tool, not a debug extra)

A modular install needs introspection or it can't be patched live: a **signal
inspector** (what signals exist, who writes each, value / rate / staleness,
dropped packets, clock drift) and a **route inspector** (the compiled graph).
TouchDesigner's CHOP/operator viewers are a large part of *why* live patching
works there — build the equivalent as core, not an afterthought.

Diagnostics are **bus-native**, under the reserved **`_meta` domain** —
`_meta.<instance>.{rate_hz, last_writer, seq_gaps, queue_depth,
clock_offset_ms, …}` — so the inspector is *just a subscriber* (and a remote
inspector works for free over any transport). Two guards: `_meta` is excluded
from wildcard matching (`ROUTER_IR.md` → *Wildcard policy*), so diagnostics can
never be routed into a show by `*`; and `_meta` publishing is rate-limited, so
inspecting a packet storm doesn't amplify it.

One inspector duty deserves its own sentence: **safe-but-silent decisions must
render as decisions.** The wildcard and group policies deliberately ignore a
node that joins mid-show — correct, and indistinguishable from "broken" unless
the inspector says *why nothing happened*: "`audio.mic2.bass` discovered,
matches `audio.*.bass`, **ignored until reload** (COMPILE_TIME / EXPECTED)";
"expected `led07` missing: slot instantiated, sink stale"; "unexpected `led09`
discovered: outside group definition, ignored." Without those lines the safest
behaviors in the system read as bugs on install day.

Sequencing consequence: the **inspector is the second implementation
milestone** — after schema codegen, *before* the router compiler. Every
contract above (priority handoff, staleness, queue bounds, clock quality,
drops) reports into it; building it late means flying blind exactly while
those contracts are being proven. Its sibling is the **offline trace
simulator** — `manifests + policy + router graph + input trace → output
packet trace + inspector trace` — which turns priority handoff, stale
behavior, reloads, queue overflow, wildcard expansion, and rate-domain
crossings into deterministic golden-trace tests before any hardware is
involved.

### Group geometry contract

A group member's **position is not one number.** Define a `geometry` contract
early (even if simple): physical coords (m in room), logical coords (0–1 strip
position), topology (ring / line / grid / graph), orientation, calibration
transform, latency offset, color profile, brightness limit, safe operating
envelope. "A ring of strips is not a line"; a projector needs warp/color/blend
calibration; a laser needs scan limits + blanking. Extends *The render plane →
emitter group* (member position/index).

### Analog FX: transactional, safe route changes

Crosspoint switches and analog FX params are **not ordinary sink params** — they
pop, click, self-oscillate, overload, or feed back. Model a route change as a
**transactional operation** (`mute_output → ramp_down → switch_crosspoint →
ramp_up`) with **forbidden states** (`feedback_loop_without_limiter`,
`output_to_input_same_card`). Don't let an arbitrary sensor curve flip relays at
control rate — route changes are privileged (ties to *Authority*).

### Adapters confirmed (prior art, at the edges)

Keep these as **edge adapters**, not core reinventions: **OSCQuery** for
discovery export of the routable namespace; a **DMX/sACN/Art-Net adapter** for
LED/lighting-style emitters (reuse universes/fixture-modes/priority/failsafe
rather than homemade LED semantics); **Ableton Link** as a *clock-driver option*
for live/jam sections (peer tempo/phase, join/leave without disrupting the
session); the **Houdini HDA** model for plugins/choreographies as **versioned
assets** (`laser.edge_tracer.v1`) that expose a stable contract, not their
internal graph.

## Current state vs. target (honesty section)

| Concept | Today | Target |
|---|---|---|
| Signal bus | `window.AMBIENT_INPUTS` snapshot, sensor names only | Namespaced typed signals; sensors + clock + audio + sequencer all publish |
| Router | Hardcoded in `applyAutomation()` (e.g. distance→twist) | Declarative per-project config (the manifest) with reusable curve/scale primitives |
| Transport | Node SSE bridge (Pi→browser) | + OSC / MIDI bridges at every edge, same namespace |
| Clock | `bpm` lane in `.timeline.json` | Swappable driver (timeline / sequencer / MIDI / tap), publishes `clock.*` |
| Visualizer | One monolithic `index.html` (host + scene fused) | Thin host + swappable scene plugins; config-driven engine as one plugin |
| Projects | One hardcoded arrangement | Project manifest + selector; bridge/sidecar project-aware |
| Render plane | Chromium only (scene + screen emitter fused) | Scene source feeding many emitters — Chromium, LED arrays, laser, multi-projector — parametric or shared-scene |
| Audio plane | Single stereo, Daisy-originated (synth/playback) | Swappable audio source (synth / live ADC in / Pi / external); multi-channel I/O |
| Audio routing | Fixed in-DSP chain on the Daisy | Software *or* hardware (analog FX backplane crosspoint), driven from the control plane |
| Sensing | Wired two-board cluster on one Pi | + distributed ESP-NOW sources over a multi-hop transport |
| Capability set | Hardcoded signal/param list | Modules enumerate sources/sinks (FX-card EEPROM, ESP `node_id`); router/UI discovers them |
| Runtime contracts | Implicit (flat `AMBIENT_INPUTS`, no time/stale/authority/identity) | First-class: transport shapes + `TimePoint`, stale/failsafe, authority/priority, lifecycle, identity, router IR, observability — see *Runtime contracts* |

## Repository layout (engine vs. installation)

As the repo generalizes from Pain Material into the platform, project-specific
content separates from engine content — but stays **in one repo** for now.

**Decided (2026-06-10): a `projects/` directory in this repo; not submodules,
not multi-repo — yet.** The engine↔project boundary is still being designed, and
while that seam moves a **monorepo is correct**: you refactor across the line
freely with no cross-repo version dance. Submodules are a tax (detached HEADs,
double-commits, CI friction) with little payoff for a solo dev. Extraction will
move things back and forth across the boundary constantly (is the raster scene
engine-generic or Pain-Material-specific? the patches? the SVG parser?) — trivial
in one repo, painful across two.

```
/ (engine)            visualizer host, bus, router, scene-plugin API,
                      daisy/ workspace (crates dsp/host/firmware = engine)
/projects/
  pain-material/      the reference installation (see its README)
    manifest/         router graph, timeline/lanes, palettes, group defs, clock driver
    assets/           irocz.svg, audio, images
    scenes/           bespoke code plugin (today's raster pipeline = "scene #1")
    patches/          its Daisy patches (.pat, bell/stab/wavetable presets)
  _demo/              the bundled demo as a second, tiny project (later)
```

**Engine vs. project:** `daisy/crates/*`, the host, bus, and router are engine;
the arrangement, timeline, sensor→param mappings, palettes, the SVG artwork, the
bespoke scene plugin, and the specific patches are `projects/pain-material/`.

**When to split to multiple repos:** when a *second real installation* exists and
you want to pin it to a specific engine version — then engine-as-versioned-
dependency, projects downstream (never the engine as a submodule *of* a project).
Until that pain is concrete, one repo. (`project` here matches the existing
"multi-project manifest" language; it's the *installation* scope, distinct from
the authorization-policy "project".)

## Where to read next

- `README.md` — running the system; the reference visualizer's internals.
- `MIGRATION_PLAN.md` — **the implementation plan**: phased vertical slices
  onto these contracts, Pain Material kept live throughout.
- `EXHIBIT.md` — the Pain Material project (the reference instance).
- `SENSOR_MAPPING.md` — a concrete router instance (sensor → visualizer).
- `PARAMETERS.md` — the visualizer's sink-param registry.
- `BACKLOG.md` — the modularization epics (bus, manifest, OSC, plugin
  boundary, symbolic event stream, LED, projectors).
- `daisy/` — the audio engine; `daisy/MULTICHANNEL_IO.md` — multi-channel
  audio I/O (live-musician / multi-speaker substrate).
- `ANALOG_FX_RACK.md` — the hardware audio-router / FX-processor subsystem.
- `ESP32_SENSOR_NETWORK.md` — distributed wireless sensor sources.
- `COMMON_PROTO.md` — shared schema vocabulary (`common.v1`); imported by all four below.
- `BUS_PROTOCOL.md` — the concrete control-bus packet schema (`bus.v1`).
- `MANIFEST_PROTOCOL.md` — the capability manifest + project policy (`manifest.v1`).
- `ROUTER_IR.md` — the router as a compiled typed graph (`router.v1`).
- `PLUGIN_CONTRACT.md` — the versioned code-asset interface (`plugin.v1`).
