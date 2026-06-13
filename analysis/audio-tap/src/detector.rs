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

use serde::Deserialize;

/// Onset-gate knobs (the most-tuned constants; CLI flags override them on
/// top of any params file).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default, deny_unknown_fields)] // a typo'd knob is a loud error, not a silent no-op
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

/// One detector chain's tunables (band + envelope follower).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default, deny_unknown_fields)] // a typo'd knob is a loud error, not a silent no-op
pub struct ChainParams {
    pub band_hz: [f64; 2],
    pub attack_s: f64,
    pub release_s: f64,
}

impl ChainParams {
    const fn from_consts(band: (f64, f64), ar: (f64, f64)) -> Self {
        ChainParams { band_hz: [band.0, band.1], attack_s: ar.0, release_s: ar.1 }
    }
}

impl Default for ChainParams {
    fn default() -> Self {
        // never used directly (DetectorParams::default seeds each chain),
        // but serde(default) needs it for partial chain objects
        ChainParams::from_consts(defaults::KICK_BAND, defaults::KICK_AR)
    }
}

/// One spectral-flux channel (stage 2, observe-only): a measurement band
/// plus a `compress` knob. Flux peaks vary hit-to-hit; compression (a
/// power-law that lifts weak-but-present onsets toward the strong ones,
/// the log/mu-law flux normalization of the onset-detection literature)
/// tames that so a single threshold works across hits — at the cost of
/// floor contrast, so it's adjustable and viewed.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FluxChannelParams {
    pub band_hz: [f64; 2],
    /// 0 = linear (off); 1 = strong. gamma = 1 − 0.8·compress, applied as
    /// `out = in^gamma` on the level-normalized flux (monotonic, [0,1]).
    pub compress: f64,
}

impl Default for FluxChannelParams {
    fn default() -> Self {
        FluxChannelParams { band_hz: [20.0, 120.0], compress: 0.0 }
    }
}

impl FluxChannelParams {
    const fn new(lo: f64, hi: f64) -> Self {
        FluxChannelParams { band_hz: [lo, hi], compress: 0.0 }
    }
    /// Shape a level-normalized flux value (≥0) by this channel's compress.
    pub fn shape(&self, x: f64) -> f64 {
        let gamma = 1.0 - 0.8 * self.compress.clamp(0.0, 1.0);
        x.clamp(0.0, 1.0).powf(gamma)
    }
}

/// The kick SCORE combiner: a weighted geometric mean of the two
/// (compressed) flux channels. Geometric mean = hard coincidence (zero if
/// EITHER channel is zero), which is the kick/tom discriminator — a tom
/// has body flux but no beater click, so it scores ~0. Weights tilt the
/// emphasis; a weight of 0 drops that channel (e.g. click-only). The score
/// is computed PER TICK (then slice-maxed) so it credits body+click only
/// when they're simultaneous, not merely both-somewhere-in-the-row.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FluxScore {
    pub kick_weight: f64,
    pub click_weight: f64,
}

impl Default for FluxScore {
    fn default() -> Self {
        FluxScore { kick_weight: 1.0, click_weight: 1.0 }
    }
}

impl FluxScore {
    /// Combine two shaped (compressed) flux values, each in [0,1].
    pub fn combine(&self, kick_flux: f64, click_flux: f64) -> f64 {
        let (wk, wc) = (self.kick_weight.max(0.0), self.click_weight.max(0.0));
        let sum = wk + wc;
        if sum <= 0.0 {
            return 0.0; // degenerate weights -> no signal
        }
        (kick_flux.clamp(0.0, 1.0).powf(wk) * click_flux.clamp(0.0, 1.0).powf(wc)).powf(1.0 / sum)
    }
}

/// The two flux channels — `kick` (body) + `click` (beater) — plus the
/// `score` combiner. A kick spikes both coincidentally; a tom mostly
/// `kick`. Each channel has its own band (independent of the envelope
/// detectors' bands).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FluxParams {
    pub kick: FluxChannelParams,
    pub click: FluxChannelParams,
    pub score: FluxScore,
}

impl Default for FluxParams {
    fn default() -> Self {
        FluxParams {
            kick: FluxChannelParams::new(20.0, 120.0),
            click: FluxChannelParams::new(2000.0, 5000.0),
            score: FluxScore::default(),
        }
    }
}

/// The full detector tunable set — the `detector-params.v1` artifact
/// (tools/tuning/), which is also the shape these graduate to as project
/// data in the manifest. serde(default) so a partial file falls back to
/// the research defaults field by field.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default)]
pub struct DetectorParams {
    pub kick: ChainParams,
    pub pad: ChainParams,
    pub lead: ChainParams,
    pub onset: OnsetParams,
    pub flux: FluxParams,
}

impl Default for DetectorParams {
    fn default() -> Self {
        use defaults::*;
        DetectorParams {
            kick: ChainParams::from_consts(KICK_BAND, KICK_AR),
            pad: ChainParams::from_consts(PAD_BAND, PAD_AR),
            lead: ChainParams::from_consts(LEAD_BAND, LEAD_AR),
            onset: OnsetParams::default(),
            flux: FluxParams::default(),
        }
    }
}

