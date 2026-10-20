// Every editor and tool in one place. Adding a tool: one entry in TOOLS (and its editor file, an icon in icons.js and
// a line in presence.js). Everything else (home cards, the Toolbox, tabs, menus, names, icons) reads from here.

import { hostIsWindows } from './dom.js';

/** The editors behind each tab mode, loaded the first time one opens. */
const DOC_EDITORS = {
  doc: () => import('../editors/doc.js').then((m) => m.DocEditor),
  pdf: () => import('../editors/pdf.js').then((m) => m.PdfEditor),
  text: () => import('../editors/text.js').then((m) => m.TextEditor),
  code: () => import('../editors/code.js').then((m) => m.CodeEditor),
  sheet: () => import('../editors/sheet.js').then((m) => m.SheetEditor),
  image: () => import('../editors/image.js').then((m) => m.ImageEditor),
  hex: () => import('../editors/hex.js').then((m) => m.HexEditor),
  video: () => import('../editors/video.js').then((m) => m.VideoEditor),
  player: () => import('../editors/player.js').then((m) => m.PlayerEditor),
  cut: () => import('../editors/cut.js').then((m) => m.CutEditor),
  form: () => import('../editors/form.js').then((m) => m.FormEditor),
  paint: () => import('../editors/paint.js').then((m) => m.PaintEditor),
};

/**
 * In home-page order (the order a fresh copy shows; people can drag their own).
 *   mode     the tab's mode (tools that open as a tab)
 *   name     its name; `rename`: it can be renamed from its home card (toolName)
 *   icon     the tab and file-list icon
 *   editor   loads its editor class
 *   tab      a tool tab rather than a file (no path, no save)
 *   kind     reopened as a fresh tool when its tab is pinned, torn off or restored
 *   single   one tab at a time: opening it again goes to the open one
 *   home     its home card and Toolbox row: { icon, sub } (open: what clicking it does, when that isn't a new tab)
 *   toolbox  a Toolbox row only, not on the home page: its subtitle
 *   available  only on offer when this says so
 */
