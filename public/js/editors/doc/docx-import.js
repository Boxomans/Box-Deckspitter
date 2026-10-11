// .docx → editable HTML. Reads document.xml, styles, numbering, relationships, theme and media.

import { vendor, bytesToBase64 } from '../../core/dom.js';
import { LH_FACTOR } from './styles.js';

const HIGHLIGHT = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};
const LIST_FMT = {
  decimal: 'decimal', decimalZero: 'decimal-leading-zero', lowerLetter: 'lower-alpha', upperLetter: 'upper-alpha',
  lowerRoman: 'lower-roman', upperRoman: 'upper-roman', none: 'none', ordinal: 'decimal', cardinalText: 'decimal',
};
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff', emf: 'image/emf', wmf: 'image/wmf' };

const kids = (el) => (el ? Array.from(el.children) : []);
const child = (el, name) => (el ? kids(el).find((c) => c.nodeName === name) : null);
const val = (el, a = 'w:val') => (el ? el.getAttribute(a) : null);
const onOff = (el) => !!el && !/^(0|false|off|none)$/i.test(el.getAttribute('w:val') || '1');
const tw = (v) => (v == null || v === '' ? null : Number(v) / 20); // twips → pt

function parseRPr(rPr, theme) {
  const o = {};
  if (!rPr) return o;
  for (const c of kids(rPr)) {
    switch (c.nodeName) {
      case 'w:b': o.bold = onOff(c); break;
      case 'w:i': o.italic = onOff(c); break;
      case 'w:u': o.underline = (val(c) || 'single') !== 'none'; break;
      case 'w:strike': o.strike = onOff(c); break;
      case 'w:dstrike': if (onOff(c)) o.strike = true; break;
      case 'w:caps': o.caps = onOff(c); break;
      case 'w:smallCaps': o.smallCaps = onOff(c); break;
      case 'w:vanish': o.hidden = onOff(c); break;
      case 'w:color': { const v = val(c); if (v && v !== 'auto') o.color = '#' + v.toLowerCase(); else if (v === 'auto') o.color = null; break; }
      case 'w:sz': o.size = Number(val(c)) / 2; break;
      case 'w:highlight': { const v = val(c); if (v && v !== 'none') o.highlight = HIGHLIGHT[v] || null; break; }
      case 'w:shd': { const f = val(c, 'w:fill'); if (f && f !== 'auto' && f !== 'FFFFFF') o.shading = '#' + f.toLowerCase(); break; }
      case 'w:vertAlign': { const v = val(c); o.vert = v === 'superscript' ? 'super' : v === 'subscript' ? 'sub' : null; break; }
      case 'w:rFonts': {
        let f = c.getAttribute('w:ascii') || c.getAttribute('w:hAnsi');
        const th = c.getAttribute('w:asciiTheme') || c.getAttribute('w:hAnsiTheme');
        if (!f && th && theme) f = /major/i.test(th) ? theme.major : theme.minor;
        if (f) o.font = f;
        break;
      }
      case 'w:rStyle': o.rStyle = val(c); break;
      default: break;
    }
  }
  return o;
}

function parsePPr(pPr) {
  const o = {};
  if (!pPr) return o;
  for (const c of kids(pPr)) {
    switch (c.nodeName) {
      case 'w:pStyle': o.styleId = val(c); break;
      case 'w:jc': {
        const v = val(c);
        o.align = v === 'center' ? 'center' : v === 'right' || v === 'end' ? 'right' : v === 'both' || v === 'distribute' ? 'justify' : 'left';
        break;
      }
      case 'w:ind': {
        const l = c.getAttribute('w:left') ?? c.getAttribute('w:start');
        if (l != null) o.indLeft = tw(l);
        const fl = c.getAttribute('w:firstLine');
        const hg = c.getAttribute('w:hanging');
        if (fl != null) o.firstLine = tw(fl);
        if (hg != null) o.firstLine = -tw(hg);
        break;
      }
      case 'w:spacing': {
        const b = c.getAttribute('w:before');
        const a = c.getAttribute('w:after');
        if (b != null && c.getAttribute('w:beforeAutospacing') !== '1') o.before = tw(b);
        if (a != null && c.getAttribute('w:afterAutospacing') !== '1') o.after = tw(a);
        const line = c.getAttribute('w:line');
        if (line != null) {
          const rule = c.getAttribute('w:lineRule') || 'auto';
          o.line = rule === 'auto' ? { ratio: Number(line) / 240 } : { pt: tw(line), atLeast: rule === 'atLeast' };
        }
        break;
      }
      case 'w:numPr': {
        const id = val(child(c, 'w:numId'));
        if (id != null) o.numId = id;
        const lvl = val(child(c, 'w:ilvl'));
        if (lvl != null) o.ilvl = Number(lvl);
        break;
      }
      case 'w:pageBreakBefore': o.pageBreakBefore = onOff(c); break;
      case 'w:shd': { const f = val(c, 'w:fill'); if (f && f !== 'auto') o.shading = '#' + f.toLowerCase(); break; }
      case 'w:outlineLvl': o.outline = Number(val(c)); break;
      case 'w:rPr': o.markRun = true; break;
      default: break;
    }
  }
  return o;
}

