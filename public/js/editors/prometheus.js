// Prometheus: a space program seen from above. The Prometheus A system is drawn top down (drag to pan, scroll to zoom,
// double-click a planet to follow it); every orbit is a circle on rails and every transfer a half-ellipse, so time warp
// runs as fast as you like. Vessels aren't built part by part: pick a lifter (it's thrown away once the payload is in
// orbit) and the modules that ride on top, and the delta-v comes from what reaches orbit. In orbit, queue maneuvers:
// change height, transfer to another body (it waits for the window, burns, coasts and captures), land in a biome or
// take off again. Science modules take readings on their own and send them home when there's a signal; the research
// points they earn unlock the tree. Progress is saved in settings.prometheus, so it goes with the setup export.

import { BaseEditor } from './base.js';
import { h, clear } from '../core/dom.js';
import { confirmDialog, contextMenu } from '../core/ui.js';
import { BODIES, BODY_ORDER, LY, LIFTERS, BOOSTER, PARTS, PART_CATS, REUSABLE_SHIELD, SCIENCE, SCI_GRANT, CREW_SCI, ROVER_DAYS, REFINE_RATIO, SMELT_RATIO, FAB_RATIO, COMP_PER_T, SCRAP_BACK, HOME_RANGE, TECH, TECH_BRANCHES, MILESTONE, LANDED_RETURN_RP, MILESTONE_X, START_MONEY, FLOOR_MONEY, INCOME, AU, DAY, YEAR } from './prometheus/data.js';
import { drawBody } from './prometheus/art.js';
import { reportFor } from './prometheus/reports.js';
import { drawHole, drawHoleMap } from './prometheus/hole.js';
import { mod, period, angleAt, helio, orbitPeriod, lowR, hostOf, hohmann, dipOf, reachable, transfer, FAST, windowAt, onTransfer, ascentDv, descentDv, stats, solarAt, madeAt, lightAt, dvOf, fuelFor, twr, shieldFor, lifter } from './prometheus/orbit.js';

const TAU = Math.PI * 2;
const WARPS = [0, 1, 10, 100, 1000, 1e4, 1e5, 1e6, 1e7, 2.5e7];
const WARP_LABEL = ['❚❚', '1×', '10×', '100×', '1K×', '10K×', '100K×', '1M×', '10M×', '25M×'];
const LANDING_S = 3600, ASCENT_S = 900;
/** The last bit of matching speeds and closing in, on top of the climb or drop to the other vessel's height (m/s). */
const DOCK_DV = 25;
/** How long a lander takes to reach a surface site in the same spot and dock with it (s). */
const SITE_DOCK_S = 3600;
const ORBIT_COL = '#5b6cff';
/** How far apart along an orbit (radians) an undocked vessel ends up from the next one: far enough to see on the map. */
const UNDOCK_GAP = 0.12;
/** A vessel's parts without its floats (left behind on take-off when asked). */
const noFloats = (parts) => parts.filter((p) => !PARTS[p.id].floats);
/** Where Hecate A* is, around Prometheus A (m). It never moves in a game's time: one orbit takes 330 million years. */
const holeAt = () => ({ x: -BODIES.star.galA * Math.cos(BODIES.star.galA0), y: -BODIES.star.galA * Math.sin(BODIES.star.galA0) });
/** The star a body is lit by: the first one up from it. */
const litBy = (id) => { let k = BODIES[id].parent; while (BODIES[k].parent && !BODIES[k].star) k = BODIES[k].parent; return k; };
/** Where a body is, seen from the star it's lit by (m). */
const starVec = (id, t) => { const p = helio(id, t), s = helio(litBy(id), t); return { x: p.x - s.x, y: p.y - s.y }; };
/** A temperature in °C, with a proper minus sign. */
const degC = (c) => `${c < 0 ? '−' : ''}${Math.abs(c)} °C`;
const biomeOf = (body, id) => BODIES[body].biomes.find((b) => b.id === id);
/** What a vessel carries that counts as dry mass: regolith, metal and components (t). */
const cargo = (v) => (v.ore || 0) + (v.metal || 0) + (v.comps || 0);
/** A vessel's modules that are switched on (solar panels, antennas and rovers can be turned off). */
const live = (v) => (v.off ? v.parts.filter((p) => !v.off[p.id]) : v.parts);

/** An SVG path through points, its corners rounded off by up to r. */
function roundPath(pts, r) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
    const k1 = Math.min(r, Math.hypot(x - px, y - py) / 2), k2 = Math.min(r, Math.hypot(nx - x, ny - y) / 2);
    const u = (ax, ay, k) => { const l = Math.hypot(ax, ay) || 1; return [(ax / l) * k, (ay / l) * k]; };
    const [ax, ay] = u(px - x, py - y, k1), [bx, by] = u(nx - x, ny - y, k2);
    d += ` L${x + ax},${y + ay} Q${x},${y} ${x + bx},${y + by}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return `${d} L${lx},${ly}`;
}

/** Finds each body's name in a log line, longest names first. */
const BODY_RX = BODY_ORDER.map((id) => [id, new RegExp(`(^|\\W)${BODIES[id].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'g')])
  .sort((a, b) => BODIES[b[0]].name.length - BODIES[a[0]].name.length);

const money = (m) => `$${m >= 1e6 ? `${(m / 1e6).toFixed(1)}T` : m >= 1000 ? `${(m / 1000).toFixed(1)}B` : `${m.toFixed(m < 10 ? 2 : 1)}M`}`;
const kms = (dv) => `${(dv / 1000).toFixed(2)} km/s`;
const kw = (x) => `${x < 10 ? x.toFixed(2) : Math.round(x)} kW`;
const km = (m) => `${Math.round(m / 1000).toLocaleString('en-US')} km`;
const tons = (t) => `${t.toFixed(t < 10 ? 2 : 1)} t`;
function span(s) {
  s = Math.max(0, s);
  if (s >= YEAR * 2) return `${(s / YEAR).toFixed(1)} years`;
  if (s >= DAY * 2) return `${Math.round(s / DAY).toLocaleString('en-US')} days`;
  if (s >= 3600 * 2) return `${Math.round(s / 3600)} hours`;
  return `${Math.max(1, Math.round(s / 60))} min`;
}
function date(t) {
  const y = Math.floor(t / YEAR) + 1, d = Math.floor(mod(t, YEAR) / DAY) + 1, hh = Math.floor(mod(t, DAY) / 3600), mm = Math.floor(mod(t, 3600) / 60);
  return `Y${y} · D${d} · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
const where = (at) => {
  const b = (id) => BODIES[id].name;
  if (at.s === 'orbit') return `${b(at.body)} orbit, ${km(at.r - BODIES[at.body].R)}`;
  if (at.s === 'landed') return `Landed on ${b(at.body)}, ${BODIES[at.body].biomes.find((x) => x.id === at.biome)?.name || ''}`;
  if (at.s === 'busy') return at.what === 'dipping' ? `Dipping into ${b(at.body)}'s air, orbit coming down to ${km(at.r2 - BODIES[at.body].R)}` : at.what === 'landing' ? `Coming down on ${b(at.body)}` : at.what === 'docking' ? (at.biome ? `Docking with a surface site on ${b(at.body)}` : `Closing in to dock, ${b(at.body)} orbit`) : `Climbing to ${b(at.body)} orbit`;
  if (at.s === 'transfer') return at.tr.from === at.tr.to ? `Changing height around ${b(at.tr.to)}` : `On the way to ${b(at.tr.to)}`;
  return '';
};

export class PrometheusEditor extends BaseEditor {
  static mode = 'prometheus';

