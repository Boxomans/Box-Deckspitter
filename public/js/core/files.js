// Open / Save dialogs: native Windows dialogs (via the server) with a built-in browser fallback.

import { api } from './api.js';
import { h, clear, dirname, joinPath, extOf, formatBytes, timeAgo, basename } from './dom.js';
import { icon } from './icons.js';
import { modal, toast, confirmDialog, promptDialog } from './ui.js';
import { OPEN_FILTERS, iconForName } from './filetypes.js';

const state = { info: null, settings: {}, lastDir: null };

export function configureFiles({ info, settings }) {
  if (info) state.info = info;
  if (settings) state.settings = settings;
}
export function setLastDir(d) { if (d) state.lastDir = d; }
export function getLastDir() { return state.lastDir || state.info?.documents || state.info?.home; }

// In the desktop shell, dialogs come straight from Electron (fast and modal to the window).
const nativeDialog = (opts) => (window.bdsShell ? window.bdsShell.dialog(opts) : api.dialog(opts));

function useNative() {
  return state.info?.nativeDialogs && state.settings.nativeDialogs !== false;
}

export async function pickOpen({ multi = false, filters = OPEN_FILTERS, title = 'Open', initialDir } = {}) {
  if (useNative()) {
    const r = await nativeDialog({ kind: 'open', multi, filters, title, initialDir: initialDir || getLastDir() }).catch((e) => ({ unsupported: true, error: e.message }));
    if (r.cancelled) return null;
    if (!r.unsupported) { setLastDir(dirname(r.paths[0])); return r.paths; }
    toast('Native file dialog unavailable — using the built-in browser.', { type: 'warn' });
  }
  const res = await browseDialog({ kind: 'open', multi, filters, title, initialDir });
  return res ? res.paths : null;
}

/** Returns {path, filterIndex} or null. filterIndex is 1-based like WinForms. */
export async function pickSave({ defaultName = 'Untitled', filters = [{ name: 'All files', extensions: ['*'] }], title = 'Save as', initialDir } = {}) {
  if (useNative()) {
    const r = await nativeDialog({
      kind: 'save', defaultName, filters, title, initialDir: initialDir || getLastDir(),
      defaultExt: filters[0]?.extensions?.[0] !== '*' ? filters[0]?.extensions?.[0] : undefined,
    }).catch((e) => ({ unsupported: true, error: e.message }));
    if (r.cancelled) return null;
    if (!r.unsupported) { setLastDir(dirname(r.paths[0])); return { path: r.paths[0], filterIndex: r.filterIndex || 1 }; }
    toast('Native file dialog unavailable — using the built-in browser.', { type: 'warn' });
  }
  const res = await browseDialog({ kind: 'save', filters, title, initialDir, defaultName });
  return res ? { path: res.paths[0], filterIndex: res.filterIndex } : null;
}

export async function pickFolder({ title = 'Choose folder', initialDir } = {}) {
  if (useNative()) {
    const r = await nativeDialog({ kind: 'folder', title, initialDir: initialDir || getLastDir() }).catch(() => ({ unsupported: true }));
    if (r.cancelled) return null;
    if (!r.unsupported) return r.paths[0];
  }
  const res = await browseDialog({ kind: 'folder', title, initialDir });
  return res ? res.paths[0] : null;
}

// ---------------------------------------------------------------------------
// Built-in file browser
// ---------------------------------------------------------------------------

function quickPlaces() {
  const i = state.info || {};
  const places = [
    ['Home', i.home, 'home'], ['Desktop', i.desktop, 'window'], ['Documents', i.documents, 'file-text'],
    ['Downloads', i.downloads, 'download'], ['Pictures', i.pictures, 'image'],
  ].filter((p) => p[1]);
  for (const d of i.drives || []) places.push([d.replace(/\\$/, ''), d, 'layers']);
  return places;
}

function matchesFilter(name, filter) {
  if (!filter) return true;
  const exts = filter.extensions || ['*'];
  if (exts.includes('*')) return true;
  return exts.includes(extOf(name));
}

