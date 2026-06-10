# Pain Material — reference installation

The original piece this repo grew out of, and the **reference installation** for
the platform (`ARCHITECTURE.md`, `EXHIBIT.md`). As the repo generalizes, Pain
Material's project-specific content migrates here, leaving the engine generic.

> **Status: scaffold.** This directory structure is in place; the actual
> content has **not** been moved yet — the running system still loads from its
> current locations (`static/`, `patches/`, `daisy/`). Extraction is a tracked
> backlog item (`BACKLOG.md` → *Extract Pain Material to `projects/`*) and
> happens *after* the engine/project boundary (host/plugin split, bus, router)
> is stable enough to depend on. Moving files before then just churns.

## What lives here (target)

| Subdir | Holds | Currently at |
|---|---|---|
| `manifest/` | router graph, timeline/lanes, palettes, emitter-group defs, clock driver | hardcoded in `static/index.html`; `*.timeline.json` |
| `assets/` | silhouette SVG, audio, images | `static/irocz.svg`, `static/*.mp3`, `static/*.png` |
| `scenes/` | the bespoke raster scene plugin ("scene #1": lattice / slice-tears / flyout / dither) | the IIFE in `static/index.html` |
| `patches/` | this piece's Daisy patches | `patches/`, the firmware-baked presets |

## Engine vs. this installation

**Engine (stays at repo root):** the visualizer host, control bus, router,
scene-plugin API, and the `daisy/` workspace crates (`dsp` / `host` /
`firmware`).

**This installation:** the 18-minute arrangement, its timeline/lanes, the
sensor→parameter mappings, palettes, the silhouette artwork, the bespoke raster
scene, and the specific Daisy patches/sequences.

## Extraction order (when the boundary is ready)

1. Assets first (pure data, no engine coupling) → `assets/`.
2. Timeline + palettes + sensor mappings → `manifest/` (needs the router IR).
3. The raster pipeline → `scenes/` (needs the host/plugin split).
4. Patches → `patches/` (needs the project-aware patch loader).

Each step waits on its engine dependency; see `BACKLOG.md`.
