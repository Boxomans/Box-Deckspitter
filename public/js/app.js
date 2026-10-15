// Box-DocSpitter — application shell. App is spread over app/*.js, a part per file.

import { $, h, uid } from './core/dom.js';
import { api } from './core/api.js';
import { configureFiles } from './core/files.js';
import { createPresence } from './core/presence.js';
import { createSounds } from './core/sounds.js';
import { createClips } from './core/clips.js';
import { createMusic } from './core/music.js';
import { createClock } from './core/clock.js';
import { createCalendar } from './core/calendar.js';
import { LockPart } from './app/lock.js';
import { EasterEggsPart } from './app/easter-eggs.js';
import { RailPart } from './app/rail.js';
import { SidebarsPart } from './app/sidebars.js';
import { ThemesPart } from './app/themes.js';
import { MenusPart } from './app/menus.js';
import { TabsPart } from './app/tabs.js';
import { DocumentsPart } from './app/documents.js';
import { HomePart } from './app/home.js';
import { PanelsPart } from './app/panels.js';
import { ExplorerPart } from './app/explorer.js';
import { DumpsPart } from './app/dumps.js';
import { SettingsPart } from './app/settings.js';
import { SettingsSectionsPart } from './app/settings-sections.js';
import { StartupPart } from './app/startup.js';
import { WindowPart } from './app/window.js';

const DEFAULT_SETTINGS = {
  theme: 'dark', uiFont: 'theme', nativeDialogs: true, showHidden: false, drafts: true, spellcheck: true,
  docFont: 'Calibri', docSize: 11, codeFontSize: 13, textFont: 'mono', textFontSize: 14, paper: 'white',
  sidebar: null, explorerDir: null,
};

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
      this.renameToolKey('BoxVidKlep', 'BoxKlep');
    } catch (e) {
      document.body.append(h('div', { class: 'loading-pane' }, 'Could not reach the local server. Restart Box-DocSpitter.'));
      throw e;
    }
    configureFiles({ info: this.info, settings: this.settings });
    // several app windows can be open: the one-per-app things run in the main one (see shell.js)
    const win = await window.bdsShell?.winInfo?.().catch(() => null);
    this.mainWindow = win ? !!win.main : true;
    window.bdsShell?.onMainWindow?.(() => { this.mainWindow = true; this.syncTomcat(); });
    this.applyTheme(this.settings.theme, false);
    this.applyLook();
    this.loadUserFonts();
    this.setupAppLock(); // before anything is drawn: the lock screen covers it straight away
    this.presence = createPresence(this);
    this.sounds = createSounds(this);
    this.clips = createClips(this);
    this.music = createMusic(this);
    this.clock = createClock(this);
    this.calendar = createCalendar(this);

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
    if (this.mainWindow && !params.get('adopt')) await this.restorePinned();
    // BoxTunnel's lines can start with the app (main window only, so torn-off windows don't double them)
    if (this.mainWindow && this.settings.tunnel?.autostart) import('./core/tunnel.js').then((m) => m.tunnel(this).start()).catch((e) => console.warn('tunnel', e));
    if (params.get('adopt')) { history.replaceState(null, '', '/'); await this.adoptTabs(params.get('adopt')); }
    const opens = params.getAll('open');
    if (opens.length) {
      history.replaceState(null, '', '/');
      for (const p of opens) await this.openPath(p);
    }
  }

  // ======================================================================= app PIN lock
  // A lock screen over the whole app (Settings → Security). It hides the app; your files on disk aren't encrypted
  // by it — Secure notes are. The PIN is checked by the local server (slow hash, growing waits after wrong tries).

  async saveSettings(patch) {
    Object.assign(this.settings, patch);
    configureFiles({ settings: this.settings });
    try { await api.saveSettings(patch); } catch { /* offline */ }
  }

  // ======================================================================= menubar

  /** A span showing a tool's name that follows renames while it's on screen (tool headings). */
  toolLabel(key) { return h('span', { dataset: { toolname: key } }, this.toolName(key)); }

  /** Open BoxDiff with this file on the left and ask for the file to compare it with. */
  compareWith(path) { return this.newDocument('diff', { diff: [{ path }], pickRight: true }); }
}

// The rest of App lives in app/*.js, a part per file; their methods are App's.
for (const part of [LockPart, EasterEggsPart, RailPart, SidebarsPart, ThemesPart, MenusPart, TabsPart, DocumentsPart, HomePart, PanelsPart, ExplorerPart, DumpsPart, SettingsPart, SettingsSectionsPart, StartupPart, WindowPart]) {
  for (const key of Object.getOwnPropertyNames(part.prototype)) {
    if (key !== 'constructor') Object.defineProperty(App.prototype, key, Object.getOwnPropertyDescriptor(part.prototype, key));
  }
}

const app = new App();
window.bdsApp = app;
app.init().catch((e) => console.error(e));
export default app;
