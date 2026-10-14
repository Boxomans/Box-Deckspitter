// Calendar (left sidebar): a month at a glance with holidays and your own events. An event has a start time and a
// length (or is all day), can repeat (weekly, monthly, yearly), and can ring through the clock's alarm: before it
// starts and/or when it ends. The clock rings them (main window only) and lists today's events.
// Events live in settings.calendarEvents; settings.calendarHolidays turns the holidays off ('off') or on.

import { api } from './api.js';
import { h, clear, uid } from './dom.js';
import { icon } from './icons.js';
import { toast, contextMenu, modal } from './ui.js';

const COLORS = ['#b48cff', '#6ee7e0', '#ff7ac6', '#ffb86b', '#7cd992', '#6aa8ff'];
const REPEAT = { none: 'Doesn’t repeat', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' };
const LENGTHS = [[15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 hour'], [90, '1 h 30'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours'], [480, '8 hours']];
const REMIND = { '': 'No alarm', 0: 'When it starts', 5: '5 minutes before', 15: '15 minutes before', 30: '30 minutes before', 60: '1 hour before', 1440: '1 day before' };

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const sameDay = (a, b) => keyOf(a) === keyOf(b);

// ---------------------------------------------------------------- holidays (US)
/** The nth weekday (0 = Sunday) of a month; n = -1 is the last one. */
function nthWeekday(y, m, wd, n) {
  if (n > 0) { const d = new Date(y, m, 1); d.setDate(1 + ((wd - d.getDay() + 7) % 7) + (n - 1) * 7); return d; }
  const d = new Date(y, m + 1, 0); d.setDate(d.getDate() - ((d.getDay() - wd + 7) % 7)); return d;
}
/** Easter Sunday (Gregorian, the anonymous algorithm). */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), hh = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - hh - k) % 7, m = Math.floor((a + 11 * hh + 22 * l) / 451);
  const month = Math.floor((hh + l - 7 * m + 114) / 31), day = ((hh + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
const holidayCache = new Map();
/** { 'YYYY-MM-DD': [{ name, off }] } for a year. off: a federal holiday (most offices closed). */
function holidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const out = {};
  const add = (d, name, off = false) => { (out[keyOf(d)] ||= []).push({ name, off }); };
  // a federal holiday on a weekend is observed on the nearest weekday
  const fed = (d, name) => {
    add(d, name, true);
    const wd = d.getDay();
    if (wd === 6) add(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1), `${name} (observed)`, true);
    if (wd === 0) add(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), `${name} (observed)`, true);
  };
  fed(new Date(y, 0, 1), 'New Year’s Day');
  fed(nthWeekday(y, 0, 1, 3), 'Martin Luther King Jr. Day');
  fed(nthWeekday(y, 1, 1, 3), 'Presidents’ Day');
  fed(nthWeekday(y, 4, 1, -1), 'Memorial Day');
  fed(new Date(y, 5, 19), 'Juneteenth');
  fed(new Date(y, 6, 4), 'Independence Day');
  fed(nthWeekday(y, 8, 1, 1), 'Labor Day');
  fed(nthWeekday(y, 9, 1, 2), 'Columbus / Indigenous Peoples’ Day');
  fed(new Date(y, 10, 11), 'Veterans Day');
  fed(nthWeekday(y, 10, 4, 4), 'Thanksgiving');
  fed(new Date(y, 11, 25), 'Christmas Day');
  const e = easter(y);
  add(new Date(y, 0, 6), 'Epiphany');
  add(nthWeekday(y, 1, 0, 1), 'Super Bowl Sunday');
  add(new Date(y, 1, 2), 'Groundhog Day');
  add(new Date(y, 1, 14), 'Valentine’s Day');
  add(new Date(y, e.getMonth(), e.getDate() - 47), 'Mardi Gras');
  add(new Date(y, 2, 17), 'St. Patrick’s Day');
  add(new Date(y, 3, 1), 'April Fools’ Day');
  add(new Date(y, e.getMonth(), e.getDate() - 2), 'Good Friday');
  add(e, 'Easter');
  add(new Date(y, 3, 22), 'Earth Day');
  add(new Date(y, 4, 5), 'Cinco de Mayo');
  add(nthWeekday(y, 4, 0, 2), 'Mother’s Day');
  add(nthWeekday(y, 5, 0, 3), 'Father’s Day');
  add(new Date(y, 9, 31), 'Halloween');
  add(new Date(y, 10, 1), 'All Saints’ Day');
  add(nthWeekday(y, 10, 0, 1), 'Daylight saving time ends');
  add(nthWeekday(y, 2, 0, 2), 'Daylight saving time starts');
  add(new Date(nthWeekday(y, 10, 4, 4).getTime() + 86_400_000), 'Black Friday');
  add(new Date(y, 11, 24), 'Christmas Eve');
  add(new Date(y, 11, 31), 'New Year’s Eve');
  holidayCache.set(y, out);
  return out;
}

