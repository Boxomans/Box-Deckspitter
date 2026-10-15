// The hidden game's sim: one sortie (radar, bandits, missiles, the dogfight, drawing the scope).

import { toast } from '../../core/ui.js';
import { h } from '../../core/dom.js';
import {
  F14_PATH, PANEL_W, BSCOPE_SIZE, MARGIN, RADAR_RANGE_KM, KILL_RANGE_KM, DOGFIGHT_S, DOGFIGHT_COUNTDOWN,
  DOGFIGHT_CLICKS, MACH1_KMPS, OWN_SPEED, PLAYER_ALT_FT, MIN_ALT_M, MAX_ALT_M, M_TO_FT, KTS_PER_KMPS, KM_PER_NM,
  AZ_LIMIT, KILL_RADIUS_KM, MONO, MISSILES, HOSTILE_MISSILES, INCOME, BOUNTY, NOTCH_HOLD, JINK_KM, AGILITY,
  overshootChance, dudChance, speedsFor, MAGAZINE_STEP, BANDIT_TYPES, H20, H20_FAINT_KM, H20_COLOR, DRONE_AMMO,
  DRONE_RELOAD, DRONE_GAP, GOOSE_PATH, GOOSE_NOSE, rand, rad, clamp, inRect, angNorm, shortCode, clock,
} from './data.js';

