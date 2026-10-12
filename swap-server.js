// BoxSwap: hot-swap sets of files in any folder. Not a mod manager, but the same idea.
//
// Master folder (data/boxswap, or one you pick)
//   └ <target folder name>/          one per folder you manage; .boxswap.json says which folder it is
//       ├ <profile>/                 the files, laid out exactly as they go in the target
//       ├ <another profile>/
//       └ .originals/                the target's own files a profile replaced, kept until it's switched off
//
// Switching moves files: the active profile's files go back to its folder (with any edits made meanwhile), the
// target's originals come back, then the next profile's files move in. On one drive a move is an instant rename;
// across drives it's a copy. Only files BoxSwap put in the target are ever taken out of it, and every move of a
// switch is recorded, so a failure halfway (a game holding a file open) puts everything back where it was.
//
// Nothing is ever deleted. A move never lands on an existing file; a cross-drive copy is checked before its source
// goes; every move is written to a journal on disk first, so a crash or power cut mid-switch is undone the next time
// the folder is opened. Removing a profile or forgetting a folder only moves it into .removed in the master folder.
// The only things BoxSwap removes are its own bookkeeping files and folders it made that are empty again.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const META = '.boxswap.json';
const ORIGINALS = '.originals';
const JOURNAL = '.boxswap.journal';
const REMOVED = '.removed';
const err = (status, message) => Object.assign(new Error(message), { status });
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (child, parent) => { const r = path.relative(path.resolve(parent), path.resolve(child)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
// names Windows won't take, and anything that would step out of the folder
const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]|^\.|^\s|\s$|\.$|^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

module.exports = function createSwap({ readJSONBody, requirePath, dataDir, appRoot }) {
  const DEFAULT_STORE = path.join(dataDir, 'boxswap');
  const busy = new Set(); // groups mid-switch

  function storeOf(p) {
    const store = p ? requirePath(p) : DEFAULT_STORE;
    if (path.parse(store).root === store) throw err(400, 'Pick a folder for the profiles, not a whole drive.');
    return store;
  }
  const driveOf = (p) => path.parse(path.resolve(p)).root.toLowerCase();

  function checkName(name, what = 'profile') {
    const n = String(name || '').trim();
    if (!n || n.length > 120 || BAD_NAME.test(n)) throw err(400, `That ${what} name won’t work as a folder name. Avoid \\ / : * ? " < > | and a leading dot.`);
    return n;
  }

  async function readMeta(dir) {
    try { return JSON.parse(await fsp.readFile(path.join(dir, META), 'utf8')); } catch { return null; }
  }
  async function writeMeta(dir, meta) {
    const tmp = path.join(dir, `${META}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify(meta, null, 2));
    await fsp.rename(tmp, path.join(dir, META));
  }

  /** Every target in the master folder: [{ id, dir, meta }]. */
  async function groups(store) {
    let names = [];
    try { names = await fsp.readdir(store, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const d of names) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const dir = path.join(store, d.name);
      const meta = await readMeta(dir);
      if (meta?.target) out.push({ id: d.name, dir, meta, problem: await recover(dir, meta) });
    }
    return out;
  }

  async function group(store, id) {
    if (!id || BAD_NAME.test(id)) throw err(400, 'Unknown folder');
    const dir = path.join(store, id);
    const meta = await readMeta(dir);
    if (!meta?.target) throw err(404, 'That folder isn’t set up in this master folder any more.');
    return { id, dir, meta, problem: await recover(dir, meta) };
  }

  /** A path from a list BoxSwap keeps, joined onto root; refuses anything that would land outside root. */
  function under(root, rel) {
    const p = path.join(root, rel);
    if (!inside(p, root)) throw err(400, `Refusing a path outside the folder: ${rel}`);
    return p;
  }

  /** Somewhere new to park a folder in .removed (never on top of anything). */
  function removedSpot(parent, name) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    let p = path.join(parent, REMOVED, `${name} ${stamp}`);
    for (let i = 2; fs.existsSync(p); i++) p = path.join(parent, REMOVED, `${name} ${stamp} (${i})`);
    return p;
  }

  // ---- the journal: a switch writes each move down before making it, so one cut short by a crash is undone later

  async function readJournal(dir) {
    let text;
    try { text = await fsp.readFile(path.join(dir, JOURNAL), 'utf8'); } catch { return null; }
    const lines = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return { id: lines[0]?.switch, moves: lines.filter((l) => Array.isArray(l.move)).map((l) => l.move) };
  }

  /** Undo a switch that never finished. Returns a message when some files couldn't be put back, else null. */
  async function recover(dir, meta) {
    if (busy.has(dir.toLowerCase())) return null; // a switch is running right now: its journal is live
    const j = await readJournal(dir);
    if (!j) return null;
    if (j.id && meta.lastSwitch === j.id) { await fsp.unlink(path.join(dir, JOURNAL)).catch(() => {}); return null; } // it did finish
    const stuck = [], doubled = [];
    for (const [a, b] of j.moves.reverse()) {
      if (!fs.existsSync(b)) continue; // never happened, or already put back
      if (fs.existsSync(a)) {
        // both names there: cut off between linking and dropping the old name. If they're one and the same file, the
        // new name is just a second name for it and can go. Anything else is left alone for you to look at.
        const sa = await fsp.stat(a, { bigint: true }).catch(() => null), sb = await fsp.stat(b, { bigint: true }).catch(() => null);
        if (sa && sb && sa.isFile() && sa.ino && sa.ino === sb.ino && sa.dev === sb.dev) await fsp.unlink(b).catch(() => stuck.push(b));
        else doubled.push(b);
        continue;
      }
      try { await move(b, a); } catch { stuck.push(b); }
    }
    if (doubled.length) return `A switch was cut short while copying. Your files are safe where they were, but ${doubled.length} leftover cop${doubled.length === 1 ? 'y is' : 'ies are'} at: ${doubled.slice(0, 3).join(', ')}${doubled.length > 3 ? '…' : ''}. Check and move ${doubled.length === 1 ? 'it' : 'them'} away, then refresh.`;
    if (stuck.length) return `A switch was cut short and ${stuck.length} file${stuck.length === 1 ? '' : 's'} couldn’t be put back yet (in use?): ${stuck.slice(0, 3).join(', ')}${stuck.length > 3 ? '…' : ''}. Close whatever is using the folder and refresh.`;
    await fsp.unlink(path.join(dir, JOURNAL)).catch(() => {});
    return null;
  }

  /** Every file under dir, as paths relative to it (folders BoxSwap keeps for itself are skipped). */
  async function walk(dir, rel = '', out = []) {
    let list = [];
    try { list = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
    for (const d of list) {
      const r = rel ? path.join(rel, d.name) : d.name;
      if (d.isDirectory()) await walk(dir, r, out);
      else if (d.isFile()) out.push(r);
    }
    return out;
  }

  async function sizeOf(dir) {
    let files = 0, bytes = 0;
    for (const r of await walk(dir)) { files++; try { bytes += (await fsp.stat(path.join(dir, r))).size; } catch { /* gone */ } }
    return { files, bytes };
  }

  async function profiles(g) {
    let list = [];
    try { list = await fsp.readdir(g.dir, { withFileTypes: true }); } catch { /* none */ }
    const out = [];
    for (const d of list) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const active = g.meta.active === d.name;
      // the active profile's files are out in the target: count what it put there
      const s = active ? { files: (g.meta.deployed || []).length, bytes: (g.meta.deployed || []).reduce((n, x) => n + (x.size || 0), 0) } : await sizeOf(path.join(g.dir, d.name));
      out.push({ name: d.name, active, description: g.meta.notes?.profiles?.[d.name] || '', ...s });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }

  async function summary(g) {
    return {
      id: g.id, dir: g.dir, target: g.meta.target, exists: fs.existsSync(g.meta.target), active: g.meta.active || null, problem: g.problem || null,
      description: g.meta.notes?.target || '',
      sameDrive: driveOf(g.dir) === driveOf(g.meta.target), originals: (g.meta.originals || []).length, profiles: await profiles(g),
    };
  }

  // ---- moving files

  /**
   * Move one file without ever landing on top of another. Same drive: a hard link (which fails if anything is at
   * `to`, with no gap for a race) then the old name goes, which is an instant rename that can't overwrite. Drives
   * without hard links fall back to a rename after checking. Across drives: copy (which also refuses to overwrite),
   * check the copy is whole, and only then let the original go. If the original can't go, the new one is taken
   * back away, so a file is never in two places and never in none.
   */
  async function move(from, to) {
    if (fs.existsSync(to)) throw err(409, `Something is already at ${to}`);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    const st = await fsp.lstat(from);
    if (st.isFile()) {
      let linked = false;
      try { await fsp.link(from, to); linked = true; }
      catch (e) {
        if (e.code === 'EEXIST') throw err(409, `Something is already at ${to}`);
        if (e.code !== 'EXDEV') {
          // no hard links here (FAT drives, some network shares): plain rename
          if (fs.existsSync(to)) throw err(409, `Something is already at ${to}`);
          try { await fsp.rename(from, to); return; } catch (e2) { if (e2.code !== 'EXDEV') throw e2; }
        }
      }
      if (linked) {
        try { await fsp.unlink(from); } // the same file is still at `to`: this only drops the old name
        catch (e) { await fsp.unlink(to).catch(() => {}); throw e; } // couldn't: drop the new name instead, nothing moved
        return;
      }
      await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      try {
        const got = await fsp.stat(to);
        if (got.size !== st.size) throw err(500, `Copying ${path.basename(from)} came out the wrong size (disk full?).`);
        await fsp.utimes(to, st.atime, st.mtime);
        await fsp.unlink(from);
      } catch (e) { await fsp.unlink(to).catch(() => {}); throw e; } // `to` is the copy just made; the original is untouched
      return;
    }
    // a folder (only when one sits where a profile's file was): rename only, never copy-and-remove
    if (fs.existsSync(to)) throw err(409, `Something is already at ${to}`);
    await fsp.rename(from, to);
  }

  /** Folders made in the target for a profile's files: removed again (deepest first) once they're empty. */
  async function pruneDirs(root, dirs) {
    for (const rel of [...dirs].sort((a, b) => b.length - a.length)) {
      try { await fsp.rmdir(path.join(root, rel)); } catch { /* not empty, or gone */ }
    }
  }

  /** Folders between root and rel's file that don't exist yet. */
  function missingDirs(root, rel) {
    const out = [];
    let d = path.dirname(rel);
    while (d && d !== '.' && !fs.existsSync(path.join(root, d))) { out.push(d); d = path.dirname(d); }
    return out;
  }

  /** What switching to `to` (null = off) would do, without doing it. */
  async function plan(g, to) {
    const { meta } = g;
    const target = meta.target;
    const out = (meta.deployed || []).map((x) => x.rel);
    const changed = [];
    for (const x of meta.deployed || []) {
      try { const st = await fsp.stat(path.join(target, x.rel)); if (st.size !== x.size || Math.abs(st.mtimeMs - x.mtimeMs) > 2000) changed.push(x.rel); }
      catch { /* gone: nothing to bring back */ }
    }
    const restore = meta.originals || [];
    const incoming = to ? await walk(path.join(g.dir, to)) : [];
    const outSet = new Set(out.map((r) => r.toLowerCase()));
    const restoreSet = new Set(restore.map((r) => r.toLowerCase()));
    // after the current profile leaves and the originals are back: which of the target's files get set aside
    const replace = incoming.filter((r) => {
      const k = r.toLowerCase();
      if (restoreSet.has(k)) return true;
      return !outSet.has(k) && fs.existsSync(path.join(target, r));
    });
    return { from: meta.active || null, to: to || null, remove: out.length, changed, restore: restore.length, add: incoming.length, replace, sameDrive: driveOf(g.dir) === driveOf(target) };
  }

  async function doSwitch(g, to) {
    const { dir, meta } = g;
    const target = meta.target;
    if (!fs.existsSync(target)) throw err(404, `The folder ${target} isn’t there (a drive unplugged?).`);
    if (to && !fs.existsSync(path.join(dir, to))) throw err(404, `There’s no profile called “${to}”.`);
    if (g.problem || fs.existsSync(path.join(dir, JOURNAL))) throw err(409, g.problem || 'An earlier switch of this folder is still being undone. Refresh and try again.');
    const switchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const jpath = path.join(dir, JOURNAL);
    const jfile = await fsp.open(jpath, 'wx'); // 'wx': never on top of another journal
    await jfile.write(JSON.stringify({ switch: switchId, at: Date.now() }) + '\n');
    await jfile.sync();
    const journal = []; // [from, to] of every move made, to undo in reverse
    const mv = async (a, b) => {
      await jfile.write(JSON.stringify({ move: [a, b] }) + '\n'); // on disk before the move happens
      await jfile.sync();
      await move(a, b);
      journal.push([a, b]);
    };
    const next = { ...meta, deployed: [...(meta.deployed || [])], originals: [...(meta.originals || [])], createdDirs: [...(meta.createdDirs || [])] };
    try {
      // 1. the active profile's files go home (edits included). If its folder already has that file (added there
      //    while it was active), the live copy wins and the other is kept beside it.
      if (meta.active) {
        const home = path.join(dir, meta.active);
        for (const x of meta.deployed || []) {
          const live = under(target, x.rel);
          if (!fs.existsSync(live)) continue;
          let dest = under(home, x.rel);
          if (fs.existsSync(dest)) {
            const p = path.parse(dest);
            await mv(dest, path.join(p.dir, `${p.name} (in profile folder ${Date.now()})${p.ext}`));
          }
          await mv(live, dest);
        }
        next.deployed = [];
        // 2. the target's own files come back
        for (const rel of meta.originals || []) {
          const kept = under(path.join(dir, ORIGINALS), rel);
          if (!fs.existsSync(kept)) continue;
          if (fs.existsSync(under(target, rel))) throw err(409, `Can’t put back the original ${rel}: something new is in its place in the folder. Move that file away and try again.`);
          await mv(kept, under(target, rel));
        }
        next.originals = [];
        await pruneDirs(target, meta.createdDirs || []);
        next.createdDirs = [];
        next.active = null;
      }
      // 3. the next profile moves in; anything of the target's in the way is set aside first
      if (to) {
        const src = path.join(dir, to);
        const files = await walk(src);
        const made = new Set();
        for (const rel of files) {
          const dest = under(target, rel);
          for (const d of missingDirs(target, rel)) made.add(d);
          if (fs.existsSync(dest)) {
            if (fs.statSync(dest).isDirectory()) throw err(409, `The profile has a file called ${rel}, but the folder has a folder by that name.`);
            await mv(dest, under(path.join(dir, ORIGINALS), rel));
            next.originals.push(rel);
          }
          await mv(path.join(src, rel), dest);
          const st = await fsp.stat(dest);
          next.deployed.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
        }
        next.createdDirs = [...made];
        next.active = to;
      }
      next.switchedAt = Date.now();
      next.lastSwitch = switchId; // marks the journal as done: a crash after this line is not undone
      await writeMeta(dir, next);
      g.meta = next;
      await jfile.close();
      await fsp.unlink(jpath).catch(() => {});
      return { ok: true, moved: journal.length };
    } catch (e) {
      // put every file back where it was, newest move first
      const stuck = [];
      for (const [a, b] of [...journal].reverse()) { try { await move(b, a); } catch { stuck.push(b); } }
      await jfile.close().catch(() => {});
      if (!stuck.length) await fsp.unlink(jpath).catch(() => {}); // else the journal stays, and the next refresh tries again
      await pruneDirs(target, [...new Set([...(next.createdDirs || []), ...(meta.createdDirs || [])])].filter((d) => !(meta.createdDirs || []).includes(d)));
      const locked = ['EBUSY', 'EPERM', 'EACCES'].includes(e.code);
      const why = locked ? `A file is in use or read-only${e.path ? ` (${path.basename(e.path)})` : ''}. Is the game or program running? Close it and try again.` : e.message;
      if (stuck.length) throw err(500, `${why}\n\nMost files were put back, but ${stuck.length} couldn’t be yet: ${stuck.slice(0, 5).join(', ')}${stuck.length > 5 ? '…' : ''}. Nothing was lost: close whatever is using the folder and refresh, and BoxSwap finishes putting them back.`);
      throw err(e.status || (locked ? 423 : 500), `${why}\n\nNothing was changed.`);
    }
  }

  async function withGroup(store, id, fn) {
    const g = await group(store, id); // also finishes undoing a switch a crash cut short
    const key = g.dir.toLowerCase();
    if (busy.has(key)) throw err(409, 'Already switching that folder.');
    busy.add(key);
    try { return await fn(g); } finally { busy.delete(key); }
  }

  return {
    'POST /api/swap/state': async (req) => {
      const body = await readJSONBody(req);
      const store = storeOf(body.store);
      const list = [];
      for (const g of await groups(store)) list.push(await summary(g));
      return { store, defaultStore: DEFAULT_STORE, isDefault: same(store, DEFAULT_STORE), exists: fs.existsSync(store), targets: list.sort((a, b) => a.id.localeCompare(b.id)) };
    },

    'POST /api/swap/add': async (req) => {
      const body = await readJSONBody(req);
      const store = storeOf(body.store);
      const target = requirePath(body.target);
      if (path.parse(target).root === target) throw err(400, 'Pick a folder, not a whole drive.');
      if (same(target, store) || inside(target, store) || inside(store, target)) throw err(400, 'The folder and the master folder can’t be inside one another.');
      if (same(target, appRoot) || inside(target, appRoot)) throw err(400, 'That’s Box-DocSpitter’s own folder.');
      const win = process.env.SystemRoot;
      if (win && (same(target, win) || inside(target, win))) throw err(400, 'Not the Windows folder.');
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw err(404, 'That folder isn’t there.');
      for (const g of await groups(store)) {
        if (same(g.meta.target, target)) return summary(g);
        if (inside(target, g.meta.target) || inside(g.meta.target, target)) throw err(400, `That folder overlaps ${g.meta.target}, which BoxSwap already manages. Two profiles could fight over the same files.`);
      }
      let base = checkName(path.basename(target).replace(/[<>:"/\\|?*]/g, '_').replace(/^\.+/, ''), 'folder');
      let id = base;
      for (let i = 2; fs.existsSync(path.join(store, id)); i++) id = `${base} (${i})`;
      const dir = path.join(store, id);
      await fsp.mkdir(dir, { recursive: true });
      await writeMeta(dir, { target, active: null, deployed: [], originals: [], createdDirs: [], created: Date.now() });
      return summary(await group(store, id));
    },

    'POST /api/swap/forget': async (req) => {
      const body = await readJSONBody(req);
      const store = storeOf(body.store);
      return withGroup(store, body.id, async (g) => {
        if (g.meta.active) throw err(409, 'Switch its profile off first, so the folder is back to how it was.');
        const spot = removedSpot(store, g.id);
        await fsp.mkdir(path.dirname(spot), { recursive: true });
        await fsp.rename(g.dir, spot); // kept, not deleted
        return { ok: true, keptAt: spot };
      });
    },

    'POST /api/swap/profile/new': async (req) => {
      const body = await readJSONBody(req);
      const store = storeOf(body.store);
      const g = await group(store, body.id);
      const name = checkName(body.name);
      const dir = path.join(g.dir, name);
      if (fs.existsSync(dir)) throw err(409, 'There’s already a profile with that name.');
      await fsp.mkdir(dir, { recursive: true });
      return { ok: true, path: dir };
    },

    'POST /api/swap/profile/rename': async (req) => {
      const body = await readJSONBody(req);
      const store = storeOf(body.store);
      return withGroup(store, body.id, async (g) => {
        const from = checkName(body.name), to = checkName(body.to);
        if (fs.existsSync(path.join(g.dir, to)) && from.toLowerCase() !== to.toLowerCase()) throw err(409, 'There’s already a profile with that name.');
        await fsp.rename(path.join(g.dir, from), path.join(g.dir, to));
        const profiles = { ...(g.meta.notes?.profiles || {}) };
        if (profiles[from] != null) { profiles[to] = profiles[from]; delete profiles[from]; }
        if (g.meta.active === from || profiles[to] != null) await writeMeta(g.dir, { ...g.meta, active: g.meta.active === from ? to : g.meta.active, notes: { ...(g.meta.notes || {}), profiles } });
        return { ok: true };
      });
    },

    'POST /api/swap/describe': async (req) => {
      // a note for the folder (no name) or one of its profiles, kept in .boxswap.json
      const body = await readJSONBody(req);
      const store = storeOf(body.store);
      return withGroup(store, body.id, async (g) => {
        const text = String(body.text || '').trim().slice(0, 500);
        const notes = { target: g.meta.notes?.target || '', profiles: { ...(g.meta.notes?.profiles || {}) } };
        if (body.name) {
          const name = checkName(body.name);
          if (!fs.existsSync(path.join(g.dir, name))) throw err(404, `There’s no profile called “${name}”.`);
          if (text) notes.profiles[name] = text; else delete notes.profiles[name];
        } else notes.target = text;
        g.meta = { ...g.meta, notes };
        await writeMeta(g.dir, g.meta);
        return { ok: true };
      });
    },

    'POST /api/swap/profile/delete': async (req) => {
      const body = await readJSONBody(req);
      const store = storeOf(body.store);
      return withGroup(store, body.id, async (g) => {
        const name = checkName(body.name);
        if (g.meta.active === name) throw err(409, 'That profile is switched on. Switch to another one (or off) first.');
        const from = path.join(g.dir, name);
        if (!fs.existsSync(from)) throw err(404, `There’s no profile called “${name}”.`);
        const spot = removedSpot(g.dir, name);
        await fsp.mkdir(path.dirname(spot), { recursive: true });
        await fsp.rename(from, spot); // kept, not deleted
        return { ok: true, keptAt: spot };
      });
    },

    'POST /api/swap/profile/import': async (req) => {
      // copy files or folders into a profile (picked in the app, or dropped on it)
      const body = await readJSONBody(req);
      const store = storeOf(body.store);
      return withGroup(store, body.id, async (g) => {
        const name = checkName(body.name);
        if (g.meta.active === name) throw err(409, 'Switch that profile off to add files to it (its files are out in the folder right now).');
        const dest = path.join(g.dir, name, body.sub ? checkName(body.sub, 'folder') : '');
        let n = 0;
        for (const p of body.paths || []) {
          const from = requirePath(p);
          const to = path.join(dest, path.basename(from));
          if (fs.existsSync(to)) throw err(409, `${path.basename(from)} is already in that profile.`);
          await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
          n++;
        }
        return { ok: true, added: n };
      });
    },

    'POST /api/swap/plan': async (req) => {
      const body = await readJSONBody(req);
      const store = storeOf(body.store);
      const g = await group(store, body.id);
      return plan(g, body.to ? checkName(body.to) : null);
    },

    'POST /api/swap/switch': async (req) => {
      const body = await readJSONBody(req);
      const store = storeOf(body.store);
      const to = body.to ? checkName(body.to) : null;
      return withGroup(store, body.id, async (g) => {
        if ((g.meta.active || null) === to) return { ok: true, moved: 0 };
        const r = await doSwitch(g, to);
        return { ...r, ...(await summary(g)) };
      });
    },
  };
};
