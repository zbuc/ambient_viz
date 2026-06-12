//! The filterbank detector surface (AUDIO_ANALYSIS_SIDECAR.md stage 1,
//! Path A of the research): per-band biquad bandpass → attack/release
//! envelope follower. Time-domain, a few multiply-adds per sample per
//! band, reacts within samples — the low-latency half of the design;
//! spectral flux (stage 2) arrives only where these bands confuse targets.
//!
//! The follower is the dasp_envelope algorithm (peak-rectified one-pole
//! with separate attack/release) implemented directly — ten lines didn't
//! justify the dependency. The biquad is the RBJ cookbook constant-0dB-
//! peak bandpass.
//!
//! Band edges and attack/release pairs are PROJECT DATA hand-tuned
//! against the piece (design doc, open question 2); the constants below
//! are the starting points from the research conversation.

/// The research starting points — PROJECT DATA in waiting (hand-tune
/// against the piece via the trace harness, tools/tuning/, then move to
/// the project manifest). Public so the trace meta restates exactly what
/// ran.
pub mod defaults {
    pub const KICK_BAND: (f64, f64) = (40.0, 120.0);
    pub const KICK_AR: (f64, f64) = (0.005, 0.120);
    pub const PAD_BAND: (f64, f64) = (200.0, 800.0);
    pub const PAD_AR: (f64, f64) = (0.250, 0.800);
    pub const LEAD_BAND: (f64, f64) = (2000.0, 6000.0);
    pub const LEAD_AR: (f64, f64) = (0.030, 0.250);
    pub const ONSET_BASELINE_TAU_S: f64 = 1.5;
    pub const ONSET_THRESHOLD: f64 = 0.06;
    pub const ONSET_COOLDOWN_S: f64 = 0.150;
}

/// Onset-gate knobs (the most-tuned constants get CLI overrides before
/// they get manifest entries).
#[derive(Debug, Clone, Copy)]
pub struct OnsetParams {
    pub baseline_tau_s: f64,
    pub threshold: f64,
    pub cooldown_s: f64,
}

impl Default for OnsetParams {
    fn default() -> Self {
        OnsetParams {
            baseline_tau_s: defaults::ONSET_BASELINE_TAU_S,
            threshold: defaults::ONSET_THRESHOLD,
            cooldown_s: defaults::ONSET_COOLDOWN_S,
        }
    }
}

