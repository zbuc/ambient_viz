//! Rule-based bass generator — root-locked, with mood-selectable styles.
//!
//! Pitch is always the current chord root (the bass is the ensemble's
//! anchor; contour comes from the conductor's harmonic walk). *How* the root
//! is played is the `bass_style` gene, mapped to triangle weights over three
//! archetypes and drawn once per chord boundary so the style is coherent
//! within a chord:
//!
//! - **Drone** (gene → 0): strike on chord changes only and hold until the
//!   next — a pedal tone under the whole chord period.
//! - **Pulse** (gene ≈ 0.5): the classic anchor — bar-downbeat strikes (plus
//!   a mid-bar strike at high activity), held per `note_length` with a small
//!   per-strike jitter.
//! - **Stab** (gene → 1): short Euclidean hits, count scaled by
//!   `bass_activity`, rotation drawn per chord; quick releases.

use super::{Genome, Pcg32, STEPS_PER_BAR, euclid};
use crate::sequencer::BassEvent;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BassStyle {
    Drone,
    Pulse,
    Stab,
}

pub struct BassGen {
    gate_open: bool,
    /// Absolute step at which the open gate releases (Pulse/Stab only —
    /// a Drone holds until the next chord or silence).
    release_step: u32,
    style: BassStyle,
    /// Euclidean rotation for Stab, drawn per chord.
    stab_rotation: usize,
}

impl BassGen {
    pub fn new() -> Self {
        Self {
            gate_open: false,
            release_step: 0,
            style: BassStyle::Pulse,
            stab_rotation: 0,
        }
    }

    pub fn reset(&mut self) {
        self.gate_open = false;
        self.release_step = 0;
        self.style = BassStyle::Pulse;
        self.stab_rotation = 0;
    }

    pub fn style(&self) -> BassStyle {
        self.style
    }

    /// Triangle weights over the style axis: 0 = pure Drone, 0.5 = pure
    /// Pulse (the historical behavior), 1 = pure Stab. Between anchors the
    /// mood blend lands between styles → a probabilistic mix per chord.
    fn choose_style(gene: f32, rng: &mut Pcg32) -> BassStyle {
        let s = gene.clamp(0.0, 1.0);
        let weights = [
            (1.0 - 2.0 * s).max(0.0),
            1.0 - (2.0 * s - 1.0).abs(),
            (2.0 * s - 1.0).max(0.0),
        ];
        match rng.pick_weighted(&weights) {
            0 => BassStyle::Drone,
            1 => BassStyle::Pulse,
            _ => BassStyle::Stab,
        }
    }

    /// Pulse hold length in steps from `note_length` (2 ≈ a clipped
    /// half-beat at 16th resolution, up to 14 — just short of a bar).
    fn hold_steps(genome: &Genome) -> u32 {
        let nl = genome.note_length.clamp(0.0, 1.0);
        (2.0 + 12.0 * nl + 0.5) as u32
    }