  async load() {
    this.canvas = h('canvas', { class: 'pm-canvas', tabindex: '0' });
    this.panel = h('div', { class: 'ds-panel pm-panel' });
    this.top = h('div', { class: 'ds-top' });
    this.over = h('div', { class: 'pm-over', hidden: true });
    this.root = h('div', { class: 'ds-root pm-root', 'data-no-clip': '' }, this.top,
      h('div', { class: 'ds-body' }, (this.mapwrap = h('div', { class: 'ds-mapwrap' }, this.canvas,
        h('button', { class: 'ds-btn pm-cat-btn', title: 'Every body in the system: its science reports, survey, telescope view and log', onclick: () => this.openOver('catalogue') }, 'CATALOGUE'))), this.panel, this.over));
    this.pane.append(this.root);
    const s = this.app.settings.prometheus;
    this.st = s?.v === 1 ? structuredClone(s) : { v: 1, t: 0, money: START_MONEY, rp: 0, tech: ['basic'], vessels: [], done: {}, miles: {}, log: [], nextId: 1 };
    if (!this.st.power) { // once, when power came in: what's already flying (and the saved design) gets a panel
      this.st.power = true;
      for (const v of this.st.vessels) if (!stats(v.parts).solar) { v.parts.push({ id: 'solar1', n: 1 }); this.log(`${v.name} was fitted with a Mk1. Solar Panel.`); }
      if (this.st.draft && !stats(this.st.draft.parts).solar) this.st.draft.parts.push({ id: 'solar1', n: 1 });
    }
    if (!this.st.bigStar) {
      this.st.bigStar = true;
      for (const v of this.st.vessels) {
        if (v.at.s === 'transfer') { v.at = { s: 'orbit', body: v.at.tr.to, r: v.at.tr.r2, ph: Math.random() * TAU }; this.log(`${v.name} arrived early: the system was redrawn.`); }
        for (const q of v.queue) delete q.depart;
      }
    }
    // the lowest orbits went up (50 km everywhere): anything saved below them climbs to them
    for (const v of this.st.vessels) if (v.at.s === 'orbit' && v.at.r < lowR(v.at.body)) v.at.r = lowR(v.at.body);
    // vessels undocked onto the same spot of the same orbit: moved apart along it
    for (const v of this.st.vessels) {
      if (v.at.s !== 'orbit') continue;
      const twin = this.st.vessels.find((x) => x !== v && x.at.s === 'orbit' && x.at.body === v.at.body && Math.abs(x.at.r - v.at.r) < 1e3 && Math.abs(mod((x.at.ph || 0) - (v.at.ph || 0) + Math.PI, TAU) - Math.PI) < 0.01);
      if (twin) v.at.ph = this.freePhase(v.at.body, v.at.r, v.at.ph || 0, v);
    }
    // "full" notes used to repeat every frame: keep only the first of each run
    this.st.log = this.st.log.filter((e, i, a) => !/ (is full|are full again)\.$/.test(e.text) || !a.slice(0, i).some((x) => x.text === e.text));
    for (const e of [...this.st.log, ...Object.values(this.st.blog || {}).flat()]) e.text =e.text.replace('Mk2. Science (Surface)', 'Mk1. Science (Surface)'); // renamed
    if (!this.st.blog) { this.st.blog = {}; for (const e of this.st.log) this.bodyLog(e); } // once: each body's history from the log so far
    if (!this.st.log.length) this.log('Prometheus Space Program founded. Put something in orbit: NEW LAUNCH, top right.', 'good');
    this.warp = 1;
    this.sel = null; // { kind: 'body' | 'vessel', id }
    this.follow = null;
    this.view = { cx: 0, cy: 0, scale: 1 };
    this.wire();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.mapwrap);
    this.resize();
    this.fitSystem();
    this.renderTop();
    this.renderPanel();
    this.loop();
  }

  // ---------------------------------------------------------------- saving (settings.prometheus: goes with the setup export)

  save(now = false) {
    clearTimeout(this.saveT);
    const go = () => this.app.saveSettings({ prometheus: structuredClone(this.st) });
    if (now) go(); else this.saveT = setTimeout(go, 3000);
  }
  log(text, kind = 'info') {
    const e = { t: this.st.t, text, kind };
    this.st.log.push(e);
    if (this.st.log.length > 80) this.st.log.splice(0, this.st.log.length - 80);
    this.bodyLog(e);
    this.panelDirty = true;
  }
  /** Files a log entry under every body it names too, so each body keeps its own history for the catalogue. */
  bodyLog(e) {
    let text = e.text;
    for (const [id, rx] of BODY_RX) {
      if (text.search(rx) < 0) continue;
      text = text.replace(rx, '$1'); // "Pal & Gal" isn't also Pal's
      const list = ((this.st.blog ||= {})[id] ||= []);
      list.push(e);
      if (list.length > 60) list.splice(0, list.length - 60);
    }
  }
  has(tech) { return this.st.tech.includes(tech); }
  vessel(id) { return this.st.vessels.find((v) => v.id === id); }
  /** Is a vessel (other than `except`) already called this? */
  nameTaken(name, except) { const n = name.trim().toLowerCase(); return !!n && this.st.vessels.some((v) => v !== except && v.name.toLowerCase() === n); }
  /** The next free default name: Probe 3, Crew 4... */
  autoName(crew) { let n = this.st.nextId; while (this.nameTaken(`${crew ? 'Crew' : 'Probe'} ${n}`)) n++; return `${crew ? 'Crew' : 'Probe'} ${n}`; }

  // ---------------------------------------------------------------- the clock

  loop() {
    let last = performance.now(), scopeAt = 0, panelAt = 0;
    const tick = (now) => {
      this.raf = requestAnimationFrame(tick);
      const real = Math.min(0.25, (now - last) / 1000);
      last = now;
      if (WARPS[this.warp]) {
        this.st.t = Math.min(this.st.t + real * WARPS[this.warp], this.nextEvent());
        this.advance();
        this.dirtySave = true;
      }
      this.draw();
      if ((this.scope || this.catScope) && now - scopeAt > 160) {
        scopeAt = now;
        if (this.scope) this.drawScope(this.scope);
        if (this.catScope) this.drawScope(this.catScope);
      }
      if (now - panelAt > 1000) {
        panelAt = now;
        this.clockEl && (this.clockEl.textContent = date(this.st.t));
        if (this.dirtySave) { this.dirtySave = false; this.save(); }
        // a full redraw, unless something in the panel is being typed into
        if (!this.panel.contains(document.activeElement) || this.panelDirty) this.renderPanel();
        if (this.app.active === this.tab) this.app.updateStatus(this.tab);
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  setWarp(i) {
    this.warp = Math.max(0, Math.min(WARPS.length - 1, i));
    if (this.warp) this.lastWarp = this.warp;
    this.renderTop();
  }
  /** Something happened worth watching: back to 1×. */
  calm() { if (this.warp > 1) this.setWarp(1); }

  /** When the next arrival, landing, take-off, planned burn or rover drive is due, so a fast warp stops on it. */
  nextEvent() {
    let n = Infinity;
    for (const v of this.st.vessels) {
      const at = v.at;
      if (at.s === 'transfer') n = Math.min(n, at.tr.t0 + at.tr.tof);
      if (at.s === 'busy') n = Math.min(n, at.until);
      if (at.s === 'landed' && v.roverAt) n = Math.min(n, v.roverAt);
      if ((at.s === 'orbit' || at.s === 'landed') && v.queue[0]?.depart > this.st.t) n = Math.min(n, v.queue[0].depart);
    }
    return n;
  }

  /** Moves every vessel on: arrivals, landings, maneuvers starting, science transmitted. */
  advance() {
    const t = this.st.t;
    for (const v of [...this.st.vessels]) {
      for (let guard = 0; guard < 8; guard++) {
        if (!this.st.vessels.includes(v)) break; // recovered on Terra
        const at = v.at;
        if (at.s === 'transfer' && t >= at.tr.t0 + at.tr.tof) { this.arrive(v); continue; }
        if (at.s === 'busy' && t >= at.until) { this.settle(v); continue; }
        if ((at.s === 'orbit' || at.s === 'landed') && v.queue.length && this.startNext(v)) continue;
        break;
      }
      if (this.st.vessels.includes(v) && v.at.s === 'landed' && v.roverAt && t >= v.roverAt) this.rove(v);
      if (this.st.vessels.includes(v)) this.work(v);
    }
    this.sendHome();
    // the yearly funding, paid out as time goes by
    const paid = this.st.paidAt ?? t;
    this.st.paidAt = t;
    if (t > paid) this.st.money += (this.income() * (t - paid)) / YEAR;
    if (!this.st.vessels.length && this.st.money < FLOOR_MONEY) {
      this.st.money = FLOOR_MONEY;
      this.log(`Budget review: with nothing flying, the program's account is topped back up to ${money(FLOOR_MONEY)}.`, 'good');
    }
  }

  /** The queue's next maneuver, if it can start now. Returns true if it did (or failed and cleared the queue). */
  startNext(v) {
    const t = this.st.t, q = v.queue[0], at = v.at;
    const step = this.stepOf(v.at, v.parts, v.fuel, q);
    if (step.why) { this.log(`${v.name}: ${step.label} called off. ${step.why}`, 'bad'); v.queue = []; this.calm(); return true; }
    if (q.type === 'go') {
      q.depart ??= windowAt(step.tr, at.body, q.to, t, step.tr.tof);
      if (t < q.depart) return false; // waiting for the window
    }
    v.queue.shift();
    if (q.type === 'ascend' && q.dropFloats) v.parts = noFloats(v.parts);
    v.fuel = Math.max(0, v.fuel - fuelFor(stats(v.parts, cargo(v)), v.fuel, step.dv));
    if (q.type === 'height') {
      v.at = { s: 'transfer', tr: { from: at.body, to: at.body, frame: at.body, r2: q.r, rp: Math.min(at.r, q.r), ra: Math.max(at.r, q.r), outbound: q.r > at.r, th0: this.orbitAngle(at, t), t0: t, tof: step.tof } };
    } else if (q.type === 'go') {
      const tr = step.tr, t0 = q.depart;
      const th0 = tr.kind === 'out' ? angleAt(q.to, t0 + tr.tof) - tr.sweep : angleAt(at.body, t0);
      v.at = { s: 'transfer', tr: { ...tr, from: at.body, to: q.to, r1: at.r, r2: q.r, th0, t0 } };
      this.log(`${v.name} left ${BODIES[at.body].name} for ${BODIES[q.to].name}: ${kms(tr.dep)} now, ${kms(tr.arr)} to capture in ${span(tr.tof)}.`);
    } else if (q.type === 'dip') {
      v.at = { s: 'busy', what: 'dipping', body: at.body, r: at.r, r2: q.r, ph: this.orbitAngle(at, t), from: t, until: t + step.tof };
      this.log(`${v.name} dipped into ${BODIES[at.body].name}'s air: ${step.passes} passes over ${span(step.tof)} to bring its orbit down to ${km(q.r - BODIES[at.body].R)}.`);
    } else if (q.type === 'land') {
      if (step.shield && !step.shield.reusable) v.parts = this.dropShield(v.parts, step.shield);
      v.at = { s: 'busy', what: 'landing', body: step.next.body, biome: q.biome, until: t + LANDING_S };
      this.log(`${v.name} is coming down on ${BODIES[step.next.body].name}${step.shield ? ' behind its heat shield' : ' under power'}.`);
    } else if (q.type === 'dock') {
      v.at = at.s === 'landed' ? { s: 'busy', what: 'docking', body: at.body, biome: at.biome, target: q.target, from: t, until: t + step.tof }
        : { s: 'busy', what: 'docking', body: at.body, target: q.target, r: at.r, ph: this.orbitAngle(at, t), from: t, until: t + step.tof };
      this.log(`${v.name} is closing in on ${this.vessel(q.target).name} to dock.`);
    } else if (q.type === 'ascend') {
      v.at = { s: 'busy', what: 'ascent', body: at.body, biome: at.biome, until: t + ASCENT_S };
      v.roverAt = null;
      this.log(`${v.name} took off from ${BODIES[at.body].name}${q.dropFloats ? ', leaving its floats behind' : ''}.`);
    }
    this.panelDirty = true;
    return true;
  }

  /** One maneuver worked out from a state: { dv, tof, tr, shield, next (the state after), why (if it can't), label }. */
  stepOf(at, parts, fuel, q, ore = 0) {
    if (q.type === 'ascend' && q.dropFloats) parts = noFloats(parts);
    const st = stats(parts, ore), B = BODIES[at.body], out = { dv: 0, label: this.label(q, at) };
    const fail = (why) => ({ ...out, why });
    if (!st.isp && q.type !== 'land' && !(q.type === 'dock' && at.s === 'landed')) return fail('It has no engine.');
    if (q.type === 'height') {
      if (at.s !== 'orbit') return fail('It has to be in orbit.');
      Object.assign(out, hohmann(at.body, at.r, q.r));
      out.next = { s: 'orbit', body: at.body, r: q.r };
    } else if (q.type === 'go') {
      if (at.s !== 'orbit') return fail('It has to be in orbit.');
      const tr = transfer(at.body, at.r, q.to, q.r, q.fast);
      if (!tr) return fail(`${BODIES[q.to].name} can't be reached straight from ${B.name}.`);
      if (tr.tooClose) return fail(`A ${FAST[q.fast].name.toLowerCase()} transfer would pass too close to ${BODIES[tr.frame].name}.`);
      if (BODIES[q.to].hot && st.cool < st.dry + fuel - 1e-9) return fail(this.tooHot(q.to, st, fuel));
      Object.assign(out, { dv: tr.dv, tof: tr.tof, tr });
      out.next = { s: 'orbit', body: q.to, r: q.r };
    } else if (q.type === 'dip') {
      if (at.s !== 'orbit') return fail('It has to be in orbit.');
      if (!B.top) return fail(`${B.name} has no air to dip into.`);
      const d = dipOf(at.body, at.r, q.r);
      if (!d) return fail('A dip can only bring an orbit down.');
      Object.assign(out, { dv: d.dv, tof: d.tof, passes: d.passes });
      out.next = { s: 'orbit', body: at.body, r: q.r };
    } else if (q.type === 'land') {
      if (at.s !== 'orbit') return fail('It has to be in orbit.');
      const L = BODIES[q.body || at.body]; // one of a binary pair, landed on from the pair's orbit
      if (!L.biomes || hostOf(L.id) !== at.body) return fail(`It can't land on ${L.name} from here.`);
      if (L.hot && st.cool < st.dry + fuel - 1e-9) return fail(this.tooHot(L.id, st, fuel));
      const shield = L.atm > 0 ? shieldFor(st, fuel) : null;
      const chuted = L.atm > 0 && st.chute >= st.dry + fuel;
      const down = hohmann(at.body, at.r, lowR(at.body)).dv;
      out.dv = down + descentDv(L.id, q.biome, !!shield, chuted);
      out.shield = shield;
      out.chuted = chuted;
      // in thin air parachutes and heat shields need rockets to finish the landing
      const assist = (chuted || !!shield) && L.chuteAssist, powered = (!shield && !chuted) || assist;
      if (assist && !st.isp) return fail(`${L.name}'s air is too thin to land on parachutes or a heat shield alone: it needs an engine for the last of the way down.`);
      if (!shield && !chuted && !st.isp) return fail('It has no engine and no heat shield big enough.');
      if (powered && twr(st, fuel, L.g) < 1) return fail(assist ? `${L.name}'s air is too thin to land on parachutes or a heat shield alone, and there's too little thrust to finish the landing (T/W ${twr(st, fuel, L.g).toFixed(2)} at ${L.g} g).` : `Too little thrust to land under power (T/W ${twr(st, fuel, L.g).toFixed(2)} at ${L.g} g)${L.atm ? ', and no heat shield or parachutes cover it' : ''}.`);
      // Terra's recovery boats pick vessels up, so coming home needs neither
      const wet = biomeOf(L.id, q.biome)?.water, holds = wet ? st.floats : st.legs, what = wet ? 'floats' : 'landing legs';
      if (!L.home && holds < (st.dry + fuel) * L.g) return fail(holds ? `Its ${what} hold ${tons(holds / L.g)} here; it weighs ${tons(st.dry + fuel)}.` : `It has no ${what}${wet ? ': this is water' : ''}.`);
      out.next = { s: 'landed', body: L.id, biome: q.biome };
    } else if (q.type === 'dock' && at.s === 'landed') {
      const T = this.vessel(q.target);
      if (!T?.site || T.at.s !== 'landed' || T.at.body !== at.body || T.at.biome !== at.biome) return fail(`${T ? T.name : 'That site'} isn't a surface site here.`);
      out.tof = SITE_DOCK_S;
      out.next = { s: 'docked', body: at.body, biome: at.biome, target: T.id };
    } else if (q.type === 'dock') {
      if (at.s !== 'orbit') return fail('It has to be in orbit.');
      const T = this.vessel(q.target);
      if (!T || T.at.s !== 'orbit' || T.at.body !== at.body) return fail(`${T ? T.name : 'That vessel'} isn't in orbit around ${B.name}.`);
      // up or down to its height, then wait (half a turn, on average) to come round to it
      const hm = hohmann(at.body, at.r, T.at.r);
      Object.assign(out, { dv: hm.dv + DOCK_DV, tof: hm.tof + orbitPeriod(at.body, T.at.r) / 2 });
      out.next = { s: 'docked', body: at.body, target: T.id };
    } else if (q.type === 'ascend') {
      if (at.s !== 'landed') return fail('It has to be landed.');
      if (at.site) return fail('A surface site stays where it is.');
      if (twr(st, fuel, B.g) < 1) return fail(`Too little thrust to take off (T/W ${twr(st, fuel, B.g).toFixed(2)} at ${B.g} g).`);
      out.dv = ascentDv(at.body);
      out.next = { s: 'orbit', body: hostOf(at.body), r: lowR(hostOf(at.body)) };
    }
    if (out.dv > 0 && fuelFor(st, fuel, out.dv) > fuel + 1e-9) return fail(`It needs ${kms(out.dv)} and has ${kms(dvOf(st, fuel))}.`);
    return out;
  }

  /** Why a vessel can't go near a hot world: its radiators don't cover all of it. */
  tooHot(id, st, fuel) {
    return `${BODIES[id].name} is too hot to go near without radiators for the whole vessel: it weighs ${tons(st.dry + fuel)}${st.cool ? ` and its radiators cool ${tons(st.cool)}` : ' and it has none'}.`;
  }

  label(q, at) {
    if (q.type === 'height') return `Orbit height → ${km(q.r - BODIES[at.body]?.R || 0)}`;
    if (q.type === 'dip') return `Dip into the air → ${km(q.r - BODIES[at.body]?.R || 0)}`;
    if (q.type === 'dock') return `Dock with ${this.vessel(q.target)?.name || 'a vessel that\'s gone'}`;
    if (q.type === 'go') return `${q.fast ? `${FAST[q.fast].name} transfer` : 'Transfer'} to ${BODIES[q.to].name}, ${km(q.r - BODIES[q.to].R)}`;
    const L = BODIES[q.body || at.body];
    if (q.type === 'land') return L?.home ? `Return to ${L.name}` : `Land: ${q.body ? `${L.name}, ` : ''}${L?.biomes?.find((b) => b.id === q.biome)?.name || q.biome}`;
    return q.dropFloats ? 'Take off, leaving the floats' : 'Take off';
  }

  /** The whole queue worked out from where the vessel is: [{ q, step, fuel (after) }]; it stops at the first that can't. */
  plan(v, extra) {
    let at = v.at.s === 'transfer' ? { s: 'orbit', body: v.at.tr.to, r: v.at.tr.r2 } : v.at.s === 'busy' ? (v.at.what === 'dipping' ? { s: 'orbit', body: v.at.body, r: v.at.r2 } : v.at.what === 'landing' ? { s: 'landed', body: v.at.body, biome: v.at.biome } : v.at.what === 'docking' ? { s: 'docked', body: v.at.body, biome: v.at.biome, target: v.at.target } : { s: 'orbit', body: hostOf(v.at.body), r: lowR(hostOf(v.at.body)) }) : v.at;
    if (v.site) at = { ...at, site: true };
    let parts = v.parts, fuel = v.fuel;
    const out = [];
    for (const q of extra ? [...v.queue, extra] : v.queue) {
      const step = this.stepOf(at, parts, fuel, q, cargo(v));
      if (step.why) { out.push({ q, step, fuel }); break; }
      if (q.type === 'ascend' && q.dropFloats) parts = noFloats(parts);
      fuel -= fuelFor(stats(parts, cargo(v)), fuel, step.dv);
      if (step.shield && !step.shield.reusable) parts = this.dropShield(parts, step.shield);
      at = step.next;
      out.push({ q, step, fuel, at, parts });
    }
    return { steps: out, at, parts, fuel };
  }

  dropShield(parts, sh) {
    const i = parts.findIndex((p) => PARTS[p.id].covers === sh.covers && !!p.reusable === sh.reusable);
    if (i < 0) return parts;
    return parts.map((p, k) => (k === i ? { ...p, n: p.n - 1 } : p)).filter((p) => p.n > 0);
  }

  orbitAngle(at, t) { return at.ph + (TAU * t) / orbitPeriod(at.body, at.r); }
  /** A dipping vessel's orbit, eased from where it started down to where it ends up, and how far round it is. */
  dipR(at, t) { return at.r + (at.r2 - at.r) * Math.max(0, Math.min(1, (t - at.from) / (at.until - at.from))); }
  dipAngle(at, t) { const n = 24, dt = (Math.min(t, at.until) - at.from) / n; let a = at.ph; for (let i = 0; i < n; i++) a += (TAU * dt) / orbitPeriod(at.body, this.dipR(at, at.from + (i + 0.5) * dt)); return a; }

  arrive(v) {
    const tr = v.at.tr, t = this.st.t;
    // picks up its new orbit where the line on the map ends: on the side of the body it came in from
    const th = onTransfer(tr, tr.tof).th, end = tr.from === tr.to || tr.kind === 'in' ? th : tr.outbound ? th + Math.PI : th;
    v.at = { s: 'orbit', body: tr.to, r: tr.r2, ph: end - (TAU * t) / orbitPeriod(tr.to, tr.r2) };
    if (tr.from !== tr.to) {
      this.log(`${v.name} is in orbit around ${BODIES[tr.to].name}.`, 'good');
      this.calm();
    }
    this.reached(v);
  }

  settle(v) {
    const at = v.at, B = BODIES[at.body];
    if (at.what === 'docking') {
      const T = this.vessel(at.target);
      const there = at.biome ? T?.site && T.at.s === 'landed' && T.at.biome === at.biome : T?.at.s === 'orbit';
      if (there && T.at.body === at.body) { this.dock(v, T); this.calm(); return; }
      v.at = at.biome ? { s: 'landed', body: at.body, biome: at.biome } : { s: 'orbit', body: at.body, r: T?.at.r ?? at.r, ph: Math.random() * TAU };
      this.log(`${v.name} couldn't dock: ${T ? `${T.name} left ${at.biome ? 'there' : `${B.name} orbit`}` : 'the other vessel is gone'}.`, 'bad');
      this.calm();
      return;
    }
    if (at.what === 'dipping') {
      v.at = { s: 'orbit', body: at.body, r: at.r2, ph: this.dipAngle(at, at.until) - (TAU * at.until) / orbitPeriod(at.body, at.r2) };
      this.log(`${v.name} is out of ${B.name}'s air, in orbit at ${km(at.r2 - B.R)}.`, 'good');
      this.calm();
      return;
    }
    if (at.what === 'ascent') {
      const o = hostOf(at.body);
      v.at = { s: 'orbit', body: o, r: lowR(o), ph: Math.random() * TAU };
      this.log(`${v.name} is back in orbit around ${BODIES[o].name}.`, 'good');
      this.reached(v);
      return;
    }
    if (B.home) { this.recover(v); this.calm(); return; }
    v.at = { s: 'landed', body: at.body, biome: at.biome };
    this.log(`${v.name} landed on ${B.name}, ${B.biomes.find((b) => b.id === at.biome)?.name}.`, 'good');
    this.calm();
    this.reached(v);
  }

  /** In orbit or landed somewhere new: first-time rewards and the science modules' readings. */
  reached(v) {
    const at = v.at, b = at.body, st = stats(v.parts);
    if (at.s === 'orbit') {
      if (!v.visited.includes(b)) v.visited.push(b);
      this.milestone(`orbit:${b}`, MILESTONE.orbit, `First orbit of ${BODIES[b].name}`, b);
      if (st.sci.has('solar')) this.reading(v, `solar:${b}`, 'solar', b, `${SCIENCE.solar.name}, ${BODIES[b].name} orbit`);
      if (st.sci.has('atmos') && BODIES[b].atm) this.reading(v, `atmos:${b}:orbit`, 'atmos', b, `${SCIENCE.atmos.name}, ${BODIES[b].name} orbit`);
      if (st.crew) this.reading(v, `crew:${b}:orbit`, 'crew', b, `${SCIENCE.crew.name}, ${BODIES[b].name} orbit`);
    } else if (at.s === 'landed') {
      if (!v.landedOn.includes(b)) v.landedOn.push(b);
      if (this.milestone(`land:${b}`, MILESTONE.land, `First landing on ${BODIES[b].name}`, b)) this.log(`Funding up to ${money(this.income())} a year.`, 'good');
      const biome = BODIES[b].biomes.find((x) => x.id === at.biome)?.name;
      const dry = !biomeOf(b, at.biome)?.water;
      if (st.sci.has('water') && !dry) this.reading(v, `water:${b}:${at.biome}`, 'water', b, `${SCIENCE.water.name}, ${BODIES[b].name} ${biome}`);
      if ((st.sci.has('surface') || st.rover) && dry) this.reading(v, `surface:${b}:${at.biome}`, 'surface', b, `${SCIENCE.surface.name}, ${BODIES[b].name} ${biome}`);
      if (st.rover && !v.off?.rover && !v.roverAt && dry && this.roverNext(v)) v.roverAt = this.st.t + ROVER_DAYS * DAY;
      if (st.sci.has('atmos') && BODIES[b].atm) this.reading(v, `atmos:${b}:${at.biome}`, 'atmos', b, `${SCIENCE.atmos.name}, ${BODIES[b].name} ${biome}`);
      if (st.sci.has('temp')) this.reading(v, `temp:${b}:${at.biome}`, 'temp', b, `${SCIENCE.temp.name}, ${BODIES[b].name} ${biome}`);
      if (st.crew) this.reading(v, `crew:${b}:${at.biome}`, 'crew', b, `${SCIENCE.crew.name}, ${BODIES[b].name} ${biome}`);
    }
    this.panelDirty = true;
  }

  reading(v, key, kind, body, name) {
    if (!this.powerOf(v).ok) return;
    if (this.st.done[key] || this.st.vessels.some((x) => x.data.some((d) => d.key === key))) return;
    const crewed = stats(v.parts).crew > 0 && kind !== 'crew'; // a crew report is the crew's own: no extra on top
    v.data.push({ key, name: crewed ? `${name} (crewed)` : name, rp: Math.round(SCIENCE[kind].rp * BODIES[body].sci * (crewed ? CREW_SCI : 1)) });
  }

  /** The next land biome on the world a rover hasn't sampled yet, or null. */
  roverNext(v) {
    const b = v.at.body, has = (k) => this.st.done[k] || this.st.vessels.some((x) => x.data.some((d) => d.key === k));
    return BODIES[b].biomes.find((bm) => !bm.water && !has(`surface:${b}:${bm.id}`)) || null;
  }
  /** A landed vessel's rover reaches the next biome and analyses the ground there. */
  rove(v) {
    const b = v.at.body, bm = this.roverNext(v);
    v.roverAt = null;
    if (!bm) return;
    this.reading(v, `surface:${b}:${bm.id}`, 'surface', b, `${SCIENCE.surface.name}, ${BODIES[b].name} ${bm.name} (rover)`);
    if (stats(live(v)).sci.has('temp')) this.reading(v, `temp:${b}:${bm.id}`, 'temp', b, `${SCIENCE.temp.name}, ${BODIES[b].name} ${bm.name} (rover)`);
    this.log(`${v.name}'s rover reached ${bm.name} on ${BODIES[b].name} and analysed the ground.`, 'good');
    if (this.roverNext(v)) v.roverAt = this.st.t + ROVER_DAYS * DAY;
    else this.log(`${v.name}'s rover has sampled every land biome on ${BODIES[b].name}.`);
    this.panelDirty = true;
  }

  /** Funding coming in a year ($M): the base, plus some for every world landed on and every surface site. */
  income() {
    return INCOME.base + Object.keys(this.st.miles).filter((k) => k.startsWith('land:') && k !== 'land:terra').reduce((s, k) => s + INCOME.perLanding * (MILESTONE_X[k.slice(5)] || 1), 0)
      + this.st.vessels.reduce((s, v) => s + (v.site ? this.siteIncome(v) : 0), 0);
  }
  /** What a surface site (or a vessel made one) brings in a year ($M). */
  siteIncome(v) { return INCOME.perSite * (MILESTONE_X[v.at.body] || 1); }

  milestone(key, amount, text, body) {
    if (this.st.miles[key]) return false;
    const pay = amount * (MILESTONE_X[body] || 1);
    this.st.miles[key] = this.st.t;
    this.st.money += pay;
    this.log(`${text}: +${money(pay)} in funding.`, 'kill');
    return true;
  }

  /** Back down on Terra: the readings on board count, part of the vessel's price comes back, and where it went pays off. */
  recover(v) {
    const st = stats(v.parts), refund = st.cost * 0.25;
    let rp = 0;
    for (const d of v.data) if (!this.st.done[d.key]) { this.gotReport(d, v); rp += d.rp; }
    this.st.rp += rp;
    this.st.money += refund + rp * SCI_GRANT;
    this.st.vessels = this.st.vessels.filter((x) => x !== v);
    this.log(`${v.name} recovered on Terra: +${money(refund + rp * SCI_GRANT)}${rp ? `, +${rp} research` : ''}.`, 'good');
    for (const b of new Set([...v.visited, ...v.landedOn])) if (b !== 'terra') this.milestone(`return:${b}`, MILESTONE.return, `First return from ${BODIES[b].name}`, b);
    // back from a world's surface, the first time: more funding, and a little research from studying the vessel itself
    for (const b of v.landedOn) {
      if (b === 'terra' || this.st.miles[`landedReturn:${b}`]) continue;
      const pts = Math.round(LANDED_RETURN_RP * BODIES[b].sci);
      this.st.rp += pts;
      this.milestone(`landedReturn:${b}`, MILESTONE.landedReturn, `First vessel home from the surface of ${BODIES[b].name} (+${pts} research)`, b);
    }
    if (this.sel?.id === v.id) this.sel = null;
  }

  // ---------------------------------------------------------------- docking

  /** v docks with T: one vessel from now on (T's name, orbit and orders), with everything on board shared. v is kept in
   *  T's docked list so it can undock again. */
  dock(v, T) {
    T.docked = [...(T.docked || []), { id: v.id, name: v.name, parts: structuredClone(v.parts), fav: v.fav, launched: v.launched }, ...(v.docked || [])];
    for (const p of v.parts) {
      const same = T.parts.find((x) => x.id === p.id && !!x.reusable === !!p.reusable);
      if (same) same.n += p.n; else T.parts.push({ ...p });
    }
    T.fuel += v.fuel;
    T.ore = (T.ore || 0) + (v.ore || 0);
    T.metal = (T.metal || 0) + (v.metal || 0);
    T.comps = (T.comps || 0) + (v.comps || 0);
    T.smelting ||= v.smelting;
    T.fabbing ||= v.fabbing;
    T.data.push(...v.data);
    T.visited = [...new Set([...T.visited, ...v.visited])];
    T.landedOn = [...new Set([...T.landedOn, ...v.landedOn])];
    T.refining ||= v.refining;
    if (T.at.s === 'landed' && !T.roverAt && !T.off?.rover && stats(T.parts).rover && this.roverNext(T)) T.roverAt = this.st.t + ROVER_DAYS * DAY;
    this.st.vessels = this.st.vessels.filter((x) => x !== v);
    if (this.sel?.kind === 'vessel' && this.sel.id === v.id) this.sel = { kind: 'vessel', id: T.id };
    this.log(`${v.name} docked with ${T.name}.`, 'good');
    this.panelDirty = true;
  }

  /** What a docked vessel can take when it leaves: { parts (what's still there of its own), min, max (fuel, t) }. */
  undockable(T, m) {
    const left = T.parts.map((p) => ({ ...p })), mine = [];
    for (const p of m.parts) {
      const x = left.find((y) => y.id === p.id && !!y.reusable === !!p.reusable && y.n > 0);
      if (!x) continue;
      const n = Math.min(p.n, x.n);
      x.n -= n;
      mine.push({ ...p, n });
    }
    const stay = left.filter((p) => p.n > 0), capGo = stats(mine).cap, capStay = stats(stay).cap;
    return { parts: mine, stay, min: Math.max(0, T.fuel - capStay), max: Math.min(T.fuel, capGo) };
  }

  /** A docked vessel leaves with `fuel` tonnes: back on its own, in the same orbit. */
  /** A spot a little way ahead of ph along an orbit, clear of every other vessel on it (but `skip`), so none sit on top of each other. */
  freePhase(body, r, ph, skip) {
    const near = this.st.vessels.filter((x) => x !== skip && x.at.s === 'orbit' && x.at.body === body && Math.abs(x.at.r - r) < 1e3);
    const gap = (a, b) => Math.abs(mod(a - b + Math.PI, TAU) - Math.PI);
    let k = 1;
    while (k < 50 && near.some((x) => gap(x.at.ph || 0, ph + UNDOCK_GAP * k) < UNDOCK_GAP / 2)) k++;
    return ph + UNDOCK_GAP * k;
  }

  undock(T, m, fuel) {
    const u = this.undockable(T, m), oreStay = Math.min(T.ore || 0, stats(u.stay).oreCap);
    // storage holds metal and components together: what stays fills the storage that stays, components first
    const storeStay = stats(u.stay).store, storeGo = stats(u.parts).store;
    const compsStay = Math.min(T.comps || 0, storeStay), metalStay = Math.min(T.metal || 0, storeStay - compsStay);
    const compsGo = Math.min((T.comps || 0) - compsStay, storeGo), metalGo = Math.min((T.metal || 0) - metalStay, storeGo - compsGo);
    const v = { id: m.id, name: m.name, parts: u.parts, fuel, ore: Math.min((T.ore || 0) - oreStay, stats(u.parts).oreCap), metal: metalGo, comps: compsGo, queue: [], data: [],
      visited: [...T.visited], landedOn: [...T.landedOn], launched: m.launched, fav: m.fav, at: { ...T.at } };
    if (T.at.s === 'orbit') v.at.ph = this.freePhase(T.at.body, T.at.r, T.at.ph || 0, T);
    T.parts = u.stay;
    T.fuel -= fuel;
    T.ore = oreStay;
    T.metal = metalStay;
    T.comps = compsStay;
    T.docked = T.docked.filter((x) => x !== m);
    if (!stats(T.parts).refine) T.refining = false;
    if (!stats(T.parts).smelt) T.smelting = false;
    if (!stats(T.parts).fab) T.fabbing = false;
    this.st.vessels.push(v);
    this.log(`${m.name} undocked from ${T.name} with ${tons(fuel)} of fuel.`, 'good');
    this.save(); this.renderPanel();
  }

  /** The docked list in the vessel panel: undock one (picking how much fuel it takes), or make the whole stack one vessel for good. */
  dockSec(v) {
    if (!v.docked?.length) return null;
    const canGo = (v.at.s === 'orbit' || v.at.s === 'landed') && !v.queue.length;
    const typed = (this.typed ||= new Map());
    const rows = v.docked.map((m) => {
      const u = this.undockable(v, m), share = stats(u.parts).cap / Math.max(1e-9, stats(v.parts).cap), key = `${v.id}:undock:${m.id}`;
      const sGo = stats(u.parts), sStay = stats(u.stay), clamp = (f) => Math.min(u.max, Math.max(u.min, f));
      const dvGo = (f) => dvOf(sGo, f), dvStay = (f) => dvOf(sStay, v.fuel - f);
      // the split where both come away with the same delta-v (the one leaving gains as it takes more, the one staying loses)
      const even = () => { let lo = u.min, hi = u.max; for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (dvGo(mid) < dvStay(mid)) lo = mid; else hi = mid; } return (lo + hi) / 2; };
      const start = clamp(Number(typed.get(key) ?? v.fuel * share));
      const fIn = h('input', { class: 'ds-sel pm-num', type: 'number', step: '0.01', min: u.min.toFixed(2), max: u.max.toFixed(2), value: start.toFixed(2) });
      const slide = h('input', { class: 'pm-slide grow', type: 'range', min: u.min, max: u.max, step: Math.max(0.001, (u.max - u.min) / 400), value: start, disabled: u.max - u.min < 1e-6 });
      fIn.dataset.keep = `${key}:n`; slide.dataset.keep = `${key}:s`;
      const out = h('div', { class: 'sm faint' });
      const show = (f, from) => {
        typed.set(key, f);
        if (from !== fIn) fIn.value = f.toFixed(2);
        if (from !== slide) slide.value = f;
        fIn.classList.toggle('bad', !(f >= u.min - 1e-6 && f <= u.max + 1e-6));
        clear(out).append(`${m.name} leaves with ${tons(clamp(f))} · ${kms(dvGo(clamp(f)))}. ${v.name} keeps ${tons(v.fuel - clamp(f))} · ${kms(dvStay(clamp(f)))}.`);
      };
      fIn.addEventListener('input', () => show(Number(fIn.value), fIn));
      fIn.addEventListener('change', () => show(clamp(Number(fIn.value)), null));
      slide.addEventListener('input', () => show(Number(slide.value), slide));
      const pick = (label, title, f) => h('button', { class: 'ds-btn sm', title, disabled: u.max - u.min < 1e-6, onclick: () => show(clamp(f()), null) }, label);
      const go = h('button', { class: 'ds-btn sm', disabled: !canGo, onclick: () => {
        const f = Number(fIn.value);
        if (!(f >= u.min - 1e-6 && f <= u.max + 1e-6)) { fIn.classList.add('bad'); return; }
        typed.delete(key);
        this.undock(v, m, clamp(f));
      } }, 'UNDOCK');
      show(start, null);
      return h('div', { class: 'pm-add' }, h('div', { class: 'ds-kv' }, h('b', {}, m.name), h('span', { class: 'faint sm' }, u.parts.map((p) => `${PARTS[p.id].name} ×${p.n}`).join(', '))),
        h('div', { class: 'ds-row' }, h('span', { class: 'faint sm' }, 'Takes'), fIn, h('span', { class: 'faint sm' }, 't of fuel'), slide),
        h('div', { class: 'ds-row' },
          pick('LEAST', `Only what ${v.name}'s own tanks can't hold: ${tons(u.min)}`, () => u.min),
          pick('EVEN', 'Split so both have the same delta-v', even),
          pick('MOST', `Fill ${m.name}'s tanks, or take all there is: ${tons(u.max)}`, () => u.max),
          h('div', { class: 'grow' }), go),
        out);
    });
    return this.sec(`DOCKED (${v.docked.length})`, ...rows,
      canGo ? null : h('div', { class: 'faint sm' }, 'Undocking needs it in orbit or on the ground, with nothing planned.'),
      h('div', { class: 'ds-row' }, h('div', { class: 'grow' }), h('button', { class: 'ds-btn sm', onclick: async () => {
        if (!(await confirmDialog('Combine for good?', `${v.name} stays one vessel: the docked vessels can't undock any more.`, { okLabel: 'Combine' }))) return;
        this.log(`${[v.name, ...v.docked.map((m) => m.name)].join(', ')} combined into one vessel, ${v.name}.`, 'good');
        v.docked = []; this.save(); this.renderPanel();
      } }, 'COMBINE FOR GOOD')),
      h('div', { class: 'faint sm' }, 'Docked vessels share fuel, power and everything on board, and fly as one.'));
  }

  // ---------------------------------------------------------------- power and mining

  /** A vessel's power: what its panels make where it is, what it needs, and whether the drill, refinery, smelter and
   *  fabricator can run. The vessel's own systems come first, then those in that order. */
  powerOf(v, st = stats(v.parts, cargo(v))) {
    const p = this.vesselHelio(v), on = v.off ? stats(live(v)) : st, solar = solarAt(on, lightAt(p, this.st.t)), rtg = on.rtg, load = on.load;
    // the fuel cell: on automatic it stands by, ready to cover what the panels can't
    const cell = { has: st.cell > 0, mode: v.cellMode || 'auto' };
    cell.up = cell.has && cell.mode !== 'off' && v.fuel > 1e-9;
    const avail = solar + rtg + (cell.up ? st.cell : 0);
    const ok = avail + 1e-9 >= load, at = v.at, B = BODIES[at.body];
    const ground = at.s === 'landed' && !B?.home && !biomeOf(at.body, at.biome)?.water;
    const drill = { has: st.drill > 0, why: '' }, refine = { has: st.refine > 0, why: '' }, smelt = { has: st.smelt > 0, why: '' }, fab = { has: st.fab > 0, why: '' };
    let spare = avail - load;
    if (drill.has) {
      drill.why = !ok ? 'no power' : !ground ? (at.s === 'landed' ? 'nothing to dig here' : 'not landed') : !st.oreCap ? 'no regolith tank' : (v.ore || 0) >= st.oreCap - 1e-9 ? 'regolith tank full' : spare + 1e-9 < st.drillKW ? `needs ${kw(st.drillKW)}, ${kw(Math.max(0, spare))} spare` : '';
      drill.on = !drill.why;
      if (drill.on) spare -= st.drillKW;
    }
    if (refine.has) {
      refine.why = !v.refining ? 'stopped' : !ok ? 'no power' : !(v.ore > 1e-9) && !drill.on ? 'no regolith' : v.fuel >= st.cap - 1e-9 ? 'fuel tanks full' : spare + 1e-9 < st.refineKW ? `needs ${kw(st.refineKW)}, ${kw(Math.max(0, spare))} spare` : '';
      refine.on = !refine.why;
      if (refine.on) spare -= st.refineKW;
    }
    if (smelt.has) {
      smelt.why = !v.smelting ? 'stopped' : !ok ? 'no power' : !st.store ? 'no storage unit' : (v.metal || 0) + (v.comps || 0) >= st.store - 1e-9 ? 'storage full'
        : !(v.ore > 1e-9) && !drill.on ? 'no regolith' : spare + 1e-9 < st.smeltKW ? `needs ${kw(st.smeltKW)}, ${kw(Math.max(0, spare))} spare` : '';
      smelt.on = !smelt.why;
      if (smelt.on) spare -= st.smeltKW;
    }
    if (fab.has) {
      fab.why = !v.fabbing ? 'stopped' : !ok ? 'no power' : !st.store ? 'no storage unit' : !(v.metal > 1e-9) && !smelt.on ? 'no metal'
        : spare + 1e-9 < st.fabKW ? `needs ${kw(st.fabKW)}, ${kw(Math.max(0, spare))} spare` : '';
      fab.on = !fab.why;
      if (fab.on) spare -= st.fabKW;
    }
    const used = avail - spare;
    cell.used = !cell.up ? 0 : cell.mode === 'on' ? st.cell : Math.max(0, Math.min(st.cell, used - solar - rtg));
    return { made: solar + rtg + cell.used, solar, rtg, used, need: load, ok, drill, refine, smelt, fab, cell, st };
  }

  /** Logs a tank or store filling up once, and not again until it's dropped back under 90%: a drill and a refinery (or a
   *  smelter and a fabricator) running together keep topping it back up every frame. */
  noteFull(v, key, share, text, kind) {
    v.full ||= {};
    if (share >= 1 - 1e-9) { if (!v.full[key]) { v.full[key] = true; this.log(text, kind); } }
    else if (share < 0.9) delete v.full[key];
  }
  /** Digging, refining, smelting and fabricating since the last frame, and the fuel the fuel cell burns. */
  work(v) {
    const t = this.st.t, dt = t - (v.workAt ?? t);
    v.workAt = t;
    if (dt <= 0 || v.at.s === 'busy') return;
    const pw = this.powerOf(v), st = pw.st;
    if (!pw.drill.on && !pw.refine.on && !pw.smelt.on && !pw.fab.on && !pw.cell.used) return;
    const days = dt / DAY;
    if (pw.cell.used) {
      v.fuel = Math.max(0, v.fuel - (pw.cell.used / st.cell) * st.cellBurn * days);
      if (v.fuel <= 1e-9) this.log(`${v.name}'s fuel cell is out of fuel.`, 'bad');
    }
    if (pw.drill.on) {
      v.ore = Math.min(st.oreCap, (v.ore || 0) + st.drill * BODIES[v.at.body].minerals * days);
      this.noteFull(v, 'ore', v.ore / st.oreCap, `${v.name}'s regolith tank is full.`);
    }
    if (pw.refine.on) {
      const made = Math.min(st.refine * days, (v.ore || 0) / REFINE_RATIO, st.cap - v.fuel);
      v.fuel += made;
      v.ore = Math.max(0, v.ore - made * REFINE_RATIO);
      this.noteFull(v, 'fuel', v.fuel / st.cap, `${v.name}'s fuel tanks are full again.`, 'good');
    }
    if (pw.smelt.on) {
      const made = Math.min(st.smelt * days, (v.ore || 0) / SMELT_RATIO, st.store - (v.metal || 0) - (v.comps || 0));
      v.metal = (v.metal || 0) + made;
      v.ore = Math.max(0, v.ore - made * SMELT_RATIO);
      this.noteFull(v, 'store', (v.metal + (v.comps || 0)) / st.store, `${v.name}'s storage is full.`);
    }
    if (pw.fab.on) {
      const made = Math.min(st.fab * days, (v.metal || 0) / FAB_RATIO);
      v.comps = (v.comps || 0) + made;
      v.metal = Math.max(0, v.metal - made * FAB_RATIO);
    }
  }

  // ---------------------------------------------------------------- comms

  /** Where a vessel is around the star (m). */
  vesselHelio(v, t = this.st.t) {
    const at = v.at;
    if (at.s !== 'transfer') return helio(at.body, t);
    const p = onTransfer(at.tr, t - at.tr.t0), f = helio(at.tr.frame, t);
    return at.tr.frame === 'star' ? { x: Math.cos(p.th) * p.r, y: Math.sin(p.th) * p.r } : f;
  }

  /** The vessels that can reach Terra's ground station, straight or through dish relays. */
  links() {
    const t = this.st.t, home = { pos: helio('terra', t), range: HOME_RANGE, relay: true };
    const nodes = this.st.vessels.map((v) => { const st = stats(live(v)); return { v, pos: this.vesselHelio(v, t), range: st.comms, relay: st.relay }; }).filter((n) => n.range > 0);
    const reached = new Set(), open = [home];
    while (open.length) {
      const a = open.pop();
      for (const n of nodes) {
        if (reached.has(n.v)) continue;
        const d = Math.hypot(a.pos.x - n.pos.x, a.pos.y - n.pos.y) / AU;
        if (d <= Math.sqrt(a.range * n.range)) { reached.add(n.v); if (n.relay) open.push(n); }
      }
    }
    return reached;
  }

  /** A reading has reached home: it counts, and its report goes in the catalogue with when it came in and from whom. */
  gotReport(d, v) {
    this.st.done[d.key] = true;
    (this.st.sciAt ||= {})[d.key] = { t: this.st.t, by: v.name, crew: d.name.endsWith('(crewed)') };
  }

  sendHome() {
    if (!this.st.vessels.some((v) => v.data.length)) return;
    const linked = this.links();
    for (const v of this.st.vessels) {
      if (!v.data.length || !linked.has(v) || !this.powerOf(v).ok) continue;
      for (const d of v.data) {
        if (this.st.done[d.key]) continue;
        this.gotReport(d, v);
        this.st.rp += d.rp;
        this.st.money += d.rp * SCI_GRANT;
        this.log(`${v.name} transmitted ${d.name}: +${d.rp} research, +${money(d.rp * SCI_GRANT)}.`, 'good');
      }
      v.data = [];
    }
  }

  /** Can it take new orders? Crew always; a probe only with a signal. */
  control(v, linked = this.links()) {
    const st = stats(v.parts);
    if (st.crew) return { ok: true, why: 'Crewed' };
    if (!st.probe) return { ok: false, why: 'No probe core or crew: it can\'t be steered' };
    if (!this.powerOf(v).ok) return { ok: false, why: 'No power' };
    return linked.has(v) ? { ok: true, why: 'Signal' } : { ok: false, why: 'No signal' };
  }

  // ---------------------------------------------------------------- launching

  draft() {
    this.st.draft ||= { name: '', cls: 'light', boosters: 0, reusable: false, parts: [{ id: 'mk1eng', n: 1 }, { id: 'tank5000', n: 1 }, { id: 'core', n: 1 }, { id: 'solar1', n: 1 }, { id: 'phased', n: 1 }, { id: 'sciSolar', n: 1 }] };
    const d = this.st.draft;
    if (!LIFTERS[d.cls] || !this.has(LIFTERS[d.cls].tech) || LIFTERS[d.cls].noAir) d.cls = 'light';
    if (!this.has('boosters')) d.boosters = 0;
    if (!this.has('reuse')) d.reusable = false;
    d.fill ??= 100;
    d.parts = d.parts.filter((p) => this.has(PARTS[p.id].tech) && (!p.reusable || this.has('reuse')));
    return d;
  }

  launchCheck(d) {
    const st = stats(d.parts), L = lifter(d.cls, d.boosters, d.reusable), fuel = (st.cap * d.fill) / 100, mass = st.dry + fuel, cost = L.cost + st.cost, issues = [];
    if (!d.parts.length) issues.push('Add some modules.');
    if (d.parts.length && !st.probe && !st.crew) issues.push('It needs a probe core or a crew HAB to be steered.');
    if (L.air) issues.push(`The ${L.name} only flies off worlds with no air.`);
    if (mass > L.payload + 1e-9) issues.push(`${tons(mass)} is more than the ${L.name} lifter puts in orbit (${tons(L.payload)}).`);
    if (d.parts.length && madeAt(st, 1) < st.load - 1e-9) issues.push(`It needs ${kw(st.load)} and its solar panels${st.rtg ? ' and RTGs' : ''} make ${kw(madeAt(st, 1))} at Terra: add more.`);
    if (this.nameTaken(d.name)) issues.push(`There's already a vessel called ${d.name.trim()}.`);
    if (cost > this.st.money + 1e-9) issues.push(`It costs ${money(cost)}; the program has ${money(this.st.money)}.`);
    return { st, L, fuel, mass, cost, issues };
  }

  launch() {
    const d = this.draft(), c = this.launchCheck(d);
    if (c.issues.length) return;
    const n = this.st.nextId++;
    const v = { id: `v${n}`, name: d.name.trim() || this.autoName(c.st.crew), parts: structuredClone(d.parts), fuel: c.fuel, queue: [], data: [], visited: [], landedOn: [], launched: this.st.t,
      at: { s: 'orbit', body: 'terra', r: lowR('terra'), ph: Math.random() * TAU } };
    this.st.money -= c.cost;
    this.st.vessels.push(v);
    this.log(`${v.name} launched: ${tons(c.mass)} in Terra orbit for ${money(c.cost)}${d.reusable ? ' (the lifter came back)' : ''}.`, 'good');
    this.reached(v);
    d.name = '';
    this.closeOver();
    this.sel = { kind: 'vessel', id: v.id };
    this.focusOn('terra');
    this.save(true);
  }

  // ---------------------------------------------------------------- the top strip

  renderTop() {
    this.clockEl = h('span', { class: 'ds-clock pm-clock' }, date(this.st.t));
    const warps = h('div', { class: 'ds-seg' }, WARPS.map((_, i) => h('button', { class: `ds-btn sm${this.warp === i ? ' on' : ''}`, title: i ? `Time ×${WARPS[i].toLocaleString('en-US')} (. faster, , slower)` : 'Pause (Space)', onclick: () => this.setWarp(i) }, WARP_LABEL[i])));
    clear(this.top).append(h('span', { class: 'ds-title pm-title' }, 'PROMETHEUS'),
      h('span', { class: 'pm-money' }, money(this.st.money)), h('span', { class: 'pm-rp' }, `${this.st.rp} RP`),
      h('div', { class: 'grow' }), warps, this.clockEl,
      h('button', { class: `ds-btn${this.overKind === 'research' ? ' on' : ''}`, onclick: () => this.openOver('research') }, 'RESEARCH'),
      h('button', { class: `ds-btn primary${this.overKind === 'launch' ? ' on' : ''}`, onclick: () => this.openOver('launch') }, 'NEW LAUNCH'));
  }

  // ---------------------------------------------------------------- the side panel

  renderPanel() {
    this.panelDirty = false;
    this.lastScope = this.scope;
    this.scope = null;
    if (this.sel?.kind === 'vessel' && !this.vessel(this.sel.id)) this.sel = null;
    const top = this.panel.scrollTop, keep = this.panel.contains(document.activeElement) ? document.activeElement.dataset.keep : null;
    clear(this.panel);
    if (this.sel?.kind === 'body') this.bodyPanel(this.sel.id);
    else if (this.sel?.kind === 'vessel') this.vesselPanel(this.vessel(this.sel.id));
    else this.overview();
    this.panel.scrollTop = top;
    // a box being typed into keeps the keyboard across the redraw
    if (keep) this.panel.querySelector(`[data-keep="${keep}"]`)?.focus({ preventScroll: true });
    this.renderTopNumbers();
  }
  renderTopNumbers() {
    const m = this.top.querySelector('.pm-money'), r = this.top.querySelector('.pm-rp');
    if (m) m.textContent = money(this.st.money);
    if (r) r.textContent = `${this.st.rp} RP`;
  }

  sec(title, ...kids) { return h('div', { class: 'ds-sec' }, title ? h('div', { class: 'ds-h' }, title) : null, ...kids); }
  kv(k, v, cls) { return h('div', { class: 'ds-kv' }, h('span', {}, k), h('b', { class: cls || null }, v)); }
  back() { return h('button', { class: 'ds-btn sm', onclick: () => { this.sel = null; this.renderPanel(); } }, '← PROGRAM'); }

  overview() {
    const linked = this.links();
    const vrow = (v) => h('div', { class: 'ds-srow', onclick: () => this.select({ kind: 'vessel', id: v.id }, true) },
      h('span', { class: `pm-vdot${v.site ? ' site' : ''}${v.fav ? ' fav' : ''}` }), h('span', { class: 'grow' }, v.name), h('span', { class: 'faint sm' }, where(v.at)),
      h('span', { class: `sm ${linked.has(v) ? 'good' : 'faint'}`, title: linked.has(v) ? 'In contact with Terra' : 'No signal' }, linked.has(v) ? '◉' : '○'));
    const vs = this.st.vessels.filter((v) => !v.site).map(vrow), sites = this.st.vessels.filter((v) => v.site).map(vrow);
    // planets, with their moons folded under them (click the arrow to open)
    this.openBodies ||= new Set();
    const kids = (id) => (id === 'star' ? [] : BODY_ORDER.filter((k) => BODIES[k].parent === id));
    const row = (id, depth) => {
      const ks = kids(id), open = this.openBodies.has(id);
      const what = BODIES[id].star ? 'planet' : 'moon';
      const twist = ks.length ? h('button', { class: 'pm-twist', title: open ? `Hide ${what}s` : `Show ${what}s`, onclick: (e) => { e.stopPropagation(); if (open) this.openBodies.delete(id); else this.openBodies.add(id); this.renderPanel(); } }, open ? '▾' : '▸') : h('span', { class: 'pm-twist' });
      return [h('div', { class: 'ds-srow', style: { paddingLeft: `${depth * 16}px` }, onclick: () => this.select({ kind: 'body', id }, true) },
        twist, h('span', { class: 'ds-dot', style: { background: BODIES[id].col } }), h('span', { class: 'grow' }, BODIES[id].name),
        h('span', { class: 'faint sm' }, ks.length && !open ? `${BODIES[id].kind} · ${ks.length} ${what}${ks.length === 1 ? '' : 's'}` : BODIES[id].kind)),
      ...(open ? ks.flatMap((k) => row(k, depth + 1)) : [])];
    };
    const bodies = BODY_ORDER.filter((id) => !BODIES[id].parent || BODIES[id].parent === 'star').flatMap((id) => row(id, 0));
    const open = TECH.filter((x) => !this.has(x.id) && x.needs.every((n) => this.has(n)) && x.rp <= this.st.rp).length;
    this.panel.append(
      this.sec('PROGRAM', this.kv('Funds', money(this.st.money)), this.kv('Income', `${money(this.income())} a year`), this.kv('Research', `${this.st.rp} RP${open ? ` · ${open} to unlock` : ''}`), this.kv('Date', date(this.st.t)),
        h('div', { class: 'faint sm' }, 'Drag the map to look around, scroll to zoom, double-click a planet to follow it. Space pauses; , and . change the time warp.')),
      this.sec(`VESSELS (${vs.length})`, vs.length ? vs : h('div', { class: 'faint' }, 'Nothing flying. NEW LAUNCH puts something in Terra orbit.')),
      sites.length ? this.sec(`SURFACE SITES (${sites.length})`, sites) : null,
      this.sec('THE SYSTEM', bodies),
      this.logSec());
  }

  logSec(n = 14) {
    return this.sec('LOG', ...this.st.log.slice(-n).reverse().map((e) => h('div', { class: `ds-log ${e.kind}` }, h('span', { class: 'faint' }, date(e.t).replace(/ · \d\d:\d\d$/, '')), ' ', e.text)));
  }

  bodyPanel(id) {
    const B = BODIES[id];
    // the same telescope canvas across the panel's once-a-second redraws, so it never shows blank in between
    const scope = this.lastScope?.id === id ? this.lastScope.canvas : h('canvas', { class: 'pm-scope', width: 300, height: 180 });
    this.scope = { canvas: scope, id };
    this.panel.append(this.sec(null, h('div', { class: 'ds-row' }, this.back(), h('div', { class: 'grow' }), h('button', { class: 'ds-btn sm', onclick: () => this.focusOn(id) }, 'FOLLOW'))),
      this.sec(`${B.name.toUpperCase()} · ${B.kind.toUpperCase()}`, scope, B.about ? h('div', { class: 'ds-note' }, B.about) : null),
      ...this.bodyInfo(id));
  }

  /** A body's survey: what it's like, how to get there and land, what's been learned there, and who's there now. */
  bodyInfo(id) {
    const B = BODIES[id], t = this.st.t, out = [];
    const dist = B.parent === 'star' ? `${(B.a / AU).toFixed(2)} AU` : BODIES[B.parent]?.star ? `${(B.a / AU).toFixed(2)} AU from ${BODIES[B.parent].name}` : B.parent ? `${km(B.a)} from ${BODIES[B.parent].name}` : '—';
    const fromStar = B.parent ? `${(Math.hypot(helio(id, t).x, helio(id, t).y) / AU).toFixed(2)} AU` : '—';
    if (B.binary) {
      const kids = BODY_ORDER.filter((k) => BODIES[k].host === id);
      out.push(this.sec('SURVEY',
        this.kv('Orbit', dist), this.kv('Distance from Prometheus A', fromStar), this.kv('Year', span(period(id))),
        this.kv('The pair', kids.map((k) => BODIES[k].name).join(' and ')), this.kv('Going round each other', `every ${span(period(kids[0]))}`),
        this.kv('Reaching out to', `${km(B.R)} from the centre`),
        this.kv('Lowest orbit', `${km(B.low)} above that`), this.kv('Orbits up to', km(B.max)),
        h('div', { class: 'faint sm' }, 'Heights here are measured from the edge of where the two moons swing, so no orbit can hit either.')));
      out.push(this.sec('LAND ON', kids.map((k) => h('div', { class: 'ds-srow', onclick: () => this.select({ kind: 'body', id: k }) }, h('span', { class: 'ds-dot', style: { background: BODIES[k].col } }), h('span', { class: 'grow' }, BODIES[k].name), h('span', { class: 'faint sm' }, `${BODIES[k].g} g`)))));
      const tr = this.routeFromTerra(id);
      if (tr) out.push(this.sec('FROM TERRA ORBIT', this.kv('Delta-v', `${kms(tr.dv)}`), this.kv('Trip', span(tr.tof)), tr.via ? h('div', { class: 'faint sm' }, tr.via) : null));
      const sci = Object.keys(this.st.done).filter((k) => k.split(':')[1] === id);
      out.push(this.sec('SCIENCE', sci.length ? sci.map((k) => h('div', { class: 'faint sm' }, this.sciName(k))) : h('div', { class: 'faint' }, 'Nothing transmitted from here yet.')));
    } else if (B.hole) {
      out.push(this.sec('BLACK HOLE', this.kv('Mass', `${(B.gm / 1.327e26).toFixed(0)} million Suns`), this.kv('Event horizon', `${km(B.R)} from the centre`),
        this.kv('Distance from Prometheus A', `${(BODIES.star.galA / LY).toLocaleString('en-US')} light years`), this.kv('Prometheus A goes round it', `every ${Math.round(BODIES.star.galT / 3.156e13)} million years`),
        h('div', { class: 'faint sm' }, 'Far too far to reach. Zoom right out on the map to see it.')));
    } else if (!B.parent) {
      out.push(this.sec('STAR', this.kv('Orbits', `${BODIES.hecate.name}, ${(B.galA / LY).toLocaleString('en-US')} light years away, every ${Math.round(B.galT / 3.156e13)} million years`), this.kv('Surface temperature', `${B.teff.toLocaleString('en-US')} K`), this.kv('Radius', km(B.R)), this.kv('Mass', `${(B.gm / 1.327e20).toFixed(1)} Suns`), this.kv('Light', `${B.lum} Suns`),
        h('div', { class: 'faint sm' }, 'The system\'s star. Every planet\'s distance is measured from it.')));
    } else if (B.star) {
      out.push(this.sec('SURVEY', this.kv('Orbit', dist), this.kv('Year', span(period(id))), this.kv('Surface temperature', `${B.teff.toLocaleString('en-US')} K`), this.kv('Radius', km(B.R)), this.kv('Mass', `${(B.gm / 1.327e20).toFixed(1)} Suns`), this.kv('Light', `${B.lum} Suns`),
        this.kv('Lowest orbit', km(B.low)), this.kv('Orbits up to', km(B.max)), h('div', { class: 'faint sm' }, 'A star: vessels can orbit it, but there\'s nowhere to land.')));
      const tr = this.routeFromTerra(id);
      if (tr) out.push(this.sec('FROM TERRA ORBIT', this.kv('Delta-v', `${kms(tr.dv)}`), this.kv('Trip', span(tr.tof)), this.kv('Next window', span(windowAt(tr, 'terra', id, t, tr.tof) - t))));
      const sci = Object.keys(this.st.done).filter((k) => k.split(':')[1] === id);
      out.push(this.sec('SCIENCE', sci.length ? sci.map((k) => h('div', { class: 'faint sm' }, this.sciName(k))) : h('div', { class: 'faint' }, 'Nothing transmitted from here yet.')));
    } else if (B.gas) {
      out.push(this.sec('SURVEY', this.kv('Orbit', dist), this.kv('Distance from Prometheus A', fromStar), this.kv('Year', span(period(id))),
        this.kv('Gravity', `${B.g} g at the cloud tops`), this.kv('Average temperature', `${degC(B.temp)} at the cloud tops`), this.kv('Radius', km(B.R)), this.kv('Air', B.air), this.kv('Air reaches up to', `${km(B.top)} above the cloud tops`),
        this.kv('Lowest orbit', km(B.low)), this.kv('Orbits up to', km(B.max)), h('div', { class: 'faint sm' }, 'A gas giant: vessels can orbit it, but there\'s no surface to land on.')));
      const tr = this.routeFromTerra(id);
      if (tr) out.push(this.sec('FROM TERRA ORBIT', this.kv('Delta-v', `${kms(tr.dv)}`), this.kv('Trip', span(tr.tof)), tr.via ? h('div', { class: 'faint sm' }, tr.via) : null));
      const sci = Object.keys(this.st.done).filter((k) => k.split(':')[1] === id);
      out.push(this.sec('SCIENCE', sci.length ? sci.map((k) => h('div', { class: 'faint sm' }, this.sciName(k))) : h('div', { class: 'faint' }, 'Nothing transmitted from here yet.')));
    } else {
      out.push(this.sec('SURVEY',
        B.host ? this.kv('Orbit', `${km(B.a)} from the pair's centre, every ${span(period(id))}`) : this.kv('Orbit', dist), this.kv('Distance from Prometheus A', fromStar), B.host ? this.kv('Year', span(period(B.host))) : this.kv('Year', span(period(id))),
        this.kv('Gravity', `${B.g} g`), this.kv('Average temperature', degC(B.temp)), this.kv('Radius', km(B.R)),
        this.kv('Atmosphere', B.atm ? `${B.atm} atm` : 'None'), B.top ? this.kv('Air reaches up to', km(B.top)) : null, this.kv('Air', B.air),
        this.kv('Minerals', `${B.minerals >= 2.5 ? 'Extremely rich' : B.minerals >= 1.4 ? 'Rich' : B.minerals >= 0.8 ? 'Average' : 'Poor'} (×${B.minerals})`),
        this.kv('Surface infrastructure', B.infra ? money(B.infra) : 'None'),
        B.host ? h('div', { class: 'faint sm' }, `Too small to orbit on its own: vessels orbit ${BODIES[B.host].name} and land from there.`) : this.kv('Lowest orbit', km(B.low)), B.host ? null : this.kv('Orbits up to', km(B.max))));
      const land = B.biomes.map((bm) => h('div', { class: 'ds-kv' }, h('span', {}, bm.name, this.st.done[`temp:${id}:${bm.id}`] ? h('span', { class: 'faint' }, ` · ${degC(bm.temp)}`) : null, bm.hazard ? h('span', { class: 'faint' }, ` +${Math.round(bm.hazard * 100)}%`) : null, bm.water && !B.home ? h('span', { class: 'faint' }, ' · water, needs floats') : null),
        h('b', {}, B.atm ? `${kms(descentDv(id, bm.id, false, true))} ${B.chuteAssist ? 'parachutes + rockets' : 'parachutes'} · ${kms(descentDv(id, bm.id, true, true))} with a shield too · ${kms(descentDv(id, bm.id, true))} ${B.chuteAssist ? 'shield + rockets' : 'shield only'} · ${kms(descentDv(id, bm.id, false))} powered` : kms(descentDv(id, bm.id, false)))));
      out.push(this.sec(B.home ? 'COMING HOME' : B.host ? `LANDING (FROM ${BODIES[B.host].name.toUpperCase()}'S LOWEST ORBIT)` : 'LANDING (FROM THE LOWEST ORBIT)', ...land, this.kv('Taking off', kms(ascentDv(id))),
        h('div', { class: 'faint sm' }, B.atm ? `Parachutes and heat shields only count if they're big enough for the whole vessel. A heat shield burns away unless it's reusable; parachutes can be used again.${B.chuteAssist ? ' The air here is too thin for parachutes or a heat shield alone: they slow it, then rockets finish the landing, so it needs an engine too.' : ''} Powered landings and take-offs need a thrust-to-weight over 1 here.` : 'No air, so every landing is under power and needs a thrust-to-weight over 1 here.')));
      if (id !== 'terra') {
        const tr = this.routeFromTerra(hostOf(id));
        if (tr) out.push(this.sec(B.host ? `FROM TERRA ORBIT TO ${BODIES[B.host].name.toUpperCase()} ORBIT` : 'FROM TERRA ORBIT', this.kv('Delta-v', `${kms(tr.dv)}`), this.kv('Trip', span(tr.tof)), tr.via ? h('div', { class: 'faint sm' }, tr.via) : null,
          tr.kind === 'sibling' ? this.kv('Next window', span(windowAt(tr, 'terra', id, t, tr.tof) - t)) : null));
      }
      const sci = Object.keys(this.st.done).filter((k) => k.split(':')[1] === id);
      out.push(this.sec('SCIENCE', sci.length ? sci.map((k) => h('div', { class: 'faint sm' }, this.sciName(k))) : h('div', { class: 'faint' }, 'Nothing transmitted from here yet.')));
    }
    const here = this.st.vessels.filter((v) => (v.at.body || v.at.tr?.to) === id);
    if (here.length) out.push(this.sec('VESSELS HERE', here.map((v) => h('div', { class: 'ds-srow', onclick: () => this.select({ kind: 'vessel', id: v.id }) }, h('span', { class: `pm-vdot${v.fav ? ' fav' : ''}` }), h('span', { class: 'grow' }, v.name), h('span', { class: 'faint sm' }, where(v.at))))));
    return out;
  }

  sciName(key) {
    const [kind, body, biome] = key.split(':');
    const bm = BODIES[body].biomes?.find((b) => b.id === biome)?.name;
    return `${SCIENCE[kind].name}${bm ? `, ${bm}` : ', orbit'}`;
  }

  routeFromTerra(id) {
    const r1 = lowR('terra');
    const direct = transfer('terra', r1, id, lowR(id));
    if (direct) return direct;
    const p = BODIES[id].parent, a = transfer('terra', r1, p, lowR(p)), b = transfer(p, lowR(p), id, lowR(id));
    return a && b ? { dv: a.dv + b.dv, tof: a.tof + b.tof, via: `By way of ${BODIES[p].name} orbit.` } : null;
  }

  vesselPanel(v) {
    const st = stats(v.parts, cargo(v)), B = BODIES[v.at.body || v.at.tr?.to], linked = this.links(), ctl = this.control(v, linked), t = this.st.t;
    const out = [this.sec(null, h('div', { class: 'ds-row' }, this.back(), h('div', { class: 'grow' }), h('button', { class: `pm-fav${v.fav ? ' on' : ''}`, title: v.fav ? 'Unfavourite' : 'Favourite: shows gold on the map', onclick: () => { v.fav = !v.fav; this.save(); this.renderPanel(); } }, v.fav ? '★' : '☆'), h('button', { class: 'ds-btn sm', onclick: () => this.focusOn(v.at.body || v.at.tr.frame) }, 'FOLLOW')))];
    const name = h('input', { class: 'ds-sel pm-name', value: v.name, spellcheck: false });
    name.addEventListener('change', () => {
      if (this.nameTaken(name.value, v)) { name.value = v.name; name.title = 'That name is already taken.'; name.classList.add('bad'); return; }
      v.name = name.value.trim() || v.name; this.save(); this.renderPanel();
    });
    let status = where(v.at);
    if (v.at.s === 'transfer') status += ` · arrives in ${span(v.at.tr.t0 + v.at.tr.tof - t)}`;
    if (v.at.s === 'busy') status += ` · ${span(v.at.until - t)}`;
    const head = v.queue[0];
    if (head?.type === 'go' && head.depart && t < head.depart) status += ` · window opens in ${span(head.depart - t)}`;
    const left = dvOf(st, v.fuel);
    out.push(this.sec(v.site ? 'SURFACE SITE' : 'VESSEL', name, h('div', { class: 'ds-note' }, status),
      v.site ? this.kv('Population', st.crew ? `${st.crew} crew` : 'None: no crew modules', st.crew ? 'good' : 'faint') : null,
      this.kv('Mass', tons(st.dry + v.fuel)), this.kv('Fuel', `${tons(v.fuel)} of ${tons(st.cap)}`),
      h('div', { class: 'ds-budget' }, h('div', { class: 'ds-bar', style: { width: `${st.cap ? (v.fuel / st.cap) * 100 : 0}%` } })),
      this.kv('Delta-v left', kms(left)),
      ...(st.isp ? (B.binary ? BODY_ORDER.filter((k) => BODIES[k].host === B.id).map((k) => BODIES[k]) : [B]).filter((K) => K.g).map((K) => this.kv(`T/W at ${K.name}`, twr(st, v.fuel, K.g).toFixed(2), twr(st, v.fuel, K.g) < 1 ? 'warn' : null)) : []),
      v.site ? this.kv('Funding', `+${money(this.siteIncome(v))} a year`, 'good') : null,
      this.kv('Control', ctl.why, ctl.ok ? 'good' : 'bad'),
      st.rover && v.at.s === 'landed' ? this.kv('Rover', v.off?.rover ? 'Off' : v.roverAt ? `Driving to ${this.roverNext(v)?.name}, ${span(v.roverAt - t)}` : this.roverNext(v) ? 'Waiting' : `Every land biome on ${B.name} sampled`, v.roverAt ? 'good' : 'faint') : null,
      this.kv('Comms', st.comms ? (stats(live(v)).comms ? `${linked.has(v) ? 'Linked' : 'Out of range'} (${+stats(live(v)).comms.toFixed(2)} AU${st.relay ? ', relay' : ''})` : 'Antenna off') : 'No antenna', linked.has(v) ? 'good' : 'faint')));
    out.push(this.siteSec(v));
    out.push(this.dockSec(v));
    out.push(this.powerSec(v));
    out.push(this.sec('MODULES', v.parts.map((p) => h('div', { class: 'ds-kv', title: 'Right-click for more', oncontextmenu: (e) => this.moduleMenu(e, v, p) },
      h('span', { class: v.off?.[p.id] ? 'faint' : '' }, PARTS[p.id].name, p.reusable ? h('span', { class: 'faint' }, ' (reusable)') : null, v.off?.[p.id] ? h('span', { class: 'faint' }, ' (off)') : null), h('b', {}, `×${p.n}`)))));
    if (v.data.length) out.push(this.sec('READINGS ON BOARD', ...v.data.map((d) => this.kv(d.name, `${d.rp} RP`)), h('div', { class: 'faint sm' }, 'They\'re transmitted on their own once there\'s a signal, or handed over when the vessel is recovered on Terra.')));
    out.push(this.maneuvers(v, ctl));
    out.push(this.sec(null, h('button', { class: 'ds-btn sm', onclick: async () => {
      if (!(await confirmDialog(`Abandon ${v.name}?`, 'It\'s left where it is and taken off the list. Readings still on board are lost.', { okLabel: 'Abandon', danger: true }))) return;
      this.st.vessels = this.st.vessels.filter((x) => x !== v); this.sel = null; this.log(`${v.name} abandoned.`, 'bad'); this.save(); this.renderPanel();
    } }, 'ABANDON')));
    this.panel.append(...out);
  }

  /** A landed vessel can be made a surface site for good: it never takes off again, and landers that come down in the
   *  same spot can dock with it (to leave their fuel, regolith and modules, and to undock again with some). */
  siteSec(v) {
    if (v.site) {
      return this.sec('BUILD AND LAUNCH', h('div', { class: 'faint sm' }, `Spend ${v.name}'s components on new modules for it, or on a vessel launched from here. It has ${tons(v.comps || 0)} of components; its storage holds ${tons(stats(v.parts).store)}.`),
        h('div', { class: 'ds-row' }, h('div', { class: 'grow' }), h('button', { class: 'ds-btn sm primary', onclick: () => { this.overSite = v.id; if (this.overKind === 'site') this.renderOver(); else this.openOver('site'); } }, 'BUILD / LAUNCH')));
    }
    if (v.at.s !== 'landed') return null;
    const B = BODIES[v.at.body], spot = biomeOf(v.at.body, v.at.biome)?.name;
    return this.sec('SURFACE SITE', h('div', { class: 'faint sm' }, `Make ${v.name} a surface site on ${B.name}, ${spot}: it stays there for good, landers that come down there can dock with it, and it brings in ${money(this.siteIncome(v))} a year in funding.`),
      h('div', { class: 'ds-row' }, h('div', { class: 'grow' }), h('button', { class: 'ds-btn sm', disabled: !!v.queue.length, title: v.queue.length ? 'Clear its maneuvers first' : '', onclick: async () => {
        if (!(await confirmDialog(`Make ${v.name} a surface site?`, `It stays on ${B.name} for good: it can't take off any more.`, { okLabel: 'Make site' }))) return;
        v.site = true;
        this.log(`${v.name} is now a surface site on ${B.name}, ${spot}: +${money(this.siteIncome(v))} a year. Funding up to ${money(this.income())} a year.`, 'good');
        this.save(); this.renderPanel();
      } }, 'MAKE SURFACE SITE')));
  }

  /** Right-click on one of a vessel's modules: scrap (at a site), switch on and off, vent fuel, delete. */
  moduleMenu(e, v, p) {
    const P = PARTS[p.id], items = [], done = () => { this.save(); this.renderPanel(); };
    if (v.site) {
      const scrap = (n) => {
        const r = this.scrapCheck(v, p, n);
        return { label: `${n === 1 ? 'Scrap one' : `Scrap all ${n}`} into components (+${tons(r.gain)})`, icon: 'merge', disabled: !!r.why, action: () => this.scrap(v, p, n) };
      };
      const why = this.scrapCheck(v, p, 1).why;
      items.push(scrap(1), p.n > 1 ? scrap(p.n) : null, { note: why || `Back as components: ${Math.round(SCRAP_BACK * 100)}% of what it took to build` }, { sep: true });
    }
    if (P.makes || P.range || P.rover) {
      const off = !!v.off?.[p.id];
      items.push({ label: off ? 'Turn on' : 'Turn off', icon: 'power', action: () => { this.work(v); this.switchPart(v, p.id, off); done(); } });
    }
    if (P.cell) {
      const mode = v.cellMode || 'auto';
      items.push({ label: 'Automatic', checked: mode === 'auto', action: () => {
        this.work(v);
        // off automatic it keeps doing what it was doing
        v.cellMode = mode === 'auto' ? (this.powerOf(v).cell.used ? 'on' : 'off') : 'auto';
        this.log(`${v.name}'s fuel cell ${v.cellMode === 'auto' ? 'is on automatic' : `is on manual, ${v.cellMode}`}.`); done();
      } });
      if (mode !== 'auto') items.push({ label: 'Running', checked: mode === 'on', action: () => { this.work(v); v.cellMode = mode === 'on' ? 'off' : 'on'; this.log(`${v.name}'s fuel cell turned ${v.cellMode}.`); done(); } });
      items.push({ note: mode === 'auto' ? 'On automatic it only runs when the solar panels fall short.' : 'On manual it runs flat out, or not at all.' });
    }
    if (P.litres) {
      const one = Math.min(v.fuel, (P.litres / 1000) * p.n), vent = (t) => { this.work(v); v.fuel = Math.max(0, v.fuel - t); this.log(`${v.name} vented ${tons(t)} of fuel.`); done(); };
      items.push({ label: `Vent ${p.n > 1 ? 'these tanks\'' : 'this tank\'s'} worth (${tons(one)})`, icon: 'droplet', disabled: v.fuel <= 1e-9, action: () => vent(one) },
        { label: `Vent all fuel (${tons(v.fuel)})`, icon: 'droplet', disabled: v.fuel <= 1e-9, action: () => vent(v.fuel) });
    }
    if (items.length && !items.at(-1)?.sep) items.push({ sep: true });
    const del = (n) => ({ label: n === 1 ? (p.n > 1 ? 'Delete one' : 'Delete') : `Delete all ${n}`, icon: 'trash', action: async () => {
      if (!(await confirmDialog(`Delete ${P.name}${n > 1 ? ` ×${n}` : ''}?`, `It's thrown away: nothing comes back${P.litres ? ', and fuel that no longer fits is lost' : ''}.`, { okLabel: 'Delete', danger: true }))) return;
      this.work(v);
      this.removeParts(v, p, n);
      this.log(`${v.name} threw away ${P.name}${n > 1 ? ` ×${n}` : ''}.`);
      done();
    } });
    items.push(del(1), p.n > 1 ? del(p.n) : null);
    contextMenu(e, items);
  }

  /** Switches a module (solar panels, an antenna, a rover) on or off: all of that kind on the vessel together. */
  switchPart(v, id, on) {
    v.off ||= {};
    if (on) delete v.off[id]; else v.off[id] = true;
    if (PARTS[id].rover) {
      // the rover stops where it is, and picks up from there
      if (!on && v.roverAt) { v.roverLeft = Math.max(0, v.roverAt - this.st.t); v.roverAt = null; }
      if (on && v.at.s === 'landed' && this.roverNext(v)) { v.roverAt = this.st.t + (v.roverLeft ?? ROVER_DAYS * DAY); v.roverLeft = null; }
    }
    this.log(`${v.name}: ${PARTS[id].name} turned ${on ? 'on' : 'off'}.`);
  }

  /** Takes n of module p off a vessel; what no longer has anywhere to go (fuel, regolith, metal, components) is lost. */
  removeParts(v, p, n) {
    v.parts = v.parts.map((x) => (x === p ? { ...x, n: x.n - n } : x)).filter((x) => x.n > 0);
    const st = stats(v.parts);
    v.fuel = Math.min(v.fuel, st.cap);
    v.ore = Math.min(v.ore || 0, st.oreCap);
    v.comps = Math.min(v.comps || 0, st.store);
    v.metal = Math.min(v.metal || 0, st.store - v.comps);
    if (!st.refine) v.refining = false;
    if (!st.smelt) v.smelting = false;
    if (!st.fab) v.fabbing = false;
    if (!st.rover) { v.roverAt = null; v.roverLeft = null; }
    if (v.off && !v.parts.some((x) => x.id === p.id)) delete v.off[p.id];
  }

  /** What scrapping n of a site's module p gives back (t of components), and why it can't (no room to keep them). */
  scrapCheck(v, p, n) {
    const gain = PARTS[p.id].m * COMP_PER_T * SCRAP_BACK * n;
    const left = v.parts.map((x) => (x === p ? { ...x, n: x.n - n } : x)).filter((x) => x.n > 0);
    const room = stats(left).store - (v.metal || 0) - (v.comps || 0);
    return { gain, left, why: gain > room + 1e-9 ? `No room for the components: ${tons(Math.max(0, room))} of storage free${PARTS[p.id].store ? ' without it' : ''}.` : '' };
  }

  /** Takes n of a site's module p apart: half the components it took come back into storage. */
  scrap(v, p, n) {
    const r = this.scrapCheck(v, p, n);
    if (r.why) return;
    this.work(v);
    this.removeParts(v, p, n);
    v.comps = (v.comps || 0) + r.gain;
    this.log(`${v.name} scrapped ${PARTS[p.id].name}${n > 1 ? ` ×${n}` : ''}: +${tons(r.gain)} of components.`);
    this.save(); this.renderPanel();
  }

  /** Power, and the drill, regolith and refinery if it has them. */
  powerSec(v) {
    const pw = this.powerOf(v), st = pw.st, panels = v.parts.reduce((n, p) => n + (PARTS[p.id].makes ? p.n : 0), 0), off = live(v).reduce((n, p) => n - (PARTS[p.id].makes ? p.n : 0), panels), rows = [
      this.kv('Solar', st.solar ? `${kw(pw.solar)} from ${panels} panel${panels === 1 ? '' : 's'}${off ? ` (${off} off)` : ''}` : 'No solar panels', pw.ok || pw.cell.up || pw.rtg ? null : 'bad'),
      pw.rtg ? this.kv('RTG', kw(pw.rtg), 'good') : null,
      pw.cell.has ? this.kv(`Fuel cell (${pw.cell.mode === 'auto' ? 'auto' : 'manual'})`, pw.cell.used ? `${kw(pw.cell.used)} · burning ${((pw.cell.used / st.cell) * st.cellBurn * 1000).toFixed(1)} kg of fuel a day`
        : pw.cell.mode === 'off' ? 'Off' : !pw.cell.up ? 'No fuel' : 'Standing by', pw.cell.used ? 'good' : 'faint') : null,
      this.kv('Needed', kw(pw.need), pw.ok ? null : 'bad'),
      pw.ok ? null : h('div', { class: 'sm bad' }, 'Not enough power: no readings are taken or transmitted, and a probe takes no new orders.')];
    if (pw.drill.has) rows.push(this.kv('Drill', pw.drill.on ? `Digging ${tons(st.drill * BODIES[v.at.body].minerals)} a day · ${kw(st.drillKW)}` : `Idle: ${pw.drill.why}`, pw.drill.on ? 'good' : 'faint'));
    if (st.oreCap) {
      rows.push(this.kv('Regolith', `${tons(v.ore || 0)} of ${tons(st.oreCap)}`),
        h('div', { class: 'ds-budget' }, h('div', { class: 'ds-bar', style: { width: `${((v.ore || 0) / st.oreCap) * 100}%` } })));
    }
    if (pw.refine.has) {
      rows.push(h('div', { class: 'ds-kv' }, h('span', {}, 'Refinery'), h('b', { class: pw.refine.on ? 'good' : 'faint' }, pw.refine.on ? `Making ${tons(st.refine)} of fuel a day from ${tons(st.refine * REFINE_RATIO)} of regolith · ${kw(st.refineKW)}` : v.refining ? `Idle: ${pw.refine.why}` : 'Stopped')),
        h('div', { class: 'ds-row' },
          h('button', { class: 'ds-btn sm', onclick: () => { this.work(v); v.refining = !v.refining; this.log(`${v.name}'s refinery ${v.refining ? 'started' : 'stopped'}.`); this.save(); this.renderPanel(); } }, v.refining ? 'STOP REFINERY' : 'START REFINERY'),
          h('div', { class: 'grow' }),
          v.ore > 0 ? h('button', { class: 'ds-btn sm', title: 'Throw the regolith out (lighter)', onclick: () => { v.ore = 0; this.save(); this.renderPanel(); } }, 'DUMP REGOLITH') : null));
    } else if (v.ore > 0) rows.push(h('button', { class: 'ds-btn sm', title: 'Throw the regolith out (lighter)', onclick: () => { v.ore = 0; this.save(); this.renderPanel(); } }, 'DUMP REGOLITH'));
    const toggle = (key, what) => h('div', { class: 'ds-row' }, h('button', { class: 'ds-btn sm', onclick: () => {
      this.work(v); v[key] = !v[key]; this.log(`${v.name}'s ${what} ${v[key] ? 'started' : 'stopped'}.`); this.save(); this.renderPanel();
    } }, `${v[key] ? 'STOP' : 'START'} ${what.toUpperCase()}`));
    const runs = (name, x, key, making, perDay, kwh) => [h('div', { class: 'ds-kv' }, h('span', {}, name), h('b', { class: x.on ? 'good' : 'faint' }, x.on ? `Making ${tons(perDay)} of ${making} a day · ${kw(kwh)}` : v[key] ? `Idle: ${x.why}` : 'Stopped')), toggle(key, name.toLowerCase())];
    if (pw.smelt.has) rows.push(...runs('Smelter', pw.smelt, 'smelting', 'metal', st.smelt, st.smeltKW));
    if (pw.fab.has) rows.push(...runs('Fabricator', pw.fab, 'fabbing', 'components', st.fab, st.fabKW));
    if (st.store || v.metal > 0 || v.comps > 0) {
      const full = (v.metal || 0) + (v.comps || 0);
      rows.push(this.kv('Storage', `${tons(full)} of ${tons(st.store)}`), this.kv('Metal', tons(v.metal || 0)), this.kv('Components', tons(v.comps || 0)),
        h('div', { class: 'ds-budget' }, h('div', { class: 'ds-bar', style: { width: `${st.store ? Math.min(100, (full / st.store) * 100) : 0}%` } })));
    }
    return this.sec('POWER', ...rows.filter(Boolean));
  }

  /** The maneuver queue and the controls to add to it. */
  maneuvers(v, ctl) {
    const p = this.plan(v), t = this.st.t;
    const rows = p.steps.map(({ q, step, fuel }, i) => h('div', { class: `pm-q${step.why ? ' bad' : ''}` },
      h('div', { class: 'ds-kv' }, h('span', {}, `${i + 1}. ${step.label}`), h('b', {}, step.why ? 'can\'t' : kms(step.dv)),
        ctl.ok ? h('button', { class: 'ds-x', title: 'Remove this and what comes after it', onclick: () => { v.queue.splice(i); this.save(); this.renderPanel(); } }, '×') : null),
      step.why ? h('div', { class: 'sm bad' }, step.why) : h('div', { class: 'faint sm' }, [
        step.tof ? `${span(step.tof)} on the way` : null, q.type === 'go' && q.depart && t < q.depart ? `leaves in ${span(q.depart - t)}` : null,
        step.shield ? (step.shield.tiles ? 'thermal tiles' : `heat shield${step.shield.reusable ? ' (kept)' : ' (used up)'}`) : null, `${kms(dvOf(stats(p.parts, cargo(v)), fuel))} left after`].filter(Boolean).join(' · '))));
    const sec = this.sec('MANEUVERS', rows.length ? rows : h('div', { class: 'faint' }, 'Nothing planned.'));
    if (!ctl.ok) { sec.append(h('div', { class: 'sm warn' }, ctl.why === 'No power' ? 'No power: a probe can\'t take new orders until its solar panels cover what it needs. Orders already queued still run.' : `${ctl.why}: a probe can't take new orders until it's in range of Terra or a dish relay. Orders already queued still run.`)); return sec; }
    if (p.steps.some((s) => s.step.why)) return sec;
    const at = p.at, add = (q) => { v.queue.push(q); this.save(); this.renderPanel(); };
    const preview = (q) => { const r = this.plan(v, q).steps.at(-1).step; return r.why ? h('span', { class: 'sm bad' }, r.why) : h('span', { class: 'sm faint' }, `${kms(r.dv)}${r.tof ? ` · ${span(r.tof)}` : ''}${r.shield ? (r.shield.tiles ? ' · thermal tiles' : ` · heat shield${r.shield.reusable ? '' : ' used up'}`) : ''}${r.chuted ? ' · parachutes' : ''}${(r.chuted || r.shield) && BODIES[q.body || at.body]?.chuteAssist ? ' and rockets' : ''}`); };
    const B = BODIES[at.body];
    // a height box's range, shown under it; outside it the maneuver can't be added
    const hOk = (T, el) => { const x = Number(el.value); return el.value !== '' && x >= Math.round(T.low / 1000) && x <= Math.round(T.max / 1000); };
    const hRange = (T) => `Lowest ${km(T.low)} · highest ${km(T.max)}`;
    if (at.s === 'orbit') {
      // orbit height
      // what's typed in the height boxes outlasts the panel's redraws (until it's added)
      const typed = (this.typed ||= new Map()), hKey = `${v.id}:height:${at.body}`;
      const hIn = h('input', { class: 'ds-sel pm-num', type: 'number', min: Math.round(B.low / 1000), max: Math.round(B.max / 1000), value: typed.get(hKey) ?? Math.round((at.r - B.R) / 1000) });
      hIn.dataset.keep = hKey;
      const hOut = h('div', {});
      const hq = () => ({ type: 'height', r: B.R + Number(hIn.value) * 1000 });
      const hAdd = h('button', { class: 'ds-btn sm', onclick: () => { if (hOk(B, hIn)) { typed.delete(hKey); add(hq()); } } }, 'ADD');
      const dq = () => ({ type: 'dip', r: B.R + Number(hIn.value) * 1000 });
      const dAdd = B.top ? h('button', { class: 'ds-btn sm', title: 'Bring the orbit down by dipping into the air: far less fuel, but it takes many passes', onclick: () => { if (hOk(B, hIn) && dq().r < at.r) { typed.delete(hKey); add(dq()); } } }, 'DIP') : null;
      const hShow = () => {
        const ok = hOk(B, hIn), lower = ok && dq().r < at.r - 1;
        hAdd.disabled = !ok;
        if (dAdd) dAdd.disabled = !lower;
        clear(hOut).append(ok ? preview(hq()) : h('span', { class: 'sm bad' }, `Pick a height from ${km(B.low)} to ${km(B.max)}.`), lower && dAdd ? h('div', {}, h('span', { class: 'sm faint' }, 'Dipping: '), preview(dq())) : null);
      };
      hIn.addEventListener('input', () => { typed.set(hKey, hIn.value); hShow(); }); hShow();
      sec.append(h('div', { class: 'pm-add' }, h('div', { class: 'ds-h2' }, `ORBIT HEIGHT AROUND ${B.name.toUpperCase()}`), h('div', { class: 'ds-row' }, hIn, h('span', { class: 'faint' }, 'km'), h('div', { class: 'grow' }), dAdd, hAdd), h('div', { class: 'sm faint' }, hRange(B)), hOut));
      // transfer
      const dests = reachable(at.body);
      if (dests.length) {
        const to = h('select', { class: 'ds-sel sm' }, dests.map((id) => h('option', { value: id }, BODIES[id].name)));
        to.value = this.lastTo && dests.includes(this.lastTo) ? this.lastTo : dests[0];
        const tIn = h('input', { class: 'ds-sel pm-num', type: 'number' }), tKey = () => `${v.id}:go:${to.value}`;
        tIn.dataset.keep = `${v.id}:go`;
        const tOut = h('div', {});
        const setRange = () => { const T = BODIES[to.value]; tIn.min = Math.round(T.low / 1000); tIn.max = Math.round(T.max / 1000); tIn.value = typed.get(tKey()) ?? Math.round(T.low / 1000); };
        const sp = h('select', { class: 'ds-sel sm', title: "Faster transfers reach further past the target's orbit: sooner there, more delta-v" }, FAST.map((f, i) => h('option', { value: i }, f.name)));
        sp.value = this.lastFast || 0;
        const tq = () => ({ type: 'go', to: to.value, r: BODIES[to.value].R + Number(tIn.value) * 1000, ...(Number(sp.value) ? { fast: Number(sp.value) } : {}) });
        const tAdd = h('button', { class: 'ds-btn sm', onclick: () => { if (hOk(BODIES[to.value], tIn)) { typed.delete(tKey()); add(tq()); } } }, 'ADD'), tRange = h('div', { class: 'sm faint' });
        const tShow = () => {
          const T = BODIES[to.value], ok = hOk(T, tIn);
          tRange.textContent = `Orbit height at ${T.name}: ${hRange(T).toLowerCase()}`;
          tAdd.disabled = !ok;
          if (!ok) return clear(tOut).append(h('span', { class: 'sm bad' }, `Pick a height from ${km(T.low)} to ${km(T.max)}.`));
          FAST.forEach((f, i) => { const x = transfer(at.body, at.r, to.value, BODIES[to.value].R + Number(tIn.value) * 1000, i); sp.options[i].textContent = x && !x.tooClose ? `${f.name} · ${kms(x.dv)} · ${span(x.tof)}` : `${f.name} · too close to ${BODIES[x?.frame]?.name || 'it'}`; });
          const q = tq(), tr = transfer(at.body, at.r, q.to, q.r, q.fast);
          clear(tOut).append(preview(q), tr?.kind === 'sibling' ? h('div', { class: 'sm faint' }, `Next window in ${span(windowAt(tr, at.body, q.to, Math.max(t, this.queueEnd(v)), tr.tof) - t)}`) : null);
        };
        setRange();
        to.addEventListener('change', () => { this.lastTo = to.value; setRange(); tShow(); });
        tIn.addEventListener('input', () => { typed.set(tKey(), tIn.value); tShow(); }); sp.addEventListener('change', () => { this.lastFast = Number(sp.value); tShow(); }); tShow();
        sec.append(h('div', { class: 'pm-add' }, h('div', { class: 'ds-h2' }, 'TRANSFER'), h('div', { class: 'ds-row' }, to, tIn, h('span', { class: 'faint' }, 'km'), tAdd), h('div', { class: 'ds-row' }, h('span', { class: 'faint sm' }, 'Speed'), sp), tRange, tOut));
      }
      // landing
      const near = this.st.vessels.filter((x) => x !== v && x.at.s === 'orbit' && x.at.body === at.body);
      if (near.length) {
        const ds = h('select', { class: 'ds-sel sm' }, near.map((x) => h('option', { value: x.id }, `${x.name} (${km(x.at.r - B.R)})`)));
        const dOut = h('div', {}), dShow = () => clear(dOut).append(preview({ type: 'dock', target: ds.value }));
        ds.addEventListener('change', dShow); dShow();
        sec.append(h('div', { class: 'pm-add' }, h('div', { class: 'ds-h2' }, 'DOCK'), h('div', { class: 'ds-row' }, ds, h('div', { class: 'grow' }), h('button', { class: 'ds-btn sm', onclick: () => add({ type: 'dock', target: ds.value }) }, 'ADD')), dOut));
      }
      const grounds = B.biomes ? [at.body] : BODY_ORDER.filter((k) => BODIES[k].host === at.body);
      if (grounds.length) {
        const pair = grounds[0] !== at.body;
        const bs = h('select', { class: 'ds-sel sm' }, grounds.flatMap((k) => BODIES[k].biomes.map((b) => h('option', { value: `${k}:${b.id}` }, `${pair ? `${BODIES[k].name}: ` : ''}${b.name}${b.hazard ? ` (+${Math.round(b.hazard * 100)}%)` : ''}${b.water ? ' (water)' : ''}`))));
        const lq = () => { const [k, biome] = bs.value.split(':'); return pair ? { type: 'land', body: k, biome } : { type: 'land', biome }; };
        const lOut = h('div', {});
        const lShow = () => clear(lOut).append(preview(lq()));
        bs.addEventListener('change', lShow); lShow();
        sec.append(h('div', { class: 'pm-add' }, h('div', { class: 'ds-h2' }, B.home ? `RETURN TO ${B.name.toUpperCase()} (RECOVER IT)` : `LAND ON ${grounds.map((k) => BODIES[k].name.toUpperCase()).join(' OR ')}`),
          h('div', { class: 'ds-row' }, B.home ? null : bs, h('div', { class: 'grow' }), h('button', { class: 'ds-btn sm', onclick: () => add(lq()) }, B.home ? 'ADD RETURN' : 'ADD')), lOut));
      }
    } else if (at.s === 'landed' && v.site) {
      sec.append(h('div', { class: 'faint sm' }, 'A surface site stays where it is. Landers that come down in the same spot can dock with it.'));
    } else if (at.s === 'landed') {
      const sites = this.st.vessels.filter((x) => x !== v && x.site && x.at.s === 'landed' && x.at.body === at.body && x.at.biome === at.biome);
      if (sites.length) {
        const ds = h('select', { class: 'ds-sel sm' }, sites.map((x) => h('option', { value: x.id }, x.name)));
        const dOut = h('div', {}), dShow = () => clear(dOut).append(preview({ type: 'dock', target: ds.value }));
        ds.addEventListener('change', dShow); dShow();
        sec.append(h('div', { class: 'pm-add' }, h('div', { class: 'ds-h2' }, 'DOCK WITH THE SURFACE SITE'), h('div', { class: 'ds-row' }, ds, h('div', { class: 'grow' }), h('button', { class: 'ds-btn sm', onclick: () => add({ type: 'dock', target: ds.value }) }, 'ADD')), dOut));
      }
      const floats = stats(v.parts).floats > 0, drop = h('input', { type: 'checkbox' }), aOut = h('div', {});
      drop.checked = floats;
      const aq = () => (floats && drop.checked ? { type: 'ascend', dropFloats: true } : { type: 'ascend' });
      const aShow = () => clear(aOut).append(preview(aq()));
      drop.addEventListener('change', aShow); aShow();
      sec.append(h('div', { class: 'pm-add' }, h('div', { class: 'ds-h2' }, `TAKE OFF TO ${BODIES[hostOf(at.body)].name.toUpperCase()} ORBIT`),
        floats ? h('label', { class: 'ds-row sm' }, drop, h('span', {}, 'Leave the floats behind (lighter, but no more water landings)')) : null,
        h('div', { class: 'ds-row' }, aOut, h('div', { class: 'grow' }), h('button', { class: 'ds-btn sm', onclick: () => add(aq()) }, 'ADD'))));
    }
    return sec;
  }

  /** Roughly when the queue now planned is done (for the next window's countdown). */
  queueEnd(v) {
    let t = this.st.t;
    if (v.at.s === 'transfer') t = v.at.tr.t0 + v.at.tr.tof;
    if (v.at.s === 'busy') t = v.at.until;
    for (const s of this.plan(v).steps) t += (s.q.depart && s.q.depart > t ? s.q.depart - t : 0) + (s.step.tof || (s.q.type === 'land' ? LANDING_S : s.q.type === 'ascend' ? ASCENT_S : 0));
    return t;
  }

  select(sel, follow = false) {
    this.sel = sel;
    if (follow) this.focusOn(sel.kind === 'body' ? sel.id : (() => { const v = this.vessel(sel.id); return v.at.body || v.at.tr.frame; })());
    this.renderPanel();
  }

  // ---------------------------------------------------------------- overlays: the launch editor and research

  openOver(kind) {
    if (this.overKind === kind) return this.closeOver();
    this.overKind = kind;
    this.over.hidden = false;
    this.renderOver();
    this.renderTop();
  }
  closeOver() { this.overKind = null; this.over.hidden = true; clear(this.over); this.catScope = null; this.renderTop(); }
  renderOver() {
    clear(this.over);
    if (this.overKind === 'launch') this.launchEditor();
    else if (this.overKind === 'research') this.researchView();
    else if (this.overKind === 'catalogue') this.catalogueView();
    else if (this.overKind === 'site') { const S = this.vessel(this.overSite); if (S?.site) this.launchEditor(S); else this.closeOver(); }
  }

  /** The launch editor: at Terra, paid for in money; at a surface site (S), paid for in components. */
  launchEditor(S = null) {
    const d = S ? this.siteDraft() : this.draft(), c = S ? this.siteCheck(d, S) : this.launchCheck(d), redo = () => { this.save(); this.renderOver(); };
    const addPart = (id, reusable = false) => {
      const p = d.parts.find((x) => x.id === id && !!x.reusable === reusable);
      if (p) p.n++; else d.parts.push({ id, n: 1, ...(reusable ? { reusable: true } : {}) });
      redo();
    };
    const cat = PART_CATS.map(([k, label]) => {
      const list = Object.values(PARTS).filter((p) => p.cat === k);
      return h('div', { class: 'pm-cat' }, h('div', { class: 'ds-h2' }, label.toUpperCase()), list.map((p) => {
        const ok = this.has(p.tech), crew = S && p.crew;
        return h('button', { class: 'pm-part', disabled: !ok || crew, title: crew ? 'Crew come up from Terra: crewed modules can\'t be built at a site' : ok ? this.partTip(p) : `Research ${TECH.find((x) => x.id === p.tech).name} first`, onclick: () => addPart(p.id) },
          h('span', { class: 'grow' }, p.name), h('span', { class: 'faint' }, !ok ? '🔒' : S ? tons(p.m * COMP_PER_T) : money(p.cost)));
      }));
    });
    const stack = d.parts.map((p) => {
      const P = PARTS[p.id];
      return h('div', { class: 'pm-stack-row' },
        h('span', { class: 'grow' }, P.name, p.reusable ? h('span', { class: 'warn' }, ' · reusable') : null),
        !S && P.cat === 'shield' && !P.tiles && this.has('reuse') ? h('label', { class: 'pm-tick', title: `A reusable heat shield costs ${REUSABLE_SHIELD}× as much and isn't used up landing` },
          h('input', { type: 'checkbox', checked: !!p.reusable, onchange: (e) => { p.reusable = e.target.checked || undefined; redo(); } }), 'reusable') : null,
        h('button', { class: 'ds-btn sm', onclick: () => { p.n--; if (p.n <= 0) d.parts.splice(d.parts.indexOf(p), 1); redo(); } }, '−'),
        h('b', { class: 'pm-n' }, p.n),
        h('button', { class: 'ds-btn sm', onclick: () => { p.n++; redo(); } }, '+'));
    });
    // boosters and a reusable lifter, at Terra and at sites alike
    const noLift = S && !LIFTERS[d.cls];
    const boost = h('select', { class: 'ds-sel', disabled: !this.has('boosters') || noLift }, Array.from({ length: BOOSTER.max + 1 }, (_, i) => h('option', { value: String(i) }, String(i))));
    boost.value = String(d.boosters);
    boost.addEventListener('change', () => { d.boosters = Number(boost.value); redo(); });
    const reuse = h('input', { type: 'checkbox', checked: d.reusable, disabled: !this.has('reuse') || noLift });
    reuse.addEventListener('change', () => { d.reusable = reuse.checked; redo(); });
    const foot = [
      h('label', { class: 'pm-foot', title: this.has('reuse') ? `The lifter flies back: a launch costs ${Math.round(0.4 * 100)}% of its price` : 'Research Reusability to unlock' }, reuse, h('span', { class: this.has('reuse') && !noLift ? '' : 'faint' }, 'Reusable lifter')),
      h('label', { class: 'pm-foot', title: this.has('boosters') ? `+${BOOSTER.payload * 100}% payload each` : 'Research Boosters to unlock' }, h('span', { class: 'faint' }, 'Boosters'), boost)];
    if (S) return this.siteEditor(S, d, c, cat, stack, redo, foot);
    const cls = h('select', { class: 'ds-sel' }, Object.values(LIFTERS).map((L) => {
      const x = lifter(L.id, d.boosters, d.reusable);
      return h('option', { value: L.id, disabled: !this.has(L.tech) || x.air }, `${L.name} · ${tons(x.payload)} · ${money(x.cost)}${!this.has(L.tech) ? ' 🔒' : x.air ? ' (airless worlds only)' : ''}`);
    }));
    cls.value = d.cls;
    cls.addEventListener('change', () => { d.cls = cls.value; redo(); });
    const name = h('input', { class: 'ds-sel pm-name', placeholder: this.autoName(c.st.crew), value: d.name, spellcheck: false });
    const taken = h('div', { class: 'sm bad' });
    // checked as you type; the rest of the window redraws only when you leave the box
    const nameCheck = () => { taken.textContent = this.nameTaken(name.value) ? 'That name is already taken.' : ''; go.disabled = c.issues.some((x) => !x.startsWith('There\'s already')) || this.nameTaken(name.value); };
    name.addEventListener('input', () => { d.name = name.value; nameCheck(); });
    name.addEventListener('change', () => redo());
    const tw = this.targetCheck(d, c, redo);
    const go = h('button', { class: 'ds-btn primary wide', onclick: () => this.launch() }, 'LAUNCH');
    nameCheck();
    this.over.append(h('div', { class: 'pm-ed' },
      h('div', { class: 'pm-ed-head' }, h('span', { class: 'pm-ed-title' }, 'NEW LAUNCH'), h('div', { class: 'grow' }), h('button', { class: 'ds-x', title: 'Close', onclick: () => this.closeOver() }, '×')),
      h('div', { class: 'pm-ed-body' },
        h('div', { class: 'pm-ed-cat' }, cat),
        h('div', { class: 'pm-ed-stack' }, h('div', { class: 'ds-h' }, 'PAYLOAD'), stack.length ? stack : h('div', { class: 'faint' }, 'Click modules on the left to add them.'),
          h('div', { class: 'faint sm pm-hint' }, 'The lifter takes this to Terra orbit and is dropped. Everything the vessel does after that comes out of the engines and fuel up here.')),
        h('div', { class: 'pm-ed-sum' },
          name,
          this.kv('Mass', `${tons(c.mass)} of ${tons(c.L.payload)}`, c.mass > c.L.payload ? 'bad' : null),
          h('div', { class: 'ds-budget' }, h('div', { class: `ds-bar${c.mass > c.L.payload ? ' over' : ''}`, style: { width: `${Math.min(100, (c.mass / c.L.payload) * 100)}%` } })),
          this.fillCtl(d, c.st.cap, redo), this.kv('Delta-v in orbit', kms(dvOf(c.st, c.fuel))), tw,
          ...this.gearRows(c.st, c.mass, madeAt(c.st, 1), 'at Terra'),
          this.kv('Modules', money(c.st.cost)), this.kv('Lifter', money(c.L.cost)), this.kv('Total', money(c.cost), c.cost > this.st.money ? 'bad' : null),
          ...c.issues.filter((x) => !x.startsWith('There\'s already')).map((x) => h('div', { class: 'sm bad' }, x)), taken,
          go)),
      h('div', { class: 'pm-ed-foot' },
        h('label', { class: 'pm-foot' }, h('span', { class: 'faint' }, 'Class'), cls), ...foot)));
  }

  /** What a design carries for landing, power, mining and heat, as the launch windows show it. made: its power where it starts. */
  gearRows(st, mass, made, here) {
    const run = st.drillKW + st.refineKW + st.smeltKW + st.fabKW;
    return [
      st.legs ? this.kv('Legs hold', `${tons(st.legs)} at 1 g`) : null,
      st.chute ? this.kv('Parachutes let down', tons(st.chute)) : null,
      st.floats ? this.kv('Floats hold', `${tons(st.floats)} at 1 g, on water`) : null,
      this.kv(`Power ${here}`, `${kw(made)} made · ${kw(st.load)} needed`, made < st.load - 1e-9 ? 'bad' : null),
      st.drill || st.refine || st.smelt || st.fab ? this.kv('Mining and industry', `${kw(run)} more while running`, made < st.load + run - 1e-9 ? 'warn' : null) : null,
      st.oreCap ? this.kv('Regolith tanks', tons(st.oreCap)) : null,
      st.store ? this.kv('Storage', tons(st.store)) : null,
      st.cool ? this.kv('Radiators cool', tons(st.cool), st.cool < mass - 1e-9 ? 'warn' : null) : null,
      st.shields.length ? this.kv('Heat shield covers', st.shields.map((s) => `${tons(s.covers)}${s.tiles ? ' (tiles)' : ''}`).join(', ')) : null,
    ];
  }

  /** The maneuvers from one body's lowest orbit to another's, the fewest transfers there are (null if there's no way). */
  routeLegs(from, to) {
    if (from === to) return [];
    const key = `${from}>${to}`;
    if ((this.routes ||= new Map()).has(key)) return this.routes.get(key);
    const orbits = BODY_ORDER.filter((id) => BODIES[id].parent && !BODIES[id].host && !BODIES[id].hole);
    const ok = (a, b) => { const tr = transfer(a, lowR(a), b, lowR(b)); return tr && !tr.tooClose; };
    let paths = [[from]], seen = new Set([from]), found = null;
    while (paths.length && !found) {
      const next = [];
      for (const p of paths) for (const b of orbits) {
        if (seen.has(b) || !ok(p[p.length - 1], b)) continue;
        seen.add(b);
        if (b === to) { found = [...p, b]; break; }
        next.push([...p, b]);
      }
      paths = next;
    }
    const legs = found && found.slice(1).map((b) => ({ type: 'go', to: b, r: lowR(b) }));
    this.routes.set(key, legs);
    return legs;
  }

  // ---------------------------------------------------------------- building at a surface site

  siteDraft() {
    this.st.siteDraft ||= { name: '', cls: 'build', boosters: 0, reusable: false, parts: [] };
    const d = this.st.siteDraft;
    d.fill ??= 100;
    if (LIFTERS[d.cls] && !this.has(LIFTERS[d.cls].tech)) d.cls = 'build';
    if (!this.has('boosters')) d.boosters = 0; else d.boosters ||= 0;
    if (!this.has('reuse')) d.reusable = false;
    d.parts = d.parts.filter((p) => this.has(PARTS[p.id].tech) && !p.reusable);
    return d;
  }

  /** What building the draft at site S takes: modules (t) and a lifter, all paid in components out of its storage. */
  siteCheck(d, S) {
    const st = stats(d.parts), build = d.cls === 'build', L = LIFTERS[d.cls] ? lifter(d.cls, d.boosters, d.reusable, S.at.body) : null, B = BODIES[S.at.body], have = S.comps || 0, store = stats(S.parts).store;
    const fuel = build ? 0 : Math.min((st.cap * d.fill) / 100, S.fuel), mass = st.dry + fuel, mods = st.dry * COMP_PER_T, need = mods + (L ? L.comps : 0), issues = [];
    const made = madeAt(st, lightAt(this.vesselHelio(S), this.st.t));
    if (!d.parts.length) issues.push('Add some modules.');
    if (d.parts.some((x) => PARTS[x.id].crew)) issues.push('Crew come up from Terra: crewed modules can\'t be built at a site.');
    if (!build) {
      if (d.parts.length && !st.probe) issues.push('It needs a probe core to be steered.');
      if (L?.air) issues.push(`The ${L.name} only flies off worlds with no air; ${B.name} has air.`);
      if (B.hot && d.parts.length && st.cool < mass - 1e-9) issues.push(this.tooHot(B.id, st, fuel));
      if (L && mass > L.payload + 1e-9) issues.push(`${tons(mass)} is more than the ${L.name} puts in orbit (${tons(L.payload)}).`);
      if (d.parts.length && made < st.load - 1e-9) issues.push(`It needs ${kw(st.load)} and its solar panels${st.rtg ? ' and RTGs' : ''} make ${kw(made)} here: add more.`);
      if (this.nameTaken(d.name)) issues.push(`There's already a vessel called ${d.name.trim()}.`);
    }
    if (need > store + 1e-9) issues.push(`It takes ${tons(need)} of components, more than ${S.name}'s storage holds (${tons(store)}): build more storage first.`);
    else if (need > have + 1e-9) issues.push(`It takes ${tons(need)} of components; ${S.name} has ${tons(have)}.`);
    // building into the site: what the whole site will be once the new modules are in
    const all = build ? [...S.parts, ...d.parts] : null, whole = all && stats(all);
    return { st, L, build, fuel, mass, mods, need, have, made, issues, all, whole, wholeMade: whole && madeAt(whole, lightAt(this.vesselHelio(S), this.st.t)) };
  }

  /** The editor's right side and foot at a site: add the modules to the site, or launch them as a new vessel. */
  siteEditor(S, d, c, cat, stack, redo, foot) {
    const B = BODIES[S.at.body], o = hostOf(S.at.body);
    const cls = h('select', { class: 'ds-sel' }, h('option', { value: 'build' }, `None: add the modules to ${S.name}`), h('option', { value: 'none' }, 'None: a new vessel on the ground beside the site'),
      Object.values(LIFTERS).map((L) => {
        const x = lifter(L.id, d.boosters, d.reusable, S.at.body);
        return h('option', { value: L.id, disabled: !this.has(L.tech) || x.air }, `${L.name} · ${tons(x.payload)} · ${tons(x.comps)} of components${!this.has(L.tech) ? ' 🔒' : x.air ? ' (airless worlds only)' : ''}`);
      }));
    cls.value = d.cls;
    cls.addEventListener('change', () => { d.cls = cls.value; redo(); });
    const name = h('input', { class: 'ds-sel pm-name', placeholder: this.autoName(0), value: d.name, spellcheck: false });
    const taken = h('div', { class: 'sm bad' });
    const nameCheck = () => { taken.textContent = !c.build && this.nameTaken(name.value) ? 'That name is already taken.' : ''; go.disabled = c.issues.some((x) => !x.startsWith('There\'s already')) || (!c.build && this.nameTaken(name.value)); };
    name.addEventListener('input', () => { d.name = name.value; nameCheck(); });
    name.addEventListener('change', () => redo());
    const go = h('button', { class: 'ds-btn primary wide', onclick: () => this.siteBuild(S) }, c.build ? 'BUILD' : 'LAUNCH');
    nameCheck();
    const over = c.L && c.mass > c.L.payload;
    // the trip check, from where this starts: the site itself once built, the ground beside it, or the host's orbit on a lifter
    const tw = this.targetCheck(d, c, redo, c.build ? { at: { ...S.at }, parts: c.all, fuel: S.fuel, from: S.name, site: true }
      : c.L ? { at: { s: 'orbit', body: o, r: lowR(o) }, parts: d.parts, fuel: c.fuel, from: `${BODIES[o].name} orbit` }
        : { at: { ...S.at }, parts: d.parts, fuel: c.fuel, from: `the ground beside ${S.name}` });
    this.over.append(h('div', { class: 'pm-ed' },
      h('div', { class: 'pm-ed-head' }, h('span', { class: 'pm-ed-title' }, `BUILD AT ${S.name.toUpperCase()}`), h('span', { class: 'faint sm' }, `${B.name}, ${biomeOf(S.at.body, S.at.biome)?.name}`), h('div', { class: 'grow' }), h('button', { class: 'ds-x', title: 'Close', onclick: () => this.closeOver() }, '×')),
      h('div', { class: 'pm-ed-body' },
        h('div', { class: 'pm-ed-cat' }, cat),
        h('div', { class: 'pm-ed-stack' }, h('div', { class: 'ds-h' }, c.build ? 'NEW MODULES' : 'PAYLOAD'), stack.length ? stack : h('div', { class: 'faint' }, 'Click modules on the left to add them.'),
          h('div', { class: 'faint sm pm-hint' }, c.build ? `Built straight into ${S.name}, a tonne of components for each tonne of modules.`
            : c.L ? `The lifter is built from components too: it takes this to ${BODIES[o].name} orbit and is dropped. Its fuel comes out of ${S.name}'s tanks.`
              : `It starts on the ground beside ${S.name} and takes off on its own engines. Its fuel comes out of ${S.name}'s tanks.`)),
        h('div', { class: 'pm-ed-sum' },
          c.build ? null : name,
          c.build ? null : this.kv('Mass', c.L ? `${tons(c.mass)} of ${tons(c.L.payload)}` : tons(c.mass), over ? 'bad' : null),
          c.L ? h('div', { class: 'ds-budget' }, h('div', { class: `ds-bar${over ? ' over' : ''}`, style: { width: `${Math.min(100, (c.mass / c.L.payload) * 100)}%` } })) : null,
          c.build ? null : this.fillCtl(d, c.st.cap, redo),
          c.build ? null : this.kv('Fuel from the site', `${tons(c.fuel)} of ${tons(S.fuel)} it has`, c.fuel < (c.st.cap * d.fill) / 100 - 1e-9 ? 'warn' : null),
          c.build ? h('div', { class: 'ds-h2' }, `${S.name.toUpperCase()} ONCE BUILT`) : null,
          c.build ? this.kv('Mass', tons(c.whole.dry + cargo(S) + S.fuel)) : null,
          this.kv(c.L ? `Delta-v in ${BODIES[o].name} orbit` : 'Delta-v', kms(c.build ? dvOf(c.whole, S.fuel) : dvOf(c.st, c.fuel))),
          !c.L && (c.build ? c.whole : c.st).isp ? (() => { const x = c.build ? twr(c.whole, S.fuel, B.g) : twr(c.st, c.fuel, B.g); return this.kv(`T/W at ${B.name}`, x.toFixed(2), x < 1 ? 'bad' : null); })() : null,
          tw,
          ...(c.build ? this.gearRows(c.whole, c.whole.dry + cargo(S) + S.fuel, c.wholeMade, 'here') : this.gearRows(c.st, c.mass, c.made, c.L ? `in ${BODIES[o].name} orbit` : 'here')),
          c.build ? h('div', { class: 'ds-h2' }, 'COST') : null,
          this.kv('Modules', `${tons(c.mods)} of components`), c.L ? this.kv('Lifter', `${tons(c.L.comps)} of components`) : null,
          this.kv('Total', `${tons(c.need)} of ${tons(c.have)} at the site`, c.need > c.have + 1e-9 ? 'bad' : null),
          ...c.issues.filter((x) => !x.startsWith('There\'s already')).map((x) => h('div', { class: 'sm bad' }, x)), taken,
          go)),
      h('div', { class: 'pm-ed-foot' }, h('label', { class: 'pm-foot' }, h('span', { class: 'faint' }, 'Lifter'), cls), ...foot)));
  }

  /** Builds the site draft: into the site, or as a new vessel (on the ground beside it, or lifted to orbit). */
  siteBuild(S) {
    const d = this.siteDraft(), c = this.siteCheck(d, S);
    if (c.issues.length) return;
    S.comps = Math.max(0, (S.comps || 0) - c.need);
    if (c.build) {
      for (const p of d.parts) {
        const same = S.parts.find((x) => x.id === p.id && !x.reusable);
        if (same) same.n += p.n; else S.parts.push({ id: p.id, n: p.n });
      }
      this.log(`${S.name} built ${d.parts.map((p) => `${PARTS[p.id].name} ×${p.n}`).join(', ')} from ${tons(c.need)} of components.`, 'good');
      d.parts = [];
      // new modules get to work straight away: science takes its readings, a new rover sets off
      this.reached(S);
    } else {
      const n = this.st.nextId++, o = hostOf(S.at.body);
      const v = { id: `v${n}`, name: d.name.trim() || this.autoName(0), parts: structuredClone(d.parts), fuel: c.fuel, queue: [], data: [], visited: [], landedOn: [S.at.body], launched: this.st.t,
        at: c.L ? { s: 'orbit', body: o, r: lowR(o), ph: Math.random() * TAU } : { s: 'landed', body: S.at.body, biome: S.at.biome } };
      S.fuel -= c.fuel;
      this.st.vessels.push(v);
      this.log(`${v.name} ${c.L ? `launched from ${S.name} to ${BODIES[o].name} orbit` : `put together beside ${S.name}`}, from ${tons(c.need)} of components and ${tons(c.fuel)} of ${S.name}'s fuel${c.L && d.reusable ? ' (the lifter came back)' : ''}.`, 'good');
      this.reached(v);
      d.name = '';
      this.sel = { kind: 'vessel', id: v.id };
    }
    this.closeOver();
    this.save(true);
    this.renderPanel();
  }

  /** The launch window's target check: pick a world (and where on it) and see whether this design gets into its orbit,
   *  down onto it and back up, with the thrust-to-weight there. */
  targetCheck(d, c, redo, start = null) {
    const ids = BODY_ORDER.filter((id) => BODIES[id].parent && !BODIES[id].home && BODIES[id].biomes);
    if (!ids.includes(d.target)) d.target = ids.includes('dynamis') ? 'dynamis' : ids[0];
    const B = BODIES[d.target];
    if (!B.biomes.some((b) => b.id === d.biome)) d.biome = B.biomes[0].id;
    const to = h('select', { class: 'ds-sel sm' }, ids.map((id) => h('option', { value: id }, BODIES[id].name)));
    to.value = d.target;
    to.addEventListener('change', () => { d.target = to.value; redo(); });
    const bs = h('select', { class: 'ds-sel sm' }, B.biomes.map((b) => h('option', { value: b.id }, `${b.name}${b.water ? ' (water)' : ''}`)));
    bs.value = d.biome;
    bs.addEventListener('change', () => { d.biome = bs.value; redo(); });
    const box = h('div', { class: 'pm-target' }, h('div', { class: 'ds-h2' }, 'CAN IT GET THERE?'), h('div', { class: 'ds-row' }, to, bs));
    // where it starts: Terra orbit for a launch from home, or wherever a site puts it (its host's orbit, or the ground)
    start ||= { at: { s: 'orbit', body: 'terra', r: lowR('terra') }, parts: d.parts, fuel: c.fuel, from: 'Terra orbit', launched: true };
    const st = stats(start.parts);
    if (!start.parts.length || !st.isp) return box.append(h('div', { class: 'faint sm' }, start.parts.length ? 'Add an engine to check.' : 'Add modules to check.')), box;
    // flown with the fuel it starts with, through the same checks as real maneuvers
    const o = hostOf(d.target), O = BODIES[o], r = lowR(o), landed = start.at.s === 'landed';
    const pre = landed ? [{ type: 'ascend' }] : [], from = landed ? hostOf(start.at.body) : start.at.body;
    let legs, via = '';
    if (from === 'terra') { // from home: the same way the system panel works it out
      const route = this.routeFromTerra(o);
      legs = route?.via ? [{ type: 'go', to: O.parent, r: lowR(O.parent) }, { type: 'go', to: o, r }] : [{ type: 'go', to: o, r }];
      via = route?.via ? `, ${route.via.toLowerCase()}` : '';
    } else {
      legs = this.routeLegs(from, o);
      if (!legs) return box.append(h('div', { class: 'sm bad' }, `There's no way from ${BODIES[from].name} to ${O.name}.`)), box;
      if (legs.length > 1) via = `, by way of ${legs.slice(0, -1).map((q) => `${BODIES[q.to].name} orbit`).join(' and ')}`;
    }
    const ghost = { at: start.at, parts: start.parts, fuel: start.fuel, queue: [...pre, ...legs, o === d.target ? { type: 'land', biome: d.biome } : { type: 'land', body: d.target, biome: d.biome }, { type: 'ascend' }] };
    const steps = this.plan(ghost).steps, row = (k, i) => {
      const s = steps[i];
      if (!s) return this.kv(k, '—', 'faint');
      return s.step.why ? h('div', { class: 'ds-note' }, h('div', { class: 'ds-kv' }, h('span', {}, k), h('b', { class: 'bad' }, 'No')), h('div', { class: 'sm bad' }, s.step.why))
        : this.kv(k, `Yes · ${kms(dvOf(stats(s.parts || start.parts), s.fuel))} left`, 'good');
    };
    const n = pre.length + legs.length, arrive = n === 0 ? start.fuel : steps[n - 1] && !steps[n - 1].step.why ? steps[n - 1].fuel : start.fuel;
    const t = twr(st, arrive, B.g);
    return box.append(
      n ? row(`Orbit ${O.name}`, n - 1) : this.kv(`Orbit ${O.name}`, 'Already there', 'good'),
      row(`Land, ${B.biomes.find((b) => b.id === d.biome).name}`, n),
      row('Take off again', n + 1),
      this.kv(`T/W at ${B.name}`, t.toFixed(2), t < 1 ? 'bad' : null),
      h('div', { class: 'faint sm' }, `Straight from ${start.from} with the fuel it ${start.launched ? '\'s launched with' : start.site ? 'has' : 'starts with'}${via}. T/W with the fuel left on arrival.`)), box;
  }

  partTip(p) {
    const bits = [`${tons(p.m)}`];
    if (p.thrust) bits.push(`${p.thrust} kN`, `Isp ${p.isp} s`);
    if (p.litres) bits.push(`${tons(p.litres / 1000)} of fuel`);
    if (p.holds) bits.push(`holds ${tons(p.holds)} at 1 g`);
    if (p.chute) bits.push(`lets down up to ${tons(p.chute)} where there's air; stack them for more`);
    if (p.floats) bits.push(`holds ${tons(p.floats)} at 1 g on water; can be left behind on take-off`);
    if (p.rover) bits.push(`drives to the other land biomes, ${ROVER_DAYS} days each, and analyses the ground there`);
    if (p.covers) bits.push(`covers up to ${tons(p.covers)}`);
    if (p.tiles) bits.push(`covers ${tons(p.tiles)} of the vessel coming down through air; tiles add up, and they're never used up`);
    if (p.cools) bits.push(`keeps ${tons(p.cools)} of the vessel cool; with enough to cover all of it, it can go to Pandora`);
    if (p.rtg) bits.push(`makes ${kw(p.rtg)} anywhere, however far from the star, with no fuel`);
    if (p.range) bits.push(`${p.range} AU range${p.relay ? ', relays' : ''}`);
    if (p.crew) bits.push(`${p.crew} crew, readings worth ${Math.round((CREW_SCI - 1) * 100)}% more`);
    if (p.sci) bits.push(`${SCIENCE[p.sci].name}, ${SCIENCE[p.sci].where}`);
    if (p.cell) bits.push(`makes up to ${kw(p.cell)} from fuel, burning ${tons(p.burn)} a day flat out; on automatic only when the solar panels fall short (right-click it on a vessel to change)`);
    if (p.makes) bits.push(`makes ${kw(p.makes)} at Terra's distance from the star, less further out`);
    if (p.drill) bits.push(`digs ${tons(p.drill)} of regolith a day on land (times the ground's minerals) into regolith tanks`);
    if (p.ore) bits.push(`holds ${tons(p.ore)} of regolith`);
    if (p.smelt) bits.push(`turns ${tons(p.smelt * SMELT_RATIO)} of regolith into ${tons(p.smelt)} of metal a day, kept in storage units; start and stop it from the vessel`);
    if (p.fab) bits.push(`turns ${tons(p.fab * FAB_RATIO)} of metal into ${tons(p.fab)} of components a day, kept in storage units; components build modules and vessels at a surface site`);
    if (p.store) bits.push(`holds ${tons(p.store)} of metal and components together`);
    if (p.refine) bits.push(`turns ${tons(p.refine * REFINE_RATIO)} of regolith into ${tons(p.refine)} of fuel a day; start and stop it from the vessel`);
    if (p.uses) bits.push(`needs ${kw(p.uses)}${p.drill ? ' while digging' : p.refine || p.smelt || p.fab ? ' while running' : ''}`);
    return bits.join(' · ');
  }

  /** How full the tanks go up, for every tank in the payload at once. */
  fillCtl(d, cap, redo) {
    const out = h('b', {}), show = () => { out.textContent = `${d.fill}% · ${tons((cap * d.fill) / 100)} of ${tons(cap)}`; };
    const slide = h('input', { type: 'range', class: 'pm-slide', min: 0, max: 100, step: 1, value: d.fill, disabled: !cap });
    slide.addEventListener('input', () => { d.fill = Number(slide.value); show(); });
    slide.addEventListener('change', () => redo());
    show();
    return h('div', { class: 'pm-fill' }, h('div', { class: 'ds-kv' }, h('span', {}, 'Fuel'), out), slide,
      h('div', { class: 'pm-fill-picks' }, [0, 25, 50, 75, 100].map((n) => h('button', { class: `ds-btn sm${d.fill === n ? ' on' : ''}`, disabled: !cap, onclick: () => { d.fill = n; redo(); } }, `${n}%`))));
  }

  /** The research tree: a lane for each branch, a column for each step in from Basic Rocketry, and a line from every
   *  tech to the ones it opens up. */
  researchView() {
    const byId = Object.fromEntries(TECH.map((x) => [x.id, x])), tier = {};
    const tierOf = (x) => (tier[x.id] ??= x.needs.length ? 1 + Math.max(...x.needs.map((n) => tierOf(byId[n]))) : 0);
    TECH.forEach(tierOf);
    const cols = Math.max(...Object.values(tier)), cards = {};
    const done = TECH.filter((x) => x.rp && this.has(x.id)).length, all = TECH.filter((x) => x.rp).length;
    const card = (x) => {
      const got = this.has(x.id), ready = x.needs.every((n) => this.has(n)), can = !got && ready && this.st.rp >= x.rp;
      return (cards[x.id] = h('div', { class: `pm-tech${got ? ' got' : ready ? can ? ' can' : '' : ' locked'}`, 'data-id': x.id },
        h('div', { class: 'ds-kv' }, h('b', {}, x.name), h('span', { class: got ? 'good' : can ? 'pm-rp' : '' }, got ? '✓' : `${x.rp} RP`)),
        h('div', { class: 'faint sm' }, x.gives),
        !ready ? h('div', { class: 'sm warn' }, `Needs ${x.needs.filter((n) => !this.has(n)).map((n) => byId[n].name).join(', ')}`) : null,
        !got && ready ? h('button', { class: 'ds-btn sm', disabled: !can, onclick: () => { this.st.rp -= x.rp; this.st.tech.push(x.id); this.log(`Researched ${x.name}.`, 'good'); this.save(true); this.renderOver(); this.renderPanel(); } }, 'RESEARCH') : null));
    };
    const grid = h('div', { class: 'pm-tree-grid', style: { gridTemplateColumns: `120px repeat(${cols}, 220px)` } },
      h('div', {}), Array.from({ length: cols }, (_, i) => h('div', { class: 'pm-tree-tier faint sm' }, `STEP ${i + 1}`)),
      TECH_BRANCHES.flatMap(([b, label]) => [h('div', { class: 'pm-tree-lane ds-h2' }, label.toUpperCase()),
        ...Array.from({ length: cols }, (_, i) => h('div', { class: 'pm-tree-cell' }, TECH.filter((x) => x.branch === b && tier[x.id] === i + 1).map(card)))]));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), tree = h('div', { class: 'pm-tree' }, svg, grid);
    svg.setAttribute('class', 'pm-tree-lines');
    // the lines, once the cards have been laid out (and again whenever the window changes size). They only run through
    // the gaps: down the gap between two columns, and across along the empty strip at the top of a lane, never over a card.
    const GAP = 17; // half the column gap
    const draw = () => {
      const r = tree.getBoundingClientRect(), o = { left: r.left - tree.scrollLeft, top: r.top - tree.scrollTop }; // the tree's content, scrolled or not
      svg.setAttribute('width', tree.scrollWidth); svg.setAttribute('height', tree.scrollHeight);
      svg.replaceChildren(...TECH.filter((x) => cards[x.id]).flatMap((x) => x.needs.filter((n) => cards[n]).map((n) => {
        const a = cards[n].getBoundingClientRect(), b = cards[x.id].getBoundingClientRect();
        const x1 = a.right - o.left, y1 = a.top + a.height / 2 - o.top, x2 = b.left - o.left, y2 = b.top + b.height / 2 - o.top;
        const pts = [[x1, y1]];
        if (x2 - x1 < GAP * 3) pts.push([x2 - GAP, y1], [x2 - GAP, y2]); // the next column over: straight down the gap between
        else { // further on: out into the gap, along the top of the lane it's going to, and down the gap before it
          const lane = cards[x.id].parentElement.getBoundingClientRect().top - o.top + 5;
          pts.push([x1 + GAP, y1], [x1 + GAP, lane], [x2 - GAP, lane], [x2 - GAP, y2]);
        }
        pts.push([x2, y2]);
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', roundPath(pts, 6));
        p.setAttribute('class', this.has(x.id) ? 'got' : this.has(n) ? 'open' : '');
        p.dataset.from = n; p.dataset.to = x.id;
        return p;
      })));
    };
    tree.watch = new ResizeObserver(draw); // kept on the tree: an observer nothing holds on to can be thrown away
    tree.watch.observe(tree); tree.watch.observe(grid);
    // drag anywhere off a button to move the tree around
    tree.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const sx = e.clientX + tree.scrollLeft, sy = e.clientY + tree.scrollTop;
      const move = (m) => { tree.scrollLeft = sx - m.clientX; tree.scrollTop = sy - m.clientY; };
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); tree.classList.remove('drag'); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
      tree.classList.add('drag');
      e.preventDefault();
    });
    // pointing at a tech lights up the lines into and out of it
    tree.addEventListener('mouseover', (e) => {
      const id = e.target.closest('.pm-tech')?.dataset.id;
      for (const p of svg.children) p.classList.toggle('hot', !!id && (p.dataset.from === id || p.dataset.to === id));
    });
    this.over.append(h('div', { class: 'pm-ed pm-research' },
      h('div', { class: 'pm-ed-head' }, h('span', { class: 'pm-ed-title' }, 'RESEARCH'), h('span', { class: 'pm-rp' }, `${this.st.rp} RP to spend`), h('span', { class: 'faint sm' }, `${done} of ${all} researched`), h('div', { class: 'grow' }), h('button', { class: 'ds-x', title: 'Close', onclick: () => this.closeOver() }, '×')),
      h('div', { class: 'faint sm pm-hint' }, `Science modules take readings on their own: ${Object.values(SCIENCE).map((s) => `${s.name.toLowerCase()} ${s.where}`).join('; ')}. Each reading counts once, worth more the further out it's from, and is transmitted when the vessel has a signal (or handed over if it's recovered). Each research point also brings ${money(SCI_GRANT)} in funding.`),
      tree));
  }

  /** Every reading there is to take at a body, by where it's taken: orbit first, then each biome. */
  reportGroups(id) {
    const B = BODIES[id], groups = [];
    if (B.parent && !B.host && !B.hole) {
      groups.push({ where: 'orbit', name: 'In orbit', keys: [`solar:${id}`, ...(B.atm ? [`atmos:${id}:orbit`] : []), `crew:${id}:orbit`] });
    }
    if (!B.home) for (const bm of B.biomes || []) {
      groups.push({ where: bm.id, name: bm.name, keys: [`${bm.water ? 'water' : 'surface'}:${id}:${bm.id}`, `temp:${id}:${bm.id}`, ...(B.atm ? [`atmos:${id}:${bm.id}`] : []), `crew:${id}:${bm.id}`] });
    }
    return groups;
  }

  /** What it takes to get a reading that hasn't been taken yet. */
  reportNeeds(key) {
    const [kind, , at = 'orbit'] = key.split(':'), here = at === 'orbit' ? 'in orbit' : 'landed here';
    const part = (sci) => Object.values(PARTS).find((p) => p.sci === sci)?.name;
    if (kind === 'crew') return `Needs a vessel with crew on board, ${here}.`;
    if (kind === 'surface') return `Needs a ${part('surface')} landed here, or a rover that drives here.`;
    return `Needs a ${part(kind)} ${here}.`;
  }

  /** The catalogue: every body in the system, and for each its science reports, survey, telescope view and log. */
  catalogueView() {
    const sel = (this.catSel ||= 'terra'), tab = (this.catTab ||= 'reports'), B = BODIES[sel], at = this.st.sciAt || {};
    const onBoard = (key) => this.st.vessels.find((v) => v.data.some((d) => d.key === key));
    const count = (id) => { const keys = this.reportGroups(id).flatMap((g) => g.keys); return [keys.filter((k) => this.st.done[k]).length, keys.length]; };
    const all = BODY_ORDER.map(count).reduce((s, [a, b]) => [s[0] + a, s[1] + b], [0, 0]);
    const depth = (id) => { let d = 0; for (let k = BODIES[id].parent; k && k !== 'star'; k = BODIES[k].parent) d++; return BODIES[id].parent ? d + 1 : 0; };
    const list = BODY_ORDER.map((id) => {
      const [got, of] = count(id);
      return h('div', { class: `ds-srow pm-cat-row${id === sel ? ' on' : ''}`, style: { paddingLeft: `${4 + depth(id) * 14}px` }, onclick: () => { this.catSel = id; this.renderOver(); } },
        h('span', { class: 'ds-dot', style: { background: BODIES[id].col } }), h('span', { class: 'grow' }, BODIES[id].name),
        of ? h('span', { class: `sm ${got === of ? 'good' : 'faint'}` }, `${got}/${of}`) : null);
    });
    // the telescope: the same canvas while this body stays picked, so it never shows blank between redraws
    const scope = this.catScope?.id === sel ? this.catScope.canvas : h('canvas', { class: 'pm-scope pm-cat-scope', width: 300, height: 180 });
    this.catScope = { canvas: scope, id: sel };
    let body;
    if (tab === 'reports') {
      const groups = this.reportGroups(sel);
      body = groups.length ? groups.map((g) => h('div', { class: 'pm-cat-group' }, h('div', { class: 'ds-h2' }, g.name.toUpperCase()), g.keys.map((key) => {
        const kind = key.split(':')[0], got = this.st.done[key], when = at[key], v = !got && onBoard(key);
        const bm = B.biomes?.find((x) => x.id === g.where);
        return h('div', { class: `pm-report${got ? ' got' : ''}` },
          h('div', { class: 'ds-kv' }, h('b', {}, SCIENCE[kind].name), h('span', { class: `sm ${got ? 'good' : v ? 'warn' : 'faint'}` }, got ? 'Received' : v ? 'On board' : 'Not taken')),
          got ? [
            h('div', { class: 'faint sm' }, `${when ? `${date(when.t)} · from ${when.by}${when.crew ? ' (crewed)' : ''}` : 'Received before reports were filed'} · worth ${Math.round(SCIENCE[kind].rp * B.sci * (when?.crew ? CREW_SCI : 1))} RP`),
            kind === 'temp' && bm ? h('div', { class: 'pm-report-reading' }, `Mean surface temperature: ${degC(bm.temp)}`) : null,
            h('div', { class: 'ds-note' }, reportFor(key) || 'No report on file.'),
          ] : v ? h('div', { class: 'faint sm' }, `Taken by ${v.name}; the report comes in once it's transmitted home or the vessel is recovered.`) : h('div', { class: 'faint sm' }, this.reportNeeds(key)));
      }))) : h('div', { class: 'faint' }, B.home ? 'Coming down on Terra is a recovery.' : B.hole || !B.parent ? 'Nothing can get close enough to take readings: it can only be watched through the telescope.' : 'No readings to take here.');
      if (B.home) body = [body, h('div', { class: 'faint sm' }, 'Landing on Terra brings a vessel home, so its readings are all from orbit.')];
    } else if (tab === 'survey') {
      body = [B.about ? h('div', { class: 'ds-note' }, B.about) : null, ...this.bodyInfo(sel)];
    } else {
      const log = (this.st.blog?.[sel] || []).slice().reverse();
      body = log.length ? log.map((e) => h('div', { class: `ds-log ${e.kind}` }, h('span', { class: 'faint' }, date(e.t).replace(/ · \d\d:\d\d$/, '')), ' ', e.text)) : h('div', { class: 'faint' }, `Nothing has happened at ${B.name} yet.`);
    }
    const [got, of] = count(sel);
    const tabBtn = (k, label) => h('button', { class: `ds-btn sm${tab === k ? ' on' : ''}`, onclick: () => { this.catTab = k; this.renderOver(); } }, label);
    this.over.append(h('div', { class: 'pm-ed pm-catalogue' },
      h('div', { class: 'pm-ed-head' }, h('span', { class: 'pm-ed-title' }, 'CATALOGUE'), h('span', { class: 'faint sm' }, `${all[0]} of ${all[1]} reports received`), h('div', { class: 'grow' }), h('button', { class: 'ds-x', title: 'Close', onclick: () => this.closeOver() }, '×')),
      h('div', { class: 'pm-cat-body' },
        h('div', { class: 'pm-cat-list' }, list),
        h('div', { class: 'pm-cat-main' },
          h('div', { class: 'pm-cat-top' }, scope,
            h('div', { class: 'pm-cat-id' }, h('div', { class: 'pm-cat-name' }, B.name), h('div', { class: 'faint sm' }, B.kind),
              of ? h('div', { class: 'sm' }, `${got} of ${of} reports`) : null,
              h('button', { class: 'ds-btn sm', onclick: () => { this.closeOver(); this.select({ kind: 'body', id: sel }, true); } }, 'SHOW ON MAP'))),
          h('div', { class: 'pm-cat-tabs' }, tabBtn('reports', `REPORTS${of ? ` (${got}/${of})` : ''}`), tabBtn('survey', 'SURVEY'), tabBtn('log', 'LOG')),
          h('div', { class: 'pm-cat-content' }, body)))));
  }

  // ---------------------------------------------------------------- the map

  resize() {
    const r = this.mapwrap.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr); this.canvas.height = Math.round(this.h * dpr);
    this.dpr = dpr;
  }
  fitSystem() {
    this.follow = null;
    this.view = { cx: 0, cy: 0, scale: (0.46 * Math.min(this.w, this.h)) / (BODIES.baja.a * 1.05) };
  }
  focusOn(id) {
    this.follow = id;
    if (id === 'star') return this.fitSystem();
    if (BODIES[id].hole) { this.view.scale = (0.4 * Math.min(this.w, this.h)) / BODIES.star.galA; return; }
    this.view.scale = (0.08 * Math.min(this.w, this.h)) / BODIES[id].R;
  }

  /** A body's radius on screen: to scale, but never smaller than a dot you can see and click. */
  bodyPx(id) { const B = BODIES[id]; return Math.max(B.R * this.view.scale, !B.parent ? 11 : B.star ? 6 : B.parent === 'star' ? 5 : 3.5); }
  /** Is a moon drawn? Only once zooming in has moved it clear of its parent's dot (and its parent is drawn). */
  shown(id) {
    const B = BODIES[id];
    if (!B.parent) return true;
    if (B.parent === 'star') return B.a * this.view.scale >= this.bodyPx('star') + 4; // zoomed far out, the planets fold into the star
    // a binary pair's moons sit inside the pair's own reach: shown once they're drawn apart from each other
    if (B.host) return this.shown(B.host) && B.a * this.view.scale >= 4;
    return this.shown(B.parent) && B.a * this.view.scale >= this.bodyPx(B.parent) + 8;
  }
  /** How far out from a body's centre something orbiting at r is drawn: to scale. */
  localPx(id, r) { return r * this.view.scale; }
  childPx(id) { return this.localPx(BODIES[id].parent, BODIES[id].a); }
  toScreen(x, y) { return { x: this.w / 2 + (x - this.view.cx) * this.view.scale, y: this.h / 2 - (y - this.view.cy) * this.view.scale }; }
  bodyScreen(id) {
    const B = BODIES[id], t = this.st.t;
    if (B.hole) { const p = holeAt(); return this.toScreen(p.x, p.y); }
    if (!B.parent) return this.toScreen(0, 0);
    if (B.parent === 'star') { const p = helio(id, t); return this.toScreen(p.x, p.y); }
    const p = this.bodyScreen(B.parent), th = angleAt(id, t), d = this.childPx(id);
    return { x: p.x + Math.cos(th) * d, y: p.y - Math.sin(th) * d };
  }
  around(id, th, r) { const p = this.bodyScreen(id), d = r === 0 ? 0 : this.localPx(id, r); return { x: p.x + Math.cos(th) * d, y: p.y - Math.sin(th) * d }; }
  /** A point on a transfer at angle th around its frame, on screen: the true half-ellipse, except that at either end it
   *  stops on the orbit it leaves or is captured into rather than going through the body. */
  trPoint(tr, th) {
    const peri = tr.outbound ? tr.th0 : tr.th0 - Math.PI, nu = th - peri, f = (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, (th - tr.th0) / (tr.sweep ?? Math.PI))))) / 2;
    const ring = (id, r) => (id && id !== tr.frame ? this.localPx(id, r ?? lowR(id)) : 0), s = tr.outbound ? 1 : -1;
    const off = s * (ring(tr.from, tr.r1) * (1 - f) - ring(tr.to, tr.r2) * f); // screen px: out past the inner body, short of the outer one
    const e = (tr.ra - tr.rp) / (tr.ra + tr.rp), r = (tr.rp * (1 + e)) / (1 + e * Math.cos(nu)), c = this.bodyScreen(tr.frame), d = r * this.view.scale + off;
    return { x: c.x + Math.cos(th) * d, y: c.y - Math.sin(th) * d };
  }
  trScreen(tr, tau) { return this.trPoint(tr, onTransfer(tr, tau).th); }
  vesselScreen(v) {
    const at = v.at, t = this.st.t;
    if (at.s === 'orbit') return this.around(at.body, this.orbitAngle(at, t), at.r);
    if (at.s === 'transfer') return this.trScreen(at.tr, t - at.tr.t0);
    if (at.s === 'busy' && at.what === 'dipping') return this.around(at.body, this.dipAngle(at, t), this.dipR(at, t));
    if (at.s === 'busy' && at.what === 'docking' && !at.biome) {
      // round the body, not across it: angle and height eased from its own orbit to the other vessel's
      const T = this.vessel(at.target), f = Math.max(0, Math.min(1, (t - at.from) / (at.until - at.from)));
      const th = at.ph + (TAU * (t - at.from)) / orbitPeriod(at.body, at.r), r2 = T?.at.s === 'orbit' ? T.at.r : at.r;
      const dth = T?.at.s === 'orbit' ? mod(this.orbitAngle(T.at, t) - th, TAU) : 0;
      const p = this.bodyScreen(at.body), d = this.localPx(at.body, at.r) + (this.localPx(at.body, r2) - this.localPx(at.body, at.r)) * f, a = th + dth * f;
      return { x: p.x + Math.cos(a) * d, y: p.y - Math.sin(a) * d };
    }
    // on the ground (or on the way down or up): each biome has its own spot round the edge, and vessels sharing one
    // stand side by side, so every one can be clicked
    const p = this.bodyScreen(at.body), B = BODIES[at.body], r = this.bodyPx(at.body);
    const bi = Math.max(0, B.biomes.findIndex((b) => b.id === at.biome)), same = this.st.vessels.filter((x) => (x.at.s === 'landed' || x.at.s === 'busy') && x.at.body === at.body && x.at.biome === at.biome);
    const k = Math.max(0, same.indexOf(v)), a = Math.PI / 2 + (TAU * bi) / B.biomes.length + (k - (same.length - 1) / 2) * Math.min(0.5, 11 / Math.max(r, 1));
    const f = at.s === 'busy' ? Math.max(0, Math.min(1, (at.until - t) / (at.what === 'landing' ? LANDING_S : ASCENT_S))) : 0;
    const d = r + (at.s === 'busy' ? 5 * (at.what === 'landing' ? f : 1 - f) : 0);
    return { x: p.x + Math.cos(a) * d, y: p.y - Math.sin(a) * d };
  }

  draw() {
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // follow the focused body
    if (this.follow) { const p = this.bodyScreen(this.follow); this.view.cx += (p.x - this.w / 2) / this.view.scale; this.view.cy -= (p.y - this.h / 2) / this.view.scale; }
    ctx.fillStyle = '#05080c';
    ctx.fillRect(0, 0, this.w, this.h);
    this.stars(ctx);
    this.hits = [];
    const star = this.toScreen(0, 0);
    // planet orbits
    ctx.lineWidth = 1;
    for (const id of BODY_ORDER) {
      const B = BODIES[id];
      if (!B.parent || !this.shown(id)) continue;
      ctx.strokeStyle = 'rgba(160,180,200,0.16)';
      ctx.beginPath();
      if (B.parent === 'star') ctx.arc(star.x, star.y, B.a * this.view.scale, 0, TAU);
      else { const p = this.bodyScreen(B.parent); ctx.arc(p.x, p.y, this.childPx(id), 0, TAU); }
      ctx.stroke();
    }
    // Hecate A*, far out: Prometheus A's own orbit round it, and the hole in its glowing ring
    const hp = this.bodyScreen('hecate'), hR = BODIES.star.galA * this.view.scale;
    if (hR < 20 * Math.max(this.w, this.h)) { ctx.strokeStyle = 'rgba(255,160,90,0.14)'; ctx.beginPath(); ctx.arc(hp.x, hp.y, hR, 0, TAU); ctx.stroke(); }
    const hr = BODIES.hecate.R * this.view.scale, hd = 12 * hr; // true size, so it zooms (bodyPx would hold it at 11 px); the disc reaches about 12 horizons out
    if (hp.x > -hd - 60 && hp.x < this.w + hd + 60 && hp.y > -hd - 60 && hp.y < this.h + hd + 60) {
      let reach;
      if (hd < 8) { // a speck: a warm glow round a dot
        reach = Math.max(4, hd);
        const hg = ctx.createRadialGradient(hp.x, hp.y, 0, hp.x, hp.y, reach + 3);
        hg.addColorStop(0, 'rgba(255,214,140,0.95)'); hg.addColorStop(0.5, 'rgba(255,140,60,0.4)'); hg.addColorStop(1, 'rgba(255,90,30,0)');
        ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(hp.x, hp.y, reach + 3, 0, TAU); ctx.fill();
      } else reach = drawHoleMap(ctx, hp.x, hp.y, hr, performance.now() / 1000);
      if (this.sel?.kind === 'body' && this.sel.id === 'hecate') { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(hp.x, hp.y, reach + 6, 0, TAU); ctx.stroke(); }
      this.hits.push({ kind: 'body', id: 'hecate', x: hp.x, y: hp.y, r: reach + 6 });
      this.mapText(ctx, hp.x, hp.y + reach + 16, BODIES.hecate.name, '#ffc890');
    }
    // the star
    const sp = this.bodyPx('star'), glow = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, sp * 4);
    glow.addColorStop(0, 'rgba(225,236,255,0.6)'); glow.addColorStop(1, 'rgba(170,200,255,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(star.x, star.y, sp * 4, 0, TAU); ctx.fill();
    ctx.fillStyle = '#f6f9ff'; ctx.beginPath(); ctx.arc(star.x, star.y, sp, 0, TAU); ctx.fill();
    this.hits.push({ kind: 'body', id: 'star', x: star.x, y: star.y, r: sp + 4 });
    // vessel orbits and transfers (under the planets)
    for (const v of this.st.vessels) this.drawPath(ctx, v);
    for (const id of BODY_ORDER) if (BODIES[id].parent && this.shown(id)) this.drawBody(ctx, id);
    this.mapText(ctx, star.x, star.y + sp + 12, BODIES.star.name, '#dfe9ff');
    for (const v of this.st.vessels) {
      const p = this.vesselScreen(v), on = this.sel?.kind === 'vessel' && this.sel.id === v.id;
      ctx.fillStyle = v.fav ? '#ffc845' : on ? '#ffffff' : '#c9d4ff';
      if (v.site) ctx.fillRect(p.x - 3.5, p.y - 3.5, 7, 7);
      else { ctx.beginPath(); ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x + 3.5, p.y); ctx.lineTo(p.x, p.y + 4); ctx.lineTo(p.x - 3.5, p.y); ctx.closePath(); ctx.fill(); }
      if (on) { ctx.strokeStyle = '#ffffff'; ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, TAU); ctx.stroke(); }
      // vessels side by side on the ground share one label: the picked one's (or the first's) name, +how many more
      const ground = v.at.s === 'landed' || (v.at.s === 'busy' && ((v.at.what !== 'docking' && v.at.what !== 'dipping') || !!v.at.biome)), same = ground ? this.st.vessels.filter((x) => (x.at.s === 'landed' || x.at.s === 'busy') && x.at.body === v.at.body && x.at.biome === v.at.biome) : [v];
      const lead = same.find((x) => this.sel?.kind === 'vessel' && this.sel.id === x.id) || same[0];
      if (lead === v && (on || this.follow === (v.at.body || v.at.tr?.frame))) this.mapText(ctx, p.x + 8, p.y - 6, same.length > 1 ? `${v.name} +${same.length - 1}` : v.docked?.length ? `${v.name} (${v.docked.length + 1} docked)` : v.name, v.fav ? '#ffc845' : '#c9d4ff', 'left');
      this.hits.push({ kind: 'vessel', id: v.id, x: p.x, y: p.y, r: 9 });
    }
  }

  drawPath(ctx, v) {
    const at = v.at, on = this.sel?.kind === 'vessel' && this.sel.id === v.id;
    ctx.strokeStyle = on ? ORBIT_COL : 'rgba(91,108,255,0.45)';
    ctx.lineWidth = on ? 1.6 : 1;
    if (at.s === 'orbit') {
      const p = this.bodyScreen(at.body);
      ctx.beginPath(); ctx.arc(p.x, p.y, this.localPx(at.body, at.r), 0, TAU); ctx.stroke();
      // the transfer it's waiting for, dashed
      const q = v.queue[0];
      if (on && q?.type === 'go') {
        const tr = transfer(at.body, at.r, q.to, q.r, q.fast);
        if (tr && !tr.tooClose) {
          const t0 = q.depart ?? windowAt(tr, at.body, q.to, this.st.t, tr.tof);
          const th0 = tr.kind === 'out' ? angleAt(q.to, t0 + tr.tof) - tr.sweep : angleAt(at.body, t0);
          this.trace(ctx, { ...tr, from: at.body, to: q.to, r1: at.r, r2: q.r, th0 }, true);
        }
      }
    } else if (at.s === 'transfer') this.trace(ctx, at.tr, false);
    else if (at.s === 'busy' && at.what === 'dipping') { const p = this.bodyScreen(at.body); ctx.beginPath(); ctx.arc(p.x, p.y, this.localPx(at.body, this.dipR(at, this.st.t)), 0, TAU); ctx.stroke(); }
    ctx.lineWidth = 1;
  }
  trace(ctx, tr, dashed) {
    ctx.setLineDash(dashed ? [4, 4] : []);
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) { const p = this.trPoint(tr, tr.th0 + ((tr.sweep ?? Math.PI) * i) / 96); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawBody(ctx, id) {
    const B = BODIES[id], p = this.bodyScreen(id), r = this.bodyPx(id), on = this.sel?.kind === 'body' && this.sel.id === id;
    if (B.star) { // the companion: a small red glow
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
      g.addColorStop(0, 'rgba(255,150,100,0.55)'); g.addColorStop(1, 'rgba(255,90,50,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r * 3, 0, TAU); ctx.fill();
      ctx.fillStyle = B.col; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
      if (on) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, TAU); ctx.stroke(); }
      this.mapText(ctx, p.x, p.y + r + 12, B.name, '#ffb08a');
      this.hits.push({ kind: 'body', id, x: p.x, y: p.y, r: r + 5 });
      return;
    }
    if (B.binary) { // nothing there: a small cross where the pair's centre is
      ctx.strokeStyle = on ? '#ffffff' : 'rgba(200,190,170,0.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.x - 3, p.y); ctx.lineTo(p.x + 3, p.y); ctx.moveTo(p.x, p.y - 3); ctx.lineTo(p.x, p.y + 3); ctx.stroke();
      if (on) { ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, TAU); ctx.stroke(); }
      if (r <= 40) this.mapText(ctx, p.x, p.y + r + 12, B.name, '#9fb2c0'); // past that its moons carry their own names
      this.hits.push({ kind: 'body', id, x: p.x, y: p.y, r: r + 5 });
      return;
    }
    const sun = this.bodyScreen(litBy(id));
    drawBody(ctx, id, p.x, p.y, r, Math.atan2(sun.y - p.y, sun.x - p.x), { atm: B.atm, rim: B.rim, flat: B.col });
    if (on) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, TAU); ctx.stroke(); }
    // a pair's moons are named on their own only once they're far enough apart not to sit on the pair's name
    if (!B.host || this.bodyPx(B.host) > 40) this.mapText(ctx, p.x, p.y + r + 12, B.name, '#9fb2c0');
    this.hits.push({ kind: 'body', id, x: p.x, y: p.y, r: r + 5 });
  }
  mapText(ctx, x, y, text, col, align = 'center') {
    ctx.font = '11px ui-monospace, Consolas, monospace'; ctx.textAlign = align; ctx.fillStyle = col; ctx.fillText(text, x, y);
  }
  stars(ctx) {
    this.starField ||= Array.from({ length: 160 }, () => [Math.random(), Math.random(), Math.random()]);
    for (const [x, y, b] of this.starField) { ctx.fillStyle = `rgba(200,215,255,${0.15 + b * 0.35})`; ctx.fillRect(x * this.w, y * this.h, 1, 1); }
  }

  /** The telescope view in a body's panel: the planet through a long lens, with static. */
  /** Draws a telescope view: the body panel's, or the catalogue's. */
  drawScope(sc) {
    const { canvas, id } = sc;
    if (!canvas.isConnected) { if (this.scope === sc) this.scope = null; if (this.catScope === sc) this.catScope = null; return; }
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, B = BODIES[id], cx = W / 2, cy = H / 2, r = H * 0.36;
    ctx.fillStyle = '#030405'; ctx.fillRect(0, 0, W, H);
    if (B.hole) drawHole(ctx, W, H, this.holeView || 'gargantua', performance.now() / 1000);
    else if (!B.parent || B.star) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.6);
      if (B.star) { g.addColorStop(0, '#ffe2d0'); g.addColorStop(0.45, B.col); g.addColorStop(1, 'rgba(255,90,50,0)'); }
      else { g.addColorStop(0, '#ffffff'); g.addColorStop(0.45, '#dfe9ff'); g.addColorStop(1, 'rgba(160,190,255,0)'); }
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 1.6, 0, TAU); ctx.fill();
    } else if (B.binary) {
      const sun = starVec(id, this.st.t), kids = BODY_ORDER.filter((k) => BODIES[k].host === id), big = Math.max(...kids.map((k) => BODIES[k].R));
      for (const k of kids) {
        const K = BODIES[k], th = angleAt(k, this.st.t), d = (K.a / B.R) * W * 0.3;
        drawBody(ctx, k, cx + Math.cos(th) * d, cy - Math.sin(th) * d, r * 0.5 * (K.R / big), Math.atan2(sun.y, -sun.x) + Math.PI * 0.08, { flat: K.col });
      }
    } else {
      const sun = starVec(id, this.st.t);
      drawBody(ctx, id, cx, cy, r, Math.atan2(sun.y, -sun.x) + Math.PI * 0.08, { atm: B.atm, rim: B.rim, flat: B.col });
    }
    // static and scan lines
    const img = ctx.getImageData(0, 0, W, H), px = img.data;
    // one grain pattern, drifting a row at a time, so it shimmers without flickering
    this.grain ||= Float32Array.from({ length: W * H }, () => Math.random() - 0.5);
    const drift = (this.grainAt = ((this.grainAt || 0) + 1) % H) * W;
    for (let i = 0; i < px.length; i += 4) {
      const n = this.grain[(i / 4 + drift) % (W * H)] * 22, line = ((i / 4 / W) | 0) % 3 === 0 ? 0.88 : 1;
      px[i] = (px[i] + n) * line; px[i + 1] = (px[i + 1] + n) * line; px[i + 2] = (px[i + 2] + n) * line;
    }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = 'rgba(180,255,190,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - 10, cy); ctx.lineTo(cx - 4, cy); ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 10, cy); ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy - 4); ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 10); ctx.stroke();
    ctx.font = '10px ui-monospace, Consolas, monospace'; ctx.fillStyle = 'rgba(180,255,190,0.7)'; ctx.textAlign = 'left';
    ctx.fillText(`PTS-1 · ${B.name.toUpperCase()}`, 8, 14);
    ctx.textAlign = 'right';
    ctx.fillText(B.parent ? `${(Math.hypot(helio(id, this.st.t).x - helio('terra', this.st.t).x, helio(id, this.st.t).y - helio('terra', this.st.t).y) / AU).toFixed(3)} AU` : 'FILTER ND5', W - 8, 14);
    ctx.textAlign = 'left';
    ctx.fillText(date(this.st.t), 8, H - 8);
  }

  // ---------------------------------------------------------------- input

  hitAt(x, y) {
    let best = null, bd = Infinity;
    for (const hh of this.hits || []) {
      const d = Math.hypot(hh.x - x, hh.y - y) - (hh.kind === 'vessel' ? 4 : 0); // vessels win a tie
      if (d <= hh.r && d < bd) { best = hh; bd = d; }
    }
    // vessels still on top of each other: clicking again picks the next one
    const stack = (this.hits || []).filter((hh) => hh.kind === 'vessel' && Math.hypot(hh.x - x, hh.y - y) <= hh.r);
    const i = stack.findIndex((hh) => this.sel?.kind === 'vessel' && this.sel.id === hh.id);
    if (stack.length > 1 && i >= 0) return stack[(i + 1) % stack.length];
    return best;
  }

  wire() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      c.focus();
      const r = c.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy, moved: false, px: e.clientX - r.left, py: e.clientY - r.top };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) { drag.moved = true; drag.cx = this.view.cx; drag.cy = this.view.cy; this.follow = null; }
      this.view.cx = drag.cx - dx / this.view.scale; this.view.cy = drag.cy + dy / this.view.scale;
    });
    c.addEventListener('pointerup', () => {
      if (drag && !drag.moved) {
        const hit = this.hitAt(drag.px, drag.py);
        this.sel = hit ? { kind: hit.kind, id: hit.id } : null;
        this.renderPanel();
      }
      drag = null;
    });
    c.addEventListener('dblclick', (e) => {
      const r = c.getBoundingClientRect(), hit = this.hitAt(e.clientX - r.left, e.clientY - r.top);
      if (!hit) return;
      if (hit.kind === 'body') this.select({ kind: 'body', id: hit.id }, true);
      else this.select({ kind: 'vessel', id: hit.id }, true);
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect(), k = Math.exp(-e.deltaY * 0.0015);
      const mx = this.follow ? this.w / 2 : e.clientX - r.left, my = this.follow ? this.h / 2 : e.clientY - r.top;
      const wx = this.view.cx + (mx - this.w / 2) / this.view.scale, wy = this.view.cy - (my - this.h / 2) / this.view.scale;
      this.view.scale = Math.min(1e-1, Math.max(1e-17, this.view.scale * k));
      this.view.cx = wx - (mx - this.w / 2) / this.view.scale; this.view.cy = wy + (my - this.h / 2) / this.view.scale;
    }, { passive: false });
    c.addEventListener('keydown', (e) => {
      if (e.key === ' ') { e.preventDefault(); this.setWarp(this.warp ? 0 : this.lastWarp || 1); }
      else if (e.key === '.') this.setWarp(this.warp + 1);
      else if (e.key === ',') this.setWarp(this.warp - 1);
      else if (e.key === 'Escape') { if (this.overKind) this.closeOver(); else { this.sel = null; this.renderPanel(); } }
      else if (e.key === 'f' || e.key === 'F') this.fitSystem();
    });
  }

  status() {
    return { left: [{ text: `Prometheus · ${date(this.st?.t || 0)}` }], right: this.st ? [{ text: `${money(this.st.money)} · ${this.st.rp} RP · ${this.st.vessels.length} vessel${this.st.vessels.length === 1 ? '' : 's'}` }] : [] };
  }
  onShow() { this.resize(); }
  destroy() { cancelAnimationFrame(this.raf); this.ro?.disconnect(); clearTimeout(this.saveT); if (this.st) this.save(true); }
}
