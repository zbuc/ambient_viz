//! Firmware-exact voice rigs. We deliberately do NOT use `dsp::Engine` here —
//! the firmware doesn't either. Each voice's sub-graph is hand-rolled and summed
//! in the same order the firmware master bus uses (after tape + destruction,
//! before the master limiter — see firmware/src/main.rs), so a voice auditioned
//! here sounds like it does on the Daisy.

use dsp::limiter::Limiter;
use dsp::transporter::Transporter;
use dsp::{
    AudioParam, BassPatch, FmPatch, FmStab, FrameProcessor as _, PainMaterialVoice, PingPongDelay,
    RumbleBass, WtPatch, WtSynth,
};

/// Default install note for the FM stab: A5 (MIDI 81).
pub const DEFAULT_FM_NOTE: u8 = 81;
/// Default bass note: D2 (MIDI 38) — the `D minor` install key root, an octave
/// down via the patch's `octave_offset`.
pub const DEFAULT_BASS_NOTE: u8 = 38;
/// Default wavetable-voice note: C4 (MIDI 60) — the keytrack pivot, so a fresh
/// patch plays at its written pitch.
pub const DEFAULT_WT_NOTE: u8 = 60;

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

/// Audition the reverse-grain pad (`dsp::transporter`). The source is the
/// polyphonic **wavetable** voice (`WtSynth`) — sustaining (held ADSR) and
/// evolving (per-note filter-envelope sweep) — playing a slow chord
/// PROGRESSION (long held notes that change over time, the right material
/// for a pad, unlike a percussive stab). That held chord is run through the
/// [`Transporter`]: grains start at `playhead − offset` and read **backward**
/// into the prior audio, summed into a smooth reversed pad. Output = dry
/// chord + the pad, into the master limiter. An EFFECT over a polyphonic
/// source — `trigger()` advances the progression.
pub struct TransporterRig {
    wt: WtSynth,
    trans: Transporter,
    limiter: Limiter,
    dry: Vec<f32>,
    pad: Vec<f32>,
    /// Level of the **primary playhead** (the dry source at the write head)
    /// in the output. The pad's level is the transporter's own `set_level`.
    /// 0 = pad only (pure reversed ghost); raise to blend the direct chord in.
    dry_mix: f32,
    /// A slow modal wash in **D Dorian** — the modal color is the raised 6th
    /// (B natural, not B♭): a major IV and a minor v, no leading tone, a D/A
    /// common-tone pedal so it hovers instead of resolving. 7th voicings for
    /// the floaty modal feel.
    progression: [[u8; 4]; 4],
    next: usize,
}

impl TransporterRig {
    pub fn new(sample_rate: f32) -> Self {
        let mut wt = WtSynth::new(sample_rate);
        wt.load_patch(WtPatch::default()); // sustaining wavetable pad with filter movement
        let mut trans = Transporter::new(sample_rate);
        trans.set_grain_ms(20.0);
        // trans.set_density(45.0);
        trans.set_density(5.0);
        trans.set_offset_ms(150.0); // start the reverse read offset-back from the playhead
        trans.set_reverse(true);
        trans.set_spread(0.5);
        trans.set_pitch(0.5); // octave down
        // ~density·grain_s ≈ 9 grains overlap, each ~the source amplitude, so
        // scale the pad sum down to keep it near unity (rough 1/overlap).
        trans.set_level(0.62);
        TransporterRig {
            wt,
            trans,
            limiter: Limiter::new(sample_rate),
            dry: Vec::new(),
            pad: Vec::new(),
            dry_mix: 0.4, // primary-playhead level; 0 = pad only
            progression: [
                [62, 65, 69, 72], // Dm7  (i)   D F B C - B natural = the Dorian signature
                [62, 67, 69, 74], // D?   (IV)  D G B C
                [57, 60, 64, 67], // Am7  (v)   A C E G — minor v (no leading tone)
                [62, 64, 67, 71], // Em7  (ii)  D E G B
            ],
            next: 0,
        }
    }

    /// Set the primary-playhead (dry) level in the mix. 0 = pad only.
    pub fn set_dry_mix(&mut self, m: f32) {
        self.dry_mix = m.max(0.0);
    }
}

