// Video editor export: the page renders every frame on a canvas and streams them here as JPEGs; ffmpeg
// (installed on the PC) encodes them to MP4 together with the audio mix the page rendered (a WAV).
// Frame-by-frame, so the result is exact no matter how fast the PC is.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PEAK_RATE = 100; // waveform values per second
const err = (status, message) => Object.assign(new Error(message), { status });

module.exports = function createRender({ tools, readBody, readJSONBody, requirePath, newJob, startJob, runFfmpegJob, cacheDir, log }) {
  const sessions = new Map();
  const needFfmpeg = () => { if (!tools().ffmpeg) throw err(501, 'This needs ffmpeg (winget install Gyan.FFmpeg), then restart Box-Deckspitter.'); };
  /** A cache file named after the source file and its size + date, so edits to the source make a new one. */
  async function cacheFor(src, suffix) {
    const st = await fsp.stat(src);
    const key = crypto.createHash('sha1').update(`${path.resolve(src).toLowerCase()}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
    await fsp.mkdir(cacheDir, { recursive: true });
    return path.join(cacheDir, `${key}${suffix}`);
  }

  function cleanup(s) {
    clearTimeout(s.idle);
    sessions.delete(s.id);
    fsp.rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }
  function touch(s) {
    clearTimeout(s.idle);
    // a render nobody talks to for 10 minutes is abandoned
    s.idle = setTimeout(() => { try { s.proc?.kill(); } catch { /* gone */ } cleanup(s); }, 10 * 60 * 1000);
  }
  function get(id) {
    const s = sessions.get(String(id || ''));
    if (!s) throw err(404, 'That export isn’t running any more.');
    touch(s);
    return s;
  }

  function startFfmpeg(s) {
    const ff = tools().ffmpeg;
    if (!ff) throw err(501, 'Exporting needs ffmpeg (winget install Gyan.FFmpeg), then restart Box-Deckspitter.');
    const args = ['-hide_banner', '-y', '-f', 'image2pipe', '-framerate', String(s.fps), '-c:v', 'mjpeg', '-i', 'pipe:0'];
    if (s.audio) args.push('-i', s.audio);
    args.push('-map', '0:v');
    if (s.audio) args.push('-map', '1:a', '-c:a', 'aac', '-b:a', '192k');
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(s.crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-t', s.duration.toFixed(3), s.output);
    s.proc = spawn(ff, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    s.stderr = '';
    s.proc.stderr.on('data', (d) => { s.stderr = (s.stderr + d).slice(-4000); });
    s.exited = new Promise((resolve) => s.proc.on('close', (code) => resolve(code)));
    s.proc.stdin.on('error', () => { /* ffmpeg quit early; reported by finish */ });
  }

  // ---------------------------------------------------------------- BoxConvert
  /** `dir\name`, or `dir\name (2)` and so on when that's taken: a conversion never overwrites anything. */
  function freePath(dir, name) {
    const ext = path.extname(name), stem = path.basename(name, ext);
    let p = path.join(dir, name);
    for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
    return p;
  }
  const safeName = (n) => String(n || 'converted').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 180) || 'converted';
  /** What ffmpeg is told for each target: the video ones keep the picture and the sound, the audio ones drop the picture. */
  const MEDIA_OUT = {
    mp4: ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
    mov: ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k'],
    mkv: ['-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k'],
    webm: ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '128k'],
    gif: ['-vf', "fps=15,scale='min(720,iw)':-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", '-loop', '0'],
    mp3: ['-vn', '-map', '0:a:0', '-c:a', 'libmp3lame', '-q:a', '2'],
    wav: ['-vn', '-map', '0:a:0', '-c:a', 'pcm_s16le'],
    m4a: ['-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k'],
    ogg: ['-vn', '-map', '0:a:0', '-c:a', 'libvorbis', '-q:a', '6'],
    opus: ['-vn', '-map', '0:a:0', '-c:a', 'libopus', '-b:a', '128k'],
    flac: ['-vn', '-map', '0:a:0', '-c:a', 'flac'],
  };

  // ---------------------------------------------------------------- BoxConvert: shrink to a size
  /** How long a video or sound is, its picture size and whether it has sound (from ffmpeg's own report). */
  function probe(file) {
    return new Promise((resolve) => {
      const p = spawn(tools().ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let s = '';
      p.stderr.on('data', (d) => { s += d; });
      p.on('error', () => resolve(null));
      p.on('close', () => {
        const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(s), v = /Stream #[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/.exec(s);
        resolve({ duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0, width: v ? +v[1] : 0, height: v ? +v[2] : 0, audio: /Stream #[^\n]*Audio:/.test(s) });
      });
    });
  }
  /** ffmpeg for one step of a job: its progress fills job.progress from `from` to `from + span`. */
  function ffStep(job, args, duration, from = 0, span = 1) {
    return new Promise((resolve, reject) => {
      const p = spawn(tools().ffmpeg, ['-hide_banner', '-y', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      job.cancel = () => { job.status = 'cancelled'; p.kill(); };
      let msg = '';
      p.stderr.on('data', (d) => {
        const s = String(d);
        msg = (msg + s).slice(-3000);
        const tm = /time=(\d+):(\d+):([\d.]+)/.exec(s);
        if (tm && duration) job.progress = Math.min(0.99, from + span * Math.min(1, (+tm[1] * 3600 + +tm[2] * 60 + +tm[3]) / duration));
      });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(job.status === 'cancelled' ? 'Stopped'
        : msg.split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] || `ffmpeg stopped (${code})`))));
    });
  }
  const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  /**
   * The file at `bytes` or under. Videos: H.264 MP4 in two passes at the bitrate that fills the size (smaller picture
   * when the bitrate is low); a try that comes out too big goes again a bit lower. Sounds: MP3 at the bitrate that
   * fits. GIFs: smaller and fewer frames until it fits. Anything else: a .zip, which fits only if the file packs well.
   */
  async function shrink(job, file, kind, bytes, outDir, tag) {
    const stem = safeName(path.parse(file).name), dir = outDir || path.dirname(file), named = `${stem} (${tag || mb(bytes).replace(' ', '')})`;
    const tooSmall = (what) => err(400, `${mb(bytes)} is too small for ${what}.`);
    if (kind === 'video' || kind === 'audio') {
      const info = await probe(file);
      if (!info?.duration) throw err(400, 'Couldn’t read how long it is.');
      const kbps = (bytes * 8 * 0.97) / info.duration / 1000; // what fits, less a little for the file's own bookkeeping
      if (kind === 'audio') {
        const rate = Math.min(320, Math.floor(kbps));
        if (rate < 8) throw tooSmall('this much sound');
        const out = freePath(dir, `${named}.mp3`);
        job.result = { path: out };
        await ffStep(job, ['-i', file, '-vn', '-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', `${rate}k`, ...(rate < 48 ? ['-ar', rate < 24 ? '11025' : '22050'] : []), out], info.duration);
        return { path: out, note: `MP3 at ${rate} kbit/s` };
      }
      const out = freePath(dir, `${named}.mp4`);
      job.result = { path: out };
      const log = path.join(os.tmpdir(), `bds-shrink-${job.id}`);
      let aRate = info.audio ? Math.max(32, Math.min(128, Math.round(kbps * 0.12))) : 0;
      let vRate = Math.floor(kbps - aRate);
      if (vRate < 40) { aRate = info.audio ? 24 : 0; vRate = Math.floor(kbps - aRate); }
      if (vRate < 20) throw tooSmall(`${Math.round(info.duration)} s of video`);
      try {
        for (let tryN = 0; tryN < 3; tryN++) {
          // a smaller picture looks better than a starved big one
          const h = Math.min(info.height || 1080, vRate < 250 ? 360 : vRate < 600 ? 480 : vRate < 1500 ? 720 : 1080);
          const vf = ['-vf', `scale=-2:'min(${h},ih)'`];
          const enc = ['-c:v', 'libx264', '-preset', 'medium', '-b:v', `${vRate}k`, '-pix_fmt', 'yuv420p', '-passlogfile', log];
          await ffStep(job, ['-i', file, '-map', '0:v:0', ...vf, ...enc, '-pass', '1', '-an', '-f', 'null', '-'], info.duration, 0, 0.5);
          await ffStep(job, ['-i', file, '-map', '0:v:0', ...(aRate ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', `${aRate}k`] : ['-an']), ...vf, ...enc, '-pass', '2', '-movflags', '+faststart', out], info.duration, 0.5, 0.5);
          const size = (await fsp.stat(out)).size;
          if (size <= bytes) return { path: out, note: `MP4, ${h}p at ${vRate + aRate} kbit/s` };
          vRate = Math.floor(vRate * (bytes / size) * 0.95);
          if (vRate < 20) break;
        }
        throw tooSmall(`${Math.round(info.duration)} s of video`);
      } catch (e) { await fsp.rm(out, { force: true }).catch(() => {}); throw e; } finally {
        for (const f of await fsp.readdir(os.tmpdir()).catch(() => [])) if (f.startsWith(`bds-shrink-${job.id}`)) fsp.rm(path.join(os.tmpdir(), f), { force: true }).catch(() => {});
      }
    }
    if (kind === 'gif') {
      const info = await probe(file);
      const out = freePath(dir, `${named}.gif`);
      job.result = { path: out };
      const w = info?.width || 720;
      const tries = [[1, 15], [0.75, 12], [0.6, 10], [0.45, 10], [0.33, 8], [0.25, 8], [0.18, 6]];
      for (let i = 0; i < tries.length; i++) {
        const [k, fps] = tries[i], width = Math.max(32, Math.round((Math.min(w, 720) * k) / 2) * 2);
        await ffStep(job, ['-i', file, '-vf', `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${k < 0.5 ? 64 : 128}[p];[b][p]paletteuse`, '-loop', '0', out], 0);
        job.progress = (i + 1) / tries.length;
        if ((await fsp.stat(out)).size <= bytes) return { path: out, note: `GIF, ${width} px wide at ${fps} frames/s` };
      }
      await fsp.rm(out, { force: true }).catch(() => {});
      throw tooSmall('this GIF');
    }
    // anything else: packed as tightly as a .zip goes
    const st = await fsp.stat(file);
    if (st.size > 1024 ** 3) throw err(400, 'Over 1 GB: too big to zip here.');
    const JSZip = require('jszip');
    const zip = new JSZip();
    zip.file(path.basename(file), await fsp.readFile(file));
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } }, (m) => { job.progress = m.percent / 100; });
    if (buf.length > bytes) throw err(400, `Zipped it’s still ${mb(buf.length)}: this kind of file doesn’t pack any smaller.`);
    const out = freePath(dir, `${stem}.zip`);
    job.result = { path: out };
    await fsp.writeFile(out, buf);
    return { path: out, note: `zipped: ${Math.round((1 - buf.length / st.size) * 100)}% smaller` };
  }

  return {
    // Shrink a file to a size (`bytes`), as a job (/api/job for progress): kind video / audio / gif / other.
    'POST /api/convert/shrink': async (req) => {
      const { path: src, kind, bytes, dir, tag } = await readJSONBody(req);
      const file = requirePath(src);
      if (!fs.existsSync(file)) throw err(404, 'That file isn’t there any more.');
      const k = ['video', 'audio', 'gif'].includes(kind) ? kind : 'other';
      if (k !== 'other') needFfmpeg();
      const n = Number(bytes);
      if (!(n >= 1024)) throw err(400, 'Pick a size of at least 1 KB.');
      const job = newJob(`Shrinking ${path.basename(file)}`);
      job.result = {};
      return startJob(job, async () => { const r = await shrink(job, file, k, n, dir ? requirePath(dir) : null, safeName(tag).slice(0, 12)); Object.assign(job.result, r); });
    },
    // A free file name for a converted file (dir: where it goes); folder: make it a new folder instead (PDF pages).
    'POST /api/convert/name': async (req) => {
      const { dir, name, folder } = await readJSONBody(req);
      const d = requirePath(dir);
      const p = freePath(d, safeName(name));
      if (folder) await fsp.mkdir(p, { recursive: true });
      return { path: p };
    },
    // A video or sound file in another format, through ffmpeg, as a job (/api/job for progress). Never overwrites.
    'POST /api/convert/media': async (req) => {
      const { path: src, to, dir } = await readJSONBody(req);
      needFfmpeg();
      const file = requirePath(src);
      const args = MEDIA_OUT[String(to)];
      if (!args) throw err(400, 'Can’t convert to that.');
      if (!fs.existsSync(file)) throw err(404, 'That file isn’t there any more.');
      const out = freePath(dir ? requirePath(dir) : path.dirname(file), `${safeName(path.parse(file).name)}.${to}`);
      const job = newJob(`Converting ${path.basename(file)}`);
      job.result = { path: out };
      const r = startJob(job, () => new Promise((resolve, reject) => {
        const p = spawn(tools().ffmpeg, ['-hide_banner', '-n', '-i', file, ...args, out], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        job.cancel = () => p.kill();
        let msg = '', duration = 0;
        p.stderr.on('data', (d) => {
          const s = String(d);
          msg = (msg + s).slice(-3000);
          const dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(s);
          if (dm && !duration) duration = +dm[1] * 3600 + +dm[2] * 60 + +dm[3];
          const tm = /time=(\d+):(\d+):([\d.]+)/.exec(s);
          if (tm && duration) job.progress = Math.min(0.99, (+tm[1] * 3600 + +tm[2] * 60 + +tm[3]) / duration);
        });
        p.on('error', reject);
        p.on('close', async (code) => {
          if (code === 0) return resolve();
          await fsp.rm(out, { force: true }).catch(() => {});
          const last = msg.split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] || `ffmpeg stopped (${code})`;
          reject(new Error(/matches no streams|does not contain any stream|Output file .* does not contain/i.test(msg) ? (args.includes('-vn') ? 'It has no sound to keep.' : 'It has no picture to keep.') : last));
        });
      }));
      return { ...r, path: out };
    },
    // A video the browser can't play (MKV/HEVC, AVI, WMV, ProRes…) gets an H.264 copy for editing; cached.
    'POST /api/render/proxy': async (req) => {
      const { path: src } = await readJSONBody(req);
      needFfmpeg();
      const file = requirePath(src);
      const out = await cacheFor(file, '.proxy.mp4');
      if (fs.existsSync(out)) return { done: true, path: out };
      const job = newJob(`Preparing ${path.basename(file)}`);
      const tmp = out.replace(/\.mp4$/, '.part.mp4');
      job.result = { path: out };
      const r = startJob(job, async () => {
        await runFfmpegJob(job, ['-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='min(1920,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp], 0);
        await fsp.rename(tmp, out);
      });
      return { ...r, path: out };
    },
    // A clip's sound as a plain WAV (any format ffmpeg reads), so the mixdown never loads a huge video into memory.
    'POST /api/render/extract-audio': async (req) => {
      const { path: src } = await readJSONBody(req);
      needFfmpeg();
      const file = requirePath(src);
      const out = await cacheFor(file, '.audio.wav');
      if (!fs.existsSync(out)) {
        const tmp = out + '.part';
        const code = await new Promise((resolve) => {
          const p = spawn(tools().ffmpeg, ['-hide_banner', '-y', '-i', file, '-vn', '-ac', '2', '-ar', '48000', '-f', 'wav', tmp], { windowsHide: true, stdio: 'ignore' });
          p.on('close', resolve);
          p.on('error', () => resolve(1));
        });
        if (code !== 0) { await fsp.rm(tmp, { force: true }).catch(() => {}); return { path: null }; } // no sound in it
        await fsp.rename(tmp, out);
      }
      return { path: out };
    },
    // The loudness outline of a file's sound for the timeline: one byte (0–255, the loudest sample) per 1/100 s; cached.
    'POST /api/render/peaks': async (req) => {
      const { path: src } = await readJSONBody(req);
      needFfmpeg();
      const file = requirePath(src);
      const out = await cacheFor(file, '.peaks');
      if (!fs.existsSync(out)) {
        const RATE = 8000, PER = RATE / PEAK_RATE;
        const chunks = [];
        let cur = 0, n = 0, odd = null;
        const code = await new Promise((resolve) => {
          const p = spawn(tools().ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
          const bytes = [];
          p.stdout.on('data', (d) => {
            if (odd) { d = Buffer.concat([odd, d]); odd = null; }
            if (d.length % 2) { odd = d.subarray(d.length - 1); d = d.subarray(0, d.length - 1); }
            for (let i = 0; i < d.length; i += 2) {
              const v = Math.abs(d.readInt16LE(i));
              if (v > cur) cur = v;
              if (++n === PER) { bytes.push(Math.min(255, cur >> 7)); cur = 0; n = 0; }
            }
            if (bytes.length >= 65536) chunks.push(Buffer.from(bytes.splice(0)));
          });
          p.on('close', (c) => { if (n) bytes.push(Math.min(255, cur >> 7)); chunks.push(Buffer.from(bytes)); resolve(c); });
          p.on('error', () => resolve(1));
        });
        const buf = Buffer.concat(chunks);
        if (code !== 0 && !buf.length) return { rate: PEAK_RATE, peaks: null }; // no sound in it
        await fsp.writeFile(out, buf);
      }
      return { rate: PEAK_RATE, peaks: (await fsp.readFile(out)).toString('base64') };
    },
    // The part of a file's sound a clip uses, as an MP3 (for saving a clip's sound into a dump).
    'POST /api/render/clip-audio': async (req) => {
      const { path: src, start, len, volume, output } = await readJSONBody(req);
      needFfmpeg();
      const file = requirePath(src);
      const out = requirePath(output);
      if (path.resolve(out).toLowerCase() === path.resolve(file).toLowerCase()) throw err(400, 'That’s the clip’s own file.');
      const ss = Math.max(0, Number(start) || 0), t = Math.max(0.05, Number(len) || 0);
      const vol = Math.max(0, Math.min(4, Number(volume ?? 1)));
      const args = ['-hide_banner', '-v', 'error', '-y', '-ss', ss.toFixed(3), '-t', t.toFixed(3), '-i', file, '-vn'];
      if (Math.abs(vol - 1) > 0.001) args.push('-af', `volume=${vol.toFixed(3)}`);
      args.push('-c:a', 'libmp3lame', '-q:a', '2', out);
      let msg = '';
      const code = await new Promise((resolve) => {
        const p = spawn(tools().ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        p.stderr.on('data', (d) => { msg = (msg + d).slice(-1000); });
        p.on('close', resolve);
        p.on('error', () => resolve(1));
      });
      if (code !== 0) { await fsp.rm(out, { force: true }).catch(() => {}); throw err(500, /does not contain any stream|matches no streams/i.test(msg) ? 'That clip has no sound.' : 'ffmpeg couldn’t save the sound: ' + msg.split('\n').filter(Boolean).slice(-1)[0]); }
      return { ok: true, path: out };
    },
    'POST /api/render/start': async (req) => {
      const { width, height, fps, duration, output, quality, inputs } = await readJSONBody(req);
      // never overwrite a file the project itself uses
      const outAbs = path.resolve(requirePath(output)).toLowerCase();
      if ((inputs || []).some((p) => path.resolve(String(p)).toLowerCase() === outAbs)) throw err(400, 'That’s one of the project’s own media files. Pick another name for the export.');
      if (!tools().ffmpeg) throw err(501, 'Exporting needs ffmpeg (winget install Gyan.FFmpeg), then restart Box-Deckspitter.');
      const w = Math.round(Number(width));
      const h = Math.round(Number(height));
      if (!(w >= 16 && w <= 7680 && h >= 16 && h <= 7680)) throw err(400, 'Bad video size.');
      const id = crypto.randomBytes(8).toString('hex');
      const dir = path.join(os.tmpdir(), `bds-render-${id}`);
      await fsp.mkdir(dir, { recursive: true });
      const s = {
        id, dir, w, h, fps: Math.max(1, Math.min(120, Number(fps) || 30)), duration: Math.max(0.05, Number(duration) || 1),
        output: requirePath(output), crf: quality === 'high' ? 16 : quality === 'small' ? 26 : 20, audio: null, proc: null, frames: 0,
      };
      sessions.set(id, s);
      touch(s);
      return { id };
    },
    // optional, before the first frames: the mixed soundtrack as a WAV
    'POST /api/render/audio': async (req, q) => {
      const s = get(q.get('id'));
      if (s.proc) throw err(400, 'Audio has to come before the frames.');
      const body = await readBody(req, 4 * 1024 * 1024 * 1024);
      s.audio = path.join(s.dir, 'mix.wav');
      await fsp.writeFile(s.audio, body);
      return { ok: true };
    },
    // a batch of JPEG frames, back to back
    'POST /api/render/frames': async (req, q) => {
      const s = get(q.get('id'));
      if (!s.proc) startFfmpeg(s);
      const body = await readBody(req, 512 * 1024 * 1024);
      const n = Number(q.get('n')) || 0;
      if (s.proc.exitCode !== null) throw err(500, 'ffmpeg stopped: ' + (s.stderr.split('\n').filter(Boolean).slice(-2).join(' ') || 'unknown error'));
      if (!s.proc.stdin.write(body)) await new Promise((r) => s.proc.stdin.once('drain', r));
      s.frames += n;
      return { ok: true, frames: s.frames };
    },
    'POST /api/render/finish': async (req) => {
      const { id } = await readJSONBody(req);
      const s = get(id);
      if (!s.proc) startFfmpeg(s);
      s.proc.stdin.end();
      const code = await s.exited;
      const msg = s.stderr.split('\n').filter(Boolean).slice(-3).join(' ');
      cleanup(s);
      if (code !== 0) throw err(500, 'ffmpeg couldn’t make the video: ' + msg);
      log(`video export: ${s.frames} frames → ${s.output}`);
      return { ok: true, path: s.output, frames: s.frames };
    },
    'POST /api/render/cancel': async (req) => {
      const { id } = await readJSONBody(req);
      const s = sessions.get(String(id || ''));
      if (s) {
        try { s.proc?.kill(); } catch { /* gone */ }
        await s.exited?.catch(() => {});
        await fsp.rm(s.output, { force: true }).catch(() => {});
        cleanup(s);
      }
      return { ok: true };
    },
  };
};
