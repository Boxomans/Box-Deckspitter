// Spotify links in BoxTape. Spotify's audio is DRM-protected, so nothing is downloaded from Spotify: this reads
// the track list (title, artists, length) and finds each song on YouTube, where BoxTape downloads it as an MP3.
// Track lists come from Spotify's public embed page (no setup); the embed stops near 100 songs, so longer playlists
// are paged in with the anonymous token that page hands out. A free Spotify developer key (optional, kept in
// data/secrets.json) is used first when there is one.

'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const err = (status, message) => Object.assign(new Error(message), { status });

/** open.spotify.com/(intl-xx/)playlist|album|track/<id>, spotify:playlist:<id>, spotify.link short links → { type, id } */
function parseLink(input) {
  const s = String(input || '').trim();
  let m = /^spotify:(playlist|album|track):([A-Za-z0-9]{22})$/.exec(s);
  if (m) return { type: m[1], id: m[2] };
  m = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album|track)\/([A-Za-z0-9]{22})/i.exec(s);
  if (m) return { type: m[1].toLowerCase(), id: m[2] };
  return null;
}
const isSpotify = (s) => /^spotify:|^https?:\/\/(open\.spotify\.com|spotify\.link)\//i.test(String(s || '').trim());

async function resolveShortLink(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  return res.url;
}

/** Everything Spotify's embed page knows, without any key. */
async function fromEmbed({ type, id }) {
  const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(20000) });
  if (res.status === 404) throw err(404, 'Spotify says that link doesn’t exist (or the playlist is private).');
  if (!res.ok) throw err(502, `Spotify answered ${res.status}.`);
  const html = await res.text();
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw err(502, 'Couldn’t read that Spotify page (Spotify may have changed it).');
  const ent = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  if (!ent) throw err(502, 'Couldn’t read that Spotify page (Spotify may have changed it).');
  if (type === 'track') {
    return { title: ent.name || ent.title, items: [{ title: ent.name || ent.title, artist: (ent.artists || []).map((a) => a.name).join(', '), duration: Math.round((ent.duration || 0) / 1000), id }] };
  }
  const all = ent.trackList || [];
  const items = all.filter((t) => t.title).map((t) => ({
    title: t.title, artist: String(t.subtitle || '').replace(/ /g, ' '), duration: Math.round((t.duration || 0) / 1000),
    id: String(t.uri || '').split(':').pop() || null,
  }));
  // the page stops at 100 (a few may be blank, so 98 is "maybe more" too)
  return { title: ent.name || ent.title, items, maybeMore: all.length >= 90, token: JSON.parse(m[1])?.props?.pageProps?.state?.settings?.session?.accessToken || null };
}

const FETCH_PLAYLIST = '19ff1327c29e99c208c86d7a9d8f1929cfdf3d3202a0ff4253c821f1901aa94d'; // the web player's own query

/** Every song in a playlist, 300 at a time, with the embed page's anonymous token (podcast episodes are skipped). */
async function fromPathfinder(id, token) {
  const items = [];
  let total = Infinity;
  for (let offset = 0; offset < total && offset < 10000; offset += 300) {
    const r = await fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'App-Platform': 'WebPlayer', 'User-Agent': UA },
      body: JSON.stringify({ variables: { uri: `spotify:playlist:${id}`, offset, limit: 300, enableWatchFeedEntrypoint: false }, operationName: 'fetchPlaylist', extensions: { persistedQuery: { version: 1, sha256Hash: FETCH_PLAYLIST } } }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw err(502, `Spotify answered ${r.status}.`);
    const c = (await r.json())?.data?.playlistV2?.content;
    if (!c?.items) throw err(502, 'Couldn’t read the rest of that playlist.');
    total = c.totalCount ?? 0;
    for (const x of c.items) {
      const t = x.itemV2?.data;
      if (x.itemV2?.__typename !== 'TrackResponseWrapper' || !t?.name) continue;
      items.push({
        title: t.name, artist: (t.artists?.items || []).map((a) => a.profile?.name).filter(Boolean).join(', '),
        duration: Math.round((t.trackDuration?.totalMilliseconds || 0) / 1000), id: String(t.uri || '').split(':').pop() || null,
      });
    }
    if (!c.items.length) break;
  }
  return items;
}