export class TomcatGame {
  constructor(canvas, { onGameOver, best, auto = false, onAuto, upgrades, onEarn, onBank, onHangar, onFlare, onFire, onVolume, speed = 1, onSpeed, onStart, mergeSkip } = {}) {
    this.canvas = null;
    this.mergeSkip = mergeSkip || (() => false); // (auto) → true: no click minigame, straight to the 50/50 roll
    this.ctx = null;
    this.onGameOver = onGameOver;
    this.onAuto = onAuto;
    this.upgrades = upgrades || (() => ({}));
    this.onEarn = onEarn;
    this.onBank = onBank;
    this.onHangar = onHangar;
    this.onFlare = onFlare;
    this.onFire = onFire;
    this.onVolume = onVolume;
    this.auto = auto;
    this.speed = speedsFor((best || (() => ({})))().perks).includes(speed) ? speed : 1;
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
    // the top row, left to right at full width (layout() squeezes it to fit a narrow window)
    this.restartBtn = { w: 120, h: 40, size: 15 };
    this.pauseBtn = { w: 96, h: 40, size: 16 };
    this.autoBtn = { w: 96, h: 40, size: 15 };
    this.hangarBtn = { w: 106, h: 40, size: 15 };
    this.speedBtn = { w: 64, h: 40, size: 16 };
    this.volBtn = { w: 104, h: 40, size: 14 };
    this.topRow = [this.restartBtn, this.pauseBtn, this.autoBtn, this.hangarBtn, this.speedBtn, this.volBtn];
    this.hudLow = false; // score readout moved under the buttons (no room beside them)
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
    if (this.started && !this.gameOver) this.onBank?.(); // a sortie thrown away (closing the game) still pays
    this.started = false;
    this.bandits = []; this.missiles = []; this.hostiles = [];
    this.selectedId = null; this.selectedKind = 'bandit';
    this.nextId = 1; this.nextMissileId = 1; this.nextHostileId = 1;
    this.spawnT = 0; this.nextSpawn = rand(3, 7);
    this.h20Sure = H20.every; this.h20At = this.h20Sure;
    this.simTime = 0; this.gameOver = null; this.dogfight = null;
    this.splashes = 0; this.intercepts = 0; this.shots = 0; this.score = 0; this.earned = 0;
    this.usedAuto = this.auto; this.autoCd = 0; this.restartIn = 0;
    this.flares = this.flareMax(); this.flareT = 0; this.flareCd = 0; this.flareFx = 0;
    this.notchCd = 0; this.notchHold = 0;
    this.armor = this.upgrades().armor || 0;
    this.drones = Array.from({ length: this.upgrades().wingman || 0 }, (_, i) => this.newDrone(i));
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

  /** The carrier opens any time. Mid-sortie a manual sortie holds while you're there (nobody's flying it); automatic
   *  keeps flying. */
  canHangar() { return true; }
  holding() { return !!this.hangarOpen && this.started && !this.gameOver && !this.auto; }

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
  /** Bandits fly 5% faster per wave, their missiles 4% faster. */
  banditPace() { return 1 + 0.05 * this.heat(); }
  missilePace() { return 1 + 0.04 * this.heat(); }
  /** Enemy missiles dud 12% of the time on wave 1, 1% less each wave (none from wave 13). ECM adds 6% a level on top. */
  enemyDudBase() { return Math.max(0, 0.12 - 0.01 * this.heat()); }
  enemyDudEcm() { return 0.06 * (this.upgrades().ecm || 0); }
  enemyDud() { return Math.min(0.9, this.enemyDudBase() + this.enemyDudEcm()); }
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

  /** The H-20 shows up for sure every 5 minutes (5:00, 10:00, 15:00…), and after 15:00 also rolls a small chance every
   *  minute. One in the air at a time: a sure one waits for the last to go. */
  maybeH20() {
    if (this.simTime < this.h20At) return;
    const sure = this.simTime >= this.h20Sure;
    if (this.bandits.some((b) => b.type === H20.name)) { this.h20At = this.simTime + (sure ? 1 : 60); return; }
    if (sure) this.h20Sure += H20.every;
    this.h20At = Math.min(this.simTime + 60, this.h20Sure);
    if (!sure && (this.simTime < H20.randomFrom || Math.random() >= H20.perMinute)) return;
    const distance = rand(H20.spawnMin, H20.spawnMax);
    const b = {
      id: 'B' + this.nextId++, type: H20.name, angle: rand(-AZ_LIMIT, AZ_LIMIT) * 0.7, distance, prevDistance: distance,
      altitude: rand(MAX_ALT_M * 0.7, MAX_ALT_M), mach: H20.mach * this.banditPace(), climb: 0,
      closure: 0, shots: 0, salvo: H20.salvos, launchKm: H20.launchKm, nextShotAt: null,
    };
    this.bandits.push(b); // over the bandit limit: it's not one of the wave
    this.toast(`${b.id} H-20 STEALTH BOMBER INBOUND`, 3.2, H20_COLOR);
  }

  /** One H-20 salvo: a fan of PL-15s, or two PL-21s. */
  h20Salvo(b) {
    if (Math.random() < 0.5) {
      this.spawnHostile(b, 'PL-21', { spread: -0.06, quiet: true });
      this.spawnHostile(b, 'PL-21', { spread: 0.06, quiet: true });
      this.toast(`${b.id} FOX (2× PL-21)`, 2, H20_COLOR);
    } else {
      const n = Math.min(9, 5 + Math.floor(this.heat() / 4));
      for (let i = 0; i < n; i++) this.spawnHostile(b, 'PL-15', { spread: (i / (n - 1) - 0.5) * 1.0, quiet: true });
      this.toast(`${b.id} FOX (${n}× PL-15 FAN)`, 2, H20_COLOR);
    }
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
    const tp = this.launch(card, sel);
    this.shots++;
    this.onFire?.();
    inv.count--;
    if (inv.count <= 0 && !inv.regenActive) { inv.regenActive = true; inv.regenT = card.regen; }
    // in range if the missile meets it head-on before running out: it only has to fly d·vm/(vm+vt)
    const vm = card.speedMach * MACH1_KMPS;
    const vt = sel.kind === 'bandit' ? Math.max(0, sel.obj.closure || 0) : sel.obj.speed;
    const far = (Math.hypot(tp.x, tp.y) * vm) / (vm + vt) > card.rMaxKm;
    this.toast(`${card.code} AWAY (${card.short})${far ? ' — OUT OF RANGE' : ''}`, 1.6, far ? '#ffb36b' : '#fff');
  }

  /** A missile off the rails at a track (yours or a drone's). Returns where the target was. */
  launch(card, sel, extra = {}) {
    const tp = this.posOf(sel.kind, sel.obj.id);
    const heading = Math.atan2(tp.x, tp.y);
    this.missiles.push({
      id: 'M' + this.nextMissileId++, code: card.code, name: card.name, guidance: card.guidance,
      turnRate: rad(card.turnRateDps), turnDps: card.turnRateDps, speed: card.speedMach * MACH1_KMPS, rMaxKm: card.rMaxKm, activeKm: card.activeKm,
      state: card.guidance === 'ARH' ? 'inertial' : 'guiding', x: 0, y: 0, heading, rangeKm: 0, bearing: heading, travelled: 0,
      targetId: sel.obj.id, targetKind: sel.kind, killRadiusKm: card.killRadiusKm, dud: card.dud, ...extra,
    });
    return tp;
  }

  /** A missile (yours or a drone's) is already chasing this track. */
  covered(kind, id) { return this.missiles.some((m) => m.targetId === id && m.targetKind === kind && !m.lost); }

  /** Loyal Wingman: drone i (0 on the left, 1 on the right), full of AIM-9Xs. */
  newDrone(i) { return { side: i ? 1 : -1, ammo: DRONE_AMMO, reload: [], cd: 0 }; }

  /** The drones fly their own fight: each takes the nearest bandit or inbound missile in AIM-9X reach that nothing is
   *  already chasing. A shot missile comes back 20 s later. They hold fire through a notch, like you. */
  updateDrones(dt) {
    if (!this.drones?.length) return;
    const card = this.spec('FOX-2');
    const vm = card.speedMach * MACH1_KMPS;
    this.drones.forEach((d, i) => {
      d.cd = Math.max(0, d.cd - dt);
      for (let k = d.reload.length - 1; k >= 0; k--) if ((d.reload[k] -= dt) <= 0) { d.reload.splice(k, 1); d.ammo = Math.min(DRONE_AMMO, d.ammo + 1); }
      if (d.ammo <= 0 || d.cd > 0 || this.notchHold > 0) return;
      const t = this.tracksSorted().find(({ kind, obj }) => {
        if (this.covered(kind, obj.id)) return false;
        if (this.auto && obj.id === this.selectedId && kind === this.selectedKind) return false; // auto's next shot
        const vt = kind === 'bandit' ? Math.max(0, obj.closure || 0) : obj.speed;
        const tp = this.posOf(kind, obj.id);
        return (Math.hypot(tp.x, tp.y) * vm) / (vm + vt) <= card.rMaxKm;
      });
      if (!t) return;
      this.launch(card, t, { byDrone: i + 1 });
      d.ammo--; d.reload.push(DRONE_RELOAD); d.cd = DRONE_GAP;
      this.toast(`GOOSE ${i + 1} FOX-2 (${t.obj.id})`, 1.4, '#9fc2d9');
    });
  }

  /** A missile's numbers with the hangar upgrades applied. */
  spec(code) {
    const base = MISSILES[code];
    const u = this.upgrades();
    const heater = code === 'FOX-2' && this.best().perks?.heater; // Heater bay (a perk): twice the AIM-9Xs
    return {
      ...base,
      max: (base.max + (u.magazine || 0) * MAGAZINE_STEP[code]) * (heater ? 2 : 1),
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
    const [pts, base] = (BOUNTY[what] || [50, 5]).map((n) => Math.round(n * pay));
    const favor = this.best().perks?.favor || 0;
    const cash = Math.max(1, Math.round(INCOME * base * (1 + 0.1 * (this.upgrades().contracts || 0)) * (1 + 0.1 * favor)));
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

  /** 1x -> 2x -> 3x (-> 4x -> 5x with the perk) -> 1x: the whole sim runs faster (Flight.tick takes more steps). */
  cycleSpeed() {
    const list = speedsFor(this.best().perks);
    this.speed = list[(list.indexOf(this.speed) + 1) % list.length];
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
    const plans = this.tracksSorted()
      .filter((t) => !this.covered(t.kind, t.obj.id))
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

  spawnHostile(b, wpn, { spread = 0, quiet = false } = {}) {
    const spec = HOSTILE_MISSILES[wpn];
    const x = Math.sin(b.angle) * b.distance, y = b.distance;
    const heading = Math.atan2(-x, -y) + spread; // a fan leaves off-line and curves in
    this.hostiles.push({
      id: 'H' + this.nextHostileId++, wpn, speed: spec.speedMach * MACH1_KMPS * this.missilePace(), turnRate: rad(spec.turnRateDps), heading,
      x, y, px: x, py: y, bearing: heading, rangeKm: y, altitude: b.altitude, distance: Math.hypot(x, y),
    });
    if (!quiet) this.toast(`${b.id} FOX (${wpn})`, 1.8, '#ff8080');
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
      if (!m.dudRolled && m.distance <= 15) {
        // one roll per missile: their own dud rate (falls with the waves) plus your ECM
        m.dudRolled = true;
        if (Math.random() < this.enemyDud()) { this.hostiles.splice(i, 1); this.toast(`${m.id} DUD${this.upgrades().ecm ? ' (ECM)' : ''}`, 2, '#c9a8ff'); continue; }
      }
      if (m.distance <= 1.0) {
        this.hostiles.splice(i, 1);
        if (this.armor > 0) { this.armor--; this.toast(`HIT BY ${m.wpn} — ARMOR HELD${this.armor ? ` (${this.armor} LEFT)` : ''}`, 2.4, '#ffb36b'); continue; }
        this.end(`HIT BY ${m.wpn}`);
      }
    }
  }

  // ---------------------------------------------------------------- loop

  update(dt) {
    if (this.paused || this.holding()) return;
    for (let i = this.toasts.length - 1; i >= 0; i--) if ((this.toasts[i].t -= dt) <= 0) this.toasts.splice(i, 1);
    if (this.gameOver) {
      // automatic mode flies again on its own (not while you're shopping in the hangar)
      if (this.auto && !this.hangarOpen) { this.restartIn -= dt; if (this.restartIn <= 0) this.reset({ start: true }); }
      return;
    }
    if (!this.started) return;
    if (this.dogfight) { this.updateDogfight(dt / this.speed); return; } // the fight stops the clock (in real time)
    this.simTime += dt;
    this.score += dt; // a point a second
    this.spawnT += dt;
    if (this.spawnT >= this.nextSpawn) { this.spawnT = 0; this.nextSpawn = rand(...this.spawnGap()); this.spawnBandit(); }
    this.maybeH20();

    for (const b of this.bandits) {
      b.prevDistance = b.distance;
      b.closure = Math.max(0, b.mach * MACH1_KMPS + Math.max(0, OWN_SPEED * Math.cos(b.angle)));
      b.distance -= b.closure * dt;
      b.altitude += b.climb * dt;
      if (b.altitude < MIN_ALT_M) { b.altitude = MIN_ALT_M; b.climb = Math.abs(b.climb); }
      if (b.altitude > MAX_ALT_M) { b.altitude = MAX_ALT_M; b.climb = -Math.abs(b.climb); }
      if (b.shots < b.salvo && (b.shots ? this.simTime >= b.nextShotAt : b.distance <= b.launchKm)) {
        if (b.type === H20.name) this.h20Salvo(b);
        else this.spawnHostile(b, b.type === 'J-36' ? 'PL-21' : 'PL-15');
        b.shots++;
        b.nextShotAt = this.simTime + (b.type === H20.name ? H20.gap : this.shotGap(b.type));
      }
    }
    // targets move first, so the missiles' proximity fuse sees where they went this step
    this.updateHostiles(dt);
    this.updateDrones(dt);
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
    if (merged) {
      this.dogfight = { bandit: merged, phase: 'countdown', cd: DOGFIGHT_COUNTDOWN, t: DOGFIGHT_S, clicks: 0, spin: 0, face: 1, hold: 0 };
      if (this.mergeSkip(this.auto)) Object.assign(this.dogfight, { phase: 'roll', hold: 1.4, skipped: true }); // set in SETTINGS
    }
    if (this.selectedTrack() == null) {
      const first = this.tracksSorted()[0];
      this.selectedId = first?.obj.id || null;
      this.selectedKind = first?.kind || 'bandit';
    }
  }

  // ---------------------------------------------------------------- the merge

  /** Clicks only count while the game is on screen; with the tab in the background the fight waits for you. */
  updateDogfight(dt) {
    const f = this.dogfight;
    f.spin += dt;
    const watching = this.watching();
    if (f.phase === 'countdown') {
      if (!watching) { f.cd = DOGFIGHT_COUNTDOWN; return; } // a full 3-2-1 once you're back
      f.cd -= dt;
      if (f.cd <= 0) f.phase = 'qte';
    } else if (f.phase === 'qte') {
      if (!watching) return;
      f.t -= dt;
      if (f.clicks >= DOGFIGHT_CLICKS) { f.phase = 'roll'; f.hold = 1.4; return; }
      if (f.t <= 0) { this.dogfight = null; this.end(`${f.bandit.id} (${f.bandit.type}) WON THE DOGFIGHT`); }
    } else if (f.phase === 'roll') {
      f.hold -= dt;
      if (f.hold > 0) { if ((f.tumble = (f.tumble || 0) + dt) > 0.07) { f.tumble = 0; f.face = 1 + Math.floor(Math.random() * 6); } return; }
      f.face = 1 + Math.floor(Math.random() * 6);
      f.win = f.face >= (f.bandit.type === H20.name ? 3 : 4); // 4, 5, 6: guns kill · 1, 2, 3: you're hit (a bomber: 3 too)
      f.phase = 'result';
      f.hold = 1.5;
    } else if (f.phase === 'result') {
      f.hold -= dt;
      if (f.hold > 0) return;
      this.dogfight = null;
      const b = f.bandit;
      if (!f.win) { this.end(`SHOT DOWN BY ${b.id} (${b.type}) IN THE DOGFIGHT`); return; }
      const i = this.bandits.indexOf(b);
      if (i >= 0) this.bandits.splice(i, 1);
      if (this.selectedId === b.id) this.selectedId = null;
      this.splashes++;
      this.toast(`GUNS GUNS GUNS — SPLASH ${b.id}  +$${this.award(b.type)}`, 2.6, '#8afc96');
    }
  }

  /** Someone's looking at the game: its tab is up and the app window is in front. */
  watching() { return !!this.canvas && !document.hidden && document.hasFocus(); }

  /** A click during the merge. True when it was one (so it doesn't also press a button). */
  dogfightClick() {
    const f = this.dogfight;
    if (!f || this.gameOver) return false;
    if (f.phase === 'qte') f.clicks++;
    return true;
  }

  /** END SORTIE: bring it home. The sortie counts and pays like any other. */
  endSortie() {
    if (!this.started || this.gameOver) return;
    this.dogfight = null; this.paused = false;
    this.end('Back on deck: you ended the sortie', { ended: true });
  }

  end(reason, { ended = false } = {}) {
    if (this.gameOver) return;
    const before = { ...this.best() };
    this.gameOver = { reason, ended, time: this.simTime, splashes: this.splashes, intercepts: this.intercepts, score: Math.floor(this.score), earned: this.earned, auto: this.usedAuto, before };
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
    const leftW0 = this.W - PANEL_W;
    const tg = 10, natural = this.topRow.reduce((n, b) => n + (b.nw ?? b.w), 0) + tg * (this.topRow.length - 1);
    const k = clamp((leftW0 - 20) / natural, 0.45, 1);
    let bxl = 10;
    for (const b of this.topRow) { b.nw ??= b.w; b.w = Math.round(b.nw * k); Object.assign(b, { x: bxl, y: 10 }); bxl += b.w + tg * k; }
    this.topScale = k;
    this.topEnd = bxl - tg * k;
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
    const ts = (b) => Math.max(9, b.size * this.topScale);
    this.button(this.restartBtn, 'END SORTIE', false, ts(this.restartBtn), !this.started || !!this.gameOver, true);
    this.button(this.pauseBtn, !this.started || this.gameOver ? 'START' : this.paused ? 'RESUME' : 'PAUSE', this.paused, ts(this.pauseBtn));
    this.button(this.autoBtn, this.auto ? 'AUTO ON' : 'AUTO', this.auto, ts(this.autoBtn));
    this.button(this.hangarBtn, 'CARRIER', !!this.hangarOpen, ts(this.hangarBtn), !this.canHangar());
    this.button(this.speedBtn, `${this.speed}×`, this.speed > 1, ts(this.speedBtn));
    this.button(this.volBtn, 'SETTINGS', !!this.volOpen, ts(this.volBtn));
    this.drawSelectorButtons();
    this.drawFoxButtons();
    this.drawContacts();
    this.drawMissileCounters();
    this.drawMissileInfo();
    this.drawToasts();
    if (this.gameOver) this.drawGameOver();
    else if (!this.started) this.drawReady();
    else if (this.dogfight) this.drawDogfight();
    else if (this.paused) this.drawPaused();
  }

  /** A top-bar button. warn: the red-edged look for END SORTIE (it ends the run). */
  button(r, label, active, size = 13, dim = false, warn = false) {
    const { ctx } = this;
    ctx.save();
    if (dim) ctx.globalAlpha = 0.35;
    ctx.fillStyle = active ? '#2e5a2e' : warn ? '#261818' : '#1e1e1e';
    ctx.strokeStyle = active ? '#9f9' : warn ? '#d9634f' : '#777';
    ctx.lineWidth = 2;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    if (warn) { ctx.strokeStyle = 'rgba(217,99,79,.35)'; ctx.lineWidth = 1; ctx.strokeRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8); } // a second, inner edge
    ctx.fillStyle = warn ? '#ffc9bd' : '#fff';
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
    this.drawDrones(cx, cy, L);
  }

  /** The FQ-50A drones off each wing (they turn with you on a notch), with their AIM-9Xs and reload underneath. */
  drawDrones(cx, cy, L) {
    const { ctx } = this;
    const S = L * 0.3; // the drone's size on screen
    const turn = this.notchHold > 0 ? (Math.PI / 2) * Math.min(1, (NOTCH_HOLD - this.notchHold) / 0.5, this.notchHold / 0.5) : 0;
    for (const d of this.drones || []) {
      const x = cx + d.side * L * 0.74, y = cy + L * 0.08;
      ctx.save();
      ctx.translate(x, y); ctx.rotate(turn); ctx.translate(-S / 2, -S / 2); ctx.scale(S / 100, S / 100);
      ctx.fillStyle = '#2b2f2b'; ctx.fill(this.goosePath ||= new Path2D(GOOSE_PATH));
      ctx.fillStyle = '#e8743b'; ctx.fill(this.gooseNose ||= new Path2D(GOOSE_NOSE));
      ctx.strokeStyle = '#7f8f7f'; ctx.lineWidth = (100 / S) * 1.2; ctx.stroke(this.goosePath);
      ctx.restore();
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = `12px ${MONO}`;
      ctx.fillStyle = '#cfe8cf';
      const timers = [...d.reload].sort((a, b) => a - b).map((t) => `${Math.ceil(t)}s`).join(' ');
      ctx.fillText(`AIM-9X ${'●'.repeat(d.ammo)}${'○'.repeat(DRONE_AMMO - d.ammo)}  ${timers || `${DRONE_RELOAD}s`}`, x, y + S / 2 + 18);
      ctx.fillStyle = '#6f7f6f'; ctx.font = `10px ${MONO}`;
      ctx.fillText('FQ-50A GOOSE', x, y + S / 2 + 33);
      ctx.restore();
    }
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
    const l1 = `SCORE ${Math.floor(this.score).toLocaleString()}   BEST ${bestScore.toLocaleString()}`;
    const l2 = `SPLASH ${this.splashes}   INT ${this.intercepts}   WAVE ${this.wave()}`;
    const tw = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width);
    const sx = this.topEnd + 12;
    this.hudLow = sx + tw > leftW - 10;
    if (this.hudLow) { ctx.textAlign = 'right'; this.fit(l1.length > l2.length ? l1 : l2, leftW - 120, 14); }
    const hx = this.hudLow ? leftW - 12 : sx, hy = this.hudLow ? 58 : 14;
    ctx.fillText(l1, hx, hy);
    ctx.fillStyle = '#9ecf9f';
    ctx.fillText(l2, hx, hy + 18);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffd36b';
    ctx.font = `bold 16px ${MONO}`;
    ctx.fillText(`$${(best.cash || 0).toLocaleString()}`, 14, 58);
    if (this.started && !this.gameOver) {
      // what this sortie has earned: it's paid when the sortie ends
      ctx.fillStyle = '#6bb8ff';
      ctx.font = `bold 12px ${MONO}`;
      ctx.fillText(`+$${Math.round(this.earned).toLocaleString()} this sortie`, 14, 78);
    }
    if (this.notchHold > 0 && !this.gameOver) {
      ctx.textAlign = 'center';
      ctx.font = `bold 18px ${MONO}`;
      ctx.fillStyle = '#c9a8ff';
      ctx.fillText(`NOTCHING — WEAPONS HOLD ${Math.ceil(this.notchHold)}s`, leftW * 0.45, 92 + (this.hudLow ? 40 : 0));
    }
    if (this.hostiles.length && !this.gameOver && Math.floor(performance.now() / 300) % 2 === 0) {
      ctx.textAlign = 'center';
      ctx.font = `bold 18px ${MONO}`;
      ctx.fillStyle = '#ff4d4d';
      ctx.fillText(`MISSILE${this.hostiles.length > 1 ? ` ×${this.hostiles.length}` : ''}`, leftW * 0.45, 66 + (this.hudLow ? 40 : 0));
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
      const h20 = b.type === H20.name;
      ctx.save();
      if (h20 && b.distance > H20_FAINT_KM) ctx.globalAlpha = 0.15 + 0.35 * Math.abs(Math.sin(this.simTime * 3 + b.distance));
      ctx.fillStyle = h20 ? H20_COLOR : '#ff4d4d'; ctx.beginPath(); ctx.arc(xDot, y, h20 ? 5 : 4, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
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
      ctx.textAlign = 'right';
      ctx.fillStyle = inv.regenActive ? '#a8c0ff' : '#777';
      ctx.fillText(`${Math.ceil(inv.regenActive ? inv.regenT : card.regen)}s`, pad + w - 8, y + h / 2 + 1);
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
    let y = this.hudLow || (this.started && !this.gameOver) ? 104 : 84; // under the sortie $ line while flying
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
    const title = g.ended ? 'SORTIE OVER' : 'GAME OVER', edge = g.ended ? '#8afc96' : '#ff4d4d', why = g.ended ? '#9ecf9f' : '#ff8080';
    if (g.auto) {
      this.card(title, [
        [g.reason, why],
        [`Auto survived ${clock(g.time)}   ·   score ${g.score.toLocaleString()}   ·   +$${g.earned}`],
        [`Splashes ${g.splashes}   Intercepts ${g.intercepts}`],
        [this.hangarOpen ? 'Holding while you’re on the carrier' : this.auto ? `Flying again in ${Math.max(0, Math.ceil(this.restartIn))}…` : 'Space or START to fly again', '#888'],
      ], edge);
      return;
    }
    const newBest = g.score > (b.bestScore || 0);
    this.card(title, [
      [g.reason, why],
      [`Score ${g.score.toLocaleString()}${newBest ? '  — NEW HIGH SCORE' : ''}   ·   +$${g.earned}`, newBest ? '#8afc96' : '#ddd'],
      [`Survived ${clock(g.time)}`],
      [`Splashes ${g.splashes}   Intercepts ${g.intercepts}`],
      [`High score ${Math.max(g.score, b.bestScore || 0).toLocaleString()}   ·   best time ${clock(Math.max(g.time, b.bestTime || 0))}`, '#9ecf9f'],
      ['Space or START to fly again', '#888'],
    ], edge);
  }

  /** The merge: two jets chasing each other round a circle, the click meter, then the dice. */
  drawDogfight() {
    const { ctx } = this;
    const f = this.dogfight;
    const leftW = this.W - PANEL_W;
    const w = Math.min(leftW - 40, 460), hgt = 360;
    const x = (leftW - w) / 2, y = Math.max(60, this.H * 0.45 - hgt / 2);
    const red = '#ff5d5d', green = '#8afc96';
    ctx.save();
    ctx.fillStyle = 'rgba(10,12,10,0.94)'; ctx.strokeStyle = f.phase === 'result' ? (f.win ? green : red) : '#ffb36b'; ctx.lineWidth = 2;
    ctx.fillRect(x, y, w, hgt); ctx.strokeRect(x, y, w, hgt);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffb36b'; ctx.font = `bold 22px ${MONO}`;
    ctx.fillText(`MERGED — ${f.bandit.id} (${f.bandit.type})`, x + w / 2, y + 34);
    // the turning fight: F-14 and bandit on one circle, the bandit a little behind and closing
    const cx = x + w / 2, cy = y + 140, r = 62;
    ctx.strokeStyle = '#2a2f2a'; ctx.setLineDash([4, 6]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    const a = f.spin * 2.6;
    const at = (ang) => [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r];
    // going round clockwise: the nose points along the circle (a + π in drawJet's frame), the bandit on its tail
    this.drawJet(...at(a), a + Math.PI, 'f14', '#cfe8cf');
    this.drawJet(...at(a - 1.0), a - 1.0 + Math.PI, { 'J-36': 'j36', 'H-20': 'h20' }[f.bandit.type] || 'flanker', red);
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = '#cfe8cf'; ctx.fillText('F-14F', ...at(a).map((v, i) => v + (i ? -16 : 0)));
    ctx.fillStyle = red; ctx.fillText(f.bandit.type, ...at(a - 1.0).map((v, i) => v + (i ? -16 : 0)));
    const barX = x + 30, barW = w - 60;
    if (f.phase === 'countdown') {
      const n = Math.max(1, Math.ceil(f.cd));
      const k = f.cd - Math.floor(f.cd); // shrinks through each second
      ctx.fillStyle = '#ffd36b'; ctx.font = `bold ${Math.round(40 + 28 * k)}px ${MONO}`;
      ctx.fillText(this.watching() ? String(n) : '…', cx, y + 290);
      ctx.fillStyle = '#999'; ctx.font = `13px ${MONO}`;
      ctx.fillText(`Get ready: then click ${DOGFIGHT_CLICKS} times in ${DOGFIGHT_S}s`, cx, y + 330);
    } else if (f.phase === 'qte') {
      const pulse = 0.6 + 0.4 * Math.abs(Math.sin(f.spin * 9));
      ctx.fillStyle = `rgba(255,211,107,${pulse})`; ctx.font = `bold 20px ${MONO}`;
      ctx.fillText(this.watching() ? 'CLICK AS FAST AS YOU CAN!' : 'WAITING FOR YOU…', cx, y + 248);
      // clicks
      ctx.fillStyle = '#1d241d'; ctx.fillRect(barX, y + 264, barW, 16);
      ctx.fillStyle = green; ctx.fillRect(barX, y + 264, barW * Math.min(1, f.clicks / DOGFIGHT_CLICKS), 16);
      ctx.strokeStyle = '#3c5a3c'; ctx.strokeRect(barX, y + 264, barW, 16);
      // time
      ctx.fillStyle = '#1d241d'; ctx.fillRect(barX, y + 288, barW, 6);
      ctx.fillStyle = f.t < 1 ? red : '#ffb36b'; ctx.fillRect(barX, y + 288, barW * Math.max(0, f.t / DOGFIGHT_S), 6);
      ctx.fillStyle = '#999'; ctx.font = `13px ${MONO}`;
      ctx.fillText(`${f.clicks} / ${DOGFIGHT_CLICKS} clicks · ${Math.max(0, f.t).toFixed(1)}s`, cx, y + 320);
      ctx.fillText('Get guns on it, or it gets you', cx, y + 342);
    } else {
      // the roll: a die, 4–6 is the kill
      const s = 44, dx = cx - s / 2, dy = y + 222;
      ctx.fillStyle = '#eee'; ctx.fillRect(dx, dy, s, s);
      ctx.fillStyle = '#111';
      const pip = (px, py) => { ctx.beginPath(); ctx.arc(dx + px * s, dy + py * s, 4, 0, Math.PI * 2); ctx.fill(); };
      const P = { 1: [[0.5, 0.5]], 2: [[0.25, 0.25], [0.75, 0.75]], 3: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]], 4: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]], 5: [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]], 6: [[0.25, 0.22], [0.75, 0.22], [0.25, 0.5], [0.75, 0.5], [0.25, 0.78], [0.75, 0.78]] };
      for (const [px, py] of P[f.face]) pip(px, py);
      ctx.font = `bold 18px ${MONO}`;
      if (f.phase === 'roll') { ctx.fillStyle = '#ffd36b'; ctx.fillText(f.skipped ? 'ROLLING FOR IT…' : 'GUNS ON HIM — ROLLING…', cx, y + 300); }
      else { ctx.fillStyle = f.win ? green : red; ctx.fillText(f.win ? 'SPLASH — YOU WIN THE MERGE' : 'HE GOT YOU FIRST', cx, y + 300); }
      ctx.fillStyle = '#999'; ctx.font = `13px ${MONO}`;
      ctx.fillText('4–6: guns kill  ·  1–3: you’re hit', cx, y + 330);
    }
    ctx.restore();
  }

  /** A jet seen from above, nose along `heading` (radians, 0 = up the screen). */
  drawJet(x, y, heading, kind, color) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading);
    ctx.fillStyle = color;
    ctx.beginPath();
    if (kind === 'f14') {
      // the same F-14 as the ownship and the app icon (a 100-unit box, nose at the top), centered and ~32 long
      ctx.scale(0.32, 0.32);
      ctx.translate(-50, -50);
      ctx.fill(this.f14Path ||= new Path2D(F14_PATH));
      ctx.restore();
      return;
    } else {
      // the right half, nose to tail, mirrored for the left
      const half = kind === 'h20'
        // H-20: a flying wing, swept leading edge and a W-shaped trailing edge
        ? [[0, -13], [3, -10], [24, 6], [24, 8.5], [16, 8.5], [11, 4.5], [6, 9.5], [0, 6]]
        : kind === 'j36'
        // J-36: big tailless cranked delta, long chined nose, sawtooth trailing edge
        ? [[0, -22], [1.6, -16], [3, -9], [6, -3], [18, 11], [18, 12.5], [11, 13], [7, 17], [3, 14], [0, 16]]
        // J-11 (Su-27 clone): needle nose, curved LERX into a clipped trapezoid wing, wide-set engines,
        // big stabilators reaching past the nozzles and the stinger between them
        : [[0, -19], [1, -15], [1.8, -10], [2.4, -6], [4, -2.5], [6, 0.5], [14, 7], [14, 9.5], [6.5, 9.5], [6, 11.5],
           [11.5, 14.5], [11.5, 16.5], [5.5, 15.5], [5, 17.5], [2.6, 17.5], [1.4, 15], [0.8, 19], [0, 19.5]];
      const pts = [...half, ...half.slice(1, -1).reverse().map(([px, py]) => [-px, py])];
      const k = kind === 'j36' ? 0.95 : 0.85;
      pts.forEach(([px, py], i) => (i ? ctx.lineTo(px * k, py * k) : ctx.moveTo(px * k, py * k)));
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawPaused() {
    this.card('PAUSED', [['P or Space to resume', '#ddd'], ['F fire · 1 2 3 weapon · ↑ ↓ / Tab target', '#888'], ['X flare · N notch · A auto · T speed · R end sortie', '#888']], '#9ecf9f');
  }

  drawReady() {
    if (this.hangarOpen) return;
    this.card('READY', [['Space, Enter or START to take off', '#ddd'], ['H carrier: spend $ any time · a sortie pays when it ends', '#888'], ['A auto · T speed', '#888']], '#8afc96');
  }

  // ---------------------------------------------------------------- input

  togglePause() { if (!this.gameOver && this.started && !this.dogfight) this.paused = !this.paused; }

  key(e) {
    const k = e.key.toLowerCase();
    if ((!this.started || this.gameOver) && (k === ' ' || k === 'enter')) { if (!this.hangarOpen) this.start(); return true; }
    if (this.dogfight && !this.gameOver) return k !== 'r' ? ['f', 'x', 'n', ' ', 'p', 'a', 'h', 'tab'].includes(k) : (this.endSortie(), true); // the merge is clicks only
    if (k === 'f') this.fire();
    else if (k === 'x') this.flare();
    else if (k === 'n') this.notch();
    else if (k === '1' || k === '2' || k === '3') this.foxMode = `FOX-${k}`;
    else if (k === 'arrowup' || k === 'w') this.cycleTarget(-1);
    else if (k === 'arrowdown' || k === 's' || (k === 'tab' && !e.shiftKey)) this.cycleTarget(1);
    else if (k === 'tab') this.cycleTarget(-1);
    else if (k === 'r') this.endSortie();
    else if (k === 'a') this.toggleAuto();
    else if (k === 't') this.cycleSpeed();
    else if (k === 'v') this.onVolume?.(this.volBtn);
    else if (k === 'h') this.onHangar?.();
    else if (k === 'p' || k === ' ' || k === 'escape') { if (k !== 'escape' || !this.paused) this.togglePause(); }
    else return false;
    return true;
  }

  local(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  click(e) {
    if (this.dogfight && !this.gameOver) return; // counted on pointerdown
    const { x, y } = this.local(e);
    this.layout();
    if (inRect(x, y, this.restartBtn)) return this.endSortie();
    if (inRect(x, y, this.pauseBtn)) return !this.started || this.gameOver ? this.start() : this.togglePause();
    if (inRect(x, y, this.autoBtn)) return this.toggleAuto();
    if (inRect(x, y, this.hangarBtn)) return this.onHangar?.();
    if (inRect(x, y, this.speedBtn)) return this.cycleSpeed();
    if (inRect(x, y, this.volBtn)) return this.onVolume?.(this.volBtn);
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
