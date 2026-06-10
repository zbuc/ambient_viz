// Replay-harness serial shim (phase 0, MIGRATION_PLAN.md).
//
// Loaded into the UNMODIFIED legacy bridge via `node --require` so that
// require('serialport') resolves to a fake whose far end is the harness's
// fake-daisy TCP server instead of a tty. The bridge's daisy-position.js runs
// byte-for-byte unchanged — strangler-fig means the harness adapts, not the
// legacy code.
//
// Active only when REPLAY_SERIAL_PORT is set (the fake-daisy server's port on
// 127.0.0.1); otherwise the real serialport module loads as usual.

'use strict';

const Module = require('module');
const net = require('net');
const { Duplex, Transform } = require('stream');

const REPLAY_PORT = parseInt(process.env.REPLAY_SERIAL_PORT || '', 10);

if (Number.isFinite(REPLAY_PORT)) {
  class FakeSerialPort extends Duplex {
    constructor(opts, cb) {
      super();
      this.path = opts && opts.path;
      this.isOpen = false;
      this._sock = net.connect(REPLAY_PORT, '127.0.0.1');
      this._sock.on('connect', () => {
        this.isOpen = true;
        if (cb) cb(null);
        this.emit('open');
      });
      this._sock.on('data', (d) => this.push(d));
      this._sock.on('error', (e) => {
        if (!this.isOpen) { if (cb) cb(e); return; } // open failure -> ctor callback
        this.isOpen = false;
        this.emit('error', e);
      });
      this._sock.on('close', () => {
        if (this.isOpen) { this.isOpen = false; this.emit('close'); }
      });
    }
    _read() { /* push-driven from the socket */ }
    _write(chunk, _enc, cb) { this._sock.write(chunk, cb); }
    set(_opts, cb) { if (cb) process.nextTick(cb); }
    close(cb) {
      this.isOpen = false;
      this._sock.destroy();
      if (cb) process.nextTick(cb);
    }
  }

  // Just enough ReadlineParser for `port.pipe(parser).on('data', line => ...)`.
  class FakeReadlineParser extends Transform {
    constructor(opts) {
      super({ readableObjectMode: true });
      this._delim = (opts && opts.delimiter) || '\n';
      this._buf = '';
    }
    _transform(chunk, _enc, cb) {
      this._buf += chunk.toString('utf8');
      const parts = this._buf.split(this._delim);
      this._buf = parts.pop();
      for (const p of parts) this.push(p);
      cb();
    }
  }

  const fakeModule = { SerialPort: FakeSerialPort, ReadlineParser: FakeReadlineParser };

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'serialport') return fakeModule;
    return origLoad.call(this, request, parent, isMain);
  };
}
