// Prometheus: the orbital mechanics. Every orbit is a circle on rails and every transfer a piece of an ellipse (a Hohmann
// half-ellipse, or a longer one cut short to get there sooner), worked out from formulas rather than flown, so time warp
// can run as fast as it likes. Vessels' mass, delta-v and thrust too.

import { BODIES, PARTS, G0, LIFTERS, LIFT_VE, BOOSTER, REUSE_PAYS, REUSABLE_SHIELD } from './data.js';

const TAU = Math.PI * 2;
export const mod = (x, m) => ((x % m) + m) % m;
const circ = (gm, r) => Math.sqrt(gm / r);
const visViva = (gm, r, a) => Math.sqrt(gm * (2 / r - 1 / a));
const gmOf = (id) => BODIES[id].gm;

/** A body's orbital period around its parent (s). */
export function period(id) {
  const b = BODIES[id];
  if (b.T) return b.T; // a binary pair's moons
  return TAU * Math.sqrt(b.a ** 3 / gmOf(b.parent));
}
/** Where a body is along its orbit at time t (radians). */
export const angleAt = (id, t) => (BODIES[id].parent ? BODIES[id].a0 + (TAU * t) / period(id) : 0);
/** A body's position around the star (m), moons included. */
export function helio(id, t) {
  const b = BODIES[id];
  if (!b.parent) return { x: 0, y: 0 };
  const p = helio(b.parent, t), th = angleAt(id, t);
  return { x: p.x + Math.cos(th) * b.a, y: p.y + Math.sin(th) * b.a };
}
/** A vessel's orbital period around a body at radius r (s). */
export const orbitPeriod = (body, r) => TAU * Math.sqrt(r ** 3 / gmOf(body));
export const lowR = (id) => BODIES[id].R + BODIES[id].low;
/** Where a vessel orbits to land on a body: the body itself, or for one of a binary pair the point they go round. */
export const hostOf = (id) => BODIES[id].host || id;
/** Matching (or shedding) the speed of the pair's lowest orbit, on the way down to one of them or back up. */
const hopDv = (id) => (BODIES[id].host ? circ(gmOf(BODIES[id].host), lowR(BODIES[id].host)) : 0);

/** Changing orbit height around one body: { dv, tof }. */
export function hohmann(body, r1, r2) {
  if (Math.abs(r1 - r2) < 1) return { dv: 0, tof: 0 };
  const g = gmOf(body), a = (r1 + r2) / 2;
  return { dv: Math.abs(visViva(g, r1, a) - circ(g, r1)) + Math.abs(circ(g, r2) - visViva(g, r2, a)), tof: Math.PI * Math.sqrt(a ** 3 / g) };
}

/** Lowering an orbit by dipping into the air: a small burn drops the low point into the upper air, the drag on each pass
 *  pulls the high point down, and a small burn at the new height lifts the low point back out. { dv, tof, passes, rDip }
 *  or null (no air, or not lower). */
export function dipOf(body, r1, r2) {
  const B = BODIES[body], g = gmOf(body);
  if (!B.top || r2 >= r1) return null;
  const rDip = B.R + B.top * 0.75, f = Math.min(0.15, 0.03 * Math.sqrt(B.atm));
  const dv = Math.abs(visViva(g, r1, (r1 + rDip) / 2) - circ(g, r1)) + Math.abs(circ(g, r2) - visViva(g, r2, (r2 + rDip) / 2));
  let hi = r1, tof = 0, passes = 0;
  while (hi > r2 && passes < 5000) { tof += TAU * Math.sqrt(((hi + rDip) / 2) ** 3 / g); hi = rDip + (hi - rDip) * (1 - f); passes++; }
  return { dv, tof, passes, rDip };
}

/** Leaving (or being captured at) a body with this excess speed, from (or into) a circular orbit of radius r. */
const escape = (body, r, vinf) => Math.sqrt(vinf * vinf + (2 * gmOf(body)) / r) - circ(gmOf(body), r);

/** Transfer speeds: how far past the target's orbit the ellipse reaches (out past it going out, in under it going in).
 *  1 is a Hohmann transfer; further means sooner there and more delta-v at both ends. */
