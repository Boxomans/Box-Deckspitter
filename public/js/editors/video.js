// Video / audio mode — play, mark in/out, and export a trimmed clip (MP4, WebM, GIF, MP3, WAV or lossless copy).
// Uses native ffmpeg when it's installed, otherwise ffmpeg.wasm running inside the app.

import { BaseEditor } from './base.js';
import { h, clear, clamp, stripExt, extOf, basename, dirname, joinPath, formatBytes, debounce } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { tbButton, tbSep, tbSelect, showMenu, toast, errorToast, modal } from '../core/ui.js';
import { api } from '../core/api.js';
import { pickSave, getLastDir } from '../core/files.js';

export const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv', 'avi', 'wmv', '3gp', 'ts', 'mts', 'm2ts', 'flv'];
export const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba'];

const FORMATS = [
  { id: 'copy', label: 'Same format — instant, no quality loss', note: 'cuts land on the nearest keyframe', video: true, audio: true },
  { id: 'mp4', label: 'MP4 (H.264) — exact cut', ext: 'mp4', video: true },
  { id: 'webm', label: 'WebM (VP8)', ext: 'webm', video: true },
  { id: 'gif', label: 'Animated GIF', ext: 'gif', video: true },
  { id: 'mp3', label: 'MP3 audio', ext: 'mp3', video: true, audio: true },
  { id: 'wav', label: 'WAV audio', ext: 'wav', video: true, audio: true },
];

let ffmpegPromise = null;
async function loadFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import('/vendor/@ffmpeg/ffmpeg/dist/esm/index.js');
      const ff = new FFmpeg();
      const base = location.origin + '/vendor/@ffmpeg/core/dist/esm/';
      await ff.load({ coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm' });
      return ff;
    })().catch((e) => { ffmpegPromise = null; throw e; });
  }
  return ffmpegPromise;
}

export const fmtTime = (s, ms = true) => {
  if (!Number.isFinite(s)) return '--:--';
  const neg = s < 0;
  s = Math.abs(s);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const sec = ms ? ss.toFixed(2).padStart(5, '0') : String(Math.floor(ss)).padStart(2, '0');
  return (neg ? '-' : '') + (hh ? `${hh}:${String(mm).padStart(2, '0')}:${sec}` : `${String(mm).padStart(2, '0')}:${sec}`);
};
const parseTime = (t) => {
  const parts = String(t).trim().split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};

export class VideoEditor extends BaseEditor {
  static mode = 'video';
  handlesWheelZoom = true;

  async load(bytes) {
    this.isAudio = AUDIO_EXT.includes(this.tab.ext);
    this.bytes = bytes && bytes.length ? bytes : null;
    if (this.bytes) this.src = URL.createObjectURL(new Blob([this.bytes], { type: (this.isAudio ? 'audio/' : 'video/') + (this.tab.ext === 'mov' ? 'quicktime' : this.tab.ext) }));
    else if (this.tab.path) this.src = `/api/stream?token=${encodeURIComponent(api.token)}&path=${encodeURIComponent(this.tab.path)}`;
    this.tools = await fetch('/api/tools', { headers: { 'X-BDS-Token': api.token } }).then((r) => r.json()).catch(() => ({}));
    this.in = 0;
    this.out = 0;
    this.loop = false;
    this.format = 'copy';
    this.scaleOpt = 'orig';
    this.noAudio = false;
    this.gifFps = 12;
    this.gifWidth = 480;
    this.buildDom();
    await new Promise((resolve) => {
      const done = () => resolve();
      this.media.addEventListener('loadedmetadata', done, { once: true });
      this.media.addEventListener('error', done, { once: true });
      setTimeout(done, 8000);
    });
    // WebM from screen recorders has no duration in its header: seek far ahead once to make the browser compute it.
    if (!this.media.error && this.media.duration === Infinity) {
      await new Promise((resolve) => {
        const done = () => { this.media.removeEventListener('durationchange', check); resolve(); };
        const check = () => { if (Number.isFinite(this.media.duration)) done(); };
        this.media.addEventListener('durationchange', check);
        this.media.currentTime = 1e101;
        setTimeout(done, 6000);
      });
      this.media.currentTime = 0;
    }
    if (this.media.error || !Number.isFinite(this.media.duration)) {
      this.unplayable = true;
      this.stageMsg.hidden = false;
      this.stageMsg.textContent = `This ${this.tab.ext.toUpperCase()} file can’t be previewed in the app, but you can still export it — try MP4 to convert.`;
    }
    this.duration = Number.isFinite(this.media.duration) ? this.media.duration : 0;
    this.out = this.duration;
    this.renderPanel();
    this.updateTimeline();
    if (!this.isAudio) setTimeout(() => this.buildFilmstrip(), 150);
    else this.buildWaveform();
  }

