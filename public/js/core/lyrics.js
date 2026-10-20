// Lyrics: a small floating panel with the playing song's words from LRCLIB (through the server's /api/lyrics). It
// follows the music: a new song brings its own lyrics, and timed lyrics light up line by line as it plays. Artist and
// title come from the song's tags, or from an "Artist - Title" file name.

import { api } from './api.js';
import { h, clear } from './dom.js';
import { icon } from './icons.js';

const stripExt = (n) => n.replace(/\.[^.\\/]+$/, '');
const JUNK = /[([](?:official(?: music)?(?: video| audio| visualizer| lyric video)?|music video|lyric video|lyrics?|audio|video|visualizer|hd|hq|4k|explicit|clean|mv|m\/v)[)\]]/gi;

/** "Artist - Title (Official Video).mp3" → { artist, title } (artist '' when the name has no " - "). */
export function fromName(name) {
  const s = stripExt(String(name).split('/').pop()).replace(JUNK, ' ').replace(/\s*\(\d+\)\s*$/, '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: s };
}

/** "[01:23.45] words" lines → [{ t: seconds, text }], in order. */
function parseSynced(lrc) {
  const out = [];
  for (const line of String(lrc).split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) out.push({ t: Number(s[1]) * 60 + Number(s[2]), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** audio: the music's <audio>; current(): the playing track ({ name, path }) or null. */
export function createLyrics(app, { audio, current }) {
  let el = null, body = null, head = null, src = null, shownFor = null, lines = null, rows = [], lit = -1, userScrollAt = 0, seq = 0;
  const cfg = () => app.settings.lyricsPos || {};

  function build() {
    head = h('div', { class: 'ly-title' });
    src = h('div', { class: 'ly-src faint' });
    body = h('div', { class: 'ly-body' });
    body.addEventListener('wheel', () => { userScrollAt = performance.now(); }, { passive: true });
    const close = h('button', { class: 'icon-btn ly-x', 'data-tip': 'Close the lyrics' }, icon('x', 'sm'));
    close.addEventListener('click', () => hide());
    const top = h('div', { class: 'ly-top' }, h('div', { class: 'ly-head' }, head, src), close);
    top.addEventListener('pointerdown', drag);
    el = h('div', { class: 'lyrics-panel' }, top, body);
  }

  function place(x = cfg().x, y = cfg().y) {
    if (!el?.isConnected) return;
    const w = el.offsetWidth || 320, ht = el.offsetHeight || 420;
    const pop = document.querySelector('.music-pop')?.getBoundingClientRect(); // first time: beside the music window, not on it
    x ??= pop && pop.left > w + 12 ? pop.left - w - 12 : innerWidth - w - 60;
    y ??= pop ? pop.top : 60;
    el.style.left = `${Math.max(0, Math.min(innerWidth - w, x))}px`;
    el.style.top = `${Math.max(0, Math.min(innerHeight - 40, y))}px`;
  }
  addEventListener('resize', () => place());

  function drag(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const top = e.currentTarget, r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    try { top.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    el.classList.add('dragging');
    const move = (ev) => place(ev.clientX - dx, ev.clientY - dy);
    const up = () => {
      top.removeEventListener('pointermove', move);
      top.removeEventListener('pointerup', up);
      top.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      const q = el.getBoundingClientRect();
      app.saveSettings({ lyricsPos: { x: Math.round(q.left), y: Math.round(q.top) } });
    };
    top.addEventListener('pointermove', move);
    top.addEventListener('pointerup', up);
    top.addEventListener('pointercancel', up);
  }

  const note = (text) => { lines = null; rows = []; lit = -1; clear(body).append(h('div', { class: 'ly-note faint' }, text)); };

  async function load() {
    const t = current();
    if (!t) { shownFor = null; head.textContent = 'Lyrics'; src.textContent = ''; note('Nothing is playing.'); return; }
    if (shownFor === t.path) return;
    shownFor = t.path;
    const n = ++seq;
    const guess = fromName(t.name);
    head.textContent = guess.title;
    src.textContent = guess.artist;
    note('Looking for lyrics…');
    const tags = t.path ? await api.get(`/api/audio/tags?path=${encodeURIComponent(t.path)}`).catch(() => null) : null;
    const artist = tags?.artist || guess.artist, title = tags?.title || guess.title;
    if (!audio.duration) await new Promise((r) => { audio.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 3000); });
    let res;
    try {
      res = await api.get(`/api/lyrics?${new URLSearchParams({ artist, title, dur: String(Math.round(audio.duration || 0)) })}`);
    } catch (e) {
      if (n === seq) note(e.message || 'Couldn’t look for lyrics.');
      return;
    }
    if (n !== seq) return;
    head.textContent = res?.title || title;
    src.textContent = [res?.artist || artist, res?.source && `lyrics from ${res.source}`].filter(Boolean).join(' · ');
    if (!res || res.none) { note(`No lyrics found for “${title}”${artist ? ` by ${artist}` : ''}.`); return; }
    if (res.instrumental && !res.plain && !res.synced) { note('Instrumental — no words.'); return; }
    const synced = res.synced ? parseSynced(res.synced) : [];
    clear(body);
    if (synced.length) {
      lines = synced;
      rows = synced.map((l) => {
        const row = h('div', { class: 'ly-line' }, l.text || '♪');
        row.addEventListener('click', () => { audio.currentTime = l.t; });
        row.title = 'Jump here';
        return row;
      });
      body.append(...rows);
      lit = -1;
      follow();
    } else {
      lines = null; rows = [];
      body.append(h('div', { class: 'ly-plain' }, res.plain));
    }
    body.scrollTop = 0;
  }

  /** Light up the line being sung and keep it in view (unless the reader scrolled in the last few seconds). */
  function follow() {
    if (!lines || !el?.isConnected) return;
    const now = audio.currentTime + 0.25;
    let i = -1;
    for (let k = 0; k < lines.length && lines[k].t <= now; k++) i = k;
    if (i === lit) return;
    rows[lit]?.classList.remove('on');
    lit = i;
    const row = rows[i];
    if (!row) return;
    row.classList.add('on');
    if (performance.now() - userScrollAt > 4000) body.scrollTo({ top: row.offsetTop - body.clientHeight / 2 + row.offsetHeight / 2, behavior: app.settings.animations === false ? 'auto' : 'smooth' });
  }
  audio.addEventListener('timeupdate', follow);
  audio.addEventListener('seeked', () => { lit = -1; follow(); });
  audio.addEventListener('play', () => { if (el?.isConnected) load(); });
  audio.addEventListener('loadedmetadata', () => { if (el?.isConnected) load(); });

  function show() {
    if (!el) build();
    if (!el.isConnected) document.body.append(el);
    place();
    load();
  }
  function hide() { el?.remove(); }
  const isOpen = () => !!el?.isConnected;
  function toggle() { if (isOpen()) hide(); else show(); }

  return { show, hide, toggle, isOpen };
}
