// instruments.js — combined editor: source PATCH + insert FX chain + the
// composite INSTRUMENT (patch + chain) bundle, each with savable presets.
//
//   Patch  : FM-stab / rumble-bass params. Streams to the native patch_server;
//            patch presets save to the node server (static/audio/presets/{fm,bass}).
//   FX     : an ordered insert chain over the summed instrument, edited live
//            against patch_server (host::fx). FX presets live on patch_server
//            (static/audio/presets/fx).
//   Instr. : the whole bundle (fm + bass + wt + fx) saved/loaded via
//            patch_server (static/audio/presets/instrument).
//
// The FX + instrument sections need the preview server (real DSP); patch
// editing/export works offline. See daisy/PATCH_SERVER.md.

import { PATCH_TYPES, defaultsFor, randomizeFor } from '../shared/patch-schema.js';
import { renderParams, sliderRow, el } from '../shared/ui.js';
import { saveText, saveDraft, loadDraft, listPresets, savePreset, deletePreset } from '../shared/storage.js';
import { createPreview } from '../shared/preview.js';

const $ = (id) => document.getElementById(id);
const status = (m) => { $('status').textContent = m; };

let schema = PATCH_TYPES[0];
let patch = loadDraft(`patch:${schema.id}`) || defaultsFor(schema);
let savedPatchPresets = {}; // node-server presets for the current voice
let fxCatalog = null;       // [{kind, params:[{name,default,min,max}]}]

// --- live preview (native patch_server) ----------------------------------
const preview = createPreview({ onStatus: onLive });

function onLive(online) {
  const pill = $('live');
  pill.textContent = online ? '● live' : 'preview offline';
  pill.className = 'pill ' + (online ? 'online' : 'offline');
  // FX + instrument need the DSP server; patch editing/export works offline.
  const liveOnly = ['trigger', 'fx-add', 'fx-add-kind', 'fx-add', 'fx-preset',
    'fx-preset-save', 'fx-preset-del', 'inst-preset', 'inst-load', 'inst-del', 'inst-save'];
  for (const id of liveOnly) $(id).disabled = !online;
  if (online) {
    preview.sendPatch(schema.id, patch); // sync server to editor state
    initLive();
  } else {
    renderFxOffline();
  }
}
$('live').onclick = () => { $('live').textContent = 'connecting…'; preview.probe(); };
$('trigger').onclick = () => preview.trigger(schema.id);
$('stop').onclick = () => { preview.panic(); status('killed all audio'); };

// ── PATCH ────────────────────────────────────────────────────────────────
$('voice').innerHTML = '';
for (const t of PATCH_TYPES) $('voice').appendChild(new Option(t.label, t.id));

async function fillPatchPresets() {
  savedPatchPresets = await listPresets(schema.id); // node server (disk), {} if absent
  const merged = { ...(schema.presets || {}), ...savedPatchPresets };
  $('preset').innerHTML = '';
  $('preset').appendChild(new Option('—', ''));
  for (const name of Object.keys(merged)) $('preset').appendChild(new Option(name, name));
}

$('voice').onchange = (e) => {
  schema = PATCH_TYPES.find((t) => t.id === e.target.value);
  patch = loadDraft(`patch:${schema.id}`) || defaultsFor(schema);
  fillPatchPresets();
  rerender();
  preview.sendPatch(schema.id, patch);
};
$('preset').onchange = (e) => {
  const name = e.target.value;
  const merged = { ...(schema.presets || {}), ...savedPatchPresets };
  const p = merged[name];
  if (p) { patch = { ...p }; rerender(); preview.sendPatch(schema.id, patch); status(`preset: ${name}`); }
};
$('preset-save').onclick = async () => {
  const name = prompt(`Save ${schema.label} patch preset as:`);
  if (!name) return;
  try {
    await savePreset(schema.id, name, patch);
    await fillPatchPresets();
    $('preset').value = name;
    status(`saved patch preset: ${name}`);
  } catch (err) { status(`save failed: ${err.message}`); }
};
$('preset-del').onclick = async () => {
  const name = $('preset').value;
  if (!name) return;
  try { await deletePreset(schema.id, name); await fillPatchPresets(); status(`deleted: ${name}`); }
  catch (err) { status(`delete failed: ${err.message}`); }
};
$('reset').onclick = () => { patch = defaultsFor(schema); rerender(); preview.sendPatch(schema.id, patch); status('reset to default'); };
$('randomize').onclick = () => { patch = randomizeFor(schema); rerender(); preview.sendPatch(schema.id, patch); status('randomized'); };

function rerender() {
  renderParams(schema, patch, $('params'), () => {
    saveDraft(`patch:${schema.id}`, patch);
    preview.sendPatch(schema.id, patch); // stream the edit to the live DSP
    refreshExport();
  });
  refreshExport();
}

// --- patch export --------------------------------------------------------
function toRust() {
  const struct = schema.id === 'fm' ? 'FmPatch' : 'BassPatch';
  const lines = schema.params.map((p) => {
    let v = patch[p.key];
    if (p.key === 'shaper') v = `Shaper::${v}`;
    else if (Number.isInteger(p.step) && p.step >= 1) v = String(Math.round(v));
    else v = Number(v).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
    return `    ${p.key}: ${v},`;
  });
  return `${struct} {\n${lines.join('\n')}\n}`;
}
function refreshExport() {
  $('export-out').value = $('export-fmt').value === 'rust' ? toRust() : JSON.stringify(patch, null, 2);
}
$('export-fmt').onchange = refreshExport;
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('export-out').value); status('copied'); }
  catch { status('copy failed — select + ⌘C'); }
};
$('download').onclick = () => {
  const rust = $('export-fmt').value === 'rust';
  saveText(`${schema.id}_patch.${rust ? 'rs.txt' : 'json'}`, $('export-out').value);
  status('downloaded');
};