class Styles {
  constructor(xml, theme) {
    this.theme = theme;
    this.map = {};
    this.defR = {};
    this.defP = {};
    this.defaultPara = null;
    this.defaultChar = null;
    if (!xml) return;
    const dd = xml.getElementsByTagName('w:docDefaults')[0];
    if (dd) {
      this.defR = parseRPr(dd.getElementsByTagName('w:rPr')[0], theme);
      this.defP = parsePPr(dd.getElementsByTagName('w:pPr')[0]);
    }
    for (const s of Array.from(xml.getElementsByTagName('w:style'))) {
      const id = s.getAttribute('w:styleId');
      const type = s.getAttribute('w:type');
      const entry = {
        id, type, name: (val(child(s, 'w:name')) || id || '').toLowerCase(), basedOn: val(child(s, 'w:basedOn')),
        p: parsePPr(child(s, 'w:pPr')), r: parseRPr(child(s, 'w:rPr'), theme),
      };
      this.map[id] = entry;
      if (s.getAttribute('w:default') === '1') {
        if (type === 'paragraph') this.defaultPara = id;
        if (type === 'character') this.defaultChar = id;
      }
    }
  }

  chain(id) {
    const out = [];
    let cur = this.map[id];
    const seen = new Set();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = this.map[cur.basedOn]; }
    return out;
  }

  para(id) {
    const ch = this.chain(id || this.defaultPara);
    return { p: Object.assign({}, ...ch.map((s) => s.p)), r: Object.assign({}, ...ch.map((s) => s.r)), name: ch.length ? ch[ch.length - 1].name : '' };
  }

  run(id) {
    if (!id) return {};
    return Object.assign({}, ...this.chain(id).map((s) => s.r));
  }
}

class Numbering {
  constructor(xml) {
    this.abs = {};
    this.nums = {};
    if (!xml) return;
    for (const a of Array.from(xml.getElementsByTagName('w:abstractNum'))) {
      const levels = {};
      for (const l of kids(a).filter((c) => c.nodeName === 'w:lvl')) {
        levels[l.getAttribute('w:ilvl')] = {
          fmt: val(child(l, 'w:numFmt')) || 'decimal',
          text: val(child(l, 'w:lvlText')) || '',
          start: Number(val(child(l, 'w:start')) || 1),
        };
      }
      this.abs[a.getAttribute('w:abstractNumId')] = levels;
    }
    for (const n of Array.from(xml.getElementsByTagName('w:num'))) {
      const overrides = {};
      for (const o of kids(n).filter((c) => c.nodeName === 'w:lvlOverride')) {
        const so = child(o, 'w:startOverride');
        if (so) overrides[o.getAttribute('w:ilvl')] = Number(val(so));
      }
      this.nums[n.getAttribute('w:numId')] = { abs: val(child(n, 'w:abstractNumId')), overrides };
    }
  }

  level(numId, ilvl) {
    const n = this.nums[numId];
    if (!n) return null;
    const lv = (this.abs[n.abs] || {})[ilvl] || { fmt: 'decimal', text: '', start: 1 };
    return { ...lv, start: n.overrides[ilvl] ?? lv.start };
  }
}

