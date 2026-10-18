#!/usr/bin/env node
/*
 * Box-Deckspitter — local server.
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
const { spawn, execFile, execFileSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { pathToFileURL } = require('url');

const APP_NAME = 'Box-Deckspitter';
// Which copy of the app this is (from its folder, same as the taskbar app id): a starting copy only joins a
// running server that is the same install, never another copy's (which would show that copy's files and music).
const VERSION = require('./package.json').version;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const MODULES = path.join(ROOT, 'node_modules');
// --data=<folder> keeps settings, keys and history somewhere else (used for test runs, so they never touch yours)
const INSTALL_ID = crypto.createHash('sha1').update(path.resolve(ROOT).toLowerCase()).digest('hex').slice(0, 10);
const DATA_ARG = process.argv.find((a) => a.startsWith('--data='));
const DATA = DATA_ARG ? path.resolve(DATA_ARG.slice('--data='.length)) : path.join(ROOT, 'data');
const DUMP = path.join(ROOT, 'media-dump');
const DUMP_REMOVED = path.join(DUMP, '.removed');
const DOC_DUMP = path.join(ROOT, 'doc-dump');
// Folders that were renamed: move an old one over once (pdf-dump became doc-dump, image-dump became
// media-dump). Never overwrites: a name that's already in the new folder stays in the old one.
function moveDumpFolder(from, to) {
  try {
    if (!fs.existsSync(from)) return;
    if (!fs.existsSync(to)) { fs.renameSync(from, to); return; }
    for (const n of fs.readdirSync(from)) if (!fs.existsSync(path.join(to, n))) fs.renameSync(path.join(from, n), path.join(to, n));
    if (!fs.readdirSync(from).length) fs.rmdirSync(from);
  } catch (e) { console.error(`[Box-Deckspitter] couldn't move ${path.basename(from)} to ${path.basename(to)}: ${e.message}`); }
}
moveDumpFolder(path.join(ROOT, 'pdf-dump'), DOC_DUMP);
moveDumpFolder(path.join(ROOT, 'image-dump'), DUMP);
const IS_WIN = process.platform === 'win32';
const DUMP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.jfif', '.ico']);
const DUMP_VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.wmv', '.ogv', '.3gp']);
const DUMP_AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus', '.weba']);

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
// The media dump holds pictures, videos and sounds; "image" is the same folder seen as pictures only (for the
// editors that can only use pictures). "media" comes first so /dump/ serves every kind.
const DUMPS = {
  media: { dir: DUMP, exts: new Set([...DUMP_EXT, ...DUMP_VIDEO_EXT, ...DUMP_AUDIO_EXT]), prefix: '/dump/', what: 'a picture, video or sound' },
  image: { dir: DUMP, exts: DUMP_EXT, prefix: '/dump/', what: 'an image' },
  audio: { dir: AUDIO_DUMP, exts: DUMP_AUDIO_EXT, prefix: '/audiodump/', what: 'an audio file' },
  doc: { dir: DOC_DUMP, exts: new Set(['.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt', '.md', '.xlsx', '.xls', '.ods', '.csv', '.pptx', '.ppt', '.odp', '.html', '.htm', '.eml']), prefix: '/docdump/', what: 'a document' },
};
function dumpOf(kind) { return DUMPS[kind === 'pdf' ? 'doc' : kind] || DUMPS.image; }

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

/** BoxKlep's default download folder (the old Downloads\BoxVidKlep, when there is one, so downloads stay together). */
function klepFolder() {
  const base = knownFolder('downloads') || os.homedir();
  const old = path.join(base, 'BoxVidKlep');
  return fs.existsSync(old) ? old : path.join(base, 'BoxKlep');
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

/** A song's genre and BPM from its ID3v2 tag (what BoxTape writes), reading only the frame headers and those two frames,
 *  so a big cover picture is skipped over rather than read. Remembered per file until it changes. */
const songTagCache = new Map();
/** YouTube's video categories, which yt-dlp writes as the genre (every song is "Music"): not a real genre. */
const YT_CATEGORY = /^(music|entertainment|people & blogs|film & animation|gaming|comedy|education|howto & style|news & politics|nonprofits & activism|science & technology|sports|travel & events|autos & vehicles|pets & animals)$/i;
async function readSongTags(file) {
  const st = await fsp.stat(file);
  const hit = songTagCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.tags;
  const tags = { genre: null, bpm: null };
  const fh = await fsp.open(file, 'r');
  try {
    const read = async (pos, n) => { const b = Buffer.alloc(n); const { bytesRead } = await fh.read(b, 0, n, pos); return b.subarray(0, bytesRead); };
    const head = await read(0, 10);
    if (head.length === 10 && head.toString('latin1', 0, 3) === 'ID3' && (head[3] === 3 || head[3] === 4)) {
      const v4 = head[3] === 4;
      const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
      const end = 10 + syncsafe(head, 6);
      let pos = 10;
      if (head[5] & 0x40) { const x = await read(10, 4); pos += v4 ? syncsafe(x, 0) : 4 + x.readUInt32BE(0); } // an extended header
      const text = (b) => {
        const body = b.subarray(1);
        const s = b[0] === 1 || b[0] === 2 ? (b[0] === 2 || (body[0] === 0xfe && body[1] === 0xff)
          ? Buffer.from(body.subarray(body[0] === 0xfe ? 2 : 0)).swap16().toString('utf16le') : body.subarray(body[0] === 0xff ? 2 : 0).toString('utf16le'))
          : body.toString(b[0] === 3 ? 'utf8' : 'latin1');
        return s.replace(/\0+$/, '').split('\0')[0].trim();
      };
      while (pos + 10 <= end && (tags.genre == null || tags.bpm == null)) {
        const fr = await read(pos, 10);
        if (fr.length < 10 || fr[0] === 0) break; // padding
        const id = fr.toString('latin1', 0, 4);
        const size = v4 ? syncsafe(fr, 4) : fr.readUInt32BE(4);
        if (size <= 0 || pos + 10 + size > end) break;
        if ((id === 'TCON' || id === 'TBPM') && size < 512) {
          const v = text(await read(pos + 10, size));
          if (id === 'TBPM') tags.bpm = Math.round(parseFloat(v)) || null;
          // old-style "(17)" genre numbers are left off; so is YouTube's video category, which older downloads have
          else tags.genre = v.replace(/^\(\d+\)/, '').trim().replace(YT_CATEGORY, '') || null;
        }
        pos += 10 + size;
      }
    }
  } finally { await fh.close(); }
  songTagCache.set(file, { mtime: st.mtimeMs, tags });
  return tags;
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
// Media: what streaming and outside links share (the tools, BoxKlep and the jobs are in media-server.js)
// ---------------------------------------------------------------------------

const { Readable } = require('stream');
const MEDIA_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.3gp': 'video/3gpp', '.wmv': 'video/x-ms-wmv',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.flac': 'audio/flac', '.weba': 'audio/webm',
};
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function checkUrl(u) {
  let url;
  try { url = new URL(String(u || '').trim()); } catch { throw Object.assign(new Error('That doesn’t look like a web address'), { status: 400 }); }
  if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error('Only http and https links are supported'), { status: 400 });
  if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && Number(url.port) === PORT) throw Object.assign(new Error('Not allowed'), { status: 400 });
  return url;
}

