// What depends on the operating system, in one place: the drive list, "show in folder", the recycle bin / trash,
// a file on the clipboard, and open/save dialogs (when the page runs in a plain browser tab; the app window uses
// Electron's own). Windows does it the way it always has; Linux uses the freedesktop tools found on any distro
// (gio, xdg-open, zenity or kdialog, wl-copy or xclip) and falls back to the freedesktop trash spec by hand.

'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const fail = (message, status = 500) => Object.assign(new Error(message), { status });

/** A program on the PATH, or null. */
function which(name) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return null;
}

/** Runs a program; resolves with { code, stdout, stderr } (never rejects on a non-zero exit). */
function run(cmd, args, { input = null, timeout = 60000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: env || process.env });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(fail('Timed out')); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input != null) child.stdin.end(input);
  });
}

const psQuote = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
/** PowerShell with the script base64-encoded (no quoting trouble), single-threaded apartment for UI and clipboard. */
const powershell = (script, opts) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], opts);

// ---------------------------------------------------------------------------------------------------- drives

const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'zfs', 'f2fs', 'jfs', 'reiserfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'hfsplus', 'apfs', 'nfs', 'nfs4', 'cifs', 'smb3', '9p', 'drvfs']);

/** Where the file pickers and StoragePeek start: C:\ … Z:\ on Windows; / and the mounted disks elsewhere. */
function listDrives() {
  if (IS_WIN) {
    const out = [];
    for (let c = 67; c <= 90; c++) { // C..Z
      const d = String.fromCharCode(c) + ':\\';
      try { if (fs.existsSync(d)) out.push(d); } catch { /* ignore */ }
    }
    return out;
  }
  const out = ['/'];
  try {
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const [, mnt, type] = line.split(' ');
      if (!mnt || !REAL_FS.has(type)) continue;
      const m = mnt.replace(/\\040/g, ' ');
      // removable disks and extra drives, not the system's own mounts (/boot, /var, snaps…)
      // (WSL keeps its own plumbing under /mnt/wsl and /mnt/wslg; its Windows drives are /mnt/c and so on)
      if (/^\/mnt\/wslg?(\/|$)/.test(m)) continue;
      if (/^\/(media|run\/media|mnt)\//.test(m) || /^\/(home|data|srv)$/.test(m)) if (!out.includes(m)) out.push(m);
    }
  } catch { /* no /proc (macOS): just / */ }
  if (IS_MAC) try { for (const v of fs.readdirSync('/Volumes')) out.push(path.join('/Volumes', v)); } catch { /* ignore */ }
  return out;
}

// ---------------------------------------------------------------------------------------------------- show in folder

/**
 * Opens the file manager with a file selected (or a folder opened). Explorer only understands /select,"C:\path"
 * with the quotes around the path alone, so the command line is built by hand: Node's own quoting wraps the whole
 * argument and Explorer then gives up and shows Documents. On Linux the freedesktop FileManager1 call selects the
 * file in whichever file manager is running (Nautilus, Dolphin, Nemo, Thunar, Caja…); without it, the folder opens.
 */
