// BoxMend: a recording cut off before its index was written (an MP4 or MOV with no "moov"), rebuilt with the help of
// a working video from the same camera or program. The frames are all still there, one after another; what's missing
// is the list of where each one starts. The picture's frames each start with their own length, so they can be walked
// through; what lies between runs of picture frames is the sound. AAC sound frames carry no length, so the file is cut
// at every place one could start (the starts the working video's sound frames have), and the pieces ffmpeg can't play
// are joined to their neighbours until every piece plays. The working video gives what the broken one never wrote:
// the picture's settings (SPS/PPS), the frame rate and the sound's format. Nothing is re-made: the frames are copied
// as they were recorded.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

/** Run a program; its output and log come back (stdout as a Buffer). */
function exec(exe, args, job) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (job) job.cancel = () => { job.status = 'cancelled'; p.kill(); };
    const out = [];
    let log = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { log = (log + d).slice(-20000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (job?.status === 'cancelled') return reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      resolve({ code, out: Buffer.concat(out), log });
    });
  });
}

/** The NAL units in an Annex B stream (00 00 01 / 00 00 00 01 between them). */
function annexB(buf) {
  const units = [];
  let start = -1;
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) units.push(buf.subarray(start, buf[i - 1] === 0 ? i - 1 : i));
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0) units.push(buf.subarray(start));
  return units;
}

/** What a NAL unit header says, for H.264 and H.265: its type, and whether it's a picture slice. */
const CODECS = {
  h264: {
    type: (b) => b & 31,
    vcl: (t) => t >= 1 && t <= 5,
    ok: (b) => { const t = b & 31; return !(b & 0x80) && [1, 5, 6, 7, 8, 9, 12].includes(t) && (t !== 5 || (b & 0x60)); },
  },
  hevc: {
    type: (b) => (b >> 1) & 63,
    vcl: (t) => t <= 31,
    ok: (b, b2) => { const t = (b >> 1) & 63; return !(b & 0x80) && (t <= 9 || (t >= 16 && t <= 21) || (t >= 32 && t <= 40)) && (b2 & 7) !== 0; },
  },
};

/** Reads a big file in windows, so a recording of any size never has to fit in memory. */
class Reader {
  constructor(fd, size) { this.fd = fd; this.size = size; this.buf = Buffer.alloc(0); this.at = 0; }
  has(p, n) { return p >= this.at && p + n <= this.at + this.buf.length; }
  async ensure(p, n) {
    if (this.has(p, n)) return;
    const len = Math.max(32 << 20, n);
    if (this.buf.length < len) this.buf = Buffer.alloc(len);
    const { bytesRead } = await this.fd.read(this.buf, 0, Math.min(len, this.size - p), p);
    this.at = p;
    this.buf = this.buf.length === bytesRead ? this.buf : this.buf.subarray(0, bytesRead);
  }
  u8(p) { return this.buf[p - this.at]; }
  u32(p) { return this.buf.readUInt32BE(p - this.at); }
  async bytes(p, n) { const b = Buffer.alloc(n); await this.fd.read(b, 0, n, p); return b; }
}

/** Where the frames are: inside the "mdat" box (to its end, or the file's when the size was never written). */
async function findMdat(fd, size) {
  const h = Buffer.alloc(16);
  let o = 0;
  while (o + 8 <= size) {
    await fd.read(h, 0, 16, o);
    let s = h.readUInt32BE(0), head = 8;
    const t = h.toString('latin1', 4, 8);
    if (s === 1) { s = Number(h.readBigUInt64BE(8)); head = 16; }
    if (s === 0) s = size - o;
    if (t === 'mdat') return { start: o + head, end: Math.min(size, o + s) };
    if (s < 8 || !/^[\x20-\x7e]{4}$/.test(t)) break;
    o += s;
  }
  return null;
}

/** The end of the real data: recorders often set aside room that was never written, left as zeros. */
async function lastData(fd, start, end) {
  const b = Buffer.alloc(1 << 20);
  for (let e = end; e > start;) {
    const from = Math.max(start, e - b.length);
    await fd.read(b, 0, e - from, from);
    for (let i = e - from - 1; i >= 0; i--) if (b[i]) return from + i + 1;
    e = from;
  }
  return start;
}

