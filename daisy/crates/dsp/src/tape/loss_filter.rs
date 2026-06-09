//! Tape loss filter — physical HF-rolloff model.
//!
//! Ported from CHOWTape's `LossFilter.cpp`. Frequency-domain magnitude is
//! the product of three physical loss terms:
//!
//! ```text
//!   H(f) = exp(-k · spacing)                       (spacing loss)
//!        × (1 - exp(-k · thickness)) / (k · thickness)   (thickness loss)
//!        × sinc(k · gap / 2)                        (gap loss)
//! ```
//!
//! where `k = 2π·f / (speed · 0.0254)` is the spatial wave number on the
//! tape (speed in inches/sec converted to m/s). All physical dimensions
//! are in micrometres; `f` is the audio frequency in Hz.
//!
//! Magnitudes are sampled at `order` frequency bins, IDFT'd by summation
//! into a symmetric (linear-phase) FIR, then convolved sample-by-sample.
//! The FIR doubles its delay buffer so the inner loop has no modulo —
//! at ~140 taps × 2 channels this is well under 5 % CPU on STM32H7.
//!
//! Latency: `order / 2` samples.
//!
//! **No crossfade on param change yet** — twisting a knob will click. The
//! CHOWTape original crossfades between two FIRs over 1024 samples; we'll
//! port that if needed.

use alloc::vec;
use alloc::vec::Vec;
use core::f32::consts::TAU;
use libm::cosf;

/// Schraudolph fast exp (~2-3% error), ample for shaping a loss-curve magnitude
/// and ~100x cheaper than libm `expf` on the Cortex-M7. Inputs here are <= 0;
/// very-negative inputs clamp to 0.
#[inline]
fn fast_exp(x: f32) -> f32 {
    let t = x * 12_102_203.0_f32 + 1_064_866_805.0_f32;
    if t < 1.0 {
        0.0
    } else {
        f32::from_bits(t as u32)
    }
}

/// Fast sin (~0.2% error) via the parabolic approximation, range-reduced to
/// [-PI, PI]. Replaces libm `sinf` in the per-bin magnitude loop.
#[inline]
fn fast_sin(x: f32) -> f32 {
    use core::f32::consts::PI;
    let n = (x * (1.0 / TAU) + 0.5) as i32;
    let a = x - TAU * n as f32; // [-PI, PI]
    let abs_a = if a < 0.0 { -a } else { a };
    let y = (4.0 / PI) * a - (4.0 / (PI * PI)) * a * abs_a;
    let abs_y = if y < 0.0 { -y } else { y };
    0.225 * (y * abs_y - y) + y
}

/// Base FIR order at 44.1 kHz. Scales linearly with sample rate at
/// construction (`order = BASE_ORDER · fs / 44100`).
const BASE_ORDER: usize = 128;
/// Floor on the per-bin frequency in the wave-number calc, so the DC bin
/// doesn't divide by zero in `sinc(k·gap/2)` / `(1-exp)/x`.
const MIN_FREQ_HZ: f32 = 20.0;
const UM_TO_M: f32 = 1.0e-6;
const IPS_TO_MPS: f32 = 0.0254;
/// Throttle the FIR rebuild to at most once per this many `process` blocks. A
/// sudden tape-failure change (e.g. a CC jump) makes `current_failure` smooth
/// over ~130 ms, which would otherwise re-derive the FIR on nearly every block;
/// the back-to-back ~0.4 ms rebuilds overrun the SAI. Spacing them keeps each
/// isolated (absorbed by the FIFO); the coefs lag the smoothing by <= this many
/// blocks (~5 ms — imperceptible).
const REBUILD_EVERY: u32 = 8;

pub struct LossFilter {
    fs: f32,
    order: usize,
    coefs: Vec<f32>,
    /// Doubled-length ring buffer: write to `delay[w]` and `delay[w + order]`
    /// so the convolution can read `delay[w + order - k]` without modulo.
    delay: Vec<f32>,
    write_idx: usize,
    /// `cos(2*PI*m/order)` for m in 0..order, built once. The IDFT in
    /// `recompute_coefs` is exactly these values, so a rebuild is O(order^2)
    /// table lookups (incremental index) instead of `cosf` calls — turning a
    /// ~25 ms rebuild into ~0.1 ms so tape failure can be swept live.
    cos_lut: Vec<f32>,
    /// Scratch for the frequency-domain magnitude, reused per rebuild (no alloc
    /// in the audio callback).
    h_mag: Vec<f32>,

