// Box-Deckspitter app shell, the window chrome: the left rail, the top bar's buttons and moving them between bars.
// Methods of App (app.js mixes this class into it).

import { $, $$, h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { showMenu, contextMenu } from '../core/ui.js';
import { SIDE_PANELS } from './shared.js';

/**
 * Drag `el` and drop it on `zone()`, or flick it toward the zone and let go: either way `onMove(drop)` runs, with the
 * pointer-up event when it was dropped right on the zone (so it can land where it was let go) or null for a flick.
 * Dropped back inside `home()` (the place it already is) it runs `onHome(event)` instead, to reorder it there.
 * `marker(event, el)` is told where the pointer is while dragging (and `null` at the end), to show where it would land.
 * A plain click (no drag) is left alone. A ghost copy follows the pointer and flies to where it lands.
 * With `onFloat(event)`, letting go out on the page (well away from where it started, and not flicked at the zone)
 * runs that instead of flying back.
 */
function flingable(el, zone, onMove, { home, onHome, marker, onFloat } = {}) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const pts = [];
    let ghost = null;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const inside = (z, x, y, pad = 0) => { const r = z.getBoundingClientRect(); return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad; };
    const move = (ev) => {
      pts.push({ x: ev.clientX, y: ev.clientY, t: performance.now() });
      if (pts.length > 6) pts.shift();
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
      if (!ghost) {
        ghost = el.cloneNode(true);
        ghost.removeAttribute('id');
        ghost.classList.add('fling-ghost');
        document.body.append(ghost);
        el.classList.add('fling-source');
        zone().classList.add('fling-target');
      }
      ghost.style.left = `${ev.clientX - ghost.offsetWidth / 2}px`;
      ghost.style.top = `${ev.clientY - ghost.offsetHeight / 2}px`;
      // a collapsed (empty) right sidebar slides out once the drag heads its way
      if (zone().classList.contains('rail-empty')) zone().classList.toggle('peek', ev.clientX > innerWidth - 260);
      zone().classList.toggle('fling-hot', inside(zone(), ev.clientX, ev.clientY, 20));
      marker?.(ev, el);
    };
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!ghost) return; // just a click
      // the click that follows a drag shouldn't also toggle the player
      const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
      el.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 50);
      const z = zone();
      z.classList.remove('fling-target', 'fling-hot', 'peek');
      el.classList.remove('fling-source');
      marker?.(null, el);
      const hm = home?.();
      if (hm && hm.contains(el) && inside(hm, ev.clientX, ev.clientY, 20)) {
        // let go where it already lives: it just moves along there
        ghost.style.transition = 'opacity 0.18s, transform 0.18s';
        requestAnimationFrame(() => { ghost.style.opacity = '0'; ghost.style.transform = 'scale(0.8)'; });
        const g0 = ghost;
        setTimeout(() => g0.remove(), 200);
        onHome?.(ev);
        return;
      }
      const r = z.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // a flick: fast enough, and heading roughly toward the zone (within about 40 degrees)
      let vx = 0;
      let vy = 0;
      if (pts.length > 1) { const a = pts[0]; const b = pts[pts.length - 1]; const dt = Math.max(1, b.t - a.t); vx = (b.x - a.x) / dt; vy = (b.y - a.y) / dt; }
      const speed = Math.hypot(vx, vy);
      const tx = cx - ev.clientX;
      const ty = cy - ev.clientY;
      const aimed = speed > 0.5 && (vx * tx + vy * ty) / (speed * (Math.hypot(tx, ty) || 1)) > 0.75;
      const go = inside(z, ev.clientX, ev.clientY, 20) || aimed;
      // let go out on the page (well away from where it started): with onFloat it stays there, the ghost fading in place
      const float = !go && !!onFloat && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 80 && !(hm && inside(hm, ev.clientX, ev.clientY, 40));
      const was = el.getBoundingClientRect();
      const toX = go ? cx : float ? ev.clientX : was.left + was.width / 2;
      const toY = go ? cy : float ? ev.clientY : was.top + was.height / 2;
      ghost.style.transition = 'left 0.22s cubic-bezier(.2,.8,.2,1), top 0.22s cubic-bezier(.2,.8,.2,1), opacity 0.22s, transform 0.22s';
      requestAnimationFrame(() => {
        ghost.style.left = `${toX - ghost.offsetWidth / 2}px`;
        ghost.style.top = `${toY - ghost.offsetHeight / 2}px`;
        ghost.style.opacity = '0';
        ghost.style.transform = 'scale(0.7)';
      });
      const g = ghost;
      setTimeout(() => g.remove(), 260);
      const dropped = inside(z, ev.clientX, ev.clientY, 20) ? ev : null;
      if (go) setTimeout(() => onMove(dropped), 120);
      else if (float) onFloat(ev);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

