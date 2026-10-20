// Deep Strike's missions: an objective (a real airfield, an air defence site or an industrial complex near a town)
// somewhere in one of the field's regions, the targets inside it, and the air defence network around it. Everything
// but the airfields' positions is made up from the mission's seed: no real deployments.

import { SAMS, TARGETS, RUNWAY_HP, RUNWAY_LEN, BUDGET, LARGE_BUDGET, SMALL_BUDGET, CODEWORDS, homes } from './data.js';
import { rng, whereIs, onLand, inField, inRegion, zoneAt, makeZones, arcDist, arcSpan, ARC_HALF } from './geo.js';

/** Which airfields have the long runway (the rest of the medium ones are medium). */
const LONG_RUNWAY = new Set(['Lipetsk', 'Borisoglebsk', 'Voronezh Baltimore', 'Krymsk', 'Rostov-on-Don Central', 'Millerovo', 'Kursk Khalino']);

export const TYPE_NAME = { airbase: 'Air base', sam: 'Air defence site', industry: 'Industrial complex' };

/** The field's regions; every airfield in airfields.json belongs to one (r), and geo.js knows each one's land. */
export const REGIONS = {
  west: 'Western Russia & Ukraine',
  nord: 'Sweden, Finland, the Baltics & Belarus',
  south: 'Turkey, the eastern Balkans, the Caucasus & Iran',
  central: 'Germany, Poland & Central Europe',
  westeu: 'France, Britain & the Low Countries',
  iberia: 'Spain & Portugal',
  adria: 'Italy & the Western Balkans',
};

/** A fresh mission. type: 'airbase' | 'sam' | 'industry' | undefined (any); region: a REGIONS key | undefined (any). */
/** size 'large': a much bigger network (more long-range, medium and outer sites) and three times the budget. 'small':
 *  a few sites, no fighters, no second objective, closer in, and SMALL_BUDGET of the budget. */