export async function importDocx(bytes) {
  const JSZip = await vendor.jszip();
  const zip = await JSZip.loadAsync(bytes);
  const read = async (p) => { const f = zip.file(p); return f ? f.async('string') : null; };
  const parse = (s) => (s ? new DOMParser().parseFromString(s, 'application/xml') : null);

  let mainPath = 'word/document.xml';
  const ct = parse(await read('[Content_Types].xml'));
  if (ct) {
    const o = Array.from(ct.getElementsByTagName('Override')).find((x) => /wordprocessingml\.document\.main|\.document\.macroEnabled\.main|template\.main/.test(x.getAttribute('ContentType') || ''));
    if (o) mainPath = o.getAttribute('PartName').replace(/^\//, '');
  }
  const doc = parse(await read(mainPath));
  if (!doc || !doc.getElementsByTagName('w:body')[0]) throw new Error('This file is not a valid Word document.');
  const dir = mainPath.replace(/[^/]+$/, '');
  const relName = mainPath.replace(/^.*\//, '');
  const rels = parse(await read(`${dir}_rels/${relName}.rels`));
  const themeXml = parse(await read(`${dir}theme/theme1.xml`));
  const theme = {};
  if (themeXml) {
    const maj = themeXml.getElementsByTagName('a:majorFont')[0];
    const min = themeXml.getElementsByTagName('a:minorFont')[0];
    theme.major = maj?.getElementsByTagName('a:latin')[0]?.getAttribute('typeface') || 'Calibri Light';
    theme.minor = min?.getElementsByTagName('a:latin')[0]?.getAttribute('typeface') || 'Calibri';
  }
  const styles = new Styles(parse(await read(`${dir}styles.xml`)), theme);
  const numbering = new Numbering(parse(await read(`${dir}numbering.xml`)));

  const relMap = {};
  const media = {};
  if (rels) {
    for (const r of Array.from(rels.getElementsByTagName('Relationship'))) {
      const id = r.getAttribute('Id');
      const target = r.getAttribute('Target');
      const external = r.getAttribute('TargetMode') === 'External';
      relMap[id] = { target, external, type: r.getAttribute('Type') || '' };
      if (!external && /\/image$/.test(relMap[id].type)) {
        const p = target.startsWith('/') ? target.slice(1) : (dir + target).replace(/[^/]+\/\.\.\//g, '');
        const f = zip.file(p);
        if (f) {
          const ext = p.split('.').pop().toLowerCase();
          const b = await f.async('uint8array');
          media[id] = { url: `data:${MIME[ext] || 'application/octet-stream'};base64,${bytesToBase64(b)}`, ext };
        }
      }
    }
  }

  const conv = new Converter(styles, numbering, relMap, media, theme);
  const body = doc.getElementsByTagName('w:body')[0];
  const container = document.createElement('div');
  conv.blocks(kids(body), container);
  conv.closeLists();

  // page setup from the final section
  const sect = child(body, 'w:sectPr') || Array.from(body.getElementsByTagName('w:sectPr')).pop();
  const page = { size: 'letter', orientation: 'portrait', margins: { top: 1, right: 1, bottom: 1, left: 1 } };
  if (sect) {
    const sz = child(sect, 'w:pgSz');
    const mar = child(sect, 'w:pgMar');
    if (sz) {
      let w = Number(sz.getAttribute('w:w')) / 1440;
      let hgt = Number(sz.getAttribute('w:h')) / 1440;
      const landscape = sz.getAttribute('w:orient') === 'landscape' || w > hgt;
      if (landscape) { page.orientation = 'landscape'; [w, hgt] = [hgt, w]; }
      const near = (a, b) => Math.abs(a - b) < 0.06;
      page.size = near(w, 8.5) && near(hgt, 11) ? 'letter' : near(w, 8.27) && near(hgt, 11.69) ? 'a4' : near(w, 8.5) && near(hgt, 14) ? 'legal'
        : near(w, 5.83) && near(hgt, 8.27) ? 'a5' : near(w, 11) && near(hgt, 17) ? 'tabloid' : near(w, 7.25) && near(hgt, 10.5) ? 'executive' : 'custom';
      if (page.size === 'custom') { page.w = +w.toFixed(2); page.h = +hgt.toFixed(2); }
    }
    if (mar) {
      for (const k of ['top', 'right', 'bottom', 'left']) {
        const v = mar.getAttribute('w:' + k) ?? mar.getAttribute('w:' + (k === 'left' ? 'start' : k === 'right' ? 'end' : k));
        if (v != null) page.margins[k] = Math.max(0, +(Math.abs(Number(v)) / 1440).toFixed(2));
      }
    }
  }

  const normal = styles.para(null);
  const defR = { ...styles.defR, ...normal.r };
  const defP = { ...styles.defP, ...normal.p };
  const defaults = {
    font: defR.font || theme.minor || 'Calibri',
    size: defR.size || 11,
    lineHeight: defP.line?.ratio ? +(defP.line.ratio * LH_FACTOR).toFixed(3) : LH_FACTOR,
    spaceAfter: defP.after ?? 0,
  };
  if (!container.firstChild) container.innerHTML = '<p><br></p>';
  return { html: container.innerHTML, page, defaults, warnings: conv.warnings };
}

class Converter {
  constructor(styles, numbering, rels, media, theme) {
    this.styles = styles;
    this.num = numbering;
    this.rels = rels;
    this.media = media;
    this.theme = theme;
    this.listStack = [];
    this.counters = {};
    this.listParent = null;
    this.warnings = new Set();
    const normal = styles.para(null);
    this.baseR = { ...styles.defR, ...normal.r };
    this.baseP = { ...styles.defP, ...normal.p };
  }

  // ------------------------------------------------------------------ blocks

  flatten(nodes) {
    const out = [];
    for (const n of nodes) {
      const name = n.nodeName;
      if (name === 'w:sdt') out.push(...this.flatten(kids(child(n, 'w:sdtContent'))));
      else if (name === 'w:customXml' || name === 'w:ins' || name === 'w:moveTo' || name === 'w:smartTag') out.push(...this.flatten(kids(n)));
      else if (name === 'mc:AlternateContent') out.push(...this.flatten(kids(child(n, 'mc:Choice') || child(n, 'mc:Fallback'))));
      else out.push(n);
    }
    return out;
  }

  blocks(nodes, container) {
    for (const n of this.flatten(nodes)) {
      try {
        if (n.nodeName === 'w:p') this.paragraph(n, container);
        else if (n.nodeName === 'w:tbl') { this.closeLists(); container.append(this.table(n)); }
      } catch (e) {
        console.warn('docx import: skipped element', e);
        this.warnings.add('Some content could not be converted.');
      }
    }
  }

  closeLists() { this.listStack = []; }

  paragraph(p, container) {
    const pPr = parsePPr(child(p, 'w:pPr'));
    const st = this.styles.para(pPr.styleId);
    const props = { ...this.baseP, ...st.p, ...pPr };
    const name = st.name;
    const paraR = pPr.styleId ? st.r : {};

    // numbering may come from the style
    let numId = pPr.numId ?? st.p.numId;
    const ilvl = pPr.ilvl ?? st.p.ilvl ?? 0;
    if (numId === '0') numId = null;
    const lvl = numId != null ? this.num.level(numId, ilvl) : null;

    let tag = 'p';
    let cls = null;
    const hm = /^heading (\d)$/.exec(name);
    if (hm) tag = 'h' + Math.min(6, Number(hm[1]));
    else if (name === 'title') cls = 'title';
    else if (name === 'subtitle') cls = 'subtitle';
    else if (/^(intense )?quote$/.test(name)) tag = 'blockquote';
    else if (/^(html preformatted|code|plain text|source code)/.test(name)) tag = 'pre';

    if (props.pageBreakBefore && !lvl) { this.closeLists(); container.append(pageBreak()); }

    const makeBlock = () => {
      const el = document.createElement(lvl ? 'li' : tag);
      if (cls && !lvl) el.className = cls;
      this.applyParaStyle(el, props, !!lvl, tag, paraR, !!pPr.styleId);
      return el;
    };

    let el = makeBlock();
    const segments = [el];
    const ctx = {
      base: { ...this.baseR, ...paraR },
      onPageBreak: () => { const pb = pageBreak(); segments.push(pb); el = makeBlock(); segments.push(el); return el; },
      floats: [],
      target: () => el,
      field: [],
    };
    this.inline(kids(p), ctx);

    for (const seg of segments) if (seg !== segments[0] && seg.classList?.contains('page-break')) { /* ok */ }
    for (const seg of segments) if (seg.tagName !== 'DIV' && !seg.textContent && !seg.querySelector('img,br')) seg.append(document.createElement('br'));

    if (lvl) {
      this.listItem(segments[0], numId, ilvl, lvl, container);
      for (const s of segments.slice(1)) { this.closeLists(); container.append(s.tagName === 'LI' ? relabel(s, 'p') : s); }
    } else {
      this.closeLists();
      for (const s of segments) container.append(s);
    }
    for (const f of ctx.floats) container.append(f);
  }

  applyParaStyle(el, props, isList, tag, paraR, styled) {
    const s = el.style;
    if (props.align && props.align !== 'left') s.textAlign = props.align;
    if (!isList) {
      if (props.indLeft) s.marginLeft = props.indLeft + 'pt';
      if (props.firstLine) s.textIndent = props.firstLine + 'pt';
    }
    const isHeading = /^h\d$/.test(tag) || el.className === 'title' || el.className === 'subtitle';
    if (!isHeading) {
      if (props.before != null && props.before !== (this.baseP.before ?? 0)) s.marginTop = props.before + 'pt';
      if (props.after != null && props.after !== (this.baseP.after ?? 0) && !isList) s.marginBottom = props.after + 'pt';
    }
    if (props.line && JSON.stringify(props.line) !== JSON.stringify(this.baseP.line)) {
      if (props.line.ratio) s.lineHeight = +(props.line.ratio * LH_FACTOR).toFixed(3);
      else if (props.line.pt) s.lineHeight = props.line.pt + 'pt';
    }
    if (props.shading) s.backgroundColor = props.shading;
    if (styled) {
      // bake the paragraph style's character look onto the block so Word styles survive
      const r = paraR;
      if (r.font && r.font !== this.baseR.font) s.fontFamily = `'${r.font}'`;
      if (r.size && r.size !== this.baseR.size) s.fontSize = r.size + 'pt';
      if (r.color) s.color = r.color;
      if (r.bold === false && isHeading) s.fontWeight = 'normal';
      else if (r.bold === true && !isHeading) s.fontWeight = 'bold';
      if (r.italic === true) s.fontStyle = 'italic';
      if (r.caps) s.textTransform = 'uppercase';
    }
  }

  listItem(li, numId, ilvl, lvl, container) {
    const ordered = lvl.fmt !== 'bullet';
    const type = ordered ? LIST_FMT[lvl.fmt] || 'decimal' : bulletType(lvl.text, ilvl);
    const key = numId + ':' + ilvl;
    // reset deeper counters
    for (const k of Object.keys(this.counters)) {
      const [n, l] = k.split(':');
      if (n === String(numId) && Number(l) > ilvl) delete this.counters[k];
    }
    while (this.listStack.length && this.listStack[this.listStack.length - 1].level > ilvl) this.listStack.pop();
    let top = this.listStack[this.listStack.length - 1];
    if (top && top.level === ilvl && (top.numId !== numId || top.ordered !== ordered)) { this.listStack.pop(); top = this.listStack[this.listStack.length - 1]; }
    if (!top || top.level < ilvl || top.container !== container && !top) {
      const list = document.createElement(ordered ? 'ol' : 'ul');
      const defaultType = ordered ? ['decimal', 'lower-alpha', 'lower-roman'][ilvl % 3] : ['disc', 'circle', 'square'][ilvl % 3];
      if (type !== defaultType) list.style.listStyleType = type;
      const count = this.counters[key] || 0;
      const start = (ordered ? lvl.start : 1) + count;
      if (ordered && start !== 1) list.setAttribute('start', String(start));
      const parent = top ? (top.list.lastElementChild || top.list) : container;
      parent.append(list);
      top = { list, level: ilvl, numId, ordered, container };
      this.listStack.push(top);
    }
    top.list.append(li);
    this.counters[key] = (this.counters[key] || 0) + 1;
  }

  // ------------------------------------------------------------------ inline

  inline(nodes, ctx) {
    for (const n of nodes) {
      switch (n.nodeName) {
        case 'w:r': this.run(n, ctx); break;
        case 'w:hyperlink': {
          const id = n.getAttribute('r:id');
          const anchor = n.getAttribute('w:anchor');
          const href = id && this.rels[id] ? this.rels[id].target : anchor ? '#' + anchor : null;
          const a = document.createElement('a');
          if (href) a.setAttribute('href', href);
          const prev = ctx.target;
          const outer = ctx.target();
          ctx.target = () => a;
          this.inline(kids(n), ctx);
          ctx.target = prev;
          outer.append(a);
          break;
        }
        case 'w:fldSimple': {
          const instr = n.getAttribute('w:instr') || '';
          const m = /HYPERLINK\s+"([^"]+)"/.exec(instr);
          if (m) {
            const a = document.createElement('a');
            a.setAttribute('href', m[1]);
            const prev = ctx.target;
            const outer = ctx.target();
            ctx.target = () => a;
            this.inline(kids(n), ctx);
            ctx.target = prev;
            outer.append(a);
          } else this.inline(kids(n), ctx);
          break;
        }
        case 'w:smartTag': case 'w:customXml': case 'w:ins': case 'w:moveTo': case 'w:dir': case 'w:bdo':
          this.inline(kids(n), ctx); break;
        case 'w:sdt': this.inline(kids(child(n, 'w:sdtContent')), ctx); break;
        case 'mc:AlternateContent': this.inline(kids(child(n, 'mc:Choice') || child(n, 'mc:Fallback')), ctx); break;
        case 'm:oMath': case 'm:oMathPara': {
          const t = Array.from(n.getElementsByTagName('m:t')).map((x) => x.textContent).join('');
          if (t) { const sp = document.createElement('span'); sp.style.fontStyle = 'italic'; sp.style.fontFamily = "'Cambria Math', Cambria, serif"; sp.textContent = t; ctx.target().append(sp); }
          break;
        }
        default: break;
      }
    }
  }

  run(r, ctx) {
    const rPrEl = child(r, 'w:rPr');
    const direct = parseRPr(rPrEl, this.theme);
    const charStyle = this.styles.run(direct.rStyle || this.styles.defaultChar);
    const eff = { ...ctx.base, ...charStyle, ...direct };
    if (eff.hidden) return;

    let span = null;
    const ensureSpan = () => {
      if (span) return span;
      span = this.makeRunSpan(eff, ctx.base);
      ctx.target().append(span.outer);
      return span;
    };
    const addText = (t) => { const s = ensureSpan(); s.inner.append(document.createTextNode(t)); };

    for (const c of kids(r)) {
      // complex fields: hide instructions, show results
      if (c.nodeName === 'w:fldChar') {
        const type = c.getAttribute('w:fldCharType');
        if (type === 'begin') ctx.field.push('instr');
        else if (type === 'separate') { if (ctx.field.length) ctx.field[ctx.field.length - 1] = 'result'; }
        else if (type === 'end') ctx.field.pop();
        continue;
      }
      if (ctx.field.length && ctx.field[ctx.field.length - 1] === 'instr') continue;
      switch (c.nodeName) {
        case 'w:t': addText(c.textContent); break;
        case 'w:tab': case 'w:ptab': addText('\t'); break;
        case 'w:br': case 'w:cr': {
          const type = c.getAttribute('w:type');
          if (type === 'page') { span = null; ctx.onPageBreak(); }
          else { ensureSpan().inner.append(document.createElement('br')); }
          break;
        }
        case 'w:noBreakHyphen': addText('‑'); break;
        case 'w:softHyphen': addText('­'); break;
        case 'w:sym': {
          const code = parseInt(c.getAttribute('w:char') || '0', 16);
          const font = c.getAttribute('w:font') || '';
          let ch = code >= 0xf000 ? code - 0xf000 : code;
          const map = { 0xa7: '▪', 0xb7: '•', 0xd8: '➢', 0xfc: '✓', 0xfb: '✗', 0x6c: '●', 0x6e: '■', 0x71: '❑', 0x76: '❖', 0xa8: '☐', 0xfe: '☑' };
          addText(/wingdings|symbol/i.test(font) && map[ch] ? map[ch] : String.fromCharCode(ch));
          break;
        }
        case 'w:drawing': this.drawing(c, ctx); span = null; break;
        case 'w:pict': case 'w:object': this.vml(c, ctx); span = null; break;
        case 'mc:AlternateContent': {
          const ch = child(c, 'mc:Choice') || child(c, 'mc:Fallback');
          for (const d of kids(ch)) {
            if (d.nodeName === 'w:drawing') this.drawing(d, ctx);
            else if (d.nodeName === 'w:pict') this.vml(d, ctx);
          }
          span = null;
          break;
        }
        case 'w:footnoteReference': case 'w:endnoteReference': {
          const sup = document.createElement('sup');
          sup.textContent = '[' + (c.getAttribute('w:id') || '*') + ']';
          ctx.target().append(sup);
          break;
        }
        default: break;
      }
    }
  }

  makeRunSpan(eff, base) {
    const outer = document.createElement(eff.vert === 'super' ? 'sup' : eff.vert === 'sub' ? 'sub' : 'span');
    const s = outer.style;
    const diff = (k) => eff[k] !== undefined && eff[k] !== base[k];
    if (diff('bold')) s.fontWeight = eff.bold ? 'bold' : 'normal';
    if (diff('italic')) s.fontStyle = eff.italic ? 'italic' : 'normal';
    const deco = [];
    if (eff.underline) deco.push('underline');
    if (eff.strike) deco.push('line-through');
    if (deco.length && (diff('underline') || diff('strike'))) s.textDecorationLine = deco.join(' ');
    if (diff('color') && eff.color) s.color = eff.color;
    if (diff('size') && eff.size) s.fontSize = eff.size + 'pt';
    if (diff('font') && eff.font) s.fontFamily = `'${eff.font}'`;
    const bg = eff.highlight || eff.shading;
    if (bg) s.backgroundColor = bg;
    if (eff.caps) s.textTransform = 'uppercase';
    if (eff.smallCaps) s.fontVariantCaps = 'small-caps';
    return { outer, inner: outer };
  }

  drawing(d, ctx) {
    const blip = d.getElementsByTagName('a:blip')[0];
    const extent = d.getElementsByTagName('wp:extent')[0];
    const anchor = d.getElementsByTagName('wp:anchor')[0];
    const docPr = d.getElementsByTagName('wp:docPr')[0];
    const txbx = d.getElementsByTagName('w:txbxContent')[0];
    if (blip) {
      const id = blip.getAttribute('r:embed') || blip.getAttribute('r:link');
      const m = this.media[id];
      if (!m) return;
      if (m.ext === 'emf' || m.ext === 'wmf' || m.ext === 'tif' || m.ext === 'tiff') { this.warnings.add('Some images use formats browsers cannot show (EMF/WMF/TIFF).'); return; }
      const img = document.createElement('img');
      img.src = m.url;
      if (docPr?.getAttribute('descr')) img.alt = docPr.getAttribute('descr');
      if (extent) {
        const w = Math.round(Number(extent.getAttribute('cx')) / 9525);
        if (w > 0) img.style.width = w + 'px';
      }
      if (anchor) {
        const align = anchor.getElementsByTagName('wp:align')[0]?.textContent;
        const wrap = ['wp:wrapSquare', 'wp:wrapTight', 'wp:wrapThrough'].some((t) => anchor.getElementsByTagName(t)[0]);
        if (wrap && align === 'right') img.className = 'float-right';
        else if (wrap && align === 'left') img.className = 'float-left';
        else if (align === 'center') img.className = 'center';
      }
      ctx.target().append(img);
    } else if (txbx) {
      const box = document.createElement('div');
      box.className = 'textbox';
      const saved = this.listStack;
      this.listStack = [];
      this.blocks(kids(txbx), box);
      this.listStack = saved;
      ctx.floats.push(box);
    } else {
      this.warnings.add('Charts, SmartArt and shapes are not editable here and were skipped.');
    }
  }

  vml(p, ctx) {
    const im = p.getElementsByTagName('v:imagedata')[0];
    if (!im) return;
    const m = this.media[im.getAttribute('r:id')];
    if (!m || /emf|wmf|tif/.test(m.ext)) return;
    const img = document.createElement('img');
    img.src = m.url;
    const shape = p.getElementsByTagName('v:shape')[0];
    const w = /width:\s*([\d.]+)pt/.exec(shape?.getAttribute('style') || '');
    if (w) img.style.width = Math.round(Number(w[1]) * 96 / 72) + 'px';
    ctx.target().append(img);
  }

  // ------------------------------------------------------------------ tables

  table(tbl) {
    const table = document.createElement('table');
    const tblPr = child(tbl, 'w:tblPr');
    const styleId = val(child(tblPr, 'w:tblStyle'));
    const styleName = (this.styles.map[styleId]?.name || '').toLowerCase();
    const borders = child(tblPr, 'w:tblBorders');
    const hasBorders = borders ? kids(borders).some((b) => !/^(nil|none)$/.test(val(b) || '')) : /grid|table/.test(styleName) && !/normal/.test(styleName);
    if (!hasBorders) table.className = 'plain';
    const jc = val(child(tblPr, 'w:jc'));
    const grid = kids(child(tbl, 'w:tblGrid')).map((g) => Number(g.getAttribute('w:w')) / 20);
    const total = grid.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const cg = document.createElement('colgroup');
      for (const w of grid) { const col = document.createElement('col'); col.style.width = (w / total * 100).toFixed(2) + '%'; cg.append(col); }
      table.append(cg);
      const tblW = child(tblPr, 'w:tblW');
      if (tblW && tblW.getAttribute('w:type') === 'dxa' && total < 400) table.style.width = total + 'pt';
      else if (total < 400 && !tblW) table.style.width = total + 'pt';
    }
    if (jc === 'center') { table.style.marginLeft = 'auto'; table.style.marginRight = 'auto'; }
    const tbody = document.createElement('tbody');
    table.append(tbody);
    const vmerge = {}; // grid col → td
    const saved = this.listStack;
    for (const tr of kids(tbl).filter((c) => c.nodeName === 'w:tr' || c.nodeName === 'w:sdt' || c.nodeName === 'w:customXml')) {
      const rows = tr.nodeName === 'w:tr' ? [tr] : Array.from(tr.getElementsByTagName('w:tr'));
      for (const row of rows) {
        const trEl = document.createElement('tr');
        let col = 0;
        const gridBefore = Number(val(child(child(row, 'w:trPr'), 'w:gridBefore')) || 0);
        col += gridBefore;
        for (const tc of this.flatten(kids(row)).filter((c) => c.nodeName === 'w:tc')) {
          const tcPr = child(tc, 'w:tcPr');
          const span = Number(val(child(tcPr, 'w:gridSpan')) || 1);
          const vm = child(tcPr, 'w:vMerge');
          if (vm && val(vm) !== 'restart') {
            const top = vmerge[col];
            if (top) top.rowSpan = (top.rowSpan || 1) + 1;
            col += span;
            continue;
          }
          const td = document.createElement('td');
          if (span > 1) td.colSpan = span;
          if (vm) vmerge[col] = td; else delete vmerge[col];
          const shd = child(tcPr, 'w:shd');
          const fill = shd?.getAttribute('w:fill');
          if (fill && fill !== 'auto' && fill.toUpperCase() !== 'FFFFFF') td.style.backgroundColor = '#' + fill.toLowerCase();
          const va = val(child(tcPr, 'w:vAlign'));
          if (va === 'center') td.style.verticalAlign = 'middle';
          else if (va === 'bottom') td.style.verticalAlign = 'bottom';
          this.listStack = [];
          this.blocks(kids(tc), td);
          this.listStack = [];
          if (!td.firstChild) td.innerHTML = '<p><br></p>';
          trEl.append(td);
          col += span;
        }
        tbody.append(trEl);
      }
    }
    this.listStack = saved;
    return table;
  }
}

function bulletType(text, ilvl) {
  if (text === 'o' || text === '◦') return 'circle';
  if (text === '§' || text === '▪' || text === '■' || text === '') return 'square';
  return ['disc', 'circle', 'square'][ilvl % 3];
}

function pageBreak() {
  const d = document.createElement('div');
  d.className = 'page-break';
  d.setAttribute('contenteditable', 'false');
  return d;
}

function relabel(el, tag) {
  const n = document.createElement(tag);
  n.append(...el.childNodes);
  n.setAttribute('style', el.getAttribute('style') || '');
  return n;
}
