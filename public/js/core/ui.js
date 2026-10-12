// UI primitives: menus, modals, toasts, popovers, tooltips, color picker, find bar.

import { h, clear, debounce } from './dom.js';
import { icon } from './icons.js';

const root = () => document.getElementById('overlay-root');

// ===================================================================== menus

let menuStack = [];
let menuCloseCb = null;
// press-drag-release: hold the mouse on a menu button, slide onto an item, let go to pick it
let mouseHeld = false;
let lastDown = { x: 0, y: 0 };
let dragPick = null; // { x, y, t } while a menu opened by a held press is waiting for the release
let swallowClickOn = null;

export function closeMenus() {
  for (const m of menuStack) m.el.remove();
  menuStack = [];
  const cb = menuCloseCb;
  menuCloseCb = null;
  if (cb) cb();
}

export function menusOpen() { return menuStack.length > 0; }

function resolveItems(items) {
  return (typeof items === 'function' ? items() : items || []).filter(Boolean).filter((it) => !it.hidden);
}

/**
 * Show a menu.
 * @param items  [{label, icon, shortcut, action, disabled, checked, submenu, sep, heading}]
 * @param pos    {x, y} or {anchor: Element, side: 'bottom'|'right'}
 */
export function showMenu(items, pos, opts = {}) {
  const raw = typeof items === 'function' ? items() : items;
  if (raw && typeof raw.then === 'function') {
    raw.then((r) => showMenu(r || [], pos, opts));
    return null;
  }
  items = raw;
  const level = opts.level || 0;
  if (level === 0) closeMenus();
  else { while (menuStack.length > level) menuStack.pop().el.remove(); }
  if (opts.onClose && level === 0) menuCloseCb = opts.onClose;

  const list = resolveItems(items);
  const el = h('div', { class: 'menu', role: 'menu' });
  const buttons = [];
  let subTimer = null;

  list.forEach((item) => {
    if (item.sep) { el.append(h('div', { class: 'menu-sep' })); return; }
    if (item.heading) { el.append(h('div', { class: 'menu-heading' }, item.heading)); return; }
    const btn = h('button', { class: 'menu-item', role: 'menuitem', disabled: !!item.disabled },
      h('span', { class: 'mi-icon' }, item.checked ? icon('check', 'sm') : item.icon ? icon(item.icon, 'sm') : null),
      h('span', { class: 'mi-label' }, item.label),
      item.shortcut ? h('span', { class: 'mi-key' }, item.shortcut) : null,
      item.submenu ? h('span', { class: 'mi-arrow' }, icon('chevron-right', 'sm')) : null,
    );
    if (item.labelStyle) btn.querySelector('.mi-label').setAttribute('style', item.labelStyle);
    btn._item = item;
    const openSub = () => {
      buttons.forEach((b) => b.classList.toggle('active', b === btn));
      showMenu(item.submenu, { anchor: btn, side: 'right' }, { level: level + 1 });
    };
    btn.addEventListener('mouseenter', () => {
      clearTimeout(subTimer);
      buttons.forEach((b) => b.classList.remove('active'));
      if (item.submenu && !item.disabled) subTimer = setTimeout(openSub, 120);
      else subTimer = setTimeout(() => { while (menuStack.length > level + 1) menuStack.pop().el.remove(); }, 150);
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (item.disabled) return;
      if (item.submenu) { clearTimeout(subTimer); openSub(); return; }
      closeMenus();
      if (item.action) setTimeout(() => item.action(), 0);
    });
    buttons.push(btn);
    el.append(btn);
  });
  if (!buttons.length && !list.length) el.append(h('div', { class: 'menu-heading' }, 'Nothing here'));

  root().append(el);
  // position
  const r = el.getBoundingClientRect();
  let x, y;
  if (pos.anchor) {
    const a = pos.anchor.getBoundingClientRect();
    if (pos.side === 'right') { x = a.right + 2; y = a.top - 5; if (x + r.width > innerWidth - 4) x = a.left - r.width - 2; }
    else { x = pos.align === 'right' ? a.right - r.width : a.left; y = a.bottom + 4; }
  } else { x = pos.x; y = pos.y; }
  x = Math.max(4, Math.min(x, innerWidth - r.width - 4));
  if (y + r.height > innerHeight - 4) y = Math.max(4, (pos.anchor && pos.side !== 'right' ? pos.anchor.getBoundingClientRect().top - r.height - 4 : innerHeight - r.height - 4));
  el.style.left = x + 'px';
  el.style.top = y + 'px';

  const entry = { el, buttons, level, anchor: level === 0 ? pos.anchor || null : null };
  menuStack.push(entry);
  if (level === 0) {
    dragPick = mouseHeld ? { x: lastDown.x, y: lastDown.y, t: performance.now() } : null;
    // remember buttons that open menus, so the next press on them opens it straight away (and can be dragged)
    if (pos.anchor && !pos.anchor.classList.contains('menubar-item')) pos.anchor.dataset.menuAnchor = '';
  }
  return entry;
}

