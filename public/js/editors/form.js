// Form filler — a PDF mode tuned for government-style forms: field list, progress, autofill from
// a saved profile, and stamps (✓ ✗ date initials signature) for scanned forms without real fields.

import { PdfEditor } from './pdf.js';
import { h, clear, uid, stripExt } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { tbButton, tbSep, toast, modal, confirmDialog } from '../core/ui.js';
import { boxDispToRaw } from './pdf/geometry.js';
import { buildPdf } from './pdf/save.js';

const PROFILE_FIELDS = [
  ['fullName', 'Full name'], ['firstName', 'First name'], ['middleName', 'Middle name'], ['lastName', 'Last name'],
  ['dob', 'Date of birth'], ['email', 'Email'], ['phone', 'Phone'], ['street', 'Street address'], ['apt', 'Apt / unit'],
  ['city', 'City'], ['state', 'State / province'], ['zip', 'ZIP / postal code'], ['country', 'Country'], ['employer', 'Employer'], ['title', 'Job title'],
];

// field-name patterns → profile key (checked in order)
const MATCHERS = [
  [/(^|[^a-z])(first|given|fname|forename)[^a-z]*(name)?|first_?name|f_?name/i, 'firstName'],
  [/middle|mname|m\.?i\.?$|initial/i, 'middleName'],
  [/(last|sur|family)[^a-z]*name|lname|surname/i, 'lastName'],
  [/full[^a-z]*name|applicant[^a-z]*name|^name$|your[^a-z]*name|printed?[^a-z]*name|name[^a-z]*of/i, 'fullName'],
  [/birth|dob|b[-_ ]?day/i, 'dob'],
  [/e-?mail/i, 'email'],
  [/phone|tel(ephone)?|mobile|cell/i, 'phone'],
  [/apt|unit|suite/i, 'apt'],
  [/street|address[^a-z]*(1|line)?$|addr|residence/i, 'street'],
  [/city|town/i, 'city'],
  [/state|province|region/i, 'state'],
  [/zip|postal|post[^a-z]*code/i, 'zip'],
  [/country|nation/i, 'country'],
  [/employer|company|organization/i, 'employer'],
  [/job[^a-z]*title|occupation|position/i, 'title'],
];

const STAMPS = [
  ['check', 'check-square', '✓ Check', 'C'],
  ['cross', 'x-square', '✗ Cross', 'X'],
  ['dot', 'circle', '● Dot', ''],
  ['date', 'calendar', 'Today’s date', 'D'],
  ['initials', 'type', 'Initials', ''],
];

export class FormEditor extends PdfEditor {
  static mode = 'form';

  async load(bytes, opts) {
    this.profile = { ...(this.app.settings.formProfile || {}) };
    await super.load(bytes, opts);
    this.root.classList.add('form-mode');
    this.side.hidden = true;
    this.buildFieldPanel();
    this.props.font = 'Helvetica';
    this.props.size = 11;
    this.props.color = '#0b1f6b';
    if (!this.fields.length) setTimeout(() => toast('No fillable fields — this looks like a scanned form. Click “Type” and then click on a line to write, or drop stamps.', { timeout: 7000 }), 700);
  }

  // =================================================================== field panel

