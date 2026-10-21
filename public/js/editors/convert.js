// BoxConvert: drop files in, pick what each becomes, convert. Pictures are redrawn here (PNG, JPG, WebP, GIF, BMP,
// ICO, or a PDF); videos and sounds go through the PC's ffmpeg; documents go through the document editor's own
// import and export (Word, PDF, web page, Markdown, RTF, text); spreadsheets through SheetJS; PDFs become page
// pictures or text. The new file lands next to the old one (or in a folder you pick) and nothing is ever overwritten.
// "Shrink to a size" takes any file down to a size you set: pictures are redrawn smaller here, PDFs repacked (or their
// pages redrawn as pictures), videos, sounds and GIFs go through ffmpeg at the rate that fits, anything else is zipped.

import { BaseEditor } from './base.js';
import { h, clear, uid, basename, dirname, extOf, stripExt, formatBytes, decodeText, vendor } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { toast, errorToast, contextMenu, draggedPaths } from '../core/ui.js';
import { pickOpen, pickFolder } from '../core/files.js';
import { encodeCanvas, defaultOut, alphaInfo } from './image-out.js';
import { EDITORS } from '../core/tools.js';

const post = (url, json) => api.post(url, json);
const inDir = (dir, name) => dir + (/\\/.test(dir) || !dir.includes('/') ? '\\' : '/') + name;

