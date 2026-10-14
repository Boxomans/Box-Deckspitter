// What an image is saved as — shared by the image viewer and Paint: the file type (picked up front, changeable any
// time), what that type can't keep (transparency, colours), quality, GIF options, and the hidden info inside the file
// (camera, dates, GPS location…) with a way to remove it.

import { h, clear, stripExt, blobToDataURL } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { tbSelect, modal, toast, errorToast } from '../core/ui.js';
import { encodeGif } from '../core/gif.js';

export const OUT_FORMATS = [
  { ext: 'png', name: 'PNG image', label: 'PNG', mime: 'image/png' },
  { ext: 'jpg', name: 'JPEG image', label: 'JPG', mime: 'image/jpeg' },
  { ext: 'webp', name: 'WebP image', label: 'WebP', mime: 'image/webp' },
  { ext: 'gif', name: 'GIF image', label: 'GIF', mime: 'image/gif' },
];
const JPEGS = ['jpg', 'jpeg', 'jfif'];
/** The output type a file's own extension maps to (null: not one we write). */
export const outKind = (ext) => (JPEGS.includes(ext) ? 'jpg' : OUT_FORMATS.some((f) => f.ext === ext) ? ext : null);

/** Output options, starting from the user's last choices. */
export function defaultOut(app, ext) {
  const s = app.settings;
  return {
    ext: ext || s.paintExt || 'png',
    quality: s.imageQuality ?? 92, // jpg / webp, 1–100
    bg: s.imageJpegBg || '#ffffff', // what transparent parts become in a JPEG
    colors: s.gifColors || 256,
    dither: s.gifDither ?? true,
    loop: s.gifLoop ?? 0, // 0 = forever, n = play n times
    strip: s.imageStrip ?? false,
  };
}

// ---------------------------------------------------------------- transparency

/** Does the picture have see-through parts, and are any of them half see-through (soft edges, shadows)? */
export function alphaInfo(canvas) {
  const W = canvas.width, H = canvas.height;
  if (!W || !H) return { transparent: false, partial: false };
  // big pictures are checked on a grid of rows, which is plenty to know
  const step = Math.max(1, Math.floor((W * H) / 4_000_000));
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  let transparent = false, partial = false;
  for (let y = 0; y < H; y += step) {
    for (let i = y * W * 4 + 3, end = (y + 1) * W * 4; i < end; i += 4) {
      const a = d[i];
      if (a === 255) continue;
      transparent = true;
      if (a > 0) { partial = true; return { transparent, partial }; }
    }
  }
  return { transparent, partial };
}

/** What saving as this type does to the picture. { warn, text } */
export function formatNote(ext, info = null, frames = 1) {
  const k = outKind(ext) || ext;
  const t = info?.transparent, p = info?.partial;
  const multi = frames > 1 ? ` Only the frame you’re on is saved — the other ${frames - 1} need GIF.` : '';
  if (k === 'jpg') {
    return { warn: !!t || frames > 1, text: (t ? 'JPG has no transparency — the see-through parts will be filled with the background colour. ' : 'JPG can’t be see-through: transparent parts get a solid background. ') + 'Small file, slightly lossy; best for photos.' + multi };
  }
  if (k === 'gif') {
    return { warn: !!p, text: (p ? 'GIF only has fully see-through or fully solid pixels — soft edges and shadows will turn jagged. ' : 'GIF keeps on/off transparency (no soft edges). ') + 'Up to 256 colours, so photos get banding; supports animation.' };
  }
  if (k === 'webp') return { warn: frames > 1, text: 'WebP keeps full transparency. Smaller than PNG; slightly lossy below 100% quality.' + multi };
  return { warn: frames > 1, text: 'PNG keeps full transparency and every colour exactly. Bigger files.' + multi };
}

/** After picking a type: say what it'll cost, if anything. */
export function warnFormat(ext, canvas, frames = 1) {
  const n = formatNote(ext, canvas ? alphaInfo(canvas) : null, frames);
  if (n.warn) toast(n.text, { type: 'warn', timeout: 6000 });
}

// ---------------------------------------------------------------- encode

