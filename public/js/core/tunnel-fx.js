// BoxTunnel effects: what can go on an input (a mic, mostly), and voice changers made of them. Each effect is a
// small Web Audio graph with one knob; an input runs its effects in order, after its gate, before its volume.
// Shared with BoxWave, which renders the same effects onto a recording.

export const PITCH_URL = new URL('./tunnel-pitch.js', import.meta.url).href;

/** type → { name, min, max, step, def, unit } (the one knob each effect has). */
export const FX = {
  pitch: { name: 'Pitch', min: -12, max: 12, step: 1, def: -4, unit: 'st' },
  robot: { name: 'Robot', min: 20, max: 200, step: 1, def: 70, unit: 'Hz' },
  wobble: { name: 'Wobble', min: 0.5, max: 12, step: 0.5, def: 5, unit: 'Hz' },
  echo: { name: 'Echo', min: 60, max: 900, step: 10, def: 260, unit: 'ms' },
  reverb: { name: 'Reverb', min: 0.3, max: 6, step: 0.1, def: 2, unit: 's' },
  distort: { name: 'Distortion', min: 0, max: 100, step: 1, def: 40, unit: '%' },
  radio: { name: 'Radio', min: 0, max: 100, step: 1, def: 50, unit: '%' },
  phone: { name: 'Telephone', min: 0, max: 100, step: 1, def: 50, unit: '%' },
  megaphone: { name: 'Megaphone', min: 0, max: 100, step: 1, def: 60, unit: '%' },
  bass: { name: 'Bass', min: -15, max: 15, step: 1, def: 6, unit: 'dB' },
  treble: { name: 'Treble', min: -15, max: 15, step: 1, def: 6, unit: 'dB' },
};

/** Voice changers: a set of effects with their knobs. */
export const VOICES = [
  { name: 'Deep voice', fx: [['pitch', -5], ['bass', 4]] },
  { name: 'Chipmunk', fx: [['pitch', 8]] },
  { name: 'Robot', fx: [['robot', 60], ['echo', 60]] },
  { name: 'Alien', fx: [['pitch', 4], ['wobble', 7]] },
  { name: 'Demon', fx: [['pitch', -9], ['distort', 25], ['reverb', 1.8]] },
  { name: 'Monster', fx: [['pitch', -12], ['distort', 45]] },
  { name: 'Radio', fx: [['radio', 55]] },
  { name: 'Telephone', fx: [['phone', 50]] },
  { name: 'Megaphone', fx: [['megaphone', 65]] },
  { name: 'Cave', fx: [['echo', 320], ['reverb', 4]] },
  { name: 'Stadium', fx: [['reverb', 3.2], ['echo', 520]] },
];

export const newFx = (type, v) => ({ key: Math.random().toString(36).slice(2, 10), type, v: v ?? FX[type].def, on: true });
export const fxLabel = (f) => `${FX[f.type]?.name || f.type} ${+(+f.v).toFixed(FX[f.type]?.step < 1 ? 1 : 0)}${FX[f.type]?.unit === '%' ? '%' : ` ${FX[f.type]?.unit || ''}`}`;

function curve(k) {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
  return c;
}
function impulse(ctx, secs) {
  const len = Math.max(1, Math.round(ctx.sampleRate * secs));
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
  }
  return b;
}
const filt = (ctx, type, f, q = 0.7, gain = 0) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; n.gain.value = gain; return n; };
const gainOf = (ctx, v) => { const g = ctx.createGain(); g.gain.value = v; return g; };

