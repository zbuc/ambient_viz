//! Wavetable voice — a Waldorf Microwave II-style clone.
//!
//! Per voice: **two wavetable oscillators** (each scanning a Waldorf user-wave
//! table from [`crate::wavetable_bank`] with a morph between adjacent waves) →
//! a **mixer** (osc1, osc2, ring mod = osc1×osc2, noise) → a **multimode
//! filter** ([`crate::svf::Svf`]) → a **VCA**, shaped by a **filter envelope**
//! and an **amp envelope**. Osc 2 can hard-sync to osc 1 and be FM'd by it.
//!
//! The patch ([`WtPatch`]) mirrors the browser editor's schema
//! (`static/audio/shared/patch-schema.js`, `WT_PATCH`) field-for-field so the
//! same JSON drives the editor preview (`host::rigs::PreviewRig`) and, later,
//! the firmware. Wavetable selection rides as a string id (`"vswaves1"`, …)
//! resolved against the bank at note-on.
//!
//! Real-time discipline matches the other voices: per-sample [`WtVoice::tick`],
//! no allocation after construction, f32 math. The sample reads are flash
//! indexes + one multiply (see [`crate::wavetable_bank::sample`]); no
//! band-limiting yet, so very high notes will alias (BACKLOG: mip-maps).

use crate::svf::Svf;
use crate::wavetable_bank::{sample, table_by_id, WtTableDef, WAVE_LEN};
use heapless::String;
use serde::{Deserialize, Serialize};

/// Polyphony for the wavetable bank — a triad + headroom, like the FM stab.
pub const WT_VOICES: usize = 8;

/// Multimode filter model. A representative subset of the Microwave II's 13;
/// `rename`s match the editor's `WT_FILTER_TYPES` strings exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WtFilterType {
    #[serde(rename = "Lowpass 24dB")]
    Lowpass24,
    #[serde(rename = "Lowpass 12dB")]
    Lowpass12,
    #[serde(rename = "Bandpass")]
    Bandpass,
    #[serde(rename = "Highpass")]
    Highpass,
    #[serde(rename = "Notch")]
    Notch,
    #[serde(rename = "Waveshaper")]
    Waveshaper,
    #[serde(rename = "Bitreduction")]
    Bitreduction,
}

impl WtFilterType {
    /// Pre-filter shaping for the non-standard models; identity otherwise.
    #[inline]
    fn pre(self, x: f32) -> f32 {
        match self {
            WtFilterType::Waveshaper => libm::tanhf(x * 1.8),
            WtFilterType::Bitreduction => libm::roundf(x * 8.0) / 8.0, // ~4-bit crush
            _ => x,
        }
    }
    /// Pick the filter output band for this model.
    #[inline]
    fn band_of(self, svf: &Svf) -> f32 {
        match self {
            WtFilterType::Bandpass => svf.band(),
            WtFilterType::Highpass => svf.high(),
            WtFilterType::Notch => svf.notch(),
            _ => svf.low(), // Lowpass 24/12, Waveshaper, Bitreduction
        }
    }
}

/// A two-state toggle param. Variant names match the editor's `ONOFF` strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Toggle {
    Off,
    On,
}
impl Toggle {
    #[inline]
    fn is_on(self) -> bool {
        matches!(self, Toggle::On)
    }
}

/// Wavetable-id string. 16 bytes is plenty for the bank's ids (`"ppgebass"`).
pub type WtId = String<16>;

fn wt_id(s: &str) -> WtId {
    let mut o = WtId::new();
    let _ = o.push_str(s);
    o
}

