// Deep Strike's terrain: a rough, hand-drawn biome map of the whole field (from general geography, not survey data)
// and what each biome does to a package flying low through it. Hills and forest hide a low jet from radar and
// spoil a missile's aim; flat open ground and water hide nothing. Medium and high altitude ignore the ground.

import { clipField } from './geo.js';

/** What each biome does at deck (< 120 m) and low (< 600 m): see = how far a radar sees you there (× its range),
 *  pk = × a missile's chance to hit, burn = × fuel (terrain following). */
export const BIOMES = {
  water: { name: 'Open water', col: '#3d7ab8', deck: { see: 0.9, pk: 0.9, skim: 20 }, low: { see: 1.1, pk: 1 },
    what: 'Sea-skimming: at deck height the package drops to 20 m over flat water, under every radar’s horizon until it’s close and below some missiles’ lowest engagement height; wave clutter helps too. Higher up, radar carries well over open water.' },
  farmland: { name: 'Farmland', col: '#b7b86e', deck: { see: 0.97, pk: 0.98 }, low: { see: 1, pk: 1 },
    what: 'Fields, hedgerows, villages and power lines: a little clutter down low, not much cover.' },
  steppe: { name: 'Steppe', col: '#c9b65a', deck: { see: 1, pk: 1 }, low: { see: 1, pk: 1 },
    what: 'Open grassland and fields. Flat; deck flying is easy, but there’s no cover.' },
  tundra: { name: 'Tundra', col: '#9fb0a8', deck: { see: 1.05, pk: 1 }, low: { see: 1.02, pk: 1 },
    what: 'Flat, treeless and frozen half the year: nothing to hide behind.' },
  desert: { name: 'Desert', col: '#e8c27a', deck: { see: 1.12, pk: 1.05 }, low: { see: 1.05, pk: 1.02 },
    what: 'Sand and gravel flats under clear skies: the worst place to try to hide.' },
  scrub: { name: 'Mediterranean scrub', col: '#9a9f55', deck: { see: 0.9, pk: 0.92 }, low: { see: 0.97, pk: 1 },
    what: 'Broken coastal hills, olive groves and scrub: some cover in the folds of the ground.' },
  semidesert: { name: 'Semi-desert', col: '#d99a5b', deck: { see: 1.1, pk: 1.05 }, low: { see: 1.05, pk: 1 },
    what: 'Dry, flat and nearly bare: little to hide behind.' },
  foreststeppe: { name: 'Forest-steppe', col: '#8fb35a', deck: { see: 0.92, pk: 0.95 }, low: { see: 1, pk: 1 },
    what: 'Fields broken up by woods and gullies: a little cover down low.' },
  forest: { name: 'Forest', col: '#3f8f4f', deck: { see: 0.85, pk: 0.9 }, low: { see: 0.95, pk: 1 },
    what: 'Tree cover muddies the radar picture of a jet at treetop height.' },
  wetland: { name: 'Wetland / floodplain', col: '#4fb3a6', deck: { see: 0.9, pk: 0.95 }, low: { see: 1, pk: 1 },
    what: 'Low river country, reeds and channels: you sit a little lower than the land around.' },
  upland: { name: 'Uplands', col: '#a77f5a', deck: { see: 0.75, pk: 0.85, burn: 1.05 }, low: { see: 0.9, pk: 0.95 },
    what: 'Rolling hills and ridges: valleys hide a low package from radars on the other side.' },
  mountains: { name: 'Mountains', col: '#e6e1dc', deck: { see: 0.45, pk: 0.7, burn: 1.2 }, low: { see: 0.65, pk: 0.85, burn: 1.1 },
    what: 'Real terrain masking: radars lose you behind the peaks. Terrain following burns fuel.' },
};
const IDS = Object.keys(BIOMES); // grid values

