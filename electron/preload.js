// Exposes a tiny, fixed bridge to the page. Nothing here reads or writes files directly.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bdsShell', {
  isShell: true,
  setTitlebar: (color, symbolColor, theme) => ipcRenderer.invoke('bds:titlebar', { color, symbolColor, theme }),
  setFullScreen: (on) => ipcRenderer.invoke('bds:fullscreen', !!on),
  dialog: (opts) => ipcRenderer.invoke('bds:dialog', opts),
  startDrag: (file) => ipcRenderer.send('bds:drag', file),
  copyImage: (pngDataUrl) => ipcRenderer.invoke('bds:copyImage', pngDataUrl),
  createShortcuts: () => ipcRenderer.invoke('bds:shortcuts'),
  // where a file dropped from Explorer lives on disk (the video editor uses files in place, without copying them)
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  appReady: () => ipcRenderer.send('bds:ready'), // tells the boot file an update started fine
  // Secure notes: one request at a time to the window's process ({ op, ... } → { ok, ... })
  notes: (req) => ipcRenderer.invoke('bds:notes', req),
  onNotesLocked: (cb) => { ipcRenderer.on('bds:notes-locked', (_e, reason) => cb(reason)); },
  onSystemLock: (cb) => { ipcRenderer.on('bds:system-lock', (_e, why) => cb(why)); },
});
