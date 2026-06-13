//! orrery-audio-tap — the audio analysis sidecar (AUDIO_ANALYSIS_SIDECAR.md).
//!
//! Stage 1: source (capture or file, by cargo feature + flag) → the
//! compat analysers (a numeric AnalyserNode emulation, so
//! bass/mid/treble/level/bass_fast are the browser tap's NUMBERS) + the
//! filterbank detector bank (kick/pad/lead envelopes, kick_onset EVENTs)
//! → TapPublisher → POST /bus/publish, at the SHADOW priority (250 —
//! below the browser tap's 300 on the shared compat paths; the detector
//! and onset surfaces have no incumbent and resolve from here). File
//! mode slaves decode position to clock.daisy.* over /bus/events.

// Pure DSP (analyser/bands/detector/trace) lives in the lib so the binary
// and the WASM tuning preview share ONE implementation. I/O modules stay
// bin-local.
mod bus;
mod clockfeed;
mod publisher;
mod songclock;
mod source;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use clap::Parser;

use orrery_audio_tap::analyser::CompatAnalyser;
use orrery_audio_tap::bands;
use orrery_audio_tap::detector::{self, DetectorBank};
use orrery_audio_tap::trace::analyze_mono;

use bus::{BusClient, PostResult};
use publisher::{next_boot_epoch, paths, Config, TapPublisher};
use source::AudioSource;

#[derive(Parser, Debug)]
#[command(name = "orrery-audio-tap", about, version)]
struct Args {
    /// Bridge base URL (the /bus/publish ingress + /bus/events clock feed)
    #[arg(long, default_value = "http://127.0.0.1:8080")]
    bridge: String,

    /// Capture device name ("default", a substring, or "pipewire" +
    /// PIPEWIRE_NODE=<node> for the Daisy UAC node — see README)
    #[cfg(feature = "capture")]
    #[arg(long)]
    device: Option<String>,

    /// Decode this file instead of capturing (clock-slaved to
    /// clock.daisy.position unless --free-run)
    #[cfg(feature = "file")]
    #[arg(long)]
    file: Option<PathBuf>,

    /// File mode: ignore the bus clock, pace against the wall clock
    #[cfg(feature = "file")]
    #[arg(long)]
    free_run: bool,

    /// Tuning harness: decode --file flat out (no bridge, no publishing)
    /// and write a JSON trace of bands + detector envelopes + onsets for
    /// tools/tuning/detector-viewer.html
    #[cfg(feature = "file")]
    #[arg(long)]
    trace_out: Option<PathBuf>,

    /// detector-params.v1 file (band edges + attack/release + onset gate);
    /// missing fields fall back to the research defaults. Used by BOTH
    /// trace and live-publish runs — the tuning artifact is the production
    /// artifact (tools/tuning/).
    #[arg(long)]
    params: Option<PathBuf>,

    /// Onset-gate quick overrides (applied ON TOP of --params / defaults;
    /// the single-knob nudge without editing the file)
    #[arg(long)]
    onset_threshold: Option<f64>,
    #[arg(long)]
    onset_cooldown_ms: Option<f64>,
    #[arg(long)]
    onset_baseline_tau_s: Option<f64>,

    /// Publish priority: 250 = shadow under the browser tap (default),
    /// 300 = authoritative post-cutover
    #[arg(long, default_value_t = 250)]
    priority: i64,

    /// Boot-epoch counter file (BUS_PROTOCOL ordering key)
    #[arg(long, default_value = ".orrery-audio-tap-epoch")]
    epoch_file: PathBuf,

    /// Print packets to stdout instead of POSTing
    #[arg(long)]
    dry_run: bool,
}

fn open_source(args: &Args) -> Result<Box<dyn AudioSource>, String> {
    #[cfg(feature = "file")]
    if let Some(path) = &args.file {
        let clock = if args.free_run || args.dry_run {
            None
        } else {
            Some(Arc::new(clockfeed::ClockFeed::start(&args.bridge)))
        };
        return Ok(Box::new(source::file::FileSource::open(path, clock, false)?));
    }
    #[cfg(feature = "capture")]
    {
        let device = args.device.as_deref().unwrap_or("default");
        return Ok(Box::new(source::capture::CaptureSource::open(device)?));
    }
    #[allow(unreachable_code)]
    Err("no audio source: build with `capture` and/or `file` features and pass --device/--file".into())
}