// Rough outlines, [lon, lat], painted in this order (later ones on top). Land under none of them is farmland;
// anything off the land is water.
const LAYERS = [
  // bases: the great steppe belt, the plateaus of Anatolia and Iran
  ['steppe', [[28.2, 45.5], [28, 47], [28, 49.2], [31, 49.5], [34, 49.8], [36.2, 49.9], [38, 50.1], [39.5, 50.2], [41, 50.6], [42.5, 51.2], [44, 51.6], [46, 52.2], [49, 53.2],
    [52, 53.5], [55, 53.5], [60, 53], [70, 53.5], [80, 53.5], [88, 52], [88, 48], [80, 47.5], [75, 48], [68, 48], [60, 48.5], [55, 49], [51, 49.6], [48, 49.3],
    [47.5, 44.3], [45, 43.8], [42, 43.9], [40, 44.2], [38.5, 44.6], [37.3, 44.9], [36.6, 45.2], [35.5, 44.9], [33, 44.6], [32.5, 46.1], [31, 46.5], [30, 45.9], [29, 45.2]]],
  ['upland', [[29, 40.5], [31, 41], [34, 41.3], [37, 41], [40, 40.7], [43, 41.1], [44.8, 40], [44.3, 39], [44.6, 37.5], [42, 37.4], [40, 37.3], [38, 37.2], [36.5, 37.3],
    [33, 37.1], [31, 37.3], [29.5, 37.8], [28.8, 38.8]]], // Anatolian plateau
  ['upland', [[44, 39.8], [48, 39.4], [48.9, 38.4], [50, 37.2], [53, 36.8], [55, 37.3], [57, 38], [61, 36.8], [61.5, 34], [61, 30], [63, 29.5], [61.6, 25], [57, 25.3],
    [54, 26.5], [51, 27.8], [48.5, 30], [47.5, 31.5], [46, 33], [45.5, 34.5], [44.5, 36]]], // Iranian plateau
  // forest-steppe, then forest north of it
  ['foreststeppe', [[23.5, 50.5], [26, 51], [28, 52.2], [28, 49.2], [28, 47], [26.5, 48.2], [24, 48.5]]],
  ['foreststeppe', [[28, 52.2], [31, 52.4], [33, 53.0], [34.4, 53.3], [36.2, 53.9], [37.6, 54.2], [39.7, 54.6], [41.5, 54.9], [43.5, 55.2], [46, 55.0], [49, 55.4],
    [49, 53.2], [46, 52.2], [44, 51.6], [42.5, 51.2], [41, 50.6], [39.5, 50.2], [38, 50.1], [36.2, 49.9], [34, 49.8], [31, 49.5], [28, 49.2]]],
  ['foreststeppe', [[49, 55.4], [56, 56.3], [62, 56.5], [70, 56], [80, 55.2], [88, 54.5], [88, 52], [80, 53.5], [70, 53.5], [60, 53], [55, 53.5], [52, 53.5], [49, 53.2]]],
  ['forest', [[28, 52.2], [31, 52.4], [33, 53.0], [34.4, 53.3], [36.2, 53.9], [37.6, 54.2], [39.7, 54.6], [41.5, 54.9], [43.5, 55.2], [46, 55.0], [49, 55.4], [49, 58], [28, 58]]],
  ['forest', [[49, 55.4], [56, 56.3], [62, 56.5], [62, 57.5], [49, 58]]],
  ['forest', [[14, 54], [18, 54.5], [21, 54], [23.5, 52.5], [28, 52.2], [28, 58.2], [21, 57.5], [14, 56]]], // the Baltic's mixed forest
  ['forest', [[4.5, 58], [8, 58], [10.5, 59], [12, 57.8], [12.8, 56.5], [16, 56.2], [16.8, 57.6], [19, 57.2], [21.5, 57.5], [23, 57.8], [26, 58], [28, 57.9], [49, 57.9],
    [56, 57], [62, 57], [62, 67.3], [55, 67.3], [50, 67.6], [45, 67.8], [40, 66.5], [37, 68.2], [30, 69.6], [25, 69.3], [20, 69.3], [14, 68], [10, 64], [4.5, 62]]], // taiga
  ['tundra', [[38, 68], [40, 66.6], [45, 67.9], [50, 67.7], [55, 67.4], [62, 67.4], [66, 66.8], [70, 67.5], [70, 78], [50, 78], [38, 72]]],
  ['tundra', [[20, 69.4], [25, 69.4], [30, 69.7], [37, 68.3], [41, 67.8], [42, 72], [18, 72]]],
  // the dry south-east
  // the Mediterranean coasts
  ['scrub', [[-9, 37.1], [-7.5, 37.2], [-6, 36.3], [-4, 36.7], [-2, 36.8], [-0.5, 38], [0.2, 38.8], [-0.3, 39.5], [0.5, 40.7], [3.3, 42], [2.5, 42.4], [0.8, 41.1], [-0.6, 40],
    [-1.3, 38.8], [-3, 37.8], [-5.5, 37.6], [-8.8, 38.4]]],
  ['scrub', [[3, 43.2], [5, 43.6], [7.5, 43.9], [9.5, 44.3], [10.5, 43.5], [11.5, 42.6], [12.8, 41.6], [13.5, 41.3], [13, 41.1], [11.5, 42.1], [10.5, 42.9], [9.6, 44],
    [7.5, 43.6], [5, 43.1], [3.3, 42.9]]],
  ['scrub', [[15.8, 41.6], [18.6, 40.4], [17, 39.3], [16.2, 37.9], [15.6, 38.3], [15.7, 40], [14.8, 40.6], [15.8, 41]]],
  ['scrub', [[12.3, 38.2], [15.7, 38.3], [15.1, 36.6], [12.4, 37.6]]], // Sicily
  ['scrub', [[8.2, 39], [9.9, 39], [9.9, 41.2], [9.5, 43.1], [8.5, 42.7], [8.3, 40.8]]], // Sardinia, Corsica
  ['scrub', [[19.8, 40.2], [22.8, 40.6], [24, 41], [26.3, 41], [26.6, 40.3], [24, 39.8], [24.2, 38.5], [23.4, 37.4], [23, 36.4], [21.6, 36.7], [21.1, 38.3], [20.7, 39.2]]],
  ['scrub', [[23.5, 35.7], [26.4, 35.4], [26.2, 34.9], [23.5, 35.1]]], // Crete
  ['scrub', [[32.2, 34.6], [34.6, 35.7], [34.1, 34.9]]], // Cyprus
  ['scrub', [[26, 40.4], [27.5, 40.4], [28.3, 39.5], [28.3, 38.2], [29, 37.4], [30.5, 37.1], [32, 36.6], [34, 36.8], [36, 37.1], [36.4, 36.2], [34.5, 36.2], [32.5, 36],
    [30.5, 36.2], [28, 36.5], [27, 37.3], [26.2, 38.3]]],
  // wetlands
  ['wetland', [[37.6, 46.3], [38.4, 46.2], [38.6, 45.6], [38.0, 45.1], [37.4, 45.3]]], // Kuban delta
  ['wetland', [[39.0, 47.3], [39.5, 47.25], [39.55, 47.08], [39.1, 47.05]]], // Don delta
  ['wetland', [[44.6, 48.9], [45.2, 48.8], [46.5, 47.6], [48.2, 46.6], [47.9, 45.9], [47.3, 46.2], [46.0, 47.2], [44.8, 48.3]]], // Volga-Akhtuba
  ['wetland', [[46.8, 46.4], [48.5, 46.2], [49.2, 45.5], [48, 45.3], [47, 45.7]]], // Volga delta
  ['wetland', [[40.6, 46.85], [41.6, 46.7], [42.6, 46.5], [44.0, 46.15], [45.0, 45.8], [44.8, 45.6], [43.5, 45.9], [42.4, 46.3], [41.4, 46.55], [40.5, 46.65]]], // Manych
  ['wetland', [[23.5, 52.3], [26, 52.4], [28.5, 52.1], [30.5, 51.8], [30, 51.2], [27.5, 51.3], [25, 51.4], [23.8, 51.6]]], // Polesia
  ['wetland', [[41.5, 42.5], [42.3, 42.4], [42, 41.9], [41.6, 41.9]]], // Kolkheti
  // uplands
  ['upland', [[35.3, 53.5], [36.8, 53.8], [38.3, 53.6], [38.8, 52.5], [39.2, 51.6], [39.6, 50.6], [39.3, 49.9], [38.2, 49.9], [37, 50.3], [35.8, 50.6], [35.0, 51.5], [34.8, 52.7]]], // Central Russian
  ['upland', [[37.4, 48.25], [38.3, 48.6], [39.5, 48.55], [40.5, 48.3], [40.6, 47.95], [39.5, 47.9], [38.3, 47.85], [37.5, 47.9]]], // Donetsk Ridge
  ['upland', [[43.2, 53.5], [46.5, 53.5], [46.4, 52.0], [45.6, 50.8], [44.8, 49.5], [44.3, 48.6], [43.7, 48.7], [44.2, 49.8], [44.4, 51.0], [43.6, 52.2]]], // Volga
  ['upland', [[40.0, 50.9], [41.3, 51.0], [41.6, 50.3], [41.0, 49.8], [40.2, 49.9]]], // Kalach
  ['upland', [[41.4, 45.8], [43.0, 45.9], [44.2, 45.3], [44.0, 44.4], [42.5, 44.1], [41.6, 44.5]]], // Stavropol
  ['upland', [[36.0, 47.6], [37.6, 47.7], [38.0, 47.3], [37.2, 46.95], [36.2, 47.1]]], // Azov
  ['upland', [[25, 49.6], [28, 49.8], [30, 48.8], [29.5, 48], [26.5, 48.5]]], // Podolia
  ['upland', [[31, 58.5], [34, 58.6], [35, 57.5], [33, 56.8], [31, 57.3]]], // Valdai
  ['upland', [[49, 62], [52, 64], [54, 66], [52.5, 66.5], [50.5, 64], [48.5, 62.5]]], // Timan
  ['upland', [[29, 67.5], [33, 68.5], [37, 68], [36, 67.2], [31, 67]]], // Kola
  ['upland', [[23, 47.3], [25, 47.2], [25.3, 46], [23.5, 45.9], [22.8, 46.6]]], // Transylvania
  ['upland', [[-7, 42], [-3, 42], [-1.5, 41], [-1.5, 39], [-3, 38.5], [-6.5, 38.6], [-7.2, 40]]], // Meseta
  // mountains
  ['mountains', [[37.4, 44.9], [38.6, 44.5], [40.0, 44.1], [41.5, 43.9], [43.0, 43.8], [44.5, 43.2], [46.0, 42.8], [47.5, 42.1], [48.5, 41.6], [47.6, 41.0],
    [46.0, 41.6], [44.5, 42.4], [43.0, 42.6], [41.5, 43.0], [40.0, 43.4], [38.6, 44.0], [37.5, 44.5]]], // Greater Caucasus
  ['mountains', [[41.5, 41.8], [43.5, 41.5], [45.5, 41], [46.8, 39.8], [46.5, 38.9], [45, 39.4], [43.5, 40.5], [42, 41]]], // Lesser Caucasus
  ['mountains', [[33.5, 44.45], [34.4, 44.75], [35.3, 45.0], [35.4, 44.85], [34.5, 44.55], [33.7, 44.35]]], // Crimean
  ['mountains', [[5.5, 44], [7, 45.5], [6.8, 46.4], [8, 46.8], [10, 47.3], [12.5, 47.6], [15, 47.7], [16, 47.3], [15, 46.5], [13.5, 46.3], [12, 46], [10, 45.9], [8.5, 45.9],
    [7.5, 45], [7.2, 44.1]]], // Alps
  ['mountains', [[-1.8, 43.3], [0, 43], [1.5, 42.8], [3.1, 42.5], [2.5, 42.2], [1, 42.3], [-0.5, 42.6], [-1.8, 42.9]]], // Pyrenees
  ['mountains', [[-7.5, 43.2], [-4.5, 43.2], [-3.5, 43], [-4.5, 42.8], [-7, 42.6]]], // Cantabrian
  ['mountains', [[-5.3, 36.8], [-3, 37.2], [-2, 37.4], [-2.5, 36.9], [-4.5, 36.6]]], // Sierra Nevada
  ['mountains', [[9.5, 44.4], [11, 44.2], [12.5, 43.6], [13.7, 42.6], [14.5, 41.8], [15.8, 40.8], [16.3, 39.5], [16.3, 38.6], [15.8, 38.3], [15.7, 39.6], [15, 40.4],
    [14, 41.4], [13, 42.1], [12.3, 43.2], [11, 43.8], [9.5, 44.2]]], // Apennines
  ['mountains', [[18.5, 49.6], [20, 49.5], [22, 49.3], [23.5, 48.9], [24.5, 48.2], [25.5, 47.8], [26, 47], [26.4, 45.9], [25.5, 45.5], [24, 45.4], [22.5, 45.3], [22, 44.8],
    [22.6, 45.6], [24, 45.8], [25.3, 46], [25.2, 47], [24.4, 47.6], [23.2, 48.3], [22, 48.7], [20, 49.1], [18.7, 49.3]]], // Carpathians
  ['mountains', [[14.5, 45.5], [16, 45], [18, 43.8], [19.5, 43], [20.5, 42.3], [21, 41], [21.5, 40], [21.3, 39], [22.3, 38.2], [21.5, 38.4], [20.6, 39.5], [19.8, 40.4],
    [19.4, 41.8], [18.4, 42.5], [16.5, 43.4], [15.2, 44.3], [14.2, 45.1]]], // Dinarides, Pindus
  ['mountains', [[22.4, 43.6], [24, 43], [25.5, 42.9], [27.5, 42.8], [27.5, 42.6], [25.5, 42.6], [24, 42.7], [22.4, 43.2]]], // Balkan Mountains
  ['mountains', [[23, 42.3], [24.5, 42.1], [26, 41.6], [25.5, 41.3], [24, 41.4], [23, 41.8]]], // Rila, Rhodopes
  ['mountains', [[5.5, 59], [7, 60.5], [8, 62], [10.5, 63], [13, 64.5], [15, 66.5], [17, 68], [19, 69], [22, 70], [24, 70.8], [23, 69.4], [19.5, 68.4], [17.5, 67], [15.5, 65],
    [14, 63.5], [12.5, 62.5], [11.5, 61], [10, 60], [8.5, 59.2], [7, 58.5]]], // Scandinavian
  ['mountains', [[-6, 57], [-5, 58.6], [-3, 58.6], [-3, 57], [-4.5, 56.3], [-5.5, 56.3]]], // Scottish Highlands
  ['mountains', [[59.5, 51.5], [59.5, 54], [60, 56], [59.8, 58.5], [59.5, 61], [60.5, 64], [62, 65.5], [65, 67.5], [66.5, 68.5], [66, 67], [63, 65], [61, 63], [60.2, 61],
    [59, 59], [58.3, 56.5], [58, 54], [57.8, 52]]], // Urals
  ['mountains', [[31, 41], [34, 41.8], [36, 41.4], [38, 41], [40, 41], [42, 41.3], [41.5, 40.6], [39, 40.3], [36, 40.6], [33, 41], [31, 40.6]]], // Pontic
  ['mountains', [[28.5, 37], [30.5, 37.2], [32, 36.9], [33.5, 37], [35, 37.5], [37, 38], [39, 38.5], [42, 38.6], [43.5, 38.3], [43, 37.6], [40, 37.8], [37, 37.3], [35, 36.9],
    [33, 36.4], [31, 36.6], [29.5, 36.5]]], // Taurus
  ['mountains', [[48.5, 37], [50, 36.8], [52, 36.4], [54, 36.6], [56, 37.2], [58, 37.5], [59.5, 37], [61, 36.5], [60.5, 36], [58, 36.8], [55, 36.2], [53, 35.8], [51, 35.8],
    [49, 36.3]]], // Alborz, Kopet Dag
  ['forest', [[48.8, 38.4], [48.9, 37.4], [50, 37.0], [51, 36.75], [52.5, 36.65], [54, 36.75], [55, 37.1], [54.5, 37.35], [53, 36.95], [51.5, 37.0], [50.2, 37.45],
    [49.2, 38.4]]], // Hyrcanian forest
];

