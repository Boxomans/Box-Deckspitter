// BoxMend: drop broken videos in; each gets a quick look (what's wrong with it, in plain words), then Repair reads
// every frame and tries the lightest fix first (rewrap, then re-made frame by frame, then the sound on its own), all
// through the PC's ffmpeg (mend-server.js). The original stays as it is; repaired files go in the app's mend-dump folder.

import { BaseEditor } from './base.js';
import { h, clear, uid, basename, extOf, formatBytes } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { toast, contextMenu, draggedPaths } from '../core/ui.js';
import { pickOpen } from '../core/files.js';

const post = (url, json) => api.post(url, json);
const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp', 'mxf', 'vob', 'ogv', 'dv', 'insv', 'lrv'];
const clock = (s) => { s = Math.round(s || 0); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; return `${hh ? hh + ':' + String(mm).padStart(2, '0') : mm}:${String(ss).padStart(2, '0')}`; };
const HOW = { rewrapped: 'Rewrapped, nothing lost', remade: 'Re-made frame by frame', sound: 'Sound only', rebuilt: 'Rebuilt from a working video' };

export class MendEditor extends BaseEditor {
  static mode = 'mend';

  async load(bytes, opts = {}) {
    this.items = [];
    this.root = h('div', { class: 'convert-root' });
    this.pane.append(this.root);
    this.root.addEventListener('dragover', (e) => { e.preventDefault(); this.root.classList.add('drop'); });
    this.root.addEventListener('dragleave', (e) => { if (!this.root.contains(e.relatedTarget)) this.root.classList.remove('drop'); });
    this.root.addEventListener('drop', (e) => {
      e.preventDefault(); this.root.classList.remove('drop');
      const paths = draggedPaths(e);
      for (const f of e.dataTransfer.files) { const p = window.bdsShell?.pathForFile?.(f); if (p) paths.push(p); }
      this.add(paths);
    });
    this.ffmpeg = !!(await api.tools().catch(() => ({})))?.ffmpeg;
    this.render();
    if (opts.paths?.length) this.add(opts.paths);
  }

  add(paths) {
    for (const p of paths) {
      if (this.items.some((x) => x.path === p && x.status !== 'done')) continue;
      const x = { id: uid(), path: p, name: basename(p), ext: extOf(p), status: 'checking', progress: 0, step: '', info: null, problems: [], result: null, error: null, size: null };
      this.items.push(x);
      this.check(x);
      api.stat?.(p).then((s) => { x.size = s?.size ?? null; this.renderList(); }).catch(() => {});
    }
    this.renderList();
    this.refreshStatus();
  }

  /** The quick look: what it is, and what's wrong with it when it's opened. */
  async check(x) {
    if (!this.ffmpeg) { x.status = 'ready'; this.renderList(); return; }
    try {
      const r = await post('/api/mend/check', { path: x.path });
      x.info = r; x.problems = r.problems || [];
      // won't open at all: a repair would only say the same
      // no index: it can be rebuilt once a working video from the same camera or program is picked
      if (r.cant && x.problems.some((p) => p.id === 'index')) x.status = x.ref ? 'ready' : 'needref';
      else if (r.cant) { x.status = 'error'; x.error = r.cant; }
    } catch (e) { x.error = e.message; }
    if (x.status === 'checking') x.status = 'ready';
    this.renderList();
  }

  async addDialog() {
    const paths = await pickOpen({ multi: true, title: 'Broken videos to repair', filters: [{ name: 'Videos', extensions: VIDEO_EXTS }, { name: 'All files', extensions: ['*'] }] });
    if (paths?.length) this.add(paths);
  }

  // ---------------------------------------------------------------- the page
  render() {
    clear(this.root).append(
      h('div', { class: 'convert-main' },
        h('div', { class: 'convert-head' },
          h('div', {}, h('div', { class: 'todo-title' }, 'Repair videos'),
            h('div', { class: 'faint convert-sub' }, 'Videos that won’t play, won’t seek, stop early, or are full of glitches. Each is read frame by frame and the lightest fix that works is kept. The original stays as it is.')),
          h('div', { class: 'grow' }),
          h('button', { class: 'btn sm', onclick: () => this.addDialog() }, icon('plus', 'sm'), 'Add videos')),
        this.ffmpeg ? null : h('div', { class: 'mend-need' }, icon('alert', 'sm'), h('span', {}, 'BoxMend needs ffmpeg: run ', h('code', {}, 'winget install Gyan.FFmpeg'), ', then restart the app.')),
        this.list = h('div', { class: 'convert-list' }),
        this.foot = h('div', { class: 'convert-foot' })));
    this.renderList();
  }

