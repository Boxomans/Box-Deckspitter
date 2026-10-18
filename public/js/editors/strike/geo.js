// Deep Strike's ground: a km grid over the playing field (Europe to the Urals, the Caucasus, Turkey and Iran), the radar horizon,
// and the coastlines, borders and towns from BoxMap's offline world data, cut off at the field's edge.

const WORLD_URL = new URL('../../../assets/map/world.json', import.meta.url).href;
const AIRFIELDS_URL = new URL('../../../assets/strike/airfields.json', import.meta.url).href;

/** The theatre: the box missions are set in (lon/lat). */
export const THEATRE = { lon0: 35.6, lon1: 45.6, lat0: 44.4, lat1: 53.2 };
/** Where the package and the sniffer take off: the theatre's west side. */
export const ORIGIN_SIDE = { lonMax: 36.6 };

const R = 6371, RAD = Math.PI / 180;

/** lon/lat ↔ km east (x) and km south (y) of the theatre's middle; y grows downwards like the screen. Azimuthal
 *  equidistant: distances from the middle are true, and across the whole field they're within a few percent. */
export class Proj {
  constructor(lon0 = (THEATRE.lon0 + THEATRE.lon1) / 2, lat0 = (THEATRE.lat0 + THEATRE.lat1) / 2) {
    this.lon0 = lon0; this.lat0 = lat0;
    this.s0 = Math.sin(lat0 * RAD); this.c0 = Math.cos(lat0 * RAD);
  }
  xy(lon, lat) {
    const p = lat * RAD, dl = (lon - this.lon0) * RAD, sp = Math.sin(p), cp = Math.cos(p), cl = Math.cos(dl);
    const cc = Math.max(-1, Math.min(1, this.s0 * sp + this.c0 * cp * cl)), c = Math.acos(cc);
    const k = c < 1e-9 ? 1 : c / Math.sin(c);
    return [R * k * cp * Math.sin(dl), -R * k * (this.c0 * sp - this.s0 * cp * cl)];
  }
  ll(x, y) {
    const Y = -y, rho = Math.hypot(x, Y);
    if (rho < 1e-9) return [this.lon0, this.lat0];
    const c = rho / R, sc = Math.sin(c), cc = Math.cos(c);
    const lat = Math.asin(cc * this.s0 + (Y * sc * this.c0) / rho) / RAD;
    const lon = this.lon0 + Math.atan2(x * sc, rho * this.c0 * cc - Y * this.s0 * sc) / RAD;
    return [lon, lat];
  }
}

/** The playing field: this outline [lon, lat] (the Atlantic, the Arctic, the Urals, then round Iran and back along the
 *  Mediterranean), minus the countries below, cut out along their real borders. The Urals is the only edge drawn by
 *  hand; everywhere else the field ends at a border or the sea. */
const FIELD_OUTLINE = [
  [-12, 72], [52, 72], [56, 77], [60.6, 70], [65, 68.2], [64, 67], [60, 64], [59.3, 61.5], [59.6, 59], [59, 56.5], [59.3, 54.5], [58.8, 52],
  [58.5, 51.1], [60, 50], [62, 45], [63.5, 38], [63.5, 24.5], [56, 24.5], [50, 24.5], [47, 28.5], [44, 31], [38, 33.5], [36.3, 34.3],
  [35.5, 34.6], [33, 34.4], [22, 34.7], [15.5, 36.4], [12, 37.7], [9.5, 37.6], [-1, 37.4], [-2.2, 36.6], [-4.5, 36.3], [-5.4, 35.97],
  [-6.2, 36.0], [-12, 36.0],
];
const FIELD_EXCLUDE = [
  'Kazakhstan', 'Uzbekistan', 'Turkmenistan', 'Kyrgyzstan', 'Tajikistan', 'Afghanistan', 'Pakistan',
  'Iraq', 'Syria', 'Lebanon', 'Jordan', 'Israel', 'Palestine', 'Kuwait', 'Saudi Arabia', 'Bahrain', 'Qatar', 'United Arab Emirates', 'Oman',
  'Egypt', 'Libya', 'Tunisia', 'Algeria', 'Morocco',
];
/** Bits of excluded countries kept anyway [lon0, lat0, lon1, lat1] (none at the moment). */
const FIELD_KEEP = [];

