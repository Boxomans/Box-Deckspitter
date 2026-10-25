// BoxOdds: dice, coins, picking from lists, chances in any format, random numbers, and mixes that roll any of those
// together in one go. Every roll uses the system's secure random source. Kept in settings.odds (lists, mixes, the
// last settings of each mode and the history).

import { BaseEditor } from './base.js';
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, confirmDialog, promptDialog, contextMenu } from '../core/ui.js';

const MAX_HISTORY = 300;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------------------------------------------------------------- randomness

const pool = new Uint32Array(1024);
let poolAt = pool.length;
const u32 = () => { if (poolAt >= pool.length) { crypto.getRandomValues(pool); poolAt = 0; } return pool[poolAt++]; };
/** 0 ≤ x < 1, 53 bits. */
const rand01 = () => (u32() * 2 ** 21 + (u32() >>> 11)) / 2 ** 53;
/** A whole number from 0 to n − 1 with no bias. */
function randInt(n) {
  if (n <= 1) return 0;
  if (n <= 2 ** 32) {
    const lim = Math.floor(2 ** 32 / n) * n;
    let x;
    do x = u32(); while (x >= lim);
    return x % n;
  }
  return Math.floor(rand01() * n);
}
const fastInt = (n) => Math.floor(Math.random() * n); // only for the odds estimates, never for a roll you see

// ---------------------------------------------------------------- number helpers

