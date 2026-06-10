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
`golden-<description>/` — re-record a fresh golden after every cutover.

Mock-mode (`MOCK=1`) captures are not replayable: the mock publishes directly
onto the in-process bus, bypassing the `/ingest` boundary the harness
re-injects. Capture real or scripted sessions (`tools/replay/smoke-session.js`).
