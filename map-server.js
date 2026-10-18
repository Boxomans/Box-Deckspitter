// BoxMap server side. Map regions are PMTiles files (v3) of OpenStreetMap vector tiles, cut out of the free daily
// world build at build.protomaps.com with HTTP range requests (only the tiles inside the chosen area are fetched),
// stored in data/maps/. Tiles are served to the page from there, so the map works with no connection at all.
// Optionally, places with no region show OpenStreetMap's own raster tiles while online, cached on disk (their tile
// policy: a real User-Agent, cache what you fetch, no bulk downloading, which is why regions don't come from there).
// Also: place search (the region's names + the built-in world map's cities) and pins.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const err = (status, message) => Object.assign(new Error(message), { status });
const BUILDS = 'https://build-metadata.protomaps.dev/builds.json';
const BUILD_URL = (key) => `https://build.protomaps.com/${key}`;
const ATTRIBUTION = '© OpenStreetMap contributors';
const MAX_TILES = 3_000_000;

// ---------------------------------------------------------------- PMTiles v3

function zxyToTileId(z, x, y) {
  let acc = 0;
  for (let i = 0; i < z; i++) acc += 4 ** i;
  const n = 2 ** z;
  let rx, ry, d = 0, tx = x, ty = y;
  for (let s = n / 2; s >= 1; s /= 2) {
    rx = (tx & s) > 0 ? 1 : 0;
    ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { tx = n - 1 - tx; ty = n - 1 - ty; }
      const t = tx; tx = ty; ty = t;
    }
  }
  return acc + d;
}

function readHeader(b) {
  if (b.toString('utf8', 0, 7) !== 'PMTiles' || b[7] !== 3) throw err(400, 'Not a PMTiles v3 map');
  const u = (o) => Number(b.readBigUInt64LE(o));
  const i = (o) => b.readInt32LE(o) / 1e7;
  return {
    rootOffset: u(8), rootLength: u(16), metaOffset: u(24), metaLength: u(32), leafOffset: u(40), leafLength: u(48),
    dataOffset: u(56), dataLength: u(64), addressed: u(72), entries: u(80), contents: u(88),
    clustered: b[96], internalCompression: b[97], tileCompression: b[98], tileType: b[99], minZoom: b[100], maxZoom: b[101],
    minLon: i(102), minLat: i(106), maxLon: i(110), maxLat: i(114), centerZoom: b[118], centerLon: i(119), centerLat: i(123),
  };
}

function writeHeader(h) {
  const b = Buffer.alloc(127);
  b.write('PMTiles', 0, 'utf8'); b[7] = 3;
  const u = (o, v) => b.writeBigUInt64LE(BigInt(v), o);
  const i = (o, v) => b.writeInt32LE(Math.round(v * 1e7), o);
  u(8, h.rootOffset); u(16, h.rootLength); u(24, h.metaOffset); u(32, h.metaLength); u(40, h.leafOffset); u(48, h.leafLength);
  u(56, h.dataOffset); u(64, h.dataLength); u(72, h.addressed); u(80, h.entries); u(88, h.contents);
  b[96] = h.clustered; b[97] = h.internalCompression; b[98] = h.tileCompression; b[99] = h.tileType; b[100] = h.minZoom; b[101] = h.maxZoom;
  i(102, h.minLon); i(106, h.minLat); i(110, h.maxLon); i(114, h.maxLat); b[118] = h.centerZoom; i(119, h.centerLon); i(123, h.centerLat);
  return b;
}

const decompress = (buf, kind) => (kind === 2 ? zlib.gunzipSync(buf) : kind === 1 ? buf : kind === 3 ? zlib.brotliDecompressSync(buf) : (() => { throw err(400, 'Unsupported map compression'); })());

