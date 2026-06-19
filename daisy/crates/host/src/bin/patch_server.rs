//! Live patch + FX preview server. Runs the firmware-exact source voices
//! (`host::rigs::PreviewRig`: FM stab + rumble bass + wavetable) plus an
//! editable insert **FX chain** on the Mac's audio output, and accepts edits
//! over localhost HTTP so the browser editors (static/audio) tune against the
//! REAL Rust DSP — the same code that's bit-compatible with the Daisy firmware.
//!
//!   cargo run -p host --bin patch_server [--port=8765]
//!
//! A "composite **instrument**" = the source patches + the FX chain. The FX
//! chain is NOT part of a patch — it's a separate, ordered list of insert
//! effects applied to the summed instrument, pre-master-limiter.
//!
//! Endpoints (CORS-open). See `daisy/PATCH_SERVER.md` for the full reference.
//!   GET  /health        -> "ok"   (editors probe this to switch to live mode)
//!
//!   Source patches (hot-swap; JSON = the firmware/SD schema):
//!   POST /fm/patch      <- FmPatch JSON     POST /fm/trigger    <- {"note":81}?
//!   POST /bass/patch    <- BassPatch JSON   POST /bass/trigger  <- {"note":38}?
//!   POST /wt/patch      <- WtPatch JSON     POST /wt/trigger    <- {"note":60}?
//!   POST /panic         -> kill all audio (voices + delay + FX tails)
//!
//!   FX chain (composite instrument):
//!   GET  /fx/catalog    -> [{kind, params:[{name,default,min,max}]}]  (available effects)
//!   GET  /fx/chain      -> [{kind, params:{..}}]   (the live chain)
//!   POST /fx/chain      <- [{kind, params:{..}}]   (replace the whole chain)
//!   POST /fx/add        <- {"kind":"reverb","index":0?}   (append or insert)
//!   POST /fx/remove     <- {"index":N}
//!   POST /fx/move       <- {"from":I,"to":J}
//!   POST /fx/param      <- {"index":N,"name":"mix","value":0.3}
//!
//!   Presets (this server reads/writes static/audio/presets/{fx,instrument}/*.json):
//!   GET  /fx/presets             -> ["name", ..]
//!   POST /fx/preset/save         <- {"name":"plate verb"}   (saves the live chain)
//!   POST /fx/preset/load         <- {"name":"plate verb"}
//!   POST /fx/preset/delete       <- {"name":"plate verb"}
//!   GET  /instrument/presets     -> ["name", ..]
//!   POST /instrument/save        <- {"name":"glass pad"}    (patches + chain)
//!   POST /instrument/load        <- {"name":"glass pad"}
//!   POST /instrument/delete      <- {"name":"glass pad"}

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait as _, StreamTrait as _};
use dsp::{BassPatch, FmPatch, WtPatch};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tiny_http::{Header, Method, Response, Server};

use host::audio::{open_default_output, run_output};
use host::fx::{self, FxNode, Instrument};
use host::rigs::{PreviewRig, Rig as _};

const DEFAULT_PORT: u16 = 8765;

