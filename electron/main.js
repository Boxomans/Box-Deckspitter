// Box-DocSpitter boot file. It does three small jobs and then loads the real app window (shell.js):
//   1. installs an update the app downloaded (data/update/pending.json), backing up every file it replaces;
//   2. watches that the updated version actually starts (the page reports "ready") and, if it doesn't,
//      puts the previous version back and restarts it;
//   3. "--rollback" on the command line restores the most recent backup by hand.
// The in-app updater never replaces this file, so a broken update can't break the way back.
// Only Node's own fs/path are used here: nothing that an update could change.

'use strict';

const { app, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const UPD = path.join(DATA, 'update');
const BACKUPS = path.join(DATA, 'backups', 'app');
const PENDING = path.join(UPD, 'pending.json');
const TRIAL = path.join(UPD, 'trial.json');
const RESULT = path.join(UPD, 'result.json');
const INSTALLED = path.join(UPD, 'installed.json');
const ROLLBACK_FLAG = path.join(UPD, 'rollback.flag'); // written by Settings → Updates → "Go back"
const READY_TIMEOUT = 90 * 1000;

// Paths an update may never touch, whatever the download says.
const PROTECTED = [/^data(\/|$)/i, /^(image|media|doc|audio)-dump(\/|$)/i, /^node_modules(\/|$)/i, /^\.git(\/|$)/i, /^\.claude(\/|$)/i, /^electron\/main\.js$/i, /\.lnk$/i, /^box-docspitter\.exe$/i];
const isSafeRel = (rel) => typeof rel === 'string' && rel.length > 0 && rel.length < 400 && !rel.includes('\0') && !path.isAbsolute(rel)
  && !/^[a-z]:/i.test(rel) && !rel.split(/[\\/]/).includes('..') && !PROTECTED.some((re) => re.test(rel.replace(/\\/g, '/')));
const abs = (rel) => path.join(ROOT, ...rel.split(/[\\/]/));

const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJSON(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2));
  fs.renameSync(f + '.tmp', f);
}
const rm = (f) => { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* ignore */ } };
const log = (m) => { try { console.log(`[Box-DocSpitter boot] ${m}`); } catch { /* no console */ } };

