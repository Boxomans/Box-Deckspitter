// Weather: a button that lives in the top bar or the right sidebar (the conditions and temperature), a panel with the
// next hours and 7 days, a small floating widget you can pop out and drag around (or onto the sidebar), and the
// Weather tool for the full view (editors/weather.js). One place at a time, picked by searching; it and °F/°C are kept
// in settings. Forecasts come from Open-Meteo through the local server (no key), refreshed every 15 minutes.

import { api } from './api.js';
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { toast } from './ui.js';

const STALE = 15 * 60_000;

// WMO weather codes → words and an icon (night swaps the sun for the moon)
const CODES = [
  [[0], 'Clear', 'sun', 'moon'], [[1], 'Mostly clear', 'sun', 'moon'], [[2], 'Partly cloudy', 'cloud-sun', 'cloud-moon'], [[3], 'Overcast', 'cloud'],
  [[45, 48], 'Fog', 'cloud-fog'], [[51, 53, 55], 'Drizzle', 'cloud-rain'], [[56, 57], 'Freezing drizzle', 'cloud-rain'],
  [[61], 'Light rain', 'cloud-rain'], [[63], 'Rain', 'cloud-rain'], [[65], 'Heavy rain', 'cloud-rain'], [[66, 67], 'Freezing rain', 'cloud-rain'],
  [[71], 'Light snow', 'cloud-snow'], [[73], 'Snow', 'cloud-snow'], [[75], 'Heavy snow', 'cloud-snow'], [[77], 'Snow grains', 'cloud-snow'],
  [[80], 'Showers', 'cloud-rain'], [[81], 'Showers', 'cloud-rain'], [[82], 'Heavy showers', 'cloud-rain'], [[85, 86], 'Snow showers', 'cloud-snow'],
  [[95], 'Thunderstorm', 'cloud-lightning'], [[96, 99], 'Thunderstorm with hail', 'cloud-lightning'],
];
/** { label, icon } for a weather code, by day or night. */
export function describe(code, day = true) {
  const c = CODES.find(([list]) => list.includes(code));
  return c ? { label: c[1], icon: (!day && c[3]) || c[2] } : { label: '—', icon: 'cloud' };
}
export const deg = (v) => (v == null || !isFinite(v) ? '—' : `${Math.round(v)}°`);
export const placeName = (p) => (p ? [p.name, p.admin && p.admin !== p.name ? p.admin : '', p.country].filter(Boolean).join(', ') : '');

/** A search box for places, with its own suggestion list; onPick(place). */
export function placeSearch(onPick, { placeholder = 'Search for a town or city' } = {}) {
  const input = h('input', { type: 'text', placeholder, spellcheck: 'false', autocomplete: 'off' });
  const sug = h('div', { class: 'clock-sug wx-sug', hidden: true });
  let found = [], pick = -1, seq = 0, t = null;
  const draw = () => {
    clear(sug).append(...found.map((p, i) => h('div', { class: `clock-sug-row${i === pick ? ' on' : ''}`, onmousedown: (e) => { e.preventDefault(); choose(p); } },
      h('span', {}, p.name), h('span', { class: 'faint' }, [p.admin, p.country].filter(Boolean).join(', ')))));
    sug.hidden = !found.length;
  };
  const choose = (p = found[pick]) => {
    if (!p) { if (input.value.trim()) toast('No place matches that.', { type: 'warn' }); return; }
    input.value = ''; found = []; draw();
    onPick(p);
  };
  input.addEventListener('input', () => {
    clearTimeout(t);
    const q = input.value.trim(), n = ++seq;
    if (q.length < 2) { found = []; draw(); return; }
    t = setTimeout(async () => {
      let list = [];
      try { list = await api.weatherSearch(q); } catch (e) { if (n === seq) toast(e.message, { type: 'error' }); }
      if (n !== seq) return;
      found = list; pick = found.length ? 0 : -1; draw();
    }, 250);
  });
  input.addEventListener('blur', () => { sug.hidden = true; });
  input.addEventListener('focus', () => { if (found.length) sug.hidden = false; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); choose(); }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && found.length) {
      e.preventDefault();
      pick = (pick + (e.key === 'ArrowDown' ? 1 : -1) + found.length) % found.length;
      [...sug.children].forEach((r, i) => r.classList.toggle('on', i === pick));
      sug.children[pick]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Escape' && !sug.hidden) { e.stopPropagation(); sug.hidden = true; }
  });
  return { input, sug, el: h('div', { class: 'wx-search' }, input, sug) };
}

