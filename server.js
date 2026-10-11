#!/usr/bin/env node
/*
 * Box-DocSpitter — local server.
 * Zero runtime dependencies: serves the UI, vendor libraries from node_modules,
 * and a small token-protected API for reading/writing files on this PC.
 * Binds to 127.0.0.1 only.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { pathToFileURL } = require('url');

const APP_NAME = 'Box-DocSpitter';
const VERSION = require('./package.json').version;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const MODULES = path.join(ROOT, 'node_modules');
const DATA = path.join(ROOT, 'data');
const DUMP = path.join(ROOT, 'image-dump');
const DUMP_REMOVED = path.join(DUMP, '.removed');
const DOC_DUMP = path.join(ROOT, 'doc-dump');
// The PDF dump became the doc dump: move an existing pdf-dump folder over once.
try {
  const OLD_PDF_DUMP = path.join(ROOT, 'pdf-dump');
  if (fs.existsSync(OLD_PDF_DUMP)) {
    if (!fs.existsSync(DOC_DUMP)) fs.renameSync(OLD_PDF_DUMP, DOC_DUMP);
    else {
      for (const n of fs.readdirSync(OLD_PDF_DUMP)) if (!fs.existsSync(path.join(DOC_DUMP, n))) fs.renameSync(path.join(OLD_PDF_DUMP, n), path.join(DOC_DUMP, n));
      if (!fs.readdirSync(OLD_PDF_DUMP).length) fs.rmdirSync(OLD_PDF_DUMP);
    }
  }
} catch (e) { console.error(`[Box-DocSpitter] couldn't move pdf-dump to doc-dump: ${e.message}`); }
const IS_WIN = process.platform === 'win32';
const DUMP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.jfif', '.ico']);

const argv = process.argv.slice(2);
const flagVal = (name) => {
  const f = argv.find((a) => a.startsWith(name + '='));
  return f ? f.slice(name.length + 1) : null;
};
const hasFlag = (name) => argv.includes(name);
const fileArgs = argv.filter((a) => !a.startsWith('--')).map((p) => path.resolve(p));
const BASE_PORT = Number(flagVal('--port') || process.env.BDS_PORT || 7717);
const APP_MODE = hasFlag('--app') || hasFlag('--open');
const NO_WINDOW = hasFlag('--no-window');
// Running inside the Electron shell (electron/main.js): windows are opened by the shell, which also owns shutdown.
const SHELL_MODE = hasFlag('--shell') && typeof process.send === 'function';
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(24).toString('hex');

let PORT = BASE_PORT;

// Vendor packages that may be served to the UI.
const VENDOR = new Set([
  'pdfjs-dist', 'pdf-lib', '@pdf-lib/fontkit', 'monaco-editor', 'docx', 'jszip',
  'marked', 'xlsx', '@fontsource/inter', '@fontsource/ibm-plex-mono', '@ffmpeg/ffmpeg', '@ffmpeg/util', '@ffmpeg/core',
  'tesseract.js', 'tesseract.js-core', '@tesseract.js-data/eng',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.avif': 'image/avif', '.jfif': 'image/jpeg', '.pdf': 'application/pdf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
ensureDir(DATA);
ensureDir(path.join(DATA, 'backups'));
ensureDir(path.join(DATA, 'drafts'));
ensureDir(DUMP);
ensureDir(DOC_DUMP);
const AUDIO_DUMP = path.join(ROOT, 'audio-dump');
ensureDir(AUDIO_DUMP);

// The "dumps": folders of reusable files shown in the document editor's bottom drawers.
const DUMPS = {
  image: { dir: DUMP, exts: DUMP_EXT, prefix: '/dump/', what: 'an image' },
  audio: { dir: AUDIO_DUMP, exts: new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus', '.weba']), prefix: '/audiodump/', what: 'an audio file' },
  doc: { dir: DOC_DUMP, exts: new Set(['.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt', '.md', '.xlsx', '.xls', '.ods', '.csv', '.pptx', '.ppt', '.odp', '.html', '.htm', '.eml']), prefix: '/docdump/', what: 'a document' },
};
function dumpOf(kind) { return DUMPS[kind === 'pdf' ? 'doc' : kind] || DUMPS.image; }

function dumpName(name, kind) {
  const d = dumpOf(kind);
  const base = path.basename(String(name || ''));
  if (!base || base.startsWith('.') || !d.exts.has(path.extname(base).toLowerCase())) {
    throw Object.assign(new Error(`Not ${d.what} file name`), { status: 400 });
  }
  return base;
}

async function uniqueDumpPath(name, kind) {
  const d = dumpOf(kind);
  const ext = path.extname(name);
  const stem = path.basename(name, ext).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'file';
  let candidate = path.join(d.dir, stem + ext.toLowerCase());
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(d.dir, `${stem} (${i})${ext.toLowerCase()}`);
  return candidate;
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
// Writes to the same file are chained so concurrent requests can't interleave or lose updates.
const writeChains = new Map();
let RESETTING = false; // after a factory reset nothing may be written back to data/

function writeJSON(file, value) {
  if (RESETTING) return Promise.resolve();
  const prev = writeChains.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  });
  writeChains.set(file, next);
  return next;
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}
const ok = (res, body = { ok: true }) => send(res, 200, body);
const fail = (res, status, message, extra = {}) => send(res, status, { error: message, ...extra });

function readBody(req, limit = 1024 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSONBody(req) {
  const buf = await readBody(req, 50 * 1024 * 1024);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

function requirePath(p) {
  if (!p || typeof p !== 'string') throw Object.assign(new Error('Missing path'), { status: 400 });
  if (!path.isAbsolute(p)) throw Object.assign(new Error('Path must be absolute'), { status: 400 });
  return path.normalize(p);
}

function hashPath(p) {
  return crypto.createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 16);
}

function knownFolder(name) {
  const home = os.homedir();
  const candidates = {
    desktop: [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop')],
    documents: [path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents')],
    downloads: [path.join(home, 'Downloads')],
    pictures: [path.join(home, 'Pictures'), path.join(home, 'OneDrive', 'Pictures')],
  }[name] || [];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function listDrives() {
  if (!IS_WIN) return ['/'];
  const out = [];
  for (let c = 67; c <= 90; c++) { // C..Z
    const d = String.fromCharCode(c) + ':\\';
    try { if (fs.existsSync(d)) out.push(d); } catch { /* ignore */ }
  }
  return out;
}

function findBrowser() {
  const candidates = IS_WIN ? [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}
const BROWSER = findBrowser();

// ---------------------------------------------------------------------------
// Recent files, settings, backups, drafts
// ---------------------------------------------------------------------------

const RECENT_FILE = path.join(DATA, 'recent.json');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const MAX_RECENT = 40;
const MAX_BACKUPS = 25;

let recentCache = null;
const recentList = () => (recentCache ||= readJSON(RECENT_FILE, []));
async function addRecent(p) {
  if (/\\AppData\\Local\\Temp\\bds-/i.test(p)) return;
  recentCache = recentList().filter((r) => r.path.toLowerCase() !== p.toLowerCase());
  recentCache.unshift({ path: p, name: path.basename(p), at: Date.now() });
  recentCache = recentCache.slice(0, MAX_RECENT);
  await writeJSON(RECENT_FILE, recentCache);
}

let settingsCache = null;
const settingsObj = () => (settingsCache ||= readJSON(SETTINGS_FILE, {}));

async function backupFile(p) {
  let st;
  try { st = await fsp.stat(p); } catch { return null; }
  if (!st.isFile() || st.size > 150 * 1024 * 1024) return null;
  const dir = path.join(DATA, 'backups', hashPath(p));
  await fsp.mkdir(dir, { recursive: true });
  await writeJSON(path.join(dir, 'index.json'), { path: p });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${stamp}__${path.basename(p)}`);
  await fsp.copyFile(p, dest);
  const files = (await fsp.readdir(dir)).filter((f) => f !== 'index.json').sort();
  for (const old of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
    await fsp.unlink(path.join(dir, old)).catch(() => {});
  }
  return dest;
}

async function listVersions(p) {
  const dir = path.join(DATA, 'backups', hashPath(p));
  let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => f !== 'index.json'); } catch { return []; }
  const out = [];
  for (const f of files) {
    const st = await fsp.stat(path.join(dir, f)).catch(() => null);
    if (!st) continue;
    const stamp = f.split('__')[0];
    const iso = stamp.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z');
    out.push({ id: f, size: st.size, at: Date.parse(iso) || st.mtimeMs });
  }
  return out.sort((a, b) => b.at - a.at);
}

// ---------------------------------------------------------------------------
// Native dialogs (Windows, via PowerShell + WinForms)
// ---------------------------------------------------------------------------

function psQuote(s) { return "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'"; }

function buildFilter(filters) {
  if (!Array.isArray(filters) || !filters.length) return 'All files (*.*)|*.*';
  return filters.map((f) => {
    const pats = (f.extensions || ['*']).map((e) => (e === '*' ? '*.*' : '*.' + e)).join(';');
    return `${f.name} (${pats})|${pats}`;
  }).join('|');
}

function nativeDialog(opts) {
  if (!IS_WIN) return Promise.resolve({ unsupported: true });
  const kind = opts.kind;
  let s = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
`;
  if (kind === 'open') {
    s += `$d = New-Object System.Windows.Forms.OpenFileDialog\n$d.Multiselect = ${opts.multi ? '$true' : '$false'}\n`;
  } else if (kind === 'save') {
    s += `$d = New-Object System.Windows.Forms.SaveFileDialog\n$d.OverwritePrompt = $true\n$d.AddExtension = $true\n$d.FileName = ${psQuote(opts.defaultName || '')}\n`;
    if (opts.defaultExt) s += `$d.DefaultExt = ${psQuote(opts.defaultExt)}\n`;
  } else {
    s += `$d = New-Object System.Windows.Forms.FolderBrowserDialog\n$d.ShowNewFolderButton = $true\n`;
    if (opts.title) s += `$d.Description = ${psQuote(opts.title)}\n`;
  }
  if (kind !== 'folder') {
    s += `$d.Filter = ${psQuote(buildFilter(opts.filters))}\n$d.FilterIndex = ${Number(opts.filterIndex) || 1}\n`;
    if (opts.title) s += `$d.Title = ${psQuote(opts.title)}\n`;
    if (opts.initialDir && fs.existsSync(opts.initialDir)) s += `$d.InitialDirectory = ${psQuote(opts.initialDir)}\n`;
  } else if (opts.initialDir && fs.existsSync(opts.initialDir)) {
    s += `$d.SelectedPath = ${psQuote(opts.initialDir)}\n`;
  }
  s += `
$r = $d.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) {
`;
  if (kind === 'open') s += `  foreach ($f in $d.FileNames) { [Console]::Out.WriteLine('PATH:' + $f) }\n`;
  else if (kind === 'save') s += `  [Console]::Out.WriteLine('PATH:' + $d.FileName)\n  [Console]::Out.WriteLine('FILTER:' + $d.FilterIndex)\n`;
  else s += `  [Console]::Out.WriteLine('PATH:' + $d.SelectedPath)\n`;
  s += '}\n';

  const encoded = Buffer.from(s, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) return resolve({ unsupported: true, error: String(stderr || err.message).slice(0, 500) });
        const lines = String(stdout).split(/\r?\n/);
        const paths = lines.filter((l) => l.startsWith('PATH:')).map((l) => l.slice(5));
        const fl = lines.find((l) => l.startsWith('FILTER:'));
        if (!paths.length) return resolve({ cancelled: true });
        resolve({ paths, filterIndex: fl ? Number(fl.slice(7)) : undefined });
      });
  });
}

// ---------------------------------------------------------------------------
// HTML → PDF using a headless Chromium browser (Edge on Windows)
// ---------------------------------------------------------------------------

