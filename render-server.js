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

const err = (status, message) => Object.assign(new Error(message), { status });

module.exports = function createRender({ tools, readBody, readJSONBody, requirePath, newJob, startJob, runFfmpegJob, cacheDir, log }) {
  const sessions = new Map();
  const needFfmpeg = () => { if (!tools().ffmpeg) throw err(501, 'This needs ffmpeg (winget install Gyan.FFmpeg), then restart Box-DocSpitter.'); };
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
    if (!ff) throw err(501, 'Exporting needs ffmpeg (winget install Gyan.FFmpeg), then restart Box-DocSpitter.');
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

  return {
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
    'POST /api/render/start': async (req) => {
      const { width, height, fps, duration, output, quality, inputs } = await readJSONBody(req);
      // never overwrite a file the project itself uses
      const outAbs = path.resolve(requirePath(output)).toLowerCase();
      if ((inputs || []).some((p) => path.resolve(String(p)).toLowerCase() === outAbs)) throw err(400, 'That’s one of the project’s own media files. Pick another name for the export.');
      if (!tools().ffmpeg) throw err(501, 'Exporting needs ffmpeg (winget install Gyan.FFmpeg), then restart Box-DocSpitter.');
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