function menuKey(e) {
  if (!menuStack.length) return false;
  const top = menuStack[menuStack.length - 1];
  const enabled = top.buttons.filter((b) => !b.disabled);
  const idx = enabled.findIndex((b) => b.classList.contains('active'));
  const setActive = (b) => { top.buttons.forEach((x) => x.classList.toggle('active', x === b)); b?.scrollIntoView({ block: 'nearest' }); };
  switch (e.key) {
    case 'Escape':
      if (menuStack.length > 1) menuStack.pop().el.remove(); else closeMenus();
      return true;
    case 'ArrowDown': setActive(enabled[(idx + 1) % enabled.length]); return true;
    case 'ArrowUp': setActive(enabled[(idx - 1 + enabled.length) % enabled.length]); return true;
    case 'ArrowRight': if (idx >= 0 && enabled[idx]._item.submenu) { enabled[idx].click(); const sub = menuStack[menuStack.length - 1]; const first = sub.buttons.find((b) => !b.disabled); first?.classList.add('active'); } return true;
    case 'ArrowLeft': if (menuStack.length > 1) menuStack.pop().el.remove(); return true;
    case 'Enter': case ' ': if (idx >= 0) enabled[idx].click(); return true;
    default: return false;
  }
}

document.addEventListener('mousedown', (e) => {
  if (e.button === 0) { mouseHeld = true; lastDown = { x: e.clientX, y: e.clientY }; }
  const anchor = e.button === 0 ? e.target.closest?.('[data-menu-anchor]') : null;
  if (anchor && !anchor.disabled && !menuStack.some((m) => m.el.contains(e.target))) {
    const wasOpen = menuStack[0]?.anchor === anchor;
    closeMenus();
    e.preventDefault();
    if (!wasOpen) anchor.click();
    swallowClickOn = anchor; // the click that follows this press shouldn't toggle it again
    return;
  }
  if (!menuStack.length) return;
  if (menuStack.some((m) => m.el.contains(e.target))) return;
  if (e.target.closest?.('.menubar-item')) return;
  closeMenus();
}, true);
document.addEventListener('keydown', (e) => {
  if (menuKey(e)) { e.preventDefault(); e.stopPropagation(); }
}, true);
document.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  mouseHeld = false;
  setTimeout(() => { swallowClickOn = null; }, 0);
  const pick = dragPick;
  dragPick = null;
  if (!pick || !menuStack.length) return;
  const btn = e.target.closest?.('.menu-item');
  if (!btn || !menuStack.some((m) => m.el.contains(btn))) return;
  // a quick click in place just opens the menu; a drag (or a long press) picks what's under the mouse
  if (Math.hypot(e.clientX - pick.x, e.clientY - pick.y) < 6 && performance.now() - pick.t < 300) return;
  e.preventDefault();
  e.stopPropagation();
  if (!btn.disabled) btn.click();
}, true);
document.addEventListener('click', (e) => {
  if (swallowClickOn && swallowClickOn.contains(e.target)) { e.preventDefault(); e.stopPropagation(); swallowClickOn = null; }
}, true);
window.addEventListener('blur', () => { mouseHeld = false; dragPick = null; closeMenus(); });
window.addEventListener('resize', () => closeMenus());

export function contextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  showMenu(items, { x: e.clientX, y: e.clientY });
}

// ===================================================================== modals

let modalDepth = 0;
export function modalOpen() { return modalDepth > 0; }

