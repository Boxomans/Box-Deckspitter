// Deep Strike: a strike-planning game reached from the carrier screen of the easter egg. Each mission is an objective
// in the theatre (a real airfield, an air defence site or an industrial complex) inside a made-up air defence
// network. Fly a sniffer around the network's edges to hear its radars, buy a strike package, draw its route (each
// leg at its own height and speed), then fly it in real time (re-routing as it goes) and see what it did.

import { BaseEditor } from './base.js';
import { h, clear } from '../core/dom.js';
import { confirmDialog, toast } from '../core/ui.js';
import { ALTS, ALT_ORDER, SPEEDS, SPEED_ORDER, DECK_MAX_KMH, AIRCRAFT, AIRCRAFT_ORDER, MUNITIONS, SAMS, SNIFFER, TARGETS, AIRFIELD_RADAR, FIGHTERS, HANGAR_MUNITIONS, untargeted, reach, packageKmh } from './strike/data.js';
import { Proj, loadWorld, horizon, dist, toSegment, whereIs, zoneAt, doseRate, arcPoint, inField, STORM_S, DEAD_S, THEATRE } from './strike/geo.js';
import { makeMission, REGIONS, TYPE_NAME, targetName, targetXY, alive, targetHp, lower, isRadar, searchRadars, fcRadars } from './strike/mission.js';
import { SnifferSim, StrikeSim, DT, CLIMB, DESCEND, climbRate } from './strike/sim.js';
import { MapView, COL } from './strike/view.js';
import { briefing } from './strike/story.js';
import { Terrain, BIOMES, describe } from './strike/terrain.js';
import { levelList, FEATS, KIND_NAME, strikeResult, strikePoints, startPoints, startHangar } from './strike/badges.js';

const PHASES = [['mission', 'MISSION'], ['sniffer', 'SNIFFER'], ['brief', 'BRIEFING'], ['strike', 'STRIKE'], ['debrief', 'DEBRIEF']];
const SPEEDUPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
/** What the game can pause itself for while it flies: [id, label, test(event), on to start with]. */
const PAUSE_ON = [
  ['launch', 'A missile launch', (e) => e.kind === 'warn' && /launch/i.test(e.text), true],
  ['popup', 'A pop-up threat', (e) => /^Pop-up/.test(e.text), true],
  ['detected', 'Detected by a radar', (e) => /^Detected by/.test(e.text), false],
  ['loss', 'A jet lost', (e) => e.kind === 'loss', false],
  ['weapons', 'Weapons away', (e) => /away at the/.test(e.text), false],
  ['kill', 'A target destroyed', (e) => e.kind === 'kill', false],
  ['objective', 'The objective destroyed', (e) => e.kind === 'objective', false],
];
const LEG_COL = { deck: '#6fe08a', low: '#5ec8ff', med: '#c9a8ff', high: '#e8eef3' };
/** Package B's legs, in warm colours so the two routes never get mixed up; its points and jets in orange. */
const LEG_COL_B = { deck: '#ffd166', low: '#ff9f43', med: '#ff7eb6', high: '#ffd9c2' };
const B_COL = '#ff9f43';
const PKG_NAME = ['A', 'B'];
const RING_COL = { long: COL.enemy, medium: COL.medium, short: COL.short };
/** Dead zones in yellow, radiation storms in deep purple: a wash, caution stripes and a solid edge. */
const ZONE_LOOK = {
  dead: { name: 'DEAD ZONE', wash: 'rgba(255,214,0,0.035)', stripe: 'rgba(255,214,0,0.10)', edge: 'rgba(255,214,0,0.6)', text: 'rgba(255,214,0,0.85)' },
  storm: { name: 'RADIATION STORM', wash: 'rgba(98,24,180,0.10)', stripe: 'rgba(140,70,235,0.24)', edge: 'rgba(170,110,255,0.8)', text: '#b48cff' },
};
const stripes = {};
/** A 14 px tile with one diagonal stripe: repeated, it makes caution stripes. */
function stripeTile(ctx, col) {
  if (stripes[col]) return stripes[col];
  const c = new OffscreenCanvas(14, 14), g = c.getContext('2d');
  g.strokeStyle = col; g.lineWidth = 3; g.lineCap = 'square';
  g.beginPath(); g.moveTo(-2, 16); g.lineTo(16, -2); g.moveTo(-9, 9); g.lineTo(9, -9); g.moveTo(5, 23); g.lineTo(23, 5); g.stroke();
  return (stripes[col] = ctx.createPattern(c, 'repeat'));
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const money = (m) => `$${m >= 10 ? (Math.round(m * 10) / 10).toLocaleString('en-US') : m.toFixed(2)}M`;
const clock = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** How much of a jet's fuel a route takes (1 = all of it); terrain following over hills and mountains costs extra. */
export function fuelUse(route, type, terrain) {
  let f = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1], L = dist(a, b), m = ALTS[a.alt].m;
    let ground = 1;
    if (terrain && m < 600) {
      const n = Math.max(1, Math.ceil(L / 5));
      ground = 0;
      for (let k = 0; k < n; k++) ground += terrain.effect(a.x + ((b.x - a.x) * (k + 0.5)) / n, a.y + ((b.y - a.y) * (k + 0.5)) / n, m).burn / n;
    }
    f += (L * ALTS[a.alt].burn * SPEEDS[a.spd].burn * ground) / AIRCRAFT[type].range;
  }
  return f;
}
const routeKm = (route) => route.slice(1).reduce((n, p, i) => n + dist(route[i], p), 0);
/** How many of a weapon go on one of this jet's stations (a bomber's bay takes more). */
const loadOf = (a, id) => MUNITIONS[id].per * (AIRCRAFT[a.type].bay || 1);
const stationCost = (st, a) => (st.mu ? MUNITIONS[st.mu].cost * loadOf(a, st.mu) : 0);
const jetCost = (a) => AIRCRAFT[a.type].cost + a.stations.reduce((n, s) => n + stationCost(s, a), 0);

/** The strike's clock along a route, flown the way the strike flies it: the slowest jet's pace, the deck speed
 *  cap, climbing and descending, speeding up and slowing down. { pts: [{ t, x, y, alt, kmh, leg }] every 2 s,
 *  at: [seconds into the strike at each point] }. Kept for the last few routes, since the map asks every frame. */
const timeCache = new Map();
function timeline(route, types = []) {
  const key = JSON.stringify([route.map((p) => [p.x, p.y, p.alt, p.spd]), types]);
  let out = timeCache.get(key);
  if (out) return out;
  const p0 = route[0];
  let x = p0.x, y = p0.y, alt = ALTS[p0.alt].m, kmh = packageKmh(types, p0.spd), t = 0, leg = 0, n = 0;
  const at = [0], pts = [{ t, x, y, alt, kmh, leg }];
  while (leg < route.length - 1 && t < 172800) {
    const a = route[leg], wantAlt = ALTS[a.alt].m;
    alt = alt < wantAlt ? Math.min(wantAlt, alt + climbRate(CLIMB, kmh) * DT) : Math.max(wantAlt, alt - climbRate(DESCEND, kmh) * DT);
    let want = packageKmh(types, a.spd);
    if (alt < 400) want = Math.min(want, DECK_MAX_KMH);
    kmh += Math.sign(want - kmh) * Math.min(Math.abs(want - kmh), 20 * DT);
    let step = (kmh / 3600) * DT;
    t += DT;
    while (step > 0 && leg < route.length - 1) {
      const b = route[leg + 1], d = Math.hypot(b.x - x, b.y - y);
      if (d <= step) { x = b.x; y = b.y; step -= d; at[++leg] = t; }
      else { x += ((b.x - x) / d) * step; y += ((b.y - y) / d) * step; step = 0; }
    }
    if (++n % 4 === 0 || leg >= route.length - 1) pts.push({ t, x, y, alt, kmh, leg: Math.min(leg, route.length - 2) });
  }
  out = { pts, at };
  if (timeCache.size > 24) timeCache.delete(timeCache.keys().next().value);
  timeCache.set(key, out);
  return out;
}

/** Where along the route a weapon first gets within reach of a point: { t, x, y, alt, kmh, leg } or null. Follows the
 *  jets' real height and speed (reach grows with both), the way the strike flies it. */
function releasePoint(route, at, mu, types = []) {
  for (const p of timeline(route, types).pts) if (dist(p, at) <= reach(mu, p.alt, p.kmh)) return p;
  return null;
}

export class StrikeEditor extends BaseEditor {
  static mode = 'strike';

  async load() {
    this.canvas = h('canvas', { class: 'ds-canvas', tabindex: '0' });
    this.panel = h('div', { class: 'ds-panel' });
    this.top = h('div', { class: 'ds-top' });
    this.root = h('div', { class: 'ds-root', 'data-no-clip': '' }, this.top, h('div', { class: 'ds-body' }, (this.mapwrap = h('div', { class: 'ds-mapwrap' }, this.canvas, (this.tip = h('div', { class: 'ds-tip', hidden: true })), (this.legend = h('div', { class: 'ds-legend', hidden: true })))), this.panel));
    this.pane.append(this.root);
    this.proj = new Proj();
    this.view = new MapView(this.canvas, { onDraw: (ctx, v) => this.drawLayers(ctx, v) });
    this.speed = 8;
    this.paused = true;
    this.sel = null;
    this.active = 0; // the package Shift+click draws for: picked by clicking its section in the panel
    this.wire();
    this.ro = new ResizeObserver(() => { this.view.resize(); });
    this.ro.observe(this.canvas);
    this.view.resize();
    this.panel.append(h('div', { class: 'ds-note' }, 'Loading the theatre…'));
    try { this.world = await loadWorld(this.proj); } catch (e) { clear(this.panel).append(h('div', { class: 'ds-note' }, `The map didn’t load: ${e.message}`)); return; }
    this.world.terrain ||= new Terrain(this.world, this.proj);
    this.terrain = this.world.terrain;
    this.showTerrain = !!this.store().terrain;
    this.wantRegion = REGIONS[this.store().region] ? this.store().region : undefined;
    this.wantSize = this.store().size === 'large' ? 'large' : 'normal';
    if (this.store().points == null) this.save({ points: startPoints(this.store()) });
    if (this.store().hangar == null) this.save({ hangar: startHangar(this.store()), unlocked: undefined });
    this.view.setWorld(this.world);
    this.renderLegend();
    const cur = this.store().cur;
    if (cur?.mission?.v === 1) {
      this.mission = cur.mission;
      this.pkgs = [cur.pkg || [], cur.pkg2 || []];
      this.routes = [cur.route || null, cur.route2 || null];
      this.setPhase(cur.phase === 'brief' ? 'brief' : cur.phase === 'sniffer' ? 'sniffer' : 'mission', { keep: true });
    } else this.newMission();
  }

  // ---------------------------------------------------------------- saving (settings.tomcatStrike: goes with the setup export)

