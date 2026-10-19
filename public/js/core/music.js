// ♪ music player for the audio-dump folder: play/pause, skip, shuffle, loop, seek, volume, and a 10-band
// mixer (EQ) running through Web Audio. Keeps playing while the panel is closed; media keys work too.
// A queue (separate from the library, reorder by dragging) plays before the library carries on, and the
// song, position, volume and play/pause survive closing the app, restarts and updates.
// Playlists are the folders in the audio dump: pick one and the player (next, shuffle, loop) stays inside it.
// Full screen fills the window with the player, a big cover and a visualizer.

import { api } from './api.js';
import { h, clear, formatBytes, stripExt, extOf } from './dom.js';
import { icon } from './icons.js';
import { toast, errorToast, contextMenu, hoverKeys, renameInline, modal, promptDialog, confirmDialog } from './ui.js';
import { pickOpen } from './files.js';
import { sharePlaylist, importPlaylist } from './playlist-share.js';
import { createLyrics } from './lyrics.js';

// 10-band graphic EQ (±18 dB) between a low cut (high-pass) and a high cut (low-pass).
export const BANDS = [
  [31, 'lowshelf'], [62, 'peaking'], [125, 'peaking'], [250, 'peaking'], [500, 'peaking'],
  [1000, 'peaking'], [2000, 'peaking'], [4000, 'peaking'], [8000, 'peaking'], [16000, 'highshelf'],
];
const NB = BANDS.length;
export const MIN_HZ = 20;
export const MAX_HZ = 20000;
const flat = () => Array(NB).fill(0);
// eq: dB per band · low: low cut Hz (20 = off) · high: high cut Hz (20000 = off)
export const PRESETS = {
  Flat: { eq: flat(), low: MIN_HZ, high: MAX_HZ },
  'Bass boost': { eq: [8, 7, 5, 2, 0, 0, 0, 0, 0, 0], low: MIN_HZ, high: MAX_HZ },
  'Bass cut': { eq: [-12, -10, -6, -2, 0, 0, 0, 0, 0, 0], low: 90, high: MAX_HZ },
  'V-shape': { eq: [6, 5, 3, 0, -2, -3, -1, 2, 5, 6], low: MIN_HZ, high: MAX_HZ },
  Vocal: { eq: [-4, -3, -1, 1, 3, 4, 4, 2, 0, -1], low: 80, high: MAX_HZ },
  Bright: { eq: [0, 0, 0, 0, 0, 1, 2, 4, 6, 7], low: MIN_HZ, high: MAX_HZ },
  Warm: { eq: [3, 3, 2, 1, 0, -1, -2, -3, -4, -5], low: MIN_HZ, high: MAX_HZ },
  'Tinny (phone)': { eq: [0, 0, 0, -4, 2, 6, 7, 3, 0, 0], low: 500, high: 3400 },
  'AM radio': { eq: [0, 0, 0, 0, 2, 4, 4, 2, 0, 0], low: 250, high: 4500 },
  'Muffled (next room)': { eq: [4, 4, 3, 1, 0, -2, -6, -10, -14, -18], low: MIN_HZ, high: 700 },
  Underwater: { eq: [6, 5, 4, 2, 0, -4, -10, -14, -18, -18], low: MIN_HZ, high: 420 },
  'Lo-fi': { eq: [2, 3, 3, 2, 1, 0, -2, -4, -6, -8], low: 120, high: 5500 },
};
// cut-filter sliders work on a log scale (0..1000 ↔ 20 Hz..20 kHz)
export const hzToPos = (hz) => Math.round((Math.log(hz / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ)) * 1000);
export const posToHz = (pos) => Math.round(MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, pos / 1000));
export const hzLabel = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : String(hz));

/** The current theme's colours for the visualizer and the EQ curve (custom themes included). */
function vizColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
  return { a: v('--accent-3', '#6ee7e0'), b: v('--accent', '#b48cff'), c: v('--accent-2', '#ff7ac6'), grid: v('--text-3', '#8d84a0') };
}
const themeGradient = (g, W) => {
  const k = vizColors(), grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, k.a); grad.addColorStop(0.5, k.b); grad.addColorStop(1, k.c);
  return grad;
};

/** An EQ's response curve on a canvas: st = { eq, low, high }; ac = an audio context whose filters to use (a scratch
 *  one otherwise). Shared by the music mixer and the browser equalizer. */
export function drawEqCurve(curve, st, ac) {
  const c = curve.getContext('2d');
  const W = curve.width, H = curve.height;
  c.clearRect(0, 0, W, H);
  const yOf = (db) => H / 2 - (db / 24) * (H / 2 - 8);
  const k = vizColors();
  c.strokeStyle = k.grid;
  c.lineWidth = 1;
  c.globalAlpha = 0.2;
  for (const db of [-18, -12, -6, 0, 6, 12, 18]) { c.beginPath(); c.moveTo(0, yOf(db)); c.lineTo(W, yOf(db)); c.stroke(); }
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = (hzToPos(hz) / 1000) * W; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
  c.globalAlpha = 0.8;
  c.fillStyle = k.grid;
  c.font = '9px IBM Plex Mono, monospace';
  for (const hz of [100, 1000, 10000]) c.fillText(hzLabel(hz), (hzToPos(hz) / 1000) * W + 3, H - 4);
  c.globalAlpha = 1;
  // combined response of every filter (uses the real filters when audio has started; otherwise a scratch graph)
  const N = 200;
  const freqs = new Float32Array(N);
  for (let i = 0; i < N; i++) freqs[i] = posToHz((i / (N - 1)) * 1000);
  const total = new Float32Array(N).fill(1);
  const scratch = ac || new OfflineAudioContext(1, 1, 44100);
  const make = (type, f, q, g) => { const b = scratch.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g; return b; };
  const chain = [
    make('highpass', st.low <= MIN_HZ + 1 ? 1 : st.low, 0.9, 0),
    ...BANDS.map(([f, type], i) => make(type, f, type === 'peaking' ? 1.4 : 0.7, st.eq[i])),
    make('lowpass', st.high >= MAX_HZ - 50 ? 24000 : st.high, 0.9, 0),
  ];
  const mag = new Float32Array(N), ph = new Float32Array(N);
  for (const f of chain) { f.getFrequencyResponse(freqs, mag, ph); for (let i = 0; i < N; i++) total[i] *= mag[i]; }
  c.beginPath();
  for (let i = 0; i < N; i++) {
    const db = Math.max(-24, Math.min(24, 20 * Math.log10(Math.max(total[i], 1e-6))));
    const x = (i / (N - 1)) * W, y = yOf(db);
    if (i) c.lineTo(x, y); else c.moveTo(x, y);
  }
  c.strokeStyle = themeGradient(c, W);
  c.lineWidth = 2.5;
  c.stroke();
  c.lineTo(W, H); c.lineTo(0, H); c.closePath();
  c.fillStyle = k.b;
  c.globalAlpha = 0.08;
  c.fill();
  c.globalAlpha = 1;
}

/** The mouse wheel moves a slider: `step` per notch (up is more), half that with Shift held. Fires the
 *  slider's own input event at once and its change event once the wheel stops, as dragging would. */
export function wheelSlider(r, step) {
  let doneT = 0;
  r.addEventListener('wheel', (e) => {
    const d = e.deltaY || e.deltaX;
    if (!d) return;
    e.preventDefault();
    const min = Number(r.min), max = Number(r.max), was = Number(r.value);
    const v = Math.max(min, Math.min(max, was + (d < 0 ? 1 : -1) * (e.shiftKey ? step / 2 : step)));
    if (v === was) return;
    r.value = String(v);
    r.dispatchEvent(new Event('input'));
    clearTimeout(doneT);
    doneT = setTimeout(() => r.dispatchEvent(new Event('change')), 250);
  }, { passive: false });
}
const AUDIO_RE = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|weba)$/i;
const fmt = (t) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00');
// a song's name in the dump may have its playlist (folder) in front: "Road trip/Song.mp3"
const songTitle = (name) => stripExt(String(name || '').split('/').pop());
const plOf = (name) => (String(name).includes('/') ? String(name).split('/')[0] : '');
const likeKey = (name) => String(name || '').split('/').pop().toLowerCase();
const LIKED = '\u0001liked'; // the liked songs, picked like a playlist (a folder name can't hold this character)

