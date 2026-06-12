//! The band math — a port of static/audio-tap.js computeBands(), pinned
//! by the same test vectors as the JS (server/test/audio-tap.test.js).
//!
//! This operates on AnalyserNode-SHAPED inputs (byte spectra + byte
//! time-domain) because that is the compat contract: stage 1 of the
//! sidecar emulates WebAudio's analyser (Blackman window -> FFT ->
//! per-bin smoothing 0.85 -> dB clamp [-100,-30] -> byte) and feeds the
//! result through THIS function, so the cutover A/B against the browser
//! tap compares values, not vibes. The emulation (and the filterbank
//! detector surface) is stage-1 build work — see AUDIO_ANALYSIS_SIDECAR.md;
//! only the shared back-half math lives here yet.

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Bands {
    pub bass: f64,
    pub mid: f64,
    pub treble: f64,
    pub level: f64,
    pub level_db: f64,
    pub peak: f64,
    pub bass_fast: f64,
}

fn avg_range(data: &[u8], lo_hz: f64, hi_hz: f64, nyq: f64) -> f64 {
    let n = data.len() as f64;
    let lo = ((lo_hz / nyq * n).floor() as usize).max(0);
    let hi = ((hi_hz / nyq * n).ceil() as usize).min(data.len());
    if hi <= lo {
        return 0.0;
    }
    let sum: u64 = data[lo..hi].iter().map(|&b| b as u64).sum();
    sum as f64 / (hi - lo) as f64 / 255.0
}

pub fn compute_bands(
    freq: &[u8],
    time: &[u8],
    transient_freq: Option<&[u8]>,
    sample_rate: f64,
) -> Bands {
    let nyq = sample_rate / 2.0;
    let bass = avg_range(freq, 20.0, 200.0, nyq);
    let mid = avg_range(freq, 200.0, 2000.0, nyq);
    let treble = avg_range(freq, 2000.0, 12000.0, nyq);
    let level_db =
        freq.iter().map(|&b| b as u64).sum::<u64>() as f64 / freq.len() as f64 / 255.0;
    let mut level = 0.0;
    let mut peak: f64 = 0.0;
    for &b in time {
        let s = (b as f64 - 128.0) / 128.0;
        level += s * s;
        peak = peak.max(s.abs());
    }
    level = (level / time.len() as f64).sqrt();
    let bass_fast = transient_freq.map_or(0.0, |t| avg_range(t, 20.0, 200.0, nyq));
    Bands {
        bass,
        mid,
        treble,
        level,
        level_db,
        peak,
        bass_fast,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48000.0;

    #[test]
    fn silence_is_zero_everywhere() {
        let b = compute_bands(&[0; 1024], &[128; 2048], Some(&[0; 512]), SR);
        assert_eq!(b, Bands::default());
    }

    #[test]
    fn flat_full_scale_spectrum_saturates() {
        let b = compute_bands(&[255; 1024], &[128; 2048], None, SR);
        assert_eq!(b.bass, 1.0);
        assert_eq!(b.mid, 1.0);
        assert_eq!(b.treble, 1.0);
        assert_eq!(b.level_db, 1.0);
        assert_eq!(b.bass_fast, 0.0); // no transient analyser -> 0
    }

    #[test]
    fn band_isolation_matches_bin_mapping() {
        // n=1024, nyq=24000: bass bins [0, 9). Energy in bins 0..7 only
        // (bin 8 straddles the bass/mid seam): bass = 8/9, mid untouched.
        let mut freq = [0u8; 1024];
        freq[..8].fill(255);
        let b = compute_bands(&freq, &[128; 2048], None, SR);
        assert!((b.bass - 8.0 / 9.0).abs() < 1e-12);
        assert_eq!(b.mid, 0.0);
        assert_eq!(b.treble, 0.0);
    }

    #[test]
    fn level_is_linear_rms_peak_is_max_abs() {
        let time: Vec<u8> = (0..2048).map(|i| if i % 2 == 1 { 255 } else { 0 }).collect();
        let b = compute_bands(&[0; 1024], &time, None, SR);
        let expected = ((1.0 + (127.0f64 / 128.0).powi(2)) / 2.0).sqrt();
        assert!((b.level - expected).abs() < 1e-12);
        assert_eq!(b.peak, 1.0);
    }

    #[test]
    fn bass_fast_reads_the_transient_spectrum() {
        // n=512, nyq=24000: bass bins [0, 5).
        let mut tf = [0u8; 512];
        tf[..5].fill(255);
        let b = compute_bands(&[0; 1024], &[128; 2048], Some(&tf), SR);
        assert_eq!(b.bass_fast, 1.0);
    }
}