/**
 * Generic modal. Resolves with the value of the clicked button (or null when dismissed).
 * buttons: [{label, value, primary, danger, ghost, onClick(ctx) → false keeps it open}]
 */
export function modal({ title, body, buttons = [{ label: 'Close', value: null, primary: true }], wide, xwide, className = '', onOpen, dismissable = true, footLeft } = {}) {
  return new Promise((resolve) => {
    const backdrop = h('div', { class: 'modal-backdrop' });
    const box = h('div', { class: `modal ${wide ? 'wide' : ''} ${xwide ? 'xwide' : ''} ${className}`, role: 'dialog', 'aria-modal': 'true' });
    const prevFocus = document.activeElement;
    let done = false;
    const ctx = {
      box,
      close(value = null) {
        if (done) return;
        done = true;
        modalDepth--;
        backdrop.remove();
        document.removeEventListener('keydown', onKey, true);
        try { prevFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
        resolve(value);
      },
    };
    const head = h('div', { class: 'modal-head' },
      h('div', { class: 'modal-title' }, title || ''),
      dismissable ? h('button', { class: 'icon-btn', title: 'Close', onclick: () => ctx.close(null) }, icon('x')) : null);
    const bodyEl = h('div', { class: 'modal-body' });
    if (typeof body === 'string') bodyEl.append(h('p', {}, body));
    else if (body) bodyEl.append(body);
    const foot = h('div', { class: 'modal-foot' });
    if (footLeft) { foot.append(footLeft, h('div', { class: 'grow' })); }
    let primaryBtn = null;
    for (const b of buttons) {
      const btn = h('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''} ${b.ghost ? 'ghost' : ''}` }, b.label);
      btn.addEventListener('click', async () => {
        if (b.onClick) {
          const r = await b.onClick(ctx);
          if (r === false) return;
          if (r !== undefined && r !== true) return ctx.close(r);
        }
        ctx.close(b.value === undefined ? b.label : b.value);
      });
      if (b.primary) primaryBtn = btn;
      foot.append(btn);
    }
    box.append(head, bodyEl, buttons.length || footLeft ? foot : '');
    backdrop.append(box);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop && dismissable) ctx.close(null); });
    function onKey(e) {
      if (!box.isConnected) return;
      if (e.key === 'Escape' && dismissable) { e.preventDefault(); e.stopPropagation(); ctx.close(null); }
      else if (e.key === 'Enter' && primaryBtn && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON' && !e.target.isContentEditable) {
        e.preventDefault(); e.stopPropagation(); primaryBtn.click();
      }
    }
    document.addEventListener('keydown', onKey, true);
    modalDepth++;
    closeMenus();
    root().append(backdrop);
    const focusable = bodyEl.querySelector('input:not([type=hidden]), select, textarea, [autofocus]');
    setTimeout(() => (focusable || primaryBtn || box).focus?.(), 20);
    onOpen?.(ctx);
  });
}

export function alertDialog(title, message) {
  return modal({ title, body: message, buttons: [{ label: 'OK', primary: true, value: true }] });
}

export async function confirmDialog(title, message, { okLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  const v = await modal({
    title, body: message,
    buttons: [{ label: cancelLabel, value: false, ghost: true }, { label: okLabel, value: true, primary: !danger, danger }],
  });
  return v === true;
}

export async function promptDialog(title, label, value = '', { placeholder = '', selectBase = false, type = 'text' } = {}) {
  const input = h('input', { type, value, placeholder, style: { width: '100%' } });
  const body = h('div', { class: 'field' }, label ? h('span', {}, label) : null, input);
  const res = await modal({
    title, body,
    buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'OK', primary: true, onClick: () => input.value }],
    onOpen: () => setTimeout(() => {
      input.focus();
      if (selectBase && value.lastIndexOf('.') > 0) input.setSelectionRange(0, value.lastIndexOf('.'));
      else input.select();
    }, 30),
  });
  return res == null ? null : String(res);
}

/** choices: [{label, value, primary, danger}] */
export function choiceDialog(title, message, choices) {
  return modal({ title, body: message, buttons: choices.map((c) => ({ ...c, ghost: !c.primary && !c.danger })) });
}

// ===================================================================== toasts

