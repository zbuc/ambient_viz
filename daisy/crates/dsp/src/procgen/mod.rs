//! Procedural `StepEvent` producer — the on-device half of PROCMUSIC.md.
//!
//! A conductor (chord-function FSM + density/tension on a bar clock) feeds
//! per-instrument generators: Euclidean kick/hats, a constrained-Markov
//! melody on the stab voice, and a root-locked bass. The whole thing emits
//! the same `StepEvent` stream as the grid [`crate::sequencer::Sequencer`],
//! so the voices (and any downstream `seq.*` consumer) never know which
//! producer is playing.
//!
//! The [`Genome`] holds the slow "intention" parameters the Pi will evolve
//! (PROCMUSIC.md §4 — one CC per gene in phase P2). In P1 it is set directly.
//!
//! Determinism contract: a fixed PRNG seed + a fixed genome trajectory +
//! a fixed tempo produce a byte-identical event stream — the dsp-side mirror
//! of the plugin host's REPLAYABLE rule. All randomness flows through the
//! owned [`Pcg32`]; nothing reads a clock.
//!
//! Real-time discipline: per-sample work is one phase accumulate; generators
//! run only on step boundaries (a few Hz – tens of Hz), where a `powf` or a
//! table sample is affordable. No allocation anywhere past construction.

pub mod bassgen;
pub mod conductor;
pub mod euclid;
pub mod markov;

use heapless::Vec;

use crate::chord::{Chord, Key, Mode};
use crate::sequencer::{StabHit, StepEvent};
use crate::timeline::{Keypoint, MAX_KEYPOINTS, bpm_at};
use bassgen::BassGen;
use conductor::Conductor;
use markov::MelodyGen;

/// Fixed 16th-note resolution in 4/4 — the procedural grid the generators
/// think in. (The grid sequencer's `res:` flexibility is a notation concern;
/// generators just need one resolution fine enough for fills.)
pub const STEPS_PER_BEAT: usize = 4;
pub const BEATS_PER_BAR: usize = 4;
pub const STEPS_PER_BAR: usize = STEPS_PER_BEAT * BEATS_PER_BAR;

/// Number of genes in [`Genome`] (= `to_array().len()`).
pub const GENE_COUNT: usize = 12;

/// The slow "intention" parameter set the mood layer / optimizer evolves
/// (PROCMUSIC.md §4, one CC per gene). All genes are 0..1; semantic ranges
/// live in the consumers so the wire format stays uniform. Serde derives so
/// mood-anchor JSON (`moods.v1`) deserializes straight into it on the host;
/// `#[serde(default)]` keeps old anchor files loading when genes are added.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Genome {
    /// Global busyness: melody fill and velocity floor.
    pub density: f32,
    /// Harmonic restlessness (CALM↔TENSE blend) + velocity spread.
    pub tension: f32,
    /// Euclidean kick pulses per bar (scaled).
    pub kick_fill: f32,
    /// Euclidean hat pulses per bar (scaled, closed + open).
    pub hat_fill: f32,
    /// Melody transition temperature (0 = greedy, 1 = drifty).
    pub markov_temp: f32,
    /// Stab tone center (dark/short ↔ bright/open).
    pub brightness: f32,
    /// Bass strike rate and hold length.
    pub bass_activity: f32,
    /// Chord change rate (0 = every 8 bars, 1 = every bar).
    pub harmonic_rate: f32,
    /// Melody octave center (0 → oct 3, 1 → oct 5).
    pub register: f32,
    /// Per-hit tone variance around `brightness`.
    pub stab_color: f32,
    /// Note durations: bass gate hold length (2–14 steps); the phrasing hook
    /// for melody durations later. Promoted out of `bass_activity` so
    /// "sparser but longer" is expressible (PROCMUSIC.md §4, CC 80).
    pub note_length: f32,
    /// Bass style axis: 0 = drone (pedal under the chord), 0.5 = pulse
    /// (downbeat anchor), 1 = stab (short Euclidean hits). Triangle weights;
    /// drawn per chord boundary (PROCMUSIC.md §4, CC 81).
    pub bass_style: f32,
}

impl Default for Genome {
    /// A slow, settled ambient default — audible motion on every voice
    /// without busyness. The P1 audition baseline.
    fn default() -> Self {
        Self {
            density: 0.45,
            tension: 0.25,
            kick_fill: 0.25,
            hat_fill: 0.4,
            markov_temp: 0.5,
            brightness: 0.5,
            bass_activity: 0.4,
            harmonic_rate: 0.25,
            register: 0.4,
            stab_color: 0.2,
            note_length: 0.5,
            bass_style: 0.5, // pure pulse — the historical anchor behavior
        }
    }
}

impl Genome {
    /// All genes clamped to 0..1 — the firmware-side half of the structural
    /// clamp (the other half is the optimizer mutating in bounded space).
    pub fn clamped(mut self) -> Self {
        for g in [
            &mut self.density,
            &mut self.tension,
            &mut self.kick_fill,
            &mut self.hat_fill,
            &mut self.markov_temp,
            &mut self.brightness,
            &mut self.bass_activity,
            &mut self.harmonic_rate,
            &mut self.register,
            &mut self.stab_color,
            &mut self.note_length,
            &mut self.bass_style,
        ] {
            *g = g.clamp(0.0, 1.0);
        }
        self
    }