  buildFieldPanel() {
    this.fieldList = h('div', { class: 'form-fieldlist' });
    this.progressBar = h('div', { class: 'vid-progress' }, h('div', { class: 'vid-progress-bar' }));
    this.progressText = h('div', { class: 'mono faint form-progress-text' });
    this.chips = h('div', { class: 'form-chips' });
    this.fpanel = h('div', { class: 'form-panel' },
      h('div', { class: 'panel-head' }, icon('form-fill', 'sm'), 'Form', h('div', { class: 'grow' }),
        h('button', { class: 'icon-btn', 'data-tip': 'Edit my info (used for autofill)', onclick: () => this.editProfile() }, icon('user', 'sm'))),
      h('div', { class: 'form-panel-top' },
        this.progressBar, this.progressText,
        h('div', { class: 'row' },
          h('button', { class: 'btn sm primary', onclick: () => this.autofill() }, icon('wand', 'sm'), 'Autofill'),
          h('button', { class: 'btn sm', onclick: () => this.nextEmpty() }, icon('arrow-down', 'sm'), 'Next empty'))),
      this.fields.length ? this.fieldList : h('div', { class: 'empty-note' }, 'This form has no fillable fields. Use Type and the stamps above the page — or the info chips below — to fill it in.'),
      h('div', { class: 'form-chips-wrap' }, h('div', { class: 'menu-heading' }, 'my info · click, then click the form'), this.chips));
    this.main.prepend(this.fpanel);
    this.renderFieldList();
    this.renderChips();
    this.root.addEventListener('input', (e) => { if (e.target.classList.contains('pdf-field')) this.syncFromPage(e.target); });
    this.root.addEventListener('change', (e) => { if (e.target.classList.contains('pdf-field')) this.syncFromPage(e.target); });
  }

  pretty(name) {
    const parts = name.split('.').map((p) => p.replace(/\[\d+\]$/, '')).filter((p) => p && !/^(topmostSubform|form\d*|page\d*|subform\d*)$/i.test(p));
    let label = parts.pop() || name;
    // short/generic leaf names read better with their parent ("applicant.name" → "Applicant name")
    if (parts.length && (label.length <= 5 || /^(name|text|field|value|date|line\d*|no|number)$/i.test(label))) label = parts.pop() + ' ' + label;
    label = label.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
    return label ? label[0].toUpperCase() + label.slice(1) : name;
  }

  isFilled(f) {
    const v = this.formValues[f.name];
    return f.type === 'check' ? !!v : v != null && String(v).trim() !== '';
  }

  renderFieldList() {
    if (!this.fields.length) return;
    clear(this.fieldList);
    let filled = 0;
    let lastPage = null;
    for (const f of this.fillable) {
      const pageIdx = this.pages.findIndex((p) => p.id === f.widgets[0]?.pageId);
      if (pageIdx !== lastPage) { this.fieldList.append(h('div', { class: 'menu-heading' }, `page ${pageIdx + 1}`)); lastPage = pageIdx; }
      if (this.isFilled(f)) filled++;
      let ctrl;
      const v = this.formValues[f.name];
      if (f.type === 'check') {
        ctrl = h('input', { type: 'checkbox' });
        ctrl.checked = !!v;
        ctrl.addEventListener('change', () => this.setValue(f, ctrl.checked));
      } else if (f.type === 'radio' || f.type === 'dropdown' || f.type === 'list') {
        ctrl = h('select', {}, h('option', { value: '' }, '—'), (f.options.length ? f.options : f.widgets.map((w) => w.onValue)).filter(Boolean).map((o) => h('option', { value: o }, o)));
        ctrl.value = v || '';
        ctrl.addEventListener('change', () => this.setValue(f, ctrl.value));
      } else {
        ctrl = h('input', { type: 'text', value: v || '' });
        ctrl.addEventListener('input', () => this.setValue(f, ctrl.value, true));
      }
      ctrl.addEventListener('focus', () => this.scrollToField(f));
      const row = h('div', { class: `form-field ${this.isFilled(f) ? 'filled' : ''}`, dataset: { name: f.name } },
        h('div', { class: 'form-field-label', title: f.name }, h('span', { class: 'form-dot' }), this.pretty(f.name)), ctrl);
      this.fieldList.append(row);
    }
    const total = this.fillable.length;
    this.progressBar.firstChild.style.width = (total ? (filled / total) * 100 : 0) + '%';
    this.progressText.textContent = `${filled} of ${total} fields filled`;
  }

  /** Fields the user can actually fill (read-only ones are left exactly as the PDF shows them). */
  get fillable() { return (this.fields || []).filter((f) => !f.readOnly); }

