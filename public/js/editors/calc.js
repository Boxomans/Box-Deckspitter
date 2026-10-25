// BoxCalc: a scientific calculator. Type a sum (or use the keys) and the answer shows as you go; Enter keeps it on the
// tape. Functions, constants, degrees or radians, memory, your own variables (x = 5) and hex/binary for whole answers.
// Kept in settings.calc (the tape, variables, memory and the angle mode).

import { BaseEditor } from './base.js';
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, contextMenu } from '../core/ui.js';

const MAX_TAPE = 200;

// ---------------------------------------------------------------- the maths

const FACT_MAX = 170;
function gamma(x) { // Lanczos
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return Math.sqrt(2 * Math.PI) * t ** (x + 0.5) * Math.exp(-t) * a;
}
function factorial(n) {
  if (Number.isInteger(n)) {
    if (n < 0) throw new Error('No factorial of a negative whole number');
    if (n > FACT_MAX) return Infinity;
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  }
  return gamma(n + 1);
}
function choose(n, r) {
  if (!Number.isInteger(n) || !Number.isInteger(r) || r < 0 || n < 0) throw new Error('nCr takes whole numbers');
  if (r > n) return 0;
  r = Math.min(r, n - r);
  let x = 1;
  for (let i = 1; i <= r; i++) x = x * (n - r + i) / i;
  return Math.round(x);
}
function perm(n, r) {
  if (!Number.isInteger(n) || !Number.isInteger(r) || r < 0 || n < 0) throw new Error('nPr takes whole numbers');
  if (r > n) return 0;
  let x = 1;
  for (let i = 0; i < r; i++) x *= n - i;
  return x;
}
const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };

/** name → [min args, max args, fn(deg)(...args)] */
const FUNCS = {
  sin: [1, 1, (d) => (x) => Math.sin(d ? x * Math.PI / 180 : x)],
  cos: [1, 1, (d) => (x) => Math.cos(d ? x * Math.PI / 180 : x)],
  tan: [1, 1, (d) => (x) => {
    if (d && Math.abs(((x % 180) + 180) % 180 - 90) < 1e-12) throw new Error('tan of 90° is undefined');
    return Math.tan(d ? x * Math.PI / 180 : x);
  }],
  asin: [1, 1, (d) => (x) => Math.asin(x) * (d ? 180 / Math.PI : 1)],
  acos: [1, 1, (d) => (x) => Math.acos(x) * (d ? 180 / Math.PI : 1)],
  atan: [1, 1, (d) => (x) => Math.atan(x) * (d ? 180 / Math.PI : 1)],
  atan2: [2, 2, (d) => (y, x) => Math.atan2(y, x) * (d ? 180 / Math.PI : 1)],
  sinh: [1, 1, () => Math.sinh], cosh: [1, 1, () => Math.cosh], tanh: [1, 1, () => Math.tanh],
  asinh: [1, 1, () => Math.asinh], acosh: [1, 1, () => Math.acosh], atanh: [1, 1, () => Math.atanh],
  ln: [1, 1, () => Math.log], log: [1, 2, () => (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b))],
  log2: [1, 1, () => Math.log2], exp: [1, 1, () => Math.exp],
  sqrt: [1, 1, () => Math.sqrt], cbrt: [1, 1, () => Math.cbrt], root: [2, 2, () => (x, n) => (x < 0 && n % 2 === 1 ? -((-x) ** (1 / n)) : x ** (1 / n))],
  abs: [1, 1, () => Math.abs], sign: [1, 1, () => Math.sign],
  floor: [1, 1, () => Math.floor], ceil: [1, 1, () => Math.ceil], trunc: [1, 1, () => Math.trunc],
  round: [1, 2, () => (x, p = 0) => { const f = 10 ** p; return Math.round(x * f) / f; }],
  min: [1, 99, () => Math.min], max: [1, 99, () => Math.max],
  sum: [1, 99, () => (...a) => a.reduce((s, v) => s + v, 0)],
  avg: [1, 99, () => (...a) => a.reduce((s, v) => s + v, 0) / a.length],
  ncr: [2, 2, () => choose], npr: [2, 2, () => perm],
  gcd: [2, 99, () => (...a) => a.reduce(gcd)], lcm: [2, 99, () => (...a) => a.reduce((x, y) => Math.abs(x * y) / gcd(x, y))],
  hyp: [2, 2, () => Math.hypot], gamma: [1, 1, () => gamma], fact: [1, 1, () => factorial],
  rand: [0, 2, () => (a, b) => (a === undefined ? Math.random() : b === undefined ? Math.random() * a : a + Math.random() * (b - a))],
};
const CONSTS = { pi: Math.PI, 'π': Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2, inf: Infinity };

