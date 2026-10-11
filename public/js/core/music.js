// ♪ music player for the audio-dump folder: play/pause, skip, shuffle, loop, seek, volume, and a 5-band
// mixer (EQ) running through Web Audio. Keeps playing while the panel is closed; media keys work too.

import { api } from './api.js';
import { h, clear, formatBytes, stripExt } from './dom.js';
import { icon } from './icons.js';
import { toast, errorToast, contextMenu } from './ui.js';
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
  };
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
    try { items = (await api.dump('audio')).items; } catch { /* ignore */ }
    const current = state.tracks[state.idx]?.name;
    state.tracks = items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    state.idx = current ? state.tracks.findIndex((t) => t.name === current) : state.tracks.findIndex((t) => t.name === s.musicLast);
    reshuffle();
    render();
  }

  function reshuffle() {
    const n = state.tracks.length;
    state.order = [...Array(n).keys()];
    if (state.shuffle) {
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [state.order[i], state.order[j]] = [state.order[j], state.order[i]]; }
      // keep the current song first so shuffle doesn't jump away from it
      if (state.idx >= 0) state.order = [state.idx, ...state.order.filter((x) => x !== state.idx)];
    }
  }

  function play(i = state.idx < 0 ? (state.order[0] ?? 0) : state.idx) {
    const t = state.tracks[i];
    if (!t) { toast('Put some music in the audio dump first — drop files on the player or use Add songs.', { timeout: 3200 }); return; }
    graph();
    if (i !== state.idx || !audio.src) {
      state.idx = i;
      audio.src = `/api/stream?token=${encodeURIComponent(api.token)}&path=${encodeURIComponent(t.path)}`;
      app.saveSettings({ musicLast: t.name });
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: stripExt(t.name), artist: 'audio-dump', album: 'Box-DocSpitter' });
    }
    audio.play().catch((e) => { if (e.name !== 'AbortError') errorToast(e, 'Can’t play that file'); });
    render();
  }
  const pause = () => { audio.pause(); render(); };
  const toggle = () => (audio.paused ? play() : pause());

  function step(dir) {
    if (!state.tracks.length) return;
    const pos = state.order.indexOf(state.idx);
    let next = pos + dir;
    if (next >= state.order.length) { if (state.loop === 'off' && dir > 0 && !state._manual) { pause(); return; } next = 0; }
    if (next < 0) next = state.order.length - 1;
    play(state.order[next]);
  }
  const next = () => { state._manual = true; step(1); state._manual = false; };
  const prev = () => { if (audio.currentTime > 3) { audio.currentTime = 0; return; } step(-1); };

  audio.addEventListener('ended', () => {
    if (state.loop === 'one') { audio.currentTime = 0; audio.play(); return; }
    step(1);
  });
  for (const ev of ['play', 'pause']) audio.addEventListener(ev, () => { render(); app.syncMusicButton?.(!audio.paused); });
  audio.addEventListener('timeupdate', () => updateTime());
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
  function setShuffle(on) { state.shuffle = on; reshuffle(); app.saveSettings({ musicShuffle: on }); render(); }
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
    el.append(
      h('div', { class: 'music-head' }, h('span', { class: 'music-note' }, '♪'), h('span', { class: 'mono' }, 'audio-dump/'), h('div', { class: 'grow' }),
        h('button', { class: 'icon-btn', 'data-tip': 'Add songs', onclick: () => addFromDisk() }, icon('plus', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Refresh', onclick: () => refresh() }, icon('refresh', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Open the folder', onclick: () => api.dumpReveal('audio') }, icon('external', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Close (music keeps playing)', onclick: () => setOpen(false) }, icon('x', 'sm'))),
      h('div', { class: 'music-now' }, title, sub),
      h('div', { class: 'music-time' }, cur, seek, dur),
      h('div', { class: 'music-controls' }, shuffleB, btn('skip-back', 'Previous', () => prev()), playB, btn('skip-forward', 'Next', () => next()), loopB),
      h('div', { class: 'music-volrow' }, icon('volume', 'sm'), vol, mixerB),
      eqWrap,
      list);
    document.body.append(el);
    ui = { el, title, sub, seek, cur, dur, playB, shuffleB, loopB, list, isSeeking: () => seeking };
    document.addEventListener('pointerdown', (e) => { if (state.open && performance.now() - state.openedAt > 250 && !el.contains(e.target) && !e.target.closest?.('#btn-music')) setOpen(false); }, true);
    document.addEventListener('keydown', (e) => {
      if (!state.open) return;
      if (e.key === 'Escape') setOpen(false);
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
    ui.sub.textContent = t ? `${state.idx + 1} of ${state.tracks.length}` : state.tracks.length ? `${state.tracks.length} songs in the audio dump` : 'drop mp3s here or put them in Box-DocSpitter\\audio-dump';
    clear(ui.playB).append(icon(audio.paused ? 'play' : 'pause-bars'));
    ui.shuffleB.classList.toggle('active', state.shuffle);
    ui.loopB.classList.toggle('active', state.loop !== 'off');
    clear(ui.loopB).append(icon(state.loop === 'one' ? 'repeat-1' : 'repeat'));
    ui.loopB.dataset.tip = `Loop: ${state.loop === 'one' ? 'this song' : state.loop === 'all' ? 'all songs' : 'off'}`;
    clear(ui.list);
    if (!state.tracks.length) {
      ui.list.append(h('div', { class: 'music-empty' }, 'Drop music files here, use ', h('b', {}, '+'), ', or put files in the ', h('span', { class: 'mono' }, 'audio-dump'), ' folder (', h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.dumpReveal('audio'); } }, 'open it'), ').'));
    }
    state.tracks.forEach((tr, i) => {
      const row = h('button', { class: `music-track ${i === state.idx ? 'on' : ''}`, title: `${tr.name} · ${formatBytes(tr.size)}` },
        h('span', { class: 'music-track-n mono' }, i === state.idx && !audio.paused ? '♪' : String(i + 1)),
        h('span', { class: 'music-track-name' }, stripExt(tr.name)));
      row.addEventListener('click', () => (i === state.idx ? toggle() : play(i)));
      row.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Play', icon: 'play', action: () => play(i) },
        { label: 'Show in Explorer', icon: 'external', action: () => api.dumpReveal('audio', tr.name) },
        { label: 'Remove from audio dump', icon: 'trash', action: async () => {
          if (i === state.idx) { audio.pause(); audio.removeAttribute('src'); audio.load(); state.idx = -1; }
          try { await api.dumpRemove(tr.name, 'audio'); toast(`Moved ${tr.name} to audio-dump\\.removed`, { timeout: 3000 }); refresh(); } catch (err) { errorToast(err); }
        } },
      ]));
      ui.list.append(row);
    });
    updateTime();
  }

  function position() {
    const b = document.getElementById('btn-music')?.getBoundingClientRect();
    if (!b || !ui) return;
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

  refresh();
  /** Play a file from the audio dump by name (used by BoxVidKlep / BoxTape after a download). */
  async function playByName(name) {
    await refresh();
    const i = state.tracks.findIndex((t) => t.name === name);
    if (i >= 0) play(i);
  }

  return { toggleOpen: () => setOpen(!state.open), open: () => setOpen(true), refresh, play, playByName, pause, toggle, next, prev, get playing() { return !audio.paused; } };
}