export const TOOLS = [
  { name: 'Fill a form', home: { icon: 'form-fill', sub: 'gov pdfs · autofill · sign', open: (app) => app.fillForm() } },
  { mode: 'cut', name: 'Video editor', rename: true, home: { icon: 'video', sub: 'tracks · keyframes · chroma key' } },
  { mode: 'klep', name: 'BoxKlep', icon: 'magnet', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/klep.js').then((m) => m.KlepEditor), home: { icon: 'magnet', sub: 'grab videos from a link' } },
  { mode: 'convert', name: 'BoxConvert', icon: 'repeat', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/convert.js').then((m) => m.ConvertEditor), home: { icon: 'repeat', sub: 'any file → another format' } },
  { name: 'BoxSpaces', home: { icon: 'spaces', sub: 'open a folder, IDE-style', open: (app) => app.openSpace() } },
  { mode: 'storage', name: 'StoragePeek', icon: 'layers', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/storage.js').then((m) => m.StorageEditor), home: { icon: 'layers', sub: 'what’s eating your drives' } },
  { mode: 'mail', name: 'BoxMail', icon: 'mail', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/mail.js').then((m) => m.MailEditor), home: { icon: 'mail', sub: 'gmail + the dumps + ai' } },
  { mode: 'tape', name: 'BoxTape', icon: 'music', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/tape.js').then((m) => m.TapeEditor), home: { icon: 'music', sub: 'youtube playlist → mp3s' } },
  { mode: 'music', name: 'Music', icon: 'music', tab: true, single: true,
    editor: () => import('../editors/music.js').then((m) => m.MusicEditor), home: { icon: 'play', sub: 'the audio dump · playlists · big player' } },
  { mode: 'beat', name: 'BoxBeat', icon: 'drum', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/beat.js').then((m) => m.BeatEditor), toolbox: 'drum machine · synths · patterns into songs' },
  { mode: 'studio', name: 'BoxStudio', icon: 'rec', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/studio.js').then((m) => m.StudioEditor), home: { icon: 'rec', sub: 'scenes · screen recording · hotkeys' } },
  { mode: 'wave', name: 'BoxWave', icon: 'wave', rename: true, tab: true, kind: true,
    editor: () => import('../editors/wave.js').then((m) => m.WaveEditor), toolbox: 'record · cut · effects · export audio' },
  { mode: 'map', name: 'BoxMap', icon: 'map', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/map.js').then((m) => m.MapEditor), toolbox: 'offline world map · download areas · search · pins' },
  { mode: 'log', name: 'BoxLog', icon: 'logs', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/log.js').then((m) => m.LogEditor), toolbox: 'every log on the pc · games · filters · live' },
  { mode: 'terminal', name: 'BoxTerminal', icon: 'terminal', rename: true, tab: true, kind: true,
    editor: () => import('../editors/terminal.js').then((m) => m.TerminalEditor), get toolbox() { return hostIsWindows() ? 'powershell · cmd · history' : 'bash · history'; } },
  { mode: 'scribe', name: 'BoxScribe', icon: 'scan-text', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/scribe.js').then((m) => m.ScribeEditor), home: { icon: 'scan-text', sub: 'image → text · offline ocr' } },
  { mode: 'diff', name: 'BoxDiff', icon: 'diff', rename: true, tab: true, kind: true,
    editor: () => import('../editors/diff.js').then((m) => m.DiffEditor), home: { icon: 'diff', sub: 'compare two files side by side' } },
  { mode: 'swap', name: 'BoxSwap', icon: 'swap', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/swap.js').then((m) => m.SwapEditor), home: { icon: 'swap', sub: 'profiles of files · hot-swap a folder' } },
  { mode: 'tunnel', name: 'BoxTunnel', icon: 'tunnel', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/tunnel.js').then((m) => m.TunnelEditor), home: { icon: 'tunnel', sub: 'audio lines · any input to any output' } },
  { mode: 'secure', name: 'Secure notes', icon: 'lock', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/secure.js').then((m) => m.SecureNotesEditor), home: { icon: 'lock', sub: 'passwords & private notes · encrypted' } },
  { mode: 'browser', name: 'Browser', icon: 'globe', tab: true, kind: true, single: true, available: () => !!window.bdsShell?.browser,
    editor: () => import('../editors/browser.js').then((m) => m.BrowserEditor), home: { icon: 'globe', sub: 'the web · send pages & media to the dumps' } },
  { mode: 'ticker', name: 'BoxTicker', icon: 'trending-up', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/ticker.js').then((m) => m.TickerEditor), toolbox: 'NASDAQ · S&P 500 · any ticker' },
  { mode: 'weather', name: 'Weather', icon: 'cloud-sun', tab: true, kind: true, single: true,
    editor: () => import('../editors/weather.js').then((m) => m.WeatherEditor), toolbox: 'now · next 24 hours · 7 days' },
  { mode: 'todo', name: 'Todo', icon: 'list-check', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/todo.js').then((m) => m.TodoEditor), toolbox: 'lists · due dates · stars' },
  { mode: 'saver', name: 'BoxSaver', icon: 'saver', rename: true, tab: true, kind: true, single: true,
    editor: () => import('../editors/saver.js').then((m) => m.SaverEditor), toolbox: 'screensaver studio · layers · your own code' },
  { mode: 'tomcat', name: 'F-14F Super Tomcat', icon: 'f14', tab: true, single: true,
    editor: () => import('../editors/tomcat.js').then((m) => m.TomcatEditor) },
  { mode: 'strike', name: 'Deep Strike', icon: 'reticle', tab: true, single: true,
    editor: () => import('../editors/strike.js').then((m) => m.StrikeEditor) },
];

const tabTools = TOOLS.filter((t) => t.tab);

export const EDITORS = { ...DOC_EDITORS, ...Object.fromEntries(tabTools.map((t) => [t.mode, t.editor])) };
/** Tool tabs (no file behind them). */
export const TOOL_MODES = tabTools.map((t) => t.mode);
/** Tool tabs that come back as a fresh tool (pinned, torn off, restored). */
export const TOOL_KINDS = new Set(tabTools.filter((t) => t.kind).map((t) => t.mode));
/** Tool tabs that open once: opening one again goes to it. */
export const SINGLE_MODES = new Set(tabTools.filter((t) => t.single).map((t) => t.mode));
/** Modes with a renameable name: mode → the name it's renamed by. */
export const TOOL_OF_MODE = Object.fromEntries(TOOLS.filter((t) => t.rename).map((t) => [t.mode, t.name]));
/** Icons and names of the tool tabs, for filetypes.js's MODE_ICON and MODE_LABEL. */
export const TOOL_ICON = Object.fromEntries(tabTools.map((t) => [t.mode, t.icon]));
export const TOOL_LABEL = Object.fromEntries([...tabTools, ...TOOLS.filter((t) => t.mode === 'cut')].map((t) => [t.mode, t.name]));
/** Is it on offer here (the browser needs the desktop app)? */
export const offered = (t) => !t.available || t.available();
