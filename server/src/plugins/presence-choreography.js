// presence_choreography.v1 — the trigger stack as a plugin (phase 6.1 step
// two, MIGRATION_PLAN.md). A VERBATIM port of daisy-position.js's
// bell/toll/voice/murmur state machines, with three deliberate differences:
//
//   1. OCCUPANCY IS AN INPUT. computeOccupancy() stayed behind: the
//      occupancy-conditioning router graph (graphs/occupancy.json) owns it,
//      and this plugin reads the bus-resolved `derived.room.occupied`.
//      Ordering note: the bridge starts the graph engines before the plugin
//      host subscribes, so the engine's synchronous occupancy publish reaches
//      onInput BEFORE the distance/motion packet that caused it does —
//      occupancy is always fresh when the trigger evaluation runs, exactly
//      legacy's computeOccupancy-first discipline.
//   2. RANDOMNESS IS THE HOST PRNG. Every Math.random became ctx.rand, with
//      the legacy CALL ORDER preserved exactly (industrial roll before the
//      toll reroll inside a strike; skip roll before the phrase roll in a
//      murmur) — the seeded stream only replays if the draw order is stable.
//   3. OUTPUTS ARE BUS EVENTS, not serial writes. `note_on` carries
//      [channel, note, velocity] (writeNoteOn's exact arguments; ch0 bell,
//      ch1 industrial, ch2 speech-with-phrase-as-note); nothing consumes it
//      until the cutover rebinds the MIDI adapter. `debug` carries the
//      decision instrumentation (armed/fire/suppressed/scheduled as JSON
//      text) — inspector/comparator food, never part of the stable surface.
//
// Eval sites are EXACTLY legacy's: a fresh distance sample (arrival-driven,
// fresh=true — the consecutive-sample approach gate only advances here), a
// motion edge (fresh=false), and the host tick (fresh=false). Velocity and
// occupancy arrivals update state without evaluating, as legacy's onChange
// did. The host tick runs at 250 ms vs legacy's 500 ms timer: window
// thresholds are detected up to 250 ms sooner, never differently — the
// declared timing class for the live comparison.
//
// Knob defaults are daisy-position's env defaults, verbatim. phrase_count
// must match dsp::pain_voice::PHRASE_COUNT (firmware wraps out-of-range, so
// drift only mis-labels logs — same contract as legacy).

'use strict';

