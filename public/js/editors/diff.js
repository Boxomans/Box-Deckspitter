// BoxDiff — compare two files side by side (Monaco's diff editor): added lines in green, removed in red,
// with the exact changed words highlighted. Text and code compare as-is; Word / OpenDocument / RTF / PDF /
// spreadsheets compare by their text; two pictures compare pixel by pixel.

import { BaseEditor } from './base.js';
import { h, clear, vendor, basename, extOf, decodeText, looksLikeText, formatBytes } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, errorToast, showMenu, modal } from '../core/ui.js';
import { api } from '../core/api.js';
import { pickOpen } from '../core/files.js';
import { langForName } from '../core/filetypes.js';
import { loadMonaco, monacoTheme } from './code.js';
import { DUMP_MIME } from './doc/image-dump.js';

const IMG_RE = /\.(png|jpe?g|jfif|webp|bmp|gif)$/i;
const SIDES = ['Old (left)', 'New (right)'];

// ---------------------------------------------------------------- turning files into comparable text

function htmlToText(html) {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const out = [];
  const BLOCK = /^(P|DIV|LI|H[1-6]|TR|BLOCKQUOTE|PRE|SECTION|ARTICLE|TABLE|UL|OL)$/;
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out.push(c.nodeValue.replace(/\s+/g, ' '));
      else if (c.nodeType === 1) {
        if (c.tagName === 'BR') { out.push('\n'); continue; }
        if (c.tagName === 'LI') out.push('• ');
        walk(c);
        if (c.tagName === 'TD' || c.tagName === 'TH') out.push('\t');
        else if (BLOCK.test(c.tagName)) out.push('\n');
      }
    }
  })(body);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

async function pdfToText(bytes) {
  const pdfjs = await vendor.pdfjs();
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      let s = '';
      for (const it of tc.items) s += (it.str || '') + (it.hasEOL ? '\n' : '');
      pages.push(`──────── page ${i} ────────\n${s.replace(/[ \t]+\n/g, '\n').trim()}`);
    }
  } finally { await doc.destroy(); }
  const text = pages.join('\n\n');
  return text.replace(/──────── page \d+ ────────/g, '').trim() ? text + '\n' : `${text}\n\n(No text found — this PDF looks like a scan. Read it with BoxScribe first, then compare the text.)\n`;
}

async function sheetToText(bytes) {
  const XLSX = await vendor.xlsx();
  const wb = XLSX.read(bytes, { type: 'array' });
  return wb.SheetNames.map((n) => `──────── sheet: ${n} ────────\n${XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })}`).join('\n\n') + '\n';
}