function runProcess(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

// In the desktop shell, the shell can print PDFs itself, so Edge/Chrome isn't required.
const shellPdfWaiters = new Map();
if (SHELL_MODE) {
  process.on('message', (m) => {
    if (m && m.type === 'pdf-done' && shellPdfWaiters.has(m.id)) { shellPdfWaiters.get(m.id)(m); shellPdfWaiters.delete(m.id); }
  });
}
function shellPdf(file, out) {
  const id = crypto.randomBytes(6).toString('hex');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { shellPdfWaiters.delete(id); reject(new Error('PDF export timed out')); }, 90000);
    shellPdfWaiters.set(id, (m) => { clearTimeout(timer); if (m.error) reject(new Error(m.error)); else resolve(); });
    process.send({ type: 'pdf', id, file, out });
  });
}

// Many government forms are encrypted with only an "owner password" (anyone can open and fill them, but
// they're locked against editing). pdf-lib can't read those, so they're decrypted to a normal copy first.
// Files that need a password to open are left alone.
async function unlockPdf(bytes) {
  const { PDFDocument, PDFName, PDFDict, PDFStream, PDFInvalidObject } = require('@cantoo/pdf-lib');
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { password: '', updateMetadata: false, preserveXFA: false });
  } catch (e) {
    throw Object.assign(new Error('This PDF needs a password to open'), { status: 422 });
  }
  const XREF = PDFName.of('XRef');
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    // Old cross-reference streams survive as raw, unparsed objects that still point at the encryption dictionary.
    if (obj instanceof PDFInvalidObject) { doc.context.delete(ref); continue; }
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    const isXref = dict.get(PDFName.of('Type')) === XREF || dict.has(PDFName.of('Encrypt'));
    const isEncryptDict = dict.get(PDFName.of('Filter')) === PDFName.of('Standard') && dict.has(PDFName.of('O')) && dict.has(PDFName.of('U'));
    if (isXref || isEncryptDict) doc.context.delete(ref);
  }
  delete doc.context.trailerInfo.Encrypt;
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/**
 * Opens Explorer with a file selected (or a folder opened). Explorer only understands /select,"C:\path"
 * with the quotes around the path alone, so the command line is built by hand: Node's own quoting wraps
 * the whole argument and Explorer then gives up and shows Documents.
 */