export async function encodeCanvas(canvas, ext, out) {
  const k = outKind(ext) || 'png';
  if (k === 'gif') {
    const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
    return encodeGif([{ data: d, delay: 0 }], { width: canvas.width, height: canvas.height, colors: out.colors, dither: out.dither });
  }
  let c = canvas;
  if (k === 'jpg') {
    c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    const x = c.getContext('2d');
    x.fillStyle = out.bg || '#ffffff';
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(canvas, 0, 0);
  }
  const mime = OUT_FORMATS.find((f) => f.ext === k).mime;
  const blob = await new Promise((r) => c.toBlob(r, mime, Math.max(0.01, Math.min(1, (out.quality ?? 92) / 100))));
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------- hidden info (metadata)

const latin = (b, a = 0, z = b.length) => { let s = ''; for (let i = a; i < z; i++) s += String.fromCharCode(b[i]); return s; };
const utf8 = (b, a, z) => new TextDecoder().decode(b.subarray(a, z));
const startsWith = (b, at, s) => { for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false; return true; };

const IFD0 = { 0x010e: 'Description', 0x010f: 'Camera make', 0x0110: 'Camera model', 0x0131: 'Software', 0x0132: 'Date changed', 0x013b: 'Artist', 0x8298: 'Copyright' };
const EXIF = { 0x9003: 'Date taken', 0x9004: 'Date digitised', 0xa430: 'Camera owner', 0xa431: 'Camera serial number', 0xa433: 'Lens make', 0xa434: 'Lens model', 0xa435: 'Lens serial number', 0x9286: 'User comment' };
const SENSITIVE = new Set(['Camera owner', 'Camera serial number', 'Lens serial number', 'Artist', 'Date taken', 'Date digitised', 'User comment']);

/** EXIF (TIFF) block → items, GPS and the orientation flag. */
function readTiff(b, base, out) {
  if (b.length < base + 8) return;
  const le = b[base] === 0x49;
  const u16 = (o) => (le ? b[base + o] | (b[base + o + 1] << 8) : (b[base + o] << 8) | b[base + o + 1]);
  const u32 = (o) => (le ? (b[base + o] | (b[base + o + 1] << 8) | (b[base + o + 2] << 16)) + b[base + o + 3] * 2 ** 24 : b[base + o] * 2 ** 24 + ((b[base + o + 1] << 16) | (b[base + o + 2] << 8) | b[base + o + 3]));
  const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const ifd = (off, cb) => {
    if (off <= 0 || base + off + 2 > b.length) return;
    const n = u16(off);
    for (let i = 0; i < n && i < 500; i++) {
      const e = off + 2 + i * 12;
      if (base + e + 12 > b.length) return;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const bytes = (size[type] || 1) * count;
      const at = bytes <= 4 ? e + 8 : u32(e + 8);
      if (base + at + Math.min(bytes, 1 << 20) > b.length) continue;
      const val = () => {
        if (type === 2) return latin(b, base + at, base + at + count).replace(/\0+$/, '').trim();
        if (type === 3) return u16(at);
        if (type === 4) return u32(at);
        if (type === 5) return [...Array(Math.min(count, 4))].map((_, k) => u32(at + k * 8) / (u32(at + k * 8 + 4) || 1));
        if (type === 7) return latin(b, base + at, base + at + Math.min(count, 300)).replace(/^(ASCII|UNICODE)\0*/, '').replace(/\0+/g, '').trim();
        return null;
      };
      cb(tag, val, at);
    }
  };
  let exifOff = 0, gpsOff = 0;
  ifd(u32(4), (tag, val) => {
    if (tag === 0x8769) exifOff = val();
    else if (tag === 0x8825) gpsOff = val();
    else if (tag === 0x0112) out.orientation = val();
    else if (IFD0[tag]) { const v = val(); if (v) out.items.push({ label: IFD0[tag], value: String(v), sensitive: SENSITIVE.has(IFD0[tag]) }); }
  });
  ifd(exifOff, (tag, val) => { if (EXIF[tag]) { const v = val(); if (v) out.items.push({ label: EXIF[tag], value: String(v), sensitive: SENSITIVE.has(EXIF[tag]) }); } });
  const g = {};
  ifd(gpsOff, (tag, val) => { g[tag] = val(); });
  if (Array.isArray(g[2]) && Array.isArray(g[4])) {
    const deg = (a) => a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600;
    const lat = deg(g[2]) * (g[1] === 'S' ? -1 : 1), lon = deg(g[4]) * (g[3] === 'W' ? -1 : 1);
    out.items.unshift({ label: 'GPS location', value: `${lat.toFixed(5)}, ${lon.toFixed(5)} — where the photo was taken`, sensitive: true, gps: true });
  } else if (gpsOff) out.items.unshift({ label: 'GPS data', value: 'present', sensitive: true, gps: true });
  out.kinds.add('EXIF');
}

/**
 * The hidden info in an image file: { items: [{label, value, sensitive}], kinds: Set('EXIF'|'XMP'|'IPTC'|'Comment'|'Text'|'Colour profile'),
 * orientation }. Never throws; unknown files give no items.
 */
export function readMeta(bytes) {
  const out = { items: [], kinds: new Set(), orientation: 1 };
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  try {
    if (b[0] === 0xff && b[1] === 0xd8) readJpeg(b, out);
    else if (startsWith(b, 0, '\x89PNG')) readPng(b, out);
    else if (startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP')) readWebp(b, out);
    else if (startsWith(b, 0, 'GIF8')) readGif(b, out);
  } catch { /* a damaged block just means less to show */ }
  return out;
}

function readJpeg(b, out) {
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    if (m === 0xda || m === 0xd9) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    const s = i + 4, e = i + 2 + len;
    if (m === 0xe1 && startsWith(b, s, 'Exif\0')) readTiff(b, s + 6, out);
    else if (m === 0xe1 && startsWith(b, s, 'http://ns.adobe.com/xap')) xmp(utf8(b, s, e), out);
    else if (m === 0xed) { out.kinds.add('IPTC'); out.items.push({ label: 'IPTC (captions, credits, keywords)', value: 'present', sensitive: true }); }
    else if (m === 0xe2 && startsWith(b, s, 'ICC_PROFILE')) out.kinds.add('Colour profile');
    else if (m === 0xfe) { out.kinds.add('Comment'); out.items.push({ label: 'Comment', value: utf8(b, s, e).slice(0, 200), sensitive: true }); }
    i = e;
  }
}

function readPng(b, out) {
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
    const type = latin(b, i + 4, i + 8), s = i + 8, e = s + len;
    if (type === 'IEND' || e > b.length) break;
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const z = b.indexOf(0, s);
      const key = latin(b, s, z);
      let value = '(compressed)';
      if (type === 'tEXt') value = latin(b, z + 1, e);
      else if (type === 'iTXt' && b[z + 1] === 0) { let q = b.indexOf(0, z + 3); q = b.indexOf(0, q + 1); value = utf8(b, q + 1, e); }
      if (/^XML:com\.adobe\.xmp$/i.test(key)) xmp(value, out);
      else { out.kinds.add('Text'); out.items.push({ label: key || 'Text', value: value.slice(0, 200), sensitive: !/^(Software|Creation Time)$/i.test(key) }); }
    } else if (type === 'eXIf') readTiff(b, s, out);
    else if (type === 'iCCP') out.kinds.add('Colour profile');
    else if (type === 'tIME') { out.kinds.add('Text'); out.items.push({ label: 'Last changed', value: `${(b[s] << 8) | b[s + 1]}-${b[s + 2]}-${b[s + 3]} ${b[s + 4]}:${String(b[s + 5]).padStart(2, '0')}`, sensitive: false }); }
    i = e + 4;
  }
}

