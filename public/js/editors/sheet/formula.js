// A small spreadsheet formula engine: references, ranges, operators and the common functions.

export class FormulaError {
  constructor(code) { this.code = code; }
  toString() { return this.code; }
}
const ERR = (c) => new FormulaError(c);
export const isErr = (v) => v instanceof FormulaError;

export function colName(c) {
  let s = '';
  c += 1;
  while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
  return s;
}
export function colIndex(name) {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export function parseRef(s) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(s);
  return m ? { r: Number(m[2]) - 1, c: colIndex(m[1]) } : null;
}
export const refName = (r, c) => colName(c) + (r + 1);

// ------------------------------------------------------------------ tokenizer

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      let j = i + 1, s = '';
      while (j < src.length) { if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; } s += src[j++]; }
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(src.slice(i));
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const rng = /^\$?[A-Za-z]{1,3}\$?\d{1,7}:\$?[A-Za-z]{1,3}\$?\d{1,7}/.exec(src.slice(i));
    if (rng) { out.push({ t: 'range', v: rng[0] }); i += rng[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_.]*\$?\d*/.exec(src.slice(i));
    if (id) {
      const w = id[0];
      if (src[i + w.length] === '(') out.push({ t: 'fn', v: w.toUpperCase() });
      else if (parseRef(w)) out.push({ t: 'ref', v: w });
      else if (/^(TRUE|FALSE)$/i.test(w)) out.push({ t: 'bool', v: w.toUpperCase() === 'TRUE' });
      else out.push({ t: 'name', v: w });
      i += w.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '<>'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&=<>%(),;:'.includes(ch)) { out.push({ t: 'op', v: ch === ';' ? ',' : ch }); i++; continue; }
    throw ERR('#NAME?');
  }
  return out;
}

// ------------------------------------------------------------------ parser → AST

export function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => { const t = toks[p]; if (!t || (v && t.v !== v)) throw ERR('#ERROR!'); p++; return t; };
  const isOp = (...ops) => peek()?.t === 'op' && ops.includes(peek().v);

  function cmp() {
    let l = concat();
    while (isOp('=', '<>', '<', '>', '<=', '>=')) { const op = eat().v; l = { k: 'bin', op, l, r: concat() }; }
    return l;
  }
  function concat() {
    let l = add();
    while (isOp('&')) { eat(); l = { k: 'bin', op: '&', l, r: add() }; }
    return l;
  }
  function add() {
    let l = mul();
    while (isOp('+', '-')) { const op = eat().v; l = { k: 'bin', op, l, r: mul() }; }
    return l;
  }
  function mul() {
    let l = pow();
    while (isOp('*', '/')) { const op = eat().v; l = { k: 'bin', op, l, r: pow() }; }
    return l;
  }
  function pow() {
    let l = unary();
    while (isOp('^')) { eat(); l = { k: 'bin', op: '^', l, r: unary() }; }
    return l;
  }
  function unary() {
    if (isOp('-')) { eat(); return { k: 'neg', e: unary() }; }
    if (isOp('+')) { eat(); return unary(); }
    let e = primary();
    while (isOp('%')) { eat(); e = { k: 'pct', e }; }
    return e;
  }
  function primary() {
    const t = peek();
    if (!t) throw ERR('#ERROR!');
    if (t.t === 'num' || t.t === 'str' || t.t === 'bool') { p++; return { k: 'lit', v: t.v }; }
    if (t.t === 'ref') { p++; return { k: 'ref', ...parseRef(t.v) }; }
    if (t.t === 'range') { p++; const [a, b] = t.v.split(':').map(parseRef); return { k: 'range', a, b }; }
    if (t.t === 'fn') {
      p++; eat('(');
      const args = [];
      if (!isOp(')')) { args.push(cmp()); while (isOp(',')) { eat(); args.push(cmp()); } }
      eat(')');
      return { k: 'fn', name: t.v, args };
    }
    if (t.t === 'op' && t.v === '(') { p++; const e = cmp(); eat(')'); return e; }
    if (t.t === 'name') { p++; return { k: 'lit', v: ERR('#NAME?') }; }
    throw ERR('#ERROR!');
  }
  const ast = cmp();
  if (p < toks.length) throw ERR('#ERROR!');
  return ast;
}