// ---------------------------------------------------------------------------
// Custom UI sounds and the clipboard tab
// ---------------------------------------------------------------------------

const SOUNDS_DIR = path.join(DATA, 'sounds');
const UI_SOUNDS = ['hover', 'click', 'type', 'open', 'close'];
const CLIPS_FILE = path.join(DATA, 'clips.json');
const TODOS_FILE = path.join(DATA, 'todos.json');
const BEATS_FILE = path.join(DATA, 'beats.json');

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
    // not through cmd: it reads the & between ?open= files as "run another command" and drops all but the first
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// The parts that live in their own files (each gets what it uses from here and gives back what others use).
const { routes: marketRoutes } = require('./market-server')({ BROWSER_UA });
const { routes: weatherRoutes } = require('./weather-server')({ BROWSER_UA });
const { routes: translateRoutes } = require('./translate-server')({ BROWSER_UA, readJSONBody });
const { routes: dumpsRoutes, dumpRel, dumpName, dumpAbs, dumpRelOf } = require('./dumps-server')({
  DUMP_AUDIO_EXT, DUMP_EXT, DUMP_VIDEO_EXT, IS_WIN, dumpOf, ok, readBody, readJSONBody, requirePath, revealInExplorer,
  runProcess,
});
const { routes: presenceRoutes, presence } = require('./presence-server')({ IS_WIN, readJSONBody });
const { routes: appearanceRoutes, BG_DIR, FONT_DIR } = require('./appearance-server')({ DATA, IS_WIN, ok, readJSONBody, requirePath, writeJSON });
const { routes: mediaRoutes, findExe, tools, streamFile, runCapture, newJob, runFfmpegJob, startJob } = require('./media-server')({
  AUDIO_DUMP, BROWSER_UA, DATA, IS_WIN, MEDIA_MIME, MIME, checkUrl, dumpAbs, dumpRel, dumpRelOf, klepFolder, ok,
  readJSONBody, requirePath, spotify: { findOnYouTube: (it) => spotify.findOnYouTube(it) },
});
const { routes: spacesRoutes } = require('./spaces-server')({ IS_WIN, findExe, ok, psQuote, readJSONBody, requirePath, runCapture });
const { routes: storageRoutes, drives, buildLauncher, migrateLauncher } = require('./storage-server')({
  APP_NAME, DATA, IS_WIN, PUBLIC, ROOT, listDrives, newJob, readJSONBody, requirePath, runCapture, startJob,
});
const { secretsReady, secrets, saveSecrets } = require('./secrets-store')({ APP_NAME, DATA, IS_WIN, readJSON, writeJSON });
const { routes: aiRoutes, forgetAiClient, aiChat } = require('./ai-server')({ ok, readJSONBody, saveSecrets, secrets, send });