function lnGamma(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function binomPmf(n, k, p) {
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  return Math.exp(lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log1p(-p));
}
/** A chance as a percentage, readable at any size. */
function pct(p) {
  if (p >= 1) return '100%';
  if (p <= 0) return '0%';
  const v = p * 100;
  if (v >= 99.995 && p < 1) return '>99.99%';
  if (v >= 10) return `${+v.toFixed(1)}%`;
  if (v >= 0.01) return `${+v.toPrecision(3)}%`;
  return `${v.toExponential(2)}%`;
}
const num = (v, d = 4) => String(+v.toFixed(d));
const big = (v) => (Math.abs(v) >= 1e6 ? v.toExponential(3).replace('e+', 'e') : String(+v.toPrecision(6))).replace(/^(-?\d+)/, (m) => m.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
/** Closest simple fraction (denominator up to 10 000). */
function fraction(p) {
  if (p <= 0) return '0';
  if (p >= 1) return '1';
  let [h0, h1, k0, k1, x] = [0, 1, 1, 0, p];
  for (let i = 0; i < 40; i++) {
    const a = Math.floor(x);
    const [h2, k2] = [a * h1 + h0, a * k1 + k0];
    if (k2 > 10000) break;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
    if (Math.abs(x - a) < 1e-12) break;
    x = 1 / (x - a);
  }
  const exact = Math.abs(h1 / k1 - p) < 1e-9;
  return `${exact ? '' : '≈ '}${h1}/${k1}`;
}

// ---------------------------------------------------------------- dice

const MAX_DICE = 1000, MAX_SIDES = 1e9;
const MOD_RE = /kh\d*|kl\d*|k\d*|dh\d*|dl\d*|!|r\d*|>=\d+|<=\d+|>\d+|<\d+/gy;

/** "4d6dl1 + 2d8! - 1" → terms. Throws a readable message. */
export function parseDice(src) {
  const s = String(src).toLowerCase().replace(/\s+/g, '')
    .replace(/\badv\b|advantage/g, '2d20kh1').replace(/\bdis\b|disadvantage/g, '2d20kl1');
  if (!s) throw new Error('Type some dice, like 2d6+3');
  if (!/^[+-]/.test(s) && !/^[\dd]/.test(s)) throw new Error('Dice look like 2d6, d20, 4d6dl1 or 3d10!');
  const terms = [];
  let total = 0;
  const re = /([+-]?)([^+-]+)/g;
  let m, at = 0;
  while ((m = re.exec(s))) {
    if (m.index !== at) throw new Error('Two signs in a row');
    at = re.lastIndex;
    const sign = m[1] === '-' ? -1 : 1, body = m[2];
    if (/^\d+(\.\d+)?$/.test(body)) { terms.push({ sign, const: Number(body) }); continue; }
    const d = /^(\d*)d(\d+|%|f)(.*)$/.exec(body);
    if (!d) throw new Error(`Can’t read “${body}”`);
    const t = { sign, n: d[1] ? Number(d[1]) : 1, sides: d[2] === '%' ? 100 : d[2] === 'f' ? 3 : Number(d[2]), fudge: d[2] === 'f', src: body };
    if (t.n < 1) throw new Error('Roll at least one die');
    if (t.sides < 1) throw new Error('A die needs at least one side');
    if (t.sides > MAX_SIDES) throw new Error('Up to a billion sides');
    total += t.n;
    MOD_RE.lastIndex = 0;
    let rest = d[3];
    while (rest) {
      MOD_RE.lastIndex = 0;
      const mm = MOD_RE.exec(rest);
      if (!mm) throw new Error(`Don’t know “${rest}” after the dice`);
      const x = mm[0], n = Number(x.replace(/\D/g, '')) || 1;
      if (x === '!') t.explode = true;
      else if (x[0] === 'r') t.reroll = Number(x.slice(1)) || 1;
      else if (x.startsWith('kh') || /^k\d*$/.test(x)) t.keep = ['h', n];
      else if (x.startsWith('kl')) t.keep = ['l', n];
      else if (x.startsWith('dh')) t.keep = ['l', Math.max(0, t.n - n)];
      else if (x.startsWith('dl')) t.keep = ['h', Math.max(0, t.n - n)];
      else { const c = /^(>=|<=|>|<)(\d+)$/.exec(x); t.succ = [c[1], Number(c[2])]; }
      rest = rest.slice(x.length);
    }
    if (t.keep && t.keep[1] > t.n) t.keep[1] = t.n;
    if (t.explode && t.sides === 1) throw new Error('A one-sided die would explode forever');
    if (t.reroll && t.reroll >= t.sides && !t.fudge) throw new Error('That reroll would never stop');
    terms.push(t);
  }
  if (at !== s.length) throw new Error('The dice end with a sign');
  if (total > MAX_DICE) throw new Error(`Up to ${MAX_DICE} dice at once`);
  return terms;
}

const passes = (v, [op, n]) => (op === '>=' ? v >= n : op === '<=' ? v <= n : op === '>' ? v > n : v < n);

/** Rolls parsed dice. Each die: { v, first (before a reroll), ex: [explosions], total, kept }. */
export function rollDice(terms, int = randInt) {
  let total = 0;
  const parts = terms.map((t) => {
    if (t.const != null) { total += t.sign * t.const; return { t, value: t.const }; }
    const face = () => (t.fudge ? int(3) - 1 : 1 + int(t.sides));
    const dice = [];
    for (let i = 0; i < t.n; i++) {
      const d = { v: face(), ex: [], kept: true };
      if (t.reroll && d.v <= t.reroll) { d.first = d.v; d.v = face(); }
      if (t.explode) { let last = d.v, c = 0; while (last === t.sides && c++ < 100) { last = face(); d.ex.push(last); } }
      d.total = d.v + d.ex.reduce((a, b) => a + b, 0);
      dice.push(d);
    }
    if (t.keep) {
      const order = dice.map((d, i) => i).sort((a, b) => (t.keep[0] === 'h' ? dice[b].total - dice[a].total : dice[a].total - dice[b].total));
      order.forEach((i, r) => { dice[i].kept = r < t.keep[1]; });
    }
    const kept = dice.filter((d) => d.kept);
    const value = t.succ ? kept.filter((d) => passes(d.total, t.succ)).length : kept.reduce((a, d) => a + d.total, 0);
    total += t.sign * value;
    return { t, dice, value };
  });
  return { total, parts };
}

/** The chances of every total: exact when it can be worked out, else ≈ from many rolls. → { dist: Map, exact } */
export function diceOdds(terms) {
  const simple = terms.every((t) => t.const != null || (!t.keep && !t.explode));
  if (simple) {
    let lo = 0, p = [1], work = 0, ok = true;
    for (const t of terms) {
      if (t.const != null) { lo += t.sign * t.const; continue; }
      // one die's chances, by face (lo .. lo + len)
      let dlo, dp;
      if (t.fudge) { dlo = -1; dp = [1 / 3, 1 / 3, 1 / 3]; } else {
        if (t.sides > 20000) { ok = false; break; }
        dlo = 1; dp = new Array(t.sides).fill(1 / t.sides);
        if (t.reroll) { const r = Math.min(t.reroll, t.sides) / t.sides; dp = dp.map((x, i) => (i + 1 <= t.reroll ? 0 : x) + r / t.sides); }
      }
      if (t.succ) {
        let ps = 0; dp.forEach((x, i) => { if (passes(dlo + i, t.succ)) ps += x; });
        dlo = 0; dp = [1 - ps, ps];
      }
      if (t.sign < 0) { dlo = -(dlo + dp.length - 1); dp = dp.slice().reverse(); }
      for (let i = 0; i < t.n; i++) {
        work += p.length * dp.length;
        if (work > 3e7) { ok = false; break; }
        const q = new Array(p.length + dp.length - 1).fill(0);
        for (let a = 0; a < p.length; a++) { if (!p[a]) continue; for (let b = 0; b < dp.length; b++) q[a + b] += p[a] * dp[b]; }
        p = q; lo += dlo;
      }
      if (!ok) break;
    }
    if (ok) {
      const dist = new Map();
      p.forEach((x, i) => { if (x > 1e-15) dist.set(Math.round((lo + i) * 1e6) / 1e6, x); });
      return { dist, exact: true };
    }
  }
  const dice = terms.reduce((a, t) => a + (t.n || 0), 0) || 1;
  const runs = Math.max(2000, Math.min(40000, Math.floor(4e6 / dice)));
  const counts = new Map();
  for (let i = 0; i < runs; i++) { const v = rollDice(terms, fastInt).total; counts.set(v, (counts.get(v) || 0) + 1); }
  const dist = new Map([...counts].sort((a, b) => a[0] - b[0]).map(([v, c]) => [v, c / runs]));
  return { dist, exact: false, runs };
}

const termText = (p) => {
  if (p.t.const != null) return `${p.t.sign < 0 ? '−' : '+'}${p.t.const}`;
  return `${p.t.sign < 0 ? '−' : ''}[${p.dice.map((d) => (d.kept ? '' : '~') + (d.first != null ? `${d.first}→` : '') + d.v + (d.ex.length ? '!' + d.ex.join('!') : '')).join(', ')}]`;
};
const diceLine = (r) => r.parts.map(termText).join(' ');

// ---------------------------------------------------------------- picking

/** Lines → options. "Name *3" weighs three times as much; "#" lines are notes. */
export function parseOptions(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(.*?)\s*\*\s*(\d*\.?\d+)\s*$/.exec(line);
    const name = (m ? m[1] : line).trim();
    if (!name) continue;
    out.push({ name, w: m ? Number(m[2]) : 1 });
  }
  return out;
}
function pickWeighted(opts, n, unique, int = randInt) {
  const left = opts.filter((o) => o.w > 0).slice();
  const out = [];
  for (let i = 0; i < n && left.length; i++) {
    const sum = left.reduce((a, o) => a + o.w, 0);
    let r = (int === randInt ? rand01() : Math.random()) * sum, k = 0;
    while (k < left.length - 1 && (r -= left[k].w) >= 0) k++;
    out.push(left[k]);
    if (unique) left.splice(k, 1);
  }
  return out;
}
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------------------------------------------------------------- chances

export const CHANCE_FORMATS = [
  ['auto', 'Any (worked out)'], ['pct', 'Percent  25%'], ['in', '1 in N  1 in 4'], ['frac', 'Fraction  1/4'],
  ['for', 'Odds for  1:3'], ['against', 'Odds against  3:1'], ['dec', 'Decimal odds  4.0'], ['us', 'American odds  +300'],
];
/** Any way of writing a chance → 0..1. Throws a readable message. */
export function parseChance(text, fmt = 'auto') {
  const s = String(text).trim().toLowerCase().replace(/,/g, '');
  if (!s) throw new Error('Type a chance');
  const N = '(\\d*\\.?\\d+)';
  const two = (sep) => { const m = new RegExp(`^${N}\\s*(?:${sep})\\s*${N}$`).exec(s); return m ? [Number(m[1]), Number(m[2])] : null; };
  const chk = (p) => { if (!(p >= 0 && p <= 1) || Number.isNaN(p)) throw new Error('A chance is between 0 and 100%'); return p; };
  let x;
  switch (fmt) {
    case 'pct': return chk(Number(s.replace('%', '')) / 100);
    case 'in': if ((x = two('in'))) return chk(x[0] / x[1]); if ((x = /^\d*\.?\d+$/.exec(s))) return chk(1 / Number(s)); throw new Error('Like “1 in 6”, or just 6');
    case 'frac': if ((x = two('/'))) return chk(x[0] / x[1]); throw new Error('Like 1/6');
    case 'for': if ((x = two(':|to'))) return chk(x[0] / (x[0] + x[1])); throw new Error('Like 1:5 (one win for five losses)');
    case 'against': if ((x = two(':|to'))) return chk(x[1] / (x[0] + x[1])); throw new Error('Like 5:1 (five losses for one win)');
    case 'dec': { const d = Number(s); if (!(d >= 1)) throw new Error('Decimal odds are 1.0 or more'); return 1 / d; }
    case 'us': {
      const a = Number(s);
      if (!(Math.abs(a) >= 100)) throw new Error('American odds are +100 or more, or −100 or less');
      return chk(a > 0 ? 100 / (a + 100) : -a / (-a + 100));
    }
    default:
      if (s.endsWith('%')) return parseChance(s, 'pct');
      if (/\bin\b/.test(s)) return parseChance(s, 'in');
      if (s.includes('/')) return parseChance(s, 'frac');
      if (s.includes(':') || /\bto\b/.test(s)) return parseChance(s, 'for');
      if (/^[+-]\d{3,}$/.test(s)) return parseChance(s, 'us');
      if (/^\d*\.?\d+$/.test(s)) { const v = Number(s); return chk(v <= 1 ? v : v / 100); }
      throw new Error('Try 25%, 1 in 4, 1/4, 1:3 or +300');
  }
}
function chanceForms(p) {
  const odds = (a, b) => (b === 0 ? '—' : a / b >= 1 ? `${num(a / b, 2)}:1` : `1:${num(b / a, 2)}`);
  return [
    ['Percent', pct(p)],
    ['1 in N', p > 0 ? `1 in ${big(1 / p)}` : 'never'],
    ['Fraction', fraction(p)],
    ['Odds for', p > 0 && p < 1 ? odds(p, 1 - p) : '—'],
    ['Odds against', p > 0 && p < 1 ? odds(1 - p, p) : '—'],
    ['Decimal odds', p > 0 ? num(1 / p, 3) : '—'],
    ['American odds', p > 0 && p < 1 ? (p <= 0.5 ? `+${Math.round((1 - p) / p * 100)}` : `−${Math.round(p / (1 - p) * 100)}`) : '—'],
  ];
}

// ---------------------------------------------------------------- the mix items

const MIX_TYPES = [['dice', 'Dice', 'dice'], ['coin', 'Coin', 'coin'], ['pick', 'Pick', 'list-check'], ['chance', 'Chance', 'percent'], ['number', 'Number', 'hash']];
const newItem = (type) => ({ id: uid(), type, label: '', expr: '1d20', n: 1, p: 50, list: '', text: 'Common *60\nRare *30\nLegendary *10', chance: '25%', min: 1, max: 100, dec: 0 });

// ---------------------------------------------------------------- the editor

const MODES = [['dice', 'Dice', 'dice'], ['coin', 'Coin', 'coin'], ['pick', 'Pick', 'list-check'], ['chance', 'Chance', 'percent'], ['number', 'Number', 'hash'], ['mix', 'Mix', 'layers']];
const QUICK_DICE = [2, 4, 6, 8, 10, 12, 20, 100];

export class OddsEditor extends BaseEditor {
  static mode = 'odds';

  async load() {
    const s = this.app.settings.odds || {};
    this.st = {
      mode: MODES.some((m) => m[0] === s.mode) ? s.mode : 'dice',
      dice: { expr: '2d6', times: 1, ...s.dice },
      coin: { n: 1, p: 50, a: 'Heads', b: 'Tails', ...s.coin },
      lists: Array.isArray(s.lists) && s.lists.length ? s.lists : [{ id: uid(), name: 'Dinner', text: 'Pizza *2\nTacos\nCurry\nSushi\nPasta\nBurgers', out: [] }],
      listId: s.listId,
      pick: { n: 1, unique: true, elim: false, teams: 2, ...s.pick },
      chance: { value: '1 in 6', fmt: 'auto', tries: 10, ...s.chance },
      number: { min: 1, max: 100, count: 1, dec: 0, unique: true, sort: false, ...s.number },
      mixes: Array.isArray(s.mixes) && s.mixes.length ? s.mixes : [{ id: uid(), name: 'Loot', items: [
        { ...newItem('dice'), label: 'Gold', expr: '3d6' },
        { ...newItem('pick'), label: 'Rarity' },
        { ...newItem('chance'), label: 'Bonus item', chance: '1 in 5' },
      ] }],
      mixId: s.mixId,
      history: Array.isArray(s.history) ? s.history : [],
    };
    if (!this.st.lists.some((l) => l.id === this.st.listId)) this.st.listId = this.st.lists[0].id;
    if (!this.st.mixes.some((m) => m.id === this.st.mixId)) this.st.mixId = this.st.mixes[0].id;
    this.root = h('div', { class: 'odds-root' });
    this.pane.append(this.root);
    this.render();
  }

  save(now = false) {
    clearTimeout(this.saveTimer);
    const run = () => { this.saveTimer = null; this.st.history = this.st.history.slice(0, MAX_HISTORY); this.app.saveSettings({ odds: structuredClone(this.st) }); };
    if (now) return run();
    this.saveTimer = setTimeout(run, 400);
  }

  get list() { return this.st.lists.find((l) => l.id === this.st.listId) || this.st.lists[0]; }
  get mix() { return this.st.mixes.find((m) => m.id === this.st.mixId) || this.st.mixes[0]; }

  log(kind, label, text) {
    this.st.history.unshift({ t: Date.now(), kind, label, text });
    if (this.st.history.length > MAX_HISTORY) this.st.history.length = MAX_HISTORY;
    this.save();
    this.renderHistory();
    this.refreshStatus();
  }

  render() {
    clear(this.root).append(
      h('div', { class: 'odds-side' },
        h('div', { class: 'clock-sec-title odds-side-title' }, 'Roll'),
        ...MODES.map(([id, name, ic]) => h('button', { class: 'odds-mode' + (this.st.mode === id ? ' active' : ''),
          onclick: () => { this.st.mode = id; this.save(); this.render(); this.refreshStatus(); } }, icon(ic, 'sm'), h('span', {}, name)))),
      this.main = h('div', { class: 'odds-main' }),
      h('div', { class: 'odds-history' },
        h('div', { class: 'odds-history-head' }, h('span', { class: 'clock-sec-title' }, 'History'), h('div', { class: 'grow' }),
          h('button', { class: 'btn sm ghost', onclick: () => this.clearHistory() }, icon('trash', 'sm'), 'Clear')),
        this.histEl = h('div', { class: 'odds-history-list' })));
    this[`render_${this.st.mode}`]();
    this.renderHistory();
  }

  renderHistory() {
    clear(this.histEl);
    if (!this.st.history.length) { this.histEl.append(h('div', { class: 'faint odds-history-empty' }, 'Every roll lands here.')); return; }
    const icons = Object.fromEntries(MODES.map((m) => [m[0], m[2]]));
    for (const x of this.st.history.slice(0, 150)) {
      this.histEl.append(h('div', { class: 'odds-hrow', title: `${new Date(x.t).toLocaleString()} · right-click to copy`,
        oncontextmenu: (e) => contextMenu(e, [{ label: 'Copy', icon: 'copy', action: () => navigator.clipboard.writeText(`${x.label}: ${x.text}`) }]) },
      icon(icons[x.kind] || 'dice', 'sm'),
      h('div', { class: 'odds-hbody' }, h('div', { class: 'odds-hlabel faint' }, x.label), h('div', { class: 'odds-htext' }, x.text))));
    }
  }

  clearHistory() {
    if (!this.st.history.length) return;
    const before = this.st.history;
    this.st.history = [];
    this.save(); this.renderHistory();
    toast('History cleared', { action: { label: 'Undo', fn: () => { this.st.history = before; this.save(); this.renderHistory(); } } });
  }

  // small builders
  field(label, input, tip) { return h('label', { class: 'odds-field', title: tip || '' }, h('span', { class: 'odds-field-label' }, label), input); }
  numIn(obj, key, { min, max, step = 1, width = 80, onchange } = {}) {
    const el = h('input', { type: 'number', value: String(obj[key]), min: min ?? '', max: max ?? '', step: String(step), style: { width: width + 'px' } });
    el.addEventListener('change', () => {
      let v = Number(el.value);
      if (!Number.isFinite(v)) v = obj[key];
      if (min != null) v = Math.max(min, v);
      if (max != null) v = Math.min(max, v);
      obj[key] = v; el.value = String(v);
      this.save(); onchange?.();
    });
    return el;
  }
  check(obj, key, label, onchange) {
    const cb = h('input', { type: 'checkbox', checked: !!obj[key] });
    cb.addEventListener('change', () => { obj[key] = cb.checked; this.save(); onchange?.(); });
    return h('label', { class: 'odds-check' }, cb, label);
  }
  head(title, sub) { return h('div', { class: 'odds-head' }, h('div', { class: 'odds-title' }, title), sub ? h('div', { class: 'faint odds-sub' }, sub) : null); }
  pop(el) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }

  // ------------------------------------------------------------ dice
  render_dice() {
    const D = this.st.dice;
    const input = h('input', { type: 'text', class: 'odds-dice-input mono', value: D.expr, spellcheck: 'false', placeholder: '2d6+3' });
    const err = h('div', { class: 'odds-err' });
    const result = h('div', { class: 'odds-result' }, h('div', { class: 'odds-big faint' }, '—'));
    const stats = h('div', { class: 'odds-stats' });
    let odds = null, oddsKey = null;
    const refresh = () => {
      err.textContent = '';
      try {
        const terms = parseDice(input.value);
        const key = JSON.stringify(terms);
        if (key !== oddsKey) { oddsKey = key; odds = diceOdds(terms); }
        this.drawDist(stats, odds, null);
        return terms;
      } catch (e) { err.textContent = e.message; clear(stats); oddsKey = null; return null; }
    };
    input.addEventListener('input', () => { D.expr = input.value; this.save(); refresh(); });
    const roll = () => {
      const terms = refresh();
      if (!terms) return;
      const rolls = Array.from({ length: D.times }, () => rollDice(terms));
      clear(result);
      for (const r of rolls.slice(0, 50)) {
        result.append(h('div', { class: 'odds-roll' },
          h('div', { class: 'odds-big mono' }, String(r.total)),
          h('div', { class: 'odds-chips' }, ...r.parts.flatMap((p) => (p.t.const != null
            ? [h('span', { class: 'odds-chip const' }, `${p.t.sign < 0 ? '−' : '+'}${p.t.const}`)]
            : p.dice.slice(0, 200).map((d) => h('span', {
              class: 'odds-chip' + (d.kept ? '' : ' dropped') + (p.t.succ && d.kept && passes(d.total, p.t.succ) ? ' hit' : '')
                + (!p.t.fudge && !p.t.succ && d.v === p.t.sides ? ' max' : '') + (!p.t.fudge && d.v === 1 && p.t.sides > 1 ? ' min' : '') + (p.t.sign < 0 ? ' neg' : ''),
              title: `d${p.t.fudge ? 'F' : p.t.sides}${d.first != null ? ` · rerolled a ${d.first}` : ''}${d.ex.length ? ` · exploded: ${d.ex.join(', ')}` : ''}${d.kept ? '' : ' · dropped'}`,
            }, p.t.fudge ? (d.v > 0 ? '+' : d.v < 0 ? '−' : '0') : String(d.total))))))));
      }
      if (rolls.length > 50) result.append(h('div', { class: 'faint' }, `…and ${rolls.length - 50} more (all in the history)`));
      if (rolls.length > 1) {
        const tot = rolls.map((r) => r.total);
        result.prepend(h('div', { class: 'faint odds-sum' }, `${rolls.length} rolls · sum ${big(tot.reduce((a, b) => a + b, 0))} · average ${num(tot.reduce((a, b) => a + b, 0) / tot.length, 2)} · high ${Math.max(...tot)} · low ${Math.min(...tot)}`));
      }
      this.pop(result);
      this.drawDist(stats, odds, rolls[rolls.length - 1].total);
      this.log('dice', input.value.trim(), rolls.length === 1 ? `${rolls[0].total}  ${diceLine(rolls[0])}` : rolls.map((r) => r.total).join(', '));
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') roll(); });
    const add = (sides) => {
      const re = new RegExp(`(^|[+])(\\d*)d${sides}(?![\\d%f])(?=$|[+-])`, 'i');
      const v = input.value.trim();
      input.value = re.test(v) ? v.replace(re, (m, pre, n) => `${pre}${(Number(n) || 1) + 1}d${sides}`) : (v ? `${v}+1d${sides}` : `1d${sides}`);
      D.expr = input.value; this.save(); refresh();
    };
    const custom = h('input', { type: 'number', min: '1', max: String(MAX_SIDES), placeholder: 'any', style: { width: '70px' } });
    custom.addEventListener('keydown', (e) => { if (e.key === 'Enter' && Number(custom.value) >= 1) add(Math.floor(Number(custom.value))); });
    clear(this.main).append(
      this.head('Dice', 'Any number of dice with any number of sides, mixed together.'),
      h('div', { class: 'odds-row' }, input,
        this.field('Times', this.numIn(D, 'times', { min: 1, max: 1000, width: 70 })),
        h('button', { class: 'btn primary odds-go', onclick: roll }, icon('dice', 'sm'), 'Roll')),
      err,
      h('div', { class: 'odds-row wrap' },
        ...QUICK_DICE.map((s) => h('button', { class: 'chip', onclick: () => add(s), title: `Add a d${s}` }, `d${s}`)),
        h('span', { class: 'odds-custom' }, 'd', custom, h('button', { class: 'chip', onclick: () => Number(custom.value) >= 1 && add(Math.floor(Number(custom.value))) }, '+ add')),
        h('button', { class: 'chip ghost', onclick: () => { input.value = ''; D.expr = ''; this.save(); refresh(); input.focus(); } }, 'clear')),
      h('div', { class: 'odds-row wrap' },
        ...[['Advantage', '2d20kh1'], ['Disadvantage', '2d20kl1'], ['4d6 drop lowest', '4d6dl1'], ['Exploding d6', '1d6!'], ['Fudge', '4dF'], ['10 dice, 7+ hits', '10d10>=7'], ['Percentile', 'd%']]
          .map(([l, x]) => h('button', { class: 'chip ghost', onclick: () => { input.value = x; D.expr = x; this.save(); refresh(); } }, l))),
      result, stats,
      h('div', { class: 'odds-help faint' },
        h('b', {}, 'How to write dice: '), h('span', { class: 'mono' }, '3d6'), ' three six-sided · ', h('span', { class: 'mono' }, 'd20+5'), ' add · ',
        h('span', { class: 'mono' }, '2d8-1d4'), ' subtract · ', h('span', { class: 'mono' }, 'kh2 / kl1'), ' keep highest / lowest · ',
        h('span', { class: 'mono' }, 'dl1 / dh1'), ' drop lowest / highest · ', h('span', { class: 'mono' }, '!'), ' explode on max · ',
        h('span', { class: 'mono' }, 'r1'), ' reroll 1s once (r2: 2 or less) · ', h('span', { class: 'mono' }, '>=5'), ' count dice that hit · ',
        h('span', { class: 'mono' }, 'dF'), ' fudge · ', h('span', { class: 'mono' }, 'd%'), ' 1–100 · ', h('span', { class: 'mono' }, 'adv / dis')));
    refresh();
    setTimeout(() => { if (this.tab === this.app.active) input.focus(); }, 0);
  }

  /** The bar chart of every total, with the last roll lit. */
  drawDist(box, odds, last) {
    clear(box);
    if (!odds || !odds.dist.size) return;
    const entries = [...odds.dist];
    const mean = entries.reduce((a, [v, p]) => a + v * p, 0);
    const lo = entries[0][0], hi = entries[entries.length - 1][0];
    const ap = odds.exact ? '' : '≈ ';
    const at = (v) => odds.dist.get(v) || 0;
    const ge = (v) => entries.reduce((a, [x, p]) => a + (x >= v ? p : 0), 0);
    const le = (v) => entries.reduce((a, [x, p]) => a + (x <= v ? p : 0), 0);
    // up to 60 bars; wide ranges share a bar
    const span = hi - lo + 1, per = Math.max(1, Math.ceil(span / 60));
    const bars = [];
    for (let v = lo; v <= hi; v += per) {
      let p = 0;
      for (const [x, q] of entries) if (x >= v && x < v + per) p += q;
      bars.push({ v, to: v + per - 1, p });
    }
    const top = Math.max(...bars.map((b) => b.p));
    box.append(
      h('div', { class: 'odds-statline' },
        h('span', {}, `Lowest `, h('b', {}, big(lo))), h('span', {}, `Highest `, h('b', {}, odds.exact ? big(hi) : `${big(hi)}+`)), h('span', {}, `Average `, h('b', {}, ap + num(mean, 2))),
        last != null ? h('span', { class: 'odds-lastodds' }, `Rolling exactly ${last}: `, h('b', {}, ap + pct(at(last))), ` · ${last} or more: `, h('b', {}, ap + pct(ge(last))), ` · ${last} or less: `, h('b', {}, ap + pct(le(last)))) : null),
      h('div', { class: 'odds-dist' }, ...bars.map((b) => h('div', {
        class: 'odds-bar' + (last != null && last >= b.v && last <= b.to ? ' on' : ''),
        title: `${b.v === b.to ? b.v : `${b.v}–${b.to}`}: ${ap}${pct(b.p)}`,
      }, h('div', { style: { height: `${top ? Math.max(1, (b.p / top) * 100) : 0}%` } })))),
      h('div', { class: 'odds-dist-axis faint mono' }, h('span', {}, big(lo)), h('span', {}, odds.exact ? 'every total, worked out exactly' : `from ${big(odds.runs)} practice rolls`), h('span', {}, big(hi))));
  }

  // ------------------------------------------------------------ coin
  render_coin() {
    const C = this.st.coin;
    const result = h('div', { class: 'odds-result' }, h('div', { class: 'odds-big faint' }, '—'));
    const nameA = h('input', { type: 'text', value: C.a, style: { width: '110px' } });
    const nameB = h('input', { type: 'text', value: C.b, style: { width: '110px' } });
    nameA.addEventListener('change', () => { C.a = nameA.value.trim() || 'Heads'; this.save(); });
    nameB.addEventListener('change', () => { C.b = nameB.value.trim() || 'Tails'; this.save(); });
    const flip = () => {
      const p = C.p / 100, n = C.n;
      const seq = Array.from({ length: n }, () => rand01() < p);
      const k = seq.filter(Boolean).length;
      let run = 0, best = 0, bestSide = true;
      seq.forEach((x, i) => { run = i && x === seq[i - 1] ? run + 1 : 1; if (run > best) { best = run; bestSide = x; } });
      clear(result);
      if (n === 1) {
        const coin = h('div', { class: 'odds-coin' + (seq[0] ? '' : ' b') }, h('div', { class: 'odds-coin-face a' }, C.a), h('div', { class: 'odds-coin-face b' }, C.b));
        result.append(coin, h('div', { class: 'odds-big' }, seq[0] ? C.a : C.b));
      } else {
        let atLeast = 0;
        for (let i = k; i <= n; i++) atLeast += binomPmf(n, i, p);
        result.append(
          h('div', { class: 'odds-coin-counts' },
            h('div', {}, h('div', { class: 'odds-big mono' }, big(k)), h('div', { class: 'faint' }, `${C.a} · ${pct(k / n)}`)),
            h('div', {}, h('div', { class: 'odds-big mono' }, big(n - k)), h('div', { class: 'faint' }, `${C.b} · ${pct((n - k) / n)}`))),
          h('div', { class: 'odds-split' }, h('div', { style: { width: `${(k / n) * 100}%` } })),
          h('div', { class: 'faint' }, `Longest run: ${best} × ${bestSide ? C.a : C.b} · exactly ${k} ${C.a}: ${pct(binomPmf(n, k, p))} · ${k} or more: ${pct(atLeast)}`),
          n <= 400 ? h('div', { class: 'odds-seq mono' }, ...seq.map((x) => h('span', { class: x ? 'a' : 'b' }, (x ? C.a : C.b)[0].toUpperCase()))) : null);
      }
      this.pop(result);
      this.log('coin', n === 1 ? `Coin${C.p !== 50 ? ` (${C.p}% ${C.a})` : ''}` : `${n} coins${C.p !== 50 ? ` (${C.p}% ${C.a})` : ''}`,
        n === 1 ? (seq[0] ? C.a : C.b) : `${k} ${C.a}, ${n - k} ${C.b}`);
    };
    const pIn = this.numIn(C, 'p', { min: 0, max: 100, step: 0.1, width: 80 });
    clear(this.main).append(
      this.head('Coin', 'Flip one or thousands. Weight it if you like, and name the sides.'),
      h('div', { class: 'odds-row wrap' },
        this.field('Coins', this.numIn(C, 'n', { min: 1, max: 100000, width: 90 })),
        this.field(`Chance of ${C.a} (%)`, pIn, '50 is a fair coin'),
        this.field('Sides', h('span', { class: 'odds-row tight' }, nameA, nameB)),
        h('button', { class: 'btn primary odds-go', onclick: flip }, icon('coin', 'sm'), 'Flip')),
      h('div', { class: 'odds-row wrap' }, ...[['Fair', 50], ['60 / 40', 60], ['75 / 25', 75], ['90 / 10', 90]].map(([l, v]) => h('button', { class: 'chip ghost', onclick: () => { C.p = v; pIn.value = String(v); this.save(); } }, l)),
        ...[1, 10, 100, 1000].map((v) => h('button', { class: 'chip ghost', onclick: () => { C.n = v; this.save(); this.render(); } }, `${v} coin${v === 1 ? '' : 's'}`))),
      result);
  }

  // ------------------------------------------------------------ pick
  render_pick() {
    const P = this.st.pick, L = this.list;
    L.out = L.out || [];
    const sel = h('select', {}, ...this.st.lists.map((l) => h('option', { value: l.id, selected: l.id === L.id }, l.name)));
    sel.addEventListener('change', () => { this.st.listId = sel.value; this.save(); this.render(); });
    const ta = h('textarea', { class: 'input odds-list-text mono', rows: '12', spellcheck: 'false', placeholder: 'One choice per line\nPizza *3   (three times as likely)\n# a note' });
    ta.value = L.text;
    const table = h('div', { class: 'odds-table' });
    const result = h('div', { class: 'odds-result' }, h('div', { class: 'odds-big faint' }, '—'));
    const opts = () => parseOptions(L.text).filter((o) => !(P.elim && L.out.includes(o.name)));
    const drawTable = () => {
      const all = parseOptions(L.text), sum = all.filter((o) => !(P.elim && L.out.includes(o.name))).reduce((a, o) => a + o.w, 0);
      clear(table).append(...all.map((o) => {
        const out = P.elim && L.out.includes(o.name);
        const p = out || !sum ? 0 : o.w / sum;
        return h('div', { class: 'odds-trow' + (out ? ' out' : '') },
          h('span', { class: 'odds-tname' }, o.name),
          h('span', { class: 'odds-tbar' }, h('span', { style: { width: `${p * 100}%` } })),
          h('span', { class: 'odds-tp mono' }, out ? 'picked' : pct(p)));
      }));
      if (!all.length) table.append(h('div', { class: 'faint' }, 'Type the choices on the left, one per line.'));
    };
    ta.addEventListener('input', () => { L.text = ta.value; this.save(); drawTable(); });
    const go = (how) => {
      const o = opts();
      if (!o.length) { toast(P.elim && parseOptions(L.text).length ? 'Everything’s been picked. Reset to start over.' : 'Add some choices first.'); return; }
      clear(result);
      let text;
      if (how === 'pick') {
        const n = Math.min(P.n, P.unique ? o.filter((x) => x.w > 0).length : P.n);
        const got = pickWeighted(o, n, P.unique);
        result.append(...got.map((g, i) => h('div', { class: got.length === 1 ? 'odds-big' : 'odds-picked' }, got.length > 1 ? h('span', { class: 'faint mono' }, `${i + 1}.`) : null, g.name)));
        if (P.elim) { L.out.push(...got.map((g) => g.name)); drawTable(); }
        text = got.map((g) => g.name).join(', ');
      } else if (how === 'shuffle') {
        const order = shuffle(o);
        result.append(h('ol', { class: 'odds-order' }, ...order.map((g) => h('li', {}, g.name))));
        text = order.map((g) => g.name).join(' → ');
      } else {
        const order = shuffle(o), teams = Array.from({ length: Math.min(P.teams, order.length) }, () => []);
        order.forEach((g, i) => teams[i % teams.length].push(g.name));
        result.append(h('div', { class: 'odds-teams' }, ...teams.map((t, i) => h('div', { class: 'odds-team' }, h('div', { class: 'clock-sec-title' }, `Group ${i + 1}`), ...t.map((n) => h('div', {}, n))))));
        text = teams.map((t, i) => `${i + 1}: ${t.join(', ')}`).join(' · ');
      }
      this.pop(result);
      this.save();
      this.log('pick', `${L.name} · ${how === 'pick' ? 'pick' : how === 'shuffle' ? 'shuffle' : `${P.teams} groups`}`, text);
    };
    clear(this.main).append(
      this.head('Pick', 'Pick from a list. Lines ending in *N are N times as likely (*0 leaves one out).'),
      h('div', { class: 'odds-row wrap' }, sel,
        h('button', { class: 'btn sm ghost', onclick: () => this.newList() }, icon('plus', 'sm'), 'New list'),
        h('button', { class: 'btn sm ghost', onclick: () => this.renameList() }, icon('edit', 'sm'), 'Rename'),
        h('button', { class: 'btn sm ghost', onclick: () => this.deleteList() }, icon('trash', 'sm'), 'Delete')),
      h('div', { class: 'odds-pick-grid' }, ta, table),
      h('div', { class: 'odds-row wrap' },
        this.field('How many', this.numIn(P, 'n', { min: 1, max: 1000, width: 70 })),
        this.check(P, 'unique', 'No repeats'),
        this.check(P, 'elim', 'Set picked ones aside', () => drawTable()),
        P.elim && L.out.length ? h('button', { class: 'btn sm ghost', onclick: () => { L.out = []; this.save(); this.render(); } }, icon('refresh', 'sm'), `Reset (${L.out.length} aside)`) : null,
        h('div', { class: 'grow' }),
        h('button', { class: 'btn primary odds-go', onclick: () => go('pick') }, icon('list-check', 'sm'), 'Pick')),
      h('div', { class: 'odds-row wrap' },
        h('button', { class: 'btn', onclick: () => go('shuffle') }, icon('shuffle', 'sm'), 'Shuffle the order'),
        h('button', { class: 'btn', onclick: () => go('teams') }, icon('columns', 'sm'), 'Split into groups'),
        this.field('Groups', this.numIn(P, 'teams', { min: 2, max: 100, width: 70 }))),
      result);
    drawTable();
  }

  async newList() {
    const name = (await promptDialog('New list', 'Name', '', { placeholder: 'e.g. Who goes first' }) || '').trim();
    if (!name) return;
    const l = { id: uid(), name, text: '', out: [] };
    this.st.lists.push(l); this.st.listId = l.id;
    this.save(); this.render();
    this.main.querySelector('textarea')?.focus();
  }
  async renameList() {
    const L = this.list;
    const name = (await promptDialog('Rename list', 'Name', L.name) || '').trim();
    if (!name) return;
    L.name = name; this.save(); this.render();
  }
  async deleteList() {
    const L = this.list;
    if (L.text.trim() && !(await confirmDialog(`Delete “${L.name}”?`, 'Its choices go with it.', { okLabel: 'Delete', danger: true }))) return;
    this.st.lists = this.st.lists.filter((l) => l !== L);
    if (!this.st.lists.length) this.st.lists.push({ id: uid(), name: 'List', text: '', out: [] });
    this.st.listId = this.st.lists[0].id;
    this.save(); this.render();
  }

  // ------------------------------------------------------------ chance
  render_chance() {
    const C = this.st.chance;
    const input = h('input', { type: 'text', class: 'mono odds-chance-input', value: C.value, spellcheck: 'false' });
    const fmt = h('select', {}, ...CHANCE_FORMATS.map(([id, l]) => h('option', { value: id, selected: id === C.fmt }, l)));
    const err = h('div', { class: 'odds-err' });
    const forms = h('div', { class: 'odds-forms' });
    const tries = h('div', { class: 'odds-tries' });
    const result = h('div', { class: 'odds-result' }, h('div', { class: 'odds-big faint' }, '—'));
    let p = null;
    const refresh = () => {
      err.textContent = '';
      try { p = parseChance(input.value, C.fmt); } catch (e) { p = null; err.textContent = e.message; }
      clear(forms); clear(tries);
      if (p == null) return;
      forms.append(...chanceForms(p).map(([k, v]) => h('div', { class: 'odds-form' }, h('span', { class: 'faint' }, k), h('b', { class: 'mono' }, v))));
      const K = C.tries;
      const need = (q) => (p >= 1 ? 1 : p <= 0 ? '—' : big(Math.ceil(Math.log(1 - q) / Math.log1p(-p))));
      tries.append(
        h('div', {}, `In ${big(K)} tr${K === 1 ? 'y' : 'ies'}: at least once `, h('b', {}, pct(1 - (1 - p) ** K)), ' · never ', h('b', {}, pct((1 - p) ** K)), ' · about ', h('b', {}, num(K * p, 2)), ' hits on average'),
        h('div', {}, 'Tries to be 50% sure of a hit: ', h('b', {}, need(0.5)), ' · 90%: ', h('b', {}, need(0.9)), ' · 99%: ', h('b', {}, need(0.99))));
    };
    input.addEventListener('input', () => { C.value = input.value; this.save(); refresh(); });
    fmt.addEventListener('change', () => { C.fmt = fmt.value; this.save(); refresh(); });
    const once = () => {
      if (p == null) return;
      const hit = rand01() < p;
      clear(result).append(h('div', { class: 'odds-big ' + (hit ? 'yes' : 'no') }, hit ? 'Yes, it happens' : 'No'), h('div', { class: 'faint' }, `${pct(p)} chance`));
      this.pop(result);
      this.log('chance', `${input.value.trim()} (${pct(p)})`, hit ? 'Yes' : 'No');
    };
    const many = () => {
      if (p == null) return;
      const K = C.tries, hits = [];
      for (let i = 1; i <= K; i++) if (rand01() < p) hits.push(i);
      clear(result).append(h('div', { class: 'odds-big mono' }, `${big(hits.length)} / ${big(K)}`), h('div', { class: 'faint' }, hits.length ? `hits on tr${hits.length === 1 ? 'y' : 'ies'} ${hits.slice(0, 60).join(', ')}${hits.length > 60 ? '…' : ''}` : 'no hits at all'));
      this.pop(result);
      this.log('chance', `${input.value.trim()} × ${K}`, `${hits.length} hit${hits.length === 1 ? '' : 's'}`);
    };
    const until = () => {
      if (p == null) return;
      if (p <= 0) { toast('A 0% chance never happens.'); return; }
      let n = 1;
      while (rand01() >= p && n < 1e8) n++;
      clear(result).append(h('div', { class: 'odds-big mono' }, big(n)), h('div', { class: 'faint' }, `tr${n === 1 ? 'y' : 'ies'} until it happened (about ${big(1 / p)} on average)`));
      this.pop(result);
      this.log('chance', `${input.value.trim()} until it hits`, `${n} tr${n === 1 ? 'y' : 'ies'}`);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') once(); });
    clear(this.main).append(
      this.head('Chance', 'Write a chance any way you like. See it every other way, then roll it.'),
      h('div', { class: 'odds-row wrap' }, input, fmt, h('button', { class: 'btn primary odds-go', onclick: once }, icon('percent', 'sm'), 'Roll it')),
      err, forms,
      h('div', { class: 'odds-row wrap' },
        this.field('Tries', this.numIn(C, 'tries', { min: 1, max: 1e6, width: 90, onchange: refresh })),
        h('button', { class: 'btn', onclick: many }, icon('repeat', 'sm'), 'Roll every try'),
        h('button', { class: 'btn', onclick: until }, icon('fast-forward', 'sm'), 'Roll until it happens')),
      tries, result);
    refresh();
  }

  // ------------------------------------------------------------ number
  render_number() {
    const N = this.st.number;
    const result = h('div', { class: 'odds-result' }, h('div', { class: 'odds-big faint' }, '—'));
    const go = () => {
      let { min, max, count, dec, unique, sort } = N;
      if (min > max) [min, max] = [max, min];
      const f = 10 ** dec, lo = Math.ceil(min * f), hi = Math.floor(max * f), size = hi - lo + 1;
      if (size < 1) { toast('There’s no number like that in the range.'); return; }
      if (unique && count > size) { toast(`Only ${big(size)} different numbers fit in that range.`); return; }
      let vals;
      if (unique) {
        if (size <= 2e6 && count > size / 4) { // partial shuffle
          const swap = new Map();
          vals = [];
          for (let i = 0; i < count; i++) {
            const j = i + randInt(size - i);
            const vi = swap.has(i) ? swap.get(i) : i, vj = swap.has(j) ? swap.get(j) : j;
            swap.set(j, vi); vals.push(vj);
          }
        } else { const seen = new Set(); while (seen.size < count) seen.add(randInt(size)); vals = [...seen]; }
      } else vals = Array.from({ length: count }, () => randInt(size));
      vals = vals.map((v) => (lo + v) / f);
      if (sort) vals.sort((a, b) => a - b);
      const txt = vals.map((v) => v.toFixed(dec));
      clear(result).append(count === 1 ? h('div', { class: 'odds-big mono' }, txt[0]) : h('div', { class: 'odds-numbers mono' }, ...txt.slice(0, 2000).map((t) => h('span', {}, t))));
      if (count > 2000) result.append(h('div', { class: 'faint' }, `…and ${big(count - 2000)} more`));
      this.pop(result);
      this.log('number', `${count === 1 ? '' : `${count} × `}${min.toFixed(dec)}–${max.toFixed(dec)}`, txt.slice(0, 100).join(', ') + (count > 100 ? ' …' : ''));
    };
    clear(this.main).append(
      this.head('Number', 'Random numbers in a range: whole or with decimals, with or without repeats.'),
      h('div', { class: 'odds-row wrap' },
        this.field('From', this.numIn(N, 'min', { step: 'any', width: 110 })),
        this.field('To', this.numIn(N, 'max', { step: 'any', width: 110 })),
        this.field('How many', this.numIn(N, 'count', { min: 1, max: 100000, width: 90 })),
        this.field('Decimals', this.numIn(N, 'dec', { min: 0, max: 10, width: 60 })),
        this.check(N, 'unique', 'No repeats'),
        this.check(N, 'sort', 'Sorted'),
        h('button', { class: 'btn primary odds-go', onclick: go }, icon('hash', 'sm'), 'Generate')),
      h('div', { class: 'odds-row wrap' }, ...[['1–10', 1, 10], ['1–100', 1, 100], ['0–1', 0, 1, 3], ['Lottery 6 of 49', 1, 49, 0, 6]].map(([l, a, b, d = 0, c = 1]) =>
        h('button', { class: 'chip ghost', onclick: () => { Object.assign(N, { min: a, max: b, dec: d, count: c, unique: true, sort: c > 1 }); this.save(); this.render(); } }, l))),
      result);
  }

  // ------------------------------------------------------------ mix
  render_mix() {
    const M = this.mix;
    const sel = h('select', {}, ...this.st.mixes.map((m) => h('option', { value: m.id, selected: m.id === M.id }, m.name)));
    sel.addEventListener('change', () => { this.st.mixId = sel.value; this.save(); this.render(); });
    const result = h('div', { class: 'odds-result odds-mix-result' }, h('div', { class: 'odds-big faint' }, '—'));
    const items = h('div', { class: 'odds-mix-items' });
    const drawItems = () => {
      clear(items).append(...M.items.map((it, i) => this.mixItem(M, it, i, drawItems)));
      if (!M.items.length) items.append(h('div', { class: 'faint' }, 'Add something to roll below.'));
    };
    const rollAll = () => {
      if (!M.items.length) return;
      const out = M.items.map((it) => { try { return [it, this.rollItem(it)]; } catch (e) { return [it, { text: e.message, err: true }]; } });
      clear(result).append(...out.map(([it, r]) => h('div', { class: 'odds-mix-row' + (r.err ? ' err' : '') },
        h('span', { class: 'odds-mix-label' }, icon(MIX_TYPES.find((t) => t[0] === it.type)[2], 'sm'), this.itemName(it)),
        h('span', { class: 'odds-mix-val' }, r.text),
        r.detail ? h('span', { class: 'faint mono odds-mix-detail' }, r.detail) : null)));
      this.pop(result);
      this.log('mix', M.name, out.map(([it, r]) => `${this.itemName(it)}: ${r.text}`).join(' · '));
    };
    clear(this.main).append(
      this.head('Mix', 'Roll any mix of dice, coins, picks, chances and numbers at once.'),
      h('div', { class: 'odds-row wrap' }, sel,
        h('button', { class: 'btn sm ghost', onclick: () => this.newMix() }, icon('plus', 'sm'), 'New mix'),
        h('button', { class: 'btn sm ghost', onclick: () => this.renameMix() }, icon('edit', 'sm'), 'Rename'),
        h('button', { class: 'btn sm ghost', onclick: () => this.deleteMix() }, icon('trash', 'sm'), 'Delete'),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn primary odds-go', onclick: rollAll }, icon('layers', 'sm'), 'Roll all')),
      items,
      h('div', { class: 'odds-row wrap' }, h('span', { class: 'faint' }, 'Add:'),
        ...MIX_TYPES.map(([type, name, ic]) => h('button', { class: 'chip', onclick: () => { M.items.push(newItem(type)); this.save(); drawItems(); } }, icon(ic, 'sm'), name))),
      result);
    drawItems();
  }

  itemName(it) { return it.label.trim() || MIX_TYPES.find((t) => t[0] === it.type)[1]; }

  mixItem(M, it, i, redraw) {
    const txt = (key, width, ph) => {
      const el = h('input', { type: 'text', value: it[key] ?? '', placeholder: ph || '', style: { width: width + 'px' } });
      el.addEventListener('input', () => { it[key] = el.value; this.save(); });
      return el;
    };
    let cfg;
    if (it.type === 'dice') cfg = [this.field('Dice', txt('expr', 140, '2d6+1'))];
    else if (it.type === 'coin') cfg = [this.field('Coins', this.numIn(it, 'n', { min: 1, max: 10000, width: 70 })), this.field('% heads', this.numIn(it, 'p', { min: 0, max: 100, step: 0.1, width: 70 }))];
    else if (it.type === 'chance') cfg = [this.field('Chance', txt('chance', 110, '25%'))];
    else if (it.type === 'number') cfg = [this.field('From', this.numIn(it, 'min', { step: 'any', width: 80 })), this.field('To', this.numIn(it, 'max', { step: 'any', width: 80 })), this.field('Decimals', this.numIn(it, 'dec', { min: 0, max: 10, width: 55 }))];
    else {
      const src = h('select', {}, h('option', { value: '', selected: !it.list }, 'Its own choices'), ...this.st.lists.map((l) => h('option', { value: l.id, selected: l.id === it.list }, `List: ${l.name}`)));
      src.addEventListener('change', () => { it.list = src.value; this.save(); redraw(); });
      const ta = h('textarea', { class: 'input mono odds-mix-text', rows: '3', spellcheck: 'false', placeholder: 'One per line, *N to weigh' });
      ta.value = it.text;
      ta.addEventListener('input', () => { it.text = ta.value; this.save(); });
      cfg = [this.field('From', src), this.field('How many', this.numIn(it, 'n', { min: 1, max: 100, width: 60 })), it.list ? null : ta];
    }
    return h('div', { class: 'odds-mix-item' },
      h('span', { class: 'odds-mix-type' }, icon(MIX_TYPES.find((t) => t[0] === it.type)[2], 'sm')),
      this.field('Name', txt('label', 120, MIX_TYPES.find((t) => t[0] === it.type)[1])),
      ...cfg,
      h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', 'data-tip': 'Up', disabled: i === 0, onclick: () => { M.items.splice(i - 1, 0, M.items.splice(i, 1)[0]); this.save(); redraw(); } }, icon('arrow-up', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Down', disabled: i === M.items.length - 1, onclick: () => { M.items.splice(i + 1, 0, M.items.splice(i, 1)[0]); this.save(); redraw(); } }, icon('arrow-down', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Remove', onclick: () => { M.items.splice(i, 1); this.save(); redraw(); } }, icon('x', 'sm')));
  }

  /** One mix item → { text, detail }. */
  rollItem(it) {
    if (it.type === 'dice') { const r = rollDice(parseDice(it.expr)); return { text: String(r.total), detail: `${it.expr.trim()} ${diceLine(r)}` }; }
    if (it.type === 'coin') {
      const p = it.p / 100;
      if (it.n === 1) return { text: rand01() < p ? 'Heads' : 'Tails' };
      let k = 0; for (let i = 0; i < it.n; i++) if (rand01() < p) k++;
      return { text: `${k} heads, ${it.n - k} tails` };
    }
    if (it.type === 'chance') { const p = parseChance(it.chance); return { text: rand01() < p ? 'Yes' : 'No', detail: pct(p) }; }
    if (it.type === 'number') {
      let { min, max, dec } = it; if (min > max) [min, max] = [max, min];
      const f = 10 ** dec, lo = Math.ceil(min * f), hi = Math.floor(max * f);
      if (hi < lo) throw new Error('No number fits');
      return { text: ((lo + randInt(hi - lo + 1)) / f).toFixed(dec) };
    }
    const L = it.list && this.st.lists.find((l) => l.id === it.list);
    const opts = parseOptions(L ? L.text : it.text);
    if (!opts.length) throw new Error('Nothing to pick from');
    return { text: pickWeighted(opts, it.n, true).map((o) => o.name).join(', ') };
  }

  async newMix() {
    const name = (await promptDialog('New mix', 'Name', '', { placeholder: 'e.g. Encounter' }) || '').trim();
    if (!name) return;
    const m = { id: uid(), name, items: [] };
    this.st.mixes.push(m); this.st.mixId = m.id;
    this.save(); this.render();
  }
  async renameMix() {
    const M = this.mix;
    const name = (await promptDialog('Rename mix', 'Name', M.name) || '').trim();
    if (!name) return;
    M.name = name; this.save(); this.render();
  }
  async deleteMix() {
    const M = this.mix;
    if (M.items.length && !(await confirmDialog(`Delete “${M.name}”?`, `Its ${M.items.length} item${M.items.length === 1 ? '' : 's'} go with it.`, { okLabel: 'Delete', danger: true }))) return;
    this.st.mixes = this.st.mixes.filter((m) => m !== M);
    if (!this.st.mixes.length) this.st.mixes.push({ id: uid(), name: 'Mix', items: [] });
    this.st.mixId = this.st.mixes[0].id;
    this.save(); this.render();
  }

  status() {
    if (!this.st) return { left: [], right: [] };
    const last = this.st.history[0];
    return { left: [{ text: MODES.find((m) => m[0] === this.st.mode)[1] }], right: [{ text: last ? `last: ${last.text.slice(0, 60)}` : '' }] };
  }

  destroy() { if (this.saveTimer) this.save(true); }
}