    /// Genes as a fixed-order array — the blend/CC wire order (PROCMUSIC.md
    /// §4 table order). Keep `from_array`, the CC table, and `GENE_COUNT` in
    /// sync when adding genes.
    pub fn to_array(&self) -> [f32; GENE_COUNT] {
        [
            self.density,
            self.tension,
            self.kick_fill,
            self.hat_fill,
            self.markov_temp,
            self.brightness,
            self.bass_activity,
            self.harmonic_rate,
            self.register,
            self.stab_color,
            self.note_length,
            self.bass_style,
        ]
    }

    pub fn from_array(a: [f32; GENE_COUNT]) -> Self {
        Self {
            density: a[0],
            tension: a[1],
            kick_fill: a[2],
            hat_fill: a[3],
            markov_temp: a[4],
            brightness: a[5],
            bass_activity: a[6],
            harmonic_rate: a[7],
            register: a[8],
            stab_color: a[9],
            note_length: a[10],
            bass_style: a[11],
        }
    }
}

/// PCG32 (XSH-RR 64/32) — small, fast, good enough for musical choice, and
/// fully deterministic from `(seed, stream)`. No `rand` dependency: the
/// firmware build must control every byte of state for replayability.
pub struct Pcg32 {
    state: u64,
    inc: u64,
}

impl Pcg32 {
    pub fn new(seed: u64, stream: u64) -> Self {
        let mut rng = Self {
            state: 0,
            inc: (stream << 1) | 1,
        };
        rng.next_u32();
        rng.state = rng.state.wrapping_add(seed);
        rng.next_u32();
        rng
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old
            .wrapping_mul(6364136223846793005)
            .wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniform in [0, 1).
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }

    /// Sample an index proportionally to `weights` (need not be normalized;
    /// non-positive weights are never picked). All-zero weights → index 0.
    pub fn pick_weighted(&mut self, weights: &[f32]) -> usize {
        let total: f32 = weights.iter().filter(|w| w.is_sign_positive()).sum();
        if total <= 0.0 {
            return 0;
        }
        let mut x = self.next_f32() * total;
        for (i, &w) in weights.iter().enumerate() {
            if w <= 0.0 {
                continue;
            }
            if x < w {
                return i;
            }
            x -= w;
        }
        weights.len() - 1
    }
}

/// One of three chord voicings: 0 = as given (close position), 1 = first
/// inversion (root lifted an octave), 2 = spread (middle note lifted an
/// octave). Notes clamp at the MIDI ceiling rather than wrapping.
fn voice_variant(chord: Chord, variant: usize) -> Chord {
    let src = chord.notes();
    let mut notes = [0i32; 8];
    let n = src.len().min(8);
    for (d, &s) in notes.iter_mut().zip(src.iter()) {
        *d = s as i32;
    }
    match variant {
        1 if n >= 2 => notes[0] += 12,
        2 if n >= 3 => notes[1] += 12,
        _ => {}
    }
    Chord::from_notes(&notes[..n])
}

/// Which `StepEvent` producer the engine consults. Both stay constructed —
/// selection is a mode, not a rebuild — so a later timeline-driven switch
/// (PROCMUSIC.md §8, deferred) is a field write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ProducerSel {
    /// The grid sequencer playing `.pat` patterns (today's behavior).
    #[default]
    Grid,
    /// The procedural conductor + generators.
    Procgen,
}

pub struct ProcGen {
    sample_rate: f32,
    /// Elapsed seconds, wrapped at `loop_seconds` when a tempo curve is set
    /// (only the BPM lookup needs the wrap — bars accumulate monotonically).
    time_seconds: f32,
    loop_seconds: f32,
    bpm_keypoints: Vec<Keypoint, MAX_KEYPOINTS>,
    /// Tempo when no keypoints are loaded.
    fixed_bpm: f32,
    /// Fractional position within the current step, [0, 1). Starts at 1.0 so
    /// the very first sample fires step 0 (same convention as the sequencer).
    step_phase: f32,
    /// Global step counter (never wraps to a loop — procgen freeruns).
    step: u32,
    genome: Genome,
    key: Key,
    base_octave: i32,
    conductor: Conductor,
    melody: MelodyGen,
    bass: BassGen,
    rng: Pcg32,
    /// Per-bar Euclidean rotation for the melody gate (re-rolled each bar so
    /// the line breathes instead of looping).
    melody_rotation: usize,
    /// The seeded musical start (root pitch class, mode, opening degree) —
    /// telemetry for hosts to print/pin; `set_key` overrides the key without
    /// touching this record.
    start: (i32, Mode, usize),
    /// The currently-held (gated) chord and the step its gate releases.
    held_chord: Option<(Chord, u32)>,
    /// Gated melody notes awaiting release: (release_step, note).
    melody_offs: Vec<(u32, u8), 8>,
    enabled: bool,
}