// ------------------------------------------------------------------ evaluation

const num = (v) => {
  if (isErr(v)) throw v;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === '' || v == null) return 0;
  const n = Number(String(v).replace(/,/g, ''));
  if (Number.isNaN(n)) throw ERR('#VALUE!');
  return n;
};
const str = (v) => { if (isErr(v)) throw v; if (v == null) return ''; if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'; return String(v); };
const bool = (v) => { if (isErr(v)) throw v; if (typeof v === 'string') return v.toUpperCase() === 'TRUE' ? true : v.toUpperCase() === 'FALSE' ? false : num(v) !== 0; return !!num(v); };
const flat = (args) => args.flat(Infinity);
const numbers = (args) => flat(args).filter((v) => typeof v === 'number' || (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)))).map(Number);

function criteria(c) {
  const s = String(c);
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(s);
  const op = m[1] || '=';
  const rhs = m[2];
  const rn = Number(rhs);
  const isNum = rhs !== '' && !Number.isNaN(rn);
  const re = /[*?]/.test(rhs) ? new RegExp('^' + rhs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
  return (v) => {
    if (isNum && (typeof v === 'number' || (v !== '' && !Number.isNaN(Number(v))))) {
      const x = Number(v);
      return { '=': x === rn, '<>': x !== rn, '<': x < rn, '>': x > rn, '<=': x <= rn, '>=': x >= rn }[op];
    }
    const a = String(v ?? '').toLowerCase();
    const b = rhs.toLowerCase();
    if (op === '=') return re ? re.test(String(v ?? '')) : a === b;
    if (op === '<>') return re ? !re.test(String(v ?? '')) : a !== b;
    return false;
  };
}

const FN = {
  SUM: (a) => numbers(a).reduce((x, y) => x + y, 0),
  AVERAGE: (a) => { const n = numbers(a); if (!n.length) throw ERR('#DIV/0!'); return n.reduce((x, y) => x + y, 0) / n.length; },
  MIN: (a) => { const n = numbers(a); return n.length ? Math.min(...n) : 0; },
  MAX: (a) => { const n = numbers(a); return n.length ? Math.max(...n) : 0; },
  COUNT: (a) => numbers(a).length,
  COUNTA: (a) => flat(a).filter((v) => v !== '' && v != null).length,
  COUNTBLANK: (a) => flat(a).filter((v) => v === '' || v == null).length,
  PRODUCT: (a) => numbers(a).reduce((x, y) => x * y, 1),
  MEDIAN: (a) => { const n = numbers(a).sort((x, y) => x - y); if (!n.length) throw ERR('#NUM!'); const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; },
  ROUND: ([v, d = 0]) => { const f = 10 ** num(d); return Math.round(num(v) * f) / f; },
  ROUNDUP: ([v, d = 0]) => { const f = 10 ** num(d); const x = num(v); return Math.sign(x) * Math.ceil(Math.abs(x) * f) / f; },
  ROUNDDOWN: ([v, d = 0]) => { const f = 10 ** num(d); const x = num(v); return Math.sign(x) * Math.floor(Math.abs(x) * f) / f; },
  INT: ([v]) => Math.floor(num(v)),
  ABS: ([v]) => Math.abs(num(v)),
  SQRT: ([v]) => { const x = num(v); if (x < 0) throw ERR('#NUM!'); return Math.sqrt(x); },
  POWER: ([a, b]) => num(a) ** num(b),
  MOD: ([a, b]) => { const d = num(b); if (!d) throw ERR('#DIV/0!'); const x = num(a); return x - d * Math.floor(x / d); },
  PI: () => Math.PI,
  RAND: () => Math.random(),
  RANDBETWEEN: ([a, b]) => { const lo = Math.ceil(num(a)); return lo + Math.floor(Math.random() * (Math.floor(num(b)) - lo + 1)); },
  IF: ([c, a = true, b = false]) => (bool(c) ? a : b),
  IFERROR: ([v, alt]) => (isErr(v) ? alt : v),
  AND: (a) => flat(a).every(bool),
  OR: (a) => flat(a).some(bool),
  NOT: ([v]) => !bool(v),
  CONCAT: (a) => flat(a).map(str).join(''),
  CONCATENATE: (a) => flat(a).map(str).join(''),
  TEXTJOIN: ([sep, skip, ...rest]) => flat(rest).map(str).filter((s) => !bool(skip) || s !== '').join(str(sep)),
  LEN: ([v]) => str(v).length,
  UPPER: ([v]) => str(v).toUpperCase(),
  LOWER: ([v]) => str(v).toLowerCase(),
  PROPER: ([v]) => str(v).toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()),
  TRIM: ([v]) => str(v).trim().replace(/\s+/g, ' '),
  LEFT: ([v, n = 1]) => str(v).slice(0, num(n)),
  RIGHT: ([v, n = 1]) => { const s = str(v); return s.slice(Math.max(0, s.length - num(n))); },
  MID: ([v, s, n]) => str(v).substr(num(s) - 1, num(n)),
  SUBSTITUTE: ([v, a, b]) => str(v).split(str(a)).join(str(b)),
  FIND: ([a, v]) => { const i = str(v).indexOf(str(a)); if (i < 0) throw ERR('#VALUE!'); return i + 1; },
  SEARCH: ([a, v]) => { const i = str(v).toLowerCase().indexOf(str(a).toLowerCase()); if (i < 0) throw ERR('#VALUE!'); return i + 1; },
  VALUE: ([v]) => num(v),
  TEXT: ([v, fmt]) => {
    const f = str(fmt);
    const x = num(v);
    const dec = (f.split('.')[1] || '').replace(/[^0#]/g, '').length;
    let s = x.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: f.includes(',') });
    if (f.includes('%')) s = (x * 100).toFixed(dec) + '%';
    if (f.startsWith('$')) s = '$' + s;
    return s;
  },
  TODAY: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toLocaleDateString(); },
  NOW: () => new Date().toLocaleString(),
  ISBLANK: ([v]) => v === '' || v == null,
  ISNUMBER: ([v]) => typeof v === 'number',
  ISTEXT: ([v]) => typeof v === 'string' && v !== '',
  ISERROR: ([v]) => isErr(v),
  COUNTIF: ([range, c]) => flat([range]).filter(criteria(c)).length,
  SUMIF: ([range, c, sumRange]) => {
    const r = flat([range]);
    const s = sumRange ? flat([sumRange]) : r;
    const test = criteria(c);
    return r.reduce((acc, v, i) => (test(v) ? acc + (Number(s[i]) || 0) : acc), 0);
  },
  AVERAGEIF: ([range, c, avgRange]) => {
    const r = flat([range]);
    const s = avgRange ? flat([avgRange]) : r;
    const test = criteria(c);
    const vals = r.map((v, i) => (test(v) ? Number(s[i]) : null)).filter((v) => v != null && !Number.isNaN(v));
    if (!vals.length) throw ERR('#DIV/0!');
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  },
  VLOOKUP: ([key, table, col, approx = true]) => {
    const rows = table?.rows;
    if (!rows) throw ERR('#REF!');
    const ci = num(col) - 1;
    if (ci < 0 || ci >= (rows[0]?.length || 0)) throw ERR('#REF!');
    if (!bool(approx)) {
      const row = rows.find((r) => String(r[0]).toLowerCase() === String(key).toLowerCase() || (typeof key === 'number' && Number(r[0]) === key));
      if (!row) throw ERR('#N/A');
      return row[ci];
    }
    let best = null;
    for (const r of rows) { if (num(r[0]) <= num(key)) best = r; else break; }
    if (!best) throw ERR('#N/A');
    return best[ci];
  },
  HLOOKUP: ([key, table, rowN]) => {
    const rows = table?.rows;
    if (!rows) throw ERR('#REF!');
    const ci = rows[0].findIndex((v) => String(v).toLowerCase() === String(key).toLowerCase());
    if (ci < 0) throw ERR('#N/A');
    return rows[num(rowN) - 1]?.[ci] ?? '';
  },
  INDEX: ([table, r, c = 1]) => { const rows = table?.rows; const v = rows?.[num(r) - 1]?.[num(c) - 1]; if (v === undefined) throw ERR('#REF!'); return v; },
  MATCH: ([key, range]) => { const i = flat([range]).findIndex((v) => String(v).toLowerCase() === String(key).toLowerCase()); if (i < 0) throw ERR('#N/A'); return i + 1; },
};
export const FUNCTION_NAMES = Object.keys(FN).sort();