/** What each kind of file reads from and can become. */
const KINDS = {
  image: { label: 'Picture', icon: 'image', exts: ['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'ico', 'svg', 'avif'], to: ['png', 'jpg', 'webp', 'gif', 'bmp', 'ico', 'pdf'] },
  video: { label: 'Video', icon: 'video', exts: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp'], to: ['mp4', 'webm', 'mkv', 'mov', 'gif', 'mp3', 'wav', 'm4a'] },
  audio: { label: 'Sound', icon: 'music', exts: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'weba', 'wma', 'aif', 'aiff', 'amr'], to: ['mp3', 'wav', 'm4a', 'ogg', 'opus', 'flac'] },
  doc: { label: 'Document', icon: 'file-doc', exts: ['docx', 'docm', 'dotx', 'odt', 'rtf', 'doc', 'html', 'htm', 'md', 'markdown', 'txt'], to: ['docx', 'pdf', 'html', 'md', 'rtf', 'txt'] },
  sheet: { label: 'Spreadsheet', icon: 'sheet', exts: ['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'tsv'], to: ['xlsx', 'ods', 'csv', 'tsv'] },
  pdf: { label: 'PDF', icon: 'file-pdf', exts: ['pdf'], to: ['png', 'jpg', 'txt'] },
  other: { label: 'Any file', icon: 'file', exts: [], to: [] }, // only shrinks
};
const TO_LABEL = {
  png: 'PNG', jpg: 'JPG', webp: 'WebP', gif: 'GIF', bmp: 'BMP', ico: 'ICO (Windows icon)', pdf: 'PDF',
  mp4: 'MP4', webm: 'WebM', mkv: 'MKV', mov: 'MOV', mp3: 'MP3', wav: 'WAV', m4a: 'M4A', ogg: 'OGG', opus: 'Opus', flac: 'FLAC',
  docx: 'Word (.docx)', html: 'Web page (.html)', md: 'Markdown', rtf: 'RTF', txt: 'Plain text',
  xlsx: 'Excel (.xlsx)', ods: 'OpenDocument (.ods)', csv: 'CSV', tsv: 'TSV',
  size: 'Shrink to a size',
};
const UNITS = { KB: 1024, MB: 1048576, GB: 1073741824 };
/** "10MB", "9.5MB", "800KB": in the shrunk file's name. */
const sizeTag = ({ n, unit }) => `${+Number(n).toFixed(2)}${unit}`;
const MEDIA_TO = new Set(['mp4', 'webm', 'mkv', 'mov', 'mp3', 'wav', 'm4a', 'ogg', 'opus', 'flac']);
const SAME = { jpeg: 'jpg', jfif: 'jpg', htm: 'html', markdown: 'md', xlsm: 'xlsx', oga: 'ogg', m4v: 'mp4' };
const ALL_EXTS = Object.values(KINDS).flatMap((k) => k.exts);

const kindOf = (ext) => Object.keys(KINDS).find((k) => KINDS[k].exts.includes(ext)) || 'other';
/** What a file can become: its kind's targets, minus what it already is, and a smaller one. A GIF can also become a video. */
function targetsFor(ext) {
  let to = KINDS[kindOf(ext)].to;
  if (ext === 'gif') to = [...to, 'mp4', 'webm'];
  return [...to.filter((t) => t !== (SAME[ext] || ext)), 'size'];
}

// ---------------------------------------------------------------- pictures
async function loadImage(bytes, ext) {
  const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'ico' ? 'image/x-icon' : `image/${['jpg', 'jfif'].includes(ext) ? 'jpeg' : ext}`;
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth || 1024, ht = img.naturalHeight || 1024;
    // a drawing has no real size: at least 1024 px on its longer side
    if (ext === 'svg' && Math.max(w, ht) < 1024) { const k = 1024 / Math.max(w, ht); w = Math.round(w * k); ht = Math.round(ht * k); }
    const c = document.createElement('canvas');
    c.width = w; c.height = ht;
    c.getContext('2d').drawImage(img, 0, 0, w, ht);
    return c;
  } catch { throw new Error('Couldn’t read that picture.'); } finally { URL.revokeObjectURL(url); }
}

/** 24-bit BMP (transparent parts become white). */
function encodeBmp(canvas) {
  const w = canvas.width, ht = canvas.height, row = Math.ceil((w * 3) / 4) * 4;
  const px = canvas.getContext('2d').getImageData(0, 0, w, ht).data;
  const out = new DataView(new ArrayBuffer(54 + row * ht));
  out.setUint16(0, 0x4d42, true); out.setUint32(2, 54 + row * ht, true); out.setUint32(10, 54, true);
  out.setUint32(14, 40, true); out.setInt32(18, w, true); out.setInt32(22, ht, true); out.setUint16(26, 1, true); out.setUint16(28, 24, true);
  out.setUint32(34, row * ht, true); out.setInt32(38, 2835, true); out.setInt32(42, 2835, true);
  for (let y = 0; y < ht; y++) {
    let o = 54 + (ht - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, a = px[i + 3] / 255;
      out.setUint8(o++, Math.round(px[i + 2] * a + 255 * (1 - a)));
      out.setUint8(o++, Math.round(px[i + 1] * a + 255 * (1 - a)));
      out.setUint8(o++, Math.round(px[i] * a + 255 * (1 - a)));
    }
  }
  return new Uint8Array(out.buffer);
}

/** A Windows icon with the usual sizes (up to the picture's own), each a PNG, the picture centred on a square. */
async function encodeIco(canvas) {
  const big = Math.max(canvas.width, canvas.height);
  const sizes = [16, 24, 32, 48, 64, 128, 256].filter((s) => s <= Math.max(16, big));
  const pngs = [];
  for (const s of sizes) {
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    const k = s / big, w = canvas.width * k, ht = canvas.height * k;
    x.drawImage(canvas, (s - w) / 2, (s - ht) / 2, w, ht);
    pngs.push(new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer()));
  }
  const head = 6 + 16 * sizes.length;
  const out = new Uint8Array(head + pngs.reduce((a, p) => a + p.length, 0));
  const v = new DataView(out.buffer);
  v.setUint16(2, 1, true); v.setUint16(4, sizes.length, true);
  let at = head;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    out[e] = s >= 256 ? 0 : s; out[e + 1] = s >= 256 ? 0 : s;
    v.setUint16(e + 4, 1, true); v.setUint16(e + 6, 32, true); v.setUint32(e + 8, pngs[i].length, true); v.setUint32(e + 12, at, true);
    out.set(pngs[i], at); at += pngs[i].length;
  });
  return out;
}

