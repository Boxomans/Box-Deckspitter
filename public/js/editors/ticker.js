// BoxTicker: the NASDAQ Composite and the S&P 500, plus any ticker you search for (kept as cards next to them).
// Prices, charts and search come from Yahoo Finance's public feeds (through the local server, no key); the day's
// numbers refresh every 30 seconds while the tab is open.

import { BaseEditor } from './base.js';
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';

const INDEXES = [
  { sym: '^IXIC', name: 'NASDAQ Composite', short: 'NASDAQ' },
  { sym: '^GSPC', name: 'S&P 500', short: 'S&P 500' },
];
const RANGES = [['1d', '1D'], ['5d', '5D'], ['1mo', '1M'], ['6mo', '6M'], ['ytd', 'YTD'], ['1y', '1Y'], ['5y', '5Y'], ['max', 'Max']];
const REFRESH = 30000;
const SESSION = 6.5 * 3600e3; // a regular US trading day (the feed gives each market's own)
const MAX_WATCH = 12;
const PALETTE = ['--accent', '--accent-3', '--accent-2', '#f0c27a', '#7aa8ff', '#ff7ac6', '#9be37a', '#e8743b', '#c9a0ff', '#5fd3c6', '#ffd36b', '#ff8f8f', '#8fb3ff', '#d6d6d6'];

const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const signed = (v, d = 2) => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${num(Math.abs(v), d)}`);
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
/** A % for the axis and its tags: +12.34%, or +503K% when it's huge. */
const pctTxt = (v, d = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v) >= 10000 ? compact.format(Math.abs(v)) : num(Math.abs(v), d)}%`;
/** A price for the axis and its tags, shortened past a million. */
const priceTxt = (v) => (Math.abs(v) >= 1e6 ? compact.format(v) : num(v, Math.abs(v) >= 10000 ? 0 : Math.abs(v) < 1 ? 4 : 2));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Round-number steps for an axis from lo to hi, about n of them. */
function ticks(lo, hi, n = 5) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

export class TickerEditor extends BaseEditor {
  static mode = 'ticker';

  async load() {
    const saved = this.app.settings.ticker || {};
    this.watch = (saved.watch || []).slice(0, MAX_WATCH); // [{ sym, name }] you added from search
    this.view = this.items().some((i) => i.sym === saved.view) ? saved.view : 'both'; // 'both' (compared in %) or one symbol
    this.range = RANGES.some(([r]) => r === saved.range) ? saved.range : '1d';
    this.day = {}; // symbol → today's chart (cards)
    this.data = {}; // symbol → the chart for this.range
    this.hover = null;
    this.seq = 0; // the latest search, so a slow answer can't replace a newer one

    this.cards = h('div', { class: 'tk-cards' });
    this.rangeBar = h('div', { class: 'tk-ranges' });
    this.viewBar = h('div', { class: 'tk-views' });
    this.canvas = h('canvas', { class: 'tk-canvas' });
    this.tip = h('div', { class: 'tk-tip', hidden: true });
    this.legend = h('div', { class: 'tk-legend' });
    this.stats = h('div', { class: 'tk-stats' });
    this.note = h('div', { class: 'tk-note faint' });
    this.chartBox = h('div', { class: 'tk-chart' }, this.canvas, this.tip);
    this.searchIn = h('input', { type: 'search', class: 'tk-search-in', placeholder: 'Search a ticker or company: AAPL, Toyota, bitcoin, gold…', spellcheck: false, autocomplete: 'off' });
    this.results = h('div', { class: 'tk-results', hidden: true });
    this.wireSearch();
    this.root = h('div', { class: 'sp-root tk-root' }, h('div', { class: 'sp-inner tk-inner' },
      h('div', { class: 'sp-head' },
        h('div', { class: 'klep-title' }, h('span', { class: 'g tk-g' }, this.app.toolLabel('BoxTicker')), h('span', { class: 'klep-cursor' })),
        h('div', { class: 'klep-sub mono' }, '> NASDAQ · S&P 500 · any ticker · from Yahoo Finance, every 30 s'),
        h('div', { class: 'tk-search' }, icon('search', 'sm'), this.searchIn, this.results)),
      this.cards,
      h('div', { class: 'tk-board' },
        h('div', { class: 'row tk-bar' }, this.viewBar, h('div', { class: 'grow' }), this.rangeBar,
          h('button', { class: 'icon-btn', 'data-tip': 'Refresh now', onclick: () => this.refresh(true) }, icon('refresh', 'sm'))),
        this.legend, this.chartBox, this.stats),
      this.note));
    this.pane.append(this.root);

    this.canvas.addEventListener('pointermove', (e) => { const r = this.canvas.getBoundingClientRect(); this.hover = { x: e.clientX - r.left, y: e.clientY - r.top }; this.draw(); });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.chartBox);