function readWebp(b, out) {
  let i = 12;
  while (i + 8 <= b.length) {
    const type = latin(b, i, i + 4), len = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24);
    const s = i + 8;
    if (type === 'EXIF') readTiff(b, startsWith(b, s, 'Exif\0') ? s + 6 : s, out);
    else if (type === 'XMP ') xmp(utf8(b, s, s + len), out);
    else if (type === 'ICCP') out.kinds.add('Colour profile');
    i = s + len + (len & 1);
  }
}

function readGif(b, out) {
  let i = 13;
  if (b[10] & 0x80) i += 3 * (1 << ((b[10] & 7) + 1));
  const skipBlocks = (j) => { while (j < b.length && b[j]) j += b[j] + 1; return j + 1; };
  while (i < b.length) {
    if (b[i] === 0x21) {
      const label = b[i + 1];
      if (label === 0xfe) {
        let j = i + 2, text = '';
        while (j < b.length && b[j]) { text += latin(b, j + 1, j + 1 + b[j]); j += b[j] + 1; }
        out.kinds.add('Comment'); out.items.push({ label: 'Comment', value: text.slice(0, 200), sensitive: true });
        i = j + 1;
      } else if (label === 0xff) {
        const name = latin(b, i + 3, i + 14);
        if (name.startsWith('XMP Data')) { out.kinds.add('XMP'); out.items.push({ label: 'XMP (editing / author info)', value: 'present', sensitive: true }); }
        i = skipBlocks(i + 2 + 1 + b[i + 2]);
      } else i = skipBlocks(i + 2 + 1 + b[i + 2]);
    } else if (b[i] === 0x2c) {
      const f = b[i + 9];
      i += 10 + ((f & 0x80) ? 3 * (1 << ((f & 7) + 1)) : 0) + 1;
      i = skipBlocks(i);
    } else break;
  }
}

