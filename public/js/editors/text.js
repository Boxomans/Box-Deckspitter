// Text mode — a clean notepad for .txt, .log and friends.

import { BaseEditor } from './base.js';
import { h, clear, decodeText, encodeText, detectEol, countWords, debounce, clamp, escapeHtml } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { tbButton, tbSep, tbSelect, FindBar, buildRegex, showMenu, promptDialog, toast, modal } from '../core/ui.js';
import { api } from '../core/api.js';

const FONTS = {
  mono: "'IBM Plex Mono', Consolas, monospace",
  sans: "'Inter', 'Segoe UI', sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
};
const ENCODINGS = [['utf-8', false, 'UTF-8'], ['utf-8', true, 'UTF-8 with BOM'], ['utf-16le', true, 'UTF-16 LE'], ['utf-16be', true, 'UTF-16 BE'], ['windows-1252', false, 'Windows-1252 (ANSI)']];

export class TextEditor extends BaseEditor {
  static mode = 'text';

  async load(bytes, opts = {}) {
    const dec = bytes ? decodeText(bytes) : { text: '', encoding: 'utf-8', bom: false };
    this.encoding = dec.encoding;
    this.bom = dec.bom;
    this.eol = dec.text ? detectEol(dec.text) : '\r\n';
    const text = dec.text.replace(/\r\n?/g, '\n');
    const s = this.app.settings;
    this.wrap = true;
    this.lineNumbers = false;
    this.font = s.textFont || 'mono';
    this.fontSize = s.textFontSize || 14;
    this.matches = [];
    this.matchIndex = -1;

    this.ta = h('textarea', { class: 'text-area', spellcheck: s.spellcheck !== false && this.font !== 'mono' ? 'true' : 'false', wrap: 'soft' });
    this.ta.value = text;
    this.mirror = h('div', { class: 'text-mirror', 'aria-hidden': 'true' });
    this.gutter = h('pre', { class: 'text-gutter', 'aria-hidden': 'true' });
    this.sheet = h('div', { class: 'text-sheet' }, this.gutter, h('div', { class: 'text-field' }, this.mirror, this.ta));
    this.root = h('div', { class: 'text-root' }, this.sheet);
    this.pane.append(this.root);
    this.findHost = this.root;

    this.ta.addEventListener('input', () => {
      this.markDirty();
      this.updateStatusSoon();
      if (this.lineNumbers) this.renderGutter();
      if (this.findBar?.isOpen && this.matches.length) this.refreshFindSoon();
    });
    for (const ev of ['keyup', 'click', 'select']) this.ta.addEventListener(ev, () => this.updateStatusSoon());
    this.ta.addEventListener('scroll', () => this.syncScroll());
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    this.updateStatusSoon = debounce(() => this.refreshStatus(), 120);
    this.refreshFindSoon = debounce(() => this.findBar?.run(), 250);
    this.applyLook();
    if (opts.draft != null) this.restoreDraft(opts.draft);
  }

  applyLook() {
    const s = this.app.settings;
    this.font = s.textFont || this.font;
    const style = { fontFamily: FONTS[this.font] || FONTS.mono, fontSize: this.fontSize + 'px' };
    Object.assign(this.ta.style, style);
    Object.assign(this.mirror.style, style);
    Object.assign(this.gutter.style, { fontFamily: FONTS.mono, fontSize: this.fontSize * 0.86 + 'px', lineHeight: this.fontSize * 1.6 + 'px' });
    this.ta.style.lineHeight = this.mirror.style.lineHeight = this.fontSize * 1.6 + 'px';
    this.ta.setAttribute('wrap', this.wrap ? 'soft' : 'off');
    this.root.classList.toggle('nowrap', !this.wrap);
    this.root.classList.toggle('with-gutter', this.lineNumbers);
    this.ta.spellcheck = s.spellcheck !== false && this.font !== 'mono';
    if (this.lineNumbers) this.renderGutter();
    this.syncScroll();
    this.refreshStatus?.();
  }

  onThemeChange() { this.applyLook(); }

