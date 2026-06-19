//! Composite-instrument **FX chain** — a host-only insert-effect layer.
//!
//! The dsp effects have heterogeneous shapes (in-place stereo blocks,
//! parallel sends, per-sample ticks) and no serde config structs — they're
//! setter-configured. This module wraps each one in a uniform [`Effect`]
//! trait (in-place stereo + a flat `f32` param surface) so a chain of them
//! can be built, reordered, tweaked live, and serialized to JSON as a list
//! of [`FxNode`]s. An [`Instrument`] bundles the source patches + the chain.
//!
//! **This is host-only glue.** It calls each effect's existing `process()`
//! unchanged — it does not modify any dsp effect or its real-time hot path,
//! so the Cortex-M7 firmware is unaffected. The dry/wet scratch buffers and
//! blends here run on the Mac audio callback only (same resize-on-demand
//! pattern the `PreviewRig` already uses).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use dsp::bloom::BloomBank;
use dsp::freeze::Freeze;
use dsp::svf::Svf;
use dsp::tape::TapeProcessor;
use dsp::transporter::Transporter;
use dsp::{AudioParam, BassPatch, Distortion, DistortionType, FmPatch, FrameProcessor, PingPongDelay, Reverb, WtPatch};

/// A uniform stereo insert effect (interleaved L/R, processed in place).
pub trait Effect: Send {
    /// Stable kind id (matches the JSON `kind` and the catalog).
    fn kind(&self) -> &'static str;
    /// Process one block in place. `sample_index` is the running frame count
    /// (time-aware effects need it; others ignore it).
    fn process(&mut self, buf: &mut [f32], sample_index: u64);
    /// Set a named parameter. Returns false if the name is unknown.
    fn set_param(&mut self, name: &str, value: f32) -> bool;
    /// Current parameter values (name, value) — for serialization + UI.
    fn params(&self) -> Vec<(&'static str, f32)>;
}

// ── serialization ───────────────────────────────────────────────────────────

/// One effect in a serialized chain: a kind + its params.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FxNode {
    pub kind: String,
    #[serde(default)]
    pub params: BTreeMap<String, f32>,
}

/// A composite instrument: the source patches + the FX chain.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Instrument {
    pub fm: FmPatch,
    pub bass: BassPatch,
    pub wt: WtPatch,
    #[serde(default)]
    pub fx: Vec<FxNode>,
}

/// One param's metadata for the `/fx/catalog` discovery endpoint.
#[derive(Clone, Debug, Serialize)]
pub struct ParamSpec {
    pub name: &'static str,
    pub default: f32,
    pub min: f32,
    pub max: f32,
}

/// An effect kind + its params, for discovery.
#[derive(Clone, Debug, Serialize)]
pub struct EffectSpec {
    pub kind: &'static str,
    pub params: Vec<ParamSpec>,
}

/// The order effects appear in the catalog / are offered in the UI.
pub const KINDS: &[&str] = &[
    "reverb", "delay", "distortion", "tape", "transporter", "freeze", "filter", "bloom",
];

/// Build a fresh effect of `kind` at `sr`, or `None` if unknown.
pub fn make(kind: &str, sr: f32) -> Option<Box<dyn Effect>> {
    Some(match kind {
        "reverb" => Box::new(ReverbFx::new(sr)),
        "delay" => Box::new(DelayFx::new(sr)),
        "distortion" => Box::new(DistortionFx::new(sr)),
        "tape" => Box::new(TapeFx::new(sr)),
        "transporter" => Box::new(TransporterFx::new(sr)),
        "freeze" => Box::new(FreezeFx::new(sr)),
        "filter" => Box::new(FilterFx::new(sr)),
        "bloom" => Box::new(BloomFx::new(sr)),
        _ => return None,
    })
}

/// Build an effect from a serialized node (kind + params).
pub fn from_node(node: &FxNode, sr: f32) -> Option<Box<dyn Effect>> {
    let mut fx = make(&node.kind, sr)?;
    for (name, value) in &node.params {
        fx.set_param(name, *value);
    }
    Some(fx)
}

