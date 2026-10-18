// ✂ clip — right-side tab: History (what you've copied in Box-Deckspitter) and Snippets (saved texts).
// Click = put it into what you're working on · right-click = copy · shift+right-click = more.

import { h, clear, debounce, timeAgo, blobToDataURL, basename, formatBytes } from './dom.js';
import { icon } from './icons.js';
import { toast, errorToast, contextMenu, modal, confirmDialog } from './ui.js';

export class ClipsPanel {
  constructor(app, host) {
    this.app = app;
    this.clips = app.clips;
    this.tab = app.settings.clipTab === 'snippets' ? 'snippets' : 'history';
    this.query = '';
    this.build();
    host.append(this.el);
    this.unsub = this.clips.onChange(() => this.render());
    this.clips.ready.then(() => this.render());
    this.render();
  }

  build() {
    this.tabsEl = h('div', { class: 'clip-tabs' });
    this.search = h('input', { type: 'search', placeholder: 'search…', spellcheck: 'false' });
    this.search.addEventListener('input', debounce(() => { this.query = this.search.value.trim().toLowerCase(); this.render(); }, 100));
    this.actions = h('div', { class: 'clip-actions' });
    this.list = h('div', { class: 'clip-list' });
    this.el = h('div', { class: 'clip-panel' },
      h('div', { class: 'panel-head' }, h('span', { class: 'clip-glyph' }, '✂'), 'clip', h('div', { class: 'grow' }),
        h('button', { class: 'icon-btn', 'data-tip': 'Close', onclick: () => this.app.toggleRightPanel(null) }, icon('x', 'sm'))),
      this.tabsEl,
      h('div', { class: 'clip-controls' }, this.search),
      this.actions,
      this.list,
      h('div', { class: 'clip-foot faint' }, 'click → put it in · right-click → copy · shift+right-click → more'));
  }

  setTab(t) {
    this.tab = t;
    this.app.saveSettings({ clipTab: t });
    this.render();
  }

  render() {
    clear(this.tabsEl).append(...[['history', 'History', this.clips.history.length], ['snippets', 'Snippets', this.clips.snippets.length]].map(([id, label, n]) =>
      h('button', { class: this.tab === id ? 'on' : '', onclick: () => this.setTab(id) }, label, h('span', { class: 'clip-n mono' }, String(n)))));
    clear(this.actions);
    clear(this.list);
    if (this.tab === 'history') this.renderHistory(); else this.renderSnippets();
  }

  // ================================================================ history

  renderHistory() {
    const items = this.clips.history.filter((x) => !this.query || (x.text || x.name || '').toLowerCase().includes(this.query));
    if (this.clips.history.some((x) => !x.pinned)) {
      this.actions.append(h('button', { class: 'btn sm ghost', onclick: async () => {
        if (await confirmDialog('Clear history?', 'Pinned items stay. Snippets aren’t affected.', { okLabel: 'Clear', danger: true })) this.clips.clearHistory();
      } }, icon('trash', 'sm'), 'Clear'));
    }
    if (!items.length) {
      this.list.append(h('div', { class: 'clip-empty' }, this.query ? 'Nothing matches.' : 'Nothing copied yet. Text you copy in Box-Deckspitter (Ctrl+C, Copy buttons, characters) and pictures or files you copy from the dumps show up here.'));
      return;
    }
    const pinned = items.filter((x) => x.pinned);
    const rest = items.filter((x) => !x.pinned);
    if (pinned.length) this.list.append(h('div', { class: 'clip-heading' }, 'pinned'), ...pinned.map((x) => this.historyRow(x)));
    if (pinned.length && rest.length) this.list.append(h('div', { class: 'clip-heading' }, 'recent'));
    this.list.append(...rest.map((x) => this.historyRow(x)));
  }

  historyRow(item) {
    let body;
    if (item.type === 'image') body = h('div', { class: 'clip-img' }, h('img', { src: item.url, alt: '', loading: 'lazy' }), h('span', { class: 'clip-name' }, item.name || 'image'));
    else if (item.type === 'file') body = h('div', { class: 'clip-file' }, icon(/\.pdf$/i.test(item.name || '') ? 'file-pdf' : 'file', 'lg'), h('span', { class: 'clip-name' }, item.name || basename(item.path || '')));
    else body = h('div', { class: 'clip-text' }, item.text.length > 400 ? item.text.slice(0, 400) + '…' : item.text);
    const tip = item.type === 'text' ? `${item.text.length.toLocaleString()} characters` : item.path || item.name;
    const row = h('div', { class: `clip-row ${item.pinned ? 'pinned' : ''}`, title: tip },
      body,
      h('div', { class: 'clip-meta mono faint' }, item.pinned ? '📌 ' : '', item.type === 'text' ? '' : item.type + ' · ', timeAgo(item.at), item.source ? ` · ${item.source}` : ''));
    row.addEventListener('click', () => this.use(item));
    row.addEventListener('contextmenu', (e) => {
      if (e.shiftKey) return contextMenu(e, this.historyMenu(item));
      e.preventDefault();
      this.copy(item, row);
    });
    return row;
  }

  historyMenu(item) {
    return [
      { label: item.type === 'file' ? 'Open' : 'Put it in', icon: item.type === 'file' ? 'file' : 'plus', action: () => this.use(item) },
      { label: 'Copy', icon: 'copy', action: () => this.copy(item) },
      { label: item.pinned ? 'Unpin' : 'Pin', icon: 'star', action: () => this.clips.togglePin(item) },
      ...(item.type === 'text' ? [{ label: 'Save as snippet…', icon: 'edit', action: () => this.editSnippet(null, item.text) }] : []),
      { sep: true },
      { label: 'Remove', icon: 'trash', action: () => this.clips.remove(item) },
    ];
  }

