// Prometheus: the star system, the parts a vessel is put together from, the lifters that put it in orbit and the
// research tree. Distances in metres, masses in tonnes, money in $M, fuel in litres (1 t a 1000 L).

export const G0 = 9.80665;
export const AU = 1.496e11;
export const DAY = 86400;
export const YEAR = 365 * DAY;

const gm = (g, R) => g * G0 * R * R;

/** The star, the planets and their moons. a: orbit radius around the parent, a0: where along it at day 0 (radians),
 *  g: surface gravity in Terra gs, atm: surface pressure in atmospheres, low: the lowest orbit's height, max: the highest
 *  orbit that's still this body's, sci: how much its science is worth, minerals: how rich its ground is (1 is Terra; it sets
 *  how much material drills pull), chuteAssist: the air is too thin for parachutes or a heat shield alone, so the last of the way down is
 *  under power. Biomes: hazard adds to the landing's delta-v; water ones need floats, not legs.
 *  A binary pair: vessels orbit the point the two go round (its R is how far out they reach, so the lowest orbit stays
 *  clear of both) and land on either from there; each moon's host is that point.
 *  Stars: lum is how bright (Suns). Prometheus A is a white star of 2.2 Suns' mass and 20 times the Sun's light, so its
 *  planets sit √20 times as far out as they would round the Sun; Prometheus B is a red dwarf going round it with two
 *  planets of its own. gas: a gas giant, no surface to land on. */
