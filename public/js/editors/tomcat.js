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
  constructor(canvas, { onGameOver, best } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onGameOver = onGameOver;
    this.best = best || (() => ({}));
    this.W = 0; this.H = 0;
    this.paused = false;
    this.running = false;
    this.mouse = { x: 0, y: 0 };
    this.hoveredMissileId = null;
    this.infoMode = null;
    this.toasts = [];
    this.counterRects = { 'FOX-1': {}, 'FOX-2': {}, 'FOX-3': {} };
    this.selBtns = { up: { w: 32, h: 32 }, dn: { w: 32, h: 32 } };
    this.foxBtns = ['FOX-1', 'FOX-2', 'FOX-3'].map((label) => ({ label, w: 92, h: 36 }));
    this.fireBtn = { w: 92, h: 36 };
    this.restartBtn = { x: 10, y: 10, w: 120, h: 40 };
    this.pauseBtn = { x: 140, y: 10, w: 96, h: 40 };
    this.contactRegions = [];
    this.reset();
  }

  // ---------------------------------------------------------------- state

  reset() {
    this.bandits = []; this.missiles = []; this.hostiles = [];
    this.selectedId = null; this.selectedKind = 'bandit';
    this.nextId = 1; this.nextMissileId = 1; this.nextHostileId = 1;
    this.spawnT = 0; this.nextSpawn = rand(3, 7);
    this.simTime = 0; this.gameOver = null;
    this.splashes = 0; this.intercepts = 0; this.shots = 0;
    this.inv = Object.fromEntries(Object.entries(MISSILES).map(([k, m]) => [k, { count: m.max, regenT: 0, regenActive: false }]));
    this.foxMode = 'FOX-1';
    this.infoMode = null;
    this.toasts.length = 0;
    this.paused = false;
  }

  toast(msg, t = 1.6, color = '#fff') { this.toasts.push({ msg, t, color }); if (this.toasts.length > 8) this.toasts.shift(); }

  /** More bandits at once, arriving sooner, the longer you last. */
  maxBandits() { return Math.min(6, 3 + Math.floor(this.simTime / 90)); }
  spawnGap() { const k = Math.max(0.45, 1 - this.simTime / 600); return [3 * k, 7 * k]; }

  spawnBandit() {
    if (this.bandits.length >= this.maxBandits()) return;
    const pick = BANDIT_TYPES[Math.floor(Math.random() * BANDIT_TYPES.length)];
    const distance = rand(pick.spawnMin, pick.spawnMax);
    const b = {
      id: 'B' + this.nextId++, type: pick.name, angle: rand(-AZ_LIMIT, AZ_LIMIT), distance, prevDistance: distance,
      altitude: rand(MIN_ALT_M, MAX_ALT_M), mach: pick.mach, climb: (Math.random() < 0.5 ? -1 : 1) * rand(5, 20),
      closure: 0, fired1: false, fired2: false, nextShotAt: null,
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
    const sel = this.selectedTrack();
    if (!sel) { this.toast('NO TARGET'); return; }
    const card = MISSILES[this.foxMode];
    const inv = this.inv[this.foxMode];
    if (inv.count <= 0) { this.toast(`OUT OF ${card.short} — ${Math.ceil(inv.regenT)}s`, 1.6, '#ffb36b'); return; }
    const tp = this.posOf(sel.kind, sel.obj.id);
    const heading = Math.atan2(tp.x, tp.y);
    this.missiles.push({
      id: 'M' + this.nextMissileId++, code: card.code, name: card.name, guidance: card.guidance,
      turnRate: rad(card.turnRateDps), speed: card.speedMach * MACH1_KMPS, rMaxKm: card.rMaxKm, activeKm: card.activeKm,
      state: card.guidance === 'ARH' ? 'inertial' : 'guiding', x: 0, y: 0, heading, rangeKm: 0, bearing: heading, travelled: 0,
      targetId: sel.obj.id, targetKind: sel.kind,
    });
    this.shots++;
    inv.count--;
    if (inv.count <= 0 && !inv.regenActive) { inv.regenActive = true; inv.regenT = card.regen; }
    const dist = Math.hypot(tp.x, tp.y);
    this.toast(`${card.code} AWAY (${card.short})${dist > card.rMaxKm ? ' — OUT OF RANGE' : ''}`, 1.6, dist > card.rMaxKm ? '#ffb36b' : '#fff');
  }

  updateMissiles(dt) {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      const tp = this.posOf(m.targetKind, m.targetId);
      const px = m.x, py = m.y;
      if (tp) {
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
      if (m.travelled >= m.rMaxKm) { this.missiles.splice(i, 1); this.toast('MISSILE LOST (range)', 1.6, '#aaa'); continue; }
      if (!tp) continue;
      // continuous proximity fuse: closest approach during this step, in the target's frame
      const tpPrev = this.posOf(m.targetKind, m.targetId, true) || tp;
      const R0x = px - tpPrev.x, R0y = py - tpPrev.y;
      const Vx = (m.x - px) - (tp.x - tpPrev.x);
      const Vy = (m.y - py) - (tp.y - tpPrev.y);
      const denom = Vx * Vx + Vy * Vy;
      const u = denom > 1e-9 ? clamp(-(R0x * Vx + R0y * Vy) / denom, 0, 1) : 0;
      if (Math.hypot(R0x + u * Vx, R0y + u * Vy) >= KILL_RADIUS_KM) continue;
      this.missiles.splice(i, 1);
      if (m.targetKind === 'bandit') {
        const bi = this.bandits.findIndex((b) => b.id === m.targetId);
        if (bi >= 0) { this.bandits.splice(bi, 1); this.splashes++; this.toast(`SPLASH ${m.targetId}`, 2, '#8afc96'); }
      } else {
        const hi = this.hostiles.findIndex((x) => x.id === m.targetId);
        if (hi >= 0) { this.hostiles.splice(hi, 1); this.intercepts++; this.toast(`INTERCEPT ${m.targetId}`, 2, '#8fbfff'); }
      }
    }
  }

  spawnHostile(b, wpn) {
    const spec = HOSTILE_MISSILES[wpn];
    const x = Math.sin(b.angle) * b.distance, y = b.distance;
    const heading = Math.atan2(-x, -y);
    this.hostiles.push({
      id: 'H' + this.nextHostileId++, wpn, speed: spec.speedMach * MACH1_KMPS, turnRate: rad(spec.turnRateDps), heading,
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
      if (m.distance <= 1.0) { this.hostiles.splice(i, 1); this.end(`HIT BY ${m.wpn}`); }
    }
  }

  // ---------------------------------------------------------------- loop

  update(dt) {
    if (this.gameOver || this.paused) return;
    this.simTime += dt;
    this.spawnT += dt;
    if (this.spawnT >= this.nextSpawn) { this.spawnT = 0; this.nextSpawn = rand(...this.spawnGap()); this.spawnBandit(); }

    for (const b of this.bandits) {
      b.prevDistance = b.distance;
      b.closure = Math.max(0, b.mach * MACH1_KMPS + Math.max(0, OWN_SPEED * Math.cos(b.angle)));
      b.distance -= b.closure * dt;
      b.altitude += b.climb * dt;
      if (b.altitude < MIN_ALT_M) { b.altitude = MIN_ALT_M; b.climb = Math.abs(b.climb); }
      if (b.altitude > MAX_ALT_M) { b.altitude = MAX_ALT_M; b.climb = -Math.abs(b.climb); }
      if (b.type === 'J-36') {
        if (!b.fired1 && b.distance <= 160) { this.spawnHostile(b, 'PL-21'); b.fired1 = true; }
      } else {
        if (!b.fired1 && b.distance <= 80) { this.spawnHostile(b, 'PL-15'); b.fired1 = true; b.nextShotAt = this.simTime + 8; }
        if (b.fired1 && !b.fired2 && this.simTime >= (b.nextShotAt ?? Infinity)) { this.spawnHostile(b, 'PL-15'); b.fired2 = true; }
      }
    }
    // targets move first, so the missiles' proximity fuse sees where they went this step
    this.updateHostiles(dt);
    this.updateMissiles(dt);

    for (const [code, inv] of Object.entries(this.inv)) {
      const card = MISSILES[code];
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
    this.gameOver = { reason, time: this.simTime, splashes: this.splashes, intercepts: this.intercepts, before };
    this.onGameOver?.(this.gameOver);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const frame = (t) => {
      if (!this.running) return;
      const dt = Math.min(0.06, (t - this.last) / 1000);
      this.last = t;
      this.update(dt);
      this.draw(dt);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.W = Math.max(1, r.width); this.H = Math.max(1, r.height);
    this.canvas.width = Math.floor(this.W * dpr);
    this.canvas.height = Math.floor(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.running) this.draw(0);
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
  }

  // ---------------------------------------------------------------- drawing

  draw(dt) {
    const { ctx, W, H } = this;
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
    this.button(this.pauseBtn, this.paused ? 'RESUME' : 'PAUSE', this.paused, 16);
    this.drawSelectorButtons();
    this.drawFoxButtons();
    this.drawContacts();
    this.drawMissileCounters();
    this.drawMissileInfo();
    this.drawToasts(this.paused || this.gameOver ? 0 : dt);
    if (this.gameOver) this.drawGameOver();
    else if (this.paused) this.drawPaused();
  }

  button(r, label, active, size = 13) {
    const { ctx } = this;
    ctx.save();
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
    ctx.fillText(`SPLASH ${this.splashes}   INT ${this.intercepts}   WAVE ${this.maxBandits() - 2}`, 250, 22);
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

    const card = MISSILES[this.foxMode];
    const rKm = Math.min(card.rMaxKm, RADAR_RANGE_KM);
    const yR = by + BSCOPE_SIZE - rKm * kmToPx;
    ctx.strokeStyle = '#4aa3ff'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(bx, yR); ctx.lineTo(bx + BSCOPE_SIZE, yR); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#8fbfff'; ctx.font = `11px ${MONO}`; ctx.fillText(`Rmax ${rKm} km`, bx + BSCOPE_SIZE - 80, yR - 4);

    for (const m of this.missiles) {
      const my = by + BSCOPE_SIZE - m.rangeKm * kmToPx;
      const mx = this.scopeX(m.rangeKm, m.bearing, bx);
      m._sx = mx; m._sy = my;
      ctx.fillStyle = '#4aa3ff'; ctx.beginPath(); ctx.arc(mx, my, 3, 0, Math.PI * 2); ctx.fill();
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
    ctx.fillStyle = '#6a8f6a'; ctx.font = `11px ${MONO}`; ctx.fillText('◆ = in range of the selected missile', x + MARGIN + 100, y);
    y += 6;
    ctx.strokeStyle = '#2a2'; ctx.beginPath(); ctx.moveTo(x + MARGIN, y + 6); ctx.lineTo(x + PANEL_W - MARGIN, y + 6); ctx.stroke();
    y += 22;
    const tracks = this.tracksSorted();
    if (!tracks.length) { ctx.fillStyle = '#bbb'; ctx.font = `12px ${MONO}`; ctx.fillText('None', x + MARGIN, y); return; }
    const sel = this.selectedTrack();
    const rMax = MISSILES[this.foxMode].rMaxKm;
    for (const t of tracks) {
      if (y > this.H - 10) break;
      const o = t.obj;
      const isBandit = t.kind === 'bandit';
      const altFt = Math.round(((o.altitude || MIN_ALT_M) * M_TO_FT) / 100) * 100;
      const vcKts = Math.round((isBandit ? o.closure : o.speed) * KTS_PER_KMPS);
      const mach = isBandit ? o.mach : o.speed / MACH1_KMPS;
      const name = `${o.id} ${isBandit ? o.type : o.wpn}`.padEnd(9);
      const line = `${o.distance <= rMax ? '◆' : ' '} ${name} ${altFt > PLAYER_ALT_FT ? '▲' : '▼'}${(altFt / 1000).toFixed(1)}k ft  ${Math.round(o.distance)}km  Vc ${vcKts}kt M${mach.toFixed(1)}`;
      if (sel && sel.obj === o) { ctx.save(); ctx.fillStyle = 'rgba(80,140,80,0.35)'; ctx.fillRect(x + MARGIN - 2, y - 12, PANEL_W - MARGIN * 2, 20); ctx.restore(); }
      ctx.fillStyle = isBandit ? '#fff' : '#ffb3b3'; ctx.font = `12px ${MONO}`; ctx.fillText(line, x + MARGIN, y);
      if (this.missiles.some((m) => m.targetId === o.id)) {
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
    this.foxBtns.forEach((b, i) => this.button(b, `${b.label} (${i + 1})`, b.label === this.foxMode, 12));
  }

  drawMissileCounters() {
    const { ctx } = this;
    const pad = 12, gap = 8, w = 200, h = 26;
    let y = this.H - h - pad;
    for (const code of ['FOX-1', 'FOX-2', 'FOX-3']) {
      const card = MISSILES[code], inv = this.inv[code];
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
  }

  drawMissileInfo() {
    if (!this.infoMode) return;
    const { ctx } = this;
    const m = MISSILES[this.infoMode], r = this.counterRects[this.infoMode];
    const padX = 10, padTop = 12, padBottom = 10, w = 280, lh = 16;
    const lines = [
      `Type: ${m.guidance === 'ARH' ? 'Active RADAR' : m.guidance === 'IR' ? 'IR' : 'Semi-active/IR terminal'}`,
      `Speed: Mach ${m.speedMach.toFixed(1)} (~${(m.speedMach * MACH1_KMPS).toFixed(2)} km/s)`,
      `Range: ${m.rMaxKm} km (${(m.rMaxKm / KM_PER_NM).toFixed(0)} nm)`,
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

  drawToasts(dt) {
    const { ctx } = this;
    let y = 84;
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.t -= dt;
      if (t.t <= 0) { this.toasts.splice(i, 1); continue; }
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
    const w = Math.min(380, leftW - 40), hgt = 70 + rows.length * 22;
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
    const newBest = g.time > (b.bestTime || 0);
    this.card('GAME OVER', [
      [g.reason, '#ff8080'],
      [`Survived ${clock(g.time)}${newBest ? '  — NEW BEST' : ''}`, newBest ? '#8afc96' : '#ddd'],
      [`Splashes ${g.splashes}   Intercepts ${g.intercepts}`],
      [`Best ${clock(Math.max(g.time, b.bestTime || 0))}   ·   most splashes ${Math.max(g.splashes, b.bestSplashes || 0)}`, '#9ecf9f'],
      ['R or RESTART to fly again', '#888'],
    ], '#ff4d4d');
  }

  drawPaused() {
    this.card('PAUSED', [['P or Space to resume', '#ddd'], ['F fire · 1 2 3 weapon · ↑ ↓ / Tab target · R restart', '#888']], '#9ecf9f');
  }

  // ---------------------------------------------------------------- input

  togglePause() { if (!this.gameOver) this.paused = !this.paused; }

  key(e) {
    const k = e.key.toLowerCase();
    if (k === 'f') this.fire();
    else if (k === '1' || k === '2' || k === '3') this.foxMode = `FOX-${k}`;
    else if (k === 'arrowup' || k === 'w') this.cycleTarget(-1);
    else if (k === 'arrowdown' || k === 's' || (k === 'tab' && !e.shiftKey)) this.cycleTarget(1);
    else if (k === 'tab') this.cycleTarget(-1);
    else if (k === 'r') this.reset();
    else if (k === 'p' || k === ' ' || k === 'escape') { if (k !== 'escape' || !this.paused) this.togglePause(); }
    else return false;
    return true;
  }

  local(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  click(e) {
    const { x, y } = this.local(e);
    this.layout();
    if (inRect(x, y, this.restartBtn)) return this.reset();
    if (inRect(x, y, this.pauseBtn)) return this.togglePause();
    if (inRect(x, y, this.selBtns.up)) return this.cycleTarget(-1);
    if (inRect(x, y, this.selBtns.dn)) return this.cycleTarget(1);
    for (const b of this.foxBtns) if (inRect(x, y, b)) { this.foxMode = b.label; return; }
    if (inRect(x, y, this.fireBtn)) return this.fire();
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

export class TomcatEditor extends BaseEditor {
  static mode = 'tomcat';

  async load() {
    this.canvas = h('canvas', { class: 'tomcat-canvas', tabindex: '0' });
    this.root = h('div', { class: 'tomcat-root', 'data-no-clip': '' }, this.canvas);
    this.pane.append(this.root);
    this.game = new TomcatGame(this.canvas, {
      best: () => this.app.settings.tomcat || {},
      onGameOver: (g) => this.record(g),
    });
    this.canvas.addEventListener('click', (e) => { this.canvas.focus(); this.game.click(e); });
    this.canvas.addEventListener('mousemove', (e) => this.game.move(e));
    this.canvas.addEventListener('mouseleave', () => { this.game.hoveredMissileId = null; });
    this.canvas.addEventListener('wheel', (e) => this.game.wheel(e), { passive: false });
    this.canvas.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (this.game.key(e)) { e.preventDefault(); e.stopPropagation(); }
    });
    this.ro = new ResizeObserver(() => this.game.resize());
    this.ro.observe(this.root);
    this.game.resize();
    this.game.start();
    setTimeout(() => this.canvas.focus(), 30);
  }

  /** Lifetime stats, kept for the badges to come. */
  record(g) {
    const s = { ...(this.app.settings.tomcat || {}) };
    s.games = (s.games || 0) + 1;
    s.splashes = (s.splashes || 0) + g.splashes;
    s.intercepts = (s.intercepts || 0) + g.intercepts;
    s.flightTime = (s.flightTime || 0) + g.time;
    s.bestTime = Math.max(s.bestTime || 0, g.time);
    s.bestSplashes = Math.max(s.bestSplashes || 0, g.splashes);
    this.app.saveSettings({ tomcat: s });
    this.refreshStatus();
  }

  status() {
    const s = this.app.settings.tomcat || {};
    return {
      left: [{ text: 'F fire · 1 2 3 weapon · ↑↓ target · P pause · R restart' }],
      right: s.games ? [{ text: `best ${clock(s.bestTime || 0)} · ${s.splashes || 0} splashes in ${s.games} sortie${s.games === 1 ? '' : 's'}` }] : [],
    };
  }

  focus() { this.canvas?.focus(); }
  onShow() { this.game?.start(); this.game?.resize(); setTimeout(() => this.canvas?.focus(), 30); }
  onHide() { if (this.game) { if (!this.game.gameOver && this.game.simTime > 0) this.game.paused = true; this.game.stop(); } }
  destroy() { this.ro?.disconnect(); this.game?.stop(); }
}
