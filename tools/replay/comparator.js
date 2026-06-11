// The phase-0 comparator: golden capture vs replay capture, per-type rules,
// four-way verdicts (MIGRATION_PLAN.md, "The comparator"):
//   MATCH                 within declared tolerance
//   EXPECTED_DIFFERENCE   declared, intentional (here: Math.random-driven
//                         scheduling/timbre/phrase in the legacy trigger code)
//   REGRESSION            blocks
//   UNKNOWN               also blocks — undiagnosed difference is not a pass
//
// Times are compared as t_rel = t_mono_ms - anchor, where the anchor is each
// capture's first injected input event (invariant: bridge receive order is
// canonical; wall clocks never align across runs).

'use strict';

const VERDICTS = ['MATCH', 'EXPECTED_DIFFERENCE', 'UNKNOWN', 'REGRESSION'];
function worst(a, b) { return VERDICTS[Math.max(VERDICTS.indexOf(a), VERDICTS.indexOf(b))]; }

function anchorTime(events) {
  const e = events.find((ev) => ev.kind === 'ingest' || ev.kind === 'serial_rx');
  return (e || events[0] || { t_mono_ms: 0 }).t_mono_ms;
}

function rel(events, kind) {
  const t0 = anchorTime(events);
  return events.filter((e) => e.kind === kind).map((e) => ({ ...e, t_rel: e.t_mono_ms - t0 }));
}

function floatEq(a, b, tol) {
  const d = Math.abs(a - b);
  return d <= tol.eps_abs || d <= tol.eps_rel * Math.max(Math.abs(a), Math.abs(b));
}

function signalTolerance(tolerances, name) {
  if (tolerances.signals[name]) return tolerances.signals[name];
  for (const [pat, tol] of Object.entries(tolerances.signals)) {
    if (pat.endsWith('*') && name.startsWith(pat.slice(0, -1))) return tol;
  }
  return null;
}

// --- SSE state signals -------------------------------------------------------
function compareSse(golden, replay, tolerances, results) {
  const g = rel(golden.events, 'sse_out');
  const r = rel(replay.events, 'sse_out');
  const byName = (list) => {
    const m = new Map();
    for (const e of list) {
      if (!e.entry || typeof e.entry.name !== 'string') continue;
      if (!m.has(e.entry.name)) m.set(e.entry.name, []);
      m.get(e.entry.name).push({ t_rel: e.t_rel, value: e.entry.value });
    }
    return m;
  };
  const gm = byName(g);
  const rm = byName(r);
  for (const name of new Set([...gm.keys(), ...rm.keys()])) {
    const tol = signalTolerance(tolerances, name);
    const a = gm.get(name) || [];
    const b = rm.get(name) || [];
    const id = `sse:${name}`;
    if (!tol) {
      results.push({ id, verdict: 'UNKNOWN', detail: `no declared tolerance for signal "${name}" (${a.length} golden / ${b.length} replay events)` });
      continue;
    }
    if (a.length !== b.length) {
      results.push({ id, verdict: 'REGRESSION', detail: `event count ${a.length} golden vs ${b.length} replay` });
      continue;
    }
    let verdict = 'MATCH';
    let detail = `${a.length} events`;
    for (let i = 0; i < a.length; i++) {
      const va = a[i].value;
      const vb = b[i].value;
      const valueOk = tol.type === 'float'
        ? (typeof va === 'number' && typeof vb === 'number' && floatEq(va, vb, tol))
        : va === vb; // bool / int / enum: exact
      if (!valueOk) {
        verdict = 'REGRESSION';
        detail = `value diverges at index ${i}: ${JSON.stringify(va)} vs ${JSON.stringify(vb)}`;
        break;
      }
      const dt = Math.abs(a[i].t_rel - b[i].t_rel);
      if (dt > tol.latency_ms) {
        verdict = 'REGRESSION';
        detail = `latency ${dt.toFixed(0)}ms at index ${i} exceeds ${tol.latency_ms}ms`;
        break;
      }
    }
    results.push({ id, verdict, detail });
  }
}

// --- Daisy CC output (step-function comparison) -------------------------------
function stepValueAt(series, t) {
  let v;
  for (const p of series) {
    if (p.t_rel > t) break;
    v = p.value;
  }
  return v; // undefined before the first sample
}

// Every value the step function holds anywhere inside [t0, t1]: the value it
// entered the window with, plus every change point inside it. During a fast
// ramp the matching value lies BETWEEN window edges, so probing only discrete
// points would miss it.
function stepValuesIn(series, t0, t1) {
  const out = [];
  const entering = stepValueAt(series, t0);
  if (entering !== undefined) out.push(entering);
  for (const p of series) {
    if (p.t_rel > t1) break;
    if (p.t_rel > t0) out.push(p.value);
  }
  return out;
}