    this.renderBars();
    await this.refresh(true);
    this.timer = setInterval(() => { if (!this.hidden) this.refresh(); }, REFRESH);
  }

  save() { this.app.saveSettings({ ticker: { view: this.view, range: this.range, watch: this.watch } }); }

  /** The two indexes, then what you added. */
  items() { return [...INDEXES, ...this.watch.map((w) => ({ sym: w.sym, name: w.name || w.sym, short: w.sym, mine: true }))]; }

  // ---- search

  wireSearch() {
    let t = 0;
    this.searchIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => this.search(this.searchIn.value), 250); });
    this.searchIn.addEventListener('keydown', (e) => {
      const rows = [...this.results.children].filter((r) => r._r);
      const at = rows.findIndex((r) => r.classList.contains('on'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!rows.length) return;
        const n = (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        rows.forEach((r, i) => r.classList.toggle('on', i === n));
        rows[n].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const r = rows[Math.max(0, at)]?._r;
        if (r) this.pick(r);
        else if (this.searchIn.value.trim()) { clearTimeout(t); this.search(this.searchIn.value, true); }
      } else if (e.key === 'Escape') { this.results.hidden = true; this.searchIn.blur(); }
    });
    this.searchIn.addEventListener('focus', () => { if (this.results.children.length && this.searchIn.value.trim()) this.results.hidden = false; });
    this.searchIn.addEventListener('blur', () => setTimeout(() => { this.results.hidden = true; }, 150));
  }

  async search(q, pickFirst = false) {
    q = q.trim();
    const my = ++this.seq;
    if (!q) { clear(this.results); this.results.hidden = true; return; }
    let list;
    try { list = await api.marketSearch(q); } catch (e) { list = e; }
    if (my !== this.seq) return;
    clear(this.results);
    if (list instanceof Error) this.results.append(h('div', { class: 'tk-res-note faint' }, list.message));
    else if (!list.length) this.results.append(h('div', { class: 'tk-res-note faint' }, `Nothing found for “${q}”`));
    else {
      if (pickFirst) { this.pick(list[0]); return; }
      const have = new Set(this.items().map((i) => i.sym));
      list.forEach((r, i) => {
        const row = h('button', { class: `tk-res ${i === 0 ? 'on' : ''}`, onmousedown: (e) => e.preventDefault(), onclick: () => this.pick(r) },
          h('span', { class: 'tk-res-sym mono' }, r.symbol),
          h('span', { class: 'tk-res-name' }, r.name),
          h('span', { class: 'tk-res-meta faint' }, have.has(r.symbol) ? 'on the board' : [r.exchange, r.type].filter(Boolean).join(' · ')));
        row._r = r;
        this.results.append(row);
      });
    }
    this.results.hidden = document.activeElement !== this.searchIn;
  }

  /** A search result: chart it, and keep it as a card. */
  pick(r) {
    this.searchIn.value = '';
    clear(this.results);
    this.results.hidden = true;
    if (!this.items().some((i) => i.sym === r.symbol)) {
      if (this.watch.length >= MAX_WATCH) this.watch.shift();
      this.watch.push({ sym: r.symbol, name: r.name });
    }
    this.setView(r.symbol);
    this.refresh(true);
  }

  remove(sym) {
    this.watch = this.watch.filter((w) => w.sym !== sym);
    delete this.day[sym];
    delete this.data[sym];
    if (this.view === sym) this.view = 'both';
    this.setView(this.view);
  }

  // ---- data

  async refresh(all = false) {
    const ask = (sym, range) => api.market(sym, range).then((d) => d, (e) => ({ error: e.message }));
    const jobs = this.items().map(async ({ sym }) => {
      const d = await ask(sym, '1d');
      if (!d.error || !this.day[sym]) this.day[sym] = d;
      if (this.range === '1d') this.data[sym] = this.day[sym];
      else if (all || !this.data[sym] || this.data[sym].error) { const r = await ask(sym, this.range); if (!r.error || !this.data[sym]) this.data[sym] = r; }
    });
    await Promise.all(jobs);
    this.when = new Date();
    this.renderCards();
    this.renderStats();
    this.draw();
    this.refreshStatus();
  }

  setRange(r) {
    if (r === this.range) return;
    this.range = r;
    this.data = {};
    this.save();
    this.renderBars();
    this.draw();
    this.refresh(true);
  }

  setView(v) {
    this.view = v;
    this.save();
    this.renderBars();
    this.renderCards();
    this.renderStats();
    this.draw();
  }

  // ---- the board

  renderBars() {
    clear(this.rangeBar).append(...RANGES.map(([r, label]) =>
      h('button', { class: `tk-chip ${r === this.range ? 'on' : ''}`, onclick: () => this.setRange(r) }, label)));
    clear(this.viewBar).append(...[['both', 'Compare'], ...this.items().map((i) => [i.sym, i.short])].map(([v, label]) =>
      h('button', { class: `tk-chip ${v === this.view ? 'on' : ''}`, onclick: () => this.setView(v) }, label)));
  }

  renderCards() {
    clear(this.cards);
    this.items().forEach((ix, n) => {
      const d = this.day[ix.sym];
      const ch = d && !d.error ? d.price - d.prevClose : null;
      const pct = ch != null && d.prevClose ? (ch / d.prevClose) * 100 : null;
      const dir = ch == null ? '' : ch >= 0 ? 'up' : 'down';
      const spark = h('canvas', { class: 'tk-spark' });
      const card = h('button', { class: `tk-card ${dir} ${this.view === ix.sym ? 'on' : ''}`, title: `Chart ${ix.name} on its own`, onclick: () => this.setView(this.view === ix.sym ? 'both' : ix.sym) },
        h('div', { class: 'tk-card-top' }, h('span', { class: 'tk-dot', style: { background: this.colorOf(n) } }),
          h('span', { class: 'tk-name', title: ix.name }, ix.mine ? h('b', { class: 'mono' }, ix.sym, ' ') : null, ix.name),
          h('span', { class: `tk-state ${d?.state || ''}` }, d?.error ? 'offline' : stateLabel(d?.state)),
          ix.mine ? h('span', { class: 'icon-btn tk-x', role: 'button', 'data-tip': 'Take off the board', onclick: (e) => { e.stopPropagation(); this.remove(ix.sym); } }, icon('x', 'sm')) : null),
        h('div', { class: 'tk-price mono' }, d?.error ? '—' : num(d?.price, d?.price < 1 ? 4 : 2), d?.currency && d.currency !== 'USD' && !d.error ? h('span', { class: 'tk-cur' }, d.currency) : null),
        h('div', { class: `tk-change mono ${dir}` }, d?.error ? d.error : `${ch == null ? '' : ch >= 0 ? '▲' : '▼'} ${signed(ch)}  (${signed(pct)}%)`),
        spark);
      this.cards.append(card);
      requestAnimationFrame(() => this.drawSpark(spark, d));
    });
  }

  renderStats() {
    clear(this.stats);
    const one = this.view !== 'both' ? this.day[this.view] : null;
    const cell = (k, v) => h('div', { class: 'tk-stat' }, h('span', { class: 'faint' }, k), h('span', { class: 'mono' }, v));
    if (one && !one.error) {
      this.stats.append(
        cell('Previous close', num(one.prevClose)),
        cell('Day range', `${num(one.dayLow)} – ${num(one.dayHigh)}`),
        cell('52-week range', `${num(one.low52)} – ${num(one.high52)}`),
        cell('Last price', `${num(one.price)} · ${this.fmtTime(one.time, one.tz, true)}`));
    } else {
      for (const ix of this.items()) {
        const d = this.day[ix.sym];
        if (d && !d.error) this.stats.append(cell(ix.short, `${num(d.dayLow)} – ${num(d.dayHigh)} today · 52 wk ${num(d.low52, 0)} – ${num(d.high52, 0)}`));
      }
    }
    const any = Object.values(this.day).find((d) => d && !d.error);
    clear(this.note).append(icon('info', 'sm'), h('span', {}, any
      ? `${stateLine(any)} · Index values can lag up to 15 minutes. Updated ${this.when?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) || ''}.`
      : 'Couldn’t get prices. Check the internet connection; it tries again every 30 seconds.'));
  }

  colorOf(n) { const c = PALETTE[n % PALETTE.length]; return c.startsWith('--') ? css(c) || '#b48cff' : c; }

  fmtTime(t, tz, withDate) {
    const o = { timeZone: tz || 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
    if (withDate) Object.assign(o, { month: 'short', day: 'numeric' });
    try { return new Date(t).toLocaleString([], o); } catch { return new Date(t).toLocaleString(); }
  }

  fmtX(t, tz) {
    const zone = tz || 'America/New_York';
    const r = this.range;
    const o = r === '1d' ? { hour: 'numeric', minute: '2-digit' }
      : r === '5d' ? { weekday: 'short', hour: 'numeric' }
      : r === '1mo' || r === '6mo' || r === 'ytd' ? { month: 'short', day: 'numeric' }
      : r === '1y' || r === '5y' ? { month: 'short', year: '2-digit' }
      : { year: 'numeric' };
    try { return new Date(t).toLocaleString([], { ...o, timeZone: zone }); } catch { return new Date(t).toLocaleDateString(); }
  }

  // ---- drawing

  drawSpark(cv, d) {
    if (!cv.isConnected) return;
    const w = cv.clientWidth, hgt = cv.clientHeight, dpr = devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = hgt * dpr;
    const c = cv.getContext('2d');
    c.scale(dpr, dpr);
    const pts = d?.points;
    if (!pts?.length) return;
    const t0 = pts[0][0], t1 = Math.max(t0 + (d.session || SESSION), pts[pts.length - 1][0]);
    const vals = pts.map((p) => p[1]).concat(d.prevClose ?? []);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const X = (t) => ((t - t0) / (t1 - t0)) * w, Y = (v) => hgt - 2 - ((v - lo) / (hi - lo || 1)) * (hgt - 4);
    const up = d.price >= d.prevClose;
    if (d.prevClose != null) { c.strokeStyle = css('--text-3'); c.setLineDash([2, 3]); c.lineWidth = 1; c.beginPath(); c.moveTo(0, Y(d.prevClose)); c.lineTo(w, Y(d.prevClose)); c.stroke(); c.setLineDash([]); }
    c.strokeStyle = up ? css('--ok') : css('--danger');
    c.lineWidth = 1.5;
    c.beginPath();
    pts.forEach(([t, v], i) => (i ? c.lineTo(X(t), Y(v)) : c.moveTo(X(t), Y(v))));
    c.stroke();
  }

  /** The lines to draw: [{ix, n, d, pts: [[t, v]], base}] — in % from the start when comparing. */
  series() {
    const raw = [];
    this.items().forEach((ix, n) => {
      if (this.view !== 'both' && this.view !== ix.sym) return;
      const d = this.data[ix.sym];
      if (d && !d.error && d.points?.length) raw.push({ ix, n, d });
    });
    if (this.view !== 'both') return raw.map((s) => ({ ...s, pts: s.d.points, base: s.d.base ?? s.d.points[0][1] }));
    // comparing: everyone starts on the same day (the latest first day among them, say a later IPO), and counts % from there
    const start = Math.max(...raw.map((s) => s.d.points[0][0]));
    const same = raw.every((s) => start - s.d.points[0][0] < 7 * 864e5);
    return raw.map((s) => {
      const kept = same ? s.d.points : s.d.points.filter(([t]) => t >= start);
      const base = (same || this.range === '1d') && s.d.base != null ? s.d.base : kept[0][1];
      return { ...s, pts: kept.map(([t, v]) => [t, ((v - base) / base) * 100]), base: 0 };
    }).filter((s) => s.pts.length);
  }

  draw() {
    const cv = this.canvas;
    const W = this.chartBox.clientWidth, H = this.chartBox.clientHeight;
    if (!W || !H) return;
    const dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const list = this.series();
    const pct = this.view === 'both';
    clear(this.legend);
    if (pct) this.legend.append(...this.items().map((ix, n) => h('span', { class: 'tk-key' }, h('span', { class: 'tk-dot', style: { background: this.colorOf(n) } }), `${ix.short} · % change`)));
    this.tip.hidden = true;
    if (!list.length) {
      c.fillStyle = css('--text-3'); c.font = `13px ${css('--font-mono') || 'monospace'}`; c.textAlign = 'center';
      c.fillText(Object.values(this.data).some((d) => d?.error) ? 'No prices right now' : 'Loading…', W / 2, H / 2);
      return;
    }
    const L = 8, R = 72, T = 12, B = 26;
    const pw = W - L - R, ph = H - T - B;
    // x: real time, the same clock for every line. 1D runs across the whole session (the line fills in as it goes);
    // 5D and 1M step through the bars instead, shared by all the lines, so nights and weekends don't leave gaps.
    const intraday = this.range === '1d';
    const stepped = this.range === '5d' || this.range === '1mo';
    const first = list[0];
    const t0 = Math.min(...list.map((s) => s.pts[0][0]));
    const tEnd = Math.max(...list.map((s) => s.pts[s.pts.length - 1][0]));
    const t1 = intraday ? Math.max(t0 + (first.d.session || SESSION), tEnd) : Math.max(tEnd, t0 + 1);
    const axis = stepped ? [...new Set(list.flatMap((s) => s.pts.map((p) => p[0])))].sort((a, b) => a - b) : null;
    const slot = axis && new Map(axis.map((t, i) => [t, i]));
    const xT = (t) => L + (axis ? (axis.length > 1 ? (slot.get(t) / (axis.length - 1)) * pw : pw / 2) : ((t - t0) / (t1 - t0)) * pw);
    const xOf = (s, i) => xT(s.pts[i][0]);
    let lo = Infinity, hi = -Infinity;
    for (const s of list) for (const [, v] of s.pts) { if (v < lo) lo = v; if (v > hi) hi = v; }
    for (const s of list) { lo = Math.min(lo, s.base); hi = Math.max(hi, s.base); }
    const padV = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1;
    lo -= padV; hi += padV;
    const Y = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;
    const mono = css('--font-mono') || 'monospace';

    // grid and the price axis
    c.font = `11px ${mono}`;
    c.textAlign = 'left'; c.textBaseline = 'middle';
    for (const v of ticks(lo, hi, Math.max(3, Math.round(ph / 60)))) {
      const y = Math.round(Y(v)) + 0.5;
      c.strokeStyle = css('--line'); c.lineWidth = 1;
      c.beginPath(); c.moveTo(L, y); c.lineTo(L + pw, y); c.stroke();
      c.fillStyle = css('--text-3');
      c.fillText(pct ? pctTxt(v, Math.abs(hi - lo) < 4 ? 2 : 1) : priceTxt(v), L + pw + 8, y);
    }
    // time axis: about one label per 110px
    c.textAlign = 'center'; c.textBaseline = 'top';
    const tz = first.d.tz;
    const nLab = Math.max(2, Math.floor(pw / 110));
    const label = (t, x) => { c.fillStyle = css('--text-3'); c.fillText(this.fmtX(t, tz), Math.min(Math.max(x, L + 24), L + pw - 24), T + ph + 8); };
    if (intraday) {
      // the open, then on the hour (every other hour when it's narrow)
      const step = (pw / ((t1 - t0) / 3600e3) < 80 ? 2 : 1) * 3600e3;
      const tx = (t) => L + ((t - t0) / (t1 - t0)) * pw;
      label(t0, tx(t0));
      for (let t = Math.ceil((t0 + 1) / 3600e3) * 3600e3; t <= t1; t += step) if (tx(t) - tx(t0) > 90) label(t, tx(t));
    } else if (axis) {
      for (let k = 0; k <= nLab; k++) { const t = axis[Math.round(((axis.length - 1) * k) / nLab)]; label(t, xT(t)); }
    } else {
      for (let k = 0; k <= nLab; k++) { const t = t0 + ((t1 - t0) * k) / nLab; label(t, xT(t)); }
    }
    // the baseline: previous close for one index, 0% when comparing
    const by = Math.round(Y(list[0].base)) + 0.5;
    c.strokeStyle = css('--text-3'); c.setLineDash([3, 4]); c.lineWidth = 1;
    c.beginPath(); c.moveTo(L, by); c.lineTo(L + pw, by); c.stroke(); c.setLineDash([]);

    // the lines (one index: green above where it started, red below)
    for (const s of list) {
      const last = s.pts[s.pts.length - 1][1];
      const col = pct ? this.colorOf(s.n) : last >= s.base ? css('--ok') : css('--danger');
      const path = new Path2D();
      s.pts.forEach(([, v], i) => (i ? path.lineTo(xOf(s, i), Y(v)) : path.moveTo(xOf(s, i), Y(v))));
      if (!pct) {
        const fill = new Path2D(path);
        fill.lineTo(xOf(s, s.pts.length - 1), T + ph); fill.lineTo(xOf(s, 0), T + ph); fill.closePath();
        const g = c.createLinearGradient(0, T, 0, T + ph);
        g.addColorStop(0, hexA(col, 0.28)); g.addColorStop(1, hexA(col, 0));
        c.fillStyle = g; c.fill(fill);
      }
      c.strokeStyle = col; c.lineWidth = 1.8; c.lineJoin = 'round';
      c.stroke(path);
      // the price tag on the axis
      const ly = Y(last);
      c.fillStyle = col;
      c.fillRect(L + pw + 2, ly - 9, R - 4, 18);
      c.fillStyle = css('--bg-0') || '#000'; c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText(pct ? pctTxt(last) : priceTxt(last), L + pw + 6, ly);
      if (intraday && s.d.state === 'open') { c.fillStyle = col; c.beginPath(); c.arc(xOf(s, s.pts.length - 1), ly, 3.2, 0, Math.PI * 2); c.fill(); }
    }

    // hover: a crosshair and the values under it
    const hv = this.hover;
    if (!hv || hv.x < L || hv.x > L + pw) return;
    const f = (hv.x - L) / pw;
    const at = axis ? axis[Math.round(f * (axis.length - 1))] : t0 + f * (t1 - t0);
    const near = (s) => {
      const t = at;
      let best = 0;
      for (let i = 1; i < s.pts.length; i++) if (Math.abs(s.pts[i][0] - t) < Math.abs(s.pts[best][0] - t)) best = i;
      return best;
    };
    const idx = list.map(near);
    const x = xOf(list[0], idx[0]);
    c.strokeStyle = css('--text-2'); c.lineWidth = 1; c.setLineDash([2, 3]);
    c.beginPath(); c.moveTo(Math.round(x) + 0.5, T); c.lineTo(Math.round(x) + 0.5, T + ph); c.stroke(); c.setLineDash([]);
    const rows = [];
    list.forEach((s, k) => {
      const [, v] = s.pts[idx[k]];
      const col = pct ? this.colorOf(s.n) : v >= s.base ? css('--ok') : css('--danger');
      c.fillStyle = col; c.beginPath(); c.arc(xOf(s, idx[k]), Y(v), 3.5, 0, Math.PI * 2); c.fill();
      const ch = pct ? null : v - s.base;
      rows.push(h('div', { class: 'tk-tip-row' }, h('span', { class: 'tk-dot', style: { background: col } }), h('span', {}, s.ix.short),
        h('b', { class: 'mono' }, pct ? pctTxt(v) : `${num(v)}  ${signed(ch)} (${signed((ch / s.base) * 100)}%)`)));
    });
    const t = list[0].pts[idx[0]][0];
    const when = this.range === '1d' || this.range === '5d' || this.range === '1mo' ? this.fmtTime(t, tz, this.range !== '1d')
      : new Date(t).toLocaleDateString([], { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' });
    clear(this.tip).append(h('div', { class: 'tk-tip-time faint' }, when), ...rows);
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${x + 14 + tw > W ? x - 14 - tw : x + 14}px`;
    this.tip.style.top = `${T + 4}px`;
  }

  status() {
    const d = this.day['^GSPC'];
    const left = d && !d.error ? [{ text: `S&P 500 ${num(d.price)} ${signed(((d.price - d.prevClose) / d.prevClose) * 100)}%` }] : [];
    return { left, right: [] };
  }

  onShow() { this.hidden = false; this.draw(); if (this.when && Date.now() - this.when > REFRESH) this.refresh(); }
  onHide() { this.hidden = true; }
  onThemeChange() { this.renderCards(); this.draw(); }

  destroy() {
    clearInterval(this.timer);
    this.ro?.disconnect();
  }
}

function stateLabel(s) { return { open: 'open', pre: 'pre-market', post: 'after hours', closed: 'closed' }[s] || ''; }
function stateLine(d) {
  if (d.state === 'open') return 'US market open';
  if (d.state === 'pre') return 'Pre-market (the indexes move from 9:30 AM ET)';
  if (d.state === 'post') return 'After hours: closing prices';
  return 'US market closed: last close';
}
/** A colour (#rgb, #rrggbb or rgb()) with alpha. */
function hexA(col, a) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(col);
  if (m) {
    let x = m[1];
    if (x.length === 3) x = [...x].map((ch) => ch + ch).join('');
    const n = parseInt(x, 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const r = /rgba?\(([^)]+)\)/.exec(col);
  if (r) { const [R, G, B2] = r[1].split(',').map((v) => v.trim()); return `rgba(${R}, ${G}, ${B2}, ${a})`; }
  return col;
}