export const BODIES = {
  /** Far off: Prometheus A goes round it, and the game's map is drawn around Prometheus A, so it never shows there. */
  hecate: { id: 'hecate', name: 'Hecate A*', kind: 'Supermassive black hole', hole: true, R: 1.18e10, gm: 4e6 * 1.327e20, col: '#ff9a3c',
    about: 'A black hole four million times the Sun\'s mass, wrapped in a glowing ring of gas falling in. Prometheus A goes round it 1,200 light years out, far beyond anything a vessel could reach.' },
  star: { id: 'star', name: 'Prometheus A', kind: 'Star', R: 1.67e9, gm: 2.2 * 1.327e20, lum: 20, col: '#eef4ff' },
  pandora: {
    id: 'pandora', name: 'Pandora', kind: 'Planet', parent: 'star', a: 0.45 * AU, a0: 5.9, R: 9.56e6, g: 0.8, atm: 0.8, hot: true,
    air: 'Nitrogen and oxygen, warm and humid; breathable on the dark side', mol: 0.029, col: '#c4502a', band: '#6e1d0b', rim: '#ffb070', low: 200e3, max: 500000e3, sci: 7, minerals: 1.2,
    about: 'A porous super-earth hugging Prometheus A, always turning the same face to it. That face is a magma sea no vessel can reach; around it runs a scorched desert in endless twilight, and behind it the dark side is humid and alive, seeded long ago by whatever started life on Terra and Gaia. So close in, a vessel needs radiators to get near.',
    biomes: [{ id: 'dark', name: 'The Living Dark', hazard: 0.05 }, { id: 'desert', name: 'Twilight Desert', hazard: 0.06 }, { id: 'sea', name: 'Night Sea', hazard: 0, water: true }],
  },
  terra: {
    id: 'terra', name: 'Terra', kind: 'Home planet', parent: 'star', a: 4.47 * AU, a0: 0.4, R: 6.371e6, g: 1, atm: 1,
    air: 'Nitrogen and oxygen, breathable', mol: 0.029, col: '#2fb55a', band: '#1c7a3a', rim: '#3aa0ff', low: 200e3, max: 3000000e3, sci: 1, minerals: 1,
    infra: 412e6, home: true,
    about: 'Home. Every launch leaves from here, and a vessel brought back down is recovered.',
    biomes: [{ id: 'ocean', name: 'Ocean', hazard: 0, water: true }],
  },
  dynamis: {
    id: 'dynamis', name: 'Dynamis', kind: 'Moon of Terra', parent: 'terra', a: 384.4e6, a0: 2.1, R: 3e5, g: 0.025, atm: 0,
    air: 'None', col: '#d8c24a', band: '#a08a26', low: 50e3, max: 7000e3, sci: 2.5, minerals: 1.2,
    about: 'A small sulfur-rich moon, cheap to reach from Terra orbit and to land on.',
    biomes: [{ id: 'flats', name: 'Sulfur Flats', hazard: 0 }, { id: 'crater', name: 'Crater Floor', hazard: 0.05 }, { id: 'vents', name: 'Vent Fields', hazard: 0.08 }],
  },
  sera: {
    id: 'sera', name: 'Sera', kind: 'Moon of Terra', parent: 'terra', a: 620e6, a0: 4.6, R: 1.1e6, g: 0.1, atm: 0.3,
    air: 'Nitrogen only, no oxygen', mol: 0.028, col: '#2f5873', band: '#1d3d52', rim: '#a9c3d4', low: 50e3, max: 40000e3, sci: 3, minerals: 0.3,
    about: 'A dead water world: one dark ocean under thin nitrogen air, with ice caps at the poles that will take landing legs.',
    biomes: [{ id: 'ocean', name: 'Open Ocean', hazard: 0, water: true }, { id: 'north', name: 'North Ice Cap', hazard: 0.04 }, { id: 'south', name: 'South Ice Cap', hazard: 0.04 }],
  },
  cobalt: {
    id: 'cobalt', name: 'Cobalt', kind: 'Moon of Terra', parent: 'terra', a: 160e6, a0: 5.5, R: 4.5e5, g: 0.06, atm: 0,
    air: 'None', col: '#6f8296', band: '#4b5b6c', low: 50e3, max: 5000e3, sci: 2.5, minerals: 3,
    about: 'A greyish-blue moon of bare rock, extremely rich in minerals.',
    biomes: [{ id: 'ore', name: 'Ore Fields', hazard: 0 }, { id: 'basin', name: 'Impact Basin', hazard: 0.05 }, { id: 'scarps', name: 'Ridge Scarps', hazard: 0.08 }],
  },
  cinder: {
    id: 'cinder', name: 'Cinder', kind: 'Planet', parent: 'star', a: 7.16 * AU, a0: 1.3, R: 3.39e6, g: 0.38, atm: 0.5,
    air: 'Carbon dioxide and nitrogen, not breathable', mol: 0.04, col: '#5c5f63', band: '#3b3d40', rim: '#9aa3ad', low: 150e3, max: 50000e3, sci: 4, minerals: 1.6, chuteAssist: true,
    about: 'A cold, dark grey world of ash and basalt.',
    biomes: [{ id: 'ash', name: 'Ash Plains', hazard: 0 }, { id: 'rift', name: 'Rift Valley', hazard: 0.08 }, { id: 'basalt', name: 'Basalt Highlands', hazard: 0.04 }],
  },
  palgal: {
    id: 'palgal', name: 'Pal & Gal', kind: 'Binary moons of Cinder', parent: 'cinder', a: 45e6, a0: 2.4, binary: true,
    col: '#a08f7d', low: 100e3, max: 200e3, sci: 3,
    about: 'Two tiny moons going round each other about once a day. Vessels orbit the point between them, above where either can reach, and land on one from there.',
  },
  pal: {
    id: 'pal', name: 'Pal', kind: 'Binary moon of Cinder', parent: 'palgal', host: 'palgal', a0: 0, R: 1.3e5, g: 0.0075, atm: 0,
    air: 'None', col: '#8c6f5a', low: 5e3, max: 5e3, sci: 3.5, minerals: 1.8,
    about: 'The bigger of the pair: a dark, rusty lump of rubble.',
    biomes: [{ id: 'rubble', name: 'Rubble Fields', hazard: 0.03 }, { id: 'saddle', name: 'The Saddle', hazard: 0 }, { id: 'facing', name: 'Gal-Facing Cliffs', hazard: 0.1 }],
  },
  gal: {
    id: 'gal', name: 'Gal', kind: 'Binary moon of Cinder', parent: 'palgal', host: 'palgal', a0: Math.PI, R: 1e5, g: 0.006, atm: 0,
    air: 'None', col: '#b9ad9b', low: 5e3, max: 5e3, sci: 3.5, minerals: 2.2,
    about: 'The smaller of the pair: pale, dusty and pitted.',
    biomes: [{ id: 'dust', name: 'Dust Plains', hazard: 0 }, { id: 'pits', name: 'Pit Chains', hazard: 0.06 }, { id: 'ridge', name: 'Pal-Facing Ridge', hazard: 0.05 }],
  },
  baja: {
    id: 'baja', name: 'Baja', kind: 'Planet', parent: 'star', a: 15.2 * AU, a0: 4.0, R: 8.6e6, g: 1.6, atm: 0.5,
    air: 'Nitrogen and oxygen, breathable but thin and cold', mol: 0.029, col: '#d99a4e', band: '#a8692c', rim: '#f2c58a', low: 250e3, max: 15000000e3, sci: 6, minerals: 1.3,
    about: 'A heavy, frozen desert world. The air is breathable, but landing is cheap and leaving is not.',
    biomes: [{ id: 'salt', name: 'Salt Pan', hazard: 0 }, { id: 'dunes', name: 'Dune Sea', hazard: 0.06 }, { id: 'canyons', name: 'Canyonlands', hazard: 0.1 }],
  },
  eros: {
    id: 'eros', name: 'Eros', kind: 'Moon of Baja', parent: 'baja', a: 50e6, a0: 0.6, R: 8e4, g: 0.006, atm: 0,
    air: 'None', col: '#c98a7f', band: '#9c5f57', low: 5e3, max: 40e3, sci: 4, minerals: 2,
    about: 'A small, stretched-out rosy moon skimming low over Baja, where Baja\'s pull is slowly drawing it in. One side holds a broad heart-shaped basin.',
    biomes: [{ id: 'rose', name: 'Rose Regolith', hazard: 0 }, { id: 'heart', name: 'Heart Basin', hazard: 0.02 }, { id: 'waist', name: 'The Waist', hazard: 0.06 }],
  },
  gaia: {
    id: 'gaia', name: 'Gaia', kind: 'Moon of Baja', parent: 'baja', a: 90e6, a0: 3.3, R: 2.6e6, g: 0.45, atm: 1.2,
    air: 'Nitrogen and oxygen, breathable', mol: 0.029, col: '#3f9a5a', band: '#2a6e3f', rim: '#8fd0ff', low: 100e3, max: 15000e3, sci: 5.5, minerals: 1.1,
    about: 'A living moon. Kneaded by Baja\'s tides and wrapped in thick, warm air, it stays mild while its planet freezes: shallow seas, moss forests and green uplands.',
    biomes: [{ id: 'seas', name: 'Shallow Seas', hazard: 0, water: true }, { id: 'forest', name: 'Moss Forests', hazard: 0.03 }, { id: 'uplands', name: 'Green Uplands', hazard: 0 }],
  },
  tartarus: {
    id: 'tartarus', name: 'Tartarus', kind: 'Moon of Baja', parent: 'baja', a: 160e6, a0: 5.2, R: 1.4e6, g: 0.18, atm: 0.05,
    air: 'Sulfur dioxide, very thin and poisonous', mol: 0.064, col: '#5a2a22', band: '#3a1814', rim: '#e0703a', low: 50e3, max: 6000e3, sci: 6, minerals: 2.4, chuteAssist: true,
    about: 'A dark, scorched moon split by a chasm hundreds of kilometres long and so deep its floor glows. Tides heat it from inside; sulfur seeps from every crack.',
    biomes: [{ id: 'brimstone', name: 'Brimstone Plains', hazard: 0.03 }, { id: 'cliffs', name: 'Iron Cliffs', hazard: 0.08 }, { id: 'abyss', name: 'The Abyss', hazard: 0.15 }],
  },
  erebus: {
    id: 'erebus', name: 'Erebus', kind: 'Moon of Baja', parent: 'baja', a: 280e6, a0: 1.9, R: 9e5, g: 0.07, atm: 0,
    air: 'None', col: '#2e3440', band: '#1d2129', low: 30e3, max: 5000e3, sci: 5, minerals: 1.4,
    about: 'A moon of deep shadow, coated in dark soot-stained ice. Ice volcanoes along its ridges throw up plumes that freeze and fall back as black snow.',
    biomes: [{ id: 'shadow', name: 'Shadow Plains', hazard: 0 }, { id: 'cryo', name: 'Ice Volcanoes', hazard: 0.1 }, { id: 'soot', name: 'Black Snowfields', hazard: 0.02 }],
  },
  nyx: {
    id: 'nyx', name: 'Nyx', kind: 'Moon of Baja', parent: 'baja', a: 520e6, a0: 4.4, R: 4e5, g: 0.03, atm: 0,
    air: 'None', col: '#1c2140', band: '#12152b', low: 20e3, max: 4000e3, sci: 5, minerals: 1,
    about: 'Baja\'s farthest moon and its darkest: night-black rock dusted with frost that glitters like stars when the light catches it.',
    biomes: [{ id: 'night', name: 'Night Plains', hazard: 0 }, { id: 'frost', name: 'Star Frost', hazard: 0.03 }, { id: 'dusk', name: 'Dusk Ridge', hazard: 0.07 }],
  },
  onyx: {
    id: 'onyx', name: 'Onyx', kind: 'Planet', parent: 'star', a: 28 * AU, a0: 2.7, R: 4.6e6, g: 0.7, atm: 0.8,
    air: 'Carbon monoxide and methane, poisonous', mol: 0.025, col: '#2b2b33', band: '#17171c', rim: '#c9b98a', low: 150e3, max: 80000e3, sci: 7, minerals: 1.5,
    about: 'A carbon world: graphite and carbide crust where other planets have rock, seams of diamond, and lakes of liquid methane and ethane under an orange haze.',
    biomes: [{ id: 'graphite', name: 'Graphite Plains', hazard: 0 }, { id: 'lakes', name: 'Ethane Lakes', hazard: 0, water: true }, { id: 'diamond', name: 'Diamond Scarps', hazard: 0.08 }],
  },
  starb: {
    id: 'starb', name: 'Prometheus B', kind: 'Red dwarf', parent: 'star', a: 80 * AU, a0: 0.9, R: 2.09e8, gm: 0.3 * 1.327e20, lum: 0.01, star: true,
    col: '#ff8a5c', low: 1.5e11, max: 1e12, sci: 8,
    about: 'A dim red dwarf with a third of the Sun\'s mass and a hundredth of its light. It takes about 480 years to go round Prometheus A, and it has two planets of its own.',
  },
  yalu: {
    id: 'yalu', name: 'Yalu', kind: 'Planet of Prometheus B', parent: 'starb', a: 1.6 * AU, a0: 5.1, R: 7e6, g: 1.1, atm: 4,
    air: 'Mostly hydrogen, thick and warm', mol: 0.003, col: '#4b3570', band: '#2e2048', rim: '#ff9a7a', low: 300e3, max: 1000000e3, sci: 7, minerals: 1.4,
    about: 'A heavy world in near-dark red twilight. Its thick hydrogen air holds in what little heat it gets, enough for warm violet seas of liquid water. Coming down through that much air is easy; climbing back out is not.',
    biomes: [{ id: 'sea', name: 'Warm Sea', hazard: 0, water: true }, { id: 'shores', name: 'Black Sand Shores', hazard: 0 }, { id: 'steam', name: 'Steam Highlands', hazard: 0.07 }],
  },
  vega: {
    id: 'vega', name: 'Vega', kind: 'Gas giant of Prometheus B', parent: 'starb', a: 3.2 * AU, a0: 1.8, R: 5.2e7, g: 1.4, atm: 1, gas: true,
    air: 'Helium, carbon monoxide and soot; almost no hydrogen', mol: 0.006, col: '#a593c9', band: '#6f6290', rim: '#d9cdf2', low: 1000e3, max: 5000000e3, sci: 9,
    about: 'A helium giant. Almost all its hydrogen is gone, leaving helium, carbon monoxide and soot in lilac and slate bands. There\'s no surface to land on, only orbit.',
  },
};
for (const b of Object.values(BODIES)) if (b.g) b.gm = gm(b.g, b.R);
/** Average temperatures (°C): the body's, then each biome's. They follow the light each one gets (Terra's is 1), then the
 *  air: thick air and greenhouse gases hold heat in, none lets it go. The stars' are their surface temperature (K). */
