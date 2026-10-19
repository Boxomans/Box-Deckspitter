// BoxWave: a plain audio editor. Open a sound (or the sound of a video), or record from a mic; see the waveform;
// select with the mouse and cut, copy, paste, delete, trim or silence it; amplify, normalize, fade, reverse,
// change the speed, or put BoxTunnel's effects (pitch, echo, reverb, robot, radio…) on it; then export it as WAV,
// MP3, FLAC, OGG, Opus or M4A (everything but WAV through ffmpeg, studio-server.js). Everything is kept in memory
// as 48 kHz floats; undo keeps whole copies, so very long files keep fewer steps.

import { BaseEditor } from './base.js';
import { h, clear, clamp, basename, extOf, stripExt } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { tbButton, tbSep, toast, errorToast, showMenu, contextMenu, promptDialog, modal, draggedPaths } from '../core/ui.js';
import { pickOpen, pickSave } from '../core/files.js';
import { FX, VOICES, PITCH_URL, REVERB_MIX, buildFx, newFx } from '../core/tunnel-fx.js';
import { wheelSlider } from '../core/music.js';

const SR = 48000;
const AUDIO_EXT = ['wav', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wma', 'aif', 'aiff', 'webm', 'mp4', 'mkv', 'mov', 'm4v'];
const OUT = [['wav', 'WAV (16-bit)'], ['mp3', 'MP3'], ['flac', 'FLAC'], ['ogg', 'OGG Vorbis'], ['opus', 'Opus'], ['m4a', 'M4A (AAC)']];
const UNDO_BYTES = 768 * 1024 * 1024;
const stream = (p) => `/api/stream?token=${encodeURIComponent(api.token)}&path=${encodeURIComponent(p)}`;
/** "1:02.5", "62.5" or "1:02:03" → seconds (null if it isn't a time). */
const parseTime = (t) => {
  const p = String(t).trim().split(':');
  if (!p.length || p.length > 3 || p.some((x) => !/^\d*\.?\d+$/.test(x.trim()))) return null;
  return p.reduce((acc, x) => acc * 60 + parseFloat(x), 0);
};
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`; };
const REC_WORKLET = URL.createObjectURL(new Blob([`registerProcessor('bds-rec', class extends AudioWorkletProcessor {
  process(inputs) { const i = inputs[0]; if (i && i.length) this.port.postMessage(i.map((c) => c.slice(0))); return true; }
});`], { type: 'text/javascript' }));

export class WaveEditor extends BaseEditor {
  static mode = 'wave';

  async load() {
    this.ch = []; // Float32Array per channel
    this.len = 0;
    this.name = 'Untitled';
    this.path = null;
    this.sel = { a: 0, b: 0 }; // samples; a === b is the cursor
    this.view = { start: 0, spp: 256 }; // first sample shown, samples per pixel
    this.undoStack = [];
    this.redoStack = [];
    this.loop = false;
    this.buildUI();
    this.render();
  }

  // ================================================================ the sound

  get dur() { return this.len / SR; }
  get chans() { return this.ch.length || 2; }
  hasSel() { return this.sel.b > this.sel.a; }
  range() { return this.hasSel() ? [this.sel.a, this.sel.b] : [0, this.len]; }

  async decode(arrayBuf) {
    const ctx = new OfflineAudioContext(2, 1, SR);
    const b = await ctx.decodeAudioData(arrayBuf);
    return Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, c) => b.getChannelData(c).slice());
  }

  async openFile(path) {
    if (!(await this.okToReplace())) return;
    this.busy(`Opening ${basename(path)}…`);
    try {
      const res = await fetch(stream(path));
      if (!res.ok) throw new Error('Couldn’t read that file');
      let ch;
      try { ch = await this.decode(await res.arrayBuffer()); }
      catch { throw new Error('That file has no sound this editor can read.'); }
      this.ch = ch;
      this.len = ch[0]?.length || 0;
      this.path = path;
      this.name = stripExt(basename(path));
      this.undoStack = []; this.redoStack = [];
      this.sel = { a: 0, b: 0 };
      this.fitView();
      this.setTitle();
      this.dirty = false;
      api.addRecent?.(path).catch(() => {});
    } catch (e) { errorToast(e); }
    this.busy(null);
    this.render();
  }

  async okToReplace() {
    if (!this.len || !this.dirty) return true;
    const { confirmDialog } = await import('../core/ui.js');
    return confirmDialog('Open another sound', 'The changes to this one aren’t exported yet. Open another anyway?', { okLabel: 'Open' });
  }

  setTitle() {
    this.tab.title = this.len ? `${this.name} · ${this.app.toolName('BoxWave')}` : this.app.toolName('BoxWave');
    this.app.renderTabs?.();
  }

  /** Remember the sound before a change (for undo). `redo` does the change again on whatever the sound is then, so
   *  an effect further back can be taken out or moved and everything after it done again. An effect or filter gives
   *  `again(a, b)` instead, which does it on any stretch, and `fx` = [a, b], where it went; the Applied list shows those. */
  snapshot(label, redo = null, fx = null, again = null) {
    if (again) redo = () => again(fx[0], fx[1]);
    this.undoStack.push({ label, redo, fx, again, ch: this.ch.map((c) => c.slice()), len: this.len, sel: { ...this.sel } });
    this.redoStack = [];
    // keep the newest steps that fit
    let bytes = 0;
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      bytes += this.undoStack[i].ch.reduce((n, c) => n + c.byteLength, 0);
      if (bytes > UNDO_BYTES && i < this.undoStack.length - 1) { this.undoStack.splice(0, i + 1); break; }
    }
  }
  changed() {
    this.playBuf = null;
    this.dirty = true;
    this.render();
  }
  undo() { this.step(this.undoStack, this.redoStack, 'Undid'); }
  redo() { this.step(this.redoStack, this.undoStack, 'Redid'); }
  step(from, to, verb) {
    const s = from.pop();
    if (!s) return;
    this.stop();
    to.push({ ...s, ch: this.ch, len: this.len, sel: { ...this.sel } });
    this.ch = s.ch; this.len = s.len; this.sel = s.sel;
    this.clampView();
    this.changed();
    toast(`${verb} ${s.label}`, { timeout: 1400 });
  }

  /** New channels with [a,b) replaced by `ins` (arrays per channel; mono fills both sides). */
  splice(a, b, ins = null) {
    const insLen = ins ? ins[0].length : 0;
    const n = this.len - (b - a) + insLen;
    const nch = Math.max(this.ch.length, ins?.length || 0, 1);
    const out = [];
    for (let c = 0; c < nch; c++) {
      const src = this.ch[c] || this.ch[0] || new Float32Array(0);
      const o = new Float32Array(n);
      o.set(src.subarray(0, a), 0);
      if (ins) o.set(ins[c] || ins[0], a);
      o.set(src.subarray(b), a + insLen);
      out.push(o);
    }
    this.ch = out;
    this.len = n;
  }

  // ================================================================ editing

  need(sel = true) {
    if (!this.len) { toast('Open or record a sound first.'); return false; }
    if (sel && !this.hasSel()) { toast('Select part of the sound first (drag across the waveform).'); return false; }
    return true;
  }

  copy() {
    if (!this.need()) return;
    const [a, b] = [this.sel.a, this.sel.b];
    WaveEditor.clip = this.ch.map((c) => c.slice(a, b));
    toast(`Copied ${fmt((b - a) / SR)}`, { timeout: 1200 });
  }
  cut() {
    if (!this.need()) return;
    this.copy();
    this.del('Cut');
  }
  del(label = 'Delete') {
    if (!this.need()) return;
    this.stop();
    const { a, b } = this.sel;
    this.snapshot(label, () => this.splice(a, b));
    this.splice(a, b);
    this.sel = { a: this.sel.a, b: this.sel.a };
    this.clampView();
    this.changed();
  }
  paste() {
    const clip = WaveEditor.clip;
    if (!clip) { toast('Nothing copied yet.'); return; }
    this.stop();
    const a = this.sel.a, b = this.sel.b;
    this.snapshot('Paste', () => this.splice(a, b, clip));
    this.splice(a, b, clip);
    this.sel = { a, b: a + clip[0].length };
    this.clampView();
    this.changed();
  }
  trim() {
    if (!this.need()) return;
    this.stop();
    const { a, b } = this.sel;
    const keep = () => { this.ch = this.ch.map((c) => c.slice(a, b)); this.len = this.ch[0]?.length || 0; };
    this.snapshot('Trim', keep);
    keep();
    this.sel = { a: 0, b: this.len };
    this.fitView();
    this.changed();
  }
  silence() {
    if (!this.need()) return;
    const { a, b } = this.sel;
    const hush = (a2, b2) => { for (const c of this.ch) c.fill(0, a2, b2); };
    this.snapshot('Silence', null, [a, b], hush);
    hush(a, b);
    this.changed();
  }
  insertSilence = async () => {
    const v = await promptDialog('Insert silence', 'Seconds', '1');
    const s = +v;
    if (!(s > 0)) return;
    const n = Math.round(Math.min(3600, s) * SR);
    const at = this.sel.a;
    const add = () => {
      this.splice(at, at, Array.from({ length: this.chans }, () => new Float32Array(n)));
      if (!this.ch.length) { this.ch = [new Float32Array(n), new Float32Array(n)]; this.len = n; }
    };
    this.snapshot('Insert silence', add);
    add();
    this.sel = { a: this.sel.a, b: this.sel.a + n };
    this.fitIfEmpty();
    this.changed();
  };
  selectAll() { this.sel = { a: 0, b: this.len }; this.render(); }

  /** Run fn(channelArray, a, b) on the selection (or everything). */
  process(label, fn) {
    if (!this.need(false)) return;
    const [a, b] = this.range();
    this.stop();
    const run = (a2, b2) => this.ch.forEach((c, i) => fn(c, a2, b2, i));
    this.snapshot(label, null, [a, b], run);
    run(a, b);
    this.changed();
  }
  peak(a, b) { let p = 0; for (const c of this.ch) for (let i = a; i < b; i++) { const v = Math.abs(c[i]); if (v > p) p = v; } return p; }

  async amplify() {
    if (!this.need(false)) return;
    const [a, b] = this.range();
    const p = this.peak(a, b);
    const most = p > 0 ? -20 * Math.log10(p) : 0;
    const v = await promptDialog('Amplify', `Change in dB (up to ${most.toFixed(1)} dB before it clips)`, String(+most.toFixed(1)));
    const db = parseFloat(v);
    if (!Number.isFinite(db)) return;
    const k = Math.pow(10, db / 20);
    this.process(`Amplify ${db > 0 ? '+' : ''}${db} dB`, (c, a2, b2) => { for (let i = a2; i < b2; i++) c[i] *= k; });
  }
  normalize() {
    if (!this.need(false)) return;
    const [a, b] = this.range();
    const p = this.peak(a, b);
    if (!p) { toast('It’s silent.'); return; }
    const k = Math.pow(10, -1 / 20) / p; // to -1 dB
    this.process('Normalize', (c, a2, b2) => { for (let i = a2; i < b2; i++) c[i] *= k; });
  }
  fade(dir) {
    if (!this.need(false)) return;
    this.process(dir > 0 ? 'Fade in' : 'Fade out', (c, a, b) => {
      const n = b - a;
      for (let i = 0; i < n; i++) { const t = i / n; c[a + i] *= dir > 0 ? t * t : (1 - t) * (1 - t); }
    });
  }
  reverse() { this.process('Reverse', (c, a, b) => c.subarray(a, b).reverse()); }
  invert() { this.process('Invert', (c, a, b) => { for (let i = a; i < b; i++) c[i] = -c[i]; }); }
  toMono() {
    if (!this.need(false) || this.ch.length < 2) return;
    const mono = (a, b) => {
      if (this.ch.length < 2) return;
      for (let i = a; i < b; i++) this.ch[0][i] = this.ch[1][i] = (this.ch[0][i] + this.ch[1][i]) / 2;
    };
    this.snapshot('Make mono', null, [0, this.len], mono);
    mono(0, this.len);
    this.changed();
  }

  /** Render part of the sound through an OfflineAudioContext graph: build(ctx, input, output). */
  async renderPart(label, build, { speed = 1 } = {}) {
    if (!this.need(false)) return;
    const [a, b] = this.range();
    const n = b - a;
    this.busy(`${label}…`);
    try {
      const outLen = Math.max(1, Math.round(n / speed));
      const r = await this.renderRange(a, b, build, speed);
      this.stop();
      this.snapshot(label, null, [a, b], async (a2, b2) => this.splice(a2, b2, await this.renderRange(a2, b2, build, speed)));
      this.splice(a, b, r);
      this.sel = { a, b: a + outLen };
      this.clampView();
      this.changed();
    } catch (e) { errorToast(e, `Couldn’t ${label.toLowerCase()}`); }
    this.busy(null);
  }

  /** [a,b) of the sound through build(ctx, input, output), as new channels. */
  async renderRange(a, b, build, speed = 1) {
    const n = b - a;
    const ctx = new OfflineAudioContext(2, Math.max(1, Math.round(n / speed)), SR);
    const buf = ctx.createBuffer(2, n, SR);
    for (let c = 0; c < 2; c++) buf.copyToChannel((this.ch[c] || this.ch[0]).subarray(a, b), c);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = speed;
    const out = ctx.createGain();
    await build(ctx, src, out);
    out.connect(ctx.destination);
    src.start();
    const r = await ctx.startRendering();
    return [r.getChannelData(0), r.getChannelData(1)];
  }

  /** Take one effect back out (`to` null) or do it on another stretch instead (`to` = [a, b]): back to the sound
   *  before it, then every later step done again on top. */
  async rebuild(k, to = null) {
    const e = this.undoStack[k];
    if (!e?.fx || this.busyNow) return;
    const what = to ? `moving ${e.label}` : `taking out ${e.label}`;
    // an "undo that" step from an earlier rebuild belongs to the old sound; it goes
    const later = this.undoStack.slice(k + 1).filter((x) => !x.jump);
    if (later.some((x) => !x.redo)) { toast(`A step after ${e.label} can’t be done again, so it can only be undone.`, { type: 'error' }); return; }
    const lenAfter = later[0]?.len;
    this.stop();
    this.busyNow = true;
    this.busy(`${what[0].toUpperCase()}${what.slice(1)}…`);
    const keep = { stack: this.undoStack, ch: this.ch, len: this.len, sel: { ...this.sel } };
    try {
      this.undoStack = this.undoStack.slice(0, k);
      this.ch = e.ch.map((c) => c.slice()); this.len = e.len;
      if (to) {
        this.undoStack.push({ ...e, fx: to, redo: () => e.again(to[0], to[1]), ch: this.ch.map((c) => c.slice()), len: this.len });
        await e.again(to[0], to[1]);
      }
      // the steps after it are placed by time, so they only fit if the length comes out the same
      if (later.length && this.len !== lenAfter) throw new Error(`${e.label} changes the length, and the steps after it are placed by time, so it can only be ${to ? 'moved' : 'taken out'} while it’s the latest step. Undo back to it instead.`);
      for (const x of later) {
        this.undoStack.push({ ...x, ch: this.ch.map((c) => c.slice()), len: this.len });
        await x.redo();
      }
      // undo puts it back how it was
      this.undoStack.push({ label: what, jump: true, redo: null, fx: null, ch: keep.ch, len: keep.len, sel: keep.sel });
      this.redoStack = [];
      this.sel = to ? { a: to[0], b: to[1] } : keep.sel;
      this.clampView();
      this.changed();
      toast(to ? `${e.label} now on ${fmt(to[0] / SR)} → ${fmt(to[1] / SR)}` : `Took out ${e.label}`, { timeout: 1600 });
    } catch (err) {
      Object.assign(this, { undoStack: keep.stack, ch: keep.ch, len: keep.len, sel: keep.sel });
      errorToast(err, `Couldn’t do that`);
    }
    this.busyNow = false;
    this.busy(null);
  }
  removeFx(k) { return this.rebuild(k); }

  async speed() {
    const v = await promptDialog('Change speed', 'Speed (0.25–4; the pitch goes with it, like a tape)', '1.25');
    const k = parseFloat(v);
    if (!(k >= 0.25 && k <= 4)) return;
    this.renderPart(`Speed ×${k}`, (ctx, src, out) => { src.connect(out); }, { speed: k });
  }

  async applyFx(list, label) {
    await this.renderPart(label, async (ctx, src, out) => {
      let ok = true;
      try { await ctx.audioWorklet.addModule(PITCH_URL); } catch { ok = false; }
      let at = src;
      for (const f of list) { const n = buildFx(ctx, f, ok); at.connect(n.input); at = n.output; }
      at.connect(out);
    });
  }
  async oneFx(type) {
    if (type === 'reverb') return this.reverbFx();
    const d = FX[type];
    const v = await promptDialog(d.name, `Amount (${d.min} to ${d.max} ${d.unit})`, String(d.def));
    const x = parseFloat(v);
    if (!Number.isFinite(x)) return;
    this.applyFx([newFx(type, clamp(x, d.min, d.max))], `${d.name}`);
  }

  /** Reverb: two sliders, the room's size (how long the tail rings) and the strength (how much of it you hear). */
  async reverbFx() {
    const d = FX.reverb, last = this.reverbLast || { v: d.def, mix: REVERB_MIX };
    const slider = (label, min, max, step, val, fmt, wheel) => {
      const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(val) });
      const out = h('span', { class: 'mono' }, fmt(val));
      r.addEventListener('input', () => { out.textContent = fmt(+r.value); });
      wheelSlider(r, wheel);
      return { r, el: h('label', { class: 'wv-rv-row' }, h('span', {}, label), r, out) };
    };
    const size = slider('Room size', d.min, d.max, d.step, last.v, (v) => `${v.toFixed(1)} s`, 0.2);
    const mix = slider('Strength', 0, 100, 1, last.mix, (v) => `${v}%`, 5);
    const ok = await modal({
      title: 'Reverb',
      body: h('div', { class: 'wv-rv' }, size.el, mix.el,
        h('div', { class: 'faint', style: { fontSize: '10.5px' } }, 'Room size: how long the sound rings on. Strength: how much of the room you hear over the dry sound. The mouse wheel moves a slider (Shift for fine steps).')),
      buttons: [{ label: 'Cancel', value: false, ghost: true }, { label: 'Apply', value: true, primary: true }],
    });
    if (!ok) return;
    this.reverbLast = { v: +size.r.value, mix: +mix.r.value };
    this.applyFx([{ ...newFx('reverb', this.reverbLast.v), mix: this.reverbLast.mix }], 'Reverb');
  }

  // ================================================================ playing

  ensureCtx() {
    if (!this.ac) this.ac = new AudioContext({ sampleRate: SR, latencyHint: 'playback' });
    if (this.ac.state === 'suspended') this.ac.resume();
    return this.ac;
  }
  play() {
    if (!this.len) return;
    if (this.src) { this.stop(true); return; }
    const ctx = this.ensureCtx();
    if (!this.playBuf) {
      this.playBuf = ctx.createBuffer(Math.max(1, this.ch.length), this.len, SR);
      this.ch.forEach((c, i) => this.playBuf.copyToChannel(c, i));
    }
    const [a, b] = this.hasSel() ? [this.sel.a, this.sel.b] : [this.sel.a >= this.len ? 0 : this.sel.a, this.len];
    const src = ctx.createBufferSource();
    src.buffer = this.playBuf;
    if (this.loop && this.hasSel()) { src.loop = true; src.loopStart = a / SR; src.loopEnd = b / SR; src.start(0, a / SR); }
    else src.start(0, a / SR, (b - a) / SR);
    src.connect(ctx.destination);
    src.onended = () => { if (this.src === src) { this.src = null; this.syncPlay(); this.drawHead(); } };
    this.src = src;
    this.playFrom = { t0: ctx.currentTime, a, b };
    this.syncPlay();
    this.animate();
  }
  /** pause: leave the cursor where the sound got to. */
  stop(pause = false) {
    if (!this.src) return;
    const at = this.playPos();
    const s = this.src;
    this.src = null;
    try { s.stop(); } catch { /* ended */ }
    if (pause && !this.hasSel()) this.sel = { a: at, b: at };
    this.syncPlay();
    this.render();
  }
  playPos() {
    if (!this.src) return this.sel.a;
    const { t0, a, b } = this.playFrom;
    let p = a + Math.round((this.ac.currentTime - t0) * SR);
    if (this.src.loop) p = a + ((p - a) % Math.max(1, b - a));
    return Math.min(p, this.len);
  }
  animate() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.src) return;
      const p = this.playPos();
      // keep the playhead in view
      const w = this.cv.clientWidth;
      if (p > this.view.start + w * this.view.spp * 0.95 || p < this.view.start) { this.view.start = Math.max(0, p - w * this.view.spp * 0.1); this.clampView(); this.draw(); }
      this.drawHead(p);
      this.timeEl.textContent = fmt(p / SR);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  syncPlay() {
    if (!this.playBtn) return;
    clear(this.playBtn).append(icon(this.src ? 'pause-bars' : 'play'));
    this.playBtn.dataset.tip = this.src ? 'Pause (Space)' : 'Play (Space)';
  }

  // ================================================================ recording

  async record() {
    if (this.recording) { this.stopRecord(); return; }
    this.stop();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(this.micId ? { deviceId: { exact: this.micId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } });
    } catch (e) { errorToast(e, 'No microphone'); return; }
    const ctx = this.ensureCtx();
    try { await ctx.audioWorklet.addModule(REC_WORKLET); } catch { /* already there */ }
    const node = new AudioWorkletNode(ctx, 'bds-rec', { numberOfOutputs: 0 });
    const src = ctx.createMediaStreamSource(stream);
    src.connect(node);
    const parts = [[], []];
    let n = 0;
    node.port.onmessage = (e) => {
      const d = e.data;
      parts[0].push(d[0]); parts[1].push(d[1] || d[0]);
      n += d[0].length;
      if (this.recEl) this.recEl.textContent = `● ${fmt(n / SR)}`;
      this.recLevel = Math.max(...d[0].map(Math.abs));
    };
    this.recording = { stream, node, src, parts, at: this.sel.a, b: this.sel.b, n: () => n };
    this.syncRec();
  }
  stopRecord() {
    const r = this.recording;
    if (!r) return;
    this.recording = null;
    r.src.disconnect(); r.node.port.onmessage = null;
    r.stream.getTracks().forEach((t) => t.stop());
    const n = r.n();
    this.syncRec();
    if (!n) return;
    const join = (list) => { const o = new Float32Array(n); let at = 0; for (const p of list) { o.set(p.subarray(0, n - at), at); at += p.length; if (at >= n) break; } return o; };
    const ins = [join(r.parts[0]), join(r.parts[1])];
    const put = () => { if (!this.ch.length) this.ch = [new Float32Array(0), new Float32Array(0)]; this.splice(r.at, r.b, ins); };
    this.snapshot('Recording', put);
    put();
    this.sel = { a: r.at, b: r.at + n };
    if (!this.path && this.name === 'Untitled') this.name = `Recording ${new Date().toLocaleString().replace(/[/:]/g, '-')}`;
    this.setTitle();
    this.fitIfEmpty(true);
    this.changed();
  }
  syncRec() {
    if (!this.recBtn) return;
    this.recBtn.classList.toggle('on', !!this.recording);
    this.recBtn.dataset.tip = this.recording ? 'Stop recording (R)' : 'Record from the mic at the cursor (R)';
    if (this.recEl) { this.recEl.hidden = !this.recording; this.recEl.textContent = '● 0:00.000'; }
    this.render();
  }
  async micMenu(anchor) {
    const devs = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
    showMenu([{ heading: 'Record from' }, ...devs.map((d, i) => ({ label: (d.label || `Input ${i + 1}`).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, ''), checked: (this.micId || 'default') === d.deviceId, action: () => { this.micId = d.deviceId === 'default' ? null : d.deviceId; } }))], { anchor });
  }

  // ================================================================ export

  wav(bits = 16, a = 0, b = this.len) {
    const nch = Math.max(1, this.ch.length);
    const n = b - a;
    const bps = bits / 8;
    const buf = new ArrayBuffer(44 + n * nch * bps);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * nch * bps, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, bits === 32 ? 3 : 1, true); v.setUint16(22, nch, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * nch * bps, true); v.setUint16(32, nch * bps, true); v.setUint16(34, bits, true);
    str(36, 'data'); v.setUint32(40, n * nch * bps, true);
    let o = 44;
    for (let i = a; i < b; i++) {
      for (let c = 0; c < nch; c++) {
        const s = (this.ch[c] || this.ch[0])[i];
        if (bits === 32) { v.setFloat32(o, s, true); o += 4; }
        else { v.setInt16(o, clamp(Math.round(s * 32767), -32768, 32767), true); o += 2; }
      }
    }
    return new Uint8Array(buf);
  }

  async exportAs(onlySel = false) {
    if (!this.need(onlySel)) return;
    const fmtSel = h('select', { class: 'tb-select' }, ...OUT.map(([k, n]) => h('option', { value: k, selected: k === (this.lastFormat || 'mp3') }, n)));
    const ok = await modal({ title: onlySel ? 'Export the selection' : 'Export', body: h('div', { class: 'wv-export' }, h('label', {}, 'Format ', fmtSel)),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Choose where…', value: true, primary: true }] });
    if (!ok) return;
    const ext = fmtSel.value;
    this.lastFormat = ext;
    const dest = await pickSave({ defaultName: `${this.name}${onlySel ? ' (part)' : ''}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }], title: 'Export audio' });
    if (!dest) return;
    const [a, b] = onlySel ? [this.sel.a, this.sel.b] : [0, this.len];
    this.busy('Exporting…');
    try {
      if (ext === 'wav') await api.write(dest, this.wav(16, a, b), { force: true });
      else {
        const res = await fetch(`/api/wave/export?path=${encodeURIComponent(dest)}&format=${ext}`, { method: 'POST', headers: { 'X-BDS-Token': api.token }, body: this.wav(32, a, b) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || 'Couldn’t export');
      }
      if (!onlySel) { this.path = dest; this.name = stripExt(basename(dest)); this.setTitle(); this.dirty = false; }
      toast(`Exported ${basename(dest)}`, { type: 'ok', action: { label: 'Show', fn: () => api.reveal(dest) } });
    } catch (e) { errorToast(e); }
    this.busy(null);
  }

  /** The selection straight into the audio dump, for the music player: an MP3 (a WAV without ffmpeg), named after the sound. */
  async exportToDump() {
    if (!this.need()) return;
    const { a, b } = this.sel;
    this.busy('Saving to the audio dump…');
    try {
      const tools = await api.get('/api/tools').catch(() => ({}));
      const fmt = tools.ffmpeg ? 'mp3' : 'wav';
      const res = await fetch(`/api/wave/export?dump=audio&format=${fmt}&name=${encodeURIComponent(`${this.name || 'Sound'} (part)`)}`,
        { method: 'POST', headers: { 'X-BDS-Token': api.token }, body: this.wav(fmt === 'wav' ? 16 : 32, a, b) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'Couldn’t save it');
      await this.app.music?.refresh?.();
      toast(`Saved ${out.name} to the audio dump`, { type: 'ok', action: { label: 'Play', fn: () => this.app.music?.playByName(out.name) } });
    } catch (e) { errorToast(e, 'Couldn’t save it to the audio dump'); }
    this.busy(null);
  }

  // ================================================================ view

  clampView() {
    const w = this.cv?.clientWidth || 800;
    const maxSpp = Math.max(1, this.len / Math.max(1, w));
    this.view.spp = clamp(this.view.spp, 1 / 16, Math.max(maxSpp, 1));
    this.view.start = clamp(this.view.start, 0, Math.max(0, this.len - w * this.view.spp));
    this.sel.a = clamp(this.sel.a, 0, this.len); this.sel.b = clamp(this.sel.b, this.sel.a, this.len);
  }
  fitView() {
    const w = this.cv?.clientWidth || 800;
    this.view = { start: 0, spp: Math.max(1 / 16, this.len / Math.max(1, w)) };
  }
  fitIfEmpty(force = false) { if (force || this.undoStack.length <= 1) this.fitView(); }
  zoomAt(k, x) {
    const s = this.view.start + x * this.view.spp;
    this.view.spp *= k;
    this.clampView();
    this.view.start = Math.max(0, s - x * this.view.spp);
    this.clampView();
    this.render();
  }
  zoom(delta) { this.zoomAt(delta > 0 ? 0.5 : 2, (this.cv.clientWidth || 0) / 2); }
  zoomSel() {
    if (!this.hasSel()) return;
    const w = this.cv.clientWidth;
    this.view.spp = (this.sel.b - this.sel.a) / (w * 0.9);
    this.view.start = this.sel.a - w * 0.05 * this.view.spp;
    this.clampView();
    this.render();
  }

  // ================================================================ UI

  buildToolbar() {
    this.playBtn = tbButton('play', 'Play (Space)', () => this.play());
    this.recBtn = tbButton('rec', 'Record from the mic at the cursor (R)', () => this.record(), { cls: 'wv-rec' });
    const micBtn = tbButton('chevron-down', 'Which microphone', (e) => this.micMenu(e.currentTarget), { cls: 'wv-mini' });
    this.loopBtn = tbButton('repeat', 'Loop the selection', () => { this.loop = !this.loop; this.loopBtn.classList.toggle('active', this.loop); if (this.src) { this.stop(); this.play(); } });
    const fxBtn = tbButton('wand', 'Effects', (e) => showMenu(this.fxMenu(), { anchor: e.currentTarget }), { text: 'Effects' });
    return h('div', { class: 'toolbar' },
      tbButton('folder-open', 'Open a sound (or a video’s sound)', () => this.open(), { text: 'Open' }),
      tbButton('download', 'Export as WAV, MP3, FLAC, OGG…', () => this.exportAs(), { text: 'Export' }),
      tbSep(),
      tbButton('square', 'Stop', () => { this.stop(); this.render(); }), this.playBtn, this.loopBtn, this.recBtn, micBtn,
      tbSep(),
      tbButton('undo', 'Undo (Ctrl+Z)', () => this.undo()), tbButton('redo', 'Redo (Ctrl+Y)', () => this.redo()),
      tbSep(),
      tbButton('scissors', 'Cut (Ctrl+X)', () => this.cut()), tbButton('copy', 'Copy (Ctrl+C)', () => this.copy()), tbButton('paste', 'Paste (Ctrl+V)', () => this.paste()),
      tbButton('trash', 'Delete the selection (Delete)', () => this.del()), tbButton('crop', 'Keep only the selection (Ctrl+T)', () => this.trim()), tbButton('volume-x', 'Silence the selection (Ctrl+L)', () => this.silence()),
      tbSep(), fxBtn,
      tbSep(),
      tbButton('zoom-in', 'Zoom in (Ctrl+wheel)', () => this.zoom(1)), tbButton('zoom-out', 'Zoom out', () => this.zoom(-1)),
      tbButton('maximize', 'Fit the whole sound', () => { this.fitView(); this.render(); }), tbButton('focus', 'Zoom to the selection (Ctrl+E)', () => this.zoomSel()),
      h('span', { class: 'tb-label' }, 'audio'));
  }

  fxMenu() {
    const scope = this.hasSel() ? 'the selection' : 'everything';
    return [
      { heading: `On ${scope}` },
      { label: 'Amplify…', icon: 'volume', action: () => this.amplify() },
      { label: 'Normalize (to −1 dB)', icon: 'sliders', action: () => this.normalize() },
      { label: 'Fade in', icon: 'trending-up', action: () => this.fade(1) },
      { label: 'Fade out', icon: 'trending-down', action: () => this.fade(-1) },
      { label: 'Reverse', icon: 'repeat', action: () => this.reverse() },
      { label: 'Change speed…', icon: 'fast-forward', action: () => this.speed() },
      { label: 'Invert', action: () => this.invert() },
      { label: 'Make mono', disabled: this.ch.length < 2, action: () => this.toMono() },
      { sep: true },
      { label: 'Voice changer', icon: 'wand', submenu: VOICES.map((v) => ({ label: v.name, action: () => this.applyFx(v.fx.map(([t, x]) => newFx(t, x)), v.name) })) },
      { label: 'Effect', icon: 'plus', submenu: Object.entries(FX).map(([t, d]) => ({ label: `${d.name}…`, action: () => this.oneFx(t) })) },
      { sep: true },
      { label: 'Insert silence at the cursor…', action: this.insertSilence },
    ];
  }

  async open() {
    const p = await pickOpen({ title: 'Open a sound', filters: [{ name: 'Sound and video', extensions: AUDIO_EXT }, { name: 'All files', extensions: ['*'] }] });
    if (p) this.openFile(p[0]);
  }

  buildUI() {
    this.cv = h('canvas', { class: 'wv-canvas' });
    this.head = h('div', { class: 'wv-head', hidden: true });
    this.played = h('div', { class: 'wv-played', hidden: true });
    this.ruler = h('canvas', { class: 'wv-ruler' });
    this.empty = h('div', { class: 'wv-empty' },
      icon('wave', 'xl'), h('div', {}, 'Open a sound, drop one here, or record from your mic.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => this.open() }, icon('folder-open', 'sm'), 'Open…'),
        h('button', { class: 'btn', onclick: () => this.record() }, icon('rec', 'sm'), 'Record')));
    this.busyEl = h('div', { class: 'wv-busy', hidden: true });
    this.wrap = h('div', { class: 'wv-wrap', tabindex: '0' }, this.ruler, h('div', { class: 'wv-tracks' }, this.cv, this.played, this.head), this.empty, this.busyEl);
    this.timeEl = h('span', { class: 'wv-time mono' }, '0:00.000');
    this.recEl = h('span', { class: 'wv-rectime mono', hidden: true });
    this.selEl = h('div', { class: 'wv-selinfo mono' });
    this.fxEl = h('div', { class: 'wv-applied', hidden: true });
    this.scroll = h('input', { type: 'range', class: 'wv-scroll', min: '0', max: '1000', value: '0', oninput: () => {
      const w = this.cv.clientWidth;
      this.view.start = (+this.scroll.value / 1000) * Math.max(0, this.len - w * this.view.spp);
      this.render();
    } });
    this.root = h('div', { class: 'wv' }, this.wrap, this.scroll, this.fxEl, h('div', { class: 'wv-bar' }, this.timeEl, this.recEl, h('div', { class: 'grow' }), this.selEl));
    this.pane.append(this.root);
    this.ro = new ResizeObserver(() => { this.clampView(); this.render(); });
    this.ro.observe(this.wrap);
    this.wire();
  }

  xToSample(x) { return clamp(Math.round(this.view.start + x * this.view.spp), 0, this.len); }

  wire() {
    const cv = this.cv;
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.len) return;
      this.wrap.focus({ preventScroll: true });
      const r = cv.getBoundingClientRect();
      const s0 = this.xToSample(e.clientX - r.left);
      const anchor = e.shiftKey ? (Math.abs(s0 - this.sel.a) < Math.abs(s0 - this.sel.b) ? this.sel.b : this.sel.a) : s0;
      const wasPlaying = !!this.src;
      if (wasPlaying) this.stop();
      this.sel = { a: Math.min(anchor, s0), b: Math.max(anchor, s0) };
      this.render();
      cv.setPointerCapture(e.pointerId);
      const move = (ev) => {
        let x = ev.clientX - r.left;
        // dragging past the edge scrolls
        if (x < 0) { this.view.start = Math.max(0, this.view.start + x * this.view.spp * 0.2); x = 0; }
        if (x > r.width) { this.view.start += (x - r.width) * this.view.spp * 0.2; x = r.width; }
        this.clampView();
        const s = this.xToSample(x);
        this.sel = { a: Math.min(anchor, s), b: Math.max(anchor, s) };
        this.render();
      };
      const up = () => {
        cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up);
        if (this.editing && this.sel.b > this.sel.a) { this.editing.a = this.sel.a; this.editing.b = this.sel.b; this.render(); }
        if (wasPlaying) this.play();
      };
      cv.addEventListener('pointermove', move);
      cv.addEventListener('pointerup', up);
    });
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e, [
        { label: 'Cut', icon: 'scissors', disabled: !this.hasSel(), action: () => this.cut() },
        { label: 'Copy', icon: 'copy', disabled: !this.hasSel(), action: () => this.copy() },
        { label: 'Paste', icon: 'paste', disabled: !WaveEditor.clip, action: () => this.paste() },
        { label: 'Delete', icon: 'trash', disabled: !this.hasSel(), action: () => this.del() },
        { label: 'Keep only this', icon: 'crop', disabled: !this.hasSel(), action: () => this.trim() },
        { label: 'Silence', icon: 'volume-x', disabled: !this.hasSel(), action: () => this.silence() },
        { sep: true },
        { label: 'Effects', icon: 'wand', submenu: this.fxMenu() },
        { label: 'Export the selection…', icon: 'download', disabled: !this.hasSel(), action: () => this.exportAs(true) },
        { label: 'Export the selection to the audio dump', icon: 'music', disabled: !this.hasSel(), action: () => this.exportToDump() },
        { sep: true },
        { label: 'Select all', action: () => this.selectAll() },
      ]);
    });
    this.wrap.addEventListener('wheel', (e) => {
      if (!this.len) return;
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      if (e.ctrlKey) this.zoomAt(e.deltaY < 0 ? 0.8 : 1.25, e.clientX - r.left);
      else { this.view.start += (e.deltaY + e.deltaX) * this.view.spp * 0.6; this.clampView(); this.render(); }
    }, { passive: false });
    this.wrap.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    this.wrap.addEventListener('drop', async (e) => {
      e.preventDefault();
      let paths = draggedPaths(e);
      if (!paths.length) paths = [...(e.dataTransfer.files || [])].map((f) => window.bdsShell?.pathForFile?.(f) || '').filter(Boolean);
      const p = paths.find((x) => AUDIO_EXT.includes(extOf(x).toLowerCase())) || paths[0];
      if (!p) return;
      if (!this.len) { this.openFile(p); return; }
      // into the sound at the cursor
      this.busy('Adding…');
      try {
        const ins = await this.decode(await (await fetch(stream(p))).arrayBuffer());
        const a = this.sel.a;
        this.snapshot(`Add ${basename(p)}`, () => this.splice(a, a, ins));
        this.splice(a, a, ins);
        this.sel = { a, b: a + ins[0].length };
        this.changed();
      } catch { toast('That file has no sound this editor can read.', { type: 'error' }); }
      this.busy(null);
    });
  }

  handlesKey(e) {
    if (this.app.active !== this.tab) return false;
    const t = e.target;
    if (t?.tagName === 'INPUT' && t.type !== 'range' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return false;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const run = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); return true; };
    if (e.key === ' ' && !ctrl) return run(() => this.play());
    if (k === 'r' && !ctrl && !e.altKey) return run(() => this.record());
    if (!this.len) return false;
    if (ctrl && k === 'c') return run(() => this.copy());
    if (ctrl && k === 'x') return run(() => this.cut());
    if (ctrl && k === 'v') return run(() => this.paste());
    if (ctrl && k === 'a') return run(() => this.selectAll());
    if (ctrl && k === 't') return run(() => this.trim());
    if (ctrl && k === 'l') return run(() => this.silence());
    if (ctrl && k === 'e') return run(() => this.zoomSel());
    if (ctrl && (k === '=' || k === '+')) return run(() => this.zoom(1));
    if (ctrl && k === '-') return run(() => this.zoom(-1));
    if (e.key === 'Delete' || e.key === 'Backspace') return run(() => this.del());
    if (e.key === 'Home') return run(() => { this.sel = { a: 0, b: 0 }; this.view.start = 0; this.render(); });
    if (e.key === 'End') return run(() => { this.sel = { a: this.len, b: this.len }; this.view.start = this.len; this.clampView(); this.render(); });
    if (e.key === 'Escape') return run(() => { if (this.editing) { this.editFx(null); return; } this.sel = { a: this.sel.a, b: this.sel.a }; this.render(); });
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      return run(() => {
        const d = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? SR : Math.max(1, Math.round(this.view.spp * 10)));
        const p = clamp(this.sel.a + d, 0, this.len);
        this.sel = { a: p, b: p };
        this.render();
      });
    }
    return false;
  }

  busy(msg) {
    if (!this.busyEl) return;
    this.busyEl.hidden = !msg;
    clear(this.busyEl).append(...(msg ? [h('div', { class: 'spinner' }), msg] : []));
  }

  // ================================================================ drawing

  render() {
    if (!this.cv) return;
    this.empty.hidden = !!this.len || !!this.recording;
    this.draw();
    this.drawRuler();
    this.drawHead();
    const w = this.cv.clientWidth;
    const span = Math.max(0, this.len - w * this.view.spp);
    this.scroll.hidden = !span;
    this.scroll.value = String(span ? Math.round((this.view.start / span) * 1000) : 0);
    const { a, b } = this.sel;
    clear(this.selEl).append(this.len ? (b > a ? `${fmt(a / SR)} → ${fmt(b / SR)}  ·  ${fmt((b - a) / SR)}` : `cursor ${fmt(a / SR)}`) : '', this.len ? `  ·  ${fmt(this.dur)} · ${this.ch.length === 1 ? 'mono' : 'stereo'} · 48 kHz` : '');
    if (!this.src) this.timeEl.textContent = fmt(a / SR);
    this.renderApplied();
    this.refreshStatus();
  }

  /** The effects and filters on the sound, each with an × to take it back out. Clicking one opens where it goes:
   *  type the times, or drag across the waveform, then Apply. */
  renderApplied() {
    const list = this.undoStack.map((e, k) => [e, k]).filter(([e]) => e.fx);
    if (this.editing && !this.undoStack.includes(this.editing.e)) this.editing = null;
    this.fxEl.hidden = !list.length;
    if (this.editing && this.fxEl.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') {
      // typing in a time box: leave the boxes alone, only follow a drag on the waveform
      return;
    }
    clear(this.fxEl);
    if (!list.length) return;
    this.fxEl.append(h('span', { class: 'wv-applied-h' }, 'Applied'));
    for (const [e, k] of list) {
      const [a, b] = e.fx;
      const where = a === 0 && b >= e.len ? 'on everything' : `on ${fmt(a / SR)} → ${fmt(b / SR)}`;
      const on = this.editing?.e === e;
      this.fxEl.append(h('span', { class: `wv-chip${on ? ' on' : ''}`, 'data-tip': `${e.label}, ${where}. Click to change where it goes`,
        onclick: () => this.editFx(on ? null : e) },
      e.label,
      h('button', { class: 'wv-chip-x', 'data-tip': `Take out ${e.label}`, onclick: (ev) => { ev.stopPropagation(); this.removeFx(k); } }, icon('x', 'sm'))));
    }
    if (this.editing) {
      const ed = this.editing;
      const box = (v, set) => h('input', { class: 'wv-time-in mono', value: fmt(v / SR), spellcheck: 'false',
        onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); this.applyEdit(); } else if (ev.key === 'Escape') { ev.preventDefault(); this.editFx(null); } },
        onchange: (ev) => {
          const t = parseTime(ev.target.value);
          if (t == null) { ev.target.value = fmt(v / SR); return; }
          set(clamp(Math.round(t * SR), 0, this.len));
          if (ed.b < ed.a) [ed.a, ed.b] = [ed.b, ed.a];
          this.sel = { a: ed.a, b: ed.b };
          this.render();
        } });
      this.fxEl.append(h('span', { class: 'wv-fxedit' },
        h('span', { class: 'wv-fxedit-h' }, ed.e.label),
        box(ed.a, (x) => { ed.a = x; }), '→', box(ed.b, (x) => { ed.b = x; }),
        h('button', { class: 'btn sm', 'data-tip': 'Use the whole sound', onclick: () => { ed.a = 0; ed.b = this.len; this.sel = { a: 0, b: this.len }; this.render(); } }, 'All'),
        h('button', { class: 'btn sm primary', onclick: () => this.applyEdit() }, 'Apply'),
        h('button', { class: 'btn sm', onclick: () => this.editFx(null) }, 'Cancel')));
    }
  }
  /** Start (or stop) changing where an applied effect goes; the selection shows it and dragging changes it. */
  editFx(e) {
    if (!e) { this.editing = null; this.render(); return; }
    const [a, b] = e.fx;
    this.editing = { e, a: Math.min(a, this.len), b: Math.min(b, this.len) };
    this.sel = { a: this.editing.a, b: this.editing.b };
    this.render();
  }
  applyEdit() {
    const ed = this.editing;
    if (!ed) return;
    const k = this.undoStack.indexOf(ed.e);
    this.editing = null;
    if (ed.b <= ed.a) { toast('Pick a stretch with a start before its end.', { type: 'error' }); this.render(); return; }
    if (k < 0 || (ed.a === ed.e.fx[0] && ed.b === ed.e.fx[1])) { this.render(); return; }
    this.rebuild(k, [ed.a, ed.b]);
  }

  colors() {
    const cs = getComputedStyle(this.root);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    return { bg: v('--bg-1', '#111'), line: v('--line', '#333'), wave: v('--accent', '#f80'), sel: v('--accent-soft', 'rgba(255,128,0,.2)'), text: v('--text-3', '#888'), mid: v('--line-2', '#444') };
  }

  draw() {
    const cv = this.cv;
    const dpr = devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = this.colors();
    g.fillStyle = c.bg;
    g.fillRect(0, 0, W, H);
    if (!this.len) return;
    const { start, spp } = this.view;
    // selection
    const sx = (this.sel.a - start) / spp, ex = (this.sel.b - start) / spp;
    if (this.sel.b > this.sel.a) { g.fillStyle = c.sel; g.fillRect(sx, 0, Math.max(1, ex - sx), H); }
    const nch = this.ch.length;
    const lane = H / nch;
    for (let k = 0; k < nch; k++) {
      const data = this.ch[k];
      const mid = lane * k + lane / 2;
      const amp = lane / 2 - 4;
      g.strokeStyle = c.mid; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, Math.round(mid) + 0.5); g.lineTo(W, Math.round(mid) + 0.5); g.stroke();
      if (k) { g.strokeStyle = c.line; g.beginPath(); g.moveTo(0, lane * k + 0.5); g.lineTo(W, lane * k + 0.5); g.stroke(); }
      g.fillStyle = c.wave; g.strokeStyle = c.wave;
      if (spp > 1) {
        for (let x = 0; x < W; x++) {
          const i0 = Math.floor(start + x * spp), i1 = Math.min(this.len, Math.floor(start + (x + 1) * spp));
          if (i0 >= this.len) break;
          let lo = 1, hi = -1;
          // very zoomed out: a stride keeps drawing quick; peaks still show
          const stride = Math.max(1, Math.floor((i1 - i0) / 2000));
          for (let i = i0; i < i1; i += stride) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
          if (hi < lo) continue;
          g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
        }
      } else {
        // close up: the samples themselves
        g.lineWidth = 1.5;
        g.beginPath();
        const i0 = Math.floor(start), i1 = Math.min(this.len, Math.ceil(start + W * spp) + 1);
        for (let i = i0; i < i1; i++) { const x = (i - start) / spp; const y = mid - data[i] * amp; if (i === i0) g.moveTo(x, y); else g.lineTo(x, y); }
        g.stroke();
        if (spp < 0.25) for (let i = i0; i < i1; i++) g.fillRect((i - start) / spp - 2, mid - data[i] * amp - 2, 4, 4);
      }
    }
    // cursor
    if (this.sel.a === this.sel.b) { g.fillStyle = c.text; g.fillRect(Math.round(sx), 0, 1, H); }
  }

  drawRuler() {
    const cv = this.ruler;
    const dpr = devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = this.colors();
    g.clearRect(0, 0, W, H);
    if (!this.len) return;
    const secPerPx = this.view.spp / SR;
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => s / secPerPx >= 80) || 600;
    const t0 = this.view.start / SR;
    g.fillStyle = c.text; g.strokeStyle = c.line;
    g.font = '10px ' + (getComputedStyle(this.root).getPropertyValue('--font-mono') || 'monospace');
    for (let t = Math.floor(t0 / step) * step; ; t += step) {
      const x = (t - t0) / secPerPx;
      if (x > W) break;
      if (x < 0) continue;
      g.fillRect(Math.round(x), H - 6, 1, 6);
      const m = Math.floor(t / 60), s = t - m * 60;
      g.fillText(step >= 1 ? `${m}:${String(Math.round(s)).padStart(2, '0')}` : `${m}:${s.toFixed(step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3).padStart(step >= 0.1 ? 4 : step >= 0.01 ? 5 : 6, '0')}`, x + 3, 10);
    }
  }

  drawHead(p = this.src ? this.playPos() : null) {
    if (p == null) { this.head.hidden = true; this.played.hidden = true; return; }
    const x = (p - this.view.start) / this.view.spp;
    this.head.hidden = x < 0 || x > this.cv.clientWidth;
    this.head.style.transform = `translateX(${x}px)`;
    // what's been played so far, tinted: from where playback started (a selection's start), clipped to the view
    const x0 = clamp(((this.playFrom?.a ?? 0) - this.view.start) / this.view.spp, 0, this.cv.clientWidth);
    const x1 = clamp(x, 0, this.cv.clientWidth);
    this.played.hidden = x1 <= x0;
    this.played.style.left = `${x0}px`;
    this.played.style.width = `${x1 - x0}px`;
  }

  // ================================================================ BaseEditor

  status() {
    return {
      left: [{ text: this.app.toolName('BoxWave'), icon: 'wave' }, ...(this.len ? [{ text: this.name }] : [])],
      right: [
        ...(this.recording ? [{ text: '● recording', cls: 'st-status-rec' }] : []),
        ...(this.len ? [{ text: `${fmt(this.dur)}` }] : []),
        { text: `${this.undoStack.length} undo` },
      ],
    };
  }

  onShow() { this.render(); }
  onHide() { if (this.src) this.stop(true); }

  async beforeClose() {
    if (this.recording) this.stopRecord();
    if (!this.dirty || !this.len) return true;
    this.app.activate?.(this.tab);
    const { choiceDialog } = await import('../core/ui.js');
    const c = await choiceDialog('Not exported', `Export “${this.name}” before closing?`, [
      { label: 'Cancel', value: 'cancel' }, { label: 'Close anyway', value: 'close', danger: true }, { label: 'Export…', value: 'export', primary: true }]);
    if (c === 'export') { await this.exportAs(); return !this.dirty; }
    return c === 'close';
  }

  destroy() {
    this.stop();
    if (this.recording) { this.recording.stream.getTracks().forEach((t) => t.stop()); this.recording = null; }
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.ac?.close().catch(() => {});
  }
}
