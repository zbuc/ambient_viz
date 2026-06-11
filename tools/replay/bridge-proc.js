// Spawns the legacy bridge as a child process for capture/replay runs.
// The bridge code is untouched; everything install-specific arrives via env.

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BRIDGE_ENTRY = path.join(REPO_ROOT, 'server', 'src', 'index.js');
const SHIM = path.join(__dirname, 'serialport-shim.js');

// Env keys that shape bridge behavior — scrubbed from the inherited shell env
// so a run is controlled entirely by what the caller passes in.
const SCRUB = /^(PORT|HOST|MOCK|DAISY|CAPTURE|INGEST_TOKEN|MOTION_|BELL_|TOLL_|VOICE_|REPLAY_SERIAL_PORT|TAPE_CC)/;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function waitHttp(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('bridge HTTP never came up'));
        else setTimeout(poll, 100);
      });
      req.on('timeout', () => req.destroy());
    };
    poll();
  });
}

// opts: { captureDir, fakeDaisyPort, env: {extra overrides}, quiet }
async function spawnBridge(opts = {}) {
  const port = await getFreePort();
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SCRUB.test(k)) env[k] = v;
  }
  Object.assign(env, {
    PORT: String(port),
    HOST: '127.0.0.1',
    DAISY: '1',
    DAISY_SERIAL: 'replay-fake-daisy', // any truthy path; the shim ignores it
    NODE_OPTIONS: `${env.NODE_OPTIONS || ''} --require ${SHIM}`.trim(),
    REPLAY_SERIAL_PORT: String(opts.fakeDaisyPort),
  }, opts.captureDir ? { CAPTURE_DIR: opts.captureDir } : {}, opts.env || {});

  const proc = spawn(process.execPath, [BRIDGE_ENTRY], {
    env,
    cwd: path.join(REPO_ROOT, 'server'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = opts.quiet ? null : '[bridge] ';
  proc.stdout.on('data', (d) => { if (prefix) process.stderr.write(prefix + d.toString().trimEnd().replace(/\n/g, `\n${prefix}`) + '\n'); });
  proc.stderr.on('data', (d) => { if (prefix) process.stderr.write(prefix + d.toString().trimEnd().replace(/\n/g, `\n${prefix}`) + '\n'); });

  await waitHttp(port);

  const stop = () => new Promise((resolve) => {
    if (proc.exitCode !== null) { resolve(proc.exitCode); return; }
    proc.on('exit', (code) => resolve(code));
    proc.kill('SIGTERM'); // capture finalizes + flushes on SIGTERM
    setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 5000).unref();
  });

  return { proc, port, stop };
}

module.exports = { spawnBridge, getFreePort };