const TEMPS = {
  pandora: [45, { dark: 24, desert: 85, sea: 18 }],
  terra: [15, { ocean: 17 }],
  dynamis: [-25, { flats: -20, crater: -60, vents: 40 }],
  sera: [2, { ocean: 5, north: -35, south: -35 }],
  cobalt: [-25, { ore: -20, basin: -35, scarps: -25 }],
  cinder: [-55, { ash: -50, rift: -40, basalt: -70 }],
  pal: [-75, { rubble: -75, saddle: -70, facing: -90 }],
  gal: [-85, { dust: -85, pits: -100, ridge: -80 }],
  baja: [-120, { salt: -125, dunes: -115, canyons: -120 }],
  eros: [-125, { rose: -120, heart: -125, waist: -130 }],
  gaia: [8, { seas: 10, forest: 9, uplands: 2 }],
  tartarus: [-60, { brimstone: -70, cliffs: -90, abyss: 120 }],
  erebus: [-205, { shadow: -210, cryo: -180, soot: -205 }],
  nyx: [-215, { night: -218, frost: -220, dusk: -210 }],
  onyx: [-172, { graphite: -170, lakes: -178, diamond: -175 }],
  yalu: [22, { sea: 20, shores: 24, steam: 45 }],
  vega: [-190, {}],
};
for (const [id, [t, bs]] of Object.entries(TEMPS)) {
  BODIES[id].temp = t;
  for (const bm of BODIES[id].biomes || []) bm.temp = bs[bm.id];
}
/** How high the air reaches (m): where its pressure has fallen to a few millionths of an atmosphere (about 100 km on
 *  Terra). Light, warm air under weak gravity reaches far. No orbit can be lower than 10 km above it. */
