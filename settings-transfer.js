// Settings export / import (Settings → Your setup): one .zip with the settings (theme, renames, layout, UI
// setup…) and the Secure notes file exactly as it is on disk, still encrypted. Never the dumps, recent files,
// drafts, history or keys/passwords from secrets.json. And the app PIN lock: a lock screen for the whole app.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const err = (status, message) => Object.assign(new Error(message), { status });
const KIND = 'box-docspitter-setup';
// settings that belong to this PC or this session, not to "your setup". Easter egg game progress (tomcat*) is
// yours: it always goes with the export.
const LOCAL_ONLY = new Set(['explorerDir', 'spaces', 'musicLast', 'musicPos', 'musicPlaying', 'musicQueue', 'musicShuffleOrder', 'lastSeenVersion', 'welcomed', 'browserTabs', 'browserActive', 'browserPinned',
  'pinnedTabs', 'tunnel']); // pinned file paths and audio devices are this PC's too
const NOTE_FILES = ['notes.bdsv', 'device.key'];
const MAX_ZIP = 90 * 1024 * 1024;
const BG_RE = /^background\/(bg-[0-9a-f]{8}\.(?:jpg|jpeg|png|webp|gif|bmp))$/; // the app background picture, if there is one

module.exports = function createTransfer({ root, data, version, settings, saveSettings, readJSONBody, requirePath, log }) {
  const JSZip = require(path.join(root, 'node_modules', 'jszip'));
  const NOTES = path.join(data, 'secure-notes');
  const BGS = path.join(data, 'backgrounds');
  const LOCK = path.join(data, 'applock.json');

  // ---------------------------------------------------------------- app PIN lock
  // The PIN is kept as a slow scrypt hash. Wrong PINs wait longer and longer (saved, so a restart doesn't reset it).
  const readLock = () => { try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return null; } };
  const writeLock = (v) => { const t = LOCK + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, LOCK); };
  const PIN_RE = /^\S{4,32}$/u;
  const hashPin = (pin, salt) => new Promise((resolve, reject) => crypto.scrypt(String(pin).normalize('NFC'), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));
  async function pinMatches(lock, pin) {
    const k = await hashPin(String(pin || ''), Buffer.from(lock.salt, 'base64'));
    const want = Buffer.from(lock.hash, 'base64');
    return k.length === want.length && crypto.timingSafeEqual(k, want);
  }
  const waitLeft = (lock) => Math.max(0, (lock?.until || 0) - Date.now());
  async function checkPin(pin) {
    const lock = readLock();
    if (!lock) return true;
    const wait = waitLeft(lock);
    if (wait) throw Object.assign(err(429, `Too many wrong PINs. Try again in ${Math.ceil(wait / 1000)} s.`), { wait });
    if (await pinMatches(lock, pin)) {
      if (lock.fails) { lock.fails = 0; lock.until = 0; writeLock(lock); }
      return true;
    }
    lock.fails = (lock.fails || 0) + 1;
    // 5 wrong: 30 s, then doubling each time, up to 15 minutes
    if (lock.fails >= 5) lock.until = Date.now() + Math.min(15 * 60000, 30000 * 2 ** (lock.fails - 5));
    writeLock(lock);
    const w = waitLeft(lock);
    throw Object.assign(err(401, w ? `Wrong PIN. Try again in ${Math.ceil(w / 1000)} s.` : 'Wrong PIN.'), { wait: w });
  }

  // ---------------------------------------------------------------- export / import
  async function exportTo(out) {
    const zip = new JSZip();
    const s = { ...settings() };
    for (const k of LOCAL_ONLY) delete s[k];
    const files = [];
    zip.file('settings.json', JSON.stringify(s, null, 2));
    for (const n of NOTE_FILES) {
      const f = path.join(NOTES, n);
      if (fs.existsSync(f)) { zip.file(`secure-notes/${n}`, fs.readFileSync(f)); files.push(n); }
    }
    const bg = s.bgImage?.file;
    if (bg && BG_RE.test(`background/${bg}`) && fs.existsSync(path.join(BGS, bg))) zip.file(`background/${bg}`, fs.readFileSync(path.join(BGS, bg)));
    zip.file('manifest.json', JSON.stringify({ kind: KIND, app: 'Box-DocSpitter', version, exported: new Date().toISOString(), secureNotes: files.includes('notes.bdsv') }, null, 2));
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const tmp = `${out}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, out);
    log(`setup exported → ${out}`);
    return { ok: true, path: out, secureNotes: files.includes('notes.bdsv'), settings: Object.keys(s).length };
  }

  async function readExport(file) {
    const st = await fsp.stat(file).catch(() => null);
    if (!st?.isFile()) throw err(404, 'That file isn’t there any more.');
    if (st.size > MAX_ZIP) throw err(400, 'That’s far too big to be a Box-DocSpitter export.');
    let zip;
    try { zip = await JSZip.loadAsync(await fsp.readFile(file)); } catch { throw err(400, 'That isn’t a .zip file.'); }
    const allowed = new Set(['manifest.json', 'settings.json', ...NOTE_FILES.map((n) => `secure-notes/${n}`)]);
    const names = Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name);
    let manifest;
    try { manifest = JSON.parse(await zip.file('manifest.json').async('string')); } catch { manifest = null; }
    if (manifest?.kind !== KIND) throw err(400, 'That .zip isn’t a Box-DocSpitter export.');
    if (names.some((n) => !allowed.has(n) && !BG_RE.test(n))) throw err(400, 'That export has files in it that don’t belong; not importing it.');
    let s = {};
    if (zip.file('settings.json')) {
      try { s = JSON.parse(await zip.file('settings.json').async('string')); } catch { throw err(400, 'The settings in that export are damaged.'); }
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw err(400, 'The settings in that export are damaged.');
    }
    const notes = {};
    for (const n of NOTE_FILES) { const f = zip.file(`secure-notes/${n}`); if (f) notes[n] = await f.async('nodebuffer'); }
    if (notes['notes.bdsv']) {
      let ok = false;
      try { const j = JSON.parse(notes['notes.bdsv'].toString('utf8')); ok = j.magic === 'BDS-SECURE-NOTES'; } catch { /* no */ }
      if (!ok) throw err(400, 'The Secure notes in that export are damaged.');
    }
    const bgName = names.find((n) => BG_RE.test(n));
    const bg = bgName ? { name: BG_RE.exec(bgName)[1], buf: await zip.file(bgName).async('nodebuffer') } : null;
    return { manifest, settings: s, notes, bg };
  }

  async function importFrom(file, { replaceNotes = false } = {}) {
    const x = await readExport(file);
    // settings: yours from the export, except the ones that belong to this PC
    const cur = settings();
    const next = { ...cur };
    for (const [k, v] of Object.entries(x.settings)) if (!LOCAL_ONLY.has(k)) next[k] = v;
    if (x.bg) {
      await fsp.mkdir(BGS, { recursive: true });
      for (const f of await fsp.readdir(BGS)) if (f !== x.bg.name) await fsp.rm(path.join(BGS, f), { force: true });
      await fsp.writeFile(path.join(BGS, x.bg.name), x.bg.buf);
    }
    await saveSettings(next);
    let notes = 'none';
    if (x.notes['notes.bdsv']) {
      const have = fs.existsSync(path.join(NOTES, 'notes.bdsv'));
      if (have && !replaceNotes) notes = 'kept';
      else {
        await fsp.mkdir(NOTES, { recursive: true });
        if (have) {
          // the notes that were here are kept, not deleted
          const keep = path.join(NOTES, 'backups', `replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`);
          await fsp.mkdir(keep, { recursive: true });
          for (const n of NOTE_FILES) { const f = path.join(NOTES, n); if (fs.existsSync(f)) await fsp.copyFile(f, path.join(keep, n)); }
        }
        for (const n of NOTE_FILES) {
          const f = path.join(NOTES, n);
          if (x.notes[n]) { const t = f + '.tmp'; await fsp.writeFile(t, x.notes[n]); await fsp.rename(t, f); }
          else if (n === 'device.key') await fsp.rm(f, { force: true }); // from another PC: the secure key opens it
        }
        notes = 'imported';
      }
    }
    log(`setup imported from ${file} (notes: ${notes})`);
    return { ok: true, settings: Object.keys(x.settings).length, notes };
  }

  return {
    'GET /api/applock': async () => {
      const lock = readLock();
      return { enabled: !!lock, wait: waitLeft(lock) };
    },
    'POST /api/applock/verify': async (req) => {
      const { pin } = await readJSONBody(req);
      await checkPin(pin);
      return { ok: true };
    },
    'POST /api/applock/set': async (req) => {
      const { current, pin } = await readJSONBody(req);
      if (!PIN_RE.test(String(pin ?? ''))) throw err(400, 'A PIN is 4 to 32 letters, numbers or symbols (no spaces).');
      await checkPin(current);
      const salt = crypto.randomBytes(16);
      writeLock({ salt: salt.toString('base64'), hash: (await hashPin(pin, salt)).toString('base64'), fails: 0, until: 0 });
      return { ok: true };
    },
    'POST /api/applock/remove': async (req) => {
      const { current } = await readJSONBody(req);
      await checkPin(current);
      await fsp.rm(LOCK, { force: true });
      return { ok: true };
    },
    'POST /api/setup/export': async (req) => {
      const { path: out } = await readJSONBody(req);
      return exportTo(requirePath(out));
    },
    'POST /api/setup/inspect': async (req) => {
      const { path: file } = await readJSONBody(req);
      const x = await readExport(requirePath(file));
      return { exported: x.manifest.exported, version: x.manifest.version, settings: Object.keys(x.settings).length, secureNotes: !!x.notes['notes.bdsv'], haveNotes: fs.existsSync(path.join(NOTES, 'notes.bdsv')) };
    },
    'POST /api/setup/import': async (req) => {
      const { path: file, replaceNotes } = await readJSONBody(req);
      return importFrom(requirePath(file), { replaceNotes: !!replaceNotes });
    },
  };
};