function revealInExplorer(target, { select = true } = {}) {
  if (!IS_WIN) {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [select ? path.dirname(target) : target], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const clean = String(target).replace(/"/g, '');
  const exists = fs.existsSync(clean);
  const arg = select && exists ? `/select,"${clean}"` : `"${exists ? clean : path.dirname(clean)}"`;
  spawn('explorer.exe', [arg], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
}

async function htmlToPdf(html) {
  const viaShell = SHELL_MODE && (!BROWSER || process.env.BDS_PDF === 'shell');
  if (!BROWSER && !viaShell) throw Object.assign(new Error('No Chromium-based browser found for PDF export'), { status: 501 });
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'bds-print-'));
  const htmlPath = path.join(tmp, 'document.html');
  const pdfPath = path.join(tmp, 'document.pdf');
  try {
    await fsp.writeFile(htmlPath, html, 'utf8');
    if (viaShell) {
      await shellPdf(htmlPath, pdfPath);
      return await fsp.readFile(pdfPath);
    }
    await runProcess(BROWSER, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-sync', '--mute-audio', `--user-data-dir=${path.join(tmp, 'profile')}`,
      '--no-pdf-header-footer', '--run-all-compositor-stages-before-draw', '--virtual-time-budget=5000',
      `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href,
    ], 90000);
    return await fsp.readFile(pdfPath);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// System fonts (for embedding in PDFs with full Unicode support)
// ---------------------------------------------------------------------------

const FONT_FILES = {
  'Arial': ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
  'Calibri': ['calibri.ttf', 'calibrib.ttf', 'calibrii.ttf', 'calibriz.ttf'],
  'Times New Roman': ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'],
  'Georgia': ['georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf'],
  'Verdana': ['verdana.ttf', 'verdanab.ttf', 'verdanai.ttf', 'verdanaz.ttf'],
  'Segoe UI': ['segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf'],
  'Tahoma': ['tahoma.ttf', 'tahomabd.ttf', 'tahoma.ttf', 'tahomabd.ttf'],
  'Trebuchet MS': ['trebuc.ttf', 'trebucbd.ttf', 'trebucit.ttf', 'trebucbi.ttf'],
  'Courier New': ['cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf'],
  'Consolas': ['consola.ttf', 'consolab.ttf', 'consolai.ttf', 'consolaz.ttf'],
  'Comic Sans MS': ['comic.ttf', 'comicbd.ttf', 'comici.ttf', 'comicz.ttf'],
  'Segoe Script': ['segoesc.ttf', 'segoescb.ttf', 'segoesc.ttf', 'segoescb.ttf'],
  'Ink Free': ['Inkfree.ttf', 'Inkfree.ttf', 'Inkfree.ttf', 'Inkfree.ttf'],
  'Segoe UI Symbol': ['seguisym.ttf', 'seguisym.ttf', 'seguisym.ttf', 'seguisym.ttf'],
  'Segoe UI Emoji': ['seguiemj.ttf', 'seguiemj.ttf', 'seguiemj.ttf', 'seguiemj.ttf'],
};
const FONT_DIRS = IS_WIN ? [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts'),
] : ['/usr/share/fonts', '/Library/Fonts'];

function fontPath(family, bold, italic) {
  const files = FONT_FILES[family];
  if (!files) return null;
  const idx = (bold ? 1 : 0) + (italic ? 2 : 0);
  for (const name of [files[idx], files[0]]) {
    for (const dir of FONT_DIRS) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discord Rich Presence (opt-in). Talks to the local Discord client over its IPC pipe.
// The UI only ever sends generic phrases ("editing a .pdf"), never file names.
// ---------------------------------------------------------------------------

const net = require('net');

class DiscordPresence {
  constructor() {
    this.sock = null;
    this.clientId = null;
    this.ready = false;
    this.connecting = false;
    this.activity = null;
    this.lastSent = 0;
    this.sendTimer = null;
    this.status = 'off';
    this.buf = Buffer.alloc(0);
  }

  pipePath(i) {
    if (IS_WIN) return `\\\\?\\pipe\\discord-ipc-${i}`;
    const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
    return path.join(base, `discord-ipc-${i}`);
  }

  frame(op, payload) {
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    const head = Buffer.alloc(8);
    head.writeInt32LE(op, 0);
    head.writeInt32LE(json.length, 4);
    return Buffer.concat([head, json]);
  }

  disconnect(status = 'off') {
    if (this.sock) { try { this.sock.destroy(); } catch { /* ignore */ } }
    this.sock = null;
    this.ready = false;
    this.connecting = false;
    this.status = status;
  }

  async connect() {
    if (this.sock || this.connecting || !this.clientId) return;
    this.connecting = true;
    this.status = 'connecting';
    for (let i = 0; i < 10; i++) {
      const sock = await new Promise((resolve) => {
        const s = net.createConnection(this.pipePath(i));
        const t = setTimeout(() => { s.destroy(); resolve(null); }, 800);
        s.once('connect', () => { clearTimeout(t); resolve(s); });
        s.once('error', () => { clearTimeout(t); resolve(null); });
      });
      if (!sock) continue;
      this.sock = sock;
      this.buf = Buffer.alloc(0);
      sock.on('data', (d) => this.onData(d));
      sock.on('close', () => { this.sock = null; this.ready = false; if (this.status !== 'off' && this.status !== 'bad-id') this.status = 'discord-closed'; });
      sock.on('error', () => {});
      sock.write(this.frame(0, { v: 1, client_id: this.clientId }));
      this.connecting = false;
      return;
    }
    this.connecting = false;
    this.status = 'discord-not-running';
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) break;
      let msg = {};
      try { msg = JSON.parse(this.buf.subarray(8, 8 + len).toString('utf8')); } catch { /* ignore */ }
      this.buf = this.buf.subarray(8 + len);
      if (op === 1 && msg.evt === 'READY') { this.ready = true; this.status = 'connected'; this.flush(true); }
      else if (op === 1 && msg.evt === 'ERROR') { this.status = 'error: ' + (msg.data?.message || 'unknown'); }
      else if (op === 2) { this.disconnect(/client id/i.test(msg.message || '') ? 'bad-id' : 'discord-closed'); }
      else if (op === 3) { this.sock?.write(this.frame(4, msg)); } // ping → pong
    }
  }

  /** Discord allows ~5 updates / 20s; coalesce to one every 4s. */
  flush(now = false) {
    clearTimeout(this.sendTimer);
    if (!this.ready || !this.sock) return;
    const wait = now ? 0 : Math.max(0, 4000 - (Date.now() - this.lastSent));
    this.sendTimer = setTimeout(() => {
      if (!this.ready || !this.sock) return;
      this.lastSent = Date.now();
      this.sock.write(this.frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: this.activity }, nonce: crypto.randomUUID() }));
    }, wait);
  }

  async update({ enabled, clientId, activity }) {
    const id = String(clientId || '').trim();
    if (!enabled || !/^\d{15,22}$/.test(id)) {
      if (this.sock && this.ready) this.sock.write(this.frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: crypto.randomUUID() }));
      setTimeout(() => this.disconnect(enabled ? 'bad-id' : 'off'), 200);
      return this.status = enabled ? 'bad-id' : 'off';
    }
    if (id !== this.clientId) { this.disconnect('connecting'); this.clientId = id; }
    this.activity = sanitizeActivity(activity);
    if (!this.sock) await this.connect();
    else this.flush();
    return this.status;
  }
}

function sanitizeActivity(a) {
  if (!a) return null;
  const clip = (s, n = 120) => (s == null ? undefined : String(s).slice(0, n));
  const out = { details: clip(a.details), state: clip(a.state), instance: false };
  if (a.start) out.timestamps = { start: Math.floor(Number(a.start) / 1000) * 1000 };
  const assets = {};
  if (a.largeImage) { assets.large_image = clip(a.largeImage, 256); assets.large_text = clip(a.largeText || 'Box-DocSpitter'); }
  if (a.smallImage) { assets.small_image = clip(a.smallImage, 256); assets.small_text = clip(a.smallText); }
  if (Object.keys(assets).length) out.assets = assets;
  return out;
}

const presence = new DiscordPresence();

// ---------------------------------------------------------------------------
// Media: streaming, external tools (yt-dlp / ffmpeg), BoxVidKlep scanning & download jobs
// ---------------------------------------------------------------------------

const { Readable } = require('stream');
const MEDIA_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.3gp': 'video/3gpp', '.wmv': 'video/x-ms-wmv',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.flac': 'audio/flac', '.weba': 'audio/webm',
};
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function findExe(name) {
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = [
    path.join(DATA, 'bin'),
    ...(process.env.PATH || process.env.Path || '').split(path.delimiter),
    ...(IS_WIN ? [path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'), path.join(os.homedir(), 'scoop', 'shims'), 'C:\\ProgramData\\chocolatey\\bin', 'C:\\ffmpeg\\bin'] : ['/usr/local/bin', '/opt/homebrew/bin']),
  ].filter(Boolean);
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, name + e);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}
function tools() { return { ytdlp: findExe('yt-dlp'), ffmpeg: findExe('ffmpeg') }; }

async function streamFile(req, res, file) {
  const st = await fsp.stat(file);
  const type = MEDIA_MIME[path.extname(file).toLowerCase()] || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    let start = m[1] ? Number(m[1]) : st.size - Number(m[2] || 0);
    let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, st.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }
}

function checkUrl(u) {
  let url;
  try { url = new URL(String(u || '').trim()); } catch { throw Object.assign(new Error('That doesn’t look like a web address'), { status: 400 }); }
  if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error('Only http and https links are supported'), { status: 400 });
  if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && Number(url.port) === PORT) throw Object.assign(new Error('Not allowed'), { status: 400 });
  return url;
}

const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mov|mkv|ogv|m3u8|mpd|mp3|m4a|wav|ogg|flac)(?:$|[?#])/i;
const SITE_RE = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com|twitter\.com|x\.com|instagram\.com|facebook\.com|fb\.watch|reddit\.com|redd\.it|soundcloud\.com|bilibili\.com|streamable\.com|bandcamp\.com|rumble\.com|kick\.com|odysee\.com|bsky\.app)$/i;

function extractMedia(html, base) {
  const found = new Map();
  const add = (raw, how, extra = {}) => {
    if (!raw) return;
    let u = raw.trim().replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    if (u.startsWith('blob:') || u.startsWith('data:')) return;
    try { u = new URL(u, base).href; } catch { return; }
    if (!/^https?:/.test(u)) return;
    if (!found.has(u)) found.set(u, { url: u, how, ...extra });
  };
  const attr = (tag, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag); return m ? m[1] : null; };
  let poster = null;
  for (const m of html.matchAll(/<video\b[^>]*>/gi)) { add(attr(m[0], 'src'), 'video tag'); poster = poster || attr(m[0], 'poster'); }
  for (const m of html.matchAll(/<source\b[^>]*>/gi)) {
    const t = attr(m[0], 'type') || '';
    const s = attr(m[0], 'src');
    if (s && (/video|audio|mpegurl/i.test(t) || VIDEO_EXT_RE.test(s))) add(s, 'source tag', { mime: t || undefined });
  }
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], 'property') || attr(m[0], 'name') || attr(m[0], 'itemprop') || '').toLowerCase();
    if (/^(og:video(:url|:secure_url)?|twitter:player:stream|contenturl)$/.test(key)) add(attr(m[0], 'content'), 'page metadata');
    if (key === 'og:image' && !poster) poster = attr(m[0], 'content');
  }
  for (const m of html.matchAll(/"contentUrl"\s*:\s*"([^"]+)"/gi)) add(m[1], 'structured data');
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) if (VIDEO_EXT_RE.test(m[1])) add(m[1], 'link');
  for (const m of html.matchAll(/(?:https?:)?(?:\\?\/){2}[^\s"'<>()\\]+?\.(?:mp4|m4v|webm|mov|mkv|ogv|m3u8)(?:\?[^\s"'<>\\]*)?/gi)) add(m[0].startsWith('//') || m[0].startsWith('\\/') ? 'https:' + m[0].replace(/\\\//g, '/') : m[0], 'page source');
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || '').trim().replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  let posterUrl = null;
  try { posterUrl = poster ? new URL(poster.replace(/&amp;/g, '&'), base).href : null; } catch { /* ignore */ }
  return { title, poster: posterUrl, items: [...found.values()].slice(0, 80) };
}

async function probe(url, referer) {
  const headers = { 'User-Agent': BROWSER_UA, Range: 'bytes=0-0' };
  if (referer) headers.Referer = referer;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(url, { headers, redirect: 'follow', signal: ctl.signal });
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const cr = r.headers.get('content-range');
    const size = cr && /\/(\d+)$/.test(cr) ? Number(/\/(\d+)$/.exec(cr)[1]) : Number(r.headers.get('content-length')) || null;
    try { await r.body?.cancel(); } catch { /* ignore */ }
    return { ok: r.ok || r.status === 206, status: r.status, type, size: r.status === 206 || size > 1 ? size : null, finalUrl: r.url };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(t); }
}

function runCapture(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; if (out.length > 64 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { child.kill(); reject(new Error('Timed out')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error((err.split('\n').filter((l) => /ERROR/.test(l)).pop() || err.slice(-400) || `exit ${code}`).trim())); });
  });
}

/** @param {'on'|'off'|undefined} playlist  for links that are both a video and a playlist (watch?v=…&list=…) */
async function ytdlpInfo(url, { playlist } = {}) {
  const exe = tools().ytdlp;
  if (!exe) return null;
  const flag = playlist === 'on' ? ['--yes-playlist'] : playlist === 'off' ? ['--no-playlist'] : [];
  const json = JSON.parse(await runCapture(exe, ['-J', '--no-warnings', '--flat-playlist', ...flag, '--', url], 300000));
  const hasFfmpeg = !!tools().ffmpeg;
  const toItem = (v) => {
    const fmts = (v.formats || []).filter((f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.protocol && /^https?$/.test(f.protocol));
    const progressive = fmts.sort((a, b) => (b.height || 0) - (a.height || 0)).slice(0, 4).map((f) => ({
      label: `${f.height ? f.height + 'p' : f.format_note || f.format_id} ${f.ext}${f.fps ? ' ' + Math.round(f.fps) + 'fps' : ''}`, selector: f.format_id, size: f.filesize || f.filesize_approx || null,
    }));
    const options = [
      { label: hasFfmpeg ? 'Best quality (video + audio)' : 'Best single file', selector: hasFfmpeg ? 'bv*+ba/b' : 'b[ext=mp4]/b', size: null },
      ...progressive,
      { label: hasFfmpeg ? 'Audio only (mp3)' : 'Audio only (m4a)', selector: hasFfmpeg ? 'ba/b' : 'ba[ext=m4a]/ba', audio: true, size: null },
    ];
    return {
      id: crypto.randomBytes(6).toString('hex'), type: 'ytdlp', url: v.webpage_url || v.url || url, title: v.title || v.id || 'video',
      thumb: v.thumbnail || (v.thumbnails && v.thumbnails[v.thumbnails.length - 1]?.url) || null, duration: v.duration || null,
      uploader: v.uploader || v.channel || null, options, extractor: v.extractor_key || v.ie_key,
    };
  };
  if (json._type === 'playlist') {
    return { title: json.title, playlist: true, items: (json.entries || []).slice(0, 500).map((e) => ({ ...toItem(e), url: e.url && /^https?:/.test(e.url) ? e.url : e.webpage_url || e.url })) };
  }
  return { title: json.title, items: [toItem(json)] };
}

const jobs = new Map();
function newJob(label) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, label, status: 'running', progress: 0, bytes: 0, total: null, path: null, error: null, started: Date.now(), cancel: null };
  jobs.set(id, job);
  return job;
}
function jobView(j) { const { cancel, ...rest } = j; void cancel; return rest; }

function safeFileName(name, fallback = 'video') {
  const n = String(name || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);
  return n.replace(/[. ]+$/, '') || fallback;
}
async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}

async function downloadDirect(job, url, dest, referer) {
  const ctl = new AbortController();
  job.cancel = () => ctl.abort();
  const headers = { 'User-Agent': BROWSER_UA };
  if (referer) headers.Referer = referer;
  const r = await fetch(url, { headers, redirect: 'follow', signal: ctl.signal });
  if (!r.ok) throw new Error(`Server answered ${r.status}`);
  job.total = Number(r.headers.get('content-length')) || null;
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  const body = Readable.fromWeb(r.body);
  body.on('data', (c) => { job.bytes += c.length; job.progress = job.total ? job.bytes / job.total : 0; });
  await new Promise((resolve, reject) => { body.pipe(out); out.on('finish', resolve); out.on('error', reject); body.on('error', reject); });
  await fsp.rename(tmp, dest);
}

async function downloadHls(job, url, dest, referer) {
  const headers = { 'User-Agent': BROWSER_UA };
  if (referer) headers.Referer = referer;
  const ctl = new AbortController();
  job.cancel = () => ctl.abort();
  const text = async (u) => { const r = await fetch(u, { headers, signal: ctl.signal }); if (!r.ok) throw new Error(`Playlist answered ${r.status}`); return r.text(); };
  let pl = await text(url);
  let base = url;
  if (/#EXT-X-STREAM-INF/.test(pl)) {
    const lines = pl.split(/\r?\n/);
    let best = null;
    for (let i = 0; i < lines.length; i++) {
      const m = /#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/.exec(lines[i]);
      if (m && lines[i + 1] && !lines[i + 1].startsWith('#')) { const bw = Number(m[1]); if (!best || bw > best.bw) best = { bw, uri: lines[i + 1].trim() }; }
    }
    if (!best) throw new Error('No playable variant in this stream');
    base = new URL(best.uri, url).href;
    pl = await text(base);
  }
  if (/#EXT-X-KEY:(?![^\n]*METHOD=NONE)/.test(pl)) throw new Error('This stream is encrypted (DRM-protected), so it can’t be downloaded.');
  const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(pl);
  const segs = pl.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => new URL(l.trim(), base).href);
  if (!segs.length) throw new Error('Empty stream');
  if (init && dest.endsWith('.ts')) { dest = dest.slice(0, -3) + '.mp4'; job.path = dest; } // fragmented-MP4 stream
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  const write = (buf) => new Promise((res, rej) => out.write(buf, (e) => (e ? rej(e) : res())));
  if (init) { const r = await fetch(new URL(init[1], base).href, { headers, signal: ctl.signal }); await write(Buffer.from(await r.arrayBuffer())); }
  for (let i = 0; i < segs.length; i++) {
    const r = await fetch(segs[i], { headers, signal: ctl.signal });
    if (!r.ok) throw new Error(`Segment ${i + 1} failed (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    job.bytes += buf.length;
    await write(buf);
    job.progress = (i + 1) / segs.length;
  }
  await new Promise((res) => out.end(res));
  await fsp.rename(tmp, dest);
}

function downloadYtdlp(job, url, dir, selector) {
  return new Promise((resolve, reject) => {
    const exe = tools().ytdlp;
    if (!exe) return reject(new Error('yt-dlp is not installed'));
    const args = ['-f', selector || 'b', '-o', path.join(dir, '%(title).120B [%(id)s].%(ext)s'), '--newline', '--no-playlist', '--no-mtime', '--no-warnings',
      '--print', 'after_move:filepath', '--windows-filenames'];
    const ff = tools().ffmpeg;
    if (ff) args.push('--ffmpeg-location', ff, '--merge-output-format', 'mp4');
    if (/^ba/.test(selector || '') && ff) args.push('-x', '--audio-format', 'mp3');
    args.push('--', url);
    const child = spawn(exe, args, { windowsHide: true });
    job.cancel = () => child.kill();
    let last = '';
    let err = '';
    child.stdout.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        const m = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)(\w+)/.exec(line);
        if (m) {
          job.progress = Number(m[1]) / 100;
          const mult = { KiB: 1024, MiB: 1048576, GiB: 1073741824, B: 1 }[m[3]] || 1;
          job.total = Math.round(Number(m[2]) * mult);
          job.bytes = Math.round(job.total * job.progress);
        } else if (line.trim() && !line.startsWith('[')) last = line.trim();
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && last && fs.existsSync(last)) { job.path = last; resolve(); }
      else reject(new Error((err.split('\n').filter((l) => /ERROR/.test(l)).pop() || err.slice(-300) || `yt-dlp exited ${code}`).trim()));
    });
  });
}

// ---- audio grabbing: links → MP3s in the audio dump (BoxVidKlep's "MP3 → audio dump" and BoxTape)

/** One link (YouTube, SoundCloud, any yt-dlp site) → MP3 with title/artist/cover art. Resolves to the file path. */
function ytdlpToMp3(track, url, dir, onProgress, onChild) {
  return new Promise((resolve, reject) => {
    const t = tools();
    if (!t.ytdlp) return reject(new Error('yt-dlp is not installed (winget install yt-dlp)'));
    if (!t.ffmpeg) return reject(new Error('Making MP3s needs ffmpeg (winget install Gyan.FFmpeg)'));
    const args = ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg',
      '--no-playlist', '--newline', '--no-warnings', '--no-mtime', '--windows-filenames', '--ffmpeg-location', t.ffmpeg,
      '-o', path.join(dir, '%(title).120B.%(ext)s'), '--print', 'after_move:filepath', '--', url];
    const child = spawn(t.ytdlp, args, { windowsHide: true });
    onChild(child);
    let last = '';
    let err = '';
    child.stdout.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        const m = /\[download\]\s+([\d.]+)%/.exec(line);
        if (m) onProgress(Number(m[1]) / 100 * 0.9);
        else if (/\[ExtractAudio\]|\[EmbedThumbnail\]|\[Metadata\]/.test(line)) onProgress(0.95);
        else if (line.trim() && !line.startsWith('[')) last = line.trim();
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && last && fs.existsSync(last)) resolve(last);
      else reject(new Error((err.split('\n').filter((l) => /ERROR/.test(l)).pop() || err.slice(-300) || `yt-dlp exited ${code}`).replace(/^ERROR:\s*/, '').trim()));
    });
  });
}

