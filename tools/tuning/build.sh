#!/bin/sh
# Build the detector tuning preview to tools/tuning/wasm/ — the SAME Rust
# DSP the sidecar runs, compiled to WASM so detector-viewer.html previews
# every param live (AUDIO_ANALYSIS_SIDECAR.md). Re-run after editing
# analysis/audio-tap/src/{analyser,bands,detector,trace}.rs — the viewer's
# live preview is only as fresh as this build (the wasm/ dir is gitignored;
# it's a build artifact, not source).
#
# Needs: rustup target add wasm32-unknown-unknown + wasm-pack.
set -e
cd "$(dirname "$0")/../../analysis"
wasm-pack build audio-tap --target web --out-dir ../../tools/tuning/wasm \
  --out-name detector --no-typescript
echo "built tools/tuning/wasm/ — reload detector-viewer.html"
