// BoxMend: broken videos in, the most that can be saved out. A quick look says what's wrong in plain words; a repair
// reads every frame, then tries the lightest fix first: rewrap the same picture and sound into a fresh file (fixes a
// missing length, broken timing, a cut-short ending), then a fresh copy re-made frame by frame with the damaged parts
// patched over, then the sound on its own. Each try is checked by reading it back. A recording cut off before its
// index was written is rebuilt with a working video from the same camera or program (mend-rebuild.js). The original is
// never touched; repaired files go in the app's mend-dump folder.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { rebuild } = require('./mend-rebuild');

const err = (status, message) => Object.assign(new Error(message), { status });
const secs = (m) => +m[1] * 3600 + +m[2] * 60 + +m[3];
const clock = (s) => { s = Math.round(s); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; return `${hh ? hh + ':' + String(mm).padStart(2, '0') : mm}:${String(ss).padStart(2, '0')}`; };

/** Each problem in a few words, for the list of what was done. */
const SHORT = { index: 'no index', unreadable: 'unreadable parts', short: 'cut short', frames: 'damaged frames', timing: 'broken timing', sound: 'damaged sound', length: 'no length', empty: 'nothing in it' };
/** ffmpeg's complaints, in plain words (the first that matches each line). */
const PROBLEMS = [
  { id: 'index', re: /moov atom not found/i, text: 'The recording was cut off before it finished saving: the index that says where every frame is was never written.' },
  { id: 'unreadable', re: /Invalid data found when processing input|could not find codec parameters|Failed to read frame size/i, text: 'Parts of the file aren’t video data any more (damaged, or overwritten).' },
  { id: 'short', re: /partial file|truncat|End of file|stream ends prematurely|Packet mismatch|incomplete frame/i, text: 'It ends early: the end of the file is missing.' },
  { id: 'frames', re: /error while decoding|concealing|corrupt|Invalid NAL|missing picture|decode_slice_header|no frame!|Error splitting|illegal|out of range|ac-tex damaged|reference picture|mmco|marker does not match|error, skipping/i, text: 'Some frames are damaged (blocky, smeared or green patches).' },
  { id: 'timing', re: /non[- ]monoton|Invalid (DTS|PTS)|timestamps? (are )?unset|pts has no value|Application provided invalid/i, text: 'Its timing is broken (skips, freezes, or sound out of step).' },
  { id: 'sound', re: /(aac|mp3|opus|ac3|audio)[^\n]*(error|invalid)|Reserved bit set|Number of bands .* exceeds|channel element .* is not allocated/i, text: 'The sound is damaged in places (clicks, gaps).' },
];