/** One picture as a one-page PDF the picture's size (JPGs go in as they are, everything else as PNG). */
async function imageToPdf(bytes, ext, canvas) {
  const PDFLib = await vendor.pdfLib();
  const doc = await PDFLib.PDFDocument.create();
  const jpg = ['jpg', 'jpeg', 'jfif'].includes(ext);
  const img = jpg ? await doc.embedJpg(bytes) : await doc.embedPng(await encodeCanvas(canvas, 'png', {}));
  const w = canvas.width * 0.75, ht = canvas.height * 0.75; // px at 96 dpi → points
  doc.addPage([w, ht]).drawImage(img, { x: 0, y: 0, width: w, height: ht });
  return doc.save();
}

// ---------------------------------------------------------------- documents, through the document editor itself
/** The editor for `mode`, loaded off-screen with the file, for fn to save from; gone afterwards. */
async function withEditor(app, mode, name, bytes, fn) {
  const Editor = await EDITORS[mode]();
  const pane = h('div', { class: 'convert-offscreen', 'aria-hidden': 'true' });
  document.body.append(pane);
  const tab = { id: 'convert-' + uid(), title: name, ext: extOf(name), path: null, mode, pane, headless: true };
  const ed = new Editor(app, tab);
  try {
    await ed.load(bytes, {});
    return await fn(ed);
  } finally {
    try { ed.destroy(); } catch { /* gone anyway */ }
    pane.remove();
  }
}
async function asBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
  return new TextEncoder().encode(String(v ?? ''));
}

export class ConvertEditor extends BaseEditor {
  static mode = 'convert';

  async load(bytes, opts = {}) {
    this.items = [];
    this.root = h('div', { class: 'convert-root' });
    this.pane.append(this.root);
    this.root.addEventListener('dragover', (e) => { e.preventDefault(); this.root.classList.add('drop'); });
    this.root.addEventListener('dragleave', (e) => { if (!this.root.contains(e.relatedTarget)) this.root.classList.remove('drop'); });
    this.root.addEventListener('drop', (e) => {
      e.preventDefault(); this.root.classList.remove('drop');
      const paths = draggedPaths(e);
      for (const f of e.dataTransfer.files) { const p = window.bdsShell?.pathForFile?.(f); if (p) paths.push(p); }
      this.add(paths);
    });
    this.ffmpeg = !!(await api.tools().catch(() => ({})))?.ffmpeg;
    this.render();
    if (opts.paths?.length) this.add(opts.paths);
  }

  get settings() { return this.app.settings; }
  get outDir() { return this.settings.convertDir || null; }

  add(paths) {
    for (const p of paths) {
      const ext = extOf(p);
      if (this.items.some((x) => x.path === p && x.status !== 'done')) continue;
      const kind = kindOf(ext), to = targetsFor(ext);
      const last = (this.settings.convertTo || {})[kind];
      this.items.push({ id: uid(), path: p, name: basename(p), ext, kind, to: to.includes(last) ? last : to[0], status: 'ready', progress: 0, out: [], error: null, size: null });
    }
    this.renderList();
    this.refreshStatus();
    for (const x of this.items) if (x.size == null) api.stat?.(x.path).then((s) => { x.size = s?.size ?? null; this.renderList(); }).catch(() => {});
  }

  async addDialog() {
    const paths = await pickOpen({ multi: true, title: 'Files to convert or shrink', filters: [{ name: 'All files (any file can be shrunk)', extensions: ['*'] }, { name: 'Files BoxConvert converts', extensions: ALL_EXTS }] });
    if (paths?.length) this.add(paths);
  }

