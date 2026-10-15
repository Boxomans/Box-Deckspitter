// data/secrets.json: the API keys, tokens and email app passwords, sealed to this Windows account.

'use strict';

const { spawn } = require('child_process');
const fsp = require('fs').promises;
const path = require('path');

module.exports = function createSecrets({ APP_NAME, DATA, IS_WIN, readJSON, writeJSON }) {
  // data/secrets.json holds the API keys, tokens and email app passwords. On Windows it's sealed with DPAPI under this
  // Windows account ({ "dpapi": "…" }), so the file is useless copied anywhere else. Read once, then kept in memory.
  const SECRETS_FILE = path.join(DATA, 'secrets.json');
  const SECRETS_ENTROPY = 'Box-DocSpitter secrets v1';
  let secretsCache = null;
  let secretsUnreadable = false; // sealed on another PC or Windows account: left alone until new ones are saved

  /** Windows DPAPI (current user) through PowerShell. Data goes over stdin/stdout, never on the command line. */
  function dpapi(op, buf) {
    const fn = op === 'protect' ? 'Protect' : 'Unprotect';
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $e=[Text.Encoding]::UTF8.GetBytes('${SECRETS_ENTROPY}'); $o=[Security.Cryptography.ProtectedData]::${fn}($in,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))`;
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

  async function loadSecrets() {
    const raw = readJSON(SECRETS_FILE, {});
    if (typeof raw.dpapi === 'string') {
      try { secretsCache = JSON.parse((await dpapi('unprotect', Buffer.from(raw.dpapi, 'base64'))).toString('utf8')); } catch (e) {
        console.error(`[${APP_NAME}] secrets.json was sealed on another PC or Windows account; keys and passwords need entering again (${e.message})`);
        secretsCache = {};
        secretsUnreadable = true;
      }
      return;
    }
    secretsCache = raw;
    // from before 1.0.45: plain text, sealed now
    if (IS_WIN && Object.keys(raw).length) await saveSecrets(raw).catch((e) => console.error(`[${APP_NAME}] couldn't seal secrets.json: ${e.message}`));
  }
  const secretsReady = loadSecrets().catch((e) => { console.error(e); secretsCache ||= {}; });

  function secrets() { return secretsCache || {}; }

  async function saveSecrets(value) {
    const clean = JSON.parse(JSON.stringify(value || {})); // drops the keys set to undefined
    secretsCache = clean;
    if (!IS_WIN) return writeJSON(SECRETS_FILE, clean);
    let sealed;
    try { sealed = (await dpapi('protect', Buffer.from(JSON.stringify(clean), 'utf8'))).toString('base64'); } catch (e) {
      // can't seal (PowerShell blocked?): keeping the keys beats losing them
      console.error(`[${APP_NAME}] couldn't seal secrets.json, saved as plain text: ${e.message}`);
      return writeJSON(SECRETS_FILE, clean);
    }
    if (secretsUnreadable) {
      await fsp.copyFile(SECRETS_FILE, path.join(DATA, `secrets.unreadable-${Date.now()}.json`)).catch(() => {});
      secretsUnreadable = false;
    }
    return writeJSON(SECRETS_FILE, { dpapi: sealed });
  }

  return { secretsReady, secrets, saveSecrets };
};