export function makeMission(world, proj, seed = (Math.random() * 2 ** 31) >>> 0, type, region, size = 'normal') {
  const r = rng(seed), big = size === 'large', small = size === 'small';
  type ||= r.pick(['airbase', 'airbase', 'sam', 'industry']);
  region ||= r.pick(Object.keys(REGIONS));
  const sites = [];
  let n = 0;
  const id = () => `s${++n}`;
  // every mission is built around one of the region's airfields: the objective itself, or what's near it
  const anchor = r.pick(world.airfields.filter((a) => a.r === region));
  let zones = [];
  const dead = (x, y) => !!zoneAt(zones, x, y);
  const mine = (x, y) => inRegion(world, region, x, y) && !dead(x, y);

  // ---- the objective
  let primary;
  if (type === 'airbase') {
    const af = anchor;
    const size = af.s === 'S' ? 'S' : af.s === 'L' || LONG_RUNWAY.has(af.n) ? 'L' : 'M';
    primary = { id: id(), kind: 'airbase', name: `${af.n} airbase`, x: af.x, y: af.y, size, targets: airbaseTargets(r, size) };
  } else if (type === 'industry') {
    let towns = world.places.filter((p) => p.pop > 40000 && Math.hypot(p.x - anchor.x, p.y - anchor.y) < 150 && mine(p.x, p.y));
    if (!towns.length) towns = [world.places.reduce((a, b) => (Math.hypot(b.x - anchor.x, b.y - anchor.y) < Math.hypot(a.x - anchor.x, a.y - anchor.y) ? b : a))];
    let x, y, tries = 0; // on the town's edge, on land (a coastal town's other side is the sea)
    do { const t = r.pick(towns), a = r() * Math.PI * 2, d = r.range(4, 11); x = t.x + Math.cos(a) * d; y = t.y + Math.sin(a) * d; } while (!mine(x, y) && ++tries < 200);
    primary = { id: id(), kind: 'industry', x, y, targets: industryTargets(r) };
    primary.name = `Industrial complex ${whereIs(world, primary, 40000)}`;
  } else {
    let x, y, tries = 0;
    do { const a = r() * Math.PI * 2, d = r.range(15, 120); x = anchor.x + Math.cos(a) * d; y = anchor.y + Math.sin(a) * d; } while (!mine(x, y) && ++tries < 200);
    const sam = r() < 0.55 ? 's400' : 's300';
    primary = { id: id(), kind: 'sam', sam, x, y, targets: samTargets(r, sam) };
    primary.name = `${SAMS[sam].name} site ${whereIs(world, primary)}`;
  }
  sites.push(primary);
  // one target inside is the objective
  const pickable = primary.targets.map((t, i) => [t, i]).filter(([t]) => !['entrance'].includes(t.k) || type !== 'airbase');
  const weights = pickable.map(([t]) => (t.k === 'runway' ? 3 : t.k === 'launcher' ? 0.5 : 1));
  let roll = r() * weights.reduce((a, b) => a + b, 0), objective = pickable[0][1];
  for (let i = 0; i < pickable.length; i++) { roll -= weights[i]; if (roll <= 0) { objective = pickable[i][1]; break; } }

  // ---- where the package comes from: any side, out of reach of the defences, inside the field (land or sea)
  let brg, od, origin, tries = 0;
  do {
    brg = r() * Math.PI * 2; // radians, 0 = east, y runs south
    od = big ? r.range(600, 760) : small ? r.range(360, 450) : r.range(430, 550); // a large mission's package comes from further out
    origin = { x: primary.x + Math.cos(brg) * od, y: primary.y + Math.sin(brg) * od };
  } while (!inField(world, origin.x, origin.y) && ++tries < 80);
  // the planner can slide the origin round the objective along this arc (to balance the packages' fuel)
  const arc = { a: brg, half: ARC_HALF, r: od };
  Object.assign(arc, arcSpan(world, primary, arc)); // only the part over the field
  // ---- the dead zones: broken rings round it, out past the defences (nothing below goes inside one)
  zones = makeZones(world, r, primary, arc, big);

  // ---- the network around it
  const far = (x, y, min = 9) => sites.every((s) => Math.hypot(s.x - x, s.y - y) >= min);
  const place = (sam, near, dMin, dMax, towardOrigin = false) => {
    for (let tries = 0; tries < 90; tries++) { // the region's own land first, then (an island's defences) any land
      let a = r() * Math.PI * 2;
      if (towardOrigin) a = brg + r.range(-0.8, 0.8);
      const d = r.range(dMin, dMax);
      const x = near.x + Math.cos(a) * d, y = near.y + Math.sin(a) * d;
      if (!(tries < 60 ? mine(x, y) : onLand(world, x, y) && !dead(x, y)) || !far(x, y, SAMS[sam].ring === 'short' ? 1.2 : 9) || arcDist({ x, y }, primary, arc) < SAMS[sam].missile.km + 40) continue;
      const s = { id: id(), kind: 'sam', sam, x, y, targets: samTargets(r, sam) };
      s.name = `${SAMS[sam].name} site ${whereIs(world, s)}`;
      sites.push(s);
      return s;
    }
    return null;
  };
  // point defence right at the objective
  place(r() < 0.5 ? 'pantsir' : 'tor', primary, 1.2, 3.5);
  if (!small && (big || r() < 0.55)) place(r() < 0.5 ? 'pantsir' : 'tor', primary, 1.5, 4.5);
  // one or two long-range systems covering it (three to five on a large mission, none or one on a small one)
  const longs = big ? r.int(3, 5) : small ? (r() < 0.5 ? 1 : 0) : r.int(1, 2);
  for (let i = 0; i < longs; i++) {
    const s = place(r() < 0.5 ? 's400' : 's300', primary, 25, big ? 140 : 95, i === 0 && r() < 0.6);
    if (s && r() < 0.7) place('pantsir', s, 1.2, 3); // long-range sites keep their own point defence
  }
  // medium-range sites, some across the way in
  const meds = big ? r.int(6, 9) : small ? r.int(1, 2) : r.int(2, 4);
  for (let i = 0; i < meds; i++) place('buk', primary, 15, big ? 120 : 80, r() < 0.5);
  for (let i = big ? r.int(2, 3) : small ? 0 : r() < 0.4 ? 1 : 0; i > 0; i--) place('tor', primary, 20, 60, true);
  // an outer layer out along the way in: the edge to feel around first
  const outer = big ? r.int(3, 5) : small ? (r() < 0.5 ? 1 : 0) : r.int(1, 2);
  for (let i = 0; i < outer; i++) place(r() < 0.65 ? 'buk' : 's300', primary, 100, big ? 240 : 175, true);

  // hidden: how many missiles each site really has (shown in the debrief)
  for (const s of sites) {
    if (!s.sam) continue;
    const S = SAMS[s.sam];
    const tubes = s.targets.filter((t) => t.k === 'launcher' || t.k === 'telar' || t.k === 'tlar').length * S.per;
    s.missiles = Math.max(2, Math.round(tubes * r.range(0.55, 1)));
    s.fired = 0;
  }

  // enemy fighters on patrol (CAP) out toward the origin: on about half the normal missions, one to three flights of two
  // on a large one, none on a small one; the Su-57 is very rare
  const cap = [], ang = Math.atan2(origin.y - primary.y, origin.x - primary.x);
  for (let i = big ? r.int(1, 3) : small ? 0 : r() < 0.5 ? 1 : 0; i > 0; i--) {
    const back = r.range(50, 160), side = r.range(-80, 80);
    cap.push({ id: `cap${cap.length}`, type: r() < 0.05 ? 'su57' : 'su35', n: 2,
      x: primary.x + Math.cos(ang) * back - Math.sin(ang) * side, y: primary.y + Math.sin(ang) * back + Math.cos(ang) * side });
  }

  const code = r.pick(CODEWORDS);
  // now and then a second objective: the engagement radar of a long-range site covering the first (it goes on the map
  // from the start), or failing one, another part of the objective itself. Both have to go.
  const objectives = [{ site: primary.id, idx: objective }], known = { [primary.id]: true };
  if (!small && r() < 0.3) {
    const longs = sites.filter((s) => s !== primary && s.sam && SAMS[s.sam].ring === 'long');
    if (longs.length) {
      const s = r.pick(longs);
      objectives.push({ site: s.id, idx: s.targets.findIndex((t) => t.k === 'fc') });
      known[s.id] = true;
    } else {
      const rest = pickable.filter(([, i]) => i !== objective);
      if (rest.length) objectives.push({ site: primary.id, idx: r.pick(rest)[1] });
    }
  }
  return {
    v: 1, seed, type, region, size: big ? 'large' : small ? 'small' : 'normal', code, budget: BUDGET[type] * (big ? LARGE_BUDGET : small ? SMALL_BUDGET : 1), origin, arc, primary: primary.id, objective: objectives[0],
    ...(objectives.length > 1 ? { objectives } : {}), sites, known, cap, zones,
  };
}

