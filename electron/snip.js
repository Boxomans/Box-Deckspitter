// Screenshots with Win+Shift+Q, while the app runs: the screen dims, drag to grab an area or click a window to grab
// that window. A fullscreen app in front (a game…) is grabbed whole at once, with no overlay to knock it out of full
// screen or take its focus. The PNG goes straight into the media dump; the clipboard is never touched.
// Window positions come from a small PowerShell helper (Win32 calls), started on the first press and kept for a while.

const { BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const KEY = 'Super+Shift+Q';
const HELPER_IDLE = 10 * 60 * 1000;

// Top-level windows front to back (visible, not minimised, not hidden by Windows, with a title), the one in front and
// whether it fills its monitor. Physical pixels (per-monitor DPI aware); one JSON line per request.
const HELPER_CS = `
using System; using System.Text; using System.Runtime.InteropServices;
public static class BdsWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, int f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONINFO i);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONINFO { public int Size; public RECT Mon; public RECT Work; public int Flags; }
  static string Esc(string s) {
    var b = new StringBuilder();
    foreach (char c in s) { if (c == '"' || c == '\\\\') b.Append('\\\\').Append(c); else if (c < 32) b.Append(' '); else b.Append(c); }
    return b.ToString();
  }
  static RECT Bounds(IntPtr h) { RECT r; if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r); return r; }
  static string Cls(IntPtr h) { var c = new StringBuilder(128); GetClassName(h, c, 128); return c.ToString(); }
  static string Json(RECT r) { return "\\"x\\":" + r.L + ",\\"y\\":" + r.T + ",\\"w\\":" + (r.R - r.L) + ",\\"h\\":" + (r.B - r.T); }
  public static string List() {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    var sb = new StringBuilder("{\\"windows\\":[");
    bool first = true;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true; // tool windows
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      if (t.Length == 0) return true;
      RECT r = Bounds(h);
      if (r.R - r.L < 8 || r.B - r.T < 8) return true;
      if (!first) sb.Append(','); first = false;
      sb.Append("{" + Json(r) + ",\\"t\\":\\"" + Esc(t.ToString()) + "\\"}");
      return true;
    }, IntPtr.Zero);
    sb.Append("]");
    IntPtr fg = GetForegroundWindow();
    if (fg != IntPtr.Zero) {
      RECT r = Bounds(fg);
      var mi = new MONINFO(); mi.Size = Marshal.SizeOf(typeof(MONINFO));
      string cls = Cls(fg);
      bool full = GetMonitorInfo(MonitorFromWindow(fg, 2), ref mi) && cls != "Progman" && cls != "WorkerW" && cls != "Shell_TrayWnd"
        && r.L <= mi.Mon.L && r.T <= mi.Mon.T && r.R >= mi.Mon.R && r.B >= mi.Mon.B;
      sb.Append(",\\"front\\":{" + Json(r) + ",\\"full\\":" + (full ? "true" : "false") + "}");
    }
    sb.Append("}");
    return sb.ToString();
  }
}`;
const HELPER_PS = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${HELPER_CS}
'@
while ($null -ne ($line = [Console]::In.ReadLine())) { [Console]::Out.WriteLine([BdsWin]::List()); [Console]::Out.Flush() }`;

// The overlay page: the frozen screen, dimmed, with the area or window that would be taken lit up.
const OVERLAY_HTML = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#000;cursor:crosshair;user-select:none}
canvas{position:fixed;inset:0;width:100vw;height:100vh}
#hint{position:fixed;top:18px;left:50%;transform:translateX(-50%);padding:7px 14px;border-radius:8px;background:rgba(10,8,16,.86);
color:#e8e2f4;font:13px/1.3 "Segoe UI",system-ui,sans-serif;border:1px solid rgba(255,255,255,.14);pointer-events:none;white-space:nowrap}
#size{position:fixed;padding:2px 6px;border-radius:4px;background:rgba(10,8,16,.86);color:#e8e2f4;font:11px "Cascadia Mono",Consolas,monospace;pointer-events:none;display:none}
</style><canvas id="c"></canvas><div id="hint">Drag to grab an area · click a window · Esc to cancel</div><div id="size"></div>
<script>
const c = document.getElementById('c'), g = c.getContext('2d'), size = document.getElementById('size');
let img = null, wins = [], drag = null, hover = null, done = false;
const fit = () => { c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio; draw(); };
const under = (x, y) => wins.find((w) => x >= w.x && y >= w.y && x < w.x + w.w && y < w.y + w.h) || null;
const rectOf = (d) => ({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) });
function draw() {
  if (!img) return;
  const k = devicePixelRatio, sx = img.naturalWidth / innerWidth, sy = img.naturalHeight / innerHeight;
  g.drawImage(img, 0, 0, c.width, c.height);
  g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, c.width, c.height);
  const r = drag && drag.moved ? rectOf(drag) : hover;
  size.style.display = 'none';
  if (!r) return;
  const x = Math.max(0, r.x), y = Math.max(0, r.y), w = Math.min(innerWidth, r.x + r.w) - x, h = Math.min(innerHeight, r.y + r.h) - y;
  if (w <= 0 || h <= 0) return;
  g.drawImage(img, x * sx, y * sy, w * sx, h * sy, x * k, y * k, w * k, h * k);
  g.strokeStyle = '#ff8a3d'; g.lineWidth = 2 * k; g.strokeRect(x * k + k, y * k + k, w * k - 2 * k, h * k - 2 * k);
  size.textContent = Math.round(w * sx) + ' × ' + Math.round(h * sy);
  size.style.display = 'block';
  size.style.left = x + 'px'; size.style.top = (y > 26 ? y - 24 : y + h + 4) + 'px';
}
function finish(r) { if (done) return; done = true; window.snip.done(r); }
addEventListener('resize', fit);
addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(null); });
addEventListener('contextmenu', (e) => { e.preventDefault(); finish(null); });
addEventListener('pointerdown', (e) => { if (e.button !== 0) return; drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, moved: false }; c.setPointerCapture(e.pointerId); });
addEventListener('pointermove', (e) => {
  if (drag) { drag.x1 = e.clientX; drag.y1 = e.clientY; if (Math.abs(drag.x1 - drag.x0) + Math.abs(drag.y1 - drag.y0) > 4) drag.moved = true; }
  else hover = under(e.clientX, e.clientY) || { x: 0, y: 0, w: innerWidth, h: innerHeight, screen: true };
  draw();
});
addEventListener('pointerup', (e) => {
  if (!drag || e.button !== 0) return;
  const d = drag; drag = null;
  if (d.moved) { const r = rectOf(d); if (r.w >= 3 && r.h >= 3) finish({ ...r, kind: 'area' }); else draw(); return; }
  const w = under(d.x0, d.y0);
  finish(w ? { x: w.x, y: w.y, w: w.w, h: w.h, kind: 'window', title: w.t } : { x: 0, y: 0, w: innerWidth, h: innerHeight, kind: 'screen' });
});
window.snip.onData((d) => {
  wins = d.windows || [];
  if (d.img) { const i = new Image(); i.onload = () => { img = i; fit(); }; i.src = d.img; }
  else draw();
});
</script>`;

const OVERLAY_PRELOAD = path.join(__dirname, 'snip-preload.js');

module.exports = function createSnip({ dumpDir, notify, log = () => {} }) {
  // ---- the window-list helper
  let helper = null, idle = null, pending = [], buf = '';
  function startHelper() {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(HELPER_PS, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const cb = pending.shift();
        if (cb) { try { cb(JSON.parse(line)); } catch { cb(null); } }
      }
    });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    p.on('exit', () => { if (helper === p) helper = null; if (err) log(`snip helper: ${err.trim().split('\n')[0]}`); for (const cb of pending.splice(0)) cb(null); });
    p.on('error', () => { if (helper === p) helper = null; });
    p.stdin.on('error', () => {});
    return p;
  }
  /** Windows front to back and the one in front, in physical pixels; null if the helper can't run. */
  function windowList() {
    clearTimeout(idle);
    idle = setTimeout(() => { try { helper?.kill(); } catch { /* gone */ } helper = null; }, HELPER_IDLE);
    if (!helper) helper = startHelper();
    return new Promise((resolve) => {
      const t = setTimeout(() => { const k = pending.indexOf(done); if (k >= 0) pending.splice(k, 1); resolve(null); }, 8000);
      const done = (v) => { clearTimeout(t); resolve(v); };
      pending.push(done);
      try { helper.stdin.write('list\n'); } catch { done(null); }
    });
  }

  // ---- capturing and saving
  /** Every display's picture, at its own full resolution. Windows scales every screen to the size asked for, so
   *  each different screen size is asked for separately (side by side, it costs no extra time). */
  async function grabScreens() {
    const displays = screen.getAllDisplays();
    const native = (d) => ({ width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) });
    const sizes = [...new Map(displays.map((d) => { const n = native(d); return [`${n.width}x${n.height}`, n]; })).entries()];
    const got = new Map(await Promise.all(sizes.map(async ([k, n]) => [k, await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: n })])));
    return displays.map((d, i) => {
      const n = native(d);
      const sources = got.get(`${n.width}x${n.height}`) || [];
      return { display: d, image: (sources.find((s) => s.display_id === String(d.id)) || sources[i])?.thumbnail };
    }).filter((s) => s.image && !s.image.isEmpty());
  }

  const two = (n) => String(n).padStart(2, '0');
  function save(image, title = '') {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
    fs.mkdirSync(dumpDir, { recursive: true });
    let file = path.join(dumpDir, `Screenshot ${stamp}.png`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dumpDir, `Screenshot ${stamp} (${n}).png`);
    fs.writeFileSync(file, image.toPNG());
    const { width, height } = image.getSize();
    notify({ path: file, name: path.basename(file), width, height, title });
    log(`screenshot: ${path.basename(file)} (${width}×${height})`);
  }
  /** `r` in DIPs relative to the display → the matching part of its full-resolution picture. */
  function crop(shot, r) {
    const { width: W, height: H } = shot.image.getSize();
    const kx = W / shot.display.bounds.width, ky = H / shot.display.bounds.height;
    const x = Math.max(0, Math.round(r.x * kx)), y = Math.max(0, Math.round(r.y * ky));
    const w = Math.min(W - x, Math.round(r.w * kx)), h = Math.min(H - y, Math.round(r.h * ky));
    return w > 0 && h > 0 ? shot.image.crop({ x, y, width: w, height: h }) : null;
  }
  const toDip = (r) => { try { return screen.screenToDipRect(null, { x: r.x, y: r.y, width: r.w, height: r.h }); } catch { return { x: r.x, y: r.y, width: r.w, height: r.h }; } };

  // ---- the overlay
  let busy = false;
  let overlays = [];
  function closeOverlays() { for (const w of overlays) if (!w.isDestroyed()) w.destroy(); overlays = []; }
  ipcMain.on('bds:snip-done', (e, r) => {
    const o = overlays.find((w) => !w.isDestroyed() && w.webContents === e.sender);
    if (!o || !o.shot) return;
    const shot = o.shot;
    closeOverlays();
    busy = false;
    if (!r) return;
    const img = crop(shot, r);
    if (img) save(img, r.kind === 'window' ? String(r.title || '') : '');
  });

  function overlayFor(display) {
    const b = display.bounds;
    const win = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height, show: false, frame: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
      enableLargerThanScreen: true, backgroundColor: '#000000', title: 'Screenshot',
      webPreferences: { preload: OVERLAY_PRELOAD, sandbox: true, contextIsolation: true, spellcheck: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setBounds(b); // again once it exists: Windows can resize it on a scaled display
    win.on('closed', () => { overlays = overlays.filter((w) => w !== win); if (!overlays.length) busy = false; });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(OVERLAY_HTML));
    overlays.push(win);
    return win;
  }

  async function start() {
    if (busy) return;
    busy = true;
    try {
      // the picture first (it's what was on screen at the press), the window list and the (hidden) overlays alongside
      const ready = screen.getAllDisplays().map((d) => [d.id, overlayFor(d)]);
      const [shots, list] = await Promise.all([grabScreens(), windowList()]);
      if (!shots.length) { closeOverlays(); busy = false; return; }
      // a fullscreen app in front (a game…): take its screen as it is; the overlays are never shown
      if (list?.front?.full) {
        closeOverlays();
        const fr = toDip(list.front);
        const target = screen.getDisplayNearestPoint({ x: Math.round(fr.x + fr.width / 2), y: Math.round(fr.y + fr.height / 2) });
        save((shots.find((s) => s.display.id === target.id) || shots[0]).image);
        busy = false;
        return;
      }
      const wins = (list?.windows || []).map((w) => { const d = toDip(w); return { x: d.x, y: d.y, w: d.width, h: d.height, t: w.t }; });
      const cursor = screen.getCursorScreenPoint();
      for (const [id, win] of ready) {
        const shot = shots.find((s) => s.display.id === id);
        if (!shot) { win.destroy(); continue; }
        win.shot = shot;
        const b = shot.display.bounds;
        const local = wins.map((w) => ({ x: w.x - b.x, y: w.y - b.y, w: w.w, h: w.h, t: w.t }));
        win.loaded.then(() => {
          if (win.isDestroyed()) return;
          // shown as a JPEG (quick to make); the saved file is cut from the full PNG-quality picture
          win.webContents.send('bds:snip-data', { img: 'data:image/jpeg;base64,' + shot.image.toJPEG(88).toString('base64'), windows: local });
          win.showInactive();
          if (cursor.x >= b.x && cursor.y >= b.y && cursor.x < b.x + b.width && cursor.y < b.y + b.height) win.focus();
        });
      }
    } catch (e) {
      log(`screenshot failed: ${e.message}`);
      closeOverlays();
      busy = false;
    }
  }

  return {
    /** Claim the key; false if something else on the PC has it. */
    register() {
      try { return globalShortcut.register(KEY, () => { start(); }); } catch { return false; }
    },
    dispose() {
      try { globalShortcut.unregister(KEY); } catch { /* not ours */ }
      closeOverlays();
      try { helper?.kill(); } catch { /* gone */ }
    },
    start,
  };
};
