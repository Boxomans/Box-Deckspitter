// Image mode — view, crop, rotate, flip, resize, adjust, annotate-free basics; save as PNG/JPG/WebP or PDF.

import { BaseEditor } from './base.js';
import { h, clear, clamp, vendor, stripExt, extOf, blobToDataURL } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { tbButton, tbSep, tbSelect, showMenu, modal, toast, errorToast } from '../core/ui.js';
import { api } from '../core/api.js';
import { OUT_FORMATS, outKind, defaultOut, formatSelect, warnFormat, imageSettings, encodeCanvas, copyCanvas, readMeta, stripMeta } from './image-out.js';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml', apng: 'image/png' };

export class ImageEditor extends BaseEditor {
  static mode = 'image';

  async load(bytes) {
    const ext = this.tab.ext || 'png';
    this.mime = MIME[ext] || 'image/png';
    this.origBytes = bytes;
    this.out = defaultOut(this.app, outKind(ext) ? ext : 'png');
    this.meta = bytes?.length ? readMeta(bytes) : null;
    this.fresh = false;
    this.canvas = h('canvas', { class: 'img-canvas' });
    this.stage = h('div', { class: 'img-stage' }, this.canvas);
    this.cropBox = h('div', { class: 'img-crop', hidden: true }, ...['nw', 'ne', 'sw', 'se'].map((k) => h('div', { class: 'img-crop-h ' + k, dataset: { h: k } })));
    this.stage.append(this.cropBox);
    this.scroller = h('div', { class: 'img-scroller checker-soft' }, this.stage);
    this.info = h('div', { class: 'img-info mono' });
    this.root = h('div', { class: 'img-root' }, this.scroller, this.info);
    this.pane.append(this.root);
    this.history = [];
    this.future = [];
    this.view = 'fit';
    this.scale = 1;
    if (bytes && bytes.length) {
      const url = URL.createObjectURL(new Blob([bytes], { type: this.mime }));
      const img = new Image();
      img.src = url;
      await img.decode().catch(() => { throw new Error('This image format can’t be displayed.'); });
      this.canvas.width = img.naturalWidth || 800;
      this.canvas.height = img.naturalHeight || 600;
      this.canvas.getContext('2d').drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
      URL.revokeObjectURL(url);
      this.animated = ext === 'gif' && bytes.length > 0 && countGifFrames(bytes) > 1;
    } else {
      this.canvas.width = 1200; this.canvas.height = 800;
      const c = this.canvas.getContext('2d');
      c.fillStyle = '#fff';
      c.fillRect(0, 0, 1200, 800);
    }
    new ResizeObserver(() => this.layout()).observe(this.scroller);
    this.wireCrop();
    this.layout();
  }

  layout() {
    const W = this.canvas.width, H = this.canvas.height;
    if (this.view === 'fit') {
      const sw = this.scroller.clientWidth - 48, sh = this.scroller.clientHeight - 48;
      this.scale = Math.min(1, sw / W, sh / H) || 1;
    }
    this.canvas.style.width = W * this.scale + 'px';
    this.canvas.style.height = H * this.scale + 'px';
    this.info.textContent = `${W} × ${H}px  ·  ${Math.round(this.scale * 100)}%${this.animated ? '  ·  animated GIF: edits keep the first frame (Frames opens it in Paint)' : ''}`;
    if (!this.cropBox.hidden) this.drawCrop();
    this.refreshStatus();
  }

  // ------------------------------------------------------------------ history

  push() {
    const c = h('canvas', { width: this.canvas.width, height: this.canvas.height });
    c.getContext('2d').drawImage(this.canvas, 0, 0);
    this.history.push(c);
    if (this.history.length > 30) this.history.shift();
    this.future = [];
  }

