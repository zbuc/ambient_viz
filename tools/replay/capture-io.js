// Load a phase-0 capture session (meta.json + events.jsonl) from disk.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Promoted goldens live gzipped in git (an hour of kiosk JSONL is ~100 MB raw,
// ~10x smaller compressed); live captures are plain. Read either.
function readEvents(dir) {
  const plain = path.join(dir, 'events.jsonl');
  if (fs.existsSync(plain)) return fs.readFileSync(plain, 'utf8');
  return zlib.gunzipSync(fs.readFileSync(plain + '.gz')).toString('utf8');
}

function loadSession(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const lines = readEvents(dir).split('\n');
  const events = [];
  let badLines = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { badLines += 1; }
  }
  events.sort((a, b) => a.seq - b.seq); // already in order; sort is a guard
  return { dir, meta, events, badLines };
}

// Newest session directory under a fixtures root (used to find the capture a
// just-finished bridge run produced).
function newestSession(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'meta.json')))
    .map((e) => e.name)
    .sort();
  if (!entries.length) throw new Error(`no capture sessions under ${root}`);
  return path.join(root, entries[entries.length - 1]);
}

function rawBytes(ev) {
  if (typeof ev.raw === 'string') return Buffer.from(ev.raw, 'utf8');
  if (typeof ev.raw_b64 === 'string') return Buffer.from(ev.raw_b64, 'base64');
  return null;
}

module.exports = { loadSession, newestSession, rawBytes };
