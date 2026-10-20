// Deep Strike's numbers: the jets you can send, what they carry, and the air defences they fly against. Simplified
// from public figures; ranges are what the game uses, not exact performance.

/** Altitude bands a route leg can fly at (metres above the ground). */
export const ALTS = {
  deck: { name: 'Deck', m: 60, burn: 1.7, tip: 'Hugging the ground: under most radar until it’s close, but slow and thirsty' },
  low: { name: 'Low', m: 300, burn: 1.4, tip: 'Low level: still hidden behind the earth’s curve from far-off radars' },
  med: { name: 'Medium', m: 4500, burn: 1.0, tip: 'Medium altitude: seen from far away, weapons reach further' },
  high: { name: 'High', m: 9000, burn: 0.85, tip: 'High: seen from very far, longest weapon reach, least fuel' },
};
export const ALT_ORDER = ['deck', 'low', 'med', 'high'];

/** Speeds a leg can fly at. Faster burns more and is easier to track, but gives a missile less time to reach you.
 *  kmh here is the reference; each jet has its own (AIRCRAFT kmh) and the package flies at its slowest jet's. */
export const SPEEDS = {
  cruise: { name: 'Cruise', kmh: 850, burn: 1.0, pk: 1.0 },
  fast: { name: 'Fast', kmh: 1050, burn: 1.3, pk: 0.92 },
  dash: { name: 'Dash', kmh: 1250, burn: 1.75, pk: 0.84 },
};
export const SPEED_ORDER = ['cruise', 'fast', 'dash'];
/** Most jets can't hold supersonic down low with bombs on. */
export const DECK_MAX_KMH = 1100;

/** The jets. cost in $M; range in km at medium altitude and cruise (out and back counts double); rcs in m² loaded;
 *  lo (stealth) scales a missile's chance against it, since its seeker struggles to hold a lock; bay = how many
 *  stations' worth each of its stations carries (a bomber's bays); radar.km = what its own radar sees of a 5 m² fighter (none: it can't
 *  aim air-to-air missiles, though heat-seekers still go at close range); points = what one airframe costs in the hangar:
 *  it's kept from mission to mission (still paid for from each mission's budget) until it's lost (see strike/badges.js).
 *  tank = how much one drop tank adds to its fuel (1 = its internal fuel), tanks = how many it carries at most. */
