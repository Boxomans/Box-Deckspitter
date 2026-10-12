// Browser: a web browser in a tab of its own (left sidebar → globe). Desktop app only: pages run in <webview>s on
// a session of their own (electron/browser.js), so sites never see the app, its bridge or its files.

import { BaseEditor } from './base.js';
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, showMenu, closeMenus, confirmDialog, modal } from '../core/ui.js';
import { BANDS, PRESETS, MIN_HZ, MAX_HZ, hzToPos, posToHz, hzLabel } from '../core/music.js';
import { api } from '../core/api.js';

const SEARCH = {
  google: { name: 'Google', q: 'https://www.google.com/search?q=', home: 'https://www.google.com/' },
  duckduckgo: { name: 'DuckDuckGo', q: 'https://duckduckgo.com/?q=', home: 'https://duckduckgo.com/' },
  bing: { name: 'Bing', q: 'https://www.bing.com/search?q=', home: 'https://www.bing.com/' },
};

const bridge = window.bdsShell;
let current = null; // the one open Browser editor; events from its pages are routed here
bridge?.onBrowser?.((ev) => current?.pageEvent(ev));

/** Typed text → a URL: a web address as is (https:// added), anything else is a search. */
function toUrl(text, engine) {
  const t = text.trim();
  if (!t) return null;
  if (/^(https?|chrome-extension):\/\//i.test(t) || t === 'about:blank') return t;
  if (!/\s/.test(t)) {
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(t)) return 'http://' + t;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(t) && /\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(t)) return 'https://' + t;
  }
  return (SEARCH[engine] || SEARCH.google).q + encodeURIComponent(t);
}

export class BrowserEditor extends BaseEditor {
  static mode = 'browser';

