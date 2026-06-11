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

/// Max motif length (in notes) the recall mechanism stores per phrase.
pub const MOTIF_MAX: usize = 8;

pub struct MelodyGen {
    /// Current scale degree (0-based, 0..7).
    degree: usize,
    /// Last emitted MIDI note, or -1 before the first note.
    last_note: i32,
    /// Motif memory: the first [`MOTIF_MAX`] degrees emitted in a recorded
    /// phrase. Markov gives contour but no long-term structure; replaying a
    /// stored motif at later phrases (snapped to the then-current harmony)
    /// is what makes the line thematic instead of a perpetual wander.
    motif: [u8; MOTIF_MAX],
    motif_len: usize,
    /// `Some(i)` = replaying `motif[i..]` instead of drawing from the chain.
    replay_idx: Option<usize>,
    /// Capturing the current phrase into `motif` (replay phrases never
    /// record, so a finished replay doesn't mutate the stored theme).
    recording: bool,
}

impl MelodyGen {
    pub fn new() -> Self {
        Self {
            degree: 0,
            last_note: -1,
            motif: [0; MOTIF_MAX],
            motif_len: 0,
            replay_idx: None,
            recording: false,
        }
    }

    pub fn reset(&mut self) {
        self.degree = 0;
        self.last_note = -1;
        self.motif_len = 0;
        self.replay_idx = None;
        self.recording = false;
    }

    /// Is a motif replay currently in progress? (test/telemetry)
    pub fn replaying(&self) -> bool {
        self.replay_idx.is_some()
    }

    /// Phrase boundary: with probability `recall`, replay the stored motif
    /// through this phrase; otherwise record this phrase as the new motif.
    /// Draws exactly once (fixed stream shape regardless of outcome).
    pub fn on_phrase(&mut self, recall: f32, rng: &mut Pcg32) {
        let roll = rng.next_f32();
        if self.motif_len >= 3 && roll < recall.clamp(0.0, 1.0) {
            self.replay_idx = Some(0);
            self.recording = false;
        } else {
            self.replay_idx = None;
            self.motif_len = 0; // record afresh
            self.recording = true;
        }
    }

    pub fn degree(&self) -> usize {
        self.degree
    }

    /// Place the chain on a degree (the seeded start) without a note history.
    pub fn set_degree(&mut self, degree: usize) {
        self.degree = degree % 7;
        self.last_note = -1;
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
        // 1. Degree: replay the stored motif when active, else a Markov step
        //    with temperature. Replayed degrees still pass the harmony
        //    constraints below, so the theme adapts to the current chord.
        let mut degree = match self.replay_idx {
            Some(i) if i < self.motif_len => {
                self.replay_idx = Some(i + 1);
                if i + 1 >= self.motif_len {
                    self.replay_idx = None; // motif done — back to the chain
                }
                self.motif[i] as usize
            }
            _ => {
                self.replay_idx = None;
                let tau = 0.35 + 1.3 * genome.markov_temp.clamp(0.0, 1.0);
                let row = &MELODY_T[self.degree % 7];
                let mut weights = [0.0f32; 7];
                for (w, &p) in weights.iter_mut().zip(row.iter()) {
                    *w = powf(p, 1.0 / tau);
                }
                rng.pick_weighted(&weights)
            }
        };

        // 2. Chord-tone snap on strong beats.
        if strong && !is_chord_tone(degree, chord_degree) {
            degree = nearest_chord_tone(degree, chord_degree);
        }
        self.degree = degree;

        // Record the emitted (post-snap) degree into the motif while a fresh
        // phrase is being captured (replay phrases never record).
        if self.recording && self.motif_len < MOTIF_MAX {
            self.motif[self.motif_len] = degree as u8;
            self.motif_len += 1;
        }

        // 3. Octave placement: scan the degree's placements around the
        //    register center AND around the previous note; keep the placement
        //    closest to the previous note (leap clamp) with a mild pull
        //    toward the center. Including the octave nearest the anchor
        //    guarantees a candidate ≤ 6 semitones away (placements are 12
        //    apart), so the clamp filter never empties; min-leap stands by
        //    as the paranoid fallback.
        let center_octave = 3 + (genome.register.clamp(0.0, 1.0) * 2.0 + 0.5) as i32; // 3..=5
        let off = key.root_pc() + key.degree_semitones(degree);
        let center = (center_octave + 1) * 12 + off;
        let anchor = if self.last_note < 0 { center } else { self.last_note };
        // cand(oct) = (oct + 1) * 12 + off → the octave whose placement is
        // nearest the anchor:
        let oct_near = (((anchor - off) as f32) / 12.0 + 0.5) as i32 - 1;

        let mut best = center;
        let mut best_cost = f32::MAX;
        let mut nearest = center;
        let mut nearest_leap = i32::MAX;
        let lo = (center_octave - 2).min(oct_near - 1);
        let hi = (center_octave + 2).max(oct_near + 1);
        for oct in lo..=hi {
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
