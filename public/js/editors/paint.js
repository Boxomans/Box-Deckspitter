// BoxPaint — a lightweight Paint.NET-style editor: layers, brush, eraser, line/rectangle/ellipse, fill bucket,
// text, colour picker, rectangle selection (crop/clear/copy/cut/paste), move layer, zoom, undo/redo.
// Left mouse button paints with the primary colour, right button with the secondary (like Paint.NET).

import { BaseEditor } from './base.js';
import { h, clear, uid, clamp, stripExt, blobToDataURL } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { tbButton, tbSep, toast, errorToast, modal, promptDialog, showMenu, colorPopover, hoverKeys, renameInline } from '../core/ui.js';
import { api } from '../core/api.js';
import { pickOpen } from '../core/files.js';
import { DumpDock, DUMP_MIME } from './doc/image-dump.js';

const TOOLS = [
  ['brush', 'brush', 'Brush', 'B'], ['eraser', 'eraser', 'Eraser', 'E'], ['line', 'line', 'Line', 'L'],
  ['rect', 'square', 'Rectangle', 'R'], ['ellipse', 'circle', 'Ellipse', 'O'], ['fill', 'bucket', 'Paint bucket', 'F'],
  ['text', 'type', 'Text', 'T'], ['picker', 'pipette', 'Colour picker', 'K'], ['select', 'select', 'Rectangle select', 'S'], ['move', 'move', 'Move layer', 'M'],
];
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
const MAX_UNDO = 30;

const mkCanvas = (w, h2) => { const c = document.createElement('canvas'); c.width = w; c.height = h2; return c; };
const hexToRgba = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]; };

export class PaintEditor extends BaseEditor {
  static mode = 'paint';

  async load(bytes) {
    const s = this.app.settings;
    this.tool = 'brush';
    this.size = s.paintSize || 8;
    this.opacity = 1;
    this.shapeMode = s.paintShape || 'stroke'; // stroke | fill | both
    this.tolerance = s.paintTolerance ?? 24;
    this.primary = s.paintPrimary || '#1d1b22';
    this.secondary = s.paintSecondary || '#ffffff';
    this.zoomLevel = 1;
    this.layers = [];
    this.active = 0;
    this.sel = null; // {x,y,w,h} in image pixels
    this.undoStack = [];
    this.redoStack = [];
    this.buildDom();
    if (bytes && bytes.length) {
      const bmp = await createImageBitmap(new Blob([bytes]));
      this.newImage(bmp.width, bmp.height, 'transparent');
      this.layers[0].canvas.getContext('2d').drawImage(bmp, 0, 0);
      this.layers[0].name = 'Background';
    } else {
      const spec = await this.askNewSize();
      this.newImage(spec.w, spec.h, spec.bg);
    }
    this.renderLayers();
    this.composite();
    requestAnimationFrame(() => this.zoom('fit'));
  }

  // ================================================================ DOM

