# Granulizer — granular cloud sampler/effect

**Status: design only (2026-06-18). No code.** An FL-"Fruity
Granulizer"-style granular engine: a source buffer played back as a cloud
of overlapping windowed grains, with grain size / density / position /
pitch and their randomizations. Member of the buffer-player family with
`TRANSPORTER.md` and the existing `Freeze` (see *Shared substrate*).
Subsumes the existing backlog "Grain-delay / granular send" item.

## Concept

A grain scheduler emits short windowed reads ("grains") from a source
buffer, overlapping and summed into a continuous texture. Move the read
**position** slowly for a frozen drone, in real time for a shimmer, or
scatter it for a cloud. Each grain has a position, length, pitch, pan, and
an amplitude window; randomizing those turns a sample into anything from a
time-stretch to a wash.

## Source

The grain engine reads a buffer; the buffer is either:
- **Live capture** — a rolling SDRAM ring of incoming audio (granulize the
  Daisy mix, or the voice), with a **freeze** that stops the write head so
  the playhead grazes a held slice; or
- **Loaded sample** — a field recording / one-shot (shares the `Sampler` /
  backing-track loading path).

Same engine over either; a `source` param picks live-ring vs sample.

## Signal flow

```
source buffer (SDRAM) ──► [ grain scheduler ] ──► Σ grains ──► wet ─┐
       ▲                       │  emits grains at `density`,         ├─► out
       │                       │  each: pos+jitter, size, rate,      │
   write head                  │  pan, window(table)                 │
   (live) / fixed (sample)     └─────────────────────────────────────┘
in ───────────────────────────────────────────────────► dry ───────┘
```

## Grain engine internals

- **Grain pool**: a fixed array of grain slots (e.g. 24–32 max for the
  H750), no allocation. The scheduler activates a free slot every grain
  interval; a finished grain frees its slot. Polyphony is capped and `log`
  / counted, never grows.
- **Each grain** holds: `read_pos` (f32, into the source), `rate`
  (playback speed = pitch), `samples_left`, `pan`, and `win_phase` (0..1
  across its life). Per sample it does one **interpolated read** of the
  source at `read_pos` (advance by `rate`), multiplies by the **window
  table** lookup at `win_phase`, and pans.
- **Window table, precomputed** (Hann/Tukey, one table, indexed by
  `win_phase`). This is the load-bearing RT decision: computing a window
  (a `cos`) per sample per grain is transcendentals × polyphony — exactly
  the cost the realtime memo warns about. Table lookup makes the window
  free. Same table the Transporter's loop-seam crossfade uses.
- **Scheduler** emits at `density` (grains/sec, or as an overlap factor vs
  grain size). Higher density / longer grains = more simultaneous slots.

## Parameter surface

**MVP (the FL Granulizer feel):**

| Param | Range | Notes |
|---|---|---|
| `grain_size` | ~5–500 ms | length of each grain |
| `density` | grains/sec (or overlap) | grain rate; drives polyphony |
| `position` | 0..1 | playhead into the source |
| `scan` | −1..1 | how fast/which way `position` drifts (0 = frozen drone) |
| `pitch` | semitones | grain playback rate |
| `spray` | 0..1 | master randomization of position + timing |
| `dry` / `wet` | 0..1 | mix |
| `freeze` | 0/1 | (live source) stop the write head → drone from a slice |

**Refinements (optional):**
- `pos_jitter` / `pitch_jitter` / `pan_spread` (split the `spray` master)
- `pitch_quantize` (snap grain pitches to a scale/chord → harmonic cloud)
- `window_shape` (attack/decay skew of the grain envelope — the FL
  Attack/Hold/Release)
- `source` (live-ring | sample); `direction` (forward | reverse grains)
- `stereo_source` handling / mono-collapse

Ship the MVP rows; the jitters and pitch-quantize are the expressive
follow-ups.

## Integration (this project's idioms)

- **DSP module** `daisy/crates/dsp/src/granulizer.rs`, real-time-safe:
  fixed grain pool + window table allocated once, SDRAM source buffer, no
  alloc in `process()`, interpolated reads, f32 math.
- **Params** in `Param` + `apply_param` (`midi_map.rs`), CC-mapped → bus-
  and CC-controllable; a project routes sensors/sequencer to them via
  graphs (generic mechanism, no piece-specific mapping baked in).
- **Browser UI**: a `GranulizerPatch` (serde) + a `static/audio` panel,
  live against real Rust DSP via `patch_server` (FM/bass/wt pattern).
- **Mood layer**: when the granular fx key lands in the mood anchors
  (currently excluded — see the backlog item), the mood blend can drive
  `density`/`position`/`pitch`. Generic; not baked in here.

## RT / memory (the watch items)

- **CPU scales with active grain count** (each grain = an interpolated read
  + window lookup + pan, per sample). Cap polyphony; let `density` ×
  `grain_size` bound it. Profile against the H750 budget (the realtime
  memo: per-sample cost × polyphony is the danger).
- **Source buffer in SDRAM**; grain pool + window table in fast RAM.
- **No transcendentals in the grain loop** — window via table, pitch via
  linear (or 4-point) interpolation, no `cos`/`pow` per sample.

## Shared substrate

Granulizer, `TRANSPORTER.md`, and `Freeze` share: an SDRAM
**capture/source buffer** (live ring or loaded sample), **interpolated
reads**, and a **window/crossfade table**. `Freeze` = one frozen grain
looped; Transporter = two whole-slice loop players; Granulizer = a cloud of
short grains. Build the buffer + interpolated-read + window-table primitive
**once** and have all three share it — the cleanest way to ship this family
without three divergent capture implementations. A small
`dsp::buffer_player` (or extend `Freeze`'s capture) is the natural home.

## Open questions

1. **Default source: live ring or loaded sample?** Live is the more
   exhibit-relevant effect; sample is the more instrument-like. Both share
   the engine; which is the default UI mode?
2. **Polyphony cap** — fix the grain-slot count by the H750 budget
   (profile), and decide overflow policy (steal oldest vs drop new).
3. **Played pitch source** — a fixed `pitch` param vs MIDI/keyboard vs a
   bus-routed pitch (chord from the sequencer) for a playable instrument.
