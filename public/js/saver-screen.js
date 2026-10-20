// The screensaver page on each display (public/saver.html, opened by electron/saver.js): plays the screensaver it's
// handed. Ending it is the desktop side's job (it watches the keys and the pointer across every screen).

import { SaverPlayer, normalizeSaver } from './core/saver.js';

let player = null;
let pending = null;
window.showSaver = (saver) => {
  pending = saver;
  if (document.readyState === 'loading') return;
  player?.destroy();
  player = new SaverPlayer(document.querySelector('.saver-overlay'), normalizeSaver(pending));
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { if (pending) window.showSaver(pending); });