impl DetectorParams {
    /// Load a `detector-params.v1` file. Missing fields fall back to the
    /// research defaults; a wrong/absent schema tag is a loud error (catches
    /// "pointed at the wrong JSON").
    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        let txt = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let v: serde_json::Value =
            serde_json::from_str(&txt).map_err(|e| format!("{}: {e}", path.display()))?;
        match v.get("schema").and_then(|s| s.as_str()) {
            Some("detector-params.v1") => {}
            other => return Err(format!("{}: schema {:?} != \"detector-params.v1\"", path.display(), other)),
        }
        serde_json::from_value(v).map_err(|e| format!("{}: {e}", path.display()))
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
        Self::from_params(sample_rate, &DetectorParams::default())
    }

    pub fn from_params(sample_rate: f64, p: &DetectorParams) -> Self {
        let chain = |c: &ChainParams| Chain::new(c.band_hz[0], c.band_hz[1], c.attack_s, c.release_s, sample_rate);
        DetectorBank {
            kick: chain(&p.kick),  // low-band transient — fast attack, medium release
            pad: chain(&p.pad),    // mid-band swell — slow both ways
            lead: chain(&p.lead),  // upper-mid presence — medium both ways
            onset: OnsetGate::new(p.onset.baseline_tau_s, p.onset.threshold, p.onset.cooldown_s, sample_rate),
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
    fn params_partial_file_falls_back_field_by_field() {
        // only kick band + threshold set; everything else must be defaults
        let p: DetectorParams = serde_json::from_str(
            r#"{ "kick": { "band_hz": [30, 90] }, "onset": { "threshold": 0.1 } }"#,
        ).unwrap();
        assert_eq!(p.kick.band_hz, [30.0, 90.0]);
        assert_eq!(p.kick.attack_s, defaults::KICK_AR.0); // untouched chain field
        assert_eq!(p.onset.threshold, 0.1);
        assert_eq!(p.onset.cooldown_s, defaults::ONSET_COOLDOWN_S);
        assert_eq!(p.pad.band_hz, [defaults::PAD_BAND.0, defaults::PAD_BAND.1]);
    }

    #[test]
    fn flux_compress_lifts_lows_and_is_off_at_zero() {
        let linear = FluxChannelParams { band_hz: [20.0, 120.0], compress: 0.0 };
        assert!((linear.shape(0.25) - 0.25).abs() < 1e-12); // compress 0 = identity
        let strong = FluxChannelParams { band_hz: [20.0, 120.0], compress: 1.0 };
        assert!(strong.shape(0.25) > 0.25); // a weak onset is lifted
        assert!((strong.shape(1.0) - 1.0).abs() < 1e-9); // a full onset stays at 1
        assert!((strong.shape(0.0)).abs() < 1e-9); // silence stays at 0
        // monotonic: bigger in -> bigger out (so slice-max commutes with shape)
        assert!(strong.shape(0.6) > strong.shape(0.3));
    }

    #[test]
    fn flux_score_is_coincidence_sensitive() {
        let s = FluxScore { kick_weight: 1.0, click_weight: 1.0 };
        assert_eq!(s.combine(0.8, 0.0), 0.0); // body but no click (a tom) -> 0
        assert_eq!(s.combine(0.0, 0.8), 0.0); // click but no body -> 0
        assert!((s.combine(0.8, 0.8) - 0.8).abs() < 1e-9); // both equal -> that value
        let both = s.combine(0.3, 0.9); // weak body + strong click (a kick)
        assert!(both > 0.3 && both < 0.9, "geomean lands between: {both}");
        assert!(both > 0.0, "a real kick scores well above a tom's 0");
        // a 0 weight drops that channel: click-only -> score == click_flux
        let click_only = FluxScore { kick_weight: 0.0, click_weight: 1.0 };
        assert!((click_only.combine(0.2, 0.7) - 0.7).abs() < 1e-9);
        // degenerate weights -> no signal, not a panic
        assert_eq!(FluxScore { kick_weight: 0.0, click_weight: 0.0 }.combine(0.5, 0.5), 0.0);
    }

    #[test]
    fn params_flux_partial_falls_back() {
        let p: DetectorParams = serde_json::from_str(
            r#"{ "flux": { "click": { "compress": 0.5 } } }"#,
        ).unwrap();
        assert_eq!(p.flux.click.compress, 0.5);
        assert_eq!(p.flux.click.band_hz, [20.0, 120.0]); // FluxChannelParams default band
        assert_eq!(p.flux.kick.band_hz, [20.0, 120.0]);
        assert_eq!(p.flux.kick.compress, 0.0);
    }

    #[test]
    fn params_reject_typoed_knob() {
        // cooldown_ms (should be cooldown_s) must error, not silently no-op
        let r: Result<DetectorParams, _> =
            serde_json::from_str(r#"{ "onset": { "cooldown_ms": 200 } }"#);
        assert!(r.is_err());
    }

    #[test]
    fn params_load_checks_schema() {
        let dir = std::env::temp_dir().join(format!("detparams-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("good.json");
        std::fs::write(&good, r#"{"schema":"detector-params.v1","onset":{"threshold":0.2}}"#).unwrap();
        assert_eq!(DetectorParams::load(&good).unwrap().onset.threshold, 0.2);
        let bad = dir.join("bad.json");
        std::fs::write(&bad, r#"{"onset":{"threshold":0.2}}"#).unwrap();
        assert!(DetectorParams::load(&bad).is_err()); // missing schema tag
        let _ = std::fs::remove_dir_all(&dir);
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
