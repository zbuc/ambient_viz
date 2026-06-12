// Owns the Daisy's USB-CDC serial port, full-duplex (PLAN_USB_COMPOSITE):
//
//  READ  (Phase D): the Daisy emits `POS <sec>\n` ~20x/s and `RESET <sec>\n`
//    once per loop wrap; we republish both as the `song_position` SSE topic so
//    the visualizer can sync its lanes (it rebases on every report, so the
//    backward jump a RESET produces hard-snaps — no separate signal needed).
//
//  WRITE (Phase E): we tunnel control to the Daisy as raw 3-byte MIDI CC
//    frames `[0xB0, cc, value]` (the firmware frames + decodes them):
//      - CC 23 (tape failure) consumes the orrery bus's arbitrated RESOLVED
//        `fx.tape.failure`, computed by the router graph
//        (manifest/graphs/tape-failure.json — nearness, `invert: true`: near
//        = most destroyed, far = pristine). The in-process legacy ramp was
//        deleted in migration phase 4F; see the transport-adapter block below.
//      - `distance_near_cm` / `distance_far_cm` -> parameterize the presence
//        triggers below (and mirror the graph's Normalize endpoints); not
//        forwarded to the Daisy.
//      - `freeze` (0..1, posted by the browser to /ingest) -> CC 24.
//    On-change + rate-capped so the bulk-OUT pipe + param smoothers don't flood.
//
// This is the SINGLE owner of the fd. Do NOT open a second writer elsewhere — a
// tty has one clean reader/writer; concurrent writers corrupt MIDI frames.

const { SerialPort, ReadlineParser } = require('serialport');
const capture = require('../capture'); // phase-0 boundary tap; no-op when off
const { attachResolvedBinding, attachEventBinding } = require('../cc-binding'); // 4D/6.1 transport-adapter consumers

// macOS has no stable device name (it's /dev/cu.usbmodemXXXX); the Pi is
// /dev/ttyACM0. Require an explicit DAISY_SERIAL on macOS.
const DEFAULT_PATH = process.platform === 'darwin' ? null : '/dev/ttyACM0';
const LINE_RE = /^(?:POS|RESET)\s+([0-9]+(?:\.[0-9]+)?)/;
const REOPEN_MS = 1000;

// CC map — must match dsp::install_kiosk_bindings on the firmware.
const CC_TAPE_FAILURE = 23;
const CC_FREEZE = 24;
// Learned near/far endpoints (cm). The failure CURVE itself lives in the
// router graph since 4F (Normalize over the bus's conditioned endpoints,
// `invert: true` = the ce577ea reversal, now one declared artifact); these
// locals only parameterize the presence triggers below (bell/voice/toll
// thresholds key off farCm) and guard each other's claims — the same
// reject-not-clamp rules the bus adapter applies at ingest. Both track
// values published by the Python sidecar (`distance_near_cm` the config.py
// onset, `distance_far_cm` the sensor's mode-derived reach); defaults until
// the first claim arrives.
const NEAR_DEFAULT_CM = 75;
const FAR_DEFAULT_CM = 130;
let nearCm = NEAR_DEFAULT_CM;
let farCm = FAR_DEFAULT_CM;
const MIN_WRITE_MS = 33; // cap each CC to ~30 Hz (complication #13)

// ── MIDI transport adapter binding (migration phases 4D-4F) ─────────────────
// CC 23 is a resolved-value binding: every accepted fx.tape.failure packet
// hands the bus's ARBITRATED value to writeCc (the 0..127 quantize, on-change
// dedupe, and 33 ms cap stay HERE — adapter behavior, not graph nodes). The
// router graph is the SOLE writer since 4F deleted the legacy ramp and its
// tape_cc flag; rollback from here is artifact-level only (redeploy the
// previous release — migration doctrine, invariant 4).
const TAPE_PATH = 'fx.tape.failure';

