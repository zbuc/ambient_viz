//! Sliding-window RMS over mono samples — the one real analysis the
//! scaffold publishes (`audio.main.level`, same linear-RMS semantic as
//! the browser tap's time-domain level). The band/detector surfaces are
//! stage-1 work (AUDIO_ANALYSIS_SIDECAR.md).

pub struct BlockRms {
    window: Vec<f32>,
    next: usize,
    filled: usize,
    sum_sq: f64,
}

impl BlockRms {
    /// `window_len` in samples — 2048 at 48 kHz ≈ 43 ms, the browser
    /// analyser's time-domain window.
    pub fn new(window_len: usize) -> Self {
        BlockRms {
            window: vec![0.0; window_len.max(1)],
            next: 0,
            filled: 0,
            sum_sq: 0.0,
        }
    }

    pub fn push(&mut self, samples: &[f32]) {
        for &s in samples {
            let s = if s.is_finite() { s } else { 0.0 };
            let old = self.window[self.next] as f64;
            self.sum_sq += (s as f64) * (s as f64) - old * old;
            self.window[self.next] = s;
            self.next = (self.next + 1) % self.window.len();
            if self.filled < self.window.len() {
                self.filled += 1;
            }
        }
    }

    pub fn value(&self) -> f64 {
        if self.filled == 0 {
            return 0.0;
        }
        // Running-sum drift is bounded by re-summing occasionally; for a
        // 2k window the f64 error stays far below the 3-decimal publish
        // quantization, so the cheap version holds.
        (self.sum_sq.max(0.0) / self.filled as f64).sqrt()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_is_zero() {
        let mut r = BlockRms::new(2048);
        r.push(&[0.0; 4096]);
        assert_eq!(r.value(), 0.0);
    }

    #[test]
    fn full_scale_square_is_one() {
        let mut r = BlockRms::new(2048);
        let sq: Vec<f32> = (0..4096).map(|i| if i % 2 == 0 { 1.0 } else { -1.0 }).collect();
        r.push(&sq);
        assert!((r.value() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn sine_is_inv_sqrt2() {
        let mut r = BlockRms::new(4800);
        let sine: Vec<f32> = (0..9600)
            .map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 100.0 / 48000.0).sin())
            .collect();
        r.push(&sine);
        assert!((r.value() - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-3);
    }

    #[test]
    fn non_finite_samples_are_zeroed_not_poisonous() {
        let mut r = BlockRms::new(16);
        r.push(&[f32::NAN, 1.0, -1.0, f32::INFINITY]);
        assert!(r.value().is_finite());
    }
}
