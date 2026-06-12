# Day-of-Installation Setup

On-site checklist for installing an **already bench-tested** kiosk at the venue.
For first-time/bench bringup or any failure, fall back to `PI_KIOSK_BRINGUP.md`.

The one venue-specific step is calibrating the distance sensor to the
curator's projector — everything else should already work.

---

## 1. Mount

- Place VL53L1X at the screen plane, **facing outward** toward viewers (not at the screen).
- **Recess it ~1 cm behind the screen surface** (or add a small shroud) so the projector beam can't graze its cover glass.
- Sensor at adult chest height; cone is a narrow ~15°.
- Check the sensor's shadow on the projected image — hide it (bezel / bottom edge) or accept it.

## 2. Power on + bus check

```sh
cd ~/ambient_viz && sudo i2cdetect -y 1
```

- `0x29` (distance) and `0x5A` (touch) must show, steady across repeated scans.
- Missing/flickering → `PI_KIOSK_BRINGUP.md` Phase 3.

## 3. Calibrate distance sensor to the projector  ← the venue-specific step

```sh
cd ~/ambient_viz/python && source .venv/bin/activate
python test_tof.py          # L1X auto-detected; this calibration step is L1X-only
```

- Point at the real wall. Read the **`amb`** column with the **projector OFF**, then **ON**.
- Set `VL53_AMBIENT_LONG_MAX` in `python/ambient_kiosk/config.py` **just above the OFF (dark) baseline**.
  - Projector adds little IR (LED/laser) → leaves headroom → long mode, more reach.
  - Projector floods IR (bright lamp) → ON value exceeds the threshold → short mode, ambient-immune.
- Sanity-check accuracy: held target tracks within ~2 cm @ 30 cm, ~5 cm @ 100 cm.

## 4. Launch + confirm auto-mode

```sh
cd ~/ambient_viz && ./run_kiosk.sh
```

- Watch the sidecar log for the auto-select decision:
  ```
  distance: ambient median=… (long_max=…) -> short mode
  distance: VL53L1X ready (mode=1, budget=20ms)
  ```
- `mode=2` = long, `mode=1` = short. Confirm it matches what step 3's numbers implied.
- Wave a hand: `distance_cm` should track ~100 cm → ~5 cm and back.

## 5. Display

- Chromium kiosk URL:
  ```
  http://localhost:8080/?lite=1&bitmap=360&distanceToBitmap=on
  ```
- Walk toward the screen — the bitmap ceiling should tighten as you approach.
- For unattended autostart (systemd + Chromium): `PI_KIOSK_BRINGUP.md` Phase 9.

## 6. Before walking away

- Reboot once; confirm the kiosk comes back up unattended and the auto-mode log reappears.
- Re-run step 3 if the projector or its position changes during the run.

---

## Tuning the experience

The handful of knobs that actually shape the interaction for the **current setup**
(VL53L5CX distance + optional AM312 motion; no MPR121 touch). Everything else can
stay default. Two locations:

- **Distance** — `python/ambient_kiosk/config.py` (those marked *env* can instead
  be set on the **sensors** service, e.g. `Environment=DISTANCE_NEAR_CM=80`).
- **Motion / voice** — project config since the phase-6 cutover: the occupancy graph
  (`manifest/graphs/occupancy.json`) and the presence plugin's binding
  (`manifest/plugins/presence.json`); details in the moved section below. (The old
  `kiosk_motion_on` env drop-in is inert.)

**Distance (VL53L5CX):**

- **`DISTANCE_NEAR_CM`** (75, *env*) — the effect *onset*: within this distance the
  visuals/tape sit clean, and the distortion grows from here out to the far reach.
  Lower → effects only kick in up close; raise → they start from farther away.
- **`VL53L5CX_FAR_CM`** (400) — the far reach: the "fully destroyed" saturation point
  and the no-target "empty" snap (the empty-room learner refines it live from here).
  Set it near the real empty-room depth so the ramp spans the room's actual usable distance.
- **`VL53L5CX_CONE_ZONES`** (None = all zones) — which grid zones count toward the
  closest-target distance. Leave None for max coverage; set a tuple to drop zones that
  graze the floor/ceiling/walls and cause phantom "someone's here" reads — find the
  bad zones by watching the live grid in `python test_tof.py l5cx`.
- **`NO_TARGET_TIMEOUT_S`** (1.5, *env*) — seconds of no-target before the room reads
  empty. Higher rides out flicker (dark clothing, oblique torso) but a real walk-away
  takes longer to register; lower is snappier but twitchier.
- **`EMPTY_ROOM_MIN_CM`** (200, *env*) — the nearest distance that can be *learned* as
  the empty-room baseline; a still reading closer than this is treated as a motionless
  visitor, not the room. Raise if near clutter/wall gets learned as "empty"; lower for a tight install.

**Motion (AM312) + voice cadence — project config (moved at the phase-6 cutover):**

The old server env knobs (`MOTION_PRESENCE`, `MOTION_HOLD_S`, `VOICE_TOLL*`) are inert.
The same levers now live in two project files:

- **Occupancy motion fusion + hold** — `projects/pain-material/manifest/graphs/occupancy.json`:
  the motion envelope's `releaseMs` (20000) is the old `MOTION_HOLD_S` — how long the room
  stays "occupied" after the last motion (sets how promptly the **exit voice** fires when
  people leave). Motion always augments occupancy now; to run distance-only, remove the
  `motion_env`/`occ_motion` branch from the graph.
- **Trigger knobs** — `projects/pain-material/manifest/plugins/presence.json` (params; defaults
  in `server/src/plugins/presence-choreography.js`): `motion_presence` selects the bell mode
  (1 = occupancy-edge bell, 0 = distance approach gate); `voice_toll_min_s`/`voice_toll_max_s`
  (300/600) the murmur interval — widen for rarer, narrow for more frequent surveillance
  whispers, `voice_toll: 0` to disable; cooldowns, dwell/confirm windows, skip probabilities
  all alongside. Edits load at bridge restart; the seed lives in the same file (change it and
  golden replays no longer reproduce — re-record after intentional changes).

---

**Ping back if:** ambient reads near `long_max` in both modes (effect feels unreliable),
the sensor can't see past ~1 m even in long mode, or the projector shadow can't be hidden
acceptably. Capture the sidecar log either way.
