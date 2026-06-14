# Tuning audio analysis

A practical guide to dialing in the detector parameters with the live
viewer (`detector-viewer.html`). You tune by **ear and eye**: play the
piece, watch the lanes against the music, adjust knobs, and the whole
analysis re-runs in the browser instantly.

Screenshots referenced below live in `tools/tuning/screenshots/` — capture
your own as you go.

---

## 1. Launch

```sh
sh tools/tuning/build.sh          # compile the detector to WASM (once; re-run only
                                  # after editing the Rust DSP, NOT after a param tweak)
python3 -m http.server            # from the repo root
```

Open:
`http://localhost:8000/tools/tuning/detector-viewer.html?audio=/static/20251006_arrangement_1.mp3`

(or open the page and pick the audio file by hand). When the status line
reads **`LIVE (wasm) …`**, every parameter is live — changing a knob
re-analyzes the whole piece in ~1–2 s.

> Loading a `*.json` trace instead of audio gives a **static** view (no
> live re-analysis — only `threshold`/`cooldown` preview). For real tuning
> you want LIVE, which needs the audio file.

![The viewer on load](screenshots/01-loaded.png)
*Placeholder: the full viewer right after the audio loads — overview strip
on top, detail strip below, editor panel, status line reading LIVE.*

---

## 2. Reading the display

- **Overview strip** (top): the whole piece; the box shows the detail
  window. Click/drag to seek.
- **Detail strip** (bottom): the zoomed window. Wheel to zoom, drag to
  seek, **space** to play/pause, **follow** keeps it on the playhead.
- **Lanes**: each toggle (with its color swatch) shows/hides a signal.
  Red ticks dropping from the top are **onset fires**; the dashed purple
  line is the **onset threshold**.
- **Status line**: LIVE/STATIC, row count, and number of kick fires.

![Lanes and toggles](screenshots/02-lanes.png)
*Placeholder: close-up of the channel toggles row and a stretch of the
detail strip showing a few lanes + red onset ticks + the threshold line.*

### The lanes that matter

| Lane | Color | What it is |
|------|-------|------------|
| `kick` | red | kick-band **envelope** (smoothed energy) |
| `kick_dev` | purple | `kick − kick_baseline` — what the onset gate thresholds today |
| `kick_baseline` | dim purple | slow adaptive floor under `kick` |
| `kick_flux` | teal | spectral flux in the kick **body** band (onset, level-normalized) |
| `click_flux` | orange | spectral flux in the **beater-click** band |
| `kick_score` | yellow (bold) | coincidence combiner of the two flux channels — **the headline** |
| `bass/mid/treble/level/peak/bass_fast` | various | the compat band signals (off by default) |
| `pad`, `lead` | green/blue | the other detector envelopes |

The goal: **`kick_score` high on every kick, low on everything else**
(especially toms, which have body but no click).

---

## 3. The parameters

The editor groups mirror the analysis chain. All values are live.

### kick / pad / lead (the envelope detectors)
- **band_lo / band_hi** — the bandpass edges (Hz). Watch the envelope
  (`kick`/`pad`/`lead`) rise on the right instrument and stay flat
  otherwise. If the envelope barely moves, the band is missing the energy.
- **attack_s** — how fast the envelope rises. Short = catches transients
  (kick); too short = jittery.
- **release_s** — how fast it falls. Too long smears one hit into the
  next; too short makes presence signals flicker.

### kick onset (the gate that fires `kick_onset`)
- **threshold** — the dashed line on `kick_dev`. Set it **above** the
  ripple between hits and **below** the real kick spikes. Too low → fires
  on noise; too high → misses soft kicks.
- **cooldown_s** — minimum gap between fires; raise it if one hit
  double-fires.
- **baseline_tau_s** — how fast `kick_baseline` chases `kick`. Faster
  (smaller) eats sustained energy so only sharp transients deviate; slower
  keeps the floor flat so swells still register.

### flux kick / flux click
- **band_lo / band_hi** — the measurement band for each flux channel
  (independent of the envelope bands above). `flux kick` ≈ the body
  (e.g. 20–120 Hz); `flux click` ≈ the beater (e.g. 2–5 kHz).
- **compress** — `0` = off (linear). Raising it **lifts weak-but-present
  onsets** toward the strong ones so a single threshold works across hits
  — at the cost of raising the floor between hits. Find the point where
  weak kicks read clearly but the floor hasn't crept up.

### kick score (the combiner)
- **kick_weight / click_weight** — tilt the weighted geometric mean.
  Equal (1, 1) demands both. Push **click_weight** up to lean on the
  beater click (the strongest kick/tom discriminator); set a weight to
  **0** to ignore that channel entirely (e.g. score on the click alone).
  The score is **zero if either channel is zero** — that's what rejects
  toms.

![The editor panel](screenshots/03-editor.png)
*Placeholder: the editor groups (kick / pad / lead / kick onset / flux kick
/ flux click / kick score) with their number inputs.*

---

## 4. A suggested order

1. **Detector bands + attack/release** — turn on `kick`, scrub to a clear
   kick, set `band_lo/band_hi` so the envelope spikes on kicks; tighten
   `attack_s`/`release_s` so each hit is a clean spike.
2. **Flux bands** — turn on `kick_flux` and `click_flux`. Set `flux kick`
   to the body, `flux click` to the beater click. Confirm a kick lights
   **both**; a tom lights mostly `kick_flux`.
3. **Compression** — raise each channel's `compress` until weak hits read
   as clearly as strong ones, watching `kick_score` respond live.
4. **Weights** — turn on `kick_score`. Adjust `kick_weight`/`click_weight`
   until the score is high on every kick and ~0 on toms and bass.
5. **Threshold / cooldown** — once `kick_score` separates the kit, set the
   onset `threshold` against it and `cooldown_s` to taste.

![Kick vs tom separation](screenshots/04-kick-vs-tom.png)
*Placeholder: a stretch with both a kick and a tom — kick_score (yellow)
high on the kick, near zero on the tom, even though kick_flux (teal) is
present on both.*

---

## 5. Saving your tuning

Click **download detector-params.json**. Save it as the project's asset:

```
projects/<project>/assets/detector-params.json
```

The sidecar loads it with `--params`:

```sh
orrery-audio-tap --params projects/pain-material/assets/detector-params.json --file <piece>
# or, live: --device pipewire   (see analysis/README.md)
```

The same file feeds both the offline trace and the live-publish run — the
tuning artifact *is* the production artifact.

![Download + saved params](screenshots/05-download.png)
*Placeholder: the download button and the resulting detector-params.json
in the project's assets folder.*

---

## Notes

- **Editing a knob does not need a rebuild** — params are live. Only re-run
  `build.sh` if you change the Rust DSP (`analysis/audio-tap/src/*.rs`); the
  viewer's preview is only as fresh as the last build.
- `kick_score` is currently **observe-only** — the onset gate still fires on
  `kick_dev`. It moves to `kick_score` once the score reliably separates the
  kit on the real piece.
- A typo'd key in a hand-edited `detector-params.json` is a **loud error**,
  not a silent no-op.