impl ProcGen {
    pub fn new(sample_rate: f32, seed: u64) -> Self {
        let mut pg = Self {
            sample_rate,
            time_seconds: 0.0,
            loop_seconds: 0.0,
            bpm_keypoints: Vec::new(),
            fixed_bpm: 0.0,
            step_phase: 1.0,
            step: 0,
            genome: Genome::default(),
            key: Key::default(),
            base_octave: crate::chord::DEFAULT_OCTAVE,
            conductor: Conductor::new(),
            melody: MelodyGen::new(),
            bass: BassGen::new(),
            rng: Pcg32::new(seed, 0x6f7272657279), // stream: "orrery"
            melody_rotation: 0,
            start: (0, Mode::Aeolian, 0),
            held_chord: None,
            melody_offs: Vec::new(),
            enabled: false,
        };
        pg.seed_musical_start();
        pg
    }

    /// Draw the musical starting point from the PRNG — key root, mode, and
    /// opening chord degree — so different seeds start in different places
    /// instead of merely diverging later. FIXED draw order (mode, root,
    /// degree): it leads the stream and is part of the determinism contract.
    fn seed_musical_start(&mut self) {
        // Ambient-leaning mode palette; Ionian/Locrian excluded (too plain /
        // too unstable as a tonal home).
        const MODES: [Mode; 5] =
            [Mode::Aeolian, Mode::Dorian, Mode::Phrygian, Mode::Lydian, Mode::Mixolydian];
        const MODE_W: [f32; 5] = [0.30, 0.25, 0.15, 0.15, 0.15];
        let mode = MODES[self.rng.pick_weighted(&MODE_W)];
        let root_pc = (self.rng.next_u32() % 12) as i32;
        self.key = Key::new(root_pc, mode);

        // Opening chord: tonic favored, but not guaranteed — a piece may
        // open mid-thought. (ii/v lightly weighted: weak openings.)
        const DEGREE_W: [f32; 7] = [0.35, 0.05, 0.15, 0.15, 0.05, 0.15, 0.10];
        let degree = self.rng.pick_weighted(&DEGREE_W);
        self.conductor.set_degree(degree);
        self.melody.set_degree(degree);
        // ...and the phase within the first chord period, so the opening
        // chord's duration varies with the seed too (otherwise the first
        // change always lands at exactly `chord_period_bars`).
        self.conductor.seed_hold_fraction(self.rng.next_f32());
        self.start = (root_pc, mode, degree);
    }

    /// The seeded musical start: (root pitch class, mode, opening degree).
    /// Format the root with [`crate::chord::NOTE_NAMES`].
    pub fn musical_start(&self) -> (i32, Mode, usize) {
        self.start
    }

    /// Replace the genome (P2 routes the per-gene CCs here via `apply_param`).
    pub fn set_genome(&mut self, genome: Genome) {
        self.genome = genome.clamped();
    }
    pub fn genome(&self) -> &Genome {
        &self.genome
    }
    /// Mutate one gene in place (used by per-gene setters).
    pub fn genome_mut(&mut self) -> &mut Genome {
        &mut self.genome
    }

    /// Key + base octave for chords and melody (default C minor, octave 3).
    pub fn set_key(&mut self, key: Key, base_octave: i32) {
        self.key = key;
        self.base_octave = base_octave;
    }

    /// Run from a timeline tempo curve (the sequencer's contract). Enables.
    pub fn set_tempo(&mut self, keypoints: Vec<Keypoint, MAX_KEYPOINTS>, loop_seconds: f32) {
        self.bpm_keypoints = keypoints;
        self.loop_seconds = loop_seconds;
        self.enabled = true;
    }

    /// Run at a constant tempo with no timeline. Enables.
    pub fn set_fixed_bpm(&mut self, bpm: f32) {
        self.bpm_keypoints.clear();
        self.fixed_bpm = bpm.max(0.0);
        self.enabled = true;
    }

    pub fn enable(&mut self, enabled: bool) {
        self.enabled = enabled;
    }
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Re-seed the PRNG and restart musical state (for replay/golden runs).
    /// Redraws the seeded musical start from the new stream.
    pub fn reset(&mut self, seed: u64) {
        self.time_seconds = 0.0;
        self.step_phase = 1.0;
        self.step = 0;
        self.conductor.reset();
        self.melody.reset();
        self.bass.reset();
        self.rng = Pcg32::new(seed, 0x6f7272657279);
        self.melody_rotation = 0;
        self.held_chord = None;
        self.melody_offs.clear();
        self.seed_musical_start();
    }

    /// Next step index to fire (global, freerunning).
    pub fn step(&self) -> u32 {
        self.step
    }
    /// Completed bars since start.
    pub fn bar(&self) -> u32 {
        self.step / STEPS_PER_BAR as u32
    }
    /// Current chord (the conductor's degree voiced in the active key) —
    /// telemetry for tests now, the `MUS` CDC line in P4.
    pub fn current_chord(&self) -> Chord {
        self.conductor.chord(&self.key, self.base_octave)
    }
    /// Current chord root degree (0 = i .. 6 = VII).
    pub fn chord_degree(&self) -> usize {
        self.conductor.degree()
    }

