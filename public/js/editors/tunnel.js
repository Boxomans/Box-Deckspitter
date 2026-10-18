// BoxTunnel: audio lines. Each line (BoxAudioLine1, 2, …) takes one input and plays it to one output, with a
// volume, a meter and a "listen" toggle. The sound itself runs in core/tunnel.js so it outlives this tab.

import { BaseEditor } from './base.js';
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { contextMenu, confirmDialog, promptDialog, showMenu, toast } from '../core/ui.js';
import { tunnel, deviceName, isVirtual } from '../core/tunnel.js';
import { FX, VOICES, newFx } from '../core/tunnel-fx.js';

const opt = (value, label, selected) => h('option', { value, selected: !!selected }, label);
/** -72..0 dB → 0..100% of an input meter. */
const dbPct = (db) => Math.max(0, Math.min(100, ((db + 72) / 72) * 100));

export class TunnelEditor extends BaseEditor {
  static mode = 'tunnel';

  async load() {
    this.t = tunnel(this.app);
    this.linesEl = h('div', { class: 'tn-lines' });
    this.hintEl = h('div', { class: 'tn-hint' });
    this.monSel = h('select', { class: 'tn-sel', title: 'Where “listen” plays', onchange: () => this.t.setMonitor(this.monSel.value) });
    this.monVol = h('input', { type: 'range', min: 0, max: 1.5, step: 0.01, class: 'tn-vol', title: 'Listen volume', oninput: () => this.t.setMonitor(undefined, +this.monVol.value) });
    const check = (key, label, tip) => h('label', { class: 'check', title: tip },
      h('input', { type: 'checkbox', checked: !!this.t.cfg[key], onchange: (e) => this.t.save({ [key]: e.target.checked }) }), h('span', {}, label));
    this.root = h('div', { class: 'sp-root' }, h('div', { class: 'sp-inner tn-inner' },
      h('div', { class: 'sp-head' },
        h('div', { class: 'klep-title' }, h('span', { class: 'g tn-g' }, this.app.toolLabel('BoxTunnel')), h('span', { class: 'klep-cursor' })),
        h('div', { class: 'klep-sub mono' }, '> any sound in · any output out · listen in on any line'),
        h('div', { class: 'row tn-top' },
          h('button', { class: 'btn primary', onclick: () => { this.t.addLine(); this.render(); } }, icon('plus', 'sm'), 'Add line'),
          h('button', { class: 'btn', onclick: () => this.allOff() }, icon('power', 'sm'), 'Turn all off'),
          h('div', { class: 'grow' }),
          h('span', { class: 'faint tn-lbl' }, icon('volume', 'sm'), 'Listen on'), this.monSel, this.monVol),
        h('div', { class: 'row tn-opts' },
          check('keep', 'Keep lines running when this tab is closed', 'Off: closing BoxTunnel stops every line until you open it again'),
          check('autostart', 'Start lines when the app opens', 'Lines that are on start by themselves, without opening BoxTunnel'))),
      this.hintEl, this.linesEl));
    this.pane.append(this.root);
    this.off = this.t.on(() => this.renderState());
    await this.t.start();
    if (!this.t.lines.length) this.t.addLine();
    this.render();
    this.loop();
  }

  // ---- drawing