/** A direct video/audio file or an HLS stream → MP3 with ffmpeg. */
function ffmpegToMp3(url, dest, referer, onProgress, onChild) {
  return new Promise((resolve, reject) => {
    const ff = tools().ffmpeg;
    if (!ff) return reject(new Error('Making MP3s needs ffmpeg (winget install Gyan.FFmpeg)'));
    const headers = `User-Agent: ${BROWSER_UA}\r\n${referer ? `Referer: ${referer}\r\n` : ''}`;
    const child = spawn(ff, ['-hide_banner', '-y', '-headers', headers, '-i', url, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', dest], { windowsHide: true });
    onChild(child);
    let err = '';
    let duration = 0;
    child.stderr.on('data', (d) => {
      const s2 = String(d);
      err = (err + s2).slice(-4000);
      const dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(s2);
      if (dm) duration = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]);
      const tm = /time=(\d+):(\d+):([\d.]+)/.exec(s2);
      if (tm && duration) onProgress(Math.min(0.99, (Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3])) / duration));
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(dest) : reject(new Error(err.split('\n').filter(Boolean).slice(-2).join(' ') || `ffmpeg exited ${code}`))));
  });
}

async function grabAudio(job, items, parallel = 3) {
  const children = new Set();
  let cancelled = false;
  job.cancel = () => { cancelled = true; for (const c of children) { try { c.kill(); } catch { /* gone */ } } };
  job.tracks = items.map((it) => ({ title: it.title || it.name || it.url, status: 'waiting', file: null, error: null, progress: 0 }));
  job.done = 0;
  job.failed = 0;
  job.parallel = parallel;
  const overall = () => { job.progress = job.tracks.reduce((a, t) => a + (t.status === 'done' || t.status === 'failed' ? 1 : t.progress || 0), 0) / items.length; };
  let next = 0;
  async function worker() {
    while (!cancelled && next < items.length) {
      const i = next++;
      const it = items[i];
      const tr = job.tracks[i];
      tr.status = 'working';
      job.current = job.tracks.filter((t) => t.status === 'working').map((t) => t.title).join(' · ');
      let child = null;
      const onChild = (c) => { child = c; children.add(c); };
      const onProgress = (p) => { tr.progress = p; overall(); };
      try {
        checkUrl(it.url);
        if (it.type === 'ytdlp' || !it.type) {
          // each track downloads into its own temp folder, then moves in under a unique name
          // (parallel tracks with the same title can't collide, and half-done files never show up in the player)
          const tmp = path.join(AUDIO_DUMP, '.incoming', crypto.randomBytes(6).toString('hex'));
          await fsp.mkdir(tmp, { recursive: true });
          try {
            const made = await ytdlpToMp3(tr, it.url, tmp, onProgress, onChild);
            const dest = await uniquePath(AUDIO_DUMP, path.basename(made));
            await fsp.rename(made, dest);
            tr.file = dest;
          } finally {
            fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
          }
        } else {
          let base = it.name || it.title || 'audio';
          try { if (!it.name && !it.title) base = decodeURIComponent(path.basename(new URL(it.url).pathname)); } catch { /* ignore */ }
          const dest = await uniquePath(AUDIO_DUMP, safeFileName(base.replace(/\.[a-z0-9]{2,5}$/i, ''), 'audio') + '.mp3');
          tr.file = await ffmpegToMp3(it.url, dest, it.referer, onProgress, onChild);
        }
        tr.status = 'done';
        tr.name = path.basename(tr.file);
        job.done++;
      } catch (e) {
        if (cancelled) { tr.status = 'cancelled'; } else { tr.status = 'failed'; tr.error = e.message; job.failed++; }
      } finally {
        if (child) children.delete(child);
        overall();
        job.current = job.tracks.filter((t) => t.status === 'working').map((t) => t.title).join(' · ') || null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, items.length)) }, worker));
  for (const t of job.tracks) if (t.status === 'waiting') t.status = 'cancelled';
  job.current = null;
  if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  if (!job.done && job.failed) throw new Error(job.tracks.find((t) => t.error)?.error || 'Nothing could be converted');
}

function runFfmpegJob(job, args, durationSec) {
  return new Promise((resolve, reject) => {
    const exe = tools().ffmpeg;
    if (!exe) return reject(new Error('ffmpeg not found'));
    const child = spawn(exe, ['-hide_banner', '-y', ...args], { windowsHide: true });
    job.cancel = () => child.kill();
    let err = '';
    child.stderr.on('data', (d) => {
      const s = String(d);
      err = (err + s).slice(-4000);
      const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
      if (m && durationSec) job.progress = Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / durationSec);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.split('\n').filter(Boolean).slice(-2).join(' ') || `ffmpeg exited ${code}`))));
  });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

function startJob(job, work) {
  work().then(() => { job.status = 'done'; job.progress = 1; }).catch(async (e) => {
    job.status = job.status === 'cancelled' ? 'cancelled' : 'error';
    job.error = e.name === 'AbortError' ? 'cancelled' : e.message;
    if (job.path) await fsp.unlink(job.path + '.part').catch(() => {});
  });
  return { id: job.id };
}

// ---------------------------------------------------------------------------
// BoxSpaces (folder workspaces): file index, text search, git status, recycle-bin delete
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.cache', '.gradle', '.idea', 'bin', 'obj', 'target', '.pytest_cache', '.mypy_cache', 'dist-newstyle', '$RECYCLE.BIN', 'System Volume Information']);
const BIN_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.zip', '.7z', '.rar', '.gz', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.mov', '.mkv', '.webm', '.mp3', '.wav', '.flac', '.docx', '.xlsx', '.pptx', '.psd', '.class', '.jar', '.pyc', '.o', '.obj', '.lib', '.bin', '.iso', '.db', '.sqlite']);

