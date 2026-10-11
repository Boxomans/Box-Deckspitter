// HTML cleanup (paste / import), whitespace normalization and HTML → Markdown.

const ALLOWED = new Set([
  'P', 'DIV', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'INS', 'SUB', 'SUP', 'A', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH',
  'CAPTION', 'COLGROUP', 'COL', 'IMG', 'HR', 'FONT', 'MARK', 'SMALL', 'BIG', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD',
  'ABBR', 'CITE', 'Q', 'KBD', 'SAMP', 'VAR', 'TIME', 'ADDRESS', 'CENTER', 'INPUT', 'TT',
]);
const UNWRAP_BLOCK = new Set(['SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'BODY', 'HTML', 'FORM', 'FIELDSET', 'DETAILS', 'SUMMARY', 'LABEL']);
const DROP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'HEAD', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'TEMPLATE', 'BUTTON', 'SELECT', 'TEXTAREA', 'MAP', 'AREA', 'BASE', 'PARAM', 'SOURCE', 'TRACK', 'DIALOG']);
const STYLE_PROPS = [
  'color', 'background-color', 'font-weight', 'font-style', 'text-decoration-line', 'font-size', 'font-family', 'text-align',
  'margin-left', 'text-indent', 'line-height', 'vertical-align', 'text-transform', 'font-variant-caps', 'list-style-type',
];
const IMG_PROPS = ['width', 'height', 'float'];
const CELL_PROPS = ['width', 'vertical-align', 'background-color'];
const KNOWN_CLASSES = new Set(['title', 'subtitle', 'checklist', 'page-break', 'toc', 'plain', 'textbox', 'float-left', 'float-right', 'center']);

export const BLOCK_RE = /^(P|DIV|H[1-6]|UL|OL|LI|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|BLOCKQUOTE|PRE|HR|FIGURE|FIGCAPTION|DL|DT|DD|ADDRESS|CAPTION|COLGROUP|COL|CENTER)$/;

