// Custom theme: a rough palette (dark or light, a background, an accent and a highlight) turned into the full set of
// theme colours. The base theme (dark or light) supplies everything not derived here (warning colours, shadows and the
// few light-only rules), and the derived colours sit on top as inline variables on <html>, so they win over it.
// The result is also kept in localStorage so index.html can put it on before the app loads (no flash of the base).

export const CUSTOM_DEFAULT = { base: 'dark', bg: '#0f1620', accent: '#4da3ff', accent2: '#3ee6c4', gradient: false, bg2: '#2a1240', angle: 135 };

export const CUSTOM_PRESETS = [
  { name: 'Ocean', base: 'dark', bg: '#0f1620', accent: '#4da3ff', accent2: '#3ee6c4' },
  { name: 'Forest', base: 'dark', bg: '#0f1912', accent: '#6fdc8c', accent2: '#e8c26b' },
  { name: 'Ember', base: 'dark', bg: '#1a100d', accent: '#ff8a4c', accent2: '#ffd166' },
  { name: 'Crimson', base: 'dark', bg: '#170c10', accent: '#ff4d6d', accent2: '#ffa3b5' },
  { name: 'Graphite', base: 'dark', bg: '#141414', accent: '#d4d4d4', accent2: '#8ab4f8' },
  { name: 'Rose', base: 'light', bg: '#fbf1f4', accent: '#c93e6a', accent2: '#8a5cf5' },
  { name: 'Mint', base: 'light', bg: '#eff8f4', accent: '#178f69', accent2: '#2f7dd6' },
  { name: 'Sand', base: 'light', bg: '#f7f0e4', accent: '#b5651d', accent2: '#2f7d6d' },
  { name: 'Paper', base: 'light', bg: '#f4f4f2', accent: '#3a3a3a', accent2: '#d6453a' },
];

const VARS = ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-4', '--bg-5', '--line', '--line-2', '--text', '--text-2', '--text-3',
  '--accent', '--accent-strong', '--accent-2', '--accent-soft', '--accent-soft-2', '--accent-line', '--gloss', '--focus',
  '--desk', '--desk-grid', '--scroll', '--scroll-hover', '--custom-grad'];

