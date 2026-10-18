// BoxStudio, the desktop side: what can be captured (screens and windows, with thumbnails), global hotkeys that
// work while another app (a game) has focus, the pick-an-area overlay (shared with the screenshot key), and keeping
// the page running at full speed while it records.

const { BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen } = require('electron');

module.exports = function createStudio({ isAppSender, pickArea = null, log = () => {} }) {
  let owner = null; // the webContents whose hotkeys are registered
  let keys = new Map(); // accelerator -> action

  function clearKeys() {
    for (const accel of keys.keys()) { try { globalShortcut.unregister(accel); } catch { /* not ours any more */ } }
    keys = new Map();
    owner = null;
  }

  async function sources() {
    const displays = new Map(screen.getAllDisplays().map((d) => [String(d.id), d]));
    // the app's own windows aren't offered (recording a window of the recorder shows itself)
    const own = new Set(BrowserWindow.getAllWindows().map((w) => { try { return w.getMediaSourceId(); } catch { return ''; } }));
    const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    return list.map((s) => {
      const d = displays.get(String(s.display_id));
      const size = d ? { w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor) } : null;
      return {
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        display: s.display_id ? String(s.display_id) : '',
        thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
        ...(size || {}),
      };
    }).filter((s) => s.kind === 'screen' || !own.has(s.id));
  }

  ipcMain.handle('bds:studio', async (e, req = {}) => {
    if (!isAppSender(e)) return { ok: false, error: 'Not allowed' };
    try {
      switch (req.op) {
        case 'sources':
          return { ok: true, list: await sources() };
        case 'hotkeys': {
          // { keys: { action: 'Ctrl+Alt+R', … } } replaces everything this window had registered
          clearKeys();
          const failed = [];
          const wc = e.sender;
          owner = wc;
          for (const [action, accel] of Object.entries(req.keys || {})) {
            if (!accel || typeof accel !== 'string' || keys.has(accel)) { if (accel) failed.push(action); continue; }
            let ok = false;
            try { ok = globalShortcut.register(accel, () => {
              if (wc.isDestroyed()) return;
              // the record-this-area key opens the screenshot overlay right where you are; the page gets the area
              if (action === 'area' && pickArea) pickArea((area) => { if (!wc.isDestroyed()) wc.send('bds:studio-area', area); });
              else wc.send('bds:studio-key', action);
            }); } catch { ok = false; }
            if (ok) keys.set(accel, action); else failed.push(action);
          }
          wc.once('destroyed', () => { if (owner === wc) clearKeys(); });
          return { ok: true, failed };
        }
        case 'unhotkeys':
          if (owner === e.sender) clearKeys();
          return { ok: true };
        case 'area':
          // the same overlay from a button in the app
          if (!pickArea) return { ok: false, error: 'Not available' };
          pickArea((area) => { if (!e.sender.isDestroyed()) e.sender.send('bds:studio-area', area); });
          return { ok: true };
        case 'busy':
          // while recording, a hidden or minimized window must not be slowed down
          e.sender.setBackgroundThrottling(!req.on);
          return { ok: true };
        default:
          return { ok: false, error: 'Unknown request' };
      }
    } catch (err) {
      log(`studio: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  return { dispose: clearKeys };
};