export function createCalendar(app) {
  const now0 = new Date();
  let month = new Date(now0.getFullYear(), now0.getMonth(), 1);
  let picked = keyOf(now0);
  let host = null;

  const events = () => (Array.isArray(app.settings.calendarEvents) ? app.settings.calendarEvents : []);
  const save = (list) => app.saveSettings({ calendarEvents: list });
  const showHolidays = () => app.settings.calendarHolidays !== 'off';
  const lenText = (m) => { m = Number(m) || 0; const hh = Math.floor(m / 60), mm = m % 60; return hh ? `${hh} h${mm ? ` ${mm}` : ''}` : `${mm} min`; };
  const endOf = (t, dur) => { const [hh, mm] = t.split(':').map(Number); const e = hh * 60 + mm + (Number(dur) || 0); return `${pad(Math.floor(e / 60) % 24)}:${pad(e % 60)}`; };
  /** "9:00 AM – 10:30 AM", or "All day". */
  const span = (ev) => (ev.time ? (Number(ev.dur) ? `${fmtTime(ev.time)} – ${fmtTime(endOf(ev.time, ev.dur))}` : fmtTime(ev.time)) : 'All day');
  const fmtTime = (t) => { if (!t) return ''; const [hh, mm] = t.split(':').map(Number); const d = new Date(); d.setHours(hh, mm, 0, 0); return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: !app.settings.clock24 }); };

  /** Does this event happen on day d? */
  function occurs(ev, d) {
    const start = parseKey(ev.date);
    if (d < start) return false;
    if (ev.until && keyOf(d) > ev.until) return false;
    switch (ev.repeat) {
      case 'weekly': return d.getDay() === start.getDay();
      case 'monthly': return d.getDate() === start.getDate();
      case 'yearly': return d.getDate() === start.getDate() && d.getMonth() === start.getMonth();
      default: return sameDay(d, start);
    }
  }
  const eventsOn = (d) => events().filter((ev) => occurs(ev, d)).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const holidaysOn = (d) => (showHolidays() ? holidays(d.getFullYear())[keyOf(d)] || [] : []);

  // ---------------------------------------------------------------- rings (the clock asks; main window only)
  const rung = new Set();
  /** Start/end times (ms) of an occurrence on day d. */
  function timesOn(ev, d) {
    const [hh, mm] = ev.time.split(':').map(Number);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm).getTime();
    return { start, end: start + (Number(ev.dur) || 0) * 60_000 };
  }
  /** Rings due now: [{ title, sub }], each once. More than 5 minutes late = missed, not rung. */
  function due(now = new Date()) {
    const out = [];
    const t = now.getTime();
    for (const ev of events()) {
      if (!ev.time) continue;
      for (const off of [-1, 0, 1]) { // yesterday (ends after midnight), today, tomorrow (a day-before alarm)
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off);
        if (!occurs(ev, d)) continue;
        const { start, end } = timesOn(ev, d);
        const fire = (kind, at, sub) => {
          const key = `${ev.id}@${keyOf(d)}:${kind}`;
          if (rung.has(key) || t < at || t - at > 5 * 60_000) return;
          rung.add(key);
          out.push({ title: ev.title || 'Event', sub });
        };
        if (ev.remind !== '' && ev.remind != null) {
          const r = Number(ev.remind);
          fire('start', start - r * 60_000, r === 0 ? `Starting now · ${span(ev)}` : `${off === 1 ? 'Tomorrow' : 'Today'} ${span(ev)} · in ${lenText(r)}`);
        }
        if (ev.ringEnd && Number(ev.dur)) fire('end', end, `Ending now · ${span(ev)}`);
      }
    }
    return out;
  }
  /** Today's events (all-day ones first), for the clock. */
  function today(now = new Date()) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return eventsOn(d).map((ev) => ({ ev, span: span(ev), ...(ev.time ? timesOn(ev, d) : {}) }));
  }

  // ---------------------------------------------------------------- the panel
  function render(into = host) {
    if (!into) return;
    host = into;
    const today = new Date();
    const head = h('div', { class: 'panel-head' }, 'Calendar', h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', 'data-tip': 'Today', onclick: () => { month = new Date(today.getFullYear(), today.getMonth(), 1); picked = keyOf(today); render(); } }, icon('calendar', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Add an event', onclick: () => editEvent(null, picked) }, icon('plus', 'sm')),
      h('button', { class: `icon-btn ${showHolidays() ? 'active' : ''}`, 'data-tip': showHolidays() ? 'Hide holidays' : 'Show holidays', onclick: () => { app.saveSettings({ calendarHolidays: showHolidays() ? 'off' : 'on' }); render(); } }, icon('flag', 'sm')));

    const title = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const nav = h('div', { class: 'cal-nav' },
      h('button', { class: 'icon-btn', 'data-tip': 'Previous month', onclick: () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); render(); } }, icon('chevron-left', 'sm')),
      h('b', { class: 'cal-title' }, title),
      h('button', { class: 'icon-btn', 'data-tip': 'Next month', onclick: () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); render(); } }, icon('chevron-right', 'sm')));

    const grid = h('div', { class: 'cal-grid' });
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const startDay = new Date(first);
    startDay.setDate(1 - first.getDay());
    for (const wd of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) grid.append(h('div', { class: 'cal-wd' }, wd));
    for (let i = 0; i < 42; i++) {
      const d = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + i);
      const k = keyOf(d);
      const evs = eventsOn(d);
      const hol = holidaysOn(d);
      const cell = h('button', {
        class: ['cal-day', d.getMonth() !== month.getMonth() && 'other', sameDay(d, today) && 'today', k === picked && 'picked', hol.some((x) => x.off) && 'off', hol.length && 'hol'].filter(Boolean).join(' '),
        title: [...hol.map((x) => x.name), ...evs.map((e) => `${e.time ? span(e) + ' ' : ''}${e.title}`)].join('\n') || undefined,
        onclick: () => { picked = k; if (d.getMonth() !== month.getMonth()) month = new Date(d.getFullYear(), d.getMonth(), 1); render(); },
        ondblclick: () => editEvent(null, k),
      }, h('span', { class: 'cal-n' }, String(d.getDate())),
        h('span', { class: 'cal-dots' }, evs.slice(0, 3).map((e) => h('i', { style: { background: e.color || COLORS[0] } })), hol.length ? h('i', { class: 'cal-hol-dot' }) : null));
      cell.addEventListener('contextmenu', (e) => contextMenu(e, [{ label: 'Add an event on this day…', icon: 'plus', action: () => editEvent(null, k) }]));
      grid.append(cell);
    }

    // the picked day
    const pd = parseKey(picked);
    const dayList = h('div', { class: 'cal-agenda' });
    dayList.append(h('div', { class: 'cal-agenda-head' }, h('b', {}, pd.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })), h('div', { class: 'grow' }),
      h('button', { class: 'btn sm', onclick: () => editEvent(null, picked) }, icon('plus', 'sm'), 'Event')));
    for (const x of holidaysOn(pd)) dayList.append(h('div', { class: `cal-item hol ${x.off ? 'off' : ''}` }, icon('flag', 'sm'), h('span', {}, x.name), x.off ? h('span', { class: 'cal-tag' }, 'holiday') : null));
    const evs = eventsOn(pd);
    for (const ev of evs) dayList.append(eventRow(ev, pd));
    if (!evs.length && !holidaysOn(pd).length) dayList.append(h('div', { class: 'faint cal-empty' }, 'Nothing on this day. Double-click a day or press + to add something.'));

    // coming up
    const soon = h('div', { class: 'cal-agenda' }, h('div', { class: 'cal-agenda-head' }, h('b', {}, 'Coming up')));
    let n = 0;
    const seen = new Set(); // a repeating event shows once, at its next time
    for (let i = 1; i <= 45 && n < 8; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      for (const ev of eventsOn(d)) { if (seen.has(ev.id)) continue; seen.add(ev.id); if (n++ < 8) soon.append(eventRow(ev, d, true)); }
      for (const x of holidaysOn(d).filter((y) => y.off)) { if (n++ < 8) soon.append(h('div', { class: 'cal-item hol off' }, icon('flag', 'sm'), h('span', {}, x.name), h('span', { class: 'cal-when faint' }, relDay(d)))); }
    }
    if (!n) soon.append(h('div', { class: 'faint cal-empty' }, 'Nothing in the next few weeks.'));

    clear(host).append(head, h('div', { class: 'panel-body cal-body' }, nav, grid, dayList, soon));
  }

  function relDay(d) {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const diff = Math.round((d - t) / 86_400_000);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function eventRow(ev, d, withDay = false) {
    const row = h('div', { class: 'cal-item', style: `--c: ${ev.color || COLORS[0]}`, title: ev.notes || '' },
      h('i', { class: 'cal-bar' }),
      h('div', { class: 'cal-item-main' }, h('span', { class: 'cal-item-title' }, ev.title || '(untitled)'),
        h('span', { class: 'faint cal-item-sub' }, [span(ev), ev.time && Number(ev.dur) ? lenText(ev.dur) : null, ev.repeat && ev.repeat !== 'none' ? REPEAT[ev.repeat].toLowerCase() : null, ev.time && ((ev.remind !== '' && ev.remind != null) || ev.ringEnd) ? '⏰' : null].filter(Boolean).join(' · '))),
      withDay ? h('span', { class: 'cal-when faint' }, relDay(d)) : null);
    row.addEventListener('click', () => editEvent(ev));
    row.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Edit…', icon: 'edit', action: () => editEvent(ev) },
      ...(ev.repeat && ev.repeat !== 'none' ? [{ label: 'Stop repeating after this day', icon: 'x', action: () => { save(events().map((x) => (x.id === ev.id ? { ...x, until: keyOf(d) } : x))); render(); } }] : []),
      { label: 'Delete', icon: 'trash', action: () => removeEvent(ev) },
    ]));
    return row;
  }

  function removeEvent(ev) {
    const before = events();
    save(before.filter((x) => x.id !== ev.id));
    render();
    app.clock?.refresh?.();
    toast(`Deleted “${ev.title || 'event'}”`, { action: { label: 'Undo', fn: () => { save(before); render(); } } });
  }

  /** Add (ev null) or edit an event. */
  async function editEvent(ev, dateKey = picked) {
    const e = ev ? { ...ev } : { id: uid('ev'), title: '', date: dateKey, time: `${pad((new Date().getHours() + 1) % 24)}:00`, dur: 60, repeat: 'none', remind: '', ringEnd: false, color: COLORS[0], notes: '' };
    const title = h('input', { type: 'text', value: e.title, placeholder: 'What’s happening?', style: { width: '100%' } });
    const date = h('input', { type: 'date', value: e.date, class: 'cal-input' });
    const allDay = h('input', { type: 'checkbox', checked: !e.time });
    const time = h('input', { type: 'time', value: e.time || '09:00', class: 'cal-input', disabled: !e.time });
    const len = h('select', {}, [[0, 'No length'], ...LENGTHS].map(([v, l]) => h('option', { value: String(v) }, l)));
    const d0 = Number(e.dur ?? 60);
    if (d0 && !LENGTHS.some(([v]) => v === d0)) len.append(h('option', { value: String(d0) }, lenText(d0)));
    len.value = String(d0);
    const ends = h('span', { class: 'faint cal-ends' });
    const ringEnd = h('input', { type: 'checkbox', checked: !!e.ringEnd });
    const sync = () => {
      const off = allDay.checked;
      time.disabled = off; len.disabled = off; remind.disabled = off; ringEnd.disabled = off || !Number(len.value);
      ends.textContent = !off && Number(len.value) && time.value ? `ends ${fmtTime(endOf(time.value, len.value))}` : '';
    };
    for (const x of [allDay, time, len]) { x.addEventListener('input', sync); x.addEventListener('change', sync); }
    const repeat = h('select', {}, Object.entries(REPEAT).map(([k, v]) => h('option', { value: k }, v)));
    repeat.value = e.repeat || 'none';
    const remind = h('select', { disabled: !e.time }, Object.entries(REMIND).map(([k, v]) => h('option', { value: k }, v)));
    remind.value = e.remind == null ? '' : String(e.remind);
    let color = e.color || COLORS[0];
    const swatches = h('div', { class: 'cal-swatches' }, COLORS.map((c) => {
      const b = h('button', { class: `cal-swatch ${c === color ? 'on' : ''}`, style: { background: c }, type: 'button', onclick: () => { color = c; for (const x of swatches.children) x.classList.toggle('on', x === b); } });
      return b;
    }));
    const notes = h('textarea', { class: 'input', rows: '3', placeholder: 'Notes (optional)', style: { width: '100%', resize: 'vertical' } });
    notes.value = e.notes || '';
    const row = (label, ...els) => h('label', { class: 'cal-form-row' }, h('span', { class: 'dim' }, label), ...els);
    const body = h('div', { class: 'cal-form' }, title,
      row('Date', date), h('div', { class: 'cal-form-row' }, h('span', { class: 'dim' }, 'Time'), h('label', { class: 'check' }, allDay, 'All day'), time),
      h('div', { class: 'cal-form-row' }, h('span', { class: 'dim' }, 'Length'), len, ends),
      row('Repeats', repeat), row('Alarm', remind), h('div', { class: 'cal-form-row' }, h('span', {}), h('label', { class: 'check' }, ringEnd, 'Also ring when it ends')), row('Colour', swatches), notes);
    const res = await modal({
      title: ev ? 'Edit event' : 'New event', body,
      buttons: [...(ev ? [{ label: 'Delete', value: 'delete', danger: true }] : []), { label: 'Cancel', value: null, ghost: true }, { label: ev ? 'Save' : 'Add', primary: true, onClick: () => 'save' }],
      onOpen: () => { sync(); setTimeout(() => title.focus(), 30); },
    });
    if (res === 'delete') return removeEvent(ev);
    if (res !== 'save') return;
    if (!/^\d{4}-\d\d-\d\d$/.test(date.value)) { toast('Pick a date.', { type: 'warn' }); return; }
    Object.assign(e, { title: title.value.trim() || 'Untitled event', date: date.value, time: allDay.checked ? '' : time.value, dur: allDay.checked ? 0 : Number(len.value) || 0, ringEnd: !allDay.checked && ringEnd.checked && !!Number(len.value), repeat: repeat.value, remind: allDay.checked ? '' : remind.value, color, notes: notes.value.trim() });
    if (e.until && e.until < e.date) delete e.until;
    save(ev ? events().map((x) => (x.id === e.id ? e : x)) : [...events(), e]);
    picked = e.date;
    const d = parseKey(e.date);
    month = new Date(d.getFullYear(), d.getMonth(), 1);
    render();
    app.clock?.refresh?.();
  }

  // the day ticks over at midnight: keep "today" right
  let lastDay = keyOf(new Date());
  setInterval(() => { const k = keyOf(new Date()); if (k !== lastDay) { lastDay = k; if (host?.isConnected && app.panel === 'calendar') render(); } }, 60_000);

  return {
    render, due, today, lenText, holidays,
    add: (k) => editEvent(null, k ?? keyOf(new Date())),
    edit: (ev) => editEvent(ev),
    /** Show the calendar panel (on day k, if given). */
    open: (k) => { if (k) { picked = k; const d = parseKey(k); month = new Date(d.getFullYear(), d.getMonth(), 1); } app.showPanel('calendar'); },
  };
}
