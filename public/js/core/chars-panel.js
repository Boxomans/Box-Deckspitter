// Compact special-character drawer that opens from the right-hand tab rail.

import { h, clear, debounce } from './dom.js';
import { icon } from './icons.js';
import { contextMenu, toast } from './ui.js';
import { CHAR_SETS, charsFor, describe, searchChars, loadCharNames } from './chars.js';

export class CharsPanel {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.set = app.settings.charSet || 'alt0';
    this.recent = Array.isArray(app.settings.charRecent) ? app.settings.charRecent : [];
    this.query = '';
    this.build();
  }

  build() {
    this.search = h('input', { type: 'search', placeholder: 'search: name, 0169, U+2192…', spellcheck: 'false' });
    this.search.addEventListener('input', debounce(() => { this.query = this.search.value; this.renderGrid(); }, 120));
    loadCharNames().then(() => { if (this.query.trim()) this.renderGrid(); });
    this.select = h('select', { class: 'chars-select' }, h('option', { value: 'all' }, 'All characters'), CHAR_SETS.filter((s) => s.id !== 'recent').map((s) => h('option', { value: s.id }, s.label)));
    this.select.value = this.set;
    this.select.addEventListener('change', () => { this.set = this.select.value; this.search.value = ''; this.query = ''; this.app.saveSettings({ charSet: this.set }); this.renderGrid(); });
    this.recentRow = h('div', { class: 'chars-recent' });
    this.note = h('div', { class: 'chars-note' });
    this.grid = h('div', { class: 'chars-grid' });
    this.info = h('div', { class: 'chars-info' });
    this.el = h('div', { class: 'chars-panel' },
      h('div', { class: 'panel-head' }, h('span', { class: 'chars-omega' }, 'Ω'), 'characters', h('div', { class: 'grow' }),
        h('button', { class: 'icon-btn', 'data-tip': 'Close', onclick: () => this.app.toggleRightPanel(null) }, icon('x', 'sm'))),
      h('div', { class: 'chars-controls' }, this.search, this.select),
      this.recentRow,
      this.note,
      h('div', { class: 'chars-scroll' }, this.grid),
      this.info);
    this.host.append(this.el);
    this.renderRecent();
    this.renderGrid();
    this.showInfo(null);
  }

  cell(item, showAlt) {
    const b = h('button', { class: 'chars-cell' }, h('span', { class: 'cc-ch' }, item.ch === ' ' ? '⍽' : item.ch));
    if (showAlt && item.alt) b.append(h('span', { class: 'cc-alt' }, item.alt));
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret where it is
    b.addEventListener('mouseenter', () => this.showInfo(item.ch));
    b.addEventListener('click', () => this.insert(item.ch));
    b.addEventListener('contextmenu', (e) => {
      if (!e.shiftKey) { e.preventDefault(); this.copy(item.ch); b.classList.add('copied'); setTimeout(() => b.classList.remove('copied'), 500); return; }
      const d = describe(item.ch);
      contextMenu(e, [
        { label: 'Insert', icon: 'plus', action: () => this.insert(item.ch) },
        { label: 'Copy character', icon: 'copy', action: () => this.copy(item.ch) },
        { label: `Copy HTML entity  ${d.html}`, action: () => this.copy(d.html) },
        { label: `Copy code point  ${d.hex}`, action: () => this.copy(d.hex) },
      ]);
    });
    return b;
  }

  renderRecent() {
    clear(this.recentRow);
    if (!this.recent.length) { this.recentRow.hidden = true; return; }
    this.recentRow.hidden = false;
    this.recentRow.append(h('span', { class: 'chars-label' }, 'recent'));
    for (const ch of this.recent.slice(0, 14)) this.recentRow.append(this.cell({ ch }, false));
  }

  renderGrid() {
    clear(this.grid);
    let items;
    let showAlt = false;
    if (this.query.trim()) {
      items = searchChars(this.query).map((x) => ({ ...x, alt: describe(x.ch).alt }));
      this.note.textContent = items.length ? `${items.length}${items.length >= 600 ? '+' : ''} match${items.length === 1 ? '' : 'es'} across all categories` : 'no matches — try a name, an alt code like 0169, or U+2192';
      showAlt = true;
    } else {
      const set = this.set === 'all' ? { note: 'every category' } : CHAR_SETS.find((s) => s.id === this.set);
      items = charsFor(this.set);
      showAlt = this.set === 'alt' || this.set === 'alt0';
      this.note.textContent = set?.note ? `${set.note} · ${items.length} chars` : `${items.length} characters`;
    }
    this.grid.classList.toggle('with-alt', showAlt);
    const frag = document.createDocumentFragment();
    for (const it of items) frag.append(this.cell(it, showAlt));
    this.grid.append(frag);
    this.grid.parentElement.scrollTop = 0;
  }

  showInfo(ch) {
    clear(this.info);
    if (!ch) { this.info.append(h('span', { class: 'faint' }, 'click → add to doc · right-click → copy')); return; }
    const d = describe(ch);
    this.info.append(
      h('span', { class: 'ci-big' }, ch === ' ' ? '⍽' : ch),
      h('div', { class: 'ci-meta' },
        h('div', { class: 'ci-name' }, d.name || '—'),
        h('div', { class: 'ci-codes' }, d.hex, d.alt ? `  ·  Alt+${d.alt}` : '', `  ·  ${d.html}`)));
  }

  insert(ch) {
    const ok = this.app.insertTextIntoActive(ch);
    if (!ok) { this.copy(ch); return; }
    this.recent = [ch, ...this.recent.filter((c) => c !== ch)].slice(0, 28);
    this.app.saveSettings({ charRecent: this.recent });
    this.renderRecent();
  }

  async copy(text) {
    try { await navigator.clipboard.writeText(text); toast(`Copied ${text}`, { type: 'ok', timeout: 1400 }); } catch { toast('Clipboard blocked', { type: 'warn' }); }
  }

  focus() { this.search.focus(); }
}
