# Replay harness (phase 0 — MIGRATION_PLAN.md)

Closes the loop on phase-0 captures: re-injects a recorded session's inputs
into the **unmodified** legacy bridge and verifies the outputs reproduce under
declared tolerances. This is the *replay harness* maturity level (phases 0–3);
the graph simulator is phase 4.

```sh
# replay a captured session (exit 0 = MATCH/EXPECTED only, 1 = blocked, 2 = harness error)
node tools/replay/replay.js projects/pain-material/fixtures/<session>/ [--quiet]

# record a scripted ~20 s smoke session (no kiosk needed), then replay it
node tools/replay/smoke-session.js
node tools/replay/replay.js <printed-session-dir>
```

## How it works

- `serialport-shim.js` is `--require`'d into the spawned bridge so
  `require('serialport')` resolves to a fake whose far end is `fake-daisy.js`
  (a TCP server that injects captured POS/RESET lines and records MIDI TX).
  The legacy bridge code runs byte-for-byte unchanged.
- Inputs replayed in capture order at capture pacing: `/ingest` raw bodies
  (including bodies that were *dropped* — same bytes must drop the same way)
  and Daisy serial RX lines. Trigger-shaping env (`BELL_*`, `VOICE_*`, …) is
  restored from the golden's `meta.json`.
- The replay run is itself captured (`<golden>/replays/<session>/`), and the
  comparator diffs golden vs replay capture per type: bool/int/enum exact,
  floats epsilon abs+rel, CC trajectories as step functions within a time
  window, note events by ordered correspondence per class.
- Verdicts are four-way (MATCH / EXPECTED_DIFFERENCE / REGRESSION / UNKNOWN);
  REGRESSION and UNKNOWN block. Signals with no entry in `tolerances.js` come
  back UNKNOWN — the tolerance table is the only source of "≈ 0".
- Declared EXPECTED_DIFFERENCEs: everything the legacy code decides with
  `Math.random` — toll/murmur scheduling, the industrial timbre roll, the
  voice phrase pick. The capture's `trigger` events (reason recorded at strike
  time) classify each note so the deterministic classes still gate hard.

Gates are declared for `--speed 1`; the bridge's rate caps and trigger state
machines run on wall time, so a time-scaled replay legitimately diverges.

`report.json` lands next to the replay capture.
