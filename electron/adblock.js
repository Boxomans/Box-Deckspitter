// The browser's built-in ad blocker (main-process side). The filters are EasyList, EasyPrivacy, Peter Lowe's list and
// uBlock Origin's lists, run by Ghostery's filter engine: electron/vendor/adblocker.js is a one-file bundle of
// @ghostery/adblocker 2.20.1 (MPL-2.0, source at github.com/ghostery/adblocker), shipped in the app itself because
// in-app updates never touch node_modules.
//
// Three layers, all on the browser's session only (the app's own window is never filtered):
//   requests  ad and tracker requests are cancelled (or swapped for a harmless stand-in where the lists say so)
//   hiding    vendor/adblocker-preload.js runs in every page and asks for the CSS that hides the leftover ad boxes
//   scripts   the lists' small anti-ad scripts (scriptlets: YouTube and the like), injected into the page by the same
//
// The lists are downloaded and built into an engine (about a second), which is cached in data/browser and rebuilt
// once a week. Until the first download finishes nothing is blocked. Allowed sites skip all three layers.

'use strict';

const { ipcMain } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { FiltersEngine, Request, parseHost } = require('./vendor/adblocker.js');

const PRELOAD = path.join(__dirname, 'vendor', 'adblocker-preload.js');
const MAX_AGE = 7 * 24 * 3600e3; // rebuild the lists once a week
const CH_INJECT = '@ghostery/adblocker/inject-cosmetic-filters'; // what the preload asks on (fixed by the preload)
const CH_OBSERVE = '@ghostery/adblocker/is-mutation-observer-enabled';

