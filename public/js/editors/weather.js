// Weather: the full view of the place picked in the weather button (core/weather.js): now, a 24-hour temperature
// line, and the week. It follows the button: changing the place or °F/°C in either changes both.

import { BaseEditor } from './base.js';
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { describe, deg, placeName, placeSearch } from '../core/weather.js';

export class WeatherEditor extends BaseEditor {
  static mode = 'weather';

  async load() {
    this.wx = this.app.weather;
    this.body = h('div', { class: 'wx-full' });
    this.pane.append(h('div', { class: 'wx-root' }, this.body));
    this.off = this.wx?.subscribe(() => this.render());
    this.render();
    this.wx?.refresh();
  }

  clock(opts) { return new Intl.DateTimeFormat(undefined, { hour12: !this.app.settings.clock24, timeZone: this.wx.data?.tz, ...opts }); }

  render() {
    const b = clear(this.body);
    const wx = this.wx;
    if (!wx) { b.append(h('div', { class: 'empty-note' }, 'Weather isn’t available in this window.')); return; }
    const p = wx.place, d = wx.data;
    const s = placeSearch((np) => wx.setPlace(np), { placeholder: p ? 'Change place…' : 'Search for a town or city' });
    b.append(h('div', { class: 'wx-bar' },
      h('div', { class: 'wx-bar-place' }, p ? placeName(p) : 'Weather'),
      h('div', { class: 'grow' }),
      s.el, wx.unitToggle(),
      h('button', { class: 'btn sm', title: 'Refresh', onclick: () => wx.refresh(true) }, icon('refresh', 'sm')),
      h('button', { class: 'btn sm', onclick: () => { wx.toggleMini(); this.render(); } }, icon('external', 'sm'), wx.miniOn ? 'Close widget' : 'Pop out widget')));
    if (!p) { b.append(h('div', { class: 'wx-empty' }, icon('cloud-sun'), h('div', {}, 'Search for a place above to see its weather.'))); setTimeout(() => s.input.focus(), 0); return; }
    if (!d) {
      b.append(h('div', { class: 'wx-empty' }, icon('cloud'), h('div', {}, wx.error || 'Loading…'),
        wx.error ? h('button', { class: 'btn', onclick: () => wx.refresh(true) }, 'Try again') : null));
      return;
    }

    // now
    const w = describe(d.current.code, d.current.day);
    const today = d.daily[0] || {};
    const fmtT = this.clock({ hour: 'numeric', minute: '2-digit' });
    b.append(h('div', { class: 'wx-hero' },
      h('span', { class: 'wx-hero-icon' }, icon(w.icon)),
      h('div', { class: 'wx-hero-temp mono' }, deg(d.current.temp)),
      h('div', { class: 'wx-hero-text' },
        h('div', { class: 'wx-hero-label' }, w.label),
        h('div', {}, `High ${deg(today.hi)} · Low ${deg(today.lo)}`),
        h('div', { class: 'faint' }, wx.details(d)),
        today.sunrise ? h('div', { class: 'faint' }, `Sunrise ${fmtT.format(today.sunrise)} · Sunset ${fmtT.format(today.sunset)}`) : null)));

    // the next 24 hours: a temperature line over the hours
    const hrs = d.hourly.slice(0, 24);
    if (hrs.length > 1) {
      const W = 1000, H = 120, pad = 18;
      const lo = Math.min(...hrs.map((x) => x.temp)), hi = Math.max(...hrs.map((x) => x.temp));
      const xAt = (i) => (i + 0.5) * (W / hrs.length), yAt = (t) => pad + (1 - (t - lo) / (hi - lo || 1)) * (H - pad * 2);
      const pts = hrs.map((x, i) => `${xAt(i).toFixed(1)},${yAt(x.temp).toFixed(1)}`).join(' ');
      const svg = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="wx-line">`
        + `<polygon class="wx-line-fill" points="${xAt(0)},${H} ${pts} ${xAt(hrs.length - 1)},${H}"/><polyline class="wx-line-stroke" points="${pts}"/></svg>`, 'image/svg+xml').documentElement;
      const fmtH = this.clock({ hour: 'numeric' });
      b.append(h('div', { class: 'wx-card' }, h('div', { class: 'clock-sec-title' }, 'Next 24 hours'),
        h('div', { class: 'wx-chart' }, document.importNode(svg, true),
          h('div', { class: 'wx-chart-cols', style: { gridTemplateColumns: `repeat(${hrs.length}, minmax(40px, 1fr))` } }, hrs.map((x, i) => {
            const hw = describe(x.code, x.day);
            return h('div', { class: 'wx-col', title: `${hw.label}${x.pop ? ` · ${x.pop}% chance of rain` : ''}` },
              h('b', { class: 'mono' }, deg(x.temp)), h('span', { class: 'wx-col-gap' }), icon(hw.icon),
              h('span', { class: 'wx-pop' }, x.pop >= 20 ? `${x.pop}%` : ''), h('span', { class: 'faint' }, i === 0 ? 'Now' : fmtH.format(x.t)));
          })))));
    }

    // the week
    const fmtD = this.clock({ weekday: 'long' }), fmtDate = this.clock({ month: 'short', day: 'numeric' });
    b.append(h('div', { class: 'wx-card' }, h('div', { class: 'clock-sec-title' }, '7 days'),
      h('div', { class: 'wx-week' }, d.daily.map((x, i) => {
        const dw = describe(x.code, true);
        return h('div', { class: 'wx-dcard', title: dw.label },
          h('b', {}, i === 0 ? 'Today' : fmtD.format(x.t)), h('span', { class: 'faint' }, fmtDate.format(x.t)),
          icon(dw.icon), h('span', {}, dw.label),
          h('span', { class: 'mono' }, h('b', {}, deg(x.hi)), ' / ', h('span', { class: 'faint' }, deg(x.lo))),
          h('span', { class: 'wx-pop' }, x.pop != null ? `${x.pop}% rain` : ''));
      }))));
    b.append(h('div', { class: 'faint wx-credit' }, `Weather data by Open-Meteo.com · updated ${this.clock({ hour: 'numeric', minute: '2-digit', timeZone: undefined }).format(d.at)}`));
    this.refreshStatus();
  }

  status() {
    const d = this.wx?.data;
    return { left: [{ text: this.wx?.place ? placeName(this.wx.place) : 'Weather' }], right: d ? [{ text: describe(d.current.code, d.current.day).label + ' · ' + deg(d.current.temp) }] : [] };
  }

  onShow() { this.wx?.refresh(); }
  destroy() { this.off?.(); }
}
