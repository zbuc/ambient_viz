//! Host-side mood audition (PROCMUSIC.md §5) — the Mac mirror of the Pi's
//! `mood_expander.v1` plugin, reading the **same** `moods.json` so anchors
//! are authored once. Inverse-distance² blend over anchors → a `Genome` for
//! the procedural producer plus FX params applied straight to the engine.
//!
//! FX values are RAW `apply_param` values, not normalized — fine for the
//! 0..1 params (ReverbWet, StabDecay, TapeFailure, …); mind the real-unit
//! ones (KickFreq Hz, StabDelayTime s) when authoring anchors.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use dsp::{GENE_COUNT, Genome, Param};

#[derive(serde::Deserialize, Debug, Clone)]
pub struct Anchor {
    pub name: String,
    pub pos: [f32; 2],
    pub genome: Genome,
    #[serde(default)]
    pub fx: BTreeMap<String, f32>,
}

#[derive(serde::Deserialize, Debug)]
pub struct MoodsFile {
    pub schema: String,
    pub anchors: Vec<Anchor>,
}

/// Load and sanity-check a `moods.v1` file. (The host is the lenient
/// consumer: genes missing from an anchor take `Genome::default()` values
/// via serde — the Pi expander is the strict one.)
pub fn load(path: &Path) -> Result<MoodsFile> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let file: MoodsFile =
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?;
    if file.schema != "moods.v1" {
        bail!("{}: schema {:?} != \"moods.v1\"", path.display(), file.schema);
    }
    if file.anchors.is_empty() {
        bail!("{}: needs at least one anchor", path.display());
    }
    Ok(file)
}

