// BoxMap: a map that works offline. The whole world is always there (countries, borders, coastlines, lakes and
// about 7,000 cities, from Natural Earth, shipped with the app); for street-level detail, pick an area and download
// it (OpenStreetMap vector tiles, cut out by map-server.js), and that area keeps every street, building, park and
// name with no connection at all. Optionally, while online, places without a download show OpenStreetMap's own
// tiles (kept on disk once seen). Search, pins with notes, and a distance tool. It opens on the whole world.

import { BaseEditor } from './base.js';
import { h, clear, clamp, debounce, formatBytes } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { tbButton, tbSep, toast, errorToast, showMenu, contextMenu, modal, promptDialog, confirmDialog } from '../core/ui.js';
import { decodeTile } from '../core/mvt.js';

const WORLD_URL = new URL('../../assets/map/world.json', import.meta.url).href;
/** Where a country's name goes when the data's own spot is a poor one: [lon, lat]. */
const LABEL_AT = { Russia: [96, 62] };
// the city list spells some countries differently from the country names
const COUNTRY_AS = { 'Congo (Kinshasa)': 'Dem. Rep. Congo', 'Congo (Brazzaville)': 'Congo', 'Bosnia and Herzegovina': 'Bosnia and Herz.',
  'Dominican Republic': 'Dominican Rep.', 'Central African Republic': 'Central African Rep.', 'Ivory Coast': "Côte d'Ivoire",
  'The Bahamas': 'Bahamas', 'The Gambia': 'Gambia', 'East Timor': 'Timor-Leste', 'Equatorial Guinea': 'Eq. Guinea',
  'Guinea Bissau': 'Guinea-Bissau', 'Solomon Islands': 'Solomon Is.' };
const MAX_Z = 19;
const TILE_LRU = 360;
const DETAIL = [
  [15, 'Every street, building and shop'],
  [14, 'Streets and buildings'],
  [12, 'Main roads and towns'],
  [10, 'Highways and cities'],
];

