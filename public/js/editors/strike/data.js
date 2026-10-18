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

/** Speeds a leg can fly at. Faster burns more and is easier to track, but gives a missile less time to reach you. */
export const SPEEDS = {
  cruise: { name: 'Cruise', kmh: 850, burn: 1.0, pk: 1.0 },
  fast: { name: 'Fast', kmh: 1050, burn: 1.3, pk: 0.92 },
  dash: { name: 'Dash', kmh: 1250, burn: 1.75, pk: 0.84 },
};
export const SPEED_ORDER = ['cruise', 'fast', 'dash'];
/** Most jets can't hold supersonic down low with bombs on. */
export const DECK_MAX_KMH = 1100;

/** The jets. cost in $M; range in km at medium altitude and cruise (out and back counts double); rcs in m² loaded. */
export const AIRCRAFT = {
  f16: { id: 'f16', name: 'F-16C Viper', cost: 35, stations: 4, range: 1500, rcs: 1.2, ecm: 0.12, cm: 0.18,
    weapons: ['harm', 'jdam', 'sdb', 'jsow', 'cbu', 'mald'], what: 'Cheap and nimble. Four bomb stations.' },
  f15e: { id: 'f15e', name: 'F-15E Strike Eagle', cost: 55, stations: 7, range: 2400, rcs: 4, ecm: 0.18, cm: 0.18,
    weapons: ['jdam', 'sdb', 'jsow', 'cbu', 'mald'], what: 'The heavy hauler: seven stations and the longest legs. A big radar return.' },
  f18e: { id: 'f18e', name: 'F/A-18E Super Hornet', cost: 45, stations: 5, range: 1700, rcs: 1.5, ecm: 0.2, cm: 0.2,
    weapons: ['harm', 'jdam', 'sdb', 'jsow', 'cbu', 'mald'], what: 'Five stations and good self-protection.' },
  ea18g: { id: 'ea18g', name: 'EA-18G Growler', cost: 65, stations: 2, range: 1600, rcs: 1.5, ecm: 0.3, cm: 0.2,
    weapons: ['harm'], jam: { km: 160, factor: 0.55, pk: 0.7 },
    what: 'Jams every radar within 160 km: they see the package later and their missiles miss more. Carries two HARMs.' },
};
export const AIRCRAFT_ORDER = ['f16', 'f18e', 'f15e', 'ea18g'];

/** What goes on a station. per = how many fit on one station. rng in km from the deck (lo) to high altitude (hi).
 *  dmg against hard targets; soft = against radars, launchers and vehicles. pd = chance a point defence can shoot it down. */
export const MUNITIONS = {
  harm: { id: 'harm', name: 'AGM-88E AARGM', short: 'HARM', kind: 'arm', per: 1, cost: 0.9, lo: 40, hi: 120, kmh: 2400,
    dmg: 0.6, soft: 1.5, pd: 0.35, what: 'Homes on a radar that’s switched on. Remembers where it was if it shuts down (less often hits then).' },
  jsow: { id: 'jsow', name: 'AGM-154C JSOW', short: 'JSOW', kind: 'glide', per: 1, cost: 0.5, lo: 22, hi: 110, kmh: 750,
    dmg: 2.2, soft: 2, pd: 0.6, what: 'A gliding bomb with a big warhead: drop it far out, at height.' },
  sdb: { id: 'sdb', name: 'GBU-39 SDB', short: 'SDB', kind: 'glide', per: 4, cost: 0.05, lo: 18, hi: 100, kmh: 750,
    dmg: 0.7, soft: 1.2, pd: 0.55, what: 'Small glide bombs, four to a station. Precise, light: plenty of them for buildings and launchers.' },
  jdam: { id: 'jdam', name: 'GBU-31 JDAM', short: 'JDAM', kind: 'bomb', per: 1, cost: 0.04, lo: 6, hi: 24, kmh: 900,
    dmg: 3, soft: 2, pd: 0.3, what: 'A 2,000 lb guided bomb. Short reach, cuts runways and cracks shelters.' },
  cbu: { id: 'cbu', name: 'CBU-87 cluster', short: 'CBU', kind: 'bomb', per: 1, cost: 0.03, lo: 3, hi: 12, kmh: 900,
    dmg: 0.2, soft: 2.5, pd: 0.25, what: 'Bomblets over an area: wrecks radars, launchers and parked vehicles, useless on concrete.' },
  mald: { id: 'mald', name: 'ADM-160 MALD', short: 'MALD', kind: 'decoy', per: 2, cost: 0.32, lo: 600, hi: 900, kmh: 900,
    dmg: 0, soft: 0, pd: 0, what: 'Decoys that look like a jet on radar: they wake the defences up and soak up their missiles.' },
};
export const MUNITION_ORDER = ['harm', 'jsow', 'sdb', 'jdam', 'cbu', 'mald'];

/** How far a weapon reaches when let go at altitude m (glide range grows with height). */
export function reach(mu, m) {
  const f = Math.max(0, Math.min(1, (m - 60) / (9000 - 60)));
  return mu.lo + (mu.hi - mu.lo) * Math.pow(f, 0.6);
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

/** The money for one mission ($M). */
export const BUDGET = { airbase: 420, sam: 380, industry: 360 };

/** Words for the objective's codename (locations only; no sides are ever named). */
export const CODEWORDS = ['GRANITE', 'ANVIL', 'KESTREL', 'SALTMARSH', 'IRONWOOD', 'BRASS', 'TALON', 'NORTHGATE', 'FLINT', 'COBALT',
  'HARROW', 'WINTERSET', 'BASALT', 'LANTERN', 'MERIDIAN', 'QUARRY', 'SPINDLE', 'TEMPEST', 'GALLOWS', 'CINDER', 'OSPREY', 'BULWARK',
  'HALBERD', 'MAGPIE', 'RAMPART', 'SEXTANT', 'THISTLE', 'VANGUARD', 'WARDEN', 'ZENITH'];
