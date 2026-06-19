# Vendored `infinitedsp-core` — local patches

We vendor [`infinitedsp-core`](https://github.com/Na1w/infinitedsp) via the
workspace `[patch.crates-io]` in `daisy/Cargo.toml`. The vendored tree tracks
upstream **`main`** (currently commit `b4da941`, recorded in
`infinitedsp-core/.cargo_vcs_info.json`).

## Why vendored

Upstream `main` has **merged all of our per-sample performance work** behind the
`perf-approximations` cargo feature:

| Upstream PR | What it covers (was our patch) |
|-------------|--------------------------------|
| #44 | cache `1/sample_rate` in `Oscillator::tick` |
| #46 | Padé[3/2] `tan` prewarp in `StateVariableFilter` (feature-gated) |
| #47 | fast `log2`/`exp2` gain computer in `Compressor` (feature-gated) |
| #48 | parabolic fast-sine in `Oscillator` (feature-gated) |
| #42/#43/#45 | loop-invariant hoists in SVF / Compressor / `SpeechSynth::process` |

We enable `perf-approximations` for our build in `crates/dsp/Cargo.toml`, so the
oscillator/compressor/filter hot paths get the cheap approximations the Daisy's
Cortex-M7 (no hardware transcendental unit) needs — with **zero local diff**.

## The remaining local diff (3 files)

These are NOT in upstream and are re-applied on top of `main`:

1. **`src/synthesis/speech.rs`**
   - **Voice formant de-ess** — lowered noise drive + amp on the sibilant
     phonemes (S/Z/SH/CH/J) and a one-pole **noise low-pass** (`NOISE_LP_HZ`)
     that de-harshes all fricative/plosive bursts. *Artistic tuning of the Pain
     Material voice — deliberately not upstreamed.*
   - **Per-sample `Stutter::tick`** — replaces the block `Stutter::process`
     (4 `AudioParam` buffer-fills + resize checks per sample) the embedded voice
     drove one sample at a time. Depends on the `stutter.rs` patch below.

2. **`src/effects/time/stutter.rs`**
   - `Stutter::tick(...)` — per-sample entry point (see above).
   - `set_sample_rate` no longer `Vec::resize`s the ring. `Vec` doubles on grow,
     and that transient blew the AXI heap — which had forced an earlier 44.1 kHz
     pitch hack.

3. **`src/low_mem/effects/time/reverb_low_mem.rs`**
   - `Comb4LowMem` rewritten from `wide::f32x4` to plain scalar 4-lane. `wide`
     has **no hardware SIMD** on the Cortex-M7, so each `f32x4` op was 4 scalar
     ops plus lane pack/unpack overhead. Numerically equivalent (≤1 ULP in the
     reverb tail).

Candidates to upstream later (general, not Daisy-specific): the scalar low-mem
reverb and the per-sample `Stutter::tick`.

## Re-syncing to a newer upstream

The vendored tree is reproducible as a 3-way rebase:

```sh
git clone https://github.com/Na1w/infinitedsp.git && cd infinitedsp
# BASE = the commit recorded in .cargo_vcs_info.json of the *previous* vendor
git checkout -b fork <BASE_SHA>
# overlay the previous vendored src/ (the 3 patched files) and commit
git commit -am "our fork"
git rebase main            # superseded perf patches conflict -> take upstream
# resolve: keep only speech.rs voice tuning + Stutter::tick, stutter.rs, reverb
```

Then copy `src/`, `benches/`, `assets/`, `README.md`, `CHANGELOG.md`,
`Cargo.lock`, `LICENSE` into `vendor/infinitedsp-core/`, refresh
`.cargo_vcs_info.json` to the new `main` sha, and keep the **workspace-free**
`Cargo.toml` (the crates.io-normalized form + the `perf-approximations` feature;
upstream's dev `Cargo.toml` has a `[workspace]`/`[profile]` that conflicts with
our parent workspace).
