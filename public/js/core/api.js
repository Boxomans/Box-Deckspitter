// Thin client for the local Box-DocSpitter server API.

const TOKEN = window.BDS?.token || '';
const enc = encodeURIComponent;

async function request(method, url, { json, body, raw } = {}) {
  const headers = { 'X-BDS-Token': TOKEN };
  let payload = body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload });
  } catch (e) {
    const err = new Error('Cannot reach the Box-DocSpitter server. Is it still running?');
    err.offline = true;
    throw err;
  }
  if (!res.ok) {
    let data;
    try { data = await res.json(); } catch { data = { error: res.statusText }; }
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  if (raw) return res;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : new Uint8Array(await res.arrayBuffer());
}

export const api = {
  token: TOKEN,
  info: () => request('GET', '/api/info'),
  list: (path) => request('GET', `/api/list?path=${enc(path)}`),
  stat: (path) => request('GET', `/api/stat?path=${enc(path)}`),

  async read(path) {
    const res = await request('GET', `/api/read?path=${enc(path)}`, { raw: true });
    return { bytes: new Uint8Array(await res.arrayBuffer()), mtime: Number(res.headers.get('X-Mtime')) || null };
  },

  write(path, data, { expectMtime, force } = {}) {
    let url = `/api/write?path=${enc(path)}`;
    if (expectMtime) url += `&expectMtime=${expectMtime}`;
    if (force) url += '&force=1';
    return request('POST', url, { body: data });
  },

  mkdir: (path) => request('POST', '/api/mkdir', { json: { path } }),
  rename: (from, to) => request('POST', '/api/rename', { json: { from, to } }),

  recent: () => request('GET', '/api/recent'),
  addRecent: (path) => request('POST', '/api/recent', { json: { path } }),
  removeRecent: (path) => request('POST', '/api/recent/remove', { json: { path } }),

  settings: () => request('GET', '/api/settings'),
  saveSettings: (patch) => request('POST', '/api/settings', { json: patch }),
  setBackground: (path) => request('POST', '/api/background', { json: { path } }),
  clearBackground: () => request('POST', '/api/background/clear', { json: {} }),
  setWallpaper: (path) => request('POST', '/api/wallpaper', { json: { path } }),
  fonts: () => request('GET', '/api/fonts'),
  getFont: (name) => request('POST', '/api/fonts/get', { json: { name } }),
  addFontFile: (path) => request('POST', '/api/fonts/file', { json: { path } }),
  removeFont: (id) => request('POST', '/api/fonts/remove', { json: { id } }),

  versions: (path) => request('GET', `/api/versions?path=${enc(path)}`),
  async readVersion(path, id) {
    const res = await request('GET', `/api/version?path=${enc(path)}&id=${enc(id)}`, { raw: true });
    return new Uint8Array(await res.arrayBuffer());
  },

  drafts: () => request('GET', '/api/drafts'),
  draft: (id) => request('GET', `/api/draft?id=${enc(id)}`),
  saveDraft: (d) => request('POST', '/api/draft', { json: d }),
  deleteDraft: (id) => request('POST', '/api/draft/delete', { json: { id } }),

  dialog: (opts) => request('POST', '/api/dialog', { json: opts }),
  printPdf: (html) => request('POST', '/api/print-pdf', { body: html }),

  fonts: () => request('GET', '/api/fonts'),
  font: (family, bold, italic) => request('GET', `/api/font?family=${enc(family)}&bold=${bold ? 1 : 0}&italic=${italic ? 1 : 0}`),

  reveal: (path) => request('POST', '/api/reveal', { json: { path } }),
  heartbeat: (clientId) => request('POST', '/api/heartbeat', { json: { clientId } }),
  bye(clientId) {
    try { navigator.sendBeacon(`/api/bye?token=${enc(TOKEN)}&clientId=${enc(clientId)}`, ''); } catch { /* ignore */ }
  },
  newWindow: () => request('POST', '/api/new-window', { json: {} }),
  previewRoot: (dir) => request('POST', '/api/preview-root', { json: { dir } }),

  files: (root) => request('GET', `/api/files?root=${enc(root)}`),
  search: (body) => request('POST', '/api/search', { json: body }),
  git: (root) => request('GET', `/api/git?root=${enc(root)}`),
  trash: (path) => request('POST', '/api/trash', { json: { path } }),
  tools: () => request('GET', '/api/tools'),

  presence: (body) => request('POST', '/api/presence', { json: body }),
  presenceStatus: () => request('GET', '/api/presence'),

  get: (url) => request('GET', url),
  post: (url, json = {}) => request('POST', url, { json }),
  /** dir: a folder in the dump ('' = the top) → its folders and files; leave it out for every file. */
  dump: (kind = 'image', dir) => request('GET', `/api/dump?kind=${enc(kind)}${dir != null ? `&dir=${enc(dir)}` : ''}`),
  dumpFolder: (path, kind = 'media') => request('POST', '/api/dump/folder', { json: { path, kind } }),
  dumpMove: (names, to, kind = 'media') => request('POST', '/api/dump/move', { json: { names, to, kind } }),
  dumpAdd: (name, bytes, kind = 'image') => request('POST', `/api/dump/add?name=${enc(name)}&kind=${enc(kind)}`, { body: bytes }),
  customSounds: () => request('GET', '/api/sounds/custom'),
  customSound: (name) => request('GET', `/api/sounds/file?name=${enc(name)}`),
  setCustomSound: (name, ext, bytes) => request('POST', `/api/sounds/custom?name=${enc(name)}&ext=${enc(ext)}`, { body: bytes }),
  resetSound: (name = null) => request('POST', '/api/sounds/reset', { json: { name } }),
  dumpImport: (path, kind = 'media', name, folder) => request('POST', '/api/dump/import', { json: { path, kind, name, folder } }),
  dumpReserve: (name, kind = 'media') => request('POST', '/api/dump/reserve', { json: { name, kind } }),
  dumpRemove: (name, kind = 'image') => request('POST', '/api/dump/remove', { json: { name, kind } }),
  dumpRename: (name, to, kind = 'image') => request('POST', '/api/dump/rename', { json: { name, to, kind } }),
  dumpIdentical: (kind = 'image') => request('GET', `/api/dump/identical?kind=${enc(kind)}`),
  dumpReveal: (kind = 'image', name, folder) => request('POST', '/api/dump/reveal', { json: { kind, name, folder } }),
  dumpClip: (name, kind = 'image') => request('POST', '/api/dump/clip', { json: { name, kind } }),
  quit: () => request('POST', '/api/quit', { json: {} }),
};
