// Lyrics: a song's words from LRCLIB (lrclib.net: free, no key, community-made), timed line by line when it has
// them. Only the artist, title and length are sent, and only when the lyrics button is pressed.

'use strict';

const UA = 'Box-Deckspitter (https://github.com/Boxomans/Box-Deckspitter)'; // LRCLIB asks apps to say who they are

module.exports = function createLyrics() {
  const get = async (url, retry = true) => {
    let r;
    try { r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) }); } catch {
      throw Object.assign(new Error('Couldn’t reach LRCLIB'), { status: 502 });
    }
    if (r.status === 404) return null;
    if (r.status >= 500 && retry) { await new Promise((res) => setTimeout(res, 800)); return get(url, false); } // it has busy moments
    if (!r.ok) throw Object.assign(new Error(`LRCLIB answered ${r.status}`), { status: 502 });
    return r.json();
  };
  const pack = (x) => (x && (x.plainLyrics || x.syncedLyrics || x.instrumental)
    ? { artist: x.artistName, title: x.trackName, plain: x.plainLyrics || '', synced: x.syncedLyrics || '', instrumental: !!x.instrumental, source: 'LRCLIB' }
    : null);

  /** The best match: the exact song (artist + title + length) first, then a search picked by how close the length is. */
  const cache = new Map();
  async function lyrics(artist, title, dur) {
    artist = String(artist || '').trim().slice(0, 200);
    title = String(title || '').trim().slice(0, 200);
    dur = Math.round(Number(dur)) || 0;
    if (!title) throw Object.assign(new Error('No title to look up'), { status: 400 });
    const key = `${artist}\n${title}\n${dur}`.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    let found = null;
    if (artist && dur) found = pack(await get('https://lrclib.net/api/get?' + new URLSearchParams({ artist_name: artist, track_name: title, duration: String(dur) })).catch(() => null)); // a miss here still leaves the search
    if (!found) {
      const list = (await get('https://lrclib.net/api/search?' + new URLSearchParams(artist ? { artist_name: artist, track_name: title } : { q: title }))) || [];
      const usable = list.filter((x) => x.plainLyrics || x.syncedLyrics || x.instrumental);
      const off = (x) => (dur ? Math.abs((x.duration || 0) - dur) : 0);
      usable.sort((a, b) => off(a) - off(b) || !!b.syncedLyrics - !!a.syncedLyrics);
      const best = usable[0];
      if (best && (!dur || off(best) <= 15)) found = pack(best);
    }
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    cache.set(key, found);
    return found;
  }

  const routes = {
    'GET /api/lyrics': async (req, q) => (await lyrics(q.get('artist'), q.get('title'), q.get('dur'))) || { none: true },
  };

  return { routes };
};
