# Graph simulator (phase 4 — MIGRATION_PLAN.md)

Replay maturity level 2: **manifests + policy + graph → output + `_meta`
logs**, fully deterministic. Where the replay harness (`tools/replay/`,
phases 0–3) re-injects captured bytes into the live legacy bridge under wall
time, the simulator runs the orrery pipeline — registry, bus, RouterGraph —
under **virtual time** driven by the capture's own `t_mono_ms` timeline. A
63-minute golden simulates in about a second, and two runs produce
byte-identical logs (the determinism the router contract promises:
arrival-driven paths are deterministic *given the packet log*).

```sh
# 4A identity gate (default): echo every mapped path back at incumbent-1 priority
node tools/sim/sim.js projects/pain-material/fixtures/<golden>/

# any router.v1 graph (proto-JSON), report-only
node tools/sim/sim.js projects/pain-material/fixtures/<golden>/ --graph my-graph.json
```

Exit 0 = MATCH / report-only, 1 = gate fail, 2 = harness error. Output lands
in `<golden>/sims/<label>-<stamp>/`: `signals.jsonl` (every accepted signal
packet, bus arrival order), `meta.jsonl` (the 1 Hz virtual `_meta`
self-description), `report.json` (the verdict + every count).

## How it works

- **Layer choice:** the pump consumes the capture's *decoded* layer (`items`
  on ingest, `decoded` on serial_rx) and mirrors the legacy `publish()`
  on-change dedupe. Raw-byte decode fidelity stays the replay harness's job;
  the simulator proves everything from the input bus down.
- **The production adapter, not a copy:** `server/src/bus-adapter.js` runs
  with its clock injected, so writer discipline (publish-on-change +
  keepalive) is the real code under virtual time.
- **Manifests + policy load exactly as the bridge loads them.** The identity
  echo's authorization comes from a sim-scoped role overlay
  (`sim_identity_echo`, in memory only, declared in the report) because no
  real role may publish across sensor/touch/clock/ui — the real `router`
  role (fx.* only) lands in policy.json with 4C.
- **Engine semantics** (ROUTER_IR.md): arrival-driven `RATE_CONTROL`
  evaluation in compiled topo order; the engine never reacts to its own
  writes (the in-process analog of rule 2, and what makes the deliberate
  identity-echo loop well-defined). 4A implements `Input`/`Output` only;
  graphs using anything else are rejected at compile, loudly.

## The 4A gate (passed 2026-06-10)

Identity graph over the 63-min mock golden: 281,353 packets in → 281,353
echoes, 0 mismatches / extra / missing; 72,096 arbitration checks, 0
violations (every echo candidate reads `would_win_if_priority_ge_legacy` —
the exact pre-cutover shadow state); 0 rejects, 0 policy WARNs; two runs
SHA-256-identical. Tests: `server/test/sim.test.js`.

## The 4B gate (passed 2026-06-10)

```sh
node tools/sim/validate-tape.js projects/pain-material/fixtures/<golden>/
```

The compiled nearness graph (`projects/pain-material/manifest/graphs/
tape-failure.json`, live near/far endpoints, authorized by the project's own
`router` role) runs over the golden; its `fx.tape.failure` trajectory passes
through the MIDI transport adapter model (0..127 quantize, on-change dedupe,
33 ms per-CC cap — `writeCc` verbatim; this stays OUT of the graph by design)
and is compared to the captured CC 23 stream with the phase-0 comparator's
step-function rules. Result: **15,205 predicted = 15,205 captured, exact.**

**4B discovery** — legacy validates endpoint claims consumer-side
(`far > near`, `0 ≤ near < far`); the golden contains a real `far=50` claim
legacy rejected while the phase-1 bus adapter forwarded it raw. At 4C that
conditioning moved INTO `bus-adapter` (with the 75/130 defaults as a standing
idle-priority writer), so the validator needs no seeds and no mirroring — the
production writer discipline does it all. Op evaluators:
`server/test/graph-ops.test.js`.

## The 4C live lane (passed 2026-06-11)

The bridge now runs the compiled graph LIVE (shadow — nothing consumes
`fx.tape.failure`), tapping every graph write into the capture as `bus_tx`.
`validate-tape.js` gains a third lane: when a capture carries `bus_tx`, the
live value-change sequence must equal the simulated one exactly (publish
counts differ legitimately — wall-clock keepalive cadence — value changes are
the invariant). Proof on a real-time replay of the real-sensor golden:
**1,701 live changes = 1,701 sim changes, pointwise**, alongside CC 23 MATCH.
Legacy serial == simulated graph == live graph.

Two rules the live run taught (both tested): the engine reads the
**arbitrated resolved value**, never packet payloads (a low-priority defaults
keepalive must not drag the graph to a shadowed value); and the replay
comparator's CC lane carries a declared, bounded **cap-dropped transient**
excusal (`transient_max_ms`/`transient_budget` in tolerances.js) for
one-sample sensor spikes the 33 ms wall-clock cap keeps or drops on ms-level
alignment luck.

Next: 4D — the MIDI adapter consumes the resolved `fx.tape.failure` (legacy
still winning), after a full kiosk session soaks the 4C shadow.

## Phase 5 — visualizer mapping gates

```sh
node tools/sim/validate-twist.js  projects/pain-material/fixtures/<golden>/
node tools/sim/validate-bitmap.js projects/pain-material/fixtures/<golden>/
```

Shared machinery in `viz-gate.js`; since the phase-5 cutover deleted the
in-page ramps, each validator's frame-clocked legacy model is the **frozen
spec** of the deleted browser math, and these are the standing regression
gates for `fx.viz.twist_gain` / `fx.viz.bitmap_x`.

## Phase 6.0 — plugin host gate

```sh
node tools/sim/validate-plugin.js projects/pain-material/fixtures/<golden>/
```

Three legs over the golden's virtual timeline, with the production
manifests + policy + bus-adapter live: **replay** (two from-scratch runs of
every hosted plugin instance must emit byte-identically — seeded PRNG,
host-tick discipline), **resume** (snapshot all instances at the midpoint,
discard the host, rebuild with deliberately wrong seeds, restore, continue —
the tail must equal the straight run's exactly, proving snapshots carry
plugin state AND PRNG state), and **hygiene** (zero crashes / publish
rejects / policy WARNs / queue drops). Passed 2026-06-11 on all three
goldens (mock 63-min: 93 emissions; cutover: 7; viz-cutover: 1). Host unit
tests: `server/test/plugin-host.test.js`.