async function walkFiles(root, { limit = 25000, onFile } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(full); }
      else if (e.isFile()) {
        out.push(full);
        if (onFile && (await onFile(full)) === false) return out;
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

async function searchFiles(root, query, { regex = false, caseSensitive = false, wholeWord = false, include = '' } = {}) {
  let src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) src = `\\b${src}\\b`;
  const re = new RegExp(src, caseSensitive ? 'g' : 'gi');
  const inc = include ? new RegExp(include.split(',').map((s) => s.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')).filter(Boolean).join('|') + '$', 'i') : null;
  const results = [];
  let files = 0;
  let hits = 0;
  await walkFiles(root, {
    limit: 40000,
    onFile: async (file) => {
      if (BIN_EXT.has(path.extname(file).toLowerCase())) return;
      if (inc && !inc.test(file)) return;
      let st;
      try { st = await fsp.stat(file); } catch { return; }
      if (st.size > 2 * 1024 * 1024) return;
      let text;
      try { text = await fsp.readFile(file, 'utf8'); } catch { return; }
      if (text.includes('\u0000')) return;
      files++;
      const lines = text.split(/\r?\n/);
      const matches = [];
      for (let i = 0; i < lines.length && matches.length < 50; i++) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (m) matches.push({ line: i + 1, col: m.index + 1, len: m[0].length, text: lines[i].slice(0, 300) });
      }
      if (matches.length) {
        hits += matches.length;
        results.push({ path: file, rel: path.relative(root, file), matches });
      }
      return hits < 3000;
    },
  });
  return { results, files, hits, truncated: hits >= 3000 };
}

async function gitStatus(root) {
  const git = findExe('git');
  if (!git || !fs.existsSync(path.join(root, '.git'))) return null;
  try {
    const out = await runCapture(git, ['-C', root, 'status', '--porcelain=v1', '-b', '-uall'], 15000);
    const lines = out.split(/\r?\n/).filter(Boolean);
    const branch = (lines[0] || '').replace(/^## /, '').split('...')[0];
    const files = {};
    for (const l of lines.slice(1)) {
      const code = l.slice(0, 2);
      const file = l.slice(3).split(' -> ').pop().replace(/^"|"$/g, '');
      files[path.join(root, file).toLowerCase()] = code.trim() || code;
    }
    return { branch, files };
  } catch { return null; }
}

function recycle(target) {
  if (!IS_WIN) return fsp.rm(target, { recursive: true, force: false });
  const isDir = fs.statSync(target).isDirectory();
  const s = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${isDir ? 'DeleteDirectory' : 'DeleteFile'}(${psQuote(target)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  return runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', s], 60000);
}

// ---------------------------------------------------------------------------
// StoragePeek: drive usage + folder size scans
// ---------------------------------------------------------------------------

let volumeCache = { at: 0, map: {} };
async function volumeInfo() {
  if (!IS_WIN) return {};
  if (Date.now() - volumeCache.at < 60000) return volumeCache.map;
  try {
    const out = await runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, VolumeName, DriveType, FileSystem | ConvertTo-Json -Compress'], 15000);
    const arr = [].concat(JSON.parse(out || '[]'));
    const map = {};
    for (const v of arr) map[String(v.DeviceID).toUpperCase()] = { label: v.VolumeName || '', type: v.DriveType, fs: v.FileSystem || '' };
    volumeCache = { at: Date.now(), map };
  } catch { /* ignore */ }
  return volumeCache.map;
}

async function drives() {
  const vols = await volumeInfo();
  const out = [];
  for (const d of listDrives()) {
    try {
      const s = await fsp.statfs(d);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      const v = vols[d.slice(0, 2).toUpperCase()] || {};
      out.push({ path: d, total, free, used: total - free, label: v.label || '', kind: { 2: 'removable', 3: 'local', 4: 'network', 5: 'optical' }[v.type] || 'drive', fs: v.fs || '' });
    } catch { /* not ready (e.g. empty card reader) */ }
  }
  return out;
}

const CATEGORY = [
  ['video', /\.(mp4|mkv|mov|avi|wmv|webm|m4v|m4s|flv|ts|m2ts|mts|3gp|vob)$/i],
  ['image', /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|raw|cr2|nef|arw|dng|psd|svg|ico)$/i],
  ['audio', /\.(mp3|wav|flac|m4a|aac|ogg|opus|wma|aiff?)$/i],
  ['archive', /\.(zip|7z|rar|tar|gz|bz2|xz|iso|img|cab|msi|vhdx?|vmdk|dmg)$/i],
  ['document', /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|txt|md|rtf|csv|epub)$/i],
  ['code', /\.(js|ts|py|java|cs|cpp|c|h|go|rs|rb|php|json|xml|yml|yaml|html|css|lua|sh|ps1|sql)$/i],
  ['game', /\.(pak|p4k|vpk|bsa|ba2|esm|esp|esl|forge|ucas|utoc|upk|uasset|umap|wad|pck|big|gcf|ncm|rpf|vfs|arc|cpk|dsar|xxx|bnk|wem|sii|scs|acf|ress|resource|assets|ztr|tex|toc|sb|cas|cat)$/i],
  ['app', /\.(exe|dll|sys|so|dylib|bin|dat|bundle|asar|node|jar|class|apk|appx|msix|lib|pdb|obj|cache|db|sqlite|ldb|blob|msp)$/i],
];
const categoryOf = (name) => (CATEGORY.find(([, re]) => re.test(name)) || ['other'])[0];

const scans = new Map();

/**
 * A scan result that fills in while the scan runs. Each folder's own size is pushed up to its ancestors as
 * soon as it is counted, so a view of any folder is correct for whatever has been seen so far.
 */
class ScanTree {
  constructor(root) {
    this.root = root;
    this.nodes = [];
    this.bigFiles = [];
    this.minBig = 0;
    this.byType = {};
    this.byExt = [];
    this.admin = false;
    this.mft = 0;
    this.denied = 0;
    this.add(0, -1, root);
  }
  add(id, parentId, name) {
    const parent = parentId >= 0 ? this.nodes[parentId] : null;
    const n = { id, name, parent, own: 0, logical: 0, count: 0, size: 0, total: 0, kids: new Map(), files: [], denied: false };
    this.nodes[id] = n;
    if (parent) parent.kids.set(name.toLowerCase(), n);
    return n;
  }
  counted(id, alloc, logical, count, denied) {
    const n = this.nodes[id];
    if (!n) return;
    n.own = alloc;
    n.logical = logical;
    n.count = count;
    n.denied = !!denied;
    if (denied) this.denied++;
    for (let p = n; p; p = p.parent) { p.size += alloc; p.total += count; }
  }
  file(id, size, name) {
    const n = this.nodes[id];
    if (!n) return;
    n.files.push({ name, size });
    if (n.files.length > 24) { n.files.sort((a, b) => b.size - a.size); n.files.length = 16; }
    if (this.bigFiles.length < 200 || size > this.minBig) {
      this.bigFiles.push({ node: n, name, size });
      if (this.bigFiles.length > 260) {
        this.bigFiles.sort((a, b) => b.size - a.size);
        this.bigFiles.length = 200;
        this.minBig = this.bigFiles[199].size;
      }
    }
  }
  pathOf(n) {
    const parts = [];
    for (let p = n; p.parent; p = p.parent) parts.push(p.name);
    return path.join(this.root, ...parts.reverse());
  }
}

const SCAN_SRC = path.join(ROOT, 'tools', 'bds-scan.cs');
let scanToolPromise = null;

/** Compiles tools/bds-scan.cs with the C# compiler built into Windows (once per source version). */
function scanTool() {
  if (!IS_WIN) return Promise.resolve(null);
  if (!scanToolPromise) {
    scanToolPromise = (async () => {
      const src = await fsp.readFile(SCAN_SRC);
      const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
      const dir = path.join(DATA, 'bin');
      const exe = path.join(dir, `bds-scan-${hash}.exe`);
      if (fs.existsSync(exe)) return exe;
      const windir = process.env.WINDIR || 'C:\\Windows';
      const csc = [
        path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
        path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
      ].find((p) => fs.existsSync(p));
      if (!csc) return null;
      await fsp.mkdir(dir, { recursive: true });
      for (const old of await fsp.readdir(dir).catch(() => [])) {
        if (/^bds-scan-.*\.exe$/.test(old)) await fsp.unlink(path.join(dir, old)).catch(() => {});
      }
      await new Promise((resolve, reject) => execFile(csc, ['/nologo', '/optimize+', `/out:${exe}`, SCAN_SRC], { windowsHide: true, timeout: 60000 },
        (err, stdout) => (err ? reject(new Error('Scanner compile failed: ' + (stdout || err.message))) : resolve())));
      return exe;
    })().catch((e) => { console.error(`[${APP_NAME}] ${e.message}`); scanToolPromise = null; return null; });
  }
  return scanToolPromise;
}

function applyScanLine(tree, job, line) {
  const f = line.split('\t');
  switch (f[0]) {
    case 'D': {
      const n = tree.add(Number(f[1]), Number(f[2]), f[3]);
      if (n.parent) job.current = tree.pathOf(n);
      break;
    }
    case 'S':
      tree.counted(Number(f[1]), Number(f[2]), Number(f[3]), Number(f[4]), f[5] === '1');
      job.dirs++;
      job.files += Number(f[4]);
      job.bytes += Number(f[2]);
      if (job.total) job.progress = Math.min(0.99, job.bytes / job.total);
      break;
    case 'F': tree.file(Number(f[1]), Number(f[2]), f[3]); break;
    case 'T': {
      const cat = categoryOf('x.' + f[1]);
      tree.byType[cat] = (tree.byType[cat] || 0) + Number(f[2]);
      tree.byExt.push([f[1], Number(f[2])]);
      break;
    }
    case 'A': tree.admin = f[1] === '1'; job.admin = tree.admin; break;
    case 'M': tree.mft = Number(f[1]); break;
    case 'E': job.elapsed = Number(f[2]); break;
    default: break;
  }
}

/** Runs the native scanner. Admin scans go through a UAC prompt and report through a file. */
async function nativeScan(job, tree, exe, elevated) {
  let cancelled = false;
  let rest = '';
  const feed = (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    for (const l of lines) if (l) applyScanLine(tree, job, l.replace(/\r$/, ''));
  };
  if (!elevated) {
    const child = spawn(exe, [tree.root], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    job.cancel = () => { cancelled = true; child.kill(); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', feed);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    if (rest) feed('\n');
    if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    if (code !== 0) throw new Error(`Scanner stopped unexpectedly (code ${code})`);
    return;
  }
  const out = path.join(DATA, 'bin', `scan-${job.id}.txt`);
  const q = (s) => s.replace(/'/g, "''");
  // A trailing backslash would escape the closing quote of the argument (C:\" ), so double it.
  const rootArg = '"' + tree.root.replace(/\\$/, '\\\\') + '"';
  const ps = `$p = Start-Process -FilePath '${q(exe)}' -ArgumentList @('${q(rootArg)}','--out','"${q(out)}"') -Verb RunAs -WindowStyle Hidden -PassThru -Wait; exit $p.ExitCode`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
  job.cancel = () => { cancelled = true; fs.writeFile(out + '.cancel', '', () => {}); };
  job.current = 'waiting for you to approve the admin prompt…';
  let exited = false;
  let exitCode = null;
  child.on('close', (c) => { exited = true; exitCode = c; });
  let pos = 0;
  const decoder = new StringDecoder('utf8');
  const pump = async () => {
    const fh = await fsp.open(out, 'r').catch(() => null);
    if (!fh) return;
    try {
      const buf = Buffer.alloc(1 << 20);
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        feed(decoder.write(buf.subarray(0, bytesRead)));
      }
    } finally { await fh.close(); }
  };
  while (!exited) { await new Promise((r) => setTimeout(r, 250)); await pump(); }
  await pump();
  if (rest) feed('\n');
  await fsp.unlink(out).catch(() => {});
  await fsp.unlink(out + '.cancel').catch(() => {});
  if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  if (!pos) throw new Error('The admin scan didn’t run (was the prompt declined?)');
  if (!job.elapsed) throw new Error(`Scanner stopped unexpectedly (code ${exitCode})`);
}

/** Portable fallback: parallel readdir + lstat in Node (slower; used when the native scanner is unavailable). */
async function jsScan(job, tree) {
  let cancelled = false;
  job.cancel = () => { cancelled = true; };
  let nextId = 0;
  const queue = [[tree.root, 0]];
  let active = 0;
  const one = async (dir, id) => {
    job.current = dir;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { tree.counted(id, 0, 0, 0, true); job.dirs++; return; }
    let own = 0;
    let count = 0;
    const files = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { const cid = ++nextId; tree.add(cid, id, e.name); queue.push([path.join(dir, e.name), cid]); } else if (e.isFile()) files.push(e.name);
    }
    for (let i = 0; i < files.length && !cancelled; i += 64) {
      const stats = await Promise.all(files.slice(i, i + 64).map((n) => fsp.lstat(path.join(dir, n)).then((s) => [n, s.size], () => null)));
      for (const s of stats) {
        if (!s) continue;
        own += s[1];
        count++;
        const cat = categoryOf(s[0]);
        tree.byType[cat] = (tree.byType[cat] || 0) + s[1];
        tree.extTotals[path.extname(s[0]).slice(1).toLowerCase()] = (tree.extTotals[path.extname(s[0]).slice(1).toLowerCase()] || 0) + s[1];
        if (s[1] >= 1024 * 1024) tree.file(id, s[1], s[0]);
      }
    }
    tree.counted(id, own, own, count, false);
    job.dirs++;
    job.files += count;
    job.bytes += own;
    if (job.total) job.progress = Math.min(0.99, job.bytes / job.total);
  };
  await new Promise((resolve) => {
    const pump = () => {
      if (cancelled && !active) return resolve();
      while (!cancelled && active < 32 && queue.length) {
        const [dir, id] = queue.pop();
        active++;
        one(dir, id).catch(() => {}).finally(() => { active--; if (!queue.length && !active) resolve(); else pump(); });
      }
      if (!queue.length && !active) resolve();
    };
    pump();
  });
  if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
}

async function scanFolder(job, root, { elevated = false } = {}) {
  const tree = new ScanTree(root);
  const isDrive = path.parse(root).root.toLowerCase() === root.toLowerCase();
  const st = isDrive ? await fsp.statfs(root).catch(() => null) : null;
  job.total = st ? (st.blocks - st.bavail) * st.bsize : null;
  job.files = 0;
  job.dirs = 0;
  scans.set(job.id, { root, tree, job, at: Date.now(), driveUsed: job.total });
  for (const [id, s] of scans) if (id !== job.id && Date.now() - s.at > 3600_000) scans.delete(id); // keep memory in check
  const exe = await scanTool();
  job.engine = exe ? 'native' : 'node';
  if (exe) {
    try {
      await nativeScan(job, tree, exe, elevated);
      return;
    } catch (e) {
      // If antivirus blocked or removed the compiled scanner, fall back to the portable scanner.
      if (e.name === 'AbortError' || elevated || job.dirs > 0) throw e;
      console.error(`[${APP_NAME}] native scanner unavailable (${e.message}); using the portable scanner`);
      scanToolPromise = null;
      job.engine = 'node';
      return scanFolderJs(job, root);
    }
  }
  if (elevated) throw new Error('Admin scans need Windows');
  await runJsScan(job, tree);
}

async function scanFolderJs(job, root) {
  const tree = new ScanTree(root);
  const prev = scans.get(job.id);
  scans.set(job.id, { ...prev, tree });
  Object.assign(job, { files: 0, dirs: 0, bytes: 0 });
  await runJsScan(job, tree);
}

async function runJsScan(job, tree) {
  tree.extTotals = {};
  await jsScan(job, tree);
  tree.byExt = Object.entries(tree.extTotals);
}

function scanView(scan, p) {
  const { tree, job } = scan;
  const top = tree.nodes[0];
  let node = top;
  let cur = scan.root;
  if (p && p.toLowerCase() !== scan.root.toLowerCase()) {
    const rel = path.relative(scan.root, p);
    for (const part of rel.split(path.sep).filter(Boolean)) {
      node = node.kids.get(part.toLowerCase());
      if (!node) throw Object.assign(new Error('Folder not in this scan'), { status: 404 });
      cur = path.join(cur, node.name);
    }
  }
  const kids = [...node.kids.values()].sort((a, b) => b.size - a.size).slice(0, 300)
    .map((k) => ({ name: k.name, path: path.join(cur, k.name), size: k.size, count: k.total, isDir: true, denied: k.denied }));
  const files = [...node.files].sort((a, b) => b.size - a.size).slice(0, 16)
    .map((f) => ({ name: f.name, path: path.join(cur, f.name), size: f.size, isDir: false, cat: categoryOf(f.name) }));
  const shownFiles = files.reduce((a, f) => a + f.size, 0);
  const running = job.status === 'running';
  // At a drive root, show the space the scan couldn't see, so the map adds up to what Windows reports as used.
  const extra = [];
  let size = node.size;
  if (node === top && scan.driveUsed) {
    if (tree.mft) { extra.push({ name: 'NTFS file table ($MFT)', size: tree.mft, cat: 'system' }); size += tree.mft; }
    const gap = scan.driveUsed - size;
    if (gap > scan.driveUsed * 0.002) {
      extra.push(running
        ? { name: 'not scanned yet', size: gap, cat: 'pending' }
        : { name: tree.admin ? 'System & reserved (shadow copies, metadata)' : 'Hidden / protected — rescan as admin', size: gap, cat: 'hidden' });
      size += gap;
    }
  }
  return {
    root: scan.root, path: cur, size, scanned: node.size, count: node.total, kids, files, extra,
    looseFiles: Math.max(0, node.own - shownFiles), running, admin: tree.admin, denied: tree.denied, engine: job.engine,
    elapsed: job.elapsed || Date.now() - job.started, isDrive: !!scan.driveUsed,
    bigFiles: [...tree.bigFiles].sort((a, b) => b.size - a.size).slice(0, 200).map((b) => ({ path: path.join(tree.pathOf(b.node), b.name), size: b.size })),
    byType: tree.byType,
    byExt: [...tree.byExt].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([ext, size]) => ({ ext, size, cat: categoryOf('x.' + ext) })),
  };
}

// ---------------------------------------------------------------------------
// Ask Claude (opt-in). The user's API key lives in data/secrets.json and never goes back to the page.
// ---------------------------------------------------------------------------

const SECRETS_FILE = path.join(DATA, 'secrets.json');
const CLIPS_FILE = path.join(DATA, 'clips.json');
const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function aiKey() { return readJSON(SECRETS_FILE, {}).anthropicKey || process.env.ANTHROPIC_API_KEY || ''; }

let anthropicClient = null;
let anthropicKeyUsed = null;
function anthropic() {
  const key = aiKey();
  if (!key) throw Object.assign(new Error('Add your Anthropic API key in Settings → Ask Claude first.'), { status: 400 });
  if (!anthropicClient || anthropicKeyUsed !== key) {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod;
    anthropicClient = new Anthropic({ apiKey: key });
    anthropicKeyUsed = key;
  }
  return anthropicClient;
}

async function aiChat(req, res) {
  const body = await readJSONBody(req);
  const model = AI_MODELS.includes(body.model) ? body.model : AI_MODELS[0];
  const effort = AI_EFFORTS.includes(body.effort) ? body.effort : 'medium';
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
  if (!messages.length || messages[0].role !== 'user') throw Object.assign(new Error('Nothing to send'), { status: 400 });
  const client = anthropic();
  const Anthropic = client.constructor;
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch { /* client gone */ } };
  const params = {
    model,
    max_tokens: 64000,
    output_config: { effort },
    system: String(body.system || '').slice(0, 20000) || undefined,
    messages,
  };
  // Server-side refusal fallback (Opus / Sonnet only; Haiku has none).
  if (model !== 'claude-haiku-5-5') { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
  const stream = client.beta.messages.stream(params);
  req.on('close', () => { try { stream.abort(); } catch { /* ignore */ } });
  stream.on('text', (t) => send({ type: 'text', text: t }));
  try {
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      send({ type: 'refusal', category: final.stop_details?.category || null, explanation: final.stop_details?.explanation || null });
    }
    send({ type: 'done', stop_reason: final.stop_reason, model: final.model, usage: { input: final.usage?.input_tokens, output: final.usage?.output_tokens } });
  } catch (e) {
    let message = e.message || 'Request failed';
    if (e instanceof Anthropic.AuthenticationError) message = 'Anthropic rejected the API key — check it in Settings.';
    else if (e instanceof Anthropic.PermissionDeniedError) message = 'This API key isn’t allowed to use that model.';
    else if (e instanceof Anthropic.RateLimitError) message = 'Rate limited by Anthropic — wait a moment and try again.';
    else if (e instanceof Anthropic.BadRequestError) message = 'Request rejected: ' + e.message;
    else if (e instanceof Anthropic.APIConnectionError) message = 'Couldn’t reach Anthropic — check your internet connection.';
    else if (e instanceof Anthropic.APIError) message = `Anthropic API error ${e.status}: ${e.message}`;
    if (e.name !== 'APIUserAbortError') send({ type: 'error', message });
  }
  res.end();
}

// ---------------------------------------------------------------------------
// Client tracking (for auto-exit when the app window closes)
// ---------------------------------------------------------------------------

const clients = new Map();
const previewRoots = new Map();
let everHadClient = false;
let lastClientSeen = Date.now();
const startedAt = Date.now();

function touchClient(id) {
  if (!id) return;
  clients.set(id, Date.now());
  everHadClient = true;
  lastClientSeen = Date.now();
}

// Windows say goodbye via /api/bye when they close. Minimized windows get their timers throttled to about
// one per minute, so a silent client is only dropped after 2.5 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of clients) if (now - t > 150000) clients.delete(id);
  if (!APP_MODE) return;
  if (everHadClient && clients.size === 0 && now - lastClientSeen > 10000) shutdown('window closed');
  if (!everHadClient && now - startedAt > 5 * 60 * 1000) shutdown('no window connected');
}, 3000).unref();

