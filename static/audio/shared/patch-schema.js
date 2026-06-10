// patch-schema.js — parameter definitions for the synth patches, mirrored from
// the Rust structs so the editor can't drift from what the DSP accepts:
//   FmPatch   → daisy/crates/dsp/src/fm_stab.rs
//   BassPatch → daisy/crates/dsp/src/bass.rs
//
// Each param: { key, label, min, max, step, unit, default, help }.
// `enum` params carry { key, label, options:[...], default } instead of a range.
// Keep ranges sane-for-editing; the DSP itself may accept wider values.

export const SHAPER_OPTIONS = ['Off', 'Tanh', 'HardClip', 'Foldback'];

/** FM stab voice (fm_stab.rs FmPatch). */
export const FM_PATCH = {
  id: 'fm',
  label: 'FM Stab',
  params: [
    { key: 'mod_ratio',   label: 'Mod ratio',    min: 0.25, max: 8,   step: 0.001, unit: '×',  default: 1.0,  help: 'Modulator freq as a multiple of the note. Integer → harmonic; non-integer → metallic.' },
    { key: 'index',       label: 'FM index',     min: 0,    max: 10,  step: 0.01,  unit: '',   default: 2.2,  help: 'Peak deviation = index × mod freq. ~1-4 musical; higher = more sidebands.' },
    { key: 'feedback',    label: 'Feedback',     min: 0,    max: 1.2, step: 0.01,  unit: '',   default: 0.0,  help: 'Carrier self-feedback. 0 = pure sine; rising → sawtooth buzz. The main grit knob.' },
    { key: 'drive',       label: 'Drive',        min: 0.1,  max: 3,   step: 0.01,  unit: '×',  default: 1.0,  help: 'Pre-shaper input gain. 1.0 = unity.' },
    { key: 'shaper',      label: 'Shaper',       options: SHAPER_OPTIONS,            default: 'Tanh', help: 'Output waveshaper. HardClip/Foldback = abrasive.' },
    { key: 'attack_s',    label: 'Attack',       min: 0.001, max: 0.5, step: 0.001, unit: 's',  default: 0.002, help: 'Amp attack. Keep tiny (~1-5 ms) for a stab.' },
    { key: 'decay_s',     label: 'Decay',        min: 0.02, max: 4,   step: 0.01,  unit: 's',  default: 0.28, help: "Amp decay to silence — the stab's length." },
    { key: 'mod_decay_s', label: 'Mod decay',    min: 0.02, max: 4,   step: 0.01,  unit: 's',  default: 0.12, help: 'Brightness fade. Usually shorter than decay so the tone outlasts the sparkle.' },
  ],
  presets: {
    default: { mod_ratio: 1.0, index: 2.2, feedback: 0.0, drive: 1.0, shaper: 'Tanh', attack_s: 0.002, decay_s: 0.28, mod_decay_s: 0.12 },
    industrial: { mod_ratio: 1.414, index: 4.5, feedback: 0.45, drive: 1.5, shaper: 'HardClip', attack_s: 0.081, decay_s: 1.32, mod_decay_s: 1.18 },
  },
};

/** Rumble sub-bass voice (bass.rs BassPatch). */
export const BASS_PATCH = {
  id: 'bass',
  label: 'Rumble Bass',
  params: [
    { key: 'octave_offset', label: 'Octave offset', min: -24, max: 12,  step: 1,    unit: 'st', default: -12,  help: 'Semitones applied to the incoming note so the bass sits below the stabs.' },
    { key: 'detune_cents',  label: 'Detune',        min: 0,   max: 50,  step: 0.5,  unit: '¢',  default: 12,   help: 'Saw-stack spread; outer saws at ±this. ~5-20 typical.' },
    { key: 'sub_level',     label: 'Sub level',     min: 0,   max: 1,   step: 0.01, unit: '',   default: 0.7,  help: 'Sub-sine level relative to the saw stack.' },
    { key: 'cutoff_hz',     label: 'Cutoff',        min: 40,  max: 2000, step: 1,   unit: 'Hz', default: 180,  help: 'Base lowpass cutoff.' },
    { key: 'resonance',     label: 'Resonance',     min: 0,   max: 1,   step: 0.01, unit: '',   default: 0.35, help: 'Filter resonance; self-oscillates near 1.' },
    { key: 'env_mod_hz',    label: 'Env→cutoff',    min: 0,   max: 4000, step: 10,  unit: 'Hz', default: 600,  help: 'Hz added at full envelope. 0 = static cutoff.' },
    { key: 'attack_s',      label: 'Attack',        min: 0.001, max: 1, step: 0.001, unit: 's', default: 0.02, help: 'Amp-envelope attack.' },
    { key: 'decay_s',       label: 'Decay',         min: 0.02, max: 4, step: 0.01,  unit: 's',  default: 0.5,  help: 'Decay to the sustain level.' },
    { key: 'sustain',       label: 'Sustain',       min: 0,   max: 1,   step: 0.01, unit: '',   default: 0.8,  help: 'Level held while the gate is open.' },
    { key: 'release_s',     label: 'Release',       min: 0.01, max: 4, step: 0.01,  unit: 's',  default: 0.25, help: 'Release after note-off.' },
  ],
  presets: {
    default: { octave_offset: -12, detune_cents: 12, sub_level: 0.7, cutoff_hz: 180, resonance: 0.35, env_mod_hz: 600, attack_s: 0.02, decay_s: 0.5, sustain: 0.8, release_s: 0.25 },
  },
};

