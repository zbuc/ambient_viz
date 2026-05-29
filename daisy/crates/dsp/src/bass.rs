//! Analog-style subtractive "rumble bass" — a monophonic voice for long,
//! low, LPF'd whole-note bass under the techno/industrial mix.
//!
//! Signal path (classic monosynth):
//! - a **stack of detuned saws** (band-limited, anti-aliased) for an analog,
//!   beating, slightly-drifting tone, plus a **sub sine** an octave below the
//!   saws for weight/rumble;
//! - a resonant **lowpass** ([`crate::svf::Svf`], the double-sampled DaisySP
//!   port — `.low()` output) with low cutoff and a touch of resonance for the
//!   analog growl, optionally swept by the envelope;
//! - a gate-driven **ADSR** with a real *held sustain* stage.
//!
//! **Duration is not in the envelope.** The amp envelope shapes *articulation*
//! (attack swell, release tail) only. How long a note lasts is governed by how
//! long the sequencer holds the gate open ([`note_on`]/[`note_off`]), and the
//! sequencer's gate is sample-locked to the BPM curve — so a "whole note"
//! stretches and compresses with tempo changes with zero drift. A held note
//! that crosses a loop boundary simply keeps its gate open (the sequencer does
//! not force a note-off at the wrap), so sustain is seamless across loops.
//!
//! Monophonic, last-note priority. Per-sample `tick()` matches the engine's
//! hot loop; no allocation after construction (embedded-safe — see the
//! performance note in `daisy/`).

use crate::fm_stab::midi_to_freq;
use crate::svf::Svf;
use infinitedsp_core::FrameProcessor;
use infinitedsp_core::core::audio_param::AudioParam;
use infinitedsp_core::synthesis::oscillator::{Oscillator, Waveform};

/// Number of detuned saws in the stack. 3 = center + sharp + flat: enough
/// analog thickness/beating without piling up per-sample cost.
pub const NUM_SAWS: usize = 3;
const INV_NSAWS: f32 = 1.0 / NUM_SAWS as f32;

/// Tunable timbre/shape for the [`RumbleBass`].
#[derive(Debug, Clone, Copy)]
pub struct BassPatch {
    /// Semitone offset applied to the incoming note so the bass sits below the
    /// stabs. Default -12 (one octave down) → a `prog` root at octave 3 plays
    /// at octave 2, with the sub sine another octave below.
    pub octave_offset: i32,
    /// Saw-stack detune spread, in cents (outer saws at ±this). ~5-20 typical.
    pub detune_cents: f32,
    /// Sub-sine level relative to the saw stack (0..1).
    pub sub_level: f32,
    /// Base lowpass cutoff, Hz.
    pub cutoff_hz: f32,
    /// Filter resonance, 0..1 (higher = more growl; self-oscillates near 1).
    pub resonance: f32,
    /// Envelope→cutoff amount, Hz added at full envelope (0 = static cutoff,
    /// so the filter is set once per note and never recomputed per sample).
    pub env_mod_hz: f32,
    /// Amp-envelope attack, seconds.
    pub attack_s: f32,
    /// Amp-envelope decay to the sustain level, seconds.
    pub decay_s: f32,
    /// Sustain level held while the gate is open, 0..1.
    pub sustain: f32,
    /// Release time after note-off, seconds.
    pub release_s: f32,
}