  // ---------------------------------------------------------------- the page
  render() {
    clear(this.root).append(
      h('div', { class: 'convert-main' },
        h('div', { class: 'convert-head' },
          h('div', {}, h('div', { class: 'todo-title' }, 'Convert files'),
            h('div', { class: 'faint convert-sub' }, 'Pictures, videos, sounds, documents, spreadsheets and PDFs, or any file shrunk to a size. The original stays as it is.')),
          h('div', { class: 'grow' }),
          h('button', { class: 'btn sm', onclick: () => this.addDialog() }, icon('plus', 'sm'), 'Add files')),
        this.list = h('div', { class: 'convert-list' }),
        this.foot = h('div', { class: 'convert-foot' })));
    this.renderList();
  }

  renderList() {
    if (!this.list) return;
    clear(this.list);
    if (!this.items.length) {
      this.list.append(h('button', { class: 'convert-drop', onclick: () => this.addDialog() },
        icon('repeat'), h('div', { class: 'convert-drop-big' }, 'Drop files here'),
        h('div', { class: 'faint' }, 'or click to choose them'),
        h('div', { class: 'convert-kinds' }, Object.values(KINDS).map((k) => h('span', {}, icon(k.icon, 'sm'), k.label)))));
    } else this.list.append(...this.items.map((x) => this.row(x)));
    this.renderFoot();
  }

