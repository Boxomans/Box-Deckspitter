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

/** Put a palette on the page (or take it off with null). Returns the base theme (dark / light) to show under it. */
export function applyCustom(palette) {
  const root = document.documentElement;
  for (const k of VARS) root.style.removeProperty(k);
  root.style.removeProperty('--accent-text');
  root.classList.toggle('custom-theme', !!palette);
  root.classList.toggle('custom-grad', !!palette?.gradient);
  if (!palette) { try { localStorage.removeItem('bds-custom-theme'); } catch { /* ignore */ } return null; }
  const { base, vars } = deriveCustom(palette);
  vars['--accent-text'] = accentText(vars['--accent']);
  for (const [k, val] of Object.entries(vars)) root.style.setProperty(k, val);
  try { localStorage.setItem('bds-custom-theme', JSON.stringify({ base, vars })); } catch { /* ignore */ }
  return base;
}