export const AIR_EDGE = 6e-6, AIR_CLEAR = 10e3;
for (const b of Object.values(BODIES)) {
  if (!b.atm || !b.mol) { b.top = 0; continue; }
  const H = (8.314 * (b.temp + 273.15)) / (b.mol * b.g * G0);
  b.top = H * Math.log(b.atm / AIR_EDGE);
  b.low = Math.max(b.low, Math.ceil((b.top + AIR_CLEAR) / 10e3) * 10e3);
}
BODIES.star.teff = 7900;
/** Prometheus A's own orbit, round Hecate A*: how far out (m) and how long once round takes (s). */
export const LY = 9.4607e15;
BODIES.star.galA = 1200 * LY;
BODIES.star.galA0 = 2.3; // where along it (radians), Hecate A* seen from Prometheus A the other way
BODIES.star.galT = 2 * Math.PI * Math.sqrt(BODIES.star.galA ** 3 / BODIES.hecate.gm);
BODIES.starb.teff = 3300;
// Pal and Gal, 700 km apart, each going round the point between them; that point carries both their pulls
{
  const { palgal, pal, gal } = BODIES, d = 700e3;
  palgal.gm = pal.gm + gal.gm;
  pal.a = (d * gal.gm) / palgal.gm;
  gal.a = (d * pal.gm) / palgal.gm;
  palgal.R = Math.max(pal.a + pal.R, gal.a + gal.R);
  pal.T = gal.T = 2 * Math.PI * Math.sqrt(d ** 3 / palgal.gm);
}
export const BODY_ORDER = ['hecate', 'star', 'pandora', 'terra', 'cobalt', 'dynamis', 'sera', 'cinder', 'palgal', 'pal', 'gal', 'baja', 'eros', 'gaia', 'tartarus', 'erebus', 'nyx', 'onyx', 'starb', 'yalu', 'vega'];

/** Lifters: how much they put in Terra orbit (t), what they cost at Terra ($M) and what they take to build at a surface
 *  site (components, t). Boosters add a share of the payload each. Off worlds that take less to leave than Terra a lifter
 *  carries more, off harder ones less (see LIFT_VE). noAir: only flies off worlds with no air. */