const manifest = {
  asset: 'presence_choreography',
  version: 1,
  kind: 'GENERATOR',
  humanLabel: 'Presence choreography (bell / toll / exit voice / murmur)',
  schemaVersion: 'plugin.v1',
  inputs: [
    { name: 'occupied', valueType: 'VALUE_TYPE_FLOAT', shape: 'SHAPE_STATE', unit: 'ratio', required: true },
    { name: 'distance_cm', valueType: 'VALUE_TYPE_FLOAT', shape: 'SHAPE_STATE', unit: 'cm', required: true },
    { name: 'velocity_cm_s', valueType: 'VALUE_TYPE_FLOAT', shape: 'SHAPE_STATE', unit: 'cm_s', required: false },
    { name: 'far_cm', valueType: 'VALUE_TYPE_FLOAT', shape: 'SHAPE_STATE', unit: 'cm', required: true },
    { name: 'motion', valueType: 'VALUE_TYPE_BOOL', shape: 'SHAPE_STATE', unit: '', required: false },
  ],
  params: [
    { name: 'motion_presence', valueType: 'VALUE_TYPE_FLOAT', default: { number: 1 }, range: { min: 0, max: 1 } },
    { name: 'bell_note', valueType: 'VALUE_TYPE_FLOAT', default: { number: 81 }, range: { min: 0, max: 127 } },
    { name: 'bell_velocity', valueType: 'VALUE_TYPE_FLOAT', default: { number: 100 }, range: { min: 1, max: 127 } },
    { name: 'industrial_prob', valueType: 'VALUE_TYPE_FLOAT', default: { number: 0.1 }, range: { min: 0, max: 1 } },
    { name: 'industrial_note', valueType: 'VALUE_TYPE_FLOAT', default: { number: 81 }, range: { min: 0, max: 127 } },
    { name: 'enter_fraction', valueType: 'VALUE_TYPE_FLOAT', default: { number: 0.15 }, range: { min: 0, max: 1 } },
    { name: 'empty_fraction', valueType: 'VALUE_TYPE_FLOAT', default: { number: 0.08 }, range: { min: 0, max: 1 } },
    { name: 'rearm_recede_s', valueType: 'VALUE_TYPE_FLOAT', default: { number: 2.5 }, range: { min: 0, max: 600 } },
    { name: 'cooldown_s', valueType: 'VALUE_TYPE_FLOAT', default: { number: 30 }, range: { min: 0, max: 3600 } },
    { name: 'approach_cm_s', valueType: 'VALUE_TYPE_FLOAT', default: { number: 2.0 }, range: { min: 0, max: 400 } },
    { name: 'approach_sustain', valueType: 'VALUE_TYPE_FLOAT', default: { number: 3 }, range: { min: 1, max: 100 } },
    { name: 'toll_min_s', valueType: 'VALUE_TYPE_FLOAT', default: { number: 120 }, range: { min: 0, max: 7200 } },
    { name: 'toll_max_s', valueType: 'VALUE_TYPE_FLOAT', default: { number: 180 }, range: { min: 0, max: 7200 } },
    { name: 'toll_skip_prob', valueType: 'VALUE_TYPE_FLOAT', default: { number: 0.25 }, range: { min: 0, max: 1 } },
    { name: 'voice_velocity', valueType: 'VALUE_TYPE_FLOAT', default: { number: 100 }, range: { min: 1, max: 127 } },
    { name: 'voice_presence_min_s', valueType: 'VALUE_TYPE_FLOAT', default: { number: 3.0 }, range: { min: 0, max: 600 } },
    { name: 'voice_confirm_empty_s', valueType: 'VALUE_TYPE_FLOAT', default: { number: 2.0 }, range: { min: 0, max: 600 } },
    { name: 'voice_toll', valueType: 'VALUE_TYPE_FLOAT', default: { number: 1 }, range: { min: 0, max: 1 } },
    { name: 'voice_toll_min_s', valueType: 'VALUE_TYPE_FLOAT', default: { number: 300 }, range: { min: 0, max: 7200 } },
    { name: 'voice_toll_max_s', valueType: 'VALUE_TYPE_FLOAT', default: { number: 600 }, range: { min: 0, max: 7200 } },
    { name: 'voice_toll_skip_prob', valueType: 'VALUE_TYPE_FLOAT', default: { number: 0.25 }, range: { min: 0, max: 1 } },
    { name: 'voice_toll_active_s', valueType: 'VALUE_TYPE_FLOAT', default: { number: 30 }, range: { min: 0, max: 3600 } },
    { name: 'voice_min_gap_s', valueType: 'VALUE_TYPE_FLOAT', default: { number: 20 }, range: { min: 0, max: 3600 } },
    { name: 'motion_hold_s', valueType: 'VALUE_TYPE_FLOAT', default: { number: 20 }, range: { min: 0, max: 600 } },
    { name: 'phrase_count', valueType: 'VALUE_TYPE_FLOAT', default: { number: 15 }, range: { min: 1, max: 128 } },
  ],
  outputs: [
    { name: 'note_on', valueType: 'VALUE_TYPE_VEC', shape: 'SHAPE_EVENT', unit: '',
      required: true, dest: 'BUS', media: 'SIGNAL', busPath: 'seq.presence.note_on' },
    { name: 'debug', valueType: 'VALUE_TYPE_TEXT', shape: 'SHAPE_EVENT', unit: '',
      required: false, dest: 'BUS', media: 'SIGNAL', busPath: 'seq.presence.debug' },
  ],
  memberNeeds: [],
  rateDomain: 'RATE_CONTROL',
  requiresHostTick: true,
  determinism: 'REPLAYABLE',
  stateModel: 'SNAPSHOTTABLE',
};