export const AIRCRAFT = {
  f16: { id: 'f16', name: 'F-16C Viper', cost: 35, stations: 4, kmh: { cruise: 850, fast: 1050, dash: 1250 }, range: 1500, rcs: 1.2, ecm: 0.12, cm: 0.18, radar: { km: 110 }, tank: 0.3, tanks: 2,
    weapons: ['harm', 'jdam', 'jdamer', 'sdb', 'jsow', 'agm130', 'mako', 'cbu', 'mald', 'aim120', 'aim9x', 'tank'], what: 'Cheap and nimble. Four bomb stations.',
    good: 'Cheap HARM shooter and package filler: hunts radars for little money', bad: 'Only four stations, short legs and a small radar' },
  f15e: { id: 'f15e', name: 'F-15E Strike Eagle', cost: 55, points: 100, stations: 7, kmh: { cruise: 870, fast: 1100, dash: 1400 }, range: 2400, rcs: 4, ecm: 0.18, cm: 0.18, radar: { km: 150 }, tank: 0.15, tanks: 3,
    weapons: ['jdam', 'jdamer', 'sdb', 'jsow', 'agm130', 'mako', 'cbu', 'mald', 'aim120', 'aim9x', 'tank'], what: 'The heavy hauler: seven stations and the longest legs. A big radar return.',
    good: 'Hauling bombs a long way: most stations of any fighter, fastest dash, longest range', bad: 'The biggest radar return: SAMs see it first. No HARMs. Costs hangar points' },
  f18e: { id: 'f18e', name: 'F/A-18E Super Hornet', cost: 45, stations: 5, kmh: { cruise: 820, fast: 1000, dash: 1150 }, range: 1700, rcs: 1.5, ecm: 0.2, cm: 0.2, radar: { km: 120 }, tank: 0.2, tanks: 2,
    weapons: ['harm', 'jdam', 'jdamer', 'sdb', 'jsow', 'agm130', 'mako', 'cbu', 'mald', 'aim120', 'aim9x', 'tank'], what: 'Five stations and good self-protection.',
    good: 'All-rounder that survives: strong jammer and decoys, carries HARMs and bombs', bad: 'The slowest fighter at full speed, and middling range' },
  ea18g: { id: 'ea18g', name: 'EA-18G Growler', cost: 65, stations: 2, kmh: { cruise: 800, fast: 960, dash: 1100 }, range: 1600, rcs: 1.5, ecm: 0.3, cm: 0.2, tank: 0.2, tanks: 2,
    weapons: ['harm', 'pod', 'tank'], jam: { km: 160, factor: 0.55, pk: 0.7 },
    what: 'Jams every radar within 160 km: they see the package later and their missiles miss more. Two stations: HARMs, or the NGJ pod that blinds one site outright.',
    good: 'Protecting the whole package: its jamming helps every jet near it', bad: 'Carries no bombs and no air-to-air missiles; only two stations. Expensive for what it drops' },
  f35a: { id: 'f35a', name: 'F-35A Lightning II', cost: 80, points: 300, stations: 4, kmh: { cruise: 880, fast: 1080, dash: 1300 }, range: 2200, rcs: 0.005, ecm: 0.25, cm: 0.18, lo: 0.55, radar: { km: 170 },
    weapons: ['aargmer', 'jdam', 'sdb', 'jsow', 'mako', 'aim120', 'aim9x'],
    what: 'A stealth fighter: four stations, all in its bays. Radars see it at about a fifth of the range they see an F-16, and their missiles lock on less well. Less stealthy than the B-21, but it keeps up with fighters.',
    good: 'Getting in unseen, and the best radar for air-to-air', bad: 'Only four stations, no cluster bombs, and its only anti-radar missile is the pricey AARGM-ER. Pricey itself, and costs hangar points' },
  b21: { id: 'b21', name: 'B-21 Raider', cost: 700, points: 800, stations: 8, bay: 2, kmh: { cruise: 850, fast: 920, dash: 980 }, range: 9000, rcs: 0.001, ecm: 0.3, cm: 0.15, lo: 0.4,
    weapons: ['jdam', 'sdb', 'jsow', 'cbu'],
    what: 'Stealth bomber. Eight bays, each carrying twice what a fighter’s station does, and the range to reach anything. Radars see it at about an eighth of a fighter’s range, and their missiles struggle to hold a lock. Subsonic: it slows any package it flies with, and the jets with it can still be seen. Costs more than a normal mission’s whole budget.',
    good: 'The stealthiest, the biggest bomb load and the range to reach anything', bad: 'Slow (subsonic), no air-to-air at all, large missions only' },
};
export const AIRCRAFT_ORDER = ['f16', 'f18e', 'f15e', 'f35a', 'ea18g', 'b21'];
/** How fast a package of these jet types flies at a speed setting: as fast as its slowest jet. */
export const packageKmh = (types, spd) => (types.length ? Math.min(...types.map((t) => AIRCRAFT[t].kmh[spd])) : SPEEDS[spd].kmh);

/** What goes on a station. per = how many fit on one station. rng in km from the deck (lo) to high altitude (hi).
 *  dmg against hard targets; soft = against radars, launchers and vehicles. pd = chance a point defence can shoot it down. */
