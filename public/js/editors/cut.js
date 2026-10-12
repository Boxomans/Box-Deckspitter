// Video editor: a small multi-track editor. Video and audio tracks, images on the timeline (drag the edge to
// change how long they show), keyframes for position / scale / rotation / opacity / volume, chroma key, a
// properties panel for the selected clip, and frame-exact MP4 export through the PC's ffmpeg.
// Projects are saved as .boxcut (JSON) and use media files where they are on disk.

import { BaseEditor } from './base.js';
import { h, clear, clamp, basename, extOf, stripExt, uid, dirname } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { tbButton, tbSep, toast, errorToast, contextMenu, modal } from '../core/ui.js';
import { api } from '../core/api.js';
import { pickOpen, pickSave } from '../core/files.js';
import { fmtTime } from './video.js';

const VIDEO_RE = /\.(mp4|m4v|webm|mov|mkv|ogv|avi|wmv|3gp|mts|m2ts|flv)$/i;
const AUDIO_RE = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i;
const IMAGE_RE = /\.(png|jpe?g|jfif|webp|gif|bmp|svg)$/i;
const kindOf = (name) => (VIDEO_RE.test(name) ? 'video' : AUDIO_RE.test(name) ? 'audio' : IMAGE_RE.test(name) ? 'image' : null);
const stream = (p) => `/api/stream?token=${encodeURIComponent(api.token)}&path=${encodeURIComponent(p)}`;
/** What to actually play for a media item: its editing proxy if it needed one, else the file itself. */
const srcOf = (m) => stream(m.proxy || m.path);
const postJSON = (url, body) => fetch(url, { method: 'POST', headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`); return d; });

// keyframable properties: default, range, unit
const PROPS = {
  x: { label: 'X', def: 0, step: 1, unit: 'px' },
  y: { label: 'Y', def: 0, step: 1, unit: 'px' },
  scale: { label: 'Scale', def: 100, step: 1, min: 1, max: 1000, unit: '%' },
  rotation: { label: 'Rotation', def: 0, step: 1, unit: '°' },
  opacity: { label: 'Opacity', def: 100, step: 1, min: 0, max: 100, unit: '%' },
  volume: { label: 'Volume', def: 100, step: 1, min: 0, max: 200, unit: '%' },
};
const VISUAL = ['x', 'y', 'scale', 'rotation', 'opacity'];
const IMAGE_LEN = 5;
const MIN_LEN = 0.1;
const SNAP_PX = 8;
const PRESETS = [['1920 × 1080 (HD)', 1920, 1080], ['1280 × 720', 1280, 720], ['3840 × 2160 (4K)', 3840, 2160], ['1080 × 1920 (vertical)', 1080, 1920], ['1080 × 1080 (square)', 1080, 1080]];

const smooth = (u) => u * u * (3 - 2 * u);

/** A property's value at clip-local time t: keyframes eased between, or the plain value. */
function valueAt(clip, prop, t) {
  const keys = clip.keys?.[prop];
  if (!keys?.length) return clip.props?.[prop] ?? PROPS[prop].def;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.t && t <= b.t) return a.v + (b.v - a.v) * smooth((t - a.t) / (b.t - a.t || 1));
  }
  return last.v;
}

const newProject = () => ({
  version: 1, width: 1920, height: 1080, fps: 30, background: '#000000',
  media: [],
  tracks: [{ id: uid('t'), kind: 'video', name: 'V1', clips: [] }, { id: uid('t'), kind: 'audio', name: 'A1', clips: [] }],
});

// ---------------------------------------------------------------- chroma key (per pixel, in YCbCr chroma space)
function hexToRgb(hex) { const n = parseInt(String(hex).replace('#', ''), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function chromaKey(ctx, w, h, key) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [kr, kg, kb] = hexToRgb(key.color);
  const kcb = -0.168736 * kr - 0.331264 * kg + 0.5 * kb;
  const kcr = 0.5 * kr - 0.418688 * kg - 0.081312 * kb;
  const tol = (key.tolerance ?? 40) * 1.2;
  const soft = Math.max(1, (key.softness ?? 20) * 1.2);
  const spill = (key.spill ?? 50) / 100;
  const green = kg >= kr && kg >= kb;
  const blue = kb > kg && kb >= kr;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
    const dist = Math.hypot(cb - kcb, cr - kcr);
    if (dist < tol) d[i + 3] = 0;
    else if (dist < tol + soft) d[i + 3] = Math.round(d[i + 3] * ((dist - tol) / soft));
    // spill: pull the key colour's channel down to its neighbours so edges don't glow green/blue
    if (spill && d[i + 3]) {
      if (green) { const lim = Math.max(r, b); if (g > lim) d[i + 1] = Math.round(g - (g - lim) * spill); }
      else if (blue) { const lim = Math.max(r, g); if (b > lim) d[i + 2] = Math.round(b - (b - lim) * spill); }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Chroma key on the GPU: the frame goes up as a texture, a small shader does the keying, and the result is
 * drawn back like any picture. Hundreds of times faster than the per-pixel version below, which stays as the
 * fallback for PCs without WebGL.
 */
class GLKey {
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
    if (!gl) { this.failed = true; return; }
    this.gl = gl;
    const vs = 'attribute vec2 p; varying vec2 uv; void main(){ uv = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0., 1.); }';
    const fs = `precision mediump float;
      uniform sampler2D tex; uniform vec2 key; uniform float tol; uniform float soft; uniform float spill; uniform int mode;
      varying vec2 uv;
      void main(){
        vec4 c = texture2D(tex, uv);
        float cb = -0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b;
        float cr = 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b;
        float a = clamp((distance(vec2(cb, cr), key) - tol) / soft, 0.0, 1.0) * c.a;
        vec3 rgb = c.rgb;
        if (mode == 0) { float lim = max(rgb.r, rgb.b); if (rgb.g > lim) rgb.g -= (rgb.g - lim) * spill; }
        else if (mode == 1) { float lim = max(rgb.r, rgb.g); if (rgb.b > lim) rgb.b -= (rgb.b - lim) * spill; }
        gl_FragColor = vec4(rgb * a, a);
      }`;
    const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return gl.getShaderParameter(o, gl.COMPILE_STATUS) ? o : null; };
    const v = sh(gl.VERTEX_SHADER, vs);
    const f = sh(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) { this.failed = true; return; }
    const prog = gl.createProgram();
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { this.failed = true; return; }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, val);
    this.u = Object.fromEntries(['key', 'tol', 'soft', 'spill', 'mode'].map((n) => [n, gl.getUniformLocation(prog, n)]));
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.failed = true; });
  }

  /** Key `source` at w×h; returns a canvas to draw, or null (then the CPU version is used). */
  run(source, w, h, key) {
    if (this.failed) return null;
    const gl = this.gl;
    try {
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      const [kr, kg, kb] = hexToRgb(key.color).map((x) => x / 255);
      gl.uniform2f(this.u.key, -0.168736 * kr - 0.331264 * kg + 0.5 * kb, 0.5 * kr - 0.418688 * kg - 0.081312 * kb);
      gl.uniform1f(this.u.tol, ((key.tolerance ?? 40) * 1.2) / 255);
      gl.uniform1f(this.u.soft, Math.max(1, (key.softness ?? 20) * 1.2) / 255);
      gl.uniform1f(this.u.spill, (key.spill ?? 50) / 100);
      gl.uniform1i(this.u.mode, kg >= kr && kg >= kb ? 0 : kb > kg && kb >= kr ? 1 : 2);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return this.canvas;
    } catch { this.failed = true; return null; }
  }
}

// ---------------------------------------------------------------- WAV for the export's soundtrack
function wavFrom(buf) {
  const ch = buf.numberOfChannels;
  const n = buf.length;
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

export class CutEditor extends BaseEditor {
  static mode = 'cut';

  async load(bytes, opts = {}) {
    this.p = newProject();
    if (bytes && bytes.length) {
      try { this.p = { ...newProject(), ...JSON.parse(new TextDecoder().decode(bytes)) }; } catch { throw new Error('That isn’t a video editor project.'); }
    }
    this.t = 0; // playhead (s)
    this.pps = 60; // timeline zoom: pixels per second
    this.sel = null; // selected clip id
    this.undoStack = [];
    this.redoStack = [];
    this.els = new Map(); // preview media elements: clip id → <video>/<audio>; media id → <img>
    this.build();
    for (const m of this.p.media) this.probe(m);
    for (const p of opts.media || []) await this.importPath(p, { place: true });
    this.renderAll();
  }

  // =================================================================== model helpers

  media(id) { return this.p.media.find((m) => m.id === id); }
  allClips() { return this.p.tracks.flatMap((tr) => tr.clips.map((c) => ({ c, tr }))); }
  clip(id) { for (const tr of this.p.tracks) { const c = tr.clips.find((x) => x.id === id); if (c) return { c, tr }; } return null; }
  get duration() { return Math.max(1, ...this.allClips().map(({ c }) => c.start + c.len)); }
  get selected() { return this.sel ? this.clip(this.sel) : null; }

  /** Call before a change: remembers the project for undo. */
  remember() {
    this.undoStack.push(JSON.stringify(this.p));
    if (this.undoStack.length > 120) this.undoStack.shift();
    this.redoStack = [];
    this.markDirty();
  }
  undo() { if (!this.undoStack.length) return; this.redoStack.push(JSON.stringify(this.p)); this.p = JSON.parse(this.undoStack.pop()); this.afterHistory(); }
  redo() { if (!this.redoStack.length) return; this.undoStack.push(JSON.stringify(this.p)); this.p = JSON.parse(this.redoStack.pop()); this.afterHistory(); }
  afterHistory() { if (this.sel && !this.clip(this.sel)) this.sel = null; this.markDirty(); this.renderAll(); }

  // =================================================================== media

  async importPath(path, { place = false } = {}) {
    const kind = kindOf(path);
    if (!kind) { toast(`${basename(path)}: not a video, audio or image file`, { type: 'warn' }); return null; }
    let m = this.p.media.find((x) => x.path.toLowerCase() === path.toLowerCase());
    if (!m) {
      m = { id: uid('m'), path, name: basename(path), kind, duration: kind === 'image' ? null : 0, w: 0, h: 0 };
      this.p.media.push(m);
      await this.probe(m);
      this.markDirty();
    }
    if (place) this.placeMedia(m);
    this.renderBin();
    return m;
  }

  /** Length and size of a media file (from the browser's own decoder). */
  probe(m) {
    return new Promise((resolve) => {
      if (m.kind === 'image') {
        const img = new Image();
        img.onload = () => { m.w = img.naturalWidth; m.h = img.naturalHeight; m.missing = false; this.els.set(m.id, img); resolve(); this.draw(); };
        img.onerror = () => { m.missing = true; resolve(); this.renderBin(); };
        img.src = srcOf(m);
        return;
      }
      const el = document.createElement(m.kind === 'video' ? 'video' : 'audio');
      el.preload = 'metadata';
      el.onloadedmetadata = () => {
        m.w = el.videoWidth || 0;
        m.h = el.videoHeight || 0;
        m.missing = false;
        m.bad = false;
        if (Number.isFinite(el.duration) && el.duration > 0) { m.duration = el.duration; resolve(); this.renderBin(); return; }
        // some files (recorded webm…) don't say how long they are: jump to the end to find out
        el.ontimeupdate = () => { el.ontimeupdate = null; m.duration = Number.isFinite(el.duration) ? el.duration : el.currentTime || m.duration || 0; el.currentTime = 0; resolve(); this.renderBin(); };
        el.currentTime = 1e7;
      };
      el.onerror = async () => {
        // the browser can't play this format: have ffmpeg make an H.264 copy for editing (only once; it's cached)
        if (m.kind === 'video' && !m.proxy && !m.proxyFailed && (await this.makeProxy(m))) { resolve(await this.probe(m)); return; }
        m.missing = !(await api.stat(m.path).then((x) => x.exists).catch(() => false));
        m.bad = !m.missing;
        resolve();
        this.renderBin();
      };
      el.src = srcOf(m);
    });
  }

  /** H.264 editing copy of a video the browser can't decode. True when it's ready. */
  async makeProxy(m) {
    m.preparing = true;
    this.renderBin();
    try {
      const r = await postJSON('/api/render/proxy', { path: m.path });
      if (!r.done) {
        for (;;) {
          await new Promise((res) => setTimeout(res, 700));
          const j = await fetch(`/api/job?id=${r.id}`, { headers: { 'X-BDS-Token': api.token } }).then((x) => x.json());
          if (j.status === 'running') { m.preparing = Math.round((j.progress || 0) * 100); this.renderBin(); continue; }
          if (j.status !== 'done') throw new Error(j.error || 'conversion failed');
          break;
        }
      }
      m.proxy = r.path;
      return true;
    } catch (e) {
      m.proxyFailed = true;
      toast(`${m.name} can’t be played here${/ffmpeg/i.test(e.message) ? ' — installing ffmpeg would let the editor convert it' : ''}.`, { type: 'warn', timeout: 6000 });
      return false;
    } finally { m.preparing = false; this.renderBin(); }
  }

  /** Point a missing media item at its new location. */
  async relink(m) {
    const paths = await pickOpen({ title: `Where is ${m.name} now?` });
    if (!paths?.length) return;
    if (kindOf(paths[0]) !== m.kind) return toast(`Pick a ${m.kind} file.`, { type: 'warn' });
    this.remember();
    m.path = paths[0];
    m.name = basename(paths[0]);
    delete m.proxy; delete m.proxyFailed;
    for (const [k, el] of this.els) if (k === m.id || this.clip(k)?.c.media === m.id) { if (el.pause) { el.pause(); el.removeAttribute('src'); el.load(); } this.els.delete(k); }
    await this.probe(m);
    this.renderAll();
  }

  async importDialog() {
    const paths = await pickOpen({ multi: true, title: 'Add media', filters: [{ name: 'Video, audio & images', extensions: ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'] }, { name: 'All files', extensions: ['*'] }] });
    for (const p of paths || []) await this.importPath(p);
  }

  async fromImageDump() {
    let items = [];
    try { items = (await api.dump('image')).items; } catch { /* ignore */ }
    if (!items.length) return toast('The image dump is empty.', { type: 'warn' });
    let ctx = null;
    const grid = h('div', { class: 'mail-dumppick image' }, items.map((it) => {
      const b = h('button', { class: 'mail-dumpitem', title: it.name }, h('img', { src: it.url, alt: '' }), h('span', { class: 'mail-dumpname' }, it.name));
      b.addEventListener('click', async () => { ctx?.close(null); await this.importPath(it.path); });
      return b;
    }));
    modal({ title: 'Add from the image dump', wide: true, body: grid, buttons: [{ label: 'Cancel', value: null, ghost: true }], onOpen: (c) => { ctx = c; } });
  }

  /** Put a media item on the first fitting track at the playhead (or after the last clip there). */
  placeMedia(m, trackId = null, at = null) {
    const kind = m.kind === 'audio' ? 'audio' : 'video';
    let tr = trackId ? this.p.tracks.find((x) => x.id === trackId) : this.p.tracks.find((x) => x.kind === kind);
    if (!tr || tr.kind !== kind) tr = this.addTrack(kind, { quiet: true });
    const len = m.kind === 'image' ? IMAGE_LEN : Math.max(MIN_LEN, m.duration || IMAGE_LEN);
    let start = at ?? this.t;
    // don't drop on top of another clip on that track
    const hit = tr.clips.find((c) => start < c.start + c.len && start + len > c.start);
    if (hit && at == null) start = Math.max(...tr.clips.map((c) => c.start + c.len));
    this.remember();
    const c = { id: uid('c'), media: m.id, start: Math.max(0, start), in: 0, len, props: {}, keys: {} };
    tr.clips.push(c);
    this.sel = c.id;
    this.renderAll();
    return c;
  }

  addTrack(kind, { quiet = false } = {}) {
    if (!quiet) this.remember();
    const n = this.p.tracks.filter((t) => t.kind === kind).length + 1;
    const tr = { id: uid('t'), kind, name: (kind === 'video' ? 'V' : 'A') + n, clips: [] };
    // video tracks stack upward (new ones on top), audio tracks go downward
    if (kind === 'video') this.p.tracks.unshift(tr); else this.p.tracks.push(tr);
    if (!quiet) this.renderAll();
    return tr;
  }

  removeTrack(tr) {
    if (this.p.tracks.filter((t) => t.kind === tr.kind).length < 2 && tr.clips.length) return toast('Keep at least one track of each kind — clear it instead.', { type: 'warn' });
    this.remember();
    this.p.tracks = this.p.tracks.filter((t) => t !== tr);
    if (this.sel && !this.clip(this.sel)) this.sel = null;
    this.renderAll();
  }

  // =================================================================== editing

  split() {
    const s = this.selected || this.allClips().find(({ c }) => this.t > c.start && this.t < c.start + c.len);
    if (!s) return toast('Put the playhead over a clip to split it.', { timeout: 1600 });
    const { c, tr } = s;
    const at = this.t - c.start;
    if (at <= MIN_LEN / 2 || at >= c.len - MIN_LEN / 2) return;
    this.remember();
    const b = JSON.parse(JSON.stringify(c));
    b.id = uid('c');
    b.start = this.t;
    b.in = c.in + (this.media(c.media)?.kind === 'image' ? 0 : at);
    b.len = c.len - at;
    // keyframes after the cut move to the second half
    for (const [prop, keys] of Object.entries(c.keys || {})) {
      const v = valueAt(c, prop, at);
      c.keys[prop] = [...keys.filter((k) => k.t < at), { t: at, v }];
      b.keys[prop] = [{ t: 0, v }, ...keys.filter((k) => k.t > at).map((k) => ({ t: k.t - at, v: k.v }))];
    }
    c.len = at;
    tr.clips.push(b);
    this.sel = b.id;
    this.renderAll();
  }

  deleteSelected() {
    const s = this.selected;
    if (!s) return;
    this.remember();
    s.tr.clips = s.tr.clips.filter((c) => c !== s.c);
    this.sel = null;
    this.renderAll();
  }

  /** Set a property at the playhead: a keyframe if the property is animated, otherwise its plain value. */
  setProp(c, prop, v, { forceKey = false } = {}) {
    const t = clamp(this.t - c.start, 0, c.len);
    c.keys = c.keys || {};
    const keys = c.keys[prop];
    if (keys?.length || forceKey) {
      const k = (keys || []).find((x) => Math.abs(x.t - t) < 1 / (this.p.fps * 2));
      if (k) k.v = v; else c.keys[prop] = [...(keys || []), { t, v }].sort((a, b) => a.t - b.t);
    } else {
      c.props = c.props || {};
      c.props[prop] = v;
    }
  }

  toggleKey(c, prop) {
    this.remember();
    const t = clamp(this.t - c.start, 0, c.len);
    const keys = c.keys?.[prop] || [];
    const at = keys.findIndex((x) => Math.abs(x.t - t) < 1 / (this.p.fps * 2));
    if (at >= 0) {
      keys.splice(at, 1);
      if (!keys.length) { delete c.keys[prop]; }
    } else this.setProp(c, prop, valueAt(c, prop, t), { forceKey: true });
    this.renderProps();
    this.renderTimeline();
    this.draw();
  }

  // =================================================================== layout

  build() {
    this.canvas = h('canvas', { class: 'cut-canvas' });
    this.ctx2d = this.canvas.getContext('2d', { willReadFrequently: false });
    this.scratch = document.createElement('canvas'); // for chroma key
    this.timeLabel = h('span', { class: 'mono cut-time' });
    this.playBtn = h('button', { class: 'cut-play', 'data-tip': 'Play / pause (Space)', onclick: () => this.togglePlay() }, icon('play'));
    this.bin = h('div', { class: 'cut-bin-list' });
    this.props = h('div', { class: 'cut-props' });
    this.tlHead = h('div', { class: 'cut-tl-heads' });
    this.ruler = h('div', { class: 'cut-ruler' });
    this.lanes = h('div', { class: 'cut-lanes' });
    this.playhead = h('div', { class: 'cut-playhead' });
    this.tlInner = h('div', { class: 'cut-tl-inner' }, this.ruler, this.lanes, this.playhead);
    this.tlScroll = h('div', { class: 'cut-tl-scroll' }, this.tlInner);

    const binEl = h('div', { class: 'cut-bin' },
      h('div', { class: 'cut-pane-head' }, 'Media', h('div', { class: 'grow' }),
        h('button', { class: 'icon-btn', 'data-tip': 'From the image dump', onclick: () => this.fromImageDump() }, icon('image', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Add video, audio or images', onclick: () => this.importDialog() }, icon('plus', 'sm'))),
      this.bin);
    const stage = h('div', { class: 'cut-stage' },
      h('div', { class: 'cut-view' }, this.canvas),
      h('div', { class: 'cut-transport' },
        h('button', { class: 'icon-btn', 'data-tip': 'Start (Home)', onclick: () => this.seek(0) }, icon('skip-back', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Back one frame (←)', onclick: () => this.seek(this.t - 1 / this.p.fps) }, icon('chevron-left', 'sm')),
        this.playBtn,
        h('button', { class: 'icon-btn', 'data-tip': 'Forward one frame (→)', onclick: () => this.seek(this.t + 1 / this.p.fps) }, icon('chevron-right', 'sm')),
        this.timeLabel));
    const propsEl = h('div', { class: 'cut-side' }, h('div', { class: 'cut-pane-head' }, 'Properties'), this.props);
    const timeline = h('div', { class: 'cut-timeline' },
      h('div', { class: 'cut-tl-bar' },
        h('button', { class: 'btn sm', onclick: () => this.addTrack('video') }, icon('plus', 'sm'), 'Video track'),
        h('button', { class: 'btn sm', onclick: () => this.addTrack('audio') }, icon('plus', 'sm'), 'Audio track'),
        h('div', { class: 'grow' }),
        h('span', { class: 'faint', style: { fontSize: '11px' } }, 'drag clips · drag edges to trim · S split · Del delete · Ctrl+wheel zoom'),
        h('button', { class: 'icon-btn', 'data-tip': 'Zoom out', onclick: () => this.zoom(-1) }, icon('zoom-out', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Zoom in', onclick: () => this.zoom(1) }, icon('zoom-in', 'sm'))),
      h('div', { class: 'cut-tl-body' }, this.tlHead, this.tlScroll));
    this.root = h('div', { class: 'cut-root' }, h('div', { class: 'cut-top' }, binEl, stage, propsEl), timeline);
    this.pane.append(this.root);

    // timeline interactions
    this.ruler.addEventListener('pointerdown', (e) => this.scrub(e));
    this.lanes.addEventListener('pointerdown', (e) => { if (e.target === this.lanes || e.target.classList.contains('cut-lane')) { this.sel = null; this.scrub(e); this.renderTimeline(); this.renderProps(); } });
    this.tlScroll.addEventListener('scroll', () => { this.tlHead.scrollTop = this.tlScroll.scrollTop; });
    this.tlScroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1 : -1, e.clientX);
    }, { passive: false });
    // media dragged from the bin, or files dropped from Explorer
    this.lanes.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/bds-media') || e.dataTransfer.types.includes('Files')) { e.preventDefault(); this.lanes.classList.add('drop'); } });
    this.lanes.addEventListener('dragleave', (e) => { if (e.target === this.lanes) this.lanes.classList.remove('drop'); });
    this.lanes.addEventListener('drop', async (e) => {
      this.lanes.classList.remove('drop');
      e.preventDefault();
      const at = Math.max(0, this.xToT(e.clientX));
      const lane = e.target.closest('.cut-lane');
      const id = e.dataTransfer.getData('text/bds-media');
      if (id) { const m = this.media(id); if (m) this.placeMedia(m, this.fits(lane?.dataset.track, m), at); return; }
      for (const f of e.dataTransfer.files) {
        const p = window.bdsShell?.pathForFile?.(f);
        if (!p) { toast('Use the + button to add files here (drag-and-drop from Explorer works in the app window).', { type: 'warn' }); return; }
        const m = await this.importPath(p);
        if (m) this.placeMedia(m, this.fits(lane?.dataset.track, m), at);
      }
    });
    this.root.querySelector('.cut-bin').addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    this.root.querySelector('.cut-bin').addEventListener('drop', async (e) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      for (const f of e.dataTransfer.files) { const p = window.bdsShell?.pathForFile?.(f); if (p) await this.importPath(p); }
    });
    // chroma key eyedropper: click the preview
    this.canvas.addEventListener('click', (e) => {
      if (!this.picking) return;
      const r = this.canvas.getBoundingClientRect();
      const px = this.ctx2dRaw.getImageData(Math.round(((e.clientX - r.left) / r.width) * this.canvas.width), Math.round(((e.clientY - r.top) / r.height) * this.canvas.height), 1, 1).data;
      const hex = '#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      const s = this.selected;
      this.picking = false;
      this.canvas.classList.remove('picking');
      if (!s) return;
      this.remember();
      s.c.key = { ...(s.c.key || { tolerance: 40, softness: 20, spill: 50 }), on: true, color: hex };
      this.renderProps();
      this.draw();
    });
    this.keyHandler = (e) => this.onKey(e);
    document.addEventListener('keydown', this.keyHandler);
    this.ro = new ResizeObserver(() => this.fitCanvas());
    this.ro.observe(this.root.querySelector('.cut-view'));
  }

  /** The track a dropped item lands on: the lane under the pointer if it's the right kind. */
  fits(trackId, m) {
    const tr = this.p.tracks.find((t) => t.id === trackId);
    const kind = m.kind === 'audio' ? 'audio' : 'video';
    return tr && tr.kind === kind ? tr.id : null;
  }

  fitCanvas() {
    const view = this.root.querySelector('.cut-view');
    const r = view.getBoundingClientRect();
    const k = Math.min((r.width - 16) / this.p.width, (r.height - 16) / this.p.height);
    // preview renders at most ~960 px wide so chroma key and compositing stay quick
    const scale = Math.min(1, 960 / this.p.width);
    this.canvas.width = Math.round(this.p.width * scale);
    this.canvas.height = Math.round(this.p.height * scale);
    this.canvas.style.width = `${Math.max(40, Math.floor(this.p.width * k))}px`;
    this.canvas.style.height = `${Math.max(24, Math.floor(this.p.height * k))}px`;
    this.ctx2dRaw = this.ctx2d;
    this.draw();
  }

  renderAll() { this.renderBin(); this.renderTimeline(); this.renderProps(); this.fitCanvas(); this.refreshStatus(); }

  renderBin() {
    clear(this.bin);
    if (!this.p.media.length) {
      this.bin.append(h('div', { class: 'cut-empty' }, 'Add videos, music and pictures with ', h('b', {}, '+'), ', or drop them here. Then drag them onto the timeline.'));
      return;
    }
    for (const m of this.p.media) {
      const state = m.preparing ? `preparing${typeof m.preparing === 'number' ? ` ${m.preparing}%` : '…'}` : m.missing ? 'missing' : m.bad ? 'can’t play' : null;
      const row = h('div', { class: `cut-media ${m.missing || m.bad ? 'missing' : ''}`, draggable: 'true', title: `${m.path}${m.missing ? '\n(file not found — right-click to find it)' : ''}${m.proxy ? '\n(using an editing copy)' : ''}\nDrag onto the timeline · double-click to add at the playhead` },
        h('span', { class: `cut-media-ic ${m.kind}` }, icon(m.kind === 'video' ? 'video' : m.kind === 'audio' ? 'music' : 'image', 'sm')),
        h('span', { class: 'cut-media-name' }, m.name),
        h('span', { class: 'mono faint cut-media-len' }, state || (m.kind === 'image' ? `${m.w}×${m.h}` : fmtTime(m.duration, false))));
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/bds-media', m.id); e.dataTransfer.effectAllowed = 'copy'; });
      row.addEventListener('dblclick', () => this.placeMedia(m));
      row.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Add at the playhead', icon: 'plus', action: () => this.placeMedia(m) },
        { label: m.missing ? 'Find the file…' : 'Point at a different file…', icon: 'folder-open', action: () => this.relink(m) },
        { label: 'Show in folder', icon: 'external', action: () => api.reveal(m.path) },
        { sep: true },
        { label: 'Remove from project', icon: 'trash', action: () => {
          const used = this.allClips().filter(({ c }) => c.media === m.id).length;
          this.remember();
          for (const tr of this.p.tracks) tr.clips = tr.clips.filter((c) => c.media !== m.id);
          this.p.media = this.p.media.filter((x) => x !== m);
          if (this.sel && !this.clip(this.sel)) this.sel = null;
          if (used) toast(`Removed it and its ${used} clip${used > 1 ? 's' : ''}`, { timeout: 1800 });
          this.renderAll();
        } },
      ]));
      this.bin.append(row);
    }
  }

  // =================================================================== timeline

  tToX(t) { return t * this.pps; }
  xToT(clientX) { const r = this.lanes.getBoundingClientRect(); return (clientX - r.left) / this.pps; }

  zoom(dir, clientX = null) {
    const anchorT = clientX != null ? this.xToT(clientX) : this.t;
    const before = this.tToX(anchorT) - this.tlScroll.scrollLeft;
    this.pps = clamp(this.pps * (dir > 0 ? 1.25 : 0.8), 4, 600);
    this.renderTimeline();
    this.tlScroll.scrollLeft = this.tToX(anchorT) - before;
  }

  renderTimeline() {
    const ids = new Set(this.allClips().map(({ c }) => c.id));
    for (const [k, el] of this.els) if (el.pause && !ids.has(k)) { el.pause(); el.removeAttribute('src'); el.load(); this.els.delete(k); }
    const total = this.duration + 10;
    const W = this.tToX(total);
    this.tlInner.style.width = `${W}px`;
    // ruler: a tick every 1, 2, 5, 10 … seconds depending on zoom
    clear(this.ruler);
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * this.pps >= 70) || 600;
    for (let s = 0; s <= total; s += step) this.ruler.append(h('span', { class: 'cut-tick', style: { left: `${this.tToX(s)}px` } }, fmtTime(s, false)));
    clear(this.lanes);
    clear(this.tlHead);
    this.tlHead.append(h('div', { class: 'cut-head-ruler' }));
    for (const tr of this.p.tracks) {
      this.tlHead.append(h('div', { class: `cut-head ${tr.kind}` },
        h('span', { class: 'cut-head-name' }, icon(tr.kind === 'video' ? 'video' : 'music', 'sm'), tr.name),
        h('button', { class: `icon-btn ${tr.muted ? 'on' : ''}`, 'data-tip': tr.kind === 'video' ? 'Hide this track' : 'Mute this track', onclick: () => { this.remember(); tr.muted = !tr.muted; this.renderTimeline(); this.draw(); } }, icon(tr.kind === 'video' ? (tr.muted ? 'eye-off' : 'eye') : tr.muted ? 'volume-x' : 'volume', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Remove track', onclick: () => this.removeTrack(tr) }, icon('x', 'sm'))));
      const lane = h('div', { class: `cut-lane ${tr.kind} ${tr.muted ? 'muted' : ''}`, dataset: { track: tr.id } });
      for (const c of tr.clips) lane.append(this.clipEl(c, tr));
      this.lanes.append(lane);
    }
    this.placePlayhead();
  }

  clipEl(c, tr) {
    const m = this.media(c.media);
    const on = c.id === this.sel;
    const el = h('div', { class: `cut-clip ${m?.kind || 'missing'} ${on ? 'on' : ''} ${c.key?.on ? 'keyed' : ''}`, style: { left: `${this.tToX(c.start)}px`, width: `${Math.max(4, this.tToX(c.len))}px` }, title: `${m?.name || 'missing media'} · ${fmtTime(c.len)}` },
      h('span', { class: 'cut-clip-name' }, m?.name || 'missing'),
      h('span', { class: 'cut-trim l' }), h('span', { class: 'cut-trim r' }));
    if (m?.kind === 'image' && !m.missing) el.style.backgroundImage = `linear-gradient(90deg, rgba(0,0,0,.55), rgba(0,0,0,.25)), url("${srcOf(m)}")`;
    // keyframe diamonds of the selected clip
    if (on) {
      const times = [...new Set(Object.values(c.keys || {}).flat().map((k) => Math.round(k.t * 1000) / 1000))];
      for (const kt of times) {
        const d = h('span', { class: 'cut-kf', title: `keyframe at ${fmtTime(kt)} — click to jump, drag to move`, style: { left: `${this.tToX(kt)}px` } });
        d.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.dragKey(e, c, kt, el); });
        el.append(d);
      }
    }
    el.addEventListener('pointerdown', (e) => this.dragClip(e, c, tr, el));
    el.addEventListener('contextmenu', (e) => {
      this.sel = c.id; this.renderTimeline(); this.renderProps();
      contextMenu(e, [
        { label: 'Split at the playhead', shortcut: 'S', action: () => this.split() },
        { label: 'Duplicate', action: () => { this.remember(); const d = JSON.parse(JSON.stringify(c)); d.id = uid('c'); d.start = c.start + c.len; tr.clips.push(d); this.sel = d.id; this.renderAll(); } },
        { sep: true },
        { label: 'Delete', icon: 'trash', shortcut: 'Del', action: () => this.deleteSelected() },
      ]);
    });
    return el;
  }

  /** Snap time t to clip edges / the playhead / 0 when it's within a few pixels. */
  snap(t, skip) {
    const pts = [0, this.t];
    for (const { c } of this.allClips()) if (c.id !== skip) pts.push(c.start, c.start + c.len);
    let best = t;
    let bd = SNAP_PX / this.pps;
    for (const p of pts) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  dragClip(e, c, tr, el) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const m = this.media(c.media);
    const mode = e.target.classList.contains('cut-trim') ? (e.target.classList.contains('l') ? 'left' : 'right') : 'move';
    const sx = e.clientX;
    const orig = { start: c.start, in: c.in, len: c.len };
    let moved = false;
    let curTrack = tr;
    this.sel = c.id;
    const maxLen = m && m.kind !== 'image' && m.duration ? m.duration : Infinity;
    const move = (ev) => {
      const dt = (ev.clientX - sx) / this.pps;
      if (!moved && Math.abs(ev.clientX - sx) < 3 && mode === 'move' && !ev.target.closest?.('.cut-lane:not([data-track="' + curTrack.id + '"])')) return;
      if (!moved) { moved = true; this.remember(); }
      if (mode === 'move') {
        let start = Math.max(0, orig.start + dt);
        const sEnd = this.snap(start + c.len, c.id) - c.len;
        const sStart = this.snap(start, c.id);
        start = Math.abs(sStart - start) <= Math.abs(sEnd - start) ? sStart : sEnd;
        c.start = Math.max(0, start);
        // move to another track of the same kind under the pointer
        const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.cut-lane');
        const target = lane && this.p.tracks.find((t) => t.id === lane.dataset.track);
        if (target && target !== curTrack && target.kind === curTrack.kind) {
          curTrack.clips = curTrack.clips.filter((x) => x !== c);
          target.clips.push(c);
          curTrack = target;
          lane.append(el);
        }
      } else if (mode === 'left') {
        let start = this.snap(orig.start + dt, c.id);
        start = clamp(start, Math.max(0, orig.start - (m?.kind === 'image' ? Infinity : orig.in)), orig.start + orig.len - MIN_LEN);
        const d = start - orig.start;
        c.start = start;
        c.len = orig.len - d;
        if (m?.kind !== 'image') c.in = Math.max(0, orig.in + d);
        // keep keyframes where they were on screen
        if (d) for (const keys of Object.values(c.keys || {})) for (const k of keys) k.t = (k._t0 ?? (k._t0 = k.t)) - d;
      } else {
        const end = this.snap(orig.start + orig.len + dt, c.id);
        c.len = clamp(end - orig.start, MIN_LEN, maxLen - (m?.kind === 'image' ? 0 : orig.in));
      }
      el.style.left = `${this.tToX(c.start)}px`;
      el.style.width = `${Math.max(4, this.tToX(c.len))}px`;
      this.requestUpdate();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      for (const keys of Object.values(c.keys || {})) for (const k of keys) delete k._t0;
      if (mode === 'left') for (const [p, keys] of Object.entries(c.keys || {})) c.keys[p] = keys.filter((k) => k.t >= -1e-6 && k.t <= c.len + 1e-6);
      this.renderTimeline();
      this.renderProps();
      this.refreshStatus();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    this.renderTimeline();
    this.renderProps();
  }

  dragKey(e, c, kt, clipEl) {
    const sx = e.clientX;
    let moved = false;
    const all = Object.values(c.keys || {}).flatMap((keys) => keys.filter((k) => Math.abs(k.t - kt) < 0.0006));
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - sx) < 3) return;
      if (!moved) { moved = true; this.remember(); }
      const nt = clamp(kt + (ev.clientX - sx) / this.pps, 0, c.len);
      for (const k of all) k.t = nt;
      this.t = c.start + nt;
      this.requestUpdate(false);
      this.placePlayhead();
      e.target.style.left = `${this.tToX(nt)}px`;
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (!moved) this.seek(c.start + kt);
      for (const keys of Object.values(c.keys || {})) keys.sort((a, b) => a.t - b.t);
      this.renderTimeline();
      this.renderProps();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    void clipEl;
  }

  scrub(e) {
    if (e.button !== 0) return;
    const go = (ev) => this.seek(Math.max(0, this.xToT(ev.clientX)));
    go(e);
    const up = () => { removeEventListener('pointermove', go); removeEventListener('pointerup', up); };
    addEventListener('pointermove', go);
    addEventListener('pointerup', up);
  }

  placePlayhead() {
    this.playhead.style.left = `${this.tToX(this.t)}px`;
    this.timeLabel.textContent = `${fmtTime(this.t)} / ${fmtTime(this.duration)}`;
  }

  seek(t) {
    this.t = Math.max(0, t);
    if (this.playing) this.syncMedia(true);
    this.placePlayhead();
    this.requestUpdate();
  }

  /** Coalesce redraws: scrubbing and dragging fire far more often than the screen refreshes. */
  requestUpdate(props = true) {
    this.needProps = this.needProps || props;
    if (this.updateRaf) return;
    this.updateRaf = requestAnimationFrame(() => {
      this.updateRaf = 0;
      if (this.needProps) this.renderProps();
      this.needProps = false;
      this.draw();
    });
  }

  // =================================================================== properties panel

  renderProps() {
    const P = clear(this.props);
    const s = this.selected;
    if (!s) return this.renderProjectProps(P);
    const { c } = s;
    const m = this.media(c.media);
    const local = clamp(this.t - c.start, 0, c.len);
    const inside = this.t >= c.start && this.t <= c.start + c.len;
    const num = (label, value, onSet, { step = 0.01, min = 0, unit = 's' } = {}) => {
      const inp = h('input', { type: 'number', step: String(step), value: String(Math.round(value * 100) / 100) });
      inp.addEventListener('change', () => { const v = Number(inp.value); if (Number.isFinite(v)) { this.remember(); onSet(Math.max(min, v)); this.renderAll(); } });
      return h('label', { class: 'cut-row' }, h('span', {}, label), inp, h('span', { class: 'faint' }, unit));
    };
    P.append(h('div', { class: 'cut-props-title' }, icon(m?.kind === 'audio' ? 'music' : m?.kind === 'image' ? 'image' : 'video', 'sm'), h('span', {}, m?.name || 'missing media')));
    P.append(h('div', { class: 'cut-group' }, h('h5', {}, 'Timing'),
      num('Start', c.start, (v) => { c.start = v; }),
      num('Length', c.len, (v) => { c.len = Math.max(MIN_LEN, m?.kind === 'image' ? v : Math.min(v, (m?.duration || v) - c.in)); }),
      m?.kind !== 'image' ? num('Starts at', c.in, (v) => { c.in = Math.min(v, Math.max(0, (m?.duration || v) - MIN_LEN)); c.len = Math.min(c.len, (m?.duration || Infinity) - c.in); }, { unit: 's in' }) : null));

    const propRow = (prop) => {
      const def = PROPS[prop];
      const keys = c.keys?.[prop] || [];
      const here = keys.some((k) => Math.abs(k.t - local) < 1 / (this.p.fps * 2));
      const inp = h('input', { type: 'number', step: String(def.step), value: String(Math.round(valueAt(c, prop, local) * 100) / 100) });
      inp.addEventListener('change', () => {
        let v = Number(inp.value);
        if (!Number.isFinite(v)) return;
        if (def.min != null) v = Math.max(def.min, v);
        if (def.max != null) v = Math.min(def.max, v);
        this.remember();
        this.setProp(c, prop, v);
        this.renderProps(); this.renderTimeline(); this.draw();
      });
      // drag the label left/right to scrub the value
      const lab = h('span', { class: 'cut-scrubber', title: 'Drag sideways to change' }, def.label);
      lab.addEventListener('pointerdown', (e) => {
        const sx = e.clientX;
        const v0 = valueAt(c, prop, local);
        let first = true;
        const mv = (ev) => {
          if (first) { this.remember(); first = false; }
          let v = v0 + (ev.clientX - sx) * def.step * (ev.shiftKey ? 10 : 1);
          if (def.min != null) v = Math.max(def.min, v);
          if (def.max != null) v = Math.min(def.max, v);
          this.setProp(c, prop, Math.round(v * 100) / 100);
          inp.value = String(Math.round(v * 100) / 100);
          this.requestUpdate(false);
        };
        const upf = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', upf); this.renderTimeline(); };
        addEventListener('pointermove', mv);
        addEventListener('pointerup', upf);
      });
      const kb = h('button', { class: `cut-keybtn ${here ? 'here' : keys.length ? 'has' : ''}`, disabled: !inside, title: here ? 'Remove the keyframe here' : keys.length ? 'Add a keyframe here' : 'Animate: add a keyframe at the playhead' }, '◆');
      kb.addEventListener('click', () => this.toggleKey(c, prop));
      const row = h('div', { class: 'cut-row' }, lab, inp, h('span', { class: 'faint' }, def.unit), kb);
      row.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: `Reset ${def.label.toLowerCase()}`, action: () => { this.remember(); delete c.keys?.[prop]; delete c.props?.[prop]; this.renderProps(); this.renderTimeline(); this.draw(); } },
        { label: 'Remove all its keyframes', disabled: !keys.length, action: () => { this.remember(); c.props = c.props || {}; c.props[prop] = valueAt(c, prop, local); delete c.keys[prop]; this.renderProps(); this.renderTimeline(); this.draw(); } },
      ]));
      return row;
    };

    if (m?.kind !== 'audio') {
      P.append(h('div', { class: 'cut-group' }, h('h5', {}, 'Transform', h('span', { class: 'faint' }, ' · ◆ = keyframe at the playhead')), ...VISUAL.map(propRow)));
      // chroma key
      const k = c.key || { on: false, color: '#00ff00', tolerance: 40, softness: 20, spill: 50 };
      const setK = (patch) => { this.remember(); c.key = { ...k, ...patch }; this.renderProps(); this.renderTimeline(); this.draw(); };
      const color = h('input', { type: 'color', value: k.color });
      color.addEventListener('change', () => setK({ color: color.value, on: true }));
      const slider = (label, field, max = 100) => {
        const r = h('input', { type: 'range', min: '0', max: String(max), value: String(k[field] ?? 0) });
        const v = h('span', { class: 'mono faint' }, String(k[field] ?? 0));
        r.addEventListener('input', () => { c.key = { ...k, [field]: Number(r.value) }; v.textContent = r.value; this.requestUpdate(false); });
        r.addEventListener('change', () => { k[field] = Number(r.value); setK({ [field]: Number(r.value) }); });
        return h('label', { class: 'cut-row' }, h('span', {}, label), r, v);
      };
      const onBox = h('input', { type: 'checkbox', checked: !!k.on });
      onBox.addEventListener('change', () => setK({ on: onBox.checked }));
      P.append(h('div', { class: 'cut-group' }, h('h5', {}, 'Chroma key'),
        h('label', { class: 'check' }, onBox, 'Remove a colour (green screen)'),
        h('div', { class: 'cut-row' }, h('span', {}, 'Colour'), color,
          h('button', { class: `btn sm ${this.picking ? 'primary' : ''}`, title: 'Click the colour in the preview', onclick: () => { this.picking = !this.picking; this.canvas.classList.toggle('picking', this.picking); this.renderProps(); } }, icon('pipette', 'sm'), this.picking ? 'Click the preview…' : 'Pick')),
        slider('Tolerance', 'tolerance', 150), slider('Softness', 'softness', 100), slider('Spill', 'spill', 100)));
    }
    if (m?.kind !== 'image') {
      const muteBox = h('input', { type: 'checkbox', checked: !!c.mute });
      muteBox.addEventListener('change', () => { this.remember(); c.mute = muteBox.checked; this.draw(); });
      P.append(h('div', { class: 'cut-group' }, h('h5', {}, 'Audio'), propRow('volume'),
        m?.kind === 'video' ? h('label', { class: 'check' }, muteBox, 'Mute this clip’s sound') : null));
    }
    P.append(h('div', { class: 'cut-actions' },
      h('button', { class: 'btn sm', onclick: () => this.split() }, 'Split (S)'),
      h('button', { class: 'btn sm ghost', onclick: () => this.deleteSelected() }, icon('trash', 'sm'), 'Delete')));
  }

  renderProjectProps(P) {
    const p = this.p;
    const preset = h('select', {}, [h('option', { value: '' }, 'Custom'), ...PRESETS.map(([l, w, hh]) => h('option', { value: `${w}x${hh}` }, l))]);
    preset.value = PRESETS.some(([, w, hh]) => w === p.width && hh === p.height) ? `${p.width}x${p.height}` : '';
    preset.addEventListener('change', () => { if (!preset.value) return; const [w, hh] = preset.value.split('x').map(Number); this.remember(); p.width = w; p.height = hh; this.renderAll(); });
    const fps = h('select', {}, [24, 25, 30, 50, 60].map((n) => h('option', { value: String(n) }, `${n} fps`)));
    fps.value = String(p.fps);
    fps.addEventListener('change', () => { this.remember(); p.fps = Number(fps.value); this.refreshStatus(); });
    const bg = h('input', { type: 'color', value: p.background || '#000000' });
    bg.addEventListener('change', () => { this.remember(); p.background = bg.value; this.draw(); });
    P.append(h('div', { class: 'cut-props-title' }, icon('video', 'sm'), h('span', {}, 'Project')),
      h('div', { class: 'cut-group' }, h('h5', {}, 'Video'),
        h('label', { class: 'cut-row' }, h('span', {}, 'Size'), preset),
        h('label', { class: 'cut-row' }, h('span', {}, 'Frame rate'), fps),
        h('label', { class: 'cut-row' }, h('span', {}, 'Background'), bg)),
      h('div', { class: 'cut-empty' }, 'Click a clip on the timeline to change its timing, position, size, rotation, opacity, volume or chroma key. Press ◆ next to a value to animate it from the playhead.'),
      h('div', { class: 'cut-actions' }, h('button', { class: 'btn primary', onclick: () => this.exportVideo() }, icon('download', 'sm'), 'Export MP4…')));
  }

  // =================================================================== preview

  /** Draw the frame at time t on ctx (W×H). getEl(clip, media) returns the element to draw from. */
  composite(ctx, W, H, t, getEl) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.p.background || '#000';
    ctx.fillRect(0, 0, W, H);
    const k = W / this.p.width; // preview is drawn smaller than the real size
    const videoTracks = this.p.tracks.filter((tr) => tr.kind === 'video' && !tr.muted).reverse(); // bottom first
    for (const tr of videoTracks) {
      for (const c of tr.clips) {
        if (t < c.start || t >= c.start + c.len) continue;
        const m = this.media(c.media);
        const el = m && getEl(c, m);
        if (!el) continue;
        const sw = m.kind === 'image' ? el.naturalWidth : el.videoWidth;
        const sh = m.kind === 'image' ? el.naturalHeight : el.videoHeight;
        if (!sw || !sh) continue;
        const lt = t - c.start;
        const fit = Math.min(this.p.width / sw, this.p.height / sh); // fit inside the frame at 100 %
        const scale = (valueAt(c, 'scale', lt) / 100) * fit * k;
        const dw = sw * scale;
        const dh = sh * scale;
        ctx.save();
        ctx.globalAlpha = clamp(valueAt(c, 'opacity', lt) / 100, 0, 1);
        ctx.translate(W / 2 + valueAt(c, 'x', lt) * k, H / 2 + valueAt(c, 'y', lt) * k);
        ctx.rotate((valueAt(c, 'rotation', lt) * Math.PI) / 180);
        const keyed = c.key?.on ? (this.glkey || (this.glkey = new GLKey())).run(el, Math.max(1, Math.round(dw)), Math.max(1, Math.round(dh)), c.key) : null;
        if (keyed) ctx.drawImage(keyed, -dw / 2, -dh / 2, dw, dh);
        else if (c.key?.on) {
          // no WebGL: key the clip on its own canvas first (slower), then place it
          const sc = this.scratch;
          sc.width = Math.max(1, Math.round(dw));
          sc.height = Math.max(1, Math.round(dh));
          const sctx = sc.getContext('2d', { willReadFrequently: true });
          sctx.drawImage(el, 0, 0, sc.width, sc.height);
          chromaKey(sctx, sc.width, sc.height, c.key);
          ctx.drawImage(sc, -dw / 2, -dh / 2, dw, dh);
        } else ctx.drawImage(el, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  /** The preview element for a clip: one <video>/<audio> per clip (so the same file can be in twice), one <img> per picture. */
  elFor(c, m) {
    if (m.kind === 'image') return this.els.get(m.id);
    let el = this.els.get(c.id);
    if (!el || el.dataset.src !== m.path) {
      el = document.createElement(m.kind === 'video' ? 'video' : 'audio');
      el.preload = 'auto';
      el.dataset.src = m.path;
      el.src = srcOf(m);
      el.addEventListener('seeked', () => { if (!this.playing) this.draw(); });
      el.addEventListener('loadeddata', () => { if (!this.playing) this.draw(); });
      this.els.set(c.id, el);
    }
    return el;
  }

  draw() {
    if (!this.canvas.width) return;
    if (!this.playing) {
      // paused: put every visible clip's video on the right frame (drawn again when the seek lands)
      for (const { c, tr } of this.allClips()) {
        if (tr.kind !== 'video' || this.t < c.start || this.t >= c.start + c.len) continue;
        const m = this.media(c.media);
        if (m?.kind !== 'video') continue;
        const el = this.elFor(c, m);
        const want = c.in + (this.t - c.start);
        if (Math.abs(el.currentTime - want) > 0.02) el.currentTime = want;
      }
    }
    this.composite(this.ctx2d, this.canvas.width, this.canvas.height, this.t, (c, m) => {
      const el = this.elFor(c, m);
      return m.kind === 'image' ? el : el.readyState >= 2 ? el : null;
    });
  }

  // =================================================================== playback

  togglePlay() { if (this.playing) this.pause(); else this.play(); }

  play() {
    if (this.t >= this.duration - 0.01) this.t = 0;
    this.playing = true;
    clear(this.playBtn).append(icon('pause-bars'));
    this.clock0 = performance.now() - this.t * 1000;
    this.syncMedia(true);
    const loop = () => {
      if (!this.playing) return;
      this.t = (performance.now() - this.clock0) / 1000;
      if (this.t >= this.duration) { this.t = this.duration; this.pause(); this.placePlayhead(); return; }
      this.syncMedia(false);
      this.composite(this.ctx2d, this.canvas.width, this.canvas.height, this.t, (c, m) => { const el = this.elFor(c, m); return m.kind === 'image' ? el : el.readyState >= 2 ? el : null; });
      this.placePlayhead();
      // keep the playhead in view
      const x = this.tToX(this.t) - this.tlScroll.scrollLeft;
      if (x > this.tlScroll.clientWidth - 40) this.tlScroll.scrollLeft += this.tlScroll.clientWidth * 0.6;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const el of this.els.values()) if (el.pause) el.pause();
    clear(this.playBtn).append(icon('play'));
    this.renderProps();
    this.draw();
  }

  /** While playing: run every clip that's on now in step with the clock; pause the rest. */
  syncMedia(force) {
    const live = new Set();
    for (const { c, tr } of this.allClips()) {
      const m = this.media(c.media);
      if (!m || m.kind === 'image' || this.t < c.start || this.t >= c.start + c.len) continue;
      if (tr.kind === 'video' && m.kind !== 'video') continue;
      const el = this.elFor(c, m);
      live.add(el);
      const want = c.in + (this.t - c.start);
      if (force || Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
      const vol = (tr.muted || c.mute) ? 0 : clamp(valueAt(c, 'volume', this.t - c.start) / 100, 0, 1);
      el.volume = vol;
      el.muted = vol === 0;
      if (el.paused) el.play().catch(() => {});
    }
    for (const el of this.els.values()) if (el.pause && !live.has(el) && !el.paused) el.pause();
  }

  // =================================================================== export

  /** target: a path to export to without asking (the export dialog is skipped). */
  async exportVideo(target = null) {
    if (this.exporting) return;
    if (!this.allClips().length) return toast('Put something on the timeline first.', { type: 'warn' });
    const tools = await fetch('/api/tools', { headers: { 'X-BDS-Token': api.token } }).then((r) => r.json()).catch(() => ({}));
    if (!tools.ffmpeg) return toast('Exporting needs ffmpeg: run "winget install Gyan.FFmpeg", then restart Box-DocSpitter.', { type: 'warn', timeout: 8000 });
    const base = this.tab.path ? stripExt(basename(this.tab.path)) : stripExt(this.tab.title);
    const res = target ? { path: target } : await pickSave({ defaultName: `${base}.mp4`, initialDir: this.tab.path ? dirname(this.tab.path) : undefined, filters: [{ name: 'MP4 video', extensions: ['mp4'] }], title: 'Export video' });
    if (!res) return;
    let out = res.path;
    if (extOf(out) !== 'mp4') out += '.mp4';
    this.pause();
    const { width: W, height: H, fps } = this.p;
    const dur = this.duration;
    const frames = Math.ceil(dur * fps);
    let cancelled = false;
    const bar = h('div', { class: 'vid-progress' }, h('div', { class: 'vid-progress-bar' }));
    const label = h('div', { class: 'dim' }, 'Getting ready…');
    let id = null;
    const ctxModal = { close: () => {} };
    modal({ title: 'Exporting video', body: h('div', { class: 'col', style: { gap: '10px', minWidth: '320px' } }, label, bar),
      buttons: [{ label: 'Cancel', value: null, ghost: true, onClick: () => { cancelled = true; return null; } }],
      onOpen: (c) => { ctxModal.close = c.close; } }).then(() => { cancelled = true; });
    this.exporting = true;
    const post = (url, body, json = true) => fetch(url, { method: 'POST', headers: { 'X-BDS-Token': api.token, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(body) : body })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Export failed'); return d; });
    const els = new Map();
    try {
      const missing = this.p.media.filter((m) => (m.missing || m.bad) && this.allClips().some(({ c }) => c.media === m.id));
      if (missing.length && !target) toast(`Leaving out ${missing.length} missing file${missing.length > 1 ? 's' : ''}: ${missing.map((m) => m.name).join(', ')}`, { type: 'warn', timeout: 6000 });
      ({ id } = await post('/api/render/start', { width: W, height: H, fps, duration: dur, output: out, inputs: this.p.media.flatMap((m) => [m.path, m.proxy].filter(Boolean)) }));
      // 1) the soundtrack, mixed offline
      label.textContent = 'Mixing the sound…';
      const wav = await this.mixAudio(dur);
      if (cancelled) throw new Error('cancelled');
      if (wav) await post(`/api/render/audio?id=${id}`, wav, false);
      // 2) every frame, drawn at full size and sent as JPEG
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const cx = cv.getContext('2d');
      const getEl = (c, m) => {
        if (m.kind === 'image') return this.els.get(m.id);
        return els.get(c.id);
      };
      const seekAll = async (t) => {
        const waits = [];
        for (const { c, tr } of this.allClips()) {
          if (tr.kind !== 'video' || tr.muted || t < c.start || t >= c.start + c.len) continue;
          const m = this.media(c.media);
          if (m?.kind !== 'video') continue;
          let el = els.get(c.id);
          if (!el) {
            el = document.createElement('video');
            el.muted = true;
            el.preload = 'auto';
            el.src = srcOf(m);
            els.set(c.id, el);
            await new Promise((r) => { el.onloadeddata = r; el.onerror = r; setTimeout(r, 15000); });
          }
          const want = Math.min(c.in + (t - c.start), (m.duration || Infinity) - 0.001);
          if (Math.abs(el.currentTime - want) > 1 / (fps * 4)) {
            waits.push(new Promise((r) => { const done = () => { el.removeEventListener('seeked', done); r(); }; el.addEventListener('seeked', done); setTimeout(done, 4000); }));
            el.currentTime = want;
          }
        }
        await Promise.all(waits);
      };
      // Pipeline: while a frame is being JPEG-encoded and uploaded, the next one is already being seeked and
      // drawn. Uploads go out in order, at most two at a time, so ffmpeg always gets frames in sequence.
      let batch = [];
      let upload = Promise.resolve();
      let inflight = 0;
      const send = (blobs) => {
        inflight++;
        const prev = upload;
        upload = (async () => {
          const parts = await Promise.all(blobs);
          await prev;
          const body = new Blob(parts);
          const r = await fetch(`/api/render/frames?id=${id}&n=${parts.length}`, { method: 'POST', headers: { 'X-BDS-Token': api.token }, body });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Export failed');
        })().finally(() => { inflight--; });
        upload.catch(() => {});
      };
      const flush = async () => { if (batch.length) { send(batch); batch = []; } };
      const started = performance.now();
      for (let f = 0; f < frames; f++) {
        if (cancelled) throw new Error('cancelled');
        const t = f / fps;
        await seekAll(t);
        this.composite(cx, W, H, t, getEl);
        // toBlob takes the picture now and encodes in the background; the loop moves on
        batch.push(new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92)));
        if (batch.length >= 8) { await flush(); while (inflight > 2) await upload.catch(() => {}); }
        // decoders of clips that are over can go
        for (const { c } of this.allClips()) if (t >= c.start + c.len && els.has(c.id)) { const el = els.get(c.id); el.removeAttribute('src'); el.load(); els.delete(c.id); }
        if (f % 5 === 0) {
          const pct = f / frames;
          const left = pct > 0.02 ? ((performance.now() - started) / pct) * (1 - pct) / 1000 : null;
          bar.firstChild.style.width = `${Math.round(pct * 100)}%`;
          label.textContent = `Frame ${f + 1} of ${frames}${left != null ? ` · about ${fmtTime(left, false)} left` : ''}`;
        }
      }
      await flush();
      await upload;
      label.textContent = 'Finishing…';
      await post('/api/render/finish', { id });
      id = null;
      ctxModal.close(true);
      toast(`Exported ${basename(out)}`, { type: 'ok', timeout: 8000, action: { label: 'Open', fn: () => this.app.openPath(out) } });
    } catch (e) {
      if (id) await post('/api/render/cancel', { id }).catch(() => {});
      ctxModal.close(null);
      if (e.message !== 'cancelled') errorToast(e, 'Export failed');
    } finally {
      for (const el of els.values()) { el.removeAttribute('src'); el.load(); }
      this.exporting = false;
    }
  }

  /** Every audible clip mixed into one soundtrack (volume keyframes included). Null if there's no sound. */
  async mixAudio(dur) {
    const clips = this.allClips().filter(({ c, tr }) => {
      const m = this.media(c.media);
      return m && m.kind !== 'image' && !tr.muted && !c.mute;
    });
    if (!clips.length) return null;
    const rate = 48000;
    const ctx = new OfflineAudioContext(2, Math.ceil(dur * rate), rate);
    const decoded = new Map();
    let any = false;
    for (const { c } of clips) {
      const m = this.media(c.media);
      if (!decoded.has(m.id)) {
        let buf = null;
        // plain audio files decode directly; videos (and anything that fails) go through ffmpeg as a WAV,
        // so a long video's picture data never has to be loaded into memory
        if (m.kind === 'audio') { try { buf = await ctx.decodeAudioData(await fetch(srcOf(m)).then((r) => r.arrayBuffer())); } catch { buf = null; } }
        if (!buf) {
          try {
            const { path: wavPath } = await postJSON('/api/render/extract-audio', { path: m.path });
            if (wavPath) buf = await ctx.decodeAudioData(await fetch(stream(wavPath)).then((r) => r.arrayBuffer()));
          } catch { buf = null; }
        }
        decoded.set(m.id, buf); // null: no sound in it
      }
      const buf = decoded.get(m.id);
      if (!buf) continue;
      any = true;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      const keys = c.keys?.volume;
      if (keys?.length) {
        g.gain.setValueAtTime(valueAt(c, 'volume', 0) / 100, c.start);
        for (const k of keys) g.gain.linearRampToValueAtTime(k.v / 100, c.start + k.t);
      } else g.gain.value = valueAt(c, 'volume', 0) / 100;
      src.connect(g).connect(ctx.destination);
      src.start(c.start, c.in, c.len);
    }
    if (!any) return null;
    return wavFrom(await ctx.startRendering());
  }

  // =================================================================== keys, saving, status

  onKey(e) {
    if (this.app.active !== this.tab || this.exporting) return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || document.querySelector('.modal-backdrop')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); return this.undo(); }
    if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); return this.redo(); }
    if (ctrl || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); return this.togglePlay(); }
    if (e.key.toLowerCase() === 's') { e.preventDefault(); return this.split(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return this.deleteSelected(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); return this.seek(this.t - (e.shiftKey ? 1 : 1 / this.p.fps)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); return this.seek(this.t + (e.shiftKey ? 1 : 1 / this.p.fps)); }
    if (e.key === 'Home') { e.preventDefault(); return this.seek(0); }
    if (e.key === 'End') { e.preventDefault(); return this.seek(this.duration); }
    if (e.key === 'Escape' && this.picking) { this.picking = false; this.canvas.classList.remove('picking'); this.renderProps(); }
  }

  buildToolbar() {
    return h('div', { class: 'toolbar' },
      tbButton('undo', 'Undo (Ctrl+Z)', () => this.undo()),
      tbButton('redo', 'Redo (Ctrl+Y)', () => this.redo()),
      tbSep(),
      tbButton('plus', 'Add media', () => this.importDialog(), { text: 'Add media' }),
      tbButton('image', 'From the image dump', () => this.fromImageDump()),
      tbSep(),
      tbButton('scissors', 'Split at the playhead (S)', () => this.split(), { text: 'Split' }),
      tbButton('trash', 'Delete the selected clip (Del)', () => this.deleteSelected()),
      h('div', { class: 'grow' }),
      tbButton('download', 'Export MP4', () => this.exportVideo(), { text: 'Export MP4', cls: 'tb-primary' }));
  }

  status() {
    return {
      left: [{ text: this.app.toolName('Video editor'), icon: 'video' }, { text: `${this.p.width}×${this.p.height} · ${this.p.fps} fps` }],
      right: [{ text: `${this.allClips().length} clips · ${fmtTime(this.duration, false)}` }],
    };
  }

  saveFormats() { return [{ ext: 'boxcut', name: 'Video editor project' }]; }
  async serialize() {
    const clean = JSON.parse(JSON.stringify(this.p));
    for (const m of clean.media) delete m.missing;
    return JSON.stringify(clean, null, 1);
  }
  getDraft() { return JSON.stringify(this.p); }
  restoreDraft(content) { try { this.p = JSON.parse(content); for (const m of this.p.media) this.probe(m); this.renderAll(); } catch { /* ignore */ } }

  onHide() { if (this.playing) this.pause(); }
  destroy() {
    this.pause();
    document.removeEventListener('keydown', this.keyHandler);
    this.ro?.disconnect();
    for (const el of this.els.values()) { if (el.pause) { el.pause(); el.removeAttribute('src'); el.load(); } }
  }
}

