// Deep Strike's simulation: the sniffer's flight (finding radars by their emissions) and the strike itself (the
// package flying its route, the network seeing it over the horizon, missiles chasing it, weapons going in).
// Distances in km, altitudes in m, time in seconds of game time.

import { ALTS, SPEEDS, DECK_MAX_KMH, AIRCRAFT, MUNITIONS, SAMS, SNIFFER, ELINT_GAIN, AIRFIELD_RADAR, reach } from './data.js';
import { horizon, dist } from './geo.js';
import { searchRadars, fcRadars, canEngage, alive, isHard, targetXY, targetName, targetHp, isRadar, lower } from './mission.js';

export const DT = 0.5;
const NO_COVER = { see: 1, pk: 1, burn: 1 }; // seconds of game time per step
export const CLIMB = 120, DESCEND = 120; // m/s

/** A radar's numbers. kind 'search' | 'fc'. */
function radarOf(site, kind) {
  if (site.sam) return SAMS[site.sam][kind];
  return kind === 'search' ? AIRFIELD_RADAR : null;
}
/** How far a radar picks up something of rcs m² at alt m (its own reach, the earth's curve, and jamming). */
function seesKm(spec, rcs, alt, jam = 1) {
  return Math.min(horizon(spec.h, alt), spec.km * Math.pow(rcs / 5, 0.25) * jam);
}

class Base {
  constructor(m) {
    this.m = m;
    this.t = 0;
    this.missiles = []; // SAMs in the air
    this.fx = []; // bursts on the map: { x, y, t, kind }
    this.log = [];
    this.done = null;
    this.nid = 0;
    this.site = Object.fromEntries(m.sites.map((s) => [s.id, s]));
  }
  event(text, kind = 'info', at) {
    this.log.push({ t: this.t, text, kind });
    this.onEvent?.({ text, kind, at });
  }
  burst(x, y, kind) { this.fx.push({ x, y, t: this.t, kind }); }
  /** Point the sim at a site's missile: it chases its target as long as the site's radar can still guide it. */
  launch(site, target, n = 1) {
    const S = SAMS[site.sam];
    for (let i = 0; i < n && site.fired < site.missiles; i++) {
      site.fired++;
      this.missiles.push({ id: ++this.nid, site: site.id, target, x: site.x, y: site.y, flown: 0, max: S.missile.km * 1.25, kmh: S.missile.kmh, lost: 0, delay: i * 2 });
    }
    target.engaged = (target.engaged || 0) + n;
  }
  stepMissiles(dt, guided) {
    for (const ms of this.missiles) {
      if (ms.dead) continue;
      if (ms.delay > 0) { ms.delay -= dt; continue; }
      const site = this.site[ms.site], tg = ms.target;
      if (!tg.alive) { ms.dead = true; continue; }
      // command and semi-active guidance: no track from the site's radar for a few seconds and it goes stupid
      if (!guided(site, tg)) ms.lost += dt; else ms.lost = 0;
      if (ms.lost > 4) { ms.dead = true; this.burst(ms.x, ms.y, 'miss'); tg.engaged = Math.max(0, (tg.engaged || 1) - 1); this.missed?.(ms, 'lost its guidance'); continue; }
      const step = (ms.kmh / 3600) * dt;
      const d = Math.hypot(tg.x - ms.x, tg.y - ms.y);
      if (d <= step) {
        ms.dead = true;
        tg.engaged = Math.max(0, (tg.engaged || 1) - 1);
        this.impact(ms, site, tg);
        continue;
      }
      ms.x += ((tg.x - ms.x) / d) * step;
      ms.y += ((tg.y - ms.y) / d) * step;
      ms.flown += step;
      if (ms.flown > ms.max) { ms.dead = true; tg.engaged = Math.max(0, (tg.engaged || 1) - 1); this.burst(ms.x, ms.y, 'miss'); this.missed?.(ms, 'ran out of energy'); }
    }
    if (this.missiles.length > 80) this.missiles = this.missiles.filter((m) => !m.dead);
  }
}

