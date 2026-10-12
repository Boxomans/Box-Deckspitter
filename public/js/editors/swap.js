// BoxSwap: hot-swap sets of files in any folder. Pick a folder (a game's Mods folder, say), make profiles of
// files for it, and switch which one is in. The moving and the safety rules live in swap-server.js.

import { BaseEditor } from './base.js';
import { h, clear, formatBytes } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { showMenu, toast, errorToast, confirmDialog, promptDialog, modal } from '../core/ui.js';
import { api } from '../core/api.js';
import { pickFolder, pickOpen } from '../core/files.js';

export class SwapEditor extends BaseEditor {
  static mode = 'swap';

  async load() {
    this.storeEl = h('div', { class: 'bs-store' });
    this.listEl = h('div', { class: 'bs-targets' });
    this.detailEl = h('div', { class: 'bs-detail' });
    this.root = h('div', { class: 'sp-root' }, h('div', { class: 'sp-inner' },
      h('div', { class: 'sp-head' },
        h('div', { class: 'klep-title' }, h('span', { class: 'g bs-g' }, this.app.toolLabel('BoxSwap')), h('span', { class: 'klep-cursor' })),
        h('div', { class: 'klep-sub mono' }, '> hot-swap sets of files in any folder'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => this.addTarget() }, icon('folder-plus', 'sm'), 'Add a folder…'),
          h('button', { class: 'btn', onclick: () => this.refresh() }, icon('refresh', 'sm'), 'Refresh'))),
      this.storeEl,
      h('div', { class: 'bs-body' }, this.listEl, this.detailEl)));
    this.pane.append(this.root);
    await this.refresh();
  }

  get store() { return this.app.settings.swapStore || null; }
  post(op, body = {}) { return api.post(`/api/swap/${op}`, { store: this.store, ...body }); }

  async refresh() {
    try { this.state = await this.post('state'); } catch (e) { errorToast(e); return; }
    const ids = this.state.targets.map((t) => t.id);
    if (!ids.includes(this.sel)) this.sel = ids.includes(this.app.settings.swapTarget) ? this.app.settings.swapTarget : ids[0] || null;
    this.render();
  }

  select(id) {
    this.sel = id;
    this.app.saveSettings({ swapTarget: id });
    this.render();
  }

  current() { return this.state?.targets.find((t) => t.id === this.sel) || null; }

  render() {
    const s = this.state;
    clear(this.storeEl).append(
      icon('layers', 'sm'), h('span', { class: 'faint' }, 'Master folder'),
      h('b', { class: 'mono bs-path', title: s.store }, s.store), s.isDefault ? h('span', { class: 'bs-pill' }, 'default') : null,
      h('div', { class: 'grow' }),
      h('button', { class: 'btn sm ghost', onclick: () => api.mkdir(s.store).then(() => api.reveal(s.store)).catch(errorToast) }, icon('external', 'sm'), 'Open'),
      h('button', { class: 'btn sm ghost', onclick: () => this.changeStore() }, 'Change…'),
      s.isDefault ? null : h('button', { class: 'btn sm ghost', onclick: () => this.setStore(null) }, 'Use default'));

    clear(this.listEl);
    if (!s.targets.length) {
      this.listEl.append(h('div', { class: 'bs-empty' },
        h('b', {}, 'No folders yet'),
        h('p', {}, 'Add a folder you want to swap files in, like a game’s Mods or Data folder. Then make profiles for it: each one is a set of files laid out exactly as they go in that folder.'),
        h('button', { class: 'btn primary', onclick: () => this.addTarget() }, icon('folder-plus', 'sm'), 'Add a folder…')));
      clear(this.detailEl);
      this.refreshStatus();
      return;
    }
    for (const t of s.targets) {
      const card = h('button', { class: `bs-target ${t.id === this.sel ? 'sel' : ''} ${t.exists ? '' : 'gone'}`, title: t.description ? `${t.target}\n${t.description}` : t.target, onclick: () => this.select(t.id) },
        icon('folder', 'sm'),
        h('div', { class: 'bs-target-name' }, h('b', {}, t.id), h('span', { class: 'mono' }, t.target)),
        h('span', { class: `bs-pill ${t.active ? 'on' : ''}` }, t.active || 'off'));
      card.addEventListener('contextmenu', (e) => { e.preventDefault(); this.select(t.id); showMenu(this.targetMenu(t), { x: e.clientX, y: e.clientY }); });
      this.listEl.append(card);
    }
    this.renderDetail();
    this.refreshStatus();
  }

  renderDetail() {
    const t = this.current();
    clear(this.detailEl);
    if (!t) return;
    const warn = [];
    if (t.problem) warn.push(h('div', { class: 'bs-warn' }, icon('alert', 'sm'), t.problem));
    if (!t.exists) warn.push(h('div', { class: 'bs-warn' }, icon('alert', 'sm'), `The folder ${t.target} isn’t there. Plug the drive back in (or forget this folder).`));
    else if (!t.sameDrive) warn.push(h('div', { class: 'bs-note' }, icon('info', 'sm'), 'This folder is on a different drive from the master folder, so switching copies files instead of moving them instantly. Big profiles take a while. A master folder on the same drive makes it instant.'));
    const offRow = h('div', { class: `bs-prof ${t.active ? '' : 'on'}` },
      h('span', { class: 'bs-dot' }),
      h('div', { class: 'bs-prof-name' }, h('b', {}, 'Off'), h('span', {}, t.active ? 'the folder as it was, without any profile' : 'no profile in: the folder is as it was')),
      t.active ? h('button', { class: 'btn sm', onclick: () => this.switchTo(null) }, 'Switch off') : h('span', { class: 'bs-pill on' }, 'current'));
    const rows = t.profiles.map((p) => {
      const more = h('button', { class: 'btn sm ghost icon-only', title: 'More' }, icon('more', 'sm'));
      more.addEventListener('click', () => showMenu(this.profileMenu(t, p), { anchor: more }));
      const row = h('div', { class: `bs-prof ${p.active ? 'on' : ''}`, title: p.description || '' },
        h('span', { class: 'bs-dot' }),
        h('div', { class: 'bs-prof-name' }, h('b', {}, p.name),
          h('span', {}, p.files ? `${p.files} file${p.files === 1 ? '' : 's'} · ${formatBytes(p.bytes)}${p.active ? ' · in the folder now' : ''}` : 'empty: open its folder and put files in')),
        p.active ? h('span', { class: 'bs-pill on' }, 'current') : h('button', { class: 'btn sm primary', disabled: !t.exists || !p.files, onclick: () => this.switchTo(p.name) }, icon('swap', 'sm'), 'Switch to'),
        more);
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(this.profileMenu(t, p), { x: e.clientX, y: e.clientY }); });
      return row;
    });
    const forget = h('button', { class: 'btn sm ghost', title: 'Stop managing this folder (its profiles are kept in the master folder’s .removed folder)', disabled: !!t.active, onclick: () => this.forget(t) }, 'Forget folder…');
    this.detailEl.append(
      h('div', { class: 'bs-detail-head' },
        h('div', { class: 'bs-detail-title' }, h('b', {}, t.id), h('span', { class: 'mono' }, t.target)),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn sm ghost', onclick: () => api.reveal(t.target) }, icon('external', 'sm'), 'Open folder'),
        h('button', { class: 'btn sm ghost', onclick: () => api.reveal(t.dir) }, icon('layers', 'sm'), 'Open profiles'),
        forget),
      ...warn,
      h('div', { class: 'bs-profs' }, offRow, ...rows),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => this.newProfile() }, icon('plus', 'sm'), 'New profile…')),
      h('p', { class: 'bs-help' }, 'A profile’s files go in the folder at the same place they sit in the profile: ', h('span', { class: 'mono' }, `${t.id}\\Profile\\textures\\a.dds`), ' lands at ', h('span', { class: 'mono' }, `${t.target}\\textures\\a.dds`),
        '. Switching takes the current profile’s files back out (with any changes made while it was in) and puts the folder’s own files back before the next profile goes in. Files the folder had that a profile replaces are kept safe until you switch off.'));
  }

  // ---- menus (the ⋯ button and right-click): the description, if there is one, sits at the bottom

  targetMenu(t) {
    return [
      { label: 'Set description…', icon: 'edit-text', action: () => this.describe(t) },
      { label: 'Open folder', icon: 'external', action: () => api.reveal(t.target) },
      { label: 'Open profiles', icon: 'layers', action: () => api.reveal(t.dir) },
      { label: 'New profile…', icon: 'plus', action: () => { this.select(t.id); this.newProfile(); } },
      { sep: true },
      { label: 'Forget folder…', icon: 'trash', disabled: !!t.active, action: () => this.forget(t) },
      ...(t.description ? [{ sep: true }, { note: t.description }] : []),
    ];
  }

  profileMenu(t, p) {
    return [
      { label: 'Set description…', icon: 'edit-text', action: () => this.describe(t, p) },
      { label: 'Add files…', icon: 'file-plus', disabled: p.active, action: () => this.importInto(p, 'files') },
      { label: 'Add a folder…', icon: 'folder-plus', disabled: p.active, action: () => this.importInto(p, 'folder') },
      { label: 'Open its folder', icon: 'external', action: () => api.reveal(`${t.dir}\\${p.name}`) },
      { label: 'Rename…', icon: 'edit-text', action: () => this.renameProfile(p) },
      { sep: true },
      { label: 'Remove…', icon: 'trash', disabled: p.active, action: () => this.deleteProfile(p) },
      ...(p.description ? [{ sep: true }, { note: p.description }] : []),
    ];
  }

  async describe(t, p = null) {
    const text = await promptDialog(p ? `Description of “${p.name}”` : `Description of ${t.id}`, 'Shown at the bottom of its right-click menu. Leave it empty to clear it.', (p ? p.description : t.description) || '', { placeholder: p ? 'e.g. 4K textures + ENB, needs 12 GB VRAM' : 'e.g. Skyrim SE Data folder' });
    if (text == null) return;
    try { await this.post('describe', { id: t.id, name: p?.name, text }); this.refresh(); } catch (e) { errorToast(e); }
  }

  // ---- actions

  async changeStore() {
    const p = await pickFolder({ title: 'Master folder for BoxSwap profiles', initialDir: this.state?.store });
    if (p) this.setStore(p);
  }

  async setStore(p) {
    if (this.state?.targets.some((t) => t.active)) {
      const ok = await confirmDialog('Change the master folder?', 'Profiles that are switched on stay on (their files stay in their folders). BoxSwap only sees them again when you come back to this master folder.', { okLabel: 'Change' });
      if (!ok) return;
    }
    await this.app.saveSettings({ swapStore: p });
    this.refresh();
  }

  async addTarget() {
    const p = await pickFolder({ title: 'Which folder do you want to swap files in?' });
    if (!p) return;
    try {
      const t = await this.post('add', { target: p });
      await this.refresh();
      this.select(t.id);
      if (!t.profiles.length) this.newProfile();
    } catch (e) { errorToast(e); }
  }

  async newProfile() {
    const t = this.current();
    if (!t) return;
    const name = await promptDialog('New profile', `A set of files for ${t.id}`, '', { placeholder: 'e.g. Vanilla+, Heavy graphics, Co-op' });
    if (!name?.trim()) return;
    try {
      const r = await this.post('profile/new', { id: t.id, name: name.trim() });
      await this.refresh();
      const choice = await modal({
        title: `“${name.trim()}” is ready`,
        body: h('div', {}, h('p', {}, 'Fill it with the files it should put in the folder, laid out the way they go there.'), h('p', { class: 'faint' }, 'You can add more any time from its ⋯ menu, or straight into its folder.')),
        buttons: [{ label: 'Later', value: null, ghost: true }, { label: 'Open its folder', value: 'open' }, { label: 'Add files…', value: 'files', primary: true }],
      });
      if (choice === 'open') api.reveal(r.path);
      else if (choice === 'files') this.importInto({ name: name.trim() }, 'files');
    } catch (e) { errorToast(e); }
  }

  async importInto(p, kind) {
    const t = this.current();
    const paths = kind === 'folder'
      ? [await pickFolder({ title: `Add a folder to “${p.name}”` })].filter(Boolean)
      : await pickOpen({ multi: true, title: `Add files to “${p.name}”`, filters: [{ name: 'All files', extensions: ['*'] }] });
    if (!paths?.length) return;
    try {
      const r = await this.post('profile/import', { id: t.id, name: p.name, paths });
      toast(`Added ${r.added} to ${p.name}`, { type: 'ok' });
      this.refresh();
    } catch (e) { errorToast(e); }
  }

  async renameProfile(p) {
    const to = await promptDialog('Rename profile', '', p.name);
    if (!to?.trim() || to.trim() === p.name) return;
    try { await this.post('profile/rename', { id: this.sel, name: p.name, to: to.trim() }); this.refresh(); } catch (e) { errorToast(e); }
  }

  async deleteProfile(p) {
    if (!(await confirmDialog(`Remove “${p.name}”?`, `Nothing is deleted: its folder and ${p.files} file${p.files === 1 ? '' : 's'} move into .removed beside the profiles. Delete them from there yourself when you’re sure.`, { okLabel: 'Remove' }))) return;
    try { await this.post('profile/delete', { id: this.sel, name: p.name }); this.refresh(); } catch (e) { errorToast(e); }
  }

  async forget(t) {
    if (!(await confirmDialog(`Forget ${t.id}?`, `BoxSwap stops managing ${t.target}. The folder itself isn’t touched, and nothing is deleted: its profiles (${t.profiles.length}) move into .removed in the master folder.`, { okLabel: 'Forget' }))) return;
    try { await this.post('forget', { id: t.id }); this.refresh(); } catch (e) { errorToast(e); }
  }

  async switchTo(name) {
    const t = this.current();
    if (!t || this.switching) return;
    let plan;
    try { plan = await this.post('plan', { id: t.id, to: name }); } catch (e) { errorToast(e); return; }
    const n = (x, w) => `${x} ${w}${x === 1 ? '' : 's'}`;
    const lines = [];
    if (plan.from) lines.push(`${n(plan.remove, 'file')} of “${plan.from}” go back to its profile folder${plan.changed.length ? ` (${plan.changed.length} changed while it was in: the changes are kept)` : ''}.`);
    if (plan.restore) lines.push(`${n(plan.restore, 'original file')} of the folder come${plan.restore === 1 ? 's' : ''} back.`);
    if (plan.to) lines.push(`${n(plan.add, 'file')} of “${plan.to}” go into the folder.`);
    if (plan.replace.length) lines.push(`${n(plan.replace.length, 'file')} already in the folder get${plan.replace.length === 1 ? 's' : ''} set aside until you switch off: ${plan.replace.slice(0, 4).join(', ')}${plan.replace.length > 4 ? '…' : ''}`);
    if (!plan.sameDrive && plan.add + plan.remove > 0) lines.push('Different drives: files are copied, so this can take a while.');
    const ok = await confirmDialog(plan.to ? `Switch ${t.id} to “${plan.to}”?` : `Switch ${t.id} off?`,
      h('div', { class: 'bs-plan' }, h('ul', {}, ...lines.map((l) => h('li', {}, l))), h('p', { class: 'faint' }, 'Close the game or program using the folder first.')),
      { okLabel: plan.to ? 'Switch' : 'Switch off' });
    if (!ok) return;
    this.switching = true;
    const busy = toast(plan.to ? `Switching to ${plan.to}…` : 'Switching off…', { timeout: 0 });
    try {
      const r = await this.post('switch', { id: t.id, to: name });
      toast(plan.to ? `${t.id}: “${plan.to}” is in (${n(r.moved, 'file')} moved)` : `${t.id}: back to its own files`, { type: 'ok' });
    } catch (e) {
      errorToast(e);
    } finally {
      busy();
      this.switching = false;
      this.refresh();
    }
  }

  status() {
    const t = this.current();
    return {
      left: [{ text: t ? `${t.id} · ${t.active ? `“${t.active}” in` : 'off'} · ${t.profiles.length} profile${t.profiles.length === 1 ? '' : 's'}` : 'add a folder to start' }],
      right: [],
    };
  }
}
