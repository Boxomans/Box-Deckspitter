// Translate: right-click selected text anywhere in the app → "Translate to …" shows the translation in a small popup
// (change the language there, copy it, put it in place of the selection, or just close it), and in a field you can
// type in, "Translate and replace" swaps it straight in. Text goes through the local server to Google Translate.
// Menus made with contextMenu() get the items on top (setContextExtras); places with no menu of their own get one
// with them plus copy (and cut and paste in fields). The code editor and the Browser's pages add theirs too.

import { api } from './api.js';
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { toast, showMenu, setContextExtras } from './ui.js';

const LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'sv', 'no', 'da', 'fi', 'pl', 'cs', 'uk', 'ru', 'el', 'tr', 'ar', 'he', 'fa', 'hi', 'bn',
  'ur', 'th', 'vi', 'id', 'ms', 'tl', 'zh-CN', 'zh-TW', 'ja', 'ko', 'ro', 'hu', 'bg', 'hr', 'sr', 'sk', 'sl', 'lt', 'lv', 'et', 'ga', 'cy', 'is', 'sw', 'af', 'la'];
const names = (() => { try { return new Intl.DisplayNames(undefined, { type: 'language' }); } catch { return null; } })();
export const langName = (code) => { try { return names?.of(code) || code; } catch { return code; } };
const short = (t, n = 24) => { t = t.trim().replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n)}…` : t; };
const FIELD_TYPES = /^(text|search|url|email|)$/;

/** What's selected where the right-click happened: { text, restore() (selects it again), replace(out) → true if it
 *  went in } or null. */
export function grabSelection(target) {
  const field = target?.closest?.('input, textarea');
  if (field && (field.tagName === 'TEXTAREA' || FIELD_TYPES.test(field.type || ''))) {
    const s = field.selectionStart, e = field.selectionEnd;
    if (s == null || s === e) return null;
    const text = field.value.slice(s, e);
    if (!text.trim()) return null;
    const replace = field.readOnly || field.disabled ? null : (out) => {
      if (!field.isConnected || field.value.slice(s, e) !== text) return false; // changed since
      field.focus();
      field.setSelectionRange(s, e);
      // insertText keeps Ctrl+Z working; setRangeText if the field won't take it
      if (!document.execCommand('insertText', false, out)) { field.setRangeText(out, s, e, 'end'); field.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    };
    return { text, replace, restore: () => { field.focus(); field.setSelectionRange(s, e); } };
  }
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const range = sel.getRangeAt(0);
  const common = range.commonAncestorContainer;
  // only when the click is on (or around) the selection, not somewhere else on the page
  if (target && !(target.contains?.(common) || range.intersectsNode(target))) return null;
  const el = common.nodeType === 1 ? common : common.parentElement;
  const host = el?.isContentEditable ? el : null;
  const saved = range.cloneRange();
  const replace = host ? (out) => {
    if (!saved.startContainer.isConnected) return false;
    host.focus();
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(saved);
    if (s.toString() !== text) return false;
    document.execCommand('insertText', false, out);
    return true;
  } : null;
  const restore = () => { host?.focus(); const s = getSelection(); s.removeAllRanges(); s.addRange(saved); };
  return { text, replace, restore };
}

export function createTranslate(app) {
  const to = () => app.settings.translateTo || (navigator.language || 'en').split('-')[0] || 'en';
  const langs = () => (LANGS.includes(to()) ? LANGS : [to(), ...LANGS]);

  async function run(text, lang = to()) {
    return api.translate(text, lang);
  }

  /** Translate and put it in place of the selection. */
  async function replaceNow(g) {
    try {
      const r = await run(g.text);
      if (!g.replace(r.text)) toast('The text changed, so it wasn’t replaced. Translate it again.', { type: 'warn' });
    } catch (e) { toast(e.message, { type: 'error' }); }
  }

  // ------------------------------------------------------------------ the popup
  let pop = null, openedAt = 0;
  function close() { pop?.remove(); pop = null; }
  function open(g, x, y) {
    close();
    let lang = to(), result = null, seq = 0;
    const out = h('div', { class: 'tr-out' }, 'Translating…');
    const from = h('span', { class: 'faint' });
    const sel = h('select', { class: 'tr-lang', title: 'Translate into' }, langs().map((c) => h('option', { value: c, selected: c === lang }, langName(c))));
    const replaceBtn = g.replace ? h('button', { class: 'btn sm primary', disabled: true, onclick: () => { if (!result) return; if (g.replace(result)) close(); else toast('The text changed, so it wasn’t replaced.', { type: 'warn' }); } }, 'Replace') : null;
    const copyBtn = h('button', { class: 'btn sm', disabled: true, onclick: async () => { try { await navigator.clipboard.writeText(result); toast('Copied.'); } catch { toast('Couldn’t copy.', { type: 'error' }); } } }, icon('copy', 'sm'), 'Copy');
    const go = async () => {
      const n = ++seq;
      result = null;
      out.textContent = 'Translating…';
      out.classList.remove('err');
      for (const b of [replaceBtn, copyBtn]) if (b) b.disabled = true;
      try {
        const r = await run(g.text, lang);
        if (n !== seq || !pop) return;
        result = r.text;
        out.textContent = r.text;
        from.textContent = r.from && r.from !== 'auto' ? `from ${langName(r.from)}` : '';
        for (const b of [replaceBtn, copyBtn]) if (b) b.disabled = false;
      } catch (e) { if (n === seq && pop) { out.textContent = e.message; out.classList.add('err'); } }
    };
    sel.addEventListener('change', () => { lang = sel.value; app.saveSettings({ translateTo: lang }); go(); });
    pop = h('div', { class: 'tr-pop', role: 'dialog' },
      h('div', { class: 'tr-head' }, icon('translate', 'sm'), h('b', {}, 'Translate'), from, h('div', { class: 'grow' }), sel,
        h('button', { class: 'icon-btn sm', title: 'Close (Esc)', onclick: close }, icon('x', 'sm'))),
      h('div', { class: 'tr-src faint' }, g.text),
      out,
      h('div', { class: 'tr-foot' }, h('span', { class: 'faint tr-credit' }, 'Google Translate'), h('div', { class: 'grow' }), copyBtn, replaceBtn,
        h('button', { class: 'btn sm', onclick: close }, 'Close')));
    document.body.append(pop);
    const w = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, x))}px`;
    pop.style.top = `${Math.max(8, Math.min(innerHeight - ph - 8, y + 8))}px`;
    openedAt = performance.now();
    go();
  }
  document.addEventListener('pointerdown', (e) => {
    if (!pop || performance.now() - openedAt < 200 || pop.contains(e.target) || e.target.closest?.('.menu, .toasts')) return;
    close();
  }, true);
  document.addEventListener('keydown', (e) => { if (pop && e.key === 'Escape') { e.stopPropagation(); close(); } }, true);

  // ------------------------------------------------------------------ the menu items
  /** The Translate items for a selection grabbed at (x, y). */
  function items(g, x, y) {
    if (!g) return [];
    return [
      { label: `Translate “${short(g.text)}” to ${langName(to())}`, icon: 'translate', action: () => open(g, x, y) },
      ...(g.replace ? [{ label: 'Translate and replace', icon: 'translate', action: () => replaceNow(g) }] : []),
    ];
  }
  // on top of every contextMenu() in the app
  setContextExtras((e) => items(grabSelection(e.target), e.clientX, e.clientY));
  // and where nothing has a menu of its own: these plus copy (cut and paste in fields)
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented || e.shiftKey) return;
    const g = grabSelection(e.target);
    const field = e.target.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]');
    const typeable = field && !field.readOnly && !field.disabled && (field.isContentEditable || field.tagName === 'TEXTAREA' || FIELD_TYPES.test(field.type || ''));
    if (!g && !typeable) return;
    e.preventDefault();
    const edit = typeable ? [
      { label: 'Cut', icon: 'cut', shortcut: 'Ctrl+X', disabled: !g, action: () => { g.restore(); document.execCommand('cut'); } },
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', disabled: !g, action: () => { g.restore(); document.execCommand('copy'); } },
      { label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', action: async () => { try { const t = await navigator.clipboard.readText(); field.focus(); document.execCommand('insertText', false, t); } catch { toast('Couldn’t paste: use Ctrl+V.', { type: 'warn' }); } } },
    ] : [{ label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', action: () => navigator.clipboard.writeText(g.text).catch(() => document.execCommand('copy')) }];
    const tr = items(g, e.clientX, e.clientY);
    showMenu([...tr, ...(tr.length ? [{ sep: true }] : []), ...edit], { x: e.clientX, y: e.clientY });
  });

  return { open, items, grab: grabSelection, replaceNow, get to() { return to(); } };
}
