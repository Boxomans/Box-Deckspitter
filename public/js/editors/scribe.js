// BoxScribe — offline OCR (image → text) with tesseract.js running locally: the engine and the English
// language data are served from node_modules, so nothing is uploaded anywhere.
// Images, pasted screenshots and (scanned) PDFs; drag a box to read just one area; low-confidence words
// are highlighted so you know what to double-check.

import { BaseEditor } from './base.js';
import { h, clear, vendor, basename, extOf, stripExt, debounce } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, errorToast, showMenu, modal } from '../core/ui.js';
import { api } from '../core/api.js';
import { pickOpen } from '../core/files.js';

const IMG_RE = /\.(png|jpe?g|jfif|webp|bmp|gif|tiff?)$/i;
const CORE = '/vendor/tesseract.js-core';
const LANG = '/vendor/@tesseract.js-data/eng/4.0.0_best_int';

let workerPromise = null;
/** One shared OCR engine for the whole app (loads once, ~2 s). */
function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const mod = await import('/vendor/tesseract.js/dist/tesseract.esm.min.js');
      const T = mod.default || mod;
      const worker = await T.createWorker('eng', T.OEM?.LSTM_ONLY ?? 1, {
        workerPath: '/vendor/tesseract.js/dist/worker.min.js',
        corePath: CORE,
        langPath: LANG,
        gzip: true,
        cacheMethod: 'none',
        logger: (m) => getWorker.progress?.(m),
      });
      return worker;
    })().catch((e) => { workerPromise = null; throw e; });
  }
  getWorker.progress = onProgress;
  return workerPromise;
}

export class ScribeEditor extends BaseEditor {
  static mode = 'scribe';

  async load(bytes, opts = {}) {
    this.pages = []; // { name, canvas, text, words, conf, done }
    this.cur = 0;
    this.clean = this.app.settings.scribeClean !== false;
    this.showBoxes = this.app.settings.scribeBoxes !== false;
    this.build();
    if (bytes && bytes.length) await this.addBytes(this.tab.title, bytes);
    if (opts.scribeSource) await this.addBytes(opts.scribeSource.name, opts.scribeSource.bytes);
  }

