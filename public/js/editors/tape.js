// BoxTape — paste a YouTube playlist (or any yt-dlp playlist / single video link), pick the tracks,
// and they're saved as MP3s (title, artist and cover art included) into the audio dump for the ♪ player.

import { BaseEditor } from './base.js';
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, errorToast } from '../core/ui.js';
import { api } from '../core/api.js';
import { fmtTime } from './video.js';

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`); return d; });
const get = (url) => fetch(url, { headers: { 'X-BDS-Token': api.token } }).then((r) => r.json());

export class TapeEditor extends BaseEditor {
  static mode = 'tape';

  async load() {
    this.tools = await get('/api/tools').catch(() => ({}));
    this.items = [];
    this.input = h('input', { type: 'url', class: 'klep-url', placeholder: 'paste a YouTube playlist link (or a single video / album link)…', spellcheck: 'false' });
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.fetch(); });
    this.goBtn = h('button', { class: 'btn primary klep-go', onclick: () => this.fetch() }, icon('music', 'sm'), 'Get tracks');
    this.results = h('div', { class: 'tape-results' });
    this.progress = h('div', { class: 'tape-progress' });
    const need = [!this.tools.ytdlp ? 'yt-dlp (winget install yt-dlp)' : null, !this.tools.ffmpeg ? 'ffmpeg (winget install Gyan.FFmpeg)' : null].filter(Boolean);
    this.pane.append(h('div', { class: 'klep-root' }, h('div', { class: 'klep-inner' },
      h('div', { class: 'klep-hero' },
        h('div', { class: 'klep-title' }, h('span', { class: 'g tape-g' }, 'BoxTape'), h('span', { class: 'klep-cursor' })),
        h('div', { class: 'klep-sub mono' }, '> playlist in, mp3s out — straight into the audio dump'),
        h('div', { class: 'klep-bar' }, this.input, this.goBtn),
        need.length
          ? h('div', { class: 'klep-note error' }, icon('info', 'sm'), `BoxTape needs ${need.join(' and ')}. Install, then restart Box-DocSpitter.`)
          : h('div', { class: 'faint', style: { fontSize: '11.5px' } }, 'Saves to Box-DocSpitter\\audio-dump with the song title, artist and cover art. Only download music you have the right to keep.')),
      this.progress,
      this.results)));
    setTimeout(() => this.input.focus(), 50);
  }

  async fetch() {
    const url = this.input.value.trim();
    if (!/^https?:\/\//i.test(url)) return toast('Paste a link that starts with https://', { type: 'warn' });
    this.goBtn.disabled = true;
    clear(this.results).append(h('div', { class: 'klep-loading' }, h('div', { class: 'spinner' }), h('span', { class: 'faint' }, 'reading the playlist… (big playlists take a few seconds)')));
    try {
      const res = await post('/api/klep/scan', { url, mode: 'ytdlp', playlist: 'on' });
      this.items = (res.items || []).filter((x) => x.url);
      this.title = res.title || '';
      this.render(res);
    } catch (e) {
      clear(this.results).append(h('div', { class: 'klep-note error' }, e.message));
    } finally {
      this.goBtn.disabled = false;
    }
  }

  render(res) {
    const R = clear(this.results);
    for (const n of res.notes || []) R.append(h('div', { class: 'klep-note' }, icon('info', 'sm'), n));
    if (!this.items.length) { R.append(h('div', { class: 'klep-note' }, 'No tracks found at that link.')); return; }
    const all = h('input', { type: 'checkbox', checked: true });
    const count = h('span', {});
    const goBtn = h('button', { class: 'btn primary', onclick: () => this.download() }, icon('download', 'sm'), h('span', {}));
    const update = () => {
      const n = this.boxes.filter((b) => b.checked).length;
      count.textContent = `${n} of ${this.items.length} selected`;
      goBtn.lastChild.textContent = n ? `Download ${n} as MP3` : 'Download as MP3';
      goBtn.disabled = !n;
      all.checked = n === this.items.length;
    };
    all.addEventListener('change', () => { for (const b of this.boxes) b.checked = all.checked; update(); });
    this.boxes = [];
    const list = h('div', { class: 'tape-list' });
    this.items.forEach((it, i) => {
      const cb = h('input', { type: 'checkbox', checked: true });
      cb.addEventListener('change', update);
      cb._item = it;
      this.boxes.push(cb);
      list.append(h('label', { class: 'tape-row' }, cb,
        h('span', { class: 'tape-n mono faint' }, String(i + 1)),
        h('span', { class: 'tape-title' }, it.title || it.url),
        h('span', { class: 'tape-meta mono faint' }, [it.uploader, it.duration ? fmtTime(it.duration, false) : null].filter(Boolean).join(' · '))));
    });
    this.lanes = h('select', { class: 'tape-lanes', title: 'How many tracks download at the same time' }, [1, 2, 3, 4, 5, 6].map((n) => h('option', { value: String(n) }, `${n} at a time`)));
    this.lanes.value = String(this.app.settings.tapeParallel || 3);
    this.lanes.addEventListener('change', () => this.app.saveSettings({ tapeParallel: Number(this.lanes.value) }));
    R.append(h('div', { class: 'klep-results-head' }, h('label', { class: 'check' }, all, count),
      this.title ? h('span', { class: 'faint klep-pagetitle' }, '· ' + this.title) : null, h('div', { class: 'grow' }), this.lanes, goBtn), list);
    update();
  }

  async download() {
    const picked = this.boxes.filter((b) => b.checked).map((b) => b._item);
    if (!picked.length) return;
    const bar = h('div', { class: 'vid-progress' }, h('div', { class: 'vid-progress-bar' }));
    const head = h('div', { class: 'tape-prog-head' }, h('b', {}, `Saving ${picked.length} track${picked.length > 1 ? 's' : ''} to the audio dump`), h('div', { class: 'grow' }));
    const counter = h('span', { class: 'mono faint', style: { fontSize: '11px' } });
    head.append(counter);
    const cancel = h('button', { class: 'btn sm ghost' }, 'Cancel');
    head.append(cancel);
    const rows = h('div', { class: 'tape-prog-rows' });
    clear(this.progress).append(h('div', { class: 'tape-prog' }, head, bar, rows));
    this.progress.scrollIntoView({ block: 'nearest' });
    try {
      const parallel = Number(this.lanes?.value) || this.app.settings.tapeParallel || 3;
      const { id } = await post('/api/audio/grab', { items: picked.map((it) => ({ url: it.url, type: 'ytdlp', title: it.title })), parallel });
      cancel.onclick = () => post('/api/job/cancel', { id });
      let refreshed = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const j = await get(`/api/job?id=${id}`);
        bar.firstChild.style.width = Math.round((j.progress || 0) * 100) + '%';
        const working = (j.tracks || []).filter((t) => t.status === 'working').length;
        counter.textContent = `${j.done || 0} done${j.failed ? ` · ${j.failed} failed` : ''}${working ? ` · ${working} downloading` : ''}`;
        clear(rows).append(...(j.tracks || []).map((t) => h('div', { class: `tape-prog-row ${t.status}` },
          h('span', { class: 'tape-state' }, { waiting: '·', working: '♪', done: '✓', failed: '✕', cancelled: '–' }[t.status] || '·'),
          h('span', { class: 'tape-title' }, t.title),
          h('span', { class: 'mono faint' }, t.status === 'working' ? `${Math.round((t.progress || 0) * 100)}%` : t.status === 'failed' ? (t.error || 'failed').slice(0, 80) : t.status))));
        // songs appear in the player as they finish
        if ((j.done || 0) > refreshed) { refreshed = j.done; this.app.music?.refresh(); }
        if (j.status !== 'running') {
          cancel.remove();
          const first = (j.tracks || []).find((t) => t.status === 'done');
          head.firstChild.textContent = j.status === 'done' ? `Done — ${j.done} saved${j.failed ? `, ${j.failed} failed` : ''}` : j.status === 'cancelled' ? `Stopped — ${j.done || 0} saved` : `Failed — ${j.error || ''}`;
          if (first) head.append(h('button', { class: 'btn sm primary', onclick: () => this.app.music?.playByName(first.name) }, icon('play', 'sm'), 'Play'), h('button', { class: 'btn sm', onclick: () => this.app.music?.open() }, icon('music', 'sm'), 'Open player'));
          if (j.status === 'done') toast(`BoxTape: ${j.done} song${j.done === 1 ? '' : 's'} in the audio dump`, { type: j.failed ? 'warn' : 'ok' });
          break;
        }
      }
    } catch (e) { errorToast(e, 'BoxTape'); }
  }

  status() { return { left: [{ text: 'BoxTape', icon: 'music' }, { text: 'saves to audio-dump' }], right: [{ text: this.tools?.ytdlp && this.tools?.ffmpeg ? 'yt-dlp + ffmpeg ready' : 'needs yt-dlp + ffmpeg' }] }; }
  saveFormats() { return []; }
}
