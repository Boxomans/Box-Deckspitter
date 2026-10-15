// BoxSpaces — open a folder as a workspace: file tree, git status, search across files, quick open.

import { h, clear, basename, dirname, joinPath, extOf, debounce, formatBytes } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { contextMenu, promptDialog, confirmDialog, toast, errorToast, hoverKeys, rubberSelect, modal } from './ui.js';
import { iconForName, MODE_ICON } from './filetypes.js';

const GIT_CLASS = { M: 'mod', ' M': 'mod', MM: 'mod', AM: 'add', A: 'add', '??': 'new', D: 'del', R: 'mod', U: 'conflict', UU: 'conflict' };

export class Spaces {
  constructor(app) {
    this.app = app;
    this.root = app.settings.space || null;
    this.expanded = new Set(app.settings.spaceExpanded || []);
    this.cache = new Map();
    this.view = 'tree';
    this.git = { branch: null, files: {} };
    this.selected = null;
  }

  async open(root) {
    this.root = root;
    this.cache.clear();
    this.expanded = new Set([root]);
    const recent = [root, ...(this.app.settings.spaces || []).filter((r) => r.toLowerCase() !== root.toLowerCase())].slice(0, 10);
    this.app.saveSettings({ space: root, spaces: recent, spaceExpanded: [root] });
    this.view = 'tree';
    this.files = null;
    await this.refreshGit();
  }

  close() {
    this.root = null;
    this.app.saveSettings({ space: null });
    this.render(this.host);
  }

  async refreshGit() {
    if (!this.root) return;
    try { this.git = await api.git(this.root); } catch { this.git = { branch: null, files: {} }; }
  }

  async list(dir) {
    if (!this.cache.has(dir)) {
      try { this.cache.set(dir, (await api.list(dir)).entries); } catch (e) { this.cache.set(dir, []); errorToast(e); }
    }
    return this.cache.get(dir);
  }

  saveExpanded() { this.app.saveSettings({ spaceExpanded: [...this.expanded].slice(0, 300) }); }

  // ------------------------------------------------------------------ render