// ── presence strike/speak source (migration phase 6.1) ──────────────────────
// migration_flag: presence_cc (legacy | bus) — owner phase-6.1, delete_by the
// 6.1 cleanup PR (with the whole trigger stack below).
//   legacy (default): the in-process bell/toll/voice/murmur stack drives
//     note-on serial writes, exactly as always. The presence_choreography.v1
//     plugin runs in pure shadow (its seq.presence.note_on is unconsumed).
//   bus: the plugin's seq.presence.note_on events drive the serial writes
//     (the cutover shape); the legacy stack KEEPS RUNNING and keeps recording
//     its decisions as `trigger` capture events — it just stops writing the
//     port, becoming the shadow the comparator judges against. Pre-delete
//     rollback = restart with PRESENCE_CC=legacy.
const PRESENCE_PATH = 'seq.presence.note_on';
const PRESENCE_SOURCE = /^bus$/i.test(process.env.PRESENCE_CC || '') ? 'bus' : 'legacy';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const envNum = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };
const envBool = (k, d) => { const v = process.env[k]; return v == null ? d : /^(1|true|yes|on)$/i.test(v.trim()); };

// --- AM312 motion presence (opt-in) -----------------------------------------
// FEATURE FLAG, default OFF. When off, room occupancy is derived purely from
// the ToF distance feed exactly as it always has been — the AM312s are ignored
// even if the Python sidecar is publishing `motion`. This is the deliberate,
// reliable fallback: if the AM312 wiring isn't done or doesn't work, leave this
// off and nothing changes.
//
// When ON, the OR'd AM312 `motion` channel AUGMENTS occupancy: a motion hit
// forces the room "occupied" and holds it for MOTION_HOLD_S after motion stops.
// Motion can only ADD presence, never remove it — so the distance logic still
// governs the "empty" baseline, and the AM312's blindness to a perfectly still
// person can never *falsely* empty a room the ToF still sees. The hold bridges
// both the AM312's ~2 s internal drop and its stillness-blindness (a visitor
// who stops moving keeps counting as present until the hold lapses). All three
// presence triggers key off this fused occupancy: the entry bell fires on the
// empty->occupied edge (motion onset, or a ToF approach), voice-on-leave on the
// confirmed empty edge, and the toll while occupied. With the flag OFF each
// reverts to its pure-distance path — the entry bell to its sustained-approach
// gate, voice/toll to distance hysteresis.
//
// Safety backstop: even with the flag ON, if no `motion` events ever arrive
// (AM312 dead / miswired), occupancy silently reverts to the distance path —
// the bell then fires on the distance occupancy edge rather than the richer
// sustained-approach gate, so prefer the flag OFF if the AM312s aren't trusted.
const MOTION_PRESENCE = envBool('MOTION_PRESENCE', false);
const MOTION_HOLD_S = Math.max(0, envNum('MOTION_HOLD_S', 20)); // hold occupied this long after last motion
const MOTION_HOLD_MS = MOTION_HOLD_S * 1000;

// --- Bell-on-entry ----------------------------------------------------------
// Ring the firmware's FM bell (a MIDI note-on; FmStab strikes it on top of the
// mix, just before the limiter) when someone arrives at the kiosk.
//
// Thresholds key off the learned far reach (distance_far_cm). The trigger is a
// small state machine that fires once per arrival:
//   - ARM once the nearest target has receded past the empty band for
//     BELL_REARM_RECEDE_S — LOCAL turnover ("whoever was here stepped back"),
//     not a whole-room empty. A single-point ToF in a continuously-occupied
//     room rarely reads empty for long, which starved the old empty-room arming.
//   - FIRE when an armed scene is penetrated by BELL_ENTER_FRACTION of its depth
//     AND the visitor moves inward (distance_velocity_cm_s, negative on
//     approach) for BELL_APPROACH_SUSTAIN consecutive samples. The depth gate
//     rejects edge-hoverers; the sustained-velocity gate rejects a furniture
//     shuffle, a drifting estimate, or a one-frame occlusion spike (e.g. a
//     second visitor cutting in front of the tracked one).
//   - DISARM after firing, and refuse any strike within BELL_COOLDOWN_S of the
//     last (a refractory cooldown shared with the toll below).
const BELL_NOTE = clamp(Math.round(envNum('BELL_NOTE', 81)), 0, 127); // A5 ~880 Hz
const BELL_VELOCITY = clamp(Math.round(envNum('BELL_VELOCITY', 100)), 1, 127);
// 1-in-N entries strike the harsher "industrial" FmStab patch instead of the
// bell. Same trigger + mix path; only the timbre differs, selected by MIDI
// channel (ch1 = industrial) so the firmware swaps the patch for that strike.
const BELL_INDUSTRIAL_PROB = clamp(envNum('BELL_INDUSTRIAL_PROB', 0.1), 0, 1);
const BELL_INDUSTRIAL_NOTE = clamp(Math.round(envNum('BELL_INDUSTRIAL_NOTE', BELL_NOTE)), 0, 127);
const BELL_ENTER_FRACTION = envNum('BELL_ENTER_FRACTION', 0.15); // come in 15% of the depth
const BELL_EMPTY_FRACTION = envNum('BELL_EMPTY_FRACTION', 0.08); // within 8% of far = "empty"
const BELL_REARM_RECEDE_S = envNum('BELL_REARM_RECEDE_S', 2.5); // nearest target receded past empty this long -> re-arm
const BELL_COOLDOWN_S = envNum('BELL_COOLDOWN_S', 30); // min gap between ANY two strikes (entry or toll)
const BELL_APPROACH_CM_S = envNum('BELL_APPROACH_CM_S', 2.0); // min inward speed to count as entering
const BELL_APPROACH_SUSTAIN = Math.max(1, Math.round(envNum('BELL_APPROACH_SUSTAIN', 3))); // consecutive inward samples to fire
const BELL_TICK_MS = 500; // re-evaluate arming + toll even when distance_cm is static