/// RBJ cookbook bandpass (constant 0 dB peak gain).
pub struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Biquad {
    /// Band from edges: f0 = √(lo·hi), Q = f0 / (hi − lo).
    pub fn bandpass(lo_hz: f64, hi_hz: f64, sample_rate: f64) -> Self {
        let f0 = (lo_hz * hi_hz).sqrt();
        let q = f0 / (hi_hz - lo_hz);
        let w0 = 2.0 * std::f64::consts::PI * f0 / sample_rate;
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Biquad {
            b0: alpha / a0,
            b1: 0.0,
            b2: -alpha / a0,
            a1: -2.0 * w0.cos() / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    #[inline]
    pub fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// Peak-rectified one-pole follower with separate attack/release taus.
pub struct EnvelopeFollower {
    attack: f64,  // per-sample coefficient
    release: f64, // per-sample coefficient
    env: f64,
}

fn coeff(tau_s: f64, sample_rate: f64) -> f64 {
    1.0 - (-1.0 / (tau_s * sample_rate)).exp()
}

impl EnvelopeFollower {
    pub fn new(attack_s: f64, release_s: f64, sample_rate: f64) -> Self {
        EnvelopeFollower {
            attack: coeff(attack_s, sample_rate),
            release: coeff(release_s, sample_rate),
            env: 0.0,
        }
    }

    #[inline]
    pub fn process(&mut self, x: f64) -> f64 {
        let r = x.abs();
        let a = if r > self.env { self.attack } else { self.release };
        self.env += a * (r - self.env);
        self.env
    }

    pub fn value(&self) -> f64 {
        self.env
    }
}

/// Kick onset: envelope deviation above a slow adaptive baseline (the
/// same shape as the page's bassDev/bassOnset), guarded two ways so one
/// hit fires exactly once: a refractory cooldown AND hysteresis re-arm —
/// after a fire the gate stays down until the deviation falls back under
/// half the threshold (a cooldown alone re-fires on the envelope's
/// release tail, found by the burst test).
pub struct OnsetGate {
    baseline_coeff: f64,
    baseline: f64,
    threshold: f64,
    cooldown_samples: u64,
    until: u64, // refractory: no fire before this sample index
    armed: bool,
}

impl OnsetGate {
    pub fn new(baseline_tau_s: f64, threshold: f64, cooldown_s: f64, sample_rate: f64) -> Self {
        OnsetGate {
            baseline_coeff: coeff(baseline_tau_s, sample_rate),
            baseline: 0.0,
            threshold,
            cooldown_samples: (cooldown_s * sample_rate) as u64,
            until: 0,
            armed: true,
        }
    }

    /// Returns the fire strength when the gate trips at this sample.
    #[inline]
    pub fn process(&mut self, env: f64, t_samples: u64) -> Option<f64> {
        let dev = env - self.baseline;
        self.baseline += self.baseline_coeff * (env - self.baseline);
        if !self.armed {
            if dev < self.threshold * 0.5 {
                self.armed = true;
            }
            return None;
        }
        if dev > self.threshold && t_samples >= self.until {
            self.until = t_samples + self.cooldown_samples;
            self.armed = false;
            Some((dev / (self.threshold * 4.0)).clamp(0.0, 1.0))
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct DetectorOut {
    pub kick: f64,
    pub pad: f64,
    pub lead: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OnsetFire {
    pub strength: f64,
}

/// One detector chain: a CASCADE of two identical biquads (4th-order —
/// a single biquad's 12 dB/oct skirts leak too much neighbor-band energy
/// into the envelopes, found by the cross-band test) feeding a follower.
struct Chain {
    bpf1: Biquad,
    bpf2: Biquad,
    env: EnvelopeFollower,
}

impl Chain {
    fn new(lo: f64, hi: f64, attack_s: f64, release_s: f64, sr: f64) -> Self {
        Chain {
            bpf1: Biquad::bandpass(lo, hi, sr),
            bpf2: Biquad::bandpass(lo, hi, sr),
            env: EnvelopeFollower::new(attack_s, release_s, sr),
        }
    }

    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        self.env.process(self.bpf2.process(self.bpf1.process(x)))
    }
}

pub struct DetectorBank {
    kick: Chain,
    pad: Chain,
    lead: Chain,
    onset: OnsetGate,
    t_samples: u64,
}

impl DetectorBank {
    #[allow(dead_code)] // default-params constructor: the tests' entry point
    pub fn new(sample_rate: f64) -> Self {
        Self::with_onset(sample_rate, OnsetParams::default())
    }

    pub fn with_onset(sample_rate: f64, onset: OnsetParams) -> Self {
        use defaults::*;
        DetectorBank {
            // kick: low-band transient — fast attack, medium release
            kick: Chain::new(KICK_BAND.0, KICK_BAND.1, KICK_AR.0, KICK_AR.1, sample_rate),
            // pad: mid-band swell — slow both ways
            pad: Chain::new(PAD_BAND.0, PAD_BAND.1, PAD_AR.0, PAD_AR.1, sample_rate),
            // lead: upper-mid presence — medium both ways
            lead: Chain::new(LEAD_BAND.0, LEAD_BAND.1, LEAD_AR.0, LEAD_AR.1, sample_rate),
            onset: OnsetGate::new(onset.baseline_tau_s, onset.threshold, onset.cooldown_s, sample_rate),
            t_samples: 0,
        }
    }

    /// The onset gate's adaptive baseline — the trace harness plots
    /// kick − baseline against the threshold, which is what tuning is.
    pub fn kick_baseline(&self) -> f64 {
        self.onset.baseline
    }

    /// Run a mono block through every chain; envelopes update per sample,
    /// onset fires are collected (at 50 ms publish granularity, only the
    /// fire itself matters, not its sub-block offset).
    pub fn process(&mut self, mono: &[f32], fires: &mut Vec<OnsetFire>) -> DetectorOut {
        for &s in mono {
            let x = if s.is_finite() { s as f64 } else { 0.0 };
            let k = self.kick.process(x);
            self.pad.process(x);
            self.lead.process(x);
            if let Some(strength) = self.onset.process(k, self.t_samples) {
                fires.push(OnsetFire { strength });
            }
            self.t_samples += 1;
        }
        DetectorOut {
            kick: self.kick.env.value().clamp(0.0, 1.0),
            pad: self.pad.env.value().clamp(0.0, 1.0),
            lead: self.lead.env.value().clamp(0.0, 1.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48000.0;

    fn sine(freq: f64, n: usize, amp: f64) -> Vec<f32> {
        (0..n)
            .map(|i| (amp * (2.0 * std::f64::consts::PI * freq * i as f64 / SR).sin()) as f32)
            .collect()
    }

    fn rms(v: &[f64]) -> f64 {
        (v.iter().map(|x| x * x).sum::<f64>() / v.len() as f64).sqrt()
    }

    #[test]
    fn bandpass_passes_center_attenuates_far() {
        let mut bpf = Biquad::bandpass(40.0, 120.0, SR);
        let in_band: Vec<f64> = sine(69.0, 48000, 1.0).iter().map(|&s| s as f64).collect();
        let out_in: Vec<f64> = in_band.iter().map(|&x| bpf.process(x)).collect();
        let mut bpf2 = Biquad::bandpass(40.0, 120.0, SR);
        let far: Vec<f64> = sine(1000.0, 48000, 1.0).iter().map(|&s| s as f64).collect();
        let out_far: Vec<f64> = far.iter().map(|&x| bpf2.process(x)).collect();
        let gain_in = rms(&out_in[24000..]) / rms(&in_band[24000..]);
        let gain_far = rms(&out_far[24000..]) / rms(&far[24000..]);
        assert!(gain_in > 0.9, "center gain {gain_in}");
        assert!(gain_far < 0.1, "far gain {gain_far} should be < -20 dB");
    }

    #[test]
    fn follower_attacks_fast_releases_slow() {
        let mut env = EnvelopeFollower::new(0.005, 0.120, SR);
        for _ in 0..(0.02 * SR) as usize {
            env.process(1.0); // 20 ms of full scale
        }
        assert!(env.value() > 0.95, "after 4 attack taus: {}", env.value());
        let peak = env.value();
        for _ in 0..(0.120 * SR) as usize {
            env.process(0.0); // one release tau of silence
        }
        let expect = peak * (-1.0f64).exp();
        assert!((env.value() - expect).abs() < 0.02, "{} vs {}", env.value(), expect);
    }

    #[test]
    fn kick_bursts_fire_once_each_and_track_kick_env() {
        let mut bank = DetectorBank::new(SR);
        let mut fires = Vec::new();
        // 2 s: silence, then 80 ms kick-band bursts at 0.5 s and 1.5 s
        let mut audio = vec![0.0f32; 96000];
        for (i, s) in sine(70.0, 3840, 0.9).into_iter().enumerate() {
            audio[24000 + i] = s;
            audio[72000 + i] = s;
        }
        let mut kick_during_burst = 0.0f64;
        for (bi, chunk) in audio.chunks(800).enumerate() {
            let out = bank.process(chunk, &mut fires);
            if bi == 33 {
                kick_during_burst = out.kick; // ~0.55 s, mid-burst
            }
        }
        assert_eq!(fires.len(), 2, "one fire per burst: {fires:?}");
        assert!(fires.iter().all(|f| f.strength > 0.0 && f.strength <= 1.0));
        assert!(kick_during_burst > 0.3, "kick env mid-burst: {kick_during_burst}");
    }

    #[test]
    fn pad_ignores_kick_band_and_vice_versa() {
        let mut bank = DetectorBank::new(SR);
        let mut fires = Vec::new();
        let bass = sine(70.0, 48000, 0.9);
        let mut out = DetectorOut::default();
        for chunk in bass.chunks(800) {
            out = bank.process(chunk, &mut fires);
        }
        // an order of magnitude of separation is the contract; exact
        // rejection depths are band-tuning work (project data)
        assert!(out.kick > 0.4, "{out:?}");
        assert!(out.pad < 0.1, "{out:?}");
        assert!(out.lead < 0.1, "{out:?}");

        let mut bank2 = DetectorBank::new(SR);
        let mid = sine(400.0, 96000, 0.9); // pad attack is 250 ms — give it 2 s
        for chunk in mid.chunks(800) {
            out = bank2.process(chunk, &mut fires);
        }
        assert!(out.pad > 0.4, "{out:?}");
        assert!(out.kick < 0.1, "{out:?}");
    }

    #[test]
    fn cooldown_suppresses_double_fires_within_a_hit() {
        let mut gate = OnsetGate::new(1.5, 0.06, 0.150, SR);
        let mut fires = 0;
        // a step that stays high for 100 ms (inside one cooldown window)
        for t in 0..(0.1 * SR) as u64 {
            if gate.process(0.5, t).is_some() {
                fires += 1;
            }
        }
        assert_eq!(fires, 1);
    }
}