/// Tunable timbre/shape for a [`WtSynth`]. Field names and types mirror the
/// editor's `WT_PATCH` schema; serde (de)serializes the exact JSON the editor
/// exports and the firmware will read off SD.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WtPatch {
    pub osc1_wavetable: WtId,
    pub osc1_wave: f32,
    pub osc1_semitone: i32,
    pub osc1_detune: f32,
    pub osc1_keytrack: f32,

    pub osc2_wavetable: WtId,
    pub osc2_wave: f32,
    pub osc2_semitone: i32,
    pub osc2_detune: f32,
    pub osc2_keytrack: f32,
    pub osc2_sync: Toggle,
    pub osc2_fm: f32,

    pub mix_osc1: f32,
    pub mix_osc2: f32,
    pub mix_ring: f32,
    pub mix_noise: f32,
    pub noise_colour: f32,

    pub filter_type: WtFilterType,
    pub cutoff_hz: f32,
    pub resonance: f32,
    pub filter_env_amount: f32,
    pub filter_keytrack: f32,

    pub fenv_attack: f32,
    pub fenv_decay: f32,
    pub fenv_sustain: f32,
    pub fenv_release: f32,

    pub aenv_attack: f32,
    pub aenv_decay: f32,
    pub aenv_sustain: f32,
    pub aenv_release: f32,
    pub volume: f32,

    pub glide: f32,
}

impl Default for WtPatch {
    fn default() -> Self {
        WtPatch {
            osc1_wavetable: wt_id("vswaves1"),
            osc1_wave: 0.0,
            osc1_semitone: 0,
            osc1_detune: 0.0,
            osc1_keytrack: 100.0,
            osc2_wavetable: wt_id("ppgebass"),
            osc2_wave: 0.0,
            osc2_semitone: 0,
            osc2_detune: 7.0,
            osc2_keytrack: 100.0,
            osc2_sync: Toggle::Off,
            osc2_fm: 0.0,
            mix_osc1: 1.0,
            mix_osc2: 0.7,
            mix_ring: 0.0,
            mix_noise: 0.0,
            noise_colour: 0.5,
            filter_type: WtFilterType::Lowpass24,
            cutoff_hz: 8000.0,
            resonance: 0.2,
            filter_env_amount: 0.3,
            filter_keytrack: 50.0,
            fenv_attack: 0.005,
            fenv_decay: 0.5,
            fenv_sustain: 0.4,
            fenv_release: 0.4,
            aenv_attack: 0.005,
            aenv_decay: 1.0,
            aenv_sustain: 0.8,
            aenv_release: 0.6,
            volume: 0.8,
            glide: 0.0,
        }
    }
}

/// Effective MIDI note → Hz (fractional, for keytrack/detune). Note 69 = 440.
#[inline]
fn note_to_freq(nf: f32) -> f32 {
    440.0 * libm::powf(2.0, (nf - 69.0) / 12.0)
}

// --- oscillator -----------------------------------------------------------

/// A wavetable oscillator: a 0..1 phase over the 128-sample cycle, scanning a
/// contiguous run of waves and morphing between the two nearest at `wave_pos`.
#[derive(Clone, Copy)]
struct WtOsc {
    phase: f32,
    first: usize,
    count: usize,
    wave_pos: f32,
}

impl WtOsc {
    fn new() -> Self {
        WtOsc { phase: 0.0, first: 0, count: 1, wave_pos: 0.0 }
    }
    fn set_table(&mut self, t: &WtTableDef) {
        self.first = t.first;
        self.count = t.count.max(1);
    }
    #[inline]
    fn reset_phase(&mut self) {
        self.phase = 0.0;
    }
    /// Advance by `inc` cycles and return `(sample, wrapped)`. `wrapped` is true
    /// on the sample where phase crossed 1.0 — used to hard-sync a follower.
    #[inline]
    fn tick(&mut self, inc: f32) -> (f32, bool) {
        // morph between the two nearest waves in the table
        let span = self.count.saturating_sub(1) as f32;
        let wf = self.wave_pos.clamp(0.0, 1.0) * span;
        let wi = wf as usize;
        let wfrac = wf - wi as f32;
        let w0 = self.first + wi;
        let w1 = self.first + (wi + 1).min(self.count - 1);

        // linear interp within the cycle (power-of-two mask wrap)
        let p = self.phase * WAVE_LEN as f32;
        let i = p as usize & (WAVE_LEN - 1);
        let frac = p - (p as usize) as f32;
        let i1 = (i + 1) & (WAVE_LEN - 1);
        let a = sample(w0, i) + (sample(w0, i1) - sample(w0, i)) * frac;
        let b = sample(w1, i) + (sample(w1, i1) - sample(w1, i)) * frac;
        let out = a + (b - a) * wfrac;

        self.phase += inc;
        let mut wrapped = false;
        while self.phase >= 1.0 {
            self.phase -= 1.0;
            wrapped = true;
        }
        while self.phase < 0.0 {
            self.phase += 1.0; // FM can drive inc negative
        }
        (out, wrapped)
    }
}

