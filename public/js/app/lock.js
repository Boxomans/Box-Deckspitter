// Box-DocSpitter app shell, the app PIN lock and the setup questions that guard keys.
// Methods of App (app.js mixes this class into it).

import { $, h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { closeMenus, modal, toast, errorToast } from '../core/ui.js';

export class LockPart {
  async setupAppLock() {
    // events from the window's process: Windows locked / asleep, Secure notes locked
    window.bdsShell?.onSystemLock?.((why) => { if (this.settings.lockOnWindowsLock !== false) this.lockApp(why); });
    window.bdsShell?.onNotesLocked?.((reason) => window.dispatchEvent(new CustomEvent('bds:notes-locked', { detail: reason })));
    // keys typed while locked go nowhere but the lock screen
    window.addEventListener('keydown', (e) => {
      if (this.appLocked && !this.appLockEl?.contains(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    this.lastInput = Date.now();
    for (const ev of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(ev, () => { if (!this.appLocked) this.lastInput = Date.now(); }, { capture: true, passive: true });
    setInterval(() => {
      const min = Number(this.settings.appLockIdle || 0);
      if (min && this.appLockOn && !this.appLocked && Date.now() - this.lastInput > min * 60000) this.lockApp('idle');
    }, 15000);
    try { this.appLockOn = (await api.get('/api/applock')).enabled; } catch { this.appLockOn = false; }
    if (this.appLockOn) this.lockApp('start');
  }

  lockApp(reason = 'manual') {
    if (!this.appLockOn) {
      if (reason === 'manual') toast('Set a PIN in Settings → Security first.', { type: 'warn' });
      return;
    }
    // Secure notes lock too (they ask for their own PIN)
    window.bdsShell?.notes?.({ op: 'lock' });
    if (this.appLocked) return;
    this.appLocked = true;
    const pin = h('input', { type: 'password', class: 'applock-input', placeholder: 'PIN', autocomplete: 'off', spellcheck: 'false' });
    const err = h('div', { class: 'applock-err' });
    const go = h('button', { class: 'btn primary' }, 'Unlock');
    const submit = async () => {
      if (go.disabled || !pin.value) return;
      go.disabled = true;
      try {
        await api.post('/api/applock/verify', { pin: pin.value });
        this.unlockApp();
      } catch (e) {
        err.textContent = e.message;
        pin.value = '';
        pin.focus();
      } finally { go.disabled = false; }
    };
    go.addEventListener('click', submit);
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    this.appLockEl = h('div', { class: 'applock' }, h('div', { class: 'applock-card' },
      h('div', { class: 'applock-logo' }, icon('lock', 'xl')),
      h('div', { class: 'applock-title' }, 'Box-DocSpitter is locked'),
      pin, err, go,
      h('div', { class: 'applock-hint faint' }, 'Forgot the PIN? Close the app, delete data\\applock.json in its folder, and start it again.')));
    document.body.append(this.appLockEl);
    document.body.classList.add('app-locked');
    closeMenus();
    setTimeout(() => pin.focus(), 30);
  }

  unlockApp() {
    this.appLocked = false;
    this.lastInput = Date.now();
    this.appLockEl?.remove();
    this.appLockEl = null;
    document.body.classList.remove('app-locked');
  }

  /** Settings → Security: the app PIN lock. */
  securitySettings() {
    const box = h('div', { class: 'settings-group' }, h('h4', {}, 'Security'));
    const draw = async () => {
      let on = false;
      try { on = (await api.get('/api/applock')).enabled; } catch { /* ignore */ }
      this.appLockOn = on;
      clear(box).append(h('h4', {}, 'Security'),
        h('span', { class: 'faint', style: { fontSize: '11px' } }, on
          ? 'Box-DocSpitter asks for your PIN when it starts. This hides the app; it doesn’t encrypt your files (Secure notes are encrypted on their own).'
          : 'Lock Box-DocSpitter with a PIN when it starts, after it’s been idle, or when Windows locks.'),
        h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
          h('button', { class: 'btn sm', onclick: async () => { if (await this.setAppPin(on)) draw(); } }, icon('lock', 'sm'), on ? 'Change PIN…' : 'Set a PIN…'),
          on ? h('button', { class: 'btn sm ghost', onclick: async () => { if (await this.removeAppPin()) draw(); } }, 'Turn off') : null,
          on ? h('button', { class: 'btn sm ghost', onclick: () => this.lockApp('manual') }, 'Lock now (Ctrl+Alt+L)') : null));
      if (on) {
        const idle = h('select', {}, [[0, 'Never'], [1, '1 minute'], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour']].map(([v, l]) => h('option', { value: String(v) }, l)));
        idle.value = String(this.settings.appLockIdle || 0);
        idle.addEventListener('change', () => this.saveSettings({ appLockIdle: Number(idle.value) }));
        const win = h('input', { type: 'checkbox', checked: this.settings.lockOnWindowsLock !== false });
        win.addEventListener('change', () => this.saveSettings({ lockOnWindowsLock: win.checked }));
        box.append(h('label', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'dim' }, 'Lock after no use'), idle),
          h('label', { class: 'check' }, win, 'Lock when Windows locks or the PC sleeps'));
      }
    };
    draw();
    return box;
  }

  /** A modal of password boxes → their values (null if cancelled). */
  async askSecrets(title, fields, note) {
    const inputs = fields.map((f) => h('input', { type: 'password', placeholder: f.label, autocomplete: 'off', spellcheck: 'false', class: 'applock-field' }));
    const err = h('div', { class: 'applock-err' });
    let out = null;
    await modal({
      title, body: h('div', { class: 'col', style: { gap: '8px', minWidth: '300px' } }, note ? h('p', { class: 'dim' }, note) : null, ...inputs, err),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Save', primary: true, onClick: () => {
        const v = Object.fromEntries(fields.map((f, i) => [f.name, inputs[i].value]));
        const problem = fields.map((f) => f.check?.(v[f.name], v)).find(Boolean);
        if (problem) { err.textContent = problem; return false; }
        out = v;
        return true;
      } }],
      onOpen: () => setTimeout(() => inputs[0]?.focus(), 30),
    });
    return out;
  }

  async setAppPin(on) {
    const v = await this.askSecrets(on ? 'Change the app PIN' : 'Set an app PIN', [
      ...(on ? [{ name: 'current', label: 'Current PIN' }] : []),
      { name: 'pin', label: 'New PIN (4+ letters, numbers or symbols)', check: (x) => (!/^\S{4,32}$/u.test(x) ? 'A PIN is 4 to 32 letters, numbers or symbols (no spaces).' : null) },
      { name: 'pin2', label: 'New PIN again', check: (x, all) => (x !== all.pin ? 'The two PINs don’t match.' : null) },
    ], on ? null : 'Box-DocSpitter will ask for it every time it starts.');
    if (!v) return false;
    try { await api.post('/api/applock/set', { current: v.current, pin: v.pin }); toast(on ? 'App PIN changed' : 'App PIN set — it’s asked for when Box-DocSpitter starts', { type: 'ok', timeout: 3000 }); return true; } catch (e) { errorToast(e); return false; }
  }

  async removeAppPin() {
    const v = await this.askSecrets('Turn off the app PIN', [{ name: 'current', label: 'Current PIN' }]);
    if (!v) return false;
    try { await api.post('/api/applock/remove', { current: v.current }); toast('App PIN turned off', { type: 'ok' }); return true; } catch (e) { errorToast(e); return false; }
  }
}
