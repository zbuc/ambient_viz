//! Hybrid dimming: 16-bit linear light -> the SK9822's 5-bit global + 8-bit PWM.
//!
//! The SK9822 gives you two dimming mechanisms per LED:
//!
//! * an 8-bit PWM duty per channel, and
//! * a 5-bit **global** field (1..=31) that sets a constant CURRENT for the whole
//!   LED — all three channels share it.
//!
//! Using PWM alone wastes the part: a deep fade ends up crawling across the last
//! few of 256 codes and visibly stair-steps. Using both gives ~13 bits, because
//! each of the 31 current steps gets its own full 8-bit ramp.
//!
//! The global is per-LED, so it is chosen from the LED's PEAK channel: the
//! smallest current step that still leaves that peak inside the 8-bit PWM range.
//! Whatever rounding is left over is pushed into a temporal dither, which spreads
//! the residue across frames so the mean duty lands on the exact value.
//!
//! NOTE this is an SK9822 strategy, not an APA102 one. On a true APA102 the global
//! field is implemented as a ~580 Hz current PWM, so dimming with it puts a
//! low-frequency flicker on camera; there the received wisdom is to pin global at
//! 31 and dim in PWM only. The SK9822 uses a real current DAC, which is precisely
//! why it was chosen (cpldcpu, "SK9822 - a clone of the APA102?", 2016).

use crate::color::Rgb16;

/// The SK9822's global current field is 5 bits: 0 (off) .. 31 (full).
pub const GLOBAL_MAX: u32 = 31;
/// 8-bit PWM duty per channel.
pub const PWM_MAX: u32 = 255;

/// One LED's wire-level state: the 5-bit global current and three 8-bit PWM duties.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Led {
    pub global: u8,
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Led {
    pub const OFF: Self = Self {
        global: 0,
        r: 0,
        g: 0,
        b: 0,
    };

    /// PWM duty of channel `ch` (0=r, 1=g, 2=b).
    pub fn duty(&self, ch: usize) -> u8 {
        [self.r, self.g, self.b][ch]
    }

    /// Effective output of channel `ch` as a fraction of full scale — what the eye
    /// or a camera actually integrates: `(pwm/255) * (global/31)`.
    ///
    /// Only the tests and the host sim need this; the firmware never computes it.
    pub fn effective(&self, ch: usize) -> f64 {
        (self.duty(ch) as f64 / PWM_MAX as f64) * (self.global as f64 / GLOBAL_MAX as f64)
    }
}

/// Per-strip dimmer state. `N` is the strip length; the only thing carried between
/// frames is the temporal-dither residue, one byte per channel per LED.
pub struct Dimmer<const N: usize> {
    err: [[u8; 3]; N],
    dither: bool,
}

impl<const N: usize> Default for Dimmer<N> {
    fn default() -> Self {
        Self::new(true)
    }
}

impl<const N: usize> Dimmer<N> {
    pub const fn new(dither: bool) -> Self {
        Self {
            err: [[0; 3]; N],
            dither,
        }
    }

    /// Turn temporal dither off — useful on the bench to see the raw quantization.
    pub fn set_dither(&mut self, on: bool) {
        self.dither = on;
    }

    /// Map one frame of linear light to wire-level LED state.
    pub fn map(&mut self, px: &[Rgb16], out: &mut [Led]) {
        debug_assert_eq!(px.len(), out.len());
        debug_assert!(px.len() <= N);
        for (i, (p, o)) in px.iter().zip(out.iter_mut()).enumerate() {
            *o = self.map_one(i, *p);
        }
    }

