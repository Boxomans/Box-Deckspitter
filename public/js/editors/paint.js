// BoxPaint — a lightweight Paint.NET-style editor: layers, brush, eraser, line/rectangle/ellipse, fill bucket,
// text (typed on the canvas, any font), colour picker, rectangle selection (crop/clear/copy/cut/paste), move /
// transform (drag, resize, rotate, flip a layer or the selection), zoom, undo/redo.
// Left mouse button paints with the primary colour, right button with the secondary (like Paint.NET).

import { BaseEditor } from './base.js';
import { h, clear, uid, clamp, stripExt, blobToDataURL, basename } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { tbButton, tbSep, toast, errorToast, modal, promptDialog, showMenu, colorPopover, hoverKeys, renameInline, contextMenu } from '../core/ui.js';
import { encodeGif, decodeGif } from '../core/gif.js';
import { OUT_FORMATS, outKind, defaultOut, formatSelect, formatNote, warnFormat, imageSettings, encodeCanvas, copyCanvas, readMeta } from './image-out.js';
import { api } from '../core/api.js';
import { pickOpen } from '../core/files.js';
import { DumpDock, DUMP_MIME } from './doc/image-dump.js';
import { FONTS } from './doc/styles.js';

const TOOLS = [
  ['brush', 'brush', 'Brush', 'B'], ['eraser', 'eraser', 'Eraser', 'E'], ['line', 'line', 'Line', 'L'],
  ['rect', 'square', 'Rectangle', 'R'], ['ellipse', 'circle', 'Ellipse', 'O'], ['fill', 'bucket', 'Paint bucket', 'F'],
  ['text', 'type', 'Text', 'T'], ['picker', 'pipette', 'Colour picker', 'K'], ['select', 'select', 'Rectangle select', 'S'], ['move', 'move', 'Move / transform — drag the handles to resize, the dot to rotate', 'M'],
];
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
const MAX_UNDO = 30;
const TEXT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56, 64, 72, 96, 120, 144, 192, 256];
const ROT_GAP = 22; // screen px from the box's top edge to its rotate dot
const angNorm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const selBox = (r) => ({ cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, rot: 0 });
const UNDO_BYTES = 768 * 1024 * 1024; // frames make snapshots big: older steps are dropped past this

const mkCanvas = (w, h2) => { const c = document.createElement('canvas'); c.width = w; c.height = h2; return c; };
/**
 * Accuracy: fewer half-coloured (anti-aliased) pixels along edges. 0 = smooth as drawn, 100 = every pixel is either
 * fully painted or not at all. In between, edges get sharper. color (optional): the one colour that was drawn, so the
 * kept pixels get it exactly (a faint pixel's colour can't be read back precisely).
 */
