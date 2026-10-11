// Spreadsheet mode — xlsx / xls / ods / csv / tsv with formulas, multiple sheets and a virtualized grid.

import { BaseEditor } from './base.js';
import { h, clear, clamp, debounce, decodeText, encodeText, vendor, escapeHtml } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { tbButton, tbSep, showMenu, contextMenu, promptDialog, toast, confirmDialog, FindBar, buildRegex } from '../core/ui.js';
import { parse, evaluate, isErr, colName, refName, parseRef, FUNCTION_NAMES } from './sheet/formula.js';

const ROW_H = 24;
const DEF_W = 104;
const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

export class SheetEditor extends BaseEditor {
  static mode = 'sheet';

  async load(bytes, opts = {}) {
    this.XLSX = await vendor.xlsx();
    this.sheets = [];
    this.active = 0;
    this.sel = { r: 0, c: 0, ar: 0, ac: 0 };
    this.undoStack = [];
    this.redoStack = [];
    this.astCache = new Map();
    const ext = this.tab.ext;
    if (bytes && bytes.length) {
      if (ext === 'csv' || ext === 'tsv') this.loadDelimited(decodeText(bytes).text, ext === 'tsv' ? '\t' : null);
      else this.loadWorkbook(bytes);
    }
    if (!this.sheets.length) this.sheets.push(this.newSheet('Sheet1'));
    if (opts.draft) this.restoreDraft(opts.draft);
    this.buildDom();
    this.recalc();
    this.render();
  }

  newSheet(name) { return { name, cells: new Map(), rows: 0, cols: 0, colW: [] }; }

  loadDelimited(text, sep) {
    if (sep == null) {
      const first = text.split(/\r?\n/, 1)[0] || '';
      const counts = { ',': (first.match(/,/g) || []).length, ';': (first.match(/;/g) || []).length, '\t': (first.match(/\t/g) || []).length };
      sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
    }
    this.sep = sep;
    const s = this.newSheet(this.tab.title.replace(/\.[^.]+$/, '').slice(0, 31) || 'Sheet1');
    const rows = parseDelimited(text, sep);
    rows.forEach((row, r) => row.forEach((v, c) => { if (v !== '') s.cells.set(r + ',' + c, { raw: v }); }));
    s.rows = rows.length;
    s.cols = Math.max(0, ...rows.map((r) => r.length));
    this.sheets.push(s);
  }