  renderList() {
    if (!this.list) return;
    clear(this.list);
    if (!this.items.length) {
      this.list.append(h('button', { class: 'convert-drop', onclick: () => this.addDialog() },
        icon('mend'), h('div', { class: 'convert-drop-big' }, 'Drop broken videos here'),
        h('div', { class: 'faint' }, 'or click to choose them'),
        h('div', { class: 'convert-kinds' }, ['won’t open', 'can’t seek', 'stops early', 'glitches', 'sound out of step'].map((t) => h('span', {}, t)))));
    } else this.list.append(...this.items.map((x) => this.row(x)));
    this.renderFoot();
  }

  /** What ffmpeg found, one line each (or that it opened fine, before a repair has read it all). */
  findings(x) {
    if (x.status === 'checking') return h('div', { class: 'faint mend-finding' }, 'Looking at it…');
    const list = x.result?.problems || x.problems;
    if (!list.length) return h('div', { class: 'faint mend-finding' }, icon('check', 'sm'), x.result ? 'No damage found reading it through.' : 'It opens fine. Repair reads every frame to find damage inside.');
    return h('div', { class: 'mend-findings' }, list.map((p) => h('div', { class: 'mend-finding bad' }, icon('alert', 'sm'), h('span', {}, p.text))));
  }