function tokenize(src) {
  const out = [];
  const s = src.replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').replace(/√/g, 'sqrt').replace(/²/g, '^2').replace(/³/g, '^3');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    let m;
    if ((m = /^0x[0-9a-f]+|^0b[01]+|^0o[0-7]+/i.exec(s.slice(i)))) { out.push({ t: 'num', v: Number(m[0].toLowerCase()) }); i += m[0].length; continue; }
    if ((m = /^(\d[\d_,]*\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i)))) {
      // thousands commas only between digit groups of three, so f(1,2) still has two arguments
      let txt = m[0];
      if (txt.includes(',') && !/^\d{1,3}(,\d{3})+(\.\d*)?(e[+-]?\d+)?$/i.test(txt)) txt = txt.slice(0, txt.indexOf(','));
      out.push({ t: 'num', v: Number(txt.replace(/[_,]/g, '')) }); i += txt.length; continue;
    }
    if ((m = /^[a-zπ_][a-z0-9_]*/i.exec(s.slice(i)))) { out.push({ t: 'id', v: m[0].toLowerCase() }); i += m[0].length; continue; }
    if ('+-*/^()!%,='.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error(`Can’t read “${c}”`);
  }
  return out;
}

/** Works out a sum. scope: { vars, ans, deg }. Returns { value, assign? }. */
export function evaluate(src, scope) {
  const toks = tokenize(src);
  if (!toks.length) return { value: null };
  let p = 0;
  const peek = () => toks[p], take = () => toks[p++];
  const expect = (t) => { if (peek()?.t !== t) throw new Error(t === ')' ? 'A bracket is missing a “)”' : `Expected “${t}”`); p++; };

  let assign = null;
  if (toks[0].t === 'id' && toks[1]?.t === '=') {
    assign = toks[0].v;
    if (FUNCS[assign] || assign in CONSTS || assign === 'ans' || assign === 'mod') throw new Error(`“${assign}” is taken`);
    p = 2;
  }

  const startsTerm = (t) => t && (t.t === 'num' || t.t === 'id' || t.t === '(') && !(t.t === 'id' && t.v === 'mod');
  function add() {
    let v = mul();
    while (peek()?.t === '+' || peek()?.t === '-') v = take().t === '+' ? v + mul() : v - mul();
    return v;
  }
  function mul() {
    let v = unary();
    for (;;) {
      const t = peek();
      if (t?.t === '*') { p++; v *= unary(); } else if (t?.t === '/') { p++; const d = unary(); if (d === 0) throw new Error('Can’t divide by zero'); v /= d; } else if (t?.t === 'id' && t.v === 'mod') { p++; const d = unary(); v = ((v % d) + d) % d; } else if (startsTerm(t)) v *= unary(); // 2π, 3(4), 2sin 30
      else return v;
    }
  }
  function unary() {
    if (peek()?.t === '-') { p++; return -unary(); }
    if (peek()?.t === '+') { p++; return unary(); }
    return pow();
  }
  function pow() {
    const b = postfix();
    if (peek()?.t === '^') { p++; return b ** unary(); } // right-associative, and -2^2 = -4
    return b;
  }
  function postfix() {
    let v = primary();
    for (;;) {
      if (peek()?.t === '!') { p++; v = factorial(v); } else if (peek()?.t === '%') { p++; v /= 100; } else return v;
    }
  }
  function primary() {
    const t = take();
    if (!t) throw new Error('The sum ends too soon');
    if (t.t === 'num') return t.v;
    if (t.t === '(') { const v = add(); expect(')'); return v; }
    if (t.t === 'id') {
      const f = FUNCS[t.v];
      if (f) {
        const args = [];
        if (peek()?.t === '(') {
          p++;
          if (peek()?.t !== ')') { args.push(add()); while (peek()?.t === ',') { p++; args.push(add()); } }
          expect(')');
        } else if (f[0] > 0) args.push(pow()); // sin 30
        if (args.length < f[0] || args.length > f[1]) throw new Error(`${t.v} takes ${f[0] === f[1] ? f[0] : `${f[0]}–${f[1]}`} number${f[1] === 1 ? '' : 's'}`);
        return f[2](scope.deg)(...args);
      }
      if (t.v in CONSTS) return CONSTS[t.v];
      if (t.v === 'ans') { if (scope.ans == null) throw new Error('No answer yet'); return scope.ans; }
      if (t.v in scope.vars) return scope.vars[t.v];
      throw new Error(`Don’t know “${t.v}”`);
    }
    throw new Error(`Unexpected “${t.t}”`);
  }

  const value = add();
  if (p < toks.length) throw new Error(toks[p].t === ')' ? 'A “)” has no “(”' : `Unexpected “${toks[p].v ?? toks[p].t}”`);
  if (Number.isNaN(value)) throw new Error('Not a real number');
  return { value, assign };
}

