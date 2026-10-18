// BoxBeat: a drum machine with synths. Beats down the side (kept in data/beats.json); in each, rows of sounds against a
// grid of steps (16 to the bar), in patterns (A, B, C…) that a song strings together. The drums and synths are made on
// the fly with Web Audio, or a row plays a sample (any sound file: from the audio dump, or dropped on it). Synth rows
// carry notes, written in a piano roll that opens under the row. Each row has its own reverb, delay, drive and filter.
// Export renders the pattern or the song offline into the audio dump, as WAV or MP3.

import { BaseEditor } from './base.js';
import { h, clear, clamp, uid, basename, stripExt, extOf } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { toast, errorToast, confirmDialog, promptDialog, contextMenu, modal, popover, draggedPaths } from '../core/ui.js';
import { pickOpen } from '../core/files.js';

const T = () => ({ 'X-BDS-Token': api.token });
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba']);
const STEP_COUNTS = [8, 12, 16, 24, 32, 48, 64];
const MAX_STEPS = 64;
const MAX_PATTERNS = 16;
const LETTERS = 'ABCDEFGHIJKLMNOP';
const SOFT = 0.5; // a Shift+click hit
const NONE = Object.freeze([]);

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11],
  'minor pentatonic': [0, 3, 5, 7, 10], 'major pentatonic': [0, 2, 4, 7, 9],
  dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], 'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  blues: [0, 3, 5, 6, 7, 10], chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const inScale = (b, m) => (SCALES[b.scale] || SCALES.minor).includes((((m - b.key) % 12) + 12) % 12);

// ---------------------------------------------------------------- the built-in drums
const NOISE = new WeakMap();
function noiseBuf(ctx) {
  let b = NOISE.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    NOISE.set(ctx, b);
  }
  return b;
}
/** A gain that rises to `peak` in `a` seconds and dies away over `d`. */
function env(ctx, t, peak, a, d) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  return g;
}
function tone(ctx, type, f0, f1, t, sweep, len) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
  o.start(t); o.stop(t + len + 0.05);
  return o;
}
function noise(ctx, t, len) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf(ctx);
  s.loop = true;
  s.start(t, Math.random() * 0.5); s.stop(t + len + 0.05);
  return s;
}
function filter(ctx, type, f, q = 0.7) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
const chain = (...nodes) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; };

/** name → (ctx, out, t, vel, p) where p is the pitch as a rate (1 = as made). */
const KIT = {
  kick: { name: 'Kick', play(ctx, out, t, v, p) {
    chain(tone(ctx, 'sine', 160 * p, 42 * p, t, 0.12, 0.5), env(ctx, t, v, 0.002, 0.45), out);
    chain(noise(ctx, t, 0.02), filter(ctx, 'highpass', 3000), env(ctx, t, v * 0.25, 0.001, 0.012), out);
  } },
  snare: { name: 'Snare', play(ctx, out, t, v, p) {
    chain(noise(ctx, t, 0.25), filter(ctx, 'highpass', 1200 * p), env(ctx, t, v * 0.7, 0.001, 0.18), out);
    chain(tone(ctx, 'triangle', 200 * p, 150 * p, t, 0.08, 0.12), env(ctx, t, v * 0.55, 0.001, 0.1), out);
  } },
  clap: { name: 'Clap', play(ctx, out, t, v, p) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    for (const k of [0, 0.011, 0.022]) { g.gain.setValueAtTime(v * 0.8, t + k); g.gain.exponentialRampToValueAtTime(v * 0.15, t + k + 0.009); }
    g.gain.setValueAtTime(v * 0.6, t + 0.033);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    chain(noise(ctx, t, 0.25), filter(ctx, 'bandpass', 1150 * p, 1.1), g, out);
  } },
  hat: { name: 'Closed hat', play(ctx, out, t, v, p) {
    chain(noise(ctx, t, 0.06), filter(ctx, 'highpass', 7000 * p), env(ctx, t, v * 0.38, 0.001, 0.045), out);
  } },
  openhat: { name: 'Open hat', play(ctx, out, t, v, p) {
    chain(noise(ctx, t, 0.4), filter(ctx, 'highpass', 6500 * p), env(ctx, t, v * 0.32, 0.002, 0.32), out);
  } },
  tom: { name: 'Tom', play(ctx, out, t, v, p) {
    chain(tone(ctx, 'sine', 150 * p, 92 * p, t, 0.2, 0.35), env(ctx, t, v * 0.85, 0.002, 0.3), out);
  } },
  rim: { name: 'Rim', play(ctx, out, t, v, p) {
    chain(tone(ctx, 'triangle', 480 * p, 0, t, 0, 0.05), filter(ctx, 'highpass', 1500 * p), env(ctx, t, v * 0.9, 0.001, 0.035), out);
  } },
  cowbell: { name: 'Cowbell', play(ctx, out, t, v, p) {
    const bp = filter(ctx, 'bandpass', 800 * p, 2.5);
    tone(ctx, 'square', 540 * p, 0, t, 0, 0.3).connect(bp);
    tone(ctx, 'square', 800 * p, 0, t, 0, 0.3).connect(bp);
    chain(bp, env(ctx, t, v * 0.45, 0.001, 0.25), out);
  } },
  bass808: { name: '808', play(ctx, out, t, v, p) {
    const sat = ctx.createWaveShaper();
    const c = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = i / 128 - 1; c[i] = Math.tanh(x * 1.8); }
    sat.curve = c;
    chain(tone(ctx, 'sine', 62 * p, 49 * p, t, 0.08, 1.2), sat, env(ctx, t, v * 0.85, 0.003, 1.1), out);
  } },
  shaker: { name: 'Shaker', play(ctx, out, t, v, p) {
    chain(noise(ctx, t, 0.1), filter(ctx, 'bandpass', 6000 * p, 0.8), env(ctx, t, v * 0.32, 0.018, 0.06), out);
  } },
  blip: { name: 'Blip', play(ctx, out, t, v, p) {
    chain(tone(ctx, 'sine', 880 * p, 0, t, 0, 0.1), env(ctx, t, v * 0.4, 0.001, 0.08), out);
  } },
};

// ---------------------------------------------------------------- the synths (notes, not hits)
function osc(ctx, type, f, t, end, detune = 0) {
  const o = ctx.createOscillator();
  o.type = type; o.frequency.value = f; o.detune.value = detune;
  o.start(t); o.stop(end);
  return o;
}
/** Attack to `peak`, decay to `sus` × peak while the note is held, then release. Returns [gain, when it's silent]. */
function adsr(ctx, t, dur, peak, a, d, sus, r) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.setTargetAtTime(peak * sus, t + a, d / 3);
  const off = t + Math.max(dur, a);
  g.gain.setTargetAtTime(0, off, r / 3);
  return [g, off + r * 2 + 0.05];
}
// Plucked strings (a Karplus-Strong string: a burst of noise looped through a delay that's averaged each time round, which
// is what makes it ring at one pitch and die away). Each note is worked out sample by sample into a buffer, because Web
// Audio's own delay can't loop faster than about 340 Hz. t60: seconds to fade 60 dB; soft: 0 (dark) to 0.5 (bright is
// lower), the loop's averaging; pluck: how sharp the attack is; pos: where along the string it's plucked.
const STRINGS = {
  bassgtr: { t60: 3.4, soft: 0.46, pluck: 0.4, pos: 0.15, drive: 0, lp: 3000, body: [[85, 4, 1.4], [170, 2, 1.6]], vol: 0.9 },
  electric: { t60: 4.2, soft: 0.34, pluck: 0.9, pos: 0.2, drive: 2.4, lp: 5600, body: [[2800, 3, 1]], vol: 0.55 },
  acoustic: { t60: 2.3, soft: 0.4, pluck: 0.8, pos: 0.12, drive: 0, lp: 7500, body: [[105, 6, 2.5], [210, 4, 2], [440, 3, 2], [2400, 2, 1]], vol: 0.8 },
};
function stringNote(ctx, out, kind, t, dur, f, v) {
  const S = STRINGS[kind], sr = ctx.sampleRate;
  // the loop's length in samples: the string's period, plus what the averaging takes off (it reads one sample ahead, which
  // shortens the loop by an amount that depends on the pitch)
  const w = (2 * Math.PI * f) / sr;
  const D = sr / f + Math.atan2(S.soft * Math.sin(w), 1 - S.soft + S.soft * Math.cos(w)) / w;
  const L = Math.max(2, Math.floor(D)), frac = D - L;
  const C = (1 - frac) / (1 + frac); // all-pass that tunes the fraction of a sample the loop is short by
  const buf = new Float32Array(L);
  // the pluck: noise, softened for a fingertip, with a comb where the pick lands
  let prev = 0, mean = 0;
  for (let i = 0; i < L; i++) { prev += S.pluck * ((Math.random() * 2 - 1) - prev); buf[i] = prev; }
  const k = Math.max(1, Math.floor(L * S.pos));
  for (let i = L - 1; i >= k; i--) buf[i] -= 0.7 * buf[i - k];
  for (let i = 0; i < L; i++) mean += buf[i];
  mean /= L;
  let peak = 1e-6;
  for (let i = 0; i < L; i++) { buf[i] -= mean; peak = Math.max(peak, Math.abs(buf[i])); }
  for (let i = 0; i < L; i++) buf[i] /= peak;
  const g = Math.pow(10, -3 / (S.t60 * f)); // loss per trip round the loop, for the t60
  const n = Math.floor((dur + 0.45) * sr), hold = dur * sr;
  const data = new Float32Array(n);
  let idx = 0, apIn = 0, apOut = 0;
  for (let i = 0; i < n; i++) {
    const y0 = buf[idx], y1 = buf[idx + 1 === L ? 0 : idx + 1];
    const lp = (1 - S.soft) * y0 + S.soft * y1;
    const ap = C * lp + apIn - C * apOut; apIn = lp; apOut = ap;
    buf[idx] = ap * g;
    idx = idx + 1 === L ? 0 : idx + 1;
    // the note's end damps the string (a hand or a palm on it) rather than cutting it off
    const damp = i > hold ? Math.exp(-(i - hold) / (sr * 0.07)) : 1;
    let y = y0 * damp;
    if (S.drive) y = Math.tanh(S.drive * 1.6 * y) / Math.tanh(S.drive * 1.6);
    data[i] = y;
  }
  const ab = ctx.createBuffer(1, n, sr);
  ab.getChannelData(0).set(data);
  const src = ctx.createBufferSource();
  src.buffer = ab;
  let node = src;
  for (const [hz, db, q] of S.body) { const pk = filter(ctx, 'peaking', hz, q); pk.gain.value = db; node.connect(pk); node = pk; }
  const lpf = filter(ctx, 'lowpass', Math.min(S.lp, sr / 2.2), 0.7);
  node.connect(lpf);
  const gain = ctx.createGain(); gain.gain.value = v * S.vol * 0.5;
  lpf.connect(gain).connect(out);
  src.start(t);
}

