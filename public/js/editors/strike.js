// Deep Strike: a strike-planning game reached from the carrier screen of the easter egg. Each mission is an objective
// in the theatre (a real airfield, an air defence site or an industrial complex) inside a made-up air defence
// network. Fly a sniffer around the network's edges to hear its radars, buy a strike package, draw its route (each
// leg at its own height and speed), then fly it in real time (re-routing as it goes) and see what it did.

import { BaseEditor } from './base.js';
import { h, clear } from '../core/dom.js';
import { confirmDialog, toast } from '../core/ui.js';
import { ALTS, ALT_ORDER, SPEEDS, SPEED_ORDER, AIRCRAFT, AIRCRAFT_ORDER, MUNITIONS, SAMS, SNIFFER, TARGETS, reach } from './strike/data.js';
import { Proj, loadWorld, horizon, dist, toSegment, whereIs, THEATRE } from './strike/geo.js';
import { makeMission, REGIONS, TYPE_NAME, targetName, targetXY, alive, targetHp, lower } from './strike/mission.js';
import { SnifferSim, StrikeSim, DT, CLIMB, DESCEND } from './strike/sim.js';
import { MapView, COL } from './strike/view.js';
import { briefing } from './strike/story.js';
import { Terrain, BIOMES, describe } from './strike/terrain.js';

const PHASES = [['mission', 'MISSION'], ['sniffer', 'SNIFFER'], ['brief', 'BRIEFING'], ['strike', 'STRIKE'], ['debrief', 'DEBRIEF']];
const SPEEDUPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
const LEG_COL = { deck: '#6fe08a', low: '#5ec8ff', med: '#c9a8ff', high: '#e8eef3' };
const RING_COL = { long: COL.enemy, medium: COL.medium, short: COL.short };
const clone = (o) => JSON.parse(JSON.stringify(o));
const money = (m) => `$${m >= 100 ? Math.round(m) : m >= 10 ? m.toFixed(1) : m.toFixed(2)}M`;
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
const stationCost = (st) => (st.mu ? MUNITIONS[st.mu].cost * MUNITIONS[st.mu].per : 0);
const jetCost = (a) => AIRCRAFT[a.type].cost + a.stations.reduce((n, s) => n + stationCost(s), 0);

/** Where along the route a weapon first gets within reach of a point: { x, y, leg } or null. Follows the jets'
 *  real height as they climb and descend between legs (reach grows with height), the way the strike flies it. */
function releasePoint(route, at, mu) {
  let alt = ALTS[route[0].alt].m;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1], want = ALTS[a.alt].m;
    const L = dist(a, b), n = Math.max(1, Math.ceil(L / 2)), kmPerStep = L / n;
    const perKm = 3600 / Math.min(SPEEDS[a.spd].kmh, want < 400 ? 1100 : Infinity); // seconds per km
    for (let k = 0; k <= n; k++) {
      const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
      if (dist(p, at) <= reach(mu, alt)) return { ...p, leg: i };
      const dt = kmPerStep * perKm;
      alt = alt < want ? Math.min(want, alt + CLIMB * dt) : Math.max(want, alt - DESCEND * dt);
    }
  }
  return null;
}

export class StrikeEditor extends BaseEditor {
  static mode = 'strike';

  async load() {
    if (!this.app.settings.tomcatEnabled && !this.app.settings.strikeEnabled) { this.pane.append(h('div', { class: 'loading-pane' }, 'Nothing here.')); return; }
    this.canvas = h('canvas', { class: 'ds-canvas', tabindex: '0' });
    this.panel = h('div', { class: 'ds-panel' });
    this.top = h('div', { class: 'ds-top' });
    this.root = h('div', { class: 'ds-root', 'data-no-clip': '' }, this.top, h('div', { class: 'ds-body' }, (this.mapwrap = h('div', { class: 'ds-mapwrap' }, this.canvas, (this.tip = h('div', { class: 'ds-tip', hidden: true })), (this.legend = h('div', { class: 'ds-legend', hidden: true })))), this.panel));
    this.pane.append(this.root);
    this.proj = new Proj();
    this.view = new MapView(this.canvas, { onDraw: (ctx, v) => this.drawLayers(ctx, v) });
    this.speed = 8;
    this.paused = true;
    this.autoPause = true;
    this.sel = null;
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
    this.view.setWorld(this.world);
    this.renderLegend();
    const cur = this.store().cur;
    if (cur?.mission?.v === 1) {
      this.mission = cur.mission;
      this.pkg = cur.pkg || [];
      this.route = cur.route || null;
      this.setPhase(cur.phase === 'brief' ? 'brief' : cur.phase === 'sniffer' ? 'sniffer' : 'mission', { keep: true });
    } else this.newMission();
  }