  render() {
    const { inputs, outputs } = this.t.devs;
    const cfg = this.t.cfg;
    clear(this.monSel).append(opt('', 'Default output', !cfg.monitor), ...outputs.filter((d) => d.id !== 'default').map((d) => opt(d.id, deviceName(d.label), d.id === cfg.monitor)));
    this.monVol.value = cfg.monitorVolume;

    const virt = outputs.filter((d) => d.id !== 'default' && isVirtual(d.label));
    clear(this.hintEl).append(icon('info', 'sm'), virt.length
      ? h('span', {}, 'Each line mixes its inputs (say your mic and the system sound) into one. Lines only exist inside this app. To let other apps (Discord, OBS, games) hear one, send it to a virtual cable you have installed — found: ', h('b', {}, virt.map((d) => deviceName(d.label)).join(', ')), ' — and pick that cable as the microphone in the other app.')
      : h('span', {}, 'Each line mixes its inputs (say your mic and the system sound) into one, and plays to your own devices. For other apps to pick a line as their microphone you need a virtual audio cable (VB-Audio Cable is free); once installed it shows up here as an output.'));

    clear(this.linesEl);
    this.rows = new Map();
    for (const l of this.t.lines) {
      const outSel = h('select', { class: 'tn-sel', title: 'Output' });
      const outDev = l.output?.id === 'none' ? null : this.t.resolve(outputs, l.output);
      outSel.append(opt('none', 'None (listen only)'),
        ...outputs.map((d) => opt(d.id, d.id === 'default' ? `Default output (${deviceName(d.label.replace(/^Default\s*-\s*/i, ''))})` : deviceName(d.label) + (isVirtual(d.label) ? '  · cable' : ''))));
      if (l.output?.id !== 'none' && !outDev) outSel.append(opt(l.output.id, `${deviceName(l.output.label)} (not connected)`));
      outSel.value = l.output?.id === 'none' ? 'none' : (outDev || l.output).id;
      outSel.onchange = () => {
        const d = outputs.find((x) => x.id === outSel.value);
        this.t.update(l.id, { output: d ? { id: d.id, label: d.label } : { id: 'none', label: '' } });
        this.render();
      };

      const power = h('button', { class: `icon-btn tn-power ${l.on ? 'on' : ''}`, 'data-tip': l.on ? 'Turn off' : 'Turn on', onclick: () => { this.t.update(l.id, { on: !l.on }); this.render(); } }, icon('power', 'sm'));
      const name = h('div', { class: 'tn-name', title: 'Double-click to rename', ondblclick: () => this.rename(l) }, l.name);
      const meter = h('div', { class: 'tn-meter' }, h('div', { class: 'tn-meter-fill' }));
      const [vol, pct] = this.slider(l.volume, (v) => this.t.update(l.id, { volume: v }), 'Line volume (double-click: 100%)');
      const mute = h('button', { class: `icon-btn ${l.mute ? 'on warn' : ''}`, 'data-tip': l.mute ? 'Unmute' : 'Mute the line', onclick: () => { this.t.update(l.id, { mute: !l.mute }); this.render(); } }, icon(l.mute ? 'volume-x' : 'volume', 'sm'));
      const listen = h('button', { class: `btn sm tn-listen ${l.listen ? 'on' : ''}`, title: 'Hear what’s going through this line', onclick: () => { this.t.update(l.id, { listen: !l.listen }); this.render(); } }, icon('headphones', 'sm'), l.listen ? 'Listening' : 'Listen');
      const more = h('button', { class: 'icon-btn', 'data-tip': 'More', onclick: (e) => this.lineMenu(e, l) }, icon('more', 'sm'));

      // the compressor evens out the mix: loud bits down, everything brought back up
      const compSeg = h('div', { class: 'seg tn-comp', 'data-tip': 'Compressor: evens out loud and quiet parts of the mix' },
        ...['off', 'light', 'medium', 'strong'].map((v) => h('button', { class: (l.comp || 'off') === v ? 'on' : '', onclick: () => { this.t.update(l.id, { comp: v }); this.render(); } }, v)));
      const red = h('span', { class: 'tn-red mono', title: 'How much the compressor is turning it down right now' });

      const ins = h('div', { class: 'tn-ins' });
      const inRows = new Map();
      for (const i of l.inputs) {
        const r = this.inputRow(l, i);
        ins.append(r.el);
        inRows.set(i.key, r);
      }
      ins.append(h('div', { class: 'tn-ins-foot' },
        h('button', { class: 'btn sm ghost', onclick: () => { this.t.addInput(l.id); this.render(); } }, icon('plus', 'sm'), 'Add input'),
        h('div', { class: 'grow' }),
        h('span', { class: 'faint tn-lbl' }, 'Compressor'), compSeg, red));

      const state = h('div', { class: 'tn-state' });
      const row = h('div', { class: `tn-line ${l.on ? '' : 'off'}` },
        h('div', { class: 'tn-main' }, power, name, h('div', { class: 'grow' }),
          h('span', { class: 'tn-tag' }, 'mix'), meter, icon('arrow-right', 'sm'),
          h('div', { class: 'tn-io' }, h('span', { class: 'tn-tag' }, 'out'), outSel),
          h('div', { class: 'tn-volbox' }, vol, pct), mute, listen, more),
        ins, state);
      row.addEventListener('contextmenu', (e) => { if (!e.target.closest('select, input')) this.lineMenu(e, l); });
      this.linesEl.append(row);
      this.rows.set(l.id, { row, meter: meter.firstChild, state, red, inRows });
    }
    if (!this.t.lines.length) this.linesEl.append(h('div', { class: 'tn-empty faint' }, 'No lines yet — Add line makes BoxAudioLine1.'));
    this.renderState();
  }

