// BoxLog: every log on the PC in one place. Pick any number of sources (Windows event logs, log files from Windows,
// apps and video games, or a folder or file of your own), and they're merged into one timeline you can filter by
// words, regex, level, source, time range and more. Live mode follows the files as they grow. Read-only: BoxLog
// never changes a log.

import { BaseEditor } from './base.js';
import { h, clear, clamp, debounce, formatBytes, fileManager } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { tbButton, tbSep, toast, errorToast, showMenu, contextMenu, promptDialog } from '../core/ui.js';
import { pickOpen, pickFolder, pickSave } from '../core/files.js';

const ROW = 19;
const MAX_ENTRIES = 400000;
const LV = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
const LV_CLASS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const RANGES = [['all', 'All time', 0], ['5m', 'Last 5 minutes', 300e3], ['15m', 'Last 15 minutes', 900e3], ['1h', 'Last hour', 3600e3], ['6h', 'Last 6 hours', 6 * 3600e3], ['24h', 'Last 24 hours', 86400e3], ['7d', 'Last 7 days', 7 * 86400e3]];
const GROUPS = ['Active now', 'Games', 'Windows', 'System', 'Apps', 'Temp', 'Added', 'Event logs'];
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const ACTIVE_MS = 120000;
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`bdslog.${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`bdslog.${k}`, JSON.stringify(v)); } catch { /* private window */ } },
};

// ---------------------------------------------------------------- reading a line

const RE_ISO = /(\d{4})[-/.](\d{2})[-/.](\d{2})[T _-](\d{2})[:.](\d{2})[:.](\d{2})(?:[.,:](\d{1,6}))?\s*(Z|[+-]\d{2}:?\d{2})?/;
const RE_US = /(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2}):(\d{2})/;
const RE_SYS = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/;
const RE_TIME = /(?:^|[[\s(])(\d{2}):(\d{2}):(\d{2})(?:[.,:](\d{1,3}))?(?=[\])\s:]|$)/;
const RE_LEVEL = /\b(FATAL|CRITICAL|CRIT|SEVERE|EMERG(?:ENCY)?|ALERT|ERROR|ERR|WARN(?:ING)?|NOTICE|INFO(?:RMATION)?|DEBUG|DBG|TRACE|VERBOSE|VRB)\b/;
const RE_UNREAL = /: (Error|Warning|Fatal):/;

function parseTime(line, mtime) {
  const head = line.length > 80 ? line.slice(0, 80) : line;
  let m = RE_ISO.exec(head);
  if (m) {
    const ms = m[7] ? +(m[7] + '00').slice(0, 3) : 0;
    if (m[8]) {
      const tz = m[8] === 'Z' ? 0 : ((m[8][0] === '-' ? -1 : 1) * (+m[8].slice(1, 3) * 60 + +m[8].slice(-2)));
      return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms) - tz * 60000;
    }
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms).getTime();
  }
  m = RE_US.exec(head);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]).getTime();
  m = RE_SYS.exec(head);
  if (m) return new Date(new Date(mtime).getFullYear(), MONTHS[m[1].toLowerCase()], +m[2], +m[3], +m[4], +m[5]).getTime();
  m = RE_TIME.exec(head);
  if (m) {
    const d = new Date(mtime);
    let t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), +m[1], +m[2], +m[3], m[4] ? +(m[4] + '00').slice(0, 3) : 0).getTime();
    if (t > mtime + 3600e3) t -= 86400e3; // a clock-only time later than the file's last write was yesterday's
    return t;
  }
  return null;
}

function parseLevel(line) {
  const head = line.length > 160 ? line.slice(0, 160) : line;
  let m = RE_LEVEL.exec(head);
  if (m) {
    const w = m[1];
    if (/^(FATAL|CRIT|SEVERE|EMERG|ALERT)/.test(w)) return 5;
    if (/^ERR/.test(w)) return 4;
    if (/^WARN/.test(w)) return 3;
    if (/^(NOTICE|INFO)/.test(w)) return 2;
    if (/^(DEBUG|DBG)$/.test(w)) return 1;
    return 0;
  }
  m = RE_UNREAL.exec(head);
  if (m) return m[1] === 'Warning' ? 3 : m[1] === 'Fatal' ? 5 : 4;
  if (/\b(exception|failed|failure|fatal|crash(ed)?)\b/i.test(head)) return 4;
  if (/\bwarn(ing)?\b/i.test(head)) return 3;
  if (/\berror\b/i.test(head)) return 4;
  return -1;
}
const evLevel = (lv) => (lv === 1 ? 5 : lv === 2 ? 4 : lv === 3 ? 3 : lv === 5 ? 0 : 2);

const pad = (n, w = 2) => String(n).padStart(w, '0');
function fmtTime(t, withDate) {
  const d = new Date(t);
  return `${withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` : ''}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 90 ? 'now' : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- the editor

export class LogEditor extends BaseEditor {
  static mode = 'log';

  async load() {
    this.sources = new Map(); // key → { key, kind, label, sub, group, path, size, mtime, color, offset, on, ... }
    this.ents = [];
    this.rows = [];
    this.seq = 0;
    this.live = true;
    this.follow = true;
    this.sel = -1;
    this.tail = store.get('tail', 1024 * 1024);
    this.evHours = store.get('evHours', 24);
    this.days = store.get('days', 14);
    this.f = { q: '', regex: false, cs: false, word: false, ex: '', levels: new Set([-1, 0, 1, 2, 3, 4, 5]), range: 'all', from: 0, to: 0, ctx: 0, dedupe: false, off: new Set() };
    { const st = store.get('filters', {}); this.f = { ...this.f, ...st }; }
    this.catalog = { files: [], folders: [], logs: [], windows: /Windows/.test(navigator.userAgent) };
    this.buildUI();
    this.renderSources();
    this.renderEmpty();
    this.refreshCatalog();
    this.timer = setInterval(() => this.poll(), 1500);
  }

  // ================================================================ catalog

  async refreshCatalog(force = false) {
    this.srcStatus.textContent = 'Looking for logs…';
    try {
      const [s, e] = await Promise.all([
        api.get(`/api/log/sources?days=${this.days}${force ? '&refresh=1' : ''}`),
        api.get('/api/log/eventlogs').catch(() => ({ logs: [] })),
      ]);
      this.catalog = { files: s.files || [], folders: s.folders || [], logs: e.logs || [], windows: s.windows };
      // the same file keeps its selection across a refresh
      for (const f of this.catalog.files) { const x = this.sources.get(f.path); if (x) { x.size = f.size; x.mtime = f.mtime; } }
    } catch (err) { errorToast(err); }
    this.renderSources();
  }

  keyOfFile(f) { return f.path; }
  makeSource(base) {
    const idx = this.sources.size;
    return { color: `hsl(${(idx * 47 + 20) % 360} 62% 62%)`, offset: 0, count: 0, on: true, loading: false, ...base };
  }

  // ================================================================ selecting sources

  async setSource(def, on) {
    if (!on) { this.removeSource(def.key); return; }
    if (this.sources.has(def.key)) return;
    const src = this.makeSource(def);
    this.sources.set(def.key, src);
    this.renderSources();
    await this.loadSource(src);
    this.afterChange(true);
  }
  async setMany(defs, on) {
    if (!on) { for (const d of defs) this.removeSource(d.key, false); this.afterChange(); this.renderSources(); return; }
    const todo = defs.filter((d) => !this.sources.has(d.key));
    for (const d of todo) this.sources.set(d.key, this.makeSource(d));
    this.renderSources();
    // a few at a time
    const queue = todo.map((d) => this.sources.get(d.key));
    await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await this.loadSource(queue.shift()); }));
    this.afterChange(true);
  }
  removeSource(key, update = true) {
    const src = this.sources.get(key);
    if (!src) return;
    this.sources.delete(key);
    this.ents = this.ents.filter((e) => e.s !== src);
    if (update) { this.renderSources(); this.afterChange(); }
  }

  async loadSource(src, tail = this.tail) {
    src.loading = true; src.error = null;
    try {
      this.ents = this.ents.filter((e) => e.s !== src);
      src.count = 0;
      if (src.kind === 'event') {
        const since = Date.now() - this.evHours * 3600e3;
        const r = await api.get(`/api/log/events?log=${encodeURIComponent(src.path)}&since=${since}&max=3000`);
        this.ingestEvents(src, r.events || []);
        src.since = Date.now();
      } else {
        const r = await api.get(`/api/log/read?path=${encodeURIComponent(src.path)}&tail=${tail}`);
        src.offset = r.end; src.size = r.size; src.mtime = r.mtime || src.mtime;
        src.partial = r.size > tail;
        this.ingestText(src, r.text);
      }
    } catch (e) { src.error = e.message; }
    src.loading = false;
  }

  // ================================================================ turning text into entries

  ingestText(src, text) {
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const mt = src.mtime || Date.now();
    const out = [];
    let prevT = src.lastT ?? null, prevL = src.lastL ?? -1, stamped = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let t = parseTime(line, mt);
      let lv = parseLevel(line);
      let cont = false;
      if (t == null) { cont = prevT != null && /^\s|^\w+(\.\w+)*(Exception|Error)|^\s*at /.test(line) || (prevT != null && lv < 0); t = prevT; if (cont && lv < 0) lv = prevL; }
      else stamped++;
      if (t != null) prevT = t;
      if (lv >= 0 && !cont) prevL = lv; else if (!cont) prevL = -1;
      out.push({ t, lv, text: line, cont, ft: false });
    }
    src.lastT = prevT; src.lastL = prevL;
    // a log with no timestamps at all: spread the lines back from its last write so it sorts sensibly
    if (!stamped && !src.hasTimes) {
      const n = out.length;
      out.forEach((o, i) => { o.t = mt - (n - i) * 2; o.ft = true; });
    } else if (stamped) src.hasTimes = true;
    for (const o of out) { if (o.t == null) { o.t = mt; o.ft = true; } this.ents.push({ ...o, s: src, n: this.seq++ }); }
    src.count += out.length;
  }

  ingestEvents(src, evs) {
    for (const e of evs) {
      const first = String(e.m || '').split(/\r?\n/)[0];
      this.ents.push({ t: e.t, lv: evLevel(e.lv), text: `${e.p} (${e.id}): ${first}`, full: `${e.p}  ·  Event ${e.id}\n\n${e.m || ''}`, cont: false, s: src, n: this.seq++ });
    }
    src.count += evs.length;
    if (evs.length) src.lastT = evs[evs.length - 1].t;
  }

  // ================================================================ live

  async poll() {
    if (!this.live || document.hidden || !this.sources.size || this.polling || this.root.offsetParent === null) return;
    this.polling = true;
    try {
      const files = [], events = [];
      for (const s of this.sources.values()) {
        if (s.loading) continue;
        if (s.kind === 'file') files.push({ path: s.path, from: s.offset });
        else events.push({ log: s.path, since: (s.lastT || s.since || Date.now()) + 1 });
      }
      const r = await api.post('/api/log/poll', { files, events });
      let added = 0;
      for (const s of [...this.sources.values()]) {
        if (s.kind === 'file') {
          const c = r.files?.[s.path];
          if (!c) continue;
          if (c.error) { s.error = c.error === 'gone' ? 'The file is gone' : 'Locked by another program'; continue; }
          s.error = null; s.size = c.size; s.mtime = c.mtime;
          if (c.reset) { this.ents = this.ents.filter((e) => e.s !== s); s.count = 0; s.lastT = null; }
          if (c.text) { const before = this.ents.length; this.ingestText(s, c.text); added += this.ents.length - before; }
          s.offset = c.end;
        } else {
          const evs = r.events?.[s.path];
          if (evs?.length) { this.ingestEvents(s, evs); added += evs.length; }
        }
      }
      if (added) {
        if (this.ents.length > MAX_ENTRIES) this.ents.splice(0, this.ents.length - MAX_ENTRIES);
        this.afterChange(false, true);
      }
    } catch { /* the next poll tries again */ }
    this.polling = false;
  }

  // ================================================================ filtering

  afterChange(sortNow = false, live = false) {
    if (sortNow || live) this.ents.sort((a, b) => (a.t - b.t) || (a.n - b.n));
    this.applyFilters();
    this.renderSources();
    if (!this.ents.length) this.renderEmpty(); else this.empty.hidden = true;
    if (live && this.follow) this.scrollToEnd();
  }

  /** The search box → a test on an entry. */
  buildMatcher() {
    const f = this.f;
    const tests = [];
    const flags = f.cs ? '' : 'i';
    const text = (e) => e.text;
    const term = (raw, neg) => {
      let t = raw, test;
      let m;
      if ((m = /^src:(.+)$/i.exec(t))) { const v = m[1].toLowerCase(); test = (e) => `${e.s.label} ${e.s.sub || ''} ${e.s.group}`.toLowerCase().includes(v); }
      else if ((m = /^level:(=?)(\w+)$/i.exec(t))) {
        const want = { trace: 0, debug: 1, info: 2, warn: 3, warning: 3, error: 4, err: 4, fatal: 5 }[m[2].toLowerCase()];
        if (want == null) return;
        test = m[1] ? (e) => e.lv === want : (e) => e.lv >= want;
      } else if ((m = /^\/(.+)\/([a-z]*)$/.exec(t))) {
        let re; try { re = new RegExp(m[1], m[2] || flags); } catch { return; }
        test = (e) => re.test(text(e));
      } else {
        const alts = t.split('|').filter(Boolean);
        if (f.word) {
          const re = new RegExp(`\\b(${alts.map(escRe).join('|')})\\b`, flags);
          test = (e) => re.test(text(e));
        } else if (f.cs) test = (e) => alts.some((a) => e.text.includes(a));
        else { const low = alts.map((a) => a.toLowerCase()); test = (e) => { const l = (e.lc ||= e.text.toLowerCase()); return low.some((a) => l.includes(a)); }; }
      }
      tests.push(neg ? (e) => !test(e) : test);
    };
    const q = f.q.trim();
    this.hl = null;
    if (q) {
      if (f.regex) {
        try { const re = new RegExp(q, flags); tests.push((e) => re.test(text(e))); this.hl = new RegExp(q, flags + 'g'); this.qError = null; } catch (e) { this.qError = e.message; }
      } else {
        this.qError = null;
        const toks = q.match(/"[^"]*"|\S+/g) || [];
        const pos = [];
        for (let tok of toks) {
          let neg = false;
          if (tok.startsWith('-') && tok.length > 1) { neg = true; tok = tok.slice(1); }
          if (tok.startsWith('"') && tok.endsWith('"') && tok.length > 1) tok = tok.slice(1, -1);
          if (!tok) continue;
          term(tok, neg);
          if (!neg && !/^(src|level):/i.test(tok) && !/^\/.+\/[a-z]*$/.test(tok)) pos.push(...tok.split('|').filter(Boolean));
        }
        if (pos.length) this.hl = new RegExp(pos.map(escRe).join('|'), flags + 'g');
      }
    }
    for (const x of f.ex.split(',').map((s) => s.trim()).filter(Boolean)) term(x, true);
    return tests;
  }

  rangeBounds() {
    const f = this.f;
    if (f.range === 'custom') return [f.from, f.to || Infinity];
    const r = RANGES.find((x) => x[0] === f.range);
    return r && r[2] ? [Date.now() - r[2], Infinity] : [-Infinity, Infinity];
  }

  applyFilters() {
    const f = this.f;
    const tests = this.buildMatcher();
    const [t0, t1] = this.rangeBounds();
    const off = f.off;
    const base = [];
    const counts = [0, 0, 0, 0, 0, 0, 0]; // none, trace…fatal (index = level + 1)
    for (const e of this.ents) {
      if (off.has(e.s.group) || off.has(e.s.key)) continue;
      if (e.t < t0 || e.t > t1) continue;
      base.push(e);
    }
    // histogram works on everything that passes everything but the time range
    this.histSource = this.ents.filter((e) => !off.has(e.s.group) && !off.has(e.s.key));
    const hits = new Uint8Array(base.length);
    let hitCount = 0;
    for (let i = 0; i < base.length; i++) {
      const e = base[i];
      let ok = true;
      for (const t of tests) if (!t(e)) { ok = false; break; }
      if (!ok) continue;
      counts[e.lv + 1]++; // the chips show what each level would add, shown or not
      if (f.levels.has(e.lv)) { hits[i] = 1; hitCount++; }
    }
    let keep = hits;
    if (f.ctx > 0 && (tests.length || f.levels.size < 7)) {
      keep = new Uint8Array(base.length);
      for (let i = 0; i < base.length; i++) if (hits[i]) for (let k = Math.max(0, i - f.ctx); k <= Math.min(base.length - 1, i + f.ctx); k++) keep[k] = keep[k] || (k === i ? 1 : 2);
    }
    const rows = [];
    for (let i = 0; i < base.length; i++) {
      if (!keep[i]) continue;
      const e = base[i];
      const last = rows[rows.length - 1];
      if (f.dedupe && last && last.e.s === e.s && last.key === (e.key ||= e.text.replace(/\d+/g, '#')) && keep[i] === 1) { last.dup++; last.last = e; continue; }
      rows.push({ e, hit: keep[i] === 1, dup: 1, key: e.key ||= e.text.replace(/\d+/g, '#') });
    }
    this.rows = rows;
    this.counts = counts;
    this.total = base.length;
    this.hitCount = hitCount;
    this.renderChips();
    this.updateSizer();
    this.paintRows();
    this.drawHist();
    this.refreshStatus();
    store.set('filters', { q: f.q, regex: f.regex, cs: f.cs, word: f.word, ex: f.ex, ctx: f.ctx, dedupe: f.dedupe });
  }
  applySoon = debounce(() => this.applyFilters(), 120);

  // ================================================================ UI

  buildUI() {
    // the search row
    this.qIn = h('input', { class: 'lg-q', type: 'search', placeholder: 'Search: words (all must match), "a phrase", a|b, -exclude, /regex/, src:name, level:warn', spellcheck: 'false',
      oninput: () => { this.f.q = this.qIn.value; this.applySoon(); } });
    const tog = (key, text, tip) => { const b = h('button', { class: `lg-tog ${this.f[key] ? 'on' : ''}`, 'data-tip': tip, onclick: () => { this.f[key] = !this.f[key]; b.classList.toggle('on', this.f[key]); this.applyFilters(); } }, text); return b; };
    this.exIn = h('input', { class: 'lg-ex', type: 'search', placeholder: 'Hide lines containing… (comma separated)', spellcheck: 'false', oninput: () => { this.f.ex = this.exIn.value; this.applySoon(); } });
    const range = h('select', { class: 'lg-sel', 'data-tip': 'Time range', onchange: () => { this.f.range = range.value; this.applyFilters(); } },
      ...RANGES.map(([k, l]) => h('option', { value: k }, l)), h('option', { value: 'custom', hidden: true }, 'Custom (from the chart)'));
    this.rangeSel = range;
    const ctx = h('select', { class: 'lg-sel', 'data-tip': 'Show lines around each match', onchange: () => { this.f.ctx = +ctx.value; this.applyFilters(); } },
      ...[0, 1, 2, 3, 5, 10, 25].map((n) => h('option', { value: String(n) }, n ? `±${n} lines` : 'No context')));
    this.dedupeCb = h('input', { type: 'checkbox', onchange: () => { this.f.dedupe = this.dedupeCb.checked; this.applyFilters(); } });
    this.chips = h('div', { class: 'lg-chips' });
    this.qErr = h('span', { class: 'lg-qerr' });
    const filters = h('div', { class: 'lg-filters' },
      h('div', { class: 'lg-row' }, h('div', { class: 'lg-qwrap' }, icon('search', 'sm'), this.qIn, this.qErr,
        tog('regex', '.*', 'Treat the whole search as a regular expression'), tog('cs', 'Aa', 'Match case'), tog('word', 'W', 'Whole words only')),
      this.exIn),
      h('div', { class: 'lg-row' }, this.chips, h('div', { class: 'grow' }), range, ctx,
        h('label', { class: 'lg-check', 'data-tip': 'Fold repeated lines into one with a count' }, this.dedupeCb, 'Fold repeats')));
    this.hist = h('canvas', { class: 'lg-hist', 'data-tip': 'Drag to zoom into a time range · double-click to reset' });
    this.list = h('div', { class: 'lg-list', tabindex: '0' }, this.sizer = h('div', { class: 'lg-sizer' }), this.body = h('div', { class: 'lg-body' }));
    this.empty = h('div', { class: 'lg-empty' });
    this.detail = h('div', { class: 'lg-detail', hidden: true });
    this.srcSearch = h('input', { class: 'lg-ssearch', type: 'search', placeholder: 'Find a log…', spellcheck: 'false', oninput: () => this.renderSources() });
    this.srcStatus = h('div', { class: 'lg-sstatus' });
    this.srcList = h('div', { class: 'lg-slist' });
    this.side = h('div', { class: 'lg-side' }, h('div', { class: 'lg-shead' }, this.srcSearch), this.srcList, this.srcStatus);
    this.main = h('div', { class: 'lg-main' }, filters, this.hist, h('div', { class: 'lg-listwrap' }, this.list, this.empty), this.detail);
    this.root = h('div', { class: 'lg-root' }, this.side, this.main);
    this.pane.append(this.root);
    this.exIn.value = this.f.ex; this.qIn.value = this.f.q;
    this.list.addEventListener('scroll', () => { this.paintRows(); this.follow = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - ROW * 2; this.followBtn?.classList.toggle('active', this.follow); });
    this.ro = new ResizeObserver(() => { this.paintRows(); this.drawHist(); });
    this.ro.observe(this.list);
    this.wireHist();
    this.wireList();
  }

  buildToolbar() {
    this.liveBtn = tbButton('play', 'Live: follow the logs as they grow', () => this.toggleLive(), { text: 'Live', cls: 'active' });
    this.followBtn = tbButton('arrow-down', 'Stay at the newest line', () => { this.follow = !this.follow; this.followBtn.classList.toggle('active', this.follow); if (this.follow) this.scrollToEnd(); }, { cls: 'active' });
    return h('div', { class: 'toolbar' },
      tbButton('file-plus', 'Add a log file', () => this.addFile(), { text: 'File' }),
      tbButton('folder-plus', 'Add a folder of logs', () => this.addFolder(), { text: 'Folder' }),
      tbButton('refresh', 'Look for logs again', () => this.refreshCatalog(true)),
      tbSep(), this.liveBtn, this.followBtn,
      tbSep(),
      tbButton('download', 'Save what’s shown as a text file', () => this.exportView(), { text: 'Export' }),
      tbButton('copy', 'Copy what’s shown', () => this.copyView()),
      tbButton('trash', 'Clear the view (keeps the sources)', () => this.clearView()),
      tbSep(),
      tbButton('star', 'Saved filters', (e) => showMenu(this.presetMenu(), { anchor: e.currentTarget })),
      tbButton('more', 'Options', (e) => showMenu(this.optionsMenu(), { anchor: e.currentTarget })),
      h('span', { class: 'tb-label' }, 'logs'));
  }

  status() {
    const n = this.rows?.length || 0;
    return { left: [{ text: `${(this.hitCount ?? 0).toLocaleString()} matching of ${(this.total ?? 0).toLocaleString()} lines` }, { text: `${this.sources.size} source${this.sources.size === 1 ? '' : 's'}` }], right: [{ text: n && this.sel >= 0 ? `row ${(this.sel + 1).toLocaleString()}` : '' }] };
  }

  renderEmpty() {
    const quick = (ic, title, sub, fn) => h('button', { class: 'lg-quick', onclick: fn }, icon(ic), h('div', {}, h('b', {}, title), h('span', {}, sub)));
    clear(this.empty).append(h('div', { class: 'lg-empty-in' },
      icon('list-check', 'xl'), h('div', { class: 'lg-empty-t' }, 'Pick some logs on the left, or start here'),
      h('div', { class: 'lg-quicks' },
        quick('play', 'Follow what’s being written now', 'Every log that changed in the last two minutes', () => this.quickActive()),
        this.catalog.windows ? quick('alert', 'Windows problems', 'Errors and warnings from the Application and System logs', () => this.quickWindows()) : null,
        quick('drum', 'Recent game logs', 'Steam, Epic, Unity, Unreal, Minecraft and launchers', () => this.quickGames()))));
    this.empty.hidden = false;
  }

  async quickActive() {
    const now = Date.now();
    const defs = this.catalog.files.filter((f) => now - f.mtime < ACTIVE_MS).slice(0, 40).map((f) => this.fileDef(f));
    if (!defs.length) { toast('Nothing has been written in the last two minutes. Try Refresh.'); return; }
    this.live = true; this.liveBtn.classList.add('active');
    await this.setMany(defs, true);
  }
  async quickWindows() {
    if (!this.catalog.windows) { toast('Windows event logs are only on Windows.'); return; }
    this.f.levels = new Set([3, 4, 5]); this.renderChips();
    await this.setMany(['Application', 'System'].map((n) => this.eventDef(n)), true);
  }
  async quickGames() {
    const defs = this.catalog.files.filter((f) => f.group === 'Games' && Date.now() - f.mtime < 7 * 86400e3).slice(0, 40).map((f) => this.fileDef(f));
    if (!defs.length) { toast('No recent game logs were found. Add a folder if yours live somewhere unusual.'); return; }
    await this.setMany(defs, true);
  }

  fileDef(f) { return { key: f.path, kind: 'file', path: f.path, label: f.name, sub: f.sub, group: f.group, size: f.size, mtime: f.mtime }; }
  eventDef(name) { return { key: `event:${name}`, kind: 'event', path: name, label: name.replace(/^Microsoft-Windows-/, ''), sub: 'Windows event log', group: 'Event logs' }; }

  // ---- the source list

  renderSources() {
    if (!this.srcList) return;
    const q = this.srcSearch.value.trim().toLowerCase();
    const now = Date.now();
    const groups = new Map(GROUPS.map((g) => [g, []]));
    for (const f of this.catalog.files) {
      const label = `${f.name} ${f.sub || ''} ${f.group}`.toLowerCase();
      if (q && !label.includes(q)) continue;
      if (now - f.mtime < ACTIVE_MS) groups.get('Active now').push(f);
      groups.get(f.group)?.push(f);
    }
    for (const s of this.sources.values()) if (s.kind === 'file' && !this.catalog.files.some((f) => f.path === s.path) && (!q || s.label.toLowerCase().includes(q))) groups.get(s.group === 'Added' ? 'Added' : 'Apps').unshift({ path: s.path, name: s.label, sub: s.sub, group: s.group, size: s.size || 0, mtime: s.mtime || 0 });
    const events = this.catalog.logs.filter((l) => !q || l.name.toLowerCase().includes(q) || 'event windows'.includes(q));
    const frag = document.createDocumentFragment();
    const collapsed = (this.collapsed ||= new Set(store.get('collapsed', ['Apps', 'Temp', 'Event logs'])));
    for (const g of GROUPS) {
      const items = g === 'Event logs' ? events : groups.get(g);
      if (!items.length && g !== 'Added') continue;
      const defs = g === 'Event logs' ? items.map((l) => this.eventDef(l.name)) : items.map((f) => this.fileDef(f));
      const chosen = defs.filter((d) => this.sources.has(d.key)).length;
      const open = !collapsed.has(g) || !!q;
      const head = h('div', { class: 'lg-ghead' },
        h('button', { class: 'lg-caret', onclick: () => { collapsed.has(g) ? collapsed.delete(g) : collapsed.add(g); store.set('collapsed', [...collapsed]); this.renderSources(); } }, icon(open ? 'chevron-down' : 'chevron-right', 'sm')),
        h('span', { class: 'lg-gname' }, g), h('span', { class: 'lg-gcount' }, chosen ? `${chosen}/${defs.length}` : String(defs.length)),
        h('div', { class: 'grow' }),
        g === 'Added' ? h('button', { class: 'icon-btn', 'data-tip': 'Add a folder', onclick: () => this.addFolder() }, icon('plus', 'sm')) : null,
        h('label', { class: 'lg-gall', 'data-tip': `Select all in ${g}` }, h('input', { type: 'checkbox', checked: defs.length > 0 && chosen === defs.length, indeterminate: chosen > 0 && chosen < defs.length, disabled: !defs.length,
          onchange: (e) => this.setMany(defs.slice(0, 60), e.target.checked) })));
      frag.append(head);
      if (!open) continue;
      if (g === 'Added' && !defs.length) frag.append(h('div', { class: 'lg-sempty' }, 'Folders and files you add show up here.'));
      const shown = g === 'Event logs' ? items.slice(0, q ? 80 : 30) : items.slice(0, 150);
      let lastSub = null;
      shown.forEach((it) => {
        const isEv = g === 'Event logs';
        const def = isEv ? this.eventDef(it.name) : this.fileDef(it);
        const src = this.sources.get(def.key);
        if (!isEv && it.sub !== lastSub && g !== 'Active now') { lastSub = it.sub; frag.append(h('div', { class: 'lg-sub' }, it.sub || '')); }
        const active = !isEv && now - it.mtime < ACTIVE_MS;
        frag.append(h('label', { class: `lg-src ${src ? 'on' : ''}`, 'data-tip': isEv ? `${it.count.toLocaleString()} events` : it.path,
          oncontextmenu: (e) => contextMenu(e, this.sourceMenu(def, src)) },
        h('input', { type: 'checkbox', checked: !!src, onchange: (e) => this.setSource(def, e.target.checked) }),
        h('span', { class: 'lg-dot', style: { background: src ? src.color : 'transparent', borderColor: src ? src.color : 'var(--line)' } }),
        h('span', { class: 'lg-sname' }, isEv ? def.label : it.name),
        src?.loading ? h('span', { class: 'lg-sspin' }, '…') : src?.error ? h('span', { class: 'lg-serr', 'data-tip': src.error }, '!') : null,
        active ? h('span', { class: 'lg-live' }, 'live') : null,
        h('span', { class: 'lg-smeta' }, isEv ? '' : `${formatBytes(it.size)} · ${ago(it.mtime)}`)));
      });
      if (items.length > shown.length) frag.append(h('div', { class: 'lg-sempty' }, `${items.length - shown.length} more, use the search above.`));
    }
    clear(this.srcList).append(frag);
    this.srcStatus.textContent = `${this.catalog.files.length.toLocaleString()} log files · ${this.catalog.logs.length} event logs`;
  }

  sourceMenu(def, src) {
    return [
      { label: src ? 'Stop showing it' : 'Show it', icon: src ? 'eye-off' : 'eye', action: () => this.setSource(def, !src) },
      ...(src && src.kind === 'file' ? [
        { label: 'Load more of its history', icon: 'history', action: async () => { src.loading = true; this.renderSources(); await this.loadSource(src, 8 * 1024 * 1024); this.afterChange(true); } },
        { label: 'Show only this source', icon: 'sliders', action: () => this.soloSource(src) },
      ] : []),
      ...(def.kind === 'file' ? [
        { label: `Show in ${fileManager()}`, icon: 'folder-open', action: () => api.post('/api/reveal', { path: def.path }).catch(() => {}) },
        { label: 'Copy path', icon: 'copy', action: () => navigator.clipboard.writeText(def.path).then(() => toast('Copied')) },
      ] : []),
    ];
  }
  soloSource(src) {
    this.f.off = new Set([...this.sources.keys()].filter((k) => k !== src.key));
    toast(`Showing only ${src.label}. Reset in the ⋯ menu.`, { action: { label: 'Reset', fn: () => { this.f.off = new Set(); this.applyFilters(); } } });
    this.applyFilters();
  }

  async addFile() {
    const paths = await pickOpen({ multi: true, title: 'Log files to add', filters: [{ name: 'Logs and text', extensions: ['log', 'txt', 'out', 'json', 'csv'] }, { name: 'All files', extensions: ['*'] }] });
    if (!paths?.length) return;
    await this.setMany(paths.map((p) => ({ key: p, kind: 'file', path: p, label: p.split(/[\\/]/).pop(), sub: 'Added by you', group: 'Added', size: 0, mtime: Date.now() })), true);
  }
  async addFolder() {
    const dir = await pickFolder({ title: 'A folder of logs' });
    if (!dir) return;
    try { await api.post('/api/log/folders', { add: dir }); toast('Looking through it…'); await this.refreshCatalog(true); } catch (e) { errorToast(e); }
  }

  // ---- level chips

  renderChips() {
    if (!this.chips) return;
    const mk = (lv, label, cls) => {
      const on = this.f.levels.has(lv), n = this.counts?.[lv + 1] ?? 0;
      return h('button', { class: `lg-chip ${cls} ${on ? 'on' : ''}`, 'data-tip': 'Click to show or hide · double-click for only this', onclick: () => { on ? this.f.levels.delete(lv) : this.f.levels.add(lv); this.applyFilters(); },
        ondblclick: () => { this.f.levels = new Set([lv]); this.applyFilters(); } }, label, h('i', {}, n.toLocaleString()));
    };
    clear(this.chips).append(mk(5, 'Fatal', 'fatal'), mk(4, 'Error', 'error'), mk(3, 'Warn', 'warn'), mk(2, 'Info', 'info'), mk(1, 'Debug', 'debug'), mk(0, 'Trace', 'trace'), mk(-1, 'Other', 'none'));
    this.qErr.textContent = this.qError ? 'bad regex' : '';
  }

  // ================================================================ the list

  updateSizer() {
    this.sizer.style.height = `${this.rows.length * ROW}px`;
    this.empty.hidden = !!this.ents.length;
    if (this.ents.length && !this.rows.length) { this.empty.hidden = false; clear(this.empty).append(h('div', { class: 'lg-empty-in' }, icon('search', 'xl'), h('div', { class: 'lg-empty-t' }, 'Nothing matches those filters'), h('button', { class: 'btn', onclick: () => this.resetFilters() }, 'Reset filters'))); }
  }

  paintRows() {
    if (!this.body) return;
    const top = this.list.scrollTop, H = this.list.clientHeight;
    const a = Math.max(0, Math.floor(top / ROW) - 6), b = Math.min(this.rows.length, Math.ceil((top + H) / ROW) + 6);
    const span = this.ents.length ? (this.ents[this.ents.length - 1].t - this.ents[0].t) : 0;
    const dated = span > 20 * 3600e3 || (this.ents[0] && new Date(this.ents[0].t).toDateString() !== new Date().toDateString());
    const frag = document.createDocumentFragment();
    for (let i = a; i < b; i++) {
      const r = this.rows[i], e = r.e;
      const el = h('div', { class: `lg-row-l lv-${e.lv < 0 ? 'none' : LV_CLASS[e.lv]} ${r.hit ? '' : 'ctx'} ${i === this.sel ? 'sel' : ''}`, style: { top: `${i * ROW}px` }, 'data-i': String(i) },
        h('span', { class: 'lg-t' }, e.ft ? '' : fmtTime(e.t, dated)),
        h('span', { class: 'lg-lv' }, e.lv < 0 ? '' : LV[e.lv]),
        h('span', { class: 'lg-src-tag', style: { color: e.s.color }, title: e.s.path }, e.s.label),
        r.dup > 1 ? h('span', { class: 'lg-dup' }, `×${r.dup}`) : null,
        this.textCell(e, r.hit));
      frag.append(el);
    }
    clear(this.body).append(frag);
  }

  textCell(e, hit) {
    const span = h('span', { class: 'lg-text' });
    const t = e.text.length > 2000 ? `${e.text.slice(0, 2000)}…` : e.text;
    if (hit && this.hl) {
      let last = 0, n = 0;
      this.hl.lastIndex = 0;
      for (let m; (m = this.hl.exec(t)) && n < 40; n++) {
        if (!m[0]) { this.hl.lastIndex++; continue; }
        if (m.index > last) span.append(t.slice(last, m.index));
        span.append(h('mark', {}, m[0]));
        last = m.index + m[0].length;
      }
      span.append(t.slice(last));
    } else span.textContent = t;
    return span;
  }

  scrollToEnd() { this.list.scrollTop = this.list.scrollHeight; this.paintRows(); }

  wireList() {
    this.list.addEventListener('click', (e) => {
      const r = e.target.closest('.lg-row-l');
      if (r) this.select(+r.dataset.i);
    });
    this.list.addEventListener('contextmenu', (e) => {
      const r = e.target.closest('.lg-row-l');
      if (!r) return;
      this.select(+r.dataset.i);
      contextMenu(e, this.rowMenu(this.rows[+r.dataset.i]));
    });
    this.list.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.select(clamp(this.sel + (e.key === 'ArrowDown' ? 1 : -1), 0, this.rows.length - 1), true); }
      else if (e.key === 'End') { e.preventDefault(); this.follow = true; this.scrollToEnd(); }
      else if (e.key === 'Home') { e.preventDefault(); this.list.scrollTop = 0; }
      else if (e.key === 'PageDown' || e.key === 'PageUp') { e.preventDefault(); this.list.scrollTop += (e.key === 'PageDown' ? 1 : -1) * this.list.clientHeight * 0.9; }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && this.sel >= 0 && !window.getSelection().toString()) { navigator.clipboard.writeText(this.rows[this.sel].e.full || this.rows[this.sel].e.text); }
    });
  }

  select(i, scroll) {
    this.sel = i;
    const r = this.rows[i];
    if (scroll) { const y = i * ROW; if (y < this.list.scrollTop) this.list.scrollTop = y; else if (y + ROW > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = y + ROW - this.list.clientHeight; }
    this.paintRows();
    if (!r) { this.detail.hidden = true; return; }
    const e = r.e;
    clear(this.detail).append(
      h('div', { class: 'lg-dhead' }, h('b', { style: { color: e.s.color } }, e.s.label), h('span', {}, e.s.sub || ''), h('span', { class: 'mono' }, e.ft ? '' : new Date(e.t).toLocaleString()),
        h('div', { class: 'grow' }), h('button', { class: 'icon-btn', 'data-tip': 'Copy', onclick: () => navigator.clipboard.writeText(e.full || e.text).then(() => toast('Copied')) }, icon('copy', 'sm')),
        h('button', { class: 'icon-btn', 'data-tip': 'Close', onclick: () => { this.detail.hidden = true; } }, icon('x', 'sm'))),
      h('pre', { class: 'lg-dtext' }, this.neighbors(i)));
    this.detail.hidden = false;
    this.refreshStatus();
  }
  /** The selected line plus any lines that continue it (a stack trace…), in the file's own order. */
  neighbors(i) {
    const out = [this.rows[i].e.full || this.rows[i].e.text];
    for (let k = i + 1; k < this.rows.length && this.rows[k].e.cont && this.rows[k].e.s === this.rows[i].e.s && out.length < 60; k++) out.push(this.rows[k].e.text);
    return out.join('\n');
  }

  rowMenu(r) {
    if (!r) return [];
    const e = r.e;
    const pickText = () => { const s = window.getSelection().toString().trim(); return s || e.text.replace(/\d+/g, '').slice(0, 40).trim(); };
    return [
      { label: 'Copy line', icon: 'copy', action: () => navigator.clipboard.writeText(e.full || e.text).then(() => toast('Copied')) },
      { sep: true },
      { label: 'Hide lines like this', icon: 'eye-off', action: () => { const t = pickText(); this.f.ex = this.f.ex ? `${this.f.ex}, ${t}` : t; this.exIn.value = this.f.ex; this.applyFilters(); } },
      { label: 'Only this source', icon: 'sliders', action: () => this.soloSource(e.s) },
      { label: 'Only this level', icon: 'sliders', disabled: e.lv < 0, action: () => { this.f.levels = new Set([e.lv]); this.applyFilters(); } },
      { label: 'Hide this source', icon: 'x', action: () => { this.f.off.add(e.s.key); this.applyFilters(); } },
      { sep: true },
      { label: 'Show 5 lines around it', icon: 'list-bullet', action: () => this.aroundTime(e) },
    ];
  }
  /** Clear the text filters and look at the time around one line. */
  aroundTime(e) {
    this.f.q = ''; this.qIn.value = ''; this.f.ex = ''; this.exIn.value = '';
    this.f.levels = new Set([-1, 0, 1, 2, 3, 4, 5]); this.f.range = 'custom'; this.f.from = e.t - 30000; this.f.to = e.t + 30000; this.rangeSel.value = 'custom';
    this.applyFilters();
    const i = this.rows.findIndex((r) => r.e === e);
    if (i >= 0) { this.follow = false; this.list.scrollTop = Math.max(0, i * ROW - this.list.clientHeight / 2); this.select(i); }
  }

  // ================================================================ the chart

  drawHist() {
    const cv = this.hist;
    if (!cv) return;
    const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W) return;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const src = this.histSource || [];
    const css = getComputedStyle(this.root);
    const col = { err: '#e5484d', warn: '#f5a524', ok: css.getPropertyValue('--text-3').trim() || '#777', line: css.getPropertyValue('--line').trim() || '#333' };
    ctx.clearRect(0, 0, W, H);
    this.histMap = null;
    if (src.length < 2) { ctx.fillStyle = col.ok; ctx.font = '11px sans-serif'; ctx.fillText('Lines over time show up here', 10, H / 2 + 4); return; }
    // the span: the time range if one is set, else everything loaded
    let [a, b] = this.rangeBounds();
    const real = src.filter((e) => !e.ft);
    if (!Number.isFinite(a)) a = (real[0] || src[0]).t;
    if (!Number.isFinite(b)) b = (real[real.length - 1] || src[src.length - 1]).t;
    if (b <= a) b = a + 1000;
    const N = Math.max(20, Math.floor(W / 5));
    const bins = Array.from({ length: N }, () => [0, 0, 0]);
    const bw = (b - a) / N;
    for (const e of src) {
      if (e.t < a || e.t > b || !this.f.levels.has(e.lv)) continue;
      const k = Math.min(N - 1, Math.floor((e.t - a) / bw));
      bins[k][e.lv >= 4 ? 0 : e.lv === 3 ? 1 : 2]++;
    }
    const max = Math.max(1, ...bins.map((x) => x[0] + x[1] + x[2]));
    const x = (k) => (k / N) * W;
    bins.forEach((v, k) => {
      let y = H - 2;
      for (const [i, c] of [[2, col.ok], [1, col.warn], [0, col.err]]) {
        const hgt = (v[i] / max) * (H - 8);
        if (hgt <= 0) continue;
        ctx.globalAlpha = i === 2 ? 0.5 : 1; ctx.fillStyle = c;
        ctx.fillRect(x(k) + 0.5, y - Math.max(1, hgt), Math.max(1, W / N - 1), Math.max(1, hgt));
        y -= hgt;
      }
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = col.ok; ctx.font = '10px sans-serif';
    ctx.fillText(fmtTime(a, true).slice(0, -4), 4, 10);
    const lbl = fmtTime(b, true).slice(0, -4);
    ctx.fillText(lbl, W - ctx.measureText(lbl).width - 4, 10);
    if (this.brush) { ctx.fillStyle = 'rgba(120,120,255,.25)'; ctx.fillRect(Math.min(this.brush[0], this.brush[1]), 0, Math.abs(this.brush[1] - this.brush[0]), H); }
    this.histMap = { a, b, W };
  }

  wireHist() {
    const cv = this.hist;
    let down = null;
    const xOf = (e) => clamp(e.clientX - cv.getBoundingClientRect().left, 0, cv.clientWidth);
    cv.addEventListener('pointerdown', (e) => { if (!this.histMap) return; down = xOf(e); this.brush = [down, down]; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => { if (down == null) return; this.brush[1] = xOf(e); this.drawHist(); });
    cv.addEventListener('pointerup', (e) => {
      if (down == null) return;
      const x1 = xOf(e), m = this.histMap; down = null;
      const [p, q] = [Math.min(this.brush[0], x1), Math.max(this.brush[0], x1)];
      this.brush = null;
      if (m && q - p > 4) {
        const t = (x) => m.a + (x / m.W) * (m.b - m.a);
        this.f.range = 'custom'; this.f.from = t(p); this.f.to = t(q); this.rangeSel.value = 'custom';
        this.follow = false;
      }
      this.applyFilters();
    });
    cv.addEventListener('dblclick', () => { this.f.range = 'all'; this.rangeSel.value = 'all'; this.applyFilters(); });
  }

  // ================================================================ the rest

  toggleLive() {
    this.live = !this.live;
    this.liveBtn.classList.toggle('active', this.live);
    this.liveBtn.querySelector('span').textContent = this.live ? 'Live' : 'Paused';
    if (this.live) this.poll();
  }

  clearView() {
    for (const s of this.sources.values()) { s.count = 0; }
    this.ents = [];
    this.applyFilters();
    this.renderEmpty();
    this.empty.hidden = false;
  }

  resetFilters() {
    this.f = { ...this.f, q: '', regex: false, cs: false, word: false, ex: '', levels: new Set([-1, 0, 1, 2, 3, 4, 5]), range: 'all', ctx: 0, dedupe: false, off: new Set() };
    this.qIn.value = ''; this.exIn.value = ''; this.rangeSel.value = 'all'; this.dedupeCb.checked = false;
    this.root.querySelectorAll('.lg-tog').forEach((b) => b.classList.remove('on'));
    this.applyFilters();
  }

  viewText() { return this.rows.map((r) => `${r.e.ft ? '' : fmtTime(r.e.t, true)}  [${r.e.s.label}]  ${r.e.text}${r.dup > 1 ? `  (×${r.dup})` : ''}`).join('\n'); }
  async copyView() {
    const t = this.viewText();
    if (!t) { toast('Nothing to copy'); return; }
    await navigator.clipboard.writeText(t);
    toast(`Copied ${this.rows.length.toLocaleString()} lines`);
  }
  async exportView() {
    if (!this.rows.length) { toast('Nothing to export'); return; }
    const dest = await pickSave({ defaultName: 'log-export.txt', filters: [{ name: 'Text', extensions: ['txt'] }, { name: 'Log', extensions: ['log'] }], title: 'Export what’s shown' });
    if (!dest) return;
    try { await api.write(dest.path, new TextEncoder().encode(this.viewText()), { force: true }); toast(`Saved ${this.rows.length.toLocaleString()} lines`, { type: 'ok' }); } catch (e) { errorToast(e); }
  }

  presetMenu() {
    const list = store.get('presets', []);
    return [
      { label: 'Save these filters…', icon: 'save', action: async () => {
        const name = await promptDialog('Save filters', 'Name', this.f.q || 'My filter');
        if (!name) return;
        const p = list.filter((x) => x.name !== name);
        p.push({ name, f: { q: this.f.q, regex: this.f.regex, cs: this.f.cs, word: this.f.word, ex: this.f.ex, levels: [...this.f.levels], range: this.f.range === 'custom' ? 'all' : this.f.range, ctx: this.f.ctx, dedupe: this.f.dedupe } });
        store.set('presets', p);
        toast('Saved');
      } },
      ...(list.length ? [{ sep: true }] : []),
      ...list.map((p) => ({ label: p.name, icon: 'star', action: () => this.loadPreset(p), submenu: [{ label: 'Use', action: () => this.loadPreset(p) }, { label: 'Delete', icon: 'trash', action: () => store.set('presets', list.filter((x) => x !== p && x.name !== p.name)) }] })),
      { sep: true },
      { label: 'Errors and fatals only', icon: 'alert', action: () => this.loadPreset({ f: { levels: [4, 5] } }) },
      { label: 'Warnings and worse', icon: 'alert', action: () => this.loadPreset({ f: { levels: [3, 4, 5] } }) },
      { label: 'Crashes and exceptions', icon: 'alert', action: () => this.loadPreset({ f: { q: 'crash|exception|fatal|unhandled|access violation|stack trace', levels: [-1, 0, 1, 2, 3, 4, 5] } }) },
      { label: 'Failed logins and access', icon: 'lock', action: () => this.loadPreset({ f: { q: 'denied|unauthorized|forbidden|login failed|authentication fail', levels: [-1, 0, 1, 2, 3, 4, 5] } }) },
    ];
  }
  loadPreset(p) {
    const f = p.f;
    this.f = { ...this.f, q: f.q || '', regex: !!f.regex, cs: !!f.cs, word: !!f.word, ex: f.ex || '', levels: new Set(f.levels || [-1, 0, 1, 2, 3, 4, 5]), range: f.range || 'all', ctx: f.ctx || 0, dedupe: !!f.dedupe };
    this.qIn.value = this.f.q; this.exIn.value = this.f.ex; this.rangeSel.value = this.f.range; this.dedupeCb.checked = this.f.dedupe;
    this.root.querySelectorAll('.lg-tog').forEach((b, i) => b.classList.toggle('on', [this.f.regex, this.f.cs, this.f.word][i]));
    this.applyFilters();
  }

  optionsMenu() {
    const pick = (label, key, vals, cur, after) => ({ label, submenu: vals.map(([v, l]) => ({ label: l, checked: cur === v, action: () => { this[key] = v; store.set(key, v); after?.(); } })) });
    return [
      pick('First read of each file', 'tail', [[262144, 'Last 256 KB'], [1048576, 'Last 1 MB'], [4194304, 'Last 4 MB'], [8388608, 'Last 8 MB']], this.tail),
      !this.catalog.windows ? null : pick('Windows event history', 'evHours', [[1, 'Last hour'], [6, 'Last 6 hours'], [24, 'Last 24 hours'], [168, 'Last 7 days'], [720, 'Last 30 days']], this.evHours, () => this.reloadEvents()),
      pick('Look for log files changed in', 'days', [[1, 'the last day'], [7, 'the last week'], [14, 'the last 2 weeks'], [60, 'the last 2 months'], [365, 'the last year']], this.days, () => this.refreshCatalog(true)),
      { sep: true },
      { label: 'Show every source again', icon: 'eye', action: () => { this.f.off = new Set(); this.applyFilters(); } },
      { label: 'Reset all filters', icon: 'refresh', action: () => this.resetFilters() },
      ...(this.catalog.folders.length ? [{ sep: true }, ...this.catalog.folders.map((d) => ({ label: `Stop looking in ${d}`, icon: 'x', action: async () => { await api.post('/api/log/folders', { remove: d }).catch(errorToast); this.refreshCatalog(true); } }))] : []),
    ];
  }
  async reloadEvents() {
    const evs = [...this.sources.values()].filter((s) => s.kind === 'event');
    for (const s of evs) await this.loadSource(s);
    this.afterChange(true);
  }

  handlesKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); this.qIn.focus(); this.qIn.select(); return true; }
    return false;
  }
  find() { this.qIn.focus(); this.qIn.select(); }
  onShow() { this.paintRows(); this.drawHist(); }
  destroy() { clearInterval(this.timer); this.ro?.disconnect(); }
}