export const LIFTERS = {
  omu: { id: 'omu', name: 'Orbital Maneuver Unit', payload: 0.8, cost: 0.5, comps: 0.5, noAir: true, tech: 'fab' },
  ultralight: { id: 'ultralight', name: 'Ultralight', payload: 2, cost: 1, comps: 1.5, tech: 'fab' },
  superlight: { id: 'superlight', name: 'Superlight', payload: 4, cost: 2, comps: 3.5, tech: 'fab' },
  light: { id: 'light', name: 'Light', payload: 12, cost: 4, comps: 7, tech: 'basic' },
  medium: { id: 'medium', name: 'Medium', payload: 25, cost: 10, comps: 14, tech: 'medium' },
  heavy: { id: 'heavy', name: 'Heavy', payload: 70, cost: 24, comps: 32, tech: 'heavy' },
};
/** How a lifter's payload changes with the world it takes off from: ×e for every LIFT_VE (m/s) less it takes to reach
 *  orbit than from Terra. A Superlight puts 4 t in Terra orbit and about 20 t in Cobalt's. */
export const LIFT_VE = 5500;
export const BOOSTER = { payload: 0.2, cost: 0.15, max: 4 }; // per booster: +20% payload, 15% of the lifter's cost
export const REUSE_PAYS = 0.4; // a reusable lifter costs this share of its price per launch

/** Parts. m: dry mass (t), cost ($M). Engines: thrust (kN), isp (s). Tanks: litres. Legs: what they hold up (t at 1 g).
 *  Parachutes: how heavy a vessel each one lets down through air (t). Floats: what they hold up on water (t at 1 g). Shields: the most they cover (t). Comms: range (AU), relay passes other
 *  vessels' signal on. Rover: drives off to the world's other land biomes and analyses the ground there.
 *  Power (kW): makes is what a solar panel gives at Terra's distance from the star (falling with the square of the
 *  distance), uses is what a part needs. Drill: regolith dug a day on land (t, times the ground's minerals). Ore: what a
 *  regolith tank holds (t). Refine: fuel a refinery makes a day (t), from REFINE_RATIO times as much regolith. Smelt:
 *  metal a smelter makes a day (t), from SMELT_RATIO times as much regolith. Fab: components a fabricator makes a day
 *  (t), from FAB_RATIO times as much metal. Store: what a storage unit holds (t), metal and components together. Cell:
 *  what a fuel cell makes (kW), burning `burn` t of fuel a day at full output; on automatic it only makes what the
 *  solar panels fall short of. RTG: power (kW) made anywhere, whatever the light, with no fuel. Tiles: thermal tiles, each
 *  covering this much of the vessel (t) on the way down through air; they add up, and are never used up. Cools: a
 *  radiator, keeping this much of the vessel (t) cool; a hot world (hot) can only be gone to or landed on with enough. */
