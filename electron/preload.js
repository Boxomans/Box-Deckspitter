// Exposes a tiny, fixed bridge to the page. Nothing here reads or writes files directly.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bdsShell', {
  isShell: true,
  setTitlebar: (color, symbolColor, theme) => ipcRenderer.invoke('bds:titlebar', { color, symbolColor, theme }),
  setFullScreen: (on) => ipcRenderer.invoke('bds:fullscreen', !!on),
  dialog: (opts) => ipcRenderer.invoke('bds:dialog', opts),
  startDrag: (file) => ipcRenderer.send('bds:drag', file),
  copyImage: (pngDataUrl) => ipcRenderer.invoke('bds:copyImage', pngDataUrl),
  createShortcuts: () => ipcRenderer.invoke('bds:shortcuts'),
  appReady: () => ipcRenderer.send('bds:ready'), // tells the boot file an update started fine
});