/** 12 significant figures, floating-point dust removed, long ones in e-notation. */
export function fmt(v) {
  if (v === Infinity) return '∞';
  if (v === -Infinity) return '−∞';
  if (Object.is(v, -0) || Math.abs(v) < 1e-300) return '0';
  const a = Math.abs(v);
  if (a >= 1e15 || a < 1e-9) return v.toExponential(10).replace(/\.?0+e/, 'e').replace('e+', 'e');
  return String(Number(v.toPrecision(12)));
}
const group = (s) => s.replace(/^(-?\d+)/, (m) => m.replace(/\B(?=(\d{3})+(?!\d))/g, ','));

// ---------------------------------------------------------------- the editor

const KEYS = [
  [['sin', 'sin('], ['cos', 'cos('], ['tan', 'tan('], ['x²', '^2'], ['xʸ', '^'], ['(', '('], [')', ')'], ['⌫', 'back', 'op']],
  [['sin⁻¹', 'asin('], ['cos⁻¹', 'acos('], ['tan⁻¹', 'atan('], ['√', 'sqrt('], ['ʸ√x', 'root('], ['7', '7', 'num'], ['8', '8', 'num'], ['9', '9', 'num']],
  [['ln', 'ln('], ['log', 'log('], ['eˣ', 'exp('], ['10ˣ', '10^'], ['n!', '!'], ['4', '4', 'num'], ['5', '5', 'num'], ['6', '6', 'num']],
  [['π', 'π'], ['e', 'e'], ['%', '%'], ['mod', ' mod '], ['nCr', 'ncr('], ['1', '1', 'num'], ['2', '2', 'num'], ['3', '3', 'num']],
  [['ans', 'ans'], ['abs', 'abs('], ['1/x', '1/('], [',', ','], ['rand', 'rand()'], ['0', '0', 'num'], ['.', '.', 'num'], ['±', 'neg', 'num']],
];
const OPS = [['÷', '/'], ['×', '*'], ['−', '-'], ['+', '+']];

export class CalcEditor extends BaseEditor {
  static mode = 'calc';

  async load() {
    const s = this.app.settings.calc || {};
    this.tape = Array.isArray(s.tape) ? s.tape : [];
    this.vars = s.vars && typeof s.vars === 'object' ? s.vars : {};
    this.mem = typeof s.mem === 'number' ? s.mem : 0;
    this.deg = s.deg !== false;
    this.ans = this.tape.length ? this.tape[this.tape.length - 1].value : null;
    this.root = h('div', { class: 'calc-root' });
    this.pane.append(this.root);
    this.render();
  }

  save(now = false) {
    clearTimeout(this.saveTimer);
    const run = () => { this.saveTimer = null; this.app.saveSettings({ calc: { tape: this.tape.slice(-MAX_TAPE), vars: this.vars, mem: this.mem, deg: this.deg } }); };
    if (now) return run();
    this.saveTimer = setTimeout(run, 400);
  }

  scope() { return { vars: this.vars, ans: this.ans, deg: this.deg }; }