    /// Advance one audio sample. Call exactly once per output sample.
    pub fn advance(&mut self) -> StepEvent {
        if !self.enabled {
            return StepEvent::default();
        }

        self.time_seconds += 1.0 / self.sample_rate;
        if self.loop_seconds > 0.0 && self.time_seconds >= self.loop_seconds {
            // Only the tempo-curve lookup wraps; bars keep accumulating.
            self.time_seconds -= self.loop_seconds;
        }

        let bpm = if self.bpm_keypoints.is_empty() {
            self.fixed_bpm
        } else {
            bpm_at(&self.bpm_keypoints, self.time_seconds)
        };
        let step_rate = (bpm / 60.0) * STEPS_PER_BEAT as f32;
        self.step_phase += step_rate / self.sample_rate;

        if self.step_phase < 1.0 {
            return StepEvent::default();
        }
        self.step_phase -= 1.0;
        let evt = self.on_step();
        self.step = self.step.wrapping_add(1);
        evt
    }

    /// One step's decisions. Runs at step rate (a few Hz – tens of Hz).
    fn on_step(&mut self) -> StepEvent {
        let step = self.step;
        let sib = step as usize % STEPS_PER_BAR;
        if sib == 0 {
            self.on_bar();
        }
        let g = self.genome;
        let mut evt = StepEvent::default();

        // Releases due this step — held chord and/or melody notes whose
        // drawn duration has elapsed. Gathered first so a release and a new
        // strike can share the step (the engine processes offs before ons).
        // The buffer is one Chord wide (MAX_CHORD); melody collection leaves
        // headroom for a chord release while a chord is held — uncollected
        // melody offs just wait a step (their tails are already ringing).
        let mut off_notes = [0i32; crate::chord::MAX_CHORD];
        let mut off_n = 0usize;
        if let Some((chord, at)) = self.held_chord {
            if step >= at {
                for &note in chord.notes() {
                    if off_n < off_notes.len() {
                        off_notes[off_n] = note as i32;
                        off_n += 1;
                    }
                }
                self.held_chord = None;
            }
        }
        let melody_cap = if self.held_chord.is_some() {
            off_notes.len() - crate::chord::MAX_CHORD / 2
        } else {
            off_notes.len()
        };
        self.melody_offs.retain(|&(at, note)| {
            if step >= at && off_n < melody_cap {
                off_notes[off_n] = note as i32;
                off_n += 1;
                false
            } else {
                true
            }
        });

        // Kick — Euclidean, thinned by density so an empty room can fall to
        // a heartbeat. Downbeat carries full weight.
        let kick_pulses = (g.kick_fill * 7.0 * (0.4 + 0.6 * g.density) + 0.5) as usize;
        if euclid::hit(sib, kick_pulses, STEPS_PER_BAR, 0) {
            evt.kick_velocity = Some(if sib == 0 { 1.0 } else { 0.6 + 0.2 * g.tension });
        }

        // Hats — closed carries the grid, open answers on a sparse rotation.
        let chat_pulses = (g.hat_fill * 12.0 + 0.5) as usize;
        evt.closed_hat = euclid::hit(sib, chat_pulses, STEPS_PER_BAR, 0);
        let ohat_pulses = (g.hat_fill * 3.0 + 0.5) as usize;
        evt.open_hat = euclid::hit(sib, ohat_pulses, STEPS_PER_BAR, 2);

        // Stab — chord-change downbeats voice the new chord whole; otherwise
        // the Markov melody fires on a per-bar-rotated Euclidean gate.
        let strong = sib % STEPS_PER_BEAT == 0;
        // Chord boundary: every harmonic move — and step 0, so the seeded
        // opening chord is treated like an arrival (chord strike, bass style
        // re-draw, drone re-strike).
        let chord_boundary = sib == 0 && (self.conductor.chord_changed() || step == 0);

        // Chord strikes: voiced with a drawn hold of their own (otherwise
        // the piece opens on bass+melody alone and the first drawn chord
        // duration only arrives at the first change).
        if chord_boundary {
            // Per-hit character, like the melody path: a drawn voicing
            // (root / first inversion / spread third), tone/velocity jitter,
            // and a GATED duration — the chord sustains for a drawn number
            // of steps (note_length-centered), then releases into the
            // patch's decay. Fixed draw order: voicing, tone, velocity, hold.
            let chord = voice_variant(
                self.current_chord(),
                self.rng.pick_weighted(&[0.5, 0.25, 0.25]),
            );
            let tone =
                (g.brightness + g.stab_color * (self.rng.next_f32() - 0.5)).clamp(0.0, 1.0);
            let vel = (0.5 + 0.3 * g.tension + 0.2 * (self.rng.next_f32() - 0.5))
                .clamp(0.05, 1.0);
            // A beat at minimum, up to ~2 bars; jittered ±30%.
            let base = 4.0 + 28.0 * g.note_length.clamp(0.0, 1.0);
            let hold = (base * (0.7 + 0.6 * self.rng.next_f32())).max(1.0) as u32;
            // A still-held previous chord releases right now, with this step's
            // other offs (its scheduled release would land after the new hit).
            if let Some((prev, _)) = self.held_chord.take() {
                for &note in prev.notes() {
                    if off_n < off_notes.len() {
                        off_notes[off_n] = note as i32;
                        off_n += 1;
                    }
                }
            }
            self.held_chord = Some((chord, step.wrapping_add(hold)));
            evt.stab = Some(StabHit {
                chord,
                velocity: vel,
                tone: Some(tone),
                gate: true,
            });
        } else {
            let mel_pulses = (g.density * 6.0 + 0.5) as usize;
            if euclid::hit(sib, mel_pulses, STEPS_PER_BAR, self.melody_rotation) {
                let note = self.melody.next_note(
                    &self.key,
                    self.conductor.degree(),
                    strong,
                    &g,
                    &mut self.rng,
                );
                let tone =
                    (g.brightness + g.stab_color * (self.rng.next_f32() - 0.5)).clamp(0.0, 1.0);
                let vel = (0.35 + 0.4 * g.density
                    + 0.25 * g.tension * (self.rng.next_f32() - 0.5))
                    .clamp(0.05, 1.0);
                // Gated melody: duration in steps (a 16th up to ~half a bar),
                // note_length-centered with per-note jitter. Draw order:
                // (markov draws), tone, velocity, hold.
                let base = 1.0 + 6.0 * g.note_length.clamp(0.0, 1.0);
                let hold = (base * (0.6 + 0.8 * self.rng.next_f32())).max(1.0) as u32;
                // Queue the release; if the queue is somehow full, release the
                // oldest pending note now rather than leaking a held voice.
                if self.melody_offs.push((step.wrapping_add(hold), note)).is_err() {
                    let (_, oldest) = self.melody_offs.swap_remove(0);
                    if off_n < off_notes.len() {
                        off_notes[off_n] = oldest as i32;
                        off_n += 1;
                    }
                    let _ = self.melody_offs.push((step.wrapping_add(hold), note));
                }
                evt.stab = Some(StabHit {
                    chord: Chord::from_notes(&[note as i32]),
                    velocity: vel,
                    tone: Some(tone),
                    gate: true,
                });
            }
        }

        if off_n > 0 {
            evt.stab_off = Some(Chord::from_notes(&off_notes[..off_n]));
        }

        // Bass — root-locked, style drawn per chord (drone/pulse/stab via
        // the bass_style gene). Draws after the stab branch: fixed order.
        let root = self
            .current_chord()
            .notes()
            .first()
            .copied()
            .unwrap_or(48);
        evt.bass = self
            .bass
            .on_step(step, root, &g, chord_boundary, &mut self.rng);

        evt
    }

