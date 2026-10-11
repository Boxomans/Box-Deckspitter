// Rich Text Format import (→ HTML) and export (live DOM → RTF).

import { rgbToHex, dataURLToBytes } from '../../core/dom.js';

const CP1252 = { 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ' };
const SKIP_DEST = new Set(['stylesheet', 'info', 'header', 'footer', 'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'fldinst', 'object', 'footnote', 'pgdsctbl', 'mmathPr', 'pnseclvl', 'bkmkstart', 'bkmkend', 'filetbl', 'revtbl', 'userprops', 'docvar', 'pn', 'pntxta', 'pntxtb', 'template', 'nonshppict', 'shppict_skip', 'atnid', 'annotation', 'xe', 'tc', 'objdata', 'fchars', 'lchars', 'wgrffmtfilter', 'shp', 'shpinst', 'sp']);
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function importRtf(rtf) {
  if (!/^\s*{\\rtf/.test(rtf)) throw new Error('Not an RTF document.');
  const fonts = {};
  const colors = [];
  let curColor = null;
  let fontId = null;
  let fontName = '';
  let deff = 0;
  const stack = [];
  let st = { b: false, i: false, ul: false, strike: false, fs: 24, fsSet: false, f: null, cf: 0, hl: 0, va: null, caps: false, uc: 1, skip: false, dest: null };
  let para = { align: null, intbl: false, li: 0, fi: 0 };
  let pict = null;
  let skipChars = 0;
  const blocks = [];
  let cur = '';
  let runText = '';
  let runState = null;
  let cellParas = [];
  let rowCells = [];
  let rows = [];

  const sameRun = (a, b) => a && b && a.b === b.b && a.i === b.i && a.ul === b.ul && a.strike === b.strike && a.fs === b.fs && a.f === b.f && a.cf === b.cf && a.hl === b.hl && a.va === b.va && a.caps === b.caps;
  const wrapRun = (text, s) => {
    const css = [];
    if (s.b) css.push('font-weight:bold');
    if (s.i) css.push('font-style:italic');
    const deco = [s.ul && 'underline', s.strike && 'line-through'].filter(Boolean);
    if (deco.length) css.push('text-decoration-line:' + deco.join(' '));
    if (s.fsSet && s.fs) css.push(`font-size:${s.fs / 2}pt`);
    if (s.f != null && s.f !== deff && fonts[s.f]) css.push(`font-family:'${fonts[s.f]}'`);
    if (s.cf && colors[s.cf]) css.push('color:' + colors[s.cf]);
    if (s.hl && colors[s.hl]) css.push('background-color:' + colors[s.hl]);
    if (s.caps) css.push('text-transform:uppercase');
    let html = esc(text).replace(/\n/g, '<br>');
    if (css.length) html = `<span style="${css.join(';')}">${html}</span>`;
    if (s.va === 'super') html = `<sup>${html}</sup>`;
    if (s.va === 'sub') html = `<sub>${html}</sub>`;
    return html;
  };
  const flushRun = () => { if (runText) { cur += wrapRun(runText, runState); runText = ''; } };
  const addText = (t) => {
    if (st.skip) return;
    if (st.dest === 'fonttbl') { fontName += t; return; }
    if (st.dest === 'colortbl') { if (t.includes(';')) { colors.push(curColor); curColor = null; } return; }
    if (st.dest === 'pict') { if (pict) pict.hex += t.replace(/[^0-9a-fA-F]/g, ''); return; }
    if (skipChars > 0) { const k = Math.min(skipChars, t.length); skipChars -= k; t = t.slice(k); if (!t) return; }
    if (!sameRun(runState, st)) { flushRun(); runState = { ...st }; }
    runText += t;
  };
  const addHtml = (html) => { if (st.skip || st.dest) return; flushRun(); cur += html; };
  const paraHtml = () => {
    flushRun();
    const css = [];
    if (para.align) css.push('text-align:' + para.align);
    if (para.li && !para.intbl) css.push(`margin-left:${para.li / 20}pt`);
    if (para.fi) css.push(`text-indent:${para.fi / 20}pt`);
    const html = `<p${css.length ? ` style="${css.join(';')}"` : ''}>${cur || '<br>'}</p>`;
    cur = '';
    return html;
  };
  const flushTable = () => {
    if (!rows.length) return;
    blocks.push('<table><tbody>' + rows.map((r) => '<tr>' + r.map((c) => `<td>${c || '<br>'}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
    rows = [];
  };
  const endPara = () => {
    const html = paraHtml();
    if (para.intbl) cellParas.push(html);
    else { flushTable(); blocks.push(html); }
  };

  const word = (w, p) => {
    const on = p == null || p !== 0;
    switch (w) {
      case 'fonttbl': st.dest = 'fonttbl'; return;
      case 'colortbl': st.dest = 'colortbl'; curColor = null; return;
      case 'red': curColor = '#' + [p, 0, 0].map((x) => x.toString(16).padStart(2, '0')).join(''); return;
      case 'green': if (curColor) curColor = curColor.slice(0, 3) + p.toString(16).padStart(2, '0') + curColor.slice(5); return;
      case 'blue': if (curColor) curColor = curColor.slice(0, 5) + p.toString(16).padStart(2, '0'); return;
      case 'deff': deff = p; return;
      case 'f':
        if (st.dest === 'fonttbl') { fontId = p; fontName = ''; } else st.f = p;
        return;
      case 'pict': st.dest = 'pict'; st.skip = false; pict = { type: null, hex: '', w: null, h: null, sx: 100 }; return;
      case 'pngblip': if (pict) pict.type = 'png'; return;
      case 'jpegblip': if (pict) pict.type = 'jpeg'; return;
      case 'picwgoal': if (pict) pict.w = p; return;
      case 'pichgoal': if (pict) pict.h = p; return;
      case 'picscalex': if (pict) pict.sx = p; return;
      case 'fldrslt': st.skip = false; return;
      case 'par': endPara(); return;
      case 'line': addHtml('<br>'); return;
      case 'tab': addText('\t'); return;
      case 'page': endPara(); flushTable(); blocks.push('<div class="page-break" contenteditable="false"></div>'); return;
      case 'sect': endPara(); return;
      case 'pard': para = { align: null, intbl: false, li: 0, fi: 0 }; return;
      case 'plain': Object.assign(st, { b: false, i: false, ul: false, strike: false, fs: 24, fsSet: false, f: null, cf: 0, hl: 0, va: null, caps: false }); return;
      case 'b': st.b = on; return;
      case 'i': st.i = on; return;
      case 'ul': case 'uld': case 'uldash': case 'uldb': case 'ulth': case 'ulw': case 'ulwave': st.ul = on; return;
      case 'ulnone': st.ul = false; return;
      case 'strike': case 'striked': st.strike = on; return;
      case 'caps': st.caps = on; return;
      case 'fs': st.fs = p; st.fsSet = true; return;
      case 'cf': st.cf = p; return;
      case 'highlight': case 'cb': case 'chcbpat': st.hl = p; return;
      case 'super': st.va = 'super'; return;
      case 'sub': st.va = 'sub'; return;
      case 'nosupersub': st.va = null; return;
      case 'qc': para.align = 'center'; return;
      case 'qr': para.align = 'right'; return;
      case 'qj': para.align = 'justify'; return;
      case 'ql': para.align = null; return;
      case 'li': para.li = p || 0; return;
      case 'fi': para.fi = p || 0; return;
      case 'intbl': para.intbl = true; return;
      case 'cell': case 'nestcell': { if (cur || runText) endPara(); rowCells.push(cellParas.join('').replace(/^<p>(.*)<\/p>$/s, '$1')); cellParas = []; return; }
      case 'row': case 'nestrow': rows.push(rowCells); rowCells = []; return;
      case 'u': {
        const code = p < 0 ? p + 65536 : p;
        addText(String.fromCharCode(code));
        skipChars = st.uc;
        return;
      }
      case 'uc': st.uc = p; return;
      case 'bullet': addText('•'); return;
      case 'emdash': addText('—'); return;
      case 'endash': addText('–'); return;
      case 'lquote': addText('‘'); return;
      case 'rquote': addText('’'); return;
      case 'ldblquote': addText('“'); return;
      case 'rdblquote': addText('”'); return;
      case 'emspace': case 'enspace': case 'qmspace': addText(' '); return;
      default:
        if (SKIP_DEST.has(w)) st.skip = true;
    }
  };

  let i = 0;
  const n = rtf.length;
  while (i < n) {
    const c = rtf[i];
    if (c === '{') { stack.push({ ...st }); i++; continue; }
    if (c === '}') {
      if (st.dest === 'fonttbl' && fontId != null && fontName) { fonts[fontId] = fontName.replace(/;.*$/s, '').trim(); fontName = ''; fontId = null; }
      if (st.dest === 'pict' && pict && (!stack.length || stack[stack.length - 1].dest !== 'pict')) {
        if (pict.type && pict.hex.length > 16) {
          const bytes = new Uint8Array(pict.hex.length / 2);
          for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(pict.hex.substr(k * 2, 2), 16);
          let s = '';
          for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
          const w = pict.w ? Math.round((pict.w / 1440) * 96 * (pict.sx / 100)) : null;
          flushRun();
          cur += `<img src="data:image/${pict.type};base64,${btoa(s)}"${w ? ` style="width:${w}px"` : ''}>`;
        }
        pict = null;
      }
      st = stack.pop() || st;
      i++;
      continue;
    }
    if (c === '\\') {
      const nx = rtf[i + 1];
      if (nx === '\\' || nx === '{' || nx === '}') { addText(nx); i += 2; continue; }
      if (nx === "'") {
        const code = parseInt(rtf.substr(i + 2, 2), 16);
        if (skipChars > 0) skipChars--;
        else addText(code >= 0x80 && code < 0xa0 ? CP1252[code] || '' : String.fromCharCode(code));
        i += 4;
        continue;
      }
      if (nx === '*') { st.skip = true; i += 2; continue; }
      if (nx === '~') { addText('\u00a0'); i += 2; continue; }
      if (nx === '-') { i += 2; continue; }
      if (nx === '_') { addText('\u2011'); i += 2; continue; }
      if (nx === '\n' || nx === '\r') { endPara(); i += 2; continue; }
      const m = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(rtf.slice(i + 1, i + 48));
      if (!m) { i++; continue; }
      i += 1 + m[0].length;
      word(m[1], m[2] != null ? parseInt(m[2], 10) : null);
      continue;
    }
    if (c === '\r' || c === '\n') { i++; continue; }
    let j = i;
    while (j < n && rtf[j] !== '\\' && rtf[j] !== '{' && rtf[j] !== '}' && rtf[j] !== '\r' && rtf[j] !== '\n') j++;
    addText(rtf.slice(i, j));
    i = j;
  }
  if (cur || runText) endPara();
  flushTable();
  return blocks.join('') || '<p><br></p>';
}

// ---------------------------------------------------------------------------

export async function exportRtf(body, defaults) {
  const fonts = [defaults.font || 'Calibri'];
  const colors = [];
  const fIdx = (name) => { let k = fonts.indexOf(name); if (k < 0) { fonts.push(name); k = fonts.length - 1; } return k; };
  const cIdx = (hex) => { let k = colors.indexOf(hex); if (k < 0) { colors.push(hex); k = colors.length - 1; } return k + 1; };
  const rtfText = (s) => {
    let o = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (ch === '\\' || ch === '{' || ch === '}') o += '\\' + ch;
      else if (ch === '\t') o += '\\tab ';
      else if (ch === '\n') o += '\\line ';
      else if (ch === '\u200b') continue;
      else if (c > 127) {
        if (c > 0xffff) { const s2 = String.fromCodePoint(c); for (let k = 0; k < s2.length; k++) { const u = s2.charCodeAt(k); o += `\\u${u > 32767 ? u - 65536 : u}?`; } }
        else o += `\\u${c > 32767 ? c - 65536 : c}?`;
      } else o += ch;
    }
    return o;
  };
  const baseSize = defaults.size || 11;

  const runCodes = (el, block) => {
    const cs = getComputedStyle(el);
    let s = '\\plain';
    if (Number(cs.fontWeight) >= 600) s += '\\b';
    if (cs.fontStyle !== 'normal') s += '\\i';
    let ul = false, strike = false, bg = null, va = null;
    for (let e = el; e && e !== block?.parentElement && e !== body; e = e.parentElement) {
      const c2 = getComputedStyle(e);
      if ((c2.textDecorationLine || '').includes('underline')) ul = true;
      if ((c2.textDecorationLine || '').includes('line-through')) strike = true;
      if (!bg) bg = rgbToHex(c2.backgroundColor);
      if (e.tagName === 'SUP') va = 'super';
      if (e.tagName === 'SUB') va = 'sub';
      if (e === block) break;
    }
    if (ul) s += '\\ul';
    if (strike) s += '\\strike';
    if (va) s += '\\' + va;
    s += `\\fs${Math.round(parseFloat(cs.fontSize) * 0.75 * 2)}`;
    s += `\\f${fIdx(cs.fontFamily.split(',')[0].replace(/["']/g, '').trim())}`;
    const col = rgbToHex(cs.color);
    if (col && col !== '#1d1b22' && col !== '#000000') s += `\\cf${cIdx(col)}`;
    if (bg) s += `\\highlight${cIdx(bg)}`;
    return s + ' ';
  };

  const imgRtf = async (img) => {
    let bytes = null;
    let type = 'png';
    const src = img.getAttribute('src') || '';
    const d = src.startsWith('data:') ? dataURLToBytes(src) : null;
    if (d && /png|jpe?g/.test(d.mime)) { bytes = d.bytes; type = /png/.test(d.mime) ? 'png' : 'jpeg'; }
    else {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 1; c.height = img.naturalHeight || 1;
        c.getContext('2d').drawImage(img, 0, 0);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        bytes = new Uint8Array(await blob.arrayBuffer());
      } catch { return ''; }
    }
    let hex = '';
    for (let k = 0; k < bytes.length; k++) { hex += bytes[k].toString(16).padStart(2, '0'); if (k % 64 === 63) hex += '\n'; }
    const wTw = Math.round((img.offsetWidth || img.naturalWidth) * 15);
    const hTw = Math.round((img.offsetHeight || img.naturalHeight) * 15);
    return `{\\pict\\${type}blip\\picw${img.naturalWidth}\\pich${img.naturalHeight}\\picwgoal${wTw}\\pichgoal${hTw}\n${hex}}`;
  };

  const inline = async (nodes, block) => {
    let o = '';
    for (const n of nodes) {
      if (n.nodeType === 3) { if (n.data) o += `{${runCodes(n.parentElement, block)}${rtfText(n.data)}}`; continue; }
      if (n.nodeType !== 1) continue;
      if (n.tagName === 'BR') { if (n.nextSibling) o += '\\line '; continue; }
      if (n.tagName === 'IMG') { o += await imgRtf(n); continue; }
      if (n.tagName === 'A' && n.getAttribute('href')) {
        o += `{\\field{\\*\\fldinst HYPERLINK "${n.getAttribute('href').replace(/"/g, '')}"}{\\fldrslt ${await inline([...n.childNodes], block)}}}`;
        continue;
      }
      o += await inline([...n.childNodes], block);
    }
    return o;
  };

  const paraCodes = (el, extra = '') => {
    const cs = getComputedStyle(el);
    let s = '\\pard\\plain';
    const a = cs.textAlign;
    s += a === 'center' ? '\\qc' : a === 'right' || a === 'end' ? '\\qr' : a === 'justify' ? '\\qj' : '\\ql';
    s += `\\sb${Math.round(parseFloat(cs.marginTop) * 15) || 0}\\sa${Math.round(parseFloat(cs.marginBottom) * 15) || 0}`;
    const ml = Math.round(parseFloat(cs.marginLeft) * 15) || 0;
    if (ml) s += `\\li${ml}`;
    return s + extra + ' ';
  };

  const blocksRtf = async (container, ctx = {}) => {
    let o = '';
    for (const el of container.children) {
      const t = el.tagName;
      if (el.classList.contains('page-break')) { o += '\\page\n'; continue; }
      if (t === 'UL' || t === 'OL') {
        let k = Number(el.getAttribute('start') || 1);
        for (const li of el.children) {
          const nested = [...li.children].filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
          const marker = el.classList.contains('checklist') ? (li.dataset.checked === 'true' ? '☑' : '☐') : t === 'OL' ? `${k++}.` : '•';
          const indent = 720 * ((ctx.level || 0) + 1);
          o += paraCodes(li, `\\fi-360\\li${indent}`) + `{\\plain ${rtfText(marker)}\\tab}` + await inline([...li.childNodes].filter((c) => !nested.includes(c)), li) + '\\par\n';
          for (const n2 of nested) o += await blocksRtf({ children: [n2] }, { level: (ctx.level || 0) + 1 });
        }
        continue;
      }
      if (t === 'TABLE') {
        for (const tr of el.rows) {
          o += '\\trowd\\trgaph108\\trleft0';
          let x = 0;
          for (const td of tr.cells) {
            x += Math.round(td.offsetWidth * 15);
            const bg = rgbToHex(getComputedStyle(td).backgroundColor);
            o += (el.classList.contains('plain') ? '' : '\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10') + (bg ? `\\clcbpat${cIdx(bg)}` : '') + `\\cellx${x}`;
          }
          o += '\n';
          for (const td of tr.cells) {
            const inner = [...td.children].some((c) => /^(P|H\d|DIV|UL|OL)$/.test(c.tagName))
              ? (await Promise.all([...td.children].map(async (c) => paraCodes(c, '\\intbl') + await inline([...c.childNodes], c)))).join('\\par ')
              : '\\pard\\intbl ' + await inline([...td.childNodes], td);
            o += inner + '\\cell\n';
          }
          o += '\\row\n';
        }
        o += '\\pard\\par\n';
        continue;
      }
      if (t === 'HR') { o += '\\pard\\brdrb\\brdrs\\brdrw10\\brsp20 \\par\n'; continue; }
      if ((t === 'DIV' || t === 'BLOCKQUOTE') && [...el.children].some((c) => /^(P|H\d|DIV|UL|OL|TABLE|PRE|BLOCKQUOTE)$/.test(c.tagName))) { o += await blocksRtf(el, ctx); continue; }
      o += paraCodes(el, t === 'BLOCKQUOTE' ? '\\li360' : '') + await inline([...el.childNodes], el) + '\\par\n';
    }
    return o;
  };

  const content = await blocksRtf(body);
  const fonttbl = '{\\fonttbl' + fonts.map((f, k) => `{\\f${k}\\fnil ${f};}`).join('') + '}';
  const colortbl = '{\\colortbl;' + colors.map((c) => `\\red${parseInt(c.slice(1, 3), 16)}\\green${parseInt(c.slice(3, 5), 16)}\\blue${parseInt(c.slice(5, 7), 16)};`).join('') + '}';
  return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1${fonttbl}${colortbl}{\\*\\generator Box-DocSpitter;}\\viewkind4\\fs${Math.round(baseSize * 2)}\n${content}}`;
}