// --- envelope -------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

/// Linear-attack, exponential decay/release ADSR with a held sustain — the same
/// convention as [`crate::bass`], configured directly from seconds.
#[derive(Clone, Copy)]
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
            sustain: 0.0,
            release_coeff: 0.0,
        }
    }
    fn configure(&mut self, a: f32, d: f32, s: f32, r: f32, sample_rate: f32) {
        self.attack_inc = 1.0 / (a * sample_rate).max(1.0);
        self.decay_coeff = exp_coeff(d, sample_rate);
        self.release_coeff = exp_coeff(r, sample_rate);
        self.sustain = s.clamp(0.0, 1.0);
    }
    fn gate_on(&mut self) {
        self.stage = Stage::Attack;
    }
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

// --- voice ----------------------------------------------------------------

struct WtVoice {
    osc1: WtOsc,
    osc2: WtOsc,
    inc1: f32,
    inc2: f32,
    sync: bool,
    fm: f32,

    mix_osc1: f32,
    mix_osc2: f32,
    mix_ring: f32,
    mix_noise: f32,
    noise_colour: f32,
    noise_lp: f32,
    rng: u32,

    svf: Svf,
    filter_type: WtFilterType,
    cutoff_base: f32, // post-keytrack, pre-envelope
    env_amount: f32,

    amp_env: Adsr,
    filt_env: Adsr,
    volume: f32,
    velocity: f32,
    age: u64,
}

impl WtVoice {
    fn new(sample_rate: f32) -> Self {
        WtVoice {
            osc1: WtOsc::new(),
            osc2: WtOsc::new(),
            inc1: 0.0,
            inc2: 0.0,
            sync: false,
            fm: 0.0,
            mix_osc1: 1.0,
            mix_osc2: 0.0,
            mix_ring: 0.0,
            mix_noise: 0.0,
            noise_colour: 0.5,
            noise_lp: 0.0,
            rng: 0x1234_5678,
            svf: Svf::new(sample_rate),
            filter_type: WtFilterType::Lowpass24,
            cutoff_base: 8000.0,
            env_amount: 0.0,
            amp_env: Adsr::new(),
            filt_env: Adsr::new(),
            volume: 0.8,
            velocity: 0.0,
            age: 0,
        }
    }

    fn set_sample_rate(&mut self, sample_rate: f32) {
        self.svf = Svf::new(sample_rate);
    }

    fn is_idle(&self) -> bool {
        self.amp_env.is_idle()
    }

    /// One osc's phase increment (cycles/sample) from the played note.
    fn osc_inc(note: u8, semitone: i32, detune_cents: f32, keytrack: f32, sample_rate: f32) -> f32 {
        // keytrack pivots on note 60: 100% = full tracking, 0% = fixed pitch.
        let nf = 60.0 + (note as f32 - 60.0) * (keytrack / 100.0) + semitone as f32;
        let freq = note_to_freq(nf) * libm::powf(2.0, detune_cents / 1200.0);
        freq / sample_rate
    }

