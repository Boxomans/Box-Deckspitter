// Prometheus: the planets' looks, as pixel art: a few big shapes in solid colours (water, land, ice, sulfur, ash, dunes)
// on a coarse grid, a stepped shadow on the side away from the star and a one-pixel glow of air on the lit side. Shapes
// come from smooth 3D noise sampled on a sphere, so they wrap without seams; each sprite is drawn once and reused.

const TAU = Math.PI * 2;

/** Seeded 3D value noise, a few soft octaves (big blobs, no grain). */
function noise(seed) {
  const hash = (x, y, z) => {
    let n = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1) ^ Math.imul(seed, 0x85ebca6b);
    n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
    n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
    return ((n ^ (n >>> 15)) >>> 0) / 4294967295;
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  const v = (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
    const c = (dx, dy, dz) => hash(xi + dx, yi + dy, zi + dz);
    return lerp(lerp(lerp(c(0, 0, 0), c(1, 0, 0), xf), lerp(c(0, 1, 0), c(1, 1, 0), xf), yf), lerp(lerp(c(0, 0, 1), c(1, 0, 1), xf), lerp(c(0, 1, 1), c(1, 1, 1), xf), yf), zf);
  };
  return (x, y, z, oct = 3) => {
    let s = 0, a = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { s += a * v(x * f, y * f, z * f); norm += a; a *= 0.45; f *= 2.1; }
    return s / norm;
  };
}

