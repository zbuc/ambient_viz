# The audio analysis sidecar (Rust `dasp` tap)

**Status: design accepted 2026-06-12; build not started.** This is the
external-sidecar form of the `audio.main.*` tap from ARCHITECTURE.md →
*Audio analysis: one tap per thing you listen to* — a native Rust binary
that analyzes the audio plane and publishes derived control signals onto
the bus. It is a **run-location move, not a contract change**: the tap
publishes the same `audio.<tap>.*` names wherever it runs, and phase 8A
already shipped the contract (manifest, role, ranges/rates, the
`/bus/publish` ingress, the standing gate). Supersedes the one-line
BACKLOG.md entry; grounded in the dasp/filterbank/flux research
(conversation 2026-06-12, "Multiband audio detection with Rust and dasp").

## Why a sidecar

- **Decouple analysis from Chromium.** The browser tap is tied to
  Chromium's audio stack — which is exactly what's broken for live capture
  on the Pi (the PipeWire clocking fault, `daisy/PLAN_USB_CAPTURE.md`). A
  Rust process opens the capture device directly.
- **Analyze what the audience hears.** The kiosk page analyzes a muted
  local mp3 seek-synced to the Daisy (`?localaudio`) — a workaround that
  exists *only* to feed the in-page analyser. A sidecar tap retires it.
- **Richer detection than an AnalyserNode.** Per-instrument envelopes and
  onsets ("kick hitting", "pad swelling", "lead active") need a multiband
  filterbank and, later, spectral flux — not practical in the page.
- **One tap, N consumers.** Analysis decided once, upstream, is what makes
  multiple render nodes coherent (see *The two-projector test* below) and
  what lets graphs, the sequencer path, and Daisy CC bindings consume audio
  signals without each growing its own analyser.

## The DSP plan

Two stages, shipped in this order:

**Stage 1 — compat bands + filterbank detectors.**

- *Compat surface*: reproduce the browser tap's `bass/mid/treble/level/
  bass_fast` numerically — WebAudio's AnalyserNode is a specified
  algorithm (Blackman window → FFT → per-bin time smoothing 0.85 → dB clamp
  [-100,-30] → byte), so `realfft` + the same band averaging
  (`static/audio-tap.js computeBands`) reproduces today's values. This is
  what makes the cutover A/B a *numeric* comparison instead of a re-tune:
  the renderer (8C) must not see different curves when the writer swaps.
- *Detector surface*: a biquad bandpass filterbank (the `biquad` crate)
  with an independent `dasp_envelope::Detector` per band — attack/release
  pairs are the instrument detectors (fast attack + med release = kick;
  slow/slow = pad swell; med/med = lead presence). Time-domain, ~5
  multiply-adds per sample per band, updates every sample, a couple of
  samples of latency. Trivial CPU on a Pi (the Pi is GPU-bound, not
  CPU-bound).

**Stage 2 — spectral flux (when the filterbank confuses pad vs lead).**
Half-wave-rectified spectral flux over the same `realfft` frames, band-
limited per target. More discriminating onsets at the cost of block
latency (~21 ms at 1024/48k). Added only where stage 1 produces false
positives — the historical arc of the field, on purpose.

`dasp`'s role is the time-domain back half (peak/rms/envelope/window +
signal plumbing); it deliberately has no FFT — `realfft`/`rustfft`
(maintained, SIMD incl. NEON) own the transform.

## The signal surface

Everything under the existing tap instance — `audio.main.*` — declared in
the manifest like any writer:

- **Continuity set** (STATE, float ratio [0,1], ~20 Hz, exactly the 8A
  contract): `bass`, `mid`, `treble`, `level`, `bass_fast`.
- **Detector envelopes** (STATE, same shape): `kick`, `pad`, `lead` — names
  per the exhibit's actual stems, settled at band-tuning time against the
  18-minute piece.
- **Onsets** (EVENT, payload = strength, source-timestamped): `onset`,
  `kick_onset`, … . Events are not rate-decimated; consumers trigger off
  them (and may drop stale ones by timestamp — a late slice tear is worse
  than none).

## Sources (build flags, daisy alias discipline)

Two audio sources, selected by **cargo feature** (the daisy workspace's
house style), runtime config choosing device/path within what's compiled:

- **`capture`** — live input via cpal/ALSA, device opened directly (no
  PipeWire/Chromium in the path). The honest mode for live musicians and
  the kiosk end state.
- **`file`** — decode the piece (symphonia) and slave playback position to
  the bus clock: subscribe to `clock.daisy.{position,rate}` over
  `/bus/events` and extrapolate with a **Rust port of SongClock**
  (static/song-clock.js is ~30 lines by design; the port is validated by
  the same fixtures as the JS — one contract, now three implementations).
  This is the deterministic mode: fixture mp3 + captured clock stream →
  reproducible analysis output, which is what the offline gate drives.

## Bus integration

- **Transport**: `bus.v1` proto-JSON packets over `POST /bus/publish` — the
  8A ingress, unchanged; the sidecar is its second client. (If/when the
  sidecar leaves the bridge's machine, the same packets ride whatever
  transport phase 9 standardizes; nothing here assumes loopback except
  today's endpoint guard.)
- **Writer discipline**: identical to the browser TapPublisher — control-
  rate decimation, quantized change-dedupe, keepalive inside the declared
  stale window, boot-epoch counter persisted to a file (the bridge's own
  mechanism).
- **Identity**: own module manifest + allowlist entry —
  `spiffe://pain-material.local/analysis/audio-tap`, role `audio_tap` (the
  role already exists and is path-scoped, not writer-scoped; the allowlist
  gains a second entry).