    /// Bar boundary: advance the conductor, re-roll the melody gate rotation.
    fn on_bar(&mut self) {
        self.conductor.on_bar(&self.genome, &mut self.rng);
        self.melody_rotation = (self.rng.next_u32() as usize) % STEPS_PER_BAR;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chord::parse_key;
    use crate::sequencer::BassEvent;

    const SR: f32 = 48_000.0;
    const SEED: u64 = 0xC0FFEE;

    fn make(bpm: f32) -> ProcGen {
        let mut pg = ProcGen::new(SR, SEED);
        pg.set_fixed_bpm(bpm);
        pg
    }

    /// Drive `bars` bars and collect every non-empty event with its sample
    /// index. At 96 BPM a 16-step bar is 2.5 s.
    fn run(pg: &mut ProcGen, bars: u32, bpm: f32) -> std::vec::Vec<(u64, StepEvent)> {
        let secs = bars as f32 * STEPS_PER_BAR as f32 / ((bpm / 60.0) * STEPS_PER_BEAT as f32);
        let n = (secs * SR) as u64;
        let mut out = std::vec::Vec::new();
        for i in 0..n {
            let evt = pg.advance();
            let empty = evt.kick_velocity.is_none()
                && !evt.closed_hat
                && !evt.open_hat
                && evt.stab.is_none()
                && evt.stab_off.is_none()
                && evt.bass == BassEvent::None;
            if !empty {
                out.push((i, evt));
            }
        }
        out
    }

    /// FNV-1a over a canonical rendering of the event stream. Stable across
    /// runs/platforms (f32s quantized to 1e-4 before hashing).
    fn digest(events: &[(u64, StepEvent)]) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        let mut eat = |b: u64| {
            for byte in b.to_le_bytes() {
                h ^= byte as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
        };
        let q = |f: f32| (f * 10_000.0 + 0.5) as u64;
        for (i, e) in events {
            eat(*i);
            eat(e.kick_velocity.map(q).unwrap_or(u64::MAX));
            eat(e.closed_hat as u64 | (e.open_hat as u64) << 1);
            if let Some(s) = e.stab {
                for &n in s.chord.notes() {
                    eat(n as u64);
                }
                eat(q(s.velocity));
                eat(s.tone.map(q).unwrap_or(u64::MAX));
                eat(s.gate as u64);
            }
            if let Some(off) = e.stab_off {
                eat(0x0FF);
                for &n in off.notes() {
                    eat(n as u64);
                }
            }
            match e.bass {
                BassEvent::None => eat(0),
                BassEvent::NoteOn { note, vel } => {
                    eat(1);
                    eat(note as u64);
                    eat(q(vel));
                }
                BassEvent::NoteOff => eat(2),
            }
        }
        h
    }

    #[test]
    fn same_seed_same_stream() {
        let a = run(&mut make(96.0), 8, 96.0);
        let b = run(&mut make(96.0), 8, 96.0);
        assert_eq!(digest(&a), digest(&b), "fixed seed+genome must replay exactly");
        assert!(!a.is_empty());
    }

    #[test]
    fn different_seed_different_stream() {
        let a = run(&mut make(96.0), 8, 96.0);
        let mut pg = ProcGen::new(SR, SEED + 1);
        pg.set_fixed_bpm(96.0);
        let b = run(&mut pg, 8, 96.0);
        assert_ne!(digest(&a), digest(&b));
    }

    #[test]
    fn golden_trace() {
        // The committed fingerprint of (seed 0xC0FFEE, default genome,
        // 96 BPM, 8 bars). Any change to generator logic, RNG draw order,
        // or event shaping moves this value — bump it CONSCIOUSLY, with a
        // listen, because it is the audible output's identity.
        let events = run(&mut make(96.0), 8, 96.0);
        let d = digest(&events);
        // Bumped 2026-06-11 (×6): seeded musical start (key/mode/opening
        // degree), seeded opening-hold phase, per-hit chord character
        // (voicing/tone/velocity), gated durations (chord + melody holds
        // with note-offs), the opening chord struck at step 0 with a drawn
        // hold, then bass styles (drone/pulse/stab per chord via bass_style)
        // — intended audible changes.
        assert_eq!(
            d, 0x29e2f74972462b13,
            "golden digest mismatch — actual {d:#018x}"
        );
    }

    #[test]
    fn melody_stays_in_key() {
        // Every single-note stab (melody) lands on a scale pitch class.
        let key = parse_key("D dorian").unwrap();
        let mut pg = make(120.0);
        pg.set_key(key, 3);
        let scale_pcs: std::vec::Vec<i32> =
            (0..7).map(|d| (key.root_pc() + key.degree_semitones(d)) % 12).collect();
        let events = run(&mut pg, 32, 120.0);
        let mut melody_notes = 0;
        for (_, e) in &events {
            if let Some(s) = e.stab {
                if s.chord.notes().len() == 1 {
                    melody_notes += 1;
                    let pc = s.chord.notes()[0] as i32 % 12;
                    assert!(
                        scale_pcs.contains(&pc),
                        "melody note pc {pc} outside scale {scale_pcs:?}"
                    );
                }
            }
        }
        assert!(melody_notes > 20, "melody should actually fire ({melody_notes})");
    }

    #[test]
    fn strong_beats_are_chord_tones() {
        let mut pg = make(120.0);
        let events = run(&mut pg, 32, 120.0);
        // Recompute which step each event fired on from its sample index:
        // at fixed BPM, step i fires when phase crosses i. Simpler and exact:
        // replay a twin and interrogate it directly.
        let mut twin = make(120.0);
        let secs = 32.0 * STEPS_PER_BAR as f32 / ((120.0 / 60.0) * STEPS_PER_BEAT as f32);
        let mut checked = 0;
        for _ in 0..((secs * SR) as u64) {
            let evt = twin.advance();
            if let Some(s) = evt.stab {
                if s.chord.notes().len() == 1 {
                    // step() was incremented after firing → fired step is -1.
                    let fired = twin.step().wrapping_sub(1) as usize % STEPS_PER_BAR;
                    if fired % STEPS_PER_BEAT == 0 {
                        let note_pc = s.chord.notes()[0] as i32 % 12;
                        let chord_pcs: std::vec::Vec<i32> = twin
                            .current_chord()
                            .notes()
                            .iter()
                            .map(|&n| n as i32 % 12)
                            .collect();
                        assert!(
                            chord_pcs.contains(&note_pc),
                            "strong-beat melody pc {note_pc} not in chord {chord_pcs:?}"
                        );
                        checked += 1;
                    }
                }
            }
        }
        assert!(checked > 5, "expected strong-beat melody hits ({checked})");
        let _ = events;
    }

    #[test]
    fn melody_leaps_are_clamped() {
        let mut pg = make(120.0);
        let events = run(&mut pg, 64, 120.0);
        let notes: std::vec::Vec<i32> = events
            .iter()
            .filter_map(|(_, e)| e.stab)
            .filter(|s| s.chord.notes().len() == 1)
            .map(|s| s.chord.notes()[0] as i32)
            .collect();
        assert!(notes.len() > 40);
        for w in notes.windows(2) {
            let leap = (w[1] - w[0]).abs();
            assert!(leap <= markov::MAX_LEAP, "leap {leap} exceeds clamp");
        }
    }

    #[test]
    fn bass_strikes_the_chord_root() {
        let mut pg = make(120.0);
        let secs = 32.0 * STEPS_PER_BAR as f32 / ((120.0 / 60.0) * STEPS_PER_BEAT as f32);
        let mut strikes = 0;
        for _ in 0..((secs * SR) as u64) {
            let evt = pg.advance();
            if let BassEvent::NoteOn { note, .. } = evt.bass {
                assert_eq!(
                    note,
                    pg.current_chord().notes()[0],
                    "bass must strike the current chord root"
                );
                strikes += 1;
            }
        }
        assert!(strikes > 20);
    }

    #[test]
    fn density_zero_silences_the_melody_not_the_anchor() {
        let mut pg = make(120.0);
        let mut g = Genome::default();
        g.density = 0.0;
        pg.set_genome(g);
        let events = run(&mut pg, 16, 120.0);
        let melody = events
            .iter()
            .filter_map(|(_, e)| e.stab)
            .filter(|s| s.chord.notes().len() == 1)
            .count();
        assert_eq!(melody, 0, "zero density → no melody");
        let bass_ons = events
            .iter()
            .filter(|(_, e)| matches!(e.bass, BassEvent::NoteOn { .. }))
            .count();
        assert!(bass_ons > 0, "the bass anchor survives zero density");
    }

    #[test]
    fn disabled_is_silent() {
        let mut pg = make(120.0);
        pg.enable(false);
        for _ in 0..48_000 {
            let e = pg.advance();
            assert!(e.kick_velocity.is_none() && e.stab.is_none());
        }
    }

    #[test]
    fn seed_draws_the_musical_start() {
        // Same seed → same start; the start is reproducible telemetry.
        let a = ProcGen::new(SR, 7).musical_start();
        let b = ProcGen::new(SR, 7).musical_start();
        assert_eq!(a, b);
        // Across a handful of seeds the keys genuinely vary — the whole
        // point of seeding the start (no more "always C minor on i").
        let mut keys = std::collections::HashSet::new();
        let mut degrees = std::collections::HashSet::new();
        for seed in 0..16u64 {
            let (root, mode, degree) = ProcGen::new(SR, seed).musical_start();
            keys.insert((root, mode.name()));
            degrees.insert(degree);
        }
        assert!(keys.len() >= 6, "16 seeds gave only {} distinct keys", keys.len());
        assert!(degrees.len() >= 2, "opening degree never varies");
    }

    #[test]
    fn opening_chord_duration_varies_with_the_seed() {
        // Bar index of the first harmonic move, per seed. Pre-fix this was
        // always chord_period_bars (6 at the default genome).
        fn first_change_bar(seed: u64) -> u32 {
            let mut pg = ProcGen::new(SR, seed);
            pg.set_fixed_bpm(240.0); // fast: 16 steps/bar at 16 steps/s
            let start = pg.chord_degree();
            for _ in 0..(48_000 * 60) {
                pg.advance();
                if pg.chord_degree() != start {
                    return pg.bar();
                }
            }
            panic!("no chord change in 60 s");
        }
        let bars: std::collections::HashSet<u32> = (0..10u64).map(first_change_bar).collect();
        assert!(
            bars.len() >= 3,
            "10 seeds gave only {} distinct opening-chord durations: {bars:?}",
            bars.len()
        );
    }

    #[test]
    fn opening_chord_is_struck_with_a_seed_drawn_hold() {
        // The seeded opening chord must be voiced at step 0 (gated), and its
        // hold length must vary across seeds like any other chord hit.
        fn opening_hold(seed: u64) -> u32 {
            let mut pg = ProcGen::new(SR, seed);
            pg.set_fixed_bpm(240.0);
            let mut g = Genome::default();
            g.density = 0.0; // melody silent — chord offs are unambiguous
            pg.set_genome(g);
            let mut struck: Option<std::vec::Vec<u8>> = None;
            for _ in 0..(48_000 * 60) {
                let evt = pg.advance();
                let fired = pg.step().wrapping_sub(1);
                if let Some(s) = evt.stab {
                    assert!(struck.is_some() || fired == 0, "first strike must be step 0");
                    if struck.is_none() {
                        assert!(s.gate && s.chord.notes().len() >= 3, "opening chord gated triad");
                        struck = Some(s.chord.notes().to_vec());
                    }
                }
                if let (Some(notes), Some(off)) = (&struck, evt.stab_off) {
                    if off.notes().iter().any(|n| notes.contains(n)) {
                        return fired;
                    }
                }
            }
            panic!("opening chord never released");
        }
        let holds: std::collections::HashSet<u32> = (0..8u64).map(opening_hold).collect();
        assert!(
            holds.len() >= 3,
            "8 seeds gave only {} distinct opening-chord holds: {holds:?}",
            holds.len()
        );
    }

    #[test]
    fn note_durations_follow_note_length_and_vary_per_note() {
        // Mean steps between a melody note-on and its note-off must track the
        // note_length gene, and individual durations must vary (per-note draw).
        fn durations(note_length: f32) -> std::vec::Vec<u32> {
            let mut pg = make(240.0);
            let mut g = Genome::default();
            g.note_length = note_length;
            pg.set_genome(g);
            let mut on_step: std::collections::HashMap<u8, u32> = Default::default();
            let mut durs = std::vec::Vec::new();
            let secs = 64.0 * STEPS_PER_BAR as f32 / ((240.0 / 60.0) * STEPS_PER_BEAT as f32);
            for _ in 0..((secs * SR) as u64) {
                let evt = pg.advance();
                let fired = pg.step().wrapping_sub(1);
                if let Some(s) = evt.stab {
                    if s.chord.notes().len() == 1 {
                        on_step.insert(s.chord.notes()[0], fired);
                    }
                }
                if let Some(off) = evt.stab_off {
                    for &n in off.notes() {
                        if let Some(on) = on_step.remove(&n) {
                            durs.push(fired.wrapping_sub(on));
                        }
                    }
                }
            }
            durs
        }
        let short = durations(0.05);
        let long = durations(0.95);
        assert!(short.len() > 20 && long.len() > 20, "need offs to compare");
        let mean = |v: &[u32]| v.iter().sum::<u32>() as f32 / v.len() as f32;
        assert!(
            mean(&long) > mean(&short) * 2.0,
            "long note_length ({}) must dwarf short ({})",
            mean(&long),
            mean(&short)
        );
        let distinct: std::collections::HashSet<u32> = long.iter().copied().collect();
        assert!(distinct.len() >= 3, "per-note duration draw never varies");
    }

    #[test]
    fn held_chord_releases_and_yields_to_the_next() {
        let mut pg = make(240.0);
        let mut g = Genome::default();
        g.harmonic_rate = 1.0; // chord per bar → strikes outlive holds
        g.density = 0.0; // melody silent: only chord ons/offs in the stream
        pg.set_genome(g);
        let secs = 32.0 * STEPS_PER_BAR as f32 / ((240.0 / 60.0) * STEPS_PER_BEAT as f32);
        let (mut ons, mut off_notes) = (0u32, 0u32);
        let mut held: std::collections::HashSet<u8> = Default::default();
        for _ in 0..((secs * SR) as u64) {
            let evt = pg.advance();
            if let Some(off) = evt.stab_off {
                for &n in off.notes() {
                    assert!(held.remove(&n), "release of a note that isn't held ({n})");
                    off_notes += 1;
                }
            }
            if let Some(s) = evt.stab {
                assert!(s.gate, "procgen chord hits are gated");
                ons += 1;
                for &n in s.chord.notes() {
                    held.insert(n);
                }
            }
        }
        assert!(ons > 10, "expected many chord strikes ({ons})");
        assert!(off_notes > 0, "gated chords must release");
        assert!(held.len() <= 6, "held set stays bounded (no leaked gates)");
    }

    #[test]
    fn chord_hits_vary_in_voicing_tone_and_velocity() {
        let mut pg = make(240.0);
        let mut g = Genome::default();
        g.harmonic_rate = 1.0; // chord moves every bar → many chord hits
        pg.set_genome(g);
        let events = run(&mut pg, 64, 240.0);
        let chords: std::vec::Vec<StabHit> = events
            .iter()
            .filter_map(|(_, e)| e.stab)
            .filter(|s| s.chord.notes().len() >= 3)
            .collect();
        assert!(chords.len() > 10, "expected many chord hits ({})", chords.len());
        let tones: std::collections::HashSet<u32> =
            chords.iter().map(|s| (s.tone.unwrap() * 1000.0) as u32).collect();
        let vels: std::collections::HashSet<u32> =
            chords.iter().map(|s| (s.velocity * 1000.0) as u32).collect();
        let voicings: std::collections::HashSet<std::vec::Vec<u8>> =
            chords.iter().map(|s| s.chord.notes().to_vec()).collect();
        assert!(tones.len() > 3, "chord tones never vary ({} distinct)", tones.len());
        assert!(vels.len() > 3, "chord velocities never vary ({} distinct)", vels.len());
        assert!(
            voicings.len() > chords.iter().map(|s| s.chord.notes()[0] % 12).collect::<std::collections::HashSet<_>>().len(),
            "voicing variants never appear (every degree always voiced identically)"
        );
    }

    #[test]
    fn genome_array_roundtrip_covers_every_gene() {
        let g = Genome::default();
        assert_eq!(Genome::from_array(g.to_array()), g);
        // A distinct value per slot proves order + coverage.
        let mut a = [0.0f32; GENE_COUNT];
        for (i, v) in a.iter_mut().enumerate() {
            *v = i as f32 / GENE_COUNT as f32;
        }
        assert_eq!(Genome::from_array(a).to_array(), a);
    }

    #[test]
    fn genome_deserializes_from_anchor_json_with_defaults() {
        // Partial JSON (an old anchor file) fills missing genes from Default.
        let g: Genome = serde_json_core::from_str::<Genome>(
            r#"{"density":0.7,"note_length":0.9}"#,
        )
        .unwrap()
        .0;
        assert_eq!(g.density, 0.7);
        assert_eq!(g.note_length, 0.9);
        assert_eq!(g.tension, Genome::default().tension);
    }

    #[test]
    fn genome_is_clamped_on_set() {
        let mut pg = make(120.0);
        let mut g = Genome::default();
        g.density = 7.5;
        g.tension = -2.0;
        pg.set_genome(g);
        assert_eq!(pg.genome().density, 1.0);
        assert_eq!(pg.genome().tension, 0.0);
    }
}