/**
 * Evaluate a parsed formula.
 * get(r, c) returns the (computed) value of a cell.
 */
export function evaluate(ast, get) {
  const rangeVals = (a, b) => {
    const r1 = Math.min(a.r, b.r), r2 = Math.max(a.r, b.r), c1 = Math.min(a.c, b.c), c2 = Math.max(a.c, b.c);
    if ((r2 - r1 + 1) * (c2 - c1 + 1) > 2e6) throw ERR('#REF!');
    const rows = [];
    for (let r = r1; r <= r2; r++) { const row = []; for (let c = c1; c <= c2; c++) row.push(get(r, c)); rows.push(row); }
    return rows;
  };
  const ev = (n) => {
    switch (n.k) {
      case 'lit': return n.v;
      case 'ref': { const v = get(n.r, n.c); return v; }
      case 'range': { const rows = rangeVals(n.a, n.b); const flatV = rows.flat(); flatV.rows = rows; return flatV; }
      case 'neg': return -num(ev(n.e));
      case 'pct': return num(ev(n.e)) / 100;
      case 'bin': {
        const l = ev(n.l);
        const r = ev(n.r);
        if (isErr(l)) return l;
        if (isErr(r)) return r;
        switch (n.op) {
          case '+': return num(l) + num(r);
          case '-': return num(l) - num(r);
          case '*': return num(l) * num(r);
          case '/': { const d = num(r); if (d === 0) return ERR('#DIV/0!'); return num(l) / d; }
          case '^': return num(l) ** num(r);
          case '&': return str(l) + str(r);
          default: {
            const both = typeof l === 'number' || typeof r === 'number' ? [num(l), num(r)] : [str(l).toLowerCase(), str(r).toLowerCase()];
            const [x, y] = both;
            return { '=': x === y, '<>': x !== y, '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y }[n.op];
          }
        }
      }
      case 'fn': {
        const f = FN[n.name];
        if (!f) return ERR('#NAME?');
        if (n.name === 'IF') {
          const c = ev(n.args[0]);
          return bool(c) ? (n.args[1] ? ev(n.args[1]) : true) : (n.args[2] ? ev(n.args[2]) : false);
        }
        const lazy = n.name === 'IFERROR';
        const args = n.args.map((a) => {
          try {
            const v = ev(a);
            if (Array.isArray(v) && v.rows) { const out = [...v]; out.rows = v.rows; return out; }
            return v;
          } catch (e) { if (isErr(e) && lazy) return e; throw e; }
        });
        if (n.name.match(/^(VLOOKUP|HLOOKUP|INDEX)$/)) args[n.name === 'INDEX' ? 0 : 1] = { rows: args[n.name === 'INDEX' ? 0 : 1]?.rows };
        return f(args);
      }
      default: return ERR('#ERROR!');
    }
  };
  try {
    const v = ev(ast);
    if (Array.isArray(v)) return v[0] ?? '';
    return v;
  } catch (e) {
    if (isErr(e)) return e;
    return ERR('#ERROR!');
  }
}