function readDirectory(buf) {
  let pos = 0;
  const varint = () => {
    let v = 0, mul = 1, byte;
    do { byte = buf[pos++]; v += (byte & 0x7f) * mul; mul *= 128; } while (byte & 0x80);
    return v;
  };
  const n = varint();
  const e = Array.from({ length: n }, () => ({ tileId: 0, offset: 0, length: 0, runLength: 1 }));
  let last = 0;
  for (let k = 0; k < n; k++) { last += varint(); e[k].tileId = last; }
  for (let k = 0; k < n; k++) e[k].runLength = varint();
  for (let k = 0; k < n; k++) e[k].length = varint();
  for (let k = 0; k < n; k++) {
    const v = varint();
    e[k].offset = v === 0 && k > 0 ? e[k - 1].offset + e[k - 1].length : v - 1;
  }
  return e;
}

function writeDirectory(entries) {
  const out = [];
  const varint = (v) => { while (v >= 128) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); } out.push(v); };
  varint(entries.length);
  let last = 0;
  for (const e of entries) { varint(e.tileId - last); last = e.tileId; }
  for (const e of entries) varint(e.runLength);
  for (const e of entries) varint(e.length);
  entries.forEach((e, k) => varint(k > 0 && e.offset === entries[k - 1].offset + entries[k - 1].length ? 0 : e.offset + 1));
  return zlib.gzipSync(Buffer.from(out));
}

function findEntry(entries, tileId) {
  let lo = 0, hi = entries.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const c = tileId - entries[m].tileId;
    if (c > 0) lo = m + 1; else if (c < 0) hi = m - 1; else return entries[m];
  }
  if (hi >= 0) {
    const e = entries[hi];
    if (e.runLength === 0) return e; // a leaf directory that may hold it
    if (tileId - e.tileId < e.runLength) return e;
  }
  return null;
}

/** A PMTiles archive read through `read(offset, length) → Buffer` (a local file or HTTP ranges). */
function archive(read) {
  let header = null;
  const dirs = new Map(); // `${offset}:${length}` → entries (a small cache)
  async function head() {
    if (header) return header;
    const b = await read(0, 16384);
    header = readHeader(b);
    // the root directory usually comes in the same first read
    if (header.rootOffset + header.rootLength <= b.length) dirs.set(`r`, readDirectory(decompress(b.subarray(header.rootOffset, header.rootOffset + header.rootLength), header.internalCompression)));
    return header;
  }
  async function dir(key, offset, length) {
    let d = dirs.get(key);
    if (!d) {
      d = readDirectory(decompress(await read(offset, length), header.internalCompression));
      if (dirs.size > 400) dirs.delete(dirs.keys().next().value);
      dirs.set(key, d);
    }
    return d;
  }
  /** { offset (in the data section), length } of a tile, or null. */
  async function locate(tileId) {
    const h = await head();
    let entries = await dir('r', h.rootOffset, h.rootLength);
    for (let depth = 0; depth < 4; depth++) {
      const e = findEntry(entries, tileId);
      if (!e) return null;
      if (e.runLength > 0) return { offset: e.offset, length: e.length };
      entries = await dir(`${e.offset}:${e.length}`, h.leafOffset + e.offset, e.length);
    }
    return null;
  }
  async function tile(tileId) {
    const loc = await locate(tileId);
    if (!loc) return null;
    return read(header.dataOffset + loc.offset, loc.length);
  }
  async function metadata() {
    const h = await head();
    if (!h.metaLength) return {};
    try { return JSON.parse(decompress(await read(h.metaOffset, h.metaLength), h.internalCompression).toString('utf8')); } catch { return {}; }
  }
  return { head, locate, tile, metadata };
}

function remoteArchive(url, signal) {
  return archive(async (offset, length) => {
    for (let tries = 0; ; tries++) {
      try {
        const r = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}`, 'User-Agent': 'Box-Deckspitter map' }, signal });
        if (r.status !== 206 && r.status !== 200) throw new Error(`Map server answered ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      } catch (e) {
        if (signal?.aborted || tries >= 3) throw e;
        await new Promise((res) => setTimeout(res, 800 * (tries + 1)));
      }
    }
  });
}