module.exports = function createAdblock({ stateDir, onCount }) {
  const CONF = path.join(stateDir, 'adblock.json');
  const CACHE = path.join(stateDir, 'adblock-engine.bin');

  const readConf = () => { try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch { return {}; } };
  let conf = { enabled: true, allow: [], ...readConf() };
  const saveConf = () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(CONF + '.tmp', JSON.stringify(conf, null, 2));
    fs.renameSync(CONF + '.tmp', CONF);
  };

  let engine = null;
  let built = 0; // when the lists in `engine` were downloaded
  let building = null;
  let lastError = '';
  let ses = null;

  // ---- sites you've allowed ads on (a host covers its subdomains; "www." is ignored)
  const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
  const isAllowed = (u) => { const h = hostOf(u); return !!h && conf.allow.some((a) => h === a || h.endsWith('.' + a)); };
  const on = () => !!engine && conf.enabled;

  // ---- per page: what was blocked since it last navigated. Each address counts once: some pages retry a
  // blocked request hundreds of times a second (CNN's video player does), which would make the number meaningless.
  const seen = new Map(); // webContents id → Set of blocked URLs
  const pending = new Map(); // webContents id → timer (the count is sent at most ~3× a second)
  const countOf = (id) => seen.get(id)?.size || 0;
  function bump(id, url) {
    if (id == null) return;
    let s = seen.get(id);
    if (!s) seen.set(id, (s = new Set()));
    if (s.has(url) || s.size >= 9999) return;
    s.add(url);
    if (!pending.has(id)) pending.set(id, setTimeout(() => { pending.delete(id); onCount(id, countOf(id)); }, 300));
  }
  function reset(id) { seen.delete(id); clearTimeout(pending.get(id)); pending.delete(id); onCount(id, 0); }

  /** The page a request belongs to (its tab's address), for the allow list. */
  const pageOf = (d) => { try { return d.webContents?.getURL() || ''; } catch { return ''; } };
  const frameOf = (d) => { try { return d.frame?.url || ''; } catch { return ''; } };

  function toRequest(d) {
    const req = Request.fromRawDetails({ requestId: `${d.id}`, url: d.url, sourceUrl: d.referrer || frameOf(d) || pageOf(d), tabId: d.webContentsId, type: d.resourceType || 'other' });
    if (req.type === 'other') req.guessTypeOfRequest();
    return req;
  }

  function onBeforeRequest(d, cb) {
    if (!on() || d.resourceType === 'mainFrame' || isAllowed(pageOf(d))) return cb({});
    try {
      const { redirect, match } = engine.match(toRequest(d));
      if (redirect) { bump(d.webContentsId, d.url); return cb({ redirectURL: redirect.dataUrl }); }
      if (match) { bump(d.webContentsId, d.url); return cb({ cancel: true }); }
    } catch { /* a request the engine can't read: let it through */ }
    cb({});
  }

  // some list rules work by tightening a page's Content-Security-Policy (blocking inline ad scripts, say)
  function onHeadersReceived(d, cb) {
    if (!on() || (d.resourceType !== 'mainFrame' && d.resourceType !== 'subFrame') || isAllowed(d.resourceType === 'mainFrame' ? d.url : pageOf(d))) return cb({});
    try {
      const csp = engine.getCSPDirectives(toRequest(d));
      if (csp === undefined) return cb({});
      const headers = { ...(d.responseHeaders || {}) };
      const policies = csp.split(';').map((s) => s.trim());
      for (const name of Object.keys(headers)) if (name.toLowerCase() === 'content-security-policy') { policies.push(...headers[name]); delete headers[name]; }
      headers['content-security-policy'] = [policies.join(';')];
      cb({ responseHeaders: headers });
    } catch { cb({}); }
  }

  // the preload in each page asks for its hiding CSS and scriptlets (first with just the address, then again with
  // the classes / ids / links it finds as the page builds itself)
  async function onInject(e, url, msg) {
    // only pages on the browser's session have the preload that asks this
    if (!on()) return;
    let page = '';
    try { page = e.sender.getURL(); } catch { return; }
    if (isAllowed(page) || isAllowed(url)) return;
    const parsed = parseHost(String(url || ''));
    const first = msg === undefined;
    const { active, styles, scripts } = engine.getCosmeticsFilters({
      url, hostname: parsed.hostname || '', domain: parsed.domain || '',
      classes: msg?.classes, hrefs: msg?.hrefs, ids: msg?.ids,
      getBaseRules: first, getInjectionRules: first, getExtendedRules: false, getRulesFromHostname: first, getRulesFromDOM: !first,
      callerContext: { frameId: e.frameId, processId: e.processId, lifecycle: msg?.lifecycle },
    });
    if (active === false) return;
    if (styles.length) e.sender.insertCSS(styles, { cssOrigin: 'user' }).catch(() => {});
    for (const s of scripts) e.sender.executeJavaScript(s, true).catch(() => {});
  }

  // ---- the engine: from the cache if it's fresh, else downloaded and built
  async function build() {
    if (building) return building;
    building = (async () => {
      try {
        const fresh = await FiltersEngine.fromPrebuiltAdsAndTracking(fetch);
        engine = fresh;
        built = Date.now();
        lastError = '';
        await fsp.mkdir(stateDir, { recursive: true });
        await fsp.writeFile(CACHE + '.tmp', fresh.serialize());
        await fsp.rename(CACHE + '.tmp', CACHE);
      } catch (e) {
        lastError = e.message || String(e);
        console.log(`[adblock] couldn’t update the filter lists: ${lastError}`);
        throw e;
      } finally { building = null; }
    })();
    return building;
  }

  async function load() {
    try {
      const [st, buf] = await Promise.all([fsp.stat(CACHE), fsp.readFile(CACHE)]);
      engine = FiltersEngine.deserialize(buf); // throws for a cache from another engine version: rebuilt below
      built = st.mtimeMs;
    } catch { engine = null; }
    if (!engine || Date.now() - built > MAX_AGE) build().catch(() => {});
  }

  return {
    /** Hooks the browser's session (once, at startup). */
    attach(session) {
      ses = session;
      ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD });
      ipcMain.handle(CH_INJECT, onInject);
      ipcMain.handle(CH_OBSERVE, () => true);
      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, onBeforeRequest);
      ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, onHeadersReceived);
      load();
      // a session left open for days still gets the weekly update
      setInterval(() => { if (Date.now() - built > MAX_AGE) build().catch(() => {}); }, 6 * 3600e3).unref();
    },
    reset,
    status(pageUrl, id) {
      const host = hostOf(pageUrl);
      return { enabled: conf.enabled, ready: !!engine, building: !!building, updated: built || null, error: lastError || null,
        host, allowed: isAllowed(pageUrl), count: countOf(id) };
    },
    setEnabled(v) { conf.enabled = !!v; saveConf(); },
    /** Allow (or stop allowing) ads on a page's site. */
    setAllowed(pageUrl, allow) {
      const h = hostOf(pageUrl);
      if (!h) throw new Error('That page has no site to allow.');
      conf.allow = conf.allow.filter((a) => a !== h && !(allow ? false : h.endsWith('.' + a)));
      if (allow) conf.allow.push(h);
      saveConf();
    },
    allowList: () => [...conf.allow],
    removeAllowed(h) { conf.allow = conf.allow.filter((a) => a !== h); saveConf(); },
    update: () => build(),
  };
};
