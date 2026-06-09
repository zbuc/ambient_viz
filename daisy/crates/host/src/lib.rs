//! Shared host-side audio harness for the macOS dev tools.
//!
//! The firmware-exact voice rigs and the cpal output plumbing live here so they
//! have a single source of truth, used by both binaries:
//!   - `sound_test`   — timed audition of each voice (Ctrl-C to stop)
//!   - `patch_server` — live patch editing driven by the browser patch editor
//!     (static/audio/patches) against the REAL Rust DSP.
//!
//! None of this runs `dsp::Engine`; like the firmware, each voice's sub-graph is
//! hand-rolled and summed in the firmware's master-bus order (see `rigs`).

pub mod audio;
pub mod rigs;