export function createWeather(app) {
  const btn = document.getElementById('btn-weather');
  if (!btn) return null;
  const glyph = h('span', { class: 'wx-glyph' }, icon('cloud-sun'));
  const now = h('span', { class: 'wx-now mono' });
  btn.append(glyph, now);

  const subs = new Set();
  let data = null, err = null, loading = false, fetchedAt = 0, lastIcon = 'cloud-sun';
  const cfg = () => app.settings.weather || {};
  const place = () => cfg().place || null;
  const unit = () => (cfg().unit === 'c' ? 'c' : 'f');
  const keyOf = () => { const p = place(); return p ? `${p.lat},${p.lon},${unit()}` : ''; };
  const save = (patch) => app.saveSettings({ weather: { ...cfg(), ...patch } });
  const clock = (opts) => new Intl.DateTimeFormat(undefined, { hour12: !app.settings.clock24, timeZone: data?.tz, ...opts });

  // ------------------------------------------------------------------ the forecast
  async function refresh(force = false) {
    const p = place();
    if (!p) { data = null; err = null; notify(); return; }
    if (loading || (!force && data?.key === keyOf() && Date.now() - fetchedAt < STALE)) return;
    loading = true;
    const key = keyOf();
    try {
      const d = await api.weather(p.lat, p.lon, unit());
      if (key === keyOf()) { data = { ...d, key }; err = null; fetchedAt = Date.now(); }
    } catch (e) { if (key === keyOf()) err = e.message || 'Couldn’t get the weather'; }
    loading = false;
    notify();
  }
  const current = () => (data && data.key === keyOf() ? data : null);
  function notify() { paint(); updateMini(); if (open) render(); for (const f of subs) { try { f(); } catch { /* a closed view */ } } }
  setInterval(() => refresh(), 60_000);
  addEventListener('focus', () => refresh());
  refresh();

  // ------------------------------------------------------------------ the button
  function paint() {
    const d = current();
    const p = place();
    const ic = d ? describe(d.current.code, d.current.day).icon : 'cloud-sun';
    if (ic !== lastIcon) { lastIcon = ic; glyph.replaceChildren(icon(ic)); }
    const label = d ? deg(d.current.temp) : '';
    if (now.textContent !== label) {
      now.textContent = label;
      btn.dataset.rlabel = label || 'weather';
      if (btn.closest('#rightrail')) app.layoutRail?.();
    }
    btn.classList.toggle('has-temp', !!label);
    btn.title = d ? `${placeName(p)} · ${describe(d.current.code, d.current.day).label}, ${deg(d.current.temp)}${d.units.temp.slice(1)} · click for the forecast; drag or flick it to the other bar`
      : p ? `Weather for ${placeName(p)}${err ? ` · ${err}` : ' · loading…'}` : 'Weather · click to pick a place; drag or flick it to the other bar';
  }
  paint();

  // ------------------------------------------------------------------ the panel
  let pop = null, open = false, openedAt = 0;

  /** The next hours, the week, the details: shared by the panel and the widget. */
  function hoursRow(d, n = 12) {
    const fmtH = clock({ hour: 'numeric' });
    return h('div', { class: 'wx-hours' }, d.hourly.slice(0, n).map((x, i) => {
      const w = describe(x.code, x.day);
      return h('div', { class: 'wx-hour', title: `${w.label}${x.pop ? ` · ${x.pop}% chance of rain` : ''}` },
        h('span', { class: 'faint' }, i === 0 ? 'Now' : fmtH.format(x.t)), icon(w.icon), h('b', {}, deg(x.temp)),
        h('span', { class: 'wx-pop' }, x.pop >= 20 ? `${x.pop}%` : ''));
    }));
  }
  function daysList(d) {
    const fmtD = clock({ weekday: 'short' });
    const lo = Math.min(...d.daily.map((x) => x.lo)), hi = Math.max(...d.daily.map((x) => x.hi));
    const span = hi - lo || 1;
    return h('div', { class: 'wx-days' }, d.daily.map((x, i) => {
      const w = describe(x.code, true);
      return h('div', { class: 'wx-day', title: w.label },
        h('span', { class: 'wx-day-name' }, i === 0 ? 'Today' : fmtD.format(x.t)), icon(w.icon),
        h('span', { class: 'wx-pop' }, x.pop >= 20 ? `${x.pop}%` : ''),
        h('span', { class: 'wx-lo mono' }, deg(x.lo)),
        h('span', { class: 'wx-range' }, h('i', { style: { left: `${((x.lo - lo) / span) * 100}%`, right: `${((hi - x.hi) / span) * 100}%` } })),
        h('span', { class: 'wx-hi mono' }, deg(x.hi)));
    }));
  }
  const details = (d) => [`Feels like ${deg(d.current.feels)}`, d.current.humidity != null ? `Humidity ${Math.round(d.current.humidity)}%` : '',
    d.current.wind != null ? `Wind ${Math.round(d.current.wind)} ${d.units.wind}` : ''].filter(Boolean).join(' · ');

  function unitToggle(after) {
    const b = (u, t) => h('button', { class: `btn sm${unit() === u ? ' primary' : ''}`, onclick: () => { if (unit() !== u) { save({ unit: u }); refresh(true); after?.(); } } }, t);
    return h('div', { class: 'wx-units' }, b('f', '°F'), b('c', '°C'));
  }
  const setPlace = (p) => { save({ place: { name: p.name, admin: p.admin, country: p.country, lat: p.lat, lon: p.lon } }); data = null; err = null; refresh(true); };

  function render() {
    clear(pop);
    const d = current(), p = place();
    if (!p) {
      const s = placeSearch(setPlace);
      pop.append(h('div', { class: 'clock-head' }, h('div', { class: 'clock-big' }, 'Weather'), h('div', { class: 'faint' }, 'Pick a place to see its weather.')),
        h('div', { class: 'clock-sec' }, s.el, unitToggle()));
      place_();
      setTimeout(() => s.input.focus(), 0);
      return;
    }
    if (!d) {
      pop.append(h('div', { class: 'clock-head' }, h('div', { class: 'clock-big' }, placeName(p)),
        h('div', { class: 'faint' }, err || 'Loading…'), err ? h('button', { class: 'btn sm', onclick: () => refresh(true) }, icon('refresh', 'sm'), 'Try again') : null));
    } else {
      const w = describe(d.current.code, d.current.day);
      pop.append(h('div', { class: 'clock-head wx-head' },
        h('div', { class: 'wx-head-main' }, h('span', { class: 'wx-big-icon' }, icon(w.icon)), h('div', { class: 'clock-big mono' }, deg(d.current.temp)),
          h('div', { class: 'wx-head-text' }, h('b', {}, w.label), h('span', { class: 'faint' }, `${deg(d.daily[0]?.hi)} / ${deg(d.daily[0]?.lo)}`))),
        h('div', { class: 'wx-place' }, placeName(p)),
        h('div', { class: 'faint' }, details(d))));
      pop.append(h('div', { class: 'clock-sec' }, h('div', { class: 'clock-sec-title' }, 'Next hours'), hoursRow(d)));
      pop.append(h('div', { class: 'clock-sec' }, h('div', { class: 'clock-sec-title' }, '7 days'), daysList(d)));
    }
    const s = placeSearch((np) => { setPlace(np); });
    pop.append(h('div', { class: 'clock-sec' }, h('div', { class: 'clock-sec-title' }, 'Place'), h('div', { class: 'clock-add' }, s.el, unitToggle()), s.sug));
    pop.append(h('div', { class: 'clock-sec' }, h('div', { class: 'clock-add wx-actions' },
      h('button', { class: 'btn sm', onclick: () => { hide(); app.newDocument('weather'); } }, icon('maximize', 'sm'), 'Full screen'),
      h('button', { class: 'btn sm', onclick: () => { hide(); toggleMini(); } }, icon('external', 'sm'), miniOn() ? 'Close widget' : 'Pop out'),
      h('button', { class: 'icon-btn sm', title: 'Refresh', onclick: () => refresh(true) }, icon('refresh', 'sm'))),
    h('div', { class: 'faint wx-credit' }, 'Weather data by Open-Meteo.com')));
    place_();
  }

  // (named with a _ so it doesn't shadow place())
  function place_() {
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
      pop = h('div', { class: 'clock-pop wx-panel', hidden: true });
      document.body.append(pop);
      document.addEventListener('pointerdown', (e) => {
        if (!open || performance.now() - openedAt < 250) return;
        if (pop.contains(e.target) || btn.contains(e.target) || e.target.closest?.('.menu, .modal-backdrop, .toasts')) return;
        hide();
      }, true);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open && !document.querySelector('.modal-backdrop')) hide(); });
      addEventListener('resize', place_);
    }
    open = true;
    openedAt = performance.now();
    pop.hidden = false;
    btn.classList.add('on');
    render();
    refresh();
  }
  function hide() { open = false; if (pop) pop.hidden = true; btn.classList.remove('on'); }
  btn.addEventListener('click', () => (open ? hide() : show()));

  // ------------------------------------------------------------------ the pop-out widget
  const miniOn = () => !!cfg().mini?.on;
  let mini = null;
  function buildMini() {
    const close = h('button', { class: 'wx-mini-x', title: 'Close the widget' }, icon('x', 'sm'));
    close.addEventListener('click', (e) => { e.stopPropagation(); toggleMini(false); });
    mini = h('div', { class: 'wx-mini', tabindex: '0' }, h('div', { class: 'wx-mini-body' }), close);
    mini.addEventListener('pointerdown', dragMini);
    mini.addEventListener('dragstart', (e) => e.preventDefault()); // the browser's own drag would cancel ours
  }
  function updateMini() {
    if (!miniOn() || app.mainWindow === false) { mini?.remove(); return; }
    if (!mini) buildMini();
    if (mini.parentElement !== document.body) document.body.append(mini);
    const body = mini.querySelector('.wx-mini-body');
    const d = current(), p = place();
    if (!d) clear(body).append(h('div', { class: 'wx-mini-none faint' }, p ? (err || 'Loading…') : 'Click to pick a place'));
    else {
      const w = describe(d.current.code, d.current.day);
      clear(body).append(
        h('div', { class: 'wx-mini-top' }, icon(w.icon), h('span', { class: 'wx-mini-temp mono' }, deg(d.current.temp))),
        h('div', { class: 'wx-mini-label' }, w.label),
        h('div', { class: 'wx-mini-sub faint' }, `${deg(d.daily[0]?.hi)} / ${deg(d.daily[0]?.lo)} · ${p.name}`));
    }
    mini.title = `${p ? placeName(p) : 'Weather'} · click for the full view · drag to move, or onto the right sidebar to put it there`;
    placeMini();
  }
  function placeMini(x = cfg().mini?.x, y = cfg().mini?.y) {
    if (!mini?.isConnected) return;
    const w = mini.offsetWidth || 150, ht = mini.offsetHeight || 80;
    x ??= innerWidth - w - 50;
    y ??= innerHeight - ht - 60;
    mini.style.left = `${Math.max(0, Math.min(innerWidth - w, x))}px`;
    mini.style.top = `${Math.max(0, Math.min(innerHeight - ht, y))}px`;
  }
  addEventListener('resize', () => placeMini());
  function toggleMini(on = !miniOn()) {
    save({ mini: { ...(cfg().mini || {}), on } });
    updateMini();
    for (const f of subs) { try { f(); } catch { /* a closed view */ } }
  }
  /** Drag to move; let go on the right sidebar to put the weather there instead; a click opens the full view. */
  function dragMini(e) {
    if (e.button !== 0 || e.target.closest('.wx-mini-x')) return;
    e.preventDefault();
    const m = mini, rail = document.getElementById('rightrail');
    const sx = e.clientX, sy = e.clientY, r = m.getBoundingClientRect();
    const dx = sx - r.left, dy = sy - r.top;
    let dragging = false;
    try { m.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const overRail = (x, y) => { const q = rail.getBoundingClientRect(); return x >= q.left - 20 && x <= q.right + 20 && y >= q.top && y <= q.bottom; };
    const move = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        dragging = true;
        m.classList.add('dragging');
        rail.classList.add('fling-target');
      }
      placeMini(ev.clientX - dx, ev.clientY - dy);
      if (rail.classList.contains('rail-empty')) rail.classList.toggle('peek', ev.clientX > innerWidth - 260);
      rail.classList.toggle('fling-hot', overRail(ev.clientX, ev.clientY));
      app.railMarker?.(ev, btn);
    };
    const up = (ev) => {
      m.removeEventListener('pointermove', move);
      m.removeEventListener('pointerup', up);
      m.removeEventListener('pointercancel', up);
      rail.classList.remove('fling-target', 'fling-hot', 'peek');
      m.classList.remove('dragging');
      app.railMarker?.(null, btn);
      if (!dragging) { app.newDocument('weather'); return; }
      if (overRail(ev.clientX, ev.clientY)) {
        toggleMini(false);
        app.setToolDock?.('btn-weather', true, { drop: ev });
        return;
      }
      const q = m.getBoundingClientRect();
      save({ mini: { on: true, x: Math.round(q.left), y: Math.round(q.top) } });
    };
    m.addEventListener('pointermove', move);
    m.addEventListener('pointerup', up);
    m.addEventListener('pointercancel', up);
  }
  updateMini();

  return {
    get data() { return current(); }, get error() { return err; }, get place() { return place(); }, get unit() { return unit(); },
    refresh, setPlace, unitToggle, hoursRow, daysList, details, toggleMini, get miniOn() { return miniOn(); },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    show, hide,
  };
}