  // =================================================================== DOM

  buildDom() {
    this.media = h(this.isAudio ? 'audio' : 'video', { class: 'vid-media', src: this.src, preload: 'auto', playsinline: true });
    this.stageMsg = h('div', { class: 'vid-msg', hidden: true });
    this.bigPlay = h('button', { class: 'vid-bigplay', onclick: () => this.toggle() }, icon('play', 'xl'));
    this.audioArt = this.isAudio ? h('div', { class: 'vid-audio-art' }, icon('note', 'xl'), h('div', { class: 'mono' }, this.tab.title)) : null;
    this.stage = h('div', { class: 'vid-stage' }, this.audioArt, this.media, this.stageMsg, this.bigPlay);
    this.stage.addEventListener('click', (e) => { if (e.target === this.media || e.target === this.stage) this.toggle(); });

    this.timeLabel = h('span', { class: 'vid-time mono' }, '00:00.00 / 00:00.00');
    this.playBtn = h('button', { class: 'icon-btn vid-play', 'data-tip': 'Play / pause', 'data-key': 'Space', onclick: () => this.toggle() }, icon('play', 'lg'));
    const speed = h('select', { class: 'tb-select', 'data-tip': 'Speed' }, [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4].map((s) => h('option', { value: String(s) }, s + '×')));
    speed.value = '1';
    speed.addEventListener('change', () => { this.media.playbackRate = Number(speed.value); });
    const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '1', class: 'vid-vol', 'data-tip': 'Volume' });
    vol.addEventListener('input', () => { this.media.volume = Number(vol.value); this.media.muted = false; });
    this.loopBtn = h('button', { class: 'icon-btn', 'data-tip': 'Loop the selection', 'data-key': 'L', onclick: () => this.toggleLoop() }, icon('refresh'));
    const ctrl = h('div', { class: 'vid-controls' },
      h('button', { class: 'icon-btn', 'data-tip': 'Back 1 frame (←)', onclick: () => this.step(-1 / 30) }, icon('chevron-left')),
      this.playBtn,
      h('button', { class: 'icon-btn', 'data-tip': 'Forward 1 frame (→)', onclick: () => this.step(1 / 30) }, icon('chevron-right')),
      this.timeLabel,
      h('div', { class: 'grow' }),
      h('button', { class: 'btn sm', 'data-tip': 'Set start at playhead', 'data-key': 'I', onclick: () => this.setIn(this.media.currentTime) }, '[ Set in'),
      h('button', { class: 'btn sm', 'data-tip': 'Set end at playhead', 'data-key': 'O', onclick: () => this.setOut(this.media.currentTime) }, 'Set out ]'),
      this.loopBtn,
      this.isAudio ? null : h('button', { class: 'icon-btn', 'data-tip': 'Snapshot this frame', onclick: (e) => this.snapshot(e.currentTarget) }, icon('image')),
      speed,
      h('span', { class: 'faint' }, icon('volume', 'sm')), vol);

    this.strip = h('canvas', { class: 'vid-strip' });
    this.selBand = h('div', { class: 'vid-sel' }, h('div', { class: 'vid-handle in', dataset: { h: 'in' } }), h('div', { class: 'vid-handle out', dataset: { h: 'out' } }));
    this.playhead = h('div', { class: 'vid-playhead' });
    this.track = h('div', { class: 'vid-track' }, this.strip, this.selBand, this.playhead);
    this.ruler = h('div', { class: 'vid-ruler mono' });
    this.timeline = h('div', { class: 'vid-timeline' }, this.ruler, this.track);

    this.panel = h('div', { class: 'vid-panel' });
    this.root = h('div', { class: 'vid-root' }, h('div', { class: 'vid-left' }, this.stage, ctrl, this.timeline), this.panel);
    this.pane.append(this.root);

    this.media.addEventListener('timeupdate', () => this.onTime());
    this.media.addEventListener('play', () => { clear(this.playBtn).append(icon('pause-bars', 'lg')); this.bigPlay.hidden = true; this.tick(); });
    this.media.addEventListener('pause', () => { clear(this.playBtn).append(icon('play', 'lg')); this.bigPlay.hidden = false; });
    this.wireTimeline();
    new ResizeObserver(debounce(() => { this.updateTimeline(); if (!this.isAudio) this.buildFilmstrip(); else this.drawWave(); }, 250)).observe(this.track);
    this.keyHandler = (e) => this.onKey(e);
    document.addEventListener('keydown', this.keyHandler);
  }

  tick() {
    if (this.media.paused) return;
    this.onTime();
    requestAnimationFrame(() => this.tick());
  }

  onTime() {
    const t = this.media.currentTime;
    if (this.loop && t >= this.out - 0.02) { this.media.currentTime = this.in; }
    this.timeLabel.textContent = `${fmtTime(t)} / ${fmtTime(this.duration)}`;
    const w = this.track.clientWidth;
    this.playhead.style.left = (this.duration ? (t / this.duration) * w : 0) + 'px';
  }

  toggle() { if (this.media.paused) { if (this.loop && (this.media.currentTime < this.in || this.media.currentTime >= this.out)) this.media.currentTime = this.in; this.media.play().catch(() => {}); } else this.media.pause(); }
  step(dt) { this.media.pause(); this.media.currentTime = clamp(this.media.currentTime + dt, 0, this.duration); this.onTime(); }
  toggleLoop() { this.loop = !this.loop; this.loopBtn.classList.toggle('active', this.loop); }

  setIn(t) { this.in = clamp(t, 0, Math.max(0, this.out - 0.05)); this.updateTimeline(); this.renderPanel(); this.markClip(); }
  setOut(t) { this.out = clamp(t, this.in + 0.05, this.duration); this.updateTimeline(); this.renderPanel(); this.markClip(); }
  markClip() { this.refreshStatus(); }

  updateTimeline() {
    const w = this.track.clientWidth;
    if (!w || !this.duration) return;
    const x1 = (this.in / this.duration) * w;
    const x2 = (this.out / this.duration) * w;
    Object.assign(this.selBand.style, { left: x1 + 'px', width: Math.max(2, x2 - x1) + 'px' });
    // ruler ticks
    clear(this.ruler);
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const step = steps.find((s) => (s / this.duration) * w > 70) || 3600;
    for (let t = 0; t <= this.duration; t += step) this.ruler.append(h('span', { style: { left: (t / this.duration) * w + 'px' } }, fmtTime(t, false)));
    this.onTime();
  }

  wireTimeline() {
    const toTime = (e) => { const r = this.track.getBoundingClientRect(); return clamp(((e.clientX - r.left) / r.width) * this.duration, 0, this.duration); };
    this.track.addEventListener('pointerdown', (e) => {
      if (!this.duration) return;
      e.preventDefault();
      const handle = e.target.dataset.h;
      this.track.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const t = toTime(ev);
        if (handle === 'in') { this.setIn(t); this.media.currentTime = this.in; }
        else if (handle === 'out') { this.setOut(t); this.media.currentTime = this.out; }
        else this.media.currentTime = t;
        this.onTime();
      };
      const up = () => { this.track.removeEventListener('pointermove', move); this.track.removeEventListener('pointerup', up); };
      this.track.addEventListener('pointermove', move);
      this.track.addEventListener('pointerup', up);
      move(e);
    });
  }

  async buildFilmstrip() {
    if (this.unplayable || !this.duration || this.isAudio) return;
    const token = (this.stripToken = {});
    const w = this.track.clientWidth;
    const hgt = 54;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.strip.width = w * dpr;
    this.strip.height = hgt * dpr;
    const ctx = this.strip.getContext('2d');
    ctx.fillStyle = '#16121f';
    ctx.fillRect(0, 0, this.strip.width, this.strip.height);
    const probe = document.createElement('video');
    probe.muted = true;
    probe.preload = 'auto';
    probe.src = this.src;
    await new Promise((r) => { probe.addEventListener('loadeddata', r, { once: true }); probe.addEventListener('error', r, { once: true }); setTimeout(r, 6000); });
    if (probe.duration === Infinity) {
      await new Promise((r) => { probe.addEventListener('durationchange', r, { once: true }); probe.currentTime = 1e101; setTimeout(r, 4000); });
    }
    if (!probe.videoWidth) return;
    const thumbW = (hgt * probe.videoWidth) / probe.videoHeight;
    const n = Math.max(1, Math.ceil(w / thumbW));
    for (let i = 0; i < n; i++) {
      if (token !== this.stripToken) return;
      const t = Math.min(this.duration - 0.05, ((i + 0.5) / n) * this.duration);
      await new Promise((r) => { probe.addEventListener('seeked', r, { once: true }); probe.currentTime = t; setTimeout(r, 1500); });
      ctx.drawImage(probe, i * thumbW * dpr, 0, thumbW * dpr, hgt * dpr);
    }
    probe.removeAttribute('src');
    probe.load();
  }

  async buildWaveform() {
    try {
      let buf = this.bytes;
      if (!buf) {
        const st = await api.stat(this.tab.path);
        if (st.size > 150 * 1024 * 1024) return;
        buf = (await api.read(this.tab.path)).bytes;
      }
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const audio = await ac.decodeAudioData(buf.slice().buffer);
      ac.close();
      const data = audio.getChannelData(0);
      const buckets = 1200;
      const size = Math.floor(data.length / buckets) || 1;
      this.peaks = Array.from({ length: buckets }, (_, i) => { let m = 0; for (let j = i * size; j < (i + 1) * size && j < data.length; j += 16) m = Math.max(m, Math.abs(data[j])); return m; });
      this.drawWave();
    } catch { /* not decodable */ }
  }

  drawWave() {
    if (!this.peaks) return;
    const w = this.track.clientWidth;
    const hgt = 54;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.strip.width = w * dpr;
    this.strip.height = hgt * dpr;
    const ctx = this.strip.getContext('2d');
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    ctx.fillStyle = css.getPropertyValue('--bg-2').trim() || '#16121f';
    ctx.fillRect(0, 0, w, hgt);
    ctx.fillStyle = css.getPropertyValue('--accent').trim() || '#b48cff';
    for (let x = 0; x < w; x++) {
      const p = this.peaks[Math.floor((x / w) * this.peaks.length)] || 0;
      const bh = Math.max(1, p * (hgt - 6));
      ctx.fillRect(x, (hgt - bh) / 2, 1, bh);
    }
  }

  async snapshot(anchor) {
    if (this.isAudio || !this.media.videoWidth) return;
    const c = h('canvas', { width: this.media.videoWidth, height: this.media.videoHeight });
    c.getContext('2d').drawImage(this.media, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const name = `${stripExt(this.tab.title)} @ ${fmtTime(this.media.currentTime).replace(/:/g, '-')}.png`;
    showMenu([
      { label: 'Save frame as PNG…', icon: 'download', action: () => this.app.saveBytesAs(blob, { defaultName: name, filters: [{ name: 'PNG image', extensions: ['png'] }] }) },
      { label: 'Send to media dump', icon: 'image', action: async () => { await api.dumpAdd(name, new Uint8Array(await blob.arrayBuffer())); toast('Frame saved to the media dump', { type: 'ok' }); } },
      { label: 'Copy to clipboard', icon: 'copy', action: async () => { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Copied', { type: 'ok' }); } },
    ], { anchor });
  }

  // =================================================================== export panel

  renderPanel() {
    const p = clear(this.panel);
    const inIn = h('input', { type: 'text', class: 'mono', value: fmtTime(this.in) });
    const outIn = h('input', { type: 'text', class: 'mono', value: fmtTime(this.out) });
    inIn.addEventListener('change', () => { const t = parseTime(inIn.value); if (t != null) this.setIn(t); });
    outIn.addEventListener('change', () => { const t = parseTime(outIn.value); if (t != null) this.setOut(t); });
    const formats = FORMATS.filter((f) => (this.isAudio ? f.audio : f.video));
    if (!formats.some((f) => f.id === this.format)) this.format = formats[0].id;
    const fmtSel = h('select', {}, formats.map((f) => h('option', { value: f.id }, f.label)));
    fmtSel.value = this.format;
    fmtSel.addEventListener('change', () => { this.format = fmtSel.value; this.renderPanel(); });
    const f = FORMATS.find((x) => x.id === this.format);
    const opts = h('div', { class: 'col' });
    if (!this.isAudio && ['mp4', 'webm'].includes(this.format)) {
      const sc = h('select', {}, [['orig', 'Original size'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']].map(([v, l]) => h('option', { value: v }, l)));
      sc.value = this.scaleOpt;
      sc.addEventListener('change', () => { this.scaleOpt = sc.value; });
      opts.append(h('span', { class: 'dim' }, 'Resolution'), sc);
    }
    if (this.format === 'gif') {
      const fps = h('select', {}, [8, 10, 12, 15, 20, 25].map((v) => h('option', { value: String(v) }, v + ' fps')));
      fps.value = String(this.gifFps);
      fps.addEventListener('change', () => { this.gifFps = Number(fps.value); });
      const gw = h('select', {}, [240, 320, 480, 640, 800].map((v) => h('option', { value: String(v) }, v + ' px wide')));
      gw.value = String(this.gifWidth);
      gw.addEventListener('change', () => { this.gifWidth = Number(gw.value); });
      opts.append(h('span', { class: 'dim' }, 'GIF'), h('div', { class: 'row' }, fps, gw));
    }
    if (!this.isAudio && ['copy', 'mp4', 'webm'].includes(this.format)) {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = this.noAudio;
      cb.addEventListener('change', () => { this.noAudio = cb.checked; });
      opts.append(h('label', { class: 'check' }, cb, 'Remove audio'));
    }
    const native = !!(this.tools?.ffmpeg && this.tab.path);
    this.progress = h('div', { class: 'vid-progress', hidden: true }, h('div', { class: 'vid-progress-bar' }));
    this.progressLabel = h('div', { class: 'faint mono', style: { fontSize: '11px' } });
    this.exportBtn = h('button', { class: 'btn primary', onclick: () => this.exportClip() }, icon('download', 'sm'), 'Export clip');
    p.append(
      h('div', { class: 'vid-panel-title' }, '▸ clip'),
      h('div', { class: 'form-grid vid-grid' },
        h('label', {}, 'Start'), h('div', { class: 'row' }, inIn, h('button', { class: 'icon-btn', 'data-tip': 'Jump to start', onclick: () => { this.media.currentTime = this.in; } }, icon('arrow-left', 'sm'))),
        h('label', {}, 'End'), h('div', { class: 'row' }, outIn, h('button', { class: 'icon-btn', 'data-tip': 'Jump to end', onclick: () => { this.media.currentTime = this.out; } }, icon('arrow-left', 'sm'))),
        h('label', {}, 'Length'), h('span', { class: 'mono' }, fmtTime(this.out - this.in))),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => { this.in = 0; this.out = this.duration; this.updateTimeline(); this.renderPanel(); } }, 'Select all'),
        h('button', { class: 'btn sm', onclick: () => this.previewClip() }, icon('eye', 'sm'), 'Preview clip')),
      h('div', { class: 'vid-panel-title' }, '▸ export'),
      h('div', { class: 'col' }, h('span', { class: 'dim' }, 'Format'), fmtSel, f?.note ? h('span', { class: 'faint', style: { fontSize: '11px' } }, f.note) : null, opts),
      this.exportBtn, this.progress, this.progressLabel,
      h('div', { class: 'vid-engine faint mono' }, native ? '● engine: native ffmpeg (fast)' : '● engine: ffmpeg.wasm — runs in the app, slower for re-encodes'),
      h('div', { class: 'vid-keys faint' }, 'Space play · I / O set in & out · ← → frame step · Shift+← → 1s · L loop'),
    );
  }

  previewClip() { this.loop = true; this.loopBtn.classList.add('active'); this.media.currentTime = this.in; this.media.play().catch(() => {}); }

  buildArgs(input, output) {
    const dur = Math.max(0.05, this.out - this.in);
    const ss = ['-ss', this.in.toFixed(3)];
    const t = ['-t', dur.toFixed(3)];
    const scale = this.scaleOpt !== 'orig' ? ['-vf', `scale=-2:${this.scaleOpt}`] : [];
    const an = this.noAudio ? ['-an'] : [];
    switch (this.format) {
      case 'copy': return [...ss, '-i', input, ...t, '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...an, output];
      case 'mp4': return [...ss, '-i', input, ...t, ...scale, '-c:v', 'libx264', '-preset', this.native ? 'medium' : 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p', ...(this.noAudio ? ['-an'] : ['-c:a', 'aac', '-b:a', '160k']), '-movflags', '+faststart', output];
      case 'webm': return [...ss, '-i', input, ...t, ...scale, '-c:v', 'libvpx', '-b:v', '2M', '-deadline', 'realtime', '-cpu-used', '8', ...(this.noAudio ? ['-an'] : ['-c:a', 'libvorbis']), output];
      case 'gif': return [...ss, '-t', dur.toFixed(3), '-i', input, '-vf', `fps=${this.gifFps},scale=${this.gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0', output];
      case 'mp3': return [...ss, '-i', input, ...t, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', output];
      case 'wav': return [...ss, '-i', input, ...t, '-vn', '-c:a', 'pcm_s16le', output];
      default: return [];
    }
  }

  outExt() {
    const f = FORMATS.find((x) => x.id === this.format);
    return f.ext || this.tab.ext || 'mp4';
  }

  setProgress(p, label) {
    this.progress.hidden = p == null;
    if (p != null) this.progress.firstChild.style.width = Math.round(clamp(p, 0, 1) * 100) + '%';
    this.progressLabel.textContent = label || '';
  }

  async exportClip() {
    if (this.busy) return;
    const ext = this.outExt();
    const name = `${stripExt(this.tab.title)} (${fmtTime(this.in, false).replace(/:/g, '.')}-${fmtTime(this.out, false).replace(/:/g, '.')}).${ext}`;
    this.native = !!(this.tools?.ffmpeg && this.tab.path);
    this.busy = true;
    this.exportBtn.disabled = true;
    try {
      if (this.native) {
        const res = await pickSave({ defaultName: name, initialDir: dirname(this.tab.path), filters: [{ name: ext.toUpperCase(), extensions: [ext] }], title: 'Export clip' });
        if (!res) return;
        let out = res.path;
        if (extOf(out) !== ext) out += '.' + ext;
        this.setProgress(0, 'exporting…');
        const { id } = await fetch('/api/ffmpeg', { method: 'POST', headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ args: this.buildArgs(this.tab.path, out), duration: this.out - this.in, output: out, label: name }) }).then((r) => r.json());
        const job = await this.pollJob(id);
        if (job.status !== 'done') throw new Error(job.error || job.status);
        this.setProgress(1, 'done');
        toast(`Exported ${basename(out)}`, { type: 'ok', action: { label: 'Open', fn: () => this.app.openPath(out) } });
      } else {
        this.setProgress(0, 'loading ffmpeg (first time takes a moment)…');
        const ff = await loadFfmpeg();
        let input = this.bytes;
        if (!input) {
          const st = await api.stat(this.tab.path);
          if (st.size > 1.8 * 1024 ** 3) throw new Error('This file is too big for the in-app engine. Install ffmpeg (winget install ffmpeg) for big files.');
          this.setProgress(0, `reading ${formatBytes(st.size)}…`);
          input = (await api.read(this.tab.path)).bytes;
        }
        const inName = 'input.' + (this.tab.ext || 'mp4');
        const outName = 'output.' + ext;
        await ff.writeFile(inName, input);
        const onProg = ({ progress }) => this.setProgress(progress, `encoding… ${Math.round(clamp(progress, 0, 1) * 100)}%`);
        ff.on('progress', onProg);
        this.setProgress(0.01, 'encoding…');
        const code = await ff.exec(this.buildArgs(inName, outName));
        ff.off('progress', onProg);
        if (code !== 0) throw new Error('ffmpeg could not process this file with these settings.');
        const data = await ff.readFile(outName);
        await ff.deleteFile(inName).catch(() => {});
        await ff.deleteFile(outName).catch(() => {});
        this.setProgress(1, `done · ${formatBytes(data.length)}`);
        await this.app.saveBytesAs(data, { defaultName: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }], title: 'Export clip' });
      }
    } catch (e) {
      this.setProgress(null, '');
      errorToast(e, 'Export failed');
    } finally {
      this.busy = false;
      this.exportBtn.disabled = false;
    }
  }

  async pollJob(id) {
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      const j = await fetch(`/api/job?id=${id}`, { headers: { 'X-BDS-Token': api.token } }).then((r) => r.json());
      if (j.status === 'running') { this.setProgress(j.progress, `exporting… ${Math.round(j.progress * 100)}%`); continue; }
      return j;
    }
  }

  // =================================================================== keys / misc

  onKey(e) {
    if (this.app.active !== this.tab) return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || document.querySelector('.modal-backdrop')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); this.toggle(); }
    else if (k === 'i') { e.preventDefault(); this.setIn(this.media.currentTime); }
    else if (k === 'o') { e.preventDefault(); this.setOut(this.media.currentTime); }
    else if (k === 'l') { e.preventDefault(); this.toggleLoop(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this.step(e.shiftKey ? -1 : -1 / 30); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); this.step(e.shiftKey ? 1 : 1 / 30); }
    else if (e.key === 'Home') { e.preventDefault(); this.media.currentTime = this.in; }
    else if (e.key === 'End') { e.preventDefault(); this.media.currentTime = this.out; }
  }

  buildToolbar() {
    return h('div', { class: 'toolbar' },
      tbButton('download', 'Export the selected clip', () => this.exportClip(), { text: 'Export clip' }),
      tbSep(),
      tbButton('external', 'Show in folder', () => this.tab.path && api.reveal(this.tab.path)),
      this.tab.path ? tbButton('play', 'Watch this in the video player', () => this.app.openPath(this.tab.path, { mode: 'player' }), { text: 'Play' }) : null,
      this.tab.path ? tbButton('video', 'Open this in the video editor (tracks, keyframes, chroma key)', () => this.app.newDocument('cut', { media: [this.tab.path] }), { text: 'Open in video editor' }) : null,
      h('span', { class: 'tb-label' }, this.isAudio ? 'audio trimmer' : 'video trimmer'));
  }

  status() {
    const v = this.media;
    return {
      left: [
        { text: `clip ${fmtTime(this.in)} → ${fmtTime(this.out)} (${fmtTime(this.out - this.in)})`, icon: 'crop' },
        ...(v?.videoWidth ? [{ text: `${v.videoWidth}×${v.videoHeight}` }] : []),
      ],
      right: [{ text: fmtTime(this.duration) }],
    };
  }

  saveFormats() { return []; }
  exportTargets() { return [{ label: 'Trimmed clip…', icon: 'crop', run: () => this.exportClip() }]; }
  focus() { this.root?.focus?.(); }
  onHide() { this.media?.pause(); }
  destroy() {
    document.removeEventListener('keydown', this.keyHandler);
    this.media?.pause();
    if (this.src?.startsWith('blob:')) URL.revokeObjectURL(this.src);
    this.stripToken = null;
  }
}
