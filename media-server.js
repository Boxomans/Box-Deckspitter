// Media: streaming, external tools (yt-dlp / ffmpeg), BoxKlep scanning & download jobs, links → MP3s.

'use strict';

const { spawn, execFileSync } = require('child_process');
const { Readable } = require('stream');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

module.exports = function createMedia({
  AUDIO_DUMP, BROWSER_UA, DATA, IS_WIN, MEDIA_MIME, MIME, checkUrl, dumpAbs, dumpRel, dumpRelOf, klepFolder, ok,
  platform, playlists, readJSONBody, readSongTags, requirePath, spotify,
}) {
  function findExe(name) {
    const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
    const dirs = [
      path.join(DATA, 'bin'),
      ...(process.env.PATH || process.env.Path || '').split(path.delimiter),
      ...(IS_WIN ? [
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WinGet', 'Links'), // winget run from an admin terminal
        path.join(os.homedir(), 'scoop', 'shims'), 'C:\\ProgramData\\chocolatey\\bin', 'C:\\ffmpeg\\bin',
        ...savedPathDirs(),
      ] : ['/usr/local/bin', '/opt/homebrew/bin']),
    ].filter(Boolean);
    for (const d of dirs) for (const e of exts) {
      const p = path.join(d, name + e);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
    return IS_WIN ? wingetPackageExe(name) : null;
  }

  // The app's PATH is the one it started with, so a tool installed since (winget in a terminal, or BoxTape's button) may only
  // be on the PATH Windows has saved. Read that fresh from the registry (at most every 15 s).
  let savedPath = { at: 0, dirs: [] };
  function savedPathDirs() {
    if (Date.now() - savedPath.at < 15000) return savedPath.dirs;
    const dirs = [];
    for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
      try {
        const out = execFileSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
        const m = /\sPath\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(out);
        if (m) dirs.push(...m[1].trim().split(';').map((d) => d.replace(/%([^%]+)%/g, (all, v) => process.env[v] ?? all)));
      } catch { /* no saved Path there */ }
    }
    savedPath = { at: Date.now(), dirs };
    return dirs;
  }
  /** Last resort: winget's own package folders (yt-dlp.yt-dlp_…, Gyan.FFmpeg_…), where the exe sits a few folders down
   *  even when winget couldn't make a link to it. */
  function wingetPackageExe(name) {
    const want = new RegExp(`(^|\\.)${name}[._]`, 'i');
    const file = name.toLowerCase() + '.exe';
    const look = (dir, depth) => {
      let list = [];
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
      const hit = list.find((d) => d.isFile() && d.name.toLowerCase() === file);
      if (hit) return path.join(dir, hit.name);
      if (depth <= 0) return null;
      for (const d of list) if (d.isDirectory()) { const r = look(path.join(dir, d.name), depth - 1); if (r) return r; }
      return null;
    };
    for (const root of [path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WinGet', 'Packages')]) {
      let pkgs = [];
      try { pkgs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const d of pkgs) if (d.isDirectory() && want.test(d.name)) { const r = look(path.join(root, d.name), 3); if (r) return r; }
    }
    return null;
  }
  function tools() { return { ytdlp: findExe('yt-dlp'), ffmpeg: findExe('ffmpeg') }; }

  async function streamFile(req, res, file) {
    const st = await fsp.stat(file);
    const type = MEDIA_MIME[path.extname(file).toLowerCase()] || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] ? Number(m[1]) : st.size - Number(m[2] || 0);
      let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, st.size - 1);
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    }
  }

  const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mov|mkv|ogv|m3u8|mpd|mp3|m4a|wav|ogg|flac)(?:$|[?#])/i;
  const SITE_RE = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com|twitter\.com|x\.com|instagram\.com|facebook\.com|fb\.watch|reddit\.com|redd\.it|soundcloud\.com|bilibili\.com|streamable\.com|bandcamp\.com|rumble\.com|kick\.com|odysee\.com|bsky\.app)$/i;

  function extractMedia(html, base) {
    const found = new Map();
    const add = (raw, how, extra = {}) => {
      if (!raw) return;
      let u = raw.trim().replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
      if (u.startsWith('blob:') || u.startsWith('data:')) return;
      try { u = new URL(u, base).href; } catch { return; }
      if (!/^https?:/.test(u)) return;
      if (!found.has(u)) found.set(u, { url: u, how, ...extra });
    };
    const attr = (tag, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag); return m ? m[1] : null; };
    let poster = null;
    for (const m of html.matchAll(/<video\b[^>]*>/gi)) { add(attr(m[0], 'src'), 'video tag'); poster = poster || attr(m[0], 'poster'); }
    for (const m of html.matchAll(/<source\b[^>]*>/gi)) {
      const t = attr(m[0], 'type') || '';
      const s = attr(m[0], 'src');
      if (s && (/video|audio|mpegurl/i.test(t) || VIDEO_EXT_RE.test(s))) add(s, 'source tag', { mime: t || undefined });
    }
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
      const key = (attr(m[0], 'property') || attr(m[0], 'name') || attr(m[0], 'itemprop') || '').toLowerCase();
      if (/^(og:video(:url|:secure_url)?|twitter:player:stream|contenturl)$/.test(key)) add(attr(m[0], 'content'), 'page metadata');
      if (key === 'og:image' && !poster) poster = attr(m[0], 'content');
    }
    for (const m of html.matchAll(/"contentUrl"\s*:\s*"([^"]+)"/gi)) add(m[1], 'structured data');
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) if (VIDEO_EXT_RE.test(m[1])) add(m[1], 'link');
    for (const m of html.matchAll(/(?:https?:)?(?:\\?\/){2}[^\s"'<>()\\]+?\.(?:mp4|m4v|webm|mov|mkv|ogv|m3u8)(?:\?[^\s"'<>\\]*)?/gi)) add(m[0].startsWith('//') || m[0].startsWith('\\/') ? 'https:' + m[0].replace(/\\\//g, '/') : m[0], 'page source');
    const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || '').trim().replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    let posterUrl = null;
    try { posterUrl = poster ? new URL(poster.replace(/&amp;/g, '&'), base).href : null; } catch { /* ignore */ }
    return { title, poster: posterUrl, items: [...found.values()].slice(0, 80) };
  }

  async function probe(url, referer) {
    const headers = { 'User-Agent': BROWSER_UA, Range: 'bytes=0-0' };
    if (referer) headers.Referer = referer;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(url, { headers, redirect: 'follow', signal: ctl.signal });
      const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const cr = r.headers.get('content-range');
      const size = cr && /\/(\d+)$/.test(cr) ? Number(/\/(\d+)$/.exec(cr)[1]) : Number(r.headers.get('content-length')) || null;
      try { await r.body?.cancel(); } catch { /* ignore */ }
      return { ok: r.ok || r.status === 206, status: r.status, type, size: r.status === 206 || size > 1 ? size : null, finalUrl: r.url };
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? 'timed out' : e.message };
    } finally { clearTimeout(t); }
  }

  function runCapture(cmd, args, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; if (out.length > 64 * 1024 * 1024) child.kill(); });
      child.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => { child.kill(); reject(new Error('Timed out')); }, timeoutMs);
      child.on('error', (e) => { clearTimeout(t); reject(e); });
      child.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error((err.split('\n').filter((l) => /ERROR/.test(l)).pop() || err.slice(-400) || `exit ${code}`).trim())); });
    });
  }

  /** @param {'on'|'off'|undefined} playlist  for links that are both a video and a playlist (watch?v=…&list=…) */
  async function ytdlpInfo(url, { playlist } = {}) {
    const exe = tools().ytdlp;
    if (!exe) return null;
    const flag = playlist === 'on' ? ['--yes-playlist'] : playlist === 'off' ? ['--no-playlist'] : [];
    const json = JSON.parse(await runCapture(exe, ['-J', '--no-warnings', '--flat-playlist', ...flag, '--', url], 300000));
    const hasFfmpeg = !!tools().ffmpeg;
    const toItem = (v) => {
      const fmts = (v.formats || []).filter((f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.protocol && /^https?$/.test(f.protocol));
      const progressive = fmts.sort((a, b) => (b.height || 0) - (a.height || 0)).slice(0, 4).map((f) => ({
        label: `${f.height ? f.height + 'p' : f.format_note || f.format_id} ${f.ext}${f.fps ? ' ' + Math.round(f.fps) + 'fps' : ''}`, selector: f.format_id, size: f.filesize || f.filesize_approx || null,
      }));
      const options = [
        { label: hasFfmpeg ? 'Best quality (video + audio)' : 'Best single file', selector: hasFfmpeg ? 'bv*+ba/b' : 'b[ext=mp4]/b', size: null },
        ...progressive,
        { label: hasFfmpeg ? 'Audio only (mp3)' : 'Audio only (m4a)', selector: hasFfmpeg ? 'ba/b' : 'ba[ext=m4a]/ba', audio: true, size: null },
      ];
      return {
        id: crypto.randomBytes(6).toString('hex'), type: 'ytdlp', url: v.webpage_url || v.url || url, title: v.title || v.id || 'video',
        thumb: v.thumbnail || (v.thumbnails && v.thumbnails[v.thumbnails.length - 1]?.url) || null, duration: v.duration || null,
        uploader: v.uploader || v.channel || null, options, extractor: v.extractor_key || v.ie_key,
      };
    };
    if (json._type === 'playlist') {
      return { title: json.title, playlist: true, items: (json.entries || []).slice(0, 500).map((e) => ({ ...toItem(e), url: e.url && /^https?:/.test(e.url) ? e.url : e.webpage_url || e.url })) };
    }
    return { title: json.title, items: [toItem(json)] };
  }

  const jobs = new Map();
  function newJob(label) {
    const id = crypto.randomBytes(8).toString('hex');
    const job = { id, label, status: 'running', progress: 0, bytes: 0, total: null, path: null, error: null, started: Date.now(), cancel: null };
    jobs.set(id, job);
    return job;
  }
  function jobView(j) { const { cancel, ...rest } = j; void cancel; return rest; }

  function safeFileName(name, fallback = 'video') {
    const n = String(name || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);
    return n.replace(/[. ]+$/, '') || fallback;
  }
  async function uniquePath(dir, name) {
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let p = path.join(dir, name);
    for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
    return p;
  }

  async function downloadDirect(job, url, dest, referer) {
    const ctl = new AbortController();
    job.cancel = () => ctl.abort();
    const headers = { 'User-Agent': BROWSER_UA };
    if (referer) headers.Referer = referer;
    const r = await fetch(url, { headers, redirect: 'follow', signal: ctl.signal });
    if (!r.ok) throw new Error(`Server answered ${r.status}`);
    job.total = Number(r.headers.get('content-length')) || null;
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    const body = Readable.fromWeb(r.body);
    body.on('data', (c) => { job.bytes += c.length; job.progress = job.total ? job.bytes / job.total : 0; });
    await new Promise((resolve, reject) => { body.pipe(out); out.on('finish', resolve); out.on('error', reject); body.on('error', reject); });
    await fsp.rename(tmp, dest);
  }

  async function downloadHls(job, url, dest, referer) {
    const headers = { 'User-Agent': BROWSER_UA };
    if (referer) headers.Referer = referer;
    const ctl = new AbortController();
    job.cancel = () => ctl.abort();
    const text = async (u) => { const r = await fetch(u, { headers, signal: ctl.signal }); if (!r.ok) throw new Error(`Playlist answered ${r.status}`); return r.text(); };
    let pl = await text(url);
    let base = url;
    if (/#EXT-X-STREAM-INF/.test(pl)) {
      const lines = pl.split(/\r?\n/);
      let best = null;
      for (let i = 0; i < lines.length; i++) {
        const m = /#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/.exec(lines[i]);
        if (m && lines[i + 1] && !lines[i + 1].startsWith('#')) { const bw = Number(m[1]); if (!best || bw > best.bw) best = { bw, uri: lines[i + 1].trim() }; }
      }
      if (!best) throw new Error('No playable variant in this stream');
      base = new URL(best.uri, url).href;
      pl = await text(base);
    }
    if (/#EXT-X-KEY:(?![^\n]*METHOD=NONE)/.test(pl)) throw new Error('This stream is encrypted (DRM-protected), so it can’t be downloaded.');
    const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(pl);
    const segs = pl.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => new URL(l.trim(), base).href);
    if (!segs.length) throw new Error('Empty stream');
    if (init && dest.endsWith('.ts')) { dest = dest.slice(0, -3) + '.mp4'; job.path = dest; } // fragmented-MP4 stream
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    const write = (buf) => new Promise((res, rej) => out.write(buf, (e) => (e ? rej(e) : res())));
    if (init) { const r = await fetch(new URL(init[1], base).href, { headers, signal: ctl.signal }); await write(Buffer.from(await r.arrayBuffer())); }
    for (let i = 0; i < segs.length; i++) {
      const r = await fetch(segs[i], { headers, signal: ctl.signal });
      if (!r.ok) throw new Error(`Segment ${i + 1} failed (${r.status})`);
      const buf = Buffer.from(await r.arrayBuffer());
      job.bytes += buf.length;
      await write(buf);
      job.progress = (i + 1) / segs.length;
    }
    await new Promise((res) => out.end(res));
    await fsp.rename(tmp, dest);
  }

  function downloadYtdlp(job, url, dir, selector) {
    return new Promise((resolve, reject) => {
      const exe = tools().ytdlp;
      if (!exe) return reject(new Error('yt-dlp is not installed'));
      const args = ['-f', selector || 'b', '-o', path.join(dir, '%(title).120B [%(id)s].%(ext)s'), '--newline', '--no-playlist', '--no-mtime', '--no-warnings',
        '--print', 'after_move:filepath', '--windows-filenames'];
      const ff = tools().ffmpeg;
      if (ff) args.push('--ffmpeg-location', ff, '--merge-output-format', 'mp4');
      if (/^ba/.test(selector || '') && ff) args.push('-x', '--audio-format', 'mp3');
      args.push('--', url);
      const child = spawn(exe, args, { windowsHide: true });
      job.cancel = () => child.kill();
      let last = '';
      let meta = { artist: '', title: '', genre: '' };
      let err = '';
      child.stdout.on('data', (d) => {
        for (const line of String(d).split(/\r?\n/)) {
          const m = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)(\w+)/.exec(line);
          if (m) {
            job.progress = Number(m[1]) / 100;
            const mult = { KiB: 1024, MiB: 1048576, GiB: 1073741824, B: 1 }[m[3]] || 1;
            job.total = Math.round(Number(m[2]) * mult);
            job.bytes = Math.round(job.total * job.progress);
          } else if (line.trim() && !line.startsWith('[')) last = line.trim();
        }
      });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0 && last && fs.existsSync(last)) { job.path = last; resolve(); }
        else reject(new Error((err.split('\n').filter((l) => /ERROR/.test(l)).pop() || err.slice(-300) || `yt-dlp exited ${code}`).trim()));
      });
    });
  }

  // ---- audio grabbing: links → MP3s in the audio dump (BoxKlep's "MP3 → audio dump" and BoxTape)

  /** One link (YouTube, SoundCloud, any yt-dlp site) → MP3 with title/artist/cover art. Resolves to { file, meta }, meta
   *  being the artist, title and genre the site gave (blank where it gave none). */
  function ytdlpToMp3(track, url, dir, onProgress, onChild, outName = null) {
    return new Promise((resolve, reject) => {
      const t = tools();
      if (!t.ytdlp) return reject(new Error('yt-dlp is not installed (winget install yt-dlp)'));
      if (!t.ffmpeg) return reject(new Error('Making MP3s needs ffmpeg (winget install Gyan.FFmpeg)'));
      const args = ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg',
        '--no-playlist', '--newline', '--no-warnings', '--no-mtime', '--windows-filenames', '--ffmpeg-location', t.ffmpeg,
        '-o', path.join(dir, outName ? outName.replace(/%/g, '%%') + '.%(ext)s' : '%(title).120B.%(ext)s'), '--print', 'after_move:BDSMETA%(artist,creator,uploader)s	%(track,title)s	%(genre)s', '--print', 'after_move:filepath', '--', url];
      const child = spawn(t.ytdlp, args, { windowsHide: true });
      onChild(child);
      let last = '';
      let meta = { artist: '', title: '', genre: '' };
      let err = '';
      child.stdout.on('data', (d) => {
        for (const line of String(d).split(/\r?\n/)) {
          const m = /\[download\]\s+([\d.]+)%/.exec(line);
          if (line.startsWith('BDSMETA')) {
            const [artist, title, genre] = line.slice(7).split('	').map((v) => (v && v !== 'NA' ? v.trim() : ''));
            meta = { artist, title, genre };
          } else if (m) onProgress(Number(m[1]) / 100 * 0.9);
          else if (/\[ExtractAudio\]|\[EmbedThumbnail\]|\[Metadata\]/.test(line)) onProgress(0.95);
          else if (line.trim() && !line.startsWith('[')) last = line.trim();
        }
      });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0 && last && fs.existsSync(last)) resolve({ file: last, meta });
        else reject(new Error((err.split('\n').filter((l) => /ERROR/.test(l)).pop() || err.slice(-300) || `yt-dlp exited ${code}`).replace(/^ERROR:\s*/, '').trim()));
      });
    });
  }

  /** A downloaded .ts stream → .mp4 next to it (same video and sound, just a different container). */
  async function remuxToMp4(job) {
    const src = job.path;
    const out = await uniquePath(path.dirname(src), path.basename(src).replace(/\.ts$/i, '.mp4'));
    const code = await new Promise((resolve) => {
      const child = spawn(tools().ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', src, '-c', 'copy', '-movflags', '+faststart', out], { windowsHide: true, stdio: 'ignore' });
      child.on('close', resolve);
      child.on('error', () => resolve(1));
    });
    if (code === 0) { await fsp.rm(src, { force: true }).catch(() => {}); job.path = out; } else await fsp.rm(out, { force: true }).catch(() => {});
  }

  /** A direct video/audio file or an HLS stream → MP3 with ffmpeg. */
  function ffmpegToMp3(url, dest, referer, onProgress, onChild) {
    return new Promise((resolve, reject) => {
      const ff = tools().ffmpeg;
      if (!ff) return reject(new Error('Making MP3s needs ffmpeg (winget install Gyan.FFmpeg)'));
      const headers = `User-Agent: ${BROWSER_UA}\r\n${referer ? `Referer: ${referer}\r\n` : ''}`;
      const child = spawn(ff, ['-hide_banner', '-y', '-headers', headers, '-i', url, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', dest], { windowsHide: true });
      onChild(child);
      let err = '';
      let duration = 0;
      child.stderr.on('data', (d) => {
        const s2 = String(d);
        err = (err + s2).slice(-4000);
        const dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(s2);
        if (dm) duration = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]);
        const tm = /time=(\d+):(\d+):([\d.]+)/.exec(s2);
        if (tm && duration) onProgress(Math.min(0.99, (Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3])) / duration));
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(dest) : reject(new Error(err.split('\n').filter(Boolean).slice(-2).join(' ') || `ffmpeg exited ${code}`))));
    });
  }

  /** Rewrite an MP3's title/artist/genre/BPM tags in place (cover art and audio are copied untouched). */
  function retagMp3(file, { title, artist, genre, bpm }) {
    return new Promise((resolve, reject) => {
      const ff = tools().ffmpeg;
      if (!ff) return resolve();
      const tmp = file.replace(/\.mp3$/i, '') + '.tag.mp3';
      const args = ['-hide_banner', '-y', '-i', file, '-map', '0', '-c', 'copy', '-id3v2_version', '3'];
      if (title) args.push('-metadata', `title=${title}`);
      if (artist) args.push('-metadata', `artist=${artist}`);
      if (genre != null) args.push('-metadata', `genre=${genre}`); // '' clears it
      if (bpm) args.push('-metadata', `TBPM=${bpm}`);
      args.push(tmp);
      const child = spawn(ff, args, { windowsHide: true });
      child.on('error', reject);
      child.on('close', async (code) => {
        if (code !== 0) { await fsp.rm(tmp, { force: true }).catch(() => {}); return reject(new Error('retag failed')); }
        try { await fsp.rename(tmp, file); resolve(); } catch (e) { reject(e); }
      });
    });
  }

  // ---- a downloaded song's genre and tempo, for its tags

  /** YouTube's video categories, which yt-dlp writes as the genre (every song is "Music"): not a real genre. */
  const YT_CATEGORY = /^(music|entertainment|people & blogs|film & animation|gaming|comedy|education|howto & style|news & politics|nonprofits & activism|science & technology|sports|travel & events|autos & vehicles|pets & animals)$/i;
  const norm = (v) => String(v || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const same = (x, y) => !!(x && y && (x.includes(y) || y.includes(x)));

  /** Upload names tidied into a plain artist and title: "Artist - Topic" and VEVO channels, "(Official Video)" and the
   *  like, and "Artist - Song" titles (but not "Song - Remastered 2011"). */
  function tidySong(artist, title) {
    artist = String(artist || '').split(',')[0].replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').trim();
    title = String(title || '').replace(/\s*[([][^)\]]*(official|video|audio|lyric|visuali[sz]er|hd|4k|mv|m\/v)[^)\]]*[)\]]/gi, '').trim();
    const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
    if (dash && !/remaster|live|version|mix|edit|mono|stereo|acoustic|demo/i.test(dash[2])) { artist = dash[1]; title = dash[2]; }
    return { artist, title };
  }

  /** The best match in a song search: artist and title both matching, or failing that the artist; with no artist, the
   *  title. null when nothing fits, so an unknown song gets nothing rather than a wrong answer. */
  function pickSong(results, artist, title, artistOf, titleOf) {
    const a = norm(artist), t = norm(title);
    return results.find((x) => same(norm(artistOf(x)), a) && same(norm(titleOf(x)), t))
      || results.find((x) => same(norm(artistOf(x)), a))
      || (!a && results.find((x) => same(norm(titleOf(x)), t)))
      || null;
  }

  /** Genre from the iTunes song search (free, no key; only the artist and title are sent). null when nothing fits. */
  const genreCache = new Map();
  async function findGenre(artist, title) {
    ({ artist, title } = tidySong(artist, title));
    if (!title) return null;
    const key = norm(artist) + '|' + norm(title);
    if (genreCache.has(key)) return genreCache.get(key);
    const q = new URLSearchParams({ term: `${artist} ${title}`.trim(), media: 'music', entity: 'song', limit: '10' });
    const r = await fetch(`https://itunes.apple.com/search?${q}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const hit = pickSong((await r.json()).results || [], artist, title, (x) => x.artistName, (x) => x.trackName);
    const genre = hit?.primaryGenreName || null;
    genreCache.set(key, genre);
    return genre;
  }

  /** BPM from Deezer's song search (free, no key; only the artist and title are sent). Deezer has it for many songs but
   *  not all (it says 0); null then, or when nothing fits. */
  async function deezerBpm(artist, title) {
    ({ artist, title } = tidySong(artist, title));
    if (!title) return null;
    const q = new URLSearchParams({ q: `${artist} ${title}`.trim(), limit: '10' });
    const r = await fetch(`https://api.deezer.com/search?${q}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const hit = pickSong((await r.json()).data || [], artist, title, (x) => x.artist?.name, (x) => x.title);
    if (!hit?.id) return null;
    const t = await fetch(`https://api.deezer.com/track/${hit.id}`, { signal: AbortSignal.timeout(8000) }).then((x) => (x.ok ? x.json() : null));
    return t?.bpm > 0 ? Math.round(t.bpm) : null;
  }

  /** The tempo measured from the song itself: 90 s from past its intro, decoded small and mono; how much louder each
   *  ~12 ms gets than the last (where the beats land); and which beat spacing between 70 and 180 BPM lines up with
   *  itself best. Like most beat counters it can land on half or double the tempo. null if it can't tell. */
  function measureBpm(file) {
    return new Promise((resolve) => {
      const ff = tools().ffmpeg;
      if (!ff) return resolve(null);
      const RATE = 11025, HOP = 128;
      const child = spawn(ff, ['-hide_banner', '-v', 'error', '-ss', '30', '-t', '90', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { windowsHide: true });
      const chunks = [];
      child.stdout.on('data', (d) => chunks.push(d));
      child.on('error', () => resolve(null));
      child.on('close', () => {
        const buf = Buffer.concat(chunks);
        const pcm = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
        const frames = Math.floor(pcm.length / HOP);
        if (frames < 400) return resolve(null);
        // onset strength: the rise in log energy from one hop to the next
        const flux = new Float32Array(frames);
        let prev = 0;
        for (let f = 0; f < frames; f++) {
          let e = 0;
          for (let i = f * HOP, n = i + HOP; i < n; i++) e += pcm[i] * pcm[i];
          const le = Math.log(1e-9 + e);
          flux[f] = f ? Math.max(0, le - prev) : 0;
          prev = le;
        }
        let mean = 0;
        for (const v of flux) mean += v;
        mean /= frames;
        for (let f = 0; f < frames; f++) flux[f] -= mean;
        const fps = RATE / HOP;
        const score = (lag) => { let s = 0; for (let f = lag; f < frames; f++) s += flux[f] * flux[f - lag]; return s / (frames - lag); };
        let best = 0, bestLag = 0;
        for (let lag = Math.floor(fps * 60 / 180); lag <= Math.ceil(fps * 60 / 70); lag++) {
          // a real beat also lines up at twice its spacing, which keeps off-beat flukes down
          const s = score(lag) + 0.5 * score(lag * 2);
          if (s > best) { best = s; bestLag = lag; }
        }
        if (!bestLag) return resolve(null);
        // between whole hops: a parabola through the peak and its neighbours
        const a = score(bestLag - 1), b = score(bestLag), c = score(bestLag + 1);
        const off = a - 2 * b + c ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
        resolve(Math.round((60 * fps) / (bestLag + Math.max(-0.5, Math.min(0.5, off)))));
      });
    });
  }

  /** BPM for a downloaded song: Deezer's figure when it has one, otherwise measured from the file. */
  async function findBpm(file, artist, title) {
    return (await deezerBpm(artist, title).catch(() => null)) || measureBpm(file);
  }

  /** Downloads left in audio-dump/.incoming when the app closed before moving them in. They never got their tags or
   *  playlist and never reached the audio dump, so downloading the playlist again brings them back properly: clear
   *  them. Runs once at start, before any download can be using the folder. */
  setTimeout(() => fsp.rm(path.join(AUDIO_DUMP, '.incoming'), { recursive: true, force: true }).catch(() => {}), 2000).unref?.();

  async function grabAudio(job, items, parallel = 3, playlist = '', retries = 3) {
    // songs land at the top of the audio dump; playlist: a playlist they're added to as each one finishes
    const destDir = AUDIO_DUMP;
    await fsp.mkdir(destDir, { recursive: true });
    const children = new Set();
    let cancelled = false;
    job.cancel = () => { cancelled = true; for (const c of children) { try { c.kill(); } catch { /* gone */ } } };
    job.tracks = items.map((it) => ({ title: it.label || it.title || it.name || it.url, status: 'waiting', file: null, error: null, progress: 0, note: null }));
    job.done = 0;
    job.failed = 0;
    job.parallel = parallel;
    const overall = () => { job.progress = job.tracks.reduce((a, t) => a + (t.status === 'done' || t.status === 'failed' ? 1 : t.progress || 0), 0) / items.length; };
    // YouTube turns down some of many requests made at once (403s, timeouts, "try again later") and lets the same one
    // through a few seconds later, so each step gets a few tries before the song counts as failed. Not for answers
    // that won't change: no match, missing tools, a video that's gone/private/age-locked.
    const FINAL = /unavailable|private video|removed|confirm your age|age-restricted|copyright|not available in your country|members-only|premieres/i;
    const retrying = async (tr, what, fn, tries = retries + 1) => {
      for (let n = 1; ; n++) {
        try { return await fn(); } catch (e) {
          if (cancelled || n >= tries || e.status === 404 || e.status === 400 || e.name === 'AbortError' || FINAL.test(e.message)) throw e;
          tr.note = `${what} — try ${n + 1} of ${tries}`;
          tr.progress = 0;
          overall();
          await new Promise((r) => setTimeout(r, 2000 * n + Math.random() * 1500 * n)); // 2 s, 4 s, 6 s… staggered so the workers don't retry in step
          if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        }
      }
    };
    let next = 0;
    async function worker() {
      while (!cancelled && next < items.length) {
        const i = next++;
        let it = items[i];
        const tr = job.tracks[i];
        tr.status = 'working';
        job.current = job.tracks.filter((t) => t.status === 'working').map((t) => t.title).join(' · ');
        let child = null;
        const onChild = (c) => { child = c; children.add(c); };
        const onProgress = (p) => { tr.progress = p; overall(); };
        try {
          if (it.type === 'spotify') {
            // Spotify only gives us the song; find the same recording on YouTube and download that
            tr.note = 'finding it on YouTube';
            const match = await retrying(tr, 'finding it on YouTube', () => spotify.findOnYouTube(it));
            if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
            tr.note = `from: ${match.title}`;
            const firstArtist = String(it.artist || '').split(',')[0].trim();
            it = { ...it, type: 'ytdlp', url: match.url, outName: safeFileName(firstArtist ? `${firstArtist} - ${it.title}` : it.title, 'song'), tags: { title: it.title, artist: it.artist } };
          }
          checkUrl(it.url);
          if (it.type === 'ytdlp' || !it.type) {
            // each track downloads into its own temp folder, then moves in under a unique name
            // (parallel tracks with the same title can't collide, and half-done files never show up in the player)
            const tmp = path.join(AUDIO_DUMP, '.incoming', crypto.randomBytes(6).toString('hex'));
            await fsp.mkdir(tmp, { recursive: true });
            try {
              const { file: made, meta } = await retrying(tr, 'downloading', () => ytdlpToMp3(tr, it.url, tmp, onProgress, onChild, it.outName));
              // Spotify's title/artist, not the YouTube upload's; a genre (from the site, or looked up) and the BPM
              const tags = { ...(it.tags || {}) };
              const [genre, bpm] = await Promise.all([
                (!YT_CATEGORY.test(meta.genre) && meta.genre) || findGenre(tags.artist || meta.artist, tags.title || meta.title).catch(() => null),
                findBpm(made, tags.artist || meta.artist, tags.title || meta.title).catch(() => null),
              ]);
              // no genre found: clear the one yt-dlp wrote, which is only YouTube's category ("Music")
              Object.assign(tags, { genre: genre || '', bpm });
              if (tags.title || tags.artist || tags.genre || tags.bpm) await retagMp3(made, tags).catch(() => {});
              const dest = await uniquePath(destDir, path.basename(made));
              await fsp.rename(made, dest);
              tr.file = dest;
            } finally {
              fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
            }
          } else {
            let base = it.name || it.title || 'audio';
            try { if (!it.name && !it.title) base = decodeURIComponent(path.basename(new URL(it.url).pathname)); } catch { /* ignore */ }
            const dest = await uniquePath(destDir, safeFileName(base.replace(/\.[a-z0-9]{2,5}$/i, ''), 'audio') + '.mp3');
            tr.file = await ffmpegToMp3(it.url, dest, it.referer, onProgress, onChild);
          }
          tr.status = 'done';
          tr.name = dumpRelOf('audio', tr.file) || path.basename(tr.file); // its name in the audio dump, as the player names it
          if (playlist) await playlists.add(playlist, [tr.name]).catch(() => {});
          job.done++;
        } catch (e) {
          if (cancelled) { tr.status = 'cancelled'; } else { tr.status = 'failed'; tr.error = e.message; job.failed++; }
        } finally {
          if (child) children.delete(child);
          overall();
          job.current = job.tracks.filter((t) => t.status === 'working').map((t) => t.title).join(' · ') || null;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, items.length)) }, worker));
    for (const t of job.tracks) if (t.status === 'waiting') t.status = 'cancelled';
    job.current = null;
    if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    if (!job.done && job.failed) throw new Error(job.tracks.find((t) => t.error)?.error || 'Nothing could be converted');
  }

  function runFfmpegJob(job, args, durationSec) {
    return new Promise((resolve, reject) => {
      const exe = tools().ffmpeg;
      if (!exe) return reject(new Error('ffmpeg not found'));
      const child = spawn(exe, ['-hide_banner', '-y', ...args], { windowsHide: true });
      job.cancel = () => child.kill();
      let err = '';
      child.stderr.on('data', (d) => {
        const s = String(d);
        err = (err + s).slice(-4000);
        const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
        if (m && durationSec) job.progress = Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / durationSec);
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.split('\n').filter(Boolean).slice(-2).join(' ') || `ffmpeg exited ${code}`))));
    });
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
  }

  function startJob(job, work) {
    work().then(() => { job.status = 'done'; job.progress = 1; }).catch(async (e) => {
      job.status = job.status === 'cancelled' ? 'cancelled' : 'error';
      job.error = e.name === 'AbortError' ? 'cancelled' : e.message;
      if (job.path) await fsp.unlink(job.path + '.part').catch(() => {});
    });
    return { id: job.id };
  }

  // ---- songs like a playlist's, from Deezer (free, no key; only artist names are sent)

  const deezer = async (p) => {
    const r = await fetch(`https://api.deezer.com/${p}`, { signal: AbortSignal.timeout(8000) });
    const j = r.ok ? await r.json() : null;
    if (!j || j.error) throw new Error('Deezer didn’t answer');
    return j.data || [];
  };
  const deezerArtists = new Map(); // name → Deezer artist id (or null)
  async function deezerArtist(name) {
    const key = norm(name);
    if (deezerArtists.has(key)) return deezerArtists.get(key);
    const hit = (await deezer(`search/artist?${new URLSearchParams({ q: name, limit: '5' })}`)).find((a) => norm(a.name) === key) || null;
    deezerArtists.set(key, hit?.id || null);
    return hit?.id || null;
  }

  /** Who a playlist's songs are by: the artist tag, or "Artist - Song" in the file name. Most songs first. */
  async function playlistArtists(paths) {
    const count = new Map();
    await mapLimit(paths.slice(0, 300), 8, async (p) => {
      let artist = null;
      try { artist = (await readSongTags(requirePath(p))).artist; } catch { /* unreadable: the name may still say */ }
      if (!artist) { const m = /^(.+?)\s+[-–—]\s+.+$/.exec(path.basename(p).replace(/\.[^.]+$/, '')); if (m) artist = m[1]; }
      artist = String(artist || '').split(/,|;|\s(?:feat\.?|ft\.?|&|x)\s/i)[0].trim();
      if (!artist) return;
      const k = norm(artist);
      const c = count.get(k) || { name: artist, n: 0 };
      c.n++;
      count.set(k, c);
    });
    return [...count.values()].sort((a, b) => b.n - a.n);
  }

  const shuffled = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  /** Songs by artists like the playlist's (Deezer's related artists, then their top songs), leaving out songs already in
   *  the audio dump; at most two per artist, best fits first. */
  async function recommend(paths, have) {
    const seeds = (await playlistArtists(paths)).slice(0, 6);
    if (!seeds.length) return { items: [], note: 'None of these songs say who they’re by, so there’s nothing to go on.' };
    const own = new Set(seeds.map((s) => norm(s.name)));
    const related = new Map(); // artist id → { name, score }
    const ids = await mapLimit(seeds, 3, (s) => deezerArtist(s.name).catch(() => null));
    await mapLimit(seeds.map((s, i) => [s, ids[i]]).filter(([, id]) => id), 3, async ([s, id]) => {
      const rel = await deezer(`artist/${id}/related?limit=8`).catch(() => []);
      rel.forEach((a, k) => {
        if (own.has(norm(a.name))) return;
        const r = related.get(a.id) || { id: a.id, name: a.name, score: 0 };
        r.score += s.n * (1 - k / 10); // liked by more of the playlist, and nearer the top of Deezer's list
        related.set(a.id, r);
      });
    });
    if (!ids.some(Boolean)) throw new Error('Deezer doesn’t know these artists');
    const haveSet = new Set((have || []).map((n) => norm(String(n).replace(/\.[^.]+$/, '').split('/').pop())));
    const owned = (artist, title) => {
      const t = norm(title), a = norm(artist);
      // "Artist - Song" names, and songs named just by their title
      return [...haveSet].some((h) => h === t || (h.includes(t) && h.includes(a)));
    };
    // the closest six artists every time, and six more picked at random from the next ones, so asking again finds others
    const ranked = [...related.values()].sort((a, b) => b.score - a.score);
    const pick = [...ranked.slice(0, 6), ...shuffled(ranked.slice(6, 24)).slice(0, 6)];
    const tops = await mapLimit(pick, 4, (a) => deezer(`artist/${a.id}/top?limit=8`).catch(() => []));
    const seen = new Set();
    const per = pick.map((a, i) => shuffled(tops[i].filter((t) => t.readable !== false && t.title && !owned(a.name, t.title_short || t.title)))
      .filter((t) => { const k = norm(a.name) + '|' + norm(t.title_short || t.title); return !seen.has(k) && seen.add(k); }) // one of each song, not every version
      .slice(0, 2).map((t) => ({ title: t.title_short || t.title, artist: t.artist?.name || a.name, duration: t.duration || null, url: t.link })));
    // one song from each artist first, then the second ones
    const items = [...per.map((s) => s[0]), ...per.map((s) => s[1])].filter(Boolean).slice(0, 20);
    return { items, basedOn: seeds.map((s) => s.name) };
  }

  // ---- Linux: yt-dlp and ffmpeg into data/bin (findExe looks there first), no password needed. yt-dlp is its own
  // official single-file build; ffmpeg the static build yt-dlp's own docs point to (BtbN), unpacked with the system's tar.
  const LINUX_BUILDS = new Map([
    ['x64', { ytdlp: 'yt-dlp_linux', ffmpeg: 'ffmpeg-master-latest-linux64-gpl.tar.xz' }],
    ['arm64', { ytdlp: 'yt-dlp_linux_aarch64', ffmpeg: 'ffmpeg-master-latest-linuxarm64-gpl.tar.xz' }],
  ]);
  async function installLinuxTools() {
    const builds = process.platform === 'linux' && LINUX_BUILDS.get(process.arch);
    if (!builds) throw Object.assign(new Error(`Install them with your package manager: ${platform.installHint('yt-dlp')} and ${platform.installHint('ffmpeg')}`), { status: 400 });
    const t = tools();
    const want = [!t.ytdlp && 'yt-dlp', !t.ffmpeg && 'ffmpeg'].filter(Boolean);
    if (!want.length) return { id: null, already: true };
    const bin = path.join(DATA, 'bin');
    const job = newJob(`Installing ${want.join(' + ')}`);
    const fetchTo = async (url, dest, share) => {
      const ctl = new AbortController();
      job.cancel = () => ctl.abort();
      const r = await fetch(url, { redirect: 'follow', signal: ctl.signal });
      if (!r.ok || !r.body) throw new Error(`the download failed (${r.status})`);
      const size = Number(r.headers.get('content-length')) || 0;
      let got = 0;
      const out = fs.createWriteStream(dest);
      for await (const chunk of Readable.fromWeb(r.body)) {
        got += chunk.length;
        if (size) job.progress = share[0] + (got / size) * share[1];
        if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      }
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    };
    return startJob(job, async () => {
      await fsp.mkdir(bin, { recursive: true });
      for (const [i, name] of want.entries()) {
        const share = [i / want.length, 1 / want.length];
        job.current = `Downloading ${name} (${i + 1} of ${want.length})${name === 'ffmpeg' ? ' — about 130 MB' : ''}…`;
        try {
          if (name === 'yt-dlp') {
            const dest = path.join(bin, 'yt-dlp');
            await fetchTo(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${builds.ytdlp}`, dest + '.part', share);
            await fsp.chmod(dest + '.part', 0o755);
            await fsp.rename(dest + '.part', dest);
          } else {
            const tmp = path.join(bin, '.ffmpeg-download');
            await fsp.rm(tmp, { recursive: true, force: true });
            await fsp.mkdir(tmp, { recursive: true });
            try {
              const xz = path.join(tmp, 'ffmpeg.tar.xz');
              await fetchTo(`https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${builds.ffmpeg}`, xz, share);
              job.current = 'Unpacking ffmpeg…';
              await runCapture('tar', ['-xJf', xz, '-C', tmp, '--strip-components=2', '--wildcards', '*/bin/ffmpeg', '*/bin/ffprobe'], 5 * 60 * 1000);
              for (const f of ['ffmpeg', 'ffprobe']) { await fsp.chmod(path.join(tmp, f), 0o755); await fsp.rename(path.join(tmp, f), path.join(bin, f)); }
            } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          throw new Error(`Couldn’t install ${name} (${e.message}). Install it by hand: ${platform.installHint(name)}`);
        }
        if (!findExe(name)) throw new Error(`${name} was downloaded but won’t run here. Install it by hand: ${platform.installHint(name)}`);
      }
      job.current = null;
    });
  }

  const routes = {
    'POST /api/music/recommend': async (req) => {
      const { paths, have } = await readJSONBody(req);
      if (!Array.isArray(paths) || !paths.length) throw Object.assign(new Error('That playlist is empty'), { status: 400 });
      return recommend(paths.filter((p) => typeof p === 'string'), Array.isArray(have) ? have.slice(0, 20000) : []);
    },
    'GET /api/tools': async () => {
      const t = tools();
      return {
        ytdlp: !!t.ytdlp, ffmpeg: !!t.ffmpeg, ytdlpPath: t.ytdlp, ffmpegPath: t.ffmpeg, downloads: klepFolder(), mediaDump: dumpAbs('media', ''),
        canInstall: IS_WIN || LINUX_BUILDS.has(process.arch) && process.platform === 'linux',
        hints: { ytdlp: platform.installHint('yt-dlp'), ffmpeg: platform.installHint('ffmpeg') }, // to install them by hand
      };
    },

    // installs whichever of yt-dlp / ffmpeg is missing with winget (Windows' own package manager), one after the other.
    // A job: the client polls /api/job for job.current (what's happening) and the end. winget puts both in its Links
    // folder, which findExe already looks in, so they work straight away without a restart.
    'POST /api/tools/install': async () => {
      if (!IS_WIN) return installLinuxTools();
      const t = tools();
      const want = [!t.ytdlp && ['yt-dlp', 'yt-dlp.yt-dlp'], !t.ffmpeg && ['ffmpeg', 'Gyan.FFmpeg']].filter(Boolean);
      if (!want.length) return { id: null, already: true };
      const winget = findExe('winget') || path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'winget.exe');
      const job = newJob(`Installing ${want.map(([n]) => n).join(' + ')}`);
      return startJob(job, async () => {
        for (const [i, [name, id]] of want.entries()) {
          job.current = `Installing ${name} (${i + 1} of ${want.length}) — this can take a minute or two…`;
          job.progress = i / want.length;
          try {
            await runCapture(winget, ['install', '--id', id, '-e', '--source', 'winget', '--silent', '--disable-interactivity',
              '--accept-package-agreements', '--accept-source-agreements'], 15 * 60 * 1000);
          } catch (e) {
            if (e.code === 'ENOENT') throw new Error('winget isn’t on this PC. Get “App Installer” from the Microsoft Store, then try again.');
            // winget also exits non-zero for "already installed" / "no newer version": only a missing tool afterwards is a failure
            if (!findExe(name)) throw new Error(`Couldn’t install ${name}: ${String(e.message || e).split('\n').filter(Boolean).pop()}`);
          }
          if (!findExe(name)) throw new Error(`winget finished, but ${name} still can’t be found. Restart Box-Deckspitter and look again.`);
        }
        job.current = null;
      });
    },

    'POST /api/klep/scan': async (req) => {
      const { url: raw, mode = 'auto', playlist } = await readJSONBody(req);
      const url = checkUrl(raw);
      const t = tools();
      const site = SITE_RE.test(url.hostname);
      const out = { page: url.href, title: '', poster: null, items: [], ytdlp: !!t.ytdlp, ffmpeg: !!t.ffmpeg, needsYtDlp: false, notes: [] };
      const viaYtdlp = async () => {
        const info = await ytdlpInfo(url.href, { playlist });
        out.title = info.title || out.title;
        out.playlist = !!info.playlist;
        out.items = info.items;
      };
      if ((site && mode !== 'page') || mode === 'ytdlp') {
        if (t.ytdlp) {
          try { await viaYtdlp(); return out; } catch (e) { out.notes.push('yt-dlp: ' + e.message); if (mode === 'ytdlp') return out; }
        } else if (site || mode === 'ytdlp') out.needsYtDlp = true;
      }
      // a direct link to a media file?
      const p = await probe(url.href);
      if (p.ok && (/^(video|audio)\//.test(p.type) || /mpegurl/i.test(p.type))) {
        out.items = [{ id: crypto.randomBytes(6).toString('hex'), type: /mpegurl/i.test(p.type) ? 'hls' : 'direct', url: p.finalUrl || url.href, title: decodeURIComponent(path.basename(url.pathname)) || 'video', mime: p.type, size: p.size, how: 'direct link' }];
        return out;
      }
      // otherwise scan the page
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 20000);
      let r;
      try { r = await fetch(url.href, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,*/*' }, redirect: 'follow', signal: ctl.signal }); }
      catch (e) { throw Object.assign(new Error(e.name === 'AbortError' ? 'The page took too long to load' : 'Couldn’t load that page: ' + e.message), { status: 502 }); }
      finally { clearTimeout(tm); }
      const ct = r.headers.get('content-type') || '';
      if (!r.ok) out.notes.push(`The page answered ${r.status}.`);
      if (!/html|xml|text|json/i.test(ct)) { out.notes.push('That link isn’t a web page or a video file.'); return out; }
      const html = (await r.text()).slice(0, 8000000);
      const ex = extractMedia(html, r.url);
      out.title = ex.title;
      out.poster = ex.poster;
      const probed = await mapLimit(ex.items.slice(0, 40), 6, async (c) => ({ c, pr: await probe(c.url, r.url) }));
      for (const { c, pr } of probed) {
        const isHls = /\.m3u8/i.test(c.url) || /mpegurl/i.test(pr.type || '');
        const isMedia = /^(video|audio)\//.test(pr.type || '') || isHls || (pr.ok && /octet-stream|binary/.test(pr.type || '') && VIDEO_EXT_RE.test(c.url));
        if (!isMedia || (!pr.ok && !isHls) || /\.mpd(\?|$)/i.test(c.url)) continue;
        let name = 'video';
        try { name = decodeURIComponent(path.basename(new URL(c.url).pathname)) || name; } catch { /* ignore */ }
        out.items.push({ id: crypto.randomBytes(6).toString('hex'), type: isHls ? 'hls' : 'direct', url: pr.finalUrl || c.url, title: name, mime: pr.type, size: pr.size, how: c.how, referer: r.url });
      }
      if (!out.items.length && t.ytdlp && mode !== 'page') {
        try { await viaYtdlp(); } catch (e) { out.notes.push('yt-dlp couldn’t read it either: ' + e.message); }
      }
      if (!out.items.length) {
        out.notes.push(t.ytdlp ? 'No downloadable videos found on that page.' : 'No direct video files on that page. Sites like YouTube need yt-dlp.');
        if (!t.ytdlp) out.needsYtDlp = true;
      }
      return out;
    },

    // Links → MP3s in the audio dump (one at a time; failures are skipped and reported per track).
    'POST /api/audio/grab': async (req) => {
      const { items, parallel, playlist, folder, retries } = await readJSONBody(req);
      const list = (Array.isArray(items) ? items : []).filter((x) => x && typeof x.url === 'string').slice(0, 500);
      const lanes = Math.max(1, Math.min(6, Number(parallel) || 3));
      if (!list.length) throw Object.assign(new Error('Nothing to download'), { status: 400 });
      // folder: what older pages called the playlist
      const pl = String(playlist ?? folder ?? '').trim();
      const job = newJob(list.length === 1 ? (list[0].title || list[0].url) : `${list.length} tracks`);
      const again = Number.isFinite(Number(retries)) ? Math.max(0, Math.min(10, Math.round(Number(retries)))) : 3;
      return startJob(job, () => grabAudio(job, list, lanes, pl, again));
    },

    'POST /api/klep/download': async (req) => {
      const { url, type, selector, dir, name, referer, dump } = await readJSONBody(req);
      checkUrl(url);
      // dump: into the media dump instead of the chosen folder
      const target = dump ? dumpAbs('media', '') : requirePath(dir || klepFolder());
      await fsp.mkdir(target, { recursive: true });
      const job = newJob(name || url);
      if (type === 'ytdlp') return startJob(job, () => downloadYtdlp(job, url, target, selector));
      let fname = 'video';
      try { fname = decodeURIComponent(path.basename(new URL(url).pathname)) || fname; } catch { /* ignore */ }
      fname = safeFileName(name || fname);
      if (type === 'hls') fname = fname.replace(/\.m3u8$/i, '') + '.ts';
      else if (!path.extname(fname)) fname += '.mp4';
      const dest = await uniquePath(target, fname);
      job.path = dest;
      return startJob(job, async () => {
        await (type === 'hls' ? downloadHls(job, url, dest, referer) : downloadDirect(job, url, dest, referer));
        // the media dump doesn't list .ts: rewrap a stream as MP4 there (no re-encoding) when ffmpeg is around
        if (dump && /\.ts$/i.test(job.path || '') && tools().ffmpeg) await remuxToMp4(job);
      });
    },

    'GET /api/job': async (req, q) => {
      const j = jobs.get(q.get('id'));
      if (!j) throw Object.assign(new Error('No such job'), { status: 404 });
      return jobView(j);
    },
    'POST /api/job/cancel': async (req) => {
      const { id } = await readJSONBody(req);
      const j = jobs.get(id);
      if (j && j.status === 'running') { j.status = 'cancelled'; try { j.cancel?.(); } catch { /* ignore */ } }
      return { ok: true };
    },

    'POST /api/ffmpeg': async (req) => {
      const { args, duration, output, label } = await readJSONBody(req);
      if (!Array.isArray(args) || !args.length) throw Object.assign(new Error('Missing arguments'), { status: 400 });
      if (!tools().ffmpeg) throw Object.assign(new Error('ffmpeg is not installed'), { status: 501 });
      const job = newJob(label || 'ffmpeg');
      job.path = output ? requirePath(output) : null;
      return startJob(job, () => runFfmpegJob(job, args.map(String), Number(duration) || 0));
    },
  };

  return { routes, findExe, tools, streamFile, runCapture, newJob, runFfmpegJob, startJob };
};
