# orrery

**orrery** is a modular platform for A/V installations and performances —
synthesis, sampling, sequencing, sensing, and visuals bound together by a
configurable clock and one uniform way of routing signals between them.
(The repository still carries its original name, `ambient_viz`; the platform
and its schemas — `orrery.*.v1` — are named orrery.)

It grew out of — and still ships — a browser-based audio visualizer built for
the **Pain Material** installation (`EXHIBIT.md`): ambient/industrial/IDM
material, black-and-white CRT/glitch aesthetic. Pain Material is now the
**reference project** being migrated onto the platform contracts, piece by
piece, without ever taking the installation down (`MIGRATION_PLAN.md`).

**New here? → [Getting started](GETTING_STARTED.md)** *(under construction)*

## Design overview

### Three planes

One **control plane** parameterizes two **media planes** (`ARCHITECTURE.md` →
*Three planes*):

- **Control plane** — low-bandwidth named signals: sensors, clocks, UI,
  sequencer steps, analysis features. It decides *what the content does*.
- **Audio plane** — sample streams flowing through devices to speakers
  (Daisy Seed DSP, host synths, the analog FX rack).
- **Render plane** — frames / visual descriptions flowing to emitters: the
  Chromium visualizer today; addressable LEDs, laser/ILDA, multi-projector
  later. A *scene* is produced once and distributed to many emitters.

Sensors feed control; audio analysis taps the audio plane and publishes
features back onto control; the render plane is terminal — it consumes.

### The control bus (`bus.v1`)

Every control-plane value is a **signal** at a path `domain.instance.field`
(`sensor.door.distance_cm`, `clock.daisy.position`, `ui.browser.freeze`) with
one of two shapes: **STATE** (latest-replaces, retained, replayed to late
joiners) or **EVENT** (append-only, never coalesced, bounded queues where
every drop is counted — no silent loss). Packets carry a durable SPIFFE-style
source identity and a `(boot_epoch, seq)` ordering key that survives reboots;
**priority arbitration** picks one effective writer per STATE sink from an
operator-defined authority ladder (safety → manual → UI → timeline → sensors).
Diagnostics are bus-native under the reserved `_meta.*` domain, so the
**signal inspector** (`/inspector`) is just another subscriber: it renders
every path's resolved value *and* every pre-resolution writer candidate, plus
per-field enforcement truth values. Spec: `BUS_PROTOCOL.md`, `COMMON_PROTO.md`.

### Modularity

Modules declare what they are and what they publish in a **manifest** —
claims, not rights. The operator's **ProjectPolicy** decides what's permitted:
roles with publish globs, priority ceilings, an enrollment allowlist
(`MANIFEST_PROTOCOL.md`). Installation-specific content lives under
`projects/<name>/` (manifests, fixtures, scenes, patches); the engine stays
generic. Routing between signals and parameters is (phase 4+) a compiled,
typed graph (`ROUTER_IR.md`); generative behaviors become host-ticked,
deterministic **plugins** (`PLUGIN_CONTRACT.md`). Clock sources, audio
sources, and visual emitters are all swappable behind the same contracts.

### Security and safety

Enforcement is **staged, and staging is visible**: every check runs
OFF → WARN → ENFORCE per project (`runtime_modes` is live config), and the
inspector **banners any permissive mode** — staged enforcement must never
*look* enforced. Identity is present from day one (SPIFFE-style ids,
signature fields carried-but-unverified until enabled) so turning enforcement
on is a config change, not a refactor. Safety is the exception with no
permissive mode: a device's `SafeEnvelope` (brightness caps, laser scan
limits, flash-rate guards) is enforced node-local, last in the chain,
unconditionally — no packet at any priority can exceed it.

### Testability

