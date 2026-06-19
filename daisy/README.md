# ambient-viz-daisy

The ambient visualizer's audio coprocessor — a Rust workspace whose `no_std`
DSP core runs identically on the **Daisy Seed firmware** and a **macOS host**
(so you iterate on the audio on the Mac in seconds, then flash the same code).

> **This file is the map of the audio code — keep it current.** When you add
> a voice, effect, host tool, CLI flag, preset kind, or CC mapping, add it
> here. It exists so the next person (or agent) doesn't re-discover the
> codebase by grepping. Deep topics have their own docs (linked inline);
> this is the index.

| Crate             | Type                        | What it is |
| ----------------- | --------------------------- | ---------- |
| `crates/dsp`      | `no_std` lib (`std` in test)| Audio + MIDI core: voices, effects, the generative music engine, the mix `Engine`, MIDI/patch types. Same code on both targets. |
| `crates/firmware` | embedded bin (thumbv7em)    | Daisy Seed firmware: embassy + SAI audio + USB UAC + UART-MIDI + SDMMC, driving `dsp::Engine`. |
| `crates/host`     | std bin (macOS)             | Dev host: CoreAudio (cpal) + CoreMIDI (midir) + `dsp`. Run/audition/tune the audio without reflashing. |

Real-time discipline everywhere in `dsp`: no allocation in the audio path
(buffers allocated once at construction), f32 math, no per-sample
transcendentals on the hot path (the Cortex-M7 has no HW transcendental
unit — see mem `daisy-dsp-realtime`). `Engine::process(&mut [f32])` is
block-size agnostic (~512 frames on cpal, ~48 on SAI).

---

## `crates/dsp` — the audio core (`src/`)

### Voices (sound generators)
| Module | Type | Key entry points |
| ------ | ---- | ---------------- |
| `fm_stab` | `FmStab` | 8-voice **polyphonic** FM stab. `note_on` / `note_on_gated` (gated = holds/sustains until `note_off`); `play_chord` / `play_chord_gated`; `tick() -> f32` (mono sum). `FmPatch` (serde) with `bell()` / `industrial()` / `default()`. |
| `wavetable` | `WtSynth` | **Polyphonic** wavetable voice, sustaining ADSR + per-note filter-envelope sweep. `note_on` / `play_chord` / `note_off_all`; `tick()`. `WtPatch` (serde) loads wavetables by id from `wavetable_bank`. |
| `bass` | `RumbleBass` | Sustaining mono rumble bass. `note_on`; `BassPatch`. |
| `pain_voice` | `PainMaterialVoice` | Formant speech (vendored infinitedsp `SpeechSynth`) + own reverb. `trigger_phrase(idx, vel)`; `set_phonemes`. `PHRASE_COUNT` / `PHRASE_LABELS`. See `../VOICE_FITTING.md`. |
| `analog_bass_drum`, `hihat` | — | Analog-modeled kick / hat (DaisySP-style). |

### Effects
| Module | Type | Notes |
| ------ | ---- | ----- |
| `tape` | `TapeProcessor` (+ `WowFlutter`, `Chew`) | Tape saturation/wow/flutter + a failure model. `TAPE_SIMULATION.md`, `PLAN_TAPE_FAILURE.md`. |
| `freeze` | `Freeze`, `GlitchTape` | Capture-a-grain-and-loop master freeze (parallel send). The degenerate case of the buffer-player family. |
| `transporter` | `Transporter` | **Reverse-grain pad**: grains start at `playhead − offset`, read backward into prior audio, summed into a smooth wash. Knobs: grain_ms/density/offset_ms/pitch/reverse/spread/level. `../TRANSPORTER.md`. |
| `buffer_player` | `CaptureBuffer`, `WindowTable`, `Grain` | **Shared substrate** for the buffer/grain effects (transporter, the planned granulizer, and freeze): an interleaved ring + interpolated reads + a precomputed window table. `../GRANULIZER.md`. |
| `bloom` | `Bloom` | Bloom/pad FX. |
| `limiter` | `Limiter` | Master limiter (not a brickwall — allows brief attack overshoot). |
| `svf` | — | State-variable filter (DaisySP port). |
| reverb / ping-pong delay | — | From the vendored `infinitedsp-core` (re-exported: `Reverb`, `PingPongDelay`, `AudioParam`, `FrameProcessor`). Vendor patches: `vendor/PATCHES.md`. |