let toastHost = null;
export function toast(message, { type = 'info', timeout = 3400, action } = {}) {
  if (!toastHost) { toastHost = h('div', { class: 'toasts' }); root().append(toastHost); }
  const ico = { error: 'alert', ok: 'check', warn: 'alert', info: 'info' }[type] || 'info';
  const el = h('div', { class: `toast ${type}` }, icon(ico, 'sm'), h('span', {}, message));
  if (action) {
    el.append(h('button', { class: 'btn sm toast-action', onclick: () => { action.fn(); el.remove(); } }, action.label));
  }
  toastHost.append(el);
  const kill = () => { el.style.transition = 'opacity .2s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 220); };
  if (timeout) setTimeout(kill, timeout);
  return kill;
}

export function errorToast(err, prefix = '') {
  console.error(err);
  return toast((prefix ? prefix + ': ' : '') + (err?.message || String(err)), { type: 'error', timeout: 6000 });
}

// ===================================================================== popovers

let activePopover = null;
export function closePopover() { if (activePopover) { const p = activePopover; activePopover = null; p.close(); } }

export function popover(anchor, content, { onClose, align = 'left', offset = 4 } = {}) {
  closePopover();
  const el = h('div', { class: 'popover' }, content);
  root().append(el);
  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  let x = align === 'right' ? a.right - r.width : a.left;
  let y = a.bottom + offset;
  x = Math.max(4, Math.min(x, innerWidth - r.width - 4));
  if (y + r.height > innerHeight - 4) y = Math.max(4, a.top - r.height - offset);
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  setTimeout(() => { document.addEventListener('mousedown', onDown, true); }, 0);
  document.addEventListener('keydown', onKey, true);
  const entry = {
    el,
    close() {
      el.remove();
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      if (activePopover === entry) activePopover = null;
      onClose?.();
    },
  };
  activePopover = entry;
  return entry;
}

export const DOC_COLORS = [
  ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff'],
  ['#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff'],
  ['#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc'],
  ['#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd'],
  ['#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'],
  ['#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79'],
  ['#85200c', '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#1155cc', '#0b5394', '#351c75', '#741b47'],
];

/** Color picker popover. onPick(hex | null) — null means "none / reset". */
export function colorPopover(anchor, { onPick, allowNone = true, noneLabel = 'None', current } = {}) {
  const grid = h('div', { class: 'swatches' });
  for (const row of DOC_COLORS) {
    for (const c of row) {
      grid.append(h('button', {
        class: 'swatch', title: c, style: { background: c },
        onmousedown: (e) => e.preventDefault(),
        onclick: () => { closePopover(); onPick(c); },
      }));
    }
  }
  const custom = h('input', { type: 'color', value: current || '#b48cff' });
  custom.addEventListener('change', () => { closePopover(); onPick(custom.value); });
  const row = h('div', { class: 'popover-row' },
    allowNone ? h('button', { class: 'btn sm', onmousedown: (e) => e.preventDefault(), onclick: () => { closePopover(); onPick(null); } }, h('span', { class: 'swatch none', style: { width: '14px', height: '14px', display: 'inline-block' } }), noneLabel) : null,
    h('div', { class: 'grow' }),
    h('span', {}, 'Custom'), custom);
  return popover(anchor, h('div', {}, grid, row));
}

// ===================================================================== tooltips

let tipEl = null;
let tipTimer = null;
function hideTip() { clearTimeout(tipTimer); if (tipEl) { tipEl.remove(); tipEl = null; } }
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    if (!t.isConnected || menusOpen()) return;
    hideTip();
    tipEl = h('div', { class: 'tooltip' }, t.dataset.tip, t.dataset.key ? h('kbd', {}, t.dataset.key) : null);
    root().append(tipEl);
    const a = t.getBoundingClientRect();
    const r = tipEl.getBoundingClientRect();
    let x = a.left + a.width / 2 - r.width / 2;
    let y = a.bottom + 6;
    if (y + r.height > innerHeight - 4) y = a.top - r.height - 6;
    tipEl.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    tipEl.style.top = y + 'px';
  }, 450);
});
document.addEventListener('mouseout', (e) => { if (e.target.closest?.('[data-tip]')) hideTip(); });
document.addEventListener('mousedown', hideTip, true);

// ===================================================================== toolbar helpers

