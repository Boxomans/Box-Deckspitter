// Box-Deckspitter app shell, the Settings screen: fonts, backgrounds, the custom theme, moving your setup, factory reset.
// Methods of App (app.js mixes this class into it).

import { $, h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { modal, toast, errorToast } from '../core/ui.js';
import { normalizeCustom, CUSTOM_PRESETS } from '../core/custom-theme.js';
import { pickOpen, pickSave } from '../core/files.js';
import { DISCORD_INVITE, THEMES, HIDDEN_THEMES } from './shared.js';

// Appearance → Interface font. 'theme' keeps whatever the theme uses (each hidden theme has its own).
const UI_FONTS = [
  ['theme', 'Theme default'],
  ['inter', 'Inter', "'Inter', 'Segoe UI', system-ui, sans-serif"],
  ['segoe', 'Segoe UI', "'Segoe UI', system-ui, sans-serif"],
  ['arial', 'Arial', "Arial, Helvetica, sans-serif"],
  ['verdana', 'Verdana', "Verdana, Geneva, sans-serif"],
  ['trebuchet', 'Trebuchet MS', "'Trebuchet MS', sans-serif"],
  ['georgia', 'Georgia (serif)', "Georgia, 'Times New Roman', serif"],
  ['palatino', 'Palatino (serif)', "'Palatino Linotype', 'Book Antiqua', Palatino, serif"],
  ['plex', 'IBM Plex Mono', "'IBM Plex Mono', Consolas, monospace"],
  ['consolas', 'Consolas', "Consolas, 'Cascadia Mono', monospace"],
  ['comic', 'Comic Sans MS', "'Comic Sans MS', 'Comic Sans', cursive"],
];

/** A font family name made safe to put inside quotes in CSS. */
const cssFamily = (s) => String(s).replace(/['"\\<>;{}]/g, '');

export class SettingsPart {
  /** Settings → Your setup: export / import a .zip of settings + the (still encrypted) Secure notes. */
  setupTransferSettings() {
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Your setup'),
      h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Settings, theme, renames and layout, plus your Secure notes (still encrypted) — never the dumps, recent files or saved keys.'),
      h('div', { class: 'row', style: { gap: '6px' } },
        h('button', { class: 'btn sm', onclick: () => this.exportSetup() }, icon('download', 'sm'), 'Export…'),
        h('button', { class: 'btn sm', onclick: () => this.importSetup() }, icon('upload', 'sm'), 'Import…')));
  }

  async exportSetup() {
    const day = new Date().toISOString().slice(0, 10);
    const out = await pickSave({ title: 'Export your setup', defaultName: `Box-Deckspitter setup ${day}.zip`, filters: [{ name: 'Zip file', extensions: ['zip'] }] });
    if (!out?.path) return;
    try {
      await this.saveGames();
      const r = await api.post('/api/setup/export', { path: out.path.toLowerCase().endsWith('.zip') ? out.path : out.path + '.zip' });
      toast(`Exported${r.secureNotes ? ' (with your encrypted Secure notes)' : ''}`, { type: 'ok', timeout: 4000, action: { label: 'Show', fn: () => api.reveal(r.path) } });
    } catch (e) { errorToast(e, 'Export failed'); }
  }

  async importSetup() {
    const file = (await pickOpen({ title: 'Import a setup', filters: [{ name: 'Zip file', extensions: ['zip'] }] }))?.[0];
    if (!file) return;
    let info;
    try { info = await api.post('/api/setup/inspect', { path: file }); } catch (e) { return errorToast(e, 'Can’t import that'); }
    const replace = h('input', { type: 'checkbox' });
    const ok = await modal({
      title: 'Import this setup?',
      body: h('div', { class: 'col', style: { gap: '8px' } },
        h('p', {}, `From ${info.exported ? new Date(info.exported).toLocaleString() : 'an export'}${info.version ? ` (v${info.version})` : ''}: ${info.settings} settings${info.secureNotes ? ' and Secure notes' : ''}.`),
        h('p', { class: 'dim' }, 'Your settings, theme, renames and layout are replaced by the ones in the file. Folders and things that belong to this PC stay as they are.'),
        info.secureNotes && info.haveNotes ? h('label', { class: 'check' }, replace, `Also replace the Secure notes here with the ones in the file (the current ones are kept in data${BDS.sep}secure-notes${BDS.sep}backups)`) : null,
        info.secureNotes && !info.haveNotes ? h('p', { class: 'dim' }, 'The Secure notes open with your passphrase on the PC they came from, or with your secure key + PIN anywhere else.') : null),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Import', value: 'ok', primary: true }],
    });
    if (ok !== 'ok') return;
    try {
      if (replace.checked) await window.bdsShell?.notes?.({ op: 'lock', hard: true });
      // close the game first so its progress can't be saved over the imported one
      for (const t of this.tabs.filter((x) => x.mode === 'tomcat' || x.mode === 'strike')) await this.closeTab(t);
      await this.stopTomcatFlight();
      const r = await api.post('/api/setup/import', { path: file, replaceNotes: replace.checked });
      toast(`Imported${r.notes === 'imported' ? ' (with Secure notes)' : r.notes === 'kept' ? ' — your Secure notes here were kept' : ''}. Restarting the window…`, { type: 'ok', timeout: 2500 });
      setTimeout(() => location.reload(), 1200);
    } catch (e) { errorToast(e, 'Import failed'); }
  }

  renderSettings() {
    const p = clear(this.sidepanel);
    const s = this.settings;
    const sel = (key, options, onChange) => {
      const el = h('select', {}, options.map(([v, l]) => h('option', { value: v }, l)));
      el.value = String(s[key]);
      el.addEventListener('change', () => { const v = isNaN(el.value) ? el.value : Number(el.value); this.saveSettings({ [key]: v }); onChange?.(v); });
      return el;
    };
    const check = (key, label, onChange) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = s[key] !== false;
      cb.addEventListener('change', () => { this.saveSettings({ [key]: cb.checked }); onChange?.(cb.checked); });
      return h('label', { class: 'check' }, cb, label);
    };
    const customBox = this.customThemeSettings();
    customBox.hidden = s.theme !== 'custom';
    p.append(
      h('div', { class: 'panel-head' }, 'Settings', h('div', { class: 'grow' }), h('button', { class: 'icon-btn', onclick: () => this.hidePanel() }, icon('x', 'sm'))),
      h('div', { class: 'panel-body' }, h('div', { class: 'settings-panel' },
        h('div', { class: 'settings-group' }, h('h4', {}, 'Appearance'),
          (() => {
            // the hidden themes sit under their own heading, apart from the everyday ones
            const el = Object.assign(sel('theme', THEMES.map(([id, , label]) => [id, label]), (v) => this.applyTheme(v)), { className: 'set-theme' });
            if (s.hiddenThemes) {
              el.append(h('optgroup', { class: 'opt-hidden', label: 'Hidden themes' }, HIDDEN_THEMES.map(([id, , label]) => h('option', { value: id }, label))));
              el.value = String(s.theme);
            }
            return el;
          })(),
          customBox,
          h('span', { class: 'dim', style: { fontSize: '12px' } }, 'Interface font'),
          sel('uiFont', this.uiFontList().map(([id, label]) => [id, label]), () => this.applyLook()),
          this.userFontSettings(),
          this.backgroundSettings(),
          check('animations', 'Animations (hovers, fades, sliding panels)', () => this.applyLook()),
          (() => { // off unless switched on
            const cb = h('input', { type: 'checkbox' });
            cb.checked = !!s.fpsCounter;
            cb.addEventListener('change', () => { this.saveSettings({ fpsCounter: cb.checked }); this.fps?.sync(); });
            return h('label', { class: 'check' }, cb, 'FPS counter (a small box you can drag anywhere)');
          })(),
          check('sounds', 'Sounds', () => this.syncSoundButton()),
          check('soundTyping', 'Typing sounds'),
          check('soundHover', 'Hover sounds'),
          (() => {
            const r = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.soundVolume ?? 0.7), title: 'Sound volume' });
            r.addEventListener('input', () => { this.settings.soundVolume = Number(r.value); this.sounds.setVolume(); });
            r.addEventListener('change', () => { this.saveSettings({ soundVolume: Number(r.value) }); this.sounds.play('click'); });
            return h('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, h('span', { class: 'dim' }, 'Volume'), r);
          })()),
        this.soundSettings(),
        this.screensaverSettings(),
        h('div', { class: 'settings-group' }, h('h4', {}, 'Documents'),
          h('span', { class: 'dim' }, 'Default font for new documents'),
          sel('docFont', ['Calibri', 'Arial', 'Georgia', 'Times New Roman', 'Cambria', 'Segoe UI', 'Verdana', 'Garamond', 'Inter'].map((f) => [f, f])),
          h('span', { class: 'dim' }, 'Default size'),
          sel('docSize', [10, 11, 12, 13, 14].map((n) => [n, n + ' pt'])),
          h('span', { class: 'dim' }, 'Paper'),
          sel('paper', [['white', 'White paper'], ['night', 'Night paper (dark)']], () => this.tabs.forEach((t) => t.editor?.onThemeChange?.())),
          check('spellcheck', 'Spell check while typing', () => this.tabs.forEach((t) => t.editor?.onThemeChange?.()))),
        h('div', { class: 'settings-group' }, h('h4', {}, 'Text & code'),
          h('span', { class: 'dim' }, 'Text editor font'),
          sel('textFont', [['mono', 'Monospace (IBM Plex Mono)'], ['sans', 'Sans (Inter)'], ['serif', 'Serif (Georgia)']], () => this.tabs.forEach((t) => t.editor?.onThemeChange?.())),
          h('span', { class: 'dim' }, 'Code font size'),
          sel('codeFontSize', [11, 12, 13, 14, 15, 16, 18].map((n) => [n, n + ' px']), () => this.tabs.forEach((t) => t.editor?.onThemeChange?.()))),
        h('div', { class: 'settings-group' }, h('h4', {}, 'Files'),
          check('nativeDialogs', this.info?.platform === 'win32' ? 'Use Windows open/save dialogs' : 'Use the system’s open/save dialogs'),
          check('showHidden', 'Show hidden & dot files', () => this.panel === 'explorer' && this.renderExplorer()),
          check('drafts', 'Keep crash-recovery drafts of unsaved work'),
          h('span', { class: 'dim' }, 'Opening a video or sound file'),
          sel('videoOpen', [['player', 'Plays it in the video player'], ['trim', 'Opens it in the video trimmer']]),
          h('span', { class: 'dim' }, 'Opening a picture'),
          sel('imageOpen', [['viewer', 'Shows it in the image viewer (quick crop, rotate, resize)'], ['paint', 'Opens it in the image editor, BoxPaint']]),
          check('showRecent', 'Show recent files (home page, Recent panel, File › Open recent)', () => { this.syncRecentRail(); this.refreshHome(); })),
        this.securitySettings(),
        this.setupTransferSettings(),
        this.updateSettings(),
        this.windowsSettings(),
        this.mailSettings(),
        this.discordSettings(),
        this.aiSettings(),
        this.gameSettings(),
        this.easterEggSettings(),
        h('div', { class: 'settings-group' }, h('h4', {}, 'About'),
          h('span', { class: 'dim mono', style: { fontSize: '11px' } }, `v${window.BDS?.version} · data folder: Box-Deckspitter${BDS.sep}data`)),
        h('div', { class: 'settings-group danger-zone' }, h('h4', {}, 'Reset'),
          h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Erase everything Box-Deckspitter has stored and start fresh, like a new copy.'),
          h('button', { class: 'btn sm danger', onclick: () => this.factoryReset() }, icon('trash', 'sm'), 'Reset to clean state…')),
        h('div', { class: 'settings-group' }, h('h4', {}, 'Community'),
          h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Questions, ideas or bugs? Come say hi.'),
          h('button', { class: 'btn sm', onclick: () => window.open(DISCORD_INVITE, '_blank', 'noopener') }, icon('external', 'sm'), 'Join the Discord')))));
  }

  // ---------------------------------------------------------------- your own fonts (data/fonts)

  /** The built-in interface fonts, then yours (ids "u:<id>"). */
  uiFontList() {
    const back = { serif: 'Georgia, serif', monospace: 'Consolas, monospace', handwriting: 'cursive' };
    return [...UI_FONTS, ...(this.userFonts || []).map((f) => [`u:${f.id}`, `${f.family} (yours)`, `'${cssFamily(f.family)}', ${back[f.category] || "'Segoe UI', system-ui, sans-serif"}`])];
  }

  /** Reads data/fonts and puts their @font-face rules on the page. */
  async loadUserFonts() {
    try { this.userFonts = (await api.fonts()).fonts || []; } catch { this.userFonts = []; }
    let el = document.getElementById('user-fonts');
    if (!el) { el = document.createElement('style'); el.id = 'user-fonts'; document.head.append(el); }
    el.textContent = this.userFonts.flatMap((f) => f.faces.map((x) => `@font-face { font-family: '${cssFamily(f.family)}'; font-style: normal; font-display: swap; font-weight: ${x.weight}; `
      + `src: url('/userfonts/${x.file.split('/').map(encodeURIComponent).join('/')}') format('${x.format}');${x.range ? ` unicode-range: ${x.range};` : ''} }`)).join('\n');
    this.applyLook(); // a font of yours picked as the interface font only resolves once the list is in
  }

  /** Settings → Appearance → Your fonts: type a name and it's fetched, or add a file; each one can be removed. */
  userFontSettings() {
    const status = h('div', { class: 'uf-status faint' });
    const input = h('input', { type: 'text', class: 'input uf-input', placeholder: 'Font name', spellcheck: 'false' });
    const getBtn = h('button', { class: 'btn sm primary' }, icon('download', 'sm'), 'Get');
    const get = async (name) => {
      if (!name.trim()) { input.focus(); return; }
      getBtn.disabled = true;
      clear(status).append(h('div', { class: 'spinner' }), ` Looking for “${name.trim()}”…`);
      try {
        const r = await api.getFont(name);
        if (r.font) return this.fontAdded(r.font);
        clear(status);
        if (!r.suggestions?.length) { status.textContent = `No font called “${name.trim()}”. Check the spelling, or add a font file instead.`; return; }
        status.append(h('span', {}, 'Did you mean '), ...r.suggestions.map((s) => h('button', { class: 'chip uf-sugg', onclick: () => { input.value = s.family; get(s.family); } }, s.family)));
      } catch (e) { status.textContent = e.message; } finally { getBtn.disabled = false; }
    };
    getBtn.addEventListener('click', () => get(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); get(input.value); } });
    const mine = (this.userFonts || []).map((f) => h('span', { class: 'chip uf-font', style: { fontFamily: `'${cssFamily(f.family)}', sans-serif` }, title: f.source === 'file' ? 'From a file' : `${f.category || 'font'} · ${f.license || ''}` },
      f.family, h('button', { class: 'uf-x', 'data-tip': 'Remove', onclick: () => this.removeUserFont(f) }, icon('x', 'sm'))));
    return h('div', { class: 'uf-box' },
      h('span', { class: 'dim', style: { fontSize: '12px' } }, 'Your fonts'),
      h('div', { class: 'row uf-row' }, input, getBtn),
      status,
      mine.length ? h('div', { class: 'uf-list' }, ...mine) : null,
      h('div', { class: 'faint', style: { fontSize: '11px' } }, 'Any Google font by name (free, from Fontsource), or a .ttf / .otf of your own.'),
      h('div', { class: 'row' }, h('button', { class: 'btn sm ghost', onclick: () => this.addFontFile() }, icon('folder-open', 'sm'), 'Add a font file…')));
  }

  /** A font just arrived: it becomes the interface font (easy to change back), and the list shows it. */
  async fontAdded(font) {
    await this.saveSettings({ uiFont: `u:${font.id}` });
    await this.loadUserFonts();
    this.redrawSettings();
    toast(`${font.family} added and set as the interface font. Change it back under Interface font.`, { type: 'ok', timeout: 4500 });
  }

  async addFontFile() {
    let p = await pickOpen({ title: 'Choose a font file', filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2'] }] });
    if (Array.isArray(p)) p = p[0];
    if (!p) return;
    try { this.fontAdded((await api.addFontFile(p)).font); } catch (e) { errorToast(e, 'Couldn’t add that font'); }
  }

  async removeUserFont(f) {
    try { await api.removeFont(f.id); } catch (e) { return errorToast(e, 'Couldn’t remove that font'); }
    if (this.settings.uiFont === `u:${f.id}`) await this.saveSettings({ uiFont: 'theme' });
    await this.loadUserFonts();
    this.redrawSettings();
  }

  /** Draws Settings again where you were (lists in it have changed). */
  redrawSettings() {
    if (this.panel !== 'settings') return;
    const y = this.sidepanel.querySelector('.panel-body')?.scrollTop || 0;
    this.renderSettings();
    const body = this.sidepanel.querySelector('.panel-body');
    if (body) body.scrollTop = y;
  }

  /** Settings → Appearance → Background image: any picture behind the app, under any theme. */
  backgroundSettings() {
    const box = h('div', { class: 'bgi-box' });
    const draw = () => {
      const bg = this.settings.bgImage;
      const set = (patch) => { this.saveSettings({ bgImage: { ...this.settings.bgImage, ...patch } }); this.applyLook(); };
      clear(box).append(h('span', { class: 'dim', style: { fontSize: '12px' } }, 'Background image'));
      if (!bg?.file) {
        box.append(h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => this.setAppBackground().then(draw) }, icon('image', 'sm'), 'Choose a picture…')));
        return;
      }
      const slider = (key, min, max, step, def, label, fmt) => {
        const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(bg[key] ?? def) });
        const out = h('span', { class: 'faint mono bgi-val' }, fmt(bg[key] ?? def));
        r.addEventListener('input', () => { out.textContent = fmt(Number(r.value)); set({ [key]: Number(r.value) }); });
        return h('label', { class: 'row bgi-slider' }, h('span', { class: 'dim' }, label), r, out);
      };
      box.append(
        h('div', { class: 'row bgi-row' }, h('div', { class: 'bgi-thumb', style: { backgroundImage: `url("/bg/${encodeURIComponent(bg.file)}")` } }),
          h('button', { class: 'btn sm', onclick: () => this.setAppBackground().then(draw) }, 'Change…'),
          h('button', { class: 'btn sm ghost', onclick: () => this.clearAppBackground().then(draw) }, icon('x', 'sm'), 'Remove')),
        slider('cover', 0, 90, 5, 55, 'Theme over it', (v) => `${v}%`),
        slider('blur', 0, 30, 1, 0, 'Blur', (v) => (v ? `${v} px` : 'off')));
    };
    draw();
    return box;
  }

  /** Puts a picture behind the app (asks for one when no path is given). */
  async setAppBackground(p) {
    if (!p) p = await pickOpen({ title: 'Choose a background picture', filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'bmp'] }] });
    if (Array.isArray(p)) p = p[0];
    if (!p) return;
    try {
      const { file } = await api.setBackground(p);
      await this.saveSettings({ bgImage: { cover: 55, blur: 0, ...this.settings.bgImage, file } });
      this.applyLook();
      toast('App background set. Settings → Appearance changes how much the theme covers it.', { type: 'ok', timeout: 3500 });
    } catch (e) { errorToast(e, 'Couldn’t set the background'); }
  }

  async clearAppBackground() {
    try { await api.clearBackground(); } catch { /* the setting going is what matters */ }
    await this.saveSettings({ bgImage: null });
    this.applyLook();
  }

  async setDesktopBackground(p) {
    try {
      await api.setWallpaper(p);
      toast('Desktop background set.', { type: 'ok', timeout: 2500 });
    } catch (e) { errorToast(e, 'Couldn’t set the desktop background'); }
  }

  /** "Set as app background" / "Set as desktop background" for one picture (nothing for other files). */
  backgroundMenu(paths) {
    if (paths.length !== 1 || !/\.(png|jpe?g|jfif|webp|gif|bmp)$/i.test(paths[0])) return [];
    const p = paths[0];
    const desk = /\.(png|jpe?g|jfif|bmp)$/i.test(p) && this.info?.platform === 'win32';
    return [
      { label: 'Set as app background', icon: 'image', action: () => this.setAppBackground(p) },
      ...(desk ? [{ label: 'Set as desktop background', icon: 'window', action: () => this.setDesktopBackground(p) }] : []),
    ];
  }

  /** Settings → Appearance → Custom: a few colours (or a preset) and everything else is worked out from them. */
  customThemeSettings() {
    const box = h('div', { class: 'ct-box' });
    const draw = () => {
      const c = normalizeCustom(this.settings.customTheme);
      const set = (patch) => {
        this.saveSettings({ customTheme: { ...normalizeCustom(this.settings.customTheme), ...patch } });
        if (this.settings.theme === 'custom') this.applyTheme('custom', false);
      };
      const pick = (key, label) => {
        const inp = h('input', { type: 'color', value: c[key] });
        inp.addEventListener('input', () => set({ [key]: inp.value }));
        return h('label', { class: 'ct-pick' }, inp, label);
      };
      const tone = (v, label) => h('button', { class: c.base === v ? 'on' : '', onclick: () => {
        // flipping dark / light keeps the hue of the background but moves it to the other end
        const flip = c.base !== v ? (v === 'light' ? '#f4f2f7' : '#121016') : c.bg;
        set({ base: v, bg: c.base !== v ? blendBg(c.bg, flip) : c.bg }); draw();
      } }, label);
      clear(box).append(
        h('div', { class: 'ct-presets' }, ...CUSTOM_PRESETS.map((p) => h('button', {
          class: 'ct-preset' + (p.bg === c.bg && p.accent === c.accent && p.accent2 === c.accent2 ? ' on' : ''),
          'data-tip': p.name, style: { background: p.bg },
          onclick: () => { set({ base: p.base, bg: p.bg, accent: p.accent, accent2: p.accent2 }); draw(); },
        }, h('span', { style: { background: p.accent } }), h('span', { style: { background: p.accent2 } })))),
        h('div', { class: 'ct-row' }, h('div', { class: 'seg ct-tone' }, tone('dark', 'Dark'), tone('light', 'Light')),
          pick('bg', 'Background'), pick('accent', 'Accent'), pick('accent2', 'Highlight')),
        (() => {
          const on = h('input', { type: 'checkbox', checked: c.gradient });
          on.addEventListener('change', () => { set({ gradient: on.checked }); draw(); });
          const ang = h('input', { type: 'range', min: '0', max: '359', step: '1', value: String(c.angle), title: 'Direction', class: 'ct-angle' });
          const deg = h('span', { class: 'ct-deg' }, `${c.angle}°`);
          ang.addEventListener('input', () => { deg.textContent = `${ang.value}°`; set({ angle: Number(ang.value) }); });
          return h('div', { class: 'ct-row' }, h('label', { class: 'check' }, on, 'Gradient background'),
            c.gradient ? pick('bg2', 'Fades to') : null, c.gradient ? ang : null, c.gradient ? deg : null);
        })(),
        h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Pick a preset or your own three colours; every other shade is worked out from them.'));
    };
    // keep a little of the old background's colour when switching between dark and light
    const blendBg = (from, to) => {
      const a = parseInt(from.slice(1), 16), b = parseInt(to.slice(1), 16);
      const ch = (n, s) => (n >> s) & 255;
      return '#' + [16, 8, 0].map((s) => Math.round(ch(b, s) + (ch(a, s) - ch(b, s)) * 0.12).toString(16).padStart(2, '0')).join('');
    };
    draw();
    return box;
  }

  async factoryReset() {
    const DUMP_KINDS = [['media', 'media dump', 'file'], ['doc', 'doc dump', 'document'], ['audio', 'audio dump', 'song']];
    const counts = {};
    await Promise.all(DUMP_KINDS.map(async ([k]) => { try { counts[k] = (await api.dump(k)).items.length; } catch { counts[k] = 0; } }));
    const dumpBoxes = DUMP_KINDS.map(([k, label, noun]) => {
      const cb = h('input', { type: 'checkbox', checked: counts[k] > 0 });
      cb.disabled = !counts[k];
      return { k, cb, row: h('label', { class: 'check' }, cb, counts[k] ? `Also delete the ${counts[k]} ${noun}${counts[k] === 1 ? '' : 's'} in the ${label}` : `The ${label} is empty`) };
    });
    const notesBox = h('input', { type: 'checkbox' });
    const ok = await modal({
      title: 'Reset to clean state',
      body: h('div', { class: 'reset-body' },
        h('p', {}, 'This permanently erases:'),
        h('ul', {},
          h('li', {}, 'settings, theme and window preferences'),
          h('li', {}, 'recent files and recent BoxSpaces'),
          h('li', {}, 'crash-recovery drafts and saved version history'),
          h('li', {}, 'your AI API keys, Discord lines and form-fill info'),
          h('li', {}, 'caches (app window cache, compiled StoragePeek scanner)')),
        ...dumpBoxes.map((b) => b.row),
        h('label', { class: 'check' }, notesBox, 'Also delete Secure notes (can’t be undone — without this they’re kept)'),
        h('p', { class: 'faint' }, 'Your own documents and files saved anywhere else are not touched. Box-Deckspitter restarts when it’s done.')),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Erase everything', value: 'ok', danger: true }],
    });
    if (ok !== 'ok') return;
    if (!(await this.closeAll())) return toast('Reset cancelled — a document is still open.', { type: 'warn' });
    if (notesBox.checked) await window.bdsShell?.notes?.({ op: 'lock', hard: true });
    let res;
    try {
      res = await fetch('/api/reset', { method: 'POST', headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ dumps: dumpBoxes.filter((b) => b.cb.checked).map((b) => b.k), secureNotes: notesBox.checked }) }).then((r) => r.json());
    } catch (e) { return errorToast(e, 'Reset failed'); }
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
    this.resetting = true;
    document.body.innerHTML = `<div class="loading-pane">${res.relaunch ? 'Reset complete — restarting Box-Deckspitter…' : 'Reset complete. Box-Deckspitter has stopped — start it again for a fresh copy.'}</div>`;
  }

  // ======================================================================= Windows file types

  // ======================================================================= startup notes, updates
}
