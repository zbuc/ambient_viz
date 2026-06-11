# Getting started with orrery

> **Under construction.** This guide will walk a new user from clone to a
> running system. Until it's written, the closest equivalents are
> `README.md` → *Two ways to run* (the visualizer + kiosk pipeline) and
> `PI_KIOSK_BRINGUP.md` (the full hardware runbook).

Planned contents:

1. **Run the visualizer standalone** — open `static/index.html`, load a track.
2. **Run the full pipeline without hardware** — `./run_kiosk.sh --mock`
   (all sensors synthetic), open the visualizer + the signal inspector
   (`/inspector`).
3. **Watch the bus** — what the inspector shows: signals, writer candidates,
   enforcement truth values, `_meta` diagnostics.
4. **Record + replay a session** — `CAPTURE=1`, the fixtures layout, and
   `tools/replay/replay.js`.
5. **The Daisy audio engine** — flashing, audio modes, host-side tools
   (`daisy/`).
6. **Author a project** — manifests, ProjectPolicy, and (phase 4+) router
   mappings under `projects/<name>/`.
7. **Glossary** — signal, path, STATE/EVENT, shape, priority ladder, golden.
