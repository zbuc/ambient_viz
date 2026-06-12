//! CompatAnalyser — a numeric emulation of WebAudio's AnalyserNode, per
//! the WebAudio spec's defined algorithm:
//!
//!   1. take the last fftSize time-domain samples,
//!   2. apply the Blackman window (a0=0.42, a1=0.5, a2=0.08),
//!   3. FFT; magnitudes scaled by 1/fftSize,
//!   4. per-bin time smoothing  X̂[k] = τ·X̂prev[k] + (1−τ)·|X[k]|,
//!   5. dB = 20·log10(X̂[k]), mapped from [minDecibels, maxDecibels]
//!      (defaults −100…−30) to bytes 0..255.
//!
//! getByteTimeDomainData: byte = clamp(⌊128·(1 + x)⌋, 0, 255).
//!
//! This exists so the sidecar's `bass/mid/treble/level/bass_fast` are the
//! SAME NUMBERS the browser tap produces (AUDIO_ANALYSIS_SIDECAR.md: the
//! cutover A/B compares values, not vibes). The browser steps the
//! smoothing once per rAF (~60 Hz on the kiosk); call tick() at the same
//! cadence — main drives it sample-counted (every sampleRate/60 samples),
//! which also makes file-mode output deterministic.

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};
use std::sync::Arc;

const MIN_DB: f64 = -100.0;
const MAX_DB: f64 = -30.0;

pub struct CompatAnalyser {
    fft_size: usize,
    smoothing: f64,
    ring: Vec<f32>,
    write: usize,
    fft: Arc<dyn RealToComplex<f64>>,
    input: Vec<f64>,
    spectrum: Vec<Complex<f64>>,
    scratch: Vec<Complex<f64>>,
    window: Vec<f64>,
    smoothed: Vec<f64>, // X̂[k], linear magnitude
    freq_bytes: Vec<u8>,
}

pub fn blackman(n: usize) -> Vec<f64> {
    (0..n)
        .map(|i| {
            let x = 2.0 * std::f64::consts::PI * i as f64 / n as f64;
            0.42 - 0.5 * x.cos() + 0.08 * (2.0 * x).cos()
        })
        .collect()
}

impl CompatAnalyser {
    /// Browser parity: main analyser = (2048, 0.85); transient = (1024, 0.3).
    pub fn new(fft_size: usize, smoothing: f64) -> Self {
        let mut planner = RealFftPlanner::<f64>::new();
        let fft = planner.plan_fft_forward(fft_size);
        CompatAnalyser {
            fft_size,
            smoothing,
            ring: vec![0.0; fft_size],
            write: 0,
            input: fft.make_input_vec(),
            spectrum: fft.make_output_vec(),
            scratch: fft.make_scratch_vec(),
            fft,
            window: blackman(fft_size),
            smoothed: vec![0.0; fft_size / 2],
            freq_bytes: vec![0; fft_size / 2],
        }
    }

    pub fn push(&mut self, mono: &[f32]) {
        for &s in mono {
            self.ring[self.write] = if s.is_finite() { s } else { 0.0 };
            self.write = (self.write + 1) % self.fft_size;
        }
    }

    /// One smoothing step over the current window (the browser's per-rAF
    /// recompute). Refreshes freq_bytes().
    pub fn tick(&mut self) {
        for i in 0..self.fft_size {
            let s = self.ring[(self.write + i) % self.fft_size] as f64;
            self.input[i] = s * self.window[i];
        }
        self.fft
            .process_with_scratch(&mut self.input, &mut self.spectrum, &mut self.scratch)
            .expect("fft sizes are planner-made");
        let tau = self.smoothing;
        for k in 0..self.fft_size / 2 {
            let mag = self.spectrum[k].norm() / self.fft_size as f64;
            let sm = tau * self.smoothed[k] + (1.0 - tau) * mag;
            self.smoothed[k] = sm;
            let db = if sm > 0.0 { 20.0 * sm.log10() } else { f64::NEG_INFINITY };
            let b = (255.0 / (MAX_DB - MIN_DB) * (db - MIN_DB)).floor();
            self.freq_bytes[k] = b.clamp(0.0, 255.0) as u8;
        }
    }

    /// getByteFrequencyData equivalent (frequencyBinCount = fftSize/2).
    pub fn freq_bytes(&self) -> &[u8] {
        &self.freq_bytes
    }

    /// getByteTimeDomainData equivalent over the last fftSize samples.
    pub fn time_bytes_into(&self, out: &mut Vec<u8>) {
        out.clear();
        out.reserve(self.fft_size);
        for i in 0..self.fft_size {
            let s = self.ring[(self.write + i) % self.fft_size] as f64;
            out.push((128.0 * (1.0 + s)).floor().clamp(0.0, 255.0) as u8);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48000.0;

    fn sine(freq: f64, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / SR).sin() as f32)
            .collect()
    }

