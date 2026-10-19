// Secure notes: an encrypted store for passwords and private notes. All of it runs here, in the app window's
// main process. The page only gets what it shows, the local server never sees any of it, and nothing is
// written to disk unencrypted.
//
// How it's locked
//   - The notes are encrypted with a random 256-bit data key (AES-256-GCM, fresh nonce per save, tamper-evident).
//   - The data key is stored wrapped twice:
//       pass slot      scrypt(passphrase) + this PC's device key → HKDF → AES-256-GCM
//       secure key slot scrypt(secure key + PIN)                → HKDF → AES-256-GCM (for a new PC / fresh copy)
//     scrypt is deliberately slow and memory-hungry (256 MiB per guess), so guessing a copied file is impractical.
//     (Electron's crypto library has no Argon2, and scrypt needs nothing extra installed.)
//   - The device key is random and sealed with Windows DPAPI under this Windows account (on Linux, with the system
//     keyring through Electron's safeStorage), so a copied vault file can't be opened anywhere else with the
//     passphrase — only with the secure key (+ PIN, if one is set).
//   - The secure key is XXXX-XXXX-XXXX-XXXX-XXXX-XXXX: 24 random letters and numbers, not case-sensitive, no
//     look-alikes (~120 bits), shown once at setup (a sticky note is fine). It's also kept inside the encrypted
//     notes, so the secure key slot can be re-made when the PIN changes.
//   - Every 30 days the secure key has to be typed in again before the notes open (checked each time they're
//     opened; the date lives inside the encrypted notes, and a clock set backwards counts as due).
//   - Optional key file (on a USB stick): its SHA-256 goes into the pass slot too, so the passphrase alone
//     isn't enough without the stick. The secure key still works without it.
//   - The PIN never unlocks anything on disk. After a passphrase unlock the data key is kept in memory,
//     wrapped with scrypt(PIN), while the notes are locked; 5 wrong PINs throw it away. After a restart the
//     passphrase is always needed.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAGIC = 'BDS-SECURE-NOTES';
const KDF = { N: 2 ** 18, r: 8, p: 1 }; // 256 MiB per guess: makes guessing slow and expensive
const PIN_KDF = { N: 2 ** 16, r: 8, p: 1 }; // 64 MiB
const MAX_PIN_FAILS = 5;
const KEEP_BACKUPS = 10;
const CLIPBOARD_CLEAR_MS = 20000;
const LIMITS = { title: 300, username: 500, password: 2000, url: 2000, notes: 200000, entries: 5000 };
const DPAPI_ENTROPY = 'Box-Deckspitter secure notes device key v1';

const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64');
const fail = (message, code = 'error') => Object.assign(new Error(message), { code });

function slowKdf(message, salt, p = KDF) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(String(message).normalize('NFC'), 'utf8'), salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: 160 * p.N * p.r }, (err, key) => (err ? reject(err) : resolve(Buffer.from(key))));
  });
}
const hkdf = (ikm, salt, info) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 32));

function seal(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct) };
}
function open(key, box, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, unb64(box.iv));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(unb64(box.tag));
  return Buffer.concat([d.update(unb64(box.ct)), d.final()]); // throws if the key is wrong or the data was changed
}

/** Linux: the system keyring (GNOME Keyring, KWallet…) through Electron's safeStorage. With no keyring Electron
 *  falls back to a fixed built-in key ("basic_text"), which protects nothing, so that counts as no keyring. */
const NO_KEYRING = 'Secure notes need the system keyring (GNOME Keyring or KWallet), and none is running.';
function keyring() {
  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable() || /^basic/.test(safeStorage.getSelectedStorageBackend?.() || '')) throw fail(NO_KEYRING, 'platform');
  return safeStorage;
}
/** Can the device key be sealed here? null if so, else why not. */
function sealProblem() {
  if (process.platform === 'win32') return null;
  if (process.platform !== 'linux') return 'Secure notes need Windows or Linux.';
  try { keyring(); return null; } catch (e) { return e.message; }
}
/** The device key sealed to this computer's account: "2:" DPAPI on Windows, "3:" the keyring on Linux. */
async function sealDevice(key) {
  if (process.platform === 'win32') return '2:' + b64(await dpapi('protect', key));
  return '3:' + b64(keyring().encryptString(b64(key)));
}
async function openDevice(saved) {
  if (saved.startsWith('2:') && process.platform === 'win32') return dpapi('unprotect', unb64(saved.slice(2)), DPAPI_ENTROPY);
  if (saved.startsWith('3:') && process.platform !== 'win32') return unb64(keyring().decryptString(unb64(saved.slice(2))));
  throw new Error('sealed on another system');
}