/**
 * Rebuild `file` with `ref`'s help into `out`. info: what the working video is (look() in mend-server.js).
 * Returns { frames, sounds, fps, seconds, note }.
 */
async function rebuild(job, { file, ref, refInfo, out, tmp, ffmpeg }) {
  const kind = refInfo.video?.codec;
  const codec = CODECS[kind];
  if (!codec) throw new Error(`The working video’s picture is ${kind || 'missing'}; rebuilding works for H.264 and H.265 recordings.`);
  const fps = refInfo.fps || 30;
  const ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe' + path.extname(ffmpeg));

  // the picture's settings, from the working video's first frame
  job.step = 'Reading the working video';
  const first = await exec(ffmpeg, ['-v', 'error', '-i', ref, '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', `${kind}_mp4toannexb`, '-frames:v', '1', '-f', kind, 'pipe:1'], job);
  const params = [];
  for (const u of annexB(first.out)) { if (codec.vcl(codec.type(u[0]))) break; params.push(u); }
  if (!params.length) throw new Error('The working video’s picture settings couldn’t be read.');

  // the sound's format, and how its frames start, from the working video's sound (AAC only)
  let adtsHead = null, starts = null, lead = null;
  const channels = /stereo/.test(refInfo.audio?.layout || '') ? 2 : /mono/.test(refInfo.audio?.layout || '') ? 1 : 2;
  if (refInfo.audio?.codec === 'aac' && fs.existsSync(ffprobe)) {
    const a = (await exec(ffmpeg, ['-v', 'error', '-i', ref, '-map', '0:a:0', '-c:a', 'copy', '-f', 'adts', '-frames:a', '400', 'pipe:1'], job)).out;
    starts = new Set();
    for (let o = 0; o + 7 < a.length && a[o] === 0xff;) {
      const len = ((a[o + 3] & 3) << 11) | (a[o + 4] << 3) | (a[o + 5] >> 5), hl = a[o + 1] & 1 ? 7 : 9;
      if (!adtsHead) { adtsHead = Buffer.from(a.subarray(o, o + 7)); adtsHead[1] |= 1; lead = Buffer.from(a.subarray(o, o + len)); }
      if (len > hl + 1) starts.add(a[o + hl] * 16 + (a[o + hl + 1] & 15));
      o += len || 1;
    }
    if (!adtsHead || !starts.size) adtsHead = starts = null;
  }

  const fd = await fsp.open(file, 'r');
  const tmpV = path.join(tmp, kind === 'hevc' ? 'v.265' : 'v.264'), tmpA = path.join(tmp, 'a.aac');
  let frames = 0, sounds = 0;
  try {
    const { size } = await fd.stat();
    const mdat = await findMdat(fd, size);
    if (!mdat) throw new Error('No frames could be found in it (its frame data is missing).');
    const start = mdat.start, end = await lastData(fd, mdat.start, mdat.end);
    if (end - start < 1024) throw new Error('Nothing was recorded into it: the space set aside for the frames is empty.');

    // ---- walk it: runs of picture frames (each starting with its length), and the gaps between them
    job.step = 'Finding the frames';
    const r = new Reader(fd, size);
    const nalAt = async (p) => {
      if (p + 6 > end) return 0;
      await r.ensure(p, 6);
      const L = r.u32(p);
      return L >= 2 && p + 4 + L <= end && codec.ok(r.u8(p + 4), r.u8(p + 5)) ? 4 + L : 0;
    };
    // a run starts where several picture frames follow one another exactly (or reach the end)
    const runAt = async (p, n) => { for (let i = 0; i < n; i++) { const k = await nalAt(p); if (!k) return false; p += k; if (p >= end) return true; } return true; };
    const vOut = await fsp.open(tmpV, 'w');
    const gaps = [];
    try {
      const SC = Buffer.from([0, 0, 0, 1]);
      for (const u of params) await vOut.write(Buffer.concat([SC, u]));
      let p = start, inRun = false, tick = 0;
      while (p < end) {
        const k = await nalAt(p);
        if (k && (inRun || await runAt(p, 4))) {
          const nal = await r.bytes(p + 4, k - 4);
          await vOut.write(Buffer.concat([SC, nal]));
          if (codec.vcl(codec.type(nal[0]))) frames++;
          p += k; inRun = true;
        } else {
          // the last picture frame, cut off where the recording stopped: leave it out
          if (inRun && p + 6 <= end) { await r.ensure(p, 6); if (r.u32(p) >= 2 && p + 4 + r.u32(p) > end && codec.ok(r.u8(p + 4), r.u8(p + 5))) break; }
          inRun = false;
          let q = p + 1;
          for (;;) {
            if (q >= end) break;
            await r.ensure(q, 6);
            const lim = Math.min(end, r.at + r.buf.length - 6);
            // skip through quickly to the next place that could start a run
            while (q < lim && !(r.u32(q) >= 2 && r.u32(q) < end - q && codec.ok(r.u8(q + 4), r.u8(q + 5)))) q++;
            if (q < lim && await runAt(q, 6)) break;
            if (q < lim) q++;
          }
          gaps.push([p, Math.min(q, end)]);
          p = q;
        }
        if (++tick % 64 === 0) { job.progress = 0.05 + 0.6 * ((p - start) / (end - start)); if (job.status === 'cancelled') throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); }
      }
    } finally { await vOut.close(); }
    if (frames < 2) throw new Error('No picture frames could be found in it.');

    // ---- the sound: cut where a frame could start, join the pieces that don't play
    if (adtsHead) {
      job.step = 'Sorting out the sound';
      const MAX = 768 * channels; // the most an AAC frame can hold
      let pieces = [];
      for (const [a, b] of gaps) {
        if (b - a > 64 << 20) continue; // not sound
        const g = await r.bytes(a, b - a);
        if (!g.some((x) => x)) continue; // never written
        let s = 0;
        for (let i = 1; i < g.length - 1; i++) if (starts.has(g[i] * 16 + (g[i + 1] & 15))) { pieces.push({ g, a: s, b: i }); s = i; }
        pieces.push({ g, a: s, b: g.length, last: true });
      }
      const adts = (list) => Buffer.concat(list.flatMap((x) => {
        const n = x.b - x.a + 7, h = Buffer.from(adtsHead);
        h[3] = (h[3] & 0xfc) | ((n >> 11) & 3); h[4] = (n >> 3) & 0xff; h[5] = ((n & 7) << 5) | 0x1f; h[6] = (h[6] & 0xfc);
        return [h, x.g.subarray(x.a, x.b)];
      }));
      /** How many sound frames each piece plays as (0: it doesn't play), one ffprobe for the lot. A good frame from the
       *  working video goes first, as the decoder counts whatever comes first twice */
      const frameCounts = async (list) => {
        await fsp.writeFile(tmpA, Buffer.concat([lead, adts(list)]));
        const pr = await exec(ffprobe, ['-v', 'quiet', '-show_entries', 'frame=pkt_pos', '-of', 'csv=p=0', tmpA], job);
        const at = new Map(), n = new Array(list.length).fill(0);
        let pos = lead.length;
        list.forEach((x, i) => { at.set(pos, i); pos += x.b - x.a + 7; });
        for (const l of String(pr.out).split(/\r?\n/)) { const i = at.get(+l); if (i != null) n[i]++; }
        return n;
      };
      const BIG = 4 * MAX; // a piece this size may still be a few frames run together
      for (let round = 0; round < 30 && pieces.length; round++) {
        const list = pieces.filter((x) => x.b - x.a <= BIG);
        const n = await frameCounts(list);
        for (const x of pieces) x.n = 0;
        list.forEach((x, i) => { x.n = n[i]; });
        // a frame cut in two: neither half plays, so two failed pieces in a row are joined
        const next = [];
        let joined = 0;
        for (let i = 0; i < pieces.length; i++) {
          const x = pieces[i], y = pieces[i + 1];
          if (!x.n && y && !y.n && !x.last && y.g === x.g && y.b - x.a <= MAX) { next.push({ g: x.g, a: x.a, b: y.b, last: y.last }); i++; joined++; } else next.push(x);
        }
        pieces = next;
        if (!joined) break;
      }
      // a piece that plays as more than one frame: frames whose start didn't look like the working video's. It's split
      // at the first place where both halves play as one frame each (any earlier cuts the first frame short)
      const split = async () => {
        for (let round = 0; round < 8; round++) {
          const multi = pieces.filter((x) => x.n > 1 && x.b - x.a <= BIG);
          if (!multi.length) break;
          const tests = [];
          for (const x of multi) for (let k = x.a + 8; k < x.b - 8; k++) tests.push({ i: tests.length, x, k, h1: { g: x.g, a: x.a, b: k }, h2: { g: x.g, a: k, b: x.b } });
          const n = await frameCounts(tests.flatMap((t) => [t.h1, t.h2]));
          const cut = new Map();
          tests.forEach((t, i) => { if (!cut.has(t.x) && n[2 * i] === 1 && n[2 * i + 1] >= 1) cut.set(t.x, t); });
          if (!cut.size) break;
          pieces = pieces.flatMap((x) => {
            const t = cut.get(x);
            if (!t) return [x];
            return [{ ...t.h1, n: 1 }, { ...t.h2, last: x.last, n: n[2 * t.i + 1] }];
          });
        }
      };
      await split();
      // a frame that plays but is followed by pieces that don't may have run on into the next frame (its start didn't
      // look like the working video's): it's cut again inside, where the first part plays as one frame and the rest
      // (with the pieces that didn't play) plays too
      for (let round = 0; round < 6; round++) {
        const tests = [], runs = new Map();
        pieces.forEach((x, i) => {
          if (x.n !== 1 || x.last) return;
          let e = i + 1;
          while (pieces[e] && pieces[e].g === x.g && !pieces[e].n && pieces[e].b - x.a <= BIG) { if (pieces[e].last) { e++; break; } e++; }
          if (e === i + 1) return;
          runs.set(x, e);
          const b = pieces[e - 1].b;
          for (let k = x.a + 8; k < x.b; k++) tests.push({ x, k, h1: { g: x.g, a: x.a, b: k }, h2: { g: x.g, a: k, b, last: pieces[e - 1].last } });
        });
        if (!tests.length) break;
        const n = await frameCounts(tests.flatMap((t) => [t.h1, t.h2]));
        const cut = new Map();
        tests.forEach((t, i) => { if (!cut.has(t.x) && n[2 * i] === 1 && n[2 * i + 1] >= 1) cut.set(t.x, { ...t, n2: n[2 * i + 1] }); });
        if (!cut.size) break;
        const next = [];
        for (let i = 0; i < pieces.length; i++) {
          const t = cut.get(pieces[i]);
          if (!t) { next.push(pieces[i]); continue; }
          next.push({ ...t.h1, n: 1 }, { ...t.h2, n: t.n2 });
          i = runs.get(pieces[i]) - 1;
        }
        pieces = next;
        await split();
      }
      // whatever still won't play is left out
      const final = pieces.filter((x) => x.n === 1 && x.b - x.a <= BIG);
      sounds = final.length;
      if (sounds) await fsp.writeFile(tmpA, adts(final)); else adtsHead = null;
    }
  } finally { await fd.close(); }

  // ---- into a fresh MP4, nothing re-made
  job.step = 'Putting it together';
  job.progress = 0.7;
  const args = ['-hide_banner', '-v', 'error', '-y', '-fflags', '+genpts', '-r', String(fps), '-f', kind, '-i', tmpV];
  if (adtsHead) args.push('-i', tmpA, '-map', '0:v:0', '-map', '1:a:0');
  args.push('-c', 'copy', ...(kind === 'hevc' ? ['-tag:v', 'hvc1'] : []), '-movflags', '+faststart', out);
  const m = await exec(ffmpeg, args, job);
  if (m.code !== 0 || !fs.existsSync(out)) throw new Error('The frames were found, but couldn’t be put into a video: ' + (m.log.trim().split('\n').pop() || `ffmpeg stopped (${m.code})`));
  return { frames, sounds, fps, seconds: frames / fps, sound: !!adtsHead };
}

module.exports = { rebuild };