  onKey(e) {
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '\t');
    } else if (e.key === 'F5') {
      e.preventDefault();
      this.insertDate();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      this.goToLine();
    } else if (e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      this.toggleWrap();
    }
  }

  // ------------------------------------------------------------------ toolbar & menus

  buildToolbar() {
    this.wrapBtn = tbButton('wrap', 'Word wrap', () => this.toggleWrap(), { key: 'Alt+Z' });
    this.numBtn = tbButton('list-ordered', 'Line numbers', () => this.toggleLineNumbers());
    this.wrapBtn.classList.toggle('active', this.wrap);
    const fontSel = tbSelect([{ value: 'mono', label: 'Monospace' }, { value: 'sans', label: 'Sans' }, { value: 'serif', label: 'Serif' }],
      (v) => { this.app.settings.textFont = v; this.app.saveSettings({ textFont: v }); this.applyLook(); }, { tip: 'Font', value: this.font, width: '112px' });
    this.sizeLabel = h('span', { class: 'tb-label' }, this.fontSize + 'px');
    return h('div', { class: 'toolbar' },
      tbButton('undo', 'Undo', () => this.undo(), { key: 'Ctrl+Z' }),
      tbButton('redo', 'Redo', () => this.redo(), { key: 'Ctrl+Y' }),
      tbSep(),
      tbButton('search', 'Find', () => this.find(false), { key: 'Ctrl+F' }),
      tbButton('replace', 'Replace', () => this.find(true), { key: 'Ctrl+H' }),
      tbSep(),
      fontSel,
      tbButton('minus', 'Smaller text', () => this.zoom(-1)),
      this.sizeLabel,
      tbButton('plus', 'Larger text', () => this.zoom(+1)),
      tbSep(),
      this.wrapBtn, this.numBtn,
      tbSep(),
      tbButton('type', 'Change case', (e) => showMenu(this.caseItems(), { anchor: e.currentTarget })),
      tbButton('sort', 'Line tools', (e) => showMenu(this.lineItems(), { anchor: e.currentTarget })),
      tbButton('calendar', 'Insert date & time', () => this.insertDate(), { key: 'F5' }),
      tbSep(),
      tbButton('file-doc', 'Open as rich document', () => this.toDocument(), { text: 'To document' }),
    );
  }

  caseItems() {
    return [
      { label: 'UPPERCASE', action: () => this.transformSel((s) => s.toUpperCase()) },
      { label: 'lowercase', action: () => this.transformSel((s) => s.toLowerCase()) },
      { label: 'Title Case', action: () => this.transformSel((s) => s.toLowerCase().replace(/(^|[\s\-_(["'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())) },
      { label: 'Sentence case', action: () => this.transformSel((s) => s.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (m, a, b) => a + b.toUpperCase())) },
      { label: 'tOGGLE cASE', action: () => this.transformSel((s) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('')) },
    ];
  }

  lineItems() {
    const lines = (fn) => () => this.transformSel((s) => fn(s.split('\n')).join('\n'), true);
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return [
      { label: 'Sort lines A → Z', action: lines((l) => l.sort(coll.compare)) },
      { label: 'Sort lines Z → A', action: lines((l) => l.sort(coll.compare).reverse()) },
      { label: 'Reverse line order', action: lines((l) => l.reverse()) },
      { label: 'Remove duplicate lines', action: lines((l) => [...new Set(l)]) },
      { label: 'Remove empty lines', action: lines((l) => l.filter((x) => x.trim())) },
      { label: 'Trim trailing whitespace', action: lines((l) => l.map((x) => x.replace(/[ \t]+$/, ''))) },
      { label: 'Join lines', action: () => this.transformSel((s) => s.split('\n').map((x) => x.trim()).filter(Boolean).join(' '), true) },
      { sep: true },
      { label: 'Tabs → spaces', action: () => this.transformSel((s) => s.replace(/\t/g, '    '), true) },
      { label: 'Leading spaces → tabs', action: lines((l) => l.map((x) => x.replace(/^( {4})+/, (m) => '\t'.repeat(m.length / 4)))) },
    ];
  }

  menus() {
    return {
      edit: [
        { label: 'Go to line…', shortcut: 'Ctrl+G', action: () => this.goToLine() },
        { label: 'Insert date & time', icon: 'calendar', shortcut: 'F5', action: () => this.insertDate() },
        { label: 'Change case', icon: 'type', submenu: () => this.caseItems() },
        { label: 'Lines', icon: 'sort', submenu: () => this.lineItems() },
      ],
      view: [
        { label: 'Word wrap', icon: 'wrap', shortcut: 'Alt+Z', checked: this.wrap, action: () => this.toggleWrap() },
        { label: 'Line numbers', icon: 'list-ordered', checked: this.lineNumbers, action: () => this.toggleLineNumbers() },
      ],
      tools: [
        { label: 'Word count…', action: () => this.wordCount() },
        { label: 'Encoding', submenu: () => this.encodingItems() },
        { label: 'Line endings', submenu: () => this.eolItems() },
        { sep: true },
        { label: 'Open as rich document', icon: 'file-doc', action: () => this.toDocument() },
        { label: 'Open in code editor', icon: 'file-code', action: () => this.toCode() },
      ],
    };
  }

  encodingItems() {
    return ENCODINGS.map(([enc, bom, label]) => ({
      label, checked: this.encoding === enc && !!this.bom === bom,
      action: () => { this.encoding = enc; this.bom = bom; this.markDirty(); this.refreshStatus(); },
    }));
  }

  eolItems() {
    return [['\r\n', 'Windows (CRLF)'], ['\n', 'Unix / macOS (LF)']].map(([e, l]) => ({
      label: l, checked: this.eol === e, action: () => { this.eol = e; this.markDirty(); this.refreshStatus(); },
    }));
  }

  // ------------------------------------------------------------------ actions

  transformSel(fn, wholeLines = false) {
    const ta = this.ta;
    let { selectionStart: a, selectionEnd: b } = ta;
    if (a === b) { a = 0; b = ta.value.length; }
    else if (wholeLines) {
      a = ta.value.lastIndexOf('\n', a - 1) + 1;
      const nl = ta.value.indexOf('\n', b - (ta.value[b - 1] === '\n' ? 1 : 0));
      b = nl < 0 ? ta.value.length : nl;
    }
    const out = fn(ta.value.slice(a, b));
    ta.focus();
    ta.setSelectionRange(a, b);
    document.execCommand('insertText', false, out);
    ta.setSelectionRange(a, a + out.length);
  }

  insertDate() {
    this.ta.focus();
    const d = new Date();
    document.execCommand('insertText', false, d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' ' + d.toLocaleDateString());
  }

  async goToLine() {
    const total = this.ta.value.split('\n').length;
    const v = await promptDialog('Go to line', `Line number (1–${total})`, '');
    const n = parseInt(v, 10);
    if (!n) return;
    const lines = this.ta.value.split('\n');
    const line = clamp(n, 1, lines.length);
    let pos = 0;
    for (let i = 0; i < line - 1; i++) pos += lines[i].length + 1;
    this.ta.focus();
    this.ta.setSelectionRange(pos, pos);
    this.scrollToOffset(pos);
    this.refreshStatus();
  }

  toggleWrap() {
    this.wrap = !this.wrap;
    if (this.wrap && this.lineNumbers) this.lineNumbers = false;
    this.wrapBtn?.classList.toggle('active', this.wrap);
    this.numBtn?.classList.toggle('active', this.lineNumbers);
    this.applyLook();
  }

  toggleLineNumbers() {
    this.lineNumbers = !this.lineNumbers;
    if (this.lineNumbers && this.wrap) { this.wrap = false; toast('Word wrap turned off so line numbers line up.', { timeout: 2500 }); }
    this.wrapBtn?.classList.toggle('active', this.wrap);
    this.numBtn?.classList.toggle('active', this.lineNumbers);
    this.applyLook();
  }

  renderGutter() {
    const n = this.ta.value.split('\n').length;
    if (n === this._gutterN) return;
    this._gutterN = n;
    let s = '';
    for (let i = 1; i <= n; i++) s += i + '\n';
    this.gutter.textContent = s;
  }

  syncScroll() {
    this.mirror.scrollTop = this.ta.scrollTop;
    this.mirror.scrollLeft = this.ta.scrollLeft;
    this.gutter.style.transform = `translateY(${-this.ta.scrollTop}px)`;
  }

  wordCount() {
    const t = this.ta.value;
    const sel = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
    const row = (a, b, c) => h('tr', {}, h('td', {}, a), h('td', {}, b), h('td', { class: 'faint' }, c));
    modal({
      title: 'Word count',
      body: h('table', { class: 'shortcut-table' },
        row('', h('b', {}, 'Document'), sel ? 'Selection' : ''),
        row('Words', countWords(t).toLocaleString(), sel ? countWords(sel).toLocaleString() : ''),
        row('Characters', t.length.toLocaleString(), sel ? sel.length.toLocaleString() : ''),
        row('Characters (no spaces)', t.replace(/\s/g, '').length.toLocaleString(), ''),
        row('Lines', t.split('\n').length.toLocaleString(), sel ? sel.split('\n').length : ''),
        row('Reading time', Math.max(1, Math.round(countWords(t) / 230)) + ' min', '')),
    });
  }

  toDocument() {
    const text = this.ta.value;
    this.app.newDocument('doc').then((tab) => {
      if (!tab?.editor) return;
      tab.editor.setPlainText(text);
      this.app.setTabMeta(tab, { title: this.tab.title.replace(/\.[^.]+$/, '') });
    });
  }

  toCode() {
    if (this.tab.path) this.app.reopenAs(this.tab, 'code');
    else toast('Save the file first, then reopen it in the code editor.', { type: 'warn' });
  }

  // ------------------------------------------------------------------ find

  find(replace) {
    if (!this.findBar) this.findBar = new FindBar(this.root, this.findProvider());
    const sel = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
    this.findBar.open(replace, sel && !sel.includes('\n') ? sel : undefined);
  }

  findProvider() {
    const self = this;
    return {
      canReplace: true,
      find(q, opts) {
        self.lastQuery = { q, opts };
        const re = buildRegex(q, opts);
        self.matches = [];
        const text = self.ta.value;
        let m;
        while ((m = re.exec(text)) && self.matches.length < 20000) {
          if (m[0].length === 0) { re.lastIndex++; continue; }
          self.matches.push([m.index, m.index + m[0].length]);
        }
        const caret = self.ta.selectionStart;
        self.matchIndex = self.matches.length ? Math.max(0, self.matches.findIndex((x) => x[0] >= caret)) : -1;
        if (self.matchIndex < 0 && self.matches.length) self.matchIndex = 0;
        self.showMatch();
        return { count: self.matches.length, index: self.matchIndex };
      },
      next() { return self.step(1); },
      prev() { return self.step(-1); },
      replace(r) {
        const cur = self.matches[self.matchIndex];
        if (!cur) return { count: 0, index: -1 };
        const active = document.activeElement;
        const { q, opts } = self.lastQuery;
        const piece = self.ta.value.slice(cur[0], cur[1]);
        const repl = opts.regex ? piece.replace(buildRegex(q, opts), r) : r;
        self.ta.focus();
        self.ta.setSelectionRange(cur[0], cur[1]);
        document.execCommand('insertText', false, repl);
        self.ta.setSelectionRange(cur[0] + repl.length, cur[0] + repl.length);
        active?.focus();
        return this.find(q, opts);
      },
      replaceAll(r) {
        const { q, opts } = self.lastQuery || {};
        if (!q) return 0;
        const re = buildRegex(q, opts);
        const n = (self.ta.value.match(re) || []).length;
        if (!n) return 0;
        const out = self.ta.value.replace(re, opts.regex ? r : () => r);
        self.ta.focus();
        self.ta.select();
        document.execCommand('insertText', false, out);
        return n;
      },
      clear() { self.matches = []; self.matchIndex = -1; clear(self.mirror); self.root.classList.remove('finding'); },
      onClose() { self.ta.focus(); },
    };
  }

  step(dir) {
    if (!this.matches.length) return { count: 0, index: -1 };
    this.matchIndex = (this.matchIndex + dir + this.matches.length) % this.matches.length;
    this.showMatch();
    return { count: this.matches.length, index: this.matchIndex };
  }

  showMatch() {
    const text = this.ta.value;
    this.root.classList.toggle('finding', this.matches.length > 0);
    if (!this.matches.length) { clear(this.mirror); return; }
    // Render highlight layer (only a window around matches would be faster, but this is fine for typical files).
    let html = '';
    let last = 0;
    const limit = Math.min(this.matches.length, 5000);
    for (let i = 0; i < limit; i++) {
      const [a, b] = this.matches[i];
      html += escapeHtml(text.slice(last, a)) + `<mark${i === this.matchIndex ? ' class="cur"' : ''}>${escapeHtml(text.slice(a, b))}</mark>`;
      last = b;
    }
    html += escapeHtml(text.slice(last)) + '\n';
    this.mirror.innerHTML = html;
    const cur = this.matches[this.matchIndex];
    this.ta.setSelectionRange(cur[0], cur[1]);
    const mark = this.mirror.querySelector('mark.cur');
    if (mark) {
      const top = mark.offsetTop - this.ta.clientHeight / 3;
      this.ta.scrollTop = Math.max(0, top);
      if (!this.wrap) this.ta.scrollLeft = Math.max(0, mark.offsetLeft - this.ta.clientWidth / 2);
    }
    this.syncScroll();
  }

  scrollToOffset(pos) {
    const before = this.ta.value.slice(0, pos);
    this.mirror.innerHTML = escapeHtml(before) + '<mark class="probe"></mark>';
    const m = this.mirror.querySelector('mark');
    this.ta.scrollTop = Math.max(0, m.offsetTop - this.ta.clientHeight / 3);
    clear(this.mirror);
    this.syncScroll();
  }

  // ------------------------------------------------------------------ status & io

  status() {
    const v = this.ta.value;
    const pos = this.ta.selectionStart;
    const before = v.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    const selLen = Math.abs(this.ta.selectionEnd - this.ta.selectionStart);
    const encLabel = ENCODINGS.find(([e, b]) => e === this.encoding && !!b === !!this.bom)?.[2] || this.encoding;
    return {
      left: [
        { text: `Ln ${line}, Col ${col}${selLen ? ` (${selLen} selected)` : ''}` },
        { text: `${countWords(v).toLocaleString()} words` },
        { text: `${v.length.toLocaleString()} chars` },
      ],
      right: [
        { text: encLabel, title: 'Encoding', action: (e, el) => showMenu(this.encodingItems(), { anchor: el }) },
        { text: this.eol === '\r\n' ? 'CRLF' : 'LF', title: 'Line endings', action: (e, el) => showMenu(this.eolItems(), { anchor: el }) },
        { text: this.wrap ? 'wrap' : 'no wrap', action: () => this.toggleWrap() },
        { text: this.fontSize + 'px', title: 'Text size', action: () => this.zoom(0) },
      ],
    };
  }

  zoom(delta) {
    this.fontSize = delta === 0 ? 14 : clamp(this.fontSize + delta, 9, 40);
    if (this.sizeLabel) this.sizeLabel.textContent = this.fontSize + 'px';
    this._gutterN = 0;
    this.applyLook();
    this.refreshStatus();
  }

  saveFormats() {
    const ext = this.tab.ext && this.tab.ext !== 'txt' ? [{ ext: this.tab.ext, name: `${this.tab.ext.toUpperCase()} file` }] : [];
    return [...ext, { ext: 'txt', name: 'Text file' }, { ext: 'md', name: 'Markdown' }, { ext: 'log', name: 'Log file' }];
  }

  async serialize() {
    const text = this.eol === '\r\n' ? this.ta.value.replace(/\n/g, '\r\n') : this.ta.value;
    return encodeText(text, this.encoding, this.bom);
  }

  getDraft() { return this.ta.value; }
  restoreDraft(content) { this.ta.value = content || ''; this.refreshStatus(); }
  setText(t) { this.ta.value = t; }
  insertText(t) { this.ta.focus(); document.execCommand('insertText', false, t); }
  getSelectionText() { return this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd); }
  getContextText() { return this.ta.value; }
  replaceSelection(t) { this.insertText(t); }
  gotoLine(line, col = 1) {
    const lines = this.ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
    pos += col - 1;
    this.ta.focus();
    this.ta.setSelectionRange(pos, pos);
    this.scrollToOffset(pos);
    this.refreshStatus();
  }

  undo() { this.ta.focus(); document.execCommand('undo'); }
  redo() { this.ta.focus(); document.execCommand('redo'); }
  focus() { this.ta.focus({ preventScroll: true }); }
  selectAll() { this.ta.select(); }

  print() {
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return toast('Allow pop-ups to print.', { type: 'warn' });
    w.document.write(`<!doctype html><title>${escapeHtml(this.tab.title)}</title><style>body{margin:0}pre{font:11pt/1.45 Consolas,monospace;white-space:pre-wrap;word-wrap:break-word;margin:0}@page{margin:18mm}</style><pre>${escapeHtml(this.ta.value)}</pre>`);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 200);
  }

  exportTargets() {
    return [{
      label: 'PDF (.pdf)', icon: 'file-pdf',
      run: async () => {
        const html = `<!doctype html><meta charset="utf-8"><style>@page{size:Letter;margin:0.8in}body{margin:0}pre{font:10.5pt/1.5 Consolas,'Courier New',monospace;white-space:pre-wrap;word-wrap:break-word;margin:0}</style><pre>${escapeHtml(this.ta.value)}</pre>`;
        const pdf = await api.printPdf(html);
        await this.app.saveBytesAs(pdf, { defaultName: this.tab.title.replace(/\.[^.]+$/, '') + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      },
    }];
  }
}