// --- Periodic toll ----------------------------------------------------------
// A room that stays occupied gives the entry bell no fresh "empty -> approach"
// edge, so it would fall silent for the whole visit. Instead, while occupied,
// strike a toll at a random interval in [TOLL_MIN_S, TOLL_MAX_S] and sometimes
// skip one entirely (TOLL_SKIP_PROB) — a slow, irregular recurrence, not a
// metronome. Shares the bell's strike path + cooldown; the clock resets after
// any strike so a toll never treads on a fresh entry bell.
const TOLL_MIN_S = Math.max(0, envNum('TOLL_MIN_S', 120)); // shortest gap between tolls
const TOLL_MAX_S = Math.max(TOLL_MIN_S, envNum('TOLL_MAX_S', 180)); // longest gap
const TOLL_SKIP_PROB = clamp(envNum('TOLL_SKIP_PROB', 0.25), 0, 1); // chance a due toll is skipped

// --- Voice-on-leave ---------------------------------------------------------
// Speak "pain material" (the firmware's formant speech voice + reverb, struck
// by a ch2 MIDI note-on) once when the room returns to empty after a genuine
// visit. Mirrors the bell's dwell mechanics so a rapid in-and-out doesn't fire:
//   - count someone as PRESENT (hysteretic) using the same near/far thresholds
//     as the bell; only a stay of VOICE_PRESENCE_MIN_S arms a pending leave —
//     darting through the cone never arms it.
//   - SPEAK when the armed-pending room has then read empty continuously for
//     VOICE_CONFIRM_EMPTY_S (a quick re-entry inside that window resets it, so
//     boundary flicker / pacing in and out won't trigger).
//   - one utterance per visit: speaking clears the pending flag until the room
//     is genuinely re-occupied.
// The voice knows several phrases; we pick one at random and send its index as
// the ch2 note number (pitch is internal to the speech synth, so the note is
// free to carry the phrase). Must match dsp::pain_voice::PHRASE_COUNT/_LABELS;
// firmware wraps an out-of-range index, so drift only mis-labels logs.
const VOICE_VELOCITY = clamp(Math.round(envNum('VOICE_VELOCITY', 100)), 1, 127);
const VOICE_PRESENCE_MIN_S = envNum('VOICE_PRESENCE_MIN_S', 3.0); // min dwell to count as a visit
const VOICE_CONFIRM_EMPTY_S = envNum('VOICE_CONFIRM_EMPTY_S', 2.0); // empty this long after leaving to speak
// Order MUST match dsp::pain_voice::PHRASE_LABELS — the index is the ch2 note.
const VOICE_PHRASES = [
  'pain material',
  'you are alone',
  'i see you',
  'you do not belong here',
  'ha ha ha ha ha',
  'eins zwei drei vier',
  "don't come back",
  'you are not welcome',
  'you are not happy',
  'you can not feel joy',
  'you are fake',
  'everybody sees through you',
  'you are weak',
  'time space transmat',
  'avoid eye contact',
];

