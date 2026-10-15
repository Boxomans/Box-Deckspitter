// Box-DocSpitter app shell, the menu bar.
// Methods of App (app.js mixes this class into it).

import { $, $$, h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { showMenu, closeMenus, toast, errorToast } from '../core/ui.js';
import { LANGUAGES, MODE_ICON, iconForName } from '../core/filetypes.js';
import { DISCORD_INVITE, THEMES } from './shared.js';

export class MenusPart {
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
      { label: 'Image (paint)', icon: 'brush', action: () => this.newDocument('paint') },
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
      { label: this.toolName('BoxKlep'), icon: 'magnet', action: () => this.newDocument('klep') },
      { label: `${this.toolName('BoxSpaces')} — open folder…`, icon: 'folder-open', action: () => this.openSpace() },
      { label: this.toolName('StoragePeek'), icon: 'layers', action: () => this.newDocument('storage') },
      { label: this.toolName('BoxMail'), icon: 'mail', action: () => this.newDocument('mail') },
      { label: 'Music player (as a tab)', icon: 'music', action: () => this.newDocument('music') },
      { label: `${this.toolName('BoxTape')} — playlist to MP3s`, icon: 'music', action: () => this.newDocument('tape') },
      { label: `${this.toolName('BoxScribe')} — image to text (OCR)`, icon: 'scan-text', action: () => this.newDocument('scribe') },
      { label: `${this.toolName('BoxDiff')} — compare two files`, icon: 'diff', action: () => this.newDocument('diff') },
      { label: `${this.toolName('BoxSwap')} — swap sets of files in a folder`, icon: 'swap', action: () => this.newDocument('swap') },
      { label: `${this.toolName('BoxTunnel')} — audio lines: any input to any output`, icon: 'tunnel', action: () => this.newDocument('tunnel') },
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
      { label: 'Full screen', icon: 'maximize', shortcut: 'F11', checked: this.isFullScreen(), action: () => this.toggleFullScreen() },
      { label: 'Focus mode', icon: 'focus', shortcut: 'Shift+F11', checked: document.body.classList.contains('focus-mode'), action: () => this.toggleFocus() },
      { sep: true },
      ...THEMES.map(([id, name, , ic]) => ({ label: `${name} theme`, icon: ic, checked: this.settings.theme === id, action: () => this.applyTheme(id) })),
      { label: 'Edit custom theme…', action: () => this.showPanel('settings') },
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
      { sep: true },
      { label: 'Join the Discord', icon: 'external', action: () => window.open(DISCORD_INVITE, '_blank', 'noopener') },
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
    const modes = [['doc', 'Document editor'], ['text', 'Text editor'], ['code', 'Code editor'], ['pdf', 'PDF editor'], ['form', 'Form filler'], ['sheet', 'Spreadsheet'], ['image', 'Image viewer'], ['paint', 'Paint (layers, GIF frames)'], ['video', 'Video trimmer'], ['hex', 'Binary (hex) viewer']];
    return modes.map(([m, label]) => ({ label, icon: MODE_ICON[m], checked: t.mode === m, action: () => this.reopenAs(t, m) }));
  }

  // ======================================================================= tabs
}