function reveal(target, { select = true } = {}) {
  const clean = String(target).replace(/"/g, '');
  const exists = fs.existsSync(clean);
  if (IS_WIN) {
    const arg = select && exists ? `/select,"${clean}"` : `"${exists ? clean : path.dirname(clean)}"`;
    spawn('explorer.exe', [arg], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    return;
  }
  if (IS_MAC) {
    spawn('open', select && exists ? ['-R', clean] : [exists ? clean : path.dirname(clean)], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const folder = () => spawn('xdg-open', [select || !exists ? path.dirname(clean) : clean], { detached: true, stdio: 'ignore' }).unref();
  if (!select || !exists || !which('dbus-send')) return folder();
  const uri = 'file://' + clean.split('/').map(encodeURIComponent).join('/');
  run('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
    'org.freedesktop.FileManager1.ShowItems', `array:string:${uri}`, 'string:'], { timeout: 5000 })
    .then((r) => { if (r.code !== 0) folder(); }, folder);
}

/** Opens a file or link with the system's default program. */
function openExternal(target) {
  if (IS_WIN) spawn('rundll32.exe', ['url.dll,FileProtocolHandler', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(IS_MAC ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
}

// ---------------------------------------------------------------------------------------------------- recycle bin / trash

const trashStamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** The freedesktop trash spec by hand: $XDG_DATA_HOME/Trash, or <disk>/.Trash-<uid> for files on another disk. */
async function specTrash(target) {
  const home = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'Trash');
  const sameDisk = (a, b) => { try { return fs.statSync(a).dev === fs.statSync(b).dev; } catch { return false; } };
  let dir = home;
  if (!sameDisk(path.dirname(target), path.dirname(home)) && !sameDisk(path.dirname(target), os.homedir())) {
    // the top of target's disk: walk up while the device stays the same
    let top = path.dirname(target);
    const dev = fs.statSync(top).dev;
    while (path.dirname(top) !== top && fs.statSync(path.dirname(top)).dev === dev) top = path.dirname(top);
    dir = path.join(top, `.Trash-${process.getuid ? process.getuid() : 0}`);
  }
  const files = path.join(dir, 'files'), info = path.join(dir, 'info');
  await fsp.mkdir(files, { recursive: true, mode: 0o700 });
  await fsp.mkdir(info, { recursive: true, mode: 0o700 });
  const base = path.basename(target), ext = path.extname(base), stem = ext ? base.slice(0, -ext.length) : base;
  for (let n = 1; n < 10000; n++) {
    const name = n === 1 ? base : `${stem}.${n}${ext}`;
    const infoFile = path.join(info, name + '.trashinfo');
    let fd;
    try { fd = await fsp.open(infoFile, 'wx'); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    const rel = dir === home ? target : path.relative(path.dirname(dir), target);
    await fd.writeFile(`[Trash Info]\nPath=${rel.split('/').map(encodeURIComponent).join('/')}\nDeletionDate=${trashStamp()}\n`);
    await fd.close();
    try { await fsp.rename(target, path.join(files, name)); } catch (e) { await fsp.rm(infoFile, { force: true }); throw e; }
    return;
  }
  throw fail('The trash is too full of files with this name');
}

/**
 * Moves a file or folder to the recycle bin / trash, never deletes it outright. Linux: gio (GNOME, Xfce, Cinnamon,
 * MATE, most others), then kioclient (KDE), then trash-cli, then the freedesktop spec by hand.
 */
async function trash(target) {
  if (IS_WIN) {
    const isDir = fs.statSync(target).isDirectory();
    const r = await powershell(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${isDir ? 'DeleteDirectory' : 'DeleteFile'}(${psQuote(target)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`);
    if (r.code !== 0) throw fail(r.stderr.trim().split('\n')[0] || 'Could not move it to the Recycle Bin');
    return;
  }
  if (IS_MAC) {
    const r = await run('osascript', ['-e', `tell application "Finder" to delete POSIX file ${JSON.stringify(target)}`]);
    if (r.code !== 0) throw fail('Could not move it to the Trash');
    return;
  }
  for (const [cmd, args] of [['gio', ['trash', '--', target]], ['kioclient6', ['move', target, 'trash:/']], ['kioclient5', ['move', target, 'trash:/']], ['trash-put', ['--', target]]]) {
    if (!which(cmd)) continue;
    try { const r = await run(cmd, args); if (r.code === 0 && !fs.existsSync(target)) return; } catch { /* try the next one */ }
  }
  await specTrash(target);
}

// ---------------------------------------------------------------------------------------------------- a file on the clipboard

/** Puts a file on the clipboard as a file (like Ctrl+C in the file manager), so it pastes into folders, chats, email. */
async function copyFileToClipboard(full) {
  if (IS_WIN) {
    const r = await powershell(`Set-Clipboard -LiteralPath ${psQuote(full)}`, { timeout: 15000 });
    if (r.code !== 0) throw fail('Could not copy the file');
    return;
  }
  const uri = 'file://' + full.split('/').map(encodeURIComponent).join('/');
  const tools = process.env.WAYLAND_DISPLAY
    ? [['wl-copy', ['--type', 'text/uri-list']], ['xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-i']]]
    : [['xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-i']], ['wl-copy', ['--type', 'text/uri-list']]];
  for (const [cmd, args] of tools) {
    if (!which(cmd)) continue;
    // xclip and wl-copy stay running to serve the clipboard, so don't wait for them to exit
    const child = spawn(cmd, args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => {});
    child.stdin.end(uri + '\r\n');
    child.unref();
    return;
  }
  throw fail(IS_MAC ? 'Copying files isn’t available on macOS yet' : 'Copying files needs wl-clipboard or xclip (e.g. sudo apt install wl-clipboard xclip)', 501);
}

// ---------------------------------------------------------------------------------------------------- open / save dialogs

function winFilter(filters) {
  if (!Array.isArray(filters) || !filters.length) return 'All files (*.*)|*.*';
  return filters.map((f) => {
    const pats = (f.extensions || ['*']).map((e) => (e === '*' ? '*.*' : '*.' + e)).join(';');
    return `${f.name} (${pats})|${pats}`;
  }).join('|');
}

async function winDialog(opts) {
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
    s += `$d.Filter = ${psQuote(winFilter(opts.filters))}\n$d.FilterIndex = ${Number(opts.filterIndex) || 1}\n`;
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

  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(s, 'utf16le').toString('base64')],
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

/** zenity (GTK desktops) or kdialog (KDE). The save dialog's file type comes from the name's extension. */
async function linuxDialog(opts) {
  const kind = opts.kind;
  const filters = Array.isArray(opts.filters) ? opts.filters : [];
  const dir = opts.initialDir && fs.existsSync(opts.initialDir) ? opts.initialDir : os.homedir();
  const start = kind === 'save' && opts.defaultName ? path.join(dir, opts.defaultName) : dir + '/';
  const kde = /kde/i.test(process.env.XDG_CURRENT_DESKTOP || '') && which('kdialog');
  let cmd, args;
  if (!kde && which('zenity')) {
    cmd = 'zenity';
    args = ['--file-selection', `--title=${opts.title || (kind === 'save' ? 'Save as' : kind === 'folder' ? 'Choose a folder' : 'Open')}`, `--filename=${start}`];
    if (kind === 'open' && opts.multi) args.push('--multiple', '--separator=\n');
    if (kind === 'save') args.push('--save', '--confirm-overwrite');
    if (kind === 'folder') args.push('--directory');
    if (kind !== 'folder') for (const f of filters) args.push(`--file-filter=${f.name} | ${(f.extensions || ['*']).map((e) => (e === '*' ? '*' : '*.' + e)).join(' ')}`);
  } else if (which('kdialog')) {
    cmd = 'kdialog';
    const filter = filters.map((f) => `${(f.extensions || ['*']).map((e) => (e === '*' ? '*' : '*.' + e)).join(' ')}|${f.name}`).join('\n');
    args = kind === 'folder' ? ['--getexistingdirectory', dir]
      : kind === 'save' ? ['--getsavefilename', start, filter]
        : ['--getopenfilename', dir, filter, ...(opts.multi ? ['--multiple', '--separate-output'] : [])];
    if (opts.title) args.push('--title', opts.title);
  } else return { unsupported: true };
  let r;
  try { r = await run(cmd, args, { timeout: 30 * 60 * 1000 }); } catch (e) { return { unsupported: true, error: e.message }; }
  const paths = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (r.code !== 0 || !paths.length) return { cancelled: true };
  if (kind !== 'save') return { paths };
  let file = paths[0];
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!ext && opts.defaultExt) file += '.' + opts.defaultExt;
  const filterIndex = Math.max(1, filters.findIndex((f) => (f.extensions || []).includes(ext || opts.defaultExt)) + 1);
  return { paths: [file], filterIndex };
}

/** Whether the server can show the system's own open/save dialogs (for a plain browser tab). */
const hasFileDialogs = () => IS_WIN || (!IS_MAC && !!(which('zenity') || which('kdialog')));

function fileDialog(opts = {}) {
  if (IS_WIN) return winDialog(opts);
  if (!IS_MAC) return linuxDialog(opts);
  return Promise.resolve({ unsupported: true });
}

// ---------------------------------------------------------------------------------------------------- installing tools

/** This Linux's package manager, from the first one found. */
function packageManager() {
  if (IS_WIN) return 'winget';
  if (IS_MAC) return 'brew';
  for (const pm of ['apt', 'dnf', 'pacman', 'zypper', 'apk', 'xbps-install', 'emerge']) if (which(pm)) return pm;
  return null;
}
const PACKAGE = { // what each package manager calls them
  winget: { 'yt-dlp': 'yt-dlp', ffmpeg: 'Gyan.FFmpeg' },
};
/** The command that installs a program by hand ("sudo apt install ffmpeg"), for notes and error messages. */
function installHint(name) {
  const pm = packageManager();
  const pkg = PACKAGE[pm]?.[name] || name;
  return {
    winget: `winget install ${pkg}`, brew: `brew install ${pkg}`, apt: `sudo apt install ${pkg}`, dnf: `sudo dnf install ${pkg}`,
    pacman: `sudo pacman -S ${pkg}`, zypper: `sudo zypper install ${pkg}`, apk: `sudo apk add ${pkg}`, 'xbps-install': `sudo xbps-install ${pkg}`,
    emerge: `sudo emerge ${pkg}`,
  }[pm] || `install ${pkg} with your package manager`;
}

// ---------------------------------------------------------------------------------------------------- sound

/** Linux: the name of the speakers everything plays on, as PulseAudio / PipeWire (and so Chromium's device list)
 *  call them, or null. BoxTunnel records system sound from their "Monitor of …" input. */
async function defaultSpeakers() {
  if (IS_WIN || IS_MAC || !which('pactl')) return null;
  const opts = { timeout: 5000, env: { ...process.env, LC_ALL: 'C' } }; // pactl's labels are translated otherwise
  const out = async (...args) => (await run('pactl', args, opts).catch(() => null))?.stdout || '';
  // older pactl has no get-default-sink; its "info" says it
  const name = (await out('get-default-sink')).trim() || /Default Sink:\s*(.+)/.exec(await out('info'))?.[1].trim();
  if (!name) return null;
  for (const block of (await out('list', 'sinks')).split(/\n(?=Sink #)/)) {
    if (block.split('\n').some((l) => l.trim() === `Name: ${name}`)) return /Description:\s*(.+)/.exec(block)?.[1].trim() || null;
  }
  return null;
}

// Chromium leaves PulseAudio/PipeWire "Monitor of …" inputs out of its device list, so system sound comes through
// a plain input that copies the speakers' monitor (module-remap-source). It lasts until the app quits.
const SYSTEM_SOURCE = 'bds_system_sound';
const SYSTEM_LABEL = 'Box-Deckspitter-system-sound'; // no spaces: PulseAudio won't load the module with them
let systemModule = null;
async function systemSoundSource() {
  if (IS_WIN || IS_MAC || !which('pactl')) return null;
  const opts = { timeout: 5000, env: { ...process.env, LC_ALL: 'C' } };
  const out = async (...args) => (await run('pactl', args, opts).catch(() => null))?.stdout || '';
  const sink = (await out('get-default-sink')).trim() || /Default Sink:\s*(.+)/.exec(await out('info'))?.[1].trim();
  if (!sink) return null;
  const master = `${sink}.monitor`;
  for (const line of (await out('list', 'short', 'modules')).split('\n')) {
    const [id, mod, args = ''] = line.split('\t');
    if (mod !== 'module-remap-source' || !args.includes(`source_name=${SYSTEM_SOURCE}`)) continue;
    if (args.includes(`master=${master} `) || args.endsWith(`master=${master}`)) { systemModule = id; return SYSTEM_LABEL; }
    await out('unload-module', id); // the default speakers changed
  }
  const id = (await out('load-module', 'module-remap-source', `master=${master}`, `source_name=${SYSTEM_SOURCE}`,
    `source_properties=device.description=${SYSTEM_LABEL}`)).trim();
  if (!/^\d+$/.test(id)) return null;
  systemModule = id;
  return SYSTEM_LABEL;
}
process.on('exit', () => {
  if (!systemModule) return;
  try { require('child_process').execFileSync('pactl', ['unload-module', systemModule], { timeout: 3000, stdio: 'ignore' }); } catch { /* gone already */ }
});

// ---------------------------------------------------------------------------------------------------- networks

/** What the system knows about each connected network, for BoxComms's "is this a home network?" check:
 *  { [adapter name]: { profile, category: 'private' | 'public' | 'domain' | 'unknown', vpn } }. Windows says whether
 *  you marked a network private or public; NetworkManager only knows its name and whether it's a VPN. */
async function networkProfiles() {
  const out = {};
  try {
    if (IS_WIN) {
      const r = await powershell('Get-NetConnectionProfile | Select-Object InterfaceAlias, Name, @{n="Category";e={[string]$_.NetworkCategory}} | ConvertTo-Json -Compress', { timeout: 15000 });
      const list = JSON.parse(r.stdout.trim() || '[]');
      for (const n of Array.isArray(list) ? list : [list]) {
        const cat = String(n.Category || '').toLowerCase();
        out[n.InterfaceAlias] = { profile: String(n.Name || ''), category: cat.startsWith('domain') ? 'domain' : cat === 'private' || cat === 'public' ? cat : 'unknown', vpn: false };
      }
    } else if (which('nmcli')) {
      const r = await run('nmcli', ['-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show', '--active'], { timeout: 10000 });
      for (const line of r.stdout.split('\n').filter(Boolean)) {
        const [name, type, dev] = line.split(/(?<!\\):/).map((x) => x.replace(/\\:/g, ':'));
        if (dev) out[dev] = { profile: name, category: 'unknown', vpn: /vpn|wireguard|tun/.test(type) };
      }
    }
  } catch { /* nothing known: every network counts as unrecognised */ }
  return out;
}

module.exports = {
  IS_WIN, IS_MAC, which, psQuote, listDrives, reveal, openExternal, trash, copyFileToClipboard, fileDialog, hasFileDialogs, installHint,
  defaultSpeakers, systemSoundSource, SYSTEM_LABEL, networkProfiles,
};
