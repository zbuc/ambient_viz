#!/usr/bin/env node
// Phase-0 replay harness (MIGRATION_PLAN.md, Deliverable 2). Feeds a captured
// session's inputs — /ingest raw bodies and Daisy serial RX lines, in capture
// order, at capture pacing — into the UNMODIFIED legacy bridge, captures the
// replay run the same way phase 0 captured the original, and compares the two
// captures' outputs (SSE stream, serial TX, drop behavior) under the declared
// tolerances. All MATCH / EXPECTED_DIFFERENCE => the capture is replayable and
// the logs are a regression suite, not just evidence.
//
// Usage: node tools/replay/replay.js <golden-session-dir> [--speed N] [--settle-ms N] [--out DIR] [--quiet]
//
// NOTE: comparison gates are declared for --speed 1; rate caps and trigger
// state machines run on wall time, so scaled replays legitimately diverge.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const { spawnBridge } = require('./bridge-proc');
const { FakeDaisy } = require('./fake-daisy');
const { loadSession, newestSession, rawBytes } = require('./capture-io');
const { compare } = require('./comparator');
const tolerances = require('./tolerances');

function parseArgs(argv) {
  const args = { speed: 1, settleMs: 3000, out: null, quiet: false, dir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--speed') args.speed = parseFloat(argv[++i]);
    else if (a === '--settle-ms') args.settleMs = parseInt(argv[++i], 10);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (!args.dir) args.dir = a;
    else throw new Error(`unexpected arg: ${a}`);
  }
  if (!args.dir) throw new Error('usage: replay.js <golden-session-dir> [--speed N] [--settle-ms N] [--out DIR] [--quiet]');
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function postIngest(port, body) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/ingest', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve); // injection is paced, not retried; capture diff will surface loss
    req.end(body);
  });
}

// The input timeline: everything the bridge RECEIVED in the golden run, in
// capture order. ingest_drop bodies are re-injected too — the same bytes must
// drop the same way.
function inputTimeline(golden) {
  const t0 = golden.events.find((e) => e.kind === 'ingest' || e.kind === 'serial_rx');
  const inputs = [];
  for (const e of golden.events) {
    if (e.kind === 'ingest') {
      inputs.push({ t: e.t_mono_ms, kind: 'ingest', body: rawBytes(e) });
    } else if (e.kind === 'ingest_drop' && (e.reason === 'bad_json' || e.reason === 'payload_too_large')) {
      const b = rawBytes(e);
      if (b) inputs.push({ t: e.t_mono_ms, kind: 'ingest', body: b });
    } else if (e.kind === 'serial_rx') {
      inputs.push({ t: e.t_mono_ms, kind: 'serial_rx', line: e.raw });
    }
  }
  return { inputs, t0: t0 ? t0.t_mono_ms : (inputs[0] ? inputs[0].t : 0) };
}

// Trigger-shaping env from the golden capture, so the replayed bridge runs the
// same configuration the original did.
function goldenEnv(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta.env || {})) {
    if (/^(MOTION_|BELL_|TOLL_|VOICE_)/.test(k)) out[k] = v;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const golden = loadSession(path.resolve(args.dir));
  if (golden.badLines) console.warn(`warning: ${golden.badLines} unparseable lines in golden events.jsonl`);
  const { inputs, t0 } = inputTimeline(golden);
  if (!inputs.length) throw new Error('golden capture contains no replayable inputs (ingest/serial_rx)');

  const outRoot = path.resolve(args.out || path.join(golden.dir, 'replays'));
  fs.mkdirSync(outRoot, { recursive: true });

  const daisy = new FakeDaisy();
  await daisy.start();
  console.log(`replay: ${inputs.length} inputs over ${((inputs[inputs.length - 1].t - t0) / 1000).toFixed(1)}s (speed ${args.speed}x)`);

  const bridge = await spawnBridge({
    captureDir: outRoot,
    fakeDaisyPort: daisy.port,
    env: goldenEnv(golden.meta),
    quiet: args.quiet,
  });

  try {
    await daisy.waitForBridge();
    await sleep(300); // let the bridge finish its own startup capture events

    const start = Date.now();
    for (const input of inputs) {
      const due = start + (input.t - t0) / args.speed;
      const wait = due - Date.now();
      if (wait > 1) await sleep(wait);
      if (input.kind === 'ingest') await postIngest(bridge.port, input.body);
      else daisy.sendLine(input.line);
    }
    await sleep(args.settleMs);
  } finally {
    await bridge.stop();
    daisy.stop();
  }

  const replayDir = newestSession(outRoot);
  const replay = loadSession(replayDir);
  const report = compare(golden, replay, tolerances);
  report.speed = args.speed;
  if (args.speed !== 1) report.note = 'gates are declared for --speed 1; treat verdicts as advisory';

  const reportPath = path.join(replayDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('');
  for (const r of report.results) {
    console.log(`  ${r.verdict.padEnd(20)} ${r.id.padEnd(28)} ${r.detail}`);
  }
  console.log(`\nreplay verdict: ${report.overall}  (report: ${reportPath})`);
  process.exit(report.blocks ? 1 : 0);
}

main().catch((e) => { console.error(`replay: ${e.message}`); process.exit(2); });
