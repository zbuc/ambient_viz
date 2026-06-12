# led_room (working name)

**Status: incubating (2026-06-12).** A second orrery project, split out of
pain-material — the mood plane / genome machinery was built during the
procmusic work and its binding initially landed in the exhibit's
manifest, but it belongs here. The name is a placeholder.

## The idea

Generative music with a sensed room in the loop, rendered to light:

- **Sound**: the Daisy runs the `dsp::procgen` sequencer — the 19-gene
  Genome (CC 70–88, PROCMUSIC.md) — so the music is generated, not
  played back. The **mood plane** (`manifest/moods.json` anchors +
  the `mood_expander.v1` plugin) is the aesthetic state: a 2-D position
  expands to a full genome + FX params by inverse-distance² blend over
  the anchors.
- **Sensing → fitness**: sensors around the room (kind TBD) feed back
  into the generator — fitness/feedback steering the mood position and/or
  genome directly, so the room's behavior shapes what the music becomes.
  The sensor types, the fitness function, and whether steering targets
  the mood plane or individual genes are all OPEN.
- **Visuals**: addressable LED strips/panels — the render plane is the
  distributed-emitter case from ARCHITECTURE.md (*Distributed render
  nodes*): ESP32-class nodes receiving shared control (clock, `seq.*` /
  `music.genome.*`, palette) and computing their slice locally. Tier-B
  sync; no raster screen.

Everything speaks the same control bus as pain-material — same packet
protocol, manifests, policy, capture, gates. This directory is the
project-as-data: `manifest/` (policy, modules, plugin bindings, moods)
is what a bridge boots with `PROJECT=led_room`.

## What lives here today

- `manifest/moods.json` — the 5 mood anchors (first drafts, tune by ear).
- `manifest/plugins/mood-expander.json` — the mood_expander binding
  (instance `mood`, seeded). The plugin code is a platform asset
  (`server/src/plugins/mood-expander.js`).
- `manifest/modules/plugin-host.json` — declares the 19
  `music.genome.*` publishes under `spiffe://led-room.local/bridge/plugin-host`.
- `manifest/policy.json` — project policy (WARN modes, plugin_host role).

## What is deliberately undecided

Sensor inventory and the fitness function; the genome→CC transport
choreography on the Pi side (procmusic P2's open half); the LED node
hardware/protocol (the ESP32 render-node arc, BACKLOG.md); whether the
audio analysis sidecar (`AUDIO_ANALYSIS_SIDECAR.md`) gets a tap instance
here. Decisions land in this file as they're made.
