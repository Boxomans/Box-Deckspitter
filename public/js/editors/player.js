// Video player — just watch it: big picture, controls that hide while it plays, the rest of the folder one key away.
// Trimming and editing are a click away (the video trimmer, the video editor).

import { BaseEditor } from './base.js';
import { h, clear, clamp, stripExt, extOf, basename, dirname } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { tbButton, tbSep, showMenu, toast, errorToast } from '../core/ui.js';
import { api } from '../core/api.js';
import { VIDEO_EXT, AUDIO_EXT, fmtTime } from './video.js';

const PLAYABLE = new Set([...VIDEO_EXT, ...AUDIO_EXT]);
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export class PlayerEditor extends BaseEditor {
  static mode = 'player';
  handlesWheelZoom = true;

  async load() {
    this.buildDom();
    this.keyHandler = (e) => this.onKey(e);
    document.addEventListener('keydown', this.keyHandler);
    await this.play(this.tab.path, { autoplay: false });
  }

  // =================================================================== DOM

  buildDom() {
    this.media = h('video', { class: 'pl-media', preload: 'auto', playsinline: true });
    this.media.volume = clamp(Number(this.app.settings.playerVolume ?? 1), 0, 1);
    this.msg = h('div', { class: 'vid-msg', hidden: true });
    this.art = h('div', { class: 'vid-audio-art', hidden: true }, icon('note', 'xl'), h('div', { class: 'mono pl-art-name' }));
    this.bigPlay = h('button', { class: 'vid-bigplay', onclick: () => this.toggle() }, icon('play', 'xl'));
    this.flash = h('div', { class: 'pl-flash' });

    this.bar = h('div', { class: 'pl-bar' }, h('div', { class: 'pl-buf' }), h('div', { class: 'pl-fill' }), h('div', { class: 'pl-knob' }));
    this.hoverTip = h('div', { class: 'pl-tip mono', hidden: true });
    this.seek = h('div', { class: 'pl-seek' }, this.bar, this.hoverTip);
    this.wireSeek();

    this.timeLabel = h('span', { class: 'pl-time mono' }, '00:00 / 00:00');
    this.playBtn = h('button', { class: 'icon-btn', 'data-tip': 'Play / pause', 'data-key': 'Space', onclick: () => this.toggle() }, icon('play', 'lg'));
    this.muteBtn = h('button', { class: 'icon-btn', 'data-tip': 'Mute', 'data-key': 'M', onclick: () => this.mute() }, icon('volume'));
    this.vol = h('input', { type: 'range', min: '0', max: '1', step: '0.02', value: String(this.media.volume), class: 'vid-vol', 'data-tip': 'Volume (↑ ↓)' });
    this.vol.addEventListener('input', () => this.setVolume(Number(this.vol.value)));
    this.speedBtn = h('button', { class: 'btn sm ghost mono', 'data-tip': 'Speed ( [ ] )', onclick: (e) => this.speedMenu(e.currentTarget) }, '1×');
    this.loopBtn = h('button', { class: 'icon-btn', 'data-tip': 'Loop', 'data-key': 'R', onclick: () => this.setLoop(!this.media.loop) }, icon('refresh'));
    this.prevBtn = h('button', { class: 'icon-btn', 'data-tip': 'Previous in this folder', 'data-key': 'PgUp', onclick: () => this.neighbour(-1) }, icon('chevron-left'));
    this.nextBtn = h('button', { class: 'icon-btn', 'data-tip': 'Next in this folder', 'data-key': 'PgDn', onclick: () => this.neighbour(1) }, icon('chevron-right'));
    const controls = h('div', { class: 'pl-controls' },
      this.prevBtn, this.playBtn, this.nextBtn,
      this.muteBtn, this.vol, this.timeLabel,
      h('div', { class: 'grow' }),
      this.speedBtn, this.loopBtn,
      h('button', { class: 'icon-btn', 'data-tip': 'Snapshot this frame', 'data-key': 'S', onclick: (e) => this.snapshot(e.currentTarget) }, icon('image')),
      document.pictureInPictureEnabled ? h('button', { class: 'icon-btn', 'data-tip': 'Picture in picture', 'data-key': 'P', onclick: () => this.pip() }, icon('layers')) : null,
      h('button', { class: 'icon-btn', 'data-tip': 'Full screen (double-click the picture)', 'data-key': 'F', onclick: () => this.fullscreen() }, icon('maximize')));
    this.chrome = h('div', { class: 'pl-chrome' }, this.seek, controls);

    this.root = h('div', { class: 'pl-root', tabindex: '-1' }, this.art, this.media, this.msg, this.bigPlay, this.flash, this.chrome);
    this.pane.append(this.root);

    this.media.addEventListener('click', () => this.toggle());
    this.media.addEventListener('dblclick', () => this.fullscreen());
    this.art.addEventListener('click', () => this.toggle());
    this.media.addEventListener('play', () => { clear(this.playBtn).append(icon('pause-bars', 'lg')); this.bigPlay.hidden = true; this.wake(); this.tick(); });
    this.media.addEventListener('pause', () => { clear(this.playBtn).append(icon('play', 'lg')); this.bigPlay.hidden = false; this.wake(true); });
    this.media.addEventListener('timeupdate', () => this.onTime());
    this.media.addEventListener('progress', () => this.onTime());
    this.media.addEventListener('volumechange', () => this.syncVolume());
    this.media.addEventListener('ratechange', () => { this.speedBtn.textContent = this.media.playbackRate + '×'; });
    this.media.addEventListener('ended', () => { if (this.app.settings.playerAutoNext) this.neighbour(1, { autoplay: true, quiet: true }); });
    this.media.addEventListener('loadedmetadata', () => this.refreshStatus());
    // the controls fade out while it plays and the mouse rests; any movement brings them back
    this.root.addEventListener('mousemove', () => this.wake());
    this.root.addEventListener('mouseleave', () => { if (!this.media.paused) this.root.classList.add('idle'); });
    this.root.addEventListener('wheel', (e) => { if (e.ctrlKey) return; e.preventDefault(); this.setVolume(this.media.volume + (e.deltaY < 0 ? 0.05 : -0.05)); }, { passive: false });
    this.setLoop(!!this.app.settings.playerLoop, { quiet: true });
    this.syncVolume();
  }

  /** Load a file into the player (the tab follows it: title, path). */
  async play(path, { autoplay = true } = {}) {
    if (!path) return;
    const ext = extOf(path);
    this.isAudio = AUDIO_EXT.includes(ext);
    if (path !== this.tab.path) {
      this.app.setTabMeta(this.tab, { path, title: basename(path), ext });
      api.addRecent(path).catch(() => {});
    }
    this.siblings = null;
    this.msg.hidden = true;
    this.root.classList.toggle('audio', this.isAudio);
    this.art.hidden = !this.isAudio;
    this.art.querySelector('.pl-art-name').textContent = basename(path);
    this.media.src = `/api/stream?token=${encodeURIComponent(api.token)}&path=${encodeURIComponent(path)}`;
    const ok = await new Promise((resolve) => {
      const done = (v) => { this.media.removeEventListener('loadedmetadata', yes); this.media.removeEventListener('error', no); resolve(v); };
      const yes = () => done(true);
      const no = () => done(false);
      this.media.addEventListener('loadedmetadata', yes);
      this.media.addEventListener('error', no);
      setTimeout(() => done(!this.media.error), 8000);
    });
    if (!ok || this.media.error) {
      this.msg.hidden = false;
      clear(this.msg).append(`This ${ext.toUpperCase()} file can’t be played in the app.`, h('br'),
        h('button', { class: 'btn sm', style: { marginTop: '10px' }, onclick: () => this.app.openPath(this.tab.path, { mode: 'video' }) }, icon('crop', 'sm'), 'Open in the video trimmer (it can convert it)'));
    } else if (autoplay) this.media.play().catch(() => {});
    this.onTime();
    this.refreshStatus();
    this.loadSiblings();
  }

  // =================================================================== playing

  toggle() {
    if (this.media.error) return;
    if (this.media.paused) this.media.play().catch(() => {}); else this.media.pause();
  }

  tick() {
    if (this.media.paused) return;
    this.onTime();
    requestAnimationFrame(() => this.tick());
  }

  onTime() {
    const d = this.media.duration;
    const t = this.media.currentTime;
    const f = Number.isFinite(d) && d > 0 ? t / d : 0;
    this.bar.style.setProperty('--p', String(f));
    let buf = 0;
    const b = this.media.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5) buf = Math.max(buf, b.end(i));
    this.bar.style.setProperty('--b', String(Number.isFinite(d) && d > 0 ? buf / d : 0));
    this.timeLabel.textContent = `${fmtTime(t, false)} / ${fmtTime(d, false)}`;
  }

  skip(sec) {
    const d = this.media.duration;
    if (!Number.isFinite(d)) return;
    this.media.currentTime = clamp(this.media.currentTime + sec, 0, d);
    this.show(`${sec > 0 ? '+' : '−'}${Math.abs(sec)}s`);
    this.onTime();
  }

  wireSeek() {
    const at = (e) => { const r = this.bar.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
    this.seek.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !Number.isFinite(this.media.duration)) return;
      this.seek.setPointerCapture(e.pointerId);
      const go = (ev) => { this.media.currentTime = at(ev) * this.media.duration; this.onTime(); };
      go(e);
      const up = () => { this.seek.removeEventListener('pointermove', go); this.seek.removeEventListener('pointerup', up); };
      this.seek.addEventListener('pointermove', go);
      this.seek.addEventListener('pointerup', up);
    });
    this.seek.addEventListener('pointermove', (e) => {
      if (!Number.isFinite(this.media.duration)) return;
      const f = at(e);
      this.hoverTip.hidden = false;
      this.hoverTip.textContent = fmtTime(f * this.media.duration, false);
      this.hoverTip.style.left = `${f * 100}%`;
    });
    this.seek.addEventListener('pointerleave', () => { this.hoverTip.hidden = true; });
  }

  setVolume(v) {
    this.media.volume = clamp(Math.round(v * 100) / 100, 0, 1);
    this.media.muted = false;
    this.show(`${Math.round(this.media.volume * 100)}%`);
    clearTimeout(this.volSave);
    this.volSave = setTimeout(() => this.app.saveSettings({ playerVolume: this.media.volume }), 600);
  }

  mute() { this.media.muted = !this.media.muted; this.show(this.media.muted ? 'muted' : `${Math.round(this.media.volume * 100)}%`); }

  syncVolume() {
    const quiet = this.media.muted || this.media.volume === 0;
    clear(this.muteBtn).append(icon(quiet ? 'volume-x' : 'volume'));
    this.vol.value = String(this.media.muted ? 0 : this.media.volume);
  }

  setSpeed(s) { this.media.playbackRate = s; this.show(s + '×'); }

  speedMenu(anchor) {
    showMenu(SPEEDS.map((s) => ({ label: s + '×', checked: this.media.playbackRate === s, action: () => this.setSpeed(s) })), { anchor });
  }

  setLoop(on, { quiet = false } = {}) {
    this.media.loop = on;
    this.loopBtn.classList.toggle('on', on);
    if (!quiet) { this.show(on ? 'loop on' : 'loop off'); this.app.saveSettings({ playerLoop: on }); }
  }

  fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else this.root.requestFullscreen?.().catch(() => {});
  }

  async pip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (!this.isAudio) await this.media.requestPictureInPicture();
    } catch (e) { errorToast(e); }
  }

  /** A short word in the middle of the picture (volume, speed, skips). */
  show(text) {
    this.flash.textContent = text;
    this.flash.classList.remove('on');
    void this.flash.offsetWidth;
    this.flash.classList.add('on');
  }

  wake(stay = false) {
    this.root.classList.remove('idle');
    clearTimeout(this.idleT);
    if (!stay && !this.media.paused) this.idleT = setTimeout(() => this.root.classList.add('idle'), 2200);
  }

  // =================================================================== the folder around it

  async loadSiblings() {
    const path = this.tab.path;
    try {
      const { entries } = await api.list(dirname(path));
      if (path !== this.tab.path) return;
      this.siblings = entries.filter((e) => !e.isDir && PLAYABLE.has(extOf(e.name))).map((e) => e.path);
    } catch { this.siblings = []; }
    const i = this.siblingIndex();
    this.prevBtn.disabled = i <= 0;
    this.nextBtn.disabled = i < 0 || i >= this.siblings.length - 1;
  }

  siblingIndex() { return (this.siblings || []).findIndex((p) => p.toLowerCase() === this.tab.path.toLowerCase()); }

  neighbour(dir, { autoplay = !this.media.paused, quiet = false } = {}) {
    const i = this.siblingIndex();
    const next = i < 0 ? null : this.siblings[i + dir];
    if (!next) { if (!quiet) this.show(dir > 0 ? 'last one' : 'first one'); return; }
    this.play(next, { autoplay });
  }

  // =================================================================== frames

  async snapshot(anchor) {
    if (this.isAudio || !this.media.videoWidth) return;
    const c = h('canvas', { width: this.media.videoWidth, height: this.media.videoHeight });
    c.getContext('2d').drawImage(this.media, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const name = `${stripExt(this.tab.title)} @ ${fmtTime(this.media.currentTime).replace(/:/g, '-')}.png`;
    const items = [
      { label: 'Send to media dump', icon: 'image', action: async () => { await api.dumpAdd(name, new Uint8Array(await blob.arrayBuffer())); toast('Frame saved to the media dump', { type: 'ok' }); } },
      { label: 'Save frame as PNG…', icon: 'download', action: () => this.app.saveBytesAs(blob, { defaultName: name, filters: [{ name: 'PNG image', extensions: ['png'] }] }) },
      { label: 'Copy to clipboard', icon: 'copy', action: async () => { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Copied', { type: 'ok' }); } },
    ];
    if (anchor) showMenu(items, { anchor });
    else items[0].action().catch(errorToast);
  }

  // =================================================================== keys / app

  onKey(e) {
    if (this.app.active !== this.tab) return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t !== this.vol || document.querySelector('.modal-backdrop')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const run = (fn) => { e.preventDefault(); fn(); this.wake(); };
    if (k === ' ' || k === 'k') run(() => this.toggle());
    else if (e.key === 'ArrowLeft') run(() => this.skip(e.shiftKey ? -1 : -5));
    else if (e.key === 'ArrowRight') run(() => this.skip(e.shiftKey ? 1 : 5));
    else if (k === 'j') run(() => this.skip(-10));
    else if (k === 'l') run(() => this.skip(10));
    else if (e.key === 'ArrowUp') run(() => this.setVolume(this.media.volume + 0.05));
    else if (e.key === 'ArrowDown') run(() => this.setVolume(this.media.volume - 0.05));
    else if (k === ',' && this.media.paused) run(() => { this.media.currentTime = Math.max(0, this.media.currentTime - 1 / 30); });
    else if (k === '.' && this.media.paused) run(() => { this.media.currentTime += 1 / 30; });
    else if (k === '[') run(() => this.setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(this.media.playbackRate) - 1)] ?? 1));
    else if (k === ']') run(() => this.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(this.media.playbackRate) + 1)] ?? 1));
    else if (k === 'm') run(() => this.mute());
    else if (k === 'f') run(() => this.fullscreen());
    else if (k === 'p') run(() => this.pip());
    else if (k === 'r') run(() => this.setLoop(!this.media.loop));
    else if (k === 's') run(() => this.snapshot());
    else if (e.key === 'Home') run(() => { this.media.currentTime = 0; });
    else if (e.key === 'End') run(() => { if (Number.isFinite(this.media.duration)) this.media.currentTime = this.media.duration; });
    else if (e.key === 'PageUp') run(() => this.neighbour(-1));
    else if (e.key === 'PageDown') run(() => this.neighbour(1));
    else if (/^[0-9]$/.test(e.key) && Number.isFinite(this.media.duration)) run(() => { this.media.currentTime = this.media.duration * Number(e.key) / 10; });
  }

  buildToolbar() {
    return h('div', { class: 'toolbar' },
      tbButton('crop', 'Open this in the video trimmer (cut a clip, GIF, MP3…)', () => this.app.openPath(this.tab.path, { mode: 'video' }), { text: 'Trim' }),
      tbButton('video', 'Add this to the video editor (tracks, keyframes, chroma key)', () => this.app.sendToVideoEditor([this.tab.path]), { text: 'Video editor' }),
      tbSep(),
      tbButton('external', 'Show in folder', () => this.tab.path && api.reveal(this.tab.path)),
      h('span', { class: 'tb-label' }, 'player'));
  }

  menus() {
    return {
      view: [
        { sep: true },
        { label: 'Loop', checked: !!this.media?.loop, action: () => this.setLoop(!this.media.loop) },
        { label: 'Play the next one in the folder when it ends', checked: !!this.app.settings.playerAutoNext, action: () => this.app.saveSettings({ playerAutoNext: !this.app.settings.playerAutoNext }) },
      ],
    };
  }

  status() {
    const v = this.media;
    const i = this.siblingIndex();
    return {
      left: [
        ...(v?.videoWidth ? [{ text: `${v.videoWidth}×${v.videoHeight}` }] : []),
        ...(this.siblings?.length > 1 && i >= 0 ? [{ text: `${i + 1} of ${this.siblings.length} in this folder` }] : []),
      ],
      right: [{ text: fmtTime(v?.duration, false) }],
    };
  }

  saveFormats() { return []; }
  focus() { this.root?.focus?.(); }
  onHide() { if (!document.pictureInPictureElement) this.media?.pause(); }
  destroy() {
    document.removeEventListener('keydown', this.keyHandler);
    clearTimeout(this.idleT);
    clearTimeout(this.volSave);
    if (document.pictureInPictureElement === this.media) document.exitPictureInPicture().catch(() => {});
    this.media?.pause();
    this.media?.removeAttribute('src');
    this.media?.load();
  }
}
