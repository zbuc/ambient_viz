// wavetable.js — Microwave II-style wavetable voice editor.
//
// Two wavetable oscillators (each scanning a Waldorf user-wave table with a
// graphical picker + live morph preview), a mixer with noise + ring mod, a
// multimode filter and two envelopes. The schema (shared/patch-schema.js,
// WT_PATCH) is the source of truth for the planned Rust `WtPatch`; there is no
// wavetable DSP yet, so "Audition" is a local WebAudio approximation.

import { WT_PATCH, defaultsFor, randomizeFor } from '../shared/patch-schema.js';
import { renderParams, el } from '../shared/ui.js';
import { saveText, saveDraft, loadDraft, loadText, listPresets, savePreset, deletePreset } from '../shared/storage.js';
import { createPreview } from '../shared/preview.js';
import { drawWave, drawWavetableThumb, wavetableAt, waveInfoAt } from './waveview.js';

const $ = (id) => document.getElementById(id);
const status = (m) => { $('status').textContent = m; };

let bank = null;                 // { wave_len, wavetables: [...] }
let patch = loadDraft('patch:wt') || defaultsFor(WT_PATCH);

const tableById = (id) => bank.wavetables.find((t) => t.id === id) || bank.wavetables[0];

// --- live preview (native patch_server, same as the FM/bass patch editor) ---
const preview = createPreview({ onStatus: onLive });
function onLive(online) {
  const pill = $('live');
  pill.textContent = online ? '● live' : 'preview offline';
  pill.className = 'pill ' + (online ? 'online' : 'offline');
  $('trigger').disabled = !online;
  if (online) preview.sendPatch('wt', patch); // sync server to editor state
}
$('live').onclick = () => { $('live').textContent = 'connecting…'; preview.probe(); };
$('trigger').onclick = () => preview.trigger('wt');
// Kill switch stays clickable even when offline.
$('stop').onclick = () => { preview.panic(); status('killed all audio'); };

// ---------------------------------------------------------------------------
// boot: load the wavetable bank, then build the UI
// ---------------------------------------------------------------------------
(async function boot() {
  try {
    bank = JSON.parse(await loadText('wavetables.json'));
  } catch (e) {
    status('failed to load wavetables.json — is the server serving static/?');
    return;
  }
  // Repair any draft that names a wavetable no longer in the bank.
  for (const n of [1, 2]) {
    const key = `osc${n}_wavetable`;
    if (!bank.wavetables.some((t) => t.id === patch[key])) patch[key] = bank.wavetables[0].id;
  }

  buildPresets();
  oscUI[1] = buildOscCard(1, $('osc1-card'));
  oscUI[2] = buildOscCard(2, $('osc2-card'));
  renderBody();
  refreshExport();
  requestAnimationFrame(redrawAll);
  status(`${bank.wavetables.length} wavetables loaded`);
})();

function onEdit() {
  saveDraft('patch:wt', patch);
  preview.sendPatch('wt', patch); // stream the edit to the live DSP (no-op if offline)
  refreshExport();
}

// ---------------------------------------------------------------------------
// oscillator card: wavetable picker (preview thumbnails) + morph display
// ---------------------------------------------------------------------------
const oscUI = {};

function buildOscCard(n, card) {
  card.innerHTML = '';
  const wtKey = `osc${n}_wavetable`;
  const posKey = `osc${n}_wave`;

  card.appendChild(el('h2', {}, `Oscillator ${n}`));

  // current (morphed) wave
  const mainCanvas = el('canvas', { class: 'wave-main' });
  card.appendChild(mainCanvas);
  const readoutL = el('span', {}, '');
  const readoutR = el('span', {}, '');
  card.appendChild(el('div', { class: 'wave-readout' }, [readoutL, readoutR]));

  // wavetable picker — one preview thumbnail per table
  const strip = el('div', { class: 'wt-strip' });
  const thumbs = {};
  for (const t of bank.wavetables) {
    const cv = el('canvas');
    const box = el('div', { class: 'wt-thumb', title: `${t.name} — ${t.waves.length} waves` }, [
      cv, el('div', { class: 'wt-name' }, t.name),
    ]);
    box.onclick = () => {
      patch[wtKey] = t.id;
      onEdit();
      redrawOsc(n);
    };
    thumbs[t.id] = { box, cv };
    strip.appendChild(box);
  }
  card.appendChild(strip);

  // wave-position slider (bespoke: a widget param, drawn here not by renderParams)
  const posParam = WT_PATCH.params.find((p) => p.key === posKey);
  const posReadout = el('span', { class: 'param-val' }, '');
  const posInput = el('input', {
    type: 'range', min: 0, max: 1, step: 0.001, value: patch[posKey],
    oninput: (e) => { patch[posKey] = parseFloat(e.target.value); onEdit(); redrawOsc(n); },
  });
  card.appendChild(el('label', { class: 'param-row', title: posParam.help }, [
    el('span', { class: 'param-label' }, posParam.label), posInput, posReadout,
  ]));

  // remaining osc params (transpose/detune/keytrack, + sync/fm on osc 2)
  const paramsBox = el('div', { class: 'osc-params' });
  card.appendChild(paramsBox);
  const oscParams = WT_PATCH.params
    .filter((p) => p.osc === n && !p.widget)
    .map((p) => ({ ...p, section: undefined })); // card title already labels the section
  renderParams({ params: oscParams }, patch, paramsBox, onEdit);

  return { mainCanvas, readoutL, readoutR, thumbs, posReadout, wtKey, posKey };
}