  store() { return this.app.settings.tomcatStrike || {}; }
  save(patch) { this.app.saveSettings({ tomcatStrike: { ...this.store(), ...patch } }); }
  saveCur() {
    if (!this.mission) return;
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => this.save({ cur: { mission: this.plan || this.mission, phase: this.phase === 'strike' || this.phase === 'debrief' ? 'brief' : this.phase, pkg: this.pkgs[0], route: this.routes[0], pkg2: this.pkgs[1], route2: this.routes[1] } }), 400);
  }

  // ---------------------------------------------------------------- phases

  newMission(type) {
    this.stopLoop();
    this.mission = makeMission(this.world, this.proj, undefined, type || this.wantType, this.wantRegion, this.wantSize);
    this.pkgs = [[], []];
    this.routes = [null, null];
    this.active = 0;
    this.plan = null;
    this.setPhase('mission');
  }

  setPhase(p, { keep = false } = {}) {
    this.stopLoop();
    this.phase = p;
    this.sel = null;
    if (p !== 'debrief') this.sim = null;
    if (p !== 'strike' && p !== 'debrief') this.live = null;
    this.paused = true;
    const m = this.mission;
    if (p === 'sniffer') {
      this.sim = new SnifferSim(m);
      this.sim.onEvent = (e) => this.onEvent(e);
      this.speed = Math.max(this.speed, 8);
    }
    if (p === 'brief') {
      for (const k of [0, 1]) if (!this.routes[k]) this.routes[k] = [{ ...m.origin, alt: 'med', spd: 'cruise' }, { ...m.origin, alt: 'med', spd: 'cruise', home: true }];
      this.plan = null;
    }
    if (p === 'strike') {
      this.plan = clone({ mission: m, pkg: this.pkgs[0], route: this.routes[0], pkg2: this.pkgs[1], route2: this.routes[1] });
      this.live = clone(m);
      this.sim = new StrikeSim(this.live, clone(this.pkgs[0]), this.routes[0], this.terrain, clone(this.pkgs[1]), this.routes[1]);
      for (const f of this.sim.flights) this.routes[f.k] = f.route; // re-routing in flight edits the sim's own copy
      if (!this.sim.flight(this.active) && this.sim.flights[0]) this.active = this.sim.flights[0].k;
      this.sim.onEvent = (e) => this.onEvent(e);
      this.sim.onLeg = () => this.renderPanel();
      this.speed = Math.min(this.speed, 4);
    }
    if (p === 'debrief') this.record();
    if (!keep || p !== 'strike') this.fitView();
    this.renderTop();
    this.renderPanel();
    this.view.request();
    if (this.app.active === this.tab) this.app.updateStatus(this.tab);
    if (p !== 'strike' && p !== 'debrief') this.saveCur();
  }

  /** Route k's radiation, flown at package k's pace: { dose (1 = lethal), storm, dead (seconds in each) }. */
  radiation(k) {
    const zones = this.mission.zones || [], pts = timeline(this.routes[k], this.pkgs[k].map((a) => a.type)).pts, out = { dose: 0, storm: 0, dead: 0 };
    for (let i = 1; i < pts.length; i++) {
      const z = zoneAt(zones, pts[i].x, pts[i].y);
      if (!z) continue;
      const dt = pts[i].t - pts[i - 1].t;
      out.dose += doseRate(z) * dt;
      out[z.storm ? 'storm' : 'dead'] += dt;
    }
    return out;
  }

  fitView() {
    const m = this.mission;
    const pts = [m.origin, ...m.sites.filter((s) => m.known[s.id] || this.phase === 'debrief')];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const pad = this.phase === 'sniffer' ? 220 : 90;
    this.view.fit(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
  }

  /** Stats for the record (and the carrier screen). */
  record() {
    const st = { ...(this.store().stats || {}) };
    const s = this.sim;
    st.flown = (st.flown || 0) + 1;
    if (s.objectiveDone()) st.won = (st.won || 0) + 1;
    st.jetsLost = (st.jetsLost || 0) + s.lost.length;
    st.spent = Math.round(((st.spent || 0) + s.used + s.lost.reduce((n, l) => n + l.jet.A.cost, 0)) * 100) / 100;
    const r = strikeResult(this.plan, s, [...this.plan.pkg, ...(this.plan.pkg2 || [])].reduce((n, a) => n + jetCost(a), 0));
    if (r.won && !r.lost) st.flawless = (st.flawless || 0) + 1;
    if (r.won && this.plan.mission.region && !(st.regions || []).includes(this.plan.mission.region)) st.regions = [...(st.regions || []), this.plan.mission.region];
    this.useHangarMunitions(s);
    this.loseHangarJets(s);
    this.trimHangarMunitions();
    this.save({ stats: st, cur: { mission: this.plan.mission, phase: 'brief', pkg: this.plan.pkg, route: this.plan.route, pkg2: this.plan.pkg2 || [], route2: this.plan.route2 || null } });
    const badges = this.awardBadges(r);
    // points for the hangar; a mission already destroyed once pays only for flying it
    const m = this.plan.mission, key = `${m.seed}:${m.type || ''}:${m.region || ''}:${m.size}`, wonList = this.store().wonMissions || [];
    this.earned = strikePoints(r, m.size === 'large', wonList.includes(key), badges);
    const total = this.earned.reduce((n, [, p]) => n + p, 0);
    this.save({ points: this.points() + total, ...(r.won && !wonList.includes(key) ? { wonMissions: [...wonList, key].slice(-200) } : {}) });
    toast(`+${total} points · ${this.points().toLocaleString('en-US')} to spend in the hangar`, { type: 'ok', timeout: 5000 });
  }

  /** Points to spend, and the hangar: how many of each hangar jet and hangar munition are owned (kept between missions
   *  until lost, or for a munition, fired). */
  points() { return this.store().points || 0; }
  owned(id) { return this.store().hangar?.[id] || 0; }
  /** Hangar jets of a type not yet in either package (an ordinary jet: always). */
  spare(id) { return AIRCRAFT[id].points ? this.owned(id) - [...this.pkgs[0], ...this.pkgs[1]].filter((a) => a.type === id).length : Infinity; }
  /** A hangar munition not yet loaded in either package (any other munition: always). */
  spareMu(id) { return MUNITIONS[id].points ? this.owned(id) - this.loaded(this.pkgs.flat(), id) : Infinity; }
  loaded(jets, id) { return jets.reduce((n, a) => n + a.stations.reduce((k, s) => k + (s.mu === id ? s.n || 0 : 0), 0), 0); }

  async buyJet(id) {
    const A = AIRCRAFT[id] || MUNITIONS[id], jet = !!AIRCRAFT[id];
    if (this.points() < A.points) return;
    const keep = jet ? 'It stays in the hangar from mission to mission (each mission’s budget still pays for flying it) until it’s lost.'
      : id === 'pod' ? 'It stays in the hangar from mission to mission (each mission’s budget still pays for flying it) until the Growler carrying it is lost.'
        : 'It stays in the hangar from mission to mission (each mission’s budget still pays for it) until it’s fired or its jet is lost.';
    if (!(await confirmDialog(`Buy one ${A.name}?`, `${A.points.toLocaleString('en-US')} of your ${this.points().toLocaleString('en-US')} points. ${keep}`, { okLabel: 'Buy' }))) return;
    this.save({ points: this.points() - A.points, hangar: { ...(this.store().hangar || {}), [id]: this.owned(id) + 1 } });
    toast(`${A.name} in the hangar (${this.owned(id)})`, { type: 'ok', timeout: 5000 });
    this.renderPanel();
  }

  /** Hangar munitions fired on the strike, or still on a jet that was lost, are gone. */
  useHangarMunitions(s) {
    const hangar = { ...(this.store().hangar || {}) };
    const flown = [...this.plan.pkg, ...(this.plan.pkg2 || [])];
    for (const id of HANGAR_MUNITIONS) {
      const gone = this.loaded(flown, id) - this.loaded(s.jets.filter((j) => j.alive), id);
      if (gone > 0) hangar[id] = Math.max(0, (hangar[id] || 0) - gone);
    }
    this.save({ hangar });
  }

  /** The plan flown again can't carry more hangar munitions than are left: the extra stations go empty. */
  trimHangarMunitions() {
    for (const id of HANGAR_MUNITIONS) {
      let left = this.owned(id);
      for (const a of [...this.plan.pkg, ...(this.plan.pkg2 || [])]) for (const st of a.stations) {
        if (st.mu !== id) continue;
        if (left >= st.n) left -= st.n; else Object.assign(st, { mu: null, n: 0, target: null });
      }
    }
  }

  /** A hangar jet lost on the strike is gone: off the hangar's count and out of the plan flown again. */
  loseHangarJets(s) {
    const gone = s.lost.map((l) => l.jet).filter((j) => j.A.points);
    if (!gone.length) return;
    const hangar = { ...(this.store().hangar || {}) };
    for (const j of gone) hangar[j.type] = Math.max(0, (hangar[j.type] || 0) - 1);
    const drop = (pk, k) => pk?.filter((a, i) => !gone.some((j) => j.f.k === k && j.f.jets.indexOf(j) === i));
    this.plan.pkg = drop(this.plan.pkg, 0);
    this.plan.pkg2 = drop(this.plan.pkg2, 1) || [];
    this.save({ hangar });
    for (const type of new Set(gone.map((j) => j.type))) {
      const n = gone.filter((j) => j.type === type).length;
      toast(`${n > 1 ? `${n} ${AIRCRAFT[type].name}s` : `The ${AIRCRAFT[type].name}`} lost: ${hangar[type] || 'none'} left in the hangar`, { type: 'warn', timeout: 6000 });
    }
  }

  /** HANGAR: the points to spend and the jets owned, each bought one at a time. */
  hangarSection() {
    const pts = this.points();
    const rows = [...AIRCRAFT_ORDER.filter((id) => AIRCRAFT[id].points), ...HANGAR_MUNITIONS].map((id) => {
      const A = AIRCRAFT[id] || MUNITIONS[id], n = this.owned(id);
      return h('div', { class: `ds-kv ds-hangar${n ? ' on' : ''}`, title: A.what },
        h('span', {}, `${A.name}${n ? ` ×${n}` : ''}`),
        h('button', { class: 'ds-btn sm', disabled: pts < A.points, onclick: () => this.buyJet(id) }, `BUY · ${A.points.toLocaleString('en-US')} pts`));
    });
    return this.section(`HANGAR · ${pts.toLocaleString('en-US')} POINTS`,
      h('div', { class: 'faint sm' }, 'Strikes earn points: more for destroying the objective and bringing everyone home, double on large missions, and for each new badge. A jet or NGJ pod bought here is kept from mission to mission until it’s lost, a Mako until it’s fired; each mission’s budget still pays for them.'),
      ...rows);
  }

  /** Levels and feats this strike earned: saved, and a toast for each. */
  awardBadges(r) {
    const got = { ...(this.store().badges || {}) };
    const lv = levelList({ ...this.store(), badges: got }).filter((b) => !b.earned && b.have >= b.goal);
    const ft = FEATS.filter((f) => !got[f.id] && f.test(r));
    if (!lv.length && !ft.length) return 0;
    for (const b of [...lv, ...ft]) got[b.id] = Date.now();
    this.save({ badges: got });
    const level = (b) => levelList(this.store()).filter((x) => x.kind === b.kind).findIndex((x) => x.id === b.id) + 1;
    const lines = [...lv.map((b) => `★ Badge LV ${level(b)}: ${b.name} — ${b.what}`), ...ft.map((f) => `★ ${f.name} — ${f.what}`)];
    if (lines.length > 3) toast(`★ ${lines.length} badges: ${[...lv, ...ft].map((b) => b.name).join(', ')}`, { type: 'ok', timeout: 8000 }); // a pile at once: one toast
    else for (const l of lines) toast(l, { type: 'ok', timeout: 6000 });
    return lines.length;
  }

  /** BADGES: a row per level kind (LV n / N, hover for the list), then the feats, lit once earned. */
  badgeSection() {
    const store = this.store(), list = levelList(store), got = store.badges || {};
    const n = list.filter((b) => b.earned).length + FEATS.filter((f) => got[f.id]).length;
    const rows = [...new Set(list.map((b) => b.kind))].map((k) => {
      const tiers = list.filter((b) => b.kind === k), done = tiers.filter((b) => b.earned);
      const last = done[done.length - 1], next = tiers.find((b) => !b.earned);
      return h('div', { class: `ds-badge${last ? ' on' : ''}`, title: tiers.map((b, i) => `LV ${i + 1} ${b.name}: ${b.what}${b.earned ? ` · earned ${new Date(b.earned).toLocaleDateString()}` : ''}`).join('\n') },
        h('div', { class: 'ds-kv' }, h('span', {}, `${last ? '★' : '☆'} ${KIND_NAME[k]}${last ? ` · ${last.name}` : ''}`), h('b', {}, `LV ${done.length} / ${tiers.length}`)),
        next ? h('div', { class: 'ds-badge-bar' }, h('span', { style: { width: `${Math.floor((next.have / next.goal) * 100)}%` } })) : null,
        h('div', { class: 'faint sm' }, next ? `Next: ${next.name}, ${next.what} (${next.have} / ${next.goal})` : 'Every level earned'));
    });
    const feats = h('div', { class: 'ds-feats' }, ...FEATS.map((f) => h('span', {
      class: `ds-feat${got[f.id] ? ' on' : ''}`, title: `${f.what}${got[f.id] ? ` · earned ${new Date(got[f.id]).toLocaleDateString()}` : ''}`,
    }, `${got[f.id] ? '★' : '☆'} ${f.name}`)));
    return this.section(`BADGES (${n} of ${list.length + FEATS.length})`, ...rows, h('div', { class: 'ds-h2' }, 'FEATS'), feats);
  }

  // ---------------------------------------------------------------- the loop

  startLoop() {
    if (this.raf) return;
    let last = performance.now(), acc = 0;
    const tick = (now) => {
      this.raf = requestAnimationFrame(tick);
      const real = Math.min(0.25, (now - last) / 1000);
      last = now;
      if (this.paused || !this.sim || this.sim.done) { this.view.request(); return; }
      acc += real * this.speed;
      let n = 0;
      while (acc >= DT && n < 600 && !this.sim.done && !this.paused) { this.sim.step(DT); acc -= DT; n++; }
      if (this.sim.done) this.finished();
      this.view.paint();
      if (now - (this.panelAt || 0) > 500) { this.panelAt = now; this.refreshLive(); }
    };
    this.raf = requestAnimationFrame(tick);
  }
  stopLoop() { cancelAnimationFrame(this.raf); this.raf = 0; }
  setPaused(p) {
    if (!this.sim || this.sim.done) return;
    this.paused = p;
    if (!p) this.startLoop();
    this.renderTop();
    this.renderPanel();
  }

  onEvent(e) {
    const on = this.pauseOn();
    if (!this.paused && PAUSE_ON.some(([id, , test]) => on[id] && test(e))) { this.paused = true; this.renderTop(); this.renderPanel(); }
    this.logDirty = true;
  }

  finished() {
    this.paused = true;
    this.renderTop();
    this.renderPanel();
  }

  // ---------------------------------------------------------------- the top strip

  renderTop() {
    const at = PHASES.findIndex(([id]) => id === this.phase);
    const steps = PHASES.map(([id, label], i) => h('span', { class: `ds-step${i === at ? ' on' : i < at ? ' done' : ''}` }, label));
    const live = this.phase === 'sniffer' || this.phase === 'strike';
    const ctl = live && this.sim && !this.sim.done ? [
      h('button', { class: `ds-btn ds-play${this.paused ? '' : ' on'}`, title: 'Run / pause (Space)', onclick: () => this.setPaused(!this.paused) }, this.paused ? '▶ RUN' : '❚❚ PAUSE'),
      this.speedButton(),
      this.pauseButton(),
    ] : [];
    this.clockEl = h('span', { class: 'ds-clock' }, this.sim ? clock(this.sim.t) : '');
    clear(this.top).append(h('span', { class: 'ds-title' }, 'DEEP STRIKE'), h('span', { class: 'ds-code' }, `OBJECTIVE ${this.mission?.code || ''}`),
      h('div', { class: 'ds-steps' }, ...steps), h('div', { class: 'grow' }),
      h('button', { class: `ds-btn sm${this.showTerrain ? ' on' : ''}`, title: 'Terrain overlay (T): the biomes, and what each does to a low package. Hover the map to see.', onclick: () => this.toggleTerrain() }, 'TERRAIN'),
      ...ctl, this.clockEl);
  }

  /** One button for the time speed: click or scroll up for faster, right-click or scroll down for slower. */
  /** Which events pause the game (saved): { id: true/false }, the defaults filled in. */
  pauseOn() { return { ...Object.fromEntries(PAUSE_ON.map(([id, , , d]) => [id, d])), ...(this.store().pauseOn || {}) }; }

  /** AUTO-PAUSE ▾: a small menu of the events the game stops for. It stays open while you tick them. */
  pauseButton() {
    const n = Object.values(this.pauseOn()).filter(Boolean).length;
    const b = h('button', { class: `ds-btn ds-pause-btn${this.pauseMenu ? ' on' : ''}`, title: 'Choose what pauses the game while it flies' }, `AUTO-PAUSE (${n}) ▾`);
    b.addEventListener('click', () => (this.pauseMenu ? this.closePauseMenu() : this.openPauseMenu(b)));
    return b;
  }
  openPauseMenu(btn) {
    const on = this.pauseOn();
    const menu = h('div', { class: 'ds-pop' }, h('div', { class: 'ds-h2' }, 'PAUSE THE GAME ON'),
      ...PAUSE_ON.map(([id, label]) => h('label', { class: 'ds-check' }, h('input', {
        type: 'checkbox', checked: !!on[id], onchange: (e) => { this.save({ pauseOn: { ...this.pauseOn(), [id]: e.target.checked } }); this.renderTop(); },
      }), label)));
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(innerWidth - 230, r.left))}px`;
    menu.style.top = `${r.bottom + 4}px`;
    document.body.append(menu);
    this.pauseMenu = menu;
    this.pauseAway = (e) => { if (!menu.contains(e.target) && !e.target.closest?.('.ds-pause-btn')) this.closePauseMenu(); };
    setTimeout(() => addEventListener('pointerdown', this.pauseAway, true));
    btn.classList.add('on');
  }
  closePauseMenu() {
    this.pauseMenu?.remove();
    this.pauseMenu = null;
    removeEventListener('pointerdown', this.pauseAway, true);
    this.renderTop();
  }

  speedButton() {
    const b = h('button', { class: 'ds-btn ds-speed', title: 'Time speed · click or scroll up: faster · right-click or scroll down: slower' }, `${this.speed}×`);
    const step = (d) => {
      const i = Math.max(0, Math.min(SPEEDUPS.length - 1, SPEEDUPS.indexOf(this.speed) + d));
      this.speed = SPEEDUPS[i];
      b.textContent = `${this.speed}×`;
    };
    b.addEventListener('click', () => step(1));
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); step(-1); });
    b.addEventListener('wheel', (e) => { e.preventDefault(); step(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    return b;
  }

  // ---------------------------------------------------------------- the side panel

  renderPanel() {
    if (!this.mission) return;
    const top = this.panel.scrollTop;
    const body = this[`panel_${this.phase}`]();
    clear(this.panel).append(...body.filter(Boolean));
    this.panel.scrollTop = top;
    this.logDirty = false;
    this.panelFull = performance.now();
  }
  refreshLive() {
    if (this.clockEl && this.sim) this.clockEl.textContent = clock(this.sim.t);
    // rebuilt when something happens (or every few seconds for fuel); in between only the live numbers change, so
    // a click on the panel's buttons isn't lost to a redraw
    if (this.panel.matches(':active')) return;
    if (this.logDirty || (this.phase === 'strike' && performance.now() - (this.panelFull || 0) > 3000)) this.renderPanel();
    else for (const [el, f] of this.nowEls || []) el.textContent = `${Math.round(f.pos.alt)} m · ${Math.round(f.pos.kmh)} km/h`;
  }

  section(title, ...kids) { return h('div', { class: 'ds-sec' }, title ? h('div', { class: 'ds-h' }, title) : null, ...kids); }

  objectiveLine() {
    const m = this.mission, s = m.sites.find((x) => x.id === m.primary);
    return h('div', { class: 'ds-obj' }, h('span', { class: 'ds-star' }, '★'), ' ', targetName(s.targets[m.objective.idx]), h('span', { class: 'faint' }, ` · ${s.name}`));
  }

  panel_mission() {
    const m = this.mission, s = m.sites.find((x) => x.id === m.primary);
    const st = this.store().stats || {};
    const typeSel = h('select', { class: 'ds-sel' }, ...[['', 'Any objective'], ['airbase', 'Air base'], ['sam', 'Air defence site'], ['industry', 'Industrial complex']].map(([v, t]) => h('option', { value: v }, t)));
    typeSel.value = this.wantType || '';
    typeSel.addEventListener('change', () => { this.wantType = typeSel.value || undefined; });
    const regionSel = h('select', { class: 'ds-sel' }, h('option', { value: '' }, 'Any region'), ...Object.entries(REGIONS).map(([v, t]) => h('option', { value: v }, t)));
    regionSel.value = this.wantRegion || '';
    regionSel.addEventListener('change', () => { this.wantRegion = regionSel.value || undefined; this.save({ region: this.wantRegion }); });
    const sizeSel = h('select', { class: 'ds-sel' }, h('option', { value: 'normal' }, 'Normal mission'), h('option', { value: 'large' }, 'Large mission: more sites, 3× the budget'));
    sizeSel.value = this.wantSize;
    sizeSel.addEventListener('change', () => { this.wantSize = sizeSel.value; this.save({ size: this.wantSize }); });
    const story = briefing(m, { place: s.name, where: whereIs(this.world, s, 30000), sam: s.sam ? SAMS[s.sam].long : null, budget: money(m.budget) });
    return [
      this.section('BRIEFING', ...story.map((p) => h('p', { class: 'ds-story' }, p))),
      this.section(`${TYPE_NAME[m.type].toUpperCase()}`, h('div', { class: 'ds-big' }, s.name), / of /.test(s.name) ? null : h('div', { class: 'faint' }, whereIs(this.world, s, 30000)),
        m.region ? h('div', { class: 'ds-kv' }, h('span', {}, 'Region'), h('b', {}, REGIONS[m.region])) : null,
        m.size === 'large' ? h('div', { class: 'ds-kv' }, h('span', {}, 'Size'), h('b', {}, 'Large')) : null,
        h('div', { class: 'ds-kv' }, h('span', {}, 'Primary target'), this.objectiveLine()),
        h('div', { class: 'ds-kv' }, h('span', {}, 'Budget'), h('b', {}, money(m.budget))),
        h('div', { class: 'ds-kv' }, h('span', {}, 'From the origin'), h('b', {}, `${Math.round(dist(m.origin, s))} km`))),
      this.section('INSIDE THE OBJECTIVE', ...this.targetSummary(s)),
      this.section('HOW IT GOES', h('div', { class: 'ds-note' },
        'Fly the sniffer first: it hears the radars around the objective and marks each one with its type and reach. Then buy jets and weapons, draw the route (each leg at its own height and speed) and fly it. ',
        'Low legs hide behind the curve of the earth until a radar is close; high legs see further and throw weapons further, but every radar sees them.')),
      this.section(null, h('div', { class: 'ds-row' }, regionSel, sizeSel), h('div', { class: 'ds-row' }, typeSel, h('button', { class: 'ds-btn', onclick: () => this.newMission() }, 'NEW MISSION')),
        h('button', { class: 'ds-btn primary wide', onclick: () => this.setPhase('sniffer') }, 'FLY THE SNIFFER →')),
      st.flown ? this.section('RECORD', h('div', { class: 'ds-note' }, `${st.flown} flown · ${st.won || 0} objectives destroyed · ${st.jetsLost || 0} jets lost · ${money(st.spent || 0)} spent`)) : null,
      this.hangarSection(),
      this.badgeSection(),
    ];
  }

  /** The objective's contents, alike ones counted together ("S-400 launcher ×8"); the primary target first. */
  targetSummary(s) {
    const m = this.mission, obj = s.targets[m.objective.idx];
    const counts = new Map();
    for (const t of s.targets) if (t !== obj) counts.set(targetName(t), (counts.get(targetName(t)) || 0) + 1);
    return [h('div', { class: 'ds-trow obj' }, h('span', { class: 'ds-ico' }, '★'), h('span', { class: 'grow' }, targetName(obj)), h('span', { class: 'faint' }, 'primary')),
      ...[...counts].map(([n, c]) => h('div', { class: 'ds-trow' }, h('span', { class: 'ds-ico' }, '·'), h('span', { class: 'grow' }, n), c > 1 ? h('span', { class: 'faint' }, `×${c}`) : null))];
  }

  targetRows(s, { assign } = {}) {
    const m = this.live || this.mission;
    return s.targets.map((t, i) => {
      const obj = m.objective.site === s.id && m.objective.idx === i;
      const dead = this.phase === 'debrief' || this.phase === 'strike' ? !alive(t) : false;
      const hp = t.dmg ? ` ${Math.min(100, Math.round((t.dmg / targetHp(t)) * 100))}%` : '';
      return h('div', { class: `ds-trow${obj ? ' obj' : ''}${dead ? ' dead' : ''}`, onclick: assign ? () => assign(i) : null },
        h('span', { class: 'ds-ico' }, obj ? '★' : dead ? '✕' : '·'), h('span', { class: 'grow' }, targetName(t)), hp ? h('span', { class: 'faint' }, hp) : null);
    });
  }

  panel_sniffer() {
    const s = this.sim, m = this.mission;
    const found = m.sites.filter((x) => m.known[x.id] && x.id !== m.primary);
    const done = s.done;
    return [
      this.section(SNIFFER.name.toUpperCase(),
        h('div', { class: 'ds-note' }, done ? (done.why === 'shot' ? 'The sniffer was shot down. You plan with what it heard.' : done.why === 'rad' ? 'The sniffer’s crew died of radiation. You plan with what it heard.' : 'The sniffer is home.')
          : 'Click the map to fly there (Shift+click adds a waypoint). Every radar it hears goes on the map with its type and reach. Fly into a site’s missile range and it shoots: stay on the edges. The phase ends when it’s back at the origin.'),
        done ? null : h('div', { class: 'ds-row' },
          h('button', { class: 'ds-btn', onclick: () => { s.home(); this.setPaused(false); } }, 'RETURN TO ORIGIN'),
          h('button', { class: 'ds-btn', title: 'Stop here and plan with what it has heard', onclick: () => this.setPhase('brief') }, 'END FLIGHT'),
          h('span', { class: 'faint' }, `${Math.round(s.flown)} km flown`)),
        done ? h('button', { class: 'ds-btn primary wide', onclick: () => this.setPhase('brief') }, 'PLAN THE STRIKE →') : null),
      this.section(`HEARD (${found.length + this.capRows().length})`, ...(found.length ? found.map((x) => this.siteRow(x)) : this.capRows().length ? [] : [h('div', { class: 'faint' }, 'Nothing yet.')]), ...this.capRows()),
      this.logSection(),
    ];
  }

  siteRow(x) {
    const S = x.sam ? SAMS[x.sam] : null;
    return h('div', { class: `ds-srow${this.sel?.site === x.id ? ' on' : ''}`, onclick: () => { this.sel = { site: x.id }; this.renderPanel(); this.view.request(); } },
      h('span', { class: 'ds-dot', style: { background: S ? RING_COL[S.ring] : COL.unknown } }),
      h('span', { class: 'grow' }, S ? S.long : x.name), S ? h('span', { class: 'faint' }, `${S.missile.km} km`) : null);
  }

  /** The debrief's whole log, first event first, folded away until it's opened (and kept open across redraws). */
  fullLog() {
    const log = this.sim?.log || [];
    const { ours, theirs } = this.expended();
    const list = (o) => Object.entries(o).filter(([, n]) => n > 0).map(([k, n]) => `${k} ×${n}`).join(' · ') || 'nothing';
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    const d = h('details', { class: 'ds-sec ds-fulllog' }, h('summary', { class: 'ds-h' }, `FULL LOG (${log.length} event${log.length === 1 ? '' : 's'})`),
      h('div', { class: 'ds-tally' },
        h('div', { class: 'ds-kv' }, h('span', {}, `${this.sim?.flights?.length > 1 ? 'The packages' : 'The package'} fired (${sum(ours)})`), h('b', {}, list(ours))),
        h('div', { class: 'ds-kv' }, h('span', {}, `The defences fired (${sum(theirs)})`), h('b', {}, list(theirs)))),
      ...log.map((e) => h('div', { class: `ds-log ${e.kind}` }, h('span', { class: 'faint' }, clock(e.t)), ' ', e.text)));
    d.open = !!this.logOpen;
    d.addEventListener('toggle', () => { this.logOpen = d.open; });
    return d;
  }

  /** Munitions let go on each side: the package's by weapon (loaded minus what's still on the rails, so a jet lost with
   *  its bombs doesn't count them), the defences' by system (point defence shots included). */
  expended() {
    const ours = {}, theirs = {};
    const left = {};
    for (const j of this.sim?.jets || []) for (const s of j.stations) if (s.mu) left[s.mu] = (left[s.mu] || 0) + (s.n || 0);
    for (const a of [...(this.plan?.pkg || []), ...(this.plan?.pkg2 || [])]) for (const s of a.stations) if (s.mu) ours[MUNITIONS[s.mu].short] = (ours[MUNITIONS[s.mu].short] || 0) + (s.n || MUNITIONS[s.mu].per);
    for (const [mu, n] of Object.entries(left)) ours[MUNITIONS[mu].short] -= n;
    for (const s of this.live?.sites || []) if (s.sam && s.fired) theirs[SAMS[s.sam].long] = (theirs[SAMS[s.sam].long] || 0) + s.fired;
    return { ours, theirs };
  }

  logSection(n = 14) {
    const log = this.sim?.log || [];
    return this.section('LOG', ...log.slice(-n).reverse().map((e) => h('div', { class: `ds-log ${e.kind}` }, h('span', { class: 'faint' }, clock(e.t).slice(3)), ' ', e.text)));
  }

  // ---- briefing

  panel_brief() {
    const m = this.mission;
    const cost = this.pkgs.flat().reduce((n, a) => n + jetCost(a), 0);
    const over = cost > m.budget + 1e-9;
    const flying = [0, 1].filter((k) => this.pkgs[k].length);
    const both = flying.length > 1;
    const worst = flying.flatMap((k) => this.fuels(k)).reduce((a, b) => (b[1] > a[1] ? b : a), ['', 0]);
    const ready = flying.length && !over && flying.every((k) => this.routes[k].length >= 3) && this.podCount() <= this.podMax() && HANGAR_MUNITIONS.every((id) => this.spareMu(id) >= 0);
    const issues = this.planIssues();
    return [
      this.section('BUDGET', h('div', { class: 'ds-budget' }, h('div', { class: `ds-bar${over ? ' over' : ''}`, style: { width: `${Math.min(100, (cost / m.budget) * 100)}%` } })),
        h('div', { class: 'ds-kv' }, h('span', {}, `${money(cost)} of ${money(m.budget)}`), over ? h('b', { class: 'bad' }, 'over budget') : h('span', { class: 'faint' }, `${money(m.budget - cost)} left`)),
        this.objectiveLine()),
      this.packageSection(0), this.packageSection(1),
      this.section('ROUTES', h('div', { class: 'ds-note' }, 'Shift+click the map to add the next turn point (after the selected one) to the package picked above: click a package’s section to pick it. Or click a line to put a point in it; drag points to move them, right-click one to remove it. Click a point to set the height and speed of the leg that starts there, or scroll on it holding Alt for the height, Z for the speed.'),
        ...[0, 1].filter((k) => this.pkgs[k].length || this.routes[k].length > 2).flatMap((k) => [
          h('div', { class: 'ds-kv' }, h('span', { style: k ? { color: B_COL } : null }, `Route ${PKG_NAME[k]}`), h('b', {}, `${Math.round(routeKm(this.routes[k]))} km`)),
          ...this.fuels(k).map(([t, f]) => h('div', { class: 'ds-kv' }, h('span', {}, `Fuel, ${AIRCRAFT[t].name}${both ? ` (${PKG_NAME[k]})` : ''}`), h('b', { class: f > 1 ? 'bad' : f > 0.85 ? 'warn' : '' }, `${Math.round(f * 100)}%`)))]),
        this.legEditor()),
      this.timingSection(),
      issues.length ? this.section('CHECK', ...issues.map((t) => h('div', { class: 'ds-log warn' }, t))) : null,
      this.section(null, h('div', { class: 'ds-row' },
        h('button', { class: 'ds-btn', onclick: () => this.setPhase('mission') }, '← MISSION'),
        h('button', { class: 'ds-btn primary grow', disabled: !ready, onclick: () => this.launch(worst) }, 'LAUNCH THE STRIKE →'))),
    ];
  }

  /** Fuel each jet type in package k needs for its route: [[type, share]]. */
  fuels(k) { return [...new Set(this.pkgs[k].map((a) => a.type))].map((t) => [t, fuelUse(this.routes[k], t, this.terrain)]); }

  /** PACKAGE A / PACKAGE B: its jets and its own "+ Add a jet". */
  packageSection(k) {
    const pk = this.pkgs[k];
    const add = h('select', { class: 'ds-sel' }, h('option', { value: '' }, '+ Add a jet…'),
      ...AIRCRAFT_ORDER.map((id) => { // a locked jet, or one costing more than the whole budget (the B-21 on a normal mission), can't be bought
        const left = this.spare(id), none = left <= 0, no = none || AIRCRAFT[id].cost > this.mission.budget;
        const tag = AIRCRAFT[id].points ? (this.owned(id) ? ` · ${Math.max(0, left)} of ${this.owned(id)} in the hangar` : ' · buy one in the hangar') : '';
        return h('option', { value: id, disabled: no }, `${AIRCRAFT[id].name} · ${money(AIRCRAFT[id].cost)}${tag}${!none && no ? ' · large missions' : ''}`);
      }));
    add.addEventListener('change', () => {
      if (!add.value) return;
      const A = AIRCRAFT[add.value];
      pk.push({ type: A.id, stations: Array.from({ length: A.stations }, () => ({ mu: null, n: 0, target: null })) });
      this.changed();
    });
    return this.pkgFrame(k, this.section(h('span', { style: k ? { color: B_COL } : null }, `PACKAGE ${PKG_NAME[k]} (${pk.length})${this.active === k ? ' · DRAWING' : ''}`),
      h('div', { class: 'faint sm' }, this.active === k ? 'Shift+click the map draws its route.' : `Click here, then Shift+click the map to draw its route.${k ? ' Leave it empty to fly one package.' : ''}`),
      ...pk.map((a, i) => this.jetCard(a, i, k)), add, this.packageSpeed(k)));
  }

  /** A package's panel section: clicking it (anywhere but its controls) makes it the one Shift+click draws for. */
  pkgFrame(k, sec) {
    sec.classList.add('ds-pk');
    if (k) sec.classList.add('b');
    if (this.active === k) sec.classList.add('on');
    sec.addEventListener('click', (e) => { if (!e.target.closest('select, button, input, textarea, label')) this.setActive(k); });
    return sec;
  }

  setActive(k) {
    if (this.active === k) return;
    this.active = k;
    if (this.sel?.node != null && (this.sel.pk || 0) !== k) this.sel = null;
    this.renderPanel();
    this.view.request();
  }

  /** The enemy fighter patrols the sniffer heard, one row each. */
  capRows() {
    return (this.mission.cap || []).filter((c) => c.heard).map((c) => h('div', { class: 'ds-srow' },
      h('span', { class: 'ds-dot', style: { background: COL.enemy } }), h('span', { class: 'grow' }, `CAP: ${c.n}× ${FIGHTERS[c.type].name}`),
      h('span', { class: 'faint' }, `${FIGHTERS[c.type].radar.name} radar`)));
  }

  planIssues() {
    const m = this.mission, out = [];
    const flying = [0, 1].filter((k) => this.pkgs[k].length), both = flying.length > 1;
    if (!flying.length && this.routes[0].length < 3) out.push('Draw a route: Shift+click the map to add turn points.');
    for (const k of flying) if (this.routes[k].length < 3) out.push(`Draw package ${PKG_NAME[k]}’s route: click its section, then Shift+click the map to add turn points.`);
    for (const k of [0, 1]) if (!this.pkgs[k].length && this.routes[k].length > 2 && flying.length) out.push(`Package ${PKG_NAME[k]} has a route but no jets: it stays home.`);
    const heard = (m.cap || []).filter((c) => c.heard);
    if (flying.length && heard.length && !this.pkgs.flat().some((a) => a.stations.some((s) => s.mu && MUNITIONS[s.mu].kind === 'aam')))
      out.push(`Enemy fighters on patrol (${heard.map((c) => `${c.n}× ${FIGHTERS[c.type].name}`).join(', ')}) and no air-to-air missiles in either package.`);
    const pods = this.podCount(), podMax = this.podMax();
    if (pods > podMax) out.push(podMax ? `${pods} NGJ pods: this mission allows ${podMax} (one fewer than its long-range SAM sites).` : 'No NGJ pods this mission: it has too few long-range SAM sites. Take the pod off.');
    for (const id of HANGAR_MUNITIONS) if (this.spareMu(id) < 0) out.push(`${this.loaded(this.pkgs.flat(), id)} ${MUNITIONS[id].short} loaded, ${this.owned(id)} in the hangar: buy more there or take some off.`);
    const objT = m.sites.find((s) => s.id === m.objective.site).targets[m.objective.idx];
    const onObj = this.pkgs.flat().some((a) => a.stations.some((s) => s.mu && s.target?.site === m.objective.site && s.target.idx === m.objective.idx));
    if (flying.length && !onObj) out.push(`No weapon is aimed at the primary target (${lower(targetName(objT))}).`);
    for (const k of flying) {
      const pk = this.pkgs[k], route = this.routes[k];
      for (const [i, a] of pk.entries()) for (const s of a.stations) {
        if (!s.mu || !s.target || s.target === 'auto' || s.mu === 'harm' || s.mu === 'mald' || s.mu === 'pod') continue;
        const site = m.sites.find((x) => x.id === s.target.site), t = site?.targets[s.target.idx];
        if (t && !releasePoint(route, targetXY(site, t), MUNITIONS[s.mu], pk.map((x) => x.type))) out.push(`${AIRCRAFT[a.type].name} ${k ? 'B' : ''}${i + 1}: the ${MUNITIONS[s.mu].short} never gets within reach of the ${lower(targetName(t))} on ${both ? `route ${PKG_NAME[k]}` : 'this route'}.`);
      }
      const rad = this.radiation(k), RT = both ? `Route ${PKG_NAME[k]}` : 'The route';
      const where = [rad.storm && `${Math.ceil(rad.storm / 60)} min in radiation storms`, rad.dead && `${Math.ceil(rad.dead / 60)} min in dead zones`].filter(Boolean).join(' and ');
      if (rad.dose >= 1) out.push(`${RT} is a lethal radiation dose (${where}): the crews die on the way.`);
      else if (rad.dose > 0) out.push(`${RT} takes ${Math.round(rad.dose * 100)}% of a lethal radiation dose (${where}).`);
      for (const [t, f] of this.fuels(k)) if (f > 1) out.push(`The ${AIRCRAFT[t].name}${both ? ` in package ${PKG_NAME[k]}` : ''} doesn’t have the fuel for ${both ? 'its' : 'this'} route.`);
    }
    return out;
  }

  /** SPEEDS with package k's real km/h in each button's tooltip. */
  speedTable(k = 0) {
    const types = this.pkgs[k].map((a) => a.type);
    return Object.fromEntries(SPEED_ORDER.map((id) => [id, { ...SPEEDS[id], tip: `${SPEEDS[id].name}: ${packageKmh(types, id).toLocaleString()} km/h for this package (below 400 m, 1,100 at most)` }]));
  }

  /** Package k's speeds, set by its slowest jet, and which jet that is. */
  packageSpeed(k = 0) {
    const types = [...new Set(this.pkgs[k].map((a) => a.type))];
    if (!types.length) return null;
    const slow = types.reduce((a, b) => (AIRCRAFT[b].kmh.dash < AIRCRAFT[a].kmh.dash ? b : a));
    const held = types.length > 1 && types.some((t) => AIRCRAFT[t].kmh.dash > AIRCRAFT[slow].kmh.dash);
    return h('div', { class: 'ds-pkgspd' },
      h('div', { class: 'ds-kv' }, h('span', {}, 'Package speed'), h('b', {}, SPEED_ORDER.map((s) => packageKmh(types, s).toLocaleString()).join(' / ') + ' km/h')),
      h('div', { class: 'faint sm' }, held ? `Cruise / Fast / Dash. Held back by the ${AIRCRAFT[slow].name}: the package flies at its slowest jet’s speed.` : 'Cruise / Fast / Dash. The package flies at its slowest jet’s speed.'));
  }

  jetCard(a, i, k = 0) {
    const A = AIRCRAFT[a.type], pk = this.pkgs[k];
    const rm = h('button', { class: 'ds-x', title: 'Take this jet out', onclick: () => { pk.splice(i, 1); this.changed(); } }, '×');
    const dup = h('button', { class: 'ds-x ds-dup', title: `Add another ${A.name} with the same weapons and targets`, onclick: () => {
      const copy = structuredClone(a);
      let pods = this.podCount();
      const left = Object.fromEntries(HANGAR_MUNITIONS.map((id) => [id, this.spareMu(id)]));
      for (const st of copy.stations) {
        if (st.mu === 'pod' && ++pods > this.podMax()) Object.assign(st, { mu: null, n: 0, target: null });
        else if (st.mu in left && (left[st.mu] -= st.n) < 0) Object.assign(st, { mu: null, n: 0, target: null });
      }
      pk.splice(i + 1, 0, copy); this.changed();
    } }, '⧉');
    return h('div', { class: 'ds-jet' },
      h('div', { class: 'ds-jet-h' }, h('b', { style: k ? { color: B_COL } : null }, `${k ? 'B' : ''}${i + 1}. ${A.name}`), h('span', { class: 'faint' }, money(jetCost(a))), dup, rm),
      ...a.stations.map((st, k) => this.stationRow(a, st, k)));
  }

  stationRow(a, st, k) {
    const A = AIRCRAFT[a.type], m = this.mission;
    const muSel = h('select', { class: 'ds-sel sm', title: st.mu ? MUNITIONS[st.mu].what : 'What goes on this station' }, h('option', { value: '' }, `${A.bay ? 'Bay' : 'Station'} ${k + 1}: empty`),
      ...A.weapons.map((id) => {
        const mu = MUNITIONS[id], n = loadOf(a, id);
        // NGJ pods: the option goes grey once the strike has all this mission allows (unless this station holds one)
        const cap = mu.max ? this.podMax() : Infinity, full = st.mu !== id && this.podCount() >= cap;
        // hangar munitions (Mako, NGJ): only as many as are bought
        const left = this.spareMu(id), none = st.mu !== id && left < n;
        const stock = mu.points ? (none ? (this.owned(id) ? ' (all in use)' : ' (buy in the hangar)') : ` · ${left} left in the hangar`) : '';
        return h('option', { value: id, disabled: full || none }, `${n > 1 ? n + '× ' : ''}${mu.short} · ${money(mu.cost * n)}${full ? (cap ? ` (${cap} this mission, all taken)` : ' (none this mission)') : stock}`);
      }));
    muSel.value = st.mu || '';
    muSel.addEventListener('change', () => {
      st.mu = muSel.value || null;
      st.n = st.mu ? loadOf(a, st.mu) : 0;
      st.target = st.mu === 'harm' ? 'auto' : st.mu === 'pod' ? this.defaultPodTarget() : st.mu && !untargeted(st.mu) ? this.defaultTarget(st.mu) : null;
      this.changed();
    });
    if (!st.mu || untargeted(st.mu)) return h('div', { class: 'ds-st' }, muSel, st.mu ? h('span', { class: 'faint sm' }, st.mu === 'mald' ? 'at the decoy point, or when first shot at' : 'at enemy fighters, by itself') : null);
    const tSel = h('select', { class: 'ds-sel sm' });
    const known = m.sites.filter((s) => m.known[s.id]);
    if (st.mu === 'pod') {
      const objSite = m.objective.site;
      tSel.append(h('option', { value: '' }, 'No site'), ...known.filter((s) => s.targets.some(isRadar)).map((s) => h('option', { value: s.id }, `${s.id === objSite ? '★ ' : ''}Blind the ${s.sam ? SAMS[s.sam].long : s.name} · ${whereIs(this.world, s, 30000)}`)));
      tSel.value = st.target?.site || '';
    } else if (st.mu === 'harm') {
      // ★ on the site whose radars include the objective, when the objective is a radar a HARM can go for
      const objSite = m.objective.site, objT = m.sites.find((s) => s.id === objSite)?.targets[m.objective.idx];
      const harmObj = objT && isRadar(objT) ? objSite : null;
      tSel.append(h('option', { value: 'auto' }, 'Any radar that’s on'), ...known.filter((s) => s.targets.some(isRadar)).map((s) => h('option', { value: s.id }, `${s.id === harmObj ? '★ ' : ''}Radars of ${s.sam ? SAMS[s.sam].long : s.name} · ${whereIs(this.world, s, 30000)}`)));
      tSel.value = st.target === 'auto' || !st.target ? 'auto' : st.target.site;
    } else {
      tSel.append(h('option', { value: '' }, 'No target'));
      for (const s of known) {
        const g = h('optgroup', { label: s.sam ? `${SAMS[s.sam].long} site` : s.name });
        s.targets.forEach((t, i) => {
          const obj = m.objective.site === s.id && m.objective.idx === i;
          g.append(h('option', { value: `${s.id}:${i}` }, `${obj ? '★ ' : ''}${targetName(t)}`));
        });
        tSel.append(g);
      }
      tSel.value = st.target?.site ? `${st.target.site}:${st.target.idx}` : '';
    }
    tSel.addEventListener('change', () => {
      const v = tSel.value;
      st.target = v === 'auto' ? 'auto' : !v ? null : v.includes(':') ? { site: v.split(':')[0], idx: +v.split(':')[1] } : { site: v };
      this.changed();
    });
    return h('div', { class: 'ds-st' }, muSel, tSel);
  }

  defaultTarget() { return { site: this.mission.objective.site, idx: this.mission.objective.idx }; }
  /** A new NGJ pod goes on the objective's site if it has radars, else on the first known site that does. */
  defaultPodTarget() {
    const m = this.mission, known = m.sites.filter((s) => m.known[s.id] && s.targets.some(isRadar));
    const s = known.find((x) => x.id === m.objective.site) || known[0];
    return s ? { site: s.id } : null;
  }
  /** NGJ pods this mission allows: always one fewer than its long-range SAM sites (S-300, S-400), two at most, so
   *  there's always a long-range site the pods can't blind. One such site or none: no pods. */
  podMax() {
    const long = this.mission.sites.filter((s) => s.sam && SAMS[s.sam].ring === 'long').length;
    return Math.max(0, Math.min(MUNITIONS.pod.max, long - 1));
  }
  podCount() { return this.pkgs.flat().reduce((n, a) => n + a.stations.filter((s) => s.mu === 'pod').length, 0); }

  legEditor() {
    const k = this.sel?.pk || 0, r = this.routes[k];
    const i = this.sel?.node, first = this.firstEditable(k);
    const editable = i != null && r?.[i] && !r[i].home && first != null && i >= first;
    if (!editable) return h('div', { class: 'faint' }, 'Select a point on a route to set its leg.');
    const p = r[i];
    const seg = (order, table, key) => h('div', { class: 'ds-seg' }, ...order.map((id) => h('button', {
      class: `ds-btn sm${p[key] === id ? ' on' : ''}`, title: table[id].tip || '', onclick: () => { p[key] = id; this.changed(); },
    }, table[id].name)));
    const two = this.pkgs[1].length || this.routes[1]?.length > 2;
    return h('div', { class: 'ds-leg' },
      h('div', { class: 'ds-h2', style: k ? { color: B_COL } : null }, `${two ? `PACKAGE ${PKG_NAME[k]} · ` : ''}${i === 0 ? 'FIRST LEG (from the origin)' : `LEG FROM POINT ${i}`}`),
      seg(ALT_ORDER, ALTS, 'alt'), seg(SPEED_ORDER, this.speedTable(k), 'spd'),
      h('label', { class: 'ds-check' }, h('input', { type: 'checkbox', checked: !!p.decoys, onchange: (e) => { p.decoys = e.target.checked; this.changed(); } }), 'Launch decoys here'),
      i > 0 && i > first ? h('button', { class: 'ds-btn sm', onclick: () => this.removeNode(i, k) }, 'Remove this point') : null);
  }

  changed() { this.renderPanel(); this.view.request(); if (this.phase === 'brief') this.saveCur(); }

  async launch(worst) {
    const short = AIRCRAFT_ORDER.find((id) => this.spare(id) < 0); // a saved plan with more hangar jets than are left
    if (short) { toast(`Only ${this.owned(short)} ${AIRCRAFT[short].name} in the hangar: take one out of the packages`, { type: 'warn', timeout: 6000 }); return; }
    const shortMu = HANGAR_MUNITIONS.find((id) => this.spareMu(id) < 0);
    if (shortMu) { toast(`Only ${this.owned(shortMu)} ${MUNITIONS[shortMu].short} in the hangar: take some off the jets`, { type: 'warn', timeout: 6000 }); return; }
    if (worst[1] > 1 && !(await confirmDialog('Not enough fuel', `The ${AIRCRAFT[worst[0]].name} won’t make it home on this route (${Math.round(worst[1] * 100)}% of its fuel). Launch anyway?`, { okLabel: 'Launch' }))) return;
    this.setPhase('strike');
  }

  // ---- the strike

  panel_strike() {
    const s = this.sim, two = s.flights.length > 1;
    this.nowEls = [];
    const pkgSec = (f) => {
      const jets = f.jets.map((j, i) => {
        const load = new Map();
        for (const st of j.stations) if (st.n && st.mu) load.set(st.mu, (load.get(st.mu) || 0) + st.n);
        const left = [...load].map(([mu, n]) => `${n}× ${MUNITIONS[mu].short}`).join(', ');
        return h('div', { class: `ds-srow${j.alive ? '' : ' dead'}` }, h('span', { class: 'ds-ico', style: f.k && j.alive ? { color: B_COL } : null }, j.alive ? '✈' : '✕'),
          h('span', { class: 'grow' }, `${f.k ? 'B' : ''}${i + 1}. ${j.A.name}`), h('span', { class: `faint${j.fuel > 0.9 ? ' bad' : ''}` }, j.alive ? `${Math.max(0, Math.round((1 - j.fuel) * 100))}% fuel` : 'lost'),
          left && j.alive ? h('div', { class: 'ds-sub' }, left) : null);
      });
      const now = h('b', {}, `${Math.round(f.pos.alt)} m · ${Math.round(f.pos.kmh)} km/h`);
      if (!f.done) this.nowEls.push([now, f]);
      return this.pkgFrame(f.k, this.section(h('span', { style: f.k ? { color: B_COL } : null }, two ? `PACKAGE ${f.name}${this.active === f.k && !f.done && !s.done ? ' · DRAWING' : ''}` : 'PACKAGE'),
        f.done ? h('div', { class: 'faint' }, f.done.why === 'home' ? 'Home.' : 'Lost.') : h('div', { class: 'ds-kv' }, h('span', {}, 'Now'), now),
        ...jets,
        f.done || s.done ? null : h('div', { class: 'ds-row' },
          h('button', { class: 'ds-btn', title: 'Turn this package for home now, straight back', onclick: () => { s.rtb(f); this.sel = null; this.renderPanel(); this.view.request(); } }, two ? `RTB ${f.name}` : 'RTB NOW')),
        f.done || s.done ? null : this.overrideSection(f)));
    };
    const over = !s.done ? null : !two ? (s.done.why === 'home' ? 'The package is home.' : s.done.why === 'ended' ? 'The strike was ended.' : 'The package is lost.')
      : s.done.why === 'ended' ? 'The strike was ended.' : `${s.flights.map((f) => `Package ${f.name} ${f.done?.why === 'home' ? 'is home' : 'was lost'}`).join(' · ')}.`;
    return [
      s.done ? this.section(null, h('div', { class: 'ds-big' }, over), h('button', { class: 'ds-btn primary wide', onclick: () => this.setPhase('debrief') }, 'DEBRIEF →')) : null,
      this.section(null, h('div', { class: 'ds-kv' }, h('span', {}, 'Defences'), h('b', { class: s.alert ? 'bad' : 'good' }, s.alert ? 'awake' : 'not seen yet')),
        s.done ? null : h('div', { class: 'ds-row' }, h('button', { class: 'ds-btn', title: 'Stop the strike here and go to the debrief', onclick: () => this.endStrike() }, 'END MISSION'))),
      ...s.flights.map(pkgSec),
      s.done ? null : this.section(two ? 'ROUTES' : 'ROUTE', h('div', { class: 'ds-note' }, two
        ? 'Edit the routes ahead as they fly (pausing gives you time): Shift+click adds the next point to the package picked above (click its section to pick it), click a line ahead to insert one, drag or right-click the points ahead.'
        : 'Edit the route ahead as it flies (pausing gives you time): Shift+click adds the next point after the selected one, click a line ahead to insert one, drag or right-click the points ahead.'), this.legEditor()),
      this.logSection(18),
    ];
  }

  /** Stop the strike where it is: the jets still flying count as home, what's been hit stays hit. */
  async endStrike() {
    const was = this.paused;
    this.setPaused(true);
    if (!(await confirmDialog('End the mission?', 'The strike stops here and goes to the debrief. Jets still in the air count as home; weapons not yet landed don’t count.', { okLabel: 'End mission' }))) { if (!was) this.setPaused(false); return; }
    if (this.phase !== 'strike' || !this.sim) return;
    this.sim.done ||= { why: 'ended' };
    this.setPhase('debrief');
  }

  /** Height and speed for the leg a package is flying, changed on the spot (running or paused). The rest of its route keeps its plan. */
  overrideSection(f) {
    const p = f.route[f.leg];
    if (!p || !f.route[f.leg + 1]) return null;
    const seg = (order, table, key) => h('div', { class: 'ds-seg' }, ...order.map((id) => h('button', {
      class: `ds-btn sm${p[key] === id ? ' on' : ''}`, title: table[id].tip || '',
      onclick: () => { p[key] = id; this.renderPanel(); this.view.request(); },
    }, table[id].name)));
    return h('div', { class: 'ds-leg' }, h('div', { class: 'ds-h2' }, 'THIS LEG, NOW'),
      h('div', { class: 'ds-note' }, `Leg ${f.leg + 1} of ${f.route.length - 1}: the package takes the new height and speed straight away.`),
      seg(ALT_ORDER, ALTS, 'alt'), seg(SPEED_ORDER, this.speedTable(f.k), 'spd'));
  }

  // ---- the debrief

  panel_debrief() {
    const s = this.sim, m = this.live;
    const won = s.objectiveDone();
    const lostCost = s.lost.reduce((n, l) => n + l.jet.A.cost, 0);
    const killed = [];
    for (const site of m.sites) for (const t of site.targets) if (!alive(t)) killed.push(`${targetName(t)} · ${site.sam ? SAMS[site.sam].long + ' site' : site.name}`);
    return [
      this.section(null, h('div', { class: `ds-result ${won ? 'good' : 'bad'}` }, won ? 'OBJECTIVE DESTROYED' : 'OBJECTIVE STANDING'), this.objectiveLine()),
      this.section('COST', h('div', { class: 'ds-kv' }, h('span', {}, `Jets lost (${s.lost.length})`), h('b', {}, money(lostCost))),
        h('div', { class: 'ds-kv' }, h('span', {}, 'Weapons used'), h('b', {}, money(s.used))),
        h('div', { class: 'ds-kv' }, h('span', {}, 'Total'), h('b', {}, money(lostCost + s.used))),
        ...s.lost.map((l) => h('div', { class: 'ds-log loss' }, `${l.jet.A.name}: ${l.why === 'fuel' ? 'out of fuel' : l.why === 'radiation' ? 'crew killed by radiation' : 'shot down by a ' + l.why}`))),
      this.earned ? this.section(`POINTS (+${this.earned.reduce((n, [, p]) => n + p, 0)})`, ...this.earned.map(([w, p]) => h('div', { class: 'ds-kv' }, h('span', {}, w), h('b', {}, `+${p}`))),
        h('div', { class: 'faint sm' }, `${this.points().toLocaleString('en-US')} to spend in the hangar (on the mission screen)`)) : null,
      this.section(`DESTROYED (${killed.length})`, ...(killed.length ? killed.map((t) => h('div', { class: 'ds-log kill' }, t)) : [h('div', { class: 'faint' }, 'Nothing.')])),
      this.section('THE DEFENCES, REVEALED', ...m.sites.filter((x) => x.sam).map((x) => h('div', { class: 'ds-srow' },
        h('span', { class: 'ds-dot', style: { background: RING_COL[SAMS[x.sam].ring] } }), h('span', { class: 'grow' }, `${SAMS[x.sam].long}${this.plan.mission.known[x.id] ? '' : ' (never found)'}`),
        h('span', { class: 'faint' }, `${x.fired} of ${x.missiles} missiles`)))),
      this.fullLog(),
      this.section(null, h('div', { class: 'ds-row' },
        h('button', { class: 'ds-btn', onclick: () => this.flyAgain() }, 'FLY IT AGAIN'),
        h('button', { class: 'ds-btn primary grow', onclick: () => this.newMission() }, 'NEW MISSION'))),
    ];
  }

  flyAgain() {
    const p = this.plan;
    this.mission = clone(p.mission);
    this.pkgs = [clone(p.pkg), clone(p.pkg2 || [])];
    this.routes = [clone(p.route), p.route2 ? clone(p.route2) : null];
    this.live = null;
    this.setPhase('brief');
  }

  // ---------------------------------------------------------------- the map: input

  /** The first point of package k's route that can still be changed (0 in the briefing; the leg being flown in the
   *  strike), or null if it can't be edited now (the strike's over, or that package isn't flying). */
  firstEditable(k) {
    if (this.phase === 'brief') return this.routes[k] ? 0 : null;
    if (this.phase !== 'strike' || !this.sim || this.sim.done) return null;
    const f = this.sim.flight(k);
    return f && !f.done ? f.leg : null;
  }
  routeEditable(k = 0) { return this.firstEditable(k) != null; }

  hit(px, py) {
    const v = this.view;
    if (this.routes?.[0] && (this.phase === 'brief' || this.phase === 'strike')) {
      const pref = this.sel?.pk || 0; // the origin is in both routes: the package already selected gets it
      for (const k of [pref, 1 - pref]) {
        const r = this.routes[k];
        if (!r || (this.phase === 'strike' && !this.sim.flight(k))) continue;
        for (let i = r.length - 2; i >= 0; i--) {
          const p = r[i];
          if (Math.hypot(v.sx(p.x) - px, v.sy(p.y) - py) < 9) return { node: i, pk: k };
        }
      }
    }
    const m = this.live || this.mission;
    let best = null, bd = 12;
    for (const s of m.sites) {
      if (!m.known[s.id] && this.phase !== 'debrief') continue;
      const d = Math.hypot(v.sx(s.x) - px, v.sy(s.y) - py);
      if (d < bd) { bd = d; best = { site: s.id }; }
    }
    return best;
  }

  wire() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const k = e.altKey ? 'alt' : this.zHeld ? 'spd' : null;
      if (k && this.legWheel(e.clientX - r.left, e.clientY - r.top, e.deltaY || e.deltaX, k)) return;
      this.view.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const hit = this.hit(e.clientX - r.left, e.clientY - r.top);
      if (hit?.node > 0 && this.routeEditable(hit.pk) && hit.node > this.firstEditable(hit.pk)) this.removeNode(hit.node, hit.pk);
    });
    c.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      c.focus();
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      if (e.button === 0 && this.overOrigin(px, py)) { this.dragOrigin(e, r); return; }
      const hit = e.button === 0 ? this.hit(px, py) : null;
      const dragNode = hit?.node != null && this.routeEditable(hit.pk) && hit.node > 0 && hit.node > this.firstEditable(hit.pk) ? hit.node : null;
      let moved = false, lx = e.clientX, ly = e.clientY;
      c.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        moved = true;
        if (dragNode != null) {
          const p = this.routes[hit.pk][dragNode];
          p.x = this.view.wx(ev.clientX - r.left); p.y = this.view.wy(ev.clientY - r.top);
          this.view.request();
        } else { this.view.pan(ev.clientX - lx, ev.clientY - ly); }
        lx = ev.clientX; ly = ev.clientY;
      };
      const up = (ev) => {
        c.removeEventListener('pointermove', move);
        c.removeEventListener('pointerup', up);
        if (dragNode != null && moved) { this.sel = { node: dragNode, pk: hit.pk }; this.active = hit.pk || 0; this.changed(); return; }
        if (!moved && e.button === 0) this.click(px, py, hit, ev);
      };
      c.addEventListener('pointermove', move);
      c.addEventListener('pointerup', up);
    });
    c.addEventListener('pointermove', (e) => { if (!e.buttons) this.hover(e); });
    // Z held (not typing in a box, no Ctrl/Alt): the wheel on a route point changes its leg's speed
    this.zKeys = (e) => {
      if (e.key !== 'z' && e.key !== 'Z') return;
      if (e.type === 'keydown' && (e.ctrlKey || e.altKey || e.metaKey || e.target.closest?.('input, textarea, select, [contenteditable]'))) return;
      this.zHeld = e.type === 'keydown';
    };
    this.zOff = () => { this.zHeld = false; };
    addEventListener('keydown', this.zKeys);
    addEventListener('keyup', this.zKeys);
    addEventListener('blur', this.zOff);
    c.addEventListener('pointerleave', () => { this.tip.hidden = true; });
    c.addEventListener('keydown', (e) => {
      if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); this.toggleTerrain(); }
      if (e.key === ' ' && (this.phase === 'sniffer' || this.phase === 'strike')) { e.preventDefault(); this.setPaused(!this.paused); }
    });
  }

  /** Alt+scroll on a route point: the leg that starts there goes up (scroll up) or down a height band; Z+scroll: faster
   *  or slower. A trackpad's small steps add up to one step. True if it was over a point it could change (else the
   *  wheel zooms as usual). key: 'alt' | 'spd'. */
  legWheel(px, py, dy, key) {
    const hit = this.hit(px, py);
    if (hit?.node == null) return false;
    const first = this.firstEditable(hit.pk), p = this.routes[hit.pk][hit.node];
    if (first == null || hit.node < first || p.home) return false;
    this.altAcc = (Math.sign(dy) === Math.sign(this.altAcc || 0) ? this.altAcc : 0) + dy;
    if (Math.abs(this.altAcc) < 40) return true;
    const order = key === 'alt' ? ALT_ORDER : SPEED_ORDER;
    const i = Math.max(0, Math.min(order.length - 1, order.indexOf(p[key]) + (this.altAcc < 0 ? 1 : -1)));
    this.altAcc = 0;
    this.sel = { node: hit.node, pk: hit.pk };
    p[key] = order[i];
    this.changed();
    return true;
  }

  toggleTerrain() {
    this.showTerrain = !this.showTerrain;
    this.save({ terrain: this.showTerrain });
    if (!this.showTerrain) this.tip.hidden = true;
    this.renderLegend();
    this.renderTop();
    this.view.request();
  }

  renderLegend() {
    this.legend.hidden = !this.showTerrain;
    if (!this.showTerrain) return;
    clear(this.legend).append(h('div', { class: 'ds-h' }, 'TERRAIN · LOW FLYING'), ...Object.entries(BIOMES).map(([id, b]) => h('div', { class: 'ds-leg-row' },
      h('span', { class: 'ds-swatch', style: { background: b.col } }), h('span', { class: 'grow' }, b.name),
      h('span', { class: 'faint' }, `${Math.round(b.deck.see * 100)}%`))), h('div', { class: 'faint sm' }, 'radar range on a package at deck height · hover for more'));
  }

  /** In the planner, on a mission with an origin arc: is the pointer on the origin? */
  overOrigin(px, py) {
    const m = this.mission;
    return this.phase === 'brief' && m?.arc && Math.hypot(this.view.sx(m.origin.x) - px, this.view.sy(m.origin.y) - py) < 11;
  }

  /** Drag the origin along its arc; both routes start and end there. Not past the field's edge. */
  dragOrigin(e, r) {
    const c = this.canvas, m = this.mission, P = m.sites.find((s) => s.id === m.primary);
    c.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const a = Math.atan2(this.view.wy(ev.clientY - r.top) - P.y, this.view.wx(ev.clientX - r.left) - P.x), p = arcPoint(P, m.arc, a);
      if (!inField(this.world, p.x, p.y)) return;
      m.origin.x = p.x; m.origin.y = p.y;
      for (const rt of this.routes) if (rt) for (const q of [rt[0], rt[rt.length - 1]]) { q.x = p.x; q.y = p.y; }
      this.view.request();
    };
    const up = () => { c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); this.changed(); };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
  }

  /** A known site under the pointer: its name as the target list words it. Otherwise, with the terrain overlay on: what
   *  the ground under the pointer does to the package. */
  hover(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    this.canvas.style.cursor = this.overOrigin(px, py) ? 'grab' : '';
    const at = this.mission && this.hit(px, py)?.site, s = at && (this.live || this.mission).sites.find((x) => x.id === at);
    if (s) {
      const m = this.live || this.mission, obj = m.objective.site === s.id;
      clear(this.tip).append(h('div', { class: 'ds-tip-h' }, `${obj ? '★ ' : ''}${s.sam ? `${SAMS[s.sam].long} site` : s.name}`),
        h('div', { class: 'ds-tip-line' }, whereIs(this.world, s, 30000)));
    } else {
      const z = this.mission && zoneAt((this.live || this.mission).zones, this.view.wx(px), this.view.wy(py)), ground = this.showTerrain && this.terrain;
      if (!z && !ground) { this.tip.hidden = true; return; }
      clear(this.tip);
      if (z) {
        const L = ZONE_LOOK[z.storm ? 'storm' : 'dead'];
        this.tip.append(h('div', { class: 'ds-tip-h' }, h('span', { class: 'ds-swatch', style: { background: L.edge } }), L.name),
          h('div', { class: 'ds-tip-what' }, z.storm ? `Salted ground under a radiation storm: ${STORM_S / 60} minutes inside kills a crew.` : `Salted ground from a cluster of megaton strikes: ${DEAD_S / 60} minutes inside kills a crew. Nothing lives or is built here.`),
          h('div', { class: 'ds-tip-line' }, 'Radiation adds up over the whole flight, dead zones and storms together.'));
      }
      if (ground) {
        const d = describe(this.terrain.at(this.view.wx(px), this.view.wy(py)));
        this.tip.append(h('div', { class: 'ds-tip-h' }, h('span', { class: 'ds-swatch', style: { background: d.col } }), d.name),
          h('div', { class: 'ds-tip-what' }, d.what), ...d.lines.map((l) => h('div', { class: 'ds-tip-line' }, l)));
      }
    }
    this.tip.hidden = false;
    const w = this.tip.offsetWidth, ht = this.tip.offsetHeight;
    this.tip.style.left = `${Math.min(px + 16, r.width - w - 8)}px`;
    this.tip.style.top = `${py + 16 + ht > r.height ? py - ht - 12 : py + 16}px`;
  }

  click(px, py, hit, e) {
    const x = this.view.wx(px), y = this.view.wy(py);
    if (hit?.node != null) { this.sel = { node: hit.node, pk: hit.pk }; this.active = hit.pk || 0; this.renderPanel(); this.view.request(); return; }
    if (hit?.site) { this.sel = { site: hit.site }; this.renderPanel(); this.view.request(); if (this.phase !== 'sniffer') return; }
    if (this.phase === 'sniffer' && !this.sim.done) {
      this.sim.goTo({ x, y }, e.shiftKey);
      if (this.paused) this.setPaused(false);
      return;
    }
    // Shift+click draws for the package picked in the panel: on one of its lines, a point in it; elsewhere, its next
    // point after the selected one (or at the end, before the way home). A plain click on either route's line puts a
    // point in it (and picks that package). The new point is selected, so more clicks keep adding legs. A plain click
    // on empty map deselects.
    const P = { x: px, y: py };
    const want = e.shiftKey ? this.active : -1;
    let at = -1, bd = 8, k = 0;
    for (const kk of want < 0 ? [0, 1] : [want]) {
      const first = this.firstEditable(kk), r = this.routes[kk];
      if (first == null) continue;
      for (let i = first; i < r.length - 1; i++) {
        const sa = { x: this.view.sx(r[i].x), y: this.view.sy(r[i].y) }, sb = { x: this.view.sx(r[i + 1].x), y: this.view.sy(r[i + 1].y) };
        if (Math.hypot(sb.x - sa.x, sb.y - sa.y) < 1) continue; // an empty route (out and straight back) has no line yet
        const d = toSegment(P, sa, sb).d;
        if (d < bd) { bd = d; at = i + 1; k = kk; }
      }
    }
    if (at < 0) {
      k = want;
      if (k < 0) { if (this.sel) { this.sel = null; this.renderPanel(); this.view.request(); } return; }
      const first = this.firstEditable(k), r = this.routes[k];
      if (first == null) return; // that package isn't flying
      const i = this.sel?.pk === k ? this.sel.node : null;
      at = i != null && i >= first && i < r.length - 1 ? i + 1 : r.length - 1;
    }
    const r = this.routes[k], prev = r[at - 1];
    r.splice(at, 0, { x, y, alt: prev.alt, spd: prev.spd });
    this.sel = { node: at, pk: k };
    this.active = k;
    this.changed();
  }

  removeNode(i, k = 0) {
    const r = this.routes[k];
    if (!r || i <= 0 || i >= r.length - 1) return;
    r.splice(i, 1);
    this.sel = null;
    this.changed();
  }

  // ---------------------------------------------------------------- the map: drawing

  drawLayers(ctx, v) {
    const m = this.live || this.mission;
    if (!m) return;
    const reveal = this.phase === 'debrief';
    if (this.showTerrain && this.terrain) this.terrain.draw(ctx, v);
    this.drawZones(ctx, v);
    ctx.lineWidth = 1.2;
    // threat rings first, under everything
    for (const s of m.sites) {
      if (!s.sam || (!m.known[s.id] && !reveal)) continue;
      const S = SAMS[s.sam];
      const dead = !(s.targets.some((t) => (t.k === 'fc' || t.k === 'telar' || t.k === 'tlar') && alive(t)));
      const col = RING_COL[S.ring];
      const known = this.plan ? this.plan.mission.known[s.id] : m.known[s.id];
      v.circle(s.x, s.y, S.missile.km, dead ? COL.faint : col, dead ? null : `${col}14`, known ? null : [5, 5]);
      if (this.phase === 'strike' && s.tracking) v.circle(s.x, s.y, S.missile.km, col, `${col}22`);
    }
    // enemy fighter patrols the sniffer heard (roughly where they orbit; every one in the debrief)
    for (const c of m.cap || []) {
      if (!c.heard && !reveal) continue;
      v.circle(c.x, c.y, 45, COL.enemy, null, [3, 5]);
      v.label(`CAP · ${c.n}× ${FIGHTERS[c.type].name}`, c.x, c.y, COL.enemy, { align: 'center', font: 'bold 10px ui-monospace, Consolas, monospace' });
    }
    // where the radars would see the picked package on its selected leg (letters round each outline say whose it is)
    if (this.phase === 'brief' && this.sel?.node != null && this.routes) {
      const k = this.sel.pk || 0, r = this.routes[k], node = this.sel.node;
      if (r?.[node] && r[node + 1] && !r[node].home) this.drawDetection(ctx, v, k, node);
    }
    this.drawSites(ctx, v, m, reveal);
    // the origin, and in the planner the arc it can be dragged along
    const o = m.origin;
    if (this.phase === 'brief' && m.arc) {
      const P = m.sites.find((s) => s.id === m.primary);
      ctx.beginPath();
      ctx.arc(v.sx(P.x), v.sy(P.y), m.arc.r * v.scale, m.arc.a - m.arc.half, m.arc.a + m.arc.half);
      ctx.setLineDash([2, 5]); ctx.lineWidth = 1.5; ctx.strokeStyle = `${COL.friend}99`; ctx.stroke(); ctx.setLineDash([]);
      for (const s of [-1, 1]) {
        const q = arcPoint(P, m.arc, m.arc.a + s * m.arc.half), ux = Math.cos(m.arc.a + s * m.arc.half), uy = Math.sin(m.arc.a + s * m.arc.half);
        ctx.beginPath(); ctx.moveTo(v.sx(q.x) - ux * 5, v.sy(q.y) - uy * 5); ctx.lineTo(v.sx(q.x) + ux * 5, v.sy(q.y) + uy * 5); ctx.stroke();
      }
    }
    ctx.fillStyle = COL.friend;
    ctx.beginPath(); ctx.moveTo(v.sx(o.x), v.sy(o.y) - 7); ctx.lineTo(v.sx(o.x) + 6, v.sy(o.y) + 5); ctx.lineTo(v.sx(o.x) - 6, v.sy(o.y) + 5); ctx.closePath(); ctx.fill();
    v.label('ORIGIN', o.x, o.y, COL.friend, { dx: 10 });
    if (this.routes?.[0] && (this.phase === 'brief' || this.phase === 'strike' || this.phase === 'debrief')) {
      // in the air and after, only the routes that flew; the picked package last, so it's on top where they share a line
      this.relLabels = []; // release-point labels placed this frame, so the next one steps clear of them
      for (const k of [1 - this.active, this.active]) if (this.routes[k] && (this.phase === 'brief' || this.sim?.flight?.(k))) this.drawRoute(ctx, v, k);
    }
    if (this.phase === 'sniffer' || (this.sim instanceof SnifferSim)) this.drawSniffer(ctx, v);
    if (this.sim instanceof StrikeSim) this.drawStrike(ctx, v);
    if (this.sim) this.drawMissiles(ctx, v);
  }

  /** The dead zones and radiation storms, every footprint of a kind merged into one shape: a wash, caution stripes
   *  that move with the map, and an edge round the outside only (each footprint's edge, minus where it lies inside
   *  another of its kind, or under a storm). Storms on top. A name on the bigger clusters. */
  drawZones(ctx, v) {
    const zones = (this.live || this.mission).zones || [];
    if (!zones.length) return;
    const ox = ((v.sx(0) % 14) + 14) % 14, oy = ((v.sy(0) % 14) + 14) % 14;
    const all = zones.flatMap((z) => z.parts.map((f) => {
      const q = new Path2D();
      f.pts.forEach(([x, y], i) => (i ? q.lineTo(v.sx(x), v.sy(y)) : q.moveTo(v.sx(x), v.sy(y))));
      q.closePath();
      return { f, q, storm: z.storm };
    }));
    const onScreen = ({ f }) => { const rp = f.r * v.scale, cx = v.sx(f.x), cy = v.sy(f.y); return cx + rp > 0 && cy + rp > 0 && cx - rp < v.w && cy - rp < v.h; };
    for (const storm of [false, true]) {
      const mine = all.filter((p) => p.storm === storm), L = ZONE_LOOK[storm ? 'storm' : 'dead'], path = new Path2D();
      for (const p of mine) path.addPath(p.q);
      ctx.fillStyle = L.wash; ctx.fill(path, 'nonzero');
      const pat = stripeTile(ctx, L.stripe);
      pat.setTransform(new DOMMatrix().translate(ox, oy));
      ctx.fillStyle = pat; ctx.fill(path, 'nonzero');
      ctx.setLineDash([]); ctx.lineWidth = 1; ctx.strokeStyle = L.edge; ctx.lineJoin = 'miter';
      for (const p of mine) {
        if (!onScreen(p)) continue;
        ctx.save();
        for (const o of all) {
          if (o === p || (storm && !o.storm) || Math.hypot(o.f.x - p.f.x, o.f.y - p.f.y) > o.f.r + p.f.r) continue;
          const out = new Path2D(); out.rect(-1e5, -1e5, 2e5, 2e5); out.addPath(o.q);
          ctx.clip(out, 'evenodd');
        }
        ctx.stroke(p.q);
        ctx.restore();
      }
    }
    // a name on the bigger clusters, kept well apart so a merged shape doesn't repeat it
    const named = [];
    for (const z of [...zones].sort((a, b) => b.r - a.r)) {
      const x = v.sx(z.x), y = v.sy(z.y);
      if (z.r * v.scale < 70 || named.some((p) => Math.hypot(p.x - x, p.y - y) < 260 && p.storm === z.storm)) continue;
      named.push({ x, y, storm: z.storm });
      const L = ZONE_LOOK[z.storm ? 'storm' : 'dead'];
      v.label(L.name, z.x, z.y, L.text, { align: 'center', font: '10px ui-monospace, Consolas, monospace' });
    }
  }

  drawSites(ctx, v, m, reveal) {
    const detail = v.scale > 40;
    for (const s of m.sites) {
      if (!m.known[s.id] && !reveal) continue;
      const S = s.sam ? SAMS[s.sam] : null;
      const primary = s.id === m.primary;
      const col = primary ? COL.objective : S ? RING_COL[S.ring] : COL.unknown;
      const x = v.sx(s.x), y = v.sy(s.y);
      if (detail) { this.drawInside(ctx, v, s, m); continue; }
      ctx.strokeStyle = col; ctx.lineWidth = 1.6;
      if (primary) { ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12); ctx.stroke(); }
      else { ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.stroke(); }
      if (this.sel?.site === s.id) { ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke(); }
      const jammed = this.phase === 'strike' && this.sim?.blinded?.(s);
      const name = `${primary ? `★ ${m.code}` : S ? S.name : s.name}${jammed ? ' · JAMMED' : ''}`;
      if (primary || jammed || v.scale > 0.9 || this.sel?.site === s.id) v.label(name, s.x, s.y, col, { dx: primary ? 15 : 9 });
    }
  }

  /** Zoomed right in: the site's layout, target by target. */
  drawInside(ctx, v, s, m) {
    const S = s.sam ? SAMS[s.sam] : null;
    s.targets.forEach((t, i) => {
      const at = targetXY(s, t);
      const x = v.sx(at.x), y = v.sy(at.y);
      const obj = m.objective.site === s.id && m.objective.idx === i;
      const dead = !alive(t);
      const col = dead ? '#555' : obj ? COL.objective : S ? RING_COL[S.ring] : '#c9d4dc';
      ctx.strokeStyle = col; ctx.fillStyle = dead ? '#222' : `${col}33`; ctx.lineWidth = 1.4;
      if (t.k === 'runway') {
        ctx.save(); ctx.translate(x, y); ctx.rotate(t.ang);
        const L = (t.len / 1000) * v.scale, W = Math.max(3, 0.05 * v.scale);
        ctx.fillRect(-L / 2, -W / 2, L, W); ctx.strokeRect(-L / 2, -W / 2, L, W);
        if (t.dmg) { ctx.fillStyle = '#ff7a3d'; const n = Math.min(12, Math.round((t.dmg / targetHp(t)) * 10)); for (let k = 0; k < n; k++) ctx.fillRect(-L / 2 + ((k + 0.5) / n) * L - 2, -2, 4, 4); }
        ctx.restore();
      } else {
        const r = Math.max(3, Math.min(9, 0.06 * v.scale));
        ctx.beginPath();
        if (TARGETS[t.k]?.radar) ctx.arc(x, y, r, 0, Math.PI * 2); else ctx.rect(x - r, y - r, r * 2, r * 2);
        ctx.fill(); ctx.stroke();
        if (dead) { ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke(); }
      }
      if (v.scale > 90 || obj) v.label(`${obj ? '★ ' : ''}${targetName(t)}`, at.x, at.y, col, { dx: 10, font: '10px ui-monospace, Consolas, monospace' });
    });
    v.label(s.sam ? SAMS[s.sam].long : s.name, s.x, s.y, COL.text, { dy: -Math.max(26, 1.3 * v.scale), align: 'center' });
  }

  /** Where each known radar would see package k on leg `node`, the way the strike works it out: search radars (an
   *  airfield's too) dotted white, the guidance radars that steer missiles dashed red (no further than the missile flies: where it can shoot). Counts the package's least
   *  stealthy jet, the leg's height (the route marks where the jets level off at it), the earth's
   *  curve, its Growler's jamming, NGJ pods (a blinded site sees nothing inside the pod's reach) and the ground under
   *  a low leg, so a shape can be lopsided. Package B's outlines are in its warm colours; every outline has the
   *  package's letter round its rim. A package mixing stealth jets with ordinary ones also gets the guidance radars'
   *  outline for its stealthiest jet (named round the rim): the package is seen and shot at by the big one, but a
   *  missile can only be guided onto the stealth jet inside the small one. */
  drawDetection(ctx, v, k, node) {
    const m = this.mission, pk = this.pkgs[k], r = this.routes[k];
    const rcs = pk.length ? Math.max(...pk.map((a) => AIRCRAFT[a.type].rcs)) : 1.2;
    const quiet = pk.length ? pk.reduce((a, b) => (AIRCRAFT[b.type].rcs < AIRCRAFT[a.type].rcs ? b : a)) : null;
    const stealth = quiet && AIRCRAFT[quiet.type].lo && AIRCRAFT[quiet.type].rcs < rcs / 10 ? AIRCRAFT[quiet.type] : null;
    const tag = PKG_NAME[k], col = k ? ['rgba(255,217,194,0.4)', 'rgba(255,159,67,0.65)'] : ['rgba(255,255,255,0.32)', 'rgba(255,120,120,0.55)'];
    const jam = pk.map((a) => AIRCRAFT[a.type].jam).find(Boolean) || null;
    const podded = new Set(this.pkgs.flat().flatMap((a) => a.stations.filter((st) => st.mu === 'pod' && st.target?.site).map((st) => st.target.site)));
    const alt = ALTS[r[node].alt].m;
    for (const s of m.sites) {
      if (!m.known[s.id]) continue;
      const blind = podded.has(s.id) ? MUNITIONS.pod.km : 0, draw = [];
      for (const kind of ['search', 'fc']) {
        const spec = s.sam ? SAMS[s.sam][kind] : kind === 'search' ? AIRFIELD_RADAR : null;
        if (!spec || !(kind === 'search' ? searchRadars(s) : fcRadars(s)).length) continue;
        const c = col[kind === 'search' ? 0 : 1];
        // a guidance radar only matters as far as its missile flies: past that it tracks but can't shoot
        const cap = kind === 'fc' ? SAMS[s.sam].missile.km : Infinity;
        draw.push([this.seenShape(s, spec, rcs, alt, jam, blind, cap), kind === 'search' ? [2, 4] : [7, 4], c, tag]);
        if (kind === 'fc' && stealth) draw.push([this.seenShape(s, spec, stealth.rcs, alt, jam, blind, cap), [2, 3], c, `${tag} ${stealth.name.split(' ')[0]}`]);
      }
      for (const d of draw) this.outline(ctx, v, ...d);
    }
  }

  /** One detection outline, with its label every so often round the rim. */
  outline(ctx, v, shape, dash, col, tag) {
    if (!shape) return;
    ctx.beginPath();
    shape.forEach(([x, y], i) => (i ? ctx.lineTo(v.sx(x), v.sy(y)) : ctx.moveTo(v.sx(x), v.sy(y))));
    ctx.closePath();
    ctx.setLineDash(dash); ctx.strokeStyle = col; ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.setLineDash([]);
    // three labels spread round the rim (one on a small outline), so a crowded network doesn't turn to letter soup
    const rim = shape.reduce((n, [x, y], i) => { const [px, py] = shape[(i || shape.length) - 1]; return n + Math.hypot(v.sx(x) - v.sx(px), v.sy(y) - v.sy(py)); }, 0);
    const every = rim < 240 ? Infinity : rim / 3;
    let run = rim < 240 ? 0 : every / 2, put = 0;
    for (let i = 0; i < shape.length && put < 3; i++) {
      const [x, y] = shape[i], [px, py] = shape[(i || shape.length) - 1];
      run += Math.hypot(v.sx(x) - v.sx(px), v.sy(y) - v.sy(py));
      if (put ? run < every : i !== Math.floor(shape.length * 0.375) && run < every) continue;
      run = 0; put++;
      v.label(tag, x, y, col.replace(/[\d.]+\)$/, '0.9)'), { dx: 0, align: 'center', font: 'bold 9px ui-monospace, Consolas, monospace' });
    }
  }

  /** The outline of where one radar sees something of rcs m² at alt m: 120 bearings, each walked in from the
   *  furthest it could see until the jamming and the ground there let it. null if it can't see anything. Kept, since
   *  low legs check the ground a few thousand times. */
  seenShape(s, spec, rcs, alt, jam, blindKm, cap = Infinity) {
    const key = `${s.x.toFixed(2)},${s.y.toFixed(2)}|${spec.name}|${rcs}|${Math.round(alt / 5)}|${jam ? jam.km + ':' + jam.factor : ''}|${blindKm}|${cap}`;
    this.shapeCache ||= new Map();
    if (this.shapeCache.has(key)) return this.shapeCache.get(key);
    const base = spec.km * Math.pow(rcs / 5, 0.25), hz = horizon(spec.h, alt), max = Math.min(hz, base, cap);
    const step = Math.max(0.5, max / 160), N = 120;
    let any = false;
    const out = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2, cx = Math.cos(a), cy = Math.sin(a);
      let d = max;
      for (; d > blindKm; d -= step) {
        const x = s.x + cx * d, y = s.y + cy * d;
        const see = (jam && d <= jam.km ? jam.factor : 1) * (this.terrain ? this.terrain.effect(x, y, alt).see : 1);
        if (d <= Math.min(hz, base * see)) break;
      }
      if (d <= blindKm) d = 0; else any = true;
      out.push([s.x + cx * Math.max(0, d), s.y + cy * Math.max(0, d)]);
    }
    const shape = any ? out : null;
    if (shape) shape.r = Math.max(...out.map(([x, y]) => Math.hypot(x - s.x, y - s.y))); // its furthest reach
    if (this.shapeCache.size > 400) this.shapeCache.clear();
    this.shapeCache.set(key, shape);
    return shape;
  }

  drawRoute(ctx, v, k = 0) {
    const r = this.routes[k], cols = k ? LEG_COL_B : LEG_COL, nodeCol = k ? B_COL : COL.node;
    const sim = this.phase === 'strike' || this.phase === 'debrief' ? this.sim?.flight(k) : null; // its leg: what's flown
    // the package not picked, while planning or flying two: a thin faded line and its point names, nothing else
    const other = this.routes[1 - k], twoOn = this.phase === 'debrief' ? false : this.phase === 'strike' ? !!this.sim?.flight?.(1 - k) : (this.pkgs[1 - k].length || other?.length > 2);
    const quiet = k !== this.active && twoOn;
    if (quiet) ctx.globalAlpha = 0.4;
    // legs already labelled: one flown back over the same line says nothing if it's the same height and speed, or
    // puts its label on the other side of the line if not. Package B's labels go under its lines (A's over), so where
    // the two routes share a way they don't pile up.
    const drawn = new Map();
    const key = (p, q) => `${p.x.toFixed(2)},${p.y.toFixed(2)}>${q.x.toFixed(2)},${q.y.toFixed(2)}`;
    const line = this.phase === 'brief' && !quiet && r.length > 1 ? timeline(r, this.pkgs[k].map((a) => a.type)) : null;
    for (let i = 0; i < r.length - 1; i++) {
      const a = r[i], b = r[i + 1];
      const text = `${ALTS[a.alt].name.toUpperCase()} · ${SPEEDS[a.spd].name.toUpperCase()}`;
      const back = drawn.get(key(b, a));
      drawn.set(key(a, b), text);
      const past = sim && i < sim.leg;
      ctx.strokeStyle = past ? 'rgba(140,160,180,0.35)' : cols[a.alt];
      ctx.lineWidth = quiet ? 1 : a.spd === 'dash' ? 3 : a.spd === 'fast' ? 2.2 : 1.6;
      // still climbing or descending to the leg's height: that stretch is drawn finely dashed, with a tick where the
      // jets level off (none if they never do before the next point)
      const want = ALTS[a.alt].m, legPts = line && !b.home ? line.pts.filter((q) => q.leg === i) : [];
      const lvl = legPts.length && Math.abs(legPts[0].alt - want) > 1 ? legPts.find((q) => Math.abs(q.alt - want) <= 1) || b : null;
      if (lvl) {
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(v.sx(a.x), v.sy(a.y)); ctx.lineTo(v.sx(lvl.x), v.sy(lvl.y)); ctx.stroke();
        ctx.setLineDash([]);
        if (lvl !== b) {
          ctx.beginPath(); ctx.moveTo(v.sx(lvl.x), v.sy(lvl.y)); ctx.lineTo(v.sx(b.x), v.sy(b.y)); ctx.stroke();
          const ang = Math.atan2(v.sy(b.y) - v.sy(a.y), v.sx(b.x) - v.sx(a.x)) + Math.PI / 2, tx = Math.cos(ang) * 5, ty = Math.sin(ang) * 5;
          ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(v.sx(lvl.x) - tx, v.sy(lvl.y) - ty); ctx.lineTo(v.sx(lvl.x) + tx, v.sy(lvl.y) + ty); ctx.stroke();
          if (v.scale > 0.5) v.label('LEVEL', lvl.x, lvl.y, cols[a.alt], { dx: 6, dy: k ? 10 : -8, font: '8.5px ui-monospace, Consolas, monospace' });
        }
      } else {
        ctx.setLineDash(b.home ? [6, 5] : []);
        ctx.beginPath(); ctx.moveTo(v.sx(a.x), v.sy(a.y)); ctx.lineTo(v.sx(b.x), v.sy(b.y)); ctx.stroke();
        ctx.setLineDash([]);
      }
      // leg labels: zoomed in, or on the selected leg (the line's colour and weight already say height and speed)
      const legOn = this.sel?.node === i && (this.sel.pk || 0) === k;
      if (!quiet && !past && back !== text && (v.scale > 2 || legOn) && dist(a, b) * v.scale > 70) {
        v.label(text, (a.x + b.x) / 2, (a.y + b.y) / 2, cols[a.alt], { dx: 6, dy: !back !== !k ? 14 : -8, font: '9.5px ui-monospace, Consolas, monospace' });
      }
    }
    const times = line?.at;
    r.forEach((p, i) => {
      if (i === 0 || p.home) return;
      const past = sim && i <= sim.leg;
      const x = v.sx(p.x), y = v.sy(p.y), on = this.sel?.node === i && (this.sel.pk || 0) === k;
      ctx.fillStyle = past ? '#556' : on ? '#fff' : nodeCol;
      ctx.beginPath(); ctx.arc(x, y, on ? 6 : 4.5, 0, Math.PI * 2); ctx.fill();
      if (p.decoys) { ctx.strokeStyle = COL.short; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke(); }
      v.label(`${k ? 'B' : ''}${i}${times?.[i] != null ? ` · ${clock(times[i])}` : ''}`, p.x, p.y, past ? '#667' : nodeCol, { dx: 8, dy: -8, font: '10px ui-monospace, Consolas, monospace' });
    });
    ctx.globalAlpha = 1;
    if (this.phase !== 'brief' || quiet) return;
    // where each weapon gets let go, and when it lands (HARMs: when a radar first comes within reach)
    const placed = this.relLabels || [];
    for (const sh of this.shots(k)) {
      const { rp, at } = sh, col = sh.harm ? '#7cf' : COL.short;
      ctx.strokeStyle = sh.harm ? 'rgba(124,204,255,0.5)' : 'rgba(255,216,74,0.55)'; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(v.sx(rp.x), v.sy(rp.y)); ctx.lineTo(v.sx(at.x), v.sy(at.y)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.fillRect(v.sx(rp.x) - 2.5, v.sy(rp.y) - 2.5, 5, 5);
      if (v.scale < 0.5) continue;
      const x = v.sx(rp.x) - 8;
      let y = v.sy(rp.y) + (k ? 14 : -8);
      while (placed.some((q) => Math.abs(q.x - x) < 120 && Math.abs(q.y - y) < 11)) y += k ? 11 : -11;
      placed.push({ x, y });
      v.label(`${sh.n > 1 ? sh.n + '× ' : ''}${sh.short} ${clock(sh.away).slice(3)} → ${sh.harm ? '~' : ''}${clock(sh.hits).slice(3)}`, rp.x, rp.y, col, { dx: -8, dy: y - v.sy(rp.y), align: 'right', font: '9.5px ui-monospace, Consolas, monospace' });
    }
  }

  /** Every weapon package k will let go, planned: when it's let go and when it lands, earliest first. [{ jet, short,
   *  n, harm, rp, at, away, hits, what }]. HARMs: the first radar of the site they were given (any known site, for
   *  "any radar that's on") to come within reach, if it's on the air then. */
  shots(k) {
    const m = this.mission, pk = this.pkgs[k], r = this.routes[k];
    if (!pk.length || !r || r.length < 2) return [];
    const types = pk.map((x) => x.type), pts = timeline(r, types).pts;
    const key = JSON.stringify([r, pk, m.known]);
    if (this.shotCache?.[k]?.key === key) return this.shotCache[k].out;
    const out = [];
    pk.forEach((a, i) => a.stations.forEach((st) => {
      if (!st.mu || !st.n || !st.target || st.mu === 'mald' || st.mu === 'pod') return;
      const mu = MUNITIONS[st.mu], jet = `${AIRCRAFT[a.type].name.split(' ')[0]} ${k ? 'B' : ''}${i + 1}`;
      if (mu.kind === 'arm') {
        const radars = m.sites.filter((s) => m.known[s.id] && (st.target === 'auto' || st.target.site === s.id))
          .flatMap((s) => s.targets.filter((t) => isRadar(t) && alive(t)).map((t) => ({ s, t, at: targetXY(s, t) })));
        for (const p of radars.length ? pts : []) {
          const R = reach(mu, p.alt, p.kmh), hit = radars.find((x) => dist(p, x.at) <= R);
          if (hit) { out.push({ jet, short: mu.short, n: st.n, harm: true, rp: p, at: hit.at, away: p.t, hits: p.t + (dist(p, hit.at) / mu.kmh) * 3600, what: `the radars at the ${hit.s.sam ? `${SAMS[hit.s.sam].long} site` : hit.s.name}` }); break; }
        }
        return;
      }
      if (st.target === 'auto' || st.target.idx == null) return;
      const s = m.sites.find((x) => x.id === st.target.site), t = s?.targets[st.target.idx];
      if (!t) return;
      const at = targetXY(s, t), rp = releasePoint(r, at, mu, types);
      if (rp) out.push({ jet, short: mu.short, n: st.n, rp, at, away: rp.t, hits: rp.t + (dist(rp, at) / mu.kmh) * 3600, what: `the ${lower(targetName(t))}` });
    }));
    // the same weapon let go at the same thing at the same moment is one shot: "3× JSOW", from whichever jets
    const merged = new Map();
    for (const sh of out) {
      const id = `${sh.short}|${sh.what}|${Math.round(sh.away)}`, was = merged.get(id);
      if (!was) { merged.set(id, { ...sh, jets: [sh.jet] }); continue; }
      was.n += sh.n;
      if (!was.jets.includes(sh.jet)) was.jets.push(sh.jet);
    }
    const list = [...merged.values()].map((sh) => ({ ...sh, jet: sh.jets.join(', ') })).sort((x, y) => x.hits - y.hits);
    (this.shotCache ||= [])[k] = { key, out: list };
    return list;
  }

  /** The briefing's timeline: every planned impact from both packages in order, so attacks can be lined up. */
  timingSection() {
    const flying = [0, 1].filter((k) => this.pkgs[k].length && this.routes[k]?.length >= 3);
    if (!flying.length) return null;
    const both = flying.length > 1;
    const rows = flying.flatMap((k) => this.shots(k).map((sh) => ({ ...sh, k })));
    rows.sort((x, y) => x.hits - y.hits);
    const home = flying.map((k) => {
      const r = this.routes[k], at = timeline(r, this.pkgs[k].map((a) => a.type)).at;
      return h('div', { class: 'ds-kv' }, h('span', { style: k ? { color: B_COL } : null }, `${both ? `Package ${PKG_NAME[k]}` : 'The package'} home`), h('b', {}, clock(at[r.length - 1] ?? 0)));
    });
    return this.section('TIMING',
      h('div', { class: 'ds-note' }, 'Planned times from take-off: turn points on the map show when the package gets there, weapons when they go and land. HARM times (~) assume the radar is on.'),
      ...rows.map((sh) => h('div', { class: 'ds-time' },
        h('b', { style: { color: sh.harm ? '#7cf' : COL.short } }, `${sh.harm ? '~' : ''}${clock(sh.hits)}`),
        h('span', { class: 'grow' }, h('span', { style: sh.k ? { color: B_COL } : null }, `${both && !sh.k ? 'A · ' : ''}${sh.jet}`), `: ${sh.n > 1 ? sh.n + '× ' : ''}${sh.short} at ${sh.what}`, h('span', { class: 'faint' }, ` (away ${clock(sh.away)})`)))),
      ...home);
  }

  drawSniffer(ctx, v) {
    const s = this.sim;
    if (!(s instanceof SnifferSim)) return;
    const j = s.jet;
    if (s.path.length) {
      ctx.strokeStyle = 'rgba(182,243,106,0.6)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(v.sx(j.x), v.sy(j.y));
      for (const p of s.path) ctx.lineTo(v.sx(p.x), v.sy(p.y));
      ctx.stroke(); ctx.setLineDash([]);
    }
    this.jetIcon(ctx, v.sx(j.x), v.sy(j.y), j.hdg, j.alive ? COL.sniffer : '#555', 9);
    v.label(j.alive ? 'SNIFFER' : 'SNIFFER (DOWN)', j.x, j.y, j.alive ? COL.sniffer : COL.faint, { dx: 12 });
  }

  drawStrike(ctx, v) {
    const s = this.sim;
    for (const d of s.decoys) if (d.alive) { ctx.fillStyle = COL.short; ctx.fillRect(v.sx(d.x) - 2, v.sy(d.y) - 2, 4, 4); }
    for (const w of s.weapons) {
      if (w.dead || w.delay > 0) continue;
      ctx.fillStyle = w.mu === 'harm' ? '#7cf' : '#ffd84a';
      ctx.beginPath(); ctx.arc(v.sx(w.x), v.sy(w.y), 2, 0, Math.PI * 2); ctx.fill();
    }
    for (const j of s.jets) if (j.alive) this.jetIcon(ctx, v.sx(j.x), v.sy(j.y), j.f.pos.hdg || 0, j.f.k ? B_COL : COL.friend, 7);
    // enemy fighters, once a radar or warning receiver has them (all of them in the debrief)
    for (const b of s.bandits || []) if (b.alive && (b.seen || this.phase === 'debrief')) {
      this.jetIcon(ctx, v.sx(b.x), v.sy(b.y), b.hdg, COL.enemy, 7);
      v.label(b.F.name, b.x, b.y, COL.enemy, { dx: 10, dy: -8, font: '10px ui-monospace, Consolas, monospace' });
    }
    for (const f of s.flights) if (!f.done) v.label(`${s.flights.length > 1 ? f.name + ' · ' : ''}${Math.round(f.pos.alt)} m`, f.pos.x, f.pos.y, f.k ? B_COL : COL.friend, { dx: 14, dy: 10, font: '10px ui-monospace, Consolas, monospace' });
  }

  drawMissiles(ctx, v) {
    const s = this.sim;
    for (const ms of s.missiles) {
      if (ms.dead || ms.delay > 0) continue;
      const x = v.sx(ms.x), y = v.sy(ms.y), site = s.site[ms.site];
      ctx.strokeStyle = 'rgba(255,90,90,0.35)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(v.sx(site.x), v.sy(site.y)); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = COL.enemy; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
    }
    for (const a of s.aams || []) {
      if (a.dead) continue;
      ctx.fillStyle = a.red ? COL.enemy : '#9fe8ff';
      ctx.beginPath(); ctx.arc(v.sx(a.x), v.sy(a.y), 2.2, 0, Math.PI * 2); ctx.fill();
    }
    for (const f of s.fx) {
      const age = s.t - f.t;
      if (age > 8) continue;
      const col = f.kind === 'kill' ? COL.enemy : f.kind === 'hit' ? '#ff9a3d' : f.kind === 'pd' || f.kind === 'dud' ? COL.faint : f.kind === 'decoy' ? COL.short : '#aab';
      ctx.strokeStyle = col; ctx.globalAlpha = Math.max(0, 1 - age / 8); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(v.sx(f.x), v.sy(f.y), 4 + age * 2.2, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (s.fx.length > 200) s.fx = s.fx.filter((f) => s.t - f.t < 8);
  }

  jetIcon(ctx, x, y, hdg, col, r) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(hdg);
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(-r * 0.7, r * 0.6); ctx.lineTo(-r * 0.35, 0); ctx.lineTo(-r * 0.7, -r * 0.6); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  status() {
    return { left: [{ text: this.phase === 'sniffer' ? 'Click to steer the sniffer · Shift+click adds a waypoint · Space runs / pauses · wheel zooms · drag pans'
      : this.phase === 'brief' ? 'Shift+click adds a route point to the picked package (click its section to pick) · click a line to insert one · drag to move (the origin slides along its arc) · right-click removes · Alt / Z+wheel on a point: its leg’s height / speed · wheel zooms'
      : this.phase === 'strike' ? 'Space runs / pauses · Shift+click adds the picked package’s next point · drag points ahead to re-route · Alt / Z+wheel on a point: its leg’s height / speed · wheel zooms · drag pans' : 'Wheel zooms · drag pans' }] };
  }

  onShow() { this.view?.resize(); }
  onHide() { if (this.sim && !this.sim.done && !this.paused) this.setPaused(true); } // off screen: the clock stops
  destroy() { removeEventListener('keydown', this.zKeys); removeEventListener('keyup', this.zKeys); removeEventListener('blur', this.zOff); this.stopLoop(); this.ro?.disconnect(); clearTimeout(this.saveT); if (this.pauseMenu) this.closePauseMenu(); }
}

export { THEATRE };
