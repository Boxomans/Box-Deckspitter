// Windows file associations for Box-Deckspitter (per user, HKCU only: no admin rights, fully removable).
// On Linux the same choices go the freedesktop way (see the end): a desktop entry listing the file types, and
// ~/.config/mimeapps.list making it their default (there an app may set that itself).
//
// Since Windows 10, apps can't make themselves the default: they register as a *handler* and the user
// confirms the default in Settings. So this registers ProgIDs + OpenWithProgids + RegisteredApplications
// capabilities (which makes Box-Deckspitter show up in Settings → Default apps), and can open that page.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const APP = 'Box-Deckspitter';
const LAUNCHER = 'Box-Deckspitter.exe';
const KEY = 'BoxDeckspitter';
const CAP = `HKCU:\\Software\\${KEY}\\Capabilities`;

// ProgID per kind of file: [suffix, friendly type name]
const KINDS = {
  pdf: ['PDF', 'PDF document'],
  doc: ['Document', 'Document'],
  text: ['Text', 'Text file'],
  config: ['Config', 'Config file'],
  sheet: ['Sheet', 'Spreadsheet'],
  code: ['Code', 'Source code file'],
  web: ['Web', 'Web page'],
  image: ['Image', 'Image'],
  video: ['Video', 'Video'],
  mail: ['Mail', 'Email message'],
  playlist: ['Playlist', 'Shared playlist'],
};

const EXT_RE = /^[a-z0-9]{1,12}$/;

// The script runs from a temporary .ps1 file: registering many file types makes a script far longer than
// Windows allows on a command line (that was "spawn ENAMETOOLONG"). UTF-8 with a BOM keeps non-English
// folder names intact in Windows PowerShell 5.
function runPs(script, timeout = 60000) {
  const file = path.join(os.tmpdir(), `bds-assoc-${crypto.randomBytes(6).toString('hex')}.ps1`);
  return new Promise((resolve, reject) => {
    try { fs.writeFileSync(file, '﻿' + script, 'utf8'); } catch (e) { reject(e); return; }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        fs.rm(file, { force: true }, () => {});
        if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')));
        else resolve(stdout);
      });
  });
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

