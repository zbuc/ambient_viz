# patch_server — live patch + FX preview bridge

`cargo run -p host --bin patch_server [--port=8765]`

A localhost HTTP server that runs the **firmware-exact** Rust DSP on the Mac's
audio output and accepts edits live, so the browser editors in `static/audio`
tune against the **real** code that's bit-compatible with the Daisy — not a JS
re-implementation. Source: `daisy/crates/host/src/bin/patch_server.rs`; the
audio engine is `host::rigs::PreviewRig`; the FX layer is `host::fx`.

> Keep this doc current when you add an effect kind, a route, or a preset
> kind (the `daisy/README.md` keep-current norm).

## The model: a composite "instrument"

```
  source voices (the "patch" layer)        insert FX chain (NOT part of a patch)
  ┌─────────────────────────────┐          ┌──────────────────────────────┐
  │ FmStab  (FmPatch)  + ping-pong│         │  reverb → delay → filter → …  │
  │ RumbleBass (BassPatch)        │── sum ─►│  (ordered, editable, dry/wet) │──► master limiter ──► out
  │ WtSynth  (WtPatch)            │         │                              │
  └─────────────────────────────┘          └──────────────────────────────┘
```

- **Patch layer** — the three source voices, each with its serde patch
  (`FmPatch`/`BassPatch`/`WtPatch`, the same JSON the firmware reads off SD).
  The FM stab keeps its hardwired ping-pong send (part of the voice).
- **FX chain** — an *ordered, editable* list of insert effects applied to the
  summed instrument, **before** the master limiter. The chain is **not** part
  of any patch; it's a separate layer. This is the "effects chain" you
  add/remove/tweak at runtime.
- **Instrument** = patch layer + FX chain. Saved/loaded as one bundle.

`host::fx` (host-only — see *Real-time / firmware safety* below) wraps each
heterogeneous dsp effect in a uniform `Effect` trait (`process(&mut [f32],
sample_index)`, `set_param(name, value)`, `params()`, `kind()`), so a chain is
build/reorder/tweak/serialize-able. `FxChain` owns the `Vec<Box<dyn Effect>>`;
`PreviewRig` runs it in `render()` pre-limiter.

## Effects (`/fx/catalog` is the source of truth at runtime)

| kind | dsp type | params |
| ---- | -------- | ------ |
| `reverb` | infinitedsp `Reverb` | `room_size` `damping` `mix` |
| `delay` | infinitedsp `PingPongDelay` | `time_ms` `feedback` `mix` |
| `distortion` | infinitedsp `Distortion` (SoftClip) | `drive` `mix` |
| `tape` | `dsp::tape::TapeProcessor` | `failure` `hiss` `wow_ms` `flutter_ms` `mix` |
| `transporter` | `dsp::transporter::Transporter` | `grain_ms` `density` `offset_ms` `pitch` `spread` `reverse` `mix` |
| `freeze` | `dsp::freeze::Freeze` | `amount` `mix` |
| `filter` | `dsp::svf::Svf` (stereo) | `freq` `res` `drive` `mode` (0 low/1 high/2 band/3 notch) `mix` |
| `bloom` | `dsp::bloom::BloomBank` | `amount` `mix` |

Every effect has a wrapper-level `mix`: in-place effects (reverb/delay/
distortion/tape/filter) blend `dry*(1-mix) + wet*mix`; additive effects
(transporter/freeze/bloom) add `wet*mix` over the dry. `GET /fx/catalog`
returns each kind's params with `default`/`min`/`max` for building a UI.

Adding a new effect: write a wrapper struct implementing `Effect` in
`host::fx`, add it to `make()`, `KINDS`, and `param_ranges()`. Nothing else
changes — chain/preset/route code is generic over the trait.

## HTTP API

CORS-open (so the static dev-server origin can reach it). All bodies + non-`ok`
responses are JSON. `GET /health → "ok"` is the editors' live-mode probe.

### Source patches
| Method · path | body | effect |
| --- | --- | --- |
| `POST /fm/patch` | `FmPatch` JSON | hot-swap stab patch |
| `POST /bass/patch` | `BassPatch` JSON | hot-swap bass patch |
| `POST /wt/patch` | `WtPatch` JSON | hot-swap wavetable patch |
| `POST /fm/trigger` | `{"note":81}?` | strike the stab (note optional) |
| `POST /bass/trigger` | `{"note":38}?` | strike the bass |
| `POST /wt/trigger` | `{"note":60}?` | strike the wavetable voice (sustains) |
| `POST /panic` | — | silence everything (voices + delay + FX tails) |