function xmp(text, out) {
  out.kinds.add('XMP');
  const pick = (re) => (text.match(re) || [])[1];
  const tool = pick(/xmp:CreatorTool(?:="|>)([^"<]+)/);
  const who = pick(/dc:creator>[\s\S]*?<rdf:li[^>]*>([^<]+)/);
  if (tool) out.items.push({ label: 'Made with', value: tool, sensitive: false });
  if (who) out.items.push({ label: 'Author', value: who, sensitive: true });
  if (/exif:GPSLatitude/.test(text)) out.items.unshift({ label: 'GPS location (XMP)', value: 'present — where the photo was taken', sensitive: true, gps: true });
  if (!tool && !who) out.items.push({ label: 'XMP (editing / author info)', value: 'present', sensitive: true });
}

/**
 * The same file without its hidden info, without re-encoding (no quality lost). Colour profiles are kept (they're
 * about colours, not you). Returns null when it can't be done this way (unknown type, or a rotated photo whose
 * rotation lives in the info) — then a fresh encode does it instead.
 */
export function stripMeta(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const meta = readMeta(b);
  if (meta.orientation && meta.orientation !== 1) return null;
  const parts = [];
  try {
    if (b[0] === 0xff && b[1] === 0xd8) {
      parts.push(b.subarray(0, 2));
      let i = 2;
      while (i + 4 <= b.length && b[i] === 0xff) {
        const m = b[i + 1];
        if (m === 0xda) break;
        const e = i + 2 + ((b[i + 2] << 8) | b[i + 3]);
        const keep = !(m === 0xe1 || m === 0xed || m === 0xfe || (m >= 0xe3 && m <= 0xed && m !== 0xee) || (m === 0xe2 && !startsWith(b, i + 4, 'ICC_PROFILE')));
        if (keep) parts.push(b.subarray(i, e));
        i = e;
      }
      parts.push(b.subarray(i));
    } else if (startsWith(b, 0, '\x89PNG')) {
      parts.push(b.subarray(0, 8));
      let i = 8;
      while (i + 12 <= b.length) {
        const len = ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
        const type = latin(b, i + 4, i + 8), e = i + 12 + len;
        if (!['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME'].includes(type)) parts.push(b.subarray(i, e));
        i = e;
        if (type === 'IEND') break;
      }
    } else if (startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP')) {
      let i = 12;
      const chunks = [];
      while (i + 8 <= b.length) {
        const type = latin(b, i, i + 4), len = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24);
        const e = i + 8 + len + (len & 1);
        if (type !== 'EXIF' && type !== 'XMP ') chunks.push(b.slice(i, e));
        i = e;
      }
      const vp8x = chunks.find((c) => startsWith(c, 0, 'VP8X'));
      if (vp8x) vp8x[8] &= ~(0x08 | 0x04);
      const total = chunks.reduce((n, c) => n + c.length, 4);
      const head = new Uint8Array(12);
      head.set([82, 73, 70, 70, total & 255, (total >> 8) & 255, (total >> 16) & 255, (total >>> 24) & 255, 87, 69, 66, 80]);
      parts.push(head, ...chunks);
    } else if (startsWith(b, 0, 'GIF8')) {
      let i = 13;
      if (b[10] & 0x80) i += 3 * (1 << ((b[10] & 7) + 1));
      parts.push(b.subarray(0, i));
      const blocksEnd = (j) => { while (j < b.length && b[j]) j += b[j] + 1; return j + 1; };
      while (i < b.length) {
        if (b[i] === 0x21) {
          const label = b[i + 1];
          const e = label === 0xfe ? blocksEnd(i + 2) : blocksEnd(i + 3 + b[i + 2]);
          const keep = label === 0xf9 || label === 0x01 || (label === 0xff && latin(b, i + 3, i + 14).startsWith('NETSCAPE'));
          if (keep) parts.push(b.subarray(i, e));
          i = e;
        } else if (b[i] === 0x2c) {
          const f = b[i + 9];
          const e = blocksEnd(i + 10 + ((f & 0x80) ? 3 * (1 << ((f & 7) + 1)) : 0) + 1);
          parts.push(b.subarray(i, e));
          i = e;
        } else { parts.push(b.subarray(i)); break; }
      }
    } else return null;
  } catch { return null; }
  const n = parts.reduce((s, p) => s + p.length, 0);
  const res = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { res.set(p, o); o += p.length; }
  return res;
}