The recorded session is the regression suite. A read-only **capture tap**
records every bridge boundary (raw + decoded, in arrival order); the **replay
harness** re-injects a capture into the unmodified system and a typed
comparator verdicts every output stream MATCH / EXPECTED_DIFFERENCE /
REGRESSION / UNKNOWN — where every tolerance is declared and an undiagnosed
difference blocks (`tools/replay/`). Migration follows **shadow → compare →
cut over → delete**: new implementations run alongside legacy at lower
priority, observably in the inspector, before any flip; every cutover has a
runtime rollback (flag/priority swap) and an artifact rollback (redeploy).
Golden captures live in `projects/pain-material/fixtures/`.

### Specs and plans

| Doc | What it is |
|---|---|
| `ARCHITECTURE.md` | The platform model: planes, roles, clock tiers, runtime contracts |
| `COMMON_PROTO.md` / `BUS_PROTOCOL.md` / `MANIFEST_PROTOCOL.md` / `ROUTER_IR.md` / `PLUGIN_CONTRACT.md` | The five `orrery.*.v1` schemas (spec docs; `proto/` is the executable IDL) |
| `MIGRATION_PLAN.md` | Phased strangler-fig migration of Pain Material onto the contracts (phases 0–3 landed) |
| `BACKLOG.md` | The permanent future-work backlog |
| `EXHIBIT.md` | Pain Material: the installation's design |

## Codebase overview

- `proto/` — the executable `orrery.*.v1` schemas (`common`, `bus`,
  `manifest`) + ts-proto codegen (`gen.sh`); generated CJS is committed under
  `server/src/gen/` so nothing needs a build step at runtime.
- `server/` — the Node bridge (pure stdlib + serialport): serves `static/`,
  ingests sensor events (`/ingest`), streams them to the browser (legacy SSE
  `/events` and bus-over-SSE `/bus/events`), owns the Daisy serial port, runs
  the in-process **bus** (`src/bus.js`), the **manifest registry + policy**
  (`src/registry.js`), the legacy→bus **adapter** (`src/bus-adapter.js`), and
  the phase-0 **capture tap** (`src/capture.js`). Tests: `npm test`.
- `static/` — everything served to the browser: `index.html` (the Pain
  Material visualizer — single file, no build), `inspector.html` (the signal
  inspector), `audio/` (sequencer + patch editors).
- `python/` — the sensor sidecar for the kiosk Pi (ToF distance, PIR motion,
  MPR121 touch, breath); every driver runs hardware-free with `--mock`.
- `daisy/` — the audio coprocessor: a Rust workspace with a `no_std` DSP core
  shared by a Mac host and the Daisy Seed firmware (synthesis, tape/freeze FX,
  SD sample streaming, USB/MIDI/CDC transport).
- `tools/replay/` — capture replay harness, comparator, feed A/B gate,
  fake-Daisy serial shim.
- `projects/pain-material/` — the reference project: `manifest/` (module
  manifests + ProjectPolicy), `fixtures/` (golden captures).
- `run_kiosk.sh` — launches bridge + sidecar together for the kiosk.
- Hardware/runbooks: `hardware-handoff.md`, `PI_KIOSK_BRINGUP.md`,
  `SENSOR_MAPPING.md`, `PI_PERFORMANCE.md`.

---

# Pain Material — the reference visualizer

The remainder of this README documents the reference visualizer itself —
the single-file app in `static/index.html` (its asset pipeline lives in
`tools/preprocess.js` / `tools/verify.js`; runtime tests in
`static/tests.html`).

## Two ways to run

**Standalone visualizer** — open `static/index.html` directly in a
browser. No server, no Python, no hardware. File loading is via the file
input or drag-drop; mic input is supported but doesn't play audio out
(avoids feedback).

**Kiosk mode** — three-process pipeline on a Raspberry Pi:

```
[Pi sensors] ──► [python/ sidecar] ── POST /ingest ──► [server/] ── /events ──► [Chromium]
   AM312 PIR        gpiozero          JSON {name,value}  Node SSE   EventSource    visualizer
   VL53L1X ToF      pigpio                                bridge     window.AMBIENT_INPUTS
   HR202+TLC555     CircuitPython
   MPR121
```