    fn note_on(&mut self, note: u8, velocity: f32, patch: &WtPatch, sample_rate: f32, age: u64) {
        self.velocity = velocity.clamp(0.0, 1.0);
        self.age = age;

        self.osc1.set_table(table_by_id(patch.osc1_wavetable.as_str()));
        self.osc2.set_table(table_by_id(patch.osc2_wavetable.as_str()));
        self.osc1.wave_pos = patch.osc1_wave;
        self.osc2.wave_pos = patch.osc2_wave;
        self.osc1.reset_phase();
        self.osc2.reset_phase();

        self.inc1 = Self::osc_inc(note, patch.osc1_semitone, patch.osc1_detune, patch.osc1_keytrack, sample_rate);
        self.inc2 = Self::osc_inc(note, patch.osc2_semitone, patch.osc2_detune, patch.osc2_keytrack, sample_rate);
        self.sync = patch.osc2_sync.is_on();
        self.fm = patch.osc2_fm.max(0.0);

        self.mix_osc1 = patch.mix_osc1;
        self.mix_osc2 = patch.mix_osc2;
        self.mix_ring = patch.mix_ring;
        self.mix_noise = patch.mix_noise;
        self.noise_colour = patch.noise_colour.clamp(0.0, 1.0);
        self.noise_lp = 0.0;

        // filter: cutoff with per-note keytrack baked in; env sweeps it per-sample.
        let kt_oct = (note as f32 - 60.0) / 12.0 * (patch.filter_keytrack / 100.0);
        self.cutoff_base = (patch.cutoff_hz * libm::powf(2.0, kt_oct)).clamp(20.0, sample_rate / 3.0);
        self.filter_type = patch.filter_type;
        self.env_amount = patch.filter_env_amount;
        self.svf.set_res(patch.resonance);
        self.svf.set_freq(self.cutoff_base);

        self.amp_env.configure(patch.aenv_attack, patch.aenv_decay, patch.aenv_sustain, patch.aenv_release, sample_rate);
        self.filt_env.configure(patch.fenv_attack, patch.fenv_decay, patch.fenv_sustain, patch.fenv_release, sample_rate);
        self.volume = patch.volume;
        self.amp_env.gate_on();
        self.filt_env.gate_on();
    }

    fn note_off(&mut self) {
        self.amp_env.gate_off();
        self.filt_env.gate_off();
    }

    #[inline]
    fn white(&mut self) -> f32 {
        // xorshift32 → [-1, 1)
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        (x as f32 / 2_147_483_648.0) - 1.0
    }

    #[inline]
    fn tick(&mut self, sample_rate: f32) -> f32 {
        if self.amp_env.is_idle() {
            return 0.0;
        }
        let amp = self.amp_env.process();
        let fenv = self.filt_env.process();

        let (o1, wrapped) = self.osc1.tick(self.inc1);
        if self.sync && wrapped {
            self.osc2.reset_phase();
        }
        // osc1 frequency-modulates osc2 (approximate, bounded).
        let inc2 = self.inc2 * (1.0 + 1.5 * self.fm * o1);
        let (o2, _) = self.osc2.tick(inc2);

        let ring = o1 * o2;
        let mut mix = o1 * self.mix_osc1 + o2 * self.mix_osc2 + ring * self.mix_ring;
        if self.mix_noise > 0.0 {
            let w = self.white();
            // colour: 0 = dark (heavy LP), 1 = bright (passes white)
            let alpha = 0.02 + self.noise_colour * 0.98;
            self.noise_lp += alpha * (w - self.noise_lp);
            mix += self.noise_lp * self.mix_noise;
        }

        // filter-envelope sweep on cutoff (only recompute coeffs when modulated)
        if self.env_amount != 0.0 {
            let c = (self.cutoff_base * libm::powf(2.0, self.env_amount * fenv * 4.0))
                .clamp(20.0, sample_rate / 3.0);
            self.svf.set_freq(c);
        }
        self.svf.process(self.filter_type.pre(mix));
        let filtered = self.filter_type.band_of(&self.svf);

        filtered * amp * self.velocity * self.volume
    }
}

