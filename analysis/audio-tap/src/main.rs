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

mod analyser;
mod bands;
mod bus;
mod clockfeed;
mod detector;
mod publisher;
mod songclock;
mod source;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use clap::Parser;

use analyser::CompatAnalyser;
use bus::{BusClient, PostResult};
use detector::DetectorBank;
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
        return Ok(Box::new(source::file::FileSource::open(path, clock)?));
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

    // Browser parity: main analyser (2048, smoothing 0.85) + transient
    // analyser (1024, 0.3); smoothing stepped at the page's rAF cadence,
    // sample-counted (sample_rate/60) so file mode is deterministic.
    let mut main_an = CompatAnalyser::new(2048, 0.85);
    let mut trans_an = CompatAnalyser::new(1024, 0.3);
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
            DetectorBank::new(sr as f64)
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