/** Each body's surface: the solid colour at a point on the unit sphere (z is the axis: |z| near 1 at the poles). */
const SURFACES = {
  terra(n, x, y, z) {
    if (n(x * 2.2 + 9, y * 2.2, z * 2.2 + 4, 2) > 0.66) return '#f4f8fb'; // clouds
    const h = n(x * 1.4, y * 1.4, z * 1.4);
    if (Math.abs(z) > 0.86 - (h - 0.5) * 0.25) return '#e8f0f5'; // ice caps
    if (h < 0.55) return '#1f5c99'; // ocean
    if (h < 0.575) return '#2f78b8'; // shallows
    if (h < 0.66) return '#3c9a48'; // green
    return '#8f8a52'; // dry
  },
  dynamis(n, x, y, z) {
    if (n(x * 4 + 20, y * 4, z * 4, 2) > 0.68) return '#76705a'; // crater floors
    if (n(x * 2.2 + 3, y * 2.2, z * 2.2) > 0.6) return '#e2c43c'; // sulfur
    return n(x * 1.5, y * 1.5, z * 1.5) > 0.5 ? '#b3aa82' : '#9c9572';
  },
  sera(n, x, y, z) {
    const h = n(x * 1.6, y * 1.6, z * 1.6);
    if (Math.abs(z) > 0.74 - (h - 0.5) * 0.3) return Math.abs(z) > 0.9 ? '#e6eef3' : '#c4d6e0'; // ice caps
    if (n(x * 5 + 11, y * 5, z * 5, 2) > 0.72) return '#4f7690'; // drifting ice
    return h > 0.52 ? '#24485f' : '#1b3a4f'; // dark, dead water
  },
  cobalt(n, x, y, z) {
    if (n(x * 4 + 8, y * 4, z * 4, 2) > 0.68) return '#3f4c5a'; // craters
    if (n(x * 3 + 2, y * 3, z * 3 + 5, 2) > 0.64) return '#9fb6cc'; // bare ore
    return n(x * 1.5, y * 1.5, z * 1.5) > 0.5 ? '#71879b' : '#5d7184';
  },
  cinder(n, x, y, z) {
    if (n(x * 4 + 5, y * 4, z * 4, 2) > 0.68) return '#2a2b2e'; // craters
    if (n(x * 1.1, y * 1.1, z * 4, 2) > 0.6) return '#8a8d91'; // ash streaks
    return n(x * 1.6, y * 1.6, z * 1.6) > 0.5 ? '#5a5c60' : '#46484c';
  },
  pal(n, x, y, z) {
    if (n(x * 4 + 3, y * 4, z * 4, 2) > 0.66) return '#4f3e33'; // rubble shadows
    if (n(x * 3 + 9, y * 3, z * 3, 2) > 0.64) return '#a8805f'; // rust
    return n(x * 1.5, y * 1.5, z * 1.5) > 0.5 ? '#8c6f5a' : '#765c4a';
  },
  gal(n, x, y, z) {
    if (n(x * 5 + 6, y * 5, z * 5, 2) > 0.68) return '#7d7364'; // pits
    return n(x * 1.6, y * 1.6, z * 1.6) > 0.5 ? '#c8bdab' : '#b2a692';
  },
  onyx(n, x, y, z) {
    if (n(x * 2 + 4, y * 2, z * 2) > 0.62) return '#5a4a2a'; // ethane lakes under the haze
    if (n(x * 7 + 1, y * 7, z * 7, 2) > 0.78) return '#9fb8c8'; // diamond glints
    return n(x * 1.5, y * 1.5, z * 1.5) > 0.5 ? '#34343d' : '#26262d'; // graphite
  },
  yalu(n, x, y, z) {
    const h = n(x * 1.5, y * 1.5, z * 1.5);
    if (n(x * 2.5 + 6, y * 2.5, z * 2.5, 2) > 0.67) return '#c98a8a'; // red-lit cloud
    if (h < 0.5) return '#4b3570'; // violet sea
    if (h < 0.53) return '#6a4d93'; // shallows
    return h > 0.62 ? '#5e4d47' : '#1f1b1f'; // steam highlands, black sand
  },
  vega(n, x, y, z) {
    const b = Math.sin(z * 14 + n(x * 1.4, y * 1.4, z * 3) * 3);
    if (n(x * 3 + 2, y * 3, z * 6, 2) > 0.7) return '#3b3548'; // soot storms
    return b > 0.45 ? '#c7b8e6' : b > -0.2 ? '#a593c9' : '#6f6a80'; // lilac and slate bands
  },
  // always the same face to the star, so it's coloured by where the light falls: molten under it, a desert band at the
  // edge of the light, and the living dark behind with its night sea
  pandora: Object.assign((n, x, y, z, sun) => {
    sun += (n(x * 7 + 3, y * 7, z * 7) - 0.5) * 0.24; // ragged edges so the bands bleed into each other
    if (sun > 0.34) { // the magma face, glowing in its own light
      const h = n(x * 3, y * 3, z * 3);
      return h > 0.64 ? '#ffd27a' : h > 0.5 ? '#f08a2e' : h > 0.42 ? '#c2461a' : '#6e1d0b';
    }
    if (sun > 0.22) return n(x * 8, y * 8 + 7, z * 8) > 0.6 ? '#c2461a' : '#6b4a32'; // cooling crust, still cracked with glow
    if (sun > -0.1) return n(x * 4 + 5, y * 4, z * 4) > 0.55 ? '#c9a46a' : '#a8814c'; // the twilight desert
    if (sun > -0.2) return n(x * 6 + 9, y * 6, z * 6) > 0.5 ? '#6f6a42' : '#3d4a2c'; // scrub where the dark starts to live
    const s = n(x * 1.4 + 11, y * 1.4, z * 1.4);
    if (s < 0.38) return '#143048'; // the night sea
    if (n(x * 9, y * 9 + 2, z * 9) > 0.8) return '#5fe0a8'; // things that glow
    return s > 0.55 ? '#1f4a2c' : '#173a25'; // the living dark
  }, { lit: true }),
  eros(n, x, y, z) {
    if (n(x * 1.3 + 9, y * 1.3, z * 1.3) > 0.64) return '#e0a8a0'; // the heart basin's pale floor
    if (n(x * 5, y * 5 + 3, z * 5, 2) > 0.7) return '#7d4c46'; // craters
    return n(x * 2, y * 2, z * 2) > 0.5 ? '#c98a7f' : '#b37269'; // rosy regolith
  },
  gaia(n, x, y, z) {
    const h = n(x * 1.6, y * 1.6, z * 1.6);
    if (n(x * 2.6 + 5, y * 2.6, z * 2.6, 2) > 0.68) return '#eef4f6'; // cloud
    if (h < 0.47) return '#2f6f9a'; // shallow seas
    if (h < 0.5) return '#4b9bb8'; // shoals
    return h > 0.62 ? '#7fae5a' : '#2f7a3e'; // green uplands, moss forests
  },
  tartarus(n, x, y, z) {
    const c = Math.abs(n(x * 1.2 + 3, y * 1.2, z * 1.2) - 0.5);
    if (c < 0.012) return '#ffb347'; // the glowing floor of the Abyss
    if (c < 0.03) return '#1a0c0a'; // the chasm walls
    if (n(x * 4 + 2, y * 4, z * 4, 2) > 0.69) return '#d8c24a'; // sulfur seeps
    return n(x * 2, y * 2, z * 2) > 0.52 ? '#6a3428' : '#4a221c'; // scorched rock, iron cliffs
  },
  erebus(n, x, y, z) {
    if (n(x * 4 + 13, y * 4, z * 4, 2) > 0.71) return '#9fb0c2'; // fresh ice round the volcanoes
    if (n(x * 2.5, y * 2.5 + 6, z * 2.5) > 0.6) return '#14171d'; // black snow
    return n(x * 1.5, y * 1.5, z * 1.5) > 0.5 ? '#343b48' : '#272c36'; // sooty ice
  },
  nyx(n, x, y, z) {
    if (n(x * 9 + 1, y * 9, z * 9) > 0.8) return '#dfe6ff'; // frost glinting like stars
    if (n(x * 2 + 8, y * 2, z * 2) > 0.62) return '#2c3360'; // dusk ridges
    return n(x * 1.5, y * 1.5, z * 1.5) > 0.5 ? '#1c2140' : '#141830'; // night-black plains
  },
  baja(n, x, y, z) {
    if (n(x * 2 + 7, y * 2, z * 2) > 0.63) return '#f1e7d4'; // salt pans
    if (n(x * 3, y * 3 + 2, z * 3, 2) > 0.66) return '#9a5a2a'; // canyons
    return Math.sin(z * 9 + n(x * 1.2, y * 1.2, z * 1.2) * 5) > 0 ? '#dfa865' : '#c88947'; // dune belts
  },
};

