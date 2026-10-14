// The built-in web browser (left sidebar → globe), main-process side. Its pages run in <webview>s on a session of
// their own, never with the app's bridge, Node or preload (shell.js enforces that when a webview attaches).
//
// Logins: cookies and site data are only kept on disk once Electron's cookie encryption is on (the same Windows
// DPAPI protection Chrome uses). That switch ("fuse") lives inside electron.exe, which can't be written while the app
// runs, so until it's on the browser runs on an in-memory session. It's switched on in a copy of electron.exe that is
// swapped in while the app runs (Windows lets a running program's file be renamed, not written), so the next start
// has it. If that fails, a job flips it in place after quit (and on an in-app restart, before starting again).
//
// Also: the built-in ad blocker (adblock.js), unpacked Chrome extensions, permission prompts, external app links (nxm:// for Vortex, steam://…) behind a
// prompt, and right-click → media dump / doc dump straight into the app's dump folders.

'use strict';

const { app, session, ipcMain, Menu, dialog, clipboard, webContents, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PERSIST = 'persist:bds-browser';
const MEMORY = 'bds-browser'; // no "persist:" → nothing written to disk
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const COOKIE_FUSE = 1; // index of EnableCookieEncryption in the fuse wire (version 1)
const MAX_MEDIA = 1024 * 1024 * 1024; // 1 GB
// link types that have been used to run code on Windows: never handed to the shell
const BLOCKED_SCHEMES = new Set(['file', 'javascript', 'vbscript', 'ms-msdt', 'search-ms', 'search', 'ms-officecmd', 'ms-appinstaller',
  'ms-cxh', 'ms-cxh-full', 'its', 'ms-its', 'mk', 'hcp', 'shell', 'ldap', 'jar', 'ms-word', 'ms-excel', 'ms-powerpoint', 'ms-access', 'ms-settings']);
const WEB_SCHEMES = new Set(['http', 'https', 'about', 'data', 'blob', 'chrome-extension', 'devtools', 'chrome-error']);
const ASK_PERMS = { media: 'use your camera or microphone', geolocation: 'know your location', notifications: 'show notifications', midi: 'use MIDI devices', 'clipboard-read': 'read your clipboard', 'display-capture': 'see your screen' };
const FREE_PERMS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
const EQ_WORLD = 1312; // isolated JS world the EQ runs in
const EQ_BANDS = [[31, 'lowshelf'], [62, 'peaking'], [125, 'peaking'], [250, 'peaking'], [500, 'peaking'], [1000, 'peaking'], [2000, 'peaking'], [4000, 'peaking'], [8000, 'peaking'], [16000, 'highshelf']];
// Runs inside each page: routes its <audio>/<video> through low cut → 10 bands → high cut. Elements are only
// hooked once the EQ is actually doing something, and never DRM (EME) or cross-origin media without CORS:
// Chromium plays those as silence through Web Audio, so they're left alone (unequalised but audible).
const EQ_JS = `(() => {
  if (window.__bdsEq) return;
  const BANDS = ${JSON.stringify(EQ_BANDS)};
  let ctx = null, low, high, filters, cfg = null;
  const seen = new WeakSet();
  const active = (c) => c && (c.eq.some((v) => v) || c.low > 21 || c.high < 19950);
  const apply = () => {
    if (!ctx || !cfg) return;
    const t = ctx.currentTime;
    filters.forEach((f, i) => f.gain.setTargetAtTime(cfg.eq[i], t, 0.02));
    low.frequency.setTargetAtTime(cfg.low, t, 0.02);
    high.frequency.setTargetAtTime(cfg.high, t, 0.02);
  };
  const build = () => {
    ctx = new AudioContext();
    low = ctx.createBiquadFilter(); low.type = 'highpass'; low.Q.value = 0.7;
    high = ctx.createBiquadFilter(); high.type = 'lowpass'; high.Q.value = 0.7;
    filters = BANDS.map(([hz, type]) => { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = hz; f.Q.value = type === 'peaking' ? 1.4 : 0.7; return f; });
    [low, ...filters, high].reduce((a, b) => (a.connect(b), b)).connect(ctx.destination);
    apply();
  };
  const safe = (el) => {
    if (el.mediaKeys) return false;
    const src = el.currentSrc || el.src || '';
    if (!src || src.startsWith('blob:') || src.startsWith('data:') || el.crossOrigin != null) return true;
    try { return new URL(src, location.href).origin === location.origin; } catch { return false; }
  };
  const hook = (el) => {
    if (seen.has(el) || !active(cfg) || !safe(el)) return;
    seen.add(el);
    if (!ctx) build();
    try { ctx.createMediaElementSource(el).connect(low); } catch { /* already routed by the page */ }
    ctx.resume().catch(() => {});
  };
  document.addEventListener('play', (e) => { if (e.target instanceof HTMLMediaElement) hook(e.target); }, true);
  window.__bdsEq = (c) => {
    cfg = c;
    apply();
    if (active(c)) for (const el of document.querySelectorAll('audio, video')) if (!el.paused) hook(el);
  };
})();`;

module.exports = function createBrowser({ root, isAppSender }) {
  const DATA = path.join(root, 'data');
  const STATE = path.join(DATA, 'browser');
  const EXT_FILE = path.join(STATE, 'extensions.json');
  const PROTO_FILE = path.join(STATE, 'external-apps.json');
  const FUSE_FILE = path.join(STATE, 'fuse.json');
  const MEDIA_DUMP = path.join(root, 'media-dump');
  const DOC_DUMP = path.join(root, 'doc-dump');

  let adblock = null; // created in setup(), with the session

  const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); };

  // ---------------------------------------------------------------- cookie encryption (the fuse)
  /** { on, offset } for this electron.exe (cached by size + mtime: reading 200 MB on every start is slow). */
  function fuseState() {
    const exe = process.execPath;
    try {
      const st = fs.statSync(exe);
      const c = readJSON(FUSE_FILE, null);
      if (c && c.exe === exe && c.size === st.size && c.mtime === st.mtimeMs) return c;
      const buf = fs.readFileSync(exe);
      const i = buf.indexOf(FUSE_SENTINEL);
      if (i < 0 || buf[i + FUSE_SENTINEL.length] !== 1) return { on: false, offset: -1 }; // unknown layout: never patch
      const offset = i + FUSE_SENTINEL.length + 2 + COOKIE_FUSE;
      const out = { exe, size: st.size, mtime: st.mtimeMs, offset, on: buf[offset] === 0x31 };
      writeJSON(FUSE_FILE, out);
      return out;
    } catch { return { on: false, offset: -1 }; }
  }
  const fuse = fuseState();
  const partition = fuse.on ? PERSIST : MEMORY;

  /**
   * While the app runs: copy electron.exe, switch the fuse on in the copy, and swap the copy in (the running file is
   * renamed to electron.exe.old, deleted on a later start). Doesn't depend on the app closing, or staying closed long
   * enough for a file to come free: reopening it straight away beat the after-quit job every time.
   */
  async function swapInPatchedExe() {
    const exe = process.execPath;
    const old = `${exe}.old`, tmp = `${exe}.patching`;
    await fsp.rm(old, { force: true }).catch(() => {}); // the one swapped out last time (still in use if that copy runs)
    if (fuse.on || fuse.offset < 0 || process.platform !== 'win32') return;
    try {
      await fsp.copyFile(exe, tmp);
      const fh = await fsp.open(tmp, 'r+');
      try {
        const at = fuse.offset - COOKIE_FUSE - 2 - FUSE_SENTINEL.length;
        const chk = Buffer.alloc(FUSE_SENTINEL.length + 3 + COOKIE_FUSE);
        await fh.read(chk, 0, chk.length, at);
        // the sentinel where it was found, and the fuse still off: else this isn't the file we measured
        if (!chk.subarray(0, FUSE_SENTINEL.length).equals(FUSE_SENTINEL) || chk[chk.length - 1] !== 0x30) throw new Error('unexpected layout');
        await fh.write(Buffer.from('1'), 0, 1, fuse.offset);
        await fh.sync();
      } finally { await fh.close(); }
      await fsp.rename(exe, old);
      try { await fsp.rename(tmp, exe); } catch (e) { await fsp.rename(old, exe).catch(() => {}); throw e; }
      // the copy keeps the original's size and date, so the cache can't tell them apart: record it directly
      const st = fs.statSync(exe);
      writeJSON(FUSE_FILE, { exe, size: st.size, mtime: st.mtimeMs, offset: fuse.offset, on: true });
      fuse.swapped = true;
      console.log('[browser] cookie encryption switched on for the next start');
    } catch (e) {
      console.log(`[browser] couldn’t switch cookie encryption on yet (${e.message}); it's tried again after quit`);
    } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
  }

  /**
   * After the app has fully closed: flip the fuse in electron.exe (PowerShell, waits until the file is free).
   * With `relaunch` ({ args }) it then starts the app again: an in-app restart (updates) can't use app.relaunch()
   * while the fuse is off, because the new copy would hold electron.exe open before it could be patched.
   * Returns whether the job was started.
   */
  function scheduleFusePatch(relaunch) {
    if (fuse.on || fuse.swapped || fuse.offset < 0 || process.platform !== 'win32') return false;
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    // one Windows command line for the relaunch (each argument quoted the way programs split it)
    const winArg = (a) => (a && !/[\s"]/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);
    const again = relaunch
      ? `Start-Process -FilePath $exe -WorkingDirectory ${q(process.cwd())} -ArgumentList ${q([process.argv[1] ? path.resolve(process.argv[1]) : '', ...(relaunch.args || [])].filter(Boolean).map(winArg).join(' '))}`
      : '';
    const ps = `
$exe = ${q(process.execPath)}; $off = ${fuse.offset}; $at = ${fuse.offset - COOKIE_FUSE - 2 - FUSE_SENTINEL.length}; $sent = '${FUSE_SENTINEL.toString()}'
for ($n = 0; $n -lt 120; $n++) {
  Start-Sleep -Milliseconds 500
  $done = $false
  try {
    $f = [IO.File]::Open($exe, 'Open', 'ReadWrite', 'None')
    try {
      $done = $true
      # the sentinel must still sit where it was when the offset was found (else this is a different exe: leave it)
      $chk = New-Object byte[] 32; $f.Position = $at; [void]$f.Read($chk, 0, 32)
      if ([Text.Encoding]::ASCII.GetString($chk) -eq $sent) {
        $f.Position = $off; $b = $f.ReadByte()
        if ($b -eq 0x30) { $f.Position = $off; $f.WriteByte(0x31) }
      }
    } finally { $f.Close() }
  } catch { }
  if ($done) { break }
}
${again}`;
    // detached so it outlives the app (plain children die with it); but a detached PowerShell has no console and
    // silently does nothing, so cmd's `start` gives it one of its own (hidden).
    const cmd = `start "" /min powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`;
    try {
      spawn(process.env.ComSpec || 'cmd.exe', [`/d /s /c "${cmd}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
      return true;
    } catch { return false; /* next quit tries again */ }
  }

  // ---------------------------------------------------------------- session setup
  let ses = null;
  const exts = () => ses.extensions || ses; // newer Electron moved these under session.extensions
  const remembered = new Map(); // "origin|permission" → allowed, for this run

  const hostOf = (wc) => { try { return wc.hostWebContents || null; } catch { return null; } };
  const winFor = (wc) => BrowserWindow.fromWebContents(hostOf(wc) || wc) || BrowserWindow.getAllWindows()[0];
  const send = (wc, ev) => { const h = hostOf(wc); if (h && !h.isDestroyed()) h.send('bds:browser-event', { ...ev, id: wc.id }); };
  const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
  const siteName = (u) => { try { return new URL(u).host || u; } catch { return u; } };

  async function setup() {
    ses = session.fromPartition(partition);
    // a plain Chrome user agent: some sign-in pages refuse anything that says "Electron"
    ses.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`);
    ses.setPermissionCheckHandler((wc, permission, origin) => FREE_PERMS.has(permission) || remembered.get(`${origin}|${permission}`) === true);
    ses.setPermissionRequestHandler(async (wc, permission, cb, details) => {
      if (FREE_PERMS.has(permission)) return cb(true);
      if (permission === 'openExternal') return cb(false); // handled by externalLink() before it gets here
      const what = ASK_PERMS[permission];
      if (!what) return cb(false);
      const origin = originOf(details?.requestingUrl || wc.getURL());
      const key = `${origin}|${permission}`;
      if (remembered.has(key)) return cb(remembered.get(key));
      const { response } = await dialog.showMessageBox(winFor(wc), {
        type: 'question', title: 'Box-DocSpitter browser', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1,
        message: `${siteName(origin)} wants to ${what}.`, detail: 'Remembered until the app closes.',
      });
      remembered.set(key, response === 0);
      cb(response === 0);
    });
    try {
      adblock = require('./adblock.js')({ stateDir: STATE, onCount: (id, count) => { const wc = webContents.fromId(id); if (wc && !wc.isDestroyed()) send(wc, { type: 'adblock', count }); } });
      adblock.attach(ses);
    } catch (e) { adblock = null; console.log(`[browser] ad blocker not started: ${e.message}`); }
    for (const dir of readJSON(EXT_FILE, [])) {
      try { await exts().loadExtension(dir, { allowFileAccess: false }); } catch (e) { console.log(`[browser] extension not loaded: ${dir} (${e.message})`); }
    }
  }

  // ---------------------------------------------------------------- external apps (nxm://, steam://, discord://…)
  async function externalLink(wc, url) {
    let scheme;
    try { scheme = new URL(url).protocol.slice(0, -1).toLowerCase(); } catch { return; }
    if (BLOCKED_SCHEMES.has(scheme)) { send(wc, { type: 'error', message: `Blocked a ${scheme}: link (that kind can run programs).` }); return; }
    const origin = originOf(wc.getURL()) || 'this page';
    const always = readJSON(PROTO_FILE, {});
    if (!(always[origin] || []).includes(scheme)) {
      const { response } = await dialog.showMessageBox(winFor(wc), {
        type: 'question', title: 'Open an external app?', buttons: ['Open', 'Always for this site', 'Cancel'], defaultId: 0, cancelId: 2,
        message: `${siteName(origin)} wants to open an external app.`, detail: `${scheme}: link\n${url.length > 160 ? url.slice(0, 160) + '…' : url}`,
      });
      if (response === 2) return;
      if (response === 1) { always[origin] = [...new Set([...(always[origin] || []), scheme])]; writeJSON(PROTO_FILE, always); }
    }
    shell.openExternal(url).catch(() => send(wc, { type: 'error', message: `Nothing on this PC opens ${scheme}: links.` }));
  }
  const isWeb = (url) => { try { return WEB_SCHEMES.has(new URL(url).protocol.slice(0, -1).toLowerCase()); } catch { return true; } };

  // ---------------------------------------------------------------- dumps
  const EXT_OF = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/webm': 'weba', 'audio/flac': 'flac' };
  const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  async function freeName(dir, name) {
    await fsp.mkdir(dir, { recursive: true });
    const ext = path.extname(name), base = name.slice(0, name.length - ext.length) || 'file';
    for (let n = 1; ; n++) {
      const p = path.join(dir, n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`);
      if (!fs.existsSync(p)) return p;
    }
  }

  async function toMediaDump(wc, url, kind) {
    if (/^blob:/i.test(url)) throw new Error('That one is streamed by the page, so there’s no file to save.');
    let buf, type = '';
    if (/^data:/i.test(url)) {
      const m = /^data:([^;,]*)((?:;[^,]*)*),(.*)$/s.exec(url);
      if (!m) throw new Error('Couldn’t read that.');
      type = m[1].toLowerCase();
      buf = /;base64/i.test(m[2]) ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    } else {
      // with the page's own cookies (the media may need the login)
      const r = await wc.session.fetch(url, { headers: { Referer: wc.getURL() } }).catch(() => wc.session.fetch(url));
      if (!r.ok) throw new Error(`The site said ${r.status}.`);
      if (+r.headers.get('content-length') > MAX_MEDIA) throw new Error('That’s over 1 GB.');
      type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      buf = Buffer.from(await r.arrayBuffer());
    }
    let name = '';
    try { name = decodeURIComponent(path.basename(new URL(url).pathname)); } catch { /* data: */ }
    name = clean(name) || `${kind || 'media'} ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`;
    if (!/\.[a-z0-9]{2,5}$/i.test(name) && EXT_OF[type]) name += '.' + EXT_OF[type];
    const out = await freeName(MEDIA_DUMP, name);
    await fsp.writeFile(out, buf);
    return out;
  }

  async function toDocDump(wc) {
    const pdf = await wc.printToPDF({ printBackground: true, preferCSSPageSize: true });
    const out = await freeName(DOC_DUMP, `${clean(wc.getTitle()) || clean(siteName(wc.getURL())) || 'page'}.pdf`);
    await fsp.writeFile(out, pdf);
    return out;
  }

  const report = (wc, where, job) => job.then((file) => send(wc, { type: 'saved', where, file }), (e) => send(wc, { type: 'error', message: e.message }));

  // ---------------------------------------------------------------- each page
  function contextMenu(wc, p) {
    const items = [];
    const sep = () => items.length && items[items.length - 1].type !== 'separator' && items.push({ type: 'separator' });
    if (p.linkURL) {
      items.push({ label: 'Open link in new tab', click: () => send(wc, { type: 'open', url: p.linkURL, background: true }) });
      items.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) });
      sep();
    }
    const media = ['image', 'video', 'audio'].includes(p.mediaType) && p.srcURL ? p.mediaType : null;
    if (media) {
      items.push({ label: `Send ${media} to media dump`, click: () => report(wc, 'media', toMediaDump(wc, p.srcURL, media)) });
      if (media === 'image') items.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) });
      items.push({ label: `Open ${media} in new tab`, click: () => send(wc, { type: 'open', url: p.srcURL }) });
      sep();
    }
    if (p.isEditable) {
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
      sep();
    } else if (p.selectionText) {
      items.push({ role: 'copy' });
      const q = p.selectionText.trim().replace(/\s+/g, ' ');
      items.push({ label: `Search for “${q.length > 30 ? q.slice(0, 30) + '…' : q}”`, click: () => send(wc, { type: 'search', text: q }) });
      sep();
    }
    const nav = wc.navigationHistory;
    items.push({ label: 'Back', enabled: nav ? nav.canGoBack() : wc.canGoBack(), click: () => (nav ? nav.goBack() : wc.goBack()) });
    items.push({ label: 'Forward', enabled: nav ? nav.canGoForward() : wc.canGoForward(), click: () => (nav ? nav.goForward() : wc.goForward()) });
    items.push({ label: 'Reload', click: () => wc.reload() });
    sep();
    items.push({ label: 'Save page to doc dump (PDF)', click: () => report(wc, 'doc', toDocDump(wc)) });
    sep();
    // BoxVidKlep: the video you right-clicked (when it has a real address), else the page's video; or every video on the page
    const page = wc.getURL();
    const direct = p.mediaType === 'video' && /^https?:/i.test(p.srcURL || '') ? p.srcURL : null;
    if (/^https?:/i.test(page)) {
      items.push({ label: direct ? 'Get this video with BoxVidKlep' : 'Get the video with BoxVidKlep', click: () => send(wc, { type: 'klep', url: direct || page, all: false }) });
      items.push({ label: 'Get all videos on this page with BoxVidKlep', click: () => send(wc, { type: 'klep', url: page, all: true }) });
      sep();
    }
    items.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: winFor(wc) });
  }

  // ---------------------------------------------------------------- EQ for page audio
  let eq = null; // { eq: [10 dB], low: Hz, high: Hz } from the app's settings
  const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
  const cleanEq = (c) => (c && Array.isArray(c.eq) && c.eq.length === EQ_BANDS.length
    ? { eq: c.eq.map((v) => num(v, -18, 18, 0)), low: num(c.low, 20, 20000, 20), high: num(c.high, 20, 20000, 20000) } : null);
  function pushEq(wc) {
    if (!eq || wc.isDestroyed()) return;
    wc.executeJavaScriptInIsolatedWorld(EQ_WORLD, [{ code: `${EQ_JS}\nwindow.__bdsEq(${JSON.stringify(eq)});` }]).catch(() => {});
  }

  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'webview') return;
    // links that open a tab → a tab in the browser; real popups (sign-in windows) stay popups, on the same session
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!isWeb(url)) { externalLink(wc, url); return { action: 'deny' }; }
      if (disposition === 'new-window') {
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } } };
      }
      send(wc, { type: 'open', url, background: disposition === 'background-tab' });
      return { action: 'deny' };
    });
    wc.on('will-frame-navigate', (e) => {
      if (isWeb(e.url)) return;
      e.preventDefault();
      externalLink(wc, e.url);
    });
    wc.on('context-menu', (_e, p) => contextMenu(wc, p));
    wc.on('dom-ready', () => pushEq(wc));
    wc.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) adblock?.reset(wc.id); });
    const wcId = wc.id;
    wc.once('destroyed', () => adblock?.reset(wcId));
    // browser keys work while a page has focus
    wc.on('before-input-event', (e, i) => {
      if (i.type !== 'keyDown') return;
      const k = i.key.toLowerCase();
      if (k === 'f12') { e.preventDefault(); wc.toggleDevTools(); return; }
      if (i.control && (k === '=' || k === '+' || k === '-' || k === '0')) {
        e.preventDefault();
        wc.setZoomLevel(k === '0' ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + (k === '-' ? -0.5 : 0.5))));
        return;
      }
      const combo = (i.control ? 'ctrl+' : '') + (i.shift ? 'shift+' : '') + (i.alt ? 'alt+' : '') + k;
      if (['ctrl+t', 'ctrl+w', 'ctrl+l', 'ctrl+r', 'f5', 'ctrl+shift+t', 'alt+arrowleft', 'alt+arrowright', 'ctrl+tab', 'ctrl+shift+tab', 'ctrl+f', 'escape'].includes(combo)) {
        if (combo !== 'escape') e.preventDefault();
        send(wc, { type: 'key', combo });
      }
    });
  });

  // ---------------------------------------------------------------- the app page asks
  const guestOf = (e, id) => {
    const wc = webContents.fromId(Number(id));
    if (!wc || wc.getType() !== 'webview' || hostOf(wc) !== e.sender) throw new Error('No such page.');
    return wc;
  };
  ipcMain.handle('bds:browser', async (e, req = {}) => {
    if (!isAppSender(e)) return { ok: false, error: 'Not allowed' };
    try {
      switch (req.op) {
        case 'status':
          return { ok: true, partition, persistent: partition === PERSIST };
        case 'extensions':
          return { ok: true, list: exts().getAllExtensions().map((x) => ({ id: x.id, name: x.name, version: x.version, path: x.path })) };
        case 'addExtension': {
          const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Pick an unpacked extension folder (the one with manifest.json)', properties: ['openDirectory'] });
          if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
          const dir = r.filePaths[0];
          if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error('That folder has no manifest.json. Pick the unpacked extension folder.');
          const x = await exts().loadExtension(dir, { allowFileAccess: false });
          writeJSON(EXT_FILE, [...new Set([...readJSON(EXT_FILE, []), dir])]);
          return { ok: true, ext: { id: x.id, name: x.name, version: x.version } };
        }
        case 'removeExtension': {
          const x = exts().getExtension(String(req.id));
          if (x) { exts().removeExtension(x.id); writeJSON(EXT_FILE, readJSON(EXT_FILE, []).filter((p) => path.resolve(p) !== path.resolve(x.path))); }
          return { ok: true };
        }
        case 'adblock': {
          if (!adblock) return { ok: false, error: 'The ad blocker didn’t start.' };
          const wc = req.id != null ? guestOf(e, req.id) : null;
          if (req.set === 'enabled') adblock.setEnabled(req.value);
          else if (req.set === 'allow') adblock.setAllowed(wc?.getURL() || '', !!req.value);
          else if (req.set === 'unallow') adblock.removeAllowed(String(req.value || ''));
          else if (req.set === 'update') await adblock.update();
          return { ok: true, ...adblock.status(wc?.getURL() || '', wc?.id), allowList: adblock.allowList() };
        }
        case 'savePage':
          return { ok: true, file: await toDocDump(guestOf(e, req.id)) };
        case 'eq':
          eq = cleanEq(req.eq);
          for (const wc of webContents.getAllWebContents()) if (wc.getType() === 'webview') pushEq(wc);
          return { ok: true };
        case 'clearData':
          await ses.clearStorageData();
          await ses.clearCache();
          remembered.clear();
          writeJSON(PROTO_FILE, {});
          return { ok: true };
        default:
          return { ok: false, error: 'Unknown request' };
      }
    } catch (err) { return { ok: false, error: err.message }; }
  });

  app.on('will-quit', () => scheduleFusePatch());
  // a little after start-up, so the 200 MB copy doesn't slow the window opening
  app.whenReady().then(() => setTimeout(() => { swapInPatchedExe(); }, 15000).unref?.());

  return {
    partition,
    setup,
    /** Restarts the app through the fuse patch when it's still off (true), else leaves the restart to the caller. */
    relaunchPatched: (args) => scheduleFusePatch({ args }),
    /** Locks down every <webview> the app page attaches: no preload, no Node, sandboxed, the browser's session only. */
    guardWebview(e, prefs, params) {
      delete prefs.preload;
      Object.assign(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false });
      if (params.partition !== partition || !/^(https?:|chrome-extension:|about:blank$)/i.test(params.src || 'about:blank')) e.preventDefault();
    },
  };
};
