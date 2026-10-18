// FPS counter: a small floating readout of how many frames a second the app is drawing, in the theme's colours.
// Drag it anywhere; it stays where it was left. On and off in Settings › Appearance (off to start with).

import { h } from './dom.js';

export function createFps(app) {
  let el = null, num = null, raf = 0, frames = 0, last = 0;
  const cfg = () => app.settings.fpsPos || {};

  function build() {
    num = h('b', { class: 'fps-num mono' }, '--');
    el = h('div', { class: 'fps-counter', title: 'Frames per second · drag to move' }, num, h('span', { class: 'fps-unit' }, 'FPS'));
    el.addEventListener('pointerdown', drag);
    el.addEventListener('dragstart', (e) => e.preventDefault());
  }

  function tick(t) {
    frames++;
    if (t - last >= 500) {
      const fps = Math.round((frames * 1000) / (t - last));
      num.textContent = String(fps);
      el.classList.toggle('low', fps < 30);
      frames = 0; last = t;
    }
    raf = requestAnimationFrame(tick);
  }

  function place(x = cfg().x, y = cfg().y) {
    if (!el?.isConnected) return;
    const w = el.offsetWidth || 64, ht = el.offsetHeight || 24;
    x ??= innerWidth - w - 16;
    y ??= 44;
    el.style.left = `${Math.max(0, Math.min(innerWidth - w, x))}px`;
    el.style.top = `${Math.max(0, Math.min(innerHeight - ht, y))}px`;
  }
  addEventListener('resize', () => place());

  function drag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    el.classList.add('dragging');
    const move = (ev) => place(ev.clientX - dx, ev.clientY - dy);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      const q = el.getBoundingClientRect();
      app.saveSettings({ fpsPos: { x: Math.round(q.left), y: Math.round(q.top) } });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** Show or hide it to match the setting. */
  function sync() {
    if (!app.settings.fpsCounter) {
      cancelAnimationFrame(raf); raf = 0;
      el?.remove();
      return;
    }
    if (!el) build();
    if (!el.isConnected) document.body.append(el);
    place();
    if (!raf) { frames = 0; last = performance.now(); raf = requestAnimationFrame(tick); }
  }

  sync();
  return { sync };
}