// ── FX CHAIN ───────────────────────────────────────────────────────────────
async function initLive() {
  if (!fxCatalog) {
    fxCatalog = await preview.fx.catalog();
    $('fx-add-kind').innerHTML = '';
    for (const e of (fxCatalog || [])) $('fx-add-kind').appendChild(new Option(e.kind, e.kind));
  }
  await fillFxPresets();
  await fillInstruments();
  await refreshFxChain();
}
const specFor = (kind) => (fxCatalog || []).find((e) => e.kind === kind);

async function refreshFxChain() {
  renderFxChain((await preview.fx.chain()) || []);
}
function renderFxOffline() {
  $('fx-list').innerHTML = '';
  $('fx-list').appendChild(el('div', { class: 'fx-empty' }, 'Start the preview server (cargo run -p host --bin patch_server) to edit the FX chain.'));
}
function renderFxChain(chain) {
  const list = $('fx-list');
  list.innerHTML = '';
  if (!chain.length) { list.appendChild(el('div', { class: 'fx-empty' }, 'No effects — add one above.')); return; }
  chain.forEach((node, i) => list.appendChild(fxCard(node, i, chain.length)));
}
function fxCard(node, i, n) {
  const head = el('div', { class: 'fx-head' }, [
    el('span', { class: 'name' }, `${i + 1}. ${node.kind}`),
    el('span', { class: 'grow' }),
    el('button', { title: 'Move up', disabled: i === 0 || null, onclick: async () => { await preview.fx.move(i, i - 1); refreshFxChain(); } }, '↑'),
    el('button', { title: 'Move down', disabled: i === n - 1 || null, onclick: async () => { await preview.fx.move(i, i + 1); refreshFxChain(); } }, '↓'),
    el('button', { title: 'Remove', onclick: async () => { await preview.fx.remove(i); refreshFxChain(); } }, '✕'),
  ]);
  const body = el('div', {});
  const spec = specFor(node.kind);
  if (spec) for (const p of spec.params) {
    const param = { key: p.name, label: p.name, min: p.min, max: p.max, step: fxStep(p.name, p.min, p.max), unit: '' };
    const val = node.params[p.name] != null ? node.params[p.name] : p.default;
    body.appendChild(sliderRow(param, val, (v) => preview.fx.setParam(i, p.name, v)));
  }
  return el('div', { class: 'fx-card' }, [head, body]);
}
function fxStep(name, min, max) {
  if (name === 'reverse' || name === 'mode') return 1;
  const span = max - min;
  if (span <= 2) return 0.01;
  if (span <= 20) return 0.1;
  return 1;
}
$('fx-add').onclick = async () => {
  const kind = $('fx-add-kind').value;
  if (!kind) return;
  await preview.fx.add(kind);
  await refreshFxChain();
  status(`added ${kind}`);
};

// --- FX presets ----------------------------------------------------------
async function fillFxPresets() {
  const names = (await preview.fxPresets.list()) || [];
  $('fx-preset').innerHTML = '';
  $('fx-preset').appendChild(new Option('—', ''));
  for (const nm of names) $('fx-preset').appendChild(new Option(nm, nm));
}
$('fx-preset').onchange = async (e) => {
  const name = e.target.value;
  if (!name) return;
  await preview.fxPresets.load(name);
  await refreshFxChain();
  status(`FX preset: ${name}`);
};
$('fx-preset-save').onclick = async () => {
  const name = prompt('Save FX chain preset as:');
  if (!name) return;
  if (await preview.fxPresets.save(name)) { await fillFxPresets(); $('fx-preset').value = name; status(`saved FX preset: ${name}`); }
  else status('FX preset save failed');
};
$('fx-preset-del').onclick = async () => {
  const name = $('fx-preset').value;
  if (!name) return;
  await preview.fxPresets.remove(name);
  await fillFxPresets();
  status(`deleted FX preset: ${name}`);
};

// ── INSTRUMENT (patch + FX bundle) ───────────────────────────────────────────
async function fillInstruments() {
  const names = (await preview.instruments.list()) || [];
  $('inst-preset').innerHTML = '';
  $('inst-preset').appendChild(new Option('—', ''));
  for (const nm of names) $('inst-preset').appendChild(new Option(nm, nm));
}
$('inst-load').onclick = async () => {
  const name = $('inst-preset').value;
  if (!name) return;
  const inst = await preview.instruments.load(name); // applies on the server, returns the bundle
  if (!inst) { status('instrument load failed'); return; }
  // sync the editor: stash all source patches as drafts, show the current voice's
  for (const t of ['fm', 'bass', 'wt']) if (inst[t]) saveDraft(`patch:${t}`, inst[t]);
  if (inst[schema.id]) { patch = { ...inst[schema.id] }; rerender(); }
  await refreshFxChain();
  status(`loaded instrument: ${name}`);
};
$('inst-save').onclick = async () => {
  const name = prompt('Save instrument (patch + FX chain) as:');
  if (!name) return;
  if (await preview.instruments.save(name)) { await fillInstruments(); $('inst-preset').value = name; status(`saved instrument: ${name}`); }
  else status('instrument save failed');
};
$('inst-del').onclick = async () => {
  const name = $('inst-preset').value;
  if (!name) return;
  await preview.instruments.remove(name);
  await fillInstruments();
  status(`deleted instrument: ${name}`);
};

// ── boot ─────────────────────────────────────────────────────────────────
fillPatchPresets();
rerender();
renderFxOffline();
status('editing ' + schema.label);
preview.probe(); // detect the preview server, then initLive() wires the FX/instrument panels