export const PATCH_TYPES = [FM_PATCH, BASS_PATCH];

// --- Wavetable voice (Microwave II clone) --------------------------------
// Front-end scaffold: a Rust `WtPatch` DSP struct does NOT exist yet (the FM
// stab / rumble bass are the only voices with a Rust mirror today). This schema
// is the source of truth for the editor and the planned struct; keep it in sync
// when the `dsp` wavetable osc lands. See BACKLOG.md "Waldorf wavetable osc".
//
// Architecture mirrors the Waldorf Microwave II/XT voice:
//   2 wavetable oscillators -> mixer (+ noise + ring mod) -> multimode filter
//   -> VCA, with a filter envelope and an amp envelope.
// `widget`-tagged params (wavetable picker, wave-position) are drawn by the
// wavetable pane's bespoke canvas UI, not the generic slider renderer.

export const WT_FILTER_TYPES = [
  'Lowpass 24dB', 'Lowpass 12dB', 'Bandpass', 'Highpass', 'Notch',
  'Waveshaper', 'Bitreduction',
];
export const ONOFF = ['Off', 'On'];

export const WT_PATCH = {
  id: 'wt',
  label: 'Wavetable',
  params: [
    // -- Oscillator 1 (osc:1) ------------------------------------------------
    { key: 'osc1_wavetable', label: 'Wavetable',  widget: 'wavetable', osc: 1, section: 'Oscillator 1', default: 'vswaves1', help: 'Which wavetable osc 1 scans. Previews shown below.' },
    { key: 'osc1_wave',      label: 'Wave pos',    widget: 'wavepos',   osc: 1, section: 'Oscillator 1', default: 0.0, help: 'Position scanned within the wavetable (0 = first wave … 1 = last). Morphs between adjacent waves.' },
    { key: 'osc1_semitone',  label: 'Transpose',   min: -24, max: 24,  step: 1,    unit: 'st', osc: 1, section: 'Oscillator 1', default: 0,   help: 'Coarse pitch in semitones.' },
    { key: 'osc1_detune',    label: 'Detune',      min: -50, max: 50,  step: 0.5,  unit: '¢',  osc: 1, section: 'Oscillator 1', default: 0,   help: 'Fine pitch in cents.' },
    { key: 'osc1_keytrack',  label: 'Keytrack',    min: 0,   max: 200, step: 1,    unit: '%',  osc: 1, section: 'Oscillator 1', default: 100, help: 'How much the note pitch tracks the keyboard. 100% = normal.' },
    // -- Oscillator 2 (osc:2) ------------------------------------------------
    { key: 'osc2_wavetable', label: 'Wavetable',  widget: 'wavetable', osc: 2, section: 'Oscillator 2', default: 'ppgebass', help: 'Which wavetable osc 2 scans.' },
    { key: 'osc2_wave',      label: 'Wave pos',    widget: 'wavepos',   osc: 2, section: 'Oscillator 2', default: 0.0, help: 'Wave-scan position for osc 2.' },
    { key: 'osc2_semitone',  label: 'Transpose',   min: -24, max: 24,  step: 1,    unit: 'st', osc: 2, section: 'Oscillator 2', default: 0,   help: 'Coarse pitch in semitones.' },
    { key: 'osc2_detune',    label: 'Detune',      min: -50, max: 50,  step: 0.5,  unit: '¢',  osc: 2, section: 'Oscillator 2', default: 7,   help: 'Fine pitch in cents; a few cents off osc 1 thickens the tone.' },
    { key: 'osc2_keytrack',  label: 'Keytrack',    min: 0,   max: 200, step: 1,    unit: '%',  osc: 2, section: 'Oscillator 2', default: 100, help: 'Keyboard pitch tracking for osc 2.' },
    { key: 'osc2_sync',      label: 'Sync→Osc1',   options: ONOFF,                            osc: 2, section: 'Oscillator 2', default: 'Off', help: 'Hard-sync osc 2 to osc 1 for classic sync sweeps.' },
    { key: 'osc2_fm',        label: 'FM (1→2)',    min: 0,   max: 1,   step: 0.01,             osc: 2, section: 'Oscillator 2', default: 0.0, help: 'Osc 1 frequency-modulates osc 2.' },
    // -- Mixer ---------------------------------------------------------------
    { key: 'mix_osc1',     label: 'Osc 1',      min: 0, max: 1, step: 0.01, section: 'Mixer', default: 1.0,  help: 'Osc 1 level into the filter.' },
    { key: 'mix_osc2',     label: 'Osc 2',      min: 0, max: 1, step: 0.01, section: 'Mixer', default: 0.7,  help: 'Osc 2 level into the filter.' },
    { key: 'mix_ring',     label: 'Ring mod',   min: 0, max: 1, step: 0.01, section: 'Mixer', default: 0.0,  help: 'Ring modulator (osc1 × osc2) level — clangorous, inharmonic.' },
    { key: 'mix_noise',    label: 'Noise',      min: 0, max: 1, step: 0.01, section: 'Mixer', default: 0.0,  help: 'Noise generator level.' },
    { key: 'noise_colour', label: 'Noise colour', min: 0, max: 1, step: 0.01, section: 'Mixer', default: 0.5, help: 'Noise tone: 0 = dark/red, 1 = bright/white.' },
    // -- Filter --------------------------------------------------------------
    { key: 'filter_type',       label: 'Type',      options: WT_FILTER_TYPES, section: 'Filter', default: 'Lowpass 24dB', help: 'Multimode filter model (Microwave II has 13; a representative subset here).' },
    { key: 'cutoff_hz',         label: 'Cutoff',    min: 20, max: 16000, step: 1,    unit: 'Hz', section: 'Filter', default: 8000, help: 'Filter cutoff frequency.' },
    { key: 'resonance',         label: 'Resonance', min: 0,  max: 1,     step: 0.01,             section: 'Filter', default: 0.2,  help: 'Filter resonance; self-oscillates near 1.' },
    { key: 'filter_env_amount', label: 'Env→Cutoff', min: -1, max: 1,    step: 0.01,             section: 'Filter', default: 0.3,  help: 'Filter-envelope amount (bipolar) on cutoff.' },
    { key: 'filter_keytrack',   label: 'Keytrack',  min: 0,  max: 200,   step: 1,    unit: '%',  section: 'Filter', default: 50,   help: 'How much cutoff tracks the played note.' },
    // -- Filter envelope -----------------------------------------------------
    { key: 'fenv_attack',  label: 'Attack',  min: 0.001, max: 4, step: 0.001, unit: 's', section: 'Filter Envelope', default: 0.005, help: 'Filter-env attack.' },
    { key: 'fenv_decay',   label: 'Decay',   min: 0.002, max: 8, step: 0.01,  unit: 's', section: 'Filter Envelope', default: 0.5,   help: 'Filter-env decay.' },
    { key: 'fenv_sustain', label: 'Sustain', min: 0,     max: 1, step: 0.01,             section: 'Filter Envelope', default: 0.4,   help: 'Filter-env sustain level.' },
    { key: 'fenv_release', label: 'Release', min: 0.002, max: 8, step: 0.01,  unit: 's', section: 'Filter Envelope', default: 0.4,   help: 'Filter-env release.' },
    // -- Amplifier envelope --------------------------------------------------
    { key: 'aenv_attack',  label: 'Attack',  min: 0.001, max: 4, step: 0.001, unit: 's', section: 'Amplifier', default: 0.005, help: 'Amp-env attack.' },
    { key: 'aenv_decay',   label: 'Decay',   min: 0.002, max: 8, step: 0.01,  unit: 's', section: 'Amplifier', default: 1.0,   help: 'Amp-env decay.' },
    { key: 'aenv_sustain', label: 'Sustain', min: 0,     max: 1, step: 0.01,             section: 'Amplifier', default: 0.8,   help: 'Amp-env sustain level.' },
    { key: 'aenv_release', label: 'Release', min: 0.002, max: 8, step: 0.01,  unit: 's', section: 'Amplifier', default: 0.6,   help: 'Amp-env release.' },
    { key: 'volume',       label: 'Volume',  min: 0,     max: 1, step: 0.01,             section: 'Amplifier', default: 0.8,   help: 'Voice output level.' },
    // -- Voice ---------------------------------------------------------------
    { key: 'glide', label: 'Glide', min: 0, max: 1, step: 0.001, unit: 's', section: 'Voice', default: 0.0, help: 'Portamento time between notes.' },
  ],
  presets: {
    default: {
      osc1_wavetable: 'vswaves1', osc1_wave: 0.0, osc1_semitone: 0, osc1_detune: 0, osc1_keytrack: 100,
      osc2_wavetable: 'ppgebass', osc2_wave: 0.0, osc2_semitone: 0, osc2_detune: 7, osc2_keytrack: 100, osc2_sync: 'Off', osc2_fm: 0.0,
      mix_osc1: 1.0, mix_osc2: 0.7, mix_ring: 0.0, mix_noise: 0.0, noise_colour: 0.5,
      filter_type: 'Lowpass 24dB', cutoff_hz: 8000, resonance: 0.2, filter_env_amount: 0.3, filter_keytrack: 50,
      fenv_attack: 0.005, fenv_decay: 0.5, fenv_sustain: 0.4, fenv_release: 0.4,
      aenv_attack: 0.005, aenv_decay: 1.0, aenv_sustain: 0.8, aenv_release: 0.6, volume: 0.8,
      glide: 0.0,
    },
    'sweep pad': {
      osc1_wavetable: 'vswaves2', osc1_wave: 0.0, osc1_semitone: 0, osc1_detune: 0, osc1_keytrack: 100,
      osc2_wavetable: 'vswaves1', osc2_wave: 0.35, osc2_semitone: -12, osc2_detune: 9, osc2_keytrack: 100, osc2_sync: 'Off', osc2_fm: 0.0,
      mix_osc1: 0.9, mix_osc2: 0.8, mix_ring: 0.0, mix_noise: 0.05, noise_colour: 0.3,
      filter_type: 'Lowpass 24dB', cutoff_hz: 2600, resonance: 0.35, filter_env_amount: 0.5, filter_keytrack: 40,
      fenv_attack: 0.9, fenv_decay: 2.0, fenv_sustain: 0.5, fenv_release: 2.5,
      aenv_attack: 1.2, aenv_decay: 3.0, aenv_sustain: 0.85, aenv_release: 3.5, volume: 0.8,
      glide: 0.05,
    },
  },
};

