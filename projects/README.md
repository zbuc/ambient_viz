# projects/ — installations built on the platform

Each subdirectory is one **installation** (a "project" in the
multi-project-manifest sense): the project-specific *data + assets + bespoke
code* that runs on top of the engine. The engine itself lives at the repo root
(visualizer host, bus, router, scene-plugin API, the `daisy/` workspace).

See `ARCHITECTURE.md` → *Repository layout (engine vs. installation)* for the
decision and the engine/project split. Short version: **one repo while the
engine↔project boundary is still being designed**; split to multiple repos only
when a second real installation needs to pin a specific engine version.

## Installations

- [`pain-material/`](pain-material/) — the **reference installation**; the
  original piece this repo grew out of (`EXHIBIT.md`).
- `_demo/` — *(planned)* the bundled demo as a second, tiny project.

## Layout of an installation

```
<name>/
  manifest/   router graph, timeline/lanes, palettes, group defs, clock driver
  assets/     artwork, audio, images
  scenes/     bespoke code plugin(s) — when the project needs custom rendering
  patches/    Daisy patches (.pat sequences, synth/FX presets)
```

Nothing here is a fork of the engine — an installation is *configuration over*
the engine, plus optional bespoke scene/patch code.
