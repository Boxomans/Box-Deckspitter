// BoxSaver: the screensaver studio (Toolbox → BoxSaver). Your screensavers down the side, then the examples; a live
// preview in the middle; on the right the whole screen's settings and the stack of layers, each with its own. The
// dice throws one together at random. The screensaver itself (Settings → Screensaver) plays these
// (app/screensaver.js). They're kept in the settings, so they go with the setup export.

import { BaseEditor } from './base.js';
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, confirmDialog, promptDialog, contextMenu, showMenu } from '../core/ui.js';
import { SaverPlayer, LAYERS, LAYER_ORDER, COMMON, SAVER_PARAMS, EXAMPLES, newLayer, blankSaver, normalizeSaver, randomLayer, randomSaver } from '../core/saver.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

/** A picture made small enough to keep in the settings (longest side 512 px). */
function shrinkPicture(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/webp', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture couldn’t be read.')); };
    img.src = url;
  });
}

export class SaverEditor extends BaseEditor {
  static mode = 'saver';

  async load() {
    this.list = (Array.isArray(this.app.settings.screensavers) ? this.app.settings.screensavers : []).map(normalizeSaver);
    this.codeErrors = new Map();
    this.root = h('div', { class: 'saver-root' },
      this.side = h('div', { class: 'saver-side' }),
      h('div', { class: 'saver-main' },
        this.head = h('div', { class: 'saver-head' }),
        this.preview = h('div', { class: 'saver-preview' }),
        this.note = h('div', { class: 'saver-note' })),
      this.insp = h('div', { class: 'saver-insp' }));
    this.pane.append(this.root);
    const pick = this.app.settings.screensaverPick;
    this.cur = this.draft(this.find(pick) || this.list[0] || EXAMPLES[0]);
    this.sel = this.cur.layers[0]?.id || null;
    this.render();
  }

  /** An example opens as a copy of its own (from: the example's id) that becomes yours with its first change (see
   *  edited); the example stays as it was. Your own open as they are. */
  draft(s) {
    if (!s.example) return s;
    const c = clone(s);
    delete c.example;
    c.from = s.id;
    return c;
  }

  /** The open screensaver changed: saved, and an example's copy kept as yours first. */
  edited() {
    const c = this.cur;
    if (c.from) {
      delete c.from;
      c.id = blankSaver().id;
      this.list.push(c);
      this.insp.querySelector('.saver-banner')?.remove(); // not the whole side: a slider may be mid-drag
      this.renderSide(); this.renderHead(); this.refreshStatus();
      toast(`“${c.name}” is yours now. The example stays as it was.`, { type: 'ok' });
    }
    this.save();
  }

  find(id) { return this.list.find((s) => s.id === id) || EXAMPLES.find((s) => s.id === id) || null; }

