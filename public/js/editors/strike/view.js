// Deep Strike's map: a dark tactical chart of the theatre (land, sea, lakes, towns) in km, with pan and zoom.
// The game draws its own layers (sites, rings, routes, jets, missiles) on top through draw(ctx, view).

import { clipField } from './geo.js';

export const COL = {
  sea: '#0b1219', land: '#151c22', coast: '#2a3a46', edge: 'rgba(125,141,154,0.55)', lake: '#0d1820', grid: 'rgba(120,160,190,0.06)',
  town: '#6f8496', townText: 'rgba(170,190,205,0.75)', halo: 'rgba(8,12,16,0.85)',
  friend: '#5ec8ff', route: '#5ec8ff', node: '#cfeeff', enemy: '#ff5a5a', enemySoft: 'rgba(255,90,90,0.12)', medium: '#ffae42',
  short: '#ffd84a', unknown: '#8a96a3', objective: '#ff3df0', good: '#6fe08a', text: '#d7e4ee', faint: '#7d8d9a', sniffer: '#b6f36a',
};

export class MapView {
  constructor(canvas, { onDraw } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onDraw = onDraw;
    this.cx = 0; this.cy = 0; this.scale = 1; // px per km
    this.world = null;
    this.dirty = true;
    this.raf = 0;
  }
  setWorld(w) { this.world = w; this.request(); }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr); this.canvas.height = Math.round(this.h * dpr);
    this.dpr = dpr;
    this.request();
  }

  /** km → screen px, and back. */
  sx(x) { return (x - this.cx) * this.scale + this.w / 2; }
  sy(y) { return (y - this.cy) * this.scale + this.h / 2; }
  wx(px) { return (px - this.w / 2) / this.scale + this.cx; }
  wy(py) { return (py - this.h / 2) / this.scale + this.cy; }

  fit(x0, y0, x1, y1, pad = 60) {
    this.cx = (x0 + x1) / 2; this.cy = (y0 + y1) / 2;
    this.scale = Math.min((this.w - pad * 2) / Math.max(1, x1 - x0), (this.h - pad * 2) / Math.max(1, y1 - y0));
    this.request();
  }
  zoomAt(px, py, f) {
    const x = this.wx(px), y = this.wy(py);
    this.scale = Math.max(0.06, Math.min(400, this.scale * f));
    this.cx = x - (px - this.w / 2) / this.scale;
    this.cy = y - (py - this.h / 2) / this.scale;
    this.request();
  }
  pan(dx, dy) { this.cx -= dx / this.scale; this.cy -= dy / this.scale; this.request(); }

  request() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
  }

  paint() {
    const { ctx, dpr } = this;
    if (!this.w) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COL.sea;
    ctx.fillRect(0, 0, this.w, this.h);
    const w = this.world;
    if (w) {
      ctx.save();
      ctx.translate(this.w / 2, this.h / 2);
      ctx.scale(this.scale, this.scale);
      ctx.translate(-this.cx, -this.cy);
      ctx.lineWidth = 1 / this.scale;
      clipField(ctx, w); // nothing past the playing field's edge
      ctx.fillStyle = COL.land;
      ctx.fill(w.land, 'evenodd');
      ctx.fillStyle = COL.lake;
      ctx.fill(w.lakes);
      ctx.strokeStyle = COL.coast;
      ctx.stroke(w.land);
      // where the field ends on land, a faint dashed line: the excluded countries' borders and the Urals cut (the
      // clip keeps only the field's side of each line, so it's drawn twice as wide)
      ctx.clip(w.field.inland); // not all land: an excluded coast would leave a hairline along the clip's edge
      ctx.setLineDash([6 / this.scale, 5 / this.scale]);
      ctx.strokeStyle = COL.edge;
      ctx.lineWidth = 3 / this.scale;
      ctx.stroke(w.field.borders);
      ctx.stroke(w.field.outline);
      ctx.restore();
      this.paintGrid();
      this.paintTowns();
    }
    this.onDraw?.(ctx, this);
    this.paintScale();
  }

  /** A 50 km grid, faint, for judging distance. */
  paintGrid() {
    const { ctx } = this;
    const step = this.scale > 3 ? 10 : this.scale > 0.8 ? 50 : this.scale > 0.25 ? 100 : 500;
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(this.wx(0) / step) * step; x < this.wx(this.w); x += step) { const p = Math.round(this.sx(x)) + 0.5; ctx.moveTo(p, 0); ctx.lineTo(p, this.h); }
    for (let y = Math.floor(this.wy(0) / step) * step; y < this.wy(this.h); y += step) { const p = Math.round(this.sy(y)) + 0.5; ctx.moveTo(0, p); ctx.lineTo(this.w, p); }
    ctx.stroke();
  }

  paintTowns() {
    const { ctx } = this;
    const minPop = this.scale > 6 ? 0 : this.scale > 2.5 ? 15000 : this.scale > 1.2 ? 60000 : this.scale > 0.6 ? 200000 : this.scale > 0.25 ? 600000 : 1500000;
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    const taken = [];
    for (const t of this.world.places) {
      if (t.pop < minPop) continue;
      const x = this.sx(t.x), y = this.sy(t.y);
      if (x < -40 || y < -20 || x > this.w + 40 || y > this.h + 20) continue;
      const tw = ctx.measureText(t.n).width;
      const box = [x + 5, y - 7, x + 9 + tw, y + 7];
      if (taken.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      taken.push(box);
      ctx.fillStyle = COL.town;
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      ctx.lineWidth = 3; ctx.strokeStyle = COL.halo; ctx.strokeText(t.n, x + 6, y);
      ctx.fillStyle = COL.townText; ctx.fillText(t.n, x + 6, y);
    }
  }

  paintScale() {
    const { ctx } = this;
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
    const km = nice.find((n) => n * this.scale >= 70) || 2000;
    const px = km * this.scale, x = 14, y = this.h - 16;
    ctx.strokeStyle = COL.faint; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 4); ctx.stroke();
    ctx.fillStyle = COL.faint; ctx.font = '10.5px ui-monospace, Consolas, monospace'; ctx.textBaseline = 'bottom';
    ctx.fillText(`${km} km`, x + 4, y - 3);
  }

  // ---- drawing helpers for the game's layers (all in km)

  circle(x, y, km, stroke, fill, dash) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(this.sx(x), this.sy(y), Math.max(0, km * this.scale), 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.setLineDash(dash || []); ctx.strokeStyle = stroke; ctx.stroke(); ctx.setLineDash([]); }
  }
  label(text, x, y, color = COL.text, { dx = 8, dy = 0, align = 'left', font = '11px ui-monospace, Consolas, monospace' } = {}) {
    const { ctx } = this;
    ctx.font = font; ctx.textAlign = align; ctx.textBaseline = 'middle';
    const px = Math.round(this.sx(x) + dx), py = Math.round(this.sy(y) + dy); // whole pixels: small text shimmers when panned otherwise
    ctx.lineWidth = 3; ctx.strokeStyle = COL.halo; ctx.strokeText(text, px, py);
    ctx.fillStyle = color; ctx.fillText(text, px, py);
    ctx.textAlign = 'left';
  }
}