    // Independent reference: naive DFT magnitude at bin k of the SAME
    // windowed frame, scaled 1/N — pins the realfft path + normalization.
    fn naive_bin_mag(samples: &[f32], window: &[f64], k: usize) -> f64 {
        let n = samples.len();
        let (mut re, mut im) = (0.0f64, 0.0f64);
        for i in 0..n {
            let x = samples[i] as f64 * window[i];
            let ph = -2.0 * std::f64::consts::PI * k as f64 * i as f64 / n as f64;
            re += x * ph.cos();
            im += x * ph.sin();
        }
        (re * re + im * im).sqrt() / n as f64
    }

    #[test]
    fn blackman_endpoints_and_peak() {
        let w = blackman(2048);
        assert!(w[0].abs() < 1e-12); // 0.42 - 0.5 + 0.08
        assert!((w[1024] - 1.0).abs() < 1e-9); // center = 0.42 + 0.5 + 0.08
    }

    #[test]
    fn magnitude_matches_naive_dft_with_smoothing_off() {
        let n = 1024;
        let mut a = CompatAnalyser::new(n, 0.0); // τ=0: X̂ = |X|
        // bin-centered sine: k = 8 -> f = 8/1024 * 48000 = 375 Hz
        let s = sine(375.0, n);
        a.push(&s);
        a.tick();
        let w = blackman(n);
        let expected = naive_bin_mag(&s, &w, 8);
        let expected_db = 20.0 * expected.log10();
        let expected_byte = (255.0 / 70.0 * (expected_db + 100.0)).floor().clamp(0.0, 255.0) as u8;
        assert_eq!(a.freq_bytes()[8], expected_byte);
        assert!(a.freq_bytes()[8] > 100, "bin should be hot, got {}", a.freq_bytes()[8]);
        assert!(a.freq_bytes()[200] < 10, "far bin should be cold");
    }

    #[test]
    fn smoothing_is_one_pole_in_linear_magnitude() {
        let n = 1024;
        let mut a = CompatAnalyser::new(n, 0.85);
        // low amplitude so both ticks sit inside the [-100,-30] dB window
        // (a full-scale sine clamps at the -30 dB byte ceiling)
        let s: Vec<f32> = sine(375.0, n).iter().map(|&x| x * 0.05).collect();
        a.push(&s);
        a.tick(); // X̂1 = 0.15·|X|
        let b1 = a.freq_bytes()[8];
        a.tick(); // X̂2 = 0.85·X̂1 + 0.15·|X| = 0.2775·|X|
        let b2 = a.freq_bytes()[8];
        assert!(b2 > b1, "smoothed magnitude must rise toward steady state");
        // dB delta of 0.2775/0.15 ≈ +5.34 dB ≈ 19.5 byte steps
        let expect_delta = (255.0 / 70.0 * 20.0 * (0.2775f64 / 0.15).log10()).round() as i32;
        let got_delta = b2 as i32 - b1 as i32;
        assert!((got_delta - expect_delta).abs() <= 1, "delta {got_delta} vs {expect_delta}");
    }

    #[test]
    fn silence_is_byte_zero_everywhere() {
        let mut a = CompatAnalyser::new(1024, 0.85);
        a.push(&vec![0.0; 1024]);
        a.tick();
        assert!(a.freq_bytes().iter().all(|&b| b == 0));
    }

    #[test]
    fn time_bytes_match_the_spec_mapping() {
        let mut a = CompatAnalyser::new(8, 0.85);
        a.push(&[0.0, 1.0, -1.0, 0.5, -0.5, 0.0, 0.0, 0.0]);
        let mut out = Vec::new();
        a.time_bytes_into(&mut out);
        assert_eq!(&out[..5], &[128, 255, 0, 192, 64]);
    }

    #[test]
    fn end_to_end_bands_see_a_bass_sine_as_bass() {
        let mut main = CompatAnalyser::new(2048, 0.85);
        let mut tr = CompatAnalyser::new(1024, 0.3);
        let s = sine(100.0, 48000); // 1 s of 100 Hz
        for chunk in s.chunks(800) {
            main.push(chunk);
            tr.push(chunk);
            main.tick();
            tr.tick();
        }
        let mut time = Vec::new();
        main.time_bytes_into(&mut time);
        let b = crate::bands::compute_bands(main.freq_bytes(), &time, Some(tr.freq_bytes()), SR);
        assert!(b.bass > 0.3, "bass {:?}", b);
        assert!(b.bass > b.treble * 2.0);
        assert!(b.bass_fast > 0.3);
        assert!((b.level - std::f64::consts::FRAC_1_SQRT_2).abs() < 0.02);
    }
}