/// Serialize a live effect to a node.
pub fn to_node(fx: &dyn Effect) -> FxNode {
    FxNode {
        kind: fx.kind().to_string(),
        params: fx.params().into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
    }
}

/// Every kind + its param specs (default from a fresh instance, ranges from
/// the per-kind table) — the `/fx/catalog` payload.
pub fn catalog() -> Vec<EffectSpec> {
    KINDS
        .iter()
        .filter_map(|&kind| {
            let fx = make(kind, 48_000.0)?;
            let ranges = param_ranges(kind);
            let params = fx
                .params()
                .into_iter()
                .map(|(name, default)| {
                    let (min, max) = ranges.iter().find(|(n, ..)| *n == name).map(|(_, lo, hi)| (*lo, *hi)).unwrap_or((0.0, 1.0));
                    ParamSpec { name, default, min, max }
                })
                .collect();
            Some(EffectSpec { kind: leak_kind(kind), params })
        })
        .collect()
}

/// `&'static str` for a known kind (KINDS entries are already static).
fn leak_kind(kind: &str) -> &'static str {
    KINDS.iter().find(|k| **k == kind).copied().unwrap_or("?")
}

/// (param, min, max) ranges per kind for the catalog. Defaults live in the
/// wrapper constructors; this is only for UI bounds.
fn param_ranges(kind: &str) -> Vec<(&'static str, f32, f32)> {
    match kind {
        "reverb" => vec![("room_size", 0.0, 1.0), ("damping", 0.0, 1.0), ("mix", 0.0, 1.0)],
        "delay" => vec![("time_ms", 1.0, 2000.0), ("feedback", 0.0, 0.95), ("mix", 0.0, 1.0)],
        "distortion" => vec![("drive", 1.0, 16.0), ("mix", 0.0, 1.0)],
        "tape" => vec![
            ("failure", 0.0, 1.0), ("hiss", 0.0, 1.0), ("wow_ms", 0.0, 10.0),
            ("flutter_ms", 0.0, 5.0), ("mix", 0.0, 1.0),
        ],
        "transporter" => vec![
            ("grain_ms", 5.0, 1000.0), ("density", 0.0, 100.0), ("offset_ms", 0.0, 2000.0),
            ("pitch", 0.25, 4.0), ("spread", 0.0, 4.0), ("reverse", 0.0, 1.0),
            ("dry", 0.0, 1.0), ("wet", 0.0, 2.0),
        ],
        "freeze" => vec![("amount", 0.0, 1.0), ("dry", 0.0, 1.0), ("wet", 0.0, 1.0)],
        "filter" => vec![
            ("freq", 20.0, 16000.0), ("res", 0.0, 1.0), ("drive", 0.0, 1.0),
            ("mode", 0.0, 3.0), ("mix", 0.0, 1.0),
        ],
        "bloom" => vec![("amount", 0.0, 1.0), ("dry", 0.0, 1.0), ("wet", 0.0, 1.0)],
        _ => vec![],
    }
}

/// dry*(1-mix) + buf*mix, in place (`buf` already holds the wet signal).
fn blend(buf: &mut [f32], dry: &[f32], mix: f32) {
    for (o, &d) in buf.iter_mut().zip(dry.iter()) {
        *o = d * (1.0 - mix) + *o * mix;
    }
}

// ── the chain ────────────────────────────────────────────────────────────────

/// An ordered chain of insert effects over a stereo bus.
pub struct FxChain {
    sample_rate: f32,
    effects: Vec<Box<dyn Effect>>,
}

impl FxChain {
    pub fn new(sample_rate: f32) -> Self {
        FxChain { sample_rate, effects: Vec::new() }
    }

    /// Run every effect in series, in place.
    pub fn process(&mut self, buf: &mut [f32], sample_index: u64) {
        for fx in &mut self.effects {
            fx.process(buf, sample_index);
        }
    }

