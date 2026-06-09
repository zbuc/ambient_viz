//! Firmware-exact voice rigs. We deliberately do NOT use `dsp::Engine` here —
//! the firmware doesn't either. Each voice's sub-graph is hand-rolled and summed
//! in the same order the firmware master bus uses (after tape + destruction,
//! before the master limiter — see firmware/src/main.rs), so a voice auditioned
//! here sounds like it does on the Daisy.

use dsp::limiter::Limiter;
use dsp::{
    AudioParam, BassPatch, FmPatch, FmStab, FrameProcessor as _, PainMaterialVoice, PingPongDelay,
    RumbleBass,
};

/// Default install note for the FM stab: A5 (MIDI 81).
pub const DEFAULT_FM_NOTE: u8 = 81;
/// Default bass note: D2 (MIDI 38) — the `D minor` install key root, an octave
/// down via the patch's `octave_offset`.
pub const DEFAULT_BASS_NOTE: u8 = 38;

/// One auditionable voice: trigger it, then render interleaved-stereo blocks.
pub trait Rig: Send {
    /// Strike / start the voice; returns a label for what was triggered.
    fn trigger(&mut self) -> &'static str;
    /// Render `out.len()/2` stereo frames (interleaved) in place.
    fn render(&mut self, out: &mut [f32]);
    /// Grow internal scratch up front so the callback never allocates.
    fn prime(&mut self) {}
}

/// Build the firmware-realistic stab ping-pong delay. The first ctor arg is the
/// *max* buffer in seconds (what's allocated): 0.25 s stereo f32 ≈ 96 KB, fits
/// the firmware's AXI-SRAM heap (the Engine's 1.0 s default would overflow it).
/// `mix = 1.0` → wet-only, so callers scale the wet themselves when summing,
/// exactly like the Engine's stab bus.
fn stab_delay() -> PingPongDelay {
    PingPongDelay::new(
        0.25,                      // max delay buffer, seconds (fits AXI heap)
        AudioParam::seconds(0.22), // ~quarter-note bounce, < the 0.25 s ceiling
        AudioParam::linear(0.55),  // feedback → a few L<->R repeats
        AudioParam::linear(1.0),   // mix = wet-only
    )
}

/// The FM-bank sub-graph (bell OR industrial): FM voice + ping-pong delay +
/// master limiter, summed in firmware master-bus order. The only difference
/// between bell and industrial is the loaded patch — exactly how the firmware
/// does it (it swaps the patch on the shared `FmStab` per strike).
pub struct BellRig {
    bell: FmStab,
    delay: PingPongDelay,
    limiter: Limiter,
    send: Vec<f32>,
    wet: f32,
    note: u8,
    label: &'static str,
    sample_index: u64,
}

impl BellRig {
    pub fn new(sample_rate: f32, patch: FmPatch, note: u8, label: &'static str) -> Self {
        let mut bell = FmStab::new(sample_rate);
        bell.load_patch(patch);
        let mut delay = stab_delay();
        delay.set_sample_rate(sample_rate);
        BellRig {
            bell,
            delay,
            limiter: Limiter::new(sample_rate),
            send: Vec::new(),
            wet: 0.6,
            note,
            label,
            sample_index: 0,
        }
    }
}

impl Rig for BellRig {
    fn prime(&mut self) {
        let mut scratch = vec![0.0f32; 2048 * 2];
        self.delay.process(&mut scratch, 0);
    }

    fn trigger(&mut self) -> &'static str {
        self.bell.note_on(self.note, 1.0);
        self.label
    }

    fn render(&mut self, out: &mut [f32]) {
        let frames = out.len() / 2;
        self.send.resize(frames * 2, 0.0);
        for i in 0..frames {
            let s = self.bell.tick();
            out[2 * i] = s;
            out[2 * i + 1] = s;
            self.send[2 * i] = s; // delay send, left only — cross-feedback bounces L<->R
            self.send[2 * i + 1] = 0.0;
        }
        self.delay.process(&mut self.send, self.sample_index);
        let wet = self.wet;
        for (o, &w) in out.iter_mut().zip(self.send.iter()) {
            *o += w * wet;
        }
        self.limiter.process(out);
        self.sample_index += frames as u64;
    }
}

/// The "pain material" speech sub-graph: `PainMaterialVoice` (SpeechSynth + its
/// own reverb) → master limiter, exactly the firmware's voice slot.
pub struct VoiceRig {
    voice: PainMaterialVoice,
    limiter: Limiter,
    cap: usize,
    next: usize,
    sample_index: u64,
}

