// GIF: encode (one or many frames, up to 256 colours each, on/off transparency) and decode (every frame, through
// the browser's ImageDecoder). No libraries: a median-cut palette per frame and the standard LZW packer.

// ---------------------------------------------------------------- palette

/**
 * One frame's colours. rgba: Uint8ClampedArray. Pixels under half opacity become the transparent index.
 * Returns { palette: [[r,g,b]...], index: Uint8Array, transparent: index or -1 }.
 */
export function quantize(rgba, w, h, maxColors = 256, dither = false) {
  const n = w * h;
  let hasT = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 128) { hasT = true; break; }
  const limit = Math.max(2, Math.min(hasT ? 255 : 256, maxColors));
  const index = new Uint8Array(n);

  // few enough colours: keep them exactly
  const exact = new Map();
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (rgba[i + 3] < 128) continue;
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    if (!exact.has(key)) { if (exact.size >= limit) { exact.clear(); exact.set(-1, -1); break; } exact.set(key, exact.size); }
  }
  if (!exact.has(-1)) {
    const palette = [...exact.keys()].map((k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255]);
    const t = hasT ? palette.length : -1;
    if (hasT) palette.push([0, 0, 0]);
    if (!palette.length) palette.push([0, 0, 0]);
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      index[p] = rgba[i + 3] < 128 ? t : exact.get((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
    }
    return { palette, index, transparent: t };
  }

  // median cut over a 5-bit-per-channel histogram (averages use the real 8-bit values)
  const count = new Uint32Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (rgba[i + 3] < 128) continue;
    const k = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    count[k]++; sr[k] += rgba[i]; sg[k] += rgba[i + 1]; sb[k] += rgba[i + 2];
  }
  const bins = [];
  for (let k = 0; k < 32768; k++) if (count[k]) bins.push(k);
  const ch = (k, c) => (c === 0 ? k >> 10 : c === 1 ? (k >> 5) & 31 : k & 31);
  const boxInfo = (list) => {
    let total = 0;
    const lo = [31, 31, 31], hi = [0, 0, 0];
    for (const k of list) { total += count[k]; for (let c = 0; c < 3; c++) { const v = ch(k, c); if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; } }
    const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const axis = span[0] >= span[1] && span[0] >= span[2] ? 0 : span[1] >= span[2] ? 1 : 2;
    return { list, total, span: span[axis], axis };
  };
  const boxes = [boxInfo(bins)];
  while (boxes.length < limit) {
    let bi = -1, best = 0;
    for (let i = 0; i < boxes.length; i++) { const s = boxes[i].span > 0 ? boxes[i].span * Math.sqrt(boxes[i].total) : 0; if (s > best) { best = s; bi = i; } }
    if (bi < 0) break;
    const b = boxes[bi];
    const sorted = [...b.list].sort((x, y) => ch(x, b.axis) - ch(y, b.axis));
    let acc = 0, cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) { acc += count[sorted[i]]; if (acc >= b.total / 2) { cut = i + 1; break; } cut = i + 1; }
    boxes.splice(bi, 1, boxInfo(sorted.slice(0, cut)), boxInfo(sorted.slice(cut)));
  }
  const palette = boxes.map((b) => {
    let t = 0, r = 0, g = 0, bl = 0;
    for (const k of b.list) { t += count[k]; r += sr[k]; g += sg[k]; bl += sb[k]; }
    return [Math.round(r / t), Math.round(g / t), Math.round(bl / t)];
  });
  const t = hasT ? palette.length : -1;
  const cache = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let v = cache[k];
    if (v >= 0) return v;
    let bd = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const d = (p[0] - r) * (p[0] - r) * 0.3 + (p[1] - g) * (p[1] - g) * 0.59 + (p[2] - b) * (p[2] - b) * 0.11;
      if (d < bd) { bd = d; v = i; }
    }
    cache[k] = v;
    return v;
  };
  if (dither) {
    const err = new Float32Array(n * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x, i = p * 4;
        if (rgba[i + 3] < 128) { index[p] = t; continue; }
        const r = Math.max(0, Math.min(255, rgba[i] + err[p * 3])), g = Math.max(0, Math.min(255, rgba[i + 1] + err[p * 3 + 1])), b = Math.max(0, Math.min(255, rgba[i + 2] + err[p * 3 + 2]));
        const v = nearest(r | 0, g | 0, b | 0);
        index[p] = v;
        const er = r - palette[v][0], eg = g - palette[v][1], eb = b - palette[v][2];
        const spread = (dx, dy, f) => {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= w || yy >= h) return;
          const q = (yy * w + xx) * 3;
          err[q] += er * f; err[q + 1] += eg * f; err[q + 2] += eb * f;
        };
        spread(1, 0, 7 / 16); spread(-1, 1, 3 / 16); spread(0, 1, 5 / 16); spread(1, 1, 1 / 16);
      }
    }
  } else {
    for (let p = 0; p < n; p++) { const i = p * 4; index[p] = rgba[i + 3] < 128 ? t : nearest(rgba[i], rgba[i + 1], rgba[i + 2]); }
  }
  if (hasT) palette.push([0, 0, 0]);
  return { palette, index, transparent: t };
}