Convenience launcher: `./run_kiosk.sh` starts both the Node bridge
and the Python sidecar with interleaved `[node]`/`[py  ]` prefixed
logs. Hardware bringup is documented in `PI_KIOSK_BRINGUP.md`; the
sensor-to-visualizer wiring in `SENSOR_MAPPING.md`.

CPU budget on a Pi 4: visualizer takes 2–3 cores under load; Node bridge
< 0.1% of one core; Python sidecar 1–3%; `pigpiod` 1–3%. The kiosk
pipeline does not measurably affect the visualizer's frame budget — see
`PI_PERFORMANCE.md` for the levers that actually move the needle.

## High-level architecture

Single `<canvas>` filling the viewport, fixed at logical viewport pixels (`W`,
`H`) with `dpr` device-pixel scaling. All drawing happens in CSS-pixel space
via `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`.

Audio path: `MediaElementSource` (file) or `MediaStreamSource` (mic) →
`AnalyserNode` (fftSize 2048, smoothingTimeConstant 0.85) → `destination`
(file only, never mic).

Each frame:

1. **Audio analysis** — `bands()` averages FFT bins into `bass` (20–200 Hz),
   `mid` (200–2000 Hz), `treble` (2k–12k Hz), and overall `level`. Output is
   per-band 0..1.
2. **Envelopes** — derived signals updated each frame. See "Audio routing".
3. **Trigger logic** — slice tears, flashes, freeze, block shuffle gated by
   thresholds + cooldowns.
4. **Render branch** — either replay a frozen snapshot, or do the full
   render pipeline.
5. **Overlays** — scanlines, grain, dither, then optional invert/strobe flash.

## Audio routing (drives which effects)

| Source signal | Drives |
|---|---|
| `bassPulse` (peak follower over `pow(max(0, (bass - 0.5) * 2), 2)`, release `0.88`) | Lattice particle radius, lattice row corruption, flyout shape size + alpha throb |
| `bassRise` (per-frame `max(0, bass - prevBass)`) | Slice tear trigger (cooldown 3–9 frames), single-frame invert/strobe flash trigger, beat counter for slice angle rotation |
| `smoothMid` (`(mid - smoothMid) * 0.20`) | Flyout approach speed (×1 to ×6) |
| `midPulse` (deviation + derivative, release `0.91`) | Independent slice tear trigger stream (cooldown 4–11 frames) — does NOT count toward beat-rotation timer |
| `smoothTreble` (`(treble - smoothTreble) * 0.30`) | Per-particle jitter (max 26 px), grain density boost, dither phase advance rate |
| `smoothLevel` (`(level - smoothLevel) * 0.08`) | Trail-fade alpha (loud passages crisp up trails), drift breath, flyout overall energy gating |
| `levelRise` + `b.level - energyAvg` (energyAvg release `0.95`) | Onset detection → freeze (55%) and/or shuffle (55%), each rolled independently with a fallback so at least one fires |

Knee design notes:

- **Bass pulse uses a hard floor at 0.5** (`Math.max(0, (b.bass - 0.5) * 2)`) then
  squared. Anything below 0.5 contributes zero; only really thumping bass
  approaches max. The peak-follower release (`0.88`, half-life ~75 ms) gives
  each kick a clean spike-and-decay.
- **Discrete events use `bassRise` directly** (rising-edge derivative). This
  fires consistently on every kick regardless of baseline level — fixes the
  problem where slow baselines averaged-out repeated kicks at sustained
  passages.
- **Onset detection** combines fast baseline deviation AND rising edge
  (`max(level - energyAvg, levelRise * 1.8)`). The derivative carries
  repeated transients when the baseline catches up.

## Render layer order (per frame, after analysis)

If `freezeFrames > 0`: replay snapshot via `drawImage(freezeCanvas, 0, 0)`,
then jump straight to overlays. Otherwise:

