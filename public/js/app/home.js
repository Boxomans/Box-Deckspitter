// Box-DocSpitter app shell, the home page: its cards, their order and names.
// Methods of App (app.js mixes this class into it).

import { $, $$, h, clear, dirname, timeAgo } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { showMenu, contextMenu, modal, toast, errorToast, hoverKeys, rubberSelect } from '../core/ui.js';
import { LANGUAGES, iconForName } from '../core/filetypes.js';
import { pickOpen } from '../core/files.js';
import { TOOLS, TOOL_OF_MODE, offered } from '../core/tools.js';

const HOME_TITLE = 'BOX//DOCSPITTER';

const HOME_TAGLINE = 'local docs, pdfs, video, storage, text & code — nothing leaves this machine unless you want it to';

export class HomePart {
  buildHome() {
    this.homeEl = h('div', { class: 'home' });
    this.workspace.append(this.homeEl);
  }

  /** Home cards in the order you dragged them into (new cards you haven't placed go at the end). */
  ordered(group, list, keyOf) {
    const saved = (this.settings.cardOrder || {})[group] || [];
    const rank = new Map(saved.map((k, i) => [k, i]));
    return [...list].sort((a, b) => (rank.get(keyOf(a)) ?? 1e6 + list.indexOf(a)) - (rank.get(keyOf(b)) ?? 1e6 + list.indexOf(b)));
  }

