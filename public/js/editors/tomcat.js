// F-14F Super Tomcat: an AWG-9 B-scope intercept game, the easter egg behind Settings → Easter eggs.
// Ported from boxbind's original single-page game and built on: the ownship is a Tomcat now, there's a
// pause, a missile-launch warning, contacts marked when they're in range, waves that get harder the longer
// you last, and stats (best time, splashes) kept in settings for the badges to come.

import { BaseEditor } from './base.js';
import { h } from '../core/dom.js';

/** F-14 top-view silhouette, 100×100 (the same shape is the 'f14' icon in core/icons.js). */
export const F14_PATH = 'M50 1L52.6 18L53 30L57 30L57 36L65 56L97 65.5L99 70.5L64 72L64 78L74 92L67 96L62 91.5L58 96L54 92L51 96.5L50 99' +
  'L49 96.5L46 92L42 96L38 91.5L33 96L26 92L36 78L36 72L1 70.5L3 65.5L35 56L43 36L43 30L47 30L47.4 18Z';

// ===== Radar / flight model =====
const PANEL_W = 360;
const BSCOPE_SIZE = 260;
const MARGIN = 18;
const RADAR_RANGE_KM = 185; // ~100 nm
const KILL_RANGE_KM = 20; // a bandit this close has merged: game over
const MACH1_KMPS = 0.343;
const OWN_SPEED = MACH1_KMPS * 1.0;
const PLAYER_ALT_FT = 30000;
const MIN_ALT_M = 5000 * 0.3048;
const MAX_ALT_M = 15000;
const M_TO_FT = 3.28084;
const KTS_PER_KMPS = 1943.844;
const KM_PER_NM = 1.852;
const AZ_LIMIT = Math.PI / 4; // ±45° azimuth
const KILL_RADIUS_KM = 0.35;
const MONO = 'ui-monospace, "IBM Plex Mono", Consolas, monospace';

const MISSILES = {
  'FOX-1': { code: 'FOX-1', name: 'AIM-7R (IR Sparrow)', short: 'AIM-7R', max: 4, regen: 20, speedMach: 5.0, rMaxKm: 100, guidance: 'SARH_IR', activeKm: 0, turnRateDps: 20, notes: 'Cancelled IR-homing Sparrow concept; mid-course like Sparrow, IR terminal.' },
  'FOX-2': { code: 'FOX-2', name: 'AIM-9X (IR)', short: 'AIM-9X', max: 8, regen: 10, speedMach: 3.5, rMaxKm: 50, guidance: 'IR', activeKm: 0, turnRateDps: 45, notes: 'High-agility short-range IR WVR missile.' },
  'FOX-3': { code: 'FOX-3', name: 'AIM-54F (Active RADAR)*', short: 'AIM-54F', max: 4, regen: 30, speedMach: 6.0, rMaxKm: 200, guidance: 'ARH', activeKm: 50, turnRateDps: 18, notes: 'Hypothetical Phoenix variant; placeholder specs.' },
};
const HOSTILE_MISSILES = {
  'PL-21': { speedMach: 8.5, turnRateDps: 18 },
  'PL-15': { speedMach: 5.0, turnRateDps: 22 },
};
// points and $ per kill
const BOUNTY = { 'J-11': [100, 10], 'J-36': [150, 15], 'PL-15': [50, 5], 'PL-21': [80, 8] };
const NOTCH_HOLD = 5; // seconds without firing after a notch
// missiles don't always kill: a target breaks hard as one closes in (the seeker has to out-turn it), and a fuse can dud
const JINK_KM = 6; // the target sees it coming and breaks
const AGILITY = { 'J-11': 1, 'J-36': 0.8, 'PL-15': 0.5, 'PL-21': 0.4 };
const overshootChance = (agility, turnDps) => clamp(0.25 * agility * (20 / turnDps) ** 2, 0.02, 0.6);
const dudChance = (fuseLevel) => Math.max(0.02, 0.15 - 0.025 * fuseLevel);
export const SPEEDS = [1, 2, 3];
const MAGAZINE_STEP = { 'FOX-1': 1, 'FOX-2': 2, 'FOX-3': 1 };
/** Hangar upgrades: each level costs base·1.6^level. */
export const UPGRADES = [
  { id: 'reload', name: 'Reload crews', what: 'Missiles come back 10% faster per level', base: 60, max: 5 },
  { id: 'magazine', name: 'Extra rails', what: '+1 AIM-7R, +2 AIM-9X, +1 AIM-54F per level', base: 120, max: 3 },
  { id: 'motor', name: 'Hotter motors', what: 'Missiles fly 8% faster per level', base: 80, max: 5 },
  { id: 'seeker', name: 'Better seekers', what: 'Missiles turn 10% harder per level: fewer overshoots on jinking targets', base: 80, max: 5 },
  { id: 'fuse', name: 'Proximity fuses', what: 'Fuses 15% wider and fewer duds per level', base: 80, max: 5 },
  { id: 'reach', name: 'Longer burn', what: 'Missiles reach 10% further per level', base: 100, max: 5 },
  { id: 'flares', name: 'Bigger dispenser', what: '+2 chaff/flares and 15% faster reload per level', base: 90, max: 3 },
  { id: 'notch', name: 'Beam training', what: 'Notch is ready 10% sooner per level', base: 110, max: 5 },
  { id: 'ecm', name: 'ECM pod', what: '6% chance per level to spoof each inbound missile', base: 150, max: 5 },
];
export const upgradeCost = (u, level) => Math.round(u.base * 1.6 ** level);

const BANDIT_TYPES = [
  { name: 'J-36', mach: 3.0, spawnMin: 180, spawnMax: 185 },
  { name: 'J-11', mach: 2.0, spawnMin: 118, spawnMax: 122 },
];

