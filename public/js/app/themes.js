// Box-Deckspitter app shell, themes and the UI font.
// Methods of App (app.js mixes this class into it).

import { $, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { applyCustom, normalizeCustom } from '../core/custom-theme.js';
import { THEMES, HIDDEN_THEMES } from './shared.js';
import { chicken } from '../core/chicken.js';

const THEME_NAME = Object.fromEntries([...THEMES, ...HIDDEN_THEMES].map(([id, name]) => [id, name]));

// what Blue hour's rays fade out behind
const RAY_QUIET = '#titlebar .brand, #menubar .menubar-item, #doc-title, .titlebar-actions .icon-btn, #tabbar .tab, #tabbar .icon-btn, #rail .rail-btn, #rightrail, #statusbar, .home-title, .home-sub';

export class ThemesPart {
  /** The themes Settings offers: the built-in ones, plus the hidden ones when that easter egg is on. */
  themeList() { return this.settings.hiddenThemes ? [...THEMES, ...HIDDEN_THEMES] : THEMES; }

  /** The theme before (-1) or after (1) the current one on the top-bar button, which only goes round the built-in
   *  ones (from a hidden theme it goes to the first or last of them). */
  themeStep(dir, from = this.settings.theme) {
    const ids = THEMES.map(([id]) => id);
    const i = ids.indexOf(from);
    if (i < 0) return dir > 0 ? ids[0] : ids[ids.length - 1];
    return ids[(i + dir + ids.length) % ids.length];
  }

  /** The interface font and UI animations (Settings → Appearance). Kept in localStorage too so the page starts with them. */
  applyLook() {
    const root = document.documentElement;
    const font = this.uiFontList().find(([id]) => id === this.settings.uiFont)?.[2];
    if (font) root.style.setProperty('--font-ui', font); else root.style.removeProperty('--font-ui');
    const still = this.settings.animations === false;
    root.classList.toggle('no-anim', still);
    // a picture behind the whole app, under whatever theme is on
    const bg = this.settings.bgImage;
    root.classList.toggle('bg-image', !!bg?.file);
    if (bg?.file) {
      root.style.setProperty('--bg-image', `url("/bg/${encodeURIComponent(bg.file)}")`);
      root.style.setProperty('--bg-cover', `${bg.cover ?? 55}%`);
      root.style.setProperty('--bg-blur', `${bg.blur ?? 0}px`);
    } else for (const k of ['--bg-image', '--bg-cover', '--bg-blur']) root.style.removeProperty(k);
    try {
      if (font) localStorage.setItem('bds-ui-font', font); else localStorage.removeItem('bds-ui-font');
      if (still) localStorage.setItem('bds-no-anim', '1'); else localStorage.removeItem('bds-no-anim');
    } catch { /* ignore */ }
  }

  applyTheme(theme, persist = true) {
    if (!this.themeList().some(([id]) => id === theme)) theme = 'dark';
    this.settings.theme = theme;
    // a custom theme sits on its base (dark or light): the base's own rules apply, the palette's colours win
    const shown = theme === 'custom' ? applyCustom(normalizeCustom(this.settings.customTheme)) : (applyCustom(null), theme);
    document.documentElement.dataset.theme = shown;
    try { localStorage.setItem('bds-theme', shown); } catch { /* ignore */ }
    const b = $('#btn-theme');
    const next = this.themeStep(1, theme);
    clear(b).append(icon(THEMES.find(([id]) => id === next)?.[3] || 'moon')); // shows where a click goes
    b.title = `Theme: ${THEME_NAME[theme] || theme} — click for ${THEME_NAME[next]}, right-click for ${THEME_NAME[this.themeStep(-1, theme)]}`;
    if (persist) this.saveSettings({ theme });
    // Settings open (the top-bar button or View menu changed it): keep its dropdown and the custom palette box in step
    const pick = document.querySelector('select.set-theme');
    if (pick) { pick.value = theme; const ct = document.querySelector('.ct-box'); if (ct) ct.hidden = theme !== 'custom'; }
    this.sunRays(shown === 'bluehour');
    chicken(shown === 'miami');
    for (const t of this.tabs) t.editor?.onThemeChange?.(theme);
    if (window.bdsShell) {
      const cs = getComputedStyle(document.documentElement);
      window.bdsShell.setTitlebar((cs.getPropertyValue('--titlebar-solid') || cs.getPropertyValue('--bg-1')).trim(), (cs.getPropertyValue('--titlebar-text') || cs.getPropertyValue('--text-2')).trim(), shown).catch(() => {});
    }
  }

  /** Blue hour's sun rays over the bars round the window: the header, tab strip, both side rails and the status bar. They fan out from the home page's sun when it's on
   *  screen (from the same spot when it isn't) and are clipped to those bars, so tab contents never get them; on the home
   *  page they also cross the page above the sun's horizon. They fade behind text and icons. */
  sunRays(on) {
    clearInterval(this._rays?.timer);
    window.removeEventListener('resize', this._rays?.place);
    document.removeEventListener('scroll', this._rays?.place, true);
    this._rays?.el.remove();
    this._rays = null;
    if (!on) return;
    const el = document.createElement('div');
    el.className = 'bh-rays';
    document.body.append(el);
    const place = () => {
      const W = innerWidth, H = innerHeight;
      const top = $('#tabbar')?.getBoundingClientRect().bottom || $('#titlebar')?.getBoundingClientRect().bottom || 0;
      // the sun is 124px wide, 32px in from the hero's right edge, sitting on its bottom
      const hero = $('.home-hero');
      const r = hero?.getClientRects().length ? hero.getBoundingClientRect() : null;
      const sunUp = r && r.bottom > top && r.top < H;
      if (sunUp) {
        el.style.setProperty('--bh-x', `${r.right - 94}px`);
        el.style.setProperty('--bh-y', `${r.bottom - 1}px`);
      } else if (!this._rays?.seen) {
        el.style.setProperty('--bh-x', `${W - 140}px`);
        el.style.setProperty('--bh-y', '150px');
      }
      // the bars round the edge of the window; on the home page also the page above the sun's horizon, so they visibly
      // come out of it
      const boxes = ['#rail', '#rightrail', '#statusbar'].map((q) => $(q)?.getBoundingClientRect()).filter((b) => b?.width && b.height);
      boxes.push({ left: 0, top: 0, right: W, bottom: top });
      const ws = sunUp ? $('#workspace')?.getBoundingClientRect() : null;
      if (ws) boxes.push({ left: ws.left, top, right: ws.right, bottom: Math.max(top, Math.min(r.bottom - 1, ws.bottom)) });
      el.style.clipPath = `path('${boxes.map((b) => `M${b.left} ${b.top}H${b.right}V${b.bottom}H${b.left}Z`).join('')}')`;
      if (r && this._rays) this._rays.seen = true;
      // fade them to a quarter behind anything with words or icons on it, so all of it stays easy to read
      // (the text's own line boxes, not the elements', so a wide paragraph only fades where its words are)
      const range = document.createRange();
      const spots = [...document.querySelectorAll(RAY_QUIET)].flatMap((e) => { range.selectNodeContents(e); return [...range.getClientRects()]; }).filter((b) => b.width && b.bottom > 0 && b.top < H)
        .map((b) => `<rect x="${Math.round(b.left - 4)}" y="${Math.round(b.top - 2)}" width="${Math.round(b.width + 8)}" height="${Math.round(b.height + 4)}" rx="4"/>`).join('');
      const key = W + 'x' + H + spots;
      if (key !== this._rays?.key) {
        if (this._rays) this._rays.key = key;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><filter id="b"><feGaussianBlur stdDeviation="3"/></filter>`
          + `<mask id="m"><rect width="100%" height="100%" fill="#fff"/><g fill="#000" fill-opacity="0.75" filter="url(#b)">${spots}</g></mask></defs>`
          + `<rect width="100%" height="100%" mask="url(#m)"/></svg>`;
        el.style.setProperty('--bh-quiet', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
      }
    };
    this._rays = { el, place, timer: setInterval(place, 400) };
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, { capture: true, passive: true });
    place();
  }
}
