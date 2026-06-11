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
pub const GENE_COUNT: usize = 11;

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
        if sib == 0 && self.conductor.chord_changed() {
            evt.stab = Some(StabHit {
                chord: self.current_chord(),
                velocity: 0.5 + 0.3 * g.tension,
                tone: Some(g.brightness),
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
                evt.stab = Some(StabHit {
                    chord: Chord::from_notes(&[note as i32]),
                    velocity: vel,
                    tone: Some(tone),
                });
            }
        }

        // Bass — root-locked anchor on the current chord.
        let root = self
            .current_chord()
            .notes()
            .first()
            .copied()
            .unwrap_or(48);
        evt.bass = self.bass.on_step(step, root, &g);

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
        // Bumped 2026-06-11 (×2): seeded musical start (key/mode/opening
        // degree), then seeded opening-hold phase — intended audible changes.
        assert_eq!(
            d, 0x0433c3d46972a6ed,
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