    pub fn len(&self) -> usize {
        self.effects.len()
    }
    pub fn is_empty(&self) -> bool {
        self.effects.is_empty()
    }

    /// Insert a new effect of `kind` at `index` (append if None / out of
    /// range). Returns false if the kind is unknown.
    pub fn add(&mut self, kind: &str, index: Option<usize>) -> bool {
        match make(kind, self.sample_rate) {
            Some(fx) => {
                let at = index.unwrap_or(self.effects.len()).min(self.effects.len());
                self.effects.insert(at, fx);
                true
            }
            None => false,
        }
    }

    pub fn remove(&mut self, index: usize) -> bool {
        if index < self.effects.len() {
            self.effects.remove(index);
            true
        } else {
            false
        }
    }

    /// Move the effect at `from` to `to`.
    pub fn move_fx(&mut self, from: usize, to: usize) -> bool {
        if from >= self.effects.len() || to >= self.effects.len() {
            return false;
        }
        let fx = self.effects.remove(from);
        self.effects.insert(to, fx);
        true
    }

    pub fn set_param(&mut self, index: usize, name: &str, value: f32) -> bool {
        self.effects.get_mut(index).is_some_and(|fx| fx.set_param(name, value))
    }

    pub fn to_nodes(&self) -> Vec<FxNode> {
        self.effects.iter().map(|fx| to_node(fx.as_ref())).collect()
    }

    /// Replace the whole chain from serialized nodes (unknown kinds skipped).
    pub fn set_nodes(&mut self, nodes: &[FxNode]) {
        self.effects = nodes.iter().filter_map(|n| from_node(n, self.sample_rate)).collect();
    }

    pub fn clear(&mut self) {
        self.effects.clear();
    }
}

// ── wrappers ─────────────────────────────────────────────────────────────────
//
// In-place effects (reverb/delay/distortion/tape/filter) keep a `dry` scratch
// and blend by `mix`. Parallel-send effects (transporter/freeze/bloom) keep a
// `send` scratch and mix the wet over a *scalable* dry — `out = dry·in +
// wet·send` — so `dry = 0` gives a pure parallel send (the through/"primary"
// signal removed, e.g. the sound_test transporter pad).

struct ReverbFx {
    inner: Reverb,
    dry: Vec<f32>,
    room: f32,
    damp: f32,
    mix: f32,
}
impl ReverbFx {
    fn new(sr: f32) -> Self {
        let mut inner = Reverb::new();
        inner.set_sample_rate(sr);
        let mut s = ReverbFx { inner, dry: Vec::new(), room: 0.7, damp: 0.4, mix: 0.3 };
        s.apply();
        s
    }
    fn apply(&mut self) {
        self.inner.set_room_size(AudioParam::linear(self.room));
        self.inner.set_damping(AudioParam::linear(self.damp));
    }
}
impl Effect for ReverbFx {
    fn kind(&self) -> &'static str {
        "reverb"
    }
    fn process(&mut self, buf: &mut [f32], idx: u64) {
        self.dry.resize(buf.len(), 0.0);
        self.dry.copy_from_slice(buf);
        self.inner.process(buf, idx);
        blend(buf, &self.dry, self.mix);
    }
    fn set_param(&mut self, name: &str, v: f32) -> bool {
        match name {
            "room_size" => {
                self.room = v.clamp(0.0, 1.0);
                self.apply();
            }
            "damping" => {
                self.damp = v.clamp(0.0, 1.0);
                self.apply();
            }
            "mix" => self.mix = v.clamp(0.0, 1.0),
            _ => return false,
        }
        true
    }
    fn params(&self) -> Vec<(&'static str, f32)> {
        vec![("room_size", self.room), ("damping", self.damp), ("mix", self.mix)]
    }
}

