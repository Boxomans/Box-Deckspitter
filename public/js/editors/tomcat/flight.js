// The hidden game's Flight: the sortie that keeps running in the background, saving, badges, the mini radar.

import { toast } from '../../core/ui.js';
import { h } from '../../core/dom.js';
import { RADAR_RANGE_KM, AZ_LIMIT, MONO, H20, H20_COLOR, clamp } from './data.js';
import { TomcatGame } from './game.js';

// ---------------------------------------------------------------- the flight
// While the easter egg is on, one sortie keeps flying for as long as the app runs: full size in its tab, as a tiny
// radar you can drag anywhere, or folded into the right sidebar. It only stops for the hangar or for P.

// Badges: lifetime totals (manual and automatic sorties together). Score counts when a sortie ends, plus the one in
// the air; time is flying time at the game's speed (an hour at 5× counts 5 hours), paused and carrier time not included.
const BADGES = [
  { id: 'score-25k', kind: 'score', goal: 25000, name: 'Nugget', what: '25,000 points in total' },
  { id: 'score-250k', kind: 'score', goal: 250000, name: 'Ace', what: '250,000 points in total' },
  { id: 'score-2500k', kind: 'score', goal: 2500000, name: 'Legend', what: '2,500,000 points in total' },
  { id: 'time-1h', kind: 'time', goal: 3600, name: 'Hour builder', what: '1 hour in the air' },
  { id: 'time-10h', kind: 'time', goal: 36000, name: 'Long haul', what: '10 hours in the air' },
  { id: 'time-24h', kind: 'time', goal: 86400, name: 'Round the clock', what: '24 hours in the air' },
  { id: 'time-100h', kind: 'time', goal: 360000, name: 'Centurion', what: '100 hours in the air' },
  ...[[250, 'Old salt'], [500, 'Iron seat'], [1000, 'Thousand-hour club'], [2000, 'Graybeard'], [3000, 'Part of the airframe'],
      [4000, 'Living legend'], [5000, 'Five thousand']]
    .map(([h, name]) => ({ id: `time-${h}h`, kind: 'time', goal: h * 3600, name, what: `${h.toLocaleString()} hours in the air` })),
];
export const hours = (s) => (s >= 36000 ? `${Math.floor(s / 3600).toLocaleString()} h` : s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.floor(s / 60)} min`);
export const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(Math.floor(n)));

const SOUND_FILE = { flare: '/assets/sounds/cm.mp3', missile: '/assets/sounds/missile.mp3', rwr: '/assets/sounds/rwr.mp3' };
const SIM_STEP = 0.05; // s per update (the old frame loop capped steps at 0.06)
const MINI_W = 120, MINI_H = 84;

export class Flight {
  constructor(app) {
    this.app = app;
    // fuses used to come with seekers: pilots who bought seekers keep those levels as fuses too
    const t = app.settings.tomcat;
    if (t?.upgrades?.seeker && t.upgrades.fuse == null) app.saveSettings({ tomcat: { ...t, upgrades: { ...t.upgrades, fuse: t.upgrades.seeker } } });
    // badge totals started after the stats did: the best score stands in for the old total (a floor, never more),
    // and the recorded flight time for the time flown
    const st = app.settings.tomcat;
    if (st && (st.totalScore == null || st.playTime == null)) {
      const next = { ...st };
      if (next.totalScore == null) next.totalScore = next.bestScore || 0;
      if (next.auto && next.auto.totalScore == null) next.auto = { ...next.auto, totalScore: next.auto.bestScore || 0 };
      if (next.playTime == null) next.playTime = (next.flightTime || 0) + (next.auto?.flightTime || 0);
      app.saveSettings({ tomcat: next });
    }
    // a sortie still flying when the app closed ended there: what it earned is paid now
    if (app.settings.tomcat?.pending) this.bank();
    // the Heater bay was a $ upgrade for one version (1.0.40): bought there, it's the perk now
    const tc = app.settings.tomcat;
    if (tc?.upgrades?.heater) {
      const { heater, ...upgrades } = tc.upgrades;
      app.saveSettings({ tomcat: { ...tc, upgrades, perks: { ...(tc.perks || {}), heater: 1 } } });
    }
    this.lastBadgeCheck = 0;
    this.view = null; // the TomcatEditor drawing it full size, while that tab is the one on screen
    this.game = new TomcatGame(null, {
      best: () => app.settings.tomcat || {},
      onGameOver: (g) => this.record(g),
      auto: !!app.settings.tomcatAuto,
      onAuto: (on) => app.saveSettings({ tomcatAuto: on }),
      upgrades: () => app.settings.tomcat?.upgrades || {},
      onEarn: (n) => this.earn(n),
      onBank: () => this.bank(),
      onHangar: () => this.view?.toggleHangar(),
      onFlare: () => this.sound('flare'),
      onFire: () => this.sound('missile'),
      onVolume: () => this.view?.toggleVolume(),
      speed: app.settings.tomcatSpeed || 1,
      onSpeed: (n) => app.saveSettings({ tomcatSpeed: n }),
      onStart: () => this.launch(),
      mergeSkip: (auto) => (app.settings.tomcatMerge || {})[auto ? 'auto' : 'manual'] === 'skip',
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
    const real = Math.min(600, (now - this.last) / 1000);
    let left = real * this.game.speed; // asleep longer than 10 min: that time is lost
    this.last = now;
    this.logTime(real, now);
    while (left > 1e-6) { const d = Math.min(SIM_STEP, left); this.game.update(d); left -= d; }
    // merged while you're somewhere else (another tab, another window): the RWR goes off, app wide, every few seconds
    // until you come back to it
    const f = this.game.dogfight;
    if (f && !this.game.gameOver && (f.phase === 'countdown' || f.phase === 'qte') && !this.game.watching() && now - (this.lastRwr || 0) > 4000) {
      this.lastRwr = now;
      this.sound('rwr', { anywhere: true });
    }
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

  // ---- badges

  /** Time in the air at the game's speed (a sortie flying, not paused, not over), saved every 30 s and with the $. */
  logTime(real, now) {
    const g = this.game;
    if (!g.started || g.paused || g.gameOver || g.holding() || real <= 0) return;
    const t = (this.app.settings.tomcat ||= {});
    t.playTime = (t.playTime || 0) + real * (g.dogfight ? 1 : g.speed); // sped up: 4× and 5× earn time badges faster
    if (!this.saveCash && now - (this.lastTimeSave || 0) > 30000) { this.lastTimeSave = now; this.saveCash = setTimeout(() => this.flushCash(), 3000); }
    if (now - this.lastBadgeCheck > 2000) { this.lastBadgeCheck = now; this.checkBadges(); }
  }

  /** Totals for the badges: both kinds of sortie, and the one in the air right now. */
  totals() {
    const t = this.app.settings.tomcat || {};
    const g = this.game;
    const live = g.started && !g.gameOver ? Math.floor(g.score) : 0;
    return { score: (t.totalScore || 0) + (t.auto?.totalScore || 0) + live, time: t.playTime || 0 };
  }

  badgeList() {
    const tot = this.totals();
    const got = this.app.settings.tomcat?.badges || {};
    return BADGES.map((b) => ({ ...b, have: Math.min(tot[b.kind], b.goal), earned: got[b.id] || null }));
  }

  checkBadges() {
    const fresh = this.badgeList().filter((b) => !b.earned && b.have >= b.goal);
    if (!fresh.length) return;
    const t = (this.app.settings.tomcat ||= {});
    t.badges = { ...(t.badges || {}) };
    for (const b of fresh) t.badges[b.id] = Date.now();
    this.flushCash();
    const lv = (b) => BADGES.filter((x) => x.kind === b.kind).indexOf(b) + 1;
    for (const b of fresh) toast(`★ Badge LV ${lv(BADGES.find((x) => x.id === b.id))}: ${b.name} — ${b.what}`, { type: 'ok', timeout: 6000 });
    this.app.sounds?.play?.('click');
    if (this.view?.hangar) this.view.renderHangar();
  }

  /** Lifetime stats (the badges count from these). Sorties flown in automatic mode count separately (s.auto). */
  record(g) {
    this.bank(false);
    const all = { ...(this.app.settings.tomcat || {}) };
    const s = g.auto ? { ...(all.auto || {}) } : all;
    s.games = (s.games || 0) + 1;
    s.totalScore = (s.totalScore || 0) + g.score;
    s.splashes = (s.splashes || 0) + g.splashes;
    s.intercepts = (s.intercepts || 0) + g.intercepts;
    s.flightTime = (s.flightTime || 0) + g.time;
    s.bestTime = Math.max(s.bestTime || 0, g.time);
    s.bestSplashes = Math.max(s.bestSplashes || 0, g.splashes);
    s.bestScore = Math.max(s.bestScore || 0, g.score);
    if (g.auto) all.auto = s;
    this.app.saveSettings({ tomcat: all });
    this.view?.refreshStatus();
    this.checkBadges();
  }

  /** The game's own volumes (SETTINGS in the game), each on top of the app's sound volume. */
  volume(kind) { return clamp((this.app.settings.tomcatVolume || {})[kind] ?? 1, 0, 1); }

  /** Only heard while the game is on screen. A busy fight at 3× fires a lot: one launch sound per 120 ms at most. */
  sound(kind, { anywhere = false } = {}) {
    const s = this.app.settings;
    if ((!this.view && !anywhere) || s.sounds === false) return;
    const now = performance.now();
    if (kind === 'missile' && now - (this.lastLaunch || 0) < 120) return;
    if (kind === 'missile') this.lastLaunch = now;
    const v = clamp((s.soundVolume ?? 0.7) * this.volume(kind), 0, 1);
    if (v <= 0) return;
    const a = new Audio(SOUND_FILE[kind]);
    a.volume = v;
    a.play().catch(() => {});
  }

  /** $ from kills: held for the sortie (pending) and paid when it ends; saved a few seconds later (a busy fight is a lot
   *  of kills), so a sortie cut short by closing the app is still paid next time. */
  earn(n) {
    const t = (this.app.settings.tomcat ||= {});
    t.pending = (t.pending || 0) + n;
    clearTimeout(this.saveCash);
    this.saveCash = setTimeout(() => this.flushCash(), 3000);
    if (this.view?.hangar) this.view.renderHangar();
  }

  /** The sortie's over: its pending $ goes into the bank. */
  bank(save = true) {
    const t = this.app.settings.tomcat;
    if (!t?.pending) return;
    t.cash = (t.cash || 0) + t.pending;
    t.pending = 0;
    if (save) this.flushCash();
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

  /**
   * Drag to move; drop on the right sidebar to fold it there, at the height it was let go (like everything else in
   * the sidebar: an outline shows where, and the others make room); drag a folded one out to float it, or along the
   * sidebar to move it there; a click opens the game.
   */
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
      this.app.railMarker?.(ev, m);
    };
    const up = (ev) => {
      m.removeEventListener('pointermove', move);
      m.removeEventListener('pointerup', up);
      m.removeEventListener('pointercancel', up);
      rail.classList.remove('fling-target', 'fling-hot', 'peek');
      m.classList.remove('dragging');
      this.app.railMarker?.(null, m);
      if (!dragging) { this.app.newDocument('tomcat'); return; }
      if (overRail(ev.clientX, ev.clientY)) {
        this.setMini({ docked: true });
        this.app.railMove?.(m, ev.clientY); // its spot in the sidebar
        return;
      }
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
    const merged = !!g.dogfight && !g.gameOver;
    this.mini.classList.toggle('merged', merged);
    // the wedge, range rings, and a sweep (red while merged)
    ctx.strokeStyle = merged ? 'rgba(255,90,90,.5)' : 'rgba(120,220,120,.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(...at(-AZ_LIMIT, RADAR_RANGE_KM)); ctx.moveTo(ox, oy); ctx.lineTo(...at(AZ_LIMIT, RADAR_RANGE_KM)); ctx.stroke();
    for (const k of docked ? [1] : [1 / 3, 2 / 3, 1]) { ctx.beginPath(); ctx.arc(ox, oy, R * k, -Math.PI / 2 - AZ_LIMIT, -Math.PI / 2 + AZ_LIMIT); ctx.stroke(); }
    if (!g.paused && !g.gameOver && g.started) {
      const sweep = Math.sin(performance.now() / 700) * AZ_LIMIT;
      ctx.strokeStyle = 'rgba(140,255,140,.25)'; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(...at(sweep, RADAR_RANGE_KM)); ctx.stroke();
    }
    const dot = docked ? 1.6 : 2.4;
    for (const b of g.bandits) { ctx.fillStyle = b.type === H20.name ? H20_COLOR : b.type === 'J-36' ? '#ffd27a' : '#8ef08e'; ctx.beginPath(); ctx.arc(...at(b.angle, b.distance), dot, 0, Math.PI * 2); ctx.fill(); }
    const blink = Math.floor(performance.now() / 250) % 2 === 0;
    for (const m of g.hostiles) { ctx.fillStyle = blink ? '#ff4d4d' : '#ff9a9a'; ctx.beginPath(); ctx.arc(...at(m.bearing, m.distance), dot, 0, Math.PI * 2); ctx.fill(); }
    // ours: blue, like on the B-scope
    ctx.fillStyle = '#4aa3ff';
    for (const m of g.missiles) if (!m.lost) { ctx.beginPath(); ctx.arc(...at(m.bearing, Math.hypot(m.x, m.y)), dot * 0.75, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = merged ? '#ff6b6b' : '#cfe8cf'; ctx.beginPath(); ctx.moveTo(ox, oy - (docked ? 3 : 5)); ctx.lineTo(ox - (docked ? 2 : 3), oy); ctx.lineTo(ox + (docked ? 2 : 3), oy); ctx.fill();
    // merged: MERGED right across the scope, pulsing, until you open the game and fight it
    if (merged && !docked) {
      const pulse = 0.65 + 0.35 * Math.abs(Math.sin(performance.now() / 260));
      ctx.fillStyle = 'rgba(20,4,4,.72)'; ctx.fillRect(0, H / 2 - 17, W, 34);
      ctx.save();
      ctx.translate(W / 2, H / 2 + 1);
      ctx.rotate(-0.12);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `900 25px ${MONO}`;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText('MERGED', 0, 0);
      ctx.fillStyle = `rgba(255,59,59,${pulse})`; ctx.fillText('MERGED', 0, 0);
      ctx.restore();
    }
    // nearest enemy: a missile beats a bandit for attention at the same range
    let near = null;
    for (const b of g.bandits) if (!near || b.distance < near.d) near = { d: b.distance, msl: false };
    for (const m of g.hostiles) if (!near || m.distance <= near.d) near = { d: m.distance, msl: true };
    const km = near ? `${near.d < 10 ? near.d.toFixed(1) : Math.round(near.d)}km` : '';
    let label;
    if (g.gameOver) label = g.auto ? `DOWN · ${Math.max(0, Math.ceil(g.restartIn))}s` : 'DOWN';
    else if (!g.started) label = 'READY';
    else if (g.dogfight) label = docked ? 'MERGE' : g.dogfight.phase === 'roll' || g.dogfight.phase === 'result' ? 'MERGED — ROLLING' : g.watching() ? 'FIGHT!' : 'OPEN TO FIGHT';
    else if (g.paused) label = 'PAUSED';
    else if (!near) label = 'CLEAR';
    else label = docked ? km : `${near.msl ? 'MSL' : 'BANDIT'} ${km}${g.speed > 1 ? ` ${g.speed}×` : ''}`;
    this.miniDist.textContent = label;
    this.miniDist.classList.toggle('threat', (!!near?.msl || !!g.dogfight) && !g.paused && !g.gameOver);
    this.miniDist.classList.toggle('down', !!g.gameOver);
    this.miniPause.textContent = g.paused ? '▶' : '❚❚';
  }
}
