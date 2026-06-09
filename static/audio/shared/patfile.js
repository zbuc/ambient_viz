// patfile.js — parse + serialize the `.pat` drum-grid format.
//
// THIS IS THE FORMAT BOUNDARY. Every other module in static/audio/ speaks the
// in-memory `Pattern` object defined below and knows nothing about `.pat`
// syntax. When the format migrates to MIDI, replace ONLY this file with a
// midifile.js that parses/serializes to the same `Pattern` shape — the
// sequencer UI does not change.
//
// Mirrors the Rust parser in daisy/crates/dsp/src/sequencer.rs (parse_grid).
// Keep the two in sync; the Rust side is the source of truth for what the DSP
// will actually accept.

/**
 * @typedef {Object} Pattern
 * @property {string}   name
 * @property {number}   steps            total step count (must match every lane)
 * @property {number}   res              note division (8 = 8ths, 16 = 16ths); multiple of 4
 * @property {string}   key              e.g. "D minor"
 * @property {number}   octave           base octave for named/roman chords
 * @property {Object<string, number[]>} drums   kick/chat/ohat/stab → velocity 0..1 per step
 * @property {number[]} stabtone         per-step tone 0..1, or -1 for "none" (empty array = all pristine)
 * @property {BassCell[]} bass           per-step bass cell (empty array = no bass row)
 * @property {string[]} prog             chord tokens, one consumed per stab hit
 * @property {string[]} bassprog         chord tokens for bass; empty = ride `prog`
 */

/** @typedef {{kind:'strike', vel:number} | {kind:'hold'} | {kind:'rest'}} BassCell */

export const DRUM_LANES = ['kick', 'chat', 'ohat', 'stab'];
export const MAX_GRID_STEPS = 256; // keep aligned with dsp MAX_GRID_STEPS if it changes

/** Velocity cell char → 0..1 (drum/stab rows). Returns null for "not a cell". */
function drumCell(ch) {
  if (ch === 'X') return 1.0;
  if (ch === 'x') return 0.7;
  if (ch === '.' || ch === '-') return 0.0;
  if (ch >= '0' && ch <= '9') return (ch.charCodeAt(0) - 48) / 9;
  return null; // whitespace, |, ,, and anything else: ignored
}

/** @returns {BassCell|null} */
function bassCell(ch) {
  if (ch === 'X') return { kind: 'strike', vel: 1.0 };
  if (ch === 'x') return { kind: 'strike', vel: 0.7 };
  if (ch >= '0' && ch <= '9') return { kind: 'strike', vel: (ch.charCodeAt(0) - 48) / 9 };
  if (ch === '_') return { kind: 'hold' };
  if (ch === '.' || ch === '-') return { kind: 'rest' };
  return null; // whitespace / | / , : ignored
}

/** stabtone digit → 0..1, '.'/'-' → -1 (none), else null (ignore). */
function toneCell(ch) {
  if (ch >= '0' && ch <= '9') return (ch.charCodeAt(0) - 48) / 9;
  if (ch === '.' || ch === '-') return -1;
  return null;
}

/** Split a prog/bassprog row into chord tokens, dropping visual filler. */
function tokenizeProg(rest) {
  return rest
    .split(/[\s|,]+/)
    .filter((t) => t && t !== '.' && t !== '-');
}

/**
 * Parse `.pat` text into a Pattern. Throws Error on the same conditions the
 * Rust parser rejects (missing steps:, length mismatch, etc.).
 * @param {string} text
 * @returns {Pattern}
 */
