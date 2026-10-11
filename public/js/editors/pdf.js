// PDF mode — view, annotate, fill forms, edit existing text, sign, and rearrange pages.

import { BaseEditor } from './base.js';
import { h, $$, clear, uid, clamp, debounce, vendor, blobToDataURL, stripExt, basename, extOf, toBytes } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { tbButton, tbSep, tbSelect, showMenu, contextMenu, modal, promptDialog, toast, errorToast, colorPopover, FindBar, buildRegex, confirmDialog, choiceDialog } from '../core/ui.js';
import { api } from '../core/api.js';
import { pickOpen } from '../core/files.js';
import {
  PT_TO_PX, totalRotation, displaySize, rawToDisp, dispToRaw, boxRawToDisp, boxDispToRaw, inkPath, PDF_FONTS, fontCss,
} from './pdf/geometry.js';
import { buildPdf, assetFromDataUrl } from './pdf/save.js';
import { DumpDock, DUMP_MIME } from './doc/image-dump.js';

// The plain PDF editor works in one of three modes. The Form filler (form.js) always fills.
const MODE_HINT = { edit: '', view: 'reading only · select text to copy', fill: 'click a field and type · Tab for the next one' };
const PDF_MODES = [['edit', 'Edit', 'Add text, marks, shapes, images and signatures; rearrange pages'], ['view', 'View', 'Just read: nothing on the page can be changed'], ['fill', 'Fill', 'Type into the form fields right on the page']];

const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const TOOLS = [
  ['select', 'pointer', 'Select, move & resize', 'V'],
  ['text', 'type', 'Add text', 'T'],
  ['edittext', 'edit-text', 'Edit existing text', 'E'],
  ['draw', 'pen', 'Draw', 'D'],
  ['highlight', 'highlighter', 'Highlight', 'H'],
  ['rect', 'square', 'Rectangle', 'R'],
  ['ellipse', 'circle', 'Ellipse', 'O'],
  ['arrow', 'arrow', 'Arrow', 'A'],
  ['line', 'line', 'Line', 'L'],
  ['whiteout', 'whiteout', 'Whiteout (covers content)', 'W'],
  ['image', 'image-plus', 'Image', 'I'],
  ['signature', 'signature', 'Signature', 'S'],
];
const TOOL_KEYS = Object.fromEntries(TOOLS.map(([id, , , k]) => [k.toLowerCase(), id]));
const BOX_TYPES = new Set(['rect', 'ellipse', 'highlight', 'whiteout', 'image', 'text']);

export class PdfEditor extends BaseEditor {
  static mode = 'pdf';

  async load(bytes, opts = {}) {
    this.pdfjs = await vendor.pdfjs();
    this.PDFLib = await vendor.pdfLib();
    this.sources = [];
    this.pages = [];
    this.assets = new Map();
    this.textCache = new Map();
    this.zoom = 1;
    this.tool = 'select';
    this.pdfMode = this.constructor.mode === 'pdf' ? (['edit', 'view', 'fill'].includes(this.app.settings.pdfMode) ? this.app.settings.pdfMode : 'edit') : 'fill';
    this.props = { stroke: '#e53935', fill: null, width: 2, opacity: 1, color: '#111111', font: 'Helvetica', size: 14, bold: false, italic: false, highlight: '#ffd54f', whiteout: '#ffffff' };
    this.undoStack = [];
    this.redoStack = [];
    this.selected = null;
    this.selPages = new Set();
    this.fields = [];
    this.formValues = {};
    this.formDirty = false;
    this.currentPage = 0;
    this.findHits = [];
    this.findIndex = -1;

    this.buildDom();
    if (opts.images?.length) bytes = await this.pdfFromImagePaths(opts.images);
    else if (!bytes || !bytes.length) bytes = await this.blankPdf();
    const src = await this.addSource(bytes, this.tab.title);
    this.pages = src.pageModels;
    await this.loadForms(src).catch((e) => console.warn('forms', e));
    this.renderAll();
  }

  get k() { return PT_TO_PX * this.zoom; }

  // =================================================================== sources

  async addSource(bytes, name) {
    const id = 's' + (this.sources.length + 1) + uid('');
    bytes = await this.unlockIfNeeded(bytes, name);
    const task = this.pdfjs.getDocument({
      data: bytes.slice(), isEvalSupported: false,
      cMapUrl: '/vendor/pdfjs-dist/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs-dist/standard_fonts/',
    });
    task.onPassword = (update, reason) => {
      promptDialog(reason === 2 ? 'Wrong password' : 'Password required', `“${name}” is password protected.`, '', { type: 'password' })
        .then((p) => (p == null ? task.destroy() : update(p)));
    };
    const doc = await task.promise;
    const src = { id, bytes: bytes.slice(), doc, name, pageModels: [] };
    for (let i = 0; i < doc.numPages; i++) {
      const p = await doc.getPage(i + 1);
      const [x1, y1, x2, y2] = p.view;
      src.pageModels.push({ id: uid('p'), src: id, index: i, w: x2 - x1, h: y2 - y1, view: [x1, y1, x2, y2], baseRotate: p.rotate || 0, rotate: 0, annots: [] });
    }
    this.sources.push(src);
    return src;
  }

  /** Encrypted forms that open without a password are decrypted to a normal copy so fields can be filled and saved. */
  async unlockIfNeeded(bytes, name) {
    if (!looksEncrypted(bytes)) return bytes;
    try {
      const r = await fetch('/api/pdf/unlock', { method: 'POST', headers: { 'X-BDS-Token': api.token }, body: bytes });
      if (!r.ok) return bytes; // needs a real password: pdf.js will ask for it
      const out = new Uint8Array(await r.arrayBuffer());
      this.unlocked = true;
      setTimeout(() => toast(`“${name}” was locked against editing, so Box-DocSpitter opened an unlocked copy — its fields can be filled and saved.`, { timeout: 6500 }), 600);
      return out;
    } catch { return bytes; }
  }

  async blankPdf(w = 612, hgt = 792) {
    const d = await this.PDFLib.PDFDocument.create();
    d.addPage([w, hgt]);
    return d.save();
  }

  async pdfFromImageBytes(list) {
    const d = await this.PDFLib.PDFDocument.create();
    for (const { bytes, name } of list) {
      const url = await blobToDataURL(new Blob([bytes], { type: mimeFor(name) }));
      const a = await assetFromDataUrl(url);
      const img = a.type === 'jpg' ? await d.embedJpg(a.bytes) : await d.embedPng(a.bytes);
      let w = a.w * 0.75;
      let hh = a.h * 0.75;
      const s = Math.min(1, 1440 / Math.max(w, hh));
      w *= s; hh *= s;
      const page = d.addPage([w, hh]);
      page.drawImage(img, { x: 0, y: 0, width: w, height: hh });
    }
    return d.save();
  }

  async pdfFromImagePaths(paths) {
    const list = [];
    for (const p of paths) { const { bytes } = await api.read(p); list.push({ bytes, name: basename(p) }); }
    return this.pdfFromImageBytes(list);
  }

  pdfPage(pm) {
    const src = this.sources.find((s) => s.id === pm.src);
    return src ? src.doc.getPage(pm.index + 1) : null;
  }

  textContent(pm) {
    const key = pm.src + ':' + pm.index;
    if (!this.textCache.has(key)) {
      const p = this.pdfPage(pm);
      this.textCache.set(key, p ? p.then((pg) => pg.getTextContent()) : Promise.resolve({ items: [], styles: {} }));
    }
    return this.textCache.get(key);
  }

  // =================================================================== forms