function shutdown(reason) {
  console.log(`[${APP_NAME}] shutting down (${reason})`);
  try { fs.unlinkSync(path.join(DATA, 'session.json')); } catch { /* ignore */ }
  process.exit(0);
}

function openAppWindow(paths = []) {
  const qs = paths.map((p) => 'open=' + encodeURIComponent(p)).join('&');
  const url = `http://${HOST}:${PORT}/${qs ? '?' + qs : ''}`;
  if (SHELL_MODE) { process.send({ type: 'open', url }); return; }
  if (NO_WINDOW) { console.log(`[${APP_NAME}] ${url}`); return; }
  if (BROWSER) {
    const child = spawn(BROWSER, [`--app=${url}`, '--window-size=1480,940', '--no-first-run', '--no-default-browser-check'], {
      detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.unref();
  } else if (IS_WIN) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

const routes = {
  'GET /api/info': async () => ({
    app: APP_NAME, version: VERSION, platform: process.platform, sep: path.sep,
    home: os.homedir(), desktop: knownFolder('desktop'), documents: knownFolder('documents'),
    downloads: knownFolder('downloads'), pictures: knownFolder('pictures'),
    drives: listDrives(), pdfExport: !!BROWSER || SHELL_MODE, nativeDialogs: IS_WIN, appMode: APP_MODE || SHELL_MODE, shell: SHELL_MODE,
    user: os.userInfo().username,
  }),

  'GET /api/list': async (req, q) => {
    const dir = requirePath(q.get('path'));
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out = await Promise.all(entries.map(async (e) => {
      const full = path.join(dir, e.name);
      let st = null;
      try { st = await fsp.stat(full); } catch { /* broken link / access denied */ }
      const isDir = st ? st.isDirectory() : e.isDirectory();
      const hidden = e.name.startsWith('$') || /^(desktop\.ini|thumbs\.db|ntuser\.(dat|ini|pol).*|system volume information)$/i.test(e.name);
      return {
        name: e.name, path: full, isDir, size: st && !isDir ? st.size : null,
        mtime: st ? st.mtimeMs : null, hidden, dot: e.name.startsWith('.'), denied: !st,
      };
    }));
    out.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { path: dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, entries: out };
  },

  'GET /api/stat': async (req, q) => {
    const p = requirePath(q.get('path'));
    try {
      const st = await fsp.stat(p);
      return { exists: true, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
    } catch { return { exists: false }; }
  },

  'POST /api/write': async (req, q) => {
    const p = requirePath(q.get('path'));
    const expect = q.get('expectMtime');
    const force = q.get('force') === '1';
    const body = await readBody(req);
    let st = null;
    try { st = await fsp.stat(p); } catch { /* new file */ }
    if (st && st.isDirectory()) throw Object.assign(new Error('Path is a folder'), { status: 400 });
    if (st && expect && !force && Math.abs(st.mtimeMs - Number(expect)) > 2) {
      return { httpStatus: 409, body: { error: 'File changed on disk since it was opened', conflict: true, mtime: st.mtimeMs } };
    }
    await fsp.mkdir(path.dirname(p), { recursive: true });
    if (st) await backupFile(p).catch((e) => console.warn('backup failed', e.message));
    const tmp = path.join(path.dirname(p), `.${path.basename(p)}.bds-${process.pid}.tmp`);
    try {
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, p);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      await fsp.writeFile(p, body); // fall back to an in-place write (e.g. rename blocked by a lock)
    }
    const after = await fsp.stat(p);
    await addRecent(p).catch(() => {});
    return { ok: true, mtime: after.mtimeMs, size: after.size, path: p };
  },

  'POST /api/mkdir': async (req) => {
    const { path: p } = await readJSONBody(req);
    await fsp.mkdir(requirePath(p), { recursive: true });
    return { ok: true };
  },

  'POST /api/rename': async (req) => {
    const { from, to } = await readJSONBody(req);
    const a = requirePath(from), b = requirePath(to);
    if (fs.existsSync(b)) throw Object.assign(new Error('A file with that name already exists'), { status: 409 });
    await fsp.rename(a, b);
    return { ok: true, path: b };
  },

  'GET /api/recent': async () => recentList().map((r) => ({ ...r, exists: fs.existsSync(r.path) })),
  'POST /api/recent': async (req) => {
    const { path: p } = await readJSONBody(req);
    await addRecent(requirePath(p));
    return { ok: true };
  },
  'POST /api/recent/remove': async (req) => {
    const { path: p } = await readJSONBody(req);
    recentCache = p ? recentList().filter((r) => r.path.toLowerCase() !== String(p).toLowerCase()) : [];
    await writeJSON(RECENT_FILE, recentCache);
    return { ok: true };
  },

  'GET /api/settings': async () => settingsObj(),
  'POST /api/settings': async (req) => {
    const patch = await readJSONBody(req);
    settingsCache = { ...settingsObj(), ...patch };
    await writeJSON(SETTINGS_FILE, settingsCache);
    return settingsCache;
  },

  'GET /api/versions': async (req, q) => listVersions(requirePath(q.get('path'))),

  'GET /api/drafts': async () => {
    const dir = path.join(DATA, 'drafts');
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
      const d = readJSON(path.join(dir, f), null);
      if (d) out.push({ id: d.id, title: d.title, path: d.path, mode: d.mode, ext: d.ext, savedAt: d.savedAt, size: (d.content || '').length });
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  },
  'GET /api/draft': async (req, q) => {
    const id = String(q.get('id') || '').replace(/[^a-z0-9_-]/gi, '');
    const d = readJSON(path.join(DATA, 'drafts', id + '.json'), null);
    if (!d) throw Object.assign(new Error('Draft not found'), { status: 404 });
    return d;
  },
  'POST /api/draft': async (req) => {
    const d = await readJSONBody(req);
    const id = String(d.id || '').replace(/[^a-z0-9_-]/gi, '');
    if (!id) throw Object.assign(new Error('Missing id'), { status: 400 });
    await writeJSON(path.join(DATA, 'drafts', id + '.json'), { ...d, id, savedAt: Date.now() });
    return { ok: true };
  },
  'POST /api/draft/delete': async (req) => {
    const { id } = await readJSONBody(req);
    const clean = String(id || '').replace(/[^a-z0-9_-]/gi, '');
    if (clean) await fsp.unlink(path.join(DATA, 'drafts', clean + '.json')).catch(() => {});
    return { ok: true };
  },

  'POST /api/dialog': async (req) => nativeDialog(await readJSONBody(req)),

  'POST /api/pdf/unlock': async (req) => {
    const bytes = await readBody(req, 300 * 1024 * 1024);
    return { raw: await unlockPdf(bytes), type: 'application/pdf' };
  },

  'POST /api/print-pdf': async (req) => {
    const html = (await readBody(req, 300 * 1024 * 1024)).toString('utf8');
    const pdf = await htmlToPdf(html);
    return { raw: pdf, type: 'application/pdf' };
  },

  'GET /api/fonts': async () => Object.keys(FONT_FILES).filter((f) => fontPath(f, false, false)),
  'GET /api/font': async (req, q) => {
    const p = fontPath(q.get('family'), q.get('bold') === '1', q.get('italic') === '1');
    if (!p) throw Object.assign(new Error('Font not available'), { status: 404 });
    return { raw: await fsp.readFile(p), type: 'font/ttf' };
  },

  'POST /api/reveal': async (req) => {
    const { path: p } = await readJSONBody(req);
    const target = requirePath(p);
    revealInExplorer(target);
    return { ok: true };
  },

  'POST /api/heartbeat': async (req) => {
    const { clientId } = await readJSONBody(req);
    touchClient(clientId);
    return { ok: true, clients: clients.size };
  },

  'POST /api/new-window': async () => { openAppWindow([]); return { ok: true }; },

  'GET /api/files': async (req, q) => {
    const root = requirePath(q.get('root'));
    const files = await walkFiles(root, { limit: 25000 });
    return { root, files: files.map((f) => path.relative(root, f)), truncated: files.length >= 25000 };
  },
  'POST /api/search': async (req) => {
    const { root, query, ...opts } = await readJSONBody(req);
    if (!query) return { results: [], files: 0, hits: 0 };
    try { return await searchFiles(requirePath(root), query, opts); }
    catch (e) { throw Object.assign(new Error(e instanceof SyntaxError ? 'Invalid regular expression' : e.message), { status: 400 }); }
  },
  'GET /api/git': async (req, q) => (await gitStatus(requirePath(q.get('root')))) || { branch: null, files: {} },
  'POST /api/trash': async (req) => {
    const { path: p } = await readJSONBody(req);
    const target = requirePath(p);
    if (path.parse(target).root === target) throw Object.assign(new Error('Refusing to delete a drive root'), { status: 400 });
    await recycle(target);
    return { ok: true };
  },

  'GET /api/ai/status': async () => {
    const key = aiKey();
    return { configured: !!key, keyHint: key ? '…' + key.slice(-4) : null, fromEnv: !readJSON(SECRETS_FILE, {}).anthropicKey && !!process.env.ANTHROPIC_API_KEY, models: AI_MODELS };
  },
  'POST /api/ai/key': async (req) => {
    const { key } = await readJSONBody(req);
    const k = String(key || '').trim();
    if (k && !/^sk-ant-[\w-]{20,}$/.test(k)) throw Object.assign(new Error('That doesn’t look like an Anthropic API key (they start with sk-ant-).'), { status: 400 });
    await writeJSON(SECRETS_FILE, { ...readJSON(SECRETS_FILE, {}), anthropicKey: k || undefined });
    anthropicClient = null;
    return { ok: true, configured: !!aiKey() };
  },

  'GET /api/drives': async () => drives(),
  'POST /api/storage/scan': async (req) => {
    const { path: p, elevated } = await readJSONBody(req);
    const root = requirePath(p);
    const job = newJob('scan ' + root);
    job.bytes = 0;
    job.files = 0;
    return startJob(job, () => scanFolder(job, root, { elevated: !!elevated }));
  },
  'GET /api/storage/view': async (req, q) => {
    const scan = scans.get(q.get('id'));
    if (!scan) throw Object.assign(new Error('Scan expired — run it again'), { status: 404 });
    return scanView(scan, q.get('path'));
  },

  'GET /api/tools': async () => {
    const t = tools();
    return { ytdlp: !!t.ytdlp, ffmpeg: !!t.ffmpeg, ytdlpPath: t.ytdlp, ffmpegPath: t.ffmpeg, downloads: path.join(knownFolder('downloads') || os.homedir(), 'BoxVidKlep') };
  },

  'POST /api/klep/scan': async (req) => {
    const { url: raw, mode = 'auto', playlist } = await readJSONBody(req);
    const url = checkUrl(raw);
    const t = tools();
    const site = SITE_RE.test(url.hostname);
    const out = { page: url.href, title: '', poster: null, items: [], ytdlp: !!t.ytdlp, ffmpeg: !!t.ffmpeg, needsYtDlp: false, notes: [] };
    const viaYtdlp = async () => {
      const info = await ytdlpInfo(url.href, { playlist });
      out.title = info.title || out.title;
      out.playlist = !!info.playlist;
      out.items = info.items;
    };
    if ((site && mode !== 'page') || mode === 'ytdlp') {
      if (t.ytdlp) {
        try { await viaYtdlp(); return out; } catch (e) { out.notes.push('yt-dlp: ' + e.message); if (mode === 'ytdlp') return out; }
      } else if (site || mode === 'ytdlp') out.needsYtDlp = true;
    }
    // a direct link to a media file?
    const p = await probe(url.href);
    if (p.ok && (/^(video|audio)\//.test(p.type) || /mpegurl/i.test(p.type))) {
      out.items = [{ id: crypto.randomBytes(6).toString('hex'), type: /mpegurl/i.test(p.type) ? 'hls' : 'direct', url: p.finalUrl || url.href, title: decodeURIComponent(path.basename(url.pathname)) || 'video', mime: p.type, size: p.size, how: 'direct link' }];
      return out;
    }
    // otherwise scan the page
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 20000);
    let r;
    try { r = await fetch(url.href, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,*/*' }, redirect: 'follow', signal: ctl.signal }); }
    catch (e) { throw Object.assign(new Error(e.name === 'AbortError' ? 'The page took too long to load' : 'Couldn’t load that page: ' + e.message), { status: 502 }); }
    finally { clearTimeout(tm); }
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) out.notes.push(`The page answered ${r.status}.`);
    if (!/html|xml|text|json/i.test(ct)) { out.notes.push('That link isn’t a web page or a video file.'); return out; }
    const html = (await r.text()).slice(0, 8000000);
    const ex = extractMedia(html, r.url);
    out.title = ex.title;
    out.poster = ex.poster;
    const probed = await mapLimit(ex.items.slice(0, 40), 6, async (c) => ({ c, pr: await probe(c.url, r.url) }));
    for (const { c, pr } of probed) {
      const isHls = /\.m3u8/i.test(c.url) || /mpegurl/i.test(pr.type || '');
      const isMedia = /^(video|audio)\//.test(pr.type || '') || isHls || (pr.ok && /octet-stream|binary/.test(pr.type || '') && VIDEO_EXT_RE.test(c.url));
      if (!isMedia || (!pr.ok && !isHls) || /\.mpd(\?|$)/i.test(c.url)) continue;
      let name = 'video';
      try { name = decodeURIComponent(path.basename(new URL(c.url).pathname)) || name; } catch { /* ignore */ }
      out.items.push({ id: crypto.randomBytes(6).toString('hex'), type: isHls ? 'hls' : 'direct', url: pr.finalUrl || c.url, title: name, mime: pr.type, size: pr.size, how: c.how, referer: r.url });
    }
    if (!out.items.length && t.ytdlp && mode !== 'page') {
      try { await viaYtdlp(); } catch (e) { out.notes.push('yt-dlp couldn’t read it either: ' + e.message); }
    }
    if (!out.items.length) {
      out.notes.push(t.ytdlp ? 'No downloadable videos found on that page.' : 'No direct video files on that page. Sites like YouTube need yt-dlp.');
      if (!t.ytdlp) out.needsYtDlp = true;
    }
    return out;
  },

  // Links → MP3s in the audio dump (one at a time; failures are skipped and reported per track).
  'POST /api/audio/grab': async (req) => {
    const { items, parallel } = await readJSONBody(req);
    const list = (Array.isArray(items) ? items : []).filter((x) => x && typeof x.url === 'string').slice(0, 500);
    const lanes = Math.max(1, Math.min(6, Number(parallel) || 3));
    if (!list.length) throw Object.assign(new Error('Nothing to download'), { status: 400 });
    const job = newJob(list.length === 1 ? (list[0].title || list[0].url) : `${list.length} tracks`);
    return startJob(job, () => grabAudio(job, list, lanes));
  },

  'POST /api/klep/download': async (req) => {
    const { url, type, selector, dir, name, referer } = await readJSONBody(req);
    checkUrl(url);
    const target = requirePath(dir || path.join(knownFolder('downloads') || os.homedir(), 'BoxVidKlep'));
    await fsp.mkdir(target, { recursive: true });
    const job = newJob(name || url);
    if (type === 'ytdlp') return startJob(job, () => downloadYtdlp(job, url, target, selector));
    let fname = 'video';
    try { fname = decodeURIComponent(path.basename(new URL(url).pathname)) || fname; } catch { /* ignore */ }
    fname = safeFileName(name || fname);
    if (type === 'hls') fname = fname.replace(/\.m3u8$/i, '') + '.ts';
    else if (!path.extname(fname)) fname += '.mp4';
    const dest = await uniquePath(target, fname);
    job.path = dest;
    return startJob(job, () => (type === 'hls' ? downloadHls(job, url, dest, referer) : downloadDirect(job, url, dest, referer)));
  },

  'GET /api/job': async (req, q) => {
    const j = jobs.get(q.get('id'));
    if (!j) throw Object.assign(new Error('No such job'), { status: 404 });
    return jobView(j);
  },
  'POST /api/job/cancel': async (req) => {
    const { id } = await readJSONBody(req);
    const j = jobs.get(id);
    if (j && j.status === 'running') { j.status = 'cancelled'; try { j.cancel?.(); } catch { /* ignore */ } }
    return { ok: true };
  },

  'POST /api/ffmpeg': async (req) => {
    const { args, duration, output, label } = await readJSONBody(req);
    if (!Array.isArray(args) || !args.length) throw Object.assign(new Error('Missing arguments'), { status: 400 });
    if (!tools().ffmpeg) throw Object.assign(new Error('ffmpeg is not installed'), { status: 501 });
    const job = newJob(label || 'ffmpeg');
    job.path = output ? requirePath(output) : null;
    return startJob(job, () => runFfmpegJob(job, args.map(String), Number(duration) || 0));
  },

  'POST /api/presence': async (req) => ({ status: await presence.update(await readJSONBody(req)) }),
  'GET /api/presence': async () => ({ status: presence.status }),

  // ---- dumps: folders of reusable images / PDFs, shown in the document editor's bottom drawers
  'GET /api/dump': async (req, q) => {
    const kind = q.get('kind') || 'image';
    const d = dumpOf(kind);
    const entries = await fsp.readdir(d.dir, { withFileTypes: true }).catch(() => []);
    const out = [];
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.') || !d.exts.has(path.extname(e.name).toLowerCase())) continue;
      const full = path.join(d.dir, e.name);
      const st = await fsp.stat(full).catch(() => null);
      if (st) out.push({ name: e.name, path: full, size: st.size, mtime: st.mtimeMs, url: `${d.prefix}${encodeURIComponent(e.name)}?v=${Math.round(st.mtimeMs)}` });
    }
    return { dir: d.dir, items: out.sort((a, b) => b.mtime - a.mtime) };
  },
  'POST /api/dump/add': async (req, q) => {
    const kind = q.get('kind') || 'image';
    const name = dumpName(q.get('name') || (kind === 'image' ? 'image.png' : 'document.pdf'), kind);
    const body = await readBody(req, 300 * 1024 * 1024);
    if (!body.length) throw Object.assign(new Error('Empty file'), { status: 400 });
    const dest = await uniqueDumpPath(name, kind);
    await fsp.writeFile(dest, body);
    return { ok: true, name: path.basename(dest), path: dest };
  },
  'POST /api/dump/remove': async (req) => {
    // "Remove" is reversible: files go to <dump>/.removed rather than being deleted.
    const { name, kind } = await readJSONBody(req);
    const d = dumpOf(kind);
    const n = dumpName(name, kind);
    const bin = path.join(d.dir, '.removed');
    await fsp.mkdir(bin, { recursive: true });
    let dest = path.join(bin, n);
    if (fs.existsSync(dest)) dest = path.join(bin, `${Date.now()}-${n}`);
    await fsp.rename(path.join(d.dir, n), dest);
    return { ok: true };
  },
  'POST /api/dump/rename': async (req) => {
    const { name, to, kind } = await readJSONBody(req);
    const d = dumpOf(kind);
    const a = dumpName(name, kind);
    const b = dumpName(to, kind);
    if (fs.existsSync(path.join(d.dir, b))) throw Object.assign(new Error('That name is taken'), { status: 409 });
    await fsp.rename(path.join(d.dir, a), path.join(d.dir, b));
    return { ok: true, name: b };
  },
  'POST /api/dump/reveal': async (req) => {
    const { kind, name } = await readJSONBody(req).catch(() => ({}));
    const d = dumpOf(kind);
    if (name) revealInExplorer(path.join(d.dir, dumpName(name, kind)));
    else revealInExplorer(d.dir, { select: false });
    return { ok: true };
  },
  // ---- clip tab: clipboard history + saved snippets (data/clips.json; erased by the factory reset)
  'GET /api/clips': async () => {
    const c = readJSON(CLIPS_FILE, {});
    return { history: Array.isArray(c.history) ? c.history : [], snippets: Array.isArray(c.snippets) ? c.snippets : [] };
  },
  'POST /api/clips': async (req) => {
    const body = await readJSONBody(req);
    const cur = readJSON(CLIPS_FILE, {});
    const clean = (list, max) => (Array.isArray(list) ? list : []).slice(0, max).map((x) => ({ ...x, text: typeof x.text === 'string' ? x.text.slice(0, 100000) : x.text }));
    const next = {
      history: body.history ? clean(body.history, 300) : cur.history || [],
      snippets: body.snippets ? clean(body.snippets, 500) : cur.snippets || [],
    };
    await writeJSON(CLIPS_FILE, next);
    return { ok: true };
  },
  // Any file → Windows clipboard as a file (used by the clip tab to re-copy files).
  'POST /api/clip-file': async (req) => {
    const { path: p } = await readJSONBody(req);
    const full = requirePath(p);
    if (!fs.existsSync(full)) throw Object.assign(new Error('That file isn’t there any more'), { status: 404 });
    if (!IS_WIN) throw Object.assign(new Error('Copying files needs Windows'), { status: 501 });
    const ps = `Set-Clipboard -LiteralPath '${full.replace(/'/g, "''")}'`;
    await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], 15000);
    return { ok: true };
  },

  // Puts a dump file on the Windows clipboard as a file (like Ctrl+C in Explorer), so it pastes into
  // Explorer, Discord, email and so on.
  'POST /api/dump/clip': async (req) => {
    const { kind, name } = await readJSONBody(req);
    const d = dumpOf(kind);
    const full = path.join(d.dir, dumpName(name, kind));
    if (!fs.existsSync(full)) throw Object.assign(new Error('File not found'), { status: 404 });
    if (!IS_WIN) throw Object.assign(new Error('Copying files needs Windows'), { status: 501 });
    const ps = `Set-Clipboard -LiteralPath '${full.replace(/'/g, "''")}'`;
    await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], 15000);
    return { ok: true };
  },

  // Lets the HTML/Markdown preview iframe resolve relative links (css, images) next to the file.
  'POST /api/preview-root': async (req) => {
    const { dir } = await readJSONBody(req);
    const d = requirePath(dir);
    let id = [...previewRoots].find(([, v]) => v === d)?.[0];
    if (!id) { id = crypto.randomBytes(9).toString('hex'); previewRoots.set(id, d); }
    return { id, base: `/preview/${id}/` };
  },

  // Factory reset: wipe everything the app has stored (settings, recent files, drafts, version history,
  // API key, caches, and optionally the image dump), then restart clean. Never touches the user's own files.
  'POST /api/reset': async (req) => {
    const body = await readJSONBody(req);
    // which dumps to empty: { dumps: ['image', 'doc', 'audio'] } (older clients sent dump: true for all)
    const wipe = new Set(Array.isArray(body.dumps) ? body.dumps : body.dump ? Object.keys(DUMPS) : []);
    RESETTING = true;
    presence.disconnect();
    await Promise.allSettled([...writeChains.values()]);
    settingsCache = {};
    recentCache = [];
    anthropicClient = null;
    const removed = [];
    for (const name of await fsp.readdir(DATA).catch(() => [])) {
      if (name === 'session.json') continue;
      const full = path.join(DATA, name);
      if (name === 'electron' && SHELL_MODE) {
        // In use by the open window: the shell deletes it on the next start.
        await fsp.writeFile(path.join(DATA, '.reset-electron'), '').catch(() => {});
        removed.push(name + ' (on restart)');
        continue;
      }
      try { await fsp.rm(full, { recursive: true, force: true }); removed.push(name); } catch (e) { console.error(`[${APP_NAME}] reset: ${name}: ${e.message}`); }
    }
    ensureDir(path.join(DATA, 'backups'));
    ensureDir(path.join(DATA, 'drafts'));
    for (const [kind, d] of Object.entries(DUMPS)) {
      await fsp.rm(path.join(d.dir, '.removed'), { recursive: true, force: true }).catch(() => {});
      await fsp.rm(path.join(d.dir, '.incoming'), { recursive: true, force: true }).catch(() => {});
      if (!wipe.has(kind)) continue;
      for (const name of await fsp.readdir(d.dir).catch(() => [])) await fsp.rm(path.join(d.dir, name), { recursive: true, force: true }).catch(() => {});
      removed.push(path.basename(d.dir));
    }
    // Cache left behind by early versions that kept Electron's data in %APPDATA%.
    if (IS_WIN && process.env.APPDATA) await fsp.rm(path.join(process.env.APPDATA, APP_NAME), { recursive: true, force: true }).catch(() => {});
    console.log(`[${APP_NAME}] reset to clean state: ${removed.join(', ')}`);
    setTimeout(() => {
      if (SHELL_MODE) process.send({ type: 'relaunch' });
      else shutdown('reset');
    }, 300);
    return { ok: true, relaunch: SHELL_MODE };
  },

  'POST /api/quit': async () => {
    setTimeout(() => shutdown('quit requested'), 300);
    return { ok: true };
  },
};