// --- polyphonic bank ------------------------------------------------------

/// A small polyphonic bank of [`WtVoice`]s sharing one [`WtPatch`].
pub struct WtSynth {
    voices: [WtVoice; WT_VOICES],
    patch: WtPatch,
    sample_rate: f32,
    gain: f32,
    counter: u64,
}

impl WtSynth {
    pub fn new(sample_rate: f32) -> Self {
        WtSynth {
            voices: core::array::from_fn(|_| WtVoice::new(sample_rate)),
            patch: WtPatch::default(),
            sample_rate,
            gain: 0.4,
            counter: 0,
        }
    }

    /// Start a note, allocating a free voice or stealing the oldest.
    pub fn note_on(&mut self, note: u8, velocity: f32) {
        self.counter = self.counter.wrapping_add(1);
        let age = self.counter;
        let idx = self.pick_voice();
        self.voices[idx].note_on(note, velocity, &self.patch, self.sample_rate, age);
    }

    /// Release every sounding voice into its amp/filter release tail.
    pub fn note_off_all(&mut self) {
        for v in self.voices.iter_mut() {
            v.note_off();
        }
    }

    pub fn play_chord(&mut self, notes: &[u8], velocity: f32) {
        for &n in notes {
            self.note_on(n, velocity);
        }
    }

    fn pick_voice(&self) -> usize {
        let mut best = 0usize;
        let mut best_age = u64::MAX;
        for (i, v) in self.voices.iter().enumerate() {
            if v.is_idle() {
                return i;
            }
            if v.age < best_age {
                best_age = v.age;
                best = i;
            }
        }
        best
    }

    /// Render and sum all active voices for one sample (mono).
    #[inline]
    pub fn tick(&mut self) -> f32 {
        let sr = self.sample_rate;
        let mut sum = 0.0;
        for v in self.voices.iter_mut() {
            sum += v.tick(sr);
        }
        sum * self.gain
    }

    pub fn set_sample_rate(&mut self, sample_rate: f32) {
        self.sample_rate = sample_rate;
        for v in self.voices.iter_mut() {
            v.set_sample_rate(sample_rate);
        }
    }