  /** Saves a moment after the last change. */
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.app.saveSettings({ screensavers: clone(this.list) }); this.app.redrawSaverSettings?.(); }, 500);
  }

  render() {
    this.renderSide();
    this.renderHead();
    this.renderInsp();
    this.startPlayer();
    this.renderNote();
    this.refreshStatus();
  }

  startPlayer() {
    this.player?.destroy();
    this.player = new SaverPlayer(this.preview, this.cur, {
      onCodeError: (id, msg) => {
        if (msg) this.codeErrors.set(id, msg); else this.codeErrors.delete(id);
        const el = this.insp.querySelector(`[data-code-err="${id}"]`);
        if (el) { el.textContent = msg || ''; el.hidden = !msg; }
      },
    });
  }

  /** Something about the layers' stack changed (added, removed, moved). */
  restack() { this.player?.set(this.cur); this.edited(); this.renderInsp(); this.refreshStatus(); }

  // ---------------------------------------------------------------- the list
  renderSide() {
    const row = (s) => {
      const el = h('div', { class: 'saver-item' + (s === this.cur || this.cur.from === s.id ? ' active' : ''), title: s.example ? 'An example: change anything and it’s saved as yours' : 'Double-click to rename · right-click for more',
        onclick: () => this.open(s),
        ondblclick: () => !s.example && this.rename(s),
        oncontextmenu: (e) => contextMenu(e, [
          { label: 'Try it full screen', icon: 'play', action: () => this.app.startScreensaver(s) },
          { label: 'Use as my screensaver', icon: 'check', action: () => this.use(s) },
          s.example ? { label: 'Make it yours', icon: 'copy', action: () => this.copy(s) } : { label: 'Rename…', icon: 'edit', action: () => this.rename(s) },
          !s.example ? { label: 'Duplicate', icon: 'copy', action: () => this.copy(s) } : null,
          !s.example ? { label: 'Delete', icon: 'trash', action: () => this.remove(s) } : null,
        ].filter(Boolean)) },
      icon(s.example ? 'sparkle' : 'saver', 'sm'), h('span', { class: 'saver-item-name' }, s.name),
      this.app.settings.screensaverPick === s.id ? h('span', { class: 'saver-badge', title: 'Your screensaver' }, icon('check', 'sm')) : null);
      return el;
    };
    clear(this.side).append(
      h('div', { class: 'clock-sec-title saver-side-title' }, 'Yours'),
      ...this.list.map(row),
      !this.list.length ? h('div', { class: 'faint saver-empty' }, 'None yet. Start a new one, roll the dice, or make one of the examples yours.') : null,
      h('div', { class: 'row saver-side-btns' },
        h('button', { class: 'btn sm', onclick: () => this.create(blankSaver()) }, icon('plus', 'sm'), 'New'),
        h('button', { class: 'btn sm', 'data-tip': 'Throw one together at random', onclick: () => this.create(randomSaver()) }, icon('dice', 'sm'), 'Random')),
      h('div', { class: 'clock-sec-title saver-side-title' }, 'Examples'),
      ...EXAMPLES.map(row));
  }

  open(s) {
    if (s === this.cur || this.cur.from === s.id) return;
    this.cur = this.draft(s);
    this.sel = s.layers[0]?.id || null;
    this.render();
  }

  create(s) {
    if (!s.layers.length) s.layers.push(newLayer('bounce'));
    this.list.push(s);
    this.save();
    this.cur = s;
    this.sel = s.layers[0].id;
    this.render();
  }

  copy(s) {
    const c = clone(s);
    delete c.example;
    c.id = blankSaver().id;
    c.name = s.example ? s.name : `${s.name} copy`;
    for (const L of c.layers) L.id = newLayer(L.type).id;
    this.create(normalizeSaver(c));
    toast(s.example ? `“${c.name}” is yours now. Change anything.` : `Duplicated as “${c.name}”`, { type: 'ok' });
  }

  async rename(s) {
    const name = (await promptDialog('Rename screensaver', 'Name', s.name) || '').trim();
    if (!name || name === s.name) return;
    s.name = name.slice(0, 80);
    this.save();
    this.renderSide(); this.renderHead(); this.refreshStatus();
  }

  async remove(s) {
    if (!(await confirmDialog(`Delete “${s.name}”?`, 'It can’t be brought back.', { okLabel: 'Delete', danger: true }))) return;
    const at = this.list.indexOf(s);
    this.list.splice(at, 1);
    if (this.app.settings.screensaverPick === s.id) this.app.saveSettings({ screensaverPick: 'random' });
    this.save();
    if (this.cur === s) { this.cur = this.list[Math.max(0, at - 1)] || this.draft(EXAMPLES[0]); this.sel = this.cur.layers[0]?.id || null; }
    this.render();
  }

  /** Makes it the one the screensaver shows (and offers to switch the screensaver on). */
  use(s) {
    this.app.saveSettings({ screensaverPick: s.id });
    this.renderSide(); this.renderNote();
    if (this.app.settings.screensaverOn) toast(`“${s.name}” is your screensaver now.`, { type: 'ok' });
    else toast(`“${s.name}” is your screensaver now. The screensaver is off.`, { type: 'ok', timeout: 6000, action: { label: 'Turn it on', fn: () => this.turnOn() } });
  }

  async turnOn() {
    await this.app.saveSettings({ screensaverOn: true });
    this.app.redrawSettings?.();
    this.renderNote();
    toast(`The screensaver comes on after ${this.app.settings.screensaverMin || 10} minutes of not using the PC. Settings → Screensaver changes that.`, { type: 'ok', timeout: 5000 });
  }

  // ---------------------------------------------------------------- the head and the note under the preview
  renderHead() {
    const s = this.cur;
    const name = h('input', { type: 'text', class: 'saver-name', value: s.name, maxlength: '80', spellcheck: 'false' });
    name.addEventListener('change', () => { const v = name.value.trim(); if (!v) { name.value = s.name; return; } s.name = v; this.edited(); this.renderSide(); this.refreshStatus(); });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    clear(this.head).append(
      name,
      h('div', { class: 'grow' }),
      s.from ? h('button', { class: 'btn sm primary', onclick: () => this.edited() }, icon('copy', 'sm'), 'Make it yours') : null,
      h('button', { class: 'btn sm', 'data-tip': 'Shows it the way the screensaver does. Any key or mouse move ends it.', onclick: () => this.app.startScreensaver(s) }, icon('play', 'sm'), 'Try it full screen'),
      h('button', { class: 'btn sm' + (this.app.settings.screensaverPick === s.id ? ' on' : ''), onclick: () => this.use(s) }, icon('check', 'sm'), 'Use as my screensaver'));
  }

  renderNote() {
    const st = this.app.settings;
    const pick = st.screensaverPick && st.screensaverPick !== 'random' ? this.find(st.screensaverPick) : null;
    clear(this.note).append(
      icon('saver', 'sm'),
      st.screensaverOn
        ? h('span', {}, `The screensaver is on: ${pick ? `“${pick.name}”` : 'a random one'} after ${st.screensaverMin || 10} min of not using the PC.`)
        : h('span', {}, 'The screensaver is off.'),
      h('button', { class: 'btn sm ghost', onclick: () => this.app.showPanel('settings') }, 'Settings → Screensaver'),
      !st.screensaverOn ? h('button', { class: 'btn sm', onclick: () => this.turnOn() }, 'Turn it on') : null);
  }

  // ---------------------------------------------------------------- the right side: settings and layers
  renderInsp() {
    const s = this.cur;
    const y = this.insp.scrollTop;
    const L = s.layers.find((x) => x.id === this.sel) || null;
    const body = h('fieldset', { class: 'saver-fields' },
      h('div', { class: 'saver-sec' }, 'Whole screen'),
      ...this.controls(SAVER_PARAMS, s),
      h('div', { class: 'saver-sec row' }, h('span', {}, 'Layers'), h('div', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: (e) => this.addMenu(e.currentTarget) }, icon('plus', 'sm'), 'Add'),
        h('button', { class: 'icon-btn', 'data-tip': 'Add a random layer', onclick: () => this.addLayer(randomLayer(pickType())) }, icon('dice', 'sm'))),
      h('div', { class: 'saver-layers' }, ...[...s.layers].reverse().map((x) => this.layerRow(x))),
      !s.layers.length ? h('div', { class: 'faint saver-empty' }, 'No layers: just the background. Add one above.') : null,
      L ? h('div', { class: 'saver-sec row' }, icon(LAYERS[L.type].icon, 'sm'), h('span', {}, LAYERS[L.type].name), h('div', { class: 'grow' }),
        L.type !== 'code' ? h('button', { class: 'btn sm ghost', 'data-tip': 'Roll this layer’s settings at random', onclick: () => this.shuffle(L) }, icon('dice', 'sm'), 'Shuffle') : null) : null,
      ...(L ? this.controls(LAYERS[L.type].params, L) : []),
      L ? h('div', { class: 'saver-sub' }, 'Effects') : null,
      ...(L ? this.controls(COMMON, L) : []));
    clear(this.insp).append(
      s.from ? h('div', { class: 'saver-banner' }, h('span', {}, 'An example: change anything and it’s saved as yours.'),
        h('button', { class: 'btn sm primary', onclick: () => this.edited() }, 'Make it yours')) : null,
      body);
    this.insp.scrollTop = y;
  }

  layerRow(L) {
    const s = this.cur, i = s.layers.indexOf(L);
    const move = (d) => { const i = s.layers.findIndex((x) => x.id === L.id), j = i + d; if (i < 0 || j < 0 || j >= s.layers.length) return; s.layers.splice(j, 0, s.layers.splice(i, 1)[0]); this.restack(); };
    const el = h('div', { class: 'saver-layer-row' + (L.id === this.sel ? ' active' : '') + (L.on === false ? ' off' : ''),
      onclick: () => { this.sel = L.id; this.renderInsp(); },
      oncontextmenu: (e) => contextMenu(e, [
        { label: 'Duplicate', icon: 'copy', action: () => this.addLayer({ ...clone(L), id: newLayer(L.type).id }) },
        { label: L.on === false ? 'Show' : 'Hide', icon: L.on === false ? 'eye' : 'eye-off', action: () => { L.on = L.on === false; this.edited(); this.renderInsp(); } },
        { label: 'Delete', icon: 'trash', action: () => this.removeLayer(L) },
      ]) },
    h('button', { class: 'icon-btn', 'data-tip': L.on === false ? 'Show' : 'Hide', onclick: (e) => { e.stopPropagation(); L.on = L.on === false; this.edited(); this.renderInsp(); } }, icon(L.on === false ? 'eye-off' : 'eye', 'sm')),
    icon(LAYERS[L.type].icon, 'sm'),
    h('span', { class: 'saver-layer-name' }, LAYERS[L.type].name + (this.codeErrors.has(L.id) ? ' ⚠' : '')),
    h('button', { class: 'icon-btn', 'data-tip': 'Up (in front)', disabled: i === s.layers.length - 1, onclick: (e) => { e.stopPropagation(); move(1); } }, icon('arrow-up', 'sm')),
    h('button', { class: 'icon-btn', 'data-tip': 'Down (behind)', disabled: i === 0, onclick: (e) => { e.stopPropagation(); move(-1); } }, icon('arrow-down', 'sm')),
    h('button', { class: 'icon-btn', 'data-tip': 'Delete', onclick: (e) => { e.stopPropagation(); this.removeLayer(L); } }, icon('trash', 'sm')));
    return el;
  }

  addMenu(anchor) {
    showMenu(LAYER_ORDER.map((t) => ({ label: LAYERS[t].name, icon: LAYERS[t].icon, action: () => this.addLayer(newLayer(t)) })), { anchor });
  }

  addLayer(L) {
    this.cur.layers.push(L);
    this.sel = L.id;
    this.restack();
  }

  removeLayer(L) {
    // by id: the row's layer may not be the very object in the list any more
    const s = this.cur, at = s.layers.findIndex((x) => x.id === L.id);
    if (at < 0) return;
    L = s.layers.splice(at, 1)[0];
    if (this.sel === L.id) this.sel = s.layers[Math.min(at, s.layers.length - 1)]?.id || null;
    this.restack();
    toast(`Removed ${LAYERS[L.type].name}`, { action: { label: 'Undo', fn: () => { s.layers.splice(at, 0, L); this.sel = L.id; this.restack(); } } });
  }

  shuffle(L) {
    const r = randomLayer(L.type);
    for (const p of LAYERS[L.type].params) if (p.kind !== 'image' && p.kind !== 'code') L[p.key] = r[p.key];
    this.edited();
    this.renderInsp();
  }

  /** Controls for a list of params on obj (the screensaver or a layer). Changes show in the preview straight away. */
  controls(params, obj) {
    return params.filter((p) => !p.when || p.when(obj)).map((p) => {
      const set = (v, redraw) => { obj[p.key] = v; this.edited(); if (redraw) this.renderInsp(); };
      const label = h('span', { class: 'saver-label' }, p.label);
      switch (p.kind) {
        case 'range': {
          const fmt = (v) => `${Math.round(v * 100) / 100}${p.unit || ''}`;
          const out = h('span', { class: 'saver-val mono' }, fmt(obj[p.key] ?? p.def));
          const r = h('input', { type: 'range', min: String(p.min), max: String(p.max), step: String(p.step), value: String(obj[p.key] ?? p.def) });
          r.addEventListener('input', () => { out.textContent = fmt(Number(r.value)); set(Number(r.value)); });
          r.addEventListener('dblclick', () => { r.value = String(p.def); out.textContent = fmt(p.def); set(p.def); });
          return h('label', { class: 'saver-ctl', title: 'Double-click the slider to put it back' }, label, r, out);
        }
        case 'color': {
          const c = h('input', { type: 'color', value: obj[p.key] || p.def });
          c.addEventListener('input', () => set(c.value));
          return h('label', { class: 'saver-ctl' }, label, c);
        }
        case 'check': {
          const cb = h('input', { type: 'checkbox', checked: !!obj[p.key] });
          cb.addEventListener('change', () => set(cb.checked, params.some((q) => q.when)));
          return h('label', { class: 'check saver-check' }, cb, p.label);
        }
        case 'select': {
          const el = h('select', {}, p.options.map(([v, l]) => h('option', { value: String(v) }, l)));
          el.value = String(obj[p.key] ?? p.def);
          el.addEventListener('change', () => set(typeof p.options[0][0] === 'number' ? Number(el.value) : el.value, params.some((q) => q.when)));
          return h('label', { class: 'saver-ctl' }, label, el);
        }
        case 'text': {
          const t = h('input', { type: 'text', class: 'input', value: obj[p.key] ?? '', maxlength: '400', spellcheck: 'false' });
          t.addEventListener('input', () => set(t.value));
          return h('label', { class: 'saver-ctl wide' }, label, t);
        }
        case 'image': {
          const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
          file.addEventListener('change', async () => {
            const f = file.files?.[0];
            if (!f) return;
            try { set(await shrinkPicture(f), true); } catch (e) { toast(e.message, { type: 'error' }); }
          });
          return h('div', { class: 'saver-ctl wide' }, label,
            h('div', { class: 'row saver-pic' },
              obj[p.key] ? h('img', { class: 'saver-thumb', src: obj[p.key], alt: '' }) : null,
              h('button', { class: 'btn sm', onclick: () => file.click() }, icon('image', 'sm'), obj[p.key] ? 'Change…' : 'Choose a picture…'),
              obj[p.key] ? h('button', { class: 'btn sm ghost', onclick: () => set(null, true) }, icon('x', 'sm'), 'Remove') : null,
              file));
        }
        case 'code': {
          const ta = h('textarea', { class: 'saver-code mono', spellcheck: 'false', rows: '14' });
          ta.value = obj[p.key] ?? '';
          let tm = null;
          ta.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => set(ta.value), 350); });
          ta.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab') return;
            e.preventDefault();
            const a = ta.selectionStart;
            ta.setRangeText('  ', a, ta.selectionEnd, 'end');
            ta.dispatchEvent(new Event('input'));
          });
          const err = this.codeErrors.get(obj.id);
          return h('div', { class: 'saver-ctl wide' }, label, ta,
            h('div', { class: 'saver-code-err mono', dataset: { codeErr: obj.id }, hidden: !err }, err || ''),
            h('div', { class: 'faint saver-hint' }, 'It runs in a sealed-off frame: it can draw, but can’t reach your files or the app.'));
        }
        default: return null;
      }
    }).filter(Boolean);
  }

  status() {
    if (!this.cur) return { left: [], right: [] };
    const n = this.cur.layers.length;
    return { left: [{ text: this.cur.name + (this.cur.from ? ' (example)' : '') }], right: [{ text: `${n} layer${n === 1 ? '' : 's'}` }] };
  }

  onShow() { if (this.cur && !this.player) this.startPlayer(); }
  onHide() { this.player?.destroy(); this.player = null; }
  destroy() {
    this.player?.destroy(); this.player = null;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.app.saveSettings({ screensavers: clone(this.list) }); this.app.redrawSaverSettings?.(); }
  }
}

const pickType = () => { const pool = LAYER_ORDER.filter((t) => t !== 'code' && t !== 'picture'); return pool[Math.floor(Math.random() * pool.length)]; };