// Windows file associations ("open .pdf with Box-DocSpitter").
Object.assign(routes, require('./file-assoc')({ root: ROOT, isWin: IS_WIN, readJSONBody }));

// BoxMail (Gmail over IMAP/SMTP) lives in its own module.
Object.assign(routes, require('./mail-server')({
  secrets: () => readJSON(SECRETS_FILE, {}),
  saveSecrets: (value) => writeJSON(SECRETS_FILE, value),
  readBody, readJSONBody, requirePath,
  dumpFile: (kind, name) => {
    if (!DUMPS[kind]) throw Object.assign(new Error('Unknown dump'), { status: 400 });
    const file = path.join(DUMPS[kind].dir, dumpName(name, kind));
    if (!fs.existsSync(file)) throw Object.assign(new Error(`${name} isn't in the dump any more`), { status: 404 });
    return file;
  },
  log: (msg) => console.log(`[${APP_NAME}] ${msg}`),
}));

async function handleApi(req, res, urlObj) {
  const q = urlObj.searchParams;
  const key = `${req.method} ${urlObj.pathname}`;

  if (key === 'GET /api/ping') return ok(res, { app: APP_NAME, version: VERSION, pid: process.pid });

  // sendBeacon can't set headers, so /api/bye carries the token in the query string.
  if (key === 'POST /api/bye') {
    if (q.get('token') !== TOKEN) return fail(res, 403, 'Bad token');
    clients.delete(q.get('clientId'));
    lastClientSeen = Date.now(); // grace period: a reload says bye, then hello again
    return ok(res);
  }

  // <video> elements can't send headers, so media endpoints take the token in the query string.
  if (key === 'GET /api/stream' || key === 'GET /api/klep/proxy') {
    if (q.get('token') !== TOKEN) return fail(res, 403, 'Bad token');
    if (key === 'GET /api/stream') return streamFile(req, res, requirePath(q.get('path')));
    const target = checkUrl(q.get('url'));
    const headers = { 'User-Agent': BROWSER_UA };
    if (req.headers.range) headers.Range = req.headers.range;
    if (q.get('ref')) headers.Referer = q.get('ref');
    const ctl = new AbortController();
    req.on('close', () => ctl.abort());
    let r;
    try { r = await fetch(target.href, { headers, redirect: 'follow', signal: ctl.signal }); } catch (e) { return fail(res, 502, e.message); }
    const out = { 'Cache-Control': 'no-store' };
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (r.headers.get(h)) out[h] = r.headers.get(h);
    res.writeHead(r.status, out);
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res);
    return;
  }

  if (req.headers['x-bds-token'] !== TOKEN) return fail(res, 403, 'Missing or invalid token');

  if (key === 'GET /api/read' || key === 'GET /api/version') {
    let file;
    if (key === 'GET /api/read') file = requirePath(q.get('path'));
    else {
      const p = requirePath(q.get('path'));
      const id = path.basename(String(q.get('id') || ''));
      file = path.join(DATA, 'backups', hashPath(p), id);
    }
    const st = await fsp.stat(file);
    if (st.isDirectory()) return fail(res, 400, 'Path is a folder');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': st.size,
      'X-Mtime': String(st.mtimeMs), 'Cache-Control': 'no-store',
    });
    if (key === 'GET /api/read') addRecent(file).catch(() => {});
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (key === 'POST /api/ai/chat') return aiChat(req, res);

  const handler = routes[key];
  if (!handler) return fail(res, 404, 'Unknown endpoint');
  const result = await handler(req, q);
  if (result && result.raw) return send(res, 200, result.raw, { 'Content-Type': result.type });
  if (result && result.httpStatus) return send(res, result.httpStatus, result.body);
  return ok(res, result);
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