impl Rig for TransporterRig {
    fn trigger(&mut self) -> &'static str {
        // release the held chord, advance to the next — long held notes that
        // change over time. WtSynth sustains, so the cloud always has material.
        self.wt.note_off_all();
        let chord = self.progression[self.next % self.progression.len()];
        self.next += 1;
        self.wt.play_chord(&chord, 0.7);
        "transporter pad (D Dorian wash)"
    }

    fn render(&mut self, out: &mut [f32]) {
        let frames = out.len() / 2;
        self.dry.resize(frames * 2, 0.0);
        self.pad.resize(frames * 2, 0.0);
        // 1. render the polyphonic held chord (mono sum) into a stereo dry buffer
        for i in 0..frames {
            let s = self.wt.tick();
            self.dry[2 * i] = s;
            self.dry[2 * i + 1] = s;
        }
        // 2. reverse-grain pad of the chord (parallel send: dry untouched)
        self.trans.process(&self.dry, &mut self.pad);
        // 3. primary playhead (dry chord) + the reverse pad
        for i in 0..frames * 2 {
            out[i] = self.dry[i] * self.dry_mix + self.pad[i];
        }
        self.limiter.process(out);
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
    wt: WtSynth,
    limiter: Limiter,
    fm_note: u8,
    bass_note: u8,
    wt_note: u8,
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
        let mut wt = WtSynth::new(sample_rate);
        wt.load_patch(WtPatch::default());
        PreviewRig {
            fm,
            delay,
            send: Vec::new(),
            wet: 0.6,
            bass,
            wt,
            limiter: Limiter::new(sample_rate),
            fm_note: DEFAULT_FM_NOTE,
            bass_note: DEFAULT_BASS_NOTE,
            wt_note: DEFAULT_WT_NOTE,
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
    pub fn set_wt_patch(&mut self, patch: WtPatch) {
        self.wt.load_patch(patch);
    }

    /// Kill all audio immediately: the held bass sustain, any FM tail, and the
    /// ping-pong feedback ring. Rebuilds every voice + the delay from scratch
    /// (the surest reset — no per-voice "panic" API needed), then re-applies the
    /// currently-loaded patches so the editor's state is preserved. A one-time
    /// allocation under the audio lock; fine for a manual stop on the dev host.
    pub fn silence(&mut self) {
        let fm_patch = *self.fm.patch();
        let bass_patch = *self.bass.patch();
        let wt_patch = self.wt.patch().clone();
        let sr = self.sample_rate;
        *self = PreviewRig::new(sr);
        self.fm.load_patch(fm_patch);
        self.bass.load_patch(bass_patch);
        self.wt.load_patch(wt_patch);
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
    /// Strike the wavetable voice. It sustains (held ADSR) until `/panic`,
    /// like the bass. `note` of `None` reuses the last note.
    pub fn trigger_wt(&mut self, note: Option<u8>) {
        if let Some(n) = note {
            self.wt_note = n;
        }
        self.wt.note_on(self.wt_note, 1.0);
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
            let w = self.wt.tick();
            out[2 * i] = s + b + w; // dry stab + bass + wavetable on both channels
            out[2 * i + 1] = s + b + w;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transporter_rig_renders_a_pad() {
        let sr = 48_000.0;
        let mut rig = TransporterRig::new(sr);
        rig.trigger();
        // ~1 s of audio in blocks; the cloud needs a beat to fill + establish.
        // Track the loudest block (the pad must sound at SOME point — the
        // source may decay, which the timed audition refreshes by re-trigger).
        let mut buf = vec![0.0f32; 1024];
        let mut peak_energy = 0.0f32;
        for _ in 0..48 {
            rig.render(&mut buf);
            assert!(buf.iter().all(|x| x.is_finite()), "no NaN/Inf");
            // a limiter, not a brickwall — allow brief attack overshoot, but
            // catch genuine runaway
            assert!(buf.iter().all(|x| x.abs() < 1.5), "stays roughly bounded");
            let e: f32 = buf.iter().map(|x| x * x).sum::<f32>() / buf.len() as f32;
            peak_energy = peak_energy.max(e);
        }
        assert!(
            peak_energy > 1e-4,
            "pad/source should be audible, peak {peak_energy}"
        );
    }
}
