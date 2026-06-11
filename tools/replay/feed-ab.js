#!/usr/bin/env node
// Phase-2 feed A/B (MIGRATION_PLAN.md): consumes BOTH browser feeds from a
// running bridge — legacy /events and bus-over-SSE /bus/events — derives the
// AMBIENT_INPUTS object from each exactly like the kiosk page does, and
// compares them continuously.
//
// RETIRED 2026-06-11: the phase-2 cutover gate passed (mechanical
// full-session run over the replayed cutover golden + the accepted live
// gate session) and the cleanup PR deleted the page's legacy reader + the
// `feed` flag. Both server endpoints still exist until phase 9, so this
// tool still runs for forensics; "legacy" below now means the /events
// stream itself, not anything the page consumes. This is the cutover gate tool: run it against a
// full kiosk session; all keys must verdict MATCH (transient transport skew
// between the two SSE streams is measured and declared, persistent divergence
// is a REGRESSION, an unmapped legacy key is UNKNOWN and blocks).
//
// Usage: node tools/replay/feed-ab.js [--url http://127.0.0.1:8080] [--duration-s 30]

'use strict';

const http = require('http');

const SAMPLE_MS = 500;
const PERSIST_LIMIT = 3; // consecutive disagreeing samples (1.5 s) = persistent

function parseArgs(argv) {
  const a = { url: 'http://127.0.0.1:8080', durationS: 30 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--url') a.url = argv[++i];
    else if (argv[i] === '--duration-s') a.durationS = parseFloat(argv[++i]);
    else throw new Error(`unexpected arg ${argv[i]}`);
  }
  return a;
}

// Minimal SSE client: calls onEvent(name, dataString).
function sse(url, onEvent) {
  const req = http.get(url, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) onEvent(event, data);
      }
    });
  });
  req.on('error', (e) => { console.error(`sse ${url}: ${e.message}`); process.exit(2); });
  return req;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const fromValue = (val) => {
  if (!val || typeof val !== 'object') return undefined;
  if ('number' in val) return val.number;
  if ('integer' in val) return val.integer;
  if ('boolean' in val) return val.boolean;
  if ('text' in val) return val.text;
  if ('vec' in val) return val.vec && val.vec.elems;
  return undefined;
};

async function main() {
  const args = parseArgs(process.argv);
  const { map, touch } = await fetchJson(`${args.url}/bus/map`);
  const pathToLegacy = {};
  for (const [legacy, m] of Object.entries(map)) pathToLegacy[m.path] = legacy;
  const touchBit = {};
  touch.paths.forEach((p, i) => { touchBit[p] = i; });

  const legacyState = Object.create(null);
  const busState = Object.create(null);
  const unmappedLegacy = new Set(); // legacy names with no bus path = UNKNOWN
  let touchMask = 0;

  sse(`${args.url}/events`, (event, data) => {
    if (event !== 'change') return;
    try {
      const { name, value } = JSON.parse(data);
      legacyState[name] = value;
      if (name !== 'touch_mask' && !(name in map)) unmappedLegacy.add(name);
    } catch { /* */ }
  });
  sse(`${args.url}/bus/events`, (event, data) => {
    if (event !== 'packet' && event !== 'retained') return;
    try {
      const pkt = JSON.parse(data);
      const st = pkt.state;
      if (!st || !st.path) return;
      // Mirror the kiosk page exactly: state reads through arbitration —
      // live frames carry `pkt.resolved`; payload only as pre-fix fallback.
      const v = ('resolved' in pkt) ? fromValue(pkt.resolved) : fromValue(st.value);
      if (st.path in touchBit) {
        if (v) touchMask |= 1 << touchBit[st.path];
        else touchMask &= ~(1 << touchBit[st.path]);
        busState.touch_mask = touchMask;
        return;
      }
      const legacy = pathToLegacy[st.path];
      if (legacy) busState[legacy] = v;
    } catch { /* */ }
  });

  // keyed stats: samples, agree, races (transient skew), consecutive, persistMax
  const stats = new Map();
  const sample = () => {
    for (const k of new Set([...Object.keys(legacyState), ...Object.keys(busState)])) {
      let s = stats.get(k);
      if (!s) { s = { samples: 0, agree: 0, filledBlank: 0, consecutive: 0, persistMax: 0 }; stats.set(k, s); }
      s.samples += 1;
      const a = legacyState[k];
      const b = busState[k];
      if (JSON.stringify(a) === JSON.stringify(b)) {
        s.agree += 1;
        s.consecutive = 0;
      } else if (a === undefined && b !== undefined) {
        // The DECLARED improvement class (phase 2 reload retention + the 4C
        // standing defaults writer): the bus resolves a value where legacy
        // has shown nothing yet — near/far hold the idle-priority defaults
        // until the sidecar's first claim, retained state survives where
        // legacy blanks. Absent ≠ wrong here; the fill is the point.
        s.filledBlank += 1;
        s.consecutive = 0;
      } else {
        s.consecutive += 1;
        s.persistMax = Math.max(s.persistMax, s.consecutive);
        s.lastDiff = { legacy: a, bus: b };
      }
    }
  };

  console.log(`feed-ab: sampling both feeds at ${args.url} for ${args.durationS}s …`);
  const timer = setInterval(sample, SAMPLE_MS);
  await new Promise((r) => setTimeout(r, args.durationS * 1000));
  clearInterval(timer);

  let overall = 'MATCH';
  const worst = (v) => {
    const rank = { MATCH: 0, EXPECTED_DIFFERENCE: 1, UNKNOWN: 2, REGRESSION: 3 };
    if (rank[v] > rank[overall]) overall = v;
  };
  console.log('');
  for (const [k, s] of [...stats.entries()].sort()) {
    let verdict;
    let note;
    const races = s.samples - s.agree - s.filledBlank;
    if (unmappedLegacy.has(k)) {
      verdict = 'UNKNOWN';
      note = 'legacy signal with no bus mapping';
    } else if (s.persistMax >= PERSIST_LIMIT) {
      verdict = 'REGRESSION';
      note = `diverged for ${s.persistMax} consecutive samples; last: legacy=${JSON.stringify(s.lastDiff.legacy)} bus=${JSON.stringify(s.lastDiff.bus)}`;
    } else if (races > 0) {
      verdict = 'EXPECTED_DIFFERENCE';
      note = `${races}/${s.samples} samples mid-flight (two SSE streams, declared transport skew)`;
    } else if (s.filledBlank > 0) {
      verdict = 'EXPECTED_DIFFERENCE';
      note = `${s.filledBlank}/${s.samples} samples bus-resolved while legacy blank (declared: defaults writer / retention)`;
    } else {
      verdict = 'MATCH';
      note = `${s.agree}/${s.samples} samples`;
    }
    worst(verdict);
    console.log(`  ${verdict.padEnd(20)} ${k.padEnd(26)} ${note}`);
  }
  console.log(`\nfeed-ab verdict: ${overall}`);
  process.exit(overall === 'MATCH' || overall === 'EXPECTED_DIFFERENCE' ? 0 : 1);
}

main().catch((e) => { console.error(`feed-ab: ${e.message}`); process.exit(2); });