  async loadForms(src) {
    const L = this.PDFLib;
    let doc;
    try { doc = await L.PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false }); } catch { return; }
    let form;
    try { form = doc.getForm(); } catch { return; }
    const libPages = doc.getPages();
    for (const f of form.getFields()) {
      let type = null;
      if (f instanceof L.PDFTextField) type = 'text';
      else if (f instanceof L.PDFCheckBox) type = 'check';
      else if (f instanceof L.PDFDropdown) type = 'dropdown';
      else if (f instanceof L.PDFRadioGroup) type = 'radio';
      else if (f instanceof L.PDFOptionList) type = 'list';
      if (!type) continue;
      const name = f.getName();
      const entry = { name, type, widgets: [], options: [], readOnly: f.isReadOnly?.() };
      try {
        if (type === 'text') { this.formValues[name] = f.getText() || ''; entry.multiline = f.isMultiline(); entry.maxLength = f.getMaxLength?.(); }
        else if (type === 'check') this.formValues[name] = f.isChecked();
        else if (type === 'dropdown' || type === 'list') { entry.options = f.getOptions(); this.formValues[name] = f.getSelected()[0] || ''; }
        else if (type === 'radio') { entry.options = f.getOptions(); this.formValues[name] = f.getSelected() || ''; }
      } catch { /* odd field */ }
      const widgets = f.acroField.getWidgets();
      const onValues = type === 'radio' ? f.acroField.getOnValues?.() || [] : [];
      widgets.forEach((w, wi) => {
        const r = w.getRectangle();
        let idx = -1;
        const pref = w.P();
        if (pref) idx = libPages.findIndex((p) => p.ref === pref);
        if (idx < 0) {
          const wref = doc.context.getObjectRef(w.dict);
          idx = libPages.findIndex((p) => { const annots = p.node.Annots(); return annots && annots.asArray().some((x) => x === wref); });
        }
        const pm = src.pageModels[idx];
        if (!pm) return;
        const v = pm.view;
        entry.widgets.push({
          pageId: pm.id,
          box: { x: r.x - v[0], y: v[3] - (r.y + r.height), w: r.width, h: r.height },
          onValue: onValues[wi] ? (onValues[wi].decodeText ? onValues[wi].decodeText() : String(onValues[wi]).replace(/^\//, '')) : entry.options[wi],
        });
      });
      if (entry.widgets.length) this.fields.push(entry);
    }
    if (this.fields.length) setTimeout(() => toast(`This PDF has ${this.fields.length} fillable field${this.fields.length > 1 ? 's' : ''} — click them to fill in.`, { timeout: 4500 }), 500);
  }

  // =================================================================== DOM

  buildDom() {
    this.thumbs = h('div', { class: 'pdf-thumbs' });
    this.side = h('div', { class: 'pdf-side', hidden: this.app.settings.pdfThumbs === false }, h('div', { class: 'panel-head' }, 'Pages', h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', 'data-tip': 'Insert pages from file', onclick: () => this.insertFromFiles() }, icon('plus', 'sm'))), this.thumbs);
    this.pagesEl = h('div', { class: 'pdf-pages' });
    this.scroller = h('div', { class: 'pdf-scroller' }, this.pagesEl);
    this.main = h('div', { class: 'pdf-main' }, this.side, this.scroller);
    this.dumps = new DumpDock({
      app: this.app,
      onInsert: (url) => { if (!this.canEditMarks) this.setPdfMode('edit'); this.placeImage(url); },
      onSaveDoc: async () => ({ name: (stripExt(this.tab.title) || 'document') + '.pdf', bytes: await toBytes(await this.serialize('pdf')) }),
    });
    this.dump = this.dumps.image;
    this.root = h('div', { class: `pdf-root pdf-mode-${this.pdfMode}`, tabindex: '-1' }, this.main, this.dumps.el);
    this.pane.append(this.root);

    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.renderPage(e.target._pm);
    }, { root: this.scroller, rootMargin: '800px 0px' });
    this.thumbIo = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.renderThumb(e.target._pm, e.target);
    }, { root: this.thumbs, rootMargin: '400px 0px' });
    this.scroller.addEventListener('scroll', debounce(() => { this.trackCurrent(); this.renderVisible(); }, 80));
    this.thumbs.addEventListener('scroll', debounce(() => this.renderVisible(), 120));
    this.keyHandler = (e) => this.onKey(e);
    document.addEventListener('keydown', this.keyHandler);
    this.scroller.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      this.zoomBy(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  renderAll(keepScroll = true) {
    const ratio = keepScroll && this.scroller.scrollHeight ? this.scroller.scrollTop / this.scroller.scrollHeight : 0;
    for (const el of this.pagesEl.children) this.io.unobserve(el);
    clear(this.pagesEl);
    this.pageEls = new Map();
    this.pages.forEach((pm, i) => {
      const el = this.makePageEl(pm, i);
      this.pageEls.set(pm.id, el);
      this.pagesEl.append(el);
      this.io.observe(el);
    });
    this.renderThumbs();
    if (keepScroll) this.scroller.scrollTop = ratio * this.scroller.scrollHeight;
    this.refreshStatus();
    setTimeout(() => this.renderVisible(), 0);
  }

  /** Fallback for IntersectionObserver (which doesn't fire while the window isn't painting). */
  renderVisible() {
    const top = this.scroller.scrollTop - 800;
    const bottom = this.scroller.scrollTop + (this.scroller.clientHeight || 1200) + 800;
    for (const el of this.pagesEl.children) {
      if (el.offsetTop + el.offsetHeight >= top && el.offsetTop <= bottom) this.renderPage(el._pm);
    }
    const tTop = this.thumbs.scrollTop - 400;
    const tBottom = this.thumbs.scrollTop + (this.thumbs.clientHeight || 900) + 400;
    for (const el of this.thumbs.children) {
      if (el.offsetTop + el.offsetHeight >= tTop && el.offsetTop <= tBottom) this.renderThumb(el._pm, el);
    }
  }

  makePageEl(pm, i) {
    const k = this.k;
    const d = displaySize(pm);
    const el = h('div', { class: 'pdf-page', dataset: { id: pm.id }, style: { width: d.w * k + 'px', height: d.h * k + 'px', '--scale-factor': String(k) } });
    el.style.setProperty('--scale-factor', String(k));
    el._pm = pm;
    el._canvas = h('canvas', { class: 'pdf-canvas' });
    el._text = h('div', { class: 'textLayer' });
    el._svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el._svg.setAttribute('class', 'pdf-svg');
    el._svg.setAttribute('viewBox', `0 0 ${d.w} ${d.h}`);
    el._annots = h('div', { class: 'pdf-annots' });
    el._forms = h('div', { class: 'pdf-forms' });
    el._find = h('div', { class: 'pdf-findlayer' });
    el._capture = h('div', { class: 'pdf-capture' });
    el._hover = h('div', { class: 'pdf-hoverbox', hidden: true });
    el.append(el._canvas, el._text, el._find, el._svg, el._annots, el._forms, el._capture, el._hover, h('div', { class: 'pdf-pagenum' }, `${i + 1}`));
    this.wirePage(el);
    this.renderAnnots(pm, el);
    this.renderForms(pm, el);
    this.applyToolClass(el);
    return el;
  }

  async renderPage(pm, force = false) {
    const el = this.pageEls?.get(pm.id);
    if (!el) return;
    const r = totalRotation(pm);
    const k = this.k;
    const key = `${k}|${r}`;
    if (!force && el._renderedKey === key) return;
    el._renderedKey = key;
    const d = displaySize(pm);
    const canvas = el._canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let s = k * dpr;
    if (d.w * s * d.h * s > 24e6) s = Math.sqrt(24e6 / (d.w * d.h));
    canvas.style.width = d.w * k + 'px';
    canvas.style.height = d.h * k + 'px';
    if (pm.src === 'blank') {
      canvas.width = Math.round(d.w * s); canvas.height = Math.round(d.h * s);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      clear(el._text);
      return;
    }
    try {
      el._task?.cancel();
      const page = await this.pdfPage(pm);
      const vp = page.getViewport({ scale: s, rotation: r });
      const off = document.createElement('canvas');
      off.width = Math.round(vp.width);
      off.height = Math.round(vp.height);
      // 'print' intent renders without waiting on requestAnimationFrame, so pages still draw while the window is hidden
      el._task = page.render({
        canvasContext: off.getContext('2d'), viewport: vp, intent: 'print',
        annotationMode: this.fields.length ? this.pdfjs.AnnotationMode.ENABLE_FORMS : this.pdfjs.AnnotationMode.ENABLE,
      });
      await el._task.promise;
      if (el._renderedKey !== key) return;
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext('2d').drawImage(off, 0, 0);
      // selectable text layer
      clear(el._text);
      const tc = await this.textContent(pm);
      const tl = new this.pdfjs.TextLayer({ textContentSource: tc, container: el._text, viewport: page.getViewport({ scale: k, rotation: r }) });
      await tl.render();
      el._page = page;
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.warn('render', e);
    }
  }

  async renderToCanvas(pm, scale) {
    const d = displaySize(pm);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(d.w * scale);
    canvas.height = Math.round(d.h * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (pm.src === 'blank') return canvas;
    const page = await this.pdfPage(pm);
    await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale, rotation: totalRotation(pm) }), intent: 'print', annotationMode: this.pdfjs.AnnotationMode.ENABLE_FORMS }).promise;
    return canvas;
  }

  // =================================================================== thumbnails

  renderThumbs() {
    for (const el of this.thumbs.children) this.thumbIo.unobserve(el);
    clear(this.thumbs);
    this.pages.forEach((pm, i) => {
      const d = displaySize(pm);
      const w = 118;
      const cv = h('canvas', { class: 'pdf-thumb-canvas', style: { width: w + 'px', height: (w * d.h) / d.w + 'px' } });
      const el = h('div', { class: `pdf-thumb ${this.selPages.has(pm.id) ? 'selected' : ''} ${i === this.currentPage ? 'current' : ''}`, draggable: 'true', dataset: { id: pm.id } },
        cv, h('div', { class: 'pdf-thumb-num' }, String(i + 1), pm.annots.length ? h('span', { class: 'pdf-thumb-dot', title: 'Has annotations' }) : null));
      el._pm = pm;
      el._canvas = cv;
      el.addEventListener('click', (e) => this.thumbClick(pm, e));
      el.addEventListener('contextmenu', (e) => {
        if (!this.selPages.has(pm.id)) { this.selPages = new Set([pm.id]); this.renderThumbSelection(); }
        contextMenu(e, this.pageMenu());
      });
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/bds-page', pm.id); e.dataTransfer.effectAllowed = 'move'; });
      el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/bds-page')) { e.preventDefault(); const r = el.getBoundingClientRect(); el.classList.toggle('drop-before', e.clientY < r.top + r.height / 2); el.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
      el.addEventListener('drop', (e) => {
        const id = e.dataTransfer.getData('text/bds-page');
        const after = el.classList.contains('drop-after');
        el.classList.remove('drop-before', 'drop-after');
        if (!id || id === pm.id) return;
        e.preventDefault();
        this.movePage(id, pm.id, after);
      });
      this.thumbs.append(el);
      this.thumbIo.observe(el);
    });
  }

  renderThumbSelection() {
    for (const el of this.thumbs.children) {
      el.classList.toggle('selected', this.selPages.has(el.dataset.id));
      el.classList.toggle('current', this.pages[this.currentPage]?.id === el.dataset.id);
    }
  }

  async renderThumb(pm, el) {
    if (el._done) return;
    el._done = true;
    const d = displaySize(pm);
    const s = (118 / d.w) * Math.min(window.devicePixelRatio || 1, 2);
    const cv = el._canvas;
    cv.width = Math.round(d.w * s);
    cv.height = Math.round(d.h * s);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (pm.src === 'blank') return;
    try {
      const page = await this.pdfPage(pm);
      await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: s, rotation: totalRotation(pm) }), intent: 'print' }).promise;
    } catch { el._done = false; }
  }

  thumbClick(pm, e) {
    const i = this.pages.indexOf(pm);
    if (e.ctrlKey || e.metaKey) { this.selPages.has(pm.id) ? this.selPages.delete(pm.id) : this.selPages.add(pm.id); }
    else if (e.shiftKey && this.lastThumb != null) {
      const [a, b] = [Math.min(this.lastThumb, i), Math.max(this.lastThumb, i)];
      this.selPages = new Set(this.pages.slice(a, b + 1).map((p) => p.id));
    } else { this.selPages = new Set([pm.id]); this.scrollToPage(i); }
    this.lastThumb = i;
    this.renderThumbSelection();
  }

  scrollToPage(i) {
    const el = this.pagesEl.children[i];
    if (el) this.scroller.scrollTop = el.offsetTop - 16;
    this.currentPage = i;
    this.refreshStatus();
  }

  trackCurrent() {
    const mid = this.scroller.scrollTop + this.scroller.clientHeight * 0.35;
    let cur = 0;
    for (let i = 0; i < this.pagesEl.children.length; i++) if (this.pagesEl.children[i].offsetTop <= mid) cur = i;
    if (cur !== this.currentPage) {
      this.currentPage = cur;
      this.renderThumbSelection();
      const t = this.thumbs.children[cur];
      if (t && !this.side.hidden) {
        const tr = t.getBoundingClientRect();
        const sr = this.thumbs.getBoundingClientRect();
        if (tr.top < sr.top || tr.bottom > sr.bottom) t.scrollIntoView({ block: 'nearest' });
      }
      this.refreshStatus();
    }
  }

  // =================================================================== page operations

  targetPages() {
    if (this.selPages.size) return this.pages.filter((p) => this.selPages.has(p.id));
    return this.pages[this.currentPage] ? [this.pages[this.currentPage]] : [];
  }

  pageMenu() {
    const n = this.targetPages().length;
    const s = n > 1 ? `${n} pages` : 'page';
    return [
      { label: `Rotate ${s} right`, icon: 'rotate-cw', action: () => this.rotatePages(90) },
      { label: `Rotate ${s} left`, icon: 'rotate-ccw', action: () => this.rotatePages(-90) },
      { label: `Duplicate ${s}`, icon: 'copy', action: () => this.duplicatePages() },
      { label: 'Insert blank page after', icon: 'file-plus', action: () => this.insertBlank() },
      { label: 'Insert pages from file…', icon: 'layers', action: () => this.insertFromFiles() },
      { sep: true },
      { label: `Extract ${s} to new PDF…`, icon: 'split', action: () => this.extractPages() },
      { label: `Save ${s} as PNG…`, icon: 'image', action: () => this.exportPng() },
      { sep: true },
      { label: `Delete ${s}`, icon: 'trash', disabled: n >= this.pages.length, action: () => this.deletePages() },
    ];
  }

  rotatePages(delta) {
    const ts = this.targetPages();
    if (!ts.length) return;
    this.change(() => { for (const pm of ts) pm.rotate = ((pm.rotate || 0) + delta + 360) % 360; }, { relayout: true });
  }

  deletePages() {
    const ids = new Set(this.targetPages().map((p) => p.id));
    if (ids.size >= this.pages.length) return toast('A PDF needs at least one page.', { type: 'warn' });
    this.change(() => { this.pages = this.pages.filter((p) => !ids.has(p.id)); this.selPages.clear(); }, { relayout: true });
  }

  duplicatePages() {
    const ts = this.targetPages();
    this.change(() => {
      for (const pm of ts) {
        const copy = { ...structuredClone(pm), id: uid('p'), annots: pm.annots.map((a) => ({ ...structuredClone(a), id: uid('a') })) };
        this.pages.splice(this.pages.indexOf(pm) + 1, 0, copy);
      }
    }, { relayout: true });
  }

  insertBlank() {
    const ref = this.targetPages().pop() || this.pages[this.pages.length - 1];
    const idx = this.pages.indexOf(ref);
    const d = ref ? displaySize(ref) : { w: 612, h: 792 };
    this.change(() => { this.pages.splice(idx + 1, 0, { id: uid('p'), src: 'blank', index: 0, w: d.w, h: d.h, view: [0, 0, d.w, d.h], baseRotate: 0, rotate: 0, annots: [] }); }, { relayout: true });
    setTimeout(() => this.scrollToPage(idx + 1), 50);
  }

  async insertFromFiles() {
    const paths = await pickOpen({ multi: true, title: 'Insert pages from…', filters: [{ name: 'PDFs & images', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
    if (!paths) return;
    const at = (this.targetPages().pop() ? this.pages.indexOf(this.targetPages().pop()) : this.pages.length - 1) + 1;
    const newPages = [];
    try {
      const images = [];
      for (const p of paths) {
        const { bytes } = await api.read(p);
        if (extOf(p) === 'pdf') { const src = await this.addSource(bytes, basename(p)); newPages.push(...src.pageModels); }
        else images.push({ bytes, name: basename(p) });
      }
      if (images.length) { const src = await this.addSource(await this.pdfFromImageBytes(images), 'images'); newPages.push(...src.pageModels); }
    } catch (e) { return errorToast(e, 'Could not insert'); }
    this.change(() => { this.pages.splice(at, 0, ...newPages); }, { relayout: true });
    toast(`Inserted ${newPages.length} page${newPages.length > 1 ? 's' : ''}`, { type: 'ok' });
  }

  movePage(id, targetId, after) {
    this.change(() => {
      const from = this.pages.findIndex((p) => p.id === id);
      const [pm] = this.pages.splice(from, 1);
      let to = this.pages.findIndex((p) => p.id === targetId);
      if (after) to++;
      this.pages.splice(to, 0, pm);
    }, { relayout: true });
  }

  async extractPages() {
    const ts = this.targetPages();
    if (!ts.length) return;
    try {
      const { bytes } = await buildPdf(this, { pages: ts });
      const base = stripExt(this.tab.title);
      await this.app.saveBytesAs(bytes, { defaultName: `${base} (pages ${ts.map((p) => this.pages.indexOf(p) + 1).join(',')}).pdf`.slice(0, 120), filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
    } catch (e) { errorToast(e, 'Extract failed'); }
  }

  async exportPng() {
    const ts = this.targetPages();
    for (const pm of ts) {
      const canvas = await this.renderToCanvas(pm, 2.5);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const n = this.pages.indexOf(pm) + 1;
      const saved = await this.app.saveBytesAs(blob, { defaultName: `${stripExt(this.tab.title)} - page ${n}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }] });
      if (!saved) break;
    }
  }

  // =================================================================== history

  snapshot() { return JSON.stringify(this.pages); }

  change(fn, { relayout = false, pages = null } = {}) {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 120) this.undoStack.shift();
    this.redoStack = [];
    fn();
    this.markDirty();
    if (relayout) this.renderAll();
    else for (const pm of pages || this.pages) this.renderAnnots(pm);
    this.refreshStatus();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return toast('Nothing to undo', { timeout: 1200 });
    this.redoStack.push(this.snapshot());
    this.restore(prev);
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.restore(next);
  }

  restore(json) {
    const structureBefore = this.pages.map((p) => p.id + p.rotate).join();
    this.pages = JSON.parse(json);
    this.selected = null;
    this.markDirty();
    if (this.pages.map((p) => p.id + p.rotate).join() !== structureBefore) this.renderAll();
    else for (const pm of this.pages) this.renderAnnots(pm);
  }

  // =================================================================== annotations rendering

  findAnnot(id) {
    for (const pm of this.pages) { const a = pm.annots.find((x) => x.id === id); if (a) return { pm, a }; }
    return null;
  }

  renderAnnots(pm, el = this.pageEls?.get(pm.id)) {
    if (!el) return;
    const k = this.k;
    const r = totalRotation(pm);
    const W = pm.w;
    const H = pm.h;
    const svg = el._svg;
    while (svg.firstChild) svg.firstChild.remove();
    clear(el._annots);
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [a, v] of Object.entries(attrs)) if (v != null) n.setAttribute(a, v); return n; };
    const dpt = (x, y) => rawToDisp(x, y, W, H, r);
    for (const a of pm.annots) {
      const sel = this.selected === a.id;
      if (a.type === 'text' || a.type === 'image') {
        const box = boxRawToDisp(a, W, H, r);
        const delta = ((r - (a.rot || 0)) % 360 + 360) % 360;
        if (a.cover) {
          const c = boxRawToDisp(a.cover, W, H, r);
          svg.append(mk('rect', { x: c.x, y: c.y, width: c.w, height: c.h, fill: a.bg || '#ffffff', 'data-aid': a.id, class: 'pdf-hit' }));
        }
        const fw = delta % 180 ? box.h : box.w;
        const fh = delta % 180 ? box.w : box.h;
        const wrap = h('div', {
          class: `pdf-anno pdf-anno-${a.type} ${sel ? 'selected' : ''}`, dataset: { aid: a.id },
          style: { left: (box.x + box.w / 2 - fw / 2) * k + 'px', top: (box.y + box.h / 2 - fh / 2) * k + 'px', width: fw * k + 'px', height: fh * k + 'px', transform: delta ? `rotate(${delta}deg)` : '', opacity: a.opacity ?? 1 },
        });
        if (a.type === 'text') {
          const t = h('div', { class: 'pdf-text', style: {
            fontFamily: fontCss(a.font), fontSize: (a.size || 12) * k + 'px', color: a.color || '#111',
            fontWeight: a.bold ? 'bold' : 'normal', fontStyle: a.italic ? 'italic' : 'normal', padding: 2 * k + 'px', textAlign: a.align || 'left',
          } }, a.text || '');
          wrap.append(t);
          wrap._text = t;
        } else {
          const asset = this.assets.get(a.asset);
          wrap.append(h('img', { src: asset?.url || '', draggable: 'false', style: { width: '100%', height: '100%' } }));
        }
        if (sel) wrap.append(h('div', { class: 'pdf-handle br', dataset: { handle: 'br' } }));
        el._annots.append(wrap);
        continue;
      }
      const stroke = a.stroke || '#e53935';
      const width = a.width ?? 2;
      if (a.type === 'highlight' || a.type === 'whiteout' || a.type === 'rect' || a.type === 'ellipse') {
        const b = boxRawToDisp(a, W, H, r);
        let node;
        if (a.type === 'highlight') node = mk('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: a.color || '#ffd54f', 'fill-opacity': a.opacity ?? 0.4, style: 'mix-blend-mode:multiply' });
        else if (a.type === 'whiteout') node = mk('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: a.color || '#ffffff' });
        else if (a.type === 'rect') node = mk('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: a.fill || 'none', 'fill-opacity': a.opacity ?? 1, stroke, 'stroke-width': width, 'stroke-opacity': a.opacity ?? 1 });
        else node = mk('ellipse', { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2, fill: a.fill || 'none', 'fill-opacity': a.opacity ?? 1, stroke, 'stroke-width': width, 'stroke-opacity': a.opacity ?? 1 });
        node.setAttribute('data-aid', a.id);
        node.setAttribute('class', 'pdf-hit');
        svg.append(node);
        if (sel) {
          svg.append(mk('rect', { x: b.x - 2, y: b.y - 2, width: b.w + 4, height: b.h + 4, class: 'pdf-selrect' }));
          el._annots.append(h('div', { class: 'pdf-handle br free', dataset: { handle: 'br', aid: a.id }, style: { left: (b.x + b.w) * k + 'px', top: (b.y + b.h) * k + 'px' } }));
        }
      } else if (a.type === 'line' || a.type === 'arrow') {
        const [x1, y1] = dpt(a.x1, a.y1);
        const [x2, y2] = dpt(a.x2, a.y2);
        const g = mk('g', { 'data-aid': a.id, class: 'pdf-hit', opacity: a.opacity ?? 1 });
        g.append(mk('line', { x1, y1, x2, y2, stroke: 'transparent', 'stroke-width': Math.max(10, width + 8) }));
        g.append(mk('line', { x1, y1, x2, y2, stroke, 'stroke-width': width, 'stroke-linecap': 'round' }));
        if (a.type === 'arrow') {
          const ang = Math.atan2(y2 - y1, x2 - x1);
          const len = Math.max(8, width * 4);
          for (const s of [-1, 1]) {
            const t = ang + Math.PI + s * 0.45;
            g.append(mk('line', { x1: x2, y1: y2, x2: x2 + Math.cos(t) * len, y2: y2 + Math.sin(t) * len, stroke, 'stroke-width': width, 'stroke-linecap': 'round' }));
          }
        }
        svg.append(g);
        if (sel) {
          for (const [hx, hy, name] of [[x1, y1, 'p1'], [x2, y2, 'p2']]) el._annots.append(h('div', { class: 'pdf-handle free', dataset: { handle: name, aid: a.id }, style: { left: hx * k + 'px', top: hy * k + 'px' } }));
        }
      } else if (a.type === 'ink') {
        const d = inkPath(a.points, (p) => dpt(p[0], p[1]));
        const g = mk('g', { 'data-aid': a.id, class: 'pdf-hit' });
        g.append(mk('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(10, width + 8), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        g.append(mk('path', { d, fill: 'none', stroke, 'stroke-width': width, 'stroke-opacity': a.opacity ?? 1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        svg.append(g);
        if (sel) {
          const xs = a.points.map((p) => dpt(p[0], p[1]));
          const minX = Math.min(...xs.map((p) => p[0])); const maxX = Math.max(...xs.map((p) => p[0]));
          const minY = Math.min(...xs.map((p) => p[1])); const maxY = Math.max(...xs.map((p) => p[1]));
          svg.append(mk('rect', { x: minX - 4, y: minY - 4, width: maxX - minX + 8, height: maxY - minY + 8, class: 'pdf-selrect' }));
        }
      }
    }
    // thumbnails show a dot for annotated pages
    const thumb = this.thumbs.querySelector(`[data-id="${pm.id}"] .pdf-thumb-num`);
    if (thumb) { thumb.querySelector('.pdf-thumb-dot')?.remove(); if (pm.annots.length) thumb.append(h('span', { class: 'pdf-thumb-dot' })); }
  }

  renderForms(pm, el = this.pageEls?.get(pm.id)) {
    if (!el || !this.fields.length) return;
    clear(el._forms);
    const k = this.k;
    const r = totalRotation(pm);
    for (const f of this.fields) {
      if (f.readOnly) continue; // read-only (e.g. "for office use"): the page already shows it, so draw nothing
      f.widgets.forEach((w) => {
        if (w.pageId !== pm.id) return;
        const b = boxRawToDisp(w.box, pm.w, pm.h, r);
        const style = { left: b.x * k + 'px', top: b.y * k + 'px', width: b.w * k + 'px', height: b.h * k + 'px', fontSize: Math.max(8, Math.min(b.h * 0.7, 14)) * k + 'px' };
        let input;
        const set = (v) => { this.formValues[f.name] = v; this.formDirty = true; this.markDirty(); };
        if (f.type === 'text') {
          input = f.multiline ? h('textarea', { class: 'pdf-field', style }) : h('input', { type: 'text', class: 'pdf-field', style });
          input.value = this.formValues[f.name] || '';
          if (f.maxLength) input.maxLength = f.maxLength;
          input.addEventListener('input', () => {
            set(input.value);
            for (const other of this.pagesEl.querySelectorAll(`.pdf-field[data-field="${CSS.escape(f.name)}"]`)) if (other !== input) other.value = input.value;
          });
        } else if (f.type === 'check') {
          input = h('input', { type: 'checkbox', class: 'pdf-field pdf-check', style });
          input.checked = !!this.formValues[f.name];
          input.addEventListener('change', () => set(input.checked));
        } else if (f.type === 'radio') {
          input = h('input', { type: 'radio', class: 'pdf-field pdf-check', name: 'r-' + f.name + this.tab.id, style });
          input.checked = this.formValues[f.name] === w.onValue;
          input.addEventListener('change', () => { if (input.checked) set(w.onValue); });
        } else {
          input = h('select', { class: 'pdf-field', style }, h('option', { value: '' }, ''), f.options.map((o) => h('option', { value: o }, o)));
          input.value = this.formValues[f.name] || '';
          input.addEventListener('change', () => set(input.value));
        }
        input.dataset.field = f.name;
        input.title = f.name;
        if (this.pdfMode === 'view') { input.disabled = true; input.tabIndex = -1; }
        el._forms.append(input);
      });
    }
  }

  // =================================================================== pointer interaction

  applyToolClass(el) {
    el.classList.toggle('tool-select', this.tool === 'select');
    el.classList.toggle('tool-draw', this.tool !== 'select');
    el.dataset.tool = this.tool;
  }

  /** Whether marks can be added / moved / deleted right now (always in the Form filler). */
  get canEditMarks() { return this.pdfMode === 'edit'; }

  setPdfMode(m) {
    if (!['edit', 'view', 'fill'].includes(m) || this.constructor.mode !== 'pdf') return;
    this.pdfMode = m;
    this.app.saveSettings({ pdfMode: m });
    for (const x of ['edit', 'view', 'fill']) this.root.classList.toggle(`pdf-mode-${x}`, x === m);
    for (const b of this.modeSeg?.children || []) b.classList.toggle('on', b.dataset.mode === m);
    for (const el of this.editOnly || []) el.hidden = m !== 'edit';
    if (this.modeHint) this.modeHint.textContent = MODE_HINT[m];
    if (m !== 'edit') { this.selectAnnot(null); if (this.tool !== 'select') this.setTool('select'); }
    for (const pm of this.pages) this.renderForms(pm);
    this.refreshStatus();
  }

  async openFormFiller() {
    if (this.tab.dirty || !this.tab.path) {
      const c = await choiceDialog('Open in the Form filler', this.tab.path ? 'Save your changes first? The Form filler opens the saved file.' : 'Save this PDF first — the Form filler opens the saved file.', [
        { label: 'Cancel', value: 'cancel' }, { label: 'Save and open', value: 'save', primary: true },
      ]);
      if (c !== 'save' || !(await this.app.save(this.tab))) return;
    }
    this.app.reopenAs(this.tab, 'form');
  }

  setTool(t) {
    if (t !== 'select' && !this.canEditMarks && this.constructor.mode === 'pdf') this.setPdfMode('edit');
    if (t === 'signature') { this.chooseSignature(); return; }
    if (t === 'image' && this.tool !== 'image') { this.pendingImage = null; }
    this.tool = t;
    this.pendingSignature = null;
    this.selectAnnot(null);
    for (const el of this.pagesEl.children) { this.applyToolClass(el); el._hover.hidden = true; }
    if (this.toolBtns) for (const [id, b] of Object.entries(this.toolBtns)) b.classList.toggle('active', id === t);
    this.renderProps();
    this.refreshStatus();
  }

  /** Pointer position → {disp: [u,v] in points, raw: [x,y]} for a page element. */
  pointOn(el, e) {
    const pm = el._pm;
    const rect = el.getBoundingClientRect();
    const k = this.k;
    const u = (e.clientX - rect.left) / k;
    const v = (e.clientY - rect.top) / k;
    const r = totalRotation(pm);
    return { u, v, raw: dispToRaw(u, v, pm.w, pm.h, r), r };
  }

  wirePage(el) {
    el._capture.addEventListener('pointerdown', (e) => this.onCaptureDown(el, e));
    el._capture.addEventListener('pointermove', (e) => { if (this.tool === 'edittext') this.hoverText(el, e); });
    el._capture.addEventListener('pointerleave', () => { el._hover.hidden = true; });
    // selecting / moving existing annotations (select tool)
    el.addEventListener('pointerdown', (e) => {
      if (this.tool !== 'select' || !this.canEditMarks) return;
      const handle = e.target.closest('[data-handle]');
      const hit = e.target.closest('[data-aid]');
      if (handle) { this.startHandleDrag(el, e, handle); return; }
      if (hit) {
        const id = hit.dataset.aid;
        if (this.editingId === id) return;
        e.preventDefault();
        this.selectAnnot(id);
        this.startMove(el, e, id);
        return;
      }
      if (!e.target.closest('.pdf-field')) this.selectAnnot(null);
    });
    el.addEventListener('dblclick', (e) => {
      const hit = e.target.closest('[data-aid]');
      if (!hit || !this.canEditMarks) return;
      const f = this.findAnnot(hit.dataset.aid);
      if (f?.a.type === 'text') this.editText(f.a.id);
    });
    el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes(DUMP_MIME) || e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); } });
    el.addEventListener('drop', async (e) => {
      const url = e.dataTransfer.getData(DUMP_MIME);
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
      if (!url && !files.length) return;
      e.preventDefault();
      e.stopPropagation();
      const pt = this.pointOn(el, e);
      const dataUrl = url ? await blobToDataURL(await (await fetch(url)).blob()) : await blobToDataURL(files[0]);
      this.placeImage(dataUrl, { el, pt });
    });
  }

  onCaptureDown(el, e) {
    if (e.button !== 0) return;
    const pm = el._pm;
    const pt = this.pointOn(el, e);
    const t = this.tool;
    if (t === 'text') { e.preventDefault(); this.createText(pm, pt); return; }
    if (t === 'edittext') { e.preventDefault(); this.replaceTextAt(el, pt); return; }
    if (t === 'image') { e.preventDefault(); this.placeImageFromDisk(el, pt); return; }
    if (t === 'signature-place' && this.pendingSignature) { e.preventDefault(); this.placeImage(this.pendingSignature, { el, pt, signature: true }); return; }
    if (t === 'draw') { e.preventDefault(); this.drawInk(el, e); return; }
    if (['rect', 'ellipse', 'highlight', 'whiteout', 'line', 'arrow'].includes(t)) { e.preventDefault(); this.dragShape(el, e, t); }
  }

  dragShape(el, e, type) {
    const pm = el._pm;
    const start = this.pointOn(el, e);
    const k = this.k;
    const ghost = document.createElementNS('http://www.w3.org/2000/svg', type === 'ellipse' ? 'ellipse' : type === 'line' || type === 'arrow' ? 'line' : 'rect');
    ghost.setAttribute('class', 'pdf-ghost');
    el._svg.append(ghost);
    el._capture.setPointerCapture(e.pointerId);
    let end = start;
    const move = (ev) => {
      end = this.pointOn(el, ev);
      if (ev.shiftKey && (type === 'rect' || type === 'ellipse')) {
        const s = Math.max(Math.abs(end.u - start.u), Math.abs(end.v - start.v));
        end = { ...end, u: start.u + Math.sign(end.u - start.u || 1) * s, v: start.v + Math.sign(end.v - start.v || 1) * s };
      }
      const x = Math.min(start.u, end.u); const y = Math.min(start.v, end.v);
      const w = Math.abs(end.u - start.u); const hh = Math.abs(end.v - start.v);
      if (type === 'line' || type === 'arrow') Object.entries({ x1: start.u, y1: start.v, x2: end.u, y2: end.v }).forEach(([a, v]) => ghost.setAttribute(a, v));
      else if (type === 'ellipse') Object.entries({ cx: x + w / 2, cy: y + hh / 2, rx: w / 2, ry: hh / 2 }).forEach(([a, v]) => ghost.setAttribute(a, v));
      else Object.entries({ x, y, width: w, height: hh }).forEach(([a, v]) => ghost.setAttribute(a, v));
    };
    const up = () => {
      el._capture.removeEventListener('pointermove', move);
      el._capture.removeEventListener('pointerup', up);
      ghost.remove();
      const r = totalRotation(pm);
      const w = Math.abs(end.u - start.u);
      const hh = Math.abs(end.v - start.v);
      if (type === 'line' || type === 'arrow') {
        if (Math.hypot(w, hh) < 3) return;
        const [x1, y1] = dispToRaw(start.u, start.v, pm.w, pm.h, r);
        const [x2, y2] = dispToRaw(end.u, end.v, pm.w, pm.h, r);
        this.addAnnot(pm, { type, x1, y1, x2, y2, stroke: this.props.stroke, width: this.props.width, opacity: this.props.opacity });
        return;
      }
      if (w < 3 || hh < 3) return;
      const box = boxDispToRaw({ x: Math.min(start.u, end.u), y: Math.min(start.v, end.v), w, h: hh }, pm.w, pm.h, r);
      const extra = type === 'highlight' ? { color: this.props.highlight, opacity: 0.4 }
        : type === 'whiteout' ? { color: this.props.whiteout }
          : { stroke: this.props.stroke, width: this.props.width, fill: this.props.fill, opacity: this.props.opacity };
      this.addAnnot(pm, { type, ...box, ...extra });
    };
    el._capture.addEventListener('pointermove', move);
    el._capture.addEventListener('pointerup', up);
    move(e);
    void k;
  }

  drawInk(el, e) {
    const pm = el._pm;
    const r = totalRotation(pm);
    const pts = [];
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', this.props.stroke);
    path.setAttribute('stroke-width', this.props.width);
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-opacity', this.props.opacity);
    el._svg.append(path);
    el._capture.setPointerCapture(e.pointerId);
    const add = (ev) => {
      const p = this.pointOn(el, ev);
      const last = pts[pts.length - 1];
      if (last && Math.hypot(last[0] - p.u, last[1] - p.v) < 0.8) return;
      pts.push([p.u, p.v]);
      path.setAttribute('d', inkPath(pts));
    };
    const move = (ev) => { for (const ce of ev.getCoalescedEvents?.() || [ev]) add(ce); };
    const up = () => {
      el._capture.removeEventListener('pointermove', move);
      el._capture.removeEventListener('pointerup', up);
      path.remove();
      if (!pts.length) return;
      const raw = pts.map(([u, v]) => dispToRaw(u, v, pm.w, pm.h, r).map((n) => +n.toFixed(2)));
      this.addAnnot(pm, { type: 'ink', points: raw, stroke: this.props.stroke, width: this.props.width, opacity: this.props.opacity }, { keepTool: true });
    };
    el._capture.addEventListener('pointermove', move);
    el._capture.addEventListener('pointerup', up);
    add(e);
  }

  addAnnot(pm, a, { keepTool = false, select = true } = {}) {
    const ann = { id: uid('a'), ...a };
    this.change(() => { pm.annots.push(ann); }, { pages: [pm] });
    if (select && !keepTool && this.app.settings.pdfStickyTools !== true) {
      this.setTool('select');
      this.selectAnnot(ann.id);
    }
    return ann;
  }

  selectAnnot(id) {
    if (this.selected === id) return;
    const prev = this.selected ? this.findAnnot(this.selected) : null;
    this.selected = id;
    if (prev) this.renderAnnots(prev.pm);
    const cur = id ? this.findAnnot(id) : null;
    if (cur) { this.renderAnnots(cur.pm); this.syncPropsFrom(cur.a); }
    this.renderProps();
  }

  startMove(el, e, id) {
    const f = this.findAnnot(id);
    if (!f) return;
    const { pm, a } = f;
    const r = totalRotation(pm);
    const k = this.k;
    const sx = e.clientX;
    const sy = e.clientY;
    const before = this.snapshot();
    const orig = structuredClone(a);
    let moved = false;
    const move = (ev) => {
      const du = (ev.clientX - sx) / k;
      const dv = (ev.clientY - sy) / k;
      if (!moved && Math.hypot(du, dv) < 1.5) return;
      moved = true;
      const [ox, oy] = dispToRaw(0, 0, pm.w, pm.h, r);
      const [dx1, dy1] = dispToRaw(du, dv, pm.w, pm.h, r);
      const dx = dx1 - ox;
      const dy = dy1 - oy;
      Object.assign(a, translate(orig, dx, dy));
      this.renderAnnots(pm);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) { this.undoStack.push(before); this.redoStack = []; this.markDirty(); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  startHandleDrag(el, e, handle) {
    e.preventDefault();
    e.stopPropagation();
    const id = handle.dataset.aid || handle.closest('[data-aid]')?.dataset.aid || this.selected;
    const f = this.findAnnot(id);
    if (!f) return;
    const { pm, a } = f;
    const r = totalRotation(pm);
    const before = this.snapshot();
    const orig = structuredClone(a);
    const startPt = this.pointOn(el, e);
    const dbox = BOX_TYPES.has(a.type) ? boxRawToDisp(orig, pm.w, pm.h, r) : null;
    const move = (ev) => {
      const p = this.pointOn(el, ev);
      if (handle.dataset.handle === 'p1' || handle.dataset.handle === 'p2') {
        const [x, y] = dispToRaw(p.u, p.v, pm.w, pm.h, r);
        if (handle.dataset.handle === 'p1') { a.x1 = x; a.y1 = y; } else { a.x2 = x; a.y2 = y; }
      } else if (dbox) {
        let w = Math.max(4, dbox.w + (p.u - startPt.u));
        let hh = Math.max(4, dbox.h + (p.v - startPt.v));
        if (a.type === 'image' || a.type === 'text' || ev.shiftKey) { const s = Math.max(w / dbox.w, hh / dbox.h); w = dbox.w * s; hh = dbox.h * s; }
        if (a.type === 'text') {
          a.size = Math.max(4, +(orig.size * (hh / dbox.h)).toFixed(1));
          this.renderAnnots(pm);
          this.fitTextBox(pm, a);
          return;
        }
        Object.assign(a, boxDispToRaw({ x: dbox.x, y: dbox.y, w, h: hh }, pm.w, pm.h, r));
      }
      this.renderAnnots(pm);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.undoStack.push(before);
      this.redoStack = [];
      this.markDirty();
      this.syncPropsFrom(a);
      this.renderProps();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  deleteSelected() {
    const f = this.selected && this.findAnnot(this.selected);
    if (!f) return false;
    this.change(() => { f.pm.annots = f.pm.annots.filter((x) => x.id !== f.a.id); }, { pages: [f.pm] });
    this.selected = null;
    this.renderProps();
    return true;
  }

  nudge(dx, dy) {
    const f = this.selected && this.findAnnot(this.selected);
    if (!f) return;
    const r = totalRotation(f.pm);
    const [ox, oy] = dispToRaw(0, 0, f.pm.w, f.pm.h, r);
    const [x1, y1] = dispToRaw(dx, dy, f.pm.w, f.pm.h, r);
    this.change(() => { Object.assign(f.a, translate(structuredClone(f.a), x1 - ox, y1 - oy)); }, { pages: [f.pm] });
  }

  // =================================================================== text

  createText(pm, pt) {
    const size = this.props.size;
    const r = pt.r;
    const frame = { x: pt.u, y: pt.v - size * 0.7, w: size * 4, h: size * 1.2 + 4 };
    const raw = boxDispToRaw(frame, pm.w, pm.h, r);
    const a = this.addAnnot(pm, { type: 'text', ...raw, rot: r, text: '', font: this.props.font, size, color: this.props.color, bold: this.props.bold, italic: this.props.italic });
    this.editText(a.id, true);
  }

  editText(id, isNew = false, selectAll = false) {
    const f = this.findAnnot(id);
    if (!f) return;
    this.selectAnnot(id);
    const el = this.pageEls.get(f.pm.id);
    const wrap = el._annots.querySelector(`[data-aid="${id}"]`);
    const t = wrap?._text;
    if (!t) return;
    this.editingId = id;
    wrap.classList.add('editing');
    t.contentEditable = 'plaintext-only';
    t.spellcheck = true;
    t.focus();
    const range = document.createRange();
    range.selectNodeContents(t);
    if (!selectAll) range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const before = isNew ? null : this.snapshot();
    const onInput = () => {
      f.a.text = t.innerText.replace(/\n$/, '');
      this.fitTextBox(f.pm, f.a, wrap);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); t.blur(); }
      e.stopPropagation();
    };
    const finish = () => {
      t.removeEventListener('input', onInput);
      t.removeEventListener('keydown', onKey);
      t.contentEditable = 'false';
      this.editingId = null;
      f.a.text = t.innerText.replace(/\n$/, '');
      if (!f.a.text.trim() && !f.a.cover) {
        f.pm.annots = f.pm.annots.filter((x) => x.id !== f.a.id);
        if (this.selected === f.a.id) this.selected = null;
      } else if (before && before !== this.snapshot()) { this.undoStack.push(before); this.redoStack = []; }
      this.markDirty();
      this.renderAnnots(f.pm);
      this.renderProps();
    };
    t.addEventListener('input', onInput);
    t.addEventListener('keydown', onKey);
    t.addEventListener('blur', finish, { once: true });
  }

  /** Resize a text annotation's box to fit its content (frame top-left stays put). */
  fitTextBox(pm, a, wrap) {
    const el = this.pageEls.get(pm.id);
    wrap = wrap || el?._annots.querySelector(`[data-aid="${a.id}"]`);
    const t = wrap?._text;
    if (!t) return;
    const k = this.k;
    const meas = h('div', { style: { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', font: getComputedStyle(t).font, padding: t.style.padding, left: '-9999px', top: '0' } }, (a.text || ' ') + (a.text?.endsWith('\n') ? ' ' : ''));
    document.body.append(meas);
    const fw = Math.max(meas.offsetWidth, (a.size || 12) * k * 1.5) / k + 1;
    const fh = meas.offsetHeight / k;
    meas.remove();
    const rot = a.rot || 0;
    const fb = boxRawToDisp(a, pm.w, pm.h, rot);
    Object.assign(a, boxDispToRaw({ x: fb.x, y: fb.y, w: Math.max(fw, a.cover && !a.grown ? 0 : 0), h: fh }, pm.w, pm.h, rot));
    // live-update element size without a full re-render (keeps the caret)
    const r = totalRotation(pm);
    const box = boxRawToDisp(a, pm.w, pm.h, r);
    const delta = ((r - rot) % 360 + 360) % 360;
    const w2 = delta % 180 ? box.h : box.w;
    const h2 = delta % 180 ? box.w : box.h;
    Object.assign(wrap.style, { left: (box.x + box.w / 2 - w2 / 2) * k + 'px', top: (box.y + box.h / 2 - h2 / 2) * k + 'px', width: w2 * k + 'px', height: h2 * k + 'px' });
  }

  // edit existing text: hover shows text runs, click replaces one with an editable copy
  async textItems(pm) {
    if (pm.src === 'blank') return [];
    if (pm._items) return pm._items;
    const tc = await this.textContent(pm);
    const page = await this.pdfPage(pm);
    const v = pm.view;
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const [a, b, c, d, e, f] = it.transform;
      if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0) continue;
      const size = Math.abs(d) || Math.hypot(c, d);
      const base = v[3] - f;
      let fontName = '';
      try { if (page.commonObjs.has(it.fontName)) fontName = page.commonObjs.get(it.fontName)?.name || ''; } catch { /* ignore */ }
      const generic = tc.styles?.[it.fontName]?.fontFamily || '';
      items.push({ str: it.str, x: e - v[0], y: base - size * 0.86, w: it.width, h: size * 1.1, size, fontName, generic });
    }
    Object.defineProperty(pm, '_items', { value: items, enumerable: false, configurable: true, writable: true });
    return items;
  }

  async hoverText(el, e) {
    const pm = el._pm;
    const pt = this.pointOn(el, e);
    const items = await this.textItems(pm);
    const [x, y] = pt.raw;
    const it = items.find((i) => x >= i.x - 1 && x <= i.x + i.w + 1 && y >= i.y - 1 && y <= i.y + i.h + 1);
    if (!it) { el._hover.hidden = true; el._hoverItem = null; return; }
    const b = boxRawToDisp(it, pm.w, pm.h, pt.r);
    const k = this.k;
    Object.assign(el._hover.style, { left: b.x * k + 'px', top: b.y * k + 'px', width: b.w * k + 'px', height: b.h * k + 'px' });
    el._hover.hidden = false;
    el._hoverItem = it;
  }

  async replaceTextAt(el, pt) {
    const pm = el._pm;
    const items = await this.textItems(pm);
    const [x, y] = pt.raw;
    const it = items.find((i) => x >= i.x - 1 && x <= i.x + i.w + 1 && y >= i.y - 1 && y <= i.y + i.h + 1);
    if (!it) { toast('Click directly on a line of text to edit it.', { timeout: 2000 }); return; }
    el._hover.hidden = true;
    const name = it.fontName.replace(/^[A-Z]{6}\+/, '');
    const sys = PDF_FONTS.find((f) => !f.std && name.toLowerCase().replace(/[^a-z]/g, '').startsWith(f.id.toLowerCase().replace(/[^a-z]/g, '')));
    let font = sys ? sys.id : 'Helvetica';
    if (!sys) {
      if (/times|serif|georgia|garamond|cambria|book|roman/i.test(name) || (it.generic === 'serif' && !/sans/i.test(name))) font = 'Times';
      else if (/courier|mono|consol/i.test(name) || it.generic === 'monospace') font = 'Courier';
    }
    const pad = 2;
    const a = this.addAnnot(pm, {
      type: 'text', x: it.x - pad, y: it.y - pad + it.h * 0.02, w: it.w + pad * 2, h: it.size * 1.2 + pad * 2, rot: 0,
      text: it.str, font, size: +it.size.toFixed(2), color: this.props.color === '#111111' ? '#000000' : this.props.color,
      bold: /bold|black|heavy|semibold/i.test(name), italic: /italic|oblique/i.test(name),
      cover: { x: it.x - 1, y: it.y - 1, w: it.w + 2, h: it.h + 2 }, bg: this.props.whiteout,
    }, { keepTool: true });
    this.selectAnnot(a.id);
    this.editText(a.id, true, true);
  }

  // =================================================================== images & signatures

  async placeImageFromDisk(el, pt) {
    const paths = await pickOpen({ title: 'Choose image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'] }] });
    if (!paths) return;
    const { bytes } = await api.read(paths[0]);
    const url = await blobToDataURL(new Blob([bytes], { type: mimeFor(paths[0]) }));
    this.placeImage(url, { el, pt });
  }

  async placeImage(url, { el, pt, signature = false } = {}) {
    let asset;
    try { asset = await assetFromDataUrl(url); } catch (e) { return errorToast(e, 'Unsupported image'); }
    const id = 'img' + uid('');
    this.assets.set(id, asset);
    if (!el) {
      el = this.pagesEl.children[this.currentPage];
      const pm = el._pm;
      const d = displaySize(pm);
      pt = { u: d.w / 2, v: d.h / 2, r: totalRotation(pm), center: true };
    }
    const pm = el._pm;
    const maxW = signature ? 180 : 260;
    let w = asset.w * 0.75;
    let hh = asset.h * 0.75;
    const s = Math.min(1, maxW / w);
    w *= s; hh *= s;
    const frame = { x: pt.u - (pt.center ? w / 2 : 0), y: pt.v - (pt.center ? hh / 2 : 0), w, h: hh };
    const r = totalRotation(pm);
    const raw = boxDispToRaw(frame, pm.w, pm.h, r);
    this.addAnnot(pm, { type: 'image', ...raw, rot: r, asset: id });
  }

  async chooseSignature() {
    const { signatureDialog } = await import('./pdf/signature.js');
    const url = await signatureDialog(this.app);
    if (!url) return;
    this.tool = 'signature-place';
    this.pendingSignature = url;
    for (const el of this.pagesEl.children) this.applyToolClass(el);
    if (this.toolBtns) for (const [id, b] of Object.entries(this.toolBtns)) b.classList.toggle('active', id === 'signature');
    toast('Click where the signature should go.', { timeout: 2500 });
    this.refreshStatus();
  }

  // =================================================================== toolbar & properties

  buildToolbar() {
    this.toolBtns = {};
    const tools = TOOLS.map(([id, ic, tip, key]) => {
      const b = tbButton(ic, tip, () => this.setTool(id), { key });
      if (id === this.tool) b.classList.add('active');
      this.toolBtns[id] = b;
      return b;
    });
    this.zoomSel = tbSelect([...ZOOMS.map((z) => ({ value: String(z), label: Math.round(z * 100) + '%' })), { value: 'width', label: 'Fit width' }, { value: 'page', label: 'Fit page' }],
      (v) => this.setZoom(v), { tip: 'Zoom', width: '92px', value: '1' });
    this.propsEl = h('div', { class: 'tb-group pdf-props' });
    this.modeSeg = h('div', { class: 'seg pdf-modeseg' }, PDF_MODES.map(([m, label, tip]) =>
      h('button', { class: this.pdfMode === m ? 'on' : '', dataset: { mode: m }, 'data-tip': tip, onclick: () => this.setPdfMode(m) }, label)));
    const formBtn = tbButton('form-fill', 'Open in the Form filler: field list, progress, autofill, stamps and Finalize', () => this.openFormFiller(), { text: 'Form filler' });
    const editOnly = [
      tbButton('undo', 'Undo', () => this.undo(), { key: 'Ctrl+Z' }),
      tbButton('redo', 'Redo', () => this.redo(), { key: 'Ctrl+Y' }),
      tbSep(),
      ...tools,
      tbSep(),
      this.propsEl,
    ];
    const editOnlyRight = [
      tbButton('rotate-ccw', 'Rotate page left', () => this.rotatePages(-90)),
      tbButton('rotate-cw', 'Rotate page right', () => this.rotatePages(90)),
      tbButton('pages', 'Page tools', (e) => showMenu(this.pageMenu(), { anchor: e.currentTarget })),
      tbSep(),
    ];
    this.editOnly = [...editOnly, ...editOnlyRight];
    for (const el of this.editOnly) el.hidden = this.pdfMode !== 'edit';
    this.modeHint = h('span', { class: 'pdf-modehint faint mono' }, MODE_HINT[this.pdfMode]);
    const tb = h('div', { class: 'toolbar pdf-toolbar' },
      this.modeSeg, formBtn, tbSep(),
      ...editOnly,
      this.modeHint,
      h('div', { class: 'grow' }),
      ...editOnlyRight,
      tbButton('zoom-out', 'Zoom out', () => this.zoomBy(-1), { key: 'Ctrl+-' }),
      this.zoomSel,
      tbButton('zoom-in', 'Zoom in', () => this.zoomBy(1), { key: 'Ctrl+=' }),
      tbSep(),
      tbButton('search', 'Find text', () => this.find(), { key: 'Ctrl+F' }),
      tbButton('sidebar', 'Page thumbnails', () => this.toggleSide()),
    );
    this.renderProps();
    return tb;
  }

  syncPropsFrom(a) {
    if (!a) return;
    if (a.stroke) this.props.stroke = a.stroke;
    if (a.width) this.props.width = a.width;
    if (a.type === 'text') Object.assign(this.props, { color: a.color || this.props.color, font: a.font || this.props.font, size: a.size || this.props.size, bold: !!a.bold, italic: !!a.italic });
  }

  updateSelected(patch) {
    const f = this.selected && this.findAnnot(this.selected);
    if (!f) return;
    this.change(() => { Object.assign(f.a, patch); }, { pages: [f.pm] });
    if (f.a.type === 'text') this.fitTextBox(f.pm, f.a);
  }

  renderProps() {
    if (!this.propsEl) return;
    const p = this.props;
    const f = this.selected && this.findAnnot(this.selected);
    const kind = f ? f.a.type : this.tool;
    clear(this.propsEl);
    const colorBtn = (value, tip, onPick, allowNone) => {
      const b = h('button', { class: 'icon-btn color-swatch-btn', 'data-tip': tip }, h('span', { class: 'swatch-dot', style: { background: value || 'transparent' } }));
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => colorPopover(b, { allowNone, noneLabel: 'No fill', onPick }));
      return b;
    };
    const widthSel = () => tbSelect([0.5, 1, 2, 3, 4, 6, 8, 12].map((w) => ({ value: String(w), label: w + ' pt' })), (v) => { p.width = Number(v); this.updateSelected({ width: p.width }); }, { tip: 'Line width', width: '68px', value: String(p.width) });
    const opacitySel = () => tbSelect([1, 0.75, 0.5, 0.25].map((o) => ({ value: String(o), label: Math.round(o * 100) + '%' })), (v) => { p.opacity = Number(v); this.updateSelected({ opacity: p.opacity }); }, { tip: 'Opacity', width: '64px', value: String(p.opacity) });
    if (kind === 'text' || kind === 'edittext') {
      const fontSel = tbSelect(PDF_FONTS.map((x) => ({ value: x.id, label: x.label, style: `font-family:${x.css}` })), (v) => { p.font = v; this.updateSelected({ font: v }); }, { tip: 'Font', width: '120px', value: p.font });
      const size = h('input', { type: 'text', class: 'tb-num', value: String(p.size), 'data-tip': 'Size (pt)' });
      size.addEventListener('change', () => { const v = parseFloat(size.value); if (v > 0) { p.size = v; this.updateSelected({ size: v }); } });
      const bold = tbButton('bold', 'Bold', () => { p.bold = !p.bold; bold.classList.toggle('active', p.bold); this.updateSelected({ bold: p.bold }); });
      const italic = tbButton('italic', 'Italic', () => { p.italic = !p.italic; italic.classList.toggle('active', p.italic); this.updateSelected({ italic: p.italic }); });
      bold.classList.toggle('active', p.bold);
      italic.classList.toggle('active', p.italic);
      this.propsEl.append(fontSel, size, bold, italic, colorBtn(p.color, 'Text color', (c) => { p.color = c || '#111111'; this.updateSelected({ color: p.color }); this.renderProps(); }));
      if (kind === 'edittext' || f?.a.cover) this.propsEl.append(colorBtn(f?.a.bg || p.whiteout, 'Cover color (match the page)', (c) => { p.whiteout = c || '#ffffff'; this.updateSelected({ bg: p.whiteout }); this.renderProps(); }));
    } else if (kind === 'highlight') {
      this.propsEl.append(colorBtn(f?.a.color || p.highlight, 'Highlight color', (c) => { p.highlight = c || '#ffd54f'; this.updateSelected({ color: p.highlight }); this.renderProps(); }));
    } else if (kind === 'whiteout') {
      this.propsEl.append(colorBtn(f?.a.color || p.whiteout, 'Cover color', (c) => { p.whiteout = c || '#ffffff'; this.updateSelected({ color: p.whiteout }); this.renderProps(); }), h('span', { class: 'tb-label' }, 'covers only — text underneath stays in the file'));
    } else if (['draw', 'ink', 'line', 'arrow'].includes(kind)) {
      this.propsEl.append(colorBtn(f?.a.stroke || p.stroke, 'Color', (c) => { p.stroke = c || '#e53935'; this.updateSelected({ stroke: p.stroke }); this.renderProps(); }), widthSel(), opacitySel());
    } else if (['rect', 'ellipse'].includes(kind)) {
      this.propsEl.append(
        colorBtn(f?.a.stroke || p.stroke, 'Border color', (c) => { p.stroke = c || '#e53935'; this.updateSelected({ stroke: p.stroke }); this.renderProps(); }),
        colorBtn(f ? f.a.fill : p.fill, 'Fill', (c) => { p.fill = c; this.updateSelected({ fill: c }); this.renderProps(); }, true),
        widthSel(), opacitySel());
    } else if (kind === 'image' || kind === 'signature-place') {
      this.propsEl.append(h('span', { class: 'tb-label' }, kind === 'image' && f ? 'drag the corner to resize · Del to remove' : 'click the page to place'));
    } else if (kind === 'select') {
      this.propsEl.append(h('span', { class: 'tb-label' }, this.fields.length ? 'select text to copy · click fields to fill' : 'select text to copy · click marks to edit'));
    }
    if (f) this.propsEl.append(tbButton('trash', 'Delete (Del)', () => this.deleteSelected()));
  }

  toggleSide() {
    this.side.hidden = !this.side.hidden;
    this.app.saveSettings({ pdfThumbs: !this.side.hidden });
  }

  setZoom(v) {
    if (v === 'width' || v === 'page') {
      const pm = this.pages[this.currentPage] || this.pages[0];
      const d = displaySize(pm);
      const availW = this.scroller.clientWidth - 48;
      const availH = this.scroller.clientHeight - 32;
      const zW = availW / (d.w * PT_TO_PX);
      const zP = Math.min(zW, availH / (d.h * PT_TO_PX));
      this.zoom = clamp(v === 'width' ? zW : zP, 0.1, 6);
    } else this.zoom = Number(v);
    const cur = this.currentPage;
    this.renderAll(false);
    this.scrollToPage(cur);
    if (this.zoomSel && ZOOMS.includes(this.zoom)) this.zoomSel.value = String(this.zoom);
  }

  zoomBy(dir) {
    const i = ZOOMS.findIndex((z) => z >= this.zoom - 0.001);
    const next = dir > 0 ? ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS[i] > this.zoom + 0.001 ? i : i + 1)] : ZOOMS[Math.max(0, i - 1)];
    this.setZoom(next ?? this.zoom);
  }

  zoom(delta) { if (delta === 0) this.setZoom(1); else this.zoomBy(delta); }

  // =================================================================== find

  find() {
    if (!this.findBar) {
      const self = this;
      this.findBar = new FindBar(this.root, {
        canReplace: false,
        async find(q, opts) {
          const re = buildRegex(q, opts);
          self.findHits = [];
          for (const pm of self.pages) {
            const items = await self.textItems(pm);
            for (const it of items) {
              re.lastIndex = 0;
              let m;
              while ((m = re.exec(it.str))) {
                if (!m[0].length) { re.lastIndex++; continue; }
                const frac = it.w / Math.max(1, it.str.length);
                self.findHits.push({ pm, box: { x: it.x + frac * m.index, y: it.y, w: frac * m[0].length, h: it.h } });
              }
            }
          }
          self.findIndex = self.findHits.length ? 0 : -1;
          self.showFind();
          return { count: self.findHits.length, index: self.findIndex };
        },
        next() { if (!self.findHits.length) return { count: 0, index: -1 }; self.findIndex = (self.findIndex + 1) % self.findHits.length; self.showFind(); return { count: self.findHits.length, index: self.findIndex }; },
        prev() { if (!self.findHits.length) return { count: 0, index: -1 }; self.findIndex = (self.findIndex - 1 + self.findHits.length) % self.findHits.length; self.showFind(); return { count: self.findHits.length, index: self.findIndex }; },
        clear() { self.findHits = []; for (const el of self.pagesEl.children) clear(el._find); },
      });
    }
    this.findBar.open(false, getSelection().toString().slice(0, 60) || undefined);
  }

  showFind() {
    const k = this.k;
    for (const el of this.pagesEl.children) clear(el._find);
    this.findHits.forEach((hit, i) => {
      const el = this.pageEls.get(hit.pm.id);
      if (!el) return;
      const b = boxRawToDisp(hit.box, hit.pm.w, hit.pm.h, totalRotation(hit.pm));
      el._find.append(h('div', { class: `pdf-findhit ${i === this.findIndex ? 'cur' : ''}`, style: { left: b.x * k + 'px', top: b.y * k + 'px', width: b.w * k + 'px', height: b.h * k + 'px' } }));
    });
    const cur = this.findHits[this.findIndex];
    if (cur) {
      const el = this.pageEls.get(cur.pm.id);
      const b = boxRawToDisp(cur.box, cur.pm.w, cur.pm.h, totalRotation(cur.pm));
      this.scroller.scrollTop = el.offsetTop + b.y * k - this.scroller.clientHeight / 3;
    }
  }

  // =================================================================== keys

  onKey(e) {
    if (this.app.active !== this.tab) return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (document.querySelector('.modal-backdrop')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); return; }
    if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); this.redo(); return; }
    if (ctrl || e.altKey) return;
    if (!this.canEditMarks) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { if (this.deleteSelected()) e.preventDefault(); return; }
    if (e.key === 'Escape') { this.selectAnnot(null); this.setTool('select'); return; }
    if (this.selected && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const s = e.shiftKey ? 10 : 1;
      this.nudge(e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0);
      return;
    }
    if (e.key === 'Enter' && this.selected) { const f = this.findAnnot(this.selected); if (f?.a.type === 'text') { e.preventDefault(); this.editText(f.a.id); } return; }
    const tool = TOOL_KEYS[e.key.toLowerCase()];
    if (tool) { e.preventDefault(); this.setTool(tool); }
  }

  // =================================================================== status & io

  status() {
    const annots = this.pages.reduce((n, p) => n + p.annots.length, 0);
    const toolName = (TOOLS.find(([id]) => id === this.tool) || [, , this.tool === 'signature-place' ? 'Place signature' : this.tool])[2];
    return {
      left: [
        { text: `page ${Math.min(this.currentPage + 1, this.pages.length)} of ${this.pages.length}`, icon: 'pages', action: async () => { const v = parseInt(await promptDialog('Go to page', `Page (1–${this.pages.length})`, ''), 10); if (v) this.scrollToPage(clamp(v, 1, this.pages.length) - 1); } },
        this.constructor.mode === 'pdf' && this.pdfMode !== 'edit'
          ? { text: this.pdfMode === 'view' ? 'View mode' : 'Fill mode', icon: this.pdfMode === 'view' ? 'file' : 'form-fill', action: (e, el) => showMenu(PDF_MODES.map(([m, label]) => ({ label: `${label} mode`, checked: this.pdfMode === m, action: () => this.setPdfMode(m) })), { anchor: el }) }
          : { text: toolName, icon: 'pointer' },
        ...(annots ? [{ text: `${annots} mark${annots === 1 ? '' : 's'}` }] : []),
        ...(this.fields.length ? [{ text: `${this.fields.length} form fields`, icon: 'form' }] : []),
      ],
      right: [{ text: Math.round(this.zoom * 100) + '%', action: (e, el) => showMenu(ZOOMS.map((z) => ({ label: Math.round(z * 100) + '%', checked: z === this.zoom, action: () => this.setZoom(z) })).concat([{ sep: true }, { label: 'Fit width', action: () => this.setZoom('width') }, { label: 'Fit page', action: () => this.setZoom('page') }]), { anchor: el }) }],
    };
  }

  menus() {
    return {
      edit: [
        { label: 'Delete selected mark', icon: 'trash', shortcut: 'Del', disabled: !this.selected, action: () => this.deleteSelected() },
        { label: 'Clear all marks on this page', action: () => { const pm = this.pages[this.currentPage]; if (pm) this.change(() => { pm.annots = []; }, { pages: [pm] }); } },
      ],
      view: [
        { label: 'Fit width', icon: 'fit-width', action: () => this.setZoom('width') },
        { label: 'Fit page', icon: 'fit-page', action: () => this.setZoom('page') },
        { label: 'Page thumbnails', icon: 'sidebar', checked: !this.side.hidden, action: () => this.toggleSide() },
        { label: 'Image dump drawer', icon: 'image', checked: this.dump.open, action: () => this.dump.toggle() },
        { label: 'Doc dump drawer', icon: 'file-text', checked: this.dumps.doc.open, action: () => this.dumps.doc.toggle() },
        ...(this.constructor.mode === 'pdf' ? [{ sep: true }, ...PDF_MODES.map(([m, label]) => ({ label: `${label} mode`, checked: this.pdfMode === m, action: () => this.setPdfMode(m) })), { label: 'Open in the Form filler', icon: 'form-fill', action: () => this.openFormFiller() }] : []),
      ],
      insert: [
        { label: 'Text', icon: 'type', shortcut: 'T', action: () => this.setTool('text') },
        { label: 'Image…', icon: 'image-plus', action: () => this.setTool('image') },
        { label: 'Signature…', icon: 'signature', shortcut: 'S', action: () => this.setTool('signature') },
        { sep: true },
        { label: 'Blank page', icon: 'file-plus', action: () => this.insertBlank() },
        { label: 'Pages from file…', icon: 'layers', action: () => this.insertFromFiles() },
      ],
      tools: [
        { label: 'Tools', submenu: TOOLS.map(([id, ic, tip, key]) => ({ label: tip, icon: ic, shortcut: key, checked: this.tool === id, action: () => this.setTool(id) })) },
        { label: 'Pages', icon: 'pages', submenu: () => this.pageMenu() },
        { label: 'Keep tool after placing marks', checked: this.app.settings.pdfStickyTools === true, action: () => this.app.saveSettings({ pdfStickyTools: !this.app.settings.pdfStickyTools }) },
      ],
    };
  }

  saveFormats() { return [{ ext: 'pdf', name: 'PDF document' }]; }

  exportTargets() {
    return [
      { label: 'Flattened PDF (pages as images)', icon: 'layers', run: async () => { const { bytes } = await buildPdf(this, { flatten: true }); await this.app.saveBytesAs(bytes, { defaultName: stripExt(this.tab.title) + ' (flattened).pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] }); } },
      { label: 'Current page as PNG…', icon: 'image', run: () => { this.selPages = new Set([this.pages[this.currentPage].id]); return this.exportPng(); } },
    ];
  }

  async serialize() {
    const { bytes, flattened } = await buildPdf(this);
    if (flattened) toast('This PDF is encrypted, so it was saved as a flattened copy (pages as images).', { type: 'warn', timeout: 7000 });
    return bytes;
  }

  async print() {
    try {
      const { bytes } = await buildPdf(this);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const w = window.open(url, '_blank');
      if (!w) toast('Allow pop-ups to print.', { type: 'warn' });
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (e) { errorToast(e, 'Print failed'); }
  }

  insertText(text) {
    if (this.editingId) { document.execCommand('insertText', false, text); return true; }
    return false;
  }

  getSelectionText() { return String(getSelection() || ''); }

  async getContextText() {
    const out = [];
    for (const [i, pm] of this.pages.entries()) {
      const items = await this.textItems(pm);
      let page = '';
      let lastY = null;
      for (const it of items) { page += lastY != null && Math.abs(it.y - lastY) > it.h * 0.5 ? '\n' : ' '; page += it.str; lastY = it.y; }
      out.push(`--- page ${i + 1} ---\n${page.trim()}`);
    }
    if (this.fields?.length) out.push('--- form fields ---\n' + this.fields.map((f) => `${f.name}: ${this.formValues[f.name] ?? ''}`).join('\n'));
    return out.join('\n\n');
  }

  onShow() { /* layout is CSS-driven */ }
  focus() { if (!this.editingId) this.root.focus({ preventScroll: true }); }

  destroy() {
    document.removeEventListener('keydown', this.keyHandler);
    this.io?.disconnect();
    this.thumbIo?.disconnect();
    this.dumps?.destroy();
    for (const s of this.sources) s.doc?.destroy?.();
  }
}

function translate(a, dx, dy) {
  const out = { ...a };
  if ('x' in a) { out.x = a.x + dx; out.y = a.y + dy; }
  if ('x1' in a) { out.x1 = a.x1 + dx; out.y1 = a.y1 + dy; out.x2 = a.x2 + dx; out.y2 = a.y2 + dy; }
  if (a.points) out.points = a.points.map(([x, y]) => [x + dx, y + dy]);
  if (a.cover) out.cover = { ...a.cover, x: a.cover.x + dx, y: a.cover.y + dy };
  return out;
}

function mimeFor(name) {
  const e = extOf(name);
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }[e] || 'application/octet-stream';
}

/** True if the file has an /Encrypt entry (checked in the trailer area, where it lives). */
function looksEncrypted(bytes) {
  const tail = bytes.subarray(Math.max(0, bytes.length - 64 * 1024));
  const head = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  const has = (b) => { const t = new TextDecoder('latin1').decode(b); return t.includes('/Encrypt'); };
  return has(tail) || has(head);
}
