// sequencer.js — drum-grid + chord-prog editor.
//
// Talks only to the in-memory Pattern object; all .pat parsing/serializing
// lives in shared/patfile.js (the format boundary that MIDI will replace).

import { parsePat, serializePat, emptyPattern, DRUM_LANES } from '../shared/patfile.js';
import { loadText, saveText, openFile, saveDraft, loadDraft } from '../shared/storage.js';

const SAMPLE_URL = '../../20251006_arrangement_1.pat';
const DRAFT_KEY = 'sequencer';

// Lanes shown as toggle grids. `bass`/`stabtone` are tie/value lanes that need
// their own editors — scaffolded as drum-style for now (TODO before MIDI swap).
const GRID_LANES = [...DRUM_LANES];

let pattern = loadDraft(DRAFT_KEY) || emptyPattern();

const $ = (id) => document.getElementById(id);
const status = (msg, isErr = false) => {
  const s = $('status');
  s.textContent = msg;
  s.className = isErr ? 'err' : '';
};

function autosave() { saveDraft(DRAFT_KEY, pattern); }

// --- meta fields ---------------------------------------------------------
function syncMeta() {
  $('m-name').value = pattern.name;
  $('m-key').value = pattern.key;
  $('m-octave').value = pattern.octave;
  $('m-steps').value = pattern.steps;
  $('m-res').value = pattern.res;
  $('m-prog').value = pattern.prog.join(' ');
  $('m-bassprog').value = pattern.bassprog.join(' ');
}
$('m-name').oninput = (e) => { pattern.name = e.target.value; autosave(); };
$('m-key').oninput = (e) => { pattern.key = e.target.value; autosave(); };
$('m-octave').oninput = (e) => { pattern.octave = parseInt(e.target.value, 10) || 0; autosave(); };
$('m-res').oninput = (e) => { pattern.res = parseInt(e.target.value, 10) || 16; renderGrid(); autosave(); };
$('m-prog').oninput = (e) => { pattern.prog = tokens(e.target.value); autosave(); };
$('m-bassprog').oninput = (e) => { pattern.bassprog = tokens(e.target.value); autosave(); };
const tokens = (s) => s.trim().split(/\s+/).filter(Boolean);

// --- grid ----------------------------------------------------------------
// Cell click cycles velocity: off → full → soft → off.
function cycle(v) {
  if (v <= 0.0001) return 1.0;
  if (v >= 0.999) return 0.7;
  return 0.0;
}
function cellClass(v) {
  if (v >= 0.999) return 'cell on';
  if (v > 0.0001) return 'cell soft';
  return 'cell';
}

function renderGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  for (const lane of GRID_LANES) {
    let row = pattern.drums[lane];
    if (!row || row.length !== pattern.steps) {
      row = new Array(pattern.steps).fill(0);
      pattern.drums[lane] = row;
    }
    const rowEl = document.createElement('div');
    rowEl.className = 'grid-row';
    rowEl.appendChild(Object.assign(document.createElement('span'), { className: 'lane-name', textContent: lane }));
    for (let i = 0; i < pattern.steps; i++) {
      const cell = document.createElement('div');
      cell.className = cellClass(row[i]) + (i % pattern.res === 0 ? ' bar-start' : '');
      cell.title = `${lane} step ${i + 1}`;
      cell.onclick = () => {
        row[i] = cycle(row[i]);
        cell.className = cellClass(row[i]) + (i % pattern.res === 0 ? ' bar-start' : '');
        autosave();
      };
      rowEl.appendChild(cell);
    }
    grid.appendChild(rowEl);
  }
}

// --- load / save ---------------------------------------------------------
function adopt(p) { pattern = p; syncMeta(); renderGrid(); autosave(); }

$('load-default').onclick = async () => {
  try { adopt(parsePat(await loadText(SAMPLE_URL))); status('loaded sample .pat'); }
  catch (e) { status(String(e.message || e), true); }
};
$('open').onclick = async () => {
  try {
    const { name, text } = await openFile('.pat,text/plain');
    adopt(parsePat(text)); status(`loaded ${name}`);
  } catch (e) { status(String(e.message || e), true); }
};
$('new').onclick = () => { adopt(emptyPattern()); status('new pattern'); };
$('save').onclick = () => {
  try {
    const text = serializePat(pattern);
    const fname = (pattern.name || 'pattern').replace(/\s+/g, '_') + '.pat';
    saveText(fname, text);
    status(`downloaded ${fname}`);
  } catch (e) { status(String(e.message || e), true); }
};

// --- boot ----------------------------------------------------------------
syncMeta();
renderGrid();
status(loadDraft(DRAFT_KEY) ? 'restored draft' : 'empty — load a .pat to start');