function safeUrl(u, img) {
  const s = String(u || '').trim();
  if (/^(https?:|mailto:|tel:|#)/i.test(s)) return s;
  if (img && /^data:image\//i.test(s)) return s;
  if (img && /^blob:/i.test(s)) return s;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) return s; // relative
  return null;
}

function copyStyle(src, dst, props) {
  for (const p of props) {
    let v = src.style.getPropertyValue(p);
    if (!v) continue;
    if (/^(inherit|initial|unset|windowtext|transparent)$/i.test(v)) continue;
    if (p === 'font-family') v = v.replace(/"/g, "'");
    if (p === 'background-color' && /^rgba\(.+,\s*0\)$/.test(v)) continue;
    dst.style.setProperty(p, v);
  }
  // shorthand fallbacks
  const deco = src.style.getPropertyValue('text-decoration');
  if (deco && !dst.style.textDecorationLine && /underline|line-through/.test(deco)) dst.style.textDecorationLine = deco.match(/underline|line-through/g).join(' ');
  const bg = src.style.getPropertyValue('background');
  if (bg && !dst.style.backgroundColor && /^(#|rgb)/.test(bg.trim())) dst.style.backgroundColor = bg.trim().split(/\s+(?![^(]*\))/)[0];
}

function convertFont(src, el) {
  const color = src.getAttribute('color');
  const face = src.getAttribute('face');
  const size = src.getAttribute('size');
  if (color) el.style.color = color;
  if (face) el.style.fontFamily = face;
  if (size) {
    const map = { 1: '8pt', 2: '10pt', 3: '12pt', 4: '14pt', 5: '18pt', 6: '24pt', 7: '36pt' };
    if (map[size]) el.style.fontSize = map[size];
  }
}

function cleanInto(src, out, doc) {
  for (const child of Array.from(src.childNodes)) {
    if (child.nodeType === 3) { out.append(doc.createTextNode(child.data)); continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toUpperCase();
    if (DROP.has(tag)) continue;
    if (tag.includes(':')) { if (tag !== 'O:P') cleanInto(child, out, doc); continue; }
    if (UNWRAP_BLOCK.has(tag)) {
      const div = doc.createElement('div');
      cleanInto(child, div, doc);
      out.append(...div.childNodes);
      continue;
    }
    if (!ALLOWED.has(tag)) { cleanInto(child, out, doc); continue; }
    if (tag === 'INPUT') {
      if ((child.getAttribute('type') || '').toLowerCase() === 'checkbox') {
        const li = src.closest ? src.closest('li') : null;
        out.dataset.bdsCheck = child.hasAttribute('checked') ? 'true' : 'false';
        if (li) { /* handled by post-pass */ }
      }
      continue;
    }
    let el;
    if (tag === 'FONT') { el = doc.createElement('span'); convertFont(child, el); }
    else if (tag === 'CENTER') { el = doc.createElement('div'); el.style.textAlign = 'center'; }
    else if (tag === 'TT') el = doc.createElement('code');
    else if (tag === 'BIG') { el = doc.createElement('span'); el.style.fontSize = '1.2em'; }
    else el = doc.createElement(tag);

    copyStyle(child, el, STYLE_PROPS);
    const align = child.getAttribute('align');
    if (align && !el.style.textAlign && /^(left|right|center|justify)$/i.test(align) && tag !== 'IMG') el.style.textAlign = align.toLowerCase();

    if (tag === 'A') {
      const href = safeUrl(child.getAttribute('href'));
      if (href) el.setAttribute('href', href);
      if (child.getAttribute('title')) el.setAttribute('title', child.getAttribute('title'));
    } else if (tag === 'IMG') {
      const s = safeUrl(child.getAttribute('src'), true);
      if (!s) continue;
      el.setAttribute('src', s);
      if (child.getAttribute('alt')) el.setAttribute('alt', child.getAttribute('alt'));
      copyStyle(child, el, IMG_PROPS);
      const w = child.getAttribute('width');
      const hgt = child.getAttribute('height');
      if (w && !el.style.width) el.style.width = /^\d+$/.test(w) ? w + 'px' : w;
      if (hgt && w && !el.style.height) { /* keep aspect via auto height */ }
      if (/^(left|right)$/i.test(child.getAttribute('align') || '')) el.classList.add('float-' + child.getAttribute('align').toLowerCase());
    } else if (tag === 'TD' || tag === 'TH') {
      for (const a of ['colspan', 'rowspan']) if (child.getAttribute(a)) el.setAttribute(a, child.getAttribute(a));
      copyStyle(child, el, CELL_PROPS);
      if (child.getAttribute('bgcolor')) el.style.backgroundColor = child.getAttribute('bgcolor');
    } else if (tag === 'COL') {
      if (child.getAttribute('span')) el.setAttribute('span', child.getAttribute('span'));
      copyStyle(child, el, ['width']);
    } else if (tag === 'OL') {
      if (child.getAttribute('start')) el.setAttribute('start', child.getAttribute('start'));
      const t = child.getAttribute('type');
      if (t && !el.style.listStyleType) el.style.listStyleType = { a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman', 1: 'decimal' }[t] || '';
    } else if (tag === 'LI' && child.dataset.checked) {
      el.dataset.checked = child.dataset.checked;
    } else if (tag === 'TABLE') {
      if (child.getAttribute('border') === '0' && !child.classList.contains('plain')) { /* leave bordered by default */ }
    }
    for (const c of child.classList) if (KNOWN_CLASSES.has(c)) el.classList.add(c);
    if (el.classList.contains('page-break')) { el.setAttribute('contenteditable', 'false'); out.append(el); continue; }
    cleanInto(child, el, doc);
    if (el.dataset.bdsCheck && tag === 'LI') { el.dataset.checked = el.dataset.bdsCheck; delete el.dataset.bdsCheck; el.parentElement; }
    out.append(el);
  }
}

/** Collapse source-formatting whitespace (we edit with white-space: pre-wrap). */
export function normalizeWhitespace(root) {
  const isBlock = (n) => n && n.nodeType === 1 && BLOCK_RE.test(n.tagName);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const t of texts) {
    if (t.parentElement?.closest('pre')) continue;
    const s = t.data.replace(/[ \t\n\r\f]+/g, ' ');
    if (s === ' ' || s === '') {
      const p = t.parentNode;
      if (!t.previousSibling || !t.nextSibling || isBlock(t.previousSibling) || isBlock(t.nextSibling) || /^(UL|OL|TABLE|TBODY|THEAD|TFOOT|TR|COLGROUP)$/.test(p.nodeName)) {
        t.remove();
        continue;
      }
    }
    t.data = s;
  }
  // trim leading/trailing spaces at block edges
  for (const b of [root, ...root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,div,dt,dd,figcaption,caption')]) {
    const first = firstText(b);
    if (first && !first.parentElement?.closest('pre')) first.data = first.data.replace(/^ +/, '');
    const last = lastText(b);
    if (last && !last.parentElement?.closest('pre')) last.data = last.data.replace(/ +$/, '');
  }
}

function firstText(el) {
  for (let n = el.firstChild; n; n = n.firstChild || n.nextSibling) {
    if (n.nodeType === 3) return n.data.length ? n : null;
    if (n.nodeType === 1 && (BLOCK_RE.test(n.tagName) || n.tagName === 'BR' || n.tagName === 'IMG')) return null;
    if (!n.firstChild) { while (n && !n.nextSibling && n !== el) n = n.parentNode; if (!n || n === el) return null; }
  }
  return null;
}
function lastText(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let last = null;
  while (w.nextNode()) last = w.currentNode;
  if (!last) return null;
  // only if no block/br between it and the end of el
  for (let n = last; n && n !== el; n = n.parentNode) {
    for (let s = n.nextSibling; s; s = s.nextSibling) if (s.nodeType === 1 && (BLOCK_RE.test(s.tagName) || s.tagName === 'BR')) return null;
  }
  return last;
}

/** Wrap loose inline content at the top level into paragraphs. */
export function wrapLooseInline(root) {
  const kids = Array.from(root.childNodes);
  let run = [];
  const flush = (before) => {
    if (!run.length) return;
    if (run.every((n) => n.nodeType === 3 && !n.data.trim())) { run.forEach((n) => n.remove()); run = []; return; }
    const p = document.createElement('p');
    root.insertBefore(p, before);
    run.forEach((n) => p.append(n));
    run = [];
  };
  for (const n of kids) {
    if (n.nodeType === 1 && BLOCK_RE.test(n.tagName)) flush(n);
    else if (n.nodeType === 1 && n.tagName === 'BR' && run.length === 0) n.remove();
    else run.push(n);
  }
  flush(null);
  if (!root.firstChild) root.append(Object.assign(document.createElement('p'), { innerHTML: '<br>' }));
}

/** Mark lists containing checkbox items as checklists. */
function fixChecklists(root) {
  for (const li of root.querySelectorAll('li[data-checked]')) {
    const ul = li.parentElement;
    if (ul && ul.tagName === 'UL') ul.classList.add('checklist');
  }
  for (const ul of root.querySelectorAll('ul.checklist')) for (const li of ul.children) if (!li.dataset.checked) li.dataset.checked = 'false';
}

/** Turn arbitrary HTML into clean, editable document HTML. */
export function sanitizeHtml(input, { keepWhitespace = false } = {}) {
  const parsed = new DOMParser().parseFromString(input, 'text/html');
  const out = document.createElement('div');
  cleanInto(parsed.body, out, document);
  // markdown task list items come through as <li><input type=checkbox> — mark via data-bds-check on li parent
  for (const el of out.querySelectorAll('[data-bds-check]')) {
    const li = el.tagName === 'LI' ? el : el.closest('li');
    if (li) li.dataset.checked = el.dataset.bdsCheck;
    delete el.dataset.bdsCheck;
  }
  fixChecklists(out);
  if (!keepWhitespace) normalizeWhitespace(out);
  wrapLooseInline(out);
  // empty paragraphs need a <br> to keep their height
  for (const p of out.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li')) if (!p.textContent && !p.querySelector('img,br')) p.append(document.createElement('br'));
  return out.innerHTML;
}

export function textToHtml(text) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  return lines.map((l) => (l ? `<p>${esc(l)}</p>` : '<p><br></p>')).join('');
}

// ---------------------------------------------------------------------------
// HTML → Markdown
// ---------------------------------------------------------------------------

function mdEscape(s) {
  return s.replace(/([\\`*_[\]])/g, '\\$1').replace(/^(\s*)([#>+-]|\d+\.)(\s)/, '$1\\$2$3');
}

function inlineMd(node) {
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) { out += mdEscape(n.data); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    if (BLOCK_RE.test(tag) && tag !== 'COL') { out += inlineMd(n) + '\n'; continue; }
    const cs = n.style;
    let inner = inlineMd(n);
    if (tag === 'BR') { out += '  \n'; continue; }
    if (tag === 'IMG') { out += `![${n.getAttribute('alt') || ''}](${n.getAttribute('src') || ''})`; continue; }
    if (!inner.trim()) { out += inner; continue; }
    const bold = tag === 'B' || tag === 'STRONG' || /^(bold|[6-9]00)$/.test(cs.fontWeight);
    const italic = tag === 'I' || tag === 'EM' || cs.fontStyle === 'italic';
    const strike = tag === 'S' || tag === 'DEL' || tag === 'STRIKE' || /line-through/.test(cs.textDecorationLine || cs.textDecoration);
    if (tag === 'CODE') inner = '`' + n.textContent + '`';
    if (strike) inner = `~~${inner}~~`;
    if (italic) inner = `*${inner}*`;
    if (bold) inner = `**${inner}**`;
    if (tag === 'SUP') inner = `<sup>${inner}</sup>`;
    if (tag === 'SUB') inner = `<sub>${inner}</sub>`;
    if (tag === 'A' && n.getAttribute('href')) inner = `[${inner}](${n.getAttribute('href')})`;
    out += inner;
  }
  return out;
}

function listMd(list, depth) {
  const ordered = list.tagName === 'OL';
  const check = list.classList.contains('checklist');
  let i = Number(list.getAttribute('start') || 1);
  let out = '';
  for (const li of list.children) {
    if (li.tagName !== 'LI') continue;
    const marker = check ? `- [${li.dataset.checked === 'true' ? 'x' : ' '}] ` : ordered ? `${i++}. ` : '- ';
    const text = [];
    let nested = '';
    for (const c of li.childNodes) {
      if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested += listMd(c, depth + 1);
      else if (c.nodeType === 1 && BLOCK_RE.test(c.tagName)) text.push(inlineMd(c));
      else text.push(c.nodeType === 3 ? mdEscape(c.data) : inlineMd({ childNodes: [c] }));
    }
    out += '  '.repeat(depth) + marker + text.join('').trim().replace(/\n/g, '\n' + '  '.repeat(depth + 1)) + '\n' + nested;
  }
  return out;
}

function tableMd(table) {
  const rows = Array.from(table.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((c) => inlineMd(c).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()));
  if (!rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(cols - r.length).fill('')];
  const lines = [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(cols).fill('---').join(' | ')} |`];
  for (const r of rows.slice(1)) lines.push(`| ${pad(r).join(' | ')} |`);
  return lines.join('\n') + '\n\n';
}

export function htmlToMarkdown(root) {
  let out = '';
  for (const n of root.childNodes) {
    if (n.nodeType === 3) { if (n.data.trim()) out += mdEscape(n.data) + '\n\n'; continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    if (/^H[1-6]$/.test(tag)) out += '#'.repeat(Number(tag[1])) + ' ' + inlineMd(n).trim() + '\n\n';
    else if (tag === 'P' && n.classList.contains('title')) out += '# ' + inlineMd(n).trim() + '\n\n';
    else if (tag === 'P' && n.classList.contains('subtitle')) out += '*' + inlineMd(n).trim() + '*\n\n';
    else if (tag === 'UL' || tag === 'OL') out += listMd(n, 0) + '\n';
    else if (tag === 'BLOCKQUOTE') out += htmlToMarkdown(n).trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
    else if (tag === 'PRE') out += '```\n' + n.textContent.replace(/\n$/, '') + '\n```\n\n';
    else if (tag === 'TABLE') out += tableMd(n);
    else if (tag === 'HR') out += '---\n\n';
    else if (n.classList.contains('page-break')) out += '\n<div style="page-break-after: always"></div>\n\n';
    else if (tag === 'DIV' && n.querySelector('p,h1,h2,h3,ul,ol,table,pre,blockquote')) out += htmlToMarkdown(n);
    else {
      const t = inlineMd(n).trim();
      out += (t || '') + '\n\n';
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
