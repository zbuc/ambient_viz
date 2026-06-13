//! orrery-audio-tap library: the pure-DSP core — the compat analyser, the
//! filterbank detector bank, the band math, and the trace assembly that
//! drives them. No I/O lives here: SAMPLES IN, TRACE OUT. That's what lets
//! the EXACT SAME code run three places without a second implementation to
//! drift —
//!
//!   - the binary's `--trace-out` (decodes a file, calls `analyze_mono`),
//!   - the WASM tuning preview (browser decodes the audio, calls the same
//!     `analyze_mono` over wasm-bindgen — `src/wasm.rs`), and
//!   - the unit tests.
//!
//! Compiles to wasm32 with only realfft + serde (cpal/symphonia/clap/ureq
//! are the binary's, target-gated out of the wasm build in Cargo.toml).

pub mod analyser;
pub mod bands;
pub mod detector;
pub mod trace;

#[cfg(target_arch = "wasm32")]
mod wasm;