  /** A 0–200% volume slider and its readout; double-click resets to 100%. */
  slider(value, onChange, tip) {
    const vol = h('input', { type: 'range', min: 0, max: 2, step: 0.01, class: 'tn-vol', value: value ?? 1, title: tip });
    const pct = h('span', { class: 'tn-pct mono' }, `${Math.round((value ?? 1) * 100)}%`);
    vol.oninput = () => { pct.textContent = `${Math.round(+vol.value * 100)}%`; onChange(+vol.value); };
    vol.ondblclick = () => { vol.value = 1; vol.oninput(); };
    return [vol, pct];
  }

  /** One input of a line: what it is, its level (with the gate's threshold on it), volume, mute, gate, remove. */
  inputRow(l, i) {
    const { inputs } = this.t.devs;
    const sel = h('select', { class: 'tn-sel', title: 'Input' });
    const devOpts = inputs.map((d) => opt(`dev:${d.id}`, d.id === 'default' ? `Default mic (${deviceName(d.label.replace(/^Default\s*-\s*/i, ''))})` : deviceName(d.label)));
    const dev = i.kind === 'device' ? this.t.resolve(inputs, i) : null;
    if (i.kind === 'device' && !dev) devOpts.push(opt(`dev:${i.id}`, `${deviceName(i.label)} (not connected)`));
    // other lines, but not ones that already take sound from this line (that would loop)
    const others = this.t.lines.filter((o) => o.id !== l.id && !this.t.feeds(o.id).has(l.id));
    sel.append(
      h('optgroup', { label: 'Microphones & line-in' }, ...devOpts),
      h('optgroup', { label: 'System' }, opt('system', 'System sound (everything playing)')),
      others.length ? h('optgroup', { label: 'Lines' }, ...others.map((o) => opt(`line:${o.id}`, o.name))) : null);
    sel.value = i.kind === 'line' ? `line:${i.id}` : i.kind === 'device' ? `dev:${(dev || i).id}` : 'system';
    sel.onchange = () => {
      const v = sel.value;
      if (v === 'system') this.t.updateInput(l.id, i.key, { kind: 'system', id: undefined, label: undefined });
      else if (v.startsWith('line:')) this.t.updateInput(l.id, i.key, { kind: 'line', id: v.slice(5), label: undefined });
      else { const d = inputs.find((x) => `dev:${x.id}` === v); if (d) this.t.updateInput(l.id, i.key, { kind: 'device', id: d.id, label: d.label }); }
      this.render();
    };

    // input meter, -72..0 dB, with the gate threshold marked on it
    const fill = h('div', { class: 'tn-meter-fill' });
    const mark = h('div', { class: 'tn-thr', hidden: !i.gate, style: `left:${dbPct(i.threshold)}%` });
    const meter = h('div', { class: 'tn-meter tn-imeter' }, fill, mark);
    const [vol, pct] = this.slider(i.volume, (v) => this.t.updateInput(l.id, i.key, { volume: v }), 'Input volume (double-click: 100%)');
    const mute = h('button', { class: `icon-btn ${i.mute ? 'on warn' : ''}`, 'data-tip': i.mute ? 'Unmute' : 'Mute this input', onclick: () => { this.t.updateInput(l.id, i.key, { mute: !i.mute }); this.render(); } }, icon(i.mute ? 'volume-x' : 'volume', 'sm'));
    const thr = h('input', { type: 'range', min: -80, max: -10, step: 1, class: 'tn-gthr', value: i.threshold, title: 'Gate threshold: quieter than this is cut', hidden: !i.gate });
    const thrLbl = h('span', { class: 'tn-pct mono', hidden: !i.gate }, `${Math.round(i.threshold)} dB`);
    thr.oninput = () => {
      thrLbl.textContent = `${thr.value} dB`;
      mark.style.left = `${dbPct(+thr.value)}%`;
      this.t.updateInput(l.id, i.key, { threshold: +thr.value });
    };
    const gate = h('button', { class: `btn sm tn-gate ${i.gate ? 'on' : ''}`, title: 'Noise gate: cuts the background hiss and keyboard between words', onclick: () => { this.t.updateInput(l.id, i.key, { gate: !i.gate }); this.render(); } }, 'Gate');
    const del = h('button', { class: 'icon-btn', 'data-tip': 'Remove this input', onclick: () => { this.t.removeInput(l.id, i.key); this.render(); } }, icon('x', 'sm'));
    const err = h('span', { class: 'tn-err tn-inerr' });
    const nfx = i.fx.filter((f) => f.on).length;
    const fxBtn = h('button', { class: `btn sm tn-fxbtn ${nfx ? 'on' : ''}`, title: 'Voice changers and effects', onclick: (e) => showMenu(this.fxMenu(l, i), { anchor: e.currentTarget }) },
      icon('wand', 'sm'), nfx ? `Effects · ${nfx}` : 'Effects');
    const row = h('div', { class: `tn-in ${i.mute ? 'muted' : ''}` },
      h('span', { class: 'tn-tag' }, 'in'), sel, meter, h('div', { class: 'tn-volbox' }, vol, pct), mute, gate, thr, thrLbl, fxBtn, h('div', { class: 'grow' }), err, del);
    row.addEventListener('contextmenu', (e) => {
      if (e.target.closest('select, input')) return;
      e.preventDefault(); e.stopPropagation();
      contextMenu(e, this.fxMenu(l, i));
    });
    const el = h('div', { class: 'tn-inwrap' }, row, i.fx.length ? this.fxStrip(l, i) : null);
    return { el, fill, err, gateOn: i.gate, threshold: i.threshold, thr };
  }

