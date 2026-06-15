# Voice fitting — matching the formant synth to human recordings

**Status: feasibility + design only (2026-06-15). Not built.** A study of
whether the infinitedsp formant voice can be fitted to human recordings of
given phrases, what "match" can mean, how to record the targets, and how
to validate a recording before any fitting effort. Companion to
`AUDIO_ANALYSIS_SIDECAR.md` (the analysis muscle this would reuse).

## What "match" can — and can't — mean

The voice is a real **formant source-filter speech synth** (glottal/saw +
noise source → three band-pass formant filters F1/F2/F3), driven by a
**sequence of phonemes**, each a ~10-param block (`duration_ms, f1, f2, f3,
mix_voice, mix_noise, pitch_mod, amp` + discrete `jump_freq`/
`glitch_repeats`) with smoothed transitions. `SpeechSynth::set_phonemes`
already takes arbitrary sequences. (`daisy/vendor/infinitedsp-core/src/
synthesis/speech.rs`, `…/effects/filter/vowel.rs`, `daisy/crates/dsp/src/
pain_voice.rs`.)

Two structural facts bound the whole problem:

1. **The target is a phoneme SEQUENCE, not a static patch** — a
   time-structured estimate (per-phoneme params + durations), not a single
   timbre match. **"Given phrases" means the phoneme sequence is known a
   priori**, which collapses the hard part (segmentation discovery) into
   the easy part (parameter estimation of a known sequence). This is
   load-bearing for feasibility.
2. **Pitch is locked** (~110 Hz × `pitch_mod`, ±~10%, not continuously
   controllable). The synth fundamentally cannot match a human's pitch or
   prosody as built.

So the achievable target is **"an intelligible, robotic utterance carrying
the human's formant colors, voicing, and rhythm"** — not "sounds like the
human." Robotic is on-theme (the exhibit's surveillance/dissociation
voice), but it's a hard ceiling: matching prosody would require extending
the vendored synth's pitch model (possible — we own the vendor copy — but
a separate, larger project, out of scope here).

## Approach — three tiers (increasing cost)

This is **analysis-by-synthesis / "copy synthesis,"** a solved problem
class for this exact synth architecture (Klatt-era). The synth's knobs map
~1:1 to what a formant analyzer measures, which is what makes it tractable.

- **Tier 0 — formant analysis, no optimizer (highest ROI; start here).**
  Run a formant tracker (LPC / Praat-/pyworld-style) on the recording; it
  directly estimates F1/F2/F3 trajectories, voicing, and amplitude
  envelope. With the phoneme sequence known, forced-align to get
  boundaries, segment the tracked formants into phonemes, read per-segment
  values into `Phoneme` blocks. Deterministic, cheap, no search — likely
  ~80% of the achievable result. Listen before doing more.
- **Tier 1 — black-box fitness search (the literal "fitness training").**
  Seed from Tier 0, then CMA-ES / (1+1)-ES **per phoneme** to minimize the
  perceptual distance (below) to the target's aligned segment. After
  alignment each phoneme is a smooth ~10-dim problem — tractable, and
  offline rendering makes thousands of evals cheap. A *refiner on top of
  Tier 0*, not a from-scratch GA against a waveform (that naive version is
  expensive and lower-quality — avoid it).
- **Tier 2 — differentiable / learned (overkill; research escape hatch).**
  The Rust DSP is **not differentiable**. You'd reimplement the synth in
  JAX/PyTorch (a formant synth is differentiable in principle — DDSP does
  this) and gradient-descend a spectral loss, or train an encoder
  audio→phoneme-params. Best quality, large effort, must validate the port
  matches the Rust. Not warranted unless Tiers 0–1 disappoint.

## Fitness function

Raw waveform L2 is useless (pitch/phase/timing). Because the synth can't
match pitch, the loss must be **pitch-invariant and formant-emphasizing**:
**MFCC distance** (MFCCs discard pitch, capture the spectral envelope =
formants — exactly what the synth controls), or a mel-envelope distance,
**DTW-aligned** to absorb duration/timing mismatch. This reuses the
analysis muscle from the sidecar (FFT, mel/bands; the A/B lane's
lag-alignment is DTW-lite); MFCC + DTW is the main new piece, modest in
Rust.

## Recording the targets

These are **analysis targets, not a music vocal** — so anything that makes
a vocal sound nice (compression, EQ, de-essing, noise reduction, reverb)
corrupts the spectral envelope and dynamics being measured. **Capture flat
and clean; never process the master.** Process a copy if you want
something listenable.

**Format**
- **Uncompressed WAV/AIFF — never MP3/lossy.** Codec artifacts add
  broadband spectral noise that wrecks MFCC/formant analysis.
- **Mono, 24-bit, 48 kHz** — matches the engine (`SAMPLE_RATE = 48_000`),
  so no resampling in the comparison. Mono (single source, no stereo phase
  complications). 24-bit gives headroom to record conservatively.

**Levels & noise floor**
- **Peaks ~−12 dBFS, never above −6.** 24-bit means you never need hot
  levels; clipping destroys the spectrum irrecoverably. Conservative beats
  loud.
