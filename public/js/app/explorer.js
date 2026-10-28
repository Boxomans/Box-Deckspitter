// Box-Deckspitter app shell, the file explorer panel and what you can do to files in it.
// Methods of App (app.js mixes this class into it).

import { $, $$, h, clear, basename, dirname, extOf, formatBytes, formatDate, joinPath, fileManager } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { contextMenu, confirmDialog, promptDialog, toast, errorToast, hoverKeys, rubberSelect } from '../core/ui.js';
import { MODE_ICON, MODE_LABEL, iconForName, detectMode, PAINT_EXT } from '../core/filetypes.js';
import { TOOL_OF_MODE } from '../core/tools.js';
import { watchFolders, redrawKeepingPlace } from '../core/watch.js';

// files the video editor can use
const MEDIA_FILE_RE = /\.(mp4|m4v|webm|mov|mkv|ogv|avi|wmv|3gp|mts|m2ts|flv|mp3|wav|m4a|aac|ogg|oga|opus|flac|weba|png|jpe?g|jfif|webp|gif|bmp|svg)$/i;

export class ExplorerPart {
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
    // files added, removed or renamed in this folder (by anything) show up by themselves
    watchFolders('explorer', [ex.dir], () => redrawKeepingPlace(this.sidepanel, () => this.renderExplorer(null, { history: false })), () => this.panel === 'explorer');
    p.append(
      h('div', { class: 'panel-head' }, 'Files', h('div', { class: 'grow' }),
        h('button', { class: 'icon-btn', 'data-tip': 'New folder', onclick: () => this.explorerNewFolder() }, icon('folder-plus', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Refresh', onclick: () => this.renderExplorer(ex.dir) }, icon('refresh', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Hide panel', onclick: () => this.hidePanel() }, icon('x', 'sm'))),
      quick,
      h('div', { class: 'explorer-path' },
        h('button', { class: 'icon-btn', 'data-tip': 'Up one folder', disabled: !ex.parent, onclick: () => ex.parent && this.renderExplorer(ex.parent) }, icon('arrow-up', 'sm')),
        h('span', { class: 'crumbs', title: ex.dir }, ex.dir),
        h('button', { class: 'icon-btn', 'data-tip': `Open in ${fileManager(true)}`, onclick: () => api.reveal(ex.dir) }, icon('external', 'sm'))),
      h('div', { class: 'explorer-filter' }, filter),
      h('div', { class: 'panel-body' }, list));
    renderList();
  }

  explorerItemMenu(e) {
    if (e.isDir) {
      return [
        { label: 'Open folder', icon: 'folder-open', action: () => this.renderExplorer(e.path) },
        { label: `Open in ${this.toolName('BoxTerminal')}`, icon: 'terminal', action: () => this.newDocument('terminal', { another: true, cwd: e.path }) },
        { label: `Show in ${fileManager(true)}`, icon: 'external', action: () => api.reveal(e.path) },
        { label: 'Copy path', icon: 'copy', action: () => navigator.clipboard.writeText(e.path) },
        { label: 'Rename…', shortcut: 'F2', action: () => this.explorerRename(e) },
      ];
    }
    return [
      { label: 'Open', icon: 'file', action: () => this.openPath(e.path) },
      { label: 'Open with', icon: 'layers', submenu: [['doc', 'Document editor'], ['text', 'Text editor'], ['code', 'Code editor'], ['pdf', 'PDF editor'], ['form', 'Form filler'], ['sheet', 'Spreadsheet'], ['image', 'Image viewer'], ['paint', 'Image editor (BoxPaint)'], ['player', 'Video player'], ['video', 'Video trimmer'], ['hex', 'Hex viewer']].map(([m, l]) => ({ label: l, icon: MODE_ICON[m], action: () => this.openPath(e.path, { mode: m }) })) },
      ...this.videoEditorMenu([e.path]),
      ...this.backgroundMenu([e.path]),
      { sep: true },
      { label: `Show in ${fileManager(true)}`, icon: 'external', action: () => api.reveal(e.path) },
      { label: 'Copy path', icon: 'copy', action: () => navigator.clipboard.writeText(e.path) },
      { label: 'Compare with…', icon: 'diff', action: () => this.compareWith(e.path) },
      { label: 'Rename…', shortcut: 'F2', action: () => this.explorerRename(e) },
      { label: 'Delete (Recycle Bin)', icon: 'trash', shortcut: 'Del', action: () => this.explorerTrash(e) },
    ];
  }

  /**
   * For menus of files with a video, sound or picture among them: "Add to the video editor", and for one video
   * or sound, the trimmer or player too (whichever "Open" doesn't already go to); for one picture, the image
   * editor (BoxPaint) or the image viewer, the same way.
   */
  videoEditorMenu(paths) {
    const media = paths.filter((p) => MEDIA_FILE_RE.test(p));
    if (!media.length) return [];
    const label = `Add ${media.length > 1 ? `${media.length} files ` : ''}to the ${this.toolName('Video editor').toLowerCase() === 'video editor' ? 'video editor' : this.toolName('Video editor')}`;
    const one = paths.length === 1 && detectMode(paths[0]).mode === 'video' ? paths[0] : null;
    const trimFirst = this.settings.videoOpen === 'trim';
    const pic = paths.length === 1 && PAINT_EXT.includes(extOf(paths[0])) ? paths[0] : null;
    const snd = paths.length === 1 && /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba|wma|aiff?)$/i.test(paths[0]) ? paths[0] : null;
    const paintFirst = pic && (detectMode(pic).mode === 'paint' || this.settings.imageOpen === 'paint');
    return [
      ...(pic && !paintFirst ? [{ label: 'Open in the image editor', icon: 'brush', action: () => this.openPath(pic, { mode: 'paint' }) }] : []),
      ...(pic && paintFirst ? [{ label: 'Open in the image viewer', icon: 'image', action: () => this.openPath(pic, { mode: 'image' }) }] : []),
      ...(one && !trimFirst ? [{ label: 'Open in the video trimmer', icon: 'crop', action: () => this.openPath(one, { mode: 'video' }) }] : []),
      ...(one && trimFirst ? [{ label: 'Play in the video player', icon: 'play', action: () => this.openPath(one, { mode: 'player' }) }] : []),
      ...(snd ? [{ label: `Open in ${this.toolName('BoxWave')}`, icon: 'wave', action: () => this.openInWave(snd) }] : []),
      { label, icon: 'video', action: () => this.sendToVideoEditor(media) },
    ];
  }

  /** A sound into a new BoxWave tab. */
  async openInWave(path) {
    const tab = await this.newDocument('wave', { another: true });
    await tab?.editor?.openFile?.(path);
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
}
