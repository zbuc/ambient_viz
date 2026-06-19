//! Control-rate LFOs that modulate **effect CCs**.
//!
//! A [`CcLfo`] targets a MIDI CC number and oscillates its *value* (0..127)
//! between two endpoints at a rate. The rig ticks its LFOs once per render
//! block and feeds each `(cc, value)` back through the rig's normal
//! `handle_cc`, so the LFO endpoints are expressed in the same CC units you
//! dial on the controller ("CC#22 sin between 77 and 92") and inherit the
//! existing CC→param scaling for free. Any rig (or, later, the control
//! plane) can hold a `Vec<CcLfo>` and modulate any CC-mapped knob this way.

use std::f32::consts::TAU;

#[derive(Clone, Copy, Debug)]
pub enum Waveform {
    Sine,
    Triangle,
    Saw,
    Square,
}

impl Waveform {
    /// Shape at `phase` (0..1) -> 0..1.
    fn at(self, phase: f32) -> f32 {
        match self {
            Waveform::Sine => 0.5 + 0.5 * (TAU * phase).sin(),
            Waveform::Triangle => 1.0 - (2.0 * phase - 1.0).abs(),
            Waveform::Saw => phase,
            Waveform::Square => {
                if phase < 0.5 {
                    1.0
                } else {
                    0.0
                }
            }
        }
    }
}

/// An LFO bound to one CC, sweeping its value between `lo` and `hi`
/// (CC units, 0..127) at `rate_hz`.
#[derive(Clone, Debug)]
pub struct CcLfo {
    pub cc: u8,
    pub lo: f32,
    pub hi: f32,
    pub rate_hz: f32,
    pub wave: Waveform,
    phase: f32,
}

impl CcLfo {
    pub fn new(cc: u8, lo: f32, hi: f32, rate_hz: f32, wave: Waveform) -> Self {
        CcLfo { cc, lo, hi, rate_hz, wave, phase: 0.0 }
    }

    /// A sine LFO (the common case).
    pub fn sine(cc: u8, lo: f32, hi: f32, rate_hz: f32) -> Self {
        Self::new(cc, lo, hi, rate_hz, Waveform::Sine)
    }

    /// Advance `dt` seconds and return `(cc, value)` to apply — the CC value
    /// rounded into 0..127.
    pub fn tick(&mut self, dt: f32) -> (u8, u8) {
        self.phase = (self.phase + self.rate_hz * dt).rem_euclid(1.0);
        let v = self.lo + self.wave.at(self.phase) * (self.hi - self.lo);
        (self.cc, v.round().clamp(0.0, 127.0) as u8)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sine_lfo_stays_in_endpoints_and_advances() {
        let mut lfo = CcLfo::sine(22, 77.0, 92.0, 1.0); // 1 Hz
        let dt = 1.0 / 64.0; // 64 steps/cycle
        let (mut lo, mut hi) = (127u8, 0u8);
        let mut seen_motion = false;
        let mut last = None;
        for _ in 0..64 {
            let (cc, v) = lfo.tick(dt);
            assert_eq!(cc, 22);
            assert!((77..=92).contains(&v), "value {v} within endpoints");
            lo = lo.min(v);
            hi = hi.max(v);
            if let Some(p) = last {
                if p != v {
                    seen_motion = true;
                }
            }
            last = Some(v);
        }
        assert!(seen_motion, "LFO should move over a cycle");
        assert!(lo <= 78 && hi >= 91, "sweeps most of the range ({lo}..{hi})");
    }

    #[test]
    fn waveforms_bounded_0_1() {
        for w in [Waveform::Sine, Waveform::Triangle, Waveform::Saw, Waveform::Square] {
            for k in 0..=100 {
                let s = w.at(k as f32 / 100.0);
                assert!((0.0..=1.0).contains(&s), "{w:?} at phase out of [0,1]: {s}");
            }
        }
    }
}
