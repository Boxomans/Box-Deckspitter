// Playlist sharing: a playlist (a folder at the top of the audio dump) → a short code to paste to a friend, or a
// .plylst file, listing where each song came from. Their copy reads that back and BoxTape downloads the songs.
// Only links and names travel, never the music itself.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

const PREFIX = 'PLYLST1:';
const MAX_SONGS = 500;
const TYPE = 'box-deckspitter-playlist';

/** "NA" is what yt-dlp and some taggers write for a field they didn't have: as a whole artist, or tacked on the end
 *  of a title ("Song-NA", "Song - NA"), it isn't part of the name. */
const noNA = (v) => String(v || '').replace(/^\s*N\/?A\s*$/, '').replace(/[\s_-]+N\/?A$/, '').trim();

/** The ID3v2 frames a shared song needs: title, artist and the link it was downloaded from (yt-dlp writes that as a
 *  "purl" TXXX frame and as the comment). Only frame headers and those small frames are read, so cover art is skipped. */
async function readLinkTags(file) {
  const tags = { title: null, artist: null, url: null };
  const fh = await fsp.open(file, 'r');
  try {
    const read = async (pos, n) => { const b = Buffer.alloc(n); const { bytesRead } = await fh.read(b, 0, n, pos); return b.subarray(0, bytesRead); };
    const head = await read(0, 10);
    if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3' || (head[3] !== 3 && head[3] !== 4)) return tags;
    const v4 = head[3] === 4;
    const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
    const end = 10 + syncsafe(head, 6);
    let pos = 10;
    if (head[5] & 0x40) { const x = await read(10, 4); pos += v4 ? syncsafe(x, 0) : 4 + x.readUInt32BE(0); }
    // the strings in a text frame body (after its encoding byte), split on the encoding's own terminator
    const strings = (enc, body) => {
      if (enc === 1 || enc === 2) {
        const parts = [];
        let start = 0;
        for (let i = 0; i + 1 < body.length; i += 2) if (body[i] === 0 && body[i + 1] === 0) { parts.push(body.subarray(start, i)); start = i + 2; }
        parts.push(body.subarray(start));
        let be = enc === 2;
        return parts.map((p) => {
          if (p[0] === 0xfe && p[1] === 0xff) { be = true; p = p.subarray(2); } else if (p[0] === 0xff && p[1] === 0xfe) { be = false; p = p.subarray(2); }
          return (be ? Buffer.from(p).swap16() : p).toString('utf16le').trim();
        });
      }
      return body.toString(enc === 3 ? 'utf8' : 'latin1').split('\0').map((s) => s.trim());
    };
    const isLink = (s) => /^https?:\/\/\S+$/i.test(s || '');
    while (pos + 10 <= end) {
      const fr = await read(pos, 10);
      if (fr.length < 10 || fr[0] === 0) break;
      const id = fr.toString('latin1', 0, 4);
      const size = v4 ? syncsafe(fr, 4) : fr.readUInt32BE(4);
      if (size <= 0 || pos + 10 + size > end) break;
      if (['TIT2', 'TPE1', 'TXXX', 'COMM', 'WOAS', 'WXXX'].includes(id) && size < 4096) {
        const b = await read(pos + 10, size);
        if (id === 'WOAS') { const s = b.toString('latin1').replace(/\0+$/, '').trim(); if (isLink(s)) tags.url = s; }
        else if (id === 'WXXX') { const s = strings(b[0], b.subarray(1)); const u = s[s.length - 1]; if (!tags.url && isLink(u)) tags.url = u; }
        else if (id === 'COMM') { const s = strings(b[0], b.subarray(4)); const u = s[s.length - 1]; if (!tags.url && isLink(u)) tags.url = u; }
        else {
          const s = strings(b[0], b.subarray(1));
          if (id === 'TIT2') tags.title = s[0] || null;
          else if (id === 'TPE1') tags.artist = s[0] || null;
          else if (/^purl$/i.test(s[0]) && isLink(s[1])) tags.url = s[1];
        }
      }
      pos += 10 + size;
    }
  } finally { await fh.close(); }
  return tags;
}

/** YouTube links shrink to their video id in a code. */
function shortUrl(u) {
  const m = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/)|youtu\.be\/)([\w-]{11})/i.exec(u || '');
  return m ? 'y' + m[1] : u || '';
}
function longUrl(s) {
  if (/^y[\w-]{11}$/.test(s)) return `https://www.youtube.com/watch?v=${s.slice(1)}`;
  return s;
}

