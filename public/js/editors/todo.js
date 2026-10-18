// Todo: to-do lists, kept in data/todos.json. Lists down the side; in each, tasks with a star, a due date and a
// done tick. Drag the grip to reorder, or onto another list to move a task there. Done tasks sink to the bottom.

import { BaseEditor } from './base.js';
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { toast, confirmDialog, promptDialog, contextMenu } from '../core/ui.js';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const T = () => ({ 'X-BDS-Token': api.token });
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export class TodoEditor extends BaseEditor {
  static mode = 'todo';

  async load() {
    this.showDone = true;
    this.root = h('div', { class: 'todo-root' });
    this.pane.append(this.root);
    const d = await fetch('/api/todos', { headers: T() }).then((r) => r.json()).catch(() => ({ lists: [] }));
    this.lists = d.lists || [];
    if (!this.lists.length) this.lists.push({ id: uid(), name: 'To do', items: [] });
    this.active = this.lists.some((l) => l.id === d.active) ? d.active : this.lists[0].id;
    this.render();
  }

  get list() { return this.lists.find((l) => l.id === this.active) || this.lists[0]; }

  /** Saves a moment after the last change (and right away when the tab closes). */
  save(now = false) {
    clearTimeout(this.saveTimer);
    const run = () => fetch('/api/todos', { method: 'POST', headers: { ...T(), 'Content-Type': 'application/json' }, body: JSON.stringify({ lists: this.lists, active: this.active }) })
      .then((r) => { if (!r.ok) throw new Error(); }).catch(() => toast('Couldn’t save your todo lists.', { type: 'error' }));
    if (now) return run();
    this.saveTimer = setTimeout(run, 400);
  }

  changed({ lists = true } = {}) {
    this.save();
    if (lists) this.renderLists();
    this.refreshStatus();
  }

  render() {
    clear(this.root).append(
      this.side = h('div', { class: 'todo-side' }),
      this.main = h('div', { class: 'todo-main' }));
    this.renderLists();
    this.renderMain();
  }

  // ---------------------------------------------------------------- the lists
  renderLists() {
    const left = (l) => l.items.filter((x) => !x.done).length;
    clear(this.side).append(
      h('div', { class: 'clock-sec-title todo-side-title' }, 'Lists'),
      ...this.lists.map((l) => {
        const row = h('div', { class: 'todo-list' + (l.id === this.active ? ' active' : ''), title: 'Double-click to rename · right-click for more',
          onclick: () => { if (this.active === l.id) return; this.active = l.id; this.save(); this.render(); this.refreshStatus(); },
          ondblclick: () => this.renameList(l),
          oncontextmenu: (e) => contextMenu(e, [
            { label: 'Rename…', icon: 'edit', action: () => this.renameList(l) },
            { label: 'Delete list', icon: 'trash', action: () => this.deleteList(l) },
          ]) },
        icon('list-check', 'sm'), h('span', { class: 'todo-list-name' }, l.name), h('span', { class: 'todo-count mono' }, left(l) || ''));
        // drop a task here to move it to this list
        row.addEventListener('dragover', (e) => { if (this.dragging && l.id !== this.active) { e.preventDefault(); row.classList.add('drop'); } });
        row.addEventListener('dragleave', () => row.classList.remove('drop'));
        row.addEventListener('drop', (e) => {
          e.preventDefault(); row.classList.remove('drop');
          const it = this.dragging; if (!it || l.id === this.active) return;
          this.list.items.splice(this.list.items.indexOf(it), 1);
          l.items.unshift(it);
          this.dragging = null;
          this.changed(); this.renderMain();
          toast(`Moved to ${l.name}`, { type: 'ok' });
        });
        return row;
      }),
      h('button', { class: 'btn sm ghost todo-new-list', onclick: () => this.newList() }, icon('plus', 'sm'), 'New list'));
  }

  async newList() {
    const name = (await promptDialog('New list', 'Name', '', { placeholder: 'e.g. Groceries' }) || '').trim();
    if (!name) return;
    const l = { id: uid(), name, items: [] };
    this.lists.push(l);
    this.active = l.id;
    this.save(); this.render(); this.refreshStatus();
    this.addInput?.focus();
  }

  async renameList(l) {
    const name = (await promptDialog('Rename list', 'Name', l.name) || '').trim();
    if (!name || name === l.name) return;
    l.name = name;
    this.changed(); this.renderMain();
  }

  async deleteList(l) {
    if (l.items.length && !(await confirmDialog(`Delete “${l.name}”?`, `Its ${l.items.length} task${l.items.length === 1 ? '' : 's'} go with it.`, { okLabel: 'Delete', danger: true }))) return;
    const at = this.lists.indexOf(l);
    this.lists.splice(at, 1);
    if (!this.lists.length) this.lists.push({ id: uid(), name: 'To do', items: [] });
    if (this.active === l.id) this.active = this.lists[Math.max(0, at - 1)].id;
    this.save(); this.render(); this.refreshStatus();
    toast(`Deleted ${l.name}`, { action: { label: 'Undo', fn: () => { this.lists.splice(at, 0, l); this.active = l.id; this.save(); this.render(); this.refreshStatus(); } } });
  }

  // ---------------------------------------------------------------- the tasks
  renderMain() {
    const l = this.list;
    const open = l.items.filter((x) => !x.done), done = l.items.filter((x) => x.done);
    this.addInput = h('input', { type: 'text', class: 'todo-add-input', placeholder: 'Add a task and press Enter', maxlength: '2000' });
    const addDue = h('input', { type: 'date', class: 'todo-date', title: 'Due date (optional)' });
    const add = () => {
      const text = this.addInput.value.trim();
      if (!text) return;
      l.items.splice(open.length ? l.items.indexOf(open[open.length - 1]) + 1 : 0, 0, { id: uid(), text, done: false, star: false, due: addDue.value || null, created: Date.now(), doneAt: null });
      this.changed(); this.renderMain();
      this.addInput.focus();
    };
    this.addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

    clear(this.main).append(
      h('div', { class: 'todo-head' },
        h('div', { class: 'todo-title' }, l.name),
        h('span', { class: 'faint mono' }, done.length ? `${done.length}/${l.items.length} done` : l.items.length ? `${l.items.length} to do` : ''),
        h('div', { class: 'grow' }),
        done.length ? h('button', { class: 'btn sm ghost', onclick: () => this.clearDone() }, icon('trash', 'sm'), 'Clear done') : null),
      h('div', { class: 'todo-add' }, icon('plus', 'sm'), this.addInput, addDue,
        h('button', { class: 'btn sm', onclick: add }, 'Add')),
      h('div', { class: 'todo-items' }, open.map((x) => this.row(x))),
      !l.items.length ? h('div', { class: 'todo-empty' }, icon('list-check'), h('div', {}, 'Nothing here yet. Type a task above and press Enter.')) : null,
      done.length ? h('button', { class: 'todo-done-head', onclick: () => { this.showDone = !this.showDone; this.renderMain(); } },
        icon(this.showDone ? 'chevron-down' : 'chevron-right', 'sm'), `Done (${done.length})`) : null,
      done.length && this.showDone ? h('div', { class: 'todo-items done' }, done.map((x) => this.row(x))) : null);
    setTimeout(() => { if (this.tab === this.app.active && !this.main.contains(document.activeElement)) this.addInput.focus(); }, 0);
  }

  row(x) {
    const l = this.list;
    const text = h('input', { type: 'text', class: 'todo-text', value: x.text, maxlength: '2000', spellcheck: 'true' });
    text.addEventListener('change', () => { const v = text.value.trim(); if (!v) return this.remove(x); x.text = v; this.changed({ lists: false }); });
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { text.blur(); if (e.key === 'Escape') text.value = x.text; } });
    const due = h('input', { type: 'date', class: 'todo-date' + (x.due ? '' : ' empty'), value: x.due || '', title: 'Due date' });
    due.addEventListener('change', () => { x.due = due.value || null; this.changed({ lists: false }); this.renderMain(); });
    const when = x.due && !x.done ? (x.due < today() ? 'late' : x.due === today() ? 'today' : '') : '';
    const grip = h('span', { class: 'todo-grip', title: 'Drag to reorder, or onto a list to move it' }, icon('grip', 'sm'));
    const el = h('div', { class: `todo-item${x.done ? ' is-done' : ''}${x.star ? ' starred' : ''}${when ? ' ' + when : ''}` },
      grip,
      h('button', { class: 'todo-check', title: x.done ? 'Not done' : 'Done', onclick: () => this.toggle(x) }, x.done ? icon('check', 'sm') : null),
      text,
      due,
      h('button', { class: 'icon-btn todo-star', 'data-tip': x.star ? 'Unstar' : 'Star', onclick: () => { x.star = !x.star; this.changed({ lists: false }); this.renderMain(); } }, icon('star', 'sm')),
      h('button', { class: 'icon-btn todo-del', 'data-tip': 'Delete', onclick: () => this.remove(x) }, icon('x', 'sm')));
    el.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: x.done ? 'Mark not done' : 'Mark done', icon: 'check', action: () => this.toggle(x) },
      { label: x.star ? 'Unstar' : 'Star', icon: 'star', action: () => { x.star = !x.star; this.changed({ lists: false }); this.renderMain(); } },
      { label: 'Due today', icon: 'calendar', action: () => { x.due = today(); this.changed({ lists: false }); this.renderMain(); } },
      x.due ? { label: 'Clear due date', icon: 'calendar', action: () => { x.due = null; this.changed({ lists: false }); this.renderMain(); } } : null,
      ...(this.lists.length > 1 ? [{ label: 'Move to', icon: 'arrow-right', submenu: this.lists.filter((o) => o !== l).map((o) => ({ label: o.name, action: () => {
        l.items.splice(l.items.indexOf(x), 1); o.items.unshift(x); this.changed(); this.renderMain();
      } })) }] : []),
      { label: 'Copy text', icon: 'copy', action: () => navigator.clipboard.writeText(x.text) },
      { label: 'Delete', icon: 'trash', action: () => this.remove(x) },
    ].filter(Boolean)));

    // drag by the grip: reorder within the list, or drop on a list at the side
    grip.addEventListener('pointerdown', () => { el.draggable = true; });
    el.addEventListener('dragstart', (e) => { this.dragging = x; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', x.text); });
    el.addEventListener('dragend', () => { el.draggable = false; el.classList.remove('dragging'); this.dragging = null; this.main.querySelectorAll('.drop-above, .drop-below').forEach((n) => n.classList.remove('drop-above', 'drop-below')); });
    el.addEventListener('dragover', (e) => {
      const it = this.dragging;
      if (!it || it === x || it.done !== x.done) return;
      e.preventDefault();
      const below = e.offsetY > el.offsetHeight / 2;
      el.classList.toggle('drop-below', below); el.classList.toggle('drop-above', !below);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-above', 'drop-below'));
    el.addEventListener('drop', (e) => {
      const it = this.dragging;
      if (!it || it === x) return;
      e.preventDefault();
      const below = el.classList.contains('drop-below');
      l.items.splice(l.items.indexOf(it), 1);
      l.items.splice(l.items.indexOf(x) + (below ? 1 : 0), 0, it);
      this.dragging = null;
      this.changed({ lists: false }); this.renderMain();
    });
    return el;
  }

  toggle(x) {
    x.done = !x.done;
    x.doneAt = x.done ? Date.now() : null;
    const items = this.list.items;
    items.splice(items.indexOf(x), 1);
    // where the open tasks end and the done ones start: done goes on top of the done pile, undone to the end of the open ones
    const firstDone = items.findIndex((o) => o.done);
    items.splice(firstDone < 0 ? items.length : firstDone, 0, x);
    this.changed(); this.renderMain();
  }

  remove(x) {
    const l = this.list, at = l.items.indexOf(x);
    if (at < 0) return;
    l.items.splice(at, 1);
    this.changed(); this.renderMain();
    toast('Task deleted', { action: { label: 'Undo', fn: () => { l.items.splice(at, 0, x); this.changed(); this.renderMain(); } } });
  }

  clearDone() {
    const l = this.list, before = l.items.slice();
    const n = before.filter((x) => x.done).length;
    l.items = l.items.filter((x) => !x.done);
    this.changed(); this.renderMain();
    toast(`Cleared ${n} done task${n === 1 ? '' : 's'}`, { action: { label: 'Undo', fn: () => { l.items = before; this.changed(); this.renderMain(); } } });
  }

  status() {
    if (!this.lists) return { left: [], right: [] };
    const open = this.list.items.filter((x) => !x.done);
    const late = open.filter((x) => x.due && x.due < today()).length;
    return { left: [{ text: this.list.name }], right: [{ text: `${open.length} to do${late ? ` · ${late} overdue` : ''}` }] };
  }

  focus() { this.addInput?.focus(); }
  destroy() { if (this.saveTimer) { clearTimeout(this.saveTimer); this.save(true); } }
}