const rand = (a, b) => a + Math.random() * (b - a);
const rad = (d) => (d * Math.PI) / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const inRect = (x, y, r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const pad2 = (n) => String(n).padStart(2, '0');
function angNorm(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
function shortCode(name) { const m = /AIM-(\d+)([A-Z]+)/.exec(name); return m ? m[1] + m[2] : name; }
export function clock(t) { const m = Math.floor(t / 60); const s = Math.floor(t % 60); const cs = Math.floor((t - Math.floor(t)) * 100); return `${pad2(m)}:${pad2(s)}.${pad2(cs)}`; }

class TomcatGame {
  constructor(canvas, { onGameOver, best, auto = false, onAuto, upgrades, onEarn, onHangar, onFlare, speed = 1, onSpeed, onStart } = {}) {
    this.canvas = null;
    this.ctx = null;
    this.onGameOver = onGameOver;
    this.onAuto = onAuto;
    this.upgrades = upgrades || (() => ({}));
    this.onEarn = onEarn;
    this.onHangar = onHangar;
    this.onFlare = onFlare;
    this.auto = auto;
    this.speed = SPEEDS.includes(speed) ? speed : 1;
    this.onSpeed = onSpeed;
    this.onStart = onStart;
    this.hangarOpen = false; // set by the tab while the hangar is up: holds an automatic restart
    this.best = best || (() => ({}));
    this.W = 0; this.H = 0;
    this.paused = false;
    this.mouse = { x: 0, y: 0 };
    this.hoveredMissileId = null;
    this.infoMode = null;
    this.toasts = [];
    this.counterRects = { 'FOX-1': {}, 'FOX-2': {}, 'FOX-3': {} };
    this.selBtns = { up: { w: 32, h: 32 }, dn: { w: 32, h: 32 } };
    this.foxBtns = ['FOX-1', 'FOX-2', 'FOX-3'].map((label) => ({ label, w: 92, h: 36 }));
    this.fireBtn = { w: 92, h: 36 };
    this.flareBtn = { w: 92, h: 36 };
    this.notchBtn = { w: 92, h: 36 };
    this.flareRect = {};
    this.restartBtn = { x: 10, y: 10, w: 120, h: 40 };
    this.pauseBtn = { x: 140, y: 10, w: 96, h: 40 };
    this.autoBtn = { x: 246, y: 10, w: 96, h: 40 };
    this.hangarBtn = { x: 352, y: 10, w: 106, h: 40 };
    this.speedBtn = { x: 468, y: 10, w: 64, h: 40 };
    this.contactRegions = [];
    this.reset();
    if (canvas) this.attach(canvas);
  }

  /** Draw into this canvas (the full-size game tab) from now on; detach() when it's no longer on screen. */
  attach(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.resize(); }
  detach() { this.canvas = null; this.ctx = null; }

  // ---------------------------------------------------------------- state

  /** A fresh sortie, waiting on the ramp (or straight into the air with start). */
  reset({ start = false } = {}) {
    this.started = false;
    this.bandits = []; this.missiles = []; this.hostiles = [];
    this.selectedId = null; this.selectedKind = 'bandit';
    this.nextId = 1; this.nextMissileId = 1; this.nextHostileId = 1;
    this.spawnT = 0; this.nextSpawn = rand(3, 7);
    this.simTime = 0; this.gameOver = null;
    this.splashes = 0; this.intercepts = 0; this.shots = 0; this.score = 0; this.earned = 0;
    this.usedAuto = this.auto; this.autoCd = 0; this.restartIn = 0;
    this.flares = this.flareMax(); this.flareT = 0; this.flareCd = 0; this.flareFx = 0;
    this.notchCd = 0; this.notchHold = 0;
    this.inv = Object.fromEntries(Object.keys(MISSILES).map((k) => [k, { count: this.spec(k).max, regenT: 0, regenActive: false }]));
    this.foxMode = 'FOX-1';
    this.infoMode = null;
    this.toasts.length = 0;
    this.paused = false;
    if (start) this.start();
  }

  /** Off the ramp: the run starts and the hangar shuts until it's over. */
  start() {
    if (this.started || this.hangarOpen) return;
    if (this.gameOver) return this.reset({ start: true });
    this.started = true;
    this.toast('FIGHT’S ON', 1.4, '#8afc96');
    this.onStart?.();
  }

  /** The hangar is open on the ramp and between sorties, never mid-run. */
  canHangar() { return !this.started || !!this.gameOver; }

  toast(msg, t = 1.6, color = '#fff') { this.toasts.push({ msg, t, color }); if (this.toasts.length > 8) this.toasts.shift(); }

  /** More bandits at once, arriving sooner, the longer you last. */
  // ---- the difficulty curve: it never levels off. A new wave every 90 s, and every wave is worse on every axis.
  wave() { return 1 + Math.floor(this.simTime / 90); }
  /** 0 on wave 1, +1 per wave after. */
  heat() { return this.wave() - 1; }
  /** One more bandit allowed in the air each wave, with no ceiling. */
  maxBandits() { return 2 + this.wave(); }
  /** Gaps shrink to 45% by ~5½ min, then keep shrinking 15% a wave. */
  spawnGap() {
    const t = this.simTime;
    const k = t <= 330 ? 1 - t / 600 : 0.45 * 0.85 ** ((t - 330) / 90);
    return [3 * k, 7 * k];
  }
  /** Bandits fly 5% faster per wave. Their missiles are 4% faster and turn 5% harder per wave. */
  banditPace() { return 1 + 0.05 * this.heat(); }
  missilePace() { return 1 + 0.04 * this.heat(); }
  missileTurn() { return 1 + 0.05 * this.heat(); }
  /** Targets break harder each wave (more overshoots), so seekers stay worth upgrading. */
  agility() { return 1 + 0.04 * this.heat(); }
  /** Launch range grows 3% a wave (never past where they show up). */
  launchKm(type) { const base = type === 'J-36' ? 160 : 80; return Math.min(type === 'J-36' ? 178 : 116, base * (1 + 0.03 * this.heat())); }
  /** An extra missile in each salvo every 4 waves (J-11) or 5 waves (J-36), fired at shrinking intervals. */
  salvo(type) { return type === 'J-36' ? 1 + Math.floor(this.heat() / 5) : 2 + Math.floor(this.heat() / 4); }
  shotGap(type) { return (type === 'J-36' ? 10 : 8) * Math.max(0.35, 1 - 0.04 * this.heat()); }

  spawnBandit() {
    if (this.bandits.length >= this.maxBandits()) return;
    const pick = BANDIT_TYPES[Math.floor(Math.random() * BANDIT_TYPES.length)];
    const distance = rand(pick.spawnMin, pick.spawnMax);
    const b = {
      id: 'B' + this.nextId++, type: pick.name, angle: rand(-AZ_LIMIT, AZ_LIMIT), distance, prevDistance: distance,
      altitude: rand(MIN_ALT_M, MAX_ALT_M), mach: pick.mach * this.banditPace(), climb: (Math.random() < 0.5 ? -1 : 1) * rand(5, 20),
      closure: 0, shots: 0, salvo: this.salvo(pick.name), launchKm: this.launchKm(pick.name), nextShotAt: null,
    };
    this.bandits.push(b);
    if (!this.selectedId) { this.selectedId = b.id; this.selectedKind = 'bandit'; }
  }

  // ---------------------------------------------------------------- tracks

  tracksSorted() {
    return [
      ...this.bandits.map((o) => ({ kind: 'bandit', obj: o, dist: o.distance })),
      ...this.hostiles.map((o) => ({ kind: 'hostile', obj: o, dist: o.distance })),
    ].sort((a, b) => a.dist - b.dist);
  }

  selectedTrack() {
    if (!this.selectedId) return null;
    const list = this.selectedKind === 'bandit' ? this.bandits : this.hostiles;
    const o = list.find((x) => x.id === this.selectedId);
    return o ? { kind: this.selectedKind, obj: o } : null;
  }

  cycleTarget(dir) {
    const tracks = this.tracksSorted();
    if (!tracks.length) return;
    const idx = Math.max(0, tracks.findIndex((t) => t.obj.id === this.selectedId && t.kind === this.selectedKind));
    const n = tracks[(idx + dir + tracks.length) % tracks.length];
    this.selectedKind = n.kind; this.selectedId = n.obj.id;
  }

  /** Position in the display plane: x = range·sin(az), y = range. */
  posOf(kind, id, prev = false) {
    if (kind === 'bandit') {
      const b = this.bandits.find((x) => x.id === id);
      if (!b) return null;
      const d = prev ? b.prevDistance : b.distance;
      return { x: Math.sin(b.angle) * d, y: d };
    }
    const m = this.hostiles.find((x) => x.id === id);
    if (!m) return null;
    return prev ? { x: m.px, y: m.py } : { x: m.x, y: m.y };
  }

  // ---------------------------------------------------------------- weapons

  fire() {
    if (this.gameOver || this.paused) return;
    if (this.notchHold > 0) { this.toast(`NOTCHING — WEAPONS HOLD ${Math.ceil(this.notchHold)}s`, 1.2, '#c9a8ff'); return; }
    const sel = this.selectedTrack();
    if (!sel) { this.toast('NO TARGET'); return; }
    const card = this.spec(this.foxMode);
    const inv = this.inv[this.foxMode];
    if (inv.count <= 0) { this.toast(`OUT OF ${card.short} — ${Math.ceil(inv.regenT)}s`, 1.6, '#ffb36b'); return; }
    const tp = this.posOf(sel.kind, sel.obj.id);
    const heading = Math.atan2(tp.x, tp.y);
    this.missiles.push({
      id: 'M' + this.nextMissileId++, code: card.code, name: card.name, guidance: card.guidance,
      turnRate: rad(card.turnRateDps), turnDps: card.turnRateDps, speed: card.speedMach * MACH1_KMPS, rMaxKm: card.rMaxKm, activeKm: card.activeKm,
      state: card.guidance === 'ARH' ? 'inertial' : 'guiding', x: 0, y: 0, heading, rangeKm: 0, bearing: heading, travelled: 0,
      targetId: sel.obj.id, targetKind: sel.kind, killRadiusKm: card.killRadiusKm, dud: card.dud,
    });
    this.shots++;
    inv.count--;
    if (inv.count <= 0 && !inv.regenActive) { inv.regenActive = true; inv.regenT = card.regen; }
    // in range if the missile meets it head-on before running out: it only has to fly d·vm/(vm+vt)
    const vm = card.speedMach * MACH1_KMPS;
    const vt = sel.kind === 'bandit' ? Math.max(0, sel.obj.closure || 0) : sel.obj.speed;
    const far = (Math.hypot(tp.x, tp.y) * vm) / (vm + vt) > card.rMaxKm;
    this.toast(`${card.code} AWAY (${card.short})${far ? ' — OUT OF RANGE' : ''}`, 1.6, far ? '#ffb36b' : '#fff');
  }

  /** A missile's numbers with the hangar upgrades applied. */
  spec(code) {
    const base = MISSILES[code];
    const u = this.upgrades();
    return {
      ...base,
      max: base.max + (u.magazine || 0) * MAGAZINE_STEP[code],
      regen: base.regen * (1 - 0.1 * (u.reload || 0)),
      speedMach: base.speedMach * (1 + 0.08 * (u.motor || 0)),
      turnRateDps: base.turnRateDps * (1 + 0.1 * (u.seeker || 0)),
      killRadiusKm: KILL_RADIUS_KM * (1 + 0.15 * (u.fuse || 0)),
      dud: dudChance(u.fuse || 0),
      rMaxKm: Math.round(base.rMaxKm * (1 + 0.1 * (u.reach || 0))),
    };
  }

  // chaff/flares: one every few seconds, up to a full dispenser
  flareMax() { return 6 + 2 * (this.upgrades().flares || 0); }
  flareReload() { return 8 * (1 - 0.15 * (this.upgrades().flares || 0)); }

  /** Pops a chaff/flare: every enemy missile on the field rolls a 10% chance of being juked. */
  flare() {
    if (this.gameOver || this.paused || this.flareCd > 0) return;
    if (this.flares <= 0) { this.toast(`NO FLARES — ${Math.ceil(this.flareReload() - this.flareT)}s`, 1.4, '#ffb36b'); return; }
    this.flares--;
    this.flareCd = 0.8;
    this.flareFx = 1;
    this.onFlare?.();
    let spoofed = 0;
    for (let i = this.hostiles.length - 1; i >= 0; i--) {
      const m = this.hostiles[i];
      if (Math.random() < 0.1) { this.hostiles.splice(i, 1); spoofed++; this.toast(`${m.id} JUKED (FLARE)`, 2, '#ffcf6b'); }
    }
    if (!spoofed) this.toast('FLARE', 1, '#ffcf6b');
  }

  // notch: turn the jet across the radar beams; every missile in the air loses you, but you can't shoot meanwhile
  notchCooldown() { return 45 * (1 - 0.1 * (this.upgrades().notch || 0)); }

  notch() {
    if (this.gameOver || this.paused) return;
    if (this.notchCd > 0) { this.toast(`NOTCH READY IN ${Math.ceil(this.notchCd)}s`, 1.4, '#ffb36b'); return; }
    const n = this.hostiles.length;
    this.hostiles.length = 0;
    this.notchCd = this.notchCooldown();
    this.notchHold = NOTCH_HOLD;
    this.toast(n ? `NOTCH — ${n} missile${n === 1 ? '' : 's'} defeated` : 'NOTCH', 2, '#c9a8ff');
  }

  updateFlares(dt) {
    this.notchCd = Math.max(0, this.notchCd - dt);
    this.notchHold = Math.max(0, this.notchHold - dt);
    this.flareCd = Math.max(0, this.flareCd - dt);
    this.flareFx = Math.max(0, this.flareFx - dt);
    const max = this.flareMax();
    if (this.flares >= max) { this.flares = max; this.flareT = 0; return; }
    this.flareT += dt;
    if (this.flareT >= this.flareReload()) { this.flares++; this.flareT = 0; }
  }

  /** Points and $ for a kill. */
  award(what) {
    // later waves pay more (+15% a wave), so the money keeps up with the hangar prices
    const pay = 1 + 0.15 * this.heat();
    const [pts, cash] = (BOUNTY[what] || [50, 5]).map((n) => Math.round(n * pay));
    this.score += pts;
    this.earned += cash;
    this.onEarn?.(cash);
    return cash;
  }

  // ---------------------------------------------------------------- automatic mode

  toggleAuto() {
    this.auto = !this.auto;
    if (this.auto) this.usedAuto = true;
    this.toast(this.auto ? 'AUTO ON — the WSO has the trigger' : 'AUTO OFF', 1.6, '#8afc96');
    this.onAuto?.(this.auto);
  }

  /** 1x -> 2x -> 3x -> 1x: the whole sim runs faster (Flight.tick takes more steps). */
  cycleSpeed() {
    this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length];
    this.toast(this.speed > 1 ? `FAST FORWARD ${this.speed}×` : 'NORMAL SPEED', 1.4, '#9ecf9f');
    this.onSpeed?.(this.speed);
  }

  /** Seconds until an inbound missile reaches us. */
  timeToImpact(m) { return (m.distance - 1) / m.speed; }

  /**
   * Defence while auto flies: chaff/flares while any missile is under ~6 s out (each one is a 10% roll), and a notch
   * once one is under ~1.5 s out, or early when three or more are inbound. Notching holds fire, so it's the last resort.
   */
  autoDefend() {
    if (!this.hostiles.length) return;
    const soonest = Math.min(...this.hostiles.map((m) => this.timeToImpact(m)));
    if (this.notchCd <= 0 && (soonest <= 1.5 || (this.hostiles.length >= 3 && soonest <= 4))) { this.toast('AUTO: NOTCH', 1.2, '#c9a8ff'); this.notch(); return; }
    if (soonest <= 6 && this.flareCd <= 0 && this.flares > 0) this.flare();
  }

  /** Seconds until a track becomes dangerous: a bandit reaching its launch range (or the merge), a missile reaching us. */
  deadline(kind, o, d, vt) {
    if (kind === 'hostile') return (d - 1) / vt;
    const merge = (d - KILL_RANGE_KM) / vt;
    if (!o.shots) { const t = (d - o.launchKm) / vt; return t > 0 ? t : merge; }
    if (o.shots < o.salvo) return Math.min(merge, Math.max(0, (o.nextShotAt ?? 0) - this.simTime));
    return merge;
  }

  /**
   * The cheapest missile (AIM-9X, then AIM-7R, then AIM-54F) that kills the track before its deadline, even if
   * that means holding fire until it's in reach. If none can make it in time, the quickest one in reach now.
   * Returns a FOX code, 'wait', or null.
   */
  pickWeapon({ d, vt, deadline }) {
    let fallback = null, fastest = Infinity;
    for (const code of ['FOX-2', 'FOX-1', 'FOX-3']) {
      const card = this.spec(code);
      if (this.inv[code].count <= 0) continue;
      const vm = card.speedMach * MACH1_KMPS;
      const reach = card.rMaxKm * 0.9; // head-on intercept needs the missile to fly d·vm/(vm+vt)
      const dReach = (reach * (vm + vt)) / vm;
      const inReach = d <= dReach;
      const wait = Math.max(0, (d - dReach) / vt);
      const flight = Math.min(d, dReach) / (vm + vt);
      if (wait + flight <= deadline - 1) return inReach ? code : 'wait';
      if (inReach && flight < fastest) { fastest = flight; fallback = code; }
    }
    return fallback;
  }

  autopilot(dt) {
    this.autoCd = Math.max(0, this.autoCd - dt);
    if (this.autoCd > 0) return;
    const covered = new Set(this.missiles.filter((m) => !m.lost).map((m) => m.targetId));
    const plans = this.tracksSorted()
      .filter((t) => !covered.has(t.obj.id))
      .map((t) => {
        const vt = t.kind === 'bandit' ? Math.max(0.05, t.obj.closure || t.obj.mach * MACH1_KMPS) : t.obj.speed;
        return { t, d: t.dist, vt, deadline: this.deadline(t.kind, t.obj, t.dist, vt) };
      })
      .sort((a, b) => a.deadline - b.deadline);
    for (const p of plans) {
      const code = this.pickWeapon(p);
      if (!code || code === 'wait') continue;
      this.selectedKind = p.t.kind; this.selectedId = p.t.obj.id; this.foxMode = code;
      this.fire();
      this.autoCd = 0.4; // one shot at a time, like a person would
      return;
    }
  }

  updateMissiles(dt) {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      const tp = this.posOf(m.targetKind, m.targetId);
      const px = m.x, py = m.y;
      if (tp && !m.lost) {
        const los = Math.atan2(tp.x - m.x, tp.y - m.y);
        const maxStep = m.turnRate * dt;
        m.heading = angNorm(m.heading + clamp(angNorm(los - m.heading), -maxStep, maxStep));
      }
      m.x += Math.sin(m.heading) * m.speed * dt;
      m.y += Math.cos(m.heading) * m.speed * dt;
      m.travelled += m.speed * dt;
      m.rangeKm = m.y;
      m.bearing = Math.atan2(m.x, m.y);
      if (m.guidance === 'ARH' && m.state !== 'active' && m.rangeKm >= m.activeKm) { m.state = 'active'; this.toast('PITBULL', 1.2, '#8fbfff'); }
      if (m.travelled >= m.rMaxKm) { this.missiles.splice(i, 1); if (!m.lost) this.toast('MISSILE LOST (range)', 1.6, '#aaa'); continue; }
      if (!tp || m.lost) continue;
      // the target breaks hard as the missile closes: a seeker that can't turn with it overshoots
      if (!m.jinked && Math.hypot(tp.x - m.x, tp.y - m.y) <= JINK_KM) {
        m.jinked = true;
        const t = (m.targetKind === 'bandit' ? this.bandits : this.hostiles).find((x) => x.id === m.targetId);
        if (Math.random() < overshootChance((AGILITY[t?.type || t?.wpn] ?? 0.7) * this.agility(), m.turnDps)) { m.lost = true; this.toast(`${m.id} OVERSHOT ${m.targetId}`, 1.8, '#aaa'); continue; }
      }
      // continuous proximity fuse: closest approach during this step, in the target's frame
      const tpPrev = this.posOf(m.targetKind, m.targetId, true) || tp;
      const R0x = px - tpPrev.x, R0y = py - tpPrev.y;
      const Vx = (m.x - px) - (tp.x - tpPrev.x);
      const Vy = (m.y - py) - (tp.y - tpPrev.y);
      const denom = Vx * Vx + Vy * Vy;
      const u = denom > 1e-9 ? clamp(-(R0x * Vx + R0y * Vy) / denom, 0, 1) : 0;
      if (Math.hypot(R0x + u * Vx, R0y + u * Vy) >= m.killRadiusKm) continue;
      if (Math.random() < m.dud) { m.lost = true; this.toast(`${m.id} DUD — fuse failed`, 1.8, '#aaa'); continue; }
      this.missiles.splice(i, 1);
      if (m.targetKind === 'bandit') {
        const bi = this.bandits.findIndex((b) => b.id === m.targetId);
        if (bi >= 0) { const [b] = this.bandits.splice(bi, 1); this.splashes++; this.toast(`SPLASH ${m.targetId}  +$${this.award(b.type)}`, 2, '#8afc96'); }
      } else {
        const hi = this.hostiles.findIndex((x) => x.id === m.targetId);
        if (hi >= 0) { const [x] = this.hostiles.splice(hi, 1); this.intercepts++; this.toast(`INTERCEPT ${m.targetId}  +$${this.award(x.wpn)}`, 2, '#8fbfff'); }
      }
    }
  }

  spawnHostile(b, wpn) {
    const spec = HOSTILE_MISSILES[wpn];
    const x = Math.sin(b.angle) * b.distance, y = b.distance;
    const heading = Math.atan2(-x, -y);
    this.hostiles.push({
      id: 'H' + this.nextHostileId++, wpn, speed: spec.speedMach * MACH1_KMPS * this.missilePace(), turnRate: rad(spec.turnRateDps * this.missileTurn()), heading,
      x, y, px: x, py: y, bearing: heading, rangeKm: y, altitude: b.altitude, distance: Math.hypot(x, y),
    });
    this.toast(`${b.id} FOX (${wpn})`, 1.8, '#ff8080');
  }

  updateHostiles(dt) {
    for (let i = this.hostiles.length - 1; i >= 0; i--) {
      const m = this.hostiles[i];
      m.px = m.x; m.py = m.y;
      const los = Math.atan2(-m.x, -m.y);
      const maxStep = m.turnRate * dt;
      m.heading = angNorm(m.heading + clamp(angNorm(los - m.heading), -maxStep, maxStep));
      m.x += Math.sin(m.heading) * m.speed * dt;
      m.y += Math.cos(m.heading) * m.speed * dt;
      m.rangeKm = m.y;
      m.bearing = Math.atan2(m.x, m.y);
      m.distance = Math.hypot(m.x, m.y);
      if (!m.ecmRolled && m.distance <= 15) {
        m.ecmRolled = true;
        if (Math.random() < 0.06 * (this.upgrades().ecm || 0)) { this.hostiles.splice(i, 1); this.toast(`${m.id} SPOOFED (ECM)`, 2, '#c9a8ff'); continue; }
      }
      if (m.distance <= 1.0) { this.hostiles.splice(i, 1); this.end(`HIT BY ${m.wpn}`); }
    }
  }

  // ---------------------------------------------------------------- loop

  update(dt) {
    if (this.paused) return;
    for (let i = this.toasts.length - 1; i >= 0; i--) if ((this.toasts[i].t -= dt) <= 0) this.toasts.splice(i, 1);
    if (this.gameOver) {
      // automatic mode flies again on its own (not while you're shopping in the hangar)
      if (this.auto && !this.hangarOpen) { this.restartIn -= dt; if (this.restartIn <= 0) this.reset({ start: true }); }
      return;
    }
    if (!this.started) return;
    this.simTime += dt;
    this.score += dt; // a point a second
    this.spawnT += dt;
    if (this.spawnT >= this.nextSpawn) { this.spawnT = 0; this.nextSpawn = rand(...this.spawnGap()); this.spawnBandit(); }

    for (const b of this.bandits) {
      b.prevDistance = b.distance;
      b.closure = Math.max(0, b.mach * MACH1_KMPS + Math.max(0, OWN_SPEED * Math.cos(b.angle)));
      b.distance -= b.closure * dt;
      b.altitude += b.climb * dt;
      if (b.altitude < MIN_ALT_M) { b.altitude = MIN_ALT_M; b.climb = Math.abs(b.climb); }
      if (b.altitude > MAX_ALT_M) { b.altitude = MAX_ALT_M; b.climb = -Math.abs(b.climb); }
      if (b.shots < b.salvo && (b.shots ? this.simTime >= b.nextShotAt : b.distance <= b.launchKm)) {
        this.spawnHostile(b, b.type === 'J-36' ? 'PL-21' : 'PL-15');
        b.shots++;
        b.nextShotAt = this.simTime + this.shotGap(b.type);
      }
    }
    // targets move first, so the missiles' proximity fuse sees where they went this step
    this.updateHostiles(dt);
    this.updateMissiles(dt);
    this.updateFlares(dt);
    if (this.auto && !this.gameOver) {
      this.autoDefend();
      if (this.notchHold <= 0) this.autopilot(dt);
    }

    for (const [code, inv] of Object.entries(this.inv)) {
      const card = this.spec(code);
      if (inv.count === 0 && !inv.regenActive) { inv.regenActive = true; inv.regenT = card.regen; }
      if (!inv.regenActive) continue;
      inv.regenT -= dt;
      if (inv.regenT <= 0) {
        if (inv.count < card.max) { inv.count++; inv.regenT += card.regen; }
        if (inv.count >= card.max) { inv.regenActive = false; inv.regenT = 0; }
      }
    }

    const merged = this.bandits.find((b) => b.distance <= KILL_RANGE_KM);
    if (merged) this.end(`${merged.id} (${merged.type}) MERGED`);
    if (this.selectedTrack() == null) {
      const first = this.tracksSorted()[0];
      this.selectedId = first?.obj.id || null;
      this.selectedKind = first?.kind || 'bandit';
    }
  }

  end(reason) {
    if (this.gameOver) return;
    const before = { ...this.best() };
    this.gameOver = { reason, time: this.simTime, splashes: this.splashes, intercepts: this.intercepts, score: Math.floor(this.score), earned: this.earned, auto: this.usedAuto, before };
    this.restartIn = 5;
    this.onGameOver?.(this.gameOver);
  }

  resize() {
    if (!this.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.W = Math.max(1, r.width); this.H = Math.max(1, r.height);
    this.canvas.width = Math.floor(this.W * dpr);
    this.canvas.height = Math.floor(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  // ---------------------------------------------------------------- layout

  scope() { const x = this.W - PANEL_W; return { x, bx: x + (PANEL_W - BSCOPE_SIZE) / 2, by: 66 }; }

  scopeX(rangeKm, az, bx) {
    const half = BSCOPE_SIZE / 2 - 6;
    const rNorm = clamp(rangeKm / RADAR_RANGE_KM, 0, 1);
    const azNorm = clamp(Math.sin(az) / Math.sin(AZ_LIMIT), -1, 1);
    return bx + BSCOPE_SIZE / 2 + azNorm * half * rNorm;
  }

  layout() {
    const { x, bx, by } = this.scope();
    const sx = Math.max(x + 8, bx - this.selBtns.up.w - 10);
    Object.assign(this.selBtns.up, { x: sx, y: by + 8 });
    Object.assign(this.selBtns.dn, { x: sx, y: by + 8 + this.selBtns.up.h + 8 });
    const leftW = this.W - PANEL_W, pad = 12, gap = 10;
    let y = this.H - (36 * 3 + gap * 2) - pad;
    for (const b of this.foxBtns) { Object.assign(b, { x: leftW - b.w - pad, y }); y += b.h + gap; }
    const f3 = this.foxBtns[2];
    Object.assign(this.fireBtn, { x: f3.x - this.fireBtn.w - 12, y: f3.y });
    Object.assign(this.flareBtn, { x: this.fireBtn.x, y: this.foxBtns[1].y });
    Object.assign(this.notchBtn, { x: this.fireBtn.x, y: this.foxBtns[0].y });
  }

  // ---------------------------------------------------------------- drawing

  draw() {
    const { ctx, W, H } = this;
    if (!ctx) return;
    this.layout();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, W, H);
    const leftW = W - PANEL_W;
    ctx.save();
    ctx.strokeStyle = '#181818';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < leftW; gx += 40) { ctx.beginPath(); ctx.moveTo(gx + 0.5, 0); ctx.lineTo(gx + 0.5, H); ctx.stroke(); }
    for (let gy = 0; gy < H; gy += 40) { ctx.beginPath(); ctx.moveTo(0, gy + 0.5); ctx.lineTo(leftW, gy + 0.5); ctx.stroke(); }
    ctx.restore();
    this.drawOwnship();
    this.drawPanel();
    this.drawHud();
    this.button(this.restartBtn, 'RESTART', false, 18);
    this.button(this.pauseBtn, !this.started || this.gameOver ? 'START' : this.paused ? 'RESUME' : 'PAUSE', this.paused, 16);
    this.button(this.autoBtn, this.auto ? 'AUTO ON' : 'AUTO', this.auto, 15);
    this.button(this.hangarBtn, 'HANGAR', !!this.hangarOpen, 15, !this.canHangar());
    this.button(this.speedBtn, `${this.speed}×`, this.speed > 1, 16);
    this.drawSelectorButtons();
    this.drawFoxButtons();
    this.drawContacts();
    this.drawMissileCounters();
    this.drawMissileInfo();
    this.drawToasts();
    if (this.gameOver) this.drawGameOver();
    else if (!this.started) this.drawReady();
    else if (this.paused) this.drawPaused();
  }

  button(r, label, active, size = 13, dim = false) {
    const { ctx } = this;
    ctx.save();
    if (dim) ctx.globalAlpha = 0.35;
    ctx.fillStyle = active ? '#2e5a2e' : '#1e1e1e';
    ctx.strokeStyle = active ? '#9f9' : '#777';
    ctx.lineWidth = 2;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = '#fff';
    ctx.font = `${size}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 1);
    ctx.restore();
  }

  drawOwnship() {
    const { ctx, W, H } = this;
    const leftW = W - PANEL_W;
    const cx = leftW * 0.45, cy = H * 0.55;
    const L = Math.max(60, Math.min(leftW, H) * 0.42);
    this._own = { cx, cy, L };
    ctx.save();
    // missile warning: a red tick around the jet for every inbound missile, toward where it's coming from
    if (this.hostiles.length) {
      const R = L * 0.62;
      ctx.strokeStyle = 'rgba(255,77,77,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#ff4d4d';
      ctx.lineWidth = 3;
      for (const m of this.hostiles) {
        const a = Math.atan2(m.x, m.y) - Math.PI / 2; // 0 = straight ahead (up)
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (R - 8), cy + Math.sin(a) * (R - 8)); ctx.lineTo(cx + Math.cos(a) * (R + 8), cy + Math.sin(a) * (R + 8)); ctx.stroke();
      }
    }
    if (this.flareFx > 0) {
      const t = 1 - this.flareFx;
      ctx.save();
      ctx.globalAlpha = this.flareFx;
      ctx.fillStyle = '#ffcf6b';
      for (let i = 0; i < 8; i++) {
        const side = i % 2 ? 1 : -1, k = Math.floor(i / 2) + 1;
        ctx.beginPath();
        ctx.arc(cx + side * (L * 0.12 + k * L * 0.07 * t), cy + L * 0.42 + k * L * 0.11 * t, 3 + 2 * (1 - t), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    if (this.notchHold > 0) {
      const k = Math.min(1, (NOTCH_HOLD - this.notchHold) / 0.5, this.notchHold / 0.5); // turn in, hold, turn back
      ctx.translate(cx, cy); ctx.rotate((Math.PI / 2) * k); ctx.translate(-cx, -cy);
    }
    ctx.translate(cx - L / 2, cy - L / 2);
    ctx.scale(L / 100, L / 100);
    const p = new Path2D(F14_PATH);
    ctx.fillStyle = '#2b2f2b';
    ctx.fill(p);
    ctx.strokeStyle = '#7f8f7f';
    ctx.lineWidth = 100 / L * 1.5;
    ctx.stroke(p);
    ctx.restore();
    ctx.save();
    ctx.fillStyle = '#6f7f6f';
    ctx.font = `12px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText('F-14F SUPER TOMCAT  ·  FL300  ·  M1.0', cx, cy + L / 2 + 22);
    ctx.restore();
  }

  drawHud() {
    const { ctx, W } = this;
    const leftW = W - PANEL_W;
    ctx.save();
    ctx.font = `14px ${MONO}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#9ecf9f';
    ctx.fillText(clock(this.simTime), W - 12, 12);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#cfd8cf';
    const best = this.best();
    const bestScore = Math.max(Math.floor(this.score), (this.auto || this.usedAuto ? best.auto?.bestScore : best.bestScore) || 0);
    ctx.fillText(`SCORE ${Math.floor(this.score).toLocaleString()}   BEST ${bestScore.toLocaleString()}`, 544, 14);
    ctx.fillStyle = '#9ecf9f';
    ctx.fillText(`SPLASH ${this.splashes}   INT ${this.intercepts}   WAVE ${this.wave()}`, 544, 32);
    ctx.fillStyle = '#ffd36b';
    ctx.font = `bold 16px ${MONO}`;
    ctx.fillText(`$${(best.cash || 0).toLocaleString()}`, 14, 58);
    if (this.notchHold > 0 && !this.gameOver) {
      ctx.textAlign = 'center';
      ctx.font = `bold 18px ${MONO}`;
      ctx.fillStyle = '#c9a8ff';
      ctx.fillText(`NOTCHING — WEAPONS HOLD ${Math.ceil(this.notchHold)}s`, leftW * 0.45, 92);
    }
    if (this.hostiles.length && !this.gameOver && Math.floor(performance.now() / 300) % 2 === 0) {
      ctx.textAlign = 'center';
      ctx.font = `bold 18px ${MONO}`;
      ctx.fillStyle = '#ff4d4d';
      ctx.fillText(`MISSILE${this.hostiles.length > 1 ? ` ×${this.hostiles.length}` : ''}`, leftW * 0.45, 66);
    }
    ctx.restore();
  }

  drawPanel() {
    const { ctx, H } = this;
    const { x, bx, by } = this.scope();
    const kmToPx = BSCOPE_SIZE / RADAR_RANGE_KM;
    ctx.fillStyle = '#151515';
    ctx.fillRect(x, 0, PANEL_W, H);
    ctx.fillStyle = '#b9ffc0'; ctx.font = `16px ${MONO}`; ctx.fillText('F-14F B-SCOPE (AWG-9)', x + MARGIN, 26);
    ctx.fillStyle = '#9ecf9f'; ctx.font = `12px ${MONO}`; ctx.fillText('Scale: 100 nm (185 km) max', x + MARGIN, 44);

    ctx.strokeStyle = '#54ff6b'; ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, BSCOPE_SIZE, BSCOPE_SIZE);
    ctx.beginPath(); ctx.moveTo(bx + BSCOPE_SIZE / 2, by + BSCOPE_SIZE); ctx.lineTo(bx + BSCOPE_SIZE / 2, by); ctx.stroke();
    ctx.save();
    ctx.strokeStyle = 'rgba(84,255,107,0.35)'; ctx.lineWidth = 1;
    for (const az of [-AZ_LIMIT, AZ_LIMIT]) { ctx.beginPath(); ctx.moveTo(bx + BSCOPE_SIZE / 2, by + BSCOPE_SIZE); ctx.lineTo(this.scopeX(RADAR_RANGE_KM, az, bx), by); ctx.stroke(); }
    ctx.restore();

    ctx.strokeStyle = '#3c9f4c'; ctx.fillStyle = '#8afc96'; ctx.font = `11px ${MONO}`;
    for (let r = 20; r <= RADAR_RANGE_KM; r += 20) {
      const y = by + BSCOPE_SIZE - r * kmToPx;
      ctx.globalAlpha = 0.28; ctx.beginPath(); ctx.moveTo(bx, y); ctx.lineTo(bx + BSCOPE_SIZE, y); ctx.stroke();
      ctx.globalAlpha = 1; ctx.fillText(r + ' km', bx + 6, y + 11);
    }
    const yKill = by + BSCOPE_SIZE - KILL_RANGE_KM * kmToPx;
    ctx.strokeStyle = '#ff4d4d'; ctx.beginPath(); ctx.moveTo(bx, yKill); ctx.lineTo(bx + BSCOPE_SIZE, yKill); ctx.stroke();

    const card = this.spec(this.foxMode);
    const rKm = Math.min(card.rMaxKm, RADAR_RANGE_KM);
    const yR = by + BSCOPE_SIZE - rKm * kmToPx;
    ctx.strokeStyle = '#4aa3ff'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(bx, yR); ctx.lineTo(bx + BSCOPE_SIZE, yR); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#8fbfff'; ctx.font = `11px ${MONO}`; ctx.fillText(`Rmax ${rKm} km`, bx + BSCOPE_SIZE - 80, yR - 4);

    for (const m of this.missiles) {
      const my = by + BSCOPE_SIZE - m.rangeKm * kmToPx;
      const mx = this.scopeX(m.rangeKm, m.bearing, bx);
      m._sx = mx; m._sy = my;
      ctx.fillStyle = m.lost ? '#5a6470' : '#4aa3ff'; ctx.beginPath(); ctx.arc(mx, my, 3, 0, Math.PI * 2); ctx.fill();
      if (m.guidance === 'ARH' && m.state === 'active') { ctx.strokeStyle = '#8fbfff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(mx, my, 6, 0, Math.PI * 2); ctx.stroke(); }
      if (this.hoveredMissileId === m.id) {
        const label = `${m.id} ${shortCode(m.name)}`;
        ctx.save();
        ctx.font = `11px ${MONO}`;
        const w = ctx.measureText(label).width + 8, lh = 16;
        const lx = Math.min(mx + 10, bx + BSCOPE_SIZE - w - 2), ly = Math.max(my - lh - 8, by + 2);
        ctx.fillStyle = 'rgba(30,30,30,0.9)'; ctx.strokeStyle = '#8fbfff'; ctx.lineWidth = 1;
        ctx.fillRect(lx, ly, w, lh); ctx.strokeRect(lx, ly, w, lh);
        ctx.fillStyle = '#cfe3ff'; ctx.textBaseline = 'middle'; ctx.fillText(label, lx + 4, ly + lh / 2);
        ctx.restore();
      }
    }

    const sel = this.selectedTrack();
    const ownX = bx + BSCOPE_SIZE / 2, ownY = by + BSCOPE_SIZE;
    for (const m of this.hostiles) {
      const hy = by + BSCOPE_SIZE - m.rangeKm * kmToPx;
      const hx = this.scopeX(m.rangeKm, m.bearing, bx);
      m._sx = hx; m._sy = hy;
      ctx.save(); ctx.translate(hx, hy); ctx.rotate(Math.atan2(ownY - hy, ownX - hx));
      ctx.fillStyle = '#ff4d4d'; ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(-3, -2); ctx.lineTo(-3, 2); ctx.closePath(); ctx.fill();
      ctx.restore();
      if (sel?.kind === 'hostile' && sel.obj === m) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(hx, hy, 8, 0, Math.PI * 2); ctx.stroke(); }
    }
    const hovered = this.hoveredMissileId && this.missiles.find((m) => m.id === this.hoveredMissileId);
    for (const b of this.bandits) {
      const y = by + BSCOPE_SIZE - b.distance * kmToPx;
      const xDot = this.scopeX(b.distance, b.angle, bx);
      b._sx = xDot; b._sy = y;
      ctx.fillStyle = '#ff4d4d'; ctx.beginPath(); ctx.arc(xDot, y, 4, 0, Math.PI * 2); ctx.fill();
      if (sel?.kind === 'bandit' && sel.obj === b) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(xDot, y, 8, 0, Math.PI * 2); ctx.stroke(); }
    }
    if (hovered) {
      const t = (hovered.targetKind === 'bandit' ? this.bandits : this.hostiles).find((x) => x.id === hovered.targetId);
      if (t?._sx != null) { ctx.strokeStyle = '#4aa3ff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(t._sx, t._sy, 12, 0, Math.PI * 2); ctx.stroke(); }
    }
  }

  drawContacts() {
    const { ctx } = this;
    this.contactRegions.length = 0;
    const { x, by } = this.scope();
    let y = by + BSCOPE_SIZE + 28;
    ctx.fillStyle = '#9f9'; ctx.font = `14px ${MONO}`; ctx.fillText('CONTACTS', x + MARGIN, y);
    ctx.fillStyle = '#6a8f6a'; ctx.textAlign = 'right';
    this.fit('◆ = in range of selected weapon', PANEL_W - MARGIN * 2 - 96, 11);
    ctx.fillText('◆ = in range of selected weapon', x + PANEL_W - MARGIN, y);
    ctx.textAlign = 'left';
    y += 6;
    ctx.strokeStyle = '#2a2'; ctx.beginPath(); ctx.moveTo(x + MARGIN, y + 6); ctx.lineTo(x + PANEL_W - MARGIN, y + 6); ctx.stroke();
    y += 22;
    const tracks = this.tracksSorted();
    if (!tracks.length) { ctx.fillStyle = '#bbb'; ctx.font = `12px ${MONO}`; ctx.fillText('None', x + MARGIN, y); return; }
    const sel = this.selectedTrack();
    const rMax = this.spec(this.foxMode).rMaxKm;
    for (const t of tracks) {
      if (y > this.H - 10) break;
      const o = t.obj;
      const isBandit = t.kind === 'bandit';
      const altFt = Math.round(((o.altitude || MIN_ALT_M) * M_TO_FT) / 100) * 100;
      const vcKts = Math.round((isBandit ? o.closure : o.speed) * KTS_PER_KMPS);
      const mach = isBandit ? o.mach : o.speed / MACH1_KMPS;
      const name = `${o.id} ${isBandit ? o.type : o.wpn}`.padEnd(9);
      const vm = this.spec(this.foxMode).speedMach * MACH1_KMPS;
      const inRange = (o.distance * vm) / (vm + (isBandit ? o.closure || 0 : o.speed)) <= rMax;
      const line = `${inRange ? '◆' : ' '} ${name} ${altFt > PLAYER_ALT_FT ? '▲' : '▼'}${(altFt / 1000).toFixed(1)}k ft ${String(Math.round(o.distance)).padStart(3)}km Vc ${vcKts}kt M${mach.toFixed(1)}`;
      if (sel && sel.obj === o) { ctx.save(); ctx.fillStyle = 'rgba(80,140,80,0.35)'; ctx.fillRect(x + MARGIN - 2, y - 12, PANEL_W - MARGIN * 2, 20); ctx.restore(); }
      ctx.fillStyle = isBandit ? '#fff' : '#ffb3b3';
      this.fit(line, PANEL_W - MARGIN * 2 - 18, 12); // room on the right for the missile-on-it dot
      ctx.fillText(line, x + MARGIN, y);
      if (this.missiles.some((m) => m.targetId === o.id && !m.lost)) {
        const dx = x + PANEL_W - MARGIN - 8, dy = y - 4;
        ctx.fillStyle = '#4aa3ff'; ctx.beginPath(); ctx.arc(dx, dy, 4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#8fbfff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(dx, dy, 6, 0, Math.PI * 2); ctx.stroke();
      }
      this.contactRegions.push({ kind: t.kind, id: o.id, x: x + MARGIN - 4, y: y - 14, w: PANEL_W - MARGIN * 2 + 8, h: 20 });
      y += 18;
    }
  }

  drawSelectorButtons() { this.button(this.selBtns.up, '▲', false, 16); this.button(this.selBtns.dn, '▼', false, 16); }

  drawFoxButtons() {
    this.button(this.fireBtn, 'FIRE (F)', false);
    this.button(this.flareBtn, 'FLARE (X)', this.flareFx > 0.6, 12);
    this.button(this.notchBtn, this.notchHold > 0 ? `HOLD ${Math.ceil(this.notchHold)}s` : this.notchCd > 0 ? `NOTCH ${Math.ceil(this.notchCd)}s` : 'NOTCH (N)', this.notchHold > 0, 12);
    this.foxBtns.forEach((b, i) => this.button(b, `${b.label} (${i + 1})`, b.label === this.foxMode, 12));
  }

  drawMissileCounters() {
    const { ctx } = this;
    const pad = 12, gap = 8, w = 200, h = 26;
    let y = this.H - h - pad;
    for (const code of ['FOX-3', 'FOX-2', 'FOX-1']) { // bottom up: AIM-54F at the bottom, AIM-7R on top
      const card = this.spec(code), inv = this.inv[code];
      Object.assign(this.counterRects[code], { x: pad, y, w, h });
      const active = this.foxMode === code, empty = inv.count === 0;
      ctx.save();
      ctx.fillStyle = empty ? '#151515' : active ? '#243524' : '#1e1e1e';
      ctx.strokeStyle = empty ? '#555' : active ? '#8bd88b' : '#777';
      ctx.lineWidth = 1.6;
      ctx.fillRect(pad, y, w, h); ctx.strokeRect(pad, y, w, h);
      ctx.font = `13px ${MONO}`; ctx.textBaseline = 'middle';
      ctx.fillStyle = empty ? '#888' : '#fff';
      ctx.fillText(`${card.short} | ${inv.count}/${card.max}`, pad + 10, y + h / 2 + 1);
      if (inv.regenActive) {
        ctx.fillStyle = '#a8c0ff'; ctx.textAlign = 'right';
        ctx.fillText(`${Math.ceil(inv.regenT)}s`, pad + w - 8, y + h / 2 + 1);
      }
      ctx.restore();
      y -= h + gap;
    }
    const max = this.flareMax();
    Object.assign(this.flareRect, { x: pad, y, w, h });
    ctx.save();
    ctx.fillStyle = this.flares ? '#2a2316' : '#151515';
    ctx.strokeStyle = this.flares ? '#c9a24a' : '#555';
    ctx.lineWidth = 1.6;
    ctx.fillRect(pad, y, w, h); ctx.strokeRect(pad, y, w, h);
    ctx.font = `13px ${MONO}`; ctx.textBaseline = 'middle';
    ctx.fillStyle = this.flares ? '#ffd98a' : '#888';
    ctx.fillText(`CHAFF/FLR | ${this.flares}/${max}`, pad + 10, y + h / 2 + 1);
    if (this.flares < max) {
      ctx.fillStyle = '#a8c0ff'; ctx.textAlign = 'right';
      ctx.fillText(`${Math.ceil(this.flareReload() - this.flareT)}s`, pad + w - 8, y + h / 2 + 1);
    }
    ctx.restore();
  }

  drawMissileInfo() {
    if (!this.infoMode) return;
    const { ctx } = this;
    const m = this.spec(this.infoMode), r = this.counterRects[this.infoMode];
    const padX = 10, padTop = 12, padBottom = 10, w = 280, lh = 16;
    const lines = [
      `Type: ${m.guidance === 'ARH' ? 'Active RADAR' : m.guidance === 'IR' ? 'IR' : 'Semi-active/IR terminal'}`,
      `Speed: Mach ${m.speedMach.toFixed(1)} (~${(m.speedMach * MACH1_KMPS).toFixed(2)} km/s)`,
      `Range: ${m.rMaxKm} km (${(m.rMaxKm / KM_PER_NM).toFixed(0)} nm)`,
      `Turn: ${Math.round(m.turnRateDps)}°/s · fuse ${Math.round(m.killRadiusKm * 1000)} m · dud ${Math.round(m.dud * 100)}%`,
      `Reload: ${m.regen}s per round once empty`,
    ];
    const notes = this.wrap(m.notes, w - 2 * padX, `12px ${MONO}`);
    const contentH = padTop + 18 + (lines.length + notes.length) * lh + padBottom;
    const boxY = r.y - 8 - contentH;
    ctx.save();
    ctx.fillStyle = 'rgba(20,20,20,0.95)'; ctx.strokeStyle = '#6aa56a'; ctx.lineWidth = 2;
    ctx.fillRect(r.x, boxY, w, contentH); ctx.strokeRect(r.x, boxY, w, contentH);
    let ty = boxY + padTop + 8;
    ctx.fillStyle = '#b9ffc0'; ctx.font = `14px ${MONO}`; ctx.fillText(`${m.name} — ${m.code}`, r.x + padX, ty); ty += 18;
    ctx.font = `12px ${MONO}`;
    ctx.fillStyle = '#ddd'; for (const l of lines) { ctx.fillText(l, r.x + padX, ty); ty += lh; }
    ctx.fillStyle = '#aaa'; for (const l of notes) { ctx.fillText(l, r.x + padX, ty); ty += lh; }
    ctx.restore();
  }

  /** Sets the largest font (from `size` down to 8px) at which `text` fits in maxW. */
  fit(text, maxW, size, weight = '') {
    const { ctx } = this;
    for (; size > 8; size -= 0.5) { ctx.font = `${weight}${size}px ${MONO}`; if (ctx.measureText(text).width <= maxW) return; }
  }

  wrap(text, maxWidth, font) {
    const { ctx } = this;
    ctx.save(); ctx.font = font;
    const out = [];
    let line = '';
    for (const word of text.split(' ')) {
      const t = line + word + ' ';
      if (ctx.measureText(t).width > maxWidth && line) { out.push(line.trim()); line = word + ' '; } else line = t;
    }
    if (line) out.push(line.trim());
    ctx.restore();
    return out;
  }

  drawToasts() {
    const { ctx } = this;
    let y = 84;
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      ctx.save();
      ctx.globalAlpha = clamp(t.t / 1.2, 0, 1);
      ctx.fillStyle = t.color; ctx.font = `14px ${MONO}`;
      ctx.fillText(t.msg, 14, y);
      ctx.restore();
      y += 18;
    }
  }

  /** A centered card over the left side. */
  card(title, rows, color) {
    const { ctx } = this;
    const leftW = this.W - PANEL_W;
    // as wide as its longest line (up to the room there is); lines still too long wrap
    ctx.font = `13px ${MONO}`;
    const room = Math.max(200, leftW - 40);
    const w = Math.min(room, Math.max(300, ...rows.map(([t]) => ctx.measureText(t).width + 40)));
    rows = rows.flatMap(([t, c]) => this.wrap(t, w - 30, `13px ${MONO}`).map((l) => [l, c]));
    const hgt = 70 + rows.length * 22;
    const x = (leftW - w) / 2, y = Math.max(60, this.H * 0.45 - hgt / 2);
    ctx.save();
    ctx.fillStyle = 'rgba(10,12,10,0.92)'; ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.fillRect(x, y, w, hgt); ctx.strokeRect(x, y, w, hgt);
    ctx.textAlign = 'center'; ctx.fillStyle = color; ctx.font = `bold 22px ${MONO}`;
    ctx.fillText(title, x + w / 2, y + 36);
    ctx.font = `13px ${MONO}`;
    rows.forEach(([text, c], i) => { ctx.fillStyle = c || '#ddd'; ctx.fillText(text, x + w / 2, y + 66 + i * 22); });
    ctx.restore();
  }

  drawGameOver() {
    const g = this.gameOver, b = g.before || {};
    if (g.auto) {
      this.card('GAME OVER', [
        [g.reason, '#ff8080'],
        [`Auto survived ${clock(g.time)}   ·   score ${g.score.toLocaleString()}   ·   +$${g.earned}`],
        [`Splashes ${g.splashes}   Intercepts ${g.intercepts}`],
        [this.hangarOpen ? 'Holding while the hangar is open' : this.auto ? `Flying again in ${Math.max(0, Math.ceil(this.restartIn))}… · H hangar` : 'Space or START to fly again · H hangar', '#888'],
      ], '#ff4d4d');
      return;
    }
    const newBest = g.score > (b.bestScore || 0);
    this.card('GAME OVER', [
      [g.reason, '#ff8080'],
      [`Score ${g.score.toLocaleString()}${newBest ? '  — NEW HIGH SCORE' : ''}   ·   +$${g.earned}`, newBest ? '#8afc96' : '#ddd'],
      [`Survived ${clock(g.time)}`],
      [`Splashes ${g.splashes}   Intercepts ${g.intercepts}`],
      [`High score ${Math.max(g.score, b.bestScore || 0).toLocaleString()}   ·   best time ${clock(Math.max(g.time, b.bestTime || 0))}`, '#9ecf9f'],
      ['Space or START to fly again · H hangar', '#888'],
    ], '#ff4d4d');
  }

  drawPaused() {
    this.card('PAUSED', [['P or Space to resume', '#ddd'], ['F fire · 1 2 3 weapon · ↑ ↓ / Tab target', '#888'], ['X flare · N notch · A auto · T speed · R restart', '#888']], '#9ecf9f');
  }

  drawReady() {
    if (this.hangarOpen) return;
    this.card('READY', [['Space, Enter or START to take off', '#ddd'], ['H hangar: upgrades are bought between sorties', '#888'], ['A auto · T speed', '#888']], '#8afc96');
  }

  // ---------------------------------------------------------------- input

  togglePause() { if (!this.gameOver && this.started) this.paused = !this.paused; }

  key(e) {
    const k = e.key.toLowerCase();
    if ((!this.started || this.gameOver) && (k === ' ' || k === 'enter')) { if (!this.hangarOpen) this.start(); return true; }
    if (k === 'f') this.fire();
    else if (k === 'x') this.flare();
    else if (k === 'n') this.notch();
    else if (k === '1' || k === '2' || k === '3') this.foxMode = `FOX-${k}`;
    else if (k === 'arrowup' || k === 'w') this.cycleTarget(-1);
    else if (k === 'arrowdown' || k === 's' || (k === 'tab' && !e.shiftKey)) this.cycleTarget(1);
    else if (k === 'tab') this.cycleTarget(-1);
    else if (k === 'r') this.reset();
    else if (k === 'a') this.toggleAuto();
    else if (k === 't') this.cycleSpeed();
    else if (k === 'h') this.onHangar?.();
    else if (k === 'p' || k === ' ' || k === 'escape') { if (k !== 'escape' || !this.paused) this.togglePause(); }
    else return false;
    return true;
  }

  local(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  click(e) {
    const { x, y } = this.local(e);
    this.layout();
    if (inRect(x, y, this.restartBtn)) return this.reset();
    if (inRect(x, y, this.pauseBtn)) return !this.started || this.gameOver ? this.start() : this.togglePause();
    if (inRect(x, y, this.autoBtn)) return this.toggleAuto();
    if (inRect(x, y, this.hangarBtn)) return this.onHangar?.();
    if (inRect(x, y, this.speedBtn)) return this.cycleSpeed();
    if (inRect(x, y, this.selBtns.up)) return this.cycleTarget(-1);
    if (inRect(x, y, this.selBtns.dn)) return this.cycleTarget(1);
    for (const b of this.foxBtns) if (inRect(x, y, b)) { this.foxMode = b.label; return; }
    if (inRect(x, y, this.fireBtn)) return this.fire();
    if (inRect(x, y, this.flareBtn)) return this.flare();
    if (inRect(x, y, this.notchBtn)) return this.notch();
    for (const code of Object.keys(this.counterRects)) if (inRect(x, y, this.counterRects[code])) { this.infoMode = this.infoMode === code ? null : code; return; }
    const { bx, by } = this.scope();
    if (inRect(x, y, { x: bx, y: by, w: BSCOPE_SIZE, h: BSCOPE_SIZE })) {
      let best = null, bestD2 = 100;
      for (const [kind, list] of [['bandit', this.bandits], ['hostile', this.hostiles]]) {
        for (const t of list) {
          if (t._sx == null) continue;
          const d2 = (x - t._sx) ** 2 + (y - t._sy) ** 2;
          if (d2 <= bestD2) { bestD2 = d2; best = { kind, id: t.id }; }
        }
      }
      if (best) { this.selectedKind = best.kind; this.selectedId = best.id; return; }
    }
    const hit = this.contactRegions.find((r) => inRect(x, y, r));
    if (hit) { this.selectedKind = hit.kind; this.selectedId = hit.id; }
  }

  move(e) {
    const p = this.local(e);
    this.mouse = p;
    this.hoveredMissileId = null;
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      if (m._sx != null && (p.x - m._sx) ** 2 + (p.y - m._sy) ** 2 <= 64) { this.hoveredMissileId = m.id; break; }
    }
  }

  wheel(e) {
    const p = this.local(e);
    if (!this.contactRegions.some((r) => inRect(p.x, p.y, r))) return;
    e.preventDefault();
    this.cycleTarget(e.deltaY > 0 ? 1 : -1);
  }
}

// ---------------------------------------------------------------- the flight
// While the easter egg is on, one sortie keeps flying for as long as the app runs: full size in its tab, as a tiny
// radar you can drag anywhere, or folded into the right sidebar. It only stops for the hangar or for P.

const SIM_STEP = 0.05; // s per update (the old frame loop capped steps at 0.06)
const MINI_W = 120, MINI_H = 84;

export class Flight {
  constructor(app) {
    this.app = app;
    // fuses used to come with seekers: pilots who bought seekers keep those levels as fuses too
    const t = app.settings.tomcat;
    if (t?.upgrades?.seeker && t.upgrades.fuse == null) app.saveSettings({ tomcat: { ...t, upgrades: { ...t.upgrades, fuse: t.upgrades.seeker } } });
    this.view = null; // the TomcatEditor drawing it full size, while that tab is the one on screen
    this.game = new TomcatGame(null, {
      best: () => app.settings.tomcat || {},
      onGameOver: (g) => this.record(g),
      auto: !!app.settings.tomcatAuto,
      onAuto: (on) => app.saveSettings({ tomcatAuto: on }),
      upgrades: () => app.settings.tomcat?.upgrades || {},
      onEarn: (n) => this.earn(n),
      onHangar: () => this.view?.toggleHangar(),
      onFlare: () => this.flareSound(),
      speed: app.settings.tomcatSpeed || 1,
      onSpeed: (n) => app.saveSettings({ tomcatSpeed: n }),
      onStart: () => this.launch(),
    });
    // a timer, not animation frames: those stop when the window is minimized. A throttled timer catches up in steps.
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), 16);
    this.buildMini();
    this.onKey = (e) => this.key(e);
    this.onResize = () => this.placeMini();
    document.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);
    this.syncMini();
    if (this.game.auto) this.game.start(); // automatic mode keeps flying from start-up
  }

  /** The first take-off: the top-bar button steps aside for the radar. */
  launch() {
    if (this.launched) return;
    this.launched = this.app.tomcatLaunched = true;
    const btn = document.getElementById('btn-tomcat');
    if (btn) btn.hidden = true;
    this.syncMini();
  }

  tick() {
    const now = performance.now();
    let left = Math.min(600, (now - this.last) / 1000) * this.game.speed; // asleep longer than 10 min: that time is lost
    this.last = now;
    while (left > 1e-6) { const d = Math.min(SIM_STEP, left); this.game.update(d); left -= d; }
  }

  stop() {
    clearInterval(this.timer);
    cancelAnimationFrame(this.miniRaf);
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    this.mini.remove();
    this.app.tomcatLaunched = false;
    this.app.syncRail?.();
    return this.flushCash();
  }

  togglePause() {
    if (this.view?.hangar) return;
    this.game.togglePause();
    this.drawMini();
  }

  /** P pauses while the pointer is on (or focus is in) the F-14 button or the radar. */
  key(e) {
    if (e.key.toLowerCase() !== 'p' || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
    const btn = document.getElementById('btn-tomcat');
    const on = (el) => el && (el.matches(':hover') || el.contains(document.activeElement));
    if (!on(btn) && !(this.mini.isConnected && on(this.mini))) return;
    e.preventDefault();
    e.stopPropagation();
    this.togglePause();
  }

  /** Lifetime stats, kept for the badges to come. Sorties flown in automatic mode count separately (s.auto). */
  record(g) {
    const all = { ...(this.app.settings.tomcat || {}) };
    const s = g.auto ? { ...(all.auto || {}) } : all;
    s.games = (s.games || 0) + 1;
    s.splashes = (s.splashes || 0) + g.splashes;
    s.intercepts = (s.intercepts || 0) + g.intercepts;
    s.flightTime = (s.flightTime || 0) + g.time;
    s.bestTime = Math.max(s.bestTime || 0, g.time);
    s.bestSplashes = Math.max(s.bestSplashes || 0, g.splashes);
    s.bestScore = Math.max(s.bestScore || 0, g.score);
    if (g.auto) all.auto = s;
    this.app.saveSettings({ tomcat: all });
    this.view?.refreshStatus();
  }

  /** Only heard while the game is on screen. */
  flareSound() {
    const s = this.app.settings;
    if (!this.view || s.sounds === false) return;
    const a = new Audio('/assets/sounds/cm.mp3');
    a.volume = Math.max(0, Math.min(1, s.soundVolume ?? 0.7));
    a.play().catch(() => {});
  }

  /** $ from kills: added right away, saved a few seconds later (a busy fight is a lot of kills). */
  earn(n) {
    const t = (this.app.settings.tomcat ||= {});
    t.cash = (t.cash || 0) + n;
    clearTimeout(this.saveCash);
    this.saveCash = setTimeout(() => this.flushCash(), 3000);
    if (this.view?.hangar) this.view.renderHangar();
  }

  flushCash() {
    clearTimeout(this.saveCash);
    this.saveCash = null;
    if (this.app.settings.tomcat) return this.app.saveSettings({ tomcat: { ...this.app.settings.tomcat } });
  }

  // ---- the tiny radar

  buildMini() {
    this.miniCanvas = h('canvas', { class: 'tm-scope' });
    this.miniDist = h('span', { class: 'tm-dist' });
    this.miniPause = h('button', { class: 'tm-btn', title: 'Pause / resume (P)' });
    const fold = h('button', { class: 'tm-btn', title: 'Fold it into the right sidebar' }, '⇥');
    this.miniPause.addEventListener('click', (e) => { e.stopPropagation(); this.togglePause(); });
    fold.addEventListener('click', (e) => { e.stopPropagation(); this.setMini({ docked: true }); });
    this.mini = h('div', { class: 'tomcat-mini', tabindex: '0' }, this.miniCanvas, h('div', { class: 'tm-bar' }, this.miniDist, this.miniPause, fold));
    this.mini.addEventListener('pointerdown', (e) => this.dragMini(e));
  }

  miniState() { return this.app.settings.tomcatMini || {}; }

  setMini(patch) {
    this.app.saveSettings({ tomcatMini: { ...this.miniState(), ...patch } });
    this.syncMini();
  }

  /** Folded: always in the sidebar. Floating: only while the game isn't on screen full size. */
  syncMini() {
    if (!this.launched) {
      cancelAnimationFrame(this.miniRaf);
      this.mini.remove();
      this.app.syncRail?.();
      return;
    }
    const docked = this.miniState().docked ?? true;
    this.mini.classList.toggle('docked', docked);
    this.mini.title = docked
      ? 'F-14F Super Tomcat · click to open · drag it out to float it · P pauses'
      : 'F-14F Super Tomcat · click to open · drag to move, or onto the right sidebar to fold it there · P pauses';
    if (docked) {
      const rail = document.getElementById('rightrail');
      const spacer = rail.querySelector('.rrail-spacer');
      if (this.mini.parentElement !== rail) { if (spacer) spacer.before(this.mini); else rail.append(this.mini); }
      this.mini.style.left = this.mini.style.top = '';
    } else if (this.view) this.mini.remove();
    else {
      if (this.mini.parentElement !== document.body) document.body.append(this.mini);
      this.placeMini();
    }
    this.app.syncRail?.();
    cancelAnimationFrame(this.miniRaf);
    if (this.mini.isConnected) {
      let lastDraw = 0;
      const frame = (t) => {
        if (t - lastDraw > 66) { lastDraw = t; this.drawMini(); } // ~15 fps is plenty for a radar this size
        this.miniRaf = requestAnimationFrame(frame);
      };
      this.drawMini();
      this.miniRaf = requestAnimationFrame(frame);
    }
  }

  placeMini(x = this.miniState().x, y = this.miniState().y) {
    if (this.mini.classList.contains('docked') || !this.mini.isConnected) return;
    const w = this.mini.offsetWidth || MINI_W + 10, ht = this.mini.offsetHeight || MINI_H + 34;
    x ??= innerWidth - w - 50;
    y ??= innerHeight - ht - 50;
    this.mini.style.left = `${clamp(x, 0, innerWidth - w)}px`;
    this.mini.style.top = `${clamp(y, 0, innerHeight - ht)}px`;
  }

  /** Drag to move; drop on the right sidebar to fold it there; drag a folded one out to float it; a click opens the game. */
  dragMini(e) {
    if (e.button !== 0 || e.target.closest('.tm-btn')) return;
    const m = this.mini, rail = document.getElementById('rightrail');
    const sx = e.clientX, sy = e.clientY;
    let r = m.getBoundingClientRect();
    let dx = sx - r.left, dy = sy - r.top, dragging = false;
    try { m.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const overRail = (x, y) => { const q = rail.getBoundingClientRect(); return x >= q.left - 20 && x <= q.right + 20 && y >= q.top && y <= q.bottom; };
    const move = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        dragging = true;
        if (m.classList.contains('docked')) {
          // pulled out of the sidebar: it floats from here on
          m.classList.remove('docked');
          document.body.append(m);
          this.app.syncRail?.();
          r = m.getBoundingClientRect();
          dx = r.width / 2; dy = r.height / 2;
        }
        m.classList.add('dragging');
        rail.classList.add('fling-target');
      }
      this.placeMini(ev.clientX - dx, ev.clientY - dy);
      if (rail.classList.contains('rail-empty')) rail.classList.toggle('peek', ev.clientX > innerWidth - 260);
      rail.classList.toggle('fling-hot', overRail(ev.clientX, ev.clientY));
    };
    const up = (ev) => {
      m.removeEventListener('pointermove', move);
      m.removeEventListener('pointerup', up);
      m.removeEventListener('pointercancel', up);
      rail.classList.remove('fling-target', 'fling-hot', 'peek');
      m.classList.remove('dragging');
      if (!dragging) { this.app.newDocument('tomcat'); return; }
      if (overRail(ev.clientX, ev.clientY)) return this.setMini({ docked: true });
      const q = m.getBoundingClientRect();
      this.setMini({ docked: false, x: Math.round(q.left), y: Math.round(q.top) });
    };
    m.addEventListener('pointermove', move);
    m.addEventListener('pointerup', up);
    m.addEventListener('pointercancel', up);
  }

  /** Bandits and missiles in a ±45° wedge out to 185 km, and the distance to the nearest one. */
  drawMini() {
    const g = this.game, c = this.miniCanvas;
    const docked = this.mini.classList.contains('docked');
    const W = docked ? 22 : MINI_W, H = docked ? 22 : MINI_H;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const ox = W / 2, oy = H - (docked ? 2 : 4);
    const R = Math.min(oy - 2, W / 2 / Math.sin(AZ_LIMIT) - 1);
    const at = (az, d) => { const r = clamp(d / RADAR_RANGE_KM, 0, 1) * R; return [ox + Math.sin(az) * r, oy - Math.cos(az) * r]; };
    // the wedge, range rings, and a sweep
    ctx.strokeStyle = 'rgba(120,220,120,.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(...at(-AZ_LIMIT, RADAR_RANGE_KM)); ctx.moveTo(ox, oy); ctx.lineTo(...at(AZ_LIMIT, RADAR_RANGE_KM)); ctx.stroke();
    for (const k of docked ? [1] : [1 / 3, 2 / 3, 1]) { ctx.beginPath(); ctx.arc(ox, oy, R * k, -Math.PI / 2 - AZ_LIMIT, -Math.PI / 2 + AZ_LIMIT); ctx.stroke(); }
    if (!g.paused && !g.gameOver && g.started) {
      const sweep = Math.sin(performance.now() / 700) * AZ_LIMIT;
      ctx.strokeStyle = 'rgba(140,255,140,.25)'; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(...at(sweep, RADAR_RANGE_KM)); ctx.stroke();
    }
    const dot = docked ? 1.6 : 2.4;
    for (const b of g.bandits) { ctx.fillStyle = b.type === 'J-36' ? '#ffd27a' : '#8ef08e'; ctx.beginPath(); ctx.arc(...at(b.angle, b.distance), dot, 0, Math.PI * 2); ctx.fill(); }
    const blink = Math.floor(performance.now() / 250) % 2 === 0;
    for (const m of g.hostiles) { ctx.fillStyle = blink ? '#ff4d4d' : '#ff9a9a'; ctx.beginPath(); ctx.arc(...at(m.bearing, m.distance), dot, 0, Math.PI * 2); ctx.fill(); }
    // ours: blue, like on the B-scope
    ctx.fillStyle = '#4aa3ff';
    for (const m of g.missiles) if (!m.lost) { ctx.beginPath(); ctx.arc(...at(m.bearing, Math.hypot(m.x, m.y)), dot * 0.75, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#cfe8cf'; ctx.beginPath(); ctx.moveTo(ox, oy - (docked ? 3 : 5)); ctx.lineTo(ox - (docked ? 2 : 3), oy); ctx.lineTo(ox + (docked ? 2 : 3), oy); ctx.fill();
    // nearest enemy: a missile beats a bandit for attention at the same range
    let near = null;
    for (const b of g.bandits) if (!near || b.distance < near.d) near = { d: b.distance, msl: false };
    for (const m of g.hostiles) if (!near || m.distance <= near.d) near = { d: m.distance, msl: true };
    const km = near ? `${near.d < 10 ? near.d.toFixed(1) : Math.round(near.d)}km` : '';
    let label;
    if (g.gameOver) label = g.auto ? `DOWN · ${Math.max(0, Math.ceil(g.restartIn))}s` : 'DOWN';
    else if (!g.started) label = 'READY';
    else if (g.paused) label = 'PAUSED';
    else if (!near) label = 'CLEAR';
    else label = docked ? km : `${near.msl ? 'MSL' : 'BANDIT'} ${km}${g.speed > 1 ? ` ${g.speed}×` : ''}`;
    this.miniDist.textContent = label;
    this.miniDist.classList.toggle('threat', !!near?.msl && !g.paused && !g.gameOver);
    this.miniDist.classList.toggle('down', !!g.gameOver);
    this.miniPause.textContent = g.paused ? '▶' : '❚❚';
  }
}

// ---------------------------------------------------------------- the tab: the flight at full size

export class TomcatEditor extends BaseEditor {
  static mode = 'tomcat';

  async load() {
    this.canvas = h('canvas', { class: 'tomcat-canvas', tabindex: '0' });
    this.root = h('div', { class: 'tomcat-root', 'data-no-clip': '' }, this.canvas);
    this.pane.append(this.root);
    this.flight = await this.app.tomcatFlight();
    this.game = this.flight.game;
    this.canvas.addEventListener('click', (e) => { this.canvas.focus(); this.game.click(e); });
    this.canvas.addEventListener('mousemove', (e) => this.game.move(e));
    this.canvas.addEventListener('mouseleave', () => { this.game.hoveredMissileId = null; });
    this.canvas.addEventListener('wheel', (e) => this.game.wheel(e), { passive: false });
    this.canvas.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (this.game.key(e)) { e.preventDefault(); e.stopPropagation(); }
    });
    this.ro = new ResizeObserver(() => { if (this.game.canvas === this.canvas) this.game.resize(); });
    this.ro.observe(this.root);
    this.show();
  }

  show() {
    if (!this.flight || this.flight.view === this) return;
    this.flight.view = this;
    this.game.attach(this.canvas);
    this.flight.syncMini();
    const frame = () => { this.game.draw(); this.raf = requestAnimationFrame(frame); };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(frame);
    setTimeout(() => (this.hangar || this.canvas)?.focus(), 30);
  }

  /** Off screen (another tab, or closed): the flight carries on as the tiny radar. */
  hide() {
    cancelAnimationFrame(this.raf);
    if (this.hangar) this.closeHangar();
    if (this.flight?.view !== this) return;
    this.flight.view = null;
    this.game.detach();
    this.flight.syncMini();
    this.flight.flushCash();
  }

  // ---- the hangar: spend $ on upgrades that last between sorties

  toggleHangar() {
    if (this.hangar) return this.closeHangar();
    const g = this.game;
    if (!g.canHangar()) { g.toast('HANGAR OPENS BETWEEN SORTIES', 1.6, '#ffb36b'); return; }
    g.hangarOpen = true;
    this.hangar = h('div', { class: 'tomcat-hangar', tabindex: '-1' });
    this.hangar.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key.toLowerCase() === 'h') { e.preventDefault(); e.stopPropagation(); this.closeHangar(); }
    });
    this.root.append(this.hangar);
    this.renderHangar();
    this.hangar.focus();
  }

  closeHangar() {
    this.hangar?.remove();
    this.hangar = null;
    this.game.hangarOpen = false;
    this.canvas.focus();
  }

  renderHangar() {
    const t = this.app.settings.tomcat || {};
    const cash = t.cash || 0;
    const lv = t.upgrades || {};
    const rows = UPGRADES.map((u) => {
      const level = lv[u.id] || 0;
      const cost = upgradeCost(u, level);
      const maxed = level >= u.max;
      const buy = h('button', { class: 'th-buy', disabled: maxed || cash < cost }, maxed ? 'MAX' : `$${cost.toLocaleString()}`);
      buy.addEventListener('click', () => this.buy(u));
      return h('div', { class: 'th-row' },
        h('div', { class: 'th-info' }, h('div', { class: 'th-name' }, u.name), h('div', { class: 'th-what' }, u.what)),
        h('div', { class: 'th-pips' }, ...Array.from({ length: u.max }, (_, i) => h('span', { class: i < level ? 'on' : '' }))),
        buy);
    });
    const close = h('button', { class: 'th-close', title: 'Close (H or Esc)' }, '×');
    close.addEventListener('click', () => this.closeHangar());
    const focused = this.hangar.contains(document.activeElement);
    this.hangar.replaceChildren(h('div', { class: 'th-card' },
      h('div', { class: 'th-head' }, h('span', {}, 'HANGAR'), h('span', { class: 'th-cash' }, `$${cash.toLocaleString()}`), close),
      h('div', { class: 'th-sub' }, 'Splash bandits and missiles for $. Upgrades stay between sorties.'),
      ...rows));
    if (focused) this.hangar.focus();
  }

  buy(u) {
    const t = { ...(this.app.settings.tomcat || {}) };
    const lv = { ...(t.upgrades || {}) };
    const level = lv[u.id] || 0;
    const cost = upgradeCost(u, level);
    if (level >= u.max || (t.cash || 0) < cost) return;
    const g = this.game;
    const before = Object.fromEntries(Object.keys(g.inv).map((k) => [k, g.spec(k).max]));
    t.cash -= cost;
    lv[u.id] = level + 1;
    t.upgrades = lv;
    this.app.settings.tomcat = t;
    this.flight.flushCash();
    // new rails come loaded
    for (const [k, inv] of Object.entries(g.inv)) inv.count += g.spec(k).max - before[k];
    this.app.sounds?.play?.('click');
    this.renderHangar();
  }

  status() {
    const s = this.app.settings.tomcat || {};
    return {
      left: [{ text: 'Space start · F fire · X flare · N notch · 1 2 3 weapon · ↑↓ target · A auto · T speed · H hangar (between sorties) · P pause · R restart' }],
      right: [{ text: `high score ${(s.bestScore || 0).toLocaleString()} · $${(s.cash || 0).toLocaleString()}` }],
    };
  }

  focus() { this.canvas?.focus(); }
  onShow() { this.show(); }
  onHide() { this.hide(); }
  destroy() { this.ro?.disconnect(); this.hide(); }
}