// ---------------------------------------------------------------- toolbar bits

/** The file-type picker for a toolbar. ed: { out, setOutExt(ext) } */
export function formatSelect(ed) {
  const s = tbSelect(OUT_FORMATS.map((f) => ({ value: f.ext, label: f.label })), (v) => ed.setOutExt(v), { tip: 'Save as this file type', value: outKind(ed.out.ext) || 'png' });
  s.classList.add('img-format');
  return s;
}

const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);

/**
 * The Image settings dialog. ed provides:
 *   out, setOutExt(ext, {quiet}), outCanvas() → flattened picture, frameCount(), meta (readMeta result or null),
 *   fresh (true: every save writes a brand-new file, so hidden info is never carried over),
 *   size() → {W, H}, resize(), canvasSize?(), trim?(), toDump(), copyImage(), serialize(ext), app, tab
 */
export async function imageSettings(ed) {
  const app = ed.app;
  const o = ed.out;
  const save = (patch) => app.saveSettings(patch);
  const frames = ed.frameCount?.() || 1;
  const info = alphaInfo(ed.outCanvas());

  const note = h('div', { class: 'imgset-note' });
  const typeSel = h('select', {}, ...OUT_FORMATS.map((f) => h('option', { value: f.ext }, `${f.label} — ${f.name}`)));
  typeSel.value = outKind(o.ext) || 'png';
  const defBox = h('input', { type: 'checkbox' });
  defBox.checked = (app.settings.paintExt || 'png') === typeSel.value;

  const qIn = h('input', { type: 'range', min: '10', max: '100', value: String(o.quality) });
  const qLbl = h('span', { class: 'mono faint' });
  qIn.addEventListener('input', () => { o.quality = Number(qIn.value); qLbl.textContent = `${o.quality}%`; sizeLbl.textContent = ''; });
  qIn.addEventListener('change', () => save({ imageQuality: o.quality }));
  const bgIn = h('input', { type: 'color', value: o.bg });
  bgIn.addEventListener('input', () => { o.bg = bgIn.value; save({ imageJpegBg: o.bg }); });

  const colSel = h('select', {}, ...[256, 128, 64, 32, 16, 8, 4, 2].map((n) => h('option', { value: String(n) }, `${n} colours`)));
  colSel.value = String(o.colors);
  colSel.addEventListener('change', () => { o.colors = Number(colSel.value); save({ gifColors: o.colors }); sizeLbl.textContent = ''; });
  const dith = h('input', { type: 'checkbox' });
  dith.checked = !!o.dither;
  dith.addEventListener('change', () => { o.dither = dith.checked; save({ gifDither: o.dither }); sizeLbl.textContent = ''; });
  const loopSel = h('select', {}, h('option', { value: '0' }, 'Forever'), h('option', { value: '1' }, 'Once'), h('option', { value: 'n' }, 'A number of times…'));
  const loopN = h('input', { type: 'number', min: '2', max: '1000', value: String(o.loop > 1 ? o.loop : 3), style: 'width:70px' });
  loopSel.value = o.loop === 0 ? '0' : o.loop === 1 ? '1' : 'n';
  const syncLoop = () => { loopN.hidden = loopSel.value !== 'n'; o.loop = loopSel.value === 'n' ? Math.max(2, Number(loopN.value) || 3) : Number(loopSel.value); save({ gifLoop: o.loop }); };
  loopSel.addEventListener('change', syncLoop);
  loopN.addEventListener('input', syncLoop);
  loopN.hidden = loopSel.value !== 'n';

  const rowQ = h('div', { class: 'imgset-row' }, h('span', {}, 'Quality'), h('div', { class: 'row' }, qIn, qLbl));
  const rowBg = h('div', { class: 'imgset-row' }, h('span', {}, 'Background'), h('div', { class: 'row' }, bgIn, h('span', { class: 'faint' }, 'fills the see-through parts')));
  const rowGif = h('div', { class: 'imgset-grp' },
    h('div', { class: 'imgset-row' }, h('span', {}, 'Colours'), h('div', { class: 'row' }, colSel, h('label', { class: 'check' }, dith, 'Dither (smoother gradients)'))),
    h('div', { class: 'imgset-row' }, h('span', {}, 'Loop'), h('div', { class: 'row' }, loopSel, loopN, frames > 1 ? null : h('span', { class: 'faint' }, 'for animations'))));

  const sizeLbl = h('span', { class: 'mono faint' });
  const sync = () => {
    const k = typeSel.value;
    const n = formatNote(k, info, frames);
    note.className = `imgset-note ${n.warn ? 'warn' : ''}`;
    clear(note).append(icon(n.warn ? 'alert' : 'info', 'sm'), h('span', {}, n.text));
    rowQ.hidden = !(k === 'jpg' || k === 'webp');
    rowBg.hidden = k !== 'jpg';
    rowGif.hidden = k !== 'gif';
    qLbl.textContent = `${o.quality}%`;
    defBox.checked = (app.settings.paintExt || 'png') === k;
    sizeLbl.textContent = '';
  };
  typeSel.addEventListener('change', () => { ed.setOutExt(typeSel.value, { quiet: true }); sync(); });
  defBox.addEventListener('change', () => save({ paintExt: defBox.checked ? typeSel.value : 'png' }));

  const sizeBtn = h('button', { class: 'btn sm', onclick: async () => {
    sizeLbl.textContent = 'working…';
    try { const b = await ed.serialize(typeSel.value); sizeLbl.textContent = `≈ ${fmtBytes(b.length)}`; } catch (e) { sizeLbl.textContent = ''; errorToast(e); }
  } }, 'How big will it be?');

  // hidden info
  const meta = ed.meta;
  const items = meta?.items || [];
  const hasGps = items.some((x) => x.gps);
  const strip = h('input', { type: 'checkbox' });
  strip.checked = !!o.strip;
  strip.addEventListener('change', () => { o.strip = strip.checked; save({ imageStrip: o.strip }); if (o.strip && !ed.fresh) ed.markDirty?.(); });
  const metaList = items.length
    ? h('div', { class: 'imgset-meta' }, ...items.slice(0, 14).map((x) => h('div', { class: `imgset-metarow ${x.sensitive ? 'sens' : ''}` }, h('span', {}, x.label), h('span', { class: 'mono', title: x.value }, x.value))),
      items.length > 14 ? h('div', { class: 'faint' }, `…and ${items.length - 14} more`) : null)
    : h('div', { class: 'faint' }, meta ? 'Nothing found — this file has no camera, date, location or author info.' : 'New picture — no hidden info.');
  const kinds = meta ? [...meta.kinds].filter((k) => k !== 'Colour profile') : [];
  const metaNote = ed.fresh
    ? h('div', { class: 'faint imgset-small' }, items.length ? 'Paint saves a brand-new file, so none of this is carried over — it’s already removed when you save.' : 'Paint saves a brand-new file — nothing hidden is ever carried over.')
    : h('label', { class: 'check' }, strip, 'Remove hidden info when saving', h('span', { class: 'faint' }, ' — camera, dates, GPS location, author, comments'));

  const { W, H } = ed.size();
  const dims = h('span', { class: 'mono' }, `${W} × ${H}px${frames > 1 ? ` · ${frames} frames` : ''}`);
  const close = (ctx) => ctx.close(null);
  let mctx = null;
  const body = h('div', { class: 'imgset' },
    h('div', { class: 'imgset-sec' }, h('div', { class: 'menu-heading' }, 'File type'),
      h('div', { class: 'imgset-row' }, h('span', {}, 'Save as'), h('div', { class: 'row' }, typeSel)),
      note,
      rowQ, rowBg, rowGif,
      h('div', { class: 'row imgset-small' }, h('label', { class: 'check' }, defBox, 'Use this type for new images'), h('div', { class: 'grow' }), sizeBtn, sizeLbl)),
    h('div', { class: 'imgset-sec' }, h('div', { class: 'menu-heading' }, 'Hidden info', hasGps ? h('span', { class: 'imgset-gps' }, icon('pin', 'sm'), 'has location') : null,
      kinds.length ? h('span', { class: 'faint imgset-kinds' }, kinds.join(' · ')) : null),
      metaList, metaNote),
    h('div', { class: 'imgset-sec' }, h('div', { class: 'menu-heading' }, 'Size'),
      h('div', { class: 'row', style: 'flex-wrap:wrap' }, dims, h('div', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: () => { close(mctx); ed.resize(); } }, icon('resize', 'sm'), 'Resize…'),
        ed.canvasSize ? h('button', { class: 'btn sm', onclick: () => { close(mctx); ed.canvasSize(); } }, 'Canvas size…') : null,
        ed.trim ? h('button', { class: 'btn sm', 'data-tip': 'Cut off see-through (or same-colour) borders', onclick: () => { close(mctx); ed.trim(); } }, icon('crop', 'sm'), 'Trim edges') : null)),
    h('div', { class: 'imgset-sec' }, h('div', { class: 'menu-heading' }, 'Share'),
      h('div', { class: 'row', style: 'flex-wrap:wrap' },
        h('button', { class: 'btn sm', onclick: () => ed.copyImage() }, icon('copy', 'sm'), 'Copy picture'),
        h('button', { class: 'btn sm', onclick: () => ed.toDump() }, icon('image-down', 'sm'), 'Send to media dump'),
        h('button', { class: 'btn sm', onclick: () => { close(mctx); app.saveAs(ed.tab); } }, icon('save', 'sm'), 'Save as…'))));
  sync();
  await modal({ title: 'Image settings', body, wide: true, onOpen: (c) => { mctx = c; }, buttons: [{ label: 'Done', value: null, primary: true }] });
}

/** Copy a canvas as a PNG picture. */
export async function copyCanvas(canvas) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  try {
    if (window.bdsShell?.copyImage) await window.bdsShell.copyImage(await blobToDataURL(blob));
    else await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Copied', { timeout: 1000 });
  } catch (e) { errorToast(e, 'Copy failed'); }
}

/** "photo.png" → "photo.gif" for untitled tabs whose title carries an extension. */
export function retitle(title, ext) { return /\.[a-z0-9]{2,5}$/i.test(title) ? `${stripExt(title)}.${ext}` : title; }
