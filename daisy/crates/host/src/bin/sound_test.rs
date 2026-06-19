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

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use cpal::traits::{DeviceTrait as _, StreamTrait as _};
use dsp::{FmPatch, WtPatch};

use host::audio::{open_default_output, run_output};
use host::rigs::{BellRig, Rig, TransporterRig, VoiceRig, DEFAULT_FM_NOTE};

/// The browser editor's wavetable preset dir, resolved at compile time so it
/// works regardless of the run directory: `<repo>/static/audio/presets/wt`.
const WT_PRESET_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../static/audio/presets/wt");

/// Which foreground voice to audition.
#[derive(Clone, Copy, Debug)]
enum Mode {
    Bell,
    Industrial,
    Voice,
    Transporter,
}

impl Mode {
    fn label(self) -> &'static str {
        match self {
            Mode::Bell => "bell",
            Mode::Industrial => "industrial",
            Mode::Voice => "voice",
            Mode::Transporter => "transporter",
        }
    }
}

struct Args {
    mode: Mode,
    every: u64,
    /// `--wt=NAME` — load a `presets/wt/NAME.json` (or a path) as the
    /// transporter's source wavetable patch.
    wt_load: Option<String>,
    /// `--save-wt=NAME` — write the active wavetable patch to
    /// `presets/wt/NAME.json` (or a path).
    wt_save: Option<String>,
}

/// Parse the CLI. Defaults: bell, 10 s.
fn parse_args() -> Args {
    let mut a = Args { mode: Mode::Bell, every: 10, wt_load: None, wt_save: None };
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "bell" => a.mode = Mode::Bell,
            "industrial" => a.mode = Mode::Industrial,
            "voice" | "pain" | "pain-material" => a.mode = Mode::Voice,
            "transporter" | "pad" => a.mode = Mode::Transporter,
            "-h" | "--help" => {
                println!(
                    "usage: sound_test [bell|industrial|voice|transporter] [--every=SECS] \
                     [--wt=NAME] [--save-wt=NAME]\n\
                     \n\
                     bell         FM bell (firmware ch0 patch)\n\
                     industrial   industrial stab (firmware ch1 patch)\n\
                     voice        formant speech through reverb, cycling all phrases\n\
                     transporter  reverse-grain pad through dsp::transporter (CC20-27 tunable)\n\
                     --every=N    seconds between triggers (default 10)\n\
                     --wt=NAME    load presets/wt/NAME.json (or a path) as the wavetable source\n\
                     --save-wt=N  save the active wavetable patch to presets/wt/N.json (or a path)"
                );
                std::process::exit(0);
            }
            s if s.starts_with("--every=") => match s["--every=".len()..].parse::<u64>() {
                Ok(n) if n > 0 => a.every = n,
                _ => {
                    eprintln!("bad --every value {s:?}; want a positive integer");
                    std::process::exit(2);
                }
            },
            s if s.starts_with("--wt=") => a.wt_load = Some(s["--wt=".len()..].to_string()),
            s if s.starts_with("--save-wt=") => a.wt_save = Some(s["--save-wt=".len()..].to_string()),
            other => {
                eprintln!("unknown arg {other:?}; try --help");
                std::process::exit(2);
            }
        }
    }
    a
}

/// Resolve a `--wt`/`--save-wt` argument to a file path: a direct path if it
/// exists (or ends in `.json`/contains `/`), else `presets/wt/<name>.json`.
fn wt_preset_path(name: &str) -> PathBuf {
    let direct = Path::new(name);
    if direct.exists() || name.ends_with(".json") || name.contains('/') {
        direct.to_path_buf()
    } else {
        Path::new(WT_PRESET_DIR).join(format!("{name}.json"))
    }
}

fn load_wt_patch(name: &str) -> Result<WtPatch> {
    let path = wt_preset_path(name);
    let txt = std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("read {}: {e}", path.display()))?;
    let patch: WtPatch = serde_json::from_str(&txt)
        .map_err(|e| anyhow::anyhow!("parse {}: {e}", path.display()))?;
    println!("loaded wt patch: {}", path.display());
    Ok(patch)
}