// ================================================================ the sniffer

/** The ELINT flight: steer the sniffer around the network; every radar it hears goes on the map with its type and
 *  reach. Fly into a site's missile range and it shoots. Ends when the sniffer is shot down or back at the origin. */
export class SnifferSim extends Base {
  constructor(m) {
    super(m);
    this.jet = { x: m.origin.x, y: m.origin.y, alt: SNIFFER.m, rcs: SNIFFER.rcs, alive: true, hdg: 0 };
    this.path = [];
    this.flown = 0;
  }
  step(dt = DT) {
    if (this.done) return;
    this.t += dt;
    const j = this.jet;
    if (this.path.length) {
      const p = this.path[0];
      const d = Math.hypot(p.x - j.x, p.y - j.y);
      const step = (SNIFFER.kmh / 3600) * dt;
      j.hdg = Math.atan2(p.y - j.y, p.x - j.x);
      if (d <= step) { j.x = p.x; j.y = p.y; this.path.shift(); this.flown += d; }
      else { j.x += ((p.x - j.x) / d) * step; j.y += ((p.y - j.y) / d) * step; this.flown += step; }
    } else j.hdg += dt * 0.02; // holding
    if (this.rtb && !this.path.length && dist(j, this.m.origin) < 1) {
      this.done = { why: 'home' };
      this.event('The sniffer is back at the origin.', 'good');
      return;
    }
    for (const s of this.m.sites) {
      const d = dist(s, j);
      // hearing it: any working radar whose emissions reach the sniffer
      if (!this.m.known[s.id]) {
        for (const kind of ['search', 'fc']) {
          const spec = radarOf(s, kind);
          if (!spec || !(kind === 'search' ? searchRadars(s) : fcRadars(s)).length) continue;
          if (d <= Math.min(horizon(spec.h, j.alt), spec.km * ELINT_GAIN)) {
            this.m.known[s.id] = true;
            this.event(s.sam ? `New emitter: ${SAMS[s.sam].long} (${spec.name} radar)` : `New emitter: ${spec.name} surveillance radar`, 'info', s);
            break;
          }
        }
      }
      // and being shot at for coming too close
      if (!s.sam || !canEngage(s) || s.fired >= s.missiles) continue;
      const S = SAMS[s.sam];
      if (d <= S.missile.km && j.alt >= S.missile.min && d <= seesKm(S.fc, j.rcs, j.alt) && !(j.engaged > 0) && this.t >= (s.cool || 0)) {
        this.m.known[s.id] = true;
        this.launch(s, j, S.salvo);
        s.cool = this.t + 6;
        this.event(`Missile launch! ${S.long} is firing at the sniffer: turn away and get out of its range.`, 'warn', s);
      }
    }
    this.stepMissiles(dt, (site, tg) => fcRadars(site).length && dist(site, tg) <= seesKm(SAMS[site.sam].fc, tg.rcs, tg.alt));
  }
  impact(ms, site) {
    const j = this.jet;
    if (Math.random() < SNIFFER.pk) {
      j.alive = false;
      this.burst(j.x, j.y, 'kill');
      this.event(`The sniffer was shot down by the ${SAMS[site.sam].long}.`, 'loss', j);
      this.done = { why: 'shot' };
    } else { this.burst(j.x, j.y, 'miss'); this.event(`A ${SAMS[site.sam].name} missile missed the sniffer.`, 'good', j); }
  }
  missed(ms, why) { if (this.jet.alive) this.event(`A ${SAMS[this.site[ms.site].sam].name} missile ${why}.`, 'good'); }
  goTo(p, add) { if (this.done) return; this.rtb = false; if (add) this.path.push(p); else this.path = [p]; }
  home() { this.path = [{ ...this.m.origin }]; this.rtb = true; }
}

// ================================================================ the strike

/** A planned package: [{ type, stations: [{ mu, n, target: {site, idx} | {site} | 'auto' | null }] }]. A route:
 *  [{ x, y, alt, spd, decoys }], starting at the origin; the last leg is the way home. */
