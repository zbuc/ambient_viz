//! Constrained-Markov melody generator over scale degrees.
//!
//! A first-order chain over the 7 diatonic degrees picks *what degree* comes
//! next; a constraint pass then decides *which octave placement* plays it:
//! chord-tone snapping on strong beats, a leap clamp, and a pull toward the
//! genome's register center. The transition table favors stepwise motion —
//! the chain supplies contour, the constraints supply harmony. (Order-2 over
//! `(prev, cur)` is the documented upgrade if contours feel too local; the
//! table grows to 49×7 and nothing else changes.)
//!
//! Temperature: weights are raised to `1/τ` before sampling. τ < 1 sharpens
//! toward the likeliest transition (greedy), τ > 1 flattens toward uniform.
//! `powf` runs at note rate (a few Hz), never per sample.

use libm::powf;

use super::{Genome, Pcg32};
use crate::chord::Key;

/// Melody transition weights, row = current degree, col = next degree.
/// Hand-authored to favor seconds, allow thirds, and discourage (not forbid)
/// larger degree jumps; rows need not be normalized — the sampler normalizes.
const MELODY_T: [[f32; 7]; 7] = [
    //  1     2     3     4     5     6     7
    [0.10, 0.30, 0.18, 0.08, 0.12, 0.08, 0.30], // from 1
    [0.30, 0.08, 0.30, 0.15, 0.06, 0.04, 0.12], // from 2
    [0.15, 0.28, 0.08, 0.28, 0.12, 0.05, 0.04], // from 3
    [0.10, 0.10, 0.28, 0.08, 0.30, 0.10, 0.04], // from 4
    [0.18, 0.04, 0.10, 0.26, 0.08, 0.26, 0.08], // from 5
    [0.08, 0.05, 0.06, 0.10, 0.30, 0.08, 0.28], // from 6
    [0.35, 0.10, 0.04, 0.04, 0.10, 0.25, 0.08], // from 7 (leading → 1)
];

/// Maximum melodic leap in semitones after the constraint pass.
pub const MAX_LEAP: i32 = 7;

/// Is `degree` a chord tone of the triad rooted on `chord_degree`
/// (root / third / fifth, i.e. chord_degree + {0, 2, 4} mod 7)?
pub fn is_chord_tone(degree: usize, chord_degree: usize) -> bool {
    matches!((degree + 7 - chord_degree % 7) % 7, 0 | 2 | 4)
}

/// The chord-tone degree nearest to `degree` (circular distance over the 7
/// degrees; ties resolve to the lower chord member, i.e. toward the root).
pub fn nearest_chord_tone(degree: usize, chord_degree: usize) -> usize {
    let mut best = chord_degree % 7;
    let mut best_d = 8;
    for off in [0usize, 2, 4] {
        let cand = (chord_degree + off) % 7;
        let d = degree.abs_diff(cand);
        let circ = d.min(7 - d);
        if circ < best_d {
            best_d = circ;
            best = cand;
        }
    }
    best
}

pub struct MelodyGen {
    /// Current scale degree (0-based, 0..7).
    degree: usize,
    /// Last emitted MIDI note, or -1 before the first note.
    last_note: i32,
}

impl MelodyGen {
    pub fn new() -> Self {
        Self {
            degree: 0,
            last_note: -1,
        }
    }

    pub fn reset(&mut self) {
        self.degree = 0;
        self.last_note = -1;
    }

    pub fn degree(&self) -> usize {
        self.degree
    }

    /// Pick the next melody note. `chord_degree` is the conductor's current
    /// chord root degree; `strong` marks a beat boundary (chord-tone snap).
    pub fn next_note(
        &mut self,
        key: &Key,
        chord_degree: usize,
        strong: bool,
        genome: &Genome,
        rng: &mut Pcg32,
    ) -> u8 {
        // 1. Markov step with temperature.
        let tau = 0.35 + 1.3 * genome.markov_temp.clamp(0.0, 1.0);
        let row = &MELODY_T[self.degree % 7];
        let mut weights = [0.0f32; 7];
        for (w, &p) in weights.iter_mut().zip(row.iter()) {
            *w = powf(p, 1.0 / tau);
        }
        let mut degree = rng.pick_weighted(&weights);

        // 2. Chord-tone snap on strong beats.
        if strong && !is_chord_tone(degree, chord_degree) {
            degree = nearest_chord_tone(degree, chord_degree);
        }
        self.degree = degree;

        // 3. Octave placement: try the degree in five octaves around the
        //    register center; keep the placement closest to the previous note
        //    (leap clamp) with a mild pull toward the center. The ±2-octave
        //    scan always contains the lattice point nearest any previous note
        //    the scan itself could have produced (placements are 12 apart →
        //    nearest is ≤ 6 semitones < MAX_LEAP), so the clamp filter never
        //    empties; min-leap stands by as the paranoid fallback.
        let center_octave = 3 + (genome.register.clamp(0.0, 1.0) * 2.0 + 0.5) as i32; // 3..=5
        let center = (center_octave + 1) * 12 + key.root_pc() + key.degree_semitones(degree);
        let anchor = if self.last_note < 0 { center } else { self.last_note };

        let mut best = center;
        let mut best_cost = f32::MAX;
        let mut nearest = center;
        let mut nearest_leap = i32::MAX;
        for oct in (center_octave - 2)..=(center_octave + 2) {
            let cand = (oct + 1) * 12 + key.root_pc() + key.degree_semitones(degree);
            if !(0..=127).contains(&cand) {
                continue;
            }
            let leap = (cand - anchor).abs();
            if leap < nearest_leap {
                nearest_leap = leap;
                nearest = cand;
            }
            if self.last_note >= 0 && leap > MAX_LEAP {
                continue;
            }
            let cost = leap as f32 + 0.3 * (cand - center).abs() as f32;
            if cost < best_cost {
                best_cost = cost;
                best = cand;
            }
        }
        if best_cost == f32::MAX {
            best = nearest;
        }
        let note = best.clamp(0, 127);
        self.last_note = note;
        note as u8
    }
}

impl Default for MelodyGen {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chord_tone_membership() {
        // Triad on degree 0 (i) = degrees {0, 2, 4}.
        assert!(is_chord_tone(0, 0));
        assert!(is_chord_tone(2, 0));
        assert!(is_chord_tone(4, 0));
        assert!(!is_chord_tone(1, 0));
        assert!(!is_chord_tone(3, 0));
        // Triad on degree 4 (v) = degrees {4, 6, 1}.
        assert!(is_chord_tone(6, 4));
        assert!(is_chord_tone(1, 4));
        assert!(!is_chord_tone(0, 4));
    }

    #[test]
    fn nearest_chord_tone_is_a_chord_tone_and_close() {
        for chord in 0..7 {
            for d in 0..7 {
                let s = nearest_chord_tone(d, chord);
                assert!(is_chord_tone(s, chord));
                let dist = d.abs_diff(s);
                assert!(dist.min(7 - dist) <= 1, "snap moved more than one degree");
            }
        }
    }
}
