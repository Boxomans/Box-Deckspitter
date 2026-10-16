// The screenshot overlay's bridge (electron/snip.js): it gets the frozen screen and says what was picked.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snip', {
  onData: (cb) => { ipcRenderer.on('bds:snip-data', (_e, d) => cb(d)); },
  done: (r) => ipcRenderer.send('bds:snip-done', r),
});