// web mercator in world units (0..1 both ways)
const mx = (lon) => (lon + 180) / 360;
const my = (lat) => { const s = Math.sin((clamp(lat, -85.0511, 85.0511) * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
/** A world x brought back into 0–1 (the map repeats east and west). */
const wrap1 = (x) => x - Math.floor(x);
const lonOf = (x) => wrap1(x) * 360 - 180;
const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
function haversine(a, b) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : m < 10000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m / 1000).toLocaleString()} km`);
const fmtDeg = (v, pos, neg) => `${Math.abs(v).toFixed(5)}° ${v >= 0 ? pos : neg}`;

const PALETTE = {
  light: {
    sea: '#aad3df', land: '#f2efe9', tints: ['#efe9dc', '#e9eedd', '#f1e4e0', '#e3e9ef', '#eee6ee', '#f2ecd6', '#e5eee8'],
    border: '#9b8aa8', state: '#c3b6c9', coast: '#8fb8c9', water: '#aad3df', river: '#9ccbdc',
    park: '#cfe8b8', wood: '#bfdca8', grass: '#dcecc8', sand: '#f2e8c4', ice: '#f4f8fb', urban: '#ebe6dd', farm: '#eef0d9', other: '#e8e2da', cemetery: '#d6e3cc', industrial: '#e6dfe6', hospital: '#f4dedc', school: '#f2ecd2',
    building: '#d9d0c6', buildingLine: '#c8beb3',
    casing: '#c9bfb2', highway: '#f7c47b', highwayCase: '#d79a4a', major: '#fde9a6', medium: '#ffffff', minor: '#ffffff', path: '#b8a99a', rail: '#9a9a9a',
    text: '#2f2a26', textSoft: '#5d5650', halo: 'rgba(255,255,255,0.9)', waterText: '#3f7590', region: '#7a52a0',
  },
  dark: {
    sea: '#121d29', land: '#24272c', tints: ['#2b2e33', '#283029', '#312a2c', '#272d35', '#2e2933', '#302e2a', '#28302f'],
    border: '#6b5d86', state: '#3e3a48', coast: '#2c4558', water: '#1b2b39', river: '#22394b',
    park: '#22362a', wood: '#1f3326', grass: '#24302a', sand: '#302e26', ice: '#2c3237', urban: '#26282c', farm: '#262a25', other: '#26272a', cemetery: '#24302a', industrial: '#29262c', hospital: '#2f2729', school: '#2d2b25',
    building: '#30333a', buildingLine: '#3a3e46',
    casing: '#16171a', highway: '#8a6a3e', highwayCase: '#4f3c25', major: '#625b45', medium: '#4b4e56', minor: '#3d4047', path: '#5a5a5e', rail: '#5c5c62',
    text: '#e6e3df', textSoft: '#aaa5a0', halo: 'rgba(16,17,20,0.88)', waterText: '#7fb0c8', region: '#b79be0',
  },
};
const LANDUSE = {
  park: 'park', national_park: 'park', nature_reserve: 'park', garden: 'park', playground: 'park', golf_course: 'park', zoo: 'park', recreation_ground: 'park', pitch: 'park', dog_park: 'park', village_green: 'park',
  forest: 'wood', wood: 'wood', protected_area: 'park', grassland: 'grass', grass: 'grass', meadow: 'grass', scrub: 'grass', allotments: 'grass', farmland: 'farm', farmyard: 'farm', orchard: 'farm', vineyard: 'farm',
  beach: 'sand', sand: 'sand', barren: 'sand', glacier: 'ice', urban_area: 'urban', residential: 'urban', cemetery: 'cemetery', grave_yard: 'cemetery',
  industrial: 'industrial', railway: 'industrial', military: 'industrial', aerodrome: 'industrial', runway: 'industrial', taxiway: 'industrial', apron: 'industrial',
  pedestrian: 'urban', pier: 'urban', platform: 'industrial', hospital: 'hospital', school: 'school', university: 'school', college: 'school', kindergarten: 'school',
};
/** Antarctica's territorial claims, south of 60°S, as sectors between meridians [west lon, east lon] (none crosses the
 *  date line: the Ross Dependency is in two). The Antarctic Treaty (1959) freezes them: not recognised, not given up. */
const CLAIMS = [
  { who: 'Norway', name: 'Queen Maud Land', span: '20°W – 44°38′E', year: 1939, color: '#d9534f', at: [12, -76], s: [[-20, 44.633]],
    info: 'Norway also claims Peter I Island, off Marie Byrd Land (1931). Troll station is inland.' },
  { who: 'Australia', name: 'Australian Antarctic Territory', span: '44°38′E – 136°11′E, 142°02′E – 160°E', year: 1933, color: '#e0a030', at: [90, -76], s: [[44.633, 136.183], [142.033, 160]],
    info: 'The largest claim, about 42% of the continent, in two parts either side of Adélie Land. Mawson, Davis and Casey stations.' },
  { who: 'France', name: 'Adélie Land', span: '136°11′E – 142°02′E', year: 1924, color: '#4f7fd9', at: [139.1, -70], s: [[136.183, 142.033]],
    info: 'A thin slice between the two parts of Australia’s claim. Dumont d’Urville station is on its coast.' },
  { who: 'New Zealand', name: 'Ross Dependency', span: '160°E – 150°W', year: 1923, color: '#3aa58a', at: [-178, -80], s: [[160, 180], [-180, -150]],
    info: 'Takes in most of the Ross Ice Shelf. Scott Base, with the United States’ McMurdo Station next door.' },
  { who: null, name: 'Marie Byrd Land', span: '150°W – 90°W', year: null, color: '#8a8f98', at: [-120, -78], s: [[-150, -90]],
    info: 'Claimed by no one: the largest unclaimed land on Earth.' },
  { who: 'Chile', name: 'Chilean Antarctic Territory', span: '90°W – 53°W', year: 1940, color: '#c94fc0', at: [-80, -72], s: [[-90, -53]],
    info: 'Overlaps Argentina’s and Britain’s claims on the Antarctic Peninsula. Villa Las Estrellas, at Frei station, has families living year-round.' },
  { who: 'Argentina', name: 'Argentine Antarctica', span: '74°W – 25°W', year: 1943, color: '#5bb3e0', at: [-38, -76], s: [[-74, -25]],
    info: 'Overlaps Chile’s and Britain’s claims. Esperanza Base, near the peninsula’s tip, has had children born there.' },
  { who: 'United Kingdom', name: 'British Antarctic Territory', span: '80°W – 20°W', year: 1908, color: '#9b7be0', at: [-50, -82], s: [[-80, -20]],
    info: 'The oldest claim, overlapping both Chile’s and Argentina’s. Rothera and Halley stations.' },
];
const claimsAt = (lon, lat) => (lat > -60 ? [] : CLAIMS.filter((c) => c.s.some(([a, b]) => lon >= a && lon < b)));
/** The tiny joke at 69°N 69°W: 200 m across, so it only shows zoomed far in. */
const NICE = { lon: -69, lat: 69, text: 'Nice.', metres: 200 };

const ROAD_W = { highway: 3.6, major_road: 2.8, medium_road: 2.2, minor_road: 1.5, other: 1.1, path: 0.9 };

export class MapEditor extends BaseEditor {
  static mode = 'map';

  async load() {
    this.view = { cx: 0.5, cy: 0.45, z: 1.6 };
    this.tiles = new Map(); // "z/x/y" → { state, data, used }
    this.raster = new Map(); // OSM: "z/x/y" → { state, img, used }
    this.queue = [];
    this.loading = 0;
    this.regions = [];
    this.pins = [];
    this.settings = { osm: true };
    this.mode = null; // 'area' | 'measure'
    this.measure = [];
    this.jobs = [];
    this.buildUI();
    this.applyTheme();
    this.loadWorld();
    try {
      const [r, p] = await Promise.all([api.get('/api/map/regions'), api.get('/api/map/pins')]);
      this.regions = r.regions || [];
      this.pins = p.pins || [];
      this.settings = { osm: true, ...(p.settings || {}) };
      const v = this.settings.view;
      if (v && Number.isFinite(v.z)) this.view = { cx: clamp(+v.cx, 0, 1), cy: clamp(+v.cy, 0, 1), z: clamp(+v.z, 0, MAX_Z) };
    } catch (e) { errorToast(e); }
    this.renderPanel();
    this.draw();
  }

  async loadWorld() {
    try {
      const w = await fetch(WORLD_URL).then((r) => r.json());
      const Q = w.q;
      const ring = (p, d) => {
        let x = 0, y = 0;
        for (let i = 0; i < d.length; i += 2) { x += d[i]; y += d[i + 1]; if (i === 0) p.moveTo(x, y); else p.lineTo(x, y); }
      };
      const tint = Array.from({ length: 7 }, () => new Path2D());
      const borders = new Path2D(), lakes = new Path2D(), states = new Path2D();
      const countries = [];
      for (const c of w.countries) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, land = 0;
        for (const poly of c.p) {
          for (const d of poly) { ring(tint[(c.c - 1 + 7) % 7], d); ring(borders, d); }
          let x = 0, y = 0;
          let a = 0, px = 0, py = 0;
          for (let i = 0; i < poly[0].length; i += 2) {
            x += poly[0][i]; y += poly[0][i + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            if (i) a += px * y - x * py;
            px = x; py = y;
          }
          land += Math.abs(a) / 2;
        }
        // Natural Earth puts this name in its far west, in among Europe's names; further east has the room
        const [lx, ly] = LABEL_AT[c.n] || c.l;
        countries.push({ n: c.n, r: c.r, x: mx(lx), y: my(ly), box: [x0 / Q, y0 / Q, x1 / Q, y1 / Q], land: land / Q / Q });
      }
      for (const l of w.lakes) for (const poly of l.p) for (const d of poly) ring(lakes, d);
      const named = new Set(countries.map((c) => c.n));
      for (const d of w.states) ring(states, d);
      const places = w.places.map(([n, lon, lat, rank, pop, cap, country]) => ({ n, x: mx(lon), y: my(lat), rank, pop, cap,
        country: named.has(COUNTRY_AS[country] || country) ? COUNTRY_AS[country] || country : null }))
        .sort((a, b) => (b.cap - a.cap) || (a.rank - b.rank) || (b.pop - a.pop));
      this.world = { Q, tint, borders, lakes, states, countries, places };
    } catch (e) { errorToast(e, 'The world map didn’t load'); }
    this.draw();
  }

  // ================================================================ UI

  buildToolbar() {
    this.searchIn = h('input', { class: 'mp-search', type: 'search', placeholder: 'Search places…', spellcheck: 'false',
      oninput: () => this.searchSoon(), onkeydown: (e) => this.searchKey(e), onfocus: () => this.searchSoon() });
    this.areaBtn = tbButton('download', 'Download an area to use offline (drag a box on the map)', () => this.startArea(), { text: 'Download area' });
    this.measureBtn = tbButton('ruler', 'Measure a distance (click points; Esc to stop)', () => this.toggleMeasure());
    this.panelBtn = tbButton('sidebar', 'Downloaded maps and pins', () => this.togglePanel());
    return h('div', { class: 'toolbar' },
      h('div', { class: 'mp-searchwrap' }, icon('search', 'sm'), this.searchIn),
      tbSep(),
      this.areaBtn, this.panelBtn,
      tbSep(),
      tbButton('map-pin', 'Drop a pin in the middle of the map', () => this.addPin(this.view.cx, this.view.cy)),
      this.measureBtn,
      tbSep(),
      tbButton('zoom-in', 'Zoom in (+)', () => this.zoomBy(1)), tbButton('zoom-out', 'Zoom out (−)', () => this.zoomBy(-1)),
      tbButton('globe', 'Show the whole world', () => this.flyTo(0.5, 0.45, this.fitZoom())),
      tbButton('more', 'Map options', (e) => showMenu(this.optionsMenu(), { anchor: e.currentTarget })),
      h('span', { class: 'tb-label' }, 'map'));
  }

  optionsMenu() {
    return [
      { label: 'Show OpenStreetMap streets while online', checked: this.settings.osm !== false, action: () => { this.settings.osm = this.settings.osm === false; this.saveSettings(); this.draw(); } },
      { label: 'Show Antarctic claims (hover one to see whose)', checked: this.settings.claims !== false, action: () => { this.settings.claims = this.settings.claims === false; this.saveSettings(); this.hideClaim(); this.draw(); } },
      { label: 'Show the outlines of downloaded maps', checked: !!this.settings.outlines, action: () => { this.settings.outlines = !this.settings.outlines; this.saveSettings(); this.draw(); } },
      { sep: true },
      { label: 'Clear the online street cache from memory', icon: 'refresh', action: () => { this.raster.clear(); this.draw(); } },
    ];
  }

  buildUI() {
    this.cv = h('canvas', { class: 'mp-canvas' });
    this.results = h('div', { class: 'mp-results', hidden: true });
    this.coordsEl = h('span', { class: 'mono' });
    this.zoomEl = h('span', { class: 'mono' });
    this.attrib = h('div', { class: 'mp-attrib' }, 'Natural Earth · © OpenStreetMap contributors');
    this.hint = h('div', { class: 'mp-hint', hidden: true });
    this.popEl = h('div', { class: 'mp-pop', hidden: true });
    this.claimTip = h('div', { class: 'mp-claim-tip', hidden: true });
    this.panel = h('div', { class: 'mp-panel', hidden: true });
    this.wrap = h('div', { class: 'mp-wrap', tabindex: '0' }, this.cv, this.hint, this.popEl, this.claimTip, this.attrib, this.results);
    this.root = h('div', { class: 'mp' }, h('div', { class: 'mp-main' }, this.wrap, this.panel),
      h('div', { class: 'mp-bar' }, icon('map-pin', 'sm'), this.coordsEl, h('div', { class: 'grow' }), this.zoomEl));
    this.pane.append(this.root);
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.wrap);
    this.themeObs = new MutationObserver(() => { this.applyTheme(); this.draw(); });
    this.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    this.wire();
  }

  applyTheme() {
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue('--bg-0').trim() || '#111';
    const c = document.createElement('canvas').getContext('2d');
    c.fillStyle = bg;
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c.fillStyle);
    const lum = m ? (0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16)) / 255 : 0;
    this.pal = lum > 0.5 ? PALETTE.light : PALETTE.dark;
    this.accent = cs.getPropertyValue('--accent').trim() || '#b3a1f2';
    this.font = getComputedStyle(document.body).fontFamily || 'sans-serif';
  }

  // ================================================================ view

  get W() { return this.cv.clientWidth || 1; }
  get H() { return this.cv.clientHeight || 1; }
  scale(z = this.view.z) { return 256 * 2 ** z; }
  toScreen(x, y) { const S = this.scale(); return [(x - this.view.cx) * S + this.W / 2, (y - this.view.cy) * S + this.H / 2]; }
  toWorld(px, py) { const S = this.scale(); return [this.view.cx + (px - this.W / 2) / S, this.view.cy + (py - this.H / 2) / S]; }
  /** The copy of world x nearest the middle of the screen. */
  nearX(x) { return x + Math.round(this.view.cx - x); }
  /** Which copies of the world the screen shows (…, -1, 0, 1, …: the map repeats east and west). */
  copies() {
    const x0 = this.toWorld(0, 0)[0], x1 = this.toWorld(this.W, 0)[0];
    const out = [];
    for (let c = Math.floor(x0); c <= Math.floor(x1) && out.length < 8; c++) out.push(c);
    return out;
  }
  /** Run fn with the view moved so that copy c of the world is where the screen shows it. */
  inCopy(c, fn) {
    const v = this.view;
    this.view = { ...v, cx: v.cx - c };
    try { fn(); } finally { this.view = v; }
  }
  fitZoom() { return Math.max(0, Math.log2(Math.min(this.W, this.H * 1.2) / 256)); }
  minZoom() { return Math.max(0, Math.log2(Math.min(this.W, this.H) / 256) - 0.5); }

  setView(cx, cy, z) {
    z = clamp(z, this.minZoom(), MAX_Z);
    const S = this.scale(z);
    const halfH = this.H / 2 / S;
    this.view = {
      // east–west the world goes round (kept within one turn of it); north–south it stops at the edges
      cx: wrap1(cx),
      cy: halfH >= 0.5 ? 0.5 : clamp(cy, halfH, 1 - halfH),
      z,
    };
    this.draw();
    this.saveViewSoon();
  }
  zoomAt(px, py, dz) {
    const [wx, wy] = this.toWorld(px, py);
    const z = clamp(this.view.z + dz, this.minZoom(), MAX_Z);
    const S = this.scale(z);
    this.setView(wx - (px - this.W / 2) / S, wy - (py - this.H / 2) / S, z);
  }
  zoomBy(dz) { this.flyTo(this.view.cx, this.view.cy, this.view.z + dz, 220); }
  flyTo(cx, cy, z, ms = 650) {
    cancelAnimationFrame(this.anim);
    const a = { ...this.view }, t0 = performance.now();
    z = clamp(z, this.minZoom(), MAX_Z);
    cx = this.nearX(cx); // the short way round
    // zoom out a little on long trips so it reads as a move, not a cut
    const far = Math.hypot(cx - a.cx, cy - a.cy) * 2 ** Math.min(a.z, z);
    const dip = far > 2 ? Math.min(4, Math.log2(far)) : 0;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const zz = a.z + (z - a.z) * e - dip * Math.sin(Math.PI * e);
      // move in screen-proportional steps so the target doesn't race off at high zoom
      this.setView(a.cx + (cx - a.cx) * e, a.cy + (cy - a.cy) * e, zz);
      if (k < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }
  fitBox([x0, y0, x1, y1], pad = 40) {
    const z = Math.log2(Math.min((this.W - pad * 2) / Math.max(1e-9, x1 - x0), (this.H - pad * 2) / Math.max(1e-9, y1 - y0)) / 256);
    this.flyTo((x0 + x1) / 2, (y0 + y1) / 2, Math.min(z, 17));
  }
  bboxToBox(b) { return [mx(b[0]), my(b[3]), mx(b[2]), my(b[1])]; }
  saveViewSoon = debounce(() => { this.settings.view = { ...this.view }; this.saveSettings(); }, 1200);
  saveSettings() { api.post('/api/map/settings', this.settings).catch(() => {}); }

  // ================================================================ input

  wire() {
    const cv = this.cv;
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.wrap.focus({ preventScroll: true });
      this.hideResults();
      const r = cv.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      cancelAnimationFrame(this.anim);
      if (this.mode === 'area') {
        const [wx, wy] = this.toWorld(px, py);
        this.areaBox = [wx, wy, wx, wy];
        drag = { kind: 'area' };
      } else {
        const pin = this.pinAt(px, py);
        drag = { kind: 'pan', x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy, moved: false, pin };
      }
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const [wx, wy] = this.toWorld(px, py);
      this.coordsEl.textContent = `${fmtDeg(latOf(wy), 'N', 'S')}, ${fmtDeg(lonOf(wx), 'E', 'W')}`;
      this.mouse = [px, py];
      if (this.mode === 'measure' && this.measure.length) this.draw();
      if (!drag) { cv.style.cursor = this.mode ? 'crosshair' : this.pinAt(px, py) ? 'pointer' : 'grab'; this.hoverClaim(px, py, lonOf(wx), latOf(wy)); return; }
      this.hideClaim();
      if (drag.kind === 'area') { this.areaBox[2] = wx; this.areaBox[3] = wy; this.draw(); return; }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      cv.style.cursor = 'grabbing';
      const S = this.scale();
      this.setView(drag.cx - dx / S, drag.cy - dy / S, this.view.z);
      this.placePop();
    });
    const up = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      const r = cv.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      if (d.kind === 'area') { this.finishArea(); return; }
      cv.style.cursor = 'grab';
      if (d.moved) return;
      const [wx, wy] = this.toWorld(px, py);
      if (this.mode === 'measure') { this.measure.push({ x: wx, y: wy }); this.draw(); return; }
      if (d.pin) this.openPin(d.pin); else this.closePop();
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', () => { drag = null; });
    cv.addEventListener('pointerleave', () => this.hideClaim());
    cv.addEventListener('dblclick', (e) => {
      if (this.mode) return;
      const r = cv.getBoundingClientRect();
      const [wx, wy] = this.toWorld(e.clientX - r.left, e.clientY - r.top);
      const z = this.view.z + (e.shiftKey ? -1 : 1);
      const S = this.scale(z);
      this.flyTo(wx - (e.clientX - r.left - this.W / 2) / S, wy - (e.clientY - r.top - this.H / 2) / S, z, 250);
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      cancelAnimationFrame(this.anim);
      const r = cv.getBoundingClientRect();
      const dz = clamp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022), -1, 1);
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, dz);
      this.placePop();
    }, { passive: false });
    cv.addEventListener('contextmenu', (e) => {
      const r = cv.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      if (this.mode === 'measure') { e.preventDefault(); this.toggleMeasure(false); return; }
      const [wx, wy] = this.toWorld(px, py);
      const pin = this.pinAt(px, py);
      const lat = latOf(wy).toFixed(6), lon = lonOf(wx).toFixed(6);
      contextMenu(e, [
        ...(pin ? [
          { label: 'Edit this pin', icon: 'edit', action: () => this.openPin(pin) },
          { label: 'Remove this pin', icon: 'trash', action: () => this.removePin(pin) },
          { sep: true },
        ] : []),
        { label: 'Drop a pin here', icon: 'map-pin', action: () => this.addPin(wx, wy) },
        { label: 'Measure from here', icon: 'ruler', action: () => { this.toggleMeasure(true); this.measure = [{ x: wx, y: wy }]; this.draw(); } },
        { label: 'Zoom in here', icon: 'zoom-in', action: () => { const z = this.view.z + 2; this.flyTo(wx, wy, z, 300); } },
        { sep: true },
        { label: 'Download the map of what’s on screen…', icon: 'download', action: () => { const [x0, y0] = this.toWorld(0, 0), [x1, y1] = this.toWorld(this.W, this.H); this.areaBox = [x0, y0, x1, y1]; this.finishArea(); } },
        { label: `Copy ${lat}, ${lon}`, icon: 'copy', action: () => navigator.clipboard.writeText(`${lat}, ${lon}`).then(() => toast('Copied')) },
      ]);
    });
    this.wrap.addEventListener('keydown', (e) => {
      if (e.target !== this.wrap) return;
      const S = this.scale(), step = 120 / S;
      const k = e.key;
      if (k === 'Escape') { if (this.mode === 'area') this.stopArea(); else if (this.mode === 'measure') this.toggleMeasure(false); else this.closePop(); }
      else if (k === '+' || k === '=') this.zoomBy(1);
      else if (k === '-' || k === '_') this.zoomBy(-1);
      else if (k === 'ArrowLeft') this.setView(this.view.cx - step, this.view.cy, this.view.z);
      else if (k === 'ArrowRight') this.setView(this.view.cx + step, this.view.cy, this.view.z);
      else if (k === 'ArrowUp') this.setView(this.view.cx, this.view.cy - step, this.view.z);
      else if (k === 'ArrowDown') this.setView(this.view.cx, this.view.cy + step, this.view.z);
      else if (k === 'Backspace' && this.mode === 'measure') { this.measure.pop(); this.draw(); }
      else return;
      e.preventDefault();
    });
  }

  handlesKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); this.searchIn.focus(); this.searchIn.select(); return true; }
    return false;
  }
  find() { this.searchIn.focus(); this.searchIn.select(); }

  // ================================================================ drawing

  draw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
  }

  paint() {
    const cv = this.cv, dpr = window.devicePixelRatio || 1;
    const W = this.W, H = this.H;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const S = this.scale();
    const ctx = cv.getContext('2d');
    const P = this.pal;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = P.sea;
    ctx.fillRect(0, 0, W, H);
    const oy = H / 2 - this.view.cy * S;
    const z = this.view.z;
    this.labels = [];
    this.wantTiles = [];
    this.rasterShown = false;
    const w = this.world;
    // the world repeats left and right (across the date line the land runs on): each copy on screen is drawn in turn
    const copies = this.copies();
    for (const c of copies) this.inCopy(c, () => {
      const ox = W / 2 - this.view.cx * S;
      // 1. the built-in world
      if (w) {
        const k = S / w.Q;
        ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
        w.tint.forEach((p, i) => { ctx.fillStyle = P.tints[i]; ctx.fill(p); });
        ctx.fillStyle = P.water; ctx.fill(w.lakes);
        ctx.lineJoin = 'round';
        if (z > 3) { ctx.strokeStyle = P.state; ctx.lineWidth = 0.7 / k; ctx.setLineDash([3 / k, 2.5 / k]); ctx.stroke(w.states); ctx.setLineDash([]); }
        ctx.strokeStyle = P.border; ctx.lineWidth = (z < 3 ? 0.6 : 0.9) / k; ctx.stroke(w.borders);
      }
      // 2. OpenStreetMap tiles while online (where nothing is downloaded)
      if (this.settings.osm !== false) this.paintRaster(ctx, dpr, ox, oy, S);
      // 3. the downloaded regions' vector tiles
      this.paintVector(ctx, dpr, ox, oy, S);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.settings.claims !== false) this.paintClaims(ctx);
      // 4. label candidates: world places where no region covers (the tiles added theirs as they drew)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (w) this.worldLabels(w);
    });
    // the labels of every copy, best first
    this.paintLabels(ctx);

    // 5. overlays
    for (const c of copies) this.inCopy(c, () => {
      if (this.settings.outlines || this.mode === 'area') this.paintRegionOutlines(ctx);
      this.paintNice(ctx);
      this.paintPins(ctx);
    });
    this.paintMeasure(ctx);
    if (this.mode === 'area' && this.areaBox) this.paintAreaBox(ctx);
    this.paintScale(ctx);
    this.zoomEl.textContent = `zoom ${z.toFixed(1)}`;
    this.placePop();
    this.pump();
  }

  visibleRange(tz) {
    const n = 2 ** tz;
    const [x0, y0] = this.toWorld(0, 0), [x1, y1] = this.toWorld(this.W, this.H);
    return { n, x0: clamp(Math.floor(x0 * n), 0, n - 1), x1: clamp(Math.floor(x1 * n), 0, n - 1), y0: clamp(Math.floor(y0 * n), 0, n - 1), y1: clamp(Math.floor(y1 * n), 0, n - 1) };
  }

  /** Tiles each downloaded region can draw for this view: [{ z, x, y }] (overzoomed past a region's detail). */
  wantedVector() {
    const out = [], seen = new Set();
    // zoomed out, the built-in world is the map (a region's coarse tiles would show as a square on it)
    if (this.view.z < 7.5) return out;
    const [vx0, vy0] = this.toWorld(0, 0), [vx1, vy1] = this.toWorld(this.W, this.H);
    for (const r of this.regions) {
      const [bx0, by0, bx1, by1] = this.bboxToBox(r.bbox);
      if (bx1 < vx0 || bx0 > vx1 || by1 < vy0 || by0 > vy1) continue;
      const tz = clamp(Math.floor(this.view.z + 0.25), 0, r.maxZoom);
      const n = 2 ** tz;
      const xa = clamp(Math.floor(Math.max(vx0, bx0) * n), 0, n - 1), xb = clamp(Math.floor(Math.min(vx1, bx1) * n), 0, n - 1);
      const ya = clamp(Math.floor(Math.max(vy0, by0) * n), 0, n - 1), yb = clamp(Math.floor(Math.min(vy1, by1) * n), 0, n - 1);
      if ((xb - xa + 1) * (yb - ya + 1) > 400) continue;
      for (let x = xa; x <= xb; x++) for (let y = ya; y <= yb; y++) {
        const k = `${tz}/${x}/${y}`;
        if (!seen.has(k)) { seen.add(k); out.push({ z: tz, x, y, k }); }
      }
    }
    return out.sort((a, b) => a.z - b.z);
  }

  /** Whether a downloaded region covers a world-unit point at about this zoom. */
  covered(x, y) {
    for (const r of this.regions) {
      const [x0, y0, x1, y1] = this.bboxToBox(r.bbox);
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
    }
    return false;
  }

  paintVector(ctx, dpr, ox, oy, S) {
    const want = this.wantedVector();
    this.wantTiles.push(...want);
    for (const t of want) {
      const e = this.tiles.get(t.k);
      if (e?.state === 'ok') { e.used = performance.now(); this.paintTile(ctx, dpr, ox, oy, S, t, e.data, null); continue; }
      if (!e) this.enqueue(t);
      // meanwhile, a coarser tile of the same place, cut to this one's square
      for (let up = 1; up <= 6 && t.z - up >= 0; up++) {
        const pz = t.z - up, px = t.x >> up, py = t.y >> up;
        const pe = this.tiles.get(`${pz}/${px}/${py}`);
        if (pe?.state === 'ok') { this.paintTile(ctx, dpr, ox, oy, S, { z: pz, x: px, y: py }, pe.data, t); break; }
      }
    }
  }

  paintTile(ctx, dpr, ox, oy, S, t, d, clipTo) {
    const P = this.pal, z = this.view.z;
    const size = S / 2 ** t.z, k = size / d.extent;
    const tx = ox + t.x * size, ty = oy + t.y * size;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = clipTo || t;
    const cs = S / 2 ** c.z;
    ctx.beginPath();
    ctx.rect(ox + c.x * cs, oy + c.y * cs, cs, cs);
    ctx.clip();
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    const px = 1 / k;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (d.earth) { ctx.fillStyle = P.land; ctx.fill(d.earth); }
    for (const [cls, p] of d.fills) { ctx.fillStyle = P[cls] || P.other; ctx.fill(p); }
    if (d.water) { ctx.fillStyle = P.water; ctx.fill(d.water); }
    if (d.rivers && z >= 8) { ctx.strokeStyle = P.river; ctx.lineWidth = clamp(2 ** (z - 13), 0.6, 6) * px; ctx.stroke(d.rivers); }
    if (d.buildings && z >= 13.5) {
      ctx.globalAlpha = clamp((z - 13.5) * 2, 0, 1);
      ctx.fillStyle = P.building; ctx.fill(d.buildings);
      if (z >= 16) { ctx.strokeStyle = P.buildingLine; ctx.lineWidth = 0.6 * px; ctx.stroke(d.buildings); }
      ctx.globalAlpha = 1;
    }
    if (d.boundaries) {
      ctx.strokeStyle = P.border; ctx.lineWidth = 1 * px; ctx.setLineDash([4 * px, 3 * px]); ctx.stroke(d.boundaries); ctx.setLineDash([]);
    }
    // roads: casings under, then the fills, minor first
    const roadScale = clamp(2 ** ((z - 14) * 0.62), 0.28, 5);
    const show = (kind) => (kind === 'path' ? z >= 14.5 : kind === 'minor_road' || kind === 'other' ? z >= 12.5 : kind === 'medium_road' ? z >= 10.5 : kind === 'major_road' ? z >= 7.5 : true);
    const order = ['path', 'other', 'minor_road', 'medium_road', 'major_road', 'highway'];
    if (z >= 12) {
      for (const kind of order) {
        const p = d.roads.get(kind);
        if (!p || !show(kind) || kind === 'path') continue;
        ctx.strokeStyle = kind === 'highway' ? P.highwayCase : P.casing;
        ctx.lineWidth = (ROAD_W[kind] * roadScale + 1.6) * px;
        ctx.stroke(p);
      }
    }
    for (const kind of order) {
      const p = d.roads.get(kind);
      if (!p || !show(kind)) continue;
      ctx.strokeStyle = { highway: P.highway, major_road: P.major, medium_road: P.medium, minor_road: P.minor, other: P.minor, path: P.path }[kind];
      ctx.lineWidth = Math.max(0.6, ROAD_W[kind] * roadScale) * px;
      if (kind === 'path') ctx.setLineDash([2 * px, 2 * px]);
      ctx.stroke(p);
      ctx.setLineDash([]);
    }
    if (d.rail && z >= 11) {
      ctx.strokeStyle = P.rail; ctx.lineWidth = 1.2 * px; ctx.stroke(d.rail);
      if (z >= 14) { ctx.setLineDash([4 * px, 4 * px]); ctx.strokeStyle = P.land; ctx.lineWidth = 0.7 * px; ctx.stroke(d.rail); ctx.setLineDash([]); }
    }
    ctx.restore();
    if (!clipTo) for (const l of d.labels) this.labels.push({ ...l, x: tx + l.tx * k, y: ty + l.ty * k, ang: l.ang, t });
  }

  /** Decoded tile → paths grouped by how they're drawn, plus label candidates. */
  prepTile(layers, z) {
    const path = (p, f) => {
      for (const r of f.geom) { for (let i = 0; i < r.length; i += 2) { if (i === 0) p.moveTo(r[0], r[1]); else p.lineTo(r[i], r[i + 1]); } }
    };
    const out = { extent: 4096, fills: new Map(), roads: new Map(), labels: [] };
    const get = (key) => (out[key] ||= new Path2D());
    for (const [name, L] of Object.entries(layers)) {
      out.extent = L.extent;
      for (const f of L.features) {
        const kind = f.props.kind;
        if (name === 'earth' && f.type === 3) path(get('earth'), f);
        else if ((name === 'landuse' || name === 'landcover') && f.type === 3) {
          const cls = LANDUSE[kind];
          if (!cls) continue;
          if (!out.fills.has(cls)) out.fills.set(cls, new Path2D());
          path(out.fills.get(cls), f);
        } else if (name === 'water') {
          if (f.type === 3) path(get('water'), f);
          else if (f.type === 2) path(get('rivers'), f);
          if (f.props.name && (f.type === 1 || (f.type === 2 && z >= 13))) this.labelOf(out, f, 'water', z);
        } else if (name === 'buildings' && f.type === 3) path(get('buildings'), f);
        else if (name === 'roads' && f.type === 2) {
          if (kind === 'rail' || f.props.kind_detail === 'rail') { path(get('rail'), f); continue; }
          if (kind === 'ferry') continue;
          // the build files secondary and tertiary roads as major ones too; they read better a step down
          const k = kind === 'major_road' && /^(secondary|tertiary)/.test(f.props.kind_detail || '') ? 'medium_road' : ROAD_W[kind] ? kind : 'other';
          if (!out.roads.has(k)) out.roads.set(k, new Path2D());
          path(out.roads.get(k), f);
          if (f.props.name && z >= 14) this.labelOf(out, f, 'road', z);
        } else if (name === 'transit' && f.type === 2 && (kind === 'rail' || f.props.pmap_kind === 'rail')) path(get('rail'), f);
        else if (name === 'boundaries' && f.type === 2) path(get('boundaries'), f);
        else if ((name === 'places' || name === 'pois' || name === 'physical_point') && f.type === 1 && f.props.name) this.labelOf(out, f, name, z);
      }
    }
    // the best labels first
    out.labels.sort((a, b) => b.pri - a.pri);
    return out;
  }

  labelOf(out, f, layer, z) {
    const p = f.props;
    const name = layer === 'places' && (p.kind === 'country' || p.kind === 'region') ? p['name:en'] || p.name : p.name;
    if (layer === 'road') {
      // along the line's longest piece
      let best = null;
      for (const r of f.geom) for (let i = 2; i < r.length; i += 2) {
        const dx = r[i] - r[i - 2], dy = r[i + 1] - r[i - 1], len = Math.hypot(dx, dy);
        if (!best || len > best.len) best = { len, x: (r[i] + r[i - 2]) / 2, y: (r[i + 1] + r[i - 1]) / 2, ang: Math.atan2(dy, dx) };
      }
      if (!best) return;
      let ang = best.ang;
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      out.labels.push({ name, tx: best.x, ty: best.y, ang, seg: best.len, kind: 'road', pri: { highway: 30, major_road: 26, medium_road: 22 }[p.kind] || 18, minZ: 14.5 });
      return;
    }
    const g = f.type === 1 ? f.geom[0] : [f.geom[0][0], f.geom[0][1]];
    if (!g) return;
    let pri = 10, size = 12, minZ = (p.min_zoom ?? 0) - 0.5, style = 'place';
    if (layer === 'places') {
      const pk = p.kind;
      const pr = +p.population_rank || 0;
      if (pk === 'country') { pri = 100; size = 15; style = 'country'; }
      else if (pk === 'region') { pri = 80; size = 12; style = 'region'; }
      else if (pk === 'locality') { pri = 50 + pr * 2; size = clamp(10 + pr * 0.55, 11, 18); }
      else { pri = 34; size = 11; style = 'hood'; }
    } else if (layer === 'water') { pri = 20; size = 11; style = 'water'; minZ = Math.max(minZ, 9); }
    else if (layer === 'physical_point') { pri = 16; size = 11; style = 'soft'; minZ = Math.max(minZ, 11); }
    else { pri = 8 - (p.min_zoom || 14) / 4; size = 10.5; style = 'poi'; minZ = Math.max(minZ, 15.2); }
    out.labels.push({ name, tx: g[0], ty: g[1], kind: style, size, pri, minZ });
  }

  worldLabels(w) {
    const z = this.view.z;
    // countries until the cities take over; then cities by rank (a downloaded region names its own places)
    if (z < 6.5) {
      for (const c of w.countries) {
        if (c.r > z * 1.7 + 1.5) continue;
        if (this.covered(c.x, c.y) && z >= 4) continue;
        // islands too small to see yet don't get a name
        if (Math.max(c.box[2] - c.box[0], c.box[3] - c.box[1]) * this.scale() < 14) continue;
        // nor do scattered specks of islands whose box is big but whose land isn't (zoomed out)
        if (z < 4 && Math.sqrt(c.land) * this.scale() < 12) continue;
        const [x, y] = this.toScreen(c.x, c.y);
        // the more land, the stronger the claim to the space: the biggest countries keep their names, and
        // a big island country's isn't lost to a scatter of small islands'
        const land = Math.max(1e-12, c.land);
        this.labels.push({ name: c.n, x, y, kind: 'country', size: clamp(10 + z * 1.4, 11, 16), pri: 120 - c.r * 3 + clamp(20 + Math.log2(land), 0, 20) * 1.2, minZ: 0 });
      }
    }
    const lim = z * 1.55 - 0.6;
    for (const p of w.places) {
      // the whole world names no cities; zoomed out to continents the capitals and the giant cities all come in
      // together, none ahead of the others; closer in, the rest by rank
      if (z < 3) break;
      if (z < 4 ? !(p.pop >= 10e6 || p.cap) : p.rank > lim && !p.cap) continue;
      // a downloaded region, or OpenStreetMap's own streets, name the places there (and in the right spot: the world
      // list's points can be a few km off)
      if (z >= 9 && (this.covered(p.x, p.y) || this.rasterShown)) continue;
      const [x, y] = this.toScreen(p.x, p.y);
      if (x < -50 || y < -20 || x > this.W + 50 || y > this.H + 20) continue;
      this.labels.push({ name: p.n, x, y, kind: 'city', size: clamp(12.5 - p.rank * 0.25, 10.5, 12), pri: 70 - p.rank * 4 + (p.cap ? 10 : 0), dot: true, cap: p.cap, country: z < 4 ? p.country || '?' : null, minZ: 0 });
    }
  }

  paintLabels(ctx) {
    const P = this.pal, z = this.view.z;
    const boxes = [];
    const hit = (b) => boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
    const list = this.labels.filter((l) => z >= (l.minZ || 0)).sort((a, b) => b.pri - a.pri);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    let drawn = 0;
    const seen = new Set(), named = new Set();
    const capDots = this.labels.filter((l) => l.cap && l.dot).map((l) => [l.x - 5, l.y - 5, l.x + 5, l.y + 5]);
    for (const l of list) {
      // zoomed out, a city is named only when its country's name is there too
      if (l.country && !named.has(l.country)) continue;
      if (drawn > 600) break;
      if (l.x < -100 || l.y < -40 || l.x > this.W + 100 || l.y > this.H + 40) continue;
      const key = `${l.name}|${Math.round(l.x / 40)}|${Math.round(l.y / 40)}`;
      if (seen.has(key)) continue;
      const weight = l.kind === 'country' ? 600 : l.kind === 'region' ? 500 : l.kind === 'city' || (l.kind === 'place' && l.size > 13) ? 500 : 400;
      ctx.font = `${l.kind === 'water' || l.kind === 'region' ? 'italic ' : ''}${weight} ${l.size || 12}px ${this.font}`;
      const text = l.kind === 'country' && z < 3.5 ? l.name.toUpperCase() : l.name;
      ctx.letterSpacing = l.kind === 'country' && z < 3.5 ? '1px' : '0px';
      const tw = ctx.measureText(text).width, th = (l.size || 12) + 2;
      if (l.kind === 'road' && tw > l.seg * (this.scale() / 2 ** l.t.z / 4096) * 0.95) continue;
      const half = l.kind === 'road' ? Math.max(tw, th) / 2 : tw / 2;
      // a country's box keeps a margin, so no city sits on a country's name
      const pad = l.kind === 'country' ? 6 : 0;
      let lx = l.x, ly = l.y, b;
      if (l.kind === 'road') b = [l.x - half, l.y - half, l.x + half, l.y + half];
      else if (l.kind === 'country') {
        // a country's name steps up or down off its capital's dot, so the capital has room beside it
        b = null;
        for (const dy of [0, th + 6, -th - 6]) {
          const c = [l.x - tw / 2 - 3 - pad, l.y + dy - th / 2 - 1 - pad, l.x + tw / 2 + 3 + pad, l.y + dy + th / 2 + 1 + pad];
          if (!hit(c) && !capDots.some((o) => c[0] < o[2] && c[2] > o[0] && c[1] < o[3] && c[3] > o[1])) { b = c; ly = l.y + dy; break; }
        }
        if (!b) b = [l.x - tw / 2 - 3 - pad, l.y - th / 2 - 1 - pad, l.x + tw / 2 + 3 + pad, l.y + th / 2 + 1 + pad];
      }
      else if (!l.dot) b = [l.x - tw / 2 - 3 - pad, l.y - th / 2 - 1 - pad, l.x + tw / 2 + 3 + pad, l.y + th / 2 + 1 + pad];
      else {
        // a city's name goes above its dot, or below, right or left of it when that's taken (the box takes in the dot)
        const spots = [[0, -th / 2 - 3], [0, th / 2 + 3], [tw / 2 + 6, 0], [-tw / 2 - 6, 0]];
        b = null;
        for (const [dx, dy] of spots) {
          const c = [l.x + dx - tw / 2 - 3, l.y + dy - th / 2 - 1, l.x + dx + tw / 2 + 3, l.y + dy + th / 2 + 1];
          const t = [Math.min(c[0], l.x - 4), Math.min(c[1], l.y - 4), Math.max(c[2], l.x + 4), Math.max(c[3], l.y + 4)];
          if (!hit(t)) { b = t; lx = l.x + dx; ly = l.y + dy; break; }
        }
        if (!b) continue;
      }
      if (hit(b)) continue;
      boxes.push(b);
      seen.add(key);
      if (l.kind === 'country') named.add(l.name);
      drawn++;
      ctx.save();
      ctx.translate(lx, ly);
      if (l.ang) ctx.rotate(l.ang);
      ctx.strokeStyle = P.halo; ctx.lineWidth = 3;
      ctx.fillStyle = l.kind === 'water' ? P.waterText : l.kind === 'region' ? P.region : l.kind === 'hood' || l.kind === 'poi' || l.kind === 'soft' || l.kind === 'road' ? P.textSoft : P.text;
      ctx.strokeText(text, 0, 0);
      ctx.fillText(text, 0, 0);
      ctx.restore();
      ctx.letterSpacing = '0px';
      if (l.dot) {
        ctx.beginPath();
        ctx.arc(l.x, l.y, l.cap ? 3.2 : 2.4, 0, Math.PI * 2);
        ctx.fillStyle = P.text; ctx.fill();
        ctx.strokeStyle = P.halo; ctx.lineWidth = 1.2; ctx.stroke();
        if (l.cap) { ctx.beginPath(); ctx.arc(l.x, l.y, 1.2, 0, Math.PI * 2); ctx.fillStyle = P.halo; ctx.fill(); }
      }
    }
  }

  paintRaster(ctx, dpr, ox, oy, S) {
    const tz = clamp(Math.round(this.view.z), 0, 19);
    if (tz < 9) return; // the built-in world (with its own names) is the map out to there
    const r = this.visibleRange(tz);
    const size = S / r.n;
    if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > 120) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    // OpenStreetMap's tiles are drawn light; on a dark theme, turned to night colours
    if (this.pal === PALETTE.dark) ctx.filter = 'invert(1) hue-rotate(180deg) brightness(0.82) contrast(0.88) saturate(0.6)';
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) {
      // a downloaded region draws its own, nicer, streets
      if (this.regionCoversTile(tz, x, y)) continue;
      const k = `${tz}/${x}/${y}`;
      const e = this.raster.get(k);
      if (e?.state === 'ok') { e.used = performance.now(); this.rasterShown = true; ctx.drawImage(e.img, ox + x * size, oy + y * size, size + 0.5, size + 0.5); continue; }
      if (!e) this.enqueue({ z: tz, x, y, k, raster: true });
      for (let up = 1; up <= 5 && tz - up >= 0; up++) {
        const pz = tz - up, px = x >> up, py = y >> up;
        const pe = this.raster.get(`${pz}/${px}/${py}`);
        if (pe?.state !== 'ok') continue;
        const f = 2 ** up, sw = 256 / f;
        ctx.drawImage(pe.img, (x - px * f) * sw, (y - py * f) * sw, sw, sw, ox + x * size, oy + y * size, size + 0.5, size + 0.5);
        break;
      }
    }
    ctx.restore();
  }
  regionCoversTile(z, x, y) {
    const n = 2 ** z;
    const x0 = x / n, y0 = y / n, x1 = (x + 1) / n, y1 = (y + 1) / n;
    return this.regions.some((r) => {
      if (r.maxZoom < Math.min(z, 14)) return false;
      const [a, b, c, d] = this.bboxToBox(r.bbox);
      return x0 >= a && x1 <= c && y0 >= b && y1 <= d;
    });
  }

  /** The claims as tinted sectors from 60°S to the bottom of the map, edged in their colour, named where there's room. */
  paintClaims(ctx) {
    const [, top] = this.toScreen(0, my(-60)), [, bot] = this.toScreen(0, 1);
    if (top > this.H || bot < 0) return;
    const hot = this.claimHot || [];
    ctx.save();
    for (const c of CLAIMS) {
      const lit = hot.includes(c);
      for (const [a, b] of c.s) {
        const [x0] = this.toScreen(mx(a), 0), [x1] = this.toScreen(mx(b), 0);
        if (x1 < 0 || x0 > this.W) continue;
        ctx.globalAlpha = c.who ? (lit ? 0.34 : 0.15) : (lit ? 0.16 : 0.05);
        ctx.fillStyle = c.color; ctx.fillRect(x0, top, x1 - x0, bot - top);
        ctx.globalAlpha = lit ? 1 : 0.7;
        ctx.strokeStyle = c.color; ctx.lineWidth = lit ? 2 : 1.2; ctx.setLineDash(c.who ? [] : [5, 4]);
        ctx.beginPath(); ctx.moveTo(x0, bot); ctx.lineTo(x0, top); ctx.lineTo(x1, top); ctx.lineTo(x1, bot); ctx.stroke();
      }
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    // names, where the sector is wide enough on screen
    ctx.font = `600 11px ${this.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    for (const c of CLAIMS) {
      const [x, y] = this.toScreen(mx(c.at[0]), my(c.at[1]));
      const label = c.who || 'Unclaimed';
      const room = Math.max(...c.s.map(([a, b]) => (b - a) / 360)) * this.scale();
      if (room < ctx.measureText(label).width + 12 || x < -100 || x > this.W + 100 || y < -20 || y > this.H + 20) continue;
      ctx.strokeStyle = this.pal.halo; ctx.lineWidth = 3; ctx.strokeText(label, x, y);
      ctx.fillStyle = c.color; ctx.fillText(label, x, y);
    }
    ctx.restore();
  }
  /** Hovering south of 60°S: a card with whose claim it is (all of them where they overlap). */
  hoverClaim(px, py, lon, lat) {
    const list = this.settings.claims === false || this.mode ? [] : claimsAt(lon, lat);
    if (!list.length) { this.hideClaim(); return; }
    const was = this.claimHot || [];
    if (list.length !== was.length || list.some((c, i) => c !== was[i])) {
      this.claimHot = list;
      clear(this.claimTip).append(...list.map((c) => h('div', { class: 'mp-claim' },
        h('div', { class: 'mp-claim-head' }, h('span', { class: 'mp-dot', style: { background: c.color } }), h('b', {}, c.name)),
        h('div', { class: 'mp-claim-who' }, c.who ? `${c.who} · claimed ${c.year} · ${c.span}` : `Unclaimed · ${c.span}`),
        h('div', { class: 'mp-claim-info' }, c.info))),
        h('div', { class: 'mp-claim-foot faint' }, list.length > 1 ? 'Overlapping claims. All are frozen by the Antarctic Treaty (1959).' : 'Frozen by the Antarctic Treaty (1959): not recognised, not given up.'));
      this.claimTip.hidden = false;
      this.draw();
    }
    const w = this.claimTip.offsetWidth, hh = this.claimTip.offsetHeight;
    this.claimTip.style.left = `${px + 16 + w > this.W ? px - 16 - w : px + 16}px`;
    this.claimTip.style.top = `${clamp(py - hh - 12, 8, Math.max(8, this.H - hh - 8))}px`;
  }
  hideClaim() {
    if (!this.claimHot) return;
    this.claimHot = null;
    this.claimTip.hidden = true;
    this.draw();
  }

  /** "Nice." at 69°N 69°W, drawn to its true size (200 m wide): a speck until zoomed far in. */
  paintNice(ctx) {
    const [x, y] = this.toScreen(mx(NICE.lon), my(NICE.lat));
    const wpx = NICE.metres / ((Math.cos((NICE.lat * Math.PI) / 180) * 40075016.7) / this.scale());
    if (wpx < 14 || x < -wpx || x > this.W + wpx || y < -wpx || y > this.H + wpx) return;
    ctx.save();
    ctx.font = `700 100px ${this.font}`;
    const size = (100 * wpx) / ctx.measureText(NICE.text).width;
    ctx.font = `700 ${size}px ${this.font}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.strokeStyle = this.pal.halo; ctx.lineWidth = Math.max(2, size / 8); ctx.strokeText(NICE.text, x, y);
    ctx.fillStyle = this.pal.text; ctx.fillText(NICE.text, x, y);
    ctx.restore();
  }

  paintRegionOutlines(ctx) {
    ctx.save();
    ctx.strokeStyle = this.accent; ctx.lineWidth = 1.2; ctx.setLineDash([5, 4]);
    ctx.font = `500 11px ${this.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (const r of this.regions) {
      const [x0, y0, x1, y1] = this.bboxToBox(r.bbox);
      const [a, b] = this.toScreen(x0, y0), [c, d] = this.toScreen(x1, y1);
      ctx.strokeRect(a, b, c - a, d - b);
      if (c - a > 60) { ctx.fillStyle = this.accent; ctx.fillText(r.name, a + 4, b + 4); }
    }
    ctx.restore();
  }

  paintAreaBox(ctx) {
    const [x0, y0, x1, y1] = this.areaBox;
    const [a, b] = this.toScreen(Math.min(x0, x1), Math.min(y0, y1)), [c, d] = this.toScreen(Math.max(x0, x1), Math.max(y0, y1));
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath(); ctx.rect(0, 0, this.W, this.H); ctx.rect(a, b, c - a, d - b); ctx.fill('evenodd');
    ctx.strokeStyle = this.accent; ctx.lineWidth = 2; ctx.setLineDash([]);
    ctx.strokeRect(a, b, c - a, d - b);
    ctx.restore();
  }

  paintPins(ctx) {
    const P = this.pal;
    for (const p of this.pins) {
      const [x, y] = this.toScreen(mx(p.lon), my(p.lat));
      if (x < -20 || y < -40 || x > this.W + 20 || y > this.H + 20) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-3, -7, -9, -11, -9, -18);
      ctx.arc(0, -18, 9, Math.PI, 0);
      ctx.bezierCurveTo(9, -11, 3, -7, 0, 0);
      ctx.fillStyle = p.color || this.accent;
      ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.beginPath(); ctx.arc(0, -18, 3.4, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      if (p.name && this.view.z >= 4) {
        ctx.font = `600 11.5px ${this.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.strokeStyle = P.halo; ctx.lineWidth = 3; ctx.lineJoin = 'round';
        ctx.strokeText(p.name, 12, -18); ctx.fillStyle = P.text; ctx.fillText(p.name, 12, -18);
      }
      ctx.restore();
    }
    if (this.mark) {
      const [x, y] = this.toScreen(this.mark.x, this.mark.y);
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = this.accent; ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1;
      ctx.lineWidth = 2.5; ctx.strokeStyle = this.accent; ctx.stroke();
      ctx.restore();
    }
  }
  pinAt(px, py) {
    for (let i = this.pins.length - 1; i >= 0; i--) {
      const p = this.pins[i];
      const [x, y] = this.toScreen(this.nearX(mx(p.lon)), my(p.lat));
      if (Math.hypot(px - x, py - (y - 16)) < 12) return p;
    }
    return null;
  }

  paintMeasure(ctx) {
    if (this.mode !== 'measure' && this.measure.length < 2) return;
    const pts = this.measure.map((m) => this.toScreen(m.x, m.y));
    if (this.mode === 'measure' && this.mouse && pts.length) pts.push(this.mouse);
    if (!pts.length) return;
    ctx.save();
    ctx.strokeStyle = this.pal.halo; ctx.lineWidth = 5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
    ctx.strokeStyle = this.accent; ctx.lineWidth = 2.5; ctx.setLineDash([7, 5]); ctx.stroke(); ctx.setLineDash([]);
    for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2; ctx.stroke(); }
    // the running total at the end
    const geo = pts.map(([x, y]) => { const [wx, wy] = this.toWorld(x, y); return { lon: lonOf(wx), lat: latOf(wy) }; });
    let total = 0;
    for (let i = 1; i < geo.length; i++) total += haversine(geo[i - 1], geo[i]);
    if (pts.length > 1) {
      const [x, y] = pts[pts.length - 1];
      const t = fmtDist(total);
      ctx.font = `600 12px ${this.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(t).width;
      ctx.fillStyle = this.accent; ctx.beginPath(); ctx.roundRect(x + 10, y - 11, tw + 14, 22, 6); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(t, x + 17, y);
    }
    ctx.restore();
    this.measureTotal = total;
  }

  paintScale(ctx) {
    const [, wy] = this.toWorld(0, this.H - 20);
    const metersPerPx = (Math.cos((latOf(wy) * Math.PI) / 180) * 40075016.7) / this.scale();
    const target = metersPerPx * 110;
    const pow = 10 ** Math.floor(Math.log10(target));
    const nice = [1, 2, 5, 10].map((m) => m * pow).filter((v) => v <= target).pop() || pow;
    const px = nice / metersPerPx;
    const x = 12, y = this.H - 16;
    ctx.save();
    ctx.strokeStyle = this.pal.halo; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5); ctx.stroke();
    ctx.strokeStyle = this.pal.text; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = `500 11px ${this.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3; ctx.strokeStyle = this.pal.halo;
    ctx.strokeText(fmtDist(nice), x + 4, y - 3); ctx.fillStyle = this.pal.text; ctx.fillText(fmtDist(nice), x + 4, y - 3);
    ctx.restore();
  }

  // ================================================================ loading tiles

  enqueue(t) {
    const map = t.raster ? this.raster : this.tiles;
    if (map.has(t.k)) return;
    map.set(t.k, { state: 'queued', used: performance.now() });
    this.queue.push(t);
  }

  pump() {
    // what's still on screen goes first; what isn't any more is dropped
    if (!this.queue.length) return;
    const z = this.view.z;
    const keep = [];
    for (const t of this.queue) {
      const map = t.raster ? this.raster : this.tiles;
      const onScreen = t.raster ? Math.abs(t.z - Math.round(z)) <= 0 && this.tileOnScreen(t) : this.wantTiles?.some((w) => w.k === t.k);
      if (onScreen) keep.push(t); else map.delete(t.k);
    }
    this.queue = keep;
    while (this.loading < 8 && this.queue.length) {
      const t = this.queue.pop();
      this.loading++;
      this.fetchTile(t).finally(() => { this.loading--; this.trim(); this.draw(); });
    }
  }
  tileOnScreen(t) {
    return this.copies().some((c) => {
      let r;
      this.inCopy(c, () => { r = this.visibleRange(t.z); });
      return t.x >= r.x0 && t.x <= r.x1 && t.y >= r.y0 && t.y <= r.y1;
    });
  }

  async fetchTile(t) {
    const map = t.raster ? this.raster : this.tiles;
    try {
      const res = await fetch(`/api/map/${t.raster ? 'osm' : 'tile'}?z=${t.z}&x=${t.x}&y=${t.y}`, { headers: { 'X-BDS-Token': api.token } });
      if (res.status === 204 || !res.ok) { map.set(t.k, { state: 'empty', used: performance.now() }); return; }
      if (t.raster) {
        const img = await createImageBitmap(await res.blob());
        map.set(t.k, { state: 'ok', img, used: performance.now() });
      } else {
        const data = this.prepTile(decodeTile(new Uint8Array(await res.arrayBuffer())), t.z);
        map.set(t.k, { state: 'ok', data, used: performance.now() });
      }
    } catch {
      // offline or a broken tile: try again later rather than never
      map.set(t.k, { state: 'empty', used: performance.now() });
      setTimeout(() => { if (map.get(t.k)?.state === 'empty') map.delete(t.k); }, 30000);
    }
  }

  trim() {
    for (const map of [this.tiles, this.raster]) {
      if (map.size <= TILE_LRU) continue;
      const old = [...map.entries()].filter(([, e]) => e.state !== 'queued').sort((a, b) => a[1].used - b[1].used);
      for (const [k, e] of old.slice(0, map.size - TILE_LRU)) { e.img?.close?.(); map.delete(k); }
    }
  }

  // ================================================================ search

  searchSoon = debounce(() => this.search(), 180);

  async search() {
    const q = this.searchIn.value.trim();
    if (q.length < 2) { this.hideResults(); return; }
    const ql = q.toLowerCase();
    // countries from the built-in map, here; everything else from the server
    const countries = (this.world?.countries || []).filter((c) => c.n.toLowerCase().startsWith(ql)).slice(0, 4)
      .map((c) => ({ name: c.n, kind: 'country', box: c.box }));
    let rest = [];
    try { rest = (await api.get(`/api/map/search?q=${encodeURIComponent(q)}`)).results || []; } catch { /* the countries still show */ }
    if (this.searchIn.value.trim() !== q) return;
    const coord = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(q);
    const list = [
      ...(coord && Math.abs(+coord[1]) <= 90 && Math.abs(+coord[2]) <= 180 ? [{ name: `${coord[1]}, ${coord[2]}`, kind: 'coordinates', lat: +coord[1], lon: +coord[2] }] : []),
      ...countries, ...rest,
    ];
    this.showResults(list);
  }

  showResults(list) {
    clear(this.results);
    this.resultList = list;
    this.resultIdx = 0;
    if (!list.length) { this.results.append(h('div', { class: 'mp-res-empty' }, 'Nothing by that name. Downloaded areas can be searched street by street.')); }
    list.forEach((r, i) => this.results.append(h('button', { class: `mp-res ${i === 0 ? 'on' : ''}`, onmousedown: (e) => e.preventDefault(), onclick: () => this.pick(r) },
      icon(r.kind === 'downloaded map' ? 'map' : r.kind === 'country' ? 'globe' : 'map-pin', 'sm'),
      h('span', { class: 'mp-res-name' }, r.name),
      h('span', { class: 'mp-res-kind' }, [r.kind, r.where].filter(Boolean).join(' · ')))));
    this.results.hidden = false;
  }
  hideResults() { this.results.hidden = true; }

  searchKey(e) {
    const btns = [...this.results.querySelectorAll('.mp-res')];
    if (e.key === 'Escape') { this.hideResults(); this.wrap.focus(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!btns.length) return;
      this.resultIdx = (this.resultIdx + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
      btns.forEach((b, i) => b.classList.toggle('on', i === this.resultIdx));
    }
    if (e.key === 'Enter') { e.preventDefault(); const r = this.resultList?.[this.resultIdx || 0]; if (r) this.pick(r); else this.search(); }
  }

  pick(r) {
    this.hideResults();
    if (r.box) { this.mark = null; this.fitBox(r.box); }
    else if (r.bbox) { this.mark = null; this.fitBox(this.bboxToBox(r.bbox)); }
    else {
      const z = { capital: 11, city: 11, country: 5, coordinates: 15, locality: 13, neighbourhood: 15, macrohood: 14, region: 7 }[r.kind] || 17;
      this.mark = { x: mx(r.lon), y: my(r.lat) };
      this.flyTo(this.mark.x, this.mark.y, z, 900);
    }
    this.wrap.focus({ preventScroll: true });
  }

  // ================================================================ pins

  async savePins() { try { await api.post('/api/map/pins', { pins: this.pins }); } catch (e) { errorToast(e); } this.renderPanel(); }
  addPin(x, y) {
    const near = this.labels?.filter((l) => Math.hypot(...((([sx, sy]) => [sx - l.x, sy - l.y])(this.toScreen(x, y)))) < 30)[0];
    const pin = { id: Math.random().toString(36).slice(2, 10), lon: +lonOf(x).toFixed(6), lat: +latOf(y).toFixed(6), name: near?.name || '', note: '' };
    this.pins.push(pin);
    this.savePins();
    this.draw();
    this.openPin(pin);
  }
  removePin(pin) {
    this.pins = this.pins.filter((p) => p !== pin);
    if (this.popPin === pin) this.closePop();
    this.savePins();
    this.draw();
  }
  openPin(pin) {
    this.popPin = pin;
    const name = h('input', { class: 'mp-pop-name', value: pin.name, placeholder: 'Name this pin' });
    const note = h('textarea', { class: 'mp-pop-note', placeholder: 'Notes…', rows: '3' }, pin.note || '');
    const save = debounce(() => { pin.name = name.value.trim(); pin.note = note.value; this.savePins(); this.draw(); }, 400);
    name.addEventListener('input', save); note.addEventListener('input', save);
    const colors = ['', '#e5484d', '#f59e0b', '#30a46c', '#3e8ef7', '#8e4ec6', '#2f2f33'];
    clear(this.popEl).append(
      h('div', { class: 'mp-pop-head' }, name, h('button', { class: 'icon-btn', 'data-tip': 'Close', onclick: () => this.closePop() }, icon('x', 'sm'))),
      note,
      h('div', { class: 'mp-pop-foot' },
        ...colors.map((c) => h('button', { class: `mp-swatch ${(pin.color || '') === c ? 'on' : ''}`, style: { background: c || this.accent }, 'data-tip': c ? null : 'Theme colour', onclick: (e) => { pin.color = c; this.savePins(); this.draw(); this.popEl.querySelectorAll('.mp-swatch').forEach((s) => s.classList.toggle('on', s === e.currentTarget)); } })),
        h('div', { class: 'grow' }),
        h('span', { class: 'mp-pop-coord mono' }, `${pin.lat.toFixed(5)}, ${pin.lon.toFixed(5)}`),
        h('button', { class: 'icon-btn', 'data-tip': 'Remove this pin', onclick: () => this.removePin(pin) }, icon('trash', 'sm'))));
    this.popEl.hidden = false;
    this.placePop();
    if (!pin.name) setTimeout(() => name.focus(), 0);
  }
  closePop() { this.popPin = null; this.popEl.hidden = true; }
  placePop() {
    const p = this.popPin;
    if (!p || this.popEl.hidden) return;
    const [x, y] = this.toScreen(this.nearX(mx(p.lon)), my(p.lat));
    const w = this.popEl.offsetWidth || 260, hh = this.popEl.offsetHeight || 140;
    this.popEl.style.left = `${clamp(x - w / 2, 8, this.W - w - 8)}px`;
    this.popEl.style.top = `${y - 40 - hh < 8 ? y + 10 : y - 40 - hh}px`;
  }

  // ================================================================ measuring

  toggleMeasure(on = this.mode !== 'measure') {
    if (on && this.mode === 'area') this.stopArea();
    this.mode = on ? 'measure' : null;
    if (on) { this.measure = []; this.showHint('Click points to measure. Backspace takes one back; Esc or right-click stops.'); }
    else this.showHint(null);
    this.measureBtn.classList.toggle('active', on);
    this.cv.style.cursor = on ? 'crosshair' : 'grab';
    this.draw();
  }
  showHint(text) { this.hint.hidden = !text; this.hint.textContent = text || ''; }

  // ================================================================ downloading an area

  startArea() {
    if (this.mode === 'area') { this.stopArea(); return; }
    if (this.mode === 'measure') this.toggleMeasure(false);
    this.mode = 'area';
    this.areaBox = null;
    this.areaBtn.classList.add('active');
    this.cv.style.cursor = 'crosshair';
    this.showHint('Drag a box around the area to keep offline. Esc cancels.');
    this.draw();
  }
  stopArea() {
    this.mode = null; this.areaBox = null;
    this.areaBtn.classList.remove('active');
    this.cv.style.cursor = 'grab';
    this.showHint(null);
    this.draw();
  }

  async finishArea() {
    const b = this.areaBox;
    if (!b) return;
    // into the copy of the world the box mostly sits in (a download stops at the date line)
    const c = Math.floor((b[0] + b[2]) / 2);
    const x0 = clamp(Math.min(b[0], b[2]) - c, 0, 1), x1 = clamp(Math.max(b[0], b[2]) - c, 0, 1), y0 = clamp(Math.min(b[1], b[3]), 0, 1), y1 = clamp(Math.max(b[1], b[3]), 0, 1);
    const [sa, sb] = this.toScreen(x0, y0), [sc, sd] = this.toScreen(x1, y1);
    if (sc - sa < 6 || sd - sb < 6) { this.areaBox = null; this.draw(); return; }
    this.mode = 'area';
    this.areaBox = [x0 + c, y0, x1 + c, y1];
    this.draw();
    const bbox = [x0 * 360 - 180, latOf(y1), x1 * 360 - 180, latOf(y0)].map((v) => +v.toFixed(5));
    // a name: the biggest city in the box, else the country
    const inBox = (p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    const city = (this.world?.places || []).filter(inBox).sort((a, b2) => (b2.pop || 0) - (a.pop || 0))[0];
    const country = (this.world?.countries || []).find((c) => inBox(c));
    const name = h('input', { value: city?.n || country?.n || 'My area', style: { width: '100%' } });
    const detail = h('select', { style: { width: '100%' } }, ...DETAIL.map(([z, label]) => h('option', { value: String(z) }, label)));
    const est = h('div', { class: 'mp-est' }, '');
    let tooBig = false;
    const estimate = debounce(async () => {
      est.textContent = 'Working out the size…';
      try {
        const r = await api.post('/api/map/estimate', { bbox, maxZoom: +detail.value });
        tooBig = !!r.tooBig;
        est.textContent = r.tooBig ? `That’s ${r.tiles.toLocaleString()} map tiles, too many. Pick a smaller area or less detail.`
          : r.bytes != null ? `About ${formatBytes(r.bytes)} (${r.tiles.toLocaleString()} tiles).` : `Roughly ${formatBytes(r.guess)} or less (${r.tiles.toLocaleString()} tiles; empty land and sea take almost nothing).`;
      } catch (e) { est.textContent = e.message; }
    }, 250);
    detail.addEventListener('change', estimate);
    estimate();
    const go = await modal({
      title: 'Download this area',
      body: h('div', { class: 'mp-dl' },
        h('label', { class: 'field' }, h('span', {}, 'Name'), name),
        h('label', { class: 'field' }, h('span', {}, 'Detail'), detail),
        est,
        h('p', { class: 'mp-dl-note' }, 'Map data © OpenStreetMap contributors, from the free daily world build at protomaps.com. Only this area is downloaded; it works offline from then on.')),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Download', primary: true, onClick: () => (tooBig ? false : { name: name.value.trim() || 'My area', maxZoom: +detail.value }) }],
      onOpen: () => setTimeout(() => { name.focus(); name.select(); }, 0),
    });
    this.stopArea();
    if (!go) return;
    try {
      const { id } = await api.post('/api/map/download', { bbox, ...go });
      this.jobs.push({ id, name: go.name, progress: 0, phase: 'Starting', box: [x0, y0, x1, y1] });
      if (this.panel.hidden) this.togglePanel(true);
      this.renderPanel();
      this.pollJobs();
    } catch (e) { errorToast(e); }
  }

  async pollJobs() {
    if (this.polling) return;
    this.polling = true;
    while (this.jobs.length && !this.closed) {
      await new Promise((r) => setTimeout(r, 700));
      for (const j of [...this.jobs]) {
        try {
          const s = await api.get(`/api/job?id=${encodeURIComponent(j.id)}`);
          Object.assign(j, { progress: s.progress, phase: s.phase, bytes: s.bytes, total: s.total });
          if (s.status === 'running') continue;
          this.jobs = this.jobs.filter((x) => x !== j);
          if (s.status === 'done') {
            if (j.replaces) await api.post('/api/map/regions/remove', { id: j.replaces }).catch(() => {});
            this.regions = (await api.get('/api/map/regions')).regions || [];
            this.tiles.clear();
            toast(`${j.name} is ready to use offline`, { type: 'ok', action: { label: 'Show', fn: () => this.fitBox(j.box) } });
          } else if (s.status === 'error') toast(`The map of ${j.name} didn’t download: ${s.error}`, { type: 'error', timeout: 8000 });
        } catch { this.jobs = this.jobs.filter((x) => x !== j); }
      }
      this.renderPanel();
      this.draw();
    }
    this.polling = false;
  }

  // ================================================================ the side panel

  togglePanel(on = this.panel.hidden) {
    this.panel.hidden = !on;
    this.panelBtn.classList.toggle('active', on);
    this.renderPanel();
    this.draw();
  }

  renderPanel() {
    if (this.panel.hidden) return;
    const p = clear(this.panel);
    p.append(h('div', { class: 'mp-sec' }, 'Downloaded maps'));
    for (const j of this.jobs) {
      p.append(h('div', { class: 'mp-row job' },
        h('div', { class: 'mp-row-main' },
          h('div', { class: 'mp-row-name' }, j.name),
          h('div', { class: 'mp-row-sub' }, `${j.phase || 'Starting'}${j.total ? ` · ${formatBytes(j.bytes || 0)} of ${formatBytes(j.total)}` : ''}`),
          h('div', { class: 'mp-prog' }, h('div', { style: { width: `${Math.round((j.progress || 0) * 100)}%` } }))),
        h('button', { class: 'icon-btn', 'data-tip': 'Cancel', onclick: () => api.post('/api/job/cancel', { id: j.id }) }, icon('x', 'sm'))));
    }
    if (!this.regions.length && !this.jobs.length) {
      p.append(h('div', { class: 'mp-empty' }, 'None yet. The world map is always here; for streets, ',
        h('button', { class: 'link', onclick: () => this.startArea() }, 'download an area'), ' and it works with no connection.'));
    }
    for (const r of this.regions) {
      p.append(h('div', { class: 'mp-row', onclick: () => this.fitBox(this.bboxToBox(r.bbox)),
        oncontextmenu: (e) => contextMenu(e, this.regionMenu(r)) },
        icon('map', 'sm'),
        h('div', { class: 'mp-row-main' },
          h('div', { class: 'mp-row-name' }, r.name),
          h('div', { class: 'mp-row-sub' }, `${formatBytes(r.size)} · ${(DETAIL.find(([z]) => z === r.maxZoom) || [0, `detail ${r.maxZoom}`])[1].toLowerCase()}`)),
        h('button', { class: 'icon-btn', 'data-tip': 'More', onclick: (e) => { e.stopPropagation(); showMenu(this.regionMenu(r), { anchor: e.currentTarget }); } }, icon('more', 'sm'))));
    }
    p.append(h('button', { class: 'btn sm mp-addbtn', onclick: () => this.startArea() }, icon('download', 'sm'), 'Download an area'));
    p.append(h('div', { class: 'mp-sec' }, 'Pins'));
    if (!this.pins.length) p.append(h('div', { class: 'mp-empty' }, 'Right-click the map to drop a pin.'));
    for (const pin of this.pins) {
      p.append(h('div', { class: 'mp-row', onclick: () => { this.flyTo(mx(pin.lon), my(pin.lat), Math.max(this.view.z, 14)); this.openPin(pin); } },
        h('span', { class: 'mp-dot', style: { background: pin.color || this.accent } }),
        h('div', { class: 'mp-row-main' },
          h('div', { class: 'mp-row-name' }, pin.name || 'Pin'),
          pin.note ? h('div', { class: 'mp-row-sub' }, pin.note.split('\n')[0].slice(0, 80)) : null),
        h('button', { class: 'icon-btn', 'data-tip': 'Remove', onclick: (e) => { e.stopPropagation(); this.removePin(pin); } }, icon('trash', 'sm'))));
    }
  }

  regionMenu(r) {
    return [
      { label: 'Show it', icon: 'focus', action: () => this.fitBox(this.bboxToBox(r.bbox)) },
      { label: 'Rename…', icon: 'edit', action: async () => {
        const n = await promptDialog('Rename this map', '', r.name);
        if (!n) return;
        try { await api.post('/api/map/regions/rename', { id: r.id, name: n }); r.name = n; this.renderPanel(); this.draw(); } catch (e) { errorToast(e); }
      } },
      { label: 'Download it again (newer streets)', icon: 'refresh', action: async () => {
        try {
          const { id } = await api.post('/api/map/download', { bbox: r.bbox, maxZoom: r.maxZoom, name: r.name });
          this.jobs.push({ id, name: r.name, progress: 0, phase: 'Starting', box: this.bboxToBox(r.bbox), replaces: r.id });
          this.renderPanel(); this.pollJobs();
        } catch (e) { errorToast(e); }
      } },
      { sep: true },
      { label: 'Delete', icon: 'trash', action: async () => {
        if (!(await confirmDialog('Delete this map', `Delete the offline map of ${r.name} (${formatBytes(r.size)})? The world map stays.`, { okLabel: 'Delete', danger: true }))) return;
        try {
          await api.post('/api/map/regions/remove', { id: r.id });
          this.regions = this.regions.filter((x) => x !== r);
          this.tiles.clear();
          this.renderPanel(); this.draw();
        } catch (e) { errorToast(e); }
      } },
    ];
  }

  // ================================================================ tab life

  onShow() { this.applyTheme(); this.draw(); }
  onThemeChange() { this.applyTheme(); this.draw(); }
  destroy() {
    this.closed = true;
    this.ro?.disconnect();
    this.themeObs?.disconnect();
    cancelAnimationFrame(this.anim);
    for (const e of this.raster.values()) e.img?.close?.();
  }
}