  // ---------------------------------------------------------------- saving (settings.tomcatStrike: goes with the setup export)

  store() { return this.app.settings.tomcatStrike || {}; }
  save(patch) { this.app.saveSettings({ tomcatStrike: { ...this.store(), ...patch } }); }
  saveCur() {
    if (!this.mission) return;
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => this.save({ cur: { mission: this.plan || this.mission, phase: this.phase === 'strike' || this.phase === 'debrief' ? 'brief' : this.phase, pkg: this.pkg, route: this.route } }), 400);
  }

  // ---------------------------------------------------------------- phases

  newMission(type) {
    this.stopLoop();
    this.mission = makeMission(this.world, this.proj, undefined, type || this.wantType, this.wantRegion);
    this.pkg = [];
    this.route = null;
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
      if (!this.route) this.route = [{ ...m.origin, alt: 'med', spd: 'cruise' }, { ...m.origin, alt: 'med', spd: 'cruise', home: true }];
      this.plan = null;
    }
    if (p === 'strike') {
      this.plan = clone({ mission: m, pkg: this.pkg, route: this.route });
      this.live = clone(m);
      this.sim = new StrikeSim(this.live, clone(this.pkg), this.route, this.terrain);
      this.route = this.sim.route; // re-routing in flight edits the sim's own copy
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
    this.save({ stats: st, cur: { mission: this.plan.mission, phase: 'brief', pkg: this.plan.pkg, route: this.plan.route } });
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
    if (this.autoPause && e.kind === 'warn' && /launch|Pop-up/.test(e.text)) { this.paused = true; this.renderTop(); this.renderPanel(); }
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
    ] : [];
    this.clockEl = h('span', { class: 'ds-clock' }, this.sim ? clock(this.sim.t) : '');
    clear(this.top).append(h('span', { class: 'ds-title' }, 'DEEP STRIKE'), h('span', { class: 'ds-code' }, `OBJECTIVE ${this.mission?.code || ''}`),
      h('div', { class: 'ds-steps' }, ...steps), h('div', { class: 'grow' }),
      h('button', { class: `ds-btn sm${this.showTerrain ? ' on' : ''}`, title: 'Terrain overlay (T): the biomes, and what each does to a low package. Hover the map to see.', onclick: () => this.toggleTerrain() }, 'TERRAIN'),
      ...ctl, this.clockEl);
  }

  /** One button for the time speed: click or scroll up for faster, right-click or scroll down for slower. */
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
    else if (this.nowEl && this.sim?.pos) this.nowEl.textContent = `${Math.round(this.sim.pos.alt)} m · ${Math.round(this.sim.pos.kmh)} km/h`;
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
    const story = briefing(m, { place: s.name, where: whereIs(this.world, s, 30000), sam: s.sam ? SAMS[s.sam].long : null, budget: money(m.budget) });
    return [
      this.section('BRIEFING', ...story.map((p) => h('p', { class: 'ds-story' }, p))),
      this.section(`${TYPE_NAME[m.type].toUpperCase()}`, h('div', { class: 'ds-big' }, s.name), / of /.test(s.name) ? null : h('div', { class: 'faint' }, whereIs(this.world, s, 30000)),
        m.region ? h('div', { class: 'ds-kv' }, h('span', {}, 'Region'), h('b', {}, REGIONS[m.region])) : null,
        h('div', { class: 'ds-kv' }, h('span', {}, 'Primary target'), this.objectiveLine()),
        h('div', { class: 'ds-kv' }, h('span', {}, 'Budget'), h('b', {}, money(m.budget))),
        h('div', { class: 'ds-kv' }, h('span', {}, 'From the origin'), h('b', {}, `${Math.round(dist(m.origin, s))} km`))),
      this.section('INSIDE THE OBJECTIVE', ...this.targetSummary(s)),
      this.section('HOW IT GOES', h('div', { class: 'ds-note' },
        'Fly the sniffer first: it hears the radars around the objective and marks each one with its type and reach. Then buy jets and weapons, draw the route (each leg at its own height and speed) and fly it. ',
        'Low legs hide behind the curve of the earth until a radar is close; high legs see further and throw weapons further, but every radar sees them.')),
      this.section(null, h('div', { class: 'ds-row' }, regionSel), h('div', { class: 'ds-row' }, typeSel, h('button', { class: 'ds-btn', onclick: () => this.newMission() }, 'NEW MISSION')),
        h('button', { class: 'ds-btn primary wide', onclick: () => this.setPhase('sniffer') }, 'FLY THE SNIFFER →')),
      st.flown ? this.section('RECORD', h('div', { class: 'ds-note' }, `${st.flown} flown · ${st.won || 0} objectives destroyed · ${st.jetsLost || 0} jets lost · ${money(st.spent || 0)} spent`)) : null,
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
        h('div', { class: 'ds-note' }, done ? (done.why === 'shot' ? 'The sniffer was shot down. You plan with what it heard.' : 'The sniffer is home.')
          : 'Click the map to fly there (Shift+click adds a waypoint). Every radar it hears goes on the map with its type and reach. Fly into a site’s missile range and it shoots: stay on the edges. The phase ends when it’s back at the origin.'),
        done ? null : h('div', { class: 'ds-row' },
          h('button', { class: 'ds-btn', onclick: () => { s.home(); this.setPaused(false); } }, 'RETURN TO ORIGIN'),
          h('button', { class: 'ds-btn', title: 'Stop here and plan with what it has heard', onclick: () => this.setPhase('brief') }, 'END FLIGHT'),
          h('span', { class: 'faint' }, `${Math.round(s.flown)} km flown`)),
        done ? h('button', { class: 'ds-btn primary wide', onclick: () => this.setPhase('brief') }, 'PLAN THE STRIKE →') : null),
      this.section(`HEARD (${found.length})`, ...(found.length ? found.map((x) => this.siteRow(x)) : [h('div', { class: 'faint' }, 'Nothing yet.')])),
      this.logSection(),
    ];
  }

  siteRow(x) {
    const S = x.sam ? SAMS[x.sam] : null;
    return h('div', { class: `ds-srow${this.sel?.site === x.id ? ' on' : ''}`, onclick: () => { this.sel = { site: x.id }; this.renderPanel(); this.view.request(); } },
      h('span', { class: 'ds-dot', style: { background: S ? RING_COL[S.ring] : COL.unknown } }),
      h('span', { class: 'grow' }, S ? S.long : x.name), S ? h('span', { class: 'faint' }, `${S.missile.km} km`) : null);
  }

  logSection(n = 14) {
    const log = this.sim?.log || [];
    return this.section('LOG', ...log.slice(-n).reverse().map((e) => h('div', { class: `ds-log ${e.kind}` }, h('span', { class: 'faint' }, clock(e.t).slice(3)), ' ', e.text)));
  }

  // ---- briefing

  panel_brief() {
    const m = this.mission;
    const cost = this.pkg.reduce((n, a) => n + jetCost(a), 0);
    const over = cost > m.budget + 1e-9;
    const add = h('select', { class: 'ds-sel' }, h('option', { value: '' }, '+ Add a jet…'),
      ...AIRCRAFT_ORDER.map((id) => h('option', { value: id }, `${AIRCRAFT[id].name} · ${money(AIRCRAFT[id].cost)}`)));
    add.addEventListener('change', () => {
      if (!add.value) return;
      const A = AIRCRAFT[add.value];
      this.pkg.push({ type: A.id, stations: Array.from({ length: A.stations }, () => ({ mu: null, n: 0, target: null })) });
      this.changed();
    });
    const km = routeKm(this.route);
    const fuels = [...new Set(this.pkg.map((a) => a.type))].map((t) => [t, fuelUse(this.route, t, this.terrain)]);
    const worst = fuels.reduce((a, b) => (b[1] > a[1] ? b : a), ['', 0]);
    const issues = this.planIssues();
    return [
      this.section('BUDGET', h('div', { class: 'ds-budget' }, h('div', { class: `ds-bar${over ? ' over' : ''}`, style: { width: `${Math.min(100, (cost / m.budget) * 100)}%` } })),
        h('div', { class: 'ds-kv' }, h('span', {}, `${money(cost)} of ${money(m.budget)}`), over ? h('b', { class: 'bad' }, 'over budget') : h('span', { class: 'faint' }, `${money(m.budget - cost)} left`)),
        this.objectiveLine()),
      this.section(`PACKAGE (${this.pkg.length})`, ...this.pkg.map((a, i) => this.jetCard(a, i)), add),
      this.section('ROUTE', h('div', { class: 'ds-note' }, 'Shift+click the map to add the next turn point (after the selected one), or click a line to put one in it; drag points to move them, right-click one to remove it. Click a point to set the height and speed of the leg that starts there.'),
        h('div', { class: 'ds-kv' }, h('span', {}, 'Length'), h('b', {}, `${Math.round(km)} km`)),
        ...fuels.map(([t, f]) => h('div', { class: 'ds-kv' }, h('span', {}, `Fuel, ${AIRCRAFT[t].name}`), h('b', { class: f > 1 ? 'bad' : f > 0.85 ? 'warn' : '' }, `${Math.round(f * 100)}%`))),
        this.legEditor()),
      issues.length ? this.section('CHECK', ...issues.map((t) => h('div', { class: 'ds-log warn' }, t))) : null,
      this.section(null, h('div', { class: 'ds-row' },
        h('button', { class: 'ds-btn', onclick: () => this.setPhase('mission') }, '← MISSION'),
        h('button', { class: 'ds-btn primary grow', disabled: !this.pkg.length || over || this.route.length < 3, onclick: () => this.launch(worst) }, 'LAUNCH THE STRIKE →'))),
    ];
  }

  planIssues() {
    const m = this.mission, out = [];
    if (this.route.length < 3) out.push('Draw a route: Shift+click the map to add turn points.');
    const objT = m.sites.find((s) => s.id === m.objective.site).targets[m.objective.idx];
    const onObj = this.pkg.some((a) => a.stations.some((s) => s.mu && s.target?.site === m.objective.site && s.target.idx === m.objective.idx));
    if (this.pkg.length && !onObj) out.push(`No weapon is aimed at the primary target (${lower(targetName(objT))}).`);
    for (const [i, a] of this.pkg.entries()) for (const s of a.stations) {
      if (!s.mu || !s.target || s.target === 'auto' || s.mu === 'harm' || s.mu === 'mald') continue;
      const site = m.sites.find((x) => x.id === s.target.site), t = site?.targets[s.target.idx];
      if (t && !releasePoint(this.route, targetXY(site, t), MUNITIONS[s.mu])) out.push(`${AIRCRAFT[a.type].name} ${i + 1}: the ${MUNITIONS[s.mu].short} never gets within reach of the ${lower(targetName(t))} on this route.`);
    }
    for (const t of new Set(this.pkg.map((a) => a.type))) if (fuelUse(this.route, t, this.terrain) > 1) out.push(`The ${AIRCRAFT[t].name} doesn’t have the fuel for this route.`);
    return out;
  }

  jetCard(a, i) {
    const A = AIRCRAFT[a.type];
    const rm = h('button', { class: 'ds-x', title: 'Take this jet out', onclick: () => { this.pkg.splice(i, 1); this.changed(); } }, '×');
    return h('div', { class: 'ds-jet' },
      h('div', { class: 'ds-jet-h' }, h('b', {}, `${i + 1}. ${A.name}`), h('span', { class: 'faint' }, money(jetCost(a))), rm),
      ...a.stations.map((st, k) => this.stationRow(a, st, k)));
  }

  stationRow(a, st, k) {
    const A = AIRCRAFT[a.type], m = this.mission;
    const muSel = h('select', { class: 'ds-sel sm', title: st.mu ? MUNITIONS[st.mu].what : 'What goes on this station' }, h('option', { value: '' }, `Station ${k + 1}: empty`),
      ...A.weapons.map((id) => { const mu = MUNITIONS[id]; return h('option', { value: id }, `${mu.per > 1 ? mu.per + '× ' : ''}${mu.short} · ${money(mu.cost * mu.per)}`); }));
    muSel.value = st.mu || '';
    muSel.addEventListener('change', () => {
      st.mu = muSel.value || null;
      st.n = st.mu ? MUNITIONS[st.mu].per : 0;
      st.target = st.mu === 'harm' ? 'auto' : st.mu && st.mu !== 'mald' ? this.defaultTarget(st.mu) : null;
      this.changed();
    });
    if (!st.mu || st.mu === 'mald') return h('div', { class: 'ds-st' }, muSel, st.mu === 'mald' ? h('span', { class: 'faint sm' }, 'at the decoy point, or when first shot at') : null);
    const tSel = h('select', { class: 'ds-sel sm' });
    const known = m.sites.filter((s) => m.known[s.id]);
    if (st.mu === 'harm') {
      tSel.append(h('option', { value: 'auto' }, 'Any radar that’s on'), ...known.filter((s) => s.sam).map((s) => h('option', { value: s.id }, `Radars of ${SAMS[s.sam].long} · ${whereIs(this.world, s, 30000)}`)));
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

  legEditor() {
    const r = this.route;
    const i = this.sel?.node;
    const editable = i != null && r[i] && !r[i].home && (this.phase !== 'strike' || i >= this.sim.leg);
    if (!editable) return h('div', { class: 'faint' }, 'Select a point on the route to set its leg.');
    const p = r[i];
    const seg = (order, table, key) => h('div', { class: 'ds-seg' }, ...order.map((id) => h('button', {
      class: `ds-btn sm${p[key] === id ? ' on' : ''}`, title: table[id].tip || '', onclick: () => { p[key] = id; this.changed(); },
    }, table[id].name)));
    return h('div', { class: 'ds-leg' },
      h('div', { class: 'ds-h2' }, i === 0 ? 'FIRST LEG (from the origin)' : `LEG FROM POINT ${i}`),
      seg(ALT_ORDER, ALTS, 'alt'), seg(SPEED_ORDER, SPEEDS, 'spd'),
      h('label', { class: 'ds-check' }, h('input', { type: 'checkbox', checked: !!p.decoys, onchange: (e) => { p.decoys = e.target.checked; this.changed(); } }), 'Launch decoys here'),
      i > 0 && (this.phase !== 'strike' || i > this.sim.leg) ? h('button', { class: 'ds-btn sm', onclick: () => this.removeNode(i) }, 'Remove this point') : null);
  }

  changed() { this.renderPanel(); this.view.request(); if (this.phase === 'brief') this.saveCur(); }

  async launch(worst) {
    if (worst[1] > 1 && !(await confirmDialog('Not enough fuel', `The ${AIRCRAFT[worst[0]].name} won’t make it home on this route (${Math.round(worst[1] * 100)}% of its fuel). Launch anyway?`, { okLabel: 'Launch' }))) return;
    this.setPhase('strike');
  }

  // ---- the strike

  panel_strike() {
    const s = this.sim;
    const jets = s.jets.map((j, i) => {
      const load = new Map();
      for (const st of j.stations) if (st.n && st.mu) load.set(st.mu, (load.get(st.mu) || 0) + st.n);
      const left = [...load].map(([mu, n]) => `${n}× ${MUNITIONS[mu].short}`).join(', ');
      return h('div', { class: `ds-srow${j.alive ? '' : ' dead'}` }, h('span', { class: 'ds-ico' }, j.alive ? '✈' : '✕'),
        h('span', { class: 'grow' }, `${i + 1}. ${j.A.name}`), h('span', { class: `faint${j.fuel > 0.9 ? ' bad' : ''}` }, j.alive ? `${Math.max(0, Math.round((1 - j.fuel) * 100))}% fuel` : 'lost'),
        left && j.alive ? h('div', { class: 'ds-sub' }, left) : null);
    });
    const p = s.pos;
    return [
      s.done ? this.section(null, h('div', { class: 'ds-big' }, s.done.why === 'home' ? 'The package is home.' : 'The package is lost.'),
        h('button', { class: 'ds-btn primary wide', onclick: () => this.setPhase('debrief') }, 'DEBRIEF →')) : null,
      this.section('PACKAGE', h('div', { class: 'ds-kv' }, h('span', {}, 'Now'), (this.nowEl = h('b', {}, `${Math.round(p.alt)} m · ${Math.round(p.kmh)} km/h`))),
        h('div', { class: 'ds-kv' }, h('span', {}, 'Defences'), h('b', { class: s.alert ? 'bad' : 'good' }, s.alert ? 'awake' : 'not seen yet')),
        ...jets,
        s.done ? null : h('div', { class: 'ds-row' },
          h('button', { class: 'ds-btn', title: 'Turn for home now, straight back', onclick: () => { s.rtb(); this.route = s.route; this.sel = null; this.renderPanel(); this.view.request(); } }, 'RTB NOW'),
          h('button', { class: 'ds-btn', title: 'Stop the strike here and go to the debrief', onclick: () => this.endStrike() }, 'END MISSION'),
          h('label', { class: 'ds-check' }, h('input', { type: 'checkbox', checked: this.autoPause, onchange: (e) => { this.autoPause = e.target.checked; } }), 'Pause on a launch'))),
      s.done ? null : this.overrideSection(),
      s.done ? null : this.section('ROUTE', h('div', { class: 'ds-note' }, 'Edit the route ahead as it flies (pausing gives you time): Shift+click adds the next point after the selected one, click a line ahead to insert one, drag or right-click the points ahead.'), this.legEditor()),
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

  /** Height and speed for the leg being flown, changed on the spot (running or paused). The rest of the route keeps its plan. */
  overrideSection() {
    const s = this.sim, p = s.node;
    if (!p || !s.next) return null;
    const seg = (order, table, key) => h('div', { class: 'ds-seg' }, ...order.map((id) => h('button', {
      class: `ds-btn sm${p[key] === id ? ' on' : ''}`, title: table[id].tip || '',
      onclick: () => { p[key] = id; this.renderPanel(); this.view.request(); },
    }, table[id].name)));
    return this.section('THIS LEG, NOW', h('div', { class: 'ds-note' }, `Leg ${s.leg + 1} of ${s.route.length - 1}: the package takes the new height and speed straight away.`),
      seg(ALT_ORDER, ALTS, 'alt'), seg(SPEED_ORDER, SPEEDS, 'spd'));
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
        ...s.lost.map((l) => h('div', { class: 'ds-log loss' }, `${l.jet.A.name}: ${l.why === 'fuel' ? 'out of fuel' : 'shot down by a ' + l.why}`))),
      this.section(`DESTROYED (${killed.length})`, ...(killed.length ? killed.map((t) => h('div', { class: 'ds-log kill' }, t)) : [h('div', { class: 'faint' }, 'Nothing.')])),
      this.section('THE DEFENCES, REVEALED', ...m.sites.filter((x) => x.sam).map((x) => h('div', { class: 'ds-srow' },
        h('span', { class: 'ds-dot', style: { background: RING_COL[SAMS[x.sam].ring] } }), h('span', { class: 'grow' }, `${SAMS[x.sam].long}${this.plan.mission.known[x.id] ? '' : ' (never found)'}`),
        h('span', { class: 'faint' }, `${x.fired} of ${x.missiles} missiles`)))),
      this.section(null, h('div', { class: 'ds-row' },
        h('button', { class: 'ds-btn', onclick: () => this.flyAgain() }, 'FLY IT AGAIN'),
        h('button', { class: 'ds-btn primary grow', onclick: () => this.newMission() }, 'NEW MISSION'))),
    ];
  }

  flyAgain() {
    const p = this.plan;
    this.mission = clone(p.mission);
    this.pkg = clone(p.pkg);
    this.route = clone(p.route);
    this.live = null;
    this.setPhase('brief');
  }

  // ---------------------------------------------------------------- the map: input

  routeEditable() { return this.phase === 'brief' || (this.phase === 'strike' && !this.sim.done); }

  hit(px, py) {
    const v = this.view;
    if (this.route && (this.phase === 'brief' || this.phase === 'strike')) {
      for (let i = this.route.length - 2; i >= 0; i--) {
        const p = this.route[i];
        if (Math.hypot(v.sx(p.x) - px, v.sy(p.y) - py) < 9) return { node: i };
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
    c.addEventListener('wheel', (e) => { e.preventDefault(); const r = c.getBoundingClientRect(); this.view.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const hit = this.hit(e.clientX - r.left, e.clientY - r.top);
      if (hit?.node > 0 && this.routeEditable() && (this.phase !== 'strike' || hit.node > this.sim.leg)) this.removeNode(hit.node);
    });
    c.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      c.focus();
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const hit = e.button === 0 ? this.hit(px, py) : null;
      const dragNode = hit?.node != null && this.routeEditable() && hit.node > 0 && (this.phase !== 'strike' || hit.node > this.sim.leg) ? hit.node : null;
      let moved = false, lx = e.clientX, ly = e.clientY;
      c.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        moved = true;
        if (dragNode != null) {
          const p = this.route[dragNode];
          p.x = this.view.wx(ev.clientX - r.left); p.y = this.view.wy(ev.clientY - r.top);
          this.view.request();
        } else { this.view.pan(ev.clientX - lx, ev.clientY - ly); }
        lx = ev.clientX; ly = ev.clientY;
      };
      const up = (ev) => {
        c.removeEventListener('pointermove', move);
        c.removeEventListener('pointerup', up);
        if (dragNode != null && moved) { this.sel = { node: dragNode }; this.changed(); return; }
        if (!moved && e.button === 0) this.click(px, py, hit, ev);
      };
      c.addEventListener('pointermove', move);
      c.addEventListener('pointerup', up);
    });
    c.addEventListener('pointermove', (e) => { if (!e.buttons) this.hover(e); });
    c.addEventListener('pointerleave', () => { this.tip.hidden = true; });
    c.addEventListener('keydown', (e) => {
      if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); this.toggleTerrain(); }
      if (e.key === ' ' && (this.phase === 'sniffer' || this.phase === 'strike')) { e.preventDefault(); this.setPaused(!this.paused); }
    });
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

  /** With the terrain overlay on: what the ground under the pointer does to the package. */
  hover(e) {
    if (!this.showTerrain || !this.terrain) { this.tip.hidden = true; return; }
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const d = describe(this.terrain.at(this.view.wx(px), this.view.wy(py)));
    clear(this.tip).append(h('div', { class: 'ds-tip-h' }, h('span', { class: 'ds-swatch', style: { background: d.col } }), d.name),
      h('div', { class: 'ds-tip-what' }, d.what), ...d.lines.map((l) => h('div', { class: 'ds-tip-line' }, l)));
    this.tip.hidden = false;
    const w = this.tip.offsetWidth, ht = this.tip.offsetHeight;
    this.tip.style.left = `${Math.min(px + 16, r.width - w - 8)}px`;
    this.tip.style.top = `${py + 16 + ht > r.height ? py - ht - 12 : py + 16}px`;
  }

  click(px, py, hit, e) {
    const x = this.view.wx(px), y = this.view.wy(py);
    if (hit?.node != null) { this.sel = { node: hit.node }; this.renderPanel(); this.view.request(); return; }
    if (hit?.site) { this.sel = { site: hit.site }; this.renderPanel(); this.view.request(); if (this.phase !== 'sniffer') return; }
    if (this.phase === 'sniffer' && !this.sim.done) {
      this.sim.goTo({ x, y }, e.shiftKey);
      if (this.paused) this.setPaused(false);
      return;
    }
    if (!this.routeEditable()) return;
    // on a line: a point in it. Shift+click elsewhere: the next point after the selected one (or at the end, before
    // the way home), selected so more Shift+clicks keep adding legs. A plain click on empty map just deselects.
    const r = this.route, P = { x: px, y: py };
    const first = this.phase === 'strike' ? this.sim.leg : 0;
    let at = -1, bd = 8;
    for (let i = first; i < r.length - 1; i++) {
      const sa = { x: this.view.sx(r[i].x), y: this.view.sy(r[i].y) }, sb = { x: this.view.sx(r[i + 1].x), y: this.view.sy(r[i + 1].y) };
      const d = toSegment(P, sa, sb).d;
      if (d < bd) { bd = d; at = i + 1; }
    }
    if (at < 0) {
      if (!e.shiftKey) { if (this.sel) { this.sel = null; this.renderPanel(); this.view.request(); } return; }
      const i = this.sel?.node;
      at = i != null && i >= first && i < r.length - 1 ? i + 1 : r.length - 1;
    }
    const prev = r[at - 1];
    r.splice(at, 0, { x, y, alt: prev.alt, spd: prev.spd });
    this.sel = { node: at };
    this.changed();
  }

  removeNode(i) {
    if (i <= 0 || i >= this.route.length - 1) return;
    this.route.splice(i, 1);
    this.sel = null;
    this.changed();
  }

  // ---------------------------------------------------------------- the map: drawing

  drawLayers(ctx, v) {
    const m = this.live || this.mission;
    if (!m) return;
    const reveal = this.phase === 'debrief';
    if (this.showTerrain && this.terrain) this.terrain.draw(ctx, v);
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
    // what the radars would see at the selected leg's height
    const legP = this.sel?.node != null && this.route?.[this.sel.node];
    if (legP && !legP.home && this.phase === 'brief') {
      const alt = ALTS[legP.alt].m, rcs = Math.max(1.2, ...this.pkg.map((a) => AIRCRAFT[a.type].rcs));
      for (const s of m.sites) {
        if (!s.sam || !m.known[s.id]) continue;
        const sp = SAMS[s.sam].search;
        const km = Math.min(horizon(sp.h, alt), sp.km * Math.pow(rcs / 5, 0.25));
        v.circle(s.x, s.y, km, 'rgba(255,255,255,0.28)', null, [2, 4]);
      }
    }
    this.drawSites(ctx, v, m, reveal);
    // the origin
    const o = m.origin;
    ctx.fillStyle = COL.friend;
    ctx.beginPath(); ctx.moveTo(v.sx(o.x), v.sy(o.y) - 7); ctx.lineTo(v.sx(o.x) + 6, v.sy(o.y) + 5); ctx.lineTo(v.sx(o.x) - 6, v.sy(o.y) + 5); ctx.closePath(); ctx.fill();
    v.label('ORIGIN', o.x, o.y, COL.friend, { dx: 10 });
    if (this.route && (this.phase === 'brief' || this.phase === 'strike' || this.phase === 'debrief')) this.drawRoute(ctx, v);
    if (this.phase === 'sniffer' || (this.sim instanceof SnifferSim)) this.drawSniffer(ctx, v);
    if (this.sim instanceof StrikeSim) this.drawStrike(ctx, v);
    if (this.sim) this.drawMissiles(ctx, v);
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
      const name = primary ? `★ ${m.code}` : S ? S.name : s.name;
      if (primary || v.scale > 0.9 || this.sel?.site === s.id) v.label(name, s.x, s.y, col, { dx: primary ? 15 : 9 });
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

  drawRoute(ctx, v) {
    const r = this.route;
    const sim = this.phase === 'strike' || this.phase === 'debrief' ? this.sim : null;
    for (let i = 0; i < r.length - 1; i++) {
      const a = r[i], b = r[i + 1];
      const past = sim && i < sim.leg;
      ctx.strokeStyle = past ? 'rgba(140,160,180,0.35)' : LEG_COL[a.alt];
      ctx.lineWidth = a.spd === 'dash' ? 3 : a.spd === 'fast' ? 2.2 : 1.6;
      ctx.setLineDash(b.home ? [6, 5] : []);
      ctx.beginPath(); ctx.moveTo(v.sx(a.x), v.sy(a.y)); ctx.lineTo(v.sx(b.x), v.sy(b.y)); ctx.stroke();
      ctx.setLineDash([]);
      if (!past && v.scale > 0.5 && dist(a, b) * v.scale > 70) {
        v.label(`${ALTS[a.alt].name.toUpperCase()} · ${SPEEDS[a.spd].name.toUpperCase()}`, (a.x + b.x) / 2, (a.y + b.y) / 2, LEG_COL[a.alt], { dx: 6, dy: -8, font: '9.5px ui-monospace, Consolas, monospace' });
      }
    }
    r.forEach((p, i) => {
      if (i === 0 || p.home) return;
      const past = sim && i <= sim.leg;
      const x = v.sx(p.x), y = v.sy(p.y), on = this.sel?.node === i;
      ctx.fillStyle = past ? '#556' : on ? '#fff' : COL.node;
      ctx.beginPath(); ctx.arc(x, y, on ? 6 : 4.5, 0, Math.PI * 2); ctx.fill();
      if (p.decoys) { ctx.strokeStyle = COL.short; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke(); }
      v.label(String(i), p.x, p.y, past ? '#667' : COL.node, { dx: 8, dy: -8, font: '10px ui-monospace, Consolas, monospace' });
    });
    if (this.phase !== 'brief') return;
    // where each weapon gets let go
    const m = this.mission;
    for (const a of this.pkg) for (const st of a.stations) {
      if (!st.mu || !st.target?.site || st.target.idx == null || st.mu === 'harm') continue;
      const s = m.sites.find((x) => x.id === st.target.site), t = s?.targets[st.target.idx];
      if (!t) continue;
      const at = targetXY(s, t);
      const rp = releasePoint(r, at, MUNITIONS[st.mu]);
      if (!rp) continue;
      ctx.strokeStyle = 'rgba(255,216,74,0.55)'; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(v.sx(rp.x), v.sy(rp.y)); ctx.lineTo(v.sx(at.x), v.sy(at.y)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = COL.short; ctx.fillRect(v.sx(rp.x) - 2.5, v.sy(rp.y) - 2.5, 5, 5);
    }
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
    for (const j of s.jets) if (j.alive) this.jetIcon(ctx, v.sx(j.x), v.sy(j.y), s.pos.hdg || 0, COL.friend, 7);
    if (!s.done) v.label(`${Math.round(s.pos.alt)} m`, s.pos.x, s.pos.y, COL.friend, { dx: 14, dy: 10, font: '10px ui-monospace, Consolas, monospace' });
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
      : this.phase === 'brief' ? 'Shift+click adds the next route point · click a line to insert one · drag to move · right-click removes · wheel zooms'
      : this.phase === 'strike' ? 'Space runs / pauses · Shift+click adds the next route point · drag points ahead to re-route · wheel zooms · drag pans' : 'Wheel zooms · drag pans' }] };
  }

  onShow() { this.view?.resize(); }
  onHide() { if (this.sim && !this.sim.done && !this.paused) this.setPaused(true); } // off screen: the clock stops
  destroy() { this.stopLoop(); this.ro?.disconnect(); clearTimeout(this.saveT); }
}

export { THEATRE };
