// BoxTunnel's engine: audio lines (BoxAudioLine1, 2, …). A line mixes any number of inputs (a mic / line-in,
// everything the system is playing, or another line), each with its own volume, mute and noise gate, through an
// optional compressor, and plays the mix to one output device, with a volume and a "listen" monitor.
// It lives on the app, not the tab, so lines keep running with the BoxTunnel tab closed (settings.tunnel.keep).
// Other apps can only pick a line up through a virtual audio cable: set the line's output to the cable.

import { PITCH_URL, chainFx, fxSig } from './tunnel-fx.js';

const SYSTEM = 'system';
const NONE = 'none';
const VIRTUAL_RE = /virtual|cable|vb-audio|voicemeeter|vac\b/i;
export const GATE_DEFAULT = -50; // dB
const GATE_URL = new URL('./tunnel-gate.js', import.meta.url).href;

/** Compressor strengths: threshold dB, ratio, knee, attack s, release s, extra make-up gain dB
 *  (Chromium's compressor already adds its own make-up gain, so the mix stays about as loud, just more even). */
export const COMP = {
  off: null,
  light: [-20, 2.5, 10, 0.005, 0.2, 0],
  medium: [-26, 4, 8, 0.003, 0.25, 0],
  strong: [-34, 8, 6, 0.002, 0.3, 0],
};

