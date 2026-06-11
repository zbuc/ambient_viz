//! Rule-based bass generator — root-locked, predictable on purpose.
//!
//! The bass strikes the current chord root on the bar downbeat (and mid-bar
//! when `bass_activity` is high), holding each note for a step count derived
//! from the gene, so duration stays locked to the tempo like the grid
//! sequencer's hold cells. No randomness: the bass is the ensemble's anchor;
//! contour comes from the conductor's harmonic walk, not from this voice.

use super::{Genome, STEPS_PER_BAR};
use crate::sequencer::BassEvent;

pub struct BassGen {
    gate_open: bool,
    /// Absolute step at which the open gate releases.
    release_step: u32,
}

impl BassGen {
    pub fn new() -> Self {
        Self {
            gate_open: false,
            release_step: 0,
        }
    }

    pub fn reset(&mut self) {
        self.gate_open = false;
        self.release_step = 0;
    }

    /// Hold length in steps from the `note_length` gene (2 steps = a clipped
    /// half-beat at 16th resolution, up to 14 — just short of a full bar so
    /// releases breathe). Decoupled from `bass_activity` (strike rate) so
    /// "sparser but longer" is expressible.
    fn hold_steps(genome: &Genome) -> u32 {
        let nl = genome.note_length.clamp(0.0, 1.0);
        (2.0 + 12.0 * nl + 0.5) as u32
    }

    /// Advance one step. `abs_step` is the producer's global step counter,
    /// `root_note` the current chord root (pre-octave-offset MIDI, as for
    /// the grid sequencer's bass lane — the voice applies its own -12).
    pub fn on_step(&mut self, abs_step: u32, root_note: u8, genome: &Genome) -> BassEvent {
        let a = genome.bass_activity.clamp(0.0, 1.0);
        let sib = abs_step as usize % STEPS_PER_BAR;

        // Strike on the downbeat whenever the bass is audible at all; add a
        // mid-bar strike once activity passes the halfway mark.
        let strike = (a > 0.02 && sib == 0) || (a > 0.5 && sib == STEPS_PER_BAR / 2);
        if strike {
            self.gate_open = true;
            self.release_step = abs_step + Self::hold_steps(genome);
            return BassEvent::NoteOn {
                note: root_note,
                vel: 0.55 + 0.35 * a,
            };
        }
        if self.gate_open && abs_step >= self.release_step {
            self.gate_open = false;
            return BassEvent::NoteOff;
        }
        BassEvent::None
    }
}

impl Default for BassGen {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downbeat_strike_then_release_after_hold() {
        let mut b = BassGen::new();
        let g = Genome::default(); // note_length 0.5 → hold 8 steps; activity 0.4 → no mid-bar
        let hold = BassGen::hold_steps(&g);
        let mut events = std::vec::Vec::new();
        for s in 0..(STEPS_PER_BAR as u32 * 2) {
            events.push((s, b.on_step(s, 48, &g)));
        }
        assert!(matches!(events[0].1, BassEvent::NoteOn { note: 48, .. }));
        assert!(matches!(events[hold as usize].1, BassEvent::NoteOff));
        // Exactly one on and one off per bar at default activity.
        let ons = events
            .iter()
            .filter(|(_, e)| matches!(e, BassEvent::NoteOn { .. }))
            .count();
        assert_eq!(ons, 2, "one strike per bar over two bars");
    }

    #[test]
    fn high_activity_adds_midbar_strike() {
        let mut b = BassGen::new();
        let mut g = Genome::default();
        g.bass_activity = 0.9;
        let mut ons = 0;
        for s in 0..(STEPS_PER_BAR as u32) {
            if matches!(b.on_step(s, 50, &g), BassEvent::NoteOn { .. }) {
                ons += 1;
            }
        }
        assert_eq!(ons, 2, "downbeat + mid-bar at high activity");
    }

    #[test]
    fn zero_activity_is_silent() {
        let mut b = BassGen::new();
        let mut g = Genome::default();
        g.bass_activity = 0.0;
        for s in 0..(STEPS_PER_BAR as u32 * 4) {
            assert!(matches!(b.on_step(s, 48, &g), BassEvent::None));
        }
    }
}