struct DelayFx {
    inner: PingPongDelay,
    dry: Vec<f32>,
    time_ms: f32,
    feedback: f32,
    mix: f32,
}
impl DelayFx {
    fn new(sr: f32) -> Self {
        // wet-only inner (mix=1); the wrapper owns dry/wet.
        let mut inner = PingPongDelay::new(
            2.0,
            AudioParam::seconds(0.375),
            AudioParam::linear(0.45),
            AudioParam::linear(1.0),
        );
        inner.set_sample_rate(sr);
        DelayFx { inner, dry: Vec::new(), time_ms: 375.0, feedback: 0.45, mix: 0.35 }
    }
}
impl Effect for DelayFx {
    fn kind(&self) -> &'static str {
        "delay"
    }
    fn process(&mut self, buf: &mut [f32], idx: u64) {
        self.dry.resize(buf.len(), 0.0);
        self.dry.copy_from_slice(buf);
        self.inner.process(buf, idx);
        blend(buf, &self.dry, self.mix);
    }
    fn set_param(&mut self, name: &str, v: f32) -> bool {
        match name {
            "time_ms" => {
                self.time_ms = v.clamp(1.0, 2000.0);
                self.inner.set_delay_time(AudioParam::seconds(self.time_ms * 0.001));
            }
            "feedback" => {
                self.feedback = v.clamp(0.0, 0.95);
                self.inner.set_feedback(AudioParam::linear(self.feedback));
            }
            "mix" => self.mix = v.clamp(0.0, 1.0),
            _ => return false,
        }
        true
    }
    fn params(&self) -> Vec<(&'static str, f32)> {
        vec![("time_ms", self.time_ms), ("feedback", self.feedback), ("mix", self.mix)]
    }
}

struct DistortionFx {
    inner: Distortion,
    dry: Vec<f32>,
    drive: f32,
    mix: f32,
}
impl DistortionFx {
    fn new(sr: f32) -> Self {
        let mut inner = Distortion::new(
            AudioParam::linear(2.0),
            AudioParam::linear(1.0), // inner mix = wet; wrapper owns dry/wet
            DistortionType::SoftClip,
        );
        inner.set_sample_rate(sr);
        DistortionFx { inner, dry: Vec::new(), drive: 2.0, mix: 1.0 }
    }
}
impl Effect for DistortionFx {
    fn kind(&self) -> &'static str {
        "distortion"
    }
    fn process(&mut self, buf: &mut [f32], idx: u64) {
        self.dry.resize(buf.len(), 0.0);
        self.dry.copy_from_slice(buf);
        self.inner.process(buf, idx);
        blend(buf, &self.dry, self.mix);
    }
    fn set_param(&mut self, name: &str, v: f32) -> bool {
        match name {
            "drive" => {
                self.drive = v.clamp(1.0, 16.0);
                self.inner.set_drive(AudioParam::linear(self.drive));
            }
            "mix" => self.mix = v.clamp(0.0, 1.0),
            _ => return false,
        }
        true
    }
    fn params(&self) -> Vec<(&'static str, f32)> {
        vec![("drive", self.drive), ("mix", self.mix)]
    }
}

struct TapeFx {
    inner: TapeProcessor,
    dry: Vec<f32>,
    failure: f32,
    hiss: f32,
    wow_ms: f32,
    flutter_ms: f32,
    mix: f32,
}
impl TapeFx {
    fn new(sr: f32) -> Self {
        let mut inner = TapeProcessor::new(sr);
        inner.set_failure(0.0);
        inner.set_hiss_amount(0.0);
        TapeFx { inner, dry: Vec::new(), failure: 0.0, hiss: 0.0, wow_ms: 0.0, flutter_ms: 0.0, mix: 1.0 }
    }
}
impl Effect for TapeFx {
    fn kind(&self) -> &'static str {
        "tape"
    }
    fn process(&mut self, buf: &mut [f32], idx: u64) {
        self.dry.resize(buf.len(), 0.0);
        self.dry.copy_from_slice(buf);
        self.inner.process(buf, idx);
        blend(buf, &self.dry, self.mix);
    }
    fn set_param(&mut self, name: &str, v: f32) -> bool {
        match name {
            "failure" => {
                self.failure = v.clamp(0.0, 1.0);
                self.inner.set_failure(self.failure);
            }
            "hiss" => {
                self.hiss = v.clamp(0.0, 1.0);
                self.inner.set_hiss_amount(self.hiss);
            }
            "wow_ms" => {
                self.wow_ms = v.max(0.0);
                self.inner.wow_flutter_mut().set_wow_depth_ms(self.wow_ms);
            }
            "flutter_ms" => {
                self.flutter_ms = v.max(0.0);
                self.inner.wow_flutter_mut().set_flutter_depth_ms(self.flutter_ms);
            }
            "mix" => self.mix = v.clamp(0.0, 1.0),
            _ => return false,
        }
        true
    }
    fn params(&self) -> Vec<(&'static str, f32)> {
        vec![
            ("failure", self.failure),
            ("hiss", self.hiss),
            ("wow_ms", self.wow_ms),
            ("flutter_ms", self.flutter_ms),
            ("mix", self.mix),
        ]
    }
}