export class StrikeSim extends Base {
  constructor(m, pkg, route, terrain = null) {
    super(m);
    this.terrain = terrain; // biomes (terrain.js): hills, forest and water change what a low package shows
    this.route = route.map((p) => ({ ...p }));
    this.leg = 0;
    const p0 = this.route[0];
    this.pos = { x: p0.x, y: p0.y, alt: ALTS[p0.alt].m, kmh: SPEEDS[p0.spd].kmh };
    this.jets = pkg.map((a, i) => ({
      id: i, type: a.type, A: AIRCRAFT[a.type], alive: true, fuel: 0, x: p0.x, y: p0.y, alt: this.pos.alt, rcs: AIRCRAFT[a.type].rcs,
      stations: a.stations.map((s) => ({ ...s })), spent: 0,
    }));
    this.decoys = [];
    this.weapons = []; // ours in the air
    this.alert = false;
    this.used = 0; // $M of munitions let go
    this.lost = [];
    this.decoysOut = false;
    for (const s of m.sites) { s.fired = 0; s.cool = 0; s.readyAt = 0; s.tracking = false; s.awake = false; for (const t of s.targets) { t.dmg = 0; t.harmed = false; } }
  }

  /** Where the package is headed now, and what the current leg asks for. */
  get node() { return this.route[this.leg]; }
  get next() { return this.route[this.leg + 1]; }

  jammed(site) {
    for (const j of this.jets) if (j.alive && j.A.jam && dist(j, site) <= j.A.jam.km) return j.A.jam;
    return null;
  }

  step(dt = DT) {
    if (this.done) return;
    this.t += dt;
    this.fly(dt);
    this.release();
    this.defend(dt);
    this.stepMissiles(dt, (site, tg) => this.tracks(site, tg));
    this.stepWeapons(dt);
    this.stepDecoys(dt);
    const left = this.jets.filter((j) => j.alive);
    if (!left.length) { this.done = { why: 'lost' }; this.event('The whole package is lost.', 'loss'); }
  }

