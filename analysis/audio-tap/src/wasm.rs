//! WASM tuning preview (wasm-pack `--target web`). The browser decodes the
//! audio (WebAudio), downmixes to mono Float32, and calls `analyze` on
//! every param change — running the EXACT analyser/detector code the
//! sidecar runs, so the live preview and the production tap can't drift.
//! `tools/tuning/detector-viewer.html` loads this.

use wasm_bindgen::prelude::*;

use crate::detector::DetectorParams;
use crate::trace::{analyze_mono, COLUMNS, ROW_MS};

/// A computed trace, returned as flat typed arrays (cheap to hand to JS —
/// the viewer reshapes by `n_cols`). Rebuilt on every analyze() call.
#[wasm_bindgen]
pub struct Analysis {
    rows: Vec<f32>,   // n_rows * n_cols, row-major (COLUMNS order)
    onsets: Vec<f32>, // n_onsets * 2, (t_seconds, strength) pairs
    n_rows: usize,
    sample_rate: u32,
}

#[wasm_bindgen]
impl Analysis {
    #[wasm_bindgen(getter)]
    pub fn rows(&self) -> Vec<f32> {
        self.rows.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn onsets(&self) -> Vec<f32> {
        self.onsets.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn n_rows(&self) -> usize {
        self.n_rows
    }
    #[wasm_bindgen(getter)]
    pub fn n_cols(&self) -> usize {
        COLUMNS.len()
    }
    #[wasm_bindgen(getter)]
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

/// Column names (COLUMNS order) — the viewer maps names to indices.
#[wasm_bindgen]
pub fn columns() -> Vec<JsValue> {
    COLUMNS.iter().map(|s| JsValue::from_str(s)).collect()
}

/// Row period in ms (50) — the viewer's time grid.
#[wasm_bindgen]
pub fn row_ms() -> u32 {
    ROW_MS
}

/// The research-default detector params as a `detector-params.v1` JSON —
/// so the viewer seeds its editor from Rust (detector.rs::defaults), never
/// a hardcoded JS copy that could drift.
#[wasm_bindgen]
pub fn default_params() -> String {
    let p = DetectorParams::default();
    let ch = |c: &crate::detector::ChainParams| {
        serde_json::json!({ "band_hz": c.band_hz, "attack_s": c.attack_s, "release_s": c.release_s })
    };
    let fx = |c: &crate::detector::FluxChannelParams| {
        serde_json::json!({ "band_hz": c.band_hz, "compress": c.compress })
    };
    serde_json::json!({
        "schema": "detector-params.v1",
        "kick": ch(&p.kick),
        "pad": ch(&p.pad),
        "lead": ch(&p.lead),
        "onset": { "threshold": p.onset.threshold, "cooldown_s": p.onset.cooldown_s, "baseline_tau_s": p.onset.baseline_tau_s },
        "flux": { "kick": fx(&p.flux.kick), "click": fx(&p.flux.click) },
    })
    .to_string()
}

/// Analyze mono PCM with a `detector-params.v1` JSON. Missing fields fall
/// back to the research defaults; a typo'd leaf key is an error (same
/// deny_unknown_fields contract as the binary's --params).
#[wasm_bindgen]
pub fn analyze(pcm: &[f32], sample_rate: u32, params_json: &str) -> Result<Analysis, JsValue> {
    let params: DetectorParams =
        serde_json::from_str(params_json).map_err(|e| JsValue::from_str(&format!("params: {e}")))?;
    let tr = analyze_mono(pcm, sample_rate, &params);
    let mut rows = Vec::with_capacity(tr.rows.len() * COLUMNS.len());
    for r in &tr.rows {
        for v in r {
            rows.push(*v as f32);
        }
    }
    let mut onsets = Vec::with_capacity(tr.onsets.len() * 2);
    for (t, s) in &tr.onsets {
        onsets.push(*t as f32);
        onsets.push(*s as f32);
    }
    Ok(Analysis { rows, onsets, n_rows: tr.rows.len(), sample_rate: tr.sample_rate })
}