// --- Periodic voice ("active room") -----------------------------------------
// While the room is occupied AND there's RECENT MOTION (an active room, not a
// still one), murmur a random phrase at a slow random interval, skipping some —
// the "I'm watching the crowd" surveillance layer, distinct from the once-per-
// visit exit voice. Once the interval elapses it holds "due" and waits for the
// next motion, so it speaks *at* activity rather than into a lull. Shares the
// speech path + a min-gap with the exit voice so two utterances never stack.
// Self-disabling: with no AM312 motion (sensor absent/quiet) it never fires.
const VOICE_TOLL = envBool('VOICE_TOLL', true); // master switch
const VOICE_TOLL_MIN_S = Math.max(0, envNum('VOICE_TOLL_MIN_S', 300)); // shortest gap (5 min)
const VOICE_TOLL_MAX_S = Math.max(VOICE_TOLL_MIN_S, envNum('VOICE_TOLL_MAX_S', 600)); // longest (10 min)
const VOICE_TOLL_SKIP_PROB = clamp(envNum('VOICE_TOLL_SKIP_PROB', 0.25), 0, 1); // chance a due murmur is skipped
const VOICE_TOLL_ACTIVE_S = Math.max(0, envNum('VOICE_TOLL_ACTIVE_S', 30)); // "recent motion" window to count as active
const VOICE_MIN_GAP_S = Math.max(0, envNum('VOICE_MIN_GAP_S', 20)); // min gap between ANY two spoken phrases (murmur or exit)

let port = null;
let reopenTimer = null;
let triggerTimer = null;
const lastCc = {}; // cc# -> last value sent (dedupe)
const lastWriteAt = {}; // cc# -> last write time (throttle)

let detachTapeBinding = null; // resolved-value binding teardown (stop())
let detachPresenceBinding = null; // 6.1 note_on event-binding teardown (stop())

// Bell-on-entry state.
let lastDistanceCm = null; // most recent distance_cm
let lastVelocityCmS = 0; // most recent distance_velocity_cm_s (approach negative)
let bellArmed = false; // ready to ring on the next entry
let emptySinceMs = null; // when the nearest target first receded past the empty band
let approachFrames = 0; // consecutive fresh samples satisfying the inward-approach gate
let lastBellMs = 0; // last strike (entry OR toll) — drives the shared refractory cooldown
let nextTollMs = null; // scheduled time of the next occupied-room toll (null when empty)

// Voice-on-leave state.
let roomOccupied = false; // hysteretic occupancy (near -> true, far -> false)
let occupiedSinceMs = null; // when the current occupancy began
let voicePending = false; // a genuine visit happened, awaiting a confirmed leave
let voiceEmptySinceMs = null; // when the room first read empty after that visit

// Periodic "active room" voice state + the shared utterance timestamp.
let nextMurmurMs = null; // scheduled next murmur (null when room empty/disabled)
let lastVoiceMs = -Infinity; // last spoken phrase (murmur OR exit) — shared min-gap

// AM312 motion-presence state (only consulted when MOTION_PRESENCE is on).
let motionActive = false; // latest OR'd AM312 state (true = a cone sees motion)
let lastMotionMs = -Infinity; // when motion last fell low; -inf = never seen

// Whether the AM312 array counts the room as occupied right now: motion is held
// high, OR motion fell low within the hold window. Always false when the flag
// is off, so callers collapse to the pure-distance path.
function motionPresent(nowMs) {
  if (!MOTION_PRESENCE) return false;
  return motionActive || (nowMs - lastMotionMs) <= MOTION_HOLD_MS;
}

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

// The raw note-on frame writer — the one path to the wire, used by whichever
// side the presence_cc flag selects.
function sendNoteOn(note, velocity, channel = 0) {
  if (!port || !port.isOpen) return;
  // note-on; velocity 0 would read as note-off, so floor at 1. The channel
  // selects the FM timbre on the firmware's shared bank (0 = bell, 1 = industrial).
  const n = clamp(Math.round(note), 0, 127);
  const v = clamp(Math.round(velocity), 1, 127);
  const ch = clamp(Math.round(channel), 0, 15);
  portWrite(Buffer.from([0x90 | ch, n, v]), { type: 'note_on', ch, note: n, vel: v });
}

