// A small Mapbox Vector Tile (protobuf) reader for BoxMap: layers → features with their properties and geometry
// in tile units (0..extent). Geometry: points [[x,y],…], lines and polygons as arrays of rings [[x,y,x,y,…],…].

class Pbf {
  constructor(buf, pos = 0, end = buf.length) { this.buf = buf; this.pos = pos; this.end = end; }
  varint() {
    const b = this.buf;
    let v = 0, mul = 1, byte;
    do { byte = b[this.pos++]; v += (byte & 0x7f) * mul; mul *= 128; } while (byte & 0x80);
    return v;
  }
  svarint() { const v = this.varint(); return v % 2 === 1 ? (v + 1) / -2 : v / 2; }
  skip(wt) {
    if (wt === 0) this.varint();
    else if (wt === 1) this.pos += 8;
    else if (wt === 2) this.pos += this.varint();
    else if (wt === 5) this.pos += 4;
    else throw new Error('Bad tile');
  }
  sub() { const len = this.varint(); const p = new Pbf(this.buf, this.pos, this.pos + len); this.pos += len; return p; }
  string() { const len = this.varint(); const s = DEC.decode(this.buf.subarray(this.pos, this.pos + len)); this.pos += len; return s; }
}
const DEC = new TextDecoder();

function readValue(p) {
  let v = null;
  const dv = new DataView(p.buf.buffer, p.buf.byteOffset);
  while (p.pos < p.end) {
    const tag = p.varint(), f = tag >> 3, wt = tag & 7;
    if (f === 1) v = p.string();
    else if (f === 2) { v = dv.getFloat32(p.pos, true); p.pos += 4; }
    else if (f === 3) { v = dv.getFloat64(p.pos, true); p.pos += 8; }
    else if (f === 4 || f === 5) v = p.varint();
    else if (f === 6) v = p.svarint();
    else if (f === 7) v = !!p.varint();
    else p.skip(wt);
  }
  return v;
}

function packed(p) {
  const s = p.sub(), out = [];
  while (s.pos < s.end) out.push(s.varint());
  return out;
}

/** Commands → geometry (type 1 points, 2 lines, 3 polygons). */
function geometry(cmds, type) {
  const rings = [];
  let ring = null, x = 0, y = 0;
  const zz = (v) => (v >>> 1) ^ -(v & 1);
  for (let i = 0; i < cmds.length;) {
    const c = cmds[i++], id = c & 7, count = c >> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < count; k++) {
        x += zz(cmds[i++]); y += zz(cmds[i++]);
        if (id === 1) { ring = [x, y]; rings.push(ring); } else ring.push(x, y);
      }
    } else if (id === 7 && ring && type === 3) ring.push(ring[0], ring[1]);
  }
  if (type === 1) return rings.map((r) => [r[0], r[1]]);
  return rings;
}

/** { layerName: { extent, features: [{ type, props, geom }] } } */
export function decodeTile(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const top = new Pbf(buf);
  const layers = {};
  while (top.pos < top.end) {
    const tag = top.varint();
    if (tag >> 3 !== 3) { top.skip(tag & 7); continue; }
    const L = top.sub();
    let name = '', extent = 4096;
    const keys = [], values = [], feats = [];
    while (L.pos < L.end) {
      const t = L.varint(), f = t >> 3, wt = t & 7;
      if (f === 1) name = L.string();
      else if (f === 2) feats.push(L.sub());
      else if (f === 3) keys.push(L.string());
      else if (f === 4) values.push(readValue(L.sub()));
      else if (f === 5) extent = L.varint();
      else L.skip(wt);
    }
    const features = [];
    for (const F of feats) {
      let type = 0, tags = [], cmds = [];
      while (F.pos < F.end) {
        const t = F.varint(), f = t >> 3, wt = t & 7;
        if (f === 2) tags = packed(F);
        else if (f === 3) type = F.varint();
        else if (f === 4) cmds = packed(F);
        else F.skip(wt);
      }
      const props = {};
      for (let k = 0; k + 1 < tags.length; k += 2) props[keys[tags[k]]] = values[tags[k + 1]];
      features.push({ type, props, geom: geometry(cmds, type) });
    }
    layers[name] = { extent, features };
  }
  return layers;
}
