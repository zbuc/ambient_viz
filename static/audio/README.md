# audio tools

Browser-based tools for authoring the **audio** side of the exhibit: the DSP
sequencer patterns and the synth patches that drive the Daisy. Separate from
the visualizer/editor in `static/index.html` (a viz↔audio linkage may come
later; for now they're independent).

## Running

Served by the existing Node server (`server/`), which serves the `static/`
root. With it running, open:

```
http://localhost:<port>/audio/
```

No build step — vanilla HTML + ES modules. Edit a file, reload.

## Layout

```
audio/
  index.html          launcher
  shared/
    patfile.js        parse/serialize .pat            ← FORMAT BOUNDARY
    patch-schema.js   FmPatch/BassPatch param defs     (mirrors the Rust structs)
    storage.js        fetch-load, download-save, localStorage drafts
    ui.js             vanilla widgets (slider/select/grid)
    style.css         shared dark UI
  sequencer/          drum-grid + chord-prog editor
  instruments/        combined patch + FX-chain + instrument-preset editor
  wavetable/          Microwave II-style wavetable voice editor
  presets/            saved presets (committed): fm/ bass/ wt/ fx/ instrument/
    wavetables.json   generated wave bank (see below)
    waveview.js       canvas preview rendering
```

## Instruments editor

`instruments/` is the combined editor (formerly `patches/`). A composite
**instrument** = a source patch + an insert **FX chain**, and it edits all
three preset levels live against the real Rust DSP through `patch_server`
(`daisy/crates/host/src/bin/patch_server.rs`; see `daisy/PATCH_SERVER.md`):

- **Patch** — the FM-stab / rumble-bass voice params (schema
  `shared/patch-schema.js`). Patch presets save to the **node server**
  (`/api/presets/{fm,bass}`, schema-validated) → `presets/{fm,bass}/`.
- **FX chain** — an ordered list of insert effects (reverb, delay,
  distortion, tape, transporter, freeze, filter, bloom), added/reordered/
  tweaked live; the available effects + param ranges come from
  `GET /fx/catalog`. FX presets save to **patch_server** → `presets/fx/`.
- **Instrument** — the whole bundle (fm + bass + wt patches + FX chain),
  saved/loaded via **patch_server** → `presets/instrument/`. Starter:
  `otamatone reverse wash` (otamatone wt + a transporter FX).

The FX + instrument panels need the preview server running; patch editing +
export work offline. Presets are committed to git (no `.gitignore`).

## Wavetable editor

`wavetable/` edits a **Waldorf Microwave II-style** voice — two wavetable
oscillators (each with a graphical wavetable picker + live wave-position morph
preview), a mixer with noise + ring mod, a multimode filter and two envelopes.
Schema: `shared/patch-schema.js` (`WT_PATCH`).

Wave data comes from the Waldorf user-wave SysEx in
`patches/wavetables/*.mid` (decoded by `waldorf_wavetable.py`). Regenerate the
browser bank with:

```
python3 patches/wavetables/waldorf_wavetable.py bank \
  patches/wavetables/UW_XTUsersoundset3_and_VS-Waves.mid \
  static/audio/wavetable/wavetables.json
```

Edits audition against the **real Rust DSP** (`dsp::WtSynth`, a Microwave
II-style 2-osc + noise + ring-mod voice) via the same `patch_server` bridge as
the FM/bass patch editor. Run it and the `● live` pill lights up:

```
cd daisy && cargo run -p host --bin patch_server
```

**Trigger ▶** strikes the voice (it sustains until **Stop ◼**, which panics all
audio). With no server the editor is export-only. The `WtPatch` JSON the editor
streams is the exact serde schema `dsp::WtPatch` parses (and the firmware will
read off SD once the QSPI overlay lands — see `BACKLOG.md`). The Rust wavetable
bank is generated from the same SysEx via `waldorf_wavetable.py rustbin` →
`daisy/crates/dsp/src/wavetables.bin`.

## Format boundary (MIDI migration)

The tools speak an **in-memory `Pattern` object**, not `.pat` text. All `.pat`
syntax is confined to `shared/patfile.js`. When the format migrates to MIDI,
replace only that module with one that parses/serializes the same `Pattern`
shape — the sequencer UI is unaffected. (See the `@typedef Pattern` there.)

## Source of truth

The schemas and the `.pat` grammar are mirrored from the Rust DSP — keep them
in sync if those change:

- `.pat` grammar / `Pattern` fields → `daisy/crates/dsp/src/sequencer.rs` (`parse_grid`)
- `FmPatch` params → `daisy/crates/dsp/src/fm_stab.rs`
- `BassPatch` params → `daisy/crates/dsp/src/bass.rs`

## Live preview (real Rust DSP)

The patch editor can audition edits against the **actual** Rust DSP — the same
`dsp` code that's bit-compatible with the Daisy firmware — not a WebAudio fake.
Run the native bridge on the Mac:

```
cd daisy && cargo run -p host --bin patch_server   # listens on 127.0.0.1:8765
```

Then open the patch editor. The `● live` pill lights up; moving any slider
streams the patch to the server (debounced) and **Trigger ▶** strikes the
voice through the Mac's speakers. **Stop ◼** kills all audio (the rumble bass
sustains until you do — it's a gated voice). FM stab and rumble bass are both
summed into one master limiter, in firmware master-bus order
(`host::rigs::PreviewRig`).

The editor is fully usable with no server running (export-only). Point it at a
different host with `localStorage 'ambient_preview_server'`.

Endpoints (CORS-open): `GET /health`, `POST /fm/patch`, `POST /bass/patch`,
`POST /fm/trigger`, `POST /bass/trigger`, `POST /panic` (kill all audio) —
patch bodies are the same JSON the editor exports.

## Saving

Two paths:

- **Export → Download** — always available; writes the patch JSON (or a Rust
  literal) as a file download. Works under any static server.
- **Save preset** *(wavetable editor)* — persists a named preset server-side so
  it shows up in the dropdown beside the built-ins (under a "Saved" group),
  surviving reloads. This needs the **Node server** (`npm start` in `server/`)
  and the page opened from it (`http://localhost:8080/audio/...`) — it POSTs to
  the loopback-only `/api/presets/<type>` write API. Files land in
  `static/audio/presets/<type>/` (git-ignored local data). With a bare static
  file server the Save button just reports the API is unreachable; Download
  still works. See `server/README.md` for the endpoint + its security model
  (filename whitelist, schema validation, size/symlink/count guards).

## Scaffold status / TODO

- `bass:` (tie chars) and `stabtone:` lanes parse + serialize, but the grid UI
  renders only the drum/stab velocity lanes. Add tie/value editors before the
  MIDI swap.
- Live preview (`patch_server`) covers the patch editor. The sequencer has no
  preview yet — it would need to drive the DSP sequencer over the same bridge.
- Firmware **SD overlay is deferred until QSPI.** Parsing the patch JSON on the
  Daisy needs ~30 KB of `serde_json_core` deserialize code, and the 128 KB
  internal flash is already full — so patches can't be baked from SD until the
  QSPI bootloader lifts the ceiling. The shared serde schema and this editor's
  JSON export are ready for that day. See `BACKLOG.md` ("Patch SD overlay").
  Until then, bake by hand: copy the editor's **Rust** export into
  `daisy/crates/dsp/src/fm_stab.rs` (`FmPatch::bell()` / `industrial()`).