export function parsePat(text) {
  /** @type {Pattern} */
  const p = {
    name: '',
    steps: 0,
    res: 8,
    key: 'C minor',
    octave: 3,
    drums: { kick: [], chat: [], ohat: [], stab: [] },
    stabtone: [],
    bass: [],
    prog: [],
    bassprog: [],
  };
  let gotSteps = false;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const header = (k) => (line.startsWith(k) ? line.slice(k.length).trim() : null);

    let v;
    if ((v = header('name:')) !== null) { p.name = v; continue; }
    if ((v = header('steps:')) !== null) {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n)) throw new Error('BadHeader: steps:');
      p.steps = n; gotSteps = true; continue;
    }
    if ((v = header('res:')) !== null) {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0 || n % 4 !== 0) throw new Error('BadRes: res must be a positive multiple of 4');
      p.res = n; continue;
    }
    if ((v = header('key:')) !== null) { p.key = v; continue; }
    if ((v = header('octave:')) !== null) {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n)) throw new Error('BadHeader: octave:');
      p.octave = n; continue;
    }
    // bassprog: before prog: so the longer key wins.
    if ((v = header('bassprog:')) !== null) { p.bassprog = tokenizeProg(v); continue; }
    if ((v = header('prog:')) !== null) { p.prog = tokenizeProg(v); continue; }

    if ((v = header('bass:')) !== null) {
      for (const ch of v) { const c = bassCell(ch); if (c) p.bass.push(c); }
      continue;
    }
    if ((v = header('stabtone:')) !== null) {
      for (const ch of v) { const c = toneCell(ch); if (c !== null) p.stabtone.push(c); }
      continue;
    }
    // Drum/stab velocity rows.
    let matched = false;
    for (const lane of DRUM_LANES) {
      if ((v = header(lane + ':')) !== null) {
        for (const ch of v) { const c = drumCell(ch); if (c !== null) p.drums[lane].push(c); }
        matched = true; break;
      }
    }
    if (matched) continue;
    // Unknown header — ignore (forward-compatible with new lanes).
  }

  if (!gotSteps) throw new Error('BadHeader: steps: required');
  if (p.steps <= 0 || p.steps > MAX_GRID_STEPS) {
    throw new Error(`WrongStepCount: steps=${p.steps} (max ${MAX_GRID_STEPS})`);
  }
  for (const lane of DRUM_LANES) {
    const len = p.drums[lane].length;
    if (len && len !== p.steps) throw new Error(`VoiceLengthMismatch: ${lane} has ${len}, expected ${p.steps}`);
  }
  if (p.bass.length && p.bass.length !== p.steps) {
    throw new Error(`VoiceLengthMismatch: bass has ${p.bass.length}, expected ${p.steps}`);
  }
  if (p.stabtone.length && p.stabtone.length !== p.steps) {
    throw new Error(`VoiceLengthMismatch: stabtone has ${p.stabtone.length}, expected ${p.steps}`);
  }
  return p;
}

/** velocity 0..1 → display char. */
function drumChar(v) {
  if (v >= 0.999) return 'X';
  if (v <= 0.0001) return '.';
  if (Math.abs(v - 0.7) < 0.01) return 'x';
  return String(Math.round(v * 9));
}
function bassChar(c) {
  if (c.kind === 'hold') return '_';
  if (c.kind === 'rest') return '.';
  return drumChar(c.vel); // strike
}
function toneChar(v) {
  return v < 0 ? '.' : String(Math.round(v * 9));
}

/** Group a per-step char array into `| `-separated bars of `res` cells. */
function groupRow(chars, res) {
  const out = [];
  for (let i = 0; i < chars.length; i += res) {
    out.push(chars.slice(i, i + res).join(' '));
  }
  return out.join(' | ');
}

/**
 * Serialize a Pattern back to `.pat` text. Output is re-parseable by parsePat
 * and by the Rust parser; it does not byte-match the hand-authored source.
 * @param {Pattern} p
 * @returns {string}
 */
export function serializePat(p) {
  const res = p.res || 8;
  const lines = [];
  if (p.name) lines.push(`name: ${p.name}`);
  lines.push(`steps: ${p.steps}`);
  lines.push(`res: ${res}`);
  if (p.key) lines.push(`key: ${p.key}`);
  if (p.octave !== undefined && p.octave !== null) lines.push(`octave: ${p.octave}`);

  for (const lane of DRUM_LANES) {
    const row = p.drums[lane];
    if (row && row.length) lines.push(`${lane}: ${groupRow(row.map(drumChar), res)}`);
  }
  if (p.stabtone.length) lines.push(`stabtone: ${groupRow(p.stabtone.map(toneChar), res)}`);
  if (p.prog.length) lines.push(`prog: ${p.prog.join(' ')}`);
  if (p.bass.length) lines.push(`bass: ${groupRow(p.bass.map(bassChar), res)}`);
  if (p.bassprog.length) lines.push(`bassprog: ${p.bassprog.join(' ')}`);

  return lines.join('\n') + '\n';
}

/** A fresh empty pattern of the given size (defaults match the Rust parser). */
export function emptyPattern(steps = 64, res = 16) {
  const zeros = () => new Array(steps).fill(0);
  return {
    name: 'untitled',
    steps, res,
    key: 'C minor',
    octave: 3,
    drums: { kick: zeros(), chat: zeros(), ohat: zeros(), stab: zeros() },
    stabtone: [],
    bass: [],
    prog: [],
    bassprog: [],
  };
}