  async use(item) {
    if (item.type === 'file') { this.app.openPath(item.path); return; }
    if (item.type === 'image') {
      const ed = this.app.active?.editor;
      const place = ed?.insertImage ? (u) => ed.insertImage(u) : ed?.placeImage ? (u) => ed.placeImage(u) : null;
      if (!place) return this.copy(item, null, 'Copied — paste it where you need it');
      try { place(await blobToDataURL(await (await fetch(item.url)).blob())); } catch (e) { errorToast(e); }
      return;
    }
    this.insertText(item.text);
  }

  insertText(text) {
    if (this.app.insertTextIntoActive(text)) return;
    this.clips.copyText(text).then(() => toast('Nothing to type into here — copied instead', { timeout: 1800 })).catch(errorToast);
  }

  async copy(item, row = null, msg = 'Copied') {
    try {
      await this.clips.copyEntry(item);
      if (row) { row.classList.add('copied'); setTimeout(() => row.classList.remove('copied'), 500); }
      toast(msg, { timeout: 1200 });
    } catch (e) { errorToast(e, 'Copy failed'); }
  }

  // ================================================================ snippets

  renderSnippets() {
    this.actions.append(
      h('button', { class: 'btn sm primary', onclick: () => this.editSnippet() }, icon('plus', 'sm'), 'New snippet'),
      h('button', { class: 'btn sm ghost', 'data-tip': 'Make a snippet from what’s on the clipboard', onclick: async () => {
        let text = '';
        try { text = await navigator.clipboard.readText(); } catch { /* blocked */ }
        this.editSnippet(null, text || this.clips.history.find((x) => x.type === 'text')?.text || '');
      } }, icon('paste', 'sm'), 'From clipboard'));
    const items = this.clips.snippets.filter((x) => !this.query || `${x.title}\n${x.text}`.toLowerCase().includes(this.query));
    if (!items.length) {
      this.list.append(h('div', { class: 'clip-empty' }, this.query ? 'Nothing matches.' : 'Save texts you use again and again — your address, an email sign-off, a stock reply, answers for forms. Click one to type it into whatever you’re working on.'));
      return;
    }
    for (const s of items) {
      const row = h('div', { class: 'clip-row snippet', title: s.text },
        h('div', { class: 'clip-title' }, s.title || s.text.split('\n')[0].slice(0, 60)),
        h('div', { class: 'clip-text' }, s.text.length > 300 ? s.text.slice(0, 300) + '…' : s.text));
      row.addEventListener('click', () => this.insertText(s.text));
      row.addEventListener('contextmenu', (e) => {
        if (e.shiftKey) return contextMenu(e, this.snippetMenu(s));
        e.preventDefault();
        this.clips.copyText(s.text).then(() => { row.classList.add('copied'); setTimeout(() => row.classList.remove('copied'), 500); toast('Copied', { timeout: 1200 }); }).catch(errorToast);
      });
      this.list.append(row);
    }
  }

  snippetMenu(s) {
    const i = this.clips.snippets.indexOf(s);
    return [
      { label: 'Put it in', icon: 'plus', action: () => this.insertText(s.text) },
      { label: 'Copy', icon: 'copy', action: () => this.clips.copyText(s.text).then(() => toast('Copied', { timeout: 1200 })) },
      { label: 'Edit…', icon: 'edit', action: () => this.editSnippet(s) },
      { label: 'Duplicate', action: () => this.clips.addSnippet(`${s.title} (copy)`, s.text) },
      { sep: true },
      { label: 'Move up', icon: 'arrow-up', disabled: i <= 0, action: () => this.clips.moveSnippet(s, -1) },
      { label: 'Move down', icon: 'arrow-down', disabled: i >= this.clips.snippets.length - 1, action: () => this.clips.moveSnippet(s, 1) },
      { sep: true },
      { label: 'Delete', icon: 'trash', action: async () => { if (await confirmDialog('Delete snippet?', `“${s.title || s.text.slice(0, 40)}” will be gone.`, { okLabel: 'Delete', danger: true })) this.clips.removeSnippet(s); } },
    ];
  }

  async editSnippet(s = null, text = '') {
    const title = h('input', { type: 'text', value: s?.title || '', placeholder: 'Name (e.g. Home address, Email sign-off)' });
    const body = h('textarea', { rows: '8', placeholder: 'The text to keep', spellcheck: 'true' });
    body.value = s ? s.text : text;
    const count = h('span', { class: 'faint mono', style: { fontSize: '10.5px' } });
    const upd = () => { count.textContent = `${body.value.length.toLocaleString()} characters`; };
    body.addEventListener('input', upd);
    upd();
    const res = await modal({
      title: s ? 'Edit snippet' : 'New snippet', wide: true,
      body: h('div', { class: 'clip-edit' }, title, body, count, h('div', { class: 'faint', style: { fontSize: '11px' } }, 'Stored only on this PC (Box-Deckspitter\\data). Settings → Reset erases it.')),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Save', value: 'ok', primary: true }],
      onOpen: () => setTimeout(() => (s || text ? title : body).focus(), 40),
    });
    if (res !== 'ok' || !body.value.trim()) return;
    if (s) this.clips.updateSnippet(s, { title: title.value.trim(), text: body.value });
    else { this.clips.addSnippet(title.value.trim(), body.value); if (this.tab !== 'snippets') this.setTab('snippets'); }
  }

  destroy() { this.unsub?.(); }
}