/// Effective detector params: research defaults < --params file < the
/// individual --onset-* flags (the single-knob nudge wins). Exits on a
/// bad params file rather than silently running defaults.
fn detector_params(args: &Args) -> detector::DetectorParams {
    let mut p = match &args.params {
        Some(path) => match detector::DetectorParams::load(path) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("audio-tap: {e}");
                std::process::exit(2);
            }
        },
        None => detector::DetectorParams::default(),
    };
    if let Some(t) = args.onset_threshold {
        p.onset.threshold = t;
    }
    if let Some(ms) = args.onset_cooldown_ms {
        p.onset.cooldown_s = ms / 1000.0;
    }
    if let Some(tau) = args.onset_baseline_tau_s {
        p.onset.baseline_tau_s = tau;
    }
    p
}

// ── trace mode (the tuning harness's data half) ─────────────────────────────
// Decode the file flat out and emit audiotap-trace.v1: one row per 50 ms of
// SONG time (sample-counted, deterministic) carrying the band values, the
// detector envelopes, the onset gate's internals (baseline + deviation —
// what tuning actually adjusts against), and every onset fire. The viewer
// is tools/tuning/detector-viewer.html.
#[cfg(feature = "file")]
fn trace_run(args: &Args, file: &std::path::Path, out: &std::path::Path) -> Result<(), String> {
    use std::fmt::Write as _;

    let dp = detector_params(args);

    // Decode the whole file to mono, then run the SHARED batch analyzer —
    // the same analyze_mono the WASM preview calls, so the offline trace
    // and the browser preview can't diverge.
    let mut src = source::file::FileSource::open(file, None, true)?;
    let mut mono: Vec<f32> = Vec::new();
    let mut chunk: Vec<f32> = Vec::new();
    let mut sr: u32 = 0;
    while let Some(block) = src.next_block() {
        if sr == 0 {
            sr = block.sample_rate;
        }
        block.downmix_into(&mut chunk);
        mono.extend_from_slice(&chunk);
    }
    if sr == 0 {
        return Err("decoded no audio".into());
    }
    let tr = analyze_mono(&mono, sr, &dp);

    let mut rows = String::new();
    for (i, r) in tr.rows.iter().enumerate() {
        if i > 0 {
            rows.push(',');
        }
        let _ = write!(
            rows,
            "[{:.3},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4}]",
            r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14],
        );
    }
    let mut onsets = String::new();
    for (i, (t, s)) in tr.onsets.iter().enumerate() {
        if i > 0 {
            onsets.push(',');
        }
        let _ = write!(onsets, "[{:.3},{:.3}]", t, s);
    }

    // Echo the EFFECTIVE params (the viewer seeds its editor from these,
    // and they're a detector-params.v1 verbatim — round-trips straight
    // back in as --params).
    let ch = |c: &detector::ChainParams| serde_json::json!({
        "band_hz": c.band_hz, "attack_s": c.attack_s, "release_s": c.release_s });
    let fx = |c: &detector::FluxChannelParams| serde_json::json!({
        "band_hz": c.band_hz, "compress": c.compress });
    let meta = serde_json::json!({
        "schema": "audiotap-trace.v1",
        "file": file.display().to_string(),
        "sample_rate": tr.sample_rate,
        "row_ms": orrery_audio_tap::trace::ROW_MS,
        "columns": orrery_audio_tap::trace::COLUMNS,
        "params": {
            "schema": "detector-params.v1",
            "kick": ch(&dp.kick),
            "pad": ch(&dp.pad),
            "lead": ch(&dp.lead),
            "onset": { "threshold": dp.onset.threshold, "cooldown_s": dp.onset.cooldown_s, "baseline_tau_s": dp.onset.baseline_tau_s },
            "flux": {
                "kick": fx(&dp.flux.kick), "click": fx(&dp.flux.click),
                "score": { "kick_weight": dp.flux.score.kick_weight, "click_weight": dp.flux.score.click_weight },
            },
        },
    });
    let body = format!(
        "{{\"meta\":{},\"rows\":[{}],\"onsets\":[{}]}}\n",
        serde_json::to_string(&meta).unwrap(), rows, onsets,
    );
    std::fs::write(out, body).map_err(|e| format!("{}: {e}", out.display()))?;
    eprintln!(
        "audio-tap: trace -> {} ({} rows, {} onsets, onset {:?})",
        out.display(), tr.rows.len(), tr.onsets.len(), dp.onset
    );
    Ok(())
}

