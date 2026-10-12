// In-app updates from GitHub. This side only checks, downloads, verifies and stages files under
// data/update/; the boot file (electron/main.js) installs them at the next start, keeps a backup of every
// file it replaces, and puts the old version back if the new one doesn't start.
// Never touched by an update: data/, the dumps, node_modules/, .git/, electron/main.js.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_REPO = 'Boxomans/Box-Docspitter';
const BRANCH = 'main';
const MAX_ZIP = 300 * 1024 * 1024;
const PROTECTED = [/^data(\/|$)/i, /^(image|media|doc|audio)-dump(\/|$)/i, /^node_modules(\/|$)/i, /^\.git(\/|$)/i, /^\.claude(\/|$)/i, /^electron\/main\.js$/i, /\.lnk$/i, /^box-docspitter\.exe$/i];
// Files that must be in any real release.
const REQUIRED = ['package.json', 'server.js', 'update-server.js', 'electron/shell.js', 'electron/preload.js', 'public/index.html', 'public/js/app.js'];

const isProtected = (rel) => PROTECTED.some((re) => re.test(rel));
const isUnsafe = (rel) => !rel || rel.includes('\0') || rel.includes('\\') || path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.split('/').some((p) => p === '..' || p === '.');

function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
const err = (status, message) => Object.assign(new Error(message), { status });

