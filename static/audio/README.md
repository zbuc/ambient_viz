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
  patches/            FM-stab / rumble-bass parameter editor
```

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

The server is read-only today, so **Save = browser download**; drop the file
back into `static/` by hand. When a write endpoint is added, swap
`saveText()` in `shared/storage.js` for a `fetch(POST)` — callers don't change.

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
