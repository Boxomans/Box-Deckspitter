// The screensaver, the desktop side (the page decides when: public/js/app/screensaver.js). It covers every screen,
// over every program, with a window of its own on each display showing public/saver.html; any key, click or real
// mouse move anywhere ends it. And whether something else on the PC is playing: sound coming out of the speakers, or
// a program full screen (a video, a game, a presentation), so the screensaver waits.

const { BrowserWindow, powerMonitor, screen } = require('electron');
const { spawn, execFile } = require('child_process');

// Windows: the loudness on the default speakers right now (Core Audio's meter) and whether a program has the screen
// to itself (SHQueryUserNotificationState: 2 busy full screen, 3 Direct3D full screen, 4 presentation mode).
const WIN_PROBE = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BdsProbe {
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int EnumAudioEndpoints(); [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation { [PreserveSig] int GetPeakValue(out float peak); }
  public static float Peak() {
    try {
      IMMDevice dev;
      if (((IMMDeviceEnumerator)new MMDeviceEnumerator()).GetDefaultAudioEndpoint(0, 0, out dev) != 0) return 0;
      Guid iid = typeof(IAudioMeterInformation).GUID; object o;
      if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return 0;
      float p; ((IAudioMeterInformation)o).GetPeakValue(out p); return p;
    } catch { return 0; }
  }
  public static int Screen() { int s; return SHQueryUserNotificationState(out s) == 0 ? s : 0; }
}
'@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $peak = 0
  for ($i = 0; $i -lt 8; $i++) { $v = [BdsProbe]::Peak(); if ($v -gt $peak) { $peak = $v }; Start-Sleep -Milliseconds 150 }
  [Console]::Out.WriteLine($peak.ToString([Globalization.CultureInfo]::InvariantCulture) + ' ' + [BdsProbe]::Screen())
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

  /** Is something on the PC playing (sound out of the speakers, or a program full screen)? */
  async function playing() {
    if (process.platform === 'win32') {
      const [peak, state] = (await winProbe()).split(' ').map(Number);
      // the app itself full screen (left that way) doesn't count
      const ours = BrowserWindow.getFocusedWindow()?.isFullScreen();
      return peak > 0.001 || (!ours && state >= 2 && state <= 4);
    }
    if (process.platform === 'linux') {
      // PulseAudio / PipeWire: a stream that isn't paused
      return new Promise((resolve) => execFile('pactl', ['list', 'sink-inputs'], { timeout: 4000 }, (err, out) => resolve(!err && /Corked:\s*no/i.test(out))));
    }
    return false;
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