const KM_PX = 4; // the lookup grid: one cell per 4 km

export class Terrain {
  constructor(world, proj) {
    this.layers = LAYERS.map(([id, poly]) => {
      const p = new Path2D();
      poly.forEach(([lon, lat], i) => { const [x, y] = proj.xy(lon, lat); if (i) p.lineTo(x, y); else p.moveTo(x, y); });
      p.closePath();
      return [id, p];
    });
    this.world = world;
    // paint the map once into a grid over the field (each biome a grey level), so asking "what's here?" is one array read
    const [x0, y0, x1, y1] = world.bbox;
    this.x0 = x0 - 50; this.y0 = y0 - 50;
    this.w = Math.ceil((x1 - x0 + 100) / KM_PX); this.h = Math.ceil((y1 - y0 + 100) / KM_PX);
    const c = new OffscreenCanvas(this.w, this.h), g = c.getContext('2d');
    g.setTransform(1 / KM_PX, 0, 0, 1 / KM_PX, -this.x0 / KM_PX, -this.y0 / KM_PX);
    const shade = (id) => `rgb(${IDS.indexOf(id) * 16},0,0)`;
    g.fillStyle = shade('water'); g.fillRect(this.x0, this.y0, this.w * KM_PX, this.h * KM_PX);
    g.fillStyle = shade('farmland'); g.fill(world.land, 'evenodd');
    g.save(); g.clip(world.land, 'evenodd');
    for (const [id, p] of this.layers) { g.fillStyle = shade(id); g.fill(p); }
    g.restore();
    g.fillStyle = shade('water'); g.fill(world.lakes);
    const px = g.getImageData(0, 0, this.w, this.h).data;
    this.grid = new Uint8Array(this.w * this.h);
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = Math.min(IDS.length - 1, Math.round(px[i * 4] / 16));
  }