/** What each mission region covers: whole countries, plus boxes [lon0, lat0, lon1, lat1] for odd islands. */
const REGION_LANDS = {
  west: { countries: ['Russia', 'Ukraine'] },
  nord: { countries: ['Sweden', 'Finland', 'Åland', 'Estonia', 'Latvia', 'Lithuania', 'Belarus'] },
  south: { countries: ['Turkey', 'Romania', 'Greece', 'Bulgaria', 'Georgia', 'Armenia', 'Azerbaijan', 'Iran'] },
  central: { countries: ['Germany', 'Poland', 'Czechia', 'Slovakia', 'Austria', 'Hungary', 'Switzerland', 'Liechtenstein', 'Denmark'] },
  westeu: { countries: ['France', 'United Kingdom', 'Ireland', 'Belgium', 'Netherlands', 'Luxembourg', 'Monaco', 'Jersey', 'Guernsey', 'Isle of Man'] },
  iberia: { countries: ['Spain', 'Portugal', 'Andorra'] },
  adria: { countries: ['Italy', 'San Marino', 'Vatican', 'Slovenia', 'Croatia', 'Bosnia and Herz.', 'Serbia', 'Montenegro', 'Kosovo', 'Albania', 'North Macedonia'] },
};

/** Furthest a radar at hr metres sees something at ht metres over a smooth earth (4/3 earth radius), km. */
export const horizon = (hr, ht) => 4.12 * (Math.sqrt(Math.max(0, hr)) + Math.sqrt(Math.max(0, ht)));

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
/** Closest distance from p to the segment a–b, and how far along it (0..1). */
export function toSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return { d: Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)), t };
}