const hex = (col) => [1, 3, 5].map((k) => parseInt(col.slice(k, k + 2), 16));
const cache = new Map();

/** A body's sprite: n × n pixels of disc (plus a pixel all round for the air), seen side on with the poles at top and
 *  bottom, lit from `step` (one of 64 directions). */
function sprite(id, n, step, atm, rim, flat) {
  const key = `${id}:${n}:${step}`;
  if (cache.has(key)) return cache.get(key);
  const S = n + 2, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const surf = SURFACES[id], ctx = cv.getContext('2d'), img = ctx.createImageData(S, S), px = img.data;
  const nz = noise([...id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)), R = n / 2, rgb = {};
  const L = (step / 64) * TAU, lx = Math.cos(L) * 0.97, ly = Math.sin(L) * 0.97, lz = 0.24, glow = hex(rim);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const x = (i - 1 + 0.5 - R) / R, y = (j - 1 + 0.5 - R) / R, d = x * x + y * y, k = (j * S + i) * 4;
    if (d > 1) { // the air: a pixel-wide ring on the lit side
      if (atm && d < (1 + 1.5 / R) ** 2 && x * lx + y * ly > 0.15) { px[k] = glow[0]; px[k + 1] = glow[1]; px[k + 2] = glow[2]; px[k + 3] = 110 + 120 * Math.min(1, atm); }
      continue;
    }
    const z0 = Math.sqrt(1 - d), tz = 0.3, depth = z0 * Math.cos(tz) + y * Math.sin(tz), up = -y * Math.cos(tz) + z0 * Math.sin(tz);
    const sun = x * lx + y * ly + z0 * lz;
    const col = surf ? surf(nz, x, depth, up, sun) : flat, c = (rgb[col] ||= hex(col));
    // day, a checkered band of dusk, then night (a world that's always facing the same way does its own)
    const m = surf?.lit ? 1 : sun > 0.06 ? 1 : sun > -0.06 ? ((i + j) % 2 ? 0.62 : 0.3) : 0.3;
    px[k] = c[0] * m; px[k + 1] = c[1] * m; px[k + 2] = c[2] * m; px[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  cache.set(key, cv);
  return cv;
}

/** Draws a body at (x, y), radius r, lit from the direction `light` (radians, screen space). The grid gets finer as the
 *  body gets bigger on screen, but the pixels never get smaller than about 4 screen pixels, so it stays chunky. */
export function drawBody(ctx, id, x, y, r, light, { atm = 0, rim = '#88aaff', flat = '#888' } = {}) {
  if (r < 3) { ctx.fillStyle = flat; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); return; }
  const n = Math.min(64, Math.max(8, Math.round(r / 2 / 2) * 2)), step = Math.round((light / TAU) * 64) & 63;
  const cv = sprite(id, n, step, atm, rim, flat), px = (r * 2) / n;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cv, Math.round(x - r - px), Math.round(y - r - px), Math.round(cv.width * px), Math.round(cv.width * px));
  ctx.restore();
}