/** Replace one file without ever leaving it half-written. */
function putFile(src, rel) {
  const dest = abs(rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.bds-new';
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
}

/** Put a backup back: restore every saved file and delete the files the update added. */
function restore(backupDir) {
  const man = readJSON(path.join(backupDir, 'manifest.json'));
  if (!man) throw new Error('backup manifest missing');
  for (const rel of man.saved || []) if (isSafeRel(rel)) putFile(path.join(backupDir, 'files', ...rel.split('/')), rel);
  for (const rel of man.added || []) if (isSafeRel(rel)) rm(abs(rel));
  return man;
}

/** Install a staged update. Any failure restores what was already replaced. */
function apply(pending) {
  const staging = pending.staging;
  const files = (pending.files || []).filter(isSafeRel);
  const removed = (pending.removed || []).filter(isSafeRel);
  if (!staging || !fs.existsSync(staging) || !files.length) throw new Error('the downloaded update is incomplete');
  for (const rel of files) if (!fs.existsSync(path.join(staging, ...rel.split('/')))) throw new Error(`the download is missing ${rel}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(BACKUPS, `${pending.from}-to-${pending.version}-${stamp}`);
  const man = { from: pending.from, version: pending.version, at: Date.now(), saved: [], added: [] };
  fs.mkdirSync(path.join(backupDir, 'files'), { recursive: true });
  // back up everything first, before changing anything
  for (const rel of [...files, ...removed]) {
    const cur = abs(rel);
    if (fs.existsSync(cur) && fs.statSync(cur).isFile()) {
      const b = path.join(backupDir, 'files', ...rel.split('/'));
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.copyFileSync(cur, b);
      man.saved.push(rel);
    } else if (files.includes(rel)) man.added.push(rel);
  }
  writeJSON(path.join(backupDir, 'manifest.json'), man);
  // a plain list for "Restore previous version.bat", which works even if nothing else does
  fs.writeFileSync(path.join(backupDir, 'added.txt'), man.added.map((r) => r.replace(/\//g, '\\')).join('\r\n'));
  try {
    for (const rel of files) putFile(path.join(staging, ...rel.split('/')), rel);
    for (const rel of removed) rm(abs(rel));
  } catch (e) {
    try { restore(backupDir); rm(backupDir); } catch (e2) { log('restore after a failed install also failed: ' + e2.message); }
    throw e;
  }
  return { backupDir, files };
}

function latestBackup() {
  try {
    return fs.readdirSync(BACKUPS).map((n) => path.join(BACKUPS, n))
      .filter((d) => fs.existsSync(path.join(d, 'manifest.json')))
      .sort((a, b) => (readJSON(path.join(b, 'manifest.json')).at || 0) - (readJSON(path.join(a, 'manifest.json')).at || 0))[0] || null;
  } catch { return null; }
}

function pruneBackups(keep = 3) {
  try {
    const all = fs.readdirSync(BACKUPS).map((n) => path.join(BACKUPS, n)).filter((d) => fs.existsSync(path.join(d, 'manifest.json')))
      .sort((a, b) => (readJSON(path.join(b, 'manifest.json')).at || 0) - (readJSON(path.join(a, 'manifest.json')).at || 0));
    for (const d of all.slice(keep)) rm(d);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- startup

// The single-instance lock lives in Electron's data folder, so that has to point inside the app folder first
// (portable: nothing in %APPDATA%). A factory reset can't delete that folder while it's in use, so it finishes here.
app.setName('Box-DocSpitter');
const USER_DATA = path.join(DATA, 'electron');
const RESET_FLAG = path.join(DATA, '.reset-electron');
if (fs.existsSync(RESET_FLAG)) {
  rm(USER_DATA);
  if (!fs.existsSync(USER_DATA)) rm(RESET_FLAG);
}
app.setPath('userData', USER_DATA);
const gotLock = app.requestSingleInstanceLock();
let trial = null;

function rollBack(reason, relaunch) {
  const t = trial || readJSON(TRIAL);
  trial = null;
  rm(TRIAL);
  try {
    const man = restore(t.backup);
    rm(t.backup); // that backup is the version we're back on now; "Go back" should reach the one before
    writeJSON(RESULT, { ok: false, rolledBack: true, version: t.version, from: man.from, reason, at: Date.now(), seen: false });
    log(`update to ${t.version} didn't start (${reason}); back on ${man.from}`);
  } catch (e) {
    writeJSON(RESULT, { ok: false, rolledBack: false, version: t.version, reason: `${reason}; restoring the backup also failed: ${e.message}`, at: Date.now(), seen: false });
    dialog.showErrorBox('Box-DocSpitter', `The update didn't start and the previous version couldn't be put back automatically.\n\nRun "Restore previous version.bat" in the Box-DocSpitter folder.\n\n${e.message}`);
  }
  if (relaunch) { app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--rollback') }); app.exit(0); }
}

if (gotLock) {
  try {
    if (process.argv.includes('--rollback') || fs.existsSync(ROLLBACK_FLAG)) {
      rm(ROLLBACK_FLAG);
      // manual: put the most recent backup back
      const b = latestBackup();
      rm(TRIAL); rm(PENDING);
      if (b) {
        const man = restore(b);
        rm(b);
        writeJSON(RESULT, { ok: true, manualRollback: true, version: man.from, from: man.version, at: Date.now(), seen: false });
      }
    }
    const pending = readJSON(PENDING);
    if (pending) {
      rm(PENDING);
      try {
        const done = apply(pending);
        trial = { version: pending.version, from: pending.from, backup: done.backupDir, files: pending.all || done.files, launches: 0, at: Date.now() };
        writeJSON(TRIAL, trial);
        rm(pending.staging);
        log(`installed ${pending.version}; waiting for it to start`);
      } catch (e) {
        writeJSON(RESULT, { ok: false, rolledBack: true, version: pending.version, from: pending.from, reason: 'install failed: ' + e.message, at: Date.now(), seen: false });
        rm(pending.staging);
      }
    }
    trial = trial || readJSON(TRIAL);
    if (trial) {
      trial.launches = (trial.launches || 0) + 1;
      // a previous start of this version never reported "ready": don't try again, go back
      if (trial.launches > 1) rollBack('it didn’t finish starting last time', false);
      else writeJSON(TRIAL, trial);
    }
  } catch (e) {
    log('update step failed: ' + e.message);
  }
}

global.bdsBoot = {
  gotLock,
  inTrial: () => !!trial,
  /** Called by shell.js when the server dies during startup. Returns true if the boot handled it. */
  fail(reason) {
    if (!trial) return false;
    rollBack(reason, true);
    return true;
  },
};

ipcMain.on('bds:ready', () => {
  if (!trial) return;
  const t = trial;
  trial = null;
  clearTimeout(readyTimer);
  rm(TRIAL);
  writeJSON(INSTALLED, { version: t.version, files: t.files, at: Date.now() });
  writeJSON(RESULT, { ok: true, version: t.version, from: t.from, at: Date.now(), seen: false });
  pruneBackups(3);
  log(`${t.version} started fine`);
});

let readyTimer = null;
if (trial) {
  app.whenReady().then(() => {
    readyTimer = setTimeout(() => { if (trial) rollBack('it didn’t start within 90 seconds', true); }, READY_TIMEOUT);
  });
}

try {
  require('./shell.js');
} catch (e) {
  if (trial) rollBack('the app window code failed to load: ' + e.message, true);
  else {
    app.whenReady().then(() => {
      dialog.showErrorBox('Box-DocSpitter', `Box-DocSpitter couldn't start.\n\n${e.stack || e.message}\n\nIf this started after an update, run "Restore previous version.bat".`);
      app.exit(1);
    });
  }
}
