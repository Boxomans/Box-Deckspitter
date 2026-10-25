// Box-Deckspitter app shell, themes and the UI font.
// Methods of App (app.js mixes this class into it).

import { $, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { applyCustom, normalizeCustom, applyReadout, normalizeReadout } from '../core/custom-theme.js';
import { THEMES, HIDDEN_THEMES, SKIES, skyAt } from './shared.js';
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
    // a custom theme or a readout sits on its base (dark or light): the base's own rules apply, the palette's colours win
    const shown = theme === 'custom' ? applyCustom(normalizeCustom(this.settings.customTheme))
      : theme === 'readout' ? applyReadout(normalizeReadout(this.settings.readoutTheme)) : (applyCustom(null), theme);
    document.documentElement.dataset.theme = shown;
    // AWG-9's phosphor colour (Settings → Appearance → Phosphor): green, or amber
    const amber = theme === 'f14' && this.settings.f14Phosphor === 'amber';
    if (amber) document.documentElement.dataset.phosphor = 'amber'; else delete document.documentElement.dataset.phosphor;
    // Blue hour's sky (Settings → Appearance → Sky): dusk is the theme as it is, the others recolour it; Auto goes by the clock
    const auto = theme === 'bluehour' && this.settings.bluehourSky === 'auto';
    const want = auto ? skyAt(new Date().getHours()) : this.settings.bluehourSky;
    const sky = theme === 'bluehour' && want !== 'dusk' && SKIES.some(([id]) => id === want) ? want : '';
    if (sky) document.documentElement.dataset.sky = sky; else delete document.documentElement.dataset.sky;
    // on Auto, look at the clock each minute and change the sky when its hour comes round
    clearInterval(this._skyTimer);
    if (auto) this._skyTimer = setInterval(() => { if (skyAt(new Date().getHours()) !== (document.documentElement.dataset.sky || 'dusk')) this.applyTheme('bluehour', false); }, 60000);
    try {
      localStorage.setItem('bds-theme', shown);
      if (amber) localStorage.setItem('bds-phosphor', 'amber'); else localStorage.removeItem('bds-phosphor');
      if (sky) localStorage.setItem('bds-sky', sky); else localStorage.removeItem('bds-sky');
    } catch { /* ignore */ }
    const b = $('#btn-theme');
    const next = this.themeStep(1, theme);
    clear(b).append(icon(THEMES.find(([id]) => id === next)?.[3] || 'moon')); // shows where a click goes
    b.title = `Theme: ${THEME_NAME[theme] || theme} — click for ${THEME_NAME[next]}, right-click for ${THEME_NAME[this.themeStep(-1, theme)]}`;
    if (persist) this.saveSettings({ theme });
    // Settings open (the top-bar button or View menu changed it): keep its dropdown and the colour boxes in step
    const pick = document.querySelector('select.set-theme');
    if (pick) {
      pick.value = theme;
      const ct = document.querySelector('.ct-box:not(.ro-box):not(.phos-box):not(.sky-box)'), ro = document.querySelector('.ro-box'), ph = document.querySelector('.phos-box'), sk = document.querySelector('.sky-box');
      if (ct) ct.hidden = theme !== 'custom';
      if (ro) ro.hidden = theme !== 'readout';
      if (ph) ph.hidden = theme !== 'f14';
      if (sk) sk.hidden = theme !== 'bluehour';
    }
    this.sunRays(shown === 'bluehour');
    chicken(shown === 'miami');
    for (const t of this.tabs) t.editor?.onThemeChange?.(theme);
    if (window.bdsShell) {
      const cs = getComputedStyle(document.documentElement);
      window.bdsShell.setTitlebar((cs.getPropertyValue('--titlebar-solid') || cs.getPropertyValue('--bg-1')).trim(), (cs.getPropertyValue('--titlebar-text') || cs.getPropertyValue('--text-2')).trim(), shown).catch(() => {});
    }
  }

  /** Blue hour's sun rays over the bars round the window: the header, tab strip, both side rails and the status bar. They fan out from the home page's sun when it's on
   *  screen (from a smaller sun setting on the tab strip when it isn't) and are clipped to those bars, so tab contents never get them; on the home
   *  page they also cross the page above the sun's horizon. They fade behind text and icons. */
  sunRays(on) {
    clearInterval(this._rays?.timer);
    window.removeEventListener('resize', this._rays?.place);
    document.removeEventListener('scroll', this._rays?.place, true);
    this._rays?.el.remove();
    this._rays?.sun.remove();
    this._rays = null;
    if (!on) return;
    const el = document.createElement('div');
    el.className = 'bh-rays';
    // when the home page's sun isn't on screen, a smaller one sets on the tab strip and the rays come from it
    const sun = document.createElement('div');
    sun.className = 'bh-sun';
    document.body.append(el, sun);
    const place = () => {
      const W = innerWidth, H = innerHeight;
      const top = $('#tabbar')?.getBoundingClientRect().bottom || $('#titlebar')?.getBoundingClientRect().bottom || 0;
      // the sun is 124px wide, 32px in from the hero's right edge, sitting on its bottom
      const hero = $('.home-hero');
      const r = hero?.getClientRects().length ? hero.getBoundingClientRect() : null;
      const sunUp = r && r.bottom > top && r.top < H;
      const strip = $('#tabbar')?.getBoundingClientRect();
      sun.hidden = sunUp || !strip?.height;
      if (sunUp) {
        el.style.setProperty('--bh-x', `${r.right - 94}px`);
        el.style.setProperty('--bh-y', `${r.bottom - 1}px`);
        el.style.removeProperty('--bh-hole');
      } else if (strip?.height) {
        // 52 × 26, sitting on the strip's bottom edge 24px in from its right end
        const h = Math.min(26, strip.height - 2), w = h * 2, x = strip.right - 24 - w;
        Object.assign(sun.style, { left: `${x}px`, top: `${strip.bottom - h}px`, width: `${w}px`, height: `${h}px` });
        el.style.setProperty('--bh-x', `${x + w / 2}px`);
        el.style.setProperty('--bh-y', `${strip.bottom - 1}px`);
        el.style.setProperty('--bh-hole', `${Math.round(h * 1.4)}px`);
      } else {
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
    this._rays = { el, sun, place, timer: setInterval(place, 400) };
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, { capture: true, passive: true });
    place();
  }
}
