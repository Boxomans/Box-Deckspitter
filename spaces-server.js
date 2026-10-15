// BoxSpaces (folder workspaces): file index, text search, git status, recycle-bin delete.

'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

module.exports = function createSpaces({ IS_WIN, findExe, ok, psQuote, readJSONBody, requirePath, runCapture }) {
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

  const routes = {
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
  };

  return { routes };
};