  async render(host) {
    this.host = host;
    clear(host);
    if (!this.root) return this.renderEmpty(host);
    const name = basename(this.root);
    const head = h('div', { class: 'panel-head' }, h('span', { class: 'spaces-name', title: this.root }, this.app.toolName('BoxSpaces') + ' · ' + name), h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', 'data-tip': 'New BoxSpace — make a new folder and open it', onclick: () => this.createSpace() }, icon('plus', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'New file', onclick: () => this.newFile(this.root) }, icon('file-plus', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'New folder', onclick: () => this.newFolder(this.root) }, icon('folder-plus', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Refresh', onclick: () => this.refresh() }, icon('refresh', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Collapse all', onclick: () => { this.expanded = new Set([this.root]); this.saveExpanded(); this.render(host); } }, icon('chevron-up', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Close space', onclick: () => this.close() }, icon('x', 'sm')));
    const tabs = h('div', { class: 'spaces-tabs' },
      h('button', { class: this.view === 'tree' ? 'on' : '', onclick: () => { this.view = 'tree'; this.render(host); } }, icon('folder', 'sm'), 'Files'),
      h('button', { class: this.view === 'search' ? 'on' : '', onclick: () => { this.view = 'search'; this.render(host); } }, icon('search', 'sm'), 'Search'),
      this.git.branch ? h('span', { class: 'spaces-branch mono', title: 'git branch' }, icon('git', 'sm'), this.git.branch) : null);
    host.append(head, tabs);
    if (this.view === 'search') return this.renderSearch(host);
    const tree = h('div', { class: 'spaces-tree', tabindex: '0' });
    const body = h('div', { class: 'panel-body' }, tree);
    host.append(body);
    this.picker = rubberSelect(tree, {
      rows: '.tree-row', scroller: body,
      menu: (items) => this.app.fileManyMenu(items, () => this.refresh()),
      onDelete: (items) => this.app.trashMany(items, () => this.refresh()),
      onOpen: (items) => this.app.openMany(items),
    });
    await this.renderDir(this.root, tree, 0);
    tree.addEventListener('contextmenu', (e) => { if (e.target === tree) contextMenu(e, this.dirMenu(this.root)); });
  }

  renderEmpty(host) {
    const recent = (this.app.settings.spaces || []);
    host.append(
      h('div', { class: 'panel-head' }, this.app.toolName('BoxSpaces'), h('div', { class: 'grow' }),
        h('button', { class: 'icon-btn', 'data-tip': 'New BoxSpace — make a new folder and open it', onclick: () => this.createSpace() }, icon('plus', 'sm'))),
      h('div', { class: 'panel-body' }, h('div', { class: 'spaces-empty' },
        icon('spaces', 'xl'),
        h('div', {}, 'Open a folder to work on it like a project — file tree, git status, search across files, quick open with Ctrl+E.'),
        h('div', { class: 'spaces-empty-btns' },
          h('button', { class: 'btn primary', onclick: () => this.app.openSpace() }, icon('folder-open', 'sm'), 'Open folder…'),
          h('button', { class: 'btn', onclick: () => this.createSpace() }, icon('folder-plus', 'sm'), 'New folder…')),
        recent.length ? h('div', { class: 'menu-heading' }, 'recent spaces') : null,
        ...recent.map((r) => {
          const row = h('button', { class: 'file-row', title: r, onclick: async () => { await this.open(r); this.render(host); } }, h('span', { class: 'fr-icon' }, icon('folder', 'sm')), h('span', { class: 'fr-name' }, basename(r)), h('span', { class: 'fr-meta' }, dirname(r).slice(-24)),
            h('span', { class: 'fr-x', role: 'button', 'data-tip': 'Remove from recent (the folder itself stays)', onclick: (e) => { e.stopPropagation(); this.forgetRecent(r, host); } }, icon('x', 'sm')));
          row.addEventListener('contextmenu', (e) => contextMenu(e, [
            { label: 'Open', icon: 'folder-open', action: async () => { await this.open(r); this.render(host); } },
            { label: 'Show in Explorer', icon: 'external', action: () => api.reveal(r) },
            { label: 'Copy path', icon: 'copy', action: () => { navigator.clipboard.writeText(r); toast('Copied', { timeout: 1200 }); } },
            { sep: true },
            { label: 'Remove from recent', icon: 'x', action: () => this.forgetRecent(r, host) },
            { label: 'Clear all recent spaces', icon: 'trash', action: () => this.forgetRecent(null, host) },
          ]));
          return row;
        }))));
  }

  forgetRecent(r, host) {
    const recent = r ? (this.app.settings.spaces || []).filter((x) => x.toLowerCase() !== r.toLowerCase()) : [];
    this.app.saveSettings({ spaces: recent });
    clear(host);
    this.renderEmpty(host);
  }

  gitClass(p) {
    const code = this.git.files?.[p.toLowerCase()];
    if (code) return GIT_CLASS[code] || GIT_CLASS[code.trim()] || 'mod';
    // folders containing changes
    const low = p.toLowerCase() + '\\';
    for (const k of Object.keys(this.git.files || {})) if (k.startsWith(low)) return 'dirty';
    return '';
  }

  async renderDir(dir, container, depth) {
    const entries = (await this.list(dir)).filter((e) => this.app.settings.showHidden || !e.hidden);
    for (const e of entries) {
      const open = e.isDir && this.expanded.has(e.path);
      const g = this.gitClass(e.path);
      const isActive = this.app.active?.path && this.app.active.path.toLowerCase() === e.path.toLowerCase();
      const nameEl = h('span', { class: 'fr-name' }, e.name);
      const row = h('button', {
        class: `tree-row ${e.isDir ? 'dir' : ''} ${g ? 'git-' + g : ''} ${isActive ? 'active' : ''} ${e.dot ? 'dot' : ''}`,
        style: { paddingLeft: 8 + depth * 14 + 'px' }, title: e.path,
      },
      h('span', { class: 'tree-chev' }, e.isDir ? icon(open ? 'chevron-down' : 'chevron-right', 'sm') : null),
      h('span', { class: 'fr-icon' }, icon(e.isDir ? (open ? 'folder-open' : 'folder') : iconForName(e.name), 'sm')),
      nameEl,
      g && g !== 'dirty' ? h('span', { class: 'tree-git' }, { mod: 'M', add: 'A', new: 'U', del: 'D', conflict: '!' }[g] || '') : null);
      row.addEventListener('click', async () => {
        if (e.isDir) {
          if (open) this.expanded.delete(e.path); else this.expanded.add(e.path);
          this.saveExpanded();
          this.render(this.host);
        } else this.app.openPath(e.path);
      });
      row.addEventListener('contextmenu', (ev) => contextMenu(ev, e.isDir ? this.dirMenu(e.path) : this.fileMenu(e)));
      hoverKeys(row, { nameEl, value: () => e.name, selectBase: !e.isDir, commit: (n) => this.rename(e.path, n), remove: () => (row.classList.contains('picked') && this.picker?.picked().length > 1 ? this.app.trashMany(this.picker.picked(), () => this.refresh()) : this.trash(e.path)) });
      row._item = e;
      container.append(row);
      if (open) await this.renderDir(e.path, container, depth + 1);
    }
    if (!entries.length && depth > 0) container.append(h('div', { class: 'tree-empty', style: { paddingLeft: 30 + depth * 14 + 'px' } }, 'empty'));
  }

  fileMenu(e) {
    return [
      { label: 'Open', icon: 'file', action: () => this.app.openPath(e.path) },
      { label: 'Open with', icon: 'layers', submenu: [['doc', 'Document'], ['text', 'Text'], ['code', 'Code'], ['pdf', 'PDF'], ['sheet', 'Spreadsheet'], ['image', 'Image'], ['video', 'Video'], ['hex', 'Hex']].map(([m, l]) => ({ label: l, icon: MODE_ICON[m], action: () => this.app.openPath(e.path, { mode: m }) })) },
      ...this.app.videoEditorMenu([e.path]),
      ...this.app.backgroundMenu([e.path]),
      { sep: true },
      { label: 'Compare with…', icon: 'diff', action: () => this.app.compareWith(e.path) },
      { label: 'Rename…', shortcut: 'F2', action: () => this.rename(e.path) },
      { label: 'Duplicate', icon: 'copy', action: () => this.duplicate(e.path) },
      { label: 'Delete (Recycle Bin)', icon: 'trash', shortcut: 'Del', action: () => this.trash(e.path) },
      { sep: true },
      { label: 'Copy path', action: () => navigator.clipboard.writeText(e.path) },
      { label: 'Copy relative path', action: () => navigator.clipboard.writeText(e.path.slice(this.root.length + 1)) },
      { label: 'Show in Explorer', icon: 'external', action: () => api.reveal(e.path) },
    ];
  }

  dirMenu(dir) {
    return [
      { label: 'New file…', icon: 'file-plus', action: () => this.newFile(dir) },
      { label: 'New folder…', icon: 'folder-plus', action: () => this.newFolder(dir) },
      { label: 'Search in folder', icon: 'search', action: () => { this.view = 'search'; this.searchScope = dir; this.render(this.host); } },
      { sep: true },
      ...(dir !== this.root ? [{ label: 'Rename…', action: () => this.rename(dir) }, { label: 'Delete (Recycle Bin)', icon: 'trash', action: () => this.trash(dir) }, { sep: true }] : []),
      { label: 'Copy path', action: () => navigator.clipboard.writeText(dir) },
      { label: 'Show in Explorer', icon: 'external', action: () => api.reveal(dir) },
    ];
  }

  async refresh() {
    this.cache.clear();
    this.files = null;
    await this.refreshGit();
    this.render(this.host);
  }

  async newFile(dir) {
    const name = await promptDialog('New file', `In ${basename(dir)}`, '', { placeholder: 'name.ext' });
    if (!name) return;
    const p = joinPath(dir, name);
    try {
      const st = await api.stat(p);
      if (st.exists) return toast('A file with that name already exists.', { type: 'warn' });
      await api.write(p, new Uint8Array());
      this.expanded.add(dir);
      await this.refresh();
      this.app.openPath(p);
    } catch (e) { errorToast(e); }
  }

  /** A new, empty folder opened as a BoxSpace. It goes in data/BoxSpaces unless another place is picked. */
  async createSpace() {
    const sep = this.app.info?.sep || '\\';
    const home = this.app.info?.data ? joinPath(this.app.info.data, 'BoxSpaces') : (this.app.info?.documents || '');
    let where = home;
    const name = h('input', { type: 'text', placeholder: 'My project', style: 'width:100%' });
    const whereEl = h('div', { class: 'mono spaces-where', title: where });
    const full = h('div', { class: 'faint spaces-where-full' });
    const show = () => {
      whereEl.textContent = where; whereEl.title = where;
      const n = name.value.trim();
      full.textContent = n ? `Makes ${where.replace(/[\\/]+$/, '')}${sep}${n}` : '';
    };
    name.addEventListener('input', show);
    const change = h('button', { class: 'btn', onclick: async () => {
      const { pickFolder } = await import('./files.js');
      const p = await pickFolder({ title: 'Where should the new BoxSpace go?', initialDir: where });
      if (p) { where = p; show(); }
    } }, icon('folder-open', 'sm'), 'Change…');
    const reset = h('button', { class: 'btn ghost', 'data-tip': 'Back to the usual place (BoxSpaces in the app’s data folder)', onclick: () => { where = home; show(); } }, 'Default');
    show();
    const body = h('div', {},
      h('label', { class: 'field' }, h('span', {}, 'Folder name'), name),
      h('div', { class: 'field' }, h('span', {}, 'Where it goes'), h('div', { class: 'spaces-where-row' }, whereEl, change, reset)),
      full);
    const bad = /[<>:"/\\|?*\x00-\x1f]/;
    const res = await modal({
      title: 'New BoxSpace', body,
      onOpen: () => name.focus(),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Create', primary: true, onClick: () => {
        const n = name.value.trim().replace(/[. ]+$/, '');
        if (!n) { name.focus(); return false; }
        if (bad.test(n)) { toast('A folder name can’t have < > : " / \\ | ? *', { type: 'warn' }); return false; }
        return n;
      } }],
    });
    if (!res) return;
    const path = joinPath(where, res);
    try {
      const st = await api.stat(path);
      if (st.exists && !(await confirmDialog('Folder already there', `${path} already exists. Open it as a BoxSpace?`, { okLabel: 'Open it' }))) return;
      if (!st.exists) await api.mkdir(path);
      await this.app.openSpace(path);
    } catch (e) { errorToast(e); }
  }

  async newFolder(dir) {
    const name = await promptDialog('New folder', `In ${basename(dir)}`, '');
    if (!name) return;
    try { await api.mkdir(joinPath(dir, name)); this.expanded.add(dir); this.refresh(); } catch (e) { errorToast(e); }
  }

  async rename(p, given) {
    const name = given ?? await promptDialog('Rename', 'New name', basename(p), { selectBase: true });
    if (!name || name === basename(p)) return;
    const to = joinPath(dirname(p), name);
    try {
      await api.rename(p, to);
      const tab = this.app.tabs.find((t) => t.path && t.path.toLowerCase() === p.toLowerCase());
      if (tab) this.app.setTabMeta(tab, { path: to, title: name, ext: extOf(name) });
      this.refresh();
    } catch (e) { errorToast(e); }
  }

  async duplicate(p) {
    const ext = extOf(p);
    const stem = basename(p).replace(new RegExp(`\\.${ext}$`), '');
    let n = 1;
    let to;
    do { to = joinPath(dirname(p), `${stem} copy${n > 1 ? ' ' + n : ''}${ext ? '.' + ext : ''}`); n++; } while ((await api.stat(to)).exists);
    try { const { bytes } = await api.read(p); await api.write(to, bytes); this.refresh(); } catch (e) { errorToast(e); }
  }

  async trash(p) {
    if (!(await confirmDialog('Move to Recycle Bin?', `“${basename(p)}” will be moved to the Recycle Bin. You can restore it from there.`, { okLabel: 'Move to Recycle Bin', danger: true }))) return;
    try {
      await api.trash(p);
      const tab = this.app.tabs.find((t) => t.path && t.path.toLowerCase().startsWith(p.toLowerCase()));
      if (tab) this.app.closeTab(tab, { force: !tab.dirty });
      toast(`Moved ${basename(p)} to the Recycle Bin`, { type: 'ok' });
      this.refresh();
    } catch (e) { errorToast(e, 'Delete failed'); }
  }

  // ------------------------------------------------------------------ search

  renderSearch(host) {
    const scope = this.searchScope || this.root;
    const q = h('input', { type: 'search', placeholder: 'Search in files', value: this.lastSearch?.query || '' });
    const inc = h('input', { type: 'text', placeholder: 'files to include, e.g. *.js, *.json', value: this.lastSearch?.include || '' });
    const flags = { caseSensitive: false, wholeWord: false, regex: false, ...(this.lastSearch || {}) };
    const tog = (k, label, tip) => { const b = h('button', { class: `icon-btn toggle ${flags[k] ? 'active' : ''}`, 'data-tip': tip }, label); b.addEventListener('click', () => { flags[k] = !flags[k]; b.classList.toggle('active', flags[k]); run(); }); return b; };
    const results = h('div', { class: 'spaces-results' });
    const info = h('div', { class: 'faint mono spaces-search-info' });
    const run = debounce(async () => {
      const query = q.value;
      this.lastSearch = { query, include: inc.value, ...flags };
      clear(results);
      if (!query) { info.textContent = ''; return; }
      info.textContent = 'searching…';
      try {
        const r = await api.search({ root: scope, query, include: inc.value, ...flags });
        info.textContent = `${r.hits} result${r.hits === 1 ? '' : 's'} in ${r.results.length} file${r.results.length === 1 ? '' : 's'}${r.truncated ? ' (stopped at 3000)' : ''}`;
        for (const f of r.results) {
          const group = h('div', { class: 'spaces-hitgroup' },
            h('div', { class: 'spaces-hitfile', title: f.path }, icon(iconForName(f.rel), 'sm'), h('span', {}, basename(f.rel)), h('span', { class: 'faint' }, dirname(f.rel)), h('span', { class: 'spaces-count' }, String(f.matches.length))));
          for (const m of f.matches) {
            const pre = m.text.slice(Math.max(0, m.col - 1 - 30), m.col - 1);
            const hit = m.text.slice(m.col - 1, m.col - 1 + m.len);
            const post = m.text.slice(m.col - 1 + m.len, m.col - 1 + m.len + 80);
            const row = h('button', { class: 'spaces-hit' }, h('span', { class: 'spaces-ln mono' }, m.line), h('span', { class: 'spaces-snip' }, pre.trimStart(), h('mark', {}, hit), post));
            row.addEventListener('click', () => this.app.openAt(f.path, m.line, m.col));
            group.append(row);
          }
          results.append(group);
        }
      } catch (e) { info.textContent = e.message; }
    }, 300);
    q.addEventListener('input', run);
    inc.addEventListener('input', run);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') run.flush(); });
    host.append(h('div', { class: 'spaces-search' },
      h('div', { class: 'row' }, q, tog('caseSensitive', 'Aa', 'Match case'), tog('wholeWord', 'ab', 'Whole word'), tog('regex', '.*', 'Regex')),
      inc,
      scope !== this.root ? h('div', { class: 'faint mono', style: { fontSize: '10.5px' } }, 'in ', scope.slice(this.root.length + 1) || '.', ' ', h('button', { class: 'btn sm ghost', onclick: () => { this.searchScope = null; this.render(host); } }, 'search everything')) : null,
      info),
    h('div', { class: 'panel-body' }, results));
    setTimeout(() => q.focus(), 30);
    if (q.value) run();
  }

  // ------------------------------------------------------------------ quick open

  async fileIndex() {
    if (!this.root) return [];
    if (!this.files) {
      try { this.files = (await api.files(this.root)).files; } catch { this.files = []; }
    }
    return this.files;
  }
}

/** Fuzzy score: higher is better; -1 = no match. */
export function fuzzy(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx - (t.length - q.length) * 0.1 + (t.lastIndexOf('\\') < idx ? 200 : 0);
  let score = 0, ti = 0, streak = 0;
  for (const ch of q) {
    const f = t.indexOf(ch, ti);
    if (f < 0) return -1;
    streak = f === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (f - ti) * 0.5;
    ti = f + 1;
  }
  return score;
}

export { formatBytes };