    // Physical params (CHOWTape defaults: 30 IPS, 0.1 μm spacing/thick, 1 μm gap).
    speed_ips: f32,
    spacing_um: f32,
    thickness_um: f32,
    gap_um: f32,
    dirty: bool,
    blocks_since_rebuild: u32,
}

impl LossFilter {
    pub fn new(sample_rate: f32) -> Self {
        let order = (((BASE_ORDER as f32) * sample_rate / 44100.0) as usize).max(8);
        let cos_lut = {
            let mut t = vec![0.0f32; order];
            let step = TAU / order as f32;
            for (m, v) in t.iter_mut().enumerate() {
                *v = cosf(m as f32 * step);
            }
            t
        };
        let mut f = Self {
            fs: sample_rate,
            order,
            coefs: vec![0.0; order],
            delay: vec![0.0; order * 2],
            write_idx: 0,
            cos_lut,
            h_mag: vec![0.0; order],
            speed_ips: 30.0,
            spacing_um: 0.1,
            thickness_um: 0.1,
            gap_um: 1.0,
            dirty: true,
            blocks_since_rebuild: REBUILD_EVERY, // first runtime dirty rebuilds promptly
        };
        f.recompute_coefs();
        f
    }

    pub fn order(&self) -> usize {
        self.order
    }

    /// Tape speed in inches/sec. Range 1-50, default 30.
    pub fn set_speed_ips(&mut self, ips: f32) {
        self.speed_ips = ips.clamp(1.0, 50.0);
        self.dirty = true;
    }
    /// Head-to-tape spacing in micrometres. Range 0.1-20, default 0.1.
    pub fn set_spacing_um(&mut self, um: f32) {
        self.spacing_um = um.clamp(0.1, 20.0);
        self.dirty = true;
    }
    /// Tape coating thickness in micrometres. Range 0.1-50, default 0.1.
    pub fn set_thickness_um(&mut self, um: f32) {
        self.thickness_um = um.clamp(0.1, 50.0);
        self.dirty = true;
    }
    /// Playhead gap in micrometres. Range 1-50, default 1.
    pub fn set_gap_um(&mut self, um: f32) {
        self.gap_um = um.clamp(1.0, 50.0);
        self.dirty = true;
    }

    pub fn speed_ips(&self) -> f32 {
        self.speed_ips
    }

    /// Rebuild the FIR coefficient table from current physical parameters.
    fn recompute_coefs(&mut self) {
        let order = self.order;
        let bin_width = self.fs / order as f32;

        // Frequency-domain magnitude, length `order`. Real and symmetric:
        // h_mag[order-k-1] = h_mag[k], so we only fill the lower half.
        for k in 0..(order / 2) {
            let freq = ((k as f32) * bin_width).max(MIN_FREQ_HZ);
            let wave_number = TAU * freq / (self.speed_ips * IPS_TO_MPS);

            let spacing_loss = fast_exp(-wave_number * self.spacing_um * UM_TO_M);

            let thick_k = wave_number * self.thickness_um * UM_TO_M;
            let thickness_loss = if thick_k > 1.0e-6 {
                (1.0 - fast_exp(-thick_k)) / thick_k
            } else {
                1.0
            };

            let gap_over_two = wave_number * self.gap_um * UM_TO_M / 2.0;
            let gap_loss = if gap_over_two > 1.0e-6 {
                fast_sin(gap_over_two) / gap_over_two
            } else {
                1.0
            };

            let mag = spacing_loss * thickness_loss * gap_loss;
            self.h_mag[k] = mag;
            self.h_mag[order - k - 1] = mag;
        }

        // IDFT-by-summation into a symmetric (linear-phase) FIR. The cos term is
        // `cos(2*PI*(k*n)/order) = cos_lut[(k*n) % order]`; track `(k*n) % order`
        // incrementally (`idx += n`, wrap) so the inner loop is a LUT read + MAC,
        // no `cosf`. Fill [order/2, order) and mirror; index 0 stays zero.
        let inv_order = 1.0 / order as f32;
        for n in 0..(order / 2) {
            let mut acc = 0.0f32;
            let mut idx = 0usize; // (k*n) % order at k=0
            for k in 0..order {
                acc += self.h_mag[k] * self.cos_lut[idx];
                idx += n;
                if idx >= order {
                    idx -= order;
                }
            }
            let c = acc * inv_order;
            self.coefs[order / 2 + n] = c;
            self.coefs[order / 2 - n] = c;
        }

        self.dirty = false;
    }

