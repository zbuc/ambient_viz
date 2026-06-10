// Load a phase-0 capture session (meta.json + events.jsonl) from disk.

'use strict';

const fs = require('fs');
const path = require('path');

function loadSession(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n');
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