/** Windows DPAPI (current user) through PowerShell. Data goes over stdin/stdout, never on the command line. */
function dpapi(op, buf, entropy = DPAPI_ENTROPY) {
  if (process.platform !== 'win32') return Promise.reject(fail('Secure notes need Windows.', 'platform'));
  const fn = op === 'protect' ? 'Protect' : 'Unprotect';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $e=[Text.Encoding]::UTF8.GetBytes('${entropy}'); $o=[Security.Cryptography.ProtectedData]::${fn}($in,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))`;
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(e));
    p.on('close', (code) => (code === 0 && out ? resolve(unb64(out.trim())) : reject(fail(err.trim().split('\n')[0] || `DPAPI ${op} failed`, 'dpapi'))));
    p.stdin.end(b64(buf));
  });
}

/** Text on the clipboard that Windows clipboard history (Win+V) and cloud clipboard skip. */
function secureClipboardWrite(text) {
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())); $d=New-Object System.Windows.Forms.DataObject; $d.SetData([System.Windows.Forms.DataFormats]::UnicodeText,$t); foreach($f in 'ExcludeClipboardContentFromMonitorProcessing','CanIncludeInClipboardHistory','CanUploadToCloudClipboard'){ $d.SetData($f,(New-Object IO.MemoryStream(,[byte[]](0,0,0,0)))) }; [System.Windows.Forms.Clipboard]::SetDataObject($d,$true)`;
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(false); return; }
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
    p.stdin.end(b64(Buffer.from(String(text), 'utf8')));
  });
}

/** The secure key: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX, 24 random letters/numbers without look-alikes (no O, 0, I, 1), ~120 bits. */
const KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 characters: every random byte maps evenly
const KEY_DAYS = 30;
function newSecureKey() {
  const bytes = crypto.randomBytes(24);
  let out = '';
  for (let i = 0; i < 24; i++) out += KEY_CHARS[bytes[i] % 32];
  return out.match(/.{4}/g).join('-');
}
/** Dashes, spaces and case don't matter. */
const normKey = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const clean = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
/** A PIN: 4–32 letters, numbers or symbols, no spaces. */
const PIN_RE = /^\S{4,32}$/u;
const badPin = () => fail('A PIN is 4 to 32 letters, numbers or symbols (no spaces).', 'weakpin');

/** SHA-256 of a key file (the page only passes its path; the file is read here). */
function keyFileHash(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw fail('Choose your key file.', 'keyfile');
  let st;
  try { st = fs.statSync(p); } catch { throw fail('The key file isn’t there (is the USB stick plugged in?).', 'keyfile'); }
  if (!st.isFile() || st.size < 32 || st.size > 1024 * 1024) throw fail('That isn’t a key file.', 'keyfile');
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest();
}