export function tbButton(iconName, tip, onClick, { key, cls = '', text } = {}) {
  const b = h('button', { class: `icon-btn ${cls} ${text ? 'tb-btn-text' : ''}`, 'data-tip': tip, 'data-key': key || null },
    icon(iconName), text ? h('span', {}, text) : null);
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep editor selection
  b.addEventListener('click', onClick);
  return b;
}
export const tbSep = () => h('div', { class: 'tb-sep' });

export function tbSelect(options, onChange, { tip, width, value } = {}) {
  const s = h('select', { class: 'tb-select', 'data-tip': tip || null, style: width ? { width } : null });
  for (const o of options) {
    if (o.group) {
      const g = h('optgroup', { label: o.group });
      o.options.forEach((x) => g.append(h('option', { value: x.value ?? x.label }, x.label)));
      s.append(g);
    } else s.append(h('option', { value: o.value ?? o.label, style: o.style || null }, o.label));
  }
  if (value != null) s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

// ===================================================================== find bar

/**
 * provider: {
 *   find(query, opts) → {count, index}
 *   next() / prev() → {count, index}
 *   replace(text) → {count, index}
 *   replaceAll(text) → number
 *   clear()
 *   canReplace: boolean
 * }
 */
export class FindBar {
  constructor(host, provider) {
    this.host = host;
    this.provider = provider;
    this.opts = { caseSensitive: false, wholeWord: false, regex: false };
    this.el = null;
  }

  get isOpen() { return !!this.el; }

  open(replace = false, query) {
    if (!this.el) this.build();
    this.replaceRow.hidden = !(replace && this.provider.canReplace !== false);
    if (query) this.input.value = query;
    this.input.focus();
    this.input.select();
    if (this.input.value) this.run();
  }

  close() {
    if (!this.el) return;
    this.provider.clear?.();
    this.el.remove();
    this.el = null;
    this.provider.onClose?.();
  }

  build() {
    this.input = h('input', { type: 'search', placeholder: 'Find', spellcheck: 'false' });
    this.replaceInput = h('input', { type: 'text', placeholder: 'Replace with', spellcheck: 'false' });
    this.count = h('span', { class: 'fb-count' }, '');
    const toggle = (key, label, tip) => {
      const b = h('button', { class: 'icon-btn toggle', 'data-tip': tip }, label);
      b.addEventListener('click', () => { this.opts[key] = !this.opts[key]; b.classList.toggle('active', this.opts[key]); this.run(); this.input.focus(); });
      return b;
    };
    const ib = (name, tip, fn) => { const b = h('button', { class: 'icon-btn', 'data-tip': tip }, icon(name, 'sm')); b.addEventListener('click', fn); return b; };
    this.replaceRow = h('div', { class: 'fb-row' },
      this.replaceInput,
      h('button', { class: 'btn sm', onclick: () => this.update(this.provider.replace(this.replaceInput.value)) }, 'Replace'),
      h('button', { class: 'btn sm', onclick: () => { const n = this.provider.replaceAll(this.replaceInput.value); toast(`Replaced ${n} occurrence${n === 1 ? '' : 's'}`, { type: 'ok' }); this.run(); } }, 'All'));
    this.el = h('div', { class: 'findbar' },
      h('div', { class: 'fb-row' },
        this.input, this.count,
        ib('chevron-up', 'Previous (Shift+Enter)', () => this.update(this.provider.prev())),
        ib('chevron-down', 'Next (Enter)', () => this.update(this.provider.next())),
        toggle('caseSensitive', 'Aa', 'Match case'),
        toggle('wholeWord', 'ab', 'Whole word'),
        toggle('regex', '.*', 'Regular expression'),
        this.provider.canReplace !== false ? ib('replace', 'Toggle replace', () => { this.replaceRow.hidden = !this.replaceRow.hidden; if (!this.replaceRow.hidden) this.replaceInput.focus(); }) : null,
        ib('x', 'Close (Esc)', () => this.close())),
      this.replaceRow);
    const run = debounce(() => this.run(), 140);
    this.input.addEventListener('input', run);
    const keys = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
      else if (e.key === 'Enter' && e.target === this.input) { e.preventDefault(); run.cancel(); if (this.dirty) this.run(); else this.update(e.shiftKey ? this.provider.prev() : this.provider.next()); }
      else if (e.key === 'Enter' && e.target === this.replaceInput) { e.preventDefault(); this.update(this.provider.replace(this.replaceInput.value)); }
    };
    this.input.addEventListener('keydown', keys);
    this.replaceInput.addEventListener('keydown', keys);
    this.input.addEventListener('input', () => { this.dirty = true; });
    this.host.append(this.el);
  }

  run() {
    this.dirty = false;
    const q = this.input.value;
    if (!q) { this.provider.clear?.(); this.count.textContent = ''; return; }
    try { this.update(this.provider.find(q, { ...this.opts })); }
    catch (e) { this.count.textContent = 'bad regex'; }
  }

  update(res) {
    if (!res || !this.el) return;
    Promise.resolve(res).then((r) => {
      if (!this.el || !r) return;
      this.count.textContent = r.count ? `${r.index + 1} of ${r.count}` : 'No results';
    });
  }
}

