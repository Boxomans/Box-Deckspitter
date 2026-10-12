// Document mode — a Word / Google Docs style rich text editor with paper layout.

import { BaseEditor } from './base.js';
import { h, $$, clear, debounce, clamp, decodeText, vendor, escapeHtml, countWords, rgbToHex, blobToDataURL, stripExt, basename, toBytes } from '../core/dom.js';
import { icon } from '../core/icons.js';
import {
  tbButton, tbSep, tbSelect, showMenu, contextMenu, modal, promptDialog, toast, errorToast, popover, closePopover,
  colorPopover, FindBar, buildRegex,
} from '../core/ui.js';
import { api } from '../core/api.js';
import { pickOpen } from '../core/files.js';
import { PAGE_SIZES, FONTS, FONT_SIZES, LH_FACTOR, pageDims, fontStack, docContentCss, printCss } from './doc/styles.js';
import { sanitizeHtml, textToHtml, htmlToMarkdown, BLOCK_RE } from './doc/html-tools.js';
import { importDocx } from './doc/docx-import.js';
import { DumpDock, DUMP_MIME } from './doc/image-dump.js';
import { PageTools } from './doc/pages.js';

const SHEET_GAP = 28; // px between pages
const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div:not(.page-break):not(.toc),td,th';
const STYLE_OPTIONS = [
  { value: 'p', label: 'Normal text' }, { value: 'title', label: 'Title' }, { value: 'subtitle', label: 'Subtitle' },
  { value: 'h1', label: 'Heading 1' }, { value: 'h2', label: 'Heading 2' }, { value: 'h3', label: 'Heading 3' },
  { value: 'h4', label: 'Heading 4' }, { value: 'quote', label: 'Quote' }, { value: 'code', label: 'Code block' },
];
const SPECIAL_CHARS = '© ® ™ § ¶ † ‡ • … – — ‘ ’ “ ” « » ° ± × ÷ ≈ ≠ ≤ ≥ ∞ √ ∑ ∏ ∂ ∫ µ π Ω α β γ δ λ σ θ φ → ← ↑ ↓ ↔ ⇒ ⇔ ½ ⅓ ¼ ¾ ² ³ € £ ¥ ¢ ₿ ✓ ✗ ★ ☆ ♥ ♦ ♣ ♠ ☐ ☑ ☎ ✉ ☀ ☾ ♪ ⌘ ⌥ ⏎'.split(' ');

let contentCssInjected = false;

export class DocEditor extends BaseEditor {
  static mode = 'doc';

  async load(bytes, opts = {}) {
    const s = this.app.settings;
    this.pageSetup = { size: 'letter', orientation: 'portrait', margins: { top: 1, right: 1, bottom: 1, left: 1 } };
    this.defaults = { font: s.docFont || 'Calibri', size: s.docSize || 11, lineHeight: LH_FACTOR, spaceAfter: 6 };
    this.scale = 1;
    this.undoStack = [];
    this.redoStack = [];
    this.imgIds = new Map();
    this.imgById = new Map();
    this.findRanges = [];
    this.findIndex = -1;
    this.pageCount = 1;
    this.selectedImg = null;

    if (!contentCssInjected) {
      document.head.append(h('style', { id: 'bds-doc-content' }, docContentCss('.doc-body')));
      contentCssInjected = true;
    }
    this.buildDom();

    let html = '<p><br></p>';
    const ext = this.tab.ext;
    if (bytes && bytes.length) {
      if (['docx', 'docm', 'dotx'].includes(ext)) {
        const r = await importDocx(bytes);
        html = r.html;
        Object.assign(this.pageSetup, r.page);
        Object.assign(this.defaults, r.defaults);
        if (r.warnings?.size) setTimeout(() => toast([...r.warnings].join(' '), { type: 'warn', timeout: 7000 }), 400);
      } else if (ext === 'odt') {
        const { importOdt } = await import('./doc/odt-import.js');
        const r = await importOdt(bytes);
        html = r.html;
        Object.assign(this.pageSetup, r.page || {});
      } else if (ext === 'rtf' || ext === 'doc') {
        const { importRtf } = await import('./doc/rtf.js');
        html = sanitizeHtml(importRtf(decodeText(bytes).text), { keepWhitespace: true });
      } else if (['html', 'htm', 'xhtml', 'mht'].includes(ext)) {
        html = sanitizeHtml(decodeText(bytes).text);
      } else if (['md', 'markdown'].includes(ext)) {
        html = sanitizeHtml((await vendor.marked()).parse(decodeText(bytes).text, { gfm: true }));
      } else {
        html = textToHtml(decodeText(bytes).text);
      }
    }
    this.body.innerHTML = html;
    this.applyPageSetup();
    this.applyDefaults();
    this.onThemeChange();
    this.contentChanged({ silent: true });
    if (opts.draft) this.restoreDraft(opts.draft);
    // Start typing straight away in a new document.
    if (!bytes?.length && !opts.draft) {
      setTimeout(() => {
        if (!this.pane.isConnected || this.pane.offsetParent === null) return;
        this.body.focus({ preventScroll: true });
        this.placeCaret(this.body.firstElementChild || this.body);
      }, 60);
    }
  }

  // =================================================================== DOM