function fileArchive(file) {
  let fh = null;
  const a = archive(async (offset, length) => {
    fh ||= await fsp.open(file, 'r');
    const b = Buffer.alloc(length);
    const { bytesRead } = await fh.read(b, 0, length, offset);
    return b.subarray(0, bytesRead);
  });
  a.close = () => { fh?.close().catch(() => {}); fh = null; };
  return a;
}

/** The root directory (fits in the first 16 KB with the header) and, for big maps, the leaf directories after it. */
function buildDirectories(entries, maxRoot = 16384 - 127) {
  const root = writeDirectory(entries);
  if (root.length <= maxRoot) return { root, leaves: Buffer.alloc(0) };
  for (let size = 4096; ; size *= 2) {
    const leafBufs = [], rootEntries = [];
    let at = 0;
    for (let k = 0; k < entries.length; k += size) {
      const chunk = entries.slice(k, k + size);
      const b = writeDirectory(chunk);
      rootEntries.push({ tileId: chunk[0].tileId, offset: at, length: b.length, runLength: 0 });
      leafBufs.push(b);
      at += b.length;
    }
    const r = writeDirectory(rootEntries);
    if (r.length <= maxRoot) return { root: r, leaves: Buffer.concat(leafBufs) };
  }
}

// ---------------------------------------------------------------- tiles of an area

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => { const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
const clampT = (v, z) => Math.max(0, Math.min(2 ** z - 1, v));

function tileRange(bbox, z) {
  const [w, s, e, n] = bbox;
  return { x0: clampT(lon2x(w, z), z), x1: clampT(lon2x(e, z), z), y0: clampT(lat2y(n, z), z), y1: clampT(lat2y(s, z), z) };
}
function countTiles(bbox, maxZoom) {
  let n = 0;
  for (let z = 0; z <= maxZoom; z++) { const r = tileRange(bbox, z); n += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1); }
  return n;
}
function* tilesOf(bbox, maxZoom) {
  for (let z = 0; z <= maxZoom; z++) {
    const r = tileRange(bbox, z);
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield [z, x, y];
  }
}

// ---------------------------------------------------------------- reading names out of vector tiles (for search)