/** Build a RegExp from find options. */
export function buildRegex(query, { caseSensitive, wholeWord, regex } = {}) {
  let src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) src = `\\b${src}\\b`;
  return new RegExp(src, caseSensitive ? 'gu' : 'giu');
}

export { clear };

// ===================================================================== hover keys
// Hover a name and press F2 to rename it in place, or Delete to remove it (dump items, layers, songs, files…).

const hoverTargets = new WeakMap();
const pointer = { x: -1, y: -1 };
let inlineEditing = false;

/** el: the hover area. o.nameEl + o.value() + o.commit(newName) enable F2; o.remove() enables Delete. */
export function hoverKeys(el, o) {
  hoverTargets.set(el, o);
  return el;
}

/** Start the F2 rename for a registered element (also used by "Rename…" menu items). */
export function renameInline(el) {
  const o = hoverTargets.get(el);
  if (!o?.nameEl || inlineEditing) return false;
  const value = o.value();
  editInline(o.nameEl, value, { selectBase: o.selectBase }).then(async (v) => {
    if (v != null && v !== value) { try { await o.commit(v); } catch (e) { errorToast(e, 'Rename failed'); } }
  });
  return true;
}

/** Floating text box over nameEl; resolves to the new text, or null when cancelled. */
export function editInline(nameEl, value, { selectBase = false } = {}) {
  return new Promise((resolve) => {
    const r = nameEl.getBoundingClientRect();
    const input = h('input', { class: 'inline-rename', value, spellcheck: 'false' });
    Object.assign(input.style, { left: r.left - 3 + 'px', top: r.top + r.height / 2 + 'px', width: Math.max(r.width + 6, 140) + 'px' });
    document.body.append(input);
    inlineEditing = true;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      inlineEditing = false;
      input.remove();
      window.removeEventListener('resize', cancel);
      resolve(v == null ? null : v.trim() || null);
    };
    const cancel = () => finish(null);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value); } else if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    });
    input.addEventListener('blur', () => finish(input.value));
    window.addEventListener('resize', cancel);
    input.focus();
    const dot = value.lastIndexOf('.');
    if (selectBase && dot > 0) input.setSelectionRange(0, dot); else input.select();
  });
}

document.addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { capture: true, passive: true });
document.documentElement.addEventListener('mouseleave', () => { pointer.x = -1; pointer.y = -1; });
document.addEventListener('keydown', (e) => {
  if ((e.key !== 'F2' && e.key !== 'Delete') || e.repeat || inlineEditing || e.ctrlKey || e.altKey || e.metaKey || pointer.x < 0) return;
  if (menusOpen() || document.querySelector('.modal-backdrop')) return;
  let el = document.elementFromPoint(pointer.x, pointer.y);
  while (el && !hoverTargets.has(el)) el = el.parentElement;
  if (!el) return;
  const o = hoverTargets.get(el);
  if (e.key === 'F2') {
    if (!o.nameEl) return;
    e.preventDefault(); e.stopPropagation();
    renameInline(el);
  } else {
    // don't let Delete meant for a text box remove whatever the mouse happens to rest on
    const t = document.activeElement;
    if (!o.remove || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest?.('.cm-editor')))) return;
    e.preventDefault(); e.stopPropagation();
    o.remove();
  }
}, true);
