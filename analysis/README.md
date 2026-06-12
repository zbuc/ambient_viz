# analysis/ — control-plane Rust workspace

Rust that participates in the orrery control plane and is **not** on-Daisy
code (`daisy/` is the audio-plane node only; ruling 2026-06-11). First
member: `audio-tap`, the audio analysis sidecar — design of record:
[`AUDIO_ANALYSIS_SIDECAR.md`](../AUDIO_ANALYSIS_SIDECAR.md).

## orrery-audio-tap (v0 scaffold)

Taps the audio plane, publishes `audio.main.*` as `bus.v1` packets through
the phase-8A `POST /bus/publish` ingress, under its own manifest identity
(`spiffe://pain-material.local/analysis/audio-tap`, role `audio_tap`), at
the **shadow priority 250** — the browser tap at 300 stays authoritative,
so running this changes nothing downstream until the cutover swaps
priorities.

**What v0 actually publishes: `audio.main.level` only** (sliding-window
linear RMS, the same semantic as the browser tap's level). The compat band
surface (AnalyserNode emulation → `bass/mid/treble/bass_fast`) and the
filterbank detector surface (`kick/pad/lead` + onset EVENTs) are stage-1
build work. What v0 *does* fully implement: the writer discipline
(decimation / quantized dedupe / keepalive / persisted boot epoch / 403
self-disable — ported from `static/audio-tap.js` with matching tests), the
wire (pinned against a browser-tap packet), and the SongClock port the
`file` mode's clock-slave will use.

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