/** The full list through Spotify's Web API (needs the user's own free client id + secret). */
async function fromApi({ type, id }, { clientId, clientSecret }) {
  const tok = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64') },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  }).then((r) => r.json());
  if (!tok.access_token) throw err(400, 'Spotify didn’t accept that key (check the Client ID and Secret).');
  const get = async (url) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(20000) });
    if (r.status === 404) throw err(404, 'Spotify’s API can’t see that one (playlists made by Spotify itself are blocked for new keys; your own and other people’s public playlists work).');
    if (!r.ok) throw err(502, `Spotify’s API answered ${r.status}.`);
    return r.json();
  };
  const meta = await get(`https://api.spotify.com/v1/${type}s/${id}?fields=name`);
  const items = [];
  let url = type === 'album' ? `https://api.spotify.com/v1/albums/${id}/tracks?limit=50` : `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100&fields=next,items(track(id,name,duration_ms,artists(name)))`;
  while (url && items.length < 2000) {
    const page = await get(url);
    for (const it of page.items || []) {
      const t = it.track || it;
      if (!t?.name) continue;
      items.push({ title: t.name, artist: (t.artists || []).map((a) => a.name).join(', '), duration: Math.round((t.duration_ms || 0) / 1000), id: t.id || null });
    }
    url = page.next;
  }
  return { title: meta.name, items };
}

// ---------------------------------------------------------------- matching a song on YouTube

// accents come off Latin letters; Japanese, Korean, Cyrillic etc. stay (recomposed, so ド is still one letter)
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
/** How much of one wanted word is in a title: whole-word for spaced scripts; for Japanese/Chinese/Korean (no spaces), the
 *  share of its two-character pieces that turn up (so 夏の終りの… still matches 夏の終わりの…). */
function wordHit(w, t) {
  if (!CJK.test(w) || w.length < 3) return t.includes(w) ? 1 : 0;
  const grams = Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2));
  return grams.filter((g) => t.includes(g)).length / grams.length;
}
// versions you almost never want unless the Spotify title says so
const AVOID = ['live', 'cover', 'karaoke', 'instrumental', 'remix', 'sped up', 'slowed', 'nightcore', '8d', 'reverb', 'reaction', 'tutorial', 'lesson', 'extended', '1 hour', '10 hours', 'loop', 'bass boosted', 'acapella', 'acoustic', 'demo', 'concert', 'club mix',
  // not music at all: trailers, shows and clips that happen to share a song's name
  'trailer', 'teaser', 'episode', 'season', 'full movie', 'scene', 'interview', 'review', 'gameplay', 'reaction', 'explained', 'behind the scenes'];
// words that come with a song's upload title and say nothing about which song it is
const TITLE_TAGS = ['official', 'music', 'video', 'audio', 'lyric', 'lyrics', 'mv', 'pv', 'hd', 'hq', '4k', 'remaster', 'remastered', 'version', 'ver', 'feat', 'ft', 'prod', 'with', 'full', 'song', 'album', 'single', 'the', 'a', 'and', 'by', 'visualizer', 'color', 'coded', 'sub', 'subs', 'english', 'romaji'];
const LATIN = /^[\p{Script=Latin}\p{N} ]+$/u;

/** How sure a result is by the song's artist: 1 by name (in the channel, or the artist part of an "Artist - Song" title),
 *  a share when only some of the name's words are there (a romanisation spelled a little differently), 0 when nothing
 *  says either way, -1 when it's clearly someone else's. A name that's only somewhere in the title doesn't count (a
 *  video can use the artist's name as an ordinary word); a Japanese/Chinese/Korean artist part or channel is let through for a Latin-letter name, as it's
 *  likely the same artist written natively (泰葉 for Yasuha), unless another Latin-letter name sits in the artist part. */
