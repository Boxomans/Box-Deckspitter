// ♪ music player for the audio-dump folder: play/pause, skip, shuffle, loop, seek, volume, and a 10-band
// mixer (EQ) running through Web Audio. Keeps playing while the panel is closed; media keys work too.
// A queue (separate from the library, reorder by dragging) plays before the library carries on, and the
// song, position, volume and play/pause survive closing the app, restarts and updates.

import { api } from './api.js';
import { h, clear, formatBytes, stripExt, extOf } from './dom.js';
import { icon } from './icons.js';
import { toast, errorToast, contextMenu, hoverKeys, renameInline, modal } from './ui.js';
import { pickOpen } from './files.js';

// 10-band graphic EQ (±18 dB) between a low cut (high-pass) and a high cut (low-pass).
const BANDS = [
  [31, 'lowshelf'], [62, 'peaking'], [125, 'peaking'], [250, 'peaking'], [500, 'peaking'],
  [1000, 'peaking'], [2000, 'peaking'], [4000, 'peaking'], [8000, 'peaking'], [16000, 'highshelf'],
];
const NB = BANDS.length;
const MIN_HZ = 20;
const MAX_HZ = 20000;
const flat = () => Array(NB).fill(0);
// eq: dB per band · low: low cut Hz (20 = off) · high: high cut Hz (20000 = off)
const PRESETS = {
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
const hzToPos = (hz) => Math.round((Math.log(hz / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ)) * 1000);
const posToHz = (pos) => Math.round(MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, pos / 1000));
const hzLabel = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : String(hz));
const AUDIO_RE = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|weba)$/i;
const fmt = (t) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00');

