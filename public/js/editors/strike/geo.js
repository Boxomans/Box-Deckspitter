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

/** The dead zones: salted ground round the old megaton strikes. Each mission makes its own from its seed: two to
 *  four broken rings of strike clusters round the objective, blending into each other, each with its own gaps and
 *  slits to thread. A cluster is one or more overlapping footprints, each a rough polygon of straight cuts, strung out
 *  roughly along its ring. Every footprint sits on land inside the field (lakes are fine), so coasts stay open. Radiation adds up over the whole flight: STORM_S
 *  seconds in a radiation storm kills a crew, DEAD_S in an ordinary dead zone, and the two count together. */
export const STORM_S = 600, DEAD_S = 1200;
/** How much of a lethal dose a second in this zone gives. */
export const doseRate = (z) => 1 / (z.storm ? STORM_S : DEAD_S);

/** Dry land or a lake, inside the field: where a footprint may lie. */
function onGround(world, x, y) {
  return inFieldOf(world.field, x, y) && probe.isPointInPath(world.land, x, y, 'evenodd');
}

/** Where the origin may be dragged to: an arc round the objective, `half` radians either side of bearing `a`, r km out. */
export const ARC_HALF = Math.PI / 3;
/** The point of a mission's origin arc at bearing a (clamped to the arc). */
export function arcPoint(primary, arc, a) {
  const d = Math.max(-arc.half, Math.min(arc.half, Math.atan2(Math.sin(a - arc.a), Math.cos(a - arc.a))));
  return { x: primary.x + Math.cos(arc.a + d) * arc.r, y: primary.y + Math.sin(arc.a + d) * arc.r };
}
/** How far a point is from the origin arc. */
export function arcDist(p, primary, arc) {
  return dist(p, arcPoint(primary, arc, Math.atan2(p.y - primary.y, p.x - primary.x)));
}

/** The mission's dead zones (see above): primary {x, y} and the origin's arc; nothing covers the objective or any
 *  point the origin can be dragged to. */
export function makeZones(world, r, primary, arc, big) {
  const zones = [], od = arc.r;
  const q = (v) => Math.round(v * 10) / 10;
  // one strike's footprint round (x, y), stretched along `wind`: every 8 km of its edge on ground and clear of the
  // origin's arc and the objective, or null
  const footprint = (x, y, rad, stretch, wind) => {
    const n = r.int(7, 11), pts = [], cw = Math.cos(wind), sw = Math.sin(wind);
    for (let i = 0; i < n; i++) {
      const t = ((i + r.range(-0.3, 0.3)) / n) * Math.PI * 2, k = rad * r.range(0.7, 1.1);
      const u = Math.cos(t) * k * stretch, v = (Math.sin(t) * k) / stretch;
      pts.push([q(x + u * cw - v * sw), q(y + u * sw + v * cw)]);
    }
    const far = rad * 1.1 * stretch;
    if (arcDist({ x, y }, primary, arc) < far + 30 || Math.hypot(primary.x - x, primary.y - y) < far + 20) return null;
    const ok = pts.every((p, i) => {
      const e = pts[(i + 1) % n], k = Math.max(1, Math.ceil(Math.hypot(e[0] - p[0], e[1] - p[1]) / 8));
      for (let j = 0; j < k; j++) if (!onGround(world, p[0] + ((e[0] - p[0]) * j) / k, p[1] + ((e[1] - p[1]) * j) / k)) return false;
      return true;
    });
    return ok ? { x: q(x), y: q(y), r: q(far), pts } : null;
  };
  // a cluster: the first strike at (x, y), the rest overlapping one already there, mostly strung out along the wind
  const cluster = (x, y, want, rMin, rMax, wind, storm) => {
    const parts = [];
    for (let k = 0; parts.length < want && k < want * 6; k++) {
      const at = parts.length ? r.pick(parts) : null, rad = r.range(rMin, rMax);
      let px = x, py = y;
      if (at) {
        const d = (at.r + rad) * r.range(0.35, 0.7), ang = wind + (r() < 0.75 ? r.range(-0.4, 0.4) : r.range(0, Math.PI * 2)) + (r() < 0.5 ? Math.PI : 0);
        px = at.x + Math.cos(ang) * d; py = at.y + Math.sin(ang) * d;
      } else if (!onGround(world, x, y)) return;
      const f = footprint(px, py, rad, r.range(1.05, r() < 0.3 ? 2 : 1.45), wind);
      if (f) parts.push(f);
    }
    if (!parts.length) return;
    let far = 0;
    for (const f of parts) for (const p of f.pts) far = Math.max(far, Math.hypot(p[0] - x, p[1] - y));
    zones.push({ x: q(x), y: q(y), r: q(far), parts, storm });
  };
  // the rings: two or three (three or four on a large mission) from just outside the objective outwards, each wandering
  // in and out so they blend into each other, with clusters bridging between them in places; each ring has its own
  // one or two gaps, so getting in means weaving from one to the next
  const rings = big ? r.int(3, 4) : r.int(2, 3), step = r.range(70, 95);
  for (let ri = 0; ri < rings; ri++) {
    const R0 = r.range(65, 90) + ri * step;
    if (R0 > od - 120) break;
    const gaps = [];
    for (let i = r() < 0.5 ? 1 : 2; i > 0; i--) gaps.push({ a: r() * Math.PI * 2, w: r.range(22, 38) / R0 }); // half-widths, radians
    const inGap = (a) => gaps.some((g) => Math.abs(Math.atan2(Math.sin(a - g.a), Math.cos(a - g.a))) < g.w);
    const wob = [r.range(10, 28), r.int(2, 4), r() * 7, r.range(5, 14), r.int(5, 8), r() * 7];
    const Rat = (a) => R0 + wob[0] * Math.sin(wob[1] * a + wob[2]) + wob[3] * Math.sin(wob[4] * a + wob[5]);
    for (let a = r() * 0.5; a < Math.PI * 2; ) {
      const size = r.range(22, 40), R = Rat(a) + r.range(-10, 10);
      if (!inGap(a)) {
        cluster(primary.x + Math.cos(a) * R, primary.y + Math.sin(a) * R, r.int(2, 4), size * 0.6, size, a + Math.PI / 2 + r.range(-0.4, 0.4), r() < 0.3);
        // a bridge out toward the next ring (or in toward the last), so the rings run into each other
        if (r() < 0.3) { const R2 = R + (r() < 0.65 ? 1 : -1) * step * r.range(0.4, 0.6); cluster(primary.x + Math.cos(a) * R2, primary.y + Math.sin(a) * R2, r.int(1, 3), size * 0.5, size * 0.85, a + r.range(-0.5, 0.5), r() < 0.3); }
      }
      a += (size * r.range(1.4, 1.8)) / R; // a little under a cluster's width on, so neighbours run together
    }
  }
  return zones;
}

/** Is (x, y) inside this polygon [[x, y], ...]? */
function inPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The dead zone (of these) a point (km) is in, or null. */
export function zoneAt(zones, x, y) {
  let hit = null; // a storm wins where it overlaps a dead zone
  for (const z of zones || []) if ((!hit || z.storm) && Math.hypot(z.x - x, z.y - y) <= z.r && z.parts.some((f) => inPoly(f.pts, x, y))) { hit = z; if (z.storm) break; }
  return hit;
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
