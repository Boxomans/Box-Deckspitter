// BoxTerminal server side: shell sessions you drive from the app. Each session is one long-lived shell
// (PowerShell, PowerShell 7, cmd, or bash elsewhere) started in a folder you pick; the page sends a command, and
// polls for the output. A marker line after each command says when it finished and where the shell ended up, so
// `cd`, variables and the rest carry over between commands. There's no pseudo-terminal, so full-screen programs
// (vim, less, anything that waits for a key) aren't supported; everything else works.
// The API is behind the per-launch token like everything else, and it only runs what the person at the page types.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const err = (status, message) => Object.assign(new Error(message), { status });
const IS_WIN = process.platform === 'win32';
const MARK = /<<BDS:([0-9a-f]+):(.*?)>>/;
const MAX_CHUNKS = 30000;

module.exports = function createTerminal({ requirePath, readJSONBody, findExe }) {
  const sessions = new Map();

  const shells = () => {
    const out = [];
    if (IS_WIN) {
      out.push({ id: 'powershell', name: 'Windows PowerShell' });
      if (findExe?.('pwsh')) out.push({ id: 'pwsh', name: 'PowerShell 7' });
      out.push({ id: 'cmd', name: 'Command Prompt' });
    } else {
      out.push({ id: 'bash', name: 'bash' });
      if (findExe?.('pwsh')) out.push({ id: 'pwsh', name: 'PowerShell 7' });
    }
    return out;
  };

  function launch(s) {
    let cmd, args;
    if (s.shell === 'cmd') { cmd = 'cmd.exe'; args = ['/Q', '/D', '/K']; }
    else if (s.shell === 'bash') { cmd = 'bash'; args = ['--noprofile', '--norc']; }
    else {
      cmd = s.shell === 'pwsh' ? (findExe?.('pwsh') || 'pwsh') : 'powershell.exe';
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', ...(IS_WIN ? ['-ExecutionPolicy', 'Bypass'] : []), '-Command', '-'];
    }
    const p = spawn(cmd, args, { cwd: s.cwd, windowsHide: true, env: { ...process.env, TERM: 'dumb' } });
    s.proc = p;
    s.partial = '';
    const feed = (kind) => (d) => {
      let t = d.toString('utf8');
      if (kind === 'out') {
        t = s.partial + t;
        const lines = t.split('\n');
        s.partial = lines.pop();
        let text = '';
        for (const line of lines) {
          const m = MARK.exec(line);
          if (m) {
            if (text) { push(s, 'out', text); text = ''; }
            s.cwd = m[2].replace(/\r$/, '') || s.cwd;
            s.busy = false;
            push(s, 'done', '', { cwd: s.cwd });
          } else text += `${line}\n`;
        }
        if (text) push(s, 'out', text);
        // a half line (a prompt, progress text) is shown after a short wait instead of being held back
        clearTimeout(s.flush);
        if (s.partial && !s.partial.startsWith('<<')) s.flush = setTimeout(() => { if (s.partial && !s.partial.startsWith('<<')) { push(s, 'out', s.partial); s.partial = ''; } }, 150);
      } else push(s, 'err', t);
    };
    p.stdout.on('data', feed('out'));
    p.stderr.on('data', feed('err'));
    p.on('error', (e) => { push(s, 'err', `Couldn’t start ${cmd}: ${e.message}\n`); s.busy = false; push(s, 'done', '', { cwd: s.cwd }); });
    p.on('close', () => { if (s.proc === p) { s.dead = true; s.busy = false; push(s, 'exit', ''); } });
    p.stdin.on('error', () => {});
    if (s.shell === 'powershell' || s.shell === 'pwsh') p.stdin.write('[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;$ProgressPreference="SilentlyContinue"\n');
    if (s.shell === 'cmd') p.stdin.write('chcp 65001 >nul\n');
  }

  function push(s, k, t, extra) {
    s.chunks.push({ k, t, ...extra });
    if (s.chunks.length > MAX_CHUNKS) { const cut = s.chunks.length - MAX_CHUNKS; s.chunks.splice(0, cut); s.base += cut; }
  }

  const marker = (s, id) => (s.shell === 'cmd' ? `\r\n@echo <<BDS:${id}:%CD%>>\r\n`
    : s.shell === 'bash' ? `\necho "<<BDS:${id}:$PWD>>"\n`
      : `\n[Console]::Out.WriteLine("<<BDS:${id}:$((Get-Location).Path)>>")\n`);

  function kill(s) {
    const p = s.proc;
    s.proc = null;
    if (!p || p.exitCode != null) return;
    try {
      if (IS_WIN) execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else p.kill('SIGKILL');
    } catch { /* already gone */ }
  }
  process.on('exit', () => { for (const s of sessions.values()) { try { s.proc?.kill(); } catch { /* ignore */ } } });

  const get = (id) => { const s = sessions.get(id); if (!s) throw err(404, 'That terminal isn’t running any more'); return s; };

  async function dirOf(p) {
    const dir = p ? requirePath(p) : os.homedir();
    const st = await fsp.stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw err(400, `${dir} isn’t a folder`);
    return dir;
  }

  async function completePS(s, line, pos) {
    const script = '$r=[System.Management.Automation.CommandCompletion]::CompleteInput($env:BDS_LINE,[int]$env:BDS_POS,$null);'
      + "[pscustomobject]@{from=$r.ReplacementIndex;len=$r.ReplacementLength;items=@($r.CompletionMatches|Select-Object -First 80|ForEach-Object{[pscustomobject]@{t=$_.CompletionText;l=$_.ListItemText;k=[string]$_.ResultType}})}|ConvertTo-Json -Compress -Depth 4";
    const exe = s.shell === 'pwsh' ? (findExe?.('pwsh') || 'pwsh') : 'powershell.exe';
    return new Promise((resolve) => {
      execFile(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8;${script}`],
        { cwd: s.cwd, env: { ...process.env, BDS_LINE: line, BDS_POS: String(pos) }, windowsHide: true, timeout: 8000 }, (e, out) => {
          try { const j = JSON.parse(out); resolve({ from: j.from, len: j.len, items: [].concat(j.items || []) }); } catch { resolve({ from: pos, len: 0, items: [] }); }
        });
    });
  }

  async function completePath(s, line, pos) {
    const head = line.slice(0, pos);
    const m = /(?:"([^"]*)|(\S*))$/.exec(head);
    const word = m[1] ?? m[2] ?? '';
    const from = pos - word.length;
    const sep = word.lastIndexOf(IS_WIN ? '\\' : '/');
    const altSep = IS_WIN ? word.lastIndexOf('/') : -1;
    const cut = Math.max(sep, altSep);
    const dirPart = word.slice(0, cut + 1), base = word.slice(cut + 1).toLowerCase();
    const dir = path.resolve(s.cwd, dirPart || '.');
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { /* not a folder */ }
    const items = ents.filter((e) => e.name.toLowerCase().startsWith(base)).sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 80)
      .map((e) => { const t = dirPart + e.name + (e.isDirectory() ? (IS_WIN ? '\\' : '/') : ''); return { t: /\s/.test(t) ? `"${t}"` : t, l: e.name, k: e.isDirectory() ? 'ProviderContainer' : 'ProviderItem' }; });
    return { from: m[1] != null ? from - 1 : from, len: word.length + (m[1] != null ? 1 : 0), items };
  }

  return {
    'GET /api/term/shells': async () => ({ shells: shells(), home: os.homedir(), win: IS_WIN }),

    'POST /api/term/start': async (req) => {
      const { cwd, shell } = await readJSONBody(req);
      if (sessions.size >= 12) throw err(400, 'Too many terminals are open');
      const kind = shells().find((x) => x.id === shell)?.id || shells()[0].id;
      const s = { id: crypto.randomBytes(6).toString('hex'), shell: kind, cwd: await dirOf(cwd), chunks: [], base: 0, busy: false, dead: false, n: 0 };
      sessions.set(s.id, s);
      launch(s);
      return { id: s.id, shell: kind, cwd: s.cwd };
    },

    'POST /api/term/send': async (req) => {
      const { id, cmd } = await readJSONBody(req);
      const s = get(id);
      if (s.dead || !s.proc) { s.dead = false; launch(s); }
      if (s.busy) throw err(409, 'Still running the last command');
      s.busy = true;
      const cid = (++s.n).toString(16);
      s.proc.stdin.write(String(cmd ?? '').replace(/\r?\n$/, '') + marker(s, cid));
      return { ok: true };
    },

    'GET /api/term/read': async (req, q) => {
      const s = get(q.get('id'));
      const from = Math.max(s.base, +q.get('from') || 0);
      return { chunks: s.chunks.slice(from - s.base), next: s.base + s.chunks.length, cwd: s.cwd, busy: s.busy, dead: s.dead, shell: s.shell };
    },

    // stop whatever is running: the shell is killed and a fresh one starts in the same folder (variables are lost)
    'POST /api/term/interrupt': async (req) => {
      const s = get((await readJSONBody(req)).id);
      kill(s);
      push(s, 'err', '^C\n');
      s.busy = false; s.dead = false; s.partial = '';
      launch(s);
      push(s, 'note', 'Stopped. A fresh shell started in the same folder (variables from before are gone).\n');
      push(s, 'done', '', { cwd: s.cwd });
      return { ok: true };
    },

    'POST /api/term/cd': async (req) => {
      const { id, dir } = await readJSONBody(req);
      const s = get(id);
      const d = await dirOf(dir);
      if (s.busy) throw err(409, 'Still running a command');
      s.busy = true;
      const cid = (++s.n).toString(16);
      s.proc.stdin.write((s.shell === 'cmd' ? `cd /d "${d}"` : s.shell === 'bash' ? `cd '${d.replace(/'/g, "'\\''")}'` : `Set-Location -LiteralPath '${d.replace(/'/g, "''")}'`) + marker(s, cid));
      return { ok: true };
    },

    'POST /api/term/complete': async (req) => {
      const { id, line, pos } = await readJSONBody(req);
      const s = get(id);
      const p = Math.max(0, Math.min(String(line).length, +pos || 0));
      const first = (s.shell === 'powershell' || s.shell === 'pwsh') ? await completePS(s, String(line), p) : null;
      return first && first.items.length ? first : completePath(s, String(line), p);
    },

    'POST /api/term/close': async (req) => {
      const { id } = await readJSONBody(req);
      const s = sessions.get(id);
      if (s) { kill(s); sessions.delete(id); }
      return { ok: true };
    },
  };
};
