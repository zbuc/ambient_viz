// Owns the Daisy's USB-CDC serial port, full-duplex (PLAN_USB_COMPOSITE).
// Since migration phase 6 this module is ONLY: the serial owner + the MIDI
// transport adapter + the POS reader. Everything that DECIDES lives
// elsewhere — the trigger stack (bell/toll/voice/murmur) is the
// presence_choreography.v1 plugin, occupancy conditioning is the occupancy
// router graph, and the tape-failure curve is the tape router graph. The
// in-process legacy versions were deleted at the phase-6 cutover (gate
// session 2026-06-12, accepted); rollback is artifact-level (redeploy the
// previous release — migration doctrine, invariant 4).
//
//  READ  (Phase D): the Daisy emits `POS <sec>\n` ~20x/s and `RESET <sec>\n`
//    once per loop wrap; we republish both as the `song_position` SSE topic so
//    the visualizer can sync its lanes (it rebases on every report, so the
//    backward jump a RESET produces hard-snaps — no separate signal needed).
//
//  WRITE (Phase E): we tunnel control to the Daisy as raw 3-byte MIDI frames
//    (the firmware frames + decodes them):
//      - CC 23 (tape failure) consumes the bus's arbitrated RESOLVED
//        `fx.tape.failure` — the tape router graph is the sole writer.
//      - CC 24 (freeze) from the browser's `freeze` 0..1 via /ingest.
//      - note-ons consume `seq.presence.note_on` events ([ch, note, vel]
//        verbatim from the presence plugin: ch0 bell, ch1 industrial,
//        ch2 speech-with-phrase-as-note).
//    CCs are on-change + rate-capped so the bulk-OUT pipe + param smoothers
//    don't flood; note-ons are events and write through.
//
// This is the SINGLE owner of the fd. Do NOT open a second writer elsewhere — a
// tty has one clean reader/writer; concurrent writers corrupt MIDI frames.

const { SerialPort, ReadlineParser } = require('serialport');
const capture = require('../capture'); // phase-0 boundary tap; no-op when off
const { attachResolvedBinding, attachEventBinding } = require('../cc-binding'); // 4D/6.1 transport-adapter consumers
const { createRateEstimator, NOMINAL_RATE } = require('../clock-rate'); // phase-7 clock tuple

// macOS has no stable device name (it's /dev/cu.usbmodemXXXX); the Pi is
// /dev/ttyACM0. Require an explicit DAISY_SERIAL on macOS.
const DEFAULT_PATH = process.platform === 'darwin' ? null : '/dev/ttyACM0';
const LINE_RE = /^(?:POS|RESET)\s+([0-9]+(?:\.[0-9]+)?)/;
const REOPEN_MS = 1000;

// CC map — must match dsp::install_kiosk_bindings on the firmware.
const CC_TAPE_FAILURE = 23;
const CC_FREEZE = 24;
const MIN_WRITE_MS = 33; // cap each CC to ~30 Hz (complication #13)

// Bus paths this adapter consumes.
const TAPE_PATH = 'fx.tape.failure';
const PRESENCE_PATH = 'seq.presence.note_on';

// ── the clock tuple (migration phase 7) ─────────────────────────────────────
// clock.daisy.position (the legacy-mapped POS float, via the bus adapter)
// plus clock.daisy.rate, published HERE under the daisy identity — together
// the (position, rate) tuple of the clock contract (ARCHITECTURE.md:
// extrapolate, don't sample). Consumers extrapolate pos₀ + rate·Δt between
// reports; a RESET wrap re-anchors position (backward jump = hard snap) and
// resets the rate to nominal. Rate is published on meaningful change only
// (the bus retains it; no keepalive — position staleness governs hold).
const RATE_PATH = 'clock.daisy.rate';
const RATE_EPS = 0.005; // publish when the estimate moves this much
const DAISY_SOURCE = 'spiffe://pain-material.local/daisy/serial';
const PRI_CLOCK = 400;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

let port = null;
let reopenTimer = null;
const lastCc = {}; // cc# -> last value sent (dedupe)
const lastWriteAt = {}; // cc# -> last write time (throttle)

let detachTapeBinding = null; // resolved-value binding teardown (stop())
let detachPresenceBinding = null; // note_on event-binding teardown (stop())
let orreryBusRef = null; // for the rate publish (set at module init)
let rateEstimator = createRateEstimator();
let lastPublishedRate = -Infinity; // forces the first publish (the nominal seed)

// Tapped serial write: the capture's serial_tx events ARE the Daisy output
// boundary, in write order, with the write callback surfacing flush/write
// errors (the 'error' event path only covers port-level failures).
function portWrite(buf, decoded) {
  capture.event('serial_tx', { hex: buf.toString('hex'), decoded });
  port.write(buf, (err) => {
    if (err) capture.event('serial_err', { op: 'write', hex: buf.toString('hex'), message: err.message });
  });
}

function writeCc(cc, value) {
  const v = clamp(Math.round(value), 0, 127);
  if (lastCc[cc] === v) return; // on-change only
  const now = Date.now();
  if (now - (lastWriteAt[cc] || 0) < MIN_WRITE_MS) return; // rate cap
  if (!port || !port.isOpen) return;
  portWrite(Buffer.from([0xb0, cc, v]), { type: 'cc', cc, value: v });
  lastCc[cc] = v;
  lastWriteAt[cc] = now;
}

