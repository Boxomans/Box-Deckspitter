// Deep Strike badges: levels for lifetime totals (one row per kind, like the carrier's), and one-off feats, most of
// them for doing something daft. Earned ones live in settings.tomcatStrike.badges ({ id: timestamp }), so they go
// with the setup export like the rest of the game.

import { AIRCRAFT, MUNITIONS } from './data.js';
import { REGIONS } from './mission.js';

/** Levels: goal is reached when the stat (from stats()) gets there. */
export const LEVELS = [
  ...[[1, 'First strike'], [5, 'Regular'], [10, 'Strike lead'], [25, 'Package commander'], [50, 'Deep striker'], [100, 'Air campaign'], [250, 'Nobody sleeps']]
    .map(([n, name]) => ({ id: `won-${n}`, kind: 'won', goal: n, name, what: `${n} objective${n === 1 ? '' : 's'} destroyed` })),
  ...[[1, 'Everyone home'], [5, 'Clean sheet'], [25, 'Untouchable'], [100, 'Ghost']]
    .map(([n, name]) => ({ id: `flawless-${n}`, kind: 'flawless', goal: n, name, what: `${n} objective${n === 1 ? '' : 's'} destroyed without losing a jet` })),
  ...[[3, 'Well travelled'], [5, 'Long reach'], [7, 'Every corner of the map']]
    .map(([n, name]) => ({ id: `regions-${n}`, kind: 'regions', goal: n, name, what: `objectives destroyed in ${n} of the ${Object.keys(REGIONS).length} regions` })),
  ...[[10, 'Expensive habit'], [50, 'The accountants are calling'], [100, 'Taxpayer’s nightmare']]
    .map(([n, name]) => ({ id: `lost-${n}`, kind: 'lost', goal: n, name, what: `${n} jets lost` })),
];
export const KIND_NAME = { won: 'Objectives destroyed', flawless: 'Flawless strikes', regions: 'Regions', lost: 'Jets lost' };

/** Feats: test(r) gets one flown strike's result (see result() in strike.js). */
export const FEATS = [
  { id: 'overkill', name: 'Overkill', what: '50 SDBs aimed at one target in a single strike. It’s very dead.', test: (r) => r.maxSdb >= 50 },
  { id: 'shoestring', name: 'Shoestring', what: 'Destroy the objective spending under 20% of the budget', test: (r) => r.won && r.cost < r.budget * 0.2 },
  { id: 'money', name: 'Money is no object', what: 'Spend 99% of the budget and still miss the objective', test: (r) => !r.won && r.cost >= r.budget * 0.99 },
  { id: 'lonewolf', name: 'Lone wolf', what: 'Destroy the objective with a package of one', test: (r) => r.won && r.jets === 1 },
  { id: 'friends', name: 'Should’ve brought friends', what: 'Fly a package of one and lose it', test: (r) => r.jets === 1 && r.lost === 1 },
  { id: 'deck', name: 'Nap of the earth', what: 'Destroy the objective flying every leg on the deck', test: (r) => r.won && r.allDeck },
  { id: 'fumes', name: 'Running on fumes', what: 'Bring a jet home with under 3% of its fuel left', test: (r) => r.home && r.fumes },
  { id: 'bingo', name: 'Bingo, bingo, bingo', what: 'Run a jet out of fuel', test: (r) => r.lostFuel > 0 },
  { id: 'unseen', name: 'Didn’t even see us', what: 'Destroy the objective without a single missile fired at the package', test: (r) => r.won && r.samShots === 0 },
  { id: 'magnet', name: 'Magnet', what: '20 or more missiles fired at the package, and everyone comes home', test: (r) => r.samShots >= 20 && r.lost === 0 && r.home },
  { id: 'weasel', name: 'Weasel', what: 'Destroy a radar with a HARM', test: (r) => r.harmKills > 0 },
  { id: 'parade', name: 'Big parade', what: 'Fly a package of 12 jets or more', test: (r) => r.jets >= 12 },
  { id: 'paper', name: 'Paper airplane', what: 'Fly a strike with nothing on the rails', test: (r) => r.jets > 0 && r.loaded === 0 },
  { id: 'tourist', name: 'Tourist', what: 'Carry weapons all the way there and back without letting one go', test: (r) => r.home && r.loaded > 0 && r.released === 0 },
  { id: 'heat', name: 'Speed of heat', what: 'Only F-15Es, every leg at Dash', test: (r) => r.jets > 0 && r.allF15 && r.allDash },
];

/** Points a flown strike earns, to spend on jets in the hangar: 50 for the objective, 50 for each on a mission with two (only the first time
 *  for a mission, so flying it again doesn't farm them), 25 more with every jet home, 10 just for flying; twice that
 *  on a large mission; with the objective, 5 for each other target destroyed and 10 for each fighter shot down (twice
 *  that on a large mission, and again only the first time; the ships' Tomahawk kills don't count); 12 for each new
 *  badge. Returns [[what, points]]. */