/** Build a patch object filled with a schema's defaults. */
export function defaultsFor(schema) {
  const out = {};
  for (const p of schema.params) out[p.key] = p.default;
  return out;
}

/** Snap a value to a param's step and clamp to its range. */
function snap(v, p) {
  let out = v;
  if (p.step > 0) out = Math.round(v / p.step) * p.step;
  out = Math.min(p.max, Math.max(p.min, out));
  return p.step && p.step < 1 ? parseFloat(out.toFixed(6)) : out;
}

/**
 * Build a patch with each param rolled uniformly within its declared range
 * (enums pick a random option; sliders snap to their step). Bespoke `widget`
 * params: `wavepos` rolls 0..1; `wavetable` picks from `opts.wavetableIds`
 * (left at its default if none supplied, since the id list is runtime data).
 */
export function randomizeFor(schema, opts = {}) {
  const out = {};
  for (const p of schema.params) {
    if (p.widget === 'wavetable') {
      const ids = opts.wavetableIds;
      out[p.key] = ids && ids.length ? ids[(Math.random() * ids.length) | 0] : p.default;
    } else if (p.widget === 'wavepos') {
      out[p.key] = parseFloat(Math.random().toFixed(3));
    } else if (p.options) {
      out[p.key] = p.options[(Math.random() * p.options.length) | 0];
    } else {
      out[p.key] = snap(p.min + Math.random() * (p.max - p.min), p);
    }
  }
  return out;
}
