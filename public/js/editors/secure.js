// Secure notes: passwords and private notes, encrypted by the app window's own process (electron/secure-notes.js).
// This page only ever holds what's on screen: passwords come over one at a time (hold the eye to see one) and
// copying goes straight from that process to the clipboard. It locks whenever you leave the tab, so opening it
// always asks for the PIN.

import { BaseEditor } from './base.js';
import { h, clear, timeAgo } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, errorToast, contextMenu, modal, confirmDialog } from '../core/ui.js';
import { pickOpen, pickSave } from '../core/files.js';

const bridge = () => window.bdsShell?.notes;
async function call(op, args = {}) {
  const r = await bridge()({ op, ...args });
  if (!r?.ok) throw Object.assign(new Error(r?.error || 'Something went wrong'), { code: r?.code });
  return r;
}

/** Password / PIN box with a hold-to-show eye (shows only while the button is held). */
function secretInput({ placeholder = '', autocomplete = 'off', value = '', cls = '' } = {}) {
  const input = h('input', { type: 'password', class: `sn-input ${cls}`, placeholder, autocomplete, spellcheck: 'false', value });
  const eye = h('button', { class: 'icon-btn sn-eye', type: 'button', tabindex: '-1', title: 'Hold to show' }, icon('eye', 'sm'));
  const show = (on) => { input.type = on ? 'text' : 'password'; };
  eye.addEventListener('pointerdown', (e) => { e.preventDefault(); show(true); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) eye.addEventListener(ev, () => show(false));
  return { input, el: h('div', { class: 'sn-secret' }, input, eye) };
}

/** The secure key typed as XXXX-XXXX-…: capitals and dashes added as you type. */
function keyInput() {
  const input = h('input', { class: 'sn-input sn-key-input mono', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX', autocomplete: 'off', spellcheck: 'false', maxlength: '29' });
  input.addEventListener('input', () => {
    const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
    input.value = raw.match(/.{1,4}/g)?.join('-') || '';
  });
  return input;
}

export class SecureNotesEditor extends BaseEditor {
  static mode = 'secure';
  secret = true; // the Claude panel, Ctrl+right-click sends and drafts leave this tab alone

  async load() {
    this.root = h('div', { class: 'sn-root', 'data-no-clip': '' });
    this.pane.append(this.root);
    this.entries = [];
    this.sel = null;
    this.query = '';
    this.onLocked = () => { if (this.view === 'open') this.render(); };
    window.addEventListener('bds:notes-locked', this.onLocked);
    // any use of the tab keeps the auto-lock timer from running out (at most every 15 s)
    let last = 0;
    this.activity = () => { if (this.view === 'open' && Date.now() - last > 15000) { last = Date.now(); bridge()?.({ op: 'touch' }); } };
    this.root.addEventListener('pointerdown', this.activity);
    this.root.addEventListener('keydown', this.activity);
    if (!bridge()) return this.renderUnavailable();
    // opening the tab always asks for the PIN: anything left open is locked first
    await bridge()({ op: 'lock' });
    await this.render();
  }

  async render(msg) {
    let st;
    try { st = await call('status'); } catch (e) { return this.screen('Secure notes', h('p', { class: 'sn-error' }, e.message)); }
    this.st = st;
    if (!st.platform) return this.renderUnavailable('Secure notes need Windows.');
    if (!st.exists) return this.renderSetup();
    if (st.unlocked) return this.renderOpen();
    if (st.needsKey) return this.renderKeyCheck(msg);
    if (st.pinReady) return this.renderPin(msg);
    return this.renderPassphrase(msg);
  }

  /** A centered card (setup / lock screens). */
  screen(title, ...body) {
    this.view = 'lock';
    this.refreshStatus();
    clear(this.root).append(h('div', { class: 'sn-center' }, h('div', { class: 'sn-card' },
      h('div', { class: 'sn-badge' }, icon('lock', 'lg')),
      h('h2', {}, title), ...body)));
    setTimeout(() => this.root.querySelector('input')?.focus(), 30);
  }

  renderUnavailable(why) {
    this.screen('Secure notes', h('p', { class: 'dim' }, why || 'Secure notes only open in the Box-DocSpitter app window, not in a browser tab. They’re encrypted by the app itself and never pass through the browser.'));
  }

  busy(btn, text, fn) {
    return async () => {
      if (btn.disabled) return;
      const old = btn.textContent;
      btn.disabled = true;
      btn.textContent = text;
      try { await fn(); } catch (e) { this.showError(e); } finally { btn.disabled = false; btn.textContent = old; }
    };
  }

  showError(e) {
    const el = this.root.querySelector('.sn-error');
    if (el) { el.textContent = e.message; el.hidden = false; } else errorToast(e);
  }

  // ------------------------------------------------------------------ first-time setup

  renderSetup() {
    const pass = secretInput({ placeholder: 'Passphrase (10+ characters — a few random words is best)', autocomplete: 'new-password' });
    const pass2 = secretInput({ placeholder: 'Passphrase again', autocomplete: 'new-password' });
    const pin = secretInput({ placeholder: 'PIN (4+ letters, numbers or symbols)', autocomplete: 'new-password' });
    const pin2 = secretInput({ placeholder: 'PIN again', autocomplete: 'new-password' });
    const err = h('div', { class: 'sn-error', hidden: true });
    const go = h('button', { class: 'btn primary' }, 'Set up Secure notes');
    go.addEventListener('click', this.busy(go, 'Encrypting…', async () => {
      const p = pass.input.value;
      if (p.length < 10) throw new Error('Use a passphrase of at least 10 characters.');
      if (p !== pass2.input.value) throw new Error('The two passphrases don’t match.');
      if (!/^\S{4,32}$/u.test(pin.input.value)) throw new Error('A PIN is 4 to 32 letters, numbers or symbols (no spaces).');
      if (pin.input.value !== pin2.input.value) throw new Error('The two PINs don’t match.');
      const r = await call('create', { passphrase: p, pin: pin.input.value });
      this.renderKeyReveal(r.secureKey);
    }));
    for (const x of [pass, pass2, pin, pin2]) x.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    this.screen('Set up Secure notes',
      h('p', { class: 'dim' }, 'Passwords and private notes, encrypted on this PC. Only this app can open them.'),
      h('ul', { class: 'sn-points' },
        h('li', {}, h('b', {}, 'Passphrase'), ' — opens them after the app starts. Without it (and this PC) the file is useless.'),
        h('li', {}, h('b', {}, 'PIN'), ' — asked every time you open Secure notes.'),
        h('li', {}, h('b', {}, 'Secure key'), ' — made for you next. Every 30 days it’s asked for again, and it (with your PIN) opens your notes on a new PC.')),
      pass.el, pass2.el, pin.el, pin2.el, err, h('div', { class: 'sn-actions' }, go));
  }

  /** The secure key, shown once. */
  renderKeyReveal(key) {
    const ok = h('input', { type: 'checkbox' });
    const go = h('button', { class: 'btn primary', disabled: true }, 'Open Secure notes');
    ok.addEventListener('change', () => { go.disabled = !ok.checked; });
    go.addEventListener('click', () => { key = null; this.render(); });
    this.screen('Your secure key',
      h('p', { class: 'dim' }, 'Write this down — a sticky note is fine. Keep it somewhere away from this PC. It’s shown only this once.'),
      h('div', { class: 'sn-key mono' }, key),
      h('ul', { class: 'sn-points' },
        h('li', {}, 'Every 30 days Secure notes ask for it before opening.'),
        h('li', {}, 'On a new PC or a fresh copy of the app, it plus your PIN opens your notes.'),
        h('li', {}, 'Dashes and capitals don’t matter when you type it.')),
      h('div', { class: 'sn-actions' },
        h('button', { class: 'btn', onclick: async () => { try { const r = await call('copyText', { text: key }); toast(`Copied — the clipboard clears itself in ${r.clearsIn} s`, { type: 'ok', timeout: 2500 }); } catch (e) { errorToast(e); } } }, icon('copy', 'sm'), 'Copy')),
      h('label', { class: 'check' }, ok, 'I’ve written it down'),
      h('div', { class: 'sn-actions' }, go));
  }

  // ------------------------------------------------------------------ lock screens

  renderPin(msg) {
    const pin = secretInput({ placeholder: 'PIN', autocomplete: 'off' });
    const err = h('div', { class: 'sn-error', hidden: !msg }, msg || '');
    const go = h('button', { class: 'btn primary' }, 'Open');
    go.addEventListener('click', this.busy(go, 'Checking…', async () => {
      try {
        const r = await call('unlockPin', { pin: pin.input.value });
        if (r.needsKey) return this.renderKeyCheck();
        this.render();
      } catch (e) {
        pin.input.value = '';
        if (e.code === 'pinlocked' || e.code === 'nopin' || e.code === 'replaced') return this.render(e.message);
        throw e;
      }
    }));
    pin.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    this.screen('Secure notes are locked', h('p', { class: 'dim' }, 'Enter your PIN.'), pin.el, err,
      h('div', { class: 'sn-actions' }, go),
      h('div', { class: 'sn-links' }, h('button', { class: 'link', onclick: () => this.renderPassphrase() }, 'Use the passphrase instead')));
  }

  renderPassphrase(msg) {
    const pass = secretInput({ placeholder: 'Passphrase', autocomplete: 'current-password' });
    const err = h('div', { class: 'sn-error', hidden: !msg }, msg || '');
    let keyFile = null;
    const kfLabel = h('span', { class: 'faint' }, 'no key file chosen');
    const kfRow = this.st.keyFile ? h('div', { class: 'sn-row' },
      h('button', { class: 'btn sm', onclick: async () => {
        const p = await pickOpen({ title: 'Your Secure notes key file', filters: [{ name: 'Key file', extensions: ['bdskey'] }, { name: 'All files', extensions: ['*'] }] });
        if (p?.[0]) { keyFile = p[0]; kfLabel.textContent = p[0].split(/[\\/]/).pop(); }
      } }, icon('disk', 'sm'), 'Key file…'), kfLabel) : null;
    const go = h('button', { class: 'btn primary' }, 'Open');
    go.addEventListener('click', this.busy(go, 'Opening…', async () => {
      try {
        const r = await call('unlock', { passphrase: pass.input.value, keyFile });
        if (r.needsKey) return this.renderKeyCheck();
        this.render();
      } catch (e) {
        if (e.code === 'device') return this.renderRecover(e.message);
        throw e;
      }
    }));
    pass.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    this.screen('Secure notes are locked',
      h('p', { class: 'dim' }, this.st.keyFile ? 'Enter your passphrase and choose your key file (USB stick).' : 'Enter your passphrase.'),
      pass.el, kfRow, err, h('div', { class: 'sn-actions' }, go),
      h('div', { class: 'sn-links' }, h('button', { class: 'link', onclick: () => this.renderRecover() }, 'New PC or fresh copy? Use your secure key')));
  }

  renderKeyCheck(msg) {
    const key = keyInput();
    const err = h('div', { class: 'sn-error', hidden: !msg }, msg || '');
    const go = h('button', { class: 'btn primary' }, 'Open');
    go.addEventListener('click', this.busy(go, 'Checking…', async () => {
      try { await call('confirmKey', { code: key.value }); this.render(); } catch (e) {
        if (e.code === 'keylocked') return this.render(e.message);
        throw e;
      }
    }));
    key.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    this.screen('30-day secure key check', h('p', { class: 'dim' }, 'It’s been 30 days: type your secure key (from your sticky note) to keep going for another 30.'), key, err,
      h('div', { class: 'sn-actions' }, h('button', { class: 'btn ghost', onclick: async () => { await bridge()({ op: 'lock', hard: true }); this.render(); } }, 'Cancel'), go));
  }

  renderRecover(msg) {
    const key = keyInput();
    const pin = secretInput({ placeholder: 'Your PIN' });
    const pass = secretInput({ placeholder: 'Passphrase for this PC (can be the same as before)', autocomplete: 'new-password' });
    const pass2 = secretInput({ placeholder: 'Passphrase again', autocomplete: 'new-password' });
    const err = h('div', { class: 'sn-error', hidden: !msg }, msg || '');
    const go = h('button', { class: 'btn primary' }, 'Open here');
    go.addEventListener('click', this.busy(go, 'Opening…', async () => {
      if (pass.input.value.length < 10) throw new Error('Use a passphrase of at least 10 characters.');
      if (pass.input.value !== pass2.input.value) throw new Error('The two passphrases don’t match.');
      await call('recover', { code: key.value, pin: pin.input.value, passphrase: pass.input.value });
      toast('Secure notes are set up on this PC.', { type: 'ok' });
      this.render();
    }));
    this.screen('Open with your secure key',
      h('p', { class: 'dim' }, 'For a new PC, a fresh copy of the app, or a new Windows account. Then pick the passphrase to use here.'),
      key, this.st.secureKeyNeedsPin ? pin.el : null, pass.el, pass2.el, err,
      h('div', { class: 'sn-actions' }, h('button', { class: 'btn ghost', onclick: () => this.render() }, 'Back'), go));
  }

  // ------------------------------------------------------------------ open

  async renderOpen() {
    this.view = 'open';
    let r;
    try { r = await call('list'); } catch { return this.render(); }
    this.entries = r.entries;
    this.settings = r.settings;
    this.keyDueDays = this.st.keyDueDays;
    if (this.sel && !this.entries.some((e) => e.id === this.sel)) this.sel = null;
    this.search = h('input', { type: 'search', class: 'sn-search', placeholder: 'Search notes…', value: this.query });
    this.search.addEventListener('input', () => { this.query = this.search.value; this.renderList(); });
    this.list = h('div', { class: 'sn-list' });
    this.detail = h('div', { class: 'sn-detail' });
    const head = h('div', { class: 'sn-head' },
      h('span', { class: 'sn-title' }, icon('lock', 'sm'), this.app.toolName('Secure notes')),
      h('span', { class: 'faint sn-sub' }, `encrypted on this PC · key check in ${this.keyDueDays ?? 30} day${this.keyDueDays === 1 ? '' : 's'}`),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn sm', onclick: () => this.newEntry() }, icon('plus', 'sm'), 'New note'),
      h('button', { class: 'icon-btn', 'data-tip': 'Security settings', onclick: (e) => this.settingsMenu(e) }, icon('settings', 'sm')),
      h('button', { class: 'btn sm', 'data-tip': 'Lock now', onclick: () => this.lockNow() }, icon('lock', 'sm'), 'Lock'));
    clear(this.root).append(head, h('div', { class: 'sn-body' }, h('div', { class: 'sn-side' }, this.search, this.list), this.detail));
    this.renderList();
    this.renderDetail();
    this.refreshStatus();
  }

  renderList() {
    const q = this.query.trim().toLowerCase();
    const shown = this.entries.filter((e) => !q || [e.title, e.username, e.url, e.notes].some((x) => (x || '').toLowerCase().includes(q)));
    clear(this.list);
    if (!this.entries.length) { this.list.append(h('div', { class: 'cut-empty' }, 'No notes yet. Click “New note” to add a password or a private note.')); return; }
    if (!shown.length) { this.list.append(h('div', { class: 'cut-empty' }, 'Nothing matches.')); return; }
    for (const e of shown) {
      const row = h('button', { class: `sn-item ${e.id === this.sel ? 'on' : ''}` },
        h('span', { class: 'sn-item-ic' }, icon(e.hasPassword ? 'lock' : 'note', 'sm')),
        h('span', { class: 'sn-item-text' },
          h('span', { class: 'sn-item-title' }, e.title || 'Untitled'),
          h('span', { class: 'sn-item-sub faint' }, e.username || e.url || (e.notes || '').split('\n')[0] || ' ')));
      row.addEventListener('click', () => { this.sel = e.id; this.renderList(); this.renderDetail(); });
      row.addEventListener('contextmenu', (ev) => contextMenu(ev, [
        { label: 'Copy username', icon: 'user', disabled: !e.username, action: () => this.copy(e, 'username') },
        { label: 'Copy password', icon: 'copy', disabled: !e.hasPassword, action: () => this.copy(e, 'password') },
        { sep: true },
        { label: 'Delete', icon: 'trash', action: () => this.remove(e) },
      ]));
      this.list.append(row);
    }
  }

  renderDetail() {
    const D = clear(this.detail);
    const e = this.entries.find((x) => x.id === this.sel);
    if (!e) { D.append(h('div', { class: 'sn-empty' }, icon('lock', 'xl'), h('div', {}, 'Pick a note, or make a new one.'))); return; }
    const field = (label, key, { type = 'text', placeholder = '', extra = null } = {}) => {
      const input = h(type === 'area' ? 'textarea' : 'input', { class: 'sn-input', placeholder, spellcheck: type === 'area' ? 'true' : 'false', autocomplete: 'off' });
      input.value = e[key] || '';
      input.addEventListener('input', () => { e[key] = input.value; this.queueSave(e, key); });
      return h('label', { class: `sn-field ${type === 'area' ? 'grow' : ''}` }, h('span', { class: 'sn-label' }, label), h('div', { class: 'sn-row' }, input, extra));
    };
    // the password: never in the page except while the eye is held, or while you type a new one
    const masked = h('span', { class: 'sn-masked mono' }, e.hasPassword ? '••••••••••••' : 'no password');
    const eye = h('button', { class: 'icon-btn', title: 'Hold to show', disabled: !e.hasPassword }, icon('eye', 'sm'));
    let revealed = false;
    eye.addEventListener('pointerdown', async (ev) => {
      ev.preventDefault();
      revealed = true;
      try { const r = await call('reveal', { id: e.id }); if (revealed) masked.textContent = r.password; } catch (err) { errorToast(err); }
    });
    const hide = () => { revealed = false; masked.textContent = e.hasPassword ? '••••••••••••' : 'no password'; };
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) eye.addEventListener(ev, hide);
    const pwRow = h('div', { class: 'sn-row' }, masked, eye,
      h('button', { class: 'icon-btn', title: 'Copy (clears in 20 s)', disabled: !e.hasPassword, onclick: () => this.copy(e, 'password') }, icon('copy', 'sm')),
      h('button', { class: 'btn sm', onclick: () => this.changePassword(e, pwRow) }, e.hasPassword ? 'Change' : 'Set password'));
    D.append(
      field('Title', 'title', { placeholder: 'e.g. Bank, Discord, Wi-Fi' }),
      field('Username / email', 'username', { extra: h('button', { class: 'icon-btn', title: 'Copy (clears in 20 s)', onclick: () => this.copy(e, 'username') }, icon('copy', 'sm')) }),
      h('label', { class: 'sn-field' }, h('span', { class: 'sn-label' }, 'Password'), pwRow),
      field('Website', 'url', { placeholder: 'https://…', extra: h('button', { class: 'icon-btn', title: 'Open in your browser', onclick: () => { if (/^https?:\/\//i.test(e.url || '')) window.open(e.url, '_blank', 'noopener'); } }, icon('external', 'sm')) }),
      field('Notes', 'notes', { type: 'area', placeholder: 'Anything private: recovery codes, PINs, answers to security questions…' }),
      h('div', { class: 'sn-foot' },
        h('span', { class: 'faint' }, e.updated ? `saved ${timeAgo(e.updated)}` : ''),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn sm ghost', onclick: () => this.remove(e) }, icon('trash', 'sm'), 'Delete')));
  }

  changePassword(e, row) {
    const pw = secretInput({ placeholder: 'New password', autocomplete: 'new-password' });
    const save = h('button', { class: 'btn sm primary' }, 'Save');
    const cancel = h('button', { class: 'btn sm ghost', onclick: () => this.renderDetail() }, 'Cancel');
    save.addEventListener('click', async () => {
      try {
        const r = await call('saveEntry', { entry: { id: e.id, password: pw.input.value } });
        Object.assign(e, r.entry);
        pw.input.value = '';
        this.renderDetail();
        this.renderList();
        toast('Password saved', { type: 'ok', timeout: 1400 });
      } catch (err) { errorToast(err); }
    });
    pw.input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save.click(); if (ev.key === 'Escape') cancel.click(); });
    clear(row).append(pw.el, save, cancel);
    pw.input.focus();
  }

  queueSave(e) {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      try {
        const r = await call('saveEntry', { entry: { id: e.id, title: e.title, username: e.username, url: e.url, notes: e.notes } });
        e.updated = r.entry.updated;
        this.renderList();
      } catch (err) { if (err.code === 'locked') this.render(); else errorToast(err, 'Couldn’t save'); }
    }, 600);
  }

  async newEntry() {
    try {
      const r = await call('saveEntry', { entry: { title: '' } });
      this.entries.unshift(r.entry);
      this.sel = r.entry.id;
      this.query = '';
      this.search.value = '';
      this.renderList();
      this.renderDetail();
      this.detail.querySelector('input')?.focus();
    } catch (err) { errorToast(err); }
  }

  async remove(e) {
    if (!(await confirmDialog(`Delete “${e.title || 'Untitled'}”?`, 'It’s gone from Secure notes (older encrypted copies stay in the backups for a while).', { danger: true, okLabel: 'Delete' }))) return;
    try { await call('removeEntry', { id: e.id }); this.entries = this.entries.filter((x) => x !== e); if (this.sel === e.id) this.sel = null; this.renderList(); this.renderDetail(); } catch (err) { errorToast(err); }
  }

  async copy(e, field) {
    try {
      const r = await call('copy', { id: e.id, field });
      if (r.ok === false) return;
      toast(`Copied — clears in ${r.clearsIn} s${r.secure ? '' : ' (Windows clipboard history may keep it)'}`, { type: 'ok', timeout: 2000 });
    } catch (err) { errorToast(err); }
  }

  async lockNow() {
    clearTimeout(this.saveTimer);
    await bridge()({ op: 'lock' });
    this.render();
  }

  // ------------------------------------------------------------------ security settings

  /** A small form of password boxes; resolves to their values, or null. */
  async ask(title, fields, { okLabel = 'Save', note } = {}) {
    const inputs = fields.map((f) => (f.kind === 'key' ? { f, ...{ input: keyInput(), el: null } } : { f, ...secretInput({ placeholder: f.label, autocomplete: f.auto || 'off' }) }));
    const err = h('div', { class: 'sn-error', hidden: true });
    const body = h('div', { class: 'sn-form' }, note ? h('p', { class: 'dim' }, note) : null, ...inputs.map((x) => x.el || x.input), err);
    let out = null;
    await modal({
      title, body,
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: okLabel, primary: true, onClick: async () => {
        const vals = Object.fromEntries(inputs.map((x) => [x.f.name, x.input.value]));
        const problem = fields.map((f) => f.check?.(vals[f.name], vals)).find(Boolean);
        if (problem) { err.textContent = problem; err.hidden = false; return false; }
        out = vals;
        return true;
      } }],
      onOpen: () => setTimeout(() => inputs[0]?.input.focus(), 30),
    });
    return out;
  }

  settingsMenu(e) {
    const mins = Number(this.settings?.autoLockMin ?? 5);
    contextMenu(e, [
      { label: 'Lock after no use', icon: 'clock', submenu: [1, 5, 15, 30, 60, 0].map((m) => ({ label: m ? `${m} minute${m === 1 ? '' : 's'}` : 'Only when I leave the tab', checked: m === mins, action: async () => { try { await call('setAutoLock', { minutes: m }); this.settings.autoLockMin = m; } catch (err) { errorToast(err); } } })) },
      { label: 'Change PIN…', icon: 'lock', action: () => this.changePin() },
      { label: 'Change passphrase…', icon: 'edit', action: () => this.changePassphrase() },
      { sep: true },
      this.st.keyFile
        ? { label: 'Stop using the key file…', icon: 'disk', action: () => this.keyFile(false) }
        : { label: 'Add a key file (USB stick)…', icon: 'disk', action: () => this.keyFile(true) },
    ]);
  }

  async changePin() {
    const v = await this.ask('Change PIN', [
      { name: 'pin', label: 'New PIN (4+ letters, numbers or symbols)', auto: 'new-password', check: (x) => (!/^\S{4,32}$/u.test(x) ? 'A PIN is 4 to 32 letters, numbers or symbols (no spaces).' : null) },
      { name: 'pin2', label: 'New PIN again', auto: 'new-password', check: (x, all) => (x !== all.pin ? 'The two PINs don’t match.' : null) },
    ], { note: 'Your secure key works together with the PIN on a new PC, so remember the new one.' });
    if (!v) return;
    try { await call('setPin', { pin: v.pin }); toast('PIN changed', { type: 'ok' }); } catch (err) { errorToast(err); }
  }

  async changePassphrase() {
    const v = await this.ask('Change passphrase', [
      { name: 'current', label: 'Current passphrase', auto: 'current-password' },
      { name: 'next', label: 'New passphrase (10+ characters)', auto: 'new-password', check: (x) => (x.length < 10 ? 'Use a passphrase of at least 10 characters.' : null) },
      { name: 'next2', label: 'New passphrase again', auto: 'new-password', check: (x, all) => (x !== all.next ? 'The two passphrases don’t match.' : null) },
    ]);
    if (!v) return;
    let keyFile;
    if (this.st.keyFile) { keyFile = (await pickOpen({ title: 'Your current key file', filters: [{ name: 'Key file', extensions: ['bdskey'] }, { name: 'All files', extensions: ['*'] }] }))?.[0]; if (!keyFile) return; }
    try { await call('rekey', { current: v.current, keyFile, passphrase: v.next }); toast('Passphrase changed', { type: 'ok' }); } catch (err) { errorToast(err); }
  }

  async keyFile(on) {
    const v = await this.ask(on ? 'Add a key file' : 'Stop using the key file', [{ name: 'current', label: 'Your passphrase', auto: 'current-password' }], {
      okLabel: 'Continue',
      note: on
        ? 'A key file is a small random file you keep on a USB stick. After the app starts, the passphrase only works together with it. Keep a copy somewhere safe — your secure key still opens the notes if the stick is lost.'
        : 'After this, the passphrase alone opens Secure notes again.',
    });
    if (!v) return;
    try {
      if (on) {
        const out = await pickSave({ title: 'Save the key file (e.g. on your USB stick)', defaultName: 'secure-notes.bdskey', filters: [{ name: 'Key file', extensions: ['bdskey'] }] });
        if (!out?.path) return;
        await call('rekey', { current: v.current, newKeyFile: out.path });
        toast('Key file made. From now on, opening Secure notes after a restart needs it.', { type: 'ok', timeout: 6000 });
      } else {
        const kf = (await pickOpen({ title: 'Your key file', filters: [{ name: 'Key file', extensions: ['bdskey'] }, { name: 'All files', extensions: ['*'] }] }))?.[0];
        if (!kf) return;
        await call('rekey', { current: v.current, keyFile: kf, newKeyFile: null });
        toast('Key file no longer needed.', { type: 'ok' });
      }
      this.st = await call('status');
    } catch (err) { errorToast(err); }
  }

  // ------------------------------------------------------------------ tab life

  getSelectionText() { return ''; }
  status() {
    return { left: [{ text: this.app.toolName('Secure notes'), icon: 'lock' }, { text: this.view === 'open' ? 'open — locks when you leave this tab' : 'locked' }], right: [] };
  }
  onShow() { if (this.view === 'open' || !this.root?.isConnected) return; this.render(); }
  /** Leaving the tab locks it (the PIN is asked the next time). */
  onHide() { if (this.view === 'open') { clearTimeout(this.saveTimer); bridge()?.({ op: 'lock' }); this.view = 'lock'; clear(this.root); } }
  destroy() {
    window.removeEventListener('bds:notes-locked', this.onLocked);
    clearTimeout(this.saveTimer);
    bridge()?.({ op: 'lock' });
  }
}