/** name → play(ctx, out, t, dur, f, v); view: the lowest note the piano roll shows to begin with. strum: chords are spread across the strings. */
const SYNTHS = {
  bass: { name: 'Bass', view: 36, play(ctx, out, t, dur, f, v) {
    const [g, end] = adsr(ctx, t, dur, v * 0.42, 0.004, 0.12, 0.7, 0.07);
    const lp = filter(ctx, 'lowpass', f * 2.5, 5);
    lp.frequency.setValueAtTime(Math.min(16000, f * 14), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(60, f * 2.5), t + 0.16);
    osc(ctx, 'sawtooth', f, t, end).connect(lp);
    const sub = ctx.createGain(); sub.gain.value = 0.6;
    chain(osc(ctx, 'square', f / 2, t, end), sub, lp);
    chain(lp, g, out);
  } },
  lead: { name: 'Lead', view: 60, play(ctx, out, t, dur, f, v) {
    const [g, end] = adsr(ctx, t, dur, v * 0.2, 0.01, 0.25, 0.65, 0.18);
    const lp = filter(ctx, 'lowpass', Math.min(14000, f * 6), 2);
    for (const d of [-8, 8]) osc(ctx, 'sawtooth', f, t, end, d).connect(lp);
    chain(lp, g, out);
  } },
  pad: { name: 'Pad', view: 48, play(ctx, out, t, dur, f, v) {
    const [g, end] = adsr(ctx, t, dur, v * 0.11, 0.35, 0.6, 0.8, 0.9);
    const lp = filter(ctx, 'lowpass', Math.min(9000, f * 4), 0.8);
    for (const d of [-12, 0, 12]) osc(ctx, 'sawtooth', f, t, end, d).connect(lp);
    osc(ctx, 'triangle', f / 2, t, end).connect(lp);
    chain(lp, g, out);
  } },
  pluck: { name: 'Pluck', view: 60, play(ctx, out, t, dur, f, v) {
    const [g, end] = adsr(ctx, t, Math.min(dur, 0.05), v * 0.3, 0.002, 0.3, 0, 0.25);
    const lp = filter(ctx, 'lowpass', 400, 3);
    lp.frequency.setValueAtTime(Math.min(16000, f * 12), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(200, f * 1.5), t + 0.25);
    osc(ctx, 'square', f, t, end).connect(lp);
    osc(ctx, 'triangle', f * 2, t, end).connect(lp);
    chain(lp, g, out);
  } },
  bassgtr: { name: 'Bass guitar', view: 28, play: (ctx, out, t, dur, f, v) => stringNote(ctx, out, 'bassgtr', t, dur, f, v) },
  electric: { name: 'Electric guitar', view: 40, strum: true, play: (ctx, out, t, dur, f, v) => stringNote(ctx, out, 'electric', t, dur, f, v) },
  acoustic: { name: 'Acoustic guitar', view: 40, strum: true, play: (ctx, out, t, dur, f, v) => stringNote(ctx, out, 'acoustic', t, dur, f, v) },
  keys: { name: 'Keys', view: 48, play(ctx, out, t, dur, f, v) {
    const [g, end] = adsr(ctx, t, dur, v * 0.28, 0.004, 1.1, 0.22, 0.3);
    osc(ctx, 'sine', f, t, end).connect(g);
    const bell = ctx.createGain(); bell.gain.setValueAtTime(0.35, t); bell.gain.exponentialRampToValueAtTime(0.01, t + 0.4);
    chain(osc(ctx, 'sine', f * 3, t, end), bell, g);
    const body = ctx.createGain(); body.gain.value = 0.25;
    chain(osc(ctx, 'triangle', f * 2, t, end), body, g);
    g.connect(out);
  } },
};

// ---------------------------------------------------------------- beats, patterns, rows
const emptyHits = () => new Array(MAX_STEPS).fill(0);
const hitsFrom = (on = []) => { const s = emptyHits(); for (const i of on) s[i] = 1; return s; };
const pattern = (b, id = b.pat) => b.patterns.find((p) => p.id === id) || b.patterns[0];
/** A drum row's hits in a pattern (read only: an empty one when it has none yet). */
const hitsIn = (r, pid) => r.pats?.[pid] || NONE;
const notesIn = (r, pid) => r.notes?.[pid] || NONE;
/** The same, made if missing, for changing. */
const ownHits = (r, pid) => (r.pats[pid] ||= emptyHits());
const ownNotes = (r, pid) => (r.notes[pid] ||= []);

const NO_FX = () => ({ rev: 0, dly: 0, drive: 0, tone: 0 });
const baseRow = (name) => ({ id: uid(), name, kind: 'drum', sound: null, synth: null, view: 48, sample: null, vol: 0.8, pan: 0, pitch: 0, mute: false, solo: false, fx: NO_FX(), pats: {}, notes: {} });
const newRow = (sound, pid, on) => { const r = { ...baseRow(KIT[sound]?.name || 'Sound'), sound }; if (pid && on) r.pats[pid] = hitsFrom(on); return r; };
const newSynthRow = (k) => ({ ...baseRow(SYNTHS[k].name), kind: 'synth', synth: k, view: SYNTHS[k].view, vol: 0.7 });
const newPattern = (name, steps = 16) => ({ id: uid(), name, steps });
const KIT_ORDER = ['kick', 'snare', 'clap', 'hat', 'openhat', 'tom', 'rim', 'bass808'];
const BEAT_DEFAULTS = { bpm: 120, swing: 0, master: 0.8, humanize: 0, comp: 0, key: 9, scale: 'minor', song: [], songMode: false };

function newBeat(name, starter = false) {
  const p = newPattern('A');
  const on = starter ? { kick: [0, 7, 10], clap: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], openhat: [15], bass808: [0, 10] } : {};
  return { id: uid(), name, ...BEAT_DEFAULTS, song: [], patterns: [p], pat: p.id, rows: KIT_ORDER.map((k) => newRow(k, p.id, on[k])) };
}

/** Brings a saved beat up to date: a beat from before patterns becomes pattern A, its rows' steps that pattern's hits. */
function upgrade(b) {
  for (const [k, v] of Object.entries(BEAT_DEFAULTS)) if (b[k] == null) b[k] = Array.isArray(v) ? [] : v;
  if (!Array.isArray(b.patterns) || !b.patterns.length) b.patterns = [{ id: uid(), name: 'A', steps: STEP_COUNTS.includes(b.steps) ? b.steps : 16 }];
  if (!b.patterns.some((p) => p.id === b.pat)) b.pat = b.patterns[0].id;
  b.song = b.song.filter((id) => b.patterns.some((p) => p.id === id));
  delete b.steps;
  for (const r of b.rows) {
    r.kind = r.kind === 'synth' ? 'synth' : 'drum';
    r.fx = { ...NO_FX(), ...(r.fx || {}) };
    r.pats = r.pats && typeof r.pats === 'object' ? r.pats : {};
    r.notes = r.notes && typeof r.notes === 'object' ? r.notes : {};
    if (Array.isArray(r.steps)) { if (!r.pats[b.patterns[0].id]) r.pats[b.patterns[0].id] = r.steps; delete r.steps; }
    for (const k of Object.keys(r.pats)) r.pats[k] = [...r.pats[k], ...emptyHits()].slice(0, MAX_STEPS);
    if (r.kind === 'synth' && !SYNTHS[r.synth]) r.synth = 'bass';
    if (r.view == null) r.view = SYNTHS[r.synth]?.view ?? 48;
  }
  return b;
}

// ---------------------------------------------------------------- presets: a beat to start from
// drums: one character a step (x hit, o soft hit); parts: [step, semitones above the key's root, length in steps]
// (an array of semitones for a chord), on top of `oct` (the octave's C, as a MIDI note)
const PRESETS = {
  boombap: { name: 'Boom bap', bpm: 90, swing: 0.28, key: 2, scale: 'minor', drums: {
    kick: 'x......x..x.....', snare: '....x.......x..o', hat: 'x.o.x.o.x.o.x.o.', openhat: '..............x.' },
    parts: [{ synth: 'bass', oct: 36, notes: [[0, 0, 4], [7, 0, 2], [10, 3, 3], [14, -2, 2]] },
      { synth: 'keys', oct: 48, notes: [[0, [0, 3, 7, 10], 8], [8, [-2, 2, 5, 8], 8]] }] },
  trap: { name: 'Trap', bpm: 140, swing: 0, key: 1, scale: 'harmonic minor', drums: {
    kick: 'x......x..x.....', clap: '........x.......', hat: 'xoxoxxxoxoxoxxxx', openhat: '...........x....', bass808: 'x......x..x.....' },
    parts: [{ synth: 'pluck', oct: 60, notes: [[0, 7, 2], [3, 8, 1], [4, 7, 2], [6, 3, 2], [8, 0, 2], [11, 3, 1], [12, 2, 2], [14, -1, 2]] }] },
  house: { name: 'House', bpm: 124, swing: 0.08, key: 5, scale: 'minor', drums: {
    kick: 'x...x...x...x...', clap: '....x.......x...', hat: 'oooooooooooooooo', openhat: '..x...x...x...x.' },
    parts: [{ synth: 'bass', oct: 36, notes: [[2, 0, 1], [6, 0, 1], [10, 0, 1], [14, 3, 1]] },
      { synth: 'pad', oct: 48, notes: [[0, [0, 3, 7], 16]] }] },
  techno: { name: 'Techno', bpm: 132, swing: 0, key: 9, scale: 'phrygian', drums: {
    kick: 'x...x...x...x...', openhat: '..x...x...x...x.', rim: 'x..x..x..x..x...', hat: 'oxoooxoooxoooxoo', clap: '....x.......x...' },
    parts: [{ synth: 'bass', oct: 36, notes: [[1, 0, 1], [2, 0, 1], [3, 12, 1], [5, 0, 1], [6, 0, 1], [7, 1, 1], [9, 0, 1], [10, 0, 1], [11, 12, 1], [13, 0, 1], [14, 0, 1], [15, 1, 1]] }] },
  dnb: { name: 'Drum & bass', bpm: 174, swing: 0, key: 4, scale: 'minor', drums: {
    kick: 'x.........x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.xo', shaker: 'oooooooooooooooo' },
    parts: [{ synth: 'bass', oct: 36, notes: [[0, 0, 6], [6, -2, 4], [10, 3, 6]] },
      { synth: 'pad', oct: 48, notes: [[0, [0, 3, 7, 10], 16]] }] },
  lofi: { name: 'Lo-fi', bpm: 80, swing: 0.35, key: 5, scale: 'major', drums: {
    kick: 'x.....x...x.....', snare: '....x.......x...', hat: 'x.o.x.o.x.o.x.oo', shaker: '..o...o...o...o.' },
    parts: [{ synth: 'keys', oct: 48, notes: [[0, [0, 4, 7, 11], 8], [8, [5, 9, 12, 16], 8]] },
      { synth: 'bass', oct: 36, notes: [[0, 0, 5], [6, 7, 2], [8, 5, 5], [14, 4, 2]] }] },
  reggaeton: { name: 'Reggaeton', bpm: 95, swing: 0, key: 7, scale: 'minor', drums: {
    kick: 'x...x...x...x...', snare: '...x..x....x..x.', hat: 'x.x.x.x.x.x.x.x.', rim: '..o...o...o...o.' },
    parts: [{ synth: 'bass', oct: 36, notes: [[0, 0, 3], [3, 0, 1], [6, 0, 2], [8, -4, 3], [11, -4, 1], [14, -2, 2]] },
      { synth: 'pluck', oct: 60, notes: [[0, 7, 1], [3, 3, 1], [6, 7, 1], [8, 8, 1], [11, 3, 1], [14, 5, 1]] }] },
  funk: { name: 'Funk', bpm: 104, swing: 0.12, key: 4, scale: 'dorian', drums: {
    kick: 'x..x..x...x..x..', snare: 'o...x..o.o..x..o', hat: 'xoxoxoxoxoxoxoxo', cowbell: '..x.......x.....' },
    parts: [{ synth: 'bass', oct: 36, notes: [[0, 0, 1], [3, 12, 1], [4, 10, 1], [6, 0, 2], [10, 7, 1], [11, 10, 1], [13, 12, 1], [14, 0, 1]] },
      { synth: 'keys', oct: 60, notes: [[2, [0, 3, 7, 10], 1], [7, [0, 3, 7, 10], 1], [12, [2, 5, 9], 2]] }] },
};