  /** Drag home cards to reorder them; the order is saved by each card's original name. */
  sortableCards(grid, group) {
    let dragged = null;
    for (const card of grid.children) {
      card.draggable = true;
      card.addEventListener('dragstart', (e) => { dragged = card; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/bds-card', card.dataset.key); });
      card.addEventListener('dragend', () => { dragged = null; card.classList.remove('dragging'); for (const c of grid.children) c.classList.remove('drop-before', 'drop-after'); });
      card.addEventListener('dragover', (e) => {
        if (!dragged || dragged === card || dragged.parentElement !== grid) return;
        e.preventDefault();
        const r = card.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        for (const c of grid.children) c.classList.remove('drop-before', 'drop-after');
        card.classList.add(after ? 'drop-after' : 'drop-before');
      });
      card.addEventListener('drop', (e) => {
        if (!dragged || dragged === card) return;
        e.preventDefault();
        const after = card.classList.contains('drop-after');
        card.classList.remove('drop-before', 'drop-after');
        if (after) card.after(dragged); else card.before(dragged);
        this.saveSettings({ cardOrder: { ...(this.settings.cardOrder || {}), [group]: [...grid.children].map((c) => c.dataset.key) } });
      });
    }
  }

  /** F2 on the home logo: pick a picture (file, media dump or paste) — shrunk to 256 px and kept in settings. */
  async changeHomeLogo(img) {
    const set = (url) => { this.saveSettings({ homeLogo: url }); img.src = url || '/assets/icon.svg'; };
    const shrink = async (blob) => {
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
      const c = h('canvas', { width: Math.max(1, Math.round(bmp.width * k)), height: Math.max(1, Math.round(bmp.height * k)) });
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(bmp, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    };
    const use = async (blob) => { try { set(await shrink(blob)); ctx?.close(null); } catch (e) { errorToast(e, 'Couldn’t use that picture'); } };
    let ctx = null;
    const preview = h('img', { src: this.settings.homeLogo || '/assets/icon.svg', alt: '', class: 'logo-pick-preview' });
    const grid = h('div', { class: 'mail-dumppick image logo-pick-dump' });
    api.dump('image').then(({ items }) => {
      if (!items.length) grid.append(h('div', { class: 'faint' }, 'The media dump is empty.'));
      for (const it of items) {
        const b = h('button', { class: 'mail-dumpitem', title: it.name }, h('img', { src: it.url, alt: '' }), h('span', { class: 'mail-dumpname' }, it.name));
        b.addEventListener('click', async () => use(await (await fetch(it.url)).blob()));
        grid.append(b);
      }
    }).catch(() => {});
    const pasteHint = h('div', { class: 'faint', style: { fontSize: '11px' } }, 'Tip: you can also paste a picture (Ctrl+V) while this is open.');
    const onPaste = (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); use(f); } };
    document.addEventListener('paste', onPaste);
    await modal({
      title: 'Change the logo', wide: true,
      body: h('div', { class: 'logo-pick' },
        h('div', { class: 'row' }, preview,
          h('div', { class: 'logo-pick-btns' },
            h('button', { class: 'btn primary', onclick: async () => {
              const paths = await pickOpen({ title: 'Choose a logo picture', filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico'] }] });
              if (!paths?.length) return;
              try { const { bytes } = await api.read(paths[0]); use(new Blob([bytes], { type: /\.svg$/i.test(paths[0]) ? 'image/svg+xml' : '' })); } catch (e) { errorToast(e); }
            } }, icon('folder-open', 'sm'), 'Choose a picture…'),
            h('button', { class: 'btn ghost', onclick: () => { set(null); ctx?.close(null); } }, icon('undo', 'sm'), 'Back to the original'),
            pasteHint)),
        h('div', { class: 'home-section-title' }, 'from the media dump'),
        grid),
      buttons: [{ label: 'Close', value: null, ghost: true }],
      onOpen: (c) => { ctx = c; },
    });
    document.removeEventListener('paste', onPaste);
  }

  /** A tool's name as you've named it (F2 on its home card), e.g. toolName('BoxTape'). */
  /** A tool's own name changed: carry over what was saved under the old one (a custom name, the card order). */
  renameToolKey(from, to) {
    const s = this.settings, patch = {};
    if (s.cardNames && from in s.cardNames) { const n = { ...s.cardNames }; if (!(to in n)) n[to] = n[from]; delete n[from]; patch.cardNames = n; }
    if (s.cardOrder && Object.values(s.cardOrder).some((l) => Array.isArray(l) && l.includes(from))) {
      patch.cardOrder = Object.fromEntries(Object.entries(s.cardOrder).map(([g, l]) => [g, Array.isArray(l) ? l.map((k) => (k === from ? to : k)) : l]));
    }
    if (Object.keys(patch).length) this.saveSettings(patch);
  }

  toolName(key) { return (this.settings.cardNames || {})[key] || key; }

  /** After a rename: every heading, open tab, menu and status bar that shows the tool picks up the new name. */
  toolRenamed(key, was) {
    const now = this.toolName(key);
    for (const el of $$(`[data-toolname="${CSS.escape(key)}"]`)) el.textContent = now;
    const mode = Object.keys(TOOL_OF_MODE).find((m) => TOOL_OF_MODE[m] === key);
    if (mode) {
      for (const t of this.tabs) {
        if (t.mode !== mode || t.path) continue;
        // "BoxTape" or "BoxTape 2" → the same with the new name (tabs named after their contents are left alone)
        if (t.title === was || t.title.startsWith(was + ' ')) this.setTabMeta(t, { title: now + t.title.slice(was.length) });
      }
    }
    if (key === 'BoxSpaces' && this.panel === 'spaces' && this.spaces?.host) this.spaces.render(this.spaces.host);
    this.renderMenubar();
    this.updateStatus(this.active);
  }

  /** A home screen card. Hover + F2 renames it (saved in settings); Ctrl+F2 puts the original name back. */
  homeCard(ic, title, sub) {
    const names = this.settings.cardNames || {};
    const nameEl = h('span', { class: 'nc-title' }, names[title] || title);
    const subs = this.settings.cardSubs || {};
    const subEl = h('span', { class: 'nc-sub' }, subs[title] || sub);
    const card = h('button', { class: 'new-card', dataset: { key: title }, title: 'F2 to rename · Ctrl+F2 to reset · drag to reorder (hover the small line to change that instead)' }, h('span', { class: 'nc-icon' }, icon(ic, 'lg')), nameEl, subEl);
    hoverKeys(subEl, {
      nameEl: subEl,
      value: () => (this.settings.cardSubs || {})[title] || sub,
      commit: (n) => {
        const next = { ...(this.settings.cardSubs || {}) };
        if (!n.trim() || n.trim() === sub) delete next[title]; else next[title] = n.trim();
        this.saveSettings({ cardSubs: next });
        subEl.textContent = next[title] || sub;
      },
      reset: () => { const next = { ...(this.settings.cardSubs || {}) }; delete next[title]; this.saveSettings({ cardSubs: next }); subEl.textContent = sub; },
    });
    hoverKeys(card, {
      nameEl,
      value: () => (this.settings.cardNames || {})[title] || title,
      commit: (n) => {
        const was = this.toolName(title);
        const next = { ...(this.settings.cardNames || {}) };
        if (!n.trim() || n.trim() === title) delete next[title]; else next[title] = n.trim();
        this.saveSettings({ cardNames: next });
        nameEl.textContent = next[title] || title;
        this.toolRenamed(title, was);
      },
      reset: () => { const was = this.toolName(title); const next = { ...(this.settings.cardNames || {}) }; delete next[title]; this.saveSettings({ cardNames: next }); nameEl.textContent = title; this.toolRenamed(title, was); },
    });
    return card;
  }

  async refreshHome() {
    const el = clear(this.homeEl);
    const cards = [
      ['doc', 'file-doc', 'Document', '.docx · rich text'],
      ['pdf-images', 'file-pdf', 'PDF from images', '.pdf · combine'],
      ['text', 'file-text', 'Text file', '.txt · notepad'],
      ['code', 'file-code', 'Code / config', 'json · ini · yaml…'],
      ['html', 'globe', 'HTML page', 'live preview'],
      ['md', 'markdown', 'Markdown', 'live preview'],
      ['sheet', 'sheet', 'Spreadsheet', '.xlsx · .csv'],
      ['paint', 'brush', 'Image', 'paint · layers · .png'],
    ];
    const inner = h('div', { class: 'home-inner' });
    // the big title and the line under it can be renamed with F2 (the user@127.0.0.1 part always stays)
    const editable = (el, key, def) => hoverKeys(el, {
      nameEl: el,
      value: () => this.settings[key] || def,
      commit: (n) => { const v = n.trim() && n.trim() !== def ? n.trim() : null; this.saveSettings({ [key]: v }); el.textContent = v || def; },
      reset: () => { this.saveSettings({ [key]: null }); el.textContent = def; },
    });
    const heroTitle = h('span', { class: 'g' }, this.settings.homeTitle || HOME_TITLE);
    const heroTag = h('span', {}, this.settings.homeTagline || HOME_TAGLINE);
    editable(heroTitle, 'homeTitle', HOME_TITLE);
    const heroLogo = h('img', { src: this.settings.homeLogo || '/assets/icon.svg', alt: '', title: 'F2 to change the logo' });
    hoverKeys(heroLogo, { f2: () => this.changeHomeLogo(heroLogo), reset: () => { this.saveSettings({ homeLogo: null }); heroLogo.src = '/assets/icon.svg'; } });
    editable(heroTag, 'homeTagline', HOME_TAGLINE);
    el.append(h('div', { class: 'home-grid' }), inner);
    inner.append(
      h('div', { class: 'home-hero' },
        heroLogo,
        h('div', {},
          h('h1', { class: 'home-title', title: 'F2 to rename' }, heroTitle, h('span', { class: 'cursor' })),
          h('p', { class: 'home-sub', title: 'F2 to change this line' }, '> ', heroTag, `  ·  ${this.info?.user || ''}@127.0.0.1`))),
    );

    const draftsHost = h('div');
    inner.append(draftsHost);

    inner.append(h('div', { class: 'home-section-title' }, 'start something'));
    const grid = h('div', { class: 'new-cards' });
    for (const [kind, ic, title, sub] of this.ordered('start', cards, (c) => c[2])) {
      const card = this.homeCard(ic, title, sub);
      card.addEventListener('click', (e) => {
        if (kind === 'code') showMenu(LANGUAGES.map(([id, name]) => ({ label: name, action: () => this.newDocument('code', { lang: id }) })), { x: e.clientX, y: e.clientY });
        else this.newDocument(kind);
      });
      grid.append(card);
    }
    this.sortableCards(grid, 'start');
    inner.append(grid);
    inner.append(h('div', { class: 'home-section-title' }, 'tools'));
    const toolGrid = h('div', { class: 'new-cards tool-cards' });
    for (const [ic, title, sub, fn] of this.ordered('tools', this.homeTools(), (c) => c[1])) {
      const card = this.homeCard(ic, title, sub);
      card.addEventListener('click', fn);
      toolGrid.append(card);
    }
    this.sortableCards(toolGrid, 'tools');
    inner.append(toolGrid);
    inner.append(h('div', { class: 'home-actions' },
      h('button', { class: 'btn primary', onclick: () => this.openDialog() }, icon('folder-open'), 'Open a file…'),
      h('button', { class: 'btn', onclick: () => this.showPanel('explorer') }, icon('folder'), 'Browse files'),
      h('button', { class: 'btn ghost', onclick: () => this.showShortcuts() }, icon('keyboard'), 'Shortcuts')));
    inner.append(h('div', { class: 'drop-hint' }, 'drop files anywhere to open them  ·  pdf  docx  odt  rtf  txt  md  html  json  yaml  ini  xlsx  csv  png  jpg  svg …'));

    const recentHost = h('div');
    inner.append(recentHost);

    try {
      const recent = this.settings.showRecent === false ? [] : (await api.recent()).slice(0, 12);
      if (recent.length) {
        recentHost.append(h('div', { class: 'home-section-title' }, 'recent',
          h('button', { class: 'home-clear', title: 'Clear the recent list (the files themselves stay where they are)', onclick: async () => { await api.removeRecent(null); this.refreshHome(); toast('Recent list cleared', { timeout: 1400 }); } }, 'clear')));
        const list = h('div', { class: 'recent-list' });
        rubberSelect(list, { rows: '.recent-row', menu: (items) => this.recentManyMenu(items, () => this.refreshHome()), onDelete: (items) => this.forgetRecents(items, () => this.refreshHome()), onOpen: (items) => this.openMany(items) });
        for (const r of recent) {
          const row = h('button', { class: `recent-row ${r.exists ? '' : 'missing'}`, title: r.exists ? r.path : 'File not found' },
            h('span', { class: 'rr-icon' }, icon(iconForName(r.name), 'sm')),
            h('span', { class: 'rr-name' }, r.name),
            h('span', { class: 'rr-path' }, dirname(r.path)),
            h('span', { class: 'rr-time' }, timeAgo(r.at)));
          row.addEventListener('click', () => (r.exists ? this.openPath(r.path) : toast('That file no longer exists.', { type: 'warn' })));
          row.addEventListener('contextmenu', (e) => contextMenu(e, [
            { label: 'Open', disabled: !r.exists, action: () => this.openPath(r.path) },
            { label: 'Show in folder', disabled: !r.exists, action: () => api.reveal(r.path) },
            { label: 'Remove from list', action: () => api.removeRecent(r.path).then(() => this.refreshHome()) },
          ]));
          row._item = r;
          list.append(row);
        }
        recentHost.append(list);
      }
    } catch { /* ignore */ }

    try {
      const openIds = new Set(this.tabs.map((t) => t.id));
      const drafts = (await api.drafts()).filter((d) => !openIds.has(d.id) && !(d.live && d.client !== this.clientId));
      if (drafts.length) {
        draftsHost.append(h('div', { class: 'banner' },
          icon('history'),
          h('div', { class: 'grow' }, h('b', {}, `${drafts.length} unsaved document${drafts.length > 1 ? 's' : ''} recovered`), h('div', { class: 'dim' }, drafts.slice(0, 3).map((d) => d.title).join(', ') + (drafts.length > 3 ? '…' : ''))),
          h('button', { class: 'btn ghost', onclick: async () => { for (const d of drafts) await api.deleteDraft(d.id); this.refreshHome(); } }, 'Discard'),
          h('button', { class: 'btn primary', onclick: () => this.restoreDrafts(drafts) }, 'Restore')));
      }
    } catch { /* ignore */ }
  }

  /** The home page's tool cards: [icon, name, what it does, open]. The Tools folder lists them too. */
  homeTools() {
    return TOOLS.filter((t) => t.home && offered(t))
      .map((t) => [t.home.icon, t.name, t.home.sub, () => (t.home.open ? t.home.open(this) : this.newDocument(t.mode))]);
  }
}