### Generative music & the mix
| Module | What |
| ------ | ---- |
| `procgen/` | The generative composer: 19-gene `Genome`, `sequencer`, `conductor`, `markov`, `bassgen`. Deterministic (seed + genome → byte-identical events). See `../PROCMUSIC.md`. |
| `sequencer` | Step/stab sequencer (the stab lane + chord output). |
| `chord` | Text → MIDI notes: roman numerals, chord names, bracket stacks. `Chord`, `Key`. |
| `lib.rs` | **`Engine`** — the full firmware mix (internal `Sampler` + the voices + procgen + tape + reverb/delay + limiter). `process(&mut [f32])`, `apply_param(Param, f32)`, `handle_midi(MidiMessage)`, `midi_map()`. `timeline` parses the ambient-viz timeline sidecars (shared with the page). |

### MIDI & control
| Module | What |
| ------ | ---- |
| `midi` | `MidiMessage` enum + `decode(bytes) -> Option<MidiMessage>` (NoteOn/Off, **ControlChange { channel, cc, value }**, PitchBend). |
| `midi_map` | `Param` enum (~68 params across kick/stab/bass/reverb/tape/…) + the **CC → Param** map (`map_cc(cc, value)`). The control surface for the `Engine`. |

### Patches (serde, JSON)
`FmPatch` / `BassPatch` / `WtPatch` derive `Serialize + Deserialize + Clone`,
so they round-trip as JSON. The browser patch editors (`static/audio/`) author
them; saved presets live in **`static/audio/presets/{fm,bass,wt}/*.json`**
(names may contain spaces). On the host, `serde_json::from_slice`/`to_string`.

---

## `crates/host` — dev host & tooling

Two ways to make sound on the Mac: the full **`Engine`** (`main.rs`), and
hand-rolled **rigs** that sum a voice's sub-graph exactly the way the firmware
master bus does (NOT via `Engine`) — for auditioning one voice/effect in
isolation. Rigs live in `src/rigs.rs` (`Rig` trait: `trigger`, `render`,
`prime`, `handle_cc`).

### Binaries (`src/bin/`, + the default `main.rs`)
| Run | What |
| --- | ---- |
| `cargo run -p host` | `main.rs` — the full `Engine` with CoreAudio out + CoreMIDI in (CC → `Engine` via the midi_map). `MIDI_PORT=N` selects the input. |
| `cargo run -p host --bin sound_test -- MODE` | Audition one voice/effect (see below). |
| `cargo run -p host --bin patch_server` | HTTP bridge (127.0.0.1:8765) for the browser patch editors — live FM/bass/wt patch hot-swap (`PreviewRig`) so you hear real Rust DSP, not the JS sim. `POST /fm|bass|wt/patch`, `/trigger`, `/panic`. |
| `cargo run -p host --bin heap_probe` | Measure peak heap of the full firmware FX chain (proves it fits the ~448 KB AXI-SRAM heap). |

### `sound_test` — the audition tool
```
cargo run -p host --bin sound_test -- [bell|industrial|voice|transporter] [flags]
```
- **bell / industrial** — `BellRig`: FM bell/stab + ping-pong + limiter.
- **voice** — `VoiceRig`: formant speech, cycling all phrases.
- **transporter** — `TransporterRig`: a polyphonic **`WtSynth`** held chord
  (a slow **D Dorian** progression) run through `dsp::transporter` into a
  reverse-grain pad. Dry (primary playhead) + pad → limiter.
