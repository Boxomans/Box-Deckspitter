// Builds the output PDF with pdf-lib: page order/rotation, annotations, form values.
// Falls back to a flattened (rasterized) export for encrypted PDFs pdf-lib can't rewrite.

import { vendor, dataURLToBytes } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { totalRotation, rawToDisp, dispToRaw, boxRawToDisp, displaySize, hexToRgb01, inkPath, PDF_FONTS } from './geometry.js';

const STD = {
  Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

class FontCache {
  constructor(doc, L, fontkit) { this.doc = doc; this.L = L; this.fontkit = fontkit; this.map = new Map(); this.registered = false; }

  async get(family, bold, italic) {
    const key = `${family}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
    if (this.map.has(key)) return this.map.get(key);
    let font;
    if (STD[family] || !family) {
      const names = STD[family || 'Helvetica'];
      font = await this.doc.embedFont(this.L.StandardFonts[names[(bold ? 1 : 0) + (italic ? 2 : 0)]]);
    } else {
      if (!this.registered) { this.doc.registerFontkit(this.fontkit); this.registered = true; }
      try {
        const bytes = await api.font(family, bold, italic);
        font = await this.doc.embedFont(bytes, { subset: true });
      } catch {
        font = await this.get('Helvetica', bold, italic);
      }
    }
    this.map.set(key, font);
    return font;
  }

  /** Share of the text's characters this font can draw (standard fonts are WinAnsi only). */
  coverage(font, text) {
    const cps = [...text].filter((c) => c.trim()).map((c) => c.codePointAt(0));
    if (!cps.length) return 1;
    const fk = font.embedder?.font;
    if (fk?.hasGlyphForCodePoint) return cps.filter((cp) => fk.hasGlyphForCodePoint(cp)).length / cps.length;
    let ok = 0;
    for (const cp of cps) { try { font.encodeText(String.fromCodePoint(cp)); ok++; } catch { /* missing */ } }
    return ok / cps.length;
  }

  /** Pick the first font in a fallback chain that can draw every character (or the best one). */
  async forText(family, bold, italic, text) {
    let best = null;
    let bestScore = -1;
    for (const fam of [family, 'Arial', 'Segoe UI', 'Segoe UI Symbol', 'Segoe UI Emoji', 'Calibri']) {
      let f;
      try { f = await this.get(fam, bold, italic); } catch { continue; }
      const s = this.coverage(f, text);
      if (s === 1) return f;
      if (s > bestScore) { best = f; bestScore = s; }
    }
    return best || this.get('Helvetica', bold, italic);
  }
}

export async function buildPdf(ed, { flatten = false, pages = ed.pages } = {}) {
  const L = ed.PDFLib;
  const fontkit = await vendor.fontkit();
  if (!flatten) {
    try {
      return { bytes: await vectorSave(ed, L, fontkit, pages), flattened: false };
    } catch (e) {
      if (!e.encrypted) throw e;
    }
  }
  return { bytes: await rasterSave(ed, L, fontkit, pages), flattened: true };
}

async function vectorSave(ed, L, fontkit, pages) {
  const base = ed.sources.find((s) => s.bytes && pages.some((p) => p.src === s.id)) || null;
  let out;
  try {
    out = base ? await L.PDFDocument.load(base.bytes, { updateMetadata: false }) : await L.PDFDocument.create();
  } catch (e) {
    if (/encrypt/i.test(e.message || e.name)) e.encrypted = true;
    throw e;
  }
  const outPages = out.getPages();
  const order = [];
  const used = new Set();
  const others = new Map();
  for (const pm of pages) {
    if (base && pm.src === base.id) {
      if (used.has(pm.index)) { const [cp] = await out.copyPages(out, [pm.index]); order.push(cp); }
      else { used.add(pm.index); order.push(outPages[pm.index]); }
    } else if (pm.src === 'blank') {
      order.push({ blank: true, w: pm.w, h: pm.h });
    } else {
      const src = ed.sources.find((s) => s.id === pm.src);
      let d = others.get(src.id);
      if (!d) {
        try { d = await L.PDFDocument.load(src.bytes, { updateMetadata: false }); }
        catch (e) { if (/encrypt/i.test(e.message || e.name)) e.encrypted = true; throw e; }
        others.set(src.id, d);
      }
      const [cp] = await out.copyPages(d, [pm.index]);
      order.push(cp);
    }
  }
  for (let i = out.getPageCount() - 1; i >= 0; i--) out.removePage(i);
  const finals = order.map((p) => (p.blank ? out.addPage([p.w, p.h]) : out.addPage(p)));

  const fonts = new FontCache(out, L, fontkit);
  const images = new Map();
  for (let i = 0; i < pages.length; i++) {
    const pm = pages[i];
    const page = finals[i];
    const r = totalRotation(pm);
    page.setRotation(L.degrees(r));
    const view = pm.view || [0, 0, pm.w, pm.h];
    await drawAnnots(page, pm, { map: (x, y) => [view[0] + x, view[3] - y], angleOffset: 0 }, L, out, fonts, images, ed);
  }

  if (ed.fields?.length && ed.formDirty && base) await applyForm(ed, out, fonts);
  out.setProducer('Box-Deckspitter');
  out.setModificationDate(new Date());
  return out.save({ useObjectStreams: true });
}

async function applyForm(ed, out, fonts) {
  let form;
  try { form = out.getForm(); } catch { return; }
  for (const f of ed.fields) {
    if (!(f.name in ed.formValues)) continue;
    const v = ed.formValues[f.name];
    try {
      if (f.type === 'text') form.getTextField(f.name).setText(v == null ? '' : String(v));
      else if (f.type === 'check') { const cb = form.getCheckBox(f.name); v ? cb.check() : cb.uncheck(); }
      else if (f.type === 'dropdown') { if (v) form.getDropdown(f.name).select(v); else form.getDropdown(f.name).clear(); }
      else if (f.type === 'list') { if (v) form.getOptionList(f.name).select(v); }
      else if (f.type === 'radio') { if (v) form.getRadioGroup(f.name).select(v); }
    } catch (e) { console.warn('form field', f.name, e); }
  }
  try {
    form.updateFieldAppearances(await fonts.get('Helvetica'));
  } catch {
    try { form.updateFieldAppearances(await fonts.get('Arial')); } catch (e) { console.warn('appearances', e); }
  }
}

async function rasterSave(ed, L, fontkit, pages) {
  const out = await L.PDFDocument.create();
  const fonts = new FontCache(out, L, fontkit);
  const images = new Map();
  for (const pm of pages) {
    const { w: Wd, h: Hd } = displaySize(pm);
    const r = totalRotation(pm);
    const page = out.addPage([Wd, Hd]);
    if (pm.src !== 'blank') {
      const canvas = await ed.renderToCanvas(pm, 2.2);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
      const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      page.drawImage(img, { x: 0, y: 0, width: Wd, height: Hd });
    }
    const map = (x, y) => { const [u, v] = rawToDisp(x, y, pm.w, pm.h, r); return [u, Hd - v]; };
    await drawAnnots(page, pm, { map, angleOffset: -r }, L, out, fonts, images, ed);
  }
  out.setProducer('Box-Deckspitter');
  return out.save();
}

function rectFrom(map, b) {
  const [x1, y1] = map(b.x, b.y);
  const [x2, y2] = map(b.x + b.w, b.y + b.h);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

async function drawAnnots(page, pm, { map, angleOffset }, L, doc, fonts, images, ed) {
  const col = (hex) => { const [r, g, b] = hexToRgb01(hex); return L.rgb(r, g, b); };
  const W = pm.w;
  const H = pm.h;
  for (const a of pm.annots || []) {
    const opacity = a.opacity ?? 1;
    switch (a.type) {
      case 'highlight':
        page.drawRectangle({ ...rectFrom(map, a), color: col(a.color || '#ffd54f'), opacity: a.opacity ?? 0.4, blendMode: L.BlendMode.Multiply });
        break;
      case 'whiteout':
        page.drawRectangle({ ...rectFrom(map, a), color: col(a.color || '#ffffff'), opacity: 1 });
        break;
      case 'rect': {
        const o = { ...rectFrom(map, a), borderWidth: a.width ?? 2, borderColor: col(a.stroke || '#e53935'), borderOpacity: opacity };
        if (a.fill) { o.color = col(a.fill); o.opacity = opacity; }
        page.drawRectangle(o);
        break;
      }
      case 'ellipse': {
        const r = rectFrom(map, a);
        const o = { x: r.x + r.width / 2, y: r.y + r.height / 2, xScale: r.width / 2, yScale: r.height / 2, borderWidth: a.width ?? 2, borderColor: col(a.stroke || '#e53935'), borderOpacity: opacity };
        if (a.fill) { o.color = col(a.fill); o.opacity = opacity; }
        page.drawEllipse(o);
        break;
      }
      case 'line': case 'arrow': {
        const [x1, y1] = map(a.x1, a.y1);
        const [x2, y2] = map(a.x2, a.y2);
        const thickness = a.width ?? 2;
        const color = col(a.stroke || '#e53935');
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color, opacity, lineCap: L.LineCapStyle.Round });
        if (a.type === 'arrow') {
          const ang = Math.atan2(y2 - y1, x2 - x1);
          const len = Math.max(8, thickness * 4);
          for (const s of [-1, 1]) {
            const t = ang + Math.PI + s * 0.45;
            page.drawLine({ start: { x: x2, y: y2 }, end: { x: x2 + Math.cos(t) * len, y: y2 + Math.sin(t) * len }, thickness, color, opacity, lineCap: L.LineCapStyle.Round });
          }
        }
        break;
      }
      case 'ink': {
        if (!a.points?.length) break;
        const d = inkPath(a.points, (p) => { const [x, y] = map(p[0], p[1]); return [x, -y]; });
        page.drawSvgPath(d, { x: 0, y: 0, borderColor: col(a.stroke || '#1e88e5'), borderWidth: a.width ?? 2, borderOpacity: opacity, borderLineCap: L.LineCapStyle.Round });
        break;
      }
      case 'text': {
        if (a.cover) page.drawRectangle({ ...rectFrom(map, a.cover), color: col(a.bg || '#ffffff'), opacity: 1 });
        const text = (a.text || '').replace(/\r/g, '');
        if (!text.trim()) break;
        const rot = a.rot || 0;
        const size = a.size || 12;
        const lh = size * 1.2;
        const pad = 2;
        const box = boxRawToDisp(a, W, H, rot); // the text's own upright frame
        const lines = text.split('\n');
        const font = await fonts.forText(a.font || 'Helvetica', !!a.bold, !!a.italic, text);
        const angle = (((rot + angleOffset) % 360) + 360) % 360;
        lines.forEach((line, i) => {
          if (!line) return;
          let fx = box.x + pad;
          if (a.align === 'center' || a.align === 'right') {
            const w = font.widthOfTextAtSize(line, size);
            fx = a.align === 'center' ? box.x + (box.w - w) / 2 : box.x + box.w - pad - w;
          }
          const fy = box.y + pad + i * lh + size * 0.94;
          const [rx, ry] = dispToRaw(fx, fy, W, H, rot);
          const [px, py] = map(rx, ry);
          page.drawText(line, { x: px, y: py, size, font, color: col(a.color || '#111111'), rotate: L.degrees(angle), opacity });
        });
        break;
      }
      case 'image': {
        const asset = ed.assets.get(a.asset);
        if (!asset) break;
        let img = images.get(a.asset);
        if (!img) {
          img = asset.type === 'jpg' ? await doc.embedJpg(asset.bytes) : await doc.embedPng(asset.bytes);
          images.set(a.asset, img);
        }
        const rot = a.rot || 0;
        const box = boxRawToDisp(a, W, H, rot);
        const [rx, ry] = dispToRaw(box.x, box.y + box.h, W, H, rot);
        const [px, py] = map(rx, ry);
        const angle = (((rot + angleOffset) % 360) + 360) % 360;
        page.drawImage(img, { x: px, y: py, width: box.w, height: box.h, rotate: L.degrees(angle), opacity });
        break;
      }
      default: break;
    }
  }
}

/** Make an image asset from a data URL (converting non-PNG/JPEG formats to PNG). */
export async function assetFromDataUrl(url) {
  let d = dataURLToBytes(url);
  let type = /jpe?g/.test(d.mime) ? 'jpg' : /png/.test(d.mime) ? 'png' : null;
  const img = new Image();
  img.src = url;
  await img.decode();
  if (!type) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    d = { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' };
    type = 'png';
    url = c.toDataURL('image/png');
  }
  return { bytes: d.bytes, type, url, w: img.naturalWidth, h: img.naturalHeight };
}
