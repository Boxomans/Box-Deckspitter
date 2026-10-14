// BoxKlep — paste a page or video link, grep the videos out of it, pick what to download.

import { BaseEditor } from './base.js';
import { h, clear, formatBytes, basename, extOf } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, errorToast, contextMenu } from '../core/ui.js';
import { api } from '../core/api.js';
import { pickFolder } from '../core/files.js';
import { fmtTime } from './video.js';

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`); return d; });
const get = (url) => fetch(url, { headers: { 'X-BDS-Token': api.token } }).then((r) => r.json());

export class KlepEditor extends BaseEditor {
  static mode = 'klep';

  async load() {
    this.tools = await get('/api/tools').catch(() => ({}));
    this.dir = this.app.settings.klepDir || this.tools.downloads;
    this.items = [];
    this.jobs = [];
    this.buildDom();
  }

  buildDom() {
    this.input = h('input', { type: 'url', class: 'klep-url', placeholder: 'paste a page link or a direct video link…  (youtube, a blog post, an .mp4 …)', spellcheck: 'false' });
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.scan(); });
    this.modeSel = h('select', { class: 'klep-mode', title: 'How to look for videos' }, h('option', { value: 'auto' }, 'auto'), h('option', { value: 'page' }, 'page scan only'), h('option', { value: 'ytdlp' }, 'yt-dlp only'));
    this.goBtn = h('button', { class: 'btn primary klep-go', onclick: () => this.scan() }, icon('magnet', 'sm'), 'Grep');
    // links that are both a video and a playlist (watch?v=…&list=…): grab just the video or the whole playlist
    this.playlistMode = this.app.settings.klepPlaylist === 'on' ? 'on' : 'off';
    this.playlistSeg = h('div', { class: 'seg klep-plseg', hidden: true, 'data-tip': 'This link is part of a playlist' },
      ...[['off', 'This video'], ['on', 'Whole playlist']].map(([v, label]) => h('button', { class: this.playlistMode === v ? 'on' : '', dataset: { v }, onclick: () => {
        this.playlistMode = v;
        this.app.saveSettings({ klepPlaylist: v });
        for (const b of this.playlistSeg.children) b.classList.toggle('on', b.dataset.v === v);
      } }, label)));
    const syncPl = () => { this.playlistSeg.hidden = !/[?&]list=/.test(this.input.value); };
    this.input.addEventListener('input', syncPl);
    this.input.addEventListener('change', syncPl);
    this.dirChip = h('button', { class: 'chip', title: 'Change download folder', onclick: () => this.changeDir() }, icon('folder', 'sm'), h('span', {}, this.dir || 'Downloads'));
    this.toolsEl = h('div', { class: 'klep-tools' });
    this.history = h('div', { class: 'klep-history' });
    this.results = h('div', { class: 'klep-results' });
    this.downloads = h('div', { class: 'klep-downloads' });
    const hero = h('div', { class: 'klep-hero' },
      h('div', { class: 'klep-title' }, h('span', { class: 'g' }, this.app.toolLabel('BoxKlep')), h('span', { class: 'klep-cursor' })),
      h('div', { class: 'klep-sub mono' }, '> paste a link · it greps the videos out · you pick what to keep'),
      h('div', { class: 'klep-bar' }, this.input, this.playlistSeg, this.modeSel, this.goBtn),
      h('div', { class: 'klep-meta' }, h('span', { class: 'faint mono' }, 'save to'), this.dirChip,
        h('button', { class: 'icon-btn', 'data-tip': 'Open download folder', onclick: () => this.dir && api.reveal(this.dir + '\\.') }, icon('external', 'sm')),
        h('div', { class: 'grow' }), this.toolsEl),
      this.history);
    this.root = h('div', { class: 'klep-root' }, h('div', { class: 'klep-inner' }, hero, this.results, this.downloads,
      h('div', { class: 'klep-legal faint' }, 'Only download videos you have the right to save — your own uploads, public-domain or Creative Commons clips, or with permission. DRM-protected streams are skipped.')));
    this.pane.append(this.root);
    this.renderTools();
    this.renderHistory();
  }

  renderTools() {
    const t = this.tools || {};
    clear(this.toolsEl).append(
      h('span', { class: `klep-tool ${t.ytdlp ? 'ok' : 'off'}`, title: t.ytdlpPath || 'not installed' }, t.ytdlp ? '● yt-dlp' : '○ yt-dlp'),
      h('span', { class: `klep-tool ${t.ffmpeg ? 'ok' : 'off'}`, title: t.ffmpegPath || 'not installed (optional)' }, t.ffmpeg ? '● ffmpeg' : '○ ffmpeg'),
      h('button', { class: 'icon-btn', 'data-tip': 'Re-check tools', onclick: async () => { this.tools = await get('/api/tools'); this.renderTools(); toast(this.tools.ytdlp ? 'yt-dlp found' : 'yt-dlp still not found — restart Box-DocSpitter after installing', { timeout: 2500 }); } }, icon('refresh', 'sm')));
  }

  renderHistory() {
    const hist = this.app.settings.klepHistory || [];
    clear(this.history);
    for (const u of hist.slice(0, 6)) {
      let label = u;
      try { const x = new URL(u); label = x.hostname.replace(/^www\./, '') + x.pathname.slice(0, 28); } catch { /* ignore */ }
      this.history.append(h('button', { class: 'chip', title: u, onclick: () => { this.input.value = u; this.scan(); } }, label));
    }
  }

  async changeDir() {
    const d = await pickFolder({ title: 'Download videos to…', initialDir: this.dir });
    if (!d) return;
    this.dir = d;
    this.app.saveSettings({ klepDir: d });
    this.dirChip.lastChild.textContent = d;
  }

  // =================================================================== scanning

  /** From the browser's right-click menu: one video (auto: yt-dlp for video sites) or every video the page links/embeds. */
  grab(url, { all = false } = {}) {
    this.input.value = url;
    this.input.dispatchEvent(new Event('input'));
    const pl = /[?&]list=/.test(url);
    this.modeSel.value = all && !pl ? 'page' : 'auto'; // a playlist goes through yt-dlp as a whole
    if (pl) {
      this.playlistMode = all ? 'on' : 'off';
      for (const b of this.playlistSeg.children) b.classList.toggle('on', b.dataset.v === this.playlistMode);
    }
    return this.scan();
  }

  async scan() {
    const url = this.input.value.trim();
    if (!url) { this.input.focus(); return; }
    clear(this.results).append(h('div', { class: 'klep-loading' }, h('div', { class: 'spinner' }), h('span', { class: 'mono' }, 'grepping ', h('b', {}, url.slice(0, 80)), '…')));
    this.goBtn.disabled = true;
    try {
      const isPl = /[?&]list=/.test(url);
      const res = await post('/api/klep/scan', { url, mode: this.modeSel.value, playlist: isPl ? this.playlistMode : undefined });
      const hist = [url, ...(this.app.settings.klepHistory || []).filter((x) => x !== url)].slice(0, 12);
      this.app.saveSettings({ klepHistory: hist });
      this.renderHistory();
      this.lastPage = res;
      this.items = res.items || [];
      this.renderResults(res);
    } catch (e) {
      clear(this.results).append(h('div', { class: 'klep-note error' }, icon('alert', 'sm'), e.message));
    } finally {
      this.goBtn.disabled = false;
    }
  }

  renderResults(res) {
    const R = clear(this.results);
    if (res.needsYtDlp) R.append(this.ytdlpHelp(res));
    for (const n of res.notes || []) R.append(h('div', { class: 'klep-note' }, icon('info', 'sm'), n));
    if (!this.items.length) return;
    const allCb = h('input', { type: 'checkbox' });
    allCb.addEventListener('change', () => { this.results.querySelectorAll('.klep-card input[type=checkbox]').forEach((c) => { c.checked = allCb.checked; }); this.updateBulk(); });
    this.bulkBtn = h('button', { class: 'btn primary sm', onclick: () => this.downloadSelected(false) }, icon('download', 'sm'), 'Download selected');
    this.bulkTrimBtn = h('button', { class: 'btn sm', onclick: () => this.downloadSelected(true) }, icon('crop', 'sm'), '+ open in trimmer');
    this.bulkMp3Btn = h('button', { class: 'btn sm', 'data-tip': 'Save the selected videos as MP3s in the audio dump', onclick: () => this.mp3Selected() }, icon('music', 'sm'), '→ MP3');
    R.append(h('div', { class: 'klep-results-head' },
      h('label', { class: 'check' }, allCb, h('span', {}, `found ${this.items.length} ${this.items.length === 1 ? 'video' : 'videos'}${res.playlist ? ' in the playlist' : ''}`)),
      res.title ? h('span', { class: 'faint klep-pagetitle', title: res.page }, '· ' + res.title) : null,
      h('div', { class: 'grow' }), this.bulkMp3Btn, this.bulkTrimBtn, this.bulkBtn));
    const grid = h('div', { class: 'klep-grid' });
    for (const it of this.items) grid.append(this.card(it, res));
    R.append(grid);
    this.updateBulk();
  }

  ytdlpHelp() {
    const cmd = 'winget install yt-dlp';
    return h('div', { class: 'klep-help' },
      h('div', { class: 'klep-help-title' }, icon('info', 'sm'), 'This site needs yt-dlp'),
      h('div', {}, 'YouTube and most social sites don’t expose a plain video file. yt-dlp is the free, open-source tool that reads them — BoxKlep uses it automatically once it’s installed.'),
      h('div', { class: 'row' }, h('code', { class: 'klep-cmd' }, cmd),
        h('button', { class: 'btn sm', onclick: () => { navigator.clipboard.writeText(cmd); toast('Copied — paste it into a terminal', { type: 'ok' }); } }, icon('copy', 'sm'), 'Copy')),
      h('div', { class: 'faint' }, 'Optional, for best quality (merging HD video + audio): ', h('code', {}, 'winget install Gyan.FFmpeg'), '. Then restart Box-DocSpitter.'));
  }

  card(it, res) {
    const cb = h('input', { type: 'checkbox' });
    cb.addEventListener('change', () => this.updateBulk());
    cb._item = it;
    const ext = it.type === 'ytdlp' ? 'mp4' : (extOf(new URL(it.url).pathname) || (it.mime || '').split('/')[1] || 'mp4').replace('quicktime', 'mov').replace('mp2t', 'ts');
    const kind = it.type === 'ytdlp' ? (it.extractor || 'site') : it.type === 'hls' ? 'HLS stream' : ext.toUpperCase();
    const name = h('input', { type: 'text', class: 'klep-name', value: cleanName(it.title, it.type === 'ytdlp' ? '' : ext), spellcheck: 'false', title: 'File name' });
    const meta = h('div', { class: 'klep-cardmeta mono' });
    const metaParts = [kind, it.size ? formatBytes(it.size) : null, it.duration ? fmtTime(it.duration, false) : null, it.uploader].filter(Boolean);
    meta.textContent = metaParts.join(' · ');
    let preview;
    if (it.type === 'direct' && /^video\//.test(it.mime || 'video/')) {
      const src = `/api/klep/proxy?token=${encodeURIComponent(api.token)}&url=${encodeURIComponent(it.url)}${it.referer ? '&ref=' + encodeURIComponent(it.referer) : ''}`;
      preview = h('video', { class: 'klep-preview', src, preload: 'metadata', muted: true, controls: true, poster: res.poster || null });
      preview.addEventListener('loadedmetadata', () => {
        const extra = [preview.videoWidth ? `${preview.videoWidth}×${preview.videoHeight}` : null, Number.isFinite(preview.duration) ? fmtTime(preview.duration, false) : null].filter(Boolean);
        meta.textContent = [...metaParts, ...extra].join(' · ');
      });
    } else if (it.thumb || res.poster) {
      preview = h('div', { class: 'klep-preview klep-thumb' }, h('img', { src: `/api/klep/proxy?token=${encodeURIComponent(api.token)}&url=${encodeURIComponent(it.thumb || res.poster)}`, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }),
        it.duration ? h('span', { class: 'klep-dur mono' }, fmtTime(it.duration, false)) : null);
    } else {
      preview = h('div', { class: 'klep-preview klep-thumb klep-noprev' }, icon(it.type === 'hls' ? 'layers' : 'video', 'xl'), h('span', { class: 'mono faint' }, it.type === 'hls' ? 'stream — no preview' : 'no preview'));
    }
    let quality = null;
    if (it.options?.length) {
      quality = h('select', { class: 'klep-quality' }, it.options.map((o, i) => h('option', { value: String(i) }, o.label + (o.size ? ` · ${formatBytes(o.size)}` : ''))));
    }
    const card = h('div', { class: 'klep-card' },
      h('div', { class: 'klep-cardtop' }, cb, h('span', { class: 'klep-badge' }, kind), h('div', { class: 'grow' }),
        h('button', { class: 'icon-btn', 'data-tip': 'Copy link', onclick: () => { navigator.clipboard.writeText(it.url); toast('Link copied', { timeout: 1200 }); } }, icon('link', 'sm'))),
      preview, name, meta, quality,
      h('div', { class: 'klep-actions' },
        h('button', { class: 'btn sm primary', onclick: () => this.download(it, name.value, quality, false) }, icon('download', 'sm'), 'Download'),
        h('button', { class: 'btn sm', onclick: () => this.download(it, name.value, quality, true) }, icon('crop', 'sm'), 'Download + trim'),
        h('button', { class: 'btn sm', 'data-tip': 'Save as an MP3 straight into the audio dump (plays in the ♪ player)', onclick: () => this.toMp3([{ ...it, name: it.type === 'ytdlp' ? undefined : name.value.replace(/\.[a-z0-9]{2,5}$/i, '') }]) }, icon('music', 'sm'), 'MP3')));
    card.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Copy video link', icon: 'link', action: () => navigator.clipboard.writeText(it.url) },
      { label: 'Open link in browser', icon: 'external', action: () => window.open(it.url, '_blank', 'noopener') },
    ]));
    cb._name = name;
    cb._quality = quality;
    return card;
  }

  updateBulk() {
    const n = [...this.results.querySelectorAll('.klep-card input[type=checkbox]')].filter((c) => c.checked).length;
    if (this.bulkBtn) { this.bulkBtn.disabled = !n; this.bulkBtn.lastChild.textContent = n ? `Download ${n}` : 'Download selected'; }
    if (this.bulkTrimBtn) this.bulkTrimBtn.disabled = n !== 1;
    if (this.bulkMp3Btn) this.bulkMp3Btn.disabled = !n;
  }

  /** Several at once, but queued a few at a time (a 200-video playlist shouldn't start 200 downloads). */
  async downloadSelected(trim) {
    const boxes = [...this.results.querySelectorAll('.klep-card input[type=checkbox]')].filter((c) => c.checked);
    const lanes = Math.max(1, Math.min(6, this.app.settings.klepParallel || 3));
    if (boxes.length > lanes) toast(`Downloading ${boxes.length} videos, ${lanes} at a time`, { timeout: 2500 });
    let next = 0;
    const worker = async () => {
      while (next < boxes.length) {
        const cb = boxes[next++];
        await this.download(cb._item, cb._name.value, cb._quality, trim && boxes.length === 1);
      }
    };
    await Promise.all(Array.from({ length: Math.min(lanes, boxes.length) }, worker));
  }

  // =================================================================== downloading

  mp3Selected() {
    const boxes = [...this.results.querySelectorAll('.klep-card input[type=checkbox]')].filter((c) => c.checked);
    if (boxes.length) this.toMp3(boxes.map((cb) => ({ ...cb._item, name: cb._item.type === 'ytdlp' ? undefined : cb._name.value.replace(/\.[a-z0-9]{2,5}$/i, '') })));
  }

  /** Convert to MP3 into the audio dump (one job for the whole batch). */
  async toMp3(list) {
    if (!this.tools?.ffmpeg) return toast('Making MP3s needs ffmpeg: winget install Gyan.FFmpeg, then restart Box-DocSpitter.', { type: 'warn', timeout: 6000 });
    const label = list.length === 1 ? `♪ ${list[0].name || list[0].title || 'audio'}` : `♪ ${list.length} tracks → MP3`;
    const row = this.addJobRow(label);
    try {
      const { id } = await post('/api/audio/grab', { items: list.map((it) => ({ url: it.url, type: it.type, referer: it.referer || this.lastPage?.page, title: it.title, name: it.name })), parallel: this.app.settings.klepParallel || 3 });
      row.id = id;
      for (;;) {
        await new Promise((r) => setTimeout(r, 600));
        const j = await get(`/api/job?id=${id}`);
        row.updateAudio(j);
        if (j.status !== 'running') {
          if (j.status === 'done') {
            this.app.music?.refresh();
            const first = j.tracks?.find((t) => t.status === 'done');
            toast(j.failed ? `${j.done} saved to the audio dump · ${j.failed} failed` : `Saved ${j.done === 1 ? first?.name : j.done + ' songs'} to the audio dump`, { type: j.failed ? 'warn' : 'ok', action: first ? { label: 'Play', fn: () => this.app.music?.playByName(first.name) } : null });
          } else if (j.status === 'error') errorToast(new Error(j.error), 'MP3 failed');
          break;
        }
      }
    } catch (e) {
      row.update({ status: 'error', error: e.message });
      errorToast(e, 'MP3 failed');
    }
  }

  async download(it, name, qualitySel, trim) {
    const opt = it.options?.[Number(qualitySel?.value || 0)];
    const row = this.addJobRow(name || it.title);
    try {
      const { id } = await post('/api/klep/download', {
        url: it.url, type: it.type, selector: opt?.selector, dir: this.dir, name: it.type === 'ytdlp' ? undefined : name, referer: it.referer || this.lastPage?.page,
      });
      row.id = id;
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        const j = await get(`/api/job?id=${id}`);
        row.update(j);
        if (j.status !== 'running') {
          if (j.status === 'done') {
            toast(`Downloaded ${basename(j.path)}`, { type: 'ok', action: { label: 'Trim', fn: () => this.app.openPath(j.path, { mode: 'video' }) } });
            if (trim) this.app.openPath(j.path, { mode: 'video' });
          } else if (j.status === 'error') errorToast(new Error(j.error), 'Download failed');
          break;
        }
      }
    } catch (e) {
      row.update({ status: 'error', error: e.message });
      errorToast(e, 'Download failed');
    }
  }

  addJobRow(label) {
    if (!this.downloads.firstChild) this.downloads.append(h('div', { class: 'home-section-title' }, 'downloads'));
    const bar = h('div', { class: 'vid-progress' }, h('div', { class: 'vid-progress-bar' }));
    const info = h('span', { class: 'mono faint' }, 'starting…');
    const actions = h('div', { class: 'row' });
    const el = h('div', { class: 'klep-job' }, h('div', { class: 'klep-job-name' }, label), bar, info, actions);
    this.downloads.append(el);
    const row = {
      id: null,
      updateAudio: (j) => {
        bar.firstChild.style.width = Math.round((j.progress || 0) * 100) + '%';
        el.className = `klep-job ${j.status}`;
        const n = j.tracks?.length || 1;
        if (j.status === 'running') {
          const i = (j.tracks || []).findIndex((t) => t.status === 'working');
          info.textContent = `${n > 1 ? `track ${i + 1} of ${n} · ` : ''}${j.current || 'starting…'} · ${Math.round((j.progress || 0) * 100)}%`;
          clear(actions).append(h('button', { class: 'btn sm ghost', onclick: () => post('/api/job/cancel', { id: row.id }) }, 'Cancel'));
        } else if (j.status === 'done') {
          const ok = (j.tracks || []).filter((t) => t.status === 'done');
          info.textContent = `in the audio dump · ${ok.length === 1 ? ok[0].name : `${ok.length} songs`}${j.failed ? ` · ${j.failed} failed` : ''}`;
          clear(actions).append(...[
            ok[0] ? h('button', { class: 'btn sm', onclick: () => this.app.music?.playByName(ok[0].name) }, icon('play', 'sm'), 'Play') : null,
            h('button', { class: 'btn sm ghost', onclick: () => this.app.music?.open() }, icon('music', 'sm'), 'Player')].filter(Boolean));
        } else {
          info.textContent = j.status === 'cancelled' ? 'cancelled' : `failed — ${j.error || ''}`;
          clear(actions);
        }
      },
      update: (j) => {
        bar.firstChild.style.width = Math.round((j.progress || 0) * 100) + '%';
        el.className = `klep-job ${j.status}`;
        if (j.status === 'running') {
          clear(actions).append(h('button', { class: 'btn sm ghost', onclick: () => post('/api/job/cancel', { id: row.id }) }, 'Cancel'));
          info.textContent = `${j.total ? `${formatBytes(j.bytes)} of ${formatBytes(j.total)}` : formatBytes(j.bytes || 0)} · ${Math.round((j.progress || 0) * 100)}%`;
        } else if (j.status === 'done') {
          info.textContent = `done · ${basename(j.path || '')}`;
          clear(actions).append(
            h('button', { class: 'btn sm', onclick: () => this.app.openPath(j.path, { mode: 'video' }) }, icon('crop', 'sm'), 'Trim'),
            h('button', { class: 'btn sm ghost', onclick: () => api.reveal(j.path) }, icon('external', 'sm'), 'Show'));
        } else {
          info.textContent = j.status === 'cancelled' ? 'cancelled' : `failed — ${j.error || ''}`;
          clear(actions);
        }
      },
    };
    return row;
  }

  status() { return { left: [{ text: this.app.toolName('BoxKlep'), icon: 'magnet' }, { text: this.dir || '' }], right: [{ text: this.tools?.ytdlp ? 'yt-dlp ready' : 'direct links only' }] }; }
  saveFormats() { return []; }
  focus() { this.input?.focus(); }
  insertText(t) { this.input.focus(); document.execCommand('insertText', false, t); return true; }
}

function cleanName(title, ext) {
  let n = String(title || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'video';
  if (ext && !n.toLowerCase().endsWith('.' + ext)) n = n.replace(/\.(m3u8|php|aspx?)$/i, '') + (extOf(n) ? '' : '.' + ext);
  return n;
}
