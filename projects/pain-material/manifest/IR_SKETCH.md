# Pain Material as `router.v1` — IR sketch

> **Status: design sketch, written before the compiler exists.** The target
> representation of today's hardcoded interactions — `applyAutomation()` in the
> visualizer, the 523-line trigger stack in `server/src/inputs/daisy-position.js`,
> the sidecar's mapping config — as a `RouterGraph` + plugins. This is the
> document the first real `manifest/` artifacts get extracted from; signal
> names are provisional until the namespace migration lands.
>
> Contracts: `ROUTER_IR.md` (`router.v1`), `PLUGIN_CONTRACT.md` (`plugin.v1`),
> `MANIFEST_PROTOCOL.md`, `BUS_PROTOCOL.md`. The interaction evaluation that
> produced this (and the `Normalize` node, the seeded-PRNG rule, and the
> time-arrives-with-packets rule) is in the 2026-06-10 design-review session.

## Signal inventory (condensed manifests)

**Sources**

| Path | Shape | Notes |
|---|---|---|
| `sensor.door.distance_cm` | STATE | ToF, ~30 Hz, `on_stale: DEFAULT` w/ `failsafe = far` (replaces the sidecar's no-target snap) |
| `sensor.door.velocity_cm_s` | STATE | sidecar-derived; approach negative |
| `sensor.door.near_cm` / `sensor.door.far_cm` | STATE | **learned calibration** — `near` is the install-day knob, `far` the empty-room learner's output (`static_config_state`-ish, but live) |
| `sensor.room.motion` | STATE (bool) | OR'd AM312 pair; absent ⇒ motion features self-disable |
| `touch.pad0.e0 … e11` | STATE (bool) | MPR121 electrodes |
| `audio.main.{bass,mid,treble,level}` | STATE | the in-host analysis tap |
| `clock.daisy.position` | STATE, **cyclic** | (position, rate) tuple, extrapolated locally — replaces POS/RESET rebasing |
| `timeline.*` | STATE | timeline player; truly interpolated (authored keyframes) |
| `ui.browser.freeze` | STATE | browser POST → today's CC 24 path |

**Sinks** — `render.raster.*` (the visualizer's PARAMETERS.md surface, as the
`pain_material_raster` plugin's typed inputs), `fx.tape.{failure,freeze}`,
`synth.bell.strike` (EVENT), `voice.main.speak` (EVENT, payload = phrase
index; **the firmware manifest declares the phrase enum** so the JS↔firmware
comment-contract becomes a compile check).

## Shared conditioning (the subgraph everything reads)

One **nearness** chain replaces the three mirrored ramps (tape, twist, bitmap)
across two processes — and the reversed direction (`near = destroyed`,
ce577ea's hardcode) becomes a single `invert` flag:

```yaml
nodes:
  - { id: d,    rate_domain: RATE_CONTROL, input: { path: sensor.door.distance_cm } }
  - { id: near, rate_domain: RATE_CONTROL, input: { path: sensor.door.near_cm } }
  - { id: far,  rate_domain: RATE_CONTROL, input: { path: sensor.door.far_cm } }
  # nearness: 1 at/inside the onset, 0 at the empty-room reach — Normalize takes
  # its endpoints from the LIVE learned signals (the reason the node exists)
  - { id: nearness, rate_domain: RATE_CONTROL, normalize: { input: d, lo: near, hi: far, invert: true } }
```

**Occupancy** (hysteresis + augment-only motion fusion, as IR):

```yaml
  # hysteretic occupancy from nearness: enter at 15% depth, release at 8%
  - { id: enter, rate_domain: RATE_CONTROL, trigger: { input: nearness, threshold: 0.15, hysteresis: 0.02, edge: RISING } }
  - { id: leave, rate_domain: RATE_CONTROL, trigger: { input: nearness, threshold: 0.08, hysteresis: 0.02, edge: FALLING } }
  - { id: dist_occ, rate_domain: RATE_CONTROL, latch: { input: enter, reset: leave, mode: HOLD_PAYLOAD, idle: false } }
  # motion held 20 s after it falls (the AM312 hold window)
  - { id: motion,     rate_domain: RATE_CONTROL, input:    { path: sensor.room.motion } }
  - { id: motion_held, rate_domain: RATE_CONTROL, envelope: { input: motion, mode: PEAK_FOLLOW, release_ms: 20000 } }
  # augment-only fusion: motion can ADD presence, never clear it (MAX)
  - { id: occupied, rate_domain: RATE_CONTROL, combine: { inputs: [dist_occ, motion_held], mode: MAX } }
```

Notes: the `MOTION_PRESENCE` feature flag becomes *which graph is loaded*
(edge present or absent), not an env var. The sidecar's empty-room learner
(stillness detection, plausibility floor, baseline adoption) **stays in the
source** — smart-source conditioning, not router logic; its *output* is
`sensor.door.far_cm`.

## Continuous mappings

```yaml
  # tape failure — today: (far−d)/(far−near) → CC23. The 0..127 quantize,
  # on-change dedupe, and 30 Hz cap live in the MIDI TRANSPORT ADAPTER, not here.
  - { id: tape_out, rate_domain: RATE_CONTROL, output: { input: nearness, target: fx.tape.failure, shape: STATE, priority: 300, authority_role: sensor } }

  # twist — nearness gain × authored timeline ceiling (the directorial clamp)
  - { id: twist_curve, rate_domain: RATE_RENDER_FRAME, curve:   { input: nearness, kind: EASE_IN_QUAD, in_min: 0, in_max: 1, out_min: 0, out_max: 1, clamp: true } }
  - { id: twist_ceil,  rate_domain: RATE_RENDER_FRAME, input:   { path: timeline.maxTwistDeg } }
  - { id: twist,       rate_domain: RATE_RENDER_FRAME, combine: { inputs: [twist_curve, twist_ceil], mode: MUL } }
  - { id: twist_out,   rate_domain: RATE_RENDER_FRAME, output:  { input: twist, target: render.raster.maxTwistDeg, shape: STATE, priority: 300 } }

  # bitmap resolution — same nearness, its own curve (SENSOR_MAPPING.md)
  # freeze — UI passthrough at local_ui priority
  - { id: freeze_in,  rate_domain: RATE_CONTROL, input:  { path: ui.browser.freeze } }
  - { id: freeze_out, rate_domain: RATE_CONTROL, output: { input: freeze_in, target: fx.tape.freeze, shape: STATE, priority: 700, authority_role: local_ui } }
```

**Touch tints** — twelve identical chains = one `Replicated` over a wildcard;
the slow rise/fall is an `Envelope AR` per electrode:

```yaml
reps:
  - over: { match: "touch.pad0.*" }
    bind: "${instance}"
    rate_domain: RATE_RENDER_FRAME
    graph:
      nodes:
        - { id: e,    input:    { path: "touch.pad0.${instance}" } }
        - { id: env,  envelope: { input: e, mode: AR, attack_ms: 800, release_ms: 4000 } }
        - { id: out,  output:   { input: env, target: "render.raster.tint_${instance}", shape: STATE, priority: 300 } }
      output_node: out
```

## Audio analysis → raster (the README envelope table, as IR)

```yaml
  - { id: bass,  rate_domain: RATE_CONTROL,      input:    { path: audio.main.bass } }
  # bassPulse: hard floor at 0.5, squared, peak-follow ~75 ms release
  - { id: kneed, rate_domain: RATE_RENDER_FRAME, curve:    { input: bass, kind: EASE_IN_QUAD, in_min: 0.5, in_max: 1.0, out_min: 0, out_max: 1, clamp: true } }
  - { id: pulse, rate_domain: RATE_RENDER_FRAME, envelope: { input: kneed, mode: PEAK_FOLLOW, release_ms: 75 } }
  - { id: pulse_out, rate_domain: RATE_RENDER_FRAME, output: { input: pulse, target: render.raster.bassPulse, shape: STATE, priority: 300 } }
  # bassRise → slice-tear EVENTs: rising-edge derivative as a Trigger
  - { id: tear, rate_domain: RATE_CONTROL, trigger: { input: bass, threshold: 0.07, hysteresis: 0.02, edge: RISING } }
  - { id: tear_out, rate_domain: RATE_CONTROL, output: { input: tear, target: render.raster.sliceTear, shape: EVENT, priority: 300 } }
```

(The full table — midPulse, smoothTreble jitter, onset freeze/shuffle — follows
the same three patterns: knee-`Curve` → `Envelope` for continuous, `Trigger`
for discrete. The freeze/shuffle *random rolls* are scene-plugin-internal.)

## Plugins

**`presence_choreography.v1`** (`GENERATOR`) — the whole bell/toll/voice/murmur
stack: ARM/FIRE/DISARM, dwell + confirm timers, scheduled random intervals,
skip/timbre/phrase rolls, the shared strike cooldown and voice min-gap. This is
today's `daisy-position.js` trigger logic, factored to the plugin boundary the
contract drew — sequential, stochastic, self-scheduled ⇒ not IR.

```yaml
asset: presence_choreography
version: 1
kind: GENERATOR
inputs:
  - { name: occupied,  value_type: BOOL,  shape: STATE, required: true }
  - { name: nearness,  value_type: FLOAT, shape: STATE, required: true }
  - { name: velocity,  value_type: FLOAT, shape: STATE, required: false }  # cm/s, approach negative
  - { name: motion,    value_type: BOOL,  shape: STATE, required: false }  # murmur self-disables without it
params:   # every env-var knob, verbatim: enter/empty fractions, approach cm/s +
          # sustain, rearm/cooldown/dwell/confirm seconds, toll + murmur min/max/
          # skip, industrial prob, phrase count
outputs:
  - { name: strike, value_type: VEC,  media: SIGNAL, dest: BUS, bus_path: "synth.bell.strike", shape: EVENT }  # [note, velocity, timbre]
  - { name: speak,  value_type: INT,  media: SIGNAL, dest: BUS, bus_path: "voice.main.speak",  shape: EVENT }  # phrase index
rate_domain: RATE_CONTROL   # reacts to occupancy/nearness packets…
requires_host_tick: true    # …AND has self-scheduled behavior (toll/murmur timers,
                            # cooldown expiry) — the host must tick it (plugin.v1)
determinism: REPLAYABLE     # host-seeded PRNG; golden-traceable
state_model: SNAPSHOTTABLE  # arm flags + schedules are plain data — reload-safe
```

Randomness comes from the **host-seeded PRNG** (plugin contract → *Randomness*),
so the toll/murmur/timbre behavior is replayable in golden traces.

**`pain_material_raster.v1`** (`SCENE_RASTER`) — already sketched in
`PLUGIN_CONTRACT.md`; its inputs are the `render.raster.*` sinks above.

## Transports & priorities

- **MIDI adapter** (the single serial-port owner): binds `fx.tape.failure` →
  CC 23 and `fx.tape.freeze` → CC 24 (7-bit quantize, on-change dedupe, 30 Hz
  cap — adapter behavior, not graph nodes); `synth.bell.strike` → note-on with
  channel = timbre (0 bell / 1 industrial); `voice.main.speak` → ch 2 note-on,
  note = phrase index. Reads `POS`/`RESET` and publishes the
  `clock.daisy.position` tuple.
- **Priorities** as `ProjectPolicy`: `local_ui 700` (freeze) > `timeline 500`
  (ceilings) > `sensor 300` (everything distance/touch-driven).

## Deliberately *not* in the IR

Empty-room learning, VL53L5CX zone-grid→closest-target reduction, velocity
estimation (sidecar = smart source); CC framing/rate-capping (transport
adapter); freeze/shuffle random rolls and all raster effects (scene plugin);
bell/voice sequencing (choreography plugin).

## Open items

- `Merge`/`Cooldown` nodes if strike sources ever split across plugins
  (ROUTER_IR → *Anticipated*).
- `sensor.door.far_cm` arriving mid-show re-parameterizes live `Normalize`
  ramps — intended, but the inspector should surface calibration changes.
- Phrase-enum declaration in the firmware manifest (kills the
  comment-contract with `dsp::pain_voice::PHRASE_LABELS`).
- Whether `tear`-style audio triggers stay host-side (in-browser tap) or move
  with a future analysis sidecar — the names don't change either way; that's
  the point.
