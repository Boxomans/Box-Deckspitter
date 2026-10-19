// Box-Deckspitter desktop shell: runs server.js as a child process and shows the UI in its own window
// (own icon, own taskbar entry, no browser chrome). Everything still talks to 127.0.0.1 with the per-launch token.
// Loaded by electron/main.js (the boot file), which applies updates and rolls them back if this doesn't start.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeImage, clipboard, ClipboardItem, powerMonitor, screen } = require('electron');
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Windows caches icons by file path, so a redesigned icon gets a new file name or the old one keeps showing
let ICON = path.join(ROOT, 'public', 'assets', 'icon-lavender.ico');
// Copies told apart on the taskbar: one run from a git checkout (the dev copy) gets a red icon, one run from the temp
// folder (a scratch test copy) a yellow one. Everyone else keeps the lavender one. The tinted icon is made here at
// startup and kept in the copy's own data folder, so the repo's icon files never change.
try {
  const tmp = path.resolve(require('os').tmpdir()).toLowerCase();
  const tint = path.resolve(ROOT).toLowerCase().startsWith(tmp) ? ['yellow', [240, 200, 40]]
    : fs.existsSync(path.join(ROOT, '.git')) ? ['red', [232, 64, 64]] : null;
  if (tint) {
    const img = nativeImage.createFromPath(path.join(ROOT, 'public', 'assets', 'icon-256.png'));
    const { width, height } = img.getSize();
    const px = img.toBitmap(); // BGRA
    const [r, g, b] = tint[1];
    for (let i = 0; i < px.length; i += 4) {
      const hi = Math.max(px[i], px[i + 1], px[i + 2]), lo = Math.min(px[i], px[i + 1], px[i + 2]);
      if (hi - lo < 24 || px[i] < px[i + 2]) continue; // only the lavender (blue-led) parts; the page and the black stay
      const f = Math.min(1.15, hi / 214);
      px[i] = Math.min(255, b * f); px[i + 1] = Math.min(255, g * f); px[i + 2] = Math.min(255, r * f);
    }
    const png = nativeImage.createFromBitmap(px, { width, height }).toPNG();
    // a one-image .ico holding the PNG (Windows wants a file path for the taskbar and shortcuts)
    const head = Buffer.alloc(22);
    head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
    head[6] = width >= 256 ? 0 : width; head[7] = height >= 256 ? 0 : height;
    head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
    const out = path.join(ROOT, 'data', 'electron', `icon-${tint[0]}.ico`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const ico = Buffer.concat([head, png]);
    if (!fs.existsSync(out) || !fs.readFileSync(out).equals(ico)) fs.writeFileSync(out, ico);
    ICON = out;
  }
} catch { /* keep the lavender icon */ }
const BG = { dark: '#111214', light: '#f5f5f8', dusk: '#0b0910', bluehour: '#090b12', pbj: '#3a1e3e' };

app.setName('Box-Deckspitter');
// Keep Electron's own cache and window state inside the app folder (portable: nothing left in %APPDATA%).
const USER_DATA = path.join(ROOT, 'data', 'electron');
// A factory reset can't delete the cache while the window is using it, so it's finished here, before startup.
const RESET_FLAG = path.join(ROOT, 'data', '.reset-electron');
if (fs.existsSync(RESET_FLAG)) {
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* still locked: try next time */ }
  try { if (!fs.existsSync(USER_DATA)) fs.unlinkSync(RESET_FLAG); } catch { /* ignore */ }
}
app.setPath('userData', USER_DATA);
// Each copy of the app (another folder, a USB stick…) gets its own Windows app id. With one shared id,
// Windows treated every copy as the same app, so pinning one to the taskbar could launch another.
const ROOT_HASH = require('crypto').createHash('sha1').update(path.resolve(ROOT).toLowerCase()).digest('hex').slice(0, 10);
const APP_ID = 'BoxDeckspitter.App.' + ROOT_HASH;
app.setAppUserModelId(APP_ID);
Menu.setApplicationMenu(null);
// UI sounds (hover etc.) should work before the first click; this is our own app window, not a website.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/** Files passed on the command line (drag-and-drop onto the shortcut). */
function fileArgs(argv) {
  // the app's own entry files (main.js is what Electron is started with) are never "files to open"
  const own = [__filename, path.join(__dirname, 'main.js'), ROOT].map((p) => path.resolve(p).toLowerCase());
  return argv.slice(1).filter((a) => {
    if (!a || a.startsWith('-')) return false;
    const p = path.resolve(a);
    if (own.includes(p.toLowerCase())) return false;
    if (p.toLowerCase().endsWith('.exe')) return false;
    try { return fs.statSync(p).isFile() || fs.statSync(p).isDirectory(); } catch { return false; }
  }).map((a) => path.resolve(a));
}

