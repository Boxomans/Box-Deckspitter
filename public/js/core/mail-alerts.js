// Email alerts (left sidebar): watch the inbox for key words or for mail from chosen senders. The server looks
// every couple of minutes (data/mail-watch.json); this side shows a count on the rail button, a toast (and a
// system notification when the app is in the background) for anything new, and the list in the panel.

import { api } from './api.js';
import { h, clear, timeAgo } from './dom.js';
import { icon } from './icons.js';
import { toast, contextMenu, showMenu } from './ui.js';

const POLL_MS = 30_000;
const who = (f) => f?.name || f?.address || 'someone';

export function createMailAlerts(app) {
  let state = { rules: [], alerts: [], unseen: 0, accounts: [], lastCheck: 0, error: '' };
  let known = null; // alert ids already shown, so a toast only comes once
  let host = null;
  let form = { kind: 'word', value: '', acct: '' };
  let busy = false;

  const button = () => document.querySelector('#rail .rail-btn[data-panel="alerts"]');
  const isOpen = () => app.panel === 'alerts' && host?.isConnected;

  function take(s) {
    state = s;
    badge();
    announce();
    if (isOpen()) render();
  }

  async function refresh() {
    try { take(await api.get('/api/mail/watch')); } catch { /* the server will be back */ }
  }

  function badge() {
    const b = button();
    if (!b) return;
    let el = b.querySelector('.rail-badge');
    const n = state.unseen;
    if (!n) { el?.remove(); b.title = 'Email alerts — key words and senders to watch for'; return; }
    if (!el) b.append((el = h('span', { class: 'rail-badge' })));
    el.textContent = n > 99 ? '99+' : String(n);
    b.title = `Email alerts — ${n} new`;
  }

  function announce() {
    const fresh = state.alerts.filter((a) => !a.seen && !known?.has(a.id));
    const first = !known;
    known = new Set(state.alerts.map((a) => a.id));
    if (first || !fresh.length || app.mainWindow === false) return; // other windows just show the count
    const one = fresh[0];
    const text = fresh.length === 1 ? `Email from ${who(one.from)}: ${one.subject}` : `${fresh.length} new emails you’re watching for`;
    toast(text, { timeout: 7000, action: { label: fresh.length === 1 ? 'Open' : 'Show', fn: () => (fresh.length === 1 ? open(one) : app.showPanel('alerts')) } });
    if (document.hidden || !document.hasFocus()) {
      try { new Notification(fresh.length === 1 ? `Email from ${who(one.from)}` : 'New emails', { body: fresh.length === 1 ? one.subject : text, silent: true }); } catch { /* ignore */ }
    }
  }

  async function post(url, json) {
    try { take(await api.post(url, json)); } catch (e) { toast(e.message, { type: 'error' }); }
  }
  const saveRules = (rules) => post('/api/mail/watch', { rules });

  async function open(a) {
    post('/api/mail/alerts', { action: 'seen', ids: [a.id] });
    const tab = await app.newDocument('mail');
    tab?.editor?.showMessage?.(a.acct, a.uid);
  }

  /** Add a rule from elsewhere (BoxMail's right-click menu). */
  function watchSender(address, acct = null) {
    const value = String(address || '').trim().toLowerCase();
    if (!value) return;
    if (state.rules.some((r) => r.kind === 'sender' && r.value.toLowerCase() === value)) { toast(`Already watching for mail from ${value}.`); return; }
    saveRules([...state.rules, { kind: 'sender', value, acct }]).then(() => toast(`You’ll get an alert when ${value} emails you.`, { type: 'ok', action: { label: 'Alerts', fn: () => app.showPanel('alerts') } }));
  }

  async function check() {
    if (busy) return;
    busy = true;
    if (isOpen()) render();
    try { take(await api.post('/api/mail/watch/check')); } catch (e) { toast(e.message, { type: 'error' }); }
    busy = false;
    if (isOpen()) render();
  }

  // ---------------------------------------------------------------- the panel

  function acctName(id) {
    const a = state.accounts.find((x) => x.id === id);
    return a ? a.address : '';
  }
  function ruleLabel(r) {
    return r.kind === 'sender' ? `from ${r.value}` : `“${r.value}”`;
  }

  function alertRow(a, rules) {
    const matched = (a.rules || []).map((id) => rules.get(id)).filter(Boolean);
    const row = h('button', { class: `ma-alert ${a.seen ? '' : 'new'}`, title: `${a.from?.address || ''}${a.address ? ' → ' + a.address : ''}` },
      h('div', { class: 'ma-alert-top' },
        h('span', { class: 'ma-from' }, who(a.from)),
        h('span', { class: 'ma-when faint mono' }, timeAgo(a.date || a.at))),
      h('div', { class: 'ma-subj' }, a.subject),
      matched.length ? h('div', { class: 'ma-tags' }, ...matched.map((r) => h('span', { class: 'ma-tag' }, ruleLabel(r)))) : null);
    row.addEventListener('click', () => open(a));
    row.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Open in BoxMail', icon: 'mail', action: () => open(a) },
      a.seen ? { label: 'Mark as new', icon: 'flag', action: () => post('/api/mail/alerts', { action: 'unseen', ids: [a.id] }) }
        : { label: 'Mark as seen', icon: 'check', action: () => post('/api/mail/alerts', { action: 'seen', ids: [a.id] }) },
      ...(a.from?.address ? [{ label: `Watch for mail from ${a.from.address}`, icon: 'bell', action: () => watchSender(a.from.address, a.acct) }] : []),
      { sep: true },
      { label: 'Remove', icon: 'x', action: () => post('/api/mail/alerts', { action: 'remove', ids: [a.id] }) },
    ]));
    return row;
  }

  function ruleRow(r) {
    const toggle = () => saveRules(state.rules.map((x) => (x.id === r.id ? { ...x, on: x.on === false } : x)));
    return h('div', { class: `ma-rule ${r.on === false ? 'off' : ''}` },
      h('span', { class: 'ma-rule-ico' }, icon(r.kind === 'sender' ? 'user' : 'search', 'sm')),
      h('div', { class: 'ma-rule-main' },
        h('span', { class: 'ma-rule-val' }, r.value),
        h('span', { class: 'ma-rule-sub faint' }, (r.kind === 'sender' ? 'sender' : 'words') + ' · ' + (r.acct ? acctName(r.acct) || 'removed account' : 'every account'))),
      h('button', { class: `icon-btn ${r.on === false ? '' : 'active'}`, 'data-tip': r.on === false ? 'Paused — click to watch again' : 'Watching — click to pause', onclick: toggle }, icon(r.on === false ? 'bell-off' : 'bell', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Stop watching', onclick: () => saveRules(state.rules.filter((x) => x.id !== r.id)) }, icon('x', 'sm')));
  }

  async function pickSender(anchor) {
    const acct = form.acct || state.accounts[0]?.id;
    if (!acct) return;
    let items = [];
    try { items = (await api.get(`/api/mail/list?acct=${encodeURIComponent(acct)}&box=inbox&limit=80`)).items || []; } catch (e) { toast(e.message, { type: 'error' }); return; }
    const seen = new Map();
    for (const m of items) for (const f of m.from || []) if (f.address && !seen.has(f.address.toLowerCase())) seen.set(f.address.toLowerCase(), f);
    const list = [...seen.values()].slice(0, 30);
    if (!list.length) { toast('No recent senders in that inbox.'); return; }
    showMenu(list.map((f) => ({ label: f.name ? `${f.name} — ${f.address}` : f.address, action: () => { form = { ...form, kind: 'sender', value: f.address }; render(); } })), { anchor });
  }

  function addForm() {
    const kind = h('select', { class: 'ma-kind', onchange: (e) => { form.kind = e.target.value; render(); } },
      h('option', { value: 'word', selected: form.kind === 'word' }, 'Words'),
      h('option', { value: 'sender', selected: form.kind === 'sender' }, 'Sender'));
    const value = h('input', { type: 'text', class: 'ma-value', value: form.value, placeholder: form.kind === 'sender' ? 'name@example.com' : 'a word or phrase',
      oninput: (e) => { form.value = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') add(); } });
    const acct = state.accounts.length > 1 ? h('select', { class: 'ma-acct', onchange: (e) => { form.acct = e.target.value; } },
      h('option', { value: '', selected: !form.acct }, 'Every account'),
      ...state.accounts.map((a) => h('option', { value: a.id, selected: form.acct === a.id }, a.address))) : null;
    const add = () => {
      const v = form.value.trim();
      if (!v) { value.focus(); return; }
      saveRules([...state.rules, { kind: form.kind, value: v, acct: form.acct || null }]);
      form = { ...form, value: '' };
    };
    return h('div', { class: 'ma-form' },
      h('div', { class: 'ma-form-row' }, kind, value),
      h('div', { class: 'ma-form-row' },
        acct,
        form.kind === 'sender' ? h('button', { class: 'btn sm ghost', onclick: (e) => pickSender(e.currentTarget) }, icon('inbox', 'sm'), 'Recent senders') : null,
        h('div', { class: 'grow' }),
        h('button', { class: 'btn sm primary', onclick: add }, icon('plus', 'sm'), 'Watch')));
  }

  function render(into = host) {
    host = into;
    if (!host) return;
    const head = h('div', { class: 'panel-head' }, 'Email alerts', h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', 'data-tip': busy ? 'Checking…' : 'Check now', disabled: busy || !state.rules.length, onclick: check }, icon('refresh', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Clear the alerts', disabled: !state.alerts.length, onclick: () => post('/api/mail/alerts', { action: 'clear' }) }, icon('trash', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Hide panel', onclick: () => app.hidePanel() }, icon('x', 'sm')));
    const body = h('div', { class: 'panel-body ma-body' });
    clear(host).append(head, body);
    if (!state.accounts.length) {
      body.append(h('div', { class: 'empty-note' }, 'Add a Gmail account to BoxMail, then pick words or senders to watch for here.'),
        h('button', { class: 'btn sm', onclick: () => app.newDocument('mail') }, icon('mail', 'sm'), `Open ${app.toolName('BoxMail')}`));
      return;
    }
    const rules = new Map(state.rules.map((r) => [r.id, r]));
    const list = h('div', { class: 'ma-list' });
    if (!state.alerts.length) list.append(h('div', { class: 'empty-note' }, state.rules.length ? 'Nothing yet. New mail that matches shows up here.' : 'Nothing to watch for yet. Add a word or a sender below.'));
    for (const a of state.alerts) list.append(alertRow(a, rules));
    const watching = h('div', { class: 'ma-rules' }, ...state.rules.map(ruleRow));
    const foot = h('div', { class: 'ma-foot faint' },
      state.error ? h('span', { class: 'ma-err' }, state.error)
        : state.lastCheck ? `Checked ${timeAgo(state.lastCheck)} · every 2 minutes` : state.rules.length ? 'Checks every 2 minutes.' : '');
    body.append(list,
      h('div', { class: 'ma-head' }, 'Watching for', h('span', { class: 'faint' }, state.rules.length ? String(state.rules.length) : '')),
      watching, addForm(), foot);
    // opening the panel counts as seeing what's in it
    if (state.unseen) setTimeout(() => { if (isOpen()) api.post('/api/mail/alerts', { action: 'seen' }).then((s) => { state = s; known = new Set(s.alerts.map((a) => a.id)); badge(); }).catch(() => {}); }, 1500);
  }

  refresh();
  setInterval(() => { if (!document.hidden || state.rules.length) refresh(); }, POLL_MS);

  return { render, refresh, watchSender };
}