const rgb = (hex) => {
  let x = String(hex || '').replace('#', '');
  if (x.length === 3) x = [...x].map((c) => c + c).join('');
  const n = parseInt(x, 16);
  return Number.isNaN(n) || x.length !== 6 ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
/** a blended toward b by t (0..1) */
const mix = (a, b, t) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
const rgba = (c, a) => `rgba(${rgb(c).join(', ')}, ${a})`;
const lum = (c) => { const [r, g, b] = rgb(c); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

export function normalizeCustom(p) {
  const ok = (v) => /^#[0-9a-f]{6}$/i.test(v || '');
  const d = CUSTOM_DEFAULT;
  return {
    base: p?.base === 'light' ? 'light' : 'dark',
    bg: ok(p?.bg) ? p.bg : d.bg, accent: ok(p?.accent) ? p.accent : d.accent, accent2: ok(p?.accent2) ? p.accent2 : d.accent2,
    gradient: !!p?.gradient, bg2: ok(p?.bg2) ? p.bg2 : d.bg2,
    angle: Number.isFinite(Number(p?.angle)) ? ((Math.round(Number(p.angle)) % 360) + 360) % 360 : d.angle,
  };
}

/** The full set of colours for a palette. */
export function deriveCustom(palette) {
  const { base, bg, accent, accent2, gradient, bg2, angle } = normalizeCustom(palette);
  const dark = base === 'dark';
  const far = dark ? '#ffffff' : '#000000'; // what the layers step toward
  const tint = mix(far, accent, 0.12); // text with a hint of the accent, like the built-in themes
  const v = dark ? {
    '--bg-0': mix(bg, '#000000', 0.3), '--bg-1': bg, '--bg-2': mix(bg, far, 0.03), '--bg-3': mix(bg, far, 0.065),
    '--bg-4': mix(bg, far, 0.11), '--bg-5': mix(bg, far, 0.16), '--line': mix(bg, far, 0.09), '--line-2': mix(bg, far, 0.16),
    '--text': mix(bg, tint, 0.9), '--text-2': mix(bg, tint, 0.68), '--text-3': mix(bg, tint, 0.44),
    '--accent-strong': mix(accent, '#ffffff', 0.2), '--scroll': mix(bg, far, 0.14), '--scroll-hover': mix(bg, far, 0.22),
  } : {
    '--bg-0': mix(bg, '#000000', 0.05), '--bg-1': bg, '--bg-2': mix(bg, '#ffffff', 0.45), '--bg-3': mix(bg, '#ffffff', 0.85),
    '--bg-4': mix(mix(bg, '#000000', 0.03), accent, 0.05), '--bg-5': mix(mix(bg, '#000000', 0.07), accent, 0.08),
    '--line': mix(bg, '#000000', 0.09), '--line-2': mix(bg, '#000000', 0.16),
    '--text': mix(bg, tint, 0.88), '--text-2': mix(bg, tint, 0.64), '--text-3': mix(bg, tint, 0.45),
    '--accent-strong': mix(accent, '#000000', 0.15), '--scroll': mix(bg, '#000000', 0.16), '--scroll-hover': mix(bg, '#000000', 0.25),
  };
  Object.assign(v, {
    '--accent': accent, '--accent-2': accent2,
    '--accent-soft': rgba(accent, dark ? 0.12 : 0.1), '--accent-soft-2': rgba(accent, dark ? 0.22 : 0.18), '--accent-line': rgba(accent, 0.45),
    '--gloss': `linear-gradient(135deg, ${accent} 0%, ${mix(accent, accent2, 0.5)} 55%, ${accent2} 100%)`,
    '--focus': `0 0 0 1px ${rgba(accent, 0.55)}, 0 0 14px ${rgba(accent, 0.18)}`,
    '--desk': mix(bg, dark ? '#000000' : '#000000', dark ? 0.35 : 0.08), '--desk-grid': rgba(accent, dark ? 0.035 : 0.05),
  });
  // the gradient runs from the background colour to the second one; the window chrome turns to tinted glass over it
  if (gradient) v['--custom-grad'] = `linear-gradient(${angle}deg, ${bg} 0%, ${mix(bg, bg2, 0.55)} 55%, ${bg2} 100%)`;
  return { base, vars: v };
}

/** A gloss button on a pale accent needs dark text. */
export const accentText = (accent) => (lum(accent) > 0.6 ? '#111111' : '#ffffff');

// Source Code (theme id readout): a backlit display, all in two colours. A bright backlight with dark characters is a lit LCD (the
// characters cast a faint shadow on the glass); a dark one with bright characters is a glowing VFD or LED readout.
export const READOUT_DEFAULT = { glass: '#a9c46c', ink: '#1c2a12' };
export const READOUT_PRESETS = [
  { name: 'Green LCD', glass: '#a9c46c', ink: '#1c2a12' },
  { name: 'Amber LCD', glass: '#f0a640', ink: '#2a1504' },
  { name: 'Ice blue LCD', glass: '#86c9ee', ink: '#0b2034' },
  { name: 'Teal night light', glass: '#3fcfc4', ink: '#05292a' },
  { name: 'Grey LCD', glass: '#c3c6b8', ink: '#22241e' },
  { name: 'Cyan VFD', glass: '#050d0f', ink: '#4ff2df' },
  { name: 'Red LED', glass: '#120505', ink: '#ff3d33' },
  { name: 'Amber plasma', glass: '#110a03', ink: '#ffa233' },
  { name: 'Blue VFD', glass: '#040817', ink: '#80b6ff' },
];

export function normalizeReadout(p) {
  const ok = (v) => /^#[0-9a-f]{6}$/i.test(v || '');
  const glass = ok(p?.glass) ? p.glass : READOUT_DEFAULT.glass, ink = ok(p?.ink) ? p.ink : READOUT_DEFAULT.ink;
  // mine: your own two colours, kept while you try the presets
  const mine = ok(p?.mine?.glass) && ok(p?.mine?.ink) ? { glass: p.mine.glass, ink: p.mine.ink } : null;
  return { glass, ink, mine };
}

/** The full set of colours for a readout. */
export function deriveReadout(palette) {
  const { glass, ink } = normalizeReadout(palette);
  const lit = lum(glass) >= lum(ink); // a lit backlight with dark characters, or the other way round
  const base = lit ? 'light' : 'dark';
  const step = (t) => mix(glass, ink, t);
  const v = {
    '--bg-0': lit ? mix(glass, '#000000', 0.07) : mix(glass, '#000000', 0.35), '--bg-1': glass,
    '--bg-2': lit ? mix(glass, '#ffffff', 0.14) : step(0.035), '--bg-3': lit ? mix(glass, '#ffffff', 0.26) : step(0.06),
    '--bg-4': step(lit ? 0.08 : 0.1), '--bg-5': step(lit ? 0.14 : 0.15), '--line': step(lit ? 0.18 : 0.12), '--line-2': step(lit ? 0.32 : 0.24),
    '--text': ink, '--text-2': step(lit ? 0.78 : 0.72), '--text-3': step(lit ? 0.56 : 0.48),
    '--accent': ink, '--accent-strong': lit ? mix(ink, '#000000', 0.25) : mix(ink, '#ffffff', 0.3), '--accent-2': step(lit ? 0.7 : 0.65), '--accent-3': step(lit ? 0.85 : 0.8),
    '--accent-soft': rgba(ink, lit ? 0.1 : 0.12), '--accent-soft-2': rgba(ink, lit ? 0.18 : 0.22), '--accent-line': rgba(ink, 0.45),
    '--gloss': `linear-gradient(180deg, ${ink} 0%, ${step(0.85)} 100%)`,
    '--focus': `0 0 0 1px ${rgba(ink, 0.6)}, 0 0 12px ${rgba(ink, lit ? 0.12 : 0.25)}`,
    '--desk': step(lit ? 0.12 : 0.03), '--desk-grid': rgba(ink, 0.05),
    '--scroll': step(lit ? 0.22 : 0.16), '--scroll-hover': step(lit ? 0.34 : 0.26),
    // for the structural rules in app.css: the characters' shadow on lit glass, or their glow on dark
    '--ro-ink': ink, '--ro-glass': glass,
    '--ro-glow': lit ? `1px 1px 0 ${rgba(ink, 0.16)}` : `0 0 6px ${rgba(ink, 0.45)}`,
    '--ro-grid': rgba(lit ? ink : '#000000', lit ? 0.045 : 0.25),
    '--accent-text': glass,
  };
  return { base, vars: v };
}

const ALL_VARS = [...VARS, '--accent-text', '--accent-3', '--ro-ink', '--ro-glass', '--ro-glow', '--ro-grid'];
/** Put derived colours on the page (or take them off with null); cls marks which kind they are for app.css. */
function putVars(derived, cls, extra = []) {
  const root = document.documentElement;
  for (const k of ALL_VARS) root.style.removeProperty(k);
  root.classList.remove('custom-grad', 'readout-theme');
  root.classList.toggle('custom-theme', !!derived);
  if (!derived) { try { localStorage.removeItem('bds-custom-theme'); } catch { /* ignore */ } return null; }
  for (const c of [cls, ...extra]) if (c) root.classList.add(c);
  for (const [k, val] of Object.entries(derived.vars)) root.style.setProperty(k, val);
  try { localStorage.setItem('bds-custom-theme', JSON.stringify({ base: derived.base, vars: derived.vars, cls })); } catch { /* ignore */ }
  return derived.base;
}

/** Put a palette on the page (or take it off with null). Returns the base theme (dark / light) to show under it. */
export function applyCustom(palette) {
  if (!palette) return putVars(null);
  const d = deriveCustom(palette);
  d.vars['--accent-text'] = accentText(d.vars['--accent']);
  return putVars(d, null, palette.gradient ? ['custom-grad'] : []);
}

/** Put a readout on the page. Returns the base theme (dark / light) to show under it. */
export const applyReadout = (palette) => putVars(deriveReadout(palette), 'readout-theme');