fn save_wt_patch(name: &str, patch: &WtPatch) -> Result<()> {
    let path = wt_preset_path(name);
    let json = serde_json::to_string_pretty(patch)?;
    std::fs::write(&path, json + "\n")
        .map_err(|e| anyhow::anyhow!("write {}: {e}", path.display()))?;
    println!("saved wt patch: {}", path.display());
    Ok(())
}

fn main() -> Result<()> {
    let Args { mode, every, wt_load, wt_save } = parse_args();

    let out = open_default_output()?;
    println!(
        "output: {}  sr={} Hz  ch={}  fmt={:?}",
        out.device.name().unwrap_or_else(|_| "<unnamed>".into()),
        out.sample_rate,
        out.channels,
        out.format,
    );

    // The transporter's wavetable source patch: a loaded preset (--wt) or the
    // built-in default. --save-wt writes whichever it ends up being.
    let wt_patch = match &wt_load {
        Some(name) => load_wt_patch(name)?,
        None => WtPatch::default(),
    };
    if let Some(name) = &wt_save {
        save_wt_patch(name, &wt_patch)?;
    }

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
        Mode::Transporter => {
            let mut r = TransporterRig::new(out.sample_rate);
            r.set_wt_patch(wt_patch.clone());
            Arc::new(Mutex::new(r))
        }
    };
    rig.lock().unwrap().prime();

    let stream = run_output(&out, rig.clone())?;
    stream.play()?;

    // Live CC tuning (transporter maps CC20-27; other rigs ignore). Keep the
    // connection alive for the program's lifetime.
    if matches!(mode, Mode::Transporter) {
        println!("CC map:\n{}", host::rigs::TransporterRig::CC_HELP);
    }
    let _midi = connect_midi_rig(rig.clone());

    println!("auditioning '{}' every {every} s — Ctrl-C to stop", mode.label());
    loop {
        let what = rig.lock().unwrap().trigger();
        println!("{what}");
        std::thread::sleep(Duration::from_secs(every));
    }
}

/// Open a MIDI input and route control-changes to the rig's `handle_cc`
/// (live tuning). Returns the connection to keep alive; `None` if no port /
/// midir error. `MIDI_PORT=N` picks the port (default 0).
fn connect_midi_rig(
    rig: Arc<Mutex<dyn Rig + Send>>,
) -> Option<midir::MidiInputConnection<()>> {
    use midir::{Ignore, MidiInput};
    let mut midi_in = MidiInput::new("ambient-viz sound_test").ok()?;
    midi_in.ignore(Ignore::None);
    let ports = midi_in.ports();
    if ports.is_empty() {
        eprintln!("no MIDI input ports — CC tuning disabled");
        return None;
    }
    let idx = std::env::var("MIDI_PORT")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0)
        .min(ports.len() - 1);
    let port = &ports[idx];
    println!("MIDI in: [{idx}] {}", midi_in.port_name(port).unwrap_or_default());
    midi_in
        .connect(
            port,
            "midi-in",
            move |_t, bytes, _| {
                if let Some(dsp::MidiMessage::ControlChange { channel, cc, value }) =
                    dsp::midi::decode(bytes)
                {
                    println!("  CC#{cc} = {value}  (ch{channel})");
                    rig.lock().unwrap().handle_cc(cc, value);
                }
            },
            (),
        )
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wt_patch_round_trips_and_editor_presets_parse() {
        // the default serializes and re-parses (the --save-wt path)
        let p = WtPatch::default();
        let json = serde_json::to_string_pretty(&p).unwrap();
        let _back: WtPatch = serde_json::from_str(&json).unwrap();
        // every existing editor preset deserializes into WtPatch (the --wt path)
        if let Ok(dir) = std::fs::read_dir(WT_PRESET_DIR) {
            for e in dir.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "json")) {
                let txt = std::fs::read_to_string(e.path()).unwrap();
                serde_json::from_str::<WtPatch>(&txt)
                    .unwrap_or_else(|err| panic!("{}: {err}", e.path().display()));
            }
        }
    }
}