  swap(from, to) {
    const snap = from.pop();
    if (!snap) return;
    const cur = h('canvas', { width: this.canvas.width, height: this.canvas.height });
    cur.getContext('2d').drawImage(this.canvas, 0, 0);
    to.push(cur);
    this.canvas.width = snap.width; this.canvas.height = snap.height;
    this.canvas.getContext('2d').drawImage(snap, 0, 0);
    this.markDirty();
    this.layout();
  }

  undo() { this.swap(this.history, this.future); }
  redo() { this.swap(this.future, this.history); }

  apply(w, hh, draw) {
    this.push();
    const tmp = h('canvas', { width: this.canvas.width, height: this.canvas.height });
    tmp.getContext('2d').drawImage(this.canvas, 0, 0);
    this.canvas.width = w; this.canvas.height = hh;
    const ctx = this.canvas.getContext('2d');
    draw(ctx, tmp);
    this.markDirty();
    this.layout();
  }

  rotate(dir) {
    const W = this.canvas.width, H = this.canvas.height;
    this.apply(H, W, (ctx, src) => { ctx.translate(dir > 0 ? H : 0, dir > 0 ? 0 : W); ctx.rotate((dir * Math.PI) / 2); ctx.drawImage(src, 0, 0); });
  }

  flip(horizontal) {
    const W = this.canvas.width, H = this.canvas.height;
    this.apply(W, H, (ctx, src) => { if (horizontal) { ctx.translate(W, 0); ctx.scale(-1, 1); } else { ctx.translate(0, H); ctx.scale(1, -1); } ctx.drawImage(src, 0, 0); });
  }