/** Small seeded random numbers, so a mission is the same each time it's loaded. */
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  next.int = (a, b) => a + Math.floor(next() * (b - a + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.range = (a, b) => a + next() * (b - a);
  return next;
}

let worldCache = null;
/** The coastlines, borders, lakes and towns in and around the theatre, as Path2Ds in km. */
export function loadWorld(proj) {
  return (worldCache ||= (async () => {
    const [w, af] = await Promise.all([fetch(WORLD_URL).then((r) => r.json()), fetch(AIRFIELDS_URL).then((r) => r.json())]);
    const Q = w.q;
    const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
    const inBox = (lon, lat) => lon > -15 && lon < 90 && lat > 24 && lat < 80; // everything that could touch the field
    const ring = (path, d, onPt) => {
      let x = 0, y = 0, pts = [], any = false;
      for (let i = 0; i < d.length; i += 2) {
        x += d[i]; y += d[i + 1];
        const lon = (x / Q) * 360 - 180, lat = latOf(y / Q);
        if (inBox(lon, lat)) any = true;
        pts.push(proj.xy(lon, lat));
      }
      if (!any) return;
      if (onPt) pts.forEach(onPt);
      path.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
      path.closePath();
    };
    const land = new Path2D(), lakes = new Path2D();
    for (const c of w.countries) for (const poly of c.p) for (const d of poly) ring(land, d);
    for (const l of w.lakes) for (const poly of l.p) for (const d of poly) ring(lakes, d);
    const box = (path, [a, b, c, e]) => { [[a, b], [c, b], [c, e], [a, e]].forEach(([lon, lat], i) => { const q = proj.xy(lon, lat); if (i) path.lineTo(q[0], q[1]); else path.moveTo(q[0], q[1]); }); path.closePath(); };
    // the field: the outline (its long straight edges cut in 1° steps, so they curve with the projection) ...
    const outline = new Path2D();
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    const grow = ([x, y]) => { bbox[0] = Math.min(bbox[0], x); bbox[1] = Math.min(bbox[1], y); bbox[2] = Math.max(bbox[2], x); bbox[3] = Math.max(bbox[3], y); };
    FIELD_OUTLINE.forEach(([lon, lat], i) => {
      const [lon2, lat2] = FIELD_OUTLINE[(i + 1) % FIELD_OUTLINE.length];
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(lon2 - lon), Math.abs(lat2 - lat))));
      for (let k = 0; k < n; k++) {
        const p = proj.xy(lon + ((lon2 - lon) * k) / n, lat + ((lat2 - lat) * k) / n);
        grow(p);
        if (i === 0 && k === 0) outline.moveTo(p[0], p[1]); else outline.lineTo(p[0], p[1]);
      }
    });
    outline.closePath();
    // ... minus the excluded countries: a big rectangle with them (and the kept boxes) as even-odd holes
    const borders = new Path2D(), keep = new Path2D(), inland = new Path2D(); // inland: the countries left in
    for (const c of w.countries) for (const poly of c.p) for (const d of poly) ring(FIELD_EXCLUDE.includes(c.n) ? borders : inland, d);
    keep.rect(bbox[0] - 1000, bbox[1] - 1000, bbox[2] - bbox[0] + 2000, bbox[3] - bbox[1] + 2000);
    keep.addPath(borders);
    for (const b of FIELD_KEEP) box(keep, b);
    const regions = {};
    for (const [k, { countries, boxes = [] }] of Object.entries(REGION_LANDS)) {
      const p = (regions[k] = new Path2D());
      for (const c of w.countries.filter((c) => countries.includes(c.n))) for (const poly of c.p) for (const d of poly) ring(p, d);
      for (const b of boxes) box(p, b);
    }
    const field = { outline, keep, borders, inland };
    const places = [];
    for (const [n, lon, lat, rank, pop, cap] of w.places) {
      if (!inBox(lon, lat)) continue;
      const [x, y] = proj.xy(lon, lat);
      if (!inFieldOf(field, x, y)) continue;
      places.push({ n, x, y, lon, lat, rank, pop, cap });
    }
    places.sort((a, b) => b.pop - a.pop);
    const airfields = af.airfields.map((a) => { const [x, y] = proj.xy(a.lon, a.lat); return { ...a, x, y }; });
    return { land, lakes, field, regions, bbox, places, airfields };
  })().catch((e) => { worldCache = null; throw e; }));
}

let probe;
/** Inside the field's outline and not in an excluded country. */
function inFieldOf(field, x, y) {
  probe ||= new OffscreenCanvas(1, 1).getContext('2d');
  return probe.isPointInPath(field.outline, x, y) && probe.isPointInPath(field.keep, x, y, 'evenodd');
}

/** Clip a canvas (already in km) to the field. */
export function clipField(ctx, world) {
  ctx.clip(world.field.outline);
  ctx.clip(world.field.keep, 'evenodd');
}

/** Is this point (km) on dry land in the field: inside a country's outline and not in a lake? Sites never go in the water. */
export function onLand(world, x, y) {
  return inFieldOf(world.field, x, y) && probe.isPointInPath(world.land, x, y, 'evenodd') && !probe.isPointInPath(world.lakes, x, y);
}

/** Is this point (km) inside the playing field (land or sea)? */
export function inField(world, x, y) {
  return inFieldOf(world.field, x, y);
}

/** Is this point (km) on the land of a mission region (REGION_LANDS)? */
export function inRegion(world, region, x, y) {
  return onLand(world, x, y) && probe.isPointInPath(world.regions[region], x, y);
}

/** The nearest town to a point, for naming where something is ("38 km NE of Millerovo"). */
export function whereIs(world, p, minPop = 20000) {
  let best = null, bd = Infinity;
  for (const c of world.places) {
    if (c.pop < minPop) continue;
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < bd) { bd = d; best = c; }
  }
  if (!best) return '';
  if (bd < 6) return `at ${best.n}`;
  const ang = (Math.atan2(p.x - best.x, -(p.y - best.y)) * 180) / Math.PI;
  const dir = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((ang + 360) % 360) / 45) % 8];
  return `${Math.round(bd)} km ${dir} of ${best.n}`;
}