  /** The biome id at a point (km). */
  at(x, y) {
    const i = Math.floor((x - this.x0) / KM_PX), j = Math.floor((y - this.y0) / KM_PX);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return 'farmland';
    return IDS[this.grid[j * this.w + i]];
  }

  /** What the ground does to something at alt m over this point: { see, pk, burn } (all 1 when it's high). */
  effect(x, y, alt) {
    if (alt >= 600) return NONE;
    const b = BIOMES[this.at(x, y)];
    const e = alt < 120 ? b.deck : b.low;
    return { see: e.see, pk: e.pk, burn: e.burn || 1 };
  }

  /** How high a jet holding deck height really flies here: lower over flat water (sea-skimming). */
  skimAlt(x, y, alt) {
    if (alt > 120) return alt;
    const s = BIOMES[this.at(x, y)].deck.skim;
    return s ? Math.min(alt, s) : alt;
  }

  /** The overlay: every biome tinted, land first, inside the field. */
  draw(ctx, view) {
    ctx.save();
    ctx.translate(view.w / 2, view.h / 2);
    ctx.scale(view.scale, view.scale);
    ctx.translate(-view.cx, -view.cy);
    clipField(ctx, this.world);
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = BIOMES.farmland.col;
    ctx.fill(this.world.land, 'evenodd');
    ctx.save(); ctx.clip(this.world.land, 'evenodd');
    for (const [id, p] of this.layers) { ctx.fillStyle = BIOMES[id].col; ctx.fill(p); }
    ctx.restore();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = BIOMES.water.col;
    ctx.fill(this.world.lakes);
    ctx.restore();
  }
}
const NONE = { see: 1, pk: 1, burn: 1 };

/** "45%" for a factor, as a change ("−55%") where that reads better. */
export function describe(id) {
  const b = BIOMES[id];
  const pct = (f) => `${f > 1 ? '+' : f < 1 ? '−' : '±'}${Math.round(Math.abs(f - 1) * 100)}%`;
  const line = (label, e) => {
    if (e.see === 1 && e.pk === 1 && !e.burn) return `${label}: no effect`;
    const bits = [`radar range on you ${pct(e.see)}`, `missile hit chance ${pct(e.pk)}`];
    if (e.skim) bits.unshift(`skims at ${e.skim} m (shorter radar horizon; under the S-300’s 25 m floor)`);
    if (e.burn) bits.push(`fuel ${pct(e.burn)}`);
    return `${label}: ${bits.join(' · ')}`;
  };
  return { name: b.name, col: b.col, what: b.what, lines: [line('Deck', b.deck), line('Low', b.low), 'Medium / high: the ground makes no difference'] };
}