function artistFit(c, want) {
  const a = norm(String(want.artist || '').split(',')[0]);
  if (!a) return 0;
  const ch = norm(c.channel || c.uploader);
  const songW = norm(want.title).split(' ').filter((w) => w.length > 1 || CJK.test(w));
  // the title's other parts (split at " - ", " | ", 「 」 …) once the part naming the song is taken out
  const parts = String(c.title || '').split(/\s[-–—|:]\s|[|「」『』【】]/).map(norm).filter(Boolean);
  const songAt = parts.findIndex((p) => songW.length && songW.every((w) => wordHit(w, p) >= 0.5));
  const slot = parts.length > 1 ? parts.filter((_, i) => i !== songAt).join(' ') : '';
  const has = (x) => x.includes(a) || x.split(' ').includes(a);
  if (has(ch) || (slot && has(slot)) || new RegExp(`\\bby ${a}\\b`).test(norm(c.title))) return 1;
  const aw = a.split(' ').filter((w) => w.length > 2);
  const some = aw.filter((w) => ch.split(' ').includes(w) || slot.split(' ').includes(w)).length / (a.split(' ').length || 1);
  if (some) return some;
  if (!LATIN.test(a)) return 0;
  const latinSlot = /\p{Script=Latin}/u.test(slot.replace(/\b(official|music|video|audio|lyrics?|mv|hd|hq|full|ver(sion)?|feat|ft)\b/g, ''));
  if (!latinSlot && (CJK.test(slot) || CJK.test(ch))) return 0;
  return -1;
}

function score(c, want) {
  const t = norm(c.title);
  const wantT = norm(want.title);
  const ch = norm(c.channel || c.uploader);
  const firstArtist = norm(String(want.artist).split(',')[0]);
  let s = 0;
  if (want.duration && c.duration) {
    const d = Math.abs(c.duration - want.duration);
    s += d <= 3 ? 40 : d <= 8 ? 28 : d <= 15 ? 12 : d <= 30 ? -10 : -80;
  } else if (want.duration) s -= 15; // only a penalty when we know how long the song should be (typed songs don't)
  const words = wantT.split(' ').filter((w) => w.length > 1 || CJK.test(w));
  const hit = words.reduce((n, w) => n + wordHit(w, t), 0) / (words.length || 1);
  s += Math.round(hit * 35);
  // the artist: a same-named song by someone else is the commonest wrong match, so a missing artist costs, not just a
  // missing bonus (see artistFit).
  let artistHit = 0;
  if (firstArtist) {
    artistHit = artistFit(c, want);
    if (artistHit > 0) s += Math.round(artistHit * 20);
    else if (artistHit < 0) s -= 35;
  }
  // YouTube's auto-generated "Artist - Topic" uploads are the studio recording, of the right song when it's the right artist
  if (/ topic$/.test(ch)) s += artistHit > 0 || !firstArtist ? 25 : 5;
  // a song's upload is titled with little more than the artist and the song; a long title of other words is a vlog, a
  // news clip or a show that just mentions them
  const known = new Set([...wantT.split(' '), ...firstArtist.split(' '), ...TITLE_TAGS]);
  const extra = t.split(' ').filter((w) => w && !known.has(w) && !/^\d+$/.test(w)).length;
  if (extra > 10) s -= 35; else if (extra > 6) s -= 15;
  if (/official audio/.test(t)) s += 10;
  if (/official (music )?video/.test(t)) s += 2; // videos often have intros/outros
  for (const w of AVOID) if (new RegExp(`\\b${w}\\b`).test(t) && !wantT.includes(w)) s -= 45;
  return s;
}