function ccSeries(events) {
  const out = new Map();
  for (const e of rel(events, 'serial_tx')) {
    if (!e.decoded || e.decoded.type !== 'cc') continue;
    if (!out.has(e.decoded.cc)) out.set(e.decoded.cc, []);
    out.get(e.decoded.cc).push({ t_rel: e.t_rel, value: e.decoded.value });
  }
  return out;
}

function compareCc(golden, replay, tolerances, results) {
  const gm = ccSeries(golden.events);
  const rm = ccSeries(replay.events);
  for (const cc of new Set([...gm.keys(), ...rm.keys()])) {
    const tol = tolerances.cc[cc];
    const a = gm.get(cc) || [];
    const b = rm.get(cc) || [];
    const id = `cc:${cc}${tol ? `(${tol.name})` : ''}`;
    if (!tol) {
      results.push({ id, verdict: 'UNKNOWN', detail: `no declared tolerance for CC ${cc}` });
      continue;
    }
    // Each run's change points must be explainable by the other run's step
    // function somewhere within ±window_ms (the rate cap samples wall time, so
    // exact change points differ legitimately). Two ways to explain a value:
    // the other run HELD it (within eps), or the other run TRAVERSED it — when
    // inputs outpace the 33 ms rate cap, which intermediate sample gets written
    // depends on ms-level arrival timing, so one run may step 71->75 where the
    // other wrote 73. Traversal only excuses values inside the window's
    // [min, max] span, i.e. values the other run demonstrably passed through.
    const explainedFlags = (points, other) => points.map((p) => {
      const cands = stepValuesIn(other, p.t_rel - tol.window_ms, p.t_rel + tol.window_ms);
      const held = cands.some((v) => Math.abs(v - p.value) <= tol.eps_value);
      const traversed = cands.length >= 2
        && p.value >= Math.min(...cands) - tol.eps_value
        && p.value <= Math.max(...cands) + tol.eps_value;
      return held || traversed;
    });
    // Second pass — the cap-dropped TRANSIENT class (real sensors only): a
    // single-sample spike is one write wide, so when the other run's rate cap
    // lands a few ms differently it drops that write entirely, and the spike
    // value sits OUTSIDE the window's traversal span by definition. Excused
    // iff the value was transient in its own run (lived <= transient_max_ms)
    // AND both neighbors are explained (the runs re-converge immediately).
    // Bounded by transient_budget per CC per session — a logic divergence
    // produces sustained disagreement, not a handful of one-sample blips.
    const explainAll = (points, other) => {
      const flags = explainedFlags(points, other);
      let excused = 0;
      for (let i = 0; i < points.length; i++) {
        if (flags[i]) continue;
        const livedMs = i + 1 < points.length ? points[i + 1].t_rel - points[i].t_rel : Infinity;
        const neighborsOk = (i === 0 || flags[i - 1]) && (i + 1 < points.length && flags[i + 1]);
        if (tol.transient_max_ms && livedMs <= tol.transient_max_ms && neighborsOk) { excused += 1; continue; }
        const p = points[i];
        return { fail: `value ${p.value} at t=${p.t_rel.toFixed(0)}ms unexplained by other run (±${tol.window_ms}ms, eps ${tol.eps_value})`, excused };
      }
      return { fail: null, excused };
    };
    const ra = explainAll(a, b);
    const rb = explainAll(b, a);
    const excusedTotal = ra.excused + rb.excused;
    let detail = ra.fail || rb.fail;
    if (!detail && excusedTotal > (tol.transient_budget || 0)) {
      detail = `${excusedTotal} cap-boundary transients exceed the declared budget (${tol.transient_budget || 0})`;
    }
    let verdict = detail ? 'REGRESSION' : 'MATCH';
    const transientNote = excusedTotal ? `, ${excusedTotal} cap-boundary transient(s) excused (budget ${tol.transient_budget})` : '';
    if (!detail && a.length && b.length) {
      const fa = a[a.length - 1].value;
      const fb = b[b.length - 1].value;
      if (Math.abs(fa - fb) > tol.eps_value) {
        verdict = 'REGRESSION';
        detail = `final value ${fa} vs ${fb}`;
      }
    }
    if (!detail) detail = `${a.length} golden / ${b.length} replay writes${transientNote}`;
    if ((a.length === 0) !== (b.length === 0)) {
      verdict = 'REGRESSION';
      detail = `one run never wrote CC ${cc} (${a.length} vs ${b.length})`;
    }
    results.push({ id, verdict, detail });
  }
}