/** "Headset Microphone (SteelSeries Arctis Nova 5) (1038:2232)" → without the USB id at the end. */
export const deviceName = (label) => String(label || '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim();
export const isVirtual = (label) => VIRTUAL_RE.test(label || '');
const newKey = () => Math.random().toString(36).slice(2, 10);
const dbToGain = (db) => Math.pow(10, db / 20);

/** Lines saved with one `input` (before mixing) become a line with one entry in `inputs`. */
function normalize(l) {
  const inputs = Array.isArray(l.inputs) ? l.inputs : l.input ? [{ ...l.input }] : [];
  const { input, ...rest } = l;
  void input;
  return {
    ...rest,
    comp: COMP[l.comp] !== undefined ? l.comp : 'off',
    inputs: inputs.map((i) => ({ key: i.key || newKey(), kind: i.kind || SYSTEM, id: i.id, label: i.label, volume: i.volume ?? 1, mute: !!i.mute, gate: !!i.gate, threshold: i.threshold ?? GATE_DEFAULT,
      fx: (Array.isArray(i.fx) ? i.fx : []).map((f) => ({ key: f.key || newKey(), type: f.type, v: +f.v, on: f.on !== false })) })),
  };
}

/** What a running line's audio graph depends on: changing any of it rebuilds the line. */
const shape = (l) => `${l.on}|${l.output?.id}|${l.inputs.map((i) => `${i.key}:${i.kind}:${i.id || ''}`).join(',')}`;

let theTunnel = null;
export function tunnel(app) { return (theTunnel ||= new Tunnel(app)); }

class Tunnel {
  constructor(app) {
    this.app = app;
    this.run = new Map(); // line id → { ctx, mix, comp, makeup, gain, an, dest, mon, ins: Map(key → {an, gate, gain, streamKey}) }
    this.errors = new Map(); // line id → message (the line as a whole)
    this.inErrors = new Map(); // `${line id}:${input key}` → message
    this.streams = new Map(); // 'system' | 'dev:<id>' → { stream, users }
    this.subs = new Set();
    this.started = false;
    this.devs = { inputs: [], outputs: [] };
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.refreshDevices().then(() => this.started && this.sync()));
  }

  // ---- settings: { lines: [...], monitor: deviceId, monitorVolume, keep, autostart }

  get cfg() {
    const c = this.app.settings.tunnel || {};
    return { lines: (Array.isArray(c.lines) ? c.lines : []).map(normalize), monitor: c.monitor || '', monitorVolume: c.monitorVolume ?? 1, keep: c.keep !== false, autostart: !!c.autostart };
  }
  save(patch) {
    // in memory at once, on disk a moment later (a volume drag is many changes)
    this.app.settings.tunnel = { ...this.cfg, ...patch };
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => this.app.saveSettings({ tunnel: this.app.settings.tunnel }), 300);
  }
  get lines() { return this.cfg.lines; }
  line(id) { return this.lines.find((l) => l.id === id) || null; }
  setLines(lines) { this.save({ lines }); }

  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit() { for (const fn of this.subs) { try { fn(); } catch (e) { console.warn(e); } } }

  nextName() {
    const used = new Set(this.lines.map((l) => l.name));
    let n = 1;
    while (used.has(`BoxAudioLine${n}`)) n++;
    return `BoxAudioLine${n}`;
  }

  defaultMic() {
    const d = this.devs.inputs.find((x) => x.id === 'default') || this.devs.inputs[0];
    return d ? { kind: 'device', id: d.id, label: d.label } : { kind: SYSTEM };
  }

  addLine() {
    const l = normalize({
      id: newKey(), name: this.nextName(), on: true,
      inputs: [this.defaultMic()],
      output: { id: NONE, label: '' }, volume: 1, mute: false, listen: false, comp: 'off',
    });
    this.setLines([...this.lines, l]);
    if (this.started) this.sync();
    return l;
  }

  update(id, patch) {
    const before = this.line(id);
    if (!before) return;
    const after = normalize({ ...before, ...patch });
    this.setLines(this.lines.map((l) => (l.id === id ? after : l)));
    const r = this.run.get(id);
    // volumes, mutes, gates, the compressor and listen change a running line in place; anything else rebuilds it
    if (r && shape(before) === shape(after)) { this.applyParams(after, r); this.applyMonitor(after, r); this.emit(); return; }
    if (this.started) { this.stopLine(id, { dependents: true }); this.sync(); } else this.emit();
  }

  updateInput(id, key, patch) {
    const l = this.line(id);
    if (l) this.update(id, { inputs: l.inputs.map((i) => (i.key === key ? { ...i, ...patch } : i)) });
  }

  addInput(id, input) {
    const l = this.line(id);
    if (!l) return;
    // a mic line gets the system sound next, anything else the default mic
    const next = input || (l.inputs.some((i) => i.kind === SYSTEM) ? this.defaultMic() : { kind: SYSTEM });
    this.update(id, { inputs: [...l.inputs, { ...next, key: newKey() }] });
  }

  removeInput(id, key) {
    const l = this.line(id);
    if (l) this.update(id, { inputs: l.inputs.filter((i) => i.key !== key) });
    this.inErrors.delete(`${id}:${key}`);
  }

  /** Rebuild a line from scratch (and the lines it feeds): picks up a device that came back. */
  async restart(id) {
    this.stopLine(id, { dependents: true });
    await this.refreshDevices();
    if (this.started) await this.sync();
  }

  remove(id) {
    this.stopLine(id, { dependents: true });
    // lines that mixed this one in lose that input
    this.setLines(this.lines.filter((l) => l.id !== id).map((l) => ({ ...l, inputs: l.inputs.filter((i) => !(i.kind === 'line' && i.id === id)) })));
    this.errors.delete(id);
    if (this.started) this.sync();
    this.emit();
  }

  /** Every line this one (indirectly) takes sound from. */
  feeds(id, seen = new Set()) {
    for (const i of this.line(id)?.inputs || []) {
      if (i.kind !== 'line' || seen.has(i.id)) continue;
      seen.add(i.id);
      this.feeds(i.id, seen);
    }
    return seen;
  }

  // ---- devices

  async refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return this.devs;
    let list = await navigator.mediaDevices.enumerateDevices();
    if (list.some((d) => d.kind === 'audioinput' && !d.label)) {
      // labels only show once audio access was granted
      try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); list = await navigator.mediaDevices.enumerateDevices(); } catch { /* no mic */ }
    }
    const pick = (kind) => list.filter((d) => d.kind === kind && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: d.label || 'Unnamed device' }));
    this.devs = { inputs: pick('audioinput'), outputs: pick('audiooutput') };
    this.emit();
    return this.devs;
  }

  /** The device behind a saved {id, label} — by id, or by name when Windows handed out a new id. */
  resolve(list, saved) {
    if (!saved) return null;
    return list.find((d) => d.id === saved.id) || list.find((d) => saved.label && d.label === saved.label) || null;
  }

  /** The real device "default" stands for (the one system sound is recorded from). */
  defaultOutput() {
    const d = this.devs.outputs.find((x) => x.id === 'default');
    if (!d) return null;
    const name = d.label.replace(/^Default\s*-\s*/i, '');
    return this.devs.outputs.find((x) => x.id !== 'default' && x.label === name) || d;
  }

  sameAsDefault(out) {
    if (!out || out.id === NONE) return false;
    if (out.id === '' || out.id === 'default') return true;
    const def = this.defaultOutput();
    return !!def && (out.id === def.id || out.label === def.label);
  }

  /** Warnings for a line (an echo loop: recording everything that plays while playing into it). */
  warning(l) {
    const sys = (x, seen = new Set()) => x.inputs.some((i) => i.kind === SYSTEM || (i.kind === 'line' && !seen.has(i.id) && seen.add(i.id) && this.line(i.id) && sys(this.line(i.id), seen)));
    if (!sys(l)) return null;
    const out = this.resolve(this.devs.outputs, l.output) || l.output;
    if (this.sameAsDefault(out)) return 'Echo loop: this line records everything playing on your default speakers and plays back into them. Send it to another output.';
    if (l.listen && this.sameAsDefault(this.cfg.monitor ? { id: this.cfg.monitor } : { id: '' })) return 'Listening plays this line on your default speakers, which it is also recording — expect an echo.';
    return null;
  }

  // ---- input streams, shared between lines that use the same one

  async takeStream(key, input) {
    const s = this.streams.get(key);
    if (s) { s.users++; return s.stream; }
    let stream;
    if (key === SYSTEM) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 1, maxHeight: 1, maxFrameRate: 1 } },
      });
      for (const t of stream.getVideoTracks()) { t.stop(); stream.removeTrack(t); } // only the sound is wanted
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: input.id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } });
    }
    this.streams.set(key, { stream, users: 1 });
    return stream;
  }

  dropStream(key) {
    const s = this.streams.get(key);
    if (!s || --s.users > 0) return;
    s.stream.getTracks().forEach((t) => t.stop());
    this.streams.delete(key);
  }

  // ---- running

  async start() {
    this.started = true;
    await this.refreshDevices();
    await this.sync();
  }

  stopAll() {
    for (const id of [...this.run.keys()]) this.stopLine(id);
    this.started = false;
    this.emit();
  }

  get running() { return this.run.size; }

  /** Start every line that's on and not running (feeding lines first); stop the ones turned off. */
  async sync() {
    if (this.syncing) { this.again = true; return; }
    this.syncing = true;
    try {
      do {
        this.again = false;
        for (const l of this.lines) if (!l.on && this.run.has(l.id)) this.stopLine(l.id, { dependents: true });
        const pending = this.lines.filter((l) => l.on && !this.run.has(l.id));
        const waiting = (l) => l.inputs.some((i) => i.kind === 'line' && !this.run.has(i.id) && this.line(i.id)?.on && pending.some((p) => p.id === i.id));
        // feeding lines first; a few passes settle chains of lines
        for (let pass = 0; pass < 6 && pending.length; pass++) {
          for (const l of [...pending]) {
            if (waiting(l)) continue;
            pending.splice(pending.indexOf(l), 1);
            await this.startLine(l);
          }
        }
        for (const l of pending) await this.startLine(l); // whatever is left starts without the missing lines
      } while (this.again);
    } finally { this.syncing = false; }
    this.emit();
  }

  async startLine(l) {
    this.errors.delete(l.id);
    for (const k of [...this.inErrors.keys()]) if (k.startsWith(`${l.id}:`)) this.inErrors.delete(k);
    const r = { ins: new Map(), mon: null };
    try {
      const out = l.output?.id === NONE ? null : this.resolve(this.devs.outputs, l.output);
      if (l.output?.id !== NONE && !out) throw new Error(`${deviceName(l.output?.label) || 'The output'} isn’t connected`);
      const ctx = new AudioContext({ latencyHint: 'interactive', sinkId: !out ? { type: 'none' } : out.id === 'default' ? '' : out.id });
      Object.assign(r, { ctx });
      let gateOk = true;
      try { await ctx.audioWorklet.addModule(GATE_URL); } catch (e) { gateOk = false; console.warn('tunnel gate', e); }
      try { await ctx.audioWorklet.addModule(PITCH_URL); r.pitchOk = true; } catch (e) { r.pitchOk = false; console.warn('tunnel pitch', e); }
      // inputs → mix → compressor → make-up → line volume → (meter, output, other lines / listen)
      r.mix = ctx.createGain();
      r.comp = ctx.createDynamicsCompressor();
      r.makeup = ctx.createGain();
      r.gain = ctx.createGain();
      r.an = ctx.createAnalyser();
      r.an.fftSize = 1024;
      r.buf = new Float32Array(r.an.fftSize);
      r.dest = ctx.createMediaStreamDestination();
      r.mix.connect(r.comp).connect(r.makeup).connect(r.gain);
      r.gain.connect(r.an);
      r.gain.connect(ctx.destination);
      r.gain.connect(r.dest);
      this.run.set(l.id, r);
      for (const i of l.inputs) await this.attachInput(l, r, i, gateOk);
      this.applyParams(l, r);
      this.applyMonitor(l, r);
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    } catch (e) {
      this.stopLine(l.id);
      this.errors.set(l.id, e.name === 'NotAllowedError' ? 'Audio access was refused' : e.message || String(e));
    }
  }

  /** One input: source → meter → gate → effects → its volume → the line's mix. A failing input doesn't stop the others. */
  async attachInput(l, r, i, gateOk) {
    const ctx = r.ctx;
    let streamKey = null;
    try {
      let stream;
      if (i.kind === 'line') {
        const from = this.run.get(i.id);
        if (!from) throw new Error(`${this.line(i.id)?.name || 'That line'} is off`);
        stream = from.dest.stream;
      } else if (i.kind === 'device') {
        const dev = this.resolve(this.devs.inputs, i);
        if (!dev) throw new Error(`${deviceName(i.label) || 'The input'} isn’t connected`);
        streamKey = `dev:${dev.id}`;
        stream = await this.takeStream(streamKey, dev);
      } else {
        streamKey = SYSTEM;
        stream = await this.takeStream(SYSTEM);
      }
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      const gain = ctx.createGain();
      const gate = gateOk ? new AudioWorkletNode(ctx, 'bds-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }) : null;
      const pre = ctx.createGain();
      src.connect(an);
      (gate ? src.connect(gate) : src).connect(pre);
      gain.connect(r.mix);
      const x = { src, an, gate, pre, gain, streamKey, buf: new Float32Array(an.fftSize) };
      x.fx = chainFx(ctx, pre, gain, i.fx, r.pitchOk);
      r.ins.set(i.key, x);
    } catch (e) {
      if (streamKey) this.dropStream(streamKey);
      this.inErrors.set(`${l.id}:${i.key}`, e.name === 'NotAllowedError' ? 'Audio access was refused' : e.message || String(e));
    }
  }

  stopLine(id, { dependents = false } = {}) {
    const r = this.run.get(id);
    if (r) {
      this.run.delete(id);
      try { r.mon?.ctx.close(); } catch { /* closed */ }
      try { r.ctx?.close(); } catch { /* closed */ }
      for (const x of r.ins.values()) if (x.streamKey) this.dropStream(x.streamKey);
    }
    // lines fed by this one lose their sound: stop them too, so the next sync rebuilds them
    if (dependents) for (const l of this.lines) if (l.inputs.some((i) => i.kind === 'line' && i.id === id) && this.run.has(l.id)) this.stopLine(l.id, { dependents: true });
  }

  /** Volumes, mutes, gates and the compressor of a running line. */
  applyParams(l, r) {
    const t = r.ctx.currentTime;
    const set = (param, v) => param.setTargetAtTime(v, t, 0.015);
    set(r.gain.gain, l.mute ? 0 : Math.max(0, Math.min(2, +l.volume || 0)));
    for (const i of l.inputs) {
      const x = r.ins.get(i.key);
      if (!x) continue;
      set(x.gain.gain, i.mute ? 0 : Math.max(0, Math.min(2, +i.volume || 0)));
      // effects added, removed, reordered or switched rebuild the chain; a knob just turns
      if (x.fx.sig !== fxSig(i.fx)) { x.fx.stop(); x.fx = chainFx(r.ctx, x.pre, x.gain, i.fx, r.pitchOk); }
      x.fx.set(i.fx);
      x.gate?.parameters.get('threshold').setValueAtTime(i.gate ? Math.max(-99, Math.min(0, +i.threshold)) : -100, t);
    }
    const c = COMP[l.comp];
    const [thr, ratio, knee, atk, rel, makeup] = c || [0, 1, 0, 0.003, 0.25, 0];
    r.comp.threshold.setValueAtTime(thr, t);
    r.comp.ratio.setValueAtTime(ratio, t);
    r.comp.knee.setValueAtTime(knee, t);
    r.comp.attack.setValueAtTime(atk, t);
    r.comp.release.setValueAtTime(rel, t);
    set(r.makeup.gain, dbToGain(makeup));
  }

  /** "Listen": the line, after its volume, also plays on the monitor device. */
  applyMonitor(l, r) {
    if (!l.listen) {
      if (r.mon) { try { r.mon.ctx.close(); } catch { /* closed */ } r.mon = null; }
      return;
    }
    const want = this.cfg.monitor;
    if (r.mon && r.mon.device === want) { r.mon.gain.gain.value = this.cfg.monitorVolume; return; }
    if (r.mon) { try { r.mon.ctx.close(); } catch { /* closed */ } }
    try {
      const out = want ? this.resolve(this.devs.outputs, { id: want }) : null;
      const ctx = new AudioContext({ latencyHint: 'interactive', sinkId: out && out.id !== 'default' ? out.id : '' });
      const src = ctx.createMediaStreamSource(r.dest.stream);
      const gain = ctx.createGain();
      gain.gain.value = this.cfg.monitorVolume;
      src.connect(gain).connect(ctx.destination);
      r.mon = { ctx, gain, device: want };
    } catch (e) { this.errors.set(l.id, `Can’t listen: ${e.message}`); }
  }

  setMonitor(device, volume) {
    this.save({ ...(device !== undefined ? { monitor: device } : {}), ...(volume !== undefined ? { monitorVolume: volume } : {}) });
    for (const l of this.lines) { const r = this.run.get(l.id); if (r) this.applyMonitor(l, r); }
    this.emit();
  }

  peak(an, buf) {
    an.getFloatTimeDomainData(buf);
    let p = 0;
    for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > p) p = v; }
    return p;
  }

  /** 0..1 peak level of a running line (after its volume). */
  level(id) {
    const r = this.run.get(id);
    return r ? this.peak(r.an, r.buf) : 0;
  }

  /** 0..1 peak level of one input, before its gate and volume (what the gate threshold is compared with). */
  inputLevel(id, key) {
    const x = this.run.get(id)?.ins.get(key);
    return x ? this.peak(x.an, x.buf) : 0;
  }

  /** How much the compressor is turning the line down right now, in dB (0 = not at all). */
  reduction(id) {
    const r = this.run.get(id);
    return r && COMP[this.line(id)?.comp] ? r.comp.reduction : 0;
  }

  latency(id) {
    const r = this.run.get(id);
    return r ? Math.round(((r.ctx.baseLatency || 0) + (r.ctx.outputLatency || 0)) * 1000) : 0;
  }
}