export const PARTS = {
  mk0eng: { id: 'mk0eng', name: 'Mk0. Mini Engine', cat: 'engine', m: 0.3, cost: 0.6, thrust: 15, isp: 320, tech: 'basic' },
  mk1eng: { id: 'mk1eng', name: 'Mk1. Vac Engine', cat: 'engine', m: 1.2, cost: 1.5, thrust: 60, isp: 340, tech: 'basic' },
  mk2eng: { id: 'mk2eng', name: 'Mk2. Vac Engine', cat: 'engine', m: 1.8, cost: 3, thrust: 120, isp: 365, tech: 'mk2eng' },
  ntr: { id: 'ntr', name: 'NTR-1 Nuclear Engine', cat: 'engine', m: 3.5, cost: 9, thrust: 70, isp: 850, tech: 'ntr' },
  tank500: { id: 'tank500', name: 'Fuel Tank (500L)', cat: 'tank', m: 0.05, cost: 0.03, litres: 500, tech: 'basic' },
  tank1000: { id: 'tank1000', name: 'Fuel Tank (1000L)', cat: 'tank', m: 0.1, cost: 0.05, litres: 1000, tech: 'basic' },
  tank2500: { id: 'tank2500', name: 'Fuel Tank (2500L)', cat: 'tank', m: 0.25, cost: 0.1, litres: 2500, tech: 'basic' },
  tank5000: { id: 'tank5000', name: 'Fuel Tank (5000L)', cat: 'tank', m: 0.5, cost: 0.2, litres: 5000, tech: 'basic' },
  tank10000: { id: 'tank10000', name: 'Fuel Tank (10000L)', cat: 'tank', m: 1, cost: 0.35, litres: 10000, tech: 'basic' },
  tank20000: { id: 'tank20000', name: 'Fuel Tank (20000L)', cat: 'tank', m: 2, cost: 0.6, litres: 20000, tech: 'medium' },
  tank50000: { id: 'tank50000', name: 'Fuel Tank (50000L)', cat: 'tank', m: 4.5, cost: 1.2, litres: 50000, tech: 'bigtanks' },
  tank100000: { id: 'tank100000', name: 'Fuel Tank (100000L)', cat: 'tank', m: 9, cost: 2.2, litres: 100000, tech: 'bigtanks' },
  miniCore: { id: 'miniCore', name: 'Mini Probe Core', cat: 'control', m: 0.05, cost: 0.4, probe: true, uses: 0.02, tech: 'miniCore' },
  core: { id: 'core', name: 'Probe Core', cat: 'control', m: 0.25, cost: 0.8, probe: true, uses: 0.05, tech: 'basic' },
  pod: { id: 'pod', name: 'Command Pod (2)', cat: 'control', m: 2.2, cost: 3, crew: 2, uses: 0.2, tech: 'hab' },
  hab: { id: 'hab', name: 'Crew HAB (5)', cat: 'control', m: 6, cost: 6, crew: 5, uses: 0.6, tech: 'hab' },
  legs1: { id: 'legs1', name: 'Mk1. Landing Legs', cat: 'legs', m: 0.3, cost: 0.5, holds: 12, tech: 'basic' },
  legs2: { id: 'legs2', name: 'Mk2. Landing Legs', cat: 'legs', m: 1.2, cost: 1.5, holds: 60, tech: 'legs2' },
  chute: { id: 'chute', name: 'Mk1. Parachute', cat: 'legs', m: 0.1, cost: 0.2, chute: 4, tech: 'basic' },
  chute2: { id: 'chute2', name: 'Mk2. Parachute', cat: 'legs', m: 0.35, cost: 0.6, chute: 20, tech: 'chute2' },
  floats: { id: 'floats', name: 'Mk1. Floats', cat: 'legs', m: 0.4, cost: 0.6, floats: 15, tech: 'basic' },
  shieldS: { id: 'shieldS', name: 'Heat Shield (S)', cat: 'shield', m: 0.3, cost: 0.6, covers: 4, tech: 'shields' },
  shieldM: { id: 'shieldM', name: 'Heat Shield (M)', cat: 'shield', m: 1, cost: 1.5, covers: 15, tech: 'shields' },
  shieldL: { id: 'shieldL', name: 'Heat Shield (L)', cat: 'shield', m: 3, cost: 4, covers: 50, tech: 'heavy' },
  tiles1: { id: 'tiles1', name: 'Mk1. Thermal Tiles', cat: 'shield', m: 0.15, cost: 0.5, tiles: 2, tech: 'tiles' },
  phased: { id: 'phased', name: 'Mk1. Phased Array', cat: 'comms', m: 0.05, cost: 0.3, range: 0.05, uses: 0.02, tech: 'basic' },
  phased2: { id: 'phased2', name: 'Mk2. Phased Array', cat: 'comms', m: 0.1, cost: 0.8, range: 0.5, uses: 0.04, tech: 'comms2' },
  dish: { id: 'dish', name: 'Mk1. Dish Relay', cat: 'comms', m: 0.2, cost: 1.2, range: 25, relay: true, uses: 0.2, tech: 'dish' },
  dish2: { id: 'dish2', name: 'Mk2. Dish Relay', cat: 'comms', m: 0.5, cost: 3, range: 100, relay: true, uses: 0.4, tech: 'comms2' },
  sciSolar: { id: 'sciSolar', name: 'Mk1. Science (Solar)', cat: 'sci', m: 0.1, cost: 0.4, sci: 'solar', uses: 0.05, tech: 'basic' },
  sciSurface: { id: 'sciSurface', name: 'Mk1. Science (Surface)', cat: 'sci', m: 0.25, cost: 0.8, sci: 'surface', uses: 0.05, tech: 'surface' },
  sciAtmos: { id: 'sciAtmos', name: 'Mk1. Science (Atmospheric)', cat: 'sci', m: 0.12, cost: 0.5, sci: 'atmos', uses: 0.05, tech: 'atmos' },
  sciTemp: { id: 'sciTemp', name: 'Mk1. Science (Temperature)', cat: 'sci', m: 0.05, cost: 0.3, sci: 'temp', uses: 0.02, tech: 'basic' },
  sciWater: { id: 'sciWater', name: 'Mk1. Science (Water)', cat: 'sci', m: 0.15, cost: 0.6, sci: 'water', uses: 0.05, tech: 'surface' },
  rover: { id: 'rover', name: 'Mk1. Rover', cat: 'sci', m: 0.6, cost: 2, rover: true, uses: 0.3, tech: 'surface' },
  solar1: { id: 'solar1', name: 'Mk1. Solar Panel', cat: 'power', m: 0.04, cost: 0.15, makes: 0.6, tech: 'basic' },
  solar2: { id: 'solar2', name: 'Mk2. Solar Panel', cat: 'power', m: 0.15, cost: 0.6, makes: 3, tech: 'power2' },
  rtg: { id: 'rtg', name: 'RTG', cat: 'power', m: 0.4, cost: 5, rtg: 0.5, tech: 'rtg' },
  rad1: { id: 'rad1', name: 'Mk1. Radiator', cat: 'power', m: 0.2, cost: 0.6, cools: 8, tech: 'thermal' },
  cell1: { id: 'cell1', name: 'Mk1. Fuel Cell', cat: 'power', m: 0.25, cost: 1, cell: 1.5, burn: 0.05, tech: 'isru' },
  drill1: { id: 'drill1', name: 'Mk1. Drill', cat: 'isru', m: 0.6, cost: 2.5, drill: 0.5, uses: 1.2, tech: 'isru' },
  ore1: { id: 'ore1', name: 'Mk1. Regolith Tank', cat: 'isru', m: 0.15, cost: 0.2, ore: 2, tech: 'isru' },
  refinery1: { id: 'refinery1', name: 'Mk1. Refinery', cat: 'isru', m: 1.5, cost: 4, refine: 0.5, uses: 2.4, tech: 'isru' },
  smelter1: { id: 'smelter1', name: 'Mk1. Smelter', cat: 'isru', m: 1.8, cost: 5, smelt: 0.25, uses: 2, tech: 'fab' },
  fab1: { id: 'fab1', name: 'Mk1. Fabricator', cat: 'isru', m: 2.5, cost: 8, fab: 0.2, uses: 3, tech: 'fab' },
  storeS: { id: 'storeS', name: 'Storage Unit (S)', cat: 'storage', m: 0.1, cost: 0.15, store: 1, tech: 'fab' },
  storeM: { id: 'storeM', name: 'Storage Unit (M)', cat: 'storage', m: 0.4, cost: 0.5, store: 5, tech: 'fab' },
  storeL: { id: 'storeL', name: 'Storage Unit (L)', cat: 'storage', m: 1.2, cost: 1.2, store: 20, tech: 'fab' },
};
/** Tonnes of regolith that go into each tonne of fuel. */
export const REFINE_RATIO = 2;
/** Tonnes of regolith that go into each tonne of metal, and of metal into each tonne of components. */
export const SMELT_RATIO = 3, FAB_RATIO = 1.25;
/** Components (t) it takes to build a tonne of modules at a site. */
export const COMP_PER_T = 1;
/** Share of those components a site gets back scrapping a module. */
export const SCRAP_BACK = 0.5;
export const PART_CATS = [['engine', 'Propulsion'], ['tank', 'Fuel'], ['control', 'Control'], ['legs', 'Landing'], ['shield', 'Heat shields'], ['comms', 'Comms'], ['power', 'Power'], ['isru', 'Mining and industry'], ['storage', 'Storage'], ['sci', 'Science Experiments']];
/** A reusable heat shield costs this many times as much, and isn't used up on the way down. */
export const REUSABLE_SHIELD = 3;

