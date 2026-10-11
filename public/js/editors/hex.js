// Binary mode — a fast, virtualized read-only hex viewer for anything we can't edit.

import { BaseEditor } from './base.js';
import { h, clear, formatBytes, clamp } from '../core/dom.js';
import { tbButton, tbSep, promptDialog, FindBar } from '../core/ui.js';

const ROW_H = 20;
const PER_ROW = 16;

const MAGIC = [
  [[0x50, 0x4b, 0x03, 0x04], 'ZIP archive (or Office/OpenDocument file)'],
  [[0xd0, 0xcf, 0x11, 0xe0], 'Legacy Microsoft Office (OLE) — e.g. .doc / .xls / .ppt'],
  [[0x25, 0x50, 0x44, 0x46], 'PDF document'],
  [[0x89, 0x50, 0x4e, 0x47], 'PNG image'],
  [[0xff, 0xd8, 0xff], 'JPEG image'],
  [[0x47, 0x49, 0x46, 0x38], 'GIF image'],
  [[0x4d, 0x5a], 'Windows executable (EXE/DLL)'],
  [[0x7f, 0x45, 0x4c, 0x46], 'ELF executable'],
  [[0x1f, 0x8b], 'GZIP archive'],
  [[0x52, 0x61, 0x72, 0x21], 'RAR archive'],
  [[0x37, 0x7a, 0xbc, 0xaf], '7-Zip archive'],
  [[0x49, 0x44, 0x33], 'MP3 audio'],
  [[0x66, 0x4c, 0x61, 0x43], 'FLAC audio'],
  [[0x4f, 0x67, 0x67, 0x53], 'OGG media'],
  [[0x1a, 0x45, 0xdf, 0xa3], 'Matroska / WebM video'],
  [[0x53, 0x51, 0x4c, 0x69], 'SQLite database'],
  [[0x00, 0x00, 0x01, 0x00], 'Windows icon'],
  [[0x42, 0x4d], 'BMP image'],
  [[0x52, 0x49, 0x46, 0x46], 'RIFF container (WAV / AVI / WEBP)'],
];

function sniff(bytes) {
  for (const [sig, label] of MAGIC) if (sig.every((b, i) => bytes[i] === b)) return label;
  if (bytes.length > 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'MP4 / MOV / HEIC media';
  return 'Unknown binary data';
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

export class HexEditor extends BaseEditor {
  static mode = 'hex';

  async load(bytes) {
    this.bytes = bytes || new Uint8Array();
    this.rows = Math.ceil(this.bytes.length / PER_ROW) || 1;
    this.highlight = null;
    this.kind = sniff(this.bytes);
    this.spacer = h('div', { class: 'hex-spacer', style: { height: this.rows * ROW_H + 'px' } });
    this.view = h('div', { class: 'hex-view' });
    this.scroller = h('div', { class: 'hex-scroller' }, this.spacer, this.view);
    this.info = h('div', { class: 'hex-info' },
      h('span', { class: 'mono' }, this.kind), h('span', { class: 'faint mono' }, `${formatBytes(this.bytes.length)} · ${this.bytes.length.toLocaleString()} bytes`),
      h('div', { class: 'grow' }),
      this.tab.path ? h('button', { class: 'btn sm', onclick: () => this.app.reopenAs(this.tab, 'text') }, 'Open as text anyway') : null);
    this.root = h('div', { class: 'hex-root' }, this.info, this.scroller);
    this.pane.append(this.root);
    this.scroller.addEventListener('scroll', () => this.render());
    new ResizeObserver(() => this.render()).observe(this.scroller);
    this.render();
  }

  render() {
    const top = this.scroller.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW_H) - 5);
    const count = Math.ceil(this.scroller.clientHeight / ROW_H) + 10;
    const last = Math.min(this.rows, first + count);
    let html = '';
    const b = this.bytes;
    const [ha, hb] = this.highlight || [-1, -1];
    for (let r = first; r < last; r++) {
      const off = r * PER_ROW;
      let hx = '';
      let asc = '';
      for (let i = 0; i < PER_ROW; i++) {
        const idx = off + i;
        if (idx < b.length) {
          const v = b[idx];
          const on = idx >= ha && idx < hb ? ' class="on"' : '';
          hx += `<span${on}>${hex2(v)}</span>` + (i === 7 ? '  ' : ' ');
          const ch = v >= 32 && v < 127 ? String.fromCharCode(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) : '·';
          asc += `<span${on}>${ch}</span>`;
        } else { hx += '   ' + (i === 7 ? ' ' : ''); }
      }
      html += `<div class="hex-row"><span class="hex-off">${off.toString(16).padStart(8, '0')}</span><span class="hex-bytes">${hx}</span><span class="hex-ascii">${asc}</span></div>`;
    }
    this.view.style.transform = `translateY(${first * ROW_H}px)`;
    this.view.innerHTML = html;
  }

  buildToolbar() {
    return h('div', { class: 'toolbar' },
      tbButton('search', 'Find bytes or text', () => this.find(), { key: 'Ctrl+F' }),
      tbButton('arrow-down', 'Go to offset', () => this.goto(), { text: 'Go to offset' }),
      tbSep(),
      h('span', { class: 'tb-label' }, 'read-only binary view'));
  }

  async goto() {
    const v = await promptDialog('Go to offset', 'Offset (decimal, or hex like 0x1F40)', '');
    if (!v) return;
    const n = v.trim().toLowerCase().startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10);
    if (isNaN(n)) return;
    this.scrollTo(clamp(n, 0, this.bytes.length), 1);
  }

  scrollTo(offset, len) {
    this.highlight = [offset, offset + len];
    this.scroller.scrollTop = Math.max(0, Math.floor(offset / PER_ROW) * ROW_H - this.scroller.clientHeight / 3);
    this.render();
  }

  find() {
    if (!this.findBar) {
      const self = this;
      let hits = [];
      let idx = -1;
      let len = 0;
      this.findBar = new FindBar(this.root, {
        canReplace: false,
        find(q) {
          let needle;
          const hexish = /^([0-9a-f]{2}\s*)+$/i.test(q.trim()) && q.trim().length >= 2;
          needle = hexish ? Uint8Array.from(q.replace(/\s+/g, '').match(/../g).map((x) => parseInt(x, 16))) : new TextEncoder().encode(q);
          len = needle.length;
          hits = [];
          const b = self.bytes;
          outer: for (let i = 0; i <= b.length - len && hits.length < 10000; i++) {
            for (let j = 0; j < len; j++) if (b[i + j] !== needle[j]) continue outer;
            hits.push(i);
          }
          idx = hits.length ? 0 : -1;
          if (idx >= 0) self.scrollTo(hits[0], len);
          return { count: hits.length, index: idx };
        },
        next() { if (!hits.length) return { count: 0, index: -1 }; idx = (idx + 1) % hits.length; self.scrollTo(hits[idx], len); return { count: hits.length, index: idx }; },
        prev() { if (!hits.length) return { count: 0, index: -1 }; idx = (idx - 1 + hits.length) % hits.length; self.scrollTo(hits[idx], len); return { count: hits.length, index: idx }; },
        clear() { self.highlight = null; self.render(); },
      });
    }
    this.findBar.open(false);
  }

  status() {
    return { left: [{ text: this.kind }], right: [{ text: `${this.bytes.length.toLocaleString()} bytes` }] };
  }

  saveFormats() { return []; }
}