  build() {
    this.drop = h('div', { class: 'scribe-drop' },
      icon('scan-text', 'xl'),
      h('div', {}, h('b', {}, 'Drop images or a scanned PDF here'), ' — or paste a screenshot (Ctrl+V)'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => this.openFiles() }, icon('folder-open', 'sm'), 'Open images / PDF…'),
        h('button', { class: 'btn', onclick: () => this.fromDump() }, icon('image', 'sm'), 'From image dump')),
      h('div', { class: 'faint', style: { fontSize: '11px' } }, 'Runs entirely on this PC (offline). English text. Works best on clear, straight scans.'));
    this.stage = h('div', { class: 'scribe-stage' });
    this.overlay = h('canvas', { class: 'scribe-overlay' });
    this.img = h('canvas', { class: 'scribe-img' });
    this.selBox = h('div', { class: 'scribe-sel', hidden: true });
    this.imgWrap = h('div', { class: 'scribe-imgwrap' }, this.img, this.overlay, this.selBox);
    this.stage.append(this.imgWrap);
    this.pageNav = h('div', { class: 'scribe-pages' });
    this.progress = h('div', { class: 'vid-progress scribe-prog', hidden: true }, h('div', { class: 'vid-progress-bar' }));
    this.progressText = h('span', { class: 'mono faint scribe-progtext' });
    this.text = h('textarea', { class: 'scribe-text', spellcheck: 'true', placeholder: 'The text will appear here. You can edit it before copying or saving.' });
    this.text.addEventListener('input', debounce(() => { const p = this.pages[this.cur]; if (p) p.text = this.text.value; }, 200));
    this.confEl = h('span', { class: 'mono faint scribe-conf' });
    const boxesCb = h('input', { type: 'checkbox', checked: this.showBoxes });
    boxesCb.addEventListener('change', () => { this.showBoxes = boxesCb.checked; this.app.saveSettings({ scribeBoxes: this.showBoxes }); this.drawBoxes(); });
    const cleanCb = h('input', { type: 'checkbox', checked: this.clean });
    cleanCb.addEventListener('change', () => { this.clean = cleanCb.checked; this.app.saveSettings({ scribeClean: this.clean }); });
    this.left = h('div', { class: 'scribe-left' },
      h('div', { class: 'scribe-bar' },
        h('button', { class: 'btn sm', onclick: () => this.openFiles() }, icon('plus', 'sm'), 'Add'),
        h('button', { class: 'btn sm', 'data-tip': 'Add pictures from the image dump', onclick: () => this.fromDump() }, icon('image', 'sm'), 'Dump'),
        h('button', { class: 'btn sm primary', onclick: () => this.readAll() }, icon('scan-text', 'sm'), 'Read all'),
        h('button', { class: 'btn sm', 'data-tip': 'Read this page again', onclick: () => this.readPage(this.cur, null, true) }, icon('refresh', 'sm'), 'Re-read'),
        h('div', { class: 'grow' }),
        h('label', { class: 'check', 'data-tip': 'Enlarge small images and boost contrast before reading (more accurate)' }, cleanCb, 'clean up'),
        h('label', { class: 'check', 'data-tip': 'Show the words it found; pink = not sure' }, boxesCb, 'word boxes')),
      this.stage, this.pageNav,
      h('div', { class: 'faint scribe-hint' }, 'Tip: drag a box on the image to read just that part.'));
    this.right = h('div', { class: 'scribe-right' },
      h('div', { class: 'scribe-bar' }, h('b', {}, 'Text'), this.confEl, h('div', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: () => this.copyText() }, icon('copy', 'sm'), 'Copy'),
        h('button', { class: 'btn sm', 'data-tip': 'Save as a ✂ clip snippet named after the file', onclick: () => this.toSnippet(false) }, icon('pin', 'sm'), 'To clip'),
        h('button', { class: 'btn sm', 'data-tip': 'More', onclick: (e) => showMenu([
          { label: 'Copy all pages', icon: 'copy', action: () => this.copyText(true) },
          { label: 'Save as .txt…', icon: 'download', action: () => this.saveTxt() },
          { label: 'Open as document', icon: 'file-text', action: () => this.openAsDoc() },
          { label: 'Save this page to ✂ clip snippets', icon: 'copy', action: () => this.toSnippet(false) },
          { label: 'Save all pages to ✂ clip snippets', icon: 'copy', action: () => this.toSnippet(true) },
          { sep: true },
          { label: 'Clear everything', icon: 'trash', action: () => { this.pages = []; this.cur = 0; this.render(); } },
        ], { anchor: e.currentTarget }) }, icon('more', 'sm'))),
      this.progress, this.progressText, this.text);
    this.work = h('div', { class: 'scribe-work', hidden: true }, this.left, this.right);
    this.root = h('div', { class: 'scribe-root' },
      h('div', { class: 'scribe-head' }, h('span', { class: 'klep-title' }, h('span', { class: 'g scribe-g' }, this.app.toolLabel('BoxScribe'))), h('span', { class: 'klep-sub mono' }, '> pictures in, text out — offline')),
      this.drop, this.work);
    this.pane.append(this.root);

    // drop / paste
    this.root.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); this.root.classList.add('drop'); } });
    this.root.addEventListener('dragleave', (e) => { if (e.target === this.root) this.root.classList.remove('drop'); });
    this.root.addEventListener('drop', async (e) => {
      this.root.classList.remove('drop');
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      for (const f of e.dataTransfer.files) await this.addBytes(f.name, new Uint8Array(await f.arrayBuffer()));
      this.readAll(true);
    });
    this.pasteHandler = async (e) => {
      if (this.app.active !== this.tab || e.target === this.text) return;
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) await this.addBytes(`pasted-${Date.now().toString(36)}.png`, new Uint8Array(await f.arrayBuffer()));
      this.readAll(true);
    };
    document.addEventListener('paste', this.pasteHandler);
    this.wireSelect();
    this.ro = new ResizeObserver(() => this.drawBoxes());
    this.ro.observe(this.stage);
  }

  // ================================================================ inputs

  async openFiles() {
    const paths = await pickOpen({ multi: true, title: 'Pick images or a PDF to read', filters: [{ name: 'Images & PDFs', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'pdf'] }] });
    for (const p of paths || []) { try { const { bytes } = await api.read(p); await this.addBytes(basename(p), bytes); } catch (e) { errorToast(e, basename(p)); } }
    if (paths?.length) this.readAll(true);
  }

  async fromDump() {
    let items = [];
    try { items = (await api.dump('image')).items; } catch { /* ignore */ }
    if (!items.length) return toast('The image dump is empty — add screenshots or photos to it first.', { type: 'warn' });
    const picked = new Set();
    const grid = h('div', { class: 'mail-dumppick image' }, items.map((it) => {
      const b = h('button', { class: 'mail-dumpitem', title: it.name }, h('img', { src: it.url, alt: '' }), h('span', { class: 'mail-dumpname' }, it.name));
      b.addEventListener('click', () => { if (picked.has(it)) picked.delete(it); else picked.add(it); b.classList.toggle('on', picked.has(it)); });
      b.addEventListener('dblclick', () => { picked.clear(); picked.add(it); ctxRef?.close('ok'); });
      return b;
    }));
    let ctxRef = null;
    const res = await modal({ title: 'Read text from the image dump', wide: true, body: h('div', {}, h('div', { class: 'faint', style: { fontSize: '12px', marginBottom: '8px' } }, 'Pick one or more pictures (double-click to read just one).'), grid),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Read text', value: 'ok', primary: true }], onOpen: (c) => { ctxRef = c; } });
    if (res !== 'ok' || !picked.size) return;
    for (const it of picked) await this.addBytes(it.name, new Uint8Array(await (await fetch(it.url)).arrayBuffer()));
    this.cur = this.pages.length - picked.size;
    this.readAll(true);
  }

  /** Add an image or a PDF (each page becomes an item). */
  async addBytes(name, bytes) {
    const isPdf = extOf(name) === 'pdf' || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
    try {
      if (isPdf) {
        const pdfjs = await vendor.pdfjs();
        const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 300 / 72 }); // 300 dpi is the sweet spot for OCR
          const c = document.createElement('canvas');
          c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
          this.pages.push({ name: `${stripExt(name)} — page ${i}`, canvas: c, text: '', words: [], conf: null, done: false });
        }
        await doc.destroy();
      } else {
        const bmp = await createImageBitmap(new Blob([bytes]));
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        this.pages.push({ name, canvas: c, text: '', words: [], conf: null, done: false });
      }
    } catch (e) { errorToast(e, `Couldn’t open ${name}`); }
    if (this.pages.length && this.cur >= this.pages.length) this.cur = 0;
    this.render();
  }

  // ================================================================ OCR

  /** Upscale small images, greyscale and stretch contrast — makes a big difference for screenshots. */
  prepare(src) {
    if (!this.clean) return src;
    const k = Math.max(1, Math.min(3, 1800 / Math.max(src.width, 1)));
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * k);
    c.height = Math.round(src.height * k);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    let lo = 255, hi = 0;
    const lum = new Uint8ClampedArray(d.length / 4);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      lum[j] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // light text on a dark background (dark-mode screenshots) reads better inverted
    let sum = 0;
    for (const v of lum) sum += v;
    const invert = sum / lum.length < 110;
    const range = Math.max(1, hi - lo);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      let v = ((lum[j] - lo) / range) * 255;
      if (invert) v = 255 - v;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    c._scale = k;
    return c;
  }

  setProgress(p, label) {
    this.progress.hidden = p == null;
    this.progressText.textContent = label || '';
    if (p != null) this.progress.firstChild.style.width = Math.round(p * 100) + '%';
  }

  async readPage(i, rect = null, force = false) {
    const p = this.pages[i];
    if (!p || (p.done && !rect && !force)) return;
    try {
      this.setProgress(0, 'starting the OCR engine…');
      const worker = await getWorker((m) => {
        if (m.status === 'recognizing text') this.setProgress(m.progress, `reading ${this.pages.length > 1 ? `${i + 1} of ${this.pages.length}` : ''}… ${Math.round(m.progress * 100)}%`);
        else if (m.status) this.setProgress(m.progress ?? 0, m.status);
      });
      const src = this.prepare(p.canvas);
      const k = src._scale || 1;
      const opts = rect ? { rectangle: { left: Math.round(rect.x * k), top: Math.round(rect.y * k), width: Math.round(rect.w * k), height: Math.round(rect.h * k) } } : {};
      const { data } = await worker.recognize(src, opts, { text: true, blocks: true });
      const words = [];
      for (const b of data.blocks || []) for (const para of b.paragraphs || []) for (const line of para.lines || []) for (const w of line.words || []) {
        words.push({ text: w.text, conf: w.confidence, x0: w.bbox.x0 / k, y0: w.bbox.y0 / k, x1: w.bbox.x1 / k, y1: w.bbox.y1 / k });
      }
      const text = (data.text || '').replace(/\n{3,}/g, '\n\n').trim();
      if (rect) {
        // reading a selected area: put that text in (and select it) without losing the rest
        p.words = [...p.words.filter((w) => !(w.x0 >= rect.x && w.y0 >= rect.y && w.x1 <= rect.x + rect.w && w.y1 <= rect.y + rect.h)), ...words];
        if (i === this.cur) {
          const at = this.text.selectionStart ?? this.text.value.length;
          const before = this.text.value.slice(0, at);
          const ins = (before && !before.endsWith('\n') ? '\n' : '') + text + '\n';
          this.text.setRangeText(ins, at, this.text.selectionEnd ?? at, 'select');
          p.text = this.text.value;
        }
        this.lastArea = text;
        toast(text ? 'Read the selected area' : 'No text found in that area', { timeout: 1600 });
      } else {
        p.text = text;
        p.words = words;
        p.conf = data.confidence;
        p.done = true;
      }
      this.setProgress(null);
      this.render();
    } catch (e) {
      this.setProgress(null);
      errorToast(e, 'OCR failed');
    }
  }

  async readAll(onlyNew = false) {
    if (!this.pages.length) return this.openFiles();
    if (this.busy) return;
    this.busy = true;
    try {
      for (let i = 0; i < this.pages.length; i++) {
        if (onlyNew && this.pages[i].done) continue;
        this.cur = i;
        this.render();
        await this.readPage(i, null, !onlyNew);
      }
    } finally { this.busy = false; }
    const done = this.pages.filter((p) => p.done).length;
    if (done) toast(`Read ${done} page${done === 1 ? '' : 's'}`, { type: 'ok', timeout: 1600 });
  }

  // ================================================================ view

  render() {
    const has = this.pages.length > 0;
    this.drop.hidden = has;
    this.work.hidden = !has;
    if (!has) { this.refreshStatus(); return; }
    const p = this.pages[this.cur];
    this.img.width = p.canvas.width;
    this.img.height = p.canvas.height;
    this.img.getContext('2d').drawImage(p.canvas, 0, 0);
    if (document.activeElement !== this.text || this.text.value !== p.text) this.text.value = p.text;
    this.confEl.textContent = p.done ? `${Math.round(p.conf)}% sure` : 'not read yet';
    this.confEl.classList.toggle('low', p.done && p.conf < 70);
    clear(this.pageNav);
    if (this.pages.length > 1) {
      this.pages.forEach((pg, i) => this.pageNav.append(h('button', { class: `chip ${i === this.cur ? 'on' : ''} ${pg.done ? 'done' : ''}`, title: pg.name, onclick: () => { this.cur = i; this.render(); } }, String(i + 1))));
    }
    requestAnimationFrame(() => this.drawBoxes());
    this.refreshStatus();
  }

  drawBoxes() {
    const p = this.pages[this.cur];
    const ov = this.overlay;
    const r = this.img.getBoundingClientRect();
    if (!p || !r.width) return;
    ov.width = Math.round(r.width * devicePixelRatio);
    ov.height = Math.round(r.height * devicePixelRatio);
    ov.style.width = r.width + 'px';
    ov.style.height = r.height + 'px';
    const c = ov.getContext('2d');
    c.clearRect(0, 0, ov.width, ov.height);
    if (!this.showBoxes) return;
    const k = ov.width / p.canvas.width;
    for (const w of p.words) {
      if (!w.text.trim()) continue;
      const low = w.conf < 60;
      c.fillStyle = low ? 'rgba(255, 90, 160, 0.28)' : 'rgba(110, 231, 224, 0.14)';
      c.strokeStyle = low ? 'rgba(255, 90, 160, 0.9)' : 'rgba(110, 231, 224, 0.55)';
      c.lineWidth = Math.max(1, devicePixelRatio);
      c.fillRect(w.x0 * k, w.y0 * k, (w.x1 - w.x0) * k, (w.y1 - w.y0) * k);
      c.strokeRect(w.x0 * k, w.y0 * k, (w.x1 - w.x0) * k, (w.y1 - w.y0) * k);
    }
  }

  /** Drag a rectangle on the image to read just that area. */
  wireSelect() {
    let start = null;
    const toImg = (e) => {
      const r = this.img.getBoundingClientRect();
      const p = this.pages[this.cur];
      return { x: ((e.clientX - r.left) / r.width) * p.canvas.width, y: ((e.clientY - r.top) / r.height) * p.canvas.height, cx: e.clientX - r.left, cy: e.clientY - r.top };
    };
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.pages.length) return;
      e.preventDefault();
      start = toImg(e);
      this.overlay.setPointerCapture(e.pointerId);
      Object.assign(this.selBox.style, { left: start.cx + 'px', top: start.cy + 'px', width: '0px', height: '0px' });
      this.selBox.hidden = false;
    });
    this.overlay.addEventListener('pointermove', (e) => {
      if (!start) return;
      const pt = toImg(e);
      Object.assign(this.selBox.style, { left: Math.min(start.cx, pt.cx) + 'px', top: Math.min(start.cy, pt.cy) + 'px', width: Math.abs(pt.cx - start.cx) + 'px', height: Math.abs(pt.cy - start.cy) + 'px' });
    });
    this.overlay.addEventListener('pointerup', (e) => {
      if (!start) return;
      const pt = toImg(e);
      const rect = { x: Math.min(start.x, pt.x), y: Math.min(start.y, pt.y), w: Math.abs(pt.x - start.x), h: Math.abs(pt.y - start.y) };
      start = null;
      this.selBox.hidden = true;
      if (rect.w > 8 && rect.h > 8) this.readPage(this.cur, rect);
    });
  }

  // ================================================================ output

  /** The text → a ✂ clip snippet whose title is the file name (find it later in the clip tab). */
  toSnippet(all) {
    if (!this.app.clips) return;
    const p = this.pages[this.cur];
    const text = (all ? this.allText() : (this.text.value || p?.text || '')).trim();
    if (!text) return toast('Nothing to save yet — read the page first.', { type: 'warn' });
    const title = all ? (stripExt(this.pages[0]?.name || 'scan').replace(/ — page \d+$/, '') || 'scan') : (p?.name || 'scan');
    this.app.clips.addSnippet(title, text);
    toast(`Saved “${title}” to ✂ clip snippets`, { type: 'ok', timeout: 2200, action: { label: 'Show', fn: () => { if (this.app.rightPanel !== 'clip') this.app.toggleRightPanel('clip'); this.app.rightPanels?.clip?.panel?.setTab('snippets'); } } });
  }

  allText() { return this.pages.map((p, i) => (this.pages.length > 1 ? `— ${p.name} —\n` : '') + (p.text || '')).join('\n\n').trim(); }

  async copyText(all = false) {
    const text = all ? this.allText() : (this.text.value || '');
    if (!text.trim()) return toast('Nothing to copy yet.', { type: 'warn' });
    try { await navigator.clipboard.writeText(text); toast('Copied', { timeout: 1200 }); } catch (e) { errorToast(e); }
  }

  async saveTxt() {
    const text = this.allText();
    if (!text) return toast('Nothing to save yet.', { type: 'warn' });
    const name = (stripExt(this.pages[0]?.name || 'scan').replace(/ — page \d+$/, '') || 'scan') + ' (text).txt';
    await this.app.saveBytesAs(new TextEncoder().encode(text.replace(/\n/g, '\r\n')), { defaultName: name, filters: [{ name: 'Text', extensions: ['txt'] }] });
  }

  async openAsDoc() {
    const text = this.allText();
    if (!text) return toast('Nothing to open yet.', { type: 'warn' });
    const name = (stripExt(this.pages[0]?.name || 'scan').replace(/ — page \d+$/, '') || 'scan') + ' (text).txt';
    await this.app.openBytes(name, new TextEncoder().encode(text), { mode: 'doc' });
  }

  status() {
    const done = this.pages.filter((p) => p.done).length;
    return { left: [{ text: this.app.toolName('BoxScribe'), icon: 'scan-text' }, ...(this.pages.length ? [{ text: `${done}/${this.pages.length} read` }] : [])], right: [{ text: 'offline · English' }] };
  }

  saveFormats() { return []; }
  destroy() { document.removeEventListener('paste', this.pasteHandler); this.ro?.disconnect(); }
}

/** Open BoxScribe on some image/PDF bytes (used by the dumps, image editor and PDF editor menus). */
export async function scribeBytes(app, name, bytes) {
  let tab = app.tabs.find((t) => t.mode === 'scribe');
  if (!tab) tab = await app.newDocument('scribe');
  else app.activate(tab);
  const ed = tab?.editor;
  if (!ed) return;
  await ed.addBytes(name, bytes);
  ed.cur = ed.pages.length - 1;
  ed.readAll(true);
}
