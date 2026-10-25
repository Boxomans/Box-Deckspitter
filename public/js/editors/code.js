// Code mode — Monaco editor for config files, HTML, Markdown and source code, with live preview.

import { BaseEditor } from './base.js';
import { h, clear, decodeText, encodeText, detectEol, debounce, clamp, dirname, vendor, escapeHtml, stripExt } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { tbButton, tbSep, tbSelect, showMenu, toast, errorToast } from '../core/ui.js';
import { LANGUAGES, langForName } from '../core/filetypes.js';
import { api } from '../core/api.js';

let monacoPromise = null;

/** The Monaco colour theme that goes with the app theme (its right-click menu and lists in the app theme's colours). */
export const monacoTheme = (t) => withMenus(t === 'custom' || t === 'readout' ? customMonaco() : t === 'light' ? 'bds-light' : t === 'dusk' ? 'bds-dusk' : t === 'pbj' ? 'bds-pbj' : t === 'f14' ? (document.documentElement.dataset.phosphor === 'amber' ? 'bds-f14-amber' : 'bds-f14') : t === 'blood' ? 'bds-blood' : t === 'blurple' ? 'bds-blurple' : t === 'kabuto' ? 'bds-kabuto' : t === 'temple' ? 'bds-temple' : t === 'lubyanka' ? 'bds-lubyanka' : t === 'miami' ? 'bds-miami' : t === 'bluehour' ? (document.documentElement.dataset.sky ? 'bds-bluehour-' + document.documentElement.dataset.sky : 'bds-bluehour') : 'bds-dark');

const allDefs = {}; // every Monaco theme as first defined, so the menu colours can be laid over it again
/** Any CSS colour → #rrggbb (Monaco wants hex; theme variables may be rgb() or a name). */
function hex(c) {
  const x = document.createElement('canvas').getContext('2d');
  x.fillStyle = '#000';
  x.fillStyle = String(c || '').trim() || '#000';
  const f = x.fillStyle;
  if (f.startsWith('#')) return f;
  const m = /rgba?\(([^)]+)\)/.exec(f);
  return m ? '#' + m[1].split(',').slice(0, 3).map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join('') : '#000000';
}
/** Re-defines a theme with the editor's menus, suggestion list and quick-pick in the current app theme's colours
 *  (read live from the page, so the hidden and custom themes get theirs too) instead of Monaco's blue. */
function withMenus(name) {
  const def = allDefs[name];
  if (!window.monaco || !def) return name;
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => hex(cs.getPropertyValue(n));
  const acc = v('--accent'), acc2 = v('--accent-2'), bg = v('--bg-3'), fg = v('--text'), line = v('--line-2');
  window.monaco.editor.defineTheme(name, {
    ...def,
    colors: {
      // the accent bits a theme doesn't colour itself (cursor, selection, find, brackets) in the app theme's accents
      'editorLineNumber.activeForeground': acc, 'editorCursor.foreground': acc2,
      'editor.selectionBackground': acc + '38', 'editor.inactiveSelectionBackground': acc + '1f', 'editor.selectionHighlightBackground': acc + '1a',
      'editor.findMatchBackground': acc2 + '55', 'editor.findMatchHighlightBackground': acc + '33',
      'editorIndentGuide.activeBackground1': acc + '40', 'editorBracketMatch.background': acc + '22', 'editorBracketMatch.border': acc + '66',
      ...def.colors,
      'menu.background': bg, 'menu.foreground': fg, 'menu.border': line, 'menu.separatorBackground': line,
      'menu.selectionBackground': acc + '3d', 'menu.selectionForeground': fg, 'menu.selectionBorder': acc + '00',
      'list.activeSelectionBackground': acc + '3d', 'list.activeSelectionForeground': fg, 'list.focusBackground': acc + '33',
      'list.hoverBackground': acc + '1f', 'list.inactiveSelectionBackground': acc + '26', 'list.highlightForeground': v('--accent-strong'),
      'quickInputList.focusBackground': acc + '3d', 'quickInput.background': bg, 'pickerGroup.foreground': acc,
      'editorSuggestWidget.selectedBackground': acc + '33', 'editorSuggestWidget.highlightForeground': v('--accent-strong'),
      'widget.border': line, 'focusBorder': acc + '88',
    },
  }, true);
  return name;
}

/** The code font: the default, or the theme's own where it has one (TEMPLE's pixel font). Monaco measures it once loaded. */
const codeFont = (t) => (t === 'temple' ? "'BDS Temple', " : "'IBM Plex Mono', ") + "'Cascadia Code', Consolas, monospace";
function fontReady(monaco, t) { if (t === 'temple') document.fonts.load('13px "BDS Temple"').then(() => monaco.editor.remeasureFonts()).catch(() => {}); }

let themeDefs = null; // the built-in definitions, kept to build the custom one from
/** Re-made each time (the palette may have changed): the base theme's syntax colours on the palette's backgrounds. */
function customMonaco() {
  const light = document.documentElement.dataset.theme === 'light';
  if (!window.monaco || !themeDefs) return light ? 'bds-light' : 'bds-dark';
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  const def = light ? themeDefs.light : themeDefs.dark;
  const bg = light ? v('--bg-2') : mix(v('--bg-1'), v('--bg-0'));
  const acc = v('--accent'), acc2 = v('--accent-2');
  window.monaco.editor.defineTheme('bds-custom', {
    ...def,
    colors: {
      ...def.colors,
      'editor.background': bg, 'editorGutter.background': bg, 'minimap.background': bg, 'editor.foreground': v('--text'),
      'editorLineNumber.foreground': v('--text-3') + '88', 'editorLineNumber.activeForeground': acc, 'editorCursor.foreground': acc2,
      'editor.selectionBackground': acc + '38', 'editor.inactiveSelectionBackground': acc + '1f', 'editor.selectionHighlightBackground': acc + '1a',
      'editor.findMatchHighlightBackground': acc + '33', 'editorBracketMatch.background': acc + '22', 'editorBracketMatch.border': acc + '66',
      'editorIndentGuide.activeBackground1': acc + '40', 'focusBorder': acc + '88', 'editorSuggestWidget.selectedBackground': acc + '2e',
      'editorWidget.background': v('--bg-3'), 'editorWidget.border': v('--line-2'), 'editorSuggestWidget.background': v('--bg-3'),
      'editorHoverWidget.background': v('--bg-3'), 'input.background': v('--bg-2'), 'input.border': v('--line-2'),
    },
  });
  return 'bds-custom';
}
const mix = (a, b) => '#' + [1, 3, 5].map((i) => Math.round((parseInt(a.slice(i, i + 2), 16) + parseInt(b.slice(i, i + 2), 16)) / 2).toString(16).padStart(2, '0')).join('');

export function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    const base = `${location.origin}/vendor/monaco-editor/min`;
    window.MonacoEnvironment = {
      getWorkerUrl() {
        return URL.createObjectURL(new Blob([`self.MonacoEnvironment={baseUrl:'${base}/'};importScripts('${base}/vs/base/worker/workerMain.js');`], { type: 'text/javascript' }));
      },
    };
    const s = document.createElement('script');
    s.src = '/vendor/monaco-editor/min/vs/loader.js';
    s.onload = () => {
      window.require.config({ paths: { vs: '/vendor/monaco-editor/min/vs' } });
      window.require(['vs/editor/editor.main'], () => { defineThemes(window.monaco); resolve(window.monaco); }, reject);
    };
    s.onerror = () => reject(new Error('Could not load the code editor'));
    document.head.append(s);
  });
  return monacoPromise;
}

