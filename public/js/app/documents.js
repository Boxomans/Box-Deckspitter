// Box-DocSpitter app shell, opening, creating and saving documents, versions and drafts.
// Methods of App (app.js mixes this class into it).

import {
  $, h, clear, basename, dirname, extOf, stripExt, formatBytes, timeAgo, formatDate, toBytes,
} from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { modal, confirmDialog, choiceDialog, toast, errorToast } from '../core/ui.js';
import { detectMode, extForLang, OPEN_FILTERS, VIDEO_FILTERS } from '../core/filetypes.js';
import { pickOpen, pickSave, setLastDir, getLastDir } from '../core/files.js';
import { TOOLS, EDITORS, SINGLE_MODES } from '../core/tools.js';

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

export class DocumentsPart {
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
      ...Object.fromEntries(TOOLS.filter((t) => t.tab).map((t) => [t.mode, { mode: t.mode, ext: '', base: t.rename ? this.toolName(t.name) : t.name }])),
      cut: { mode: 'cut', ext: 'boxcut', base: `Untitled ${this.toolName('Video editor').toLowerCase()}` },
      paint: { mode: 'paint', ext: 'png', base: 'Untitled image' },
    }[kind];
    if (!spec) return;
    let images = opts.images || null;
    if (kind === 'pdf-images' && !images) {
      images = await pickOpen({ multi: true, title: 'Choose images', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
      if (!images) return;
    }
    if (SINGLE_MODES.has(kind) && !opts.another) {
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
      const { pickFolder } = await import('../core/files.js');
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
      const { Spaces } = await import('../core/spaces.js');
      this.spaces = new Spaces(this);
    }
    return this.spaces;
  }

  async commandPalette(mode = 'commands') {
    const { openPalette } = await import('../core/palette.js');
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
    // an image whose file type was changed goes to a new name rather than writing GIF bytes into a .png
    if (!tab.path || !formats.some((f) => f.ext === tab.ext) || (tab.editor.out && extOf(tab.path) !== tab.ext)) return this.saveAs(tab);
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
    const lossy = tab.editor.lossyFormat(ext) && (tab.editor.lossyNote?.(ext) || null);
    if (tab.editor.lossyFormat(ext) && !(await confirmDialog(lossy ? 'Not everything fits in this file' : 'Some formatting may be lost', lossy || `Saving as .${ext} keeps the text but drops formatting this format can't store. Continue?`, { okLabel: 'Save anyway' }))) return false;
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
        api.saveDraft({ id: t.id, title: t.title, path: t.path, mode: t.mode, ext: t.ext, lang: t.lang, content, client: this.clientId }).catch(() => {});
      }
    }, 15000);
  }

  // ======================================================================= side panels
}