module.exports = function createSecureNotes({ dir, clipboard, onLockChange = () => {} }) {
  const FILE = path.join(dir, 'notes.bdsv');
  const DEVICE = path.join(dir, 'device.key');
  const BACKUPS = path.join(dir, 'backups');

  let dk = null; // data key (unlocked only)
  let vaultId = null; // which file the key belongs to (an import may swap the file underneath)
  let data = null; // decrypted notes (unlocked only)
  let pinWrap = null; // data key wrapped with the PIN, kept in memory while locked
  let pinFails = 0;
  let passFails = 0;
  let pending = null; // opened, but waiting for the 30-day secure key check
  let keyFails = 0;
  let idle = null;
  let busy = Promise.resolve();
  let clipTimer = null;

  const exists = () => fs.existsSync(FILE);
  const readFile = () => {
    let f;
    try { f = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { throw fail('The Secure notes file is damaged or unreadable. Older copies are in data\\secure-notes\\backups.', 'damaged'); }
    if (f.magic !== MAGIC || f.v !== 1 || !f.pass || !f.data) throw fail('That isn’t a Secure notes file.', 'damaged');
    return f;
  };

  /** Atomic write (temp file + rename), keeping the last 10 versions. */
  function writeFile(f) {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(FILE)) {
      fs.mkdirSync(BACKUPS, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.copyFileSync(FILE, path.join(BACKUPS, `notes-${stamp}.bdsv`)); } catch { /* best effort */ }
      const old = fs.readdirSync(BACKUPS).filter((n) => n.endsWith('.bdsv')).sort();
      for (const n of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.rmSync(path.join(BACKUPS, n), { force: true });
    }
    const tmp = FILE + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(f)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, FILE);
  }

  async function deviceKey({ create = false } = {}) {
    if (create) {
      const key = crypto.randomBytes(32);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(DEVICE)) fs.copyFileSync(DEVICE, DEVICE + '.old');
      fs.writeFileSync(DEVICE, await sealDevice(key));
      return key;
    }
    if (!fs.existsSync(DEVICE)) throw fail('This PC’s key for Secure notes is missing. Open them with your secure key.', 'device');
    try {
      const saved = fs.readFileSync(DEVICE, 'utf8').trim();
      const key = await openDevice(saved);
      if (key.length !== 32) throw new Error('bad key');
      return key;
    } catch (e) {
      if (e.code === 'platform') throw e;
      throw fail('These Secure notes were set up on another PC or account, so they can’t be opened here with the passphrase. Open them with your secure key.', 'device');
    }
  }

  async function passSlot(pass, device, salt = crypto.randomBytes(16), keyHash = null) {
    const k = hkdf(Buffer.concat([await slowKdf(pass, salt), device, keyHash || Buffer.alloc(0)]), salt, 'bds secure notes: pass slot');
    return { salt, k };
  }
  /** The key file's hash when this vault uses one (asked for by the page with the passphrase). */
  const slotKeyHash = (f, keyFile) => (f.keyfile ? keyFileHash(keyFile) : null);
  /** Secure key slot: the key and the PIN together (an empty PIN when none is set). */
  async function secureKeySlotKey(code, pin, salt) {
    return hkdf(await slowKdf(`${normKey(code)}\u0000${pin || ''}`, salt), salt, 'bds secure notes: secure key slot');
  }
  async function makeSecureKeySlot(f) {
    const rsalt = crypto.randomBytes(16);
    const rk = await secureKeySlotKey(data.secureKey, data.pin, rsalt);
    f.recovery = { salt: b64(rsalt), withPin: !!data.pin, ...seal(rk, dk, 'recovery') };
  }

  /** The notes inside the file; a changed or damaged file fails here (GCM checks every byte). */
  function decryptData(f, key) {
    let out;
    try { out = JSON.parse(open(key, f.data, 'data').toString('utf8')); } catch { throw fail('The Secure notes file was changed or damaged, so it won’t open. Older copies are in data\\secure-notes\\backups.', 'damaged'); }
    out.entries = out.entries || [];
    out.settings = out.settings || { autoLockMin: 5 };
    return out;
  }

  function encryptData(f) {
    f.data = seal(dk, Buffer.from(JSON.stringify(data), 'utf8'), 'data');
    f.saved = Date.now();
    return f;
  }
  function save() {
    if (!dk || !data) throw fail('Secure notes are locked.', 'locked');
    const f = readFile();
    // never write this key's notes over a different vault file
    if (f.id !== vaultId) { lock({ hard: true, reason: 'replaced' }); throw fail('The Secure notes file was replaced. Unlock it again.', 'replaced'); }
    writeFile(encryptData(f));
  }

  async function makePinWrap() {
    pinWrap = null;
    pinFails = 0;
    if (!data?.pin || !dk) return;
    const salt = crypto.randomBytes(16);
    const k = hkdf(await slowKdf(data.pin, salt, PIN_KDF), salt, 'bds secure notes: pin');
    pinWrap = { salt, box: seal(k, dk, 'pin'), id: vaultId };
  }

  function afterUnlock() {
    passFails = 0;
    touch();
    onLockChange(true);
  }

  /** Days until the secure key has to be typed again (0 = now). A clock that went backwards counts as due. */
  function keyDueIn(d) {
    const now = Date.now();
    if (!d.keyCheckedAt || (d.lastSeen && now < d.lastSeen - 60000)) return 0;
    return Math.max(0, KEY_DAYS - (now - d.keyCheckedAt) / 86400000);
  }

  /** The last step of every way in: open now, or hold the notes until the secure key is checked. */
  function finishOpen(f, key, { keyChecked = false } = {}) {
    const d = decryptData(f, key);
    dk = key;
    vaultId = f.id;
    if (keyChecked) d.keyCheckedAt = Date.now();
    if (!d.secureKey || keyDueIn(d) > 0) {
      data = d;
      // remember the latest time seen (catches a clock set backwards); written at most hourly
      if (keyChecked || !data.lastSeen || Date.now() - data.lastSeen > 3600000) {
        data.lastSeen = Math.max(Date.now(), data.lastSeen || 0);
        try { save(); } catch { /* the timestamps can wait */ }
      }
      afterUnlock();
      return { ok: true };
    }
    pending = d; // the key is in memory but nothing is readable until confirmKey
    keyFails = 0;
    return { ok: true, needsKey: true };
  }

  function lock({ hard = false, reason = 'manual' } = {}) {
    const was = !!data || !!pending;
    pending = null;
    if (hard) { pinWrap = null; pinFails = 0; }
    if (dk) dk.fill(0);
    dk = null;
    data = null;
    clearTimeout(idle);
    if (was || hard) onLockChange(false, reason);
  }

  function touch() {
    clearTimeout(idle);
    if (!data) return;
    const min = Number(data.settings?.autoLockMin ?? 5);
    if (min > 0) idle = setTimeout(() => lock({ reason: 'idle' }), min * 60000);
  }

  /** Slow down guessing the passphrase in the app: 1 s, 2 s, 4 s … up to 30 s after a few wrong tries. */
  const passDelay = () => (passFails >= 3 ? new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** (passFails - 3)))) : null);

  const entryView = (e) => ({ id: e.id, title: e.title, username: e.username, url: e.url, notes: e.notes, hasPassword: !!e.password, created: e.created, updated: e.updated });
  const findEntry = (id) => {
    const e = data?.entries.find((x) => x.id === id);
    if (!e) throw fail('That note isn’t there any more.', 'missing');
    return e;
  };

  async function copyToClipboard(text) {
    if (!text) return { ok: false };
    const secure = await secureClipboardWrite(text);
    if (!secure) clipboard.writeText(text); // fallback: still cleared below, just not hidden from Win+V
    clearTimeout(clipTimer);
    clipTimer = setTimeout(() => { try { if (clipboard.readText() === text) clipboard.clear(); } catch { /* ignore */ } }, CLIPBOARD_CLEAR_MS);
    return { ok: true, secure, clearsIn: CLIPBOARD_CLEAR_MS / 1000 };
  }

  const ops = {
    status: async () => ({
      exists: exists(),
      secureKeyNeedsPin: exists() ? (() => { try { return !!readFile().recovery?.withPin; } catch { return false; } })() : false,
      keyFile: exists() ? (() => { try { return !!readFile().keyfile; } catch { return false; } })() : false,
      unlocked: !!data,
      needsKey: !!pending,
      keyDueDays: data && data.secureKey ? Math.ceil(keyDueIn(data)) : null,
      pinReady: !data && !pending && !!pinWrap,
      pinSet: data ? !!data.pin : !!pinWrap,
      autoLockMin: data ? Number(data.settings?.autoLockMin ?? 5) : null,
      count: data ? data.entries.length : null,
      platform: !sealProblem(),
      platformNote: sealProblem(),
    }),

    create: async ({ passphrase, pin }) => {
      if (exists()) throw fail('Secure notes are already set up.', 'exists');
      if (typeof passphrase !== 'string' || passphrase.length < 10) throw fail('Use a passphrase of at least 10 characters.', 'weak');
      if (!PIN_RE.test(String(pin ?? ''))) throw badPin();
      const device = await deviceKey({ create: true });
      const key = crypto.randomBytes(32);
      const code = newSecureKey();
      const { salt, k } = await passSlot(passphrase, device);
      dk = key;
      data = { entries: [], settings: { autoLockMin: 5 }, pin: String(pin), secureKey: normKey(code), keyCheckedAt: Date.now(), lastSeen: Date.now() };
      const f = {
        magic: MAGIC, v: 1, id: crypto.randomBytes(12).toString('hex'), created: Date.now(), kdf: { alg: 'scrypt', ...KDF },
        pass: { salt: b64(salt), ...seal(k, key, 'pass') },
      };
      await makeSecureKeySlot(f);
      vaultId = f.id;
      writeFile(encryptData(f));
      await makePinWrap();
      afterUnlock();
      return { secureKey: code };
    },

    unlock: async ({ passphrase, keyFile }) => {
      await passDelay();
      const f = readFile();
      const kh = slotKeyHash(f, keyFile);
      const device = await deviceKey();
      const { k } = await passSlot(String(passphrase || ''), device, unb64(f.pass.salt), kh);
      let key;
      try { key = open(k, f.pass, 'pass'); } catch { passFails++; throw fail(f.keyfile ? 'Wrong passphrase, or not the right key file.' : 'Wrong passphrase.', 'wrong'); }
      const r = finishOpen(f, key);
      const d = data || pending;
      // the PIN re-lock is ready either way (it wraps the key, not the notes)
      if (d?.pin) { const keep = data; data = d; await makePinWrap(); data = keep; }
      return r;
    },

    unlockPin: async ({ pin }) => {
      if (!pinWrap) throw fail('Use your passphrase.', 'nopin');
      const k = hkdf(await slowKdf(String(pin || ''), pinWrap.salt, PIN_KDF), pinWrap.salt, 'bds secure notes: pin');
      let key;
      try { key = open(k, pinWrap.box, 'pin'); } catch {
        pinFails++;
        if (pinFails >= MAX_PIN_FAILS) { pinWrap = null; pinFails = 0; throw fail('Too many wrong PINs. Use your passphrase.', 'pinlocked'); }
        throw fail(`Wrong PIN. ${MAX_PIN_FAILS - pinFails} ${MAX_PIN_FAILS - pinFails === 1 ? 'try' : 'tries'} left before the passphrase is needed.`, 'wrong');
      }
      const f = readFile();
      if (f.id !== pinWrap.id) { pinWrap = null; throw fail('The Secure notes file was replaced. Use the passphrase.', 'replaced'); }
      pinFails = 0;
      return finishOpen(f, key);
    },

    /** New PC or fresh copy: secure key (+ PIN if one is set) opens the notes and binds them to this PC with a passphrase. */
    recover: async ({ code, pin, passphrase }) => {
      if (typeof passphrase !== 'string' || passphrase.length < 10) throw fail('Use a passphrase of at least 10 characters.', 'weak');
      await passDelay();
      const f = readFile();
      if (!f.recovery) throw fail('This file has no secure key.', 'norecovery');
      let key;
      try { key = open(await secureKeySlotKey(code, f.recovery.withPin ? String(pin || '') : '', unb64(f.recovery.salt)), f.recovery, 'recovery'); } catch {
        passFails++;
        throw fail(f.recovery.withPin ? 'That secure key and PIN don’t match.' : 'That secure key doesn’t match.', 'wrong');
      }
      const device = await deviceKey({ create: true }); // this PC's own key from now on
      const { salt, k } = await passSlot(passphrase, device);
      f.pass = { salt: b64(salt), ...seal(k, key, 'pass') };
      delete f.keyfile; // recovering may be because the key file was lost: add a new one in the settings
      writeFile(f);
      const r = finishOpen(f, key, { keyChecked: true });
      await makePinWrap();
      return r;
    },

    /** The 30-day check: the secure key opens the held notes and starts another 30 days. */
    confirmKey: async ({ code }) => {
      if (!pending) throw fail('Nothing is waiting for the secure key.', 'nokey');
      await (keyFails >= 3 ? new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** (keyFails - 3)))) : null);
      const a = Buffer.from(normKey(code));
      const b = Buffer.from(pending.secureKey);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        keyFails++;
        if (keyFails >= 5) { lock({ hard: true, reason: 'keyfails' }); throw fail('Too many wrong secure keys. Locked — start again with your passphrase.', 'keylocked'); }
        throw fail('That isn’t the secure key.', 'wrong');
      }
      data = pending;
      pending = null;
      keyFails = 0;
      data.keyCheckedAt = Date.now();
      data.lastSeen = Date.now();
      save();
      afterUnlock();
      return { ok: true };
    },

    lock: async ({ hard = false } = {}) => { lock({ hard, reason: 'manual' }); return { ok: true }; },
    touch: async () => { touch(); return { ok: true }; },

    list: async () => {
      if (!data) throw fail('Secure notes are locked.', 'locked');
      touch();
      return { entries: data.entries.map(entryView), settings: { autoLockMin: Number(data.settings?.autoLockMin ?? 5) }, pinSet: !!data.pin };
    },

    reveal: async ({ id }) => {
      if (!data) throw fail('Secure notes are locked.', 'locked');
      touch();
      return { password: findEntry(id).password || '' };
    },

    copy: async ({ id, field }) => {
      if (!data) throw fail('Secure notes are locked.', 'locked');
      touch();
      const e = findEntry(id);
      const text = field === 'username' ? e.username : field === 'url' ? e.url : e.password;
      return copyToClipboard(text || '');
    },
    copyText: async ({ text }) => copyToClipboard(String(text || '').slice(0, 200)),

    saveEntry: async ({ entry }) => {
      if (!data) throw fail('Secure notes are locked.', 'locked');
      touch();
      const now = Date.now();
      let e = entry.id ? data.entries.find((x) => x.id === entry.id) : null;
      if (!e) {
        if (data.entries.length >= LIMITS.entries) throw fail('That’s the most notes Secure notes can hold.', 'full');
        e = { id: crypto.randomBytes(9).toString('hex'), created: now, title: '', username: '', password: '', url: '', notes: '' };
        data.entries.unshift(e);
      }
      for (const k of ['title', 'username', 'url', 'notes']) if (k in entry) e[k] = clean(entry[k], LIMITS[k]);
      if (typeof entry.password === 'string') e.password = clean(entry.password, LIMITS.password); // left out = unchanged
      e.updated = now;
      save();
      return { entry: entryView(e) };
    },

    removeEntry: async ({ id }) => {
      if (!data) throw fail('Secure notes are locked.', 'locked');
      touch();
      data.entries = data.entries.filter((x) => x.id !== id);
      save();
      return { ok: true };
    },

    setPin: async ({ pin }) => {
      if (!data) throw fail('Secure notes are locked.', 'locked');
      if (pin != null && !PIN_RE.test(String(pin))) throw badPin();
      data.pin = pin == null ? null : String(pin);
      // the secure key slot includes the PIN, so it's re-made with the new one
      const f = readFile();
      if (f.id !== vaultId) { lock({ hard: true, reason: 'replaced' }); throw fail('The Secure notes file was replaced. Unlock it again.', 'replaced'); }
      if (data.secureKey) await makeSecureKeySlot(f);
      writeFile(encryptData(f));
      await makePinWrap();
      return { ok: true, pinSet: !!data.pin };
    },

    setAutoLock: async ({ minutes }) => {
      if (!data) throw fail('Secure notes are locked.', 'locked');
      data.settings = { ...data.settings, autoLockMin: Math.max(0, Math.min(240, Number(minutes) || 0)) };
      save();
      touch();
      return { ok: true };
    },

    /** Re-wrap the pass slot: new passphrase and/or key file on or off. Always needs the current passphrase (and key file). */
    rekey: async ({ current, keyFile, passphrase, newKeyFile }) => {
      if (!data) throw fail('Secure notes are locked.', 'locked');
      if (passphrase != null && (typeof passphrase !== 'string' || passphrase.length < 10)) throw fail('Use a passphrase of at least 10 characters.', 'weak');
      await passDelay();
      const f = readFile();
      const device = await deviceKey();
      const { k: oldK } = await passSlot(String(current || ''), device, unb64(f.pass.salt), slotKeyHash(f, keyFile));
      try { open(oldK, f.pass, 'pass'); } catch { passFails++; throw fail(f.keyfile ? 'Your current passphrase or key file is wrong.' : 'Your current passphrase is wrong.', 'wrong'); }
      // newKeyFile: undefined = keep as is, null = stop using one, a path = make a new key file there
      let kh = f.keyfile ? keyFileHash(keyFile) : null;
      let made = null;
      if (newKeyFile === null) kh = null;
      else if (typeof newKeyFile === 'string') {
        if (!path.isAbsolute(newKeyFile)) throw fail('Choose where to save the key file.', 'keyfile');
        if (fs.existsSync(newKeyFile)) throw fail('A file with that name is already there. Pick a new name.', 'keyfile');
        const bytes = crypto.randomBytes(64);
        fs.writeFileSync(newKeyFile, bytes, { flag: 'wx' });
        kh = crypto.createHash('sha256').update(bytes).digest();
        made = newKeyFile;
      }
      const { salt, k } = await passSlot(passphrase ?? String(current), device, undefined, kh);
      f.pass = { salt: b64(salt), ...seal(k, dk, 'pass') };
      if (kh) f.keyfile = true; else delete f.keyfile;
      writeFile(encryptData(f));
      passFails = 0;
      return { ok: true, keyFile: !!kh, made };
    },
  };

  /** One request from the page. Requests run one at a time so saves can't interleave. */
  function handle(req) {
    const op = ops[req?.op];
    if (!op) return Promise.resolve({ ok: false, error: 'Unknown request', code: 'bad' });
    const run = busy.then(() => op(req)).then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, error: e.message || String(e), code: e.code || 'error' }));
    busy = run.catch(() => {});
    return run;
  }

  return { handle, lock: (o) => lock(o), get unlocked() { return !!data; } };
};

// for tests
module.exports._internal = { slowKdf, seal, open, dpapi, newSecureKey, normKey };
