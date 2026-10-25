// Prometheus: Hecate A* through the telescope. A Schwarzschild black hole, ray traced: once per view and size, each
// pixel's light is followed back round the hole (bent by its gravity) to where it came from, the accretion disc it
// crossed (as often as twice: the light that went round the back makes the arcs over and under the hole) or the sky
// behind it. Each frame then only shades that, with the disc's gas turning faster the closer in it is.

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- noise

const hash = (x, y, z) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const fade = (t) => t * t * (3 - 2 * t);
function noise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(hash(xi, yi, zi), hash(xi + 1, yi, zi), u), l(hash(xi, yi + 1, zi), hash(xi + 1, yi + 1, zi), u), v),
    l(l(hash(xi, yi, zi + 1), hash(xi + 1, yi, zi + 1), u), l(hash(xi, yi + 1, zi + 1), hash(xi + 1, yi + 1, zi + 1), u), v), w);
}
const fbm = (x, y, z, oct = 3) => { let s = 0, a = 0.5, f = 1; for (let i = 0; i < oct; i++) { s += a * noise(x * f, y * f, z * f); f *= 2.03; a *= 0.5; } return s / (1 - 0.5 ** oct); };

// ---------------------------------------------------------------- colour

/** A black body's colour at temperature T (K), brightest channel 1: from the Planck curve at red, green and blue. */
const planck = (lam, T) => 1 / (lam ** 5 * (Math.exp(1.4388e-2 / (lam * T)) - 1));
const BB = Array.from({ length: 256 }, (_, i) => {
  const T = 1000 * 40 ** (i / 255), c = [planck(610e-9, T), planck(550e-9, T), planck(465e-9, T)], m = Math.max(...c);
  return c.map((x) => x / m);
});
const bb = (T) => BB[Math.max(0, Math.min(255, Math.round((Math.log(T / 1000) / Math.log(40)) * 255)))];
/** A colour ramp through the given stops, x from 0 to 1. */
const ramp = (stops) => (x) => {
  x = Math.max(0, Math.min(1, x)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x)), t = x - i, a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
};
const hexes = (...hs) => hs.map((s) => [1, 3, 5].map((k) => parseInt(s.slice(k, k + 2), 16) / 255));
const INFERNO = ramp(hexes('#000004', '#1f0c48', '#550f6d', '#88226a', '#ba3655', '#e35933', '#f98e09', '#f9cb35', '#fcffa4'));
const AFMHOT = ramp(hexes('#000000', '#5a0d00', '#b33a00', '#f08a1c', '#ffd27a', '#fff8e6'));
const FILM = ramp(hexes('#000000', '#3a1604', '#9c4a12', '#e8923a', '#ffd391', '#fff4dc'));

// ---------------------------------------------------------------- ray tracing

/** Follows every pixel's light back round the hole (units of its mass M: the horizon is at r = 2, light can circle it at
 *  r = 3, and the disc's inner edge is at 6). incl: the camera's angle from the disc's axis; roll: the picture turned;
 *  span: how many M across the picture is. Returns for each pixel up to two disc crossings (radius, angle round the disc,
 *  Doppler and gravity shift g) and, for light that got away, the direction in the sky it came from. */