  async load() {
    current = this;
    this.pages = [];
    this.active = null;
    const st = await bridge?.browser?.({ op: 'status' }).catch(() => null);
    this.partition = st?.partition || 'bds-browser';
    this.persistent = !!st?.persistent;

    const btn = (name, title, fn) => { const b = h('button', { class: 'bw-btn', title }, icon(name, 'sm')); b.addEventListener('click', fn); return b; };
    this.strip = h('div', { class: 'bw-strip' });
    const plus = h('button', { class: 'bw-newtab', title: 'New tab (Ctrl+T)' }, icon('plus', 'sm'));
    plus.addEventListener('click', () => this.newPage());
    this.backBtn = btn('arrow-left', 'Back (Alt+←)', () => this.nav('back'));
    this.fwdBtn = btn('arrow-right', 'Forward (Alt+→)', () => this.nav('forward'));
    this.reloadBtn = btn('refresh', 'Reload (F5)', () => this.nav(this.active?.loading ? 'stop' : 'reload'));
    this.lock = h('span', { class: 'bw-lock' });
    this.addr = h('input', { class: 'bw-addr', spellcheck: 'false', autocomplete: 'off', placeholder: `Search ${SEARCH[this.engine()].name} or type an address` });
    this.addr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.go(this.addr.value); }
      else if (e.key === 'Escape') { this.typed = false; this.addr.value = this.active?.url || ''; this.active?.view.focus(); }
    });
    this.addr.addEventListener('focus', () => this.addr.select());
    this.addr.addEventListener('input', () => { this.typed = true; });
    const save = btn('file-pdf', 'Save page to doc dump (PDF)', () => this.savePage());
    const more = btn('more', 'Browser menu', (e) => showMenu(this.menuItems(), { anchor: e.currentTarget }));
    this.bar = h('div', { class: 'bw-bar' }, this.backBtn, this.fwdBtn, this.reloadBtn, h('div', { class: 'bw-addr-wrap' }, this.lock, this.addr), save, more);
    this.views = h('div', { class: 'bw-views' });
    this.note = this.persistent ? null : h('div', { class: 'bw-note' },
      icon('lock', 'sm'), 'Logins aren’t kept yet: Box-DocSpitter turns on encrypted storage for them the next time it closes. Until then nothing from the web is written to disk.');
    this.root = h('div', { class: 'bw-root' }, h('div', { class: 'bw-top' }, this.strip, plus), this.bar, this.note, this.views);
    this.pane.append(this.root);
    this.root.addEventListener('keydown', (e) => { if (this.key(e)) { e.preventDefault(); e.stopPropagation(); } });

    this.sendEq();
    // the tabs from last time (this PC only: they aren't part of setup exports)
    const saved = (this.app.settings.browserTabs || []).filter((u) => typeof u === 'string');
    if (saved.length) {
      saved.forEach((u) => this.newPage(u, { background: true }));
      this.activate(this.pages[Math.min(this.app.settings.browserActive || 0, this.pages.length - 1)]);
    } else this.newPage();
  }

  engine() { return SEARCH[this.app.settings.browserSearch] ? this.app.settings.browserSearch : 'google'; }

  // ---- pages

  newPage(url, { background = false } = {}) {
    const p = { url: url || SEARCH[this.engine()].home, title: 'New tab', favicon: null, loading: true };
    p.view = h('webview', { class: 'bw-view', partition: this.partition, allowpopups: '', src: p.url });
    p.fav = h('img', { class: 'bw-fav', alt: '' });
    p.label = h('span', { class: 'bw-title' }, p.title);
    const close = h('button', { class: 'bw-close', title: 'Close tab (Ctrl+W)' }, icon('x', 'sm'));
    close.addEventListener('click', (e) => { e.stopPropagation(); this.closePage(p); });
    p.tab = h('div', { class: 'bw-tab', title: p.url }, p.fav, p.label, close);
    p.tab.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); this.closePage(p); } });
    p.tab.addEventListener('click', () => this.activate(p));
    const v = p.view;
    const upd = () => { if (p === this.active) { this.syncBar(); this.refreshStatus(); } this.renderTab(p); };
    v.addEventListener('did-attach', () => { p.wcId = v.getWebContentsId(); });
    v.addEventListener('page-title-updated', (e) => { p.title = e.title; upd(); });
    v.addEventListener('page-favicon-updated', (e) => { p.favicon = e.favicons?.[0] || null; upd(); });
    v.addEventListener('did-start-loading', () => { p.loading = true; upd(); });
    v.addEventListener('did-stop-loading', () => { p.loading = false; upd(); this.saveTabs(); });
    v.addEventListener('did-navigate', (e) => { p.url = e.url; p.favicon = null; upd(); });
    v.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) { p.url = e.url; upd(); } });
    v.addEventListener('did-fail-load', (e) => {
      if (!e.isMainFrame || e.errorCode === -3) return; // -3: cancelled (a new navigation, a download)
      p.title = 'Couldn’t load'; upd();
      if (p === this.active) toast(`${e.errorDescription || 'Couldn’t load the page'} — ${e.validatedURL}`, { type: 'error', timeout: 5000 });
    });
    v.addEventListener('focus', () => closeMenus());
    this.pages.push(p);
    this.views.append(v);
    this.strip.append(p.tab);
    this.renderTab(p);
    if (!background || !this.active) this.activate(p);
    if (!url && !background) setTimeout(() => this.addr.focus(), 50);
    this.saveTabs();
    return p;
  }

  activate(p) {
    if (!p) return;
    this.active = p;
    this.typed = false;
    for (const x of this.pages) { x.view.classList.toggle('active', x === p); x.tab.classList.toggle('active', x === p); }
    p.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.syncBar();
    this.refreshStatus();
    this.saveTabs();
    setTimeout(() => { if (this.active === p && document.activeElement !== this.addr) p.view.focus(); }, 0);
  }

  closePage(p) {
    const i = this.pages.indexOf(p);
    if (i < 0) return;
    this.pages.splice(i, 1);
    this.closed = [...(this.closed || []).slice(-9), p.url];
    p.view.remove();
    p.tab.remove();
    if (!this.pages.length) this.newPage();
    else if (this.active === p) this.activate(this.pages[Math.min(i, this.pages.length - 1)]);
    this.saveTabs();
  }

  renderTab(p) {
    p.label.textContent = p.loading && p.title === 'New tab' ? 'Loading…' : p.title || p.url;
    p.tab.title = `${p.title}\n${p.url}`;
    p.tab.classList.toggle('loading', p.loading);
    if (p.favicon) { p.fav.src = p.favicon; p.fav.hidden = false; } else p.fav.hidden = true;
  }

  syncBar() {
    const p = this.active;
    if (!p) return;
    const v = p.view;
    const can = (f) => { try { return v[f](); } catch { return false; } };
    this.backBtn.disabled = !can('canGoBack');
    this.fwdBtn.disabled = !can('canGoForward');
    this.reloadBtn.replaceChildren(icon(p.loading ? 'x' : 'refresh', 'sm'));
    this.reloadBtn.title = p.loading ? 'Stop (Esc)' : 'Reload (F5)';
    // keep what you're typing; otherwise follow the page (even with the bar focused, like a fresh new tab)
    if (document.activeElement !== this.addr || !this.typed) this.addr.value = p.url === 'about:blank' ? '' : p.url;
    const secure = /^https:/i.test(p.url), plain = /^http:/i.test(p.url) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(p.url);
    this.lock.replaceChildren(secure ? icon('lock', 'sm') : plain ? h('span', {}, 'Not secure') : '');
    this.lock.className = `bw-lock${secure ? ' ok' : plain ? ' bad' : ''}`;
    this.lock.title = secure ? 'Encrypted connection (https)' : plain ? 'This page isn’t encrypted: don’t type passwords or card numbers here' : '';
  }

  go(text) {
    const url = toUrl(text, this.engine());
    if (!url || !this.active) return;
    this.active.url = url;
    this.typed = false;
    this.active.view.loadURL(url).catch(() => {});
    this.active.view.focus();
  }

  nav(what) {
    const v = this.active?.view;
    if (!v) return;
    try {
      if (what === 'back' && v.canGoBack()) v.goBack();
      else if (what === 'forward' && v.canGoForward()) v.goForward();
      else if (what === 'reload') v.reload();
      else if (what === 'stop') v.stop();
    } catch { /* not attached yet */ }
  }

  saveTabs() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => {
      const tabs = this.pages.map((p) => p.url).filter((u) => /^(https?|chrome-extension):/i.test(u));
      this.app.saveSettings({ browserTabs: tabs, browserActive: Math.max(0, this.pages.indexOf(this.active)) });
    }, 800);
  }

  // ---- keys (from the browser's own bar, or forwarded from a page by the main process)

  key(e) {
    const k = e.key.toLowerCase();
    const combo = (e.ctrlKey ? 'ctrl+' : '') + (e.shiftKey ? 'shift+' : '') + (e.altKey ? 'alt+' : '') + k;
    return this.combo(combo);
  }

  combo(c) {
    if (c === 'ctrl+t') this.newPage();
    else if (c === 'ctrl+w') this.closePage(this.active);
    else if (c === 'ctrl+l') { this.addr.focus(); this.addr.select(); }
    else if (c === 'ctrl+r' || c === 'f5') this.nav('reload');
    else if (c === 'escape') { if (this.active?.loading) this.nav('stop'); else return false; }
    else if (c === 'alt+arrowleft') this.nav('back');
    else if (c === 'alt+arrowright') this.nav('forward');
    else if (c === 'ctrl+shift+t') { const u = this.closed?.pop(); if (u) this.newPage(u); }
    else if (c === 'ctrl+tab' || c === 'ctrl+shift+tab') {
      const i = this.pages.indexOf(this.active), n = this.pages.length;
      this.activate(this.pages[(i + (c === 'ctrl+tab' ? 1 : -1) + n) % n]);
    } else if (c === 'ctrl+f') this.find();
    else return false;
    return true;
  }

  /** Find in page: a small box over the page. */
  find() {
    if (this.findBox) { this.findBox.querySelector('input').focus(); return; }
    const input = h('input', { class: 'bw-find-input', placeholder: 'Find in page', spellcheck: 'false' });
    const count = h('span', { class: 'bw-find-count' });
    const close = () => { try { this.active?.view.stopFindInPage('clearSelection'); } catch { /* gone */ } this.findBox?.remove(); this.findBox = null; this.active?.view.focus(); };
    const run = (forward = true, findNext = true) => { const t = input.value; if (!t) { close(); return; } try { this.active.view.findInPage(t, { forward, findNext }); } catch { /* not ready */ } };
    input.addEventListener('input', () => { if (input.value) { try { this.active.view.findInPage(input.value); } catch { /* not ready */ } } else count.textContent = ''; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(!e.shiftKey); } else if (e.key === 'Escape') { e.preventDefault(); close(); } });
    const onFound = (e) => { if (e.result.finalUpdate) count.textContent = e.result.matches ? `${e.result.activeMatchOrdinal}/${e.result.matches}` : 'none'; };
    this.active?.view.addEventListener('found-in-page', onFound);
    this.findBox = h('div', { class: 'bw-find' }, input, count);
    this.views.append(this.findBox);
    input.focus();
  }

  // ---- from the main process

  pageEvent(ev) {
    const p = this.pages.find((x) => x.wcId === ev.id);
    if (!p) return;
    if (ev.type === 'open') this.newPage(ev.url, { background: !!ev.background });
    else if (ev.type === 'search') this.newPage(toUrl(ev.text, this.engine()));
    else if (ev.type === 'key') this.combo(ev.combo);
    else if (ev.type === 'saved') this.saved(ev.where, ev.file);
    else if (ev.type === 'error') toast(ev.message, { type: 'error', timeout: 5000 });
  }

  saved(where, file) {
    const name = file.split(/[\\/]/).pop();
    toast(`Saved to ${where === 'doc' ? 'doc' : 'media'} dump: ${name}`, { type: 'ok', timeout: 5000, action: { label: 'Show', fn: () => api.reveal(file) } });
    const kind = where === 'doc' ? 'doc' : 'media';
    if (this.app.panel === `${kind}dump`) this.app.renderDumpPanel(kind);
  }

  async savePage() {
    if (this.active?.wcId == null) return;
    toast('Saving the page as a PDF…', { timeout: 2000 });
    const r = await bridge.browser({ op: 'savePage', id: this.active.wcId });
    if (r?.ok) this.saved('doc', r.file); else toast(r?.error || 'Couldn’t save the page', { type: 'error' });
  }

  // ---- the ⋮ menu

  menuItems() {
    const eng = this.engine();
    return [
      { label: 'New tab', shortcut: 'Ctrl+T', action: () => this.newPage() },
      { label: 'Find in page', shortcut: 'Ctrl+F', action: () => this.find() },
      { label: 'Save page to doc dump (PDF)', icon: 'file-pdf', action: () => this.savePage() },
      { sep: true },
      { label: 'Search with', submenu: Object.entries(SEARCH).map(([id, s]) => ({ label: s.name, checked: id === eng, action: () => { this.app.saveSettings({ browserSearch: id }); this.addr.placeholder = `Search ${s.name} or type an address`; } })) },
      { label: 'Extensions', submenu: () => this.extensionItems() },
      { label: this.eqOn() ? 'Equalizer (on)…' : 'Equalizer…', icon: 'sliders', action: () => this.showEq() },
      { sep: true },
      { label: 'Developer tools', shortcut: 'F12', action: () => { try { this.active.view.openDevTools(); } catch { /* not ready */ } } },
      { label: 'Clear browsing data…', icon: 'trash', action: () => this.clearData() },
    ];
  }

  async extensionItems() {
    const r = await bridge.browser({ op: 'extensions' });
    const list = r?.list || [];
    return [
      ...list.map((x) => ({ label: `${x.name} ${x.version}`, submenu: [{ label: 'Remove', action: async () => { await bridge.browser({ op: 'removeExtension', id: x.id }); toast(`Removed ${x.name}`, { type: 'ok' }); } }] })),
      ...(list.length ? [{ sep: true }] : [{ label: 'No extensions yet', disabled: true }, { sep: true }]),
      { label: 'Load unpacked extension…', action: () => this.addExtension() },
    ];
  }

  async addExtension() {
    const r = await bridge.browser({ op: 'addExtension' });
    if (r?.ok) toast(`Loaded ${r.ext.name}. Reload open pages to use it.`, { type: 'ok', timeout: 4500 });
    else if (!r?.cancelled) toast(r?.error || 'Couldn’t load that extension', { type: 'error', timeout: 6000 });
  }

  // ---- 10-band EQ for page audio (runs inside the pages: electron/browser.js)

  eqState() {
    const e = this.app.settings.browserEq;
    return e && Array.isArray(e.eq) && e.eq.length === BANDS.length ? { eq: [...e.eq], low: e.low ?? MIN_HZ, high: e.high ?? MAX_HZ } : { eq: BANDS.map(() => 0), low: MIN_HZ, high: MAX_HZ };
  }

  eqOn(e = this.eqState()) { return e.eq.some((v) => v) || e.low > MIN_HZ + 1 || e.high < MAX_HZ - 50; }

  sendEq(e = this.eqState()) { bridge?.browser({ op: 'eq', eq: e }); }

  showEq() {
    const st = this.eqState();
    let saveT = 0;
    const commit = (now) => {
      this.sendEq(st);
      clearTimeout(saveT);
      saveT = setTimeout(() => this.app.saveSettings({ browserEq: { eq: [...st.eq], low: st.low, high: st.high } }), now ? 0 : 300);
      markPreset();
    };
    const sliders = BANDS.map(([hz], i) => {
      const r = h('input', { type: 'range', class: 'music-eq-slider', min: '-18', max: '18', step: '0.5', value: String(st.eq[i]) });
      const val = h('span', { class: 'mono music-eq-val' });
      const show = () => { val.textContent = `${st.eq[i] > 0 ? '+' : ''}${st.eq[i]}`; r.value = String(st.eq[i]); };
      r.addEventListener('input', () => { st.eq[i] = Number(r.value); show(); commit(); });
      r.addEventListener('dblclick', () => { st.eq[i] = 0; show(); commit(); });
      show();
      return { show, el: h('div', { class: 'music-eq-band' }, val, h('div', { class: 'music-eq-track' }, r), h('span', { class: 'mono faint music-eq-hz' }, hzLabel(hz))) };
    });
    const cut = (key) => {
      const r = h('input', { type: 'range', min: '0', max: '1000', class: 'music-cut' });
      const v = h('span', { class: 'mono music-cut-val' });
      const show = () => {
        r.value = String(hzToPos(st[key]));
        v.textContent = (key === 'low' ? st.low <= MIN_HZ + 1 : st.high >= MAX_HZ - 50) ? 'off' : `${hzLabel(st[key])} Hz`;
      };
      r.addEventListener('input', () => { st[key] = posToHz(Number(r.value)); show(); commit(); });
      show();
      return { show, el: h('label', {}, h('span', {}, key === 'low' ? 'Low cut' : 'High cut'), r, v) };
    };
    const lowC = cut('low'), highC = cut('high');
    const presets = h('div', { class: 'music-presets' }, Object.keys(PRESETS).map((name) => h('button', {
      class: 'chip', dataset: { preset: name },
      onclick: () => { const p = PRESETS[name]; st.eq = [...p.eq]; st.low = p.low; st.high = p.high; sliders.forEach((x) => x.show()); lowC.show(); highC.show(); commit(true); },
    }, name)));
    function markPreset() {
      for (const b of presets.children) {
        const p = PRESETS[b.dataset.preset];
        b.classList.toggle('on', p.eq.every((v, i) => v === st.eq[i]) && Math.abs(p.low - st.low) < 2 && Math.abs(p.high - st.high) < 30);
      }
    }
    markPreset();
    modal({
      title: 'Browser equalizer',
      wide: true,
      body: h('div', { class: 'music-eq' },
        h('div', { class: 'music-cuts' }, lowC.el, highC.el),
        h('div', { class: 'music-eq-bands' }, sliders.map((x) => x.el)),
        presets,
        h('div', { class: 'faint', style: { fontSize: '10.5px' } },
          'Applies to sound from web pages (videos, music sites) in every tab, separate from the music player’s mixer. Double-click a band to zero it. Copy-protected streams (Netflix, Spotify…) can’t be equalised and play as normal.')),
    }).then(() => commit(true));
  }

  async clearData() {
    if (!(await confirmDialog('Clear browsing data?', 'Signs you out of every site and clears cookies, saved site data, the cache and the external app choices.', { danger: true, okLabel: 'Clear' }))) return;
    const r = await bridge.browser({ op: 'clearData' });
    if (r?.ok) { toast('Browsing data cleared', { type: 'ok' }); this.pages.forEach((p) => { try { p.view.reload(); } catch { /* not ready */ } }); }
    else toast(r?.error || 'Couldn’t clear it', { type: 'error' });
  }

  status() {
    const p = this.active;
    return { left: [{ text: p ? (p.loading ? 'Loading… ' : '') + p.url : '' }], right: [{ text: `${this.pages.length} tab${this.pages.length === 1 ? '' : 's'}` }] };
  }

  focus() { if (this.active) this.active.view.focus(); }
  onShow() { setTimeout(() => this.focus(), 30); }
  destroy() { clearTimeout(this.saveT); if (current === this) current = null; }
}
