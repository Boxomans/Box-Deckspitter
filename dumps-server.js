// The dumps: folders of reusable files (pictures, videos, sounds, documents) the editors pull from.
// Listing, folders, moving, renaming, removing (undoable), importing, finding identical files.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

module.exports = function createDumps({
  DUMP_AUDIO_EXT, DUMP_EXT, DUMP_VIDEO_EXT, dumpOf, ok, platform, readBody, readJSONBody, requirePath, revealInExplorer,
}) {
  /** A number that goes up whenever something in a dump changes on disk (Explorer included); watched from the first ask. */
  const dumpWatch = new Map();
  function dumpRev(kind) {
    const d = dumpOf(kind);
    let w = dumpWatch.get(d.dir);
    if (!w) {
      w = { rev: 1 };
      dumpWatch.set(d.dir, w);
      try {
        fs.watch(d.dir, { recursive: true }, (ev, name) => { if (!name || !String(name).split(/[\\/]/).some((p) => p.startsWith('.'))) w.rev++; })
          .on('error', () => { w.poll = true; });
      } catch { w.poll = true; } // no watching here (some drives): the page just reloads the list each time
    }
    return w.poll ? Date.now() : w.rev;
  }

  // Dumps can have folders: names are paths inside the dump with forward slashes ("trips/beach.png").
  // Every part is checked: no "..", nothing hidden (.removed, .incoming), nothing Windows can't name, not too deep.
  const DUMP_MAX_DEPTH = 8;
  function dumpRel(rel, kind, { folder = false } = {}) {
    const d = dumpOf(kind);
    const parts = String(rel ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
    const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
    if (!folder && !parts.length) throw bad(`Not ${d.what} file name`);
    if (parts.length > DUMP_MAX_DEPTH) throw bad('Folders can only go 8 deep');
    for (const s of parts) {
      if (s.startsWith('.') || /[<>:"|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s) || s.length > 120) throw bad(`“${s}” can’t be used as a name`);
    }
    if (!folder && !d.exts.has(path.extname(parts[parts.length - 1]).toLowerCase())) throw bad(`Not ${d.what} file name`);
    return parts.join('/');
  }
  /** A file name in a dump (may include folders). */
  function dumpName(name, kind) { return dumpRel(name, kind); }
  const dumpAbs = (kind, rel) => path.join(dumpOf(kind).dir, ...String(rel || '').split('/').filter(Boolean));
  const relParent = (rel) => rel.split('/').slice(0, -1).join('/');
  const relJoin = (...parts) => parts.filter(Boolean).join('/');
  /** Path inside the dump for a file or folder on disk, or null when it's somewhere else. */
  function dumpRelOf(kind, full) {
    const base = path.resolve(dumpOf(kind).dir);
    const r = path.relative(base, path.resolve(full));
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
    return r.split(path.sep).join('/');
  }
  /** An existing file or folder in a dump. */
  async function dumpEntry(rel, kind) {
    const r = dumpRel(rel, kind, { folder: true });
    if (!r) throw Object.assign(new Error('That’s the dump itself'), { status: 400 });
    const full = dumpAbs(kind, r);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) throw Object.assign(new Error(`${r} isn’t in the dump any more`), { status: 404 });
    if (st.isFile()) dumpRel(r, kind);
    return { rel: r, full, isDir: st.isDirectory() };
  }
  /** Every file in a dump, folders included (hidden folders like .removed skipped). */
  async function walkDump(kind, sub = '', depth = 0, out = []) {
    const d = dumpOf(kind);
    for (const e of await fsp.readdir(dumpAbs(kind, sub), { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.')) continue;
      const rel = relJoin(sub, e.name);
      if (e.isDirectory()) { if (depth < DUMP_MAX_DEPTH - 1) await walkDump(kind, rel, depth + 1, out); }
      else if (e.isFile() && d.exts.has(path.extname(e.name).toLowerCase())) out.push(rel);
    }
    return out;
  }

  /** A free name for `name` (may include folders, which are made if needed). */
  async function uniqueDumpPath(name, kind) {
    const d = dumpOf(kind);
    const parts = String(name).split(/[\\/]/).filter(Boolean);
    const base = parts.pop() || 'file';
    const dir = path.join(d.dir, ...parts);
    await fsp.mkdir(dir, { recursive: true });
    const ext = path.extname(base);
    const stem = path.basename(base, ext).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'file';
    let candidate = path.join(dir, stem + ext.toLowerCase());
    for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext.toLowerCase()}`);
    return candidate;
  }

  // ---- playlists: lists of songs in the audio dump, kept in audio-dump/.playlists.json (so they travel with the songs).
  // A song can be in any number of them; the files themselves stay wherever they are. Before these, a playlist was a
  // folder at the top of the audio dump: the first read turns each of those folders into a list of its songs.
  const PL_FILE = () => path.join(dumpOf('audio').dir, '.playlists.json');
  const plName = (n) => String(n ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/^[. ]+|[. ]+$/g, '').replace(/\s+/g, ' ').slice(0, 80);
  const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
  let plChain = Promise.resolve();
  async function readLists() {
    const raw = await fsp.readFile(PL_FILE(), 'utf8').catch(() => null);
    if (raw != null) {
      try {
        const j = JSON.parse(raw);
        return (Array.isArray(j.lists) ? j.lists : []).filter((l) => l && plName(l.name))
          .map((l) => ({ name: plName(l.name), songs: [...new Set((Array.isArray(l.songs) ? l.songs : []).filter((s) => typeof s === 'string'))] }));
      } catch { /* damaged: kept aside below, and the folders are read again */ }
      await fsp.rename(PL_FILE(), `${PL_FILE()}.damaged-${Date.now()}`).catch(() => {});
    }
    const lists = [];
    for (const e of await fsp.readdir(dumpOf('audio').dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      lists.push({ name: plName(e.name) || e.name, songs: await walkDump('audio', e.name, 1) });
    }
    lists.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    await writeLists(lists);
    return lists;
  }
  async function writeLists(lists) {
    const tmp = `${PL_FILE()}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, lists }, null, 1));
    await fsp.rename(tmp, PL_FILE());
    // the file is hidden from the dump's watch, so open players are told here
    const w = dumpWatch.get(dumpOf('audio').dir);
    if (w) w.rev++;
  }
  /** Change the playlists one at a time (downloads finish side by side). fn changes `lists` in place; whatever it
   *  returns is passed back. */
  function editLists(fn) {
    const run = plChain.then(async () => {
      const lists = await readLists();
      const before = JSON.stringify(lists);
      const out = await fn(lists);
      if (JSON.stringify(lists) !== before) await writeLists(lists);
      return out;
    });
    plChain = run.catch(() => {});
    return run;
  }
  const findList = (lists, name) => {
    const n = plName(name);
    const l = n && lists.find((x) => sameName(x.name, n));
    if (!l) throw Object.assign(new Error(`There’s no playlist called “${n}”`), { status: 404 });
    return l;
  };
  /** The playlists with their songs, as the dump has them now. A song moved or renamed outside the app is found again
   *  by its file name when that's the only one; songs that are gone stay listed (they come back if the file does). */
  async function playlistsNow() {
    const files = await walkDump('audio');
    const have = new Set(files);
    const byBase = new Map();
    for (const f of files) { const b = f.split('/').pop().toLowerCase(); byBase.set(b, byBase.has(b) ? null : f); }
    return editLists((lists) => {
      for (const l of lists) l.songs = [...new Set(l.songs.map((s) => (have.has(s) ? s : byBase.get(s.split('/').pop().toLowerCase()) || s)))];
      return lists.map((l) => ({ name: l.name, songs: l.songs.filter((s) => have.has(s)) }));
    });
  }
  /** Files and folders in the audio dump moved or renamed ([[from, to], …]): the playlists follow them. */
  const songsMoved = (pairs) => (pairs.length ? editLists((lists) => {
    for (const l of lists) {
      l.songs = [...new Set(l.songs.map((s) => {
        for (const [from, to] of pairs) {
          if (s === from) return to;
          if (s.startsWith(from + '/')) return to + s.slice(from.length);
        }
        return s;
      }))];
    }
  }) : null);
  /** Files or folders taken out of the audio dump: out of the playlists too. */
  const songsGone = (names) => editLists((lists) => {
    for (const l of lists) l.songs = l.songs.filter((s) => !names.some((n) => s === n || s.startsWith(n + '/')));
  });
  const playlists = {
    now: playlistsNow,
    /** Songs (names in the audio dump) into a playlist, which is made if it isn't there. */
    add: (name, songs) => editLists((lists) => {
      const n = plName(name);
      if (!n) throw Object.assign(new Error('Give the playlist a name'), { status: 400 });
      let l = lists.find((x) => sameName(x.name, n));
      if (!l) {
        lists.push(l = { name: n, songs: [] });
        lists.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      }
      for (const s of songs) if (!l.songs.includes(s)) l.songs.push(s);
      return l.name;
    }),
    songs: async (name) => (await playlistsNow()).find((l) => sameName(l.name, plName(name)))?.songs || null,
  };

  const routes = {
    // ---- playlists (see above)
    'GET /api/audio/playlists': async () => ({ lists: await playlistsNow() }),
    // { op: 'create' | 'rename' | 'delete' | 'add' | 'remove', name, to, songs }
    'POST /api/audio/playlists': async (req) => {
      const { op, name, to, songs } = await readJSONBody(req);
      const names = (Array.isArray(songs) ? songs : []).slice(0, 5000).map((s) => dumpName(s, 'audio'));
      const out = await editLists((lists) => {
        if (op === 'create' || op === 'add') {
          const n = plName(name);
          if (!n) throw Object.assign(new Error('Give the playlist a name'), { status: 400 });
          let l = lists.find((x) => sameName(x.name, n));
          if (!l) lists.push(l = { name: n, songs: [] });
          else if (op === 'create' && !names.length) throw Object.assign(new Error('That name is taken'), { status: 409 });
          for (const s of names) if (!l.songs.includes(s)) l.songs.push(s);
          lists.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
          return l.name;
        }
        const l = findList(lists, name);
        if (op === 'remove') l.songs = l.songs.filter((s) => !names.includes(s));
        else if (op === 'delete') lists.splice(lists.indexOf(l), 1);
        else if (op === 'rename') {
          const n = plName(to);
          if (!n) throw Object.assign(new Error('Give the playlist a name'), { status: 400 });
          if (lists.some((x) => x !== l && sameName(x.name, n))) throw Object.assign(new Error('That name is taken'), { status: 409 });
          l.name = n;
        } else throw Object.assign(new Error('Unknown playlist change'), { status: 400 });
        lists.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        return l.name;
      });
      return { ok: true, name: out, lists: await playlistsNow() };
    },

    // ---- dumps: folders of reusable images / PDFs, shown in the document editor's bottom drawers
    // ?dir=<folder> (even empty): that folder's subfolders and files. Without dir: every file, folders included
    // (for pickers that just want everything). Item names are paths inside the dump ("trips/beach.png").
    'GET /api/dump/rev': async (req, q) => ({ rev: dumpRev(q.get('kind') || 'image') }),
    'GET /api/dump': async (req, q) => {
      const kind = q.get('kind') || 'image';
      const d = dumpOf(kind);
      const sub = q.has('dir') ? dumpRel(q.get('dir'), kind, { folder: true }) : null;
      const item = async (rel) => {
        const full = dumpAbs(kind, rel);
        const st = await fsp.stat(full).catch(() => null);
        if (!st) return null;
        const ext = path.extname(rel).toLowerCase();
        const type = DUMP_VIDEO_EXT.has(ext) ? 'video' : DUMP_EXT.has(ext) ? 'image' : DUMP_AUDIO_EXT.has(ext) ? 'audio' : 'doc';
        return { name: rel, base: path.basename(full), path: full, size: st.size, mtime: st.mtimeMs, type, url: `${d.prefix}${rel.split('/').map(encodeURIComponent).join('/')}?v=${Math.round(st.mtimeMs)}` };
      };
      if (sub === null) {
        const out = (await Promise.all((await walkDump(kind)).map(item))).filter(Boolean);
        return { dir: d.dir, items: out.sort((a, b) => b.mtime - a.mtime) };
      }
      const here = dumpAbs(kind, sub);
      if (sub && !(await fsp.stat(here).catch(() => null))?.isDirectory()) throw Object.assign(new Error('That folder isn’t there any more'), { status: 404 });
      const folders = [];
      const files = [];
      for (const e of await fsp.readdir(here, { withFileTypes: true }).catch(() => [])) {
        if (e.name.startsWith('.')) continue;
        const rel = relJoin(sub, e.name);
        if (e.isDirectory()) {
          const inside = (await fsp.readdir(path.join(here, e.name)).catch(() => [])).filter((n) => !n.startsWith('.'));
          const st = await fsp.stat(path.join(here, e.name)).catch(() => null);
          folders.push({ name: rel, base: e.name, path: path.join(here, e.name), count: inside.length, mtime: st?.mtimeMs || 0, isDir: true });
        } else if (e.isFile() && d.exts.has(path.extname(e.name).toLowerCase())) files.push(rel);
      }
      const items = (await Promise.all(files.map(item))).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
      folders.sort((a, b) => a.base.localeCompare(b.base, undefined, { numeric: true, sensitivity: 'base' }));
      return { dir: d.dir, sub, path: here, folders, items };
    },
    'POST /api/dump/folder': async (req) => {
      const { kind = 'media', path: rel } = await readJSONBody(req);
      const r = dumpRel(rel, kind, { folder: true });
      if (!r) throw Object.assign(new Error('Give the folder a name'), { status: 400 });
      if (fs.existsSync(dumpAbs(kind, r))) throw Object.assign(new Error('That name is taken'), { status: 409 });
      await fsp.mkdir(dumpAbs(kind, r), { recursive: true });
      return { ok: true, name: r };
    },
    // Move files / folders into another folder of the same dump ('' = the top).
    'POST /api/dump/move': async (req) => {
      const { kind = 'media', names, to } = await readJSONBody(req);
      const dest = dumpRel(to, kind, { folder: true });
      if (dest && !(await fsp.stat(dumpAbs(kind, dest)).catch(() => null))?.isDirectory()) throw Object.assign(new Error('That folder isn’t there any more'), { status: 404 });
      const moved = [];
      const pairs = [];
      for (const n of Array.isArray(names) ? names.slice(0, 2000) : []) {
        const e = await dumpEntry(n, kind);
        if (relParent(e.rel) === dest) continue; // already there
        if (e.isDir && (dest === e.rel || dest.startsWith(e.rel + '/'))) throw Object.assign(new Error(`Can’t put ${e.rel} inside itself`), { status: 400 });
        if (dest.split('/').filter(Boolean).length + (e.isDir ? 1 : 0) >= DUMP_MAX_DEPTH) throw Object.assign(new Error('Folders can only go 8 deep'), { status: 400 });
        const base = path.basename(e.full);
        let target;
        if (e.isDir) {
          target = dumpAbs(kind, relJoin(dest, base));
          for (let i = 2; fs.existsSync(target); i++) target = dumpAbs(kind, relJoin(dest, `${base} (${i})`));
        } else target = await uniqueDumpPath(relJoin(dest, base), kind);
        await fsp.rename(e.full, target);
        moved.push(dumpRelOf(kind, target));
        pairs.push([e.rel, moved[moved.length - 1]]);
      }
      if (kind === 'audio') await songsMoved(pairs);
      return { ok: true, moved };
    },
    // Identical files in a dump: same size first (cheap), then a SHA-1 of the contents to be sure.
    'GET /api/dump/identical': async (req, q) => {
      const kind = q.get('kind') || 'image';
      const d = { dir: dumpOf(kind).dir };
      const bySize = new Map();
      for (const rel of await walkDump(kind)) {
        const st = await fsp.stat(dumpAbs(kind, rel)).catch(() => null);
        if (!st || !st.size) continue;
        if (!bySize.has(st.size)) bySize.set(st.size, []);
        bySize.get(st.size).push(rel);
      }
      const groups = [];
      for (const names of bySize.values()) {
        if (names.length < 2) continue;
        const byHash = new Map();
        for (const n of names) {
          const hash = await new Promise((resolve) => {
            const hh = crypto.createHash('sha1');
            fs.createReadStream(path.join(d.dir, n)).on('data', (c) => hh.update(c)).on('end', () => resolve(hh.digest('hex'))).on('error', () => resolve(null));
          });
          if (!hash) continue;
          if (!byHash.has(hash)) byHash.set(hash, []);
          byHash.get(hash).push(n);
        }
        for (const g of byHash.values()) if (g.length > 1) groups.push(g);
      }
      return { groups };
    },
    'POST /api/dump/add': async (req, q) => {
      const kind = q.get('kind') || 'image';
      const name = dumpName(q.get('name') || (kind === 'image' ? 'image.png' : 'document.pdf'), kind);
      const body = await readBody(req, 300 * 1024 * 1024);
      if (!body.length) throw Object.assign(new Error('Empty file'), { status: 400 });
      const dest = await uniqueDumpPath(name, kind);
      await fsp.writeFile(dest, body);
      return { ok: true, name: dumpRelOf(kind, dest), path: dest };
    },
    // A file on disk copied into a dump (videos are too big to send through the page).
    'POST /api/dump/import': async (req) => {
      const { path: src, kind = 'media', name, folder } = await readJSONBody(req);
      const file = requirePath(src);
      const st = await fsp.stat(file).catch(() => null);
      if (!st?.isFile()) throw Object.assign(new Error('That file isn’t there any more'), { status: 404 });
      const sub = folder != null ? dumpRel(folder, kind, { folder: true }) : null;
      const n = dumpName(relJoin(sub, name || path.basename(file)), kind);
      // already somewhere in this dump: moved into the folder asked for (or left alone), never copied
      const inside = dumpRelOf(kind, file);
      if (inside) {
        if (sub == null || relParent(inside) === sub) return { ok: true, name: inside, path: file, already: true };
        const dest = await uniqueDumpPath(relJoin(sub, path.basename(file)), kind);
        await fsp.rename(file, dest);
        if (kind === 'audio') await songsMoved([[inside, dumpRelOf(kind, dest)]]);
        return { ok: true, name: dumpRelOf(kind, dest), path: dest, moved: true };
      }
      const dest = await uniqueDumpPath(n, kind);
      await fsp.copyFile(file, dest, fs.constants.COPYFILE_EXCL);
      return { ok: true, name: dumpRelOf(kind, dest), path: dest };
    },
    // A free file name in a dump (for exporting straight into it); nothing is created.
    'POST /api/dump/reserve': async (req) => {
      const { name, kind = 'media' } = await readJSONBody(req);
      const dest = await uniqueDumpPath(dumpName(name, kind), kind);
      return { path: dest, name: dumpRelOf(kind, dest) };
    },
    'POST /api/dump/remove': async (req) => {
      // "Remove" is reversible: files go to <dump>/.removed rather than being deleted.
      // Folders go there whole.
      const { name, kind } = await readJSONBody(req);
      const d = dumpOf(kind);
      const e = await dumpEntry(name, kind);
      const base = path.basename(e.full);
      const bin = path.join(d.dir, '.removed');
      await fsp.mkdir(bin, { recursive: true });
      let dest = path.join(bin, base);
      if (fs.existsSync(dest)) dest = path.join(bin, `${Date.now()}-${base}`);
      await fsp.rename(e.full, dest);
      if (kind === 'audio') await songsGone([e.rel]);
      return { ok: true };
    },
    // `to` is a new name in the same folder, or a path inside the dump when it has a "/".
    'POST /api/dump/rename': async (req) => {
      const { name, to, kind } = await readJSONBody(req);
      const e = await dumpEntry(name, kind);
      const t = String(to || '').includes('/') ? to : relJoin(relParent(e.rel), to);
      const b = dumpRel(t, kind, { folder: e.isDir });
      if (!b) throw Object.assign(new Error('Give it a name'), { status: 400 });
      const target = dumpAbs(kind, b);
      // a change of upper/lower case only is fine (Windows sees it as the same name)
      if (fs.existsSync(target) && b.toLowerCase() !== e.rel.toLowerCase()) throw Object.assign(new Error('That name is taken'), { status: 409 });
      if (e.isDir && (b + '/').toLowerCase().startsWith(e.rel.toLowerCase() + '/') && b.toLowerCase() !== e.rel.toLowerCase()) throw Object.assign(new Error('Can’t put a folder inside itself'), { status: 400 });
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.rename(e.full, target);
      if (kind === 'audio') await songsMoved([[e.rel, b]]);
      return { ok: true, name: b };
    },
    'POST /api/dump/reveal': async (req) => {
      const { kind, name, folder } = await readJSONBody(req).catch(() => ({}));
      const d = dumpOf(kind);
      if (name) revealInExplorer((await dumpEntry(name, kind)).full);
      else if (folder) revealInExplorer(dumpAbs(kind, dumpRel(folder, kind, { folder: true })), { select: false });
      else revealInExplorer(d.dir, { select: false });
      return { ok: true };
    },
    // Puts a dump file on the clipboard as a file (like Ctrl+C in Explorer), so it pastes into
    // Explorer, Discord, email and so on.
    'POST /api/dump/clip': async (req) => {
      const { kind, name } = await readJSONBody(req);
      const full = dumpAbs(kind, dumpName(name, kind));
      if (!fs.existsSync(full)) throw Object.assign(new Error('File not found'), { status: 404 });
      await platform.copyFileToClipboard(full);
      return { ok: true };
    },
  };

  return { routes, dumpRel, dumpName, dumpAbs, dumpRelOf, playlists };
};
