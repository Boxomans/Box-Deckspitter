// Dumps — bottom drawers backed by folders next to the app: image-dump\ and doc-dump\.
// Media dump: click inserts into the page. Doc dump: click opens the document in a new tab.
// Right-click copies (image → picture, PDF → file); Shift+right-click shows every option.
// Drag a thumbnail into the page, or (in the app window) out to Explorer / the desktop / Discord as a real file.

import { h, clear, formatBytes, timeAgo, blobToDataURL, basename, extOf, vendor } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import { contextMenu, toast, errorToast, promptDialog, hoverKeys, renameInline, PATHS_MIME, draggedPaths } from '../../core/ui.js';
import { pickOpen } from '../../core/files.js';

export const DUMP_MIME = 'text/bds-dump';

const KINDS = {
  image: {
    label: 'media dump', icon: 'image', folder: 'media-dump', noun: 'image',
    accept: /\.(png|jpe?g|jfif|gif|webp|bmp|svg|avif|ico)$/i,
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'] }],
    hint: 'click to insert · right-click to copy · shift+right-click for more · drag into the page or out of the app',
    emptyHint: 'drop images here, paste a screenshot (Ctrl+V), or use “Add images”. (Videos and sounds in the media dump show in the video editor and the left sidebar.)',
  },
  doc: {
    label: 'doc dump', icon: 'file-text', folder: 'doc-dump', noun: 'document',
    accept: /\.(pdf|docx?|odt|rtf|txt|md|xlsx?|ods|csv|pptx?|odp|html?|eml)$/i,
    filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'odt', 'rtf', 'txt', 'md', 'xlsx', 'xls', 'ods', 'csv', 'pptx', 'ppt', 'odp', 'html', 'htm', 'eml'] }],
    hint: 'click to open in a new tab · right-click to copy the file · shift+right-click for more · drag out of the app',
    emptyHint: 'drop PDFs, Word docs, spreadsheets and other documents here, use “Add documents”, or save this document into the dump.',
  },
};

// PDF first-page thumbnails, cached across drawers for the session.
const pdfThumbs = new Map();
let thumbChain = Promise.resolve();
function pdfThumb(it) {
  const key = it.name + '|' + it.mtime;
  if (!pdfThumbs.has(key)) {
    pdfThumbs.set(key, (thumbChain = thumbChain.then(async () => {
      const pdfjs = await vendor.pdfjs();
      const data = new Uint8Array(await (await fetch(it.url)).arrayBuffer());
      const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
      try {
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 320 / Math.max(base.width, base.height) });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
        return { url: c.toDataURL('image/png'), pages: doc.numPages };
      } finally { await doc.destroy(); }
    }).catch(() => null)));
  }
  return pdfThumbs.get(key);
}

