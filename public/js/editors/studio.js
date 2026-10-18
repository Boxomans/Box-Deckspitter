// BoxStudio: a screen recorder with scenes. Each scene stacks sources (screens, windows, cameras, pictures, videos,
// text, colour) on one canvas of any size; each source can be moved, resized, rotated, cropped and flipped. Audio
// inputs (the PC's sound and any number of microphones / line-ins, plus the sound of video sources) are mixed with
// their own volume. The canvas and the mix are recorded with MediaRecorder; the pieces are streamed to the server as
// they come (studio-server.js), then rewrapped by ffmpeg into MP4 / MKV / WebM / MOV, in the media dump or a folder.
// Global hotkeys (electron/studio.js) work while another app has focus, including one that opens the screenshot
// overlay to pick an area of the screen: the recording then shows just that area.
// The setup lives in data/studio.json.

import { BaseEditor } from './base.js';
import { h, clear, clamp, uid, basename, extOf, debounce } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { toast, errorToast, confirmDialog, promptDialog, contextMenu, showMenu, modal, draggedPaths } from '../core/ui.js';
import { pickOpen, pickFolder } from '../core/files.js';

const T = () => ({ 'X-BDS-Token': api.token });
const shell = () => window.bdsShell || null;
const stream = (p) => `/api/stream?token=${encodeURIComponent(api.token)}&path=${encodeURIComponent(p)}`;
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'];
const VIDEO_EXT = ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'ogv'];

const RES = [[3840, 2160, '4K'], [2560, 1440, '1440p'], [1920, 1080, '1080p'], [1600, 900, '900p'], [1280, 720, '720p'],
  [854, 480, '480p'], [1080, 1920, 'Vertical'], [1080, 1080, 'Square']];
const FPS = [24, 25, 30, 48, 50, 60];
const FORMATS = [['mp4', 'MP4'], ['mkv', 'MKV'], ['webm', 'WebM'], ['mov', 'MOV']];
const CODECS = {
  h264: ['video/mp4;codecs=avc1.640033,opus', 'video/webm;codecs=h264,opus'],
  vp9: ['video/webm;codecs=vp9,opus', 'video/mp4;codecs=vp09.00.41.08,opus'],
  av1: ['video/webm;codecs=av01,opus', 'video/mp4;codecs=av01.0.08M.08,opus'],
  vp8: ['video/webm;codecs=vp8,opus'],
};
const CODEC_NAMES = { auto: 'Automatic', h264: 'H.264', vp9: 'VP9', av1: 'AV1', vp8: 'VP8' };
const ACTIONS = [
  ['record', 'Start / stop recording', 'Ctrl+Alt+F9'],
  ['pause', 'Pause / resume', 'Ctrl+Alt+F10'],
  ['shot', 'Screenshot of the output', 'Ctrl+Alt+F11'],
  ['area', 'Pick an area of the screen to record', 'Super+Shift+K'],
  ['fullarea', 'Back to the whole screen', ''],
];
const TYPES = {
  screen: { icon: 'maximize', name: 'Display' },
  window: { icon: 'window', name: 'Window' },
  camera: { icon: 'video', name: 'Camera' },
  image: { icon: 'image', name: 'Image' },
  video: { icon: 'play', name: 'Video' },
  text: { icon: 'type', name: 'Text' },
  color: { icon: 'square', name: 'Colour' },
};
const SNAP = 8; // screen px: how close an edge comes before it snaps