function sendNoteOn(note, velocity, channel = 0) {
  if (!port || !port.isOpen) return;
  // note-on; velocity 0 would read as note-off, so floor at 1. The channel
  // selects the FM timbre on the firmware's shared bank (0 = bell, 1 = industrial).
  const n = clamp(Math.round(note), 0, 127);
  const v = clamp(Math.round(velocity), 1, 127);
  const ch = clamp(Math.round(channel), 0, 15);
  portWrite(Buffer.from([0x90 | ch, n, v]), { type: 'note_on', ch, note: n, vel: v });
}

function onChange(name, value) {
  if (name === 'freeze' && typeof value === 'number') {
    writeCc(CC_FREEZE, clamp(value, 0, 1) * 127);
  }
}

module.exports = ({ publish, bus, orreryBus }) => {
  const portPath = process.env.DAISY_SERIAL || DEFAULT_PATH;
  if (!portPath) {
    console.warn(
      'daisy-position: no port — set DAISY_SERIAL=/dev/cu.usbmodemXXXX (macOS has no fixed name)',
    );
    return;
  }

  if (orreryBus) {
    orreryBusRef = orreryBus;
    // Seed the rate at nominal so the tuple resolves from boot — a consumer
    // joining before the first POS extrapolates nothing (no anchor), but the
    // rate half of the contract is never absent.
    lastPublishedRate = NOMINAL_RATE;
    orreryBus.publishState(RATE_PATH, NOMINAL_RATE, { sourceId: DAISY_SOURCE, priority: PRI_CLOCK });
    detachTapeBinding = attachResolvedBinding({
      bus: orreryBus,
      path: TAPE_PATH,
      onResolved: (v) => writeCc(CC_TAPE_FAILURE, clamp(v, 0, 1) * 127),
    });
    detachPresenceBinding = attachEventBinding({
      bus: orreryBus,
      path: PRESENCE_PATH,
      onEvent: (payload) => {
        if (!Array.isArray(payload) || payload.length < 3) return; // malformed: never a frame
        sendNoteOn(payload[1], payload[2], payload[0]);
      },
    });
    console.log('daisy-position: CC 23 bound to bus-resolved fx.tape.failure; '
      + 'strikes/speech bound to seq.presence.note_on (the presence plugin)');
  } else {
    // The graphs/plugin are the only producers since the phase-6 cutover —
    // without the bus there is no tape CC and no bell/voice at all. Loud.
    console.warn('daisy-position: NO orrery bus wired — CC 23 (tape) and all strikes/speech are SILENT');
  }

  const scheduleReopen = () => {
    if (reopenTimer) return;
    if (port) {
      try { port.close(); } catch { /* already gone */ }
      port = null;
    }
    reopenTimer = setTimeout(() => { reopenTimer = null; open(); }, REOPEN_MS);
  };

  const open = () => {
    port = new SerialPort({ path: portPath, baudRate: 115200 }, (err) => {
      if (err) { capture.event('serial_err', { op: 'open', message: err.message }); scheduleReopen(); return; }
      // Assert DTR: the firmware only emits POS once the host opens the port
      // (its `wait_connection` waits on the DTR line state).
      try { port.set({ dtr: true, rts: true }, () => {}); } catch { /* */ }
      capture.event('serial_open', { path: portPath });
      console.log(`daisy-position: reading + writing ${portPath}`);
    });
    port.pipe(new ReadlineParser({ delimiter: '\n' })).on('data', (line) => {
      const trimmed = String(line).trim();
      const m = LINE_RE.exec(trimmed);
      // Raw line + decoded form, including lines the bridge ignores —
      // malformed input is counted and logged raw, not silently dropped.
      capture.event('serial_rx', {
        raw: trimmed,
        decoded: m
          ? { type: trimmed.startsWith('RESET') ? 'reset' : 'pos', sec: parseFloat(m[1]) }
          : { type: 'unmatched' },
      });
      if (m) {
        const sec = parseFloat(m[1]);
        publish('song_position', sec);
        if (orreryBusRef) {
          const { rate } = rateEstimator.onPosition(sec, Date.now());
          if (Math.abs(rate - lastPublishedRate) >= RATE_EPS) {
            lastPublishedRate = rate;
            orreryBusRef.publishState(RATE_PATH, rate, { sourceId: DAISY_SOURCE, priority: PRI_CLOCK });
          }
        }
      }
    });
    // Hot-plug resilience: reopen on any error/close (unplug, Daisy reboot).
    port.on('error', (err) => {
      capture.event('serial_err', { op: 'port', message: err && err.message ? err.message : String(err) });
      scheduleReopen();
    });
    port.on('close', () => {
      capture.event('serial_close', {});
      scheduleReopen();
    });
  };

  // The browser's freeze control still tunnels via the legacy input bus.
  if (bus) bus.on('change', (e) => onChange(e.name, e.value));

  open();
};

module.exports.stop = () => {
  if (reopenTimer) { clearTimeout(reopenTimer); reopenTimer = null; }
  if (detachTapeBinding) { detachTapeBinding(); detachTapeBinding = null; }
  if (detachPresenceBinding) { detachPresenceBinding(); detachPresenceBinding = null; }
  orreryBusRef = null;
  rateEstimator = createRateEstimator();
  lastPublishedRate = -Infinity;
  if (port) {
    try { port.close(); } catch { /* */ }
    port = null;
  }
};