function trace(W, H, cam) { const L = traceStart(W, H, cam); traceRows(L, Infinity); return L; }
/** Sets up a trace without tracing anything yet: traceRows does that, as many rows at a time as there's time for. */
function traceStart(W, H, { incl, roll = 0, span, rIn = 6, rOut = 20, ...rest }) {
  const n = W * H, si = Math.sin(incl), ci = Math.cos(incl);
  const C = [0, -si, ci], SY = [0, ci, si]; // towards the camera, and the picture's up (the disc's axis, as seen)
  // the galaxy's band: a great circle across the view, tilted bandTilt and shifted bandOff off centre
  const a = rest.bandTilt || 0, o = rest.bandOff || 0, N = [Math.sin(a), Math.cos(a) * SY[1], Math.cos(a) * SY[2]].map((x, j) => x + o * C[j]);
  const nl = Math.hypot(...N);
  return { W, H, hr: new Float32Array(n * 2), ha: new Float32Array(n * 2), hg: new Float32Array(n * 2), cnt: new Uint8Array(n), sky: new Float32Array(n * 3), lost: new Uint8Array(n),
    N: N.map((x) => x / nl), row: 0, cam: { cr: Math.cos(roll), sr: Math.sin(roll), span, m: span / W, rIn, rOut, C, SY } };
}
/** Traces L's next rows until the clock passes `until` (ms) or the picture's done. */
function traceRows(L, until) {
  const { W, H, hr, ha, hg, cnt, sky, lost } = L, { cr, sr, span, m, rIn, rOut, C, SY } = L.cam, h = 0.02;
  const acc = (u) => 3 * u * u - u; // the orbit equation for light: u'' = 3u² − u (u = 1/r)
  for (; L.row < H && performance.now() < until; L.row++) for (let px = 0, py = L.row; px < W; px++) {
    const i = py * W + px, X0 = (px + 0.5 - W / 2) * m, Y0 = (H / 2 - py - 0.5) * m;
    const X = X0 * cr - Y0 * sr, Y = X0 * sr + Y0 * cr, b = Math.max(1e-4, Math.hypot(X, Y));
    const E = [X / b, (Y * SY[1]) / b, (Y * SY[2]) / b]; // the pixel's direction across the picture
    let u = 0, du = 1 / b, phi = 0, prevS = C[2];
    for (let k = 0; k < 2000; k++) {
      // one Runge-Kutta step
      const k1u = du, k1d = acc(u), k2u = du + (h / 2) * k1d, k2d = acc(u + (h / 2) * k1u), k3u = du + (h / 2) * k2d, k3d = acc(u + (h / 2) * k2u), k4u = du + h * k3d, k4d = acc(u + h * k3u);
      const u0 = u, du0 = du;
      u += (h / 6) * (k1u + 2 * k2u + 2 * k3u + k4u);
      du += (h / 6) * (k1d + 2 * k2d + 2 * k3d + k4d);
      phi += h;
      if (u >= 0.5) { lost[i] = 1; break; } // into the horizon
      if (u <= 0) { // away to the sky
        // where it came from, plus the camera's own field of view (about 40° across)
        const pe = phi - h + h * (u0 / (u0 - u)), c = Math.cos(pe), s = Math.sin(pe), f = 0.7 / span;
        const d = [c * C[0] + s * E[0] + f * X, c * C[1] + s * E[1] + f * Y * SY[1], c * C[2] + s * E[2] + f * Y * SY[2]], dl = Math.hypot(...d);
        sky[i * 3] = d[0] / dl; sky[i * 3 + 1] = d[1] / dl; sky[i * 3 + 2] = d[2] / dl;
        break;
      }
      const c = Math.cos(phi), s = Math.sin(phi), S = c * C[2] + s * E[2];
      if ((S > 0) !== (prevS > 0) && cnt[i] < 2) { // through the disc's plane
        const t = prevS / (prevS - S), pX = phi - h + t * h, uX = u0 + t * (u - u0), r = 1 / uX;
        if (r >= rIn && r <= rOut) {
          const cX = Math.cos(pX), sX = Math.sin(pX), dX = du0 + t * (du - du0);
          const P = [cX * C[0] + sX * E[0], cX * C[1] + sX * E[1]].map((x) => x * r);
          const az = Math.atan2(P[1], P[0]);
          // which way the light leaves for the camera, and the gas's speed (seen by someone standing still there)
          const dP = [0, 1].map((j) => -(dX / (uX * uX)) * (cX * C[j] + sX * E[j]) + r * (-sX * C[j] + cX * E[j]));
          const dz = -(dX / (uX * uX)) * (cX * C[2] + sX * E[2]) + r * (-sX * C[2] + cX * E[2]);
          const dl = Math.hypot(dP[0], dP[1], dz), kx = -dP[0] / dl, ky = -dP[1] / dl;
          const beta = Math.min(0.99, 1 / Math.sqrt(r - 2)), gam = 1 / Math.sqrt(1 - beta * beta);
          const cosT = -Math.sin(az) * kx + Math.cos(az) * ky;
          const j = i * 2 + cnt[i];
          hr[j] = r; ha[j] = az; hg[j] = Math.sqrt(1 - 2 / r) / (gam * (1 - beta * cosT));
          cnt[i]++;
        }
      }
      prevS = S;
    }
  }
}

// ---------------------------------------------------------------- shading

