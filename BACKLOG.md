# Backlog — future improvements

Canonical, version-controlled backlog for ambient_viz. Captured 2026-06-06 from a
design session + a sweep of all repo docs and notes. The live Claude Code task
list mirrors this but is session-scoped; **this file is the permanent home** —
update it here.

Each item links its source doc/memory. Dependencies noted inline. Completed
verification checklists from already-shipped work (USB composite Phases A–D, tape
failure live control, SAI audio path) are intentionally excluded.

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
- [ ] **Rust `dasp` DSP/analysis sidecar** — move FFT/envelope/transient analysis out
  of the browser into a native Rust process feeding the visualizer over the SSE/WebSocket
  bridge. Decouples from Chromium's audio stack; pairs with the WebUSB path. Start from
  the daisy `host` crate. — conversation 2026-06-06 (new)

## Firmware / DSP (Daisy)

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
  `0x90040000`) via the Daisy bootloader behind the `qspi` feature; `cargo flash-qspi` /
  `flash-qspi-debug` build+flash via dfu on a USB power-cycle. Lifts the 128 KB ceiling →
  full `bell+voice` (which no longer fits internal flash) runs at opt-s. Benchmarked:
  +26 % on `tape` (I-cache contention) but `SAI_ERR≈0` → real-time-viable. Internal flash
  is now PARED (`flash-prod-bell`/`flash-prod-voice`); the opt-z workaround still applies
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
  `usb_cdc.rs:16`. — `daisy/PLAN_USB_COMPOSITE.md` Phase E
- [ ] **Tempo Pi→Daisy (or onboard `bpm_at`)** for the dsp Sequencer — parked until the
  sequencer is instantiated; prefer onboard `bpm_at(own POS)` over a tempo CC. —
  mem `daisy-tempo-sequencer-future`
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
  the dasp sidecar). — conversation 2026-06-06 (new)
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
  distorted, ce577ea, 3 ramps/2 files) with one flag; share with the Phase E audio leg. —
  mem `distance-reverse-flag-future`
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
  **existing Node SSE bridge** (same path as sensor data). Teach the visualizer to
  prefer this symbolic feed over FFT audio-analysis when present, falling back to
  analysis for non-sequenced material (ambient bed / the 4 distant songs). Pairs with
  the `dasp` analysis sidecar item above. — conversation 2026-06-08 (new)
- [ ] **`StepEvent`-emitter as the generator abstraction** *(foundation for the next
  project: directorially-guided algorithmic ambient)* — define the serializable event
  as the contract and put today's `Sequencer` behind it as one implementation, so an
  algorithmic generator can be a second producer of the *same* stream. Both producers
  feed the audio engine **and** the visualizer identically; "directorial intent" =
  choosing/blending/swapping producers per timeline section (some lanes from `.pat`
  loops, others generated on the fly). The visualizer never knows which. —
  conversation 2026-06-08 (new), mem `exhibit-composition-structure`
- [ ] **MIDI output (parallel, optional, later)** — *only* if external gear/DAW enters
  the loop (hardware synth voicing the stabs, recording the generative output). The
  host already links `midir`; add a MIDI *out* alongside the JSON event stream — an
  IO/export concern, never a replacement for `.pat` or the visualizer feed. —
  conversation 2026-06-08 (new)

## Infra

- [ ] **Multi-project support** — generalize from the single hardcoded arrangement to a
  project manifest (audio, timeline/lanes, sensor mappings, palettes, localaudio source) +
  a selector; make the bridge + Python sidecar project-aware. — conversation 2026-06-06 (new)