function create({ params: p }) {
  const MOTION_PRESENCE = p.motion_presence >= 0.5;
  const MOTION_HOLD_MS = p.motion_hold_s * 1000;
  const VOICE_TOLL = p.voice_toll >= 0.5;
  const TOLL_MAX_S = Math.max(p.toll_min_s, p.toll_max_s);
  const VOICE_TOLL_MAX_S = Math.max(p.voice_toll_min_s, p.voice_toll_max_s);
  const APPROACH_SUSTAIN = Math.max(1, Math.round(p.approach_sustain));

  // ── state (daisy-position's module globals, verbatim names) ────────────
  let roomOccupied = false;       // <- derived.room.occupied (the ported boundary)
  let lastDistanceCm = null;
  let lastVelocityCmS = 0;
  let farCm = null;               // resolved effective far (defaults writer guarantees presence)
  let motionActive = false;
  let lastMotionMs = -Infinity;
  let bellArmed = false;
  let emptySinceMs = null;
  let approachFrames = 0;
  // Legacy inits this to 0 against Date.now() epoch ms — semantically
  // "never struck". On the host's monotonic clock 0 is RECENT (the capture
  // timeline starts near it), so the literal port wrongly cooldown-blocked
  // the session's first bell (caught by lane B on the real golden). Port the
  // intent, not the sentinel.
  let lastBellMs = -Infinity;
  let nextTollMs = null;
  let occupiedSinceMs = null;
  let voicePending = false;
  let voiceEmptySinceMs = null;
  let nextMurmurMs = null;
  let lastVoiceMs = -Infinity;

  const dbg = (ctx, kind, fields) => ctx.emit('debug', JSON.stringify({ kind, ...fields }));

  // Draw order inside a strike is part of the replay contract: industrial
  // roll FIRST, toll reroll second (only while occupied) — legacy verbatim.
  function strikeBell(ctx, reason) {
    const industrial = ctx.rand() < p.industrial_prob;
    ctx.emit('note_on', industrial ? [1, p.industrial_note, p.bell_velocity] : [0, p.bell_note, p.bell_velocity]);
    lastBellMs = ctx.now;
    if (roomOccupied) scheduleNextToll(ctx);
    dbg(ctx, 'fire', { what: industrial ? 'industrial' : 'bell', reason });
  }

  function speakPhrase(ctx, reason) {
    const phrase = Math.floor(ctx.rand() * Math.round(p.phrase_count));
    ctx.emit('note_on', [2, phrase, p.voice_velocity]);
    lastVoiceMs = ctx.now;
    dbg(ctx, 'fire', { what: 'voice', reason, phrase });
  }

  function scheduleNextToll(ctx) {
    nextTollMs = ctx.now + (p.toll_min_s + ctx.rand() * (TOLL_MAX_S - p.toll_min_s)) * 1000;
    dbg(ctx, 'scheduled', { what: 'toll', at_ms: nextTollMs });
  }

  function scheduleNextMurmur(ctx) {
    nextMurmurMs = ctx.now + (p.voice_toll_min_s + ctx.rand() * (VOICE_TOLL_MAX_S - p.voice_toll_min_s)) * 1000;
    dbg(ctx, 'scheduled', { what: 'murmur', at_ms: nextMurmurMs });
  }

  function motionPresent(nowMs) {
    if (!MOTION_PRESENCE) return false;
    return motionActive || nowMs - lastMotionMs <= MOTION_HOLD_MS;
  }

  function updateBellTriggerMotion(ctx) {
    const nowMs = ctx.now;
    if (!roomOccupied) {
      if (emptySinceMs === null) emptySinceMs = nowMs;
      if (!bellArmed && nowMs - emptySinceMs >= p.rearm_recede_s * 1000) {
        bellArmed = true;
        dbg(ctx, 'armed', { trigger: 'bell' });
      }
      return;
    }
    emptySinceMs = null;
    if (bellArmed && nowMs - lastBellMs >= p.cooldown_s * 1000) {
      strikeBell(ctx, motionActive ? 'entry (motion)' : 'entry (motion-mode, ToF)');
      bellArmed = false;
    }
  }

  function updateBellTrigger(ctx, fresh) {
    if (MOTION_PRESENCE) { updateBellTriggerMotion(ctx); return; }
    const nowMs = ctx.now;
    if (lastDistanceCm === null || !(farCm > 0)) return;
    const enterThresh = farCm * (1 - p.enter_fraction);
    const emptyThresh = farCm * (1 - p.empty_fraction);

    if (lastDistanceCm >= emptyThresh) {
      if (emptySinceMs === null) emptySinceMs = nowMs;
      if (!bellArmed && nowMs - emptySinceMs >= p.rearm_recede_s * 1000) {
        bellArmed = true;
        dbg(ctx, 'armed', { trigger: 'bell' });
      }
      approachFrames = 0;
      return;
    }

    emptySinceMs = null;

    if (fresh) {
      const inwardSpeed = -lastVelocityCmS;
      if (lastDistanceCm <= enterThresh && inwardSpeed >= p.approach_cm_s) approachFrames += 1;
      else approachFrames = 0;
    }

    if (bellArmed && approachFrames >= APPROACH_SUSTAIN
        && nowMs - lastBellMs >= p.cooldown_s * 1000) {
      strikeBell(ctx, `entry at ${lastDistanceCm.toFixed(0)}cm, ${(-lastVelocityCmS).toFixed(1)}cm/s in, far=${farCm.toFixed(0)}cm`);
      bellArmed = false;
      approachFrames = 0;
    }
  }

  function updateVoiceTrigger(ctx) {
    const nowMs = ctx.now;
    if (roomOccupied) {
      if (occupiedSinceMs === null) occupiedSinceMs = nowMs;
      voiceEmptySinceMs = null;
      if (nowMs - occupiedSinceMs >= p.voice_presence_min_s * 1000 && !voicePending) {
        voicePending = true;
        dbg(ctx, 'armed', { trigger: 'voice' });
      }
      return;
    }
    occupiedSinceMs = null;
    if (!voicePending) return;
    if (voiceEmptySinceMs === null) voiceEmptySinceMs = nowMs;
    if (nowMs - voiceEmptySinceMs >= p.voice_confirm_empty_s * 1000) {
      speakPhrase(ctx, `room emptied, far=${farCm === null ? '?' : farCm.toFixed(0)}cm`);
      voicePending = false;
      voiceEmptySinceMs = null;
    }
  }

  function updateToll(ctx) {
    const nowMs = ctx.now;
    if (!roomOccupied) { nextTollMs = null; return; }
    if (nextTollMs === null) { scheduleNextToll(ctx); return; }
    if (nowMs < nextTollMs) return;
    if (nowMs - lastBellMs < p.cooldown_s * 1000) {
      scheduleNextToll(ctx);
      dbg(ctx, 'suppressed', { what: 'toll', reason: 'cooldown' });
      return;
    }
    if (ctx.rand() < p.toll_skip_prob) {
      scheduleNextToll(ctx);
      dbg(ctx, 'suppressed', { what: 'toll', reason: 'skip_roll' });
      return;
    }
    strikeBell(ctx, `toll, far=${farCm === null ? '?' : farCm.toFixed(0)}cm`);
  }

  function updateVoiceMurmur(ctx) {
    const nowMs = ctx.now;
    if (!VOICE_TOLL) return;
    if (!roomOccupied) { nextMurmurMs = null; return; }
    if (nextMurmurMs === null) { scheduleNextMurmur(ctx); return; }
    if (nowMs < nextMurmurMs) return;
    const active = motionActive || nowMs - lastMotionMs <= p.voice_toll_active_s * 1000;
    if (!active) return; // stays due; fires at the next motion (legacy verbatim)
    if (nowMs - lastVoiceMs < p.voice_min_gap_s * 1000) return;
    if (ctx.rand() < p.voice_toll_skip_prob) {
      scheduleNextMurmur(ctx);
      dbg(ctx, 'suppressed', { what: 'murmur', reason: 'skip_roll' });
      return;
    }
    speakPhrase(ctx, 'active room');
    scheduleNextMurmur(ctx);
  }

  // Legacy evaluation order, verbatim (occupancy already arrived — see header).
  function updateTriggers(ctx, fresh) {
    updateBellTrigger(ctx, fresh);
    updateVoiceTrigger(ctx);
    updateToll(ctx);
    updateVoiceMurmur(ctx);
  }

  return {
    onInput(port, value, ctx) {
      if (port === 'occupied') {
        roomOccupied = typeof value === 'number' ? value >= 0.5 : value === true;
      } else if (port === 'distance_cm') {
        if (typeof value !== 'number') return;
        lastDistanceCm = value;
        updateTriggers(ctx, true); // the ONLY fresh site — the approach gate counts these
      } else if (port === 'velocity_cm_s') {
        if (typeof value === 'number') lastVelocityCmS = value;
      } else if (port === 'far_cm') {
        if (typeof value === 'number') farCm = value;
      } else if (port === 'motion') {
        motionActive = value === true || value === 1;
        lastMotionMs = ctx.now;
        updateTriggers(ctx, false);
      }
    },

    tick(ctx) { updateTriggers(ctx, false); },

    snapshot() {
      return {
        room_occupied: roomOccupied,
        last_distance_cm: lastDistanceCm,
        last_velocity_cm_s: lastVelocityCmS,
        far_cm: farCm,
        motion_active: motionActive,
        last_motion_ms: lastMotionMs,
        bell_armed: bellArmed,
        empty_since_ms: emptySinceMs,
        approach_frames: approachFrames,
        last_bell_ms: lastBellMs,
        next_toll_ms: nextTollMs,
        occupied_since_ms: occupiedSinceMs,
        voice_pending: voicePending,
        voice_empty_since_ms: voiceEmptySinceMs,
        next_murmur_ms: nextMurmurMs,
        last_voice_ms: lastVoiceMs,
      };
    },
    restore(s) {
      roomOccupied = !!s.room_occupied;
      lastDistanceCm = s.last_distance_cm ?? null;
      lastVelocityCmS = s.last_velocity_cm_s || 0;
      farCm = s.far_cm ?? null;
      motionActive = !!s.motion_active;
      lastMotionMs = s.last_motion_ms ?? -Infinity;
      bellArmed = !!s.bell_armed;
      emptySinceMs = s.empty_since_ms ?? null;
      approachFrames = s.approach_frames || 0;
      lastBellMs = typeof s.last_bell_ms === 'number' ? s.last_bell_ms : -Infinity;
      nextTollMs = s.next_toll_ms ?? null;
      occupiedSinceMs = s.occupied_since_ms ?? null;
      voicePending = !!s.voice_pending;
      voiceEmptySinceMs = s.voice_empty_since_ms ?? null;
      nextMurmurMs = s.next_murmur_ms ?? null;
      lastVoiceMs = s.last_voice_ms ?? -Infinity;
    },
  };
}

module.exports = { manifest, create };
