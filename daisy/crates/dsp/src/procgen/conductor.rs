//! The conductor — shared harmonic state on a bar clock.
//!
//! A weighted FSM over the seven diatonic chord functions, advanced every
//! `chord_period_bars` (from the genome's `harmonic_rate`). Two hand-authored
//! transition tables — CALM (tonic-orbiting, subdominant-leaning) and TENSE
//! (dominant-pulling) — are blended by the genome's `tension`, so the same
//! walk drifts darker as tension rises without a mode switch. Tables are
//! `const` (in flash); the per-bar cost is one weighted sample.

use super::{Genome, Pcg32};
use crate::chord::{Chord, Key, diatonic_triad};

/// Transition weights at rest: orbit the tonic, prefer iv / VI / III,
/// resolve home often. Row = current degree, col = next degree.
const CALM_T: [[f32; 7]; 7] = [
    //  i    ii°   III    iv     v    VI    VII
    [0.22, 0.02, 0.16, 0.22, 0.08, 0.22, 0.08], // from i
    [0.30, 0.05, 0.10, 0.10, 0.25, 0.10, 0.10], // from ii°
    [0.18, 0.04, 0.08, 0.22, 0.08, 0.30, 0.10], // from III
    [0.32, 0.04, 0.10, 0.10, 0.16, 0.22, 0.06], // from iv
    [0.40, 0.02, 0.08, 0.14, 0.06, 0.24, 0.06], // from v
    [0.20, 0.04, 0.26, 0.20, 0.10, 0.08, 0.12], // from VI
    [0.30, 0.04, 0.30, 0.08, 0.08, 0.14, 0.06], // from VII
];

/// Transition weights at full tension: pull toward v / ii° / VII, linger off
/// the tonic, resolve rarely and restlessly.
const TENSE_T: [[f32; 7]; 7] = [
    //  i    ii°   III    iv     v    VI    VII
    [0.06, 0.18, 0.08, 0.20, 0.26, 0.06, 0.16], // from i
    [0.10, 0.10, 0.06, 0.12, 0.40, 0.06, 0.16], // from ii°
    [0.06, 0.16, 0.08, 0.18, 0.24, 0.10, 0.18], // from III
    [0.10, 0.16, 0.06, 0.12, 0.34, 0.06, 0.16], // from iv
    [0.18, 0.12, 0.08, 0.18, 0.14, 0.10, 0.20], // from v
    [0.06, 0.14, 0.12, 0.18, 0.28, 0.06, 0.16], // from VI
    [0.14, 0.10, 0.16, 0.10, 0.26, 0.12, 0.12], // from VII
];

pub struct Conductor {
    /// Current chord root degree (0-based: 0 = i .. 6 = VII).
    degree: usize,
    /// Bars since the last chord change.
    bars_held: u32,
    /// Did the most recent `on_bar` change the chord?
    chord_changed: bool,
}

impl Conductor {
    pub fn new() -> Self {
        Self {
            degree: 0,
            bars_held: 0,
            chord_changed: false,
        }
    }

    pub fn reset(&mut self) {
        self.degree = 0;
        self.bars_held = 0;
        self.chord_changed = false;
    }

    /// Current chord root degree (0 = i .. 6 = VII).
    pub fn degree(&self) -> usize {
        self.degree
    }

    /// Place the walk on a degree (the seeded opening chord). Resets the
    /// hold counter so the full chord period plays from here.
    pub fn set_degree(&mut self, degree: usize) {
        self.degree = degree % 7;
        self.bars_held = 0;
        self.chord_changed = false;
    }

    /// Did the most recent bar boundary change the chord?
    pub fn chord_changed(&self) -> bool {
        self.chord_changed
    }

    /// The current chord as a diatonic triad in `key`.
    pub fn chord(&self, key: &Key, base_octave: i32) -> Chord {
        diatonic_triad(key, self.degree, base_octave)
    }

    /// How many bars each chord holds for, from the `harmonic_rate` gene
    /// (0 = glacial, every 8 bars; 1 = restless, every bar).
    pub fn chord_period_bars(genome: &Genome) -> u32 {
        let r = genome.harmonic_rate.clamp(0.0, 1.0);
        (8.0 - 7.0 * r + 0.5) as u32
    }

    /// Advance one bar. Samples the blended FSM when the hold period elapses.
    pub fn on_bar(&mut self, genome: &Genome, rng: &mut Pcg32) {
        self.bars_held += 1;
        self.chord_changed = false;
        if self.bars_held < Self::chord_period_bars(genome) {
            return;
        }
        self.bars_held = 0;

        let t = genome.tension.clamp(0.0, 1.0);
        let calm = &CALM_T[self.degree];
        let tense = &TENSE_T[self.degree];
        let mut weights = [0.0f32; 7];
        for i in 0..7 {
            weights[i] = (1.0 - t) * calm[i] + t * tense[i];
        }
        let next = rng.pick_weighted(&weights);
        self.chord_changed = next != self.degree;
        self.degree = next;
    }
}

impl Default for Conductor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chord_period_spans_8_to_1_bars() {
        let mut g = Genome::default();
        g.harmonic_rate = 0.0;
        assert_eq!(Conductor::chord_period_bars(&g), 8);
        g.harmonic_rate = 1.0;
        assert_eq!(Conductor::chord_period_bars(&g), 1);
    }

    #[test]
    fn holds_chord_for_the_declared_period() {
        let mut c = Conductor::new();
        let mut rng = Pcg32::new(7, 1);
        let mut g = Genome::default();
        g.harmonic_rate = 0.5; // period ≈ 5 bars
        let period = Conductor::chord_period_bars(&g);
        for bar in 1..(period * 3) {
            c.on_bar(&g, &mut rng);
            let at_boundary = bar % period == 0;
            if !at_boundary {
                assert!(!c.chord_changed(), "chord moved mid-period at bar {bar}");
            }
        }
    }

    #[test]
    fn tension_pulls_off_the_tonic() {
        // Statistical: at full tension the walk should sit on the tonic far
        // less than at rest. Long run so the assertion is robust.
        fn tonic_share(tension: f32) -> f32 {
            let mut c = Conductor::new();
            let mut rng = Pcg32::new(42, 9);
            let mut g = Genome::default();
            g.harmonic_rate = 1.0; // change every bar
            g.tension = tension;
            let mut on_tonic = 0u32;
            const BARS: u32 = 4000;
            for _ in 0..BARS {
                c.on_bar(&g, &mut rng);
                if c.degree() == 0 {
                    on_tonic += 1;
                }
            }
            on_tonic as f32 / BARS as f32
        }
        let calm = tonic_share(0.0);
        let tense = tonic_share(1.0);
        assert!(
            calm > tense + 0.1,
            "calm tonic share {calm:.3} should clearly exceed tense {tense:.3}"
        );
    }
}