1. **Trail fade** — translucent black `fillRect` over the whole canvas.
   Alpha = `0.06 + 0.05 * (1 - smoothLevel)` (longer trails when quiet).
2. **Flyout shapes** — 10 car silhouettes (`CAR_SUBPATHS`) projected from a
   center vanishing point. Each has world position `(wx ±2.5, wy ±1.8)` —
   wide enough to spawn distributed across the viewport rather than
   clustered at the center; off-center spawns fly outward and exit the
   frame faster. Depth `z`, approach speed `vz`, fill alpha, per-shape
   energy threshold `visThresh` (0–0.15), and a fixed `rotTarget`
   (random ±90°). Rotation lerps from 0 to `rotTarget` over the first 75%
   of size-progress (apparent-size from `Z_FAR` → `Z_NEAR`), then locks.
   Renders as `fill('evenodd')` + halo stroke + crisp stroke. Bass-throb
   scales size + boosts alpha.
3. **Sparks** — short-lived particle bursts spawned by bass/treble transients
   (legacy from earlier iterations; still active).
4. **Lattice** — full-viewport hex lattice of uniform particles at
   `LATTICE_SPACING` px spacing. Each particle's radius is `bassPulse`-driven
   (zero growth below b.bass=0.5, dramatic at peak). Per-particle x/y is
   jittered by treble. Each *row* is shifted horizontally by an amount
   driven by `bassPulse * rectW * ROW_CORRUPT_AMOUNT` (lattice corruption).
5. **Slice tears** — additive `drawImage`(canvas → canvas, `lighter`)
   ghost-doubled strips. Each slice carries an `angle`. The global
   `currentSliceAngle` advances 20–45° clockwise every 3–8 bass beats.
   Mid-band slices use the current angle but don't count toward the timer.
6. **Capture freeze / apply block shuffle** — pending events fire here on
   the rendered scene, before overlays.
7. **Scanlines** — `fillRect` per row at `SCANLINE_ALPHA` alpha black,
   every `SCANLINE_PERIOD` rows.
8. **Grain** — sparse-bright-pixel noise canvas (`GRAIN_RES` square,
   regenerated every frame), scaled up nearest-neighbor with `lighter`
   composite. Density rises with treble.
9. **Dither** — 8×8 Bayer ordered dither at CSS resolution (not device res
   for speed and chunkier pixels), nearest-neighbor scaled back to the main
   canvas. Pattern phase (`ditherPhaseX/Y`) drifts continuously, accelerated
   by treble.
10. **Flash** — single-frame `strobe` (full white) or `invert`
    (`globalCompositeOperation = 'difference'` + white fill). Fires on big
    bass `bassRise > FLASH_TRIGGER`.

## Tunables (location + meaning)

All in `index.html` near top of IIFE.

| Constant | Default | What |
|---|---|---|
| `LATTICE_SPACING` | 24 | px between hex-lattice particles. Smaller = denser. |
| `PARTICLE_BASE_R` | 1.0 | baseline particle radius (px) |
| `PARTICLE_PULSE_AMOUNT` | 12 | added to radius at full bass peak |
| `JITTER_PX` | 26 | max per-particle treble jitter (px) |
| `SCANLINE_ALPHA` | 0.42 | dark-row strength (0..1) |
| `SCANLINE_PERIOD` | 2 | every Nth CSS row darkened |
| `GRAIN_ALPHA` | 0.46 | grain overlay strength |
| `GRAIN_RES` | 320 | noise canvas size; lower = chunkier grain |
| `SLICE_TRIGGER` | 0.07 | `bassRise` threshold for tear bursts |
| `SLICE_BURST_MIN/MAX` | 5 / 12 | slices per burst |
| `ROW_CORRUPT_AMOUNT` | 2.6 | px of row shift per unit `bassPulse * rectW` |
| `MID_SLICE_TRIGGER` | 0.09 | `midPulse` threshold for mid-driven tears |
| `FLASH_TRIGGER` | 0.18 | `bassRise` threshold for invert/strobe flash |
| `ONSET_THRESHOLD` | 0.07 | combined level signal threshold for freeze/shuffle |
| `ONSET_COOLDOWN_MIN/MAX` | 12 / 35 | frames between onset events |
| `FREEZE_FRAMES_MIN/MAX` | 4 / 12 | base freeze duration; final = base × (2 or 4) |
| `FLYOUT_COUNT` | 10 | concurrent flying car shapes |
| `Z_FAR` / `Z_NEAR` | 2.0 / 0.04 | spawn / despawn depth |