function defineThemes(monaco) {
  if (!monaco.editor.__bdsKept) {
    const define = monaco.editor.defineTheme.bind(monaco.editor);
    monaco.editor.defineTheme = (name, def, again) => { if (!again) allDefs[name] = def; return define(name, def); };
    monaco.editor.__bdsKept = true;
  }
  const shared = [
    { token: 'comment', fontStyle: 'italic' },
  ];
  const darkDef = {
    base: 'vs-dark', inherit: true,
    rules: [
      ...shared,
      { token: 'comment', foreground: '6e6483', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c7a6ff' },
      { token: 'keyword.json', foreground: 'c7a6ff' },
      { token: 'string', foreground: 'f7a8d8' },
      { token: 'string.key.json', foreground: 'c7a6ff' },
      { token: 'string.value.json', foreground: 'f7a8d8' },
      { token: 'number', foreground: '6ee7e0' },
      { token: 'regexp', foreground: '6ee7e0' },
      { token: 'type', foreground: '9cc2ff' },
      { token: 'type.identifier', foreground: '9cc2ff' },
      { token: 'tag', foreground: 'c7a6ff' },
      { token: 'metatag', foreground: 'b0a6c4' },
      { token: 'attribute.name', foreground: '6ee7e0' },
      { token: 'attribute.value', foreground: 'f7a8d8' },
      { token: 'delimiter', foreground: '9d93b3' },
      { token: 'key', foreground: 'c7a6ff' },
      { token: 'variable', foreground: 'e7e1f3' },
      { token: 'variable.predefined', foreground: '9cc2ff' },
      { token: 'constant', foreground: '6ee7e0' },
    ],
    colors: {
      'editor.background': '#0d0a13',
      'diffEditor.insertedLineBackground': '#3ddc841c', 'diffEditor.insertedTextBackground': '#3ddc8455', 'diffEditor.removedLineBackground': '#ff4d6d1f', 'diffEditor.removedTextBackground': '#ff4d6d5c', 'diffEditorGutter.insertedLineBackground': '#3ddc8430', 'diffEditorGutter.removedLineBackground': '#ff4d6d33', 'diffEditorOverview.insertedForeground': '#3ddc84aa', 'diffEditorOverview.removedForeground': '#ff4d6daa', 'diffEditor.diagonalFill': '#ffffff10',
      'editor.foreground': '#e7e1f3',
      'editorLineNumber.foreground': '#433a58',
      'editor.lineHighlightBackground': '#ffffff05',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': '#ffffff0b',
      'editorWidget.background': '#1c1726',
      'editorWidget.border': '#352c49',
      'editorSuggestWidget.background': '#1c1726',
      'editorHoverWidget.background': '#1c1726',
      'input.background': '#15111d',
      'input.border': '#352c49',
      'minimap.background': '#0d0a13',
      'scrollbarSlider.background': '#2c244088',
      'scrollbarSlider.hoverBackground': '#3d3358aa',
      'editorGutter.background': '#0d0a13',
      'editorOverviewRuler.border': '#00000000',
    },
  };
  // Charcoal (the default dark) has its own quiet colours: soft lavender keywords, sand strings, slate-teal numbers on grey.
  // The purple set above stays the base the other dark themes build on.
  const charcoalDef = {
    base: 'vs-dark', inherit: true,
    rules: [
      ...shared,
      { token: 'comment', foreground: '6b6d73', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'b9a8f4' },
      { token: 'keyword.json', foreground: 'b9a8f4' },
      { token: 'string', foreground: 'c9b285' },
      { token: 'string.key.json', foreground: 'cbbdf8' },
      { token: 'string.value.json', foreground: 'c9b285' },
      { token: 'number', foreground: '8fb3b9' },
      { token: 'regexp', foreground: '8fb3b9' },
      { token: 'type', foreground: '9eaecb' },
      { token: 'type.identifier', foreground: '9eaecb' },
      { token: 'tag', foreground: 'b9a8f4' },
      { token: 'metatag', foreground: 'a5a6ab' },
      { token: 'attribute.name', foreground: '8fb3b9' },
      { token: 'attribute.value', foreground: 'c9b285' },
      { token: 'delimiter', foreground: '8b8d93' },
      { token: 'key', foreground: 'cbbdf8' },
      { token: 'variable', foreground: 'e4e4e6' },
      { token: 'variable.predefined', foreground: 'd39ae6' },
      { token: 'constant', foreground: '8fb3b9' },
    ],
    colors: {
      ...darkDef.colors,
      'editor.background': '#151618', 'editorGutter.background': '#151618', 'minimap.background': '#151618',
      'editor.foreground': '#e4e4e6',
      'editorLineNumber.foreground': '#3c3e43', 'editorLineNumber.activeForeground': '#a5a6ab',
      'editorCursor.foreground': '#b3a1f2',
      'editor.selectionBackground': '#ffffff1f', 'editor.inactiveSelectionBackground': '#ffffff12', 'editor.selectionHighlightBackground': '#ffffff10',
      'editor.findMatchBackground': '#b3a1f244', 'editor.findMatchHighlightBackground': '#b3a1f226',
      'editorIndentGuide.activeBackground1': '#ffffff26',
      'editorBracketMatch.background': '#ffffff14', 'editorBracketMatch.border': '#ffffff40',
      'editorWidget.background': '#242528', 'editorWidget.border': '#37383d',
      'editorSuggestWidget.background': '#242528', 'editorSuggestWidget.selectedBackground': '#ffffff14',
      'editorHoverWidget.background': '#242528',
      'input.background': '#1d1e21', 'input.border': '#37383d',
      'focusBorder': '#b3a1f288',
      'scrollbarSlider.background': '#30313588', 'scrollbarSlider.hoverBackground': '#44454aaa',
      'editorBracketHighlight.foreground1': '#c9b285', 'editorBracketHighlight.foreground2': '#b49bb1', 'editorBracketHighlight.foreground3': '#8fb3b9',
    },
  };
  monaco.editor.defineTheme('bds-dark', charcoalDef);
  // Neon dusk: the purple set (its cursor, selection and find colours come from the theme's accents)
  monaco.editor.defineTheme('bds-dusk', darkDef);
  // Blue hour (hidden): sunset keywords, gold strings, cyan numbers on blue-hour navy
  const blueHourDef = {
    base: 'vs-dark', inherit: true,
    rules: [
      ...shared,
      { token: 'comment', foreground: '5f6883', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'ff9e6b' },
      { token: 'keyword.json', foreground: 'ff9e6b' },
      { token: 'string', foreground: 'f2c47e' },
      { token: 'string.key.json', foreground: 'ffb184' },
      { token: 'string.value.json', foreground: 'f2c47e' },
      { token: 'number', foreground: '4fd8eb' },
      { token: 'regexp', foreground: '4fd8eb' },
      { token: 'type', foreground: '8fb4ff' },
      { token: 'type.identifier', foreground: '8fb4ff' },
      { token: 'tag', foreground: 'ff9e6b' },
      { token: 'metatag', foreground: 'a7aec4' },
      { token: 'attribute.name', foreground: '4fd8eb' },
      { token: 'attribute.value', foreground: 'f2c47e' },
      { token: 'delimiter', foreground: '8c93a8' },
      { token: 'key', foreground: 'ffb184' },
      { token: 'variable', foreground: 'eceef5' },
      { token: 'variable.predefined', foreground: 'e36bd0' },
      { token: 'constant', foreground: '4fd8eb' },
    ],
    colors: {
      ...darkDef.colors,
      'editor.background': '#0c0f17', 'editorGutter.background': '#0c0f17', 'minimap.background': '#0c0f17',
      'editor.foreground': '#eceef5',
      'editorLineNumber.foreground': '#343b52', 'editorLineNumber.activeForeground': '#ff9663',
      'editorCursor.foreground': '#4fd8eb',
      'editor.selectionBackground': '#ff966333', 'editor.inactiveSelectionBackground': '#ff96631c', 'editor.selectionHighlightBackground': '#ff966318',
      'editor.findMatchBackground': '#4fd8eb44', 'editor.findMatchHighlightBackground': '#ff966330',
      'editorIndentGuide.activeBackground1': '#ff96633d',
      'editorBracketMatch.background': '#ff966320', 'editorBracketMatch.border': '#ff966366',
      'editorWidget.background': '#181d2c', 'editorWidget.border': '#2b3248',
      'editorSuggestWidget.background': '#181d2c', 'editorSuggestWidget.selectedBackground': '#ff96632b',
      'editorHoverWidget.background': '#181d2c',
      'input.background': '#121622', 'input.border': '#2b3248',
      'focusBorder': '#ff966388',
      'scrollbarSlider.background': '#262d4288', 'scrollbarSlider.hoverBackground': '#353e5aaa',
    },
  };
  monaco.editor.defineTheme('bds-bluehour', blueHourDef);
  // Blue hour's other skies: the same theme with each colour moved to the sky's counterpart
  const SKY_COLOURS = {
    midnight: { '5f6883': '525a78', ff9e6b: '9fe6ff', f2c47e: 'd6d2f2', ffb184: 'c4f1ff', '4fd8eb': 'b7a3ff', '8fb4ff': '7f9fff', a7aec4: '9fa7c2', '8c93a8': '7f87a2', eceef5: 'e6e9f5',
      e36bd0: 'f0b0ff', '0c0f17': '080a12', '343b52': '283048', ff9663: '9fe6ff', '181d2c': '111522', '2b3248': '222a3e', '121622': '0c0f1a', '262d42': '1e2538', '353e5a': '2c3550' },
    dawn: { '5f6883': '7d7b99', ff9e6b: 'ffb08a', f2c47e: 'ffe0a0', ffb184: 'ffd2ae', '4fd8eb': 'a8d8ff', '8fb4ff': 'b8b0ff', a7aec4: 'c3bfd2', '8c93a8': 'a39fba', eceef5: 'f6f0ee',
      e36bd0: 'ff9ec4', '0c0f17': '1c1f31', '343b52': '454a6b', ff9663: 'ffc58a', '181d2c': '2e334f', '2b3248': '3e4466', '121622': '272b44', '262d42': '3c4262', '353e5a': '4d5478' },
    drive: { '5f6883': '6a5a8c', ff9e6b: 'ff3ea5', f2c47e: 'ffd25c', ffb184: 'ff6fbd', '4fd8eb': '2de2ff', '8fb4ff': 'b46bff', a7aec4: 'b9a8d8', '8c93a8': '8f80b0', eceef5: 'f3ecff',
      e36bd0: 'ff8a3d', '0c0f17': '0e071c', '343b52': '3a2860', ff9663: 'ff3ea5', '181d2c': '1f1238', '2b3248': '36225a', '121622': '180e2c', '262d42': '2e1c4c', '353e5a': '402a66' },
    overcast: { '5f6883': '5f6876', ff9e6b: 'd9a3a0', f2c47e: 'd8c8a6', ffb184: 'e8bcb9', '4fd8eb': 'a9c9c4', '8fb4ff': '9fb4cc', a7aec4: 'a2abb8', '8c93a8': '858e9c', eceef5: 'e3e7ec',
      e36bd0: 'c4a3c4', '0c0f17': '12161b', '343b52': '333c49', ff9663: 'd9a3a0', '181d2c': '212831', '2b3248': '2e3742', '121622': '1a2028', '262d42': '29313c', '353e5a': '3a4452' },
  };
  for (const [sky, map] of Object.entries(SKY_COLOURS)) {
    monaco.editor.defineTheme('bds-bluehour-' + sky, JSON.parse(JSON.stringify(blueHourDef).replace(/[0-9a-f]{6}/gi, (c) => map[c.toLowerCase()] || c)));
  }
  themeDefs = { dark: darkDef };
  // PB&J: the dark syntax colours on a plum background
  monaco.editor.defineTheme('bds-pbj', {
    ...darkDef,
    colors: {
      ...darkDef.colors,
      'editor.background': '#2a1a2b', 'editorGutter.background': '#2a1a2b', 'minimap.background': '#2a1a2b',
      'editor.lineHighlightBackground': '#ffffff07', 'editorLineNumber.foreground': '#6e4f6b', 'editorLineNumber.activeForeground': '#f0b232',
      'editorCursor.foreground': '#f0b232', 'editor.selectionBackground': '#5865f255', 'editorWidget.background': '#391f38', 'editorWidget.border': '#5f3a59',
    },
  });
  // AWG-9: phosphor green, amber strings, blue numbers, on the scope's black
  const f14Def = {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: '', foreground: 'b9ffc0' },
      { token: 'comment', foreground: '4f7a50', fontStyle: 'italic' },
      { token: 'keyword', foreground: '54ff6b' }, { token: 'keyword.json', foreground: '54ff6b' },
      { token: 'string', foreground: 'ffb36b' }, { token: 'string.key.json', foreground: '8afc96' }, { token: 'string.value.json', foreground: 'ffb36b' },
      { token: 'number', foreground: '8fd8ff' }, { token: 'regexp', foreground: '8fd8ff' }, { token: 'constant', foreground: '8fd8ff' },
      { token: 'type', foreground: 'ffd36b' }, { token: 'type.identifier', foreground: 'ffd36b' },
      { token: 'tag', foreground: '54ff6b' }, { token: 'attribute.name', foreground: '8fd8ff' }, { token: 'attribute.value', foreground: 'ffb36b' },
      { token: 'delimiter', foreground: '6f9f70' }, { token: 'key', foreground: '8afc96' }, { token: 'variable', foreground: 'cfe8cf' },
    ],
    colors: {
      ...darkDef.colors,
      'editor.background': '#080b08', 'editorGutter.background': '#080b08', 'minimap.background': '#080b08', 'editor.foreground': '#b9ffc0',
      'editorLineNumber.foreground': '#2f4a30', 'editorLineNumber.activeForeground': '#54ff6b', 'editorCursor.foreground': '#54ff6b',
      'editor.selectionBackground': '#54ff6b33', 'editor.inactiveSelectionBackground': '#54ff6b1a', 'editor.selectionHighlightBackground': '#54ff6b17',
      'editor.lineHighlightBackground': '#54ff6b08', 'editor.findMatchBackground': '#ffb36b55', 'editor.findMatchHighlightBackground': '#54ff6b2a',
      'editorIndentGuide.activeBackground1': '#54ff6b40', 'editorBracketMatch.background': '#54ff6b22', 'editorBracketMatch.border': '#54ff6b66',
      'editorWidget.background': '#141a14', 'editorWidget.border': '#2c4a2c', 'editorSuggestWidget.background': '#141a14',
      'editorSuggestWidget.selectedBackground': '#54ff6b2a', 'editorHoverWidget.background': '#141a14', 'input.background': '#0f130f',
      'input.border': '#2c4a2c', 'focusBorder': '#54ff6b88', 'scrollbarSlider.background': '#1e2e1e88', 'scrollbarSlider.hoverBackground': '#2c4a2caa',
    },
  };
  monaco.editor.defineTheme('bds-f14', f14Def);
  // AWG-9 in amber phosphor: the same theme with every colour moved to its amber counterpart
  const AMBER = { b9ffc0: 'ffd9a0', '4f7a50': '7a5a30', '54ff6b': 'ffb000', ffb36b: 'ff7a1a', '8afc96': 'ffc94d', '8fd8ff': 'ffe6a8', ffd36b: 'ffd77a',
    '6f9f70': '9f7a45', cfe8cf: 'f2dcb8', '080b08': '0b0805', '2f4a30': '4a3518', '141a14': '1a150d', '2c4a2c': '4a3518', '0f130f': '13100a', '1e2e1e': '2e2414' };
  monaco.editor.defineTheme('bds-f14-amber', JSON.parse(JSON.stringify(f14Def).replace(/[0-9a-f]{6}/gi, (c) => AMBER[c.toLowerCase()] || c)));
  // Bloodflame Talons: blood-red keywords, ember numbers, gold types, ash everything else, on charcoal
  monaco.editor.defineTheme('bds-blood', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: '', foreground: 'd8d5d0' },
      { token: 'comment', foreground: '625f59', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'e8363c' }, { token: 'keyword.json', foreground: 'e8363c' },
      { token: 'string', foreground: 'd98a7e' }, { token: 'string.key.json', foreground: 'e8363c' }, { token: 'string.value.json', foreground: 'd98a7e' },
      { token: 'number', foreground: 'ff7a4d' }, { token: 'regexp', foreground: 'ff7a4d' }, { token: 'constant', foreground: 'ff7a4d' },
      { token: 'type', foreground: 'c9a24a' }, { token: 'type.identifier', foreground: 'c9a24a' },
      { token: 'tag', foreground: 'e8363c' }, { token: 'attribute.name', foreground: 'ff7a4d' }, { token: 'attribute.value', foreground: 'd98a7e' },
      { token: 'delimiter', foreground: '8a867f' }, { token: 'key', foreground: 'e8363c' }, { token: 'variable', foreground: 'dedcd8' },
    ],
    colors: {
      ...darkDef.colors,
      'editor.background': '#0e0e10', 'editorGutter.background': '#0e0e10', 'minimap.background': '#0e0e10', 'editor.foreground': '#d8d5d0',
      'editorLineNumber.foreground': '#3c3a36', 'editorLineNumber.activeForeground': '#c9a24a', 'editorCursor.foreground': '#ff3d2e',
      'editor.selectionBackground': '#c8161d40', 'editor.inactiveSelectionBackground': '#c8161d22', 'editor.selectionHighlightBackground': '#c8161d1c',
      'editor.lineHighlightBackground': '#c9a24a0a', 'editor.findMatchBackground': '#ff5a3255', 'editor.findMatchHighlightBackground': '#c8161d33',
      'editorIndentGuide.activeBackground1': '#c9a24a50', 'editorBracketMatch.background': '#c8161d22', 'editorBracketMatch.border': '#c9a24a88',
      'editorWidget.background': '#1a1a1d', 'editorWidget.border': '#45403a', 'editorSuggestWidget.background': '#1a1a1d',
      'editorSuggestWidget.selectedBackground': '#c8161d33', 'editorHoverWidget.background': '#1a1a1d', 'input.background': '#131315',
      'input.border': '#45403a', 'focusBorder': '#c9a24a88', 'scrollbarSlider.background': '#3a3a3e88', 'scrollbarSlider.hoverBackground': '#57503faa',
    },
  });
  // TEMPLE: the VGA colours on white. Blue text, red keywords, green comments, brown strings, magenta numbers, cyan types
  monaco.editor.defineTheme('bds-temple', {
    base: 'vs', inherit: true,
    rules: [
      { token: '', foreground: '0000aa' },
      { token: 'comment', foreground: '00aa00' },
      { token: 'keyword', foreground: 'aa0000' }, { token: 'keyword.json', foreground: 'aa0000' },
      { token: 'string', foreground: 'aa5500' }, { token: 'string.key.json', foreground: 'aa0000' }, { token: 'string.value.json', foreground: 'aa5500' },
      { token: 'number', foreground: 'aa00aa' }, { token: 'regexp', foreground: 'aa00aa' }, { token: 'constant', foreground: 'aa00aa' },
      { token: 'type', foreground: '00aaaa' }, { token: 'type.identifier', foreground: '00aaaa' },
      { token: 'tag', foreground: 'aa0000' }, { token: 'attribute.name', foreground: 'aa00aa' }, { token: 'attribute.value', foreground: 'aa5500' },
      { token: 'delimiter', foreground: '0000aa' }, { token: 'key', foreground: 'aa0000' }, { token: 'variable', foreground: '0000aa' },
    ],
    colors: {
      'editor.background': '#ffffff', 'editorGutter.background': '#ffffff', 'minimap.background': '#ffffff', 'editor.foreground': '#0000aa',
      'editorLineNumber.foreground': '#5555ff', 'editorLineNumber.activeForeground': '#aa0000', 'editorCursor.foreground': '#0000aa',
      'editor.selectionBackground': '#ffff55', 'editor.inactiveSelectionBackground': '#ffff5599', 'editor.selectionHighlightBackground': '#55ffff66',
      'editor.lineHighlightBackground': '#55ffff33', 'editor.findMatchBackground': '#ffff55', 'editor.findMatchHighlightBackground': '#55ffff88',
      'editorIndentGuide.background1': '#aaaaaa', 'editorIndentGuide.activeBackground1': '#0000aa', 'editorBracketMatch.background': '#55ffff', 'editorBracketMatch.border': '#0000aa',
      'editorWidget.background': '#ffffff', 'editorWidget.border': '#0000aa', 'editorSuggestWidget.background': '#ffffff', 'editorSuggestWidget.border': '#0000aa',
      'editorSuggestWidget.selectedBackground': '#ffff55', 'editorHoverWidget.background': '#ffffff', 'editorHoverWidget.border': '#0000aa', 'input.background': '#ffffff',
      'input.border': '#0000aa', 'focusBorder': '#aa00aa', 'scrollbarSlider.background': '#0000aa88', 'scrollbarSlider.hoverBackground': '#5555ffaa',
    },
  });
  // Miami Hotline: neon pink keywords, sunset-yellow strings, teal types, lavender comments, on dusk purple
  monaco.editor.defineTheme('bds-miami', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: '', foreground: 'fbefff' },
      { token: 'comment', foreground: '8f7cb8', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'ff3d8b' }, { token: 'keyword.json', foreground: 'ff3d8b' },
      { token: 'string', foreground: 'ffcf6b' }, { token: 'string.key.json', foreground: 'ff8ac0' }, { token: 'string.value.json', foreground: 'ffcf6b' },
      { token: 'number', foreground: 'ff9a7a' }, { token: 'regexp', foreground: 'ff9a7a' }, { token: 'constant', foreground: 'ff9a7a' },
      { token: 'type', foreground: '45c7d6' }, { token: 'type.identifier', foreground: '45c7d6' },
      { token: 'tag', foreground: 'ff3d8b' }, { token: 'attribute.name', foreground: '45c7d6' }, { token: 'attribute.value', foreground: 'ffcf6b' },
      { token: 'delimiter', foreground: 'c3a9e8' }, { token: 'key', foreground: 'ff8ac0' }, { token: 'variable', foreground: 'fbefff' },
    ],
    colors: {
      'editor.background': '#1b1236', 'editorGutter.background': '#170f2f', 'minimap.background': '#170f2f', 'editor.foreground': '#fbefff',
      'editorLineNumber.foreground': '#5d4a8a', 'editorLineNumber.activeForeground': '#ff6aa8', 'editorCursor.foreground': '#45c7d6',
      'editor.selectionBackground': '#ff3d8b55', 'editor.inactiveSelectionBackground': '#ff3d8b2a', 'editor.selectionHighlightBackground': '#45c7d633',
      'editor.lineHighlightBackground': '#251a4a', 'editor.findMatchBackground': '#ffcf6b66', 'editor.findMatchHighlightBackground': '#ffcf6b33',
      'editorIndentGuide.background1': '#2f2258', 'editorIndentGuide.activeBackground1': '#ff3d8b88', 'editorBracketMatch.background': '#45c7d633', 'editorBracketMatch.border': '#45c7d6',
      'editorWidget.background': '#1d1440', 'editorWidget.border': '#4a3478', 'editorSuggestWidget.background': '#1d1440', 'editorSuggestWidget.border': '#4a3478',
      'editorSuggestWidget.selectedBackground': '#ff3d8b33', 'editorHoverWidget.background': '#1d1440', 'editorHoverWidget.border': '#4a3478', 'input.background': '#140d2b',
      'input.border': '#3e2c6a', 'focusBorder': '#ff3d8b', 'scrollbarSlider.background': '#48336f88', 'scrollbarSlider.hoverBackground': '#6c4c9eaa',
      'editorBracketHighlight.foreground1': '#ff3d8b', 'editorBracketHighlight.foreground2': '#45c7d6', 'editorBracketHighlight.foreground3': '#ffcf6b',
    },
  });
  // Lubyanka: typewriter ink on cream. Red-ink keywords, grey comments, brown strings, a stamp-red cursor
  monaco.editor.defineTheme('bds-lubyanka', {
    base: 'vs', inherit: true,
    rules: [
      { token: '', foreground: '2b2722' },
      { token: 'comment', foreground: '8a8371', fontStyle: 'italic' },
      { token: 'keyword', foreground: '9e2b25', fontStyle: 'bold' }, { token: 'keyword.json', foreground: '9e2b25' },
      { token: 'string', foreground: '7d4e2d' }, { token: 'string.key.json', foreground: '9e2b25' }, { token: 'string.value.json', foreground: '7d4e2d' },
      { token: 'number', foreground: '3f5a78' }, { token: 'regexp', foreground: '3f5a78' }, { token: 'constant', foreground: '3f5a78' },
      { token: 'type', foreground: '55684f' }, { token: 'type.identifier', foreground: '55684f' },
      { token: 'tag', foreground: '9e2b25' }, { token: 'attribute.name', foreground: '55684f' }, { token: 'attribute.value', foreground: '7d4e2d' },
      { token: 'delimiter', foreground: '4f4a40' }, { token: 'key', foreground: '9e2b25' }, { token: 'variable', foreground: '2b2722' },
    ],
    colors: {
      'editor.background': '#efe8d4', 'editorGutter.background': '#e3dbc5', 'minimap.background': '#e8dfc8', 'editor.foreground': '#2b2722',
      'editorLineNumber.foreground': '#a39b85', 'editorLineNumber.activeForeground': '#9e2b25', 'editorCursor.foreground': '#9e2b25',
      'editor.selectionBackground': '#d9b9a4', 'editor.inactiveSelectionBackground': '#d9b9a480', 'editor.selectionHighlightBackground': '#cfc5a866',
      'editor.lineHighlightBackground': '#e3dac3', 'editor.findMatchBackground': '#e0b38a', 'editor.findMatchHighlightBackground': '#e0b38a66',
      'editorIndentGuide.background1': '#d0c8b1', 'editorIndentGuide.activeBackground1': '#948d78', 'editorBracketMatch.background': '#d9cfb3', 'editorBracketMatch.border': '#9e2b25',
      'editorWidget.background': '#efe8d4', 'editorWidget.border': '#948d78', 'editorSuggestWidget.background': '#efe8d4', 'editorSuggestWidget.border': '#948d78',
      'editorSuggestWidget.selectedBackground': '#e0d3b6', 'editorHoverWidget.background': '#efe8d4', 'editorHoverWidget.border': '#948d78', 'input.background': '#f4eedd',
      'input.border': '#948d78', 'focusBorder': '#9e2b25', 'scrollbarSlider.background': '#948d7866', 'scrollbarSlider.hoverBackground': '#948d78aa',
      'editorBracketHighlight.foreground1': '#9e2b25', 'editorBracketHighlight.foreground2': '#55684f', 'editorBracketHighlight.foreground3': '#3f5a78',
    },
  });
  // Kabuto-chō: amber LED keywords, green strings, red numbers, on the board's black
  monaco.editor.defineTheme('bds-kabuto', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: '', foreground: 'f0e3c8' },
      { token: 'comment', foreground: '6b5f4a', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'ffa31a' }, { token: 'keyword.json', foreground: 'ffa31a' },
      { token: 'string', foreground: '2ee86a' }, { token: 'string.key.json', foreground: 'ffa31a' }, { token: 'string.value.json', foreground: '2ee86a' },
      { token: 'number', foreground: 'ff5a4f' }, { token: 'regexp', foreground: 'ff5a4f' }, { token: 'constant', foreground: 'ff5a4f' },
      { token: 'type', foreground: 'ffd27a' }, { token: 'type.identifier', foreground: 'ffd27a' },
      { token: 'tag', foreground: 'ffa31a' }, { token: 'attribute.name', foreground: 'ffd27a' }, { token: 'attribute.value', foreground: '2ee86a' },
      { token: 'delimiter', foreground: '9a8a6c' }, { token: 'key', foreground: 'ffa31a' }, { token: 'variable', foreground: 'f0e3c8' },
    ],
    colors: {
      ...darkDef.colors,
      'editor.background': '#050505', 'editorGutter.background': '#050505', 'minimap.background': '#050505', 'editor.foreground': '#f0e3c8',
      'editorLineNumber.foreground': '#3a3124', 'editorLineNumber.activeForeground': '#ffa31a', 'editorCursor.foreground': '#ffa31a',
      'editor.selectionBackground': '#ffa31a40', 'editor.inactiveSelectionBackground': '#ffa31a22', 'editor.selectionHighlightBackground': '#ffa31a1c',
      'editor.lineHighlightBackground': '#ffa31a0a', 'editor.findMatchBackground': '#2ee86a44', 'editor.findMatchHighlightBackground': '#ffa31a33',
      'editorIndentGuide.activeBackground1': '#ffa31a50', 'editorBracketMatch.background': '#ffa31a22', 'editorBracketMatch.border': '#ffa31a88',
      'editorWidget.background': '#16130f', 'editorWidget.border': '#3a3124', 'editorSuggestWidget.background': '#16130f',
      'editorSuggestWidget.selectedBackground': '#ffa31a33', 'editorHoverWidget.background': '#16130f', 'input.background': '#0f0d0b',
      'input.border': '#3a3124', 'focusBorder': '#ffa31a88', 'scrollbarSlider.background': '#2a221688', 'scrollbarSlider.hoverBackground': '#4a3a20aa',
    },
  });
  // Blurple: a code block in the old chat app
  monaco.editor.defineTheme('bds-blurple', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: '', foreground: 'dcddde' },
      { token: 'comment', foreground: '72767d', fontStyle: 'italic' },
      { token: 'keyword', foreground: '8ea1e1' }, { token: 'keyword.json', foreground: '8ea1e1' },
      { token: 'string', foreground: '43b581' }, { token: 'string.key.json', foreground: '8ea1e1' }, { token: 'string.value.json', foreground: '43b581' },
      { token: 'number', foreground: 'faa61a' }, { token: 'regexp', foreground: 'faa61a' }, { token: 'constant', foreground: 'faa61a' },
      { token: 'type', foreground: '00b0f4' }, { token: 'type.identifier', foreground: '00b0f4' },
      { token: 'tag', foreground: '8ea1e1' }, { token: 'attribute.name', foreground: 'faa61a' }, { token: 'attribute.value', foreground: '43b581' },
      { token: 'delimiter', foreground: 'b9bbbe' }, { token: 'key', foreground: '8ea1e1' }, { token: 'variable', foreground: 'dcddde' },
    ],
    colors: {
      ...darkDef.colors,
      'editor.background': '#36393f', 'editorGutter.background': '#36393f', 'minimap.background': '#36393f', 'editor.foreground': '#dcddde',
      'editorLineNumber.foreground': '#5c6067', 'editorLineNumber.activeForeground': '#dcddde', 'editorCursor.foreground': '#dcddde',
      'editor.selectionBackground': '#7289da55', 'editor.inactiveSelectionBackground': '#7289da2a', 'editor.selectionHighlightBackground': '#7289da22',
      'editor.lineHighlightBackground': '#32353b', 'editor.findMatchBackground': '#faa61a55', 'editor.findMatchHighlightBackground': '#7289da33',
      'editorIndentGuide.activeBackground1': '#7289da55', 'editorBracketMatch.background': '#7289da22', 'editorBracketMatch.border': '#7289da88',
      'editorWidget.background': '#2f3136', 'editorWidget.border': '#202225', 'editorSuggestWidget.background': '#2f3136',
      'editorSuggestWidget.selectedBackground': '#7289da44', 'editorHoverWidget.background': '#18191c', 'input.background': '#40444b',
      'input.border': '#40444b', 'focusBorder': '#7289da', 'scrollbarSlider.background': '#20222588', 'scrollbarSlider.hoverBackground': '#18191caa',
    },
  });
  monaco.editor.defineTheme('bds-light', themeDefs.light = {
    base: 'vs', inherit: true,
    rules: [
      { token: 'comment', foreground: '8a8894', fontStyle: 'italic' },
      { token: 'keyword', foreground: '5b49a0' },
      { token: 'string', foreground: '8a5a2b' },
      { token: 'string.key.json', foreground: '5b49a0' },
      { token: 'string.value.json', foreground: '8a5a2b' },
      { token: 'number', foreground: '2f7a76' },
      { token: 'tag', foreground: '5b49a0' },
      { token: 'attribute.name', foreground: '2f7a76' },
      { token: 'attribute.value', foreground: '8a5a2b' },
      { token: 'key', foreground: '5b49a0' },
    ],
    colors: {
      'editor.background': '#fafafc',
      'diffEditor.insertedLineBackground': '#16a34a17', 'diffEditor.insertedTextBackground': '#16a34a3d', 'diffEditor.removedLineBackground': '#e11d4817', 'diffEditor.removedTextBackground': '#e11d4840', 'diffEditorGutter.insertedLineBackground': '#16a34a26', 'diffEditorGutter.removedLineBackground': '#e11d4826', 'diffEditorOverview.insertedForeground': '#16a34aaa', 'diffEditorOverview.removedForeground': '#e11d48aa',
      'editorLineNumber.foreground': '#c3c1cb',
      'editorLineNumber.activeForeground': '#55535f',
      'editorCursor.foreground': '#6c5ab0',
      'editor.selectionBackground': '#6c5ab02e',
      'editor.lineHighlightBackground': '#00000006',
      'minimap.background': '#fafafc',
    },
  });
}

