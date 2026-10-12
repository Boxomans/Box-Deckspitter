// Document mode: page tools (add / delete pages, pageless view) and "export as image".
// Mixed into DocEditor.prototype, so `this` is the editor.

import { h, clear, stripExt, joinPath, vendor } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { modal, toast, errorToast, confirmDialog } from '../../core/ui.js';
import { api } from '../../core/api.js';
import { pickFolder } from '../../core/files.js';
import { pageDims } from './styles.js';

const PX = 96; // CSS pixels per inch

export const PageTools = {
  // ------------------------------------------------------------------ geometry

  /** Top of an element in "content y" (the units of this.pageStarts: unscaled px from the top margin). */
  contentY(el) {
    const paperTop = this.paper.getBoundingClientRect().top;
    return (el.getBoundingClientRect().top - paperTop) / this.scale - this.pageSetup.margins.top * PX;
  },

  /** 0-based page index holding the caret, or the page in view when the caret isn't in the document. */
  activePageIndex() {
    if (this.pageSetup.pageless) return 0;
    const sel = getSelection();
    if (sel.rangeCount && this.body.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0).getClientRects()[0] || (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).getBoundingClientRect();
      const y = (r.top - this.paper.getBoundingClientRect().top) / this.scale - this.pageSetup.margins.top * PX;
      return this.pageAt(y);
    }
    return this.currentPage() - 1;
  },

  pageAt(y) {
    let p = 0;
    for (let i = 1; i < (this.pageStarts || [0]).length; i++) if (y >= this.pageStarts[i] - 0.5) p = i;
    return p;
  },

  /** Top-level blocks that start on page i. */
  blocksOnPage(i) {
    const start = this.pageStarts[i] ?? 0;
    const end = this.pageStarts[i + 1] ?? Infinity;
    return [...this.body.children].filter((el) => {
      const y = this.contentY(el);
      return y >= start - 0.5 && y < end - 0.5;
    });
  },

  // ------------------------------------------------------------------ add / delete

  /** Inserts a blank page after page `after` (0-based; defaults to the current page) and puts the caret on it. */
  addPage(after = this.activePageIndex()) {
    if (this.pageSetup.pageless) return toast('Pages are off — turn pageless off to work with pages.', { type: 'warn' });
    this.layoutPages();
    const nextStart = this.pageStarts[after + 1];
    const first = nextStart === undefined ? null : [...this.body.children].find((el) => this.contentY(el) >= nextStart - 0.5);
    const blank = h('p', {}, h('br'));
    const brk = () => h('div', { class: 'page-break', contenteditable: 'false' });
    this.edit(() => {
      if (!first) {
        // after the last page: make sure the document ends on a break, then add the new page
        const last = this.body.lastElementChild;
        if (!last?.classList.contains('page-break')) this.body.append(brk());
        this.body.append(blank);
      } else if (first.previousElementSibling?.classList.contains('page-break')) {
        first.before(blank, brk());
      } else {
        first.before(brk(), blank, brk());
      }
      this.placeCaret(blank);
    });
    this.layoutPages();
    requestAnimationFrame(() => this.scrollToEl(blank));
    toast(`Added page ${after + 2}`, { timeout: 1400 });
  },

  async deletePage(i = this.activePageIndex()) {
    if (this.pageSetup.pageless) return toast('Pages are off — turn pageless off to work with pages.', { type: 'warn' });
    this.layoutPages();
    if (this.pageCount <= 1 && !this.body.textContent.trim() && !this.body.querySelector('img,table,hr')) return toast('Nothing to delete.', { timeout: 1400 });
    const blocks = this.blocksOnPage(i);
    if (!blocks.length) return toast('That page is the overflow of a long paragraph or table from the page before — shorten it to remove the page.', { type: 'warn', timeout: 6000 });
    const hasContent = blocks.some((b) => !b.classList.contains('page-break') && (b.textContent.trim() || b.querySelector('img,table,hr') || /^(TABLE|HR|IMG)$/.test(b.tagName)));
    if (hasContent && !(await confirmDialog(`Delete page ${i + 1}?`, 'Everything on this page will be removed. You can undo with Ctrl+Z.', { okLabel: 'Delete page', danger: true }))) return;
    this.edit(() => {
      for (const b of blocks) b.remove();
      // don't leave a dangling break (an empty last page) or an empty document
      while (this.body.lastElementChild?.classList.contains('page-break')) this.body.lastElementChild.remove();
      while (this.body.firstElementChild?.classList.contains('page-break')) this.body.firstElementChild.remove();
      if (!this.body.firstElementChild) this.body.append(h('p', {}, h('br')));
    });
    this.layoutPages();
    const target = Math.min(i, this.pageCount - 1);
    const el = this.blocksOnPage(target)[0] || this.body.lastElementChild;
    if (el && !el.classList.contains('page-break')) this.placeCaret(el, target < i);
    toast(`Deleted page ${i + 1}`, { timeout: 1600 });
  },

  pagesMenu() {
    const cur = this.activePageIndex();
    const pageless = !!this.pageSetup.pageless;
    return [
      { label: `Add page after page ${cur + 1}`, icon: 'page-plus', shortcut: 'Ctrl+Alt+Enter', disabled: pageless, action: () => this.addPage(cur) },
      { label: 'Add page at the end', icon: 'page-plus', disabled: pageless, action: () => this.addPage(this.pageCount - 1) },
      { label: `Delete page ${cur + 1}`, icon: 'page-minus', shortcut: 'Ctrl+Alt+Backspace', disabled: pageless, action: () => this.deletePage(cur) },
      { label: 'Page break here', icon: 'page-break', shortcut: 'Ctrl+Enter', action: () => this.insertPageBreak() },
      { sep: true },
      { label: 'Pageless', icon: 'pageless', checked: pageless, action: () => this.togglePageless() },
      { label: 'Page setup…', icon: 'file', action: () => this.pageSetupDialog() },
    ];
  },

  /** Floating per-page controls in the right gutter, plus "add page" under the last page. */
  renderPageControls() {
    if (!this.pageCtl) {
      this.pageCtl = h('div', { class: 'doc-pagectl' });
      this.addPageBtn = h('button', { class: 'doc-addpage', onclick: () => this.addPage(this.pageCount - 1) }, icon('plus', 'sm'), 'add page');
      this.canvas.append(this.pageCtl, this.addPageBtn);
    }
    clear(this.pageCtl);
    const pageless = !!this.pageSetup.pageless;
    this.addPageBtn.hidden = pageless;
    if (pageless) return;
    this.pageStarts.forEach((y, i) => {
      const at = i * (this.pagePitch || 0) * this.scale;
      this.pageCtl.append(h('div', { class: 'doc-pagectl-item', style: { top: at + 'px' } },
        h('span', { class: 'mono' }, String(i + 1)),
        h('button', { 'data-tip': `Add a page after page ${i + 1}`, onclick: () => this.addPage(i) }, icon('page-plus', 'sm')),
        h('button', { 'data-tip': `Delete page ${i + 1}`, onclick: () => this.deletePage(i) }, icon('page-minus', 'sm'))));
    });
  },

  // ------------------------------------------------------------------ pageless

  togglePageless(on = !this.pageSetup.pageless) {
    this.pageSetup.pageless = on;
    this.applyPageSetup();
    this.syncPagelessButton?.();
    this.markDirty();
    toast(on ? 'Pageless — one continuous sheet. PDF and print still use pages.' : 'Pages back on', { timeout: 2200 });
  },

  /** Width (CSS px, unscaled) of the pageless sheet: fills the window, within readable limits. */
  pagelessWidth() {
    const avail = (this.scroller.clientWidth - 56) / this.scale;
    return Math.round(Math.max(560, Math.min(1180, avail)));
  },

  // ------------------------------------------------------------------ export as image

  async exportImageDialog() {
    const pageless = !!this.pageSetup.pageless;
    this.layoutPages();
    const cur = this.activePageIndex();
    const pick = (name, options, value) => {
      const seg = h('div', { class: 'seg' });
      seg.value = value;
      for (const [v, label] of options) {
        const b = h('button', { class: v === value ? 'on' : '' }, label);
        b.addEventListener('click', () => { seg.value = v; [...seg.children].forEach((x) => x.classList.toggle('on', x === b)); seg.dispatchEvent(new Event('change')); });
        seg.append(b);
      }
      return seg;
    };
    const what = pick('what', pageless
      ? [['long', 'Whole document'], ['pages', 'Split into pages']]
      : [['current', `Page ${cur + 1}`], ['pages', `All ${this.pageCount} pages`], ['long', 'One long image']], pageless ? 'long' : this.pageCount > 1 ? 'current' : 'current');
    const fmt = pick('fmt', [['png', 'PNG'], ['jpg', 'JPG'], ['webp', 'WebP']], this.app.settings.docImgFmt || 'png');
    const res = pick('res', [['1', '1× · 96 dpi'], ['2', '2× · 192 dpi'], ['3', '3× · 288 dpi']], String(this.app.settings.docImgScale || 2));
    const dest = pick('dest', [['save', 'Save file'], ['copy', 'Copy'], ['dump', 'Media dump']], 'save');
    const note = h('div', { class: 'faint', style: { fontSize: '11.5px' } });
    const sync = () => {
      const multi = what.value === 'pages';
      note.textContent = multi ? 'Each page is saved as its own file in a folder you choose.' : dest.value === 'copy' ? 'Copied as PNG — paste it into Discord, a chat or another app.' : '';
      [...dest.children][1].disabled = multi;
      if (multi && dest.value === 'copy') [...dest.children][0].click();
    };
    for (const s of [what, dest]) s.addEventListener('change', sync);
    sync();
    const ok = await modal({
      title: 'Export as image',
      body: h('div', { class: 'form-grid' },
        h('label', {}, 'What'), what,
        h('label', {}, 'Format'), fmt,
        h('label', {}, 'Sharpness'), res,
        h('label', {}, 'Send to'), dest,
        h('span'), note),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Export', value: 'ok', primary: true }],
    });
    if (ok !== 'ok') return;
    this.app.saveSettings({ docImgFmt: fmt.value, docImgScale: Number(res.value) });
    await this.exportImage({ what: what.value, page: cur, format: fmt.value, scale: Number(res.value), dest: dest.value });
  },

  /** Renders the document through the PDF pipeline, so images match print exactly. */
  async renderPages({ what, page, scale, long }) {
    const t = toast('Rendering…', { timeout: 0 });
    try {
      let html = this.standaloneHtml({ forPrint: true });
      if (long || this.pageSetup.pageless) {
        // One tall sheet as wide as the page (or the pageless sheet), so nothing gets split.
        const m = this.pageSetup.margins;
        const wIn = this.pageSetup.pageless ? this.pagelessWidth() / PX : pageDims(this.pageSetup).w;
        const pad = this.pageSetup.pageless ? 0.6 : null;
        const hIn = Math.min(200, this.body.offsetHeight / PX + (pad ?? m.top + m.bottom) + 0.5);
        const css = `@page { size: ${wIn}in ${hIn}in; margin: ${pad ?? m.top}in ${pad ?? m.right}in ${pad ?? m.bottom}in ${pad ?? m.left}in; }`
          + (long ? ' .page-break { break-after: auto !important; page-break-after: auto !important; height: 0; }' : '');
        html = html.replace('</style>', css + '</style>');
      }
      const pdfBytes = await api.printPdf(html);
      const pdfjs = await vendor.pdfjs();
      const doc = await pdfjs.getDocument({ data: pdfBytes, isEvalSupported: false }).promise;
      const nums = what === 'current' && !long ? [Math.min(page + 1, doc.numPages)] : Array.from({ length: doc.numPages }, (_, i) => i + 1);
      const canvases = [];
      for (const n of nums) {
        const pg = await doc.getPage(n);
        const vp = pg.getViewport({ scale: (PX * scale) / 72 });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        await pg.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
        canvases.push(c);
      }
      await doc.destroy();
      return canvases;
    } finally { t(); }
  },

  async exportImage({ what, page, format, scale, dest }) {
    try {
      const long = what === 'long';
      let canvases = await this.renderPages({ what, page, scale, long });
      if (long && canvases.length > 1) canvases = [stitch(canvases)];
      const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[format];
      const base = stripExt(this.tab.title) || 'document';
      if (dest === 'copy') {
        const blob = await toBlob(canvases[0], 'image/png');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return toast('Image copied to the clipboard', { type: 'ok' });
      }
      const files = await Promise.all(canvases.map(async (c, i) => ({
        name: canvases.length === 1 ? `${base}${what === 'current' ? ` - page ${page + 1}` : ''}.${format}` : `${base} - page ${String(i + 1).padStart(String(canvases.length).length, '0')}.${format}`,
        bytes: new Uint8Array(await (await toBlob(c, mime, 0.92)).arrayBuffer()),
      })));
      if (dest === 'dump') {
        for (const f of files) await api.dumpAdd(f.name, f.bytes);
        this.dump.refresh?.();
        this.dump.toggle(true);
        return toast(files.length === 1 ? 'Added to the media dump' : `Added ${files.length} images to the media dump`, { type: 'ok' });
      }
      if (files.length === 1) {
        return this.app.saveBytesAs(files[0].bytes, { defaultName: files[0].name, filters: [{ name: `${format.toUpperCase()} image`, extensions: [format] }], title: 'Export as image', openAfter: true });
      }
      const dir = await pickFolder({ title: 'Save the page images where?', initialDir: this.tab.path ? this.tab.path.replace(/[\\/][^\\/]*$/, '') : undefined });
      if (!dir) return;
      for (const f of files) await api.write(joinPath(dir, f.name), f.bytes);
      toast(`Saved ${files.length} images`, { type: 'ok', action: { label: 'Show', fn: () => api.reveal(joinPath(dir, files[0].name)) } });
    } catch (e) { errorToast(e, 'Image export failed'); }
  },
};

function toBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The image is too large — try a lower sharpness.'))), mime, quality));
}

/** Stacks page canvases into one tall image (scaled down if it would exceed browser canvas limits). */
function stitch(canvases) {
  const w = Math.max(...canvases.map((c) => c.width));
  const total = canvases.reduce((a, c) => a + c.height, 0);
  const k = Math.min(1, 32000 / total, Math.sqrt(250e6 / (w * total)));
  const out = document.createElement('canvas');
  out.width = Math.round(w * k);
  out.height = Math.round(total * k);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  let y = 0;
  for (const c of canvases) { ctx.drawImage(c, 0, Math.round(y * k), Math.round(c.width * k), Math.round(c.height * k)); y += c.height; }
  if (k < 1) toast('That was very long, so the image was scaled down to fit.', { type: 'warn' });
  return out;
}
