// BoxSaver's engine. A screensaver is a background and a stack of layers; each layer draws on a canvas of its own,
// laid over the ones below with a blend mode, and can leave trails, mirror itself, blur and spin its colours. The
// whole thing can wobble, go chunky-pixelled, invert or get old-TV lines. Used by the studio (editors/saver.js) for
// its preview and by the screensaver itself (app/screensaver.js). "Your own code" layers run in a sandboxed frame:
// they can draw, but can't reach the app, its files or the network token.

import { uid } from './dom.js';

const TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const hsl = (h, s = 90, l = 60, a = 1) => `hsla(${((h % 360) + 360) % 360} ${s}% ${l}% / ${a})`;

/** A colour as #rrggbb from hue / saturation / lightness (the studio's colour pickers only take hex). */
export function hslHex(hue, s = 90, l = 60) {
  s /= 100; l /= 100;
  const f = (n) => { const k = (n + hue / 30) % 12; const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export const FONTS = [
  ['sans', 'Sans', "'Inter', 'Segoe UI', system-ui, sans-serif"],
  ['serif', 'Serif', "Georgia, 'Times New Roman', serif"],
  ['mono', 'Mono', "'IBM Plex Mono', Consolas, monospace"],
  ['comic', 'Comic', "'Comic Sans MS', 'Comic Sans', cursive"],
  ['impact', 'Impact', "Impact, 'Arial Black', sans-serif"],
];
const fontOf = (id) => (FONTS.find((f) => f[0] === id) || FONTS[0])[2];
const FONT_OPTS = FONTS.map(([v, l]) => [v, l]);

export const BLENDS = [['normal', 'Normal'], ['screen', 'Screen (lighter)'], ['multiply', 'Multiply (darker)'], ['overlay', 'Overlay'],
  ['difference', 'Difference'], ['exclusion', 'Exclusion'], ['color-dodge', 'Colour dodge'], ['hue', 'Hue'], ['luminosity', 'Luminosity']];

// The settings every layer has. Param kinds: range {min, max, step}, color, text, select {options}, check, image, code.
export const COMMON = [
  { key: 'opacity', label: 'Opacity', kind: 'range', min: 0, max: 1, step: 0.05, def: 1 },
  { key: 'blend', label: 'Blend', kind: 'select', options: BLENDS, def: 'normal' },
  { key: 'speed', label: 'Speed', kind: 'range', min: 0, max: 5, step: 0.1, def: 1, unit: '×' },
  { key: 'trails', label: 'Trails', kind: 'range', min: 0, max: 0.98, step: 0.02, def: 0 },
  { key: 'hueSpin', label: 'Colour spin', kind: 'range', min: -360, max: 360, step: 5, def: 0, unit: '°/s' },
  { key: 'blur', label: 'Blur', kind: 'range', min: 0, max: 20, step: 1, def: 0, unit: 'px' },
  { key: 'mirror', label: 'Mirror', kind: 'select', options: [['none', 'None'], ['lr', 'Left ↔ right'], ['tb', 'Top ↕ bottom'], ['quad', 'Four ways']], def: 'none' },
];

// The whole screensaver's own settings.
export const SAVER_PARAMS = [
  { key: 'bg', label: 'Background', kind: 'color', def: '#000000' },
  { key: 'gradient', label: 'Gradient', kind: 'check', def: false },
  { key: 'bg2', label: 'Fades to', kind: 'color', def: '#2a0b4a', when: (s) => s.gradient },
  { key: 'bgAngle', label: 'Direction', kind: 'range', min: 0, max: 359, step: 1, def: 135, unit: '°', when: (s) => s.gradient },
  { key: 'bgSpin', label: 'Gradient spin', kind: 'range', min: -180, max: 180, step: 5, def: 0, unit: '°/s', when: (s) => s.gradient },
  { key: 'speed', label: 'Speed', kind: 'range', min: 0, max: 4, step: 0.1, def: 1, unit: '×' },
  { key: 'pixel', label: 'Pixel size', kind: 'select', options: [[1, 'Sharp'], [2, '2 px'], [3, '3 px'], [4, '4 px'], [6, '6 px'], [8, '8 px'], [12, '12 px (very chunky)']], def: 1 },
  { key: 'hueSpin', label: 'Colour spin', kind: 'range', min: -360, max: 360, step: 5, def: 0, unit: '°/s' },
  { key: 'wobble', label: 'Wobble', kind: 'range', min: 0, max: 10, step: 0.5, def: 0 },
  { key: 'invert', label: 'Invert colours', kind: 'check', def: false },
  { key: 'scanlines', label: 'Old TV lines', kind: 'check', def: false },
];

// ---------------------------------------------------------------- pictures (kept in the screensaver as data URLs)
const IMAGES = new Map();
function imageOf(src) {
  if (!src) return null;
  let img = IMAGES.get(src);
  if (!img) { img = new Image(); img.src = src; IMAGES.set(src, img); if (IMAGES.size > 40) IMAGES.delete(IMAGES.keys().next().value); }
  return img.complete && img.naturalWidth ? img : null;
}

/** Fades what's on a layer instead of wiping it, so things leave trails. Also put into the code layer's frame. */
function fade(ctx, w, h, trails) {
  if (!(trails > 0)) { ctx.clearRect(0, 0, w, h); return; }
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = `rgba(0,0,0,${Math.max(0.02, 1 - trails)})`;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Copies the left half over the right one flipped (and / or the top over the bottom). */
function mirror(ctx, canvas, w, h, mode) {
  const flip = (lr) => {
    ctx.save();
    ctx.beginPath();
    if (lr) ctx.rect(Math.floor(w / 2), 0, w, h); else ctx.rect(0, Math.floor(h / 2), w, h);
    ctx.clip();
    ctx.globalCompositeOperation = 'copy';
    if (lr) { ctx.translate(w, 0); ctx.scale(-1, 1); ctx.drawImage(canvas, 0, 0, Math.ceil(w / 2), h, 0, 0, Math.ceil(w / 2), h); }
    else { ctx.translate(0, h); ctx.scale(1, -1); ctx.drawImage(canvas, 0, 0, w, Math.ceil(h / 2), 0, 0, w, Math.ceil(h / 2)); }
    ctx.restore();
  };
  if (mode === 'lr' || mode === 'quad') flip(true);
  if (mode === 'tb' || mode === 'quad') flip(false);
}

/** Little bursts of sparks (corner hits, fireworks). */
function sparks() {
  const list = [];
  return {
    burst(x, y, n, speed, hue, rainbow) {
      for (let i = 0; i < n; i++) {
        const a = rnd(0, TAU), v = rnd(0.2, 1) * speed;
        list.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rnd(0.8, 1.6), age: 0, hue: rainbow ? rnd(0, 360) : hue });
      }
      if (list.length > 6000) list.splice(0, list.length - 6000);
    },
    draw(ctx, dt, gravity, r, color) {
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        p.age += dt;
        if (p.age > p.life) { list.splice(i, 1); continue; }
        p.vx *= 1 - 0.8 * dt; p.vy = p.vy * (1 - 0.8 * dt) + gravity * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        ctx.fillStyle = p.hue == null ? color : hsl(p.hue, 95, 62, 1 - p.age / p.life);
        if (p.hue == null) ctx.globalAlpha = 1 - p.age / p.life;
        ctx.fillRect(p.x - r / 2, p.y - r / 2, r, r);
        ctx.globalAlpha = 1;
      }
    },
  };
}