/// Default search locations relative to the invocation dir (the host is
/// usually run from `daisy/`, sometimes the repo root).
pub fn default_path() -> Option<PathBuf> {
    ["projects/pain-material/manifest/moods.json", "../projects/pain-material/manifest/moods.json"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
}

/// Inverse-distance² blend at `pos` — the same math as the Pi expander.
/// Returns the blended genome and the blended FX map (per-key weights
/// renormalized over the anchors that declare that key).
pub fn blend(anchors: &[Anchor], pos: [f32; 2]) -> (Genome, BTreeMap<String, f32>) {
    let weights: Vec<f32> = anchors
        .iter()
        .map(|a| {
            let dx = pos[0] - a.pos[0];
            let dy = pos[1] - a.pos[1];
            1.0 / (dx * dx + dy * dy + 1e-6)
        })
        .collect();
    let total: f32 = weights.iter().sum();

    let mut genes = [0.0f32; GENE_COUNT];
    for (a, &w) in anchors.iter().zip(weights.iter()) {
        for (g, v) in genes.iter_mut().zip(a.genome.to_array()) {
            *g += (w / total) * v;
        }
    }

    let mut fx: BTreeMap<String, (f32, f32)> = BTreeMap::new(); // key -> (Σw·v, Σw)
    for (a, &w) in anchors.iter().zip(weights.iter()) {
        for (k, &v) in &a.fx {
            let e = fx.entry(k.clone()).or_insert((0.0, 0.0));
            e.0 += w * v;
            e.1 += w;
        }
    }
    let fx = fx.into_iter().map(|(k, (sum, wsum))| (k, sum / wsum)).collect();

    (Genome::from_array(genes).clamped(), fx)
}

/// Anchor `fx` key → engine param. Names mirror the `Param` variants.
pub fn param_for(name: &str) -> Option<Param> {
    Some(match name {
        "KickFreq" => Param::KickFreq,
        "KickAccent" => Param::KickAccent,
        "KickDecay" => Param::KickDecay,
        "KickTone" => Param::KickTone,
        "KickAttackFm" => Param::KickAttackFm,
        "KickSelfFm" => Param::KickSelfFm,
        "KickDistDrive" => Param::KickDistDrive,
        "ReverbWet" => Param::ReverbWet,
        "StabGain" => Param::StabGain,
        "StabIndex" => Param::StabIndex,
        "StabDecay" => Param::StabDecay,
        "StabModRatio" => Param::StabModRatio,
        "StabFeedback" => Param::StabFeedback,
        "StabDrive" => Param::StabDrive,
        "TapeFailure" => Param::TapeFailure,
        "StabDelayWet" => Param::StabDelayWet,
        "StabDelayFeedback" => Param::StabDelayFeedback,
        "StabDelayTime" => Param::StabDelayTime,
        "BassCutoff" => Param::BassCutoff,
        "BassRes" => Param::BassRes,
        "BassEnvMod" => Param::BassEnvMod,
        "BassGain" => Param::BassGain,
        "Freeze" => Param::Freeze,
        _ => return None,
    })
}

/// Resolve a `--mood` value: an anchor name, or a literal `x,y` position.
pub fn resolve_pos(file: &MoodsFile, spec: &str) -> Result<[f32; 2]> {
    if let Some(a) = file.anchors.iter().find(|a| a.name == spec) {
        return Ok(a.pos);
    }
    if let Some((x, y)) = spec.split_once(',') {
        if let (Ok(x), Ok(y)) = (x.trim().parse(), y.trim().parse()) {
            return Ok([x, y]);
        }
    }
    bail!(
        "--mood {spec:?} is neither an anchor name ({}) nor \"x,y\"",
        file.anchors.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_anchor_file() -> MoodsFile {
        serde_json::from_str(
            r#"{ "schema": "moods.v1", "anchors": [
                 { "name": "a", "pos": [0.0, 0.0],
                   "genome": { "density": 0.1, "note_length": 0.9 },
                   "fx": { "ReverbWet": 0.6, "StabDecay": 0.9 } },
                 { "name": "b", "pos": [1.0, 0.0],
                   "genome": { "density": 0.9, "note_length": 0.1 },
                   "fx": { "ReverbWet": 0.2 } } ] }"#,
        )
        .unwrap()
    }

    #[test]
    fn parses_with_gene_defaults() {
        let f = two_anchor_file();
        assert_eq!(f.anchors[0].genome.density, 0.1);
        // Missing genes take Genome::default() values (serde(default)).
        assert_eq!(f.anchors[0].genome.tension, Genome::default().tension);
    }

    #[test]
    fn blend_is_anchor_exact_at_anchors_and_mean_at_midpoint() {
        let f = two_anchor_file();
        let (g, fx) = blend(&f.anchors, [0.0, 0.0]);
        assert!((g.density - 0.1).abs() < 1e-3);
        assert!((fx["ReverbWet"] - 0.6).abs() < 1e-3);

        let (g, fx) = blend(&f.anchors, [0.5, 0.0]);
        assert!((g.density - 0.5).abs() < 1e-6);
        assert!((g.note_length - 0.5).abs() < 1e-6);
        assert!((fx["ReverbWet"] - 0.4).abs() < 1e-6);
        // StabDecay is declared by anchor "a" only → its weight renormalizes
        // to that anchor alone, so the midpoint still hears 0.9.
        assert!((fx["StabDecay"] - 0.9).abs() < 1e-6);
    }

    #[test]
    fn production_moods_file_loads_and_resolves_names() {
        let Some(path) = default_path() else {
            // Running from an unexpected cwd — the Pi-side test covers the file.
            return;
        };
        let f = load(&path).unwrap();
        assert!(resolve_pos(&f, "ambient").is_ok());
        assert!(resolve_pos(&f, "techno").is_ok());
        assert!(resolve_pos(&f, "0.4, 0.5").is_ok());
        assert!(resolve_pos(&f, "nope").is_err());
        // Every fx key in the production anchors must map to a real Param —
        // a typo here would silently do nothing in the audition rig.
        for a in &f.anchors {
            for k in a.fx.keys() {
                assert!(param_for(k).is_some(), "unknown fx param {k:?} in anchor {}", a.name);
            }
        }
    }
}