function harden(canvas, acc, rect = null, color = null) {
  if (!(acc > 0)) return;
  const x0 = Math.max(0, Math.floor(rect ? rect.x : 0)), y0 = Math.max(0, Math.floor(rect ? rect.y : 0));
  const x1 = Math.min(canvas.width, Math.ceil(rect ? rect.x + rect.w : canvas.width)), y1 = Math.min(canvas.height, Math.ceil(rect ? rect.y + rect.h : canvas.height));
  if (x1 <= x0 || y1 <= y0) return;
  const c = canvas.getContext('2d');
  const img = c.getImageData(x0, y0, x1 - x0, y1 - y0);
  const d = img.data;
  const rgb = /^#[0-9a-f]{6}$/i.test(color || '') ? hexToRgba(color) : null;
  const k = acc >= 100 ? 0 : 1 + Math.pow(acc / 100, 2) * 24; // contrast on the edge's alpha
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i];
    if (a === 0 || (a === 255 && !rgb)) continue;
    const na = a === 255 ? 255 : k === 0 ? (a >= 128 ? 255 : 0) : Math.max(0, Math.min(255, Math.round((a - 128) * k + 128)));
    d[i] = na;
    if (rgb && na) { d[i - 3] = rgb[0]; d[i - 2] = rgb[1]; d[i - 1] = rgb[2]; }
  }
  c.putImageData(img, x0, y0);
}

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
    this.accuracy = s.paintAccuracy ?? 0;
    this.textOpts = { font: s.paintFont || 'Segoe UI', size: s.paintTextSize || 32, bold: !!s.paintBold, italic: !!s.paintItalic, underline: !!s.paintUnderline, align: s.paintAlign || 'left' };
    this.xf = null; // a transform in progress (move tool): the pixels being moved and their box
    this.textEdit = null; // text being typed on the canvas
    this.primary = s.paintPrimary || '#1d1b22';
    this.secondary = s.paintSecondary || '#ffffff';
    this.zoomLevel = 1;
    // an image is a list of frames (one, unless it's an animation); each frame has its own layers
    this.frames = [{ id: uid('F'), layers: [], active: 0, delay: 100 }];
    this.fi = 0;
    this.frameMode = 'each'; // each: edits change the frame you're on · add: every edit goes on a new frame
    this.onion = s.paintOnion ?? true;
    const own = this.tab.ext;
    this.out = defaultOut(this.app, bytes?.length ? (outKind(own) ? own : 'png') : null);
    this.meta = bytes?.length ? readMeta(bytes) : null;
    this.fresh = true; // every save is a brand-new file: hidden info never comes along
    this.layers = [];
    this.active = 0;
    this.sel = null; // {x,y,w,h} in image pixels
    this.undoStack = [];
    this.redoStack = [];
    this.buildDom();
    if (bytes && bytes.length) {
      let anim = null;
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) { try { anim = await decodeGif(bytes); } catch { anim = null; } }
      if (anim && anim.frames.length > 1) {
        this.newImage(anim.width, anim.height, 'transparent');
        this.frames = anim.frames.map((f) => {
          const L = this.makeLayer('Background');
          L.canvas.getContext('2d').drawImage(f.canvas, 0, 0);
          return { id: uid('F'), layers: [L], active: 0, delay: f.delay };
        });
        this.fi = 0;
        this.out.loop = anim.loop;
      } else {
        const bmp = await createImageBitmap(new Blob([bytes]));
        this.newImage(bmp.width, bmp.height, 'transparent');
        this.layers[0].canvas.getContext('2d').drawImage(bmp, 0, 0);
        this.layers[0].name = 'Background';
      }
    } else {
      const spec = await this.askNewSize();
      this.newImage(spec.w, spec.h, spec.bg);
      this.setOutExt(spec.ext, { quiet: true, init: true });
    }
    this.renderLayers();
    this.renderStrip();
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
        h('button', { class: 'icon-btn', 'data-tip': 'New layer from the media dump', onclick: () => this.layerFromDump() }, icon('image-plus', 'sm')),
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
    this.strip = h('div', { class: 'paint-strip', hidden: true });
    this.root = h('div', { class: 'paint-wrap' }, this.main, this.strip, this.dumps.el);
    this.pane.append(this.root);

    // pointer
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    this.overlay.addEventListener('pointermove', (e) => this.onMove(e));
    this.overlay.addEventListener('pointerup', (e) => this.onUp(e));
    this.overlay.addEventListener('pointerleave', () => { if (!this.drag) this.drawOverlay(); });
    this.scroller.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.zoom(e.deltaY < 0 ? 1 : -1, e); } }, { passive: false });
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
    this.accIn = h('input', { type: 'range', min: '0', max: '100', value: String(this.accuracy), class: 'paint-acc', 'data-tip': 'Accuracy: how crisp edges are. Higher = fewer half-coloured pixels; 100 = none (pixel-art edges)' });
    this.accLabel = h('span', { class: 'mono paint-size-label' });
    this.accIn.addEventListener('input', () => { this.accuracy = Number(this.accIn.value); this.syncProps(); this.drawOverlay(); });
    this.accIn.addEventListener('change', () => this.app.saveSettings({ paintAccuracy: this.accuracy }));
    // text: font (yours, then the ones on this PC), a small size list, bold / italic / underline, alignment
    this.fontSel = h('select', { class: 'tb-select paint-font', 'data-tip': 'Font: yours (Settings → Appearance → Your fonts), then the ones installed on this PC' });
    this.fontSel.addEventListener('change', () => this.setText({ font: this.fontSel.value }));
    this.fillFonts();
    this.tsizeSel = h('select', { class: 'tb-select paint-tsize', 'data-tip': 'Text size (px)' });
    this.tsizeSel.addEventListener('change', () => this.setText({ size: Number(this.tsizeSel.value) }));
    this.textBtns = {};
    const tog = (k, ic, tip) => (this.textBtns[k] = tbButton(ic, tip, () => this.setText({ [k]: !this.textOpts[k] })));
    this.alignBtn = tbButton('align-left', 'Alignment', () => this.setText({ align: { left: 'center', center: 'right', right: 'left' }[this.textOpts.align] || 'left' }));
    this.textBar = h('span', { class: 'paint-optbar' }, this.fontSel, this.tsizeSel,
      tog('bold', 'bold', 'Bold (Ctrl+B)'), tog('italic', 'italic', 'Italic (Ctrl+I)'), tog('underline', 'underline', 'Underline (Ctrl+U)'), this.alignBtn);
    // move / transform: flips, quarter turns, exact size, done / cancel
    this.moveBar = h('span', { class: 'paint-optbar' },
      tbButton('flip-h', 'Flip horizontally', () => this.xfOp((x) => { x.fx *= -1; x.rot = angNorm(-x.rot); })),
      tbButton('flip-v', 'Flip vertically', () => this.xfOp((x) => { x.fy *= -1; x.rot = angNorm(-x.rot); })),
      tbButton('rotate-ccw', 'Rotate 90° left', () => this.xfOp((x) => { x.rot = angNorm(x.rot - Math.PI / 2); })),
      tbButton('rotate-cw', 'Rotate 90° right', () => this.xfOp((x) => { x.rot = angNorm(x.rot + Math.PI / 2); })),
      tbButton('resize', 'Size and angle…', () => this.xfDialog()),
      (this.xfDone = tbButton('check', 'Done (Enter)', () => this.endXf())),
      (this.xfCancel = tbButton('x', 'Cancel (Esc)', () => this.cancelXf())));
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
      h('span', { class: 'faint paint-lbl' }, 'accuracy'), this.accIn, this.accLabel,
      this.shapeSel,
      h('span', { class: 'faint paint-lbl paint-tolwrap' }, 'tolerance'), this.tolIn,
      this.textBar, this.moveBar,
      this.propLabel,
      h('div', { class: 'grow' }),
      (this.fmtSel = formatSelect(this)),
      tbButton('settings', 'Image settings — file type, quality, GIF options, hidden info', () => this.openSettings()),
      tbButton('pages', 'Frames — make an animated GIF', () => { this.stripOpen = !this.stripOpen; this.renderStrip(); }),
      tbSep(),
      tbButton('image', 'Image: crop, resize, flip, rotate', (e) => showMenu(this.imageMenu(), { anchor: e.currentTarget })),
      tbButton('sliders', 'Adjustments', (e) => showMenu(this.adjustMenu(), { anchor: e.currentTarget })),
      tbSep(),
      tbButton('zoom-out', 'Zoom out', () => this.zoom(-1)),
      this.zoomLabel,
      tbButton('zoom-in', 'Zoom in', () => this.zoom(1)),
      tbButton('fit-page', 'Fit', () => this.zoom('fit')),
      tbSep(),
      tbButton('image-down', 'Export to the media dump', () => this.exportToDump(), { text: 'To dump' }),
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
    const sized = ['brush', 'eraser', 'line', 'rect', 'ellipse'].includes(t);
    show(this.sizeIn, sized); show(this.sizeLabel, sized); show(this.sizeIn.previousSibling, sized);
    const op = ['brush', 'line', 'rect', 'ellipse', 'text'].includes(t);
    show(this.opIn, op); show(this.opIn.previousSibling, op);
    show(this.shapeSel, t === 'rect' || t === 'ellipse');
    show(this.tolIn, t === 'fill'); show(this.tolIn.previousSibling, t === 'fill');
    const acc = ['brush', 'eraser', 'line', 'rect', 'ellipse', 'text'].includes(t);
    show(this.accIn, acc); show(this.accIn.previousSibling, acc); show(this.accLabel, acc);
    this.accLabel.textContent = `${this.accuracy}%`;
    show(this.textBar, t === 'text');
    show(this.moveBar, t === 'move');
    this.xfDone.disabled = this.xfCancel.disabled = !this.xf;
    this.syncText();
    const box = t === 'move' && (this.xf || this.moveBox());
    this.propLabel.textContent = t === 'fill' ? String(this.tolerance) : t === 'select' && this.sel ? `${Math.round(this.sel.w)}×${Math.round(this.sel.h)}`
      : box ? `${Math.round(box.w)}×${Math.round(box.h)}${box.rot ? ` · ${Math.round((box.rot * 180) / Math.PI)}°` : ''}` : '';
    if (!this.drag) this.overlay.style.cursor = { picker: 'copy', move: 'move', text: 'text', select: 'crosshair', fill: 'cell' }[t] || 'crosshair';
    if (this.textEdit) this.layoutText();
  }

  setTool(t) {
    if (t !== 'text') this.commitText();
    if (t !== 'move') this.endXf();
    this.tool = t;
    for (const [id, b] of Object.entries(this.toolBtns || {})) b.classList.toggle('active', id === t);
    this.syncProps();
    this.drawOverlay();
    this.refreshStatus();
  }

  pickColor(which, anchor) {
    colorPopover(anchor, { onPick: (c) => { if (!c) return; this[which] = c; this.app.saveSettings({ [which === 'primary' ? 'paintPrimary' : 'paintSecondary']: c }); this.syncProps(); this.textEdit?.ta.focus(); } });
  }
  swapColors() { [this.primary, this.secondary] = [this.secondary, this.primary]; this.syncProps(); }

  // ================================================================ document

  async askNewSize() {
    const w = h('input', { type: 'number', min: '1', max: '10000', value: String(this.app.settings.paintW || 1280) });
    const hh = h('input', { type: 'number', min: '1', max: '10000', value: String(this.app.settings.paintH || 720) });
    const bg = h('select', {}, h('option', { value: '#ffffff' }, 'White'), h('option', { value: 'transparent' }, 'Transparent'), h('option', { value: '#000000' }, 'Black'));
    const type = h('select', {}, ...OUT_FORMATS.map((f) => h('option', { value: f.ext }, `${f.label} — ${f.name}`)));
    type.value = outKind(this.app.settings.paintExt) || 'png';
    const note = h('div', { class: 'imgset-note', style: { gridColumn: '1 / -1' } });
    const sync = () => {
      const see = bg.value === 'transparent';
      const n = formatNote(type.value, { transparent: see, partial: see });
      note.className = `imgset-note ${n.warn ? 'warn' : ''}`;
      clear(note).append(icon(n.warn ? 'alert' : 'info', 'sm'), h('span', {}, n.text));
    };
    type.addEventListener('change', sync);
    bg.addEventListener('change', sync);
    sync();
    const presets = h('div', { class: 'row', style: { flexWrap: 'wrap' } }, [['1280×720', 1280, 720], ['1920×1080', 1920, 1080], ['1080×1080', 1080, 1080], ['800×600', 800, 600], ['Letter 2550×3300', 2550, 3300]].map(([l, a, b]) =>
      h('button', { class: 'chip', onclick: () => { w.value = a; hh.value = b; } }, l)));
    const res = await modal({
      title: 'New image', dismissable: false,
      body: h('div', { class: 'form-grid' }, h('label', {}, 'Width (px)'), w, h('label', {}, 'Height (px)'), hh, h('label', {}, 'Background'), bg, h('span'), presets,
        h('label', {}, 'Save as'), type, note),
      buttons: [{ label: 'Create', value: 'ok', primary: true }],
    });
    void res;
    const W = clamp(Math.round(Number(w.value) || 1280), 1, 10000);
    const H = clamp(Math.round(Number(hh.value) || 720), 1, 10000);
    this.app.saveSettings({ paintW: W, paintH: H, paintExt: type.value });
    return { w: W, h: H, bg: bg.value, ext: type.value };
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
  get frame() { return this.frames?.[this.fi]; }
  get layers() { return this.frame?.layers || []; }
  set layers(v) { if (this.frame) this.frame.layers = v; }
  get active() { return this.frame?.active ?? 0; }
  set active(v) { if (this.frame) this.frame.active = v; }
  /** Every layer of every frame (resize, crop, rotate… apply to all of them). */
  allLayers() { return this.frames.flatMap((f) => f.layers); }
  get layer() { return this.layers[this.active]; }
  ctxOf(L = this.layer) { return L.canvas.getContext('2d', { willReadFrequently: true }); }

  composite() {
    const c = this.view.getContext('2d');
    c.clearRect(0, 0, this.W, this.H);
    const onion = this.onionFrame();
    if (onion) { c.globalAlpha = 0.3; c.drawImage(onion, 0, 0); }
    for (const L of this.layers) {
      if (!L.visible) continue;
      c.globalAlpha = L.opacity;
      c.drawImage(L.canvas, 0, 0);
      if (L === this.layer && this.stroke) { c.globalAlpha = L.opacity * this.stroke.alpha; c.globalCompositeOperation = 'source-over'; c.drawImage(this.stroke.canvas, 0, 0); }
    }
    c.globalAlpha = 1;
  }

  /** Flattened image (all visible layers) of a frame (the one you're on unless given). */
  flatten(background = null, frame = this.frame) {
    const c = mkCanvas(this.W, this.H);
    const x = c.getContext('2d', { willReadFrequently: true });
    if (background) { x.fillStyle = background; x.fillRect(0, 0, this.W, this.H); }
    for (const L of frame.layers) { if (!L.visible) continue; x.globalAlpha = L.opacity; x.drawImage(L.canvas, 0, 0); }
    x.globalAlpha = 1;
    return c;
  }

  /** The frame before, shown faintly under this one while you draw (onion skin). */
  onionFrame() {
    if (!this.onion || this.playing || !this.frames || this.fi === 0 || this.frames.length < 2) return null;
    const prev = this.frames[this.fi - 1];
    const key = `${prev.id}:${this.fi}`;
    if (this._onionKey !== key) { this._onionCanvas = this.flatten(null, prev); this._onionKey = key; }
    return this._onionCanvas;
  }

  // ================================================================ undo

  snapshot(kind = 'pixels') {
    const L = this.layer;
    const one = this.W * this.H * 4;
    if (kind === 'pixels') return { kind, id: L.id, data: this.ctxOf(L).getImageData(0, 0, this.W, this.H), bytes: one };
    const frames = this.frames.map((f) => ({ id: f.id, delay: f.delay, active: f.active, layers: f.layers.map((x) => ({ id: x.id, name: x.name, visible: x.visible, opacity: x.opacity, data: this.ctxOf(x).getImageData(0, 0, this.W, this.H) })) }));
    return { kind: 'all', W: this.W, H: this.H, fi: this.fi, frames, bytes: one * this.allLayers().length };
  }
  restore(s) {
    this.xf = null;
    if (s.kind === 'pixels') {
      this.frames.forEach((f, k) => {
        const L = f.layers.find((x) => x.id === s.id);
        if (!L) return;
        this.ctxOf(L).putImageData(s.data, 0, 0);
        if (k !== this.fi) { this.fi = k; this.renderStrip(); } // undo shows you the frame it changed
      });
    } else {
      this.W = s.W; this.H = s.H;
      this.view.width = this.overlay.width = s.W;
      this.view.height = this.overlay.height = s.H;
      this.frames = s.frames.map((f) => ({
        id: f.id, delay: f.delay, active: clamp(f.active, 0, f.layers.length - 1),
        layers: f.layers.map((x) => { const c = mkCanvas(s.W, s.H); c.getContext('2d').putImageData(x.data, 0, 0); return { id: x.id, name: x.name, visible: x.visible, opacity: x.opacity, canvas: c }; }),
      }));
      this.fi = clamp(s.fi, 0, this.frames.length - 1);
      this.fitStage();
      this.renderStrip();
    }
  }
  checkpoint(kind = 'pixels') {
    this.xf = null; // any other change makes a transform final
    // "Add frames": a change to the picture goes on a new frame, a copy of this one
    const adding = kind === 'pixels' && this.frameMode === 'add';
    this.undoStack.push(this.snapshot(adding ? 'all' : kind));
    let total = this.undoStack.reduce((n, x) => n + (x.bytes || 0), 0);
    while (this.undoStack.length > MAX_UNDO || (this.undoStack.length > 1 && total > UNDO_BYTES)) total -= this.undoStack.shift().bytes || 0;
    this.redoStack = [];
    if (adding) this.spawnFrame(true);
    this.markDirty();
  }
  undo() {
    this.cancelText();
    const s = this.undoStack.pop();
    if (!s) return toast('Nothing to undo', { timeout: 1000 });
    this.redoStack.push(s.kind === 'pixels' ? this.snapshotOf(s.id) : this.snapshot('all'));
    this.restore(s);
    this.after();
  }
  redo() {
    this.cancelText();
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(s.kind === 'pixels' ? this.snapshotOf(s.id) : this.snapshot('all'));
    this.restore(s);
    this.after();
  }
  snapshotOf(id) { const L = this.allLayers().find((x) => x.id === id) || this.layer; return { kind: 'pixels', id: L.id, data: this.ctxOf(L).getImageData(0, 0, this.W, this.H), bytes: this.W * this.H * 4 }; }
  after() { this.rev = (this.rev || 0) + 1; this._onionKey = null; this.composite(); this.renderLayers(); this.drawOverlay(); this.syncProps(); this.refreshThumb(); this.refreshStatus(); }

  // ================================================================ pointer

  pt(e) {
    const r = this.overlay.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.W, y: ((e.clientY - r.top) / r.height) * this.H };
  }

  /** At full accuracy, painting snaps to the pixel grid (odd sizes to pixel centres) so edges land on whole pixels. */
  snap(p) {
    if (this.accuracy < 100 || !['brush', 'eraser', 'line', 'rect', 'ellipse'].includes(this.tool)) return p;
    const odd = Math.round(this.size) % 2 === 1;
    const f = (v) => (odd ? Math.floor(v) + 0.5 : Math.round(v));
    return { x: f(p.x), y: f(p.y) };
  }
  /** The area a brush segment from a to b touches. */
  segRect(a, b) {
    const r = this.size / 2 + 2;
    return { x: Math.min(a.x, b.x) - r, y: Math.min(a.y, b.y) - r, w: Math.abs(a.x - b.x) + r * 2, h: Math.abs(a.y - b.y) + r * 2 };
  }

  onDown(e) {
    if (e.button === 1) return; // middle: let the scroller pan
    if (this.playing) this.togglePlay();
    e.preventDefault();
    this.overlay.setPointerCapture(e.pointerId);
    const p = this.snap(this.pt(e));
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
        if (this.accuracy >= 100) harden(sc, 100, this.segRect(p, p), this.stroke.erase ? '#000000' : color);
        if (this.stroke.erase) this.previewErase(); else this.composite();
        break;
      }
      case 'select': {
        // on the selection: its handles resize it, inside moves it; anywhere else starts a new one
        const hit = this.sel && this.hitBox(selBox(this.sel), p, false);
        this.drag = hit ? { start: p, now: p, ...hit, s0: { ...this.sel } } : { start: p, now: p, color, button: e.button };
        break;
      }
      case 'line': case 'rect': case 'ellipse':
        this.drag = { start: p, now: p, color, button: e.button };
        break;
      case 'move': {
        // handles resize, the dot rotates, anywhere else moves; the pixels lift off on the first drag
        const box = this.xf || this.moveBox();
        if (!box) { toast(this.sel ? 'Nothing selected on this layer.' : 'This layer is empty — nothing to move.', { type: 'warn' }); break; }
        const hit = this.hitBox(box, p, true);
        this.drag = { start: p, now: p, mode: hit?.mode === 'scale' || hit?.mode === 'rotate' ? hit.mode : 'move', hx: hit?.hx, hy: hit?.hy, s0: { cx: box.cx, cy: box.cy, w: box.w, h: box.h, rot: box.rot || 0 } };
        break;
      }
      case 'fill':
        this.checkpoint();
        this.floodFill(Math.floor(p.x), Math.floor(p.y), color);
        this.after();
        break;
      case 'picker': {
        const d = this.flatten().getContext('2d').getImageData(clamp(Math.floor(p.x), 0, this.W - 1), clamp(Math.floor(p.y), 0, this.H - 1), 1, 1).data;
        const hex = '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
        if (e.button === 2) this.secondary = hex; else this.primary = hex;
        this.syncProps();
        break;
      }
      case 'text': this.openText(p, e.button === 2 ? 'secondary' : 'primary'); break;
      default: break;
    }
  }

  onMove(e) {
    const p = this.snap(this.pt(e));
    this.cursor = p;
    if (this.stroke) {
      if (p.x === this.stroke.last.x && p.y === this.stroke.last.y) return;
      const c = this.stroke.canvas.getContext('2d');
      c.beginPath(); c.moveTo(this.stroke.last.x, this.stroke.last.y); c.lineTo(p.x, p.y); c.stroke();
      // full accuracy shows crisp while drawing (doing it again never changes a pixel); in between, it's done at the end
      if (this.accuracy >= 100) harden(this.stroke.canvas, 100, this.segRect(this.stroke.last, p), this.stroke.erase ? '#000000' : this.stroke.color);
      this.stroke.last = p;
      if (this.stroke.erase) this.previewErase(); else this.composite();
      this.drawOverlay();
      return;
    }
    if (this.drag) {
      this.drag.now = p;
      if (this.tool === 'move') return this.dragXf(p, e.shiftKey);
      if (this.tool === 'select' && this.drag.mode) return this.dragSel(p);
      this.drawOverlay();
      return;
    }
    if (this.tool === 'move' || this.tool === 'select') this.hoverCursor(p);
    this.drawOverlay();
  }

  onUp(e) {
    if (this.stroke) {
      const s = this.stroke;
      this.stroke = null;
      if (this.accuracy > 0 && this.accuracy < 100) harden(s.canvas, this.accuracy, null, s.erase ? '#000000' : s.color);
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
      if (d.mode) this.sel = this.clipRect(this.sel);
      else if (e.shiftKey && w > 1 && hh > 1) { const k = Math.max(w, hh); this.sel = this.clipRect({ x: Math.round(d.now.x < d.start.x ? d.start.x - k : d.start.x), y: Math.round(d.now.y < d.start.y ? d.start.y - k : d.start.y), w: Math.round(k), h: Math.round(k) }); }
      else this.sel = w > 1 && hh > 1 ? this.clipRect({ x: Math.round(x0), y: Math.round(y0), w: Math.round(w), h: Math.round(hh) }) : null;
      this.syncProps();
      this.drawOverlay();
      this.refreshStatus();
      return;
    }
    if (this.tool === 'move') { if (this.xf) this.after(); return; }
    if (w < 1 && hh < 1) { this.drawOverlay(); return; }
    this.checkpoint();
    const c = this.ctxOf();
    this.drawShape(c, d.start, d.now, d.button === 2 ? this.secondary : this.primary, d.button === 2 ? this.primary : this.secondary, e.shiftKey);
    this.after();
  }

  /** Shapes: Outline uses the button's colour; Fill / both fill with the other colour (Paint.NET style). */
  drawShape(c, a, b, strokeColor, fillColor, square) {
    if (this.accuracy > 0 && this.tool !== 'text') {
      a = this.snap(a); b = this.snap(b);
      if (this._sheet?.width !== this.W || this._sheet?.height !== this.H) this._sheet = mkCanvas(this.W, this.H);
      const sheet = this._sheet;
      sheet.getContext('2d').clearRect(0, 0, this.W, this.H);
      const keep = this.opacity;
      this.opacity = 1;
      try { this.drawShapeOn(sheet.getContext('2d'), a, b, strokeColor, fillColor, square); } finally { this.opacity = keep; }
      const pad = this.size + 2;
      const one = this.tool === 'line' || this.shapeMode !== 'both' || strokeColor === fillColor;
      harden(sheet, this.accuracy, { x: Math.min(a.x, b.x) - pad, y: Math.min(a.y, b.y) - pad, w: Math.abs(a.x - b.x) + pad * 2 + (square ? Math.abs(a.x - b.x) + Math.abs(a.y - b.y) : 0), h: Math.abs(a.y - b.y) + pad * 2 + (square ? Math.abs(a.x - b.x) + Math.abs(a.y - b.y) : 0) },
        one ? (this.shapeMode === 'fill' || this.tool === 'line' || this.shapeMode === 'stroke' ? strokeColor : null) : null);
      c.save(); c.globalAlpha = this.opacity; c.drawImage(sheet, 0, 0); c.restore();
      return;
    }
    this.drawShapeOn(c, a, b, strokeColor, fillColor, square);
  }

  drawShapeOn(c, a, b, strokeColor, fillColor, square) {
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
    if (this.drag && this.tool !== 'move' && !this.drag.mode) {
      if (this.tool === 'select') this.drawSelRect(c, this.drag.start, this.drag.now, px);
      else this.drawShape(c, this.drag.start, this.drag.now, this.drag.button === 2 ? this.secondary : this.primary, this.drag.button === 2 ? this.primary : this.secondary, false);
    }
    const drawingSel = this.drag && this.tool === 'select' && !this.drag.mode;
    if (this.sel && !drawingSel) this.drawSelRect(c, { x: this.sel.x, y: this.sel.y }, { x: this.sel.x + this.sel.w, y: this.sel.y + this.sel.h }, px);
    if (this.tool === 'select' && this.sel && !drawingSel) this.drawBox(c, selBox(this.sel), px, false);
    if (this.tool === 'move' && !this.playing) { const b = this.xf || this.moveBox(); if (b) this.drawBox(c, b, px, true); }
    if (this.textEdit) { c.save(); c.globalAlpha = this.opacity; this.drawText(c, this.textEdit); c.restore(); }
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

  // ================================================================ text

  /** The font list: yours first (Settings → Appearance → Your fonts), then every family installed on this PC. */
  async fillFonts() {
    const sel = this.fontSel;
    const opt = (value, label, css) => h('option', { value, style: `font-family:${css}` }, label);
    const mine = this.app.uiFontList().filter(([id]) => id.startsWith('u:'));
    const fill = (installed) => {
      const cur = this.textOpts.font;
      clear(sel);
      if (mine.length) sel.append(h('optgroup', { label: 'Your fonts' }, mine.map(([id, label, css]) => opt(id, label.replace(/ \(yours\)$/, ''), css))));
      sel.append(h('optgroup', { label: 'Installed' }, installed.map((f) => opt(f, f, `"${f}"`))));
      if (![...sel.options].some((o) => o.value === cur)) sel.prepend(opt(cur, cur.startsWith('u:') ? 'Removed font' : cur, `"${cur}"`));
      sel.value = cur;
    };
    if (!this.localFonts) fill(FONTS);
    try {
      const list = this.localFonts || (await window.queryLocalFonts?.());
      if (list?.length) fill((this.localFonts = list) && [...new Set(list.map((f) => f.family))].sort((a, b) => a.localeCompare(b)));
    } catch { // the PC's list needs the window on screen: try again when the list is opened
      if (!this.fontRetry) { this.fontRetry = true; this.fontSel.addEventListener('pointerdown', () => { if (!this.localFonts) this.fillFonts(); }); }
    }
  }

  syncText() {
    if (!this.textBtns) return;
    const t = this.textOpts;
    for (const k of ['bold', 'italic', 'underline']) this.textBtns[k].classList.toggle('active', !!t[k]);
    this.alignBtn.replaceChildren(icon(`align-${t.align}`));
    this.alignBtn.dataset.tip = `Alignment: ${t.align}`;
    if (![...this.tsizeSel.options].some((o) => Number(o.value) === t.size) || this.tsizeSel.options.length !== new Set([...TEXT_SIZES, t.size]).size) {
      clear(this.tsizeSel).append(...[...new Set([...TEXT_SIZES, t.size])].sort((a, b) => a - b).map((n) => h('option', { value: String(n) }, String(n))));
    }
    this.tsizeSel.value = String(t.size);
    if (this.fontSel.value !== t.font && [...this.fontSel.options].some((o) => o.value === t.font)) this.fontSel.value = t.font;
  }

  setText(patch) {
    Object.assign(this.textOpts, patch);
    const t = this.textOpts;
    this.app.saveSettings({ paintFont: t.font, paintTextSize: t.size, paintBold: t.bold, paintItalic: t.italic, paintUnderline: t.underline, paintAlign: t.align });
    this.syncText();
    this.layoutText();
    this.textEdit?.ta.focus();
  }

  /** The canvas font for the text options (scale: the zoom, for the typing box). */
  textFont(scale = 1) {
    const t = this.textOpts;
    const mine = t.font.startsWith('u:') && this.app.uiFontList().find(([id]) => id === t.font);
    return `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${t.size * scale}px ${mine ? mine[2] : `"${t.font}", sans-serif`}`;
  }

  /** Where each line goes: x is the left edge, the centre or the right edge, by the alignment. */
  textLayout(te) {
    const t = this.textOpts;
    const lines = te.ta.value.split('\n');
    const m = (this._measure ||= mkCanvas(1, 1).getContext('2d'));
    m.font = this.textFont();
    const widths = lines.map((l) => m.measureText(l).width);
    const w = Math.max(t.size * 0.5, ...widths), lh = t.size * 1.25;
    const left = t.align === 'left' ? te.x : t.align === 'center' ? te.x - w / 2 : te.x - w;
    return { lines, widths, w, lh, left, top: te.y, h: lh * lines.length };
  }

  drawText(c, te) {
    const t = this.textOpts, L = this.textLayout(te);
    c.save();
    c.font = this.textFont();
    c.fillStyle = this[te.which];
    c.textBaseline = 'middle';
    c.textAlign = t.align;
    const ax = t.align === 'left' ? L.left : t.align === 'center' ? L.left + L.w / 2 : L.left + L.w;
    L.lines.forEach((line, i) => {
      const y = L.top + L.lh * i + L.lh / 2;
      c.fillText(line, ax, y);
      const lw = L.widths[i];
      if (t.underline && lw) c.fillRect(t.align === 'left' ? ax : t.align === 'center' ? ax - lw / 2 : ax - lw, y + t.size * 0.42, lw, Math.max(1, t.size / 14));
    });
    c.restore();
  }

  /** Click with the text tool: a box to type in right on the picture (the text shows as it will look). */
  openText(p, which) {
    this.commitText();
    const ta = h('textarea', { class: 'paint-textedit', spellcheck: 'false', rows: '1' });
    const grip = h('div', { class: 'paint-textgrip', 'data-tip': 'Drag to move · Ctrl+Enter or click away to finish · Esc to cancel' }, icon('move', 'sm'));
    const box = h('div', { class: 'paint-textbox' }, grip, ta);
    this.stage.append(box);
    const te = (this.textEdit = { x: p.x, y: p.y, which, box, ta });
    ta.addEventListener('input', () => this.layoutText());
    ta.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { e.preventDefault(); this.cancelText(); } else if (e.key === 'Enter' && ctrl) { e.preventDefault(); this.commitText(); } else if (ctrl && ['b', 'i', 'u'].includes(k)) {
        e.preventDefault();
        const key = { b: 'bold', i: 'italic', u: 'underline' }[k];
        this.setText({ [key]: !this.textOpts[key] });
      }
    });
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY, ox = te.x, oy = te.y;
      const mv = (ev) => { te.x = ox + (ev.clientX - sx) / this.zoomLevel; te.y = oy + (ev.clientY - sy) / this.zoomLevel; this.layoutText(); };
      const up = () => { grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); ta.focus(); };
      grip.addEventListener('pointermove', mv);
      grip.addEventListener('pointerup', up);
    });
    this.layoutText();
    requestAnimationFrame(() => ta.focus());
  }

  /** Lines the typing box up with the text (at this zoom) and redraws the preview. */
  layoutText() {
    const te = this.textEdit;
    if (!te) return;
    const f = this.textFont();
    if (!document.fonts.check(f) && this._fontTried !== f) { this._fontTried = f; document.fonts.load(f).then(() => this.layoutText(), () => {}); }
    const z = this.zoomLevel, L = this.textLayout(te), pad = 3;
    Object.assign(te.box.style, { left: L.left * z - pad + 'px', top: L.top * z + 'px' });
    Object.assign(te.ta.style, {
      width: L.w * z + pad * 2 + 'px', height: L.h * z + 'px', padding: `0 ${pad}px`, font: this.textFont(z), lineHeight: L.lh * z + 'px',
      textAlign: this.textOpts.align, caretColor: this[te.which],
    });
    this.drawOverlay();
  }

  commitText() {
    const te = this.textEdit;
    if (!te) return;
    this.textEdit = null;
    te.box.remove();
    if (!te.ta.value.trim()) { this.drawOverlay(); return; }
    this.checkpoint();
    const sheet = mkCanvas(this.W, this.H);
    this.drawText(sheet.getContext('2d'), te);
    if (this.accuracy > 0) harden(sheet, this.accuracy, null, this[te.which]);
    const c = this.ctxOf();
    c.save(); c.globalAlpha = this.opacity; c.drawImage(sheet, 0, 0); c.restore();
    this.after();
  }

  cancelText() {
    const te = this.textEdit;
    if (!te) return;
    this.textEdit = null;
    te.box.remove();
    this.drawOverlay();
  }

  // ================================================================ move / transform

  /** A rectangle trimmed to the picture (null if nothing's left). */
  clipRect(r) {
    if (!r) return null;
    const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y));
    const x1 = Math.min(this.W, Math.round(r.x + r.w)), y1 = Math.min(this.H, Math.round(r.y + r.h));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  /** The smallest rectangle round everything on a layer that isn't see-through. */
  contentBounds(L = this.layer) {
    const W = this.W, H = this.H, d = this.ctxOf(L).getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      const row = y * W * 4;
      for (let x = 0; x < W; x++) {
        if (!d[row + x * 4 + 3]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** What the move tool would pick up: the selection, or everything on the layer. */
  moveBox() {
    const L = this.layer;
    if (!L) return null;
    const key = `${L.id}:${this.rev || 0}:${this.sel ? [this.sel.x, this.sel.y, this.sel.w, this.sel.h].join() : ''}`;
    if (this._mvKey !== key) {
      this._mvKey = key;
      const r = this.sel ? this.clipRect(this.sel) : this.contentBounds(L);
      this._mvBox = r && selBox(r);
    }
    return this._mvBox;
  }

  /** Lifts the pixels: the rest of the layer stays put and the lifted part is redrawn from the original each time,
   *  so sizing up and down again never blurs it. */
  startXf() {
    if (this.xf) return this.xf;
    const r = this.sel ? this.clipRect(this.sel) : this.contentBounds();
    if (!r) { toast(this.sel ? 'Nothing selected on this layer.' : 'This layer is empty — nothing to move.', { type: 'warn' }); return null; }
    const sel0 = this.sel && { ...this.sel };
    this.checkpoint();
    const L = this.layer;
    const src = mkCanvas(r.w, r.h);
    src.getContext('2d').drawImage(L.canvas, -r.x, -r.y);
    const base = mkCanvas(this.W, this.H);
    const b = base.getContext('2d');
    b.drawImage(L.canvas, 0, 0);
    b.clearRect(r.x, r.y, r.w, r.h);
    this.xf = { L, src, base, ...selBox(r), fx: 1, fy: 1, sel0 };
    return this.xf;
  }

  renderXf() {
    const x = this.xf;
    if (!x) return;
    const c = this.ctxOf(x.L);
    c.save();
    c.clearRect(0, 0, this.W, this.H);
    c.drawImage(x.base, 0, 0);
    c.imageSmoothingEnabled = this.accuracy < 100;
    c.imageSmoothingQuality = 'high';
    if (!x.rot) { // straight: whole pixels, so a plain move stays sharp
      const w = Math.max(1, Math.round(x.w)), hh = Math.max(1, Math.round(x.h));
      c.translate(Math.round(x.cx - x.w / 2) + (x.fx < 0 ? w : 0), Math.round(x.cy - x.h / 2) + (x.fy < 0 ? hh : 0));
      c.scale(x.fx, x.fy);
      c.drawImage(x.src, 0, 0, w, hh);
    } else {
      c.translate(x.cx, x.cy);
      c.rotate(x.rot);
      c.scale(x.fx, x.fy);
      c.drawImage(x.src, -x.w / 2, -x.h / 2, x.w, x.h);
    }
    c.restore();
    if (x.sel0) this.sel = this.clipRect(this.boxRect(x)); // the selection follows what you moved
    this.composite();
    this.drawOverlay();
    this.syncProps();
    this.refreshStatus();
  }

  /** The upright rectangle round a (maybe turned) box. */
  boxRect(b) {
    const cos = Math.abs(Math.cos(b.rot || 0)), sin = Math.abs(Math.sin(b.rot || 0));
    const w = b.w * cos + b.h * sin, hh = b.w * sin + b.h * cos;
    return { x: b.cx - w / 2, y: b.cy - hh / 2, w, h: hh };
  }

  /** Done: the transform stays as it is. */
  endXf() {
    if (!this.xf) return;
    this.xf = null;
    this.drawOverlay();
    this.syncProps();
  }

  /** Puts everything back as it was before the transform. */
  cancelXf() {
    const x = this.xf;
    if (!x) return;
    this.undo();
    this.redoStack.pop();
    this.sel = x.sel0 || null;
    this.drawOverlay();
    this.syncProps();
  }

  /** A toolbar / menu change to the layer (or selection): flips, quarter turns, exact size. */
  xfOp(fn) {
    if (this.tool !== 'move') this.setTool('move');
    const x = this.startXf();
    if (!x) return;
    fn(x);
    this.renderXf();
    this.after();
  }

  async xfDialog() {
    if (this.tool !== 'move') this.setTool('move');
    const b = this.xf || this.moveBox();
    if (!b) return toast(this.sel ? 'Nothing selected on this layer.' : 'This layer is empty — nothing to size.', { type: 'warn' });
    const w = h('input', { type: 'number', min: '1', max: '20000', value: String(Math.round(b.w)) });
    const hh = h('input', { type: 'number', min: '1', max: '20000', value: String(Math.round(b.h)) });
    const pct = h('input', { type: 'number', min: '1', max: '2000', value: '100' });
    const ang = h('input', { type: 'number', min: '-360', max: '360', step: '1', value: String(Math.round(((b.rot || 0) * 180) / Math.PI)) });
    const keep = h('input', { type: 'checkbox', checked: true });
    const ratio = b.w / b.h;
    w.addEventListener('input', () => { if (keep.checked) hh.value = String(Math.max(1, Math.round(Number(w.value) / ratio))); pct.value = String(Math.round((Number(w.value) / b.w) * 100)); });
    hh.addEventListener('input', () => { if (keep.checked) w.value = String(Math.max(1, Math.round(Number(hh.value) * ratio))); });
    pct.addEventListener('input', () => { const k = Number(pct.value) / 100; w.value = String(Math.max(1, Math.round(b.w * k))); hh.value = String(Math.max(1, Math.round(b.h * k))); });
    const res = await modal({
      title: this.sel ? 'Selection size and angle' : 'Layer size and angle',
      body: h('div', { class: 'form-grid' }, h('label', {}, 'Width'), w, h('label', {}, 'Height'), hh, h('label', {}, 'Scale %'), pct, h('span'), h('label', { class: 'check' }, keep, 'Keep proportions'),
        h('label', {}, 'Angle (°)'), ang),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Apply', value: 'ok', primary: true }],
    });
    if (res !== 'ok') return;
    this.xfOp((x) => {
      x.w = clamp(Math.round(Number(w.value)) || 1, 1, 20000);
      x.h = clamp(Math.round(Number(hh.value)) || 1, 1, 20000);
      x.rot = angNorm(((Number(ang.value) || 0) * Math.PI) / 180);
    });
  }

  /** Dragging with the move tool: move (Shift: straight), a handle (corners keep proportions, Shift frees them),
   *  or the dot (Shift: 15° steps). */
  dragXf(p, shift) {
    const d = this.drag, s = d.s0;
    if (!this.xf && (Math.abs(p.x - d.start.x) < 0.5 && Math.abs(p.y - d.start.y) < 0.5)) return;
    const x = this.startXf();
    if (!x) { this.drag = null; return; }
    if (d.mode === 'rotate') {
      let a = s.rot + Math.atan2(p.y - s.cy, p.x - s.cx) - Math.atan2(d.start.y - s.cy, d.start.x - s.cx);
      if (shift) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      x.rot = angNorm(a);
    } else if (d.mode === 'scale') {
      const cos = Math.cos(s.rot), sin = Math.sin(s.rot);
      const qx = p.x - s.cx, qy = p.y - s.cy;
      const lx = qx * cos + qy * sin, ly = -qx * sin + qy * cos;
      const ax = (-d.hx * s.w) / 2, ay = (-d.hy * s.h) / 2; // the opposite side stays put
      let w = d.hx ? Math.max(1, (lx - ax) * d.hx) : s.w, hh = d.hy ? Math.max(1, (ly - ay) * d.hy) : s.h;
      if (d.hx && d.hy && !shift) { const k = Math.max(w / s.w, hh / s.h); w = s.w * k; hh = s.h * k; }
      const ccx = d.hx ? ax + (d.hx * w) / 2 : 0, ccy = d.hy ? ay + (d.hy * hh) / 2 : 0;
      x.w = w; x.h = hh;
      x.cx = s.cx + ccx * cos - ccy * sin;
      x.cy = s.cy + ccx * sin + ccy * cos;
    } else {
      let mx = p.x - d.start.x, my = p.y - d.start.y;
      if (shift) { if (Math.abs(mx) > Math.abs(my)) my = 0; else mx = 0; }
      x.cx = s.cx + Math.round(mx);
      x.cy = s.cy + Math.round(my);
    }
    this.renderXf();
  }

  /** Dragging the selection itself: inside moves it, a handle resizes it. */
  dragSel(p) {
    const d = this.drag, s = d.s0;
    const dx = Math.round(p.x - d.start.x), dy = Math.round(p.y - d.start.y);
    if (d.mode === 'move') this.sel = { ...s, x: s.x + dx, y: s.y + dy };
    else {
      let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
      if (d.hx < 0) x0 += dx;
      if (d.hx > 0) x1 += dx;
      if (d.hy < 0) y0 += dy;
      if (d.hy > 0) y1 += dy;
      this.sel = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(1, Math.abs(x1 - x0)), h: Math.max(1, Math.abs(y1 - y0)) };
    }
    this.syncProps();
    this.drawOverlay();
  }

  /** The rotate dot: above the box, or just inside it when above would be off the picture. */
  rotHandle(b) {
    const cos = Math.cos(b.rot || 0), sin = Math.sin(b.rot || 0), r = ROT_GAP / this.zoomLevel;
    const at = (ly) => ({ x: b.cx - ly * sin, y: b.cy + ly * cos });
    const out = at(-b.h / 2 - r);
    return out.x < 0 || out.y < 0 || out.x > this.W || out.y > this.H ? at(-b.h / 2 + r) : out;
  }

  /** What's under the pointer on a box: { mode: 'rotate' | 'scale' (hx, hy: -1, 0, 1) | 'move' } or null. */
  hitBox(b, p, rotate) {
    const tol = 6 / this.zoomLevel;
    if (rotate) { const r = this.rotHandle(b); if (Math.hypot(p.x - r.x, p.y - r.y) <= tol * 1.4) return { mode: 'rotate' }; }
    const cos = Math.cos(b.rot || 0), sin = Math.sin(b.rot || 0);
    const dx = p.x - b.cx, dy = p.y - b.cy;
    const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
    for (const hy of [-1, 0, 1]) for (const hx of [-1, 0, 1]) {
      if ((hx || hy) && Math.abs(lx - (hx * b.w) / 2) <= tol && Math.abs(ly - (hy * b.h) / 2) <= tol) return { mode: 'scale', hx, hy };
    }
    return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2 ? { mode: 'move' } : null;
  }

  hoverCursor(p) {
    const b = this.tool === 'move' ? this.xf || this.moveBox() : this.sel && selBox(this.sel);
    const hit = b && this.hitBox(b, p, this.tool === 'move');
    let cur = this.tool === 'move' ? 'move' : 'crosshair';
    if (hit?.mode === 'rotate') cur = 'grab';
    else if (hit?.mode === 'scale') cur = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][(((Math.round((Math.atan2(hit.hy, hit.hx) + (b.rot || 0)) / (Math.PI / 4))) % 4) + 4) % 4];
    else if (hit?.mode === 'move') cur = 'move';
    this.overlay.style.cursor = cur;
  }

  /** A box with its eight handles (and the rotate dot). */
  drawBox(c, b, px, rotate) {
    const cos = Math.cos(b.rot || 0), sin = Math.sin(b.rot || 0);
    const at = (lx, ly) => [b.cx + lx * cos - ly * sin, b.cy + lx * sin + ly * cos];
    const hw = b.w / 2, hh = b.h / 2;
    c.save();
    c.lineWidth = px;
    c.beginPath();
    [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].forEach(([x, y], i) => (i ? c.lineTo(...at(x, y)) : c.moveTo(...at(x, y))));
    c.closePath();
    c.strokeStyle = 'rgba(0,0,0,.75)'; c.stroke();
    c.setLineDash([4 * px, 4 * px]); c.strokeStyle = '#fff'; c.stroke(); c.setLineDash([]);
    if (rotate) {
      const r = this.rotHandle(b);
      c.beginPath(); c.moveTo(...at(0, -hh)); c.lineTo(r.x, r.y); c.strokeStyle = 'rgba(0,0,0,.75)'; c.stroke();
      c.beginPath(); c.arc(r.x, r.y, 5 * px, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill(); c.stroke();
    }
    const sz = 7 * px;
    for (const hy of [-1, 0, 1]) for (const hx of [-1, 0, 1]) {
      if (!hx && !hy) continue;
      const [x, y] = at(hx * hw, hy * hh);
      c.fillStyle = '#fff'; c.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      c.strokeStyle = '#1a1a1a'; c.strokeRect(x - sz / 2, y - sz / 2, sz, sz);
    }
    c.restore();
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

  /** Files sent from the file panels (Ctrl+right-click): each picture becomes a layer. */
  async receiveFiles(paths) {
    let n = 0;
    for (const p of paths.filter((x) => /\.(png|jpe?g|jfif|gif|webp|bmp|svg|avif)$/i.test(x))) {
      const { bytes } = await api.read(p);
      await this.addImageLayer(new Blob([bytes], { type: p.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : '' }), basename(p));
      n++;
    }
    return n;
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
      row.addEventListener('click', () => { if (i === this.active) return; this.endXf(); this.active = i; this.renderLayers(); this.drawOverlay(); this.syncProps(); });
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
      { label: this.sel ? 'Transform the selection (M)' : 'Transform the layer (M)', icon: 'move', action: () => this.setTool('move') },
      { label: this.sel ? 'Selection size and angle…' : 'Layer size and angle…', icon: 'resize', action: () => this.xfDialog() },
      { label: 'Flip layer horizontal', icon: 'flip-h', action: () => this.xfOp((x) => { x.fx *= -1; x.rot = angNorm(-x.rot); }) },
      { label: 'Flip layer vertical', icon: 'flip-v', action: () => this.xfOp((x) => { x.fy *= -1; x.rot = angNorm(-x.rot); }) },
      { sep: true },
      { label: 'Add image from file as layer…', icon: 'image-plus', action: () => this.layerFromFile() },
      { label: 'New layer from the media dump…', icon: 'image', action: () => this.layerFromDump() },
      { label: 'Media dump drawer', icon: 'image', checked: this.dumps?.image.open, action: () => this.dumps.image.toggle() },
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
    this.cropRect(s);
  }

  /** Cut off the empty border: see-through edges, or (on a solid picture) edges the same colour as the corner. */
  trimEdges() {
    const W = this.W, H = this.H;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    let mode = null, bg = null;
    for (const f of this.frames) {
      const d = this.flatten(null, f).getContext('2d').getImageData(0, 0, W, H).data;
      if (!mode) { mode = d[3] < 255 ? 'alpha' : 'colour'; bg = [d[0], d[1], d[2]]; }
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const keep = mode === 'alpha' ? d[i + 3] > 0 : Math.abs(d[i] - bg[0]) > 8 || Math.abs(d[i + 1] - bg[1]) > 8 || Math.abs(d[i + 2] - bg[2]) > 8;
          if (!keep) continue;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return toast('The picture is empty — nothing to keep.', { type: 'warn' });
    if (x0 === 0 && y0 === 0 && x1 === W - 1 && y1 === H - 1) return toast('No empty edges to trim.', { timeout: 1600 });
    this.cropRect({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    toast(`Trimmed to ${x1 - x0 + 1} × ${y1 - y0 + 1}`, { timeout: 1600 });
  }

  cropRect(s) {
    this.checkpoint('all');
    for (const L of this.allLayers()) { const c = mkCanvas(s.w, s.h); c.getContext('2d').drawImage(L.canvas, -s.x, -s.y); L.canvas = c; }
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
    for (const L of this.allLayers()) {
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
    for (const L of this.allLayers()) { const c = mkCanvas(this.W, this.H); const x = c.getContext('2d'); fn(x, this.W, this.H); x.drawImage(L.canvas, 0, 0); L.canvas = c; }
    this.after();
  }

  rotate(dir) {
    this.checkpoint('all');
    const W = this.H, H = this.W;
    for (const L of this.allLayers()) {
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
    if (!items.length) return toast('The media dump is empty.', { type: 'warn' });
    let ctx = null;
    const grid = h('div', { class: 'mail-dumppick image' }, items.map((it) => {
      const b = h('button', { class: 'mail-dumpitem', title: it.name }, h('img', { src: it.url, alt: '' }), h('span', { class: 'mail-dumpname' }, it.name));
      b.addEventListener('click', async () => { ctx?.close(null); await this.addImageLayer(await (await fetch(it.url)).blob(), it.name); });
      return b;
    }));
    modal({ title: 'Add a picture from the media dump', wide: true, body: grid, buttons: [{ label: 'Cancel', value: null, ghost: true }], onOpen: (c) => { ctx = c; } });
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
    this.layoutText();
    this.refreshStatus();
  }

  get handlesWheelZoom() { return true; }

  /** at: a pointer event — the image spot under it stays under it. */
  zoom(delta, at = null) {
    const before = at && this.overlay.getBoundingClientRect();
    const fx = before ? (at.clientX - before.left) / before.width : 0, fy = before ? (at.clientY - before.top) / before.height : 0;
    if (delta === 'fit') {
      const r = this.scroller.getBoundingClientRect();
      this.zoomLevel = clamp(Math.min((r.width - 48) / this.W, (r.height - 48) / this.H), 0.05, 1);
    } else if (delta === 0) this.zoomLevel = 1;
    else {
      const i = ZOOMS.findIndex((z) => z >= this.zoomLevel - 0.001);
      this.zoomLevel = delta > 0 ? ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS[i] > this.zoomLevel + 0.001 ? i : i + 1)] : ZOOMS[Math.max(0, (i < 0 ? ZOOMS.length : i) - 1)];
    }
    this.applyZoom();
    if (before) {
      const r = this.overlay.getBoundingClientRect();
      this.scroller.scrollLeft += r.left + fx * r.width - at.clientX;
      this.scroller.scrollTop += r.top + fy * r.height - at.clientY;
    }
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
    if (ctrl && k === 'a') { e.preventDefault(); this.endXf(); this.sel = { x: 0, y: 0, w: this.W, h: this.H }; this.setTool('select'); return; }
    if (ctrl && k === 'd') { e.preventDefault(); this.endXf(); this.sel = null; this.drawOverlay(); this.syncProps(); return; }
    if (ctrl && k === 'c') { e.preventDefault(); return this.copySelection(false); }
    if (ctrl && k === 'x' && !e.shiftKey) { e.preventDefault(); return this.copySelection(true); }
    if (ctrl && e.shiftKey && k === 'x') { e.preventDefault(); return this.cropToSel(); }
    if (ctrl || e.altKey) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return this.clearSelection(); }
    if (e.key === 'Escape') { if (this.xf) return this.cancelXf(); this.sel = null; this.drawOverlay(); this.syncProps(); return; }
    if (e.key === 'Enter' && this.xf) { e.preventDefault(); return this.endXf(); }
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (arrow && (this.tool === 'move' || (this.tool === 'select' && this.sel))) {
      e.preventDefault();
      const n = e.shiftKey ? 10 : 1;
      if (this.tool === 'select') { this.sel = { ...this.sel, x: this.sel.x + arrow[0] * n, y: this.sel.y + arrow[1] * n }; this.drawOverlay(); return; }
      const x = this.startXf();
      if (x) { x.cx += arrow[0] * n; x.cy += arrow[1] * n; this.renderXf(); }
      return;
    }
    if (e.key === '[') { this.size = Math.max(1, this.size - (this.size > 20 ? 5 : 1)); this.sizeIn.value = String(this.size); return this.syncProps(); }
    if (e.key === ']') { this.size = Math.min(120, this.size + (this.size >= 20 ? 5 : 1)); this.sizeIn.value = String(this.size); return this.syncProps(); }
    if ((e.key === ',' || e.key === '.') && this.frames.length > 1) { e.preventDefault(); return this.selectFrame((this.fi + (e.key === '.' ? 1 : this.frames.length - 1)) % this.frames.length); }
    if (k === 'x') return this.swapColors();
    if (k === 'd') { this.primary = '#000000'; this.secondary = '#ffffff'; return this.syncProps(); }
    const tool = TOOLS.find((x) => x[3].toLowerCase() === k);
    if (tool) { e.preventDefault(); this.setTool(tool[0]); }
  }

  // ================================================================ save / export

  saveFormats() {
    const fm = OUT_FORMATS.map((f) => ({ ext: f.ext, name: f.name }));
    if (['jpeg', 'jfif'].includes(this.tab.ext)) fm.unshift({ ext: this.tab.ext, name: 'JPEG image' });
    return fm;
  }
  // layers are flattened when saving; frames need a GIF
  lossyFormat(ext) { return this.frames.some((f) => f.layers.length > 1) || (outKind(ext) !== 'gif' && this.frames.length > 1); }
  lossyNote(ext) {
    const n = this.frames.length;
    if (outKind(ext) !== 'gif' && n > 1) return `.${ext} can’t hold an animation, so only frame ${this.fi + 1} of ${n} is saved. Save as GIF to keep every frame. (The tab keeps them all until you close it.)`;
    return 'Layers are merged into one picture in the saved file. The tab keeps them separate until you close it.';
  }

  async serialize(ext) {
    this.commitText();
    const k = outKind(ext) || 'png';
    if (k === 'gif') {
      const frames = this.frames.map((f) => ({ data: this.flatten(null, f).getContext('2d').getImageData(0, 0, this.W, this.H).data, delay: f.delay }));
      return encodeGif(frames, { width: this.W, height: this.H, loop: this.out.loop, colors: this.out.colors, dither: this.out.dither });
    }
    return encodeCanvas(this.flatten(), k, this.out);
  }

  afterSave(path, ext) {
    if (!outKind(ext)) return;
    this.out.ext = ext;
    if (this.fmtSel) this.fmtSel.value = outKind(ext);
    this.renderStrip();
  }

  /** The type it'll be saved as. Changing it from the file's own type makes the next Save ask where (a new name). */
  setOutExt(ext, { quiet = false, init = false } = {}) {
    if (outKind(this.out.ext) === ext) ext = this.out.ext; // .jpeg stays .jpeg
    this.out.ext = ext;
    if (this.fmtSel) this.fmtSel.value = outKind(ext) || 'png';
    if (!quiet) warnFormat(ext, this.flatten(), this.frames.length);
    if (this.tab.ext !== ext) { this.app.setTabMeta(this.tab, { ext }); if (!init) this.markDirty(); }
    this.renderStrip();
  }

  openSettings() {
    return imageSettings({
      app: this.app, tab: this.tab, out: this.out, meta: this.meta, fresh: true,
      setOutExt: (e, o) => this.setOutExt(e, o),
      outCanvas: () => this.flatten(),
      frameCount: () => this.frames.length,
      size: () => ({ W: this.W, H: this.H }),
      resize: () => this.resizeImage(true), canvasSize: () => this.resizeImage(false), trim: () => this.trimEdges(),
      toDump: () => this.exportToDump(), copyImage: () => copyCanvas(this.flatten()),
      serialize: (e) => this.serialize(e), markDirty: () => this.markDirty(),
    });
  }

  // ================================================================ frames (animated GIF)

  renderStrip() {
    if (!this.strip || !this.frames) return;
    const show = outKind(this.out?.ext) === 'gif' || this.frames.length > 1 || !!this.stripOpen;
    this.strip.hidden = !show;
    if (!show) return;
    clear(this.strip);
    const seg = (id, label, tip) => h('button', { class: this.frameMode === id ? 'on' : '', 'data-tip': tip, onclick: () => { this.frameMode = id; this.renderStrip(); } }, label);
    const total = this.frames.reduce((n, f) => n + (f.delay || 0), 0);
    const ctrl = h('div', { class: 'paint-strip-ctrl' },
      h('div', { class: 'paint-seg' },
        seg('each', 'Edit each', 'Drawing changes the frame you’re on'),
        seg('add', 'Add frames', 'Every change goes on a new frame (a copy of this one) — stop-motion style')),
      h('button', { class: `icon-btn ${this.playing ? 'on' : ''}`, 'data-tip': this.playing ? 'Stop' : 'Play the animation', onclick: () => this.togglePlay() }, icon(this.playing ? 'pause-bars' : 'play', 'sm')),
      h('button', { class: `icon-btn ${this.onion ? 'on' : ''}`, 'data-tip': 'Onion skin: show the frame before, faintly', onclick: () => { this.onion = !this.onion; this.app.saveSettings({ paintOnion: this.onion }); this._onionKey = null; this.renderStrip(); this.composite(); } }, icon('eye', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'New blank frame', onclick: () => this.newFrame(false) }, icon('plus', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Duplicate this frame', onclick: () => this.newFrame(true) }, icon('copy', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Delete this frame', onclick: () => this.deleteFrame(this.fi) }, icon('trash', 'sm')),
      h('span', { class: 'mono faint paint-strip-info' }, `${this.fi + 1}/${this.frames.length} · ${(total / 1000).toFixed(2)}s`));
    const list = h('div', { class: 'paint-frames' });
    const th = 54, tw = clamp(Math.round((th * this.W) / this.H), 24, 140);
    this.frames.forEach((f, i) => {
      const c = mkCanvas(tw, th);
      c.className = 'checker';
      c.getContext('2d').drawImage(this.flatten(null, f), 0, 0, tw, th);
      const el = h('div', { class: `paint-frame ${i === this.fi ? 'on' : ''}`, draggable: 'true', title: 'Click: go to it · Double-click: how long it shows · Right-click: more · Drag: reorder · , and . step' },
        c, h('div', { class: 'paint-frame-lbl mono' }, `${i + 1} · ${f.delay}ms`));
      el.addEventListener('click', () => this.selectFrame(i));
      el.addEventListener('dblclick', () => this.askDelay([i]));
      el.addEventListener('contextmenu', (e) => contextMenu(e, this.frameMenu(i)));
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-bds-frame', String(i)); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-bds-frame')) { e.preventDefault(); el.classList.add('drop'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => { const from = e.dataTransfer.getData('text/x-bds-frame'); el.classList.remove('drop'); if (from !== '') { e.preventDefault(); e.stopPropagation(); this.moveFrame(Number(from), i); } });
      list.append(el);
    });
    this.strip.append(ctrl, list);
    requestAnimationFrame(() => list.querySelector('.paint-frame.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }

  /** Just the frame you're on: its thumbnail follows your drawing. */
  refreshThumb() {
    if (!this.strip || this.strip.hidden) return;
    const c = this.strip.querySelectorAll('.paint-frame canvas')[this.fi];
    if (!c) return;
    const x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    x.drawImage(this.flatten(), 0, 0, c.width, c.height);
  }

  frameMenu(i) {
    const n = this.frames.length;
    return [
      { label: 'Duplicate', icon: 'copy', action: () => { this.selectFrame(i); this.newFrame(true); } },
      { label: 'New blank frame after', icon: 'plus', action: () => { this.selectFrame(i); this.newFrame(false); } },
      { label: `How long it shows… (${this.frames[i].delay}ms)`, icon: 'clock', action: () => this.askDelay([i]) },
      { label: 'Same time for every frame…', action: () => this.askDelay(this.frames.map((_, k) => k)) },
      { sep: true },
      { label: 'Move left', icon: 'arrow-left', disabled: i === 0, action: () => this.moveFrame(i, i - 1) },
      { label: 'Move right', icon: 'arrow-right', disabled: i === n - 1, action: () => this.moveFrame(i, i + 1) },
      { label: 'Reverse the order', icon: 'swap', disabled: n < 2, action: () => { this.checkpoint('all'); this.frames.reverse(); this.fi = n - 1 - this.fi; this.renderStrip(); this.after(); } },
      { sep: true },
      { label: 'Delete frame', icon: 'trash', disabled: n < 2, action: () => this.deleteFrame(i) },
    ];
  }

  selectFrame(i) {
    if (!this.frames[i]) return;
    this.xf = null;
    this.commitText();
    this.fi = i;
    this._onionKey = null;
    this.composite();
    this.renderLayers();
    this.drawOverlay();
    this.renderStrip();
    this.refreshStatus();
  }

  /** A new frame right after this one (a copy, or blank with the same layers) — and you're on it. */
  spawnFrame(copy) {
    const src = this.frame;
    const layers = src.layers.map((L) => {
      const n = this.makeLayer(L.name);
      n.visible = L.visible; n.opacity = L.opacity;
      if (copy) n.canvas.getContext('2d').drawImage(L.canvas, 0, 0);
      return n;
    });
    this.frames.splice(this.fi + 1, 0, { id: uid('F'), layers, active: src.active, delay: src.delay });
    this.fi += 1;
    this._onionKey = null;
    this.renderStrip();
  }

  newFrame(copy) {
    this.checkpoint('all');
    this.spawnFrame(copy);
    this.after();
  }

  deleteFrame(i) {
    if (this.frames.length <= 1) return toast('An image needs at least one frame.', { type: 'warn' });
    this.checkpoint('all');
    this.frames.splice(i, 1);
    this.fi = clamp(i <= this.fi ? this.fi - 1 : this.fi, 0, this.frames.length - 1);
    this.renderStrip();
    this.after();
  }

  moveFrame(from, to) {
    if (from === to || !this.frames[from] || !this.frames[to]) return;
    this.checkpoint('all');
    const [f] = this.frames.splice(from, 1);
    this.frames.splice(to, 0, f);
    this.fi = to;
    this.renderStrip();
    this.after();
  }

  async askDelay(list) {
    const cur = this.frames[list[0]]?.delay ?? 100;
    const v = await promptDialog(list.length > 1 ? 'Time for every frame' : `Frame ${list[0] + 1}`, 'How long it shows, in milliseconds (1000 = 1 second)', String(cur), { type: 'number' });
    if (v == null || v === '') return;
    const ms = clamp(Math.round((Number(v) || 100) / 10) * 10, 10, 60000); // GIFs count in hundredths of a second
    this.checkpoint('all');
    for (const k of list) this.frames[k].delay = ms;
    this.renderStrip();
    this.refreshStatus();
  }

  togglePlay() {
    if (this.playing) {
      clearTimeout(this.playTimer);
      this.playing = false;
      this.selectFrame(clamp(this.playFrom ?? this.fi, 0, this.frames.length - 1));
      return;
    }
    if (this.frames.length < 2) return toast('Add a second frame to play it.', { timeout: 1600 });
    this.playing = true;
    this.playFrom = this.fi;
    this.renderStrip();
    const thumbs = () => this.strip.querySelectorAll('.paint-frame');
    const step = () => {
      if (!this.playing) return;
      this.fi = (this.fi + 1) % this.frames.length;
      this.composite();
      thumbs().forEach((el, k) => el.classList.toggle('on', k === this.fi));
      this.playTimer = setTimeout(step, Math.max(20, this.frame.delay));
    };
    this.playTimer = setTimeout(step, Math.max(20, this.frame.delay));
  }

  async exportToDump() {
    try {
      const ext = outKind(this.out.ext) || 'png';
      const bytes = await this.serialize(ext);
      const name = `${stripExt(this.tab.title) || 'image'}.${ext}`;
      const r = await api.dumpAdd(name, bytes, 'image');
      toast(`Saved ${r.name} to the media dump`, { type: 'ok' });
    } catch (e) { errorToast(e, 'Export failed'); }
  }

  menus() {
    return {
      edit: [
        { label: 'Copy selection', icon: 'copy', shortcut: 'Ctrl+C', action: () => this.copySelection(false) },
        { label: 'Cut selection', shortcut: 'Ctrl+X', action: () => this.copySelection(true) },
        { label: 'Select all', shortcut: 'Ctrl+A', action: () => { this.sel = { x: 0, y: 0, w: this.W, h: this.H }; this.drawOverlay(); } },
        { label: 'Deselect', shortcut: 'Ctrl+D', action: () => { this.sel = null; this.drawOverlay(); } },
        { label: 'Select what’s on this layer', action: () => { const r = this.contentBounds(); if (!r) return toast('This layer is empty.', { type: 'warn' }); this.sel = r; this.setTool('select'); } },
        { label: 'Erase selection', shortcut: 'Del', action: () => this.clearSelection() },
      ],
      tools: [
        { label: 'Image settings…', icon: 'settings', action: () => this.openSettings() },
        { label: 'Export to the media dump', icon: 'image-down', action: () => this.exportToDump() },
        { label: 'Read text in this image (BoxScribe)', icon: 'scan-text', action: async () => { const { scribeBytes } = await import('./scribe.js'); scribeBytes(this.app, `${stripExt(this.tab.title)}.png`, await this.serialize('png')); } },
      ],
    };
  }

  status() {
    return {
      left: [{ text: `${this.W} × ${this.H}`, icon: 'image' }, { text: `${this.layers.length} layer${this.layers.length === 1 ? '' : 's'}` },
        ...(this.frames?.length > 1 ? [{ text: `frame ${this.fi + 1}/${this.frames.length}` }] : []), { text: `.${this.out?.ext || 'png'}` }, ...(this.sel ? [{ text: `selection ${this.sel.w}×${this.sel.h}` }] : []), ...(this.cursor ? [{ text: `${Math.floor(this.cursor.x)}, ${Math.floor(this.cursor.y)}` }] : [])],
      right: [{ text: Math.round(this.zoomLevel * 100) + '%' }],
    };
  }

  onShow() { requestAnimationFrame(() => this.applyZoom()); }
  destroy() { this.cancelText(); clearTimeout(this.playTimer); this.playing = false; document.removeEventListener('paste', this.pasteHandler); document.removeEventListener('keydown', this.keyHandler); this.dumps?.destroy(); }
}