  // ---- effects on an input

  setFx(l, i, fx) { this.t.updateInput(l.id, i.key, { fx }); this.render(); }

  /** Voice changers (a ready-made set) and single effects; both add to what's there. */
  fxMenu(l, i) {
    const fresh = !i.fx.length;
    const add = (list, replace = false) => {
      this.setFx(l, i, replace ? list : [...i.fx, ...list]);
      if (fresh && !l.listen) toast('Effects are on. Listen to hear yourself through the line.', { timeout: 6000, action: { label: 'Listen', fn: () => { this.t.update(l.id, { listen: true }); this.render(); } } });
    };
    return [
      // a voice replaces the effects already there; single effects add on
      { label: 'Voice changer', icon: 'wand', submenu: VOICES.map((v) => ({ label: v.name, action: () => add(v.fx.map(([t, x]) => newFx(t, x)), true) })) },
      { label: 'Add an effect', icon: 'plus', submenu: Object.entries(FX).map(([t, d]) => ({ label: d.name, action: () => add([newFx(t)]) })) },
      { sep: true },
      { label: l.listen ? 'Stop listening' : 'Listen to this line', icon: 'headphones', action: () => { this.t.update(l.id, { listen: !l.listen }); this.render(); } },
      { label: i.fx.some((f) => f.on) ? 'Bypass all effects' : 'Turn the effects back on', icon: 'power', disabled: !i.fx.length, action: () => { const off = i.fx.some((f) => f.on); this.setFx(l, i, i.fx.map((f) => ({ ...f, on: !off }))); } },
      { label: 'Remove all effects', icon: 'trash', disabled: !i.fx.length, action: () => this.setFx(l, i, []) },
    ];
  }

  /** The effects on an input, in order: click a name to bypass it, drag its knob, ‹ › to reorder, × to remove. */
  fxStrip(l, i) {
    const strip = h('div', { class: 'tn-fx' });
    i.fx.forEach((f, n) => {
      const d = FX[f.type];
      if (!d) return;
      const val = h('span', { class: 'tn-fx-val mono' });
      const show = (v) => { val.textContent = `${+(+v).toFixed(d.step < 1 ? 1 : 0)}${d.unit === '%' ? '%' : ` ${d.unit}`}`; };
      show(f.v);
      const knob = h('input', { type: 'range', min: d.min, max: d.max, step: d.step, value: f.v, class: 'tn-fx-knob', title: `${d.name} (double-click: default)` });
      const put = (v) => { show(v); this.t.updateInput(l.id, i.key, { fx: this.t.line(l.id).inputs.find((x) => x.key === i.key).fx.map((x) => (x.key === f.key ? { ...x, v } : x)) }); };
      knob.oninput = () => put(+knob.value);
      knob.ondblclick = () => { knob.value = d.def; put(d.def); };
      const move = (dir) => { const fx = [...i.fx]; const j = n + dir; if (j < 0 || j >= fx.length) return; [fx[n], fx[j]] = [fx[j], fx[n]]; this.setFx(l, i, fx); };
      strip.append(h('div', { class: `tn-fx-chip ${f.on ? '' : 'off'}` },
        h('button', { class: 'tn-fx-name', title: f.on ? 'Click to bypass' : 'Bypassed — click to turn on', onclick: () => this.setFx(l, i, i.fx.map((x) => (x.key === f.key ? { ...x, on: !x.on } : x))) }, d.name),
        knob, val,
        i.fx.length > 1 ? h('button', { class: 'icon-btn tiny', 'data-tip': 'Earlier', disabled: n === 0, onclick: () => move(-1) }, icon('chevron-left', 'sm')) : null,
        i.fx.length > 1 ? h('button', { class: 'icon-btn tiny', 'data-tip': 'Later', disabled: n === i.fx.length - 1, onclick: () => move(1) }, icon('chevron-right', 'sm')) : null,
        h('button', { class: 'icon-btn tiny', 'data-tip': 'Remove', onclick: () => this.setFx(l, i, i.fx.filter((x) => x.key !== f.key)) }, icon('x', 'sm'))));
    });
    strip.append(h('button', { class: `btn sm tn-listen ${l.listen ? 'on' : ''}`, title: 'Hear this line (with the effects) on the Listen on device', onclick: () => { this.t.update(l.id, { listen: !l.listen }); this.render(); } },
      icon('headphones', 'sm'), l.listen ? 'Listening' : 'Listen'));
    return strip;
  }

