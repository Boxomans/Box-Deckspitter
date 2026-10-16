// Box-DocSpitter app shell, themes and the UI font.
// Methods of App (app.js mixes this class into it).

import { $, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { applyCustom, normalizeCustom } from '../core/custom-theme.js';
import { THEMES, HIDDEN_THEMES } from './shared.js';

const THEME_NAME = Object.fromEntries([...THEMES, ...HIDDEN_THEMES].map(([id, name]) => [id, name]));

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
    for (const t of this.tabs) t.editor?.onThemeChange?.(theme);
    if (window.bdsShell) {
      const cs = getComputedStyle(document.documentElement);
      window.bdsShell.setTitlebar((cs.getPropertyValue('--titlebar-solid') || cs.getPropertyValue('--bg-1')).trim(), (cs.getPropertyValue('--titlebar-text') || cs.getPropertyValue('--text-2')).trim(), shown).catch(() => {});
    }
  }
}
