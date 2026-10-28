// Folders the page is showing (BoxSpaces, the file explorer, the dumps…) are watched here, so their lists update by
// themselves when anything adds, removes or renames a file in them: Explorer, a download, another program.
// The page asks for a number per folder every couple of seconds (core/watch.js); the number goes up on a change.

'use strict';

const fs = require('fs');

module.exports = function createWatch({ dumpRev, readJSONBody, requirePath }) {
  const MAX = 64; // folders watched at once; the longest-unasked one goes first
  const IDLE = 60e3; // a folder nobody has asked about for a minute stops being watched
  const dirs = new Map(); // folder → { rev, watcher, poll, asked }

  function forget(dir) {
    const w = dirs.get(dir);
    try { w?.watcher?.close(); } catch { /* already closed */ }
    dirs.delete(dir);
  }
  // where a folder can't be watched (some network drives), its last-changed time does the job: adding, removing or
  // renaming a file in it changes that on every drive we know
  const stamp = (dir) => { try { return fs.statSync(dir).mtimeMs; } catch { return -1; } };

  /** Just the folder's own files and folders, not what's inside its folders (BoxSpaces asks for each open one). */
  function dirRev(dir) {
    let w = dirs.get(dir);
    if (!w) {
      if (dirs.size >= MAX) forget([...dirs.entries()].sort((a, b) => a[1].asked - b[1].asked)[0][0]);
      w = { rev: 1, asked: 0 };
      dirs.set(dir, w);
      try {
        w.watcher = fs.watch(dir, () => { w.rev++; });
        w.watcher.on('error', () => { try { w.watcher.close(); } catch { /* gone */ } w.watcher = null; w.poll = true; w.rev++; });
      } catch { w.poll = true; }
    }
    w.asked = Date.now();
    return w.poll ? stamp(dir) : w.rev;
  }

  setInterval(() => { const old = Date.now() - IDLE; for (const [dir, w] of dirs) if (w.asked < old) forget(dir); }, 30e3).unref();

  const routes = {
    // { keys: ['C:\\some\\folder', 'dump:media', …] } → { revs: { key: number } }
    'POST /api/watch': async (req) => {
      const body = await readJSONBody(req);
      const keys = (Array.isArray(body.keys) ? body.keys : []).filter((k) => typeof k === 'string').slice(0, 100);
      const revs = {};
      for (const k of keys) {
        try { revs[k] = k.startsWith('dump:') ? dumpRev(k.slice(5)) : dirRev(requirePath(k)); } catch { revs[k] = -1; }
      }
      return { revs };
    },
  };

  return { routes };
};
