// File lists update by themselves (BoxSpaces, the file explorer, the dumps, the video editor's media tab…): each list
// says which folders it shows, and is called again when one of them changes on disk (watch-server.js). One small ask
// every two seconds covers every list; nothing is asked while the window is minimised.
// Keys are absolute folder paths, or 'dump:<kind>' for a whole dump (its folders included).

import { api } from './api.js';
import { menusOpen } from './ui.js';

const lists = new Map(); // owner → { keys, onChange, alive, revs }
let timer = null;
let busy = false;
let held = 0; // a mouse button is down (dragging, rubber-band picking): changes wait until it's let go

addEventListener('pointerdown', () => { held++; }, true);
addEventListener('pointerup', () => { held = 0; }, true);
addEventListener('pointercancel', () => { held = 0; }, true);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

/**
 * Watch these folders for this list (the owner: any object or string, one watch each; calling again replaces it).
 * onChange runs once after the folders change; alive() says whether the list is still on screen (when it says no,
 * the watch ends by itself).
 */
export function watchFolders(owner, keys, onChange, alive = () => true) {
  const old = lists.get(owner);
  const want = [...new Set(keys.filter(Boolean))];
  lists.set(owner, { keys: want, onChange, alive, revs: old && old.keys.join('\n') === want.join('\n') ? old.revs : new Map() });
  if (!timer) timer = setInterval(tick, 2000);
}
export function unwatchFolders(owner) { lists.delete(owner); }

async function tick() {
  if (busy || document.hidden) return;
  for (const [owner, l] of lists) if (!l.alive()) lists.delete(owner);
  if (!lists.size) { clearInterval(timer); timer = null; return; }
  const keys = [...new Set([...lists.values()].flatMap((l) => l.keys))];
  busy = true;
  let revs;
  try { revs = (await api.post('/api/watch', { keys })).revs || {}; } catch { busy = false; return; } // busy or restarting
  busy = false;
  for (const l of [...lists.values()]) {
    let changed = false;
    for (const k of l.keys) {
      if (!(k in revs)) continue;
      if (l.revs.has(k) && l.revs.get(k) !== revs[k]) changed = true;
      else if (!l.revs.has(k)) l.revs.set(k, revs[k]);
    }
    // while a button is held, a menu is open or a name is being edited, the old numbers stay: it runs once that's done
    if (!changed || held || menusOpen() || document.querySelector('.inline-rename')) continue;
    for (const k of l.keys) if (k in revs) l.revs.set(k, revs[k]);
    try { await l.onChange(); } catch { /* the list redraws on its next change */ }
  }
}

/**
 * Redraw a side panel without losing your place: the scroll position, and the box you were typing in (with its
 * cursor) come back after render() has rebuilt it.
 */
export async function redrawKeepingPlace(host, render) {
  const scrollers = [...host.querySelectorAll('.panel-body, .file-list')].map((el) => el.scrollTop);
  const a = document.activeElement;
  const typing = a && host.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') ? { tag: a.tagName, cls: a.className, type: a.type, s: a.selectionStart, e: a.selectionEnd } : null;
  await render();
  [...host.querySelectorAll('.panel-body, .file-list')].forEach((el, i) => { if (scrollers[i]) el.scrollTop = scrollers[i]; });
  if (typing) {
    const el = [...host.querySelectorAll(typing.tag === 'TEXTAREA' ? 'textarea' : 'input')].find((x) => x.className === typing.cls && x.type === typing.type);
    if (el) { el.focus(); try { el.setSelectionRange(typing.s, typing.e); } catch { /* not a text box */ } }
  }
}
