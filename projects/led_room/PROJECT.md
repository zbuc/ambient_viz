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

## Decided (2026-07-13): the LED node

The render-plane hardware/protocol, previously open:

- **Chipset: SK9822** (two-wire, clock + data), *not* WS2812/SK6812. Two-wire is
  plain SPI — no timing-critical encoding, immune to WiFi interrupts, DMA-able.
  The deciding property is dimming: the SK9822's 5-bit global field is a real
  constant-**current** DAC (a true APA102's is a ~580 Hz current PWM that flickers
  on camera), so pairing it with the 8-bit PWM gives ~13 bits and a fade to black
  that stays smooth. Cost: ~3x WS2812, and no RGBW — we gave up SK6812's real
  white die to get the dimming.
- **Node: ESP32-DevKitC-32** (6 on hand), firmware in **`no_std` Rust /
  esp-hal + esp-radio**. Accepted risks, in `led/README.md`: the SPI-DMA API is
  `unstable` and churning; ESP-NOW has **no hardware CI on Xtensa** (soak-test
  before mounting anything); OTA needs a bootloader we build. Escape hatch if the
  radio proves flaky: an ESP32-C6 — `led-core` is chip-agnostic, so only the thin
  `node-fw` crate would change.
- **Power: several islands, 12V within each, a 5V buck at each node.** Not one central
  PSU — that would mean 12V trunks radiating to every corner, the wires-everywhere
  problem the distributed-node design exists to avoid. Each island gets its own supply,
  fuse block, and node cluster, sized to its own load. Within an island, distributing at
  12V draws 2.4x less current than 5V (so the trunk barely drops), and each node
  regenerates a clean local 5V centimetres from its strip — 5V being the rail that
  cannot tolerate a drop (below 5V the blue/green dies dim before red, so an undervolted
  strip shifts *colour*, not just brightness).
  Because the nodes couple wirelessly, **no signal wire crosses between islands**: no
  ground bonding, no ground loops. "Never ship pixels" buys electrical independence as
  well as radio bandwidth.
  **Consequence for the render plane:** an island is a **failure domain**. A dead supply
  darkens its cluster and nothing else — desirable, but it means an emitter group can
  span islands and its choreography must degrade gracefully with a member missing,
  rather than assuming every node is alive.
  Rig details in `led/README.md`; the rules that kill hardware or people are in
  `led/SAFETY.md`.
- **Code lives in the `led/` root workspace** (sibling of `analysis/`), not here:
  this directory stays project-as-data. `led/node-manifest.draft.json` is the
  node's manifest, held out of `manifest/modules/` until a real node boots — a
  registered module that never publishes health would just be a phantom.

Still open: how many strips, their physical layout and `geometry.positionM`, and
**which control signals a node actually renders from** (`music.genome.*` is the
obvious source, but nothing publishes `clock.main.*` in led_room yet — SongClock
is pain-material's module, not a shared one).

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

## Idea parking lot

- **`dominant` signal** (from the Analyze CHOP review, 2026-06-12):
  index-of-maximum across `audio.main.{kick,pad,lead}` (or per-stem
  taps) — a one-liner "which instrument leads right now" classifier;
  exactly the low-rate symbolic input a fitness function or an LED
  render group wants before anything fancier exists.
