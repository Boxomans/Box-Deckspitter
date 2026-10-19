// Box-Deckspitter app shell, the window: mouse and keys, drag and drop, the heartbeat, full screen, quitting, help.
// Methods of App (app.js mixes this class into it).

import { $, h, vendor } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { menusOpen, modal, modalOpen, toast, errorToast } from '../core/ui.js';

export class WindowPart {
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
      // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) in every editor: a text box being typed in keeps its own undo;
      // otherwise (a canvas, a toolbar button, the page) it's the editor's undo / redo
      if (ctrl && !e.altKey && (k === 'z' || k === 'y') && ed && !e.defaultPrevented) {
        const t = e.target;
        const typing = t?.isContentEditable || t?.tagName === 'TEXTAREA' || t?.tagName === 'SELECT'
          || (t?.tagName === 'INPUT' && !/^(checkbox|radio|range|color|button|submit|reset|file|image)$/.test(t.type));
        if (!typing) { stop(); if (k === 'y' || e.shiftKey) ed.redo?.(); else ed.undo?.(); return; }
      }
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
      else if (e.key === 'F11' && e.shiftKey) { stop(); this.toggleFocus(); }
      else if (e.key === 'F11') { stop(); this.toggleFullScreen(); }
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
    this.setFullScreen(on);
    this.active?.editor?.onShow?.();
  }

  /** The whole app window full screen (bars and all). */
  isFullScreen() {
    if (document.fullscreenElement) return true;
    if (this._shellFull != null) return this._shellFull;
    // an older desktop shell can't say: guess from the size (page zoom or display scaling can fool this)
    return !!window.bdsShell && Math.abs(innerWidth - screen.width) < 2 && Math.abs(innerHeight - screen.height) < 2;
  }
  setFullScreen(on) {
    if (window.bdsShell) window.bdsShell.setFullScreen(on).catch(() => {});
    else if (on) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this._fullWant = on;
    setTimeout(() => (window.bdsShell?.isFullScreen ? window.bdsShell.isFullScreen().then((v) => { this._shellFull = v; this.syncFullScreen(); }, () => {}) : this.syncFullScreen()), 400);
  }
  toggleFullScreen() {
    if (document.body.classList.contains('focus-mode')) { this.toggleFocus(); return; } // F11 leaves focus mode too
    // ask the window itself when it can, so the button always undoes what's really on screen
    if (window.bdsShell?.isFullScreen) window.bdsShell.isFullScreen().then((on) => { this._shellFull = on; this.setFullScreen(!on); }, () => this.setFullScreen(!this.isFullScreen()));
    else this.setFullScreen(!this.isFullScreen());
  }
  syncFullScreen() {
    const b = $('#btn-fullscreen');
    if (!b) return;
    const on = this.isFullScreen();
    b.classList.toggle('on', on);
    document.documentElement.classList.toggle('app-full', on); // no window buttons to leave room for
    b.title = `${on ? 'Leave full screen' : 'Full screen'} (F11) · drag or flick it to the right sidebar`;
    const want = on ? 'full-exit' : 'maximize';
    if (b.dataset.ic !== want) { b.dataset.ic = want; const old = b.querySelector('svg'); const ni = icon(want); if (old) old.replaceWith(ni); else b.prepend(ni); }
  }

  async quit() {
    this.quitting = true; // pinned tabs stay pinned for next time
    await this.saveGames().catch(() => {});
    if (!(await this.closeAll())) { this.quitting = false; return; }
    await api.quit().catch(() => {});
    document.body.innerHTML = '<div class="loading-pane">Box-Deckspitter has stopped. You can close this window.</div>';
    setTimeout(() => window.close(), 300);
  }

  showShortcuts() {
    const rows = [
      ['New document', 'Alt+N'], ['Open file', 'Ctrl+O'], ['Save', 'Ctrl+S'], ['Save as', 'Ctrl+Shift+S'], ['Close tab', 'Alt+W'],
      ['Next / previous tab', 'Ctrl+Alt+→ / ←'], ['Jump to tab 1–9', 'Alt+1…9'], ['Print', 'Ctrl+P'], ['Find', 'Ctrl+F'], ['Find & replace', 'Ctrl+H'],
      ['Zoom in / out / reset', 'Ctrl+= / - / 0'], ['Full screen', 'F11'], ['Focus mode (full screen, no bars)', 'Shift+F11'], ['Shortcuts', 'F1'], ['Lock the app (with a PIN set)', 'Ctrl+Alt+L'], this.info?.platform === 'linux' ? ['Screenshot to the media dump (anywhere on the desktop)', 'Super+Shift+Q'] : ['Screenshot to the media dump (anywhere in Windows)', 'Win+Shift+Q'],
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
      const [{ text }, marked, { sanitizeHtml }] = await Promise.all([api.get('/api/readme'), vendor.marked(), import('../editors/doc/html-tools.js')]);
      html = sanitizeHtml(marked.parse(text, { gfm: true }), { keepWhitespace: true });
    } catch (e) { w.close(); return errorToast(e, 'Couldn’t load the README'); }
    // the window wears the app's current theme
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    const d = w.document;
    d.open();
    d.write(`<!doctype html><html><head><meta charset="utf-8"><title>Box-Deckspitter — README</title><style>
      :root { color-scheme: ${['light', 'temple', 'lubyanka'].includes(document.documentElement.dataset.theme) ? 'light' : 'dark'}; }
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
        h('div', { class: 'row' }, h('img', { src: '/assets/icon.svg', style: { width: '44px' } }), h('div', {}, h('div', { class: 'brand-name', style: { fontSize: '15px' } }, 'BOX//DECKSPITTER'), h('div', { class: 'faint mono' }, 'v' + window.BDS?.version))),
        h('p', {}, 'A self-hosted document workstation. Everything runs on this PC at 127.0.0.1. Your files never leave it.'),
        h('p', { class: 'dim' }, 'Built with pdf.js, pdf-lib, Monaco, SheetJS, docx and JSZip, all served from your own disk.'),
        h('p', { class: 'dim mono', style: { fontSize: '11.5px' } }, `Backups of every save: Box-Deckspitter${BDS.sep}data${BDS.sep}backups`),
        h('p', { class: 'dim' }, 'Made by boxbind · Discord: @boxbind')),
    });
  }
}
