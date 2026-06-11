//! Euclidean rhythm queries (Bjorklund-equivalent).
//!
//! Stateless: a hit is a pure function of `(step, pulses, steps, rotation)`,
//! so generators query the pattern per step instead of storing it. The
//! `(i * pulses) % steps < pulses` formulation distributes `pulses` onsets
//! maximally evenly over `steps` — the same necklace Bjorklund's algorithm
//! produces, anchored so step 0 always carries an onset (E(3,8) → x..x..x.,
//! the tresillo). `rotation` shifts the pattern later by that many steps.

/// Does the Euclidean pattern E(`pulses`, `steps`) rotated by `rotation`
/// fire on `step`? `step` may be any index (taken mod `steps`).
pub fn hit(step: usize, pulses: usize, steps: usize, rotation: usize) -> bool {
    if pulses == 0 || steps == 0 {
        return false;
    }
    if pulses >= steps {
        return true;
    }
    let i = (step + steps - (rotation % steps)) % steps;
    (i * pulses) % steps < pulses
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern(pulses: usize, steps: usize, rotation: usize) -> std::vec::Vec<bool> {
        (0..steps).map(|i| hit(i, pulses, steps, rotation)).collect()
    }

    #[test]
    fn onset_count_equals_pulses() {
        for steps in [8usize, 12, 16, 32] {
            for pulses in 0..=steps {
                let n = pattern(pulses, steps, 0).iter().filter(|&&h| h).count();
                assert_eq!(n, pulses, "E({pulses},{steps}) must have {pulses} onsets");
            }
        }
    }

    #[test]
    fn tresillo() {
        // E(3,8) is the canonical 3-3-2 tresillo.
        let p = pattern(3, 8, 0);
        assert_eq!(p, [true, false, false, true, false, false, true, false]);
    }

    #[test]
    fn four_on_the_floor() {
        // E(4,16) = a kick on every beat of a 16-step bar.
        let p = pattern(4, 16, 0);
        for (i, &h) in p.iter().enumerate() {
            assert_eq!(h, i % 4 == 0);
        }
    }

    #[test]
    fn rotation_shifts_later() {
        let base = pattern(3, 8, 0);
        let rot = pattern(3, 8, 2);
        for i in 0..8 {
            assert_eq!(rot[(i + 2) % 8], base[i]);
        }
    }

    #[test]
    fn degenerate_inputs_are_safe() {
        assert!(!hit(5, 0, 16, 0)); // no pulses → silent
        assert!(!hit(5, 3, 0, 0)); // zero-length pattern → silent
        assert!(hit(5, 16, 16, 0)); // saturated → every step
        assert!(hit(5, 20, 16, 3)); // over-saturated → every step
    }
}