function presetBeat(name, key) {
  const pr = PRESETS[key];
  const b = newBeat(name);
  if (!pr) return b;
  Object.assign(b, { bpm: pr.bpm, swing: pr.swing, key: pr.key, scale: pr.scale });
  const p = b.pat;
  // the kit rows the preset uses, in the usual order, plus any others it asks for
  const sounds = [...KIT_ORDER.filter((k) => pr.drums[k]), ...Object.keys(pr.drums).filter((k) => !KIT_ORDER.includes(k))];
  b.rows = sounds.map((k) => {
    const r = newRow(k, p);
    r.pats[p] = emptyHits();
    [...pr.drums[k]].forEach((c, i) => { if (c === 'x') r.pats[p][i] = 1; else if (c === 'o') r.pats[p][i] = SOFT; });
    return r;
  });
  for (const part of pr.parts) {
    const r = newSynthRow(part.synth);
    const root = part.oct + pr.key;
    r.notes[p] = part.notes.flatMap(([s, iv, l]) => (Array.isArray(iv) ? iv : [iv]).map((x) => ({ s, n: root + x, l, v: 1 })));
    r.view = Math.min(...r.notes[p].map((n) => n.n)) - ((Math.min(...r.notes[p].map((n) => n.n)) % 12) + 12) % 12;
    b.rows.push(r);
  }
  return b;
}

// ---------------------------------------------------------------- the dice
const chance = (p) => Math.random() < p;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
/** How likely a hit is on step i (16ths, i % 16), by sound. */
const DRUM_ODDS = {
  kick: (i) => (i % 8 === 0 ? 0.95 : i % 4 === 0 ? 0.25 : i % 2 === 0 ? 0.22 : 0.1),
  snare: (i) => (i % 8 === 4 ? 0.95 : i % 2 ? 0.08 : 0.05),
  clap: (i) => (i % 8 === 4 ? 0.9 : 0.04),
  hat: (i) => (i % 2 === 0 ? 0.9 : 0.4),
  openhat: (i) => (i % 4 === 2 ? 0.3 : 0.03),
  tom: (i) => (i % 16 >= 12 ? 0.25 : 0.05),
  rim: (i) => (i % 4 === 3 ? 0.35 : 0.1),
  cowbell: (i) => (i % 4 === 2 ? 0.2 : 0.05),
  bass808: (i) => (i % 8 === 0 ? 0.75 : i % 2 === 0 ? 0.15 : 0.06),
  shaker: (i) => (i % 2 === 0 ? 0.75 : 0.5),
  blip: () => 0.12,
};
function rollHits(r, n) {
  const odds = (!r.sample && DRUM_ODDS[r.sound]) || ((i) => (i % 4 === 0 ? 0.35 : 0.12));
  const s = emptyHits();
  for (let i = 0; i < n; i++) if (chance(odds(i % 16))) s[i] = chance(0.2) ? SOFT : 1;
  return s;
}
/** Notes in the beat's key and scale: chords for pads, arpeggios for plucks and keys, lines for bass and lead. */
function rollNotes(b, r, n) {
  const scale = SCALES[b.scale] || SCALES.minor;
  const base = r.view + (((b.key - r.view) % 12) + 12) % 12; // the key's root in the roll's lowest octave
  const deg = (d) => base + Math.floor(d / scale.length) * 12 + scale[((d % scale.length) + scale.length) % scale.length];
  const chordAt = (d) => [deg(d), deg(d + 2), deg(d + 4)];
  const out = [];
  const roots = [0, 3, 4, 5, 2].slice(0, 4).sort(() => Math.random() - 0.5);
  const guitar = r.synth === 'acoustic' || r.synth === 'electric';
  const bassy = r.synth === 'bass' || r.synth === 'bassgtr';
  if (r.synth === 'pad' || (r.synth === 'keys' && chance(0.5)) || (guitar && chance(0.5))) {
    const len = guitar ? Math.min(4, n) : n >= 16 ? 8 : n;
    for (let s = 0, k = 0; s < n; s += len, k++) for (const m of chordAt(k ? roots[k % roots.length] : 0)) out.push({ s, n: m, l: Math.min(len, n - s), v: 1 });
  } else if (r.synth === 'pluck' || r.synth === 'keys' || guitar) {
    const every = pick([1, 2, 2]);
    for (let s = 0; s < n; s += every) {
      const ch = chordAt(roots[Math.floor(s / 8) % roots.length]);
      if (chance(0.8)) out.push({ s, n: ch[(s / every) % 3] + (chance(0.2) ? 12 : 0), l: every, v: chance(0.25) ? SOFT : 1 });
    }
  } else {
    // a line: mostly steps through the scale, some leaps, the bass sitting on the root more
    let d = 0;
    for (let s = 0; s < n;) {
      const on = bassy ? (s % 4 === 0 ? 0.8 : 0.3) : (s % 2 === 0 ? 0.55 : 0.25);
      if (!chance(on)) { s++; continue; }
      const l = Math.min(n - s, pick(bassy ? [1, 1, 2, 3] : [1, 2, 2, 3, 4]));
      d = bassy && s % 8 === 0 ? 0 : clamp(d + pick([-2, -1, -1, 0, 1, 1, 2, 4]), -3, 9);
      out.push({ s, n: deg(d), l, v: chance(0.2) ? SOFT : 1 });
      s += l;
    }
  }
  return out;
}

// ---------------------------------------------------------------- effects
const IRS = new WeakMap();
/** A made-up room: two channels of noise dying away over a couple of seconds. */
function reverbIR(ctx) {
  let b = IRS.get(ctx);
  if (!b) {
    const len = Math.floor(ctx.sampleRate * 2.4);
    b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3.2;
    }
    IRS.set(ctx, b);
  }
  return b;
}
function driveCurve(a) {
  if (!a) return null;
  const k = 1 + a * 30, c = new Float32Array(1024), n = Math.tanh(k);
  for (let i = 0; i < 1024; i++) c[i] = Math.tanh(k * (i / 512 - 1)) / n;
  return c;
}
/** One knob from a low-pass (left) through open (middle) to a high-pass (right). */
function setTone(f, c, now) {
  const hp = c > 0.02, lp = c < -0.02;
  f.type = hp ? 'highpass' : 'lowpass';
  const hz = hp ? 20 * (5000 / 20) ** c : lp ? 20000 * (150 / 20000) ** -c : 20000;
  if (now == null) f.frequency.value = hz; else f.frequency.setTargetAtTime(hz, now, 0.02);
  f.Q.value = lp || hp ? 1.1 : 0.5;
}
function setComp(m, amt, now) {
  const at = (p, v) => (now == null ? (p.value = v) : p.setTargetAtTime(v, now, 0.03));
  at(m.comp.threshold, -amt * 28);
  at(m.comp.ratio, 1 + amt * 5);
  at(m.makeup.gain, 1 + amt * 0.9);
}
const echoTime = (b) => Math.min(1.9, 3 * stepLen(b)); // a dotted 8th

// ---------------------------------------------------------------- one beat as sound, live or rendered offline
/** Each row: gain → drive → filter → pan into the master, with sends to a shared reverb and echo; the master: a
 *  compressor (the Comp knob) and a gentle limiter. */
function buildMix(ctx, beat, dest) {
  const master = ctx.createGain();
  master.gain.value = beat.master;
  const comp = ctx.createDynamicsCompressor();
  comp.knee.value = 8; comp.attack.value = 0.01; comp.release.value = 0.2;
  const makeup = ctx.createGain();
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -6; lim.knee.value = 4; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.12;
  master.connect(comp).connect(makeup).connect(lim).connect(dest);
  const m = { master, comp, makeup, rows: new Map() };
  setComp(m, beat.comp);
  // the shared reverb and echo
  m.revIn = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.buffer = reverbIR(ctx);
  m.revIn.connect(conv).connect(master);
  m.dlyIn = ctx.createGain();
  m.delay = ctx.createDelay(2);
  m.delay.delayTime.value = echoTime(beat);
  const fb = ctx.createGain(); fb.gain.value = 0.38;
  const dlp = filter(ctx, 'lowpass', 4200);
  m.dlyIn.connect(m.delay).connect(dlp).connect(fb).connect(m.delay);
  dlp.connect(master);
  for (const r of beat.rows) {
    const g = ctx.createGain(), drive = ctx.createWaveShaper(), tf = ctx.createBiquadFilter(), pan = ctx.createStereoPanner();
    const rs = ctx.createGain(), ds = ctx.createGain();
    g.gain.value = r.vol; pan.pan.value = r.pan;
    drive.curve = driveCurve(r.fx.drive); drive.oversample = '2x';
    setTone(tf, r.fx.tone);
    rs.gain.value = r.fx.rev; ds.gain.value = r.fx.dly * 0.8;
    g.connect(drive).connect(tf).connect(pan).connect(master);
    pan.connect(rs).connect(m.revIn);
    pan.connect(ds).connect(m.dlyIn);
    m.rows.set(r.id, { g, drive, tf, pan, rs, ds, driveAt: r.fx.drive });
  }
  return m;
}
const audible = (beat, r) => !r.mute && (!beat.rows.some((x) => x.solo) || r.solo);
const stepLen = (beat) => 60 / beat.bpm / 4;
/** When step i sounds, from the bar's start: odd 16ths are pushed late by the swing. */
const stepAt = (beat, i) => i * stepLen(beat) + (i % 2 ? beat.swing * stepLen(beat) * 0.5 : 0);

function playHit(ctx, out, r, t, vel, buffers) {
  const p = 2 ** (r.pitch / 12);
  if (r.sample) {
    const buf = buffers.get(r.sample.path);
    if (!buf) return;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = p;
    const g = ctx.createGain(); g.gain.value = vel;
    s.connect(g).connect(out);
    s.start(t);
  } else (KIT[r.sound] || KIT.kick).play(ctx, out, t, vel, p);
}
const playNote = (ctx, out, r, t, dur, midi, vel) => (SYNTHS[r.synth] || SYNTHS.bass).play(ctx, out, t, dur, mtof(midi + r.pitch), vel);

/** Humanize: a little early or late, a little softer, by up to the beat's amount. */
function human(b, t, v) {
  if (!b.humanize) return [t, v];
  return [t + (Math.random() - 0.5) * b.humanize * 0.024, v * (1 - Math.random() * b.humanize * 0.35)];
}
/** Everything that sounds on step i of pattern p, at time t. */
function playStep(ctx, mix, b, p, i, t, buffers) {
  const len = stepLen(b);
  for (const r of b.rows) {
    if (!audible(b, r)) continue;
    const out = mix.rows.get(r.id)?.g;
    if (!out) continue;
    if (r.kind === 'synth') {
      const here = notesIn(r, p.id).filter((n) => n.s === i);
      if (SYNTHS[r.synth]?.strum) here.sort((a, c) => a.n - c.n);
      here.forEach((n, k) => {
        const [tt, vv] = human(b, t, n.v);
        playNote(ctx, out, r, Math.max(tt, t - 0.004) + (SYNTHS[r.synth]?.strum ? k * 0.014 : 0), n.l * len * 0.97, n.n, vv);
      });
    } else {
      const v = hitsIn(r, p.id)[i];
      if (v) { const [tt, vv] = human(b, t, v); playHit(ctx, out, r, Math.max(tt, t - 0.004), vv, buffers); }
    }
  }
}

