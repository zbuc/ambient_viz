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
legacy rejected while the phase-1 bus adapter forwarded it raw. Until 4C
hoists that conditioning to the bridge ingest boundary, the validator applies
a declared mirror of the guards (`conditionEndpoints`, drops counted in the
report). Op evaluators: `server/test/graph-ops.test.js`.

Next: 4C runs this graph live in the bridge as a shadow writer (after the
ingest-boundary conditioning hoist), nothing consuming it, inspector diffing.