const routes = {
  // Help → README: the app's own README.md
  'GET /api/readme': async () => ({ text: await fsp.readFile(path.join(ROOT, 'README.md'), 'utf8') }),
  'GET /api/info': async () => ({
    app: APP_NAME, version: VERSION, platform: process.platform, sep: path.sep,
    home: os.homedir(), desktop: knownFolder('desktop'), documents: knownFolder('documents'),
    downloads: knownFolder('downloads'), pictures: knownFolder('pictures'),
    drives: listDrives(), pdfExport: !!BROWSER || SHELL_MODE, nativeDialogs: IS_WIN, appMode: APP_MODE || SHELL_MODE, shell: SHELL_MODE,
    user: os.userInfo().username,
    root: ROOT, // the folder this copy runs from (shown in the status bar)
    data: DATA, // where new BoxSpaces go by default (data/BoxSpaces)
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
      // live: saved by a window that's still open (another app window's tab, not something to recover)
      if (d) out.push({ id: d.id, title: d.title, path: d.path, mode: d.mode, ext: d.ext, savedAt: d.savedAt, size: (d.content || '').length, client: d.client || null, live: !!d.client && clients.has(d.client) });
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

  // Custom UI sounds live in data/sounds/<sound>.<ext> (your data: kept through updates, wiped by a reset).
  'GET /api/sounds/custom': async () => {
    const out = {};
    for (const n of await fsp.readdir(SOUNDS_DIR).catch(() => [])) {
      const m = /^(hover|click|type|open|close)\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm)$/i.exec(n);
      if (m) { const st = await fsp.stat(path.join(SOUNDS_DIR, n)).catch(() => null); if (st) out[m[1].toLowerCase()] = { file: n, mtime: st.mtimeMs }; }
    }
    return out;
  },
  'GET /api/sounds/file': async (req, q) => {
    const name = String(q.get('name') || '').toLowerCase();
    if (!UI_SOUNDS.includes(name)) throw Object.assign(new Error('Unknown sound'), { status: 400 });
    const f = (await fsp.readdir(SOUNDS_DIR).catch(() => [])).find((n) => n.toLowerCase().startsWith(name + '.'));
    if (!f) throw Object.assign(new Error('No custom sound'), { status: 404 });
    return { file: f, data: (await fsp.readFile(path.join(SOUNDS_DIR, f))).toString('base64') };
  },
  'POST /api/sounds/custom': async (req, q) => {
    const name = String(q.get('name') || '').toLowerCase();
    const ext = String(q.get('ext') || '').toLowerCase().replace(/^\./, '');
    if (!UI_SOUNDS.includes(name)) throw Object.assign(new Error('Unknown sound'), { status: 400 });
    if (!/^(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm)$/.test(ext)) throw Object.assign(new Error('Pick an audio file (mp3, wav, ogg, m4a, flac…)'), { status: 400 });
    const body = await readBody(req, 8 * 1024 * 1024);
    if (!body.length) throw Object.assign(new Error('Empty file'), { status: 400 });
    await fsp.mkdir(SOUNDS_DIR, { recursive: true });
    for (const n of await fsp.readdir(SOUNDS_DIR).catch(() => [])) if (n.toLowerCase().startsWith(name + '.')) await fsp.rm(path.join(SOUNDS_DIR, n), { force: true });
    await fsp.writeFile(path.join(SOUNDS_DIR, `${name}.${ext}`), body);
    return { ok: true, file: `${name}.${ext}` };
  },
  'POST /api/sounds/reset': async (req) => {
    const { name } = await readJSONBody(req);
    const names = name ? [String(name).toLowerCase()] : UI_SOUNDS;
    for (const n of await fsp.readdir(SOUNDS_DIR).catch(() => [])) if (names.some((x) => n.toLowerCase().startsWith(x + '.'))) await fsp.rm(path.join(SOUNDS_DIR, n), { force: true });
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
  // ---- Todo: the lists (data/todos.json; erased by the factory reset)
  'GET /api/todos': async () => {
    const t = readJSON(TODOS_FILE, {});
    return { lists: Array.isArray(t.lists) ? t.lists : [], active: typeof t.active === 'string' ? t.active : null };
  },
  'POST /api/todos': async (req) => {
    const body = await readJSONBody(req);
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    const item = (x) => ({ id: str(x.id, 40), text: str(x.text, 2000), done: !!x.done, star: !!x.star,
      due: /^\d{4}-\d{2}-\d{2}$/.test(x.due) ? x.due : null, created: +x.created || Date.now(), doneAt: +x.doneAt || null });
    const lists = (Array.isArray(body.lists) ? body.lists : []).slice(0, 200).map((l) => ({
      id: str(l.id, 40), name: str(l.name, 120) || 'List', items: (Array.isArray(l.items) ? l.items : []).slice(0, 5000).map(item),
    }));
    await writeJSON(TODOS_FILE, { lists, active: str(body.active, 40) || null });
    return { ok: true };
  },
  // ---- BoxBeat: the beats (data/beats.json; erased by the factory reset)
  'GET /api/beats': async () => {
    const b = readJSON(BEATS_FILE, {});
    return { beats: Array.isArray(b.beats) ? b.beats : [], active: typeof b.active === 'string' ? b.active : null, lines: Array.isArray(b.lines) ? b.lines : [] };
  },
  'POST /api/beats': async (req) => {
    const body = await readJSONBody(req);
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    const num = (v, lo, hi, def) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : def);
    const STEP_COUNTS = [8, 12, 16, 24, 32, 48, 64];
    const hits = (a) => (Array.isArray(a) ? a : []).slice(0, 64).map((v) => num(v, 0, 1, 0));
    // per pattern id: a drum row's hits, or a synth row's notes (start step, MIDI note, length in steps, velocity)
    const perPattern = (o, each) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).slice(0, 16).map(([k, v]) => [str(k, 40), each(v)]));
    const notes = (a) => (Array.isArray(a) ? a : []).slice(0, 512).filter((n) => n && typeof n === 'object')
      .map((n) => ({ s: Math.round(num(n.s, 0, 63, 0)), n: Math.round(num(n.n, 0, 127, 60)), l: Math.round(num(n.l, 1, 64, 1)), v: num(n.v, 0, 1, 1) }));
    const row = (r) => ({ id: str(r.id, 40), name: str(r.name, 80) || 'Sound', kind: r.kind === 'synth' ? 'synth' : 'drum',
      sound: str(r.sound, 20) || null, synth: str(r.synth, 20) || null, view: Math.round(num(r.view, 12, 96, 48)),
      sample: r.sample && typeof r.sample.path === 'string' ? { path: str(r.sample.path, 1024), name: str(r.sample.name, 200) } : null,
      vol: num(r.vol, 0, 1.5, 0.8), pan: num(r.pan, -1, 1, 0), pitch: num(r.pitch, -24, 24, 0), mute: !!r.mute, solo: !!r.solo,
      fx: { rev: num(r.fx?.rev, 0, 1, 0), dly: num(r.fx?.dly, 0, 1, 0), drive: num(r.fx?.drive, 0, 1, 0), tone: num(r.fx?.tone, -1, 1, 0) },
      pats: perPattern(r.pats, hits), notes: perPattern(r.notes, notes),
      ...(Array.isArray(r.steps) ? { steps: hits(r.steps) } : {}) });
    const beats = (Array.isArray(body.beats) ? body.beats : []).slice(0, 500).map((b) => {
      const patterns = (Array.isArray(b.patterns) ? b.patterns : []).slice(0, 16).map((p) => ({ id: str(p?.id, 40), name: str(p?.name, 12) || 'A',
        steps: STEP_COUNTS.includes(+p?.steps) ? +p.steps : 16 }));
      return {
        id: str(b.id, 40), name: str(b.name, 120) || 'Beat', bpm: num(b.bpm, 40, 300, 120), swing: num(b.swing, 0, 0.75, 0),
        steps: STEP_COUNTS.includes(+b.steps) ? +b.steps : 16, master: num(b.master, 0, 1.5, 0.8),
        humanize: num(b.humanize, 0, 1, 0), comp: num(b.comp, 0, 1, 0), key: Math.round(num(b.key, 0, 11, 9)), scale: str(b.scale, 24) || 'minor',
        patterns, pat: str(b.pat, 40), song: (Array.isArray(b.song) ? b.song : []).slice(0, 256).map((id) => str(id, 40)), songMode: !!b.songMode,
        rows: (Array.isArray(b.rows) ? b.rows : []).slice(0, 64).map(row),
      };
    });
    // saved lines: one row's worth of a pattern (hits, or notes relative to the key), kept to add to any pattern later
    const lines = Array.isArray(body.lines) ? body.lines.slice(0, 500).map((l) => ({
      id: str(l.id, 40), name: str(l.name, 80) || 'Line', kind: l.kind === 'synth' ? 'synth' : 'drum', sound: str(l.sound, 20) || null, synth: str(l.synth, 20) || null,
      view: Math.round(num(l.view, 12, 96, 48)), steps: STEP_COUNTS.includes(+l.steps) ? +l.steps : 16, saved: num(l.saved, 0, 4e12, 0),
      sample: l.sample && typeof l.sample.path === 'string' ? { path: str(l.sample.path, 1024), name: str(l.sample.name, 200) } : null,
      vol: num(l.vol, 0, 1.5, 0.8), pan: num(l.pan, -1, 1, 0), pitch: num(l.pitch, -24, 24, 0),
      fx: { rev: num(l.fx?.rev, 0, 1, 0), dly: num(l.fx?.dly, 0, 1, 0), drive: num(l.fx?.drive, 0, 1, 0), tone: num(l.fx?.tone, -1, 1, 0) },
      hits: hits(l.hits),
      // notes are stored as semitones above the key's root, so a line fits whatever key it's added to
      notes: (Array.isArray(l.notes) ? l.notes : []).slice(0, 512).filter((n) => n && typeof n === 'object')
        .map((n) => ({ s: Math.round(num(n.s, 0, 63, 0)), n: Math.round(num(n.n, -48, 72, 0)), l: Math.round(num(n.l, 1, 64, 1)), v: num(n.v, 0, 1, 1) })),
    })) : (readJSON(BEATS_FILE, {}).lines || []);
    await writeJSON(BEATS_FILE, { beats, active: str(body.active, 40) || null, lines });
    return { ok: true };
  },
  // ---- the music player: a song's genre and BPM, from its MP3 tag
  'GET /api/audio/tags': async (req, q) => readSongTags(requirePath(q.get('path'))),
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

  // Lets the HTML/Markdown preview iframe resolve relative links (css, images) next to the file.
  'POST /api/preview-root': async (req) => {
    const { dir } = await readJSONBody(req);
    const d = requirePath(dir);
    let id = [...previewRoots].find(([, v]) => v === d)?.[0];
    if (!id) { id = crypto.randomBytes(9).toString('hex'); previewRoots.set(id, d); }
    return { id, base: `/preview/${id}/` };
  },

  // Factory reset: wipe everything the app has stored (settings, recent files, drafts, version history,
  // API key, caches, and optionally the dumps), then restart clean. Never touches the user's own files.
  'POST /api/reset': async (req) => {
    const body = await readJSONBody(req);
    // which dumps to empty: { dumps: ['image', 'doc', 'audio'] } (older clients sent dump: true for all)
    const wipe = new Set(Array.isArray(body.dumps) ? body.dumps : body.dump ? Object.keys(DUMPS) : []);
    RESETTING = true;
    presence.disconnect();
    await Promise.allSettled([...writeChains.values()]);
    settingsCache = {};
    recentCache = [];
    forgetAiClient();
    const removed = [];
    for (const name of await fsp.readdir(DATA).catch(() => [])) {
      if (name === 'session.json' || name === 'update') continue; // update bookkeeping isn't user data
      // Secure notes are only erased when that box was ticked (they can't be got back)
      if (name === 'secure-notes' && !body.secureNotes) continue;
      const full = path.join(DATA, name);
      if (name === 'backups') {
        // keep backups of earlier app versions (so "go back" still works); everything else in there goes
        for (const n of await fsp.readdir(full).catch(() => [])) if (n !== 'app') await fsp.rm(path.join(full, n), { recursive: true, force: true }).catch(() => {});
        removed.push('backups');
        continue;
      }
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
    if (IS_WIN && process.env.APPDATA) for (const name of [APP_NAME, 'Box-DocSpitter']) await fsp.rm(path.join(process.env.APPDATA, name), { recursive: true, force: true }).catch(() => {});
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

// their routes
Object.assign(routes, marketRoutes, weatherRoutes, translateRoutes, dumpsRoutes, presenceRoutes, appearanceRoutes, mediaRoutes, spacesRoutes, storageRoutes, aiRoutes);

// Windows file associations ("open .pdf with Box-Deckspitter").
Object.assign(routes, require('./file-assoc')({ root: ROOT, isWin: IS_WIN, readJSONBody }));

// Settings export / import (.zip: settings + the still-encrypted Secure notes) and the app PIN lock.
Object.assign(routes, require('./settings-transfer')({
  root: ROOT, data: DATA, version: VERSION, readJSONBody, requirePath,
  settings: () => settingsObj(),
  saveSettings: async (next) => { settingsCache = next; await writeJSON(SETTINGS_FILE, settingsCache); },
  log: (msg) => console.log(`[${APP_NAME}] ${msg}`),
}));

// BoxSwap: profiles of files to hot-swap in a folder (kept in data/boxswap unless you pick another master folder).
Object.assign(routes, require('./swap-server')({ readJSONBody, requirePath, dataDir: DATA, appRoot: ROOT }));

// BoxStudio: scenes + recordings (MediaRecorder pieces streamed to disk, rewrapped by ffmpeg).
Object.assign(routes, require('./studio-server')({ readBody, readJSONBody, requirePath, tools, dumpDir: DUMP, dataFile: path.join(DATA, 'studio.json'), readJSON, writeJSON, log: (msg) => console.log(`[${APP_NAME}] ${msg}`) }));

// BoxMap: offline map regions (PMTiles cut from the free OpenStreetMap build), search, pins.
Object.assign(routes, require('./map-server')({ readJSONBody, newJob, startJob, dataDir: DATA, cacheDir: path.join(DATA, 'cache'), worldFile: path.join(PUBLIC, 'assets', 'map', 'world.json'), readJSON, writeJSON, version: VERSION, log: (msg) => console.log(`[${APP_NAME}] ${msg}`) }));

// BoxLog: log files (Windows, apps, games) and Windows event logs, read-only.
Object.assign(routes, require('./log-server')({ requirePath, readJSONBody, readJSON, writeJSON, dataFile: path.join(DATA, 'log-sources.json'), extraDirs: [path.join(DATA, 'logs')] }));

// BoxTerminal: shell sessions (PowerShell etc.) started in a folder you pick.
Object.assign(routes, require('./terminal-server')({ requirePath, readJSONBody, findExe }));

// Video editor export (frames from the page → ffmpeg).
Object.assign(routes, require('./render-server')({ tools, readBody, readJSONBody, requirePath, newJob, startJob, runFfmpegJob, cacheDir: path.join(DATA, 'cache', 'video'), log: (msg) => console.log(`[${APP_NAME}] ${msg}`) }));

// Spotify links in BoxTape: read the track list, match each song on YouTube.
const spotify = require('./spotify-server')({
  secrets,
  saveSecrets,
  readJSONBody, runCapture, tools,
});
Object.assign(routes, spotify.routes);

// In-app updates (check / download / verify / stage; the boot file installs and can roll back).
Object.assign(routes, require('./update-server')({
  root: ROOT, data: DATA, version: VERSION, shellMode: SHELL_MODE,
  secrets,
  saveSecrets,
  readJSONBody, newJob, startJob,
  relaunch: () => process.send?.({ type: 'relaunch' }),
  log: (msg) => console.log(`[${APP_NAME}] ${msg}`),
}));

// BoxMail (Gmail over IMAP/SMTP) lives in its own module.
Object.assign(routes, require('./mail-server')({
  secrets,
  saveSecrets,
  readBody, readJSONBody, requirePath,
  watchFile: path.join(DATA, 'mail-watch.json'), readJSON, writeJSON,
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

  if (key === 'GET /api/ping') return ok(res, { app: APP_NAME, version: VERSION, pid: process.pid, install: INSTALL_ID, data: DATA_ARG ? 'custom' : 'default' });

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
  await secretsReady; // the keys are unsealed once, at start-up

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
  if (result && result.raw) return send(res, result.status || 200, result.raw, { 'Content-Type': result.type, ...(result.headers || {}) });
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
    if (p.startsWith('/bg/')) return await serveStatic(res, BG_DIR, p.slice(4), true); // named by contents, so cacheable
    if (p.startsWith('/userfonts/')) return await serveStatic(res, FONT_DIR, decodeURIComponent(p.slice(11)), false);
    for (const [kind, d] of Object.entries(DUMPS)) {
      if (!p.startsWith(d.prefix)) continue;
      let name;
      try { name = dumpRel(p.slice(d.prefix.length), kind); } catch { return fail(res, 404, 'Not found'); }
      const ext = path.extname(name).toLowerCase();
      // videos and sounds stream (with seeking); pictures are served whole
      if (DUMP_VIDEO_EXT.has(ext) || DUMP_AUDIO_EXT.has(ext)) {
        const file = dumpAbs(kind, name);
        if (!fs.existsSync(file)) return fail(res, 404, 'Not found');
        return await streamFile(req, res, file);
      }
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
      // the same install with the same data folder; anything else (another copy, a test run) isn't ours to join
      res.on('end', () => { try { const j = JSON.parse(data); resolve((j.app === APP_NAME || j.app === 'Box-DocSpitter') && j.install === INSTALL_ID && j.data === (DATA_ARG ? 'custom' : 'default')); } catch { resolve(false); } });
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
  buildLauncher().then(() => migrateLauncher()).catch((e) => console.error(`[${APP_NAME}] ${e.message}`));
})().catch((e) => { console.error(e); process.exit(1); });

if (SHELL_MODE) process.on('disconnect', () => shutdown('shell closed'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
