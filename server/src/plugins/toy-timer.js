// toy_timer.v1 — the phase-6.0 de-risking plugin (MIGRATION_PLAN.md).
//
// Deliberately trivial choreography with the exact execution shape of the
// phase-6.1 trigger stack: a self-scheduled timer that fires at a seeded
// random interval and sometimes skips a due fire — the toll's
// irregular-recurrence pattern, minus every ounce of installation logic. It
// exists so the first plugin-host bug hunt (tick discipline, PRNG threading,
// snapshot/restore, replay) happens here, not inside bell/voice/murmur.
//
// Contract obligations exercised on purpose:
//   - requires_host_tick: true — no inputs; if the host tick stalls, this
//     plugin falls silent (observable, not silent-wrong).
//   - REPLAYABLE — all randomness via ctx.rand (the host's seeded PRNG);
//     wall-clock and Math.random are NEVER touched. Same seed + same tick
//     timeline -> the same pulses, every run.
//   - SNAPSHOTTABLE — snapshot()/restore() carry the full timer state; the
//     host pairs it with the PRNG state so a restored instance continues the
//     random stream bit-exactly.
//
// The pulse payload is the monotonically increasing fire count — harmless,
// and self-verifying under replay (a dropped or doubled fire shows as a gap
// or repeat, not just a timing wiggle).

'use strict';

const manifest = {
  asset: 'toy_timer',
  version: 1,
  kind: 'GENERATOR',
  humanLabel: 'Toy seeded timer (phase 6.0 host prove-out)',
  schemaVersion: 'plugin.v1',
  inputs: [],
  params: [
    { name: 'min_interval_s', valueType: 'VALUE_TYPE_FLOAT', default: { number: 2 }, range: { min: 0, max: 3600 } },
    { name: 'max_interval_s', valueType: 'VALUE_TYPE_FLOAT', default: { number: 5 }, range: { min: 0, max: 3600 } },
    { name: 'skip_prob', valueType: 'VALUE_TYPE_FLOAT', default: { number: 0.25 }, range: { min: 0, max: 1 } },
  ],
  outputs: [
    { name: 'pulse', valueType: 'VALUE_TYPE_INT', shape: 'SHAPE_EVENT', unit: 'count',
      required: true, dest: 'BUS', media: 'SIGNAL', busPath: 'seq.toy.pulse' },
  ],
  memberNeeds: [],
  rateDomain: 'RATE_CONTROL',
  requiresHostTick: true,
  determinism: 'REPLAYABLE',
  stateModel: 'SNAPSHOTTABLE',
};

function create({ params }) {
  const minS = params.min_interval_s;
  // Degenerate span (max < min) steps to min rather than poisoning the roll —
  // the rule-13 posture, applied to params.
  const maxS = Math.max(params.min_interval_s, params.max_interval_s);
  const skipProb = params.skip_prob;

  // Timer state. nextDueMs is in HOST CLOCK time (bus monotonic; virtual in
  // the sim) — a snapshot is resumable within one clock domain, which is what
  // replay-resume needs; cross-boot restore is reinit (plugin.v1 makes no
  // cross-version/cross-boot state promise).
  let nextDueMs = null;
  let count = 0;

  const roll = (now, rand) => { nextDueMs = now + (minS + rand() * (maxS - minS)) * 1000; };

  return {
    tick({ now, rand, emit }) {
      if (nextDueMs === null) { roll(now, rand); return; } // first tick arms, never fires
      if (now < nextDueMs) return;
      // Due. One rand() for the skip roll, then one for the next interval —
      // a FIXED draw order, so the PRNG stream stays alignable under replay.
      if (rand() < skipProb) {
        roll(now, rand);
        return;
      }
      count += 1;
      emit('pulse', count);
      roll(now, rand);
    },
    snapshot() { return { next_due_ms: nextDueMs, count }; },
    restore(state) {
      nextDueMs = typeof state.next_due_ms === 'number' ? state.next_due_ms : null;
      count = Number(state.count) || 0;
    },
  };
}

module.exports = { manifest, create };
