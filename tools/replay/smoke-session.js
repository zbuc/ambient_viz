#!/usr/bin/env node
// Phase-0 smoke session: drives a short, scripted, deterministic "visit"
// through a live capture-enabled bridge (fake Daisy on the serial side), so
// the capture -> replay loop can be exercised end to end without the kiosk:
//
//   arrival approach -> entry bell, CC23 failure ramp
//   dwell + freeze pulse -> CC24
//   leave -> exit voice
//   plus one malformed /ingest body -> ingest_drop(bad_json)
//
// Stochastic legacy behaviors are configured OFF (industrial roll, toll,
// murmur) so the deterministic gates do the talking. The voice phrase note
// stays random — the comparator declares it EXPECTED/ignored, which this
// smoke test therefore also exercises.
//
// Usage: node tools/replay/smoke-session.js [--out DIR]
// Prints the golden session dir on completion; replay it with replay.js.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const { spawnBridge } = require('./bridge-proc');
const { FakeDaisy } = require('./fake-daisy');
const { newestSession } = require('./capture-io');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(port, pathName, body) {
  return new Promise((resolve) => {
    const buf = Buffer.from(body, 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, path: pathName, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end(buf);
  });
}

// Scripted distance trajectory (cm) over the ~20 s session. far=130/near=75:
// empty >= 119.6, enter <= 110.5 (bell), occupancy hysteresis between them.
function distanceAt(tS) {
  if (tS < 4) return 128;                       // empty room; bell arms at 2.5 s
  if (tS < 8.5) return Math.max(55, 120 - (tS - 4) * 15); // approach at -15 cm/s
  if (tS < 12.5) return 55;                     // dwell at the kiosk
  if (tS < 15) return Math.min(128, 55 + (tS - 12.5) * 30); // leave at +30 cm/s
  return 128;                                   // empty again; voice confirms
}

function velocityAt(tS) {
  if (tS < 4) return 0;
  if (tS < 8.5) return distanceAt(tS) > 55 ? -15 : 0;
  if (tS < 12.5) return 0;
  if (tS < 15) return distanceAt(tS) < 128 ? 30 : 0;
  return 0;
}

async function main() {
  const outArg = process.argv.indexOf('--out');
  const outRoot = path.resolve(outArg > -1 ? process.argv[outArg + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'pm-smoke-')));
  fs.mkdirSync(outRoot, { recursive: true });

  const daisy = new FakeDaisy();
  await daisy.start();

  const bridge = await spawnBridge({
    captureDir: outRoot,
    fakeDaisyPort: daisy.port,
    env: {
      CAPTURE: '1',
      BELL_INDUSTRIAL_PROB: '0', // deterministic timbre
      TOLL_MIN_S: '9999',        // no stochastic toll inside the smoke window
      TOLL_MAX_S: '9999',
      VOICE_TOLL: '0',           // no stochastic murmur
    },
  });

  try {
    await daisy.waitForBridge();
    await sleep(300);

    const DURATION_S = 20;
    const start = Date.now();
    const elapsed = () => (Date.now() - start) / 1000;

    // Daisy POS at 20 Hz, like the firmware.
    const posTimer = setInterval(() => {
      daisy.sendLine(`POS ${(elapsed() % 60).toFixed(3)}`);
    }, 50);

    // Sensor config first, like the sidecar does.
    await post(bridge.port, '/ingest', JSON.stringify([
      { name: 'distance_near_cm', value: 75 },
      { name: 'distance_far_cm', value: 130 },
    ]));

    let badJsonSent = false;
    let freezeOnSent = false;
    let freezeOffSent = false;
    while (elapsed() < DURATION_S) {
      const tS = elapsed();
      await post(bridge.port, '/ingest', JSON.stringify([
        { name: 'distance_cm', value: Math.round(distanceAt(tS) * 10) / 10 },
        { name: 'distance_velocity_cm_s', value: velocityAt(tS) },
      ]));
      if (tS >= 2 && !badJsonSent) { badJsonSent = true; await post(bridge.port, '/ingest', 'not json {{{'); }
      if (tS >= 9 && !freezeOnSent) { freezeOnSent = true; await post(bridge.port, '/ingest', JSON.stringify({ name: 'freeze', value: 0.6 })); }
      if (tS >= 11 && !freezeOffSent) { freezeOffSent = true; await post(bridge.port, '/ingest', JSON.stringify({ name: 'freeze', value: 0 })); }
      await sleep(100); // 10 Hz fresh samples
    }

    clearInterval(posTimer);
    await sleep(3000); // let the exit voice confirm-empty window land
  } finally {
    await bridge.stop();
    daisy.stop();
  }

  const goldenDir = newestSession(outRoot);
  const noteEvents = daisy.tx.filter((t) => t.decoded.type === 'note_on');
  console.log(`smoke: fake daisy saw ${daisy.tx.length} MIDI frames (${noteEvents.length} note-on)`);
  console.log(goldenDir);
}

main().catch((e) => { console.error(`smoke-session: ${e.message}`); process.exit(2); });
