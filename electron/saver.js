// The screensaver, the desktop side (the page decides when: public/js/app/screensaver.js). It covers every screen,
// over every program, with a window of its own on each display showing public/saver.html; any key, click or real
// mouse move anywhere ends it. And whether a video is playing somewhere on the PC, so the screensaver waits: music
// doesn't hold it up, only video.

const { BrowserWindow, powerMonitor, screen } = require('electron');
const { spawn } = require('child_process');

// Windows: whether a program is keeping the screen on (players and browsers ask for that while a video plays, not for
// music: SystemExecutionState's ES_DISPLAY_REQUIRED) and whether a program has the screen to itself
// (SHQueryUserNotificationState: 2 busy full screen, 3 Direct3D full screen, 4 presentation mode).
const WIN_PROBE = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BdsProbe {
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  [DllImport("powrprof.dll")] static extern uint CallNtPowerInformation(int level, IntPtr inBuf, uint inLen, out uint outBuf, uint outLen);
  public static int Display() { uint s; return CallNtPowerInformation(16, IntPtr.Zero, 0, out s, 4) == 0 && (s & 2) != 0 ? 1 : 0; }
  public static int Screen() { int s; return SHQueryUserNotificationState(out s) == 0 ? s : 0; }
}
'@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  [Console]::Out.WriteLine([string][BdsProbe]::Display() + ' ' + [BdsProbe]::Screen())
  [Console]::Out.Flush()
}
`;

module.exports = function createSaver({ origin, log = () => {} }) {
  let wins = [];
  let watch = null;
  let probe = null; // the Windows helper, kept running once started (starting PowerShell takes a while)
  let waiting = []; // answers it owes

  function winProbe() {
    if (!probe) {
      probe = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WIN_PROBE, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      let buf = '';
      probe.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); waiting.shift()?.(line); }
      });
      const gone = () => { probe = null; for (const w of waiting.splice(0)) w(''); };
      probe.on('exit', gone);
      probe.on('error', (e) => { log(`probe: ${e.message}`); gone(); });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(''), 15000); // the first answer waits for the helper to start
      waiting.push((line) => { clearTimeout(timer); resolve(line); });
      try { probe.stdin.write('check\n'); } catch { resolve(''); }
    });
  }

  /** Is a video playing on the PC (a program keeping the screen on, or one full screen)? Music doesn't count. */
  async function playing() {
    if (process.platform !== 'win32') return false; // Linux: only a video in the app itself holds it up (the page checks that)
    const [video, state] = (await winProbe()).split(' ').map(Number);
    // the app itself full screen (left that way) doesn't count
    const ours = BrowserWindow.getFocusedWindow()?.isFullScreen();
    return video === 1 || (!ours && state >= 2 && state <= 4);
  }

  function stop() {
    clearInterval(watch);
    watch = null;
    const list = wins;
    wins = [];
    for (const w of list) if (!w.isDestroyed()) w.close();
  }

  /** Covers every display with the screensaver (a saver as BoxSaver keeps it). Nothing if it's already up. */
  function start(saver) {
    if (wins.length || !origin()) return false;
    const json = JSON.stringify(saver);
    for (const d of screen.getAllDisplays()) {
      const w = new BrowserWindow({
        ...d.bounds, show: false, frame: false, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true,
        // no shadow or border (Windows 11 draws them round a frameless window, onto the next screen)
        hasShadow: false, thickFrame: false, roundedCorners: false,
        backgroundColor: '#000000', title: 'Screensaver',
        webPreferences: { sandbox: true, contextIsolation: true },
      });
      w.setAlwaysOnTop(true, 'screen-saver');
      w.setMenu(null);
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      w.webContents.on('will-navigate', (e) => e.preventDefault());
      w.webContents.once('did-finish-load', () => {
        w.webContents.executeJavaScript(`window.showSaver(${json})`).catch(() => {});
        if (w.isDestroyed()) return;
        w.showInactive();
        w.setBounds(d.bounds);
        w.setFullScreen(true);
      });
      w.on('closed', () => { if (wins.includes(w)) stop(); }); // one gone (Alt+F4…): all go
      w.loadURL(`${origin()}/saver.html`);
      w.bdsMain = d.id === screen.getPrimaryDisplay().id;
      wins.push(w);
    }
    // anything at all ends it: a key or click (the PC's idle time starts again with the pointer where it was) or the
    // pointer moving a bit (a jolt of a pixel or two doesn't count). Not in the first moment: the hand settling.
    const t0 = Date.now(), from = screen.getCursorScreenPoint();
    let last = from, tick = 0;
    watch = setInterval(() => {
      const p = screen.getCursorScreenPoint(), still = p.x === last.x && p.y === last.y;
      last = p;
      // over the taskbars too, which put themselves back on top now and then
      if (tick++ % 4 === 0) for (const w of wins) if (!w.isDestroyed()) { w.setAlwaysOnTop(true, 'screen-saver'); w.moveTop(); }
      if (Date.now() - t0 < 1500) return;
      if (Math.hypot(p.x - from.x, p.y - from.y) >= 10 || (still && powerMonitor.getSystemIdleTime() < 1)) stop();
    }, 250);
    // the keys go to the screensaver, not to whatever program was in front. The one on the main screen: Windows hides
    // a screen's taskbar only under the window in front
    setTimeout(() => { const w = wins.find((x) => x.bdsMain) || wins[0]; if (w && !w.isDestroyed()) w.focus(); }, 300);
    return true;
  }

  return {
    start,
    stop,
    playing,
    running: () => wins.length > 0,
    dispose() { stop(); try { probe?.kill(); } catch { /* gone */ } probe = null; },
  };
};