struct TransporterFx {
    inner: Transporter,
    send: Vec<f32>,
    grain_ms: f32,
    density: f32,
    offset_ms: f32,
    pitch: f32,
    spread: f32,
    reverse: f32,
    dry: f32, // through ("primary") level — 0 = pad only
    wet: f32, // reverse-grain pad level
}
impl TransporterFx {
    fn new(sr: f32) -> Self {
        let mut inner = Transporter::new(sr);
        inner.set_level(1.0); // wrapper `wet` scales the send
        inner.set_grain_ms(200.0);
        inner.set_density(30.0);
        inner.set_offset_ms(150.0);
        inner.set_reverse(true);
        inner.set_spread(0.3);
        TransporterFx {
            inner,
            send: Vec::new(),
            grain_ms: 200.0,
            density: 30.0,
            offset_ms: 150.0,
            pitch: 1.0,
            spread: 0.3,
            reverse: 1.0,
            dry: 1.0,
            wet: 0.6,
        }
    }
}
impl Effect for TransporterFx {
    fn kind(&self) -> &'static str {
        "transporter"
    }
    fn process(&mut self, buf: &mut [f32], _idx: u64) {
        self.send.resize(buf.len(), 0.0);
        self.inner.process(buf, &mut self.send);
        let (dry, wet) = (self.dry, self.wet);
        for (o, &w) in buf.iter_mut().zip(self.send.iter()) {
            *o = *o * dry + w * wet;
        }
    }
    fn set_param(&mut self, name: &str, v: f32) -> bool {
        match name {
            "grain_ms" => {
                self.grain_ms = v.max(5.0);
                self.inner.set_grain_ms(self.grain_ms);
            }
            "density" => {
                self.density = v.clamp(0.0, 100.0);
                self.inner.set_density(self.density);
            }
            "offset_ms" => {
                self.offset_ms = v.max(0.0);
                self.inner.set_offset_ms(self.offset_ms);
            }
            "pitch" => {
                self.pitch = v.clamp(0.25, 4.0);
                self.inner.set_pitch(self.pitch);
            }
            "spread" => {
                self.spread = v.clamp(0.0, 4.0);
                self.inner.set_spread(self.spread);
            }
            "reverse" => {
                self.reverse = if v >= 0.5 { 1.0 } else { 0.0 };
                self.inner.set_reverse(self.reverse >= 0.5);
            }
            "dry" => self.dry = v.clamp(0.0, 1.0),
            "wet" => self.wet = v.clamp(0.0, 2.0),
            _ => return false,
        }
        true
    }
    fn params(&self) -> Vec<(&'static str, f32)> {
        vec![
            ("grain_ms", self.grain_ms),
            ("density", self.density),
            ("offset_ms", self.offset_ms),
            ("pitch", self.pitch),
            ("spread", self.spread),
            ("reverse", self.reverse),
            ("dry", self.dry),
            ("wet", self.wet),
        ]
    }
}