### FX chain
| Method · path | body | effect |
| --- | --- | --- |
| `GET /fx/catalog` | — | available kinds + param specs |
| `GET /fx/chain` | — | the live chain: `[{kind, params:{..}}]` |
| `POST /fx/chain` | `[{kind, params:{..}}]` | replace the whole chain (unknown kinds skipped) |
| `POST /fx/add` | `{"kind":"reverb","index":0?}` | insert (append if no index) |
| `POST /fx/remove` | `{"index":N}` | remove |
| `POST /fx/move` | `{"from":I,"to":J}` | reorder |
| `POST /fx/param` | `{"index":N,"name":"mix","value":0.3}` | tweak one param |

### Presets (this server reads/writes the JSON files itself)
| Method · path | body | effect |
| --- | --- | --- |
| `GET /fx/presets` | — | names in `presets/fx/` |
| `POST /fx/preset/save` | `{"name":"plate verb"}` | save the live chain |
| `POST /fx/preset/load` | `{"name":"plate verb"}` | load into the chain |
| `GET /instrument/presets` | — | names in `presets/instrument/` |
| `POST /instrument/save` | `{"name":"glass pad"}` | save patches + chain |
| `POST /instrument/load` | `{"name":"glass pad"}` | apply patches + chain |

## Presets on disk

```
static/audio/presets/
├── fm/*.json           FmPatch          (node server writes; browser editor)
├── bass/*.json         BassPatch        (node server writes)
├── wt/*.json           WtPatch          (node server writes; sound_test --wt/--save-wt)
├── fx/*.json           [FxNode]         (patch_server writes  ← new)
└── instrument/*.json   Instrument       (patch_server writes  ← new)
```

- The **source** patch presets (`fm`/`bass`/`wt`) are owned by the **node
  server** (`server/src/index.js`, `/api/presets/:type`, schema-validated).
- The **fx** and **instrument** presets are owned by **patch_server** directly
  — it reads/writes `static/audio/presets/{fx,instrument}/*.json` (dir resolved
  at compile time via `env!("CARGO_MANIFEST_DIR")`, so the run directory
  doesn't matter). Names are guarded (`[A-Za-z0-9][A-Za-z0-9 _-]{0,63}`) so
  they're path-safe.
- `FxNode` = `{ "kind": "...", "params": { "name": value, .. } }`.
- `Instrument` = `{ "fm": FmPatch, "bass": BassPatch, "wt": WtPatch, "fx": [FxNode] }`.

## How the browser editors connect

The editors (`static/audio/instruments`, `static/audio/wavetable`) probe
`GET /health`; if it answers they switch to **live mode** and stream patch
edits over `POST /{fm,bass,wt}/patch` (see `static/audio/shared/preview.js`).
Offline, the patch editing + export stay usable.

The **instruments editor** (`static/audio/instruments`, formerly `patches`) is
the combined front end for this whole model: a Patch panel (voice params +
node-server patch presets), an **FX-chain panel** (catalog-driven add/remove/
reorder/param sliders talking to the `/fx/*` routes, with fx presets), and an
**Instrument panel** that saves/loads the patch+chain bundle via
`/instrument/*`. The FX + instrument panels require this server (real DSP);
patch editing works offline. `preview.js` carries the `/fx/*` + preset clients.

## Real-time / firmware safety

`host::fx` is **host-only**. The wrappers call each dsp effect's existing
`process()` unchanged; the dry/wet scratch buffers + blends run on the Mac's
cpal callback (the same resize-on-demand pattern `PreviewRig` already uses).
Nothing here compiles into the firmware. The only `dsp` change for this
feature was `use → pub use` for `Reverb`/`Distortion` (visibility only) — the
firmware still builds for `thumbv7em-none-eabihf` and all dsp tests pass, with
no change to any effect's Cortex-M7 hot path.

## Tests

`cargo test -p host` covers `host::fx`: every kind builds + round-trips
through `FxNode`, the full 8-effect chain processes finite/bounded audio, and
add/remove/move/param/load-skip-unknown behave. A live HTTP smoke test (start
server → exercise catalog/add/param/chain/save/load/instrument → path-traversal
name rejected) was run during development.