module.exports = function createAssoc({ root, data, isWin, readJSONBody }) {
  const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const mainJs = path.join(root, 'electron', 'main.js');
  const launcher = path.join(root, LAUNCHER);
  const icon = path.join(root, 'public', 'assets', 'icon-lavender.ico');

  /** The command Windows runs to open a file with Box-Deckspitter. */
  function openCommand() {
    if (fs.existsSync(electron)) return `"${electron}" "${mainJs}" "%1"`;
    return `"${launcher}" "%1"`;
  }

  async function status() {
    if (linux) return linuxStatus();
    if (!isWin) return { supported: false, registered: {} };
    const out = await runPs(`
$r = @{}
$fa = Get-ItemProperty -Path '${CAP}\\FileAssociations' -ErrorAction SilentlyContinue
if ($fa) { foreach ($p in $fa.PSObject.Properties) { if ($p.Name -like '.*') { $r[$p.Name.Substring(1)] = $p.Value } } }
$cmd = (Get-ItemProperty -Path 'HKCU:\\Software\\Classes\\${KEY}.PDF\\shell\\open\\command' -ErrorAction SilentlyContinue).'(default)'
if (-not $cmd) { foreach ($k in Get-ChildItem 'HKCU:\\Software\\Classes' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -like '${KEY}.*' } | Select-Object -First 1) { $cmd = (Get-ItemProperty -Path ($k.PSPath + '\\shell\\open\\command') -ErrorAction SilentlyContinue).'(default)' } }
@{ registered = $r; command = $cmd } | ConvertTo-Json -Compress`);
    const j = JSON.parse(out.trim() || '{}');
    const registered = j.registered || {};
    return {
      supported: true,
      registered,
      count: Object.keys(registered).length,
      moved: !!(j.command && Object.keys(registered).length && j.command !== openCommand()),
      command: openCommand(),
    };
  }

  /** Remove everything this app registered (keeps whatever else the user has). */
  const removeScript = `
foreach ($k in Get-ChildItem 'HKCU:\\Software\\Classes' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -like '${KEY}.*' }) { Remove-Item -LiteralPath $k.PSPath -Recurse -Force -ErrorAction SilentlyContinue }
foreach ($k in Get-ChildItem 'HKCU:\\Software\\Classes' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -like '.*' }) {
  $owp = Join-Path $k.PSPath 'OpenWithProgids'
  if (Test-Path -LiteralPath $owp) {
    $props = (Get-ItemProperty -LiteralPath $owp).PSObject.Properties | Where-Object { $_.Name -like '${KEY}.*' }
    foreach ($p in $props) { Remove-ItemProperty -LiteralPath $owp -Name $p.Name -ErrorAction SilentlyContinue }
  }
}
Remove-Item -LiteralPath 'HKCU:\\Software\\${KEY}' -Recurse -Force -ErrorAction SilentlyContinue
Remove-ItemProperty -LiteralPath 'HKCU:\\Software\\RegisteredApplications' -Name '${APP}' -ErrorAction SilentlyContinue
$app = 'HKCU:\\Software\\Classes\\Applications\\electron.exe'
if ((Get-ItemProperty -LiteralPath $app -ErrorAction SilentlyContinue).FriendlyAppName -eq '${APP}') { Remove-Item -LiteralPath $app -Recurse -Force -ErrorAction SilentlyContinue }
`;

  // Tell Explorer that file associations changed so icons and "Open with" refresh.
  const notifyScript = `
Add-Type -Namespace BDS -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, System.IntPtr a, System.IntPtr b);'
[BDS.Shell]::SHChangeNotify(0x08000000, 0, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
`;

  /** @param {Record<string, string[]>} groups  kind → extensions */
  async function register(groups) {
    if (linux) return linuxRegister(groups);
    const cmd = openCommand();
    const lines = [removeScript, `
$cap = '${CAP}'
New-Item -Path "$cap\\FileAssociations" -Force | Out-Null
Set-ItemProperty -Path $cap -Name ApplicationName -Value ${q(APP)}
Set-ItemProperty -Path $cap -Name ApplicationDescription -Value 'Local documents, PDFs, forms, text and code - all on this PC.'
Set-ItemProperty -Path $cap -Name ApplicationIcon -Value ${q(icon + ',0')}
New-Item -Path 'HKCU:\\Software\\RegisteredApplications' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\RegisteredApplications' -Name ${q(APP)} -Value 'Software\\${KEY}\\Capabilities'
$app = 'HKCU:\\Software\\Classes\\Applications\\electron.exe'
New-Item -Path "$app\\shell\\open\\command" -Force | Out-Null
Set-ItemProperty -Path $app -Name FriendlyAppName -Value ${q(APP)}
Set-Item -Path "$app\\shell\\open\\command" -Value ${q(cmd)}
New-Item -Path "$app\\DefaultIcon" -Force | Out-Null
Set-Item -Path "$app\\DefaultIcon" -Value ${q(icon + ',0')}
New-Item -Path "$app\\SupportedTypes" -Force | Out-Null
`];
    let total = 0;
    for (const [kind, exts] of Object.entries(groups)) {
      if (!KINDS[kind]) continue;
      const clean = [...new Set((exts || []).map((e) => String(e).toLowerCase().replace(/^\./, '')).filter((e) => EXT_RE.test(e)))];
      if (!clean.length) continue;
      const [suffix, friendly] = KINDS[kind];
      const progId = `${KEY}.${suffix}`;
      lines.push(`
$prog = 'HKCU:\\Software\\Classes\\${progId}'
New-Item -Path "$prog\\shell\\open\\command" -Force | Out-Null
Set-Item -Path $prog -Value ${q(`${friendly} (${APP})`)}
Set-ItemProperty -Path $prog -Name FriendlyTypeName -Value ${q(`${friendly} (${APP})`)}
Set-Item -Path "$prog\\shell\\open\\command" -Value ${q(cmd)}
New-Item -Path "$prog\\DefaultIcon" -Force | Out-Null
Set-Item -Path "$prog\\DefaultIcon" -Value ${q(icon + ',0')}
`);
      for (const ext of clean) {
        total++;
        lines.push(`
New-Item -Path 'HKCU:\\Software\\Classes\\.${ext}\\OpenWithProgids' -Force | Out-Null
New-ItemProperty -Path 'HKCU:\\Software\\Classes\\.${ext}\\OpenWithProgids' -Name '${progId}' -Value '' -PropertyType String -Force | Out-Null
Set-ItemProperty -Path "$cap\\FileAssociations" -Name '.${ext}' -Value '${progId}'
New-ItemProperty -Path "$app\\SupportedTypes" -Name '.${ext}' -Value '' -PropertyType String -Force | Out-Null
`);
      }
    }
    if (!total) throw Object.assign(new Error('Pick at least one file type'), { status: 400 });
    lines.push(notifyScript);
    await runPs(lines.join('\n'), 120000);
    return status();
  }

  async function unregister() {
    if (linux) return linuxUnregister();
    await runPs(removeScript + notifyScript);
    return status();
  }

  /** Opens Settings → Default apps on Box-Deckspitter's own page (Windows 11), or the general page. */
  function openDefaultApps() {
    const uri = `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(APP)}`;
    spawn('cmd.exe', ['/c', 'start', '', uri], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }

  const fail = (status, message) => Object.assign(new Error(message), { status });
  const needWin = () => { if (!isWin) throw fail(501, 'File associations are a Windows feature'); };
  const needSupport = () => { if (!isWin && !linux) throw fail(501, 'File associations aren’t available on this system'); };

  // ---------------------------------------------------------------- Linux (freedesktop)
  const linux = process.platform === 'linux';
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const mimeappsFile = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'mimeapps.list');
  // one entry per copy of the app, so each knows which types are its own
  const desktopName = `box-deckspitter-files-${crypto.createHash('sha1').update(root).digest('hex').slice(0, 8)}.desktop`;
  const desktopFile = path.join(dataHome, 'applications', desktopName);
  const mimeXml = path.join(dataHome, 'mime', 'packages', 'box-deckspitter.xml');
  const PLYLST = 'application/x-box-deckspitter-playlist';
  // extension → its MIME types (shared-mime-info names; a few have an older name too). Ones Linux has no type for,
  // or that would clash (.ts is also a video type), aren't set.
  const MIMES = {
    pdf: ['application/pdf'], docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], doc: ['application/msword'],
    odt: ['application/vnd.oasis.opendocument.text'], rtf: ['application/rtf', 'text/rtf'], txt: ['text/plain'], log: ['text/x-log'],
    md: ['text/markdown', 'text/x-markdown'], markdown: ['text/markdown', 'text/x-markdown'], json: ['application/json'],
    yaml: ['application/yaml', 'application/x-yaml'], yml: ['application/yaml', 'application/x-yaml'], toml: ['application/toml'], xml: ['application/xml', 'text/xml'],
    xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], xls: ['application/vnd.ms-excel'],
    ods: ['application/vnd.oasis.opendocument.spreadsheet'], csv: ['text/csv'], tsv: ['text/tab-separated-values'], eml: ['message/rfc822'],
    plylst: [PLYLST], js: ['text/javascript', 'application/javascript'], py: ['text/x-python3', 'text/x-python'], sh: ['application/x-shellscript'],
    css: ['text/css'], lua: ['text/x-lua'], sql: ['application/sql'], html: ['text/html'], htm: ['text/html'],
    png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'], gif: ['image/gif'], webp: ['image/webp'], bmp: ['image/bmp'],
    mp4: ['video/mp4'], mkv: ['video/x-matroska'], webm: ['video/webm'], mov: ['video/quicktime'], avi: ['video/x-msvideo'],
  };
  const ALL_MIMES = [...new Set(Object.values(MIMES).flat())];
  // update-mime-database and friends are optional: the files are what counts
  const tool = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 60000 }, () => resolve()));

  /** mimeapps.list as [{ name, lines }] sections (lines before the first section are in the one named ''). */
  function readMimeapps() {
    let text = '';
    try { text = fs.readFileSync(mimeappsFile, 'utf8'); } catch { /* none yet */ }
    const out = [{ name: '', lines: [] }];
    for (const l of text.split(/\r?\n/)) {
      const m = /^\[(.+)\]\s*$/.exec(l);
      if (m) out.push({ name: m[1], lines: [] }); else out[out.length - 1].lines.push(l);
    }
    return out;
  }
  const entriesOf = (sec) => new Map((sec?.lines || []).map((l) => /^([^#=\s][^=]*?)\s*=\s*(.*)$/.exec(l)).filter(Boolean)
    .map((m) => [m[1], m[2].split(';').map((x) => x.trim()).filter(Boolean)]));
  /** Changes the app lists of our MIME types in these sections: fn(section, mime, apps) → the new list (empty drops it).
   *  Every other line stays as it was. */
  function editMimeapps(names, fn) {
    const sections = readMimeapps();
    for (const name of names) {
      let sec = sections.find((s) => s.name === name);
      if (!sec) sections.push(sec = { name, lines: [] });
      const map = entriesOf(sec);
      const lines = [];
      const done = new Set();
      for (const l of sec.lines) {
        const m = /^([^#=\s][^=]*?)\s*=/.exec(l);
        if (!m || !ALL_MIMES.includes(m[1])) { if (l.trim()) lines.push(l); continue; }
        done.add(m[1]);
        const apps = fn(name, m[1], map.get(m[1]) || []);
        if (apps.length) lines.push(`${m[1]}=${apps.join(';')};`);
      }
      for (const mime of ALL_MIMES) {
        if (done.has(mime)) continue;
        const apps = fn(name, mime, []);
        if (apps.length) lines.push(`${mime}=${apps.join(';')};`);
      }
      sec.lines = [...lines, ''];
    }
    const text = sections.filter((s) => s.name || s.lines.some((l) => l.trim()))
      .map((s) => (s.name ? [`[${s.name}]`, ...s.lines] : s.lines).join('\n')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    fs.mkdirSync(path.dirname(mimeappsFile), { recursive: true });
    fs.writeFileSync(mimeappsFile, text + '\n');
  }

  function linuxStatus() {
    const defaults = entriesOf(readMimeapps().find((s) => s.name === 'Default Applications'));
    const registered = {};
    for (const [ext, mimes] of Object.entries(MIMES)) if (defaults.get(mimes[0])?.[0] === desktopName) registered[ext] = true;
    const count = Object.keys(registered).length;
    let moved = false;
    try { moved = count > 0 && !fs.readFileSync(desktopFile, 'utf8').includes(`Path=${root}\n`); } catch { moved = count > 0; }
    return { supported: true, linux: true, registered, count, moved, exts: Object.keys(MIMES) };
  }

  async function linuxRegister(groups) {
    const exts = new Set();
    for (const [kind, list] of Object.entries(groups || {})) {
      if (!KINDS[kind]) continue;
      for (const e of list || []) { const x = String(e).toLowerCase().replace(/^\./, ''); if (MIMES[x]) exts.add(x); }
    }
    if (!exts.size) throw fail(400, 'Pick at least one file type');
    const mimes = new Set([...exts].flatMap((e) => MIMES[e]));
    // Linux doesn't know .plylst: a type for shared playlists
    if (mimes.has(PLYLST)) {
      fs.mkdirSync(path.dirname(mimeXml), { recursive: true });
      fs.writeFileSync(mimeXml, ['<?xml version="1.0" encoding="UTF-8"?>', '<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">',
        `  <mime-type type="${PLYLST}">`, '    <comment>Shared playlist</comment>', '    <glob pattern="*.plylst"/>', '  </mime-type>', '</mime-info>', ''].join('\n'));
      await tool('update-mime-database', [path.join(dataHome, 'mime')]);
    }
    const dq = (v) => `"${v.replace(/(["`$\\])/g, '\\$1')}"`; // the desktop entry spec's quoting
    fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
    fs.writeFileSync(desktopFile, ['[Desktop Entry]', 'Type=Application', `Name=${APP}`, 'Comment=Open with Box-Deckspitter',
      `Exec=sh ${dq(path.join(root, 'Box-Deckspitter.sh'))} %F`, `Path=${root}`, `Icon=${path.join(root, 'public', 'assets', 'icon-256.png')}`,
      'Terminal=false', 'NoDisplay=true', `MimeType=${[...mimes].join(';')};`, 'StartupWMClass=Box-Deckspitter', ''].join('\n'), { mode: 0o755 });
    // the default for the ticked types, and in "Open with" for them; off the ones no longer ticked
    editMimeapps(['Default Applications', 'Added Associations'], (sec, mime, apps) => {
      const rest = apps.filter((a) => a !== desktopName);
      if (!mimes.has(mime)) return rest;
      return sec === 'Default Applications' ? [desktopName, ...rest] : [...rest, desktopName];
    });
    await tool('update-desktop-database', [path.dirname(desktopFile)]);
    return linuxStatus();
  }

  async function linuxUnregister() {
    editMimeapps(['Default Applications', 'Added Associations'], (sec, mime, apps) => apps.filter((a) => a !== desktopName));
    for (const f of [desktopFile, mimeXml]) { try { fs.unlinkSync(f); } catch { /* not there */ } }
    await tool('update-mime-database', [path.join(dataHome, 'mime')]);
    await tool('update-desktop-database', [path.dirname(desktopFile)]);
    return linuxStatus();
  }

  return {
    'GET /api/system/associations': async () => status(),
    'POST /api/system/associations': async (req) => { needSupport(); const { groups } = await readJSONBody(req); return register(groups || {}); },
    'POST /api/system/associations/remove': async () => { needSupport(); return unregister(); },
    'POST /api/system/default-apps': async () => { needWin(); openDefaultApps(); return { ok: true }; },
  };
};