module.exports = function createMend({ tools, newJob, startJob, readJSONBody, requirePath, reveal, dir: OUT }) {
  const needFfmpeg = () => { if (!tools().ffmpeg) throw err(501, 'This needs ffmpeg (winget install Gyan.FFmpeg), then restart Box-Deckspitter.'); };

  function freePath(dir, name) {
    const ext = path.extname(name), stem = path.basename(name, ext);
    let p = path.join(dir, name);
    for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
    return p;
  }
  const safeName = (n) => String(n || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 160) || 'video';

  /** Run ffmpeg; its log comes back. onTime gets the seconds it has got to. Rejects only when it can't start. */
  function ff(job, args, onTime) {
    return new Promise((resolve, reject) => {
      const p = spawn(tools().ffmpeg, ['-hide_banner', '-nostdin', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      if (job) job.cancel = () => { job.status = 'cancelled'; p.kill(); };
      let log = '', tail = '';
      p.stderr.on('data', (d) => {
        const s = String(d);
        tail += s;
        const tm = /time=(\d+):(\d+):([\d.]+)/g;
        let m, last = null;
        while ((m = tm.exec(tail))) last = m;
        if (last && onTime) onTime(secs(last));
        // the progress lines aren't kept: only what ffmpeg said
        const lines = tail.split(/[\r\n]/);
        tail = lines.pop();
        for (const l of lines) if (l && !/^\s*(frame|size)=|time=\d/.test(l) && log.length < 400000) log += l + '\n';
      });
      p.on('error', reject);
      p.on('close', (code) => {
        if (job?.status === 'cancelled') return reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        resolve({ code, log: log + (tail && !/time=/.test(tail) ? tail : '') });
      });
    });
  }

  /** What the file says about itself: its length, picture, sound, and what ffmpeg complains about opening it. */
  async function look(file) {
    const { log } = await ff(null, ['-i', file]);
    const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(log), v = /Stream #[^\n]*Video: ([a-z0-9_]+)[^\n]*?(\d{2,5})x(\d{2,5})/.exec(log), a = /Stream #[^\n]*Audio: ([a-z0-9_]+)[^\n]*?, (\d+) Hz, ([^,\n]+)/.exec(log);
    const fps = /Stream #[^\n]*Video:[^\n]*?([\d.]+) fps/.exec(log);
    const fmt = /Input #0, ([^,\n]+)/.exec(log);
    return {
      duration: d ? secs(d) : 0,
      video: v ? { codec: v[1], width: +v[2], height: +v[3] } : null,
      audio: a ? { codec: a[1], rate: +a[2], layout: a[3].trim() } : null,
      fps: fps ? +fps[1] : 0,
      format: fmt ? fmt[1] : null,
      opens: !!fmt,
      log: log.split('\n').filter((l) => !/^\s/.test(l) && !/^(Input|Output|Stream mapping|Press|At least one output)/.test(l)).join('\n'),
    };
  }

  /** The complaints in a log, grouped into plain-word problems (with how many times each came up). */
  function problems(log, info) {
    const found = new Map();
    for (const line of String(log).split('\n')) {
      if (!line.trim()) continue;
      // a picture decoder's complaint that isn't on the list is still a damaged frame
      const p = PROBLEMS.find((x) => x.re.test(line)) || (/^\[(h264|hevc|mpeg4|mpeg2video|vp[89]|av1|mjpeg|prores)[ @]/.test(line) ? PROBLEMS.find((x) => x.id === 'frames') : null);
      if (p) found.set(p.id, (found.get(p.id) || 0) + 1);
    }
    const out = PROBLEMS.filter((p) => found.has(p.id)).map((p) => ({ id: p.id, text: p.text, count: found.get(p.id) }));
    if (info && info.opens && !info.duration && !out.some((p) => p.id === 'index')) out.push({ id: 'length', text: 'It doesn’t say how long it is, so players can’t seek in it.', count: 1 });
    if (info && info.opens && !info.video && !info.audio) out.push({ id: 'empty', text: 'No picture or sound could be found in it.', count: 1 });
    return out;
  }

  /** problems() for a file that won't open: "no index" only when it really is an MP4 or MOV that was cut off. */
  async function problemsOf(file, info) {
    const head = Buffer.alloc(64);
    const fd = await fsp.open(file, 'r');
    try { await fd.read(head, 0, 64, 0); } finally { await fd.close(); }
    const isMp4 = /ftyp|mdat|moov|wide|free/.test(head.toString('latin1', 4, 12));
    const out = problems(info.log, info).filter((p) => p.id !== 'index' || isMp4);
    // a missing index is the whole story: nothing past it can be read
    return out.some((p) => p.id === 'index') ? out.filter((p) => p.id !== 'unreadable') : out;
  }
  /** Why a file that won't open can't be repaired. */
  const cantOpen = (why) => (why.some((p) => p.id === 'index')
    ? 'Pick a working video from the same camera or program (same settings), and its index can be rebuilt from that.'
    : 'Can’t be repaired: nothing in it can be read as a video.');

  /** Every frame read through; the complaints and how far it got (seconds). */
  async function scan(job, file, duration, from, span) {
    let reached = 0;
    const { log } = await ff(job, ['-v', 'error', '-stats', '-i', file, '-map', '0:v:0?', '-map', '0:a:0?', '-f', 'null', '-'], (t) => {
      reached = t;
      if (duration) job.progress = Math.min(0.99, from + span * Math.min(1, t / duration));
    });
    return { log, reached };
  }

  // picture and sound that an MP4 holds as they are; anything else is rewrapped as MKV
  const MP4_V = new Set(['h264', 'hevc', 'av1', 'mpeg4', 'vp9', 'mjpeg']);
  const MP4_A = new Set(['aac', 'mp3', 'opus', 'ac3', 'eac3', 'alac', 'flac']);

  /** A recording with no index, rebuilt with a working one's help, then read back to check it. */
  async function rebuildFrom(job, file, ref, stem, step) {
    job.step = 'Reading the working video';
    const refInfo = await look(ref);
    if (!refInfo.opens || !refInfo.video) throw new Error('The working video doesn’t play either: pick one that does, from the same camera or program.');
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'bds-mend-'));
    const out = freePath(OUT, `${stem} (repaired).mp4`);
    try {
      const r = await rebuild(job, { file, ref, refInfo, out, tmp, ffmpeg: tools().ffmpeg });
      step(`Rebuilt the index from ${path.basename(ref)}: ${r.frames} picture frames${r.sound ? `, ${r.sounds} sound frames` : ', no sound'} found`, true);
      if (!r.sound && refInfo.audio) step(refInfo.audio.codec === 'aac' ? 'The sound couldn’t be sorted out (or ffprobe, which comes with ffmpeg, is missing)' : `The sound is ${refInfo.audio.codec}, which can’t be rebuilt yet: picture only`, false);
      job.step = 'Checking the result';
      const back = await look(out);
      const check = await scan(job, out, back.duration, 0.75, 0.25);
      const left = check.log.split('\n').filter((l) => l.trim()).length;
      step(left ? `Read it back: ${left} complaint${left === 1 ? '' : 's'} (usually the last frame, cut off mid-write)` : 'Read it back: plays cleanly', !left, true);
      job.result.how = 'rebuilt';
      job.result.path = out;
      job.result.got = back.duration || r.seconds;
      job.result.note = `${clock(job.result.got)} saved`;
    } catch (e) { await fsp.rm(out, { force: true }).catch(() => {}); throw e; } finally {
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function repair(job, file, ref) {
    const steps = [];
    const step = (text, ok, read = false) => { steps.push({ text, ok, read }); job.result.steps = steps; };
    const stem = safeName(path.parse(file).name);
    await fsp.mkdir(OUT, { recursive: true });

    job.step = 'Looking at it';
    const info = await look(file);
    if (!info.opens) {
      const why = await problemsOf(file, info);
      job.result.problems = why;
      if (ref && why.some((p) => p.id === 'index')) return rebuildFrom(job, file, ref, stem, step);
      throw new Error(cantOpen(why));
    }

    job.step = 'Reading every frame';
    const src = await scan(job, file, info.duration, 0, 0.35);
    const found = problems(info.log + '\n' + src.log, info);
    job.result.problems = found;
    // how long it says it is, and how much of that could actually be read (less when it's cut short)
    const length = Math.max(info.duration, src.reached);
    const readable = found.some((p) => p.id === 'short') && src.reached ? src.reached : length;
    job.result.duration = length;
    step(found.length ? `Read it through: ${found.map((p) => (p.id === 'frames' ? `${p.count} damaged frame${p.count === 1 ? '' : 's'}` : SHORT[p.id])).join(', ')}` : 'Read it through: no damage found', !found.length, true);

    /** One try: ffmpeg into `out`, then read back. Kept when it reads clean and holds about as much as the original. */
    const attempt = async (label, out, args, from, span, need) => {
      job.step = label;
      const r = await ff(job, ['-y', ...args, out], (t) => { if (length) job.progress = Math.min(0.99, from + span * 0.8 * Math.min(1, t / length)); });
      if (r.code !== 0 || !fs.existsSync(out) || !(await fsp.stat(out)).size) {
        await fsp.rm(out, { force: true }).catch(() => {});
        step(`${label}: didn’t work`, false);
        return null;
      }
      job.step = 'Checking the result';
      const back = await look(out);
      const check = await ff(job, ['-v', 'error', '-stats', '-i', out, '-map', '0:v:0?', '-map', '0:a:0?', '-f', 'null', '-'], (t) => { if (length) job.progress = Math.min(0.99, from + span * (0.8 + 0.2 * Math.min(1, t / length))); });
      // with -v error a clean file says nothing at all: any line left is damage that came along
      const left = check.log.split('\n').filter((l) => l.trim());
      const got = back.duration || 0;
      const enough = got >= 0.5 && (!readable || got >= readable * need);
      if (left.length || !enough || (!back.video && !back.audio)) {
        await fsp.rm(out, { force: true }).catch(() => {});
        step(`${label}: ${left.length ? 'still damaged' : 'came out too short'}`, false);
        return null;
      }
      return { out, got, info: back };
    };

    const vOk = !info.video || MP4_V.has(info.video.codec), aOk = !info.audio || MP4_A.has(info.audio.codec);
    const lenient = ['-err_detect', 'ignore_err', '-fflags', '+genpts+discardcorrupt+igndts'];
    let done = null;
    // 1. the same picture and sound in a fresh file: nothing re-made, nothing lost (kept only when it reads back clean,
    //    so damaged frames, which would come along as they are, go on to 2)
    {
      const ext = vOk && aOk ? 'mp4' : 'mkv';
      done = await attempt('Rewrapping it in a fresh file', freePath(OUT, `${stem} (repaired).${ext}`),
        [...lenient, '-i', file, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...(ext === 'mp4' ? ['-movflags', '+faststart'] : [])], 0.35, 0.25, 0.97);
      if (done) { step('Rewrapped in a fresh file: the picture and sound are untouched', true); job.result.how = 'rewrapped'; }
    }
    // 2. re-made frame by frame: damaged frames are patched from the ones around them, the sound kept in step
    if (!done && info.video) {
      done = await attempt('Re-making it frame by frame', freePath(OUT, `${stem} (repaired).mp4`),
        [...lenient, '-ec', 'guess_mvs+deblock+favor_inter', '-i', file, '-map', '0:v:0', '-map', '0:a:0?',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-fps_mode', 'cfr',
          '-af', 'aresample=async=1000:first_pts=0', '-c:a', 'aac', '-b:a', '192k', '-max_muxing_queue_size', '4096', '-movflags', '+faststart'], 0.6, 0.35, 0);
      if (done) { step('Re-made frame by frame: damaged frames patched from the ones around them, sound kept in step', true); job.result.how = 'remade'; }
    }
    // 3. the sound on its own, when no picture could be saved
    if (!done && info.audio) {
      done = await attempt('Saving the sound on its own', freePath(OUT, `${stem} (repaired, sound only).m4a`),
        [...lenient, '-i', file, '-vn', '-map', '0:a:0', '-af', 'aresample=async=1000:first_pts=0', '-c:a', 'aac', '-b:a', '192k'], 0.95, 0.05, 0.3);
      if (done) { step('Only the sound could be saved', true); job.result.how = 'sound'; }
    }
    if (!done) throw new Error('Nothing in it could be saved.');
    job.path = null;
    job.result.path = done.out;
    job.result.got = done.got;
    job.result.note = length ? `${clock(Math.min(done.got, length))} of ${clock(length)} saved` : `${clock(done.got)} saved`;
  }

  return {
    // A quick look: what it is and what's wrong with it, before anything is done.
    'POST /api/mend/check': async (req) => {
      const { path: src } = await readJSONBody(req);
      needFfmpeg();
      const file = requirePath(src);
      if (!fs.existsSync(file)) throw err(404, 'That file isn’t there any more.');
      const info = await look(file);
      const { log, ...rest } = info;
      if (info.opens) return { ...rest, problems: problems(log, info) };
      const why = await problemsOf(file, info);
      return { ...rest, problems: why, cant: cantOpen(why) };
    },
    // Repair, as a job (/api/job for progress, .step for what it's doing, .result when it's done). Never overwrites.
    'POST /api/mend/repair': async (req) => {
      // ref: a working video from the same camera or program, for a recording whose index was never written
      const { path: src, ref } = await readJSONBody(req);
      needFfmpeg();
      const file = requirePath(src);
      if (!fs.existsSync(file)) throw err(404, 'That file isn’t there any more.');
      const refFile = ref ? requirePath(ref) : null;
      if (refFile && !fs.existsSync(refFile)) throw err(404, 'The working video isn’t there any more.');
      const job = newJob(`Repairing ${path.basename(file)}`);
      job.result = { steps: [] };
      job.step = 'Starting';
      return startJob(job, () => repair(job, file, refFile));
    },
    // Where repaired videos go (made when first asked for); open: show it in the file manager.
    'POST /api/mend/folder': async (req) => {
      const { open } = await readJSONBody(req).catch(() => ({}));
      await fsp.mkdir(OUT, { recursive: true });
      if (open) reveal(OUT, { select: false });
      return { path: OUT };
    },
  };
};
