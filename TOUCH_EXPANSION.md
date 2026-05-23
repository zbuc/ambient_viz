# Touch Expansion: Room-Scale Topologies

The current kiosk has one MPR121 close to the Pi, with short (<30 cm)
electrode runs. This doc captures the two viable architectures for
extending touch input to objects spread several meters around a room,
and the tradeoffs between them.

**Authoritative sensor spec is `hardware-handoff.md`.** This doc is
forward-looking architecture; the handoff doc is what's actually
wired today.

The rule that motivates both options: **electrode wires must stay
short (<30 cm).** Capacitive sensing on long wires degrades fast —
parasitic capacitance inflates baselines, and the wires become
antennas for mains-frequency EMI. Long runs must happen on something
*other* than electrode wire.

---

## Option A — Wired: Multi-MPR121 over extended I²C

Push the MPR121 chips out to where the objects are; run only I²C +
power back to the Pi.

```
                ┌─ remote MPR121 ────┐
                │  (E0..E11)         │
                │   short electrode  │
                │   wires to objects │
Pi ── I²C ──────┤                    │
   bus extender │  ADDR pin sets     │
   each end     │  unique addr per   │
                │  remote board      │
                └────────────────────┘
                   ×N remote clusters
```

**Bus extension at distance:**

- **<1 m**: raw CAT5 twisted pair, 100 kHz, 4.7 kΩ pull-ups at Pi end.
- **1-3 m**: same, drop to 50 kHz, possibly stiffen pulls to 2.2 kΩ,
  or add an LTC4311 active accelerator at the far end (single chip,
  ~$3, sits on the bus transparently).
- **3-15 m**: differential extenders — P82B96 (~$3-8 hobby breakouts,
  abundant on AliExpress) or PCA9615 (~$15+ assembled, hard to find
  cheap). Two boards per run, one at each end. Driver-transparent.
- **>15 m**: out of scope for single-bus I²C; use Option B.

**Capacity:** Up to 4 MPR121s per I²C bus (ADDR pin → 0x5A/5B/5C/5D)
= 48 electrodes total. Beyond that, a second I²C bus (Pi has more)
or Option B.

**Code changes from current state:**

- `python/ambient_kiosk/sensors/touch.py` instantiates one
  `MPR121(i2c, address=0x5A)`. For multiple boards, iterate over a
  list and OR their masks into a single `touch_mask`.
- Worker's `TOUCH_COLORS` / `TOUCH_ENV` are sized for 12 electrodes;
  grow if more channels are needed.

**Pros:**
- Zero new transport layer — the existing Pi → Python sidecar →
  Node bridge → SSE → visualizer pipeline carries it unchanged.
- Sub-5 ms latency (wired I²C).
- No firmware to write or maintain.
- No network dependency.

**Cons:**
- Cabling effort scales linearly: every remote cluster needs a
  CAT5-or-similar run + power.
- Per-cluster cost: ~$30-40 once you add extender chips, MPR121
  breakout, power conditioning, connectors.
- Bus integrity becomes more fragile as you add nodes — debugging
  requires `i2cdetect` discipline and bus-quality verification.

---

## Option B — Wireless: ESP32 satellites over WiFi

Put an ESP32 near each object cluster. ESP32 has 10 built-in
capacitive touch channels (14 on S2/S3) — no MPR121 needed at all.
The ESP32 talks to the Pi over WiFi by POSTing to the existing
`/ingest` endpoint.

```
            ┌─ ESP32 satellite ──────┐
            │  Touch T0..T9          │
            │  short electrode wires │
            │  to objects            │
            │                        │
            │  WiFi  ── POST ─────── │ ──→ Pi:8080/ingest
            │  → {"name":"touch_     │
            │      mask_zoneA",      │
            │      "value": <int>}   │
            └────────────────────────┘
                  ×N satellites
                  (independent WiFi clients)
```

**Per-cluster hardware:**

- 1× ESP32 dev board (~$3-5).
- Local 5V USB power (wall wart, USB-C, whatever — no CAT5 runs).
- Short electrode wires to objects.

**Code changes required:**

- **ESP32 firmware** — written from scratch. Arduino IDE,
  ESPHome, or MicroPython. Reads `touchRead(Tn)`, debounces against a
  local baseline, builds the bitmask, HTTP POSTs on change.
- **Node bridge `/ingest`** is currently localhost-only (see
  `isLoopback()` in `server/src/index.js`). Relax to allow LAN with
  required `X-Ingest-Token` header for non-loopback clients. Loopback
  (Python sidecar) stays unauth'd. ~10-line change.
- **Visualizer worker** — if mixing multiple sources (MPR121 + ESP32s
  or several ESP32s), each source publishes a distinct name
  (`touch_mask_main`, `touch_mask_zoneA`, …) and the worker ORs them
  into a single mask per frame. `TOUCH_COLORS` / `TOUCH_ENV` grow to
  match total channel count.

**Pros:**
- Cheapest per cluster (~$5-10 vs $30-40).
- Zero wiring beyond local USB power — pure WiFi for data.
- ESP32 can also drive local LEDs/sensors/whatever in the same cluster.
- Scales further than a single I²C bus (no 4-board ceiling, no
  capacitive-loading concerns).

**Cons:**
- Latency ~10-30 ms (WiFi + HTTP) vs <5 ms wired. The 8 s rise tau
  on the visualizer envelope absorbs this trivially, but it's
  measurable.
- WiFi can drop, reconnect, suffer congestion. Needs a router with
  reachable coverage at every satellite location.
- Firmware is now a thing you maintain. OTA updates help; ESPHome
  has them out of the box.
- Per-satellite WiFi/auth state means more failure surface than a
  passive cable.

---

## Choosing between them

| Question | Lean toward |
|---|---|
| Distances ≤ ~3 m, one or two clusters | **Option A** (P82B96 or just CAT5 + LTC4311) |
| Distances >5 m or many scattered clusters | **Option B** (ESP32 + WiFi) |
| Have an ESP32 and don't want to source extender ICs | **Option B** |
| WiFi is unreliable / unavailable in the space | **Option A** |
| Want lowest cost per cluster | **Option B** |
| Want lowest latency (and lowest firmware footprint) | **Option A** |
| Mix of close + remote clusters | **Hybrid** (see below) |

## Hybrid

Both options coexist cleanly:

- Keep the wired MPR121 for objects inside or near the kiosk's
  enclosure (zero latency, no new code).
- Add ESP32 satellites for clusters out in the room.

Each source publishes to its own distinct `touch_mask_*` name; the
visualizer worker ORs them all into the touch envelope state. No
contention. Each satellite is independent — one going down doesn't
affect others.

---

## Implementation status

Neither expansion option is implemented yet. The current code path
assumes a single MPR121 at the default address publishing to
`touch_mask`. When ready to extend:

1. Decide which option (or hybrid mix) to commit to.
2. For Option A: extend `touch.py` and grow worker arrays.
3. For Option B: write ESP32 firmware, patch Node bridge auth,
   grow worker arrays.
4. Verify with the existing mock + visualizer pipeline before
   building physical hardware.
