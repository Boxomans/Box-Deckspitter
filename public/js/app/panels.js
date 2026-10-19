// Box-Deckspitter app shell, the left side panel: switching it, the Toolbox and Recent.
// Methods of App (app.js mixes this class into it).

import { $, $$, h, clear, timeAgo } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { contextMenu, rubberSelect } from '../core/ui.js';
import { iconForName } from '../core/filetypes.js';
import { TOOLS, offered } from '../core/tools.js';

export class PanelsPart {
  togglePanel(name) {
    if (this.panel === name) this.hidePanel();
    else this.showPanel(name);
  }

  hidePanel() {
    this.panel = null;
    this.sidepanel.hidden = true;
    $$('.rail-btn').forEach((b) => b.classList.remove('active'));
    this.saveSettings({ sidebar: null });
    this.active?.editor?.onShow?.();
  }

  showPanel(name) {
    this.panel = name;
    this.sidepanel.hidden = false;
    $$('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
    if (name !== 'settings') this.saveSettings({ sidebar: name });
    if (name === 'explorer') this.renderExplorer();
    else if (name === 'recent') this.renderRecentPanel();
    else if (name === 'mediadump') this.renderDumpPanel('media');
    else if (name === 'docdump') this.renderDumpPanel('doc');
    else if (name === 'tools') this.renderToolsPanel();
    else if (name === 'settings') this.renderSettings();
    else if (name === 'calendar') this.calendar.render(this.sidepanel);
    else if (name === 'alerts') this.mailAlerts.render(this.sidepanel);
    else if (name === 'spaces') this.ensureSpaces().then((s) => s.render(this.sidepanel));
    this.active?.editor?.onShow?.();
  }

  /** The Toolbox at the foot of the left rail: every tool in one list. */
  renderToolsPanel() {
    const p = clear(this.sidepanel);
    const row = ([ic, key, sub, open, cls = ''], movable = false) => {
      const b = h('button', { class: `file-row tools-row ${cls}`, title: movable ? `${sub} · drag to reorder` : sub, dataset: movable ? { key } : {} }, h('span', { class: 'fr-icon' }, icon(ic, 'sm')),
        h('span', { class: 'tools-text' }, h('span', { class: 'fr-name' }, this.toolName(key)), h('span', { class: 'tools-sub' }, sub)));
      b.addEventListener('click', open);
      b._find = `${this.toolName(key)} ${key} ${sub}`.toLowerCase();
      return b;
    };
    // Every tool in one list with its own order, dragged into place here and kept apart from the home page's. Until you move
    // one it starts out like the home page (its tools in your order there, then the Toolbox-only ones); new tools go last.
    const all = [...this.ordered('tools', this.homeTools(), (c) => c[1]),
      ...TOOLS.filter((t) => t.toolbox && offered(t)).map((t) => [t.icon, t.name, t.toolbox, () => this.newDocument(t.mode)])];
    const mine = !!(this.settings.cardOrder || {}).toolbox;
    const groups = [
      ['Tools', this.ordered('toolbox', all, (c) => c[1])],
      ['Games', [
        ['f14', 'F-14F Super Tomcat', this.splashLine(), () => this.openGame('tomcat'), 'tools-tomcat'],
        ['reticle', 'Deep Strike', 'find the defences · plan the package · fly it', () => this.openGame('strike')],
      ]],
      ['More', [
        ['play', 'Video player', 'just watch something', () => this.openVideoPlayer()],
        ['scissors', 'Quick trim', 'cut a video down, fast', () => this.openVideoTrimmer()],
        ['music', 'Music player', 'the small pop-out player · click again to close', () => this.music.toggleOpen(), 'music-opener'],
        ...(this.weather ? [['cloud-sun', 'Weather widget', 'a small floating forecast · click again to close', () => this.weather.toggleMini()]] : []),
      ]],
    ];
    const list = h('div', { class: 'file-list tools-list' });
    for (const [title, items] of groups) list.append(h('div', { class: 'tools-group' }, title), ...items.map((it) => row(it, title === 'Tools')));
    this.sortableTools(list);
    const filter = h('input', { type: 'search', class: 'tools-filter', placeholder: 'Filter tools…', spellcheck: false });
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const el of list.children) if (el._find !== undefined) el.hidden = !!q && !el._find.includes(q);
      for (const g of list.querySelectorAll('.tools-group')) {
        let n = g.nextElementSibling, any = false;
        while (n && !n.classList.contains('tools-group')) { if (!n.hidden) any = true; n = n.nextElementSibling; }
        g.hidden = !any;
      }
    });
    filter.addEventListener('keydown', (e) => { if (e.key === 'Enter') [...list.children].find((el) => el._find !== undefined && !el.hidden)?.click(); });
    // the sortie flying right now isn't in the totals until it ends
    if (this.settings.tomcatEnabled && this._flight) this._flight.then((f) => {
      const g = f.game;
      const sub = list.querySelector('.tools-tomcat .tools-sub');
      if (g && !g.gameOver && sub && this.panel === 'tools') sub.textContent = this.splashLine(g.splashes);
    }).catch(() => {});
    p.append(h('div', { class: 'panel-head' }, 'Toolbox', h('div', { class: 'grow' }),
      mine ? h('button', { class: 'icon-btn', 'data-tip': 'Put the tools back in their usual order', onclick: () => {
        const { toolbox, ...rest } = this.settings.cardOrder || {};
        void toolbox;
        this.saveSettings({ cardOrder: rest });
        this.renderToolsPanel();
      } }, icon('refresh', 'sm')) : null,
      h('button', { class: 'icon-btn', 'data-tip': 'Hide panel', onclick: () => this.hidePanel() }, icon('x', 'sm'))),
    h('div', { class: 'tools-filter-box' }, filter),
    h('div', { class: 'panel-body' }, list));
  }

  /** Drag the Toolbox's tools into the order you like; it's saved on its own, apart from the home page's order. */
  sortableTools(list) {
    const rows = () => [...list.querySelectorAll('.tools-row[data-key]')];
    let dragged = null;
    const clearMarks = () => { for (const r of rows()) r.classList.remove('drop-before', 'drop-after'); };
    for (const row of rows()) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => { dragged = row; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/bds-tool', row.dataset.key); });
      row.addEventListener('dragend', () => { dragged = null; row.classList.remove('dragging'); clearMarks(); });
      row.addEventListener('dragover', (e) => {
        if (!dragged || dragged === row) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        clearMarks();
        row.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
      });
      row.addEventListener('drop', (e) => {
        if (!dragged || dragged === row) return;
        e.preventDefault();
        const after = row.classList.contains('drop-after');
        clearMarks();
        if (after) row.after(dragged); else row.before(dragged);
        this.saveSettings({ cardOrder: { ...(this.settings.cardOrder || {}), toolbox: rows().map((r) => r.dataset.key) } });
        // the reset button shows up once there's an order of your own
        if (this.panel === 'tools' && !this.sidepanel.querySelector('.panel-head .icon-btn[data-tip^="Put the tools"]')) this.renderToolsPanel();
      });
    }
  }

  async renderRecentPanel() {
    const p = clear(this.sidepanel);
    const list = h('div', { class: 'file-list' });
    p.append(h('div', { class: 'panel-head' }, 'Recent', h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', 'data-tip': 'Clear list', onclick: async () => { await api.removeRecent(null); this.renderRecentPanel(); } }, icon('trash', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Hide panel', onclick: () => this.hidePanel() }, icon('x', 'sm'))),
    h('div', { class: 'panel-body' }, list));
    rubberSelect(list, { scroller: () => list.parentElement, menu: (items) => this.recentManyMenu(items, () => this.renderRecentPanel()), onDelete: (items) => this.forgetRecents(items, () => this.renderRecentPanel()), onOpen: (items) => this.openMany(items) });
    if (this.settings.showRecent === false) return list.append(h('div', { class: 'empty-note' }, 'Recent files are hidden. Turn them back on in Settings › Files.'));
    try {
      const recent = await api.recent();
      if (!recent.length) list.append(h('div', { class: 'empty-note' }, 'Nothing yet.'));
      for (const r of recent) {
        const row = h('button', { class: `file-row ${r.exists ? '' : 'muted'}`, title: r.path },
          h('span', { class: 'fr-icon' }, icon(iconForName(r.name), 'sm')),
          h('span', { class: 'fr-name' }, r.name),
          h('span', { class: 'fr-meta' }, timeAgo(r.at)));
        row.addEventListener('click', () => r.exists && this.openPath(r.path));
        row.addEventListener('contextmenu', (e) => contextMenu(e, [
          { label: 'Show in folder', disabled: !r.exists, action: () => api.reveal(r.path) },
          { label: 'Remove from list', action: () => api.removeRecent(r.path).then(() => this.renderRecentPanel()) },
        ]));
        row._item = r;
        list.append(row);
      }
    } catch (e) { list.append(h('div', { class: 'empty-note' }, e.message)); }
  }
}