export class ImageDump {
  /**
   * @param {object} o
   * @param {'image'|'doc'} [o.kind]
   * @param {(url: string, name: string) => void} [o.onInsert]  media dump: insert into the page
   * @param {() => Promise<{name: string, bytes: Uint8Array}>} [o.onSaveDoc]  doc dump: current document as a PDF
   */
  constructor({ app, kind = 'image', onInsert, onSaveDoc, dock }) {
    this.app = app;
    this.kind = kind;
    this.cfg = KINDS[kind];
    this.onInsert = onInsert;
    this.onSaveDoc = onSaveDoc;
    this.dock = dock;
    this.items = [];
    this.folders = [];
    this.sub = ''; // the folder that's open ('' = the top)
    this.sig = '';
    this.open = false;
    this.size = app.settings.dumpThumb || 92;

    this.count = h('span', { class: 'dump-count' }, '0');
    this.chev = h('span', { class: 'dump-chev' }, icon('chevron-up', 'sm'));
    this.tabBtn = h('button', { class: 'dump-tab', title: `${this.cfg.label} — files saved in Box-Deckspitter\\${this.cfg.folder}` },
      icon(this.cfg.icon, 'sm'), h('span', {}, this.cfg.label), this.count, this.chev);
    this.tabBtn.addEventListener('click', () => this.toggle());

    this.grid = h('div', { class: `dump-grid ${kind}` });
    this.empty = h('div', { class: 'dump-empty' },
      h('div', {}, `nothing in the ${this.cfg.label} yet`),
      h('div', { class: 'faint' }, `${this.cfg.emptyHint} They live in Box-Deckspitter\\${this.cfg.folder}.`));
    const slider = h('input', { type: 'range', min: '64', max: '160', value: String(this.size), title: 'Thumbnail size' });
    slider.addEventListener('input', () => { this.size = Number(slider.value); this.grid.style.setProperty('--thumb', this.size + 'px'); });
    slider.addEventListener('change', () => app.saveSettings({ dumpThumb: this.size }));
    this.grid.style.setProperty('--thumb', this.size + 'px');

    this.drawer = h('div', { class: 'dump-drawer', tabindex: '0' },
      h('div', { class: 'dump-head' },
        this.crumbs = h('span', { class: 'mono faint dump-crumbs' }),
        h('div', { class: 'grow' }),
        h('button', { class: 'icon-btn', 'data-tip': 'New folder', onclick: () => this.newFolder() }, icon('folder-plus', 'sm')),
        slider,
        kind === 'doc' && onSaveDoc ? h('button', { class: 'btn sm', 'data-tip': 'Save the open document into the doc dump as a PDF', onclick: () => this.saveDoc() }, icon('file-pdf', 'sm'), 'Save this doc here') : null,
        h('button', { class: 'btn sm', onclick: () => this.addFromDisk() }, icon('plus', 'sm'), kind === 'doc' ? 'Add documents' : 'Add images'),
        h('button', { class: 'icon-btn', 'data-tip': 'Refresh', onclick: () => this.refresh(true) }, icon('refresh', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Open folder in Explorer', onclick: () => api.dumpReveal(kind, null, this.sub || null) }, icon('external', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Close', onclick: () => this.toggle(false) }, icon('chevron-down', 'sm'))),
      h('div', { class: 'dump-scroll' }, this.grid, this.empty));
    this.drawer.hidden = true;

    // drop files onto the drawer or its tab → stash them
    for (const target of [this.drawer, this.tabBtn]) {
      target.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(PATHS_MIME)) { e.preventDefault(); e.stopPropagation(); this.dock?.el.classList.add('drop'); if (!this.open) this.toggle(true); }
      });
      target.addEventListener('dragleave', () => this.dock?.el.classList.remove('drop'));
      target.addEventListener('drop', (e) => {
        this.dock?.el.classList.remove('drop');
        const paths = draggedPaths(e);
        if (!e.dataTransfer.files.length && !paths.length) return;
        e.preventDefault();
        e.stopPropagation();
        this.addFiles([...e.dataTransfer.files], this.sub, paths);
      });
    }
    this.drawer.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => this.accepts(f));
      if (!files.length) return;
      e.preventDefault();
      this.addFiles(files);
    });

    this.timer = setInterval(() => { if (this.open && document.visibilityState === 'visible' && this.drawer.isConnected && this.drawer.offsetParent) this.refresh(); }, 4000);
    this.refresh();
  }

  accepts(f) {
    return this.kind === 'doc' ? this.cfg.accept.test(f.name || '') || f.type === 'application/pdf' : f.type.startsWith('image/') || this.cfg.accept.test(f.name || '');
  }

  toggle(force) {
    const open = force ?? !this.open;
    if (this.dock) this.dock.show(open ? this.kind : null);
    else this.setOpen(open);
  }

  setOpen(open) {
    this.open = open;
    this.drawer.hidden = !open;
    this.tabBtn.classList.toggle('on', open);
    clear(this.chev).append(icon(open ? 'chevron-down' : 'chevron-up', 'sm'));
    if (open) this.refresh(true);
  }

  async refresh(force = false) {
    let res;
    try { res = await api.dump(this.kind, this.sub); } catch {
      if (this.sub) { this.sub = ''; return this.refresh(true); } // the folder went away
      return;
    }
    this.items = res.items;
    this.folders = res.folders || [];
    this.count.textContent = String(res.items.length + this.folders.length);
    const sig = this.sub + '#' + this.folders.map((f) => f.name + f.count).join('|') + '#' + res.items.map((i) => i.name + i.mtime).join('|');
    if (!force && sig === this.sig) return;
    this.sig = sig;
    this.render();
  }

  openFolder(rel) { this.sub = rel || ''; this.refresh(true); }

  async newFolder() {
    const name = await promptDialog('New folder', 'Folder name', 'New folder');
    if (!name) return;
    try { await api.dumpFolder(this.sub ? `${this.sub}/${name}` : name, this.kind); this.refresh(true); } catch (e) { errorToast(e, 'Could not make the folder'); }
  }

  /** Drops on a folder card or a part of the path go into that folder (things already in the dump are moved). */
  dropTarget(el, folder) {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(PATHS_MIME)) return;
      e.preventDefault(); e.stopPropagation();
      el.classList.add('drop-into');
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-into'); });
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-into');
      this.dock?.el.classList.remove('drop');
      e.preventDefault(); e.stopPropagation();
      this.addFiles([...e.dataTransfer.files], folder, draggedPaths(e));
    });
  }

  renderCrumbs() {
    const c = clear(this.crumbs);
    const parts = this.sub ? this.sub.split('/') : [];
    const crumb = (text, to) => {
      const b = h('button', { class: `dump-crumb ${to === this.sub ? 'here' : ''}`, onclick: () => this.openFolder(to) }, text);
      this.dropTarget(b, to);
      return b;
    };
    c.append('> ', crumb(this.cfg.folder, ''));
    parts.forEach((part, i) => c.append('/', crumb(part, parts.slice(0, i + 1).join('/'))));
    c.append('/');
  }

  render() {
    clear(this.grid);
    this.renderCrumbs();
    this.empty.hidden = this.items.length + this.folders.length > 0;
    for (const f of this.folders) {
      const nameEl = h('div', { class: 'dump-name' }, f.base);
      const card = h('div', { class: 'dump-item dump-folder', title: `${f.base}\n${f.count} item${f.count === 1 ? '' : 's'}\nClick to open · drop files on it to put them inside\nF2: rename · Del: remove` },
        h('div', { class: 'dump-thumb doc' }, icon('folder', 'xl'), h('span', { class: 'dump-badge mono' }, String(f.count))), nameEl);
      hoverKeys(card, { nameEl, value: () => f.base, commit: (n) => this.rename(f, n), remove: () => this.remove(f) });
      card.addEventListener('click', () => this.openFolder(f.name));
      card.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Open', icon: 'folder-open', action: () => this.openFolder(f.name) },
        { label: 'Rename…', icon: 'edit', shortcut: 'F2', action: () => { if (!renameInline(card)) this.rename(f); } },
        { label: 'Show in Explorer', icon: 'external', action: () => api.dumpReveal(this.kind, f.name) },
        { sep: true },
        { label: 'Remove folder', icon: 'trash', shortcut: 'Del', action: () => this.remove(f) },
      ]));
      this.dropTarget(card, f.name);
      this.grid.append(card);
    }
    for (const it of this.items) {
      const isDoc = this.kind === 'doc';
      const isPdf = isDoc && /\.pdf$/i.test(it.name);
      const img = h('img', { alt: it.base || it.name, loading: 'lazy', draggable: 'false' });
      const thumb = h('div', { class: `dump-thumb ${isDoc ? 'pdf' : 'checker'}` }, img);
      if (isPdf) {
        const badge = h('span', { class: 'dump-badge mono' }, 'PDF');
        thumb.append(badge);
        pdfThumb(it).then((t) => { if (t) { img.src = t.url; badge.textContent = `${t.pages} p`; } else thumb.classList.add('broken'); });
      } else if (isDoc) {
        img.remove();
        thumb.classList.add('doc');
        thumb.append(icon(/\.(xlsx?|ods|csv)$/i.test(it.name) ? 'table' : /\.eml$/i.test(it.name) ? 'mail' : 'file-text', 'xl'), h('span', { class: 'dump-badge mono' }, extOf(it.name).toUpperCase()));
      } else img.src = it.url;
      const tip = isDoc
        ? `${it.base || it.name}\n${formatBytes(it.size)} · added ${timeAgo(it.mtime)}\nClick: open in a new tab · Right-click: copy file · Shift+right-click: more`
        : `${it.base || it.name}\n${formatBytes(it.size)} · added ${timeAgo(it.mtime)}\nClick: insert · Right-click: copy · Shift+right-click: more · Drag: into the page, a folder, or out of the app`;
      const nameEl = h('div', { class: 'dump-name' }, it.base || it.name);
      const card = h('div', { class: 'dump-item', draggable: 'true', title: tip + '\nF2: rename · Del: remove' }, thumb, nameEl);
      hoverKeys(card, { nameEl, value: () => it.base || it.name, selectBase: true, commit: (n) => this.rename(it, n), remove: () => this.remove(it) });
      card.addEventListener('click', () => (isDoc ? this.openPdf(it) : this.insert(it)));
      card.addEventListener('dragstart', (e) => this.dragOut(e, it, img));
      card.addEventListener('contextmenu', (e) => {
        if (e.shiftKey) return contextMenu(e, this.menu(it));
        e.preventDefault();
        card.classList.add('copied');
        setTimeout(() => card.classList.remove('copied'), 600);
        if (isDoc) this.copyFile(it); else this.copy(it);
      });
      this.grid.append(card);
    }
  }

  menu(it) {
    const common = [
      { label: 'Copy as file', icon: 'copy', action: () => this.copyFile(it) },
      { label: 'Copy path', icon: 'link', action: () => { navigator.clipboard.writeText(it.path); toast('Path copied', { timeout: 1200 }); } },
      { label: 'Compare with…', icon: 'diff', action: () => this.app.compareWith(it.path) },
      { label: 'Rename…', icon: 'edit', shortcut: 'F2', action: () => { const c = [...this.grid.children].find((x) => x.querySelector('.dump-name')?.textContent === (it.base || it.name)); if (!c || !renameInline(c)) this.rename(it); } },
      ...(this.sub ? [{ label: 'Move up a folder', icon: 'arrow-up', action: () => api.dumpMove([it.name], this.sub.split('/').slice(0, -1).join('/'), this.kind).then(() => this.refresh(true), errorToast) }] : []),
      { label: 'Show in Explorer', icon: 'external', action: () => api.dumpReveal(this.kind, it.name) },
      { sep: true },
      { label: 'Remove from dump', icon: 'trash', shortcut: 'Del', action: () => this.remove(it) },
    ];
    if (this.kind === 'doc') {
      const pdf = /\.pdf$/i.test(it.name);
      return [
        { label: 'Open in a new tab', icon: 'file-text', action: () => this.openPdf(it) },
        ...(pdf ? [{ label: 'Fill as a form', icon: 'form-fill', action: () => this.app.openPath(it.path, { mode: 'form' }) }] : []),
        ...(pdf && this.app.active?.editor?.insertImage ? [{ label: 'Insert first page as image', icon: 'image-plus', action: () => this.insertPdfPage(it) }] : []),
        { sep: true },
        ...common,
      ];
    }
    return [
      { label: 'Insert at cursor', icon: 'image-plus', action: () => this.insert(it) },
      { label: 'Copy image', icon: 'copy', action: () => this.copy(it) },
      { label: 'Open in the image viewer', icon: 'image', action: () => this.openInEditor(it) },
      { label: 'Open in the image editor', icon: 'brush', action: async () => this.app.openBytes(it.name, new Uint8Array(await (await fetch(it.url)).arrayBuffer()), { mode: 'paint' }) },
      { label: 'Read text (BoxScribe)', icon: 'scan-text', action: async () => { const { scribeBytes } = await import('../scribe.js'); scribeBytes(this.app, it.name, new Uint8Array(await (await fetch(it.url)).arrayBuffer())); } },
      { sep: true },
      ...common,
    ];
  }

  /** In the app window: a real OS file drag. In a browser: in-page drag plus Chrome's drag-to-desktop. */
  dragOut(e, it, img) {
    if (window.bdsShell?.startDrag) {
      e.preventDefault();
      window.bdsShell.startDrag(it.path);
      return;
    }
    if (this.kind === 'image') e.dataTransfer.setData(DUMP_MIME, it.url);
    e.dataTransfer.setData(PATHS_MIME, JSON.stringify([it.path]));
    const abs = location.origin + it.url;
    e.dataTransfer.setData('text/uri-list', abs);
    e.dataTransfer.setData('DownloadURL', `${/\.pdf$/i.test(it.name) ? 'application/pdf' : 'application/octet-stream'}:${it.name}:${abs}`);
    e.dataTransfer.effectAllowed = 'copy';
    if (img.complete && img.naturalWidth) e.dataTransfer.setDragImage(img, 20, 20);
  }

  openPdf(it) { this.app.openPath(it.path); }

  async insert(it) {
    if (!this.onInsert) return;
    try {
      const blob = await (await fetch(it.url)).blob();
      this.onInsert(await blobToDataURL(blob), it.name);
    } catch (e) { errorToast(e, 'Could not insert image'); }
  }

  async insertPdfPage(it) {
    const t = await pdfThumb(it);
    const ed = this.app.active?.editor;
    if (!t || !ed?.insertImage) return toast('Could not render that PDF.', { type: 'warn' });
    // re-render the first page at print quality for the document
    try {
      const pdfjs = await vendor.pdfjs();
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await (await fetch(it.url)).arrayBuffer()), isEvalSupported: false }).promise;
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 2 });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
      await doc.destroy();
      ed.insertImage(c.toDataURL('image/png'));
    } catch (e) { errorToast(e, 'Could not insert page'); }
  }

  async copy(it) {
    try {
      const blob = await (await fetch(it.url)).blob();
      let png = blob;
      if (blob.type !== 'image/png') {
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        png = await new Promise((r) => c.toBlob(r, 'image/png'));
      }
      if (window.bdsShell?.copyImage) {
        if (!(await window.bdsShell.copyImage(await blobToDataURL(png)))) throw new Error('Could not read that image');
      } else {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      }
      this.app.clips?.add({ type: 'image', name: it.name, url: it.url, path: it.path, source: this.cfg.label });
      toast(`Copied ${it.name}`, { type: 'ok', timeout: 1600 });
    } catch (e) { errorToast(e, 'Copy failed'); }
  }

  async copyFile(it) {
    try {
      await api.dumpClip(it.name, this.kind);
      this.app.clips?.add({ type: 'file', name: it.name, path: it.path, source: this.cfg.label });
      toast(`Copied ${it.name} — paste it into Explorer, Discord, an email…`, { type: 'ok', timeout: 2200 });
    } catch (e) { errorToast(e, 'Copy failed'); }
  }

  async rename(it, given) {
    const base = it.base || it.name;
    const name = given ?? await promptDialog(it.isDir ? 'Rename folder' : `Rename ${this.cfg.noun}`, 'New name', base, { selectBase: !it.isDir });
    if (!name || name === base) return;
    const to = it.isDir || extOf(name) ? name : `${name}.${extOf(base)}`;
    try { await api.dumpRename(it.name, to, this.kind); this.refresh(true); } catch (e) { errorToast(e); }
  }

  async remove(it) {
    try {
      await api.dumpRemove(it.name, this.kind);
      toast(`Moved ${it.base || it.name} to ${this.cfg.folder}\\.removed`, { timeout: 3500 });
      this.refresh(true);
    } catch (e) { errorToast(e); }
  }

  async openInEditor(it) {
    const bytes = new Uint8Array(await (await fetch(it.url)).arrayBuffer());
    this.app.openBytes(it.name, bytes, { mode: 'image' });
  }

  async addFiles(files, folder = this.sub, paths = []) {
    let n = 0;
    // files with a place on disk (app window, Shift+drag): copied by the server, or moved when they're already in the dump
    const left = [];
    for (const f of files) { const fp = window.bdsShell?.pathForFile?.(f); if (fp) paths.push(fp); else left.push(f); }
    files = left;
    let moved = 0;
    for (const fp of paths) {
      try { const r = await api.dumpImport(fp, this.kind, undefined, folder); if (r.moved) moved++; else if (!r.already) n++; } catch (e) { if (e.status !== 400) errorToast(e, basename(fp)); }
    }
    if (moved && !n && !files.length) { toast(`Moved ${moved} into ${folder || this.cfg.folder}`, { type: 'ok', timeout: 1800 }); this.refresh(true); return; }
    for (const f of files) {
      if (!this.accepts(f)) continue;
      const name = f.name && this.cfg.accept.test(f.name)
        ? f.name
        : `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${this.kind === 'doc' ? 'pdf' : (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`;
      try { await api.dumpAdd(folder ? `${folder}/${name}` : name, new Uint8Array(await f.arrayBuffer()), this.kind); n++; } catch (e) { errorToast(e, name); }
    }
    if (n || moved) { toast(`Added ${n} ${this.cfg.noun}${n === 1 ? '' : 's'} to the dump${moved ? `, moved ${moved}` : ''}`, { type: 'ok' }); this.refresh(true); }
    else if (files.length || paths.length) toast(`Only ${this.kind === 'doc' ? 'documents (PDF, Word, spreadsheets, text…)' : 'images'} go in the ${this.cfg.label}.`, { type: 'warn' });
  }

  async addFromDisk() {
    const paths = await pickOpen({ multi: true, title: `Add to the ${this.cfg.label}`, filters: this.cfg.filters });
    if (!paths) return;
    let n = 0;
    for (const p of paths) {
      try { const r = await api.dumpImport(p, this.kind, undefined, this.sub); if (!r.already) n++; } catch (e) { errorToast(e, basename(p)); }
    }
    if (n) { toast(`Added ${n} ${this.cfg.noun}${n > 1 ? 's' : ''}`, { type: 'ok' }); this.refresh(true); }
  }

  async saveDoc() {
    const t = toast('Making PDF…', { timeout: 0 });
    try {
      const { name, bytes } = await this.onSaveDoc();
      const r = await api.dumpAdd(name, bytes, 'doc');
      toast(`Saved ${r.name} to the doc dump`, { type: 'ok' });
      this.refresh(true);
    } catch (e) { errorToast(e, 'Could not save PDF'); } finally { t(); }
  }

  /** Save an image (data URL / URL) from a document into the media dump. */
  async stash(src, name = 'image') {
    try {
      const blob = await (await fetch(src)).blob();
      const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
      const fname = `${name.replace(/\.[^.]+$/, '')}-${Date.now().toString(36)}.${ext}`;
      await api.dumpAdd(fname, new Uint8Array(await blob.arrayBuffer()), 'image');
      toast('Saved to media dump', { type: 'ok' });
      if (!this.open) this.toggle(true); else this.refresh(true);
    } catch (e) { errorToast(e, 'Could not save image'); }
  }

  destroy() { clearInterval(this.timer); }
}