/** A mission's objectives: [{ site, idx }], one or two (every one has to be destroyed). */
export const objectivesOf = (m) => m.objectives || [m.objective];
/** Is target idx of this site one of the objectives? Its number (1, 2) if so, else 0. */
export const objectiveNo = (m, site, idx) => objectivesOf(m).findIndex((o) => o.site === site && o.idx === idx) + 1;

// ---- the inside of each site: positions in metres from its middle (x east, y south)

function airbaseTargets(r, size) {
  const len = RUNWAY_LEN[size];
  const ang = r.range(0, Math.PI);
  const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux; // along / across the runway
  const side = r() < 0.5 ? 1 : -1;
  const at = (along, across) => ({ x: ux * along + nx * across * side, y: uy * along + ny * across * side });
  const t = [{ k: 'runway', name: `Runway (${{ S: 'short', M: 'medium', L: 'long' }[size]}, ${(len / 1000).toFixed(1)} km)`, ...at(0, 0), len, ang, hp: RUNWAY_HP[size] }];
  const ents = size === 'S' ? 2 : 3;
  for (let i = 0; i < ents; i++) t.push({ k: 'entrance', ...at(((i + 0.5) / ents - 0.5) * len * 0.9, 120) });
  const has = { S: 4, M: 6, L: 8 }[size];
  for (let i = 0; i < has; i++) t.push({ k: 'has', ...at((i - has / 2) * 110 + r.range(-20, 20), 420 + (i % 2) * 120) });
  for (let i = 0; i < (size === 'L' ? 2 : 1); i++) t.push({ k: 'hangar', ...at(len * 0.32 + i * 160, 300) });
  t.push({ k: 'command', ...at(-len * 0.3, 520) }, { k: 'fuel', ...at(len * 0.45, 700) }, { k: 'ammo', ...at(-len * 0.5, 1100) });
  t.push({ k: 'search', name: 'Airfield radar', ...at(len * 0.1, -420) });
  return t;
}

