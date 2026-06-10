// ui.js — tiny vanilla widget helpers shared by the audio tools. No framework,
// no build step. Each helper builds a DOM node and wires an onChange callback.

/** el('div', {class:'x', onclick:fn}, [child, 'text']) → HTMLElement */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/**
 * Labeled numeric slider bound to a schema param.
 * @param {object} param  one entry from patch-schema.js
 * @param {number} value
 * @param {(v:number)=>void} onChange
 */
export function sliderRow(param, value, onChange) {
  const readout = el('span', { class: 'param-val' }, fmt(value, param));
  const input = el('input', {
    type: 'range', min: param.min, max: param.max, step: param.step, value,
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      readout.textContent = fmt(v, param);
      onChange(v);
    },
  });
  return el('label', { class: 'param-row', title: param.help || '' }, [
    el('span', { class: 'param-label' }, param.label),
    input,
    readout,
  ]);
}

/** Labeled dropdown for an enum param (options:[...]). */
export function selectRow(param, value, onChange) {
  const sel = el('select', { onchange: (e) => onChange(e.target.value) },
    param.options.map((o) => el('option', { value: o, selected: o === value || null }, o)));
  return el('label', { class: 'param-row', title: param.help || '' }, [
    el('span', { class: 'param-label' }, param.label),
    sel,
  ]);
}

/**
 * Render every param of a schema into `container`, mutating `patch`.
 * If a param carries a `section` string, a header is emitted whenever the
 * section changes — schemas without `section` render as a flat list (FM/bass).
 */
export function renderParams(schema, patch, container, onChange = () => {}) {
  container.innerHTML = '';
  let section = null;
  for (const param of schema.params) {
    if (param.widget) continue; // bespoke widgets (e.g. wavetable picker) render elsewhere
    if (param.section && param.section !== section) {
      section = param.section;
      container.appendChild(el('h3', { class: 'param-section' }, section));
    }
    const apply = (v) => { patch[param.key] = v; onChange(param.key, v); };
    container.appendChild(
      param.options ? selectRow(param, patch[param.key], apply)
                    : sliderRow(param, patch[param.key], apply),
    );
  }
}

function fmt(v, param) {
  const dp = (param.step && param.step < 1) ? String(param.step).split('.')[1].length : 0;
  return `${v.toFixed(dp)}${param.unit ? ' ' + param.unit : ''}`;
}
