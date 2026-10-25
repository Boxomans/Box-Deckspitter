// BoxComms, the page side: one connection to the local server's comms stream (chat, files, who's on, the radio's
// audio), toasts for messages while the BoxComms tab isn't in front, and the radio's audio: the microphone in,
// people talking out, through the devices picked in Settings → Audio devices.
//
// It only goes on by itself on networks that look like home: marked private (Windows), a VPN, or one you've said is
// fine. Anything else asks first, and joining such a network while it's on switches it off.

import { api } from './api.js';
import { toast, confirmDialog } from './ui.js';

const FRAME_BYTES = 640;
const MIC_HOLD_MS = 30_000; // the mic stays open this long after the last transmission, so the next one starts at once
const NET_CHECK_MS = 60_000;
const netKey = (n) => `${n.name}|${n.profile}`;

export function createComms(app) {
  let state = { on: false, me: null, peers: [], history: [], shared: {} };
  const listeners = new Set();
  let reader = null, retry = null, connected = false;
  const progress = new Map(); // mid → bytes received so far
  const talking = new Set();

  const cfg = () => ({ fx: true, beeps: true, volume: 0.9, chan: 1, ...(app.settings.comms || {}) });
  const emit = (ev) => { for (const fn of listeners) { try { fn(ev, state); } catch (e) { console.warn('comms', e); } } };
  const tabUp = () => app.active?.mode === 'comms' && !document.hidden;
  const nameOf = (id) => (id === state.me?.id ? state.me.name : state.peers.find((p) => p.id === id)?.name || state.history.findLast?.((m) => m.from === id)?.name || 'Someone');

  // ---------------------------------------------------------------- the stream
  async function connect() {
    clearTimeout(retry);
    try {
      const res = await fetch('/api/comms/stream', { headers: { 'X-BDS-Token': api.token } });
      if (!res.ok || !res.body) throw new Error(res.status);
      reader = res.body.getReader();
      connected = true;
      let buf = new Uint8Array(0);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf); next.set(value, buf.length);
        buf = next;
        let at = 0;
        while (buf.length - at >= 5) {
          const dv = new DataView(buf.buffer, buf.byteOffset + at);
          const kind = dv.getUint8(0), len = dv.getUint32(1, true);
          if (buf.length - at - 5 < len) break;
          const body = buf.subarray(at + 5, at + 5 + len);
          at += 5 + len;
          if (kind === 1) onEvent(JSON.parse(new TextDecoder().decode(body)));
          else if (kind === 2) onAudio(new TextDecoder().decode(body.subarray(0, 16)), body[16], body.slice(17).buffer);
        }
        buf = buf.slice(at);
      }
    } catch { /* the server restarted or isn't up yet */ }
    connected = false;
    reader = null;
    retry = setTimeout(connect, 2000);
  }

  function onEvent(ev) {
    switch (ev.type) {
      case 'ping': return;
      case 'state': state = ev.state; break;
      case 'me': state.me = ev.me; break;
      case 'peers': state.peers = ev.peers; for (const id of [...talking]) if (!state.peers.some((p) => p.id === id)) talking.delete(id); break;
      case 'history': state.history = ev.history; break;
      case 'shared': state.shared = ev.shared; break;
      case 'msg': state.history.push(ev.msg); announce(ev.msg); break;
      case 'msg-update': { const i = state.history.findIndex((m) => m.mid === ev.mid); if (i >= 0) state.history[i] = ev.msg; if (ev.msg.file?.status !== 'receiving') progress.delete(ev.mid); break; }
      case 'progress': progress.set(ev.mid, ev.got); break;
      case 'talk':
        if (ev.on) { talking.add(ev.id); if (cfg().beeps) beep('squelch'); }
        else { talking.delete(ev.id); player?.port.postMessage({ id: ev.id, end: true }); if (cfg().beeps) beep('roger'); }
        break;
      case 'joined': if (app.mainWindow !== false && tabUp() === false && app.settings.comms?.joinToasts) toast(`${ev.peer.name} is on BoxComms`, { timeout: 3000 }); break;
    }
    emit(ev);
  }

  function announce(m) {
    if (m.from === state.me?.id || app.mainWindow === false || tabUp()) return;
    const what = m.kind === 'file' ? `${m.name} wants to send you ${m.file.name}` : `${m.name}${m.to ? ' (to you)' : ''}: ${m.text.length > 120 ? m.text.slice(0, 120) + '…' : m.text}`;
    toast(what, { timeout: 7000, action: { label: 'Open', fn: () => app.newDocument('comms') } });
    app.sounds?.play?.('open');
    if (document.hidden || !document.hasFocus()) {
      try { new Notification(m.kind === 'file' ? 'BoxComms: a file for you' : `BoxComms: ${m.name}`, { body: m.kind === 'file' ? m.file.name : m.text.slice(0, 200), silent: true }); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- audio
  let ctx = null, player = null, outGain = null, fxIn = null, dry = null, workletReady = null;
  let mic = null, micNode = null, micStream = null, micTimer = null, level = 0;
  let sending = false, pending = [], posting = Promise.resolve();

  async function audio() {
    if (ctx) { if (ctx.state === 'suspended') await ctx.resume().catch(() => {}); return ctx; }
    ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    await setOutput(app.settings.audioOut);
    workletReady = ctx.audioWorklet.addModule('/js/core/comms-worklet.js');
    await workletReady;
    player = new AudioWorkletNode(ctx, 'comms-player', { numberOfInputs: 0, outputChannelCount: [1] });
    outGain = ctx.createGain();
    // the radio sound: a narrow band (like a handheld's speaker) and a little grit
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 320;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
    const grit = ctx.createWaveShaper();
    grit.curve = Float32Array.from({ length: 1024 }, (_, i) => { const x = i / 511.5 - 1; return Math.tanh(2.2 * x) / Math.tanh(2.2); });
    hp.connect(lp).connect(grit).connect(outGain);
    fxIn = hp;
    dry = ctx.createGain();
    dry.connect(outGain);
    outGain.connect(ctx.destination);
    applyMix();
    return ctx;
  }
  function applyMix() {
    if (!player) return;
    const c = cfg();
    outGain.gain.value = c.volume;
    try { player.disconnect(); } catch { /* not connected */ }
    player.connect(c.fx ? fxIn : dry);
  }
  async function setOutput(id) {
    if (!ctx?.setSinkId) return;
    try { await ctx.setSinkId(id && id !== 'default' ? id : ''); } catch (e) { console.warn('comms output', e); }
  }

  function onAudio(id, flags, pcm) {
    if (!player || !pcm.byteLength) return;
    player.port.postMessage({ id, pcm }, [pcm]);
  }

  async function openMic() {
    clearTimeout(micTimer);
    if (micNode) return;
    await audio();
    const dev = app.settings.audioIn;
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { ...(dev && dev !== 'default' ? { deviceId: { exact: dev } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    mic = ctx.createMediaStreamSource(micStream);
    micNode = new AudioWorkletNode(ctx, 'comms-mic', { numberOfOutputs: 0 });
    micNode.port.onmessage = ({ data }) => {
      level = data.level;
      if (!sending) return;
      pending.push(new Uint8Array(data.pcm));
      if (pending.length >= 2) flush(false);
    };
    mic.connect(micNode);
  }
  function closeMic() {
    try { mic?.disconnect(); micNode?.disconnect(); } catch { /* ignore */ }
    micStream?.getTracks().forEach((t) => t.stop());
    mic = micNode = micStream = null;
    level = 0;
  }
  function flush(end) {
    const frames = pending; pending = [];
    if (!frames.length && !end) return;
    const body = new Uint8Array(frames.length * FRAME_BYTES);
    frames.forEach((f, i) => body.set(f, i * FRAME_BYTES));
    // one at a time, in order
    posting = posting.then(() => fetch(`/api/comms/voice${end ? '?end=1' : ''}`, { method: 'POST', headers: { 'X-BDS-Token': api.token }, body }).catch(() => {}));
  }

  /** Push to talk: start(true) while held, start(false) on release. */
  async function talk(on) {
    if (on) {
      if (sending || !state.on) return !!sending;
      try { await openMic(); } catch (e) { toast(`No microphone: ${e.message}`, { type: 'error' }); return false; }
      sending = true;
      if (cfg().beeps) beep('key');
      emit({ type: 'ptt', on: true });
      return true;
    }
    if (!sending) return false;
    sending = false;
    flush(true);
    if (cfg().beeps) beep('roger');
    emit({ type: 'ptt', on: false });
    micTimer = setTimeout(() => { if (!sending) closeMic(); }, MIC_HOLD_MS);
    return false;
  }

  /** Small radio noises, made on the spot. */
  function beep(kind) {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime, g = ctx.createGain();
    g.connect(outGain);
    const vol = 0.12;
    if (kind === 'squelch') {
      const n = ctx.createBufferSource(), b = ctx.createBuffer(1, 1600, 16000), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      n.buffer = b; n.connect(g);
      g.gain.value = vol * 0.6;
      n.start(t);
      return;
    }
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.connect(g);
    g.gain.setValueAtTime(0, t);
    if (kind === 'key') {
      o.frequency.value = 1200;
      g.gain.linearRampToValueAtTime(vol, t + 0.005); g.gain.setValueAtTime(vol, t + 0.05); g.gain.linearRampToValueAtTime(0, t + 0.06);
      o.start(t); o.stop(t + 0.07);
    } else { // roger: two short tones
      o.frequency.setValueAtTime(1500, t); o.frequency.setValueAtTime(1100, t + 0.07);
      g.gain.linearRampToValueAtTime(vol, t + 0.005); g.gain.setValueAtTime(vol, t + 0.13); g.gain.linearRampToValueAtTime(0, t + 0.14);
      o.start(t); o.stop(t + 0.15);
    }
  }

  // ---------------------------------------------------------------- actions
  const call = (url, json) => api.post(`/api/comms/${url}`, json);
  /** The networks BoxComms would be on that don't look like home and haven't been said to be fine. */
  async function strangeNetworks() {
    const c = cfg();
    const { networks } = await api.get('/api/comms/network-check');
    return networks.filter((n) => (!c.net || n.name === c.net) && !n.home && !(c.trusted || []).includes(netKey(n)));
  }
  const describe = (list) => list.map((n) => `${n.profile ? `“${n.profile}” (${n.name})` : n.name}${n.category === 'public' ? ', marked as a public network' : ''}`).join('; ');

  /** Goes on the network (or applies changed settings when it's on). Asks first on a network that doesn't look like
   *  home; with auto (at start-up) it stays off instead. Resolves false when it didn't go on. */
  async function start({ auto = false } = {}) {
    const strange = await strangeNetworks().catch(() => []);
    if (strange.length) {
      if (auto) {
        toast(`BoxComms stayed off: ${describe(strange)} isn’t a network you’ve said is home.`, { type: 'warn', timeout: 9000, action: { label: 'Open BoxComms', fn: () => app.newDocument('comms') } });
        return false;
      }
      const ok = await confirmDialog('Is this a network you trust?',
        `BoxComms would go on ${describe(strange)}. It isn’t a network marked as private and doesn’t look like a VPN. BoxComms hasn’t been security-tested: use it only on your home network or a VPN you trust, not on café, hotel, school, work or other public Wi-Fi.`,
        { okLabel: 'It’s my home network or VPN', danger: true });
      if (!ok) { if (state.on) await stop({ keep: false }); return false; }
      app.saveSettings({ comms: { ...cfg(), trusted: [...new Set([...(cfg().trusted || []), ...strange.map(netKey)])] } });
    }
    const c = cfg();
    await call('start', { name: c.name || undefined, folder: c.folder || undefined, chan: c.chan, net: c.net || '', extra: c.extra || [] });
    app.saveSettings({ commsOn: true });
    return true;
  }
  /** keep: stays switched on in Settings, so it comes back on a home network next time. */
  async function stop({ keep = false } = {}) {
    await talk(false);
    await call('stop', {});
    if (!keep) app.saveSettings({ commsOn: false });
  }
  // a laptop carried to a café with the app open: off as soon as a strange network shows up
  setInterval(async () => {
    if (!state.on || app.mainWindow === false) return;
    const strange = await strangeNetworks().catch(() => []);
    if (!strange.length) return;
    await stop({ keep: true }).catch(() => {});
    toast(`BoxComms went off: you’re on ${describe(strange)}, which isn’t a network you’ve said is home.`, { type: 'warn', timeout: 12000, action: { label: 'Open BoxComms', fn: () => app.newDocument('comms') } });
  }, NET_CHECK_MS);

  // the comms stream is per window; only the main window switches it on by itself
  connect();
  if (app.settings.commsOn && app.mainWindow !== false) start({ auto: true }).catch((e) => console.warn('comms start', e));
  // the browser won't play sound until the page has been clicked once
  document.addEventListener('pointerdown', () => { if (state.on) audio().catch(() => {}); }, { once: true, capture: true });

  return {
    get state() { return state; },
    get connected() { return connected; },
    get sending() { return sending; },
    get level() { return level; },
    talking, progress, nameOf,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start, stop, talk, audio, applyMix, setOutput,
    reopenMic() { if (micNode) { closeMic(); if (sending) openMic().catch(() => {}); } },
    networks: () => api.get('/api/comms/networks').then((r) => r.networks).catch(() => []),
    say: (text, to) => call('say', { text, to }),
    trustKey: (id) => call('trust-key', { id }),
    sendFiles: (paths, to) => call('send-file', { paths, to }),
    answer: (mid, accept) => call('answer', { mid, accept }),
    radio: (chan) => { app.saveSettings({ comms: { ...cfg(), chan } }); player?.port.postMessage({ clear: true }); return call('radio', { chan }); },
    shared: (patch) => call('shared', { patch }),
    wipe: () => call('wipe', {}),
    remove: (mid) => call('delete', { mid }),
    clearMine: () => call('clear-mine', {}),
    beep,
  };
}
