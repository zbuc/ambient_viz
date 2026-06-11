// orrery bus.v1 — in-process implementation (MIGRATION_PLAN.md phase 1).
//
// Implements the bus semantics from BUS_PROTOCOL.md on plain proto-JSON-shaped
// objects (the generated codecs in ./gen are the schema-of-record; encode/
// decode is exercised by tests and used when the bus first crosses a process
// boundary — in-process we stay on plain objects):
//
//   - retained STATE per path, replayed to late subscribers;
//   - per-(source,path) (boot_epoch, seq) ordering: stale-epoch/old-seq packets
//     are rejected and counted, seq gaps are counted;
//   - priority arbitration per STATE sink: highest non-stale, non-released
//     writer wins; equal priority resolves by receiver arrival order
//     (declared arbitrary across sources — BUS_PROTOCOL.md);
//   - EVENT queues: append-only, never coalesced, bounded (drop-oldest),
//     every drop counted; consumers drain explicitly;
//   - staleness: HOLD only in phase 1 — a stale candidate is *flagged* and
//     loses arbitration to live writers, but if every writer is stale the
//     last resolved value HOLDs (no failsafe modes until manifests, phase 3);
//   - `_meta.<path>.{rate_hz,last_writer,seq_gaps,queue_depth,drops}`
//     republished at 1 Hz as ordinary bus signals, so the inspector is just a
//     subscriber;
//   - enforcement truth values: what phase 1 deliberately skips (signatures,
//     range, policy) is reported as SKIPPED per packet — honestly displayed,
//     never silently green (BACKLOG.md milestone 1).
//
// Phase-1 scope guard: no Bundle handling (nothing publishes bundles yet), no
// stale modes beyond HOLD, no policy. Type checking happens when a path was
// registered with an expected type; unregistered paths are UNCHECKED.

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');

const SCHEMA = 'bus.v1';
const DEFAULT_MAX_QUEUE = 256;
const META_PERIOD_MS = 1000;
const META_SOURCE = 'spiffe://pain-material.local/bridge/bus-meta';

// Reads/increments the persisted boot-epoch counter (BUS_PROTOCOL.md: ordering
// key survives reboots). One file per node; the bridge is one node.
function nextBootEpoch(file) {
  let n = 0;
  try { n = parseInt(fs.readFileSync(file, 'utf8'), 10) || 0; } catch { /* first boot */ }
  n += 1;
  try { fs.writeFileSync(file, String(n)); }
  catch { n = Math.floor(Math.random() * 0xffffffff); } // spec fallback: re-randomize
  return n >>> 0;
}

// The Value oneof in proto-JSON shape. Phase 1 publishes scalars + vecs.
function toValue(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? { integer: v } : { number: v };
  if (typeof v === 'boolean') return { boolean: v };
  if (typeof v === 'string') return { text: v };
  if (Array.isArray(v)) return { vec: { elems: v } };
  return null;
}
function fromValue(val) {
  if (!val || typeof val !== 'object') return undefined;
  if ('number' in val) return val.number;
  if ('integer' in val) return val.integer;
  if ('boolean' in val) return val.boolean;
  if ('text' in val) return val.text;
  if ('vec' in val) return val.vec && val.vec.elems;
  if ('blob' in val) return val.blob;
  return undefined;
}
function valueKind(val) {
  if (!val || typeof val !== 'object') return 'missing';
  for (const k of ['number', 'integer', 'boolean', 'text', 'vec', 'blob']) {
    if (k in val) return k;
  }
  return 'missing';
}
// ValueType (common.v1) -> acceptable Value oneof members. FLOAT accepts
// integer because proto-JSON renders a whole-number double as an int literal.
const TYPE_ACCEPTS = {
  float: ['number', 'integer'],
  int: ['integer'],
  bool: ['boolean'],
  text: ['text'],
  vec: ['vec'],
  blob: ['blob'],
};