/** How brightly the disc shines at radius r (1 at its brightest): a thin disc, dark at its inner edge. */
const RIN = 6;
const flux = (r) => (1 - Math.sqrt(RIN / r)) / r ** 3;
const FMAX = flux(RIN * 1.36);
/** The disc's gas: streaks drawn out round the hole, each radius turning at its own speed. */
function gas(r, az, t, spin) {
  const a = az - spin * t * r ** -1.5, lr = Math.log(r);
  return 0.35 + 0.9 * fbm(Math.cos(a) * 2.2 + 9, Math.sin(a) * 2.2, lr * 9, 4) * (0.6 + 0.6 * noise(Math.cos(a) * 6, Math.sin(a) * 6, lr * 3 + 4));
}
/** The sky behind: faint stars and the galaxy's band, in direction d. */
function skyAt(x, y, z, band, N) {
  const k = 260, cx = Math.floor(x * k), cy = Math.floor(y * k), cz = Math.floor(z * k), q = hash(cx, cy, cz);
  let s = q > 0.9965 ? ((q - 0.9965) / 0.0035) ** 2 * 1.4 : 0;
  const tint = hash(cy, cz, cx);
  let R = s * (0.8 + tint * 0.3), G = s * 0.9, B = s * (1.15 - tint * 0.3);
  if (band) { // the Milky Way-like band: a glow along a great circle, with dust lanes across it
    const d = x * N[0] + y * N[1] + z * N[2], core = Math.exp(-(d * d) / 0.0035), wide = Math.exp(-(d * d) / 0.03);
    const lanes = Math.max(0, 1 - 2.6 * Math.max(0, fbm(x * 14, y * 14 + 5, z * 14, 4) - 0.42)) ** 2 * (Math.abs(d) < 0.02 ? 0.5 + Math.abs(d) * 25 : 1);
    const clumps = 0.4 + 0.9 * fbm(x * 7 + 3, y * 7, z * 7, 4), glow = band * (core * 0.5 + wide * 0.12) * clumps * lanes;
    R += glow * 1.0; G += glow * 0.82; B += glow * (0.6 + 0.5 * (1 - core));
    if (glow > 0.02 && hash(cz, cx, cy) > 0.985) { R += 0.5 * core; G += 0.5 * core; B += 0.5 * core; } // the band's crowded stars
  }
  return [R, G, B];
}

/** Separable box blur of an RGB float buffer, in place, `passes` times (three passes are close to a Gaussian). */
function blur(buf, W, H, rad, passes = 3) {
  const tmp = new Float32Array(buf.length);
  for (let p = 0; p < passes; p++) {
    for (const [a, b, n, m, sa, sb] of [[buf, tmp, W, H, 3, W * 3], [tmp, buf, H, W, W * 3, 3]]) {
      for (let line = 0; line < m; line++) for (let c = 0; c < 3; c++) {
        const base = line * sb + c;
        let sum = 0;
        for (let k = -rad; k <= rad; k++) sum += a[base + Math.max(0, Math.min(n - 1, k)) * sa];
        for (let k = 0; k < n; k++) {
          b[base + k * sa] = sum / (2 * rad + 1);
          sum += a[base + Math.min(n - 1, k + rad + 1) * sa] - a[base + Math.max(0, k - rad) * sa];
        }
      }
    }
  }
}
const bloom = (buf, W, H, amount, rad) => {
  const hi = buf.map((x) => Math.max(0, x - 0.6));
  blur(hi, W, H, rad);
  for (let i = 0; i < buf.length; i++) buf[i] += hi[i] * amount;
};
const tone = (x) => 1 - Math.exp(-x);
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((x) => (x + 0.5) / 16);

// ---------------------------------------------------------------- the views