const TOP_TOOLS = ['btn-music', 'btn-clock', 'btn-weather', 'btn-tomcat', 'btn-sound', 'btn-theme', 'btn-fullscreen', 'btn-shortcuts'];

const TOOL_LABEL = { 'btn-clock': 'clock', 'btn-weather': 'weather', 'btn-tomcat': 'F-14', 'btn-sound': 'sound', 'btn-theme': 'theme', 'btn-fullscreen': 'full', 'btn-shortcuts': 'keys' };

export class RailPart {
  decorateChrome() {
    $('#btn-home').append(icon('home'));
    $('#btn-home').addEventListener('click', () => this.activate(null));
    $('#btn-new-tab').append(icon('plus'));
    $('#btn-new-tab').addEventListener('click', (e) => showMenu(this.newMenuItems(), { anchor: e.currentTarget }));
    // the top-bar button cycles Dark → Light → PB&J
    $('#btn-theme').addEventListener('click', () => this.applyTheme(this.themeStep(1)));
    $('#btn-theme').addEventListener('contextmenu', (e) => { e.preventDefault(); this.applyTheme(this.themeStep(-1)); });
    $('#btn-sound').addEventListener('click', () => { this.sounds.toggle(); this.syncSoundButton(); });
    this.syncSoundButton();
    this.wireSoundVolume();
    $('#btn-music').append(icon('music'));
    $('#btn-music').title = 'Music player (audio-dump) · drag or flick it to the right sidebar to dock it there';
    $('#btn-music').addEventListener('click', () => this.music.toggleOpen());
    this.wireMusicDock();
    $('#btn-tomcat').append(icon('f14'));
    $('#btn-tomcat').addEventListener('click', () => this.newDocument('tomcat'));
    this.syncTomcat();
    $('#btn-fullscreen').addEventListener('click', () => this.toggleFullScreen());
    // leaving full screen some other way (the window manager, focus mode) keeps the button right
    addEventListener('resize', () => this.syncFullScreen());
    document.addEventListener('fullscreenchange', () => this.syncFullScreen());
    // the desktop app says when its window goes full screen; leaving isn't always announced (Windows), so the page
    // also asks the window whenever it changes size
    if (window.bdsShell?.isFullScreen) {
      const ask = () => window.bdsShell.isFullScreen().then((on) => { this._shellFull = on; this.syncFullScreen(); }).catch(() => {});
      window.bdsShell.onFullScreen?.((on) => { this._shellFull = on; this.syncFullScreen(); });
      addEventListener('resize', ask);
      ask();
    }
    this.syncFullScreen();
    $('#btn-shortcuts').append(icon('keyboard'));
    $('#btn-shortcuts').addEventListener('click', () => this.showShortcuts());
    const railIcons = { explorer: 'folder', spaces: 'spaces', recent: 'history', calendar: 'calendar', mediadump: 'image', docdump: 'file-pdf', alerts: 'bell', tools: 'toolbox', settings: 'settings' };
    for (const b of $$('.rail-btn[data-panel]')) {
      b.append(icon(railIcons[b.dataset.panel], 'lg'));
      b.addEventListener('click', () => this.togglePanel(b.dataset.panel));
    }
    this.syncRecentRail();
    // the browser opens in the main area, not as a side panel; it needs the desktop app (web pages in <webview>s)
    const web = $('#rail-browser');
    web.append(icon('globe', 'lg'));
    web.hidden = !window.bdsShell?.browser;
    web.addEventListener('click', () => this.newDocument('browser'));
    this.wireLeftRailOrder();
    for (const b of $$('.rrail-tab')) b.addEventListener('click', () => this.toggleRightPanel(b.dataset.rpanel));
    // remember the last place the user was typing, so side panels can insert there
    document.addEventListener('focusin', (e) => {
      const t = e.target;
      if (!this.workspace.contains(t)) return;
      if (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && /^(text|search|url|email|)$/.test(t.type))) this.lastEditable = t;
    });
  }

  /** The Recent button goes away while recent files are hidden (Settings › Files). */
  syncRecentRail() {
    const off = this.settings.showRecent === false;
    const b = $('.rail-btn[data-panel="recent"]');
    if (b) b.hidden = off;
    if (off && this.panel === 'recent') this.hidePanel();
  }

  /** The right sidebar collapses when nothing is in it (it slides out again while a button is dragged toward it). */
  syncRail() {
    const rail = $('#rightrail');
    if (!rail) return;
    const tabs = [...rail.querySelectorAll('.rrail-tab')].some((t) => !t.hidden);
    const tools = [...(rail.querySelector('.rrail-tools')?.children || [])].some((t) => !t.hidden);
    rail.classList.toggle('rail-empty', !tabs && !tools);
    this.layoutRail();
  }

  // ---- the ♪ player can sit under its top-bar button or dock as a right-sidebar tab; drag or flick to move it
  musicRailTab() {
    if (!this._musicTab) {
      const b = h('button', { class: 'rrail-tab rrail-music', dataset: { rpanel: 'music' }, title: 'Music player · drag or flick it to the top bar to undock it, or out onto the page for a small player' },
        h('span', { class: 'rrail-glyph' }, '\u266a'), h('span', { class: 'rrail-label' }, 'music'));
      b.addEventListener('click', () => this.toggleRightPanel('music'));
      this._musicTab = b;
    }
    return this._musicTab;
  }

  setMusicDock(side, { animate = true, drop = null } = {}) {
    const btn = $('#btn-music');
    const tab = this.musicRailTab();
    if ((this.settings.musicDock === 'side') !== side) this.saveSettings({ musicDock: side ? 'side' : 'top' });
    if (side) {
      btn.hidden = true;
      if (drop) this.railMove(tab, drop.clientY); else this.placeSaved(tab);
      // dragged in: open it there; at startup: only if it was open when the app closed
      if (animate || this.settings.rightPanel === 'music') this.toggleRightPanel('music', { force: true });
    } else {
      if (this.rightPanel === 'music') this.toggleRightPanel(null);
      this.music.dockInto(null);
      if (this.rightPanels?.music) { this.rightPanels.music.el.remove(); delete this.rightPanels.music; }
      tab.remove();
      btn.hidden = false;
    }
    tab.classList.toggle('playing', !!this.music.playing);
    this.syncRail();
  }

  wireMusicDock() {
    const topZone = () => $('.titlebar-actions');
    const sideZone = () => $('#rightrail');
    const marker = (ev, el) => { this.railMarker(ev, el); this.topMarker(ev, el); };
    const inRail = (el) => ({ home: sideZone, onHome: (ev) => this.railMove(el, ev.clientY), marker });
    const onTop = (el) => ({ home: topZone, onHome: (ev) => this.topMove(el, ev.clientX), marker });
    // let go out on the page instead: a small player stays there
    const onFloat = (ev) => this.music.popOut(ev.clientX, ev.clientY);
    flingable($('#btn-music'), sideZone, (drop) => this.setMusicDock(true, { drop }), { ...onTop($('#btn-music')), onFloat });
    flingable(this.musicRailTab(), topZone, () => this.setMusicDock(false), { ...inRail(this.musicRailTab()), onFloat });
    // chars, claude and clip can move to the top bar too (and back): there they open as a drop-down
    for (const tab of $$('.rrail-tab[data-rpanel]')) {
      const name = tab.dataset.rpanel;
      if (!SIDE_PANELS[name]) continue;
      const btn = h('button', { class: 'icon-btn top-panel-btn', hidden: true, dataset: { tpanel: name }, title: `${SIDE_PANELS[name]} · drag or flick it to the right sidebar to put it back` },
        h('span', { class: 'top-panel-glyph' }, tab.querySelector('.rrail-glyph')?.textContent || '•'));
      btn.addEventListener('click', () => this.toggleTopPanel(name));
      $('#btn-music').before(btn);
      flingable(tab, topZone, () => this.setPanelDock(name, 'top'), inRail(tab));
      flingable(btn, sideZone, (drop) => this.setPanelDock(name, 'side', { drop }), onTop(btn));

      tab.title = `${tab.title} · drag or flick it to the top bar to move it there`;
    }
    for (const [name, where] of Object.entries(this.settings.panelDock || {})) if (where === 'top' && SIDE_PANELS[name]) this.setPanelDock(name, 'top', { save: false });
    this.wireToolDock();
    this.applyBarOrder($('.titlebar-actions'), 'top');
    this.syncRail();
  }

  // ---- the right sidebar: anything in it sits wherever it was let go (top, bottom, or anywhere between), and can be
  //      dragged along it. Items never overlap: one dropped onto another pushes the rest along. Remembered as a
  //      fraction of the sidebar's height, so the spots hold when the window is resized.

  /** A rail item's name in settings.railPos. */
  railKey(el) {
    if (TOP_TOOLS.includes(el.id)) return el.id;
    if (el.classList?.contains('tomcat-mini')) return 'tomcat-mini';
    return el.dataset?.rpanel ? `rpanel:${el.dataset.rpanel}` : null;
  }
  /** Everything showing in the sidebar. */
  railItems(skip) {
    return [...$('#rightrail').children].filter((c) => c !== skip && !c.hidden && !c.classList.contains('rrail-spacer') && !c.classList.contains('rrail-tools'));
  }
  /** Into the sidebar (where it sits on screen is up to layoutRail). */
  placeInRail(el) {
    const rail = $('#rightrail');
    this.railTools();
    if (el.parentElement !== rail) rail.insertBefore(el, rail.querySelector('.rrail-spacer'));
  }
  placeSaved(el) { this.placeInRail(el); this.layoutRail(); }

  /** Where each item goes: as near its spot as it can be without overlapping the others. */
  railTops(items, H, override) {
    const pos = this.settings.railPos || {};
    const PAD = 8, GAP = 6;
    let stack = PAD;
    const list = items.map((el, i) => {
      const key = this.railKey(el);
      const h = el.offsetHeight;
      let want = override?.el === el ? override.top : (key && pos[key] != null ? pos[key] * H : null);
      // never placed by hand: tabs stack from the top where they sit, the moved top-bar buttons from the bottom
      if (want == null) {
        if (TOP_TOOLS.includes(el.id)) want = H;
        else { want = stack; stack += h + GAP; }
      }
      return { el, h, want, i };
    }).sort((a, b) => a.want - b.want || a.i - b.i);
    let prev = PAD - GAP;
    for (const x of list) { x.top = Math.max(Math.min(x.want, H - PAD - x.h), PAD, prev + GAP); prev = x.top + x.h; }
    let next = H - PAD + GAP;
    for (const x of [...list].reverse()) { x.top = Math.max(PAD, Math.min(x.top, next - GAP - x.h)); next = x.top; }
    return list;
  }
  layoutRail() {
    const rail = $('#rightrail');
    if (!rail) return;
    rail.classList.add('rrail-free');
    const H = rail.clientHeight;
    const W = rail.clientWidth;
    if (!H) return;
    for (const x of this.railTops(this.railItems(), H)) {
      x.el.style.top = `${Math.round(x.top)}px`;
      x.el.style.left = `${Math.round((W - x.el.offsetWidth) / 2)}px`;
    }
    if (!this._railRO) {
      // re-place when the window (or something in the sidebar, like the radar's readout) changes size
      this._railRO = new ResizeObserver(() => cancelAnimationFrame(this._railRaf) || (this._railRaf = requestAnimationFrame(() => this.layoutRail())));
      this._railRO.observe(rail);
    }
    for (const el of this.railItems()) if (!el._railObserved) { el._railObserved = true; this._railRO.observe(el); }
  }
  /** Let go at height y (inside the sidebar): its spot is where its middle was. */
  railMove(el, y) {
    this.placeInRail(el);
    const rail = $('#rightrail');
    const r = rail.getBoundingClientRect();
    const key = this.railKey(el);
    if (key) this.saveSettings({ railPos: { ...(this.settings.railPos || {}), [key]: Math.min(1, Math.max(0, (y - r.top - el.offsetHeight / 2) / (r.height || 1))) } });
    this.syncRail();
  }
  /** While dragging over the sidebar: an outline where the item would land. */
  railMarker(ev, el) {
    const rail = $('#rightrail');
    let m = this._railMarker;
    if (!m) { m = this._railMarker = h('div', { class: 'rrail-marker' }); document.body.append(m); }
    const r = rail.getBoundingClientRect();
    if (!ev || rail.classList.contains('rail-empty') || ev.clientX < r.left - 20 || ev.clientX > r.right + 20 || ev.clientY < r.top || ev.clientY > r.bottom) { m.hidden = true; return; }
    // measure it the size it'll be in the sidebar (a top-bar button is a different shape there)
    const h0 = el.closest('#rightrail') ? el.offsetHeight : (TOP_TOOLS.includes(el.id) ? 62 : 70);
    const fake = { offsetHeight: h0 };
    const probe = this.railTops([...this.railItems(el), fake].map((x) => x), r.height, { el: fake, top: ev.clientY - r.top - h0 / 2 }).find((x) => x.el === fake);
    m.hidden = false;
    m.style.left = `${r.left + 2}px`;
    m.style.width = `${r.width - 4}px`;
    m.style.top = `${Math.round(r.top + probe.top)}px`;
    m.style.height = `${h0}px`;
  }

  railTools() {
    if (!this._railTools) {
      this._railTools = h('div', { class: 'rrail-tools' });
      $('#rightrail').append(h('div', { class: 'rrail-spacer' }), this._railTools);
    }
    return this._railTools;
  }

  setToolDock(id, side, { save = true, drop = null } = {}) {
    const el = $(`#${id}`);
    if (!el) return;
    el.classList.toggle('in-rail', side); // before measuring, so it's sized like the other sidebar items
    if (side) {
      if (drop) this.railMove(el, drop.clientY);
      else this.placeSaved(el);
    } else {
      const bar = $('.titlebar-actions');
      const after = TOP_TOOLS.slice(TOP_TOOLS.indexOf(id) + 1).map((x) => $(`#${x}`)).find((x) => x && x.parentElement === bar);
      if (after) bar.insertBefore(el, after); else bar.append(el);
      if (drop && save) this.topMove(el, drop.clientX); // let go somewhere on the bar: it goes there
      else this.applyBarOrder(bar, 'top');
    }
    this.syncRail();
    if (save) this.saveSettings({ toolDock: { ...(this.settings.toolDock || {}), [id]: side ? 'side' : 'top' } });
  }

  wireToolDock() {
    for (const id of TOP_TOOLS.slice(1)) {
      const el = $(`#${id}`);
      if (!el) continue;
      el.dataset.rlabel ||= TOOL_LABEL[id]; // the clock keeps its own (the time)
      // drag or flick it to the other place
      flingable(el, () => (el.closest('#rightrail') ? $('.titlebar-actions') : $('#rightrail')), (drop) => this.setToolDock(id, !el.closest('#rightrail'), { drop }),
        {
          home: () => (el.closest('#rightrail') ? $('#rightrail') : $('.titlebar-actions')),
          onHome: (ev) => (el.closest('#rightrail') ? this.railMove(el, ev.clientY) : this.topMove(el, ev.clientX)),
          marker: (ev, x) => { this.railMarker(ev, x); this.topMarker(ev, x); },
        });
      if ((this.settings.toolDock || {})[id] === 'side') this.setToolDock(id, true, { save: false });
    }
  }

  // ---- the order of things in the top bar and the left sidebar: drag to rearrange, kept in settings.barOrder

  /** An item's name in settings.barOrder. */
  barKey(el) {
    if (el.nodeType !== 1) return null;
    if (el.id) return el.id;
    if (el.dataset.tpanel) return `tpanel:${el.dataset.tpanel}`;
    if (el.dataset.panel) return `panel:${el.dataset.panel}`;
    if (el.classList.contains('rail-spacer')) return 'spacer';
    return null;
  }
  /** Put a bar's items back in their saved order. Items it doesn't know (new ones) keep their places. */
  applyBarOrder(bar, name) {
    const saved = (this.settings.barOrder || {})[name];
    if (!bar || !saved?.length) return;
    const rank = new Map(saved.map((k, i) => [k, i]));
    const kids = [...bar.children].filter((c) => rank.has(this.barKey(c)));
    const slots = kids.map((c) => { const m = document.createComment(''); c.before(m); return m; });
    const sorted = [...kids].sort((a, b) => rank.get(this.barKey(a)) - rank.get(this.barKey(b)));
    slots.forEach((m, i) => m.replaceWith(sorted[i]));
  }
  /** Save a bar's order. Items that are away (moved to the other bar) keep their old place in the list. */
  saveBarOrder(bar, name) {
    const now = [...bar.children].map((c) => this.barKey(c)).filter(Boolean);
    const old = (this.settings.barOrder || {})[name] || [];
    for (let i = 0; i < old.length; i++) {
      if (now.includes(old[i])) continue;
      const before = old.slice(0, i).reverse().find((k) => now.includes(k));
      now.splice(before ? now.indexOf(before) + 1 : 0, 0, old[i]);
    }
    this.saveSettings({ barOrder: { ...(this.settings.barOrder || {}), [name]: now } });
  }
  /** Where along the bar something let go at x lands: before the first item whose middle is past x. */
  topSpot(el, x) {
    const bar = $('.titlebar-actions');
    return [...bar.children].find((c) => c !== el && !c.hidden && this.barKey(c) && (() => { const r = c.getBoundingClientRect(); return r.width && r.left + r.width / 2 > x; })()) || null;
  }
  topMove(el, x) {
    const bar = $('.titlebar-actions');
    const at = this.topSpot(el, x);
    if (at) bar.insertBefore(el, at); else bar.append(el);
    this.saveBarOrder(bar, 'top');
  }
  /** While dragging a top-bar button along the top bar: a line where it would go. */
  topMarker(ev, el) {
    const bar = $('.titlebar-actions');
    let m = this._topMarker;
    if (!m) { m = this._topMarker = h('div', { class: 'top-marker' }); document.body.append(m); }
    const r = bar.getBoundingClientRect();
    if (!ev || !bar.contains(el) || ev.clientX < r.left - 20 || ev.clientX > r.right + 20 || ev.clientY < r.top - 20 || ev.clientY > r.bottom + 20) { m.hidden = true; return; }
    const at = this.topSpot(el, ev.clientX);
    const vis = [...bar.children].filter((c) => c !== el && !c.hidden && c.getBoundingClientRect().width);
    const x = at ? at.getBoundingClientRect().left - 2 : (vis.length ? vis[vis.length - 1].getBoundingClientRect().right + 2 : r.left);
    m.hidden = false;
    m.style.left = `${Math.round(x - 1)}px`;
    m.style.top = `${Math.round(r.top + 4)}px`;
    m.style.height = `${Math.max(16, Math.round(r.height - 8))}px`;
  }

  /** Left sidebar: drag a button up or down to move it (across the gap too, to sit at the bottom with Settings). */
  wireLeftRailOrder() {
    const rail = $('#rail');
    if (!rail) return;
    const usual = [...rail.children].map((c) => this.barKey(c)).filter(Boolean);
    this.applyBarOrder(rail, 'rail');
    // the button follows the pointer; the others make room as it passes their middles
    const startDrag = (b, e) => {
      const sy = e.clientY;
      const grab = sy - b.getBoundingClientRect().top;
      let moving = false;
      const move = (ev) => {
        if (!moving) {
          if (Math.abs(ev.clientY - sy) < 5) return;
          moving = true;
          b.classList.add('rail-dragging');
          rail.classList.add('rail-sorting');
          document.body.classList.add('rail-grabbing');
        }
        ev.preventDefault();
        const y = Math.max(rail.getBoundingClientRect().top, Math.min(rail.getBoundingClientRect().bottom, ev.clientY));
        const at = [...rail.children].find((c) => c !== b && !c.hidden && this.barKey(c) && (() => { const r = c.getBoundingClientRect(); return r.top + r.height / 2 > y; })());
        if (at) { if (b.nextElementSibling !== at) rail.insertBefore(b, at); } else if (rail.lastElementChild !== b) rail.append(b);
        b.style.transform = '';
        const natural = b.getBoundingClientRect().top;
        b.style.transform = `translateY(${Math.round(y - grab - natural)}px)`;
      };
      const up = () => {
        removeEventListener('pointermove', move, true);
        removeEventListener('pointerup', up, true);
        removeEventListener('pointercancel', up, true);
        if (!moving) return;
        b.classList.remove('rail-dragging');
        rail.classList.remove('rail-sorting');
        document.body.classList.remove('rail-grabbing');
        b.style.transition = 'transform 0.15s';
        b.style.transform = '';
        setTimeout(() => { b.style.transition = ''; }, 160);
        // the click that ends a drag doesn't open the panel
        const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
        b.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => b.removeEventListener('click', swallow, { capture: true }), 60);
        this.saveBarOrder(rail, 'rail');
      };
      // on the window, not the button: moving the button in the page would cut it off from the pointer
      addEventListener('pointermove', move, true);
      addEventListener('pointerup', up, true);
      addEventListener('pointercancel', up, true);
    };
    for (const b of rail.querySelectorAll('.rail-btn')) {
      b.addEventListener('pointerdown', (e) => { if (e.button === 0) startDrag(b, e); });
      b.addEventListener('dragstart', (e) => e.preventDefault());
      if (!/drag/.test(b.title)) b.title += ' · drag to move it';
    }
    rail.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.rail-btn') && e.target !== rail && !e.target.classList.contains('rail-spacer')) return;
      contextMenu(e, [{ label: 'Reset the sidebar’s order', icon: 'refresh', disabled: !(this.settings.barOrder || {}).rail, action: () => {
        const { rail: _, ...rest } = this.settings.barOrder || {};
        this.saveSettings({ barOrder: rest });
        this.settings.barOrder = { ...rest, rail: usual };
        this.applyBarOrder(rail, 'rail');
        this.settings.barOrder = rest;
      } }]);
    });
  }

  syncMusicButton(playing) { $('#btn-music')?.classList.toggle('playing', !!playing); this._musicTab?.classList.toggle('playing', !!playing); }
}
