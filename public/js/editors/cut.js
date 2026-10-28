// Video editor: a small multi-track editor. Video and audio tracks, images on the timeline (drag the edge to
// change how long they show), keyframes for position / scale / rotation / opacity / volume, chroma key, a
// properties panel for the selected clip, and frame-exact MP4 export through the PC's ffmpeg.
// Projects are saved as .boxcut (JSON) and use media files where they are on disk.
// The media panel has a second tab, the media dump (Box-Deckspitter\media-dump): drag between it, the media
// list and the timeline; files from the Files / BoxSpaces / recents panels come in by Shift+drag.

import { BaseEditor } from './base.js';
import { h, clear, clamp, basename, extOf, stripExt, uid, dirname, formatBytes, fileManager } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { tbButton, tbSep, toast, errorToast, contextMenu, modal, promptDialog, hoverKeys, PATHS_MIME, draggedPaths, setDraggedPaths, popover } from '../core/ui.js';
import { api } from '../core/api.js';
import { pickOpen, pickSave } from '../core/files.js';
import { watchFolders } from '../core/watch.js';
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
  volume: { label: 'Volume', def: 100, step: 1, min: 0, max: 200, unit: '%', slider: true }, // slider: one pops out under the box
};
const VISUAL = ['x', 'y', 'scale', 'rotation', 'opacity'];
const IMAGE_LEN = 5;
const MIN_LEN = 0.1;
const SNAP_PX = 8;
const PRESETS = [['1920 × 1080 (HD)', 1920, 1080], ['1280 × 720', 1280, 720], ['2560 × 1440 (1440p)', 2560, 1440], ['3840 × 2160 (4K)', 3840, 2160], ['1080 × 1920 (vertical)', 1080, 1920], ['1080 × 1080 (square)', 1080, 1080]];

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
    this.extra = new Set(); // more selected clips (Ctrl+click), besides `sel`
    this.sel = null; // selected clip id (the one the properties panel shows)
    this.undoStack = [];
    this.redoStack = [];
    this.els = new Map(); // preview media elements: clip id → <video>/<audio>; media id → <img>
    this.build();
    for (const m of this.p.media) this.probe(m);
    for (const p of opts.media || []) await this.importPath(p, { place: opts.place !== false });
    this.renderAll();
  }

  // =================================================================== model helpers

  media(id) { return this.p.media.find((m) => m.id === id); }
  allClips() { return this.p.tracks.flatMap((tr) => tr.clips.map((c) => ({ c, tr }))); }
  clip(id) { for (const tr of this.p.tracks) { const c = tr.clips.find((x) => x.id === id); if (c) return { c, tr }; } return null; }
  get duration() { return Math.max(1, ...this.allClips().map(({ c }) => c.start + c.len)); }
  get selected() { return this.sel ? this.clip(this.sel) : null; }
  // choosing one clip drops the rest of a Ctrl+click selection
  get sel() { return this._sel; }
  set sel(id) { this._sel = id; this.extra?.clear(); }
  isPicked(id) { return id != null && (id === this._sel || this.extra.has(id)); }
  /** Every selected clip that still exists. */
  picked() { return [this._sel, ...this.extra].map((id) => id && this.clip(id)).filter(Boolean); }
  /** Ctrl+click: add a clip to the selection, or take it out. */
  togglePick(id) {
    if (!this.isPicked(id)) { if (this._sel) this.extra.add(this._sel); this._sel = id; return; }
    if (id !== this._sel) { this.extra.delete(id); return; }
    const next = [...this.extra][0] ?? null;
    this.extra.delete(next);
    this._sel = next;
  }
  /** A video's picture and its sound are two clips that go together (same `link`): the other one, or null. */
  partner(c) { return c.link ? this.allClips().find((x) => x.c.link === c.link && x.c !== c) || null : null; }

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

  /** Files into the media list (from the file panels, the app's "Add to the video editor"…). How many went in. */
  async addPaths(paths) {
    let n = 0;
    for (const p of paths) if (kindOf(p) && (await this.importPath(p))) n++;
    if (n) this.showBin('project');
    return n;
  }
  receiveFiles(paths) { return this.addPaths(paths); }

  /** Several files dropped on the timeline at `at`: one after another on fitting tracks. */
  async placePaths(paths, trackId, at) {
    let t = at;
    for (const p of paths) {
      if (!kindOf(p)) continue;
      const m = await this.importPath(p);
      if (m) { const c = this.placeMedia(m, this.fits(trackId, m), t); t = c.start + c.len; }
    }
  }

  // =================================================================== media dump

  showBin(view) {
    this.binView = view;
    const dump = view === 'dump';
    this.bin.hidden = dump;
    this.dumpView.hidden = !dump;
    this.tabProject.classList.toggle('on', !dump);
    this.tabDump.classList.toggle('on', dump);
    this.projActions.hidden = dump;
    this.dumpActions.hidden = !dump;
    if (dump) this.refreshDump();
    // files added, removed or renamed in the media dump (by anything) show up by themselves while its tab is open
    if (dump) watchFolders(this, ['dump:media'], () => this.refreshDump(), () => this.pane.isConnected && !this.dumpActions.hidden);
  }

  /** The media dump tab: the folder that's open (dumpDir, '' = the top), its folders, then its files. */
  async refreshDump(force = false) {
    let res;
    try { res = await api.dump('media', this.dumpDir || ''); } catch {
      if (this.dumpDir) { this.dumpDir = ''; return this.refreshDump(true); } // the folder went away
      return;
    }
    const { folders = [], items = [] } = res;
    this.dumpCount.textContent = folders.length + items.length ? String(folders.length + items.length) : '';
    const sig = this.dumpDir + '#' + folders.map((f) => f.name + f.count).join('|') + '#' + items.map((i) => i.name + i.mtime).join('|');
    if (!force && sig === this.dumpSig) return;
    this.dumpSig = sig;
    this.dumpItems = items;
    const sub = this.dumpDir || '';
    const parts = sub ? sub.split('/') : [];
    // the path: click a part to go there, drop on it to move things there
    const crumbs = clear(this.dumpCrumbs);
    const crumb = (text, to) => {
      const b = h('button', { class: `cut-dump-crumb cut-dump-target ${to === sub ? 'here' : ''}`, dataset: { folder: to }, onclick: () => this.openDumpFolder(to) }, text);
      this.dumpDropTarget(b, to);
      return b;
    };
    crumbs.append(crumb('media-dump', ''));
    parts.forEach((part, i) => crumbs.append(h('span', { class: 'faint' }, '/'), crumb(part, parts.slice(0, i + 1).join('/'))));
    const G = clear(this.dumpGrid);
    if (!folders.length && !items.length) {
      G.append(h('div', { class: 'cut-empty' }, sub ? 'Empty folder. Drop videos, sounds and pictures here.' : `The media dump is empty. Drop videos, sounds and pictures here — from ${fileManager()}, the media list, the timeline, or Shift+drag from Files — or export straight into it.`));
      return;
    }
    for (const f of folders) {
      const card = h('div', { class: 'cut-dump-item folder cut-dump-target', dataset: { folder: f.name }, title: `${f.base}\n${f.count} item${f.count === 1 ? '' : 's'}\nClick to open · drop things on it to put them inside` },
        h('div', { class: 'cut-dump-thumb' }, icon('folder', 'lg'), h('span', { class: 'cut-dump-badge mono' }, String(f.count))),
        h('div', { class: 'cut-dump-name' }, f.base));
      card.addEventListener('click', () => this.openDumpFolder(f.name));
      card.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Open', icon: 'folder-open', action: () => this.openDumpFolder(f.name) },
        { label: 'Rename…', icon: 'edit', action: async () => { const n = await promptDialog('Rename folder', 'New name', f.base); if (n && n !== f.base) { try { await api.dumpRename(f.name, n, 'media'); this.refreshDump(true); } catch (err) { errorToast(err); } } } },
        { label: `Show in ${fileManager()}`, icon: 'external', action: () => api.dumpReveal('media', f.name) },
        { sep: true },
        { label: 'Remove folder', icon: 'trash', action: async () => { try { await api.dumpRemove(f.name, 'media'); toast(`Moved ${f.base} to media-dump${BDS.sep}.removed`, { timeout: 2500 }); this.refreshDump(true); } catch (err) { errorToast(err); } } },
      ]));
      this.dumpDropTarget(card, f.name);
      G.append(card);
    }
    this.thumbIO?.disconnect();
    // video thumbnails load only when they scroll into view
    this.thumbIO = new IntersectionObserver((ents) => {
      for (const en of ents) if (en.isIntersecting && en.target.dataset.src) { en.target.src = en.target.dataset.src; delete en.target.dataset.src; this.thumbIO.unobserve(en.target); }
    }, { root: this.dumpView });
    for (const it of items) {
      const kind = it.type;
      let thumb;
      if (kind === 'image') thumb = h('img', { src: it.url, alt: '', loading: 'lazy', draggable: 'false' });
      else if (kind === 'video') {
        thumb = h('video', { muted: true, preload: 'metadata', draggable: 'false' });
        thumb.dataset.src = it.url.replace(/\?v=/, '?x=') + '#t=0.5';
        thumb.addEventListener('error', () => thumb.replaceWith(icon('video', 'lg')));
        this.thumbIO.observe(thumb);
      } else thumb = icon('music', 'lg');
      const card = h('div', { class: `cut-dump-item ${kind}`, draggable: 'true', title: `${it.base}\n${formatBytes(it.size)}\nDrag onto the timeline, the media list or a folder · double-click to add at the playhead` },
        h('div', { class: 'cut-dump-thumb' }, thumb, kind !== 'image' ? h('span', { class: 'cut-dump-badge' }, icon(kind === 'video' ? 'video' : 'music', 'sm')) : null),
        h('div', { class: 'cut-dump-name' }, it.base));
      card.addEventListener('dragstart', (e) => { setDraggedPaths(e, [it.path]); e.dataTransfer.setData('text/bds-from-dump', '1'); });
      card.addEventListener('dblclick', async () => { const m = await this.importPath(it.path); if (m) this.placeMedia(m); });
      card.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Add to the media list', icon: 'plus', action: () => this.importPath(it.path) },
        { label: 'Add at the playhead', icon: 'video', action: async () => { const m = await this.importPath(it.path); if (m) this.placeMedia(m); } },
        { sep: true },
        { label: 'Copy as file', icon: 'copy', action: () => api.dumpClip(it.name, 'media').then(() => toast(`Copied ${it.base}`, { type: 'ok', timeout: 1500 }), errorToast) },
        { label: 'Rename…', icon: 'edit', action: async () => { const n = await promptDialog('Rename', 'New name', it.base, { selectBase: true }); if (n && n !== it.base) { try { await api.dumpRename(it.name, extOf(n) ? n : `${n}.${extOf(it.base)}`, 'media'); this.refreshDump(true); } catch (err) { errorToast(err); } } } },
        { label: `Show in ${fileManager()}`, icon: 'external', action: () => api.dumpReveal('media', it.name) },
        ...(sub ? [{ label: 'Move up a folder', icon: 'arrow-up', action: () => api.dumpMove([it.name], parts.slice(0, -1).join('/'), 'media').then(() => this.refreshDump(true), errorToast) }] : []),
        { sep: true },
        { label: 'Remove from the dump', icon: 'trash', action: async () => { try { await api.dumpRemove(it.name, 'media'); toast(`Moved ${it.base} to media-dump${BDS.sep}.removed`, { timeout: 2500 }); this.refreshDump(true); } catch (err) { errorToast(err); } } },
      ]));
      G.append(card);
    }
  }

  openDumpFolder(rel) {
    this.dumpDir = rel || '';
    this.refreshDump(true);
  }

  async newDumpFolder() {
    const name = await promptDialog('New folder', 'Folder name', 'New folder');
    if (!name) return;
    try { await api.dumpFolder(this.dumpDir ? `${this.dumpDir}/${name}` : name, 'media'); this.refreshDump(true); } catch (e) { errorToast(e, 'Could not make the folder'); }
  }

  /** A folder card or a part of the path: drops go into that folder (things already in the dump are moved). */
  dumpDropTarget(el, folder) {
    el.addEventListener('dragover', (e) => {
      if (![PATHS_MIME, 'Files', 'text/bds-media'].some((t) => e.dataTransfer.types.includes(t))) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = e.dataTransfer.types.includes('text/bds-from-dump') ? 'move' : 'copy';
      el.classList.add('drop-into');
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-into'); });
    el.addEventListener('drop', async (e) => {
      el.classList.remove('drop-into');
      this.dumpView.classList.remove('drop');
      e.preventDefault(); e.stopPropagation();
      const paths = await this.dropPaths(e);
      if (paths.length) await this.toDump(paths, folder);
    });
  }

  /** Files on disk into the media dump (into `folder`, default the open one). From elsewhere: copied; already in the dump: moved. */
  async toDump(paths, folder = this.dumpDir || '') {
    let n = 0;
    let moved = 0;
    for (const p of paths) {
      if (!kindOf(p)) continue;
      try { const r = await api.dumpImport(p, 'media', undefined, folder); if (r.moved) moved++; else if (!r.already) n++; } catch (e) { errorToast(e, basename(p)); }
    }
    const where = `the media dump${folder ? ` (${folder})` : ''}`;
    if (n || moved) toast([n ? `Added ${n} file${n === 1 ? '' : 's'} to ${where}` : '', moved ? `${n ? 'moved' : 'Moved'} ${moved} into ${folder || 'the top folder'}` : ''].filter(Boolean).join(', '), { type: 'ok', timeout: 1800 });
    else if (paths.length) toast('Already there.', { timeout: 1500 });
    if (this.binView === 'dump') this.refreshDump(true);
    return n + moved;
  }

  /** The part of the sound a clip on an audio track plays (at its volume) as an MP3 in the media or audio dump. */
  async saveSound(c, m, kind) {
    const where = kind === 'audio' ? 'the audio dump' : `the media dump${this.dumpDir ? ` (${this.dumpDir})` : ''}`;
    const name = `${stripExt(m.name)} ${fmtTime(c.in, false).replace(/:/g, '.')}-${fmtTime(c.in + c.len, false).replace(/:/g, '.')}.mp3`;
    const t = toast(`Saving the sound to ${where}…`, { timeout: 0 });
    try {
      const r = await api.dumpReserve(kind === 'media' && this.dumpDir ? `${this.dumpDir}/${name}` : name, kind);
      await postJSON('/api/render/clip-audio', { path: m.path, start: c.in, len: c.len, volume: (c.props?.volume ?? PROPS.volume.def) / 100, output: r.path });
      t?.();
      toast(`Saved ${basename(r.path)} to ${where}.`, { type: 'ok', timeout: 2200 });
      if (kind === 'media' && this.binView === 'dump') this.refreshDump(true);
    } catch (e) { t?.(); errorToast(e, 'Saving the sound'); }
  }

  async addToDumpDialog() {
    const paths = await pickOpen({ multi: true, title: 'Add to the media dump', filters: [{ name: 'Video, audio & images', extensions: ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'] }] });
    if (paths?.length) await this.toDump(paths);
  }

  /** Paths in a drop: Shift+drag from the file panels / dump, the media list, or files from Explorer. */
  async dropPaths(e) {
    const paths = draggedPaths(e);
    const id = e.dataTransfer.getData('text/bds-media');
    if (id && this.media(id)) paths.push(this.media(id).path);
    for (const f of e.dataTransfer.files) {
      const p = window.bdsShell?.pathForFile?.(f);
      if (p) paths.push(p);
    }
    return paths;
  }

  /** Put a media item on the first fitting track at the playhead (or after the last clip there). */
  placeMedia(m, trackId = null, at = null) {
    const kind = m.kind === 'audio' ? 'audio' : 'video';
    let tr = trackId ? this.p.tracks.find((x) => x.id === trackId) : this.p.tracks.find((x) => x.kind === kind);
    // a video dropped on an audio track puts just its sound there
    if (!tr || (tr.kind !== kind && !(m.kind === 'video' && tr.kind === 'audio'))) tr = this.addTrack(kind, { quiet: true });
    const len = m.kind === 'image' ? IMAGE_LEN : Math.max(MIN_LEN, m.duration || IMAGE_LEN);
    const free = (t, s) => !t.clips.some((c) => s < c.start + c.len && s + len > c.start);
    let start = at ?? this.t;
    // don't drop on top of another clip on that track
    if (!free(tr, start) && at == null) start = Math.max(...tr.clips.map((c) => c.start + c.len));
    start = Math.max(0, start);
    this.remember();
    const c = { id: uid('c'), media: m.id, start, in: 0, len, props: {}, keys: {} };
    tr.clips.push(c);
    // a video's sound goes on an audio track of its own, linked to the picture (they move, trim, split and delete together)
    if (m.kind === 'video' && tr.kind === 'video') {
      const atr = this.p.tracks.find((t) => t.kind === 'audio' && free(t, start)) || this.addTrack('audio', { quiet: true });
      c.link = uid('l');
      c.mute = true;
      atr.clips.push({ id: uid('c'), media: m.id, start, in: 0, len, props: {}, keys: {}, link: c.link });
    }
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
    const at = this.t - s.c.start;
    if (at <= MIN_LEN / 2 || at >= s.c.len - MIN_LEN / 2) return;
    this.remember();
    const p = this.partner(s.c);
    const pat = p && this.t - p.c.start;
    const both = p && pat > MIN_LEN / 2 && pat < p.c.len - MIN_LEN / 2;
    const link = both ? uid('l') : null;
    this.sel = s.c.id;
    this.cut(s, at, link);
    if (both) this.cut(p, pat, link);
    this.renderAll();
  }

  /** Split one clip `at` seconds in; the second half is selected (and linked by `link` if it has a partner). */
  cut({ c, tr }, at, link) {
    const b = JSON.parse(JSON.stringify(c));
    if (link) b.link = link; else delete b.link;
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
    if (this.sel === c.id) this.sel = b.id;
  }

  /** Ctrl+L: unlink the selected clip from its picture / sound, or link it back to the matching clip (same file, overlapping, on the other kind of track). */
  /** The two picked clips, when they're linked to each other. */
  linkedPair() {
    const [a, b] = this.picked();
    return a && b && a.c.link && a.c.link === b.c.link;
  }

  toggleLink() {
    const all = this.picked();
    if (all.length === 2) {
      const [a, b] = all;
      if (this.linkedPair()) { this.remember(); delete a.c.link; delete b.c.link; toast('Unlinked.', { timeout: 1400 }); return this.renderAll(); }
      if (a.tr.kind === b.tr.kind) return toast('Pick one clip on a video track and one on an audio track to link them.', { timeout: 2400 });
      if (this.media((a.tr.kind === 'video' ? a : b).c.media)?.kind === 'image') return toast('A picture has no sound to link.', { timeout: 2000 });
      this.remember();
      for (const x of all) { const q = this.partner(x.c); if (q) delete q.c.link; } // each leaves its old partner
      a.c.link = b.c.link = uid('l');
      // the same video's own sound would double up with its sound clip
      const v = a.tr.kind === 'video' ? a.c : b.c;
      if (a.c.media === b.c.media) v.mute = true;
      toast('Linked — they move, trim, split and delete together.', { timeout: 1800 });
      return this.renderAll();
    }
    if (all.length > 2) return toast('Pick two clips to link (or one linked clip to unlink).', { timeout: 2000 });
    const s = this.selected;
    if (!s) return toast('Select a clip first.', { timeout: 1600 });
    const p = this.partner(s.c);
    if (p) {
      this.remember();
      delete s.c.link; delete p.c.link;
      toast('Picture and sound unlinked — they move on their own now.', { timeout: 1800 });
      return this.renderAll();
    }
    if (this.media(s.c.media)?.kind !== 'video') return toast('Only a video’s picture and sound link together.', { timeout: 2000 });
    const end = (c) => c.start + c.len;
    const near = this.allClips()
      .filter(({ c, tr }) => tr.kind !== s.tr.kind && c.media === s.c.media && !c.link && c.start < end(s.c) && end(c) > s.c.start)
      .sort((a, b) => Math.abs(a.c.start - s.c.start) - Math.abs(b.c.start - s.c.start))[0];
    if (!near) return toast('No unlinked sound or picture of this video overlaps it.', { timeout: 2200 });
    this.remember();
    s.c.link = near.c.link = uid('l');
    (s.tr.kind === 'video' ? s.c : near.c).mute = true; // the sound plays from the audio track
    toast('Picture and sound linked.', { timeout: 1600 });
    this.renderAll();
  }

  deleteSelected() {
    const all = this.picked();
    if (!all.length) return;
    this.remember();
    for (const s of all) for (const x of [s, this.partner(s.c)]) if (x) x.tr.clips = x.tr.clips.filter((c) => c !== x.c);
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
    this.snapGuide = h('div', { class: 'cut-snap-guide', hidden: true });
    this.tlInner = h('div', { class: 'cut-tl-inner' }, this.ruler, this.lanes, this.playhead, this.snapGuide);
    this.tlScroll = h('div', { class: 'cut-tl-scroll' }, this.tlInner);

    this.dumpGrid = h('div', { class: 'cut-dump-grid' });
    this.dumpCrumbs = h('div', { class: 'cut-dump-crumbs' });
    this.dumpView = h('div', { class: 'cut-dump cut-dump-target', hidden: true }, this.dumpCrumbs, this.dumpGrid);
    this.dumpDir = '';
    this.dumpCount = h('span', { class: 'cut-dump-count' });
    this.tabProject = h('button', { class: 'cut-bin-tab on', onclick: () => this.showBin('project') }, 'Media');
    this.tabDump = h('button', { class: 'cut-bin-tab cut-dump-target', title: `The media dump (Box-Deckspitter${BDS.sep}media-dump) — drop things here to keep them`, onclick: () => this.showBin('dump') }, 'Media dump', this.dumpCount);
    this.projActions = h('span', { class: 'cut-bin-actions' },
      h('button', { class: 'icon-btn', 'data-tip': 'Add video, audio or images', onclick: () => this.importDialog() }, icon('plus', 'sm')));
    this.dumpActions = h('span', { class: 'cut-bin-actions', hidden: true },
      h('button', { class: 'icon-btn', 'data-tip': 'New folder', onclick: () => this.newDumpFolder() }, icon('folder-plus', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Export the video into the media dump', onclick: () => this.exportVideo(null, { toDump: true }) }, icon('download', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Add files to the media dump', onclick: () => this.addToDumpDialog() }, icon('plus', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Open the folder', onclick: () => api.dumpReveal('media', null, this.dumpDir || null) }, icon('external', 'sm')));
    const binEl = h('div', { class: 'cut-bin' },
      h('div', { class: 'cut-pane-head cut-bin-head' }, this.tabProject, this.tabDump, h('div', { class: 'grow' }), this.projActions, this.dumpActions),
      this.bin, this.dumpView);
    this.binView = 'project';
    this.dumpTimer = setInterval(() => { if (this.binView === 'dump' && this.root.isConnected && this.root.offsetParent) this.refreshDump(); }, 4000);
    this.refreshDump();
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
        h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Shift+click or Shift+drag to seek · drag clips (they snap; press Shift mid-drag to place freely) · drag edges to trim · S split · Del delete · Ctrl+click select several · Ctrl+L link / unlink · Ctrl+wheel zoom'),
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
    const carries = (e) => ['text/bds-media', PATHS_MIME, 'Files'].some((t) => e.dataTransfer.types.includes(t));
    this.lanes.addEventListener('dragover', (e) => { if (carries(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; this.lanes.classList.add('drop'); } });
    this.lanes.addEventListener('dragleave', (e) => { if (e.target === this.lanes) this.lanes.classList.remove('drop'); });
    this.lanes.addEventListener('drop', async (e) => {
      this.lanes.classList.remove('drop');
      e.preventDefault();
      const raw = Math.max(0, this.xToT(e.clientX));
      const at = e.shiftKey ? raw : this.snapPoint(raw) ?? raw;
      const lane = e.target.closest('.cut-lane');
      const id = e.dataTransfer.getData('text/bds-media');
      if (id) { const m = this.media(id); if (m) this.placeMedia(m, this.fits(lane?.dataset.track, m), at); return; }
      const paths = await this.dropPaths(e);
      if (!paths.length && e.dataTransfer.files.length) return toast(`Use the + button to add files here (drag-and-drop from ${fileManager()} works in the app window).`, { type: 'warn' });
      await this.placePaths(paths, lane?.dataset.track, at);
    });
    // the media list takes files; the media dump (its tab, or the open dump) keeps copies
    this.bin.addEventListener('dragover', (e) => { if ([PATHS_MIME, 'Files'].some((t) => e.dataTransfer.types.includes(t))) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    this.bin.addEventListener('drop', async (e) => {
      e.preventDefault();
      for (const p of await this.dropPaths(e)) if (kindOf(p)) await this.importPath(p);
    });
    for (const zone of [this.dumpView, this.tabDump]) {
      zone.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('text/bds-from-dump') || !carries(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        this.dumpView.classList.add('drop');
        if (zone === this.tabDump && this.binView !== 'dump') this.showBin('dump');
      });
      zone.addEventListener('dragleave', (e) => { if (!this.dumpView.contains(e.relatedTarget)) this.dumpView.classList.remove('drop'); });
      zone.addEventListener('drop', async (e) => {
        this.dumpView.classList.remove('drop');
        if (e.dataTransfer.types.includes('text/bds-from-dump')) return;
        e.preventDefault();
        const paths = await this.dropPaths(e);
        if (paths.length) return this.toDump(paths);
        // a browser window (no file paths): send the bytes
        let n = 0;
        for (const f of e.dataTransfer.files) { if (kindOf(f.name)) { try { await api.dumpAdd(this.dumpDir ? `${this.dumpDir}/${f.name}` : f.name, new Uint8Array(await f.arrayBuffer()), 'media'); n++; } catch (err) { errorToast(err, f.name); } } }
        if (n) { toast(`Added ${n} to the media dump`, { type: 'ok', timeout: 1500 }); this.refreshDump(); }
      });
    }
    // chroma key eyedropper: click the preview
    this.canvas.addEventListener('pointerdown', (e) => { if (e.button === 0 && e.shiftKey && !this.picking) this.scrubPreview(e); });
    // holding Shift shows the seek cursor over the timeline and preview
    this.shiftHandler = (e) => { if (e.key === 'Shift') this.root.classList.toggle('shift-seek', e.type === 'keydown'); };
    document.addEventListener('keydown', this.shiftHandler);
    document.addEventListener('keyup', this.shiftHandler);
    this.blurHandler = () => this.root.classList.remove('shift-seek');
    window.addEventListener('blur', this.blurHandler);
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
    return tr && (tr.kind === kind || (m.kind === 'video' && tr.kind === 'audio')) ? tr.id : null;
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
      hoverKeys(row, { remove: () => this.removeMedia(m) });
      row.addEventListener('dblclick', () => this.placeMedia(m));
      row.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Add at the playhead', icon: 'plus', action: () => this.placeMedia(m) },
        { label: m.missing ? 'Find the file…' : 'Point at a different file…', icon: 'folder-open', action: () => this.relink(m) },
        { label: 'Show in folder', icon: 'external', action: () => api.reveal(m.path) },
        { label: 'Copy to the media dump', icon: 'download', disabled: m.missing, action: () => this.toDump([m.path]) },
        { sep: true },
        { label: 'Remove from project', icon: 'trash', shortcut: 'Del', action: () => this.removeMedia(m) },
      ]));
      this.bin.append(row);
    }
  }

  removeMedia(m) {
    const used = this.allClips().filter(({ c }) => c.media === m.id).length;
    this.remember();
    for (const tr of this.p.tracks) tr.clips = tr.clips.filter((c) => c.media !== m.id);
    this.p.media = this.p.media.filter((x) => x !== m);
    if (this.sel && !this.clip(this.sel)) this.sel = null;
    if (used) toast(`Removed it and its ${used} clip${used > 1 ? 's' : ''}`, { timeout: 1800 });
    this.renderAll();
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
    const on = this.isPicked(c.id);
    const p = this.partner(c);
    const linkedOn = p && !on && this.isPicked(p.c.id);
    const el = h('div', { class: `cut-clip ${m ? (tr.kind === 'audio' ? 'audio' : m.kind) : 'missing'} ${on ? 'on' : ''} ${linkedOn ? 'linked-on' : ''} ${c.key?.on ? 'keyed' : ''}`, dataset: { clip: c.id }, style: { left: `${this.tToX(c.start)}px`, width: `${Math.max(4, this.tToX(c.len))}px` }, title: `${m?.name || 'missing media'} · ${fmtTime(c.len)}${p ? ` · its ${tr.kind === 'audio' ? 'picture' : 'sound'} is on ${p.tr.name}` : ''}` },
      h('span', { class: 'cut-clip-name' }, p ? icon('link', 'sm') : null, m?.name || 'missing'),
      h('span', { class: 'cut-trim l' }), h('span', { class: 'cut-trim r' }));
    // a sound's loudness drawn along it
    if (tr.kind === 'audio' && m && m.kind !== 'image' && !m.missing) { const cv = h('canvas', { class: 'cut-wave' }); cv.wave = { c, m }; el.prepend(cv); this.drawWave(cv); }
    if (m?.kind === 'image' && !m.missing) el.style.backgroundImage = `linear-gradient(90deg, rgba(0,0,0,.55), rgba(0,0,0,.25)), url("${srcOf(m)}")`;
    // keyframe diamonds of the selected clip
    if (c.id === this.sel) {
      const times = [...new Set(Object.values(c.keys || {}).flat().map((k) => Math.round(k.t * 1000) / 1000))];
      for (const kt of times) {
        const d = h('span', { class: 'cut-kf', title: `keyframe at ${fmtTime(kt)} — click to jump, drag to move`, style: { left: `${this.tToX(kt)}px` } });
        d.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.dragKey(e, c, kt, el); });
        el.append(d);
      }
    }
    el.addEventListener('pointerdown', (e) => this.dragClip(e, c, tr, el));
    el.addEventListener('contextmenu', (e) => {
      if (!this.isPicked(c.id)) this.sel = c.id;
      this.renderTimeline(); this.renderProps();
      const two = this.picked().length === 2;
      contextMenu(e, [
        { label: 'Split at the playhead', shortcut: 'S', action: () => this.split() },
        { label: 'Copy its file to the media dump', icon: 'download', disabled: !m || m.missing, action: () => this.toDump([m.path]) },
        ...(tr.kind === 'audio' ? [
          { label: 'Save this sound to the media dump', icon: 'music', disabled: !m || m.missing, action: () => this.saveSound(c, m, 'media') },
          { label: 'Save this sound to the audio dump', icon: 'music', disabled: !m || m.missing, action: () => this.saveSound(c, m, 'audio') },
        ] : []),
        { label: 'Duplicate', action: () => {
          this.remember();
          const link = p ? uid('l') : null;
          for (const x of [{ c, tr }, p]) {
            if (!x) continue;
            const d = JSON.parse(JSON.stringify(x.c));
            d.id = uid('c'); d.start = x.c.start + x.c.len;
            if (link) d.link = link;
            x.tr.clips.push(d);
            if (x.c === c) this.sel = d.id;
          }
          this.renderAll();
        } },
        two || m?.kind === 'video' ? { label: two ? (this.linkedPair() ? 'Unlink these two' : 'Link these two (picture + sound)') : p ? (tr.kind === 'audio' ? 'Unlink from its picture' : 'Unlink its sound') : (tr.kind === 'audio' ? 'Link to its picture' : 'Link to its sound'), icon: (two ? this.linkedPair() : p) ? 'unlink' : 'link', shortcut: 'Ctrl+L', action: () => this.toggleLink() } : null,
        { sep: true },
        { label: 'Delete', icon: 'trash', shortcut: 'Del', action: () => this.deleteSelected() },
      ]);
    });
    return el;
  }

  /** A file's waveform (loudest sample per 1/100 s, 0–255): from ffmpeg on the server, or decoded here without it. */
  loadPeaks(m) {
    this.peaks ||= new Map();
    const key = m.proxy || m.path;
    if (this.peaks.has(key)) return;
    this.peaks.set(key, null); // loading
    const done = (pk) => {
      this.peaks.set(key, pk);
      if (pk) for (const cv of this.lanes.querySelectorAll('canvas.cut-wave')) if (cv.wave.m === m) this.drawWave(cv);
    };
    postJSON('/api/render/peaks', { path: m.path })
      .then((r) => done(r.peaks ? { rate: r.rate, data: Uint8Array.from(atob(r.peaks), (ch) => ch.charCodeAt(0)) } : false))
      .catch(async () => {
        // no ffmpeg: let the browser decode it, if it isn't huge
        try {
          const res = await fetch(srcOf(m));
          if (Number(res.headers.get('content-length')) > 250 * 1024 * 1024) { res.body?.cancel(); return done(false); }
          const ctx = new OfflineAudioContext(1, 1, 8000);
          const buf = await ctx.decodeAudioData(await res.arrayBuffer());
          const per = Math.max(1, Math.round(buf.sampleRate / 100));
          const data = new Uint8Array(Math.ceil(buf.length / per));
          const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
          for (let i = 0; i < data.length; i++) {
            let mx = 0;
            for (const ch of chans) for (let j = i * per, e = Math.min(ch.length, j + per); j < e; j++) { const v = Math.abs(ch[j]); if (v > mx) mx = v; }
            data[i] = Math.min(255, Math.round(mx * 255));
          }
          done({ rate: buf.sampleRate / per, data });
        } catch { done(false); }
      });
  }

  /** Draw the part of the waveform a clip on an audio track uses (its volume makes it taller or shorter). */
  drawWave(cv) {
    const { c, m } = cv.wave;
    const pk = this.peaks?.get(m.proxy || m.path);
    if (pk === undefined) this.loadPeaks(m);
    if (!pk) return;
    const dpr = devicePixelRatio || 1;
    const W = Math.max(1, Math.min(8192, Math.round(Math.max(4, this.tToX(c.len)) * dpr)));
    const H = Math.round(34 * dpr);
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(255, 255, 255, 0.38)';
    const gain = Math.min(2, (c.props?.volume ?? PROPS.volume.def) / 100);
    const mid = H / 2;
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor((c.in + (x / W) * c.len) * pk.rate);
      const i1 = Math.max(i0 + 1, Math.ceil((c.in + ((x + 1) / W) * c.len) * pk.rate));
      let v = 0;
      for (let i = i0; i < i1 && i < pk.data.length; i++) if (pk.data[i] > v) v = pk.data[i];
      // in decibels (−48 dB … 0), so quiet sound still shows
      const db = v && gain ? 20 * Math.log10((v / 255) * gain) : -Infinity;
      const a = Math.min(mid, Math.max(v ? 0.5 : 0, ((db + 48) / 48) * mid));
      if (a) g.fillRect(x, mid - a, 1, a * 2);
    }
  }

  /** The clip edge / playhead / 0 that time t is within a few pixels of, or null. */
  snapPoint(t, skip) {
    const pts = [0, this.t];
    // not to the clip being dragged, nor to its linked partner (it moves along)
    for (const { c } of this.allClips()) if (c !== skip && !(skip?.link && c.link === skip.link)) pts.push(c.start, c.start + c.len);
    let best = null;
    let bd = SNAP_PX / this.pps;
    for (const p of pts) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  /** The line showing where a clip snapped (null hides it). */
  showSnap(t) {
    this.snapGuide.hidden = t == null;
    if (t != null) this.snapGuide.style.left = `${this.tToX(t)}px`;
  }

  dragClip(e, c, tr, el) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.shiftKey) return this.scrub(e); // Shift+click / Shift+drag seeks, even over a clip
    if (e.ctrlKey || e.metaKey) { this.togglePick(c.id); this.renderTimeline(); this.renderProps(); return; } // Ctrl+click: select several
    const m = this.media(c.media);
    const mode = e.target.classList.contains('cut-trim') ? (e.target.classList.contains('l') ? 'left' : 'right') : 'move';
    const sx = e.clientX;
    const orig = { start: c.start, in: c.in, len: c.len };
    // its linked picture / sound comes along (trims too); moving, so does the rest of a Ctrl+click selection and their partners
    const pc = this.partner(c)?.c;
    const porig = pc && { start: pc.start, in: pc.in, len: pc.len };
    if (this.isPicked(c.id) && this.extra.size) { if (this._sel !== c.id) { this.extra.add(this._sel); this.extra.delete(c.id); this._sel = c.id; } }
    else this.sel = c.id;
    const group = new Set();
    if (mode === 'move') for (const x of this.picked()) for (const y of [x, this.partner(x.c)]) if (y && y.c !== c && y.c !== pc) group.add(y.c);
    const gorig = new Map([...group].map((g) => [g, g.start]));
    const gmin = Math.min(Infinity, ...gorig.values());
    let moved = false;
    let curTrack = tr;
    const maxLen = m && m.kind !== 'image' && m.duration ? m.duration : Infinity;
    let overDump = false;
    const move = (ev) => {
      const dt = (ev.clientX - sx) / this.pps;
      if (!moved && Math.abs(ev.clientX - sx) < 3 && mode === 'move' && !ev.target.closest?.('.cut-lane:not([data-track="' + curTrack.id + '"])')) return;
      if (!moved) { moved = true; this.remember(); }
      // dragged over the media dump (its tab or the open dump): drop there to keep a copy of the file
      const dumpHit = mode === 'move' && m && !m.missing && document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.cut-dump-target');
      if ((dumpHit || false) !== overDump) {
        if (overDump?.classList) overDump.classList.remove('drop-into');
        overDump = dumpHit || false;
        if (overDump?.dataset?.folder != null) overDump.classList.add('drop-into');
        this.dumpView.classList.toggle('drop', !!overDump);
        this.tabDump.classList.toggle('drop', !!overDump);
        el.classList.toggle('to-dump', !!overDump);
        if (overDump && this.binView !== 'dump') this.showBin('dump');
      }
      if (overDump) { this.showSnap(null); return; }
      // clips snap to each other's edges, the playhead and the start; hold Shift to place them freely
      const free = ev.shiftKey;
      let guide = null;
      if (mode === 'move') {
        let start = Math.max(0, orig.start + dt);
        const a = free ? null : this.snapPoint(start, c);
        const b = free ? null : this.snapPoint(start + c.len, c);
        if (a != null && (b == null || Math.abs(a - start) <= Math.abs(b - (start + c.len)))) { start = a; guide = a; }
        else if (b != null && b - c.len >= 0) { start = b - c.len; guide = b; }
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
        let start = orig.start + dt;
        const sp = free ? null : this.snapPoint(start, c);
        if (sp != null) { start = sp; guide = sp; }
        start = clamp(start, Math.max(0, orig.start - (m?.kind === 'image' ? Infinity : orig.in)), orig.start + orig.len - MIN_LEN);
        const d = start - orig.start;
        c.start = start;
        c.len = orig.len - d;
        if (m?.kind !== 'image') c.in = Math.max(0, orig.in + d);
        // keep keyframes where they were on screen
        if (d) for (const keys of Object.values(c.keys || {})) for (const k of keys) k.t = (k._t0 ?? (k._t0 = k.t)) - d;
      } else {
        let end = orig.start + orig.len + dt;
        const sp = free ? null : this.snapPoint(end, c);
        if (sp != null) { end = sp; guide = sp; }
        c.len = clamp(end - orig.start, MIN_LEN, maxLen - (m?.kind === 'image' ? 0 : orig.in));
      }
      this.showSnap(guide);
      el.style.left = `${this.tToX(c.start)}px`;
      el.style.width = `${Math.max(4, this.tToX(c.len))}px`;
      const wave = el.querySelector('canvas.cut-wave');
      if (wave && mode !== 'move') this.drawWave(wave);
      if (group.size) {
        // nothing in the group goes before 0
        if (gmin + (c.start - orig.start) < 0) c.start = orig.start - gmin;
        for (const [g, s0] of gorig) {
          g.start = s0 + c.start - orig.start;
          const gel = this.lanes.querySelector(`.cut-clip[data-clip="${g.id}"]`);
          if (gel) gel.style.left = `${this.tToX(g.start)}px`;
        }
        el.style.left = `${this.tToX(c.start)}px`;
      }
      if (pc) {
        const d = c.start - orig.start;
        pc.start = Math.max(0, porig.start + d);
        pc.len = Math.max(MIN_LEN, porig.len + (c.len - orig.len));
        pc.in = Math.max(0, porig.in + (c.in - orig.in));
        if (mode === 'left') for (const keys of Object.values(pc.keys || {})) for (const k of keys) k.t = (k._t0 ?? (k._t0 = k.t)) - d;
        const pel = this.lanes.querySelector(`.cut-clip[data-clip="${pc.id}"]`);
        if (pel) {
          pel.style.left = `${this.tToX(pc.start)}px`; pel.style.width = `${Math.max(4, this.tToX(pc.len))}px`;
          const pw = pel.querySelector('canvas.cut-wave');
          if (pw && mode !== 'move') this.drawWave(pw);
        }
      }
      this.requestUpdate();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      this.showSnap(null);
      if (overDump) {
        // the clip stays where it was; its file goes into the dump (into the folder it was dropped on)
        overDump.classList?.remove('drop-into');
        this.dumpView.classList.remove('drop');
        this.tabDump.classList.remove('drop');
        this.p = JSON.parse(this.undoStack.pop());
        this.redoStack = [];
        this.renderAll();
        this.toDump([m.path], overDump.dataset?.folder ?? this.dumpDir ?? '');
        return;
      }
      for (const x of pc ? [c, pc] : [c]) {
        for (const keys of Object.values(x.keys || {})) for (const k of keys) delete k._t0;
        if (mode === 'left') for (const [p, keys] of Object.entries(x.keys || {})) x.keys[p] = keys.filter((k) => k.t >= -1e-6 && k.t <= x.len + 1e-6);
      }
      this.renderTimeline();
      this.renderProps();
      this.refreshStatus();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    this.renderTimeline();
    this.renderProps();
    // the timeline was just redrawn (to show the selection): keep moving the clip that's on screen now
    el = this.lanes.querySelector(`.cut-clip[data-clip="${c.id}"]`) || el;
  }

  dragKey(e, c, kt, clipEl) {
    if (e.shiftKey) return this.scrub(e);
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

  /** Move the playhead to the pointer and follow it until the button comes up (the ruler, empty lanes, Shift anywhere). */
  scrub(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const go = (ev) => {
      this.seek(Math.max(0, this.xToT(ev.clientX)));
      // keep the playhead in view while scrubbing near the edges
      const r = this.tlScroll.getBoundingClientRect();
      if (r.width < 120) return;
      if (ev.clientX > r.right - 30) this.tlScroll.scrollLeft += 20;
      else if (ev.clientX < r.left + 30) this.tlScroll.scrollLeft -= 20;
    };
    go(e);
    this.root.classList.add('scrubbing');
    const up = () => { removeEventListener('pointermove', go); removeEventListener('pointerup', up); this.root.classList.remove('scrubbing'); };
    addEventListener('pointermove', go);
    addEventListener('pointerup', up);
  }

  /** Shift+click / Shift+drag across the preview: its width is the whole project, start to end. */
  scrubPreview(e) {
    const r = this.canvas.getBoundingClientRect();
    const go = (ev) => this.seek(clamp((ev.clientX - r.left) / r.width, 0, 1) * this.duration);
    e.preventDefault();
    go(e);
    this.root.classList.add('scrubbing');
    const up = () => { removeEventListener('pointermove', go); removeEventListener('pointerup', up); this.root.classList.remove('scrubbing'); };
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
    // rebuilding empties the panel, which would jump it back to the top: keep the scroll while it's the same clip
    const key = this.selected?.c.id ?? null;
    const top = key === this.propsFor ? this.props.scrollTop : 0;
    this.propsFor = key;
    this.buildProps();
    this.props.scrollTop = top;
  }

  buildProps() {
    this.sliderPop?.close(); // its box is about to be replaced
    this.sliderPop = null;
    const P = clear(this.props);
    const s = this.selected;
    if (!s) return this.renderProjectProps(P);
    const { c, tr } = s;
    const m = this.media(c.media);
    const sound = m?.kind === 'audio' || tr.kind === 'audio'; // a video's sound on an audio track is edited as audio
    const p = this.partner(c);
    const local = clamp(this.t - c.start, 0, c.len);
    const inside = this.t >= c.start && this.t <= c.start + c.len;
    const num = (label, value, onSet, { step = 0.01, min = 0, unit = 's' } = {}) => {
      const inp = h('input', { type: 'number', step: String(step), value: String(Math.round(value * 100) / 100) });
      inp.addEventListener('change', () => {
        const v = Number(inp.value);
        if (!Number.isFinite(v)) return;
        this.remember();
        const was = { start: c.start, len: c.len, in: c.in };
        onSet(Math.max(min, v));
        const pc = this.partner(c)?.c;
        if (pc) { pc.start = Math.max(0, pc.start + c.start - was.start); pc.len = Math.max(MIN_LEN, pc.len + c.len - was.len); pc.in = Math.max(0, pc.in + c.in - was.in); }
        this.renderAll();
      });
      return h('label', { class: 'cut-row' }, h('span', {}, label), inp, h('span', { class: 'faint' }, unit));
    };
    P.append(h('div', { class: 'cut-props-title' }, icon(sound ? 'music' : m?.kind === 'image' ? 'image' : 'video', 'sm'), h('span', {}, m?.name || 'missing media')));
    if (this.extra.size) {
      const n = this.picked().length;
      P.append(h('div', { class: 'cut-link-row' }, h('span', { class: 'faint' }, `${n} clips selected — they move and delete together.`),
        n === 2 ? h('button', { class: 'btn sm', title: 'Ctrl+L', onclick: () => this.toggleLink() }, icon(this.linkedPair() ? 'unlink' : 'link', 'sm'), this.linkedPair() ? 'Unlink' : 'Link') : null));
    }
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
      // type in the box, or drag the slider that pops out under it
      const showSlider = () => {
        if (this.sliderPop?.el.isConnected) return;
        const r = h('input', { type: 'range', class: 'cut-pop-slider', min: String(def.min), max: String(def.max), step: String(def.step), value: inp.value });
        let first = true;
        r.addEventListener('input', () => {
          if (first) { this.remember(); first = false; }
          this.setProp(c, prop, Number(r.value));
          inp.value = r.value;
          this.requestUpdate(false);
        });
        r.addEventListener('change', () => { first = true; this.renderTimeline(); });
        inp.addEventListener('input', () => { r.value = inp.value; });
        this.sliderPop = popover(inp, r);
      };
      if (def.slider) { inp.addEventListener('focus', showSlider); inp.addEventListener('click', showSlider); }
      const kb = h('button', { class: `cut-keybtn ${here ? 'here' : keys.length ? 'has' : ''}`, disabled: !inside, title: here ? 'Remove the keyframe here' : keys.length ? 'Add a keyframe here' : 'Animate: add a keyframe at the playhead' }, '◆');
      kb.addEventListener('click', () => this.toggleKey(c, prop));
      const row = h('div', { class: 'cut-row' }, lab, inp, h('span', { class: 'faint' }, def.unit), kb);
      row.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: `Reset ${def.label.toLowerCase()}`, action: () => { this.remember(); delete c.keys?.[prop]; delete c.props?.[prop]; this.renderProps(); this.renderTimeline(); this.draw(); } },
        { label: 'Remove all its keyframes', disabled: !keys.length, action: () => { this.remember(); c.props = c.props || {}; c.props[prop] = valueAt(c, prop, local); delete c.keys[prop]; this.renderProps(); this.renderTimeline(); this.draw(); } },
      ]));
      return row;
    };

    if (!sound) {
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
        h('div', { class: 'cut-row cut-pick' }, h('span', {}, 'Colour'), color,
          h('button', { class: `btn sm ${this.picking ? 'primary' : ''}`, title: 'Click the colour in the preview', onclick: () => { this.picking = !this.picking; this.canvas.classList.toggle('picking', this.picking); this.renderProps(); } }, icon('pipette', 'sm'), this.picking ? 'Click the preview…' : 'Pick')),
        slider('Tolerance', 'tolerance', 150), slider('Softness', 'softness', 100), slider('Spill', 'spill', 100)));
    }
    if (p && !sound) {
      // its sound is the linked clip on an audio track
      P.append(h('div', { class: 'cut-group' }, h('h5', {}, 'Audio'),
        h('div', { class: 'cut-link-row' }, h('span', { class: 'faint' }, `Its sound is on ${p.tr.name}.`),
          h('button', { class: 'btn sm', onclick: () => { this.sel = p.c.id; this.renderTimeline(); this.renderProps(); } }, icon('music', 'sm'), 'Select it'),
          h('button', { class: 'btn sm ghost', title: 'Unlink picture and sound (Ctrl+L)', onclick: () => this.toggleLink() }, icon('unlink', 'sm'), 'Unlink'))));
    } else if (m?.kind !== 'image') {
      const muteBox = h('input', { type: 'checkbox', checked: !!c.mute });
      muteBox.addEventListener('change', () => { this.remember(); c.mute = muteBox.checked; this.draw(); });
      P.append(h('div', { class: 'cut-group' }, h('h5', {}, 'Audio'), propRow('volume'),
        m?.kind === 'video' ? h('label', { class: 'check' }, muteBox, sound ? 'Mute this clip' : 'Mute this clip’s sound') : null,
        p ? h('div', { class: 'cut-link-row' }, h('span', { class: 'faint' }, `Linked to its picture on ${p.tr.name}.`),
          h('button', { class: 'btn sm ghost', title: 'Unlink picture and sound (Ctrl+L)', onclick: () => this.toggleLink() }, icon('unlink', 'sm'), 'Unlink')) : null));
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
      h('div', { class: 'cut-actions' }, h('button', { class: 'btn primary', onclick: () => this.exportVideo() }, icon('download', 'sm'), 'Export MP4…'),
        h('button', { class: 'btn', onclick: () => this.exportVideo(null, { toDump: true }) }, icon('image', 'sm'), 'Export to media dump')));
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
      if (this.seeking()) return; // 'seeked' draws it
    }
    this.composite(this.ctx2d, this.canvas.width, this.canvas.height, this.t, (c, m) => {
      const el = this.elFor(c, m);
      return m.kind === 'image' ? el : el.readyState >= 2 ? el : null;
    });
  }

  /** A visible video mid-seek has no frame to give: drawing then would flash it blank (pausing and playing both seek). */
  seeking() {
    for (const { c, tr } of this.allClips()) {
      if (tr.kind === 'video' && this.t >= c.start && this.t < c.start + c.len && this.els.get(c.id)?.seeking) return true;
    }
    return false;
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
      if (!this.seeking()) this.composite(this.ctx2d, this.canvas.width, this.canvas.height, this.t, (c, m) => { const el = this.elFor(c, m); return m.kind === 'image' ? el : el.readyState >= 2 ? el : null; });
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
    // stop on the frame that's showing: the video runs a little ahead of the clock, and seeking back to it jumps the picture
    for (const { c, tr } of this.allClips()) {
      const el = this.els.get(c.id);
      if (tr.kind !== 'video' || !el || el.seeking || this.t < c.start || this.t >= c.start + c.len) continue;
      const t = c.start + el.currentTime - c.in;
      if (Math.abs(t - this.t) < 0.25) this.t = clamp(t, c.start, c.start + c.len - 0.001);
      break;
    }
    this.placePlayhead();
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
      if (Math.abs(el.currentTime - want) > (force ? 0.02 : 0.25)) el.currentTime = want; // a seek blanks the frame: only when it's off
      const vol = (tr.muted || c.mute) ? 0 : clamp(valueAt(c, 'volume', this.t - c.start) / 100, 0, 1);
      el.volume = vol;
      el.muted = false; // volume 0 rather than muted: Chromium pauses muted videos that aren't on screen
      if (el.paused) el.play().catch(() => {});
    }
    for (const el of this.els.values()) if (el.pause && !live.has(el) && !el.paused) el.pause();
  }

  // =================================================================== export

  /** target: a path to export to without asking (the export dialog is skipped). toDump: into the media dump. */
  async exportVideo(target = null, { toDump = false } = {}) {
    if (this.exporting) return;
    if (!this.allClips().length) return toast('Put something on the timeline first.', { type: 'warn' });
    const tools = await fetch('/api/tools', { headers: { 'X-BDS-Token': api.token } }).then((r) => r.json()).catch(() => ({}));
    if (!tools.ffmpeg) return toast(`Exporting needs ffmpeg: run "${tools.hints?.ffmpeg || 'winget install Gyan.FFmpeg'}", then restart Box-Deckspitter.`, { type: 'warn', timeout: 8000 });
    const base = this.tab.path ? stripExt(basename(this.tab.path)) : stripExt(this.tab.title);
    if (toDump) {
      try { target = (await api.dumpReserve(`${base.replace(/^\.+/, '') || 'video'}.mp4`, 'media')).path; } catch (e) { return errorToast(e, 'Export failed'); }
    }
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
      if (missing.length && (!target || toDump)) toast(`Leaving out ${missing.length} missing file${missing.length > 1 ? 's' : ''}: ${missing.map((m) => m.name).join(', ')}`, { type: 'warn', timeout: 6000 });
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
      if (toDump) { this.showBin('dump'); this.refreshDump(); }
      toast(toDump ? `Exported ${basename(out)} into the media dump` : `Exported ${basename(out)}`, { type: 'ok', timeout: 8000, action: { label: 'Open', fn: () => this.app.openPath(out) } });
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
    if (ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); return this.toggleLink(); }
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
      tbButton('image', 'Media dump', () => this.showBin(this.binView === 'dump' ? 'project' : 'dump')),
      tbSep(),
      tbButton('scissors', 'Split at the playhead (S)', () => this.split(), { text: 'Split' }),
      tbButton('trash', 'Delete the selected clip (Del)', () => this.deleteSelected()),
      h('div', { class: 'grow' }),
      tbButton('image-down', 'Export into the media dump', () => this.exportVideo(null, { toDump: true })),
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
    document.removeEventListener('keydown', this.shiftHandler);
    document.removeEventListener('keyup', this.shiftHandler);
    window.removeEventListener('blur', this.blurHandler);
    this.ro?.disconnect();
    this.thumbIO?.disconnect();
    clearInterval(this.dumpTimer);
    for (const el of this.els.values()) { if (el.pause) { el.pause(); el.removeAttribute('src'); el.load(); } }
  }
}

