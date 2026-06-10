// Harness-side peer of serialport-shim.js: a TCP server standing in for the
// Daisy. Injects scripted/captured RX lines (POS/RESET) into the bridge and
// records every MIDI frame the bridge writes, in arrival order.

'use strict';

const net = require('net');
const { performance } = require('perf_hooks');

// 3-byte MIDI framing, same vocabulary the firmware decodes: status >= 0x80
// starts a frame, two data bytes follow. Unknown status bytes still frame as
// 3 bytes (only 0xB0 CC and 0x9x note-on exist in this system).
function decodeMidi(buf) {
  if (buf[0] >= 0xb0 && buf[0] <= 0xbf) return { type: 'cc', ch: buf[0] & 0x0f, cc: buf[1], value: buf[2] };
  if (buf[0] >= 0x90 && buf[0] <= 0x9f) return { type: 'note_on', ch: buf[0] & 0x0f, note: buf[1], vel: buf[2] };
  return { type: 'unknown', status: buf[0] };
}

class FakeDaisy {
  constructor() {
    this.port = null;
    this.tx = [];          // recorded frames from the bridge: {t_mono_ms, hex, decoded}
    this._sock = null;
    this._server = null;
    this._partial = Buffer.alloc(0);
    this._waiters = [];    // resolve() queue for waitForBridge
  }

  start() {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((sock) => {
        this._sock = sock;
        sock.on('data', (d) => this._onBytes(d));
        sock.on('error', () => { /* bridge side reopens; we just wait */ });
        sock.on('close', () => { if (this._sock === sock) this._sock = null; });
        for (const w of this._waiters.splice(0)) w();
      });
      this._server.on('error', reject);
      this._server.listen(0, '127.0.0.1', () => {
        this.port = this._server.address().port;
        resolve(this.port);
      });
    });
  }

  _onBytes(d) {
    let buf = Buffer.concat([this._partial, d]);
    let i = 0;
    // resync: skip anything before a status byte (never expected, but never wedge)
    while (i < buf.length && buf[i] < 0x80) i += 1;
    while (buf.length - i >= 3) {
      const frame = buf.subarray(i, i + 3);
      this.tx.push({
        t_mono_ms: Math.round(performance.now() * 1000) / 1000,
        hex: Buffer.from(frame).toString('hex'),
        decoded: decodeMidi(frame),
      });
      i += 3;
      while (i < buf.length && buf[i] < 0x80) i += 1;
    }
    this._partial = Buffer.from(buf.subarray(i));
  }

  waitForBridge(timeoutMs = 10000) {
    if (this._sock) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('bridge never opened the fake serial port')), timeoutMs);
      this._waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  sendLine(line) {
    if (!this._sock) return false;
    this._sock.write(line + '\n');
    return true;
  }

  stop() {
    if (this._sock) this._sock.destroy();
    if (this._server) this._server.close();
  }
}

module.exports = { FakeDaisy, decodeMidi };
