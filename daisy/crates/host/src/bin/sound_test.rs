//! Audition the firmware's "on top of the mix" foreground voices on the desktop,
//! without the Daisy. The voice rigs (hand-rolled the way firmware sums them,
//! not via `dsp::Engine`) live in `host::rigs`; this bin just picks one and
//! triggers it on a timer. There's no backing track here, so each voice is
//! judged in isolation.
//!
//!   cargo run -p host --bin sound_test            # bell (default)
//!   cargo run -p host --bin sound_test -- bell        # FM bell (ch0 patch)
//!   cargo run -p host --bin sound_test -- industrial  # industrial stab (ch1 patch)
//!   cargo run -p host --bin sound_test -- voice       # "pain material" speech
//!   cargo run -p host --bin sound_test -- voice --every=8
//!
//! The selected voice is triggered every `--every` seconds (default 10).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use cpal::traits::{DeviceTrait as _, StreamTrait as _};
use dsp::FmPatch;

use host::audio::{open_default_output, run_output};
use host::rigs::{BellRig, Rig, VoiceRig, DEFAULT_FM_NOTE};

/// Which foreground voice to audition.
#[derive(Clone, Copy, Debug)]
enum Mode {
    Bell,
    Industrial,
    Voice,
}

impl Mode {
    fn label(self) -> &'static str {
        match self {
            Mode::Bell => "bell",
            Mode::Industrial => "industrial",
            Mode::Voice => "voice",
        }
    }
}

/// Parse `[bell|industrial|voice] [--every=SECS]`. Defaults: bell, 10 s.
fn parse_args() -> (Mode, u64) {
    let mut mode = Mode::Bell;
    let mut every = 10u64;
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "bell" => mode = Mode::Bell,
            "industrial" => mode = Mode::Industrial,
            "voice" | "pain" | "pain-material" => mode = Mode::Voice,
            "-h" | "--help" => {
                println!(
                    "usage: sound_test [bell|industrial|voice] [--every=SECS]\n\
                     \n\
                     bell        FM bell (firmware ch0 patch)\n\
                     industrial  industrial stab (firmware ch1 patch)\n\
                     voice       formant speech through reverb, cycling all phrases\n\
                     --every=N   seconds between triggers (default 10)"
                );
                std::process::exit(0);
            }
            s if s.starts_with("--every=") => match s["--every=".len()..].parse::<u64>() {
                Ok(n) if n > 0 => every = n,
                _ => {
                    eprintln!("bad --every value {s:?}; want a positive integer");
                    std::process::exit(2);
                }
            },
            other => {
                eprintln!("unknown arg {other:?}; use bell | industrial | voice [--every=SECS]");
                std::process::exit(2);
            }
        }
    }
    (mode, every)
}

fn main() -> Result<()> {
    let (mode, every) = parse_args();

    let out = open_default_output()?;
    println!(
        "output: {}  sr={} Hz  ch={}  fmt={:?}",
        out.device.name().unwrap_or_else(|_| "<unnamed>".into()),
        out.sample_rate,
        out.channels,
        out.format,
    );

    // bell/industrial are the same FM rig with a different patch (note 81 = A5,
    // the install default); voice is the speech rig, which cycles all phrases.
    let rig: Arc<Mutex<dyn Rig + Send>> = match mode {
        Mode::Bell => Arc::new(Mutex::new(BellRig::new(
            out.sample_rate,
            FmPatch::bell(),
            DEFAULT_FM_NOTE,
            "bell",
        ))),
        Mode::Industrial => Arc::new(Mutex::new(BellRig::new(
            out.sample_rate,
            FmPatch::industrial(),
            DEFAULT_FM_NOTE,
            "industrial",
        ))),
        Mode::Voice => Arc::new(Mutex::new(VoiceRig::new(out.sample_rate))),
    };
    rig.lock().unwrap().prime();

    let stream = run_output(&out, rig.clone())?;
    stream.play()?;

    println!("auditioning '{}' every {every} s — Ctrl-C to stop", mode.label());
    loop {
        let what = rig.lock().unwrap().trigger();
        println!("{what}");
        std::thread::sleep(Duration::from_secs(every));
    }
}
