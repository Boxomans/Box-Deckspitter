// Box-Deckspitter app shell, after start-up: update checks, what's new, the welcome.
// Methods of App (app.js mixes this class into it).

import { $, h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { modal, modalOpen, toast } from '../core/ui.js';

export class StartupPart {
  /** After the app is up: say how an update/rollback went, then the first-run welcome or "what's new". */
  async afterStartup() {
    // Ctrl+right-click on a file in Files / recents / BoxSpaces sends it to the tool that's open
    window.addEventListener('bds:send-files', (e) => this.sendToActive(e.detail?.paths || []));
    if (this.mainWindow === false) return; // update notices and the welcome: the main window has them
    const H = { 'X-BDS-Token': api.token };
    const version = window.BDS?.version || '';
    try {
      const st = await fetch('/api/update/status', { headers: H }).then((r) => r.json());
      const r = st?.result;
      if (r && !r.seen) {
        fetch('/api/update/seen', { method: 'POST', headers: H }).catch(() => {});
        if (r.manualRollback) toast(`Went back to ${r.version}.`, { type: 'ok', timeout: 6000 });
        else if (!r.ok) toast(`The update to ${r.version} didn’t work (${r.reason}), so Box-Deckspitter is still on ${r.from || 'the previous version'}. Nothing of yours was touched.`, { type: 'warn', timeout: 14000 });
      }
    } catch { /* browser mode or old server */ }
    this.fileTypesNotice();
    this.launchUpdateCheck();
    const last = this.settings.lastSeenVersion;
    if (!this.settings.welcomed) {
      this.saveSettings({ welcomed: true, lastSeenVersion: version });
      return this.showWelcome();
    }
    if (last !== version) {
      this.saveSettings({ lastSeenVersion: version });
      if (last) this.showWhatsNew(last);
    }
  }

  /** Once, after the file types were registered again under the app's new name: Windows needs the defaults chosen again. */
  async fileTypesNotice() {
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, i ? 2000 : 6000)); // the server does it a few seconds after starting
      if (modalOpen()) continue; // what's new, the welcome…: after those
      const r = await api.get('/api/system/associations/renamed').catch(() => null);
      if (!r?.show) { if (r?.pending) continue; return; }
      await api.post('/api/system/associations/renamed/seen').catch(() => {});
      const go = await modal({
        title: 'Choose your default apps again',
        body: h('div', {},
          h('p', {}, 'Box-Deckspitter registered its file types under its new name, so Windows no longer has it as the default app for them.'),
          h('p', {}, 'Only you can choose a default app in Windows: in Settings → Default apps, pick Box-Deckspitter for the file types it should open.')),
        buttons: [{ label: 'Later', value: false, ghost: true }, { label: 'Open Default apps', value: true, primary: true }],
      });
      if (go) api.post('/api/system/default-apps').catch(() => {});
      return;
    }
  }

  /** At launch: quietly ask GitHub for a newer version; if there is one, say so in a toast (bottom right, with ×). */
  async launchUpdateCheck() {
    if (this.settings.updateCheckOnLaunch === false || !window.bdsShell) return;
    await new Promise((r) => setTimeout(r, 2500)); // let the app settle first
    try {
      const H = { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' };
      const st = await fetch('/api/update/status', { headers: H }).then((r) => r.json());
      if (st.pending) return; // already downloaded: Settings → Updates shows it
      const r = await fetch('/api/update/check', { method: 'POST', headers: H });
      if (!r.ok) return; // offline, private repo without a token… stay quiet
      const info = await r.json();
      if (!info.newer) return;
      const git = st.gitCheckout;
      toast(git ? `Update ${info.latest} is on GitHub — this is a git copy, so update it with git pull.` : `Box-Deckspitter ${info.latest} is available (you have ${info.current}).`, {
        timeout: 0, closable: true,
        action: git ? null : { label: 'Update…', fn: () => { this.showPanel('settings'); setTimeout(() => [...document.querySelectorAll('.settings-group h4')].find((x) => x.textContent === 'Updates')?.scrollIntoView({ block: 'start', behavior: this.settings.animations === false ? 'auto' : 'smooth' }), 150); } },
      });
    } catch { /* never bother anyone over a failed check */ }
  }

  async changelog() {
    try { return await fetch('/changelog.json', { cache: 'no-store' }).then((r) => r.json()); } catch { return []; }
  }

  /** "What's new": every release after `since` (or the latest few when since is null). */
  async showWhatsNew(since = null) {
    const all = await this.changelog();
    const newer = (a, b) => { const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); return false; };
    const list = since ? all.filter((e) => newer(e.version, since)) : all.slice(0, 6);
    if (!list.length) return since ? null : toast('No release notes yet.', { timeout: 2000 });
    modal({
      title: since ? `What’s new in ${list[0].version}` : 'What’s new',
      wide: true,
      body: h('div', { class: 'whatsnew' }, list.map((e) => h('div', {},
        h('h5', {}, `v${e.version}`, e.date ? h('span', { class: 'faint' }, `  ·  ${e.date}`) : null),
        h('ul', {}, (e.notes || []).map((n) => h('li', {}, n)))))),
      buttons: [{ label: 'Nice', value: true, primary: true }],
    });
  }

  showWelcome() {
    modal({
      title: 'Welcome',
      body: h('div', { class: 'welcome' },
        h('div', { class: 'welcome-head' }, h('img', { src: '/assets/icon.svg', alt: '' }), h('div', {}, h('b', {}, 'BOX//DECKSPITTER'), h('span', { class: 'faint mono' }, `v${window.BDS?.version}`))),
        h('p', {}, 'Your own document workstation. Everything runs on this PC; your files stay here.'),
        h('ul', {},
          h('li', {}, h('b', {}, 'Start something'), ' on the home screen makes a new doc, PDF, sheet or picture. ', h('b', {}, 'Tools'), ' has the form filler, BoxMail, BoxDiff and the rest.'),
          h('li', {}, 'Drop any file on the window to open it.'),
          h('li', {}, 'The ', h('b', {}, 'dumps'), ' at the bottom of editors hold pictures and documents you use a lot: click to use, right-click to copy, drag them anywhere.'),
          h('li', {}, 'Hover a name and press ', h('kbd', {}, 'F2'), ' to rename it, ', h('kbd', {}, 'Del'), ' to remove it.'),
          h('li', {}, h('kbd', {}, 'F1'), ' lists every shortcut. ', h('b', {}, 'Settings'), ' (bottom left) has the theme, sounds, updates and more.'))),
      buttons: [{ label: 'Let’s go', value: true, primary: true }],
    });
  }
}