struct FreezeFx {
    inner: Freeze,
    send: Vec<f32>,
    amount: f32,
    dry: f32,
    wet: f32,
}
impl FreezeFx {
    fn new(sr: f32) -> Self {
        FreezeFx { inner: Freeze::new(sr), send: Vec::new(), amount: 0.0, dry: 1.0, wet: 1.0 }
    }
}
impl Effect for FreezeFx {
    fn kind(&self) -> &'static str {
        "freeze"
    }
    fn process(&mut self, buf: &mut [f32], _idx: u64) {
        self.send.resize(buf.len(), 0.0);
        self.inner.process(buf, &mut self.send);
        let (dry, wet) = (self.dry, self.wet);
        for (o, &w) in buf.iter_mut().zip(self.send.iter()) {
            *o = *o * dry + w * wet;
        }
    }
    fn set_param(&mut self, name: &str, v: f32) -> bool {
        match name {
            "amount" => {
                self.amount = v.clamp(0.0, 1.0);
                self.inner.set_amount(self.amount);
            }
            "dry" => self.dry = v.clamp(0.0, 1.0),
            "wet" => self.wet = v.clamp(0.0, 1.0),
            _ => return false,
        }
        true
    }
    fn params(&self) -> Vec<(&'static str, f32)> {
        vec![("amount", self.amount), ("dry", self.dry), ("wet", self.wet)]
    }
}

struct FilterFx {
    l: Svf,
    r: Svf,
    dry: Vec<f32>,
    freq: f32,
    res: f32,
    drive: f32,
    mode: f32, // 0=low 1=high 2=band 3=notch
    mix: f32,
}
impl FilterFx {
    fn new(sr: f32) -> Self {
        let mut s = FilterFx {
            l: Svf::new(sr),
            r: Svf::new(sr),
            dry: Vec::new(),
            freq: 1000.0,
            res: 0.3,
            drive: 0.0,
            mode: 0.0,
            mix: 1.0,
        };
        s.apply();
        s
    }
    fn apply(&mut self) {
        for svf in [&mut self.l, &mut self.r] {
            svf.set_freq(self.freq);
            svf.set_res(self.res);
            svf.set_drive(self.drive);
        }
    }
}
fn svf_out(s: &Svf, mode: f32) -> f32 {
    match mode.round() as i32 {
        1 => s.high(),
        2 => s.band(),
        3 => s.notch(),
        _ => s.low(),
    }
}
impl Effect for FilterFx {
    fn kind(&self) -> &'static str {
        "filter"
    }
    fn process(&mut self, buf: &mut [f32], _idx: u64) {
        self.dry.resize(buf.len(), 0.0);
        self.dry.copy_from_slice(buf);
        let frames = buf.len() / 2;
        for i in 0..frames {
            self.l.process(buf[2 * i]);
            buf[2 * i] = svf_out(&self.l, self.mode);
            self.r.process(buf[2 * i + 1]);
            buf[2 * i + 1] = svf_out(&self.r, self.mode);
        }
        blend(buf, &self.dry, self.mix);
    }
    fn set_param(&mut self, name: &str, v: f32) -> bool {
        match name {
            "freq" => {
                self.freq = v.clamp(20.0, 16000.0);
                self.apply();
            }
            "res" => {
                self.res = v.clamp(0.0, 1.0);
                self.apply();
            }
            "drive" => {
                self.drive = v.clamp(0.0, 1.0);
                self.apply();
            }
            "mode" => self.mode = v.clamp(0.0, 3.0),
            "mix" => self.mix = v.clamp(0.0, 1.0),
            _ => return false,
        }
        true
    }
    fn params(&self) -> Vec<(&'static str, f32)> {
        vec![
            ("freq", self.freq),
            ("res", self.res),
            ("drive", self.drive),
            ("mode", self.mode),
            ("mix", self.mix),
        ]
    }
}

