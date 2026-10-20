// Deep Strike's simulation: the sniffer's flight (finding radars by their emissions) and the strike itself (the
// package flying its route, the network seeing it over the horizon, missiles chasing it, weapons going in).
// Distances in km, altitudes in m, time in seconds of game time.

import { ALTS, SPEEDS, DECK_MAX_KMH, AIRCRAFT, MUNITIONS, SAMS, SNIFFER, ELINT_GAIN, AIRFIELD_RADAR, FIGHTERS, R77, RWR_GAIN, SHIPS, TLAM, reach, aamReach, packageKmh, homes, fuelCap, tanksOn } from './data.js';
import { horizon, dist, zoneAt, doseRate } from './geo.js';
import { searchRadars, fcRadars, canEngage, alive, isHard, targetXY, targetName, targetHp, isRadar, lower, objectivesOf, objectiveNo, headless, SMART_RIPPLE, smartTier, smartFits } from './mission.js';

export const DT = 0.5;
/** How close a polyline [{x, y}] comes to a point (km). */
function routeDist(pts, p) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1] || a, dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    const u = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(a.x + dx * u - p.x, a.y + dy * u - p.y));
  }
  return best;
}
/** How many Tomahawks each part of a site still standing takes to destroy: [[target, n]]. */
export const salvoPlan = (site) => site.targets.filter(alive).map((t) => [t, Math.ceil(Math.max(0, targetHp(t) - (t.dmg || 0)) / (isHard(t) ? TLAM.dmg : TLAM.soft) - 1e-9)]);
const NO_COVER = { see: 1, pk: 1, burn: 1 }; // seconds of game time per step
export const CLIMB = 120, DESCEND = 120; // m/s at Cruise; faster jets climb and descend faster, the same height per km
/** Climb or descent rate (m/s) at a speed: in step with it, so a faster leg reaches its height at the same point. */
export const climbRate = (base, kmh) => (base * kmh) / 850;

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
  /** A crew's radiation (who.rad, 1 = dead) after dt more at p: logs going into a zone and the last two minutes.
   *  True once it's lethal. */
  dose(who, p, dt, name) {
    const z = zoneAt(this.m.zones, p.x, p.y);
    if (!z) { who.inZone = null; return false; }
    const was = who.rad || 0, rate = doseRate(z);
    who.rad = was + rate * dt;
    const left = (1 - who.rad) / rate, what = z.storm ? 'a radiation storm' : 'a dead zone';
    if (who.inZone !== z && who.rad < 1) this.event(`${name} is in ${what}: ${Math.ceil(left / 60)} min until it kills the crew${was > 0.005 ? ` (with the ${Math.round(was * 100)}% dose already taken)` : ''}.`, 'warn', p);
    else if ((1 - was) / rate > 120 && left <= 120) this.event(`${name}: 2 minutes of radiation left. Get out of ${what}.`, 'warn', p);
    who.inZone = z;
    return who.rad >= 1;
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
      this.samShots = (this.samShots || 0) + 1; // for the badges
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
    if (this.dose(j, j, dt, 'The sniffer')) {
      j.alive = false;
      this.burst(j.x, j.y, 'kill');
      this.event('The sniffer’s crew died of radiation.', 'loss', j);
      this.done = { why: 'rad' };
      return;
    }
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
    // enemy fighters on patrol: their radars give them away (roughly where, and what)
    for (const c of this.m.cap || []) {
      if (c.heard || dist(c, j) > FIGHTERS[c.type].radar.km * ELINT_GAIN) continue;
      c.heard = true;
      this.event(`Fighter radars: ${c.n}× ${FIGHTERS[c.type].name} on patrol, marked roughly on the map.`, 'warn', c);
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
 *  [{ x, y, alt, spd, decoys }], starting at the origin; the last leg is the way home. Up to two packages (A and B)
 *  fly at once, each its own route; one with no jets stays home. Ships: [{ id, type, x, y, tlam, sm, salvos: [{ site, t }] }]
 *  (the fleet deployed for it): their missiles go at enemy fighters, their Tomahawk salvos at whole sites. */
export class StrikeSim extends Base {
  constructor(m, pkg, route, terrain = null, pkg2 = [], route2 = null, ships = []) {
    super(m);
    this.terrain = terrain; // biomes (terrain.js): hills, forest and water change what a low package shows
    this.flights = [];
    this.jets = [];
    [[pkg, route], [pkg2, route2]].forEach(([pk, rt], k) => {
      if (!pk?.length || !rt || rt.length < 2) return;
      const r = rt.map((p) => ({ ...p })), p0 = r[0];
      const f = { k, name: 'AB'[k], route: r, leg: 0, decoysOut: false, done: null,
        pos: { x: p0.x, y: p0.y, alt: ALTS[p0.alt].m, kmh: packageKmh(pk.map((a) => a.type), p0.spd) } };
      f.jets = pk.map((a) => ({
        id: this.jets.length, f, type: a.type, A: AIRCRAFT[a.type], nm: `${AIRCRAFT[a.type].name} (package ${f.name})`, alive: true, fuel: 0, x: p0.x, y: p0.y, alt: f.pos.alt, rcs: AIRCRAFT[a.type].rcs,
        stations: a.stations.map((s) => ({ ...s })), spent: 0, cap: fuelCap(a.type, a.stations), // drop tanks: more fuel, burned first
      }));
      this.jets.push(...f.jets);
      this.flights.push(f);
    });
    this.decoys = [];
    this.weapons = []; // ours in the air
    this.alert = false;
    this.used = 0; // $M of munitions let go
    this.lost = [];
    this.aams = []; // air-to-air missiles in the air, both sides'
    this.rwrHeard = new Set(); // patrols whose radars our jets have already reported
    // enemy fighters: two to a patrol, orbiting until the alarm goes or their own radar finds someone
    this.bandits = (m.cap || []).flatMap((c) => Array.from({ length: c.n }, (_, i) => ({
      id: ++this.nid, cap: c, F: FIGHTERS[c.type], alive: true, x: c.x, y: c.y, alt: 9000, a: i * Math.PI, hdg: 0, state: 'cap',
      missiles: FIGHTERS[c.type].missiles, cool: 0, rcs: FIGHTERS[c.type].rcs, seen: false })));
    this.ships = ships.map((sh, i) => ({ ...sh, S: SHIPS[sh.type], nm: sh.nm || `${SHIPS[sh.type].short} ${i + 1}`, alt: 0, alive: true, cool: 0, used: { tlam: 0, sm: 0 },
      salvos: (sh.salvos || []).map((sv) => ({ ...sv, fired: false })) }));
    for (const s of m.sites) { s.fired = 0; s.cool = 0; s.readyAt = 0; s.tracking = false; s.awake = false; for (const t of s.targets) { t.dmg = 0; t.harmed = false; } }
  }

  /** The flight flying package k (0 = A, 1 = B), if it flies. */
  flight(k) { return this.flights.find((f) => f.k === k) || null; }
  /** "The package" with one flying, "Package A" with two. */
  pkgName(f) { return this.flights.length > 1 ? `Package ${f.name}` : 'The package'; }

  jammed(site) {
    for (const j of this.jets) if (j.alive && j.A.jam && dist(j, site) <= j.A.jam.km) return j.A.jam;
    return null;
  }

  /** Is this site blinded by an NGJ pod? Once a pod's Growler gets within reach it stays blind until that Growler is lost. */
  blinded(site) {
    return this.jets.some((j) => j.alive && j.stations.some((st) => st.mu === 'pod' && st.locked && st.target?.site === site.id));
  }

  /** NGJ pods: lock on when their Growler gets within reach; let go (with a word in the log) when it's lost. */
  jamPods() {
    for (const j of this.jets) for (const st of j.stations) {
      if (st.mu !== 'pod' || !st.target?.site) continue;
      const s = this.site[st.target.site];
      if (!s) continue;
      const name = s.sam ? `${SAMS[s.sam].long} site` : s.name;
      if (j.alive && !st.locked && dist(j, s) <= MUNITIONS.pod.km) {
        st.locked = true;
        this.event(`The NGJ pod on the ${j.nm} blinds the ${name}: its radars see nothing while the Growler flies.`, 'good', s);
      } else if (!j.alive && st.locked && !st.freed) {
        st.freed = true;
        if (!this.blinded(s)) this.event(`The ${name} can see again: the Growler jamming it is gone.`, 'warn', s);
      }
    }
  }

  step(dt = DT) {
    if (this.done) return;
    this.t += dt;
    this.fly(dt);
    this.jamPods();
    this.release();
    this.salvos();
    this.defend(dt);
    this.intercept(dt);
    this.airToAir();
    this.stepAams(dt);
    this.stepMissiles(dt, (site, tg) => this.tracks(site, tg));
    this.stepWeapons(dt);
    this.stepDecoys(dt);
    for (const f of this.flights) if (!f.done && !f.jets.some((j) => j.alive)) { f.done = { why: 'lost' }; this.event(`${this.pkgName(f)} is lost${this.flights.length > 1 ? '' : ', all of it'}.`, 'loss'); }
    // over once every package is home or lost, every planned salvo has gone and the weapons still in the air have come down
    const waiting = this.ships.some((sh) => sh.tlam > 0 && sh.salvos.some((sv) => !sv.fired));
    if (this.flights.every((f) => f.done) && !waiting && !this.weapons.some((w) => !w.dead)) this.done = { why: !this.flights.length || this.flights.some((f) => f.done.why === 'home') ? 'home' : 'lost' };
  }

  fly(dt) { for (const f of this.flights) if (!f.done) this.flyFlight(f, dt); }

  flyFlight(f, dt) {
    const p = f.pos, a = f.route[f.leg], b = f.route[f.leg + 1];
    if (!b) { f.done = { why: 'home' }; this.event(`${this.pkgName(f)} is home.`, 'good'); return; }
    const wantAlt = ALTS[a.alt].m;
    p.alt = p.alt < wantAlt ? Math.min(wantAlt, p.alt + climbRate(CLIMB, p.kmh) * dt) : Math.max(wantAlt, p.alt - climbRate(DESCEND, p.kmh) * dt);
    let want = packageKmh(f.jets.filter((j) => j.alive).map((j) => j.type), a.spd); // the slowest jet still flying sets the pace
    if (p.alt < 400) want = Math.min(want, DECK_MAX_KMH);
    p.kmh += Math.sign(want - p.kmh) * Math.min(Math.abs(want - p.kmh), 20 * dt);
    let step = (p.kmh / 3600) * dt;
    const band = ALTS[a.alt].burn * SPEEDS[a.spd].burn * this.cover(p).burn;
    for (const j of f.jets) if (j.alive) {
      j.fuel += (step * band) / (j.A.range * j.cap);
      if (j.cap > 1 && !j.dropped && j.fuel >= (j.cap - 1) / j.cap) {
        j.dropped = true;
        const n = tanksOn(j.stations);
        for (const st of j.stations) if (st.mu === 'tank') st.n = 0;
        this.used += MUNITIONS.tank.cost * n;
        this.event(`${j.nm} drops ${n > 1 ? 'its empty tanks' : 'its empty tank'}.`, 'info', j);
      }
      if (j.fuel >= 1) { j.alive = false; this.lost.push({ jet: j, why: 'fuel' }); this.event(`${j.nm} ran out of fuel; the crew ejected.`, 'loss', p); }
    }
    while (step > 0 && f.route[f.leg + 1]) {
      const n = f.route[f.leg + 1];
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d <= step) { p.x = n.x; p.y = n.y; step -= d; f.leg++; if (f.route[f.leg + 1]) this.onLeg?.(f.leg, f); }
      else { p.x += ((n.x - p.x) / d) * step; p.y += ((n.y - p.y) / d) * step; step = 0; }
    }
    const nx = f.route[f.leg + 1];
    p.hdg = nx ? Math.atan2(nx.y - p.y, nx.x - p.x) : p.hdg;
    // the jets keep a loose formation around the package's point
    const cos = Math.cos(p.hdg || 0), sin = Math.sin(p.hdg || 0);
    f.jets.forEach((j, i) => {
      if (!j.alive) return;
      const row = Math.floor((i + 1) / 2), side = i === 0 ? 0 : i % 2 ? 1 : -1;
      const back = row * 1.4, off = side * row * 1.2;
      j.x = p.x - cos * back - sin * off; j.y = p.y - sin * back + cos * off;
      j.alt = this.terrain ? this.terrain.skimAlt(j.x, j.y, p.alt) : p.alt; // deck over water: sea-skimming
    });
    // dead zones and radiation storms: the whole package soaks it together, and a lethal dose kills every crew
    if (this.dose(f, p, dt, this.pkgName(f))) for (const j of f.jets) if (j.alive) {
      j.alive = false;
      this.burst(j.x, j.y, 'kill');
      this.lost.push({ jet: j, why: 'radiation' });
      this.event(`${j.nm}: the crew died of radiation.`, 'loss', j);
    }
    // decoys go when the route says so
    if (a.decoys && !f.decoysOut) this.launchDecoys(f);
  }

  /** Every MALD in a package goes out toward the objective. */
  launchDecoys(f) {
    f.decoysOut = true;
    const goal = this.site[this.m.primary];
    let n = 0;
    for (const j of f.jets) if (j.alive) for (const st of j.stations) {
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
    if (n) this.event(`${n} decoy${n === 1 ? '' : 's'} launched${this.flights.length > 1 ? ` from package ${f.name}` : ''}.`, 'info', f.pos);
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
    if (!site.sam || !fcRadars(site).length || this.blinded(site)) return false;
    const jam = this.jammed(site);
    return dist(site, this.where(tg)) <= seesKm(SAMS[site.sam].fc, tg.rcs, tg.alt, (jam ? jam.factor : 1) * this.cover(tg).see);
  }

  /** Where the defences measure a target from: a jet counts as being on the route (the package's point), not wherever
   *  its place in the formation puts it; a decoy is where it is. So the line you drew is what crosses a ring. */
  where(tg) { return tg.decoy ? tg : tg.f.pos; }

  /** The network: search radars look, the alarm goes round, sites in range shoot. */
  defend(dt) {
    const targets = [...this.jets.filter((j) => j.alive), ...this.decoys.filter((d) => d.alive)];
    for (const s of this.m.sites) {
      const S = s.sam ? SAMS[s.sam] : null;
      const quiet = S?.quiet && !this.alert;
      if (this.blinded(s)) { s.awake = false; s.tracking = false; continue; } // NGJ: sees nothing, shoots nothing
      s.awake = !quiet && searchRadars(s).length > 0;
      if (!this.m.known[s.id] && (s.awake || s.tracking)) this.rwr(s);
      if (s.awake && !this.alert) {
        const spec = radarOf(s, 'search');
        const jam = this.jammed(s);
        const seen = spec && targets.find((tg) => dist(s, this.where(tg)) <= seesKm(spec, tg.rcs, tg.alt, (jam ? jam.factor : 1) * this.cover(tg).see));
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
        const d = dist(s, this.where(tg));
        if (d > S.missile.km || tg.alt < S.missile.min || !this.tracks(s, tg)) continue;
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
      this.event(`${S.long} launch at ${best.decoy ? 'a contact' : this.flights.length > 1 ? `package ${best.f.name}` : 'the package'}.`, 'warn', s);
      const bf = best.f;
      if (bf && !bf.decoysOut && bf.jets.some((j) => j.alive && j.stations.some((st) => st.mu === 'mald' && st.n))) this.launchDecoys(bf);
    }
  }
  inFlight(s) { return this.missiles.filter((m) => !m.dead && m.site === s.id).length; }

  /** Radar warning receivers: a radar on the air whose energy reaches one of our jets puts its site on the map, even
   *  one the sniffer never heard (a quiet Buk, Tor or Pantsir only once it switches on). */
  rwr(s) {
    for (const kind of ['search', 'fc']) {
      if (kind === 'fc' ? !s.tracking : !s.awake) continue;
      const spec = radarOf(s, kind);
      if (!spec || !(kind === 'search' ? searchRadars(s) : fcRadars(s)).length) continue;
      const j = this.jets.find((x) => x.alive && dist(s, x) <= Math.min(horizon(spec.h, x.alt), spec.km * RWR_GAIN));
      if (!j) continue;
      this.m.known[s.id] = true;
      this.event(`RWR: ${s.sam ? `${SAMS[s.sam].long} (${spec.name} radar)` : `${spec.name} surveillance radar at ${s.name}`} painting ${this.flights.length > 1 ? `package ${j.f.name}` : 'the package'}. Marked on the map.`, 'warn', s);
      return;
    }
  }

  // ---- enemy fighters

  /** Can this fighter's radar see one of our jets? Looking down at a low one, the ground clutters it. */
  banditSees(b, j) {
    const jam = this.jammed(b), look = j.alt < 600 ? 0.6 : 1;
    return dist(b, this.where(j)) <= b.F.radar.km * Math.pow(j.rcs / 5, 0.25) * (jam ? jam.factor : 1) * look * this.cover(j).see;
  }
  /** Can our jet's radar hold this fighter? */
  jetSees(j, b) { return !!j.A.radar && dist(j, b) <= j.A.radar.km * Math.pow(b.rcs / 5, 0.25); }
  /** Can a ship's radar hold this fighter (the earth's curve hides a low one)? */
  shipSees(sh, b) { const R = sh.S.radar; return dist(sh, b) <= Math.min(horizon(R.h, b.alt), R.km * Math.pow(b.rcs / 5, 0.25)); }

  // ---- the fleet's Tomahawks

  /** Planned salvos whose time has come. */
  salvos() {
    for (const sh of this.ships) for (const sv of sh.salvos) if (!sv.fired && this.t >= sv.t) { sv.fired = true; this.salvo(sh, sv.site); }
  }

  /** A ship's salvo at a site: enough at every part of it still standing to destroy it, as far as the cells go. */
  salvo(sh, siteId) {
    const s = this.site[siteId];
    if (!s) return 0;
    let n = 0;
    for (const [t, k] of salvoPlan(s)) {
      const at = targetXY(s, t);
      for (let i = 0; i < k && sh.tlam > 0; i++, n++) {
        sh.tlam--; sh.used.tlam++;
        this.weapons.push({ id: ++this.nid, mu: 'tlam', ship: sh.id, x: sh.x, y: sh.y, tx: at.x, ty: at.y, site: s.id, t, delay: n * 0.2, alt: 60 }); // close together, to swamp the point defences
      }
    }
    const name = s.sam ? `${SAMS[s.sam].long} site` : s.name;
    if (n) this.event(`${sh.nm}: ${n} TLAM${n === 1 ? '' : 's'} away at the ${name}${sh.tlam ? '' : ' (its last)'}.`, 'info', s);
    else this.event(sh.tlam ? `${sh.nm}: nothing left standing at the ${name}, so the salvo stays in its cells.` : `${sh.nm} has no Tomahawks left for the ${name}.`, 'warn', s);
    return n;
  }

  /** Fire a salvo now (from the strike's panel). */
  fireSalvo(id, siteId) { const sh = this.ships.find((x) => x.id === id); return sh ? this.salvo(sh, siteId) : 0; }

  /** The patrols: orbit until the alarm goes (or their radar finds someone), then run at the nearest jet of ours;
   *  back to the patrol point once out of missiles or after 15 minutes of chasing. */
  intercept(dt) {
    const ours = this.jets.filter((j) => j.alive);
    for (const b of this.bandits) {
      if (!b.alive) continue;
      const c = b.cap;
      if (b.state === 'cap' && b.missiles && (this.alert || ours.some((j) => this.banditSees(b, j)))) { b.state = 'hunt'; b.huntT = this.t; }
      if (b.state === 'hunt' && (!b.missiles || this.t - b.huntT > 900 || !ours.length)) b.state = 'home';
      let goal = null, kmh = b.F.kmh.dash;
      if (b.state === 'hunt') goal = ours.reduce((x, j) => (dist(j, b) < dist(x, b) ? j : x));
      else if (b.state === 'home' && dist(b, c) > 30) goal = c;
      if (!goal) { // orbiting, 25 km out
        kmh = b.F.kmh.cap;
        b.a += ((kmh / 3600) * dt) / 25;
        goal = { x: c.x + Math.cos(b.a) * 25, y: c.y + Math.sin(b.a) * 25 };
      }
      const d = dist(goal, b), step = (kmh / 3600) * dt;
      b.hdg = Math.atan2(goal.y - b.y, goal.x - b.x);
      if (d <= step) { b.x = goal.x; b.y = goal.y; } else { b.x += Math.cos(b.hdg) * step; b.y += Math.sin(b.hdg) * step; }
    }
  }

  /** Air-to-air shots, both ways. Theirs: an R-77-1 at a jet their radar holds, two in the air at a time. Ours: an AMRAAM at a fighter our
   *  jet's radar holds within reach, or an AIM-9X at one close enough to see. Two missiles at most on one target. */
  airToAir() {
    const live = this.bandits.filter((b) => b.alive);
    if (!live.length) return;
    const ours = this.jets.filter((j) => j.alive), pkg = (j) => (this.flights.length > 1 ? `package ${j.f.name}` : 'the package');
    for (const b of live) {
      const held = ours.filter((j) => this.banditSees(b, j));
      if (!held.length) continue;
      b.seen = true; // our warning receivers hear its radar
      if (!this.rwrHeard.has(b.cap.id)) { this.rwrHeard.add(b.cap.id); this.event(`RWR: ${b.F.name} radar painting ${pkg(held[0])}.`, 'warn', b); }
      if (!this.alert) { this.alert = true; this.event(`Seen by enemy fighters. The defences are awake.`, 'warn', b); }
      // two of its own in the air at most, as our jets get two at a fighter: then it waits for them to land or miss
      if (!b.missiles || this.t < b.cool || this.aams.filter((a) => !a.dead && a.from === b).length >= 2) continue;
      const rk = (j) => aamReach(R77, b.alt, j.alt, b.F.kmh.cap);
      const tg = held.filter((j) => (j.engaged || 0) < 2 && dist(b, j) <= rk(j)).sort((x, y) => dist(b, x) - dist(b, y))[0];
      if (!tg) continue;
      b.missiles--; b.cool = this.t + 6;
      this.aams.push({ id: ++this.nid, red: true, from: b, target: tg, x: b.x, y: b.y, kmh: R77.kmh, max: rk(tg) * 1.3, flown: 0, lost: 0, pitbull: R77.pitbull, pk: R77.pk, name: R77.name });
      tg.engaged = (tg.engaged || 0) + 1;
      this.event(`${b.F.name} fires an ${R77.name} at the ${tg.nm}.`, 'warn', b);
    }
    for (const b of live) if (!b.seen && (ours.some((j) => this.jetSees(j, b)) || this.ships.some((sh) => this.shipSees(sh, b)))) {
      b.seen = true;
      this.event(`Radar contact: ${b.F.name}.`, 'warn', b);
    }
    // the ships: Standard missiles at fighters within reach, once the defences are awake or the fighters are hunting
    // (so a patrol chasing the package across a ship gets shot at); one every few seconds, only so many guided at once
    for (const sh of this.ships) {
      if (!sh.sm || this.t < sh.cool || this.aams.filter((a) => !a.dead && a.from === sh).length >= sh.S.ch) continue;
      const M = sh.S.missile;
      const tg = live.filter((b) => b.alive && (this.alert || b.state !== 'cap') && (b.engaged || 0) < 2 && dist(sh, b) <= M.km && this.shipSees(sh, b))
        .sort((x, y) => dist(sh, x) - dist(sh, y))[0];
      if (!tg) continue;
      sh.sm--; sh.used.sm++; sh.cool = this.t + 3;
      tg.seen = true;
      this.aams.push({ id: ++this.nid, red: false, ship: true, from: sh, target: tg, x: sh.x, y: sh.y, kmh: M.kmh, max: M.km * 1.3, flown: 0, lost: 0, pitbull: M.pitbull, pk: M.pk, name: M.name });
      tg.engaged = (tg.engaged || 0) + 1;
      this.event(`${sh.nm}: ${M.name} away at an ${tg.F.name}.`, 'info', tg);
    }
    for (const j of ours) {
      if (this.t < (j.aamCool || 0)) continue;
      for (const st of j.stations) {
        const mu = st.n && MUNITIONS[st.mu];
        if (!mu || mu.kind !== 'aam') continue;
        const R = (b) => aamReach(mu, j.alt, b.alt, j.f.pos.kmh);
        const tg = live.filter((b) => b.alive && (b.engaged || 0) < 2 && dist(j, b) <= R(b) && (this.jetSees(j, b) || (mu.ir && dist(j, b) <= 15)))
          .sort((x, y) => dist(j, x) - dist(j, y))[0];
        if (!tg) continue;
        st.n--; this.used += mu.cost; j.aamCool = this.t + 3;
        tg.seen = true;
        this.aams.push({ id: ++this.nid, red: false, from: j, target: tg, x: j.x, y: j.y, kmh: mu.kmh, max: R(tg) * 1.3, flown: 0, lost: 0, pitbull: mu.ir ? Infinity : mu.pitbull, pk: mu.pk, name: mu.short });
        tg.engaged = (tg.engaged || 0) + 1;
        this.event(`${j.nm}: ${mu.short} away at an ${tg.F.name}.`, 'info', tg);
        break;
      }
    }
  }

  stepAams(dt) {
    for (const a of this.aams) {
      if (a.dead) continue;
      const tg = a.target;
      if (!tg.alive) { a.dead = true; continue; }
      const end = (why) => {
        a.dead = true; tg.engaged = Math.max(0, (tg.engaged || 1) - 1);
        if (why) { this.burst(a.x, a.y, 'miss'); this.event(`${a.red ? 'An' : 'Our'} ${a.name} ${why}.`, a.red ? 'good' : 'info'); }
      };
      const d = dist(a, tg);
      // until its own seeker takes over, the shooter's radar has to keep holding the target
      const held = d <= a.pitbull || (a.from.alive && (a.red ? this.banditSees(a.from, tg) : a.ship ? this.shipSees(a.from, tg) : this.jetSees(a.from, tg)));
      a.lost = held ? 0 : a.lost + dt;
      if (a.lost > 4) { end('lost its guidance'); continue; }
      const step = (a.kmh / 3600) * dt;
      if (d <= step) { end(); this.aamHit(a, tg); continue; }
      a.x += ((tg.x - a.x) / d) * step; a.y += ((tg.y - a.y) / d) * step; a.flown += step;
      if (a.flown > a.max) end('ran out of energy');
    }
    if (this.aams.length > 80) this.aams = this.aams.filter((a) => !a.dead);
  }

  aamHit(a, tg) {
    if (a.red) {
      const leg = tg.f.route[Math.min(tg.f.leg, tg.f.route.length - 2)], jam = this.jammed(a.from);
      const pk = a.pk * SPEEDS[leg.spd].pk * (1 - tg.A.ecm) * (1 - tg.A.cm) * (tg.A.lo ?? 1) * (jam ? jam.pk : 1);
      if (Math.random() < pk) {
        tg.alive = false;
        this.lost.push({ jet: tg, why: a.from.F.name });
        this.burst(tg.x, tg.y, 'kill');
        this.event(`${tg.nm} shot down by an ${a.name} from an ${a.from.F.name}.`, 'loss', tg);
      } else { this.burst(tg.x, tg.y, 'miss'); this.event(`An ${a.name} missed the ${tg.nm}.`, 'good', tg); }
      return;
    }
    const F = tg.F, pk = a.pk * (1 - F.ecm) * (1 - F.cm) * (F.lo ?? 1);
    if (Math.random() < pk) {
      tg.alive = false;
      this.airKills = (this.airKills || 0) + 1;
      this.burst(tg.x, tg.y, 'hit');
      this.event(`Splash: ${F.name} shot down by an ${a.name} from the ${a.from.nm}.`, 'kill', tg);
    } else { this.burst(tg.x, tg.y, 'miss'); this.event(`Our ${a.name} missed the ${F.name}.`, 'info', tg); }
  }

  impact(ms, site, tg) {
    const S = SAMS[site.sam];
    if (tg.decoy) {
      if (Math.random() < 0.9) { tg.alive = false; this.burst(tg.x, tg.y, 'decoy'); this.event(`A decoy soaked up a ${S.name} missile.`, 'good', tg); }
      else this.burst(tg.x, tg.y, 'miss');
      return;
    }
    const a = tg.f.route[Math.min(tg.f.leg, tg.f.route.length - 2)];
    const jam = this.jammed(site);
    let pk = S.missile.pk * SPEEDS[a.spd].pk * (1 - tg.A.ecm) * (1 - tg.A.cm) * (tg.A.lo ?? 1) * (jam ? jam.pk : 1);
    // down low the ground clutters the radar picture (and there are hills the game doesn't draw); big long-range
    // systems are built for high targets and suffer most
    if (tg.alt < 600) pk *= (tg.alt < 120 ? 0.5 : 0.75) * (S.ring === 'long' ? 0.7 : 1);
    pk *= this.cover(tg).pk;
    if (Math.random() < pk) {
      tg.alive = false;
      this.lost.push({ jet: tg, why: S.long });
      this.burst(tg.x, tg.y, 'kill');
      this.event(`${tg.nm} shot down by a ${S.long}.`, 'loss', tg);
    } else { this.burst(tg.x, tg.y, 'miss'); this.event(`A ${S.name} missile missed (${tg.nm} defended).`, 'good', tg); }
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
    for (const j of this.jets) {
      if (!j.alive) continue;
      const p = j.f.pos;
      for (const st of j.stations) {
        if (!st.n || st.mu === 'mald' || st.mu === 'pod' || st.mu === 'tank' || MUNITIONS[st.mu].kind === 'aam') continue;
        const mu = MUNITIONS[st.mu];
        const R = reach(mu, p.alt, p.kmh);
        if (st.target === 'smart') { this.smart(j, st, mu, R); continue; }
        if (mu.kind === 'arm' && !st.gps) {
          // HARMs (and AARGM-ERs in radar mode): at the radar they were given, or (auto) at whichever radar is on and shooting first
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

  /** Smart targeting: SMART_RIPPLE at each known target that comes within reach, the objectives first, then radars
   *  and air defences, then the rest (in radar mode only at radars on the air). Enough stays on the rails for the
   *  objectives still ahead on the route that nothing else is going for; one still standing once its ripple has
   *  landed gets another if it's in reach. */
  smart(j, st, mu, R) {
    const radar = homes(st), f = j.f;
    const inbound = (t) => this.weapons.reduce((n, w) => n + (!w.dead && w.t === t), 0);
    const free = (s, t) => this.m.known[s.id] && smartFits(st, t) && inbound(t) < SMART_RIPPLE;
    // objectives out of reach now but near the rest of the route, that no other station is aimed at
    const ahead = [f.pos, ...f.route.slice(f.leg + 1)];
    const aimed = (o) => this.jets.some((x) => x.alive && x.stations.some((y) => y !== st && y.n && y.target?.site === o.site && y.target.idx === o.idx));
    let reserve = 0;
    for (const o of objectivesOf(this.m)) {
      const s = this.site[o.site], t = s.targets[o.idx], at = targetXY(s, t);
      if (free(s, t) && !aimed(o) && dist(at, j) > R && routeDist(ahead, at) <= R) reserve += SMART_RIPPLE;
    }
    const near = [];
    for (const s of this.m.sites) s.targets.forEach((t, i) => {
      if (!free(s, t) || (radar && !this.emitting(s, t))) return;
      const at = targetXY(s, t), d = dist(at, j);
      if (d <= R) near.push({ s, t, at, d, tier: smartTier(this.m, s, i) });
    });
    near.sort((a, b) => a.tier - b.tier || a.d - b.d);
    for (const c of near) {
      const n = Math.min(SMART_RIPPLE - inbound(c.t), st.n - (c.tier ? reserve : 0));
      if (n > 0) this.fire(j, st, mu, c.s, c.t, c.at, n);
      if (!st.n) break;
    }
  }

  fire(j, st, mu, s, t, at, n) {
    for (let k = 0; k < n; k++) {
      this.weapons.push({ id: ++this.nid, mu: mu.id, gps: !!st.gps, x: j.x, y: j.y, tx: at.x, ty: at.y, site: s.id, t, delay: k * 0.6, alt: j.alt });
    }
    st.n -= n;
    this.used += mu.cost * n;
    this.event(`${j.nm}: ${n > 1 ? n + '× ' : ''}${mu.short} away at the ${lower(targetName(t))} (${s.name.replace(/ site .*/, ' site')}).`, 'info', at);
  }

  stepWeapons(dt) {
    for (const w of this.weapons) {
      if (w.dead) continue;
      if (w.delay > 0) { w.delay -= dt; continue; }
      const mu = MUNITIONS[w.mu];
      const step = (mu.kmh / 3600) * dt;
      const d = Math.hypot(w.tx - w.x, w.ty - w.y);
      // point defence on the way in: the two closest sites covering the target each get a go. Tor and Pantsir see it
      // coming with their own radar and fire even before the alarm (and wake the network doing it); a slow glide bomb
      // gives them time to shoot, look and shoot again. Each takes on only so many at once: a big salvo saturates it.
      // long-range intercepts (mu.lr): S-300s and S-400s covering the target try for it lr.km out. An arcing weapon
      // (Mako) is seen high up from far off, alarm or not (their search radars pick it up, and it wakes the network); hard
      // to hit at Mach 5 and manoeuvring. A big, slower missile (AGM-130) once the network is awake, a shot each, and
      // only so many at once from one site.
      const lr = mu.lr;
      if (lr && !w.arced && d < lr.km && (lr.wakes || this.alert)) {
        w.arced = true;
        const longs = this.m.sites.filter((s) => s.sam && SAMS[s.sam].ring === 'long' && canEngage(s) && !this.blinded(s) && Math.hypot(s.x - w.tx, s.y - w.ty) <= SAMS[s.sam].missile.km)
          .sort((a, b) => Math.hypot(a.x - w.tx, a.y - w.ty) - Math.hypot(b.x - w.tx, b.y - w.ty)).slice(0, 2);
        let down = null;
        for (const ls of longs) {
          const S = SAMS[ls.sam];
          if (!lr.wakes) {
            const slot = Math.floor(this.t / 4);
            ls.lrLoad = ls.lrSlot === slot ? ls.lrLoad + 1 : 1; ls.lrSlot = slot;
            if (ls.lrLoad > S.ch) continue; // busy with the others
          }
          if (!this.m.known[ls.id]) this.m.known[ls.id] = true;
          if (!this.alert) { this.alert = true; this.event(`${S.long} is tracking an incoming ${mu.short}. The defences are awake.`, 'warn', ls); }
          for (let k = lr.shots || S.salvo; k > 0 && !down && ls.fired < ls.missiles; k--) {
            ls.fired++;
            if (Math.random() < S.missile.pk * lr.pk) down = S;
          }
          if (down) break;
        }
        if (down) {
          w.dead = true;
          this.burst(w.x, w.y, 'pd');
          this.event(`${down.long} intercepted a ${mu.short}.`, 'warn', w);
          continue;
        }
      }
      if (!w.tried && d < 18) {
        w.tried = true;
        const pds = this.m.sites.filter((s) => s.sam && SAMS[s.sam].pd && canEngage(s) && !this.blinded(s) && (this.alert || SAMS[s.sam].ring === 'short') && Math.hypot(s.x - w.tx, s.y - w.ty) <= SAMS[s.sam].missile.km)
          .sort((a, b) => Math.hypot(a.x - w.tx, a.y - w.ty) - Math.hypot(b.x - w.tx, b.y - w.ty)).slice(0, 2);
        let down = null;
        for (const pd of pds) {
          const S = SAMS[pd.sam], slot = Math.floor(this.t / 4);
          pd.pdLoad = pd.pdSlot === slot ? pd.pdLoad + 1 : 1; pd.pdSlot = slot;
          if (pd.pdLoad > S.ch * 2) continue; // busy with the others
          if (!this.m.known[pd.id]) this.m.known[pd.id] = true;
          if (!this.alert) { this.alert = true; this.event(`${S.long} is engaging incoming weapons. The defences are awake.`, 'warn', pd); }
          for (let k = S.ring === 'short' && mu.kind === 'glide' ? 2 : 1; k > 0 && !down && pd.fired < pd.missiles; k--) {
            pd.fired++;
            if (Math.random() < S.pd * mu.pd * 1.6) down = S;
          }
          if (down) break;
        }
        if (down) {
          w.dead = true;
          this.burst(w.x, w.y, 'pd');
          this.event(`${down.long} shot down a ${mu.short}.`, 'warn', w);
          continue;
        }
      }
      if (d <= step) { w.dead = true; this.hit(w, mu); continue; }
      w.x += ((w.tx - w.x) / d) * step; w.y += ((w.ty - w.y) / d) * step;
    }
    if (this.weapons.length > 200) this.weapons = this.weapons.filter((w) => !w.dead);
  }

  hit(w, mu) {
    const s = this.site[w.site], t = w.t;
    const arm = mu.kind === 'arm' && !w.gps; // INS/GPS mode flies to the spot, on the air or not
    if (arm) t.harmed = false;
    let p = 0.92;
    if (arm && !this.emitting(s, t)) p = 0.45; // it shut down: going for where it was
    if (!alive(t) || Math.random() > p) { this.burst(w.tx, w.ty, 'dud'); return; }
    const was = alive(t);
    t.dmg = (t.dmg || 0) + (isHard(t) ? mu.dmg : mu.soft);
    this.burst(w.tx, w.ty, 'hit');
    if (was && !alive(t)) {
      if (arm) this.harmKills = (this.harmKills || 0) + 1;
      const obj = objectiveNo(this.m, s.id, s.targets.indexOf(t)), two = objectivesOf(this.m).length > 1;
      // the ships' kills don't earn the points for other targets (a salvo flattens a whole site)
      if (!obj) { if (w.ship) this.shipKills = (this.shipKills || 0) + 1; else this.groundKills = (this.groundKills || 0) + 1; }
      this.event(`${obj ? `OBJECTIVE${two ? ` ${obj}` : ''} DESTROYED: ` : 'Destroyed: '}${targetName(t)} at ${s.name}.`, obj ? 'objective' : 'kill', w);
      if (t.k === 'post' && headless(s) && s.targets.some((x) => isRadar(x) && alive(x))) this.event(`With its command post gone, the ${s.sam ? `${SAMS[s.sam].long} site` : s.name}’s radars go off the air.`, 'good', s);
    } else if (t.k === 'runway') this.event(`Runway hit: ${Math.min(100, Math.round(((t.dmg || 0) / targetHp(t)) * 100))}% closed.`, 'kill', w);
  }

  /** Every objective destroyed. */
  objectiveDone() { return objectivesOf(this.m).every((o) => !alive(this.site[o.site].targets[o.idx])); }
  /** How many of the objectives are destroyed. */
  objectivesDown() { return objectivesOf(this.m).filter((o) => !alive(this.site[o.site].targets[o.idx])).length; }

  /** The way home from where a package is (for RTB): straight back to the origin. Edits the route in place, so the
   *  editor's reference to it stays good. */
  rtb(f) {
    const r = f.route, now = r[f.leg];
    r.splice(f.leg + 1, r.length - f.leg - 2, { x: f.pos.x, y: f.pos.y, alt: now.alt, spd: now.spd });
    f.leg++;
  }
}
