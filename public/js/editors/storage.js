// StoragePeek — drive usage at a glance, then scan a drive or folder to see what's eating space.

import { BaseEditor } from './base.js';
import { h, clear, formatBytes, basename, dirname } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { contextMenu, toast, errorToast } from '../core/ui.js';
import { api } from '../core/api.js';
import { pickFolder } from '../core/files.js';

const req = (method, url, body) => fetch(url, { method, headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`); return d; });

const CAT_COLOR = { dir: '#7c5cc4', video: '#d6439a', image: '#2bb3a8', audio: '#e0884a', archive: '#c9a227', game: '#e05a7a', document: '#5b8def', code: '#8bc34a', app: '#8d7fa8', other: '#6e6483', loose: '#3b3350', system: '#5a4a7a', hidden: '#8a2f5c', pending: 'transparent' };
const CAT_LABEL = { video: 'Video', image: 'Images', audio: 'Audio', archive: 'Archives & disk images', game: 'Game data', document: 'Documents', code: 'Code', app: 'Apps & data', other: 'Other' };

export class StorageEditor extends BaseEditor {
  static mode = 'storage';

  async load() {
    this.drivesEl = h('div', { class: 'sp-drives' });
    this.scanEl = h('div', { class: 'sp-scan' });
    this.root = h('div', { class: 'sp-root' }, h('div', { class: 'sp-inner' },
      h('div', { class: 'sp-head' },
        h('div', { class: 'klep-title' }, h('span', { class: 'g sp-g' }, this.app.toolLabel('StoragePeek')), h('span', { class: 'klep-cursor' })),
        h('div', { class: 'klep-sub mono' }, '> where did all the space go'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => this.loadDrives() }, icon('refresh', 'sm'), 'Refresh drives'),
          h('button', { class: 'btn', onclick: () => this.scanFolder() }, icon('folder-open', 'sm'), 'Scan a folder…'))),
      this.drivesEl, this.scanEl));
    this.pane.append(this.root);
    await this.loadDrives();
  }

  async loadDrives() {
    clear(this.drivesEl).append(h('div', { class: 'klep-loading' }, h('div', { class: 'spinner' })));
    let list = [];
    try { list = await req('GET', '/api/drives'); } catch (e) { errorToast(e); }
    clear(this.drivesEl);
    for (const d of list) {
      const pct = d.total ? d.used / d.total : 0;
      const card = h('div', { class: `sp-drive ${pct > 0.9 ? 'full' : pct > 0.75 ? 'warm' : ''}` },
        h('div', { class: 'sp-drive-top' }, icon('disk', 'lg'),
          h('div', { class: 'sp-drive-name' }, h('b', {}, d.path.replace(/\\$/, '')), h('span', {}, d.label || (d.kind === 'local' ? 'Local disk' : d.kind))),
          h('div', { class: 'grow' }), h('span', { class: 'sp-pct mono' }, Math.round(pct * 100) + '%')),
        h('div', { class: 'sp-bar' }, h('div', { class: 'sp-bar-fill', style: { width: pct * 100 + '%' } })),
        h('div', { class: 'sp-drive-meta mono' }, `${formatBytes(d.used)} used · ${formatBytes(d.free)} free · ${formatBytes(d.total)}${d.fs ? ' · ' + d.fs : ''}`),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm primary', onclick: () => this.scan(d.path) }, icon('search', 'sm'), 'Scan'),
          h('button', { class: 'btn sm ghost', onclick: () => api.reveal(d.path) }, icon('external', 'sm'), 'Open')));
      this.drivesEl.append(card);
    }
    this.drives = list;
    this.refreshStatus();
  }

  async scanFolder() {
    const p = await pickFolder({ title: 'Scan which folder?' });
    if (p) this.scan(p);
  }

  async scan(root, { elevated = false } = {}) {
    if (this.scanJob) await req('POST', '/api/job/cancel', { id: this.scanJob }).catch(() => {});
    const token = (this.scanToken = {});
    this.scanRoot = root;
    this.curPath = root;
    this.scanId = null;
    const bar = h('div', { class: 'vid-progress' }, h('div', { class: 'vid-progress-bar' }));
    const stats = h('div', { class: 'mono sp-scanstats' }, elevated ? 'waiting for the admin prompt…' : 'starting…');
    const current = h('div', { class: 'mono faint sp-current' });
    const title = h('b', {}, `${elevated ? 'Admin scan of' : 'Scanning'} ${root}`);
    const spin = h('div', { class: 'spinner' });
    const actions = h('div', { class: 'row' },
      h('button', { class: 'btn sm ghost', onclick: () => req('POST', '/api/job/cancel', { id: this.scanJob }) }, 'Cancel'));
    this.headEl = h('div', { class: 'sp-scanning' }, h('div', { class: 'row' }, spin, title, h('div', { class: 'grow' }), actions), bar, stats, current);
    this.viewEl = h('div', { class: 'sp-view' });
    clear(this.scanEl).append(this.headEl, this.viewEl);
    this.headEl.scrollIntoView({ block: 'nearest' });
    try {
      const { id } = await req('POST', '/api/storage/scan', { path: root, elevated });
      this.scanJob = id;
      this.scanId = id;
      let lastView = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, 300));
        if (token !== this.scanToken) return;
        const j = await req('GET', `/api/job?id=${id}`);
        bar.firstChild.style.width = (j.total ? Math.round(j.progress * 100) : 100) + '%';
        bar.classList.toggle('indeterminate', !j.total && j.status === 'running');
        const secs = ((Date.now() - j.started) / 1000).toFixed(1);
        stats.textContent = `${(j.files || 0).toLocaleString()} files · ${(j.dirs || 0).toLocaleString()} folders · ${formatBytes(j.bytes || 0)}${j.total ? ' of ~' + formatBytes(j.total) + ' used' : ''} · ${secs}s`;
        current.textContent = j.current || '';
        const running = j.status === 'running';
        if (running && j.dirs && Date.now() - lastView > 900) { lastView = Date.now(); await this.show(this.curPath, { quiet: true }); }
        if (running) continue;
        spin.remove();
        if (j.status === 'done') {
          bar.remove();
          current.remove();
          title.textContent = `${root}`;
          const took = (j.elapsed || Date.now() - j.started) / 1000;
          stats.textContent = `${(j.files || 0).toLocaleString()} files · ${(j.dirs || 0).toLocaleString()} folders · ${formatBytes(j.bytes || 0)} on disk · scanned in ${took < 10 ? took.toFixed(1) : Math.round(took)}s${j.engine === 'node' ? ' (portable mode)' : ''}${j.admin ? ' · admin' : ''}`;
          clear(actions).append(
            h('button', { class: 'btn sm', onclick: () => this.scan(root) }, icon('refresh', 'sm'), 'Rescan'),
            !j.admin && this.app.info?.platform === 'win32'
              ? h('button', { class: 'btn sm primary', 'data-tip': 'Windows will ask for permission. Reads protected folders and system files too.', onclick: () => this.scan(root, { elevated: true }) }, icon('lock', 'sm'), 'Rescan as admin')
              : null);
          await this.show(this.curPath);
        } else {
          clear(actions).append(h('button', { class: 'btn sm', onclick: () => this.scan(root, { elevated }) }, icon('refresh', 'sm'), 'Try again'));
          stats.textContent = j.status === 'cancelled' ? 'Scan cancelled.' : j.error || 'Scan failed';
          stats.classList.toggle('error', j.status !== 'cancelled');
          if (this.view) await this.show(this.curPath, { quiet: true }); // keep whatever was found
        }
        break;
      }
    } catch (e) {
      stats.textContent = e.message;
      stats.classList.add('error');
      spin.remove();
    }
  }

  async show(p, { quiet = false } = {}) {
    if (!this.scanId) return;
    let v;
    try { v = await req('GET', `/api/storage/view?id=${this.scanId}&path=${encodeURIComponent(p)}`); } catch (e) { if (!quiet) errorToast(e); return; }
    this.view = v;
    this.curPath = v.path;
    const S = clear(this.viewEl);
    const items = [
      ...v.kids.filter((k) => k.size > 0).map((k) => ({ ...k, cat: 'dir' })),
      ...v.files.map((f) => ({ ...f })),
      ...(v.looseFiles > 0 ? [{ name: 'smaller files here', size: v.looseFiles, cat: 'loose', isDir: false }] : []),
      ...v.extra.map((x) => ({ ...x, isDir: false, virtual: true })),
    ].sort((a, b) => b.size - a.size);
    // boxes you've hidden stay out of the map (it lays out the rest) but are still listed, greyed, in "Biggest here"
    for (const it of items) it.off = this.isHidden(it);
    const shown = items.filter((it) => !it.off);
    const nOff = items.length - shown.length;

    // breadcrumb
    const crumbs = h('div', { class: 'sp-crumbs mono' });
    const rel = v.path.slice(v.root.length).split('\\').filter(Boolean);
    let acc = v.root;
    crumbs.append(h('button', { class: 'chip', onclick: () => this.show(v.root) }, v.root.replace(/\\$/, '') || v.root));
    for (const part of rel) {
      acc = acc.replace(/\\$/, '') + '\\' + part;
      const target = acc;
      crumbs.append(h('span', { class: 'faint' }, '›'), h('button', { class: 'chip', onclick: () => this.show(target) }, part));
    }
    const up = v.path !== v.root ? h('button', { class: 'icon-btn', 'data-tip': 'Up', onclick: () => this.show(dirname(v.path)) }, icon('arrow-up', 'sm')) : null;
    S.append(h('div', { class: 'sp-viewhead' }, up, crumbs, h('div', { class: 'grow' }),
      v.running ? h('span', { class: 'chip live' }, 'live') : null,
      nOff ? h('button', { class: 'chip', 'data-tip': 'Hidden from the map. They’re greyed out in “Biggest here”: right-click one to show it again.', onclick: () => { this.sideTab = 'here'; this.show(v.path); } }, icon('eye-off', 'sm'), `${nOff} hidden`) : null,
      h('span', { class: 'mono' }, formatBytes(v.size)), h('span', { class: 'faint mono' }, ` · ${v.count.toLocaleString()} files`)));


    const map = h('div', { class: 'sp-treemap' });
    const list = h('div', { class: 'sp-list' });
    const side = h('div', { class: 'sp-side' });
    S.append(h('div', { class: 'sp-body' }, map, side));
    side.append(h('div', { class: 'sp-tabs' },
      ...[['here', 'Biggest here'], ['files', 'Biggest files'], ['types', 'By type']].map(([k, label]) => {
        const b = h('button', { class: (this.sideTab || 'here') === k ? 'on' : '' }, label);
        b.addEventListener('click', () => { this.sideTab = k; this.show(v.path); });
        return b;
      })), list);
    this.mapItems = { el: map, items: shown, total: v.size };
    this.resizeObs?.disconnect();
    this.resizeObs = new ResizeObserver(() => this.drawTreemap(map, shown, v.size));
    this.resizeObs.observe(map);
    this.drawTreemap(map, shown, v.size);

    const tab = this.sideTab || 'here';
    if (tab === 'here') {
      for (const it of items.slice(0, 80)) list.append(this.row(it, v.size));
    } else if (tab === 'files') {
      for (const f of v.bigFiles.slice(0, 100)) { const it = { name: basename(f.path), path: f.path, size: f.size, isDir: false, detail: dirname(f.path) }; it.off = this.isHidden(it); list.append(this.row(it, v.bigFiles[0]?.size || 1)); }
    } else if (v.running) {
      list.append(h('div', { class: 'empty-note' }, 'The type breakdown appears when the scan finishes.'));
    } else {
      const total = Object.values(v.byType).reduce((a, b) => a + b, 0) || 1;
      for (const [cat, size] of Object.entries(v.byType).sort((a, b) => b[1] - a[1])) {
        list.append(h('div', { class: 'sp-row' },
          h('span', { class: 'sp-swatch', style: { background: CAT_COLOR[cat] } }),
          h('span', { class: 'sp-row-name' }, CAT_LABEL[cat] || cat),
          h('span', { class: 'sp-row-size mono' }, formatBytes(size)),
          h('div', { class: 'sp-row-bar' }, h('div', { style: { width: (size / total) * 100 + '%', background: CAT_COLOR[cat] } }))));
      }
      if (v.byExt?.length) {
        list.append(h('div', { class: 'sp-subhead mono faint' }, 'top extensions'));
        const max = v.byExt[0].size || 1;
        for (const x of v.byExt) {
          list.append(h('div', { class: 'sp-row' },
            h('span', { class: 'sp-swatch', style: { background: CAT_COLOR[x.cat] } }),
            h('span', { class: 'sp-row-name mono' }, x.ext ? '.' + x.ext : '(no extension)'),
            h('span', { class: 'sp-row-size mono' }, formatBytes(x.size)),
            h('div', { class: 'sp-row-bar' }, h('div', { style: { width: (x.size / max) * 100 + '%', background: CAT_COLOR[x.cat] } }))));
        }
      }
    }
    this.refreshStatus();
  }

  row(it, max) {
    const r = h('button', { class: `sp-row${it.off ? ' sp-off' : ''}`, title: (it.path || '') + (it.off ? '\nHidden from the map: right-click to show it again' : '') },
      h('span', { class: 'sp-swatch', style: { background: CAT_COLOR[it.isDir ? 'dir' : it.cat || 'other'] } }),
      h('span', { class: 'sp-row-name' }, it.off ? icon('eye-off', 'sm') : null, it.name, it.detail ? h('span', { class: 'faint' }, '  ' + it.detail) : null),
      h('span', { class: 'sp-row-size mono' }, formatBytes(it.size)),
      h('div', { class: 'sp-row-bar' }, h('div', { style: { width: Math.max(1, (it.size / max) * 100) + '%' } })));
    r.addEventListener('click', () => { if (it.isDir) this.show(it.path); else if (it.path) api.reveal(it.path); else if (it.cat === 'hidden') this.explainHidden(); });
    r.addEventListener('contextmenu', (e) => contextMenu(e, this.itemMenu(it)));
    return r;
  }

  explainHidden() {
    toast('Space Windows reports as used but a normal scan can’t open: System Volume Information (restore points and shadow copies), other users’ folders, WindowsApps and similar. “Rescan as admin” reads those too.', { timeout: 9000 });
  }

  itemMenu(it) {
    if (it.cat === 'hidden') return [{ label: 'What is this?', icon: 'info', action: () => this.explainHidden() }, { label: 'Rescan as admin', icon: 'lock', action: () => this.scan(this.scanRoot, { elevated: true }) }];
    if (it.virtual) return [{ label: it.cat === 'pending' ? 'Still being scanned' : 'Filesystem metadata', disabled: true }];
    if (!it.path) return [{ label: 'Files smaller than 1 MB in this folder', disabled: true }];
    return [
      ...(it.isDir ? [{ label: 'Drill in', icon: 'arrow-down', action: () => this.show(it.path) }, { label: 'Open as BoxSpace', icon: 'spaces', action: () => this.app.openSpace(it.path) }] : [{ label: 'Open', icon: 'file', action: () => this.app.openPath(it.path) }]),
      { label: 'Show in Explorer', icon: 'external', action: () => api.reveal(it.path) },
      { label: 'Copy path', icon: 'copy', action: () => { navigator.clipboard.writeText(it.path); toast('Copied', { timeout: 1200 }); } },
      { sep: true },
      it.off
        ? { label: 'Show in storage view', icon: 'eye', action: () => this.setHidden(it, false) }
        : { label: 'Hide from storage view', icon: 'eye-off', action: () => this.setHidden(it, true) },
    ];
  }

  /** Paths hidden from the map, kept in settings so they stay hidden in later scans. */
  hiddenPaths() { return new Set((this.app.settings.storageHidden || []).map((p) => p.toLowerCase())); }
  isHidden(it) { return !!it.path && this.hiddenPaths().has(it.path.toLowerCase()); }
  setHidden(it, on) {
    const keep = (this.app.settings.storageHidden || []).filter((p) => p.toLowerCase() !== it.path.toLowerCase());
    if (on) keep.push(it.path);
    this.app.saveSettings({ storageHidden: keep });
    if (on) toast(`Hid ${it.name}. It’s still in “Biggest here”, greyed out: right-click it there to show it again.`, { timeout: 4500 });
    this.show(this.curPath, { quiet: true });
  }

  drawTreemap(el, items, total) {
    clear(el);
    const W = el.clientWidth;
    const H = el.clientHeight;
    if (!W || !H || !items.length) return;
    const rects = squarify(items.filter((i) => i.size > 0).slice(0, 220).map((i) => ({ ...i, value: i.size })), 0, 0, W, H);
    for (const r of rects) {
      const it = r.item;
      const big = r.w > 70 && r.h > 34;
      const box = h('div', {
        class: `sp-tile ${it.isDir ? 'dir' : ''} ${it.virtual ? 'virtual ' + it.cat : ''}`,
        style: { left: r.x + 'px', top: r.y + 'px', width: Math.max(0, r.w - 2) + 'px', height: Math.max(0, r.h - 2) + 'px', background: CAT_COLOR[it.isDir ? 'dir' : it.cat || 'other'] },
        title: `${it.name}\n${formatBytes(it.size)} · ${((it.size / total) * 100).toFixed(1)}%`,
      }, big ? h('div', { class: 'sp-tile-label' }, h('b', {}, it.name), h('span', {}, formatBytes(it.size))) : null);
      box.addEventListener('click', () => { if (it.isDir) this.show(it.path); else if (it.cat === 'hidden') this.explainHidden(); });
      box.addEventListener('contextmenu', (e) => contextMenu(e, this.itemMenu(it)));
      el.append(box);
    }
  }

  status() {
    const v = this.view;
    return { left: [{ text: this.app.toolName('StoragePeek'), icon: 'layers' }, ...(v ? [{ text: `${v.path} · ${formatBytes(v.size)}` }] : [])], right: [{ text: `${this.drives?.length || 0} drives` }] };
  }

  saveFormats() { return []; }
  destroy() { this.scanToken = null; this.resizeObs?.disconnect(); if (this.scanJob) req('POST', '/api/job/cancel', { id: this.scanJob }).catch(() => {}); }
}

/** Squarified treemap layout (Bruls et al.). items must be sorted descending by value. */
function squarify(items, x, y, w, hgt) {
  const out = [];
  const total = items.reduce((a, b) => a + b.value, 0);
  if (!total) return out;
  const scale = (w * hgt) / total;
  const nodes = items.map((it) => ({ item: it, area: it.value * scale }));
  let rect = { x, y, w, h: hgt };
  let row = [];
  const worst = (r, side) => {
    const s = r.reduce((a, b) => a + b.area, 0);
    let max = -Infinity, min = Infinity;
    for (const n of r) { max = Math.max(max, n.area); min = Math.min(min, n.area); }
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const layoutRow = (r) => {
    const s = r.reduce((a, b) => a + b.area, 0);
    if (rect.w >= rect.h) {
      const colW = s / rect.h;
      let yy = rect.y;
      for (const n of r) { const hh = n.area / colW; out.push({ item: n.item, x: rect.x, y: yy, w: colW, h: hh }); yy += hh; }
      rect = { x: rect.x + colW, y: rect.y, w: rect.w - colW, h: rect.h };
    } else {
      const rowH = s / rect.w;
      let xx = rect.x;
      for (const n of r) { const ww = n.area / rowH; out.push({ item: n.item, x: xx, y: rect.y, w: ww, h: rowH }); xx += ww; }
      rect = { x: rect.x, y: rect.y + rowH, w: rect.w, h: rect.h - rowH };
    }
  };
  for (const n of nodes) {
    const side = Math.min(rect.w, rect.h);
    if (!row.length || worst([...row, n], side) <= worst(row, side)) row.push(n);
    else { layoutRow(row); row = [n]; }
  }
  if (row.length) layoutRow(row);
  return out;
}