/** The named points and lines of a few layers of an MVT tile → [[name, kind, lon, lat]]. */
function tileNames(buf, z, x, y, layersWanted) {
  const out = [];
  let pos = 0;
  const end0 = buf.length;
  const varint = (b) => { let v = 0, mul = 1, byte; do { byte = b.buf[b.pos++]; v += (byte & 0x7f) * mul; mul *= 128; } while (byte & 0x80); return v; };
  const reader = (bf, p, end) => ({ buf: bf, pos: p, end });
  const skip = (r, wt) => { if (wt === 0) varint(r); else if (wt === 1) r.pos += 8; else if (wt === 2) { const l = varint(r); r.pos += l; } else if (wt === 5) r.pos += 4; };
  const top = reader(buf, pos, end0);
  while (top.pos < top.end) {
    const tag = varint(top), f = Math.floor(tag / 8), wt = tag & 7;
    if (f !== 3 || wt !== 2) { skip(top, wt); continue; }
    const len = varint(top);
    const L = reader(buf, top.pos, top.pos + len);
    top.pos += len;
    let name = '', extent = 4096;
    const keys = [], values = [], feats = [];
    while (L.pos < L.end) {
      const t = varint(L), ff = Math.floor(t / 8), w = t & 7;
      if (ff === 1 && w === 2) { const l = varint(L); name = buf.toString('utf8', L.pos, L.pos + l); L.pos += l; }
      else if (ff === 2 && w === 2) { const l = varint(L); feats.push([L.pos, L.pos + l]); L.pos += l; }
      else if (ff === 3 && w === 2) { const l = varint(L); keys.push(buf.toString('utf8', L.pos, L.pos + l)); L.pos += l; }
      else if (ff === 4 && w === 2) {
        const l = varint(L); const V = reader(buf, L.pos, L.pos + l); L.pos += l;
        let v = null;
        while (V.pos < V.end) {
          const vt = varint(V), vf = Math.floor(vt / 8), vw = vt & 7;
          if (vf === 1 && vw === 2) { const sl = varint(V); v = buf.toString('utf8', V.pos, V.pos + sl); V.pos += sl; } else { skip(V, vw); }
        }
        values.push(v);
      } else if (ff === 5 && w === 0) extent = varint(L);
      else skip(L, w);
    }
    if (!layersWanted.includes(name)) continue;
    for (const [a, b] of feats) {
      const F = reader(buf, a, b);
      let tags = [], geom = null;
      while (F.pos < F.end) {
        const t = varint(F), ff = Math.floor(t / 8), w = t & 7;
        if ((ff === 2 || ff === 4) && w === 2) {
          const l = varint(F); const P = reader(buf, F.pos, F.pos + l); F.pos += l;
          const arr = []; while (P.pos < P.end) arr.push(varint(P));
          if (ff === 2) tags = arr; else geom = arr;
        } else skip(F, w);
      }
      const props = {};
      for (let k = 0; k + 1 < tags.length; k += 2) props[keys[tags[k]]] = values[tags[k + 1]];
      const nm = props['name:en'] || props.name;
      if (!nm || !geom || geom.length < 3) continue;
      // first point of the geometry is enough to find it again
      const zz = (v) => (v >>> 1) ^ -(v & 1);
      const px = zz(geom[1]), py = zz(geom[2]);
      const n = 2 ** z;
      const mx = (x + px / extent) / n, my = (y + py / extent) / n;
      const lon = mx * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
      out.push([nm, props.kind || name, Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the routes

module.exports = function createMap({ readJSONBody, newJob, startJob, dataDir, cacheDir, worldFile, readJSON, writeJSON, version, log }) {
  const mapsDir = path.join(dataDir, 'maps');
  const pinsFile = path.join(dataDir, 'map-pins.json');
  const settingsFile = path.join(dataDir, 'map.json');
  const open = new Map(); // region id → file archive
  let buildCache = null; // { at, key }
  let world = null;

  async function regions() {
    await fsp.mkdir(mapsDir, { recursive: true });
    const out = [];
    for (const f of await fsp.readdir(mapsDir)) {
      if (!f.endsWith('.json') || f.endsWith('.search.json')) continue;
      const meta = readJSON(path.join(mapsDir, f), null);
      if (meta?.id && fs.existsSync(path.join(mapsDir, `${meta.id}.pmtiles`))) out.push(meta);
    }
    return out.sort((a, b) => (b.maxZoom - a.maxZoom) || (a.name || '').localeCompare(b.name || ''));
  }
  const regionArchive = (id) => {
    let a = open.get(id);
    if (!a) { a = fileArchive(path.join(mapsDir, `${id}.pmtiles`)); open.set(id, a); }
    return a;
  };

  async function latestBuild() {
    if (buildCache && Date.now() - buildCache.at < 6 * 3600 * 1000) return buildCache.key;
    const r = await fetch(BUILDS, { headers: { 'User-Agent': `Box-Deckspitter/${version}` } });
    if (!r.ok) throw err(502, 'Couldn’t reach the map download server');
    const list = await r.json();
    const key = list.filter((b) => /^\d{8}\.pmtiles$/.test(b.key)).map((b) => b.key).sort().pop();
    if (!key) throw err(502, 'No map build to download from');
    buildCache = { at: Date.now(), key };
    return key;
  }

  function checkArea(body) {
    const b = (body.bbox || []).map(Number);
    if (b.length !== 4 || b.some((v) => !Number.isFinite(v))) throw err(400, 'Pick an area first');
    const bbox = [Math.max(-180, b[0]), Math.max(-85, b[1]), Math.min(180, b[2]), Math.min(85, b[3])];
    if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) throw err(400, 'That area is empty');
    const maxZoom = Math.max(6, Math.min(15, Math.round(+body.maxZoom || 15)));
    return { bbox, maxZoom };
  }

  /** Which source tiles an area needs: [{ tileId, offset, length }] sorted by tile id. */
  async function plan(src, bbox, maxZoom, job) {
    const total = countTiles(bbox, maxZoom);
    if (total > MAX_TILES) throw err(400, `That’s ${total.toLocaleString()} tiles: pick a smaller area or less detail`);
    const ids = [];
    for (const [z, x, y] of tilesOf(bbox, maxZoom)) ids.push(zxyToTileId(z, x, y));
    ids.sort((a, b) => a - b);
    const found = [];
    for (let k = 0; k < ids.length; k++) {
      if (job?.status === 'cancelled') throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      const loc = await src.locate(ids[k]);
      if (loc) found.push({ tileId: ids[k], offset: loc.offset, length: loc.length });
      if (job && k % 500 === 0) { job.progress = 0.15 * (k / ids.length); job.phase = 'Finding the tiles'; }
    }
    return found;
  }

  async function download(job, { name, bbox, maxZoom }) {
    const ctl = new AbortController();
    job.cancel = () => ctl.abort();
    const key = await latestBuild();
    const src = remoteArchive(BUILD_URL(key), ctl.signal);
    const h = await src.head();
    const meta = await src.metadata();
    const want = await plan(src, bbox, maxZoom, job);
    if (!want.length) throw err(400, 'No map there');
    await fsp.mkdir(mapsDir, { recursive: true });
    const id = crypto.randomBytes(6).toString('hex');
    const final = path.join(mapsDir, `${id}.pmtiles`);
    const dataTmp = `${final}.data.part`;
    job.path = final;
    // the tiles' bytes, fetched in a few big ranges (tiles near each other are stored near each other)
    const unique = [...new Map(want.map((t) => [t.offset, t])).values()].sort((a, b) => a.offset - b.offset);
    const ranges = [];
    for (const t of unique) {
      const r = ranges[ranges.length - 1];
      if (r && t.offset - (r.end) < 32 * 1024 && t.offset + t.length - r.start < 16 * 1024 * 1024) { r.end = Math.max(r.end, t.offset + t.length); r.tiles.push(t); }
      else ranges.push({ start: t.offset, end: t.offset + t.length, tiles: [t] });
    }
    const totalBytes = ranges.reduce((n, r) => n + r.end - r.start, 0);
    job.total = totalBytes;
    job.phase = 'Downloading';
    const out = await fsp.open(dataTmp, 'w');
    const newOffset = new Map(); // source offset → offset in the new file
    let written = 0, fetched = 0;
    const names = new Map();
    const zxyOf = new Map(); // tile id → [z,x,y] (for reading names)
    for (const [z, x, y] of tilesOf(bbox, maxZoom)) if (z >= Math.min(12, maxZoom)) zxyOf.set(zxyToTileId(z, x, y), [z, x, y]);
    const idsByOffset = new Map();
    for (const t of want) { if (!idsByOffset.has(t.offset)) idsByOffset.set(t.offset, []); idsByOffset.get(t.offset).push(t.tileId); }
    try {
      // a few ranges at a time, written in order
      const queue = ranges.slice();
      const inflight = [];
      const fetchRange = (r) => (async () => {
        const res = await fetch(BUILD_URL(key), { headers: { Range: `bytes=${h.dataOffset + r.start}-${h.dataOffset + r.end - 1}`, 'User-Agent': `Box-Deckspitter/${version}` }, signal: ctl.signal });
        if (res.status !== 206) throw new Error(`Map server answered ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      })();
      for (let k = 0; k < Math.min(4, queue.length); k++) inflight.push({ r: queue[k], p: fetchRange(queue[k]) });
      let next = inflight.length;
      while (inflight.length) {
        const { r, p } = inflight.shift();
        const buf = await p;
        if (next < queue.length) { inflight.push({ r: queue[next], p: fetchRange(queue[next]) }); next++; }
        for (const t of r.tiles) {
          const body = buf.subarray(t.offset - r.start, t.offset - r.start + t.length);
          await out.write(body, 0, body.length, written);
          newOffset.set(t.offset, written);
          written += body.length;
          // names for search, from the detailed zooms
          for (const tid of idsByOffset.get(t.offset) || []) {
            const zxy = zxyOf.get(tid);
            if (!zxy) continue;
            try {
              const raw = h.tileCompression === 2 ? zlib.gunzipSync(body) : body;
              const layers = zxy[0] >= Math.min(14, maxZoom) ? ['places', 'pois', 'roads', 'water', 'physical_point'] : ['places'];
              for (const n of tileNames(raw, ...zxy, layers)) {
                const k = `${n[0]}|${n[1]}|${n[2].toFixed(2)}|${n[3].toFixed(2)}`;
                if (!names.has(k)) names.set(k, n);
              }
            } catch { /* a tile that doesn't decode just isn't searchable */ }
            break; // the same bytes elsewhere (open sea) name nothing new
          }
        }
        fetched += r.end - r.start;
        job.bytes = fetched;
        job.progress = 0.15 + 0.8 * (fetched / totalBytes);
      }
    } catch (e) {
      await out.close().catch(() => {});
      await fsp.unlink(dataTmp).catch(() => {});
      throw e;
    }
    await out.close();

    // the directory: runs of tiles with the same bytes become one entry
    job.phase = 'Writing';
    const entries = [];
    for (const t of want) {
      const off = newOffset.get(t.offset);
      const last = entries[entries.length - 1];
      if (last && last.offset === off && last.length === t.length && last.tileId + last.runLength === t.tileId) last.runLength++;
      else entries.push({ tileId: t.tileId, offset: off, length: t.length, runLength: 1 });
    }
    const { root, leaves } = buildDirectories(entries);
    const metaOut = zlib.gzipSync(Buffer.from(JSON.stringify({ ...meta, name, attribution: ATTRIBUTION, 'boxmap:bbox': bbox, 'boxmap:build': key })));
    const header = {
      rootOffset: 127, rootLength: root.length, metaOffset: 127 + root.length, metaLength: metaOut.length,
      leafOffset: 127 + root.length + metaOut.length, leafLength: leaves.length,
      dataOffset: 127 + root.length + metaOut.length + leaves.length, dataLength: written,
      addressed: want.length, entries: entries.length, contents: newOffset.size,
      clustered: 0, internalCompression: 2, tileCompression: h.tileCompression, tileType: h.tileType, minZoom: 0, maxZoom,
      minLon: bbox[0], minLat: bbox[1], maxLon: bbox[2], maxLat: bbox[3],
      centerZoom: Math.min(maxZoom, 12), centerLon: (bbox[0] + bbox[2]) / 2, centerLat: (bbox[1] + bbox[3]) / 2,
    };
    const tmp = `${final}.part`;
    const w = fs.createWriteStream(tmp);
    w.write(writeHeader(header)); w.write(root); w.write(metaOut); w.write(leaves);
    await new Promise((res, rej) => { const rs = fs.createReadStream(dataTmp); rs.on('error', rej); rs.pipe(w); w.on('finish', res); w.on('error', rej); });
    await fsp.rename(tmp, final);
    await fsp.unlink(dataTmp).catch(() => {});
    const st = await fsp.stat(final);
    await writeJSON(path.join(mapsDir, `${id}.search.json`), [...names.values()]);
    const info = { id, name, bbox, maxZoom, build: key, size: st.size, tiles: want.length, created: Date.now() };
    await writeJSON(path.join(mapsDir, `${id}.json`), info);
    job.result = info;
    job.path = null;
    log(`map: saved ${name} (${(st.size / 1e6).toFixed(1)} MB, ${want.length} tiles)`);
  }

  const searchCache = new Map(); // region id → names
  function regionNames(id) {
    let n = searchCache.get(id);
    if (!n) { n = readJSON(path.join(mapsDir, `${id}.search.json`), []); searchCache.set(id, n); }
    return n;
  }
  function worldPlaces() {
    if (!world) { try { world = JSON.parse(fs.readFileSync(worldFile, 'utf8')).places || []; } catch { world = []; } }
    return world;
  }

  // OpenStreetMap raster tiles, while online: a small, polite disk cache
  const osmDir = path.join(cacheDir, 'osm');
  let osmBusy = 0;
  const osmWait = [];
  async function osmSlot() { if (osmBusy < 2) { osmBusy++; return; } await new Promise((r) => osmWait.push(r)); osmBusy++; }
  const osmDone = () => { osmBusy--; osmWait.shift()?.(); };

  return {
    'GET /api/map/regions': async () => ({ regions: await regions(), attribution: ATTRIBUTION }),

    'POST /api/map/estimate': async (req) => {
      const { bbox, maxZoom } = checkArea(await readJSONBody(req));
      const tiles = countTiles(bbox, maxZoom);
      if (tiles > MAX_TILES) return { tiles, tooBig: true };
      // the size, from the real directory when it's quick to read, else a rough guess per tile
      let bytes = null;
      if (tiles <= 60000) {
        const src = remoteArchive(BUILD_URL(await latestBuild()));
        const found = await plan(src, bbox, maxZoom);
        bytes = [...new Map(found.map((t) => [t.offset, t.length])).values()].reduce((a, b) => a + b, 0);
      }
      return { tiles, bytes, guess: bytes == null ? tiles * 9000 : null };
    },

    'POST /api/map/download': async (req) => {
      const body = await readJSONBody(req);
      const area = checkArea(body);
      const name = String(body.name || 'Map').trim().slice(0, 80) || 'Map';
      const job = newJob(`Downloading the map of ${name}`);
      return startJob(job, () => download(job, { name, ...area }));
    },

    'POST /api/map/regions/remove': async (req) => {
      const { id } = await readJSONBody(req);
      if (!/^[0-9a-f]{12}$/.test(String(id))) throw err(400, 'Bad id');
      open.get(id)?.close?.(); open.delete(id); searchCache.delete(id);
      for (const ext of ['.pmtiles', '.json', '.search.json']) await fsp.unlink(path.join(mapsDir, `${id}${ext}`)).catch(() => {});
      return { ok: true };
    },
    'POST /api/map/regions/rename': async (req) => {
      const { id, name } = await readJSONBody(req);
      const f = path.join(mapsDir, `${id}.json`);
      const meta = /^[0-9a-f]{12}$/.test(String(id)) && readJSON(f, null);
      if (!meta) throw err(404, 'No such map');
      meta.name = String(name || '').trim().slice(0, 80) || meta.name;
      await writeJSON(f, meta);
      return { ok: true };
    },

    // one vector tile from whichever region has it (most detailed first); 204 when none does
    'GET /api/map/tile': async (req, q) => {
      const z = +q.get('z'), x = +q.get('x'), y = +q.get('y');
      if (![z, x, y].every(Number.isInteger) || z < 0 || z > 15) throw err(400, 'Bad tile');
      const id = q.get('r');
      const list = id ? (await regions()).filter((r) => r.id === id) : await regions();
      const tid = zxyToTileId(z, x, y);
      for (const r of list) {
        if (z > r.maxZoom) continue;
        const a = regionArchive(r.id);
        const h = await a.head();
        const t = await a.tile(tid);
        if (t?.length) return { raw: t, type: 'application/x-protobuf', headers: { ...(h.tileCompression === 2 ? { 'Content-Encoding': 'gzip' } : {}), 'Cache-Control': 'private, max-age=86400' } };
      }
      return { raw: Buffer.alloc(0), status: 204, type: 'application/x-protobuf' };
    },

    'GET /api/map/osm': async (req, q) => {
      const z = +q.get('z'), x = +q.get('x'), y = +q.get('y');
      if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw err(400, 'Bad tile');
      const file = path.join(osmDir, String(z), String(x), `${y}.png`);
      const st = await fsp.stat(file).catch(() => null);
      // kept at least a week (their policy), then refreshed when seen again online
      if (st && Date.now() - st.mtimeMs < 30 * 86400 * 1000) return { raw: await fsp.readFile(file), type: 'image/png', headers: { 'Cache-Control': 'private, max-age=604800' } };
      await osmSlot();
      try {
        const r = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, { headers: { 'User-Agent': `Box-Deckspitter/${version} (desktop app; map viewer)` } });
        if (!r.ok) throw new Error(String(r.status));
        const b = Buffer.from(await r.arrayBuffer());
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, b);
        return { raw: b, type: 'image/png', headers: { 'Cache-Control': 'private, max-age=604800' } };
      } catch {
        if (st) return { raw: await fsp.readFile(file), type: 'image/png' }; // offline: the old copy
        return { raw: Buffer.alloc(0), status: 204, type: 'image/png' };
      } finally { osmDone(); }
    },

    'GET /api/map/search': async (req, q) => {
      const s = String(q.get('q') || '').trim().toLowerCase();
      if (s.length < 2) return { results: [] };
      const hits = [];
      const score = (name) => { const n = name.toLowerCase(); return n === s ? 0 : n.startsWith(s) ? 1 : n.includes(s) ? 2 : -1; };
      for (const r of await regions()) {
        if (r.name.toLowerCase().includes(s)) hits.push({ name: r.name, kind: 'downloaded map', bbox: r.bbox, s: 0 });
        for (const [name, kind, lon, lat] of regionNames(r.id)) {
          const sc = score(name);
          if (sc >= 0) hits.push({ name, kind: String(kind).replace(/_/g, ' '), lon, lat, where: r.name, s: sc + 0.5 });
        }
      }
      for (const [name, lon, lat, rank, pop, cap, country, region] of worldPlaces()) {
        const sc = score(name);
        if (sc >= 0) hits.push({ name, kind: cap ? 'capital' : 'city', lon, lat, where: [region, country].filter(Boolean).join(', '), s: sc + rank / 20 - Math.log10((pop || 1) + 1) / 20 });
      }
      hits.sort((a, b) => a.s - b.s);
      const seen = new Set();
      const results = [];
      for (const hh of hits) {
        const k = `${hh.name}|${hh.lon?.toFixed?.(2)}|${hh.lat?.toFixed?.(2)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const { s: _, ...rest } = hh;
        void _;
        results.push(rest);
        if (results.length >= 40) break;
      }
      return { results };
    },

    'GET /api/map/pins': async () => ({ pins: readJSON(pinsFile, []), settings: readJSON(settingsFile, {}) }),
    'POST /api/map/pins': async (req) => {
      const { pins } = await readJSONBody(req);
      if (!Array.isArray(pins)) throw err(400, 'Bad pins');
      const clean = pins.slice(0, 5000).map((p) => ({ id: String(p.id || crypto.randomBytes(4).toString('hex')).slice(0, 20), lon: +p.lon, lat: +p.lat, name: String(p.name || '').slice(0, 120), note: String(p.note || '').slice(0, 4000), color: String(p.color || '').slice(0, 20) }))
        .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
      await writeJSON(pinsFile, clean);
      return { ok: true };
    },
    'POST /api/map/settings': async (req) => {
      const body = await readJSONBody(req);
      await writeJSON(settingsFile, { ...readJSON(settingsFile, {}), ...body });
      return { ok: true };
    },
  };
};

module.exports.zxyToTileId = zxyToTileId;
module.exports.tileNames = tileNames;
module.exports.buildDirectories = buildDirectories;
module.exports.archive = archive;
module.exports.writeHeader = writeHeader;
module.exports.remoteArchive = remoteArchive;
