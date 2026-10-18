// BoxLog server side: finds log files on the PC (Windows' own, apps', and video games' from Steam, Epic, Unity,
// Unreal, Minecraft and the usual launchers), reads and tails them, and reads Windows event logs. Read-only:
// nothing here changes a log. Folders you add yourself are kept in data/log-sources.json.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const err = (status, message) => Object.assign(new Error(message), { status });
const IS_WIN = process.platform === 'win32';
const SKIP_DIR = /^(node_modules|\.git|cache|gpucache|code cache|crashpad|service worker|indexeddb|local storage|shadercache|dawncache|packages|webcache|blob_storage|sessions|session storage|extensions|\$recycle\.bin)$/i;
const LOG_NAME = /(\.(log|out)(\.\d+)?|\.log\.txt|_log\.txt|^output_log\.txt|^latest\.log|^console\.log|^debug\.log)$/i;
const MAX_READ = 8 * 1024 * 1024;

module.exports = function createLog({ requirePath, readJSONBody, readJSON, writeJSON, dataFile, extraDirs = [] }) {
  let cache = null; // { at, files }
  let eventLogs = null;

  // database journals (LevelDB's 000123.log and friends) share the extension but aren't text
  const NOT_TEXT = /^(\d{5,}\.log|LOG|LOG\.old|MANIFEST.*|CURRENT)$|[\\/](leveldb|databases|sentry)[\\/]|\.ldb[\\/]/i;
  const acceptable = (name, full) => !NOT_TEXT.test(name) && !NOT_TEXT.test(full) && (LOG_NAME.test(name) || (/\.txt$/i.test(name) && /[\\/]logs?[\\/]/i.test(full)));

  /** Walk a folder for log files, shallowly, within a time budget. */
  async function walk(root, maxDepth, sinceMs, deadline, out, tag) {
    const stack = [[root, 0]];
    while (stack.length && Date.now() < deadline && out.length < 3000) {
      const [dir, depth] = stack.pop();
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < maxDepth && !SKIP_DIR.test(e.name)) stack.push([full, depth + 1]);
        } else if (e.isFile() && acceptable(e.name, full)) {
          try {
            const st = await fsp.stat(full);
            if (st.size > 0 && st.mtimeMs >= sinceMs) out.push({ path: full, name: e.name, size: st.size, mtime: st.mtimeMs, group: tag.group, sub: tag.sub(full, root) });
          } catch { /* gone or locked */ }
        }
      }
    }
  }

  async function steamLibraries() {
    const libs = new Set();
    const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean).map((p) => path.join(p, 'Steam'));
    for (const b of bases) {
      if (!fs.existsSync(b)) continue;
      libs.add(b);
      try {
        const vdf = await fsp.readFile(path.join(b, 'steamapps', 'libraryfolders.vdf'), 'utf8');
        for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
      } catch { /* no library list */ }
    }
    return [...libs];
  }

  async function roots() {
    const E = process.env, home = os.homedir();
    const R = [];
    const first = (full, root) => path.relative(root, full).split(path.sep)[0];
    const second = (full, root) => path.relative(root, full).split(path.sep).slice(0, 2).join(' / ');
    const add = (dir, group, depth, sub = first) => { if (dir && fs.existsSync(dir)) R.push({ dir, group, depth, sub }); };
    if (IS_WIN) {
      const local = E.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      const roaming = E.APPDATA || path.join(home, 'AppData', 'Roaming');
      const pdata = E.ProgramData || 'C:\\ProgramData';
      // ---- games
      for (const lib of await steamLibraries()) {
        add(path.join(lib, 'steamapps', 'common'), 'Games', 3, (f, r) => first(f, r));
        add(path.join(lib, 'logs'), 'Games', 1, () => 'Steam');
      }
      add(path.join(local, 'EpicGamesLauncher', 'Saved', 'Logs'), 'Games', 1, () => 'Epic Games Launcher');
      try { // Unreal games keep <LocalAppData>\<Game>\Saved\Logs
        for (const e of await fsp.readdir(local, { withFileTypes: true })) if (e.isDirectory()) add(path.join(local, e.name, 'Saved', 'Logs'), 'Games', 1, () => e.name);
      } catch { /* ignore */ }
      add(path.join(home, 'AppData', 'LocalLow'), 'Games', 2, second); // Unity's Player.log
      add(path.join(home, 'Documents', 'My Games'), 'Games', 4);
      add(path.join(home, 'Documents', 'Rockstar Games'), 'Games', 3, () => 'Rockstar');
      add(path.join(roaming, '.minecraft', 'logs'), 'Games', 1, () => 'Minecraft');
      add(path.join(local, 'Riot Games'), 'Games', 4, () => 'Riot Games');
      add(path.join(pdata, 'Battle.net'), 'Games', 3, () => 'Battle.net');
      add(path.join(roaming, 'Battle.net'), 'Games', 2, () => 'Battle.net');
      add(path.join(pdata, 'EA Desktop', 'Logs'), 'Games', 2, () => 'EA app');
      add(path.join(local, 'Electronic Arts'), 'Games', 3, () => 'EA');
      add(path.join(local, 'Ubisoft Game Launcher', 'logs'), 'Games', 2, () => 'Ubisoft Connect');
      add(path.join(pdata, 'GOG.com', 'Galaxy', 'logs'), 'Games', 2, () => 'GOG Galaxy');
      // ---- the PC
      add(path.join(E.WINDIR || 'C:\\Windows', 'Logs'), 'Windows', 2);
      add(path.join(E.WINDIR || 'C:\\Windows', 'Panther'), 'Windows', 1, () => 'Setup');
      add(path.join(pdata, 'Microsoft', 'Windows', 'WER', 'ReportArchive'), 'Windows', 1, () => 'Crash reports');
      // ---- apps
      add(roaming, 'Apps', 3);
      add(local, 'Apps', 3);
      add(pdata, 'Apps', 3);
      add(E.TEMP || path.join(local, 'Temp'), 'Temp', 2, () => 'Temp');
    } else {
      add('/var/log', 'Windows', 3, () => 'System');
      add(path.join(home, '.local', 'share'), 'Games', 3);
      add(path.join(home, '.config'), 'Apps', 3);
      add(path.join(home, '.cache'), 'Apps', 2);
    }
    for (const d of extraDirs) add(d, 'Apps', 3, () => 'Box-Deckspitter');
    for (const d of (readJSON(dataFile, {}) || {}).folders || []) add(d, 'Added', 5, (f, r) => path.basename(r));
    return R;
  }

  async function discover(days) {
    const since = Date.now() - days * 86400000;
    const out = [];
    const deadline = Date.now() + 9000;
    await Promise.all((await roots()).map((r) => walk(r.dir, r.depth, since, deadline, out, { group: r.group, sub: r.sub })));
    // the same file found by two overlapping roots (AppData inside a game folder…): keep the first
    const seen = new Set();
    const files = out.filter((f) => { const k = f.path.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => b.mtime - a.mtime).slice(0, 2500);
    return files;
  }

  // ---- reading

  function decode(buf, startsAtZero) {
    if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
      const b = buf[0] === 0xfe ? Buffer.from(buf).swap16() : buf;
      return b.subarray(2).toString('utf16le');
    }
    void startsAtZero;
    return buf.toString('utf8');
  }
  const isUtf16 = async (fh) => { const b = Buffer.alloc(2); await fh.read(b, 0, 2, 0); return (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff); };

  /** The last `tail` bytes of a file (from a line start), or everything after byte `from`. */
  async function readChunk(file, from, tail) {
    const fh = await fsp.open(file, 'r');
    try {
      const st = await fh.stat();
      const wide = await isUtf16(fh);
      let start = 0, reset = false;
      if (from != null && from >= 0) {
        if (from > st.size) { reset = true; start = Math.max(0, st.size - tail); } else start = from;
      } else start = Math.max(0, st.size - tail);
      if (wide) start -= start % 2;
      const len = Math.min(MAX_READ, st.size - start);
      const buf = Buffer.alloc(Math.max(0, len));
      if (len > 0) await fh.read(buf, 0, len, start);
      let text = wide && start > 0 ? buf.toString('utf16le') : decode(buf, start === 0);
      // a tail starts mid-line: drop the partial first line
      if (from == null && start > 0) { const i = text.indexOf('\n'); text = i >= 0 ? text.slice(i + 1) : ''; }
      // a poll stops at a line end, so a half-written line isn't read as two
      let end = start + len;
      if (from != null && !text.endsWith('\n') && len > 0) {
        const i = text.lastIndexOf('\n');
        if (i >= 0) { const keep = text.slice(i + 1); text = text.slice(0, i + 1); end -= Buffer.byteLength(keep, wide ? 'utf16le' : 'utf8'); } else { text = ''; end = start; }
      }
      return { size: st.size, mtime: st.mtimeMs, end, reset: reset || undefined, text };
    } finally { await fh.close(); }
  }

  // ---- Windows event logs

  const ps = (script, env, timeout = 45000) => new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8;${script}`],
      { env: { ...process.env, ...env }, maxBuffer: 96 * 1024 * 1024, timeout, windowsHide: true }, (e, out) => (e && !out ? reject(e) : resolve(out)));
  });
  const asArray = (txt) => { const t = String(txt).trim(); if (!t) return []; const j = JSON.parse(t); return Array.isArray(j) ? j : [j]; };

  async function listEventLogs() {
    if (eventLogs) return eventLogs;
    const txt = await ps("Get-WinEvent -ListLog * -ErrorAction SilentlyContinue | Where-Object { $_.RecordCount -gt 0 } | Select-Object LogName,RecordCount,@{n='t';e={if($_.LastWriteTime){$_.LastWriteTime.ToUniversalTime().ToString('o')}else{''}}} | ConvertTo-Json -Compress", {});
    eventLogs = asArray(txt).map((l) => ({ name: l.LogName, count: l.RecordCount, last: l.t ? Date.parse(l.t) : 0 })).sort((a, b) => b.last - a.last);
    setTimeout(() => { eventLogs = null; }, 120000).unref?.();
    return eventLogs;
  }

  const EVENT_SCRIPT = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$f=@{LogName=$env:BL_LOG;StartTime=[datetime]::Parse($env:BL_SINCE,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)}",
    "if($env:BL_LEVELS){$f.Level=[int[]]($env:BL_LEVELS -split ',')}",
    "Get-WinEvent -FilterHashtable $f -MaxEvents ([int]$env:BL_MAX) | ForEach-Object { [pscustomobject]@{ t=$_.TimeCreated.ToUniversalTime().ToString('o'); id=$_.Id; lv=$_.Level; p=$_.ProviderName; m=$(if($_.Message){$_.Message}else{''}) } } | ConvertTo-Json -Compress",
  ].join(';');

  async function readEvents(log, sinceIso, max, levels) {
    if (!/^[\w .\-\/%()]+$/.test(log)) throw err(400, 'Bad log name');
    const rows = asArray(await ps(EVENT_SCRIPT, { BL_LOG: log, BL_SINCE: sinceIso, BL_MAX: String(max), BL_LEVELS: levels || '' }));
    return rows.map((r) => ({ t: Date.parse(r.t), id: r.id, lv: r.lv, p: r.p, m: String(r.m || '').slice(0, 4000) })).sort((a, b) => a.t - b.t);
  }

  return {
    'GET /api/log/sources': async (req, q) => {
      const days = Math.max(1, Math.min(365, +q.get('days') || 14));
      if (!cache || cache.days !== days || q.get('refresh') || Date.now() - cache.at > 60000) cache = { at: Date.now(), days, files: await discover(days) };
      return { files: cache.files, folders: (readJSON(dataFile, {}) || {}).folders || [], windows: IS_WIN };
    },
    'GET /api/log/eventlogs': async () => {
      if (!IS_WIN) return { logs: [] };
      try { return { logs: await listEventLogs() }; } catch (e) { return { logs: [], error: e.message }; }
    },
    'GET /api/log/events': async (req, q) => {
      if (!IS_WIN) throw err(400, 'Event logs are a Windows thing');
      const since = new Date(+q.get('since') || Date.now() - 86400000).toISOString();
      const levels = String(q.get('levels') || '').replace(/[^0-9,]/g, '');
      return { events: await readEvents(q.get('log') || 'Application', since, Math.max(1, Math.min(20000, +q.get('max') || 3000)), levels) };
    },
    'GET /api/log/read': async (req, q) => {
      const file = requirePath(q.get('path'));
      const from = q.get('from') == null ? null : +q.get('from');
      const tail = Math.max(4096, Math.min(MAX_READ, +q.get('tail') || 1024 * 1024));
      try { return await readChunk(file, from, tail); } catch (e) { throw err(e.code === 'ENOENT' ? 404 : 400, e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES' ? 'That log is locked by another program' : e.message); }
    },
    // one request for everything being followed: files by byte offset, event logs by time
    'POST /api/log/poll': async (req) => {
      const { files = [], events = [] } = await readJSONBody(req);
      const out = { files: {}, events: {} };
      await Promise.all(files.slice(0, 200).map(async (f) => {
        try { out.files[f.path] = await readChunk(requirePath(f.path), +f.from, 1024 * 1024); } catch (e) { out.files[f.path] = { error: e.code === 'ENOENT' ? 'gone' : 'locked' }; }
      }));
      if (IS_WIN) {
        await Promise.all(events.slice(0, 6).map(async (e) => {
          try { out.events[e.log] = await readEvents(e.log, new Date(+e.since).toISOString(), 1500, String(e.levels || '').replace(/[^0-9,]/g, '')); } catch { out.events[e.log] = []; }
        }));
      }
      return out;
    },
    'POST /api/log/folders': async (req) => {
      const { add, remove } = await readJSONBody(req);
      const cfg = readJSON(dataFile, {}) || {};
      const set = new Set(cfg.folders || []);
      if (add) { const p = requirePath(add); const st = await fsp.stat(p).catch(() => null); if (!st?.isDirectory()) throw err(400, 'That isn’t a folder'); set.add(p); }
      if (remove) set.delete(remove);
      cfg.folders = [...set];
      await writeJSON(dataFile, cfg);
      cache = null;
      return { folders: cfg.folders };
    },
  };
};