  /** Running / error / warning under each line (cheap: called on every engine change). */
  renderState() {
    if (!this.rows) return;
    if (this.app.active === this.tab) this.refreshStatus();
    for (const l of this.t.lines) {
      const r = this.rows.get(l.id);
      if (!r) continue;
      const err = this.t.errors.get(l.id);
      const warn = this.t.warning(l);
      const running = this.t.run.has(l.id);
      clear(r.state).append(
        err ? h('span', { class: 'tn-err' }, icon('alert', 'sm'), err)
          : !l.on ? h('span', { class: 'faint' }, 'off')
            : running ? h('span', { class: 'tn-ok' }, h('i', { class: 'tn-dot' }), `running · ${this.t.latency(l.id)} ms`) : h('span', { class: 'faint' }, 'starting…'),
        !l.inputs.length ? h('span', { class: 'faint' }, 'no inputs — Add input') : null,
        warn ? h('span', { class: 'tn-warn' }, icon('alert', 'sm'), warn) : null);
      for (const i of l.inputs) {
        const ir = r.inRows.get(i.key);
        if (!ir) continue;
        const m = this.t.inErrors.get(`${l.id}:${i.key}`);
        clear(ir.err).append(...(m ? [icon('alert', 'sm'), m] : []));
      }
    }
  }

  loop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (this.hidden || !this.rows) return;
      for (const [id, r] of this.rows) {
        const p = this.t.level(id);
        const db = p > 0 ? 20 * Math.log10(p) : -60;
        r.meter.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
        r.meter.classList.toggle('hot', p > 0.89);
        const red = this.t.reduction(id);
        r.red.textContent = red < -0.5 ? `−${Math.abs(red).toFixed(0)} dB` : '';
        for (const [key, ir] of r.inRows) {
          const ip = this.t.inputLevel(id, key);
          const idb = ip > 0 ? 20 * Math.log10(ip) : -100;
          ir.fill.style.width = `${dbPct(idb)}%`;
          // below the gate's threshold: shown dimmed, that part is being cut
          ir.fill.classList.toggle('gated', ir.gateOn && idb < +ir.thr.value);
          ir.fill.classList.toggle('hot', ip > 0.89);
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  // ---- actions

  async rename(l) {
    const name = (await promptDialog('Rename line', 'Name', l.name))?.trim();
    if (!name || name === l.name) return;
    this.t.update(l.id, { name });
    this.render();
  }

  lineMenu(e, l) {
    e.preventDefault();
    contextMenu(e, [
      { label: 'Rename…', icon: 'edit-text', action: () => this.rename(l) },
      { label: l.on ? 'Turn off' : 'Turn on', icon: 'power', action: () => { this.t.update(l.id, { on: !l.on }); this.render(); } },
      { label: 'Restart', icon: 'refresh', disabled: !l.on, action: () => { this.t.restart(l.id); } },
      { sep: true },
      { label: 'Delete line', icon: 'trash', action: async () => {
        if (await confirmDialog('Delete line', `Delete ${l.name}?`, { okLabel: 'Delete', danger: true })) { this.t.remove(l.id); this.render(); }
      } },
    ]);
  }

  allOff() {
    this.t.setLines(this.t.lines.map((l) => ({ ...l, on: false })));
    this.t.sync();
    this.render();
  }

  status() {
    const n = this.t?.running || 0;
    const total = this.t?.lines.length || 0;
    return { left: [{ text: `${total} ${total === 1 ? 'line' : 'lines'} · ${n} running` }], right: [] };
  }

  onShow() { this.hidden = false; if (this.rows) { this.t.refreshDevices().then(() => this.render()); this.loop(); } }
  onHide() { this.hidden = true; cancelAnimationFrame(this.raf); }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.off?.();
    if (!this.t.cfg.keep) this.t.stopAll();
  }
}