In `spawnFlyout`:
- `s.wx / s.wy` range — `rand(-2.5, 2.5)` / `rand(-1.8, 1.8)` (world offset
  from the center vanishing point; widen for more edge spawns, narrow for
  center-clustered)
- `s.size` range — `rand(80, 280)` (longest-axis pixels at z=1)
- `s.rotTarget` — `rand(-π/2, π/2)` (final locked rotation; cap at ±90°)
- `s.fillAlpha` — `rand(0.16, 0.42)` per-shape fill density
- `s.visThresh` — `rand(0, 0.15)` per-shape energy threshold

The `0.75` constant in the render loop (`rotProgress = sizeProgress / 0.75`)
controls how early in the car's flight rotation completes — lower = snaps
to target sooner; 1.0 = rotation finishes only at despawn.

## Slice angle rotation

Global `currentSliceAngle` (radians) starts at 0 and accumulates clockwise.
Each bass-triggered slice burst increments `beatsAtOrientation`. When that
reaches `nextRotateBeats` (random 3–8 each cycle), the angle advances by a
random 20–45° and the counter resets. Mid-band slice triggers use the
current angle as-is but do not increment the beat counter.

Slices store their own angle at spawn time, so when the angle advances,
already-spawned slices keep their previous orientation while new ones use
the new angle — brief two-orientation overlap during transitions.

## Frame freeze

On energy onset (rolled independently from block shuffle), `pendingFreeze`
is set. After the lattice + tear pass, `captureFreeze()` copies the current
canvas into an offscreen `freezeCanvas` and sets `freezeFrames = base × (2 or 4)`
where `base` is `rand(FREEZE_FRAMES_MIN..MAX)`.

While `freezeFrames > 0`, the next render frames replace the entire main
draw with `drawImage(freezeCanvas, 0, 0)` (so content is paused) but the
overlay passes (scanlines, grain, dither, flash) keep animating on top.
This produces a "paused video with continuous noise" feel.

`drawImage` between canvases is GPU-fast — much faster than
`getImageData`/`putImageData`, which is why we use a backing canvas.

## Block shuffle

On energy onset (rolled independently from freeze), `pendingShuffle` is set.
`applyBlockShuffle()` divides the canvas into a random 5–10 × 3–7 tile grid
and `drawImage`s 4–9 random source tiles over random destination tiles,
overwriting their pixels in device-pixel space. Single-frame effect; trail
fade absorbs the displacement over the next several frames.

## 1-bit dither

`ditherCanvas` is a CSS-pixel-resolution offscreen canvas. Each frame:

1. Downsample main canvas → ditherCanvas with smoothing on.
2. Read ImageData, walk pixels, threshold red channel against
   `BAYER8[((y+offY)&7)*8 + ((x+offX)&7)] * 4 + 2`.
3. Result pixels are pure `0xFFFFFFFF` or `0xFF000000` (no greys).
4. Put back, `drawImage` to main canvas at full device resolution with
   `imageSmoothingEnabled = false` for chunky pixel-art appearance.

Pattern offset (`ditherPhaseX/Y`) drifts every frame by `(0.35 + treble*8)`
units, so the dither texture continuously slides — slow at rest, fast on
treble-heavy material.

This pass is the heaviest in the frame (~10–20ms on a 1600×900 viewport).
First optimization to try if frame rate sags: dither at half CSS resolution
(`Math.ceil(W/2)`, `Math.ceil(H/2)` in `resizeDither`).