  fly(dt) {
    const p = this.pos, a = this.node, b = this.next;
    if (!b) {
      if (!this.done) { this.done = { why: 'home' }; this.event('The package is home.', 'good'); }
      return;
    }
    const wantAlt = ALTS[a.alt].m;
    p.alt = p.alt < wantAlt ? Math.min(wantAlt, p.alt + CLIMB * dt) : Math.max(wantAlt, p.alt - DESCEND * dt);
    let want = SPEEDS[a.spd].kmh;
    if (p.alt < 400) want = Math.min(want, DECK_MAX_KMH);
    p.kmh += Math.sign(want - p.kmh) * Math.min(Math.abs(want - p.kmh), 20 * dt);
    let step = (p.kmh / 3600) * dt;
    const band = ALTS[a.alt].burn * SPEEDS[a.spd].burn * this.cover(p).burn;
    for (const j of this.jets) if (j.alive) {
      j.fuel += (step * band) / j.A.range;
      if (j.fuel >= 1) { j.alive = false; this.lost.push({ jet: j, why: 'fuel' }); this.event(`${j.A.name} ran out of fuel; the crew ejected.`, 'loss', p); }
    }
    while (step > 0 && this.next) {
      const n = this.next;
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d <= step) { p.x = n.x; p.y = n.y; step -= d; this.leg++; if (this.next) this.onLeg?.(this.leg); }
      else { p.x += ((n.x - p.x) / d) * step; p.y += ((n.y - p.y) / d) * step; step = 0; }
    }
    p.hdg = this.next ? Math.atan2(this.next.y - p.y, this.next.x - p.x) : p.hdg;
    // the jets keep a loose formation around the package's point
    const cos = Math.cos(p.hdg || 0), sin = Math.sin(p.hdg || 0);
    this.jets.forEach((j, i) => {
      if (!j.alive) return;
      const row = Math.floor((i + 1) / 2), side = i === 0 ? 0 : i % 2 ? 1 : -1;
      const back = row * 1.4, off = side * row * 1.2;
      j.x = p.x - cos * back - sin * off; j.y = p.y - sin * back + cos * off;
      j.alt = this.terrain ? this.terrain.skimAlt(j.x, j.y, p.alt) : p.alt; // deck over water: sea-skimming
    });
    // decoys go when the route says so
    if (a.decoys && !this.decoysOut) this.launchDecoys();
  }

  /** Every MALD in the package goes out toward the objective. */
  launchDecoys() {
    this.decoysOut = true;
    const goal = this.site[this.m.primary];
    let n = 0;
    for (const j of this.jets) if (j.alive) for (const st of j.stations) {
      if (st.mu !== 'mald' || !st.n) continue;
      for (let k = 0; k < st.n; k++) {
        const spread = (this.decoys.length % 5 - 2) * 0.12;
        const ang = Math.atan2(goal.y - j.y, goal.x - j.x) + spread;
        this.decoys.push({ id: ++this.nid, x: j.x, y: j.y, alt: 4500, rcs: 3, alive: true, hdg: ang, flown: 0, decoy: true });
        n++;
      }
      this.used += MUNITIONS.mald.cost * st.n;
      st.n = 0;
    }
    if (n) this.event(`${n} decoy${n === 1 ? '' : 's'} launched.`, 'info', this.pos);
  }

  stepDecoys(dt) {
    for (const d of this.decoys) {
      if (!d.alive) continue;
      const step = (MUNITIONS.mald.kmh / 3600) * dt;
      d.x += Math.cos(d.hdg) * step; d.y += Math.sin(d.hdg) * step; d.flown += step;
      if (d.flown > MUNITIONS.mald.hi) d.alive = false;
    }
  }

  /** What the ground under something low does for it (terrain.js); decoys fly high and get nothing. */
  cover(tg) { return this.terrain && !tg.decoy ? this.terrain.effect(tg.x, tg.y, tg.alt) : NO_COVER; }

  /** Can this site's guidance radar hold this target right now? */
  tracks(site, tg) {
    if (!site.sam || !fcRadars(site).length) return false;
    const jam = this.jammed(site);
    return dist(site, tg) <= seesKm(SAMS[site.sam].fc, tg.rcs, tg.alt, (jam ? jam.factor : 1) * this.cover(tg).see);
  }

  /** The network: search radars look, the alarm goes round, sites in range shoot. */
  defend(dt) {
    const targets = [...this.jets.filter((j) => j.alive), ...this.decoys.filter((d) => d.alive)];
    for (const s of this.m.sites) {
      const S = s.sam ? SAMS[s.sam] : null;
      const quiet = S?.quiet && !this.alert;
      s.awake = !quiet && searchRadars(s).length > 0;
      if (s.awake && !this.alert) {
        const spec = radarOf(s, 'search');
        const jam = this.jammed(s);
        const seen = spec && targets.find((tg) => dist(s, tg) <= seesKm(spec, tg.rcs, tg.alt, (jam ? jam.factor : 1) * this.cover(tg).see));
        if (seen) {
          this.alert = true;
          this.event(`Detected by the ${S ? S.long + ' ' : ''}${spec.name} radar${s.sam ? '' : ' at ' + s.name}. The defences are awake.`, 'warn', s);
        }
      }
      s.tracking = false;
      if (!S || !this.alert || !canEngage(s)) continue;
      // who it can shoot: in missile range, high enough, held by its radar; one not already being shot at first
      let best = null, bd = Infinity;
      for (const tg of targets) {
        const d = dist(s, tg);
        if (d > S.missile.km * 1.05 || tg.alt < S.missile.min || !this.tracks(s, tg)) continue;
        s.tracking = true;
        if ((tg.engaged || 0) >= 2) continue; // two missiles on one jet is plenty: the rest look for another
        const score = d + (tg.engaged ? 400 : 0);
        if (score < bd) { bd = score; best = tg; }
      }
      // the first time it has someone to shoot: its crew needs a while to get a firing solution
      if (best && !s.readyAt) s.readyAt = this.t + (S.ring === 'long' ? 25 : S.ring === 'medium' ? 12 : 6);
      if (best && this.t < s.readyAt) continue;
      if (!best || this.t < (s.cool || 0) || (best.engaged && bd > 400 && this.inFlight(s) >= S.ch)) continue;
      if (this.inFlight(s) >= S.ch * S.salvo) continue;
      if (!this.m.known[s.id]) { this.m.known[s.id] = true; this.event(`Pop-up threat: a ${S.long} nobody had found.`, 'warn', s); }
      this.launch(s, best, S.salvo);
      s.cool = this.t + (S.ring === 'short' ? 4 : S.ring === 'medium' ? 6 : 8);
      this.event(`${S.long} launch at ${best.decoy ? 'a contact' : 'the package'}.`, 'warn', s);
      if (!this.decoysOut && this.jets.some((j) => j.alive && j.stations.some((st) => st.mu === 'mald' && st.n))) this.launchDecoys();
    }
  }
  inFlight(s) { return this.missiles.filter((m) => !m.dead && m.site === s.id).length; }

  impact(ms, site, tg) {
    const S = SAMS[site.sam];
    if (tg.decoy) {
      if (Math.random() < 0.9) { tg.alive = false; this.burst(tg.x, tg.y, 'decoy'); this.event(`A decoy soaked up a ${S.name} missile.`, 'good', tg); }
      else this.burst(tg.x, tg.y, 'miss');
      return;
    }
    const a = this.node;
    const jam = this.jammed(site);
    let pk = S.missile.pk * SPEEDS[a.spd].pk * (1 - tg.A.ecm) * (1 - tg.A.cm) * (jam ? jam.pk : 1);
    // down low the ground clutters the radar picture (and there are hills the game doesn't draw); big long-range
    // systems are built for high targets and suffer most
    if (tg.alt < 600) pk *= (tg.alt < 120 ? 0.5 : 0.75) * (S.ring === 'long' ? 0.7 : 1);
    pk *= this.cover(tg).pk;
    if (Math.random() < pk) {
      tg.alive = false;
      this.lost.push({ jet: tg, why: S.long });
      this.burst(tg.x, tg.y, 'kill');
      this.event(`${tg.A.name} shot down by a ${S.long}.`, 'loss', tg);
    } else { this.burst(tg.x, tg.y, 'miss'); this.event(`A ${S.name} missile missed (${tg.A.name} defended).`, 'good', tg); }
  }
  missed(ms, why) { this.event(`A ${SAMS[this.site[ms.site].sam].name} missile ${why}.`, 'good'); }

  /** Is this radar on the air now (for HARMs)? */
  emitting(site, t) {
    if (!alive(t) || !isRadar(t)) return false;
    if (t.k === 'search' || t.k === 'tlar') return site.awake || (site.tracking && t.k === 'tlar');
    return site.tracking; // engagement radars only light up to shoot
  }

  /** Let go of weapons whose targets are within reach. */
  release() {
    const p = this.pos;
    for (const j of this.jets) {
      if (!j.alive) continue;
      for (const st of j.stations) {
        if (!st.n || st.mu === 'mald') continue;
        const mu = MUNITIONS[st.mu];
        const R = reach(mu, p.alt);
        if (mu.kind === 'arm') {
          // HARMs: at the radar they were given, or (auto) at whichever radar is on and shooting first
          const radars = [];
          for (const s of this.m.sites) {
            if (st.target && st.target !== 'auto' && st.target.site !== s.id) continue;
            for (const t of s.targets) {
              if (!this.emitting(s, t) || t.harmed) continue;
              const at = targetXY(s, t);
              const d = dist(at, j);
              if (d <= R) radars.push({ s, t, at, d: d - (t.k === 'fc' || t.k === 'telar' || t.k === 'tlar' ? 200 : 0) });
            }
          }
          radars.sort((x, y) => x.d - y.d);
          if (radars[0]) { const { s, t, at } = radars[0]; t.harmed = true; this.fire(j, st, mu, s, t, at, 1); }
          continue;
        }
        if (!st.target || st.target === 'auto') continue;
        const s = this.site[st.target.site], t = s?.targets[st.target.idx];
        if (!t || !alive(t)) continue;
        const at = targetXY(s, t);
        if (dist(at, j) <= R) this.fire(j, st, mu, s, t, at, st.n);
      }
    }
  }

  fire(j, st, mu, s, t, at, n) {
    for (let k = 0; k < n; k++) {
      this.weapons.push({ id: ++this.nid, mu: mu.id, x: j.x, y: j.y, tx: at.x, ty: at.y, site: s.id, t, delay: k * 0.6, alt: j.alt });
    }
    st.n -= n;
    this.used += mu.cost * n;
    this.event(`${j.A.name}: ${n > 1 ? n + '× ' : ''}${mu.short} away at the ${lower(targetName(t))} (${s.name.replace(/ site .*/, ' site')}).`, 'info', at);
  }

  stepWeapons(dt) {
    for (const w of this.weapons) {
      if (w.dead) continue;
      if (w.delay > 0) { w.delay -= dt; continue; }
      const mu = MUNITIONS[w.mu];
      const step = (mu.kmh / 3600) * dt;
      const d = Math.hypot(w.tx - w.x, w.ty - w.y);
      // point defence gets one go at it on the way in, from the closest site that's awake and has missiles
      if (!w.tried && d < 18) {
        w.tried = true;
        const pd = this.m.sites.filter((s) => s.sam && SAMS[s.sam].pd && this.alert && canEngage(s) && Math.hypot(s.x - w.tx, s.y - w.ty) <= SAMS[s.sam].missile.km)
          .sort((a, b) => Math.hypot(a.x - w.tx, a.y - w.ty) - Math.hypot(b.x - w.tx, b.y - w.ty))[0];
        if (pd) {
          pd.fired++;
          if (!this.m.known[pd.id]) this.m.known[pd.id] = true;
          if (Math.random() < SAMS[pd.sam].pd * mu.pd * 1.6) {
            w.dead = true;
            this.burst(w.x, w.y, 'pd');
            this.event(`${SAMS[pd.sam].long} shot down a ${mu.short}.`, 'warn', w);
            continue;
          }
        }
      }
      if (d <= step) { w.dead = true; this.hit(w, mu); continue; }
      w.x += ((w.tx - w.x) / d) * step; w.y += ((w.ty - w.y) / d) * step;
    }
    if (this.weapons.length > 200) this.weapons = this.weapons.filter((w) => !w.dead);
  }

  hit(w, mu) {
    const s = this.site[w.site], t = w.t;
    if (mu.kind === 'arm') t.harmed = false;
    let p = 0.92;
    if (mu.kind === 'arm' && !this.emitting(s, t)) p = 0.45; // it shut down: going for where it was
    if (!alive(t) || Math.random() > p) { this.burst(w.tx, w.ty, 'dud'); return; }
    const was = alive(t);
    t.dmg = (t.dmg || 0) + (isHard(t) ? mu.dmg : mu.soft);
    this.burst(w.tx, w.ty, 'hit');
    if (was && !alive(t)) {
      const obj = this.m.objective.site === s.id && s.targets[this.m.objective.idx] === t;
      this.event(`${obj ? 'OBJECTIVE DESTROYED: ' : 'Destroyed: '}${targetName(t)} at ${s.name}.`, obj ? 'objective' : 'kill', w);
    } else if (t.k === 'runway') this.event(`Runway hit: ${Math.min(100, Math.round(((t.dmg || 0) / targetHp(t)) * 100))}% closed.`, 'kill', w);
  }

  objectiveDone() {
    const s = this.site[this.m.objective.site];
    return !alive(s.targets[this.m.objective.idx]);
  }

  /** The way home from where the package is (for RTB): straight back to the origin. */
  rtb() {
    this.route = [...this.route.slice(0, this.leg + 1), { x: this.pos.x, y: this.pos.y, alt: this.node.alt, spd: this.node.spd }, { ...this.route[this.route.length - 1] }];
    this.leg++;
  }
}
