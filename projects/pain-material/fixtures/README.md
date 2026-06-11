# Phase-0 baseline captures (MIGRATION_PLAN.md)

Recorded sessions of the legacy bridge, captured at its boundaries by the
read-only tap in `server/src/capture.js`. These are the golden traces every
later migration phase replays against.

## Recording a session

```sh
CAPTURE=1 ./run_kiosk.sh          # on the Pi — sessions land here
CAPTURE_DIR=/some/path ...        # anywhere else (smoke tests, dev runs)
```

Capture is a tap, not a feature: with `CAPTURE` unset the bridge runs exactly
as before (no directory, no extra code paths, `ready` advertises
`capture:false` so the page never POSTs snapshots).

**Deliverable 1 (phase 0): ≥ 1 h of real kiosk session logs in this
directory.** Record with the real Daisy + sensors + browser attached.

No sensors wired? Every sidecar driver mocks (the rule: sensors must always be
mockable). The mocks run the drivers' full pipelines — distance gets EMA
smoothing, velocity, the empty-room learner; everything still crosses the real
`/ingest` batching boundary — so the capture is structurally identical to a
hardware session:

```sh
CAPTURE=1 ./run_kiosk.sh --mock           # ALL drivers synthetic (ToF, AM312, MPR121, breath)
CAPTURE=1 ./run_kiosk.sh --mock-distance  # only the ToF mocked; other attached hardware stays real
```

(`--no-pir` / `--no-distance` / `--no-breath` / `--no-touch` skip drivers
entirely; note that passing any args to `run_kiosk.sh` replaces its default
`--no-pir --no-breath` set.)

The synthetic feeds: a ~25 s visit cycle on distance (idle → approach → dwell
→ retreat), motion toggling every ~10 s with jitter, seeded-random touch-mask
walks. That exercises bell/voice/CC continuously and replays exactly like a
hardware capture. Label such goldens (`golden-mock-*`), and re-record with
real sensors before tuning comparator tolerances against real-world noise
(phase 4B validates against captured CC 23 traces — synthetic traces are
cleaner than the sensor ever is).

## Session layout

```
<session-id>/             e.g. 2026-06-10T19-20-21Z-pid55063/
  meta.json               boot_epoch, git SHA, node/platform, env + config in effect
  events.jsonl            every boundary event, one per line, in observed order
```

`events.jsonl` lines carry `seq` (capture order — canonical for replay,
invariant lock #1), `t_mono_ms` (monotonic bridge receive time), `t_wall_ms`,
`kind`, and kind-specific fields. Raw payloads ride along as `raw` (utf8) or
`raw_b64` so decode bugs are discoverable from the capture alone.

| kind | boundary |
|---|---|
| `ingest` / `ingest_drop` | `/ingest` POST bodies, raw + decoded; drops logged raw with reason |
| `sse_out` | the logical SSE broadcast stream (one event per publish) |
| `sse_connect` / `sse_disconnect` | browser lifecycle (reload = disconnect/connect pair + fresh `page_load_id`) |
| `browser_snapshot` | periodic `window.AMBIENT_INPUTS` snapshot POSTed by the page |
| `serial_rx` | every line from the Daisy (POS/RESET), raw + decoded, unmatched lines included |
| `serial_tx` | every MIDI frame written to the Daisy (CC + note), hex + decoded, in write order |
| `serial_err` / `serial_open` / `serial_close` | write/flush errors and port lifecycle |
| `trigger` | bell/voice strike reasons (classifies deterministic vs stochastic events for the comparator) |
| `counters` | periodic + final tallies (the final one flushes on SIGINT/SIGTERM/exit) |

## The bar for "replayable" (Deliverable 2)

A capture is a regression suite — not just evidence — once
`tools/replay/replay.js <session-dir>` re-injects its inputs into the
unmodified legacy bridge and every comparison comes back
MATCH / EXPECTED_DIFFERENCE under the declared tolerances
(`tools/replay/tolerances.js`). REGRESSION or UNKNOWN blocks.

Sessions here stay untracked by default (an hour of kiosk logs is big and
mostly disposable). Promote a session to a tracked golden by renaming it
`golden-<description>/` and gzipping the event stream (`gzip -9
events.jsonl`; the replay tooling reads `.gz` transparently, and an hour
compresses ~10x). Replay runs write under `<golden>/replays/`, which stays
local. Re-record a fresh golden after every cutover.

Mock-mode (`MOCK=1`) captures are not replayable: the mock publishes directly
onto the in-process bus, bypassing the `/ingest` boundary the harness
re-injects. Capture real or scripted sessions (`tools/replay/smoke-session.js`).

## Tracked goldens

- **`golden-mock-2026-06-10T20-28-44Z-pid3067/`** — 63.3 min on the Pi, real
  Daisy, all sensors via sidecar mocks (phase-0 Deliverable 1; the phases 0–4B
  baseline). Replay: 12 MATCH + 1 declared EXPECTED_DIFFERENCE.
- **`golden-real-2026-06-11T03-15-13Z-pid6205/`** — 3.6 min on the Pi, real
  Daisy + real VL53L5CX + dual AM312 (`MOTION_PRESENCE=1`), touch ballast;
  config `d720648` (near 75 / far 170, the far claim *valid* and accepted —
  the first golden exercising live learned endpoints rather than defaults).
  Directed choreography: full ramp both directions (0.1→170.7 cm), hysteresis
  loitering, forced no-target dropouts (snap to far=170), brisk exit/re-entry,
  empty bookends. Verified 2026-06-11: replay (speed 1) all MATCH incl. CC 23
  + 3 entry bells + 2 exit voices; identity sim MATCH; 4B tape validation
  MATCH (1218 predicted / 1220 captured). The real-sensor golden the 4E
  tolerance tuning draws from.
- **`golden-cutover-2026-06-11T14-08-29Z-pid2793/`** — 5.4 min on the kiosk,
  real sensors + Daisy + browser (touch + freeze traffic, entry bell, toll);
  the **4E soak session and the first post-cutover golden**: CC 23 in it was
  produced by the router graph (sole writer of `fx.tape.failure` since 4F),
  and it is the first capture carrying `bus_tx` aboard. Verified 2026-06-11:
  replay (speed 1, through the ramp-less 4F bridge) all MATCH/EXPECTED incl.
  CC 23 750/747 + CC 24 freeze 44/44 exact; tape validation MATCH with the
  live lane exact (1344 = 1344 value changes, capture `bus_tx` vs sim). The
  canonical golden for phase 5+.