struct BloomFx {
    inner: BloomBank,
    amount: f32,
    dry: f32,
    wet: f32,
}
impl BloomFx {
    fn new(sr: f32) -> Self {
        let mut inner = BloomBank::new(sr);
        inner.set_amount(0.5);
        BloomFx { inner, amount: 0.5, dry: 1.0, wet: 0.5 }
    }
}
impl Effect for BloomFx {
    fn kind(&self) -> &'static str {
        "bloom"
    }
    fn process(&mut self, buf: &mut [f32], _idx: u64) {
        let frames = buf.len() / 2;
        let (dry, wet) = (self.dry, self.wet);
        for i in 0..frames {
            let mono = (buf[2 * i] + buf[2 * i + 1]) * 0.5;
            let w = self.inner.tick(mono) * wet;
            buf[2 * i] = buf[2 * i] * dry + w;
            buf[2 * i + 1] = buf[2 * i + 1] * dry + w;
        }
    }
    fn set_param(&mut self, name: &str, v: f32) -> bool {
        match name {
            "amount" => {
                self.amount = v.clamp(0.0, 1.0);
                self.inner.set_amount(self.amount);
            }
            "dry" => self.dry = v.clamp(0.0, 1.0),
            "wet" => self.wet = v.clamp(0.0, 1.0),
            _ => return false,
        }
        true
    }
    fn params(&self) -> Vec<(&'static str, f32)> {
        vec![("amount", self.amount), ("dry", self.dry), ("wet", self.wet)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    #[test]
    fn every_kind_builds_and_round_trips() {
        for &kind in KINDS {
            let fx = make(kind, SR).unwrap_or_else(|| panic!("make {kind}"));
            let node = to_node(fx.as_ref());
            assert_eq!(node.kind, kind);
            // rebuild from the node and confirm params match
            let fx2 = from_node(&node, SR).unwrap();
            assert_eq!(fx2.params(), fx.params(), "{kind} params round-trip");
        }
    }

    #[test]
    fn chain_processes_finite_bounded_audio() {
        let mut chain = FxChain::new(SR);
        for &kind in KINDS {
            assert!(chain.add(kind, None), "add {kind}");
        }
        assert_eq!(chain.len(), KINDS.len());
        // a few seconds of a 220 Hz tone through the whole chain
        let mut idx = 0u64;
        for _ in 0..200 {
            let mut buf = vec![0.0f32; 512];
            for i in 0..256 {
                let t = (idx + i as u64) as f32 / SR;
                let s = (t * 220.0 * std::f32::consts::TAU).sin() * 0.2;
                buf[2 * i] = s;
                buf[2 * i + 1] = s;
            }
            chain.process(&mut buf, idx);
            assert!(buf.iter().all(|x| x.is_finite()), "no NaN/Inf through the chain");
            idx += 256;
        }
    }

    #[test]
    fn add_remove_move_and_param() {
        let mut chain = FxChain::new(SR);
        chain.add("reverb", None);
        chain.add("delay", None);
        assert!(chain.add("filter", Some(1))); // reverb, filter, delay
        assert_eq!(chain.to_nodes().iter().map(|n| n.kind.clone()).collect::<Vec<_>>(), ["reverb", "filter", "delay"]);
        assert!(chain.move_fx(0, 2)); // filter, delay, reverb
        assert_eq!(chain.to_nodes()[2].kind, "reverb");
        assert!(chain.set_param(2, "room_size", 0.9));
        assert!(!chain.set_param(2, "nonexistent", 0.0));
        assert!(chain.remove(0));
        assert_eq!(chain.len(), 2);
        assert!(!chain.add("nope", None));
    }

    #[test]
    fn unknown_kinds_are_skipped_on_load() {
        let mut chain = FxChain::new(SR);
        let nodes = vec![
            FxNode { kind: "reverb".into(), params: Default::default() },
            FxNode { kind: "bogus".into(), params: Default::default() },
            FxNode { kind: "delay".into(), params: Default::default() },
        ];
        chain.set_nodes(&nodes);
        assert_eq!(chain.len(), 2, "bogus kind dropped");
    }
}