- Flags: `--every=N` (seconds between triggers/chord changes), `--wt=NAME`
  (load `presets/wt/NAME.json` — or a path — as the wavetable source),
  `--save-wt=NAME` (serialize the active `WtPatch` back to that dir).
- **Live MIDI CC tuning** (transporter): connect a controller; incoming CCs
  are echoed to the console (knob discovery) and CC **20–27** map to dry mix /
  pad level / grain / density / offset / pitch / spread / reverse
  (`TransporterRig::CC_HELP`). Saved finds become named presets on the rig
  (e.g. `preset_breathing_subwash`, the boot default).
- **CC LFOs** (`src/lfo.rs`, `CcLfo`) — general control-rate modulation of any
  effect CC: an LFO sweeps a CC's *value* (0..127, same units you dial)
  between two endpoints at a rate, ticked once per render block and fed back
  through `handle_cc` (so it inherits the CC→param scaling). A preset
  registers a `Vec<CcLfo>` (e.g. `preset_breathing_subwash` breathes grain +
  density on slow sines). Reusable by any rig.
- `src/mood.rs` — the mood-plane sweep (genome/FX blend over anchor points);
  `main.rs` can drive it. See `../PROCMUSIC.md` / mem `procmusic-design`.

---

## Build / flash / run

```bash
# Mac iteration — edit dsp/, hear it in ~3-5 s
cargo run -p host --release

# Flash to Daisy (debug probe) / DFU (no probe)
cargo flash                       # = -p firmware --target thumbv7em-none-eabihf --release
cargo bin                         # build the .bin; then hold BOOT, tap RESET, release BOOT:
dfu-util -a 0 -s 0x08000000:leave -D target/firmware.bin

# Tests (host) / no_std embedded build check
cargo test -p dsp
cargo build -p dsp --target thumbv7em-none-eabihf
```

Build aliases live in `.cargo/config.toml`, named
`<flash|bin>-<sdmmc|spi|qspi>-<uac|bulk>-<prod|rtt|debug>` (mem
`daisy-build-alias-scheme`); `default-members` excludes `firmware` so a bare
`cargo build`/`test` from the workspace skips the thumb target. Dev builds emit
diagnostics over USART3 (D2) behind the default `debug-uart` feature; `-prod`
images strip it. Full exhibit images run from QSPI flash (`*-qspi-*` aliases,
`BENCH_QSPI.md`, `PLAN_QSPI_BOOTLOADER.md`).

## Hardware target

Original **Daisy Seed Rev 7 / PCM3060** codec, 64 MB SDRAM, SD card on
**SDMMC** (`sd-sdmmc` is the default backend; `sd-spi` is legacy). For Seed
1.1/1.2 set the `daisy-embassy` feature in `crates/firmware/Cargo.toml`. (Mem
`daisy-seed-rev7`, `daisy-sd-backend-is-sdmmc`.) Big FX buffers (reverb, delay,
the buffer-player rings) live in SDRAM, not the AXI heap (mem
`daisy-fx-buffers-sdram`). USB: UAC iso source (`-uac`) or WebUSB vendor-bulk
capture (`-bulk`, `?usbaudio=1`) — `PLAN_USB_CAPTURE.md`,
`PLAN_USB_COMPOSITE.md`.

## Topic docs

`../PROCMUSIC.md` (generative music) · `../TRANSPORTER.md` /
`../GRANULIZER.md` (buffer-player effects) · `../VOICE_FITTING.md` (formant
voice) · `TAPE_SIMULATION.md` / `PLAN_TAPE_FAILURE.md` · `../OPTIMIZATIONS.md`
(Cortex-M7 perf) · `BENCH_QSPI.md` · `MULTICHANNEL_IO.md` ·
`BREAKOUT.md` · `vendor/PATCHES.md` (infinitedsp patches).
