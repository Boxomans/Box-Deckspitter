// The hidden game's tables: weapons, bandits, upgrades, rebirth perks, shapes, and small helpers.

/** F-14 top-view silhouette, 100×100 (the same shape is the 'f14' icon in core/icons.js). */
export const F14_PATH = 'M50 1L52.6 18L53 30L57 30L57 36L65 56L97 65.5L99 70.5L64 72L64 78L74 92L67 96L62 91.5L58 96L54 92L51 96.5L50 99' +
  'L49 96.5L46 92L42 96L38 91.5L33 96L26 92L36 78L36 72L1 70.5L3 65.5L35 56L43 36L43 30L47 30L47.4 18Z';

// ===== Radar / flight model =====
export const PANEL_W = 360;
export const BSCOPE_SIZE = 260;
export const MARGIN = 18;
export const RADAR_RANGE_KM = 185; // ~100 nm
export const KILL_RANGE_KM = 20; // a bandit this close has merged: dogfight
// the merge: after a 3 s countdown, click DOGFIGHT_CLICKS times in DOGFIGHT_S seconds (real time) to get guns on it,
// then a 50/50 roll decides it
export const DOGFIGHT_S = 3;
export const DOGFIGHT_COUNTDOWN = 3; // a 3-2-1 to get your hand on the mouse first
export const DOGFIGHT_CLICKS = 15;
export const MACH1_KMPS = 0.343;
export const OWN_SPEED = MACH1_KMPS * 1.0;
export const PLAYER_ALT_FT = 30000;
export const MIN_ALT_M = 5000 * 0.3048;
export const MAX_ALT_M = 15000;
export const M_TO_FT = 3.28084;
export const KTS_PER_KMPS = 1943.844;
export const KM_PER_NM = 1.852;
export const AZ_LIMIT = Math.PI / 4; // ±45° azimuth
export const KILL_RADIUS_KM = 0.35;
export const MONO = 'ui-monospace, "IBM Plex Mono", Consolas, monospace';

export const MISSILES = {
  'FOX-1': { code: 'FOX-1', name: 'AIM-7R (IR Sparrow)', short: 'AIM-7R', max: 4, regen: 20, speedMach: 5.0, rMaxKm: 100, guidance: 'SARH_IR', activeKm: 0, turnRateDps: 20, notes: 'Cancelled IR-homing Sparrow concept; mid-course like Sparrow, IR terminal.' },
  'FOX-2': { code: 'FOX-2', name: 'AIM-9X (IR)', short: 'AIM-9X', max: 8, regen: 10, speedMach: 3.5, rMaxKm: 50, guidance: 'IR', activeKm: 0, turnRateDps: 45, notes: 'High-agility short-range IR WVR missile.' },
  'FOX-3': { code: 'FOX-3', name: 'AIM-54F (Active RADAR)*', short: 'AIM-54F', max: 4, regen: 30, speedMach: 6.0, rMaxKm: 200, guidance: 'ARH', activeKm: 50, turnRateDps: 18, notes: 'Hypothetical Phoenix variant; placeholder specs.' },
};
export const HOSTILE_MISSILES = {
  'PL-21': { speedMach: 8.5, turnRateDps: 18 },
  'PL-15': { speedMach: 5.0, turnRateDps: 22 },
};
// points and $ per kill
export const INCOME = 0.5; // $ per kill is half the bounty below
/** Hours in the air pay: +25% $ per kill for every 100 hours logged (playTime is in seconds). */
export const veteranPay = (playTime) => 1 + 0.25 * Math.floor((playTime || 0) / 360000);
export const BOUNTY = { 'J-11': [100, 10], 'J-36': [150, 15], 'H-20': [2000, 200], 'PL-15': [50, 5], 'PL-21': [80, 8] };
export const NOTCH_HOLD = 5; // seconds without firing after a notch
// missiles don't always kill: a target breaks hard as one closes in (the seeker has to out-turn it), and a fuse can dud
export const JINK_KM = 6; // the target sees it coming and breaks
export const AGILITY = { 'J-11': 1, 'J-36': 0.8, 'H-20': 0.3, 'PL-15': 0.5, 'PL-21': 0.4 };
export const overshootChance = (agility, turnDps) => clamp(0.25 * agility * (20 / turnDps) ** 2, 0.02, 0.6);
export const dudChance = (fuseLevel) => Math.max(0.02, 0.15 - 0.025 * fuseLevel);
export const SPEEDS = [1, 2, 3];
/** The speeds on offer: 4× and 5× come with the Time compression perk (level 1 and 2). */
export const speedsFor = (perks) => [...SPEEDS, ...[4, 5].slice(0, clamp(perks?.warp || 0, 0, 2))];
export const MAGAZINE_STEP = { 'FOX-1': 1, 'FOX-2': 2, 'FOX-3': 1 };
/**
 * Hangar upgrades: each level costs base·growth^level (growth 1.6 unless given). max Infinity: no cap.
 * `rebirth: n`: only in the hangar once you've reborn n times.
 */
