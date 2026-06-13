//! The trace assembly — the batch driver shared by the binary's
//! `--trace-out` and the WASM tuning preview. Mono samples in, an
//! `audiotap-trace.v1`-shaped result out (the same rows + onsets the
//! viewer plots). Because both entry points call THIS, the offline trace
//! and the live browser preview can never disagree about what the
//! detector does — there is exactly one orchestration of the DSP.
//!
//! (The binary's LIVE publishing path has its own streaming driver — it
//! publishes block-by-block as it goes — but it drives the same analyser/
//! detector primitives; only the offline/preview batch path lives here.)

use crate::analyser::CompatAnalyser;
use crate::bands;
use crate::detector::{DetectorBank, DetectorParams, OnsetFire};

/// Trace row layout — the viewer's column order, the binary's meta echoes
/// it, the WASM export reports it. `kick_flux`/`click_flux` (stage 2) are
/// level-normalized positive spectral flux in the kick body band and a
/// fixed 2-5 kHz beater-click band — observe-only onset functions: a kick
/// shows flux in BOTH coincidentally, a tom mostly in the low band. Tune
/// the gate against them later; for now they're for the eye.
pub const COLUMNS: [&str; 14] = [
    "t", "bass", "mid", "treble", "level", "bass_fast", "peak",
    "kick", "pad", "lead", "kick_baseline", "kick_dev", "kick_flux", "click_flux",
];
pub const ROW_MS: u32 = 50;

pub struct Trace {
    pub sample_rate: u32,
    pub rows: Vec<[f64; 14]>,
    pub onsets: Vec<(f64, f64)>, // (t_seconds, strength)
}

// Fixed chunk so the analyser-tick phase is identical between the binary
// and the browser (both feed the full mono through analyze_mono the same
// way) — a stream chunked differently would shift the smoothing phase by
// up to a chunk.
const CHUNK: usize = 1024;

/// Analyze a full mono buffer the way the sidecar's stage-1 chain does:
/// compat analyser (2048/0.85 main, 1024/0.3 transient) stepped at the
/// ~60 Hz rAF-equivalent cadence, the filterbank detector bank per sample,
/// one row per 50 ms of audio (`peak` is the slice-max aggregate), and
/// every onset fire.
pub fn analyze_mono(mono: &[f32], sample_rate: u32, params: &DetectorParams) -> Trace {
    let sr = sample_rate.max(1);
    let mut main_an = CompatAnalyser::new(2048, 0.85);
    let mut trans_an = CompatAnalyser::new(1024, 0.3);
    let mut bank = DetectorBank::from_params(sr as f64, params);
    let tick_every = (sr as u64 / 60).max(1); // analyser smoothing cadence
    let row_every = (sr as u64 / 20).max(1); // 50 ms
    let mut since_tick = 0u64;
    let mut since_row = 0u64;
    let mut samples_done = 0u64;
    let mut time_bytes: Vec<u8> = Vec::new();
    let mut fires: Vec<OnsetFire> = Vec::new();
    let mut slice_peak = 0.0f64;
    let mut kick_flux = 0.0f64; // slice-max of band flux (sampled per tick)
    let mut click_flux = 0.0f64;
    let mut rows = Vec::new();
    let mut onsets = Vec::new();
    let fk = params.flux.kick;
    let fc = params.flux.click;

    for chunk in mono.chunks(CHUNK) {
        main_an.push(chunk);
        trans_an.push(chunk);
        since_tick += chunk.len() as u64;
        while since_tick >= tick_every {
            since_tick -= tick_every;
            main_an.tick();
            trans_an.tick();
            // spectral flux is a per-tick (60 Hz) quantity; keep the
            // strongest in the 50 ms row (the onset spike). Compression is
            // monotonic, so shaping the slice-max == max of shaped.
            kick_flux = kick_flux.max(main_an.band_flux(fk.band_hz[0], fk.band_hz[1], sr as f64));
            click_flux = click_flux.max(main_an.band_flux(fc.band_hz[0], fc.band_hz[1], sr as f64));
        }
        fires.clear();
        let det = bank.process(chunk, &mut fires);
        samples_done += chunk.len() as u64;
        let t = samples_done as f64 / sr as f64;
        for f in &fires {
            onsets.push((t, f.strength));
        }
        main_an.time_bytes_into(&mut time_bytes);
        let b = bands::compute_bands(main_an.freq_bytes(), &time_bytes, Some(trans_an.freq_bytes()), sr as f64);
        slice_peak = slice_peak.max(b.peak);
        since_row += chunk.len() as u64;
        if since_row >= row_every {
            since_row -= row_every;
            let baseline = bank.kick_baseline();
            rows.push([
                t, b.bass, b.mid, b.treble, b.level, b.bass_fast, slice_peak,
                det.kick, det.pad, det.lead, baseline, det.kick - baseline,
                fk.shape(kick_flux), fc.shape(click_flux),
            ]);
            slice_peak = 0.0;
            kick_flux = 0.0;
            click_flux = 0.0;
        }
    }
    Trace { sample_rate: sr, rows, onsets }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_is_empty_trace() {
        let t = analyze_mono(&[], 48000, &DetectorParams::default());
        assert!(t.rows.is_empty() && t.onsets.is_empty());
        assert_eq!(t.sample_rate, 48000);
    }

    #[test]
    fn rows_land_one_per_50ms_and_a_bass_sine_reads_as_bass() {
        let sr = 48000;
        let n = sr * 2; // 2 s
        let mono: Vec<f32> = (0..n)
            .map(|i| 0.6 * (2.0 * std::f32::consts::PI * 100.0 * i as f32 / sr as f32).sin())
            .collect();
        let t = analyze_mono(&mono, sr as u32, &DetectorParams::default());
        // ~2 s / 50 ms ≈ 40 rows (±1 for chunk granularity)
        assert!((t.rows.len() as i64 - 40).abs() <= 1, "rows {}", t.rows.len());
        assert_eq!(t.rows[0].len(), COLUMNS.len());
        // late row: bass column (idx 1) >> treble (idx 3)
        let r = t.rows[t.rows.len() - 2];
        assert!(r[1] > 0.3 && r[1] > r[3] * 2.0, "row {r:?}");
        // a steady sine: kick_flux (idx 12) has settled near zero by the end
        assert!(r[12] < 0.1, "steady-state kick_flux {} should be low", r[12]);
    }
}
