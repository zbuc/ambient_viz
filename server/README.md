# ambient_viz server

Serves `../static/` over HTTP and streams kiosk sensor inputs to the
browser over Server-Sent Events at `/events`. Runs on the Pi alongside
Chromium and a Python sensor sidecar (see `../python/`); receives sensor
publications over a local POST `/ingest` and fans them out as SSE.

The visualizer itself still works opened directly via
`file://.../static/index.html`; the server is only needed when you want
GPIO-driven control.

## Run

```sh
node src/index.js
# or
npm start
```

Open <http://localhost:8080/>.

No npm dependencies — pure Node stdlib.

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `MOCK` | `0` | Set to `1` to enable the in-process mock source (fake sensor data, no Python needed). Useful for Mac-side SSE plumbing tests. |
| `INGEST_TOKEN` | (none) | If set, `POST /ingest` requires header `X-Ingest-Token: <value>`. Without this var, `/ingest` accepts any localhost request unauthenticated. |
| *(presence knobs)* | — | **Moved at the phase-6 cutover.** The bell/toll/exit-voice/murmur knobs (bell note/velocity, industrial probability, cooldowns, toll + murmur intervals and skip probabilities, dwell/confirm windows, bell mode) are now `presence_choreography.v1` plugin params, set per instance in `projects/pain-material/manifest/plugins/presence.json` (defaults in `server/src/plugins/presence-choreography.js`). Motion fusion for room occupancy (the old `MOTION_PRESENCE` occupancy half + the 20 s `MOTION_HOLD_S`) lives in the occupancy router graph, `projects/pain-material/manifest/graphs/occupancy.json` (the motion envelope's `releaseMs`). The old env vars are inert. |

## Architecture

```
[Python sidecar]  ── POST /ingest ──►  [Node SSE server]  ── /events ──►  Browser
                    JSON {name,value}                       SSE change frames
```

The Python sidecar reads sensors (per `hardware-handoff.md` in the repo
root) and POSTs each value change to `/ingest`. Node holds the latest
state per name and broadcasts changes to all connected SSE clients.

## Endpoints

### `GET /events` (SSE)

Server-Sent Events stream. On connect, snapshots the latest value of
every known input as a `change` event, then sends `event: ready` and
continues streaming `change` events as values update. 15 s keepalive
comments through any proxies.

Frame format:

```
event: change
data: {"name":"distance_cm","value":42.3,"ts":1747800000000}

```

### `POST /ingest` (localhost only)

Accepts publications from the Python sensor layer. Request body is
either a single object or an array:

```json
{"name": "distance_cm", "value": 42.3}
```

Restricted to loopback connections (`127.0.0.1` / `::1`). If
`INGEST_TOKEN` is set, the `X-Ingest-Token` header must match.

Response: `200 OK` with `{"accepted": <n>}`.

### `/api/presets/:type` (localhost only) — saved patch presets

Backs the **Save preset** button in the audio editors
(`static/audio/wavetable`, and the FM/bass editor when wired). The **only**
writable surface on the server; files only ever land under
`static/audio/presets/<type>/`. `:type` is one of `fm`, `bass`, `wt`.

| Method | Path | Body | Action |
|---|---|---|---|
| `GET` | `/api/presets/:type` | — | `{ "<name>": <patch>, … }` for the dropdown |
| `POST` | `/api/presets/:type` | `{"name","patch"}` | validate + write `<name>.json` |
| `DELETE` | `/api/presets/:type/:name` | — | remove one preset |

Hardening (the server binds `0.0.0.0` for the LAN visualizer, so writes are
gated hard):

- **Loopback only** — all three verbs reject non-`127.0.0.1`/`::1` callers
  (`403`), same as `/ingest`. Never writable from the LAN.
- **Fixed root + filename whitelist** — `:type` is whitelisted; the name must
  match `^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$` (no `.`, `/`, or traversal). The
  resolved path is re-checked to stay inside the type dir.
- **Body cap** — requests over 16 KB are dropped (`413`); a patch is ~1–2 KB.
- **Schema validation** — the JSON is checked against the real patch schema
  (`static/audio/shared/patch-schema.js`, imported server-side): every field
  present, correct type/range/enum, **no unknown keys** (`422` otherwise). Only
  the re-serialized validated object is written.
- **Atomic write** (tmp + rename), **refuses to write through a symlink**
  (`409`), and **caps files per type** at 200 (`507`) to bound disk use.

Saved presets are local user data — `static/audio/presets/.gitignore` keeps the
directory but ignores its contents.

## Wire vocabulary

Event names emitted by the Python drivers (and by `MOCK=1`) per
`hardware-handoff.md`:

| Name | Type | Source | Meaning |
|---|---|---|---|
| `motion` | boolean | AM312 ×2 (GPIO4 + GPIO23), OR'd | True while *either* PIR cone holds detection; suppressed for 60 s post-boot. Ignored unless `MOTION_PRESENCE` is on |
| `distance_cm` | number | VL53L1X (I²C 0x29) | Smoothed distance to closest target in cone; `null` ≈ no target |
| `breath_detected` | timestamp (ms) | HR202 + TLC555 (GPIO17) | Most-recent breath puff; bumps monotonically. Visualizer compares to `Date.now()` for recency. |
| `touch_mask` | int (0..4095) | MPR121 (I²C 0x5A, IRQ GPIO27) | 12-bit channel state; bit `n` set ⇒ channel `n` touched |

Adding new event names: just have the Python driver POST under a new
name. Nothing in the Node server needs to change. The browser-side
`window.AMBIENT_INPUTS` will pick it up automatically.

## Browser-side access

The visualizer's inline client (`static/index.html`) populates
`window.AMBIENT_INPUTS` as values arrive:

```js
const dist = window.AMBIENT_INPUTS.distance_cm ?? 200;
const isTouched = (window.AMBIENT_INPUTS.touch_mask ?? 0) !== 0;
const lastBreathAgoMs = Date.now() - (window.AMBIENT_INPUTS.breath_detected ?? 0);
```

`window.AMBIENT_INPUTS.__meta` exposes connection state (`connected`,
`lastEventAt`, `error`).