impl Default for BassPatch {
    /// A deep, slightly-detuned analog rumble: octave down, mild detune, fat
    /// sub, low resonant cutoff with a gentle envelope sweep.
    fn default() -> Self {
        BassPatch {
            octave_offset: -12,
            detune_cents: 12.0,
            sub_level: 0.7,
            cutoff_hz: 180.0,
            resonance: 0.35,
            env_mod_hz: 600.0,
            attack_s: 0.02,
            decay_s: 0.5,
            sustain: 0.8,
            release_s: 0.25,
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

/// Gate-driven ADSR with a held sustain stage. Linear attack, exponential
/// decay/release (matching the `infinitedsp`/fm_stab convention).
struct Adsr {
    stage: Stage,
    level: f32,
    attack_inc: f32,
    decay_coeff: f32,
    sustain: f32,
    release_coeff: f32,
}

impl Adsr {
    fn new() -> Self {
        Adsr {
            stage: Stage::Idle,
            level: 0.0,
            attack_inc: 1.0,
            decay_coeff: 0.0,
            sustain: 0.8,
            release_coeff: 0.0,
        }
    }

    fn configure(&mut self, patch: &BassPatch, sample_rate: f32) {
        let attack_samples = (patch.attack_s * sample_rate).max(1.0);
        self.attack_inc = 1.0 / attack_samples;
        self.decay_coeff = exp_coeff(patch.decay_s, sample_rate);
        self.release_coeff = exp_coeff(patch.release_s, sample_rate);
        self.sustain = patch.sustain.clamp(0.0, 1.0);
    }

    /// Gate on. Starts (or restarts) attack from the current level — no zero
    /// reset, so a re-strike while ringing doesn't click.
    fn gate_on(&mut self) {
        self.stage = Stage::Attack;
    }

    /// Gate off. Begins release from the current level.
    fn gate_off(&mut self) {
        if self.stage != Stage::Idle {
            self.stage = Stage::Release;
        }
    }

    fn is_idle(&self) -> bool {
        self.stage == Stage::Idle
    }

    #[inline]
    fn process(&mut self) -> f32 {
        match self.stage {
            Stage::Idle => self.level = 0.0,
            Stage::Attack => {
                self.level += self.attack_inc;
                if self.level >= 1.0 {
                    self.level = 1.0;
                    self.stage = Stage::Decay;
                }
            }
            Stage::Decay => {
                self.level = self.sustain + (self.level - self.sustain) * self.decay_coeff;
                if (self.level - self.sustain).abs() < 1e-4 {
                    self.level = self.sustain;
                    self.stage = Stage::Sustain;
                }
            }
            Stage::Sustain => self.level = self.sustain,
            Stage::Release => {
                self.level *= self.release_coeff;
                if self.level < 1e-4 {
                    self.level = 0.0;
                    self.stage = Stage::Idle;
                }
            }
        }
        self.level
    }
}

/// Exponential one-pole decay coefficient that falls to ~5% over `time_s`.
fn exp_coeff(time_s: f32, sample_rate: f32) -> f32 {
    let samples = (time_s * sample_rate).max(1.0);
    libm::expf(-1.0 / (samples / 3.0))
}

/// Monophonic subtractive bass voice: detuned saw stack + sub sine → resonant
/// lowpass → gate-driven ADSR.
pub struct RumbleBass {
    saws: [Oscillator; NUM_SAWS],
    /// Detune ratios for each saw (computed from `patch.detune_cents`).
    ratios: [f32; NUM_SAWS],
    sub: Oscillator,
    svf: Svf,
    env: Adsr,
    patch: BassPatch,
    sample_rate: f32,
    /// Carrier frequency for the saw stack (the played note, after octave_offset).
    freq: f32,
    velocity: f32,
    gain: f32,
    /// MIDI note currently held (for last-note-priority bookkeeping / debug).
    note: u8,
}

impl RumbleBass {
    pub fn new(sample_rate: f32) -> Self {
        let patch = BassPatch::default();
        let mut saws = core::array::from_fn(|_| {
            let mut o = Oscillator::new(AudioParam::hz(1.0), Waveform::Saw);
            o.set_sample_rate(sample_rate);
            o
        });
        // Spread initial phases so the detuned stack starts decorrelated (the
        // beating is audible immediately rather than swelling in).
        for (i, o) in saws.iter_mut().enumerate() {
            o.set_phase(i as f32 * INV_NSAWS);
        }
        let mut sub = Oscillator::new(AudioParam::hz(1.0), Waveform::Sine);
        sub.set_sample_rate(sample_rate);

        let mut svf = Svf::new(sample_rate);
        svf.set_freq(patch.cutoff_hz);
        svf.set_res(patch.resonance);

        let mut env = Adsr::new();
        env.configure(&patch, sample_rate);

        let mut b = RumbleBass {
            saws,
            ratios: [1.0; NUM_SAWS],
            sub,
            svf,
            env,
            patch,
            sample_rate,
            freq: 0.0,
            velocity: 0.0,
            gain: 0.5,
            note: 0,
        };
        b.recompute_ratios();
        b
    }

    /// Recompute the per-saw detune ratios from `patch.detune_cents`.
    /// Center saw at unity; the rest spread symmetrically ±detune.
    fn recompute_ratios(&mut self) {
        // Spread factors in [-1, 1] across the stack: e.g. for 3 → -1, 0, +1.
        for (i, r) in self.ratios.iter_mut().enumerate() {
            let spread = if NUM_SAWS > 1 {
                (i as f32 / (NUM_SAWS - 1) as f32) * 2.0 - 1.0
            } else {
                0.0
            };
            let cents = spread * self.patch.detune_cents;
            *r = libm::powf(2.0, cents / 1200.0);
        }
    }

    /// Gate on: start (or re-strike) a note. `note` is the MIDI note before
    /// the patch octave offset is applied.
    pub fn note_on(&mut self, note: u8, velocity: f32) {
        self.note = note;
        let shifted = (note as i32 + self.patch.octave_offset).clamp(0, 127);
        self.freq = midi_to_freq(shifted as u8);
        self.velocity = velocity.clamp(0.0, 1.0);

        // Restart oscillator phases only on a truly fresh note (env idle), so a
        // legato re-strike while still ringing doesn't click.
        if self.env.is_idle() {
            for (i, o) in self.saws.iter_mut().enumerate() {
                o.set_phase(i as f32 * INV_NSAWS);
            }
            self.sub.set_phase(0.0);
        }
        self.env.gate_on();
    }

    /// Gate off: begin the release tail.
    pub fn note_off(&mut self) {
        self.env.gate_off();
    }

    /// Render one mono sample.
    #[inline]
    pub fn tick(&mut self) -> f32 {
        if self.env.is_idle() {
            return 0.0;
        }
        let env = self.env.process();

        let f = self.freq;
        let mut saw = 0.0;
        for (o, &r) in self.saws.iter_mut().zip(self.ratios.iter()) {
            saw += o.tick(f * r);
        }
        saw *= INV_NSAWS;
        let sub = self.sub.tick(f * 0.5);
        let raw = saw + sub * self.patch.sub_level;

        // Envelope→cutoff sweep. Only recompute the (transcendental) filter
        // coefficients per-sample when there's actual modulation; otherwise the
        // cutoff was set once at construction / set_cutoff.
        if self.patch.env_mod_hz > 0.0 {
            let c = (self.patch.cutoff_hz + env * self.patch.env_mod_hz).min(self.sample_rate * 0.33);
            self.svf.set_freq(c);
        }
        self.svf.process(raw);
        self.svf.low() * env * self.velocity * self.gain
    }

    pub fn set_sample_rate(&mut self, sample_rate: f32) {
        self.sample_rate = sample_rate;
        for o in self.saws.iter_mut() {
            o.set_sample_rate(sample_rate);
        }
        self.sub.set_sample_rate(sample_rate);
        self.svf = Svf::new(sample_rate);
        self.svf.set_freq(self.patch.cutoff_hz);
        self.svf.set_res(self.patch.resonance);
        self.env.configure(&self.patch, sample_rate);
    }

    /// Replace the whole patch (takes effect immediately; filter coeffs and
    /// envelope rates are recomputed).
    pub fn load_patch(&mut self, patch: BassPatch) {
        self.patch = patch;
        self.recompute_ratios();
        self.svf.set_freq(patch.cutoff_hz);
        self.svf.set_res(patch.resonance);
        self.env.configure(&patch, self.sample_rate);
    }

    pub fn patch(&self) -> &BassPatch {
        &self.patch
    }
    pub fn is_active(&self) -> bool {
        !self.env.is_idle()
    }
    pub fn set_gain(&mut self, g: f32) {
        self.gain = g.max(0.0);
    }
    pub fn gain(&self) -> f32 {
        self.gain
    }
    pub fn set_cutoff(&mut self, hz: f32) {
        self.patch.cutoff_hz = hz.clamp(20.0, self.sample_rate * 0.33);
        self.svf.set_freq(self.patch.cutoff_hz);
    }
    pub fn set_resonance(&mut self, r: f32) {
        self.patch.resonance = r.clamp(0.0, 1.0);
        self.svf.set_res(self.patch.resonance);
    }
    pub fn set_decay(&mut self, s: f32) {
        self.patch.decay_s = s.max(0.001);
        self.env.configure(&self.patch, self.sample_rate);
    }
    pub fn set_env_mod(&mut self, hz: f32) {
        self.patch.env_mod_hz = hz.max(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_voice_is_silent() {
        let mut b = RumbleBass::new(48_000.0);
        for _ in 0..256 {
            assert_eq!(b.tick(), 0.0);
        }
    }

    #[test]
    fn held_note_sustains_then_releases_to_silence() {
        let mut b = RumbleBass::new(48_000.0);
        b.note_on(48, 1.0); // C3 → C2 after -12 offset
        // Hold for ~0.5 s; should be producing signal and still active.
        let mut peak = 0.0f32;
        for _ in 0..24_000 {
            peak = peak.max(b.tick().abs());
        }
        assert!(peak > 0.0, "held bass should produce signal");
        assert!(b.is_active(), "note held → still active");

        // Release; after the tail it must return to exact silence.
        b.note_off();
        for _ in 0..48_000 {
            b.tick();
        }
        assert!(!b.is_active(), "released note should go idle");
        let mut tail = 0.0f32;
        for _ in 0..256 {
            tail += b.tick().abs();
        }
        assert_eq!(tail, 0.0, "bass should decay to exact silence");
    }

    #[test]
    fn lowpass_attenuates_relative_to_open_filter() {
        // With a low cutoff the RMS should be markedly lower than with the
        // filter wide open — confirms the LPF is actually in the path.
        fn rms(cutoff: f32) -> f32 {
            let mut b = RumbleBass::new(48_000.0);
            let mut p = BassPatch::default();
            p.cutoff_hz = cutoff;
            p.env_mod_hz = 0.0; // static cutoff for a clean comparison
            p.resonance = 0.2;
            p.sub_level = 0.0; // isolate the saws — the sub sine is below both cutoffs
            p.octave_offset = 0; // keep the note high so there's plenty to filter
            b.load_patch(p);
            b.note_on(72, 1.0); // C5 → rich harmonics well above 120 Hz
            let mut acc = 0.0f64;
            let n = 24_000;
            for _ in 0..n {
                let s = b.tick();
                acc += (s * s) as f64;
            }
            (acc / n as f64).sqrt() as f32
        }
        let closed = rms(120.0);
        let open = rms(12_000.0);
        assert!(
            open > closed * 1.3,
            "open filter ({open}) should pass more energy than closed ({closed})"
        );
    }
}