- **Code home**: a **new root workspace** (`analysis/`, binary
  `orrery-audio-tap`) — NOT `daisy/` (that workspace is on-Daisy code
  only; ruling 2026-06-11). Borrow cpal experience from `daisy/host`, don't
  live there. Bus types via `prost` over the shared `proto/`.

## Migration: shadow → A/B → cutover (the bus already knows how)

1. **Shadow**: sidecar publishes the continuity set at priority **250** —
   below the browser tap's 300. The inspector shows it as a candidate
   (`would_win_if_priority_ge_legacy`), captures carry both writers,
   nothing changes downstream.
2. **A/B**: extend `tools/sim/validate-audiotap.js` with a two-writer lane
   — per path, sidecar-vs-browser values on a common grid, tolerance gate
   (the compat-band emulation is what makes a tight tolerance possible).
   Run it on real kiosk captures until MATCH is boring.
3. **Cutover**: one commit swaps priorities (sidecar 300, browser tap 200).
   Rollback is artifact-level. The browser tap **stays alive at 200** in
   kiosk deployments: when the sidecar dies or goes stale, arbitration
   falls back to a live lower-priority writer automatically — failover for
   free from machinery that already exists. (Standalone drag-an-mp3 use
   keeps the in-page tap as its binding forever; run-location is
   orthogonal to the contract.)

The detector/onset surface has no incumbent — it ships as the sole writer
whenever it's ready, no A/B needed, consumers opt in by binding it.

## The two-projector test (planned for, NOT gated on)

The steelman that shaped this design: two Pis with projectors on opposite
walls, approximately framelocked (not genlock), a third machine running
this sidecar + the bridge, WiFi transport. Feasibility analysis
(2026-06-12): topology works today (two `/bus/events` clients), added
acoustic-to-photon latency ~10–25 ms typical (imperceptible; AV-sync
tolerance for abstract content ≈100 ms), inter-node skew ≤1–2 frames
(invisible across a room). What it *demands* is coherence: onsets decided
once at the tap (this design), choreography counters/state decided
upstream of both nodes (a bridge-side plugin, the phase-6 pattern), and
event-keyed — not frame-keyed — seeded RNG for anything two nodes must
agree on (frame-keyed RNG diverges on the first non-shared dropped frame).
Micro-texture (grain, jitter, individual sparks) is noise and may diverge
freely.

**Ruling (Chris, 2026-06-12): this is an aspirational future — plan for
it, don't gate on it.** Concretely: the sidecar v1 ships against the
single-kiosk topology; nothing in v1 may *foreclose* the two-node case
(signals stay on the bus, onsets stay tap-side, no node-local hidden
state in the contract), but no v1 milestone requires demonstrating it.
The named acceptance test for the future phase: *a second render node
added to the bus produces macro-identical output with no code changes.*

## Validation

- **Unit**: filterbank/envelope/compat-band math pinned against synthetic
  signals (the audio-tap.test.js pattern, in Rust).
- **Determinism leg**: `file` mode over a fixture mp3 + a captured clock
  stream → byte-stable signal output across runs.
- **The standing gate**: `validate-audiotap.js` lanes (drift, hygiene,
  contract, join) apply to any writer; generalize its source identity and
  add the two-writer A/B lane.
- **Latency**: measured, not estimated — timestamp at capture, timestamp
  at bridge accept (already in the capture), report the distribution.

## Open questions (answer before code)

1. **Capture wiring on the kiosk — RESOLVED (Chris, 2026-06-12)**: the
   Daisy's UAC capture node, the one already verified with `pw-record`:
   `alsa_input.usb-ambient-viz_Daisy_audio_source_0001-00.analog-stereo`.
   Two implications: (a) `pw-record` working confirms the capture node
   *clocks fine under PipeWire* — the "rate 0" fault really was
   Chromium-specific, so the sidecar needs no PipeWire workaround; (b)
   that string is a **PipeWire node name**, not an ALSA device name —
   cpal's ALSA host reaches it through the `pipewire-alsa` bridge (or
   bind `hw:` directly if PipeWire releases the device; `pipewire-rs` is
   the fallback if neither behaves). Config takes the device as a string
   and the README documents the PW-node ↔ ALSA-name mapping for this
   device.
2. **Band edges + detector tuning** are project data, not platform code:
   they belong in the project manifest eventually (the params live with
   the tap module declaration), hand-tuned against the actual piece first.
3. **Sidecar placement**: same Pi as the bridge initially (loopback
   `/bus/publish` holds); the third-machine topology rides phase 9
   transports.
