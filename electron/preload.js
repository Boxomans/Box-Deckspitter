// Exposes a tiny, fixed bridge to the page. Nothing here reads or writes files directly.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bdsShell', {
  isShell: true,
  setTitlebar: (color, symbolColor, theme) => ipcRenderer.invoke('bds:titlebar', { color, symbolColor, theme }),
  setFullScreen: (on) => ipcRenderer.invoke('bds:fullscreen', !!on),
  isFullScreen: () => ipcRenderer.invoke('bds:is-fullscreen'),
  onFullScreen: (cb) => { ipcRenderer.on('bds:fullscreen-changed', (_e, on) => cb(!!on)); },
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
  // the built-in browser: requests ({ op, ... } → { ok, ... }) and events from its pages (new tab, keys, saved…)
  browser: (req) => ipcRenderer.invoke('bds:browser', req),
  onBrowser: (cb) => { ipcRenderer.on('bds:browser-event', (_e, ev) => cb(ev)); },
  // several app windows: which one this is, dragging it by a tab, and tabs dragged out into a window of their own
  winInfo: () => ipcRenderer.invoke('bds:win-info'),
  moveWindow: (x, y, dx, dy) => ipcRenderer.send('bds:move-window', [x, y, dx, dy]),
  tearOff: (req) => ipcRenderer.invoke('bds:tear-off', req),
  adopt: (token) => ipcRenderer.invoke('bds:adopt', token),
  onMainWindow: (cb) => { ipcRenderer.on('bds:main-window', () => cb()); },
  // a Win+Shift+Q screenshot was saved into the media dump ({ path, name, width, height })
  onSnip: (cb) => { ipcRenderer.on('bds:snip-saved', (_e, info) => cb(info)); },
  // BoxStudio: { op: 'sources' | 'hotkeys' | 'unhotkeys' | 'busy', … } → { ok, … }, and its global hotkeys being pressed
  studio: (req) => ipcRenderer.invoke('bds:studio', req),
  onStudioKey: (cb) => { ipcRenderer.on('bds:studio-key', (_e, action) => cb(action)); },
  // an area picked with the record-this-area key: { displayId, kind, title, x, y, w, h } as fractions of that display
  onStudioArea: (cb) => { ipcRenderer.on('bds:studio-area', (_e, area) => cb(area)); },
});
