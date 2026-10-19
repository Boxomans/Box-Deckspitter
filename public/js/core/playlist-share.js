// Sharing playlists with friends: a playlist becomes a code to paste them (or a .plylst file to send), listing each
// song's link and name. Importing one opens BoxTape with those songs, ready to download into a playlist of that name.

import { h } from './dom.js';
import { modal, toast, errorToast } from './ui.js';
import { api } from './api.js';
import { pickSave, pickOpen } from './files.js';

/** The Share dialog for one playlist: copy its code, or save it as a .plylst file. */
export async function sharePlaylist(app, name) {
  let r;
  try { r = await api.get(`/api/audio/share?playlist=${encodeURIComponent(name)}`); } catch (e) { errorToast(e, 'Couldn’t share that playlist'); return; }
  const unlinked = r.count - r.linked;
  const code = h('textarea', { class: 'plylst-code mono', readonly: true, spellcheck: 'false', rows: 4 }, r.code);
  code.addEventListener('focus', () => code.select());
  const copy = async () => {
    try { await navigator.clipboard.writeText(r.code); toast('Code copied. Your friend pastes it into Import in their music player.', { type: 'ok', timeout: 3200 }); }
    catch { code.focus(); code.select(); }
  };
  const save = async () => {
    const res = await pickSave({ title: 'Save the playlist', defaultName: `${r.name}.plylst`, filters: [{ name: 'Shared playlist', extensions: ['plylst'] }] });
    if (!res) return;
    const p = /\.plylst$/i.test(res.path) ? res.path : `${res.path}.plylst`;
    try { await api.write(p, new TextEncoder().encode(r.file)); toast('Playlist saved. Send the file to a friend; it opens in their music player.', { type: 'ok', timeout: 3200 }); }
    catch (e) { errorToast(e, 'Couldn’t save it'); }
  };
  await modal({
    title: `Share “${r.name}”`, wide: true,
    body: h('div', { class: 'plylst' },
      h('p', {}, `${r.count} song${r.count === 1 ? '' : 's'}. This shares where each song came from, not the music, so your friend’s app downloads them itself.`),
      unlinked ? h('p', { class: 'faint' }, `${unlinked === r.count ? 'None of them have' : unlinked === 1 ? '1 of them doesn’t have' : `${unlinked} of them don’t have`} the link ${unlinked === 1 ? 'it was' : 'they were'} downloaded from, so ${unlinked === 1 ? 'it gets' : 'they get'} matched on YouTube by name.`) : null,
      r.more ? h('p', { class: 'faint' }, `Only the first 500 songs fit; ${r.more} more are left out.`) : null,
      code,
      h('div', { class: 'faint plylst-len' }, `${r.code.length.toLocaleString()} characters`)),
    buttons: [
      { label: 'Save as .plylst…', onClick: async () => { await save(); return false; } },
      { label: 'Copy code', primary: true, onClick: async () => { await copy(); return false; } },
    ],
  });
}

/** The Import dialog: paste a code, or open a .plylst file. True once one opened in BoxTape. */
export async function importPlaylist(app) {
  const text = h('textarea', { class: 'plylst-code mono', rows: 4, spellcheck: 'false', placeholder: 'Paste a playlist code (it starts with PLYLST1:)' });
  const err = h('div', { class: 'plylst-err' });
  const go = async (src, ctx) => {
    err.textContent = '';
    try {
      const pl = await api.post('/api/audio/share/read', src);
      ctx.close(true);
      await openShared(app, pl);
    } catch (e) { err.textContent = e.message; }
  };
  const done = await modal({
    title: 'Import a playlist',
    body: h('div', { class: 'plylst' },
      h('p', {}, 'Paste the code a friend sent you, or open their .plylst file. You see the songs before anything downloads.'),
      text, err),
    onOpen: () => setTimeout(() => text.focus(), 30),
    buttons: [
      { label: 'Open a .plylst file…', onClick: async (ctx) => {
        const paths = await pickOpen({ title: 'Open a shared playlist', filters: [{ name: 'Shared playlist', extensions: ['plylst'] }, { name: 'All files', extensions: ['*'] }] });
        if (paths) await go({ path: paths[0] }, ctx);
        return false;
      } },
      { label: 'Import', primary: true, onClick: async (ctx) => {
        if (!text.value.trim()) { err.textContent = 'Paste a code first.'; return false; }
        await go({ text: text.value }, ctx);
        return false;
      } },
    ],
  });
  return done === true;
}

/** A read playlist → BoxTape, showing its songs. */
export async function openShared(app, pl) {
  const tab = await app.newDocument('tape');
  if (tab?.editor?.loadShared) await tab.editor.loadShared(pl);
  return tab;
}

/** A .plylst file (by path, or its text when dropped in) → BoxTape. */
export async function openSharedFile(app, src) {
  try { return await openShared(app, await api.post('/api/audio/share/read', src)); }
  catch (e) { errorToast(e, 'Couldn’t open that playlist'); return null; }
}
