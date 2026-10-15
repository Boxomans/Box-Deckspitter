// F-14F Super Tomcat: an AWG-9 B-scope intercept game, the easter egg behind Settings → Easter eggs.
// Ported from boxbind's original single-page game and built on: the ownship is a Tomcat now, there's a
// pause, a missile-launch warning, contacts marked when they're in range, waves that get harder the longer
// you last, and stats (best time, splashes) kept in settings for the badges to come.

import { BaseEditor } from './base.js';
import { h } from '../core/dom.js';
import {
  PANEL_W, MISSILES, speedsFor, upgradeCost, rebirthCost, rebirthTokens, PERKS, unlockedUpgrades, nextUnlock, H20,
  DRONE_AMMO, DRONE_RELOAD, clock,
} from './tomcat/data.js';
import { hours, short } from './tomcat/flight.js';

export { Flight } from './tomcat/flight.js'; // the sortie behind the mini radar (app/easter-eggs.js)

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
    this.canvas.addEventListener('pointerdown', (e) => { if (e.button === 0 && this.game.dogfightClick()) e.preventDefault(); });
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
    if (this.vol) this.closeVolume();
    if (this.flight?.view !== this) return;
    this.flight.view = null;
    this.game.detach();
    this.flight.syncMini();
    this.flight.flushCash();
  }

  // ---- SETTINGS: the game's sound levels, and what a merge does

  toggleVolume() {
    if (this.vol) return this.closeVolume();
    const b = this.game.volBtn;
    const row = (kind, label) => {
      const pct = h('span', { class: 'tv-pct' });
      const input = h('input', { type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(this.flight.volume(kind) * 100)) });
      const show = () => { pct.textContent = `${input.value}%`; };
      input.addEventListener('input', show);
      input.addEventListener('change', () => {
        this.app.saveSettings({ tomcatVolume: { ...(this.app.settings.tomcatVolume || {}), [kind]: Number(input.value) / 100 } });
        this.flight.sound(kind);
      });
      show();
      return h('label', { class: 'tv-row' }, h('span', { class: 'tv-name' }, label), input, pct);
    };
    const note = this.app.settings.sounds === false ? h('div', { class: 'tv-note' }, 'App sounds are off (Settings), so the game is silent.') : null;
    // a merge: the click minigame (it waits for you), or skip it and go straight to the 50/50 roll. Auto and flying it yourself apart.
    const merge = (key, label, waitText) => {
      const cur = () => (this.app.settings.tomcatMerge || {})[key] === 'skip' ? 'skip' : 'wait';
      const opt = (val, text) => {
        const b = h('button', { class: `tv-opt${cur() === val ? ' on' : ''}` }, text);
        b.addEventListener('click', () => {
          this.app.saveSettings({ tomcatMerge: { ...(this.app.settings.tomcatMerge || {}), [key]: val } });
          for (const o of b.parentElement.children) o.classList.toggle('on', o === b);
        });
        return b;
      };
      return h('div', { class: 'tv-row' }, h('span', { class: 'tv-name' }, label), h('div', { class: 'tv-seg' }, opt('wait', waitText), opt('skip', 'Just roll')));
    };
    this.vol = h('div', { class: 'tomcat-vol', tabindex: '-1', style: { left: `${Math.max(8, Math.min(b.x, this.game.W - PANEL_W - 258))}px`, top: `${b.y + b.h + 6}px` } }, // stays off the scope
      h('div', { class: 'tv-head' }, 'SOUND'), row('flare', 'Chaff / flares'), row('missile', 'Missile launch'), row('rwr', 'Merge warning'), note,
      h('div', { class: 'tv-head tv-sep' }, 'MERGE'),
      merge('manual', 'Flying it yourself', 'Minigame'),
      merge('auto', 'On auto', 'Wait for me'),
      h('div', { class: 'tv-hint' }, 'Minigame: the fight waits until you open the game, then it’s 3-2-1 and click. Just roll: no clicks, straight to the 50/50 roll.'));
    this.vol.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key.toLowerCase() === 'v') { e.preventDefault(); e.stopPropagation(); this.closeVolume(); } });
    this.offVol = (e) => { if (this.vol && !this.vol.contains(e.target) && e.target !== this.canvas) this.closeVolume(); };
    document.addEventListener('pointerdown', this.offVol, true);
    this.root.append(this.vol);
    this.game.volOpen = true;
    this.vol.focus();
  }

  closeVolume() {
    document.removeEventListener('pointerdown', this.offVol, true);
    this.vol?.remove();
    this.vol = null;
    this.game.volOpen = false;
    this.canvas.focus();
  }

  // ---- the hangar: spend $ on upgrades that last between sorties

  toggleHangar() {
    if (this.hangar) return this.closeHangar();
    const g = this.game;
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
    const reborn = t.rebirths || 0;
    const tokens = t.tokens || 0;
    const shop = this.carrierTab === 'shop';
    const badges = this.carrierTab === 'badges';
    const stats = this.carrierTab === 'stats';
    clearTimeout(this.statsTimer);
    const rows = stats ? this.statsRows() : badges ? this.badgeRows() : shop ? this.shopRows(t) : unlockedUpgrades(reborn).map((u) => {
      const level = lv[u.id] || 0;
      const cost = upgradeCost(u, level);
      const maxed = level >= u.max;
      const buy = h('button', { class: 'th-buy', disabled: maxed || cash < cost }, maxed ? 'MAX' : `$${cost.toLocaleString()}`);
      buy.addEventListener('click', () => this.buy(u));
      const pips = u.max === Infinity
        ? h('div', { class: 'th-pips th-level' }, `LV ${level}`)
        : h('div', { class: 'th-pips' }, ...Array.from({ length: u.max }, (_, i) => h('span', { class: i < level ? 'on' : '' })));
      return h('div', { class: `th-row${u.rebirth ? ' th-reborn' : ''}` },
        h('div', { class: 'th-info' }, h('div', { class: 'th-name' }, u.rebirth ? `★ ${u.name}` : u.name), h('div', { class: 'th-what' }, u.what)),
        pips, buy);
    });
    const close = h('button', { class: 'th-close', title: 'Close (H or Esc)' }, '×');
    close.addEventListener('click', () => this.closeHangar());
    const tab = (id, label) => {
      const b = h('button', { class: `th-tab${(this.carrierTab || 'upgrades') === id ? ' on' : ''}` }, label);
      b.addEventListener('click', () => { this.carrierTab = id; this.rebirthArmed = false; this.renderHangar(); });
      return b;
    };
    const focused = this.hangar.contains(document.activeElement);
    const scroll = [this.hangar.scrollTop, this.hangar.querySelector('.th-card')?.scrollTop || 0]; // the live STATS redraw keeps your place
    this.hangar.replaceChildren(h('div', { class: 'th-card' },
      h('div', { class: 'th-head' }, h('span', {}, 'BACK ON THE CARRIER'), reborn ? h('span', { class: 'th-stars', title: `Reborn ${reborn}×` }, `★${reborn}`) : null,
        h('span', { class: 'th-cash' }, `$${cash.toLocaleString()}`),
        t.pending ? h('span', { class: 'th-pending', title: 'What this sortie has earned so far: paid when it ends' }, `+$${Math.round(t.pending).toLocaleString()}`) : null, tokens || reborn ? h('span', { class: 'th-tokens', title: 'Rebirth tokens' }, `◆${tokens}`) : null, close),
      h('div', { class: 'th-tabs' }, tab('upgrades', 'UPGRADES'), tab('shop', '★ REBIRTH SHOP'), tab('badges', 'BADGES'), tab('stats', 'STATS')),
      h('div', { class: 'th-sub' }, stats
        ? 'Your jet with every upgrade and perk applied, and what this wave throws at you.'
        : badges
        ? 'For your totals: every sortie’s score, manual and automatic, and the time you spend in the air. Kept forever.'
        : shop
        ? 'Rebirth for tokens, and spend them on perks. Perks stay through every rebirth.'
        : 'Splash bandits and missiles for $. Upgrades stay between sorties (until you rebirth).'),
      ...rows));
    this.hangar.scrollTop = scroll[0];
    const card = this.hangar.querySelector('.th-card');
    if (card) card.scrollTop = scroll[1];
    if (focused) this.hangar.focus();
  }

  /** One row per kind of badge (score, time): its level and latest name, and progress to the next. */
  badgeRows() {
    const list = this.flight.badgeList();
    const got = list.filter((b) => b.earned).length;
    const KIND = { score: 'Total score', time: 'Time in the air' };
    return [h('div', { class: 'th-badge-sum' }, `${got} of ${list.length} levels`), ...[...new Set(list.map((b) => b.kind))].map((k) => {
      const tiers = list.filter((b) => b.kind === k);
      const fmt = k === 'time' ? hours : short;
      const done = tiers.filter((b) => b.earned);
      const last = done[done.length - 1];
      const next = tiers.find((b) => !b.earned);
      return h('div', { class: `th-row th-badge${last ? ' on' : ''}` },
        h('div', { class: 'th-medal' }, last ? '★' : '☆'),
        h('div', { class: 'th-info' },
          h('div', { class: 'th-name' }, `${KIND[k] || k}${last ? ` · ${last.name}` : ''}`),
          h('div', { class: 'th-what' }, next ? `Next: ${next.name}, ${next.what}` : 'Every badge here earned'),
          next ? h('div', { class: 'th-bar' }, h('span', { style: `width:${Math.floor((next.have / next.goal) * 100)}%` })) : null,
          h('div', {
            class: 'th-tiers',
            title: tiers.map((b) => `LV ${tiers.indexOf(b) + 1} ${b.name}: ${b.what}${b.earned ? ` · earned ${new Date(b.earned).toLocaleDateString()}` : ''}`).join('\n'),
          }, h('span', { class: done.length ? 'on' : '' }, `LV ${done.length}`), ` / ${tiers.length}`)),
        h('div', { class: 'th-badge-val' }, next ? `${fmt(next.have)} / ${fmt(next.goal)}` : `${done.length} / ${tiers.length}`));
    })];
  }

  /** STATS: the jet's numbers with every upgrade and perk applied, and the threat this wave. Live while automatic flies. */
  statsRows() {
    const g = this.game;
    const u = g.upgrades();
    const perks = g.best().perks || {};
    const flying = g.started && !g.gameOver;
    const pct = (k) => `${k >= 1 ? '+' : '−'}${Math.round(Math.abs(k - 1) * 100)}%`;
    const kv = (rows) => h('div', { class: 'th-kv' }, ...rows.filter(Boolean).flatMap(([k, v, why]) => [
      h('span', { class: 'th-k' }, k), h('span', { class: 'th-v', title: why || '' }, v)]));
    const head = (text, note) => h('div', { class: 'th-stat-head' }, text, note ? h('span', {}, note) : null);

    const msl = h('div', { class: 'th-msl' },
      ...['', 'Rails', 'Reload', 'Speed', 'Turn', 'Range'].map((c) => h('span', { class: 'th-k' }, c)),
      ...Object.keys(MISSILES).flatMap((code) => {
        const c = g.spec(code);
        return [h('span', { class: 'th-k' }, c.short), h('span', {}, String(c.max)), h('span', {}, `${c.regen.toFixed(1)} s`),
          h('span', {}, `M${c.speedMach.toFixed(1)}`), h('span', {}, `${Math.round(c.turnRateDps)}°/s`), h('span', {}, `${c.rMaxKm} km`)];
      }));
    const fuse = g.spec('FOX-1');
    const contracts = 1 + 0.1 * (u.contracts || 0), favor = 1 + 0.1 * (perks.favor || 0), wavePay = 1 + 0.15 * g.heat();
    const jet = kv([
      ['Fuse', `${Math.round(fuse.killRadiusKm * 1000)} m · ${Math.round(fuse.dud * 100)}% duds`],
      ['Chaff/flares', `${g.flareMax()} · one every ${g.flareReload().toFixed(1)} s`],
      ['Notch', `ready every ${Math.round(g.notchCooldown())} s`],
      (u.armor || (this.app.settings.tomcat?.rebirths || 0)) ? ['Armor', `${u.armor || 0} hit${u.armor === 1 ? '' : 's'} a sortie${flying ? ` (${g.armor} left)` : ''}`] : null,
      ['$ per kill', `×${(contracts * favor * wavePay).toFixed(2)}`, `Defense contracts ${pct(contracts)} · Admiral’s favor ${pct(favor)} · wave ${pct(wavePay)}`],
      ['Wingmen', u.wingman ? `${u.wingman} × FQ-50A Goose · ${DRONE_AMMO} AIM-9X each · ${DRONE_RELOAD} s a missile` : 'none'],
      ['Speeds', speedsFor(perks).map((n) => `${n}×`).join(' ')],
    ]);

    const wave = g.wave();
    const [gapLo, gapHi] = g.spawnGap();
    const nextWave = 90 - (g.simTime % 90);
    const salvo = (type) => `${g.salvo(type)} from ${Math.round(g.launchKm(type))} km, every ${g.shotGap(type).toFixed(1)} s`;
    const h20 = `next for sure at ${clock(g.h20Sure).slice(0, 5)}${g.simTime >= H20.randomFrom ? ` · ${Math.round(H20.perMinute * 100)}% a minute too` : ''}`;
    const threat = kv([
      ['Bandits', `up to ${g.maxBandits()} at once · a new one every ${gapLo.toFixed(1)}–${gapHi.toFixed(1)} s`],
      ['Bandit speed', pct(g.banditPace())],
      ['Their missile speed', pct(g.missilePace())],
      ['Their duds', `${Math.round(g.enemyDud() * 100)}% = ${Math.round(g.enemyDudBase() * 100)}% theirs + ${Math.round(g.enemyDudEcm() * 100)}% your ECM${u.ecm ? ` (LV ${u.ecm})` : ''}`,
        'Rolled once per missile at 15 km. Their own rate starts at 12% and falls 1% a wave; ECM adds 6% a level.'],
      ['Jinking', `${pct(g.agility())}`, 'Targets break harder: your missiles overshoot more'],
      ['J-11 salvo', salvo('J-11')],
      ['J-36 salvo', salvo('J-36')],
      ['H-20', h20],
    ]);
    if (this.hangar && g.hangarOpen && flying && g.auto) this.statsTimer = setTimeout(() => { if (this.carrierTab === 'stats' && g.hangarOpen) this.renderHangar(); }, 1000);
    return [
      head('YOUR JET'), msl, jet,
      head(`THE THREAT · WAVE ${wave}`, flying ? `${clock(g.simTime).slice(0, 5)} · next wave in ${Math.ceil(nextWave)} s` : 'on the ramp'),
      threat,
    ];
  }

  /** The rebirth shop: the rebirth itself, then the token perks. */
  shopRows(t) {
    const cash = t.cash || 0;
    const reborn = t.rebirths || 0;
    const tokens = t.tokens || 0;
    const price = rebirthCost(reborn);
    const pay = rebirthTokens(reborn);
    const next = nextUnlock(reborn);
    const ready = cash >= price;
    const btn = h('button', { class: 'th-buy th-rebirth-btn', disabled: !ready }, this.rebirthArmed ? 'CONFIRM' : 'REBIRTH');
    btn.addEventListener('click', () => this.rebirth());
    const gain = `+${pay} token${pay === 1 ? '' : 's'}${next ? ` and ★ ${next.name}` : ''}`;
    const rows = [h('div', { class: 'th-row th-rebirth' },
      h('div', { class: 'th-info' },
        h('div', { class: 'th-name' }, `Rebirth ${reborn + 1}`),
        h('div', { class: 'th-what' }, this.rebirthArmed
          ? `Sure? Your $ and every upgrade go back to zero (perks, high scores and stats stay). You get ${gain}.`
          : `At $${price.toLocaleString()}: start over with $0 and no upgrades for ${gain}. The next one costs double and pays double.`),
        ready ? null : h('div', { class: 'th-bar' }, h('span', { style: `width:${Math.min(100, (cash / price) * 100).toFixed(1)}%` }))),
      btn)];
    const perks = t.perks || {};
    for (const p of PERKS) {
      const level = perks[p.id] || 0;
      const cost = p.cost(level);
      const maxed = level >= p.max;
      const buy = h('button', { class: 'th-buy th-token-btn', disabled: maxed || tokens < cost }, maxed ? 'MAX' : `◆${cost}`);
      buy.addEventListener('click', () => this.buyPerk(p));
      rows.push(h('div', { class: 'th-row th-reborn' },
        h('div', { class: 'th-info' }, h('div', { class: 'th-name' }, p.name), h('div', { class: 'th-what' }, p.what)),
        h('div', { class: 'th-pips th-level' }, `LV ${level}`), buy));
    }
    return rows;
  }

  buyPerk(p) {
    const t = { ...(this.app.settings.tomcat || {}) };
    const perks = { ...(t.perks || {}) };
    const level = perks[p.id] || 0;
    const cost = p.cost(level);
    if (level >= p.max || (t.tokens || 0) < cost) return;
    const g = this.game;
    const before = Object.fromEntries(Object.keys(g.inv).map((k) => [k, g.spec(k).max]));
    t.tokens -= cost;
    perks[p.id] = level + 1;
    t.perks = perks;
    this.app.settings.tomcat = t;
    this.flight.flushCash();
    for (const [k, inv] of Object.entries(g.inv)) inv.count += g.spec(k).max - before[k]; // new rails come loaded
    this.app.sounds?.play?.('click');
    this.renderHangar();
    this.refreshStatus();
  }

  /** First click arms it, the second does it: the $ and upgrades go, the rebirth count goes up. */
  rebirth() {
    const t = { ...(this.app.settings.tomcat || {}) };
    if ((t.cash || 0) < rebirthCost(t.rebirths || 0)) return;
    if (!this.rebirthArmed) {
      this.rebirthArmed = true;
      clearTimeout(this.rebirthDisarm);
      this.rebirthDisarm = setTimeout(() => { this.rebirthArmed = false; if (this.hangar) this.renderHangar(); }, 6000);
      this.renderHangar();
      return;
    }
    this.rebirthArmed = false;
    clearTimeout(this.rebirthDisarm);
    t.cash = 0;
    t.upgrades = {};
    t.tokens = (t.tokens || 0) + rebirthTokens(t.rebirths || 0);
    t.rebirths = (t.rebirths || 0) + 1;
    this.app.settings.tomcat = t;
    this.flight.flushCash();
    // the ramp loads to the new (smaller) racks
    const g = this.game;
    for (const [k, inv] of Object.entries(g.inv)) inv.count = Math.min(inv.count, g.spec(k).max);
    g.flares = Math.min(g.flares, g.flareMax());
    g.armor = 0;
    this.app.sounds?.play?.('click');
    this.renderHangar();
    this.refreshStatus();
  }

  buy(u) {
    const t = { ...(this.app.settings.tomcat || {}) };
    const lv = { ...(t.upgrades || {}) };
    const level = lv[u.id] || 0;
    const cost = upgradeCost(u, level);
    if (level >= u.max || (t.cash || 0) < cost || (u.rebirth || 0) > (t.rebirths || 0)) return;
    const g = this.game;
    const before = Object.fromEntries(Object.keys(g.inv).map((k) => [k, g.spec(k).max]));
    t.cash -= cost;
    lv[u.id] = level + 1;
    t.upgrades = lv;
    this.app.settings.tomcat = t;
    this.flight.flushCash();
    if (u.id === 'armor') g.armor = lv.armor; // bought on the ramp: on for this sortie
    if (u.id === 'wingman') while (g.drones.length < lv.wingman) g.drones.push(g.newDrone(g.drones.length)); // joins you now
    // new rails come loaded
    for (const [k, inv] of Object.entries(g.inv)) inv.count += g.spec(k).max - before[k];
    this.app.sounds?.play?.('click');
    this.renderHangar();
    this.refreshStatus();
  }

  status() {
    const s = this.app.settings.tomcat || {};
    return {
      left: [{ text: 'Space start · F fire · X flare · N notch · 1 2 3 weapon · ↑↓ target · A auto · T speed · V settings · H carrier · P pause · R end sortie' }],
      right: [{ text: `high score ${(s.bestScore || 0).toLocaleString()} · $${(s.cash || 0).toLocaleString()}` }],
    };
  }

  focus() { this.canvas?.focus(); }
  onShow() { this.show(); }
  onHide() { this.hide(); }
  destroy() { this.ro?.disconnect(); this.hide(); }
}