export const MUNITIONS = {
  harm: { id: 'harm', name: 'AGM-88E AARGM', short: 'HARM', kind: 'arm', per: 1, cost: 0.9, lo: 40, hi: 120, kmh: 2400,
    dmg: 0.6, soft: 1.5, pd: 0.35, what: 'Homes on a radar that’s switched on. Remembers where it was if it shuts down (less often hits then).' },
  aargmer: { id: 'aargmer', name: 'AGM-88G AARGM-ER', short: 'AARGM-ER', kind: 'arm', gps: true, per: 1, cost: 1.9, lo: 70, hi: 230, kmh: 3700,
    dmg: 0.8, soft: 1.6, pd: 0.25, what: 'The long-range AARGM, made to fit the F-35A’s bay: twice the reach of a HARM, and faster. Radar mode homes on a radar that’s switched on, like a HARM. INS/GPS mode flies to a target you pick, on or off the air, like a guided bomb.' },
  jsow: { id: 'jsow', name: 'AGM-154C JSOW', short: 'JSOW', kind: 'glide', per: 1, cost: 0.5, lo: 22, hi: 110, kmh: 750,
    dmg: 2.2, soft: 2, pd: 0.6, what: 'A gliding bomb with a big warhead: drop it far out, at height.' },
  agm130: { id: 'agm130', name: 'AGM-130', short: 'AGM-130', kind: 'missile', per: 1, cost: 0.7, lo: 40, hi: 100, kmh: 1100,
    dmg: 3, soft: 2, pd: 0.4, lr: { km: 45, pk: 0.4, shots: 1 }, what: 'A 2,000 lb bomb with a rocket motor: about 100 km from height, and still 40 km off the deck since the rocket carries it, not the glide. Faster than a JSOW, so point defences get fewer shots at it, but it’s big and not stealthy: once the defences are awake, S-300s and S-400s covering the target shoot at it on the way in. Too big for a stealth jet’s bay.' },
  sdb: { id: 'sdb', name: 'GBU-39 SDB', short: 'SDB', kind: 'glide', per: 4, cost: 0.05, lo: 18, hi: 100, kmh: 750,
    dmg: 0.7, soft: 1.2, pd: 0.55, what: 'Small glide bombs, four to a station. Precise, light: plenty of them for buildings and launchers.' },
  jdam: { id: 'jdam', name: 'GBU-31 JDAM', short: 'JDAM', kind: 'bomb', per: 1, cost: 0.04, lo: 6, hi: 24, kmh: 900,
    dmg: 3, soft: 2, pd: 0.3, what: 'A 2,000 lb guided bomb. Short reach, cuts runways and cracks shelters.' },
  mako: { id: 'mako', name: 'Mako hypersonic missile', short: 'MAKO', kind: 'missile', arc: true, lr: { km: 90, pk: 0.3, wakes: true }, per: 1, cost: 3, points: 40, lo: 120, hi: 300, kmh: 6200,
    dmg: 1.2, soft: 1.8, pd: 0.08, what: 'Rocket-boosted, Mach 5 and up, manoeuvring high: point defences barely get a shot at it, but its arc lights up S-300 and S-400 radars from far off and they will try to intercept it. A small warhead, so it’s for radars, launchers and command posts more than concrete. One to a station, and it fits a stealth jet’s bay. Very expensive.' },
  jdamer: { id: 'jdamer', name: 'GBU-31 JDAM-ER', short: 'JDAM-ER', kind: 'glide', per: 1, cost: 0.15, lo: 10, hi: 72, kmh: 750,
    dmg: 3, soft: 2, pd: 0.45, what: 'The 2,000 lb JDAM with a wing kit: the same punch, glided in from far out. Needs height to reach; slower, so point defences get more shots at it.' },
  cbu: { id: 'cbu', name: 'CBU-87 cluster', short: 'CBU', kind: 'bomb', per: 1, cost: 0.03, lo: 3, hi: 12, kmh: 900,
    dmg: 0.2, soft: 2.5, pd: 0.25, what: 'Bomblets over an area: wrecks radars, launchers and parked vehicles, useless on concrete.' },
  tank: { id: 'tank', name: 'External fuel tank', short: 'Drop tank', kind: 'tank', per: 1, cost: 0.05, dmg: 0, soft: 0, pd: 0,
    what: 'More fuel for a longer route: the jet burns it first and drops the empty tank. Two to a jet at most (three on the F-15E). Not on the stealth jets: it would spoil their stealth.' },
  pod: { id: 'pod', name: 'AN/ALQ-249 NGJ pod', short: 'NGJ', kind: 'pod', per: 1, cost: 6, points: 150, km: 250, max: 2,
    dmg: 0, soft: 0, pd: 0, what: 'Offensive jamming pod, Growler only: one fewer per strike than the mission has long-range SAM sites (S-300, S-400), two at most. Pick a site: once the Growler is within 250 km its radars go blind (no seeing, no warning the network, no shooting) and stay blind until that Growler is shot down.' },
  aim120: { id: 'aim120', name: 'AIM-120D AMRAAM', short: 'AMRAAM', kind: 'aam', per: 2, cost: 1.1, lo: 35, hi: 120, kmh: 4500, pk: 0.6, pitbull: 20,
    dmg: 0, soft: 0, pd: 0, what: 'Radar-guided air-to-air missile, two to a station. Goes by itself at an enemy fighter the jet’s radar holds within reach; the radar has to keep holding it until the missile’s own seeker takes over in the last 20 km.' },
  aim9x: { id: 'aim9x', name: 'AIM-9X Sidewinder', short: 'AIM-9X', kind: 'aam', per: 2, cost: 0.45, lo: 12, hi: 20, kmh: 3000, pk: 0.75, ir: true,
    dmg: 0, soft: 0, pd: 0, what: 'Heat-seeking dogfight missile, two to a station: short reach, but fire and forget, and it needs no radar inside 15 km.' },
  mald: { id: 'mald', name: 'ADM-160 MALD', short: 'MALD', kind: 'decoy', per: 2, cost: 0.32, lo: 600, hi: 900, kmh: 900,
    dmg: 0, soft: 0, pd: 0, what: 'Decoys that look like a jet on radar: they wake the defences up and soak up their missiles.' },
};
/** The Tomahawk: fired from a ship's launch cells (never from a jet), a salvo at a whole site. It flies low, so
 *  point defences get a go at it like any other weapon. Not on the mission's budget: the fleet refills its cells
 *  with points (SHIP_REFILL). */
