// BoxTerminal: a shell window inside the app (Windows PowerShell, PowerShell 7 or Command Prompt on Windows),
// started in any folder you pick. Type a command and press Enter; Up/Down walk your history, Tab completes,
// Shift+Enter adds a line, Ctrl+C stops what's running, Ctrl+L clears. It's a command shell, not a full terminal
// emulator: programs that take over the screen or wait for a keypress (vim, less, "Press any key") won't work.

import { BaseEditor } from './base.js';
import { h, clear, clamp, basename } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { tbButton, tbSep, toast, errorToast, showMenu, contextMenu, confirmDialog } from '../core/ui.js';
import { pickFolder } from '../core/files.js';

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`bdsterm.${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`bdsterm.${k}`, JSON.stringify(v)); } catch { /* private window */ } },
};
const ANSI = ['#555', '#e5484d', '#30a46c', '#f5a524', '#3e8ef7', '#b36bd9', '#2bb3c0', '#cfcfd4'];
const ANSI_BRIGHT = ['#8a8a92', '#ff7b7f', '#52d68c', '#ffc857', '#6aa8ff', '#d492f0', '#5ad4df', '#ffffff'];
const MAX_CHARS = 1500000;

export class TerminalEditor extends BaseEditor {
  static mode = 'terminal';

  async load(bytes, opts = {}) {
    this.history = store.get('history', []);
    this.hIdx = -1;
    this.pos = 0; // how much output has been read
    this.size = 0; // characters on screen
    this.busy = false;
    this.cwd = '';
    this.sgr = { fg: null, bold: false };
    this.buildUI();
    try {
      const info = await api.get('/api/term/shells');
      this.shells = info.shells;
      this.home = info.home;
      this.shell = store.get('shell', info.shells[0].id);
      if (!info.shells.some((s) => s.id === this.shell)) this.shell = info.shells[0].id;
      await this.start(opts.cwd || store.get('lastDir', info.home));
    } catch (e) { this.note(`Couldn’t start a shell: ${e.message}\n`, 'err'); }
  }

  async start(dir) {
    if (this.id) { api.post('/api/term/close', { id: this.id }).catch(() => {}); this.id = null; }
    try {
      const r = await api.post('/api/term/start', { cwd: dir, shell: this.shell });
      this.id = r.id; this.cwd = r.cwd; this.shell = r.shell; this.pos = 0;
    } catch (e) {
      if (dir !== this.home) { toast(`Couldn’t open ${dir}: ${e.message}`, { type: 'warn' }); return this.start(this.home); }
      throw e;
    }
    this.setTitle();
    this.renderPrompt();
    this.schedule(120);
    this.input.focus();
  }

  // ================================================================ talking to the shell

  schedule(ms) { clearTimeout(this.t); if (!this.closed) this.t = setTimeout(() => this.pollOut(), ms); }

  async pollOut() {
    if (!this.id || this.closed) return;
    let wait = 700;
    try {
      const r = await api.get(`/api/term/read?id=${this.id}&from=${this.pos}`);
      this.pos = r.next;
      for (const c of r.chunks) {
        if (c.k === 'out') this.write(c.t, false);
        else if (c.k === 'err') this.write(c.t, true);
        else if (c.k === 'note') this.note(c.t, 'note');
        else if (c.k === 'exit') { this.note('[the shell closed. Press Enter to start a new one]\n', 'note'); }
        else if (c.k === 'done') { this.cwd = c.cwd || this.cwd; }
      }
      this.cwd = r.cwd || this.cwd;
      const was = this.busy;
      this.busy = r.busy;
      if (was !== this.busy || r.chunks.length) { this.renderPrompt(); this.setTitle(); this.refreshStatus(); }
      wait = this.busy || r.chunks.length ? 90 : document.hidden || !this.visible ? 2000 : 600;
    } catch (e) {
      if (e.status === 404) { this.id = null; this.note('[that shell is gone. Press Enter to start a new one]\n', 'note'); return; }
    }
    this.schedule(wait);
  }

  async run(text) {
    if (!this.id) { await this.start(this.cwd || this.home); }
    if (this.busy) return;
    this.echo(text);
    this.busy = true;
    this.renderPrompt();
    try {
      await api.post('/api/term/send', { id: this.id, cmd: text });
    } catch (e) { this.busy = false; this.note(`${e.message}\n`, 'err'); this.renderPrompt(); }
    this.schedule(30);
  }

  async stop() {
    if (!this.id) return;
    try { await api.post('/api/term/interrupt', { id: this.id }); } catch (e) { errorToast(e); }
    this.busy = false;
    this.schedule(20);
  }

  // ================================================================ the screen

  buildUI() {
    this.out = h('div', { class: 'tm-out' });
    this.promptEl = h('span', { class: 'tm-prompt' });
    this.input = h('textarea', { class: 'tm-in', rows: '1', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off',
      onkeydown: (e) => this.keydown(e), oninput: () => { this.fit(); this.hIdx = -1; } });
    this.sugg = h('div', { class: 'tm-sugg', hidden: true });
    this.inRow = h('div', { class: 'tm-inrow' }, this.promptEl, this.input);
    this.screen = h('div', { class: 'tm-screen', onclick: (e) => { if (!window.getSelection().toString() && e.target.closest('.tm-screen')) this.input.focus(); } }, this.out, this.inRow);
    this.root = h('div', { class: 'tm' }, this.screen, this.sugg);
    this.pane.append(this.root);
    this.screen.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Copy', icon: 'copy', disabled: !window.getSelection().toString(), action: () => navigator.clipboard.writeText(window.getSelection().toString()) },
      { label: 'Paste', icon: 'paste', action: async () => { try { this.insert(await navigator.clipboard.readText()); } catch { /* denied */ } } },
      { sep: true },
      { label: 'Copy all output', icon: 'copy', action: () => navigator.clipboard.writeText(this.out.textContent).then(() => toast('Copied')) },
      { label: 'Clear', icon: 'trash', action: () => this.clear() },
    ]));
    this.visible = true;
  }

  buildToolbar() {
    this.shellBtn = tbButton('terminal', 'Which shell', (e) => showMenu((this.shells || []).map((s) => ({ label: s.name, checked: s.id === this.shell, action: () => this.switchShell(s.id) })), { anchor: e.currentTarget }), { text: 'Shell' });
    return h('div', { class: 'toolbar' },
      tbButton('folder-open', 'Run in a different folder', () => this.chooseFolder(), { text: 'Folder…' }),
      tbButton('external', 'Show this folder in Explorer', () => this.cwd && api.post('/api/reveal', { path: this.cwd }).catch(() => {})),
      tbSep(), this.shellBtn,
      tbSep(),
      tbButton('square', 'Stop the running command (Ctrl+C)', () => this.stop()),
      tbButton('trash', 'Clear the screen (Ctrl+L)', () => this.clear()),
      tbButton('copy', 'Copy all the output', () => navigator.clipboard.writeText(this.out.textContent).then(() => toast('Copied'))),
      tbButton('refresh', 'Start this shell over (forget variables)', () => this.restart()),
      h('span', { class: 'tb-label' }, 'terminal'));
  }

  status() { return { left: [{ text: this.cwd || '' }], right: [{ text: this.busy ? 'running…' : (this.shells?.find((s) => s.id === this.shell)?.name || '') }] }; }
  setTitle() { this.tab.title = this.cwd ? `${this.app.toolName('BoxTerminal')} · ${basename(this.cwd.replace(/[\\/]+$/, '')) || this.cwd}` : this.app.toolName('BoxTerminal'); this.app.renderTabs?.(); }

  renderPrompt() {
    const ps = this.shell === 'powershell' || this.shell === 'pwsh';
    this.promptEl.textContent = this.busy ? '' : ps ? `PS ${this.cwd}> ` : this.shell === 'cmd' ? `${this.cwd}> ` : `${this.cwd}$ `;
    this.input.disabled = false;
    this.inRow.classList.toggle('busy', this.busy);
    this.input.placeholder = this.busy ? 'running… (Ctrl+C to stop)' : '';
  }

  fit() { this.input.style.height = 'auto'; this.input.style.height = `${Math.min(220, this.input.scrollHeight)}px`; }

  /** Append output text, understanding the colour codes shells like to send. */
  write(text, isErr) {
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '');
    const re = /\x1b\[([0-9;]*)([A-Za-z])/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      this.span(text.slice(last, m.index), isErr);
      last = re.lastIndex;
      if (m[2] === 'm') this.sgrApply(m[1].split(';').map(Number));
    }
    this.span(text.slice(last), isErr);
    this.trimOut();
    this.stick();
  }
  sgrApply(codes) {
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i] || 0;
      if (c === 0) this.sgr = { fg: null, bold: false };
      else if (c === 1) this.sgr.bold = true;
      else if (c === 22) this.sgr.bold = false;
      else if (c >= 30 && c <= 37) this.sgr.fg = (this.sgr.bold ? ANSI_BRIGHT : ANSI)[c - 30];
      else if (c >= 90 && c <= 97) this.sgr.fg = ANSI_BRIGHT[c - 90];
      else if (c === 39) this.sgr.fg = null;
      else if (c === 38 && codes[i + 1] === 2) { this.sgr.fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
      else if (c === 38 && codes[i + 1] === 5) { this.sgr.fg = null; i += 2; }
    }
  }
  span(t, isErr) {
    if (!t) return;
    const s = h('span', { class: isErr ? 'err' : '' }, t);
    if (this.sgr.fg && !isErr) s.style.color = this.sgr.fg;
    if (this.sgr.bold) s.style.fontWeight = '700';
    this.out.append(s);
    this.size += t.length;
  }
  echo(text) {
    const s = h('span', { class: 'cmd' }, `${this.promptEl.textContent}${text}\n`);
    this.out.append(s);
    this.size += s.textContent.length;
    this.stick(true);
  }
  note(t, cls) { this.out.append(h('span', { class: cls }, t)); this.size += t.length; this.stick(); }
  trimOut() { while (this.size > MAX_CHARS && this.out.firstChild) { this.size -= this.out.firstChild.textContent.length; this.out.firstChild.remove(); } }
  stick(force) {
    const el = this.screen;
    if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 140) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }
  clear() { clear(this.out); this.size = 0; this.input.focus(); }

  // ================================================================ keys, history, completion

  insert(t) {
    const i = this.input, a = i.selectionStart, b = i.selectionEnd;
    i.value = i.value.slice(0, a) + t + i.value.slice(b);
    i.selectionStart = i.selectionEnd = a + t.length;
    this.fit();
  }

  keydown(e) {
    const i = this.input;
    if (!this.sugg.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.moveSugg(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.takeSugg(); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.hideSugg(); return; }
      this.hideSugg();
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = i.value;
      if (this.busy) return;
      i.value = ''; this.fit();
      if (text.trim()) { this.history = [...this.history.filter((x) => x !== text), text].slice(-300); store.set('history', this.history); }
      this.hIdx = -1;
      if (text.trim() === 'cls' || text.trim() === 'clear') { if (this.shell !== 'cmd' || text.trim() === 'cls') { this.clear(); return; } }
      this.run(text);
    } else if (e.key === 'ArrowUp' && (i.selectionStart === 0 || !i.value.includes('\n'))) {
      if (!this.history.length) return;
      e.preventDefault();
      if (this.hIdx < 0) { this.draft = i.value; this.hIdx = this.history.length; }
      this.hIdx = Math.max(0, this.hIdx - 1);
      i.value = this.history[this.hIdx]; this.fit(); i.selectionStart = i.selectionEnd = i.value.length;
    } else if (e.key === 'ArrowDown' && this.hIdx >= 0 && (i.selectionEnd === i.value.length || !i.value.includes('\n'))) {
      e.preventDefault();
      this.hIdx++;
      if (this.hIdx >= this.history.length) { this.hIdx = -1; i.value = this.draft || ''; } else i.value = this.history[this.hIdx];
      this.fit(); i.selectionStart = i.selectionEnd = i.value.length;
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      this.complete();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'c' && (this.busy || i.selectionStart === i.selectionEnd)) {
      e.preventDefault();
      if (this.busy) this.stop(); else { this.echo(`${i.value}^C`); i.value = ''; this.fit(); }
    } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault(); this.clear();
    } else if (e.key === 'Escape') { i.value = ''; this.fit(); }
  }

  async complete() {
    if (this.busy || !this.id) return;
    const i = this.input;
    try {
      const r = await api.post('/api/term/complete', { id: this.id, line: i.value, pos: i.selectionStart });
      const items = r.items || [];
      if (!items.length) return;
      const apply = (it) => { i.value = i.value.slice(0, r.from) + it.t + i.value.slice(r.from + r.len); i.selectionStart = i.selectionEnd = r.from + it.t.length; this.fit(); };
      if (items.length === 1) { apply(items[0]); return; }
      // several: finish the shared start, then offer the list
      let common = items[0].t;
      for (const it of items) { while (!it.t.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1); }
      const typed = i.value.slice(r.from, r.from + r.len);
      if (common.length > typed.length) { apply({ t: common }); r.len = common.length; }
      this.showSugg(items, r, apply);
    } catch { /* no completion */ }
  }
  showSugg(items, r, apply) {
    this.suggItems = items; this.suggIdx = 0; this.suggApply = apply;
    clear(this.sugg).append(...items.slice(0, 40).map((it, k) => h('div', { class: `tm-s ${k === 0 ? 'on' : ''}`, onmousedown: (e) => { e.preventDefault(); this.suggIdx = k; this.takeSugg(); } },
      icon(/Container/.test(it.k) ? 'folder' : /Command/.test(it.k) ? 'terminal' : /Parameter/.test(it.k) ? 'minus' : 'file', 'sm'), h('span', {}, it.l || it.t))));
    this.sugg.hidden = false;
  }
  moveSugg(d) {
    const els = [...this.sugg.children];
    this.suggIdx = (this.suggIdx + d + els.length) % els.length;
    els.forEach((el, k) => el.classList.toggle('on', k === this.suggIdx));
    els[this.suggIdx].scrollIntoView({ block: 'nearest' });
  }
  takeSugg() { const it = this.suggItems?.[this.suggIdx]; this.hideSugg(); if (it) this.suggApply(it); this.input.focus(); }
  hideSugg() { this.sugg.hidden = true; }

  // ================================================================ the rest

  async chooseFolder() {
    const dir = await pickFolder({ title: 'Run the terminal in…', initialDir: this.cwd || undefined });
    if (!dir) return;
    store.set('lastDir', dir);
    if (this.busy) { toast('Wait for the running command to finish, or stop it first.'); return; }
    try { await api.post('/api/term/cd', { id: this.id, dir }); this.busy = true; this.schedule(30); } catch (e) { errorToast(e); }
    this.input.focus();
  }

  async switchShell(id) {
    if (id === this.shell) return;
    this.shell = id;
    store.set('shell', id);
    this.note(`\n— switched to ${this.shells.find((s) => s.id === id)?.name} —\n`, 'note');
    await this.start(this.cwd || this.home);
  }
  async restart() { this.note('\n— fresh shell —\n', 'note'); await this.start(this.cwd || this.home); }

  async beforeClose() {
    if (!this.busy) return true;
    this.app.activate?.(this.tab);
    return confirmDialog('Close the terminal', 'A command is still running. Close it anyway and stop it?', { okLabel: 'Close', danger: true });
  }

  focus() { this.input?.focus(); }
  onShow() { this.visible = true; this.stick(true); this.input?.focus(); }
  onHide() { this.visible = false; }
  destroy() {
    this.closed = true;
    clearTimeout(this.t);
    if (this.id) api.post('/api/term/close', { id: this.id }).catch(() => {});
  }
}