const rad = (d) => (d * Math.PI) / 180;
const rot = (x, y, a) => { const c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; };
/** The upright box a (maybe rotated) item covers: [x, y, w, h]. */
const bbox = (it) => {
  const a = rad(it.rot || 0), c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const w = it.w * c + it.h * s, hh = it.w * s + it.h * c;
  return [it.x + (it.w - w) / 2, it.y + (it.h - hh) / 2, w, hh];
};
/** The closest pairing of one of `vals` with one of `targets` within `tol`: { d (how far to shift), t (the target) }, or null. */
const nearest = (vals, targets, tol) => {
  let best = null;
  for (const v of vals) for (const t of targets) { const d = t - v; if (Math.abs(d) < tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t }; }
  return best;
};
const fmtTime = (s) => { s = Math.max(0, Math.floor(s)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const keyLabel = (a) => (a || '').replace(/Super/g, 'Win').replace(/\+/g, ' + ');

function defaults() {
  const scene = { id: uid('sc'), name: 'Scene', items: [] };
  return {
    v: 1,
    canvas: { w: 1920, h: 1080, fps: 60 },
    output: { dump: true, dir: '', format: 'mp4', codec: 'auto', mbps: 12, audioKbps: 192, areaStarts: false },
    transition: { kind: 'fade', ms: 300 },
    hotkeys: Object.fromEntries(ACTIONS.map((a) => [a[0], a[2]])),
    scenes: [scene],
    scene: scene.id,
    audio: [
      { id: uid('au'), kind: 'desktop', name: 'Desktop audio', vol: 1, muted: false },
      { id: uid('au'), kind: 'mic', device: 'default', name: 'Mic', vol: 1, muted: false, ns: true },
    ],
  };
}

/** The recorder's MIME type for a codec choice and output format (null if none work here). */
function pickMime(codec, format) {
  const order = codec === 'auto' ? ['h264', 'vp9', 'vp8'] : [codec, 'vp9', 'vp8'];
  for (const c of order) {
    // WebM can't hold H.264
    if (format === 'webm' && c === 'h264') continue;
    const list = (CODECS[c] || []).filter((m) => MediaRecorder.isTypeSupported(m));
    const mp4 = list.find((m) => m.startsWith('video/mp4'));
    const pick = (format === 'mp4' || format === 'mov') && mp4 ? mp4 : list.find((m) => m.startsWith('video/webm')) || list[0];
    if (pick) return pick;
  }
  return null;
}

// one listener for the shell's hotkey and area events, passed to whichever studio is open
let current = null;
let wired = false;
function wireShell() {
  if (wired || !shell()?.studio) return;
  wired = true;
  shell().onStudioKey?.((action) => current?.hotkey(action));
  shell().onStudioArea?.((area) => current?.applyArea(area));
}
const TICKER = URL.createObjectURL(new Blob(['let t=null;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data);}'], { type: 'text/javascript' }));

export class StudioEditor extends BaseEditor {
  static mode = 'studio';

  async load() {
    current = this;
    wireShell();
    this.caps = new Map(); // capture key -> { stream, frame, el, w, h, users, error }
    this.imgs = new Map(); // path -> Image
    this.vids = new Map(); // item id -> { el, path, node, gain, an }
    this.texts = new Map(); // item id -> { key, c }
    this.chans = new Map(); // audio id -> { a, stream, src, gain, an, key }
    this.sel = null;
    this.rec = null;
    this.trans = null;
    const r = await api.get('/api/studio').catch(() => ({}));
    this.ffmpeg = !!r.ffmpeg;
    this.cfg = { ...defaults(), ...(r.config || {}) };
    this.cfg.output = { ...defaults().output, ...(this.cfg.output || {}) };
    this.cfg.hotkeys = { ...defaults().hotkeys, ...(this.cfg.hotkeys || {}) };
    if (!this.cfg.scenes?.length) { const d = defaults(); this.cfg.scenes = d.scenes; this.cfg.scene = d.scene; }
    if (!this.scene()) this.cfg.scene = this.cfg.scenes[0].id;
    this.saveSoon = debounce(() => this.save(), 500);

    this.canvas = h('canvas', { class: 'st-canvas' });
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.transCanvas = document.createElement('canvas');
    this.sizeCanvas();
    this.buildUI();
    this.ticker = new Worker(TICKER);
    this.ticker.onmessage = () => this.draw();
    this.ticker.postMessage(Math.round(1000 / this.cfg.canvas.fps));
    this.meterLoop();
    await this.resolveWindows();
    this.syncCaptures();
    this.syncAudio();
    this.applyHotkeys();
    this.recTimer = setInterval(() => this.tickRec(), 500);
  }

  scene(id = this.cfg.scene) { return this.cfg.scenes.find((s) => s.id === id); }
  items() { return this.scene()?.items || []; }
  item(id) { return this.items().find((i) => i.id === id) || null; }
  changed() { this.saveSoon(); }

  async save() {
    try {
      await fetch('/api/studio', { method: 'POST', headers: { ...T(), 'Content-Type': 'application/json' }, body: JSON.stringify(this.cfg) });
    } catch { /* next change tries again */ }
  }

  sizeCanvas() {
    const { w, h: hh } = this.cfg.canvas;
    this.canvas.width = w; this.canvas.height = hh;
    this.transCanvas.width = w; this.transCanvas.height = hh;
    this.layoutStage?.();
  }

  // ================================================================ captures

  capKey(it) { return it.type === 'camera' ? `cam:${it.src}` : `dsk:${it.src}`; }

  /** Window ids change between runs: find each window again by its title. */
  async resolveWindows() {
    const items = this.cfg.scenes.flatMap((s) => s.items).filter((i) => i.type === 'window' || i.type === 'screen');
    if (!items.length || !shell()?.studio) return;
    const r = await shell().studio({ op: 'sources' }).catch(() => null);
    const list = r?.list || [];
    for (const it of items) {
      if (list.some((s) => s.id === it.src)) continue;
      const m = it.type === 'screen' ? list.find((s) => s.kind === 'screen' && s.display === it.display)
        : list.find((s) => s.kind === 'window' && s.name === it.srcName);
      if (m) { it.src = m.id; if (m.w) { it.sw = m.w; it.sh = m.h; } }
    }
  }

  syncCaptures() {
    const want = new Map();
    for (const s of this.cfg.scenes) for (const it of s.items) if (['screen', 'window', 'camera'].includes(it.type) && it.src) want.set(this.capKey(it), it);
    for (const [k, c] of this.caps) if (!want.has(k)) { this.closeCap(c); this.caps.delete(k); }
    for (const [k, it] of want) if (!this.caps.has(k)) this.openCap(k, it);
    // pictures and videos
    const vids = new Set();
    for (const s of this.cfg.scenes) for (const it of s.items) if (it.type === 'video' && it.path) vids.add(it.id);
    for (const [id, v] of this.vids) if (!vids.has(id)) this.closeVid(id, v);
  }

  openCap(key, it) {
    const cap = { key, stream: null, frame: null, el: null, w: 0, h: 0, error: '' };
    this.caps.set(key, cap);
    const fps = this.cfg.canvas.fps;
    const constraints = it.type === 'camera'
      ? { audio: false, video: { ...(it.src && it.src !== 'default' ? { deviceId: { exact: it.src } } : {}), width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: fps } } }
      : { audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: it.src, maxWidth: it.sw || 3840, maxHeight: it.sh || 2160, maxFrameRate: fps } } };
    navigator.mediaDevices.getUserMedia(constraints).then((s) => {
      if (this.caps.get(key) !== cap) { s.getTracks().forEach((t) => t.stop()); return; }
      cap.stream = s;
      const track = s.getVideoTracks()[0];
      track.addEventListener('ended', () => { cap.error = 'gone'; this.renderSources(); });
      if ('MediaStreamTrackProcessor' in window) {
        // frames straight off the track: keeps coming while the window is hidden or minimized
        const reader = new window.MediaStreamTrackProcessor({ track }).readable.getReader();
        cap.reader = reader;
        (async () => {
          for (;;) {
            const { value, done } = await reader.read().catch(() => ({ done: true }));
            if (done) break;
            if (this.caps.get(key) !== cap) { value.close(); break; }
            cap.frame?.close();
            cap.frame = value;
            cap.w = value.displayWidth; cap.h = value.displayHeight;
          }
        })();
      } else {
        const v = h('video', { muted: true, playsinline: true });
        v.muted = true;
        v.srcObject = s;
        v.play().catch(() => {});
        v.addEventListener('resize', () => { cap.w = v.videoWidth; cap.h = v.videoHeight; });
        cap.el = v;
      }
    }).catch((e) => { cap.error = e.message || 'unavailable'; this.renderSources(); });
  }

  closeCap(c) {
    try { c.reader?.cancel(); } catch { /* done */ }
    c.frame?.close?.();
    c.frame = null;
    c.stream?.getTracks().forEach((t) => t.stop());
  }

  image(path) {
    let im = this.imgs.get(path);
    if (!im) { im = new Image(); im.src = stream(path); this.imgs.set(path, im); }
    return im.complete && im.naturalWidth ? im : null;
  }

  vid(it) {
    let v = this.vids.get(it.id);
    if (v && v.path !== it.path) { this.closeVid(it.id, v); v = null; }
    if (!v) {
      const el = h('video', { playsinline: true, crossorigin: 'anonymous' });
      el.src = stream(it.path);
      el.loop = it.loop !== false;
      el.play().catch(() => {});
      v = { el, path: it.path };
      this.vids.set(it.id, v);
      this.hookVidAudio(it, v);
    }
    v.el.loop = it.loop !== false;
    return v;
  }
  hookVidAudio(it, v) {
    if (!this.ac || v.node) return;
    try {
      v.node = this.ac.createMediaElementSource(v.el);
      v.gain = this.ac.createGain();
      v.an = this.ac.createAnalyser();
      v.an.fftSize = 1024;
      v.node.connect(v.gain).connect(v.an);
      v.gain.connect(this.mixDest);
      v.gain.gain.value = it.muted ? 0 : it.vol ?? 1;
    } catch { /* no sound */ }
  }
  closeVid(id, v) {
    try { v.el.pause(); v.el.removeAttribute('src'); v.el.load(); } catch { /* gone */ }
    try { v.node?.disconnect(); v.gain?.disconnect(); } catch { /* gone */ }
    this.vids.delete(id);
  }

  /** What an item draws: { img, w, h } or { fill }, or null while it isn't ready. */
  sourceOf(it) {
    if (it.type === 'color') return { fill: it.color || '#202030' };
    if (it.type === 'text') return this.textOf(it);
    if (it.type === 'image') { const im = it.path && this.image(it.path); return im ? { img: im, w: im.naturalWidth, h: im.naturalHeight } : null; }
    if (it.type === 'video') { const v = it.path && this.vid(it); return v && v.el.videoWidth ? { img: v.el, w: v.el.videoWidth, h: v.el.videoHeight } : null; }
    const c = this.caps.get(this.capKey(it));
    if (!c || c.error) return null;
    const img = c.frame || c.el;
    return img && c.w ? { img, w: c.w, h: c.h } : null;
  }

  expand(s) {
    const d = new Date();
    return String(s).replace(/\{time\}/g, d.toLocaleTimeString()).replace(/\{date\}/g, d.toLocaleDateString())
      .replace(/\{rec\}/g, this.rec ? fmtTime(this.recSeconds()) : '00:00:00');
  }

  textOf(it) {
    const t = it.text || {};
    const str = this.expand(t.value ?? 'Text');
    const key = JSON.stringify([str, t.font, t.size, t.color, t.bold, t.italic, t.outline, t.outlineColor, t.bg, t.bgColor, t.align]);
    let e = this.texts.get(it.id);
    if (e && e.key === key) return e.out;
    const size = t.size || 72;
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    const font = `${t.italic ? 'italic ' : ''}${t.bold ? 700 : 400} ${size}px ${t.font || 'Inter, system-ui, sans-serif'}`;
    g.font = font;
    const lines = str.split('\n');
    const lh = Math.round(size * 1.2);
    const ow = t.outline || 0;
    const pad = t.bg ? Math.round(size * 0.3) : 0;
    const tw = Math.max(1, ...lines.map((l) => g.measureText(l).width));
    c.width = Math.ceil(tw + pad * 2 + ow * 2);
    c.height = Math.ceil(lines.length * lh + pad * 2 + ow * 2);
    g.font = font;
    if (t.bg) { g.fillStyle = t.bgColor || 'rgba(0,0,0,0.6)'; g.beginPath(); g.roundRect?.(0, 0, c.width, c.height, Math.round(size * 0.18)); g.fill(); }
    g.textBaseline = 'top';
    g.textAlign = t.align || 'left';
    const x0 = t.align === 'center' ? c.width / 2 : t.align === 'right' ? c.width - pad - ow : pad + ow;
    lines.forEach((l, i) => {
      const y = pad + ow + i * lh + (lh - size) / 2;
      if (ow) { g.lineJoin = 'round'; g.lineWidth = ow * 2; g.strokeStyle = t.outlineColor || '#000'; g.strokeText(l, x0, y); }
      g.fillStyle = t.color || '#ffffff';
      g.fillText(l, x0, y);
    });
    // the box grows with the text, keeping its scale
    if (it.tw && it.th && (it.tw !== c.width || it.th !== c.height) && !it.fit) {
      const k = it.w / it.tw;
      it.w = c.width * k; it.h = c.height * k;
      if (this.sel === it.id) this.updateSel();
    }
    it.tw = c.width; it.th = c.height;
    e = { key, out: { img: c, w: c.width, h: c.height } };
    this.texts.set(it.id, e);
    return e.out;
  }

  // ================================================================ drawing

  draw() {
    const live = this.rec || (this.tab.pane.isConnected && !this.tab.pane.hidden && this.app.active === this.tab && !document.hidden);
    if (!live) return;
    const { w, h: hh } = this.cfg.canvas;
    const g = this.ctx;
    g.globalAlpha = 1;
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, hh);
    const items = this.items();
    for (let i = items.length - 1; i >= 0; i--) this.drawItem(g, items[i]);
    if (this.trans) {
      const t = (performance.now() - this.trans.at) / this.trans.ms;
      if (t >= 1) this.trans = null;
      else { g.globalAlpha = 1 - t; g.drawImage(this.transCanvas, 0, 0); g.globalAlpha = 1; }
    }
    this.vtrack?.requestFrame?.();
  }

  drawItem(g, it) {
    if (it.hidden) return;
    const src = this.sourceOf(it);
    if (!src) return;
    const c = it.crop || {};
    if (src.w) {
      const cw = src.w * (1 - (c.l || 0) - (c.r || 0)), ch = src.h * (1 - (c.t || 0) - (c.b || 0));
      if (it.fit) { this.fitItem(it, cw, ch, it.fit); this.changed(); if (this.sel === it.id) { this.updateSel(); this.renderProps(); } }
      it.nw = src.w; it.nh = src.h;
    }
    g.save();
    g.globalAlpha = it.opacity ?? 1;
    g.translate(it.x + it.w / 2, it.y + it.h / 2);
    if (it.rot) g.rotate(rad(it.rot));
    if (it.flipH || it.flipV) g.scale(it.flipH ? -1 : 1, it.flipV ? -1 : 1);
    if (src.fill) { g.fillStyle = src.fill; g.fillRect(-it.w / 2, -it.h / 2, it.w, it.h); }
    else {
      const sx = (c.l || 0) * src.w, sy = (c.t || 0) * src.h;
      const sw = src.w * (1 - (c.l || 0) - (c.r || 0)), sh = src.h * (1 - (c.t || 0) - (c.b || 0));
      if (sw > 0.5 && sh > 0.5 && it.w > 0 && it.h > 0) {
        try { g.drawImage(src.img, sx, sy, sw, sh, -it.w / 2, -it.h / 2, it.w, it.h); } catch { /* frame closed under us */ }
      }
    }
    g.restore();
  }

  /** Size an item to its source: 'contain' fits the canvas, 'native' keeps its pixels (shrunk if too big), 'cam' a corner. */
  fitItem(it, w, h, mode = 'contain') {
    const W = this.cfg.canvas.w, H = this.cfg.canvas.h;
    if (!w || !h) return;
    let k = Math.min(W / w, H / h);
    if (mode === 'native') k = Math.min(1, k);
    if (mode === 'cam') k = (W * 0.28) / w;
    if (mode === 'stretch') { it.w = W; it.h = H; it.x = 0; it.y = 0; it.rot = 0; it.fit = false; return; }
    it.w = w * k; it.h = h * k;
    if (mode === 'cam') { it.x = W - it.w - W * 0.025; it.y = H - it.h - W * 0.025; }
    else { it.x = (W - it.w) / 2; it.y = (H - it.h) / 2; }
    it.rot = 0;
    it.fit = false;
  }

  // ================================================================ audio

  async ensureAudio() {
    if (this.ac) { if (this.ac.state === 'suspended') await this.ac.resume().catch(() => {}); return; }
    this.ac = new AudioContext({ sampleRate: 48000 });
    this.mixDest = this.ac.createMediaStreamDestination();
    for (const s of this.cfg.scenes) for (const it of s.items) if (it.type === 'video' && this.vids.has(it.id)) this.hookVidAudio(it, this.vids.get(it.id));
  }

  async syncAudio() {
    await this.ensureAudio();
    const ids = new Set(this.cfg.audio.map((a) => a.id));
    for (const [id, ch] of this.chans) if (!ids.has(id)) { this.closeChan(ch); this.chans.delete(id); }
    for (const a of this.cfg.audio) {
      const key = `${a.kind}|${a.device || ''}|${a.ns ? 1 : 0}`;
      let ch = this.chans.get(a.id);
      if (ch && ch.key !== key) { this.closeChan(ch); this.chans.delete(a.id); ch = null; }
      if (!ch) { ch = { a, key, gain: this.ac.createGain(), an: this.ac.createAnalyser(), error: '' }; ch.an.fftSize = 1024; ch.gain.connect(this.mixDest); this.chans.set(a.id, ch); this.openChan(ch); }
      ch.a = a;
      ch.gain.gain.value = a.muted ? 0 : a.vol ?? 1;
    }
    for (const s of this.cfg.scenes) for (const it of s.items) {
      const v = this.vids.get(it.id);
      if (v?.gain) v.gain.gain.value = it.muted ? 0 : it.vol ?? 1;
    }
    this.renderMixer();
  }

  async openChan(ch) {
    const a = ch.a;
    try {
      let s;
      if (a.kind === 'desktop') {
        // everything the PC plays (Windows loopback); the video track that comes with it isn't wanted
        s = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 16, maxHeight: 16, maxFrameRate: 1 } } });
        s.getVideoTracks().forEach((t) => { t.stop(); s.removeTrack(t); });
      } else {
        s = await navigator.mediaDevices.getUserMedia({ audio: { ...(a.device && a.device !== 'default' ? { deviceId: { exact: a.device } } : {}), echoCancellation: false, noiseSuppression: !!a.ns, autoGainControl: false, channelCount: 2 } });
      }
      if (this.chans.get(a.id) !== ch) { s.getTracks().forEach((t) => t.stop()); return; }
      ch.stream = s;
      ch.src = this.ac.createMediaStreamSource(s);
      ch.src.connect(ch.gain);
      ch.gain.connect(ch.an);
    } catch (e) {
      ch.error = a.kind === 'desktop' ? 'Couldn’t capture the PC’s sound' : (e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? 'Device not found' : e.message);
      this.renderMixer();
    }
  }
  closeChan(ch) {
    try { ch.src?.disconnect(); ch.gain.disconnect(); } catch { /* gone */ }
    ch.stream?.getTracks().forEach((t) => t.stop());
  }

  meterLoop() {
    const buf = new Float32Array(1024);
    const tick = () => {
      if (this.dead) return;
      this.meterRaf = requestAnimationFrame(tick);
      if (!this.mixerEl?.isConnected || document.hidden) return;
      for (const row of this.mixerEl.querySelectorAll('.st-chan')) {
        const an = row._an?.();
        const bar = row.querySelector('.st-meter i');
        if (!an || !bar) continue;
        an.getFloatTimeDomainData(buf);
        let p = 0;
        for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > p) p = v; }
        const db = p > 0 ? 20 * Math.log10(p) : -90;
        const pct = clamp((db + 60) / 60, 0, 1);
        row._peak = Math.max(pct, (row._peak || 0) - 0.015);
        bar.style.width = `${(row._peak * 100).toFixed(1)}%`;
        bar.className = db > -3 ? 'hot' : db > -12 ? 'warm' : '';
      }
    };
    tick();
  }

  // ================================================================ recording

  recSeconds() {
    const r = this.rec;
    if (!r) return 0;
    const paused = r.pausedAt ? performance.now() - r.pausedAt : 0;
    return (performance.now() - r.started - r.pausedFor - paused) / 1000;
  }

  async toggleRec() { if (this.rec) await this.stopRec(); else await this.startRec(); }

  async startRec() {
    if (this.rec || this.starting) return;
    const o = this.cfg.output;
    if (!o.dump && !o.dir) { toast('Pick a folder for recordings in the studio settings (or save to the media dump).', { type: 'warn' }); this.openSettings('output'); return; }
    const mime = pickMime(o.codec, o.format);
    if (!mime) { toast('This PC can’t record video here (no encoder).', { type: 'error' }); return; }
    this.starting = true;
    try {
      await this.ensureAudio();
      const vs = this.canvas.captureStream(0);
      this.vtrack = vs.getVideoTracks()[0];
      const ms = new MediaStream([this.vtrack, ...this.mixDest.stream.getAudioTracks()]);
      const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
      const r = await api.post('/api/studio/rec/start', { ext, dump: !!o.dump, dir: o.dump ? null : o.dir, format: o.format });
      const recorder = new MediaRecorder(ms, { mimeType: mime, videoBitsPerSecond: Math.round(o.mbps * 1e6), audioBitsPerSecond: Math.round(o.audioKbps * 1000) });
      const rec = { id: r.id, recorder, mime, chain: Promise.resolve(), started: performance.now(), pausedFor: 0, pausedAt: 0, bytes: 0, failed: null };
      recorder.ondataavailable = (e) => {
        if (!e.data?.size) return;
        rec.chain = rec.chain.then(async () => {
          if (rec.failed) return;
          const res = await fetch(`/api/studio/rec/chunk?id=${rec.id}`, { method: 'POST', headers: T(), body: e.data });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Couldn’t write the recording');
          rec.bytes += e.data.size;
        }).catch((err) => { if (!rec.failed) { rec.failed = err; toast(`Recording problem: ${err.message}`, { type: 'error', timeout: 9000 }); } });
      };
      recorder.onerror = (e) => { toast(`Recorder stopped: ${e.error?.message || 'unknown error'}`, { type: 'error' }); this.stopRec(); };
      this.rec = rec;
      recorder.start(1000);
      shell()?.studio?.({ op: 'busy', on: true });
      this.app.sounds?.play?.('ok');
      const k = this.cfg.hotkeys.record;
      toast(`Recording${k ? ` · ${keyLabel(k)} stops it` : ''}`, { type: 'ok', timeout: 2600 });
    } catch (e) {
      this.vtrack?.stop(); this.vtrack = null;
      errorToast(e, 'Couldn’t start recording');
    } finally {
      this.starting = false;
      this.syncRecUI();
    }
  }

  async stopRec() {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    this.syncRecUI();
    if (rec.recorder.state !== 'inactive') await new Promise((res) => { rec.recorder.addEventListener('stop', res, { once: true }); rec.recorder.stop(); });
    await rec.chain;
    this.vtrack?.stop();
    this.vtrack = null;
    shell()?.studio?.({ op: 'busy', on: false });
    this.saving = true;
    this.syncRecUI();
    try {
      const out = await api.post('/api/studio/rec/finish', { id: rec.id, format: this.cfg.output.format });
      toast(`Saved ${out.name}${out.inDump ? ' to the media dump' : ''}`, { type: 'ok', timeout: 8000, action: { label: 'Open', fn: () => this.app.openPath(out.path) } });
      if (out.note) toast(out.note, { type: 'warn', timeout: 8000 });
      this.lastFile = out;
    } catch (e) {
      errorToast(e, 'Couldn’t finish the recording');
    } finally {
      this.saving = false;
      this.syncRecUI();
    }
  }

  togglePause() {
    const r = this.rec;
    if (!r) return;
    if (r.recorder.state === 'recording') { r.recorder.pause(); r.pausedAt = performance.now(); }
    else if (r.recorder.state === 'paused') { r.recorder.resume(); r.pausedFor += performance.now() - r.pausedAt; r.pausedAt = 0; }
    this.syncRecUI();
  }

  async screenshot() {
    this.draw();
    const blob = await new Promise((res) => this.canvas.toBlob(res, 'image/png'));
    if (!blob) return;
    const o = this.cfg.output;
    try {
      const res = await fetch(`/api/studio/shot${!o.dump && o.dir ? `?dir=${encodeURIComponent(o.dir)}` : ''}`, { method: 'POST', headers: T(), body: blob });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'Couldn’t save');
      toast(`Saved ${out.name}${out.inDump ? ' to the media dump' : ''}`, { type: 'ok', action: { label: 'Open', fn: () => this.app.openPath(out.path) } });
    } catch (e) { errorToast(e); }
  }

  tickRec() {
    if (!this.recBtn) return;
    const t = this.recBtn.querySelector('.st-rec-time');
    if (t) t.textContent = this.rec ? fmtTime(this.recSeconds()) : '';
    if (this.rec) this.refreshStatus();
  }

  syncRecUI() {
    if (!this.recBtn) return;
    const on = !!this.rec;
    const paused = this.rec?.recorder.state === 'paused';
    this.recBtn.classList.toggle('on', on);
    this.recBtn.classList.toggle('paused', paused);
    this.recBtn.querySelector('.st-rec-label').textContent = this.saving ? 'Saving…' : on ? (paused ? 'Paused' : 'Stop') : 'Record';
    this.recBtn.disabled = !!this.saving || !!this.starting;
    this.pauseBtn.disabled = !on;
    this.pauseBtn.classList.toggle('active', paused);
    this.tickRec();
    this.refreshStatus();
  }

  // ================================================================ hotkeys

  hotkeyMap() {
    const keys = {};
    for (const [a, k] of Object.entries(this.cfg.hotkeys)) if (k) keys[a] = k;
    return keys;
  }

  async applyHotkeys() {
    const keys = this.hotkeyMap();
    if (shell()?.studio) {
      const r = await shell().studio({ op: 'hotkeys', keys }).catch(() => null);
      const failed = r?.failed || [];
      this.hotkeyFailed = new Set(failed);
      if (failed.length) toast(`These keys are taken by another program: ${failed.map((a) => keyLabel(keys[a])).join(', ')}. Change them in the studio settings.`, { type: 'warn', timeout: 9000 });
    }
  }

  /** In the plain browser (no desktop shell) the keys only work while this page has focus. */
  handlesKey(e) {
    if (shell()?.studio || !e.ctrlKey && !e.altKey && !e.metaKey) return false;
    const accel = accelOf(e);
    const hit = Object.entries(this.hotkeyMap()).find(([, k]) => k === accel);
    if (!hit) return false;
    e.preventDefault();
    this.hotkey(hit[0]);
    return true;
  }

  hotkey(action) {
    if (action === 'record') this.toggleRec();
    else if (action === 'pause') this.togglePause();
    else if (action === 'shot') this.screenshot();
    else if (action === 'area') this.pickArea();
    else if (action === 'fullarea') this.wholeScreen();
    else if (action.startsWith('scene:')) this.switchScene(action.slice(6));
    else if (action.startsWith('mute:')) {
      const id = action.slice(5);
      const a = this.cfg.audio.find((x) => x.id === id);
      if (a) { a.muted = !a.muted; this.changed(); this.syncAudio(); toast(`${a.name} ${a.muted ? 'muted' : 'on'}`, { timeout: 1500 }); }
    }
  }

  // ================================================================ record an area of the screen

  pickArea() {
    if (!shell()?.studio) { toast('Picking an area needs the desktop app.', { type: 'warn' }); return; }
    shell().studio({ op: 'area' });
  }

  /** The area picked on the overlay: the display it's on gets cropped to it and fills the canvas. */
  async applyArea(area) {
    if (!area) return;
    const sc = this.scene();
    const whole = area.w >= 0.995 && area.h >= 0.995;
    let it = sc.items.find((i) => i.id === this.sel && i.type === 'screen' && i.display === area.displayId)
      || sc.items.find((i) => i.type === 'screen' && i.display === area.displayId);
    if (!it) {
      const r = await shell()?.studio?.({ op: 'sources' }).catch(() => null);
      const s = (r?.list || []).find((x) => x.kind === 'screen' && x.display === area.displayId) || (r?.list || []).find((x) => x.kind === 'screen');
      if (!s) { toast('Couldn’t find that screen to record.', { type: 'error' }); return; }
      it = this.newItem('screen', { src: s.id, srcName: s.name, display: s.display, sw: s.w, sh: s.h, name: s.name });
      sc.items.push(it); // at the bottom: anything already on top (a camera, text) stays on top
      this.syncCaptures();
    }
    it.hidden = false;
    it.crop = whole ? { l: 0, t: 0, r: 0, b: 0 } : { l: area.x, t: area.y, r: Math.max(0, 1 - area.x - area.w), b: Math.max(0, 1 - area.y - area.h) };
    it.fit = 'contain';
    this.select(it.id);
    this.changed();
    this.renderSources();
    const sw = it.nw || it.sw, sh = it.nh || it.sh;
    const size = sw ? ` (${Math.round(sw * area.w)} × ${Math.round(sh * area.h)})` : '';
    toast(whole ? 'Recording the whole screen' : `Recording just that area${size}${area.kind === 'window' && area.title ? ` · ${area.title}` : ''}`, { type: 'ok', timeout: 3500 });
    if (this.cfg.output.areaStarts && !this.rec) this.startRec();
  }

  wholeScreen() {
    const it = this.items().find((i) => i.type === 'screen' && i.crop && (i.crop.l || i.crop.t || i.crop.r || i.crop.b));
    if (!it) return;
    it.crop = { l: 0, t: 0, r: 0, b: 0 };
    it.fit = 'contain';
    this.changed();
    this.renderProps();
    toast('Recording the whole screen', { timeout: 2000 });
  }

  // ================================================================ scenes and items

  newItem(type, extra = {}) {
    return { id: uid('it'), type, name: extra.name || TYPES[type].name, x: 0, y: 0, w: 0, h: 0, rot: 0, opacity: 1, crop: { l: 0, t: 0, r: 0, b: 0 }, fit: 'contain', ...extra };
  }

  switchScene(id) {
    if (id === this.cfg.scene || !this.scene(id)) return;
    if (this.cfg.transition.kind === 'fade' && this.cfg.transition.ms > 0) {
      const g = this.transCanvas.getContext('2d');
      g.drawImage(this.canvas, 0, 0);
      this.trans = { at: performance.now(), ms: this.cfg.transition.ms };
    }
    this.cfg.scene = id;
    this.sel = null;
    this.changed();
    this.renderScenes();
    this.renderSources();
    this.renderProps();
    this.updateSel();
  }

  addScene(copyOf = null) {
    const n = this.cfg.scenes.length + 1;
    const s = copyOf
      ? { id: uid('sc'), name: `${copyOf.name} copy`, items: copyOf.items.map((i) => ({ ...structuredClone(i), id: uid('it') })) }
      : { id: uid('sc'), name: `Scene ${n}`, items: [] };
    this.cfg.scenes.push(s);
    this.switchScene(s.id);
    this.syncCaptures();
    this.applyHotkeys();
  }

  async removeScene(s) {
    if (this.cfg.scenes.length < 2) { toast('There has to be one scene.'); return; }
    if (s.items.length && !(await confirmDialog('Remove scene', `Remove “${s.name}” and its ${s.items.length} source${s.items.length === 1 ? '' : 's'}?`, { okLabel: 'Remove', danger: true }))) return;
    const i = this.cfg.scenes.indexOf(s);
    this.cfg.scenes.splice(i, 1);
    delete this.cfg.hotkeys[`scene:${s.id}`];
    if (this.cfg.scene === s.id) this.cfg.scene = this.cfg.scenes[Math.max(0, i - 1)].id;
    this.sel = null;
    this.changed();
    this.syncCaptures();
    this.applyHotkeys();
    this.renderAll();
  }

  async addSource(type, anchor) {
    const sc = this.scene();
    const put = (it, bottom = false) => {
      if (bottom) sc.items.push(it); else sc.items.unshift(it);
      this.syncCaptures();
      this.select(it.id);
      this.changed();
      this.renderSources();
    };
    if (type === 'screen' || type === 'window') {
      const s = await this.pickSource(type);
      if (!s) return;
      put(this.newItem(type, { src: s.id, srcName: s.name, display: s.display || '', sw: s.w, sh: s.h, name: s.name.slice(0, 60) }), type === 'screen');
    } else if (type === 'camera') {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      if (!devs.length) { toast('No camera found.', { type: 'warn' }); return; }
      const add = (d) => put(this.newItem('camera', { src: d.deviceId || 'default', name: d.label || 'Camera', fit: 'cam' }));
      if (devs.length === 1) add(devs[0]);
      else showMenu(devs.map((d, i) => ({ label: d.label || `Camera ${i + 1}`, icon: 'video', action: () => add(d) })), { anchor });
    } else if (type === 'image' || type === 'video') {
      const p = await pickOpen({ title: type === 'image' ? 'Add a picture' : 'Add a video', filters: [{ name: type === 'image' ? 'Images' : 'Videos', extensions: type === 'image' ? IMAGE_EXT : VIDEO_EXT }] });
      if (!p) return;
      put(this.newItem(type, { path: p[0], name: basename(p[0]), fit: 'native', ...(type === 'video' ? { loop: true, vol: 1 } : {}) }));
      if (type === 'video') this.syncAudio();
    } else if (type === 'text') {
      put(this.newItem('text', { name: 'Text', text: { value: 'Text', size: 72, color: '#ffffff', font: 'Inter, system-ui, sans-serif', bold: true, outline: 0, outlineColor: '#000000', bg: false, bgColor: '#000000aa', align: 'left' }, fit: 'native' }));
    } else if (type === 'color') {
      const W = this.cfg.canvas.w, H = this.cfg.canvas.h;
      put(this.newItem('color', { color: '#1d1530', x: 0, y: 0, w: W, h: H, fit: false }), true);
    }
  }

  addFiles(paths, at) {
    const sc = this.scene();
    let n = 0;
    for (const p of paths) {
      const ext = extOf(p).toLowerCase();
      const type = IMAGE_EXT.includes(ext) ? 'image' : VIDEO_EXT.includes(ext) ? 'video' : null;
      if (!type) continue;
      const it = this.newItem(type, { path: p, name: basename(p), fit: 'native', ...(type === 'video' ? { loop: true, vol: 1 } : {}) });
      if (at) it.dropAt = at;
      sc.items.unshift(it);
      this.sel = it.id;
      n++;
    }
    if (!n) { toast('Drop pictures or videos here.'); return; }
    this.syncCaptures();
    this.syncAudio();
    this.changed();
    this.renderSources();
    this.renderProps();
  }

  pickSource(kind) {
    return new Promise((resolve) => {
      const grid = h('div', { class: 'st-pick-grid' }, h('div', { class: 'klep-loading' }, h('div', { class: 'spinner' })));
      let done = false;
      modal({
        title: kind === 'screen' ? 'Which display?' : 'Which window?',
        body: grid, wide: true, buttons: [{ label: 'Cancel', value: null }],
        onOpen: async (ctx) => {
          const r = await shell()?.studio?.({ op: 'sources' }).catch(() => null);
          const list = (r?.list || []).filter((s) => s.kind === kind);
          clear(grid);
          if (!list.length) grid.append(h('div', { class: 'empty-note' }, shell()?.studio ? 'Nothing to capture.' : 'Capturing the screen needs the desktop app.'));
          for (const s of list) {
            grid.append(h('button', { class: 'st-pick', title: s.name, onclick: () => { done = true; ctx.close(); resolve(s); } },
              s.thumb ? h('img', { src: s.thumb, alt: '' }) : h('div', { class: 'st-pick-none' }, icon(kind === 'screen' ? 'maximize' : 'window', 'lg')),
              h('span', {}, s.name), s.w ? h('span', { class: 'faint mono' }, `${s.w} × ${s.h}`) : null));
          }
        },
      }).then(() => { if (!done) resolve(null); });
    });
  }

  removeItem(it) {
    const sc = this.scene();
    sc.items = sc.items.filter((i) => i !== it);
    if (this.sel === it.id) this.sel = null;
    this.texts.delete(it.id);
    this.changed();
    this.syncCaptures();
    this.renderSources();
    this.renderProps();
    this.updateSel();
    this.renderMixer();
  }

  moveItem(it, to) {
    const list = this.scene().items;
    const i = list.indexOf(it);
    const j = to === 'top' ? 0 : to === 'bottom' ? list.length - 1 : clamp(i + (to === 'up' ? -1 : 1), 0, list.length - 1);
    if (i === j) return;
    list.splice(i, 1);
    list.splice(j, 0, it);
    this.changed();
    this.renderSources();
  }

  select(id) {
    this.sel = id;
    this.renderSources();
    this.renderProps();
    this.updateSel();
  }

  itemMenu(e, it) {
    const sc = this.scene();
    const others = this.cfg.scenes.filter((s) => s !== sc);
    const src = { w: it.nw || it.tw || it.w, h: it.nh || it.th || it.h };
    const c = it.crop || {};
    const cw = src.w * (1 - (c.l || 0) - (c.r || 0)), ch = src.h * (1 - (c.t || 0) - (c.b || 0));
    const redo = () => { this.changed(); this.updateSel(); this.renderProps(); };
    contextMenu(e, [
      { label: 'Transform', icon: 'move', submenu: [
        { label: 'Fit to screen', action: () => { this.fitItem(it, cw, ch, 'contain'); redo(); } },
        { label: 'Stretch to screen', action: () => { this.fitItem(it, cw, ch, 'stretch'); redo(); } },
        { label: 'Actual size', action: () => { const W = this.cfg.canvas.w, H = this.cfg.canvas.h; it.w = cw; it.h = ch; it.x = (W - cw) / 2; it.y = (H - ch) / 2; redo(); } },
        { label: 'Center', action: () => { it.x = (this.cfg.canvas.w - it.w) / 2; it.y = (this.cfg.canvas.h - it.h) / 2; redo(); } },
        { label: `Canvas to this source (${Math.round(cw)}×${Math.round(ch)})`, icon: 'crop', disabled: !cw || !ch, action: () => this.canvasToItem(it) },
        { sep: true },
        { label: 'Rotate 90° right', icon: 'rotate-cw', action: () => { it.rot = ((it.rot || 0) + 90) % 360; redo(); } },
        { label: 'Rotate 90° left', icon: 'rotate-ccw', action: () => { it.rot = ((it.rot || 0) + 270) % 360; redo(); } },
        { label: 'Flip horizontally', icon: 'flip-h', action: () => { it.flipH = !it.flipH; redo(); } },
        { label: 'Flip vertically', icon: 'flip-v', action: () => { it.flipV = !it.flipV; redo(); } },
        { sep: true },
        { label: 'Remove the crop', icon: 'crop', disabled: !(c.l || c.t || c.r || c.b), action: () => { const k = it.w / cw; it.crop = { l: 0, t: 0, r: 0, b: 0 }; it.w = src.w * k; it.h = src.h * (it.h / ch); redo(); } },
        { label: 'Reset everything', action: () => { it.crop = { l: 0, t: 0, r: 0, b: 0 }; it.flipH = it.flipV = false; this.fitItem(it, src.w, src.h, 'contain'); redo(); } },
      ] },
      { label: 'Order', icon: 'layers', submenu: [
        { label: 'Bring to front', action: () => this.moveItem(it, 'top') },
        { label: 'Bring forward', action: () => this.moveItem(it, 'up') },
        { label: 'Send backward', action: () => this.moveItem(it, 'down') },
        { label: 'Send to back', action: () => this.moveItem(it, 'bottom') },
      ] },
      { label: it.hidden ? 'Show' : 'Hide', icon: it.hidden ? 'eye' : 'eye-off', action: () => { it.hidden = !it.hidden; this.changed(); this.renderSources(); this.updateSel(); } },
      { label: it.locked ? 'Unlock' : 'Lock', icon: 'lock', action: () => { it.locked = !it.locked; this.changed(); this.renderSources(); this.updateSel(); } },
      { label: 'Rename', icon: 'edit', action: async () => { const n = await promptDialog('Rename source', 'Name', it.name); if (n) { it.name = n.slice(0, 80); this.changed(); this.renderSources(); this.renderMixer(); } } },
      { label: 'Duplicate', icon: 'copy', action: () => { const d = { ...structuredClone(it), id: uid('it'), x: it.x + 24, y: it.y + 24, name: `${it.name} copy` }; sc.items.splice(sc.items.indexOf(it), 0, d); this.syncCaptures(); this.select(d.id); this.changed(); } },
      ...(others.length ? [{ label: 'Copy to scene', icon: 'copy', submenu: others.map((s) => ({ label: s.name, action: () => { s.items.unshift({ ...structuredClone(it), id: uid('it') }); this.changed(); toast(`Copied to ${s.name}`); } })) }] : []),
      { sep: true },
      { label: 'Remove', icon: 'trash', action: () => this.removeItem(it) },
    ]);
  }

  // ================================================================ layout

  buildUI() {
    this.root = h('div', { class: 'studio' });
    this.pane.append(this.root);

    // top bar
    this.recBtn = h('button', { class: 'st-rec', onclick: () => this.toggleRec() }, h('span', { class: 'st-rec-dot' }), h('span', { class: 'st-rec-label' }, 'Record'), h('span', { class: 'st-rec-time mono' }));
    this.pauseBtn = h('button', { class: 'icon-btn', 'data-tip': 'Pause / resume', disabled: true, onclick: () => this.togglePause() }, icon('pause-bars', 'sm'));
    this.resChip = h('button', { class: 'st-chip mono', 'data-tip': 'Canvas size and frame rate', onclick: () => this.openSettings('video') });
    this.outChip = h('button', { class: 'st-chip', 'data-tip': 'Where recordings go', onclick: () => this.openSettings('output') });
    const top = h('div', { class: 'st-top' },
      this.recBtn, this.pauseBtn,
      h('button', { class: 'icon-btn', 'data-tip': 'Screenshot of the output', onclick: () => this.screenshot() }, icon('image-down', 'sm')),
      h('button', { class: 'btn sm ghost', 'data-tip': 'Drag an area of the screen to record just that', onclick: () => this.pickArea() }, icon('focus', 'sm'), 'Pick area'),
      h('div', { class: 'grow' }), this.resChip, this.outChip,
      h('button', { class: 'icon-btn', 'data-tip': 'Studio settings: video, output, hotkeys', onclick: () => this.openSettings() }, icon('settings', 'sm')));

    // stage
    this.selBox = h('div', { class: 'st-box', hidden: true },
      ...[[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]].map(([x, y]) => h('div', { class: 'st-h', dataset: { hx: x, hy: y } })),
      h('div', { class: 'st-rot', 'data-tip': 'Rotate (Shift: 15° steps)' }));
    this.readEl = h('div', { class: 'st-readout mono', hidden: true });
    this.frame = h('div', { class: 'st-frame' }, this.canvas, this.selBox, h('div', { class: 'st-guides' }), this.readEl);
    this.stage = h('div', { class: 'st-stage', tabindex: '0' }, this.frame);
    this.props = h('div', { class: 'st-props' });
    const main = h('div', { class: 'st-main' }, this.stage, this.props);

    // docks
    this.scenesEl = h('div', { class: 'st-list' });
    this.sourcesEl = h('div', { class: 'st-list' });
    this.mixerEl = h('div', { class: 'st-mixer' });
    const dock = (title, body, foot) => h('div', { class: 'st-dock' }, h('div', { class: 'st-dock-head' }, title), body, foot);
    const scenesFoot = h('div', { class: 'st-dock-foot' },
      h('button', { class: 'icon-btn', 'data-tip': 'Add a scene', onclick: () => this.addScene() }, icon('plus', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Remove this scene', onclick: () => this.removeScene(this.scene()) }, icon('trash', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Move up', onclick: () => this.moveScene(-1) }, icon('chevron-up', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Move down', onclick: () => this.moveScene(1) }, icon('chevron-down', 'sm')));
    const addBtn = h('button', { class: 'icon-btn', 'data-tip': 'Add a source' }, icon('plus', 'sm'));
    addBtn.addEventListener('click', () => showMenu(Object.entries(TYPES).map(([t, d]) => ({
      label: { screen: 'Display capture', window: 'Window capture', camera: 'Camera', image: 'Image', video: 'Video file', text: 'Text', color: 'Colour' }[t],
      icon: d.icon, action: () => this.addSource(t, addBtn),
    })), { anchor: addBtn }));
    const sourcesFoot = h('div', { class: 'st-dock-foot' }, addBtn,
      h('button', { class: 'icon-btn', 'data-tip': 'Remove', onclick: () => { const it = this.item(this.sel); if (it) this.removeItem(it); } }, icon('trash', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Move up', onclick: () => { const it = this.item(this.sel); if (it) this.moveItem(it, 'up'); } }, icon('chevron-up', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Move down', onclick: () => { const it = this.item(this.sel); if (it) this.moveItem(it, 'down'); } }, icon('chevron-down', 'sm')));
    const audBtn = h('button', { class: 'icon-btn', 'data-tip': 'Add an audio input' }, icon('plus', 'sm'));
    audBtn.addEventListener('click', () => this.addAudioMenu(audBtn));
    const mixerFoot = h('div', { class: 'st-dock-foot' }, audBtn);
    this.root.append(top, main, h('div', { class: 'st-docks' },
      dock('Scenes', this.scenesEl, scenesFoot),
      dock('Sources', this.sourcesEl, sourcesFoot),
      h('div', { class: 'st-dock wide' }, h('div', { class: 'st-dock-head' }, 'Audio mixer'), this.mixerEl, mixerFoot)));

    this.layoutStage = () => {
      const r = this.stage.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const { w, h: hh } = this.cfg.canvas;
      const k = Math.min((r.width - 16) / w, (r.height - 16) / hh);
      this.k = k;
      this.frame.style.width = `${Math.round(w * k)}px`;
      this.frame.style.height = `${Math.round(hh * k)}px`;
      this.updateSel();
    };
    this.ro = new ResizeObserver(() => this.layoutStage());
    this.ro.observe(this.stage);
    this.wireStage();
    this.renderAll();
  }

  renderAll() {
    this.renderTop();
    this.renderScenes();
    this.renderSources();
    this.renderProps();
    this.renderMixer();
    this.syncRecUI();
    this.updateSel();
  }

  renderTop() {
    const { w, h: hh, fps } = this.cfg.canvas;
    this.resChip.textContent = `${w}×${hh} · ${fps}fps`;
    const o = this.cfg.output;
    clear(this.outChip).append(icon(o.dump ? 'image' : 'folder', 'sm'), o.dump ? 'media dump' : basename(o.dir) || 'pick a folder', h('span', { class: 'faint' }, ` · ${o.format.toUpperCase()}`));
  }

  moveScene(d) {
    const l = this.cfg.scenes;
    const i = l.findIndex((s) => s.id === this.cfg.scene);
    const j = clamp(i + d, 0, l.length - 1);
    if (i === j) return;
    l.splice(j, 0, l.splice(i, 1)[0]);
    this.changed();
    this.renderScenes();
  }

  renderScenes() {
    const l = clear(this.scenesEl);
    for (const s of this.cfg.scenes) {
      const key = this.cfg.hotkeys[`scene:${s.id}`];
      const row = h('button', { class: `st-row ${s.id === this.cfg.scene ? 'on' : ''}` }, h('span', { class: 'st-row-name' }, s.name), key ? h('span', { class: 'st-key mono' }, keyLabel(key)) : null);
      row.addEventListener('click', () => this.switchScene(s.id));
      row.addEventListener('dblclick', async () => { const n = await promptDialog('Rename scene', 'Name', s.name); if (n) { s.name = n.slice(0, 60); this.changed(); this.renderScenes(); } });
      row.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Rename', icon: 'edit', action: async () => { const n = await promptDialog('Rename scene', 'Name', s.name); if (n) { s.name = n.slice(0, 60); this.changed(); this.renderScenes(); } } },
        { label: 'Duplicate', icon: 'copy', action: () => this.addScene(s) },
        { label: 'Set a hotkey…', icon: 'keyboard', action: () => this.openSettings('hotkeys') },
        { sep: true },
        { label: 'Remove', icon: 'trash', disabled: this.cfg.scenes.length < 2, action: () => this.removeScene(s) },
      ]));
      l.append(row);
    }
  }

  renderSources() {
    if (!this.sourcesEl) return;
    const l = clear(this.sourcesEl);
    const items = this.items();
    if (!items.length) l.append(h('div', { class: 'empty-note' }, 'Add a display, window, camera, picture or text with +.'));
    for (const it of items) {
      const cap = ['screen', 'window', 'camera'].includes(it.type) ? this.caps.get(this.capKey(it)) : null;
      const row = h('div', { class: `st-row ${it.id === this.sel ? 'on' : ''} ${it.hidden ? 'dim' : ''}`, draggable: 'true' },
        h('span', { class: 'st-row-ico' }, icon(TYPES[it.type].icon, 'sm')),
        h('span', { class: 'st-row-name', title: it.srcName || it.path || it.name }, it.name, cap?.error ? h('span', { class: 'st-warn' }, ' · not available') : null),
        h('button', { class: 'icon-btn tiny', 'data-tip': it.hidden ? 'Show' : 'Hide', onclick: (e) => { e.stopPropagation(); it.hidden = !it.hidden; this.changed(); this.renderSources(); this.updateSel(); } }, icon(it.hidden ? 'eye-off' : 'eye', 'sm')),
        h('button', { class: `icon-btn tiny ${it.locked ? 'active' : ''}`, 'data-tip': it.locked ? 'Unlock' : 'Lock in place', onclick: (e) => { e.stopPropagation(); it.locked = !it.locked; this.changed(); this.renderSources(); this.updateSel(); } }, icon('lock', 'sm')));
      row.addEventListener('click', () => this.select(it.id));
      row.addEventListener('dblclick', async () => { const n = await promptDialog('Rename source', 'Name', it.name); if (n) { it.name = n.slice(0, 80); this.changed(); this.renderSources(); } });
      row.addEventListener('contextmenu', (e) => this.itemMenu(e, it));
      // drag to reorder
      row.addEventListener('dragstart', (e) => { this.dragItem = it; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.name); });
      row.addEventListener('dragover', (e) => { if (this.dragItem) { e.preventDefault(); row.classList.add('drop'); } });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', (e) => {
        e.preventDefault(); row.classList.remove('drop');
        const d = this.dragItem; this.dragItem = null;
        if (!d || d === it) return;
        const list = this.scene().items;
        list.splice(list.indexOf(d), 1);
        list.splice(list.indexOf(it), 0, d);
        this.changed(); this.renderSources();
      });
      l.append(row);
    }
  }

  // ---------------------------------------------------------------- properties

  renderProps() {
    if (!this.props) return;
    const p = clear(this.props);
    const it = this.item(this.sel);
    if (!it) {
      p.append(h('div', { class: 'st-props-head' }, 'Properties'),
        h('div', { class: 'st-help' },
          h('p', {}, 'Pick a source to change it. On the preview: drag to move; drag a corner to resize (keeps the shape, Shift frees it); Alt+drag an edge to crop; the dot on top rotates; right-click for more.'),
          h('p', {}, 'Edges snap to the canvas and to the other sources; hold Ctrl while dragging to turn that off, or Shift while moving to keep to one direction. Arrow keys nudge the selected source (Shift: 10 px).'),
          h('p', {}, `${keyLabel(this.cfg.hotkeys.area) || 'The area key'} picks an area of the screen to record, from anywhere. Click the desktop on that overlay to go back to the whole screen.`)));
      return;
    }
    const redo = () => { this.changed(); this.updateSel(); };
    const num = (label, get, set, { step = 1, min = -1e5, max = 1e5, digits = 0 } = {}) => h('label', { class: 'st-field' }, h('span', {}, label),
      h('input', { type: 'number', step: String(step), min: String(min), max: String(max), value: (+get()).toFixed(digits),
        onchange: (e) => { const v = clamp(+e.target.value || 0, min, max); set(v); redo(); this.renderProps(); } }));
    const c = it.crop || (it.crop = { l: 0, t: 0, r: 0, b: 0 });
    const pct = (k) => num(k.toUpperCase(), () => (c[k] || 0) * 100, (v) => { c[k] = clamp(v / 100, 0, 0.99); if ((c.l || 0) + (c.r || 0) > 0.98 || (c.t || 0) + (c.b || 0) > 0.98) c[k] = 0; }, { step: 0.5, min: 0, max: 99, digits: 1 });
    p.append(h('div', { class: 'st-props-head' }, icon(TYPES[it.type].icon, 'sm'), h('span', { class: 'st-row-name' }, it.name)));
    const sec = (title, ...kids) => h('div', { class: 'st-sec' }, h('div', { class: 'st-sec-title' }, title), ...kids);
    // the type's own settings first
    if (it.type === 'text') {
      const t = it.text || (it.text = {});
      const set = (k, v) => { t[k] = v; this.changed(); };
      p.append(sec('Text',
        h('textarea', { class: 'input st-text', rows: '3', oninput: (e) => set('value', e.target.value) }, t.value ?? ''),
        h('div', { class: 'st-hint faint' }, '{time}, {date} and {rec} (the recording time) fill themselves in.'),
        h('div', { class: 'st-grid2' },
          h('label', { class: 'st-field' }, h('span', {}, 'Font'), h('input', { type: 'text', value: t.font || '', onchange: (e) => set('font', e.target.value.slice(0, 120)) })),
          num('Size', () => t.size || 72, (v) => set('size', v), { min: 6, max: 600 }),
          h('label', { class: 'st-field' }, h('span', {}, 'Colour'), h('input', { type: 'color', value: (t.color || '#ffffff').slice(0, 7), oninput: (e) => set('color', e.target.value) })),
          h('label', { class: 'st-field' }, h('span', {}, 'Align'), h('select', { onchange: (e) => set('align', e.target.value) }, ...['left', 'center', 'right'].map((a) => h('option', { value: a, selected: (t.align || 'left') === a }, a)))),
          num('Outline', () => t.outline || 0, (v) => set('outline', v), { min: 0, max: 40 }),
          h('label', { class: 'st-field' }, h('span', {}, 'Outline colour'), h('input', { type: 'color', value: (t.outlineColor || '#000000').slice(0, 7), oninput: (e) => set('outlineColor', e.target.value) }))),
        h('div', { class: 'st-checks' },
          h('label', {}, h('input', { type: 'checkbox', checked: !!t.bold, onchange: (e) => set('bold', e.target.checked) }), 'Bold'),
          h('label', {}, h('input', { type: 'checkbox', checked: !!t.italic, onchange: (e) => set('italic', e.target.checked) }), 'Italic'),
          h('label', {}, h('input', { type: 'checkbox', checked: !!t.bg, onchange: (e) => set('bg', e.target.checked) }), 'Background'),
          h('input', { type: 'color', value: (t.bgColor || '#000000').slice(0, 7), oninput: (e) => set('bgColor', e.target.value + 'b0') }))));
    } else if (it.type === 'color') {
      p.append(sec('Colour', h('input', { type: 'color', value: (it.color || '#202030').slice(0, 7), oninput: (e) => { it.color = e.target.value; this.changed(); } })));
    } else if (it.type === 'image' || it.type === 'video') {
      p.append(sec(it.type === 'image' ? 'Picture' : 'Video',
        h('div', { class: 'st-path faint', title: it.path }, it.path),
        h('button', { class: 'btn sm', onclick: async () => { const r = await pickOpen({ filters: [{ name: 'Files', extensions: it.type === 'image' ? IMAGE_EXT : VIDEO_EXT }] }); if (r) { it.path = r[0]; it.name = basename(r[0]); it.fit = 'native'; this.changed(); this.renderSources(); this.renderProps(); } } }, 'Choose another…'),
        it.type === 'video' ? h('div', { class: 'st-checks' },
          h('label', {}, h('input', { type: 'checkbox', checked: it.loop !== false, onchange: (e) => { it.loop = e.target.checked; this.changed(); } }), 'Loop'),
          h('button', { class: 'btn sm ghost', onclick: () => { const v = this.vids.get(it.id); if (v) { v.el.currentTime = 0; v.el.play().catch(() => {}); } } }, 'Restart')) : null));
    } else {
      const cap = this.caps.get(this.capKey(it));
      p.append(sec(TYPES[it.type].name,
        h('div', { class: 'st-path faint' }, it.srcName || it.name, cap?.w ? ` · ${cap.w}×${cap.h}` : ''),
        cap?.error ? h('div', { class: 'st-warn' }, it.type === 'window' ? 'That window is closed or minimized.' : 'Not available.') : null,
        h('button', { class: 'btn sm', onclick: async () => {
          if (it.type === 'camera') { this.addSourceSwap(it); return; }
          const s = await this.pickSource(it.type);
          if (s) { it.src = s.id; it.srcName = s.name; it.display = s.display || ''; it.sw = s.w; it.sh = s.h; it.name = s.name.slice(0, 60); this.changed(); this.syncCaptures(); this.renderSources(); this.renderProps(); }
        } }, it.type === 'camera' ? 'Another camera…' : `Another ${it.type}…`),
        it.type === 'screen' ? h('button', { class: 'btn sm ghost', onclick: () => this.pickArea() }, icon('focus', 'sm'), 'Pick an area') : null));
    }
    p.append(
      sec('Position and size', h('div', { class: 'st-grid2' },
        num('X', () => it.x, (v) => { it.x = v; }), num('Y', () => it.y, (v) => { it.y = v; }),
        num('Width', () => it.w, (v) => { it.w = Math.max(2, v); }), num('Height', () => it.h, (v) => { it.h = Math.max(2, v); }),
        num('Rotation°', () => it.rot || 0, (v) => { it.rot = ((v % 360) + 360) % 360; }, { step: 1 }),
        num('Opacity %', () => (it.opacity ?? 1) * 100, (v) => { it.opacity = clamp(v / 100, 0, 1); }, { min: 0, max: 100 })),
      h('div', { class: 'st-checks' },
        h('label', {}, h('input', { type: 'checkbox', checked: !!it.flipH, onchange: (e) => { it.flipH = e.target.checked; redo(); } }), 'Flip ↔'),
        h('label', {}, h('input', { type: 'checkbox', checked: !!it.flipV, onchange: (e) => { it.flipV = e.target.checked; redo(); } }), 'Flip ↕')),
        h('button', { class: 'btn sm', 'data-tip': 'Make the canvas (the size recordings come out at) exactly this source at its real size', onclick: () => this.canvasToItem(it) }, icon('crop', 'sm'), 'Canvas to this source')),
      it.type !== 'color' ? sec('Crop (%)', h('div', { class: 'st-grid4' }, pct('l'), pct('t'), pct('r'), pct('b'))) : '',
      h('div', { class: 'st-props-foot' },
        h('button', { class: 'btn sm ghost', onclick: (e) => this.itemMenu(e, it) }, icon('more', 'sm'), 'More'),
        h('button', { class: 'btn sm ghost danger', onclick: () => this.removeItem(it) }, icon('trash', 'sm'), 'Remove')));
  }

  async addSourceSwap(it) {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    showMenu(devs.map((d, i) => ({ label: d.label || `Camera ${i + 1}`, checked: d.deviceId === it.src, action: () => { it.src = d.deviceId; it.name = d.label || it.name; this.changed(); this.syncCaptures(); this.renderSources(); this.renderProps(); } })), { anchor: this.props });
  }

  // ---------------------------------------------------------------- mixer

  async addAudioMenu(anchor) {
    const devs = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
    const has = this.cfg.audio.some((a) => a.kind === 'desktop');
    const add = (a) => { this.cfg.audio.push({ id: uid('au'), vol: 1, muted: false, ...a }); this.changed(); this.syncAudio(); };
    showMenu([
      { label: 'Desktop audio (everything the PC plays)', icon: 'volume', disabled: has, action: () => add({ kind: 'desktop', name: 'Desktop audio' }) },
      { sep: true },
      { heading: 'Microphones and line-ins' },
      ...(devs.length ? devs.map((d, i) => ({ label: d.label || `Input ${i + 1}`, icon: 'headphones', action: () => add({ kind: 'mic', device: d.deviceId, name: (d.label || `Input ${i + 1}`).replace(/^Default - /, '').slice(0, 60), ns: true }) }))
        : [{ note: 'No inputs found.' }]),
    ], { anchor });
  }

  renderMixer() {
    if (!this.mixerEl) return;
    const l = clear(this.mixerEl);
    const rows = [
      ...this.cfg.audio.map((a) => ({ a, an: () => this.chans.get(a.id)?.an, error: this.chans.get(a.id)?.error })),
      ...this.cfg.scenes.flatMap((s) => s.items).filter((it) => it.type === 'video').map((it) => ({ a: it, media: true, an: () => this.vids.get(it.id)?.an })),
    ];
    if (!rows.length) l.append(h('div', { class: 'empty-note' }, 'No audio. Add the PC’s sound or a microphone with +.'));
    for (const { a, media, an, error } of rows) {
      const vol = a.vol ?? 1;
      const db = h('span', { class: 'st-db mono' }, vol > 0 ? `${(20 * Math.log10(vol)).toFixed(1)} dB` : '−∞');
      const setVol = (v) => { a.vol = v; db.textContent = v > 0 ? `${(20 * Math.log10(v)).toFixed(1)} dB` : '−∞'; this.changed(); this.syncAudioGains(); };
      const slider = h('input', { type: 'range', min: '0', max: '200', value: String(Math.round(vol * 100)), oninput: (e) => setVol(+e.target.value / 100) });
      slider.addEventListener('dblclick', () => { slider.value = '100'; setVol(1); });
      const muteKey = !media && this.cfg.hotkeys[`mute:${a.id}`];
      const row = h('div', { class: `st-chan ${a.muted ? 'muted' : ''}` },
        h('div', { class: 'st-chan-top' },
          h('span', { class: 'st-row-ico' }, icon(media ? 'play' : a.kind === 'desktop' ? 'volume' : 'headphones', 'sm')),
          h('span', { class: 'st-row-name' }, a.name, error ? h('span', { class: 'st-warn' }, ` · ${error}`) : null),
          muteKey ? h('span', { class: 'st-key mono' }, keyLabel(muteKey)) : null,
          db,
          h('button', { class: `icon-btn tiny ${a.muted ? 'active' : ''}`, 'data-tip': a.muted ? 'Unmute' : 'Mute', onclick: () => { a.muted = !a.muted; this.changed(); this.syncAudioGains(); this.renderMixer(); } }, icon(a.muted ? 'volume-x' : 'volume', 'sm')),
          media ? null : h('button', { class: 'icon-btn tiny', 'data-tip': 'More', onclick: (e) => this.chanMenu(e, a) }, icon('more', 'sm'))),
        h('div', { class: 'st-meter' }, h('i')),
        slider);
      row._an = an;
      if (!media) row.addEventListener('contextmenu', (e) => this.chanMenu(e, a));
      l.append(row);
    }
  }

  syncAudioGains() {
    for (const [id, ch] of this.chans) { const a = this.cfg.audio.find((x) => x.id === id); if (a) ch.gain.gain.value = a.muted ? 0 : a.vol ?? 1; }
    for (const s of this.cfg.scenes) for (const it of s.items) { const v = this.vids.get(it.id); if (v?.gain) v.gain.gain.value = it.muted ? 0 : it.vol ?? 1; }
  }

  async chanMenu(e, a) {
    e.preventDefault?.();
    const devs = a.kind === 'mic' ? (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications') : [];
    const items = [
      { label: 'Rename', icon: 'edit', action: async () => { const n = await promptDialog('Rename input', 'Name', a.name); if (n) { a.name = n.slice(0, 60); this.changed(); this.renderMixer(); } } },
      ...(a.kind === 'mic' ? [
        { label: 'Device', icon: 'headphones', submenu: devs.map((d, i) => ({ label: d.label || `Input ${i + 1}`, checked: (a.device || 'default') === d.deviceId, action: () => { a.device = d.deviceId; this.changed(); this.syncAudio(); } })) },
        { label: 'Noise suppression', checked: !!a.ns, action: () => { a.ns = !a.ns; this.changed(); this.syncAudio(); } },
      ] : []),
      { label: 'Set a mute hotkey…', icon: 'keyboard', action: () => this.openSettings('hotkeys') },
      { sep: true },
      { label: 'Remove', icon: 'trash', action: () => { this.cfg.audio = this.cfg.audio.filter((x) => x !== a); delete this.cfg.hotkeys[`mute:${a.id}`]; this.changed(); this.syncAudio(); this.applyHotkeys(); } },
    ];
    if (e.clientX != null && e.type === 'contextmenu') contextMenu(e, items);
    else showMenu(items, { anchor: e.currentTarget });
  }

  // ---------------------------------------------------------------- the stage: select, move, resize, rotate, crop

  toCanvas(e) {
    const r = this.frame.getBoundingClientRect();
    return [(e.clientX - r.left) / this.k, (e.clientY - r.top) / this.k];
  }
  hit(x, y) {
    for (const it of this.items()) {
      if (it.hidden || !it.w) continue;
      const [lx, ly] = rot(x - (it.x + it.w / 2), y - (it.y + it.h / 2), -rad(it.rot || 0));
      if (Math.abs(lx) <= it.w / 2 && Math.abs(ly) <= it.h / 2) return it;
    }
    return null;
  }

  updateSel() {
    if (!this.selBox || !this.k) return;
    const it = this.item(this.sel);
    if (!it || it.hidden || !it.w) { this.selBox.hidden = true; return; }
    const k = this.k;
    this.selBox.hidden = false;
    Object.assign(this.selBox.style, { left: `${it.x * k}px`, top: `${it.y * k}px`, width: `${it.w * k}px`, height: `${it.h * k}px`, transform: `rotate(${it.rot || 0}deg)` });
    this.selBox.classList.toggle('locked', !!it.locked);
  }

  /** Lines a dragged source snaps to: the canvas's edges and middle, and every other shown source's edges and middle. */
  snapTargets(self) {
    const W = this.cfg.canvas.w, H = this.cfg.canvas.h;
    const xs = [0, W / 2, W], ys = [0, H / 2, H];
    for (const o of this.items()) {
      if (o === self || o.hidden || !o.w) continue;
      const [x, y, w, hh] = bbox(o);
      xs.push(x, x + w / 2, x + w);
      ys.push(y, y + hh / 2, y + hh);
    }
    return { xs, ys };
  }

  /** The little label under the selection while dragging it ('' hides it). */
  readout(text) {
    if (!this.readEl) return;
    this.readEl.textContent = text;
    this.readEl.hidden = !text;
    const it = text && this.item(this.sel);
    if (!it) return;
    const [x, y, w, hh] = bbox(it);
    Object.assign(this.readEl.style, { left: `${(x + w / 2) * this.k}px`, top: `${(y + hh) * this.k + 8}px` });
  }

  /** Make the canvas exactly the size of this source at its real size, with the source filling it.
   *  The scene's other sources move along with it, so they keep their place relative to it. */
  canvasToItem(it) {
    const src = { w: it.nw || it.tw || it.w, h: it.nh || it.th || it.h };
    const c = it.crop || {};
    const cw = src.w * (1 - (c.l || 0) - (c.r || 0)), ch = src.h * (1 - (c.t || 0) - (c.b || 0));
    if (!cw || !ch) return;
    // to its real size, around its middle
    const mx = it.x + it.w / 2, my = it.y + it.h / 2;
    it.w = cw; it.h = ch; it.x = mx - cw / 2; it.y = my - ch / 2;
    const [bx, by, bw, bh] = bbox(it);
    const W = clamp(Math.round(bw / 2) * 2, 16, 7680), H = clamp(Math.round(bh / 2) * 2, 16, 4320);
    // its box's corner to the canvas corner (centred in the half pixel rounding adds)
    const ox = bx - (W - bw) / 2, oy = by - (H - bh) / 2;
    for (const o of this.scene().items) { o.x -= ox; o.y -= oy; }
    this.cfg.canvas.w = W; this.cfg.canvas.h = H;
    this.sizeCanvas();
    this.changed();
    this.renderTop?.();
    this.updateSel();
    this.renderProps();
    toast(`The canvas is now ${W}×${H}, the size of ${it.name}.`, { type: 'ok' });
  }

  guides(lines) {
    const g = this.frame.querySelector('.st-guides');
    clear(g);
    for (const [axis, v] of lines) g.append(h('i', { class: axis, style: axis === 'v' ? { left: `${v * this.k}px` } : { top: `${v * this.k}px` } }));
  }

  wireStage() {
    const st = this.stage;
    st.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      st.focus({ preventScroll: true });
      this.ensureAudio();
      const [x, y] = this.toCanvas(e);
      const handle = e.target.closest('.st-h, .st-rot');
      let it = handle ? this.item(this.sel) : this.hit(x, y);
      if (!handle) { if ((it?.id || null) !== this.sel) this.select(it?.id || null); }
      if (!it || e.button !== 0 || it.locked) return;
      e.preventDefault();
      const s0 = { x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot || 0, crop: { ...(it.crop || { l: 0, t: 0, r: 0, b: 0 }) } };
      const mode = !handle ? 'move' : handle.classList.contains('st-rot') ? 'rot' : e.altKey ? 'crop' : 'size';
      const hx = handle ? +handle.dataset.hx || 0 : 0, hy = handle ? +handle.dataset.hy || 0 : 0;
      // what edges snap to: the canvas's edges and middle, and the edges and middles of the other sources
      const T = this.snapTargets(it);
      const square = !(s0.rot % 90);
      const move = (ev) => {
        const [px, py] = this.toCanvas(ev);
        let dx = px - x, dy = py - y;
        const lines = [];
        const snapping = !ev.ctrlKey;
        const tol = SNAP / Math.max(this.k, 0.05);
        if (mode === 'move') {
          // Shift: only along the way the drag mostly goes
          const lock = ev.shiftKey ? (Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y') : null;
          if (lock === 'x') dy = 0; else if (lock === 'y') dx = 0;
          let nx = s0.x + dx, ny = s0.y + dy;
          if (snapping && square) {
            const [bx, by, bw, bh] = bbox({ ...s0, x: nx, y: ny });
            const sx = lock !== 'y' && nearest([bx, bx + bw / 2, bx + bw], T.xs, tol);
            const sy = lock !== 'x' && nearest([by, by + bh / 2, by + bh], T.ys, tol);
            if (sx) { nx += sx.d; lines.push(['v', sx.t]); }
            if (sy) { ny += sy.d; lines.push(['h', sy.t]); }
          }
          it.x = nx; it.y = ny;
          this.readout(`${Math.round(nx)}, ${Math.round(ny)}`);
        } else if (mode === 'rot') {
          const cx = s0.x + s0.w / 2, cy = s0.y + s0.h / 2;
          let a = (Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90;
          if (ev.shiftKey) a = Math.round(a / 15) * 15;
          else if (!ev.ctrlKey) for (const t of [0, 90, 180, 270, 360]) if (Math.abs(a - t) < 3 || Math.abs(a + 360 - t) < 3) a = t;
          it.rot = ((a % 360) + 360) % 360;
          this.readout(`${Math.round(it.rot)}°`);
        } else {
          // in the item's own (unrotated) frame
          const [lx, ly] = rot(dx, dy, -rad(s0.rot));
          let nw = s0.w + hx * lx, nh = s0.h + hy * ly;
          const keep = mode === 'size' && hx && hy && !ev.shiftKey;
          if (keep) {
            // corners keep the shape
            const sc = Math.max(nw / s0.w, nh / s0.h);
            nw = s0.w * sc; nh = s0.h * sc;
          }
          // the dragged edges snap (only when the source sits square: a tilted edge has no one line to snap)
          if (snapping && !(s0.rot % 360)) {
            const sx = hx && nearest([hx > 0 ? s0.x + nw : s0.x + s0.w - nw], T.xs, tol);
            const sy = hy && nearest([hy > 0 ? s0.y + nh : s0.y + s0.h - nh], T.ys, tol);
            if (keep) {
              // the nearer edge wins and the other follows the shape
              if (sx && (!sy || Math.abs(sx.d) <= Math.abs(sy.d))) { const w2 = nw + hx * sx.d; nh *= w2 / nw; nw = w2; lines.push(['v', sx.t]); }
              else if (sy) { const h2 = nh + hy * sy.d; nw *= h2 / nh; nh = h2; lines.push(['h', sy.t]); }
            } else {
              if (sx) { nw += hx * sx.d; lines.push(['v', sx.t]); }
              if (sy) { nh += hy * sy.d; lines.push(['h', sy.t]); }
            }
          }
          if (mode === 'crop') {
            // the crop that shows this much of the source at the same scale
            const srcW = (it.nw || it.tw || s0.w), srcH = (it.nh || it.th || s0.h);
            const c0 = s0.crop;
            const kx = s0.w / (srcW * (1 - c0.l - c0.r)), ky = s0.h / (srcH * (1 - c0.t - c0.b));
            const c = { ...c0 };
            if (hx < 0) c.l = clamp(1 - c0.r - nw / (kx * srcW), 0, 0.99 - c0.r);
            if (hx > 0) c.r = clamp(1 - c0.l - nw / (kx * srcW), 0, 0.99 - c0.l);
            if (hy < 0) c.t = clamp(1 - c0.b - nh / (ky * srcH), 0, 0.99 - c0.b);
            if (hy > 0) c.b = clamp(1 - c0.t - nh / (ky * srcH), 0, 0.99 - c0.t);
            it.crop = c;
            nw = srcW * (1 - c.l - c.r) * kx; nh = srcH * (1 - c.t - c.b) * ky;
          }
          nw = Math.max(4, nw); nh = Math.max(4, nh);
          this.readout(`${Math.round(nw)} × ${Math.round(nh)}`);
          // the opposite side stays where it was
          const cxl = hx * (nw - s0.w) / 2, cyl = hy * (nh - s0.h) / 2;
          const [cx, cy] = rot(cxl, cyl, rad(s0.rot));
          const ncx = s0.x + s0.w / 2 + cx, ncy = s0.y + s0.h / 2 + cy;
          it.w = nw; it.h = nh; it.x = ncx - nw / 2; it.y = ncy - nh / 2;
        }
        this.guides(lines);
        this.updateSel();
      };
      const up = () => {
        removeEventListener('pointermove', move, true);
        removeEventListener('pointerup', up, true);
        removeEventListener('pointercancel', up, true);
        this.guides([]);
        this.readout('');
        this.changed();
        this.renderProps();
      };
      addEventListener('pointermove', move, true);
      addEventListener('pointerup', up, true);
      addEventListener('pointercancel', up, true);
    });
    st.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const it = this.item(this.sel);
      if (it) this.itemMenu(e, it);
      else contextMenu(e, Object.entries(TYPES).map(([t, d]) => ({ label: `Add ${d.name.toLowerCase()}`, icon: d.icon, action: () => this.addSource(t, st) })));
    });
    st.addEventListener('keydown', (e) => {
      const it = this.item(this.sel);
      if (!it) return;
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d && !it.locked) { e.preventDefault(); it.x += d[0]; it.y += d[1]; this.updateSel(); this.changed(); this.renderPropsSoon(); }
      else if (e.key === 'Delete') { e.preventDefault(); this.removeItem(it); }
      else if (e.key === 'Escape') this.select(null);
    });
    st.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    st.addEventListener('drop', (e) => {
      e.preventDefault();
      let paths = draggedPaths(e);
      if (!paths.length) paths = [...(e.dataTransfer.files || [])].map((f) => shell()?.pathForFile?.(f) || '').filter(Boolean);
      if (paths.length) this.addFiles(paths);
    });
    this.renderPropsSoon = debounce(() => this.renderProps(), 250);
  }

  // ---------------------------------------------------------------- settings

  openSettings(section = 'video') {
    const c = this.cfg;
    const o = c.output;
    const body = h('div', { class: 'st-settings' });
    const tabs = [['video', 'Video'], ['output', 'Output'], ['hotkeys', 'Hotkeys'], ['transition', 'Transition']];
    let at = section;
    const nav = h('div', { class: 'st-set-nav' });
    const pane = h('div', { class: 'st-set-pane' });
    body.append(nav, pane);
    const row = (label, ...kids) => h('div', { class: 'st-set-row' }, h('span', { class: 'st-set-label' }, label), h('div', { class: 'st-set-ctl' }, ...kids));
    const after = () => { this.changed(); this.renderTop(); };
    const show = () => {
      clear(nav).append(...tabs.map(([k, n]) => h('button', { class: `st-set-tab ${k === at ? 'on' : ''}`, onclick: () => { at = k; show(); } }, n)));
      clear(pane);
      if (at === 'video') {
        const preset = RES.find(([w, hh]) => w === c.canvas.w && hh === c.canvas.h);
        const wIn = h('input', { type: 'number', min: '16', max: '7680', step: '2', value: String(c.canvas.w), class: 'st-num' });
        const hIn = h('input', { type: 'number', min: '16', max: '4320', step: '2', value: String(c.canvas.h), class: 'st-num' });
        const apply = (w, hh) => {
          w = clamp(Math.round(w / 2) * 2, 16, 7680); hh = clamp(Math.round(hh / 2) * 2, 16, 4320);
          if (w === c.canvas.w && hh === c.canvas.h) return;
          // same shape: everything scales along; another shape: things stay where they are
          const kx = w / c.canvas.w, ky = hh / c.canvas.h;
          if (Math.abs(kx - ky) < 0.01) for (const s of c.scenes) for (const it of s.items) { it.x *= kx; it.y *= kx; it.w *= kx; it.h *= kx; }
          c.canvas.w = w; c.canvas.h = hh;
          this.sizeCanvas(); after(); show();
        };
        pane.append(
          row('Canvas size', h('select', { onchange: (e) => { if (e.target.value) { const [w, hh] = e.target.value.split('x').map(Number); apply(w, hh); } } },
            ...RES.map(([w, hh, n]) => h('option', { value: `${w}x${hh}`, selected: preset && preset[0] === w && preset[1] === hh }, `${n} · ${w}×${hh}`)),
            h('option', { value: '', selected: !preset }, 'Custom'))),
          row('Custom', wIn, h('span', { class: 'faint' }, '×'), hIn, h('button', { class: 'btn sm', onclick: () => apply(+wIn.value, +hIn.value) }, 'Use')),
          row('Frame rate', h('select', { onchange: (e) => { c.canvas.fps = +e.target.value; this.ticker.postMessage(Math.round(1000 / c.canvas.fps)); after(); } },
            ...FPS.map((f) => h('option', { value: String(f), selected: c.canvas.fps === f }, `${f} fps`)))),
          h('div', { class: 'st-set-note faint' }, 'Recordings come out at the canvas size. Any size works; even numbers are kindest to video players.'));
      } else if (at === 'output') {
        const codecs = ['auto', 'h264', 'vp9', 'av1', 'vp8'].filter((k) => k === 'auto' || CODECS[k].some((m) => MediaRecorder.isTypeSupported(m)));
        const mime = pickMime(o.codec, o.format);
        pane.append(
          row('Save to', h('label', { class: 'st-check' }, h('input', { type: 'checkbox', checked: !!o.dump, onchange: (e) => { o.dump = e.target.checked; after(); show(); } }), 'the media dump')),
          o.dump ? '' : row('Folder', h('span', { class: 'st-path', title: o.dir }, o.dir || 'none yet'),
            h('button', { class: 'btn sm', onclick: async () => { const d = await pickFolder({ title: 'Where recordings go' }); if (d) { o.dir = d; after(); show(); } } }, 'Choose…')),
          row('Format', h('select', { onchange: (e) => { o.format = e.target.value; after(); show(); } }, ...FORMATS.map(([k, n]) => h('option', { value: k, selected: o.format === k }, n)))),
          row('Encoder', h('select', { onchange: (e) => { o.codec = e.target.value; after(); show(); } }, ...codecs.map((k) => h('option', { value: k, selected: o.codec === k }, CODEC_NAMES[k])))),
          row('Video bitrate', h('input', { type: 'number', min: '1', max: '200', step: '1', value: String(o.mbps), class: 'st-num', onchange: (e) => { o.mbps = clamp(+e.target.value || 12, 1, 200); after(); } }), h('span', { class: 'faint' }, 'Mbps')),
          row('Audio bitrate', h('select', { onchange: (e) => { o.audioKbps = +e.target.value; after(); } }, ...[96, 128, 160, 192, 256, 320].map((k) => h('option', { value: String(k), selected: o.audioKbps === k }, `${k} kbps`)))),
          row('Area key', h('label', { class: 'st-check' }, h('input', { type: 'checkbox', checked: !!o.areaStarts, onchange: (e) => { o.areaStarts = e.target.checked; after(); } }), 'starts recording once an area is picked')),
          h('div', { class: 'st-set-note faint' }, mime ? `Records ${mime.split(';')[1]?.replace('codecs=', '') || mime}.` : 'No encoder for that combination.',
            this.ffmpeg ? '' : ' ffmpeg isn’t installed, so files stay as the recorder writes them (no MKV or MOV, and some players can’t seek them).'));
      } else if (at === 'hotkeys') {
        const list = [
          ...ACTIONS.map(([k, n]) => [k, n]),
          ...c.scenes.map((s) => [`scene:${s.id}`, `Switch to “${s.name}”`]),
          ...c.audio.map((a) => [`mute:${a.id}`, `Mute / unmute ${a.name}`]),
        ];
        pane.append(h('div', { class: 'st-set-note faint' }, shell()?.studio ? 'These work anywhere, even with a game in front. Click a box and press the keys; Backspace clears it. The Win button adds or drops the Windows key.' : 'These only work while this page is in front (the desktop app makes them work everywhere).'));
        for (const [k, n] of list) pane.append(row(n, ...hotkeyField(c.hotkeys, k, () => { this.changed(); this.applyHotkeys().then(() => { this.renderScenes(); this.renderMixer(); }); }, this.hotkeyFailed?.has(k))));
      } else if (at === 'transition') {
        pane.append(
          row('Between scenes', h('select', { onchange: (e) => { c.transition.kind = e.target.value; after(); } }, h('option', { value: 'fade', selected: c.transition.kind === 'fade' }, 'Fade'), h('option', { value: 'cut', selected: c.transition.kind === 'cut' }, 'Cut'))),
          row('Fade length', h('input', { type: 'number', min: '50', max: '3000', step: '50', value: String(c.transition.ms), class: 'st-num', onchange: (e) => { c.transition.ms = clamp(+e.target.value || 300, 50, 3000); after(); } }), h('span', { class: 'faint' }, 'ms')));
      }
    };
    show();
    modal({ title: 'Studio settings', body, wide: true });
  }

  // ================================================================ BaseEditor

  status() {
    const { w, h: hh, fps } = this.cfg?.canvas || {};
    const r = this.rec;
    return {
      // the mode chip already says BoxStudio
      left: [{ text: this.scene()?.name || '', icon: 'video' }],
      right: [
        r ? { text: `● ${r.recorder.state === 'paused' ? 'PAUSED' : 'REC'} ${fmtTime(this.recSeconds())}`, cls: 'st-status-rec' } : { text: this.saving ? 'saving…' : 'ready' },
        { text: `${w}×${hh} · ${fps} fps` },
      ],
    };
  }

  onShow() { this.layoutStage?.(); }

  async beforeClose() {
    if (!this.rec) return true;
    this.app.activate?.(this.tab);
    if (!(await confirmDialog('Still recording', 'Stop the recording and save it?', { okLabel: 'Stop and save' }))) return false;
    await this.stopRec();
    return true;
  }

  destroy() {
    this.dead = true;
    if (this.rec) this.stopRec(); // the server keeps what arrived either way
    if (current === this) current = null;
    shell()?.studio?.({ op: 'unhotkeys' });
    shell()?.studio?.({ op: 'busy', on: false });
    clearInterval(this.recTimer);
    cancelAnimationFrame(this.meterRaf);
    this.ticker?.terminate();
    this.ro?.disconnect();
    for (const c of this.caps.values()) this.closeCap(c);
    for (const [id, v] of this.vids) this.closeVid(id, v);
    for (const ch of this.chans.values()) this.closeChan(ch);
    this.ac?.close().catch(() => {});
    this.save();
  }
}