/** Each view: how the camera sits, how to shade the disc and sky, and what's done to the picture after. */
export const HOLE_VIEWS = {
  gargantua: { name: 'Gargantua', about: 'Almost edge on, a thin white-gold disc with its far side lensed into arcs over and under the hole. The film look: no colour shift.',
    cam: { incl: 1.5, roll: 0.12, span: 46, rOut: 22, bandTilt: 0.9, bandOff: 0.25 }, band: 0.6,
    disc: (r, az, g, t) => { const f = flux(r) / FMAX, c = FILM(0.22 + 0.6 * f ** 0.45); const k = f ** 0.8 * gas(r, az, t, 6) * g * 2.2; return [c[0] * k, c[1] * k, c[2] * k]; },
    post: (buf, W, H) => bloom(buf, W, H, 0.9, Math.round(W / 60)) },
  doppler: { name: 'Doppler', about: 'The physics left in: the side coming towards you is blue-white and blinding, the side going away dim and red.',
    cam: { incl: 1.32, roll: -0.2, span: 50, rOut: 22, bandTilt: -0.6, bandOff: -0.3 }, band: 0.5,
    disc: (r, az, g, t) => { const f = flux(r) / FMAX, c = bb(6500 * f ** 0.25 * g ** 1.6); const k = f * gas(r, az, t, 6) * g ** 3 * 0.7; return [c[0] * k, c[1] * k, c[2] * k]; },
    post: (buf, W, H) => bloom(buf, W, H, 0.8, Math.round(W / 70)) },
  shadow: { name: 'Shadow', about: 'As a planet-sized radio telescope would photograph it: a blurred, glowing ring round the hole\'s shadow, brightest on one side.',
    cam: { incl: 0.45, roll: 1.9, span: 42, rIn: 6, rOut: 11 }, band: 0, gray: AFMHOT,
    disc: (r, az, g, t) => { const k = (0.4 + 0.6 * flux(r) / FMAX) * gas(r, az, t, 2) * g ** 4 * 0.75; return [k, k, k]; },
    post: (buf, W, H) => blur(buf, W, H, Math.round(W / 75)) },
  lens: { name: 'Lens', about: 'A quiet hole with no disc: just its shadow, and the stars and galaxy behind it bent into a ring around it, slowly turning.',
    cam: { incl: 1.2, roll: 0, span: 34, rIn: 1e9, rOut: 0, bandTilt: 0.45 }, band: 2.6, turn: 0.025 },
  jets: { name: 'Quasar', about: 'Feeding hard: a hot disc and two jets of particles thrown out along its axis at nearly the speed of light, knots running up them.',
    cam: { incl: 1.15, roll: 0.25, span: 70, rOut: 24, bandTilt: 1.2, bandOff: 0.35 }, band: 0.4, jets: true,
    disc: (r, az, g, t) => { const f = flux(r) / FMAX, c = bb(5200 * f ** 0.25 * g); const k = f * gas(r, az, t, 6) * g ** 3 * 1.1; return [c[0] * k, c[1] * k, c[2] * k]; },
    post: (buf, W, H) => bloom(buf, W, H, 1, Math.round(W / 60)) },
  thermal: { name: 'Thermal', about: 'False colour from the telescope\'s instruments: brightness on a log scale, with contour lines.',
    cam: { incl: 1.38, roll: 0.1, span: 46, rOut: 22 }, band: 0, gray: INFERNO, contours: 9, log: true,
    disc: (r, az, g, t) => { const k = (flux(r) / FMAX) * gas(r, az, t, 5) * g ** 4; return [k, k, k]; } },
  pixel: { name: 'Pixel', about: 'Like the planets: drawn big-pixelled in a few colours, dithered.', scale: 3, dither: hexes('#000000', '#2a0b05', '#6e1d0b', '#c2461a', '#f08c2e', '#ffd27a', '#fff6dc'),
    cam: { incl: 1.42, roll: 0.15, span: 46, rOut: 22 }, band: 0,
    disc: (r, az, g, t) => { const k = (flux(r) / FMAX) * gas(r, az, t, 6) * g ** 2.5 * 2.2; return [k, k, k]; } },
};

const cache = new Map();

