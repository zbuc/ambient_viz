// patches.js — synth-patch parameter editor for the FM stab and rumble bass.
//
// Schemas mirror the Rust structs (see shared/patch-schema.js). Editing builds
// a plain patch object; export emits JSON or a Rust struct literal you can
// paste into fm_stab.rs / bass.rs.

import { PATCH_TYPES, defaultsFor, randomizeFor } from '../shared/patch-schema.js';
import { renderParams } from '../shared/ui.js';
import { saveText, saveDraft, loadDraft } from '../shared/storage.js';
import { createPreview } from '../shared/preview.js';

const $ = (id) => document.getElementById(id);
const status = (m) => { $('status').textContent = m; };

let schema = PATCH_TYPES[0];
let patch = loadDraft(`patch:${schema.id}`) || defaultsFor(schema);

// --- live preview (native patch_server) ----------------------------------
const preview = createPreview({ onStatus: onLive });
function onLive(online) {
  const pill = $('live');
  pill.textContent = online ? '● live' : 'preview offline';
  pill.className = 'pill ' + (online ? 'online' : 'offline');
  $('trigger').disabled = !online;
  if (online) preview.sendPatch(schema.id, patch); // sync server to editor state
}
$('live').onclick = () => { $('live').textContent = 'connecting…'; preview.probe(); };
$('trigger').onclick = () => preview.trigger(schema.id);
// Kill switch stays clickable even when offline — mash it to stop everything.
$('stop').onclick = () => { preview.panic(); status('killed all audio'); };

// --- selectors -----------------------------------------------------------
$('voice').innerHTML = '';
for (const t of PATCH_TYPES) $('voice').appendChild(new Option(t.label, t.id));

function fillPresets() {
  $('preset').innerHTML = '';
  for (const name of Object.keys(schema.presets || {})) {
    $('preset').appendChild(new Option(name, name));
  }
}

$('voice').onchange = (e) => {
  schema = PATCH_TYPES.find((t) => t.id === e.target.value);
  patch = loadDraft(`patch:${schema.id}`) || defaultsFor(schema);
  fillPresets();
  rerender();
  preview.sendPatch(schema.id, patch);
};
$('preset').onchange = (e) => {
  const p = schema.presets[e.target.value];
  if (p) { patch = { ...p }; rerender(); preview.sendPatch(schema.id, patch); status(`preset: ${e.target.value}`); }
};
$('reset').onclick = () => {
  patch = defaultsFor(schema); rerender(); preview.sendPatch(schema.id, patch); status('reset to default');
};
$('randomize').onclick = () => {
  patch = randomizeFor(schema); rerender(); preview.sendPatch(schema.id, patch); status('randomized');
};

// --- render --------------------------------------------------------------
function rerender() {
  renderParams(schema, patch, $('params'), () => {
    saveDraft(`patch:${schema.id}`, patch);
    preview.sendPatch(schema.id, patch); // stream the edit to the live DSP
    refreshExport();
  });
  refreshExport();
}

// --- export --------------------------------------------------------------
function toRust() {
  const struct = schema.id === 'fm' ? 'FmPatch' : 'BassPatch';
  const lines = schema.params.map((p) => {
    let v = patch[p.key];
    if (p.key === 'shaper') v = `Shaper::${v}`;
    else if (Number.isInteger(p.step) && p.step >= 1) v = String(Math.round(v)); // i32 fields
    else v = Number(v).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
    return `    ${p.key}: ${v},`;
  });
  return `${struct} {\n${lines.join('\n')}\n}`;
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
  saveText(`${schema.id}_patch.${rust ? 'rs.txt' : 'json'}`, $('export-out').value);
  status('downloaded');
};

// --- boot ----------------------------------------------------------------
fillPresets();
rerender();
status('editing ' + schema.label);
preview.probe(); // detect the native preview server, switch the pill to live