// The LEGACY trigger stack's writer: under presence_cc=bus its strikes stop
// reaching the wire (the plugin drives it via the event binding below) while
// the stack keeps deciding + capturing `trigger` events — the shadow side of
// the 6.1 live comparison.
function writeNoteOn(note, velocity, channel = 0) {
  if (PRESENCE_SOURCE !== 'legacy') return;
  sendNoteOn(note, velocity, channel);
}

// Roll the next toll to a random point in [TOLL_MIN_S, TOLL_MAX_S].
function scheduleNextToll(nowMs) {
  nextTollMs = nowMs + (TOLL_MIN_S + Math.random() * (TOLL_MAX_S - TOLL_MIN_S)) * 1000;
}

// One bell/industrial strike, shared by the entry trigger and the toll. Picks
// the timbre, stamps the shared cooldown, and (while occupied) re-rolls the
// toll so it never lands right on top of a just-rung strike.
function strikeBell(nowMs, reason) {
  const industrial = Math.random() < BELL_INDUSTRIAL_PROB;
  if (industrial) writeNoteOn(BELL_INDUSTRIAL_NOTE, BELL_VELOCITY, 1);
  else writeNoteOn(BELL_NOTE, BELL_VELOCITY, 0);
  lastBellMs = nowMs;
  if (roomOccupied) scheduleNextToll(nowMs);
  // The reason rides along so replay can tell deterministic strikes (entry)
  // from the Math.random-scheduled ones (toll) when comparing.
  capture.event('trigger', { what: industrial ? 'industrial' : 'bell', reason });
  console.log(`daisy-position: ${industrial ? 'industrial' : 'bell'} (${reason})`);
}

// Motion-mode entry bell (MOTION_PRESENCE on). With the AM312s covering the
// room, "someone arrived" is simply the occupancy rising edge — fire once when
// the room flips empty->occupied. Reuses the same arm/cooldown machinery as the
// distance path: the room must first read empty for BELL_REARM_RECEDE_S (so a
// person already present at boot doesn't ring), then the next time occupancy
// goes true (motion onset, or the ToF crossing the enter band) strikes the bell.
// roomOccupied is computed by computeOccupancy() before this runs.
function updateBellTriggerMotion(nowMs) {
  if (!roomOccupied) {
    // Room empty — arm after a short hold so we ring on the NEXT arrival.
    if (emptySinceMs === null) emptySinceMs = nowMs;
    if (!bellArmed && nowMs - emptySinceMs >= BELL_REARM_RECEDE_S * 1000) bellArmed = true;
    return;
  }
  // Room occupied — the empty run is broken.
  emptySinceMs = null;
  if (bellArmed && nowMs - lastBellMs >= BELL_COOLDOWN_S * 1000) {
    strikeBell(nowMs, motionActive ? 'entry (motion)' : 'entry (motion-mode, ToF)');
    bellArmed = false; // locked until the room empties again + the cooldown
  }
}

