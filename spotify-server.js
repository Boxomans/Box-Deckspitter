// Spotify links in BoxTape. Spotify's audio is DRM-protected, so nothing is downloaded from Spotify: this reads
// the track list (title, artists, length) and finds each song on YouTube, where BoxTape downloads it as an MP3.
// Track lists come from Spotify's public embed page (no setup, up to 100 songs); a free Spotify developer key
// (optional, kept in data/secrets.json) gets the rest of longer playlists.

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
  const items = (ent.trackList || []).filter((t) => t.title).map((t) => ({
    title: t.title, artist: String(t.subtitle || '').replace(/ /g, ' '), duration: Math.round((t.duration || 0) / 1000),
    id: String(t.uri || '').split(':').pop() || null,
  }));
  return { title: ent.name || ent.title, items, maybeMore: items.length >= 100 };
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

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// versions you almost never want unless the Spotify title says so
const AVOID = ['live', 'cover', 'karaoke', 'instrumental', 'remix', 'sped up', 'slowed', 'nightcore', '8d', 'reverb', 'reaction', 'tutorial', 'lesson', 'extended', '1 hour', '10 hours', 'loop', 'bass boosted', 'acapella', 'acoustic', 'demo', 'concert'];

function score(c, want) {
  const t = norm(c.title);
  const wantT = norm(want.title);
  const ch = norm(c.channel || c.uploader);
  const firstArtist = norm(String(want.artist).split(',')[0]);
  let s = 0;
  if (want.duration && c.duration) {
    const d = Math.abs(c.duration - want.duration);
    s += d <= 3 ? 40 : d <= 8 ? 28 : d <= 15 ? 12 : d <= 30 ? -10 : -80;
  } else s -= 15;
  const words = wantT.split(' ').filter((w) => w.length > 1);
  const hit = words.filter((w) => t.includes(w)).length / (words.length || 1);
  s += Math.round(hit * 35);
  if (firstArtist && (t.includes(firstArtist) || ch.includes(firstArtist))) s += 20;
  if (/ topic$/.test(ch)) s += 25; // YouTube's auto-generated "Artist - Topic" uploads are the studio recording
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
    const q = `${String(want.artist).split(',')[0]} - ${want.title}`.replace(/["\n]/g, ' ');
    const json = JSON.parse(await runCapture(exe, ['-J', '--flat-playlist', '--no-warnings', '--', `ytsearch8:${q}`], timeoutMs));
    const cands = (json.entries || []).filter((e) => e && (e.url || e.id)).map((e) => ({
      url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`, title: e.title, duration: e.duration, channel: e.channel || e.uploader,
    }));
    const ranked = cands.map((c) => ({ ...c, score: score(c, want) })).sort((a, b) => b.score - a.score);
    const best = ranked[0];
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
        const r = await fromEmbed(link);
        return { ...r, source: 'embed', hasKey: !!c };
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