export const TLAM = { id: 'tlam', name: 'BGM-109 Tomahawk Block IV', short: 'TLAM', kind: 'cruise', per: 1, cost: 0, lo: 1600, hi: 1600, kmh: 880,
  dmg: 1.6, soft: 2, pd: 0.3, what: 'Land attack cruise missile: 1,600 km, subsonic, terrain-following. A salvo sends enough at every part of a site to destroy it, if they get through.' };
MUNITIONS.tlam = TLAM;

/** The fleet's ships, bought with points (SHIP_SELL back): their Aegis radar and Standard missiles shoot down enemy
 *  fighters that come within reach once the defences are awake (or the fighters are chasing), and their launch cells
 *  hold Tomahawks for salvos at sites. Ships come fully loaded; what they fire is gone until refilled with points. */
export const SHIPS = {
  ddg: { id: 'ddg', name: 'Arleigh Burke-class destroyer', short: 'DDG', points: 750, cells: 96, tlam: 32, sm: 64,
    radar: { name: 'AN/SPY-1D', km: 320, h: 30 }, missile: { name: 'SM-2', km: 160, kmh: 3500, pk: 0.6, pitbull: 0 }, ch: 3 },
  cg: { id: 'cg', name: 'Ticonderoga-class cruiser', short: 'CG', points: 1000, cells: 122, tlam: 40, sm: 82,
    radar: { name: 'AN/SPY-1B', km: 340, h: 35 }, missile: { name: 'SM-6', km: 240, kmh: 4200, pk: 0.62, pitbull: 20 }, ch: 4 },
};
export const SHIP_ORDER = ['ddg', 'cg'];
/** Ships at most in the fleet; points to refill one missile; how near an enemy site a ship may sit (km). */
export const SHIP_MAX = 2;
export const SHIP_REFILL = { tlam: 5, sm: 3 };
export const SHIP_STANDOFF = 150;
/** A sold ship pays back half its price. */
export const shipRefund = (type) => Math.floor(SHIPS[type].points / 2);