/** Electron's name for the keys pressed ('Ctrl+Alt+R'), or '' while only modifiers are down. */
function accelOf(e) {
  const code = e.code || '';
  let key = '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^Numpad\d$/.test(code)) key = `num${code.slice(6)}`;
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else key = { Space: 'Space', Tab: 'Tab', Enter: 'Enter', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`', Pause: 'Pause', ScrollLock: 'Scrolllock',
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec' }[code] || '';
  if (!key) return '';
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', key].filter(Boolean).join('+');
}

/** A box that takes the next key combination, plus a Win toggle and a clear button. */
function hotkeyField(map, k, onChange, taken) {
  const inp = h('input', { type: 'text', readonly: true, class: `st-keyin mono ${taken ? 'taken' : ''}`, value: keyLabel(map[k] || ''), placeholder: 'none', title: taken ? 'Another program has this one' : '' });
  const set = (v) => { if (v) map[k] = v; else delete map[k]; inp.value = keyLabel(v || ''); onChange(); };
  inp.addEventListener('keydown', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { inp.blur(); return; }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey) { set(''); return; }
    const a = accelOf(e);
    if (!a) return;
    // Windows keeps most Win+ combinations for itself: a bare key without Ctrl/Alt/Win would fire while typing
    if (!/Ctrl|Alt|Super/.test(a) && !/^F\d+$|^num/.test(a.split('+').pop())) { toast('Add Ctrl, Alt or Win to that key.', { type: 'warn', timeout: 2500 }); return; }
    set(a);
  });
  const win = h('button', { class: 'btn sm ghost', 'data-tip': 'Add or drop the Windows key', onclick: () => {
    const cur = map[k] || '';
    if (!cur) return;
    set(cur.includes('Super') ? cur.replace('Super+', '') : cur.replace(/(\+?)([^+]+)$/, '$1Super+$2').replace(/^\+/, ''));
  } }, 'Win');
  const x = h('button', { class: 'icon-btn tiny', 'data-tip': 'Clear', onclick: () => set('') }, icon('x', 'sm'));
  return [inp, win, x];
}