export const FAST = [
  { name: 'Standard', k: 1 },
  { name: 'Fast', k: 1.5 },
  { name: 'Faster', k: 2.5 },
  { name: 'Fastest', k: 5 },
];

/** An arc from a circular orbit of radius rs to one of radius re around a body: leaves along the orbit from one end of an
 *  ellipse reaching k times past re, and is cut off where it crosses re. { vs (excess speed leaving), ve (excess speed
 *  arriving, sideways included), tof, sweep (the angle it goes round), M0, M1 (mean anomaly at each end), rp, ra,
 *  outbound }, or null if the ellipse would dip too close to the body. */
function arc(body, rs, re, k) {
  const g = gmOf(body), B = BODIES[body], outbound = re > rs;
  const rp = outbound ? rs : re / k, ra = outbound ? re * k : rs;
  if (rp < B.R + Math.min(B.low ?? B.R, B.R)) return null;
  const a = (rp + ra) / 2, e = (ra - rp) / (ra + rp), p = a * (1 - e * e), hm = Math.sqrt(g * p);
  const nu0 = outbound ? 0 : Math.PI;
  const c = e < 1e-9 ? -1 : Math.max(-1, Math.min(1, (p / re - 1) / e));
  const nu1 = outbound ? Math.acos(c) : TAU - Math.acos(c);
  const mean = (nu) => { const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2)); return mod(E - e * Math.sin(E), TAU); };
  const M0 = mean(nu0), M1 = nu1 >= TAU - 1e-12 ? TAU : mean(nu1) || (outbound ? 0 : TAU);
  const vs = Math.abs(hm / rs - circ(g, rs)), ve = Math.hypot(hm / re - circ(g, re), Math.sqrt(g / p) * e * Math.sin(nu1));
  return { vs, ve, tof: (M1 - M0) / Math.sqrt(g / a ** 3), sweep: nu1 - nu0, M0, M1, rp, ra, outbound };
}

/** The bodies reachable straight from a body: its parent's other children, its own moons and its parent (from a moon). */
export function reachable(from) {
  const p = BODIES[from].parent;
  return Object.values(BODIES).filter((b) => b.id !== from && b.parent && !b.host && (b.parent === p || b.parent === from || b.id === p)).map((b) => b.id);
}

/** A transfer from an orbit of radius r1 around one body to an orbit of radius r2 around another, at one of the FAST
 *  speeds: { frame (the body the ellipse goes round), dep, arr, dv (m/s), tof (s), sweep, M0, M1, rp, ra, outbound, kind },
 *  or null (not reachable straight from here, or too low: tooClose is set when only the speed is the trouble). */
export function transfer(from, r1, to, r2, fast = 0) {
  const F = BODIES[from], T = BODIES[to], k = FAST[fast]?.k || 1;
  const done = (kind, frame, x, dep, arr) => (x ? { kind, frame, dep, arr, dv: dep + arr, tof: x.tof, sweep: x.sweep, M0: x.M0, M1: x.M1, rp: x.rp, ra: x.ra, outbound: x.outbound } : { tooClose: true, frame });
  if (F.parent && F.parent === T.parent) { // planet to planet (or moon to moon) around the same parent
    const x = arc(F.parent, F.a, T.a, k);
    return done('sibling', F.parent, x, x && escape(from, r1, x.vs), x && escape(to, r2, x.ve));
  }
  if (T.parent === from) { // to a moon (up to it, or down to it from an orbit higher than the moon's)
    const x = arc(from, r1, T.a, k);
    return done('out', from, x, x?.vs, x && escape(to, r2, x.ve));
  }
  if (F.parent === to) { // from a moon to an orbit of its planet (usually lower than the moon's, but it can be higher)
    const x = arc(to, F.a, r2, k);
    return done('in', to, x, x && escape(from, r1, x.vs), x?.ve);
  }
  return null;
}