// Edge-detect "someone arrived at the kiosk" and ring the bell once. Called on
// distance_cm updates (the snappy path, `fresh` true) and on a slow timer
// (`fresh` false), so arming still progresses when a still scene stops emitting
// distance_cm changes. The sustained-approach counter only advances on fresh
// samples — the tick carries no new reading.
function updateBellTrigger(nowMs, fresh) {
  // Motion mode: occupancy-edge bell (above). Off mode falls through to the
  // distance approach logic below — the reliable, unchanged fallback.
  if (MOTION_PRESENCE) { updateBellTriggerMotion(nowMs); return; }
  if (lastDistanceCm === null || !(farCm > 0)) return;
  const enterThresh = farCm * (1 - BELL_ENTER_FRACTION); // cross BELOW to trigger
  const emptyThresh = farCm * (1 - BELL_EMPTY_FRACTION); // recede ABOVE to re-arm

  if (lastDistanceCm >= emptyThresh) {
    // Nearest target has receded past the empty band — local turnover. Arm after
    // a short hold so a brief step-back re-arms without needing a full room clear.
    if (emptySinceMs === null) emptySinceMs = nowMs;
    if (!bellArmed && nowMs - emptySinceMs >= BELL_REARM_RECEDE_S * 1000) bellArmed = true;
    approachFrames = 0;
    return;
  }

  // Someone/something is nearer than the empty band — the recede run is broken.
  emptySinceMs = null;

  // Count sustained inward approach on fresh samples only, so a single-frame
  // occlusion spike (a second visitor cutting in front) can't reach the gate.
  if (fresh) {
    const inwardSpeed = -lastVelocityCmS; // approach is negative
    if (lastDistanceCm <= enterThresh && inwardSpeed >= BELL_APPROACH_CM_S) approachFrames += 1;
    else approachFrames = 0;
  }

  // Fire once: armed, sustained approach, and clear of the shared cooldown.
  if (bellArmed && approachFrames >= BELL_APPROACH_SUSTAIN
      && nowMs - lastBellMs >= BELL_COOLDOWN_S * 1000) {
    strikeBell(
      nowMs,
      `entry at ${lastDistanceCm.toFixed(0)}cm, ${(-lastVelocityCmS).toFixed(1)}cm/s in, far=${farCm.toFixed(0)}cm`,
    );
    bellArmed = false; // locked until the nearest target recedes again + the cooldown
    approachFrames = 0;
  }
}

// Single owner of `roomOccupied`, evaluated before every trigger so the bell,
// voice, and toll all read one consistent occupancy. Distance hysteresis is the
// always-on baseline; motion (opt-in) augments it.
function computeOccupancy(nowMs) {
  // Hysteretic occupancy from distance: flip on a clear near/far reading, hold
  // in the band so someone walking out doesn't chatter between states.
  if (lastDistanceCm !== null && farCm > 0) {
    const enterThresh = farCm * (1 - BELL_ENTER_FRACTION); // near -> occupied
    const emptyThresh = farCm * (1 - BELL_EMPTY_FRACTION); // far -> empty
    if (lastDistanceCm <= enterThresh) roomOccupied = true;
    else if (lastDistanceCm >= emptyThresh) roomOccupied = false;
  }

  // Motion fusion (opt-in): an AM312 hit forces occupancy and suppresses the
  // empty transition. Augment-only — motion never *clears* occupancy, so the
  // distance path above remains the sole owner of "empty." No-ops when the flag
  // is off (motionPresent() is always false), preserving the distance fallback.
  if (motionPresent(nowMs)) roomOccupied = true;
}

// Roll the next murmur to a random point in [VOICE_TOLL_MIN_S, VOICE_TOLL_MAX_S].
function scheduleNextMurmur(nowMs) {
  nextMurmurMs = nowMs + (VOICE_TOLL_MIN_S + Math.random() * (VOICE_TOLL_MAX_S - VOICE_TOLL_MIN_S)) * 1000;
}

// One spoken phrase (ch2 note-on; the note IS the phrase index). Shared by the
// exit voice and the periodic murmur; stamps the shared min-gap timestamp.
function speakPhrase(nowMs, reason) {
  const phrase = Math.floor(Math.random() * VOICE_PHRASES.length);
  writeNoteOn(phrase, VOICE_VELOCITY, 2); // ch2 = speech voice; note = phrase index
  lastVoiceMs = nowMs;
  capture.event('trigger', { what: 'voice', reason, phrase: VOICE_PHRASES[phrase] });
  console.log(`daisy-position: voice "${VOICE_PHRASES[phrase]}" (${reason})`);
}

// Edge-detect "the room emptied after a real visit" and speak "pain material"
// once. Reads the occupancy that computeOccupancy() has already set.
function updateVoiceTrigger(nowMs) {
  if (roomOccupied) {
    if (occupiedSinceMs === null) occupiedSinceMs = nowMs;
    voiceEmptySinceMs = null;
    // Only a dwelt-in presence arms the leave; darting through never does.
    if (nowMs - occupiedSinceMs >= VOICE_PRESENCE_MIN_S * 1000) voicePending = true;
    return;
  }

  // Room reads empty.
  occupiedSinceMs = null;
  if (!voicePending) return;
  if (voiceEmptySinceMs === null) voiceEmptySinceMs = nowMs;
  if (nowMs - voiceEmptySinceMs >= VOICE_CONFIRM_EMPTY_S * 1000) {
    speakPhrase(nowMs, `room emptied, far=${farCm.toFixed(0)}cm`);
    voicePending = false;
    voiceEmptySinceMs = null;
  }
}