// ---------------------------------------------------------------- LZW

function lzw(index, minCode) {
  const out = [];
  let cur = 0, bits = 0;
  const clear = 1 << minCode, eoi = clear + 1;
  let nBits = minCode + 1, maxcode = (1 << nBits) - 1, next = eoi + 1;
  const table = new Int16Array(4096 * 256).fill(-1);
  const write = (code) => {
    cur |= code << bits;
    bits += nBits;
    while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; }
    if (code === clear) { nBits = minCode + 1; maxcode = (1 << nBits) - 1; next = eoi + 1; table.fill(-1); }
    else if (next > maxcode && nBits < 12) { nBits++; maxcode = (1 << nBits) - 1; }
  };
  write(clear);
  let prefix = index[0];
  for (let i = 1; i < index.length; i++) {
    const k = index[i];
    const key = prefix * 256 + k;
    const v = table[key];
    if (v >= 0) { prefix = v; continue; }
    write(prefix);
    if (next < 4096) table[key] = next++;
    else write(clear);
    prefix = k;
  }
  write(prefix);
  write(eoi);
  if (bits > 0) out.push(cur & 255);
  return out;
}

// ---------------------------------------------------------------- encode

/**
 * frames: [{ data: Uint8ClampedArray (RGBA, width×height), delay: ms }]
 * loop: 0 = forever, 1 = play once, n = play n times. colors: 2–256. dither: Floyd–Steinberg.
 */
export function encodeGif(frames, { width, height, loop = 0, colors = 256, dither = false } = {}) {
  const b = [];
  const u16 = (v) => b.push(v & 255, (v >> 8) & 255);
  const str = (s) => { for (const c of s) b.push(c.charCodeAt(0)); };
  str('GIF89a');
  u16(width); u16(height);
  b.push(0x70, 0, 0); // no global palette (each frame has its own)
  if (frames.length > 1 && loop !== 1) {
    b.push(0x21, 0xff, 0x0b); str('NETSCAPE2.0'); b.push(3, 1); u16(loop === 0 ? 0 : Math.max(1, loop - 1)); b.push(0);
  }
  for (const f of frames) {
    const q = quantize(f.data, width, height, colors, dither);
    let tb = 1;
    while ((1 << tb) < q.palette.length) tb++;
    const minCode = Math.max(2, tb);
    // graphic control: restore to background between frames, so every frame shows on its own
    b.push(0x21, 0xf9, 4, (2 << 2) | (q.transparent >= 0 ? 1 : 0));
    u16(Math.max(0, Math.round((f.delay ?? 100) / 10)));
    b.push(q.transparent >= 0 ? q.transparent : 0, 0);
    b.push(0x2c); u16(0); u16(0); u16(width); u16(height);
    b.push(0x80 | (tb - 1));
    for (let i = 0; i < 1 << tb; i++) { const c = q.palette[i] || [0, 0, 0]; b.push(c[0], c[1], c[2]); }
    b.push(minCode);
    const data = lzw(q.index, minCode);
    for (let i = 0; i < data.length; i += 255) {
      const len = Math.min(255, data.length - i);
      b.push(len);
      for (let j = 0; j < len; j++) b.push(data[i + j]);
    }
    b.push(0);
  }
  b.push(0x3b);
  return new Uint8Array(b);
}

// ---------------------------------------------------------------- decode

/** Every frame, fully drawn: { width, height, loop (0 = forever), frames: [{ canvas, delay }] }. */
export async function decodeGif(bytes) {
  if (typeof ImageDecoder === 'undefined') throw new Error('This app can’t read GIF frames here.');
  const dec = new ImageDecoder({ data: bytes, type: 'image/gif' });
  await dec.tracks.ready;
  const track = dec.tracks.selectedTrack;
  await dec.completed;
  const frames = [];
  for (let i = 0; i < track.frameCount; i++) {
    const { image } = await dec.decode({ frameIndex: i });
    const c = document.createElement('canvas');
    c.width = image.displayWidth; c.height = image.displayHeight;
    c.getContext('2d').drawImage(image, 0, 0);
    frames.push({ canvas: c, delay: Math.max(20, Math.round((image.duration ?? 100_000) / 1000)) });
    image.close();
  }
  const rep = track.repetitionCount;
  dec.close();
  return { width: frames[0]?.canvas.width || 1, height: frames[0]?.canvas.height || 1, loop: rep === Infinity ? 0 : rep + 1, frames };
}
