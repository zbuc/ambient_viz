// Virtual time for the graph simulator (phase 4, MIGRATION_PLAN.md).
//
// The simulator never touches the wall clock: virtual "now" is the capture's
// own t_mono_ms timeline, and everything periodic (adapter keepalives, bus
// _meta) runs as discrete-event timers interleaved with the capture events.
// Same inputs -> same total order -> byte-identical logs, every run.
//
// Tie rule (deterministic by construction): a timer due at exactly an input
// event's timestamp fires BEFORE the event; timers due at the same instant
// fire in registration order.

'use strict';

class VirtualClock {
  constructor(startMs = 0) { this.t = startMs; }
  now() { return this.t; }
}

class Scheduler {
  constructor(clock) {
    this.clock = clock;
    this.timers = []; // { due, periodMs, run, cancelled } in registration order
  }

  // Drop-in for bus-adapter's scheduleRepeating injection. First firing is one
  // period after registration time.
  addRepeating(run, periodMs) {
    const timer = { due: this.clock.now() + periodMs, periodMs, run, cancelled: false };
    this.timers.push(timer);
    return () => { timer.cancelled = true; };
  }

  // Fire every timer due at or before `untilMs`, in due order (ties by
  // registration order), advancing the clock to each due time.
  _drainUntil(untilMs) {
    for (;;) {
      let best = null;
      for (const tm of this.timers) {
        if (tm.cancelled || tm.due > untilMs) continue;
        if (!best || tm.due < best.due) best = tm;
      }
      if (!best) return;
      this.clock.t = Math.max(this.clock.t, best.due);
      best.run();
      best.due += best.periodMs;
    }
  }

  // Run a pre-sorted input timeline [{t, run}] to completion.
  run(inputs) {
    for (const ev of inputs) {
      this._drainUntil(ev.t);
      this.clock.t = Math.max(this.clock.t, ev.t); // capture t_mono is monotonic; guard regardless
      ev.run();
    }
  }
}

module.exports = { VirtualClock, Scheduler };
