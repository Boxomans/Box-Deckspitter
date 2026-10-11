// Signature dialog: draw, type, or reuse a saved signature. Resolves with a transparent PNG data URL.

import { h, clear } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { modal } from '../../core/ui.js';

const TYPE_FONTS = ['Segoe Script', 'Ink Free', 'Lucida Handwriting', 'Brush Script MT', 'Freestyle Script', 'Comic Sans MS'];
const INKS = [['#111111', 'Black'], ['#1a3fb0', 'Blue'], ['#0b2a6b', 'Navy'], ['#7a1fa2', 'Purple']];

function trimCanvas(c) {
  const ctx = c.getContext('2d');
  const { width, height } = c;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

export function signatureDialog(app) {
  const saved = Array.isArray(app.settings.signatures) ? app.settings.signatures : [];
  let mode = saved.length ? 'saved' : 'draw';
  let ink = INKS[0][0];
  const W = 600, H = 200, S = 2;

  const pad = h('canvas', { class: 'signature-pad', width: W * S, height: H * S, style: { height: H + 'px' } });
  const ctx = pad.getContext('2d');
  ctx.scale(S, S);
  let drawing = false;
  let last = null;
  let hasInk = false;
  pad.addEventListener('pointerdown', (e) => { drawing = true; pad.setPointerCapture(e.pointerId); last = pos(e); dot(last); });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    for (const ev of e.getCoalescedEvents?.() || [e]) {
      const p = pos(ev);
      const pressure = ev.pressure && ev.pointerType === 'pen' ? ev.pressure : 0.5;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.6 + pressure * 2.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
      hasInk = true;
    }
  });
  pad.addEventListener('pointerup', () => { drawing = false; });
  function pos(e) { const r = pad.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; }
  function dot(p) { ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(p.x, p.y, 1.4, 0, Math.PI * 2); ctx.fill(); hasInk = true; }

  const typeIn = h('input', { type: 'text', placeholder: 'Type your name', value: app.settings.signatureName || app.info?.user || '', style: { width: '100%' } });
  const fontSel = h('select', {}, TYPE_FONTS.map((f) => h('option', { value: f, style: `font-family:'${f}'` }, f)));
  fontSel.value = app.settings.signatureFont || TYPE_FONTS[0];
  const typePreview = h('canvas', { class: 'signature-pad', width: W * S, height: H * S, style: { height: H + 'px', cursor: 'default' } });
  const renderTyped = () => {
    const c = typePreview.getContext('2d');
    c.setTransform(S, 0, 0, S, 0, 0);
    c.clearRect(0, 0, W, H);
    c.fillStyle = ink;
    let size = 64;
    c.font = `${size}px '${fontSel.value}'`;
    while (c.measureText(typeIn.value).width > W - 40 && size > 18) { size -= 2; c.font = `${size}px '${fontSel.value}'`; }
    c.textBaseline = 'middle';
    c.fillText(typeIn.value, 20, H / 2);
  };
  typeIn.addEventListener('input', renderTyped);
  fontSel.addEventListener('change', renderTyped);

  const inkRow = h('div', { class: 'row' }, h('span', { class: 'dim' }, 'Ink'), ...INKS.map(([c, label]) => {
    const b = h('button', { class: 'swatch', title: label, style: { background: c, width: '22px', height: '22px', borderRadius: '50%' } });
    b.addEventListener('click', () => { ink = c; renderTyped(); });
    return b;
  }), h('div', { class: 'grow' }), h('button', { class: 'btn sm ghost', onclick: () => { ctx.clearRect(0, 0, W, H); hasInk = false; } }, icon('eraser', 'sm'), 'Clear'));

  const remember = h('input', { type: 'checkbox', checked: true });
  remember.checked = true;
  const savedList = h('div', { class: 'sig-saved' });
  const body = h('div', { class: 'col' });
  const seg = h('div', { class: 'seg' });
  const tabs = [['saved', 'Saved'], ['draw', 'Draw'], ['type', 'Type']].filter(([m]) => m !== 'saved' || saved.length);
  let choice = null;
  let ctxRef = null;

  const renderSaved = () => {
    clear(savedList);
    saved.forEach((url, i) => {
      const card = h('div', { class: 'sig-card' }, h('img', { src: url, alt: 'signature' }),
        h('button', { class: 'icon-btn', title: 'Forget', onclick: (e) => { e.stopPropagation(); saved.splice(i, 1); app.saveSettings({ signatures: saved }); renderSaved(); } }, icon('trash', 'sm')));
      card.addEventListener('click', () => { choice = url; ctxRef.close('use'); });
      savedList.append(card);
    });
    if (!saved.length) savedList.append(h('div', { class: 'empty-note' }, 'No saved signatures yet.'));
  };

  const show = () => {
    clear(body);
    [...seg.children].forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    if (mode === 'draw') body.append(h('div', { class: 'faint' }, 'Sign with your mouse, trackpad or pen.'), pad, inkRow);
    else if (mode === 'type') { body.append(h('div', { class: 'form-grid' }, h('label', {}, 'Name'), typeIn, h('label', {}, 'Style'), fontSel), typePreview, inkRow); setTimeout(renderTyped, 30); }
    else { body.append(h('div', { class: 'faint' }, 'Click one to place it.'), savedList); renderSaved(); }
  };
  for (const [m, label] of tabs) {
    const b = h('button', { dataset: { m } }, label);
    b.addEventListener('click', () => { mode = m; show(); });
    seg.append(b);
  }
  show();

  return modal({
    title: 'Signature', wide: true,
    body: h('div', { class: 'col' }, seg, body),
    footLeft: h('label', { class: 'check' }, remember, 'Remember for next time'),
    buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Use signature', primary: true, value: 'use' }],
    onOpen: (c) => { ctxRef = c; },
  }).then((res) => {
    if (res !== 'use') return null;
    let url = choice;
    if (!url) {
      if (mode === 'draw') { if (!hasInk) return null; url = trimCanvas(pad); }
      else if (mode === 'type') { if (!typeIn.value.trim()) return null; renderTyped(); url = trimCanvas(typePreview); app.saveSettings({ signatureName: typeIn.value, signatureFont: fontSel.value }); }
      if (url && remember.checked) app.saveSettings({ signatures: [url, ...saved.filter((s) => s !== url)].slice(0, 6) });
    }
    return url;
  });
}
