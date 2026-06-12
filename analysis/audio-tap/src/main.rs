//! orrery-audio-tap — the audio analysis sidecar (AUDIO_ANALYSIS_SIDECAR.md).
//!
//! v0 scaffold: source (capture or file, by cargo feature + flag) →
//! sliding-window RMS → TapPublisher → POST /bus/publish, publishing
//! `audio.main.level` ONLY, at the SHADOW priority (250 — below the
//! browser tap's 300, so nothing downstream changes). The band compat
//! surface (AnalyserNode emulation) and the filterbank detector surface
//! are stage 1; this binary exists so the writer discipline, identity,
//! and transport are live and gateable (validate-audiotap.js judges this
//! writer's captures by the same lanes as the browser's).

// bands + songclock are stage-1 consumers (compat-band emulation, file
// clock-slave) — present, tested, not yet wired into the v0 loop.
#[allow(dead_code)]
mod bands;
mod bus;
mod publisher;
mod rms;
#[allow(dead_code)]
mod songclock;
mod source;

use std::path::PathBuf;
use std::time::Instant;

use clap::Parser;

use bus::{BusClient, PostResult};
use publisher::{next_boot_epoch, paths, Config, TapPublisher};
use source::AudioSource;

#[derive(Parser, Debug)]
#[command(name = "orrery-audio-tap", about, version)]
struct Args {
    /// Bridge base URL (the /bus/publish ingress)
    #[arg(long, default_value = "http://127.0.0.1:8080")]
    bridge: String,

    /// Capture device name ("default", a substring, or "pipewire" +
    /// PIPEWIRE_NODE=<node> for the Daisy UAC node — see README)
    #[cfg(feature = "capture")]
    #[arg(long)]
    device: Option<String>,

    /// Decode this file instead of capturing (paced at real time)
    #[cfg(feature = "file")]
    #[arg(long)]
    file: Option<PathBuf>,

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
        return Ok(Box::new(source::file::FileSource::open(path)?));
    }
    #[cfg(feature = "capture")]
    {
        let device = args.device.as_deref().unwrap_or("default");
        return Ok(Box::new(source::capture::CaptureSource::open(device)?));
    }
    #[allow(unreachable_code)]
    Err("no audio source: build with `capture` and/or `file` features and pass --device/--file".into())
}

fn main() {
    let args = Args::parse();

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

    // 2048 samples at the source rate ≈ the browser analyser's
    // time-domain window; resized to ~43 ms once the rate is known.
    let mut meter = rms::BlockRms::new(2048);
    let mut mono: Vec<f32> = Vec::new();
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
        block.downmix_into(&mut mono);
        meter.push(&mono);
        let at_ms = t0.elapsed().as_secs_f64() * 1000.0;
        publisher.frame(&[(paths::LEVEL, meter.value())], at_ms, &mut post);
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
