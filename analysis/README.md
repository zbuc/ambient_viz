# analysis/ — control-plane Rust workspace

Rust that participates in the orrery control plane and is **not** on-Daisy
code (`daisy/` is the audio-plane node only; ruling 2026-06-11). First
member: `audio-tap`, the audio analysis sidecar — design of record:
[`AUDIO_ANALYSIS_SIDECAR.md`](../AUDIO_ANALYSIS_SIDECAR.md).

## orrery-audio-tap (stage 1)

Taps the audio plane, publishes `audio.main.*` as `bus.v1` packets through
the phase-8A `POST /bus/publish` ingress, under its own manifest identity
(`spiffe://pain-material.local/analysis/audio-tap`, role `audio_tap`), at
the **shadow priority 250** — the browser tap at 300 stays authoritative
on the shared compat paths until the cutover swaps priorities; the
detector/onset surfaces have no incumbent and resolve from this writer.

Three surfaces (all under the one `main` tap instance):

- **Compat bands** — `bass/mid/treble/level/bass_fast` from a numeric
  AnalyserNode emulation (Blackman → FFT → 1/N magnitude → per-bin 0.85 /
  0.3 smoothing stepped at ~60 Hz sample-counted → dB[-100,-30] → byte →
  the shared band math), so the cutover A/B against the browser tap
  compares numbers, not vibes.
- **Detector envelopes** — `kick/pad/lead` (STATE): cascaded RBJ bandpass
  pairs (40–120 / 200–800 / 2k–6k Hz) into attack/release followers.
  Band edges, taus, and the onset threshold are **project data** — the
  constants in `detector.rs` are research starting points, hand-tuning
  against the piece is a pending pass.
- **Onsets** — `kick_onset` (EVENT, payload = strength): envelope
  deviation over an adaptive baseline, hysteresis re-arm + 150 ms
  refractory. Events bypass the publisher's decimation/dedupe.

- **Slice aggregate** — `audio.main.peak` (STATE): max |sample| since the
  path's last published packet, accumulated across decimated frames in
  the publisher (both taps publish it; the time-slice lesson from the
  Analyze CHOP review — a point sample is blind to anything that rose and
  fell inside a publish gap).

The writer discipline (decimation / quantized dedupe / keepalive /
persisted boot epoch / 403 self-disable) is a port of
`static/audio-tap.js` with matching tests; the wire is pinned against a
captured browser-tap packet. In `file` mode the decode position is
**clock-slaved**: a background SSE reader feeds `clock.daisy.*` into the
SongClock port, pacing waits on the clock, and drift > 0.75 s (loop
wraps, bridge restarts) triggers an accurate seek — the job the kiosk
page's `?localaudio` mp3-sync hack does today. `--free-run` reverts to
wall pacing.

### Detector tuning (the trace harness)

```sh
cargo build --release    # ~10x faster traces than debug
./target/release/orrery-audio-tap \
  --file ../static/20251006_arrangement_1.mp3 \
  --trace-out /tmp/trace.json \
  --onset-threshold 0.06 --onset-cooldown-ms 150 --onset-baseline-tau-s 1.5
```

writes `audiotap-trace.v1`: one row per 50 ms of song time (bands,
detector envelopes, the onset gate's baseline + deviation) plus every
onset fire, with the exact params in the meta. View it against the audio
in `tools/tuning/detector-viewer.html` (file pickers, or serve the repo
and pass `?trace=…&audio=…`): the purple `kick_dev` trace against the
dashed threshold line is what you tune — adjust the `--onset-*` flags
(band/tau changes still mean editing `detector.rs::defaults`), re-trace,
reload. Constants graduate to project-data manifest entries once tuned.

### Build / run

Sources are cargo features (prod builds compile only what they need;
default carries both for dev):

```sh
cd analysis
cargo test                                   # all unit tests
cargo run -- --dry-run --file ../static/20251006_arrangement_1.mp3
                                             # decode the piece, print packets
cargo run -- --device default                # live capture -> bridge on :8080
cargo build --release --no-default-features --features capture   # Pi prod
```

### The kiosk capture device

The Daisy UAC node, already verified with `pw-record`:
`alsa_input.usb-ambient-viz_Daisy_audio_source_0001-00.analog-stereo`.
That's a **PipeWire node name**; cpal reaches it through the
pipewire-alsa bridge:

```sh
PIPEWIRE_NODE=alsa_input.usb-ambient-viz_Daisy_audio_source_0001-00.analog-stereo \
  orrery-audio-tap --device pipewire
```

(Direct `hw:` works if PipeWire releases the device; pipewire-rs is the
fallback. Verify at bring-up — the pw-record success already proves the
node clocks correctly, the historical capture fault was Chromium-side.)

### Gate

The standing gate is writer-agnostic: run a kiosk session with capture on,
then `node tools/sim/validate-audiotap.js <SESSION>` — this writer's
packets ride the same `bus_rx` lanes (hygiene/contract/order) as the
browser tap's.

### Notes

- Packet types in `src/bus.rs` are serde mirrors of `proto/bus.proto`'s
  proto-JSON rendering, pinned by a wire-compat test against a captured
  browser-tap packet; prost/pbjson codegen over the shared `proto/`
  replaces them when the schema surface grows.
- The boot-epoch counter persists in `.orrery-audio-tap-epoch` (cwd by
  default, `--epoch-file` to relocate) — same mechanism as the bridge's
  `.orrery-boot-epoch`.