/** A shared playlist from anywhere (a code, a .plylst file's text, or a message with a code in it), checked over. */
function decode(text) {
  const t = String(text || '').trim();
  let name = 'Shared playlist';
  let raw = [];
  const m = /PLYLST1:([A-Za-z0-9_-]+)/.exec(t);
  if (m) {
    let j;
    try { j = JSON.parse(zlib.inflateRawSync(Buffer.from(m[1], 'base64url'), { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8')); }
    catch { throw Object.assign(new Error('That code is cut off or mistyped. Copy the whole thing, from PLYLST1: to the end.'), { status: 400 }); }
    name = j.n || name;
    raw = (Array.isArray(j.s) ? j.s : []).map((x) => (Array.isArray(x) ? { url: longUrl(String(x[0] || '')), title: x[1], artist: x[2] } : null));
  } else if (t.startsWith('{')) {
    let j;
    try { j = JSON.parse(t); } catch { throw Object.assign(new Error('That playlist file is damaged.'), { status: 400 }); }
    if (j.type !== TYPE) throw Object.assign(new Error('That isn’t a shared playlist.'), { status: 400 });
    name = j.name || name;
    raw = Array.isArray(j.songs) ? j.songs : [];
  } else {
    throw Object.assign(new Error('That isn’t a playlist code. A code starts with PLYLST1:'), { status: 400 });
  }
  const str = (v, n) => (typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n) : '');
  const songs = [];
  for (const s of raw) {
    if (!s || songs.length >= MAX_SONGS) continue;
    const url = /^https?:\/\/\S+$/i.test(s.url || '') && String(s.url).length <= 600 ? String(s.url) : '';
    const title = noNA(str(s.title, 200));
    if (!url && !title) continue;
    songs.push({ url, title, artist: noNA(str(s.artist, 120)) });
  }
  if (!songs.length) throw Object.assign(new Error('That playlist has no songs in it.'), { status: 400 });
  return { name: str(name, 80) || 'Shared playlist', songs };
}

module.exports = function createPlaylistShare({ dumpAbs, dumpRel, readJSONBody, requirePath }) {
  const AUDIO = /\.(mp3|m4a|opus|ogg|wav|flac|aac|webm)$/i;

  async function share(folder) {
    const sub = dumpRel(folder, 'audio', { folder: true });
    if (!sub || sub.includes('/')) throw Object.assign(new Error('Pick a playlist to share'), { status: 400 });
    const dir = dumpAbs('audio', sub);
    const names = (await fsp.readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isFile() && AUDIO.test(e.name)).map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    if (!names.length) throw Object.assign(new Error('That playlist is empty'), { status: 400 });
    const songs = [];
    let linked = 0;
    for (const n of names.slice(0, MAX_SONGS)) {
      const base = n.replace(/\.[^.]+$/, '');
      const t = /\.mp3$/i.test(n) ? await readLinkTags(path.join(dir, n)).catch(() => ({})) : {};
      if (t.url) linked++;
      // without a title tag, the file name ("Artist - Song") stands in
      songs.push({ url: t.url || '', title: noNA(t.title || base), artist: noNA(t.artist || '') });
    }
    // in the code, an artist already in the title is left out
    const s = songs.map((x) => {
      const row = [shortUrl(x.url), x.title];
      if (x.artist && !x.title.toLowerCase().includes(x.artist.toLowerCase())) row.push(x.artist);
      return row;
    });
    const code = PREFIX + zlib.deflateRawSync(Buffer.from(JSON.stringify({ n: sub, s })), { level: 9 }).toString('base64url');
    const file = JSON.stringify({ type: TYPE, version: 1, name: sub, songs }, null, 2);
    return { name: sub, count: songs.length, linked, more: Math.max(0, names.length - MAX_SONGS), code, file };
  }

  return {
    'GET /api/audio/share': async (req, q) => share(q.get('folder')),
    // a code or a .plylst file's text (or the file itself, by path) → the playlist's name and songs
    'POST /api/audio/share/read': async (req) => {
      const { text, path: p } = await readJSONBody(req);
      if (p) {
        const full = requirePath(p);
        const st = await fsp.stat(full);
        if (st.size > 2 * 1024 * 1024) throw Object.assign(new Error('That file is too big to be a playlist'), { status: 400 });
        return decode((await fsp.readFile(full, 'utf8')).replace(/^﻿/, ''));
      }
      return decode(text);
    },
  };
};
module.exports.decode = decode;
module.exports.readLinkTags = readLinkTags;
