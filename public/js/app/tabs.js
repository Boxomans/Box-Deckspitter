// Box-Deckspitter app shell, tabs: the strip, dragging and tearing off, pinning, the title and status bar.
// Methods of App (app.js mixes this class into it).

import { $, $$, h, clear, uid, dirname } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { showMenu, contextMenu, choiceDialog, toast, errorToast } from '../core/ui.js';
import { MODE_ICON, MODE_LABEL, iconForName } from '../core/filetypes.js';
import { TOOL_MODES, TOOL_KINDS, TOOL_OF_MODE } from '../core/tools.js';

// top-bar buttons that can move to the right sidebar (in their top-bar order)
// the new-document kind for an untitled tab of each mode
const NEW_KIND = { doc: 'doc', text: 'text', code: 'code', sheet: 'sheet', pdf: 'pdf', cut: 'cut', paint: 'paint' };

export class TabsPart {
  createTab({ title, path = null, ext = '', mode = null, lang = null }) {
    const tab = { id: uid('t'), title, path, ext, mode, lang, dirty: false, mtime: null, editor: null, toolbarEl: null };
    tab.pane = h('div', { class: 'pane', hidden: true });
    this.workspace.append(tab.pane);
    this.tabs.push(tab);
    this.renderTabs();
    return tab;
  }