/** Draws Hecate A* into ctx (W × H) in the given view; t: seconds, for the turning gas. */
export function drawHole(ctx, W, H, view, t) {
  const V = HOLE_VIEWS[view] || HOLE_VIEWS.gargantua, sc = V.scale || 1, w = Math.round(W / sc), hh = Math.round(H / sc), key = `${view}:${w}x${hh}`;
  let L = cache.get(key);
  if (!L) {
    L = trace(w, hh, V.cam);
    // the sky behind, worked out once (the Lens view turns it, so does it every frame)
    if (!V.turn) { L.bg = new Float32Array(w * hh * 3); for (let i = 0; i < w * hh; i++) if (!L.lost[i]) L.bg.set(skyAt(L.sky[i * 3], L.sky[i * 3 + 1], L.sky[i * 3 + 2], V.band, L.N), i * 3); }
    cache.set(key, L);
  }
  const n = w * hh, buf = new Float32Array(n * 3);
  const ca = Math.cos(t * (V.turn || 0)), sa = Math.sin(t * (V.turn || 0));
  for (let i = 0; i < n; i++) {
    let R = 0, G = 0, B = 0;
    if (!L.lost[i]) {
      if (L.bg) { R = L.bg[i * 3]; G = L.bg[i * 3 + 1]; B = L.bg[i * 3 + 2]; }
      else { const x = L.sky[i * 3], y = L.sky[i * 3 + 1]; [R, G, B] = skyAt(x * ca - y * sa, x * sa + y * ca, L.sky[i * 3 + 2], V.band, L.N); }
    }
    // disc crossings: the nearer one in front, the far side's lensed light behind it shows through where it's thin
    for (let k = L.cnt[i] - 1; k >= 0; k--) {
      const j = i * 2 + k, c = V.disc(L.hr[j], L.ha[j], L.hg[j], t);
      const a = Math.min(1, (c[0] + c[1] + c[2]) * 1.5);
      R = R * (1 - a) + c[0]; G = G * (1 - a) + c[1]; B = B * (1 - a) + c[2];
    }
    buf[i * 3] = R; buf[i * 3 + 1] = G; buf[i * 3 + 2] = B;
  }
  if (V.jets) jets(buf, w, hh, V.cam, L, t);
  V.post?.(buf, w, hh);
  const img = ctx.createImageData(w, hh), px = img.data;
  for (let i = 0; i < n; i++) {
    let c;
    if (V.gray) {
      let k = (buf[i * 3] + buf[i * 3 + 1] + buf[i * 3 + 2]) / 3;
      k = V.log ? Math.max(0, 1 + Math.log10(k + 1e-4) / 3) : tone(k * 1.6);
      c = V.gray(k);
      if (V.contours && i % w < w - 1 && i + w < n) { // a line wherever a step in brightness falls between this pixel and the next
        const lv = (j) => { const q = (buf[j * 3] + buf[j * 3 + 1] + buf[j * 3 + 2]) / 3; return Math.floor(Math.max(0, 1 + Math.log10(q + 1e-4) / 3) * V.contours); };
        const me = lv(i);
        if (me > 0 && (lv(i + 1) !== me || lv(i + w) !== me)) c = c.map((x) => Math.min(1, x * 0.55 + 0.42));
      }
    } else if (V.dither) {
      const k = tone(((buf[i * 3] + buf[i * 3 + 1] + buf[i * 3 + 2]) / 3) * 1.4), N = V.dither.length - 1;
      const d = BAYER[((Math.floor(i / w) & 3) << 2) | (i % w & 3)];
      c = V.dither[Math.max(0, Math.min(N, Math.floor(k * N + d)))];
    } else c = [tone(buf[i * 3]), tone(buf[i * 3 + 1]), tone(buf[i * 3 + 2])];
    px[i * 4] = c[0] * 255; px[i * 4 + 1] = c[1] * 255; px[i * 4 + 2] = c[2] * 255; px[i * 4 + 3] = 255;
  }
  if (sc === 1) { ctx.putImageData(img, 0, 0); return; }
  const off = (cache.off ||= document.createElement('canvas'));
  off.width = w; off.height = hh;
  off.getContext('2d').putImageData(img, 0, 0);
  ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(off, 0, 0, W, H); ctx.restore();
}

// ---------------------------------------------------------------- on the map

/** On the map Hecate A* is drawn like the planets: big pixels (never under about 4 screen pixels), a few flat colours
 *  with a checkered band between them, hard edges. Seen from straight above, so the shadow sits in the middle of the
 *  disc, with the far side's light bent up into a thin ring at its edge. Traced on a few grids (the bigger ones a bit
 *  each frame, drawing the next smaller till they're done) and the gas redrawn a few times a second; where there's no
 *  disc the map shows through. */