  buildDom() {
    this.view = mkCanvas(1, 1);
    this.view.className = 'paint-view';
    this.overlay = mkCanvas(1, 1);
    this.overlay.className = 'paint-overlay';
    this.stage = h('div', { class: 'paint-stage checker' }, this.view, this.overlay);
    this.scroller = h('div', { class: 'paint-scroller' }, this.stage);
    this.layerList = h('div', { class: 'paint-layerlist' });
    this.layerOpacity = h('input', { type: 'range', min: '0', max: '100', value: '100' });
    this.layerOpacity.addEventListener('input', () => { const L = this.layers[this.active]; if (L) { L.opacity = Number(this.layerOpacity.value) / 100; this.composite(); } });
    this.layerOpacity.addEventListener('change', () => this.markDirty());
    this.side = h('div', { class: 'paint-side' },
      h('div', { class: 'panel-head' }, 'Layers', h('div', { class: 'grow' }),
        h('button', { class: 'icon-btn', 'data-tip': 'Add layer', onclick: () => this.addLayer() }, icon('plus', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'New layer from the image dump', onclick: () => this.layerFromDump() }, icon('image-plus', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Duplicate layer', onclick: () => this.duplicateLayer() }, icon('copy', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Delete layer', onclick: () => this.deleteLayer() }, icon('trash', 'sm'))),
      this.layerList,
      h('div', { class: 'paint-layerfoot' },
        h('label', {}, h('span', { class: 'faint' }, 'opacity'), this.layerOpacity),
        h('div', { class: 'row' },
          h('button', { class: 'icon-btn', 'data-tip': 'Move layer up', onclick: () => this.moveLayer(1) }, icon('arrow-up', 'sm')),
          h('button', { class: 'icon-btn', 'data-tip': 'Move layer down', onclick: () => this.moveLayer(-1) }, icon('arrow-down', 'sm')),
          h('button', { class: 'btn sm ghost', onclick: () => this.mergeDown() }, 'Merge down'))));
    this.dumps = new DumpDock({ app: this.app, onInsert: async (url, name) => this.addImageLayer(await (await fetch(url)).blob(), name || 'From dump') });
    this.main = h('div', { class: 'paint-root' }, this.scroller, this.side);
    this.root = h('div', { class: 'paint-wrap' }, this.main, this.dumps.el);
    this.pane.append(this.root);

    // pointer
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    this.overlay.addEventListener('pointermove', (e) => this.onMove(e));
    this.overlay.addEventListener('pointerup', (e) => this.onUp(e));
    this.overlay.addEventListener('pointerleave', () => { if (!this.drag) this.drawOverlay(); });
    this.scroller.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.zoom(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
    // drop / paste images as new layers
    this.main.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(DUMP_MIME)) e.preventDefault(); });
    this.main.addEventListener('drop', async (e) => {
      const dumpUrl = e.dataTransfer.getData(DUMP_MIME);
      if (dumpUrl) { e.preventDefault(); return this.addImageLayer(await (await fetch(dumpUrl)).blob(), decodeURIComponent(dumpUrl.split('/').pop().split('?')[0]) || 'From dump'); }
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) await this.addImageLayer(f, f.name);
    });
    this.pasteHandler = async (e) => {
      if (this.app.active !== this.tab || /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable) return;
      const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
      if (!f) return;
      e.preventDefault();
      await this.addImageLayer(f, 'Pasted');
    };
    document.addEventListener('paste', this.pasteHandler);
    this.keyHandler = (e) => this.onKey(e);
    document.addEventListener('keydown', this.keyHandler);
  }

  buildToolbar() {
    this.toolBtns = {};
    const tools = TOOLS.map(([id, ic, tip, key]) => {
      const b = tbButton(ic, `${tip} (${key})`, () => this.setTool(id));
      if (id === this.tool) b.classList.add('active');
      this.toolBtns[id] = b;
      return b;
    });
    this.swatchP = h('button', { class: 'paint-swatch primary', 'data-tip': 'Primary colour (left button)', onclick: (e) => this.pickColor('primary', e.currentTarget) });
    this.swatchS = h('button', { class: 'paint-swatch secondary', 'data-tip': 'Secondary colour (right button)', onclick: (e) => this.pickColor('secondary', e.currentTarget) });
    const swap = h('button', { class: 'icon-btn', 'data-tip': 'Swap colours (X)', onclick: () => this.swapColors() }, icon('swap', 'sm'));
    this.sizeIn = h('input', { type: 'range', min: '1', max: '120', value: String(this.size), class: 'paint-size' });
    this.sizeLabel = h('span', { class: 'mono paint-size-label' });
    this.sizeIn.addEventListener('input', () => { this.size = Number(this.sizeIn.value); this.syncProps(); });
    this.sizeIn.addEventListener('change', () => this.app.saveSettings({ paintSize: this.size }));
    this.opIn = h('input', { type: 'range', min: '5', max: '100', value: '100', class: 'paint-op', 'data-tip': 'Brush / shape opacity' });
    this.opIn.addEventListener('input', () => { this.opacity = Number(this.opIn.value) / 100; this.syncProps(); });
    this.shapeSel = h('select', { class: 'paint-shape', 'data-tip': 'Shapes: outline, fill or both' }, h('option', { value: 'stroke' }, 'Outline'), h('option', { value: 'fill' }, 'Fill'), h('option', { value: 'both' }, 'Outline + fill'));
    this.shapeSel.value = this.shapeMode;
    this.shapeSel.addEventListener('change', () => { this.shapeMode = this.shapeSel.value; this.app.saveSettings({ paintShape: this.shapeMode }); });
    this.tolIn = h('input', { type: 'range', min: '0', max: '128', value: String(this.tolerance), class: 'paint-tol', 'data-tip': 'Fill tolerance' });
    this.tolIn.addEventListener('input', () => { this.tolerance = Number(this.tolIn.value); this.syncProps(); });
    this.tolIn.addEventListener('change', () => this.app.saveSettings({ paintTolerance: this.tolerance }));
    this.propLabel = h('span', { class: 'mono faint paint-proplabel' });
    this.zoomLabel = h('span', { class: 'mono paint-zoomlabel' });
    const tb = h('div', { class: 'toolbar paint-toolbar' },
      tbButton('undo', 'Undo (Ctrl+Z)', () => this.undo()),
      tbButton('redo', 'Redo (Ctrl+Y)', () => this.redo()),
      tbSep(),
      ...tools,
      tbSep(),
      this.swatchP, swap, this.swatchS,
      tbSep(),
      h('span', { class: 'faint paint-lbl' }, 'size'), this.sizeIn, this.sizeLabel,
      h('span', { class: 'faint paint-lbl' }, 'opacity'), this.opIn,
      this.shapeSel,
      h('span', { class: 'faint paint-lbl paint-tolwrap' }, 'tolerance'), this.tolIn,
      this.propLabel,
      h('div', { class: 'grow' }),
      tbButton('image', 'Image: crop, resize, flip, rotate', (e) => showMenu(this.imageMenu(), { anchor: e.currentTarget })),
      tbButton('sliders', 'Adjustments', (e) => showMenu(this.adjustMenu(), { anchor: e.currentTarget })),
      tbSep(),
      tbButton('zoom-out', 'Zoom out', () => this.zoom(-1)),
      this.zoomLabel,
      tbButton('zoom-in', 'Zoom in', () => this.zoom(1)),
      tbButton('fit-page', 'Fit', () => this.zoom('fit')),
      tbSep(),
      tbButton('image-down', 'Export to the image dump', () => this.exportToDump(), { text: 'To dump' }),
    );
    this.syncProps();
    return tb;
  }

  syncProps() {
    if (!this.swatchP) return;
    this.swatchP.style.background = this.primary;
    this.swatchS.style.background = this.secondary;
    this.sizeLabel.textContent = `${this.size}px`;
    const t = this.tool;
    const show = (el, on) => { el.style.display = on ? '' : 'none'; };
    const sized = ['brush', 'eraser', 'line', 'rect', 'ellipse', 'text'].includes(t);
    show(this.sizeIn, sized); show(this.sizeLabel, sized); show(this.sizeIn.previousSibling, sized);
    const op = ['brush', 'line', 'rect', 'ellipse', 'text'].includes(t);
    show(this.opIn, op); show(this.opIn.previousSibling, op);
    show(this.shapeSel, t === 'rect' || t === 'ellipse');
    show(this.tolIn, t === 'fill'); show(this.tolIn.previousSibling, t === 'fill');
    this.propLabel.textContent = t === 'fill' ? String(this.tolerance) : t === 'select' && this.sel ? `${Math.round(this.sel.w)}×${Math.round(this.sel.h)}` : '';
    this.overlay.style.cursor = { picker: 'copy', move: 'move', text: 'text', select: 'crosshair', fill: 'cell' }[t] || 'crosshair';
  }

  setTool(t) {
    this.tool = t;
    for (const [id, b] of Object.entries(this.toolBtns || {})) b.classList.toggle('active', id === t);
    this.syncProps();
    this.drawOverlay();
    this.refreshStatus();
  }

  pickColor(which, anchor) {
    colorPopover(anchor, { onPick: (c) => { if (!c) return; this[which] = c; this.app.saveSettings({ [which === 'primary' ? 'paintPrimary' : 'paintSecondary']: c }); this.syncProps(); } });
  }
  swapColors() { [this.primary, this.secondary] = [this.secondary, this.primary]; this.syncProps(); }

  // ================================================================ document

  async askNewSize() {
    const w = h('input', { type: 'number', min: '1', max: '10000', value: String(this.app.settings.paintW || 1280) });
    const hh = h('input', { type: 'number', min: '1', max: '10000', value: String(this.app.settings.paintH || 720) });
    const bg = h('select', {}, h('option', { value: '#ffffff' }, 'White'), h('option', { value: 'transparent' }, 'Transparent'), h('option', { value: '#000000' }, 'Black'));
    const presets = h('div', { class: 'row', style: { flexWrap: 'wrap' } }, [['1280×720', 1280, 720], ['1920×1080', 1920, 1080], ['1080×1080', 1080, 1080], ['800×600', 800, 600], ['Letter 2550×3300', 2550, 3300]].map(([l, a, b]) =>
      h('button', { class: 'chip', onclick: () => { w.value = a; hh.value = b; } }, l)));
    const res = await modal({
      title: 'New image', dismissable: false,
      body: h('div', { class: 'form-grid' }, h('label', {}, 'Width (px)'), w, h('label', {}, 'Height (px)'), hh, h('label', {}, 'Background'), bg, h('span'), presets),
      buttons: [{ label: 'Create', value: 'ok', primary: true }],
    });
    void res;
    const W = clamp(Math.round(Number(w.value) || 1280), 1, 10000);
    const H = clamp(Math.round(Number(hh.value) || 720), 1, 10000);
    this.app.saveSettings({ paintW: W, paintH: H });
    return { w: W, h: H, bg: bg.value };
  }

  newImage(w, h2, bg) {
    this.W = w;
    this.H = h2;
    const L = this.makeLayer('Background');
    if (bg !== 'transparent') { const c = L.canvas.getContext('2d'); c.fillStyle = bg; c.fillRect(0, 0, w, h2); }
    this.layers = [L];
    this.active = 0;
    this.view.width = this.overlay.width = w;
    this.view.height = this.overlay.height = h2;
  }

  makeLayer(name) { return { id: uid('L'), name, canvas: mkCanvas(this.W, this.H), visible: true, opacity: 1 }; }
  get layer() { return this.layers[this.active]; }
  ctxOf(L = this.layer) { return L.canvas.getContext('2d', { willReadFrequently: true }); }

  composite() {
    const c = this.view.getContext('2d');
    c.clearRect(0, 0, this.W, this.H);
    for (const L of this.layers) {
      if (!L.visible) continue;
      c.globalAlpha = L.opacity;
      c.drawImage(L.canvas, 0, 0);
      if (L === this.layer && this.stroke) { c.globalAlpha = L.opacity * this.stroke.alpha; c.globalCompositeOperation = 'source-over'; c.drawImage(this.stroke.canvas, 0, 0); }
    }
    c.globalAlpha = 1;
  }

  /** Flattened image (all visible layers). */
  flatten(background = null) {
    const c = mkCanvas(this.W, this.H);
    const x = c.getContext('2d');
    if (background) { x.fillStyle = background; x.fillRect(0, 0, this.W, this.H); }
    for (const L of this.layers) { if (!L.visible) continue; x.globalAlpha = L.opacity; x.drawImage(L.canvas, 0, 0); }
    return c;
  }

  // ================================================================ undo

  snapshot(kind = 'pixels') {
    const L = this.layer;
    if (kind === 'pixels') return { kind, id: L.id, data: this.ctxOf(L).getImageData(0, 0, this.W, this.H) };
    return { kind: 'all', W: this.W, H: this.H, active: this.active, layers: this.layers.map((x) => ({ ...x, data: this.ctxOf(x).getImageData(0, 0, this.W, this.H) })) };
  }
  restore(s) {
    if (s.kind === 'pixels') {
      const L = this.layers.find((x) => x.id === s.id);
      if (L) this.ctxOf(L).putImageData(s.data, 0, 0);
    } else {
      this.W = s.W; this.H = s.H;
      this.view.width = this.overlay.width = s.W;
      this.view.height = this.overlay.height = s.H;
      this.layers = s.layers.map((x) => { const c = mkCanvas(s.W, s.H); c.getContext('2d').putImageData(x.data, 0, 0); return { id: x.id, name: x.name, visible: x.visible, opacity: x.opacity, canvas: c }; });
      this.active = clamp(s.active, 0, this.layers.length - 1);
      this.fitStage();
    }
  }
  checkpoint(kind = 'pixels') {
    this.undoStack.push(this.snapshot(kind));
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.markDirty();
  }
  undo() {
    const s = this.undoStack.pop();
    if (!s) return toast('Nothing to undo', { timeout: 1000 });
    this.redoStack.push(s.kind === 'pixels' ? this.snapshotOf(s.id) : this.snapshot('all'));
    this.restore(s);
    this.after();
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(s.kind === 'pixels' ? this.snapshotOf(s.id) : this.snapshot('all'));
    this.restore(s);
    this.after();
  }
  snapshotOf(id) { const L = this.layers.find((x) => x.id === id) || this.layer; return { kind: 'pixels', id: L.id, data: this.ctxOf(L).getImageData(0, 0, this.W, this.H) }; }
  after() { this.composite(); this.renderLayers(); this.drawOverlay(); this.syncProps(); }

  // ================================================================ pointer

  pt(e) {
    const r = this.overlay.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.W, y: ((e.clientY - r.top) / r.height) * this.H };
  }

  onDown(e) {
    if (e.button === 1) return; // middle: let the scroller pan
    e.preventDefault();
    this.overlay.setPointerCapture(e.pointerId);
    const p = this.pt(e);
    const color = e.button === 2 ? this.secondary : this.primary;
    const L = this.layer;
    if (!L) return;
    if (!L.visible && !['picker', 'select'].includes(this.tool)) return toast('That layer is hidden — show it to paint on it.', { type: 'warn' });
    switch (this.tool) {
      case 'brush':
      case 'eraser': {
        this.checkpoint();
        const sc = mkCanvas(this.W, this.H);
        this.stroke = { canvas: sc, alpha: this.tool === 'eraser' ? 1 : this.opacity, erase: this.tool === 'eraser', last: p, color };
        const c = sc.getContext('2d');
        c.lineCap = c.lineJoin = 'round';
        c.strokeStyle = c.fillStyle = this.tool === 'eraser' ? '#000' : color;
        c.lineWidth = this.size;
        c.beginPath(); c.arc(p.x, p.y, this.size / 2, 0, Math.PI * 2); c.fill();
        if (this.stroke.erase) this.previewErase(); else this.composite();
        break;
      }
      case 'line': case 'rect': case 'ellipse': case 'select':
        this.drag = { start: p, now: p, color, button: e.button };
        break;
      case 'move':
        this.checkpoint();
        this.drag = { start: p, now: p, orig: this.ctxOf().getImageData(0, 0, this.W, this.H) };
        break;
      case 'fill':
        this.checkpoint();
        this.floodFill(Math.floor(p.x), Math.floor(p.y), color);
        this.after();
        break;
      case 'picker': {
        const d = this.view.getContext('2d').getImageData(clamp(Math.floor(p.x), 0, this.W - 1), clamp(Math.floor(p.y), 0, this.H - 1), 1, 1).data;
        const hex = '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
        if (e.button === 2) this.secondary = hex; else this.primary = hex;
        this.syncProps();
        break;
      }
      case 'text': this.placeText(p, color); break;
      default: break;
    }
  }

  onMove(e) {
    const p = this.pt(e);
    this.cursor = p;
    if (this.stroke) {
      const c = this.stroke.canvas.getContext('2d');
      c.beginPath(); c.moveTo(this.stroke.last.x, this.stroke.last.y); c.lineTo(p.x, p.y); c.stroke();
      this.stroke.last = p;
      if (this.stroke.erase) this.previewErase(); else this.composite();
      this.drawOverlay();
      return;
    }
    if (this.drag) {
      this.drag.now = p;
      if (this.tool === 'move') {
        const c = this.ctxOf();
        c.clearRect(0, 0, this.W, this.H);
        c.putImageData(this.drag.orig, Math.round(p.x - this.drag.start.x), Math.round(p.y - this.drag.start.y));
        this.composite();
      }
      this.drawOverlay();
      return;
    }
    this.drawOverlay();
  }

  onUp(e) {
    if (this.stroke) {
      const s = this.stroke;
      this.stroke = null;
      const c = this.ctxOf();
      if (s.erase) { c.globalCompositeOperation = 'destination-out'; c.drawImage(s.canvas, 0, 0); c.globalCompositeOperation = 'source-over'; } else { c.globalAlpha = s.alpha; c.drawImage(s.canvas, 0, 0); c.globalAlpha = 1; }
      this.after();
      return;
    }
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    const x0 = Math.min(d.start.x, d.now.x), y0 = Math.min(d.start.y, d.now.y), w = Math.abs(d.now.x - d.start.x), hh = Math.abs(d.now.y - d.start.y);
    if (this.tool === 'select') {
      this.sel = w > 1 && hh > 1 ? { x: Math.round(x0), y: Math.round(y0), w: Math.round(w), h: Math.round(hh) } : null;
      this.syncProps();
      this.drawOverlay();
      return;
    }
    if (this.tool === 'move') { this.after(); return; }
    if (w < 1 && hh < 1) { this.drawOverlay(); return; }
    this.checkpoint();
    const c = this.ctxOf();
    this.drawShape(c, d.start, d.now, d.button === 2 ? this.secondary : this.primary, d.button === 2 ? this.primary : this.secondary, e.shiftKey);
    this.after();
  }

  /** Shapes: Outline uses the button's colour; Fill / both fill with the other colour (Paint.NET style). */
  drawShape(c, a, b, strokeColor, fillColor, square) {
    c.save();
    c.globalAlpha = this.opacity;
    c.lineWidth = this.size;
    c.lineCap = c.lineJoin = 'round';
    c.strokeStyle = strokeColor;
    c.fillStyle = this.shapeMode === 'fill' ? strokeColor : fillColor;
    let x1 = b.x, y1 = b.y;
    if (square && this.tool !== 'line') { const s = Math.max(Math.abs(x1 - a.x), Math.abs(y1 - a.y)); x1 = a.x + Math.sign(x1 - a.x || 1) * s; y1 = a.y + Math.sign(y1 - a.y || 1) * s; }
    if (square && this.tool === 'line') { const ang = Math.round(Math.atan2(y1 - a.y, x1 - a.x) / (Math.PI / 4)) * (Math.PI / 4); const len = Math.hypot(x1 - a.x, y1 - a.y); x1 = a.x + Math.cos(ang) * len; y1 = a.y + Math.sin(ang) * len; }
    c.beginPath();
    if (this.tool === 'line') { c.moveTo(a.x, a.y); c.lineTo(x1, y1); c.stroke(); c.restore(); return; }
    const x = Math.min(a.x, x1), y = Math.min(a.y, y1), w = Math.abs(x1 - a.x), hh = Math.abs(y1 - a.y);
    if (this.tool === 'rect') c.rect(x, y, w, hh); else c.ellipse(x + w / 2, y + hh / 2, w / 2, hh / 2, 0, 0, Math.PI * 2);
    if (this.shapeMode !== 'stroke') c.fill();
    if (this.shapeMode !== 'fill') c.stroke();
    c.restore();
  }

  previewErase() {
    // show the layer with the eraser stroke cut out, without committing yet
    const c = this.view.getContext('2d');
    c.clearRect(0, 0, this.W, this.H);
    const tmp = mkCanvas(this.W, this.H);
    const t = tmp.getContext('2d');
    for (const L of this.layers) {
      if (!L.visible) continue;
      c.globalAlpha = L.opacity;
      if (L === this.layer && this.stroke) {
        t.clearRect(0, 0, this.W, this.H);
        t.globalCompositeOperation = 'source-over'; t.drawImage(L.canvas, 0, 0);
        t.globalCompositeOperation = 'destination-out'; t.drawImage(this.stroke.canvas, 0, 0);
        c.drawImage(tmp, 0, 0);
      } else c.drawImage(L.canvas, 0, 0);
    }
    c.globalAlpha = 1;
  }

  drawOverlay() {
    const c = this.overlay.getContext('2d');
    c.clearRect(0, 0, this.W, this.H);
    const px = 1 / this.zoomLevel;
    // shape / selection preview
    if (this.drag && this.tool !== 'move') {
      if (this.tool === 'select') this.drawSelRect(c, this.drag.start, this.drag.now, px);
      else this.drawShape(c, this.drag.start, this.drag.now, this.drag.button === 2 ? this.secondary : this.primary, this.drag.button === 2 ? this.primary : this.secondary, false);
    }
    if (this.sel && !(this.drag && this.tool === 'select')) this.drawSelRect(c, { x: this.sel.x, y: this.sel.y }, { x: this.sel.x + this.sel.w, y: this.sel.y + this.sel.h }, px);
    // brush outline
    if (this.cursor && ['brush', 'eraser'].includes(this.tool)) {
      c.beginPath();
      c.arc(this.cursor.x, this.cursor.y, Math.max(0.5, this.size / 2), 0, Math.PI * 2);
      c.lineWidth = px; c.strokeStyle = 'rgba(0,0,0,0.6)'; c.stroke();
      c.beginPath(); c.arc(this.cursor.x, this.cursor.y, Math.max(0.5, this.size / 2) + px, 0, Math.PI * 2); c.strokeStyle = 'rgba(255,255,255,0.7)'; c.stroke();
    }
  }

  drawSelRect(c, a, b, px) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), hh = Math.abs(b.y - a.y);
    c.save();
    c.lineWidth = px;
    c.setLineDash([5 * px, 4 * px]);
    c.strokeStyle = '#000'; c.strokeRect(x, y, w, hh);
    c.lineDashOffset = 5 * px; c.strokeStyle = '#fff'; c.strokeRect(x, y, w, hh);
    c.restore();
  }

  floodFill(x, y, color) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const c = this.ctxOf();
    const img = c.getImageData(0, 0, this.W, this.H);
    const d = img.data;
    const W = this.W, H = this.H;
    const i0 = (y * W + x) * 4;
    const target = [d[i0], d[i0 + 1], d[i0 + 2], d[i0 + 3]];
    const fill = hexToRgba(color);
    fill[3] = Math.round(255 * this.opacity);
    const tol = this.tolerance;
    const match = (i) => Math.abs(d[i] - target[0]) <= tol && Math.abs(d[i + 1] - target[1]) <= tol && Math.abs(d[i + 2] - target[2]) <= tol && Math.abs(d[i + 3] - target[3]) <= tol;
    if (fill.every((v, k) => v === target[k])) return;
    const seen = new Uint8Array(W * H);
    const stack = [x, y];
    const sel = this.sel;
    while (stack.length) {
      const yy = stack.pop(), xx = stack.pop();
      let xl = xx;
      while (xl >= 0 && !seen[yy * W + xl] && match((yy * W + xl) * 4) && (!sel || xl >= sel.x)) xl--;
      xl++;
      let up = false, down = false;
      for (let xr = xl; xr < W && !seen[yy * W + xr] && match((yy * W + xr) * 4) && (!sel || xr < sel.x + sel.w); xr++) {
        if (sel && (yy < sel.y || yy >= sel.y + sel.h)) break;
        const i = (yy * W + xr) * 4;
        seen[yy * W + xr] = 1;
        d[i] = fill[0]; d[i + 1] = fill[1]; d[i + 2] = fill[2]; d[i + 3] = Math.max(d[i + 3], fill[3]);
        if (yy > 0) { const m = !seen[(yy - 1) * W + xr] && match(((yy - 1) * W + xr) * 4); if (m && !up) { stack.push(xr, yy - 1); up = true; } else if (!m) up = false; }
        if (yy < H - 1) { const m = !seen[(yy + 1) * W + xr] && match(((yy + 1) * W + xr) * 4); if (m && !down) { stack.push(xr, yy + 1); down = true; } else if (!m) down = false; }
      }
    }
    c.putImageData(img, 0, 0);
  }

  async placeText(p, color) {
    const text = await promptDialog('Add text', `Text (${this.size * 2}px, ${this.app.settings.paintFont || 'Segoe UI'}) — change size with the size slider`, '');
    if (!text) return;
    this.checkpoint();
    const c = this.ctxOf();
    c.save();
    c.globalAlpha = this.opacity;
    c.fillStyle = color;
    c.font = `${Math.max(8, this.size * 2)}px "${this.app.settings.paintFont || 'Segoe UI'}", sans-serif`;
    c.textBaseline = 'top';
    text.split('\n').forEach((line, i) => c.fillText(line, p.x, p.y + i * this.size * 2.4));
    c.restore();
    this.after();
  }

  // ================================================================ selection & clipboard

  selOrAll() { return this.sel || { x: 0, y: 0, w: this.W, h: this.H }; }
  clearSelection() { if (!this.sel) return; this.checkpoint(); this.ctxOf().clearRect(this.sel.x, this.sel.y, this.sel.w, this.sel.h); this.after(); }

  async copySelection(cut = false) {
    const s = this.selOrAll();
    const c = mkCanvas(s.w, s.h);
    c.getContext('2d').drawImage(this.layer.canvas, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    try {
      if (window.bdsShell?.copyImage) await window.bdsShell.copyImage(await blobToDataURL(blob));
      else await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast(cut ? 'Cut' : 'Copied', { timeout: 1000 });
    } catch (e) { errorToast(e, 'Copy failed'); }
    this.clipCanvas = c;
    if (cut) this.clearSelection();
  }

  async addImageLayer(blobOrFile, name) {
    try {
      const bmp = await createImageBitmap(blobOrFile);
      this.checkpoint('all');
      const L = this.makeLayer(name || 'Pasted');
      const k = Math.min(1, this.W / bmp.width, this.H / bmp.height);
      const w = bmp.width * k, hh = bmp.height * k;
      L.canvas.getContext('2d').drawImage(bmp, (this.W - w) / 2, (this.H - hh) / 2, w, hh);
      this.layers.splice(this.active + 1, 0, L);
      this.active += 1;
      this.after();
      this.setTool('move');
      toast(`Added “${name}” as a new layer — drag to position it`, { timeout: 2200 });
    } catch (e) { errorToast(e, 'Couldn’t add that image'); }
  }

  // ================================================================ layers

  renderLayers() {
    clear(this.layerList);
    // top of the list = top layer
    [...this.layers].map((L, i) => [L, i]).reverse().forEach(([L, i]) => {
      const thumb = mkCanvas(48, Math.max(8, Math.round((48 * this.H) / this.W)));
      thumb.className = 'paint-thumb checker';
      thumb.getContext('2d').drawImage(L.canvas, 0, 0, thumb.width, thumb.height);
      const eye = h('button', { class: `icon-btn paint-eye ${L.visible ? '' : 'off'}`, 'data-tip': L.visible ? 'Hide' : 'Show', onclick: (e) => { e.stopPropagation(); L.visible = !L.visible; this.markDirty(); this.after(); } }, icon(L.visible ? 'eye' : 'eye-off', 'sm'));
      const nameEl = h('span', { class: 'paint-layername' }, L.name);
      const row = h('div', { class: `paint-layer ${i === this.active ? 'on' : ''}`, title: 'Double-click or F2: rename · Del: delete' }, thumb, nameEl, eye);
      hoverKeys(row, {
        nameEl, value: () => L.name,
        commit: (n) => { L.name = n; this.renderLayers(); this.markDirty(); },
        remove: () => { this.active = this.layers.indexOf(L); this.deleteLayer(); },
      });
      row.addEventListener('click', () => { this.active = i; this.renderLayers(); });
      row.addEventListener('dblclick', () => renameInline(row));
      this.layerList.append(row);
    });
    if (this.layer) this.layerOpacity.value = String(Math.round(this.layer.opacity * 100));
  }

  addLayer() { this.checkpoint('all'); const L = this.makeLayer(`Layer ${this.layers.length + 1}`); this.layers.splice(this.active + 1, 0, L); this.active += 1; this.after(); }
  duplicateLayer() {
    this.checkpoint('all');
    const src = this.layer;
    const L = this.makeLayer(`${src.name} copy`);
    L.canvas.getContext('2d').drawImage(src.canvas, 0, 0);
    L.opacity = src.opacity;
    this.layers.splice(this.active + 1, 0, L);
    this.active += 1;
    this.after();
  }
  deleteLayer() {
    if (this.layers.length <= 1) return toast('An image needs at least one layer.', { type: 'warn' });
    this.checkpoint('all');
    this.layers.splice(this.active, 1);
    this.active = Math.max(0, this.active - 1);
    this.after();
  }
  moveLayer(dir) {
    const j = this.active + dir;
    if (j < 0 || j >= this.layers.length) return;
    this.checkpoint('all');
    [this.layers[this.active], this.layers[j]] = [this.layers[j], this.layers[this.active]];
    this.active = j;
    this.after();
  }
  mergeDown() {
    if (this.active === 0) return toast('The bottom layer has nothing below it.', { type: 'warn' });
    this.checkpoint('all');
    const top = this.layers[this.active], below = this.layers[this.active - 1];
    const c = this.ctxOf(below);
    if (top.visible) { c.globalAlpha = top.opacity; c.drawImage(top.canvas, 0, 0); c.globalAlpha = 1; }
    this.layers.splice(this.active, 1);
    this.active -= 1;
    this.after();
  }

  // ================================================================ image / adjustments

  imageMenu() {
    return [
      { label: 'Crop to selection', icon: 'crop', shortcut: 'Ctrl+Shift+X', disabled: !this.sel, action: () => this.cropToSel() },
      { label: 'Resize image…', icon: 'maximize', action: () => this.resizeImage(true) },
      { label: 'Canvas size…', icon: 'layers', action: () => this.resizeImage(false) },
      { sep: true },
      { label: 'Flip horizontal', action: () => this.transformAll((c, W, H) => { c.translate(W, 0); c.scale(-1, 1); }) },
      { label: 'Flip vertical', action: () => this.transformAll((c, W, H) => { c.translate(0, H); c.scale(1, -1); }) },
      { label: 'Rotate 90° right', icon: 'rotate-cw', action: () => this.rotate(1) },
      { label: 'Rotate 90° left', icon: 'rotate-ccw', action: () => this.rotate(-1) },
      { sep: true },
      { label: 'Add image from file as layer…', icon: 'image-plus', action: () => this.layerFromFile() },
      { label: 'New layer from the image dump…', icon: 'image', action: () => this.layerFromDump() },
      { label: 'Image dump drawer', icon: 'image', checked: this.dumps?.image.open, action: () => this.dumps.image.toggle() },
      { label: 'Flatten', action: () => { this.checkpoint('all'); const f = this.flatten(); const L = this.makeLayer('Background'); L.canvas.getContext('2d').drawImage(f, 0, 0); this.layers = [L]; this.active = 0; this.after(); } },
    ];
  }

  adjustMenu() {
    const pix = (fn) => () => {
      this.checkpoint();
      const s = this.selOrAll();
      const c = this.ctxOf();
      const img = c.getImageData(s.x, s.y, s.w, s.h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) fn(d, i);
      c.putImageData(img, s.x, s.y);
      this.after();
    };
    return [
      { label: 'Invert colours', action: pix((d, i) => { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }) },
      { label: 'Black and white', action: pix((d, i) => { const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = v; }) },
      { label: 'Sepia', action: pix((d, i) => { const r = d[i], g = d[i + 1], b = d[i + 2]; d[i] = Math.min(255, r * 0.393 + g * 0.769 + b * 0.189); d[i + 1] = Math.min(255, r * 0.349 + g * 0.686 + b * 0.168); d[i + 2] = Math.min(255, r * 0.272 + g * 0.534 + b * 0.131); }) },
      { label: 'Brighter', action: pix((d, i) => { d[i] = Math.min(255, d[i] + 20); d[i + 1] = Math.min(255, d[i + 1] + 20); d[i + 2] = Math.min(255, d[i + 2] + 20); }) },
      { label: 'Darker', action: pix((d, i) => { d[i] = Math.max(0, d[i] - 20); d[i + 1] = Math.max(0, d[i + 1] - 20); d[i + 2] = Math.max(0, d[i + 2] - 20); }) },
      { label: 'More contrast', action: pix((d, i) => { for (let k = 0; k < 3; k++) d[i + k] = clamp((d[i + k] - 128) * 1.2 + 128, 0, 255); }) },
      { label: 'Blur', action: () => this.filterCss('blur(2px)') },
      { label: 'Sharpen', action: () => this.sharpen() },
      { sep: true },
      { label: 'Applies to the selection, or the whole layer', disabled: true },
    ];
  }

  filterCss(f) {
    this.checkpoint();
    const s = this.selOrAll();
    const tmp = mkCanvas(this.W, this.H);
    const t = tmp.getContext('2d');
    t.filter = f;
    t.drawImage(this.layer.canvas, 0, 0);
    const c = this.ctxOf();
    c.clearRect(s.x, s.y, s.w, s.h);
    c.drawImage(tmp, s.x, s.y, s.w, s.h, s.x, s.y, s.w, s.h);
    this.after();
  }

  sharpen() {
    this.checkpoint();
    const s = this.selOrAll();
    const c = this.ctxOf();
    const src = c.getImageData(s.x, s.y, s.w, s.h);
    const out = c.createImageData(s.w, s.h);
    const a = src.data, o = out.data, W = s.w;
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) {
        const n = (dx, dy) => { const xx = clamp(x + dx, 0, s.w - 1), yy = clamp(y + dy, 0, s.h - 1); return a[(yy * W + xx) * 4 + k]; };
        o[i + k] = clamp(5 * a[i + k] - n(-1, 0) - n(1, 0) - n(0, -1) - n(0, 1), 0, 255);
      }
      o[i + 3] = a[i + 3];
    }
    c.putImageData(out, s.x, s.y);
    this.after();
  }

  cropToSel() {
    const s = this.sel;
    if (!s) return toast('Draw a selection first (S).', { type: 'warn' });
    this.checkpoint('all');
    for (const L of this.layers) { const c = mkCanvas(s.w, s.h); c.getContext('2d').drawImage(L.canvas, -s.x, -s.y); L.canvas = c; }
    this.W = s.w; this.H = s.h;
    this.sel = null;
    this.fitStage();
    this.after();
    this.zoom('fit');
  }

  async resizeImage(scale) {
    const w = h('input', { type: 'number', min: '1', max: '10000', value: String(this.W) });
    const hh = h('input', { type: 'number', min: '1', max: '10000', value: String(this.H) });
    const keep = h('input', { type: 'checkbox', checked: true });
    w.addEventListener('input', () => { if (keep.checked) hh.value = String(Math.max(1, Math.round((Number(w.value) * this.H) / this.W))); });
    hh.addEventListener('input', () => { if (keep.checked) w.value = String(Math.max(1, Math.round((Number(hh.value) * this.W) / this.H))); });
    const res = await modal({
      title: scale ? 'Resize image' : 'Canvas size',
      body: h('div', { class: 'form-grid' }, h('label', {}, 'Width'), w, h('label', {}, 'Height'), hh, h('span'), h('label', { class: 'check' }, keep, 'Keep proportions'),
        scale ? null : h('div', { class: 'faint', style: { gridColumn: '1 / -1', fontSize: '11px' } }, 'The picture stays the same size, centred; the canvas grows or shrinks around it.')),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Apply', value: 'ok', primary: true }],
    });
    if (res !== 'ok') return;
    const W = clamp(Math.round(Number(w.value)), 1, 10000), H = clamp(Math.round(Number(hh.value)), 1, 10000);
    this.checkpoint('all');
    for (const L of this.layers) {
      const c = mkCanvas(W, H);
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      if (scale) x.drawImage(L.canvas, 0, 0, W, H); else x.drawImage(L.canvas, Math.round((W - this.W) / 2), Math.round((H - this.H) / 2));
      L.canvas = c;
    }
    this.W = W; this.H = H;
    this.sel = null;
    this.fitStage();
    this.after();
    this.zoom('fit');
  }

  transformAll(fn) {
    this.checkpoint('all');
    for (const L of this.layers) { const c = mkCanvas(this.W, this.H); const x = c.getContext('2d'); fn(x, this.W, this.H); x.drawImage(L.canvas, 0, 0); L.canvas = c; }
    this.after();
  }

  rotate(dir) {
    this.checkpoint('all');
    const W = this.H, H = this.W;
    for (const L of this.layers) {
      const c = mkCanvas(W, H);
      const x = c.getContext('2d');
      x.translate(W / 2, H / 2); x.rotate((dir * Math.PI) / 2); x.drawImage(L.canvas, -this.W / 2, -this.H / 2);
      L.canvas = c;
    }
    this.W = W; this.H = H;
    this.sel = null;
    this.fitStage();
    this.after();
    this.zoom('fit');
  }

  async layerFromFile() {
    const paths = await pickOpen({ title: 'Add an image as a layer', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
    if (!paths?.[0]) return;
    const { bytes } = await api.read(paths[0]);
    await this.addImageLayer(new Blob([bytes]), paths[0].split(/[\\/]/).pop());
  }

  async layerFromDump() {
    let items = [];
    try { items = (await api.dump('image')).items; } catch { /* ignore */ }
    if (!items.length) return toast('The image dump is empty.', { type: 'warn' });
    let ctx = null;
    const grid = h('div', { class: 'mail-dumppick image' }, items.map((it) => {
      const b = h('button', { class: 'mail-dumpitem', title: it.name }, h('img', { src: it.url, alt: '' }), h('span', { class: 'mail-dumpname' }, it.name));
      b.addEventListener('click', async () => { ctx?.close(null); await this.addImageLayer(await (await fetch(it.url)).blob(), it.name); });
      return b;
    }));
    modal({ title: 'Add a picture from the image dump', wide: true, body: grid, buttons: [{ label: 'Cancel', value: null, ghost: true }], onOpen: (c) => { ctx = c; } });
  }

  // ================================================================ zoom

  fitStage() {
    this.view.width = this.overlay.width = this.W;
    this.view.height = this.overlay.height = this.H;
    this.applyZoom();
  }

  applyZoom() {
    const z = this.zoomLevel;
    for (const c of [this.view, this.overlay]) { c.style.width = this.W * z + 'px'; c.style.height = this.H * z + 'px'; }
    this.stage.style.width = this.W * z + 'px';
    this.stage.style.height = this.H * z + 'px';
    this.view.style.imageRendering = z >= 2 ? 'pixelated' : 'auto';
    if (this.zoomLabel) this.zoomLabel.textContent = Math.round(z * 100) + '%';
    this.drawOverlay();
    this.refreshStatus();
  }

  zoom(delta) {
    if (delta === 'fit') {
      const r = this.scroller.getBoundingClientRect();
      this.zoomLevel = clamp(Math.min((r.width - 48) / this.W, (r.height - 48) / this.H), 0.05, 1);
    } else if (delta === 0) this.zoomLevel = 1;
    else {
      const i = ZOOMS.findIndex((z) => z >= this.zoomLevel - 0.001);
      this.zoomLevel = delta > 0 ? ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS[i] > this.zoomLevel + 0.001 ? i : i + 1)] : ZOOMS[Math.max(0, (i < 0 ? ZOOMS.length : i) - 1)];
    }
    this.applyZoom();
  }

  // ================================================================ keys

  onKey(e) {
    if (this.app.active !== this.tab) return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || document.querySelector('.modal-backdrop')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && !e.shiftKey && k === 'z') { e.preventDefault(); return this.undo(); }
    if (ctrl && (k === 'y' || (e.shiftKey && k === 'z'))) { e.preventDefault(); return this.redo(); }
    if (ctrl && k === 'a') { e.preventDefault(); this.sel = { x: 0, y: 0, w: this.W, h: this.H }; this.setTool('select'); return; }
    if (ctrl && k === 'd') { e.preventDefault(); this.sel = null; this.drawOverlay(); this.syncProps(); return; }
    if (ctrl && k === 'c') { e.preventDefault(); return this.copySelection(false); }
    if (ctrl && k === 'x' && !e.shiftKey) { e.preventDefault(); return this.copySelection(true); }
    if (ctrl && e.shiftKey && k === 'x') { e.preventDefault(); return this.cropToSel(); }
    if (ctrl || e.altKey) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return this.clearSelection(); }
    if (e.key === 'Escape') { this.sel = null; this.drawOverlay(); this.syncProps(); return; }
    if (e.key === '[') { this.size = Math.max(1, this.size - (this.size > 20 ? 5 : 1)); this.sizeIn.value = String(this.size); return this.syncProps(); }
    if (e.key === ']') { this.size = Math.min(120, this.size + (this.size >= 20 ? 5 : 1)); this.sizeIn.value = String(this.size); return this.syncProps(); }
    if (k === 'x') return this.swapColors();
    if (k === 'd') { this.primary = '#000000'; this.secondary = '#ffffff'; return this.syncProps(); }
    const tool = TOOLS.find((x) => x[3].toLowerCase() === k);
    if (tool) { e.preventDefault(); this.setTool(tool[0]); }
  }

  // ================================================================ save / export

  saveFormats() { return [{ ext: 'png', name: 'PNG image' }, { ext: 'jpg', name: 'JPEG image' }, { ext: 'webp', name: 'WebP image' }]; }
  lossyFormat(ext) { return this.layers.length > 1; } // layers are flattened when saving

  async serialize(ext) {
    const jpg = ext === 'jpg' || ext === 'jpeg';
    const c = this.flatten(jpg ? '#ffffff' : null);
    const blob = await new Promise((r) => c.toBlob(r, jpg ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png', 0.92));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async exportToDump() {
    try {
      const bytes = await this.serialize('png');
      const name = `${stripExt(this.tab.title) || 'image'}.png`;
      const r = await api.dumpAdd(name, bytes, 'image');
      toast(`Saved ${r.name} to the image dump`, { type: 'ok' });
    } catch (e) { errorToast(e, 'Export failed'); }
  }

  menus() {
    return {
      edit: [
        { label: 'Copy selection', icon: 'copy', shortcut: 'Ctrl+C', action: () => this.copySelection(false) },
        { label: 'Cut selection', shortcut: 'Ctrl+X', action: () => this.copySelection(true) },
        { label: 'Select all', shortcut: 'Ctrl+A', action: () => { this.sel = { x: 0, y: 0, w: this.W, h: this.H }; this.drawOverlay(); } },
        { label: 'Deselect', shortcut: 'Ctrl+D', action: () => { this.sel = null; this.drawOverlay(); } },
        { label: 'Erase selection', shortcut: 'Del', action: () => this.clearSelection() },
      ],
      tools: [
        { label: 'Export to the image dump', icon: 'image-down', action: () => this.exportToDump() },
        { label: 'Read text in this image (BoxScribe)', icon: 'scan-text', action: async () => { const { scribeBytes } = await import('./scribe.js'); scribeBytes(this.app, `${stripExt(this.tab.title)}.png`, await this.serialize('png')); } },
      ],
    };
  }

  status() {
    return {
      left: [{ text: `${this.W} × ${this.H}`, icon: 'image' }, { text: `${this.layers.length} layer${this.layers.length === 1 ? '' : 's'}` }, ...(this.sel ? [{ text: `selection ${this.sel.w}×${this.sel.h}` }] : []), ...(this.cursor ? [{ text: `${Math.floor(this.cursor.x)}, ${Math.floor(this.cursor.y)}` }] : [])],
      right: [{ text: Math.round(this.zoomLevel * 100) + '%' }],
    };
  }

  onShow() { requestAnimationFrame(() => this.applyZoom()); }
  destroy() { document.removeEventListener('paste', this.pasteHandler); document.removeEventListener('keydown', this.keyHandler); this.dumps?.destroy(); }
}