/** What the science modules are worth (research points, times the body's sci) and where they work. */
export const SCIENCE = {
  solar: { name: 'Solar readings', rp: 4, where: 'in orbit' },
  atmos: { name: 'Atmosphere readings', rp: 6, where: 'in orbit or landed, where there is air' },
  surface: { name: 'Surface analysis', rp: 10, where: 'landed on land or ice, once per biome' },
  water: { name: 'Water analysis', rp: 10, where: 'landed on water, once per biome' },
  temp: { name: 'Temperature readings', rp: 5, where: 'landed, once per biome; shows the biome\'s temperature' },
  crew: { name: 'Crew report', rp: 5, where: 'by any vessel with crew on board, no module needed, in orbit or landed, once per biome' },
};
export const SCI_GRANT = 0.25; // $M for each research point transmitted
export const CREW_SCI = 1.5; // readings taken with crew on board are worth this much more
export const ROVER_DAYS = 5; // how long a rover takes to drive to the next biome

/** Ground station range on Terra (AU). Two antennas link when they're within the square root of their ranges multiplied. */
export const HOME_RANGE = 25;

/** The research tree's branches, drawn as lanes top to bottom. */
export const TECH_BRANCHES = [['engines', 'Propulsion'], ['lift', 'Lifters and tanks'], ['land', 'Landing and re-entry'], ['control', 'Control and crew'], ['sci', 'Science'], ['power', 'Power'], ['comms', 'Comms'], ['industry', 'Mining and industry']];
/** The research tree. rp: what it costs. needs: what has to be researched first. branch: its lane. */
export const TECH = [
  { id: 'basic', name: 'Basic Rocketry', rp: 0, needs: [], gives: 'Light lifter, Mk0. Mini Engine, Mk1. Vac Engine, fuel tanks, Probe Core, Mk1. Solar Panel, Mk1. Parachute, Mk1. Landing Legs, Mk1. Phased Array, Mk1. Science (Solar), Mk1. Science (Temperature)' },
  { id: 'atmos', name: 'Atmospheric Science', rp: 6, needs: ['basic'], branch: 'sci', gives: 'Mk1. Science (Atmospheric)' },
  { id: 'shields', name: 'Heat Shields', rp: 8, needs: ['basic'], branch: 'land', gives: 'Heat Shield (S) and (M)' },
  { id: 'miniCore', name: 'Miniaturisation', rp: 6, needs: ['basic'], branch: 'control', gives: 'Mini Probe Core: a fifth the mass of a Probe Core' },
  { id: 'isru', name: 'Resource Mining', rp: 15, needs: ['basic'], branch: 'industry', gives: 'Mk1. Drill, Mk1. Regolith Tank, Mk1. Refinery: dig regolith and turn it into fuel. Mk1. Fuel Cell: power from fuel when the solar panels fall short' },
  { id: 'fab', name: 'Fabrication', rp: 35, needs: ['isru'], branch: 'industry', gives: 'Mk1. Smelter, Mk1. Fabricator, Storage Units (S, M, L): regolith into metal, metal into components, and components into modules and vessels at a surface site, with the Orbital Maneuver Unit (airless worlds only), Ultralight and Superlight lifters, at Terra too' },
  { id: 'legs2', name: 'Heavy Landing Legs', rp: 8, needs: ['basic'], branch: 'land', gives: 'Mk2. Landing Legs: hold 60 t at 1 g' },
  { id: 'surface', name: 'Surface Science', rp: 12, needs: ['basic'], branch: 'sci', gives: 'Mk1. Science (Surface),Mk1. Science (Water), Mk1. Rover' },
  { id: 'medium', name: 'Medium Lifter', rp: 15, needs: ['basic'], branch: 'lift', gives: 'Medium lifter (25 t), Fuel Tank (20000L)' },
  { id: 'dish', name: 'Deep Space Comms', rp: 18, needs: ['basic'], branch: 'comms', gives: 'Mk1. Dish Relay: long range, relays other vessels' },
  { id: 'boosters', name: 'Boosters', rp: 20, needs: ['medium'], branch: 'lift', gives: 'Up to 4 boosters on a lifter, +20% payload each' },
  { id: 'mk2eng', name: 'Improved Engines', rp: 30, needs: ['basic'], branch: 'engines', gives: 'Mk2. Vac Engine: twice the thrust, better efficiency' },
  { id: 'hab', name: 'Crewed Flight', rp: 40, needs: ['medium'], branch: 'control', gives: 'Command Pod (2), Crew HAB (5): crewed vessels never need a signal, and their readings are worth 50% more' },
  { id: 'heavy', name: 'Heavy Lifter', rp: 50, needs: ['boosters'], branch: 'lift', gives: 'Heavy lifter (70 t), Heat Shield (L)' },
  { id: 'reuse', name: 'Reusability', rp: 60, needs: ['heavy', 'shields'], branch: 'lift', gives: 'Reusable lifters (40% of the price a launch) and reusable heat shields' },
  { id: 'ntr', name: 'Nuclear Propulsion', rp: 90, needs: ['mk2eng'], branch: 'engines', gives: 'NTR-1 Nuclear Engine: very efficient, low thrust' },
  { id: 'bigtanks', name: 'Large Tanks', rp: 45, needs: ['heavy'], branch: 'lift', gives: 'Fuel Tanks (50000L and 100000L)' },
  { id: 'chute2', name: 'Advanced Parachutes', rp: 14, needs: ['atmos'], branch: 'land', gives: 'Mk2. Parachute: lets down 20 t' },
  { id: 'tiles', name: 'Thermal Tiles', rp: 70, needs: ['reuse'], branch: 'land', gives: 'Mk1. Thermal Tiles: each covers 2 t of the vessel, they add up, and they\'re never used up' },
  { id: 'thermal', name: 'Thermal Control', rp: 16, needs: ['basic'], branch: 'power', gives: 'Mk1. Radiator: keeps 8 t of vessel cool; enough of them to cover the whole vessel let it go to Pandora' },
  { id: 'power2', name: 'Improved Solar', rp: 12, needs: ['basic'], branch: 'power', gives: 'Mk2. Solar Panel: five times the power of a Mk1.' },
  { id: 'rtg', name: 'Radioisotope Power', rp: 70, needs: ['power2', 'ntr'], branch: 'power', gives: 'RTG: steady power anywhere, however far from the star, with no fuel' },
  { id: 'comms2', name: 'Improved Comms', rp: 28, needs: ['dish'], branch: 'comms', gives: 'Mk2. Phased Array (0.5 AU), Mk2. Dish Relay (100 AU, relays)' },
];

/** First-time rewards ($M), times the body's worth. */
export const MILESTONE = { orbit: 5, land: 12, return: 8, landedReturn: 10 };
/** Research points for bringing a vessel home from a world's surface (times the world's sci), the first time. */
export const LANDED_RETURN_RP = 3;
export const MILESTONE_X = { pandora: 3.5, terra: 1, cobalt: 1, dynamis: 1, sera: 1.5, cinder: 2, palgal: 2, pal: 2.5, gal: 2.5, baja: 3, eros: 3, gaia: 3.5, tartarus: 3.5, erebus: 3.5, nyx: 3.5, onyx: 3.5, starb: 4, yalu: 5, vega: 5 };
export const START_MONEY = 30;
/** With nothing flying and less than this, the program's account is topped back up to it. */
export const FLOOR_MONEY = 12;
/** Funding that comes in on its own ($M a year): a little to start with, more for each world landed on for the first
 *  time, and more for each surface site (both times the world's worth). */
export const INCOME = { base: 4, perLanding: 6, perSite: 5 };