  buildDom() {
    const spell = this.app.settings.spellcheck !== false;
    this.body = h('div', { class: 'doc-body', contenteditable: 'true', spellcheck: spell ? 'true' : 'false', role: 'textbox', 'aria-multiline': 'true' });
    this.markers = h('div', { class: 'doc-markers', 'aria-hidden': 'true' });
    this.imgBox = h('div', { class: 'doc-imgbox', hidden: true }, h('div', { class: 'doc-imgbox-handle' }));
    this.paper = h('div', { class: 'doc-paper' }, this.markers, this.body);
    this.canvas = h('div', { class: 'doc-canvas' }, this.paper, this.imgBox);
    this.scroller = h('div', { class: 'doc-scroller' }, this.canvas);
    this.outlineEl = h('div', { class: 'doc-outline', hidden: this.app.settings.docOutline !== true });
    this.main = h('div', { class: 'doc-main' }, this.outlineEl, this.scroller);
    this.dumps = new DumpDock({
      app: this.app,
      onInsert: (url) => this.insertImage(url),
      onSaveDoc: async () => ({ name: (stripExt(this.tab.title) || 'document') + '.pdf', bytes: await toBytes(await api.printPdf(this.standaloneHtml({ forPrint: true }))) }),
    });
    this.dump = this.dumps.image;
    this.root = h('div', { class: 'doc-root' }, this.main, this.dumps.el);
    this.pane.append(this.root);

    document.execCommand('defaultParagraphSeparator', false, 'p');
    document.execCommand('styleWithCSS', false, true);

    this.layoutSoon = debounce(() => this.layoutPages(), 120);
    this.outlineSoon = debounce(() => this.renderOutline(), 400);
    this.statusSoon = debounce(() => this.refreshStatus(), 200);
    this.syncSoon = debounce(() => this.syncToolbar(), 60);
    this.findSoon = debounce(() => this.findBar?.run(), 300);

    this.body.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    this.body.addEventListener('input', () => this.contentChanged());
    this.body.addEventListener('keydown', (e) => this.onKey(e));
    this.body.addEventListener('paste', (e) => this.onPaste(e));
    this.body.addEventListener('drop', (e) => this.onDrop(e));
    this.body.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes(DUMP_MIME) || e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    this.body.addEventListener('click', (e) => this.onClick(e));
    this.body.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.body.addEventListener('focus', () => this.body.classList.add('focused'));
    // Clicking anywhere on the sheet (margins, or the empty space below the text) puts the caret on the nearest line.
    this.paper.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const brk = e.target.closest?.('.page-break');
      if (brk && this.body.contains(brk)) {
        e.preventDefault();
        this.body.focus({ preventScroll: true });
        let next = brk.nextElementSibling;
        if (!next || next.classList.contains('page-break')) { next = h('p', {}, h('br')); brk.after(next); }
        this.placeCaret(next);
        return;
      }
      if (this.body.contains(e.target)) return;
      e.preventDefault();
      this.body.focus({ preventScroll: true });
      const r = this.body.getBoundingClientRect();
      if (e.clientY > r.bottom) {
        const last = this.body.lastElementChild;
        if (last && !last.classList.contains('page-break')) this.placeCaret(last, true);
        else { const p = h('p', {}, h('br')); this.body.append(p); this.placeCaret(p); }
        return;
      }
      const x = clamp(e.clientX, r.left + 2, r.right - 2);
      const y = clamp(e.clientY, r.top + 2, r.bottom - 2);
      const pos = document.caretPositionFromPoint?.(x, y);
      const range = pos ? document.createRange() : document.caretRangeFromPoint?.(x, y);
      if (pos) range.setStart(pos.offsetNode, pos.offset);
      if (range && this.body.contains(range.startContainer) && !(range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement).closest('.page-break')) {
        range.collapse(true);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } else this.placeCaret(this.body.firstElementChild || this.body);
    });
    this.selHandler = () => this.onSelectionChange();
    document.addEventListener('selectionchange', this.selHandler);
    this.scroller.addEventListener('scroll', () => { this.statusSoon(); this.positionImgBox(); });
    this.ro = new ResizeObserver(() => { this.fitCanvas(); this.layoutSoon(); });
    this.ro.observe(this.paper);
    this.scrollRo = new ResizeObserver(() => { if (this.pageSetup?.pageless) this.applyPageSetup(); });
    this.scrollRo.observe(this.scroller);
    this.wireImageResize();
  }

  // =================================================================== page & zoom

  applyPageSetup() {
    const d = pageDims(this.pageSetup);
    const m = this.pageSetup.margins;
    const pageless = !!this.pageSetup.pageless;
    this.paper.classList.toggle('pageless', pageless);
    this.canvas.classList.toggle('pageless', pageless);
    Object.assign(this.paper.style, pageless ? {
      width: this.pagelessWidth() + 'px',
      padding: '0.6in 0.75in',
      minHeight: Math.max(300, (this.scroller.clientHeight - 60) / this.scale) + 'px',
    } : {
      width: d.w + 'in',
      padding: `${m.top}in ${m.right}in ${m.bottom}in ${m.left}in`,
      minHeight: d.h + 'in',
    });
    this.fitCanvas();
    this.layoutSoon();
  }

  applyDefaults() {
    const s = this.body.style;
    s.setProperty('--doc-font', fontStack(this.defaults.font));
    s.setProperty('--doc-size', this.defaults.size + 'pt');
    s.setProperty('--doc-lh', String(this.defaults.lineHeight));
    s.setProperty('--doc-after', this.defaults.spaceAfter + 'pt');
  }

  fitCanvas() {
    const w = this.paper.offsetWidth;
    const hgt = this.paper.offsetHeight;
    this.paper.style.transform = `scale(${this.scale})`;
    this.canvas.style.width = w * this.scale + 'px';
    this.canvas.style.height = hgt * this.scale + 'px';
    if (this.pageCtl && this.lastCtlScale !== this.scale) { this.lastCtlScale = this.scale; this.renderPageControls(); }
  }

  zoom(delta) {
    if (delta === 0) this.scale = 1;
    else if (delta === 'fit') {
      const avail = this.scroller.clientWidth - 48;
      this.scale = clamp(avail / this.paper.offsetWidth, 0.3, 3);
    } else {
      const i = ZOOMS.findIndex((z) => z >= this.scale - 0.001);
      const next = delta > 0 ? ZOOMS[Math.min(ZOOMS.length - 1, (ZOOMS[i] > this.scale + 0.001 ? i : i + 1))] : ZOOMS[Math.max(0, i - 1)];
      this.scale = next ?? this.scale;
    }
    this.fitCanvas();
    this.positionImgBox();
    if (this.zoomSel) this.zoomSel.value = String(this.scale);
    this.refreshStatus();
  }

  /**
   * Lays the document out as separate sheets of paper. The text stays one editable flow; a generated
   * stylesheet (never the document itself) pushes a block that would cross a page edge to the top of the
   * next sheet, and stretches each page break so what follows starts on a new sheet.
   */
  layoutPages() {
    const pageless = !!this.pageSetup.pageless;
    this.paper.classList.toggle('paged', !pageless);
    this.canvas.classList.toggle('paged', !pageless);
    if (!this.pageSheet) {
      this.pageSheet = h('style', { class: 'bds-page-flow' });
      document.head.append(this.pageSheet);
      this.flowId = 'flow-' + Math.random().toString(36).slice(2, 8);
      this.body.classList.add(this.flowId);
    }
    this.pageSheet.textContent = '';
    if (pageless) {
      this.pageCount = 1;
      this.pageStarts = [0];
      clear(this.markers);
      this.paper.style.minHeight = Math.max(300, (this.scroller.clientHeight - 60) / this.scale) + 'px';
      this.fitCanvas();
      this.renderPageControls();
      this.statusSoon();
      return;
    }
    const d = pageDims(this.pageSetup);
    const m = this.pageSetup.margins;
    const pageH = d.h * 96;
    const mt = m.top * 96;
    const contentH = Math.max(96, pageH - mt - m.bottom * 96);
    const pitch = pageH + SHEET_GAP;
    const paperTop = this.paper.getBoundingClientRect().top;
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: (r.top - paperTop) / this.scale, bottom: (r.bottom - paperTop) / this.scale }; };
    const sel = `.doc-body.${this.flowId}`;

    // Measure everything once in the natural flow, then work out the pushes with a running offset.
    const units = [];
    const kids = [...this.body.children];
    kids.forEach((el, i) => {
      const css = `${sel} > :nth-child(${i + 1})`;
      if ((el.tagName === 'UL' || el.tagName === 'OL') && el.children.length > 1) {
        [...el.children].forEach((li, j) => {
          if (li.tagName === 'LI') units.push({ el: li, css: `${css} > :nth-child(${j + 1})`, kind: 'li', ...box(li), pad: parseFloat(getComputedStyle(li).paddingTop) || 0, prevBottom: j ? null : undefined });
        });
        return;
      }
      const b = box(el);
      // A block taller than a page (several pictures in one paragraph, a big table…) can't move as a whole,
      // so its pictures move one by one instead.
      const imgs = b.bottom - b.top > contentH ? [...el.querySelectorAll('img')] : [];
      if (imgs.length) {
        for (const img of imgs) {
          let path = '';
          for (let n = img; n && n !== el; n = n.parentElement) path = ` > :nth-child(${[...n.parentElement.children].indexOf(n) + 1})` + path;
          units.push({ el: img, css: css + path, kind: 'img', ...box(img), margin: parseFloat(getComputedStyle(img).marginTop) || 0 });
        }
        return;
      }
      units.push({ el, css, kind: el.classList.contains('page-break') ? 'break' : 'block', ...b, index: i });
    });
    const rules = [];
    let offset = 0;
    let lastBottom = mt;
    let pages = 1;
    let lastImgTop = null;
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      // pictures sharing a line move together: only the first one on the line gets pushed
      if (u.kind === 'img' && lastImgTop !== null && Math.abs(u.top - lastImgTop) < 2) continue;
      if (u.kind === 'img') lastImgTop = u.top;
      const top = u.top + offset;
      const bottom = u.bottom + offset;
      const p = Math.max(0, Math.floor((top + 0.5) / pitch));
      const contentTop = p * pitch + mt;
      const contentBottom = contentTop + contentH;
      if (u.kind === 'break') {
        const next = units[k + 1];
        const nextMargin = next && next.kind !== 'li' ? parseFloat(getComputedStyle(next.el).marginTop) || 0 : 0;
        const target = (p + 1) * pitch + mt;
        const height = Math.max(10, target - top - nextMargin);
        rules.push(`${u.css} { height: ${height.toFixed(2)}px !important; margin: 0 !important; }`);
        offset += height - (u.bottom - u.top) - (next ? (next.top - u.bottom) - nextMargin : 0);
        lastBottom = target;
        pages = Math.max(pages, p + 2);
        continue;
      }
      const tall = u.bottom - u.top;
      if ((bottom > contentBottom + 0.5 || top > contentBottom) && tall <= contentH && top > mt + 1) {
        const shift = (p + 1) * pitch + mt - top;
        if (u.kind === 'li') {
          rules.push(`${u.css} { padding-top: ${(u.pad + shift).toFixed(2)}px !important; }`);
        } else if (u.kind === 'img') {
          rules.push(`${u.css} { margin-top: ${(u.margin + shift).toFixed(2)}px !important; }`);
        } else {
          const prev = units[k - 1];
          const gap = prev ? u.top - prev.bottom : 0; // the collapsed margin above, as laid out now
          rules.push(`${u.css} { margin-top: ${(Math.max(0, gap) + shift).toFixed(2)}px !important; }`);
        }
        offset += shift;
        lastBottom = bottom + shift;
        pages = Math.max(pages, p + 2);
      } else {
        lastBottom = Math.max(lastBottom, bottom);
        pages = Math.max(pages, Math.floor((Math.max(bottom, top + 1) - 0.5) / pitch) + 1);
      }
    }
    this.pageSheet.textContent = rules.join('\n');
    void lastBottom;

    this.pageCount = pages;
    this.pagePitch = pitch;
    this.pageStarts = Array.from({ length: pages }, (_, i) => i * pitch);
    clear(this.markers);
    for (let i = 0; i < pages; i++) {
      this.markers.append(h('div', { class: 'doc-sheet', style: { top: i * pitch + 'px', height: pageH + 'px' } },
        h('span', { class: 'doc-sheet-num' }, String(i + 1))));
    }
    this.paper.style.minHeight = pages * pitch - SHEET_GAP + 'px';
    this.fitCanvas();
    this.renderPageControls();
    this.statusSoon();
  }

  currentPage() {
    if (!this.pageStarts) return 1;
    const m = this.pageSetup.margins;
    const y = (this.scroller.scrollTop + this.scroller.clientHeight / 3 - 28) / this.scale - m.top * 96;
    let p = 1;
    for (let i = 1; i < this.pageStarts.length; i++) if (y >= this.pageStarts[i]) p = i + 1;
    return Math.min(p, this.pageCount);
  }

  // =================================================================== history

  compact(html) {
    return html.replace(/src="(data:[^"]{400,})"/g, (m, url) => {
      let id = this.imgIds.get(url);
      if (!id) { id = 'i' + (this.imgIds.size + 1); this.imgIds.set(url, id); this.imgById.set(id, url); }
      return `src="bdsimg:${id}"`;
    });
  }

  expand(html) { return html.replace(/src="bdsimg:(i\d+)"/g, (m, id) => `src="${this.imgById.get(id) || ''}"`); }

  snapshot() { return { html: this.compact(this.body.innerHTML), sel: this.getSelOffsets() }; }

  checkpoint() {
    const s = this.snapshot();
    const top = this.undoStack[this.undoStack.length - 1];
    if (!top || top.html !== s.html) {
      this.undoStack.push(s);
      if (this.undoStack.length > 150) this.undoStack.shift();
    }
    this.redoStack = [];
  }

  endBurst() { this.burst = null; clearTimeout(this.burstTimer); }

  undo() {
    this.endBurst();
    const cur = this.snapshot();
    while (this.undoStack.length) {
      const prev = this.undoStack.pop();
      if (prev.html !== cur.html) { this.redoStack.push(cur); this.restoreSnapshot(prev); return; }
    }
    toast('Nothing to undo', { timeout: 1200 });
  }

  redo() {
    this.endBurst();
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.restoreSnapshot(next);
  }

  restoreSnapshot(s) {
    this.hideImgBox();
    this.body.innerHTML = this.expand(s.html);
    this.body.focus({ preventScroll: true });
    if (s.sel) this.setSelOffsets(s.sel);
    this.contentChanged({ history: true });
  }

  getSelOffsets() {
    const sel = getSelection();
    if (!sel.rangeCount || !this.body.contains(sel.anchorNode)) return null;
    const r = sel.getRangeAt(0);
    const off = (node, o) => { const x = document.createRange(); x.setStart(this.body, 0); try { x.setEnd(node, o); } catch { return 0; } return x.toString().length; };
    return { start: off(r.startContainer, r.startOffset), end: off(r.endContainer, r.endOffset) };
  }

  setSelOffsets({ start, end }) {
    const find = (target) => {
      const w = document.createTreeWalker(this.body, NodeFilter.SHOW_TEXT);
      let acc = 0;
      let last = null;
      while (w.nextNode()) {
        const n = w.currentNode;
        if (acc + n.length >= target) return [n, target - acc];
        acc += n.length;
        last = n;
      }
      return last ? [last, last.length] : [this.body, 0];
    };
    try {
      const [sn, so] = find(start);
      const [en, eo] = find(end);
      const r = document.createRange();
      r.setStart(sn, so);
      r.setEnd(en, eo);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch { /* ignore */ }
  }

  onBeforeInput(e) {
    if (e.inputType === 'historyUndo') { e.preventDefault(); this.undo(); return; }
    if (e.inputType === 'historyRedo') { e.preventDefault(); this.redo(); return; }
    const kind = e.inputType.startsWith('delete') ? 'del' : e.inputType === 'insertText' ? 'text' : e.inputType;
    if (this.burst !== kind || kind === 'insertParagraph' || kind.startsWith('format') || kind.startsWith('insertFrom')) this.checkpoint();
    this.burst = kind;
    clearTimeout(this.burstTimer);
    this.burstTimer = setTimeout(() => { this.burst = null; }, 900);
    if (e.inputType === 'insertText' && e.data === ' ') this.burst = null; // word boundaries become undo steps
  }

  /** Run a mutation as one undo step. */
  edit(fn) {
    this.restoreSel();
    this.endBurst();
    this.checkpoint();
    const r = fn();
    this.contentChanged();
    return r;
  }

  exec(cmd, value = null) {
    return this.edit(() => {
      const r = document.execCommand(cmd, false, value);
      if (/List|insertHTML|indent|outdent|formatBlock/i.test(cmd)) this.normalizeStructure();
      return r;
    });
  }

  /** Chrome sometimes nests block elements inside <p> (e.g. lists); hoist them out, keeping the caret. */
  normalizeStructure() {
    const sel = getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    for (const bad of this.body.querySelectorAll('p > ul, p > ol, p > table, p > div, p > blockquote, p > pre, p > h1, p > h2, p > h3, p > h4, p > h5, p > h6, h1 > ul, h2 > ul, h3 > ul, h1 > ol, h2 > ol, h3 > ol')) {
      const p = bad.parentElement;
      if (!p || !this.body.contains(p)) continue;
      const others = [...p.childNodes].filter((n) => n !== bad && !(n.nodeType === 3 && !n.data.trim()) && !(n.nodeType === 1 && n.tagName === 'BR'));
      if (!others.length) { p.replaceWith(bad); continue; }
      // split the paragraph around the block
      const after = document.createElement(p.tagName);
      for (const a of p.getAttributeNames()) after.setAttribute(a, p.getAttribute(a));
      while (bad.nextSibling) after.append(bad.nextSibling);
      p.after(bad);
      if (after.textContent.trim() || after.querySelector('img')) bad.after(after);
      if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
    }
    if (range && this.body.contains(range.startContainer)) { sel.removeAllRanges(); sel.addRange(range); }
  }

  /** Insert a block element at the caret's top-level block (replacing an empty paragraph). */
  insertBlockNode(node) {
    const sel = getSelection();
    const block = sel.rangeCount ? this.topLevelBlock(sel.anchorNode) : null;
    if (block && block.tagName === 'P' && !block.textContent.trim() && !block.querySelector('img')) block.replaceWith(node);
    else if (block) block.after(node);
    else this.body.append(node);
    if (!node.nextElementSibling) node.after(h('p', {}, h('br')));
    return node;
  }

  contentChanged({ silent = false, history = false } = {}) {
    if (!silent) this.markDirty();
    this.layoutSoon();
    this.outlineSoon();
    this.statusSoon();
    if (this.findBar?.isOpen && this.findRanges.length) this.findSoon();
    if (this.selectedImg && !this.body.contains(this.selectedImg)) this.hideImgBox();
    else this.positionImgBox();
  }

  // =================================================================== selection helpers

  onSelectionChange() {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (this.body.contains(r.commonAncestorContainer)) {
      this.savedRange = r.cloneRange();
      this.syncSoon();
      this.statusSoon();
    }
  }

  restoreSel() {
    if (document.activeElement === this.body && getSelection().rangeCount && this.body.contains(getSelection().anchorNode)) return;
    this.body.focus({ preventScroll: true });
    if (this.savedRange && this.body.contains(this.savedRange.startContainer)) {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(this.savedRange);
    }
  }

  anchorElement() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    let n = sel.anchorNode;
    if (!n || !this.body.contains(n)) return null;
    return n.nodeType === 3 ? n.parentElement : n;
  }

  closestBlock(node) {
    let el = node?.nodeType === 3 ? node.parentElement : node;
    while (el && el !== this.body) {
      if (el.nodeType === 1 && BLOCK_RE.test(el.tagName) && !['UL', 'OL', 'TABLE', 'TBODY', 'TR', 'THEAD'].includes(el.tagName)) return el;
      el = el.parentElement;
    }
    return null;
  }

  selectedBlocks() {
    const sel = getSelection();
    if (!sel.rangeCount) return [];
    const r = sel.getRangeAt(0);
    const out = [];
    for (const b of this.body.querySelectorAll(BLOCK_SEL)) {
      if (b.querySelector(BLOCK_SEL)) continue; // leaf blocks only
      if (r.intersectsNode(b)) out.push(b);
    }
    if (!out.length) {
      const b = this.closestBlock(r.startContainer);
      if (b) out.push(b);
    }
    return out;
  }

  topLevelBlock(node) {
    let el = node?.nodeType === 3 ? node.parentElement : node;
    while (el && el.parentElement !== this.body) el = el.parentElement;
    return el && el.parentElement === this.body ? el : null;
  }

  placeCaret(el, atEnd = false) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(!atEnd);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // =================================================================== toolbar

  buildToolbar() {
    const btn = (ic, tip, fn, key) => {
      const b = tbButton(ic, tip, fn, { key });
      return b;
    };
    this.styleSel = tbSelect(STYLE_OPTIONS, (v) => this.applyBlockStyle(v), { tip: 'Paragraph style', width: '128px', value: 'p' });
    this.fontSel = tbSelect(FONTS.map((f) => ({ value: f, label: f, style: `font-family:${fontStack(f)}` })), (v) => this.applyFont(v), { tip: 'Font', width: '150px', value: this.defaults.font });
    if (![...this.fontSel.options].some((o) => o.value === this.defaults.font)) this.fontSel.prepend(h('option', { value: this.defaults.font }, this.defaults.font)), (this.fontSel.value = this.defaults.font);
    this.sizeInput = h('input', { type: 'text', class: 'tb-num', value: String(this.defaults.size), 'data-tip': 'Font size', list: 'bds-font-sizes' });
    const dl = h('datalist', { id: 'bds-font-sizes' }, FONT_SIZES.map((s) => h('option', { value: String(s) })));
    this.sizeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const v = parseFloat(this.sizeInput.value); if (v > 0 && v < 400) this.applyFontSize(v); }
      if (e.key === 'Escape') { this.restoreSel(); }
    });
    this.sizeInput.addEventListener('change', () => { const v = parseFloat(this.sizeInput.value); if (v > 0 && v < 400) this.applyFontSize(v); });
    this.zoomSel = tbSelect(ZOOMS.map((z) => ({ value: String(z), label: Math.round(z * 100) + '%' })), (v) => { this.scale = Number(v); this.fitCanvas(); this.refreshStatus(); }, { tip: 'Zoom', width: '74px', value: '1' });

    this.btn = {
      bold: btn('bold', 'Bold', () => this.exec('bold'), 'Ctrl+B'),
      italic: btn('italic', 'Italic', () => this.exec('italic'), 'Ctrl+I'),
      underline: btn('underline', 'Underline', () => this.exec('underline'), 'Ctrl+U'),
      strike: btn('strike', 'Strikethrough', () => this.exec('strikeThrough'), 'Alt+Shift+5'),
      left: btn('align-left', 'Align left', () => this.exec('justifyLeft'), 'Ctrl+Shift+L'),
      center: btn('align-center', 'Center', () => this.exec('justifyCenter'), 'Ctrl+Shift+E'),
      right: btn('align-right', 'Align right', () => this.exec('justifyRight'), 'Ctrl+Shift+R'),
      justify: btn('align-justify', 'Justify', () => this.exec('justifyFull'), 'Ctrl+Shift+J'),
      ul: btn('list-bullet', 'Bulleted list', () => this.toggleList('ul'), 'Ctrl+Shift+8'),
      ol: btn('list-ordered', 'Numbered list', () => this.toggleList('ol'), 'Ctrl+Shift+7'),
      check: btn('list-check', 'Checklist', () => this.toggleList('check'), 'Ctrl+Shift+9'),
    };
    const colorBtn = h('button', { class: 'icon-btn color-btn', 'data-tip': 'Text color' }, icon('text-color'), h('span', { class: 'swatch-bar', style: { color: '#e06666' } }));
    colorBtn.addEventListener('mousedown', (e) => e.preventDefault());
    colorBtn.addEventListener('click', () => colorPopover(colorBtn, { noneLabel: 'Automatic', onPick: (c) => { colorBtn.querySelector('.swatch-bar').style.color = c || '#1d1b22'; this.exec('foreColor', c || '#1d1b22'); } }));
    const hiBtn = h('button', { class: 'icon-btn color-btn', 'data-tip': 'Highlight color' }, icon('highlighter'), h('span', { class: 'swatch-bar', style: { color: '#ffe599' } }));
    hiBtn.addEventListener('mousedown', (e) => e.preventDefault());
    hiBtn.addEventListener('click', () => colorPopover(hiBtn, { noneLabel: 'None', onPick: (c) => { if (c) hiBtn.querySelector('.swatch-bar').style.color = c; this.exec('hiliteColor', c || 'transparent'); } }));

    this.pagelessBtn = btn('pageless', 'Pageless — one continuous sheet', () => this.togglePageless());
    this.syncPagelessButton = () => this.pagelessBtn.classList.toggle('active', !!this.pageSetup.pageless);
    this.syncPagelessButton();
    const tb = h('div', { class: 'toolbar doc-toolbar' },
      btn('undo', 'Undo', () => this.undo(), 'Ctrl+Z'),
      btn('redo', 'Redo', () => this.redo(), 'Ctrl+Y'),
      btn('print', 'Print', () => this.print(), 'Ctrl+P'),
      tbSep(),
      btn('page-plus', 'Add a page after this one', () => this.addPage(), 'Ctrl+Alt+Enter'),
      btn('page-minus', 'Delete this page', () => this.deletePage(), 'Ctrl+Alt+Backspace'),
      this.pagelessBtn,
      btn('pages', 'More page options', (e) => showMenu(this.pagesMenu(), { anchor: e.currentTarget })),
      btn('image-down', 'Export as image (PNG / JPG)', () => this.exportImageDialog()),
      tbSep(),
      this.zoomSel,
      tbSep(),
      this.styleSel,
      tbSep(),
      this.fontSel,
      tbSep(),
      btn('minus', 'Decrease font size', () => this.stepFontSize(-1), 'Ctrl+Shift+,'),
      this.sizeInput, dl,
      btn('plus', 'Increase font size', () => this.stepFontSize(1), 'Ctrl+Shift+.'),
      tbSep(),
      this.btn.bold, this.btn.italic, this.btn.underline, this.btn.strike,
      colorBtn, hiBtn,
      tbSep(),
      btn('link', 'Insert link', () => this.linkDialog(), 'Ctrl+K'),
      btn('image-plus', 'Insert image', (e) => showMenu(this.imageMenu(), { anchor: e.currentTarget })),
      btn('table', 'Insert table', (e) => this.tablePicker(e.currentTarget)),
      tbSep(),
      this.btn.left, this.btn.center, this.btn.right, this.btn.justify,
      btn('line-height', 'Line & paragraph spacing', (e) => showMenu(this.spacingMenu(), { anchor: e.currentTarget })),
      tbSep(),
      this.btn.check, this.btn.ul, this.btn.ol,
      btn('outdent', 'Decrease indent', () => this.indent(-1), 'Ctrl+['),
      btn('indent', 'Increase indent', () => this.indent(1), 'Ctrl+]'),
      tbSep(),
      btn('clear-format', 'Clear formatting', () => this.clearFormatting(), 'Ctrl+\\'),
      btn('search', 'Find and replace', () => this.find(true), 'Ctrl+H'),
      btn('sidebar', 'Document outline', () => this.toggleOutline()),
    );
    return tb;
  }

  syncToolbar() {
    if (!this.btn) return;
    const el = this.anchorElement();
    if (!el) return;
    const q = (c) => { try { return document.queryCommandState(c); } catch { return false; } };
    this.btn.bold.classList.toggle('active', q('bold'));
    this.btn.italic.classList.toggle('active', q('italic'));
    this.btn.underline.classList.toggle('active', q('underline'));
    this.btn.strike.classList.toggle('active', q('strikeThrough'));
    const cs = getComputedStyle(el);
    const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    if (document.activeElement !== this.fontSel) {
      if (![...this.fontSel.options].some((o) => o.value === fam)) this.fontSel.append(h('option', { value: fam }, fam));
      this.fontSel.value = fam;
    }
    if (document.activeElement !== this.sizeInput) {
      const pt = Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2;
      this.sizeInput.value = String(pt);
    }
    const block = this.closestBlock(el);
    let style = 'p';
    if (block) {
      const t = block.tagName;
      if (/^H[1-6]$/.test(t)) style = t.toLowerCase();
      else if (t === 'P' && block.classList.contains('title')) style = 'title';
      else if (t === 'P' && block.classList.contains('subtitle')) style = 'subtitle';
      else if (t === 'BLOCKQUOTE' || block.closest('blockquote')) style = 'quote';
      else if (t === 'PRE') style = 'code';
      const align = getComputedStyle(block).textAlign;
      const a = align === 'center' ? 'center' : align === 'right' || align === 'end' ? 'right' : align === 'justify' ? 'justify' : 'left';
      for (const k of ['left', 'center', 'right', 'justify']) this.btn[k].classList.toggle('active', k === a);
    }
    if (document.activeElement !== this.styleSel) this.styleSel.value = [...this.styleSel.options].some((o) => o.value === style) ? style : 'p';
    const list = el.closest('ul,ol');
    this.btn.ul.classList.toggle('active', !!list && list.tagName === 'UL' && !list.classList.contains('checklist'));
    this.btn.ol.classList.toggle('active', !!list && list.tagName === 'OL');
    this.btn.check.classList.toggle('active', !!list && list.classList.contains('checklist'));
  }

  // =================================================================== formatting actions

  applyBlockStyle(kind) {
    const tag = { p: 'p', title: 'p', subtitle: 'p', quote: 'blockquote', code: 'pre' }[kind] || kind;
    this.edit(() => {
      document.execCommand('formatBlock', false, tag);
      for (const b of this.selectedBlocks()) {
        b.classList.remove('title', 'subtitle');
        if (!b.classList.length) b.removeAttribute('class');
        if (kind === 'title' || kind === 'subtitle') b.classList.add(kind);
        for (const p of ['fontSize', 'fontFamily', 'fontWeight', 'color', 'fontStyle', 'textTransform']) b.style[p] = '';
        if (!b.getAttribute('style')) b.removeAttribute('style');
      }
    });
    this.syncToolbar();
  }

  applyFont(name) {
    this.exec('fontName', name);
  }

  applyFontSize(pt) {
    this.edit(() => {
      const sel = getSelection();
      if (!sel.rangeCount) return;
      if (sel.isCollapsed) {
        const span = h('span', { style: { fontSize: pt + 'pt' } }, '​');
        const r = sel.getRangeAt(0);
        r.insertNode(span);
        const nr = document.createRange();
        nr.setStart(span.firstChild, 1);
        nr.collapse(true);
        sel.removeAllRanges();
        sel.addRange(nr);
        return;
      }
      document.execCommand('styleWithCSS', false, false);
      document.execCommand('fontSize', false, '7');
      document.execCommand('styleWithCSS', false, true);
      for (const f of this.body.querySelectorAll('font[size="7"]')) {
        const span = document.createElement('span');
        span.style.fontSize = pt + 'pt';
        while (f.firstChild) span.append(f.firstChild);
        for (const d of span.querySelectorAll('[style]')) d.style.fontSize = '';
        f.replaceWith(span);
      }
      for (const s of this.body.querySelectorAll('span[style*="xxx-large"]')) s.style.fontSize = pt + 'pt';
    });
    this.sizeInput.value = String(pt);
    this.body.focus();
  }

  stepFontSize(dir) {
    const cur = parseFloat(this.sizeInput?.value) || this.defaults.size;
    let next;
    if (dir > 0) next = FONT_SIZES.find((s) => s > cur) ?? cur + 4;
    else next = [...FONT_SIZES].reverse().find((s) => s < cur) ?? Math.max(1, cur - 1);
    this.applyFontSize(next);
  }

  clearFormatting() {
    this.edit(() => {
      document.execCommand('removeFormat');
      const sel = getSelection();
      if (!sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      for (const s of this.body.querySelectorAll('span[style], font, b, i, u, s, strike, strong, em, mark')) {
        if (r.intersectsNode(s) && s.tagName !== 'A') s.replaceWith(...s.childNodes);
      }
    });
  }

  toggleList(kind) {
    const el = this.anchorElement();
    const list = el?.closest('ul,ol');
    const isCheck = list?.classList.contains('checklist');
    this.edit(() => {
      if (kind === 'check') {
        if (isCheck) { document.execCommand('insertUnorderedList'); return; }
        if (!list || list.tagName !== 'UL') document.execCommand('insertUnorderedList');
        this.normalizeStructure();
        const ul = this.anchorElement()?.closest('ul');
        if (ul) { ul.classList.add('checklist'); for (const li of ul.children) if (!li.dataset.checked) li.dataset.checked = 'false'; }
      } else if (kind === 'ul') {
        if (isCheck) { list.classList.remove('checklist'); for (const li of list.children) delete li.dataset.checked; if (!list.className) list.removeAttribute('class'); return; }
        document.execCommand('insertUnorderedList');
      } else document.execCommand('insertOrderedList');
      this.normalizeStructure();
    });
    this.syncToolbar();
  }

  setListStyle(type) {
    const list = this.anchorElement()?.closest('ul,ol');
    if (!list) return toast('Put the cursor in a list first.', { type: 'warn' });
    this.edit(() => { list.style.listStyleType = type; });
  }

  indent(dir) {
    const el = this.anchorElement();
    if (el?.closest('li')) { this.exec(dir > 0 ? 'indent' : 'outdent'); return; }
    this.edit(() => {
      for (const b of this.selectedBlocks()) {
        if (b.tagName === 'TD' || b.tagName === 'TH') continue;
        const cur = parseFloat(b.style.marginLeft) || 0;
        const unit = b.style.marginLeft.endsWith('pt') ? 72 / 96 : 1;
        const px = cur / unit;
        const next = Math.max(0, px + dir * 48);
        b.style.marginLeft = next ? next + 'px' : '';
      }
    });
  }

  setLineSpacing(v) {
    this.edit(() => { for (const b of this.selectedBlocks()) b.style.lineHeight = String(+(v * LH_FACTOR).toFixed(3)); });
  }

  toggleParaSpace(which) {
    this.edit(() => {
      for (const b of this.selectedBlocks()) {
        const prop = which === 'before' ? 'marginTop' : 'marginBottom';
        const cur = parseFloat(getComputedStyle(b)[prop]) || 0;
        b.style[prop] = cur > 1 ? '0pt' : '12pt';
      }
    });
  }

  spacingMenu() {
    const lh = (() => { const b = this.selectedBlocks()[0]; if (!b) return null; const v = parseFloat(b.style.lineHeight); return v ? v / LH_FACTOR : null; })();
    const opt = (v, l) => ({ label: l, checked: lh != null && Math.abs(lh - v) < 0.02, action: () => this.setLineSpacing(v) });
    return [
      opt(1, 'Single'), opt(1.15, '1.15'), opt(1.5, '1.5'), opt(2, 'Double'),
      { label: 'Custom…', action: async () => { const v = parseFloat(await promptDialog('Line spacing', 'Lines (e.g. 1.25)', String(lh || 1))); if (v > 0 && v < 10) this.setLineSpacing(v); } },
      { sep: true },
      { label: 'Toggle space before paragraph', action: () => this.toggleParaSpace('before') },
      { label: 'Toggle space after paragraph', action: () => this.toggleParaSpace('after') },
    ];
  }

  // =================================================================== insert

  imageMenu() {
    return [
      { label: 'Upload from computer…', icon: 'upload', action: () => this.insertImageFromDisk() },
      { label: 'From media dump', icon: 'image', action: () => this.dump.toggle(true) },
      { label: 'By URL…', icon: 'link', action: () => this.insertImageByUrl() },
    ];
  }

  async insertImageFromDisk() {
    const saved = this.savedRange?.cloneRange();
    const paths = await pickOpen({ multi: true, title: 'Insert image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'] }] });
    if (!paths) return;
    if (saved) this.savedRange = saved;
    for (const p of paths) {
      try {
        const { bytes } = await api.read(p);
        const ext = p.split('.').pop().toLowerCase();
        const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' }[ext] || `image/${ext}`;
        const url = await blobToDataURL(new Blob([bytes], { type: mime }));
        await this.insertImage(url);
      } catch (e) { errorToast(e, 'Could not insert image'); }
    }
  }

  async insertImageByUrl() {
    const url = await promptDialog('Insert image', 'Image URL', '', { placeholder: 'https://…', type: 'url' });
    if (!url) return;
    let src = url;
    try {
      const res = await fetch(url);
      if (res.ok) src = await blobToDataURL(await res.blob());
    } catch { /* keep remote URL (may be blocked by CORS) */ }
    this.insertImage(src);
  }

  /** Files sent from the file panels (Ctrl+right-click): pictures go in at the cursor. */
  async receiveFiles(paths) {
    let n = 0;
    for (const p of paths.filter((x) => /\.(png|jpe?g|jfif|gif|webp|bmp|svg|avif)$/i.test(x))) {
      const { bytes } = await api.read(p);
      await this.insertImage(await blobToDataURL(new Blob([bytes], { type: p.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : '' })));
      n++;
    }
    return n;
  }

  async insertImage(src, { atPoint } = {}) {
    const dims = await new Promise((resolve) => { const im = new Image(); im.onload = () => resolve([im.naturalWidth, im.naturalHeight]); im.onerror = () => resolve([0, 0]); im.src = src; });
    const maxW = this.body.clientWidth || 600;
    const w = dims[0] ? Math.min(dims[0], maxW) : null;
    const html = `<img src="${escapeHtml(src)}"${w ? ` style="width:${Math.round(w)}px"` : ''}>`;
    if (atPoint) {
      const r = document.caretRangeFromPoint(atPoint.x, atPoint.y);
      if (r && this.body.contains(r.startContainer)) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); this.savedRange = r; }
    }
    this.exec('insertHTML', html);
  }

  tablePicker(anchor) {
    const grid = h('div', { class: 'grid-picker' });
    const label = h('div', { class: 'grid-picker-label' }, 'Insert table');
    const cells = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 10; c++) {
      const d = h('div');
      d.addEventListener('mouseenter', () => { cells.forEach((x) => x.el.classList.toggle('on', x.r <= r && x.c <= c)); label.textContent = `${c + 1} × ${r + 1}`; });
      d.addEventListener('mousedown', (e) => e.preventDefault());
      d.addEventListener('click', () => { closePopover(); this.insertTable(r + 1, c + 1); });
      cells.push({ el: d, r, c });
      grid.append(d);
    }
    popover(anchor, h('div', {}, grid, label));
  }

  insertTable(rows, cols) {
    this.edit(() => {
      const table = h('table', {}, h('tbody', {}, Array.from({ length: rows }, () => h('tr', {}, Array.from({ length: cols }, () => h('td', {}, h('br')))))));
      this.insertBlockNode(table);
      this.placeCaret(table.querySelector('td'));
    });
  }

  insertPageBreak() {
    this.edit(() => {
      const sel = getSelection();
      const block = sel.rangeCount ? this.topLevelBlock(sel.anchorNode) : null;
      const pb = h('div', { class: 'page-break', contenteditable: 'false' });
      const next = h('p', {}, h('br'));
      if (block) {
        // split the paragraph at the caret if the caret is mid-text
        const r = sel.getRangeAt(0);
        const tail = document.createRange();
        tail.setStart(r.endContainer, r.endOffset);
        tail.setEndAfter(block.lastChild || block);
        const frag = tail.extractContents();
        const hasText = frag.textContent.length || frag.querySelector?.('img');
        block.after(pb);
        if (hasText && block.tagName === 'P') {
          const np = document.createElement('p');
          np.append(frag);
          pb.after(np);
          if (!block.textContent && !block.querySelector('img')) block.innerHTML = '<br>';
          this.placeCaret(np);
          return;
        }
        if (!block.textContent && !block.querySelector('img,br')) block.innerHTML = '<br>';
        pb.after(next);
      } else this.body.append(pb, next);
      this.placeCaret(next);
    });
  }

  insertToc() {
    const heads = $$('h1,h2,h3,p.title', this.body);
    if (!heads.length) return toast('Add some headings first.', { type: 'warn' });
    this.edit(() => {
      heads.forEach((hd, i) => { if (!hd.id) hd.id = 'h-' + Math.random().toString(36).slice(2, 8); });
      const toc = h('div', { class: 'toc' }, h('p', {}, h('b', {}, 'Contents')),
        heads.filter((x) => x.tagName !== 'P').map((x) => h('p', { style: { marginLeft: (Number(x.tagName[1]) - 1) * 18 + 'pt' } }, h('a', { href: '#' + x.id }, x.textContent))));
      this.insertBlockNode(toc);
    });
  }

  specialChars(anchor) {
    const grid = h('div', { class: 'swatches', style: { gridTemplateColumns: 'repeat(12, 26px)' } });
    for (const c of SPECIAL_CHARS) {
      grid.append(h('button', { class: 'btn sm', style: { width: '26px', padding: '0', height: '26px' }, onmousedown: (e) => e.preventDefault(), onclick: () => { this.exec('insertText', c); } }, c));
    }
    popover(anchor || this.btn.bold, grid);
  }

  async linkDialog() {
    this.restoreSel();
    const sel = getSelection();
    const a = this.anchorElement()?.closest('a');
    const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const textIn = h('input', { type: 'text', value: a ? a.textContent : sel.toString() });
    const urlIn = h('input', { type: 'url', value: a ? a.getAttribute('href') : '', placeholder: 'https://example.com' });
    const res = await modal({
      title: a ? 'Edit link' : 'Insert link',
      body: h('div', { class: 'form-grid' }, h('label', {}, 'Text'), textIn, h('label', {}, 'Link'), urlIn),
      buttons: [
        ...(a ? [{ label: 'Remove link', value: 'remove', danger: true }] : []),
        { label: 'Cancel', value: null, ghost: true },
        { label: 'Apply', primary: true, value: 'ok' },
      ],
      onOpen: () => setTimeout(() => (textIn.value ? urlIn : textIn).focus(), 30),
    });
    if (!res) return;
    this.body.focus();
    if (range) { sel.removeAllRanges(); sel.addRange(range); this.savedRange = range; }
    if (res === 'remove') {
      this.edit(() => { a.replaceWith(...a.childNodes); });
      return;
    }
    let url = urlIn.value.trim();
    if (!url) return;
    if (!/^[a-z][a-z0-9+.-]*:|^#/i.test(url)) url = (/^[^@\s]+@[^@\s]+\.\w+$/.test(url) ? 'mailto:' : 'https://') + url;
    const text = textIn.value || url;
    this.edit(() => {
      if (a) { a.setAttribute('href', url); if (a.textContent !== text) a.textContent = text; return; }
      document.execCommand('insertHTML', false, `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`);
    });
  }

  // =================================================================== events

  onKey(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (ctrl && !e.shiftKey && k === 'z') { stop(); return this.undo(); }
    if (ctrl && (k === 'y' || (e.shiftKey && k === 'z'))) { stop(); return this.redo(); }
    if (ctrl && k === 'k') { stop(); return this.linkDialog(); }
    if (ctrl && e.shiftKey && k === 'v') { this.plainPaste = true; setTimeout(() => { this.plainPaste = false; }, 300); return; }
    if (ctrl && e.altKey && e.key === 'Enter') { stop(); return this.addPage(); }
    if (ctrl && e.altKey && e.key === 'Backspace') { stop(); return this.deletePage(); }
    if (ctrl && e.key === 'Enter') { stop(); return this.insertPageBreak(); }
    if (ctrl && e.altKey && /^Digit[0-6]$/.test(e.code)) { stop(); const n = Number(e.code.slice(5)); return this.applyBlockStyle(n === 0 ? 'p' : 'h' + n); }
    if (ctrl && e.shiftKey && e.code === 'Digit7') { stop(); return this.toggleList('ol'); }
    if (ctrl && e.shiftKey && e.code === 'Digit8') { stop(); return this.toggleList('ul'); }
    if (ctrl && e.shiftKey && e.code === 'Digit9') { stop(); return this.toggleList('check'); }
    if (ctrl && e.shiftKey && k === 'l') { stop(); return this.exec('justifyLeft'); }
    if (ctrl && e.shiftKey && k === 'e') { stop(); return this.exec('justifyCenter'); }
    if (ctrl && e.shiftKey && k === 'r') { stop(); return this.exec('justifyRight'); }
    if (ctrl && e.shiftKey && k === 'j') { stop(); return this.exec('justifyFull'); }
    if (ctrl && e.shiftKey && e.code === 'Period') { stop(); return this.stepFontSize(1); }
    if (ctrl && e.shiftKey && e.code === 'Comma') { stop(); return this.stepFontSize(-1); }
    if (ctrl && !e.shiftKey && e.code === 'Period') { stop(); return this.exec('superscript'); }
    if (ctrl && !e.shiftKey && e.code === 'Comma') { stop(); return this.exec('subscript'); }
    if (e.altKey && e.shiftKey && e.code === 'Digit5') { stop(); return this.exec('strikeThrough'); }
    if (ctrl && e.code === 'Backslash') { stop(); return this.clearFormatting(); }
    if (ctrl && e.code === 'BracketRight') { stop(); return this.indent(1); }
    if (ctrl && e.code === 'BracketLeft') { stop(); return this.indent(-1); }
    if (ctrl && e.key === 'g') { stop(); return; }

    if (e.key === 'Tab' && !ctrl && !e.altKey) {
      const el = this.anchorElement();
      const cell = el?.closest('td,th');
      if (cell) { stop(); return this.moveCell(cell, e.shiftKey ? -1 : 1); }
      if (el?.closest('li')) { stop(); return this.exec(e.shiftKey ? 'outdent' : 'indent'); }
      stop();
      if (!e.shiftKey) this.exec('insertText', '\t');
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedImg) {
      stop();
      const img = this.selectedImg;
      this.hideImgBox();
      this.edit(() => img.remove());
      return;
    }
    if (this.selectedImg && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) this.hideImgBox();
  }

  moveCell(cell, dir) {
    const cells = $$('td,th', cell.closest('table'));
    const i = cells.indexOf(cell) + dir;
    if (i >= cells.length) {
      this.tableOp('row-below', cells[cells.length - 1]);
      const fresh = $$('td,th', cell.closest('table'));
      this.placeCaret(fresh[i] || fresh[fresh.length - 1]);
      return;
    }
    if (i < 0) return;
    const r = document.createRange();
    r.selectNodeContents(cells[i]);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  async onPaste(e) {
    const cd = e.clipboardData;
    if (!cd) return;
    e.preventDefault();
    const files = [...cd.files].filter((f) => f.type.startsWith('image/'));
    const htmlData = cd.getData('text/html');
    if (files.length && !htmlData) {
      for (const f of files) this.insertImage(await blobToDataURL(f));
      return;
    }
    if (this.plainPaste || !htmlData) {
      const text = cd.getData('text/plain');
      if (!text) return;
      if (/\n/.test(text)) {
        const parts = text.replace(/\r\n?/g, '\n').split('\n');
        this.exec('insertHTML', parts.map((p) => escapeHtml(p)).join('<br>'));
      } else this.exec('insertText', text);
      return;
    }
    const clean = sanitizeHtml(htmlData.replace(/^[\s\S]*<!--StartFragment-->|<!--EndFragment-->[\s\S]*$/g, ''));
    this.exec('insertHTML', clean);
  }

  async onDrop(e) {
    const dt = e.dataTransfer;
    const dumpUrl = dt.getData(DUMP_MIME);
    const files = [...dt.files].filter((f) => f.type.startsWith('image/'));
    if (!dumpUrl && !files.length) { if (dt.types.includes('Files')) { e.preventDefault(); } else this.checkpoint(); return; }
    e.preventDefault();
    e.stopPropagation();
    const at = { x: e.clientX, y: e.clientY };
    if (dumpUrl) {
      const blob = await (await fetch(dumpUrl)).blob();
      return this.insertImage(await blobToDataURL(blob), { atPoint: at });
    }
    for (const f of files) await this.insertImage(await blobToDataURL(f), { atPoint: at });
  }

  onClick(e) {
    const t = e.target;
    if (t.tagName === 'IMG') { this.selectImage(t); return; }
    this.hideImgBox();
    const a = t.closest('a[href]');
    if (a && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href.startsWith('#')) { const target = this.body.querySelector(href); if (target) this.scrollToEl(target); }
      else window.open(href, '_blank', 'noopener');
      return;
    }
    const li = t.closest('ul.checklist > li');
    if (li && e.clientX < li.getBoundingClientRect().left + 2) {
      this.edit(() => { li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true'; });
    }
  }

  onContextMenu(e) {
    if (e.shiftKey) return; // native menu (spelling suggestions)
    const img = e.target.closest('img');
    const cell = e.target.closest('td,th');
    if (!img && !cell) return;
    if (img) {
      this.selectImage(img);
      return contextMenu(e, this.imageItems(img));
    }
    contextMenu(e, [
      { label: 'Insert row above', icon: 'row-add', action: () => this.tableOp('row-above', cell) },
      { label: 'Insert row below', icon: 'row-add', action: () => this.tableOp('row-below', cell) },
      { label: 'Insert column left', icon: 'col-add', action: () => this.tableOp('col-left', cell) },
      { label: 'Insert column right', icon: 'col-add', action: () => this.tableOp('col-right', cell) },
      { sep: true },
      { label: 'Delete row', action: () => this.tableOp('del-row', cell) },
      { label: 'Delete column', action: () => this.tableOp('del-col', cell) },
      { label: 'Delete table', icon: 'trash', action: () => this.tableOp('del-table', cell) },
      { sep: true },
      { label: 'Cell background…', icon: 'palette', action: () => colorPopover(cell, { noneLabel: 'None', onPick: (c) => this.edit(() => { cell.style.backgroundColor = c || ''; }) }) },
      { label: 'Header row', checked: cell.closest('table').rows[0]?.cells[0]?.tagName === 'TH', action: () => this.tableOp('header', cell) },
      { label: 'Show borders', checked: !cell.closest('table').classList.contains('plain'), action: () => this.tableOp('borders', cell) },
      { sep: true },
      { label: 'Tip: Shift+right-click for spelling suggestions', disabled: true },
    ]);
  }

  tableOp(op, cell) {
    const table = cell.closest('table');
    const row = cell.parentElement;
    const colIdx = [...row.children].indexOf(cell);
    const ncols = Math.max(...[...table.rows].map((r) => [...r.cells].reduce((a, c) => a + (c.colSpan || 1), 0)));
    const newRow = (like) => { const tr = document.createElement('tr'); for (let i = 0; i < ncols; i++) tr.append(h(like?.cells[0]?.tagName === 'TH' && false ? 'th' : 'td', {}, h('br'))); return tr; };
    this.edit(() => {
      switch (op) {
        case 'row-above': row.before(newRow(row)); break;
        case 'row-below': row.after(newRow(row)); break;
        case 'col-left': case 'col-right':
          for (const r of table.rows) {
            const ref = r.cells[Math.min(colIdx, r.cells.length - 1)];
            const c = h(ref?.tagName === 'TH' ? 'th' : 'td', {}, h('br'));
            if (!ref) r.append(c); else if (op === 'col-left') ref.before(c); else ref.after(c);
          }
          for (const col of table.querySelectorAll('col')) col.style.width = '';
          break;
        case 'del-row': row.remove(); if (!table.rows.length) table.remove(); break;
        case 'del-col':
          for (const r of [...table.rows]) r.cells[Math.min(colIdx, r.cells.length - 1)]?.remove();
          table.querySelectorAll('col')[colIdx]?.remove();
          if (!table.rows[0]?.cells.length) table.remove();
          break;
        case 'del-table': table.remove(); break;
        case 'header': {
          const first = table.rows[0];
          const toTh = first.cells[0]?.tagName !== 'TH';
          for (const c of [...first.cells]) { const n = document.createElement(toTh ? 'th' : 'td'); n.append(...c.childNodes); n.setAttribute('style', c.getAttribute('style') || ''); if (c.colSpan > 1) n.colSpan = c.colSpan; c.replaceWith(n); }
          break;
        }
        case 'borders': table.classList.toggle('plain'); if (!table.className) table.removeAttribute('class'); break;
        default: break;
      }
    });
  }

  // =================================================================== images

  selectImage(img) {
    this.selectedImg = img;
    const r = document.createRange();
    r.selectNode(img);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    this.imgBox.hidden = false;
    this.positionImgBox();
    if (!this.imgBar) {
      this.imgBar = h('div', { class: 'doc-imgbar' });
      this.imgBox.append(this.imgBar);
    }
    clear(this.imgBar);
    const b = (label, fn, tip) => { const x = h('button', { class: 'btn sm', 'data-tip': tip || null, onmousedown: (e) => e.preventDefault(), onclick: (e) => { e.stopPropagation(); fn(); } }, label); return x; };
    this.imgBar.append(
      b('25%', () => this.setImgWidth(0.25)), b('50%', () => this.setImgWidth(0.5)), b('75%', () => this.setImgWidth(0.75)), b('100%', () => this.setImgWidth(1)),
      h('span', { class: 'tb-sep' }),
      b(icon('align-left', 'sm'), () => this.setImgAlign('float-left'), 'Wrap left'),
      b(icon('align-center', 'sm'), () => this.setImgAlign('center'), 'Center'),
      b(icon('align-right', 'sm'), () => this.setImgAlign('float-right'), 'Wrap right'),
      b(icon('type', 'sm'), () => this.setImgAlign(''), 'In line with text'),
      h('span', { class: 'tb-sep' }),
      b(icon('more', 'sm'), () => showMenu(this.imageItems(img), { anchor: this.imgBar.lastChild })),
    );
  }

  imageItems(img) {
    return [
      { label: 'Save to media dump', icon: 'download', action: () => this.dump.stash(img.src, stripExt(this.tab.title).slice(0, 40) || 'image') },
      { label: 'Alt text…', action: async () => { const v = await promptDialog('Alt text', 'Describe the image', img.alt || ''); if (v != null) this.edit(() => { img.alt = v; }); } },
      { label: 'Reset size', action: () => this.edit(() => { img.style.width = ''; img.style.height = ''; }) },
      { label: 'Copy image', icon: 'copy', action: () => this.copyImage(img) },
      { sep: true },
      { label: 'Delete image', icon: 'trash', action: () => { this.hideImgBox(); this.edit(() => img.remove()); } },
    ];
  }

  async copyImage(img) {
    try {
      const bmp = await createImageBitmap(await (await fetch(img.src)).blob());
      const c = h('canvas', { width: bmp.width, height: bmp.height });
      c.getContext('2d').drawImage(bmp, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Image copied', { type: 'ok' });
    } catch (e) { errorToast(e, 'Copy failed'); }
  }

  setImgWidth(frac) {
    const img = this.selectedImg;
    if (!img) return;
    this.edit(() => { img.style.width = Math.round(this.body.clientWidth * frac) + 'px'; img.style.height = ''; });
    this.positionImgBox();
  }

  setImgAlign(cls) {
    const img = this.selectedImg;
    if (!img) return;
    this.edit(() => {
      img.classList.remove('float-left', 'float-right', 'center');
      if (cls) img.classList.add(cls);
      if (!img.className) img.removeAttribute('class');
    });
    requestAnimationFrame(() => this.positionImgBox());
  }

  positionImgBox() {
    const img = this.selectedImg;
    if (!img || this.imgBox.hidden) return;
    if (!this.body.contains(img)) return this.hideImgBox();
    const cr = this.canvas.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    Object.assign(this.imgBox.style, {
      left: r.left - cr.left + 'px', top: r.top - cr.top + 'px',
      width: r.width + 'px', height: r.height + 'px',
    });
  }

  hideImgBox() { this.selectedImg = null; this.imgBox.hidden = true; }

  wireImageResize() {
    const handle = this.imgBox.querySelector('.doc-imgbox-handle');
    let start = null;
    handle.addEventListener('mousedown', (e) => {
      if (!this.selectedImg) return;
      e.preventDefault();
      e.stopPropagation();
      this.checkpoint();
      start = { x: e.clientX, w: this.selectedImg.getBoundingClientRect().width / this.scale };
    });
    window.addEventListener('mousemove', (e) => {
      if (!start || !this.selectedImg) return;
      const w = clamp(start.w + (e.clientX - start.x) / this.scale, 24, this.body.clientWidth);
      this.selectedImg.style.width = Math.round(w) + 'px';
      this.selectedImg.style.height = '';
      this.positionImgBox();
    });
    window.addEventListener('mouseup', () => { if (start) { start = null; this.contentChanged(); } });
  }

  // =================================================================== outline

  toggleOutline() {
    this.outlineEl.hidden = !this.outlineEl.hidden;
    this.app.saveSettings({ docOutline: !this.outlineEl.hidden });
    this.renderOutline();
  }

  renderOutline() {
    if (this.outlineEl.hidden) return;
    const heads = $$('p.title,h1,h2,h3,h4', this.body);
    clear(this.outlineEl).append(h('div', { class: 'panel-head' }, 'Outline'));
    const list = h('div', { class: 'doc-outline-list' });
    if (!heads.length) list.append(h('div', { class: 'empty-note' }, 'Headings you add will appear here.'));
    for (const hd of heads) {
      const lvl = hd.tagName === 'P' ? 0 : Number(hd.tagName[1]) - 1;
      list.append(h('button', { class: `doc-outline-item lvl${lvl}`, onclick: () => this.scrollToEl(hd, true) }, hd.textContent.trim() || '(empty heading)'));
    }
    this.outlineEl.append(list);
  }

  scrollToEl(el, caret = false) {
    const sr = this.scroller.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    this.scroller.scrollTop += r.top - sr.top - 60;
    if (caret) { this.body.focus(); this.placeCaret(el); }
  }

  // =================================================================== find

  find(replace) {
    if (!this.findBar) this.findBar = new FindBar(this.root, this.findProvider());
    const sel = getSelection().toString();
    this.findBar.open(replace, sel && sel.length < 80 && !sel.includes('\n') ? sel : undefined);
  }

  findProvider() {
    const self = this;
    const supportsHL = typeof Highlight !== 'undefined' && CSS.highlights;
    const paint = () => {
      if (!supportsHL) return;
      CSS.highlights.set('bds-find', new Highlight(...self.findRanges));
      const cur = self.findRanges[self.findIndex];
      if (cur) CSS.highlights.set('bds-find-current', new Highlight(cur)); else CSS.highlights.delete('bds-find-current');
    };
    const show = () => {
      paint();
      const cur = self.findRanges[self.findIndex];
      if (!cur) return;
      const r = cur.getBoundingClientRect();
      const sr = self.scroller.getBoundingClientRect();
      if (r.top < sr.top + 40 || r.bottom > sr.bottom - 40) self.scroller.scrollTop += r.top - sr.top - sr.height / 3;
      if (!supportsHL) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(cur); }
    };
    return {
      canReplace: true,
      find(q, opts) {
        self.lastFind = { q, opts };
        const re = buildRegex(q, opts);
        // flatten text per block so matches don't cross paragraphs
        self.findRanges = [];
        const blocks = $$(BLOCK_SEL, self.body).filter((b) => !b.querySelector(BLOCK_SEL));
        for (const b of blocks) {
          const nodes = [];
          const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
          let text = '';
          while (w.nextNode()) { nodes.push([w.currentNode, text.length]); text += w.currentNode.data; }
          if (!text) continue;
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(text))) {
            if (!m[0].length) { re.lastIndex++; continue; }
            const at = (pos, end) => {
              for (let i = nodes.length - 1; i >= 0; i--) {
                const [n, off] = nodes[i];
                if (pos > off || (pos === off && !end) || i === 0) return [n, Math.min(n.length, pos - off)];
              }
              return [nodes[0][0], 0];
            };
            const [sn, so] = at(m.index, false);
            const [en, eo] = at(m.index + m[0].length, true);
            const r = document.createRange();
            r.setStart(sn, so);
            r.setEnd(en, eo);
            self.findRanges.push(r);
            if (self.findRanges.length > 5000) break;
          }
        }
        const sel = getSelection();
        let idx = 0;
        if (sel.rangeCount && self.body.contains(sel.anchorNode)) {
          const caret = sel.getRangeAt(0);
          const i = self.findRanges.findIndex((r) => r.compareBoundaryPoints(Range.START_TO_START, caret) >= 0);
          idx = i < 0 ? 0 : i;
        }
        self.findIndex = self.findRanges.length ? idx : -1;
        show();
        return { count: self.findRanges.length, index: self.findIndex };
      },
      next() { if (!self.findRanges.length) return { count: 0, index: -1 }; self.findIndex = (self.findIndex + 1) % self.findRanges.length; show(); return { count: self.findRanges.length, index: self.findIndex }; },
      prev() { if (!self.findRanges.length) return { count: 0, index: -1 }; self.findIndex = (self.findIndex - 1 + self.findRanges.length) % self.findRanges.length; show(); return { count: self.findRanges.length, index: self.findIndex }; },
      replace(text) {
        const cur = self.findRanges[self.findIndex];
        if (!cur) return { count: 0, index: -1 };
        const active = document.activeElement;
        const { q, opts } = self.lastFind;
        const repl = opts.regex ? cur.toString().replace(buildRegex(q, opts), text) : text;
        self.body.focus({ preventScroll: true });
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(cur);
        self.savedRange = cur;
        self.exec('insertText', repl);
        active?.focus();
        return this.find(q, opts);
      },
      replaceAll(text) {
        const { q, opts } = self.lastFind || {};
        if (!q) return 0;
        this.find(q, opts);
        const ranges = [...self.findRanges].reverse();
        if (!ranges.length) return 0;
        self.endBurst();
        self.checkpoint();
        self.body.focus({ preventScroll: true });
        const sel = getSelection();
        for (const r of ranges) {
          const repl = opts.regex ? r.toString().replace(buildRegex(q, opts), text) : text;
          sel.removeAllRanges();
          sel.addRange(r);
          document.execCommand('insertText', false, repl);
        }
        self.contentChanged();
        return ranges.length;
      },
      clear() { self.findRanges = []; self.findIndex = -1; if (supportsHL) { CSS.highlights.delete('bds-find'); CSS.highlights.delete('bds-find-current'); } },
      onClose() { self.restoreSel(); },
    };
  }

  // =================================================================== menus

  menus() {
    return {
      edit: [
        { label: 'Paste as plain text', icon: 'paste', shortcut: 'Ctrl+Shift+V', action: () => this.app.pasteFromMenu(true) },
      ],
      view: [
        { label: 'Fit page width', icon: 'fit-width', action: () => this.zoom('fit') },
        { label: 'Document outline', icon: 'sidebar', checked: !this.outlineEl.hidden, action: () => this.toggleOutline() },
        { label: 'Media dump drawer', icon: 'image', checked: this.dump.open, action: () => this.dump.toggle() },
        { label: 'Doc dump drawer', icon: 'file-text', checked: this.dumps.doc.open, action: () => this.dumps.doc.toggle() },
        { label: 'Pageless', icon: 'pageless', checked: !!this.pageSetup.pageless, action: () => this.togglePageless() },
        { label: 'Night paper', icon: 'moon', checked: this.app.settings.paper === 'night', action: () => { this.app.saveSettings({ paper: this.app.settings.paper === 'night' ? 'white' : 'night' }); this.onThemeChange(); } },
      ],
      insert: [
        { label: 'Image', icon: 'image-plus', submenu: () => this.imageMenu() },
        { label: 'Table…', icon: 'table', action: () => this.tablePicker(this.app.menubarOpen || document.getElementById('menubar')) },
        { label: 'Link…', icon: 'link', shortcut: 'Ctrl+K', action: () => this.linkDialog() },
        { sep: true },
        { label: 'Horizontal line', icon: 'hr', action: () => this.exec('insertHorizontalRule') },
        { label: 'Page break', icon: 'page-break', shortcut: 'Ctrl+Enter', action: () => this.insertPageBreak() },
        { label: 'Blank page', icon: 'page-plus', shortcut: 'Ctrl+Alt+Enter', action: () => this.addPage() },
        { label: 'Table of contents', icon: 'list-ordered', action: () => this.insertToc() },
        { sep: true },
        { label: 'Date', icon: 'calendar', action: () => this.exec('insertText', new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })) },
        { label: 'Date & time', action: () => this.exec('insertText', new Date().toLocaleString()) },
        { label: 'Special characters', icon: 'omega', action: () => { if (this.app.rightPanel !== 'chars') this.app.toggleRightPanel('chars'); } },
        { label: 'Checklist', icon: 'list-check', action: () => this.toggleList('check') },
      ],
      format: [
        { label: 'Text', icon: 'type', submenu: [
          { label: 'Bold', icon: 'bold', shortcut: 'Ctrl+B', action: () => this.exec('bold') },
          { label: 'Italic', icon: 'italic', shortcut: 'Ctrl+I', action: () => this.exec('italic') },
          { label: 'Underline', icon: 'underline', shortcut: 'Ctrl+U', action: () => this.exec('underline') },
          { label: 'Strikethrough', icon: 'strike', shortcut: 'Alt+Shift+5', action: () => this.exec('strikeThrough') },
          { label: 'Superscript', icon: 'superscript', shortcut: 'Ctrl+.', action: () => this.exec('superscript') },
          { label: 'Subscript', icon: 'subscript', shortcut: 'Ctrl+,', action: () => this.exec('subscript') },
          { sep: true },
          { label: 'UPPERCASE', action: () => this.changeCase('upper') },
          { label: 'lowercase', action: () => this.changeCase('lower') },
          { label: 'Title Case', action: () => this.changeCase('title') },
        ] },
        { label: 'Paragraph style', icon: 'heading', submenu: STYLE_OPTIONS.map((o) => ({ label: o.label, action: () => this.applyBlockStyle(o.value) })) },
        { label: 'Align', icon: 'align-left', submenu: [
          { label: 'Left', icon: 'align-left', shortcut: 'Ctrl+Shift+L', action: () => this.exec('justifyLeft') },
          { label: 'Center', icon: 'align-center', shortcut: 'Ctrl+Shift+E', action: () => this.exec('justifyCenter') },
          { label: 'Right', icon: 'align-right', shortcut: 'Ctrl+Shift+R', action: () => this.exec('justifyRight') },
          { label: 'Justified', icon: 'align-justify', shortcut: 'Ctrl+Shift+J', action: () => this.exec('justifyFull') },
        ] },
        { label: 'Line & paragraph spacing', icon: 'line-height', submenu: () => this.spacingMenu() },
        { label: 'Bullets & numbering', icon: 'list-bullet', submenu: [
          { label: 'Bulleted list', icon: 'list-bullet', action: () => this.toggleList('ul') },
          { label: 'Numbered list', icon: 'list-ordered', action: () => this.toggleList('ol') },
          { label: 'Checklist', icon: 'list-check', action: () => this.toggleList('check') },
          { sep: true },
          ...[['disc', '● Disc'], ['circle', '○ Circle'], ['square', '■ Square'], ['decimal', '1. 2. 3.'], ['lower-alpha', 'a. b. c.'], ['upper-alpha', 'A. B. C.'], ['lower-roman', 'i. ii. iii.'], ['upper-roman', 'I. II. III.']]
            .map(([v, l]) => ({ label: l, action: () => this.setListStyle(v) })),
        ] },
        { sep: true },
        { label: 'Clear formatting', icon: 'clear-format', shortcut: 'Ctrl+\\', action: () => this.clearFormatting() },
        { sep: true },
        { label: 'Pages', icon: 'pages', submenu: () => this.pagesMenu() },
        { label: 'Page setup…', icon: 'file', action: () => this.pageSetupDialog() },
      ],
      tools: [
        { label: 'Word count…', action: () => this.wordCount() },
        { label: 'Spell check', checked: this.body.spellcheck, action: () => { this.app.saveSettings({ spellcheck: !this.body.spellcheck }); this.onThemeChange(); } },
        { label: 'Document outline', icon: 'sidebar', action: () => this.toggleOutline() },
        { label: 'Media dump', icon: 'image', action: () => this.dump.toggle(true) },
        { label: 'Doc dump', icon: 'file-text', action: () => this.dumps.doc.toggle(true) },
      ],
    };
  }

  changeCase(mode) {
    const sel = getSelection();
    const text = sel.toString();
    if (!text) return toast('Select some text first.', { type: 'warn' });
    const out = mode === 'upper' ? text.toUpperCase() : mode === 'lower' ? text.toLowerCase() : text.toLowerCase().replace(/(^|[\s\-(["'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    this.exec('insertText', out);
  }

  async pageSetupDialog() {
    const ps = this.pageSetup;
    const sizeSel = h('select', {}, Object.entries(PAGE_SIZES).map(([k, v]) => h('option', { value: k }, v.label)), h('option', { value: 'custom' }, 'Custom…'));
    sizeSel.value = ps.size;
    const wIn = h('input', { type: 'number', step: '0.01', value: String(pageDims({ ...ps, orientation: 'portrait' }).w) });
    const hIn = h('input', { type: 'number', step: '0.01', value: String(pageDims({ ...ps, orientation: 'portrait' }).h) });
    const custom = h('div', { class: 'row' }, wIn, h('span', { class: 'faint' }, '×'), hIn, h('span', { class: 'faint' }, 'in'));
    custom.hidden = ps.size !== 'custom';
    sizeSel.addEventListener('change', () => { custom.hidden = sizeSel.value !== 'custom'; });
    const orient = h('div', { class: 'seg' });
    let orientation = ps.orientation;
    for (const o of ['portrait', 'landscape']) {
      const b = h('button', { class: orientation === o ? 'on' : '' }, o);
      b.addEventListener('click', () => { orientation = o; [...orient.children].forEach((x) => x.classList.toggle('on', x === b)); });
      orient.append(b);
    }
    const mIn = {};
    for (const k of ['top', 'bottom', 'left', 'right']) mIn[k] = h('input', { type: 'number', step: '0.05', min: '0', value: String(ps.margins[k]) });
    const presets = h('div', { class: 'row' }, ...[['Normal', 1, 1], ['Narrow', 0.5, 0.5], ['Moderate', 1, 0.75], ['Wide', 1, 2]].map(([l, tb, lr]) =>
      h('button', { class: 'btn sm', onclick: () => { mIn.top.value = mIn.bottom.value = tb; mIn.left.value = mIn.right.value = lr; } }, l)));
    const fontSel = h('select', {}, FONTS.map((f) => h('option', { value: f }, f)));
    if (!FONTS.includes(this.defaults.font)) fontSel.prepend(h('option', { value: this.defaults.font }, this.defaults.font));
    fontSel.value = this.defaults.font;
    const sizeIn = h('input', { type: 'number', step: '0.5', value: String(this.defaults.size) });
    const lhIn = h('input', { type: 'number', step: '0.05', value: String(+(this.defaults.lineHeight / LH_FACTOR).toFixed(2)) });
    const afterIn = h('input', { type: 'number', step: '1', value: String(this.defaults.spaceAfter) });
    const res = await modal({
      title: 'Page setup', wide: true,
      body: h('div', { class: 'form-grid' },
        h('label', {}, 'Paper size'), sizeSel,
        h('span'), custom,
        h('label', {}, 'Orientation'), orient,
        h('label', {}, 'Margins (in)'), h('div', { class: 'row' }, h('span', { class: 'faint' }, 'T'), mIn.top, h('span', { class: 'faint' }, 'B'), mIn.bottom, h('span', { class: 'faint' }, 'L'), mIn.left, h('span', { class: 'faint' }, 'R'), mIn.right),
        h('span'), presets,
        h('div', { class: 'menu-heading', style: { gridColumn: '1 / -1', paddingLeft: 0 } }, 'Document defaults'),
        h('label', {}, 'Font'), fontSel,
        h('label', {}, 'Size (pt)'), sizeIn,
        h('label', {}, 'Line spacing'), lhIn,
        h('label', {}, 'Space after (pt)'), afterIn),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Apply', value: 'ok', primary: true }],
    });
    if (res !== 'ok') return;
    this.checkpoint();
    ps.size = sizeSel.value;
    if (ps.size === 'custom') { ps.w = parseFloat(wIn.value) || 8.5; ps.h = parseFloat(hIn.value) || 11; }
    ps.orientation = orientation;
    for (const k of Object.keys(mIn)) ps.margins[k] = clamp(parseFloat(mIn[k].value) || 0, 0, 4);
    this.defaults.font = fontSel.value;
    this.defaults.size = parseFloat(sizeIn.value) || 11;
    this.defaults.lineHeight = +((parseFloat(lhIn.value) || 1) * LH_FACTOR).toFixed(3);
    this.defaults.spaceAfter = parseFloat(afterIn.value) || 0;
    this.applyDefaults();
    this.applyPageSetup();
    this.markDirty();
  }

  wordCount() {
    const t = this.body.innerText;
    const sel = getSelection().toString();
    const row = (a, b, c) => h('tr', {}, h('td', {}, a), h('td', {}, b), h('td', { class: 'faint' }, c));
    modal({
      title: 'Word count',
      body: h('table', { class: 'shortcut-table' },
        row('', h('b', {}, 'Document'), sel ? 'Selection' : ''),
        row('Pages', String(this.pageCount), ''),
        row('Words', countWords(t).toLocaleString(), sel ? countWords(sel).toLocaleString() : ''),
        row('Characters', t.replace(/\n/g, '').length.toLocaleString(), sel ? sel.length.toLocaleString() : ''),
        row('Characters (no spaces)', t.replace(/\s/g, '').length.toLocaleString(), ''),
        row('Paragraphs', String($$('p,h1,h2,h3,h4,h5,h6,li', this.body).filter((p) => p.textContent.trim()).length), ''),
        row('Reading time', Math.max(1, Math.round(countWords(t) / 230)) + ' min', '')),
    });
  }

  // =================================================================== status

  status() {
    const words = countWords(this.body.innerText || '');
    const sel = getSelection();
    const selText = sel.rangeCount && this.body.contains(sel.anchorNode) ? sel.toString() : '';
    const link = this.anchorElement()?.closest('a[href]');
    return {
      left: [
        this.pageSetup.pageless
          ? { text: 'pageless', icon: 'pageless', action: () => this.togglePageless(false), title: 'Click to turn pages back on' }
          : { text: `page ${this.currentPage()} of ${this.pageCount}`, icon: 'pages', action: (e, el) => showMenu(this.pagesMenu(), { anchor: el }), title: 'Page options' },
        { text: `${words.toLocaleString()} words${selText ? ` · ${countWords(selText)} selected` : ''}`, action: () => this.wordCount() },
        ...(link ? [{ text: link.getAttribute('href'), icon: 'link', title: 'Ctrl+click to open' }] : []),
      ],
      right: [
        { text: (PAGE_SIZES[this.pageSetup.size]?.label.split(' · ')[0] || 'Custom') + (this.pageSetup.orientation === 'landscape' ? ' ⟲' : ''), action: () => this.pageSetupDialog(), title: 'Page setup' },
        { text: `${this.defaults.font} ${this.defaults.size}pt`, title: 'Document default font' },
        { text: Math.round(this.scale * 100) + '%', action: (e, el) => showMenu(ZOOMS.map((z) => ({ label: Math.round(z * 100) + '%', checked: Math.abs(z - this.scale) < 0.001, action: () => { this.scale = z; this.fitCanvas(); if (this.zoomSel) this.zoomSel.value = String(z); this.refreshStatus(); } })).concat([{ sep: true }, { label: 'Fit width', action: () => this.zoom('fit') }]), { anchor: el }) },
      ],
    };
  }

  // =================================================================== io

  saveFormats() {
    return [
      { ext: 'docx', name: 'Word document' },
      { ext: 'html', name: 'Web page' },
      { ext: 'md', name: 'Markdown' },
      { ext: 'rtf', name: 'Rich Text Format' },
      { ext: 'txt', name: 'Plain text' },
    ];
  }

  lossyFormat(ext) { return ext === 'txt' || ext === 'md'; }

  exportTargets() {
    return [
      { label: 'PDF (.pdf)', icon: 'file-pdf', run: () => this.exportPdf() },
      { label: 'Image (.png / .jpg)…', icon: 'image-down', run: () => this.exportImageDialog() },
    ];
  }

  cleanHtml() {
    const clone = this.body.cloneNode(true);
    for (const el of clone.querySelectorAll('[contenteditable]')) el.removeAttribute('contenteditable');
    const w = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) if (w.currentNode.data.includes('​')) w.currentNode.data = w.currentNode.data.replace(/​/g, '');
    return clone.innerHTML;
  }

  standaloneHtml({ forPrint = false } = {}) {
    const vars = `--doc-font:${fontStack(this.defaults.font)};--doc-size:${this.defaults.size}pt;--doc-lh:${this.defaults.lineHeight};--doc-after:${this.defaults.spaceAfter}pt;`;
    const title = escapeHtml(stripExt(this.tab.title));
    const d = pageDims(this.pageSetup);
    const m = this.pageSetup.margins;
    const screen = forPrint ? '' : `@media screen { body { background: #ece9f1; } .doc-body { max-width: ${d.w - m.left - m.right}in; margin: 32px auto; background: #fff; padding: ${m.top}in ${m.right}in ${m.bottom}in ${m.left}in; box-shadow: 0 2px 14px rgba(0,0,0,.12); } .page-break { border-top: 1px dashed #c9c3d6; margin: 18px 0; } }`;
    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="generator" content="Box-DocSpitter"><title>${title}</title>
<style>${docContentCss('.doc-body')}
${printCss(this.pageSetup)}
${screen}</style></head>
<body><div class="doc-body" style="${vars}">${this.cleanHtml()}</div></body></html>`;
  }

  async serialize(ext) {
    if (this.pageSheet) this.pageSheet.disabled = true;
    try { return await this.serializeRaw(ext); } finally { if (this.pageSheet) this.pageSheet.disabled = false; }
  }

  async serializeRaw(ext) {
    if (ext === 'html' || ext === 'htm') return this.standaloneHtml();
    if (ext === 'md') return htmlToMarkdown(this.body);
    if (ext === 'txt') return this.body.innerText.replace(/​/g, '').replace(/\n/g, '\r\n');
    if (ext === 'rtf') { const { exportRtf } = await import('./doc/rtf.js'); return exportRtf(this.body, this.defaults); }
    const { exportDocx } = await import('./doc/docx-export.js');
    return exportDocx(this);
  }

  async exportPdf() {
    const pdf = await api.printPdf(this.standaloneHtml({ forPrint: true }));
    await this.app.saveBytesAs(pdf, { defaultName: stripExt(this.tab.title) + '.pdf', filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
  }

  print() {
    const frame = h('iframe', { style: { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' } });
    document.body.append(frame);
    frame.srcdoc = this.standaloneHtml({ forPrint: true });
    frame.onload = () => {
      setTimeout(() => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        setTimeout(() => frame.remove(), 1000);
      }, 150);
    };
  }

  getDraft() { return JSON.stringify({ html: this.cleanHtml(), page: this.pageSetup, defaults: this.defaults }); }

  restoreDraft(content) {
    try {
      const d = JSON.parse(content);
      this.body.innerHTML = d.html || '<p><br></p>';
      if (d.page) this.pageSetup = d.page;
      if (d.defaults) this.defaults = d.defaults;
    } catch { this.body.innerHTML = content || '<p><br></p>'; }
    this.applyDefaults();
    this.applyPageSetup();
    this.contentChanged({ silent: true });
  }

  setHTML(html, { fromHtmlFile = false } = {}) {
    this.checkpoint();
    this.body.innerHTML = sanitizeHtml(html);
    this.contentChanged();
  }

  setPlainText(text) {
    this.checkpoint();
    this.body.innerHTML = textToHtml(text);
    this.contentChanged();
  }

  afterSave() { /* saved */ }

  insertText(text) { this.exec('insertText', text); }

  getSelectionText() {
    const s = getSelection();
    if (s.rangeCount && this.body.contains(s.anchorNode) && !s.isCollapsed) return s.toString();
    return this.savedRange && !this.savedRange.collapsed && this.body.contains(this.savedRange.startContainer) ? this.savedRange.toString() : '';
  }

  getContextText() { return this.body.innerText; }

  async insertMarkdown(md) {
    const marked = await vendor.marked();
    let html = sanitizeHtml(marked.parse(md, { gfm: true }));
    const one = /^<p>([\s\S]*)<\/p>$/.exec(html);
    if (one && !one[1].includes('<p>')) html = one[1];
    this.exec('insertHTML', html);
  }

  replaceSelection(text) { return this.insertMarkdown(text); }

  focus() {
    if (document.activeElement === this.body) return;
    this.body.focus({ preventScroll: true });
    if (this.savedRange && this.body.contains(this.savedRange.startContainer)) {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(this.savedRange);
    }
  }

  selectAll() { this.body.focus(); this.placeCaret(this.body); const r = document.createRange(); r.selectNodeContents(this.body); getSelection().removeAllRanges(); getSelection().addRange(r); }

  async pasteFromClipboard(plain) {
    this.restoreSel();
    try {
      if (!plain && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          if (it.types.includes('text/html')) { const html = await (await it.getType('text/html')).text(); this.exec('insertHTML', sanitizeHtml(html)); return; }
          const img = it.types.find((t) => t.startsWith('image/'));
          if (img) { this.insertImage(await blobToDataURL(await it.getType(img))); return; }
        }
      }
      const text = await navigator.clipboard.readText();
      this.exec('insertText', text);
    } catch { toast('Use Ctrl+V to paste (clipboard access was blocked).', { type: 'warn' }); }
  }

  onShow() { requestAnimationFrame(() => { this.fitCanvas(); this.layoutPages(); }); }

  onThemeChange() {
    const s = this.app.settings;
    this.paper.classList.toggle('night', s.paper === 'night');
    this.body.spellcheck = s.spellcheck !== false;
  }

  destroy() {
    document.removeEventListener('selectionchange', this.selHandler);
    this.ro?.disconnect();
    this.scrollRo?.disconnect();
    this.pageSheet?.remove();
    this.dumps?.destroy();
    if (typeof Highlight !== 'undefined' && CSS.highlights) { CSS.highlights.delete('bds-find'); CSS.highlights.delete('bds-find-current'); }
  }
}

Object.assign(DocEditor.prototype, PageTools);
