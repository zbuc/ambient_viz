// Frozen-spec model of the daisy-position trigger stack (phase 6.1 step two).
//
// An INDEPENDENT port of server/src/inputs/daisy-position.js's
// bell/toll/voice/murmur logic — written from the legacy source, not from the
// plugin — so validate-presence.js can compare two implementations of one
// spec, seeded identically, and catch porting slips in either. Structure
// mirrors the legacy file (module-style state, same function names, same
// guard order, same RNG call sites); inputs/outputs are injected:
//
//   model.onState(name, value, nowMs)  — occupied / distance_cm /
//       velocity_cm_s / far_cm / motion (the plugin's port names)
//   model.tick(nowMs)                  — the trigger timer
//   opts.rand                          — the seeded PRNG (replaces Math.random)
//   opts.emit({t, ch, note, vel, what, reason})  — replaces writeNoteOn
//
// Like the plugin (and per the 6.1 occupancy cutover), `occupied` is an
// INPUT — computeOccupancy stayed in the router graph. Eval sites are
// legacy's exactly: distance (fresh), motion, tick.

'use strict';

function createPresenceModel(opts = {}) {
  const rand = opts.rand;
  const emit = opts.emit;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  // Knobs — daisy-position env defaults, verbatim.
  const MOTION_PRESENCE = opts.motionPresence !== undefined ? opts.motionPresence : true;
  const BELL_NOTE = clamp(Math.round(opts.bellNote ?? 81), 0, 127);
  const BELL_VELOCITY = clamp(Math.round(opts.bellVelocity ?? 100), 1, 127);
  const BELL_INDUSTRIAL_PROB = clamp(opts.industrialProb ?? 0.1, 0, 1);
  const BELL_INDUSTRIAL_NOTE = clamp(Math.round(opts.industrialNote ?? BELL_NOTE), 0, 127);
  const BELL_ENTER_FRACTION = opts.enterFraction ?? 0.15;
  const BELL_EMPTY_FRACTION = opts.emptyFraction ?? 0.08;
  const BELL_REARM_RECEDE_S = opts.rearmRecedeS ?? 2.5;
  const BELL_COOLDOWN_S = opts.cooldownS ?? 30;
  const BELL_APPROACH_CM_S = opts.approachCmS ?? 2.0;
  const BELL_APPROACH_SUSTAIN = Math.max(1, Math.round(opts.approachSustain ?? 3));
  const TOLL_MIN_S = Math.max(0, opts.tollMinS ?? 120);
  const TOLL_MAX_S = Math.max(TOLL_MIN_S, opts.tollMaxS ?? 180);
  const TOLL_SKIP_PROB = clamp(opts.tollSkipProb ?? 0.25, 0, 1);
  const VOICE_VELOCITY = clamp(Math.round(opts.voiceVelocity ?? 100), 1, 127);
  const VOICE_PRESENCE_MIN_S = opts.voicePresenceMinS ?? 3.0;
  const VOICE_CONFIRM_EMPTY_S = opts.voiceConfirmEmptyS ?? 2.0;
  const VOICE_TOLL = opts.voiceToll !== undefined ? opts.voiceToll : true;
  const VOICE_TOLL_MIN_S = Math.max(0, opts.voiceTollMinS ?? 300);
  const VOICE_TOLL_MAX_S = Math.max(VOICE_TOLL_MIN_S, opts.voiceTollMaxS ?? 600);
  const VOICE_TOLL_SKIP_PROB = clamp(opts.voiceTollSkipProb ?? 0.25, 0, 1);
  const VOICE_TOLL_ACTIVE_S = Math.max(0, opts.voiceTollActiveS ?? 30);
  const VOICE_MIN_GAP_S = Math.max(0, opts.voiceMinGapS ?? 20);
  const PHRASE_COUNT = Math.round(opts.phraseCount ?? 15);

  // Legacy module globals.
  let roomOccupied = false;
  let lastDistanceCm = null;
  let lastVelocityCmS = 0;
  let farCm = null;
  let motionActive = false;
  let lastMotionMs = -Infinity;
  let bellArmed = false;
  let emptySinceMs = null;
  let approachFrames = 0;
  let lastBellMs = -Infinity; // "never struck" — see the plugin's port note
  let nextTollMs = null;
  let occupiedSinceMs = null;
  let voicePending = false;
  let voiceEmptySinceMs = null;
  let nextMurmurMs = null;
  let lastVoiceMs = -Infinity;

  function scheduleNextToll(nowMs) {
    nextTollMs = nowMs + (TOLL_MIN_S + rand() * (TOLL_MAX_S - TOLL_MIN_S)) * 1000;
  }

  function strikeBell(nowMs, reason) {
    const industrial = rand() < BELL_INDUSTRIAL_PROB;
    emit({
      t: nowMs,
      ch: industrial ? 1 : 0,
      note: industrial ? BELL_INDUSTRIAL_NOTE : BELL_NOTE,
      vel: BELL_VELOCITY,
      what: industrial ? 'industrial' : 'bell',
      reason,
    });
    lastBellMs = nowMs;
    if (roomOccupied) scheduleNextToll(nowMs);
  }

  function scheduleNextMurmur(nowMs) {
    nextMurmurMs = nowMs + (VOICE_TOLL_MIN_S + rand() * (VOICE_TOLL_MAX_S - VOICE_TOLL_MIN_S)) * 1000;
  }

  function speakPhrase(nowMs, reason) {
    const phrase = Math.floor(rand() * PHRASE_COUNT);
    emit({ t: nowMs, ch: 2, note: phrase, vel: VOICE_VELOCITY, what: 'voice', reason, phrase });
    lastVoiceMs = nowMs;
  }

  function updateBellTriggerMotion(nowMs) {
    if (!roomOccupied) {
      if (emptySinceMs === null) emptySinceMs = nowMs;
      if (!bellArmed && nowMs - emptySinceMs >= BELL_REARM_RECEDE_S * 1000) bellArmed = true;
      return;
    }
    emptySinceMs = null;
    if (bellArmed && nowMs - lastBellMs >= BELL_COOLDOWN_S * 1000) {
      strikeBell(nowMs, motionActive ? 'entry (motion)' : 'entry (motion-mode, ToF)');
      bellArmed = false;
    }
  }

  function updateBellTrigger(nowMs, fresh) {
    if (MOTION_PRESENCE) { updateBellTriggerMotion(nowMs); return; }
    if (lastDistanceCm === null || !(farCm > 0)) return;
    const enterThresh = farCm * (1 - BELL_ENTER_FRACTION);
    const emptyThresh = farCm * (1 - BELL_EMPTY_FRACTION);

    if (lastDistanceCm >= emptyThresh) {
      if (emptySinceMs === null) emptySinceMs = nowMs;
      if (!bellArmed && nowMs - emptySinceMs >= BELL_REARM_RECEDE_S * 1000) bellArmed = true;
      approachFrames = 0;
      return;
    }
    emptySinceMs = null;
    if (fresh) {
      const inwardSpeed = -lastVelocityCmS;
      if (lastDistanceCm <= enterThresh && inwardSpeed >= BELL_APPROACH_CM_S) approachFrames += 1;
      else approachFrames = 0;
    }
    if (bellArmed && approachFrames >= BELL_APPROACH_SUSTAIN
        && nowMs - lastBellMs >= BELL_COOLDOWN_S * 1000) {
      strikeBell(nowMs, `entry at ${lastDistanceCm.toFixed(0)}cm, ${(-lastVelocityCmS).toFixed(1)}cm/s in, far=${farCm.toFixed(0)}cm`);
      bellArmed = false;
      approachFrames = 0;
    }
  }

  function updateVoiceTrigger(nowMs) {
    if (roomOccupied) {
      if (occupiedSinceMs === null) occupiedSinceMs = nowMs;
      voiceEmptySinceMs = null;
      if (nowMs - occupiedSinceMs >= VOICE_PRESENCE_MIN_S * 1000) voicePending = true;
      return;
    }
    occupiedSinceMs = null;
    if (!voicePending) return;
    if (voiceEmptySinceMs === null) voiceEmptySinceMs = nowMs;
    if (nowMs - voiceEmptySinceMs >= VOICE_CONFIRM_EMPTY_S * 1000) {
      speakPhrase(nowMs, `room emptied, far=${farCm === null ? '?' : farCm.toFixed(0)}cm`);
      voicePending = false;
      voiceEmptySinceMs = null;
    }
  }

  function updateToll(nowMs) {
    if (!roomOccupied) { nextTollMs = null; return; }
    if (nextTollMs === null) { scheduleNextToll(nowMs); return; }
    if (nowMs < nextTollMs) return;
    if (nowMs - lastBellMs < BELL_COOLDOWN_S * 1000) { scheduleNextToll(nowMs); return; }
    if (rand() < TOLL_SKIP_PROB) {
      scheduleNextToll(nowMs);
      return;
    }
    strikeBell(nowMs, `toll, far=${farCm === null ? '?' : farCm.toFixed(0)}cm`);
  }

  function updateVoiceMurmur(nowMs) {
    if (!VOICE_TOLL) return;
    if (!roomOccupied) { nextMurmurMs = null; return; }
    if (nextMurmurMs === null) { scheduleNextMurmur(nowMs); return; }
    if (nowMs < nextMurmurMs) return;
    const active = motionActive || nowMs - lastMotionMs <= VOICE_TOLL_ACTIVE_S * 1000;
    if (!active) return;
    if (nowMs - lastVoiceMs < VOICE_MIN_GAP_S * 1000) return;
    if (rand() < VOICE_TOLL_SKIP_PROB) {
      scheduleNextMurmur(nowMs);
      return;
    }
    speakPhrase(nowMs, 'active room');
    scheduleNextMurmur(nowMs);
  }

  function updateTriggers(nowMs, fresh) {
    updateBellTrigger(nowMs, fresh);
    updateVoiceTrigger(nowMs);
    updateToll(nowMs);
    updateVoiceMurmur(nowMs);
  }

  return {
    onState(name, value, nowMs) {
      if (name === 'occupied') {
        roomOccupied = typeof value === 'number' ? value >= 0.5 : value === true;
      } else if (name === 'distance_cm') {
        if (typeof value !== 'number') return;
        lastDistanceCm = value;
        updateTriggers(nowMs, true);
      } else if (name === 'velocity_cm_s') {
        if (typeof value === 'number') lastVelocityCmS = value;
      } else if (name === 'far_cm') {
        if (typeof value === 'number') farCm = value;
      } else if (name === 'motion') {
        motionActive = value === true || value === 1;
        lastMotionMs = nowMs;
        updateTriggers(nowMs, false);
      }
    },
    tick(nowMs) { updateTriggers(nowMs, false); },
  };
}

module.exports = { createPresenceModel };
