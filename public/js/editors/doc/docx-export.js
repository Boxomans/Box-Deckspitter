// Editable HTML → .docx. Walks the live editor DOM and reads computed styles so what you see is what Word gets.

import { vendor, rgbToHex, dataURLToBytes } from '../../core/dom.js';
import { pageDims, LH_FACTOR, docContentCss } from './styles.js';

const PX_TW = 15; // 1 CSS px = 15 twips
const BLOCK_DISPLAY = /^(block|list-item|table|flex|grid|flow-root)$/;
const INLINE_TAGS = /^(SPAN|B|STRONG|I|EM|U|S|STRIKE|DEL|INS|SUB|SUP|A|FONT|MARK|SMALL|BIG|CODE|KBD|SAMP|VAR|ABBR|CITE|Q|TIME|TT|BR|IMG)$/;

const firstFamily = (f) => (f || '').split(',')[0].replace(/["']/g, '').trim();
const ptOf = (px) => Math.round(parseFloat(px) * 0.75 * 2) / 2;
const hex6 = (c) => { const x = rgbToHex(c); return x ? x.slice(1).toUpperCase() : null; };

export async function exportDocx(editor) {
  const D = await vendor.docx();
  const ex = new Exporter(D, editor);
  try {
    ex.makeProbes();
    const children = await ex.blocks(editor.body, {});
    const d = pageDims(editor.pageSetup);
    const m = editor.pageSetup.margins;
    const landscape = editor.pageSetup.orientation === 'landscape';
    const inTw = (v) => Math.round(v * 1440);
    const def = editor.defaults;
    const doc = new D.Document({
      creator: 'Box-DocSpitter',
      title: editor.tab.title.replace(/\.[^.]+$/, ''),
      styles: ex.styles(def),
      numbering: { config: ex.numbering.length ? ex.numbering : [ex.placeholderNumbering()] },
      features: { updateFields: false },
      sections: [{
        properties: {
          page: {
            size: { width: inTw(landscape ? d.h : d.w), height: inTw(landscape ? d.w : d.h), orientation: landscape ? D.PageOrientation.LANDSCAPE : D.PageOrientation.PORTRAIT },
            margin: { top: inTw(m.top), right: inTw(m.right), bottom: inTw(m.bottom), left: inTw(m.left) },
          },
        },
        children: children.length ? children : [new D.Paragraph({})],
      }],
    });
    const blob = await D.Packer.toBlob(doc);
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    ex.cleanup();
  }
}

class Exporter {
  constructor(D, editor) {
    this.D = D;
    this.ed = editor;
    this.numbering = [];
    this.listCount = 0;
    this.baseCache = new Map();
  }

  // ---------------------------------------------------------------- style baselines

  makeProbes() {
    // Off-screen copy of the content styles, used to learn what "unformatted" text looks like for each block type.
    this.probeHost = document.createElement('div');
    this.probeHost.className = 'doc-body';
    this.probeHost.setAttribute('style', this.ed.body.getAttribute('style') || '');
    Object.assign(this.probeHost.style, { position: 'absolute', left: '-9999px', top: '0', width: '600px', visibility: 'hidden' });
    this.probeHost.innerHTML = '<p id="pb-p">x</p><h1 id="pb-h1">x</h1><h2 id="pb-h2">x</h2><h3 id="pb-h3">x</h3><h4 id="pb-h4">x</h4><h5 id="pb-h5">x</h5><h6 id="pb-h6">x</h6>'
      + '<p class="title" id="pb-title">x</p><p class="subtitle" id="pb-subtitle">x</p><blockquote id="pb-quote">x</blockquote><pre id="pb-pre">x</pre>'
      + '<ul><li id="pb-li">x</li></ul><table><tbody><tr><td id="pb-td">x</td><th id="pb-th">x</th></tr></tbody></table>';
    document.body.append(this.probeHost);
    const read = (id) => {
      const cs = getComputedStyle(this.probeHost.querySelector('#pb-' + id));
      return { family: firstFamily(cs.fontFamily), size: ptOf(cs.fontSize), color: hex6(cs.color), bold: Number(cs.fontWeight) >= 600, italic: cs.fontStyle !== 'normal', upper: cs.textTransform === 'uppercase' };
    };
    for (const k of ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'title', 'subtitle', 'quote', 'pre', 'li', 'td', 'th']) this.baseCache.set(k, read(k));
  }

  cleanup() { this.probeHost?.remove(); }

  kindOf(block) {
    if (!block) return 'p';
    const t = block.tagName;
    if (/^H[1-6]$/.test(t)) return t.toLowerCase();
    if (t === 'P' && block.classList.contains('title')) return 'title';
    if (t === 'P' && block.classList.contains('subtitle')) return 'subtitle';
    if (t === 'PRE') return 'pre';
    if (t === 'BLOCKQUOTE' || block.closest?.('blockquote')) return 'quote';
    if (t === 'TH') return 'th';
    return 'p';
  }

  styles(def) {
    const D = this.D;
    const b = (k) => this.baseCache.get(k);
    const head = (k, before, after) => ({
      run: { size: Math.round(b(k).size * 2), bold: b(k).bold, italics: b(k).italic, color: b(k).color || undefined, font: b(k).family !== def.font ? b(k).family : undefined },
      paragraph: { spacing: { before, after, line: 300 }, keepNext: true, keepLines: true },
    });
    return {
      default: {
        document: {
          run: { font: def.font, size: Math.round(def.size * 2) },
          paragraph: { spacing: { after: Math.round(def.spaceAfter * 20), line: Math.round((def.lineHeight / LH_FACTOR) * 240) } },
        },
        title: { run: { size: Math.round(b('title').size * 2), bold: b('title').bold, color: b('title').color || undefined }, paragraph: { spacing: { after: 80, line: 276 } } },
        heading1: head('h1', 360, 120),
        heading2: head('h2', 280, 80),
        heading3: head('h3', 240, 80),
        heading4: head('h4', 200, 80),
        heading5: head('h5', 200, 60),
        heading6: head('h6', 200, 60),
        hyperlink: { run: { color: '1155CC', underline: { type: D.UnderlineType.SINGLE, color: '1155CC' } } },
      },
      paragraphStyles: [
        { id: 'Subtitle', name: 'Subtitle', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: Math.round(b('subtitle').size * 2), color: b('subtitle').color || undefined }, paragraph: { spacing: { after: 280 } } },
        { id: 'Quote', name: 'Quote', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { italics: true, color: b('quote').color || undefined }, paragraph: { indent: { left: 240 }, border: { left: { style: D.BorderStyle.SINGLE, size: 18, color: 'B9A6E4', space: 8 } } } },
        { id: 'Code', name: 'Code', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Consolas', size: Math.round(b('pre').size * 2) }, paragraph: { spacing: { after: 0, line: 240 }, shading: { type: D.ShadingType.CLEAR, fill: 'F5F3F9', color: 'auto' } } },
      ],
    };
  }

  placeholderNumbering() {
    return { reference: 'bds-none', levels: [{ level: 0, format: this.D.LevelFormat.BULLET, text: '•', alignment: this.D.AlignmentType.LEFT }] };
  }

  // ---------------------------------------------------------------- blocks

  isBlock(n) {
    if (n.nodeType !== 1) return false;
    if (n.classList.contains('page-break')) return true;
    if (INLINE_TAGS.test(n.tagName)) return false;
    return BLOCK_DISPLAY.test(getComputedStyle(n).display);
  }

  async blocks(container, ctx) {
    const out = [];
    let inline = [];
    const flush = async () => {
      if (!inline.length) return;
      const nodes = inline;
      inline = [];
      if (nodes.every((n) => n.nodeType === 3 && !n.data.trim())) return;
      out.push(...await this.paragraph(container, nodes, ctx));
    };
    for (const n of Array.from(container.childNodes)) {
      if (n.nodeType === 8) continue;
      if (!this.isBlock(n)) { inline.push(n); continue; }
      await flush();
      out.push(...await this.block(n, ctx));
    }
    await flush();
    return out;
  }

  async block(el, ctx) {
    const D = this.D;
    const t = el.tagName;
    if (el.classList.contains('page-break')) return [new D.Paragraph({ children: [new D.PageBreak()] })];
    if (t === 'UL' || t === 'OL') return this.list(el, ctx);
    if (t === 'TABLE') return [await this.table(el)];
    if (t === 'HR') return [new D.Paragraph({ border: { bottom: { color: 'C9C3D6', space: 1, style: D.BorderStyle.SINGLE, size: 6 } } })];
    if (t === 'IMG') return this.paragraph(el.parentElement, [el], ctx);
    const hasBlockKids = Array.from(el.children).some((c) => this.isBlock(c));
    if (hasBlockKids) return this.blocks(el, { ...ctx, quote: ctx.quote || t === 'BLOCKQUOTE' });
    return this.paragraph(el, Array.from(el.childNodes), ctx);
  }

  async list(listEl, ctx, level = 0, ref = null) {
    const D = this.D;
    const out = [];
    const check = listEl.classList.contains('checklist');
    if (!check && !ref) ref = this.makeNumbering(listEl);
    for (const li of Array.from(listEl.children)) {
      if (li.tagName !== 'LI') continue;
      const inline = [];
      const nested = [];
      for (const c of Array.from(li.childNodes)) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(c);
        else inline.push(c);
      }
      // li may contain paragraphs — treat each as part of the item
      const blockKids = inline.filter((c) => this.isBlock(c));
      const itemCtx = { ...ctx, list: check ? null : { ref, level }, checklist: check ? li.dataset.checked === 'true' : undefined, indentLevel: level };
      if (blockKids.length) {
        let first = true;
        for (const c of inline) {
          if (c.nodeType === 3 && !c.data.trim()) continue;
          const paras = this.isBlock(c) ? await this.block(c, first ? itemCtx : { ...ctx, continueLevel: level }) : await this.paragraph(li, [c], first ? itemCtx : { ...ctx, continueLevel: level });
          out.push(...paras);
          first = false;
        }
      } else {
        out.push(...await this.paragraph(li, inline, itemCtx));
      }
      for (const n of nested) {
        if (n.classList.contains('checklist') || check) out.push(...await this.list(n, ctx, level + 1, null));
        else out.push(...await this.list(n, ctx, level + 1, ref && !check ? this.extendNumbering(ref, n, level + 1) : null));
      }
    }
    return out;
  }

  makeNumbering(listEl) {
    const D = this.D;
    const ref = `bds-list-${++this.listCount}`;
    const types = [];
    const starts = [];
    // collect list types per depth from this subtree
    const walk = (el, depth) => {
      if (types[depth] == null) { types[depth] = { tag: el.tagName, type: getComputedStyle(el).listStyleType }; starts[depth] = Number(el.getAttribute('start') || 1); }
      for (const li of el.children) for (const c of li.children) if (c.tagName === 'UL' || c.tagName === 'OL') walk(c, depth + 1);
    };
    walk(listEl, 0);
    const fmt = (t) => {
      const F = D.LevelFormat;
      switch (t.type) {
        case 'decimal': return [F.DECIMAL, (l) => `%${l + 1}.`];
        case 'decimal-leading-zero': return [F.DECIMAL_ZERO, (l) => `%${l + 1}.`];
        case 'lower-alpha': case 'lower-latin': return [F.LOWER_LETTER, (l) => `%${l + 1}.`];
        case 'upper-alpha': case 'upper-latin': return [F.UPPER_LETTER, (l) => `%${l + 1}.`];
        case 'lower-roman': return [F.LOWER_ROMAN, (l) => `%${l + 1}.`];
        case 'upper-roman': return [F.UPPER_ROMAN, (l) => `%${l + 1}.`];
        case 'circle': return [F.BULLET, () => '◦'];
        case 'square': return [F.BULLET, () => '▪'];
        case 'none': return [F.NONE, () => ''];
        default: return t.tag === 'OL' ? [F.DECIMAL, (l) => `%${l + 1}.`] : [F.BULLET, (l) => ['•', '◦', '▪'][l % 3]];
      }
    };
    const levels = [];
    for (let l = 0; l < 9; l++) {
      const t = types[l] || { tag: types[types.length - 1]?.tag || 'UL', type: types[types.length - 1]?.tag === 'OL' ? ['decimal', 'lower-alpha', 'lower-roman'][l % 3] : ['disc', 'circle', 'square'][l % 3] };
      const [format, text] = fmt(t);
      levels.push({
        level: l, format, text: text(l), start: starts[l] || 1, alignment: D.AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720 * (l + 1) - 360 + 360, hanging: 360 } } },
      });
    }
    this.numbering.push({ reference: ref, levels });
    return ref;
  }

  extendNumbering(ref) { return ref; }

  async paragraph(block, nodes, ctx) {
    const D = this.D;
    const kind = this.kindOf(block);
    const base = this.baseCache.get(kind) || this.baseCache.get('p');
    const parts = [[]];
    const pageBreakAfter = [];
    await this.inline(nodes, base, block, parts, {});
    const cs = block ? getComputedStyle(block) : null;
    const props = {};
    if (kind === 'title') props.heading = D.HeadingLevel.TITLE;
    else if (/^h[1-6]$/.test(kind)) props.heading = D.HeadingLevel['HEADING_' + kind[1]];
    else if (kind === 'subtitle') props.style = 'Subtitle';
    else if (kind === 'pre') props.style = 'Code';
    else if (kind === 'quote' || ctx.quote) props.style = 'Quote';

    if (cs && block !== this.ed.body) {
      const a = cs.textAlign;
      if (a === 'center') props.alignment = D.AlignmentType.CENTER;
      else if (a === 'right' || a === 'end') props.alignment = D.AlignmentType.RIGHT;
      else if (a === 'justify') props.alignment = D.AlignmentType.JUSTIFIED;
      const s = block.style;
      const indent = {};
      if (s.marginLeft && !ctx.list) indent.left = Math.round(parseFloat(cs.marginLeft) * PX_TW);
      if (s.textIndent) { const ti = Math.round(parseFloat(cs.textIndent) * PX_TW); if (ti > 0) indent.firstLine = ti; else if (ti < 0) indent.hanging = -ti; }
      if (ctx.checklist !== undefined) indent.left = 360 + 360 * (ctx.indentLevel || 0);
      if (ctx.continueLevel != null) indent.left = 720 * (ctx.continueLevel + 1);
      if (Object.keys(indent).length) props.indent = indent;
      const spacing = {};
      if (s.marginTop) spacing.before = Math.round(parseFloat(cs.marginTop) * PX_TW);
      if (s.marginBottom) spacing.after = Math.round(parseFloat(cs.marginBottom) * PX_TW);
      if (s.lineHeight) {
        const v = s.lineHeight;
        if (/^[\d.]+$/.test(v)) { spacing.line = Math.round((Number(v) / LH_FACTOR) * 240); spacing.lineRule = D.LineRuleType.AUTO; }
        else { spacing.line = Math.round(parseFloat(cs.lineHeight) * PX_TW); spacing.lineRule = D.LineRuleType.EXACT; }
      }
      if (Object.keys(spacing).length) props.spacing = spacing;
      const bg = hex6(cs.backgroundColor);
      if (bg && block.tagName !== 'TD' && block.tagName !== 'TH' && block.tagName !== 'PRE') props.shading = { type: D.ShadingType.CLEAR, fill: bg, color: 'auto' };
    }
    if (ctx.list) props.numbering = { reference: ctx.list.ref, level: Math.min(8, ctx.list.level) };
    if (block?.tagName === 'LI' && block.parentElement?.tagName === 'OL' && !ctx.list) { /* nested in checklist etc. */ }

    const out = [];
    parts.forEach((runs, i) => {
      if (i > 0) out.push(new D.Paragraph({ children: [new D.PageBreak()] }));
      let children = runs;
      if (ctx.checklist !== undefined && i === 0) children = [new D.TextRun({ text: ctx.checklist ? '☑ ' : '☐ ' }), ...runs];
      out.push(new D.Paragraph({ ...props, children }));
    });
    return out;
  }

  // ---------------------------------------------------------------- inline

  runFormat(textParent, base, block) {
    const D = this.D;
    const cs = getComputedStyle(textParent);
    const o = {};
    const bold = Number(cs.fontWeight) >= 600;
    if (bold !== base.bold) o.bold = bold;
    const italic = cs.fontStyle !== 'normal';
    if (italic !== base.italic) o.italics = italic;
    const fam = firstFamily(cs.fontFamily);
    if (fam && fam !== base.family) o.font = fam;
    const size = ptOf(cs.fontSize);
    if (Math.abs(size - base.size) > 0.25) o.size = Math.round(size * 2);
    const color = hex6(cs.color);
    if (color && color !== base.color) o.color = color;
    if (cs.textTransform === 'uppercase' && !base.upper) o.allCaps = true;
    if (cs.fontVariantCaps === 'small-caps') o.smallCaps = true;
    // non-inherited properties: walk up to the block
    let underline = false, strike = false, bg = null, sup = false, sub = false;
    for (let el = textParent; el && el !== block && el !== this.ed.body; el = el.parentElement) {
      const s = getComputedStyle(el);
      const deco = s.textDecorationLine || '';
      if (deco.includes('underline') && el.tagName !== 'A') underline = true;
      if (deco.includes('line-through')) strike = true;
      if (!bg) bg = hex6(s.backgroundColor);
      if (el.tagName === 'SUP' || s.verticalAlign === 'super') sup = true;
      if (el.tagName === 'SUB' || s.verticalAlign === 'sub') sub = true;
    }
    if (underline) o.underline = { type: D.UnderlineType.SINGLE };
    if (strike) o.strike = true;
    if (bg) o.shading = { type: D.ShadingType.CLEAR, fill: bg, color: 'auto' };
    if (sup) { o.superScript = true; delete o.size; }
    if (sub) { o.subScript = true; delete o.size; }
    return o;
  }

  async inline(nodes, base, block, parts, inherited) {
    const D = this.D;
    const cur = () => parts[parts.length - 1];
    const lastMeaningful = (() => {
      // ignore Chrome's trailing <br> placeholder
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.nodeType === 3 && !n.data.length) continue;
        return n;
      }
      return null;
    })();
    for (const n of nodes) {
      if (n.nodeType === 3) {
        const text = n.data.replace(/​/g, '');
        if (!text) continue;
        const fmt = { ...this.runFormat(n.parentElement, base, block), ...inherited };
        const pieces = text.split(/(\t|\n)/);
        const children = [];
        for (const p of pieces) {
          if (p === '\t') children.push(new D.Tab());
          else if (p === '\n') { if (children.length) { cur().push(new D.TextRun({ ...fmt, children: children.splice(0) })); } cur().push(new D.TextRun({ break: 1 })); }
          else if (p) children.push(p);
        }
        if (children.length) cur().push(new D.TextRun({ ...fmt, children }));
        continue;
      }
      if (n.nodeType !== 1) continue;
      const t = n.tagName;
      if (t === 'BR') {
        if (n === lastMeaningful && n.parentElement === block) continue;
        cur().push(new D.TextRun({ break: 1 }));
        continue;
      }
      if (n.classList?.contains('page-break')) { parts.push([]); continue; }
      if (t === 'IMG') { const img = await this.image(n); if (img) cur().push(img); continue; }
      if (t === 'A' && n.getAttribute('href') && !n.getAttribute('href').startsWith('#')) {
        const inner = [[]];
        await this.inline(Array.from(n.childNodes), base, block, inner, { style: 'Hyperlink' });
        const runs = inner.flat();
        if (runs.length) cur().push(new D.ExternalHyperlink({ link: n.getAttribute('href'), children: runs }));
        continue;
      }
      if (this.isBlock(n)) {
        // block inside an inline context (e.g. <div> inside <li>) → soft break
        if (cur().length) cur().push(new D.TextRun({ break: 1 }));
        await this.inline(Array.from(n.childNodes), base, block, parts, inherited);
        continue;
      }
      await this.inline(Array.from(n.childNodes), base, block, parts, inherited);
    }
  }

  async image(img) {
    const D = this.D;
    let data = null;
    let type = 'png';
    const src = img.getAttribute('src') || '';
    try {
      if (src.startsWith('data:')) {
        const r = dataURLToBytes(src);
        data = r.bytes;
        type = /jpe?g/.test(r.mime) ? 'jpg' : /png/.test(r.mime) ? 'png' : /gif/.test(r.mime) ? 'gif' : /bmp/.test(r.mime) ? 'bmp' : null;
      } else {
        const res = await fetch(src);
        const blob = await res.blob();
        data = new Uint8Array(await blob.arrayBuffer());
        type = /jpe?g/.test(blob.type) ? 'jpg' : /png/.test(blob.type) ? 'png' : /gif/.test(blob.type) ? 'gif' : null;
      }
      if (!type) { data = await toPng(img); type = 'png'; }
    } catch {
      try { data = await toPng(img); type = 'png'; } catch { return null; }
    }
    if (!data) return null;
    const w = Math.max(1, Math.round(img.offsetWidth || img.naturalWidth || 100));
    const hgt = Math.max(1, Math.round(img.offsetHeight || img.naturalHeight || 100));
    const opts = { type, data, transformation: { width: w, height: hgt }, altText: img.alt ? { name: 'image', description: img.alt, title: img.alt } : undefined };
    if (img.classList.contains('float-left') || img.classList.contains('float-right')) {
      opts.floating = {
        horizontalPosition: { relative: D.HorizontalPositionRelativeFrom.COLUMN, align: img.classList.contains('float-left') ? D.HorizontalPositionAlign.LEFT : D.HorizontalPositionAlign.RIGHT },
        verticalPosition: { relative: D.VerticalPositionRelativeFrom.PARAGRAPH, offset: 0 },
        wrap: { type: D.TextWrappingType.SQUARE, side: D.TextWrappingSide.BOTH_SIDES },
        margins: { left: 114300, right: 114300, top: 0, bottom: 57150 },
      };
    }
    return new D.ImageRun(opts);
  }

  // ---------------------------------------------------------------- tables

  async table(tableEl) {
    const D = this.D;
    const rows = Array.from(tableEl.rows);
    const plain = tableEl.classList.contains('plain');
    const totalPx = tableEl.offsetWidth || this.ed.body.clientWidth;
    // column widths from the widest row without spans
    let ncols = 0;
    for (const r of rows) ncols = Math.max(ncols, Array.from(r.cells).reduce((a, c) => a + (c.colSpan || 1), 0));
    let widths = null;
    const simple = rows.find((r) => r.cells.length === ncols);
    if (simple) widths = Array.from(simple.cells).map((c) => Math.max(200, Math.round(c.offsetWidth * PX_TW)));
    else widths = Array(ncols).fill(Math.round((totalPx * PX_TW) / Math.max(1, ncols)));
    const none = { style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const line = { style: D.BorderStyle.SINGLE, size: 4, color: 'B9B3C6' };
    const b = plain ? none : line;
    const trs = [];
    for (const [ri, r] of rows.entries()) {
      const cells = [];
      let col = 0;
      for (const c of Array.from(r.cells)) {
        const span = c.colSpan || 1;
        const kids = await this.blocks(c, {});
        const cs = getComputedStyle(c);
        const bg = hex6(cs.backgroundColor);
        const w = widths.slice(col, col + span).reduce((a, x) => a + x, 0);
        cells.push(new D.TableCell({
          children: kids.length ? kids : [new D.Paragraph({})],
          columnSpan: span > 1 ? span : undefined,
          rowSpan: c.rowSpan > 1 ? c.rowSpan : undefined,
          shading: bg ? { type: D.ShadingType.CLEAR, fill: bg, color: 'auto' } : undefined,
          verticalAlign: cs.verticalAlign === 'middle' ? D.VerticalAlign.CENTER : cs.verticalAlign === 'bottom' ? D.VerticalAlign.BOTTOM : D.VerticalAlign.TOP,
          width: { size: w, type: D.WidthType.DXA },
          margins: { top: 60, bottom: 60, left: 90, right: 90 },
        }));
        col += span;
      }
      if (cells.length) trs.push(new D.TableRow({ children: cells, tableHeader: ri === 0 && r.cells[0]?.tagName === 'TH' }));
    }
    return new D.Table({
      rows: trs,
      width: { size: widths.reduce((a, x) => a + x, 0), type: D.WidthType.DXA },
      columnWidths: widths,
      borders: { top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b },
    });
  }
}

async function toPng(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width || 1;
  c.height = img.naturalHeight || img.height || 1;
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export { docContentCss };
