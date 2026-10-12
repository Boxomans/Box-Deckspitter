// Clipboard history + snippets for the ✂ clip tab. Records what you copy inside Box-DocSpitter: text
// (Ctrl+C anywhere, "Copy path", characters, emails…), pictures and files from the dumps. Saved in
// data/clips.json so it survives restarts; the factory reset erases it.

import { api } from './api.js';
import { debounce, blobToDataURL } from './dom.js';

const MAX_HISTORY = 150;
const MAX_TEXT = 100000;
const uidc = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const req = (method, url, body) => fetch(url, { method, headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`); return d; });

export function createClips(app) {
  const state = { history: [], snippets: [], loaded: false };
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } };
  const saveHistory = debounce(() => req('POST', '/api/clips', { history: state.history }).catch(() => {}), 600);
  const saveSnippets = debounce(() => req('POST', '/api/clips', { snippets: state.snippets }).catch(() => {}), 300);

  const ready = req('GET', '/api/clips').then((d) => {
    // anything copied before loading finished goes on top
    state.history = [...state.history, ...d.history.filter((x) => !state.history.some((y) => y.id === x.id))].slice(0, MAX_HISTORY);
    state.snippets = d.snippets;
    state.loaded = true;
    changed();
  }).catch(() => { state.loaded = true; });

  const same = (a, b) => a.type === b.type && (a.type === 'text' ? a.text === b.text : a.path === b.path && a.name === b.name);

  function add(entry) {
    if (!entry || !entry.type) return;
    if (entry.type === 'text') {
      if (typeof entry.text !== 'string' || !entry.text.trim()) return;
      entry.text = entry.text.slice(0, MAX_TEXT);
    }
    const existing = state.history.find((x) => same(x, entry));
    const item = { ...(existing || {}), ...entry, id: existing?.id || uidc(), at: Date.now(), pinned: existing?.pinned || false };
    state.history = [item, ...state.history.filter((x) => x !== existing)];
    // keep pinned entries; drop the oldest unpinned ones past the limit
    let unpinned = 0;
    state.history = state.history.filter((x) => x.pinned || ++unpinned <= MAX_HISTORY);
    saveHistory();
    changed();
  }

  // ---- capture text copies: Ctrl+C / Copy menu (the "copy" event) …
  let lastProgrammatic = '';
  document.addEventListener('copy', (e) => {
    if (e.target?.type === 'password') return;
    if (e.target?.closest?.('[data-no-clip]') || app.active?.editor?.secret) return; // Secure notes: never in the history
    setTimeout(() => {
      let text = '';
      try { text = e.clipboardData?.getData('text/plain') || ''; } catch { /* ignore */ }
      if (!text) text = String(getSelection() || '');
      if (text && text !== lastProgrammatic) add({ type: 'text', text, source: app.active?.title || 'Box-DocSpitter' });
    }, 0);
  });
  // … and copies made by buttons (navigator.clipboard.writeText)
  if (navigator.clipboard?.writeText) {
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text) => {
      lastProgrammatic = text;
      setTimeout(() => { if (lastProgrammatic === text) lastProgrammatic = ''; }, 200);
      if (!state.silent) add({ type: 'text', text: String(text), source: app.active?.title || 'Box-DocSpitter' });
      return orig(text);
    };
  }

  // ---- copying things back out
  async function copyText(text) {
    state.silent = true;
    try { await navigator.clipboard.writeText(text); } finally { state.silent = false; }
  }

  async function copyImage(url) {
    const blob = await (await fetch(url)).blob();
    let png = blob;
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      png = await new Promise((r) => c.toBlob(r, 'image/png'));
    }
    if (window.bdsShell?.copyImage) { if (!(await window.bdsShell.copyImage(await blobToDataURL(png)))) throw new Error('Could not read that image'); }
    else await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  }

  async function copyFile(path) { await req('POST', '/api/clip-file', { path }); }

  /** Copy any history entry or snippet back to the PC clipboard. */
  async function copyEntry(item) {
    if (item.type === 'image') await copyImage(item.url);
    else if (item.type === 'file') await copyFile(item.path);
    else await copyText(item.text);
    if (state.history.includes(item)) { item.at = Date.now(); state.history = [item, ...state.history.filter((x) => x !== item)]; saveHistory(); changed(); }
  }

  return {
    ready,
    get history() { return state.history; },
    get snippets() { return state.snippets; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    add,
    copyEntry,
    copyText,
    remove(item) { state.history = state.history.filter((x) => x !== item); saveHistory(); changed(); },
    togglePin(item) { item.pinned = !item.pinned; saveHistory(); changed(); },
    clearHistory() { state.history = state.history.filter((x) => x.pinned); saveHistory(); changed(); },
    // snippets
    addSnippet(title, text) { const s = { id: uidc(), title: String(title || '').slice(0, 120), text: String(text || '').slice(0, MAX_TEXT), at: Date.now() }; state.snippets = [s, ...state.snippets]; saveSnippets(); changed(); return s; },
    updateSnippet(s, patch) { Object.assign(s, patch, { at: Date.now() }); saveSnippets(); changed(); },
    removeSnippet(s) { state.snippets = state.snippets.filter((x) => x !== s); saveSnippets(); changed(); },
    moveSnippet(s, dir) {
      const i = state.snippets.indexOf(s);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= state.snippets.length) return;
      const list = [...state.snippets];
      [list[i], list[j]] = [list[j], list[i]];
      state.snippets = list;
      saveSnippets();
      changed();
    },
  };
}