export function strikePoints(r, large, repeat, badges) {
  const x = large ? 2 : 1, out = [['Flown', 10 * x]];
  const objs = r.objectives || 1;
  if (r.won && !repeat) out.push([objs > 1 ? `Objectives destroyed (${objs})` : 'Objective destroyed', 50 * objs * x]);
  if (r.won && !repeat && !r.lost) out.push(['Every jet home', 25 * x]);
  if (r.won && !repeat && r.groundKills) out.push([`Other targets destroyed (${r.groundKills})`, 5 * r.groundKills * x]);
  if (r.won && !repeat && r.airKills) out.push([`Fighters shot down (${r.airKills})`, 10 * r.airKills * x]);
  if (badges) out.push([`New badge${badges === 1 ? '' : 's'} (${badges})`, 12 * badges]);
  return out;
}

/** Points for a record from before they existed: the strikes already flown count (as normal missions). */
export function startPoints(store) {
  const st = store.stats || {};
  return 10 * (st.flown || 0) + 50 * (st.won || 0) + 25 * (st.flawless || 0) + 12 * Object.keys(store.badges || {}).length;
}

/** A hangar for a record from before there was one: the hangar jets already in the saved packages are kept. */
export function startHangar(store) {
  const cur = store.cur || {}, out = {};
  for (const a of [...(cur.pkg || []), ...(cur.pkg2 || [])]) if (AIRCRAFT[a.type]?.points) out[a.type] = (out[a.type] || 0) + 1;
  return out;
}

/** How many badges (levels and feats) are earned, and how many there are: '3 of 32 badges'. */
export const badgeCount = (store) => `${Object.keys(store.badges || {}).length} of ${LEVELS.length + FEATS.length} badges`;

/** The levels with what's earned and how far along: { ...level, have, earned }. */
export function levelList(store) {
  const st = store.stats || {}, got = store.badges || {};
  const have = { won: st.won || 0, flawless: st.flawless || 0, regions: (st.regions || []).length, lost: st.jetsLost || 0 };
  return LEVELS.map((b) => ({ ...b, have: Math.min(have[b.kind], b.goal), earned: got[b.id] || null }));
}

/** Everything a flown strike tells the feats. plan: { mission, pkg, route }; sim: the finished StrikeSim. */
export function strikeResult(plan, sim, cost) {
  // both packages count as one strike; the legs are those of every route that flew
  const pkg = [...plan.pkg, ...(plan.pkg2 || [])];
  const legs = [[plan.pkg, plan.route], [plan.pkg2, plan.route2]].filter(([p, r]) => p?.length && r).flatMap(([, r]) => r.slice(0, -1));
  const onOne = {}; // SDBs per target
  let loaded = 0;
  for (const a of pkg) for (const s of a.stations) {
    if (!s.mu || s.mu === 'pod' || s.mu === 'tank' || MUNITIONS[s.mu].kind === 'aam') continue; // the jamming pod stays on, air-to-air missiles only go if there's a fighter, and a drop tank isn't a weapon
    const n = s.n || MUNITIONS[s.mu].per;
    loaded += n;
    if (s.mu === 'sdb' && s.target?.site) onOne[`${s.target.site}:${s.target.idx}`] = (onOne[`${s.target.site}:${s.target.idx}`] || 0) + n;
  }
  const left = sim.jets.reduce((n, j) => n + j.stations.reduce((k, s) => k + (s.mu === 'pod' || s.mu === 'tank' || MUNITIONS[s.mu]?.kind === 'aam' ? 0 : s.n || 0), 0), 0);
  return {
    won: sim.objectiveDone(), objectives: (plan.mission.objectives || [0]).length, home: sim.done?.why === 'home', budget: plan.mission.budget, cost,
    jets: pkg.length, lost: sim.lost.length, lostFuel: sim.lost.filter((l) => l.why === 'fuel').length,
    fumes: sim.jets.some((j) => j.alive && j.fuel >= 0.97),
    samShots: sim.samShots || 0, harmKills: sim.harmKills || 0, groundKills: sim.groundKills || 0, airKills: sim.airKills || 0,
    maxSdb: Math.max(0, ...Object.values(onOne)), loaded, released: loaded - left,
    allDeck: legs.length > 0 && legs.every((p) => p.alt === 'deck'), allDash: legs.length > 0 && legs.every((p) => p.spd === 'dash'),
    allF15: pkg.length > 0 && pkg.every((a) => AIRCRAFT[a.type].id === 'f15e'),
  };
}