// While the room is occupied, murmur a random phrase every VOICE_TOLL_MIN..MAX
// seconds — but ONLY when there's recent motion (an active room, not a still
// one), skipping ~VOICE_TOLL_SKIP_PROB of them. Once the interval elapses it
// holds "due" and waits for the next motion, so it speaks at activity, not into
// a lull. Shares the speech min-gap so it can't stack on the exit voice.
function updateVoiceMurmur(nowMs) {
  if (!VOICE_TOLL) return;
  if (!roomOccupied) { nextMurmurMs = null; return; } // reset; re-rolls on re-entry
  if (nextMurmurMs === null) { scheduleNextMurmur(nowMs); return; }
  if (nowMs < nextMurmurMs) return; // interval not up yet
  // Due — only speak to an ACTIVE room (motion now, or within the recent window).
  const active = motionActive || (nowMs - lastMotionMs) <= VOICE_TOLL_ACTIVE_S * 1000;
  if (!active) return; // stay due; fire at the next motion
  if (nowMs - lastVoiceMs < VOICE_MIN_GAP_S * 1000) return; // don't stack on a recent utterance
  if (Math.random() < VOICE_TOLL_SKIP_PROB) {
    scheduleNextMurmur(nowMs);
    capture.event('trigger', { what: 'murmur_skip' });
    console.log('daisy-position: voice murmur skipped');
    return;
  }
  speakPhrase(nowMs, 'active room');
  scheduleNextMurmur(nowMs);
}

// While the room stays occupied, strike a toll at a random interval, sometimes
// skipping one — the entry bell can't fire without a fresh empty->approach edge,
// so this keeps the bell present through a long visit.
function updateToll(nowMs) {
  if (!roomOccupied) { nextTollMs = null; return; } // clears so re-entry re-rolls
  if (nextTollMs === null) { scheduleNextToll(nowMs); return; }
  if (nowMs < nextTollMs) return;
  if (nowMs - lastBellMs < BELL_COOLDOWN_S * 1000) { scheduleNextToll(nowMs); return; }
  if (Math.random() < TOLL_SKIP_PROB) {
    scheduleNextToll(nowMs);
    capture.event('trigger', { what: 'toll_skip' });
    console.log('daisy-position: toll skipped');
    return;
  }
  strikeBell(nowMs, `toll, far=${farCm.toFixed(0)}cm`); // re-rolls nextTollMs
}

// All presence triggers, evaluated together. `fresh` marks a real distance_cm
// sample (vs the slow tick); it gates the sustained-approach counter (distance
// bell only). computeOccupancy runs first so the bell, voice, and toll all read
// one consistent roomOccupied for this evaluation.
let lastCapturedOccupancy = null; // phase-6.1 shadow comparison tap state
function updateTriggers(nowMs, fresh) {
  computeOccupancy(nowMs);
  // Phase-6.1 occupancy shadow tap (read-only): record every legacy occupancy
  // EDGE so a captured session carries the authoritative trajectory the
  // shadow graph (derived.room.occupied, in bus_tx) is judged against —
  // tools/sim/validate-occupancy.js correlates the two lanes. Dies when
  // legacy rebinds to the graph (the 6.1 cutover for this signal).
  if (roomOccupied !== lastCapturedOccupancy) {
    lastCapturedOccupancy = roomOccupied;
    capture.event('legacy_occupancy', { occupied: roomOccupied });
  }
  updateBellTrigger(nowMs, fresh);
  updateVoiceTrigger(nowMs);
  updateToll(nowMs);
  updateVoiceMurmur(nowMs);
}

