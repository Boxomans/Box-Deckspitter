// Code mode — Monaco editor for config files, HTML, Markdown and source code, with live preview.

import { BaseEditor } from './base.js';
import { h, clear, decodeText, encodeText, detectEol, debounce, clamp, dirname, vendor, escapeHtml, stripExt } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { tbButton, tbSep, tbSelect, showMenu, toast, errorToast } from '../core/ui.js';
import { LANGUAGES, langForName } from '../core/filetypes.js';
import { api } from '../core/api.js';

let monacoPromise = null;

export function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    const base = `${location.origin}/vendor/monaco-editor/min`;
    window.MonacoEnvironment = {
      getWorkerUrl() {
        return URL.createObjectURL(new Blob([`self.MonacoEnvironment={baseUrl:'${base}/'};importScripts('${base}/vs/base/worker/workerMain.js');`], { type: 'text/javascript' }));
      },
    };
    const s = document.createElement('script');
    s.src = '/vendor/monaco-editor/min/vs/loader.js';
    s.onload = () => {
      window.require.config({ paths: { vs: '/vendor/monaco-editor/min/vs' } });
      window.require(['vs/editor/editor.main'], () => { defineThemes(window.monaco); resolve(window.monaco); }, reject);
    };
    s.onerror = () => reject(new Error('Could not load the code editor'));
    document.head.append(s);
  });
  return monacoPromise;
}

