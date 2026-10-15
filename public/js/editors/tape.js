// BoxTape — paste a YouTube playlist (or any yt-dlp playlist / single video link), pick the tracks,
// and they're saved as MP3s (title, artist and cover art included) into the audio dump for the ♪ player.
// Spotify playlist / album / song links work too: each song is matched to the same recording on YouTube.

import { BaseEditor } from './base.js';
import { h, clear, stripExt } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, errorToast, modal, promptDialog } from '../core/ui.js';
import { api } from '../core/api.js';
import { fmtTime } from './video.js';

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`); return d; });
const get = (url) => fetch(url, { headers: { 'X-BDS-Token': api.token } }).then((r) => r.json());

// same idea as the music player's duplicate check: "Artist - Song (Official Video) (1)" ≈ "artist song"
// (NFKC first: yt-dlp's Windows-safe file names turn : ? | " into their full-width look-alikes, ： ？ ｜ ＂)
function songKey(s) {
  return String(s).normalize('NFKC').toLowerCase()
    .replace(/[([](?:official(?: music)?(?: video| audio| visualizer| lyric video)?|music video|lyric video|lyrics?|audio|video|visualizer|hd|hq|4k|explicit|clean)[)\]]/gi, ' ')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/[^a-z0-9\u00c0-\uffff]+/g, ' ')
    .trim();
}

export class TapeEditor extends BaseEditor {
  static mode = 'tape';

  async load() {
    this.tools = await get('/api/tools').catch(() => ({}));
    this.items = [];
    this.input = h('input', { type: 'text', class: 'klep-url', placeholder: 'search for a song, paste a list of songs, or a YouTube / Spotify link…', spellcheck: 'false' });
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.fetch(); });
    // pasting several lines (a list of songs) keeps them apart: one line becomes one ";"-separated entry
    this.input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') || '';
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) return;
      e.preventDefault();
      this.input.value = lines.join(' ; ');
    });
    this.goBtn = h('button', { class: 'btn primary klep-go', onclick: () => this.fetch() }, icon('music', 'sm'), 'Get tracks');
    this.results = h('div', { class: 'tape-results' });
    this.progress = h('div', { class: 'tape-progress' });
    const need = [!this.tools.ytdlp ? 'yt-dlp (winget install yt-dlp)' : null, !this.tools.ffmpeg ? 'ffmpeg (winget install Gyan.FFmpeg)' : null].filter(Boolean);
    this.pane.append(h('div', { class: 'klep-root' }, h('div', { class: 'klep-inner' },
      h('div', { class: 'klep-hero' },
        h('div', { class: 'klep-title' }, h('span', { class: 'g tape-g' }, this.app.toolLabel('BoxTape')), h('span', { class: 'klep-cursor' })),
        h('div', { class: 'klep-sub mono' }, '> playlist in, mp3s out — straight into the audio dump'),
        h('div', { class: 'klep-bar' }, this.input, this.goBtn),
        need.length
          ? this.needNote(need)
          : h('div', { class: 'faint', style: { fontSize: '11.5px' } }, 'Saves to Box-DocSpitter\\audio-dump with the song title, artist and cover art. Spotify links are matched to the same song on YouTube. Only download music you have the right to keep.')),
      this.progress,
      this.results)));
    setTimeout(() => this.input.focus(), 50);
  }

  async fetch() {
    const url = this.input.value.trim();
    if (!url) return toast('Type a song to search for, or paste a link.', { type: 'warn' });
    const isLink = /^https?:\/\//i.test(url) || /^spotify:/i.test(url);
    const list = !isLink && url.includes(';') ? url.split(';').map((x) => x.trim()).filter(Boolean) : null;
    this.goBtn.disabled = true;
    clear(this.results).append(h('div', { class: 'klep-loading' }, h('div', { class: 'spinner' }), h('span', { class: 'faint' },
      isLink ? 'reading the playlist… (big playlists take a few seconds)' : list ? 'lining up your songs…' : 'searching YouTube…')));
    try {
      const res = !isLink ? (list ? await this.fromList(list) : await this.search(url))
        : /^spotify:|^https?:\/\/(open\.spotify\.com|spotify\.link)\//i.test(url) ? await this.fromSpotify(url) : await this.fromLink(url);
      this.items = (res.items || []).filter((x) => x.url);
      this.title = res.title || '';
      this.render(res);
    } catch (e) {
      clear(this.results).append(h('div', { class: 'klep-note error' }, e.message));
    } finally {
      this.goBtn.disabled = false;
    }
  }

  /** The "BoxTape needs yt-dlp and ffmpeg" note, with a button that installs them with winget. */
  needNote(need) {
    const msg = h('span', {}, `BoxTape needs ${need.join(' and ')}.`);
    const btn = this.tools.canInstall ? h('button', { class: 'btn sm primary', onclick: () => this.installTools(btn, msg) }, icon('download', 'sm'), 'Install them for me') : null;
    return h('div', { class: 'klep-note error tape-need' }, icon('info', 'sm'), msg, btn);
  }

  async installTools(btn, msg) {
    btn.disabled = true;
    const spin = h('div', { class: 'spinner' });
    btn.replaceWith(spin);
    try {
      const { id } = await post('/api/tools/install', {});
      for (let j = null; id;) {
        j = await get(`/api/job?id=${id}`);
        if (j.current) msg.textContent = j.current;
        if (j.status === 'error') throw new Error(j.error || 'Install failed');
        if (j.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      toast('yt-dlp and ffmpeg are installed — BoxTape is ready.', { type: 'ok' });
      clear(this.pane);
      await this.load(); // draws BoxTape again, now without the note
    } catch (e) {
      msg.textContent = `${e.message} (or install by hand: winget install yt-dlp and winget install Gyan.FFmpeg)`;
      spin.replaceWith(btn);
      btn.disabled = false;
    }
  }

  /** Words → the top YouTube results; nothing is ticked until you pick (except the first). */
  async search(q) {
    const res = await post('/api/tape/search', { q });
    res.items.forEach((it, i) => { it.preselect = i === 0; });
    res.notes = res.items.length ? ['Tick the ones you want — the top result is ticked for you.'] : [];
    res.search = true;
    return res;
  }

  /** A list of songs ("Artist - Title" or just a title, one per entry) → each is matched on YouTube while downloading. */
  async fromList(entries) {
    let have = new Set();
    try { have = new Set((await api.dump('audio')).items.map((it) => songKey(stripExt(it.base || it.name)))); } catch { /* ignore */ }
    const items = entries.slice(0, 300).map((line) => {
      const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(line);
      const artist = m ? m[1].trim() : '';
      const title = m ? m[2].trim() : line;
      return { type: 'spotify', url: 'https://www.youtube.com/', title, artist, duration: 0, label: artist ? `${artist} - ${title}` : title, uploader: artist || null, already: have.has(songKey(artist ? `${artist} - ${title}` : title)) };
    });
    const n = items.filter((x) => x.already).length;
    return { title: `${items.length} songs from your list`, items, notes: [`Each song is matched to the best YouTube upload when it downloads.${n ? ` ${n} already in your audio dump start unticked.` : ''}`] };
  }

  /** A YouTube (or other yt-dlp) link or playlist → its videos; ones already in the audio dump start unticked. */
  async fromLink(url) {
    const res = await post('/api/klep/scan', { url, mode: 'ytdlp', playlist: 'on' });
    let have = new Set();
    try { have = new Set((await api.dump('audio')).items.map((it) => songKey(stripExt(it.base || it.name)))); } catch { /* ignore */ }
    // downloads are named after the video title, cut to 120 bytes, so a long title is looked for both whole and cut
    const cut = (t) => { const b = new TextEncoder().encode(t); return b.length <= 120 ? t : new TextDecoder().decode(b.slice(0, 120)).replace(/�$/, ''); };
    const items = res.items || [];
    for (const it of items) {
      const t = String(it.title || '');
      if (t && (have.has(songKey(t)) || have.has(songKey(cut(t))))) it.already = true;
    }
    const n = items.filter((x) => x.already).length;
    res.notes = [...(res.notes || []), ...(n ? [`${n} song${n === 1 ? ' is' : 's are'} already in your audio dump, so ${n === 1 ? 'it starts' : 'they start'} unticked.`] : [])];
    return res;
  }

  /** Spotify → the song list (YouTube matching happens per song while downloading). */
  async fromSpotify(url) {
    const res = await post('/api/spotify/tracks', { url });
    // songs already in the audio dump start unticked
    let have = new Set();
    try { have = new Set((await api.dump('audio')).items.map((it) => songKey(stripExt(it.base || it.name)))); } catch { /* ignore */ }
    const items = res.items.map((t) => {
      const artist = String(t.artist || '').split(',')[0].trim();
      return {
        type: 'spotify', url: t.id ? `https://open.spotify.com/track/${t.id}` : 'https://open.spotify.com/',
        title: t.title, artist: t.artist, duration: t.duration, label: `${artist} - ${t.title}`,
        uploader: t.artist, already: have.has(songKey(`${artist} - ${t.title}`)),
      };
    });
    const notes = [];
    if (res.maybeMore && !res.hasKey) notes.push(h('span', {}, 'Spotify only shows the first 100 songs of a playlist without a key. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.spotifyKey(); } }, 'Add a free Spotify key'), ' to get all of them.'));
    const n = items.filter((x) => x.already).length;
    if (n) notes.push(`${n} song${n === 1 ? ' is' : 's are'} already in your audio dump, so ${n === 1 ? 'it starts' : 'they start'} unticked.`);
    return { title: res.title, items, notes, spotify: true };
  }

  async spotifyKey() {
    const id = h('input', { type: 'text', placeholder: 'Client ID', spellcheck: 'false', autocomplete: 'off' });
    const secret = h('input', { type: 'password', placeholder: 'Client Secret', spellcheck: 'false', autocomplete: 'off' });
    const ok = await modal({
      title: 'Spotify key (optional)',
      body: h('div', { class: 'col', style: { gap: '10px' } },
        h('p', { class: 'dim', style: { margin: 0 } }, 'Only needed for playlists with more than 100 songs. It’s free:'),
        h('ol', { class: 'dim', style: { margin: 0, paddingLeft: '18px', fontSize: '12.5px' } },
          h('li', {}, 'Go to developer.spotify.com/dashboard and log in.'),
          h('li', {}, 'Create app → any name, Redirect URI http://127.0.0.1, tick “Web API”.'),
          h('li', {}, 'Open the app’s Settings and copy the Client ID and Client Secret here.')),
        id, secret,
        h('div', { class: 'faint', style: { fontSize: '11px' } }, 'Kept in Box-DocSpitter\\data\\secrets.json on this PC; it’s only ever sent to Spotify.')),
      buttons: [{ label: 'Remove key', value: 'remove', ghost: true }, { label: 'Cancel', value: null, ghost: true }, { label: 'Save', value: 'save', primary: true }],
    });
    if (!ok) return;
    try {
      await post('/api/spotify/key', ok === 'remove' ? {} : { clientId: id.value.trim(), clientSecret: secret.value.trim() });
      toast(ok === 'remove' ? 'Spotify key removed' : 'Spotify key saved — fetching the whole playlist', { type: 'ok' });
      if (ok === 'save' && this.input.value.trim()) this.fetch();
    } catch (e) { errorToast(e); }
  }

  render(res) {
    const R = clear(this.results);
    for (const n of res.notes || []) R.append(h('div', { class: 'klep-note' }, icon('info', 'sm'), h('span', {}, n)));
    if (!this.items.length) { R.append(h('div', { class: 'klep-note' }, 'No tracks found at that link.')); return; }
    const all = h('input', { type: 'checkbox', checked: !this.items.some((x) => x.already || x.preselect === false) });
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
      const cb = h('input', { type: 'checkbox', checked: it.preselect !== undefined ? it.preselect : !it.already });
      cb.addEventListener('change', update);
      cb._item = it;
      this.boxes.push(cb);
      list.append(h('label', { class: 'tape-row' }, cb,
        h('span', { class: 'tape-n mono faint' }, String(i + 1)),
        h('span', { class: 'tape-title' }, it.type === 'spotify' ? it.title : it.title || it.url, it.already ? h('span', { class: 'tape-have' }, 'in your dump') : null),
        h('span', { class: 'tape-meta mono faint' }, [it.uploader, it.duration ? fmtTime(it.duration, false) : null].filter(Boolean).join(' · '))));
    });
    this.lanes = h('select', { class: 'tape-lanes', title: 'How many tracks download at the same time' }, [1, 2, 3, 4, 5, 6].map((n) => h('option', { value: String(n) }, `${n} at a time`)));
    this.lanes.value = String(this.app.settings.tapeParallel || 3);
    this.lanes.addEventListener('change', () => this.app.saveSettings({ tapeParallel: Number(this.lanes.value) }));
    // a song YouTube turns down gets tried again this many times (a few seconds apart) before it counts as failed
    this.retries = h('select', { class: 'tape-lanes', title: 'If YouTube turns a song down, try it again this many times (a few seconds apart) before giving up on it' },
      [0, 1, 2, 3, 5, 10].map((n) => h('option', { value: String(n) }, n ? `${n} ${n === 1 ? 'retry' : 'retries'}` : 'No retries')));
    this.retries.value = String(this.app.settings.tapeRetries ?? 3);
    if (!this.retries.value) this.retries.value = '3';
    this.retries.addEventListener('change', () => this.app.saveSettings({ tapeRetries: Number(this.retries.value) }));
    // tick everything you don't have yet, untick what's already in the audio dump
    const newOnly = this.items.some((x) => x.already)
      ? h('button', { class: 'btn sm', 'data-tip': 'Select only the songs that aren’t in your audio dump yet', onclick: () => {
        for (const b of this.boxes) b.checked = !b._item.already;
        update();
      } }, icon('check', 'sm'), 'Only new songs')
      : null;
    R.append(h('div', { class: 'klep-results-head' }, h('label', { class: 'check' }, all, count), newOnly,
      this.title ? h('span', { class: 'faint klep-pagetitle' }, '· ' + this.title) : null, h('div', { class: 'grow' }), this.destPicker(), this.lanes, this.retries, goBtn), list);
    update();
  }

  /**
   * Where the songs go: the audio dump itself, or one of its playlists (folders), or a new playlist —
   * named after the playlist being downloaded, or one you name.
   */
  destPicker() {
    const sel = h('select', { class: 'tape-dest', title: 'Which playlist in the music player these songs go into' });
    const clean = (n) => String(n || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/^[. ]+|[. ]+$/g, '').replace(/\s+/g, ' ').slice(0, 80);
    const fill = (playlists, pick) => {
      const fromTitle = clean(this.title);
      clear(sel).append(
        h('option', { value: '' }, 'Music dump (no playlist)'),
        playlists.length ? h('optgroup', { label: 'Playlists' }, playlists.map((p) => h('option', { value: p }, p))) : null,
        fromTitle && !playlists.includes(fromTitle) ? h('option', { value: fromTitle }, `New playlist “${fromTitle}”`) : null,
        h('option', { value: '\u0000new' }, 'New playlist…'));
      sel.value = [...sel.options].some((o) => o.value === pick) ? pick : '';
    };
    let playlists = this.app.music?.playlists || [];
    fill(playlists, this.app.settings.tapePlaylist || '');
    api.dump('audio', '').then((r) => { playlists = (r.folders || []).map((f) => f.base); fill(playlists, sel.value || this.app.settings.tapePlaylist || ''); }).catch(() => {});
    let last = sel.value;
    sel.addEventListener('change', async () => {
      if (sel.value === '\u0000new') {
        const n = clean(await promptDialog('New playlist', 'BoxTape saves these songs into it', '', { placeholder: 'e.g. Road trip' }));
        if (!n) { sel.value = last; return; }
        if (!playlists.includes(n)) playlists = [...playlists, n].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        fill(playlists, n);
      }
      last = sel.value;
      this.app.saveSettings({ tapePlaylist: sel.value });
    });
    this.dest = sel;
    return sel;
  }

  /** Queue the ticked tracks as one batch. Batches run one after another; each keeps its own progress card. */
  download() {
    const picked = this.boxes.filter((b) => b.checked).map((b) => b._item);
    if (!picked.length) return;
    const name = this.title ? `“${this.title}”` : `${picked.length} track${picked.length > 1 ? 's' : ''}`;
    const folder = this.dest && this.dest.value !== '\u0000new' ? this.dest.value : '';
    const batch = { picked, name, folder, state: 'queued', jobId: null };
    batch.titleEl = h('b', {});
    batch.counter = h('span', { class: 'mono faint', style: { fontSize: '11px' } });
    batch.actions = h('span', { class: 'row', style: { gap: '6px' } });
    batch.bar = h('div', { class: 'vid-progress' }, h('div', { class: 'vid-progress-bar' }));
    batch.rows = h('div', { class: 'tape-prog-rows' });
    batch.card = h('div', { class: 'tape-prog queued' }, h('div', { class: 'tape-prog-head' }, batch.titleEl, h('div', { class: 'grow' }), batch.counter, batch.actions), batch.bar, batch.rows);
    this.queue = this.queue || [];
    this.queue.push(batch);
    this.progress.append(batch.card);
    this.paintQueued(batch);
    batch.card.scrollIntoView({ block: 'nearest' });
    if (this.running) toast(`Queued ${name} — it starts when the current download finishes`, { timeout: 2600 });
    // untick what was just queued, so the next playlist (or the rest of this one) can be picked straight away
    for (const b of this.boxes) if (b.checked) { b.checked = false; b.dispatchEvent(new Event('change')); }
    this.pump();
  }

  paintQueued(batch) {
    const ahead = this.queue.filter((x) => x.state === 'queued').indexOf(batch);
    batch.titleEl.textContent = `Queued: ${batch.name} · ${batch.picked.length} track${batch.picked.length > 1 ? 's' : ''}${batch.folder ? ` → “${batch.folder}”` : ''}`;
    batch.counter.textContent = this.running ? (ahead > 0 ? `${ahead} ahead of it` : 'next up') : '';
    clear(batch.actions).append(h('button', { class: 'btn sm ghost', onclick: () => {
      batch.state = 'removed';
      this.queue = this.queue.filter((x) => x !== batch);
      batch.card.remove();
      this.queue.filter((x) => x.state === 'queued').forEach((x) => this.paintQueued(x));
    } }, 'Remove'));
    clear(batch.rows).append(...batch.picked.slice(0, 200).map((it) => h('div', { class: 'tape-prog-row waiting' },
      h('span', { class: 'tape-state' }, '·'), h('span', { class: 'tape-title' }, it.label || it.title || it.url), h('span', { class: 'mono faint' }, 'queued'))));
  }

  async pump() {
    if (this.running) return;
    const next = (this.queue || []).find((x) => x.state === 'queued');
    if (!next) return;
    this.running = next;
    try { await this.runBatch(next); } finally {
      this.running = null;
      this.queue = this.queue.filter((x) => x !== next);
      this.queue.filter((x) => x.state === 'queued').forEach((x) => this.paintQueued(x));
      this.pump();
    }
  }

  async runBatch(batch) {
    const { picked, bar, rows, counter } = batch;
    batch.state = 'running';
    batch.card.classList.remove('queued');
    batch.titleEl.textContent = `Saving ${batch.name} to ${batch.folder ? `the playlist “${batch.folder}”` : 'the audio dump'}`;
    const cancel = h('button', { class: 'btn sm ghost' }, 'Cancel');
    clear(batch.actions).append(cancel);
    try {
      const parallel = Number(this.lanes?.value) || this.app.settings.tapeParallel || 3;
      const { id } = await post('/api/audio/grab', {
        items: picked.map((it) => (it.type === 'spotify'
          ? { url: it.url, type: 'spotify', title: it.title, artist: it.artist, duration: it.duration, label: it.label }
          : { url: it.url, type: 'ytdlp', title: it.title })),
        parallel,
        retries: Number(this.retries?.value ?? this.app.settings.tapeRetries ?? 3),
        folder: batch.folder || '',
      });
      batch.jobId = id;
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
          h('span', { class: 'mono faint', title: t.note || '' }, t.status === 'working' ? (t.progress ? `${Math.round(t.progress * 100)}%` : t.note || '…') : t.status === 'failed' ? (t.error || 'failed').slice(0, 80) : t.status))));
        // songs appear in the player as they finish
        if ((j.done || 0) > refreshed) { refreshed = j.done; this.app.music?.refresh(); }
        if (j.status !== 'running') {
          const first = (j.tracks || []).find((t) => t.status === 'done');
          batch.titleEl.textContent = j.status === 'done' ? `Done: ${batch.name} — ${j.done} saved${j.failed ? `, ${j.failed} failed` : ''}`
            : j.status === 'cancelled' ? `Stopped: ${batch.name} — ${j.done || 0} saved` : `Failed: ${batch.name} — ${j.error || ''}`;
          clear(batch.actions).append(
            first ? h('button', { class: 'btn sm primary', onclick: () => this.app.music?.playByName(first.name) }, icon('play', 'sm'), 'Play') : null,
            first ? h('button', { class: 'btn sm', onclick: () => this.app.music?.open() }, icon('music', 'sm'), 'Open player') : null,
            h('button', { class: 'icon-btn', 'data-tip': 'Clear this from the list', onclick: () => batch.card.remove() }, icon('x', 'sm')));
          batch.card.classList.add('finished');
          if (j.status === 'done') toast(`BoxTape: ${j.done} song${j.done === 1 ? '' : 's'} from ${batch.name} in ${batch.folder ? `the playlist “${batch.folder}”` : 'the audio dump'}`, { type: j.failed ? 'warn' : 'ok' });
          break;
        }
      }
    } catch (e) {
      batch.titleEl.textContent = `Failed: ${batch.name}`;
      clear(batch.actions).append(h('button', { class: 'icon-btn', onclick: () => batch.card.remove() }, icon('x', 'sm')));
      errorToast(e, this.app.toolName('BoxTape'));
    }
    batch.state = 'finished';
  }

  status() { return { left: [{ text: this.app.toolName('BoxTape'), icon: 'music' }, { text: 'saves to audio-dump' }], right: [{ text: this.tools?.ytdlp && this.tools?.ffmpeg ? 'yt-dlp + ffmpeg ready' : 'needs yt-dlp + ffmpeg' }] }; }
  saveFormats() { return []; }
}