/** Munitions bought one at a time in the hangar (points), like the hangar jets. */
export const HANGAR_MUNITIONS = ['mako', 'pod'];
export const MUNITION_ORDER = ['harm', 'aargmer', 'mako', 'agm130', 'jsow', 'sdb', 'jdamer', 'jdam', 'cbu', 'mald', 'aim120', 'aim9x', 'tank'];
/** Drop tanks on a jet's stations, and its fuel with them (1 = internal only). */
export const tanksOn = (stations) => stations.filter((s) => s.mu === 'tank').length;
export const fuelCap = (type, stations) => 1 + (AIRCRAFT[type].tank || 0) * tanksOn(stations);
/** A station that homes on radars (a HARM, or an AARGM-ER in radar mode) rather than flying to a set target. */
export const homes = (st) => MUNITIONS[st?.mu]?.kind === 'arm' && !st.gps;
/** Weapons with nothing to aim at on the ground: decoys, and air-to-air missiles (they pick their own fighter). */
export const untargeted = (id) => id === 'mald' || id === 'tank' || MUNITIONS[id]?.kind === 'aam';

/** How far a weapon reaches when let go at altitude m and kmh (glide range grows with height, and with release speed:
 *  +10% at Fast, +20% at Dash over Cruise). */
export function reach(mu, m, kmh = 850) {
  const f = Math.max(0, Math.min(1, (m - 60) / (9000 - 60)));
  return (mu.lo + (mu.hi - mu.lo) * Math.pow(f, 0.6)) * (1 + Math.max(0, kmh - 850) / 2000);
}

/** Air defence systems. radar.km is what it sees of a 5 m² jet; h is the antenna height. missile.km at altitude;
 *  min = lowest it can engage (m). ch = targets it can engage at once. pd = shoots down incoming bombs and missiles. */
export const SAMS = {
  s400: { id: 's400', name: 'S-400', long: 'S-400 Triumf', ring: 'long',
    search: { name: '91N6E', km: 450, h: 25 }, fc: { name: '92N6E', km: 260, h: 25 },
    missile: { km: 200, min: 10, kmh: 5500, pk: 0.62 }, ch: 4, launchers: [6, 8], per: 4, salvo: 2, pd: 0.15 },
  s300: { id: 's300', name: 'S-300', long: 'S-300PM2', ring: 'long',
    search: { name: '64N6E', km: 300, h: 22 }, fc: { name: '30N6E', km: 200, h: 25 },
    missile: { km: 150, min: 25, kmh: 6000, pk: 0.58 }, ch: 3, launchers: [4, 6], per: 4, salvo: 2, pd: 0.1 },
  buk: { id: 'buk', name: 'Buk', long: 'Buk-M2', ring: 'medium', mobile: true,
    search: { name: '9S18M1', km: 160, h: 8 }, fc: { name: '9S36', km: 90, h: 21 },
    missile: { km: 45, min: 15, kmh: 3600, pk: 0.6 }, ch: 2, launchers: [3, 4], per: 4, salvo: 1, pd: 0.2, quiet: true },
  tor: { id: 'tor', name: 'Tor', long: 'Tor-M2', ring: 'short', mobile: true,
    search: { name: 'Tor search', km: 32, h: 6 }, fc: { name: 'Tor tracking', km: 25, h: 6 },
    missile: { km: 15, min: 10, kmh: 3000, pk: 0.55 }, ch: 2, launchers: [1, 2], per: 16, salvo: 1, pd: 0.6, quiet: true },
  pantsir: { id: 'pantsir', name: 'Pantsir', long: 'Pantsir-S1', ring: 'short', mobile: true,
    search: { name: 'Pantsir search', km: 36, h: 6 }, fc: { name: 'Pantsir tracking', km: 28, h: 6 },
    missile: { km: 20, min: 15, kmh: 4000, pk: 0.5 }, ch: 2, launchers: [1, 2], per: 12, salvo: 1, pd: 0.55, quiet: true },
};

/** Enemy fighters flying combat air patrol: rcs in m², radar.km = what it sees of a 5 m² jet, missiles each,
 *  lo scales a missile's chance against it. The Su-57 is a long way short of an F-35's stealth. */
export const FIGHTERS = {
  su35: { id: 'su35', name: 'Su-35S', rcs: 3, kmh: { cap: 850, dash: 1400 }, radar: { name: 'Irbis-E', km: 220 }, missiles: 6, ecm: 0.15, cm: 0.15 },
  su57: { id: 'su57', name: 'Su-57', rcs: 0.5, kmh: { cap: 900, dash: 1500 }, radar: { name: 'N036', km: 240 }, missiles: 6, ecm: 0.2, cm: 0.18, lo: 0.9 },
};
/** Their air-to-air missile: active radar seeker inside pitbull km; the fighter's radar guides it until then. Reach
 *  from lo (down low) to hi (high), like ours (see aamReach). */