/// `static/audio/presets`, resolved at compile time so the run directory
/// doesn't matter (same trick as `sound_test`'s wt-preset dir).
const PRESET_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../static/audio/presets");

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
    println!("open static/audio — it will detect the server and go live.");

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

        // ── source patches ──────────────────────────────────────────────
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

        // ── FX chain ─────────────────────────────────────────────────────
        (Method::Get, "/fx/catalog") => json_ok(&fx::catalog()),
        (Method::Get, "/fx/chain") => json_ok(&rig.lock().unwrap().fx().to_nodes()),
        (Method::Post, "/fx/chain") => match parse::<Vec<FxNode>>(body) {
            Ok(nodes) => { rig.lock().unwrap().fx().set_nodes(&nodes); (200, "ok".into()) }
            Err(e) => (400, e),
        },
        (Method::Post, "/fx/add") => match parse::<AddReq>(body) {
            Ok(r) => {
                if rig.lock().unwrap().fx().add(&r.kind, r.index) {
                    (200, "ok".into())
                } else {
                    (400, format!("unknown effect kind {:?}", r.kind))
                }
            }
            Err(e) => (400, e),
        },
        (Method::Post, "/fx/remove") => match parse::<IndexReq>(body) {
            Ok(r) => ok_or_400(rig.lock().unwrap().fx().remove(r.index), "index out of range"),
            Err(e) => (400, e),
        },
        (Method::Post, "/fx/move") => match parse::<MoveReq>(body) {
            Ok(r) => ok_or_400(rig.lock().unwrap().fx().move_fx(r.from, r.to), "index out of range"),
            Err(e) => (400, e),
        },
        (Method::Post, "/fx/param") => match parse::<ParamReq>(body) {
            Ok(r) => ok_or_400(
                rig.lock().unwrap().fx().set_param(r.index, &r.name, r.value),
                "bad index or param name",
            ),
            Err(e) => (400, e),
        },

        // ── FX presets (the live chain) ──────────────────────────────────
        (Method::Get, "/fx/presets") => json_ok(&list_presets(&fx_dir())),
        (Method::Post, "/fx/preset/save") => match parse::<NameReq>(body) {
            Ok(r) => {
                let nodes = rig.lock().unwrap().fx().to_nodes();
                respond(save_json(&fx_dir(), &r.name, &nodes))
            }
            Err(e) => (400, e),
        },
        (Method::Post, "/fx/preset/load") => match parse::<NameReq>(body) {
            Ok(r) => match load_json::<Vec<FxNode>>(&fx_dir(), &r.name) {
                Ok(nodes) => { rig.lock().unwrap().fx().set_nodes(&nodes); (200, "ok".into()) }
                Err(e) => (400, e),
            },
            Err(e) => (400, e),
        },
        (Method::Post, "/fx/preset/delete") => match parse::<NameReq>(body) {
            Ok(r) => respond(delete_json(&fx_dir(), &r.name)),
            Err(e) => (400, e),
        },

        // ── instrument presets (patches + chain) ─────────────────────────
        (Method::Get, "/instrument/presets") => json_ok(&list_presets(&instrument_dir())),
        (Method::Post, "/instrument/save") => match parse::<NameReq>(body) {
            Ok(r) => {
                let inst = rig.lock().unwrap().snapshot_instrument();
                respond(save_json(&instrument_dir(), &r.name, &inst))
            }
            Err(e) => (400, e),
        },
        (Method::Post, "/instrument/load") => match parse::<NameReq>(body) {
            // returns the loaded instrument so the editor can sync its UI
            Ok(r) => match load_json::<Instrument>(&instrument_dir(), &r.name) {
                Ok(inst) => { rig.lock().unwrap().load_instrument(&inst); json_ok(&inst) }
                Err(e) => (400, e),
            },
            Err(e) => (400, e),
        },
        (Method::Post, "/instrument/delete") => match parse::<NameReq>(body) {
            Ok(r) => respond(delete_json(&instrument_dir(), &r.name)),
            Err(e) => (400, e),
        },

        _ => (404, "not found".into()),
    }
}

// ── request bodies ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct AddReq {
    kind: String,
    #[serde(default)]
    index: Option<usize>,
}
#[derive(Deserialize)]
struct IndexReq {
    index: usize,
}
#[derive(Deserialize)]
struct MoveReq {
    from: usize,
    to: usize,
}
#[derive(Deserialize)]
struct ParamReq {
    index: usize,
    name: String,
    value: f32,
}
#[derive(Deserialize)]
struct NameReq {
    name: String,
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn parse<T: DeserializeOwned>(body: &[u8]) -> Result<T, String> {
    serde_json::from_slice(body).map_err(|e| format!("bad json: {e}"))
}

fn json_ok<T: Serialize>(value: &T) -> (u16, String) {
    match serde_json::to_string(value) {
        Ok(s) => (200, s),
        Err(e) => (500, format!("serialize: {e}")),
    }
}

fn ok_or_400(success: bool, err: &str) -> (u16, String) {
    if success { (200, "ok".into()) } else { (400, err.into()) }
}

fn respond(r: Result<(), String>) -> (u16, String) {
    match r {
        Ok(()) => (200, "ok".into()),
        Err(e) => (400, e),
    }
}

fn fx_dir() -> PathBuf {
    Path::new(PRESET_ROOT).join("fx")
}
fn instrument_dir() -> PathBuf {
    Path::new(PRESET_ROOT).join("instrument")
}

/// Preset name guard (matches the node server's rule): alphanumeric start,
/// then alphanumerics/space/_/- up to 64 chars. Keeps names path-safe.
fn valid_name(name: &str) -> bool {
    let len = name.len();
    if len == 0 || len > 64 {
        return false;
    }
    name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-'))
}

fn list_presets(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "json") {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    out.push(stem.to_string());
                }
            }
        }
    }
    out.sort();
    out
}

fn save_json<T: Serialize>(dir: &Path, name: &str, value: &T) -> Result<(), String> {
    if !valid_name(name) {
        return Err(format!("bad preset name {name:?}"));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.json"));
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&path, json + "\n").map_err(|e| format!("write {}: {e}", path.display()))
}

fn load_json<T: DeserializeOwned>(dir: &Path, name: &str) -> Result<T, String> {
    if !valid_name(name) {
        return Err(format!("bad preset name {name:?}"));
    }
    let path = dir.join(format!("{name}.json"));
    let txt = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&txt).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn delete_json(dir: &Path, name: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err(format!("bad preset name {name:?}"));
    }
    let path = dir.join(format!("{name}.json"));
    std::fs::remove_file(&path).map_err(|e| format!("delete {}: {e}", path.display()))
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
