// UI sounds: hover, click, typing, opening and closing documents. Preloaded into Web Audio so they play
// instantly; muted with the speaker button in the title bar (settings.sounds).

const FILES = { hover: 'hover.mp3', click: 'click.mp3', type: 'type.mp3', open: 'open.mp3', close: 'close.mp3' };
const LEVEL = { hover: 0.22, click: 0.5, type: 0.32, open: 0.6, close: 0.55 };
const GAP = { hover: 45, click: 35, type: 22, open: 250, close: 250 }; // min ms between repeats

const CLICKABLE = 'button, [role="button"], [role="tab"], a[href], select, summary, label.check, .tab, .file-row, .tree-row, .recent-row, .menu-item, .new-card, .chip, .dump-item, .mail-row, .sp-tile.dir';
const HOVERABLE = 'button, [role="button"], [role="tab"], .tab, .new-card, .menu-item, .chip, .dump-item, .rail-btn, .mail-row';

export function createSounds(app) {
  let ctx = null;
  let master = null;
  const buffers = {};
  const last = {};
  let lastHover = null;

  const on = () => app.settings.sounds !== false;
  const volume = () => Math.max(0, Math.min(1, app.settings.soundVolume ?? 0.7));

  // Browsers only allow audio after the first user gesture, so the engine starts on the first click/key.
  function start() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return; }
    try { ctx = new AudioContext(); } catch { return; }
    master = ctx.createGain();
    master.gain.value = volume();
    master.connect(ctx.destination);
    for (const [name, file] of Object.entries(FILES)) {
      fetch(`/assets/sounds/${file}`).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).then((buf) => { buffers[name] = buf; }).catch(() => {});
    }
  }

  function play(name, { rate = 1 } = {}) {
    if (!on() || !ctx || !buffers[name]) return;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); return; }
    const now = performance.now();
    if (now - (last[name] || 0) < GAP[name]) return;
    last[name] = now;
    const src = ctx.createBufferSource();
    src.buffer = buffers[name];
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = LEVEL[name];
    src.connect(g).connect(master);
    src.start();
  }

  const isEditable = (el) => el && (el.isContentEditable || (el.tagName === 'TEXTAREA') || (el.tagName === 'INPUT' && !/^(checkbox|radio|range|button|submit|color|file)$/i.test(el.type)));

  document.addEventListener('pointerdown', (e) => {
    start();
    if (e.button !== 0 && e.button !== 2) return;
    const el = e.target.closest?.(CLICKABLE);
    if (el && !el.disabled) play('click');
  }, true);

  document.addEventListener('mouseover', (e) => {
    if (!ctx) start();
    if (app.settings.soundHover === false) return;
    const el = e.target.closest?.(HOVERABLE);
    if (el === lastHover) return;
    lastHover = el;
    if (el && !el.disabled) play('hover');
  }, true);

  document.addEventListener('keydown', (e) => {
    start();
    if (app.settings.soundTyping === false || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!(e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter' || e.key === 'Delete' || e.key === 'Tab')) return;
    if (!isEditable(document.activeElement)) return;
    play('type', { rate: 0.92 + Math.random() * 0.16 });
  }, true);

  // In the app window audio is allowed straight away, so load the sounds now. In a plain browser tab this
  // stays suspended until the first click or key press (browser rule), then resumes.
  start();

  return {
    play,
    setVolume() { if (master) master.gain.value = volume(); },
    toggle() {
      const next = !on();
      app.saveSettings({ sounds: next });
      if (next) { start(); setTimeout(() => play('click'), 30); }
      return next;
    },
  };
}