  loadWorkbook(bytes) {
    const X = this.XLSX;
    const wb = X.read(bytes, { type: 'array', cellFormula: true, cellNF: true, cellText: true, cellStyles: true });
    this.workbookProps = wb.Props;
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      const s = this.newSheet(name);
      if (ws['!ref']) {
        const range = X.utils.decode_range(ws['!ref']);
        s.rows = range.e.r + 1;
        s.cols = range.e.c + 1;
      }
      for (const key of Object.keys(ws)) {
        if (key[0] === '!') continue;
        const cell = ws[key];
        const { r, c } = X.utils.decode_cell(key);
        let raw;
        if (cell.f) raw = '=' + cell.f;
        else if (cell.t === 'b') raw = cell.v ? 'TRUE' : 'FALSE';
        else if (cell.t === 'n') raw = String(cell.v);
        else if (cell.t === 'e') raw = cell.w || '#ERROR!';
        else raw = cell.v == null ? '' : String(cell.v);
        if (raw === '' && !cell.f) continue;
        s.cells.set(r + ',' + c, { raw, orig: cell, origRaw: raw });
      }
      (ws['!cols'] || []).forEach((col, i) => { if (col) s.colW[i] = Math.round(col.wpx || (col.wch ? col.wch * 7 + 10 : DEF_W)); });
      s.merges = ws['!merges'];
      this.sheets.push(s);
    }
  }

  get sheet() { return this.sheets[this.active]; }

  // =================================================================== evaluation

  recalc() {
    const s = this.sheet;
    this.values = new Map();
    const visiting = new Set();
    const get = (r, c) => {
      const key = r + ',' + c;
      if (this.values.has(key)) return this.values.get(key);
      const cell = s.cells.get(key);
      if (!cell) return '';
      const raw = cell.raw;
      let v;
      if (raw.startsWith('=') && raw.length > 1) {
        if (visiting.has(key)) return { code: '#CIRC!', toString() { return '#CIRC!'; } };
        visiting.add(key);
        let ast = this.astCache.get(raw);
        if (!ast) { try { ast = parse(raw.slice(1)); } catch (e) { ast = { k: 'lit', v: e }; } this.astCache.set(raw, ast); }
        v = evaluate(ast, get);
        visiting.delete(key);
      } else if (NUM_RE.test(raw.trim())) v = Number(raw);
      else if (/^(TRUE|FALSE)$/i.test(raw)) v = raw.toUpperCase() === 'TRUE';
      else v = raw;
      this.values.set(key, v);
      return v;
    };
    this.getValue = get;
    for (const key of s.cells.keys()) { const [r, c] = key.split(',').map(Number); get(r, c); }
  }

  display(r, c) {
    const cell = this.sheet.cells.get(r + ',' + c);
    if (!cell) return { text: '', num: false };
    // keep Excel's formatted text (currency, dates, %) for untouched values
    if (cell.orig && cell.raw === cell.origRaw && !cell.raw.startsWith('=') && cell.orig.w != null) return { text: cell.orig.w, num: cell.orig.t === 'n' };
    const v = this.getValue(r, c);
    if (isErr(v) || (v && v.code)) return { text: String(v.code || v), num: false, err: true };
    if (typeof v === 'number') {
      if (cell.orig && cell.raw.startsWith('=') && cell.orig.z && cell.orig.z !== 'General') {
        try { return { text: this.XLSX.SSF.format(cell.orig.z, v), num: true }; } catch { /* fallthrough */ }
      }
      return { text: formatNum(v), num: true };
    }
    if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', num: false, center: true };
    return { text: String(v), num: false };
  }

  // =================================================================== DOM

  buildDom() {
    this.nameBox = h('input', { class: 'sheet-namebox', type: 'text', spellcheck: 'false' });
    this.fx = h('input', { class: 'sheet-fx', type: 'text', spellcheck: 'false', placeholder: 'value or =formula' });
    this.fnList = h('datalist', { id: 'bds-fn-' + this.tab.id }, FUNCTION_NAMES.map((n) => h('option', { value: '=' + n + '(' })));
    this.fx.setAttribute('list', this.fnList.id);
    this.nameBox.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const ref = parseRef(this.nameBox.value.trim().split(':')[0]);
      if (ref) { this.select(ref.r, ref.c); this.grid.focus(); }
    });
    this.fx.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.setCell(this.sel.r, this.sel.c, this.fx.value); this.move(1, 0); this.grid.focus(); }
      else if (e.key === 'Escape') { this.fx.value = this.sheet.cells.get(this.sel.r + ',' + this.sel.c)?.raw || ''; this.grid.focus(); }
    });
    const fxBar = h('div', { class: 'sheet-fxbar' }, this.nameBox, h('span', { class: 'sheet-fx-label' }, 'ƒx'), this.fx, this.fnList);

    this.table = h('table', { class: 'sheet-table' });
    this.spacer = h('div', { class: 'sheet-spacer' });
    this.grid = h('div', { class: 'sheet-grid', tabindex: '0' }, this.spacer, this.table);
    this.tabsEl = h('div', { class: 'sheet-tabs' });
    this.root = h('div', { class: 'sheet-root' }, fxBar, this.grid, this.tabsEl);
    this.pane.append(this.root);

    this.grid.addEventListener('scroll', () => this.renderSoon());
    this.renderSoon = () => { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = null; this.render(); }); };
    new ResizeObserver(() => this.render()).observe(this.grid);
    this.grid.addEventListener('keydown', (e) => this.onKey(e));
    this.grid.addEventListener('paste', (e) => this.onPaste(e));
    this.grid.addEventListener('copy', (e) => this.onCopy(e, false));
    this.grid.addEventListener('cut', (e) => this.onCopy(e, true));
    this.grid.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.grid.addEventListener('dblclick', (e) => { const td = e.target.closest('td[data-r]'); if (td) this.startEdit(null); });
    this.grid.addEventListener('contextmenu', (e) => {
      const td = e.target.closest('td[data-r], th[data-c], th[data-r]');
      if (!td) return;
      contextMenu(e, this.contextItems());
    });
    this.renderTabs();
  }

  colW(c) { return this.sheet.colW[c] || DEF_W; }
  dims() {
    const s = this.sheet;
    return { rows: Math.max(s.rows + 60, 100, this.sel.r + 30), cols: Math.max(s.cols + 6, 26, this.sel.c + 4) };
  }

  render() {
    if (!this.grid) return;
    const { rows, cols } = this.dims();
    const top = this.grid.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW_H) - 4);
    const count = Math.ceil(this.grid.clientHeight / ROW_H) + 10;
    const last = Math.min(rows, first + count);
    let totalW = 48;
    for (let c = 0; c < cols; c++) totalW += this.colW(c);
    this.spacer.style.height = (rows + 1) * ROW_H + 'px';
    this.spacer.style.width = totalW + 'px';
    const [r1, r2] = [Math.min(this.sel.r, this.sel.ar), Math.max(this.sel.r, this.sel.ar)];
    const [c1, c2] = [Math.min(this.sel.c, this.sel.ac), Math.max(this.sel.c, this.sel.ac)];
    let html = `<colgroup><col style="width:48px">${Array.from({ length: cols }, (_, c) => `<col style="width:${this.colW(c)}px">`).join('')}</colgroup>`;
    html += `<thead><tr><th class="corner"></th>${Array.from({ length: cols }, (_, c) => `<th data-c="${c}" class="${c >= c1 && c <= c2 ? 'hl' : ''}">${colName(c)}<span class="col-resize" data-resize="${c}"></span></th>`).join('')}</tr></thead><tbody>`;
    for (let r = first; r < last; r++) {
      html += `<tr style="height:${ROW_H}px"><th data-r="${r}" class="${r >= r1 && r <= r2 ? 'hl' : ''}">${r + 1}</th>`;
      for (let c = 0; c < cols; c++) {
        const d = this.display(r, c);
        const inSel = r >= r1 && r <= r2 && c >= c1 && c <= c2;
        const active = r === this.sel.r && c === this.sel.c;
        const cls = [d.num ? 'num' : '', d.err ? 'err' : '', d.center ? 'center' : '', inSel ? 'sel' : '', active ? 'active' : '', this.findSet?.has(r + ',' + c) ? 'found' : ''].filter(Boolean).join(' ');
        html += `<td data-r="${r}" data-c="${c}"${cls ? ` class="${cls}"` : ''}>${escapeHtml(d.text)}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody>';
    this.table.innerHTML = html;
    this.table.style.transform = `translateY(${first * ROW_H}px)`;
    this.table.querySelector('thead').style.transform = `translateY(${top - first * ROW_H}px)`;
    this.positionEditor();
  }

  renderTabs() {
    clear(this.tabsEl);
    this.sheets.forEach((s, i) => {
      const t = h('button', { class: `sheet-tab ${i === this.active ? 'active' : ''}` }, s.name);
      t.addEventListener('click', () => this.switchSheet(i));
      t.addEventListener('dblclick', () => this.renameSheet(i));
      t.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Rename…', action: () => this.renameSheet(i) },
        { label: 'Duplicate', icon: 'copy', action: () => this.duplicateSheet(i) },
        { label: 'Delete', icon: 'trash', disabled: this.sheets.length < 2, action: () => this.deleteSheet(i) },
      ]));
      this.tabsEl.append(t);
    });
    this.tabsEl.append(h('button', { class: 'icon-btn', 'data-tip': 'Add sheet', onclick: () => this.addSheet() }, icon('plus', 'sm')));
    this.statsEl = h('div', { class: 'sheet-stats' });
    this.tabsEl.append(h('div', { class: 'grow' }), this.statsEl);
    this.updateStats();
  }

  switchSheet(i) {
    this.commitEdit();
    this.active = i;
    this.sel = { r: 0, c: 0, ar: 0, ac: 0 };
    this.grid.scrollTop = 0;
    this.grid.scrollLeft = 0;
    this.recalc();
    this.renderTabs();
    this.render();
    this.syncFx();
  }

  async renameSheet(i) {
    const n = await promptDialog('Rename sheet', 'Sheet name', this.sheets[i].name);
    if (!n) return;
    this.pushUndo();
    this.sheets[i].name = n.slice(0, 31).replace(/[\\/?*[\]:]/g, '_');
    this.markDirty();
    this.renderTabs();
  }

  addSheet() {
    this.pushUndo();
    let n = this.sheets.length + 1;
    while (this.sheets.some((s) => s.name === 'Sheet' + n)) n++;
    this.sheets.push(this.newSheet('Sheet' + n));
    this.markDirty();
    this.switchSheet(this.sheets.length - 1);
  }

  duplicateSheet(i) {
    this.pushUndo();
    const src = this.sheets[i];
    const copy = { ...src, name: (src.name + ' copy').slice(0, 31), cells: new Map([...src.cells].map(([k, v]) => [k, { raw: v.raw }])), colW: [...src.colW] };
    this.sheets.splice(i + 1, 0, copy);
    this.markDirty();
    this.switchSheet(i + 1);
  }

  async deleteSheet(i) {
    if (this.sheets.length < 2) return;
    if (!(await confirmDialog('Delete sheet?', `Delete “${this.sheets[i].name}”? You can undo this.`, { okLabel: 'Delete', danger: true }))) return;
    this.pushUndo();
    this.sheets.splice(i, 1);
    this.markDirty();
    this.switchSheet(Math.max(0, i - 1));
  }

  // =================================================================== selection & editing

  select(r, c, extend = false) {
    const { rows, cols } = this.dims();
    r = clamp(r, 0, rows + 1000);
    c = clamp(c, 0, cols + 200);
    if (extend) { this.sel.r = r; this.sel.c = c; }
    else this.sel = { r, c, ar: r, ac: c };
    this.scrollIntoView(r, c);
    this.render();
    this.syncFx();
    this.updateStats();
    this.refreshStatus();
  }

  move(dr, dc, extend = false) { this.select(this.sel.r + dr, this.sel.c + dc, extend); }

  scrollIntoView(r, c) {
    const g = this.grid;
    const y = r * ROW_H;
    if (y < g.scrollTop) g.scrollTop = y;
    else if (y + ROW_H * 2 > g.scrollTop + g.clientHeight) g.scrollTop = y + ROW_H * 2 - g.clientHeight;
    let x = 48;
    for (let i = 0; i < c; i++) x += this.colW(i);
    const w = this.colW(c);
    if (x - 48 < g.scrollLeft) g.scrollLeft = x - 48;
    else if (x + w > g.scrollLeft + g.clientWidth) g.scrollLeft = x + w - g.clientWidth;
  }

  syncFx() {
    const r1 = Math.min(this.sel.r, this.sel.ar), r2 = Math.max(this.sel.r, this.sel.ar);
    const c1 = Math.min(this.sel.c, this.sel.ac), c2 = Math.max(this.sel.c, this.sel.ac);
    this.nameBox.value = r1 === r2 && c1 === c2 ? refName(this.sel.r, this.sel.c) : `${refName(r1, c1)}:${refName(r2, c2)}`;
    if (document.activeElement !== this.fx) this.fx.value = this.sheet.cells.get(this.sel.r + ',' + this.sel.c)?.raw || '';
  }

  onMouseDown(e) {
    const resize = e.target.closest('[data-resize]');
    if (resize) { this.startResize(e, Number(resize.dataset.resize)); return; }
    const td = e.target.closest('td[data-r]');
    const colH = e.target.closest('th[data-c]');
    const rowH = e.target.closest('th[data-r]');
    if (e.button === 2 && td) {
      const r = Number(td.dataset.r), c = Number(td.dataset.c);
      const [r1, r2] = [Math.min(this.sel.r, this.sel.ar), Math.max(this.sel.r, this.sel.ar)];
      const [c1, c2] = [Math.min(this.sel.c, this.sel.ac), Math.max(this.sel.c, this.sel.ac)];
      if (r >= r1 && r <= r2 && c >= c1 && c <= c2) return;
    }
    if (this.editor && !e.target.closest('.sheet-editor')) this.commitEdit();
    if (colH) { const c = Number(colH.dataset.c); this.sel = { r: this.dims().rows - 1, c, ar: 0, ac: e.shiftKey ? this.sel.ac : c }; this.sel.r = Math.max(this.sheet.rows - 1, 0); this.sel.ar = 0; this.render(); this.syncFx(); this.updateStats(); return; }
    if (rowH) { const r = Number(rowH.dataset.r); this.sel = { r, c: Math.max(this.sheet.cols - 1, 0), ar: e.shiftKey ? this.sel.ar : r, ac: 0 }; this.render(); this.syncFx(); this.updateStats(); return; }
    if (!td) return;
    e.preventDefault();
    this.grid.focus();
    const r = Number(td.dataset.r), c = Number(td.dataset.c);
    this.select(r, c, e.shiftKey);
    const move = (ev) => {
      const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('td[data-r]');
      if (t) { const rr = Number(t.dataset.r), cc = Number(t.dataset.c); if (rr !== this.sel.r || cc !== this.sel.c) { this.sel.r = rr; this.sel.c = cc; this.render(); this.syncFx(); this.updateStats(); } }
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  startResize(e, c) {
    e.preventDefault();
    e.stopPropagation();
    const start = e.clientX;
    const w0 = this.colW(c);
    this.pushUndo();
    const move = (ev) => { this.sheet.colW[c] = Math.max(28, w0 + ev.clientX - start); this.render(); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.markDirty(); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  startEdit(initial) {
    this.commitEdit();
    const { r, c } = this.sel;
    const cell = this.sheet.cells.get(r + ',' + c);
    const input = h('input', { class: 'sheet-editor', type: 'text', spellcheck: 'false' });
    input.setAttribute('list', this.fnList.id);
    input.value = initial != null ? initial : cell?.raw || '';
    this.editor = { input, r, c };
    this.grid.append(input);
    this.positionEditor();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.addEventListener('input', () => { this.fx.value = input.value; });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.commitEdit(); this.move(e.shiftKey ? -1 : 1, 0); this.grid.focus(); }
      else if (e.key === 'Tab') { e.preventDefault(); this.commitEdit(); this.move(0, e.shiftKey ? -1 : 1); this.grid.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit(); this.grid.focus(); }
      else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && initial != null) { e.preventDefault(); this.commitEdit(); this.move(e.key === 'ArrowUp' ? -1 : 1, 0); this.grid.focus(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { if (this.editor?.input === input && document.activeElement !== input) this.commitEdit(); }, 0));
  }

  positionEditor() {
    if (!this.editor) return;
    const { r, c, input } = this.editor;
    let x = 48;
    for (let i = 0; i < c; i++) x += this.colW(i);
    Object.assign(input.style, { left: x + 'px', top: (r + 1) * ROW_H + 'px', width: Math.max(this.colW(c), 120) + 'px', height: ROW_H + 'px' });
  }

  commitEdit() {
    if (!this.editor) return;
    const { input, r, c } = this.editor;
    this.editor = null;
    input.remove();
    this.setCell(r, c, input.value);
  }

  cancelEdit() {
    if (!this.editor) return;
    this.editor.input.remove();
    this.editor = null;
    this.syncFx();
  }

  // =================================================================== data changes

  snapshot() {
    return JSON.stringify({ active: this.active, sheets: this.sheets.map((s) => ({ ...s, cells: [...s.cells].map(([k, v]) => [k, v.raw, v.origRaw != null ? 1 : 0]) })) });
  }

  pushUndo() {
    this.undoStack.push({ json: this.snapshot(), origs: this.sheets.map((s) => new Map([...s.cells].filter(([, v]) => v.orig).map(([k, v]) => [k, v]))) });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  restoreState(state) {
    const d = JSON.parse(state.json);
    this.sheets = d.sheets.map((s, i) => ({
      ...s,
      cells: new Map(s.cells.map(([k, raw, hadOrig]) => {
        const o = hadOrig && state.origs[i]?.get(k);
        return [k, o ? { ...o, raw } : { raw }];
      })),
    }));
    this.active = Math.min(d.active, this.sheets.length - 1);
    this.recalc();
    this.renderTabs();
    this.render();
    this.syncFx();
    this.markDirty();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return toast('Nothing to undo', { timeout: 1200 });
    this.redoStack.push({ json: this.snapshot(), origs: this.sheets.map((sh) => new Map([...sh.cells].filter(([, v]) => v.orig).map(([k, v]) => [k, v]))) });
    this.restoreState(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push({ json: this.snapshot(), origs: this.sheets.map((sh) => new Map([...sh.cells].filter(([, v]) => v.orig).map(([k, v]) => [k, v]))) });
    this.restoreState(s);
  }

  setCell(r, c, raw, { record = true } = {}) {
    const s = this.sheet;
    const key = r + ',' + c;
    const old = s.cells.get(key);
    if ((old?.raw || '') === raw) { this.syncFx(); return; }
    if (record) this.pushUndo();
    if (raw === '') s.cells.delete(key);
    else s.cells.set(key, old?.orig ? { ...old, raw } : { raw });
    s.rows = Math.max(s.rows, r + 1);
    s.cols = Math.max(s.cols, c + 1);
    this.afterChange();
  }

  afterChange() {
    this.recalc();
    this.render();
    this.syncFx();
    this.updateStats();
    this.markDirty();
  }

  rangeBounds() {
    return {
      r1: Math.min(this.sel.r, this.sel.ar), r2: Math.max(this.sel.r, this.sel.ar),
      c1: Math.min(this.sel.c, this.sel.ac), c2: Math.max(this.sel.c, this.sel.ac),
    };
  }

  clearRange() {
    const { r1, r2, c1, c2 } = this.rangeBounds();
    this.pushUndo();
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) this.sheet.cells.delete(r + ',' + c);
    this.afterChange();
  }

  shift(kind, at, delta) {
    // insert/delete rows or columns by re-keying cells
    const s = this.sheet;
    this.pushUndo();
    const next = new Map();
    for (const [k, v] of s.cells) {
      let [r, c] = k.split(',').map(Number);
      if (kind === 'row') {
        if (delta < 0 && r === at) continue;
        if (r >= at + (delta < 0 ? 1 : 0)) r += delta;
      } else {
        if (delta < 0 && c === at) continue;
        if (c >= at + (delta < 0 ? 1 : 0)) c += delta;
      }
      next.set(r + ',' + c, v);
    }
    s.cells = next;
    if (kind === 'row') s.rows = Math.max(0, s.rows + delta);
    else { s.cols = Math.max(0, s.cols + delta); if (delta > 0) s.colW.splice(at, 0, undefined); else s.colW.splice(at, 1); }
    this.afterChange();
  }

  sort(desc) {
    const s = this.sheet;
    const col = this.sel.c;
    const { r1, r2 } = this.rangeBounds();
    let start = r1;
    let end = r2;
    if (r1 === r2) { start = 0; end = s.rows - 1; }
    if (end <= start) return;
    // treat the first row as a header if it is text over a numeric column
    const hdr = start === 0 && typeof this.getValue(0, col) === 'string' && typeof this.getValue(1, col) === 'number' ? 1 : 0;
    start += hdr;
    const rows = [];
    for (let r = start; r <= end; r++) {
      const cells = [];
      for (let c = 0; c < s.cols; c++) cells.push(s.cells.get(r + ',' + c));
      rows.push({ key: this.getValue(r, col), cells });
    }
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    rows.sort((a, b) => {
      const x = a.key, y = b.key;
      const empty = (v) => v === '' || v == null;
      if (empty(x) && !empty(y)) return 1;
      if (empty(y) && !empty(x)) return -1;
      const res = typeof x === 'number' && typeof y === 'number' ? x - y : coll.compare(String(x), String(y));
      return desc ? -res : res;
    });
    this.pushUndo();
    rows.forEach((row, i) => {
      const r = start + i;
      row.cells.forEach((cell, c) => { if (cell) s.cells.set(r + ',' + c, cell); else s.cells.delete(r + ',' + c); });
    });
    this.afterChange();
    toast(`Sorted by column ${colName(col)}${hdr ? ' (kept header row)' : ''}`, { type: 'ok', timeout: 1800 });
  }

  autofitColumn(c) {
    const s = this.sheet;
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '13px Inter, Segoe UI, sans-serif';
    let w = 40;
    for (let r = 0; r < Math.min(s.rows, 2000); r++) w = Math.max(w, ctx.measureText(this.display(r, c).text).width + 20);
    this.pushUndo();
    s.colW[c] = Math.min(600, Math.ceil(w));
    this.markDirty();
    this.render();
  }

  // =================================================================== clipboard

  rangeText(sep = '\t') {
    const { r1, r2, c1, c2 } = this.rangeBounds();
    const lines = [];
    for (let r = r1; r <= r2; r++) {
      const row = [];
      for (let c = c1; c <= c2; c++) { const t = this.display(r, c).text; row.push(/[\t\n"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t); }
      lines.push(row.join(sep));
    }
    return lines.join('\r\n');
  }

  onCopy(e, cut) {
    if (this.editor) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', this.rangeText());
    if (cut) this.clearRange();
  }

  onPaste(e) {
    if (this.editor) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const rows = parseDelimited(text.replace(/\r?\n$/, ''), text.includes('\t') ? '\t' : ',');
    this.pushUndo();
    rows.forEach((row, i) => row.forEach((v, j) => {
      const r = this.sel.r + i, c = this.sel.c + j, key = r + ',' + c;
      if (v === '') this.sheet.cells.delete(key); else this.sheet.cells.set(key, { raw: v });
      this.sheet.rows = Math.max(this.sheet.rows, r + 1);
      this.sheet.cols = Math.max(this.sheet.cols, c + 1);
    }));
    this.sel.ar = this.sel.r + rows.length - 1;
    this.sel.ac = this.sel.c + Math.max(...rows.map((r) => r.length)) - 1;
    [this.sel.r, this.sel.ar] = [this.sel.r, this.sel.ar];
    this.afterChange();
  }

  // =================================================================== keyboard

  onKey(e) {
    if (this.editor) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    const { rows } = this.dims();
    if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); return this.undo(); }
    if (ctrl && k.toLowerCase() === 'y') { e.preventDefault(); return this.redo(); }
    if (ctrl && k.toLowerCase() === 'a') { e.preventDefault(); this.sel = { r: Math.max(0, this.sheet.rows - 1), c: Math.max(0, this.sheet.cols - 1), ar: 0, ac: 0 }; this.render(); this.updateStats(); return; }
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) {
      e.preventDefault();
      let [dr, dc] = arrows[k];
      if (ctrl) { dr *= dr ? this.jump(dr, 0) : 0; dc *= dc ? this.jump(0, dc) : 0; }
      return this.move(dr, dc, e.shiftKey);
    }
    if (k === 'PageDown' || k === 'PageUp') { e.preventDefault(); return this.move((k === 'PageDown' ? 1 : -1) * Math.floor(this.grid.clientHeight / ROW_H), 0, e.shiftKey); }
    if (k === 'Home') { e.preventDefault(); return this.select(ctrl ? 0 : this.sel.r, 0); }
    if (k === 'End' && ctrl) { e.preventDefault(); return this.select(Math.max(0, this.sheet.rows - 1), Math.max(0, this.sheet.cols - 1)); }
    if (k === 'Enter') { e.preventDefault(); return this.move(e.shiftKey ? -1 : 1, 0); }
    if (k === 'Tab') { e.preventDefault(); return this.move(0, e.shiftKey ? -1 : 1); }
    if (k === 'F2') { e.preventDefault(); return this.startEdit(null); }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); return this.clearRange(); }
    if (!ctrl && !e.altKey && k.length === 1) { e.preventDefault(); this.startEdit(k); }
    void rows;
  }

  /** Distance to the edge of a data block (Ctrl+arrow). */
  jump(dr, dc) {
    let r = this.sel.r, c = this.sel.c, n = 0;
    const has = (rr, cc) => this.sheet.cells.has(rr + ',' + cc);
    const startFilled = has(r, c) && has(r + dr, c + dc);
    while (r + dr >= 0 && c + dc >= 0 && n < 100000) {
      const nf = has(r + dr, c + dc);
      if (startFilled ? !nf : nf) { if (!startFilled) { n++; } break; }
      r += dr; c += dc; n++;
      if (r > this.sheet.rows + 1 || c > this.sheet.cols + 1) break;
    }
    return Math.max(1, n);
  }

  // =================================================================== toolbar, menus, status

  contextItems() {
    return [
      { label: 'Cut', icon: 'cut', shortcut: 'Ctrl+X', action: () => { this.grid.focus(); document.execCommand('cut'); } },
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', action: () => { this.grid.focus(); document.execCommand('copy'); } },
      { label: 'Clear', icon: 'eraser', shortcut: 'Del', action: () => this.clearRange() },
      { sep: true },
      { label: 'Insert row above', icon: 'row-add', action: () => this.shift('row', this.rangeBounds().r1, 1) },
      { label: 'Insert row below', icon: 'row-add', action: () => this.shift('row', this.rangeBounds().r2 + 1, 1) },
      { label: 'Insert column left', icon: 'col-add', action: () => this.shift('col', this.rangeBounds().c1, 1) },
      { label: 'Insert column right', icon: 'col-add', action: () => this.shift('col', this.rangeBounds().c2 + 1, 1) },
      { label: 'Delete row', action: () => this.shift('row', this.sel.r, -1) },
      { label: 'Delete column', action: () => this.shift('col', this.sel.c, -1) },
      { sep: true },
      { label: 'Sort A → Z by this column', icon: 'sort', action: () => this.sort(false) },
      { label: 'Sort Z → A by this column', action: () => this.sort(true) },
      { label: 'Auto-fit column width', action: () => this.autofitColumn(this.sel.c) },
    ];
  }

  buildToolbar() {
    return h('div', { class: 'toolbar' },
      tbButton('undo', 'Undo', () => this.undo(), { key: 'Ctrl+Z' }),
      tbButton('redo', 'Redo', () => this.redo(), { key: 'Ctrl+Y' }),
      tbSep(),
      tbButton('row-add', 'Insert row above', () => this.shift('row', this.rangeBounds().r1, 1)),
      tbButton('col-add', 'Insert column left', () => this.shift('col', this.rangeBounds().c1, 1)),
      tbButton('trash', 'Delete row / column', (e) => showMenu([{ label: 'Delete row', action: () => this.shift('row', this.sel.r, -1) }, { label: 'Delete column', action: () => this.shift('col', this.sel.c, -1) }], { anchor: e.currentTarget })),
      tbSep(),
      tbButton('sort', 'Sort by this column', (e) => showMenu([{ label: 'A → Z / smallest first', action: () => this.sort(false) }, { label: 'Z → A / largest first', action: () => this.sort(true) }], { anchor: e.currentTarget })),
      tbButton('wand', 'Insert a function', (e) => showMenu(['SUM', 'AVERAGE', 'COUNT', 'MIN', 'MAX', 'IF', 'ROUND', 'VLOOKUP', 'SUMIF', 'COUNTIF', 'CONCAT', 'TODAY'].map((f) => ({ label: f, action: () => this.insertFunction(f) })).concat([{ sep: true }, { label: `All functions (${FUNCTION_NAMES.length})`, submenu: FUNCTION_NAMES.map((f) => ({ label: f, action: () => this.insertFunction(f) })) }]), { anchor: e.currentTarget })),
      tbButton('fit-width', 'Auto-fit column', () => this.autofitColumn(this.sel.c)),
      tbSep(),
      tbButton('search', 'Find', () => this.find(false), { key: 'Ctrl+F' }),
      tbButton('replace', 'Replace', () => this.find(true), { key: 'Ctrl+H' }),
    );
  }

  insertFunction(f) {
    const { r1, r2, c1, c2 } = this.rangeBounds();
    const multi = r1 !== r2 || c1 !== c2;
    if (multi && ['SUM', 'AVERAGE', 'COUNT', 'MIN', 'MAX'].includes(f)) {
      // write the result just below the selected column(s)
      this.pushUndo();
      for (let c = c1; c <= c2; c++) this.setCell(r2 + 1, c, `=${f}(${refName(r1, c)}:${refName(r2, c)})`, { record: false });
      this.select(r2 + 1, c1);
      return;
    }
    this.startEdit(`=${f}(`);
  }

  menus() {
    return {
      edit: [
        { label: 'Clear cells', icon: 'eraser', shortcut: 'Del', action: () => this.clearRange() },
        { label: 'Go to cell…', action: async () => { const v = await promptDialog('Go to', 'Cell (e.g. B12)', ''); const ref = v && parseRef(v.trim()); if (ref) this.select(ref.r, ref.c); } },
      ],
      insert: [
        { label: 'Row above', icon: 'row-add', action: () => this.shift('row', this.rangeBounds().r1, 1) },
        { label: 'Row below', icon: 'row-add', action: () => this.shift('row', this.rangeBounds().r2 + 1, 1) },
        { label: 'Column left', icon: 'col-add', action: () => this.shift('col', this.rangeBounds().c1, 1) },
        { label: 'Column right', icon: 'col-add', action: () => this.shift('col', this.rangeBounds().c2 + 1, 1) },
        { label: 'Sheet', icon: 'plus', action: () => this.addSheet() },
        { sep: true },
        { label: 'Function', icon: 'wand', submenu: FUNCTION_NAMES.map((f) => ({ label: f, action: () => this.insertFunction(f) })) },
        { label: 'Today’s date', icon: 'calendar', action: () => this.setCell(this.sel.r, this.sel.c, new Date().toLocaleDateString()) },
      ],
      tools: [
        { label: 'Sort A → Z', icon: 'sort', action: () => this.sort(false) },
        { label: 'Sort Z → A', action: () => this.sort(true) },
        { label: 'Auto-fit column width', action: () => this.autofitColumn(this.sel.c) },
        { label: 'Recalculate', icon: 'refresh', action: () => { this.astCache.clear(); this.recalc(); this.render(); } },
      ],
    };
  }

  updateStats() {
    if (!this.statsEl) return;
    const { r1, r2, c1, c2 } = this.rangeBounds();
    const cells = (r2 - r1 + 1) * (c2 - c1 + 1);
    if (cells < 2 || cells > 200000) { this.statsEl.textContent = ''; return; }
    let sum = 0, n = 0, count = 0, min = Infinity, max = -Infinity;
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      if (!this.sheet.cells.has(r + ',' + c)) continue;
      count++;
      const v = this.getValue(r, c);
      if (typeof v === 'number') { sum += v; n++; min = Math.min(min, v); max = Math.max(max, v); }
    }
    const f = (x) => formatNum(Math.abs(x) >= 1 ? Number(x.toFixed(4)) : Number(x.toPrecision(4)));
    this.statsEl.textContent = n ? `sum ${f(sum)}  ·  avg ${f(sum / n)}  ·  min ${f(min)}  ·  max ${f(max)}  ·  count ${count}` : count ? `count ${count}` : '';
  }

  status() {
    const s = this.sheet;
    return {
      left: [{ text: this.nameBox?.value || 'A1' }, { text: `${s.rows} rows × ${s.cols} cols` }, { text: `${this.sheets.length} sheet${this.sheets.length > 1 ? 's' : ''}` }],
      right: this.sep ? [{ text: this.sep === '\t' ? 'tab-separated' : `“${this.sep}” separated` }] : [],
    };
  }

  // =================================================================== find

  find(replace) {
    if (!this.findBar) {
      const self = this;
      let hits = [];
      let idx = -1;
      let lastQ = null;
      this.findBar = new FindBar(this.root, {
        canReplace: true,
        find(q, opts) {
          lastQ = { q, opts };
          const re = buildRegex(q, opts);
          hits = [];
          for (const [k, v] of self.sheet.cells) { re.lastIndex = 0; if (re.test(v.raw) || (re.lastIndex = 0, re.test(self.display(...k.split(',').map(Number)).text))) hits.push(k.split(',').map(Number)); }
          hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
          self.findSet = new Set(hits.map(([r, c]) => r + ',' + c));
          idx = hits.length ? 0 : -1;
          if (idx >= 0) self.select(hits[0][0], hits[0][1]); else self.render();
          return { count: hits.length, index: idx };
        },
        next() { if (!hits.length) return { count: 0, index: -1 }; idx = (idx + 1) % hits.length; self.select(...hits[idx]); return { count: hits.length, index: idx }; },
        prev() { if (!hits.length) return { count: 0, index: -1 }; idx = (idx - 1 + hits.length) % hits.length; self.select(...hits[idx]); return { count: hits.length, index: idx }; },
        replace(t) {
          const cur = hits[idx];
          if (!cur || !lastQ) return { count: 0, index: -1 };
          const cell = self.sheet.cells.get(cur.join(','));
          self.setCell(cur[0], cur[1], cell.raw.replace(buildRegex(lastQ.q, lastQ.opts), lastQ.opts.regex ? t : () => t));
          return this.find(lastQ.q, lastQ.opts);
        },
        replaceAll(t) {
          if (!lastQ) return 0;
          self.pushUndo();
          let n = 0;
          for (const [r, c] of hits) {
            const cell = self.sheet.cells.get(r + ',' + c);
            const out = cell.raw.replace(buildRegex(lastQ.q, lastQ.opts), lastQ.opts.regex ? t : () => t);
            if (out !== cell.raw) { n++; if (out === '') self.sheet.cells.delete(r + ',' + c); else self.sheet.cells.set(r + ',' + c, cell.orig ? { ...cell, raw: out } : { raw: out }); }
          }
          self.afterChange();
          return n;
        },
        clear() { self.findSet = null; self.render(); },
        onClose() { self.grid.focus(); },
      });
    }
    this.findBar.open(replace);
  }

  // =================================================================== io

  saveFormats() {
    return [
      { ext: 'xlsx', name: 'Excel workbook' },
      { ext: 'csv', name: 'CSV (comma-separated)' },
      { ext: 'tsv', name: 'TSV (tab-separated)' },
      { ext: 'ods', name: 'OpenDocument spreadsheet' },
      { ext: 'xlsm', name: 'Excel macro-enabled workbook' },
      { ext: 'xls', name: 'Excel 97-2003 workbook' },
    ];
  }

  lossyFormat(ext) { return (ext === 'csv' || ext === 'tsv') && (this.sheets.length > 1 || [...this.sheet.cells.values()].some((c) => c.raw.startsWith('='))); }

  async serialize(ext) {
    this.commitEdit();
    if (ext === 'csv' || ext === 'tsv') {
      const sep = ext === 'tsv' ? '\t' : this.sep && this.sep !== '\t' ? this.sep : ',';
      const s = this.sheet;
      const lines = [];
      for (let r = 0; r < s.rows; r++) {
        const row = [];
        for (let c = 0; c < s.cols; c++) {
          const cell = s.cells.get(r + ',' + c);
          let t = '';
          if (cell) t = cell.raw.startsWith('=') ? this.display(r, c).text : cell.raw;
          row.push(t.includes(sep) || /["\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
        }
        lines.push(row.join(sep));
      }
      const text = lines.join('\r\n') + '\r\n';
      return encodeText(text, 'utf-8', /[^\x00-\x7f]/.test(text));
    }
    const X = this.XLSX;
    const wb = X.utils.book_new();
    if (this.workbookProps) wb.Props = this.workbookProps;
    const prevActive = this.active;
    this.sheets.forEach((s, i) => {
      this.active = i;
      this.recalc();
      const ws = {};
      let maxR = 0, maxC = 0;
      for (const [k, cell] of s.cells) {
        const [r, c] = k.split(',').map(Number);
        maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
        const addr = X.utils.encode_cell({ r, c });
        const v = this.getValue(r, c);
        if (cell.orig && cell.raw === cell.origRaw) {
          const o = { ...cell.orig };
          if (cell.raw.startsWith('=')) { if (!isErr(v) && !v?.code) { o.v = v; o.t = typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : 's'; } delete o.w; }
          ws[addr] = o;
        } else if (cell.raw.startsWith('=')) {
          const val = isErr(v) || v?.code ? undefined : v;
          ws[addr] = { f: cell.raw.slice(1), t: typeof val === 'number' ? 'n' : typeof val === 'boolean' ? 'b' : 's', v: val ?? '' };
        } else if (typeof v === 'number') ws[addr] = { t: 'n', v };
        else if (typeof v === 'boolean') ws[addr] = { t: 'b', v };
        else ws[addr] = { t: 's', v: cell.raw };
      }
      ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(maxR, s.rows - 1, 0), c: Math.max(maxC, s.cols - 1, 0) } });
      if (s.colW.some(Boolean)) ws['!cols'] = Array.from({ length: Math.max(s.colW.length, maxC + 1) }, (_, c) => ({ wpx: this.colW(c) }));
      if (s.merges) ws['!merges'] = s.merges;
      X.utils.book_append_sheet(wb, ws, s.name || `Sheet${i + 1}`);
    });
    this.active = prevActive;
    this.recalc();
    const bookType = ext === 'xls' ? 'biff8' : ext;
    return new Uint8Array(X.write(wb, { bookType, type: 'array', compression: true }));
  }

  afterSave(path, ext) { if (ext === 'csv' || ext === 'tsv') this.sep = ext === 'tsv' ? '\t' : this.sep && this.sep !== '\t' ? this.sep : ','; }

  getDraft() { return this.snapshot(); }
  restoreDraft(content) {
    try {
      const d = JSON.parse(content);
      this.sheets = d.sheets.map((s) => ({ ...s, cells: new Map(s.cells.map(([k, raw]) => [k, { raw }])) }));
      this.active = Math.min(d.active || 0, this.sheets.length - 1);
    } catch { /* ignore */ }
    if (this.grid) { this.recalc(); this.renderTabs(); this.render(); }
  }

  getSelectionText() {
    const { r1, r2, c1, c2 } = this.rangeBounds();
    return r1 === r2 && c1 === c2 ? '' : this.rangeText();
  }

  getContextText() {
    const s = this.sheet;
    const lines = [];
    for (let r = 0; r < Math.min(s.rows, 5000); r++) {
      const row = [];
      for (let c = 0; c < s.cols; c++) row.push(this.display(r, c).text);
      lines.push(row.join('\t'));
    }
    return `sheet "${s.name}" (tab-separated, row 1 first):\n` + lines.join('\n');
  }

  insertText(t) {
    if (this.editor) { this.editor.input.focus(); document.execCommand('insertText', false, t); return true; }
    this.startEdit((this.sheet.cells.get(this.sel.r + ',' + this.sel.c)?.raw || '') + t);
    return true;
  }

  focus() { if (!this.editor) this.grid?.focus({ preventScroll: true }); }
  zoom(delta) {
    this.zoomLevel = delta === 0 ? 1 : clamp((this.zoomLevel || 1) + delta * 0.1, 0.6, 2);
    this.root.style.setProperty('zoom', this.zoomLevel);
  }
  print() {
    const s = this.sheet;
    const w = window.open('', '_blank', 'width=1000,height=760');
    if (!w) return toast('Allow pop-ups to print.', { type: 'warn' });
    let rows = '';
    for (let r = 0; r < s.rows; r++) {
      rows += '<tr>';
      for (let c = 0; c < s.cols; c++) { const d = this.display(r, c); rows += `<td${d.num ? ' style="text-align:right"' : ''}>${escapeHtml(d.text)}</td>`; }
      rows += '</tr>';
    }
    w.document.write(`<!doctype html><title>${escapeHtml(s.name)}</title><style>body{font:10pt Calibri,Arial,sans-serif}table{border-collapse:collapse}td{border:1px solid #bbb;padding:2px 6px;white-space:nowrap}@page{margin:12mm}</style><table>${rows}</table>`);
    w.document.close();
    setTimeout(() => { w.print(); w.close(); }, 200);
  }
}

function formatNum(v) {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(12)));
}

export function parseDelimited(text, sep) {
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += ch;
    } else if (ch === '"' && f === '') q = true;
    else if (ch === sep) { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