/** -> { kind: 'text', text, lang, how } | { kind: 'image', url, w, h, data } */
async function analyse(name, bytes) {
  const ext = extOf(name).toLowerCase();
  if (IMG_RE.test(name)) {
    const url = URL.createObjectURL(new Blob([bytes]));
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(`Couldn’t read ${name} as a picture`)); i.src = url; });
    return { kind: 'image', url, img, w: img.naturalWidth, h: img.naturalHeight };
  }
  if (ext === 'pdf') return { kind: 'text', text: await pdfToText(bytes), lang: 'plaintext', how: 'PDF text' };
  if (['docx', 'docm', 'dotx'].includes(ext)) {
    const { importDocx } = await import('./doc/docx-import.js');
    return { kind: 'text', text: htmlToText((await importDocx(bytes)).html), lang: 'plaintext', how: 'Word text' };
  }
  if (ext === 'odt') {
    const { importOdt } = await import('./doc/odt-import.js');
    return { kind: 'text', text: htmlToText((await importOdt(bytes)).html), lang: 'plaintext', how: 'document text' };
  }
  if (ext === 'rtf' || ext === 'doc') {
    const { importRtf } = await import('./doc/rtf.js');
    return { kind: 'text', text: htmlToText(importRtf(decodeText(bytes).text)), lang: 'plaintext', how: 'document text' };
  }
  if (['xlsx', 'xlsm', 'xls', 'ods'].includes(ext)) return { kind: 'text', text: await sheetToText(bytes), lang: 'plaintext', how: 'cells as CSV' };
  if (looksLikeText(bytes)) return { kind: 'text', text: decodeText(bytes).text, lang: langForName(name), how: '' };
  // binary: compare a hex dump so at least the changed bytes show up
  const lines = [];
  const n = Math.min(bytes.length, 64 * 1024);
  for (let i = 0; i < n; i += 16) {
    const row = bytes.subarray(i, i + 16);
    lines.push(i.toString(16).padStart(8, '0') + '  ' + [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(48) + '  ' + [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join(''));
  }
  if (bytes.length > n) lines.push(`… (${formatBytes(bytes.length - n)} more not shown)`);
  return { kind: 'text', text: lines.join('\n') + '\n', lang: 'plaintext', how: 'hex' };
}

export class DiffEditor extends BaseEditor {
  static mode = 'diff';

  async load(bytes, opts = {}) {
    this.sides = [null, null]; // { name, path, bytes, info }
    this.sideBySide = this.app.settings.diffInline !== true;
    this.ignoreWs = this.app.settings.diffIgnoreWs === true;
    this.wrap = this.app.settings.diffWrap !== false;
    this.build();
    const pre = opts.diff || [];
    for (let i = 0; i < 2; i++) {
      const p = pre[i];
      if (!p) continue;
      if (p.path) await this.setFromPath(i, p.path, false);
      else if (p.bytes) await this.setSide(i, { name: p.name, bytes: p.bytes }, false);
    }
    await this.render();
    if (opts.pickRight && !this.sides[1]) setTimeout(() => this.pickFile(1), 150);
  }

  build() {
    this.slots = [0, 1].map((i) => {
      const name = h('span', { class: 'diff-slot-name' });
      const meta = h('span', { class: 'diff-slot-meta mono faint' });
      const el = h('div', { class: `diff-slot ${i ? 'right' : 'left'}` },
        h('span', { class: 'diff-slot-tag' }, i ? '+ new' : '− old'),
        h('div', { class: 'diff-slot-text' }, name, meta),
        h('button', { class: 'btn sm', onclick: () => this.pickFile(i) }, icon('folder-open', 'sm'), 'Open…'),
        h('button', { class: 'icon-btn', 'data-tip': 'Use an open tab or a dump file', onclick: (e) => this.sourceMenu(i, e.currentTarget) }, icon('chevron-down', 'sm')));
      return { el, name, meta };
    });
    this.stats = h('span', { class: 'diff-stats mono' });
    this.host = h('div', { class: 'diff-host' });
    this.imgHost = h('div', { class: 'diff-images', hidden: true });
    this.empty = h('div', { class: 'diff-empty' });
    this.root = h('div', { class: 'diff-root' },
      h('div', { class: 'diff-slots' }, this.slots[0].el,
        h('button', { class: 'icon-btn diff-swap', 'data-tip': 'Swap old and new', onclick: () => this.swap() }, icon('swap', 'sm')),
        this.slots[1].el),
      h('div', { class: 'diff-body' }, this.host, this.imgHost, this.empty));
    this.pane.append(this.root);
    this.root.addEventListener('keydown', (e) => { if (e.key === 'F7') { e.preventDefault(); e.stopPropagation(); this.goto(e.shiftKey ? -1 : 1); } }, true);

    // drop a file on the left or right half to load that side
    this.root.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(DUMP_MIME)) return;
      e.preventDefault();
      const side = this.sideAt(e.clientX);
      this.root.dataset.drop = String(side);
    });
    this.root.addEventListener('dragleave', (e) => { if (!this.root.contains(e.relatedTarget)) delete this.root.dataset.drop; });
    this.root.addEventListener('drop', async (e) => {
      delete this.root.dataset.drop;
      const files = [...e.dataTransfer.files];
      const dumpUrl = e.dataTransfer.getData(DUMP_MIME);
      if (!files.length && !dumpUrl) return;
      e.preventDefault();
      let side = this.sideAt(e.clientX);
      try {
        if (files.length >= 2) {
          await this.setSide(0, { name: files[0].name, bytes: new Uint8Array(await files[0].arrayBuffer()) }, false);
          await this.setSide(1, { name: files[1].name, bytes: new Uint8Array(await files[1].arrayBuffer()) }, false);
        } else if (files.length) {
          await this.setSide(side, { name: files[0].name, bytes: new Uint8Array(await files[0].arrayBuffer()) }, false);
        } else {
          const name = decodeURIComponent(dumpUrl.split('/').pop().split('?')[0]);
          await this.setSide(side, { name, bytes: new Uint8Array(await (await fetch(dumpUrl)).arrayBuffer()) }, false);
        }
        await this.render();
      } catch (err) { errorToast(err, 'Couldn’t load that file'); }
    });
  }

  sideAt(x) {
    const r = this.root.getBoundingClientRect();
    if (!this.sides[0] && this.sides[1]) return 0;
    if (this.sides[0] && !this.sides[1] && !this.sideBySide) return 1;
    return x < r.left + r.width / 2 ? 0 : 1;
  }

  buildToolbar() {
    const seg = (on, label, fn) => h('button', { class: on ? 'on' : '', onclick: fn }, label);
    this.modeSeg = h('div', { class: 'seg' });
    const renderSeg = () => clear(this.modeSeg).append(
      seg(this.sideBySide, 'Side by side', () => { this.sideBySide = true; this.app.saveSettings({ diffInline: false }); renderSeg(); this.applyOptions(); }),
      seg(!this.sideBySide, 'Inline', () => { this.sideBySide = false; this.app.saveSettings({ diffInline: true }); renderSeg(); this.applyOptions(); }));
    renderSeg();
    const cb = (label, tip, val, fn) => {
      const c = h('input', { type: 'checkbox', checked: val });
      c.addEventListener('change', () => fn(c.checked));
      return h('label', { class: 'tb-check', 'data-tip': tip }, c, label);
    };
    return h('div', { class: 'toolbar' },
      h('button', { class: 'btn sm', 'data-tip': 'Previous change (Shift+F7)', onclick: () => this.goto(-1) }, icon('arrow-up', 'sm'), 'Prev'),
      h('button', { class: 'btn sm', 'data-tip': 'Next change (F7)', onclick: () => this.goto(1) }, icon('arrow-down', 'sm'), 'Next'),
      this.stats,
      h('div', { class: 'tb-sep' }),
      this.modeSeg,
      cb('Ignore spaces', 'Ignore changes that are only extra spaces at the start or end of lines', this.ignoreWs, (v) => { this.ignoreWs = v; this.app.saveSettings({ diffIgnoreWs: v }); this.applyOptions(); }),
      cb('Wrap', 'Wrap long lines', this.wrap, (v) => { this.wrap = v; this.app.saveSettings({ diffWrap: v }); this.applyOptions(); }),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn sm ghost', 'data-tip': 'Clear both sides', onclick: () => { this.sides = [null, null]; this.render(); } }, icon('x', 'sm'), 'Clear'));
  }

  // ---------------------------------------------------------------- loading sides

  async pickFile(i) {
    const paths = await pickOpen({ multi: !this.sides[0] && !this.sides[1] && i === 0, title: `Choose the ${i ? 'new' : 'old'} file` });
    if (!paths?.length) return;
    try {
      await this.setFromPath(i, paths[0], false);
      if (paths[1]) await this.setFromPath(1, paths[1], false);
      await this.render();
      if (i === 0 && !this.sides[1] && paths.length === 1) setTimeout(() => this.pickFile(1), 120);
    } catch (e) { errorToast(e, 'Couldn’t open that file'); }
  }

  async setFromPath(i, path, rerender = true) {
    const { bytes } = await api.read(path);
    await this.setSide(i, { name: basename(path), path, bytes }, rerender);
  }

  async setSide(i, { name, path = null, bytes, text = null }, rerender = true) {
    const info = text != null ? { kind: 'text', text, lang: langForName(name), how: 'unsaved edits' } : await analyse(name, bytes);
    if (this.sides[i]?.info?.url) URL.revokeObjectURL(this.sides[i].info.url);
    this.sides[i] = { name, path, size: bytes?.length ?? text?.length ?? 0, info };
    if (rerender) await this.render();
  }

  sourceMenu(i, anchor) {
    const tabs = this.app.tabs.filter((t) => t !== this.tab && t.editor && (t.path || t.editor.getDraft));
    showMenu([
      { label: 'Open a file…', icon: 'folder-open', action: () => this.pickFile(i) },
      { label: 'From the doc dump…', icon: 'file-pdf', action: () => this.fromDump(i, 'doc') },
      { label: 'From the media dump…', icon: 'image', action: () => this.fromDump(i, 'image') },
      { sep: true },
      ...(tabs.length ? tabs.map((t) => ({ label: `Tab: ${t.title}${t.dirty ? ' (unsaved)' : ''}`, icon: 'file', action: () => this.fromTab(i, t) })) : [{ label: 'No other tabs open', disabled: true }]),
    ], { anchor });
  }

  async fromTab(i, t) {
    try {
      const ed = t.editor;
      // code / text tabs: use what's on screen (including unsaved edits)
      if ((t.mode === 'code' || t.mode === 'text') && ed.getDraft) return this.setSide(i, { name: t.title, path: t.path, text: ed.getDraft() });
      if (t.mode === 'doc' && ed.cleanHtml) return this.setSide(i, { name: t.title, path: t.path, text: htmlToText(ed.cleanHtml()) });
      if (t.path) return this.setFromPath(i, t.path);
      toast('Save that tab first, then compare it.', { type: 'warn' });
    } catch (e) { errorToast(e); }
  }

  async fromDump(i, kind) {
    let items = [];
    try { items = (await api.dump(kind)).items; } catch { /* ignore */ }
    if (!items.length) return toast(`The ${kind} dump is empty.`, { type: 'warn' });
    let ctx = null;
    const grid = h('div', { class: `mail-dumppick ${kind}` }, items.map((it) => {
      const b = h('button', { class: 'mail-dumpitem', title: it.name },
        kind === 'image' ? h('img', { src: it.url, alt: '' }) : h('span', { class: 'diff-dumpicon' }, icon(/\.pdf$/i.test(it.name) ? 'file-pdf' : 'file-text', 'xl')),
        h('span', { class: 'mail-dumpname' }, it.name));
      b.addEventListener('click', async () => {
        ctx?.close(null);
        try { await this.setSide(i, { name: it.name, path: it.path, bytes: new Uint8Array(await (await fetch(it.url)).arrayBuffer()) }); } catch (e) { errorToast(e); }
      });
      return b;
    }));
    modal({ title: `${SIDES[i]}: pick from the ${kind} dump`, wide: true, body: grid, buttons: [{ label: 'Cancel', value: null, ghost: true }], onOpen: (c) => { ctx = c; } });
  }

  async swap() {
    this.sides.reverse();
    await this.render();
  }

  // ---------------------------------------------------------------- showing the comparison

  async render() {
    this.slots.forEach((s, i) => {
      const d = this.sides[i];
      s.el.classList.toggle('set', !!d);
      s.name.textContent = d ? d.name : i ? 'drop or open the new version' : 'drop or open the old version';
      s.name.title = d?.path || d?.name || '';
      s.meta.textContent = d ? [formatBytes(d.size), d.info.how].filter(Boolean).join(' · ') : '';
    });
    const [a, b] = this.sides;
    if (a && b) this.app.setTabMeta(this.tab, { title: `${a.name} vs ${b.name}` });
    else this.app.setTabMeta(this.tab, { title: this.app.toolName('BoxDiff') });

    const imgs = a?.info.kind === 'image' && b?.info.kind === 'image';
    this.host.hidden = imgs || !(a || b);
    this.imgHost.hidden = !imgs;
    this.empty.hidden = !!(a || b);
    if (!a && !b) {
      clear(this.empty).append(
        icon('diff', 'xl'),
        h('div', {}, h('b', {}, 'Drop two files here'), ' — or one on each side'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => this.pickFile(0) }, icon('folder-open', 'sm'), 'Choose files…'),
          h('button', { class: 'btn', onclick: (e) => this.sourceMenu(0, e.currentTarget) }, 'From a tab or dump…')),
        h('div', { class: 'faint', style: { fontSize: '11px' } }, 'Text and code compare line by line. Word, PDF and spreadsheets compare by their text. Pictures compare pixel by pixel.'));
      this.stats.textContent = '';
      return;
    }
    if (imgs) return this.renderImages();
    if ((a && a.info.kind === 'image') || (b && b.info.kind === 'image')) {
      if (a && b) toast('Only one side is a picture — compare a picture with a picture.', { type: 'warn' });
    }
    await this.renderText();
  }

  async renderText() {
    const monaco = this.monaco || (this.monaco = await loadMonaco());
    const txt = (s) => (s && s.info.kind === 'text' ? s.info.text : '');
    const [a, b] = this.sides;
    const lang = a && b && a.info.lang === b.info.lang ? a.info.lang : (a || b).info.lang || 'plaintext';
    const left = monaco.editor.createModel(txt(a), lang);
    const right = monaco.editor.createModel(txt(b), lang);
    if (!this.diff) {
      this.diff = monaco.editor.createDiffEditor(this.host, {
        theme: monacoTheme(this.app.settings.theme),
        automaticLayout: true,
        readOnly: true,
        originalEditable: false,
        fontFamily: "'IBM Plex Mono', 'Cascadia Code', Consolas, monospace",
        fontSize: this.app.settings.codeFontSize || 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderOverviewRuler: true,
        enableSplitViewResizing: true,
        maxComputationTime: 0, // big files: wait for the full answer rather than giving up
        hideUnchangedRegions: { enabled: false },
      });
      this.diff.onDidUpdateDiff(() => this.updateStats());
      this.applyOptions();
    }
    const old = this.diff.getModel();
    this.diff.setModel({ original: left, modified: right });
    old?.original.dispose();
    old?.modified.dispose();
  }

  applyOptions() {
    this.diff?.updateOptions({ renderSideBySide: this.sideBySide, ignoreTrimWhitespace: this.ignoreWs, wordWrap: this.wrap ? 'on' : 'off', diffWordWrap: this.wrap ? 'on' : 'off' });
  }

  changes() { return this.diff?.getLineChanges() || []; }

  updateStats() {
    const ch = this.changes();
    let add = 0;
    let del = 0;
    for (const c of ch) {
      if (c.modifiedEndLineNumber > 0) add += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
      if (c.originalEndLineNumber > 0) del += c.originalEndLineNumber - c.originalStartLineNumber + 1;
    }
    clear(this.stats);
    if (!this.sides[0] || !this.sides[1]) return;
    if (!ch.length) { this.stats.append(h('span', { class: 'diff-same' }, '✓ identical')); return; }
    this.stats.append(h('span', { class: 'diff-add' }, `+${add}`), ' ', h('span', { class: 'diff-del' }, `−${del}`), h('span', { class: 'faint' }, ` · ${ch.length} change${ch.length > 1 ? 's' : ''}`));
  }

  goto(dir) {
    if (this.imgHost.hidden === false) return;
    const ch = this.changes();
    if (!ch.length) return toast('No differences.', { timeout: 1500 });
    const ed = this.diff.getModifiedEditor();
    const line = ed.getPosition()?.lineNumber || 0;
    const starts = ch.map((c) => Math.max(1, c.modifiedStartLineNumber));
    let target = dir > 0 ? starts.find((s) => s > line) : [...starts].reverse().find((s) => s < line);
    if (target == null) target = dir > 0 ? starts[0] : starts[starts.length - 1];
    ed.setPosition({ lineNumber: target, column: 1 });
    ed.revealLineInCenter(target);
    ed.focus();
  }

  renderImages() {
    const [a, b] = this.sides.map((s) => s.info);
    const W = Math.max(a.w, b.w);
    const H = Math.max(a.h, b.h);
    const draw = (info) => { const c = h('canvas', { width: W, height: H }); c.getContext('2d').drawImage(info.img, 0, 0); return c; };
    const ca = draw(a);
    const cb = draw(b);
    const da = ca.getContext('2d').getImageData(0, 0, W, H);
    const db = cb.getContext('2d').getImageData(0, 0, W, H);
    const mask = h('canvas', { width: W, height: H, class: 'diff-mask' });
    const mctx = mask.getContext('2d');
    const md = mctx.createImageData(W, H);
    let changed = 0;
    for (let p = 0; p < da.data.length; p += 4) {
      const d = Math.abs(da.data[p] - db.data[p]) + Math.abs(da.data[p + 1] - db.data[p + 1]) + Math.abs(da.data[p + 2] - db.data[p + 2]) + Math.abs(da.data[p + 3] - db.data[p + 3]);
      if (d > 24) { changed++; md.data[p] = 255; md.data[p + 1] = 60; md.data[p + 2] = 200; md.data[p + 3] = 200; }
    }
    mctx.putImageData(md, 0, 0);
    const pct = (changed / (W * H)) * 100;
    clear(this.stats).append(changed ? h('span', { class: 'diff-del' }, `${pct < 0.01 ? '<0.01' : pct.toFixed(2)}% of pixels differ`) : h('span', { class: 'diff-same' }, '✓ identical pictures'),
      a.w !== b.w || a.h !== b.h ? h('span', { class: 'faint' }, ` · sizes ${a.w}×${a.h} vs ${b.w}×${b.h}`) : null);
    const showMask = h('input', { type: 'checkbox', checked: true });
    const wrapB = h('div', { class: 'diff-imgbox checker' }, cb, mask);
    showMask.addEventListener('change', () => { mask.hidden = !showMask.checked; });
    clear(this.imgHost).append(
      h('div', { class: 'diff-imgcol' }, h('div', { class: 'diff-imgcap del' }, '− old'), h('div', { class: 'diff-imgbox checker' }, ca)),
      h('div', { class: 'diff-imgcol' }, h('div', { class: 'diff-imgcap add' }, '+ new ', h('label', { class: 'tb-check' }, showMask, 'highlight differences')), wrapB));
  }

  handlesKey(e) { return !!this.diff && this.root.contains(document.activeElement); }

  onThemeChange() { this.monaco?.editor.setTheme(monacoTheme(this.app.settings.theme)); }

  destroy() {
    const m = this.diff?.getModel();
    this.diff?.dispose();
    m?.original.dispose();
    m?.modified.dispose();
    for (const s of this.sides) if (s?.info?.url) URL.revokeObjectURL(s.info.url);
  }
}
