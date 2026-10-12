// Box-DocSpitter — application shell: tabs, menus, home, explorer, open/save plumbing.

import { $, $$, h, clear, uid, basename, dirname, extOf, stripExt, formatBytes, timeAgo, formatDate, toBytes, debounce, joinPath, vendor } from './core/dom.js';
import { icon } from './core/icons.js';
import { api } from './core/api.js';
import {
  showMenu, closeMenus, menusOpen, contextMenu, modal, modalOpen, alertDialog, confirmDialog, promptDialog,
  choiceDialog, toast, errorToast, hoverKeys, renameInline, rubberSelect, PATHS_MIME, draggedPaths,
} from './core/ui.js';
import { detectMode, extForLang, LANGUAGES, MODE_ICON, MODE_LABEL, iconForName, OPEN_FILTERS, VIDEO_FILTERS } from './core/filetypes.js';
import { pickOpen, pickSave, configureFiles, setLastDir, getLastDir } from './core/files.js';
import { createPresence } from './core/presence.js';
import { createSounds } from './core/sounds.js';
import { createClips } from './core/clips.js';
import { createMusic } from './core/music.js';

const EDITORS = {
  doc: () => import('./editors/doc.js').then((m) => m.DocEditor),
  pdf: () => import('./editors/pdf.js').then((m) => m.PdfEditor),
  text: () => import('./editors/text.js').then((m) => m.TextEditor),
  code: () => import('./editors/code.js').then((m) => m.CodeEditor),
  sheet: () => import('./editors/sheet.js').then((m) => m.SheetEditor),
  image: () => import('./editors/image.js').then((m) => m.ImageEditor),
  hex: () => import('./editors/hex.js').then((m) => m.HexEditor),
  video: () => import('./editors/video.js').then((m) => m.VideoEditor),
  cut: () => import('./editors/cut.js').then((m) => m.CutEditor),
  form: () => import('./editors/form.js').then((m) => m.FormEditor),
  klep: () => import('./editors/klep.js').then((m) => m.KlepEditor),
  storage: () => import('./editors/storage.js').then((m) => m.StorageEditor),
  mail: () => import('./editors/mail.js').then((m) => m.MailEditor),
  tape: () => import('./editors/tape.js').then((m) => m.TapeEditor),
  scribe: () => import('./editors/scribe.js').then((m) => m.ScribeEditor),
  diff: () => import('./editors/diff.js').then((m) => m.DiffEditor),
  secure: () => import('./editors/secure.js').then((m) => m.SecureNotesEditor),
  tomcat: () => import('./editors/tomcat.js').then((m) => m.TomcatEditor),
  browser: () => import('./editors/browser.js').then((m) => m.BrowserEditor),
  paint: () => import('./editors/paint.js').then((m) => m.PaintEditor),
};

const DEFAULT_SETTINGS = {
  theme: 'dark', nativeDialogs: true, showHidden: false, drafts: true, spellcheck: true,
  docFont: 'Calibri', docSize: 11, codeFontSize: 13, textFont: 'mono', textFontSize: 14, paper: 'white',
  sidebar: null, explorerDir: null,
};

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>New page</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; line-height: 1.6; }
  </style>
</head>
<body>
  <h1>Hello</h1>
  <p>Edit me — the preview updates as you type.</p>
</body>
</html>
`;

const MD_TEMPLATE = `# New note

Write **Markdown** here — the preview on the right updates live.

- [ ] something to do
- [x] something done

\`\`\`js
console.log('spit it out');
\`\`\`
`;

/**
 * Drag `el` and drop it on `zone()`, or flick it toward the zone and let go: either way `onMove()` runs.
 * A plain click (no drag) is left alone. A ghost copy follows the pointer and flies to where it lands.
 */
function flingable(el, zone, onMove) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const pts = [];
    let ghost = null;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const inside = (z, x, y, pad = 0) => { const r = z.getBoundingClientRect(); return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad; };
    const move = (ev) => {
      pts.push({ x: ev.clientX, y: ev.clientY, t: performance.now() });
      if (pts.length > 6) pts.shift();
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
      if (!ghost) {
        ghost = el.cloneNode(true);
        ghost.removeAttribute('id');
        ghost.classList.add('fling-ghost');
        document.body.append(ghost);
        el.classList.add('fling-source');
        zone().classList.add('fling-target');
      }
      ghost.style.left = `${ev.clientX - ghost.offsetWidth / 2}px`;
      ghost.style.top = `${ev.clientY - ghost.offsetHeight / 2}px`;
      // a collapsed (empty) right sidebar slides out once the drag heads its way
      if (zone().classList.contains('rail-empty')) zone().classList.toggle('peek', ev.clientX > innerWidth - 260);
      zone().classList.toggle('fling-hot', inside(zone(), ev.clientX, ev.clientY, 20));
    };
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!ghost) return; // just a click
      // the click that follows a drag shouldn't also toggle the player
      const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
      el.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 50);
      const z = zone();
      z.classList.remove('fling-target', 'fling-hot', 'peek');
      el.classList.remove('fling-source');
      const r = z.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // a flick: fast enough, and heading roughly toward the zone (within about 40 degrees)
      let vx = 0;
      let vy = 0;
      if (pts.length > 1) { const a = pts[0]; const b = pts[pts.length - 1]; const dt = Math.max(1, b.t - a.t); vx = (b.x - a.x) / dt; vy = (b.y - a.y) / dt; }
      const speed = Math.hypot(vx, vy);
      const tx = cx - ev.clientX;
      const ty = cy - ev.clientY;
      const aimed = speed > 0.5 && (vx * tx + vy * ty) / (speed * (Math.hypot(tx, ty) || 1)) > 0.75;
      const go = inside(z, ev.clientX, ev.clientY, 20) || aimed;
      const home = el.getBoundingClientRect();
      const toX = go ? cx : home.left + home.width / 2;
      const toY = go ? cy : home.top + home.height / 2;
      ghost.style.transition = 'left 0.22s cubic-bezier(.2,.8,.2,1), top 0.22s cubic-bezier(.2,.8,.2,1), opacity 0.22s, transform 0.22s';
      requestAnimationFrame(() => {
        ghost.style.left = `${toX - ghost.offsetWidth / 2}px`;
        ghost.style.top = `${toY - ghost.offsetHeight / 2}px`;
        ghost.style.opacity = '0';
        ghost.style.transform = 'scale(0.7)';
      });
      const g = ghost;
      setTimeout(() => g.remove(), 260);
      if (go) setTimeout(onMove, 120);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

const THEME_NEXT = { dark: 'light', light: 'pbj', pbj: 'dark' };
const THEME_NAME = { dark: 'Dark', light: 'Light', pbj: 'PB&J' };
const THEME_PREV = Object.fromEntries(Object.entries(THEME_NEXT).map(([a, b]) => [b, a]));
// side panels that can move between the right sidebar and the top bar
const SIDE_PANELS = { chars: 'Special characters', ai: 'Ask Claude', clip: 'Clipboard & snippets' };
// top-bar buttons that can move to the right sidebar (in their top-bar order)
const TOP_TOOLS = ['btn-music', 'btn-tomcat', 'btn-sound', 'btn-theme', 'btn-shortcuts'];
// tool modes and the home-card name they're renamed by
// files the video editor can use
const MEDIA_FILE_RE = /\.(mp4|m4v|webm|mov|mkv|ogv|avi|wmv|3gp|mts|m2ts|flv|mp3|wav|m4a|aac|ogg|oga|opus|flac|weba|png|jpe?g|jfif|webp|gif|bmp|svg)$/i;
const TOOL_OF_MODE = { klep: 'BoxVidKlep', storage: 'StoragePeek', mail: 'BoxMail', tape: 'BoxTape', scribe: 'BoxScribe', diff: 'BoxDiff', cut: 'Video editor', secure: 'Secure notes' };
const TOOL_LABEL = { 'btn-tomcat': 'F-14', 'btn-sound': 'sound', 'btn-theme': 'theme', 'btn-shortcuts': 'keys' };
const HOME_TITLE = 'BOX//DOCSPITTER';
const HOME_TAGLINE = 'local docs, pdfs, video, storage, text & code — nothing leaves this machine unless you want it to';

class App {
  constructor() {
    this.tabs = [];
    this.active = null;
    this.info = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.clientId = uid('c');
    this.explorer = { dir: null, entries: [], filter: '', selected: null, back: [], fwd: [] };
    this.tabHist = { list: [], pos: -1, moving: false }; // mouse back / forward between tabs
    this.draftHashes = new Map();
    this.menubarOpen = null;
  }

  // ======================================================================= boot

  async init() {
    this.workspace = $('#workspace');
    this.toolbarHost = $('#toolbar-host');
    this.sidepanel = $('#sidepanel');
    this.statusLeft = $('#status-left');
    this.statusRight = $('#status-right');

    try {
      const [info, settings] = await Promise.all([api.info(), api.settings()]);
      this.info = info;
      this.settings = { ...DEFAULT_SETTINGS, ...settings };
    } catch (e) {
      document.body.append(h('div', { class: 'loading-pane' }, 'Could not reach the local server. Restart Box-DocSpitter.'));
      throw e;
    }
    configureFiles({ info: this.info, settings: this.settings });
    this.applyTheme(this.settings.theme, false);
    this.setupAppLock(); // before anything is drawn: the lock screen covers it straight away
    this.presence = createPresence(this);
    this.sounds = createSounds(this);
    this.clips = createClips(this);
    this.music = createMusic(this);

    this.decorateChrome();
    this.renderMenubar();
    this.renderTabs();
    this.buildHome();
    this.activate(null);
    this.wireKeys();
    this.wireMouseNav();
    this.wireDragDrop();
    this.startHeartbeat();
    this.startDraftLoop();
    if (this.settings.sidebar) this.showPanel(this.settings.sidebar);
    if (this.settings.musicDock === 'side') this.setMusicDock(true, { animate: false });
    if (this.settings.rightPanel && !(this.settings.rightPanel === 'music' && this.rightPanel === 'music') && !this.panelOnTop(this.settings.rightPanel)) this.toggleRightPanel(this.settings.rightPanel);
    // the app is up: confirm a just-installed update (otherwise the boot file rolls it back), then say how it went
    window.bdsShell?.appReady?.();
    this.afterStartup();

    const params = new URLSearchParams(location.search);
    const opens = params.getAll('open');
    if (opens.length) {
      history.replaceState(null, '', '/');
      for (const p of opens) await this.openPath(p);
    }
  }

  // ======================================================================= app PIN lock
  // A lock screen over the whole app (Settings → Security). It hides the app; your files on disk aren't encrypted
  // by it — Secure notes are. The PIN is checked by the local server (slow hash, growing waits after wrong tries).

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

  /** The F-14 button shows, and the sortie flies, only while the easter egg is turned on (Settings → Easter eggs). */
  syncTomcat() {
    const on = !!this.settings.tomcatEnabled;
    $('#btn-tomcat').hidden = !on || !!this.tomcatLaunched; // after the first take-off the radar stands in for it
    $('#btn-tomcat').title = 'F-14F Super Tomcat · P pauses · drag or flick it to the right sidebar to dock it there';
    if (on) this.tomcatFlight();
    else {
      for (const t of this.tabs.filter((x) => x.mode === 'tomcat')) this.closeTab(t);
      this.stopTomcatFlight();
    }
    this.syncRail();
  }

  /** The easter egg's sortie: one per app, flying from start-up for as long as it's turned on. */
  tomcatFlight() {
    return (this._flight ||= import('./editors/tomcat.js').then((m) => new m.Flight(this)));
  }

  async stopTomcatFlight() {
    const f = this._flight;
    this._flight = null;
    await (await f)?.stop();
  }

  easterEggSettings() {
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
      clear(box).append(h('h4', {}, 'Easter eggs'),
        h('label', { class: 'check' }, cb, h('span', { class: 'row', style: { gap: '6px', alignItems: 'center' } }, icon('f14', 'sm'), 'F-14F Super Tomcat')),
        h('span', { class: 'faint', style: { fontSize: '11px' } }, played
          ? `High score ${(s.bestScore || 0).toLocaleString()} · $${(s.cash || 0).toLocaleString()} · ${(s.games || 0) + (s.auto?.games || 0)} sorties · ${(s.splashes || 0) + (s.auto?.splashes || 0)} splashes`
          : 'An AWG-9 radar intercept game, behind a button in the top bar.'),
        // wiping progress only shows while the game itself is on
        on ? h('button', { class: 'btn sm danger', style: { alignSelf: 'flex-start' }, onclick: () => this.resetTomcat(draw) }, icon('trash', 'sm'), 'Reset game progress…') : null);
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

  /** Settings → Your setup: export / import a .zip of settings + the (still encrypted) Secure notes. */
  setupTransferSettings() {
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Your setup'),
      h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Settings, theme, renames and layout, plus your Secure notes (still encrypted) — never the dumps, recent files or saved keys.'),
      h('div', { class: 'row', style: { gap: '6px' } },
        h('button', { class: 'btn sm', onclick: () => this.exportSetup() }, icon('download', 'sm'), 'Export…'),
        h('button', { class: 'btn sm', onclick: () => this.importSetup() }, icon('upload', 'sm'), 'Import…')));
  }

  async exportSetup() {
    const day = new Date().toISOString().slice(0, 10);
    const out = await pickSave({ title: 'Export your setup', defaultName: `Box-DocSpitter setup ${day}.zip`, filters: [{ name: 'Zip file', extensions: ['zip'] }] });
    if (!out?.path) return;
    try {
      await this.saveGames();
      const r = await api.post('/api/setup/export', { path: out.path.toLowerCase().endsWith('.zip') ? out.path : out.path + '.zip' });
      toast(`Exported${r.secureNotes ? ' (with your encrypted Secure notes)' : ''}`, { type: 'ok', timeout: 4000, action: { label: 'Show', fn: () => api.reveal(r.path) } });
    } catch (e) { errorToast(e, 'Export failed'); }
  }

  /** Easter egg game progress (cash is saved a few seconds late) → settings.json now, so exports carry all of it. */
  async saveGames() {
    await (await this._flight)?.flushCash();
  }

  async importSetup() {
    const file = (await pickOpen({ title: 'Import a setup', filters: [{ name: 'Zip file', extensions: ['zip'] }] }))?.[0];
    if (!file) return;
    let info;
    try { info = await api.post('/api/setup/inspect', { path: file }); } catch (e) { return errorToast(e, 'Can’t import that'); }
    const replace = h('input', { type: 'checkbox' });
    const ok = await modal({
      title: 'Import this setup?',
      body: h('div', { class: 'col', style: { gap: '8px' } },
        h('p', {}, `From ${info.exported ? new Date(info.exported).toLocaleString() : 'an export'}${info.version ? ` (v${info.version})` : ''}: ${info.settings} settings${info.secureNotes ? ' and Secure notes' : ''}.`),
        h('p', { class: 'dim' }, 'Your settings, theme, renames and layout are replaced by the ones in the file. Folders and things that belong to this PC stay as they are.'),
        info.secureNotes && info.haveNotes ? h('label', { class: 'check' }, replace, 'Also replace the Secure notes here with the ones in the file (the current ones are kept in data\\secure-notes\\backups)') : null,
        info.secureNotes && !info.haveNotes ? h('p', { class: 'dim' }, 'The Secure notes open with your passphrase on the PC they came from, or with your secure key + PIN anywhere else.') : null),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Import', value: 'ok', primary: true }],
    });
    if (ok !== 'ok') return;
    try {
      if (replace.checked) await window.bdsShell?.notes?.({ op: 'lock', hard: true });
      // close the game first so its progress can't be saved over the imported one
      for (const t of this.tabs.filter((x) => x.mode === 'tomcat')) await this.closeTab(t);
      await this.stopTomcatFlight();
      const r = await api.post('/api/setup/import', { path: file, replaceNotes: replace.checked });
      toast(`Imported${r.notes === 'imported' ? ' (with Secure notes)' : r.notes === 'kept' ? ' — your Secure notes here were kept' : ''}. Restarting the window…`, { type: 'ok', timeout: 2500 });
      setTimeout(() => location.reload(), 1200);
    } catch (e) { errorToast(e, 'Import failed'); }
  }