export const MAP_CAM = { incl: 0.06, roll: 0, span: 44, rOut: 22 };
const MAP_SIZES = [24, 32, 48, 64, 96, 128], maps = new Map();
// dark to bright; the darkest level is left see-through
const MAP_COLS = hexes('#000000', '#3a1408', '#6e2a10', '#b0521c', '#e8923a', '#ffd27a', '#fff6dc').map((c) => c.map((x) => Math.round(x * 255)));
function mapAt(n) {
  let M = maps.get(n);
  if (!M) maps.set(n, (M = { L: traceStart(n, n, MAP_CAM), cv: document.createElement('canvas'), at: -1 }));
  if (M.L.row < n) traceRows(M.L, n <= 64 ? Infinity : performance.now() + 6);
  return M.L.row >= n ? M : null;
}
function shadeMap(M, t) {
  const { L } = M, n = L.W, top = MAP_COLS.length - 1;
  M.cv.width = n; M.cv.height = n;
  const g = M.cv.getContext('2d'), img = g.createImageData(n, n), px = img.data;
  for (let i = 0; i < n * n; i++) {
    let q = 0;
    for (let k = L.cnt[i] - 1; k >= 0; k--) {
      // brightest at the inner edge, thinning out to nothing at the outer one
      const j = i * 2 + k, r = L.hr[j], f = flux(r) / FMAX, edge = Math.min(1, Math.max(0, (MAP_CAM.rOut - r) / (MAP_CAM.rOut * 0.4)));
      q = Math.max(q, f ** 0.7 * gas(r, L.ha[j], t, 6) ** 1.4 * L.hg[j] ** 2 * edge * 3.2);
    }
    // a level for the brightness, with a checkered pixel where it falls between two
    const lv = tone(q) * top, base = Math.floor(lv), chk = ((i % n) + Math.floor(i / n)) % 2 ? 0.35 : 0.65;
    const c = L.lost[i] ? 0 : Math.min(top, base + (lv - base > chk ? 1 : 0));
    if (!c && !L.lost[i]) continue; // nothing here: the map shows through
    px.set([...MAP_COLS[c], 255], i * 4); // the shadow's solid black
  }
  g.putImageData(img, 0, 0);
  M.at = t;
}
/** Draws Hecate A* on the map at (x, y), its horizon hr px across (radius); t: seconds. Returns how far out the disc
 *  reaches on screen (px). */
export function drawHoleMap(ctx, x, y, hr, t) {
  const size = (MAP_CAM.span / 2) * hr, want = [...MAP_SIZES].reverse().find((n) => size / n >= 4) || MAP_SIZES[0];
  let M = null;
  for (const n of MAP_SIZES) { if (n > want) break; M = mapAt(n) || M; }
  if (M.at < 0 || t - M.at > 0.15 || t < M.at) shadeMap(M, t);
  const cell = Math.max(1, Math.round(size / M.L.W)), s = cell * M.L.W; // whole screen pixels per cell, like the planets
  ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(M.cv, Math.round(x - s / 2), Math.round(y - s / 2), s, s); ctx.restore();
  return (MAP_CAM.rOut / 2) * hr; // where the disc stops showing
}

/** The quasar's two jets, along the disc's axis: the one leaning towards the camera bright and in front, the far one
 *  fainter and hidden behind the shadow; bright knots run up them. */
function jets(buf, W, H, cam, L, t) {
  const m = cam.span / W, cr = Math.cos(cam.roll), sr = Math.sin(cam.roll), si = Math.sin(cam.incl);
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const X0 = (px + 0.5 - W / 2) * m, Y0 = (H / 2 - py - 0.5) * m;
    const along = X0 * sr + Y0 * cr, across = X0 * cr - Y0 * sr, i = py * W + px, d = Math.abs(along);
    if (d < 3) continue;
    const near = along > 0;
    if (!near && L.lost[i]) continue;
    const width = 0.6 + d * 0.06, core = Math.exp(-((across / width) ** 2)), halo = Math.exp(-((across / (width * 5)) ** 2)) * 0.3;
    const knots = 0.6 + 0.8 * Math.max(0, Math.sin(d * 0.35 - t * 3)) ** 6;
    const k = (core + halo) * knots * Math.exp(-d / 45) * (near ? 2.4 : 0.5) * si * Math.min(1, (d - 3) / 4);
    buf[i * 3] += k * 0.55; buf[i * 3 + 1] += k * 0.7; buf[i * 3 + 2] += k * 1.25;
  }
}
