// Box-Deckspitter app shell, the side panels that move between the right sidebar and the top bar, and the sound button.
// Methods of App (app.js mixes this class into it).

import { $, $$, h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { SIDE_PANELS } from './shared.js';

export class SidebarsPart {
  /** Move chars / claude / clip between the right sidebar ('side') and the top bar ('top'). */
  setPanelDock(name, where, { save = true, drop = null } = {}) {
    const tab = $(`.rrail-tab[data-rpanel="${name}"]`);
    const btn = $(`.top-panel-btn[data-tpanel="${name}"]`);
    if (!tab || !btn) return;
    const top = where === 'top';
    if (top && this.rightPanel === name) this.toggleRightPanel(null);
    if (!top && this.topPanel === name) this.closeTopPanel();
    tab.hidden = top;
    btn.hidden = !top;
    if (!top && drop) this.railMove(tab, drop.clientY);
    this.syncRail();
    if (save) this.saveSettings({ panelDock: { ...(this.settings.panelDock || {}), [name]: top ? 'top' : 'side' } });
    if (save && top) this.toggleTopPanel(name); // show where it went
    else if (save) this.toggleRightPanel(name, { force: true });
  }
  panelOnTop(name) { return (this.settings.panelDock || {})[name] === 'top'; }

  /** The chars / claude / clip panel element, created the first time it's needed. */
  ensureSidePanel(name) {
    this.rightPanels = this.rightPanels || {};
    if (this.rightPanels[name]) return this.rightPanels[name];
    const el = h('div', { class: 'rp-container' });
    this.rightPanels[name] = { el, panel: null };
    const load = name === 'chars'
      ? import('../core/chars-panel.js').then(({ CharsPanel }) => new CharsPanel(this, el))
      : name === 'clip'
        ? import('../core/clips-panel.js').then(({ ClipsPanel }) => new ClipsPanel(this, el))
        : import('../core/ai-panel.js').then(({ AiPanel }) => new AiPanel(this, el));
    load.then((panel) => { this.rightPanels[name].panel = panel; });
    return this.rightPanels[name];
  }

  /** Top-bar mode: the panel drops down under its button (click again, Esc or click elsewhere to close). */
  toggleTopPanel(name) {
    if (this.topPanel === name) return this.closeTopPanel();
    this.closeTopPanel();
    const btn = $(`.top-panel-btn[data-tpanel="${name}"]`);
    if (!btn || btn.hidden) return;
    if (!this.topPop) {
      this.topPop = h('div', { class: 'panel-pop' });
      document.body.append(this.topPop);
      document.addEventListener('pointerdown', (e) => {
        if (!this.topPanel || performance.now() - this.topPopAt < 250) return;
        if (this.topPop.contains(e.target) || e.target.closest?.('.top-panel-btn') || e.target.closest?.('.menu, .modal-backdrop')) return;
        this.closeTopPanel();
      }, true);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.topPanel && !document.querySelector('.modal-backdrop')) this.closeTopPanel(); });
      addEventListener('resize', () => this.topPanel && this.placeTopPanel());
    }
    const p = this.ensureSidePanel(name);
    this.topPop.dataset.panel = name;
    // only one panel at a time in the drop-down
    for (const c of this.topPop.children) if (c !== p.el) c.hidden = true;
    this.topPop.append(p.el);
    p.el.hidden = false;
    this.topPop.hidden = false;
    this.topPanel = name;
    this.topPopAt = performance.now();
    btn.classList.add('on');
    if (name === 'ai') p.panel?.render();
    this.placeTopPanel();
  }
  placeTopPanel() {
    const b = $(`.top-panel-btn[data-tpanel="${this.topPanel}"]`)?.getBoundingClientRect();
    if (!b) return;
    this.topPop.style.top = `${Math.round(b.bottom + 6)}px`;
    this.topPop.style.right = `${Math.max(8, Math.round(innerWidth - b.right - 8))}px`;
  }
  closeTopPanel() {
    if (!this.topPanel) return;
    $(`.top-panel-btn[data-tpanel="${this.topPanel}"]`)?.classList.remove('on');
    this.topPop.hidden = true;
    this.topPanel = null;
  }

  toggleRightPanel(name, { force = false } = {}) {
    const host = $('#rightpanel');
    if (name && SIDE_PANELS[name] && this.panelOnTop(name)) return this.toggleTopPanel(name);
    if (name === 'music' && !this.music?.docked && this.settings.musicDock !== 'side') name = null;
    const next = name && (force || this.rightPanel !== name) ? name : null;
    this.rightPanel = next;
    host.hidden = !next;
    host.dataset.panel = next || '';
    $$('.rrail-tab').forEach((b) => b.classList.toggle('active', b.dataset.rpanel === next));
    this.saveSettings({ rightPanel: next });
    this.rightPanels = this.rightPanels || {};
    for (const [k, p] of Object.entries(this.rightPanels)) if (p.el.parentElement === host) p.el.hidden = k !== next;
    if (next === 'music' && !this.rightPanels.music) {
      const el = h('div', { class: 'rp-container' });
      host.append(el);
      this.rightPanels.music = { el, panel: null };
      this.music.dockInto(el);
    } else if (next && next !== 'music') {
      const fresh = !this.rightPanels[next];
      const p = this.ensureSidePanel(next);
      if (p.el.parentElement !== host) host.append(p.el); // coming back from the top bar
      p.el.hidden = false;
      if (!fresh && next === 'ai') p.panel?.render();
    }
    this.active?.editor?.onShow?.();
  }

  /** Insert text at the cursor of the active editor. Returns false if there's nowhere to put it. */
  insertTextIntoActive(text) {
    const ed = this.active?.editor;
    if (ed?.insertText) return ed.insertText(text) !== false;
    const el = this.lastEditable;
    if (el && el.isConnected && (!this.active || this.active.pane.contains(el))) {
      el.focus();
      return document.execCommand('insertText', false, text);
    }
    return false;
  }

  /** Hovering the speaker button pops out a volume slider for the UI sounds. */
  wireSoundVolume() {
    const btn = $('#btn-sound');
    const range = h('input', { type: 'range', min: '0', max: '1', step: '0.05', 'aria-label': 'Sound volume' });
    const pct = h('span', { class: 'mono' });
    const show = () => { pct.textContent = `${Math.round((this.settings.soundVolume ?? 0.7) * 100)}%`; };
    range.addEventListener('input', () => { this.settings.soundVolume = Number(range.value); this.sounds.setVolume(); show(); });
    range.addEventListener('change', () => { this.saveSettings({ soundVolume: Number(range.value) }); if (this.settings.sounds !== false) this.sounds.play('click'); });
    const pop = h('div', { class: 'vol-pop', hidden: true }, h('span', { class: 'faint' }, 'sounds'), range, pct);
    document.body.append(pop);
    let hideT = null;
    const open = () => {
      clearTimeout(hideT);
      range.value = String(this.settings.soundVolume ?? 0.7);
      show();
      const r = btn.getBoundingClientRect();
      pop.hidden = false;
      if (btn.closest('#rightrail')) {
        pop.style.top = Math.round(r.top + r.height / 2 - pop.offsetHeight / 2) + 'px';
        pop.style.left = Math.round(r.left - pop.offsetWidth - 8) + 'px';
      } else {
        pop.style.top = Math.round(r.bottom + 6) + 'px';
        pop.style.left = Math.round(r.left + r.width / 2 - pop.offsetWidth / 2) + 'px';
      }
    };
    const close = () => { hideT = setTimeout(() => { pop.hidden = true; }, 250); };
    for (const el of [btn, pop]) { el.addEventListener('mouseenter', open); el.addEventListener('mouseleave', close); }
    btn.addEventListener('wheel', (e) => { e.preventDefault(); range.value = String(Math.max(0, Math.min(1, Number(range.value) + (e.deltaY < 0 ? 0.05 : -0.05)))); range.dispatchEvent(new Event('input')); range.dispatchEvent(new Event('change')); }, { passive: false });
  }

  syncSoundButton() {
    const on = this.settings.sounds !== false;
    const b = $('#btn-sound');
    clear(b).append(icon(on ? 'volume' : 'volume-x'));
    b.title = on ? 'Sounds on — click to mute' : 'Sounds muted — click to turn on';
    b.classList.toggle('muted', !on);
  }
}