/** When a transfer can leave, at or after t: planets wait for the planets to line up; to and from a moon it's now. */
export function windowAt(tr, from, to, t, tof) {
  if (tr.kind !== 'sibling') return t;
  const nF = TAU / period(from), nT = TAU / period(to), w = nT - nF;
  // the target has to be as far ahead of where the vessel leaves as the arc goes round (half a turn for Hohmann)
  const f = angleAt(to, t + tof) - angleAt(from, t) - (tr.sweep ?? Math.PI);
  return t + mod(-f * Math.sign(w), TAU) / Math.abs(w);
}

/** Where along a transfer the vessel is, τ seconds after leaving: { r, th } around tr.frame. */
export function onTransfer(tr, tau) {
  const a = (tr.rp + tr.ra) / 2, e = (tr.ra - tr.rp) / (tr.ra + tr.rp);
  const f = Math.min(1, Math.max(0, tau / tr.tof)), M0 = tr.M0 ?? (tr.outbound ? 0 : Math.PI), M1 = tr.M1 ?? M0 + Math.PI;
  const M = M0 + (M1 - M0) * f;
  let E = M;
  for (let i = 0; i < 12; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const peri = tr.outbound ? tr.th0 : tr.th0 - Math.PI; // th0: the direction it leaves in
  return { r: a * (1 - e * Math.cos(E)), th: peri + nu };
}

// ---------------------------------------------------------------- landing and taking off

/** Delta-v to get from the surface into the lowest orbit: orbital speed, plus gravity and air losses. */
export function ascentDv(id) {
  const b = BODIES[id];
  return circ(b.gm, lowR(id)) + 600 * b.g + 1000 * b.atm + hopDv(id);
}
/** Delta-v to come down from the lowest orbit: all of it under power; with a heat shield only the last bit; with
 *  parachutes a short braking burn; with both, just the burn that drops it out of orbit. Shields and parachutes need air;
 *  where it's thin (chuteAssist) parachutes and shields only slow it, and rockets do the rest. */
export function descentDv(id, biome, shielded, chuted = false) {
  const b = BODIES[id], hz = 1 + (b.biomes.find((x) => x.id === biome)?.hazard || 0);
  if (chuted && b.atm > 0) return ((shielded ? 100 : 300 + 200 * b.g) + (b.chuteAssist ? 1500 * b.g : 0)) * hz;
  if (shielded && b.atm > 0) return (150 + 250 * b.g + (b.chuteAssist ? 2500 * b.g : 0)) * hz;
  return (circ(b.gm, lowR(id)) + 500 * b.g + hopDv(id)) * hz;
}

// ---------------------------------------------------------------- vessels

const partList = (v) => v.parts.flatMap((p) => Array.from({ length: p.n }, () => ({ ...PARTS[p.id], reusable: p.reusable })));

/** Everything a stack of parts adds up to: { dry, cap (fuel t), thrust (kN), isp, legs (t), floats (t), chute (t), crew, probe, comms, relay, sci,
 *  rover, shields, cost, solar (kW at 1 AU), rtg (kW), tiles (t), cool (t), load (kW, everything but the drill and refinery), drill (t a day), drillKW,
 *  oreCap (t), refine (t a day), refineKW, smelt (t a day), smeltKW, fab (t a day), fabKW, store (t), cell (kW), cellBurn (t a day) }. Regolith, metal and
 *  components on board (t, passed as cargo) count as dry mass. */
export function stats(parts, cargo = 0) {
  const out = { dry: cargo, cap: 0, thrust: 0, flow: 0, legs: 0, floats: 0, chute: 0, crew: 0, probe: false, comms: 0, relay: false, sci: new Set(), rover: false, shields: [], cost: 0,
    solar: 0, load: 0, drill: 0, drillKW: 0, oreCap: 0, refine: 0, refineKW: 0, smelt: 0, smeltKW: 0, fab: 0, fabKW: 0, store: 0, cell: 0, cellBurn: 0, rtg: 0, tiles: 0, cool: 0 };
  for (const p of parts.flatMap((x) => Array.from({ length: x.n }, () => ({ ...PARTS[x.id], reusable: x.reusable })))) {
    out.dry += p.m;
    out.cost += p.cost * (p.cat === 'shield' && p.reusable ? REUSABLE_SHIELD : 1);
    if (p.litres) out.cap += p.litres / 1000;
    if (p.thrust) { out.thrust += p.thrust; out.flow += p.thrust / p.isp; }
    if (p.holds) out.legs += p.holds;
    if (p.floats) out.floats += p.floats;
    if (p.chute) out.chute += p.chute;
    if (p.rover) out.rover = true;
    if (p.crew) out.crew += p.crew;
    if (p.probe) out.probe = true;
    if (p.range) out.comms += p.range; // antennas stack: their ranges add up
    if (p.relay) out.relay = true;
    if (p.sci) out.sci.add(p.sci);
    if (p.covers) out.shields.push({ covers: p.covers, reusable: !!p.reusable });
    if (p.makes) out.solar += p.makes;
    if (p.rtg) out.rtg += p.rtg;
    if (p.tiles) out.tiles += p.tiles;
    if (p.cools) out.cool += p.cools;
    if (p.drill) { out.drill += p.drill; out.drillKW += p.uses; } else if (p.refine) { out.refine += p.refine; out.refineKW += p.uses; }
    else if (p.smelt) { out.smelt += p.smelt; out.smeltKW += p.uses; } else if (p.fab) { out.fab += p.fab; out.fabKW += p.uses; } else if (p.uses) out.load += p.uses;
    if (p.store) out.store += p.store;
    if (p.cell) { out.cell += p.cell; out.cellBurn += p.burn; }
    if (p.ore) out.oreCap += p.ore;
  }
  out.isp = out.flow ? out.thrust / out.flow : 0;
  if (out.tiles) out.shields.push({ covers: out.tiles, reusable: true, tiles: true }); // together the tiles act as one shield that's never used up
  return out;
}
export { partList };

/** Starlight at a point (m, around Prometheus A) as a share of what Terra gets: every star's, falling with the square of
 *  the distance, and at most 25 times as much. */
export function lightAt(p, t) {
  let sum = 0;
  for (const b of Object.values(BODIES)) {
    if (!b.lum) continue;
    const s = helio(b.id, t);
    sum += b.lum / Math.max((4 * b.R) ** 2, (p.x - s.x) ** 2 + (p.y - s.y) ** 2);
  }
  return Math.min(25, (sum * BODIES.terra.a ** 2) / BODIES.star.lum);
}
/** What solar panels make in this much light (kW; 1 is Terra's). */
export const solarAt = (st, light) => st.solar * light;
/** All the power made there without fuel: solar panels and RTGs (kW). */
export const madeAt = (st, light) => solarAt(st, light) + st.rtg;

/** Delta-v with this much fuel on board (m/s). */
export const dvOf = (st, fuel) => (st.isp && fuel > 0 ? st.isp * G0 * Math.log((st.dry + fuel) / st.dry) : 0);
/** Fuel a burn of dv uses (t), Infinity with no engine. */
export const fuelFor = (st, fuel, dv) => (dv <= 0 ? 0 : st.isp ? (st.dry + fuel) * (1 - Math.exp(-dv / (st.isp * G0))) : Infinity);
/** Thrust to weight at a body's surface gravity. */
export const twr = (st, fuel, g) => (st.thrust * 1000) / ((st.dry + fuel) * 1000 * g * G0);
/** The heat shield that would take a vessel this heavy down: the smallest that covers it, or null. */
export const shieldFor = (st, fuel) => st.shields.filter((s) => s.covers >= st.dry + fuel).sort((a, b) => a.covers - b.covers)[0] || null;

/** What a launch costs ($M) and can lift (t). */
export function lifter(cls, boosters, reusable, body = 'terra') {
  const L = LIFTERS[cls], price = (1 + BOOSTER.cost * boosters) * (reusable ? REUSE_PAYS : 1);
  const scale = Math.exp((ascentDv('terra') - ascentDv(body)) / LIFT_VE);
  return { name: L.name, payload: L.payload * (1 + BOOSTER.payload * boosters) * scale, cost: L.cost * price, comps: L.comps * price, air: !!(L.noAir && BODIES[body].atm) };
}