/** One effect as { input, output, set(v), stop() }. `pitchOk`: the pitch worklet loaded in this context. */
export function buildFx(ctx, f, pitchOk = true) {
  const input = ctx.createGain(), output = ctx.createGain();
  const stops = [];
  let set = () => {};
  const t = f.type;
  if (t === 'pitch' && pitchOk) {
    const p = new AudioWorkletNode(ctx, 'bds-pitch', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    input.connect(p).connect(output);
    set = (v) => p.parameters.get('semitones').setValueAtTime(+v, ctx.currentTime);
  } else if (t === 'robot') {
    // ring modulation (the voice times a low tone), then a short metallic comb
    const ring = gainOf(ctx, 0);
    const osc = ctx.createOscillator();
    osc.frequency.value = f.v;
    osc.connect(ring.gain);
    osc.start();
    stops.push(() => osc.stop());
    const comb = ctx.createDelay(0.1); comb.delayTime.value = 0.011;
    const fb = gainOf(ctx, 0.45);
    input.connect(ring);
    ring.connect(output); ring.connect(comb); comb.connect(fb).connect(comb); comb.connect(gainOf(ctx, 0.6)).connect(output);
    set = (v) => osc.frequency.setTargetAtTime(+v, ctx.currentTime, 0.02);
  } else if (t === 'wobble') {
    const d = ctx.createDelay(0.05); d.delayTime.value = 0.008;
    const lfo = ctx.createOscillator(); lfo.frequency.value = f.v;
    const depth = gainOf(ctx, 0.004);
    lfo.connect(depth).connect(d.delayTime);
    lfo.start();
    stops.push(() => lfo.stop());
    input.connect(d).connect(output);
    set = (v) => lfo.frequency.setTargetAtTime(+v, ctx.currentTime, 0.02);
  } else if (t === 'echo') {
    const d = ctx.createDelay(2); d.delayTime.value = f.v / 1000;
    const fb = gainOf(ctx, 0.38), wet = gainOf(ctx, 0.5);
    input.connect(output);
    input.connect(d); d.connect(fb).connect(d); d.connect(wet).connect(output);
    set = (v) => d.delayTime.setTargetAtTime(+v / 1000, ctx.currentTime, 0.03);
  } else if (t === 'reverb') {
    const conv = ctx.createConvolver();
    conv.buffer = impulse(ctx, f.v);
    input.connect(gainOf(ctx, 0.8)).connect(output);
    input.connect(conv).connect(gainOf(ctx, 0.5)).connect(output);
    let last = f.v;
    set = (v) => { if (Math.abs(v - last) > 0.05) { last = v; conv.buffer = impulse(ctx, +v); } };
  } else if (t === 'distort') {
    const ws = ctx.createWaveShaper(); ws.oversample = '2x';
    const lp = filt(ctx, 'lowpass', 7000);
    const out = gainOf(ctx, 1);
    input.connect(ws).connect(lp).connect(out).connect(output);
    set = (v) => { const k = (+v / 100) * 60; ws.curve = curve(k); out.gain.value = 1 / (1 + k / 25); };
  } else if (t === 'radio' || t === 'phone' || t === 'megaphone') {
    const [lo, hi, peak] = t === 'radio' ? [450, 3600, 1600] : t === 'phone' ? [320, 3300, 1200] : [700, 4200, 2200];
    const hp = filt(ctx, 'highpass', lo, 0.9), hp2 = filt(ctx, 'highpass', lo, 0.9);
    const lp = filt(ctx, 'lowpass', hi, 0.9), lp2 = filt(ctx, 'lowpass', hi, 0.9);
    const pk = filt(ctx, 'peaking', peak, 1.2, t === 'megaphone' ? 9 : 5);
    const ws = ctx.createWaveShaper();
    const out = gainOf(ctx, 1);
    input.connect(hp).connect(hp2).connect(pk).connect(ws).connect(lp).connect(lp2).connect(out).connect(output);
    if (t === 'radio') {
      // a little hiss under it
      const n = ctx.createBufferSource();
      const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      n.buffer = b; n.loop = true;
      const hiss = gainOf(ctx, 0.004);
      n.connect(filt(ctx, 'bandpass', 3000, 0.5)).connect(hiss).connect(output);
      n.start();
      stops.push(() => n.stop());
    }
    set = (v) => { const k = 2 + (+v / 100) * (t === 'megaphone' ? 40 : 20); ws.curve = curve(k); out.gain.value = 1.4 / (1 + k / 30); };
  } else if (t === 'bass' || t === 'treble') {
    const sh = filt(ctx, t === 'bass' ? 'lowshelf' : 'highshelf', t === 'bass' ? 180 : 3200, 0.7, f.v);
    input.connect(sh).connect(output);
    set = (v) => sh.gain.setTargetAtTime(+v, ctx.currentTime, 0.02);
  } else {
    input.connect(output); // unknown, or the pitch worklet didn't load
  }
  set(f.v);
  return { input, output, set, stop: () => { for (const s of stops) { try { s(); } catch { /* stopped */ } } try { input.disconnect(); output.disconnect(); } catch { /* gone */ } } };
}

/** Chain `from` → the effects that are on → `to`. Returns { set(fx), stop(), sig }; sig changes when the chain must be rebuilt. */
export function chainFx(ctx, from, to, fx, pitchOk = true) {
  const on = (fx || []).filter((f) => f.on !== false && FX[f.type]);
  const nodes = on.map((f) => ({ key: f.key, n: buildFx(ctx, f, pitchOk) }));
  let at = from;
  for (const { n } of nodes) { at.connect(n.input); at = n.output; }
  at.connect(to);
  return {
    sig: fxSig(fx),
    set(list) { for (const f of list || []) nodes.find((x) => x.key === f.key)?.n.set(f.v); },
    stop() { try { from.disconnect(); } catch { /* gone */ } for (const { n } of nodes) n.stop(); },
  };
}
export const fxSig = (fx) => (fx || []).filter((f) => f.on !== false).map((f) => `${f.key}:${f.type}`).join(',');