    /// Replace the patch (timbre). Takes effect on the next note-on; ringing
    /// voices keep the patch they were struck with.
    pub fn load_patch(&mut self, patch: WtPatch) {
        self.patch = patch;
    }
    pub fn patch(&self) -> &WtPatch {
        &self.patch
    }
    pub fn set_gain(&mut self, gain: f32) {
        self.gain = gain.max(0.0);
    }
    pub fn is_active(&self) -> bool {
        self.voices.iter().any(|v| !v.is_idle())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_bank_is_silent() {
        let mut s = WtSynth::new(48_000.0);
        for _ in 0..256 {
            assert_eq!(s.tick(), 0.0);
        }
    }

    #[test]
    fn struck_voice_makes_bounded_sound() {
        let mut s = WtSynth::new(48_000.0);
        s.note_on(60, 1.0);
        let mut peak = 0.0f32;
        for _ in 0..4_800 {
            let x = s.tick();
            assert!(x.abs() <= 2.0, "output should stay bounded, got {x}");
            peak = peak.max(x.abs());
        }
        assert!(peak > 0.0, "a struck wavetable voice should produce signal");
    }

    #[test]
    fn released_note_decays_to_silence() {
        let mut s = WtSynth::new(48_000.0);
        s.note_on(60, 1.0);
        for _ in 0..4_800 {
            s.tick();
        }
        s.note_off_all();
        for _ in 0..96_000 {
            s.tick();
        }
        assert!(!s.is_active(), "released voices should go idle");
        let mut tail = 0.0f32;
        for _ in 0..512 {
            tail += s.tick().abs();
        }
        assert_eq!(tail, 0.0, "should decay to exact silence");
    }

    #[test]
    fn wave_position_changes_the_waveform() {
        // Two patches differing only in osc1 wave position should render
        // different samples (the morph actually selects different waves).
        fn first_block(pos: f32) -> [f32; 256] {
            let mut s = WtSynth::new(48_000.0);
            let mut p = WtPatch::default();
            p.mix_osc2 = 0.0; // isolate osc 1
            p.filter_env_amount = 0.0;
            p.cutoff_hz = 16_000.0; // open the filter so the wave passes
            p.osc1_wave = pos;
            s.load_patch(p);
            s.note_on(48, 1.0);
            core::array::from_fn(|_| s.tick())
        }
        let a = first_block(0.0);
        let b = first_block(1.0);
        let diff: f32 = a.iter().zip(b.iter()).map(|(x, y)| (x - y).abs()).sum();
        assert!(diff > 0.0, "different wave positions should sound different");
    }

    #[test]
    fn voice_stealing_caps_active_voices() {
        let mut s = WtSynth::new(48_000.0);
        for n in 48..48 + (WT_VOICES as u8 + 4) {
            s.note_on(n, 1.0);
        }
        let active = s.voices.iter().filter(|v| !v.is_idle()).count();
        assert!(active <= WT_VOICES);
    }

    #[test]
    fn patch_json_round_trips_via_serde_json_core() {
        // The editor and the (future) firmware SD overlay share ONE JSON schema:
        // serde field names must match the browser export, enums serialize as
        // their rename strings, and wavetable ids as strings. Parse with the
        // same no_std parser the firmware uses.
        let patch = WtPatch::default();
        let mut buf = [0u8; 1024];
        let n = serde_json_core::to_slice(&patch, &mut buf).expect("serialize");
        let json = core::str::from_utf8(&buf[..n]).unwrap();
        assert!(json.contains("\"filter_type\":\"Lowpass 24dB\""), "filter enum rename: {json}");
        assert!(json.contains("\"osc2_sync\":\"Off\""), "toggle enum: {json}");
        assert!(json.contains("\"osc1_wavetable\":\"vswaves1\""), "wavetable id string: {json}");

        let (back, _): (WtPatch, _) = serde_json_core::from_slice(&buf[..n]).expect("deserialize");
        assert_eq!(back.filter_type, patch.filter_type);
        assert_eq!(back.osc2_sync, patch.osc2_sync);
        assert_eq!(back.osc1_wavetable, patch.osc1_wavetable);
        assert_eq!(back.cutoff_hz, patch.cutoff_hz);

        // A hand-written blob in the browser's exact key order + string enums.
        let browser = br#"{"osc1_wavetable":"vswaves2","osc1_wave":0.5,"osc1_semitone":0,
            "osc1_detune":0,"osc1_keytrack":100,"osc2_wavetable":"ppgebass","osc2_wave":0,
            "osc2_semitone":-12,"osc2_detune":7,"osc2_keytrack":100,"osc2_sync":"On","osc2_fm":0.2,
            "mix_osc1":1,"mix_osc2":0.7,"mix_ring":0,"mix_noise":0,"noise_colour":0.5,
            "filter_type":"Bandpass","cutoff_hz":2600,"resonance":0.35,"filter_env_amount":0.5,
            "filter_keytrack":40,"fenv_attack":0.9,"fenv_decay":2,"fenv_sustain":0.5,"fenv_release":2.5,
            "aenv_attack":1.2,"aenv_decay":3,"aenv_sustain":0.85,"aenv_release":3.5,"volume":0.8,"glide":0.05}"#;
        let (p, _): (WtPatch, _) = serde_json_core::from_slice(browser).expect("browser json");
        assert_eq!(p.filter_type, WtFilterType::Bandpass);
        assert_eq!(p.osc2_sync, Toggle::On);
        assert_eq!(p.osc1_wavetable.as_str(), "vswaves2");
    }
}
