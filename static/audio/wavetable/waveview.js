// waveview.js — canvas rendering for wavetable previews.
//
// Wave sample data is stored signed 8-bit (the Waldorf source's native depth);
// see ../../../patches/wavetables/waldorf_wavetable.py for the bank generator.
// Everything here works on plain JS arrays of i8 (-128..127) and normalizes to
// [-1, 1] only for drawing / audio.

const FG = '#6ad0c8';     // --accent
const DIM = '#2a2e37';    // --line
const HILITE = '#e0a96d'; // --hit

/** i8 sample array → Float32 in [-1, 1]. */
export function normWave(s) {
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i] / 128;
  return out;
}

/**
 * Interpolate the wave at a fractional scan position.
 * @param {{waves:{s:number[]}[]}} table
 * @param {number} pos  normalized 0..1 across the table
 * @returns {Float32Array} 128-sample cycle in [-1, 1]
 */
export function wavetableAt(table, pos) {
  const n = table.waves.length;
  if (n === 0) return new Float32Array(128);
  if (n === 1) return normWave(table.waves[0].s);
  const f = Math.min(Math.max(pos, 0), 1) * (n - 1);
  const i = Math.floor(f);
  const frac = f - i;
  const a = table.waves[i].s;
  const b = table.waves[Math.min(i + 1, n - 1)].s;
  const len = a.length;
  const out = new Float32Array(len);
  for (let k = 0; k < len; k++) out[k] = (a[k] + (b[k] - a[k]) * frac) / 128;
  return out;
}

/** The wave index (and its UW number) nearest a scan position, for readouts. */
export function waveInfoAt(table, pos) {
  const n = table.waves.length;
  const idx = Math.round(Math.min(Math.max(pos, 0), 1) * (n - 1));
  return { idx, n, wave: table.waves[idx] };
}

// --- canvas plumbing -----------------------------------------------------

/** Size a canvas's backing store to its CSS box × devicePixelRatio. */
function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function polyline(ctx, samples, w, h, pad) {
  const n = samples.length;
  const mid = h / 2;
  const amp = (h / 2 - pad);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const y = mid - samples[i] * amp;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/** Draw a single normalized cycle, centered, as a stroked line. */
export function drawWave(canvas, samples, { color = FG, grid = true } = {}) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  if (grid) {
    ctx.strokeStyle = DIM;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  polyline(ctx, samples, w, h, 4);
}

/**
 * Draw a wavetable as a stacked "waterfall" silhouette — a downsampled set of
 * its waves drawn back-to-front with a perspective offset, so each table has a
 * recognizable shape in the picker. Optionally highlight the wave at `pos`.
 */
export function drawWavetableThumb(canvas, table, { pos = null, maxLines = 22 } = {}) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const waves = table.waves;
  const n = waves.length;
  if (!n) return;

  const lines = Math.min(maxLines, n);
  const depth = h * 0.34;          // vertical travel front→back
  const top = 3;
  const rowAmp = (h - depth - top * 2) / 2;
  const hiIdx = pos == null ? -1 : Math.round(Math.min(Math.max(pos, 0), 1) * (n - 1));

  // back (faint) → front (bright)
  for (let li = lines - 1; li >= 0; li--) {
    const srcIdx = Math.round((li / (lines - 1 || 1)) * (n - 1));
    const s = waves[srcIdx].s;
    const yOff = top + (li / (lines - 1 || 1)) * depth + rowAmp;
    const t = li / (lines - 1 || 1);          // 0 back … 1 front
    const isHi = hiIdx >= 0 && Math.abs(srcIdx - hiIdx) <= (n / lines) / 2;
    ctx.strokeStyle = isHi ? HILITE : FG;
    ctx.globalAlpha = isHi ? 1 : 0.18 + t * 0.5;
    ctx.lineWidth = isHi ? 1.6 : 1;
    ctx.beginPath();
    for (let i = 0; i < s.length; i++) {
      const x = (i / (s.length - 1)) * w;
      const y = yOff - (s[i] / 128) * rowAmp;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