  render() {
    this.input = h('input', { type: 'text', class: 'calc-input mono', spellcheck: 'false', autocomplete: 'off', placeholder: '0' });
    this.preview = h('div', { class: 'calc-preview mono' });
    this.bases = h('div', { class: 'calc-bases mono' });
    this.input.addEventListener('input', () => { this.fresh = false; this.update(); });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || (e.key === '=' && !/^\s*[a-z_][a-z0-9_]*\s*$/i.test(this.input.value))) { e.preventDefault(); this.equals(); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.setInput(''); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); this.recall(e.key === 'ArrowUp' ? -1 : 1); return; }
      // after =, an operator carries on from the answer and anything else starts over
      if (this.fresh && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        if (!/[-+*/^!%)]/.test(e.key)) this.input.value = '';
        else this.input.setSelectionRange(this.input.value.length, this.input.value.length);
        this.fresh = false;
      }
    });

    const key = ([label, ins, kind]) => h('button', {
      class: 'calc-key' + (kind ? ' ' + kind : ''),
      onclick: () => this.press(ins),
      'data-tip': ins.endsWith('(') && ins.length > 2 ? ins.slice(0, -1) : null,
    }, label);

    this.tapeEl = h('div', { class: 'calc-tape-list' });
    this.memEl = h('span', { class: 'calc-mem mono' });
    clear(this.root).append(
      h('div', { class: 'calc-main' },
        h('div', { class: 'calc-display' },
          h('div', { class: 'calc-display-top' },
            h('div', { class: 'seg' },
              h('button', { class: this.deg ? 'on' : '', onclick: () => { this.deg = true; this.save(); this.render(); } }, 'DEG'),
              h('button', { class: this.deg ? '' : 'on', onclick: () => { this.deg = false; this.save(); this.render(); } }, 'RAD')),
            h('div', { class: 'grow' }),
            this.memEl),
          this.input, this.preview, this.bases),
        h('div', { class: 'calc-pad' },
          h('div', { class: 'calc-mrow' },
            ...[['MC', () => { this.mem = 0; }], ['MR', () => this.press(fmt(this.mem))], ['M+', () => this.memAdd(1)], ['M−', () => this.memAdd(-1)]]
              .map(([l, fn]) => h('button', { class: 'calc-key mem', onclick: () => { fn(); this.save(); this.showMem(); this.input.focus(); } }, l)),
            h('button', { class: 'calc-key op', onclick: () => this.setInput('') }, 'C'),
            h('button', { class: 'calc-key op', onclick: () => { this.setInput(''); this.ans = null; this.update(); } }, 'AC')),
          h('div', { class: 'calc-grid' },
            h('div', { class: 'calc-keys' }, ...KEYS.flat().map(key)),
            h('div', { class: 'calc-ops' }, ...OPS.map(([l, ins]) => key([l, ins, 'op'])),
              h('button', { class: 'calc-key eq big', onclick: () => this.equals() }, '=')))),
        h('div', { class: 'calc-help faint' }, 'Type a sum and press Enter · ↑ ↓ bring back earlier sums · name = sum keeps a variable · ',
          h('span', { class: 'mono' }, '0x1f 0b101 2π 5! 3 mod 2 log(8,2) round(x,2) ncr(52,5) hyp(3,4) gcd lcm avg min max'))),
      h('div', { class: 'calc-tape' },
        h('div', { class: 'calc-tape-head' },
          h('span', { class: 'clock-sec-title' }, 'Tape'),
          h('div', { class: 'grow' }),
          h('button', { class: 'btn sm ghost', onclick: () => this.clearTape() }, icon('trash', 'sm'), 'Clear')),
        this.tapeEl,
        h('div', { class: 'calc-vars' })));
    this.renderTape();
    this.renderVars();
    this.showMem();
    this.update();
    setTimeout(() => { if (this.tab === this.app.active) this.input.focus(); }, 0);
  }

  setInput(v) { this.input.value = v; this.fresh = false; this.update(); this.input.focus(); }

  press(ins) {
    const el = this.input;
    if (ins === 'back') {
      const a = el.selectionStart, b = el.selectionEnd;
      if (a !== b) el.setRangeText('', a, b, 'end');
      else if (a > 0) el.setRangeText('', a - 1, a, 'end');
      this.fresh = false; this.update(); el.focus(); return;
    }
    if (ins === 'neg') {
      const v = el.value.trim();
      this.setInput(!v ? '-' : /^-\(.*\)$/.test(v) ? v.slice(2, -1) : /^-?[\d.]+$/.test(v) ? (v.startsWith('-') ? v.slice(1) : '-' + v) : `-(${v})`);
      return;
    }
    if (this.fresh) { if (!/^[-+*/^!%)]|^ mod /.test(ins)) el.value = ''; this.fresh = false; el.setSelectionRange(el.value.length, el.value.length); }
    el.setRangeText(ins, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, 'end');
    this.update();
    el.focus();
  }

  memAdd(sign) {
    try { const r = evaluate(this.input.value, this.scope()); if (r.value != null) this.mem += sign * r.value; } catch (e) { toast(e.message, { type: 'error' }); }
  }

  showMem() { this.memEl.textContent = this.mem ? `M ${fmt(this.mem)}` : ''; this.memEl.title = this.mem ? 'In memory' : ''; }

  /** The answer as you type. */
  update() {
    const src = this.input.value;
    this.preview.classList.remove('err');
    this.bases.textContent = '';
    if (!src.trim()) { this.preview.textContent = ''; return; }
    try {
      const { value, assign } = evaluate(src, this.scope());
      if (value == null) { this.preview.textContent = ''; return; }
      this.preview.textContent = (assign ? `${assign} = ` : '= ') + group(fmt(value));
      if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER && Math.abs(value) >= 2) {
        const neg = value < 0 ? '-' : '', a = Math.abs(value);
        this.bases.textContent = `hex ${neg}0x${a.toString(16).toUpperCase()} · bin ${neg}0b${a.toString(2)} · oct ${neg}0o${a.toString(8)}`;
      }
    } catch (e) {
      this.preview.textContent = e.message;
      this.preview.classList.add('err');
    }
  }

  equals() {
    const src = this.input.value.trim();
    if (!src) return;
    let r;
    try { r = evaluate(src, this.scope()); } catch (e) { this.preview.textContent = e.message; this.preview.classList.add('err'); return; }
    if (r.value == null) return;
    if (r.assign) { this.vars[r.assign] = r.value; this.renderVars(); }
    this.ans = r.value;
    this.tape.push({ expr: src, value: r.value, assign: r.assign || null, deg: this.deg });
    if (this.tape.length > MAX_TAPE) this.tape.splice(0, this.tape.length - MAX_TAPE);
    this.save();
    this.renderTape();
    this.input.value = fmt(r.value).replace('∞', 'inf').replace('−', '-');
    this.fresh = true;
    this.recallAt = null;
    this.update();
    this.preview.textContent = '';
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    this.input.focus();
    this.refreshStatus();
  }

  recall(dir) {
    if (!this.tape.length) return;
    this.recallAt = Math.max(0, Math.min(this.tape.length - 1, (this.recallAt ?? this.tape.length) + dir));
    this.setInput(this.tape[this.recallAt].expr);
  }

  renderTape() {
    clear(this.tapeEl);
    if (!this.tape.length) { this.tapeEl.append(h('div', { class: 'calc-tape-empty faint' }, 'Sums you finish with Enter land here. Click one to use it again.')); return; }
    this.tape.forEach((t, i) => {
      this.tapeEl.append(h('div', {
        class: 'calc-tape-row',
        title: 'Click: the answer into the sum · double-click: the sum itself · right-click for more',
        onclick: () => this.press(fmt(t.value).replace('∞', 'inf').replace('−', '-')),
        ondblclick: () => this.setInput(t.expr),
        oncontextmenu: (e) => contextMenu(e, [
          { label: 'Copy answer', icon: 'copy', action: () => navigator.clipboard.writeText(fmt(t.value)) },
          { label: 'Copy sum', icon: 'copy', action: () => navigator.clipboard.writeText(`${t.expr} = ${fmt(t.value)}`) },
          { label: 'Use the sum again', icon: 'undo', action: () => this.setInput(t.expr) },
          { label: 'Delete', icon: 'trash', action: () => { this.tape.splice(i, 1); this.save(); this.renderTape(); } },
        ]),
      },
      h('div', { class: 'calc-tape-expr mono' }, t.expr),
      h('div', { class: 'calc-tape-val mono' }, (t.assign ? `${t.assign} = ` : '= ') + group(fmt(t.value)))));
    });
    this.tapeEl.scrollTop = this.tapeEl.scrollHeight;
  }

  renderVars() {
    const box = this.root.querySelector('.calc-vars');
    const names = Object.keys(this.vars);
    clear(box);
    if (!names.length) return;
    box.append(h('div', { class: 'clock-sec-title' }, 'Variables'),
      ...names.map((n) => h('div', { class: 'calc-var', title: 'Click to use · right-click to forget', onclick: () => this.press(n),
        oncontextmenu: (e) => contextMenu(e, [{ label: `Forget ${n}`, icon: 'trash', action: () => { delete this.vars[n]; this.save(); this.renderVars(); this.update(); } }]) },
      h('span', { class: 'mono' }, n), h('span', { class: 'mono faint' }, group(fmt(this.vars[n]))))));
  }

  clearTape() {
    if (!this.tape.length) return;
    const before = this.tape;
    this.tape = [];
    this.save(); this.renderTape(); this.refreshStatus();
    toast('Tape cleared', { action: { label: 'Undo', fn: () => { this.tape = before; this.save(); this.renderTape(); this.refreshStatus(); } } });
  }

  status() {
    if (!this.tape) return { left: [], right: [] };
    return { left: [{ text: this.deg ? 'Degrees' : 'Radians' }], right: [{ text: this.ans != null ? `ans ${fmt(this.ans)}` : '' }] };
  }

  focus() { this.input?.focus(); }
  destroy() { if (this.saveTimer) this.save(true); }
}
