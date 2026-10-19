// data/secrets.json: the API keys, tokens and email app passwords, sealed to this computer's account.

'use strict';

const { spawn } = require('child_process');
const fsp = require('fs').promises;
const path = require('path');

module.exports = function createSecrets({ APP_NAME, DATA, IS_WIN, readJSON, writeJSON }) {
  // data/secrets.json holds the API keys, tokens and email app passwords. On Windows it's sealed with DPAPI under this
  // Windows account ({ "dpapi": "…" }); elsewhere with the system keyring through the app window's safeStorage
  // ({ "keyring": "…" }). Either way the file is useless copied anywhere else. Read once, then kept in memory.
  // (Run without the app window, as plain node server.js, it can only be kept as plain text.)
  const SECRETS_FILE = path.join(DATA, 'secrets.json');
  const SECRETS_ENTROPY = 'Box-Deckspitter secrets v1';
  let secretsCache = null;
  let secretsUnreadable = false; // sealed on another PC or Windows account: left alone until new ones are saved

  /** Windows DPAPI (current user) through PowerShell. Data goes over stdin/stdout, never on the command line. */
  function dpapi(op, buf, entropy = SECRETS_ENTROPY) {
    const fn = op === 'protect' ? 'Protect' : 'Unprotect';
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $e=[Text.Encoding]::UTF8.GetBytes('${entropy}'); $o=[Security.Cryptography.ProtectedData]::${fn}($in,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))`;
    return new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      ps.stdout.on('data', (d) => { out += d; });
      ps.stderr.on('data', (d) => { err += d; });
      ps.on('error', reject);
      ps.on('close', (code) => (code === 0 && out ? resolve(Buffer.from(out.trim(), 'base64')) : reject(new Error(err.trim().split('\n')[0] || `DPAPI ${op} failed`))));
      ps.stdin.end(buf.toString('base64'));
    });
  }

  /** The system keyring, through the app window (shell.js): it alone can reach Electron's safeStorage. */
  const waits = new Map();
  let seq = 0;
  let weakWarned = false;
  if (!IS_WIN && typeof process.send === 'function') {
    process.on('message', (m) => {
      const w = m && m.type === 'sealed' && waits.get(m.id);
      if (!w) return;
      waits.delete(m.id);
      if (m.weak && !weakWarned) { weakWarned = true; console.warn(`[${APP_NAME}] no system keyring (GNOME Keyring or KWallet) is running: secrets.json is only lightly scrambled`); }
      if (m.ok) w.resolve(Buffer.from(m.data, 'base64')); else w.reject(new Error(m.error || 'the keyring said no'));
    });
  }
  const canKeyring = () => !IS_WIN && typeof process.send === 'function' && process.connected !== false;
  function keyring(op, buf) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waits.set(id, { resolve, reject });
      process.send({ type: 'seal', id, op, data: buf.toString('base64') });
      setTimeout(() => { if (waits.delete(id)) reject(new Error('the keyring didn’t answer')); }, 30000);
    });
  }
  const unseal = (raw) => (typeof raw.dpapi === 'string' ? dpapi('unprotect', Buffer.from(raw.dpapi, 'base64'))
    : canKeyring() ? keyring('unprotect', Buffer.from(raw.keyring, 'base64')) : Promise.reject(new Error('the keyring needs the app window')));

  async function loadSecrets() {
    const raw = readJSON(SECRETS_FILE, {});
    if (typeof raw.dpapi === 'string' || typeof raw.keyring === 'string') {
      try { secretsCache = JSON.parse((await unseal(raw)).toString('utf8')); } catch (e) {
        console.error(`[${APP_NAME}] secrets.json was sealed on another PC or account; keys and passwords need entering again (${e.message})`);
        secretsCache = {};
        secretsUnreadable = true;
        return;
      }
      return;
    }
    secretsCache = raw;
    // from before 1.0.45 (or saved without the app window): plain text, sealed now
    if ((IS_WIN || canKeyring()) && Object.keys(raw).length) await saveSecrets(raw).catch((e) => console.error(`[${APP_NAME}] couldn't seal secrets.json: ${e.message}`));
  }
  const secretsReady = loadSecrets().catch((e) => { console.error(e); secretsCache ||= {}; });

  function secrets() { return secretsCache || {}; }

  async function saveSecrets(value) {
    const clean = JSON.parse(JSON.stringify(value || {})); // drops the keys set to undefined
    secretsCache = clean;
    if (!IS_WIN && !canKeyring()) return writeJSON(SECRETS_FILE, clean);
    let sealed;
    try { sealed = (await (IS_WIN ? dpapi : keyring)('protect', Buffer.from(JSON.stringify(clean), 'utf8'))).toString('base64'); } catch (e) {
      // can't seal (PowerShell blocked? no keyring?): keeping the keys beats losing them
      console.error(`[${APP_NAME}] couldn't seal secrets.json, saved as plain text: ${e.message}`);
      return writeJSON(SECRETS_FILE, clean);
    }
    if (secretsUnreadable) {
      await fsp.copyFile(SECRETS_FILE, path.join(DATA, `secrets.unreadable-${Date.now()}.json`)).catch(() => {});
      secretsUnreadable = false;
    }
    return writeJSON(SECRETS_FILE, IS_WIN ? { v: 2, dpapi: sealed } : { v: 3, keyring: sealed });
  }

  return { secretsReady, secrets, saveSecrets };
};