module.exports = function createUpdater({ root, data, version, shellMode, secrets, saveSecrets, readJSONBody, newJob, startJob, relaunch, log }) {
  const UPD = path.join(data, 'update');
  const PENDING = path.join(UPD, 'pending.json');
  const RESULT = path.join(UPD, 'result.json');
  const INSTALLED = path.join(UPD, 'installed.json');
  const ROLLBACK_FLAG = path.join(UPD, 'rollback.flag');
  const BACKUPS = path.join(data, 'backups', 'app');
  const pkg = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const repo = () => {
    const url = pkg().repository?.url || pkg().repository || '';
    const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(\.git)?$/i.exec(String(url));
    return m ? m[1] : DEFAULT_REPO;
  };
  const isGitCheckout = () => fs.existsSync(path.join(root, '.git'));
  const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); };
  let lastCheck = null;

  // ---------------------------------------------------------------- GitHub

  async function gh(p, { raw = false } = {}) {
    const token = secrets().githubToken;
    const res = await fetch(`https://api.github.com/repos/${repo()}${p}`, {
      headers: {
        Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
        'User-Agent': 'Box-DocSpitter-updater',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 404) throw err(502, token ? 'GitHub says the repo doesn’t exist, or this token can’t see it.' : 'Can’t see the repo on GitHub. If it’s private, add a GitHub token in Settings → Updates.');
    if (res.status === 401) throw err(502, 'GitHub rejected the token. Check it in Settings → Updates.');
    if (res.status === 403 || res.status === 429) throw err(502, 'GitHub is rate-limiting update checks right now. Try again in a while.');
    if (!res.ok) throw err(502, `GitHub answered ${res.status}.`);
    return raw ? res.text() : res.json();
  }

  async function check() {
    if (process.env.BDS_UPDATE_TEST_ZIP) return checkTestZip(); // development testing only
    const head = await gh(`/commits/${BRANCH}`);
    const sha = head.sha;
    const remotePkg = JSON.parse(await gh(`/contents/package.json?ref=${sha}`, { raw: true }));
    const latest = remotePkg.version;
    const newer = cmpVersion(latest, version) > 0;
    let notes = [];
    let changed = null;
    if (newer) {
      // release notes from the new version's changelog; commit messages if it has none
      try {
        const log = JSON.parse(await gh(`/contents/public/changelog.json?ref=${sha}`, { raw: true }));
        notes = log.filter((e) => cmpVersion(e.version, version) > 0).flatMap((e) => (e.notes || []).map((n) => `${e.version}: ${n}`)).slice(0, 40);
      } catch { /* no changelog */ }
      try {
        const cmp = await gh(`/compare/v${version}...${sha}`);
        if (!notes.length) notes = (cmp.commits || []).map((c) => String(c.commit?.message || '').split('\n')[0]).filter(Boolean).reverse().slice(0, 30);
        changed = (cmp.files || []).map((f) => f.filename);
      } catch { if (!notes.length) notes = [String(head.commit?.message || '').split('\n')[0]]; }
    }
    const warnings = [];
    if (newer && changed?.includes('electron/main.js')) warnings.push('This update changes the app launcher, which can’t be updated from inside the app. Install it by copying the new version over.');
    if (newer && depsMissing(remotePkg).length) warnings.push(`This update needs new libraries (${depsMissing(remotePkg).join(', ')}), which have to be installed by hand.`);
    lastCheck = { sha, latest, newer, at: Date.now() };
    return { current: version, latest, newer, sha: sha.slice(0, 7), notes, warnings, date: head.commit?.committer?.date || null };
  }

  /** Testing the updater without publishing anything: BDS_UPDATE_TEST_ZIP points at a release zip on disk. */
  async function checkTestZip() {
    const JSZip = require(path.join(root, 'node_modules', 'jszip'));
    const zip = await JSZip.loadAsync(fs.readFileSync(process.env.BDS_UPDATE_TEST_ZIP));
    const pj = Object.values(zip.files).find((f) => /^[^/]+\/package\.json$/.test(f.name));
    const latest = JSON.parse(await pj.async('string')).version;
    const newer = cmpVersion(latest, version) > 0;
    lastCheck = { sha: 'test000000000000', latest, newer, at: Date.now() };
    return { current: version, latest, newer, sha: 'test', notes: ['(test release from a local zip)'], warnings: [] };
  }

  /** Dependencies of the new version that this copy's node_modules doesn't already have at that exact version. */
  function depsMissing(newPkg) {
    const missing = [];
    for (const [name, spec] of Object.entries(newPkg.dependencies || {})) {
      const have = readJSON(path.join(root, 'node_modules', ...name.split('/'), 'package.json'));
      const want = String(spec).replace(/^[\^~=]/, '');
      if (!have || have.version !== want) missing.push(`${name}@${want}`);
    }
    return missing;
  }

  async function download(url, job) {
    const token = secrets().githubToken;
    let res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Box-DocSpitter-updater', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30000),
    });
    // the zip lives on codeload.github.com behind a short-lived signed link: follow it without the token
    for (let hops = 0; res.status >= 300 && res.status < 400 && hops < 4; hops++) {
      const next = new URL(res.headers.get('location'), url);
      if (next.protocol !== 'https:' || !/(^|\.)github(usercontent)?\.com$/i.test(next.hostname)) throw err(502, 'The download pointed somewhere other than GitHub; stopped.');
      res = await fetch(next, { redirect: 'manual', headers: { 'User-Agent': 'Box-DocSpitter-updater' }, signal: AbortSignal.timeout(30000) });
    }
    if (!res.ok) throw err(502, `Download failed (${res.status}).`);
    const chunks = [];
    let n = 0;
    for await (const c of res.body) {
      n += c.length;
      if (n > MAX_ZIP) throw err(502, 'The download is far bigger than a release should be; stopped.');
      chunks.push(c);
      job.bytes = n;
    }
    return Buffer.concat(chunks);
  }

  /** Syntax-check JavaScript without running it (ES modules for the page, CommonJS for the server/shell). */
  function syntaxCheck(code, asModule) {
    return new Promise((resolve) => {
      const p = spawn(process.execPath, ['--check', ...(asModule ? ['--input-type=module'] : ['--input-type=commonjs'])], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true,
      });
      let e = '';
      p.stderr.on('data', (d) => { e += d; });
      p.on('error', () => resolve(null)); // can't check: not fatal, the start-up check still catches crashes
      p.on('close', (code2) => resolve(code2 === 0 ? null : e.split('\n').find((l) => /Error/.test(l)) || 'syntax error'));
      p.stdin.end(code);
    });
  }

  async function stage(job) {
    if (!lastCheck?.newer) throw err(400, 'Check for updates first.');
    const { sha, latest } = lastCheck;
    job.label = `Downloading ${latest}`;
    let zipBuf;
    if (process.env.BDS_UPDATE_TEST_ZIP) zipBuf = fs.readFileSync(process.env.BDS_UPDATE_TEST_ZIP); // development testing only
    else zipBuf = await download(`https://api.github.com/repos/${repo()}/zipball/${sha}`, job);
    job.label = 'Checking the download';
    const JSZip = require(path.join(root, 'node_modules', 'jszip'));
    const zip = await JSZip.loadAsync(zipBuf);
    const entries = Object.values(zip.files).filter((f) => !f.dir);
    const prefix = entries[0]?.name.split('/')[0] + '/';
    const files = new Map();
    let launcherDiffers = false;
    for (const f of entries) {
      if (!f.name.startsWith(prefix)) throw err(502, 'The download isn’t laid out like a release; stopped.');
      const rel = f.name.slice(prefix.length);
      if (isUnsafe(rel)) throw err(502, `The download contains an unsafe path (${rel}); stopped.`);
      const buf = await f.async('nodebuffer');
      if (rel === 'electron/main.js') {
        let cur = null;
        try { cur = fs.readFileSync(path.join(root, 'electron', 'main.js')); } catch { /* none */ }
        launcherDiffers = !cur || !cur.equals(buf);
      }
      if (isProtected(rel)) continue;
      files.set(rel, buf);
    }
    for (const r of REQUIRED) if (!files.has(r)) throw err(502, `The download is missing ${r}; stopped.`);
    let newPkg;
    try { newPkg = JSON.parse(files.get('package.json').toString('utf8')); } catch { throw err(502, 'The new package.json is unreadable; stopped.'); }
    if (newPkg.name !== pkg().name) throw err(502, 'The download is a different app; stopped.');
    if (cmpVersion(newPkg.version, version) <= 0) throw err(400, `The download is ${newPkg.version}, which isn’t newer than ${version}.`);
    if (launcherDiffers) throw err(409, 'This update changes the app launcher (electron/main.js), so it has to be installed by copying the new version over, not from inside the app.');
    const missing = depsMissing(newPkg);
    if (missing.length) throw err(409, `This update needs new libraries that aren’t on this PC yet: ${missing.join(', ')}. Install it by copying the new version over (with its node_modules).`);

    job.label = 'Checking the code';
    const js = [...files.keys()].filter((r) => r.endsWith('.js') && !r.startsWith('public/vendor/'));
    for (let i = 0; i < js.length; i += 8) {
      const batch = js.slice(i, i + 8);
      const res = await Promise.all(batch.map((r) => syntaxCheck(files.get(r).toString('utf8'), r.startsWith('public/'))));
      res.forEach((e, k) => { if (e) throw err(502, `${batch[k]} in the new version has an error (${e.trim()}); not installing it.`); });
      job.progress = Math.min(0.95, (i + 8) / js.length);
    }

    job.label = 'Getting it ready';
    const staging = path.join(UPD, `staging-${sha.slice(0, 12)}`);
    await fsp.rm(staging, { recursive: true, force: true });
    const changed = [];
    for (const [rel, buf] of files) {
      let same = false;
      try { same = fs.readFileSync(path.join(root, ...rel.split('/'))).equals(buf); } catch { /* new file */ }
      if (same) continue;
      const out = path.join(staging, ...rel.split('/'));
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await fsp.writeFile(out, buf);
      changed.push(rel);
    }
    // files the previous update installed that this release no longer has
    const prev = readJSON(INSTALLED);
    const removed = (prev?.files || []).filter((r) => !files.has(r) && !isProtected(r) && !isUnsafe(r));
    const pending = { version: newPkg.version, from: version, sha, staging, files: changed, all: [...files.keys()], removed, at: Date.now() };
    writeJSON(PENDING, pending);
    job.result = { version: newPkg.version, changed: changed.length, removed: removed.length };
    log(`update ${newPkg.version} staged: ${changed.length} files to replace, ${removed.length} to remove`);
  }

  function blockReason() {
    if (!shellMode) return 'Updates install from the Box-DocSpitter app window, not a browser tab.';
    if (isGitCheckout()) return 'This copy is a git checkout (your development copy). Update it with git pull instead.';
    return null;
  }

  function backups() {
    try {
      return fs.readdirSync(BACKUPS).map((n) => readJSON(path.join(BACKUPS, n, 'manifest.json'))).filter(Boolean)
        .sort((a, b) => b.at - a.at).map((m) => ({ from: m.from, version: m.version, at: m.at }));
    } catch { return []; }
  }

  return {
    'GET /api/update/status': async () => {
      const result = readJSON(RESULT);
      const pending = readJSON(PENDING);
      return {
        version, repo: repo(), shell: shellMode, gitCheckout: isGitCheckout(), blocked: blockReason(),
        hasToken: !!secrets().githubToken, pending: pending ? { version: pending.version } : null,
        result, backups: backups(),
      };
    },
    'POST /api/update/seen': async () => {
      const r = readJSON(RESULT);
      if (r && !r.seen) writeJSON(RESULT, { ...r, seen: true });
      return { ok: true };
    },
    'POST /api/update/check': async () => check(),
    'POST /api/update/download': async () => {
      const b = blockReason();
      if (b) throw err(400, b);
      const job = newJob('Downloading the update');
      return startJob(job, () => stage(job));
    },
    'POST /api/update/apply': async () => {
      const b = blockReason();
      if (b) throw err(400, b);
      if (!readJSON(PENDING)) throw err(400, 'Nothing is downloaded yet.');
      setTimeout(relaunch, 300);
      return { ok: true };
    },
    'POST /api/update/cancel': async () => {
      const p = readJSON(PENDING);
      if (p?.staging) await fsp.rm(p.staging, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(PENDING, { force: true });
      return { ok: true };
    },
    'POST /api/update/rollback': async () => {
      const b = blockReason();
      if (b) throw err(400, b);
      if (!backups().length) throw err(400, 'There’s no earlier version to go back to.');
      fs.mkdirSync(UPD, { recursive: true });
      fs.writeFileSync(ROLLBACK_FLAG, String(Date.now()));
      setTimeout(relaunch, 300);
      return { ok: true };
    },
    'POST /api/update/token': async (req) => {
      const { token } = await readJSONBody(req);
      const t = token == null ? '' : String(token).trim();
      if (t && !/^(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(t)) throw err(400, 'That doesn’t look like a GitHub token (they start with ghp_ or github_pat_).');
      const s = { ...secrets() };
      if (t) s.githubToken = t; else delete s.githubToken;
      await saveSecrets(s);
      return { ok: true, hasToken: !!t };
    },
  };
};

module.exports.cmpVersion = cmpVersion;