fn main() {
    let args = Args::parse();

    #[cfg(feature = "file")]
    if let Some(out) = args.trace_out.clone() {
        let Some(file) = args.file.clone() else {
            eprintln!("audio-tap: --trace-out requires --file");
            std::process::exit(2);
        };
        match trace_run(&args, &file, &out) {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("audio-tap: trace failed: {e}");
                std::process::exit(2);
            }
        }
    }

    let mut src = match open_source(&args) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("audio-tap: {e}");
            std::process::exit(2);
        }
    };

    let now_sec = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(1);
    let epoch = next_boot_epoch(&args.epoch_file, now_sec);
    let mut cfg = Config::shadow(epoch);
    cfg.priority = args.priority;
    let mut publisher = TapPublisher::new(cfg);

    let client = BusClient::new(&args.bridge);
    let dry = args.dry_run;
    let mut post = move |pkts: &[bus::Packet]| -> PostResult {
        if dry {
            println!("{}", serde_json::to_string(pkts).unwrap());
            return PostResult::Ok;
        }
        client.publish(pkts)
    };

    // Browser parity: main analyser (2048, smoothing 0.85) + transient
    // analyser (1024, 0.3); smoothing stepped at the page's rAF cadence,
    // sample-counted (sample_rate/60) so file mode is deterministic.
    let mut main_an = CompatAnalyser::new(2048, 0.85);
    let mut trans_an = CompatAnalyser::new(1024, 0.3);
    let dp = detector_params(&args);
    let mut bank: Option<DetectorBank> = None; // needs the source rate
    let mut tick_every: u64 = 800;
    let mut since_tick: u64 = 0;
    let mut time_bytes: Vec<u8> = Vec::new();
    let mut mono: Vec<f32> = Vec::new();
    let mut fires: Vec<detector::OnsetFire> = Vec::new();
    let t0 = Instant::now();

    eprintln!(
        "audio-tap: {} -> {} (priority {}, epoch {}{})",
        src.describe(),
        args.bridge,
        args.priority,
        epoch,
        if dry { ", DRY RUN" } else { "" }
    );

    while let Some(block) = src.next_block() {
        let sr = block.sample_rate;
        let bank = bank.get_or_insert_with(|| {
            tick_every = (sr as u64 / 60).max(1);
            DetectorBank::from_params(sr as f64, &dp)
        });
        block.downmix_into(&mut mono);

        main_an.push(&mono);
        trans_an.push(&mono);
        since_tick += mono.len() as u64;
        while since_tick >= tick_every {
            since_tick -= tick_every;
            main_an.tick();
            trans_an.tick();
        }

        fires.clear();
        let det = bank.process(&mono, &mut fires);
        let at_ms = t0.elapsed().as_secs_f64() * 1000.0;
        for f in &fires {
            publisher.event(paths::KICK_ONSET, f.strength, at_ms, &mut post);
        }

        main_an.time_bytes_into(&mut time_bytes);
        let b = bands::compute_bands(
            main_an.freq_bytes(),
            &time_bytes,
            Some(trans_an.freq_bytes()),
            sr as f64,
        );
        publisher.frame(
            &[
                (paths::BASS, b.bass),
                (paths::MID, b.mid),
                (paths::TREBLE, b.treble),
                (paths::LEVEL, b.level),
                (paths::BASS_FAST, b.bass_fast),
                (paths::PEAK, b.peak), // slice-max aggregated in the publisher
                (paths::KICK, det.kick),
                (paths::PAD, det.pad),
                (paths::LEAD, det.lead),
            ],
            at_ms,
            &mut post,
        );
        if publisher.disabled() {
            eprintln!("audio-tap: disabled by the bridge (403) — exiting");
            std::process::exit(3);
        }
    }

    let c = publisher.counters();
    eprintln!(
        "audio-tap: source ended — {} packets over {} posts, {} errors",
        c.packets, c.posts, c.errors
    );
}