export const UPGRADES = [
  { id: 'reload', name: 'Reload crews', what: 'Missiles come back 10% faster per level', base: 60, max: 5 },
  { id: 'magazine', name: 'Extra rails', what: '+1 AIM-7R, +2 AIM-9X, +1 AIM-54F per level', base: 120, max: 3 },
  { id: 'motor', name: 'Hotter motors', what: 'Missiles fly 8% faster per level', base: 80, max: 5 },
  { id: 'seeker', name: 'Better seekers', what: 'Missiles turn 10% harder per level: fewer overshoots on jinking targets', base: 80, max: 5 },
  { id: 'fuse', name: 'Proximity fuses', what: 'Fuses 15% wider and fewer duds per level', base: 80, max: 5 },
  { id: 'reach', name: 'Longer burn', what: 'Missiles reach 10% further per level', base: 100, max: 5 },
  { id: 'flares', name: 'Bigger dispenser', what: '+2 chaff/flares and 15% faster reload per level', base: 90, max: 3 },
  { id: 'notch', name: 'Beam training', what: 'Notch is ready 10% sooner per level', base: 110, max: 5 },
  { id: 'ecm', name: 'ECM pod', what: '+6% enemy missile duds per level, on top of their own dud rate', base: 150, max: 5 },
  { id: 'contracts', name: 'Defense contracts', what: '+10% $ from every kill per level. No limit.', base: 200, max: Infinity, growth: 1.35 },
  { id: 'armor', name: 'Armor plating', what: 'Shrug off one missile hit per sortie per level', base: 2500, max: 3, rebirth: 1 },
  { id: 'wingman', name: 'Loyal Wingman', what: 'FQ-50A ‘Goose’ drones on your wing: 3 AIM-9X each, reloaded one at a time, 20 s a missile. Level 2 adds one on the other side.', base: 300000, growth: 2, max: 2 },
];
export const upgradeCost = (u, level) => Math.round(u.base * (u.growth || 1.6) ** level);
/**
 * Rebirth: trade the $ and every upgrade for tokens. The price doubles each time ($1M, $2M, $4M…) and so does the
 * payout (1, 2, 4… tokens). Tokens buy perks in the rebirth shop, which are kept through later rebirths.
 */
export const REBIRTH_AT = 1_000_000;
export const rebirthCost = (rebirths = 0) => REBIRTH_AT * 2 ** rebirths;
export const rebirthTokens = (rebirths = 0) => 2 ** rebirths;
/** Rebirth-shop perks, bought with tokens: level n costs cost(n) tokens. */
export const PERKS = [
  { id: 'favor', name: 'Admiral’s favor', what: '+10% $ from every kill per level, on top of Defense contracts. Kept through rebirths. No limit.', max: Infinity, cost: (level) => level + 1 },
  { id: 'heater', name: 'Heater bay', what: 'Doubles your total AIM-9X count (Extra rails included). Kept through rebirths.', max: 1, cost: () => 3 },
  { id: 'warp', name: 'Time compression', what: 'Level 1 adds 4× speed, level 2 adds 5× (T or the speed button). Kept through rebirths.', max: 2, cost: (level) => [4, 8][level] },
];
export const unlockedUpgrades = (rebirths = 0) => UPGRADES.filter((u) => (u.rebirth || 0) <= rebirths);
export const nextUnlock = (rebirths = 0) => UPGRADES.filter((u) => (u.rebirth || 0) > rebirths).sort((a, b) => a.rebirth - b.rebirth)[0] || null;

export const BANDIT_TYPES = [
  { name: 'J-36', mach: 3.0, spawnMin: 180, spawnMax: 185 },
  { name: 'J-11', mach: 2.0, spawnMin: 118, spawnMax: 122 },
];
// the H-20: a stealth bomber, for sure every 5 minutes on the sortie clock, plus a small chance every minute after 15:00
export const H20 = { name: 'H-20', mach: 0.85, spawnMin: 150, spawnMax: 155, every: 300, randomFrom: 900, perMinute: 0.08, launchKm: 140, salvos: 2, gap: 18 };
export const H20_FAINT_KM = 60; // stealthy: a faint, flickering return until it's this close
export const H20_COLOR = '#c99bff';

// Loyal Wingman: FQ-50A 'Goose' drones either side of you, each with its own AIM-9Xs that reload one at a time
export const DRONE_AMMO = 3, DRONE_RELOAD = 20, DRONE_GAP = 1.5; // missiles, s per missile, s between one drone's shots
// a Ghost Bat-style drone from above (a 100-unit box, nose at the top): chined nose, swept wing, canted tails
export const GOOSE_HALF = [[50, 2], [55, 12], [62, 26], [65, 40], [96, 56], [96, 62], [66, 65], [64, 74], [82, 84], [80, 90], [62, 84], [58, 96], [50, 94]];
export const GOOSE_PATH = 'M' + [...GOOSE_HALF, ...GOOSE_HALF.slice(1, -1).reverse().map(([x, y]) => [100 - x, y])].map(([x, y]) => `${x} ${y}`).join('L') + 'Z';
export const GOOSE_NOSE = 'M50 2L55 12L45 12Z';

export const rand = (a, b) => a + Math.random() * (b - a);
export const rad = (d) => (d * Math.PI) / 180;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const inRect = (x, y, r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
export const pad2 = (n) => String(n).padStart(2, '0');
export function angNorm(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
export function shortCode(name) { const m = /AIM-(\d+)([A-Z]+)/.exec(name); return m ? m[1] + m[2] : name; }
export function clock(t) { const m = Math.floor(t / 60); const s = Math.floor(t % 60); const cs = Math.floor((t - Math.floor(t)) * 100); return `${pad2(m)}:${pad2(s)}.${pad2(cs)}`; }
