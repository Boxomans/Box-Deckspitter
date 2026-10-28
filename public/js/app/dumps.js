// Box-Deckspitter app shell, the dump panels (images, media, docs, audio).
// Methods of App (app.js mixes this class into it).

import { $, h, clear, basename, extOf, formatBytes, timeAgo, fileManager } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import {
  contextMenu, promptDialog, toast, errorToast, hoverKeys, renameInline, rubberSelect, PATHS_MIME, draggedPaths,
} from '../core/ui.js';
import { iconForName } from '../core/filetypes.js';
import { pickOpen } from '../core/files.js';
import { watchFolders, redrawKeepingPlace } from '../core/watch.js';

export class DumpsPart {
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
    // files added, removed or renamed anywhere in the dump (by anything) show up by themselves
    watchFolders('dumppanel', [`dump:${kind}`], () => redrawKeepingPlace(this.sidepanel, () => this.renderDumpPanel(kind)), () => this.panel === panel);
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
      h('button', { class: 'icon-btn', 'data-tip': `Open this folder in ${fileManager()}`, onclick: () => api.dumpReveal(kind, null, sub || null) }, icon('external', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Hide panel', onclick: () => this.hidePanel() }, icon('x', 'sm'))),
    h('div', { class: 'explorer-path' },
      h('button', { class: 'icon-btn', 'data-tip': 'Up one folder (Mouse 4)', disabled: !sub, onclick: () => again(parts.slice(0, -1).join('/')) }, icon('arrow-up', 'sm')),
      crumbs),
    h('div', { class: 'dump-panel-hint faint' }, 'Right-click copies · Shift+right-click for more · Shift+drag to carry into a folder, a tool or another program · Ctrl+right-click sends to the open tool'),
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
    // the whole panel body, so a drag-to-pick can start in the empty space below the files too
    const picker = rubberSelect(body, {
      scroller: () => body,
      osDrag: true,
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
    if (!folders.length && !items.length) list.append(h('div', { class: 'empty-note' }, sub ? 'Empty folder. Drop files here, or Shift+drag them in.' : `Empty. Drop files here, or Shift+drag them in from Files. They live in Box-Deckspitter${BDS.sep}${folder}.`));
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
        { label: `Show in ${fileManager()}`, icon: 'external', action: () => api.dumpReveal(kind, f.name) },
        { sep: true },
        { label: 'Remove folder', icon: 'trash', shortcut: 'Del', action: () => remove([f]) },
      ]));
      dropInto(row, f.name);
      list.append(row);
    }
    for (const it of items) {
      const thumb = it.type === 'image' ? h('img', { class: 'fr-thumb', src: it.url, alt: '', loading: 'lazy', draggable: 'false' })
        : icon(it.type === 'video' ? 'video' : it.type === 'audio' ? 'music' : iconForName(it.base), 'sm');
      const row = h('button', { class: 'file-row dump-row', title: `${it.base}\n${formatBytes(it.size)} · added ${timeAgo(it.mtime)}\nDouble-click to open · Right-click: copy · Shift+right-click: more · Shift+drag to carry · Ctrl+right-click to send to the open tool` },
        h('span', { class: 'fr-icon' }, thumb),
        h('span', { class: 'fr-name' }, it.base),
        h('span', { class: 'fr-meta' }, formatBytes(it.size)));
      row._item = it;
      hoverKeys(row, { nameEl: row.querySelector('.fr-name'), value: () => it.base, selectBase: true, commit: (n) => rename(it, n),
        remove: () => remove(row.classList.contains('picked') && picker.picked().length > 1 ? picker.picked() : [it]) });
      row.addEventListener('dblclick', () => this.openPath(it.path));
      const copyFile = () => api.dumpClip(it.name, kind).then(() => toast(`Copied ${it.base}`, { type: 'ok', timeout: 1500 }), errorToast);
      // right-click copies the file, like the dump docked in the editors; Shift+right-click for everything else
      row.addEventListener('contextmenu', (e) => {
        if (e.shiftKey) return;
        e.preventDefault();
        row.classList.add('copied');
        setTimeout(() => row.classList.remove('copied'), 600);
        copyFile();
      });
      row.addEventListener('contextmenu', (e) => e.shiftKey && contextMenu(e, [
        { label: 'Open', icon: 'file', action: () => this.openPath(it.path) },
        { label: 'Send to the open tool', icon: 'send', shortcut: 'Ctrl+right-click', action: () => this.sendToActive([it.path]) },
        ...this.videoEditorMenu([it.path]),
        { sep: true },
        { label: 'Copy as file', icon: 'copy', shortcut: 'Right-click', action: copyFile },
        { label: 'Copy path', icon: 'link', action: () => navigator.clipboard.writeText(it.path) },
        { label: 'Rename…', icon: 'edit', shortcut: 'F2', action: () => { if (!renameInline(row)) promptDialog('Rename', 'New name', it.base, { selectBase: true }).then((n) => n && rename(it, n).catch(errorToast)); } },
        { label: `Show in ${fileManager()}`, icon: 'external', action: () => api.dumpReveal(kind, it.name) },
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
}