    /// Map a single LED. `i` indexes the dither state, so a caller walking a strip
    /// must pass a stable per-LED index.
    pub fn map_one(&mut self, i: usize, px: Rgb16) -> Led {
        let peak = px.peak() as u32;
        if peak == 0 {
            // Global 0 is a true off: no current at all, so a dark strip draws
            // nothing. The residue is already zero, so there is nothing to carry.
            return Led::OFF;
        }

        // Smallest current step whose 8-bit ramp still contains the peak:
        //   pwm(c, g) = c * 255 * 31 / (65535 * g)  must be <= 255 for c = peak
        //   => g >= peak * 31 / 65535
        let global = (peak * GLOBAL_MAX)
            .div_ceil(u16::MAX as u32)
            .clamp(1, GLOBAL_MAX);
        let den = u16::MAX as u32 * global;

        let ch = [px.r, px.g, px.b];
        let mut duty = [0u8; 3];
        for k in 0..3 {
            let num = ch[k] as u32 * PWM_MAX * GLOBAL_MAX;
            let mut pwm = num / den;

            if self.dither {
                // The residue, as a 0..255 fraction of one PWM code, accumulated
                // across frames: once a whole code has piled up, spend it. The mean
                // duty then converges on the exact fractional value.
                let frac = ((num % den) * 256 / den) as u16;
                let acc = self.err[i][k] as u16 + frac;
                if acc >= 256 {
                    pwm += 1;
                    self.err[i][k] = (acc - 256) as u8;
                } else {
                    self.err[i][k] = acc as u8;
                }
            }

            duty[k] = pwm.min(PWM_MAX) as u8;
        }

        Led {
            global: global as u8,
            r: duty[0],
            g: duty[1],
            b: duty[2],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grey(v: u16) -> Rgb16 {
        Rgb16 { r: v, g: v, b: v }
    }

    #[test]
    fn full_scale_is_global_31_pwm_255() {
        let mut d: Dimmer<1> = Dimmer::new(false);
        let led = d.map_one(0, grey(65535));
        assert_eq!(
            led,
            Led {
                global: 31,
                r: 255,
                g: 255,
                b: 255
            }
        );
    }

    #[test]
    fn zero_is_fully_off() {
        let mut d: Dimmer<1> = Dimmer::new(false);
        assert_eq!(d.map_one(0, Rgb16::BLACK), Led::OFF);
    }

    #[test]
    fn the_bottom_1_31st_gets_the_whole_8_bit_ramp() {
        // This is the entire point of hybrid dimming: at the lowest current step,
        // 255 PWM codes span the bottom ~3% of the range instead of 8 codes.
        let mut d: Dimmer<1> = Dimmer::new(false);
        let low = d.map_one(0, grey(65535 / 31));
        assert_eq!(low.global, 1);
        assert!(
            low.r >= 250,
            "expected near-full PWM at the top of step 1, got {}",
            low.r
        );
    }

    #[test]
    fn effective_output_is_monotonic_and_accurate() {
        let mut d: Dimmer<1> = Dimmer::new(false);
        let mut prev = 0.0f64;
        for v in 0..=65535u16 {
            let led = d.map_one(0, grey(v));
            let eff = led.effective(0);
            assert!(
                eff >= prev - 1e-12,
                "output dipped at v={v}: {eff} < {prev}"
            );
            prev = eff;

            // Undithered error must stay inside one PWM code. Note a "code" is not a
            // fixed size: at current step g it is g/(255*31) of full scale, so codes
            // get coarser as the LED gets brighter — which is exactly right, since it
            // keeps the error CONSTANT relative to the signal (~1/255) all the way
            // down. Duty is truncated, not rounded, because the residue is what the
            // temporal dither spends; so the bound is one whole code, not half.
            let ideal = v as f64 / 65535.0;
            let code = led.global as f64 / (PWM_MAX as f64 * GLOBAL_MAX as f64);
            assert!(
                (eff - ideal).abs() <= code,
                "v={v}: effective {eff} vs ideal {ideal} exceeds one code ({code}) at global={}",
                led.global
            );
        }
    }

    #[test]
    fn global_steps_up_exactly_once_per_current_boundary() {
        let mut d: Dimmer<1> = Dimmer::new(false);
        let mut seen = 0u8;
        for v in 0..=65535u16 {
            let g = d.map_one(0, grey(v)).global;
            assert!(g >= seen, "global must not step back down at v={v}");
            seen = g;
        }
        assert_eq!(seen, 31);
    }

    #[test]
    fn dither_converges_on_the_exact_value() {
        // A level that is NOT representable in one frame: the dither has to spread
        // it across frames. Averaged, it should land far closer than one code.
        let mut d: Dimmer<1> = Dimmer::new(true);
        for v in [1u16, 7, 100, 1234, 20001, 40000] {
            let mut sum = 0.0f64;
            const FRAMES: usize = 512;
            for _ in 0..FRAMES {
                sum += d.map_one(0, grey(v)).effective(0);
            }
            let mean = sum / FRAMES as f64;
            let ideal = v as f64 / 65535.0;
            let code = 1.0 / (PWM_MAX as f64 * GLOBAL_MAX as f64);
            assert!(
                (mean - ideal).abs() < code * 0.25,
                "v={v}: dithered mean {mean} vs ideal {ideal} (one code = {code})"
            );
        }
    }

    #[test]
    fn dither_state_is_per_led_and_per_channel() {
        // Two LEDs at the same level must not share a residue accumulator, or the
        // whole strip would flicker in lockstep instead of averaging out.
        let mut d: Dimmer<2> = Dimmer::new(true);
        let px = Rgb16 {
            r: 1234,
            g: 5678,
            b: 9012,
        };
        let a = d.map_one(0, px);
        let b = d.map_one(1, px);
        assert_eq!(a, b, "first frame of two fresh LEDs must agree");
    }
}
