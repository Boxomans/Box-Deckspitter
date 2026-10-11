// Page-space helpers. Annotation geometry is stored in "raw" page space:
// unrotated page, origin at the top-left of the visible page box, y pointing down, units = PDF points.

export const PT_TO_PX = 96 / 72;

export function totalRotation(pm) { return (((pm.baseRotate || 0) + (pm.rotate || 0)) % 360 + 360) % 360; }

export function displaySize(pm) {
  const r = totalRotation(pm);
  return r % 180 ? { w: pm.h, h: pm.w } : { w: pm.w, h: pm.h };
}

/** raw → display (display = what you see on screen at rotation r, in points). */
export function rawToDisp(x, y, W, H, r) {
  switch (r) {
    case 90: return [H - y, x];
    case 180: return [W - x, H - y];
    case 270: return [y, W - x];
    default: return [x, y];
  }
}

export function dispToRaw(u, v, W, H, r) {
  switch (r) {
    case 90: return [v, H - u];
    case 180: return [W - u, H - v];
    case 270: return [W - v, u];
    default: return [u, v];
  }
}

export function boxRawToDisp(b, W, H, r) {
  const [x1, y1] = rawToDisp(b.x, b.y, W, H, r);
  const [x2, y2] = rawToDisp(b.x + b.w, b.y + b.h, W, H, r);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export function boxDispToRaw(b, W, H, r) {
  const [x1, y1] = dispToRaw(b.x, b.y, W, H, r);
  const [x2, y2] = dispToRaw(b.x + b.w, b.y + b.h, W, H, r);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export function hexToRgb01(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Smooth-ish SVG path through points. */
export function inkPath(points, map = (p) => p) {
  if (!points.length) return '';
  const pts = points.map(map);
  if (pts.length === 1) return `M${pts[0][0]} ${pts[0][1]} l0.01 0`;
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last[0].toFixed(2)} ${last[1].toFixed(2)}`;
  return d;
}

export const PDF_FONTS = [
  { id: 'Helvetica', label: 'Helvetica', css: 'Helvetica, Arial, sans-serif', std: true },
  { id: 'Times', label: 'Times', css: "'Times New Roman', Times, serif", std: true },
  { id: 'Courier', label: 'Courier', css: "'Courier New', Courier, monospace", std: true },
  { id: 'Arial', label: 'Arial', css: 'Arial, sans-serif' },
  { id: 'Calibri', label: 'Calibri', css: 'Calibri, sans-serif' },
  { id: 'Georgia', label: 'Georgia', css: 'Georgia, serif' },
  { id: 'Verdana', label: 'Verdana', css: 'Verdana, sans-serif' },
  { id: 'Segoe UI', label: 'Segoe UI', css: "'Segoe UI', sans-serif" },
  { id: 'Comic Sans MS', label: 'Comic Sans MS', css: "'Comic Sans MS', cursive" },
  { id: 'Segoe Script', label: 'Segoe Script', css: "'Segoe Script', cursive" },
  { id: 'Ink Free', label: 'Ink Free', css: "'Ink Free', cursive" },
];

export function fontCss(id) { return (PDF_FONTS.find((f) => f.id === id) || PDF_FONTS[0]).css; }