    /// Convolve one mono buffer in place.
    pub fn process(&mut self, buf: &mut [f32]) {
        // Throttle rebuilds so a fast failure change can't re-derive the FIR on
        // every block (back-to-back rebuilds overrun the SAI). Each rebuild stays
        // isolated; coefs lag the smoothing by <= REBUILD_EVERY blocks.
        self.blocks_since_rebuild = self.blocks_since_rebuild.saturating_add(1);
        if self.dirty && self.blocks_since_rebuild >= REBUILD_EVERY {
            self.recompute_coefs(); // clears dirty
            self.blocks_since_rebuild = 0;
        }

        let order = self.order;
        for sample in buf.iter_mut() {
            // Write to both halves of the doubled ring so the read window
            // [write_idx+1 .. write_idx+order+1] is always contiguous.
            self.delay[self.write_idx] = *sample;
            self.delay[self.write_idx + order] = *sample;

            // y[n] = sum_k coefs[k] * x[n-k]
            //      = sum_k coefs[k] * delay[write_idx + order - k]
            let mut acc = 0.0f32;
            let base = self.write_idx + order;
            for k in 0..order {
                acc += self.coefs[k] * self.delay[base - k];
            }
            *sample = acc;

            self.write_idx += 1;
            if self.write_idx >= order {
                self.write_idx = 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::f32::consts::TAU;
    use libm::{cosf, sinf};

    const SR: f32 = 48_000.0;

    #[test]
    fn coefs_match_reference_idft() {
        // The optimized rebuild uses a precomputed cos LUT addressed by an
        // incremental (k*n) % order index. Verify the stored coefficients equal
        // a from-scratch reference IDFT of the SAME magnitude spectrum — this
        // isolates the indexing trick (the bug-prone part) from the fast_exp /
        // fast_sin magnitude approximations, which both sides share via h_mag.
        let f = LossFilter::new(SR); // recompute_coefs() ran inside new()
        let order = f.order;
        let step = TAU / order as f32;
        let inv_order = 1.0 / order as f32;
        for n in 0..(order / 2) {
            let mut acc = 0.0f32;
            for k in 0..order {
                let idx = (k * n) % order;
                acc += f.h_mag[k] * cosf(idx as f32 * step);
            }
            let expected = acc * inv_order;
            let got = f.coefs[order / 2 + n];
            assert!(
                (got - expected).abs() < 1e-4,
                "coef[{}] (n={n}): got {got}, reference {expected}",
                order / 2 + n
            );
        }
    }

    #[test]
    fn coefs_are_symmetric_and_finite() {
        let f = LossFilter::new(SR);
        let order = f.order;
        for &c in &f.coefs {
            assert!(c.is_finite(), "coef not finite: {c}");
        }
        // Linear-phase FIR: coefs mirror around the centre tap.
        for n in 1..(order / 2) {
            assert_eq!(
                f.coefs[order / 2 - n],
                f.coefs[order / 2 + n],
                "FIR must be symmetric at n={n}"
            );
        }
    }

    /// Drive a steady tone through the filter and return its post-filter RMS
    /// once the (throttled) rebuild has applied and the delay line has filled.
    fn settled_rms(f: &mut LossFilter, freq: f32) -> f32 {
        let block = 512usize;
        let mut idx = 0u64;
        let mut last = vec![0.0f32; block];
        for _ in 0..40 {
            let mut buf = vec![0.0f32; block];
            for (i, s) in buf.iter_mut().enumerate() {
                let t = (idx + i as u64) as f32 / SR;
                *s = sinf(TAU * freq * t);
            }
            f.process(&mut buf);
            last = buf;
            idx += block as u64;
        }
        (last.iter().map(|s| s * s).sum::<f32>() / last.len() as f32).sqrt()
    }

    #[test]
    fn more_loss_attenuates_highs_more() {
        // Pristine transport (fast speed, tight spacing) vs eaten (slow, wide):
        // the eaten filter must crush an 18 kHz tone far more than the pristine.
        let mut pristine = LossFilter::new(SR);
        pristine.set_speed_ips(30.0);
        pristine.set_spacing_um(0.1);
        let mut eaten = LossFilter::new(SR);
        eaten.set_speed_ips(1.5);
        eaten.set_spacing_um(18.0);

        let rms_pristine = settled_rms(&mut pristine, 18_000.0);
        let rms_eaten = settled_rms(&mut eaten, 18_000.0);
        assert!(
            rms_eaten < rms_pristine * 0.5,
            "eaten HF rms {rms_eaten} should be << pristine {rms_pristine}"
        );
    }
}
