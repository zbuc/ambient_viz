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

/** Build a patch object filled with a schema's defaults. */
export function defaultsFor(schema) {
  const out = {};
  for (const p of schema.params) out[p.key] = p.default;
  return out;
}
