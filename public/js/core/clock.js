// Clock: a button that lives in the top bar or the right sidebar (showing the time either way), and a panel with
// other time zones, alarms and a countdown timer. Alarms ring in the main window only (one ring per app); a timer
// rings in the window it was started in. Zones, alarms and 12/24-hour are kept in settings.
// Calendar events with an alarm ring here too (before they start and/or when they end), and today's events are
// listed in the panel with their times and lengths.

import { api } from './api.js';
import { h, clear, uid } from './dom.js';
import { icon } from './icons.js';
import { toast } from './ui.js';

const REPEAT = { once: 'Once', daily: 'Every day', weekdays: 'Weekdays', weekends: 'Weekends' };
const PRESETS = [1, 5, 10, 15, 25, 60];
const SNOOZE_MIN = 5;
const RING_MAX_MS = 90_000; // a ring nobody answers stops on its own

export function createClock(app) {
  const btn = document.getElementById('btn-clock');
  if (!btn) return null;
  const now = h('span', { class: 'clock-now mono' });
  btn.append(icon('clock'), now);

  let pop = null;
  let open = false;
  let openedAt = 0;
  const timer = { total: 0, left: 0, endAt: 0, running: false };
  const snoozes = []; // { at, label }
  const fired = new Set(); // "alarmId@YYYY-MM-DD HH:MM", so a minute only rings once
  let ring = null;

  const h24 = () => !!app.settings.clock24;
  const zones = () => app.settings.clockZones || [];
  const alarms = () => app.settings.clockAlarms || [];
  const fmt = (d, opts = {}) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hour12: !h24(), ...opts }).format(d);
  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const dur = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return (hh ? `${hh}:${String(mm).padStart(2, '0')}` : String(mm)) + `:${String(ss).padStart(2, '0')}`;
  };
  const alarmTime = (t) => { const [hh, mm] = t.split(':').map(Number); const d = new Date(); d.setHours(hh, mm, 0, 0); return fmt(d); };
  const save = (patch) => app.saveSettings(patch);

  // ------------------------------------------------------------------ the button
  let lastLabel = '';
  function paint() {
    const d = new Date();
    const timing = timer.running || (timer.left > 0 && timer.left < timer.total);
    const label = timing ? dur(timer.running ? timer.endAt - Date.now() : timer.left) : fmt(d);
    if (label !== lastLabel) {
      const grew = label.length !== lastLabel.length;
      lastLabel = label;
      now.textContent = label;
      btn.dataset.rlabel = label; // shown down the side when it's in the sidebar
      if (grew && btn.closest('#rightrail')) app.layoutRail?.();
    }
    btn.classList.toggle('timing', timing);
    const evs = app.calendar?.today() || [];
    btn.classList.toggle('alarm-set', alarms().some((a) => a.on) || evs.some((x) => x.ev.time && x.end > Date.now() && ((x.ev.remind !== '' && x.ev.remind != null) || x.ev.ringEnd)));
    const nextEv = evs.find((x) => x.start > Date.now());
    btn.title = `${d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · ${fmt(d, { second: '2-digit' })}`
      + (timing ? ` · timer ${dur(timer.running ? timer.endAt - Date.now() : timer.left)}${timer.running ? '' : ' (paused)'}` : '')
      + (nextEv ? ` · next: ${nextEv.ev.title || 'event'} at ${alarmTime(nextEv.ev.time)}` : '')
      + ' · click for time zones, alarms, today\u2019s events and a timer; drag or flick it to the other bar';
  }

  // ------------------------------------------------------------------ sound + ringing
  let actx = null;
  let beepT = null;
  function beeps() {
    try { actx ||= new AudioContext(); if (actx.state === 'suspended') actx.resume(); } catch { return; }
    const vol = Math.max(0.15, Math.min(1, app.settings.soundVolume ?? 0.7)) * 0.35;
    const t0 = actx.currentTime + 0.02;
    for (let i = 0; i < 4; i++) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine';
      o.frequency.value = i % 2 ? 1046.5 : 880;
      const t = t0 + i * 0.16;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      o.connect(g).connect(actx.destination);
      o.start(t); o.stop(t + 0.14);
    }
  }
  function stopRing() {
    clearInterval(beepT); beepT = null;
    if (ring) { clearTimeout(ring.auto); ring.el.remove(); ring = null; }
  }
  function startRing(title, sub, { snooze } = {}) {
    stopRing();
    beeps();
    beepT = setInterval(beeps, 1100);
    const el = h('div', { class: 'clock-ring', role: 'alertdialog' },
      h('div', { class: 'clock-ring-ico' }, icon('clock')),
      h('div', { class: 'clock-ring-text' }, h('b', {}, title), sub ? h('span', { class: 'faint' }, sub) : null),
      snooze ? h('button', { class: 'btn sm', onclick: () => { snoozes.push({ at: Date.now() + SNOOZE_MIN * 60_000, label: snooze }); stopRing(); toast(`Snoozed for ${SNOOZE_MIN} minutes.`); } }, `Snooze ${SNOOZE_MIN}m`) : null,
      h('button', { class: 'btn sm primary', onclick: stopRing }, 'Stop'));
    document.body.append(el);
    ring = { el, auto: setTimeout(stopRing, RING_MAX_MS) };
    // seen even when the app is behind something else
    if (document.hidden || !document.hasFocus()) {
      try { new Notification(title, { body: sub || '', silent: true }); } catch { /* ignore */ }
    }
  }

  // ------------------------------------------------------------------ alarms + timer
  async function refreshAlarms() {
    // alarms can be changed from another window; the main window rings them, so it re-reads them
    try {
      const s = await api.settings();
      if (s && Array.isArray(s.clockAlarms)) app.settings.clockAlarms = s.clockAlarms;
      if (s && Array.isArray(s.calendarEvents)) app.settings.calendarEvents = s.calendarEvents;
    } catch { /* offline */ }
  }
  function checkAlarms(d) {
    if (app.mainWindow === false) return;
    const t = hhmm(d), day = d.getDay();
    for (const a of alarms()) {
      if (!a.on || a.time !== t) continue;
      const rep = a.repeat || 'once';
      if (rep === 'weekdays' && (day === 0 || day === 6)) continue;
      if (rep === 'weekends' && day > 0 && day < 6) continue;
      const key = `${a.id}@${dayKey(d)} ${t}`;
      if (fired.has(key)) continue;
      fired.add(key);
      if (rep === 'once') save({ clockAlarms: alarms().map((x) => (x.id === a.id ? { ...x, on: false } : x)) }).then(() => open && render());
      startRing(a.label || 'Alarm', fmt(d), { snooze: a.label || 'Alarm' });
    }
    // calendar events: an alarm before they start, and/or when they end
    for (const r of app.calendar?.due(d) || []) startRing(r.title, r.sub, { snooze: r.title });
    for (let i = snoozes.length - 1; i >= 0; i--) {
      if (snoozes[i].at <= Date.now()) { const s = snoozes.splice(i, 1)[0]; startRing(s.label, `${fmt(d)} · snoozed`, { snooze: s.label }); }
    }
  }
  function checkTimer() {
    if (!timer.running || Date.now() < timer.endAt) return;
    timer.running = false;
    timer.left = 0;
    startRing('Timer done', `${dur(timer.total)} is up`);
    if (open) render();
  }
  function startTimer(ms) {
    if (ms > 0) { timer.total = ms; timer.left = ms; }
    if (!timer.left) return;
    timer.endAt = Date.now() + timer.left;
    timer.running = true;
    try { actx ||= new AudioContext(); } catch { /* ignore */ } // made during a click, so it may play later
  }
  function pauseTimer() { if (!timer.running) return; timer.left = Math.max(0, timer.endAt - Date.now()); timer.running = false; }
  function resetTimer() { timer.running = false; timer.left = 0; timer.total = 0; }

  let lastMin = -1;
  setInterval(() => {
    const d = new Date();
    paint();
    checkTimer();
    if (d.getMinutes() !== lastMin) {
      lastMin = d.getMinutes();
      if (app.mainWindow === false) checkAlarms(d);
      else refreshAlarms().then(() => checkAlarms(new Date()));
    } else checkAlarms(d);
    if (open) tick();
  }, 1000);
  paint();

  // ------------------------------------------------------------------ the panel
  let liveEls = []; // updates run every second while the panel is open
  function tick() { for (const f of liveEls) f(); }

  function zoneInfo(tz) {
    const d = new Date();
    const time = fmt(d, { timeZone: tz });
    let off = '';
    try { off = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || ''; } catch { /* old engine */ }
    const ymd = (o) => new Intl.DateTimeFormat('en-CA', { timeZone: o, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const diff = Math.round((new Date(ymd(tz)) - new Date(ymd(undefined))) / 86_400_000);
    return { time, off, day: diff > 0 ? 'tomorrow' : diff < 0 ? 'yesterday' : '' };
  }
  const allZones = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return []; } })();
  const zoneName = (tz) => tz.split('/').pop().replace(/_/g, ' ');

  function render() {
    liveEls = [];
    const live = (el, f) => { const up = () => { const t = f(); if (el.textContent !== t) el.textContent = t; }; liveEls.push(up); up(); return el; };
    clear(pop);

    // now
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    pop.append(h('div', { class: 'clock-head' },
      live(h('div', { class: 'clock-big mono' }), () => fmt(new Date(), { second: '2-digit' })),
      live(h('div', { class: 'faint' }), () => `${new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} · ${zoneName(local)}`),
      h('label', { class: 'clock-24', title: 'Show times as 24-hour' },
        h('input', { type: 'checkbox', checked: h24(), onchange: (e) => { save({ clock24: e.target.checked }); lastLabel = ''; paint(); render(); } }), '24-hour')));

    // time zones
    const zl = h('div', { class: 'clock-list' });
    for (const z of zones()) {
      const name = z.label || zoneName(z.tz);
      zl.append(h('div', { class: 'clock-row' },
        h('div', { class: 'clock-row-main' }, h('span', { class: 'clock-row-name' }, name),
          live(h('span', { class: 'faint clock-row-sub' }), () => { const i = zoneInfo(z.tz); return [i.off, i.day].filter(Boolean).join(' · '); })),
        live(h('span', { class: 'clock-row-time mono' }), () => zoneInfo(z.tz).time),
        h('button', { class: 'icon-btn sm', title: `Remove ${name}`, onclick: () => { save({ clockZones: zones().filter((x) => x !== z) }); render(); } }, icon('x', 'sm'))));
    }
    if (!zones().length) zl.append(h('div', { class: 'faint clock-empty' }, 'No other time zones yet.'));
    const zin = h('input', { type: 'text', placeholder: 'Add a city or zone, e.g. Tokyo', list: 'clock-zone-list', spellcheck: 'false' });
    const addZone = () => {
      const q = zin.value.trim().toLowerCase().replace(/\s+/g, '_');
      if (!q) return;
      const tz = allZones.find((z) => z.toLowerCase() === q) || allZones.find((z) => z.toLowerCase().endsWith('/' + q)) || allZones.find((z) => z.toLowerCase().includes(q));
      if (!tz) { toast('No time zone matches that.', { type: 'warn' }); return; }
      if (zones().some((z) => z.tz === tz)) { toast(`${zoneName(tz)} is already there.`); return; }
      save({ clockZones: [...zones(), { tz }] });
      render();
      pop.querySelector('.clock-zone-add input')?.focus();
    };
    zin.addEventListener('keydown', (e) => { if (e.key === 'Enter') addZone(); });
    pop.append(h('div', { class: 'clock-sec' }, h('div', { class: 'clock-sec-title' }, 'Time zones'), zl,
      h('div', { class: 'clock-add clock-zone-add' }, zin, h('button', { class: 'btn sm', onclick: addZone }, 'Add')),
      h('datalist', { id: 'clock-zone-list' }, allZones.map((z) => h('option', { value: z })))));

    // today's events (from the calendar)
    if (app.calendar) {
      const el = h('div', { class: 'clock-list' });
      const cal = app.calendar;
      for (const x of cal.today()) {
        const ev = x.ev;
        const ringing = ev.time && ((ev.remind !== '' && ev.remind != null) || ev.ringEnd);
        const status = () => {
          if (!ev.time) return '';
          const t = Date.now();
          if (t < x.start) return `in ${dur(x.start - t).replace(/:\d\d$/, '')}${x.start - t < 3_600_000 ? ' min' : ''}`;
          if (x.end > x.start && t < x.end) return `now · ${dur(x.end - t).replace(/:\d\d$/, '')}${x.end - t < 3_600_000 ? ' min' : ''} left`;
          return 'done';
        };
        const row = h('div', { class: `clock-row clock-ev${ev.time && Date.now() >= Math.max(x.end, x.start + 1) ? ' off' : ''}`, style: `--c: ${ev.color || 'var(--accent)'}` },
          h('i', { class: 'clock-ev-bar' }),
          h('div', { class: 'clock-row-main' }, h('span', { class: 'clock-row-name' }, ev.title || 'Event'),
            h('span', { class: 'faint clock-row-sub' }, [x.span, ev.time && Number(ev.dur) ? cal.lenText(ev.dur) : null].filter(Boolean).join(' · '))),
          live(h('span', { class: 'faint clock-ev-when' }), status),
          ev.time ? h('button', {
            class: `icon-btn sm clock-ev-ring${ringing ? ' on' : ''}`,
            title: ringing ? 'Rings — click to turn its alarm off' : 'Ring when it starts',
            onclick: (e) => {
              e.stopPropagation();
              const list = (app.settings.calendarEvents || []).map((y) => (y.id !== ev.id ? y : ringing ? { ...y, remind: '', ringEnd: false } : { ...y, remind: '0' }));
              save({ calendarEvents: list }); paint(); render();
            },
          }, icon('clock', 'sm')) : null);
        row.addEventListener('click', () => { hide(); cal.edit(ev); });
        el.append(row);
      }
      if (!el.children.length) el.append(h('div', { class: 'faint clock-empty' }, 'Nothing on the calendar today.'));
      pop.append(h('div', { class: 'clock-sec' }, h('div', { class: 'clock-sec-title' }, 'Today', h('div', { class: 'grow' }),
        h('button', { class: 'btn sm ghost', onclick: () => { hide(); cal.add(); } }, icon('plus', 'sm'), 'Event'),
        h('button', { class: 'btn sm ghost', onclick: () => { hide(); cal.open(); } }, icon('calendar', 'sm'), 'Calendar')), el));
    }

    // alarms
    const al = h('div', { class: 'clock-list' });
    const setAlarm = (a, patch) => { save({ clockAlarms: alarms().map((x) => (x.id === a.id ? { ...x, ...patch } : x)) }); paint(); render(); };
    for (const a of [...alarms()].sort((x, y) => x.time.localeCompare(y.time))) {
      al.append(h('div', { class: `clock-row${a.on ? '' : ' off'}` },
        h('input', { type: 'checkbox', checked: !!a.on, title: a.on ? 'On' : 'Off', onchange: (e) => setAlarm(a, { on: e.target.checked }) }),
        h('div', { class: 'clock-row-main' }, h('span', { class: 'clock-row-time mono' }, alarmTime(a.time)),
          h('span', { class: 'faint clock-row-sub' }, [a.label, REPEAT[a.repeat || 'once']].filter(Boolean).join(' · '))),
        h('button', { class: 'icon-btn sm', title: 'Delete alarm', onclick: () => { save({ clockAlarms: alarms().filter((x) => x.id !== a.id) }); paint(); render(); } }, icon('x', 'sm'))));
    }
    if (!alarms().length) al.append(h('div', { class: 'faint clock-empty' }, 'No alarms.'));
    const at = h('input', { type: 'time', value: hhmm(new Date(Date.now() + 3_600_000)).replace(/:\d\d$/, ':00') });
    const alab = h('input', { type: 'text', placeholder: 'Label (optional)' });
    const arep = h('select', {}, Object.entries(REPEAT).map(([k, v]) => h('option', { value: k }, v)));
    const addAlarm = () => {
      if (!/^\d\d:\d\d$/.test(at.value)) { toast('Pick a time first.', { type: 'warn' }); return; }
      save({ clockAlarms: [...alarms(), { id: uid('al'), time: at.value, label: alab.value.trim(), repeat: arep.value, on: true }] });
      paint();
      render();
    };
    alab.addEventListener('keydown', (e) => { if (e.key === 'Enter') addAlarm(); });
    pop.append(h('div', { class: 'clock-sec' }, h('div', { class: 'clock-sec-title' }, 'Alarms', app.mainWindow === false ? h('span', { class: 'faint' }, ' · they ring in the main window') : null), al,
      h('div', { class: 'clock-add' }, at, arep), h('div', { class: 'clock-add' }, alab, h('button', { class: 'btn sm', onclick: addAlarm }, 'Add alarm'))));

    // timer
    const shown = () => (timer.running ? timer.endAt - Date.now() : timer.left);
    const tsec = h('div', { class: 'clock-sec' }, h('div', { class: 'clock-sec-title' }, 'Timer'));
    if (timer.running || timer.left > 0) {
      const bar = h('div', { class: 'clock-timer-bar' }, h('i'));
      const fill = () => { bar.firstChild.style.width = `${timer.total ? Math.max(0, Math.min(100, (shown() / timer.total) * 100)) : 0}%`; };
      liveEls.push(fill); fill();
      tsec.append(live(h('div', { class: 'clock-timer mono' }), () => dur(shown())), bar,
        h('div', { class: 'clock-add' },
          timer.running
            ? h('button', { class: 'btn sm', onclick: () => { pauseTimer(); paint(); render(); } }, icon('pause-bars', 'sm'), 'Pause')
            : h('button', { class: 'btn sm primary', onclick: () => { startTimer(0); paint(); render(); } }, icon('play', 'sm'), 'Resume'),
          h('button', { class: 'btn sm', onclick: () => { timer.left = timer.total; timer.endAt = Date.now() + timer.total; paint(); render(); } }, icon('refresh', 'sm'), 'Restart'),
          h('button', { class: 'btn sm', onclick: () => { resetTimer(); paint(); render(); } }, icon('x', 'sm'), 'Clear')));
    } else {
      const mins = h('input', { type: 'number', min: '0', max: '999', value: String(app.settings.clockTimerMin ?? 5), title: 'Minutes' });
      const secs = h('input', { type: 'number', min: '0', max: '59', value: '0', title: 'Seconds' });
      const go = () => {
        const ms = ((Number(mins.value) || 0) * 60 + (Number(secs.value) || 0)) * 1000;
        if (ms <= 0) { toast('Set how long first.', { type: 'warn' }); return; }
        save({ clockTimerMin: Number(mins.value) || 0 });
        startTimer(ms); paint(); render();
      };
      for (const i of [mins, secs]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      tsec.append(h('div', { class: 'clock-presets' }, PRESETS.map((m) => h('button', { class: 'btn sm', onclick: () => { startTimer(m * 60_000); paint(); render(); } }, m < 60 ? `${m}m` : `${m / 60}h`))),
        h('div', { class: 'clock-add clock-timer-set' }, mins, h('span', { class: 'faint' }, 'min'), secs, h('span', { class: 'faint' }, 'sec'),
          h('button', { class: 'btn sm primary', onclick: go }, icon('play', 'sm'), 'Start')));
    }
    pop.append(tsec);
    place();
  }

  function place() {
    if (!pop || !open) return;
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth, ph = pop.offsetHeight;
    if (btn.closest('#rightrail')) {
      pop.style.left = `${Math.max(8, Math.round(r.left - w - 8))}px`;
      pop.style.top = `${Math.max(8, Math.min(innerHeight - ph - 8, Math.round(r.top + r.height / 2 - ph / 2)))}px`;
    } else {
      pop.style.top = `${Math.round(r.bottom + 6)}px`;
      pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, Math.round(r.right - w)))}px`;
    }
  }

  function show() {
    if (!pop) {
      pop = h('div', { class: 'clock-pop', hidden: true });
      document.body.append(pop);
      document.addEventListener('pointerdown', (e) => {
        if (!open || performance.now() - openedAt < 250) return;
        if (pop.contains(e.target) || btn.contains(e.target) || e.target.closest?.('.menu, .modal-backdrop, .clock-ring, .toasts')) return;
        hide();
      }, true);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open && !document.querySelector('.modal-backdrop')) hide(); });
      addEventListener('resize', place);
    }
    open = true;
    openedAt = performance.now();
    pop.hidden = false;
    btn.classList.add('on');
    render();
  }
  function hide() { open = false; liveEls = []; if (pop) pop.hidden = true; btn.classList.remove('on'); }

  btn.addEventListener('click', () => (open ? hide() : show()));

  return { show, hide, get timer() { return { ...timer }; }, ring: startRing, stopRing, refresh: () => { lastLabel = ''; paint(); if (open) render(); } };
}
