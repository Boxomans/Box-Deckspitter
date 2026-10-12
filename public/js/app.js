// Box-DocSpitter — application shell: tabs, menus, home, explorer, open/save plumbing.

import { $, $$, h, clear, uid, basename, dirname, extOf, stripExt, formatBytes, timeAgo, formatDate, toBytes, debounce, joinPath } from './core/dom.js';
import { icon } from './core/icons.js';
import { api } from './core/api.js';
import {
  showMenu, closeMenus, menusOpen, contextMenu, modal, modalOpen, alertDialog, confirmDialog, promptDialog,
  choiceDialog, toast, errorToast, hoverKeys,
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
  form: () => import('./editors/form.js').then((m) => m.FormEditor),
  klep: () => import('./editors/klep.js').then((m) => m.KlepEditor),
  storage: () => import('./editors/storage.js').then((m) => m.StorageEditor),
  mail: () => import('./editors/mail.js').then((m) => m.MailEditor),
  tape: () => import('./editors/tape.js').then((m) => m.TapeEditor),
  scribe: () => import('./editors/scribe.js').then((m) => m.ScribeEditor),
  diff: () => import('./editors/diff.js').then((m) => m.DiffEditor),
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
      z.classList.remove('fling-target', 'fling-hot');
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
const HOME_TITLE = 'BOX//DOCSPITTER';
const HOME_TAGLINE = 'local docs, pdfs, video, text & code — (almost) nothing leaves this machine';

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
    if (this.settings.rightPanel && !(this.settings.rightPanel === 'music' && this.rightPanel === 'music')) this.toggleRightPanel(this.settings.rightPanel);
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

  decorateChrome() {
    $('#btn-home').append(icon('home'));
    $('#btn-home').addEventListener('click', () => this.activate(null));
    $('#btn-new-tab').append(icon('plus'));
    $('#btn-new-tab').addEventListener('click', (e) => showMenu(this.newMenuItems(), { anchor: e.currentTarget }));
    // the top-bar button cycles Dark → Light → PB&J
    $('#btn-theme').addEventListener('click', () => this.applyTheme(THEME_NEXT[this.settings.theme] || 'dark'));
    $('#btn-sound').addEventListener('click', () => { this.sounds.toggle(); this.syncSoundButton(); });
    this.syncSoundButton();
    this.wireSoundVolume();
    $('#btn-music').append(icon('music'));
    $('#btn-music').title = 'Music player (audio-dump) · drag or flick it to the right sidebar to dock it there';
    $('#btn-music').addEventListener('click', () => this.music.toggleOpen());
    this.wireMusicDock();
    $('#btn-shortcuts').append(icon('keyboard'));
    $('#btn-shortcuts').addEventListener('click', () => this.showShortcuts());
    const railIcons = { explorer: 'folder', spaces: 'spaces', recent: 'clock', settings: 'settings' };
    for (const b of $$('.rail-btn')) {
      b.append(icon(railIcons[b.dataset.panel], 'lg'));
      b.addEventListener('click', () => this.togglePanel(b.dataset.panel));
    }
    for (const b of $$('.rrail-tab')) b.addEventListener('click', () => this.toggleRightPanel(b.dataset.rpanel));
    // remember the last place the user was typing, so side panels can insert there
    document.addEventListener('focusin', (e) => {
      const t = e.target;
      if (!this.workspace.contains(t)) return;
      if (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && /^(text|search|url|email|)$/.test(t.type))) this.lastEditable = t;
    });
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
      $('#rightrail').append(tab);
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
  }

  wireMusicDock() {
    const topZone = () => $('.titlebar-actions');
    const sideZone = () => $('#rightrail');
    flingable($('#btn-music'), sideZone, () => this.setMusicDock(true));
    flingable(this.musicRailTab(), topZone, () => this.setMusicDock(false));
  }

  toggleRightPanel(name, { force = false } = {}) {
    const host = $('#rightpanel');
    if (name === 'music' && !this.music?.docked && this.settings.musicDock !== 'side') name = null;
    const next = name && (force || this.rightPanel !== name) ? name : null;
    this.rightPanel = next;
    host.hidden = !next;
    host.dataset.panel = next || '';
    $$('.rrail-tab').forEach((b) => b.classList.toggle('active', b.dataset.rpanel === next));
    this.saveSettings({ rightPanel: next });
    this.rightPanels = this.rightPanels || {};
    for (const [k, p] of Object.entries(this.rightPanels)) p.el.hidden = k !== next;
    if (next && !this.rightPanels[next]) {
      const el = h('div', { class: 'rp-container' });
      host.append(el);
      this.rightPanels[next] = { el, panel: null };
      const load = next === 'music'
        ? Promise.resolve(this.music.dockInto(el))
        : next === 'chars'
        ? import('./core/chars-panel.js').then(({ CharsPanel }) => new CharsPanel(this, el))
        : next === 'clip'
          ? import('./core/clips-panel.js').then(({ ClipsPanel }) => new ClipsPanel(this, el))
          : import('./core/ai-panel.js').then(({ AiPanel }) => new AiPanel(this, el));
      load.then((panel) => { this.rightPanels[next].panel = panel; });
    } else if (next === 'ai') this.rightPanels.ai.panel?.render();
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
      pop.style.top = Math.round(r.bottom + 6) + 'px';
      pop.style.left = Math.round(r.left + r.width / 2 - pop.offsetWidth / 2) + 'px';
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
    b.title = `Theme: ${THEME_NAME[theme] || theme} — click for ${THEME_NAME[THEME_NEXT[theme] || 'dark']}`;
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
      { label: 'Fill a form…', icon: 'form-fill', action: () => this.fillForm() },
      { label: 'Video trimmer…', icon: 'video', action: () => this.openVideoTrimmer() },
      { label: 'BoxVidKlep', icon: 'magnet', action: () => this.newDocument('klep') },
      { label: 'BoxSpaces — open folder…', icon: 'folder-open', action: () => this.openSpace() },
      { label: 'StoragePeek', icon: 'layers', action: () => this.newDocument('storage') },
      { label: 'BoxMail', icon: 'mail', action: () => this.newDocument('mail') },
      { label: 'BoxTape — playlist to MP3s', icon: 'music', action: () => this.newDocument('tape') },
      { label: 'BoxScribe — image to text (OCR)', icon: 'scan-text', action: () => this.newDocument('scribe') },
      { label: 'BoxDiff — compare two files', icon: 'diff', action: () => this.newDocument('diff') },
      { label: 'Music player', icon: 'music', action: () => this.music.open() },
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
      { label: 'Special characters', icon: 'omega', checked: this.rightPanel === 'chars', action: () => this.toggleRightPanel('chars') },
      { label: 'Clipboard & snippets', icon: 'copy', checked: this.rightPanel === 'clip', action: () => this.toggleRightPanel('clip') },
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
    const tool = ['klep', 'storage', 'mail', 'tape', 'scribe', 'diff'].includes(t?.mode) && !t.path;
    if (t) el.append(...[h('b', {}, t.title), t.path ? h('span', {}, '  ·  ' + dirname(t.path)) : tool ? null : h('span', {}, '  ·  not saved yet')].filter(Boolean));
  }

  updateStatus(tab = this.active) {
    if (tab && tab !== this.active) return;
    const L = clear(this.statusLeft);
    const R = clear(this.statusRight);
    if (!tab) {
      L.append(h('span', { class: 'sb-item mode' }, 'home'), h('span', { class: 'sb-item' }, `${this.tabs.length} open`));
      R.append(h('span', { class: 'sb-item' }, h('span', { class: 'sb-dot' }), 'local · 127.0.0.1'), h('span', { class: 'sb-item' }, 'v' + (window.BDS?.version || '')));
      return;
    }
    const modeBtn = h('button', { class: 'sb-item mode', title: 'Reopen in a different editor' }, (MODE_LABEL[tab.mode] || 'Loading').toLowerCase());
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
      klep: { mode: 'klep', ext: '', base: 'BoxVidKlep' },
      storage: { mode: 'storage', ext: '', base: 'StoragePeek' },
      mail: { mode: 'mail', ext: '', base: 'BoxMail' },
      tape: { mode: 'tape', ext: '', base: 'BoxTape' },
      scribe: { mode: 'scribe', ext: '', base: 'BoxScribe' },
      diff: { mode: 'diff', ext: '', base: 'BoxDiff' },
      paint: { mode: 'paint', ext: 'png', base: 'Untitled image' },
    }[kind];
    if (!spec) return;
    let images = opts.images || null;
    if (kind === 'pdf-images' && !images) {
      images = await pickOpen({ multi: true, title: 'Choose images', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
      if (!images) return;
    }
    if ((kind === 'klep' || kind === 'storage' || kind === 'mail' || kind === 'tape' || kind === 'scribe') && !opts.another) {
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
      await this.mountEditor(tab, bytes, { lang: spec.lang, isNew: true, images, diff: opts.diff, pickRight: opts.pickRight });
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

  /** F2 on the home logo: pick a picture (file, image dump or paste) — shrunk to 256 px and kept in settings. */
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
      if (!items.length) grid.append(h('div', { class: 'faint' }, 'The image dump is empty.'));
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
        h('div', { class: 'home-section-title' }, 'from the image dump'),
        grid),
      buttons: [{ label: 'Close', value: null, ghost: true }],
      onOpen: (c) => { ctx = c; },
    });
    document.removeEventListener('paste', onPaste);
  }

  /** A home screen card. Hover + F2 renames it (saved in settings); Ctrl+F2 puts the original name back. */
  homeCard(ic, title, sub) {
    const names = this.settings.cardNames || {};
    const nameEl = h('span', { class: 'nc-title' }, names[title] || title);
    const subs = this.settings.cardSubs || {};
    const subEl = h('span', { class: 'nc-sub' }, subs[title] || sub);
    const card = h('button', { class: 'new-card', title: 'F2 to rename · Ctrl+F2 to reset (hover the small line to change that instead)' }, h('span', { class: 'nc-icon' }, icon(ic, 'lg')), nameEl, subEl);
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
        const next = { ...(this.settings.cardNames || {}) };
        if (!n.trim() || n.trim() === title) delete next[title]; else next[title] = n.trim();
        this.saveSettings({ cardNames: next });
        nameEl.textContent = next[title] || title;
      },
      reset: () => { const next = { ...(this.settings.cardNames || {}) }; delete next[title]; this.saveSettings({ cardNames: next }); nameEl.textContent = title; },
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
    for (const [kind, ic, title, sub] of cards) {
      const card = this.homeCard(ic, title, sub);
      card.addEventListener('click', (e) => {
        if (kind === 'code') showMenu(LANGUAGES.map(([id, name]) => ({ label: name, action: () => this.newDocument('code', { lang: id }) })), { x: e.clientX, y: e.clientY });
        else this.newDocument(kind);
      });
      grid.append(card);
    }
    inner.append(grid);
    inner.append(h('div', { class: 'home-section-title' }, 'tools'));
    const toolGrid = h('div', { class: 'new-cards tool-cards' });
    for (const [ic, title, sub, fn] of [
      ['form-fill', 'Fill a form', 'gov pdfs · autofill · sign', () => this.fillForm()],
      ['video', 'Video trimmer', 'cut · gif · mp3 · frames', () => this.openVideoTrimmer()],
      ['magnet', 'BoxVidKlep', 'grab videos from a link', () => this.newDocument('klep')],
      ['spaces', 'BoxSpaces', 'open a folder, IDE-style', () => this.openSpace()],
      ['layers', 'StoragePeek', 'what’s eating your drives', () => this.newDocument('storage')],
      ['mail', 'BoxMail', 'gmail + the dumps + claude', () => this.newDocument('mail')],
      ['music', 'BoxTape', 'youtube playlist → mp3s', () => this.newDocument('tape')],
      ['scan-text', 'BoxScribe', 'image → text · offline ocr', () => this.newDocument('scribe')],
      ['diff', 'BoxDiff', 'compare two files side by side', () => this.newDocument('diff')],
    ]) {
      const card = this.homeCard(ic, title, sub);
      card.addEventListener('click', fn);
      toolGrid.append(card);
    }
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
        recentHost.append(h('div', { class: 'home-section-title' }, 'recent'));
        const list = h('div', { class: 'recent-list' });
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
        if (!e.denied) hoverKeys(row, { nameEl: row.querySelector('.fr-name'), value: () => e.name, selectBase: !e.isDir, commit: (n) => this.explorerRename(e, n), remove: () => this.explorerTrash(e) });
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
      { sep: true },
      { label: 'Show in Windows Explorer', icon: 'external', action: () => api.reveal(e.path) },
      { label: 'Copy path', icon: 'copy', action: () => navigator.clipboard.writeText(e.path) },
      { label: 'Compare with…', icon: 'diff', action: () => this.compareWith(e.path) },
      { label: 'Rename…', shortcut: 'F2', action: () => this.explorerRename(e) },
      { label: 'Delete (Recycle Bin)', icon: 'trash', shortcut: 'Del', action: () => this.explorerTrash(e) },
    ];
  }

  /** Open BoxDiff with this file on the left and ask for the file to compare it with. */
  compareWith(path) { return this.newDocument('diff', { diff: [{ path }], pickRight: true }); }

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

  async renderRecentPanel() {
    const p = clear(this.sidepanel);
    const list = h('div', { class: 'file-list' });
    p.append(h('div', { class: 'panel-head' }, 'Recent', h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', 'data-tip': 'Clear list', onclick: async () => { await api.removeRecent(null); this.renderRecentPanel(); } }, icon('trash', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Hide panel', onclick: () => this.hidePanel() }, icon('x', 'sm'))),
    h('div', { class: 'panel-body' }, list));
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
        this.updateSettings(),
        this.windowsSettings(),
        this.mailSettings(),
        this.discordSettings(),
        this.aiSettings(),
        h('div', { class: 'settings-group' }, h('h4', {}, 'About'),
          h('span', { class: 'dim mono', style: { fontSize: '11px' } }, `v${window.BDS?.version} · data folder: Box-DocSpitter\\data`)),
        h('div', { class: 'settings-group danger-zone' }, h('h4', {}, 'Reset'),
          h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Erase everything Box-DocSpitter has stored and start fresh, like a new copy.'),
          h('button', { class: 'btn sm danger', onclick: () => this.factoryReset() }, icon('trash', 'sm'), 'Reset to clean state…')))));
  }

  async factoryReset() {
    const DUMP_KINDS = [['image', 'image dump', 'image'], ['doc', 'doc dump', 'document'], ['audio', 'audio dump', 'song']];
    const counts = {};
    await Promise.all(DUMP_KINDS.map(async ([k]) => { try { counts[k] = (await api.dump(k)).items.length; } catch { counts[k] = 0; } }));
    const dumpBoxes = DUMP_KINDS.map(([k, label, noun]) => {
      const cb = h('input', { type: 'checkbox', checked: counts[k] > 0 });
      cb.disabled = !counts[k];
      return { k, cb, row: h('label', { class: 'check' }, cb, counts[k] ? `Also delete the ${counts[k]} ${noun}${counts[k] === 1 ? '' : 's'} in the ${label}` : `The ${label} is empty`) };
    });
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
        h('p', { class: 'faint' }, 'Your own documents and files saved anywhere else are not touched. Box-DocSpitter restarts when it’s done.')),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Erase everything', value: 'ok', danger: true }],
    });
    if (ok !== 'ok') return;
    if (!(await this.closeAll())) return toast('Reset cancelled — a document is still open.', { type: 'warn' });
    let res;
    try {
      res = await fetch('/api/reset', { method: 'POST', headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ dumps: dumpBoxes.filter((b) => b.cb.checked).map((b) => b.k) }) }).then((r) => r.json());
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
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Updates'), line, note, out, actions, tokenRow);
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
        h('button', { class: 'btn sm ghost', onclick: () => this.toggleRightPanel(this.rightPanel === 'ai' ? null : 'ai') }, 'Open panel')),
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
      ['Zoom in / out / reset', 'Ctrl+= / - / 0'], ['Focus mode', 'F11'], ['Shortcuts', 'F1'],
    ];
    const hoverRows = [
      ['Rename what’s under the mouse', 'F2'], ['Put the original name back', 'Ctrl+F2'], ['Remove what’s under the mouse', 'Del'],
      ['Change the home logo (hover it)', 'F2'], ['Pick from a menu', 'Hold, drag, release'],
    ];
    const mouseRows = [
      ['Back / forward between tabs', 'Mouse 4 / Mouse 5'], ['Back / forward between folders (over the file panel)', 'Mouse 4 / Mouse 5'],
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