  setValue(f, v, keepFocus = false) {
    this.formValues[f.name] = v;
    this.formDirty = true;
    this.markDirty();
    for (const el of this.pagesEl.querySelectorAll(`.pdf-field[data-field="${CSS.escape(f.name)}"]`)) {
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type !== 'radio') el.value = v ?? '';
    }
    if (f.type === 'radio') this.renderAll(); // radios re-render so the right button shows as picked
    if (!keepFocus) this.renderFieldList();
    else this.updateCounts();
  }

  updateCounts() {
    const total = this.fillable.length;
    const filled = this.fillable.filter((f) => this.isFilled(f)).length;
    this.progressBar.firstChild.style.width = (total ? (filled / total) * 100 : 0) + '%';
    this.progressText.textContent = `${filled} of ${total} fields filled`;
    for (const row of this.fieldList.querySelectorAll('.form-field')) {
      const f = this.fields.find((x) => x.name === row.dataset.name);
      if (f) row.classList.toggle('filled', this.isFilled(f));
    }
  }

  syncFromPage(el) {
    const name = el.dataset.field;
    const row = this.fieldList.querySelector(`.form-field[data-name="${CSS.escape(name)}"]`);
    const ctrl = row?.querySelector('input,select');
    if (ctrl) { if (ctrl.type === 'checkbox') ctrl.checked = !!this.formValues[name]; else ctrl.value = this.formValues[name] ?? ''; }
    this.updateCounts();
  }

  scrollToField(f) {
    const w = f.widgets[0];
    const el = this.pageEls.get(w?.pageId);
    if (!el) return;
    const input = el.querySelector(`.pdf-field[data-field="${CSS.escape(f.name)}"]`);
    if (input) {
      const r = input.getBoundingClientRect();
      const sr = this.scroller.getBoundingClientRect();
      if (r.top < sr.top + 40 || r.bottom > sr.bottom - 40) this.scroller.scrollTop += r.top - sr.top - sr.height / 3;
      input.classList.add('flash');
      setTimeout(() => input.classList.remove('flash'), 900);
    }
  }

  nextEmpty() {
    const f = this.fields.find((x) => !this.isFilled(x) && !x.readOnly);
    if (!f) return toast(this.fields.length ? 'Every field has something in it. 🎉' : 'No fillable fields in this form.', { type: 'ok' });
    this.scrollToField(f);
    const el = this.pageEls.get(f.widgets[0].pageId)?.querySelector(`.pdf-field[data-field="${CSS.escape(f.name)}"]`);
    setTimeout(() => el?.focus(), 150);
  }

  // =================================================================== profile & autofill

  derivedProfile() {
    const p = { ...this.profile };
    if (!p.fullName && (p.firstName || p.lastName)) p.fullName = [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ');
    if (p.fullName && !p.firstName) { const parts = p.fullName.trim().split(/\s+/); p.firstName = parts[0]; if (parts.length > 1) p.lastName = parts[parts.length - 1]; }
    p.today = new Date().toLocaleDateString();
    return p;
  }

  async autofill() {
    const p = this.derivedProfile();
    if (!Object.keys(this.profile).some((k) => this.profile[k])) {
      const ok = await this.editProfile();
      if (!ok) return;
      return this.autofill();
    }
    if (!this.fields.length) return toast('Autofill needs a form with fillable fields. For scanned forms, use the info chips.', { timeout: 4000 });
    let n = 0;
    for (const f of this.fields) {
      if (f.type !== 'text' || this.isFilled(f) || f.readOnly) continue;
      const label = f.name.split('.').pop();
      let key = null;
      for (const [re, k] of MATCHERS) if (re.test(label) && p[k]) { key = k; break; }
      if (!key && /date/i.test(label) && !/birth/i.test(label)) key = 'today';
      if (key && p[key]) { this.formValues[f.name] = p[key]; n++; }
    }
    if (n) { this.formDirty = true; this.markDirty(); this.renderAll(); this.renderFieldList(); }
    toast(n ? `Filled ${n} field${n > 1 ? 's' : ''} from your info — double-check them.` : 'Nothing matched your saved info.', { type: n ? 'ok' : 'info' });
  }

  async editProfile() {
    const inputs = {};
    const grid = h('div', { class: 'form-grid' });
    for (const [k, label] of PROFILE_FIELDS) {
      inputs[k] = h('input', { type: 'text', value: this.profile[k] || '' });
      grid.append(h('label', {}, label), inputs[k]);
    }
    const res = await modal({
      title: 'My info', wide: true,
      body: h('div', {}, h('p', { class: 'dim' }, `Saved only on this PC (Box-Deckspitter${BDS.sep}data${BDS.sep}settings.json) and used to autofill forms. Leave anything blank. Don’t store ID numbers here.`), grid),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Save', value: 'ok', primary: true }],
    });
    if (res !== 'ok') return false;
    for (const [k] of PROFILE_FIELDS) this.profile[k] = inputs[k].value.trim();
    this.app.saveSettings({ formProfile: this.profile });
    this.renderChips();
    return true;
  }

  renderChips() {
    const p = this.derivedProfile();
    clear(this.chips);
    const keys = ['fullName', 'firstName', 'lastName', 'dob', 'email', 'phone', 'street', 'city', 'state', 'zip', 'today'];
    let any = false;
    for (const k of keys) {
      if (!p[k]) continue;
      any = true;
      const chip = h('button', { class: 'chip', title: `Click, then click on the form to place “${p[k]}”` }, p[k]);
      chip.addEventListener('click', () => this.armText(p[k]));
      this.chips.append(chip);
    }
    if (!any) this.chips.append(h('button', { class: 'btn sm', onclick: () => this.editProfile() }, icon('user', 'sm'), 'Add my info'));
  }

  // =================================================================== stamps & typed text

  armText(text) {
    this.pendingText = text;
    this.setTool('text');
    toast(`Click where “${text.slice(0, 40)}” should go`, { timeout: 2200 });
  }

  createText(pm, pt) {
    if (this.pendingStamp) return this.placeStamp(pm, pt);
    const preset = this.pendingText;
    this.pendingText = null;
    super.createText(pm, pt);
    if (preset) {
      const a = pm.annots[pm.annots.length - 1];
      if (a && a.type === 'text') {
        a.text = preset;
        const t = this.pageEls.get(pm.id)?._annots.querySelector(`[data-aid="${a.id}"] .pdf-text`);
        if (t) { t.innerText = preset; t.blur(); }
        this.fitTextBox(pm, a);
        this.renderAnnots(pm);
      }
    }
  }

  armStamp(kind) {
    if (kind === 'initials' && !this.app.settings.formInitials) {
      const p = this.derivedProfile();
      const guess = [p.firstName, p.lastName].filter(Boolean).map((s) => s[0].toUpperCase()).join('');
      this.app.saveSettings({ formInitials: guess || 'XX' });
    }
    this.pendingStamp = kind;
    this.setTool('text');
    this.stampBtns?.forEach((b, k) => b.classList.toggle('active', k === kind));
  }

  placeStamp(pm, pt) {
    const kind = this.pendingStamp;
    if (!kind) return;
    const size = kind === 'dot' ? 10 : 13;
    const text = { check: '✓', cross: '✗', dot: '●', date: new Date().toLocaleDateString(), initials: this.app.settings.formInitials || 'XX' }[kind];
    const frame = { x: pt.u - (kind === 'date' || kind === 'initials' ? 2 : size * 0.4), y: pt.v - size * 0.75, w: size * 2, h: size * 1.2 + 4 };
    const raw = boxDispToRaw(frame, pm.w, pm.h, pt.r);
    const a = { id: uid('a'), type: 'text', ...raw, rot: pt.r, text, font: kind === 'check' || kind === 'cross' || kind === 'dot' ? 'Segoe UI' : 'Helvetica', size, color: this.props.color, bold: kind === 'initials' };
    this.change(() => { pm.annots.push(a); }, { pages: [pm] });
    this.fitTextBox(pm, a);
    this.renderAnnots(pm);
    // stamps stay armed so you can tick a whole column of boxes
  }

  get canEditMarks() { return true; }

  setTool(t) {
    if (t !== 'text') { this.pendingStamp = null; this.stampBtns?.forEach((b) => b.classList.remove('active')); }
    super.setTool(t);
  }

  // =================================================================== toolbar / save

  buildToolbar() {
    this.toolBtns = {};
    const tool = (id, ic, tip, key) => { const b = tbButton(ic, tip, () => { this.pendingStamp = null; this.stampBtns?.forEach((x) => x.classList.remove('active')); this.setTool(id); }, { key }); this.toolBtns[id] = b; if (id === this.tool) b.classList.add('active'); return b; };
    this.stampBtns = new Map();
    const stamps = STAMPS.map(([k, ic, tip, key]) => { const b = tbButton(ic, tip, () => this.armStamp(k), { key: key || null }); this.stampBtns.set(k, b); return b; });
    this.propsEl = h('div', { class: 'tb-group pdf-props' });
    const tb = h('div', { class: 'toolbar pdf-toolbar' },
      tbButton('undo', 'Undo', () => this.undo(), { key: 'Ctrl+Z' }),
      tbButton('redo', 'Redo', () => this.redo(), { key: 'Ctrl+Y' }),
      tbSep(),
      tool('select', 'pointer', 'Select & move', 'V'),
      tool('text', 'type', 'Type on the form', 'T'),
      tbSep(),
      ...stamps,
      tbButton('signature', 'Sign', () => this.setTool('signature'), { key: 'S', text: 'Sign' }),
      tool('whiteout', 'whiteout', 'Whiteout', 'W'),
      tbSep(),
      this.propsEl,
      h('div', { class: 'grow' }),
      tbButton('wand', 'Autofill from my info', () => this.autofill(), { text: 'Autofill' }),
      tbButton('arrow-down', 'Next empty field', () => this.nextEmpty()),
      tbSep(),
      tbButton('zoom-out', 'Zoom out', () => this.zoomBy(-1)),
      tbButton('fit-width', 'Fit width', () => this.setZoom('width')),
      tbButton('zoom-in', 'Zoom in', () => this.zoomBy(1)),
      tbSep(),
      tbButton('layers', 'Save a flattened, final copy (fields become plain text)', () => this.saveFinal(), { text: 'Finalize' }),
    );
    this.renderProps();
    return tb;
  }

  onKey(e) {
    if (this.app.active !== this.tab) return;
    const t = e.target;
    if (!t.isContentEditable && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'c') { e.preventDefault(); return this.armStamp('check'); }
      if (k === 'x') { e.preventDefault(); return this.armStamp('cross'); }
      if (k === 'd') { e.preventDefault(); return this.armStamp('date'); }
    }
    return super.onKey(e);
  }

  async saveFinal() {
    const empty = this.fields.filter((f) => !this.isFilled(f) && !f.readOnly).length;
    if (empty && !(await confirmDialog('Finalize form?', `${empty} field${empty > 1 ? 's are' : ' is'} still empty. Save a flattened copy anyway?`, { okLabel: 'Finalize' }))) return;
    try {
      const { bytes } = await buildPdf(this);
      const L = this.PDFLib;
      const doc = await L.PDFDocument.load(bytes);
      try { doc.getForm().flatten(); } catch { /* no form */ }
      const out = await doc.save();
      await this.app.saveBytesAs(out, { defaultName: `${stripExt(this.tab.title)} (completed).pdf`, filters: [{ name: 'PDF document', extensions: ['pdf'] }], title: 'Save final copy' });
    } catch (e) { toast('Could not finalize: ' + e.message, { type: 'error' }); }
  }

  status() {
    const s = super.status();
    if (this.fillable.length) s.left.unshift({ text: `${this.fillable.filter((f) => this.isFilled(f)).length}/${this.fillable.length} filled`, icon: 'form-fill' });
    return s;
  }

  renderAll(keep) {
    super.renderAll(keep);
    if (this.fieldList) this.updateCounts();
  }
}
