// Settings → Appearance: the background image (the app's and the desktop's) and your own fonts.

'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

module.exports = function createAppearance({ DATA, IS_WIN, ok, readJSONBody, requirePath, writeJSON }) {
  // Settings → Appearance → Background image: a copy of the picture (so the original can move or go), one at a time,
  // named by its contents and served at /bg/<name>.
  const BG_DIR = path.join(DATA, 'backgrounds');
  const BG_EXT = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.gif', '.bmp']);

  // Settings → Appearance → Your fonts: fonts fetched by name from Fontsource's catalogue (every Google font, all free to
  // use) or added from a file, kept in data/fonts (one folder each, fonts.json lists them) and served at /userfonts/.
  const FONT_DIR = path.join(DATA, 'fonts');
  const FONT_LIST = path.join(FONT_DIR, 'fonts.json');
  const FONT_FILE_FMT = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' };
  const FONT_ID_RE = /^[a-z0-9-]{1,80}$/;
  /** What a typed font name is matched on: no case, spaces, dashes or other symbols ("cinzel-DECORATIVE" = "Cinzel Decorative"). */
  const fontKey = (s) => String(s || '').normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const readFonts = () => { try { const j = JSON.parse(fs.readFileSync(FONT_LIST, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } };
  async function saveFont(entry) {
    await fsp.mkdir(FONT_DIR, { recursive: true });
    await writeJSON(FONT_LIST, [...readFonts().filter((f) => f.id !== entry.id), entry].sort((a, b) => a.family.localeCompare(b.family)));
  }
  let fontCatalog = null;
  async function fontJSON(url) {
    let r;
    try { r = await fetch(url, { signal: AbortSignal.timeout(20000) }); } catch { throw Object.assign(new Error('Couldn’t reach the font catalogue (Fontsource). Check the internet connection.'), { status: 502 }); }
    if (!r.ok) throw Object.assign(new Error(`The font catalogue answered ${r.status}.`), { status: 502 });
    return r.json();
  }
  async function fontsourceCatalog() {
    if (!fontCatalog || Date.now() - fontCatalog.at > 6 * 3600e3) fontCatalog = { at: Date.now(), list: await fontJSON('https://api.fontsource.org/v1/fonts') };
    return fontCatalog.list;
  }
  /** Downloads the regular to bold weights (Latin and Latin Extended) of a catalogue font into data/fonts/<id>. */
  async function fetchFont(id) {
    if (!FONT_ID_RE.test(id)) throw Object.assign(new Error('Bad font id'), { status: 400 });
    const d = await fontJSON(`https://api.fontsource.org/v1/fonts/${id}`);
    let weights = [400, 500, 600, 700].filter((w) => d.weights?.includes(w));
    if (!weights.length) weights = [...(d.weights || [])].sort((a, b) => Math.abs(a - 400) - Math.abs(b - 400)).slice(0, 1);
    let subsets = ['latin', 'latin-ext'].filter((x) => d.subsets?.includes(x));
    if (!subsets.length) subsets = [d.defSubset].filter(Boolean);
    const dir = path.join(FONT_DIR, id);
    await fsp.mkdir(dir, { recursive: true });
    const faces = [];
    for (const w of weights) for (const sub of subsets) {
      const styles = d.variants?.[w] || {};
      const url = (styles.normal || Object.values(styles)[0])?.[sub]?.url?.woff2;
      if (!url || !url.startsWith('https://cdn.jsdelivr.net/fontsource/')) continue;
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) }).catch(() => null);
      if (!r?.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 8 * 1024 * 1024) continue;
      const file = `${sub}-${w}.woff2`;
      await fsp.writeFile(path.join(dir, file), buf);
      const range = d.unicodeRange?.[sub];
      faces.push({ weight: String(w), file: `${id}/${file}`, format: 'woff2', range: /^[U+0-9A-Fa-f?,\- ]+$/.test(range || '') ? range : null });
    }
    if (!faces.length) { await fsp.rm(dir, { recursive: true, force: true }); throw Object.assign(new Error(`Couldn’t download ${d.family}.`), { status: 502 }); }
    const entry = { id, family: d.family, category: d.category || '', license: d.license || '', source: 'fontsource', faces };
    await saveFont(entry);
    return entry;
  }

  const routes = {
    'POST /api/background': async (req) => {
      const { path: p } = await readJSONBody(req);
      const src = requirePath(p);
      const ext = path.extname(src).toLowerCase();
      if (!BG_EXT.has(ext)) throw Object.assign(new Error('Pick a picture: JPG, PNG, WebP, GIF or BMP.'), { status: 400 });
      const st = await fsp.stat(src).catch(() => null);
      if (!st?.isFile()) throw Object.assign(new Error('That picture isn’t there any more.'), { status: 404 });
      if (st.size > 40 * 1024 * 1024) throw Object.assign(new Error('That picture is over 40 MB. Pick a smaller one.'), { status: 400 });
      const buf = await fsp.readFile(src);
      const name = `bg-${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8)}${ext === '.jfif' ? '.jpg' : ext}`;
      await fsp.mkdir(BG_DIR, { recursive: true });
      for (const f of await fsp.readdir(BG_DIR)) if (f !== name) await fsp.rm(path.join(BG_DIR, f), { force: true });
      await fsp.writeFile(path.join(BG_DIR, name), buf);
      return { file: name };
    },
    'POST /api/background/clear': async () => {
      await fsp.rm(BG_DIR, { recursive: true, force: true });
      return { ok: true };
    },

    // "Set as desktop background": the Windows wallpaper, set the way Windows' own "Set as desktop background" does it
    // (SystemParametersInfo, saved to the profile). Windows keeps its own copy, so the picture can move afterwards.
    'POST /api/wallpaper': async (req) => {
      if (!IS_WIN) throw Object.assign(new Error('Setting the desktop background only works on Windows for now.'), { status: 400 });
      const { path: p } = await readJSONBody(req);
      const src = requirePath(p);
      if (!/\.(jpe?g|jfif|png|bmp)$/i.test(src)) throw Object.assign(new Error('Windows can only use JPG, PNG or BMP pictures as the desktop background.'), { status: 400 });
      if (!fs.statSync(src, { throwIfNoEntry: false })?.isFile()) throw Object.assign(new Error('That picture isn’t there any more.'), { status: 404 });
      // the path goes in through an environment variable, never into the command text
      const ps = "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class BdsWallpaper { [DllImport(\"user32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SystemParametersInfo(int a, int b, string c, int d); }'; "
        + "if (-not [BdsWallpaper]::SystemParametersInfo(20, 0, $env:BDS_WALLPAPER, 3)) { throw 'Windows wouldn''t use that picture.' }";
      await new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30000, env: { ...process.env, BDS_WALLPAPER: src } },
          (e, _out, err) => (e ? reject(new Error(String(err || e.message).split('\n').map((l) => l.trim()).filter(Boolean)[0] || 'Couldn’t set the desktop background')) : resolve()));
      });
      return { ok: true };
    },

    'GET /api/fonts': async () => ({ fonts: readFonts() }),

    // a typed name: an exact match (ignoring case, spaces, dashes and symbols) is downloaded; otherwise the closest names
    'POST /api/fonts/get': async (req) => {
      const { name } = await readJSONBody(req);
      const key = fontKey(name);
      if (!key) throw Object.assign(new Error('Type the name of a font.'), { status: 400 });
      const list = await fontsourceCatalog();
      const hit = list.find((f) => fontKey(f.family) === key) || list.find((f) => fontKey(f.id) === key);
      if (hit) return { font: await fetchFont(hit.id) };
      const near = list.map((f) => {
        const k = fontKey(f.family);
        return { f, rank: k.startsWith(key) ? 0 : k.includes(key) ? 1 : key.includes(k) && k.length > 3 ? 2 : 9 };
      }).filter((x) => x.rank < 9).sort((a, b) => a.rank - b.rank || a.f.family.length - b.f.family.length).slice(0, 8);
      return { suggestions: near.map(({ f }) => ({ id: f.id, family: f.family, category: f.category })) };
    },

    // a font file from this PC (.ttf .otf .woff .woff2), named after the file
    'POST /api/fonts/file': async (req) => {
      const { path: p } = await readJSONBody(req);
      const src = requirePath(p);
      const ext = path.extname(src).toLowerCase();
      if (!FONT_FILE_FMT[ext]) throw Object.assign(new Error('Pick a font file: .ttf, .otf, .woff or .woff2.'), { status: 400 });
      const st = await fsp.stat(src).catch(() => null);
      if (!st?.isFile()) throw Object.assign(new Error('That file isn’t there any more.'), { status: 404 });
      if (st.size > 30 * 1024 * 1024) throw Object.assign(new Error('That font file is over 30 MB.'), { status: 400 });
      const family = path.basename(src, path.extname(src)).replace(/[_-]+/g, ' ').replace(/['"\\<>;{}]/g, '').trim().slice(0, 60) || 'My font';
      const id = `file-${fontKey(family).slice(0, 40) || crypto.randomBytes(4).toString('hex')}`.replace(/[^a-z0-9-]/g, '');
      const dir = path.join(FONT_DIR, id);
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });
      await fsp.copyFile(src, path.join(dir, `font${ext}`));
      const entry = { id, family, category: '', license: '', source: 'file', faces: [{ weight: '100 900', file: `${id}/font${ext}`, format: FONT_FILE_FMT[ext], range: null }] };
      await saveFont(entry);
      return { font: entry };
    },

    'POST /api/fonts/remove': async (req) => {
      const { id } = await readJSONBody(req);
      if (!FONT_ID_RE.test(String(id || ''))) throw Object.assign(new Error('Bad font id'), { status: 400 });
      await fsp.rm(path.join(FONT_DIR, id), { recursive: true, force: true });
      const rest = readFonts().filter((f) => f.id !== id);
      if (rest.length) await writeJSON(FONT_LIST, rest); else await fsp.rm(FONT_LIST, { force: true });
      return { ok: true };
    },
  };

  return { routes, BG_DIR, FONT_DIR };
};