  async resizeDialog() {
    const W = this.canvas.width, H = this.canvas.height;
    const wIn = h('input', { type: 'number', value: String(W), min: '1' });
    const hIn = h('input', { type: 'number', value: String(H), min: '1' });
    const lock = h('input', { type: 'checkbox' });
    lock.checked = true;
    wIn.addEventListener('input', () => { if (lock.checked) hIn.value = Math.round((Number(wIn.value) * H) / W); });
    hIn.addEventListener('input', () => { if (lock.checked) wIn.value = Math.round((Number(hIn.value) * W) / H); });
    const presets = h('div', { class: 'row' }, [25, 50, 75, 200].map((p) => h('button', { class: 'btn sm', onclick: () => { wIn.value = Math.round((W * p) / 100); hIn.value = Math.round((H * p) / 100); } }, p + '%')));
    const res = await modal({
      title: 'Resize image',
      body: h('div', { class: 'form-grid' }, h('label', {}, 'Width (px)'), wIn, h('label', {}, 'Height (px)'), hIn, h('span'), h('label', { class: 'check' }, lock, 'Keep proportions'), h('span'), presets),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Resize', value: 'ok', primary: true }],
    });
    if (res !== 'ok') return;
    const w = clamp(Math.round(Number(wIn.value)), 1, 16000), hh = clamp(Math.round(Number(hIn.value)), 1, 16000);
    this.apply(w, hh, (ctx, src) => { ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, 0, 0, w, hh); });
  }

  async adjustDialog() {
    const vals = { brightness: 100, contrast: 100, saturate: 100, 'hue-rotate': 0, grayscale: 0, sepia: 0, invert: 0, blur: 0 };
    const preview = h('canvas', { style: { maxWidth: '100%', maxHeight: '260px', display: 'block', margin: '0 auto 12px', borderRadius: '6px' } });
    const s = Math.min(1, 560 / this.canvas.width, 260 / this.canvas.height);
    preview.width = Math.max(1, Math.round(this.canvas.width * s));
    preview.height = Math.max(1, Math.round(this.canvas.height * s));
    const filterStr = () => Object.entries(vals).map(([k, v]) => `${k}(${v}${k === 'hue-rotate' ? 'deg' : k === 'blur' ? 'px' : '%'})`).join(' ');
    const draw = () => { const c = preview.getContext('2d'); c.clearRect(0, 0, preview.width, preview.height); c.filter = filterStr(); c.drawImage(this.canvas, 0, 0, preview.width, preview.height); };
    const rows = Object.entries({ brightness: [0, 200], contrast: [0, 200], saturate: [0, 300], 'hue-rotate': [-180, 180], grayscale: [0, 100], sepia: [0, 100], invert: [0, 100], blur: [0, 20] }).map(([k, [a, b]]) => {
      const r = h('input', { type: 'range', min: String(a), max: String(b), value: String(vals[k]) });
      const v = h('span', { class: 'mono faint', style: { width: '40px', textAlign: 'right' } }, String(vals[k]));
      r.addEventListener('input', () => { vals[k] = Number(r.value); v.textContent = r.value; draw(); });
      return [h('label', {}, k), h('div', { class: 'row' }, r, v)];
    });
    setTimeout(draw, 20);
    const res = await modal({
      title: 'Adjust', wide: true,
      body: h('div', {}, preview, h('div', { class: 'form-grid' }, rows.flat())),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Apply', value: 'ok', primary: true }],
    });
    if (res !== 'ok') return;
    const f = filterStr();
    this.apply(this.canvas.width, this.canvas.height, (ctx, src) => { ctx.filter = f; ctx.drawImage(src, 0, 0); });
  }

  // ------------------------------------------------------------------ crop

  startCrop() {
    this.crop = { x: this.canvas.width * 0.1, y: this.canvas.height * 0.1, w: this.canvas.width * 0.8, h: this.canvas.height * 0.8 };
    this.cropBox.hidden = false;
    this.drawCrop();
    this.cropBar = h('div', { class: 'img-cropbar' },
      h('span', { class: 'mono' }, 'drag the box or its corners'),
      ...[['free', null], ['1:1', 1], ['4:3', 4 / 3], ['16:9', 16 / 9]].map(([l, r]) => h('button', { class: 'btn sm', onclick: () => this.cropRatio(r) }, l)),
      h('button', { class: 'btn sm', onclick: () => this.endCrop(false) }, 'Cancel'),
      h('button', { class: 'btn sm primary', onclick: () => this.endCrop(true) }, 'Apply crop'));
    this.root.append(this.cropBar);
  }

  cropRatio(r) {
    this.cropAspect = r;
    if (!r) return;
    const c = this.crop;
    c.h = Math.min(c.h, c.w / r);
    c.w = c.h * r;
    this.drawCrop();
  }

  drawCrop() {
    const c = this.crop;
    const off = this.canvas.offsetLeft;
    const top = this.canvas.offsetTop;
    Object.assign(this.cropBox.style, { left: off + c.x * this.scale + 'px', top: top + c.y * this.scale + 'px', width: c.w * this.scale + 'px', height: c.h * this.scale + 'px' });
  }

  wireCrop() {
    this.cropBox.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const handle = e.target.dataset.h;
      const mx = e.clientX;
      const my = e.clientY;
      const s0 = { ...this.crop };
      const W = this.canvas.width, H = this.canvas.height;
      const move = (ev) => {
        const dx = (ev.clientX - mx) / this.scale;
        const dy = (ev.clientY - my) / this.scale;
        const c = this.crop;
        if (!handle) {
          c.x = clamp(s0.x + dx, 0, W - c.w);
          c.y = clamp(s0.y + dy, 0, H - c.h);
        } else {
          const L = handle.includes('w') ? clamp(s0.x + dx, 0, s0.x + s0.w - 8) : s0.x;
          const T = handle.includes('n') ? clamp(s0.y + dy, 0, s0.y + s0.h - 8) : s0.y;
          const R = handle.includes('e') ? clamp(s0.x + s0.w + dx, L + 8, W) : s0.x + s0.w;
          const B = handle.includes('s') ? clamp(s0.y + s0.h + dy, T + 8, H) : s0.y + s0.h;
          c.x = L; c.y = T; c.w = R - L; c.h = B - T;
          if (this.cropAspect) { c.h = c.w / this.cropAspect; if (c.y + c.h > H) { c.h = H - c.y; c.w = c.h * this.cropAspect; } }
        }
        this.drawCrop();
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  endCrop(apply) {
    this.cropBox.hidden = true;
    this.cropBar?.remove();
    if (!apply) return;
    const c = this.crop;
    const x = Math.round(c.x), y = Math.round(c.y), w = Math.round(c.w), hh = Math.round(c.h);
    this.apply(w, hh, (ctx, src) => ctx.drawImage(src, x, y, w, hh, 0, 0, w, hh));
  }

  // ------------------------------------------------------------------ toolbar / io

  buildToolbar() {
    return h('div', { class: 'toolbar' },
      tbButton('undo', 'Undo', () => this.undo(), { key: 'Ctrl+Z' }),
      tbButton('redo', 'Redo', () => this.redo(), { key: 'Ctrl+Y' }),
      tbSep(),
      tbButton('rotate-ccw', 'Rotate left', () => this.rotate(-1)),
      tbButton('rotate-cw', 'Rotate right', () => this.rotate(1)),
      tbButton('flip-h', 'Flip horizontal', () => this.flip(true)),
      tbButton('flip-v', 'Flip vertical', () => this.flip(false)),
      tbSep(),
      tbButton('crop', 'Crop', () => this.startCrop(), { text: 'Crop' }),
      tbButton('resize', 'Resize', () => this.resizeDialog(), { text: 'Resize' }),
      tbButton('sliders', 'Adjust colors', () => this.adjustDialog(), { text: 'Adjust' }),
      tbSep(),
      tbButton('zoom-out', 'Zoom out', () => this.zoom(-1)),
      tbButton('fit-page', 'Fit', () => { this.view = 'fit'; this.layout(); }),
      tbButton('zoom-in', 'Zoom in', () => this.zoom(1)),
      tbSep(),
      (this.fmtSel = formatSelect(this)),
      tbButton('settings', 'Image settings — file type, quality, hidden info', () => this.openSettings()),
      this.animated && this.tab.path ? tbButton('pages', 'Edit every frame in Paint', () => this.app.reopenAs(this.tab, 'paint'), { text: 'Frames' }) : null,
      tbSep(),
      tbButton('image', 'Send to media dump', () => this.toDump(), { text: 'To dump' }),
      this.tab.ext === 'svg' && this.tab.path ? tbButton('code', 'Edit SVG source', () => this.app.reopenAs(this.tab, 'code'), { text: 'Source' }) : null,
    );
  }

  async toDump() {
    const blob = await new Promise((r) => this.canvas.toBlob(r, 'image/png'));
    try {
      await api.dumpAdd(stripExt(this.tab.title) + '.png', new Uint8Array(await blob.arrayBuffer()));
      toast('Saved to the media dump', { type: 'ok' });
    } catch (e) { errorToast(e); }
  }

  zoom(d) {
    if (d === 0) { this.view = 'fit'; this.layout(); return; }
    this.view = 'manual';
    this.scale = clamp(this.scale * (d > 0 ? 1.25 : 0.8), 0.05, 16);
    this.layout();
  }

  status() {
    return { left: [{ text: `${this.canvas.width} × ${this.canvas.height}px` }], right: [{ text: Math.round(this.scale * 100) + '%', action: () => this.zoom(0) }] };
  }

  menus() {
    return {
      edit: [
        { label: 'Rotate left', icon: 'rotate-ccw', action: () => this.rotate(-1) },
        { label: 'Rotate right', icon: 'rotate-cw', action: () => this.rotate(1) },
        { label: 'Flip horizontal', icon: 'flip-h', action: () => this.flip(true) },
        { label: 'Flip vertical', icon: 'flip-v', action: () => this.flip(false) },
        { label: 'Crop', icon: 'crop', action: () => this.startCrop() },
        { label: 'Resize…', icon: 'resize', action: () => this.resizeDialog() },
        { label: 'Adjust colors…', icon: 'sliders', action: () => this.adjustDialog() },
      ],
      tools: [
        { label: 'Copy image to clipboard', icon: 'copy', action: async () => { const b = await new Promise((r) => this.canvas.toBlob(r, 'image/png')); await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); toast('Copied', { type: 'ok' }); } },
        { label: 'Send to media dump', icon: 'image', action: () => this.toDump() },
        { label: 'Image settings…', icon: 'settings', action: () => this.openSettings() },
      ],
    };
  }

  saveFormats() {
    const fm = OUT_FORMATS.map((f) => ({ ext: f.ext, name: f.name }));
    if (['jpeg', 'jfif'].includes(this.tab.ext)) fm.unshift({ ext: this.tab.ext, name: 'JPEG image' });
    return fm;
  }

  exportTargets() {
    return [{
      label: 'PDF (.pdf)', icon: 'file-pdf',
      run: async () => {
        const L = await vendor.pdfLib();
        const d = await L.PDFDocument.create();
        const blob = await new Promise((r) => this.canvas.toBlob(r, 'image/png'));
        const img = await d.embedPng(new Uint8Array(await blob.arrayBuffer()));
        const w = this.canvas.width * 0.75, hh = this.canvas.height * 0.75;
        d.addPage([w, hh]).drawImage(img, { x: 0, y: 0, width: w, height: hh });
        await this.app.saveBytesAs(await d.save(), { defaultName: stripExt(this.tab.title) + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      },
    }];
  }

  async serialize(ext) {
    // untouched files are written back byte-for-byte (minus the hidden info, when that's asked for: no quality lost)
    if (!this.history.length && this.origBytes && ext === this.tab.ext) {
      if (!this.out.strip) return this.origBytes;
      const clean = stripMeta(this.origBytes);
      if (clean) return clean;
    }
    return encodeCanvas(this.canvas, outKind(ext) || 'png', this.out);
  }

  lossyFormat(ext) { return !!this.animated && (this.history.length > 0 || ext !== this.tab.ext); }
  lossyNote() { return 'Only the first frame of the animation is saved. To keep every frame, open it with Frames (Paint) and save as GIF.'; }

  afterSave(path, ext) {
    this.history = []; this.origBytes = null;
    if (outKind(ext)) { this.out.ext = ext; if (this.fmtSel) this.fmtSel.value = outKind(ext); }
  }

  /** The type it'll be saved as. Changing it from the file's own type makes the next Save ask where (a new name). */
  setOutExt(ext, { quiet = false } = {}) {
    if (outKind(this.out.ext) === ext) ext = this.out.ext;
    this.out.ext = ext;
    if (this.fmtSel) this.fmtSel.value = outKind(ext) || 'png';
    if (!quiet) warnFormat(ext, this.canvas);
    if (this.tab.ext !== ext) { this.app.setTabMeta(this.tab, { ext }); this.markDirty(); }
  }

  openSettings() {
    return imageSettings({
      app: this.app, tab: this.tab, out: this.out, meta: this.meta, fresh: false,
      setOutExt: (e, o) => this.setOutExt(e, o),
      outCanvas: () => this.canvas,
      frameCount: () => 1,
      size: () => ({ W: this.canvas.width, H: this.canvas.height }),
      resize: () => this.resizeDialog(),
      toDump: () => this.toDump(), copyImage: () => copyCanvas(this.canvas),
      serialize: (e) => this.serialize(e), markDirty: () => this.markDirty(),
    });
  }
  print() {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<img src="${this.canvas.toDataURL()}" style="max-width:100%">`);
    w.document.close();
    setTimeout(() => { w.print(); w.close(); }, 300);
  }
}

function countGifFrames(b) {
  let n = 0;
  for (let i = 0; i < b.length - 2 && n < 3; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 0x04) n++;
  return n;
}