export class BeatEditor extends BaseEditor {
  static mode = 'beat';

  async load() {
    this.buffers = new Map(); // sample path → AudioBuffer
    this.undoStack = [];
    this.redoStack = [];
    this.root = h('div', { class: 'todo-root beat-root' });
    this.pane.append(this.root);
    const d = await fetch('/api/beats', { headers: T() }).then((r) => r.json()).catch(() => ({ beats: [] }));
    this.beats = (d.beats || []).map(upgrade);
    this.lines = Array.isArray(d.lines) ? d.lines : []; // saved lines: a row's pattern kept to add to any pattern
    try { this.sideTab = localStorage.getItem('bds-beat-side') === 'lines' ? 'lines' : 'beats'; } catch { this.sideTab = 'beats'; }
    if (!this.beats.length) this.beats.push(newBeat('Beat 1', true));
    this.active = this.beats.some((b) => b.id === d.active) ? d.active : this.beats[0].id;
    this.render();
    this.loadSamples();
    this.keyHandler = (e) => this.onKey(e);
    document.addEventListener('keydown', this.keyHandler);
  }

  get beat() { return this.beats.find((b) => b.id === this.active) || this.beats[0]; }
  get pat() { return pattern(this.beat); }

  save(now = false) {
    clearTimeout(this.saveTimer);
    const run = () => fetch('/api/beats', { method: 'POST', headers: { ...T(), 'Content-Type': 'application/json' }, body: JSON.stringify({ beats: this.beats, active: this.active, lines: this.lines }) })
      .then((r) => { if (!r.ok) throw new Error(); }).catch(() => toast('Couldn’t save your beats.', { type: 'error' }));
    if (now) return run();
    this.saveTimer = setTimeout(run, 500);
  }