function redrawOsc(n) {
  const ui = oscUI[n];
  if (!ui) return;
  const table = tableById(patch[ui.wtKey]);
  const pos = patch[ui.posKey];

  // current morphed wave
  drawWave(ui.mainCanvas, wavetableAt(table, pos));
  const info = waveInfoAt(table, pos);
  ui.readoutL.textContent = table.name;
  ui.readoutR.textContent = `wave ${info.idx + 1}/${info.n} · UW${info.wave.n}`;
  ui.posReadout.textContent = pos.toFixed(2);

  // thumbnails: highlight selected table, draw its scan position
  for (const t of bank.wavetables) {
    const { box, cv } = ui.thumbs[t.id];
    const sel = t.id === patch[ui.wtKey];
    box.classList.toggle('sel', sel);
    drawWavetableThumb(cv, t, { pos: sel ? pos : null });
  }
}

// ---------------------------------------------------------------------------
// body params (mixer / filter / envelopes / voice)
// ---------------------------------------------------------------------------
function renderBody() {
  const bodyParams = WT_PATCH.params.filter((p) => !p.osc && !p.widget);
  renderParams({ params: bodyParams }, patch, $('body-params'), onEdit);
}

function redrawAll() {
  redrawOsc(1);
  redrawOsc(2);
}
window.addEventListener('resize', () => requestAnimationFrame(redrawAll));

// ---------------------------------------------------------------------------
// presets / reset
// ---------------------------------------------------------------------------
// Saved presets (server-backed); merged into the dropdown beside the built-ins.
let savedPresets = {};

async function buildPresets(selectName) {
  savedPresets = await listPresets('wt'); // {} if the server API isn't reachable
  const sel = $('preset');
  sel.innerHTML = '';
  const builtin = el('optgroup', { label: 'Built-in' });
  for (const name of Object.keys(WT_PATCH.presets)) {
    const o = new Option(name, name); o.dataset.src = 'builtin'; builtin.appendChild(o);
  }
  sel.appendChild(builtin);
  const savedNames = Object.keys(savedPresets);
  if (savedNames.length) {
    const saved = el('optgroup', { label: 'Saved' });
    for (const name of savedNames.sort()) {
      const o = new Option(name, name); o.dataset.src = 'saved'; saved.appendChild(o);
    }
    sel.appendChild(saved);
  }
  if (selectName) sel.value = selectName;
}

// Apply the selected preset, resolving built-in vs saved by the option's source.
$('preset').onchange = (e) => {
  const opt = e.target.selectedOptions[0];
  const name = e.target.value;
  const p = opt && opt.dataset.src === 'saved' ? savedPresets[name] : WT_PATCH.presets[name];
  if (p) { patch = { ...p }; rerenderAll(); status(`preset: ${name}`); }
};

$('save-preset').onclick = async () => {
  const raw = prompt('Save preset as (letters, digits, spaces, _ and -):', '');
  if (raw == null) return;
  const name = raw.trim();
  if (!name) { status('save cancelled — empty name'); return; }
  try {
    await savePreset('wt', name, patch);
    await buildPresets(name);
    status(`saved preset “${name}”`);
  } catch (e) {
    status('save failed: ' + e.message + ' (is the Node server running? `npm start` in server/)');
  }
};

$('del-preset').onclick = async () => {
  const opt = $('preset').selectedOptions[0];
  if (!opt || opt.dataset.src !== 'saved') { status('select a saved preset to delete'); return; }
  const name = opt.value;
  if (!confirm(`Delete saved preset “${name}”?`)) return;
  try { await deletePreset('wt', name); await buildPresets(); status(`deleted “${name}”`); }
  catch (e) { status('delete failed: ' + e.message); }
};
$('reset').onclick = () => { patch = defaultsFor(WT_PATCH); rerenderAll(); status('reset to default'); };
$('randomize').onclick = () => {
  patch = randomizeFor(WT_PATCH, { wavetableIds: bank.wavetables.map((t) => t.id) });
  rerenderAll();
  status('randomized');
};

function rerenderAll() {
  oscUI[1] = buildOscCard(1, $('osc1-card'));
  oscUI[2] = buildOscCard(2, $('osc2-card'));
  renderBody();
  onEdit();
  requestAnimationFrame(redrawAll);
}

// ---------------------------------------------------------------------------
// export (JSON is authoritative; Rust is a placeholder for the planned struct)
// ---------------------------------------------------------------------------
function toRust() {
  const lines = WT_PATCH.params.map((p) => {
    let v = patch[p.key];
    if (p.options || p.widget === 'wavetable') v = `"${v}"`;            // enums/ids as strings (struct TBD)
    else if (Number.isInteger(p.step) && p.step >= 1) v = String(Math.round(v));
    else v = Number(v).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
    return `    ${p.key}: ${v},`;
  });
  const header = [
    '// PLANNED — the Rust WtPatch struct does not exist yet.',
    '// Field names mirror shared/patch-schema.js (WT_PATCH); enums/wavetable ids',
    '// are emitted as strings. See BACKLOG.md "Waldorf wavetable osc".',
    '',
  ].join('\n');
  return `${header}WtPatch {\n${lines.join('\n')}\n}`;
}
function refreshExport() {
  $('export-out').value = $('export-fmt').value === 'rust'
    ? toRust()
    : JSON.stringify(patch, null, 2);
}
$('export-fmt').onchange = refreshExport;
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('export-out').value); status('copied'); }
  catch { status('copy failed — select + ⌘C'); }
};
$('download').onclick = () => {
  const rust = $('export-fmt').value === 'rust';
  saveText(`wt_patch.${rust ? 'rs.txt' : 'json'}`, $('export-out').value);
  status('downloaded');
};

// detect the native preview server and switch the pill to live
preview.probe();