impl VoiceRig {
    pub fn new(sample_rate: f32) -> Self {
        let cap = 4096; // interleaved stereo samples (2048 frames) per chunk
        VoiceRig {
            voice: PainMaterialVoice::new(sample_rate, cap),
            limiter: Limiter::new(sample_rate),
            cap,
            next: 0,
            sample_index: 0,
        }
    }
}

impl Rig for VoiceRig {
    fn trigger(&mut self) -> &'static str {
        let idx = self.next % dsp::pain_voice::PHRASE_COUNT;
        self.next += 1;
        self.voice.trigger_phrase(idx, 1.0);
        dsp::pain_voice::PHRASE_LABELS[idx]
    }

    fn render(&mut self, out: &mut [f32]) {
        let mut off = 0;
        while off < out.len() {
            let end = (off + self.cap).min(out.len());
            let chunk = &mut out[off..end];
            self.voice.process(chunk, self.sample_index);
            self.sample_index += (chunk.len() / 2) as u64;
            off = end;
        }
        self.limiter.process(out);
    }
}

/// Live-editing rig for the browser patch editor: the FM stab (+ its ping-pong)
/// and the rumble bass summed into ONE master limiter — the firmware master-bus
/// order (stab and bass are both summed pre-master). Patches and notes are
/// swapped live from the HTTP server; rendering never allocates after `prime`.
pub struct PreviewRig {
    fm: FmStab,
    delay: PingPongDelay,
    send: Vec<f32>,
    wet: f32,
    bass: RumbleBass,
    limiter: Limiter,
    fm_note: u8,
    bass_note: u8,
    sample_index: u64,
    sample_rate: f32,
}

impl PreviewRig {
    pub fn new(sample_rate: f32) -> Self {
        let mut fm = FmStab::new(sample_rate);
        fm.load_patch(FmPatch::default());
        let mut delay = stab_delay();
        delay.set_sample_rate(sample_rate);
        let mut bass = RumbleBass::new(sample_rate);
        bass.load_patch(BassPatch::default());
        PreviewRig {
            fm,
            delay,
            send: Vec::new(),
            wet: 0.6,
            bass,
            limiter: Limiter::new(sample_rate),
            fm_note: DEFAULT_FM_NOTE,
            bass_note: DEFAULT_BASS_NOTE,
            sample_index: 0,
            sample_rate,
        }
    }

    pub fn set_fm_patch(&mut self, patch: FmPatch) {
        self.fm.load_patch(patch);
    }
    pub fn set_bass_patch(&mut self, patch: BassPatch) {
        self.bass.load_patch(patch);
    }

    /// Kill all audio immediately: the held bass sustain, any FM tail, and the
    /// ping-pong feedback ring. Rebuilds every voice + the delay from scratch
    /// (the surest reset — no per-voice "panic" API needed), then re-applies the
    /// currently-loaded patches so the editor's state is preserved. A one-time
    /// allocation under the audio lock; fine for a manual stop on the dev host.
    pub fn silence(&mut self) {
        let fm_patch = *self.fm.patch();
        let bass_patch = *self.bass.patch();
        let sr = self.sample_rate;
        *self = PreviewRig::new(sr);
        self.fm.load_patch(fm_patch);
        self.bass.load_patch(bass_patch);
        self.prime();
    }
    /// Strike the stab. `note` of `None` reuses the last note.
    pub fn trigger_fm(&mut self, note: Option<u8>) {
        if let Some(n) = note {
            self.fm_note = n;
        }
        self.fm.note_on(self.fm_note, 1.0);
    }
    pub fn trigger_bass(&mut self, note: Option<u8>) {
        if let Some(n) = note {
            self.bass_note = n;
        }
        self.bass.note_on(self.bass_note, 1.0);
    }
}

impl Rig for PreviewRig {
    fn prime(&mut self) {
        let mut scratch = vec![0.0f32; 2048 * 2];
        self.delay.process(&mut scratch, 0);
    }

    fn trigger(&mut self) -> &'static str {
        self.trigger_fm(None);
        "fm"
    }

    fn render(&mut self, out: &mut [f32]) {
        let frames = out.len() / 2;
        self.send.resize(frames * 2, 0.0);
        for i in 0..frames {
            let s = self.fm.tick();
            let b = self.bass.tick();
            out[2 * i] = s + b; // dry stab + dry bass on both channels
            out[2 * i + 1] = s + b;
            self.send[2 * i] = s; // only the stab feeds the ping-pong
            self.send[2 * i + 1] = 0.0;
        }
        self.delay.process(&mut self.send, self.sample_index);
        let wet = self.wet;
        for (o, &w) in out.iter_mut().zip(self.send.iter()) {
            *o += w * wet;
        }
        self.limiter.process(out);
        self.sample_index += frames as u64;
    }
}