export const R77 = { name: 'R-77-1', lo: 30, hi: 80, kmh: 4000, pk: 0.55, pitbull: 20 };
/** How far an air-to-air missile reaches: the shooter's height and speed, cut short when the target is lower
 *  (it has to dive into thick air). A higher target gives nothing back, so height stays the shooter's advantage. */
export const aamReach = (mu, shooterAlt, targetAlt, kmh) => reach(mu, Math.min(shooterAlt, 0.6 * shooterAlt + 0.4 * targetAlt), kmh);
/** How far a jet's radar warning receiver picks up a radar, against how far that radar sees a 5 m² jet. */
export const RWR_GAIN = 1.2;

/** An airfield's own surveillance radar: part of the network (it raises the alarm) but has no missiles. */
export const AIRFIELD_RADAR = { name: 'P-18', km: 250, h: 12 };

/** How far a radar picks up its own emissions on the sniffer: an ELINT jet hears a radar much further than the radar sees. */
export const ELINT_GAIN = 1.6;

/** The sniffer (ELINT jet). */
export const SNIFFER = { name: 'RC-135V Rivet Joint', kmh: 800, m: 10500, rcs: 60, pk: 0.9 };

/** Kinds of target inside a site: hp to destroy, and whether it's hard (concrete) or soft (radars, vehicles). */
export const TARGETS = {
  runway: { name: 'Runway', hard: true },
  entrance: { name: 'Taxiway entrance', hp: 1.8, hard: true },
  has: { name: 'Hardened shelter', hp: 2.6, hard: true },
  hangar: { name: 'Hangar', hp: 1.8, hard: false },
  command: { name: 'Command building', hp: 2.4, hard: true },
  fuel: { name: 'Fuel depot', hp: 1.4, hard: false },
  ammo: { name: 'Ammunition store', hp: 2, hard: true },
  search: { name: 'Search radar', hp: 1, hard: false, radar: 'search' },
  fc: { name: 'Engagement radar', hp: 1, hard: false, radar: 'fc' },
  launcher: { name: 'Launcher', hp: 1, hard: false },
  telar: { name: 'TELAR (radar and missiles)', hp: 1, hard: false, radar: 'fc' },
  tlar: { name: 'Launcher vehicle (radar and missiles)', hp: 1, hard: false, radar: 'both' },
  post: { name: 'Command post', hp: 1.6, hard: false },
  hall: { name: 'Factory hall', hp: 3, hard: true },
  power: { name: 'Power plant', hp: 2.2, hard: false },
  tank: { name: 'Storage tanks', hp: 1.4, hard: false },
};
/** A runway's hp by length: more craters to close a longer one. */
export const RUNWAY_HP = { S: 3, M: 4.5, L: 6 };
export const RUNWAY_LEN = { S: 1800, M: 2500, L: 3200 };

/** The money for one mission ($M). A large mission (a bigger network) gets LARGE_BUDGET times as much, a small one
 *  (a few sites) SMALL_BUDGET times. */
export const BUDGET = { airbase: 420, sam: 380, industry: 360 };
export const LARGE_BUDGET = 3;
export const SMALL_BUDGET = 0.4;

/** Words for the objective's codename (locations only; no sides are ever named). */
export const CODEWORDS = ['GRANITE', 'ANVIL', 'KESTREL', 'SALTMARSH', 'IRONWOOD', 'BRASS', 'TALON', 'NORTHGATE', 'FLINT', 'COBALT',
  'HARROW', 'WINTERSET', 'BASALT', 'LANTERN', 'MERIDIAN', 'QUARRY', 'SPINDLE', 'TEMPEST', 'GALLOWS', 'CINDER', 'OSPREY', 'BULWARK',
  'HALBERD', 'MAGPIE', 'RAMPART', 'SEXTANT', 'THISTLE', 'VANGUARD', 'WARDEN', 'ZENITH'];
