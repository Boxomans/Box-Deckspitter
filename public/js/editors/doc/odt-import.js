// OpenDocument Text (.odt) → editable HTML.

import { vendor, bytesToBase64 } from '../../core/dom.js';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' };

function toPt(v) {
  if (!v) return null;
  const m = /^(-?[\d.]+)(cm|mm|in|pt|px|pc)?$/.exec(v.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return { cm: n * 28.3465, mm: n * 2.83465, in: n * 72, pt: n, px: n * 0.75, pc: n * 12 }[m[2] || 'pt'];
}

const attr = (el, name) => (el ? el.getAttribute(name) : null);

function readStyles(root, map) {
  if (!root) return;
  for (const s of Array.from(root.getElementsByTagName('style:style'))) {
    const tp = s.getElementsByTagName('style:text-properties')[0];
    const pp = s.getElementsByTagName('style:paragraph-properties')[0];
    const cp = s.getElementsByTagName('style:table-cell-properties')[0];
    const text = {};
    if (tp) {
      const fw = attr(tp, 'fo:font-weight'); if (fw) text.bold = fw === 'bold' || Number(fw) >= 600;
      const fs = attr(tp, 'fo:font-style'); if (fs) text.italic = fs === 'italic' || fs === 'oblique';
      const us = attr(tp, 'style:text-underline-style'); if (us) text.underline = us !== 'none';
      const ls = attr(tp, 'style:text-line-through-style'); if (ls) text.strike = ls !== 'none';
      const c = attr(tp, 'fo:color'); if (c) text.color = c;
      const sz = attr(tp, 'fo:font-size'); if (sz && !sz.endsWith('%')) text.size = toPt(sz);
      const fn = attr(tp, 'style:font-name') || attr(tp, 'fo:font-family'); if (fn) text.font = fn.replace(/'/g, '');
      const bg = attr(tp, 'fo:background-color'); if (bg && bg !== 'transparent') text.bg = bg;
      const pos = attr(tp, 'style:text-position'); if (pos) text.pos = /^super|^\d/.test(pos) && !pos.startsWith('-') && !/^sub/.test(pos) ? 'super' : /^sub|^-/.test(pos) ? 'sub' : null;
      const tt = attr(tp, 'fo:text-transform'); if (tt === 'uppercase') text.upper = true;
    }
    const para = {};
    if (pp) {
      const a = attr(pp, 'fo:text-align'); if (a) para.align = a === 'end' ? 'right' : a === 'start' ? 'left' : a;
      for (const [k, p] of [['fo:margin-left', 'marginLeft'], ['fo:margin-top', 'marginTop'], ['fo:margin-bottom', 'marginBottom'], ['fo:text-indent', 'textIndent']]) {
        const v = toPt(attr(pp, k)); if (v != null) para[p] = v;
      }
      const lh = attr(pp, 'fo:line-height'); if (lh && lh.endsWith('%')) para.lineHeight = parseFloat(lh) / 100 * 1.15;
      if (attr(pp, 'fo:break-before') === 'page') para.breakBefore = true;
      const bg = attr(pp, 'fo:background-color'); if (bg && bg !== 'transparent') para.bg = bg;
    }
    const cell = {};
    if (cp) { const bg = attr(cp, 'fo:background-color'); if (bg && bg !== 'transparent') cell.bg = bg; }
    map[attr(s, 'style:name')] = {
      family: attr(s, 'style:family'), parent: attr(s, 'style:parent-style-name'),
      display: (attr(s, 'style:display-name') || attr(s, 'style:name') || '').toLowerCase(), text, para, cell,
      listStyle: attr(s, 'style:list-style-name'),
    };
  }
}

function readListStyles(root, map) {
  if (!root) return;
  for (const ls of Array.from(root.getElementsByTagName('text:list-style'))) {
    const levels = {};
    for (const lv of Array.from(ls.children)) {
      const level = Number(attr(lv, 'text:level') || 1) - 1;
      if (lv.localName === 'list-level-style-number') {
        const f = attr(lv, 'style:num-format') || '1';
        levels[level] = { ordered: true, type: { 1: 'decimal', a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman' }[f] || 'decimal', start: Number(attr(lv, 'text:start-value') || 1) };
      } else levels[level] = { ordered: false };
    }
    map[attr(ls, 'style:name')] = levels;
  }
}

export async function importOdt(bytes) {
  const JSZip = await vendor.jszip();
  const zip = await JSZip.loadAsync(bytes);
  const parse = async (p) => { const f = zip.file(p); return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null; };
  const content = await parse('content.xml');
  const stylesDoc = await parse('styles.xml');
  if (!content) throw new Error('Not an OpenDocument text file.');
  const styles = {};
  const lists = {};
  readStyles(stylesDoc, styles);
  readStyles(content, styles);
  readListStyles(stylesDoc, lists);
  readListStyles(content, lists);

  const resolve = (name) => {
    const chain = [];
    let s = styles[name];
    const seen = new Set();
    while (s && !seen.has(s)) { seen.add(s); chain.unshift(s); s = styles[s.parent]; }
    return {
      text: Object.assign({}, ...chain.map((c) => c.text)),
      para: Object.assign({}, ...chain.map((c) => c.para)),
      cell: Object.assign({}, ...chain.map((c) => c.cell)),
      names: chain.map((c) => c.display),
      listStyle: chain.map((c) => c.listStyle).filter(Boolean).pop(),
    };
  };

  const images = {};
  for (const path of Object.keys(zip.files)) {
    if (/^Pictures\//.test(path)) {
      const ext = path.split('.').pop().toLowerCase();
      if (MIME[ext]) images[path] = `data:${MIME[ext]};base64,${bytesToBase64(await zip.file(path).async('uint8array'))}`;
    }
  }

  const applyText = (el, t) => {
    const s = el.style;
    if (t.bold) s.fontWeight = 'bold';
    if (t.italic) s.fontStyle = 'italic';
    const deco = [t.underline && 'underline', t.strike && 'line-through'].filter(Boolean);
    if (deco.length) s.textDecorationLine = deco.join(' ');
    if (t.color && t.color !== '#000000') s.color = t.color;
    if (t.size) s.fontSize = t.size + 'pt';
    if (t.font) s.fontFamily = `'${t.font}'`;
    if (t.bg) s.backgroundColor = t.bg;
    if (t.upper) s.textTransform = 'uppercase';
  };

  const inline = (node, out) => {
    for (const n of Array.from(node.childNodes)) {
      if (n.nodeType === 3) { out.append(n.data.replace(/[\n\r]+/g, ' ')); continue; }
      if (n.nodeType !== 1) continue;
      switch (n.nodeName) {
        case 'text:span': {
          const st = resolve(attr(n, 'text:style-name'));
          const el = document.createElement(st.text.pos === 'super' ? 'sup' : st.text.pos === 'sub' ? 'sub' : 'span');
          applyText(el, st.text);
          inline(n, el);
          out.append(el);
          break;
        }
        case 'text:a': {
          const a = document.createElement('a');
          const href = attr(n, 'xlink:href');
          if (href && /^(https?:|mailto:|#)/i.test(href)) a.setAttribute('href', href);
          inline(n, a);
          out.append(a);
          break;
        }
        case 'text:s': out.append(' '.repeat(Number(attr(n, 'text:c') || 1))); break;
        case 'text:tab': out.append('\t'); break;
        case 'text:line-break': out.append(document.createElement('br')); break;
        case 'draw:frame': {
          const im = n.getElementsByTagName('draw:image')[0];
          const href = attr(im, 'xlink:href');
          if (href && images[href]) {
            const img = document.createElement('img');
            img.src = images[href];
            const w = toPt(attr(n, 'svg:width'));
            if (w) img.style.width = Math.round(w * 96 / 72) + 'px';
            out.append(img);
          } else {
            const tb = n.getElementsByTagName('draw:text-box')[0];
            if (tb) for (const p of Array.from(tb.children)) inline(p, out);
          }
          break;
        }
        case 'text:note': case 'text:bookmark': case 'text:bookmark-start': case 'text:bookmark-end': case 'text:soft-page-break': case 'office:annotation': break;
        default: inline(n, out); break;
      }
    }
  };

  const paraEl = (n, tagOverride) => {
    const st = resolve(attr(n, 'text:style-name'));
    let tag = tagOverride || 'p';
    let cls = null;
    if (n.nodeName === 'text:h') tag = 'h' + Math.min(6, Number(attr(n, 'text:outline-level') || 1));
    else if (st.names.includes('title')) cls = 'title';
    else if (st.names.includes('subtitle')) cls = 'subtitle';
    else if (st.names.some((x) => /^heading[ _]?(\d)/.test(x.replace(/_20_/g, ' ')))) { const m = st.names.map((x) => /heading[ _]?(\d)/.exec(x.replace(/_20_/g, ' '))).find(Boolean); tag = 'h' + Math.min(6, Number(m[1])); }
    else if (st.names.some((x) => /quotations?/.test(x))) tag = 'blockquote';
    else if (st.names.some((x) => /preformatted/.test(x))) tag = 'pre';
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    const p = st.para;
    if (p.align && p.align !== 'left') el.style.textAlign = p.align;
    if (p.marginLeft && tag !== 'li') el.style.marginLeft = p.marginLeft.toFixed(1) + 'pt';
    if (p.textIndent) el.style.textIndent = p.textIndent.toFixed(1) + 'pt';
    if (p.lineHeight) el.style.lineHeight = p.lineHeight.toFixed(3);
    if (p.bg) el.style.backgroundColor = p.bg;
    if (!/^h\d$/.test(tag) && !cls) applyText(el, st.text);
    inline(n, el);
    if (!el.textContent && !el.querySelector('img')) el.append(document.createElement('br'));
    return { el, breakBefore: p.breakBefore };
  };

  const listEl = (n, depth, styleName) => {
    const sname = attr(n, 'text:style-name') || styleName;
    const lv = (lists[sname] || {})[depth] || { ordered: false };
    const list = document.createElement(lv.ordered ? 'ol' : 'ul');
    if (lv.ordered && lv.type && lv.type !== ['decimal', 'lower-alpha', 'lower-roman'][depth % 3]) list.style.listStyleType = lv.type;
    if (lv.ordered && lv.start > 1) list.setAttribute('start', String(lv.start));
    for (const item of Array.from(n.children)) {
      if (item.nodeName !== 'text:list-item' && item.nodeName !== 'text:list-header') continue;
      const li = document.createElement('li');
      let first = true;
      for (const c of Array.from(item.children)) {
        if (c.nodeName === 'text:list') li.append(listEl(c, depth + 1, sname));
        else if (c.nodeName === 'text:p' || c.nodeName === 'text:h') {
          if (!first) li.append(document.createElement('br'));
          const tmp = document.createElement('span');
          inline(c, tmp);
          li.append(...tmp.childNodes);
          first = false;
        }
      }
      if (!li.firstChild) li.append(document.createElement('br'));
      list.append(li);
    }
    return list;
  };

  const tableEl = (n) => {
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    table.append(tbody);
    const rows = Array.from(n.getElementsByTagName('table:table-row'));
    for (const r of rows) {
      if (nearestTable(r) !== n) continue; // rows of nested tables are handled by their own table
      const tr = document.createElement('tr');
      for (const c of Array.from(r.children)) {
        if (c.nodeName !== 'table:table-cell') continue;
        const td = document.createElement('td');
        const cs = Number(attr(c, 'table:number-columns-spanned') || 1);
        const rs = Number(attr(c, 'table:number-rows-spanned') || 1);
        if (cs > 1) td.colSpan = cs;
        if (rs > 1) td.rowSpan = rs;
        const st = resolve(attr(c, 'table:style-name'));
        if (st.cell.bg) td.style.backgroundColor = st.cell.bg;
        blocks(c, td);
        if (!td.firstChild) td.innerHTML = '<p><br></p>';
        tr.append(td);
      }
      tbody.append(tr);
    }
    return table;
  };

  function nearestTable(el) {
    let p = el.parentNode;
    while (p && p.nodeName !== 'table:table') p = p.parentNode;
    return p;
  }

  function blocks(container, out) {
    for (const n of Array.from(container.children)) {
      switch (n.nodeName) {
        case 'text:p': case 'text:h': {
          const { el, breakBefore } = paraEl(n);
          if (breakBefore && out.childNodes.length) { const pb = document.createElement('div'); pb.className = 'page-break'; pb.setAttribute('contenteditable', 'false'); out.append(pb); }
          out.append(el);
          break;
        }
        case 'text:list': out.append(listEl(n, 0)); break;
        case 'table:table': out.append(tableEl(n)); break;
        case 'text:section': case 'text:index-body': case 'text:table-of-content': blocks(n, out); break;
        default: break;
      }
    }
  }

  const officeText = content.getElementsByTagName('office:text')[0];
  const container = document.createElement('div');
  if (officeText) blocks(officeText, container);
  if (!container.firstChild) container.innerHTML = '<p><br></p>';

  // page layout
  const page = { size: 'letter', orientation: 'portrait', margins: { top: 1, right: 1, bottom: 1, left: 1 } };
  const pl = stylesDoc?.getElementsByTagName('style:page-layout-properties')[0];
  if (pl) {
    let w = toPt(attr(pl, 'fo:page-width')) / 72;
    let hh = toPt(attr(pl, 'fo:page-height')) / 72;
    if (w && hh) {
      if (w > hh) { page.orientation = 'landscape'; [w, hh] = [hh, w]; }
      const near = (a, b) => Math.abs(a - b) < 0.08;
      page.size = near(w, 8.5) && near(hh, 11) ? 'letter' : near(w, 8.27) && near(hh, 11.69) ? 'a4' : near(w, 8.5) && near(hh, 14) ? 'legal' : 'custom';
      if (page.size === 'custom') { page.w = +w.toFixed(2); page.h = +hh.toFixed(2); }
    }
    for (const k of ['top', 'right', 'bottom', 'left']) {
      const v = toPt(attr(pl, 'fo:margin-' + k));
      if (v != null) page.margins[k] = +(v / 72).toFixed(2);
    }
  }
  return { html: container.innerHTML, page };
}
