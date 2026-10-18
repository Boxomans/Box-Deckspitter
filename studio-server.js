// BoxStudio server side: the scene setup (data/studio.json), and recordings. The page records with MediaRecorder
// and streams the pieces here as it goes, so a long recording never sits in memory; when it stops, ffmpeg (if
// installed) rewrites the file into the chosen container with a proper index, so it seeks well everywhere.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const err = (status, message) => Object.assign(new Error(message), { status });
const FORMATS = ['mp4', 'mkv', 'webm', 'mov'];
const RAW_EXT = ['mp4', 'webm'];

module.exports = function createStudio({ readBody, readJSONBody, requirePath, tools, dumpDir, dataFile, readJSON, writeJSON, log }) {
  const recs = new Map(); // id -> { id, part, dir, inDump, ext, size, writing, idle }

  const pad = (n) => String(n).padStart(2, '0');
  function stamp(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  }
  function safeName(name, fallback) {
    const n = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/[. ]+$/, '');
    return n || fallback;
  }
  function uniquePath(dir, name) {
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let p = path.join(dir, name);
    for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
    return p;
  }
  /** Where a recording or screenshot goes: a folder the user picked, or the media dump. */
  async function target(body) {
    if (body.dump !== false && !body.dir) return { dir: dumpDir, inDump: true };
    const dir = requirePath(body.dir);
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const st = await fsp.stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw err(400, `Can't save into ${dir}`);
    return { dir, inDump: false };
  }
  function touch(r) {
    clearTimeout(r.idle);
    // a recording nobody has written to for a long while (the page went away): keep what arrived
    r.idle = setTimeout(() => finish(r, r.format).catch(() => {}), 30 * 60 * 1000);
    r.idle.unref?.();
  }

  function ffmpeg(args) {
    return new Promise((resolve, reject) => {
      const p = spawn(tools().ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true });
      let errText = '';
      p.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(errText.trim() || `ffmpeg stopped (${code})`))));
    });
  }

  async function finish(r, format) {
    recs.delete(r.id);
    clearTimeout(r.idle);
    await r.writing;
    const want = FORMATS.includes(format) ? format : r.ext;
    const out = uniquePath(r.dir, `${r.name}.${want}`);
    let note = '';
    if (tools().ffmpeg) {
      try {
        const faststart = want === 'mp4' || want === 'mov' ? ['-movflags', '+faststart'] : [];
        // the browser's audio is Opus; .mov can't hold it, so that one gets AAC
        const audio = want === 'mov' ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'copy'];
        await ffmpeg(['-y', '-fflags', '+genpts', '-i', r.part, '-map', '0', '-c:v', 'copy', ...audio, ...faststart, out]);
        await fsp.unlink(r.part).catch(() => {});
      } catch (e) {
        log(`studio: remux failed: ${e.message}`);
        note = 'ffmpeg couldn’t rewrap it, so it’s saved as the recorder wrote it.';
      }
    } else if (want !== r.ext) {
      note = `Saved as .${r.ext} (making .${want} needs ffmpeg).`;
    }
    let file = out;
    if (!fs.existsSync(out)) {
      file = uniquePath(r.dir, `${r.name}.${r.ext}`);
      await fsp.rename(r.part, file);
    }
    const st = await fsp.stat(file);
    return { ok: true, path: file, name: path.basename(file), size: st.size, inDump: r.inDump, note, seconds: (Date.now() - r.started) / 1000 };
  }

  return {
    // ---- the scene setup
    'GET /api/studio': async () => ({ config: readJSON(dataFile, null), ffmpeg: !!tools().ffmpeg, dump: dumpDir }),
    'POST /api/studio': async (req) => {
      const buf = await readBody(req, 4 * 1024 * 1024);
      let config;
      try { config = JSON.parse(buf.toString('utf8')); } catch { throw err(400, 'Bad setup'); }
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw err(400, 'Bad setup');
      await writeJSON(dataFile, config);
      return { ok: true };
    },

    // ---- recording: start → chunks (in order) → finish
    'POST /api/studio/rec/start': async (req) => {
      const body = await readJSONBody(req);
      const { dir, inDump } = await target(body);
      const ext = RAW_EXT.includes(body.ext) ? body.ext : 'webm';
      const id = crypto.randomBytes(8).toString('hex');
      const name = safeName(body.name, `Recording ${stamp()}`);
      const part = uniquePath(dir, `${name}.${ext}.part`);
      await fsp.writeFile(part, Buffer.alloc(0));
      const r = { id, part, dir, inDump, ext, name, format: body.format, size: 0, started: Date.now(), writing: Promise.resolve() };
      recs.set(id, r);
      touch(r);
      return { ok: true, id, part };
    },
    'POST /api/studio/rec/chunk': async (req, q) => {
      const r = recs.get(q.get('id'));
      if (!r) throw err(404, 'That recording isn’t running any more');
      const buf = await readBody(req, 512 * 1024 * 1024);
      r.writing = r.writing.then(() => fsp.appendFile(r.part, buf));
      await r.writing;
      r.size += buf.length;
      touch(r);
      return { ok: true, size: r.size };
    },
    'POST /api/studio/rec/finish': async (req) => {
      const { id, format } = await readJSONBody(req);
      const r = recs.get(id);
      if (!r) throw err(404, 'That recording isn’t running any more');
      return finish(r, format);
    },
    'POST /api/studio/rec/abort': async (req) => {
      const { id } = await readJSONBody(req);
      const r = recs.get(id);
      if (r) { recs.delete(id); clearTimeout(r.idle); await r.writing.catch(() => {}); await fsp.unlink(r.part).catch(() => {}); }
      return { ok: true };
    },

    // ---- BoxWave: a float WAV body → ?path= in ?format= (mp3, flac, ogg, opus, m4a) through ffmpeg; overwrites,
    //      since the path came from a save dialog
    'POST /api/wave/export': async (req, q) => {
      const ENC = {
        mp3: ['-c:a', 'libmp3lame', '-q:a', '2'],
        flac: ['-c:a', 'flac', '-sample_fmt', 's16'],
        ogg: ['-c:a', 'libvorbis', '-q:a', '6'],
        opus: ['-c:a', 'libopus', '-b:a', '160k'],
        m4a: ['-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart'],
      };
      const args = ENC[q.get('format')];
      if (!args) throw err(400, 'Can’t export to that');
      if (!tools().ffmpeg) throw err(400, 'Exporting that needs ffmpeg (WAV works without it)');
      const out = requirePath(q.get('path'));
      const buf = await readBody(req, 1536 * 1024 * 1024);
      if (buf.slice(0, 4).toString() !== 'RIFF') throw err(400, 'Not a WAV');
      const tmp = `${out}.${crypto.randomBytes(4).toString('hex')}.wav`;
      await fsp.writeFile(tmp, buf);
      try { await ffmpeg(['-y', '-i', tmp, '-map', '0:a:0', ...args, '-f', q.get('format') === 'm4a' ? 'ipod' : q.get('format'), out]); }
      finally { await fsp.unlink(tmp).catch(() => {}); }
      const st = await fsp.stat(out);
      return { ok: true, path: out, size: st.size };
    },

    // ---- a still of the output (PNG body) → ?dir=… or the media dump
    'POST /api/studio/shot': async (req, q) => {
      const { dir, inDump } = await target({ dir: q.get('dir') || null });
      const buf = await readBody(req, 100 * 1024 * 1024);
      if (buf.slice(1, 4).toString() !== 'PNG') throw err(400, 'Not a PNG');
      const file = uniquePath(dir, `Studio ${stamp()}.png`);
      await fsp.writeFile(file, buf);
      return { ok: true, path: file, name: path.basename(file), inDump };
    },
  };
};
