// Box-Deckspitter app shell, the games (their switches, the F-14's sortie, the splash count) and the easter eggs.
// Methods of App (app.js mixes this class into it).

import { $, $$, h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { confirmDialog, toast } from '../core/ui.js';
import { HIDDEN_THEMES } from './shared.js';

export class EasterEggsPart {
  /** The F-14 button shows, and the sortie flies, only while the game is on (opened once from the Toolbox, or Settings → Games). */
  syncTomcat() {
    const on = !!this.settings.tomcatEnabled && this.mainWindow !== false; // one sortie per app: in the main window
    $('#btn-tomcat').hidden = !on || !!this.tomcatLaunched; // after the first take-off the radar stands in for it
    $('#btn-tomcat').title = 'F-14F Super Tomcat · P pauses · drag or flick it to the right sidebar to dock it there';
    if (on) this.tomcatFlight();
    else {
      for (const t of this.tabs.filter((x) => x.mode === 'tomcat')) this.closeTab(t);
      this.stopTomcatFlight();
    }
    this.syncStrike();
  }

  /** Deep Strike's own switch (Settings → Games): its top-bar button. The Toolbox always opens it. */
  syncStrike() {
    const on = !!this.settings.strikeEnabled && this.mainWindow !== false;
    $('#btn-strike').hidden = !on;
    $('#btn-strike').title = 'Deep Strike · drag or flick it to the right sidebar to dock it there';
    this.syncRail();
  }

  /** A game from the Toolbox. The first time, it turns on: the F-14's sortie starts flying and its top-bar button shows
   *  (Deep Strike's too). */
  async openGame(mode) {
    const key = mode === 'tomcat' ? 'tomcatEnabled' : 'strikeEnabled';
    if (!this.settings[key]) { await this.saveSettings({ [key]: true }); this.syncTomcat(); }
    this.newDocument(mode);
  }

  /** The easter egg's sortie: one per app, flying from start-up for as long as it's turned on. */
  tomcatFlight() {
    return (this._flight ||= import('../editors/tomcat.js').then((m) => new m.Flight(this)));
  }

  async stopTomcatFlight() {
    const f = this._flight;
    this._flight = null;
    await (await f)?.stop();
  }

  /** Settings → Games: the F-14's sortie and top-bar button, Deep Strike's button, and wiping the F-14's progress. */
  gameSettings() {
    const box = h('div', { class: 'settings-group' });
    const draw = () => {
      const on = !!this.settings.tomcatEnabled;
      const s = this.settings.tomcat || {};
      const cb = h('input', { type: 'checkbox', checked: on });
      cb.addEventListener('change', async () => {
        await this.saveSettings({ tomcatEnabled: cb.checked });
        this.syncTomcat();
        if (cb.checked) toast('F-14F Super Tomcat is in the top bar. Fight’s on.', { type: 'ok', timeout: 3000 });
        draw();
      });
      const played = s.games || s.auto?.games;
      const ds = this.settings.tomcatStrike?.stats || {};
      const sb = h('input', { type: 'checkbox', checked: !!this.settings.strikeEnabled });
      sb.addEventListener('change', async () => {
        await this.saveSettings({ strikeEnabled: sb.checked });
        this.syncStrike();
        if (sb.checked) toast('Deep Strike is in the top bar.', { type: 'ok', timeout: 3000 });
        draw();
      });
      clear(box).append(h('h4', {}, 'Games'),
        h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Both games open from the Toolbox, under Games.'),
        h('label', { class: 'check' }, cb, h('span', { class: 'row', style: { gap: '6px', alignItems: 'center' } }, icon('f14', 'sm'), 'F-14F Super Tomcat: keep flying in the background and show a quick access button')),
        h('span', { class: 'faint', style: { fontSize: '11px' } }, played
          ? `High score ${(s.bestScore || 0).toLocaleString()} · $${(s.cash || 0).toLocaleString()} · ${(s.games || 0) + (s.auto?.games || 0)} sorties · ${(s.splashes || 0) + (s.auto?.splashes || 0)} splashes`
          : 'An AWG-9 radar intercept game. Turns on the first time you open it.'),
        on ? h('button', { class: 'btn sm danger', style: { alignSelf: 'flex-start' }, onclick: () => this.resetTomcat(draw) }, icon('trash', 'sm'), 'Reset game progress…') : null,
        h('label', { class: 'check' }, sb, h('span', { class: 'row', style: { gap: '6px', alignItems: 'center' } }, icon('reticle', 'sm'), 'Deep Strike: show a quick access button')),
        h('span', { class: 'faint', style: { fontSize: '11px' } }, ds.flown
          ? `${ds.flown} flown · ${ds.won || 0} objectives destroyed · ${ds.jetsLost || 0} jets lost · ${Object.keys(this.settings.tomcatStrike?.badges || {}).length} badges`
          : 'A strike-planning game: find the defences, plan the package, fly it.'));
    };
    draw();
    return box;
  }

  easterEggSettings() {
    const box = h('div', { class: 'settings-group' });
    const draw = () => {
      const hid = h('input', { type: 'checkbox', checked: !!this.settings.hiddenThemes });
      hid.addEventListener('change', async () => {
        await this.saveSettings({ hiddenThemes: hid.checked });
        this.applyTheme(this.settings.theme, false); // a hidden theme in use goes back to Dark when they're switched off
        if (this.panel === 'settings') { // the theme list up top changes; stay where you were
          const y = this.sidepanel.querySelector('.panel-body')?.scrollTop || 0;
          this.renderSettings();
          const body = this.sidepanel.querySelector('.panel-body');
          if (body) body.scrollTop = y;
        }
      });
      clear(box).append(h('h4', {}, 'Easter eggs'),
        h('label', { class: 'check' }, hid, h('span', { class: 'row', style: { gap: '6px', alignItems: 'center' } }, icon('palette', 'sm'), 'Hidden themes')),
        h('span', { class: 'faint', style: { fontSize: '11px' } }, HIDDEN_THEMES.length
          ? `Adds ${HIDDEN_THEMES.length} more theme${HIDDEN_THEMES.length === 1 ? '' : 's'} to the theme list in Appearance (not the top-bar button).`
          : 'Adds secret themes to the theme list in Appearance. None have turned up yet…'));
    };
    draw();
    return box;
  }

  /** Wipes the game: scores, stats, $ and upgrades. */
  async resetTomcat(redraw) {
    if (!(await confirmDialog('Reset F-14F Super Tomcat?', 'Your high scores, stats, $ and every hangar upgrade are wiped. This can’t be undone.', { danger: true, okLabel: 'Reset' }))) return;
    for (const t of this.tabs.filter((x) => x.mode === 'tomcat')) await this.closeTab(t);
    await this.stopTomcatFlight();
    await this.saveSettings({ tomcat: {}, tomcatAuto: false });
    this.syncTomcat(); // a fresh sortie, with no upgrades
    toast('Game progress reset', { type: 'ok' });
    redraw?.();
  }

  /** Easter egg game progress (cash is saved a few seconds late) → settings.json now, so exports carry all of it. */
  async saveGames() {
    await (await this._flight)?.flushCash();
  }

  /** The game's line in the Toolbox: every splash so far, by hand and on automatic, the sortie in the air included. */
  splashLine(live = 0) {
    const t = this.settings.tomcat || {};
    const n = (t.splashes || 0) + (t.auto?.splashes || 0) + live;
    if (!n && !this.settings.tomcatEnabled) return 'an AWG-9 radar intercept game';
    return `${n.toLocaleString()} ${n === 1 ? 'splash' : 'splashes'}`;
  }
}