  renderTabs() {
    const host = clear($('#tabs'));
    if (!host._wheel) {
      // the strip has no scrollbar: the mouse wheel (or a trackpad's sideways swipe) scrolls it when tabs overflow
      host._wheel = true;
      host.addEventListener('wheel', (e) => {
        if (e.ctrlKey) return;
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (!d) return;
        // Shift+wheel over a cut-off tab name scrolls the name itself (back to the start when the mouse leaves)
        const title = e.shiftKey && e.target.closest?.('.tab-title');
        if (title && title.scrollWidth > title.clientWidth) {
          e.preventDefault();
          title.scrollLeft += e.deltaMode === 1 ? d * 20 : d / 2;
          title.classList.toggle('scrolled', title.scrollLeft > 0);
          if (!title._reset) {
            title._reset = true;
            title.closest('.tab').addEventListener('pointerleave', () => { title._reset = false; title.scrollLeft = 0; title.classList.remove('scrolled'); }, { once: true });
          }
          return;
        }
        if (host.scrollWidth <= host.clientWidth) return;
        e.preventDefault();
        host.scrollLeft += e.deltaMode === 1 ? d * 40 : d;
      }, { passive: false });
    }
    for (const t of this.tabs) {
      const el = h('div', {
        class: `tab ${t === this.active ? 'active' : ''} ${t.dirty ? 'dirty' : ''} ${t.pinned ? 'pinned' : ''}`,
        role: 'tab', title: `${t.pinned ? '📌 ' : ''}${t.path || t.title}`,
      },
      h('span', { class: 'tab-icon' }, icon(t.mode ? (t.mode === 'code' ? iconForName(t.title) : MODE_ICON[t.mode]) : 'file', 'sm')),
      h('span', { class: 'tab-title' }, t.title),
      h('button', { class: 'tab-close', title: 'Close (Alt+W)', onclick: (e) => { e.stopPropagation(); this.closeTab(t); } }, icon('x', 'sm')));
      el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); this.closeTab(t); } });
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('.tab-close')) return;
        this.activate(t);
        this.dragTab(e, t, el);
      });
      el.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: t.pinned ? 'Unpin' : 'Pin', icon: 'pin', action: () => this.pinTab(t, !t.pinned) },
        { sep: true },
        { label: 'Close', action: () => this.closeTab(t) },
        { label: 'Close others', action: () => this.closeAll(t, { keepPinned: true }) },
        { label: 'Close all', action: () => this.closeAll(null, { keepPinned: true }) },
        { sep: true },
        { label: 'Copy path', disabled: !t.path, action: () => navigator.clipboard.writeText(t.path) },
        { label: 'Show in folder', disabled: !t.path, action: () => api.reveal(t.path) },
      ]));
      el._tab = t;
      host.append(el);
      if (t === this.active) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    }
    $('#btn-home').classList.toggle('active', !this.active);
  }

  // ---- dragging a tab: along the bar to reorder; up, down or out of the window to give it a window of its own
  //      (shell.js opens it under the pointer). That works for the last tab too: this window is left on its home page.

  dragTab(e, t, el) {
    const shellWin = !!window.bdsShell?.tearOff;
    const sx = e.screenX, sy = e.screenY;
    let mode = null, target = null, ghost = null, out = false, lastX = e.clientX, lastY = e.clientY;
    // renderTabs (activate) rebuilt the bar: follow the pointer on the tab's new element
    el = [...$$('#tabs .tab')].find((x) => x._tab === t) || el;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const clearMarks = () => { for (const x of $$('#tabs .tab')) x.classList.remove('drag-over', 'drag-over-end'); };
    const move = (ev) => {
      lastX = ev.clientX; lastY = ev.clientY;
      const dx = ev.screenX - sx, dy = ev.screenY - sy;
      if (!mode) {
        if (Math.hypot(dx, dy) < 6) return;
        mode = 'tab';
        el.classList.add('tab-dragging');
        document.body.classList.add('tab-drag');
      }
      const b = $('#tabbar').getBoundingClientRect();
      out = shellWin && (ev.clientY < b.top - 28 || ev.clientY > b.bottom + 44 || ev.clientX < 0 || ev.clientX > innerWidth);
      clearMarks();
      target = null;
      if (out) {
        if (!ghost) {
          ghost = h('div', { class: 'tab-ghost' }, el.querySelector('.tab-icon')?.cloneNode(true) || '', h('span', {}, t.title), h('span', { class: 'tab-ghost-hint' }, 'new window'));
          document.body.append(ghost);
        }
        ghost.hidden = false;
        ghost.style.left = `${Math.round(ev.clientX + 12)}px`;
        ghost.style.top = `${Math.round(ev.clientY + 10)}px`;
        return;
      }
      if (ghost) ghost.hidden = true;
      // the tab the pointer is over: the dragged one goes before it (or after the last one)
      const tabs = $$('#tabs .tab');
      const over = tabs.find((x) => { const r = x.getBoundingClientRect(); return ev.clientX < r.left + r.width / 2; });
      target = over ? over._tab : null;
      if (over && over !== el) over.classList.add('drag-over');
      else if (!over && tabs.at(-1) !== el) tabs.at(-1)?.classList.add('drag-over-end');
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('tab-dragging');
      document.body.classList.remove('tab-drag');
      clearMarks();
      ghost?.remove();
      if (mode !== 'tab') return;
      if (out) return this.tearOff(t, lastX, lastY);
      const from = this.tabs.indexOf(t);
      if (from < 0) return;
      this.tabs.splice(from, 1);
      let to = target ? this.tabs.indexOf(target) : this.tabs.length;
      if (to < 0) to = from;
      const pins = this.tabs.filter((x) => x.pinned).length;
      to = t.pinned ? Math.min(to, pins) : Math.max(to, pins);
      this.tabs.splice(to, 0, t);
      this.renderTabs();
      if (t.pinned) this.savePinned();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** What a tab needs to open again in another window, or why it can't (said to the user). */
  tabHandoff(t) {
    if (t.mode === 'tomcat') return { why: 'That one stays in the main window.' };
    if (t.mode === 'music') return { why: 'The music player stays in its window.' };
    const item = { title: t.title, path: t.path || null, ext: t.ext, mode: t.mode, lang: t.lang, untitled: !!t.untitled, dirty: !!t.dirty };
    if (TOOL_KINDS.has(t.mode)) return { item };
    if (t.dirty || (t.untitled && !NEW_KIND[t.mode])) {
      let content = null;
      try { content = t.editor?.getDraft?.(); } catch { /* none */ }
      if (content == null) return { why: t.dirty ? 'Save it first: this kind of tab can’t move to another window with unsaved changes.' : 'This tab can’t move to another window.' };
      item.content = content;
    }
    return { item };
  }

  /** (cx, cy): where it was let go, in this page's coordinates (outside the window is fine). */
  async tearOff(t, cx, cy) {
    const { item, why } = this.tabHandoff(t);
    if (!item) return toast(why, { type: 'warn' });
    const el = [...$$('#tabs .tab')].find((x) => x._tab === t);
    el?.classList.add('tab-leaving');
    const ok = await window.bdsShell.tearOff({ tabs: [item], cx, cy }).catch(() => false);
    el?.classList.remove('tab-leaving');
    if (!ok) return toast('The new window didn’t open.', { type: 'error' });
    // it's open over there now: close it here without asking (its unsaved changes went with it)
    this.draftHashes.delete(t.id);
    await this.closeTab(t, { force: true });
  }

  /** In a window just opened for tabs dragged out of another one: open them here. */
  async adoptTabs(token) {
    const items = await window.bdsShell?.adopt?.(token).catch(() => null);
    for (const it of items || []) {
      try {
        if (it.content != null) {
          const tab = this.createTab({ title: it.title, path: it.path, ext: it.ext });
          tab.mode = it.mode;
          tab.lang = it.lang;
          tab.untitled = it.untitled;
          this.activate(tab);
          await this.mountEditor(tab, null, { lang: it.lang, isNew: true, draft: it.content });
          tab.editor.restoreDraft(it.content);
          if (it.path) { const st = await api.stat(it.path).catch(() => ({})); tab.mtime = st.mtime || null; }
          this.setDirty(tab, !!it.dirty);
        } else if (TOOL_KINDS.has(it.mode)) await this.newDocument(it.mode, { another: true });
        else if (it.path) await this.openPath(it.path);
        else if (NEW_KIND[it.mode]) await this.newDocument(NEW_KIND[it.mode], { lang: it.lang });
      } catch (e) { errorToast(e, `Could not open ${it.title}`); }
    }
  }

  activate(tab) {
    const th = this.tabHist;
    if (th && !th.moving && th.list[th.pos] !== tab) { th.list = th.list.slice(0, th.pos + 1); th.list.push(tab); if (th.list.length > 100) th.list.shift(); th.pos = th.list.length - 1; }
    if (this.active && this.active !== tab) this.active.editor?.onHide?.();
    this.active = tab;
    this.homeEl.hidden = !!tab;
    for (const t of this.tabs) t.pane.hidden = t !== tab;
    clear(this.toolbarHost);
    if (tab?.toolbarEl) this.toolbarHost.append(tab.toolbarEl);
    this.renderTabs();
    this.renderMenubar();
    this.updateTitle();
    this.updateStatus(tab);
    this.presence?.update();
    if (tab?.editor) {
      tab.editor.onShow?.();
      setTimeout(() => tab.editor?.focus?.(), 0);
    }
    if (!tab) this.refreshHome();
    // blue hour's rays follow the home page's sun: move them now, not on their next timer tick (they lingered and flickered)
    this._rays?.place?.();
    requestAnimationFrame(() => this._rays?.place?.());
  }

  async closeTab(tab, { force = false } = {}) {
    if (!tab) return false;
    if (tab.dirty && !force) {
      this.activate(tab);
      const choice = await choiceDialog('Unsaved changes', `Save changes to "${tab.title}" before closing?`, [
        { label: 'Cancel', value: 'cancel' },
        { label: "Don't save", value: 'discard', danger: true },
        { label: 'Save', value: 'save', primary: true },
      ]);
      if (choice === 'cancel' || choice == null) return false;
      if (choice === 'save' && !(await this.save(tab))) return false;
    }
    // a tool that's busy (a recording) gets a say first
    if (!force && tab.editor?.beforeClose && !(await tab.editor.beforeClose())) return false;
    const idx = this.tabs.indexOf(tab);
    if (tab.pinned && !this.quitting) { tab.pinned = false; this.savePinned(); }
    try { tab.editor?.destroy?.(); } catch (e) { console.warn(e); }
    tab.pane.remove();
    this.tabs.splice(idx, 1);
    this.sounds?.play('close');
    api.deleteDraft(tab.id).catch(() => {});
    if (this.active === tab) {
      this.active = null;
      this.activate(this.tabs[Math.min(idx, this.tabs.length - 1)] || null);
    } else this.renderTabs();
    return true;
  }

  async closeAll(except, { keepPinned = false } = {}) {
    for (const t of [...this.tabs]) {
      if (t === except || (keepPinned && t.pinned)) continue;
      if (!(await this.closeTab(t))) return false;
    }
    return true;
  }

  // ---- pinned tabs: small (icon only), always at the front, and opened again when the app starts

  pinTab(t, on) {
    if (!t || !!t.pinned === on) return;
    t.pinned = on;
    const i = this.tabs.indexOf(t);
    this.tabs.splice(i, 1);
    const pins = this.tabs.filter((x) => x.pinned).length;
    this.tabs.splice(pins, 0, t); // pinning: last of the pinned · unpinning: first after them
    this.renderTabs();
    this.savePinned();
    if (on && !t.path && !TOOL_KINDS.has(t.mode) && !['tomcat', 'music'].includes(t.mode)) toast('Pinned for now — save it to a file and it comes back when the app starts.', { timeout: 3200 });
  }

  savePinned() {
    if (!this.mainWindow) return;
    const list = this.tabs.filter((t) => t.pinned).map((t) => (t.path ? { path: t.path, mode: t.mode } : TOOL_KINDS.has(t.mode) || ['tomcat', 'music'].includes(t.mode) ? { tool: t.mode } : null)).filter(Boolean);
    this.saveSettings({ pinnedTabs: list });
  }

  async restorePinned() {
    const list = Array.isArray(this.settings.pinnedTabs) ? this.settings.pinnedTabs : [];
    for (const p of list) {
      try {
        let t = null;
        if (p.tool) t = await this.newDocument(p.tool);
        else if (p.path && (await api.stat(p.path)).exists) t = await this.openPath(p.path, { mode: p.mode });
        if (t && this.tabs.includes(t)) { t.pinned = true; const i = this.tabs.indexOf(t); this.tabs.splice(i, 1); this.tabs.splice(this.tabs.filter((x) => x.pinned).length, 0, t); }
      } catch (e) { console.warn('pinned tab', p, e); }
    }
    if (list.length) { this.renderTabs(); this.activate(null); }
  }

  setDirty(tab, dirty) {
    if (!tab || tab.dirty === dirty) return;
    tab.dirty = dirty;
    this.renderTabs();
    this.updateTitle();
    this.updateStatus(tab);
  }

  setTabMeta(tab, { path, title, ext }) {
    if (path !== undefined) tab.path = path;
    if (title !== undefined) tab.title = title;
    if (ext !== undefined) tab.ext = ext;
    this.renderTabs();
    this.updateTitle();
    this.updateStatus(tab);
    this.presence?.update();
  }

  updateTitle() {
    const t = this.active;
    document.title = t ? `${t.dirty ? '● ' : ''}${t.title} — Box-Deckspitter` : 'Box-Deckspitter';
    const el = clear($('#doc-title'));
    const tool = TOOL_MODES.includes(t?.mode) && !t.path;
    if (t) el.append(...[h('b', {}, t.title), t.path ? h('span', {}, '  ·  ' + dirname(t.path)) : tool ? null : h('span', {}, '  ·  not saved yet')].filter(Boolean));
  }

  updateStatus(tab = this.active) {
    if (tab && tab !== this.active) return;
    const L = clear(this.statusLeft);
    const R = clear(this.statusRight);
    if (!tab) {
      L.append(h('span', { class: 'sb-item mode' }, 'home'), h('span', { class: 'sb-item' }, `${this.tabs.length} open`));
      const root = this.info?.root || '';
      // the last two folders are enough to tell copies apart ("Desktop\\Box-Deckspitter", "E:\\Box-Deckspitter")
      const short = root.split(/[\\/]/).filter(Boolean).slice(-2).join('\\');
      R.append(h('span', { class: 'sb-item' }, h('span', { class: 'sb-dot' }), 'local · 127.0.0.1'),
        root ? h('button', { class: 'sb-item sb-root', title: `Running from ${root}\nClick to open the folder`, onclick: () => api.reveal(root) }, icon('folder', 'sm'), short) : null,
        h('span', { class: 'sb-item' }, 'v' + (window.BDS?.version || '')));
      return;
    }
    const modeBtn = h('button', { class: 'sb-item mode', title: 'Reopen in a different editor' }, (TOOL_OF_MODE[tab.mode] ? this.toolName(TOOL_OF_MODE[tab.mode]) : MODE_LABEL[tab.mode] || 'Loading').toLowerCase());
    modeBtn.addEventListener('click', () => tab.path && showMenu(this.reopenAsItems(tab), { anchor: modeBtn }));
    // tools (the game, the browser, BoxMail…) have no file: no saved/new dot, and the tab already shows the name
    const tool = TOOL_MODES.includes(tab.mode) && !tab.path;
    L.append(modeBtn, ...(tool ? [] : [
      h('span', { class: 'sb-item', title: tab.dirty ? 'Unsaved changes' : 'Saved' }, h('span', { class: `sb-dot ${tab.dirty ? 'dirty' : ''}` }), tab.dirty ? 'modified' : tab.path ? 'saved' : 'new'),
      h('span', { class: 'sb-item sb-path', title: tab.path || '' }, tab.path || tab.title)]));
    const st = tab.editor?.status?.() || {};
    const render = (it) => {
      const el = it.action ? h('button', { class: `sb-item ${it.cls || ''}`, title: it.title || '' }) : h('span', { class: `sb-item ${it.cls || ''}`, title: it.title || '' });
      if (it.icon) el.append(icon(it.icon, 'sm'));
      el.append(it.text);
      if (it.action) el.addEventListener('click', (e) => it.action(e, el));
      return el;
    };
    // a tool naming itself again next to the mode chip says nothing new
    const said = modeBtn.textContent.trim().toLowerCase();
    (st.left || []).filter((it) => String(it.text ?? '').trim().toLowerCase() !== said).forEach((it) => L.append(render(it)));
    (st.right || []).forEach((it) => R.append(render(it)));
  }

  // ======================================================================= open / new
}