export function createMusic(app) {
  const s = app.settings;
  const audio = new Audio();
  let lyrics = null; // the lyrics panel, made the first time it's asked for
  const toggleLyrics = () => (lyrics ||= createLyrics(app, { audio, current: () => state.tracks[state.idx] || null })).toggle();
  audio.preload = 'metadata';
  let ctx = null;
  let gain = null;
  let filters = [];
  let lowCut = null;
  let highCut = null;
  let analyser = null;
  const state = {
    tracks: [], idx: -1, order: [],
    shuffle: !!s.musicShuffle,
    loop: ['off', 'all', 'one'].includes(s.musicLoop) ? s.musicLoop : 'all',
    volume: s.musicVolume ?? 0.7,
    eq: Array.isArray(s.musicEq) && s.musicEq.length === NB ? s.musicEq : flat(),
    low: Number(s.musicLowCut) || MIN_HZ,
    high: Number(s.musicHighCut) || MAX_HZ,
    open: false,
    queue: Array.isArray(s.musicQueue) ? s.musicQueue.filter((x) => typeof x === 'string') : [], // file names, in play order
    libIdx: -1, // where the library is up to (queued songs don't move it)
    view: s.musicView === 'queue' ? 'queue' : 'library',
    // null: every song · '': songs not in a playlist · 'name': that playlist (a folder in the audio dump) · LIKED: liked songs
    playlist: typeof s.musicPlaylist === 'string' ? s.musicPlaylist : null,
    playlists: [],
    // liked songs, by file name without the playlist, so a song stays liked when it moves between playlists
    liked: new Set(Array.isArray(s.musicLiked) ? s.musicLiked.filter((x) => typeof x === 'string') : []),
  };
  const isLiked = (name) => state.liked.has(likeKey(name));
  const inList = (t) => !!t && (state.playlist == null || (state.playlist === LIKED ? isLiked(t.name) : plOf(t.name) === state.playlist));
  /** Like a song, or take the like back; liked songs have their own list (the ♥ Liked chip). */
  function toggleLike(name) {
    if (!name) return;
    const k = likeKey(name);
    if (state.liked.has(k)) state.liked.delete(k); else state.liked.add(k);
    app.saveSettings({ musicLiked: [...state.liked] });
    if (state.playlist === LIKED) reshuffle(true);
    render();
  }
  const visible = () => state.tracks.map((t, i) => i).filter((i) => inList(state.tracks[i]));
  let restored = false;
  let ui = null;

  // ---------------------------------------------------------------- audio graph (built on first play)
  function graph() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return; }
    ctx = new AudioContext();
    const source = ctx.createMediaElementSource(audio);
    lowCut = ctx.createBiquadFilter();
    lowCut.type = 'highpass';
    highCut = ctx.createBiquadFilter();
    highCut.type = 'lowpass';
    filters = BANDS.map(([freq, type], i) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = type === 'peaking' ? 1.4 : 0.7;
      f.gain.value = state.eq[i];
      return f;
    });
    applyCuts();
    gain = ctx.createGain();
    gain.gain.value = state.volume;
    let node = source.connect(lowCut);
    for (const f of filters) { node.connect(f); node = f; }
    analyser = ctx.createAnalyser(); // for the full-screen visualizer
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.78;
    node.connect(highCut).connect(gain).connect(analyser).connect(ctx.destination);
  }

  // A steep-ish slope (Q 0.9) so cutting really removes the lows / highs; at the ends they're bypassed.
  // Low cut off is a flat shelf (an exact pass-through): a high-pass parked at 1 Hz drifts once a song stops,
  // feeding a slowly growing rumble to the speakers and the visualizer.
  function applyCuts() {
    if (!lowCut) return;
    const lowOff = state.low <= MIN_HZ + 1;
    lowCut.type = lowOff ? 'lowshelf' : 'highpass';
    lowCut.gain.value = 0;
    lowCut.frequency.value = lowOff ? MIN_HZ : state.low;
    lowCut.Q.value = 0.9;
    highCut.frequency.value = state.high >= MAX_HZ - 50 ? 24000 : state.high;
    highCut.Q.value = 0.9;
  }

  // ---------------------------------------------------------------- playlist
  async function refresh() {
    let items = [];
    let folders = [];
    let ok = false;
    try {
      const [all, top] = await Promise.all([api.dump('audio'), api.dump('audio', '').catch(() => ({ folders: [] }))]);
      items = all.items;
      folders = top.folders || [];
      ok = true;
    } catch { /* ignore */ }
    const current = state.tracks[state.idx]?.name;
    const libName = state.tracks[state.libIdx]?.name;
    state.tracks = items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    state.idx = current ? state.tracks.findIndex((t) => t.name === current) : state.tracks.findIndex((t) => t.name === s.musicLast);
    state.libIdx = libName ? state.tracks.findIndex((t) => t.name === libName) : state.idx;
    if (ok) {
      // playlists: the top folders (empty ones too)
      const names = new Set(folders.map((f) => f.base));
      for (const t of state.tracks) { const p = plOf(t.name); if (p) names.add(p); }
      state.playlists = [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      if (state.playlist && state.playlist !== LIKED && !names.has(state.playlist)) { state.playlist = null; app.saveSettings({ musicPlaylist: null }); }
    }
    if (ok) {
      // songs that were removed or renamed outside the player drop out of the queue
      const have = new Set(state.tracks.map((t) => t.name));
      const q = state.queue.filter((n) => have.has(n));
      if (q.length !== state.queue.length) { state.queue = q; app.saveSettings({ musicQueue: q }); }
    }
    reshuffle();
    if (ok && !restored) { restored = true; restore(); }
    render();
    findDuplicates().then(showDupeCount);
  }

  // ---------------------------------------------------------------- remembering where you were
  // The song, the spot in it and play/pause are saved every few seconds while playing, on every play/pause/seek,
  // and once more as the window closes. On the next start (also after a restart or an update) it picks up there.
  let unloading = false;
  let lastPosSave = 0;
  const posPatch = () => {
    const t = state.tracks[state.idx];
    return t ? { musicLast: t.name, musicPos: Math.round((audio.currentTime || 0) * 10) / 10, musicPlaying: !audio.paused } : null;
  };
  function savePos(force = false) {
    if (unloading) return;
    const now = Date.now();
    if (!force && now - lastPosSave < 3000) return;
    lastPosSave = now;
    const patch = posPatch();
    if (patch) app.saveSettings(patch);
  }
  addEventListener('pagehide', () => {
    const patch = posPatch();
    unloading = true;
    if (!patch) return;
    Object.assign(app.settings, patch);
    // keepalive lets this request finish even though the page is going away
    fetch('/api/settings', { method: 'POST', keepalive: true, headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => {});
  });

  function restore() {
    const t = state.tracks[state.idx];
    if (!t || s.musicLast !== t.name) return;
    state.libIdx = state.idx;
    setSource(t);
    const at = Number(s.musicPos) || 0;
    audio.addEventListener('loadedmetadata', () => {
      if (at > 0 && (!audio.duration || at < audio.duration - 1)) audio.currentTime = at;
      if (s.musicPlaying) {
        graph();
        audio.play().catch(() => { /* the browser wants a click first; the play button still works */ });
      }
      render();
    }, { once: true });
  }
  // browsers start sound paused until the first click; resume the mixer then so a restored song is audible
  const wake = () => { if (ctx?.state === 'suspended') ctx.resume().catch(() => {}); };
  addEventListener('pointerdown', wake, true);
  addEventListener('keydown', wake, true);

  // ---------------------------------------------------------------- duplicates
  // Two ways a song can be in twice: the very same file under another name (checked byte for byte), or the same
  // title with download junk around it — "Song (2).mp3", "Song (Official Video).mp3", "song - copy.mp3".
  const JUNK = /[([](?:official(?: music)?(?: video| audio| visualizer| lyric video)?|music video|lyric video|lyrics?|audio|video|visualizer|hd|hq|4k|explicit|clean|mv|m\/v)[)\]]/gi;
  function songKey(name) {
    return stripExt(name).normalize('NFKC').toLowerCase()
      .replace(JUNK, ' ')
      .replace(/\s*\(\d+\)\s*$/, '')
      .replace(/\s*-\s*copy(\s*\(\d+\))?\s*$/, '')
      .replace(/[^a-z0-9\u00c0-\uffff]+/g, ' ')
      .trim();
  }

  /** -> [[track, track, …], …]: the first of each group is the one to keep. */
  async function findDuplicates() {
    const byName = new Map(state.tracks.map((t) => [t.name, t]));
    const parent = new Map();
    const find = (n) => { while (parent.get(n) !== n) n = parent.get(n); return n; };
    const join = (a, b) => { parent.set(find(b), find(a)); };
    for (const t of state.tracks) parent.set(t.name, t.name);
    const byKey = new Map();
    for (const t of state.tracks) {
      const k = songKey(t.name);
      if (!k) continue;
      if (byKey.has(k)) join(byKey.get(k), t.name); else byKey.set(k, t.name);
    }
    try {
      const { groups } = await api.dumpIdentical('audio');
      for (const g of groups) for (const n of g.slice(1)) if (byName.has(n) && byName.has(g[0])) join(g[0], n);
    } catch { /* names only */ }
    const sets = new Map();
    for (const t of state.tracks) { const r = find(t.name); if (!sets.has(r)) sets.set(r, []); sets.get(r).push(t); }
    // keep the cleanest name (shortest, no "(2)" or "copy"), then the oldest file
    const score = (t) => (/\(\d+\)|copy/i.test(stripExt(t.name)) ? 1000 : 0) + stripExt(t.name).length;
    return [...sets.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => score(a) - score(b) || a.mtime - b.mtime));
  }

  function showDupeCount(groups) {
    if (!ui) return;
    const extra = groups.reduce((n, g) => n + g.length - 1, 0);
    ui.dupeBtn.hidden = !extra;
    ui.dupeBtn.textContent = `${extra} dupe${extra === 1 ? '' : 's'}`;
  }

  async function showDuplicates() {
    const groups = await findDuplicates();
    if (!groups.length) { showDupeCount(groups); return toast('No duplicate songs.', { type: 'ok', timeout: 1800 }); }
    // each extra copy has a checkbox (ticked); the first of each group is kept
    const picks = [];
    const body = h('div', { class: 'music-dupe-list' }, groups.map((g) => h('div', { class: 'music-dupe-group' },
      g.map((t, i) => {
        if (i === 0) return h('div', { class: 'music-dupe-keep' }, h('span', { class: 'music-dupe-tag' }, 'keep'), t.name);
        const cb = h('input', { type: 'checkbox', checked: true });
        picks.push({ cb, t });
        return h('label', { class: 'music-dupe-extra' }, cb, h('span', {}, t.name), h('span', { class: 'faint mono' }, formatBytes(t.size)));
      }))));
    ui.el.classList.add('behind'); // the player floats above everything; let the dialog show on top
    const go = await modal({
      title: `Duplicate songs (${picks.length})`, wide: true,
      body: h('div', {}, h('p', { class: 'dim', style: { marginTop: 0 } }, 'Ticked copies move to audio-dump\\.removed (nothing is deleted for good). The top song in each group stays.'), body),
      buttons: [{ label: 'Cancel', value: false, ghost: true }, { label: 'Remove ticked copies', value: true, primary: true }],
    });
    ui.el.classList.remove('behind');
    if (!go) return;
    let n = 0;
    for (const { cb, t } of picks) {
      if (!cb.checked) continue;
      const i = state.tracks.indexOf(t);
      if (i === state.idx) { audio.pause(); audio.removeAttribute('src'); audio.load(); state.idx = -1; }
      try { await api.dumpRemove(t.name, 'audio'); n++; } catch (e) { errorToast(e, t.name); }
    }
    if (n) toast(`Moved ${n} duplicate${n === 1 ? '' : 's'} to audio-dump\\.removed`, { type: 'ok', timeout: 3500 });
    refresh();
  }

  /**
   * The play order. With shuffle on it's a saved random order that stays put: refreshing the song list keeps it
   * (new songs slot in at random places), and you can rearrange it in the Queue tab. `fresh` deals a new one.
   */
  function reshuffle(fresh = false) {
    const mine = visible(); // only the songs in the playlist that's picked
    if (!state.shuffle) { state.order = mine; return; }
    const at = new Map(state.tracks.map((t, i) => [t.name, i]));
    const kept = fresh ? [] : (state.orderNames || s.musicShuffleOrder || []).filter((nm) => at.has(nm) && inList(state.tracks[at.get(nm)])).map((nm) => at.get(nm));
    const seen = new Set(kept);
    if (kept.length) {
      state.order = kept;
      for (const i of mine) if (!seen.has(i)) state.order.splice(Math.floor(Math.random() * (state.order.length + 1)), 0, i);
    } else {
      state.order = [...mine];
      for (let i = state.order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [state.order[i], state.order[j]] = [state.order[j], state.order[i]]; }
      // keep the current song first so shuffle doesn't jump away from it
      if (state.idx >= 0 && inList(state.tracks[state.idx])) state.order = [state.idx, ...state.order.filter((x) => x !== state.idx)];
    }
    saveOrder();
  }
  function saveOrder() {
    const names = state.order.map((i) => state.tracks[i]?.name).filter(Boolean);
    const changed = names.join('\n') !== (state.orderNames || []).join('\n');
    state.orderNames = names;
    if (changed && state.shuffle) app.saveSettings({ musicShuffleOrder: names });
  }

  function setSource(t) {
    audio.src = `/api/stream?token=${encodeURIComponent(api.token)}&path=${encodeURIComponent(t.path)}`;
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: songTitle(t.name), artist: plOf(t.name) || 'audio-dump', album: 'Box-Deckspitter' });
  }

  /** fromQueue: a queued song doesn't move the library's place, so the library carries on where it was after. */
  function play(i = state.idx < 0 ? (state.order[0] ?? -1) : state.idx, { fromQueue = false } = {}) {
    const t = state.tracks[i];
    if (!t) {
      toast(state.tracks.length ? 'Nothing in this playlist yet — drag songs onto its name, or drop files on the player.' : 'Put some music in the audio dump first — drop files on the player or use Add songs.', { timeout: 3200 });
      return;
    }
    graph();
    if (!fromQueue) state.libIdx = i;
    if (i !== state.idx || !audio.src) {
      state.idx = i;
      setSource(t);
      app.saveSettings({ musicLast: t.name, musicPos: 0 });
    }
    audio.play().catch((e) => { if (e.name !== 'AbortError') errorToast(e, 'Can’t play that file'); });
    render();
  }
  const pause = () => { audio.pause(); render(); };
  const toggle = () => (audio.paused ? play() : pause());

  function step(dir, manual = false) {
    if (!state.tracks.length) return;
    const pos = state.order.indexOf(state.libIdx >= 0 ? state.libIdx : state.idx);
    let next = pos + dir;
    if (next >= state.order.length) { if (state.loop === 'off' && dir > 0 && !manual) { pause(); return; } next = 0; }
    if (next < 0) next = state.order.length - 1;
    play(state.order[next]);
  }
  /** Next song: the queue first, then the library from where it was. */
  function advance(manual) {
    while (state.queue.length) {
      const name = state.queue.shift();
      saveQueue();
      const i = state.tracks.findIndex((t) => t.name === name);
      if (i >= 0) { play(i, { fromQueue: true }); return; }
    }
    step(1, manual);
  }
  const next = () => advance(true);
  const prev = () => { if (audio.currentTime > 3) { audio.currentTime = 0; return; } step(-1, true); };

  audio.addEventListener('ended', () => {
    if (state.loop === 'one') { audio.currentTime = 0; audio.play(); return; }
    advance(false);
  });
  for (const ev of ['play', 'pause']) audio.addEventListener(ev, () => { render(); app.syncMusicButton?.(!audio.paused); savePos(true); app.presence?.update(); });
  audio.addEventListener('seeked', () => savePos(true));
  audio.addEventListener('timeupdate', () => { updateTime(); miniTime(); if (!audio.paused) savePos(); });
  audio.addEventListener('loadedmetadata', () => updateTime());
  audio.addEventListener('error', () => { if (audio.src) toast(`Couldn’t play ${state.tracks[state.idx]?.name || 'that file'}`, { type: 'warn' }); });

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => play());
    ms.setActionHandler('pause', () => pause());
    ms.setActionHandler('nexttrack', () => next());
    ms.setActionHandler('previoustrack', () => prev());
    ms.setActionHandler('seekto', (d) => { if (Number.isFinite(d.seekTime)) audio.currentTime = d.seekTime; });
  }

  // ---------------------------------------------------------------- settings
  function setVolume(v) {
    state.volume = Math.max(0, Math.min(1, v));
    if (gain) gain.gain.value = state.volume; else audio.volume = state.volume;
    app.saveSettings({ musicVolume: state.volume });
  }
  function setEq(i, db, save = true) {
    state.eq[i] = db;
    if (filters[i]) filters[i].gain.value = db;
    if (save) app.saveSettings({ musicEq: [...state.eq] });
  }
  function setCuts({ low = state.low, high = state.high } = {}, save = true) {
    state.low = Math.max(MIN_HZ, Math.min(low, 16000));
    state.high = Math.max(200, Math.min(high, MAX_HZ));
    if (state.low >= state.high) state.high = Math.min(MAX_HZ, state.low * 1.5);
    applyCuts();
    if (save) app.saveSettings({ musicLowCut: state.low, musicHighCut: state.high });
  }
  function setShuffle(on) { state.shuffle = on; reshuffle(true); app.saveSettings({ musicShuffle: on }); render(); }
  function cycleLoop() { state.loop = { off: 'all', all: 'one', one: 'off' }[state.loop]; app.saveSettings({ musicLoop: state.loop }); render(); }
  audio.volume = state.volume;

  async function addFiles(files) {
    let n = 0;
    for (const f of files) {
      if (!AUDIO_RE.test(f.name || '')) continue;
      try { await api.dumpAdd(intoPl(f.name), new Uint8Array(await f.arrayBuffer()), 'audio'); n++; } catch (e) { errorToast(e, f.name); }
    }
    if (n) { toast(`Added ${n} song${n > 1 ? 's' : ''}`, { type: 'ok' }); refresh(); } else if (files.length) toast('Only audio files (mp3, m4a, wav, flac, ogg…) go in the audio dump.', { type: 'warn' });
  }
  async function addFromDisk() {
    const paths = await pickOpen({ multi: true, title: 'Add songs to the audio dump', filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'] }] });
    let n = 0;
    for (const p of paths || []) {
      try { const { bytes } = await api.read(p); await api.dumpAdd(intoPl(p.split(/[\\/]/).pop()), bytes, 'audio'); n++; } catch (e) { errorToast(e); }
    }
    if (n) { toast(`Added ${n} song${n > 1 ? 's' : ''}`, { type: 'ok' }); refresh(); }
  }

  /** A new song's name: inside the playlist that's picked, if one is. */
  const intoPl = (name) => (state.playlist && state.playlist !== LIKED ? `${state.playlist}/${name}` : name);

  // ---------------------------------------------------------------- playlists
  function setPlaylist(p) {
    state.playlist = p;
    app.saveSettings({ musicPlaylist: p });
    reshuffle(true);
    // the library carries on from the start of the new playlist (the song playing now keeps playing)
    if (!inList(state.tracks[state.libIdx])) state.libIdx = -1;
    setView('library');
  }
  /** The player floats above everything, so it steps back while one of these dialogs is up. */
  const overDialog = async (fn) => {
    ui?.el.classList.add('behind');
    try { await fn(); } finally { ui?.el.classList.remove('behind'); }
  };
  const askName = async (title, value = '') => {
    ui?.el.classList.add('behind');
    const n = await promptDialog(title, 'Name', value, { placeholder: 'e.g. Road trip' });
    ui?.el.classList.remove('behind');
    return n == null ? null : String(n).trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').slice(0, 80);
  };
  /**
   * Songs were renamed or moved ([[old, new], …]): the queue, the shuffle and the song playing follow them.
   */
  async function relocate(changes) {
    if (!changes.length) return refresh();
    const map = new Map(changes);
    const cur = state.tracks[state.idx];
    const curMoved = !!(cur && audio.src && map.has(cur.name));
    const at = audio.currentTime;
    const wasPlaying = !audio.paused;
    if (state.queue.some((n) => map.has(n))) { state.queue = state.queue.map((n) => map.get(n) ?? n); app.saveSettings({ musicQueue: [...state.queue] }); }
    if (state.orderNames) state.orderNames = state.orderNames.map((n) => map.get(n) ?? n);
    let likes = false;
    for (const [from, to] of map) if (state.liked.has(likeKey(from)) && likeKey(from) !== likeKey(to)) { state.liked.delete(likeKey(from)); state.liked.add(likeKey(to)); likes = true; }
    if (likes) app.saveSettings({ musicLiked: [...state.liked] });
    for (const t of state.tracks) if (map.has(t.name)) t.name = map.get(t.name); // so refresh() keeps the same song picked
    await refresh();
    const t = state.tracks[state.idx];
    if (curMoved && t) {
      // the old stream URL points at the old file, so pick up from the same spot at the new one
      setSource(t);
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = at; if (wasPlaying) audio.play().catch(() => {}); }, { once: true });
      app.saveSettings({ musicLast: t.name });
    }
  }
  /** Move songs into a playlist ('' = out of any playlist). */
  async function moveSongs(names, to) {
    const changes = [];
    for (const n of names) {
      if (plOf(n) === to && n.split('/').length === (to ? 2 : 1)) continue;
      try { const r = await api.dumpMove([n], to, 'audio'); if (r.moved?.[0]) changes.push([n, r.moved[0]]); } catch (e) { errorToast(e, songTitle(n)); }
    }
    await relocate(changes);
    if (changes.length) toast(`${changes.length === 1 ? songTitle(changes[0][0]) : `${changes.length} songs`} → ${to ? `“${to}”` : 'no playlist'}`, { timeout: 1800 });
  }
  async function newPlaylist(songs = null) {
    const name = await askName('New playlist');
    if (!name) return;
    try { await api.dumpFolder(name, 'audio'); } catch (e) { if (!/taken/i.test(e.message)) return errorToast(e); }
    if (songs?.length) await moveSongs(songs, name);
    else { await refresh(); setPlaylist(name); }
  }
  async function renamePlaylist(p) {
    const name = await askName('Rename playlist', p);
    if (!name || name === p) return;
    try { await api.dumpRename(p, name, 'audio'); } catch (e) { return errorToast(e); }
    if (state.playlist === p) { state.playlist = name; app.saveSettings({ musicPlaylist: name }); }
    await relocate(state.tracks.filter((t) => plOf(t.name) === p).map((t) => [t.name, name + t.name.slice(p.length)]));
  }
  async function deletePlaylist(p, withSongs) {
    const songs = state.tracks.filter((t) => plOf(t.name) === p);
    ui?.el.classList.add('behind');
    const ok = !songs.length || await confirmDialog(withSongs ? `Remove “${p}” and its songs?` : `Delete the playlist “${p}”?`,
      withSongs ? `Its ${songs.length} song${songs.length === 1 ? '' : 's'} move to audio-dump\\.removed with it (nothing is deleted for good).`
        : `Its ${songs.length} song${songs.length === 1 ? ' stays' : 's stay'} in the audio dump, just not in a playlist.`,
      { okLabel: withSongs ? 'Remove' : 'Delete playlist', danger: withSongs });
    ui?.el.classList.remove('behind');
    if (!ok) return;
    if (!withSongs) await moveSongs(songs.map((t) => t.name), '');
    else if (plOf(state.tracks[state.idx]?.name || '') === p) { audio.pause(); audio.removeAttribute('src'); audio.load(); state.idx = -1; }
    try { await api.dumpRemove(p, 'audio'); } catch (e) { errorToast(e); }
    if (state.playlist === p) setPlaylist(null);
    refresh();
  }
  function playPlaylist(p, shuffle = null) {
    if (state.playlist !== p) setPlaylist(p);
    if (shuffle != null && shuffle !== state.shuffle) setShuffle(shuffle);
    reshuffle(true);
    if (state.order.length) play(state.order[0]);
  }
  function renderPlaylists() {
    const count = (p) => state.tracks.filter((t) => p == null || plOf(t.name) === p).length;
    const chip = (p, label) => {
      const b = h('button', { class: `chip music-pl ${state.playlist === p ? 'on' : ''}`, onclick: () => setPlaylist(p) },
        p ? icon('folder', 'sm') : null, h('span', { class: 'music-pl-name' }, label), h('span', { class: 'mono faint' }, String(count(p))));
      b.title = p == null ? 'Every song in the audio dump' : p === '' ? 'Songs that aren’t in a playlist' : `Playlist “${p}” · drop songs here to move them in · right-click for more`;
      if (p != null) {
        // drag a song from the list onto a playlist to move it there
        b.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/bds-song')) { e.preventDefault(); b.classList.add('drop'); } });
        b.addEventListener('dragleave', () => b.classList.remove('drop'));
        b.addEventListener('drop', (e) => { b.classList.remove('drop'); const n = e.dataTransfer.getData('text/bds-song'); if (n) { e.preventDefault(); moveSongs([n], p); } });
      }
      if (p) {
        b.addEventListener('contextmenu', (e) => contextMenu(e, [
          { label: 'Play', icon: 'play', action: () => playPlaylist(p, false) },
          { label: 'Shuffle play', icon: 'shuffle', action: () => playPlaylist(p, true) },
          { sep: true },
          { label: 'Share…', icon: 'send', action: () => overDialog(() => sharePlaylist(app, p)) },
          { label: 'Rename…', icon: 'edit', action: () => renamePlaylist(p) },
          { label: 'Show in Explorer', icon: 'external', action: () => api.dumpReveal('audio', p) },
          { sep: true },
          { label: 'Delete playlist (keep the songs)', icon: 'x', action: () => deletePlaylist(p, false) },
          { label: 'Remove playlist and its songs', icon: 'trash', action: () => deletePlaylist(p, true) },
        ]));
      }
      return b;
    };
    const likedN = state.tracks.filter((t) => isLiked(t.name)).length;
    const likedChip = likedN || state.playlist === LIKED
      ? h('button', { class: `chip music-pl music-pl-liked ${state.playlist === LIKED ? 'on' : ''}`, title: 'Your liked songs', onclick: () => setPlaylist(LIKED) },
        icon('heart-fill', 'sm'), h('span', { class: 'music-pl-name' }, 'Liked'), h('span', { class: 'mono faint' }, String(likedN)))
      : null;
    clear(ui.pls).append(
      chip(null, 'All songs'),
      likedChip,
      state.playlists.length ? chip('', 'No playlist') : null,
      ...state.playlists.map((p) => chip(p, p)),
      h('button', { class: 'chip music-pl-add', 'data-tip': 'New playlist', onclick: () => newPlaylist() }, icon('plus', 'sm'), state.playlists.length ? null : 'New playlist'));
    ui.pls.querySelector('.music-pl.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---------------------------------------------------------------- big layout: full screen, or the Music tab
  // The player is one element. Normally it's the drop-down under the ♪ button (or docked in the right sidebar);
  // while the Music tab is showing it lays out big inside that tab, and full screen puts it over everything.
  let full = null; // the full-screen overlay
  let tabHost = null; // the Music tab's page, while that tab is showing
  let dockHost = null; // the right-sidebar panel, when the player is docked there
  let wide = null; // { holder, viz, art, main, side, raf } while laid out big
  let vizData = null;
  const dockNote = h('div', { class: 'music-dock-note' }, h('span', { class: 'music-note' }, '♪'), h('span', {}, 'The player is open in the Music tab'));
  function relayout() {
    if (!ui) return;
    const want = full || tabHost;
    if (wide && wide.holder === want) { render(); return; }
    if (wide) {
      cancelAnimationFrame(wide.raf);
      ui.el.classList.remove('full');
      ui.el.append(...ui.parts); // back in their usual order
      wide.main.remove();
      wide.side.remove();
      wide.viz.remove();
      wide = null;
    }
    if (want) {
      const viz = h('canvas', { class: 'music-viz' });
      const art = h('div', { class: 'music-art' }, h('span', {}, '♪'));
      const main = h('div', { class: 'music-full-main' }, art, ui.nowEl, ui.timeEl, ui.controlsEl, ui.volEl, ui.eqWrap);
      const side = h('div', { class: 'music-full-side' }, ui.tabs, ui.pls, ui.list);
      ui.el.classList.add('full');
      ui.el.append(main, side);
      ui.el.hidden = false;
      want.append(viz, ui.el);
      wide = { holder: want, viz, art, main, side };
      if (dockHost) dockHost.append(dockNote);
      drawViz();
      refresh();
    } else {
      dockNote.remove();
      if (state.docked && dockHost) { dockHost.append(ui.el); ui.el.hidden = false; } else { document.body.append(ui.el); ui.el.hidden = !state.open; }
    }
    render();
  }
  function setFull(on) {
    if (!ui || !!full === on) return;
    if (on) {
      graph();
      full = h('div', { class: 'music-full music-stage' });
      document.body.append(full);
      relayout();
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      const f = full;
      full = null;
      relayout();
      f.remove();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  }
  /** The Music tab shows (host = its page) or hides (null). */
  function showInTab(host) {
    if (!ui) build();
    tabHost = host;
    if (host && state.open && !state.docked) { state.open = false; document.getElementById('btn-music')?.classList.remove('on'); }
    relayout();
  }
  // leaving the window's full screen (Esc, F11) leaves the full-screen player too
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && full) setFull(false); });

  function drawViz() {
    if (!wide) return;
    wide.raf = requestAnimationFrame(drawViz);
    const c = wide.viz;
    const dpr = devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (!analyser || !W || !H) return;
    const n = analyser.frequencyBinCount;
    if (!vizData || vizData.length !== n) vizData = new Uint8Array(n);
    analyser.getByteFrequencyData(vizData);
    const bars = 72;
    const used = Math.floor(n * 0.72);
    const bw = W / bars;
    g.fillStyle = themeGradient(g, W);
    let bass = 0;
    for (let i = 0; i < bars; i++) {
      // low notes get more room (spaced roughly like pitch, not like raw frequency)
      const lo = Math.floor(Math.pow(i / bars, 1.7) * used);
      const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / bars, 1.7) * used));
      let v = 0;
      for (let k = lo; k < hi; k++) v = Math.max(v, vizData[k]);
      if (i < 6) bass += v / 6;
      const bh = Math.max(2 * dpr, (v / 255) ** 1.4 * H * 0.95);
      const x = i * bw + bw * 0.18;
      g.globalAlpha = 0.85;
      g.fillRect(x, H - bh, bw * 0.64, bh);
    }
    g.globalAlpha = 1;
    wide.holder.style.setProperty('--beat', audio.paused ? '0' : (bass / 255).toFixed(3));
  }

  // ---------------------------------------------------------------- queue
  function saveQueue() { app.saveSettings({ musicQueue: [...state.queue] }); render(); }
  function enqueue(name, front = false) {
    if (front) state.queue.unshift(name); else state.queue.push(name);
    saveQueue();
    toast(front ? `Plays next: ${songTitle(name)}` : `Added to the queue: ${songTitle(name)}`, { timeout: 1600 });
  }
  function setView(v) { state.view = v; app.saveSettings({ musicView: v }); render(); }

  // ---------------------------------------------------------------- panel UI
  function build() {
    const el = h('div', { class: 'music-pop', hidden: true });
    el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', (e) => { if (e.target === el) el.classList.remove('drop'); });
    el.addEventListener('drop', (e) => { el.classList.remove('drop'); if (e.dataTransfer.files.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } });
    const title = h('div', { class: 'music-title' });
    const sub = h('div', { class: 'music-sub mono faint' });
    const seek = h('input', { type: 'range', class: 'music-seek', min: '0', max: '1000', value: '0' });
    let seeking = false;
    seek.addEventListener('input', () => { seeking = true; cur.textContent = fmt((seek.value / 1000) * (audio.duration || 0)); });
    seek.addEventListener('change', () => { if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration; seeking = false; });
    // the wheel skips 5 s a notch (1 s with Shift), up is forward
    seek.addEventListener('wheel', (e) => {
      const d = e.deltaY || e.deltaX;
      if (!d || !audio.duration) return;
      e.preventDefault();
      audio.currentTime = Math.max(0, Math.min(audio.duration - 0.05, audio.currentTime + (d < 0 ? 1 : -1) * (e.shiftKey ? 1 : 5)));
      seek.value = String((audio.currentTime / audio.duration) * 1000);
      cur.textContent = fmt(audio.currentTime);
    }, { passive: false });
    const cur = h('span', { class: 'mono' }, '0:00');
    const dur = h('span', { class: 'mono' }, '0:00');
    const btn = (ic, tip, fn, cls = '') => h('button', { class: `icon-btn music-btn ${cls}`, 'data-tip': tip, onclick: fn }, icon(ic));
    const shuffleB = btn('shuffle', 'Shuffle', () => setShuffle(!state.shuffle));
    const loopB = btn('repeat', 'Loop: all', () => cycleLoop());
    const likeB = btn('heart', 'Like this song', () => toggleLike(state.tracks[state.idx]?.name), 'music-like-btn');
    const playB = h('button', { class: 'music-play', 'data-tip': 'Play / pause (Space when this is open)', onclick: () => toggle() }, icon('play'));
    const vol = h('input', { type: 'range', class: 'music-vol', min: '0', max: '1', step: '0.01', value: String(state.volume) });
    vol.addEventListener('input', () => setVolume(Number(vol.value)));
    wheelSlider(vol, 0.05);
    // mixer: response curve + low/high cut + 10 bands + presets
    const eqWrap = h('div', { class: 'music-eq', hidden: !s.musicMixerOpen });
    const curve = h('canvas', { class: 'music-curve', width: '620', height: '150' });
    const drawCurve = () => drawEqCurve(curve, state, ctx);
    // switching theme redraws the curve in the new colours
    new MutationObserver(() => { if (curve.isConnected) drawCurve(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    const lowR = h('input', { type: 'range', min: '0', max: '1000', value: String(hzToPos(state.low)), class: 'music-cut' });
    const highR = h('input', { type: 'range', min: '0', max: '1000', value: String(hzToPos(state.high)), class: 'music-cut' });
    const lowV = h('span', { class: 'mono music-cut-val' });
    const highV = h('span', { class: 'mono music-cut-val' });
    const showCuts = () => {
      lowV.textContent = state.low <= MIN_HZ + 1 ? 'off' : `${hzLabel(state.low)} Hz`;
      highV.textContent = state.high >= MAX_HZ - 50 ? 'off' : `${hzLabel(state.high)} Hz`;
      lowR.value = String(hzToPos(state.low));
      highR.value = String(hzToPos(state.high));
    };
    lowR.addEventListener('input', () => { setCuts({ low: posToHz(Number(lowR.value)) }, false); showCuts(); markPreset(); drawCurve(); });
    lowR.addEventListener('change', () => setCuts({}, true));
    wheelSlider(lowR, 20); wheelSlider(highR, 20);
    highR.addEventListener('input', () => { setCuts({ high: posToHz(Number(highR.value)) }, false); showCuts(); markPreset(); drawCurve(); });
    highR.addEventListener('change', () => setCuts({}, true));
    const eqSliders = BANDS.map(([freq], i) => {
      const r = h('input', { type: 'range', class: 'music-eq-slider', min: '-18', max: '18', step: '0.5', value: String(state.eq[i]) });
      const val = h('span', { class: 'mono music-eq-val' });
      const show = () => { val.textContent = `${state.eq[i] > 0 ? '+' : ''}${state.eq[i]}`; r.value = String(state.eq[i]); };
      r.addEventListener('input', () => { setEq(i, Number(r.value), false); show(); markPreset(); drawCurve(); });
      r.addEventListener('change', () => setEq(i, Number(r.value)));
      r.addEventListener('dblclick', () => { setEq(i, 0); show(); markPreset(); drawCurve(); });
      wheelSlider(r, 1);
      show();
      return { show, el: h('div', { class: 'music-eq-band' }, val, h('div', { class: 'music-eq-track' }, r), h('span', { class: 'mono faint music-eq-hz' }, hzLabel(freq))) };
    });
    const applyPreset = (p) => {
      p.eq.forEach((db, i) => setEq(i, db, false));
      setCuts({ low: p.low, high: p.high }, false);
      eqSliders.forEach((x) => x.show());
      showCuts();
      app.saveSettings({ musicEq: [...state.eq], musicLowCut: state.low, musicHighCut: state.high });
      markPreset();
      drawCurve();
    };
    // presets: a dropdown of the built-in ones and your own (saved in settings as musicEqPresets { name: { eq, low, high } })
    const mine = () => {
      const m = app.settings.musicEqPresets;
      return m && typeof m === 'object' ? Object.fromEntries(Object.entries(m).filter(([, p]) => Array.isArray(p?.eq) && p.eq.length === NB)) : {};
    };
    const same = (p) => p.eq.every((v, i) => v === state.eq[i]) && Math.abs(p.low - state.low) < 2 && Math.abs(p.high - state.high) < 30;
    const presetSel = h('select', { class: 'music-preset-sel', 'data-tip': 'EQ preset' });
    const delB = h('button', { class: 'btn sm ghost', 'data-tip': 'Delete this preset of yours', onclick: () => deletePreset() }, icon('trash', 'sm'));
    const saveB = h('button', { class: 'btn sm', 'data-tip': 'Save the current mixer settings as a preset', onclick: () => savePreset() }, icon('plus', 'sm'), 'Save preset');
    const fillPresets = () => {
      const own = mine();
      clear(presetSel).append(
        h('option', { value: '', hidden: true }, 'Custom (unsaved)'),
        h('optgroup', { label: 'Presets' }, Object.keys(PRESETS).map((n) => h('option', { value: `b:${n}` }, n))),
        Object.keys(own).length ? h('optgroup', { label: 'Yours' }, Object.keys(own).map((n) => h('option', { value: `u:${n}` }, n))) : null);
    };
    presetSel.addEventListener('change', () => {
      const [kind, name] = [presetSel.value.slice(0, 1), presetSel.value.slice(2)];
      const p = kind === 'b' ? PRESETS[name] : mine()[name];
      if (p) applyPreset(p);
    });
    const savePreset = async () => {
      const cur = presetSel.value.startsWith('u:') ? presetSel.value.slice(2) : '';
      const name = (await promptDialog('Save EQ preset', 'Name', cur, { placeholder: 'e.g. Car speakers' }))?.trim();
      if (!name) return;
      if (PRESETS[name]) { toast(`“${name}” is a built-in preset; pick another name.`); return; }
      const own = mine();
      if (own[name] && name !== cur && !await confirmDialog('Replace preset?', `You already have a preset called “${name}”. Replace it?`, { okLabel: 'Replace' })) return;
      await app.saveSettings({ musicEqPresets: { ...own, [name]: { eq: [...state.eq], low: state.low, high: state.high } } });
      fillPresets();
      markPreset();
    };
    const deletePreset = async () => {
      if (!presetSel.value.startsWith('u:')) return;
      const name = presetSel.value.slice(2);
      if (!await confirmDialog('Delete preset?', `Delete your EQ preset “${name}”? The mixer keeps its current settings.`, { okLabel: 'Delete', danger: true })) return;
      const own = mine();
      delete own[name];
      await app.saveSettings({ musicEqPresets: own });
      fillPresets();
      markPreset();
    };
    const presetRow = h('div', { class: 'music-presets' }, h('span', { class: 'dim' }, 'Preset'), presetSel, saveB, delB);
    function markPreset() {
      // shows the preset that matches the sliders (yours first if one of yours matches), or "Custom (unsaved)"
      const u = Object.entries(mine()).find(([, p]) => same(p))?.[0];
      const b = Object.entries(PRESETS).find(([, p]) => same(p))?.[0];
      presetSel.value = u ? `u:${u}` : b ? `b:${b}` : '';
      delB.hidden = !u;
    }
    fillPresets();
    showCuts();
    markPreset();
    eqWrap.append(
      curve,
      h('div', { class: 'music-cuts' },
        h('label', {}, h('span', {}, 'Low cut'), lowR, lowV),
        h('label', {}, h('span', {}, 'High cut'), highR, highV)),
      h('div', { class: 'music-eq-bands' }, eqSliders.map((x) => x.el)),
      presetRow,
      h('div', { class: 'faint', style: { fontSize: '10.5px' } }, 'Low cut removes the bass, high cut removes the treble — cut both for a tinny phone sound. Double-click a band to zero it.'));
    const mixerB = h('button', { class: `chip music-mixer-btn ${s.musicMixerOpen ? 'on' : ''}`, onclick: () => { eqWrap.hidden = !eqWrap.hidden; mixerB.classList.toggle('on', !eqWrap.hidden); app.saveSettings({ musicMixerOpen: !eqWrap.hidden }); if (!eqWrap.hidden) requestAnimationFrame(drawCurve); } }, icon('sliders', 'sm'), 'Mixer');
    requestAnimationFrame(drawCurve);
    const list = h('div', { class: 'music-list' });
    const libTab = h('button', { class: 'music-tab', onclick: () => setView('library') });
    const queueTab = h('button', { class: 'music-tab', onclick: () => setView('queue'), 'data-tip': 'Drop a song here to add it to the queue' });
    // drag a library song onto the Queue tab to add it
    queueTab.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/bds-song')) { e.preventDefault(); queueTab.classList.add('drop'); } });
    queueTab.addEventListener('dragleave', () => queueTab.classList.remove('drop'));
    queueTab.addEventListener('drop', (e) => { queueTab.classList.remove('drop'); const n = e.dataTransfer.getData('text/bds-song'); if (n) { e.preventDefault(); enqueue(n); } });
    const tabs = h('div', { class: 'music-tabs' }, libTab, queueTab);
    const dupeBtn = h('button', { class: 'music-dupes', hidden: true, 'data-tip': 'Songs that are in the audio dump more than once', onclick: () => showDuplicates() });
    const pls = h('div', { class: 'music-pls' });
    pls.addEventListener('wheel', (e) => { if (e.deltaY && pls.scrollWidth > pls.clientWidth) { e.preventDefault(); pls.scrollLeft += e.deltaY; } }, { passive: false });
    const fullB = h('button', { class: 'icon-btn music-full-btn', 'data-tip': 'Full screen', onclick: () => setFull(!full) }, icon('maximize', 'sm'));
    const head = h('div', { class: 'music-head' }, h('span', { class: 'music-note' }, '♪'), h('span', { class: 'mono' }, 'audio-dump/'), h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', 'data-tip': 'Add songs', onclick: () => addFromDisk() }, icon('plus', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': `${app.toolName?.('BoxTape') || 'BoxTape'}: songs from a YouTube or Spotify playlist`, onclick: () => app.newDocument('tape') }, icon('download', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Import a playlist a friend shared (a code or a .plylst file)', onclick: () => overDialog(async () => { if (await importPlaylist(app) && !state.docked) setOpen(false); }) }, icon('inbox', 'sm')),
      dupeBtn,
      h('button', { class: 'icon-btn', 'data-tip': 'Refresh', onclick: () => refresh() }, icon('refresh', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Open the folder', onclick: () => api.dumpReveal('audio', state.playlist && state.playlist !== LIKED ? state.playlist : undefined) }, icon('external', 'sm')),
      h('button', { class: 'icon-btn music-tab-btn', 'data-tip': 'Open as a tab', onclick: () => { setOpen(false); app.newDocument('music'); } }, icon('window', 'sm')),
      fullB,
      h('button', { class: 'icon-btn', 'data-tip': 'Close (music keeps playing)', onclick: () => setOpen(false) }, icon('x', 'sm')));
    const tagsEl = h('div', { class: 'music-tags mono', hidden: true });
    const nowEl = h('div', { class: 'music-now' }, title, tagsEl, sub);
    const timeEl = h('div', { class: 'music-time' }, cur, seek, dur);
    const controlsEl = h('div', { class: 'music-controls' }, shuffleB, btn('skip-back', 'Previous', () => prev()), playB, btn('skip-forward', 'Next', () => next()), loopB, likeB, btn('quote', 'Lyrics (looked up on LRCLIB)', () => toggleLyrics(), 'music-lyrics'));
    const volEl = h('div', { class: 'music-volrow' }, icon('volume', 'sm'), vol, mixerB);
    const parts = [head, nowEl, timeEl, controlsEl, volEl, eqWrap, tabs, pls, list];
    el.append(...parts);
    document.body.append(el);
    ui = { el, title, tagsEl, sub, seek, cur, dur, playB, shuffleB, loopB, likeB, list, dupeBtn, libTab, queueTab, pls, tabs, fullB, nowEl, timeEl, controlsEl, volEl, eqWrap, parts, isSeeking: () => seeking };
    document.addEventListener('pointerdown', (e) => { if (state.open && !state.docked && !wide && performance.now() - state.openedAt > 250 && !el.contains(e.target) && !e.target.closest?.('#btn-music, .music-opener')) setOpen(false); }, true);
    document.addEventListener('keydown', (e) => {
      if (full && e.key === 'Escape' && !document.querySelector('.modal-backdrop, .menu')) { e.preventDefault(); setFull(false); return; }
      if ((!state.open && !wide) || ((state.docked || wide) && !el.contains(e.target) && e.target !== document.body)) return;
      if (e.key === 'Escape' && !state.docked && !wide) setOpen(false);
      // in the video editor (or a video tab) Space is that video's, unless you're clicked into the player itself
      if (e.key === ' ' && ['cut', 'video'].includes(app.active?.mode) && !el.contains(e.target)) return;
      if (e.key === ' ' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.isContentEditable) { e.preventDefault(); toggle(); }
    });
  }

  function updateTime() {
    if (!ui || (!state.open && !wide)) return;
    ui.cur.textContent = ui.isSeeking() ? ui.cur.textContent : fmt(audio.currentTime);
    ui.dur.textContent = fmt(audio.duration);
    if (!ui.isSeeking()) ui.seek.value = String(audio.duration ? Math.round((audio.currentTime / audio.duration) * 1000) : 0);
  }

  /** The playing song's genre and BPM under its title, from its tags (BoxTape writes them); hidden when it has neither. */
  const songTags = new Map();
  async function showTags(t) {
    const el = ui.tagsEl;
    const paint = (tags) => {
      if (state.tracks[state.idx] !== t) return; // moved on to another song meanwhile
      const bits = [tags?.genre, tags?.bpm && `${tags.bpm} BPM`].filter(Boolean);
      el.hidden = !bits.length;
      clear(el).append(...bits.flatMap((b, i) => (i ? [h('span', { class: 'faint' }, ' · '), b] : [b])));
    };
    if (!t?.path || !/.mp3$/i.test(t.path)) return paint(null);
    if (songTags.has(t.path)) return paint(songTags.get(t.path));
    paint(null);
    const tags = await api.get(`/api/audio/tags?path=${encodeURIComponent(t.path)}`).catch(() => null);
    songTags.set(t.path, tags);
    paint(tags);
  }

  function render() {
    paintMini();
    if (!ui) return;
    const t = state.tracks[state.idx];
    const vis = visible();
    const plName = state.playlist == null ? '' : state.playlist === LIKED ? 'liked songs' : state.playlist || 'no playlist';
    ui.title.textContent = t ? songTitle(t.name) : state.tracks.length ? 'Pick a song' : 'No songs yet';
    showTags(t);
    const upNext = state.queue[0] ? ` · up next: ${songTitle(state.queue[0])}` : '';
    const at = vis.indexOf(state.idx);
    ui.sub.textContent = t ? `${at >= 0 ? `${at + 1} of ${vis.length}` : plOf(t.name) ? `from “${plOf(t.name)}”` : 'not in this playlist'}${plName ? ` · ${plName}` : ''}${upNext}`
      : state.tracks.length ? `${vis.length} song${vis.length === 1 ? '' : 's'}${plName ? ` in ${plName}` : ' in the audio dump'}` : 'drop mp3s here or put them in Box-Deckspitter\\audio-dump';
    clear(ui.libTab).append(state.playlist === LIKED ? 'Liked ' : state.playlist ? 'Playlist ' : 'Library ', h('span', { class: 'mono faint' }, String(vis.length)));
    ui.pls.hidden = state.view !== 'library' || !state.tracks.length && !state.playlists.length;
    if (!ui.pls.hidden) renderPlaylists();
    ui.fullB.dataset.tip = full ? 'Leave full screen (Esc)' : 'Full screen';
    clear(ui.fullB).append(icon(full ? 'x' : 'maximize', 'sm'));
    if (wide) {
      // each song gets its own cover from the theme's three accents: its own order, angle and a small hue nudge
      let hsh = 0;
      for (const ch of t?.name || '') hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
      const order = [['--accent', '--accent-2', '--accent-3'], ['--accent-2', '--accent', '--accent-3'], ['--accent-3', '--accent', '--accent-2'],
        ['--accent', '--accent-3', '--accent-2'], ['--accent-2', '--accent-3', '--accent'], ['--accent-3', '--accent-2', '--accent']][hsh % 6];
      order.forEach((v, i) => wide.art.style.setProperty('--c' + (i + 1), `var(${v})`));
      wide.art.style.setProperty('--angle', (90 + ((hsh >>> 3) % 180)) + 'deg');
      wide.art.style.setProperty('--shift', (((hsh >>> 11) % 25) - 12) + 'deg');
    }
    clear(ui.queueTab).append('Queue ', h('span', { class: 'mono faint' }, String(state.queue.length)));
    ui.libTab.classList.toggle('on', state.view === 'library');
    ui.queueTab.classList.toggle('on', state.view === 'queue');
    clear(ui.playB).append(icon(audio.paused ? 'play' : 'pause-bars'));
    ui.shuffleB.classList.toggle('active', state.shuffle);
    const likedNow = !!t && isLiked(t.name);
    ui.likeB.classList.toggle('active', likedNow);
    ui.likeB.disabled = !t;
    ui.likeB.dataset.tip = likedNow ? 'Unlike this song' : 'Like this song';
    clear(ui.likeB).append(icon(likedNow ? 'heart-fill' : 'heart'));
    ui.loopB.classList.toggle('active', state.loop !== 'off');
    clear(ui.loopB).append(icon(state.loop === 'one' ? 'repeat-1' : 'repeat'));
    ui.loopB.dataset.tip = `Loop: ${state.loop === 'one' ? 'this song' : state.loop === 'all' ? 'all songs' : 'off'}`;
    clear(ui.list);
    if (state.view === 'queue') { renderQueue(); updateTime(); return; }
    if (!state.tracks.length) {
      ui.list.append(h('div', { class: 'music-empty' }, 'Drop music files here, use ', h('b', {}, '+'), ', or put files in the ', h('span', { class: 'mono' }, 'audio-dump'), ' folder (', h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.dumpReveal('audio'); } }, 'open it'), ').'));
    }
    if (state.tracks.length && !vis.length && state.playlist === LIKED) {
      ui.list.append(h('div', { class: 'music-empty' }, 'No liked songs yet. Click the ', icon('heart', 'sm'), ' on a song, or under the song that’s playing.'));
    } else if (state.tracks.length && !vis.length) {
      ui.list.append(h('div', { class: 'music-empty' }, state.playlist ? 'Nothing in this playlist yet. Drag songs from All songs onto its name above, right-click a song → ' : 'Every song is in a playlist. ',
        state.playlist ? h('b', {}, 'Move to playlist') : null, state.playlist ? ', or drop music files here.' : null));
    }
    vis.forEach((i, k) => {
      const tr = state.tracks[i];
      const nameEl = h('span', { class: 'music-track-name' }, songTitle(tr.name));
      const qAdd = h('span', { class: 'music-qadd', role: 'button', title: 'Add to the queue' }, icon('plus', 'sm'));
      qAdd.addEventListener('click', (e) => { e.stopPropagation(); enqueue(tr.name); });
      const liked = isLiked(tr.name);
      const likeB = h('span', { class: `music-like ${liked ? 'on' : ''}`, role: 'button', title: liked ? 'Unlike' : 'Like' }, icon(liked ? 'heart-fill' : 'heart', 'sm'));
      likeB.addEventListener('click', (e) => { e.stopPropagation(); toggleLike(tr.name); });
      const row = h('button', { class: `music-track ${i === state.idx ? 'on' : ''}`, draggable: 'true', title: `${tr.name} · ${formatBytes(tr.size)}\nF2: rename · Del: remove · drag onto Queue to queue it` },
        h('span', { class: 'music-track-n mono' }, i === state.idx && !audio.paused ? '♪' : String(k + 1)),
        nameEl, (state.playlist == null || state.playlist === LIKED) && plOf(tr.name) ? h('span', { class: 'music-track-pl' }, plOf(tr.name)) : null, likeB, qAdd);
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/bds-song', tr.name); e.dataTransfer.effectAllowed = 'copy'; });
      const remove = async () => {
        if (i === state.idx) { audio.pause(); audio.removeAttribute('src'); audio.load(); state.idx = -1; }
        try { await api.dumpRemove(tr.name, 'audio'); toast(`Moved ${tr.name} to audio-dump\\.removed`, { timeout: 3000 }); refresh(); } catch (err) { errorToast(err); }
      };
      hoverKeys(row, { nameEl, value: () => songTitle(tr.name), commit: (n) => renameTrack(i, n), remove });
      row.addEventListener('click', () => (i === state.idx ? toggle() : play(i)));
      row.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Play', icon: 'play', action: () => play(i) },
        { label: 'Play next', icon: 'skip-forward', action: () => enqueue(tr.name, true) },
        { label: 'Add to queue', icon: 'plus', action: () => enqueue(tr.name) },
        { label: isLiked(tr.name) ? 'Unlike' : 'Like', icon: isLiked(tr.name) ? 'heart-fill' : 'heart', action: () => toggleLike(tr.name) },
        { sep: true },
        { label: 'Move to playlist', icon: 'folder', submenu: [
          ...state.playlists.filter((p) => p !== plOf(tr.name)).map((p) => ({ label: p, action: () => moveSongs([tr.name], p) })),
          ...(plOf(tr.name) ? [{ label: 'Out of the playlist', icon: 'x', action: () => moveSongs([tr.name], '') }] : []),
          ...(state.playlists.length ? [{ sep: true }] : []),
          { label: 'New playlist…', icon: 'plus', action: () => newPlaylist([tr.name]) },
        ] },
        { label: 'Rename…', icon: 'edit', shortcut: 'F2', action: () => renameInline(row) },
        { label: 'Show in Explorer', icon: 'external', action: () => api.dumpReveal('audio', tr.name) },
        { label: 'Remove from audio dump', icon: 'trash', shortcut: 'Del', action: remove },
      ]));
      ui.list.append(row);
    });
    updateTime();
  }

  /** Drag-to-reorder for one list of rows. move(from, to) gets the new position (already adjusted for the removal). */
  function sortable(rows, kind, move, { acceptSong = null } = {}) {
    let from = -1;
    rows.forEach((row, i) => {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => { from = i; row.classList.add('dragging'); e.dataTransfer.setData(kind, String(i)); e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragend', () => { from = -1; row.classList.remove('dragging'); rows.forEach((r) => r.classList.remove('drop-before', 'drop-after')); });
      row.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes(kind) && !(acceptSong && e.dataTransfer.types.includes('text/bds-song'))) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        rows.forEach((o) => o.classList.remove('drop-before', 'drop-after'));
        row.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
      });
      row.addEventListener('drop', (e) => {
        const after = row.classList.contains('drop-after');
        rows.forEach((o) => o.classList.remove('drop-before', 'drop-after'));
        let to = i + (after ? 1 : 0);
        if (e.dataTransfer.types.includes(kind) && from >= 0) {
          e.preventDefault();
          if (from < to) to--;
          if (from !== to) move(from, to);
        } else if (acceptSong) {
          const song = e.dataTransfer.getData('text/bds-song');
          if (song) { e.preventDefault(); acceptSong(song, to); }
        }
        from = -1;
      });
    });
  }

  const qRow = (n, name, extra = null) => h('div', { class: 'music-q-row', title: name },
    h('span', { class: 'music-q-grip' }, icon('grip', 'sm')),
    h('span', { class: 'music-track-n mono' }, String(n)),
    h('span', { class: 'music-track-name' }, songTitle(name)), extra);

  /** The Queue tab: what's playing, songs you queued, then (with shuffle on) the shuffled library. All draggable. */
  function renderQueue() {
    const L = ui.list;
    const now = state.tracks[state.idx];
    if (now) L.append(h('div', { class: 'music-q-now' }, h('span', { class: 'faint' }, audio.paused ? 'Paused' : 'Now playing'), h('span', {}, songTitle(now.name))));

    // songs you queued
    if (state.queue.length) {
      L.append(h('div', { class: 'music-q-head' }, h('span', { class: 'faint' }, 'Up next · drag to reorder'), h('div', { class: 'grow' }),
        h('button', { class: 'chip', onclick: () => { state.queue = []; saveQueue(); } }, 'Clear')));
      const rows = state.queue.map((name, qi) => {
        const x = h('span', { class: 'music-q-x', role: 'button', title: 'Remove from the queue' }, icon('x', 'sm'));
        x.addEventListener('click', (e) => { e.stopPropagation(); state.queue.splice(qi, 1); saveQueue(); });
        const row = qRow(qi + 1, name, x);
        row.addEventListener('click', () => {
          const i = state.tracks.findIndex((t) => t.name === name);
          state.queue.splice(qi, 1);
          saveQueue();
          if (i >= 0) play(i, { fromQueue: true });
        });
        return row;
      });
      sortable(rows, 'text/bds-queue', (from, to) => { const [m] = state.queue.splice(from, 1); state.queue.splice(to, 0, m); saveQueue(); },
        { acceptSong: (song, to) => { state.queue.splice(to, 0, song); saveQueue(); } });
      L.append(...rows);
    } else if (!state.shuffle) {
      L.append(h('div', { class: 'music-empty' }, 'The queue is empty. In the library, right-click a song → ', h('b', {}, 'Add to queue'), ' or ', h('b', {}, 'Play next'), ', hover it and click ', h('b', {}, '+'), ', or drag it onto the Queue tab. After the queue, the library carries on.'));
      return;
    }

    // with shuffle on: the order the library will play in, which you can rearrange
    if (!state.shuffle || !state.tracks.length) return;
    const base = state.order.indexOf(state.libIdx >= 0 ? state.libIdx : state.idx);
    const upcoming = [...state.order.slice(base + 1), ...(state.loop === 'all' ? state.order.slice(0, Math.max(0, base)) : [])];
    L.append(h('div', { class: 'music-q-head' }, h('span', { class: 'faint' }, `${state.queue.length ? 'Then from' : 'Up next from'} ${state.playlist === LIKED ? 'your liked songs' : state.playlist ? `“${state.playlist}”` : state.playlist === '' ? 'songs not in a playlist' : 'the library'} (shuffled) · drag to reorder`), h('div', { class: 'grow' }),
      h('button', { class: 'chip', title: 'Deal a new random order', onclick: () => { reshuffle(true); render(); } }, icon('shuffle', 'sm'), 'Reshuffle')));
    if (!upcoming.length) { L.append(h('div', { class: 'music-empty' }, state.loop === 'off' ? 'That’s the last song — turn on Loop to keep going.' : 'Nothing else to play.')); return; }
    const shown = upcoming.slice(0, 300);
    const rows = shown.map((ti, k) => {
      const row = qRow(state.queue.length + k + 1, state.tracks[ti].name);
      row.classList.add('shuffled');
      row.addEventListener('click', () => play(ti)); // jump there; the shuffle carries on from it
      return row;
    });
    sortable(rows, 'text/bds-shuffle', (from, to) => {
      // move within the upcoming list, then write it back into the full play order
      const up = [...shown];
      const [m] = up.splice(from, 1);
      up.splice(to, 0, m);
      const rest = upcoming.slice(shown.length);
      const head = state.order.slice(0, base + 1).filter((x) => !upcoming.includes(x));
      state.order = [...head, ...up, ...rest];
      // songs that wrapped around (loop all) now come after the current one; keep the current song where it is
      const cur = state.libIdx >= 0 ? state.libIdx : state.idx;
      if (cur >= 0 && !state.order.includes(cur)) state.order.unshift(cur);
      saveOrder();
      render();
    }, { acceptSong: null });
    L.append(...rows);
    if (upcoming.length > shown.length) L.append(h('div', { class: 'music-empty' }, `…and ${upcoming.length - shown.length} more`));
  }

  async function renameTrack(i, name) {
    const tr = state.tracks[i];
    const ext = extOf(tr.name);
    const to = ext && !name.toLowerCase().endsWith('.' + ext.toLowerCase()) ? `${name}.${ext}` : name;
    // a name without "/" stays in the same playlist
    const r = await api.dumpRename(tr.name, to, 'audio');
    await relocate([[tr.name, r.name || to]]);
  }

  function position() {
    const b = document.getElementById('btn-music')?.getBoundingClientRect();
    if (!b || !ui || state.docked) return;
    ui.el.style.top = Math.round(b.bottom + 6) + 'px';
    ui.el.style.right = Math.max(8, Math.round(innerWidth - b.right - 8)) + 'px';
  }

  function setOpen(open) {
    if (!ui) build();
    if (wide && !state.docked) return; // it's showing big (the Music tab or full screen)
    state.open = open;
    if (open) state.openedAt = performance.now();
    ui.el.hidden = !open;
    document.getElementById('btn-music')?.classList.toggle('on', open);
    if (open) { position(); refresh(); }
  }
  addEventListener('resize', () => { if (state.open) position(); });

  /** Docked: the player lives inside `host` (a right-side panel) instead of floating under the ♪ button. */
  function dockInto(host) {
    if (!ui) build();
    state.docked = !!host;
    dockHost = host || null;
    ui.el.classList.toggle('docked', !!host);
    if (wide) {
      // showing big right now: it goes to the sidebar when the tab / full screen is done
      state.open = !!host;
      if (host) host.append(dockNote); else dockNote.remove();
      return;
    }
    if (host) {
      host.append(ui.el);
      state.open = true;
      ui.el.hidden = false;
      document.getElementById('btn-music')?.classList.remove('on');
      refresh();
    } else {
      document.body.append(ui.el);
      state.open = false;
      ui.el.hidden = true;
    }
  }

  // ---------------------------------------------------------------- the pop-out widget
  // Drag the ♪ button (from the top bar or the right sidebar) out onto the page and a small player stays there: the
  // song, a progress bar to click along, and previous / play / next. Drag it to move it; let go over the right
  // sidebar or the top bar and it folds back into the ♪ button there. A click opens the full player.
  let mini = null;
  const miniCfg = () => app.settings.musicMini || {};
  function setMini(patch) {
    app.saveSettings({ musicMini: { ...miniCfg(), ...patch } });
    syncMini();
  }
  function buildMini() {
    const btn = (ic, tip, fn, cls = '') => {
      const b = h('button', { class: `mm-btn ${cls}`, 'data-tip': tip }, icon(ic, 'sm'));
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    const fill = h('div', { class: 'mm-fill' });
    const bar = h('div', { class: 'mm-bar', 'data-tip': 'Click to jump there' }, fill);
    bar.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.button !== 0 || !audio.duration) return;
      const r = bar.getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audio.duration;
      miniTime();
    });
    mini = {
      title: h('div', { class: 'mm-title' }), sub: h('div', { class: 'mm-sub faint' }), fill, time: h('span', { class: 'mm-time mono faint' }),
      playB: btn('play', 'Play / pause', () => toggle(), 'mm-play'),
      likeB: btn('heart', 'Like this song', () => toggleLike(state.tracks[state.idx]?.name), 'mm-like'),
    };
    mini.el = h('div', { class: 'music-mini', tabindex: '0' },
      h('div', { class: 'mm-top' }, h('span', { class: 'mm-note' }, '♪'), h('div', { class: 'mm-text' }, mini.title, mini.sub),
        btn('x', 'Close the small player', () => setMini({ on: false }), 'mm-x')),
      bar,
      h('div', { class: 'mm-controls' }, mini.time, h('div', { class: 'grow' }), btn('quote', 'Lyrics', () => toggleLyrics(), 'mm-lyrics'), mini.likeB, btn('skip-back', 'Previous', () => prev()), mini.playB, btn('skip-forward', 'Next', () => next())));
    mini.el.title = 'Click for the full player · drag to move, or onto the right sidebar or the top bar to fold it back into the ♪ button';
    mini.el.addEventListener('pointerdown', dragMini);
    mini.el.addEventListener('dragstart', (e) => e.preventDefault()); // the browser's own drag would cancel ours
  }
  function syncMini() {
    if (!miniCfg().on || app.mainWindow === false) { mini?.el.remove(); app.syncMusicHome?.(); return; }
    if (!mini) buildMini();
    if (mini.el.parentElement !== document.body) document.body.append(mini.el);
    paintMini();
    placeMini();
    app.syncMusicHome?.(); // it stands in for the ♪ button while it's out
  }
  function paintMini() {
    if (!mini?.el.isConnected) return;
    const t = state.tracks[state.idx];
    mini.title.textContent = t ? songTitle(t.name) : state.tracks.length ? 'Pick a song' : 'No songs yet';
    mini.sub.textContent = t ? (plOf(t.name) || 'audio-dump') : 'click to open the player';
    clear(mini.playB).append(icon(audio.paused ? 'play' : 'pause-bars', 'sm'));
    const liked = !!t && isLiked(t.name);
    clear(mini.likeB).append(icon(liked ? 'heart-fill' : 'heart', 'sm'));
    mini.likeB.classList.toggle('on', liked);
    mini.likeB.dataset.tip = liked ? 'Unlike this song' : 'Like this song';
    mini.el.classList.toggle('playing', !audio.paused);
    miniTime();
  }
  function miniTime() {
    if (!mini?.el.isConnected) return;
    mini.fill.style.width = `${audio.duration ? (audio.currentTime / audio.duration) * 100 : 0}%`;
    mini.time.textContent = audio.duration ? `${fmt(audio.currentTime)} / ${fmt(audio.duration)}` : '';
  }
  function placeMini(x = miniCfg().x, y = miniCfg().y) {
    if (!mini?.el.isConnected) return;
    const w = mini.el.offsetWidth || 240, ht = mini.el.offsetHeight || 90;
    x ??= innerWidth - w - 50;
    y ??= innerHeight - ht - 60;
    mini.el.style.left = `${Math.max(0, Math.min(innerWidth - w, x))}px`;
    mini.el.style.top = `${Math.max(0, Math.min(innerHeight - ht, y))}px`;
  }
  addEventListener('resize', () => placeMini());
  /** The ♪ button was dragged out and let go at (x, y): the small player appears there. */
  function popOut(x, y) {
    setMini({ on: true });
    const w = mini.el.offsetWidth, ht = mini.el.offsetHeight;
    placeMini(x - w / 2, y - ht / 2);
    const q = mini.el.getBoundingClientRect();
    setMini({ x: Math.round(q.left), y: Math.round(q.top) });
  }
  /** Drag to move; let go on the right sidebar or the top bar to fold it into the ♪ button there; a click opens the player. */
  function dragMini(e) {
    if (e.button !== 0 || e.target.closest('.mm-btn, .mm-bar')) return;
    e.preventDefault();
    const m = mini.el, rail = document.getElementById('rightrail'), top = document.querySelector('.titlebar-actions');
    const sx = e.clientX, sy = e.clientY, r = m.getBoundingClientRect();
    const dx = sx - r.left, dy = sy - r.top;
    let dragging = false;
    try { m.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const over = (z, x, y) => { const q = z?.getBoundingClientRect(); return !!q && x >= q.left - 20 && x <= q.right + 20 && y >= q.top - (z === top ? 20 : 0) && y <= q.bottom + (z === top ? 20 : 0); };
    // the ♪ button where it is now (the sidebar's music tab when it's docked there), for the "it goes here" outlines
    const target = () => (app.settings.musicDock === 'side' ? app.musicRailTab?.() : document.getElementById('btn-music'));
    const move = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        dragging = true;
        m.classList.add('dragging');
        rail.classList.add('fling-target');
        top?.classList.add('fling-target');
      }
      placeMini(ev.clientX - dx, ev.clientY - dy);
      if (rail.classList.contains('rail-empty')) rail.classList.toggle('peek', ev.clientX > innerWidth - 260);
      rail.classList.toggle('fling-hot', over(rail, ev.clientX, ev.clientY));
      top?.classList.toggle('fling-hot', over(top, ev.clientX, ev.clientY));
      const el = target();
      if (el) { app.railMarker?.(ev, el); app.topMarker?.(ev, el); }
    };
    const up = (ev) => {
      m.removeEventListener('pointermove', move);
      m.removeEventListener('pointerup', up);
      m.removeEventListener('pointercancel', up);
      rail.classList.remove('fling-target', 'fling-hot', 'peek');
      top?.classList.remove('fling-target', 'fling-hot');
      m.classList.remove('dragging');
      const el = target();
      if (el) { app.railMarker?.(null, el); app.topMarker?.(null, el); }
      if (!dragging) { (state.docked ? (app.rightPanel !== 'music' && app.toggleRightPanel('music')) : setOpen(true)); return; }
      if (over(rail, ev.clientX, ev.clientY)) {
        setMini({ on: false });
        app.setMusicDock?.(true, { drop: ev, animate: false });
        return;
      }
      if (over(top, ev.clientX, ev.clientY)) {
        setMini({ on: false });
        if (app.settings.musicDock === 'side') app.setMusicDock?.(false);
        app.topMove?.(document.getElementById('btn-music'), ev.clientX);
        return;
      }
      const q = m.getBoundingClientRect();
      setMini({ x: Math.round(q.left), y: Math.round(q.top) });
    };
    m.addEventListener('pointermove', move);
    m.addEventListener('pointerup', up);
    m.addEventListener('pointercancel', up);
  }
  syncMini();

  refresh();
  // songs deleted (or added) in the folder outside the app show up here within a few seconds
  let dumpRev = null;
  setInterval(async () => { // a tiny ask, so it runs even with the window behind Explorer (where you'd delete them)
    try {
      const { rev } = await api.dumpRev('audio');
      if (dumpRev !== null && rev !== dumpRev) refresh();
      dumpRev = rev;
    } catch { /* the server's busy or restarting */ }
  }, 3000);
  /** Play a file from the audio dump by name (used by BoxKlep / BoxTape after a download). */
  async function playByName(name) {
    await refresh();
    const i = state.tracks.findIndex((t) => t.name === name);
    if (i >= 0) play(i);
  }

  return {
    toggleOpen: () => (tabHost ? undefined : state.docked ? app.toggleRightPanel(app.rightPanel === 'music' ? null : 'music') : setOpen(!state.open)),
    open: () => (state.docked ? (app.rightPanel !== 'music' && app.toggleRightPanel('music')) : setOpen(true)),
    dockInto, get docked() { return !!state.docked; },
    popOut, get miniOn() { return !!miniCfg().on && app.mainWindow !== false; }, foldMini: () => setMini({ on: false }),
    /** Playlists (folders in the audio dump), for BoxTape's "save to". */
    get playlists() { return [...state.playlists]; },
    fullscreen: (on = true) => { if (!ui) build(); setFull(on); },
    showInTab,
    refresh, play, playByName, pause, toggle, next, prev, enqueue, get queue() { return [...state.queue]; }, get playing() { return !audio.paused; },
    /** The song that's playing, as a tidy title (no extension or download junk), or null when nothing is. */
    get nowPlaying() {
      const t = !audio.paused && state.tracks[state.idx];
      return t ? songTitle(t.name).replace(JUNK, ' ').replace(/\s*\(\d+\)\s*$/, '').replace(/\s+/g, ' ').trim() || null : null;
    } };
}