const PREVIEWABLE = new Set(['html', 'markdown', 'svg']);

export class CodeEditor extends BaseEditor {
  static mode = 'code';
  handlesWheelZoom = false;

  async load(bytes, opts = {}) {
    const monaco = await loadMonaco();
    this.monaco = monaco;
    const dec = bytes ? decodeText(bytes) : { text: '', encoding: 'utf-8', bom: false };
    this.encoding = dec.encoding;
    this.bom = dec.bom;
    this.eol = dec.text ? detectEol(dec.text) : '\r\n';
    this.lang = opts.lang || this.tab.lang || langForName(this.tab.title);
    if (this.tab.ext === 'svg') this.lang = 'xml';
    this.fontSize = this.app.settings.codeFontSize || 13;

    this.editorHost = h('div', { class: 'code-editor' });
    this.frame = null;
    this.previewHost = h('div', { class: 'code-preview' });
    this.divider = h('div', { class: 'code-divider' });
    this.root = h('div', { class: 'code-root' }, this.editorHost, this.divider, this.previewHost);
    this.pane.append(this.root);

    this.model = monaco.editor.createModel(dec.text, this.lang);
    this.model.setEOL(this.eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    this.ed = monaco.editor.create(this.editorHost, {
      model: this.model,
      theme: monacoTheme(this.app.settings.theme),
      automaticLayout: true,
      fontFamily: codeFont(this.app.settings.theme),
      fontSize: this.fontSize,
      lineHeight: Math.round(this.fontSize * 1.6),
      minimap: { enabled: true, renderCharacters: false, scale: 1 },
      wordWrap: ['markdown', 'plaintext'].includes(this.lang) ? 'on' : 'off',
      smoothScrolling: true,
      cursorBlinking: 'phase',
      cursorSmoothCaretAnimation: 'on',
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active', indentation: true },
      scrollBeyondLastLine: false,
      padding: { top: 14, bottom: 14 },
      fixedOverflowWidgets: true,
      stickyScroll: { enabled: true },
      roundedSelection: true,
      linkedEditing: true,
    });
    fontReady(monaco, this.app.settings.theme);
    this.savedVersion = this.model.getAlternativeVersionId();
    this.updatePreviewSoon = debounce(() => this.updatePreview(), 350);

    this.model.onDidChangeContent(() => {
      const dirty = this.model.getAlternativeVersionId() !== this.savedVersion;
      this.app.setDirty(this.tab, dirty);
      if (this.previewOn) this.updatePreviewSoon();
    });
    this.ed.onDidChangeCursorSelection(() => this.statusSoon());
    this.statusSoon = debounce(() => this.refreshStatus(), 100);
    // right-click a selection → translate it (shown where you clicked), or translate it in place
    let menuAt = { x: 200, y: 200 };
    this.ed.onContextMenu((e) => { menuAt = { x: e.event.posx, y: e.event.posy }; });
    const grab = (ed) => {
      const sel = ed.getSelection();
      const text = sel && !sel.isEmpty() ? this.model.getValueInRange(sel) : '';
      if (!text.trim() || !this.app.translate) return null;
      const range = sel, version = this.model.getAlternativeVersionId();
      return {
        text,
        restore: () => { ed.focus(); ed.setSelection(range); },
        replace: ed.getOption(monaco.editor.EditorOption.readOnly) ? null : (out) => {
          if (this.model.getAlternativeVersionId() !== version) return false; // changed since
          ed.executeEdits('translate', [{ range, text: out, forceMoveMarkers: true }]);
          ed.pushUndoStop();
          return true;
        },
      };
    };
    this.ed.addAction({ id: 'bds-translate', label: 'Translate selection', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 9,
      precondition: 'editorHasSelection', run: (ed) => { const g = grab(ed); if (g) this.app.translate.open(g, menuAt.x, menuAt.y); } });
    this.ed.addAction({ id: 'bds-translate-replace', label: 'Translate and replace', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 10,
      precondition: 'editorHasSelection && !editorReadonly', run: (ed) => { const g = grab(ed); if (g?.replace) this.app.translate.replaceNow(g); } });
    this.markerSub = monaco.editor.onDidChangeMarkers((uris) => {
      if (uris.some((u) => u.toString() === this.model.uri.toString())) this.statusSoon();
    });

    this.wireDivider();
    this.previewOn = this.canPreview() && this.app.settings[`preview_${this.lang}`] !== false;
    this.setPreview(this.previewOn);
    if (opts.draft != null) this.restoreDraft(opts.draft);
  }

  canPreview() { return PREVIEWABLE.has(this.lang) || this.tab.ext === 'svg'; }

  wireDivider() {
    let dragging = false;
    this.divider.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); this.root.classList.add('resizing'); });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const r = this.root.getBoundingClientRect();
      const pct = clamp(((e.clientX - r.left) / r.width) * 100, 20, 80);
      this.editorHost.style.flexBasis = pct + '%';
    });
    window.addEventListener('mouseup', () => { if (dragging) { dragging = false; this.root.classList.remove('resizing'); } });
  }

  // ------------------------------------------------------------------ preview

  setPreview(on) {
    this.previewOn = on && this.canPreview();
    this.root.classList.toggle('with-preview', this.previewOn);
    this.previewBtn?.classList.toggle('active', this.previewOn);
    if (this.previewOn) this.updatePreview();
  }

  async previewBase() {
    if (!this.tab.path) return null;
    if (this._base && this._baseFor === this.tab.path) return this._base;
    try {
      const r = await api.previewRoot(dirname(this.tab.path));
      this._base = location.origin + r.base;
      this._baseFor = this.tab.path;
      return this._base;
    } catch { return null; }
  }

  async updatePreview() {
    if (!this.previewOn) return;
    const v = this.model.getValue();
    const base = await this.previewBase();
    const baseTag = base ? `<base href="${base}">` : '';
    if (this.lang === 'markdown') {
      const marked = await vendor.marked();
      const html = marked.parse(v, { gfm: true });
      if (!this.frame || this.frame.dataset.kind !== 'md') {
        clear(this.previewHost);
        this.frame = h('iframe', { class: 'code-frame', sandbox: 'allow-same-origin', dataset: { kind: 'md' }, title: 'Preview' });
        this.frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">${baseTag}<style>${markdownCss(document.documentElement.dataset.theme)}</style></head><body><article class="md"></article></body></html>`;
        this.previewHost.append(this.frame);
        await new Promise((r) => this.frame.addEventListener('load', r, { once: true }));
      }
      const doc = this.frame.contentDocument;
      const art = doc?.querySelector('article');
      if (art) {
        art.innerHTML = html;
        for (const a of art.querySelectorAll('a[href]')) a.target = '_blank';
      }
    } else {
      let html = v;
      if (this.tab.ext === 'svg' || (this.lang === 'xml' && /<svg[\s>]/i.test(v))) {
        html = `<!doctype html><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:repeating-conic-gradient(#0000000d 0 25%,transparent 0 50%) 0 0/20px 20px">${v}</body>`;
      } else if (baseTag) {
        html = /<head[^>]*>/i.test(v) ? v.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`) : baseTag + v;
      }
      if (!this.frame || this.frame.dataset.kind !== 'html') {
        clear(this.previewHost);
        this.frame = h('iframe', { class: 'code-frame light', sandbox: 'allow-scripts allow-forms allow-modals allow-popups', dataset: { kind: 'html' }, title: 'Preview' });
        this.previewHost.append(this.frame);
      }
      this.frame.srcdoc = html;
    }
  }

  // ------------------------------------------------------------------ toolbar & menus

  buildToolbar() {
    const langSel = tbSelect(LANGUAGES.map(([id, name]) => ({ value: id, label: name })), (v) => this.setLanguage(v), { tip: 'Language', value: this.lang, width: '150px' });
    this.langSel = langSel;
    if (!LANGUAGES.some(([id]) => id === this.lang)) langSel.prepend(h('option', { value: this.lang }, this.lang)), (langSel.value = this.lang);
    this.wrapBtn = tbButton('wrap', 'Word wrap', () => this.toggleWrap(), { key: 'Alt+Z' });
    this.wrapBtn.classList.toggle('active', this.ed.getOption(this.monaco.editor.EditorOption.wordWrap) !== 'off');
    this.mapBtn = tbButton('sidebar', 'Minimap', () => this.toggleMinimap());
    this.mapBtn.classList.add('active');
    this.previewBtn = tbButton('eye', 'Live preview', () => this.setPreview(!this.previewOn), { text: 'Preview' });
    this.previewBtn.classList.toggle('active', !!this.previewOn);
    this.previewBtn.hidden = !this.canPreview();
    this.docBtn = tbButton('file-doc', 'Edit visually in the document editor', () => this.toDocument(), { text: 'Visual edit' });
    this.docBtn.hidden = !['html', 'markdown'].includes(this.lang);
    return h('div', { class: 'toolbar' },
      tbButton('undo', 'Undo', () => this.undo(), { key: 'Ctrl+Z' }),
      tbButton('redo', 'Redo', () => this.redo(), { key: 'Ctrl+Y' }),
      tbSep(),
      tbButton('search', 'Find', () => this.find(false), { key: 'Ctrl+F' }),
      tbButton('replace', 'Replace', () => this.find(true), { key: 'Ctrl+H' }),
      tbSep(),
      tbButton('wand', 'Format document', () => this.format(), { key: 'Shift+Alt+F' }),
      tbButton('braces', 'Comment / uncomment', () => this.run('editor.action.commentLine'), { key: 'Ctrl+/' }),
      tbSep(),
      langSel,
      tbSep(),
      this.wrapBtn, this.mapBtn,
      tbButton('minus', 'Smaller text', () => this.zoom(-1)),
      tbButton('plus', 'Larger text', () => this.zoom(+1)),
      tbSep(),
      this.previewBtn, this.docBtn,
    );
  }

  menus() {
    const isJson = this.lang === 'json';
    return {
      edit: [
        { label: 'Go to line…', shortcut: 'Ctrl+G', action: () => this.run('editor.action.gotoLine') },
        { label: 'Command palette…', shortcut: 'F1', action: () => this.run('editor.action.quickCommand') },
        { label: 'Toggle comment', shortcut: 'Ctrl+/', action: () => this.run('editor.action.commentLine') },
        { label: 'Duplicate line', shortcut: 'Shift+Alt+↓', action: () => this.run('editor.action.copyLinesDownAction') },
        { label: 'Sort lines ascending', icon: 'sort', action: () => this.run('editor.action.sortLinesAscending') },
        { label: 'Trim trailing whitespace', action: () => this.run('editor.action.trimTrailingWhitespace') },
      ],
      view: [
        { label: 'Word wrap', icon: 'wrap', shortcut: 'Alt+Z', checked: this.ed.getOption(this.monaco.editor.EditorOption.wordWrap) !== 'off', action: () => this.toggleWrap() },
        { label: 'Minimap', icon: 'sidebar', checked: this.ed.getOption(this.monaco.editor.EditorOption.minimap).enabled, action: () => this.toggleMinimap() },
        { label: 'Live preview', icon: 'eye', disabled: !this.canPreview(), checked: this.previewOn, action: () => this.setPreview(!this.previewOn) },
        { label: 'Fold all', action: () => this.run('editor.foldAll') },
        { label: 'Unfold all', action: () => this.run('editor.unfoldAll') },
      ],
      tools: [
        { label: 'Format document', icon: 'wand', shortcut: 'Shift+Alt+F', action: () => this.format() },
        { label: 'Language', icon: 'code', submenu: () => LANGUAGES.map(([id, name]) => ({ label: name, checked: this.lang === id, action: () => this.setLanguage(id) })) },
        { label: 'Indentation', submenu: () => this.indentItems() },
        { label: 'Encoding', submenu: () => this.encodingItems() },
        { label: 'Line endings', submenu: () => this.eolItems() },
        ...(isJson ? [{ sep: true }, { label: 'Minify JSON', action: () => this.jsonTransform(0) }, { label: 'Pretty-print JSON', action: () => this.jsonTransform(2) }, { label: 'Sort JSON keys', action: () => this.jsonTransform(2, true) }] : []),
        ...(['html', 'markdown'].includes(this.lang) ? [{ sep: true }, { label: 'Edit visually in document editor', icon: 'file-doc', action: () => this.toDocument() }] : []),
      ],
    };
  }

  indentItems() {
    const o = this.model.getOptions();
    const set = (insertSpaces, tabSize) => () => { this.model.updateOptions({ insertSpaces, tabSize }); this.refreshStatus(); };
    return [
      { label: 'Spaces: 2', checked: o.insertSpaces && o.tabSize === 2, action: set(true, 2) },
      { label: 'Spaces: 4', checked: o.insertSpaces && o.tabSize === 4, action: set(true, 4) },
      { label: 'Tabs (width 4)', checked: !o.insertSpaces && o.tabSize === 4, action: set(false, 4) },
      { label: 'Tabs (width 8)', checked: !o.insertSpaces && o.tabSize === 8, action: set(false, 8) },
      { sep: true },
      { label: 'Convert indentation to spaces', action: () => this.run('editor.action.indentationToSpaces') },
      { label: 'Convert indentation to tabs', action: () => this.run('editor.action.indentationToTabs') },
    ];
  }

  encodingItems() {
    return [['utf-8', false, 'UTF-8'], ['utf-8', true, 'UTF-8 with BOM'], ['utf-16le', true, 'UTF-16 LE'], ['windows-1252', false, 'Windows-1252']].map(([e, b, l]) => ({
      label: l, checked: this.encoding === e && !!this.bom === b, action: () => { this.encoding = e; this.bom = b; this.markDirty(); this.refreshStatus(); },
    }));
  }

  eolItems() {
    const M = this.monaco.editor.EndOfLineSequence;
    return [['\r\n', 'CRLF (Windows)', M.CRLF], ['\n', 'LF (Unix)', M.LF]].map(([e, l, seq]) => ({
      label: l, checked: this.eol === e, action: () => { this.eol = e; this.model.pushEOL(seq); this.refreshStatus(); },
    }));
  }

  setLanguage(lang) {
    this.lang = lang;
    this.tab.lang = lang;
    this.monaco.editor.setModelLanguage(this.model, lang);
    if (this.langSel) this.langSel.value = lang;
    if (this.previewBtn) this.previewBtn.hidden = !this.canPreview();
    if (this.docBtn) this.docBtn.hidden = !['html', 'markdown'].includes(lang);
    if (!this.canPreview()) this.setPreview(false);
    this.app.renderMenubar();
    this.refreshStatus();
  }

  toggleWrap() {
    const on = this.ed.getOption(this.monaco.editor.EditorOption.wordWrap) !== 'off';
    this.ed.updateOptions({ wordWrap: on ? 'off' : 'on' });
    this.wrapBtn?.classList.toggle('active', !on);
  }

  toggleMinimap() {
    const on = this.ed.getOption(this.monaco.editor.EditorOption.minimap).enabled;
    this.ed.updateOptions({ minimap: { enabled: !on } });
    this.mapBtn?.classList.toggle('active', !on);
  }

  run(id) {
    this.ed.focus();
    const a = this.ed.getAction(id);
    if (a) a.run(); else this.ed.trigger('bds', id, null);
  }

  async format() {
    const a = this.ed.getAction('editor.action.formatDocument');
    if (a && a.isSupported()) { await a.run(); return; }
    if (this.lang === 'xml' || this.lang === 'html') { this.replaceAll(formatXml(this.model.getValue())); return; }
    toast(`No formatter for ${this.lang}.`, { type: 'warn' });
  }

  jsonTransform(indent, sortKeys = false) {
    try {
      let obj = JSON.parse(this.model.getValue());
      if (sortKeys) obj = sortDeep(obj);
      this.replaceAll(JSON.stringify(obj, null, indent) + (indent ? '\n' : ''));
    } catch (e) { errorToast(e, 'Invalid JSON'); }
  }

  replaceAll(text) {
    this.ed.pushUndoStop();
    this.ed.executeEdits('bds', [{ range: this.model.getFullModelRange(), text }]);
    this.ed.pushUndoStop();
  }

  async toDocument() {
    const v = this.model.getValue();
    let html = v;
    if (this.lang === 'markdown') html = (await vendor.marked()).parse(v, { gfm: true });
    const tab = await this.app.newDocument('doc');
    if (!tab?.editor) return;
    tab.editor.setHTML(html, { fromHtmlFile: this.lang === 'html' });
    this.app.setTabMeta(tab, { title: stripExt(this.tab.title) });
  }

  // ------------------------------------------------------------------ status & io

  status() {
    const pos = this.ed.getPosition() || { lineNumber: 1, column: 1 };
    const sel = this.ed.getSelection();
    const selLen = sel ? this.model.getValueInRange(sel).length : 0;
    const markers = this.monaco.editor.getModelMarkers({ resource: this.model.uri });
    const errs = markers.filter((m) => m.severity === 8).length;
    const warns = markers.filter((m) => m.severity === 4).length;
    const o = this.model.getOptions();
    const langName = LANGUAGES.find(([id]) => id === this.lang)?.[1] || this.lang;
    return {
      left: [
        { text: `Ln ${pos.lineNumber}, Col ${pos.column}${selLen ? ` (${selLen} selected)` : ''}` },
        ...(errs || warns ? [{ text: `${errs} error${errs === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`, icon: 'alert', cls: errs ? 'err' : '', action: () => this.run('editor.action.marker.next') }] : []),
      ],
      right: [
        { text: o.insertSpaces ? `Spaces: ${o.tabSize}` : `Tab: ${o.tabSize}`, action: (e, el) => showMenu(this.indentItems(), { anchor: el }) },
        { text: this.encoding === 'utf-8' ? (this.bom ? 'UTF-8 BOM' : 'UTF-8') : this.encoding.toUpperCase(), action: (e, el) => showMenu(this.encodingItems(), { anchor: el }) },
        { text: this.eol === '\r\n' ? 'CRLF' : 'LF', action: (e, el) => showMenu(this.eolItems(), { anchor: el }) },
        { text: langName, action: (e, el) => showMenu(LANGUAGES.map(([id, name]) => ({ label: name, checked: this.lang === id, action: () => this.setLanguage(id) })), { anchor: el }) },
      ],
    };
  }

  saveFormats() {
    const ext = this.tab.ext || 'txt';
    return [{ ext, name: `${ext.toUpperCase()} file` }];
  }

  exportTargets() {
    const out = [];
    if (this.lang === 'markdown') {
      out.push({
        label: 'HTML page (.html)', icon: 'globe',
        run: async () => {
          const body = (await vendor.marked()).parse(this.model.getValue(), { gfm: true });
          const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(stripExt(this.tab.title))}</title><style>${markdownCss('light')}</style></head><body><article class="md">${body}</article></body></html>`;
          await this.app.saveBytesAs(html, { defaultName: stripExt(this.tab.title) + '.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
        },
      });
    }
    if (this.lang === 'markdown' || this.lang === 'html') {
      out.push({
        label: 'PDF (.pdf)', icon: 'file-pdf',
        run: async () => {
          let html = this.model.getValue();
          if (this.lang === 'markdown') html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{margin:0.8in}${markdownCss('light')}</style></head><body><article class="md">${(await vendor.marked()).parse(html, { gfm: true })}</article></body></html>`;
          const pdf = await api.printPdf(html);
          await this.app.saveBytesAs(pdf, { defaultName: stripExt(this.tab.title) + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        },
      });
    }
    return out;
  }

  async serialize() {
    return encodeText(this.model.getValue(), this.encoding, this.bom);
  }

  afterSave() {
    this.savedVersion = this.model.getAlternativeVersionId();
    if (this.previewOn) { this._base = null; this.updatePreview(); }
  }

  getDraft() { return this.model.getValue(); }
  restoreDraft(content) { this.model.setValue(content || ''); }
  setText(t) { this.model.setValue(t); }
  insertText(t) { this.ed.focus(); this.ed.trigger('chars', 'type', { text: t }); }
  getSelectionText() { const s = this.ed.getSelection(); return s ? this.model.getValueInRange(s) : ''; }
  getContextText() { return this.model.getValue(); }
  replaceSelection(t) {
    this.ed.focus();
    this.ed.pushUndoStop();
    this.ed.executeEdits('claude', [{ range: this.ed.getSelection(), text: t, forceMoveMarkers: true }]);
    this.ed.pushUndoStop();
  }
  gotoLine(line, col = 1) {
    this.ed.setSelection({ startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col });
    this.ed.revealLineInCenter(line);
    this.ed.focus();
  }

  handlesKey(e) {
    const inside = this.editorHost.contains(document.activeElement);
    if (!inside) return false;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (k === 'f' || k === 'h' || k === 'g')) return true;
    if (e.altKey && k === 'z') { e.preventDefault(); this.toggleWrap(); return true; }
    return false;
  }

  find(replace) { this.run(replace ? 'editor.action.startFindReplaceAction' : 'actions.find'); }
  undo() { this.ed.focus(); this.ed.trigger('bds', 'undo', null); }
  redo() { this.ed.focus(); this.ed.trigger('bds', 'redo', null); }
  focus() { this.ed?.focus(); }
  selectAll() { this.ed.setSelection(this.model.getFullModelRange()); }

  zoom(delta) {
    this.fontSize = delta === 0 ? (this.app.settings.codeFontSize || 13) : clamp(this.fontSize + delta, 9, 32);
    this.ed.updateOptions({ fontSize: this.fontSize, lineHeight: Math.round(this.fontSize * 1.6) });
  }

  onShow() { setTimeout(() => this.ed?.layout(), 0); }

  onThemeChange(theme) {
    this.monaco.editor.setTheme(monacoTheme(this.app.settings.theme));
    this.ed?.updateOptions({ fontFamily: codeFont(this.app.settings.theme) });
    fontReady(this.monaco, this.app.settings.theme);
    if (this.frame?.dataset.kind === 'md') { this.frame = null; this.updatePreview(); }
  }

  print() {
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return toast('Allow pop-ups to print.', { type: 'warn' });
    w.document.write(`<!doctype html><title>${escapeHtml(this.tab.title)}</title><style>pre{font:9.5pt/1.45 Consolas,monospace;white-space:pre-wrap;word-wrap:break-word}@page{margin:15mm}</style><pre>${escapeHtml(this.model.getValue())}</pre>`);
    w.document.close();
    setTimeout(() => { w.print(); w.close(); }, 200);
  }

  destroy() {
    this.markerSub?.dispose();
    this.ed?.dispose();
    this.model?.dispose();
  }
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

/** Small XML pretty-printer for config files. */
export function formatXml(xml) {
  const tokens = xml.replace(/>\s+</g, '><').trim().split(/(?=<)|(?<=>)/g).filter((t) => t.trim());
  let depth = 0;
  const out = [];
  for (const t of tokens) {
    if (/^<\//.test(t)) depth = Math.max(0, depth - 1);
    const line = '  '.repeat(depth) + t.trim();
    // keep <tag>text</tag> on one line
    if (out.length && !t.startsWith('<') && /^\s*<[^/!?][^>]*[^/]>$/.test(out[out.length - 1])) { out[out.length - 1] += t.trim(); continue; }
    if (/^<\//.test(t) && out.length && /^\s*<[^/!?][^>]*>[^<]+$/.test(out[out.length - 1])) { out[out.length - 1] += t.trim(); continue; }
    out.push(line);
    if (/^<[^/!?][^>]*[^/]>$/.test(t) || /^<[^/!?>]>$/.test(t)) depth++;
  }
  return out.join('\n') + '\n';
}

/** The Markdown colours from the app theme that's on (hidden and custom themes included). */
function pageColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fb) => { const x = cs.getPropertyValue(n).trim(); return x ? hex(x) : fb; };
  return { bg: v('--bg-1', '#100d16'), text: v('--text', '#e7e1f3'), rule: v('--line', '#2a2238'), a: v('--accent-strong', '#c7a6ff'), code: v('--bg-3', '#1e1929'),
    pre: v('--bg-0', '#0b0910'), quote: v('--text-2', '#b0a6c4'), bar: v('--accent', '#b48cff'), cell: v('--line-2', '#352c49'), th: v('--bg-3', '#1c1726') };
}

export function markdownCss(theme = 'dark') {
  const dark = theme !== 'light';
  // charcoal (the default dark) has its own greys; every other dark theme uses the page's own colours
  const P = theme === 'dark'
    ? { bg: '#17181b', text: '#e4e4e6', rule: '#2c2d31', a: '#cbbdf8', code: '#242528', pre: '#111214', quote: '#a5a6ab', bar: '#b3a1f2', cell: '#37383d', th: '#242528' }
    : pageColors();
  return `
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  html, body { margin: 0; background: ${dark ? P.bg : '#ffffff'}; }
  .md { max-width: 820px; margin: 0 auto; padding: 32px 36px 60px; font: 15px/1.7 Inter, 'Segoe UI', system-ui, sans-serif; color: ${dark ? P.text : '#1f1e25'}; }
  .md h1, .md h2, .md h3, .md h4 { line-height: 1.25; margin: 1.6em 0 0.6em; font-weight: 600; }
  .md h1 { font-size: 2em; padding-bottom: .3em; border-bottom: 1px solid ${dark ? P.rule : '#e6e5eb'}; }
  .md h2 { font-size: 1.45em; padding-bottom: .25em; border-bottom: 1px solid ${dark ? P.rule : '#eeedf2'}; }
  .md h1:first-child, .md h2:first-child { margin-top: 0; }
  .md a { color: ${dark ? P.a : '#5b49a0'}; }
  .md code { font: 0.88em 'IBM Plex Mono', Consolas, monospace; background: ${dark ? P.code : '#f2f2f5'}; padding: .15em .4em; border-radius: 4px; }
  .md pre { background: ${dark ? P.pre : '#f6f6f8'}; border: 1px solid ${dark ? P.rule : '#e6e5eb'}; padding: 14px 16px; border-radius: 8px; overflow: auto; }
  .md pre code { background: none; padding: 0; }
  .md blockquote { margin: 1em 0; padding: .2em 1em; color: ${dark ? P.quote : '#55535f'}; border-left: 3px solid ${dark ? P.bar : '#6c5ab0'}; }
  .md table { border-collapse: collapse; margin: 1em 0; }
  .md th, .md td { border: 1px solid ${dark ? P.cell : '#dddce4'}; padding: 6px 12px; }
  .md th { background: ${dark ? P.th : '#f6f6f8'}; }
  .md img { max-width: 100%; }
  .md hr { border: 0; height: 1px; background: ${dark ? P.cell : '#e3e2e9'}; margin: 2em 0; }
  .md li input[type=checkbox] { margin-right: .5em; }
  .md ul:has(> li > input[type=checkbox]) { list-style: none; padding-left: 1.2em; }
  @media print { html, body { background: #fff; } .md { color: #000; padding: 0; } }
  `;
}