    /// Advance one step. `chord_boundary` marks a bar-0/chord-change step
    /// (where styles re-draw and drones re-strike); `root_note` is the
    /// current chord root. Draw order per call is fixed: (boundary: style,
    /// stab rotation), then per-Pulse-strike hold jitter.
    pub fn on_step(
        &mut self,
        abs_step: u32,
        root_note: u8,
        genome: &Genome,
        chord_boundary: bool,
        rng: &mut Pcg32,
    ) -> BassEvent {
        let a = genome.bass_activity.clamp(0.0, 1.0);
        let sib = abs_step as usize % STEPS_PER_BAR;

        if chord_boundary {
            self.style = Self::choose_style(genome.bass_style, rng);
            self.stab_rotation = (rng.next_u32() as usize) % STEPS_PER_BAR;
        }

        // Silence: an open gate (drone included) releases once.
        if a <= 0.02 {
            if self.gate_open {
                self.gate_open = false;
                return BassEvent::NoteOff;
            }
            return BassEvent::None;
        }

        match self.style {
            BassStyle::Drone => {
                if chord_boundary {
                    // Legato pedal: the mono voice re-strikes on the new
                    // root; no note-off between chords.
                    self.gate_open = true;
                    return BassEvent::NoteOn {
                        note: root_note,
                        vel: 0.5 + 0.3 * a,
                    };
                }
            }
            BassStyle::Pulse => {
                let strike = sib == 0 || (a > 0.5 && sib == STEPS_PER_BAR / 2);
                if strike {
                    let jitter = 0.75 + 0.5 * rng.next_f32();
                    let hold = ((Self::hold_steps(genome) as f32 * jitter) as u32).max(1);
                    self.gate_open = true;
                    self.release_step = abs_step.wrapping_add(hold);
                    return BassEvent::NoteOn {
                        note: root_note,
                        vel: 0.55 + 0.35 * a,
                    };
                }
            }
            BassStyle::Stab => {
                let pulses = (2.0 + 8.0 * a + 0.5) as usize; // 2..=10 per bar
                if euclid::hit(sib, pulses, STEPS_PER_BAR, self.stab_rotation) {
                    // Short and tight: a 16th to a few steps via note_length.
                    let hold = (1.0 + 2.0 * genome.note_length.clamp(0.0, 1.0)) as u32;
                    self.gate_open = true;
                    self.release_step = abs_step.wrapping_add(hold.max(1));
                    return BassEvent::NoteOn {
                        note: root_note,
                        vel: if sib == 0 { 0.9 } else { 0.5 + 0.3 * a },
                    };
                }
            }
        }

        if self.gate_open && self.style != BassStyle::Drone && abs_step >= self.release_step {
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

    /// Drive one bar-aligned run; chord boundaries every `chord_bars` bars.
    fn events(
        style_gene: f32,
        activity: f32,
        bars: u32,
        chord_bars: u32,
        seed: u64,
    ) -> std::vec::Vec<(u32, BassEvent)> {
        let mut b = BassGen::new();
        let mut rng = Pcg32::new(seed, 1);
        let mut g = Genome::default();
        g.bass_style = style_gene;
        g.bass_activity = activity;
        let mut out = std::vec::Vec::new();
        for s in 0..(bars * STEPS_PER_BAR as u32) {
            let boundary = s as usize % (chord_bars as usize * STEPS_PER_BAR) == 0;
            out.push((s, b.on_step(s, 48, &g, boundary, &mut rng)));
        }
        out
    }

    fn ons(ev: &[(u32, BassEvent)]) -> usize {
        ev.iter().filter(|(_, e)| matches!(e, BassEvent::NoteOn { .. })).count()
    }
    fn offs(ev: &[(u32, BassEvent)]) -> usize {
        ev.iter().filter(|(_, e)| matches!(e, BassEvent::NoteOff)).count()
    }

    #[test]
    fn pure_pulse_strikes_each_bar_and_releases() {
        // Gene 0.5 = deterministic Pulse (triangle weight 1).
        let ev = events(0.5, 0.4, 8, 2, 7);
        assert_eq!(ons(&ev), 8, "one strike per bar at moderate activity");
        assert!(offs(&ev) >= 7, "pulse notes release");
        // High activity adds the mid-bar strike.
        let busy = events(0.5, 0.9, 8, 2, 7);
        assert_eq!(ons(&busy), 16, "downbeat + mid-bar at high activity");
    }

    #[test]
    fn pure_drone_strikes_per_chord_and_never_releases() {
        let ev = events(0.0, 0.6, 12, 3, 7);
        assert_eq!(ons(&ev), 4, "one strike per chord (12 bars / 3-bar chords)");
        assert_eq!(offs(&ev), 0, "a drone holds through the chord");
    }

    #[test]
    fn pure_stab_fires_short_euclidean_hits() {
        let ev = events(1.0, 0.8, 8, 2, 7);
        let n_ons = ons(&ev);
        // 2 + 8*0.8 ≈ 8 pulses per bar over 8 bars.
        assert!(n_ons > 40, "stab style should fire many hits ({n_ons})");
        // Short: every on is followed by an off within a few steps.
        let mut last_on: Option<u32> = None;
        for (s, e) in &ev {
            match e {
                BassEvent::NoteOn { .. } => last_on = Some(*s),
                BassEvent::NoteOff => {
                    let held = s - last_on.expect("off before any on");
                    assert!(held <= 4, "stab holds stay short ({held} steps)");
                }
                BassEvent::None => {}
            }
        }
    }

    #[test]
    fn mid_gene_mixes_styles_across_chords() {
        // Gene 0.75 = pulse/stab mix: across many chords both should occur.
        let mut b = BassGen::new();
        let mut rng = Pcg32::new(11, 1);
        let mut g = Genome::default();
        g.bass_style = 0.75;
        let mut seen = std::collections::HashSet::new();
        for chord in 0..24u32 {
            b.on_step(chord * STEPS_PER_BAR as u32, 48, &g, true, &mut rng);
            seen.insert(b.style());
        }
        assert!(seen.len() >= 2, "a mid-axis gene should mix styles ({seen:?})");
    }

    #[test]
    fn zero_activity_is_silent_and_releases_a_drone() {
        let mut b = BassGen::new();
        let mut rng = Pcg32::new(7, 1);
        let mut g = Genome::default();
        g.bass_style = 0.0;
        g.bass_activity = 0.6;
        // Start a drone…
        assert!(matches!(b.on_step(0, 48, &g, true, &mut rng), BassEvent::NoteOn { .. }));
        // …then the room empties: exactly one release, then silence.
        g.bass_activity = 0.0;
        assert!(matches!(b.on_step(1, 48, &g, false, &mut rng), BassEvent::NoteOff));
        for s in 2..64 {
            assert!(matches!(b.on_step(s, 48, &g, false, &mut rng), BassEvent::None));
        }
    }
}