function industryTargets(r) {
  const t = [];
  const halls = r.int(3, 5);
  for (let i = 0; i < halls; i++) t.push({ k: 'hall', x: (i - halls / 2) * 220 + r.range(-30, 30), y: r.range(-80, 80) });
  t.push({ k: 'power', x: r.range(-500, 500), y: 380 }, { k: 'tank', x: 520, y: -300 }, { k: 'tank', x: 600, y: -220 }, { k: 'command', x: -560, y: -260 });
  return t;
}

function samTargets(r, sam) {
  const S = SAMS[sam];
  const nL = r.int(S.launchers[0], S.launchers[1]);
  const t = [];
  if (sam === 'tor' || sam === 'pantsir') {
    for (let i = 0; i < nL; i++) t.push({ k: 'tlar', name: `${S.name} launcher vehicle`, x: i * 160 - 80, y: r.range(-40, 40) });
    return t;
  }
  if (sam === 'buk') {
    t.push({ k: 'search', name: `${S.search.name} search radar`, x: 0, y: 0 }, { k: 'post', x: 140, y: 90 });
    for (let i = 0; i < nL; i++) { const a = (i / nL) * Math.PI * 2; t.push({ k: 'telar', name: `${S.name} TELAR`, x: Math.cos(a) * 900, y: Math.sin(a) * 900 }); }
    return t;
  }
  t.push({ k: 'search', name: `${S.search.name} search radar`, x: -260, y: -120 }, { k: 'fc', name: `${S.fc.name} engagement radar`, x: 0, y: 0 }, { k: 'post', x: -180, y: 160 });
  for (let i = 0; i < nL; i++) { const a = -Math.PI / 2 + (i - (nL - 1) / 2) * 0.42; t.push({ k: 'launcher', name: `${S.name} launcher`, x: Math.cos(a) * 650, y: Math.sin(a) * 650 + 300 }); }
  return t;
}

// ---- reading a site

export const targetName = (t) => t.name || TARGETS[t.k]?.name || t.k;
/** "Fuel depot" → "fuel depot" mid-sentence; names like "9S18M1 search radar" or "Buk TELAR" stay as they are. */
export const lower = (s) => (/^[A-Z][a-z]/.test(s) && !/^\S+ [A-Z]{2}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
export const targetHp = (t) => t.hp ?? TARGETS[t.k]?.hp ?? 1;
export const isHard = (t) => !!TARGETS[t.k]?.hard;
export const alive = (t) => (t.dmg || 0) < targetHp(t);

/** A site whose command post is destroyed: its radars go off the air (still standing, but nobody runs them). */
export const headless = (s) => s.targets.some((t) => t.k === 'post') && !s.targets.some((t) => t.k === 'post' && alive(t));
/** Radars that can search: a site's search radar, or a Tor/Pantsir vehicle (it has its own). None once the command post is gone. */
export const searchRadars = (s) => (headless(s) ? [] : s.targets.filter((t) => (t.k === 'search' || t.k === 'tlar') && alive(t)));
/** Radars that can guide a missile: the engagement radar, a Buk TELAR, a Tor/Pantsir vehicle. None once the command post is gone. */
export const fcRadars = (s) => (headless(s) ? [] : s.targets.filter((t) => (t.k === 'fc' || t.k === 'telar' || t.k === 'tlar') && alive(t)));
/** Something left that can launch. */
export const launchers = (s) => s.targets.filter((t) => (t.k === 'launcher' || t.k === 'telar' || t.k === 'tlar') && alive(t));
export const canEngage = (s) => !!s.sam && fcRadars(s).length > 0 && launchers(s).length > 0 && s.fired < s.missiles;
export const isRadar = (t) => ['search', 'fc', 'telar', 'tlar'].includes(t.k);

/** Smart targeting (a station's target 'smart'): this many at each target along the route. */
export const SMART_RIPPLE = 2;
/** Smart targeting's order: 0 the objectives, 1 radars and air defences (launchers, command posts), 2 the rest. */
export const smartTier = (m, s, i) => (objectiveNo(m, s.id, i) ? 0 : isRadar(s.targets[i]) || ['launcher', 'telar', 'tlar', 'post'].includes(s.targets[i].k) ? 1 : 2);
/** Can a smart station go for this target at all? A weapon in radar mode only at radars. */
export const smartFits = (st, t) => alive(t) && (!homes(st) || isRadar(t));

/** Where a target inside a site is on the map (km). */
export const targetXY = (s, t) => ({ x: s.x + t.x / 1000, y: s.y + t.y / 1000 });
