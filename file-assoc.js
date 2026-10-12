// Windows file associations for Box-DocSpitter (per user, HKCU only: no admin rights, fully removable).
//
// Since Windows 10, apps can't make themselves the default: they register as a *handler* and the user
// confirms the default in Settings. So this registers ProgIDs + OpenWithProgids + RegisteredApplications
// capabilities (which makes Box-DocSpitter show up in Settings → Default apps), and can open that page.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const APP = 'Box-DocSpitter';
const KEY = 'BoxDocSpitter';
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

module.exports = function createAssoc({ root, isWin, readJSONBody }) {
  const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const mainJs = path.join(root, 'electron', 'main.js');
  const vbs = path.join(root, `${APP}.vbs`);
  const icon = path.join(root, 'public', 'assets', 'icon.ico');

  /** The command Windows runs to open a file with Box-DocSpitter. */
  function openCommand() {
    if (fs.existsSync(electron)) return `"${electron}" "${mainJs}" "%1"`;
    return `"${path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe')}" "${vbs}" "%1"`;
  }

  async function status() {
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
    await runPs(removeScript + notifyScript);
    return status();
  }

  /** Opens Settings → Default apps on Box-DocSpitter's own page (Windows 11), or the general page. */
  function openDefaultApps() {
    const uri = `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(APP)}`;
    spawn('cmd.exe', ['/c', 'start', '', uri], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }

  const fail = (status, message) => Object.assign(new Error(message), { status });
  const needWin = () => { if (!isWin) throw fail(501, 'File associations are a Windows feature'); };

  return {
    'GET /api/system/associations': async () => status(),
    'POST /api/system/associations': async (req) => { needWin(); const { groups } = await readJSONBody(req); return register(groups || {}); },
    'POST /api/system/associations/remove': async () => { needWin(); return unregister(); },
    'POST /api/system/default-apps': async () => { needWin(); openDefaultApps(); return { ok: true }; },
  };
};