module.exports = function createSpotify({ secrets, saveSecrets, readJSONBody, runCapture, tools }) {
  const creds = () => { const s = secrets(); return s.spotifyClientId && s.spotifyClientSecret ? { clientId: s.spotifyClientId, clientSecret: s.spotifyClientSecret } : null; };

  /** Best YouTube upload for one Spotify track → { url, title, score } (throws when nothing is close enough). */
  async function findOnYouTube(want, timeoutMs = 60000) {
    const exe = tools().ytdlp;
    if (!exe) throw err(400, 'yt-dlp is not installed (winget install yt-dlp)');
    const artist = String(want.artist || '').split(',')[0].trim();
    const search = async (q) => {
      const json = JSON.parse(await runCapture(exe, ['-J', '--flat-playlist', '--no-warnings', '--', `ytsearch8:${q.replace(/["\n]/g, ' ')}`], timeoutMs));
      return (json.entries || []).filter((e) => e && (e.url || e.id)).map((e) => ({
        url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`, title: e.title, duration: e.duration, channel: e.channel || e.uploader,
      })).map((c) => ({ ...c, score: score(c, want) })).filter((c) => artistFit(c, want) >= 0).sort((a, b) => b.score - a.score)[0];
    };
    let best = await search(artist ? `${artist} - ${want.title}` : want.title);
    // nothing close: try the title on its own (results not by the artist are dropped above, so this can't take a same-named
    // song by someone else, or a trailer, and file it under the wanted name) (Spotify's English artist name often isn't how YouTube writes it, e.g. Yasuha / 泰葉)
    if ((!best || best.score < 35) && artist) { const b2 = await search(want.title); if (b2 && (!best || b2.score > best.score)) best = b2; }
    if (!best || best.score < 35) throw err(404, 'no close enough match on YouTube');
    return best;
  }

  return {
    isSpotify,
    findOnYouTube,
    routes: {
      'POST /api/spotify/tracks': async (req) => {
        const { url } = await readJSONBody(req);
        let link = parseLink(url);
        if (!link && /spotify\.link\//i.test(url)) link = parseLink(await resolveShortLink(url));
        if (!link) throw err(400, 'That doesn’t look like a Spotify playlist, album or song link.');
        const c = creds();
        if (c && link.type !== 'track') {
          try { return { ...(await fromApi(link, c)), source: 'api' }; } catch (e) { if (e.status === 400) throw e; /* fall back to the embed page */ }
        }
        const { token, ...r } = await fromEmbed(link);
        if (link.type === 'playlist' && r.maybeMore && token) {
          try {
            const all = await fromPathfinder(link.id, token);
            if (all.length >= r.items.length) return { ...r, items: all, maybeMore: false, source: 'embed', hasKey: !!c };
          } catch { /* keep the first 100 */ }
        }
        return { ...r, source: 'embed', hasKey: !!c };
      },
      // BoxTape word search: the top YouTube results for some words
      'POST /api/tape/search': async (req) => {
        const { q } = await readJSONBody(req);
        const words = String(q || '').replace(/["\n\r]/g, ' ').trim().slice(0, 200);
        if (!words) throw err(400, 'Type something to search for.');
        const exe = tools().ytdlp;
        if (!exe) throw err(400, 'yt-dlp is not installed (winget install yt-dlp)');
        const json = JSON.parse(await runCapture(exe, ['-J', '--flat-playlist', '--no-warnings', '--', `ytsearch20:${words}`], 60000));
        const items = (json.entries || []).filter((e) => e && (e.url || e.id) && e.duration !== 0).map((e) => ({
          url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
          title: e.title, uploader: e.channel || e.uploader || null, duration: e.duration || null, type: 'ytdlp',
        }));
        return { title: `“${words}” on YouTube`, items };
      },
      'GET /api/spotify/key': async () => ({ hasKey: !!creds() }),
      'POST /api/spotify/key': async (req) => {
        const { clientId, clientSecret } = await readJSONBody(req);
        const s = { ...secrets() };
        if (clientId && clientSecret) {
          if (!/^[a-f0-9]{32}$/i.test(clientId) || !/^[a-f0-9]{32}$/i.test(clientSecret)) throw err(400, 'Spotify Client IDs and Secrets are 32 letters/numbers each.');
          s.spotifyClientId = clientId.trim();
          s.spotifyClientSecret = clientSecret.trim();
        } else { delete s.spotifyClientId; delete s.spotifyClientSecret; }
        await saveSecrets(s);
        return { ok: true, hasKey: !!(clientId && clientSecret) };
      },
    },
  };
};

module.exports.score = score;
module.exports.parseLink = parseLink;