function onChange(name, value) {
  // `motion` arrives as a bool (AM312 OR'd state) — handle it before the numeric
  // guard below. Stamp lastMotionMs on every edge so the hold window measures
  // from the moment motion *fell* low; while held high, motionActive covers it.
  if (name === 'motion') {
    motionActive = value === true || value === 1;
    lastMotionMs = Date.now();
    // Re-evaluate occupancy promptly so a motion hit can arm/extend a visit
    // without waiting on the next distance sample or the slow tick.
    updateTriggers(Date.now(), false);
    return;
  }
  if (typeof value !== 'number') return;
  if (name === 'distance_near_cm') {
    // Effect onset, shared with the visualizer; keep it below the far reach.
    if (value >= 0 && value < farCm) nearCm = value;
  } else if (name === 'distance_far_cm') {
    // Sensor's mode-derived reach; the far end of the failure ramp tracks it.
    if (value > nearCm) farCm = value;
  } else if (name === 'distance_cm') {
    // CC 23 no longer originates here — the router graph computes the failure
    // curve from the bus's distance signal and the binding below writes it.
    lastDistanceCm = value;
    updateTriggers(Date.now(), true);
  } else if (name === 'distance_velocity_cm_s') {
    lastVelocityCmS = value;
  } else if (name === 'freeze') {
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
    detachTapeBinding = attachResolvedBinding({
      bus: orreryBus,
      path: TAPE_PATH,
      onResolved: (v) => writeCc(CC_TAPE_FAILURE, clamp(v, 0, 1) * 127),
    });
    console.log('daisy-position: CC 23 bound to bus-resolved fx.tape.failure (router graph is the sole writer)');
    if (PRESENCE_SOURCE === 'bus') {
      // The 6.1 cutover shape: the plugin's [ch, note, vel] events drive the
      // wire; legacy keeps deciding silently (writeNoteOn gates on the flag).
      detachPresenceBinding = attachEventBinding({
        bus: orreryBus,
        path: PRESENCE_PATH,
        onEvent: (payload) => {
          if (!Array.isArray(payload) || payload.length < 3) return; // malformed: never a frame
          sendNoteOn(payload[1], payload[2], payload[0]);
        },
      });
      console.log('daisy-position: strikes/speech bound to seq.presence.note_on (presence_cc=bus — legacy stack is the SHADOW)');
    } else {
      console.log('daisy-position: strikes/speech from the legacy trigger stack (presence_cc=legacy — plugin shadows on the bus)');
    }
  } else {
    // The graph is the only producer since 4F — without the bus there is no
    // tape-failure CC at all. Loud, because the deck would sit pristine.
    console.warn('daisy-position: NO orrery bus wired — CC 23 (tape failure) will never move');
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
      if (m) publish('song_position', parseFloat(m[1]));
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

  // Tunnel distance_cm / freeze back to the Daisy as CC; ring the bell on entry
  // and speak on leave.
  if (bus) bus.on('change', (e) => onChange(e.name, e.value));

  console.log(
    MOTION_PRESENCE
      ? `daisy-position: AM312 motion presence ON (hold ${MOTION_HOLD_S}s; augments distance occupancy)`
      : 'daisy-position: AM312 motion presence OFF (occupancy is distance-only)',
  );
  console.log(
    VOICE_TOLL
      ? `daisy-position: periodic voice ON (every ${VOICE_TOLL_MIN_S}-${VOICE_TOLL_MAX_S}s when active, skip ${Math.round(VOICE_TOLL_SKIP_PROB * 100)}%)`
      : 'daisy-position: periodic voice OFF',
  );

  // Keep the entry re-arm + leave-confirm + toll timers advancing even while a
  // dead-still room emits no distance_cm changes (it's deduped on-change). The
  // tick is not a fresh sample, so it never advances the sustained-approach gate.
  triggerTimer = setInterval(() => updateTriggers(Date.now(), false), BELL_TICK_MS);
  if (typeof triggerTimer.unref === 'function') triggerTimer.unref();

  open();
};

module.exports.stop = () => {
  if (reopenTimer) { clearTimeout(reopenTimer); reopenTimer = null; }
  if (triggerTimer) { clearInterval(triggerTimer); triggerTimer = null; }
  if (detachTapeBinding) { detachTapeBinding(); detachTapeBinding = null; }
  if (detachPresenceBinding) { detachPresenceBinding(); detachPresenceBinding = null; }
  if (port) {
    try { port.close(); } catch { /* */ }
    port = null;
  }
};