class OrreryBus extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.nowMono = opts.nowMono || (() => performance.now());
    this.bootEpoch = nextBootEpoch(
      opts.bootEpochFile || path.join(__dirname, '..', '.orrery-boot-epoch'),
    );
    this.startedAt = this.nowMono();
    // path -> {
    //   shape: 'state'|'event', declaredType, staleAfterMs, maxQueue,
    //   writers: Map(source_id -> writer),
    //   resolved: {value, sourceId, atMono} | null   (STATE)
    //   queue: [{payload, source, atMono, seq}], drops, dedupe: Set (EVENT)
    //   arrival: counter for arrival-order ties
    //   counters: {packets, rejects:{...}, lastRateWindow}
    // }
    this.paths = new Map();
    this.warns = [];        // last 100 policy/range WARNs (inspector's triage feed)
    this.warnsTotal = 0;
    this._policyCheck = null;
    this._arrival = 0;
    this._seqBySource = new Map(); // our own publishing seq per source_id
    this._metaTimer = setInterval(() => this._publishMeta(), META_PERIOD_MS);
    if (this._metaTimer.unref) this._metaTimer.unref();
  }

  // Declare a path's contract before/at first publish. Idempotent.
  // type: 'float'|'int'|'bool'|'text'|'vec'|'blob' (or null = UNCHECKED)
  registerPath(p, { shape = 'state', type = null, staleAfterMs = 0, maxQueue = DEFAULT_MAX_QUEUE, range = null } = {}) {
    if (!this.paths.has(p)) {
      this.paths.set(p, {
        shape, declaredType: type, staleAfterMs, maxQueue, range,
        writers: new Map(),
        resolved: null,
        queue: [], drops: 0, dedupe: new Set(),
        counters: { packets: 0, rejected_type: 0, rejected_order: 0, policy_warns: 0, range_warns: 0, window: [] },
      });
    }
    return this.paths.get(p);
  }

  // Phase-3 policy hook (manifest registry). The check is OBSERVATIONAL in
  // WARN mode: it annotates enforcement + counts, it never rejects. fn(pkt,
  // path) -> { ok, reasons[] } or null for exempt paths.
  setPolicy(fn) { this._policyCheck = fn; }

  _warn(path, sourceId, kind, reasons) {
    this.warnsTotal += 1;
    this.warns.push({ t_wall_ms: Date.now(), path, source_id: sourceId, kind, reasons });
    if (this.warns.length > 100) this.warns.shift();
  }

  // Convenience publisher used by in-bridge adapters: builds a full bus.v1
  // proto-JSON packet around a JS value. Returns the acceptance record.
  publishState(p, jsValue, { sourceId, priority = 0, release = false } = {}) {
    const seq = (this._seqBySource.get(sourceId) || 0) + 1;
    this._seqBySource.set(sourceId, seq);
    return this.publish({
      schema: SCHEMA,
      source: { sourceId, seq, bootEpoch: this.bootEpoch },
      time: { monotonic: { device: 'bridge', nanos: Math.round(this.nowMono() * 1e6) } },
      priority,
      state: { path: p, value: toValue(jsValue), release },
    });
  }

  publishEvent(p, jsPayload, { sourceId, priority = 0, dedupeKey } = {}) {
    const seq = (this._seqBySource.get(sourceId) || 0) + 1;
    this._seqBySource.set(sourceId, seq);
    return this.publish({
      schema: SCHEMA,
      source: { sourceId, seq, bootEpoch: this.bootEpoch },
      time: { monotonic: { device: 'bridge', nanos: Math.round(this.nowMono() * 1e6) } },
      priority,
      event: { path: p, payload: toValue(jsPayload), dedupeKey },
    });
  }

  // The bus entry point: one proto-JSON SignalPacket. Returns
  // { accepted, reasons, enforcement } and emits 'packet' for subscribers.
  publish(pkt) {
    const now = this.nowMono();
    const body = pkt.state || pkt.event;
    const shape = pkt.state ? 'state' : pkt.event ? 'event' : null;
    // Enforcement truth values — phase 1 skips signature/range/policy BY
    // DESIGN and says so per packet rather than pretending they passed.
    const enforcement = {
      signature: 'SKIPPED (enforcement off)',
      cert: 'SKIPPED (enforcement off)',
      type: 'UNCHECKED (no declared type)',
      range: 'UNCHECKED (no declared range)',
      policy: 'SKIPPED (no policy loaded)',
    };
    const reject = (reason) => {
      const rec = { accepted: false, reasons: [reason], enforcement, pkt };
      this.emit('packet', rec);
      return rec;
    };
    if (!shape || !body || typeof body.path !== 'string' || !body.path) return reject('malformed');
    if (pkt.schema !== SCHEMA) return reject(`schema ${pkt.schema} != ${SCHEMA}`);
    const src = pkt.source || {};
    if (!src.sourceId) return reject('missing source_id');

    const entry = this.registerPath(body.path, { shape });
    entry.counters.packets += 1;
    entry.counters.window.push(now);

    if (entry.shape !== shape) return reject(`shape mismatch: path is ${entry.shape}, packet is ${shape}`);

    // Type check against the declared contract, when there is one.
    if (entry.declaredType) {
      const kind = valueKind(pkt.state ? body.value : body.payload);
      const ok = (TYPE_ACCEPTS[entry.declaredType] || []).includes(kind)
        || (shape === 'event' && kind === 'missing'); // payload is optional on events
      enforcement.type = ok ? `OK (${entry.declaredType})` : `REJECTED (declared ${entry.declaredType}, got ${kind})`;
      if (!ok) {
        entry.counters.rejected_type += 1;
        const w = this._writer(entry, src, now);
        w.lastTypeRejectAt = now;
        return reject('type_rejected');
      }
    }

    // Policy (phase 3, WARN mode): observational — annotate + count, never reject.
    if (this._policyCheck) {
      const verdict = this._policyCheck(pkt, body.path);
      if (verdict === null) {
        enforcement.policy = 'EXEMPT (reserved domain)';
      } else if (verdict.ok) {
        enforcement.policy = 'OK (WARN mode)';
      } else {
        enforcement.policy = `WARN: ${verdict.reasons.join('; ')}`;
        entry.counters.policy_warns += 1;
        this._warn(body.path, src.sourceId, 'policy', verdict.reasons);
      }
    }
    // Declared range (phase 3, WARN mode): numbers outside [min,max] are flagged.
    if (entry.range && pkt.state) {
      const num = fromValue(body.value);
      if (typeof num === 'number' && (num < entry.range.min || num > entry.range.max)) {
        enforcement.range = `WARN: ${num} outside [${entry.range.min}, ${entry.range.max}]`;
        entry.counters.range_warns += 1;
        this._warn(body.path, src.sourceId, 'range', [enforcement.range]);
      } else if (typeof num === 'number') {
        enforcement.range = `OK [${entry.range.min}, ${entry.range.max}] (WARN mode)`;
      }
    }

    // (boot_epoch, seq) ordering per (source, path): reject regressions, count gaps.
    const w = this._writer(entry, src, now);
    const epoch = src.bootEpoch >>> 0;
    const seq = Number(src.seq) || 0;
    if (w.lastBootEpoch !== null) {
      if (epoch < w.lastBootEpoch || (epoch === w.lastBootEpoch && seq <= w.lastSeq)) {
        entry.counters.rejected_order += 1;
        return reject(`out_of_order (have ${w.lastBootEpoch},${w.lastSeq}; got ${epoch},${seq})`);
      }
      if (epoch === w.lastBootEpoch && seq > w.lastSeq + 1) w.seqGaps += seq - w.lastSeq - 1;
    }
    w.lastBootEpoch = epoch;
    w.lastSeq = seq;
    w.lastUpdateMono = now;
    w.packets += 1;
    w.priority = pkt.priority || 0;

    if (shape === 'state') {
      w.value = fromValue(body.value);
      w.released = !!body.release;
      if (!w.released) w.arrival = ++this._arrival;
      this._resolve(entry, now);
    } else {
      // EVENT: dedupe, then bounded append — never coalesced, drops counted.
      const key = body.dedupeKey || `${src.sourceId}#${epoch}#${seq}`;
      if (entry.dedupe.has(key)) return reject('duplicate_event');
      entry.dedupe.add(key);
      if (entry.dedupe.size > entry.maxQueue * 4) {
        entry.dedupe = new Set([...entry.dedupe].slice(-entry.maxQueue * 2));
      }
      entry.queue.push({ path: body.path, payload: fromValue(body.payload), sourceId: src.sourceId, seq, atMono: now });
      if (entry.queue.length > entry.maxQueue) {
        entry.queue.shift();
        entry.drops += 1; // overflow_policy: drop_oldest (phase-1 default), counted
      }
    }

    const rec = { accepted: true, reasons: [], enforcement, pkt };
    this.emit('packet', rec);
    return rec;
  }

  _writer(entry, src, now) {
    let w = entry.writers.get(src.sourceId);
    if (!w) {
      w = {
        sourceId: src.sourceId, priority: 0, value: undefined,
        lastBootEpoch: null, lastSeq: 0, lastUpdateMono: now,
        seqGaps: 0, packets: 0, released: false, arrival: 0, lastTypeRejectAt: null,
      };
      entry.writers.set(src.sourceId, w);
    }
    return w;
  }

  _isStale(entry, w, now) {
    return entry.staleAfterMs > 0 && (now - w.lastUpdateMono) > entry.staleAfterMs;
  }

  // STATE arbitration: highest-priority live (non-released, non-stale) writer;
  // equal priority -> latest arrival. If nobody is live, HOLD the last value.
  _resolve(entry, now) {
    let win = null;
    for (const w of entry.writers.values()) {
      if (w.released || this._isStale(entry, w, now) || w.value === undefined) continue;
      if (!win || w.priority > win.priority || (w.priority === win.priority && w.arrival > win.arrival)) win = w;
    }
    if (win) entry.resolved = { value: win.value, sourceId: win.sourceId, atMono: now };
    // else: HOLD — entry.resolved keeps its previous value (phase-1 stale mode)
  }

  // EVENT consumption: drain everything pending (the receiver contract).
  drainEvents(p, max = Infinity) {
    const entry = this.paths.get(p);
    if (!entry || entry.shape !== 'event') return [];
    const n = Math.min(entry.queue.length, max);
    return entry.queue.splice(0, n);
  }

  // Retained-state replay for late joiners: every resolved STATE now.
  retained() {
    const out = [];
    for (const [p, entry] of this.paths) {
      if (entry.shape === 'state' && entry.resolved) {
        out.push({ path: p, value: entry.resolved.value, sourceId: entry.resolved.sourceId });
      }
    }
    return out;
  }

  // The bus-over-SSE transport frame for an accepted packet: the packet
  // verbatim, plus — for STATE — a `resolved` annotation carrying the
  // arbitrated value AFTER this packet. Consumers must read state through
  // arbitration, never packet payloads (the rule the engine learned in 4C
  // and the CC binding in 4D): on a multi-writer path, a shadowed writer's
  // keepalive must not drag a feed-derived state back to a losing value.
  // (Found live in the phase-5 kiosk A/B: the defaults writer's near/far
  // keepalives flapped the browser's feed-derived endpoints under feed=bus
  // while the graphs, reading RESOLVED, stayed correct.) `resolved` is a
  // transport-view annotation, not a bus.v1 packet field — the /bus/events
  // wire is "packet + resolution", which is what the retained replay
  // already serves.
  packetFrame(rec) {
    const body = rec.pkt.state;
    if (!body) return rec.pkt; // EVENTs interleave; there is nothing to resolve
    const entry = this.paths.get(body.path);
    if (!entry || !entry.resolved) return rec.pkt;
    return { ...rec.pkt, resolved: toValue(entry.resolved.value) };
  }

  // The inspector's two-layer view (MIGRATION_PLAN.md "Shadow visibility"):
  // per path the resolved value AND every writer candidate, pre-resolution,
  // with status explaining why each one is or isn't winning.
  snapshot() {
    const now = this.nowMono();
    const out = {};
    for (const [p, entry] of this.paths) {
      const winnerId = entry.shape === 'state' && entry.resolved ? entry.resolved.sourceId : null;
      let incumbent = null;
      for (const w of entry.writers.values()) {
        if (winnerId && w.sourceId === winnerId) incumbent = w;
      }
      const candidates = [...entry.writers.values()].map((w) => {
        const stale = this._isStale(entry, w, now);
        let status;
        if (w.released) status = 'released';
        else if (stale) status = 'stale';
        // EVENT writers never arbitrate — the STATE shadow vocabulary below
        // ("shadowed", "would win") would be a lie on an event path.
        else if (entry.shape === 'event') status = 'event_writer';
        else if (w.lastTypeRejectAt && now - w.lastTypeRejectAt < 5000) status = 'type_rejected';
        else if (w.sourceId === winnerId) status = 'winner';
        else if (incumbent && w.priority < incumbent.priority) {
          // The migration diff view: a live lower-priority candidate is what a
          // shadow looks like pre-cutover. Say whether a priority swap flips it.
          status = 'shadowed_by_higher_priority';
          const liveRivals = [...entry.writers.values()].filter((o) =>
            o !== w && o !== incumbent && !o.released && !this._isStale(entry, o, now));
          if (!liveRivals.some((o) => o.priority > incumbent.priority)) status = 'would_win_if_priority_ge_legacy';
        } else status = 'shadowed_by_higher_priority';
        return {
          source_id: w.sourceId,
          priority: w.priority,
          value: w.value,
          age_ms: Math.round(now - w.lastUpdateMono),
          stale,
          seq: w.lastSeq,
          boot_epoch: w.lastBootEpoch,
          seq_gaps: w.seqGaps,
          status,
        };
      });
      // 5 s sliding rate window
      const cutoff = now - 5000;
      entry.counters.window = entry.counters.window.filter((t) => t >= cutoff);
      out[p] = {
        shape: entry.shape,
        declared_type: entry.declaredType || null,
        stale_after_ms: entry.staleAfterMs,
        current_resolved_value: entry.shape === 'state'
          ? (entry.resolved ? entry.resolved.value : null)
          : undefined,
        resolved_holding_stale: entry.shape === 'state' && entry.resolved
          ? candidates.every((c) => c.stale || c.status === 'released')
          : false,
        writer_candidates: candidates,
        rate_hz: Math.round((entry.counters.window.length / 5) * 10) / 10,
        queue_depth: entry.shape === 'event' ? entry.queue.length : undefined,
        drops: entry.shape === 'event' ? entry.drops : undefined,
        packets: entry.counters.packets,
        rejected: { type: entry.counters.rejected_type, order: entry.counters.rejected_order },
        warned: { policy: entry.counters.policy_warns, range: entry.counters.range_warns },
        // Per-field enforcement truth values for the CURRENT phase — what is
        // actually checked vs deliberately skipped, displayed honestly.
        enforcement: {
          signature: 'SKIPPED (enforcement off)',
          type: entry.declaredType ? `CHECKED (${entry.declaredType})` : 'UNCHECKED (no declared type)',
          range: entry.range ? `CHECKED [${entry.range.min}, ${entry.range.max}] (WARN mode)` : 'UNCHECKED (no declared range)',
          policy: this._policyCheck ? 'CHECKED (WARN mode)' : 'SKIPPED (no policy loaded)',
          stale_mode: entry.staleAfterMs > 0 ? 'HOLD (flag only)' : 'NONE (no stale_after_ms declared)',
        },
      };
    }
    return out;
  }

  // `_meta.<path>.<field>` at 1 Hz, as ordinary bus signals — the inspector
  // (or any remote subscriber) needs no privileged API.
  _publishMeta() {
    const cutoff = this.nowMono() - 5000;
    for (const [p, entry] of this.paths) {
      if (p.startsWith('_meta.')) continue;
      const lastWriter = entry.shape === 'state' && entry.resolved ? entry.resolved.sourceId : '';
      let seqGaps = 0;
      for (const w of entry.writers.values()) seqGaps += w.seqGaps;
      // Prune the 5 s rate window here too — snapshot() used to be the only
      // pruner, so _meta rate_hz inflated whenever no inspector was polling.
      entry.counters.window = entry.counters.window.filter((t) => t >= cutoff);
      const fields = {
        rate_hz: entry.counters.window.length / 5,
        last_writer: lastWriter,
        seq_gaps: seqGaps,
      };
      if (entry.shape === 'event') {
        fields.queue_depth = entry.queue.length;
        fields.drops = entry.drops;
      }
      for (const [f, v] of Object.entries(fields)) {
        this.publishState(`_meta.${p}.${f}`, v, { sourceId: META_SOURCE, priority: 0 });
      }
    }
  }

  stop() {
    if (this._metaTimer) { clearInterval(this._metaTimer); this._metaTimer = null; }
  }
}

module.exports = { OrreryBus, toValue, fromValue, SCHEMA };