  decorateChrome() {
    $('#btn-home').append(icon('home'));
    $('#btn-home').addEventListener('click', () => this.activate(null));
    $('#btn-new-tab').append(icon('plus'));
    $('#btn-new-tab').addEventListener('click', (e) => showMenu(this.newMenuItems(), { anchor: e.currentTarget }));
    // the top-bar button cycles Dark → Light → PB&J
    $('#btn-theme').addEventListener('click', () => this.applyTheme(THEME_NEXT[this.settings.theme] || 'dark'));
    $('#btn-theme').addEventListener('contextmenu', (e) => { e.preventDefault(); this.applyTheme(THEME_PREV[this.settings.theme] || 'dark'); });
    $('#btn-sound').addEventListener('click', () => { this.sounds.toggle(); this.syncSoundButton(); });
    this.syncSoundButton();
    this.wireSoundVolume();
    $('#btn-music').append(icon('music'));
    $('#btn-music').title = 'Music player (audio-dump) · drag or flick it to the right sidebar to dock it there';
    $('#btn-music').addEventListener('click', () => this.music.toggleOpen());
    this.wireMusicDock();
    $('#btn-tomcat').append(icon('f14'));
    $('#btn-tomcat').addEventListener('click', () => this.newDocument('tomcat'));
    this.syncTomcat();
    $('#btn-shortcuts').append(icon('keyboard'));
    $('#btn-shortcuts').addEventListener('click', () => this.showShortcuts());
    const railIcons = { explorer: 'folder', spaces: 'spaces', recent: 'clock', mediadump: 'image', docdump: 'file-pdf', settings: 'settings' };
    for (const b of $$('.rail-btn[data-panel]')) {
      b.append(icon(railIcons[b.dataset.panel], 'lg'));
      b.addEventListener('click', () => this.togglePanel(b.dataset.panel));
    }
    // the browser opens in the main area, not as a side panel; it needs the desktop app (web pages in <webview>s)
    const web = $('#rail-browser');
    web.append(icon('globe', 'lg'));
    web.hidden = !window.bdsShell?.browser;
    web.addEventListener('click', () => this.newDocument('browser'));
    for (const b of $$('.rrail-tab')) b.addEventListener('click', () => this.toggleRightPanel(b.dataset.rpanel));
    // remember the last place the user was typing, so side panels can insert there
    document.addEventListener('focusin', (e) => {
      const t = e.target;
      if (!this.workspace.contains(t)) return;
      if (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && /^(text|search|url|email|)$/.test(t.type))) this.lastEditable = t;
    });
  }

  /** The right sidebar collapses when nothing is in it (it slides out again while a button is dragged toward it). */
  syncRail() {
    const rail = $('#rightrail');
    if (!rail) return;
    const tabs = [...rail.querySelectorAll('.rrail-tab')].some((t) => !t.hidden);
    const tools = [...(rail.querySelector('.rrail-tools')?.children || [])].some((t) => !t.hidden);
    rail.classList.toggle('rail-empty', !tabs && !tools);
  }

  // ---- the ♪ player can sit under its top-bar button or dock as a right-sidebar tab; drag or flick to move it
  musicRailTab() {
    if (!this._musicTab) {
      const b = h('button', { class: 'rrail-tab rrail-music', dataset: { rpanel: 'music' }, title: 'Music player · drag or flick it to the top bar to undock it' },
        h('span', { class: 'rrail-glyph' }, '\u266a'), h('span', { class: 'rrail-label' }, 'music'));
      b.addEventListener('click', () => this.toggleRightPanel('music'));
      this._musicTab = b;
    }
    return this._musicTab;
  }

  setMusicDock(side, { animate = true } = {}) {
    const btn = $('#btn-music');
    const tab = this.musicRailTab();
    if ((this.settings.musicDock === 'side') !== side) this.saveSettings({ musicDock: side ? 'side' : 'top' });
    if (side) {
      const spacer = $('#rightrail .rrail-spacer');
      if (spacer) spacer.before(tab); else $('#rightrail').append(tab);
      btn.hidden = true;
      // dragged in: open it there; at startup: only if it was open when the app closed
      if (animate || this.settings.rightPanel === 'music') this.toggleRightPanel('music', { force: true });
    } else {
      if (this.rightPanel === 'music') this.toggleRightPanel(null);
      this.music.dockInto(null);
      if (this.rightPanels?.music) { this.rightPanels.music.el.remove(); delete this.rightPanels.music; }
      tab.remove();
      btn.hidden = false;
    }
    tab.classList.toggle('playing', !!this.music.playing);
    this.syncRail();
  }

  wireMusicDock() {
    const topZone = () => $('.titlebar-actions');
    const sideZone = () => $('#rightrail');
    flingable($('#btn-music'), sideZone, () => this.setMusicDock(true));
    flingable(this.musicRailTab(), topZone, () => this.setMusicDock(false));
    // chars, claude and clip can move to the top bar too (and back): there they open as a drop-down
    for (const tab of $$('.rrail-tab[data-rpanel]')) {
      const name = tab.dataset.rpanel;
      if (!SIDE_PANELS[name]) continue;
      const btn = h('button', { class: 'icon-btn top-panel-btn', hidden: true, dataset: { tpanel: name }, title: `${SIDE_PANELS[name]} · drag or flick it to the right sidebar to put it back` },
        h('span', { class: 'top-panel-glyph' }, tab.querySelector('.rrail-glyph')?.textContent || '•'));
      btn.addEventListener('click', () => this.toggleTopPanel(name));
      $('#btn-music').before(btn);
      flingable(tab, topZone, () => this.setPanelDock(name, 'top'));
      flingable(btn, sideZone, () => this.setPanelDock(name, 'side'));
      tab.title = `${tab.title} · drag or flick it to the top bar to move it there`;
    }
    for (const [name, where] of Object.entries(this.settings.panelDock || {})) if (where === 'top' && SIDE_PANELS[name]) this.setPanelDock(name, 'top', { save: false });
    this.wireToolDock();
    this.syncRail();
  }

  // ---- the sound, theme and shortcuts buttons can move from the top bar to the bottom of the right sidebar (and back)
  railTools() {
    if (!this._railTools) {
      this._railTools = h('div', { class: 'rrail-tools' });
      $('#rightrail').append(h('div', { class: 'rrail-spacer' }), this._railTools);
    }
    return this._railTools;
  }

  setToolDock(id, side, { save = true } = {}) {
    const el = $(`#${id}`);
    if (!el) return;
    if (side) {
      this.railTools().append(el);
      // keep the same order as in the top bar
      [...this._railTools.children].sort((a, b) => TOP_TOOLS.indexOf(a.id) - TOP_TOOLS.indexOf(b.id)).forEach((c) => this._railTools.append(c));
    } else {
      const bar = $('.titlebar-actions');
      const after = TOP_TOOLS.slice(TOP_TOOLS.indexOf(id) + 1).map((x) => $(`#${x}`)).find((x) => x && x.parentElement === bar);
      if (after) bar.insertBefore(el, after); else bar.append(el);
    }
    el.classList.toggle('in-rail', side);
    this.syncRail();
    if (save) this.saveSettings({ toolDock: { ...(this.settings.toolDock || {}), [id]: side ? 'side' : 'top' } });
  }

  wireToolDock() {
    for (const id of TOP_TOOLS.slice(1)) {
      const el = $(`#${id}`);
      if (!el) continue;
      el.dataset.rlabel = TOOL_LABEL[id];
      // drag or flick it to the other place
      flingable(el, () => (el.closest('#rightrail') ? $('.titlebar-actions') : $('#rightrail')), () => this.setToolDock(id, !el.closest('#rightrail')));
      if ((this.settings.toolDock || {})[id] === 'side') this.setToolDock(id, true, { save: false });
    }
  }

  /** Move chars / claude / clip between the right sidebar ('side') and the top bar ('top'). */
  setPanelDock(name, where, { save = true } = {}) {
    const tab = $(`.rrail-tab[data-rpanel="${name}"]`);
    const btn = $(`.top-panel-btn[data-tpanel="${name}"]`);
    if (!tab || !btn) return;
    const top = where === 'top';
    if (top && this.rightPanel === name) this.toggleRightPanel(null);
    if (!top && this.topPanel === name) this.closeTopPanel();
    tab.hidden = top;
    btn.hidden = !top;
    this.syncRail();
    if (save) this.saveSettings({ panelDock: { ...(this.settings.panelDock || {}), [name]: top ? 'top' : 'side' } });
    if (save && top) this.toggleTopPanel(name); // show where it went
    else if (save) this.toggleRightPanel(name, { force: true });
  }
  panelOnTop(name) { return (this.settings.panelDock || {})[name] === 'top'; }

  /** The chars / claude / clip panel element, created the first time it's needed. */
  ensureSidePanel(name) {
    this.rightPanels = this.rightPanels || {};
    if (this.rightPanels[name]) return this.rightPanels[name];
    const el = h('div', { class: 'rp-container' });
    this.rightPanels[name] = { el, panel: null };
    const load = name === 'chars'
      ? import('./core/chars-panel.js').then(({ CharsPanel }) => new CharsPanel(this, el))
      : name === 'clip'
        ? import('./core/clips-panel.js').then(({ ClipsPanel }) => new ClipsPanel(this, el))
        : import('./core/ai-panel.js').then(({ AiPanel }) => new AiPanel(this, el));
    load.then((panel) => { this.rightPanels[name].panel = panel; });
    return this.rightPanels[name];
  }

  /** Top-bar mode: the panel drops down under its button (click again, Esc or click elsewhere to close). */
  toggleTopPanel(name) {
    if (this.topPanel === name) return this.closeTopPanel();
    this.closeTopPanel();
    const btn = $(`.top-panel-btn[data-tpanel="${name}"]`);
    if (!btn || btn.hidden) return;
    if (!this.topPop) {
      this.topPop = h('div', { class: 'panel-pop' });
      document.body.append(this.topPop);
      document.addEventListener('pointerdown', (e) => {
        if (!this.topPanel || performance.now() - this.topPopAt < 250) return;
        if (this.topPop.contains(e.target) || e.target.closest?.('.top-panel-btn') || e.target.closest?.('.menu, .modal-backdrop')) return;
        this.closeTopPanel();
      }, true);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.topPanel && !document.querySelector('.modal-backdrop')) this.closeTopPanel(); });
      addEventListener('resize', () => this.topPanel && this.placeTopPanel());
    }
    const p = this.ensureSidePanel(name);
    this.topPop.dataset.panel = name;
    // only one panel at a time in the drop-down
    for (const c of this.topPop.children) if (c !== p.el) c.hidden = true;
    this.topPop.append(p.el);
    p.el.hidden = false;
    this.topPop.hidden = false;
    this.topPanel = name;
    this.topPopAt = performance.now();
    btn.classList.add('on');
    if (name === 'ai') p.panel?.render();
    this.placeTopPanel();
  }
  placeTopPanel() {
    const b = $(`.top-panel-btn[data-tpanel="${this.topPanel}"]`)?.getBoundingClientRect();
    if (!b) return;
    this.topPop.style.top = `${Math.round(b.bottom + 6)}px`;
    this.topPop.style.right = `${Math.max(8, Math.round(innerWidth - b.right - 8))}px`;
  }
  closeTopPanel() {
    if (!this.topPanel) return;
    $(`.top-panel-btn[data-tpanel="${this.topPanel}"]`)?.classList.remove('on');
    this.topPop.hidden = true;
    this.topPanel = null;
  }

  toggleRightPanel(name, { force = false } = {}) {
    const host = $('#rightpanel');
    if (name && SIDE_PANELS[name] && this.panelOnTop(name)) return this.toggleTopPanel(name);
    if (name === 'music' && !this.music?.docked && this.settings.musicDock !== 'side') name = null;
    const next = name && (force || this.rightPanel !== name) ? name : null;
    this.rightPanel = next;
    host.hidden = !next;
    host.dataset.panel = next || '';
    $$('.rrail-tab').forEach((b) => b.classList.toggle('active', b.dataset.rpanel === next));
    this.saveSettings({ rightPanel: next });
    this.rightPanels = this.rightPanels || {};
    for (const [k, p] of Object.entries(this.rightPanels)) if (p.el.parentElement === host) p.el.hidden = k !== next;
    if (next === 'music' && !this.rightPanels.music) {
      const el = h('div', { class: 'rp-container' });
      host.append(el);
      this.rightPanels.music = { el, panel: null };
      this.music.dockInto(el);
    } else if (next && next !== 'music') {
      const fresh = !this.rightPanels[next];
      const p = this.ensureSidePanel(next);
      if (p.el.parentElement !== host) host.append(p.el); // coming back from the top bar
      p.el.hidden = false;
      if (!fresh && next === 'ai') p.panel?.render();
    }
    this.active?.editor?.onShow?.();
  }

  /** Insert text at the cursor of the active editor. Returns false if there's nowhere to put it. */
  insertTextIntoActive(text) {
    const ed = this.active?.editor;
    if (ed?.insertText) return ed.insertText(text) !== false;
    const el = this.lastEditable;
    if (el && el.isConnected && (!this.active || this.active.pane.contains(el))) {
      el.focus();
      return document.execCommand('insertText', false, text);
    }
    return false;
  }

  syncMusicButton(playing) { $('#btn-music')?.classList.toggle('playing', !!playing); this._musicTab?.classList.toggle('playing', !!playing); }

  /** Hovering the speaker button pops out a volume slider for the UI sounds. */
  wireSoundVolume() {
    const btn = $('#btn-sound');
    const range = h('input', { type: 'range', min: '0', max: '1', step: '0.05', 'aria-label': 'Sound volume' });
    const pct = h('span', { class: 'mono' });
    const show = () => { pct.textContent = `${Math.round((this.settings.soundVolume ?? 0.7) * 100)}%`; };
    range.addEventListener('input', () => { this.settings.soundVolume = Number(range.value); this.sounds.setVolume(); show(); });
    range.addEventListener('change', () => { this.saveSettings({ soundVolume: Number(range.value) }); if (this.settings.sounds !== false) this.sounds.play('click'); });
    const pop = h('div', { class: 'vol-pop', hidden: true }, h('span', { class: 'faint' }, 'sounds'), range, pct);
    document.body.append(pop);
    let hideT = null;
    const open = () => {
      clearTimeout(hideT);
      range.value = String(this.settings.soundVolume ?? 0.7);
      show();
      const r = btn.getBoundingClientRect();
      pop.hidden = false;
      if (btn.closest('#rightrail')) {
        pop.style.top = Math.round(r.top + r.height / 2 - pop.offsetHeight / 2) + 'px';
        pop.style.left = Math.round(r.left - pop.offsetWidth - 8) + 'px';
      } else {
        pop.style.top = Math.round(r.bottom + 6) + 'px';
        pop.style.left = Math.round(r.left + r.width / 2 - pop.offsetWidth / 2) + 'px';
      }
    };
    const close = () => { hideT = setTimeout(() => { pop.hidden = true; }, 250); };
    for (const el of [btn, pop]) { el.addEventListener('mouseenter', open); el.addEventListener('mouseleave', close); }
    btn.addEventListener('wheel', (e) => { e.preventDefault(); range.value = String(Math.max(0, Math.min(1, Number(range.value) + (e.deltaY < 0 ? 0.05 : -0.05)))); range.dispatchEvent(new Event('input')); range.dispatchEvent(new Event('change')); }, { passive: false });
  }

  syncSoundButton() {
    const on = this.settings.sounds !== false;
    const b = $('#btn-sound');
    clear(b).append(icon(on ? 'volume' : 'volume-x'));
    b.title = on ? 'Sounds on — click to mute' : 'Sounds muted — click to turn on';
    b.classList.toggle('muted', !on);
  }

  applyTheme(theme, persist = true) {
    this.settings.theme = theme;
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('bds-theme', theme); } catch { /* ignore */ }
    const b = $('#btn-theme');
    clear(b).append(icon(theme === 'dark' ? 'sun' : theme === 'light' ? 'star' : 'moon'));
    b.title = `Theme: ${THEME_NAME[theme] || theme} — click for ${THEME_NAME[THEME_NEXT[theme] || 'dark']}, right-click for ${THEME_NAME[THEME_PREV[theme] || 'dark']}`;
    if (persist) this.saveSettings({ theme });
    for (const t of this.tabs) t.editor?.onThemeChange?.(theme);
    if (window.bdsShell) {
      const cs = getComputedStyle(document.documentElement);
      window.bdsShell.setTitlebar((cs.getPropertyValue('--titlebar-solid') || cs.getPropertyValue('--bg-1')).trim(), cs.getPropertyValue('--text-2').trim(), theme).catch(() => {});
    }
  }

  async saveSettings(patch) {
    Object.assign(this.settings, patch);
    configureFiles({ settings: this.settings });
    try { await api.saveSettings(patch); } catch { /* offline */ }
  }

  // ======================================================================= menubar

  menuDefs() {
    const ed = this.active?.editor;
    const em = ed?.menus?.() || {};
    const defs = [
      ['File', () => this.fileMenu()],
      ['Edit', () => this.editMenu(em.edit)],
      ['View', () => this.viewMenu(em.view)],
    ];
    if (em.insert?.length) defs.push(['Insert', () => this.active?.editor?.menus?.().insert || []]);
    if (em.format?.length) defs.push(['Format', () => this.active?.editor?.menus?.().format || []]);
    defs.push(['Tools', () => this.toolsMenu(this.active?.editor?.menus?.().tools)]);
    defs.push(['Help', () => this.helpMenu()]);
    return defs;
  }

  renderMenubar() {
    const bar = clear($('#menubar'));
    for (const [label, items] of this.menuDefs()) {
      const b = h('button', { class: 'menubar-item' }, label);
      const open = () => {
        $$('.menubar-item', bar).forEach((x) => x.classList.toggle('open', x === b));
        this.menubarOpen = b;
        showMenu(items, { anchor: b }, { onClose: () => { b.classList.remove('open'); if (this.menubarOpen === b) this.menubarOpen = null; } });
      };
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (this.menubarOpen === b) { closeMenus(); return; }
        open();
      });
      b.addEventListener('mouseenter', () => { if (this.menubarOpen && this.menubarOpen !== b) { closeMenus(); open(); } });
      bar.append(b);
    }
  }

  newMenuItems() {
    return [
      { label: 'Document', icon: 'file-doc', shortcut: 'Alt+N', action: () => this.newDocument('doc') },
      { label: 'Text file', icon: 'file-text', action: () => this.newDocument('text') },
      { label: 'Code / config file', icon: 'file-code', submenu: LANGUAGES.map(([id, name]) => ({ label: name, action: () => this.newDocument('code', { lang: id }) })) },
      { label: 'HTML page', icon: 'globe', action: () => this.newDocument('html') },
      { label: 'Markdown note', icon: 'markdown', action: () => this.newDocument('md') },
      { label: 'Spreadsheet', icon: 'sheet', action: () => this.newDocument('sheet') },
      { sep: true },
      { label: 'Blank PDF', icon: 'file-pdf', action: () => this.newDocument('pdf') },
      { label: 'PDF from images…', icon: 'image-plus', action: () => this.newDocument('pdf-images') },
      { sep: true },
      ...this.toolItems(),
    ];
  }

  toolItems() {
    return [
      { label: `${this.toolName('Fill a form')}…`, icon: 'form-fill', action: () => this.fillForm() },
      { label: this.toolName('Video editor'), icon: 'video', action: () => this.newDocument('cut') },
      { label: 'Quick trim a video…', icon: 'scissors', action: () => this.openVideoTrimmer() },
      { label: this.toolName('BoxVidKlep'), icon: 'magnet', action: () => this.newDocument('klep') },
      { label: `${this.toolName('BoxSpaces')} — open folder…`, icon: 'folder-open', action: () => this.openSpace() },
      { label: this.toolName('StoragePeek'), icon: 'layers', action: () => this.newDocument('storage') },
      { label: this.toolName('BoxMail'), icon: 'mail', action: () => this.newDocument('mail') },
      { label: `${this.toolName('BoxTape')} — playlist to MP3s`, icon: 'music', action: () => this.newDocument('tape') },
      { label: `${this.toolName('BoxScribe')} — image to text (OCR)`, icon: 'scan-text', action: () => this.newDocument('scribe') },
      { label: `${this.toolName('BoxDiff')} — compare two files`, icon: 'diff', action: () => this.newDocument('diff') },
      { label: `${this.toolName('Secure notes')} — passwords & private notes`, icon: 'lock', action: () => this.newDocument('secure') },
      { label: 'Music player', icon: 'music', action: () => this.music.open() },
      // web pages need the desktop app's <webview>s
      ...(window.bdsShell?.browser ? [{ label: `${this.toolName('Browser')} — the web, with the dumps`, icon: 'globe', action: () => this.newDocument('browser') }] : []),
    ];
  }

  fileMenu() {
    const t = this.active;
    const ed = t?.editor;
    const exportItems = ed ? this.exportItems(t) : [];
    return [
      { label: 'New', icon: 'file-plus', submenu: () => this.newMenuItems() },
      { label: 'Open…', icon: 'folder-open', shortcut: 'Ctrl+O', action: () => this.openDialog() },
      { label: 'Open recent', icon: 'clock', submenu: () => this.recentSubmenu() },
      { sep: true },
      { label: 'Save', icon: 'save', shortcut: 'Ctrl+S', disabled: !ed || !t.editor.saveFormats().length, action: () => this.save(t) },
      { label: 'Save as…', shortcut: 'Ctrl+Shift+S', disabled: !ed || !t.editor.saveFormats().length, action: () => this.saveAs(t) },
      { label: 'Export as', icon: 'download', disabled: !exportItems.length, submenu: exportItems },
      { sep: true },
      { label: 'Version history…', icon: 'history', disabled: !t?.path, action: () => this.showVersions(t) },
      { label: 'Reload from disk', icon: 'refresh', disabled: !t?.path, action: () => this.reloadTab(t) },
      { label: 'Reopen as', icon: 'layers', disabled: !t?.path, submenu: () => this.reopenAsItems(t) },
      { label: 'Show in folder', icon: 'external', disabled: !t?.path, action: () => api.reveal(t.path).catch(errorToast) },
      { label: 'Copy file path', icon: 'copy', disabled: !t?.path, action: () => { navigator.clipboard.writeText(t.path); toast('Path copied', { type: 'ok' }); } },
      { sep: true },
      { label: 'Print…', icon: 'print', shortcut: 'Ctrl+P', disabled: !ed, action: () => ed.print() },
      { sep: true },
      { label: 'Close tab', shortcut: 'Alt+W', disabled: !t, action: () => this.closeTab(t) },
      { label: 'Close all tabs', disabled: !this.tabs.length, action: () => this.closeAll() },
      { sep: true },
      { label: 'New window', icon: 'window', action: () => api.newWindow().catch(errorToast) },
      { label: 'Quit Box-DocSpitter', icon: 'power', action: () => this.quit() },
    ];
  }

  exportItems(t) {
    const ed = t.editor;
    const items = [];
    for (const f of ed.saveFormats()) {
      items.push({ label: `${f.name} (.${f.ext})`, action: () => this.exportCopy(t, f) });
    }
    for (const x of ed.exportTargets()) {
      items.push({ label: x.label, icon: x.icon, action: () => x.run().catch((e) => errorToast(e, 'Export failed')) });
    }
    return items;
  }

  editMenu(extra = []) {
    const ed = this.active?.editor;
    return [
      { label: 'Undo', icon: 'undo', shortcut: 'Ctrl+Z', disabled: !ed, action: () => ed.undo() },
      { label: 'Redo', icon: 'redo', shortcut: 'Ctrl+Y', disabled: !ed, action: () => ed.redo() },
      { sep: true },
      { label: 'Cut', icon: 'cut', shortcut: 'Ctrl+X', disabled: !ed, action: () => { ed.focus(); document.execCommand('cut'); } },
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', disabled: !ed, action: () => { ed.focus(); document.execCommand('copy'); } },
      { label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', disabled: !ed, action: () => this.pasteFromMenu(false) },
      { label: 'Select all', shortcut: 'Ctrl+A', disabled: !ed, action: () => { ed.focus(); ed.selectAll ? ed.selectAll() : document.execCommand('selectAll'); } },
      { sep: true },
      { label: 'Find', icon: 'search', shortcut: 'Ctrl+F', disabled: !ed, action: () => ed.find(false) },
      { label: 'Find and replace', icon: 'replace', shortcut: 'Ctrl+H', disabled: !ed, action: () => ed.find(true) },
      ...(extra.length ? [{ sep: true }, ...extra] : []),
    ];
  }

  async pasteFromMenu(plain) {
    const ed = this.active?.editor;
    if (!ed) return;
    ed.focus();
    try {
      if (ed.pasteFromClipboard) return await ed.pasteFromClipboard(plain);
      const text = await navigator.clipboard.readText();
      document.execCommand('insertText', false, text);
    } catch {
      toast('Use Ctrl+V to paste (clipboard access was blocked).', { type: 'warn' });
    }
  }

  viewMenu(extra = []) {
    const ed = this.active?.editor;
    return [
      { label: 'Zoom in', icon: 'zoom-in', shortcut: 'Ctrl+=', disabled: !ed, action: () => ed.zoom(+1) },
      { label: 'Zoom out', icon: 'zoom-out', shortcut: 'Ctrl+-', disabled: !ed, action: () => ed.zoom(-1) },
      { label: 'Reset zoom', shortcut: 'Ctrl+0', disabled: !ed, action: () => ed.zoom(0) },
      { sep: true },
      { label: 'Files panel', icon: 'folder', checked: this.panel === 'explorer', action: () => this.togglePanel('explorer') },
      { label: 'Recent panel', icon: 'clock', checked: this.panel === 'recent', action: () => this.togglePanel('recent') },
      { label: 'Special characters', icon: 'omega', checked: this.rightPanel === 'chars' || this.topPanel === 'chars', action: () => this.toggleRightPanel('chars') },
      { label: 'Clipboard & snippets', icon: 'copy', checked: this.rightPanel === 'clip' || this.topPanel === 'clip', action: () => this.toggleRightPanel('clip') },
      { label: 'Music player in the sidebar', icon: 'music', checked: this.settings.musicDock === 'side', action: () => this.setMusicDock(this.settings.musicDock !== 'side') },
      { label: 'Focus mode', icon: 'focus', shortcut: 'F11', checked: document.body.classList.contains('focus-mode'), action: () => this.toggleFocus() },
      { sep: true },
      { label: 'Dark theme', icon: 'moon', checked: this.settings.theme === 'dark', action: () => this.applyTheme('dark') },
      { label: 'Light theme', icon: 'sun', checked: this.settings.theme === 'light', action: () => this.applyTheme('light') },
      { label: 'PB&J theme', icon: 'star', checked: this.settings.theme === 'pbj', action: () => this.applyTheme('pbj') },
      { label: 'Sounds', icon: 'volume', checked: this.settings.sounds !== false, action: () => { this.sounds.toggle(); this.syncSoundButton(); } },
      ...(extra.length ? [{ sep: true }, ...extra] : []),
    ];
  }

  toolsMenu(extra = []) {
    return [
      ...(extra || []),
      ...(extra?.length ? [{ sep: true }] : []),
      ...this.toolItems(),
      { sep: true },
      { label: 'Command palette', icon: 'terminal', shortcut: 'Ctrl+Shift+P', action: () => this.commandPalette() },
      { label: 'Settings', icon: 'settings', action: () => this.showPanel('settings') },
    ];
  }

  helpMenu() {
    return [
      { label: 'Keyboard shortcuts', icon: 'keyboard', shortcut: 'F1', action: () => this.showShortcuts() },
      { label: 'README', icon: 'markdown', action: () => this.showReadme() },
      { label: 'About Box-DocSpitter', icon: 'info', action: () => this.showAbout() },
    ];
  }

  async recentSubmenu() {
    let list = [];
    try { list = await api.recent(); } catch { /* ignore */ }
    const items = list.filter((r) => r.exists).slice(0, 15).map((r) => ({ label: r.name, icon: iconForName(r.name), action: () => this.openPath(r.path) }));
    if (!items.length) return [{ label: 'No recent files', disabled: true }];
    return [...items, { sep: true }, { label: 'Clear recent', action: () => api.removeRecent(null).then(() => this.refreshHome()) }];
  }

  reopenAsItems(t) {
    const modes = [['doc', 'Document editor'], ['text', 'Text editor'], ['code', 'Code editor'], ['pdf', 'PDF editor'], ['form', 'Form filler'], ['sheet', 'Spreadsheet'], ['image', 'Image viewer'], ['video', 'Video trimmer'], ['hex', 'Binary (hex) viewer']];
    return modes.map(([m, label]) => ({ label, icon: MODE_ICON[m], checked: t.mode === m, action: () => this.reopenAs(t, m) }));
  }

  // ======================================================================= tabs

  createTab({ title, path = null, ext = '', mode = null, lang = null }) {
    const tab = { id: uid('t'), title, path, ext, mode, lang, dirty: false, mtime: null, editor: null, toolbarEl: null };
    tab.pane = h('div', { class: 'pane', hidden: true });
    this.workspace.append(tab.pane);
    this.tabs.push(tab);
    this.renderTabs();
    return tab;
  }

  renderTabs() {
    const host = clear($('#tabs'));
    for (const t of this.tabs) {
      const el = h('div', {
        class: `tab ${t === this.active ? 'active' : ''} ${t.dirty ? 'dirty' : ''}`,
        role: 'tab', title: t.path || t.title, draggable: 'true',
      },
      h('span', { class: 'tab-icon' }, icon(t.mode ? (t.mode === 'code' ? iconForName(t.title) : MODE_ICON[t.mode]) : 'file', 'sm')),
      h('span', { class: 'tab-title' }, t.title),
      h('button', { class: 'tab-close', title: 'Close (Alt+W)', onclick: (e) => { e.stopPropagation(); this.closeTab(t); } }, icon('x', 'sm')));
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); this.closeTab(t); }
        else if (e.button === 0 && !e.target.closest('.tab-close')) this.activate(t);
      });
      el.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Close', action: () => this.closeTab(t) },
        { label: 'Close others', action: () => this.closeAll(t) },
        { label: 'Close all', action: () => this.closeAll() },
        { sep: true },
        { label: 'Copy path', disabled: !t.path, action: () => navigator.clipboard.writeText(t.path) },
        { label: 'Show in folder', disabled: !t.path, action: () => api.reveal(t.path) },
      ]));
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/bds-tab', t.id); e.dataTransfer.effectAllowed = 'move'; });
      el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/bds-tab')) { e.preventDefault(); el.classList.add('drag-over'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', (e) => {
        el.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/bds-tab');
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        const from = this.tabs.findIndex((x) => x.id === id);
        const to = this.tabs.indexOf(t);
        if (from < 0 || from === to) return;
        const [moved] = this.tabs.splice(from, 1);
        this.tabs.splice(to, 0, moved);
        this.renderTabs();
      });
      host.append(el);
      if (t === this.active) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    }
    $('#btn-home').classList.toggle('active', !this.active);
  }

  activate(tab) {
    const th = this.tabHist;
    if (th && !th.moving && th.list[th.pos] !== tab) { th.list = th.list.slice(0, th.pos + 1); th.list.push(tab); if (th.list.length > 100) th.list.shift(); th.pos = th.list.length - 1; }
    if (this.active && this.active !== tab) this.active.editor?.onHide?.();
    this.active = tab;
    this.homeEl.hidden = !!tab;
    for (const t of this.tabs) t.pane.hidden = t !== tab;
    clear(this.toolbarHost);
    if (tab?.toolbarEl) this.toolbarHost.append(tab.toolbarEl);
    this.renderTabs();
    this.renderMenubar();
    this.updateTitle();
    this.updateStatus(tab);
    this.presence?.update();
    if (tab?.editor) {
      tab.editor.onShow?.();
      setTimeout(() => tab.editor?.focus?.(), 0);
    }
    if (!tab) this.refreshHome();
  }

  async closeTab(tab, { force = false } = {}) {
    if (!tab) return false;
    if (tab.dirty && !force) {
      this.activate(tab);
      const choice = await choiceDialog('Unsaved changes', `Save changes to "${tab.title}" before closing?`, [
        { label: 'Cancel', value: 'cancel' },
        { label: "Don't save", value: 'discard', danger: true },
        { label: 'Save', value: 'save', primary: true },
      ]);
      if (choice === 'cancel' || choice == null) return false;
      if (choice === 'save' && !(await this.save(tab))) return false;
    }
    const idx = this.tabs.indexOf(tab);
    try { tab.editor?.destroy?.(); } catch (e) { console.warn(e); }
    tab.pane.remove();
    this.tabs.splice(idx, 1);
    this.sounds?.play('close');
    api.deleteDraft(tab.id).catch(() => {});
    if (this.active === tab) {
      this.active = null;
      this.activate(this.tabs[Math.min(idx, this.tabs.length - 1)] || null);
    } else this.renderTabs();
    return true;
  }

  async closeAll(except) {
    for (const t of [...this.tabs]) {
      if (t === except) continue;
      if (!(await this.closeTab(t))) return false;
    }
    return true;
  }

  setDirty(tab, dirty) {
    if (!tab || tab.dirty === dirty) return;
    tab.dirty = dirty;
    this.renderTabs();
    this.updateTitle();
    this.updateStatus(tab);
  }

  setTabMeta(tab, { path, title, ext }) {
    if (path !== undefined) tab.path = path;
    if (title !== undefined) tab.title = title;
    if (ext !== undefined) tab.ext = ext;
    this.renderTabs();
    this.updateTitle();
    this.updateStatus(tab);
    this.presence?.update();
  }

  updateTitle() {
    const t = this.active;
    document.title = t ? `${t.dirty ? '● ' : ''}${t.title} — Box-DocSpitter` : 'Box-DocSpitter';
    const el = clear($('#doc-title'));
    const tool = ['klep', 'storage', 'mail', 'tape', 'scribe', 'diff', 'secure', 'tomcat', 'browser'].includes(t?.mode) && !t.path;
    if (t) el.append(...[h('b', {}, t.title), t.path ? h('span', {}, '  ·  ' + dirname(t.path)) : tool ? null : h('span', {}, '  ·  not saved yet')].filter(Boolean));
  }

  updateStatus(tab = this.active) {
    if (tab && tab !== this.active) return;
    const L = clear(this.statusLeft);
    const R = clear(this.statusRight);
    if (!tab) {
      L.append(h('span', { class: 'sb-item mode' }, 'home'), h('span', { class: 'sb-item' }, `${this.tabs.length} open`));
      const root = this.info?.root || '';
      // the last two folders are enough to tell copies apart ("Desktop\\Box-DocSpitter", "E:\\Box-DocSpitter")
      const short = root.split(/[\\/]/).filter(Boolean).slice(-2).join('\\');
      R.append(h('span', { class: 'sb-item' }, h('span', { class: 'sb-dot' }), 'local · 127.0.0.1'),
        root ? h('button', { class: 'sb-item sb-root', title: `Running from ${root}\nClick to open the folder`, onclick: () => api.reveal(root) }, icon('folder', 'sm'), short) : null,
        h('span', { class: 'sb-item' }, 'v' + (window.BDS?.version || '')));
      return;
    }
    const modeBtn = h('button', { class: 'sb-item mode', title: 'Reopen in a different editor' }, (TOOL_OF_MODE[tab.mode] ? this.toolName(TOOL_OF_MODE[tab.mode]) : MODE_LABEL[tab.mode] || 'Loading').toLowerCase());
    modeBtn.addEventListener('click', () => tab.path && showMenu(this.reopenAsItems(tab), { anchor: modeBtn }));
    L.append(modeBtn,
      h('span', { class: 'sb-item', title: tab.dirty ? 'Unsaved changes' : 'Saved' }, h('span', { class: `sb-dot ${tab.dirty ? 'dirty' : ''}` }), tab.dirty ? 'modified' : tab.path ? 'saved' : 'new'),
      h('span', { class: 'sb-item sb-path', title: tab.path || '' }, tab.path || tab.title));
    const st = tab.editor?.status?.() || {};
    const render = (it) => {
      const el = it.action ? h('button', { class: `sb-item ${it.cls || ''}`, title: it.title || '' }) : h('span', { class: `sb-item ${it.cls || ''}`, title: it.title || '' });
      if (it.icon) el.append(icon(it.icon, 'sm'));
      el.append(it.text);
      if (it.action) el.addEventListener('click', (e) => it.action(e, el));
      return el;
    };
    (st.left || []).forEach((it) => L.append(render(it)));
    (st.right || []).forEach((it) => R.append(render(it)));
  }

  // ======================================================================= open / new

  async openDialog() {
    const paths = await pickOpen({ multi: true, filters: OPEN_FILTERS, title: 'Open' });
    if (!paths) return;
    for (const p of paths) await this.openPath(p);
  }

  async openPath(path, { mode: forcedMode } = {}) {
    const existing = this.tabs.find((t) => t.path && t.path.toLowerCase() === path.toLowerCase());
    if (existing && (!forcedMode || existing.mode === forcedMode)) { this.activate(existing); return existing; }
    const name = basename(path);
    const tab = this.createTab({ title: name, path, ext: extOf(path) });
    this.activate(tab);
    tab.pane.append(h('div', { class: 'loading-pane' }, h('div', { class: 'spinner' }), `loading ${name}…`));
    try {
      // videos stream straight from disk instead of being loaded into memory
      if (forcedMode === 'video' || (!forcedMode && detectMode(name).mode === 'video')) {
        const st = await api.stat(path);
        tab.mtime = st.mtime;
        tab.mode = 'video';
        setLastDir(dirname(path));
        api.addRecent(path).catch(() => {});
        await this.mountEditor(tab, null, {});
        return tab;
      }
      const { bytes, mtime } = await api.read(path);
      tab.mtime = mtime;
      let det = forcedMode ? { mode: forcedMode } : detectMode(name, bytes);
      if (!forcedMode && extOf(name) === 'doc' && bytes[0] === 0x7b && String.fromCharCode(...bytes.subarray(0, 5)) === '{\\rtf') det = { mode: 'doc' };
      tab.mode = det.mode;
      tab.lang = det.lang;
      setLastDir(dirname(path));
      await this.mountEditor(tab, bytes, { lang: det.lang });
      return tab;
    } catch (e) {
      this.failOpen(tab, e, path);
      return null;
    }
  }

  failOpen(tab, e, path) {
    console.error(e);
    tab.dirty = false;
    this.closeTab(tab, { force: true });
    const action = path && tab.mode !== 'text' && tab.mode !== 'hex'
      ? { label: 'Open as text', fn: () => this.openPath(path, { mode: 'text' }) } : null;
    toast(`Couldn't open ${basename(path || tab.title)}: ${e.message}`, { type: 'error', timeout: 8000, action });
  }

  /** Open in-memory bytes (drag & drop, version copies). */
  async openBytes(name, bytes, { mode, path = null } = {}) {
    const tab = this.createTab({ title: name, path, ext: extOf(name) });
    this.activate(tab);
    try {
      const det = mode ? { mode } : detectMode(name, bytes);
      tab.mode = det.mode;
      tab.lang = det.lang;
      await this.mountEditor(tab, bytes, { lang: det.lang, imported: true });
      if (!path) this.setDirty(tab, true);
      return tab;
    } catch (e) {
      this.failOpen(tab, e, null);
      return null;
    }
  }

  async mountEditor(tab, bytes, opts = {}) {
    const Editor = await EDITORS[tab.mode]();
    clear(tab.pane);
    const loading = h('div', { class: 'loading-pane' }, h('div', { class: 'spinner' }), 'spitting it out…');
    tab.pane.append(loading);
    const ed = new Editor(this, tab);
    tab.editor = ed;
    try {
      await ed.load(bytes, opts);
    } finally {
      loading.remove();
    }
    tab.toolbarEl = ed.buildToolbar();
    this.renderTabs();
    if (this.active === tab) this.activate(tab);
    this.sounds?.play('open');
    return ed;
  }

  untitledName(base, ext) {
    let n = 1;
    const name = () => `${base}${n > 1 ? ' ' + n : ''}`;
    while (this.tabs.some((t) => t.title === name() || t.title === `${name()}.${ext}`)) n++;
    return name();
  }

  async newDocument(kind, opts = {}) {
    const spec = {
      doc: { mode: 'doc', ext: 'docx', base: 'Untitled document' },
      text: { mode: 'text', ext: 'txt', base: 'Untitled' },
      code: { mode: 'code', ext: extForLang(opts.lang || 'plaintext'), base: 'untitled', lang: opts.lang || 'plaintext' },
      html: { mode: 'code', ext: 'html', base: 'index', lang: 'html', content: HTML_TEMPLATE },
      md: { mode: 'code', ext: 'md', base: 'note', lang: 'markdown', content: MD_TEMPLATE },
      sheet: { mode: 'sheet', ext: 'xlsx', base: 'Untitled spreadsheet' },
      pdf: { mode: 'pdf', ext: 'pdf', base: 'Untitled' },
      'pdf-images': { mode: 'pdf', ext: 'pdf', base: 'Images' },
      'form-images': { mode: 'form', ext: 'pdf', base: 'Form' },
      klep: { mode: 'klep', ext: '', base: this.toolName('BoxVidKlep') },
      storage: { mode: 'storage', ext: '', base: this.toolName('StoragePeek') },
      mail: { mode: 'mail', ext: '', base: this.toolName('BoxMail') },
      tape: { mode: 'tape', ext: '', base: this.toolName('BoxTape') },
      scribe: { mode: 'scribe', ext: '', base: this.toolName('BoxScribe') },
      diff: { mode: 'diff', ext: '', base: this.toolName('BoxDiff') },
      secure: { mode: 'secure', ext: '', base: this.toolName('Secure notes') },
      tomcat: { mode: 'tomcat', ext: '', base: 'F-14F Super Tomcat' },
      browser: { mode: 'browser', ext: '', base: 'Browser' },
      cut: { mode: 'cut', ext: 'boxcut', base: `Untitled ${this.toolName('Video editor').toLowerCase()}` },
      paint: { mode: 'paint', ext: 'png', base: 'Untitled image' },
    }[kind];
    if (!spec) return;
    let images = opts.images || null;
    if (kind === 'pdf-images' && !images) {
      images = await pickOpen({ multi: true, title: 'Choose images', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
      if (!images) return;
    }
    if ((kind === 'klep' || kind === 'storage' || kind === 'mail' || kind === 'tape' || kind === 'scribe' || kind === 'secure' || kind === 'tomcat' || kind === 'browser') && !opts.another) {
      const existing = this.tabs.find((t) => t.mode === spec.mode);
      if (existing) { this.activate(existing); return existing; }
    }
    const base = this.untitledName(spec.base, spec.ext);
    const title = spec.mode === 'code' || spec.mode === 'text' ? `${base}.${spec.ext}` : base;
    const tab = this.createTab({ title, ext: spec.ext });
    tab.mode = spec.mode;
    tab.lang = spec.lang;
    tab.untitled = true;
    this.activate(tab);
    try {
      const bytes = spec.content ? new TextEncoder().encode(spec.content) : null;
      await this.mountEditor(tab, bytes, { lang: spec.lang, isNew: true, images, diff: opts.diff, pickRight: opts.pickRight, media: opts.media, place: opts.place });
      if (images) this.setDirty(tab, true);
    } catch (e) {
      this.failOpen(tab, e, null);
    }
    return tab;
  }

  async openSpace(path) {
    if (!path) {
      const { pickFolder } = await import('./core/files.js');
      path = await pickFolder({ title: 'Open folder as a BoxSpace' });
      if (!path) return;
    }
    await this.ensureSpaces();
    await this.spaces.open(path);
    this.showPanel('spaces');
    toast(`BoxSpace: ${basename(path)} · Ctrl+E to jump to any file`, { timeout: 3500 });
  }

  async ensureSpaces() {
    if (!this.spaces) {
      const { Spaces } = await import('./core/spaces.js');
      this.spaces = new Spaces(this);
    }
    return this.spaces;
  }

  async commandPalette(mode = 'commands') {
    const { openPalette } = await import('./core/palette.js');
    if (mode === 'files') await this.ensureSpaces();
    openPalette(this, mode);
  }

  /** Open a file and put the cursor on a line (used by search results). */
  async openAt(path, line, col = 1) {
    const tab = await this.openPath(path);
    const ed = tab?.editor;
    if (ed?.gotoLine) setTimeout(() => ed.gotoLine(line, col), 60);
  }

  async openVideoTrimmer() {
    const paths = await pickOpen({ title: 'Open a video or audio file to trim', filters: VIDEO_FILTERS });
    if (paths) await this.openPath(paths[0], { mode: 'video' });
  }

  async fillForm() {
    const paths = await pickOpen({ multi: true, title: 'Open a form (PDF, or scanned pages as images)', filters: [{ name: 'Forms', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp'] }, { name: 'All files', extensions: ['*'] }] });
    if (!paths) return;
    const pdf = paths.find((p) => extOf(p) === 'pdf');
    if (pdf) await this.openPath(pdf, { mode: 'form' });
    else await this.newDocument('form-images', { images: paths });
  }

  async reopenAs(tab, mode) {
    if (!tab?.path) return;
    if (tab.dirty && !(await confirmDialog('Discard changes?', 'Reopening will discard unsaved changes in this tab.', { okLabel: 'Reopen', danger: true }))) return;
    const path = tab.path;
    await this.closeTab(tab, { force: true });
    await this.openPath(path, { mode });
  }

  async reloadTab(tab) {
    if (!tab?.path) return;
    await this.reopenAs(tab, tab.mode);
  }

  // ======================================================================= save

  async save(tab = this.active) {
    if (!tab?.editor) return false;
    const formats = tab.editor.saveFormats();
    if (!formats.length) { toast('This view is read-only.', { type: 'warn' }); return false; }
    if (!tab.path || !formats.some((f) => f.ext === tab.ext)) return this.saveAs(tab);
    return this.writeTab(tab, tab.path, tab.ext);
  }

  async saveAs(tab = this.active) {
    if (!tab?.editor) return false;
    const formats = tab.editor.saveFormats();
    if (!formats.length) return false;
    // put the current extension first so it's the default filter
    const ordered = [...formats].sort((a, b) => (b.ext === tab.ext) - (a.ext === tab.ext));
    const defExt = ordered[0].ext;
    const baseName = tab.path ? stripExt(basename(tab.path)) : stripExt(tab.title);
    const res = await pickSave({
      defaultName: `${baseName}.${defExt}`,
      initialDir: tab.path ? dirname(tab.path) : getLastDir(),
      filters: ordered.map((f) => ({ name: f.name, extensions: [f.ext] })),
      title: 'Save as',
    });
    if (!res) return false;
    let path = res.path;
    let ext = extOf(path);
    const chosen = ordered[(res.filterIndex || 1) - 1] || ordered[0];
    if (!formats.some((f) => f.ext === ext)) {
      if (tab.mode === 'text' || tab.mode === 'code') { /* any extension is fine for plain text */ }
      else { path = `${path}.${chosen.ext}`; ext = chosen.ext; }
    }
    if (tab.editor.lossyFormat(ext) && !(await confirmDialog('Some formatting may be lost', `Saving as .${ext} keeps the text but drops formatting this format can't store. Continue?`, { okLabel: 'Save anyway' }))) return false;
    const ok = await this.writeTab(tab, path, ext, { fresh: true });
    if (ok) {
      this.setTabMeta(tab, { path, title: basename(path), ext });
      tab.untitled = false;
      this.renderMenubar();
    }
    return ok;
  }

  async writeTab(tab, path, ext, { fresh = false } = {}) {
    try {
      const data = await toBytes(await tab.editor.serialize(ext));
      const res = await this.writeFile(path, data, fresh || path !== tab.path ? null : tab.mtime);
      if (!res) return false;
      tab.mtime = res.mtime;
      tab.editor.afterSave(path, ext);
      this.setDirty(tab, false);
      api.deleteDraft(tab.id).catch(() => {});
      this.draftHashes.delete(tab.id);
      toast(`Saved ${basename(path)} · ${formatBytes(res.size)}`, { type: 'ok', timeout: 2200 });
      return true;
    } catch (e) {
      errorToast(e, 'Save failed');
      return false;
    }
  }

  /** Write with conflict detection. Returns server response or null when cancelled. */
  async writeFile(path, data, expectMtime) {
    try {
      return await api.write(path, data, { expectMtime });
    } catch (e) {
      if (e.status !== 409) throw e;
      const choice = await choiceDialog('File changed on disk',
        `"${basename(path)}" was modified by another program after you opened it. Overwrite it with your version? (The other version is kept in Version history.)`,
        [{ label: 'Cancel', value: 'cancel' }, { label: 'Overwrite', value: 'overwrite', danger: true }]);
      if (choice !== 'overwrite') return null;
      return api.write(path, data, { force: true });
    }
  }

  /** Save a copy in another format without changing the tab's path. */
  async exportCopy(tab, fmt) {
    const baseName = tab.path ? stripExt(basename(tab.path)) : stripExt(tab.title);
    const res = await pickSave({ defaultName: `${baseName}.${fmt.ext}`, filters: [{ name: fmt.name, extensions: [fmt.ext] }], title: `Export as ${fmt.name}`, initialDir: tab.path ? dirname(tab.path) : getLastDir() });
    if (!res) return;
    let path = res.path;
    if (extOf(path) !== fmt.ext) path += '.' + fmt.ext;
    try {
      const data = await toBytes(await tab.editor.serialize(fmt.ext));
      const r = await this.writeFile(path, data, null);
      if (r) toast(`Exported ${basename(path)}`, { type: 'ok', action: { label: 'Open', fn: () => this.openPath(path) } });
    } catch (e) { errorToast(e, 'Export failed'); }
  }

  /** Helper for editors: ask for a path and write bytes there. */
  async saveBytesAs(bytes, { defaultName, filters, title = 'Export', openAfter = true }) {
    const res = await pickSave({ defaultName, filters, title, initialDir: this.active?.path ? dirname(this.active.path) : getLastDir() });
    if (!res) return null;
    let path = res.path;
    const want = filters?.[0]?.extensions?.[0];
    if (want && want !== '*' && !extOf(path)) path += '.' + want;
    const r = await this.writeFile(path, await toBytes(bytes), null);
    if (r) toast(`Saved ${basename(path)}`, { type: 'ok', action: openAfter ? { label: 'Open', fn: () => this.openPath(path) } : null });
    return r ? path : null;
  }

  // ======================================================================= versions

  async showVersions(tab) {
    if (!tab?.path) return;
    let versions = [];
    try { versions = await api.versions(tab.path); } catch (e) { return errorToast(e); }
    const list = h('div', { class: 'version-list' });
    if (!versions.length) list.append(h('div', { class: 'empty-note' }, 'No earlier versions yet. A snapshot is kept every time you save over a file.'));
    let ctxRef;
    for (const v of versions) {
      list.append(h('div', { class: 'version-row' },
        icon('history', 'sm'),
        h('span', { class: 'vr-time' }, formatDate(v.at), h('span', { class: 'faint' }, '  ·  ' + timeAgo(v.at))),
        h('span', { class: 'vr-size' }, formatBytes(v.size)),
        h('button', {
          class: 'btn sm',
          onclick: async () => {
            const bytes = await api.readVersion(tab.path, v.id);
            ctxRef.close();
            const name = `${stripExt(tab.title)} (${new Date(v.at).toLocaleString()}).${tab.ext}`;
            await this.openBytes(name.replace(/[:/\\]/g, '-'), bytes, { mode: tab.mode });
          },
        }, 'Open copy'),
        h('button', {
          class: 'btn sm',
          onclick: async () => {
            if (!(await confirmDialog('Restore this version?', `The file on disk will be replaced with the version from ${formatDate(v.at)}. Your current version is kept in history.`, { okLabel: 'Restore' }))) return;
            const bytes = await api.readVersion(tab.path, v.id);
            await api.write(tab.path, bytes, { force: true });
            ctxRef.close();
            await this.closeTab(tab, { force: true });
            await this.openPath(tab.path);
            toast('Version restored', { type: 'ok' });
          },
        }, 'Restore')));
    }
    modal({ title: `Version history — ${tab.title}`, body: list, wide: true, onOpen: (c) => { ctxRef = c; } });
  }

  // ======================================================================= home

  buildHome() {
    this.homeEl = h('div', { class: 'home' });
    this.workspace.append(this.homeEl);
  }

  /** Home cards in the order you dragged them into (new cards you haven't placed go at the end). */
  ordered(group, list, keyOf) {
    const saved = (this.settings.cardOrder || {})[group] || [];
    const rank = new Map(saved.map((k, i) => [k, i]));
    return [...list].sort((a, b) => (rank.get(keyOf(a)) ?? 1e6 + list.indexOf(a)) - (rank.get(keyOf(b)) ?? 1e6 + list.indexOf(b)));
  }

  /** Drag home cards to reorder them; the order is saved by each card's original name. */
  sortableCards(grid, group) {
    let dragged = null;
    for (const card of grid.children) {
      card.draggable = true;
      card.addEventListener('dragstart', (e) => { dragged = card; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/bds-card', card.dataset.key); });
      card.addEventListener('dragend', () => { dragged = null; card.classList.remove('dragging'); for (const c of grid.children) c.classList.remove('drop-before', 'drop-after'); });
      card.addEventListener('dragover', (e) => {
        if (!dragged || dragged === card || dragged.parentElement !== grid) return;
        e.preventDefault();
        const r = card.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        for (const c of grid.children) c.classList.remove('drop-before', 'drop-after');
        card.classList.add(after ? 'drop-after' : 'drop-before');
      });
      card.addEventListener('drop', (e) => {
        if (!dragged || dragged === card) return;
        e.preventDefault();
        const after = card.classList.contains('drop-after');
        card.classList.remove('drop-before', 'drop-after');
        if (after) card.after(dragged); else card.before(dragged);
        this.saveSettings({ cardOrder: { ...(this.settings.cardOrder || {}), [group]: [...grid.children].map((c) => c.dataset.key) } });
      });
    }
  }

  /** F2 on the home logo: pick a picture (file, media dump or paste) — shrunk to 256 px and kept in settings. */
  async changeHomeLogo(img) {
    const set = (url) => { this.saveSettings({ homeLogo: url }); img.src = url || '/assets/icon.svg'; };
    const shrink = async (blob) => {
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
      const c = h('canvas', { width: Math.max(1, Math.round(bmp.width * k)), height: Math.max(1, Math.round(bmp.height * k)) });
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(bmp, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    };
    const use = async (blob) => { try { set(await shrink(blob)); ctx?.close(null); } catch (e) { errorToast(e, 'Couldn’t use that picture'); } };
    let ctx = null;
    const preview = h('img', { src: this.settings.homeLogo || '/assets/icon.svg', alt: '', class: 'logo-pick-preview' });
    const grid = h('div', { class: 'mail-dumppick image logo-pick-dump' });
    api.dump('image').then(({ items }) => {
      if (!items.length) grid.append(h('div', { class: 'faint' }, 'The media dump is empty.'));
      for (const it of items) {
        const b = h('button', { class: 'mail-dumpitem', title: it.name }, h('img', { src: it.url, alt: '' }), h('span', { class: 'mail-dumpname' }, it.name));
        b.addEventListener('click', async () => use(await (await fetch(it.url)).blob()));
        grid.append(b);
      }
    }).catch(() => {});
    const pasteHint = h('div', { class: 'faint', style: { fontSize: '11px' } }, 'Tip: you can also paste a picture (Ctrl+V) while this is open.');
    const onPaste = (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); use(f); } };
    document.addEventListener('paste', onPaste);
    await modal({
      title: 'Change the logo', wide: true,
      body: h('div', { class: 'logo-pick' },
        h('div', { class: 'row' }, preview,
          h('div', { class: 'logo-pick-btns' },
            h('button', { class: 'btn primary', onclick: async () => {
              const paths = await pickOpen({ title: 'Choose a logo picture', filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico'] }] });
              if (!paths?.length) return;
              try { const { bytes } = await api.read(paths[0]); use(new Blob([bytes], { type: /\.svg$/i.test(paths[0]) ? 'image/svg+xml' : '' })); } catch (e) { errorToast(e); }
            } }, icon('folder-open', 'sm'), 'Choose a picture…'),
            h('button', { class: 'btn ghost', onclick: () => { set(null); ctx?.close(null); } }, icon('undo', 'sm'), 'Back to the original'),
            pasteHint)),
        h('div', { class: 'home-section-title' }, 'from the media dump'),
        grid),
      buttons: [{ label: 'Close', value: null, ghost: true }],
      onOpen: (c) => { ctx = c; },
    });
    document.removeEventListener('paste', onPaste);
  }

  /** A tool's name as you've named it (F2 on its home card), e.g. toolName('BoxTape'). */
  toolName(key) { return (this.settings.cardNames || {})[key] || key; }

  /** A span showing a tool's name that follows renames while it's on screen (tool headings). */
  toolLabel(key) { return h('span', { dataset: { toolname: key } }, this.toolName(key)); }

  /** After a rename: every heading, open tab, menu and status bar that shows the tool picks up the new name. */
  toolRenamed(key, was) {
    const now = this.toolName(key);
    for (const el of $$(`[data-toolname="${CSS.escape(key)}"]`)) el.textContent = now;
    const mode = Object.keys(TOOL_OF_MODE).find((m) => TOOL_OF_MODE[m] === key);
    if (mode) {
      for (const t of this.tabs) {
        if (t.mode !== mode || t.path) continue;
        // "BoxTape" or "BoxTape 2" → the same with the new name (tabs named after their contents are left alone)
        if (t.title === was || t.title.startsWith(was + ' ')) this.setTabMeta(t, { title: now + t.title.slice(was.length) });
      }
    }
    if (key === 'BoxSpaces' && this.panel === 'spaces' && this.spaces?.host) this.spaces.render(this.spaces.host);
    this.renderMenubar();
    this.updateStatus(this.active);
  }

  /** A home screen card. Hover + F2 renames it (saved in settings); Ctrl+F2 puts the original name back. */
  homeCard(ic, title, sub) {
    const names = this.settings.cardNames || {};
    const nameEl = h('span', { class: 'nc-title' }, names[title] || title);
    const subs = this.settings.cardSubs || {};
    const subEl = h('span', { class: 'nc-sub' }, subs[title] || sub);
    const card = h('button', { class: 'new-card', dataset: { key: title }, title: 'F2 to rename · Ctrl+F2 to reset · drag to reorder (hover the small line to change that instead)' }, h('span', { class: 'nc-icon' }, icon(ic, 'lg')), nameEl, subEl);
    hoverKeys(subEl, {
      nameEl: subEl,
      value: () => (this.settings.cardSubs || {})[title] || sub,
      commit: (n) => {
        const next = { ...(this.settings.cardSubs || {}) };
        if (!n.trim() || n.trim() === sub) delete next[title]; else next[title] = n.trim();
        this.saveSettings({ cardSubs: next });
        subEl.textContent = next[title] || sub;
      },
      reset: () => { const next = { ...(this.settings.cardSubs || {}) }; delete next[title]; this.saveSettings({ cardSubs: next }); subEl.textContent = sub; },
    });
    hoverKeys(card, {
      nameEl,
      value: () => (this.settings.cardNames || {})[title] || title,
      commit: (n) => {
        const was = this.toolName(title);
        const next = { ...(this.settings.cardNames || {}) };
        if (!n.trim() || n.trim() === title) delete next[title]; else next[title] = n.trim();
        this.saveSettings({ cardNames: next });
        nameEl.textContent = next[title] || title;
        this.toolRenamed(title, was);
      },
      reset: () => { const was = this.toolName(title); const next = { ...(this.settings.cardNames || {}) }; delete next[title]; this.saveSettings({ cardNames: next }); nameEl.textContent = title; this.toolRenamed(title, was); },
    });
    return card;
  }

  async refreshHome() {
    const el = clear(this.homeEl);
    const cards = [
      ['doc', 'file-doc', 'Document', '.docx · rich text'],
      ['pdf-images', 'file-pdf', 'PDF from images', '.pdf · combine'],
      ['text', 'file-text', 'Text file', '.txt · notepad'],
      ['code', 'file-code', 'Code / config', 'json · ini · yaml…'],
      ['html', 'globe', 'HTML page', 'live preview'],
      ['md', 'markdown', 'Markdown', 'live preview'],
      ['sheet', 'sheet', 'Spreadsheet', '.xlsx · .csv'],
      ['paint', 'brush', 'Image', 'paint · layers · .png'],
    ];
    const inner = h('div', { class: 'home-inner' });
    // the big title and the line under it can be renamed with F2 (the user@127.0.0.1 part always stays)
    const editable = (el, key, def) => hoverKeys(el, {
      nameEl: el,
      value: () => this.settings[key] || def,
      commit: (n) => { const v = n.trim() && n.trim() !== def ? n.trim() : null; this.saveSettings({ [key]: v }); el.textContent = v || def; },
      reset: () => { this.saveSettings({ [key]: null }); el.textContent = def; },
    });
    const heroTitle = h('span', { class: 'g' }, this.settings.homeTitle || HOME_TITLE);
    const heroTag = h('span', {}, this.settings.homeTagline || HOME_TAGLINE);
    editable(heroTitle, 'homeTitle', HOME_TITLE);
    const heroLogo = h('img', { src: this.settings.homeLogo || '/assets/icon.svg', alt: '', title: 'F2 to change the logo' });
    hoverKeys(heroLogo, { f2: () => this.changeHomeLogo(heroLogo), reset: () => { this.saveSettings({ homeLogo: null }); heroLogo.src = '/assets/icon.svg'; } });
    editable(heroTag, 'homeTagline', HOME_TAGLINE);
    el.append(h('div', { class: 'home-grid' }), inner);
    inner.append(
      h('div', { class: 'home-hero' },
        heroLogo,
        h('div', {},
          h('h1', { class: 'home-title', title: 'F2 to rename' }, heroTitle, h('span', { class: 'cursor' })),
          h('p', { class: 'home-sub', title: 'F2 to change this line' }, '> ', heroTag, `  ·  ${this.info?.user || ''}@127.0.0.1`))),
    );

    const draftsHost = h('div');
    inner.append(draftsHost);

    inner.append(h('div', { class: 'home-section-title' }, 'start something'));
    const grid = h('div', { class: 'new-cards' });
    for (const [kind, ic, title, sub] of this.ordered('start', cards, (c) => c[2])) {
      const card = this.homeCard(ic, title, sub);
      card.addEventListener('click', (e) => {
        if (kind === 'code') showMenu(LANGUAGES.map(([id, name]) => ({ label: name, action: () => this.newDocument('code', { lang: id }) })), { x: e.clientX, y: e.clientY });
        else this.newDocument(kind);
      });
      grid.append(card);
    }
    this.sortableCards(grid, 'start');
    inner.append(grid);
    inner.append(h('div', { class: 'home-section-title' }, 'tools'));
    const toolGrid = h('div', { class: 'new-cards tool-cards' });
    for (const [ic, title, sub, fn] of this.ordered('tools', [
      ['form-fill', 'Fill a form', 'gov pdfs · autofill · sign', () => this.fillForm()],
      ['video', 'Video editor', 'tracks · keyframes · chroma key', () => this.newDocument('cut')],
      ['magnet', 'BoxVidKlep', 'grab videos from a link', () => this.newDocument('klep')],
      ['spaces', 'BoxSpaces', 'open a folder, IDE-style', () => this.openSpace()],
      ['layers', 'StoragePeek', 'what’s eating your drives', () => this.newDocument('storage')],
      ['mail', 'BoxMail', 'gmail + the dumps + claude', () => this.newDocument('mail')],
      ['music', 'BoxTape', 'youtube playlist → mp3s', () => this.newDocument('tape')],
      ['scan-text', 'BoxScribe', 'image → text · offline ocr', () => this.newDocument('scribe')],
      ['diff', 'BoxDiff', 'compare two files side by side', () => this.newDocument('diff')],
      ['lock', 'Secure notes', 'passwords & private notes · encrypted', () => this.newDocument('secure')],
      ...(window.bdsShell?.browser ? [['globe', 'Browser', 'the web · send pages & media to the dumps', () => this.newDocument('browser')]] : []),
    ], (c) => c[1])) {
      const card = this.homeCard(ic, title, sub);
      card.addEventListener('click', fn);
      toolGrid.append(card);
    }
    this.sortableCards(toolGrid, 'tools');
    inner.append(toolGrid);
    inner.append(h('div', { class: 'home-actions' },
      h('button', { class: 'btn primary', onclick: () => this.openDialog() }, icon('folder-open'), 'Open a file…'),
      h('button', { class: 'btn', onclick: () => this.showPanel('explorer') }, icon('folder'), 'Browse files'),
      h('button', { class: 'btn ghost', onclick: () => this.showShortcuts() }, icon('keyboard'), 'Shortcuts')));
    inner.append(h('div', { class: 'drop-hint' }, 'drop files anywhere to open them  ·  pdf  docx  odt  rtf  txt  md  html  json  yaml  ini  xlsx  csv  png  jpg  svg …'));

    const recentHost = h('div');
    inner.append(recentHost);

    try {
      const recent = (await api.recent()).slice(0, 12);
      if (recent.length) {
        recentHost.append(h('div', { class: 'home-section-title' }, 'recent',
          h('button', { class: 'home-clear', title: 'Clear the recent list (the files themselves stay where they are)', onclick: async () => { await api.removeRecent(null); this.refreshHome(); toast('Recent list cleared', { timeout: 1400 }); } }, 'clear')));
        const list = h('div', { class: 'recent-list' });
        rubberSelect(list, { rows: '.recent-row', menu: (items) => this.recentManyMenu(items, () => this.refreshHome()), onDelete: (items) => this.forgetRecents(items, () => this.refreshHome()), onOpen: (items) => this.openMany(items) });
        for (const r of recent) {
          const row = h('button', { class: `recent-row ${r.exists ? '' : 'missing'}`, title: r.exists ? r.path : 'File not found' },
            h('span', { class: 'rr-icon' }, icon(iconForName(r.name), 'sm')),
            h('span', { class: 'rr-name' }, r.name),
            h('span', { class: 'rr-path' }, dirname(r.path)),
            h('span', { class: 'rr-time' }, timeAgo(r.at)));
          row.addEventListener('click', () => (r.exists ? this.openPath(r.path) : toast('That file no longer exists.', { type: 'warn' })));
          row.addEventListener('contextmenu', (e) => contextMenu(e, [
            { label: 'Open', disabled: !r.exists, action: () => this.openPath(r.path) },
            { label: 'Show in folder', disabled: !r.exists, action: () => api.reveal(r.path) },
            { label: 'Remove from list', action: () => api.removeRecent(r.path).then(() => this.refreshHome()) },
          ]));
          row._item = r;
          list.append(row);
        }
        recentHost.append(list);
      }
    } catch { /* ignore */ }

    try {
      const openIds = new Set(this.tabs.map((t) => t.id));
      const drafts = (await api.drafts()).filter((d) => !openIds.has(d.id));
      if (drafts.length) {
        draftsHost.append(h('div', { class: 'banner' },
          icon('history'),
          h('div', { class: 'grow' }, h('b', {}, `${drafts.length} unsaved document${drafts.length > 1 ? 's' : ''} recovered`), h('div', { class: 'dim' }, drafts.slice(0, 3).map((d) => d.title).join(', ') + (drafts.length > 3 ? '…' : ''))),
          h('button', { class: 'btn ghost', onclick: async () => { for (const d of drafts) await api.deleteDraft(d.id); this.refreshHome(); } }, 'Discard'),
          h('button', { class: 'btn primary', onclick: () => this.restoreDrafts(drafts) }, 'Restore')));
      }
    } catch { /* ignore */ }
  }

  async restoreDrafts(drafts) {
    for (const d of drafts) {
      try {
        const full = await api.draft(d.id);
        const tab = this.createTab({ title: full.title, path: full.path || null, ext: full.ext });
        tab.id = full.id;
        tab.mode = full.mode;
        tab.lang = full.lang;
        this.activate(tab);
        await this.mountEditor(tab, null, { lang: full.lang, isNew: true, draft: full.content });
        tab.editor.restoreDraft(full.content);
        if (full.path) { const st = await api.stat(full.path).catch(() => ({})); tab.mtime = st.mtime || null; }
        this.setDirty(tab, true);
      } catch (e) { errorToast(e, 'Could not restore draft'); }
    }
  }

  startDraftLoop() {
    setInterval(() => {
      if (this.settings.drafts === false) return;
      for (const t of this.tabs) {
        if (!t.dirty || !t.editor) continue;
        let content;
        try { content = t.editor.getDraft(); } catch { continue; }
        if (content == null) continue;
        const sig = content.length + ':' + content.slice(0, 64) + content.slice(-64);
        if (this.draftHashes.get(t.id) === sig) continue;
        this.draftHashes.set(t.id, sig);
        api.saveDraft({ id: t.id, title: t.title, path: t.path, mode: t.mode, ext: t.ext, lang: t.lang, content }).catch(() => {});
      }
    }, 15000);
  }

  // ======================================================================= side panels

  togglePanel(name) {
    if (this.panel === name) this.hidePanel();
    else this.showPanel(name);
  }

  hidePanel() {
    this.panel = null;
    this.sidepanel.hidden = true;
    $$('.rail-btn').forEach((b) => b.classList.remove('active'));
    this.saveSettings({ sidebar: null });
    this.active?.editor?.onShow?.();
  }

  showPanel(name) {
    this.panel = name;
    this.sidepanel.hidden = false;
    $$('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
    if (name !== 'settings') this.saveSettings({ sidebar: name });
    if (name === 'explorer') this.renderExplorer();
    else if (name === 'recent') this.renderRecentPanel();
    else if (name === 'mediadump') this.renderDumpPanel('media');
    else if (name === 'docdump') this.renderDumpPanel('doc');
    else if (name === 'settings') this.renderSettings();
    else if (name === 'spaces') this.ensureSpaces().then((s) => s.render(this.sidepanel));
    this.active?.editor?.onShow?.();
  }

  async renderExplorer(dir, { history = true } = {}) {
    const ex = this.explorer;
    const target = dir || ex.dir || this.settings.explorerDir || this.info.desktop || this.info.home;
    try {
      const res = await api.list(target);
      if (history && ex.dir && res.path !== ex.dir) { ex.back.push(ex.dir); ex.fwd = []; if (ex.back.length > 100) ex.back.shift(); }
      ex.dir = res.path;
      ex.entries = res.entries;
      ex.parent = res.parent;
      if (dir) this.saveSettings({ explorerDir: res.path });
    } catch (e) {
      if (dir) return errorToast(e);
      ex.dir = this.info.home;
      try { const res = await api.list(ex.dir); ex.entries = res.entries; ex.parent = res.parent; } catch { ex.entries = []; }
    }
    if (this.panel !== 'explorer') return;
    const p = clear(this.sidepanel);
    const quick = h('div', { class: 'explorer-quick' });
    const places = [['Desktop', this.info.desktop], ['Documents', this.info.documents], ['Downloads', this.info.downloads], ['Home', this.info.home], ...(this.info.drives || []).map((d) => [d.replace(/\\$/, ''), d])];
    for (const [label, path] of places) if (path) quick.append(h('button', { class: 'chip', onclick: () => this.renderExplorer(path) }, label));
    const filter = h('input', { type: 'search', placeholder: 'Filter…', value: ex.filter });
    const list = h('div', { class: 'file-list' });
    const picker = rubberSelect(list, {
      scroller: () => list.parentElement,
      menu: (items) => this.fileManyMenu(items, () => this.renderExplorer(ex.dir)),
      onDelete: (items) => this.trashMany(items, () => this.renderExplorer(ex.dir)),
      onOpen: (items) => this.openMany(items),
    });
    const renderList = () => {
      clear(list);
      const q = ex.filter.toLowerCase();
      const shown = ex.entries.filter((e) => (this.settings.showHidden || (!e.hidden && !e.dot)) && (!q || e.name.toLowerCase().includes(q)));
      if (!shown.length) list.append(h('div', { class: 'empty-note' }, q ? 'No matches' : 'Empty folder'));
      for (const e of shown) {
        const row = h('button', { class: `file-row ${e.isDir ? 'dir' : ''} ${e.denied ? 'muted' : ''} ${ex.selected === e.path ? 'selected' : ''}`, title: e.isDir ? e.name : `${e.name}\n${formatBytes(e.size)} · ${formatDate(e.mtime)}\nDouble-click to open` },
          h('span', { class: 'fr-icon' }, icon(iconForName(e.name, e.isDir), 'sm')),
          h('span', { class: 'fr-name' }, e.name),
          e.isDir ? null : h('span', { class: 'fr-meta' }, formatBytes(e.size)));
        // Del over a picked row removes every picked file (one confirm); otherwise just this one
        if (!e.denied) hoverKeys(row, { nameEl: row.querySelector('.fr-name'), value: () => e.name, selectBase: !e.isDir, commit: (n) => this.explorerRename(e, n), remove: () => (row.classList.contains('picked') && picker.picked().length > 1 ? this.trashMany(picker.picked(), () => this.renderExplorer(ex.dir)) : this.explorerTrash(e)) });
        if (!e.denied) row._item = e;
        row.addEventListener('click', () => {
          if (e.isDir) return this.renderExplorer(e.path);
          ex.selected = e.path;
          $$('.file-row', list).forEach((r) => r.classList.toggle('selected', r === row));
        });
        row.addEventListener('dblclick', () => { if (!e.isDir) this.openPath(e.path); });
        row.addEventListener('keydown', (k) => { if (k.key === 'Enter' && !e.isDir) this.openPath(e.path); });
        row.addEventListener('contextmenu', (ev) => contextMenu(ev, this.explorerItemMenu(e)));
        list.append(row);
      }
    };
    filter.addEventListener('input', () => { ex.filter = filter.value; renderList(); });
    p.append(
      h('div', { class: 'panel-head' }, 'Files', h('div', { class: 'grow' }),
        h('button', { class: 'icon-btn', 'data-tip': 'New folder', onclick: () => this.explorerNewFolder() }, icon('folder-plus', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Refresh', onclick: () => this.renderExplorer(ex.dir) }, icon('refresh', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Hide panel', onclick: () => this.hidePanel() }, icon('x', 'sm'))),
      quick,
      h('div', { class: 'explorer-path' },
        h('button', { class: 'icon-btn', 'data-tip': 'Up one folder', disabled: !ex.parent, onclick: () => ex.parent && this.renderExplorer(ex.parent) }, icon('arrow-up', 'sm')),
        h('span', { class: 'crumbs', title: ex.dir }, ex.dir),
        h('button', { class: 'icon-btn', 'data-tip': 'Open in Windows Explorer', onclick: () => api.reveal(ex.dir) }, icon('external', 'sm'))),
      h('div', { class: 'explorer-filter' }, filter),
      h('div', { class: 'panel-body' }, list));
    renderList();
  }

  explorerItemMenu(e) {
    if (e.isDir) {
      return [
        { label: 'Open folder', icon: 'folder-open', action: () => this.renderExplorer(e.path) },
        { label: 'Show in Windows Explorer', icon: 'external', action: () => api.reveal(e.path) },
        { label: 'Copy path', icon: 'copy', action: () => navigator.clipboard.writeText(e.path) },
        { label: 'Rename…', shortcut: 'F2', action: () => this.explorerRename(e) },
      ];
    }
    return [
      { label: 'Open', icon: 'file', action: () => this.openPath(e.path) },
      { label: 'Open with', icon: 'layers', submenu: [['doc', 'Document editor'], ['text', 'Text editor'], ['code', 'Code editor'], ['pdf', 'PDF editor'], ['form', 'Form filler'], ['sheet', 'Spreadsheet'], ['image', 'Image viewer'], ['video', 'Video trimmer'], ['hex', 'Hex viewer']].map(([m, l]) => ({ label: l, icon: MODE_ICON[m], action: () => this.openPath(e.path, { mode: m }) })) },
      ...this.videoEditorMenu([e.path]),
      { sep: true },
      { label: 'Show in Windows Explorer', icon: 'external', action: () => api.reveal(e.path) },
      { label: 'Copy path', icon: 'copy', action: () => navigator.clipboard.writeText(e.path) },
      { label: 'Compare with…', icon: 'diff', action: () => this.compareWith(e.path) },
      { label: 'Rename…', shortcut: 'F2', action: () => this.explorerRename(e) },
      { label: 'Delete (Recycle Bin)', icon: 'trash', shortcut: 'Del', action: () => this.explorerTrash(e) },
    ];
  }

  /** "Add to the video editor" for menus of files: only when there's a video, sound or picture among them. */
  videoEditorMenu(paths) {
    const media = paths.filter((p) => MEDIA_FILE_RE.test(p));
    if (!media.length) return [];
    const label = `Add ${media.length > 1 ? `${media.length} files ` : ''}to the ${this.toolName('Video editor').toLowerCase() === 'video editor' ? 'video editor' : this.toolName('Video editor')}`;
    return [{ label, icon: 'video', action: () => this.sendToVideoEditor(media) }];
  }

  /** Into the media list of the open video editor (the one showing, else the last one used), or a new one. */
  async sendToVideoEditor(paths) {
    const cuts = this.tabs.filter((t) => t.mode === 'cut' && t.editor?.addPaths);
    const tab = cuts.includes(this.active) ? this.active : cuts.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))[0];
    if (!tab) return this.newDocument('cut', { media: paths, place: false });
    this.activate(tab);
    const n = await tab.editor.addPaths(paths);
    if (n) toast(`Added ${n} file${n === 1 ? '' : 's'} to the media list`, { type: 'ok', timeout: 1800 });
  }

  /** Open BoxDiff with this file on the left and ask for the file to compare it with. */
  compareWith(path) { return this.newDocument('diff', { diff: [{ path }], pickRight: true }); }

  // ---- actions on several picked files / recent entries (drag-to-select)
  /**
   * Files handed to the open tab: the video editor puts them in its media list, the document editor and
   * BoxPaint take pictures… Editors say how with receiveFiles(paths) → how many they took.
   * With nothing open (home), the files just open.
   */
  async sendToActive(paths) {
    if (!paths.length) return;
    const tab = this.active;
    if (!tab?.editor) return this.openMany(paths.map((path) => ({ path })));
    const name = tab.title || this.toolName(TOOL_OF_MODE[tab.mode] || MODE_LABEL[tab.mode] || 'this tab');
    if (typeof tab.editor.receiveFiles !== 'function') {
      return toast(`${name} can’t take files that way.`, { type: 'warn', timeout: 3000, action: { label: paths.length > 1 ? 'Open them' : 'Open it', fn: () => this.openMany(paths.map((path) => ({ path }))) } });
    }
    try {
      const n = await tab.editor.receiveFiles(paths);
      if (!n) toast(`Nothing there that ${name} can use.`, { type: 'warn', timeout: 2500 });
    } catch (e) { errorToast(e, 'Could not send that'); }
  }

  openMany(items) {
    const files = items.filter((x) => !x.isDir && x.exists !== false);
    if (files.length > 12 && !confirm(`Open ${files.length} files?`)) return;
    for (const f of files) this.openPath(f.path);
  }

  recentManyMenu(items, after) {
    const ok = items.filter((x) => x.exists !== false);
    return [
      { heading: `${items.length} recent files` },
      { label: `Open ${ok.length}`, icon: 'file', disabled: !ok.length, action: () => this.openMany(ok) },
      { label: 'Copy paths', icon: 'copy', action: () => { navigator.clipboard.writeText(items.map((x) => x.path).join('\r\n')); toast('Paths copied', { timeout: 1200 }); } },
      ...(items.length === 2 && ok.length === 2 ? [{ label: 'Compare these two', icon: 'diff', action: () => this.newDocument('diff', { diff: ok.map((x) => ({ path: x.path })) }) }] : []),
      ...this.videoEditorMenu(ok.map((x) => x.path)),
      { sep: true },
      { label: `Remove ${items.length} from the list`, icon: 'x', shortcut: 'Del', action: () => this.forgetRecents(items, after) },
    ];
  }

  async forgetRecents(items, after) {
    for (const x of items) await api.removeRecent(x.path).catch(() => {});
    toast(`Removed ${items.length} from recent files`, { timeout: 1600 });
    after?.();
  }

  fileManyMenu(items, after) {
    const files = items.filter((x) => !x.isDir);
    return [
      { heading: `${items.length} selected` },
      { label: `Open ${files.length} file${files.length === 1 ? '' : 's'}`, icon: 'file', disabled: !files.length, action: () => this.openMany(files) },
      { label: 'Copy paths', icon: 'copy', action: () => { navigator.clipboard.writeText(items.map((x) => x.path).join('\r\n')); toast('Paths copied', { timeout: 1200 }); } },
      ...(files.length === 2 && items.length === 2 ? [{ label: 'Compare these two', icon: 'diff', action: () => this.newDocument('diff', { diff: files.map((x) => ({ path: x.path })) }) }] : []),
      ...this.videoEditorMenu(files.map((x) => x.path)),
      { sep: true },
      { label: `Delete ${items.length} (Recycle Bin)`, icon: 'trash', shortcut: 'Del', action: () => this.trashMany(items, after) },
    ];
  }

  /** Several files/folders to the Recycle Bin with one question. */
  async trashMany(items, after) {
    if (!items.length) return;
    const names = items.slice(0, 6).map((x) => `“${x.name || basename(x.path)}”`).join(', ') + (items.length > 6 ? ` and ${items.length - 6} more` : '');
    if (!(await confirmDialog(`Move ${items.length} item${items.length === 1 ? '' : 's'} to the Recycle Bin?`, `${names} will be moved to the Recycle Bin. You can restore them from there.`, { okLabel: 'Move to Recycle Bin', danger: true }))) return;
    let n = 0;
    for (const x of items) {
      try {
        await api.trash(x.path);
        n++;
        const tab = this.tabs.find((t) => t.path && t.path.toLowerCase().startsWith(x.path.toLowerCase()));
        if (tab) this.closeTab(tab, { force: !tab.dirty });
      } catch (err) { errorToast(err, x.name || x.path); }
    }
    if (n) toast(`Moved ${n} item${n === 1 ? '' : 's'} to the Recycle Bin`, { type: 'ok' });
    after?.();
  }

  async explorerTrash(e) {
    if (!(await confirmDialog('Move to Recycle Bin?', `“${e.name}” will be moved to the Recycle Bin. You can restore it from there.`, { okLabel: 'Move to Recycle Bin', danger: true }))) return;
    try {
      await api.trash(e.path);
      const tab = this.tabs.find((t) => t.path && t.path.toLowerCase().startsWith(e.path.toLowerCase()));
      if (tab) this.closeTab(tab, { force: !tab.dirty });
      toast(`Moved ${e.name} to the Recycle Bin`, { type: 'ok' });
      this.renderExplorer(this.explorer.dir);
    } catch (err) { errorToast(err, 'Delete failed'); }
  }

  async explorerRename(e, given) {
    const name = given ?? await promptDialog('Rename', 'New name', e.name, { selectBase: !e.isDir });
    if (!name || name === e.name) return;
    try {
      const to = joinPath(dirname(e.path), name);
      await api.rename(e.path, to);
      const open = this.tabs.find((t) => t.path && t.path.toLowerCase() === e.path.toLowerCase());
      if (open) this.setTabMeta(open, { path: to, title: name, ext: extOf(name) });
      this.renderExplorer(this.explorer.dir);
    } catch (err) { errorToast(err, 'Rename failed'); }
  }

  async explorerNewFolder() {
    const name = await promptDialog('New folder', 'Folder name', 'New folder');
    if (!name) return;
    try { await api.mkdir(joinPath(this.explorer.dir, name)); this.renderExplorer(this.explorer.dir); } catch (e) { errorToast(e); }
  }

  /**
   * The media dump / doc dump as a side panel, with folders: click a folder to go in (Mouse 4 goes back up),
   * the path at the top goes back to any level. Drag to pick several, Shift+drag to carry files somewhere
   * (into a folder here, or the video editor's timeline…), Ctrl+right-click to send them to the open tool,
   * F2 renames, Del removes. Files dropped on the panel are copied in; dropped on a folder, they go in there.
   */
  async renderDumpPanel(kind, dir) {
    const panel = kind === 'media' ? 'mediadump' : 'docdump';
    const label = kind === 'media' ? 'Media dump' : 'Doc dump';
    const folder = kind === 'media' ? 'media-dump' : 'doc-dump';
    this.dumpDirs = this.dumpDirs || { media: '', doc: '' };
    if (dir != null) this.dumpDirs[kind] = dir;
    const sub = this.dumpDirs[kind];
    const again = (to) => { if (this.panel === panel) this.renderDumpPanel(kind, to); };
    let res;
    try { res = await api.dump(kind, sub); } catch (e) {
      // the folder went away (removed in Explorer…): back to the top
      if (sub) return again('');
      clear(this.sidepanel).append(h('div', { class: 'empty-note' }, e.message));
      return;
    }
    if (this.panel !== panel) return;
    const p = clear(this.sidepanel);
    const list = h('div', { class: 'file-list dump-list' });
    const body = h('div', { class: 'panel-body' }, list);
    const addFiles = async () => {
      const paths = await pickOpen({ multi: true, title: `Add to the ${label.toLowerCase()}` });
      if (paths?.length) { await this.copyToDump(paths, kind, sub); again(); }
    };
    const newFolder = async () => {
      const name = await promptDialog('New folder', 'Folder name', 'New folder');
      if (!name) return;
      try { await api.dumpFolder(sub ? `${sub}/${name}` : name, kind); again(); } catch (e) { errorToast(e, 'Could not make the folder'); }
    };
    // drop files on a folder (or the path at the top) → into it: copied from elsewhere, moved within the dump
    const dropInto = (el, target) => {
      el.addEventListener('dragover', (e) => {
        if (![PATHS_MIME, 'Files'].some((t) => e.dataTransfer.types.includes(t))) return;
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        el.classList.add('drop-into');
      });
      el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-into'); });
      el.addEventListener('drop', async (e) => {
        el.classList.remove('drop-into');
        body.classList.remove('drop');
        e.preventDefault(); e.stopPropagation();
        const paths = draggedPaths(e);
        for (const f of e.dataTransfer.files) { const fp = window.bdsShell?.pathForFile?.(f); if (fp) paths.push(fp); }
        if (paths.length) { await this.copyToDump(paths, kind, target); again(); }
      });
    };
    const crumbs = h('div', { class: 'dump-crumbs' });
    const parts = sub ? sub.split('/') : [];
    const crumb = (text, to) => {
      const b = h('button', { class: `dump-crumb ${to === sub ? 'here' : ''}`, title: to ? `${folder}/${to}` : folder, onclick: () => again(to) }, text);
      dropInto(b, to);
      return b;
    };
    crumbs.append(crumb(folder, ''));
    parts.forEach((part, i) => crumbs.append(h('span', { class: 'faint' }, '/'), crumb(part, parts.slice(0, i + 1).join('/'))));
    p.append(h('div', { class: 'panel-head' }, label, h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', 'data-tip': 'New folder', onclick: newFolder }, icon('folder-plus', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Add files', onclick: addFiles }, icon('plus', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Refresh', onclick: () => again() }, icon('refresh', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Open this folder in Explorer', onclick: () => api.dumpReveal(kind, null, sub || null) }, icon('external', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Hide panel', onclick: () => this.hidePanel() }, icon('x', 'sm'))),
    h('div', { class: 'explorer-path' },
      h('button', { class: 'icon-btn', 'data-tip': 'Up one folder (Mouse 4)', disabled: !sub, onclick: () => again(parts.slice(0, -1).join('/')) }, icon('arrow-up', 'sm')),
      crumbs),
    h('div', { class: 'dump-panel-hint faint' }, 'Shift+drag to carry or move into a folder · Ctrl+right-click sends to the open tool'),
    body);
    const remove = async (items) => {
      for (const it of items) { try { await api.dumpRemove(it.name, kind); } catch (e) { errorToast(e, it.base || it.name); } }
      toast(`Moved ${items.length === 1 ? (items[0].base || items[0].name) : `${items.length} items`} to ${folder}\\.removed`, { timeout: 2500 });
      again();
    };
    const rename = async (it, n) => {
      const to = it.isDir || extOf(n) ? n : `${n}.${extOf(it.base)}`;
      await api.dumpRename(it.name, to, kind);
      again();
    };
    const picker = rubberSelect(list, {
      scroller: () => body,
      menu: (items) => {
        const files = items.filter((x) => !x.isDir);
        return [
          { label: `Send ${files.length} to the open tool`, icon: 'send', shortcut: 'Ctrl+right-click', disabled: !files.length, action: () => this.sendToActive(files.map((x) => x.path)) },
          { label: `Open ${files.length}`, icon: 'file', disabled: !files.length, action: () => this.openMany(files) },
          ...this.videoEditorMenu(files.map((x) => x.path)),
          { label: 'Move into a new folder…', icon: 'folder-plus', action: async () => {
            const name = await promptDialog('New folder', 'Folder name', 'New folder');
            if (!name) return;
            try { const r = await api.dumpFolder(sub ? `${sub}/${name}` : name, kind); await api.dumpMove(items.map((x) => x.name), r.name, kind); again(); } catch (e) { errorToast(e); }
          } },
          { sep: true },
          { label: `Remove ${items.length} from the dump`, icon: 'trash', shortcut: 'Del', action: () => remove(items) },
        ];
      },
      onDelete: (items) => remove(items),
      onOpen: (items) => { const f = items.filter((x) => !x.isDir); if (f.length) this.openMany(f); else if (items.length === 1) again(items[0].name); },
    });
    // dropped on the panel (not on a folder): into the folder that's open
    body.addEventListener('dragover', (e) => { if ([PATHS_MIME, 'Files'].some((t) => e.dataTransfer.types.includes(t))) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; body.classList.add('drop'); } });
    body.addEventListener('dragleave', (e) => { if (!body.contains(e.relatedTarget)) body.classList.remove('drop'); });
    body.addEventListener('drop', async (e) => {
      body.classList.remove('drop');
      e.preventDefault();
      const paths = draggedPaths(e);
      for (const f of e.dataTransfer.files) { const fp = window.bdsShell?.pathForFile?.(f); if (fp) paths.push(fp); }
      if (paths.length) { await this.copyToDump(paths, kind, sub); again(); }
    });
    const { folders = [], items = [] } = res;
    if (!folders.length && !items.length) list.append(h('div', { class: 'empty-note' }, sub ? 'Empty folder. Drop files here, or Shift+drag them in.' : `Empty. Drop files here, or Shift+drag them in from Files. They live in Box-DocSpitter\\${folder}.`));
    for (const f of folders) {
      const row = h('button', { class: 'file-row dir dump-row', title: `${f.base}\n${f.count} item${f.count === 1 ? '' : 's'}\nClick to open · drop files here to put them in it · F2 rename · Del remove` },
        h('span', { class: 'fr-icon' }, icon('folder', 'sm')),
        h('span', { class: 'fr-name' }, f.base),
        h('span', { class: 'fr-meta' }, String(f.count)));
      row._item = f;
      hoverKeys(row, { nameEl: row.querySelector('.fr-name'), value: () => f.base, commit: (n) => rename(f, n),
        remove: () => remove(row.classList.contains('picked') && picker.picked().length > 1 ? picker.picked() : [f]) });
      row.addEventListener('click', (e) => { if (!e.ctrlKey && !e.shiftKey && !e.metaKey) again(f.name); });
      row.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Open', icon: 'folder-open', action: () => again(f.name) },
        { label: 'Rename…', icon: 'edit', shortcut: 'F2', action: () => { if (!renameInline(row)) promptDialog('Rename folder', 'New name', f.base).then((n) => n && rename(f, n).catch(errorToast)); } },
        { label: 'Show in Explorer', icon: 'external', action: () => api.dumpReveal(kind, f.name) },
        { sep: true },
        { label: 'Remove folder', icon: 'trash', shortcut: 'Del', action: () => remove([f]) },
      ]));
      dropInto(row, f.name);
      list.append(row);
    }
    for (const it of items) {
      const thumb = it.type === 'image' ? h('img', { class: 'fr-thumb', src: it.url, alt: '', loading: 'lazy', draggable: 'false' })
        : icon(it.type === 'video' ? 'video' : it.type === 'audio' ? 'music' : iconForName(it.base), 'sm');
      const row = h('button', { class: 'file-row dump-row', title: `${it.base}\n${formatBytes(it.size)} · added ${timeAgo(it.mtime)}\nDouble-click to open · Shift+drag to carry · Ctrl+right-click to send to the open tool` },
        h('span', { class: 'fr-icon' }, thumb),
        h('span', { class: 'fr-name' }, it.base),
        h('span', { class: 'fr-meta' }, formatBytes(it.size)));
      row._item = it;
      hoverKeys(row, { nameEl: row.querySelector('.fr-name'), value: () => it.base, selectBase: true, commit: (n) => rename(it, n),
        remove: () => remove(row.classList.contains('picked') && picker.picked().length > 1 ? picker.picked() : [it]) });
      row.addEventListener('dblclick', () => this.openPath(it.path));
      row.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Open', icon: 'file', action: () => this.openPath(it.path) },
        { label: 'Send to the open tool', icon: 'send', shortcut: 'Ctrl+right-click', action: () => this.sendToActive([it.path]) },
        ...this.videoEditorMenu([it.path]),
        { sep: true },
        { label: 'Copy as file', icon: 'copy', action: () => api.dumpClip(it.name, kind).then(() => toast(`Copied ${it.base}`, { type: 'ok', timeout: 1500 }), errorToast) },
        { label: 'Copy path', icon: 'link', action: () => navigator.clipboard.writeText(it.path) },
        { label: 'Rename…', icon: 'edit', shortcut: 'F2', action: () => { if (!renameInline(row)) promptDialog('Rename', 'New name', it.base, { selectBase: true }).then((n) => n && rename(it, n).catch(errorToast)); } },
        { label: 'Show in Explorer', icon: 'external', action: () => api.dumpReveal(kind, it.name) },
        ...(sub ? [{ label: 'Move up a folder', icon: 'arrow-up', action: () => api.dumpMove([it.name], parts.slice(0, -1).join('/'), kind).then(() => again(), errorToast) }] : []),
        { sep: true },
        { label: 'Remove from the dump', icon: 'trash', shortcut: 'Del', action: () => remove([it]) },
      ]));
      list.append(row);
    }
  }

  /**
   * Files on disk into a dump ('media' or 'doc'), into `folder` ('' = the top). Files from elsewhere are
   * copied; files already in this dump are moved into the folder. Files that don't belong there are skipped.
   */
  async copyToDump(paths, kind, folder) {
    let n = 0;
    let moved = 0;
    let skipped = 0;
    for (const p of paths) {
      try { const r = await api.dumpImport(p, kind, undefined, folder); if (r.moved) moved++; else if (!r.already) n++; } catch (e) { if (e.status === 400) skipped++; else errorToast(e, basename(p)); }
    }
    const where = (kind === 'media' ? 'media dump' : 'doc dump') + (folder ? ` (${folder})` : '');
    const parts = [n ? `added ${n} file${n === 1 ? '' : 's'}` : '', moved ? `moved ${moved}` : ''].filter(Boolean).join(', ');
    if (parts) toast(`${parts[0].toUpperCase()}${parts.slice(1)} — ${where}${skipped ? ` (${skipped} skipped: wrong kind of file)` : ''}`, { type: 'ok', timeout: 2200 });
    else if (skipped) toast(kind === 'media' ? 'Only pictures, videos and sounds go in the media dump.' : 'Only documents go in the doc dump.', { type: 'warn' });
    return n + moved;
  }

  async renderRecentPanel() {
    const p = clear(this.sidepanel);
    const list = h('div', { class: 'file-list' });
    p.append(h('div', { class: 'panel-head' }, 'Recent', h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', 'data-tip': 'Clear list', onclick: async () => { await api.removeRecent(null); this.renderRecentPanel(); } }, icon('trash', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Hide panel', onclick: () => this.hidePanel() }, icon('x', 'sm'))),
    h('div', { class: 'panel-body' }, list));
    rubberSelect(list, { scroller: () => list.parentElement, menu: (items) => this.recentManyMenu(items, () => this.renderRecentPanel()), onDelete: (items) => this.forgetRecents(items, () => this.renderRecentPanel()), onOpen: (items) => this.openMany(items) });
    try {
      const recent = await api.recent();
      if (!recent.length) list.append(h('div', { class: 'empty-note' }, 'Nothing yet.'));
      for (const r of recent) {
        const row = h('button', { class: `file-row ${r.exists ? '' : 'muted'}`, title: r.path },
          h('span', { class: 'fr-icon' }, icon(iconForName(r.name), 'sm')),
          h('span', { class: 'fr-name' }, r.name),
          h('span', { class: 'fr-meta' }, timeAgo(r.at)));
        row.addEventListener('click', () => r.exists && this.openPath(r.path));
        row.addEventListener('contextmenu', (e) => contextMenu(e, [
          { label: 'Show in folder', disabled: !r.exists, action: () => api.reveal(r.path) },
          { label: 'Remove from list', action: () => api.removeRecent(r.path).then(() => this.renderRecentPanel()) },
        ]));
        row._item = r;
        list.append(row);
      }
    } catch (e) { list.append(h('div', { class: 'empty-note' }, e.message)); }
  }

  renderSettings() {
    const p = clear(this.sidepanel);
    const s = this.settings;
    const sel = (key, options, onChange) => {
      const el = h('select', {}, options.map(([v, l]) => h('option', { value: v }, l)));
      el.value = String(s[key]);
      el.addEventListener('change', () => { const v = isNaN(el.value) ? el.value : Number(el.value); this.saveSettings({ [key]: v }); onChange?.(v); });
      return el;
    };
    const check = (key, label, onChange) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = s[key] !== false;
      cb.addEventListener('change', () => { this.saveSettings({ [key]: cb.checked }); onChange?.(cb.checked); });
      return h('label', { class: 'check' }, cb, label);
    };
    p.append(
      h('div', { class: 'panel-head' }, 'Settings', h('div', { class: 'grow' }), h('button', { class: 'icon-btn', onclick: () => this.hidePanel() }, icon('x', 'sm'))),
      h('div', { class: 'panel-body' }, h('div', { class: 'settings-panel' },
        h('div', { class: 'settings-group' }, h('h4', {}, 'Appearance'),
          sel('theme', [['dark', 'Dark — neon dusk'], ['light', 'Light — lavender'], ['pbj', 'PB&J — grape & peanut butter']], (v) => this.applyTheme(v)),
          check('sounds', 'Sounds', () => this.syncSoundButton()),
          check('soundTyping', 'Typing sounds'),
          check('soundHover', 'Hover sounds'),
          (() => {
            const r = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.soundVolume ?? 0.7), title: 'Sound volume' });
            r.addEventListener('input', () => { this.settings.soundVolume = Number(r.value); this.sounds.setVolume(); });
            r.addEventListener('change', () => { this.saveSettings({ soundVolume: Number(r.value) }); this.sounds.play('click'); });
            return h('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, h('span', { class: 'dim' }, 'Volume'), r);
          })()),
        this.soundSettings(),
        h('div', { class: 'settings-group' }, h('h4', {}, 'Documents'),
          h('span', { class: 'dim' }, 'Default font for new documents'),
          sel('docFont', ['Calibri', 'Arial', 'Georgia', 'Times New Roman', 'Cambria', 'Segoe UI', 'Verdana', 'Garamond', 'Inter'].map((f) => [f, f])),
          h('span', { class: 'dim' }, 'Default size'),
          sel('docSize', [10, 11, 12, 13, 14].map((n) => [n, n + ' pt'])),
          h('span', { class: 'dim' }, 'Paper'),
          sel('paper', [['white', 'White paper'], ['night', 'Night paper (dark)']], () => this.tabs.forEach((t) => t.editor?.onThemeChange?.())),
          check('spellcheck', 'Spell check while typing', () => this.tabs.forEach((t) => t.editor?.onThemeChange?.()))),
        h('div', { class: 'settings-group' }, h('h4', {}, 'Text & code'),
          h('span', { class: 'dim' }, 'Text editor font'),
          sel('textFont', [['mono', 'Monospace (IBM Plex Mono)'], ['sans', 'Sans (Inter)'], ['serif', 'Serif (Georgia)']], () => this.tabs.forEach((t) => t.editor?.onThemeChange?.())),
          h('span', { class: 'dim' }, 'Code font size'),
          sel('codeFontSize', [11, 12, 13, 14, 15, 16, 18].map((n) => [n, n + ' px']), () => this.tabs.forEach((t) => t.editor?.onThemeChange?.()))),
        h('div', { class: 'settings-group' }, h('h4', {}, 'Files'),
          check('nativeDialogs', 'Use Windows open/save dialogs'),
          check('showHidden', 'Show hidden & dot files', () => this.panel === 'explorer' && this.renderExplorer()),
          check('drafts', 'Keep crash-recovery drafts of unsaved work')),
        this.securitySettings(),
        this.setupTransferSettings(),
        this.updateSettings(),
        this.windowsSettings(),
        this.mailSettings(),
        this.discordSettings(),
        this.aiSettings(),
        this.easterEggSettings(),
        h('div', { class: 'settings-group' }, h('h4', {}, 'About'),
          h('span', { class: 'dim mono', style: { fontSize: '11px' } }, `v${window.BDS?.version} · data folder: Box-DocSpitter\\data`)),
        h('div', { class: 'settings-group danger-zone' }, h('h4', {}, 'Reset'),
          h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Erase everything Box-DocSpitter has stored and start fresh, like a new copy.'),
          h('button', { class: 'btn sm danger', onclick: () => this.factoryReset() }, icon('trash', 'sm'), 'Reset to clean state…')))));
  }

  async factoryReset() {
    const DUMP_KINDS = [['media', 'media dump', 'file'], ['doc', 'doc dump', 'document'], ['audio', 'audio dump', 'song']];
    const counts = {};
    await Promise.all(DUMP_KINDS.map(async ([k]) => { try { counts[k] = (await api.dump(k)).items.length; } catch { counts[k] = 0; } }));
    const dumpBoxes = DUMP_KINDS.map(([k, label, noun]) => {
      const cb = h('input', { type: 'checkbox', checked: counts[k] > 0 });
      cb.disabled = !counts[k];
      return { k, cb, row: h('label', { class: 'check' }, cb, counts[k] ? `Also delete the ${counts[k]} ${noun}${counts[k] === 1 ? '' : 's'} in the ${label}` : `The ${label} is empty`) };
    });
    const notesBox = h('input', { type: 'checkbox' });
    const ok = await modal({
      title: 'Reset to clean state',
      body: h('div', { class: 'reset-body' },
        h('p', {}, 'This permanently erases:'),
        h('ul', {},
          h('li', {}, 'settings, theme and window preferences'),
          h('li', {}, 'recent files and recent BoxSpaces'),
          h('li', {}, 'crash-recovery drafts and saved version history'),
          h('li', {}, 'your Anthropic API key, Discord lines and form-fill info'),
          h('li', {}, 'caches (app window cache, compiled StoragePeek scanner)')),
        ...dumpBoxes.map((b) => b.row),
        h('label', { class: 'check' }, notesBox, 'Also delete Secure notes (can’t be undone — without this they’re kept)'),
        h('p', { class: 'faint' }, 'Your own documents and files saved anywhere else are not touched. Box-DocSpitter restarts when it’s done.')),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Erase everything', value: 'ok', danger: true }],
    });
    if (ok !== 'ok') return;
    if (!(await this.closeAll())) return toast('Reset cancelled — a document is still open.', { type: 'warn' });
    if (notesBox.checked) await window.bdsShell?.notes?.({ op: 'lock', hard: true });
    let res;
    try {
      res = await fetch('/api/reset', { method: 'POST', headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ dumps: dumpBoxes.filter((b) => b.cb.checked).map((b) => b.k), secureNotes: notesBox.checked }) }).then((r) => r.json());
    } catch (e) { return errorToast(e, 'Reset failed'); }
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
    this.resetting = true;
    document.body.innerHTML = `<div class="loading-pane">${res.relaunch ? 'Reset complete — restarting Box-DocSpitter…' : 'Reset complete. Box-DocSpitter has stopped — start it again for a fresh copy.'}</div>`;
  }

  // ======================================================================= Windows file types

  // ======================================================================= startup notes, updates

  /** After the app is up: say how an update/rollback went, then the first-run welcome or "what's new". */
  async afterStartup() {
    const H = { 'X-BDS-Token': api.token };
    const version = window.BDS?.version || '';
    try {
      const st = await fetch('/api/update/status', { headers: H }).then((r) => r.json());
      const r = st?.result;
      if (r && !r.seen) {
        fetch('/api/update/seen', { method: 'POST', headers: H }).catch(() => {});
        if (r.manualRollback) toast(`Went back to ${r.version}.`, { type: 'ok', timeout: 6000 });
        else if (!r.ok) toast(`The update to ${r.version} didn’t work (${r.reason}), so Box-DocSpitter is still on ${r.from || 'the previous version'}. Nothing of yours was touched.`, { type: 'warn', timeout: 14000 });
      }
    } catch { /* browser mode or old server */ }
    this.launchUpdateCheck();
    // Ctrl+right-click on a file in Files / recents / BoxSpaces sends it to the tool that's open
    window.addEventListener('bds:send-files', (e) => this.sendToActive(e.detail?.paths || []));
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
      toast(git ? `Update ${info.latest} is on GitHub — this is a git copy, so update it with git pull.` : `Box-DocSpitter ${info.latest} is available (you have ${info.current}).`, {
        timeout: 0, closable: true,
        action: git ? null : { label: 'Update…', fn: () => { this.showPanel('settings'); setTimeout(() => [...document.querySelectorAll('.settings-group h4')].find((x) => x.textContent === 'Updates')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150); } },
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
        h('div', { class: 'welcome-head' }, h('img', { src: '/assets/icon.svg', alt: '' }), h('div', {}, h('b', {}, 'BOX//DOCSPITTER'), h('span', { class: 'faint mono' }, `v${window.BDS?.version}`))),
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

  /** Settings → Sounds: preview, swap or reset each UI sound. */
  soundSettings() {
    const list = h('div', { class: 'sound-list' });
    const render = async () => {
      const { SOUND_LABELS } = await import('./core/sounds.js');
      let custom = {};
      try { custom = await api.customSounds(); } catch { /* old server */ }
      clear(list);
      for (const [name, label] of Object.entries(SOUND_LABELS)) {
        const mine = custom[name];
        list.append(h('div', { class: 'sound-row' },
          h('button', { class: 'icon-btn', 'data-tip': 'Play it', onclick: () => this.sounds.preview(name) }, icon('play', 'sm')),
          h('div', { class: 'sound-name' }, h('span', {}, label), h('span', { class: 'faint mono' }, mine ? `your file · ${mine.file.replace(/^[^.]+/, name)}` : 'default')),
          h('button', { class: 'btn sm', onclick: () => pick(name) }, 'Change…'),
          mine ? h('button', { class: 'btn sm ghost', onclick: async () => { await api.resetSound(name).catch(errorToast); await this.sounds.reload(name, false); render(); } }, 'Default') : null));
      }
      if (Object.keys(custom).length) list.append(h('button', { class: 'btn sm ghost sound-reset-all', onclick: async () => {
        if (!(await confirmDialog('Back to the default sounds?', 'All the UI sounds go back to the ones Box-DocSpitter came with. Your own files are deleted from data\\sounds.', { okLabel: 'Use the defaults' }))) return;
        await api.resetSound(null).catch(errorToast);
        for (const n of Object.keys(custom)) await this.sounds.reload(n, false);
        render();
      } }, icon('undo', 'sm'), 'Reset all to default'));
    };
    const pick = async (name) => {
      const paths = await pickOpen({ title: 'Choose a sound', filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'webm'] }] });
      if (!paths?.length) return;
      try {
        const { bytes } = await api.read(paths[0]);
        if (bytes.length > 8 * 1024 * 1024) throw new Error('That file is too big for a UI sound (8 MB max). Short clips work best.');
        await api.setCustomSound(name, extOf(paths[0]), bytes);
        await this.sounds.reload(name, true);
        render();
      } catch (e) { errorToast(e, 'Couldn’t use that sound'); }
    };
    render();
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Sounds'),
      h('div', { class: 'dim', style: { fontSize: '12px' } }, 'Swap any UI sound for your own clip. Short sounds (under a second) feel best.'), list);
  }

  updateSettings() {
    const H = { 'X-BDS-Token': api.token };
    const call = (method, url, body) => fetch(url, { method, headers: { ...H, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Request failed'); return d; });
    const line = h('span', { class: 'dim mono', style: { fontSize: '11px' } }, `v${window.BDS?.version}`);
    const note = h('div', { class: 'dim', style: { fontSize: '12px' } });
    const out = h('div', { class: 'update-out' });
    const actions = h('div', { class: 'row', style: { flexWrap: 'wrap' } });
    const tokenRow = h('div', { class: 'row', style: { flexWrap: 'wrap' } });
    let st = null;

    const restartBtn = (v) => h('button', { class: 'btn sm primary', onclick: async () => {
      if (this.tabs.some((t) => t.dirty) && !(await confirmDialog('Restart now?', 'Some tabs have unsaved changes. Save them first, or they’ll be lost when the app restarts.', { okLabel: 'Restart anyway', danger: true }))) return;
      try { await call('POST', '/api/update/apply'); toast(`Restarting to install ${v}…`, { timeout: 5000 }); } catch (e) { errorToast(e); }
    } }, icon('refresh', 'sm'), `Restart & install ${v}`);

    const download = async (info) => {
      clear(actions).append(h('span', { class: 'dim' }, 'Downloading…'));
      try {
        const { id } = await call('POST', '/api/update/download');
        for (;;) {
          await new Promise((r) => setTimeout(r, 400));
          const j = await fetch(`/api/job?id=${id}`, { headers: H }).then((r) => r.json());
          if (j.status === 'running') { clear(actions).append(h('span', { class: 'dim' }, `${j.label}${j.bytes ? ' · ' + formatBytes(j.bytes) : ''}…`)); continue; }
          if (j.status !== 'done') throw new Error(j.error || 'The download failed');
          break;
        }
        clear(actions).append(restartBtn(info.latest), h('button', { class: 'btn sm ghost', onclick: async () => { await call('POST', '/api/update/cancel').catch(() => {}); refresh(); } }, 'Not now'));
        note.textContent = 'Downloaded and checked. Restarting installs it; your files, settings and dumps aren’t touched. If the new version doesn’t start, the old one comes back on its own.';
      } catch (e) {
        clear(actions).append(h('button', { class: 'btn sm', onclick: () => check() }, 'Try again'));
        note.textContent = e.message;
      }
    };

    const check = async () => {
      clear(out);
      clear(actions).append(h('span', { class: 'dim' }, 'Checking GitHub…'));
      let info;
      try { info = await call('POST', '/api/update/check'); } catch (e) { note.textContent = e.message; clear(actions).append(h('button', { class: 'btn sm', onclick: () => check() }, 'Check again')); return; }
      if (!info.newer) {
        note.textContent = `You’re up to date (${info.current}).`;
        clear(actions).append(h('button', { class: 'btn sm', onclick: () => check() }, icon('refresh', 'sm'), 'Check again'));
        return;
      }
      note.textContent = `${info.latest} is available (you have ${info.current}).`;
      if (info.notes?.length) out.append(h('ul', { class: 'update-notes' }, info.notes.map((n) => h('li', {}, n))));
      for (const w of info.warnings || []) out.append(h('div', { class: 'update-warn' }, icon('alert', 'sm'), w));
      clear(actions);
      if (st?.blocked) { out.append(h('div', { class: 'update-warn' }, icon('info', 'sm'), st.blocked)); return; }
      if (info.warnings?.length) return;
      actions.append(h('button', { class: 'btn sm primary', onclick: () => download(info) }, icon('download', 'sm'), `Download ${info.latest}`));
    };

    const renderToken = () => {
      clear(tokenRow);
      if (st?.hasToken) {
        tokenRow.append(h('span', { class: 'dim', style: { fontSize: '12px' } }, '● GitHub token saved (only used to reach a private repo)'),
          h('button', { class: 'btn sm ghost', onclick: async () => { try { await call('POST', '/api/update/token', { token: null }); st.hasToken = false; renderToken(); } catch (e) { errorToast(e); } } }, 'Remove'));
        return;
      }
      const input = h('input', { type: 'password', placeholder: 'GitHub token, only if the repo is private', autocomplete: 'off', spellcheck: 'false', style: { flex: '1', minWidth: '220px' } });
      tokenRow.append(input, h('button', { class: 'btn sm', onclick: async () => {
        try { await call('POST', '/api/update/token', { token: input.value }); st.hasToken = true; renderToken(); toast('Token saved', { type: 'ok' }); } catch (e) { errorToast(e); }
      } }, 'Save'));
    };

    const refresh = async () => {
      try { st = await fetch('/api/update/status', { headers: H }).then((r) => r.json()); } catch { line.textContent = 'Couldn’t read the update status.'; return; }
      line.textContent = `v${st.version} · updates from github.com/${st.repo}`;
      note.textContent = st.blocked || '';
      clear(out);
      clear(actions);
      if (st.pending && !st.blocked) {
        note.textContent = `${st.pending.version} is downloaded and ready.`;
        actions.append(restartBtn(st.pending.version), h('button', { class: 'btn sm ghost', onclick: async () => { await call('POST', '/api/update/cancel').catch(() => {}); refresh(); } }, 'Discard it'));
      } else {
        actions.append(h('button', { class: 'btn sm', onclick: () => check() }, icon('refresh', 'sm'), 'Check for updates'));
      }
      actions.append(h('button', { class: 'btn sm ghost', onclick: () => this.showWhatsNew() }, 'What’s new'));
      const last = st.backups?.[0];
      if (last && !st.blocked) actions.append(h('button', { class: 'btn sm ghost', 'data-tip': 'Puts back the version from before the last update', onclick: async () => {
        if (!(await confirmDialog(`Go back to ${last.from}?`, `Box-DocSpitter restarts on ${last.from}, the version you had before updating to ${last.version}. Your files, settings and dumps aren’t touched.`, { okLabel: `Go back to ${last.from}` }))) return;
        try { await call('POST', '/api/update/rollback'); toast('Restarting…', { timeout: 4000 }); } catch (e) { errorToast(e); }
      } }, icon('undo', 'sm'), `Go back to ${last.from}`));
      renderToken();
    };
    refresh();
    const auto = h('input', { type: 'checkbox', checked: this.settings.updateCheckOnLaunch !== false });
    auto.addEventListener('change', () => this.saveSettings({ updateCheckOnLaunch: auto.checked }));
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Updates'), line, note, out, actions, h('label', { class: 'check' }, auto, 'Check for updates when the app starts'), tokenRow);
  }

  windowsSettings() {
    const status = h('span', { class: 'dim mono', style: { fontSize: '11px' } }, 'checking…');
    const actions = h('div', { class: 'row', style: { flexWrap: 'wrap' } });
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Request failed'); return d; });
    const refresh = async () => {
      let st;
      try { st = await fetch('/api/system/associations', { headers: { 'X-BDS-Token': api.token } }).then((r) => r.json()); } catch { st = { supported: false }; }
      clear(actions);
      if (!st.supported) { status.textContent = 'Only available on Windows.'; return; }
      status.textContent = st.count ? `● registered for ${st.count} file type${st.count === 1 ? '' : 's'}` : '○ not registered with Windows yet';
      if (st.moved) status.textContent += ' — the app folder moved, click “Choose file types” to update';
      actions.append(...[
        h('button', { class: 'btn sm', onclick: () => this.fileTypesDialog(st.registered || {}, post).then(refresh) }, icon('file', 'sm'), st.count ? 'Change file types…' : 'Choose file types…'),
        st.count ? h('button', { class: 'btn sm primary', onclick: () => post('/api/system/default-apps').catch(errorToast) }, 'Set as default…') : null,
        st.count ? h('button', { class: 'btn sm ghost', onclick: async () => {
          if (!(await confirmDialog('Remove from Windows?', 'Box-DocSpitter will disappear from “Open with” and Default apps. Files you had set to open with it go back to Windows asking which app to use.', { okLabel: 'Remove', danger: true }))) return;
          try { await post('/api/system/associations/remove'); toast('Removed from Windows', { type: 'ok' }); } catch (e) { errorToast(e); }
          refresh();
        } }, 'Remove') : null].filter(Boolean));
    };
    refresh();
    const shortcutBtn = window.bdsShell?.createShortcuts ? h('button', { class: 'btn sm', onclick: async () => {
      try {
        const made = await window.bdsShell.createShortcuts();
        toast(made.length ? 'Added to the Start menu and Desktop — right-click either one (or the open window’s taskbar button) → Pin to taskbar' : 'Couldn’t create the shortcuts', { type: made.length ? 'ok' : 'error', timeout: 6000 });
      } catch (e) { errorToast(e); }
    } }, icon('pin', 'sm'), 'Add to Start menu & Desktop') : null;
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Windows'),
      h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Open PDFs, documents, text and config files with Box-DocSpitter when you double-click them.'),
      status, actions,
      shortcutBtn,
      shortcutBtn ? h('span', { class: 'faint', style: { fontSize: '11px' } }, 'To pin it: right-click Box-DocSpitter’s button on the taskbar while it’s open → Pin to taskbar.') : null);
  }

  async fileTypesDialog(current, post) {
    const GROUPS = [
      ['pdf', 'PDF documents', ['pdf'], true],
      ['doc', 'Word & rich text', ['docx', 'doc', 'odt', 'rtf'], true],
      ['text', 'Text & notes', ['txt', 'log', 'md', 'markdown'], true],
      ['config', 'Config files', ['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'properties'], true],
      ['sheet', 'Spreadsheets', ['xlsx', 'xls', 'ods', 'csv', 'tsv'], true],
      ['mail', 'Saved emails', ['eml'], true],
      ['code', 'Code', ['js', 'ts', 'py', 'ps1', 'bat', 'cmd', 'sh', 'css', 'lua', 'sql'], false],
      ['web', 'Web pages', ['html', 'htm'], false],
      ['image', 'Images', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'], false],
      ['video', 'Videos', ['mp4', 'mkv', 'webm', 'mov', 'avi'], false],
    ];
    const has = Object.keys(current).length;
    const boxes = GROUPS.map(([id, label, exts, def]) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = has ? exts.some((e) => current[e]) : def;
      return { id, exts, cb, row: h('label', { class: 'check filetype-row' }, cb, h('span', {}, label), h('span', { class: 'faint mono' }, exts.map((e) => '.' + e).join(' '))) };
    });
    const res = await modal({
      title: 'Open these with Box-DocSpitter', wide: true,
      body: h('div', { class: 'filetypes' },
        h('div', { class: 'faint', style: { fontSize: '12px', marginBottom: '10px' } }, 'Box-DocSpitter registers itself with Windows for these types (just for your account, no admin needed). Then Windows asks you to confirm it as the default — apps aren’t allowed to do that part by themselves.'),
        ...boxes.map((b) => b.row)),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Register', value: 'ok', primary: true }],
    });
    if (res !== 'ok') return;
    const groups = {};
    for (const b of boxes) if (b.cb.checked) groups[b.id] = b.exts;
    if (!Object.keys(groups).length) {
      await post('/api/system/associations/remove').catch(() => {});
      return toast('No file types selected — removed from Windows.', { timeout: 3000 });
    }
    const done = toast('Registering with Windows…', { timeout: 0 });
    try {
      const st = await post('/api/system/associations', { groups });
      done();
      const next = await modal({
        title: 'One more step',
        body: h('div', {},
          h('p', {}, `Box-DocSpitter is now registered for ${st.count} file types and shows up in “Open with”.`),
          h('p', {}, 'To make it the default, Windows Settings will open on Box-DocSpitter’s page: click ', h('b', {}, 'Set default'), ' at the top (or pick it per file type).')),
        buttons: [{ label: 'Later', value: null, ghost: true }, { label: 'Open Default apps', value: 'go', primary: true }],
      });
      if (next === 'go') await post('/api/system/default-apps');
    } catch (e) { done(); errorToast(e, 'Could not register'); }
  }

  // ======================================================================= email settings

  mailSettings() {
    const list = h('div', { class: 'mail-acct-list' });
    const draw = (accounts) => {
      clear(list);
      if (!accounts.length) list.append(h('span', { class: 'faint', style: { fontSize: '11px' } }, 'No accounts yet.'));
      for (const a of accounts) {
        list.append(h('div', { class: 'row mail-acct-row' }, icon('mail', 'sm'), h('span', { class: 'grow mono', style: { fontSize: '11.5px' } }, a.address),
          h('button', { class: 'btn sm ghost', onclick: async () => {
            if (!(await confirmDialog('Remove account?', `BoxMail will forget ${a.address} and its app password. Nothing in your Gmail changes.`, { okLabel: 'Remove', danger: true }))) return;
            const r = await fetch('/api/mail/accounts/remove', { method: 'POST', headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: a.id }) }).then((x) => x.json());
            draw(r.accounts || []);
            for (const t of this.tabs) if (t.mode === 'mail' && t.editor && !t.editor.emlMode) t.editor.load(null);
          } }, 'Remove')));
      }
    };
    fetch('/api/mail/accounts', { headers: { 'X-BDS-Token': api.token } }).then((r) => r.json()).then((r) => draw(r.accounts || [])).catch(() => draw([]));
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Email (BoxMail)'),
      list,
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: async () => {
          const { addMailAccountDialog } = await import('./editors/mail.js');
          const accounts = await addMailAccountDialog();
          if (accounts) { draw(accounts); for (const t of this.tabs) if (t.mode === 'mail' && t.editor && !t.editor.emlMode) { clear(t.pane); t.editor.load(null); } }
        } }, icon('plus', 'sm'), 'Add Gmail account…'),
        h('button', { class: 'btn sm ghost', onclick: () => this.newDocument('mail') }, 'Open BoxMail')),
      h('label', { class: 'check' }, (() => {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = this.settings.mailBlockImages === true;
        cb.addEventListener('change', () => this.saveSettings({ mailBlockImages: cb.checked }));
        return cb;
      })(), 'Block remote images until I click Load (stops senders seeing when you open their email)'),
      h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Uses Google app passwords, stored only on this PC. Browsing never marks mail as read.'));
  }

  // ======================================================================= ask claude settings

  aiSettings() {
    const status = h('span', { class: 'dim mono', style: { fontSize: '11px' } }, 'checking…');
    const setKey = async (key) => {
      const r = await fetch('/api/ai/key', { method: 'POST', headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      if (!r.ok) throw new Error((await r.json()).error);
    };
    const refresh = async () => {
      const s = await fetch('/api/ai/status', { headers: { 'X-BDS-Token': api.token } }).then((r) => r.json()).catch(() => ({}));
      status.textContent = s.configured ? `● key saved (${s.keyHint})${s.fromEnv ? ' from ANTHROPIC_API_KEY' : ''}` : '○ no API key yet';
      this.rightPanels?.ai?.panel?.refreshStatus();
    };
    refresh();
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Ask Claude'),
      status,
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: async () => { const k = await promptDialog('Anthropic API key', 'Paste a key from console.anthropic.com', '', { type: 'password', placeholder: 'sk-ant-…' }); if (!k) return; try { await setKey(k); toast('Key saved', { type: 'ok' }); refresh(); } catch (e) { errorToast(e); } } }, 'Set key…'),
        h('button', { class: 'btn sm ghost', onclick: async () => { if (await confirmDialog('Remove API key?', 'Ask Claude will stop working until you add a key again.', { okLabel: 'Remove', danger: true })) { await setKey(''); refresh(); } } }, 'Remove'),
        h('button', { class: 'btn sm ghost', onclick: () => this.toggleRightPanel(this.rightPanel === 'ai' && !this.panelOnTop('ai') ? null : 'ai') }, 'Open panel')),
      h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Optional. Text goes to Anthropic only when you press send. Billed to your Anthropic account.'));
  }

  // ======================================================================= discord settings

  discordSettings() {
    const s = this.settings;
    const savePresence = debounce((patch) => { this.saveSettings(patch); this.presence.update(); }, 350);
    const set = (patch) => { Object.assign(s, patch); renderPreview(); savePresence(patch); };

    const enabled = h('input', { type: 'checkbox' });
    enabled.checked = !!s.discordEnabled;
    enabled.addEventListener('change', () => { set({ discordEnabled: enabled.checked }); body.hidden = !enabled.checked; });

    const idIn = h('input', { type: 'text', placeholder: 'Application ID (numbers)', value: s.discordClientId || '', spellcheck: 'false', class: 'mono' });
    idIn.addEventListener('input', () => set({ discordClientId: idIn.value.trim() }));

    const modeSeg = h('div', { class: 'seg' });
    const autoBox = h('div', { class: 'col' });
    const customBox = h('div', { class: 'col' });
    for (const [m, label] of [['auto', 'Automatic'], ['custom', 'Custom']]) {
      const b = h('button', { class: (s.discordMode || 'auto') === m ? 'on' : '' }, label);
      b.addEventListener('click', () => {
        [...modeSeg.children].forEach((x) => x.classList.toggle('on', x === b));
        autoBox.hidden = m !== 'auto';
        customBox.hidden = m !== 'custom';
        set({ discordMode: m });
      });
      modeSeg.append(b);
    }
    autoBox.hidden = (s.discordMode || 'auto') !== 'auto';
    customBox.hidden = s.discordMode !== 'custom';

    const styleSel = h('select', {}, h('option', { value: 'silly' }, 'Silly lines (“centering a div”)'), h('option', { value: 'plain' }, 'Plain lines (“Editing a .pdf”)'));
    styleSel.value = s.discordStyle || 'silly';
    styleSel.addEventListener('change', () => set({ discordStyle: styleSel.value }));
    autoBox.append(h('span', { class: 'dim' }, 'Picks a line from the kind of file you have open.'), styleSel);

    const detailsIn = h('input', { type: 'text', maxlength: '120', placeholder: 'top line, e.g. editing a .{ext}', value: s.discordDetails ?? 'spitting out documents' });
    const stateIn = h('input', { type: 'text', maxlength: '120', placeholder: 'second line, e.g. {tabs} tabs deep', value: s.discordState ?? '' });
    detailsIn.addEventListener('input', () => set({ discordDetails: detailsIn.value }));
    stateIn.addEventListener('input', () => set({ discordState: stateIn.value }));
    customBox.append(
      h('span', { class: 'dim' }, 'Top line'), detailsIn,
      h('span', { class: 'dim' }, 'Second line'), stateIn,
      h('span', { class: 'faint mono', style: { fontSize: '10.5px' } }, 'placeholders: {ext} → pdf · {kind} → spreadsheet · {tabs} → 3'));

    const timeCb = h('input', { type: 'checkbox' });
    timeCb.checked = s.discordShowTime !== false;
    timeCb.addEventListener('change', () => set({ discordShowTime: timeCb.checked }));

    // preview card styled after Discord's profile activity
    const pvDetails = h('div', { class: 'dp-line strong' });
    const pvState = h('div', { class: 'dp-line' });
    const pvTime = h('div', { class: 'dp-line faint' });
    const preview = h('div', { class: 'discord-preview' },
      h('div', { class: 'dp-head' }, 'playing a game'),
      h('div', { class: 'dp-body' }, h('img', { src: '/assets/icon.svg', class: 'dp-img', alt: '' }),
        h('div', { class: 'dp-text' }, h('div', { class: 'dp-line strong' }, 'Box-DocSpitter'), pvDetails, pvState, pvTime)));
    const statusEl = h('div', { class: 'dp-status mono' });
    const statusText = {
      off: 'off', connecting: 'connecting to Discord…', connected: '● connected — showing on your profile',
      'discord-not-running': 'Discord desktop app isn’t running', 'discord-closed': 'Discord closed the connection',
      'bad-id': 'that Application ID doesn’t look right',
    };
    const renderStatus = (st) => {
      statusEl.textContent = statusText[st] || st || '';
      statusEl.classList.toggle('ok', st === 'connected');
      statusEl.classList.toggle('bad', /not-running|bad-id|closed|error/.test(st || ''));
    };
    const renderPreview = () => {
      const a = this.presence.preview();
      pvDetails.textContent = a.details || '';
      pvState.textContent = a.state || '';
      pvTime.textContent = a.start ? '00:42 elapsed' : '';
      pvState.hidden = !a.state;
      pvTime.hidden = !a.start;
    };
    this.onPresenceStatus = renderStatus;
    renderPreview();
    renderStatus(this.presenceStatus);

    const exportLogo = h('button', {
      class: 'btn sm',
      onclick: async () => {
        const img = new Image();
        img.src = '/assets/icon.svg';
        await img.decode();
        const c = h('canvas', { width: 1024, height: 1024 });
        c.getContext('2d').drawImage(img, 0, 0, 1024, 1024);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        this.saveBytesAs(blob, { defaultName: 'box-docspitter-logo.png', filters: [{ name: 'PNG image', extensions: ['png'] }], openAfter: false });
      },
    }, icon('download', 'sm'), 'Save logo PNG');

    const body = h('div', { class: 'col' },
      h('span', { class: 'dim' }, 'Application ID'), idIn,
      h('details', { class: 'dp-help' }, h('summary', {}, 'how do I get one?'),
        h('ol', {},
          h('li', {}, 'Open discord.com/developers/applications'),
          h('li', {}, 'New Application → name it “Box-DocSpitter” (that name shows as “Playing …”)'),
          h('li', {}, 'Copy the Application ID and paste it above'),
          h('li', {}, 'Optional: Rich Presence → Art Assets → upload the logo PNG named “logo”')),
        exportLogo),
      h('span', { class: 'dim' }, 'Mode'), modeSeg, autoBox, customBox,
      h('label', { class: 'check' }, timeCb, 'Show elapsed time'),
      preview, statusEl,
      h('span', { class: 'faint', style: { fontSize: '11px' } }, 'File names and folders are never sent — only what you type here or the kind of file.'));
    body.hidden = !enabled.checked;

    if (s.discordEnabled) api.presenceStatus().then((r) => renderStatus(r.status)).catch(() => {});
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Discord'),
      h('label', { class: 'check' }, enabled, 'Show what I’m doing in Discord'), body);
  }

  // ======================================================================= keys, dnd, lifecycle

  /** Mouse back / forward (buttons 4 and 5): folders when over the file explorer, otherwise tabs. */
  wireMouseNav() {
    const go = async (dir, overExplorer) => {
      const ex = this.explorer;
      if (overExplorer && (this.panel === 'mediadump' || this.panel === 'docdump')) {
        const k = this.panel === 'mediadump' ? 'media' : 'doc';
        const cur = this.dumpDirs?.[k] || '';
        if (dir < 0 && cur) this.renderDumpPanel(k, cur.split('/').slice(0, -1).join('/'));
        return;
      }
      if (overExplorer && this.panel === 'explorer') {
        const from = dir < 0 ? ex.back : ex.fwd;
        const to = dir < 0 ? ex.fwd : ex.back;
        const target = from.pop();
        if (!target) return;
        to.push(ex.dir);
        return this.renderExplorer(target, { history: false });
      }
      const th = this.tabHist;
      let i = th.pos + dir;
      // skip tabs that have been closed since
      while (i >= 0 && i < th.list.length && th.list[i] !== null && !this.tabs.includes(th.list[i])) i += dir;
      if (i < 0 || i >= th.list.length) return;
      th.pos = i;
      th.moving = true;
      try { this.activate(th.list[i]); } finally { th.moving = false; }
    };
    // stop the page itself from navigating on these buttons
    for (const ev of ['mousedown', 'auxclick']) window.addEventListener(ev, (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); }, true);
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (document.querySelector('.modal-backdrop')) return;
      go(e.button === 3 ? -1 : 1, !!e.target.closest?.('#sidepanel'));
    }, true);
  }

  wireKeys() {
    window.addEventListener('keydown', (e) => {
      if (modalOpen() || menusOpen()) return;
      const ed = this.active?.editor;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ed?.handlesKey?.(e)) return;
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (ctrl && e.altKey && k === 'l') { stop(); this.lockApp('manual'); return; }
      if (ctrl && e.shiftKey && k === 'p') { stop(); this.commandPalette('commands'); return; }
      if (ctrl && !e.shiftKey && !e.altKey && k === 'e') { stop(); this.commandPalette('files'); return; }
      if (ctrl && !e.shiftKey && k === 's') { stop(); this.save(); }
      else if (ctrl && e.shiftKey && k === 's') { stop(); this.saveAs(); }
      else if (ctrl && k === 'o') { stop(); this.openDialog(); }
      else if (e.altKey && k === 'n') { stop(); this.newDocument('doc'); }
      else if (e.altKey && k === 'w') { stop(); this.closeTab(this.active); }
      else if (ctrl && k === 'p') { stop(); ed?.print(); }
      else if (ctrl && k === 'f' && ed) { stop(); ed.find(false); }
      else if (ctrl && k === 'h' && ed) { stop(); ed.find(true); }
      else if (ctrl && (k === '=' || k === '+') && ed) { stop(); ed.zoom(+1); }
      else if (ctrl && k === '-' && ed) { stop(); ed.zoom(-1); }
      else if (ctrl && k === '0' && ed) { stop(); ed.zoom(0); }
      else if (e.key === 'F1') { stop(); this.showShortcuts(); }
      else if (e.key === 'F11') { stop(); this.toggleFocus(); }
      else if (ctrl && e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        stop();
        if (!this.tabs.length) return;
        const i = this.tabs.indexOf(this.active);
        const n = e.key === 'ArrowRight' ? (i + 1) % this.tabs.length : (i - 1 + this.tabs.length) % this.tabs.length;
        this.activate(this.tabs[n]);
      } else if (e.altKey && /^[1-9]$/.test(e.key)) { stop(); const t = this.tabs[Number(e.key) - 1]; if (t) this.activate(t); }
    });
    // Ctrl+wheel zoom
    window.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !this.active?.editor) return;
      if (this.active.editor.handlesWheelZoom) return;
      e.preventDefault();
      this.active.editor.zoom(e.deltaY < 0 ? +1 : -1);
    }, { passive: false });
  }

  wireDragDrop() {
    let overlay = null;
    let depth = 0;
    const isFiles = (e) => e.dataTransfer?.types?.includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!isFiles(e)) return;
      depth++;
      if (!overlay) { overlay = h('div', { class: 'drag-overlay' }, '▸ drop to open'); document.body.append(overlay); }
    });
    window.addEventListener('dragleave', (e) => {
      if (!isFiles(e)) return;
      depth--;
      if (depth <= 0) { overlay?.remove(); overlay = null; depth = 0; }
    });
    window.addEventListener('dragover', (e) => { if (isFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
      overlay?.remove(); overlay = null; depth = 0;
      if (!isFiles(e)) return;
      // editors can claim drops (e.g. images into a document)
      if (e.defaultPrevented) return;
      e.preventDefault();
      for (const f of e.dataTransfer.files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        await this.openBytes(f.name, bytes);
      }
      toast('Dropped files open as copies — use Save as to choose where they go.', { timeout: 4500 });
    });
  }

  startHeartbeat() {
    const beat = () => api.heartbeat(this.clientId).catch(() => {});
    beat();
    setInterval(beat, 5000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') beat(); });
    window.addEventListener('pagehide', () => api.bye(this.clientId));
    window.addEventListener('beforeunload', (e) => {
      if (this.tabs.some((t) => t.dirty)) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  toggleFocus() {
    const on = document.body.classList.toggle('focus-mode');
    window.bdsShell?.setFullScreen(on).catch(() => {});
    this.active?.editor?.onShow?.();
  }

  async quit() {
    if (!(await this.closeAll())) return;
    await api.quit().catch(() => {});
    document.body.innerHTML = '<div class="loading-pane">Box-DocSpitter has stopped. You can close this window.</div>';
    setTimeout(() => window.close(), 300);
  }

  showShortcuts() {
    const rows = [
      ['New document', 'Alt+N'], ['Open file', 'Ctrl+O'], ['Save', 'Ctrl+S'], ['Save as', 'Ctrl+Shift+S'], ['Close tab', 'Alt+W'],
      ['Next / previous tab', 'Ctrl+Alt+→ / ←'], ['Jump to tab 1–9', 'Alt+1…9'], ['Print', 'Ctrl+P'], ['Find', 'Ctrl+F'], ['Find & replace', 'Ctrl+H'],
      ['Zoom in / out / reset', 'Ctrl+= / - / 0'], ['Focus mode', 'F11'], ['Shortcuts', 'F1'], ['Lock the app (with a PIN set)', 'Ctrl+Alt+L'],
    ];
    const hoverRows = [
      ['Rename what’s under the mouse', 'F2'], ['Put the original name back', 'Ctrl+F2'], ['Remove what’s under the mouse', 'Del'],
      ['Change the home logo (hover it)', 'F2'], ['Pick from a menu', 'Hold, drag, release'],
    ];
    const mouseRows = [
      ['Back / forward between tabs', 'Mouse 4 / Mouse 5'], ['Back / forward between folders (over the file panel)', 'Mouse 4 / Mouse 5'],
      ['Pick several files (Files, recents, BoxSpaces)', 'Drag'], ['Carry files to the video editor, a dump…', 'Shift+drag'],
      ['Send files to the open tool', 'Ctrl+right-click'],
      ['Video editor: seek (timeline or preview)', 'Shift+click / Shift+drag'], ['Video editor: place a clip without snapping', 'Shift mid-drag'], ['Dump folders: up a level (over the dump panel)', 'Mouse 4'],
    ];
    const docRows = [
      ['Bold / italic / underline', 'Ctrl+B / I / U'], ['Strikethrough', 'Alt+Shift+5'], ['Insert link', 'Ctrl+K'], ['Heading 1–3', 'Ctrl+Alt+1…3'],
      ['Normal text', 'Ctrl+Alt+0'], ['Bulleted / numbered list', 'Ctrl+Shift+8 / 7'], ['Align left / center / right', 'Ctrl+Shift+L / E / R'],
      ['Paste as plain text', 'Ctrl+Shift+V'], ['Page break', 'Ctrl+Enter'], ['Increase / decrease size', 'Ctrl+Shift+. / ,'],
    ];
    const table = (r) => h('table', { class: 'shortcut-table' }, r.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, h('kbd', {}, b)))));
    modal({
      title: 'Keyboard shortcuts', wide: true,
      body: h('div', { class: 'cols-2' }, h('div', {}, h('div', { class: 'menu-heading' }, 'Everywhere'), table(rows)), h('div', {}, h('div', { class: 'menu-heading' }, 'Documents'), table(docRows),
        h('div', { class: 'menu-heading' }, 'PDF'), table([['Select / Text / Draw', 'V / T / D'], ['Highlight / Rectangle', 'H / R'], ['Delete selection', 'Del'], ['Undo / redo', 'Ctrl+Z / Y']]),
        h('div', { class: 'menu-heading' }, 'Hover a name (dumps, layers, songs, files, home cards)'), table(hoverRows),
        h('div', { class: 'menu-heading' }, 'Mouse'), table(mouseRows),
        h('div', { class: 'menu-heading' }, 'BoxDiff'), table([['Next / previous change', 'F7 / Shift+F7']]))),
    });
  }

  /** Help → README: README.md rendered in a window of its own (opening it again just brings that window forward). */
  async showReadme() {
    const w = window.open('', 'bds-readme', 'width=980,height=860');
    if (!w) return toast('Couldn’t open a window for the README', { type: 'error' });
    if (w.document.body?.dataset.readme) { w.focus(); return; }
    let html;
    try {
      const [{ text }, marked, { sanitizeHtml }] = await Promise.all([api.get('/api/readme'), vendor.marked(), import('./editors/doc/html-tools.js')]);
      html = sanitizeHtml(marked.parse(text, { gfm: true }), { keepWhitespace: true });
    } catch (e) { w.close(); return errorToast(e, 'Couldn’t load the README'); }
    // the window wears the app's current theme
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    const d = w.document;
    d.open();
    d.write(`<!doctype html><html><head><meta charset="utf-8"><title>Box-DocSpitter — README</title><style>
      :root { color-scheme: ${this.settings.theme === 'light' ? 'light' : 'dark'}; }
      body { margin: 0; background: ${v('--bg-0')}; color: ${v('--text')}; font: 14px/1.6 Inter, "Segoe UI", system-ui, sans-serif; }
      main { max-width: 860px; margin: 0 auto; padding: 28px 32px 60px; }
      h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.6em; }
      h1 { font-size: 26px; margin-top: 0.4em; } h2 { font-size: 20px; padding-bottom: 6px; border-bottom: 1px solid ${v('--line')}; } h3 { font-size: 16px; }
      a { color: ${v('--accent')}; }
      code { font: 12.5px "IBM Plex Mono", Consolas, monospace; background: ${v('--bg-2')}; border: 1px solid ${v('--line')}; border-radius: 4px; padding: 1px 5px; }
      pre { background: ${v('--bg-2')}; border: 1px solid ${v('--line')}; border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
      pre code { background: none; border: 0; padding: 0; }
      table { border-collapse: collapse; margin: 1em 0; display: block; overflow-x: auto; }
      th, td { border: 1px solid ${v('--line-2')}; padding: 6px 10px; text-align: left; vertical-align: top; }
      th { background: ${v('--bg-2')}; }
      thead:not(:has(th:not(:empty))) { display: none; }
      blockquote { margin: 1em 0; padding: 2px 14px; border-left: 3px solid ${v('--accent-line')}; color: ${v('--text-2')}; }
      hr { border: 0; border-top: 1px solid ${v('--line')}; margin: 2em 0; }
      img { max-width: 100%; }
      ::-webkit-scrollbar { width: 10px; height: 10px; } ::-webkit-scrollbar-thumb { background: ${v('--scroll')}; border-radius: 5px; }
    </style></head><body data-readme="1"><main>${html}</main></body></html>`);
    d.close();
    // GitHub-style heading ids, so the README's own #links work
    const seen = {};
    for (const hd of d.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      if (hd.id) continue;
      let id = hd.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
      if (seen[id] != null) id += `-${++seen[id]}`; else seen[id] = 0;
      hd.id = id;
    }
    // web links open in the default browser (via the main window), never inside the README window
    d.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (!a || a.getAttribute('href').startsWith('#')) return;
      e.preventDefault();
      if (/^https?:/i.test(a.href)) window.open(a.href, '_blank', 'noopener');
    });
    w.focus();
  }

  showAbout() {
    modal({
      title: 'About',
      body: h('div', { class: 'col' },
        h('div', { class: 'row' }, h('img', { src: '/assets/icon.svg', style: { width: '44px' } }), h('div', {}, h('div', { class: 'brand-name', style: { fontSize: '15px' } }, 'BOX//DOCSPITTER'), h('div', { class: 'faint mono' }, 'v' + window.BDS?.version))),
        h('p', {}, 'A self-hosted document workstation. Everything runs on this PC at 127.0.0.1. Your files never leave it.'),
        h('p', { class: 'dim' }, 'Built with pdf.js, pdf-lib, Monaco, SheetJS, docx and JSZip, all served from your own disk.'),
        h('p', { class: 'dim mono', style: { fontSize: '11.5px' } }, 'Backups of every save: Box-DocSpitter\\data\\backups'),
        h('p', { class: 'dim' }, 'Made by boxbind · Discord: @boxbind')),
    });
  }
}

const app = new App();
window.bdsApp = app;
app.init().catch((e) => console.error(e));
export default app;