export function createMusic(app) {
  const s = app.settings;
  const audio = new Audio();
  audio.preload = 'metadata';
  let ctx = null;
  let gain = null;
  let filters = [];
  let lowCut = null;
  let highCut = null;
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
  };
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
    node.connect(highCut).connect(gain).connect(ctx.destination);
  }

  // A steep-ish slope (Q 0.9) so cutting really removes the lows / highs; at the ends they're bypassed.
  function applyCuts() {
    if (!lowCut) return;
    lowCut.frequency.value = state.low <= MIN_HZ + 1 ? 1 : state.low;
    lowCut.Q.value = 0.9;
    highCut.frequency.value = state.high >= MAX_HZ - 50 ? 24000 : state.high;
    highCut.Q.value = 0.9;
  }

  // ---------------------------------------------------------------- playlist
  async function refresh() {
    let items = [];
    let ok = false;
    try { items = (await api.dump('audio')).items; ok = true; } catch { /* ignore */ }
    const current = state.tracks[state.idx]?.name;
    const libName = state.tracks[state.libIdx]?.name;
    state.tracks = items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    state.idx = current ? state.tracks.findIndex((t) => t.name === current) : state.tracks.findIndex((t) => t.name === s.musicLast);
    state.libIdx = libName ? state.tracks.findIndex((t) => t.name === libName) : state.idx;
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
    return stripExt(name).toLowerCase()
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
    ui.dupeBtn.textContent = `${extra} duplicate${extra === 1 ? '' : 's'}`;
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
    const n = state.tracks.length;
    if (!state.shuffle) { state.order = [...Array(n).keys()]; return; }
    const at = new Map(state.tracks.map((t, i) => [t.name, i]));
    const kept = fresh ? [] : (state.orderNames || s.musicShuffleOrder || []).filter((nm) => at.has(nm)).map((nm) => at.get(nm));
    const seen = new Set(kept);
    if (kept.length) {
      state.order = kept;
      for (let i = 0; i < n; i++) if (!seen.has(i)) state.order.splice(Math.floor(Math.random() * (state.order.length + 1)), 0, i);
    } else {
      state.order = [...Array(n).keys()];
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [state.order[i], state.order[j]] = [state.order[j], state.order[i]]; }
      // keep the current song first so shuffle doesn't jump away from it
      if (state.idx >= 0) state.order = [state.idx, ...state.order.filter((x) => x !== state.idx)];
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
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: stripExt(t.name), artist: 'audio-dump', album: 'Box-DocSpitter' });
  }

  /** fromQueue: a queued song doesn't move the library's place, so the library carries on where it was after. */
  function play(i = state.idx < 0 ? (state.order[0] ?? 0) : state.idx, { fromQueue = false } = {}) {
    const t = state.tracks[i];
    if (!t) { toast('Put some music in the audio dump first — drop files on the player or use Add songs.', { timeout: 3200 }); return; }
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
  for (const ev of ['play', 'pause']) audio.addEventListener(ev, () => { render(); app.syncMusicButton?.(!audio.paused); savePos(true); });
  audio.addEventListener('seeked', () => savePos(true));
  audio.addEventListener('timeupdate', () => { updateTime(); if (!audio.paused) savePos(); });
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
      try { await api.dumpAdd(f.name, new Uint8Array(await f.arrayBuffer()), 'audio'); n++; } catch (e) { errorToast(e, f.name); }
    }
    if (n) { toast(`Added ${n} song${n > 1 ? 's' : ''}`, { type: 'ok' }); refresh(); } else if (files.length) toast('Only audio files (mp3, m4a, wav, flac, ogg…) go in the audio dump.', { type: 'warn' });
  }
  async function addFromDisk() {
    const paths = await pickOpen({ multi: true, title: 'Add songs to the audio dump', filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'] }] });
    let n = 0;
    for (const p of paths || []) {
      try { const { bytes } = await api.read(p); await api.dumpAdd(p.split(/[\\/]/).pop(), bytes, 'audio'); n++; } catch (e) { errorToast(e); }
    }
    if (n) { toast(`Added ${n} song${n > 1 ? 's' : ''}`, { type: 'ok' }); refresh(); }
  }

  // ---------------------------------------------------------------- queue
  function saveQueue() { app.saveSettings({ musicQueue: [...state.queue] }); render(); }
  function enqueue(name, front = false) {
    if (front) state.queue.unshift(name); else state.queue.push(name);
    saveQueue();
    toast(front ? `Plays next: ${stripExt(name)}` : `Added to the queue: ${stripExt(name)}`, { timeout: 1600 });
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
    const cur = h('span', { class: 'mono' }, '0:00');
    const dur = h('span', { class: 'mono' }, '0:00');
    const btn = (ic, tip, fn, cls = '') => h('button', { class: `icon-btn music-btn ${cls}`, 'data-tip': tip, onclick: fn }, icon(ic));
    const shuffleB = btn('shuffle', 'Shuffle', () => setShuffle(!state.shuffle));
    const loopB = btn('repeat', 'Loop: all', () => cycleLoop());
    const playB = h('button', { class: 'music-play', 'data-tip': 'Play / pause (Space when this is open)', onclick: () => toggle() }, icon('play'));
    const vol = h('input', { type: 'range', class: 'music-vol', min: '0', max: '1', step: '0.01', value: String(state.volume) });
    vol.addEventListener('input', () => setVolume(Number(vol.value)));
    // mixer: response curve + low/high cut + 10 bands + presets
    const eqWrap = h('div', { class: 'music-eq', hidden: !s.musicMixerOpen });
    const curve = h('canvas', { class: 'music-curve', width: '620', height: '150' });
    const drawCurve = () => {
      const c = curve.getContext('2d');
      const W = curve.width, H = curve.height;
      c.clearRect(0, 0, W, H);
      const yOf = (db) => H / 2 - (db / 24) * (H / 2 - 8);
      c.strokeStyle = 'rgba(180,160,255,0.12)';
      c.lineWidth = 1;
      for (const db of [-18, -12, -6, 0, 6, 12, 18]) { c.beginPath(); c.moveTo(0, yOf(db)); c.lineTo(W, yOf(db)); c.stroke(); }
      for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = (hzToPos(hz) / 1000) * W; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
      c.fillStyle = 'rgba(180,160,255,0.45)';
      c.font = '9px IBM Plex Mono, monospace';
      for (const hz of [100, 1000, 10000]) c.fillText(hzLabel(hz), (hzToPos(hz) / 1000) * W + 3, H - 4);
      // combined response of every filter (uses the real filters when audio has started; otherwise a scratch graph)
      const N = 200;
      const freqs = new Float32Array(N);
      for (let i = 0; i < N; i++) freqs[i] = posToHz((i / (N - 1)) * 1000);
      const total = new Float32Array(N).fill(1);
      const scratch = ctx || new OfflineAudioContext(1, 1, 44100);
      const make = (type, f, q, g) => { const b = scratch.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g; return b; };
      const chain = [
        make('highpass', state.low <= MIN_HZ + 1 ? 1 : state.low, 0.9, 0),
        ...BANDS.map(([f, type], i) => make(type, f, type === 'peaking' ? 1.4 : 0.7, state.eq[i])),
        make('lowpass', state.high >= MAX_HZ - 50 ? 24000 : state.high, 0.9, 0),
      ];
      const mag = new Float32Array(N), ph = new Float32Array(N);
      for (const f of chain) { f.getFrequencyResponse(freqs, mag, ph); for (let i = 0; i < N; i++) total[i] *= mag[i]; }
      const grad = c.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, '#6ee7e0'); grad.addColorStop(0.5, '#b48cff'); grad.addColorStop(1, '#ff7ac6');
      c.beginPath();
      for (let i = 0; i < N; i++) {
        const db = Math.max(-24, Math.min(24, 20 * Math.log10(Math.max(total[i], 1e-6))));
        const x = (i / (N - 1)) * W, y = yOf(db);
        if (i) c.lineTo(x, y); else c.moveTo(x, y);
      }
      c.strokeStyle = grad;
      c.lineWidth = 2.5;
      c.stroke();
      c.lineTo(W, H); c.lineTo(0, H); c.closePath();
      c.fillStyle = 'rgba(180,140,255,0.08)';
      c.fill();
    };
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
    highR.addEventListener('input', () => { setCuts({ high: posToHz(Number(highR.value)) }, false); showCuts(); markPreset(); drawCurve(); });
    highR.addEventListener('change', () => setCuts({}, true));
    const eqSliders = BANDS.map(([freq], i) => {
      const r = h('input', { type: 'range', class: 'music-eq-slider', min: '-18', max: '18', step: '0.5', value: String(state.eq[i]) });
      const val = h('span', { class: 'mono music-eq-val' });
      const show = () => { val.textContent = `${state.eq[i] > 0 ? '+' : ''}${state.eq[i]}`; r.value = String(state.eq[i]); };
      r.addEventListener('input', () => { setEq(i, Number(r.value), false); show(); markPreset(); drawCurve(); });
      r.addEventListener('change', () => setEq(i, Number(r.value)));
      r.addEventListener('dblclick', () => { setEq(i, 0); show(); markPreset(); drawCurve(); });
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
    const presetRow = h('div', { class: 'music-presets' }, Object.keys(PRESETS).map((name) =>
      h('button', { class: 'chip', dataset: { preset: name }, onclick: () => applyPreset(PRESETS[name]) }, name)));
    function markPreset() {
      for (const b of presetRow.children) {
        const p = PRESETS[b.dataset.preset];
        b.classList.toggle('on', p.eq.every((v, i) => v === state.eq[i]) && Math.abs(p.low - state.low) < 2 && Math.abs(p.high - state.high) < 30);
      }
    }
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
    el.append(
      h('div', { class: 'music-head' }, h('span', { class: 'music-note' }, '♪'), h('span', { class: 'mono' }, 'audio-dump/'), h('div', { class: 'grow' }),
        h('button', { class: 'icon-btn', 'data-tip': 'Add songs', onclick: () => addFromDisk() }, icon('plus', 'sm')),
        dupeBtn,
        h('button', { class: 'icon-btn', 'data-tip': 'Refresh', onclick: () => refresh() }, icon('refresh', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Open the folder', onclick: () => api.dumpReveal('audio') }, icon('external', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Close (music keeps playing)', onclick: () => setOpen(false) }, icon('x', 'sm'))),
      h('div', { class: 'music-now' }, title, sub),
      h('div', { class: 'music-time' }, cur, seek, dur),
      h('div', { class: 'music-controls' }, shuffleB, btn('skip-back', 'Previous', () => prev()), playB, btn('skip-forward', 'Next', () => next()), loopB),
      h('div', { class: 'music-volrow' }, icon('volume', 'sm'), vol, mixerB),
      eqWrap,
      tabs,
      list);
    document.body.append(el);
    ui = { el, title, sub, seek, cur, dur, playB, shuffleB, loopB, list, dupeBtn, libTab, queueTab, isSeeking: () => seeking };
    document.addEventListener('pointerdown', (e) => { if (state.open && !state.docked && performance.now() - state.openedAt > 250 && !el.contains(e.target) && !e.target.closest?.('#btn-music')) setOpen(false); }, true);
    document.addEventListener('keydown', (e) => {
      if (!state.open || (state.docked && !el.contains(e.target) && e.target !== document.body)) return;
      if (e.key === 'Escape' && !state.docked) setOpen(false);
      if (e.key === ' ' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !e.target.isContentEditable) { e.preventDefault(); toggle(); }
    });
  }

  function updateTime() {
    if (!ui || !state.open) return;
    ui.cur.textContent = ui.isSeeking() ? ui.cur.textContent : fmt(audio.currentTime);
    ui.dur.textContent = fmt(audio.duration);
    if (!ui.isSeeking()) ui.seek.value = String(audio.duration ? Math.round((audio.currentTime / audio.duration) * 1000) : 0);
  }

  function render() {
    if (!ui) return;
    const t = state.tracks[state.idx];
    ui.title.textContent = t ? stripExt(t.name) : state.tracks.length ? 'Pick a song' : 'No songs yet';
    const upNext = state.queue[0] ? ` · up next: ${stripExt(state.queue[0])}` : '';
    ui.sub.textContent = t ? `${state.idx + 1} of ${state.tracks.length}${upNext}` : state.tracks.length ? `${state.tracks.length} songs in the audio dump` : 'drop mp3s here or put them in Box-DocSpitter\\audio-dump';
    clear(ui.libTab).append('Library ', h('span', { class: 'mono faint' }, String(state.tracks.length)));
    clear(ui.queueTab).append('Queue ', h('span', { class: 'mono faint' }, String(state.queue.length)));
    ui.libTab.classList.toggle('on', state.view === 'library');
    ui.queueTab.classList.toggle('on', state.view === 'queue');
    clear(ui.playB).append(icon(audio.paused ? 'play' : 'pause-bars'));
    ui.shuffleB.classList.toggle('active', state.shuffle);
    ui.loopB.classList.toggle('active', state.loop !== 'off');
    clear(ui.loopB).append(icon(state.loop === 'one' ? 'repeat-1' : 'repeat'));
    ui.loopB.dataset.tip = `Loop: ${state.loop === 'one' ? 'this song' : state.loop === 'all' ? 'all songs' : 'off'}`;
    clear(ui.list);
    if (state.view === 'queue') { renderQueue(); updateTime(); return; }
    if (!state.tracks.length) {
      ui.list.append(h('div', { class: 'music-empty' }, 'Drop music files here, use ', h('b', {}, '+'), ', or put files in the ', h('span', { class: 'mono' }, 'audio-dump'), ' folder (', h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.dumpReveal('audio'); } }, 'open it'), ').'));
    }
    state.tracks.forEach((tr, i) => {
      const nameEl = h('span', { class: 'music-track-name' }, stripExt(tr.name));
      const qAdd = h('span', { class: 'music-qadd', role: 'button', title: 'Add to the queue' }, icon('plus', 'sm'));
      qAdd.addEventListener('click', (e) => { e.stopPropagation(); enqueue(tr.name); });
      const row = h('button', { class: `music-track ${i === state.idx ? 'on' : ''}`, draggable: 'true', title: `${tr.name} · ${formatBytes(tr.size)}\nF2: rename · Del: remove · drag onto Queue to queue it` },
        h('span', { class: 'music-track-n mono' }, i === state.idx && !audio.paused ? '♪' : String(i + 1)),
        nameEl, qAdd);
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/bds-song', tr.name); e.dataTransfer.effectAllowed = 'copy'; });
      const remove = async () => {
        if (i === state.idx) { audio.pause(); audio.removeAttribute('src'); audio.load(); state.idx = -1; }
        try { await api.dumpRemove(tr.name, 'audio'); toast(`Moved ${tr.name} to audio-dump\\.removed`, { timeout: 3000 }); refresh(); } catch (err) { errorToast(err); }
      };
      hoverKeys(row, { nameEl, value: () => stripExt(tr.name), commit: (n) => renameTrack(i, n), remove });
      row.addEventListener('click', () => (i === state.idx ? toggle() : play(i)));
      row.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Play', icon: 'play', action: () => play(i) },
        { label: 'Play next', icon: 'skip-forward', action: () => enqueue(tr.name, true) },
        { label: 'Add to queue', icon: 'plus', action: () => enqueue(tr.name) },
        { sep: true },
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
    h('span', { class: 'music-track-name' }, stripExt(name)), extra);

  /** The Queue tab: what's playing, songs you queued, then (with shuffle on) the shuffled library. All draggable. */
  function renderQueue() {
    const L = ui.list;
    const now = state.tracks[state.idx];
    if (now) L.append(h('div', { class: 'music-q-now' }, h('span', { class: 'faint' }, audio.paused ? 'Paused' : 'Now playing'), h('span', {}, stripExt(now.name))));

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
    L.append(h('div', { class: 'music-q-head' }, h('span', { class: 'faint' }, `${state.queue.length ? 'Then from' : 'Up next from'} the library (shuffled) · drag to reorder`), h('div', { class: 'grow' }),
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
    const current = i === state.idx && audio.src;
    const at = audio.currentTime;
    const wasPlaying = !audio.paused;
    await api.dumpRename(tr.name, to, 'audio');
    if (state.queue.includes(tr.name)) { state.queue = state.queue.map((n) => (n === tr.name ? to : n)); app.saveSettings({ musicQueue: [...state.queue] }); }
    tr.name = to; // so refresh() keeps this song selected
    await refresh();
    const t = state.tracks[state.idx];
    if (current && t) {
      // the old stream URL points at the old file name, so pick up from the same spot under the new one
      audio.src = `/api/stream?token=${encodeURIComponent(api.token)}&path=${encodeURIComponent(t.path)}`;
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = at; if (wasPlaying) audio.play().catch(() => {}); }, { once: true });
      app.saveSettings({ musicLast: t.name });
    }
  }

  function position() {
    const b = document.getElementById('btn-music')?.getBoundingClientRect();
    if (!b || !ui || state.docked) return;
    ui.el.style.top = Math.round(b.bottom + 6) + 'px';
    ui.el.style.right = Math.max(8, Math.round(innerWidth - b.right - 8)) + 'px';
  }

  function setOpen(open) {
    if (!ui) build();
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
    ui.el.classList.toggle('docked', !!host);
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

  refresh();
  /** Play a file from the audio dump by name (used by BoxVidKlep / BoxTape after a download). */
  async function playByName(name) {
    await refresh();
    const i = state.tracks.findIndex((t) => t.name === name);
    if (i >= 0) play(i);
  }

  return {
    toggleOpen: () => (state.docked ? app.toggleRightPanel(app.rightPanel === 'music' ? null : 'music') : setOpen(!state.open)),
    open: () => (state.docked ? (app.rightPanel !== 'music' && app.toggleRightPanel('music')) : setOpen(true)),
    dockInto, get docked() { return !!state.docked; },
    refresh, play, playByName, pause, toggle, next, prev, enqueue, get queue() { return [...state.queue]; }, get playing() { return !audio.paused; } };
}