  /** Before a change to the beat: what Ctrl+Z goes back to. */
  remember() {
    this.undoStack.push({ id: this.beat.id, json: JSON.stringify(this.beat) });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() { this.swapState(this.undoStack, this.redoStack); }
  redo() { this.swapState(this.redoStack, this.undoStack); }
  swapState(from, to) {
    const s = from.pop();
    if (!s) return;
    const at = this.beats.findIndex((b) => b.id === s.id);
    if (at < 0) return this.swapState(from, to);
    to.push({ id: s.id, json: JSON.stringify(this.beats[at]) });
    this.beats[at] = JSON.parse(s.json);
    this.active = s.id;
    this.changed(true);
  }

  changed(full = false) {
    this.save();
    if (full) this.render();
    this.syncMix();
    this.refreshStatus();
  }

  // ---------------------------------------------------------------- audio
  get ctx() {
    if (!this.actx) this.actx = new AudioContext({ latencyHint: 'interactive' });
    return this.actx;
  }

  restartMix() {
    if (this.mix) { try { this.mix.master.disconnect(); } catch { /* gone */ } }
    this.mix = buildMix(this.ctx, this.beat, this.ctx.destination);
  }
  /** Volume, pan, effects and master changes, without rebuilding. */
  syncMix() {
    if (!this.mix) return;
    const now = this.ctx.currentTime, b = this.beat;
    this.mix.master.gain.setTargetAtTime(b.master, now, 0.02);
    setComp(this.mix, b.comp, now);
    this.mix.delay.delayTime.setTargetAtTime(echoTime(b), now, 0.05);
    for (const r of b.rows) {
      const m = this.mix.rows.get(r.id);
      if (!m) return this.restartMix();
      m.g.gain.setTargetAtTime(r.vol, now, 0.02);
      m.pan.pan.setTargetAtTime(r.pan, now, 0.02);
      m.rs.gain.setTargetAtTime(r.fx.rev, now, 0.03);
      m.ds.gain.setTargetAtTime(r.fx.dly * 0.8, now, 0.03);
      setTone(m.tf, r.fx.tone, now);
      if (m.driveAt !== r.fx.drive) { m.drive.curve = driveCurve(r.fx.drive); m.driveAt = r.fx.drive; }
    }
    // a tempo or swing change carries on from the step just played instead of jumping
    if (this.playing && this.lastSched) {
      const [t, i] = this.lastSched, p = this.playPat;
      // the step just played was the last bar's when the next one starts the bar again
      this.barStart = t - stepAt(b, i) + (i >= this.nextStep ? p.steps * stepLen(b) : 0);
    }
  }

  async loadSamples() {
    const want = new Set(this.beats.flatMap((b) => b.rows.filter((r) => r.sample).map((r) => r.sample.path)));
    for (const p of want) await this.loadSample(p);
  }
  async loadSample(p) {
    if (this.buffers.has(p)) return this.buffers.get(p);
    try {
      const res = await fetch(`/api/stream?token=${encodeURIComponent(api.token)}&path=${encodeURIComponent(p)}`);
      if (!res.ok) throw new Error();
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.buffers.set(p, buf);
      this.renderRows();
      return buf;
    } catch {
      this.buffers.set(p, null);
      this.renderRows();
      return null;
    }
  }

  /** A row's sound on its own (a synth plays the key's root, or the note given). */
  preview(r, vel = 0.9, midi) {
    if (!this.mix) this.restartMix();
    this.ctx.resume();
    const out = this.mix.rows.get(r.id)?.g;
    if (!out) return;
    const t = this.ctx.currentTime + 0.01;
    if (r.kind === 'synth') playNote(this.ctx, out, r, t, 0.3, midi ?? r.view + 12 + (((this.beat.key - r.view) % 12) + 12) % 12, vel);
    else playHit(this.ctx, out, r, t, vel, this.buffers);
  }

  togglePlay() { return this.playing ? this.stop() : this.play(); }
  play() {
    const ctx = this.ctx, b = this.beat;
    ctx.resume();
    this.restartMix();
    this.playing = true;
    this.barStart = ctx.currentTime + 0.06;
    this.nextStep = 0;
    this.songPos = 0;
    this.songShown = -1;
    this.playPat = b.songMode && b.song.length ? pattern(b, b.song[0]) : this.pat;
    this.shown = [];
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
    const frame = () => { if (!this.playing) return; this.drawPlayhead(); this.raf = requestAnimationFrame(frame); };
    this.raf = requestAnimationFrame(frame);
    this.renderTransport();
    this.refreshStatus();
  }
  stop() {
    this.playing = false;
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    if (this.mix) { const m = this.mix.master; m.gain.setTargetAtTime(0, this.ctx.currentTime, 0.015); setTimeout(() => { try { m.disconnect(); } catch { /* gone */ } }, 120); this.mix = null; }
    this.songShown = -1;
    this.setPlayhead(-1);
    this.renderTransport();
    this.renderArrange();
    this.refreshStatus();
  }
  /** The pattern after this bar: the song's next, or (playing a pattern) whichever is picked now. */
  nextPattern() {
    const b = this.beat;
    if (b.songMode && b.song.length) { this.songPos = (this.songPos + 1) % b.song.length; return pattern(b, b.song[this.songPos]); }
    return this.pat;
  }
  /** Schedules the steps that start in the next moment (further ahead while the window is hidden: its timers slow down). */
  tick() {
    const b = this.beat, ctx = this.ctx;
    const ahead = ctx.currentTime + (document.hidden ? 1.6 : 0.12);
    for (;;) {
      if (this.nextStep >= this.playPat.steps) { this.barStart += this.playPat.steps * stepLen(b); this.nextStep = 0; this.playPat = this.nextPattern(); }
      const t = this.barStart + stepAt(b, this.nextStep);
      if (t > ahead) break;
      if (t >= ctx.currentTime - 0.01) {
        if (this.mix) playStep(ctx, this.mix, b, this.playPat, this.nextStep, t, this.buffers);
        this.shown.push([t, this.nextStep, this.playPat.id, b.songMode && b.song.length ? this.songPos : -1]);
        this.lastSched = [t, this.nextStep];
      }
      this.nextStep++;
    }
  }
  drawPlayhead() {
    const now = this.ctx.currentTime;
    let cur = null;
    while (this.shown.length && this.shown[0][0] <= now) cur = this.shown.shift();
    if (!cur) return;
    const [, i, pid, pos] = cur, b = this.beat;
    // playing the song, the grid follows it from pattern to pattern
    if (pid !== b.pat && b.patterns.some((p) => p.id === pid)) { b.pat = pid; this.head = -1; this.renderTransport(); this.renderRows(); this.refreshStatus(); }
    if (pos !== this.songShown) { this.songShown = pos; this.renderArrange(); }
    this.setPlayhead(i);
  }
  setPlayhead(i) {
    if (this.head === i) return;
    this.head = i;
    for (const el of this.grid?.querySelectorAll('.beat-step.now, .beat-roll-col.now') || []) el.classList.remove('now');
    if (i >= 0) for (const el of this.grid?.querySelectorAll(`.beat-step[data-i="${i}"], .beat-roll-col[data-i="${i}"]`) || []) el.classList.add('now');
  }

  // ---------------------------------------------------------------- export
  /** The patterns in `seq`, `loops` times over, rendered offline (with the last notes' tail, up to where it goes quiet). */
  async renderOffline(beat, seq, loops) {
    const rate = 44100, tail = 4;
    const bars = [];
    for (let l = 0; l < loops; l++) for (const id of seq) bars.push(pattern(beat, id));
    const len = bars.reduce((a, p) => a + p.steps * stepLen(beat), 0);
    const ctx = new OfflineAudioContext(2, Math.ceil((len + tail) * rate), rate);
    const mix = buildMix(ctx, beat, ctx.destination);
    let t0 = 0;
    for (const p of bars) {
      for (let i = 0; i < p.steps; i++) playStep(ctx, mix, beat, p, i, t0 + stepAt(beat, i) + 0.0001, this.buffers);
      t0 += p.steps * stepLen(beat);
    }
    const buf = await ctx.startRendering();
    // trim the tail where it's gone silent (never into the music itself)
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    let end = buf.length;
    const min = Math.ceil(len * rate);
    while (end > min && Math.abs(L[end - 1]) < 0.0005 && Math.abs(R[end - 1]) < 0.0005) end--;
    return { buf, end };
  }

  async exportDialog() {
    const b = this.beat;
    const song = b.songMode && b.song.length > 0;
    const ffmpeg = !!(await api.tools().catch(() => ({})))?.ffmpeg;
    const loops = h('select', {}, [1, 2, 4, 8, 16].map((n) => h('option', { value: n, selected: n === (song ? 1 : 4) }, `${n} time${n === 1 ? '' : 's'}`)));
    const fmt = h('select', {}, h('option', { value: 'mp3', disabled: !ffmpeg, selected: ffmpeg }, 'MP3' + (ffmpeg ? '' : ' (needs ffmpeg)')), h('option', { value: 'wav', selected: !ffmpeg }, 'WAV'));
    const name = h('input', { type: 'text', value: b.name, maxlength: '120' });
    const go = await modal({
      title: 'Export to the audio dump',
      body: h('div', { class: 'beat-export' },
        h('label', {}, h('span', {}, 'Name'), name),
        h('label', {}, h('span', {}, song ? 'Play the song' : `Play pattern ${this.pat.name}`), loops),
        h('label', {}, h('span', {}, 'Format'), fmt),
        h('div', { class: 'faint' }, 'It shows up in the Music player like any other song.')),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Export', value: true, primary: true }],
    });
    if (!go) return;
    const n = +loops.value, kind = fmt.value, base = (name.value.trim() || b.name).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Beat';
    const t = toast('Rendering the beat…', { timeout: 0 });
    try {
      for (const r of b.rows) if (r.sample) await this.loadSample(r.sample.path);
      const { buf, end } = await this.renderOffline(b, song ? b.song : [b.pat], n);
      const wav = wavFrom(buf, end);
      const w = await api.dumpAdd(`${base}.wav`, wav, 'audio');
      let saved = w.name;
      if (kind === 'mp3') {
        try {
          const r = await api.dumpReserve(`${base}.mp3`, 'audio');
          await api.post('/api/render/clip-audio', { path: w.path, start: 0, len: end / buf.sampleRate + 0.01, volume: 1, output: r.path });
          await api.dumpRemove(w.name, 'audio');
          saved = basename(r.path);
        } catch (e) { errorToast(e, 'Making the MP3 (the WAV is kept)'); }
      }
      t?.();
      toast(`Saved ${basename(saved)} to the audio dump.`, { type: 'ok' });
    } catch (e) { t?.(); errorToast(e, 'Exporting the beat'); }
  }

  // ---------------------------------------------------------------- the beats down the side
  render() {
    clear(this.root).append(
      this.side = h('div', { class: 'todo-side' }),
      this.main = h('div', { class: 'beat-main' }));
    this.renderSide();
    this.renderMain();
  }

  renderSide() {
    const tab = this.sideTab === 'lines' ? 'lines' : 'beats';
    const tabs = h('div', { class: 'beat-tabs' },
      ...[['beats', 'Beats', 'drum'], ['lines', 'Lines', 'list-ordered']].map(([k, label, ic]) => h('button', { class: 'beat-tab' + (tab === k ? ' active' : ''), onclick: () => this.setSideTab(k) }, icon(ic, 'sm'), label)));
    if (tab === 'lines') {
      const p = this.pat;
      clear(this.side).append(tabs,
        h('div', { class: 'beat-lines-hint faint' }, this.lines.length ? `Click a line to add it to pattern ${p.name}` : 'Right-click a row → “Save this line…” to keep it here, then add it to any pattern'),
        ...this.lines.map((l) => h('div', { class: 'todo-list beat-line', title: `Click to add it to pattern ${p.name} · right-click for more`,
          onclick: () => this.addLine(l), oncontextmenu: (e) => contextMenu(e, this.lineMenu(l)) },
        icon(l.kind === 'synth' ? 'keyboard' : 'drum', 'sm'),
        h('div', { class: 'beat-line-main' }, h('span', { class: 'todo-list-name' }, l.name), h('span', { class: 'beat-line-sub faint' }, `${l.steps} steps · ${l.kind === 'synth' ? SYNTHS[l.synth]?.name || 'Synth' : l.sample ? l.sample.name || 'Sample' : KIT[l.sound]?.name || 'Drum'}`)),
        h('button', { class: 'icon-btn', 'data-tip': 'Listen', onclick: (e) => { e.stopPropagation(); this.previewLine(l); } }, icon('play', 'sm')))));
      return;
    }
    clear(this.side).append(tabs,
      ...this.beats.map((b) => h('div', { class: 'todo-list' + (b.id === this.active ? ' active' : ''), title: 'Double-click to rename · right-click for more',
        onclick: () => this.select(b.id),
        ondblclick: () => this.renameBeat(b),
        oncontextmenu: (e) => contextMenu(e, [
          { label: 'Rename…', icon: 'edit', action: () => this.renameBeat(b) },
          { label: 'Duplicate', icon: 'copy', action: () => this.duplicateBeat(b) },
          { label: 'Delete beat', icon: 'trash', action: () => this.deleteBeat(b) },
        ]) },
      icon('drum', 'sm'), h('span', { class: 'todo-list-name' }, b.name), h('span', { class: 'todo-count mono' }, Math.round(b.bpm)))),
      h('button', { class: 'btn sm ghost todo-new-list', onclick: () => this.newBeatPrompt() }, icon('plus', 'sm'), 'New beat'));
  }

  setSideTab(k) {
    this.sideTab = k;
    try { localStorage.setItem('bds-beat-side', k); } catch { /* private window */ }
    this.renderSide();
  }

  // ---------------------------------------------------------------- saved lines
  /** The key's root in a row's lowest octave: what saved notes are measured from. */
  rootOf(view) { return view + (((this.beat.key - view) % 12) + 12) % 12; }

  /** Keep this row's part of the pattern as a line to use again. */
  async saveLine(r) {
    const p = this.pat, base = this.rootOf(r.view), synth = r.kind === 'synth';
    const name = ((await promptDialog('Save this line', 'Name', r.name)) || '').trim();
    if (!name) return;
    this.lines.unshift({
      id: uid(), name, kind: r.kind, sound: r.sound, synth: r.synth, sample: r.sample ? { ...r.sample } : null, view: r.view, steps: p.steps, saved: Date.now(),
      vol: r.vol, pan: r.pan, pitch: r.pitch, fx: { ...r.fx },
      hits: synth ? [] : hitsIn(r, p.id).slice(0, p.steps),
      notes: synth ? notesIn(r, p.id).map((n) => ({ s: n.s, n: n.n - base, l: n.l, v: n.v })) : [],
    });
    this.save();
    this.setSideTab('lines');
    toast(`Saved “${name}” under Lines`, { type: 'ok' });
  }

  /** A saved line as a new row in the pattern you're on (repeated to fill it, or cut to fit). */
  addLine(l) {
    const b = this.beat, p = this.pat;
    if (b.rows.length >= 64) return toast('That’s as many sounds as one beat holds.', { type: 'warn' });
    this.remember();
    const r = { ...baseRow(l.name), kind: l.kind, sound: l.sound, synth: l.synth, sample: l.sample ? { ...l.sample } : null, view: l.view, vol: l.vol, pan: l.pan, pitch: l.pitch, fx: { ...NO_FX(), ...l.fx } };
    if (l.kind === 'synth') {
      const base = this.rootOf(l.view), notes = [];
      for (let off = 0; off < p.steps; off += l.steps) for (const n of l.notes) {
        const st = n.s + off;
        if (st < p.steps) notes.push({ s: st, n: n.n + base, l: Math.min(n.l, p.steps - st), v: n.v });
      }
      r.notes[p.id] = notes;
      this.openRoll = r.id;
    } else {
      const hits = emptyHits();
      for (let i = 0; i < p.steps; i++) hits[i] = l.hits[i % l.steps] || 0;
      r.pats[p.id] = hits;
    }
    b.rows.push(r);
    this.changed(true);
    if (r.sample) this.loadSample(r.sample.path);
    toast(`Added “${l.name}” to pattern ${p.name}`, { timeout: 2000 });
  }

  /** Play a saved line once, at the beat's tempo and in its key. */
  previewLine(l) {
    if (!this.mix) this.restartMix();
    const ctx = this.ctx, len = stepLen(this.beat);
    ctx.resume();
    const t0 = ctx.currentTime + 0.05;
    const out = ctx.createGain(); out.gain.value = l.vol;
    out.connect(ctx.destination);
    const r = { kind: l.kind, sound: l.sound, synth: l.synth, sample: l.sample, pitch: l.pitch, view: l.view };
    if (l.kind === 'synth') {
      const base = this.rootOf(l.view), strum = SYNTHS[l.synth]?.strum, seen = new Map();
      for (const n of [...l.notes].sort((a, c) => a.n - c.n)) {
        const k = seen.get(n.s) || 0; seen.set(n.s, k + 1);
        playNote(ctx, out, r, t0 + n.s * len + (strum ? k * 0.014 : 0), n.l * len * 0.97, n.n + base, n.v);
      }
    } else l.hits.forEach((v, i) => { if (v) playHit(ctx, out, r, t0 + i * len, v, this.buffers); });
    setTimeout(() => { try { out.disconnect(); } catch { /* gone */ } }, (l.steps * len + 4) * 1000);
  }

  lineMenu(l) {
    return [
      { label: `Add to pattern ${this.pat.name}`, icon: 'plus', action: () => this.addLine(l) },
      { label: 'Listen', icon: 'play', action: () => this.previewLine(l) },
      { sep: true },
      { label: 'Rename…', icon: 'edit', action: async () => { const n = ((await promptDialog('Rename line', 'Name', l.name)) || '').trim(); if (n) { l.name = n; this.save(); this.renderSide(); } } },
      { label: 'Delete', icon: 'trash', action: () => { this.lines = this.lines.filter((x) => x !== l); this.save(); this.renderSide(); } },
    ];
  }

  select(id) {
    if (this.active === id) return;
    const was = this.playing;
    if (was) this.stop();
    this.active = id;
    this.openRoll = null;
    this.save(); this.render(); this.refreshStatus();
    if (was) this.play();
  }

  async newBeatPrompt() {
    const name = h('input', { type: 'text', value: `Beat ${this.beats.length + 1}`, maxlength: '120' });
    const from = h('select', {},
      h('option', { value: 'empty' }, 'An empty kit'),
      h('option', { value: 'starter' }, 'A simple starter beat'),
      h('optgroup', { label: 'A style' }, Object.entries(PRESETS).map(([k, p]) => h('option', { value: k }, `${p.name} · ${p.bpm} BPM`))));
    const go = await modal({
      title: 'New beat',
      body: h('div', { class: 'beat-export' }, h('label', {}, h('span', {}, 'Name'), name), h('label', {}, h('span', {}, 'Start from'), from)),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Make it', value: true, primary: true }],
      onOpen: () => setTimeout(() => { name.focus(); name.select(); }, 0),
    });
    if (!go) return;
    const n = name.value.trim() || `Beat ${this.beats.length + 1}`;
    const b = PRESETS[from.value] ? presetBeat(n, from.value) : newBeat(n, from.value === 'starter');
    this.beats.push(b);
    this.select(b.id);
  }
  duplicateBeat(b) {
    const c = JSON.parse(JSON.stringify(b));
    c.id = uid(); c.name = `${b.name} copy`;
    for (const r of c.rows) r.id = uid();
    this.beats.splice(this.beats.indexOf(b) + 1, 0, c);
    this.select(c.id);
  }
  async renameBeat(b) {
    const name = (await promptDialog('Rename beat', 'Name', b.name) || '').trim();
    if (!name || name === b.name) return;
    b.name = name;
    this.save(); this.render(); this.refreshStatus();
  }
  async deleteBeat(b) {
    if (!(await confirmDialog(`Delete “${b.name}”?`, 'Anything you exported to the audio dump stays.', { okLabel: 'Delete', danger: true }))) return;
    if (this.playing && b.id === this.active) this.stop();
    const at = this.beats.indexOf(b);
    this.beats.splice(at, 1);
    if (!this.beats.length) this.beats.push(newBeat('Beat 1'));
    if (this.active === b.id) this.active = this.beats[Math.max(0, at - 1)].id;
    this.save(); this.render(); this.refreshStatus();
    toast(`Deleted ${b.name}`, { action: { label: 'Undo', fn: () => { this.beats.splice(at, 0, b); this.active = b.id; this.save(); this.render(); this.refreshStatus(); } } });
  }

  // ---------------------------------------------------------------- the grid
  renderMain() {
    clear(this.main).append(
      this.transport = h('div', { class: 'beat-transport' }),
      this.arrange = h('div', { class: 'beat-arrange' }),
      this.grid = h('div', { class: 'beat-grid' }),
      h('div', { class: 'beat-foot' },
        h('button', { class: 'btn sm ghost', onclick: (e) => contextMenu(e, this.soundItems((k) => { this.remember(); this.beat.rows.push(newRow(k)); this.changed(true); }, {
          samples: true, synth: (k) => { this.remember(); const r = newSynthRow(k); this.beat.rows.push(r); this.openRoll = r.id; this.changed(true); } })) }, icon('plus', 'sm'), 'Add a sound'),
        h('span', { class: 'faint' }, 'Click or drag across steps · Shift+click for a softer hit · Space plays · drop a sound file on a row to use it · click a synth’s row to write its notes')));
    this.renderTransport();
    this.renderArrange();
    this.renderRows();
    this.wireGrid();
  }

  renderTransport() {
    if (!this.transport) return;
    const b = this.beat, p = this.pat;
    const num = (val, lo, hi, step, set, title, w = 58) => {
      const el = h('input', { type: 'number', class: 'beat-num mono', min: lo, max: hi, step, value: val, title, style: { width: w + 'px' } });
      el.addEventListener('change', () => { const v = clamp(+el.value || lo, lo, hi); el.value = v; this.remember(); set(v); this.changed(); this.renderSide(); });
      return el;
    };
    /** A slider for a 0–1 (or 0–max) setting, shown as a percentage. */
    const slider = (label, title, get, set, max = 100) => {
      const r = h('input', { type: 'range', min: 0, max, value: Math.round(get() * 100), title });
      const out = h('span', { class: 'mono faint beat-swing-out' }, `${Math.round(get() * 100)}%`);
      r.addEventListener('pointerdown', () => this.remember());
      r.addEventListener('input', () => { set(+r.value / 100); out.textContent = `${r.value}%`; this.changed(); });
      return h('label', { class: 'beat-field', title }, h('span', { class: 'faint' }, label), r, out);
    };
    const master = h('input', { type: 'range', min: 0, max: 150, value: Math.round(b.master * 100), title: 'Master volume' });
    master.addEventListener('pointerdown', () => this.remember());
    master.addEventListener('input', () => { b.master = +master.value / 100; this.changed(); });
    const stepsSel = h('select', { class: 'beat-sel', title: `Steps in pattern ${p.name} (4 to a beat)` }, STEP_COUNTS.map((n) => h('option', { value: n, selected: n === p.steps }, `${n} steps`)));
    stepsSel.addEventListener('change', () => { this.remember(); this.pat.steps = +stepsSel.value; this.changed(true); });
    const keySel = h('select', { class: 'beat-sel', title: 'Key: changing it moves every note with it' }, NOTE_NAMES.map((n, i) => h('option', { value: i, selected: i === b.key }, n)));
    keySel.addEventListener('change', () => this.setKey(+keySel.value));
    const scaleSel = h('select', { class: 'beat-sel', title: 'Scale: the notes the piano roll marks, and the dice use' }, Object.keys(SCALES).map((s) => h('option', { value: s, selected: s === b.scale }, s)));
    scaleSel.addEventListener('change', () => { this.remember(); b.scale = scaleSel.value; this.changed(); this.renderRows(); });
    clear(this.transport).append(
      h('button', { class: 'btn primary beat-play', title: 'Play / stop (Space)', onclick: () => this.togglePlay() }, icon(this.playing ? 'square' : 'play', 'sm'), this.playing ? 'Stop' : 'Play'),
      h('label', { class: 'beat-field' }, num(b.bpm, 40, 300, 1, (v) => { b.bpm = v; }, 'Tempo'), h('span', { class: 'faint' }, 'BPM')),
      h('button', { class: 'btn sm ghost', title: 'Tap the tempo', onclick: () => this.tap() }, 'Tap'),
      slider('Swing', 'Swing: pushes every other 16th late', () => b.swing, (v) => { b.swing = v; }, 75),
      slider('Humanize', 'Humanize: each hit and note a touch early or late, and a touch softer', () => b.humanize, (v) => { b.humanize = v; }),
      h('label', { class: 'beat-field' }, h('span', { class: 'faint' }, 'Key'), keySel, scaleSel),
      stepsSel,
      h('label', { class: 'beat-field', title: 'Master volume' }, icon('volume', 'sm'), master),
      slider('Comp', 'Compressor on the whole beat: evens it out and makes it louder', () => b.comp, (v) => { b.comp = v; }),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn sm ghost', title: 'Roll the dice', onclick: (e) => contextMenu(e, [
        { label: `Randomize pattern ${p.name}`, icon: 'shuffle', action: () => this.roll((r) => true) },
        { label: 'Just the drums', icon: 'drum', action: () => this.roll((r) => r.kind !== 'synth') },
        { label: 'Just the notes', icon: 'music', action: () => this.roll((r) => r.kind === 'synth') },
      ]) }, icon('shuffle', 'sm'), 'Dice'),
      h('button', { class: 'btn sm ghost', title: `Clear every step in pattern ${p.name}`, onclick: () => { this.remember(); for (const r of b.rows) { delete r.pats[b.pat]; delete r.notes[b.pat]; } this.changed(true); } }, 'Clear'),
      h('button', { class: 'btn sm', onclick: () => this.exportDialog() }, icon('download', 'sm'), 'Export'));
  }

  /** The patterns, and the song made of them. */
  renderArrange() {
    if (!this.arrange) return;
    const b = this.beat;
    const pats = b.patterns.map((p) => h('button', { class: 'beat-chip' + (p.id === b.pat ? ' active' : ''), title: `Pattern ${p.name} · ${p.steps} steps · F2 or right-click to rename`, dataset: { pat: p.id },
      onclick: () => this.showPattern(p.id), oncontextmenu: (e) => this.patternMenu(e, p) }, p.name));
    if (b.patterns.length < MAX_PATTERNS) pats.push(h('button', { class: 'beat-chip add', title: 'A new, empty pattern', onclick: () => this.addPattern() }, icon('plus', 'sm')));
    const song = b.song.map((id, k) => {
      const p = pattern(b, id);
      return h('button', { class: 'beat-chip song' + (k === this.songShown ? ' now' : '') + (id === b.pat ? ' active' : ''), title: 'F2 renames the pattern · right-click for more', dataset: { pat: id },
        onclick: () => this.showPattern(id), oncontextmenu: (e) => this.songMenu(e, k) }, p.name);
    });
    song.push(h('button', { class: 'beat-chip add', title: `Add pattern ${this.pat.name} to the end of the song`, onclick: () => { this.remember(); b.song.push(b.pat); this.changed(); this.renderArrange(); } }, icon('plus', 'sm')));
    // Patterns and Song are the two ways to play: click one to switch to it
    const setMode = (song) => { if (b.songMode === song) return; this.remember(); b.songMode = song; this.changed(); if (this.playing) { this.stop(); this.play(); } this.renderArrange(); };
    clear(this.arrange).append(
      h('div', { class: 'beat-chips' + (b.songMode ? ' off' : '') },
        h('button', { class: 'btn sm beat-mode' + (b.songMode ? ' ghost' : ' primary'), title: b.songMode ? 'Click to loop just the pattern you’re on' : 'Looping one pattern', onclick: () => setMode(false) }, icon('drum', 'sm'), 'Patterns'), ...pats),
      h('div', { class: 'beat-chips' + (b.songMode ? '' : ' off') },
        h('button', { class: 'btn sm beat-mode' + (b.songMode ? ' primary' : ' ghost'), title: b.songMode ? 'Playing the song' : 'Click to play the song instead', onclick: () => setMode(true) }, icon('list-ordered', 'sm'), 'Song'),
        ...song,
        b.song.length ? null : h('span', { class: 'faint' }, 'Add patterns to string them together')));
  }

  showPattern(id) {
    const b = this.beat;
    if (b.pat === id) return;
    b.pat = id;
    this.head = -1;
    this.save();
    this.renderTransport(); this.renderArrange(); this.renderRows(); this.refreshStatus();
    if (this.sideTab === 'lines') this.renderSide();
  }
  addPattern(copyOf) {
    const b = this.beat;
    if (b.patterns.length >= MAX_PATTERNS) return;
    this.remember();
    const name = [...LETTERS].find((l) => !b.patterns.some((p) => p.name === l)) || String(b.patterns.length + 1);
    const p = newPattern(name, copyOf?.steps ?? this.pat.steps);
    b.patterns.splice(copyOf ? b.patterns.indexOf(copyOf) + 1 : b.patterns.length, 0, p);
    if (copyOf) for (const r of b.rows) {
      if (r.pats[copyOf.id]) r.pats[p.id] = [...r.pats[copyOf.id]];
      if (r.notes[copyOf.id]) r.notes[p.id] = r.notes[copyOf.id].map((n) => ({ ...n }));
    }
    b.pat = p.id;
    this.changed(true);
  }
  async renamePattern(p) {
    const n = ((await promptDialog('Rename pattern', 'Name', p.name)) || '').trim().slice(0, 12);
    if (!n) return;
    this.remember(); p.name = n; this.changed(true);
  }
  patternMenu(e, p) {
    const b = this.beat;
    contextMenu(e, [
      { label: 'Rename…', icon: 'edit', shortcut: 'F2', action: () => this.renamePattern(p) },
      { label: 'Duplicate', icon: 'copy', disabled: b.patterns.length >= MAX_PATTERNS, action: () => this.addPattern(p) },
      { label: 'Add to the song', icon: 'list-ordered', action: () => { this.remember(); b.song.push(p.id); this.changed(); this.renderArrange(); } },
      { label: 'Clear', icon: 'x', action: () => { this.remember(); for (const r of b.rows) { delete r.pats[p.id]; delete r.notes[p.id]; } this.changed(true); } },
      { sep: true },
      { label: 'Delete pattern', icon: 'trash', disabled: b.patterns.length < 2, action: () => {
        this.remember();
        b.patterns.splice(b.patterns.indexOf(p), 1);
        b.song = b.song.filter((id) => id !== p.id);
        for (const r of b.rows) { delete r.pats[p.id]; delete r.notes[p.id]; }
        if (b.pat === p.id) b.pat = b.patterns[0].id;
        this.changed(true);
        toast(`Deleted pattern ${p.name}`, { action: { label: 'Undo', fn: () => this.undo() } });
      } },
    ]);
  }
  songMenu(e, k) {
    const b = this.beat;
    const edit = (fn) => () => { this.remember(); fn(); this.changed(); this.renderArrange(); };
    contextMenu(e, [
      { label: 'Pattern', icon: 'layers', submenu: b.patterns.map((p) => ({ label: p.name, action: edit(() => { b.song[k] = p.id; }) })) },
      { label: 'Repeat it', icon: 'copy', action: edit(() => b.song.splice(k + 1, 0, b.song[k])) },
      { label: 'Move earlier', icon: 'arrow-left', disabled: !k, action: edit(() => b.song.splice(k - 1, 0, ...b.song.splice(k, 1))) },
      { label: 'Move later', icon: 'arrow-right', disabled: k === b.song.length - 1, action: edit(() => b.song.splice(k + 1, 0, ...b.song.splice(k, 1))) },
      { sep: true },
      { label: 'Take out of the song', icon: 'x', action: edit(() => b.song.splice(k, 1)) },
      { label: 'Clear the song', icon: 'trash', action: edit(() => { b.song = []; }) },
    ]);
  }

  /** A new key moves every note with it (by the shorter way round). */
  setKey(k) {
    const b = this.beat;
    let d = (((k - b.key) % 12) + 12) % 12;
    if (d > 6) d -= 12;
    this.remember();
    b.key = k;
    for (const r of b.rows) for (const list of Object.values(r.notes)) for (const n of list) n.n = clamp(n.n + d, 0, 127);
    this.changed();
    this.renderRows();
  }

  roll(which) {
    const b = this.beat, p = this.pat;
    this.remember();
    for (const r of b.rows) {
      if (!which(r) || r.mute) continue;
      if (r.kind === 'synth') r.notes[p.id] = rollNotes(b, r, p.steps);
      else r.pats[p.id] = rollHits(r, p.steps);
    }
    this.changed(true);
  }

  tap() {
    const now = performance.now();
    this.taps = (this.taps || []).filter((t) => now - t < 2500);
    this.taps.push(now);
    if (this.taps.length < 2) return;
    const gaps = this.taps.slice(1).map((t, i) => t - this.taps[i]);
    const bpm = clamp(Math.round(60000 / (gaps.reduce((a, c) => a + c, 0) / gaps.length)), 40, 300);
    if (this.taps.length === 2) this.remember();
    this.beat.bpm = bpm;
    this.changed(); this.renderTransport(); this.renderSide();
  }

  renderRows() {
    if (!this.grid) return;
    const b = this.beat, p = this.pat;
    const soloing = b.rows.some((r) => r.solo);
    const out = [];
    for (const r of b.rows) {
      const synth = r.kind === 'synth';
      const missing = r.sample && this.buffers.get(r.sample.path) === null;
      const vol = h('input', { type: 'range', class: 'beat-vol', min: 0, max: 150, value: Math.round(r.vol * 100), title: `Volume ${Math.round(r.vol * 100)}%` });
      vol.addEventListener('pointerdown', () => this.remember());
      vol.addEventListener('input', () => { r.vol = +vol.value / 100; vol.title = `Volume ${vol.value}%`; this.changed(); });
      const pan = h('input', { type: 'range', class: 'beat-pan', min: -100, max: 100, value: Math.round(r.pan * 100), title: 'Pan (double-click to centre)' });
      pan.addEventListener('pointerdown', () => this.remember());
      pan.addEventListener('input', () => { r.pan = +pan.value / 100; this.changed(); });
      pan.addEventListener('dblclick', () => { r.pan = 0; pan.value = 0; this.changed(); });
      const pitch = h('input', { type: 'number', class: 'beat-num beat-pitch mono', min: -24, max: 24, step: 1, value: r.pitch, title: synth ? 'Transpose, in semitones' : 'Pitch, in semitones' });
      pitch.addEventListener('change', () => { this.remember(); r.pitch = clamp(Math.round(+pitch.value || 0), -24, 24); pitch.value = r.pitch; this.changed(); this.preview(r); });
      const cells = [];
      if (synth) {
        // a synth's row shows where its notes start (and hold); clicking it opens the piano roll
        const starts = new Map(), held = new Set();
        for (const n of notesIn(r, p.id)) {
          if (!starts.has(n.s) || starts.get(n.s) > n.n) starts.set(n.s, n.n);
          for (let k = n.s + 1; k < n.s + n.l && k < p.steps; k++) held.add(k);
        }
        for (let i = 0; i < p.steps; i++) {
          const on = starts.has(i);
          cells.push(h('div', { class: `beat-step mini${on ? ' on' : held.has(i) ? ' held' : ''}${Math.floor(i / 4) % 2 ? ' odd' : ''}${i === this.head ? ' now' : ''}`, dataset: { i, row: r.id, synth: '1' } },
            on ? h('span', {}, noteName(starts.get(i)).replace(/\d+$/, '')) : null));
        }
      } else {
        const hits = hitsIn(r, p.id);
        for (let i = 0; i < p.steps; i++) {
          const v = hits[i];
          cells.push(h('div', { class: `beat-step${v ? ' on' : ''}${v && v < 1 ? ' soft' : ''}${Math.floor(i / 4) % 2 ? ' odd' : ''}${i === this.head ? ' now' : ''}`, dataset: { i, row: r.id } }));
        }
      }
      const fxOn = r.fx.rev || r.fx.dly || r.fx.drive || r.fx.tone;
      const row = h('div', { class: `beat-row${synth ? ' synth' : ''}${this.openRoll === r.id ? ' open' : ''}${r.mute || (soloing && !r.solo) ? ' quiet' : ''}${missing ? ' missing' : ''}`, dataset: { row: r.id } },
        h('button', { class: 'beat-ms' + (r.mute ? ' on' : ''), title: 'Mute', onclick: () => { this.remember(); r.mute = !r.mute; this.changed(true); } }, 'M'),
        h('button', { class: 'beat-ms solo' + (r.solo ? ' on' : ''), title: 'Solo', onclick: () => { this.remember(); r.solo = !r.solo; this.changed(true); } }, 'S'),
        h('button', { class: 'beat-name', title: missing ? `Couldn’t open ${r.sample.path}` : r.sample ? `${r.sample.path}\nClick to hear it · right-click for more` : 'Click to hear it · right-click for more',
          onclick: () => this.preview(r), oncontextmenu: (e) => this.rowMenu(e, r) },
        r.sample ? icon(missing ? 'alert' : 'music', 'sm') : synth ? icon('keyboard', 'sm') : null, h('span', {}, r.name)),
        h('div', { class: 'beat-steps', style: { gridTemplateColumns: `repeat(${p.steps}, minmax(14px, 1fr))` } }, cells),
        vol, pan, pitch,
        h('button', { class: 'beat-fx' + (fxOn ? ' on' : ''), title: 'Effects: reverb, echo, drive, filter', onclick: (e) => this.fxPopover(e.currentTarget, r) }, 'FX'),
        h('button', { class: 'icon-btn', 'data-tip': 'More', onclick: (e) => this.rowMenu(e, r) }, icon('more', 'sm')));
      // a sound file dropped on the row becomes its sample
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop'); });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', (e) => {
        e.preventDefault(); row.classList.remove('drop');
        const paths = draggedPaths(e);
        for (const f of e.dataTransfer.files) { const fp = window.bdsShell?.pathForFile?.(f); if (fp) paths.push(fp); }
        const fp = paths.find((x) => AUDIO_EXT.has(extOf(x).toLowerCase()));
        if (fp) this.setSample(r, fp); else if (paths.length) toast('That isn’t a sound file.', { type: 'warn' });
      });
      out.push(row);
      if (synth && this.openRoll === r.id) out.push(this.roll_(r, p));
    }
    clear(this.grid).append(...out);
    if (!b.rows.length) this.grid.append(h('div', { class: 'todo-empty' }, icon('drum'), h('div', {}, 'No sounds yet. Add one below.')));
  }

  /** The piano roll under a synth's row: two octaves of notes against the pattern's steps (wired in wireGrid). */
  roll_(r, p) {
    const b = this.beat;
    const lo = r.view, hi = lo + 24;
    const cover = new Map(); // "note:step" → the note there
    for (const n of notesIn(r, p.id)) for (let k = n.s; k < n.s + n.l; k++) cover.set(`${n.n}:${k}`, n);
    const lines = [];
    for (let m = hi; m >= lo; m--) {
      const black = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
      const root = (((m - b.key) % 12) + 12) % 12 === 0;
      const cls = `beat-roll-line${black ? ' black' : ''}${inScale(b, m) ? ' in' : ''}${root ? ' root' : ''}`;
      const cells = [];
      for (let i = 0; i < p.steps; i++) {
        const n = cover.get(`${m}:${i}`);
        cells.push(h('div', { class: `beat-roll-cell${Math.floor(i / 4) % 2 ? ' odd' : ''}${n ? ' on' : ''}${n && n.s === i ? ' start' : ''}${n && n.v < 1 ? ' soft' : ''}${n && n.s + n.l - 1 === i ? ' end' : ''}`, dataset: { i, n: m } }));
      }
      lines.push(h('div', { class: cls },
        h('button', { class: 'beat-roll-key', title: 'Hear it', onclick: () => this.preview(r, 0.9, m) }, noteName(m)),
        h('div', { class: 'beat-roll-cells', style: { gridTemplateColumns: `repeat(${p.steps}, minmax(14px, 1fr))` } }, cells)));
    }
    const cols = [];
    for (let i = 0; i < p.steps; i++) cols.push(h('div', { class: `beat-roll-col${i === this.head ? ' now' : ''}`, dataset: { i } }));
    const shift = (d) => { this.remember(); r.view = clamp(r.view + d, 12, 96); this.changed(); this.renderRows(); };
    const body = h('div', { class: 'beat-roll-body' }, ...lines,
      h('div', { class: 'beat-roll-heads' }, h('div', { class: 'beat-roll-headcols', style: { gridTemplateColumns: `repeat(${p.steps}, minmax(14px, 1fr))` } }, cols)));
    return h('div', { class: 'beat-roll', dataset: { row: r.id } },
      h('div', { class: 'beat-roll-bar' },
        h('span', { class: 'faint' }, `${r.name} · pattern ${p.name} · ${NOTE_NAMES[b.key]} ${b.scale}`),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn sm ghost', title: 'An octave down', onclick: () => shift(-12) }, icon('chevron-down', 'sm'), 'Octave'),
        h('button', { class: 'btn sm ghost', title: 'An octave up', onclick: () => shift(12) }, icon('chevron-up', 'sm'), 'Octave'),
        h('button', { class: 'btn sm ghost', title: 'New notes for this pattern, in key', onclick: () => { this.remember(); r.notes[p.id] = rollNotes(b, r, p.steps); this.changed(true); } }, icon('shuffle', 'sm'), 'Dice'),
        h('button', { class: 'btn sm ghost', title: 'Take every note out of this pattern', onclick: () => { this.remember(); delete r.notes[p.id]; this.changed(true); } }, 'Clear'),
        h('button', { class: 'icon-btn', 'data-tip': 'Close', onclick: () => { this.openRoll = null; this.renderRows(); } }, icon('x', 'sm'))),
      body);
  }

  fxPopover(anchor, r) {
    const knob = (label, key, lo, hi, fmt, title) => {
      const el = h('input', { type: 'range', min: lo, max: hi, value: Math.round(r.fx[key] * 100), title });
      const out = h('span', { class: 'mono faint' }, fmt(r.fx[key]));
      el.addEventListener('pointerdown', () => this.remember());
      el.addEventListener('input', () => { r.fx[key] = +el.value / 100; out.textContent = fmt(r.fx[key]); this.changed(); this.markFx(r); });
      el.addEventListener('dblclick', () => { r.fx[key] = 0; el.value = 0; out.textContent = fmt(0); this.changed(); this.markFx(r); });
      return h('label', { class: 'beat-fx-row', title }, h('span', {}, label), el, out);
    };
    const pct = (v) => `${Math.round(v * 100)}%`;
    const toneFmt = (v) => (v < -0.02 ? `low-pass ${Math.round(-v * 100)}` : v > 0.02 ? `high-pass ${Math.round(v * 100)}` : 'open');
    popover(anchor, h('div', { class: 'beat-fx-pop' },
      h('div', { class: 'beat-fx-title' }, `${r.name} · effects`),
      knob('Reverb', 'rev', 0, 100, pct, 'How much goes to the reverb'),
      knob('Echo', 'dly', 0, 100, pct, 'How much goes to the echo (a dotted 8th, in time with the beat)'),
      knob('Drive', 'drive', 0, 100, pct, 'Distortion: grit and warmth'),
      knob('Filter', 'tone', -100, 100, toneFmt, 'Left takes the top off (low-pass), right takes the bottom off (high-pass) · double-click to open it'),
      h('div', { class: 'faint beat-fx-hint' }, 'Double-click a slider to turn it off')), { align: 'right' });
  }
  markFx(r) {
    const btn = this.grid?.querySelector(`.beat-row[data-row="${r.id}"] .beat-fx`);
    btn?.classList.toggle('on', !!(r.fx.rev || r.fx.dly || r.fx.drive || r.fx.tone));
  }

  /** Click or drag across steps to paint them on (or off, if the first one was on). A synth's row opens its piano roll. */
  wireGrid() {
    let paint = null, drag = null;
    const rowById = (id) => this.beat.rows.find((x) => x.id === id);
    /** The piano roll: click to add a note (drag right to hold it longer), click a note to take it out; Shift for a softer one. */
    const rollDown = (el, e) => {
      const r = rowById(el.closest('.beat-roll').dataset.row);
      if (!r) return;
      const p = this.pat, i = +el.dataset.i, m = +el.dataset.n;
      const list = ownNotes(r, p.id);
      const hit = list.find((n) => n.n === m && i >= n.s && i < n.s + n.l);
      this.remember();
      if (hit) { list.splice(list.indexOf(hit), 1); this.changed(); this.renderRows(); return; }
      const n = { s: i, n: m, l: 1, v: e.shiftKey ? SOFT : 1 };
      list.push(n);
      // how far it can be held: up to the next note on the same line, or the pattern's end
      const next = Math.min(p.steps, ...list.filter((x) => x !== n && x.n === m && x.s > i).map((x) => x.s));
      drag = { n, max: next - i };
      if (!this.playing) this.preview(r, n.v, m);
      this.grid.setPointerCapture?.(e.pointerId);
      this.renderRows();
    };
    const cellOf = (e) => e.target.closest?.('.beat-step');
    const apply = (el) => {
      if (el.dataset.synth) return;
      const r = this.beat.rows.find((x) => x.id === el.dataset.row), i = +el.dataset.i;
      if (!r) return;
      const hits = ownHits(r, this.beat.pat);
      if (hits[i] === paint) return;
      hits[i] = paint;
      el.classList.toggle('on', !!paint); el.classList.toggle('soft', !!paint && paint < 1);
      if (paint && !this.playing) this.preview(r, paint);
    };
    this.grid.addEventListener('pointerdown', (e) => {
      const el = cellOf(e);
      const rc = e.target.closest?.('.beat-roll-cell');
      if (rc && e.button === 0) { e.preventDefault(); return rollDown(rc, e); }
      if (!el || e.button !== 0) return;
      e.preventDefault();
      if (el.dataset.synth) { this.openRoll = this.openRoll === el.dataset.row ? null : el.dataset.row; this.renderRows(); return; }
      const r = this.beat.rows.find((x) => x.id === el.dataset.row);
      const v = hitsIn(r, this.beat.pat)[+el.dataset.i];
      const want = e.shiftKey ? SOFT : 1;
      paint = v === want ? 0 : want;
      this.remember();
      apply(el);
      this.grid.setPointerCapture?.(e.pointerId);
    });
    this.grid.addEventListener('pointermove', (e) => {
      if (drag) {
        const c = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.beat-roll-cell');
        if (!c || !this.grid.contains(c)) return;
        const l = clamp(+c.dataset.i - drag.n.s + 1, 1, drag.max);
        if (l !== drag.n.l) { drag.n.l = l; this.renderRows(); }
        return;
      }
      if (paint == null) return;
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.beat-step');
      if (el && this.grid.contains(el)) apply(el);
    });
    const end = () => {
      if (drag) { drag = null; this.changed(); return; }
      if (paint == null) return;
      paint = null; this.save();
    };
    this.grid.addEventListener('pointerup', end);
    this.grid.addEventListener('pointercancel', end);
  }

  /** The drums, then (with `synth`) the synths and (with `samples`) sample choices. */
  soundItems(pick, { samples = false, synth = null } = {}) {
    return [
      ...Object.entries(KIT).map(([k, s]) => ({ label: s.name, icon: 'drum', action: () => pick(k) })),
      ...(synth ? [{ sep: true }, ...Object.entries(SYNTHS).map(([k, s]) => ({ label: `${s.name} synth`, icon: 'keyboard', action: () => synth(k) }))] : []),
      ...(samples ? [{ sep: true }, { label: 'A sample from the audio dump…', icon: 'music', action: () => this.pickSample(null) },
        { label: 'A sample from a file…', icon: 'folder', action: () => this.pickFile(null) }] : []),
    ];
  }

  rowMenu(e, r) {
    const b = this.beat, p = this.pat;
    const synth = r.kind === 'synth';
    const edit = (fn) => () => { this.remember(); fn(); this.changed(true); };
    /** The pattern's steps of this row moved round by d. */
    const shift = (d) => edit(() => {
      if (synth) { for (const n of notesIn(r, p.id)) n.s = (n.s + d + p.steps) % p.steps; return; }
      const s = ownHits(r, p.id).slice(0, p.steps);
      if (d < 0) s.push(s.shift()); else s.unshift(s.pop());
      r.pats[p.id].splice(0, p.steps, ...s);
    });
    contextMenu(e, [
      { label: 'Sound', icon: 'drum', submenu: this.soundItems(
        (k) => { this.remember(); Object.assign(r, { kind: 'drum', sound: k, sample: null, name: KIT[k].name }); this.changed(true); this.preview(r); },
        { synth: (k) => { this.remember(); Object.assign(r, { kind: 'synth', synth: k, sample: null, name: SYNTHS[k].name, view: SYNTHS[k].view }); this.openRoll = r.id; this.changed(true); this.preview(r); } }) },
      { label: 'Sample from the audio dump…', icon: 'music', action: () => this.pickSample(r) },
      { label: 'Sample from a file…', icon: 'folder', action: () => this.pickFile(r) },
      { sep: true },
      { label: 'Rename…', icon: 'edit', action: async () => { const n = (await promptDialog('Rename sound', 'Name', r.name) || '').trim(); if (n) { this.remember(); r.name = n; this.changed(true); } } },
      { label: 'Save this line…', icon: 'star', action: () => this.saveLine(r) },
      synth ? { label: this.openRoll === r.id ? 'Close the piano roll' : 'Open the piano roll', icon: 'keyboard', action: () => { this.openRoll = this.openRoll === r.id ? null : r.id; this.renderRows(); } }
        : { label: 'Fill every…', icon: 'drum', submenu: [1, 2, 4, 8].map((n) => ({ label: n === 1 ? 'Step' : `${n} steps`, action: edit(() => { const s = ownHits(r, p.id); s.fill(0); for (let i = 0; i < MAX_STEPS; i += n) s[i] = 1; }) })) },
      { label: 'Randomize', icon: 'shuffle', action: edit(() => { if (synth) r.notes[p.id] = rollNotes(b, r, p.steps); else r.pats[p.id] = rollHits(r, p.steps); }) },
      { label: 'Shift left', icon: 'arrow-left', action: shift(-1) },
      { label: 'Shift right', icon: 'arrow-right', action: shift(1) },
      { label: synth ? 'Clear notes' : 'Clear steps', icon: 'x', action: edit(() => { delete r.pats[p.id]; delete r.notes[p.id]; }) },
      { sep: true },
      { label: 'Duplicate row', icon: 'copy', action: edit(() => b.rows.splice(b.rows.indexOf(r) + 1, 0, { ...JSON.parse(JSON.stringify(r)), id: uid() })) },
      { label: 'Move up', icon: 'arrow-up', disabled: !b.rows.indexOf(r), action: edit(() => { const i = b.rows.indexOf(r); b.rows.splice(i, 1); b.rows.splice(i - 1, 0, r); }) },
      { label: 'Move down', icon: 'arrow-down', disabled: b.rows.indexOf(r) === b.rows.length - 1, action: edit(() => { const i = b.rows.indexOf(r); b.rows.splice(i, 1); b.rows.splice(i + 1, 0, r); }) },
      { label: 'Delete row', icon: 'trash', action: () => { this.remember(); b.rows.splice(b.rows.indexOf(r), 1); this.changed(true); toast(`Removed ${r.name}`, { action: { label: 'Undo', fn: () => this.undo() } }); } },
    ]);
  }

  /** r: the row to give the sample to (null: a new row). */
  async setSample(r, p) {
    const buf = await this.loadSample(p);
    if (!buf) return toast(`Couldn’t open ${basename(p)} as a sound.`, { type: 'error' });
    this.remember();
    const name = stripExt(basename(p)).slice(0, 40);
    if (!r) { r = newRow('kick'); this.beat.rows.push(r); }
    r.kind = 'drum';
    r.sample = { path: p, name: basename(p) };
    r.name = name;
    this.changed(true);
    this.preview(r);
  }

  async pickFile(r) {
    const paths = await pickOpen({ title: 'Pick a sound', filters: [{ name: 'Sounds', extensions: [...AUDIO_EXT] }] });
    if (paths?.[0]) this.setSample(r, paths[0]);
  }

  async pickSample(r) {
    let items = [];
    try { items = (await api.dump('audio')).items || []; } catch (e) { return errorToast(e, 'The audio dump'); }
    if (!items.length) return toast('The audio dump is empty. Drop a sound file on a row instead.', { type: 'warn' });
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const filterEl = h('input', { type: 'text', placeholder: 'Filter', class: 'beat-filter' });
    const list = h('div', { class: 'beat-pick' });
    let audio = null;
    const show = () => {
      const q = filterEl.value.trim().toLowerCase();
      clear(list).append(...items.filter((x) => !q || x.name.toLowerCase().includes(q)).slice(0, 400).map((x) =>
        h('div', { class: 'beat-pick-row' },
          h('button', { class: 'icon-btn', 'data-tip': 'Listen', onclick: () => { audio?.pause(); audio = new Audio(`/api/stream?token=${encodeURIComponent(api.token)}&path=${encodeURIComponent(x.path)}`); audio.play().catch(() => {}); } }, icon('play', 'sm')),
          h('button', { class: 'beat-pick-name', onclick: () => ctx?.close(x.path) }, x.name))));
    };
    let ctx = null;
    filterEl.addEventListener('input', show);
    show();
    const p = await modal({ title: 'Pick a sample', body: h('div', {}, filterEl, list), buttons: [{ label: 'Cancel', value: null, ghost: true }], onOpen: (c) => { ctx = c; } });
    audio?.pause();
    if (p) this.setSample(r, p);
  }

  // ---------------------------------------------------------------- keys, status
  onKey(e) {
    if (this.app.active !== this.tab) return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.type !== 'range' || document.querySelector('.modal-backdrop')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); return this.undo(); }
    if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); return this.redo(); }
    if (!ctrl && !e.altKey && e.key === ' ') { e.preventDefault(); return this.togglePlay(); }
    if (e.key === 'F2' && !ctrl) {
      e.preventDefault(); e.stopPropagation();
      const id = document.querySelector('.beat-chip[data-pat]:hover')?.dataset.pat;
      return this.renamePattern(this.beat.patterns.find((x) => x.id === id) || this.pat);
    }
  }

  status() {
    if (!this.beats) return { left: [], right: [] };
    const b = this.beat, p = this.pat;
    return { left: [{ text: b.name }], right: [{ text: `${Math.round(b.bpm)} BPM · pattern ${p.name} · ${p.steps} steps${b.songMode && b.song.length ? ' · song' : ''}${this.playing ? ' · playing' : ''}` }] };
  }

  onHide() { /* keeps playing in the background, like the music player */ }
  destroy() {
    if (this.playing) this.stop();
    document.removeEventListener('keydown', this.keyHandler);
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.save(true); }
    this.actx?.close();
  }
}

// ---------------------------------------------------------------- WAV
function wavFrom(buf, n = buf.length) {
  const ch = buf.numberOfChannels;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const chans = [...Array(ch).keys()].map((c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { out.setInt16(o, Math.max(-1, Math.min(1, chans[c][i])) * 0x7fff, true); o += 2; }
  return new Uint8Array(out.buffer);
}