function defineThemes(monaco) {
  const shared = [
    { token: 'comment', fontStyle: 'italic' },
  ];
  monaco.editor.defineTheme('bds-dark', {
    base: 'vs-dark', inherit: true,
    rules: [
      ...shared,
      { token: 'comment', foreground: '6e6483', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c7a6ff' },
      { token: 'keyword.json', foreground: 'c7a6ff' },
      { token: 'string', foreground: 'f7a8d8' },
      { token: 'string.key.json', foreground: 'c7a6ff' },
      { token: 'string.value.json', foreground: 'f7a8d8' },
      { token: 'number', foreground: '6ee7e0' },
      { token: 'regexp', foreground: '6ee7e0' },
      { token: 'type', foreground: '9cc2ff' },
      { token: 'type.identifier', foreground: '9cc2ff' },
      { token: 'tag', foreground: 'c7a6ff' },
      { token: 'metatag', foreground: 'b0a6c4' },
      { token: 'attribute.name', foreground: '6ee7e0' },
      { token: 'attribute.value', foreground: 'f7a8d8' },
      { token: 'delimiter', foreground: '9d93b3' },
      { token: 'key', foreground: 'c7a6ff' },
      { token: 'variable', foreground: 'e7e1f3' },
      { token: 'variable.predefined', foreground: '9cc2ff' },
      { token: 'constant', foreground: '6ee7e0' },
    ],
    colors: {
      'editor.background': '#0d0a13',
      'editor.foreground': '#e7e1f3',
      'editorLineNumber.foreground': '#433a58',
      'editorLineNumber.activeForeground': '#b48cff',
      'editorCursor.foreground': '#ff7ac6',
      'editor.selectionBackground': '#b48cff38',
      'editor.inactiveSelectionBackground': '#b48cff1f',
      'editor.selectionHighlightBackground': '#b48cff1a',
      'editor.lineHighlightBackground': '#ffffff05',
      'editor.lineHighlightBorder': '#00000000',
      'editor.findMatchBackground': '#ff7ac655',
      'editor.findMatchHighlightBackground': '#b48cff33',
      'editorIndentGuide.background1': '#ffffff0b',
      'editorIndentGuide.activeBackground1': '#b48cff40',
      'editorBracketMatch.background': '#b48cff22',
      'editorBracketMatch.border': '#b48cff66',
      'editorWidget.background': '#1c1726',
      'editorWidget.border': '#352c49',
      'editorSuggestWidget.background': '#1c1726',
      'editorSuggestWidget.selectedBackground': '#b48cff2e',
      'editorHoverWidget.background': '#1c1726',
      'input.background': '#15111d',
      'input.border': '#352c49',
      'focusBorder': '#b48cff88',
      'minimap.background': '#0d0a13',
      'scrollbarSlider.background': '#2c244088',
      'scrollbarSlider.hoverBackground': '#3d3358aa',
      'editorGutter.background': '#0d0a13',
      'editorOverviewRuler.border': '#00000000',
    },
  });
  monaco.editor.defineTheme('bds-light', {
    base: 'vs', inherit: true,
    rules: [
      { token: 'comment', foreground: '8d84a0', fontStyle: 'italic' },
      { token: 'keyword', foreground: '7a4fd6' },
      { token: 'string', foreground: 'c2367f' },
      { token: 'string.key.json', foreground: '7a4fd6' },
      { token: 'string.value.json', foreground: 'c2367f' },
      { token: 'number', foreground: '0f8580' },
      { token: 'tag', foreground: '7a4fd6' },
      { token: 'attribute.name', foreground: '0f8580' },
      { token: 'attribute.value', foreground: 'c2367f' },
      { token: 'key', foreground: '7a4fd6' },
    ],
    colors: {
      'editor.background': '#fbf9fe',
      'editorLineNumber.foreground': '#c0b6d2',
      'editorLineNumber.activeForeground': '#7a4fd6',
      'editorCursor.foreground': '#d6439a',
      'editor.selectionBackground': '#7a4fd630',
      'editor.lineHighlightBackground': '#7a4fd608',
      'minimap.background': '#fbf9fe',
    },
  });
}

const PREVIEWABLE = new Set(['html', 'markdown', 'svg']);

export class CodeEditor extends BaseEditor {
  static mode = 'code';
  handlesWheelZoom = false;

  async load(bytes, opts = {}) {
    const monaco = await loadMonaco();
    this.monaco = monaco;
    const dec = bytes ? decodeText(bytes) : { text: '', encoding: 'utf-8', bom: false };
    this.encoding = dec.encoding;
    this.bom = dec.bom;
    this.eol = dec.text ? detectEol(dec.text) : '\r\n';
    this.lang = opts.lang || this.tab.lang || langForName(this.tab.title);
    if (this.tab.ext === 'svg') this.lang = 'xml';
    this.fontSize = this.app.settings.codeFontSize || 13;

    this.editorHost = h('div', { class: 'code-editor' });
    this.frame = null;
    this.previewHost = h('div', { class: 'code-preview' });
    this.divider = h('div', { class: 'code-divider' });
    this.root = h('div', { class: 'code-root' }, this.editorHost, this.divider, this.previewHost);
    this.pane.append(this.root);

    this.model = monaco.editor.createModel(dec.text, this.lang);
    this.model.setEOL(this.eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    this.ed = monaco.editor.create(this.editorHost, {
      model: this.model,
      theme: this.app.settings.theme === 'light' ? 'bds-light' : 'bds-dark',
      automaticLayout: true,
      fontFamily: "'IBM Plex Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: this.fontSize,
      lineHeight: Math.round(this.fontSize * 1.6),
      minimap: { enabled: true, renderCharacters: false, scale: 1 },
      wordWrap: ['markdown', 'plaintext'].includes(this.lang) ? 'on' : 'off',
      smoothScrolling: true,
      cursorBlinking: 'phase',
      cursorSmoothCaretAnimation: 'on',
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active', indentation: true },
      scrollBeyondLastLine: false,
      padding: { top: 14, bottom: 14 },
      fixedOverflowWidgets: true,
      stickyScroll: { enabled: true },
      roundedSelection: true,
      linkedEditing: true,
    });
    this.savedVersion = this.model.getAlternativeVersionId();
    this.updatePreviewSoon = debounce(() => this.updatePreview(), 350);

    this.model.onDidChangeContent(() => {
      const dirty = this.model.getAlternativeVersionId() !== this.savedVersion;
      this.app.setDirty(this.tab, dirty);
      if (this.previewOn) this.updatePreviewSoon();
    });
    this.ed.onDidChangeCursorSelection(() => this.statusSoon());
    this.statusSoon = debounce(() => this.refreshStatus(), 100);
    this.markerSub = monaco.editor.onDidChangeMarkers((uris) => {
      if (uris.some((u) => u.toString() === this.model.uri.toString())) this.statusSoon();
    });

    this.wireDivider();
    this.previewOn = this.canPreview() && this.app.settings[`preview_${this.lang}`] !== false;
    this.setPreview(this.previewOn);
    if (opts.draft != null) this.restoreDraft(opts.draft);
  }

  canPreview() { return PREVIEWABLE.has(this.lang) || this.tab.ext === 'svg'; }

  wireDivider() {
    let dragging = false;
    this.divider.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); this.root.classList.add('resizing'); });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const r = this.root.getBoundingClientRect();
      const pct = clamp(((e.clientX - r.left) / r.width) * 100, 20, 80);
      this.editorHost.style.flexBasis = pct + '%';
    });
    window.addEventListener('mouseup', () => { if (dragging) { dragging = false; this.root.classList.remove('resizing'); } });
  }

  // ------------------------------------------------------------------ preview

  setPreview(on) {
    this.previewOn = on && this.canPreview();
    this.root.classList.toggle('with-preview', this.previewOn);
    this.previewBtn?.classList.toggle('active', this.previewOn);
    if (this.previewOn) this.updatePreview();
  }

  async previewBase() {
    if (!this.tab.path) return null;
    if (this._base && this._baseFor === this.tab.path) return this._base;
    try {
      const r = await api.previewRoot(dirname(this.tab.path));
      this._base = location.origin + r.base;
      this._baseFor = this.tab.path;
      return this._base;
    } catch { return null; }
  }

  async updatePreview() {
    if (!this.previewOn) return;
    const v = this.model.getValue();
    const base = await this.previewBase();
    const baseTag = base ? `<base href="${base}">` : '';
    if (this.lang === 'markdown') {
      const marked = await vendor.marked();
      const html = marked.parse(v, { gfm: true });
      if (!this.frame || this.frame.dataset.kind !== 'md') {
        clear(this.previewHost);
        this.frame = h('iframe', { class: 'code-frame', sandbox: 'allow-same-origin', dataset: { kind: 'md' }, title: 'Preview' });
        this.frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">${baseTag}<style>${markdownCss(this.app.settings.theme)}</style></head><body><article class="md"></article></body></html>`;
        this.previewHost.append(this.frame);
        await new Promise((r) => this.frame.addEventListener('load', r, { once: true }));
      }
      const doc = this.frame.contentDocument;
      const art = doc?.querySelector('article');
      if (art) {
        art.innerHTML = html;
        for (const a of art.querySelectorAll('a[href]')) a.target = '_blank';
      }
    } else {
      let html = v;
      if (this.tab.ext === 'svg' || (this.lang === 'xml' && /<svg[\s>]/i.test(v))) {
        html = `<!doctype html><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:repeating-conic-gradient(#0000000d 0 25%,transparent 0 50%) 0 0/20px 20px">${v}</body>`;
      } else if (baseTag) {
        html = /<head[^>]*>/i.test(v) ? v.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`) : baseTag + v;
      }
      if (!this.frame || this.frame.dataset.kind !== 'html') {
        clear(this.previewHost);
        this.frame = h('iframe', { class: 'code-frame light', sandbox: 'allow-scripts allow-forms allow-modals allow-popups', dataset: { kind: 'html' }, title: 'Preview' });
        this.previewHost.append(this.frame);
      }
      this.frame.srcdoc = html;
    }
  }

  // ------------------------------------------------------------------ toolbar & menus

  buildToolbar() {
    const langSel = tbSelect(LANGUAGES.map(([id, name]) => ({ value: id, label: name })), (v) => this.setLanguage(v), { tip: 'Language', value: this.lang, width: '150px' });
    this.langSel = langSel;
    if (!LANGUAGES.some(([id]) => id === this.lang)) langSel.prepend(h('option', { value: this.lang }, this.lang)), (langSel.value = this.lang);
    this.wrapBtn = tbButton('wrap', 'Word wrap', () => this.toggleWrap(), { key: 'Alt+Z' });
    this.wrapBtn.classList.toggle('active', this.ed.getOption(this.monaco.editor.EditorOption.wordWrap) !== 'off');
    this.mapBtn = tbButton('sidebar', 'Minimap', () => this.toggleMinimap());
    this.mapBtn.classList.add('active');
    this.previewBtn = tbButton('eye', 'Live preview', () => this.setPreview(!this.previewOn), { text: 'Preview' });
    this.previewBtn.classList.toggle('active', !!this.previewOn);
    this.previewBtn.hidden = !this.canPreview();
    this.docBtn = tbButton('file-doc', 'Edit visually in the document editor', () => this.toDocument(), { text: 'Visual edit' });
    this.docBtn.hidden = !['html', 'markdown'].includes(this.lang);
    return h('div', { class: 'toolbar' },
      tbButton('undo', 'Undo', () => this.undo(), { key: 'Ctrl+Z' }),
      tbButton('redo', 'Redo', () => this.redo(), { key: 'Ctrl+Y' }),
      tbSep(),
      tbButton('search', 'Find', () => this.find(false), { key: 'Ctrl+F' }),
      tbButton('replace', 'Replace', () => this.find(true), { key: 'Ctrl+H' }),
      tbSep(),
      tbButton('wand', 'Format document', () => this.format(), { key: 'Shift+Alt+F' }),
      tbButton('braces', 'Comment / uncomment', () => this.run('editor.action.commentLine'), { key: 'Ctrl+/' }),
      tbSep(),
      langSel,
      tbSep(),
      this.wrapBtn, this.mapBtn,
      tbButton('minus', 'Smaller text', () => this.zoom(-1)),
      tbButton('plus', 'Larger text', () => this.zoom(+1)),
      tbSep(),
      this.previewBtn, this.docBtn,
    );
  }

  menus() {
    const isJson = this.lang === 'json';
    return {
      edit: [
        { label: 'Go to line…', shortcut: 'Ctrl+G', action: () => this.run('editor.action.gotoLine') },
        { label: 'Command palette…', shortcut: 'F1', action: () => this.run('editor.action.quickCommand') },
        { label: 'Toggle comment', shortcut: 'Ctrl+/', action: () => this.run('editor.action.commentLine') },
        { label: 'Duplicate line', shortcut: 'Shift+Alt+↓', action: () => this.run('editor.action.copyLinesDownAction') },
        { label: 'Sort lines ascending', icon: 'sort', action: () => this.run('editor.action.sortLinesAscending') },
        { label: 'Trim trailing whitespace', action: () => this.run('editor.action.trimTrailingWhitespace') },
      ],
      view: [
        { label: 'Word wrap', icon: 'wrap', shortcut: 'Alt+Z', checked: this.ed.getOption(this.monaco.editor.EditorOption.wordWrap) !== 'off', action: () => this.toggleWrap() },
        { label: 'Minimap', icon: 'sidebar', checked: this.ed.getOption(this.monaco.editor.EditorOption.minimap).enabled, action: () => this.toggleMinimap() },
        { label: 'Live preview', icon: 'eye', disabled: !this.canPreview(), checked: this.previewOn, action: () => this.setPreview(!this.previewOn) },
        { label: 'Fold all', action: () => this.run('editor.foldAll') },
        { label: 'Unfold all', action: () => this.run('editor.unfoldAll') },
      ],
      tools: [
        { label: 'Format document', icon: 'wand', shortcut: 'Shift+Alt+F', action: () => this.format() },
        { label: 'Language', icon: 'code', submenu: () => LANGUAGES.map(([id, name]) => ({ label: name, checked: this.lang === id, action: () => this.setLanguage(id) })) },
        { label: 'Indentation', submenu: () => this.indentItems() },
        { label: 'Encoding', submenu: () => this.encodingItems() },
        { label: 'Line endings', submenu: () => this.eolItems() },
        ...(isJson ? [{ sep: true }, { label: 'Minify JSON', action: () => this.jsonTransform(0) }, { label: 'Pretty-print JSON', action: () => this.jsonTransform(2) }, { label: 'Sort JSON keys', action: () => this.jsonTransform(2, true) }] : []),
        ...(['html', 'markdown'].includes(this.lang) ? [{ sep: true }, { label: 'Edit visually in document editor', icon: 'file-doc', action: () => this.toDocument() }] : []),
      ],
    };
  }

  indentItems() {
    const o = this.model.getOptions();
    const set = (insertSpaces, tabSize) => () => { this.model.updateOptions({ insertSpaces, tabSize }); this.refreshStatus(); };
    return [
      { label: 'Spaces: 2', checked: o.insertSpaces && o.tabSize === 2, action: set(true, 2) },
      { label: 'Spaces: 4', checked: o.insertSpaces && o.tabSize === 4, action: set(true, 4) },
      { label: 'Tabs (width 4)', checked: !o.insertSpaces && o.tabSize === 4, action: set(false, 4) },
      { label: 'Tabs (width 8)', checked: !o.insertSpaces && o.tabSize === 8, action: set(false, 8) },
      { sep: true },
      { label: 'Convert indentation to spaces', action: () => this.run('editor.action.indentationToSpaces') },
      { label: 'Convert indentation to tabs', action: () => this.run('editor.action.indentationToTabs') },
    ];
  }

  encodingItems() {
    return [['utf-8', false, 'UTF-8'], ['utf-8', true, 'UTF-8 with BOM'], ['utf-16le', true, 'UTF-16 LE'], ['windows-1252', false, 'Windows-1252']].map(([e, b, l]) => ({
      label: l, checked: this.encoding === e && !!this.bom === b, action: () => { this.encoding = e; this.bom = b; this.markDirty(); this.refreshStatus(); },
    }));
  }

  eolItems() {
    const M = this.monaco.editor.EndOfLineSequence;
    return [['\r\n', 'CRLF (Windows)', M.CRLF], ['\n', 'LF (Unix)', M.LF]].map(([e, l, seq]) => ({
      label: l, checked: this.eol === e, action: () => { this.eol = e; this.model.pushEOL(seq); this.refreshStatus(); },
    }));
  }

  setLanguage(lang) {
    this.lang = lang;
    this.tab.lang = lang;
    this.monaco.editor.setModelLanguage(this.model, lang);
    if (this.langSel) this.langSel.value = lang;
    if (this.previewBtn) this.previewBtn.hidden = !this.canPreview();
    if (this.docBtn) this.docBtn.hidden = !['html', 'markdown'].includes(lang);
    if (!this.canPreview()) this.setPreview(false);
    this.app.renderMenubar();
    this.refreshStatus();
  }

  toggleWrap() {
    const on = this.ed.getOption(this.monaco.editor.EditorOption.wordWrap) !== 'off';
    this.ed.updateOptions({ wordWrap: on ? 'off' : 'on' });
    this.wrapBtn?.classList.toggle('active', !on);
  }

  toggleMinimap() {
    const on = this.ed.getOption(this.monaco.editor.EditorOption.minimap).enabled;
    this.ed.updateOptions({ minimap: { enabled: !on } });
    this.mapBtn?.classList.toggle('active', !on);
  }

  run(id) {
    this.ed.focus();
    const a = this.ed.getAction(id);
    if (a) a.run(); else this.ed.trigger('bds', id, null);
  }

  async format() {
    const a = this.ed.getAction('editor.action.formatDocument');
    if (a && a.isSupported()) { await a.run(); return; }
    if (this.lang === 'xml' || this.lang === 'html') { this.replaceAll(formatXml(this.model.getValue())); return; }
    toast(`No formatter for ${this.lang}.`, { type: 'warn' });
  }

  jsonTransform(indent, sortKeys = false) {
    try {
      let obj = JSON.parse(this.model.getValue());
      if (sortKeys) obj = sortDeep(obj);
      this.replaceAll(JSON.stringify(obj, null, indent) + (indent ? '\n' : ''));
    } catch (e) { errorToast(e, 'Invalid JSON'); }
  }

  replaceAll(text) {
    this.ed.pushUndoStop();
    this.ed.executeEdits('bds', [{ range: this.model.getFullModelRange(), text }]);
    this.ed.pushUndoStop();
  }

  async toDocument() {
    const v = this.model.getValue();
    let html = v;
    if (this.lang === 'markdown') html = (await vendor.marked()).parse(v, { gfm: true });
    const tab = await this.app.newDocument('doc');
    if (!tab?.editor) return;
    tab.editor.setHTML(html, { fromHtmlFile: this.lang === 'html' });
    this.app.setTabMeta(tab, { title: stripExt(this.tab.title) });
  }

  // ------------------------------------------------------------------ status & io

  status() {
    const pos = this.ed.getPosition() || { lineNumber: 1, column: 1 };
    const sel = this.ed.getSelection();
    const selLen = sel ? this.model.getValueInRange(sel).length : 0;
    const markers = this.monaco.editor.getModelMarkers({ resource: this.model.uri });
    const errs = markers.filter((m) => m.severity === 8).length;
    const warns = markers.filter((m) => m.severity === 4).length;
    const o = this.model.getOptions();
    const langName = LANGUAGES.find(([id]) => id === this.lang)?.[1] || this.lang;
    return {
      left: [
        { text: `Ln ${pos.lineNumber}, Col ${pos.column}${selLen ? ` (${selLen} selected)` : ''}` },
        ...(errs || warns ? [{ text: `${errs} error${errs === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`, icon: 'alert', cls: errs ? 'err' : '', action: () => this.run('editor.action.marker.next') }] : []),
      ],
      right: [
        { text: o.insertSpaces ? `Spaces: ${o.tabSize}` : `Tab: ${o.tabSize}`, action: (e, el) => showMenu(this.indentItems(), { anchor: el }) },
        { text: this.encoding === 'utf-8' ? (this.bom ? 'UTF-8 BOM' : 'UTF-8') : this.encoding.toUpperCase(), action: (e, el) => showMenu(this.encodingItems(), { anchor: el }) },
        { text: this.eol === '\r\n' ? 'CRLF' : 'LF', action: (e, el) => showMenu(this.eolItems(), { anchor: el }) },
        { text: langName, action: (e, el) => showMenu(LANGUAGES.map(([id, name]) => ({ label: name, checked: this.lang === id, action: () => this.setLanguage(id) })), { anchor: el }) },
      ],
    };
  }

  saveFormats() {
    const ext = this.tab.ext || 'txt';
    return [{ ext, name: `${ext.toUpperCase()} file` }];
  }

  exportTargets() {
    const out = [];
    if (this.lang === 'markdown') {
      out.push({
        label: 'HTML page (.html)', icon: 'globe',
        run: async () => {
          const body = (await vendor.marked()).parse(this.model.getValue(), { gfm: true });
          const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(stripExt(this.tab.title))}</title><style>${markdownCss('light')}</style></head><body><article class="md">${body}</article></body></html>`;
          await this.app.saveBytesAs(html, { defaultName: stripExt(this.tab.title) + '.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
        },
      });
    }
    if (this.lang === 'markdown' || this.lang === 'html') {
      out.push({
        label: 'PDF (.pdf)', icon: 'file-pdf',
        run: async () => {
          let html = this.model.getValue();
          if (this.lang === 'markdown') html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{margin:0.8in}${markdownCss('light')}</style></head><body><article class="md">${(await vendor.marked()).parse(html, { gfm: true })}</article></body></html>`;
          const pdf = await api.printPdf(html);
          await this.app.saveBytesAs(pdf, { defaultName: stripExt(this.tab.title) + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        },
      });
    }
    return out;
  }

  async serialize() {
    return encodeText(this.model.getValue(), this.encoding, this.bom);
  }

  afterSave() {
    this.savedVersion = this.model.getAlternativeVersionId();
    if (this.previewOn) { this._base = null; this.updatePreview(); }
  }

  getDraft() { return this.model.getValue(); }
  restoreDraft(content) { this.model.setValue(content || ''); }
  setText(t) { this.model.setValue(t); }
  insertText(t) { this.ed.focus(); this.ed.trigger('chars', 'type', { text: t }); }
  getSelectionText() { const s = this.ed.getSelection(); return s ? this.model.getValueInRange(s) : ''; }
  getContextText() { return this.model.getValue(); }
  replaceSelection(t) {
    this.ed.focus();
    this.ed.pushUndoStop();
    this.ed.executeEdits('claude', [{ range: this.ed.getSelection(), text: t, forceMoveMarkers: true }]);
    this.ed.pushUndoStop();
  }
  gotoLine(line, col = 1) {
    this.ed.setSelection({ startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col });
    this.ed.revealLineInCenter(line);
    this.ed.focus();
  }

  handlesKey(e) {
    const inside = this.editorHost.contains(document.activeElement);
    if (!inside) return false;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (k === 'f' || k === 'h' || k === 'g')) return true;
    if (e.altKey && k === 'z') { e.preventDefault(); this.toggleWrap(); return true; }
    return false;
  }

  find(replace) { this.run(replace ? 'editor.action.startFindReplaceAction' : 'actions.find'); }
  undo() { this.ed.focus(); this.ed.trigger('bds', 'undo', null); }
  redo() { this.ed.focus(); this.ed.trigger('bds', 'redo', null); }
  focus() { this.ed?.focus(); }
  selectAll() { this.ed.setSelection(this.model.getFullModelRange()); }

  zoom(delta) {
    this.fontSize = delta === 0 ? (this.app.settings.codeFontSize || 13) : clamp(this.fontSize + delta, 9, 32);
    this.ed.updateOptions({ fontSize: this.fontSize, lineHeight: Math.round(this.fontSize * 1.6) });
  }

  onShow() { setTimeout(() => this.ed?.layout(), 0); }

  onThemeChange(theme) {
    this.monaco.editor.setTheme(this.app.settings.theme === 'light' ? 'bds-light' : 'bds-dark');
    if (this.frame?.dataset.kind === 'md') { this.frame = null; this.updatePreview(); }
  }

  print() {
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return toast('Allow pop-ups to print.', { type: 'warn' });
    w.document.write(`<!doctype html><title>${escapeHtml(this.tab.title)}</title><style>pre{font:9.5pt/1.45 Consolas,monospace;white-space:pre-wrap;word-wrap:break-word}@page{margin:15mm}</style><pre>${escapeHtml(this.model.getValue())}</pre>`);
    w.document.close();
    setTimeout(() => { w.print(); w.close(); }, 200);
  }

  destroy() {
    this.markerSub?.dispose();
    this.ed?.dispose();
    this.model?.dispose();
  }
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

/** Small XML pretty-printer for config files. */
export function formatXml(xml) {
  const tokens = xml.replace(/>\s+</g, '><').trim().split(/(?=<)|(?<=>)/g).filter((t) => t.trim());
  let depth = 0;
  const out = [];
  for (const t of tokens) {
    if (/^<\//.test(t)) depth = Math.max(0, depth - 1);
    const line = '  '.repeat(depth) + t.trim();
    // keep <tag>text</tag> on one line
    if (out.length && !t.startsWith('<') && /^\s*<[^/!?][^>]*[^/]>$/.test(out[out.length - 1])) { out[out.length - 1] += t.trim(); continue; }
    if (/^<\//.test(t) && out.length && /^\s*<[^/!?][^>]*>[^<]+$/.test(out[out.length - 1])) { out[out.length - 1] += t.trim(); continue; }
    out.push(line);
    if (/^<[^/!?][^>]*[^/]>$/.test(t) || /^<[^/!?>]>$/.test(t)) depth++;
  }
  return out.join('\n') + '\n';
}

export function markdownCss(theme = 'dark') {
  const dark = theme !== 'light';
  return `
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  html, body { margin: 0; background: ${dark ? '#100d16' : '#ffffff'}; }
  .md { max-width: 820px; margin: 0 auto; padding: 32px 36px 60px; font: 15px/1.7 Inter, 'Segoe UI', system-ui, sans-serif; color: ${dark ? '#e7e1f3' : '#221c2e'}; }
  .md h1, .md h2, .md h3, .md h4 { line-height: 1.25; margin: 1.6em 0 0.6em; font-weight: 600; }
  .md h1 { font-size: 2em; padding-bottom: .3em; border-bottom: 1px solid ${dark ? '#2a2238' : '#e7e1f0'}; }
  .md h2 { font-size: 1.45em; padding-bottom: .25em; border-bottom: 1px solid ${dark ? '#2a2238' : '#eee8f5'}; }
  .md h1:first-child, .md h2:first-child { margin-top: 0; }
  .md a { color: ${dark ? '#c7a6ff' : '#6a3fc6'}; }
  .md code { font: 0.88em 'IBM Plex Mono', Consolas, monospace; background: ${dark ? '#1e1929' : '#f3eff9'}; padding: .15em .4em; border-radius: 4px; }
  .md pre { background: ${dark ? '#0b0910' : '#f6f3fa'}; border: 1px solid ${dark ? '#2a2238' : '#e7e1f0'}; padding: 14px 16px; border-radius: 8px; overflow: auto; }
  .md pre code { background: none; padding: 0; }
  .md blockquote { margin: 1em 0; padding: .2em 1em; color: ${dark ? '#b0a6c4' : '#5a5070'}; border-left: 3px solid ${dark ? '#b48cff' : '#7a4fd6'}; }
  .md table { border-collapse: collapse; margin: 1em 0; }
  .md th, .md td { border: 1px solid ${dark ? '#352c49' : '#ddd5ea'}; padding: 6px 12px; }
  .md th { background: ${dark ? '#1c1726' : '#f6f3fa'}; }
  .md img { max-width: 100%; }
  .md hr { border: 0; height: 1px; background: ${dark ? '#352c49' : '#e2dcec'}; margin: 2em 0; }
  .md li input[type=checkbox] { margin-right: .5em; }
  .md ul:has(> li > input[type=checkbox]) { list-style: none; padding-left: 1.2em; }
  @media print { html, body { background: #fff; } .md { color: #000; padding: 0; } }
  `;
}