  row(x) {
    const i = x.info;
    const meta = [i?.video ? `${i.video.width}×${i.video.height} ${i.video.codec}` : null, i?.audio ? `${i.audio.codec} sound` : null, i?.duration ? clock(i.duration) : null,
      x.ext ? x.ext.toUpperCase() : null, x.size != null ? formatBytes(x.size) : null].filter(Boolean).join(' · ');
    let state;
    if (x.status === 'working') state = h('div', { class: 'mend-state' }, h('div', { class: 'faint mend-step' }, `${x.step || 'Working'}…`), h('div', { class: 'convert-bar' }, h('div', { style: { width: `${Math.round(x.progress * 100)}%` } })));
    else if (x.status === 'done') state = h('div', { class: 'mend-state' },
      h('div', { class: 'convert-done' }, icon('check', 'sm'),
        h('button', { class: 'convert-link', title: x.result.path, onclick: () => this.app.openPath(x.result.path) }, basename(x.result.path)),
        h('button', { class: 'icon-btn', 'data-tip': 'Show in folder', onclick: () => api.reveal(x.result.path) }, icon('folder', 'sm'))),
      h('div', { class: 'faint mend-step' }, `${HOW[x.result.how] || 'Repaired'} · ${x.result.note || ''}`));
    else if (x.status === 'error') state = h('div', { class: 'convert-err mend-err', title: x.error }, icon('alert', 'sm'), h('span', {}, x.error));
    else if (x.status === 'needref' || (x.ref && x.status === 'ready')) state = h('div', { class: 'mend-state' },
      x.ref ? h('div', { class: 'faint mend-step', title: x.ref }, `Rebuilds with ${basename(x.ref)}`) : h('div', { class: 'faint mend-step' }, 'Needs a working video from the same camera or program (same settings)'),
      h('button', { class: 'btn sm', onclick: () => this.pickRef(x) }, icon('video', 'sm'), x.ref ? 'Pick another…' : 'Pick a working video…'));
    else if (x.error) state = h('div', { class: 'convert-err mend-err', title: x.error }, icon('alert', 'sm'), h('span', {}, x.error));
    else state = h('div', { class: 'faint convert-wait' }, x.status === 'checking' ? '' : 'Ready');
    const steps = x.result?.steps?.length && x.status !== 'working' ? h('details', { class: 'mend-steps' }, h('summary', { class: 'faint' }, 'What was tried'),
      x.result.steps.map((s) => h('div', { class: `mend-try ${s.ok || s.read ? 'ok' : ''}` }, s.read ? icon('search', 'sm mend-read') : icon(s.ok ? 'check' : 'x', 'sm'), h('span', {}, s.text)))) : null;
    const el = h('div', { class: `mend-row ${x.status}` },
      h('span', { class: 'convert-icon' }, icon('video', 'sm')),
      h('div', { class: 'mend-body' },
        h('div', { class: 'convert-file', title: x.path }, x.name),
        h('div', { class: 'faint mono convert-meta' }, meta || ' '),
        this.findings(x),
        steps),
      state,
      h('button', { class: 'icon-btn', 'data-tip': x.status === 'working' ? 'Stop' : 'Remove', onclick: () => this.remove(x) }, icon('x', 'sm')));
    el.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Show the original in its folder', icon: 'folder', action: () => api.reveal(x.path) },
      x.result?.path ? { label: 'Open the repaired video', icon: 'play', action: () => this.app.openPath(x.result.path) } : null,
      x.status === 'done' || x.status === 'error' ? { label: 'Try again', icon: 'refresh', action: () => { x.status = x.problems?.some((p) => p.id === 'index') && !x.ref ? 'needref' : 'ready'; x.result = null; x.error = null; this.renderList(); } } : null,
      x.status === 'needref' || x.ref ? { label: 'Pick a working video…', icon: 'video', action: () => this.pickRef(x) } : null,
      { label: 'Remove from the list', icon: 'x', action: () => this.remove(x) },
    ].filter(Boolean)));
    return el;
  }

  renderFoot() {
    if (!this.foot) return;
    const waiting = this.items.filter((x) => x.status === 'ready');
    clear(this.foot).append(
      h('div', { class: 'convert-where' },
        h('span', { class: 'faint' }, 'Saved to'),
        h('button', { class: 'btn sm ghost', title: 'The mend-dump folder in the app’s folder', onclick: () => post('/api/mend/folder', { open: true }).catch(() => {}) },
          icon('folder', 'sm'), h('span', { class: 'convert-where-name' }, 'mend-dump'))),
      h('div', { class: 'grow' }),
      this.items.some((x) => x.status === 'done' || x.status === 'error') ? h('button', { class: 'btn sm ghost', onclick: () => { this.items = this.items.filter((x) => x.status !== 'done' && x.status !== 'error'); this.renderList(); this.refreshStatus(); } }, 'Clear finished') : null,
      h('button', { class: 'btn primary', disabled: !waiting.length || this.running || !this.ffmpeg, onclick: () => this.run() },
        icon('mend', 'sm'), this.running ? 'Repairing…' : `Repair${waiting.length > 1 ? ` ${waiting.length} videos` : ''}`));
  }

  remove(x) {
    if (x.status === 'working') { x.stop = true; if (x.job) post('/api/job/cancel', { id: x.job }).catch(() => {}); return; }
    this.items.splice(this.items.indexOf(x), 1);
    this.renderList(); this.refreshStatus();
  }

  // ---------------------------------------------------------------- repairing
  async run() {
    if (this.running) return;
    this.running = true;
    this.renderFoot();
    let ok = 0, bad = 0;
    for (const x of this.items.filter((i) => i.status === 'ready')) {
      if (this.destroyed) break;
      x.status = 'working'; x.progress = 0; x.step = ''; x.error = null; x.result = null; x.stop = false;
      this.renderList();
      try {
        x.result = await this.repair(x);
        x.status = 'done'; ok++;
      } catch (e) {
        x.status = 'error'; x.error = x.stop ? 'Stopped' : (e.message || String(e)); bad++;
      }
      this.renderList(); this.refreshStatus();
    }
    this.running = false;
    this.renderFoot();
    if (ok + bad > 1 || bad) toast(bad ? `Repaired ${ok}, ${bad} couldn’t be saved.` : `Repaired ${ok} videos.`, { type: bad ? 'warn' : 'ok' });
  }

  /** A recording with no index: the working video its index is rebuilt from. */
  async pickRef(x) {
    const dir = x.path.replace(/[\\/][^\\/]*$/, '');
    const paths = await pickOpen({ title: 'A working video from the same camera or program', initialDir: dir, filters: [{ name: 'Videos', extensions: VIDEO_EXTS }, { name: 'All files', extensions: ['*'] }] });
    if (!paths?.length) return;
    if (paths[0] === x.path) { toast('Pick a different video, one that plays.', { type: 'warn' }); return; }
    x.ref = paths[0]; x.status = 'ready'; x.error = null; x.result = null;
    this.renderList(); this.renderFoot();
  }

  async repair(x) {
    const r = await post('/api/mend/repair', { path: x.path, ref: x.ref || undefined });
    x.job = r.id;
    for (;;) {
      await new Promise((res) => setTimeout(res, 400));
      const j = await api.get(`/api/job?id=${encodeURIComponent(r.id)}`);
      if (j.result) x.result = j.result;
      if (j.status === 'done') return j.result;
      if (j.status === 'error' || j.status === 'cancelled') throw new Error(j.status === 'cancelled' ? 'Stopped' : j.error || 'Couldn’t repair it.');
      if (Math.abs((j.progress || 0) - x.progress) > 0.01 || j.step !== x.step) { x.progress = j.progress || 0; x.step = j.step; this.renderList(); }
    }
  }

  status() {
    if (!this.items) return { left: [], right: [] };
    const done = this.items.filter((x) => x.status === 'done').length;
    return { left: [{ text: this.items.length ? `${this.items.length} video${this.items.length === 1 ? '' : 's'}` : 'Drop videos to repair' }], right: done ? [{ text: `${done} repaired` }] : [] };
  }

  destroy() {
    this.destroyed = true;
    for (const x of this.items || []) if (x.job && x.status === 'working') post('/api/job/cancel', { id: x.job }).catch(() => {});
  }
}
