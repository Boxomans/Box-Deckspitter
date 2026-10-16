// Command palette (Ctrl+Shift+P) and quick open (Ctrl+E). Type ">" in quick open to switch to commands.

import { h, clear, basename, dirname } from './dom.js';
import { icon } from './icons.js';
import { iconForName } from './filetypes.js';
import { fuzzy } from './spaces.js';
import { api } from './api.js';

let open = null;

function flattenMenu(items, prefix, out) {
  for (const it of items || []) {
    if (!it || it.sep || it.heading || it.hidden) continue;
    if (Array.isArray(it.submenu)) flattenMenu(it.submenu, prefix + it.label + ' › ', out);
    else if (it.action && !it.disabled) out.push({ label: prefix + it.label, icon: it.icon, hint: it.shortcut, run: it.action });
  }
  return out;
}

async function commandItems(app) {
  const ed = app.active?.editor;
  const em = ed?.menus?.() || {};
  const out = [];
  flattenMenu(app.newMenuItems(), 'New › ', out);
  flattenMenu(app.fileMenu().filter((x) => x && x.label !== 'New' && x.label !== 'Open recent'), 'File › ', out);
  flattenMenu(app.editMenu(em.edit), 'Edit › ', out);
  flattenMenu(app.viewMenu(em.view), 'View › ', out);
  flattenMenu(em.insert, 'Insert › ', out);
  flattenMenu(em.format, 'Format › ', out);
  flattenMenu(app.toolsMenu(em.tools), 'Tools › ', out);
  flattenMenu(app.helpMenu(), 'Help › ', out);
  for (const t of app.tabs) out.push({ label: 'Go to tab › ' + t.title, icon: 'layers', run: () => app.activate(t) });
  out.push({ label: 'Go to › Home', icon: 'home', run: () => app.activate(null) });
  return out;
}

async function fileItems(app) {
  const out = [];
  const seen = new Set();
  if (app.spaces?.root) {
    const root = app.spaces.root;
    for (const rel of await app.spaces.fileIndex()) {
      const full = root.replace(/[\\/]$/, '') + '\\' + rel;
      seen.add(full.toLowerCase());
      out.push({ label: basename(rel), detail: dirname(rel), icon: iconForName(rel), match: rel, run: () => app.openPath(full) });
    }
  }
  try {
    for (const r of app.settings.showRecent === false ? [] : await api.recent()) {
      if (!r.exists || seen.has(r.path.toLowerCase())) continue;
      out.push({ label: r.name, detail: dirname(r.path), icon: iconForName(r.name), match: r.path, recent: true, run: () => app.openPath(r.path) });
    }
  } catch { /* offline */ }
  return out;
}

export async function openPalette(app, startMode = 'commands') {
  if (open) { open.close(); }
  let mode = startMode;
  const input = h('input', { type: 'text', class: 'palette-input', spellcheck: 'false', placeholder: mode === 'commands' ? 'Type a command…' : 'Search files by name  ( > for commands )' });
  if (mode === 'commands') input.value = '>';
  const list = h('div', { class: 'palette-list' });
  const box = h('div', { class: 'palette' }, h('div', { class: 'palette-top' }, icon(mode === 'commands' ? 'terminal' : 'search'), input), list);
  const back = h('div', { class: 'palette-backdrop' }, box);
  document.getElementById('overlay-root').append(back);
  let items = [];
  let shown = [];
  let index = 0;
  const cmds = await commandItems(app);
  let files = null;

  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); open = null; };
  open = { close };

  const render = async () => {
    const raw = input.value;
    const isCmd = raw.startsWith('>');
    const q = isCmd ? raw.slice(1).trim() : raw.trim();
    if (isCmd) items = cmds;
    else { if (!files) files = await fileItems(app); items = files; }
    const score = (it) => {
      const byName = fuzzy(q, it.label);
      const path = (it.match || '').toLowerCase();
      const bySub = path.includes(q.toLowerCase()) ? 300 - path.indexOf(q.toLowerCase()) * 0.5 : -1;
      const s = Math.max(byName >= 0 ? byName + 100 : -1, bySub);
      return s >= 0 && it.recent ? s - 40 : s;
    };
    shown = q
      ? items.map((it) => ({ it, s: score(it) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 60).map((x) => x.it)
      : items.slice(0, 60);
    index = Math.min(index, Math.max(0, shown.length - 1));
    clear(list);
    if (!shown.length) list.append(h('div', { class: 'palette-empty' }, isCmd ? 'No matching commands' : app.spaces?.root ? 'No matching files' : 'No matches — open a folder in BoxSpaces to search its files'));
    shown.forEach((it, i) => {
      const row = h('button', { class: `palette-item ${i === index ? 'active' : ''}` },
        h('span', { class: 'pi-icon' }, it.icon ? icon(it.icon, 'sm') : null),
        h('span', { class: 'pi-label' }, it.label),
        it.detail ? h('span', { class: 'pi-detail' }, it.detail) : null,
        it.recent ? h('span', { class: 'pi-hint' }, 'recent') : it.hint ? h('kbd', {}, it.hint) : null);
      row.addEventListener('mousemove', () => { if (index !== i) { index = i; highlight(); } });
      row.addEventListener('click', () => choose(it));
      list.append(row);
    });
  };
  const highlight = () => [...list.children].forEach((c, i) => { c.classList.toggle('active', i === index); if (i === index) c.scrollIntoView({ block: 'nearest' }); });
  const choose = (it) => { close(); setTimeout(() => it.run(), 0); };
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(shown.length - 1, index + 1); highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(0, index - 1); highlight(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (shown[index]) choose(shown[index]); }
  }
  document.addEventListener('keydown', onKey, true);
  input.addEventListener('input', () => { index = 0; render(); });
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  render();
  setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 10);
  void mode;
}