export function browseDialog({ kind, multi, filters, title, initialDir, defaultName }) {
  let dir = initialDir || getLastDir() || 'C:\\';
  let filterIndex = 1;
  let selected = new Set();
  let entries = [];

  const pathInput = h('input', { type: 'text', value: dir, spellcheck: 'false' });
  const list = h('div', { class: 'fb-list' });
  const nameInput = kind === 'save' ? h('input', { type: 'text', value: defaultName || '', spellcheck: 'false' }) : null;
  const filterSel = kind !== 'folder' ? h('select', {}, (filters || []).map((f, i) => h('option', { value: String(i + 1) }, f.name))) : null;
  const side = h('div', { class: 'fb-side' }, quickPlaces().map(([label, p, ic]) =>
    h('button', { class: 'file-row', onclick: () => go(p) }, h('span', { class: 'fr-icon' }, icon(ic, 'sm')), h('span', { class: 'fr-name' }, label))));

  let ctxRef = null;

  async function go(d) {
    try {
      const res = await api.list(d);
      dir = res.path;
      entries = res.entries;
      pathInput.value = dir;
      selected.clear();
      render();
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
  }

  function render() {
    clear(list);
    const filter = filters?.[filterIndex - 1];
    const shown = entries.filter((e) => !e.hidden && (e.isDir || (kind !== 'folder' && matchesFilter(e.name, filter))));
    if (!shown.length) list.append(h('div', { class: 'empty-note' }, 'Empty folder'));
    for (const e of shown) {
      const row = h('button', { class: `file-row ${e.isDir ? 'dir' : ''} ${selected.has(e.path) ? 'selected' : ''} ${e.dot ? 'muted' : ''}` },
        h('span', { class: 'fr-icon' }, icon(iconForName(e.name, e.isDir), 'sm')),
        h('span', { class: 'fr-name' }, e.name),
        h('span', { class: 'fr-meta' }, e.isDir ? '' : formatBytes(e.size)),
        h('span', { class: 'fr-meta', style: { width: '64px', textAlign: 'right' } }, timeAgo(e.mtime)));
      row.addEventListener('click', (ev) => {
        if (e.isDir) { selected.clear(); selected.add(e.path); }
        else if (multi && (ev.ctrlKey || ev.metaKey)) { selected.has(e.path) ? selected.delete(e.path) : selected.add(e.path); }
        else { selected.clear(); selected.add(e.path); }
        if (nameInput && !e.isDir) nameInput.value = e.name;
        render();
      });
      row.addEventListener('dblclick', () => {
        if (e.isDir) go(e.path);
        else if (kind === 'open') { selected.clear(); selected.add(e.path); accept(); }
        else if (kind === 'save') { nameInput.value = e.name; accept(); }
      });
      list.append(row);
    }
  }

  async function accept() {
    if (kind === 'folder') {
      const sel = [...selected][0];
      const entry = entries.find((e) => e.path === sel && e.isDir);
      return ctxRef.close({ paths: [entry ? entry.path : dir] });
    }
    if (kind === 'open') {
      const files = [...selected].filter((p) => !entries.find((e) => e.path === p)?.isDir);
      if (!files.length) {
        const dsel = [...selected][0];
        if (dsel) go(dsel);
        return;
      }
      setLastDir(dir);
      return ctxRef.close({ paths: files });
    }
    // save
    let name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    if (/[\\/]/.test(name) && /^[A-Za-z]:|^\//.test(name)) { // absolute path typed
      const st = await api.stat(name).catch(() => ({}));
      if (st.isDir) return go(name);
    }
    const filter = filters?.[filterIndex - 1];
    const fext = filter?.extensions?.[0];
    if (!extOf(name) && fext && fext !== '*') name += '.' + fext;
    const full = /^[A-Za-z]:[\\/]|^\//.test(name) ? name : joinPath(dir, name);
    const st = await api.stat(full).catch(() => ({}));
    if (st.isDir) return go(full);
    if (st.exists && !(await confirmDialog('Replace file?', `"${basename(full)}" already exists. Replace it?`, { okLabel: 'Replace', danger: true }))) return;
    setLastDir(dirname(full));
    ctxRef.close({ paths: [full], filterIndex });
  }

  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(pathInput.value.trim()); } });
  filterSel?.addEventListener('change', () => {
    filterIndex = Number(filterSel.value);
    if (nameInput) {
      const fext = filters[filterIndex - 1]?.extensions?.[0];
      if (fext && fext !== '*') {
        const n = nameInput.value;
        const i = n.lastIndexOf('.');
        nameInput.value = (i > 0 ? n.slice(0, i) : n) + '.' + fext;
      }
    }
    render();
  });

  const up = h('button', { class: 'icon-btn', 'data-tip': 'Up one folder', onclick: () => { const p = dirname(dir); if (p && p !== dir) go(p); } }, icon('arrow-up'));
  const newFolder = h('button', {
    class: 'icon-btn', 'data-tip': 'New folder',
    onclick: async () => {
      const name = await promptDialog('New folder', 'Folder name', 'New folder');
      if (!name) return;
      try { await api.mkdir(joinPath(dir, name)); go(dir); } catch (e) { toast(e.message, { type: 'error' }); }
    },
  }, icon('folder-plus'));

  const body = h('div', { class: 'fb' },
    h('div', { class: 'fb-top' }, up, pathInput, h('button', { class: 'icon-btn', 'data-tip': 'Refresh', onclick: () => go(dir) }, icon('refresh')), newFolder),
    h('div', { class: 'fb-main' }, side, list),
    h('div', { class: 'fb-bottom' },
      nameInput ? h('span', { class: 'dim' }, 'File name') : null, nameInput,
      filterSel, !nameInput ? h('div', { class: 'grow' }) : null));

  const okLabel = kind === 'save' ? 'Save' : kind === 'folder' ? 'Select folder' : 'Open';
  const p = modal({
    title, body, xwide: true,
    buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: okLabel, primary: true, onClick: () => { accept(); return false; } }],
    onOpen: (c) => { ctxRef = c; go(dir).catch(() => go(state.info?.home || 'C:\\')); if (nameInput) setTimeout(() => { nameInput.focus(); const i = nameInput.value.lastIndexOf('.'); nameInput.setSelectionRange(0, i > 0 ? i : nameInput.value.length); }, 40); },
  });
  return p;
}