const boot = global.bdsBoot || null;
if (!(boot ? boot.gotLock : app.requestSingleInstanceLock())) {
  app.quit();
} else {
  let server = null;
  let origin = null;
  let quitting = false;
  let attached = false; // another Box-Deckspitter server was already running; we just use it

  const urlFor = (files) => {
    const qs = files.map((p) => 'open=' + encodeURIComponent(p)).join('&');
    return `${origin}/${qs ? '?' + qs : ''}`;
  };

  app.on('second-instance', (_e, argv) => {
    if (!origin) return;
    const files = fileArgs(argv);
    const existing = BrowserWindow.getAllWindows()[0];
    if (!files.length && existing) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return;
    }
    createWindow(urlFor(files));
  });

  function startServer() {
    server = fork(path.join(ROOT, 'server.js'), ['--shell', ...fileArgs(process.argv)], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    server.on('message', (m) => {
      if (m && m.type === 'attached') attached = true;
      if (m && m.type === 'pdf') renderPdf(m);
      if (m && m.type === 'relaunch') {
        quitting = true;
        try { server?.kill(); } catch { /* gone */ }
        const args = process.argv.slice(1).filter((a) => a !== '--rollback' && !fileArgs([process.argv[0], a]).length);
        // logins in the browser aren't kept until electron.exe is patched, which needs the app closed: a restart is
        // the moment (app.exit skips will-quit, where that normally happens)
        if (!browser.relaunchPatched(args.slice(1))) app.relaunch({ args });
        app.exit(0);
      }
      if (m && m.type === 'open' && typeof m.url === 'string') {
        origin = new URL(m.url).origin;
        createWindow(m.url);
      }
    });
    server.on('exit', (code) => {
      server = null;
      if (quitting || (attached && origin)) return;
      if (!origin && boot?.fail?.('the local server stopped while starting')) return; // update trial: boot rolls back
      if (!origin) {
        dialog.showErrorBox('Box-Deckspitter', `The local server failed to start (exit code ${code}).\n\nTry "Box-Deckspitter (with console).bat" to see the error.`);
      }
      quitting = true;
      app.quit();
    });
  }

  // PDF export without Edge: render the page in a hidden window and print it with Chromium's PDF engine.
  async function renderPdf({ id, file, out }) {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
    try {
      await win.loadFile(file);
      await new Promise((r) => setTimeout(r, 300)); // let fonts and images settle
      const data = await win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true });
      fs.writeFileSync(out, data);
      server?.send({ type: 'pdf-done', id });
    } catch (e) {
      server?.send({ type: 'pdf-done', id, error: e.message });
    } finally {
      win.destroy();
    }
  }

  function isLocal(url) {
    try { return origin && new URL(url).origin === origin; } catch { return false; }
  }

  function openExternal(url) {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
  }

  // ---- app windows. Several can be open (a tab dragged out of one becomes a window of its own; they share the
  // taskbar button, like browser windows). One of them is the main window: the one-per-app things (the easter egg,
  // update notices) run there, and when it closes the next one takes over.
  const appWins = new Set();
  let mainWinId = null;
  function nextMainWindow() {
    const next = [...appWins].find((w) => !w.isDestroyed());
    mainWinId = next ? next.id : null;
    if (next) next.webContents.send('bds:main-window');
  }

  function createWindow(url, bounds = null) {
    const win = new BrowserWindow({
      width: 1480, height: 940, minWidth: 720, minHeight: 460,
      ...(bounds || {}),
      show: false,
      title: 'Box-Deckspitter',
      icon: nativeImage.createFromPath(ICON),
      backgroundColor: BG.dark,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#120f19', symbolColor: '#bfb2d9', height: 40 },
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        spellcheck: true,
        plugins: true, // built-in PDF viewer for print previews
        webviewTag: true, // the built-in browser (electron/browser.js locks each one down)
      },
    });
    // Pinning the window to the taskbar should pin Box-Deckspitter, not bare electron.exe: tell Windows how
    // to relaunch it (same app id as the shortcuts, so the pinned button and the open window are one icon).
    if (process.platform === 'win32') {
      try {
        win.setAppDetails({
          appId: APP_ID,
          appIconPath: ICON,
          appIconIndex: 0,
          relaunchCommand: `"${process.execPath}" "${path.join(__dirname, 'main.js')}"`,
          relaunchDisplayName: 'Box-Deckspitter',
        });
      } catch { /* older Windows: pinning just won't carry the details */ }
    }
    appWins.add(win);
    if (mainWinId == null) mainWinId = win.id;
    const id = win.id;
    win.on('closed', () => { appWins.delete(win); if (mainWinId === id) nextMainWindow(); });
    // the page asks the window itself whether it's full screen (guessing from sizes fails with zoom or display scaling)
    for (const ev of ['enter-full-screen', 'leave-full-screen']) win.on(ev, () => { if (!win.isDestroyed()) win.webContents.send('bds:fullscreen-changed', win.isFullScreen()); });
    win.once('ready-to-show', () => win.show());
    win.loadURL(url);

    // Popups: same-origin/blank ones (print previews, PDF view) get a plain window; web links go to the default browser.
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (!target || target === 'about:blank' || target.startsWith('blob:') || isLocal(target)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            icon: nativeImage.createFromPath(ICON), backgroundColor: '#ffffff', autoHideMenuBar: true,
            webPreferences: { sandbox: true, contextIsolation: true, plugins: true },
          },
        };
      }
      openExternal(target);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, target) => {
      if (!isLocal(target)) { e.preventDefault(); openExternal(target); }
    });
    win.webContents.on('will-attach-webview', (e, prefs, params) => browser.guardWebview(e, prefs, params));

    // The page asks before closing with unsaved tabs; Electron needs us to show that question ourselves.
    win.webContents.on('will-prevent-unload', (e) => {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning', title: 'Box-Deckspitter', buttons: ['Close anyway', 'Keep editing'], defaultId: 1, cancelId: 1,
        message: 'You have unsaved changes.', detail: 'Close this window and lose them?',
      });
      if (choice === 0) e.preventDefault();
    });

    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) win.webContents.toggleDevTools();
    });
    return win;
  }

  // Bridge for the page (see preload.js).
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  // ---- tabs dragged out into windows of their own, and a one-tab window dragged around by its tab
  ipcMain.handle('bds:win-info', (e) => {
    const win = winOf(e);
    if (!win) return null;
    return { main: win.id === mainWinId, pos: win.getPosition(), maximized: win.isMaximized() };
  });
  // [x, y] where the drag started (from win-info) and how far the pointer has moved since, in page pixels (the
  // page's zoom makes those differ from screen pixels)
  ipcMain.on('bds:move-window', (e, m) => {
    const win = winOf(e);
    if (!win || !Array.isArray(m) || m.length !== 4 || !m.every(Number.isFinite)) return;
    if (win.isMaximized()) win.unmaximize();
    const z = e.sender.getZoomFactor() || 1;
    win.setPosition(Math.round(m[0] + m[2] * z), Math.round(m[1] + m[3] * z));
  });
  const adoptions = new Map(); // token → { tabs, done }
  // the tabs go to the new window, which asks for them once it's loaded; the old window closes them only after that
  ipcMain.handle('bds:tear-off', (e, req) => {
    const src = winOf(e);
    if (!src || !fromApp(e) || !origin || !Array.isArray(req?.tabs) || !req.tabs.length) return false;
    const token = require('crypto').randomBytes(12).toString('hex');
    const [w, h] = src.isMaximized() ? [1280, 860] : src.getSize();
    // where it was let go: the page's coordinates (cx, cy) → the screen's
    const cb = src.getContentBounds(), z = e.sender.getZoomFactor() || 1;
    const px = cb.x + (Number(req.cx) || 0) * z, py = cb.y + (Number(req.cy) || 0) * z;
    // the new window's tab bar under the pointer, on the screen the pointer is on
    const area = screen.getDisplayNearestPoint({ x: Math.round(px), y: Math.round(py) }).workArea;
    const x = Math.round(Math.min(Math.max(px - Math.min(160, w / 2), area.x), area.x + area.width - Math.min(w, area.width)));
    const y = Math.round(Math.min(Math.max(py - 60, area.y), area.y + area.height - Math.min(h, area.height)));
    return new Promise((resolve) => {
      const timer = setTimeout(() => { adoptions.delete(token); resolve(false); }, 30000);
      adoptions.set(token, { tabs: req.tabs, done: () => { clearTimeout(timer); resolve(true); } });
      createWindow(`${origin}/?adopt=${token}`, { x, y, width: Math.min(w, area.width), height: Math.min(h, area.height) });
    });
  });
  ipcMain.handle('bds:adopt', (e, token) => {
    const a = fromApp(e) ? adoptions.get(String(token)) : null;
    if (!a) return null;
    adoptions.delete(String(token));
    a.done();
    return a.tabs;
  });

  ipcMain.handle('bds:titlebar', (e, { color, symbolColor, theme }) => {
    const win = winOf(e);
    if (!win) return;
    try { win.setTitleBarOverlay({ color, symbolColor }); } catch { /* not supported */ }
    if (theme && BG[theme]) win.setBackgroundColor(BG[theme]);
  });

  // Drag a dump file out of the window as a real file (to Explorer, the desktop, Discord…).
  const DRAG_DIRS = [path.join(ROOT, 'media-dump'), path.join(ROOT, 'image-dump'), path.join(ROOT, 'doc-dump')].map((d) => d.toLowerCase() + path.sep);
  const DRAG_ICON = path.join(ROOT, 'public', 'assets', 'icon-256.png');
  ipcMain.on('bds:drag', (e, file) => {
    const full = path.resolve(String(file || ''));
    if (!DRAG_DIRS.some((d) => full.toLowerCase().startsWith(d)) || !fs.existsSync(full)) return;
    let img = /\.(png|jpe?g|gif|bmp)$/i.test(full) ? nativeImage.createFromPath(full) : null;
    if (!img || img.isEmpty()) img = nativeImage.createFromPath(DRAG_ICON);
    const size = img.getSize();
    if (size.width > 96) img = img.resize({ width: 96 });
    e.sender.startDrag({ file: full, icon: img });
  });

  // Copy a picture to the system clipboard (doesn't depend on the page's clipboard permission).
  ipcMain.handle('bds:copyImage', async (_e, dataUrl) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return false;
    const png = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    if (!png.length) return false;
    if (typeof clipboard.writeImage === 'function') {
      clipboard.writeImage(nativeImage.createFromBuffer(png)); // older Electron
    } else {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    }
    return true;
  });

  // Desktop + Start menu shortcuts carrying the app id, so a pinned shortcut and the open window are one icon.
  ipcMain.handle('bds:shortcuts', () => {
    const made = [];
    const dirs = [app.getPath('desktop'), path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')];
    // a shortcut that already belongs to another copy of the app is left alone: this copy gets its own name
    const mine = (lnk) => { try { const l = shell.readShortcutLink(lnk); return path.resolve(l.cwd || path.dirname(l.target)).toLowerCase() === path.resolve(ROOT).toLowerCase() || (l.args || '').toLowerCase().includes(path.resolve(ROOT).toLowerCase()); } catch { return true; } };
    // "Box-Deckspitter (E drive)" for a copy on another drive, else "Box-Deckspitter (<parent folder>)"
    const drive = path.parse(path.resolve(ROOT)).root.slice(0, 2).toUpperCase();
    const where = drive !== 'C:' && /^[A-Z]:$/.test(drive) ? `${drive[0]} drive` : path.basename(path.dirname(path.resolve(ROOT))) || drive;
    const targets = dirs.map((d) => {
      const plain = path.join(d, 'Box-Deckspitter.lnk');
      return !fs.existsSync(plain) || mine(plain) ? plain : path.join(d, `Box-Deckspitter (${where.replace(/[\\/:*?"<>|]/g, '')}).lnk`);
    });
    for (const lnk of targets) {
      const ok = shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', {
        target: process.execPath,
        args: `"${path.join(__dirname, 'main.js')}"`,
        cwd: ROOT,
        icon: ICON,
        iconIndex: 0,
        appUserModelId: APP_ID,
        description: 'Box-Deckspitter - local docs, PDFs, forms, text and code',
      });
      if (ok) made.push(lnk);
    }
    return made;
  });

  // ---- Secure notes (electron/secure-notes.js): encrypted here, in the window's own process. Only the app's
  // own page may ask; the local server never sees any of it.
  const notes = require('./secure-notes.js')({
    dir: path.join(ROOT, 'data', 'secure-notes'),
    clipboard,
    onLockChange: (unlocked, reason) => {
      for (const w of BrowserWindow.getAllWindows()) {
        // while the notes are open the window shows black in screenshots, recordings and screen shares
        try { w.setContentProtection(!!unlocked); } catch { /* not supported */ }
        if (!unlocked) w.webContents.send('bds:notes-locked', reason || 'manual');
      }
    },
  });
  const fromApp = (e) => { try { return !!origin && new URL(e.senderFrame?.url || e.sender.getURL()).origin === origin; } catch { return false; } };
  ipcMain.handle('bds:notes', (e, req) => (fromApp(e) ? notes.handle(req || {}) : { ok: false, error: 'Not allowed', code: 'denied' }));

  // ---- the built-in web browser (electron/browser.js)
  const browser = require('./browser.js')({ root: ROOT, isAppSender: fromApp });
  // ---- screenshots with Win+Shift+Q (electron/snip.js), straight into the media dump
  const snip = require('./snip.js')({
    dumpDir: path.join(ROOT, 'media-dump'),
    notify: (info) => { const w = mainWinId != null ? BrowserWindow.fromId(mainWinId) : null; if (w && !w.isDestroyed()) w.webContents.send('bds:snip-saved', info); },
    // also kept in data\logs\snip.log (small, newest at the end), so a key that does nothing can be looked into
    log: (msg) => {
      console.log(`[snip] ${msg}`);
      try {
        const file = path.join(ROOT, 'data', 'logs', 'snip.log');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if ((fs.statSync(file, { throwIfNoEntry: false })?.size || 0) > 200000) fs.renameSync(file, file + '.old');
        fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`);
      } catch { /* logging never gets in the way */ }
    },
  });
  app.whenReady().then(() => snip.register());
  // ---- BoxStudio: capture sources, global hotkeys, full speed while recording (electron/studio.js)
  const studio = require('./studio.js')({ isAppSender: fromApp, pickArea: (cb) => snip.pickArea(cb), log: (msg) => console.log(`[studio] ${msg}`) });

  // The taskbar takes its icon from this copy's shortcuts (the ones Windows keeps for the app id, plus the
  // Desktop and Start menu ones), not from the window. After the icon file changes, point them at the new one;
  // shortcuts (taskbar pins too) still carrying the app id from before the rename get the new one.
  if (process.platform === 'win32') app.whenReady().then(() => setTimeout(() => {
    const dirs = [app.getPath('desktop'), path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')];
    const pinned = path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned');
    dirs.push(path.join(pinned, 'TaskBar'), path.join(pinned, 'StartMenu'));
    const implicit = path.join(pinned, 'ImplicitAppShortcuts');
    try { for (const d of fs.readdirSync(implicit)) dirs.push(path.join(implicit, d)); } catch { /* none yet */ }
    for (const dir of dirs) {
      let names = [];
      try { names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.lnk')); } catch { continue; }
      for (const f of names) {
        try {
          const lnk = path.join(dir, f);
          const l = shell.readShortcutLink(lnk);
          if (l.appUserModelId === APP_ID && path.resolve(l.icon || '').toLowerCase() !== ICON.toLowerCase()) {
            shell.writeShortcutLink(lnk, 'update', { icon: ICON, iconIndex: 0 });
          }
        } catch { /* not a shortcut we can read */ }
      }
    }
  }, 3000));

  // Windows locked, the PC going to sleep: lock the notes (and tell the page, for the app's PIN lock)
  app.whenReady().then(() => {
    for (const ev of ['lock-screen', 'suspend']) {
      powerMonitor.on(ev, () => {
        notes.lock({ reason: ev });
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('bds:system-lock', ev);
      });
    }
  });

  ipcMain.handle('bds:fullscreen', (e, on) => {
    const win = winOf(e);
    if (win) win.setFullScreen(!!on);
  });
  ipcMain.handle('bds:is-fullscreen', (e) => !!winOf(e)?.isFullScreen());

  ipcMain.handle('bds:dialog', async (e, opts) => {
    const win = winOf(e);
    const filters = (opts.filters || []).map((f) => ({ name: f.name, extensions: f.extensions || ['*'] }));
    const defaultPath = opts.kind === 'save' && opts.defaultName
      ? path.join(opts.initialDir || app.getPath('documents'), opts.defaultName)
      : opts.initialDir || undefined;
    if (opts.kind === 'save') {
      const r = await dialog.showSaveDialog(win, { title: opts.title, defaultPath, filters });
      if (r.canceled || !r.filePath) return { cancelled: true };
      let filePath = r.filePath;
      const ext = path.extname(filePath).slice(1).toLowerCase();
      let filterIndex = filters.findIndex((f) => f.extensions.includes(ext)) + 1;
      if (!ext && opts.defaultExt) filePath += '.' + opts.defaultExt;
      if (filterIndex < 1) filterIndex = 1;
      return { paths: [filePath], filterIndex };
    }
    const properties = opts.kind === 'folder' ? ['openDirectory', 'createDirectory'] : ['openFile'];
    if (opts.multi) properties.push('multiSelections');
    const r = await dialog.showOpenDialog(win, { title: opts.title, defaultPath, filters: opts.kind === 'folder' ? undefined : filters, properties });
    if (r.canceled || !r.filePaths.length) return { cancelled: true };
    return { paths: r.filePaths };
  });

  app.whenReady().then(async () => {
    try { await browser.setup(); } catch (e) { console.log(`[browser] setup failed: ${e.message}`); }
    startServer();
  });

  app.on('window-all-closed', () => {
    quitting = true;
    app.quit();
  });

  app.on('will-quit', () => {
    quitting = true;
    notes.lock({ hard: true, reason: 'quit' });
    snip.dispose();
    studio.dispose();
    if (server) { try { server.disconnect(); } catch { /* gone */ } try { server.kill(); } catch { /* gone */ } }
  });
}
