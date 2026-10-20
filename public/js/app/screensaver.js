// Box-Deckspitter app shell, the screensaver (Settings → Screensaver; off unless switched on). After the minutes set
// there with no key or mouse move on the PC (the desktop app asks the system; in a plain browser tab it's this page
// only), one of your BoxSaver screensavers covers the window. Any key, click, scroll or mouse move ends it. Not while a
// video plays, the window is minimised or the app is locked.
// Methods of App (app.js mixes this class into it).

import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { closeMenus } from '../core/ui.js';

const saverMod = () => import('../core/saver.js');

export class ScreensaverPart {
  setupScreensaver() {
    this.saverInput = Date.now();
    for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(ev, () => { if (!this.saverEl) this.saverInput = Date.now(); }, { capture: true, passive: true });
    }
    setInterval(() => this.saverCheck(), 5000);
  }

  async saverCheck() {
    const s = this.settings;
    if (this.saverEl) { if (this.appLocked) this.stopScreensaver(); return; }
    if (!s.screensaverOn || this.appLocked || document.hidden || this.saverChecking) return;
    const wait = Math.max(1, Number(s.screensaverMin) || 10) * 60000;
    let idle = Date.now() - this.saverInput;
    if (idle < wait) return;
    this.saverChecking = true;
    try {
      // the whole PC: keys and moves in other programs (and inside the Browser's pages) count as use too
      const sys = await window.bdsShell?.idleSeconds?.().catch(() => null);
      if (typeof sys === 'number') idle = Math.min(idle, sys * 1000);
    } finally { this.saverChecking = false; }
    if (idle < wait || this.saverEl || this.appLocked) return;
    if ([...document.querySelectorAll('video')].some((v) => !v.paused && !v.ended)) return;
    this.startScreensaver();
  }

  /** Covers the window with a screensaver: the given one, or the one picked in Settings (random by default). */
  async startScreensaver(saver) {
    if (this.saverEl) return;
    const m = await saverMod();
    if (!saver) {
      // another window may have changed them since this one started
      let st = this.settings;
      try { st = { ...st, ...(await api.settings()) }; } catch { /* the ones this window has */ }
      const mine = (Array.isArray(st.screensavers) ? st.screensavers : []).map(m.normalizeSaver);
      const all = [...mine, ...m.EXAMPLES];
      saver = all.find((x) => x.id === st.screensaverPick) || (mine.length ? mine : m.EXAMPLES.filter((x) => x.id !== 'ex-code'))[Math.floor(Math.random() * (mine.length || m.EXAMPLES.length - 1))];
    }
    closeMenus();
    const el = h('div', { class: 'saver-overlay', tabindex: '-1' });
    const hint = h('div', { class: 'saver-hint-pill' }, icon('saver', 'sm'), 'Any key or mouse move ends it');
    el.append(hint);
    document.body.append(el);
    this.saverEl = el;
    this.saverPlayer = new m.SaverPlayer(el, saver);
    hint.parentNode.append(hint); // over the layers
    requestAnimationFrame(() => el.classList.add('on'));
    setTimeout(() => hint.classList.add('gone'), 2500);
    el.focus();
    const started = performance.now();
    let from = null;
    const end = (e) => {
      if (this.appLocked) { this.stopScreensaver(); return; } // the lock screen gets the keys
      if (e.type === 'pointermove') {
        // the hand settling after a click (or the trial button) doesn't count; a real move does
        if (performance.now() - started < 700) return;
        if (!from) { from = [e.screenX, e.screenY]; return; }
        if (Math.hypot(e.screenX - from[0], e.screenY - from[1]) < 10) return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      this.stopScreensaver();
    };
    this.saverEnd = end;
    for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'contextmenu']) window.addEventListener(ev, end, { capture: true });
    // the click that ended it doesn't land on whatever was under it
    this.saverSwallow = (e) => { if (performance.now() - (this.saverEndedAt || 0) < 400) { e.preventDefault(); e.stopImmediatePropagation(); } };
    for (const ev of ['click', 'mouseup', 'pointerup', 'keyup']) window.addEventListener(ev, this.saverSwallow, { capture: true });
  }

  stopScreensaver() {
    if (!this.saverEl) return;
    for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'contextmenu']) window.removeEventListener(ev, this.saverEnd, { capture: true });
    this.saverEndedAt = performance.now();
    const el = this.saverEl, player = this.saverPlayer;
    this.saverEl = null;
    this.saverPlayer = null;
    this.saverInput = Date.now();
    el.classList.remove('on');
    setTimeout(() => { player?.destroy(); el.remove(); }, 180);
    const swallow = this.saverSwallow;
    setTimeout(() => { for (const ev of ['click', 'mouseup', 'pointerup', 'keyup']) window.removeEventListener(ev, swallow, { capture: true }); }, 500);
  }

  /** Settings → Screensaver: on / off (off to begin with), after how long, which one, and the way to the studio. */
  screensaverSettings() {
    const s = this.settings;
    const box = h('div', { class: 'settings-group' }, h('h4', {}, 'Screensaver'));
    const studio = this.toolName?.('BoxSaver') || 'BoxSaver';
    const draw = async () => {
      const m = await saverMod();
      const mine = (Array.isArray(this.settings.screensavers) ? this.settings.screensavers : []);
      const on = h('input', { type: 'checkbox', checked: !!s.screensaverOn });
      on.addEventListener('change', async () => { await this.saveSettings({ screensaverOn: on.checked }); this.saverInput = Date.now(); rest.hidden = !on.checked; });
      const after = h('select', {}, [1, 2, 3, 5, 10, 15, 20, 30, 45, 60].map((n) => h('option', { value: String(n) }, n === 60 ? '1 hour' : `${n} minute${n === 1 ? '' : 's'}`)));
      after.value = String(s.screensaverMin || 10);
      after.addEventListener('change', () => this.saveSettings({ screensaverMin: Number(after.value) }));
      const which = h('select', {},
        h('option', { value: 'random' }, mine.length ? 'A random one of yours' : 'A random example'),
        mine.length ? h('optgroup', { label: 'Yours' }, mine.map((x) => h('option', { value: x.id }, x.name))) : null,
        h('optgroup', { label: 'Examples' }, m.EXAMPLES.map((x) => h('option', { value: x.id }, x.name))));
      which.value = [...which.querySelectorAll('option')].some((o) => o.value === s.screensaverPick) ? s.screensaverPick : 'random';
      which.addEventListener('change', () => this.saveSettings({ screensaverPick: which.value }));
      const rest = h('div', { class: 'col', style: { gap: '6px' } },
        h('label', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'dim' }, 'Starts after'), after),
        h('span', { class: 'faint', style: { fontSize: '11px' } }, 'of no key or mouse move on the PC.'),
        h('label', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'dim' }, 'Shows'), which));
      rest.hidden = !s.screensaverOn;
      box.replaceChildren(h('h4', {}, 'Screensaver'),
        h('label', { class: 'check' }, on, 'Show a screensaver when the PC hasn’t been used for a while'),
        rest,
        h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
          h('button', { class: 'btn sm', onclick: () => this.startScreensaver() }, icon('play', 'sm'), 'Preview'),
          h('button', { class: 'btn sm', onclick: () => this.newDocument('saver') }, icon('saver', 'sm'), `Make your own in ${studio}`)),
        h('span', { class: 'faint', style: { fontSize: '11px' } }, 'It covers this window, not the rest of the screen. Any key or mouse move ends it. It waits while a video is playing.'));
    };
    draw();
    return box;
  }
}
