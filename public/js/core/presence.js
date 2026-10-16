// Discord Rich Presence lines. Only ever describes the *kind* of file — never its name or path.

import { api } from './api.js';
import { debounce } from './dom.js';

const CONFIG_EXT = new Set(['json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'cnf', 'env', 'properties', 'xml', 'plist', 'reg', 'inf', 'editorconfig', 'npmrc', 'gitignore', 'gitattributes', 'config', 'prefs', 'service', 'desktop', 'vmx', 'iss']);

const LINES = {
  doc: { plain: ['Editing a .{ext}'], silly: ['writing a .{ext}', 'drafting a document', 'typing words onto a page', 'formatting things nobody will read', 'arguing with bullet points', 'fighting the margins'] },
  pdf: { plain: ['Editing a .pdf'], silly: ['editing a .pdf', 'scribbling on a pdf', 'whiting out a pdf', 'signing a pdf (read it twice)', 'rearranging pdf pages'] },
  text: { plain: ['Editing a .{ext}'], silly: ['editing a .{ext}', 'taking notes', 'notepad-ing', 'writing plain text like it\'s 1995'] },
  config: { plain: ['Changing a config'], silly: ['changing a config', 'tweaking settings they\'ll regret', 'flipping a flag', 'editing a .{ext} very carefully', 'one config change away from greatness'] },
  html: { plain: ['Editing a webpage'], silly: ['hand-writing html', 'building a webpage', 'centering a div', 'live-previewing html'] },
  markdown: { plain: ['Writing markdown'], silly: ['writing markdown', 'formatting with asterisks', 'making a README look nice'] },
  code: { plain: ['Editing a .{ext} file'], silly: ['editing a .{ext} file', 'writing code', 'touching source code', 'refactoring (allegedly)'] },
  sheet: { plain: ['Editing a spreadsheet'], silly: ['crunching a spreadsheet', 'editing a .{ext}', 'doing spreadsheet things', 'making numbers line up'] },
  image: { plain: ['Editing an image'], silly: ['looking at a picture', 'cropping something', 'editing a .{ext}', 'rotating an image 90°'] },
  hex: { plain: ['Viewing a binary file'], silly: ['staring at raw bytes', 'reading hex like the matrix', 'poking at a binary'] },
  mail: { plain: ['Doing email'], silly: ['doing email', 'inbox zero speedrun', 'replying "per my last email"', 'attaching the wrong file', 'sorting promotions into oblivion'] },
  cut: { plain: ['Editing a video'], silly: ['editing a video', 'cutting a montage', 'keyframing things', 'chroma keying something'] },
  video: { plain: ['Trimming a video'], silly: ['trimming a video', 'cutting a clip', 'making a gif', 'finding the perfect frame'] },
  form: { plain: ['Filling out a form'], silly: ['filling out a form', 'doing paperwork', 'fighting a government pdf', 'checking boxes'] },
  klep: { plain: ['Grabbing a video'], silly: ['klepping a video', 'grepping videos off a page', 'saving a clip for later'] },
  diff: { plain: ['Comparing two files'], silly: ['spot the difference', 'playing spot the difference', 'squinting at two versions'] },
  scribe: { plain: ['Reading text from an image'], silly: ['squinting at a scan', 'turning pictures into words', 'OCR-ing something'] },
  paint: { plain: ['Painting'], silly: ['painting something', 'making art (allegedly)', 'pushing pixels', 'using the paint bucket irresponsibly'] },
  tape: { plain: ['Making a mixtape'], silly: ['making a mixtape', 'turning a playlist into mp3s', 'curating the audio dump'] },
  storage: { plain: ['Checking disk space'], silly: ['finding out where the space went', 'staring at a treemap', 'judging their downloads folder'] },
  swap: { plain: ['Swapping files'], silly: ['shuffling file profiles', 'hot-swapping a folder', 'swapping loadouts'] },
  ticker: { plain: ['Checking the markets'], silly: ['watching numbers go up (hopefully)', 'staring at a stock chart', 'pretending to understand the market'] },
  weather: { plain: ['Checking the weather'], silly: ['checking if it’s raining', 'looking out a digital window', 'reading the forecast'] },
  tunnel: { plain: ['Routing audio'], silly: ['plumbing some audio', 'running sound through a tunnel', 'patching cables'] },
  music: { plain: ['Listening to music'], silly: ['vibing', 'DJing for an audience of one', 'shuffling the audio dump', 'skipping to the good part'] },
  browser: { plain: ['Browsing the web'], silly: ['surfing the information superhighway', 'reading the whole internet', 'opening one more tab'] },
  tomcat: { plain: ['Flying an F-14'], silly: ['flying a Tomcat at FL300', 'calling FOX-3', 'splashing bandits', 'dodging a PL-15', 'going Mach 1 between documents'] },
  // never anything about what's in them
  secure: { plain: ['Box-DocSpitter'], silly: ['Box-DocSpitter'] },
  home: { plain: ['On the home screen'], silly: ['deciding what to spit out', 'idling on the home screen', 'thinking about documents'] },
};

function hash(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return Math.abs(x);
}

function category(tab) {
  if (!tab) return 'home';
  const ext = (tab.ext || '').toLowerCase();
  if (tab.mode === 'code') {
    if (tab.lang === 'html' || ext === 'html' || ext === 'htm') return 'html';
    if (tab.lang === 'markdown') return 'markdown';
    if (CONFIG_EXT.has(ext) || tab.lang === 'ini' || tab.lang === 'yaml' || tab.lang === 'json' || tab.lang === 'xml') return 'config';
    return 'code';
  }
  return LINES[tab.mode] ? tab.mode : 'doc';
}

const KIND = { secure: 'file', mail: 'email', video: 'video', form: 'form', klep: 'video', storage: 'drive', doc: 'document', pdf: 'pdf', text: 'text file', config: 'config', html: 'webpage', markdown: 'markdown note', code: 'code file', sheet: 'spreadsheet', image: 'image', hex: 'binary file', home: 'nothing yet' };

/** Fill {ext} {kind} {tabs} — the only things custom lines can reveal. */
function fill(text, tab, cat, tabCount) {
  const ext = (tab?.ext || (cat === 'doc' ? 'docx' : 'txt')).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'file';
  return String(text || '')
    .replace(/\{ext\}/gi, ext)
    .replace(/\{kind\}/gi, KIND[cat] || 'file')
    .replace(/\{tabs\}/gi, String(tabCount));
}

/**
 * settings: { discordMode: 'auto' | 'custom', discordStyle: 'silly' | 'plain', discordDetails, discordState, discordShowTime, discordSong }
 * song: the music player's current song (only used when discordSong is on), shown as the second line.
 */
export function presenceActivity(tab, tabCount, s, since, song = null) {
  const cat = category(tab);
  const showTime = s.discordShowTime !== false;
  let details;
  let state;
  if (s.discordMode === 'custom') {
    details = fill(s.discordDetails || 'spitting out documents', tab, cat, tabCount);
    state = fill(s.discordState || '', tab, cat, tabCount);
  } else {
    const set = LINES[cat][s.discordStyle === 'plain' ? 'plain' : 'silly'];
    details = fill(set[hash((tab?.id || 'home') + cat) % set.length], tab, cat, tabCount);
    state = tabCount ? `${tabCount} tab${tabCount === 1 ? '' : 's'} open` : 'no tabs open';
  }
  if (s.discordSong && song) state = `♪ ${song}`;
  return {
    details: details.slice(0, 120) || undefined,
    state: state.slice(0, 120) || undefined,
    start: showTime ? since : undefined,
    largeImage: 'logo',
    largeText: 'Box-DocSpitter',
  };
}

export function createPresence(app) {
  let since = Date.now();
  let lastKey = '';
  const push = debounce(async () => {
    const s = app.settings;
    const tab = app.active;
    const key = tab ? tab.id + tab.mode : 'home';
    if (key !== lastKey) { since = Date.now(); lastKey = key; }
    try {
      const r = await api.presence({
        enabled: !!s.discordEnabled,
        clientId: s.discordClientId || '',
        activity: s.discordEnabled ? presenceActivity(tab, app.tabs.length, s, since, app.music?.nowPlaying) : null,
      });
      app.presenceStatus = r.status;
      app.onPresenceStatus?.(r.status);
    } catch { /* server offline */ }
  }, 1200);
  return {
    update: push,
    /** What would be shown right now (for the live preview in settings). */
    preview: () => presenceActivity(app.active, app.tabs.length, app.settings, since, app.music?.nowPlaying || (app.settings.discordSong ? 'Song name' : null)),
  };
}