  row(x) {
    const k = KINDS[x.kind];
    const needsFf = (t) => (MEDIA_TO.has(t) || (t === 'gif' && x.kind === 'video') || (t === 'size' && (x.kind === 'video' || x.kind === 'audio' || x.ext === 'gif'))) && !this.ffmpeg;
    const sel = h('select', { class: 'convert-to', disabled: x.status === 'working' }, targetsFor(x.ext).map((t) =>
      h('option', { value: t, selected: t === x.to, disabled: needsFf(t) }, TO_LABEL[t] + (needsFf(t) ? ' (needs ffmpeg)' : ''))));
    sel.addEventListener('change', () => {
      x.to = sel.value;
      if (x.status !== 'working') { x.status = 'ready'; x.out = []; x.error = null; }
      this.app.saveSettings({ convertTo: { ...(this.settings.convertTo || {}), [x.kind]: x.to } });
      this.renderList();
    });
    let state;
    if (x.status === 'working') state = h('div', { class: 'convert-bar' }, h('div', { style: { width: `${Math.round(x.progress * 100)}%` } }));
    else if (x.status === 'done' && !x.out.length) state = h('div', { class: 'convert-done', title: x.note || '' }, icon('check', 'sm'), h('span', { class: 'faint' }, x.note || 'Nothing to do'));
    else if (x.status === 'done') state = h('div', { class: 'convert-done', title: x.note || '' }, icon('check', 'sm'),
      x.outSize != null ? h('span', { class: 'mono faint convert-size' }, formatBytes(x.outSize)) : null,
      h('button', { class: 'convert-link', title: x.out.join('\n'), onclick: () => (x.out.length === 1 ? this.app.openPath(x.out[0]) : api.reveal(x.out[0])) }, x.out.length === 1 ? basename(x.out[0]) : `${x.out.length} files`),
      h('button', { class: 'icon-btn', 'data-tip': 'Show in folder', onclick: () => api.reveal(x.out[0]) }, icon('folder', 'sm')));
    else if (x.status === 'error') state = h('div', { class: 'convert-err', title: x.error }, icon('alert', 'sm'), h('span', {}, x.error));
    else state = h('div', { class: 'faint convert-wait' }, 'Ready');
    const el = h('div', { class: `convert-row ${x.status}` },
      h('span', { class: 'convert-icon' }, icon(k.icon, 'sm')),
      h('div', { class: 'convert-name' }, h('div', { class: 'convert-file', title: x.path }, x.name),
        h('div', { class: 'faint mono convert-meta' }, `${k.label} · ${x.ext.toUpperCase()}${x.size != null ? ' · ' + formatBytes(x.size) : ''}`)),
      icon('arrow-right', 'sm'),
      sel,
      state,
      h('button', { class: 'icon-btn', 'data-tip': x.status === 'working' ? 'Stop' : 'Remove', onclick: () => this.remove(x) }, icon('x', 'sm')));
    el.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Show the original in its folder', icon: 'folder', action: () => api.reveal(x.path) },
      x.out.length ? { label: 'Open the result', icon: 'file', action: () => this.app.openPath(x.out[0]) } : null,
      { label: 'Remove from the list', icon: 'x', action: () => this.remove(x) },
    ].filter(Boolean)));
    return el;
  }

  renderFoot() {
    if (!this.foot) return;
    const waiting = this.items.filter((x) => x.status === 'ready' || x.status === 'error');
    // set every waiting file that can become it to one format
    const union = [...new Set(waiting.flatMap((x) => targetsFor(x.ext)))];
    const all = h('select', { class: 'convert-to', title: 'Set every file that can become it' },
      h('option', { value: '' }, 'Set all to…'), union.map((t) => h('option', { value: t }, TO_LABEL[t])));
    all.addEventListener('change', () => {
      for (const x of waiting) if (targetsFor(x.ext).includes(all.value)) x.to = all.value;
      this.renderList();
    });
    const where = this.outDir;
    // the size files shrink to, when any of them is set to
    let sizeBox = null;
    if (this.items.some((x) => x.to === 'size' && x.status !== 'done')) {
      const sz = this.shrinkSize;
      const num = h('input', { type: 'number', class: 'convert-size-n', min: '1', step: 'any', value: String(sz.n) });
      const unit = h('select', { class: 'convert-to convert-size-unit' }, Object.keys(UNITS).map((u) => h('option', { value: u, selected: u === sz.unit }, u)));
      const save = () => { const n = Number(num.value); if (n > 0) this.app.saveSettings({ convertSize: { n, unit: unit.value } }); };
      num.addEventListener('change', save);
      unit.addEventListener('change', save);
      sizeBox = h('label', { class: 'convert-where', title: 'Files set to “Shrink to a size” come out this size or smaller' }, h('span', { class: 'faint' }, 'Shrink to'), num, unit);
    }
    clear(this.foot).append(
      sizeBox,
      h('div', { class: 'convert-where' },
        h('span', { class: 'faint' }, 'Save to'),
        h('button', { class: 'btn sm ghost', title: where || 'Each converted file goes in the same folder as its original', onclick: (e) => contextMenu(e, [
          { label: 'Next to each original', checked: !where, action: () => { this.app.saveSettings({ convertDir: null }); this.renderFoot(); } },
          { label: 'A folder…', icon: 'folder', checked: !!where, action: async () => { const d = await pickFolder?.({ title: 'Save converted files to' }); if (d) { this.app.saveSettings({ convertDir: d }); this.renderFoot(); } } },
        ]) }, icon('folder', 'sm'), h('span', { class: 'convert-where-name' }, where ? basename(where) : 'Next to each original'), icon('chevron-down', 'sm'))),
      waiting.length > 1 && union.length ? all : null,
      h('div', { class: 'grow' }),
      this.items.some((x) => x.status === 'done') ? h('button', { class: 'btn sm ghost', onclick: () => { this.items = this.items.filter((x) => x.status !== 'done'); this.renderList(); this.refreshStatus(); } }, 'Clear finished') : null,
      h('button', { class: 'btn primary', disabled: !waiting.length || this.running, onclick: () => this.run() },
        icon('repeat', 'sm'), this.running ? 'Converting…' : `Convert${waiting.length > 1 ? ` ${waiting.length} files` : ''}`));
  }

  remove(x) {
    if (x.status === 'working') { x.stop = true; if (x.job) post('/api/job/cancel', { id: x.job }).catch(() => {}); return; }
    this.items.splice(this.items.indexOf(x), 1);
    this.renderList(); this.refreshStatus();
  }

  // ---------------------------------------------------------------- converting
  async run() {
    if (this.running) return;
    this.running = true;
    this.renderFoot();
    let ok = 0, bad = 0;
    for (const x of this.items.filter((i) => i.status === 'ready' || i.status === 'error')) {
      if (this.destroyed) break;
      x.status = 'working'; x.progress = 0; x.error = null; x.out = []; x.stop = false; x.note = null; x.outSize = null;
      this.renderList();
      try {
        x.out = await this.convert(x);
        x.status = 'done'; ok++;
      } catch (e) {
        x.status = 'error'; x.error = x.stop ? 'Stopped' : (e.message || String(e)); bad++;
      }
      this.renderList(); this.refreshStatus();
    }
    this.running = false;
    this.renderFoot();
    if (ok + bad > 1 || bad) toast(bad ? `Converted ${ok}, ${bad} didn’t work.` : `Converted ${ok} files.`, { type: bad ? 'warn' : 'ok' });
  }

  /** A free name for `name` in the output folder (`folder`: a new folder by that name). */
  async target(x, name, folder = false) {
    return (await post('/api/convert/name', { dir: this.outDir || dirname(x.path), name, folder })).path;
  }
  async writeOut(x, bytes, ext) {
    const p = await this.target(x, `${stripExt(x.name)}.${ext}`);
    await api.write(p, bytes);
    return [p];
  }

  get shrinkSize() {
    const s = this.settings.convertSize;
    return s && Number(s.n) > 0 && UNITS[s.unit] ? s : { n: 10, unit: 'MB' };
  }

  async convert(x) {
    const to = x.to;
    if (to === 'size') return this.shrink(x);
    if (MEDIA_TO.has(to) || (to === 'gif' && x.kind === 'video')) return this.media(x);
    const { bytes } = await api.read(x.path);
    x.progress = 0.2; this.renderList();
    if (x.kind === 'image') {
      const c = await loadImage(bytes, x.ext);
      const out = to === 'bmp' ? encodeBmp(c) : to === 'ico' ? await encodeIco(c) : to === 'pdf' ? await imageToPdf(bytes, x.ext, c)
        : await encodeCanvas(c, to, defaultOut(this.app, to));
      return this.writeOut(x, out, to);
    }
    if (x.kind === 'doc') {
      const out = await withEditor(this.app, 'doc', x.name, bytes, async (ed) => (to === 'pdf'
        ? api.printPdf(ed.standaloneHtml({ forPrint: true })) : ed.serialize(to)));
      return this.writeOut(x, await asBytes(out), to);
    }
    if (x.kind === 'sheet') return this.sheet(x, bytes);
    if (x.kind === 'pdf') return this.pdf(x, bytes);
    throw new Error('Can’t convert that.');
  }

  /** ffmpeg, as a job on the server; progress from its log. */
  async media(x) {
    const r = await post('/api/convert/media', { path: x.path, to: x.to, dir: this.outDir });
    x.job = r.id;
    for (;;) {
      await new Promise((res) => setTimeout(res, 400));
      const j = await api.get(`/api/job?id=${encodeURIComponent(r.id)}`);
      if (j.status === 'done') return [r.path];
      if (j.status === 'error' || j.status === 'cancelled') throw new Error(j.status === 'cancelled' ? 'Stopped' : j.error || 'ffmpeg couldn’t convert it.');
      if (Math.abs((j.progress || 0) - x.progress) > 0.01) { x.progress = j.progress || 0; this.renderList(); }
    }
  }

  // ---------------------------------------------------------------- shrinking to a size
  async shrink(x) {
    const sz = this.shrinkSize, limit = Math.floor(sz.n * UNITS[sz.unit]);
    const size = x.size ?? (await api.stat?.(x.path).catch(() => null))?.size;
    if (size != null && size <= limit) { x.note = `Already under ${sz.n} ${sz.unit}`; return []; }
    const name = (ext) => `${stripExt(x.name)} (${sizeTag(sz)}).${ext}`;
    const write = async (bytes, ext, note) => {
      const p = await this.target(x, name(ext));
      await api.write(p, bytes);
      x.note = note; x.outSize = bytes.length;
      return [p];
    };
    if (x.kind === 'image' && x.ext !== 'gif') return this.shrinkImage(x, limit, write);
    if (x.kind === 'pdf') return this.shrinkPdf(x, limit, write);
    // videos, sounds and GIFs through ffmpeg, anything else zipped: on the server
    const r = await post('/api/convert/shrink', { path: x.path, kind: x.ext === 'gif' ? 'gif' : x.kind, bytes: limit, tag: sizeTag(sz), dir: this.outDir });
    x.job = r.id;
    for (;;) {
      await new Promise((res) => setTimeout(res, 400));
      const j = await api.get(`/api/job?id=${encodeURIComponent(r.id)}`);
      if (j.status === 'done') {
        x.note = j.result?.note || null;
        x.outSize = (await api.stat?.(j.result.path).catch(() => null))?.size ?? null;
        return [j.result.path];
      }
      if (j.status === 'error' || j.status === 'cancelled') throw new Error(j.status === 'cancelled' ? 'Stopped' : j.error || 'Couldn’t shrink it.');
      if (Math.abs((j.progress || 0) - x.progress) > 0.01) { x.progress = j.progress || 0; this.renderList(); }
    }
  }

  /** The best quality that fits (JPG, or WebP when it has see-through parts); a smaller picture when even low quality doesn't. */
  async shrinkImage(x, limit, write) {
    const { bytes } = await api.read(x.path);
    let c = await loadImage(bytes, x.ext);
    const to = alphaInfo(c).transparent ? 'webp' : 'jpg';
    for (let round = 0; round < 10; round++) {
      if (x.stop) throw new Error('Stopped');
      let lo = 35, hi = 92, best = null, low = null;
      while (lo <= hi) {
        const q = (lo + hi) >> 1, out = await encodeCanvas(c, to, { quality: q });
        if (q === 35 || !low) low = out;
        if (out.length <= limit) { best = { out, q }; lo = q + 1; } else hi = q - 1;
      }
      x.progress = Math.min(0.95, (round + 1) / 6); this.renderList();
      if (best) return write(best.out, to, `${to.toUpperCase()}, ${c.width}×${c.height}, quality ${best.q}`);
      // too big even at low quality: a smaller picture, about as much smaller as needed
      const k = Math.max(0.3, Math.min(0.9, Math.sqrt(limit / low.length) * 0.95));
      const s = document.createElement('canvas');
      s.width = Math.max(1, Math.round(c.width * k)); s.height = Math.max(1, Math.round(c.height * k));
      const g = s.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(c, 0, 0, s.width, s.height);
      c = s;
    }
    throw new Error('Couldn’t get it that small.');
  }

  /** First repacked as it is (nothing lost); if that's still too big, its pages redrawn as pictures, smaller until it fits. */
  async shrinkPdf(x, limit, write) {
    const { bytes } = await api.read(x.path);
    const PDFLib = await vendor.pdfLib();
    try {
      const out = await (await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true })).save({ useObjectStreams: true });
      if (out.length <= limit) return write(out, 'pdf', 'Repacked, nothing lost');
    } catch { /* drawn as pictures below */ }
    const pdfjs = await vendor.pdfjs();
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const steps = [[150, 75], [120, 60], [96, 50], [80, 40], [64, 32], [50, 25]];
    try {
      for (let si = 0; si < steps.length; si++) {
        const [dpi, q] = steps[si];
        const out = await PDFLib.PDFDocument.create();
        for (let i = 1; i <= doc.numPages; i++) {
          if (x.stop) throw new Error('Stopped');
          const page = await doc.getPage(i);
          const pt = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: dpi / 72 });
          const c = document.createElement('canvas');
          c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: g, viewport: vp }).promise;
          const img = await out.embedJpg(await encodeCanvas(c, 'jpg', { quality: q }));
          out.addPage([pt.width, pt.height]).drawImage(img, { x: 0, y: 0, width: pt.width, height: pt.height });
          x.progress = Math.min(0.99, (si + i / doc.numPages) / steps.length); this.renderList();
        }
        const data = await out.save({ useObjectStreams: true });
        if (data.length <= limit) return write(data, 'pdf', `Pages as pictures at ${dpi} dpi: the text can’t be selected or searched any more`);
      }
    } finally { doc.destroy(); }
    throw new Error('Couldn’t get it that small, even with the pages as small pictures.');
  }

  async sheet(x, bytes) {
    const XLSX = await vendor.xlsx();
    const wb = ['csv', 'tsv'].includes(x.ext)
      ? XLSX.read(decodeText(bytes).text, { type: 'string', FS: x.ext === 'tsv' ? '\t' : undefined, raw: true })
      : XLSX.read(bytes, { type: 'array' });
    if (x.to === 'xlsx' || x.to === 'ods') return this.writeOut(x, new Uint8Array(XLSX.write(wb, { bookType: x.to, type: 'array' })), x.to);
    // CSV / TSV hold one sheet: a book with several becomes one file per sheet
    const out = [];
    for (const name of wb.SheetNames) {
      const text = XLSX.utils.sheet_to_csv(wb.Sheets[name], { FS: x.to === 'tsv' ? '\t' : ',', blankrows: false });
      const file = wb.SheetNames.length > 1 ? `${stripExt(x.name)} - ${name}.${x.to}` : `${stripExt(x.name)}.${x.to}`;
      const p = await this.target(x, file);
      await api.write(p, new TextEncoder().encode('﻿' + text)); // the BOM: Excel reads it as UTF-8
      out.push(p);
    }
    return out;
  }

  async pdf(x, bytes) {
    const pdfjs = await vendor.pdfjs();
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    try {
      if (x.to === 'txt') {
        const pages = [];
        for (let i = 1; i <= doc.numPages; i++) {
          if (x.stop) throw new Error('Stopped');
          const tc = await (await doc.getPage(i)).getTextContent();
          pages.push(tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('').replace(/[ \t]+\n/g, '\n').trim());
          x.progress = i / doc.numPages; this.renderList();
        }
        return this.writeOut(x, new TextEncoder().encode(pages.join('\n\n\f\n\n').replace(/\n/g, '\r\n')), 'txt');
      }
      // pages as pictures, at 150 dpi, in a new folder (one page: just the file)
      const one = doc.numPages === 1;
      const dir = one ? null : await this.target(x, `${stripExt(x.name)} (pages)`, true);
      const out = [];
      const pad = String(doc.numPages).length;
      for (let i = 1; i <= doc.numPages; i++) {
        if (x.stop) throw new Error('Stopped');
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 150 / 72 });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        const data = await encodeCanvas(c, x.to, defaultOut(this.app, x.to));
        const p = one ? await this.target(x, `${stripExt(x.name)}.${x.to}`) : inDir(dir, `Page ${String(i).padStart(pad, '0')}.${x.to}`);
        await api.write(p, data);
        out.push(p);
        x.progress = i / doc.numPages; this.renderList();
      }
      return out;
    } finally { doc.destroy(); }
  }

  status() {
    if (!this.items) return { left: [], right: [] };
    const done = this.items.filter((x) => x.status === 'done').length;
    return { left: [{ text: this.items.length ? `${this.items.length} file${this.items.length === 1 ? '' : 's'}` : 'Drop files to convert' }], right: done ? [{ text: `${done} converted` }] : [] };
  }

  destroy() {
    this.destroyed = true;
    for (const x of this.items || []) if (x.job && x.status === 'working') post('/api/job/cancel', { id: x.job }).catch(() => {});
  }
}