- **Floor ≥ ~50 dB below speech.** Broadband noise raises the spectral
  floor and confuses voicing-vs-noise detection (→ the synth's
  `mix_voice`/`mix_noise`). Quiet room, decent interface.
- **No compression on the way in.** It alters the amplitude envelope and
  smears transients — the dynamics the fit matches `amp` and phoneme
  onsets to. Capture the raw envelope.

**Mic & room (where formant accuracy is won)**
- **Cardioid condenser, ~15–25 cm, slightly off-axis, pop filter.** Not
  too close — proximity effect adds low-end that skews F1. Off-axis + pop
  filter protect plosives (/p/,/b/,/t/), the phonemes formant synths
  struggle with most.
- **Dead room, no reverb.** Reflections comb-filter the spectrum and smear
  formant transitions. Treated room / closet with clothes / soft-furnished
  space. Closed headphones to avoid bleed.
- **Don't de-ess** — the synth's noise channel models sibilants; keep the
  true sibilant energy (just not clipping).

**Performance (tailored to copy-synthesis)**
- **Clear, evenly-paced articulation; consistent mouth-to-mic distance**
  (mark a spot). The synth is monotone and matches formants + rhythm, so
  exaggerated prosody won't transfer and slurred/fast speech makes
  alignment harder; a steady near-monotone delivery also gives the formant
  tracker a cleaner periodic signal.
- **One phrase per file** (or clearly slated), a beat of silence around
  each, naming that maps to the known phoneme sequence.
- **Record a few seconds of room tone** (silence) to measure the real
  noise floor and calibrate "silence/voicing."
- **3–5 takes per phrase**, keep the cleanest; constant gain/distance
  across all phrases so the loss baseline is comparable phrase-to-phrase.

**Checklist:** quiet treated space → cardioid condenser ~20 cm, off-axis,
pop filter → 48 kHz / 24-bit / mono WAV → gain for ~−12 dBFS peaks, floor
≥50 dB down → **zero processing** → clear even delivery, one phrase per
file + room tone → confirm no clipping and inaudible floor.

## The payoff loop — validate the samples FIRST

Before any synth fitting is worth doing, **measure the gap** (the same
discipline as the analysis A/B lanes — know the baseline before chasing a
number). With the MFCC-DTW distance implemented, compute:

1. **human ↔ human** — the MFCC-DTW distance between **two different takes
   of the same phrase**. This is the **noise floor of the metric / the
   best a perfect fit could hope for**. If clean recordings of the *same
   words by the same person* score far apart, the capture (room, noise,
   level inconsistency) is the problem — fix recording before touching the
   synth.
2. **synth (current) ↔ human** — distance from the existing hardcoded
   phrase to the human take. The **starting gap** a fit has to close.
3. After a fit: **synth (fitted) ↔ human**, which should fall from (2)
   toward (1).

Read the numbers as: (1) is the floor, (2) is the start, (1)→(2) is the
headroom, and a fit is "good" when (3) approaches (1). If (2) is already
near (1), fitting isn't worth it; if (1) is large, the recordings need
work. This gate decides whether to proceed *and* validates the samples in
one measurement.

## Infrastructure: cheap vs. missing

**Cheap / reusable:** deterministic **offline render** is ~trivial to add
(`Engine::process()` / `Rig::render()` are buffer-agnostic and
deterministic — `heap_probe` is the template; pin 48 kHz to match the
recordings); the synth is **vendored** (instrumentable) and exposes
`set_phonemes`; the shared `dsp` crate runs on the Mac host so fitting is
host-side and only the resulting phonemes ship to the Daisy.

**Missing:** no FFT/MFCC/DTW/loss on the host yet (add `realfft` + MFCC +
DTW — modest; the sidecar is the pattern); no optimizer loop (CMA-ES is a
small crate; the PROCMUSIC (1+1)-ES is a different, sensor-reward shape);
`PainMaterialVoice::trigger_phrase` selects from a compile-time table by
index — expose a direct `set_phonemes` path on the host for fitting; no WAV
I/O (`hound`, trivial).

## Recommendation / staging (if greenlit)

1. Add offline render + MFCC-DTW loss + WAV I/O; run the **payoff loop**
   (human↔human, synth↔human) — that one number says whether to proceed
   and whether the recordings are good enough.
2. **Tier 0 copy-synthesis** (formant tracker → phonemes); listen. May be
   enough alone.
3. Only if it needs polish: **Tier 1 per-phoneme CMA-ES** seeded from
   Tier 0.
4. Tier 2 (differentiable) is a research escape hatch, not a plan.

## Open questions

- **Goal lock**: "intelligible robotic match of formants + rhythm"
  (feasible, in scope) vs. "resembles the human" (needs a synth pitch-model
  extension — separate project). Decide before building.
- **Phoneme sequence source**: hand-authored per phrase (as the 15
  hardcoded phrases are), or derived by forced alignment from the phrase
  text + recording.
- **Where fitting lives**: a host binary in `daisy/crates/host` (offline,
  Rust), consistent with the "fitting is host-side, phonemes ship" split.