let indexCache = null;
async function serveIndex(res) {
  if (!indexCache || !APP_MODE) indexCache = await fsp.readFile(path.join(PUBLIC, 'index.html'), 'utf8');
  const html = indexCache.replace(/%%TOKEN%%/g, TOKEN).replace(/%%VERSION%%/g, VERSION);
  send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
}

async function serveStatic(res, baseDir, rel, cache) {
  const file = path.normalize(path.join(baseDir, rel));
  const base = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (!file.toLowerCase().startsWith(base.toLowerCase())) return fail(res, 403, 'Forbidden');
  let st;
  try { st = await fsp.stat(file); } catch { return fail(res, 404, 'Not found'); }
  if (!st.isFile()) return fail(res, 404, 'Not found');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': cache ? 'public, max-age=604800' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

function hostAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) return fail(res, 403, 'Host not allowed');
    const urlObj = new URL(req.url, `http://${HOST}:${PORT}`);
    const p = decodeURIComponent(urlObj.pathname);

    if (p.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${HOST}:${PORT}` && origin !== `http://localhost:${PORT}`) {
        return fail(res, 403, 'Cross-origin request blocked');
      }
      return await handleApi(req, res, urlObj);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');
    for (const d of Object.values(DUMPS)) {
      if (!p.startsWith(d.prefix)) continue;
      const name = path.basename(p.slice(d.prefix.length));
      if (name.startsWith('.') || !d.exts.has(path.extname(name).toLowerCase())) return fail(res, 404, 'Not found');
      return await serveStatic(res, d.dir, name, false);
    }
    if (p.startsWith('/preview/')) {
      const [, , id, ...rest] = p.split('/');
      const rootDir = previewRoots.get(id);
      if (!rootDir) return fail(res, 404, 'Not found');
      return await serveStatic(res, path.normalize(rootDir), rest.join('/'), false);
    }
    if (p === '/' || p === '/index.html') return await serveIndex(res);
    if (p.startsWith('/vendor/')) {
      const rest = p.slice('/vendor/'.length);
      const parts = rest.split('/');
      const pkg = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      if (!VENDOR.has(pkg)) return fail(res, 404, 'Not found');
      return await serveStatic(res, MODULES, rest, true);
    }
    return await serveStatic(res, PUBLIC, p.replace(/^\/+/, ''), false);
  } catch (e) {
    const status = e.status || (e.code === 'ENOENT' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 500);
    if (status === 500) console.error(e);
    if (!res.headersSent) fail(res, status, e.message || 'Server error', { code: e.code });
    else res.end();
  }
});

// ---------------------------------------------------------------------------
// Startup (single instance per port range)
// ---------------------------------------------------------------------------

function ping(port) {
  return new Promise((resolve) => {
    const r = http.get({ host: HOST, port, path: '/api/ping', timeout: 1200, headers: { host: `${HOST}:${port}` } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data).app === APP_NAME); } catch { resolve(false); } });
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
}

function listen(port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => { server.removeListener('error', reject); resolve(); });
  });
}

(async () => {
  for (let port = BASE_PORT; port < BASE_PORT + 15; port++) {
    try {
      await listen(port);
      PORT = port;
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      if (await ping(port)) {
        // Already running: just open another window (with any files passed on the command line).
        PORT = port;
        console.log(`[${APP_NAME}] already running on port ${port}`);
        if (SHELL_MODE) process.send({ type: 'attached' });
        if (APP_MODE || SHELL_MODE) openAppWindow(fileArgs);
        setTimeout(() => process.exit(0), 300);
        return;
      }
    }
  }
  if (!server.listening) { console.error('No free port found'); process.exit(1); }
  await writeJSON(path.join(DATA, 'session.json'), { port: PORT, pid: process.pid, startedAt }).catch(() => {});
  console.log(`[${APP_NAME}] v${VERSION} running at http://${HOST}:${PORT}/`);
  if (APP_MODE || SHELL_MODE) openAppWindow(fileArgs);
})().catch((e) => { console.error(e); process.exit(1); });

if (SHELL_MODE) process.on('disconnect', () => shutdown('shell closed'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