/** The bottom bar: the media dump and doc dump tabs side by side, one drawer open at a time. */
export class DumpDock {
  constructor({ app, onInsert, onSaveDoc }) {
    this.app = app;
    this.el = h('div', { class: 'dump' });
    this.image = new ImageDump({ app, kind: 'image', onInsert, dock: this });
    this.doc = new ImageDump({ app, kind: 'doc', onSaveDoc, dock: this });
    this.hint = h('div', { class: 'dump-hint faint' }, KINDS.image.hint);
    const grip = h('div', { class: 'dump-resize', title: 'Drag to resize' });
    this.drawers = h('div', { class: 'dump-drawers' }, grip, this.image.drawer, this.doc.drawer);
    this.drawers.style.setProperty('--dump-h', (app.settings.dumpHeight || 210) + 'px');
    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = this.drawers.offsetHeight;
      const move = (ev) => this.drawers.style.setProperty('--dump-h', Math.max(110, Math.min(innerHeight * 0.7, startH + (startY - ev.clientY))) + 'px');
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        app.saveSettings({ dumpHeight: this.drawers.offsetHeight });
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    this.el.append(this.drawers, h('div', { class: 'dump-bar' }, this.image.tabBtn, this.doc.tabBtn, this.hint));
    // remember which drawer was open (older versions stored a plain true/false for the media dump)
    let saved = app.settings.dumpPanel ?? (app.settings.dumpOpen === true ? 'image' : null);
    if (saved === 'pdf') saved = 'doc';
    this.show(saved === 'image' || saved === 'doc' ? saved : null, false);
  }

  get open() { return this.current || null; }
  get pdf() { return this.doc; } // older name

  show(kind, persist = true) {
    this.current = kind;
    this.image.setOpen(kind === 'image');
    this.doc.setOpen(kind === 'doc');
    this.drawers.hidden = !kind;
    this.el.classList.toggle('open', !!kind);
    this.hint.textContent = KINDS[kind || 'image'].hint;
    if (persist) this.app.saveSettings({ dumpPanel: kind, dumpOpen: kind === 'image' });
  }

  destroy() { this.image.destroy(); this.doc.destroy(); }
}