## Silhouette pipeline (`tools/preprocess.js`)

1. Read `irocz.svg`, extract first `<path d>` and any parent
   `<g transform="translate(...)">`.
2. Tokenize the `d` string (commands + numbers).
3. Walk SVG path commands. `M/L/H/V/C/S` are absolute (translate applied);
   `m/l/h/v/c/s` are relative deltas (no translate). `S/s` use the
   reflected previous control point (`prevCtrlX/Y`). `Z/z` closes a subpath.
4. Cubic Béziers are recursively subdivided via de Casteljau until each
   segment's max perpendicular distance from the chord is ≤ `FLATTEN_TOL`
   (1.0 user-units = mm). Quadratic Béziers and elliptical arcs not
   implemented — would need to be added if a different SVG is used.
5. Subpaths are collected, normalized to a centered unit shape (longest
   axis spans [-0.5, 0.5]), and emitted as a flat `[x,y,x,y,...]` array per
   subpath.
6. Output (`silhouette.js`) declares `CAR_ASPECT` and `CAR_SUBPATHS`.

The data is **inlined** into `index.html` (not loaded at runtime) so the
HTML is fully self-contained.

To regenerate after changing the SVG: `node tools/preprocess.js`, then copy
`tools/silhouette.js`'s `CAR_ASPECT` and `CAR_SUBPATHS` into the
corresponding block in `static/index.html`.

To verify the parsed silhouette visually: `node tools/verify.js`, then open
`/tmp/verify.png`.

## UI

Bottom-of-viewport floating panel:

- **file** — file picker; loads audio, plays through `MediaElementSource`.
- **mic** — `getUserMedia` with no AGC/echo/noise suppression. Does NOT
  connect to destination (would feedback).
- **play / pause** — toggles the `<audio>` element. Disabled in mic mode.
- **timeline** — appears when a file is loaded. Click-anywhere-to-seek and
  drag-to-scrub via pointer events. Bonus keys: ←/→ ±5s, shift+←/→ ±15s,
  space toggles play/pause.

UI fades to 15% opacity after 2.5s of mouse idle; mouse motion brings it
back. Drop-zone overlay activates on drag-over the page.

## Performance notes

- Lattice particles are batched into a single `beginPath()` + `fill()` per
  frame (one path with many `arc()` subpaths).
- Slice tears use canvas-to-self `drawImage` with `lighter` composite.
  Browser handles the implicit copy.
- Dither is the bottleneck. ~1.4M pixel iterations per frame at typical
  viewport sizes.
- Frame freeze uses canvas-to-canvas `drawImage` (GPU-fast) rather than
  `putImageData` (slow).
- The dpr cap is 2 (`Math.min(window.devicePixelRatio || 1, 2)`); higher
  dpr would multiply pixel-iterating costs by 4× without much visual gain.

## Known design decisions worth preserving

- **Mic input never connects to destination** — would feedback through
  laptop speakers.
- **`bassPulse` peak-follower vs. derivative split** — peak follower for
  continuous amplitude effects (lattice pulse, throb, row corruption);
  derivative for discrete events (slices, flash). Both serve different
  purposes; don't merge them.
- **Slice angle counts only bass beats** — mid bursts use the current
  orientation but don't reset the timer. This locks the rotation rate to
  the kick rather than to fills/snares.
- **Independent freeze/shuffle rolls** (with fallback) — "both fire at
  once" frames feel more chaotic than alternating one-or-the-other. The
  fallback ensures any onset triggers something.
- **Scanlines drawn before grain, both before dither** — this lets the
  dither convert scanline-darkened rows into stippled patterns rather than
  preserving solid mid-grey rows.
- **Flash is the very last pass** — invert flips the dithered B&W result;
  strobe overrides everything. Putting it before dither would dilute the
  effect.
- **Silhouette data is inlined**, not fetched. Keeps `index.html`
  self-contained for no-server usage.
