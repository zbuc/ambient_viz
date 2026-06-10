//! Live patch preview server. Runs the firmware-exact FM stab + rumble bass +
//! wavetable voice (`host::rigs::PreviewRig`) on the Mac's audio output and
//! accepts patch edits over localhost HTTP, so the browser patch editors
//! (static/audio/patches, static/audio/wavetable) can tune against the REAL
//! Rust DSP — the same code that's bit-compatible with the Daisy firmware.
//!
//!   cargo run -p host --bin patch_server [--port=8765]
//!
//! Endpoints (CORS-open so the static dev server's origin can reach them):
//!   GET  /health        -> "ok"   (editor probes this to switch to live mode)
//!   POST /fm/patch      <- FmPatch JSON;   hot-swaps the stab patch
//!   POST /bass/patch    <- BassPatch JSON; hot-swaps the bass patch
//!   POST /wt/patch      <- WtPatch JSON;   hot-swaps the wavetable patch
//!   POST /fm/trigger    <- {"note":81}? (optional) strikes the stab
//!   POST /bass/trigger  <- {"note":38}? (optional) strikes the bass
//!   POST /wt/trigger    <- {"note":60}? (optional) strikes the wavetable voice
//!   POST /panic         -> kill all audio (bass/wt sustain, FM tail, delay ring)
//!
//! The JSON is the same schema the editor exports and the firmware reads off SD
//! — FmPatch/BassPatch/WtPatch derive serde in the `dsp` crate.

use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait as _, StreamTrait as _};
use dsp::{BassPatch, FmPatch, WtPatch};
use tiny_http::{Header, Method, Response, Server};

use host::audio::{open_default_output, run_output};
use host::rigs::{PreviewRig, Rig as _};

const DEFAULT_PORT: u16 = 8765;

fn parse_port() -> u16 {
    for arg in std::env::args().skip(1) {
        if let Some(v) = arg.strip_prefix("--port=") {
            match v.parse::<u16>() {
                Ok(p) => return p,
                Err(_) => {
                    eprintln!("bad --port value {v:?}");
                    std::process::exit(2);
                }
            }
        }
    }
    DEFAULT_PORT
}

fn main() -> Result<()> {
    let port = parse_port();

    let out = open_default_output()?;
    println!(
        "output: {}  sr={} Hz  ch={}  fmt={:?}",
        out.device.name().unwrap_or_else(|_| "<unnamed>".into()),
        out.sample_rate,
        out.channels,
        out.format,
    );

    let rig = Arc::new(Mutex::new(PreviewRig::new(out.sample_rate)));
    rig.lock().unwrap().prime();
    let stream = run_output(&out, rig.clone())?;
    stream.play()?;

    let addr = format!("127.0.0.1:{port}");
    let server = Server::http(&addr).map_err(|e| anyhow!("http server on {addr}: {e}"))?;
    println!("patch_server live on http://{addr}");
    println!("open static/audio/patches — it will detect the server and go live.");

    for request in server.incoming_requests() {
        serve(request, &rig);
    }
    Ok(())
}

/// Read the request body, route it, and respond with CORS headers.
fn serve(mut request: tiny_http::Request, rig: &Arc<Mutex<PreviewRig>>) {
    let method = request.method().clone();
    let path = request.url().split('?').next().unwrap_or("/").to_string();
    let mut body = Vec::new();
    let _ = request.as_reader().read_to_end(&mut body);

    let (code, msg) = route(method, &path, &body, rig);
    let resp = cors(Response::from_string(msg).with_status_code(code));
    let _ = request.respond(resp);
}

fn route(method: Method, path: &str, body: &[u8], rig: &Arc<Mutex<PreviewRig>>) -> (u16, String) {
    match (method, path) {
        // CORS preflight.
        (Method::Options, _) => (200, String::new()),
        (Method::Get, "/health") => (200, "ok".into()),

        (Method::Post, "/fm/patch") => match serde_json::from_slice::<FmPatch>(body) {
            Ok(p) => { rig.lock().unwrap().set_fm_patch(p); (200, "ok".into()) }
            Err(e) => (400, format!("bad FmPatch json: {e}")),
        },
        (Method::Post, "/bass/patch") => match serde_json::from_slice::<BassPatch>(body) {
            Ok(p) => { rig.lock().unwrap().set_bass_patch(p); (200, "ok".into()) }
            Err(e) => (400, format!("bad BassPatch json: {e}")),
        },
        (Method::Post, "/wt/patch") => match serde_json::from_slice::<WtPatch>(body) {
            Ok(p) => { rig.lock().unwrap().set_wt_patch(p); (200, "ok".into()) }
            Err(e) => (400, format!("bad WtPatch json: {e}")),
        },
        (Method::Post, "/wt/trigger") => {
            rig.lock().unwrap().trigger_wt(note_of(body));
            (200, "ok".into())
        }
        (Method::Post, "/fm/trigger") => {
            rig.lock().unwrap().trigger_fm(note_of(body));
            (200, "ok".into())
        }
        (Method::Post, "/bass/trigger") => {
            rig.lock().unwrap().trigger_bass(note_of(body));
            (200, "ok".into())
        }
        // Kill switch: silence every voice + the delay tail immediately.
        (Method::Post, "/panic") => {
            rig.lock().unwrap().silence();
            (200, "ok".into())
        }
        _ => (404, "not found".into()),
    }
}

/// Pull an optional MIDI `note` out of a `{"note":N}` body (absent → None).
fn note_of(body: &[u8]) -> Option<u8> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    v.get("note")?.as_u64().map(|n| n as u8)
}

fn cors<R: std::io::Read>(resp: Response<R>) -> Response<R> {
    let hdr = |k: &[u8], v: &[u8]| Header::from_bytes(k, v).unwrap();
    resp.with_header(hdr(b"Access-Control-Allow-Origin", b"*"))
        .with_header(hdr(b"Access-Control-Allow-Methods", b"GET, POST, OPTIONS"))
        .with_header(hdr(b"Access-Control-Allow-Headers", b"Content-Type"))
}
