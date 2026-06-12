// Phase-4D transport-adapter binding (MIGRATION_PLAN.md): the consumer half
// of "the MIDI adapter consumes the *resolved* value".
//
// On every accepted STATE packet for `path`, hand the bus's arbitrated
// RESOLVED value to the sink. Same rule the router engine states (4C): a
// consumer reads the SIGNAL, never the packet's own payload — on a
// multi-writer path (legacy incumbent over the candidate graph) a shadowed
// candidate's write must not reach the physical output, and a low-priority
// keepalive must not drag it backward. Arrival still drives the sink, so its
// own dedupe/rate-cap discipline (writeCc) sees the same event cadence the
// legacy direct call produced.

'use strict';

function attachResolvedBinding({ bus, path, onResolved }) {
  const handler = (rec) => {
    if (!rec.accepted || !rec.pkt.state || rec.pkt.state.path !== path) return;
    const entry = bus.paths.get(path);
    if (!entry || !entry.resolved) return;
    const v = entry.resolved.value;
    // Rule-13 mirror at the hardware boundary: a non-finite resolved value
    // never becomes a CC frame.
    if (typeof v === 'number' && !Number.isFinite(v)) return;
    onResolved(v);
  };
  bus.on('packet', handler);
  return () => bus.off('packet', handler);
}

// Phase-6.1 EVENT-sink binding: the consumer half of "the adapter rebinds
// strike/speak". EVENTs interleave with no arbitration, so the sink reacts
// to every ACCEPTED event packet on `path`, in bus arrival order, payload
// as-is — ordering and dedupe are already the bus's (per-source seq +
// dedupe keys), and the packet stream is the same one /bus/events forwards.
// This consumer deliberately does NOT drain the path's queue: the plugin
// host's inspection ring remains the declared queue drainer, and a
// packet-reactive sink works whether or not anything drains.
function attachEventBinding({ bus, path, onEvent }) {
  const { fromValue } = require('./bus');
  const handler = (rec) => {
    if (!rec.accepted || !rec.pkt.event || rec.pkt.event.path !== path) return;
    onEvent(fromValue(rec.pkt.event.payload));
  };
  bus.on('packet', handler);
  return () => bus.off('packet', handler);
}

module.exports = { attachResolvedBinding, attachEventBinding };
