// DOM + general helpers shared by the shell and all editors.

// Optional UI bits are often written as `cond ? el : null`. The DOM's append/prepend/before/after would turn
// that null into the text "null", so skip empty values everywhere (nothing appends "null" on purpose).
for (const proto of [Element.prototype, DocumentFragment.prototype, Document.prototype]) {
  for (const m of ['append', 'prepend', 'before', 'after', 'replaceChildren']) {
    const orig = proto[m];
    if (typeof orig !== 'function' || orig.__bdsSafe) continue;
    const safe = function (...nodes) { return orig.apply(this, nodes.filter((n) => n !== null && n !== undefined && n !== false)); };
    safe.__bdsSafe = true;
    proto[m] = safe;
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' && 'value' in el) el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  appendAll(el, children);
  return el;
}

export function appendAll(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const uid = (p = '') => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

export function throttle(fn, ms) {
  let last = 0, t;
  return (...a) => {
    const now = Date.now();
    clearTimeout(t);
    if (now - last >= ms) { last = now; fn(...a); }
    else t = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (now - last));
  };
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- paths

export function basename(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || ''); }
export function dirname(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (i < 0) return '';
  const d = s.slice(0, i);
  return /^[A-Za-z]:$/.test(d) ? d + '\\' : d || '/';
}
export function extOf(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}
export function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}
export function joinPath(dir, name) {
  if (!dir) return name;
  const sep = dir.includes('\\') || /^[A-Za-z]:/.test(dir) ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

// ---------------------------------------------------------------- formatting

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}

export function timeAgo(t) {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.round(s / 86400) + 'd ago';
  return new Date(t).toLocaleDateString();
}

export function formatDate(t) {
  return new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------- script loading

const loaded = new Map();
let amdHidden = 0;
let savedAmd = null;

/**
 * Load a classic (UMD) script so it attaches to window even when Monaco's AMD loader is present.
 * Only `define.amd` is hidden (UMD wrappers check it), so Monaco can keep loading its own modules meanwhile.
 */
export function loadScript(src) {
  if (loaded.has(src)) return loaded.get(src);
  const p = new Promise((resolve, reject) => {
    if (amdHidden++ === 0 && typeof window.define === 'function' && window.define.amd) {
      savedAmd = window.define.amd;
      window.define.amd = undefined;
    }
    const restore = () => {
      if (--amdHidden === 0 && savedAmd && typeof window.define === 'function') { window.define.amd = savedAmd; savedAmd = null; }
    };
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { restore(); resolve(); };
    s.onerror = () => { restore(); loaded.delete(src); reject(new Error('Failed to load ' + src)); };
    document.head.append(s);
  });
  loaded.set(src, p);
  return p;
}

export function loadCSS(href) {
  if (loaded.has(href)) return loaded.get(href);
  const p = new Promise((resolve, reject) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = resolve;
    l.onerror = reject;
    document.head.append(l);
  });
  loaded.set(href, p);
  return p;
}

export const vendor = {
  async pdfLib() { await loadScript('/vendor/pdf-lib/dist/pdf-lib.min.js'); return window.PDFLib; },
  async fontkit() { await loadScript('/vendor/@pdf-lib/fontkit/dist/fontkit.umd.min.js'); return window.fontkit; },
  async jszip() { await loadScript('/vendor/jszip/dist/jszip.min.js'); return window.JSZip; },
  async docx() { await loadScript('/vendor/docx/dist/index.iife.js'); return window.docx; },
  async xlsx() { await loadScript('/vendor/xlsx/dist/xlsx.full.min.js'); return window.XLSX; },
  async marked() { await loadScript('/vendor/marked/marked.min.js'); return window.marked; },
  async pdfjs() {
    const lib = await import('/vendor/pdfjs-dist/build/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-dist/build/pdf.worker.min.mjs';
    return lib;
  },
};

// ---------------------------------------------------------------- bytes / text

export function bytesToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export function bytesToDataURL(bytes, mime) { return `data:${mime};base64,${bytesToBase64(bytes)}`; }
export function dataURLToBytes(url) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  return { mime: m[1] || 'application/octet-stream', bytes: m[2] ? base64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3])) };
}
export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
export async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof data === 'string') return new TextEncoder().encode(data);
  throw new Error('Unsupported data type');
}

const CP1252 = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
  0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
const CP1252_REV = Object.fromEntries(Object.entries(CP1252).map(([b, u]) => [u, Number(b)]));

/** Decode bytes into text, detecting BOM / UTF-8 validity. */
export function decodeText(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', bom: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', bom: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', bom: true };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', bom: false };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252', bom: false };
  }
}

export function encodeText(text, encoding = 'utf-8', bom = false) {
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const le = encoding === 'utf-16le';
    const out = new Uint8Array(text.length * 2 + (bom ? 2 : 0));
    let o = 0;
    if (bom) { out[o++] = le ? 0xff : 0xfe; out[o++] = le ? 0xfe : 0xff; }
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (le) { out[o++] = c & 0xff; out[o++] = c >> 8; } else { out[o++] = c >> 8; out[o++] = c & 0xff; }
    }
    return out;
  }
  if (encoding === 'windows-1252' || encoding === 'latin1') {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[i] = c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : CP1252_REV[c] ?? 0x3f;
    }
    return out;
  }
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

export function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** True if the bytes look like text (no NULs, mostly printable). */
export function looksLikeText(bytes) {
  const n = Math.min(bytes.length, 8192);
  if (n === 0) return true;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return false;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) bad++;
  }
  return bad / n < 0.02;
}

export function countWords(text) {
  const m = String(text).match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

export function rgbToHex(rgb) {
  if (!rgb) return null;
  if (rgb.startsWith('#')) return rgb.length === 4 ? '#' + [...rgb.slice(1)].map((c) => c + c).join('') : rgb.slice(0, 7);
  const m = rgb.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) === 0) return null;
  return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
}

export function isMac() { return /Mac/.test(navigator.platform); }

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
