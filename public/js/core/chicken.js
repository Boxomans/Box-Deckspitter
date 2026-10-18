// A small white chicken that now and then wanders along the status bar, stopping to peck at the bottom of the window.
// Pixel art drawn from the frames below; pure decoration (no pointer events), and it stays home when animations are off.

const PX = 2;
const COLORS = { W: '#f4f1ea', S: '#c9c0d6', R: '#e8283c', Y: '#ffc93a', O: '#ff8a2a', K: '#1a0a26' };

// 12 × 11, facing right
const FRAMES = {
  walkA: [
    '......RR....',
    '.....RRRR...',
    '....WWWWW...',
    '....WWKWWYY.',
    'W...WWWWWY..',
    'WW.WWWWWR...',
    'WWWWWWWWR...',
    'WWWSSSWWW...',
    '.WWWWWWW....',
    '...O...O....',
    '...OO..OO...',
  ],
  walkB: [
    '......RR....',
    '.....RRRR...',
    '....WWWWW...',
    '....WWKWWYY.',
    'W...WWWWWY..',
    'WW.WWWWWR...',
    'WWWWWWWWR...',
    'WWWSSSWWW...',
    '.WWWWWWW....',
    '.....OO.....',
    '....OOOO....',
  ],
  peck: [
    '............',
    '............',
    '............',
    'W...........',
    'WW...WW.RR..',
    'WWWWWWWRRRR.',
    '.WWWSSWWWWW.',
    '..WWSSWWWWW.',
    '...WWWWWWKW.',
    '...O...OWWWY',
    '...OO..OO.RY',
  ],
};

const W = FRAMES.walkA[0].length * PX, H = FRAMES.walkA.length * PX;

function sprite(rows) {
  let rects = '';
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    if (COLORS[c]) rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${COLORS[c]}"/>`;
  }));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${rows[0].length} ${rows.length}" shape-rendering="crispEdges">${rects}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
const IMG = Object.fromEntries(Object.entries(FRAMES).map(([k, v]) => [k, sprite(v)]));

const rand = (a, b) => a + Math.random() * (b - a);
const still = () => document.documentElement.classList.contains('no-anim') || matchMedia('(prefers-reduced-motion: reduce)').matches;

let state = null;

/** Let the chicken out (on) or shut it away (off). */
export function chicken(on) {
  if (!on) {
    if (state) { clearTimeout(state.timer); cancelAnimationFrame(state.raf); state.el.remove(); state = null; }
    return;
  }
  if (state) return;
  const el = document.createElement('div');
  el.className = 'chicken';
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, { position: 'fixed', bottom: '0', left: '0', width: `${W}px`, height: `${H}px`, zIndex: '61', pointerEvents: 'none',
    backgroundSize: '100% 100%', imageRendering: 'pixelated', display: 'none' });
  document.body.append(el);
  state = { el, timer: 0, raf: 0 };
  state.timer = setTimeout(walk, rand(6000, 15000));
}

/** One trip across: in from one side, a few stops to peck on the way, out the other. */
function walk() {
  const s = state;
  if (!s) return;
  const bar = document.getElementById('statusbar')?.getBoundingClientRect();
  if (still() || document.hidden || !bar?.height) { s.timer = setTimeout(walk, rand(20000, 40000)); return; }
  const dir = Math.random() < 0.5 ? 1 : -1;
  const from = dir > 0 ? bar.left - W : bar.right;
  const to = dir > 0 ? bar.right : bar.left - W;
  const span = Math.abs(to - from);
  // where it stops along the way, in order
  const stops = Array.from({ length: Math.floor(rand(2, 5)) }, () => rand(0.12, 0.88) * span).sort((a, b) => a - b);
  const SPEED = 30; // px a second
  let gone = 0, last = performance.now(), pause = 0, pecks = 0, pt = 0;
  const { el } = s;
  el.style.display = '';
  el.style.transform = dir > 0 ? '' : 'scaleX(-1)';
  el.style.backgroundImage = IMG.walkA;
  const tick = (now) => {
    if (state !== s) return;
    const dt = Math.min(100, now - last); last = now;
    if (pecks > 0) {
      // pecking: head down, up, down... with a short look round between bursts
      pt += dt;
      const phase = Math.floor(pt / 140) % 3;
      el.style.backgroundImage = phase === 1 ? IMG.peck : IMG.walkA;
      if (pt >= 420) { pt = 0; pecks--; if (!pecks) pause = rand(250, 700); }
    } else if (pause > 0) {
      pause -= dt;
      el.style.backgroundImage = IMG.walkA;
    } else {
      gone += (SPEED * dt) / 1000;
      if (stops.length && gone >= stops[0]) { stops.shift(); pecks = Math.floor(rand(2, 5)); pt = 0; }
      el.style.backgroundImage = Math.floor(now / 160) % 2 ? IMG.walkB : IMG.walkA;
    }
    el.style.left = `${Math.round(from + dir * gone)}px`;
    if (gone >= span) { el.style.display = 'none'; s.timer = setTimeout(walk, rand(45000, 120000)); return; }
    s.raf = requestAnimationFrame(tick);
  };
  s.raf = requestAnimationFrame(tick);
}