// --- Daisy note events --------------------------------------------------------
// Classify each note_on via the `trigger` event the bridge logs at strike time
// (within the next few capture events / 250 ms).
function classifyNotes(events) {
  const t0 = anchorTime(events);
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind !== 'serial_tx' || !e.decoded || e.decoded.type !== 'note_on') continue;
    let cls = 'unclassified';
    for (let j = i + 1; j < Math.min(i + 6, events.length); j++) {
      const t = events[j];
      if (t.t_mono_ms - e.t_mono_ms > 250) break;
      if (t.kind !== 'trigger') continue;
      const reason = t.reason || '';
      if (t.what === 'bell' || t.what === 'industrial') {
        cls = reason.startsWith('toll') ? 'strike_toll' : 'strike_entry';
      } else if (t.what === 'voice') {
        cls = reason === 'active room' ? 'voice_murmur' : 'voice_exit';
      }
      break;
    }
    out.push({ t_rel: e.t_mono_ms - t0, cls, ...e.decoded });
  }
  return out;
}

function compareNotes(golden, replay, tolerances, results) {
  const g = classifyNotes(golden.events);
  const r = classifyNotes(replay.events);
  const classes = new Set([...g.map((n) => n.cls), ...r.map((n) => n.cls), ...Object.keys(tolerances.notes.classes)]);
  for (const cls of classes) {
    const spec = tolerances.notes.classes[cls];
    const a = g.filter((n) => n.cls === cls);
    const b = r.filter((n) => n.cls === cls);
    const id = `note:${cls}`;
    if (!spec) {
      if (a.length || b.length) results.push({ id, verdict: 'UNKNOWN', detail: `unclassified note events (${a.length} golden / ${b.length} replay)` });
      continue;
    }
    if (!spec.deterministic) {
      const verdict = (a.length || b.length) ? 'EXPECTED_DIFFERENCE' : 'MATCH';
      results.push({ id, verdict, detail: `${a.length} golden / ${b.length} replay — declared stochastic (${spec.reason})` });
      continue;
    }
    if (a.length !== b.length) {
      results.push({ id, verdict: 'REGRESSION', detail: `count ${a.length} golden vs ${b.length} replay` });
      continue;
    }
    let verdict = 'MATCH';
    let detail = `${a.length} events`;
    for (let i = 0; i < a.length; i++) {
      const dt = Math.abs(a[i].t_rel - b[i].t_rel);
      if (dt > spec.window_ms) {
        verdict = 'REGRESSION';
        detail = `event ${i} off by ${dt.toFixed(0)}ms (window ${spec.window_ms}ms)`;
        break;
      }
      if (a[i].vel !== b[i].vel) {
        verdict = 'REGRESSION';
        detail = `event ${i} velocity ${a[i].vel} vs ${b[i].vel}`;
        break;
      }
      if (cls.startsWith('strike')) {
        if (a[i].ch !== b[i].ch) {
          // industrial-vs-bell timbre is a random roll — declared
          verdict = worst(verdict, 'EXPECTED_DIFFERENCE');
          detail = `event ${i} timbre channel ${a[i].ch} vs ${b[i].ch} (random industrial roll)`;
        } else if (a[i].note !== b[i].note) {
          verdict = 'REGRESSION';
          detail = `event ${i} note ${a[i].note} vs ${b[i].note}`;
          break;
        }
      }
      // voice: note number is the randomly-picked phrase index — declared, ignored
    }
    results.push({ id, verdict, detail });
  }
}

// --- Drop behavior -------------------------------------------------------------
// Replayable drop reasons (the harness re-injects the raw bodies) must drop
// again for the same reason — that's decode behavior, and it gates.
function compareDrops(golden, replay, results) {
  const count = (s, reason) => s.events.filter((e) => e.kind === 'ingest_drop' && e.reason === reason).length;
  for (const reason of ['bad_json', 'payload_too_large']) {
    const a = count(golden, reason);
    const b = count(replay, reason);
    if (a || b) {
      results.push({
        id: `drop:${reason}`,
        verdict: a === b ? 'MATCH' : 'REGRESSION',
        detail: `${a} golden / ${b} replay`,
      });
    }
  }
}

function compare(golden, replay, tolerances) {
  const results = [];
  compareSse(golden, replay, tolerances, results);
  compareCc(golden, replay, tolerances, results);
  compareNotes(golden, replay, tolerances, results);
  compareDrops(golden, replay, results);
  const overall = results.reduce((v, r) => worst(v, r.verdict), 'MATCH');
  return {
    overall,
    blocks: overall === 'REGRESSION' || overall === 'UNKNOWN',
    golden: { dir: golden.dir, events: golden.events.length },
    replay: { dir: replay.dir, events: replay.events.length },
    results,
  };
}

// compareCc is exported standalone for the phase-4B graph validator
// (tools/sim/validate-tape.js): same step-function rules, same declared
// tolerances, applied to a predicted CC stream instead of a replay capture.
module.exports = { compare, compareCc };