// ---------------------------------------------------------------- the layers
// make() returns { draw(ctx, L, dt, t, w, h, sc) }: L is the layer's settings (read every frame, so the studio's
// changes show straight away), w × h the canvas in its own pixels, sc canvas pixels per screen pixel.
export const LAYERS = {
  bounce: {
    name: 'Bouncing things', icon: 'move',
    params: [
      { key: 'text', label: 'What bounces (words or emoji)', kind: 'text', def: 'BOX' },
      { key: 'image', label: '…or a picture', kind: 'image', def: null },
      { key: 'count', label: 'How many', kind: 'range', min: 1, max: 150, step: 1, def: 1 },
      { key: 'size', label: 'Size', kind: 'range', min: 10, max: 400, step: 2, def: 90, unit: 'px' },
      { key: 'color', label: 'Colour', kind: 'color', def: '#ffffff' },
      { key: 'rainbow', label: 'New colour every time it hits a wall', kind: 'check', def: true },
      { key: 'spin', label: 'Spin', kind: 'range', min: -6, max: 6, step: 0.5, def: 0 },
      { key: 'font', label: 'Font', kind: 'select', options: FONT_OPTS, def: 'impact' },
      { key: 'party', label: 'Sparks when it hits a corner', kind: 'check', def: true },
    ],
    texts: ['BOX', '🐸', '💿', '🛸', 'NO SIGNAL', '🍕', '👁', 'zzz', '🦆', 'HELLO?'],
    make() {
      const items = [], fx = sparks();
      return { draw(ctx, L, dt, t, w, h, sc) {
        const size = Math.max(4, L.size * sc), img = imageOf(L.image);
        ctx.font = `bold ${size}px ${fontOf(L.font)}`;
        const text = L.text || '·';
        const bw = img ? size * img.naturalWidth / img.naturalHeight : Math.max(4, ctx.measureText(text).width), bh = size;
        const n = Math.max(1, Math.round(L.count));
        while (items.length < n) items.push({ x: rnd(0, Math.max(1, w - bw)), y: rnd(0, Math.max(1, h - bh)), vx: pick([-1, 1]) * rnd(0.75, 1), vy: pick([-1, 1]) * rnd(0.75, 1), hue: rnd(0, 360), a: 0 });
        items.length = n;
        const v = 170 * sc, tolX = w * 0.015, tolY = h * 0.015;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const p of items) {
          p.x += p.vx * v * dt; p.y += p.vy * v * dt; p.a += L.spin * dt;
          let hx = false, hy = false;
          if (p.x < 0) { p.x = 0; p.vx = Math.abs(p.vx); hx = true; } else if (p.x + bw > w) { p.x = Math.max(0, w - bw); p.vx = -Math.abs(p.vx); hx = true; }
          if (p.y < 0) { p.y = 0; p.vy = Math.abs(p.vy); hy = true; } else if (p.y + bh > h) { p.y = Math.max(0, h - bh); p.vy = -Math.abs(p.vy); hy = true; }
          if ((hx || hy) && L.rainbow) p.hue = (p.hue + rnd(70, 200)) % 360;
          const corner = (hx && (p.y < tolY || p.y + bh > h - tolY)) || (hy && (p.x < tolX || p.x + bw > w - tolX));
          if (corner && L.party) fx.burst(p.x + bw / 2, p.y + bh / 2, 140, 520 * sc, p.hue, true);
          ctx.save();
          ctx.translate(p.x + bw / 2, p.y + bh / 2);
          if (p.a) ctx.rotate(p.a);
          if (img) {
            if (L.rainbow) ctx.filter = `hue-rotate(${Math.round(p.hue)}deg)`;
            ctx.drawImage(img, -bw / 2, -bh / 2, bw, bh);
          } else {
            ctx.fillStyle = L.rainbow ? hsl(p.hue) : L.color;
            ctx.fillText(text, 0, 0);
          }
          ctx.restore();
        }
        fx.draw(ctx, dt, 300 * sc, 3 * sc, L.color);
      } };
    },
  },

  stars: {
    name: 'Starfield', icon: 'sparkle',
    params: [
      { key: 'count', label: 'Stars', kind: 'range', min: 50, max: 3000, step: 50, def: 700 },
      { key: 'size', label: 'Star size', kind: 'range', min: 0.5, max: 6, step: 0.5, def: 1.5, unit: 'px' },
      { key: 'color', label: 'Colour', kind: 'color', def: '#ffffff' },
      { key: 'rainbow', label: 'Rainbow stars', kind: 'check', def: false },
      { key: 'streaks', label: 'Warp streaks', kind: 'check', def: true },
      { key: 'wander', label: 'Steer around', kind: 'check', def: false },
    ],
    make() {
      const st = [];
      const spawn = (s, far) => { s.x = rnd(-1, 1); s.y = rnd(-1, 1); s.z = far ? 1 : rnd(0.05, 1); s.hue = rnd(0, 360); return s; };
      return { draw(ctx, L, dt, t, w, h, sc) {
        const n = Math.round(L.count);
        while (st.length < n) st.push(spawn({}, false));
        st.length = n;
        const cx = w / 2 + (L.wander ? Math.sin(t * 0.37) * w * 0.25 : 0), cy = h / 2 + (L.wander ? Math.cos(t * 0.29) * h * 0.22 : 0);
        const k = Math.max(w, h) * 0.5, dz = dt * 0.35;
        ctx.lineCap = 'round';
        for (const s of st) {
          const z0 = s.z;
          s.z -= dz;
          if (s.z <= 0.02) { spawn(s, true); continue; }
          const x = cx + s.x / s.z * k, y = cy + s.y / s.z * k;
          if (x < -50 || x > w + 50 || y < -50 || y > h + 50) { spawn(s, true); continue; }
          const r = Math.max(0.4, L.size * sc * (1.2 - s.z));
          const c = L.rainbow ? hsl(s.hue, 90, 70) : L.color;
          ctx.globalAlpha = Math.min(1, (1 - s.z) * 1.6);
          if (L.streaks) {
            ctx.strokeStyle = c; ctx.lineWidth = r;
            ctx.beginPath(); ctx.moveTo(cx + s.x / z0 * k, cy + s.y / z0 * k); ctx.lineTo(x, y); ctx.stroke();
          } else { ctx.fillStyle = c; ctx.fillRect(x - r / 2, y - r / 2, r, r); }
        }
        ctx.globalAlpha = 1;
      } };
    },
  },

  rain: {
    name: 'Code rain', icon: 'terminal',
    params: [
      { key: 'chars', label: 'Characters', kind: 'text', def: 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ0123456789' },
      { key: 'size', label: 'Size', kind: 'range', min: 8, max: 60, step: 1, def: 18, unit: 'px' },
      { key: 'color', label: 'Colour', kind: 'color', def: '#3dff7a' },
      { key: 'rainbow', label: 'Rainbow columns', kind: 'check', def: false },
      { key: 'density', label: 'How much rain', kind: 'range', min: 0.05, max: 1, step: 0.05, def: 0.8 },
      { key: 'font', label: 'Font', kind: 'select', options: FONT_OPTS, def: 'mono' },
    ],
    defaults: { trails: 0.92 },
    texts: ['ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ0123456789', '01', '🌧💧☔', '▓▒░█', 'zzzzzz', '◢◣◤◥'],
    make() {
      let cols = [];
      return { draw(ctx, L, dt, t, w, h, sc) {
        const size = Math.max(5, L.size * sc), n = Math.ceil(w / size), rows = Math.ceil(h / size) + 1;
        const chars = [...(L.chars || '01')];
        while (cols.length < n) cols.push({ y: rnd(-rows, 0), v: rnd(6, 16), row: -1, hue: rnd(0, 360) });
        cols.length = n;
        ctx.font = `${size}px ${fontOf(L.font)}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        cols.forEach((c, i) => {
          c.y += c.v * dt;
          const row = Math.floor(c.y);
          if (row === c.row) return;
          const x = i * size + size / 2;
          // the one behind the head goes to the rain's colour; the head is a bright new character
          if (c.row >= 0 && c.prev) { ctx.fillStyle = L.rainbow ? hsl(c.hue) : L.color; ctx.clearRect(i * size, c.row * size, size, size); ctx.fillText(c.prev, x, c.row * size); }
          c.row = row;
          if (row > rows) { if (Math.random() < L.density) { c.y = rnd(-8, 0); c.v = rnd(6, 16); c.hue = rnd(0, 360); } c.row = -1; c.prev = null; return; }
          c.prev = pick(chars);
          ctx.fillStyle = L.rainbow ? hsl(c.hue, 100, 85) : '#ffffff';
          ctx.fillText(c.prev, x, row * size);
        });
      } };
    },
  },

  plasma: {
    name: 'Plasma', icon: 'wave',
    params: [
      { key: 'palette', label: 'Colours', kind: 'select', options: [['rainbow', 'Rainbow'], ['fire', 'Fire'], ['ocean', 'Ocean'], ['acid', 'Acid'], ['candy', 'Candy'], ['one', 'Shades of one colour']], def: 'rainbow' },
      { key: 'color', label: 'The colour', kind: 'color', def: '#ff3df0', when: (L) => L.palette === 'one' },
      { key: 'scale', label: 'Size of the blobs', kind: 'range', min: 0.2, max: 4, step: 0.1, def: 1 },
      { key: 'bands', label: 'Bands', kind: 'range', min: 1, max: 8, step: 1, def: 1 },
      { key: 'pixelly', label: 'Blocky', kind: 'check', def: false },
    ],
    make() {
      const off = document.createElement('canvas'), octx = off.getContext('2d');
      let img = null, lut = null, lutFor = '';
      const buildLut = (L) => {
        lut = new Uint8ClampedArray(256 * 3);
        const one = L.color || '#ff3df0';
        const cr = parseInt(one.slice(1, 3), 16), cg = parseInt(one.slice(3, 5), 16), cb = parseInt(one.slice(5, 7), 16);
        for (let i = 0; i < 256; i++) {
          const v = i / 255, s = Math.sin(v * TAU) * 0.5 + 0.5;
          let r, g, b;
          switch (L.palette) {
            case 'fire': r = 255 * Math.min(1, s * 2); g = 255 * Math.max(0, s * 2 - 0.6); b = 255 * Math.max(0, s * 3 - 2.4); break;
            case 'ocean': r = 20 * s; g = 120 + 120 * s; b = 160 + 95 * Math.cos(v * TAU * 2) * 0.5 + 47; break;
            case 'acid': r = 128 + 127 * Math.sin(v * TAU * 3); g = 255 * s; b = 128 + 127 * Math.sin(v * TAU * 5 + 2); break;
            case 'candy': r = 255; g = 120 + 120 * Math.sin(v * TAU + 1); b = 200 + 55 * Math.cos(v * TAU * 2); break;
            case 'one': r = cr * s; g = cg * s; b = cb * s; break;
            default: { const hex = hslHex(v * 360, 95, 55); r = parseInt(hex.slice(1, 3), 16); g = parseInt(hex.slice(3, 5), 16); b = parseInt(hex.slice(5, 7), 16); }
          }
          lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b;
        }
        lutFor = L.palette + one;
      };
      return { draw(ctx, L, dt, t, w, h) {
        if (lutFor !== L.palette + (L.color || '#ff3df0')) buildLut(L);
        const W = Math.max(16, Math.round(w / (L.pixelly ? 24 : 7))), H = Math.max(9, Math.round(W * h / w));
        if (off.width !== W || off.height !== H) { off.width = W; off.height = H; img = octx.createImageData(W, H); }
        const d = img.data, f = 6 / (L.scale * W), bands = L.bands || 1, shift = t * 40;
        const cx = W / 2 + Math.sin(t * 0.5) * W * 0.3, cy = H / 2 + Math.cos(t * 0.4) * H * 0.3;
        for (let y = 0, o = 0; y < H; y++) {
          for (let x = 0; x < W; x++, o += 4) {
            const v = Math.sin(x * f * 1.3 + t) + Math.sin((y * f + t) * 0.8) + Math.sin((x * f + y * f) * 0.7 + t * 1.3)
              + Math.sin(Math.hypot(x - cx, y - cy) * f * 1.6 - t * 1.7);
            const i = ((((v + 4) / 8) * 255 * bands + shift) | 0) & 255;
            d[o] = lut[i * 3]; d[o + 1] = lut[i * 3 + 1]; d[o + 2] = lut[i * 3 + 2]; d[o + 3] = 255;
          }
        }
        octx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = !L.pixelly;
        ctx.drawImage(off, 0, 0, w, h);
      } };
    },
  },

  lines: {
    name: 'Mystify lines', icon: 'diff',
    params: [
      { key: 'shapes', label: 'Shapes', kind: 'range', min: 1, max: 6, step: 1, def: 2 },
      { key: 'points', label: 'Corners each', kind: 'range', min: 2, max: 8, step: 1, def: 4 },
      { key: 'echoes', label: 'Echoes', kind: 'range', min: 1, max: 40, step: 1, def: 10 },
      { key: 'width', label: 'Line width', kind: 'range', min: 0.5, max: 10, step: 0.5, def: 1.5, unit: 'px' },
      { key: 'color', label: 'Colour', kind: 'color', def: '#64d2ff' },
      { key: 'rainbow', label: 'Shifting colours', kind: 'check', def: true },
      { key: 'fill', label: 'Filled in', kind: 'check', def: false },
    ],
    make() {
      const shapes = [];
      return { draw(ctx, L, dt, t, w, h, sc) {
        const ns = Math.round(L.shapes), np = Math.round(L.points);
        while (shapes.length < ns) shapes.push({ pts: [], hist: [], hue: rnd(0, 360), tick: 0 });
        shapes.length = ns;
        const v = 260 * sc;
        ctx.lineWidth = L.width * sc; ctx.lineJoin = 'round';
        for (const s of shapes) {
          while (s.pts.length < np) s.pts.push({ x: rnd(0, w), y: rnd(0, h), vx: rnd(-1, 1), vy: rnd(-1, 1) });
          s.pts.length = np;
          for (const p of s.pts) {
            p.x += p.vx * v * dt; p.y += p.vy * v * dt;
            if (p.x < 0 || p.x > w) { p.vx = -p.vx; p.x = Math.max(0, Math.min(w, p.x)); }
            if (p.y < 0 || p.y > h) { p.vy = -p.vy; p.y = Math.max(0, Math.min(h, p.y)); }
          }
          s.hue += dt * 30;
          s.tick += dt;
          if (s.tick > 0.045) { s.tick = 0; s.hist.unshift(s.pts.map((p) => [p.x, p.y])); }
          s.hist.length = Math.min(s.hist.length, Math.round(L.echoes));
          s.hist.forEach((pts, i) => {
            const a = 1 - i / Math.max(1, s.hist.length);
            const c = L.rainbow ? hsl(s.hue - i * 6, 90, 62, a) : L.color;
            ctx.beginPath();
            pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
            ctx.closePath();
            if (L.fill) { ctx.fillStyle = c; ctx.globalAlpha = L.rainbow ? 0.25 : 0.25 * a; ctx.fill(); ctx.globalAlpha = 1; }
            ctx.strokeStyle = c; if (!L.rainbow) ctx.globalAlpha = a;
            ctx.stroke(); ctx.globalAlpha = 1;
          });
        }
      } };
    },
  },

  tunnel: {
    name: 'Tunnel', icon: 'tunnel',
    params: [
      { key: 'shape', label: 'Shape', kind: 'select', options: [['circle', 'Circles'], ['square', 'Squares'], ['triangle', 'Triangles'], ['star', 'Stars'], ['heart', 'Hearts']], def: 'circle' },
      { key: 'rings', label: 'Rings', kind: 'range', min: 4, max: 60, step: 1, def: 24 },
      { key: 'twist', label: 'Twist', kind: 'range', min: -3, max: 3, step: 0.1, def: 0.6 },
      { key: 'width', label: 'Line width', kind: 'range', min: 1, max: 30, step: 1, def: 4, unit: 'px' },
      { key: 'color', label: 'Colour', kind: 'color', def: '#ff4fd8' },
      { key: 'rainbow', label: 'Rainbow rings', kind: 'check', def: true },
      { key: 'sway', label: 'Sway', kind: 'check', def: true },
    ],
    make() {
      const path = (ctx, shape, r) => {
        ctx.beginPath();
        if (shape === 'circle') { ctx.arc(0, 0, r, 0, TAU); return; }
        if (shape === 'heart') {
          ctx.moveTo(0, r * 0.7);
          ctx.bezierCurveTo(r * 1.3, -r * 0.2, r * 0.6, -r * 1.1, 0, -r * 0.45);
          ctx.bezierCurveTo(-r * 0.6, -r * 1.1, -r * 1.3, -r * 0.2, 0, r * 0.7);
          return;
        }
        const n = shape === 'square' ? 4 : shape === 'triangle' ? 3 : 10;
        for (let i = 0; i < n; i++) {
          const a = i / n * TAU - Math.PI / 2, rr = shape === 'star' && i % 2 ? r * 0.45 : r;
          i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
      };
      return { draw(ctx, L, dt, t, w, h, sc) {
        const n = Math.round(L.rings), max = Math.hypot(w, h) * 0.75;
        ctx.lineWidth = L.width * sc;
        for (let i = 0; i < n; i++) {
          const f = ((i / n + t * 0.12) % 1), r = Math.pow(f, 2.2) * max;
          if (r < 1) continue;
          ctx.save();
          const sx = L.sway ? Math.sin(t * 0.8 + f * 3) * w * 0.12 * (1 - f) : 0, sy = L.sway ? Math.cos(t * 0.6 + f * 3) * h * 0.12 * (1 - f) : 0;
          ctx.translate(w / 2 + sx, h / 2 + sy);
          ctx.rotate(L.twist * f * 3 + t * L.twist * 0.3);
          ctx.strokeStyle = L.rainbow ? hsl(f * 360 - t * 90) : L.color;
          ctx.globalAlpha = Math.min(1, f * 3);
          path(ctx, L.shape, r);
          ctx.stroke();
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      } };
    },
  },

  words: {
    name: 'Wavy words', icon: 'type',
    params: [
      { key: 'text', label: 'Words', kind: 'text', def: 'hello' },
      { key: 'mode', label: 'Moves', kind: 'select', options: [['wave', 'Wave'], ['scroll', 'Scroll past'], ['orbit', 'Round in a circle'], ['shake', 'Shake'], ['throb', 'Throb']], def: 'wave' },
      { key: 'size', label: 'Size', kind: 'range', min: 12, max: 300, step: 2, def: 80, unit: 'px' },
      { key: 'amount', label: 'How much', kind: 'range', min: 0, max: 100, step: 1, def: 30 },
      { key: 'color', label: 'Colour', kind: 'color', def: '#ffd23d' },
      { key: 'rainbow', label: 'Rainbow letters', kind: 'check', def: true },
      { key: 'font', label: 'Font', kind: 'select', options: FONT_OPTS, def: 'comic' },
      { key: 'outline', label: 'Outline', kind: 'check', def: false },
    ],
    texts: ['hello', 'are you still there?', 'zzz', 'BRB', 'wiggle', 'press any key', 'the void says hi', '¯\\_(ツ)_/¯'],
    make() {
      return { draw(ctx, L, dt, t, w, h, sc) {
        const chars = [...(L.text || ' ')], size = L.size * sc, amt = L.amount * sc;
        ctx.font = `bold ${size}px ${fontOf(L.font)}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(1, size / 18); ctx.strokeStyle = '#000';
        const widths = chars.map((c) => ctx.measureText(c).width), total = widths.reduce((a, b) => a + b, 0);
        let x0 = (w - total) / 2;
        if (L.mode === 'scroll') x0 = w - ((t * 140 * sc) % (w + total));
        const throb = L.mode === 'throb' ? 1 + Math.sin(t * 3) * L.amount / 120 : 1;
        let x = x0;
        chars.forEach((c, i) => {
          const cw = widths[i];
          ctx.save();
          if (L.mode === 'orbit') {
            const R = Math.min(w, h) * 0.32, a = t * 0.6 + (i / chars.length) * TAU;
            ctx.translate(w / 2 + Math.cos(a) * R, h / 2 + Math.sin(a) * R);
            ctx.rotate(a + Math.PI / 2);
          } else {
            let y = h / 2;
            if (L.mode === 'wave' || L.mode === 'scroll') y += Math.sin(t * 3 + i * 0.55) * amt;
            let dx = 0;
            if (L.mode === 'shake') { dx = rnd(-1, 1) * amt * 0.3; y += rnd(-1, 1) * amt * 0.3; }
            ctx.translate(L.mode === 'throb' ? w / 2 + (x + cw / 2 - w / 2) * throb : x + cw / 2 + dx, y);
            if (throb !== 1) ctx.scale(throb, throb);
          }
          ctx.fillStyle = L.rainbow ? hsl(i * 28 + t * 120) : L.color;
          if (L.outline) ctx.strokeText(c, 0, 0);
          ctx.fillText(c, 0, 0);
          ctx.restore();
          x += cw;
        });
      } };
    },
  },

  clock: {
    name: 'Clock', icon: 'clock',
    params: [
      { key: 'format', label: 'Shows', kind: 'select', options: [['hm', '12:34'], ['hms', '12:34:56'], ['ampm', '12:34 PM'], ['date', 'Date and time'],
        ['midnight', 'Time until midnight'], ['unix', 'Seconds since 1970'], ['hex', 'Hex time (the day in 65536 parts)'], ['binary', 'Binary time']], def: 'hm' },
      { key: 'size', label: 'Size', kind: 'range', min: 16, max: 400, step: 2, def: 120, unit: 'px' },
      { key: 'color', label: 'Colour', kind: 'color', def: '#ffffff' },
      { key: 'glow', label: 'Glow', kind: 'range', min: 0, max: 60, step: 2, def: 0, unit: 'px' },
      { key: 'font', label: 'Font', kind: 'select', options: FONT_OPTS, def: 'mono' },
      { key: 'drift', label: 'Drift around the screen', kind: 'check', def: true },
    ],
    make() {
      const pos = { x: 0.3, y: 0.4, vx: 1, vy: 0.7 };
      const pad = (n, k = 2) => String(n).padStart(k, '0');
      const text = (f) => {
        const d = new Date(), hh = d.getHours(), mm = pad(d.getMinutes()), ss = pad(d.getSeconds());
        switch (f) {
          case 'hms': return `${pad(hh)}:${mm}:${ss}`;
          case 'ampm': return `${hh % 12 || 12}:${mm} ${hh < 12 ? 'AM' : 'PM'}`;
          case 'date': return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}  ${pad(hh)}:${mm}`;
          case 'midnight': { const left = 86400 - (hh * 3600 + d.getMinutes() * 60 + d.getSeconds()); return `${pad(Math.floor(left / 3600))}:${pad(Math.floor(left / 60) % 60)}:${pad(left % 60)}`; }
          case 'unix': return String(Math.floor(d.getTime() / 1000));
          case 'hex': return '0x' + Math.floor((hh * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400 * 65536).toString(16).toUpperCase().padStart(4, '0');
          case 'binary': return `${hh.toString(2).padStart(5, '0')}:${d.getMinutes().toString(2).padStart(6, '0')}`;
          default: return `${pad(hh)}:${mm}`;
        }
      };
      return { draw(ctx, L, dt, t, w, h, sc) {
        const s = text(L.format), size = L.size * sc;
        ctx.font = `bold ${size}px ${fontOf(L.font)}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const tw = ctx.measureText(s).width;
        let x = w / 2, y = h / 2;
        if (L.drift) {
          const v = 40 * sc / Math.max(1, w), vy = 40 * sc / Math.max(1, h);
          pos.x += pos.vx * v * dt; pos.y += pos.vy * vy * dt;
          const mx = Math.min(0.5, tw / 2 / w), my = Math.min(0.5, size / 2 / h);
          if (pos.x < mx || pos.x > 1 - mx) { pos.vx = -pos.vx; pos.x = Math.max(mx, Math.min(1 - mx, pos.x)); }
          if (pos.y < my || pos.y > 1 - my) { pos.vy = -pos.vy; pos.y = Math.max(my, Math.min(1 - my, pos.y)); }
          x = pos.x * w; y = pos.y * h;
        }
        if (L.glow) { ctx.shadowColor = L.color; ctx.shadowBlur = L.glow * sc; }
        ctx.fillStyle = L.color;
        ctx.fillText(s, x, y);
        ctx.shadowBlur = 0;
      } };
    },
  },

  fireworks: {
    name: 'Fireworks', icon: 'sparkle',
    params: [
      { key: 'rate', label: 'Rockets a second', kind: 'range', min: 0.2, max: 12, step: 0.2, def: 1.6 },
      { key: 'burst', label: 'Sparks each', kind: 'range', min: 10, max: 400, step: 10, def: 90 },
      { key: 'power', label: 'Bang size', kind: 'range', min: 0.3, max: 3, step: 0.1, def: 1 },
      { key: 'gravity', label: 'Gravity', kind: 'range', min: -1, max: 3, step: 0.1, def: 1 },
      { key: 'color', label: 'Colour', kind: 'color', def: '#ffcf4a' },
      { key: 'rainbow', label: 'Every spark a different colour', kind: 'check', def: false },
      { key: 'spark', label: 'Spark size', kind: 'range', min: 1, max: 8, step: 0.5, def: 2.5, unit: 'px' },
    ],
    defaults: { trails: 0.86 },
    make() {
      const rockets = [], fx = sparks();
      let due = 0;
      return { draw(ctx, L, dt, t, w, h, sc) {
        due -= dt;
        if (due <= 0) { due = rnd(0.4, 1.6) / L.rate; rockets.push({ x: rnd(w * 0.1, w * 0.9), y: h, vy: -rnd(0.9, 1.25) * Math.sqrt(h * 700 * sc), vx: rnd(-40, 40) * sc, hue: rnd(0, 360) }); }
        const g = 700 * sc;
        ctx.fillStyle = '#fff';
        for (let i = rockets.length - 1; i >= 0; i--) {
          const r = rockets[i];
          r.vy += g * dt; r.x += r.vx * dt; r.y += r.vy * dt;
          ctx.fillRect(r.x - sc, r.y - sc * 3, 2 * sc, 6 * sc);
          if (r.vy >= -40 * sc) { fx.burst(r.x, r.y, Math.round(L.burst), 380 * sc * L.power, r.hue, L.rainbow); rockets.splice(i, 1); }
        }
        fx.draw(ctx, dt, 140 * sc * L.gravity, L.spark * sc, L.rainbow ? '#fff' : null);
      } };
    },
  },

  life: {
    name: 'Game of Life', icon: 'grid',
    params: [
      { key: 'cell', label: 'Cell size', kind: 'range', min: 2, max: 40, step: 1, def: 8, unit: 'px' },
      { key: 'rate', label: 'Steps a second', kind: 'range', min: 1, max: 60, step: 1, def: 12 },
      { key: 'color', label: 'Colour', kind: 'color', def: '#7cf6ff' },
      { key: 'rainbow', label: 'Colour by age', kind: 'check', def: true },
      { key: 'round', label: 'Round cells', kind: 'check', def: false },
    ],
    make() {
      let cols = 0, rows = 0, grid = null, age = null, acc = 0, same = 0, lastCount = -1;
      const seed = () => { for (let i = 0; i < grid.length; i++) { grid[i] = Math.random() < 0.28 ? 1 : 0; age[i] = 0; } same = 0; };
      const step = () => {
        const next = new Uint8Array(grid.length);
        let count = 0;
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            let n = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              if (dx || dy) n += grid[((y + dy + rows) % rows) * cols + ((x + dx + cols) % cols)];
            }
            const i = y * cols + x, alive = grid[i] ? n === 2 || n === 3 : n === 3;
            next[i] = alive ? 1 : 0;
            age[i] = alive ? Math.min(65535, age[i] + 1) : 0;
            count += next[i];
          }
        }
        grid = next;
        // stuck (or nearly empty): start again
        same = count === lastCount ? same + 1 : 0;
        lastCount = count;
        if (same > 50 || count < grid.length * 0.01) seed();
      };
      return { draw(ctx, L, dt, t, w, h, sc) {
        const cs = Math.max(2, L.cell * sc), c = Math.ceil(w / cs), r = Math.ceil(h / cs);
        if (c !== cols || r !== rows) { cols = c; rows = r; grid = new Uint8Array(c * r); age = new Uint16Array(c * r); seed(); }
        acc += dt * L.rate;
        for (let k = 0; acc >= 1 && k < 4; k++) { acc -= 1; step(); }
        if (acc > 4) acc = 0;
        for (let i = 0; i < grid.length; i++) {
          if (!grid[i]) continue;
          const x = (i % cols) * cs, y = Math.floor(i / cols) * cs;
          ctx.fillStyle = L.rainbow ? hsl(age[i] * 9 + t * 20, 90, 60) : L.color;
          if (L.round) { ctx.beginPath(); ctx.arc(x + cs / 2, y + cs / 2, cs * 0.42, 0, TAU); ctx.fill(); } else ctx.fillRect(x, y, cs - (cs > 4 ? 1 : 0), cs - (cs > 4 ? 1 : 0));
        }
      } };
    },
  },

  picture: {
    name: 'Picture', icon: 'image',
    params: [
      { key: 'image', label: 'Picture', kind: 'image', def: null },
      { key: 'mode', label: 'Moves', kind: 'select', options: [['drift', 'Drift around'], ['spin', 'Spin in the middle'], ['throb', 'Throb'], ['tile', 'Tiled, scrolling'], ['orbit', 'Round in a circle']], def: 'spin' },
      { key: 'size', label: 'Size', kind: 'range', min: 20, max: 1000, step: 10, def: 260, unit: 'px' },
      { key: 'amount', label: 'How much', kind: 'range', min: 0, max: 100, step: 1, def: 40 },
    ],
    make() {
      const pos = { x: 0.3, y: 0.3, vx: 1, vy: 0.8 };
      return { draw(ctx, L, dt, t, w, h, sc) {
        const img = imageOf(L.image);
        if (!img) {
          ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = `${16 * sc}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('Pick a picture for this layer', w / 2, h / 2);
          return;
        }
        const ph = L.size * sc, pw = ph * img.naturalWidth / img.naturalHeight, a = L.amount / 100;
        if (L.mode === 'tile') {
          const ox = (t * 60 * sc * (0.5 + a)) % pw, oy = (t * 40 * sc * (0.5 + a)) % ph;
          for (let y = -ph + oy; y < h; y += ph) for (let x = -pw + ox; x < w; x += pw) ctx.drawImage(img, x, y, pw, ph);
          return;
        }
        ctx.save();
        if (L.mode === 'drift') {
          pos.x += pos.vx * 90 * sc * dt; pos.y += pos.vy * 90 * sc * dt;
          if (pos.x < 0 || pos.x + pw > w) { pos.vx = -pos.vx; pos.x = Math.max(0, Math.min(w - pw, pos.x)); }
          if (pos.y < 0 || pos.y + ph > h) { pos.vy = -pos.vy; pos.y = Math.max(0, Math.min(h - ph, pos.y)); }
          ctx.translate(pos.x + pw / 2, pos.y + ph / 2);
          ctx.rotate(Math.sin(t) * a * 0.4);
        } else if (L.mode === 'orbit') {
          const R = Math.min(w, h) * 0.3 * (0.4 + a);
          ctx.translate(w / 2 + Math.cos(t) * R, h / 2 + Math.sin(t) * R);
        } else {
          ctx.translate(w / 2, h / 2);
          if (L.mode === 'spin') ctx.rotate(t * (0.3 + a * 3));
          else { const k = 1 + Math.sin(t * 3) * a * 0.6; ctx.scale(k, k); }
        }
        ctx.drawImage(img, -pw / 2, -ph / 2, pw, ph);
        ctx.restore();
      } };
    },
  },

  static: {
    name: 'TV static', icon: 'monitor',
    params: [
      { key: 'grain', label: 'Grain', kind: 'range', min: 1, max: 16, step: 1, def: 3, unit: 'px' },
      { key: 'color', label: 'Tint', kind: 'color', def: '#ffffff' },
      { key: 'rainbow', label: 'Colour static', kind: 'check', def: false },
      { key: 'roll', label: 'Rolling bar', kind: 'check', def: true },
    ],
    defaults: { opacity: 0.35 },
    make() {
      const off = document.createElement('canvas'), octx = off.getContext('2d');
      let img = null, roll = 0;
      return { draw(ctx, L, dt, t, w, h, sc) {
        const g = Math.max(1, L.grain * sc), W = Math.max(8, Math.ceil(w / g)), H = Math.max(8, Math.ceil(h / g));
        if (off.width !== W || off.height !== H) { off.width = W; off.height = H; img = octx.createImageData(W, H); }
        const d = img.data, c = L.color || '#ffffff';
        const r = parseInt(c.slice(1, 3), 16), gg = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
        for (let i = 0; i < d.length; i += 4) {
          const v = Math.random();
          if (L.rainbow) { d[i] = Math.random() * 255; d[i + 1] = Math.random() * 255; d[i + 2] = Math.random() * 255; } else { d[i] = r * v; d[i + 1] = gg * v; d[i + 2] = b * v; }
          d[i + 3] = 255;
        }
        octx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, 0, 0, w, h);
        if (L.roll) {
          roll = (roll + dt * 0.25) % 1.2;
          const y = (roll - 0.1) * h, grad = ctx.createLinearGradient(0, y - h * 0.08, 0, y + h * 0.08);
          grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(0.5, 'rgba(0,0,0,0.55)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grad; ctx.fillRect(0, y - h * 0.08, w, h * 0.16);
        }
      } };
    },
  },

  code: {
    name: 'Your own code', icon: 'code',
    params: [
      { key: 'code', label: 'Code (JavaScript, runs every frame)', kind: 'code', def: [
        '// ctx: the canvas (2D)   t: seconds   w, h: size   s: kept between frames   dt: seconds since the last frame',
        'const n = 14;',
        'for (let i = 0; i < n; i++) {',
        '  const a = t * 0.7 + i / n * Math.PI * 2;',
        '  const r = Math.min(w, h) * (0.25 + 0.12 * Math.sin(t * 2 + i));',
        '  ctx.fillStyle = `hsl(${(i * 26 + t * 90) % 360} 90% 60%)`;',
        '  ctx.beginPath();',
        '  ctx.arc(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a * 2) * r * 0.6, 10 + 8 * Math.sin(t * 3 + i), 0, Math.PI * 2);',
        '  ctx.fill();',
        '}',
      ].join('\n') },
    ],
    defaults: { trails: 0.9 },
  },
};

export const LAYER_ORDER = ['bounce', 'stars', 'rain', 'plasma', 'lines', 'tunnel', 'words', 'clock', 'fireworks', 'life', 'picture', 'static', 'code'];

// ---------------------------------------------------------------- making screensavers and layers
export function newLayer(type) {
  const T = LAYERS[type];
  const L = { id: uid('l'), type, on: true };
  for (const p of [...COMMON, ...T.params]) L[p.key] = p.def;
  return Object.assign(L, T.defaults || {});
}

export function blankSaver(name = 'New screensaver') {
  const s = { id: uid('s'), name, layers: [] };
  for (const p of SAVER_PARAMS) s[p.key] = p.def;
  return s;
}

/** Anything missing (older saves, hand-edited files) filled in from the defaults. */
export function normalizeSaver(s) {
  const out = { ...blankSaver(), ...s };
  out.layers = (Array.isArray(s?.layers) ? s.layers : []).filter((L) => LAYERS[L?.type]).map((L) => ({ ...newLayer(L.type), ...L }));
  return out;
}

const randomValue = (p) => {
  switch (p.kind) {
    case 'range': { const n = Math.round(rnd(p.min, p.max) / p.step) * p.step; return Number(n.toFixed(4)); }
    case 'select': return pick(p.options)[0];
    case 'check': return Math.random() < 0.5;
    case 'color': return hslHex(rnd(0, 360), rnd(60, 100), rnd(45, 75));
    default: return p.def;
  }
};

/** A layer with its settings rolled at random (within reason: sizes and counts stay watchable). */
export function randomLayer(type) {
  const T = LAYERS[type], L = newLayer(type);
  for (const p of T.params) {
    if (p.kind === 'text') { if (T.texts) L[p.key] = pick(T.texts); continue; }
    if (p.kind === 'image' || p.kind === 'code') continue;
    L[p.key] = randomValue(p);
  }
  if (type === 'bounce') { L.count = Math.random() < 0.6 ? Math.round(rnd(1, 4)) : Math.round(rnd(5, 40)); L.size = Math.round(rnd(30, 160)); }
  if (type === 'stars') L.count = Math.round(rnd(200, 1500));
  if (type === 'life') L.cell = Math.round(rnd(4, 16));
  if (type === 'static') L.opacity = Number(rnd(0.1, 0.4).toFixed(2));
  if (type !== 'static') L.opacity = Number(rnd(0.6, 1).toFixed(2));
  L.blend = Math.random() < 0.5 ? 'normal' : pick(BLENDS)[0];
  L.speed = Number(rnd(0.5, 1.8).toFixed(1));
  L.trails = Math.random() < 0.45 ? Number(rnd(0.5, 0.94).toFixed(2)) : (T.defaults?.trails ?? 0);
  L.hueSpin = Math.random() < 0.25 ? Math.round(rnd(-120, 120) / 5) * 5 : 0;
  L.blur = Math.random() < 0.12 ? Math.round(rnd(1, 6)) : 0;
  L.mirror = Math.random() < 0.25 ? pick(['lr', 'tb', 'quad']) : 'none';
  return L;
}

const WORDS_A = ['Midnight', 'Neon', 'Haunted', 'Sleepy', 'Cosmic', 'Soggy', 'Electric', 'Forbidden', 'Velvet', 'Wobbly', 'Static', 'Lost', 'Melting', 'Tiny', 'Feral'];
const WORDS_B = ['Aquarium', 'Disco', 'Highway', 'Lava Lamp', 'Signal', 'Basement', 'Carnival', 'Dream', 'Arcade', 'Swamp', 'Orbit', 'Toaster', 'Jellyfish', 'Cathedral', 'Goblin'];

/** A whole screensaver thrown together at random: 2 to 4 layers, maybe some of the whole-screen effects. */
export function randomSaver() {
  const s = blankSaver(`${pick(WORDS_A)} ${pick(WORDS_B)}`);
  const pool = LAYER_ORDER.filter((t) => t !== 'code' && t !== 'picture');
  const n = Math.round(rnd(2, 4));
  const first = pick(['plasma', 'stars', 'tunnel', 'life', 'rain', 'lines']);
  s.layers.push(randomLayer(first));
  while (s.layers.length < n) {
    const t = pick(pool.filter((x) => x !== 'plasma' && !s.layers.some((L) => L.type === x)));
    s.layers.push(randomLayer(t));
  }
  if (first === 'plasma') s.layers[0].opacity = Number(rnd(0.4, 0.9).toFixed(2));
  s.bg = hslHex(rnd(0, 360), rnd(30, 80), rnd(2, 12));
  s.gradient = Math.random() < 0.4;
  s.bg2 = hslHex(rnd(0, 360), rnd(50, 90), rnd(8, 25));
  s.bgAngle = Math.round(rnd(0, 359));
  s.bgSpin = s.gradient && Math.random() < 0.4 ? Math.round(rnd(-60, 60) / 5) * 5 : 0;
  s.pixel = Math.random() < 0.2 ? pick([2, 3, 4, 6]) : 1;
  s.hueSpin = Math.random() < 0.2 ? Math.round(rnd(-90, 90) / 5) * 5 : 0;
  s.wobble = Math.random() < 0.2 ? Number(rnd(1, 5).toFixed(1)) : 0;
  s.invert = Math.random() < 0.08;
  s.scanlines = Math.random() < 0.2;
  return s;
}

/** The ones that come with it (read-only in the studio; "Make it yours" copies one). */
const ex = (id, name, patch, layers) => ({ ...normalizeSaver({ ...patch, layers: layers.map(([type, L]) => ({ ...newLayer(type), ...L })) }), id, name, example: true });
export const EXAMPLES = [
  ex('ex-corner', 'Corner hunter', {}, [['bounce', { text: 'BOX', size: 110 }]]),
  ex('ex-warp', 'Warp speed', {}, [['stars', { count: 1200, streaks: true, wander: true, speed: 1.4 }], ['clock', { size: 60, color: '#9fb7ff', glow: 16, opacity: 0.8 }]]),
  ex('ex-rain', 'Code rain', {}, [['rain', {}]]),
  ex('ex-fever', 'Fever dream', { pixel: 3, wobble: 3, hueSpin: 40 }, [
    ['plasma', { palette: 'acid', opacity: 0.7, scale: 1.4 }],
    ['lines', { shapes: 3, echoes: 14, mirror: 'quad', blend: 'screen', width: 3 }],
    ['bounce', { text: '🐸', count: 24, size: 60, spin: 2, party: false }]]),
  ex('ex-tunnel', 'Hypnotunnel', { gradient: true, bg: '#05010d', bg2: '#2a0b4a', bgSpin: 20 }, [
    ['tunnel', { shape: 'heart', rings: 30, twist: 0.9 }], ['words', { text: 'look closer', mode: 'orbit', size: 46, rainbow: false, color: '#ffffff', font: 'serif' }]]),
  ex('ex-life', 'Petri dish', { bg: '#03140f' }, [['life', { cell: 7, rate: 14 }], ['static', { opacity: 0.12, grain: 2, roll: false }]]),
  ex('ex-party', 'Night sky party', { bg: '#02030c', scanlines: true }, [['fireworks', { rate: 2.4 }], ['clock', { format: 'ampm', size: 90, glow: 30, color: '#ffd9a0', drift: true }]]),
  ex('ex-tv', 'No signal', {}, [['static', { opacity: 1, grain: 3 }], ['words', { text: 'NO SIGNAL', mode: 'shake', amount: 12, rainbow: false, color: '#ffffff', font: 'mono', size: 70, outline: true }]]),
  ex('ex-code', 'Your code here', { bg: '#07070c' }, [['code', {}]]),
];

// ---------------------------------------------------------------- the player
// The page inside a code layer's frame. fade() and mirror() above are copied into it.
const FRAME = `<!doctype html><meta charset="utf-8"><style>:root{color-scheme:light}html,body{margin:0;height:100%;overflow:hidden;background:transparent}canvas{display:block;width:100%;height:100%}</style><canvas></canvas><script>
${fade.toString()}
${mirror.toString()}
const c = document.querySelector('canvas'), ctx = c.getContext('2d');
let fn = null, s = {}, L = {}, g = 1, px = 1, t = 0, last = performance.now();
const say = (m) => parent.postMessage(Object.assign({ bdsSaver: true }, m), '*');
addEventListener('message', (e) => {
  const m = e.data || {};
  if (typeof m.code === 'string') {
    try { fn = new Function('ctx', 't', 'w', 'h', 's', 'dt', m.code); s = {}; say({ ok: true }); } catch (err) { fn = null; say({ error: String(err && err.message || err) }); }
  }
  if (m.L) L = m.L;
  if (m.g != null) g = m.g;
  if (m.px) { px = m.px; c.style.imageRendering = px > 1 ? 'pixelated' : 'auto'; }
});
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000) * (L.speed ?? 1) * g;
  last = now; t += dt;
  const k = Math.min(2, devicePixelRatio || 1) / px, w = Math.max(1, Math.round(innerWidth * k)), h = Math.max(1, Math.round(innerHeight * k));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  fade(ctx, w, h, L.trails || 0);
  if (!fn) return;
  try { ctx.save(); fn(ctx, t, w, h, s, dt); ctx.restore(); } catch (err) { fn = null; say({ error: String(err && err.message || err) }); }
  if (L.mirror && L.mirror !== 'none') mirror(ctx, c, w, h, L.mirror);
}
requestAnimationFrame(frame);
say({ hello: true });
<\/script>`;

export class SaverPlayer {
  /** host: an element to fill. onCodeError(layerId, message | null) hears from code layers. */
  constructor(host, saver, { onCodeError } = {}) {
    this.host = host;
    this.onCodeError = onCodeError;
    this.stage = document.createElement('div');
    this.stage.className = 'saver-stage';
    this.lines = document.createElement('div');
    this.lines.className = 'saver-lines';
    host.append(this.stage, this.lines);
    this.items = new Map();
    this.t = 0;
    this.last = null;
    this.onMessage = (e) => {
      if (!e.data?.bdsSaver) return;
      for (const [id, it] of this.items) {
        if (!it.frame || e.source !== it.frame.contentWindow) continue;
        // the frame's page is up (an empty page comes and goes before it): send it everything again
        if (e.data.hello) { it.ready = true; it.sent = null; it.code = undefined; } else this.onCodeError?.(id, e.data.error || null);
      }
    };
    window.addEventListener('message', this.onMessage);
    this.set(saver);
    this.tick = this.tick.bind(this);
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Shows this screensaver (or the same one, changed): layers come, go and re-stack to match. */
  set(saver) {
    this.saver = saver;
    const keep = new Set(saver.layers.map((L) => L.id));
    for (const [id, it] of this.items) if (!keep.has(id) || it.type !== saver.layers.find((L) => L.id === id)?.type) { it.el.remove(); this.items.delete(id); }
    for (const L of saver.layers) {
      let it = this.items.get(L.id);
      if (!it) {
        if (L.type === 'code') {
          const frame = document.createElement('iframe');
          frame.className = 'saver-layer';
          frame.setAttribute('sandbox', 'allow-scripts');
          frame.setAttribute('tabindex', '-1');
          frame.srcdoc = FRAME;
          it = { type: 'code', el: frame, frame, sent: null, ready: false };
        } else {
          const el = document.createElement('canvas');
          el.className = 'saver-layer';
          it = { type: L.type, el, ctx: el.getContext('2d'), impl: LAYERS[L.type].make() };
        }
        this.items.set(L.id, it);
      }
      this.stage.append(it.el); // in order: later layers on top
    }
  }

  tick(now) {
    this.raf = requestAnimationFrame(this.tick);
    const s = this.saver;
    const dt0 = this.last == null ? 0 : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const g = Number(s.speed ?? 1);
    this.t += dt0 * g;
    const t = this.t;
    // the background and the whole-screen effects
    const angle = (Number(s.bgAngle) || 0) + t * (Number(s.bgSpin) || 0);
    this.stage.style.background = s.gradient ? `linear-gradient(${angle}deg, ${s.bg}, ${s.bg2})` : s.bg;
    const filters = [];
    if (s.hueSpin) filters.push(`hue-rotate(${(t * s.hueSpin) % 360}deg)`);
    if (s.invert) filters.push('invert(1)');
    this.stage.style.filter = filters.join(' ');
    const wob = Number(s.wobble) || 0;
    this.stage.style.transform = wob ? `rotate(${Math.sin(t * 0.9) * wob * 0.6}deg) scale(${1.04 + wob * 0.012 + Math.sin(t * 1.3) * wob * 0.008}) skewX(${Math.sin(t * 0.7) * wob * 0.5}deg)` : '';
    this.lines.hidden = !s.scanlines;
    const px = Math.max(1, Number(s.pixel) || 1), k = Math.min(2, window.devicePixelRatio || 1) / px;
    const W = Math.max(1, Math.round(this.host.clientWidth * k)), H = Math.max(1, Math.round(this.host.clientHeight * k));
    for (const L of s.layers) {
      const it = this.items.get(L.id);
      if (!it) continue;
      it.el.hidden = L.on === false;
      if (L.on === false) continue;
      const st = it.el.style;
      st.opacity = String(L.opacity ?? 1);
      st.mixBlendMode = L.blend || 'normal';
      const f = [];
      if (L.hueSpin) f.push(`hue-rotate(${(t * L.hueSpin) % 360}deg)`);
      if (L.blur) f.push(`blur(${L.blur}px)`);
      st.filter = f.join(' ');
      st.imageRendering = px > 1 ? 'pixelated' : 'auto';
      if (it.frame) {
        if (!it.ready) continue;
        const want = JSON.stringify({ code: L.code, L: { speed: L.speed, trails: L.trails, mirror: L.mirror }, g, px });
        if (want !== it.sent) {
          const msg = { L: { speed: L.speed, trails: L.trails, mirror: L.mirror }, g, px };
          if (it.code !== L.code) { msg.code = L.code || ''; it.code = L.code; }
          it.frame.contentWindow?.postMessage(msg, '*');
          it.sent = want;
        }
        continue;
      }
      const c = it.el;
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const dt = dt0 * g * Number(L.speed ?? 1);
      it.lt = (it.lt || 0) + dt;
      fade(it.ctx, W, H, L.trails);
      try {
        it.ctx.save();
        it.impl.draw(it.ctx, L, dt, it.lt, W, H, k);
        it.ctx.restore();
      } catch (e) { console.warn('saver layer', L.type, e); }
      if (L.mirror && L.mirror !== 'none') mirror(it.ctx, c, W, H, L.mirror);
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('message', this.onMessage);
    this.stage.remove();
    this.lines.remove();
    this.items.clear();
  }
}
