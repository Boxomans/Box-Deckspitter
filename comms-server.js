// BoxComms: chat, file transfer and push-to-talk radio between copies of Box-Deckspitter on the same local network.
// No server, no account, no internet: copies find each other with a small UDP beacon (multicast plus broadcast),
// each one listens on a LAN port chosen at start-up (only the comms routes below, never the main API), and the radio
// sends 20 ms frames of 16 kHz mono PCM straight to the others over UDP. Off until switched on.
//
// A network can be picked (Hamachi, a VPN, one of several adapters): beacons then go out on it only and only copies
// on it are heard. PCs can also be added by address, for VPNs that don't carry broadcasts; one side adding the
// other is enough, since every beacon also goes straight to everyone already found.
//
// Text is encrypted end to end: each copy has an X25519 key (in data/comms/id.json, sent in its beacon), every pair
// works out a key of its own from them, and each message goes to each person sealed with AES-256-GCM. A person's key
// is remembered the first time they're seen; if it changes later, messages to and from them stop until it's accepted.
// Both sides show the same safety code for a pair, so people can check nobody in between swapped the keys. Files use
// the same pair key: each transfer gets a key of its own and goes through in sealed 64 KB pieces, read from disk and
// written to disk as they go, so any size works. Each radio packet is sealed for each listener too.
//
// Shared room settings (name, topic, auto-delete, files) are the same everywhere: the newest change wins and the
// beacon carries its revision, so a copy that missed it fetches it from whoever has it.

'use strict';

const dgram = require('dgram');
const http = require('http');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');

const DISCO_PORT = 47810;
const GROUP = '239.255.47.10';
const BEACON_MS = 2000, PEER_TTL = 7000;
const VOICE_MAGIC = Buffer.from('BDSV');
const FRAME = 640; // 20 ms of 16 kHz 16-bit mono
const MAX_TEXT = 4000, MAX_HISTORY = 1000;
const SHARED_DEFAULT = { rev: 0, by: '', room: 'Comms', topic: '', autoDelete: 0, files: true, maxFileMB: 0, wipedAt: 0 };

module.exports = function createComms({ DATA, readJSON, writeJSON, readJSONBody, platform, log }) {
  const DIR = path.join(DATA, 'comms');
  const chatFile = path.join(DIR, 'chat.json');
  const sharedFile = path.join(DIR, 'shared.json');
  fs.mkdirSync(DIR, { recursive: true });
  const idFile = path.join(DIR, 'id.json');
  const saved = readJSON(idFile, {});
  let myId = saved.id;
  if (!/^[0-9a-f]{16}$/.test(myId || '')) myId = crypto.randomBytes(8).toString('hex');
  let myKey;
  try { myKey = crypto.createPrivateKey({ key: saved.key, format: 'jwk' }); } catch { myKey = crypto.generateKeyPairSync('x25519').privateKey; }
  const myPub = myKey.export({ format: 'jwk' }).x; // base64url, 32 bytes
  if (saved.id !== myId || !saved.key) writeJSON(idFile, { id: myId, key: myKey.export({ format: 'jwk' }) }).catch(() => {});
  const keysFile = path.join(DIR, 'keys.json');
  const pinned = readJSON(keysFile, {}); // id → their key, as first seen

  const me = { id: myId, name: os.hostname().slice(0, 40) || 'Box-Deckspitter', chan: 1, folder: path.join(os.homedir(), 'Downloads', 'BoxComms'), net: '', extra: [] };
  let extraIps = new Set(), resolvedAt = 0;
  let on = false;
  let disco = null, voice = null, lan = null, beaconTimer = null, sweepTimer = null;
  const peers = new Map(); // id → { id, name, addr, http, voice, chan, rev, seen, talking, talkTimer }
  let history = readJSON(chatFile, []);
  if (!Array.isArray(history)) history = [];
  let shared = { ...SHARED_DEFAULT, ...readJSON(sharedFile, {}) };
  const outgoing = new Map(); // token → { path, size, name, peer, mid, expires }
  const streams = new Set();

  // ---------------------------------------------------------------- to the page (a long chunked response)
  // frames: u8 kind (1 JSON, 2 audio) · u32 length · payload. Audio payload: 16-byte sender id · u8 flags · PCM.
  function frame(kind, payload) {
    const head = Buffer.alloc(5);
    head.writeUInt8(kind, 0);
    head.writeUInt32LE(payload.length, 1);
    return Buffer.concat([head, payload]);
  }
  function push(ev) {
    if (!streams.size) return;
    const f = frame(1, Buffer.from(JSON.stringify(ev), 'utf8'));
    for (const res of streams) res.write(f);
  }
  function pushAudio(id, flags, pcm) {
    if (!streams.size) return;
    const f = frame(2, Buffer.concat([Buffer.from(id, 'ascii'), Buffer.from([flags]), pcm]));
    for (const res of streams) res.write(f);
  }
  const peerList = () => [...peers.values()].map((p) => ({ id: p.id, name: p.name, addr: p.addr, chan: p.chan, talking: !!p.talking, safety: safety(p), keyChanged: !!p.keyChanged }));
  const state = () => ({ on, me: { id: me.id, name: me.name, chan: me.chan, folder: me.folder, net: me.net, extra: me.extra, netUp: !me.net || netAddrs().length > 0, addrs: netAddrs().map((a) => a.address) }, peers: peerList(), history, shared });
  const pushPeers = () => push({ type: 'peers', peers: peerList() });

  // ---------------------------------------------------------------- history
  let saveTimer = null;
  function saveHistory() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => writeJSON(chatFile, history).catch(() => {}), 500);
  }
  function addMessage(m) {
    if (history.some((x) => x.mid === m.mid)) return;
    m.rt = Date.now();
    history.push(m);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    saveHistory();
    push({ type: 'msg', msg: m });
  }
  function patchMessage(mid, patch) {
    const m = history.find((x) => x.mid === mid);
    if (!m) return;
    const { file, ...rest } = patch;
    Object.assign(m, rest);
    if (file) m.file = { ...m.file, ...file };
    saveHistory();
    push({ type: 'msg-update', mid, msg: m });
  }
  /** Auto-delete and "clear for everyone": by the time each copy received a message, so clocks needn't agree. */
  function sweep() {
    const before = history.length;
    const cut = shared.autoDelete > 0 ? Date.now() - shared.autoDelete * 60000 : 0;
    history = history.filter((m) => (m.rt || m.t) > cut && (m.rt || m.t) > (shared.wipedAtLocal || 0) && !(shared.wipedAt && m.t <= shared.wipedAt && (m.rt || m.t) <= shared.wipedAt + 60000));
    if (history.length !== before) { saveHistory(); push({ type: 'history', history }); }
  }

  // ---------------------------------------------------------------- shared room settings
  const newer = (a, b) => a.rev > b.rev || (a.rev === b.rev && a.by > b.by);
  function adoptShared(s, from) {
    if (!s || typeof s !== 'object' || !newer(s, shared)) return false;
    const wiped = s.wipedAt && s.wipedAt !== shared.wipedAt;
    shared = { ...SHARED_DEFAULT, ...pickShared(s), rev: Number(s.rev) || 0, by: String(s.by || '') };
    if (wiped) shared.wipedAtLocal = Date.now(); // everything received up to now goes
    writeJSON(sharedFile, shared).catch(() => {});
    push({ type: 'shared', shared, from });
    sweep();
    return true;
  }
  function pickShared(s) {
    return {
      room: String(s.room ?? shared.room).slice(0, 40) || 'Comms',
      topic: String(s.topic ?? shared.topic).slice(0, 200),
      autoDelete: Math.max(0, Math.min(525600, Number(s.autoDelete ?? shared.autoDelete) || 0)),
      files: s.files == null ? shared.files : !!s.files,
      maxFileMB: Math.max(0, Math.min(1e6, Number(s.maxFileMB ?? shared.maxFileMB) || 0)),
      wipedAt: Number(s.wipedAt ?? shared.wipedAt) || 0,
    };
  }
  function changeShared(patch) {
    const next = { ...shared, ...pickShared({ ...shared, ...patch }), rev: Math.max(Date.now(), shared.rev + 1), by: me.id };
    if (patch.wipedAt) next.wipedAtLocal = Date.now();
    shared = next;
    writeJSON(sharedFile, shared).catch(() => {});
    push({ type: 'shared', shared, from: me.id });
    sweep();
    for (const p of peers.values()) lanPost(p, '/shared', { from: me.id, shared: publicShared() }).catch(() => {});
  }
  const publicShared = () => { const { wipedAtLocal, ...s } = shared; return s; };

  // ---------------------------------------------------------------- encryption
  const PUB_RE = /^[A-Za-z0-9_-]{43}$/;
  const pubKey = (x) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });
  /** The key this pair shares (the same on both sides), worked out once per key they have. */
  function pairKey(p) {
    if (p.keyFor !== p.pub) {
      const secret = crypto.diffieHellman({ privateKey: myKey, publicKey: pubKey(p.pub) });
      p.key = Buffer.from(crypto.hkdfSync('sha256', secret, [me.id, p.id].sort().join(''), 'bds-comms text v1', 32));
      p.keyFor = p.pub;
    }
    return p.key;
  }
  /** Twelve digits both sides see the same: from both keys, so a swapped key shows up as a different code. */
  function safety(p) {
    if (!p.pub) return '';
    const h = crypto.createHash('sha256').update([myPub, p.pub].sort().join('|')).digest();
    return [0, 4, 8].map((i) => String(h.readUInt32BE(i) % 10000).padStart(4, '0')).join(' ');
  }
  const aad = (from, to, m) => Buffer.from(`${from}|${to}|${m.mid}|${m.t}|${m.to || ''}`);
  function seal(p, m, text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', pairKey(p), iv);
    c.setAAD(aad(me.id, p.id, m));
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
  }
  function unseal(p, m, enc) {
    const d = crypto.createDecipheriv('aes-256-gcm', pairKey(p), Buffer.from(String(enc.iv), 'base64'));
    d.setAAD(aad(p.id, me.id, m));
    d.setAuthTag(Buffer.from(String(enc.tag), 'base64'));
    return Buffer.concat([d.update(Buffer.from(String(enc.ct), 'base64')), d.final()]).toString('utf8');
  }
  // the offer's m: the file name is sealed with the message's id and time, the same on both sides
  const offerM = (m) => ({ mid: m.mid, t: m.t, to: null });

  // Files: a key per transfer (from the pair key and the message id), then pieces of
  // u8 flags (1 = last) · u32 length · ciphertext · 16-byte tag. The piece number is the nonce, so pieces can't be
  // dropped, swapped or repeated, and a transfer that's cut off before the last piece fails instead of saving half.
  const PIECE = 65536;
  const fileKey = (p, mid) => Buffer.from(crypto.hkdfSync('sha256', pairKey(p), String(mid), 'bds-comms file v1', 32));
  const pieceIv = (i) => { const iv = Buffer.alloc(12); iv.writeBigUInt64BE(BigInt(i), 4); return iv; };
  function sealPiece(key, i, buf, last) {
    const head = Buffer.alloc(5);
    head.writeUInt8(last ? 1 : 0, 0);
    head.writeUInt32BE(buf.length, 1);
    const c = crypto.createCipheriv('aes-256-gcm', key, pieceIv(i));
    c.setAAD(head);
    return Buffer.concat([head, c.update(buf), c.final(), c.getAuthTag()]);
  }
  function openPiece(key, i, rec) {
    const len = rec.readUInt32BE(1);
    const d = crypto.createDecipheriv('aes-256-gcm', key, pieceIv(i));
    d.setAAD(rec.subarray(0, 5));
    d.setAuthTag(rec.subarray(5 + len));
    return Buffer.concat([d.update(rec.subarray(5, 5 + len)), d.final()]);
  }

  // Radio: a key per pair, and a nonce of a random prefix (new every start) plus a counter, so none repeats.
  // Listeners drop anything that doesn't open, and anything not newer than the last packet from that sender.
  const vPrefix = crypto.randomBytes(8);
  let vCount = 0;
  function voiceKey(p) {
    if (p.vKeyFor !== p.pub) { p.vKey = Buffer.from(crypto.hkdfSync('sha256', pairKey(p), 'voice', 'bds-comms voice v1', 32)); p.vKeyFor = p.pub; }
    return p.vKey;
  }

  // ---------------------------------------------------------------- the network
  function localAddrs() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ ...a, name });
    return out;
  }
  /** The addresses on the picked network (all of them when none is picked). */
  const netAddrs = () => localAddrs().filter((a) => !me.net || a.name === me.net);
  const toInt = (ip) => ip.split('.').reduce((n, b) => n * 256 + Number(b), 0);
  const sameNet = (ip, a) => (toInt(ip) & toInt(a.netmask)) >>> 0 === (toInt(a.address) & toInt(a.netmask)) >>> 0;
  /** PCs added by address: names are looked up again every half minute (a VPN's names can move). */
  function resolveExtra() {
    if (Date.now() - resolvedAt < 30000) return;
    resolvedAt = Date.now();
    Promise.all(me.extra.map((x) => (/^\d+\.\d+\.\d+\.\d+$/.test(x) ? [x] : dns.promises.lookup(x, { family: 4, all: true }).then((r) => r.map((y) => y.address)).catch(() => []))))
      .then((lists) => { extraIps = new Set(lists.flat()); });
  }
  function broadcastOf(a) {
    const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
    return ip.map((b, i) => (b | (~mask[i] & 255))).join('.');
  }

  function beacon(bye = false) {
    if (!disco) return;
    const body = { app: 'bds-comms', v: 2, id: me.id, pub: myPub, name: me.name, http: lan?.address()?.port, voice: voice?.address()?.port, chan: me.chan, rev: shared.rev, by: shared.by, bye };
    resolveExtra();
    const mine = netAddrs();
    const wide = new Set();
    if (mine.length) {
      for (const a of mine) wide.add(broadcastOf(a));
      wide.add(GROUP);
      if (me.net) { try { disco.setMulticastInterface(mine[0].address); } catch { /* ignore */ } } else wide.add('255.255.255.255');
    }
    // straight to PCs added by address and everyone already found: marked direct, so they hear it whatever network
    // they've picked (someone adding you is how a VPN without broadcasts works)
    const direct = new Set([...extraIps, ...[...peers.values()].map((p) => p.addr)]);
    const wideMsg = Buffer.from(JSON.stringify(body)), directMsg = Buffer.from(JSON.stringify({ ...body, direct: true }));
    for (const t of wide) disco.send(wideMsg, DISCO_PORT, t, () => {});
    for (const t of direct) disco.send(directMsg, DISCO_PORT, t, () => {});
  }

  function onBeacon(buf, rinfo) {
    let b;
    try { b = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (b?.app !== 'bds-comms' || b.id === me.id || !/^[0-9a-f]{16}$/.test(b.id || '') || !PUB_RE.test(b.pub || '')) return;
    // a network is picked: only copies on it, added by address, or that added this PC
    if (me.net && !b.direct && !extraIps.has(rinfo.address) && !netAddrs().some((a) => sameNet(rinfo.address, a))) return;
    if (b.bye) { if (peers.delete(b.id)) pushPeers(); return; }
    const known = peers.get(b.id);
    const p = known || { id: b.id, addrs: new Map() };
    // a PC with several networks (Wi-Fi plus a VM's, say) is heard on each: keep talking to the one first heard
    // while it's still heard, and take any of them as theirs
    p.addrs.set(rinfo.address, Date.now());
    const addr = p.addr && Date.now() - (p.addrs.get(p.addr) || 0) < PEER_TTL ? p.addr : rinfo.address;
    const changed = !known || p.name !== b.name || p.chan !== b.chan || p.addr !== addr || p.pub !== b.pub;
    // their key, remembered the first time; a different one later is held back until accepted
    if (!(p.id in pinned)) { pinned[p.id] = b.pub; writeJSON(keysFile, pinned).catch(() => {}); }
    p.pub = b.pub;
    p.keyChanged = pinned[p.id] !== b.pub;
    Object.assign(p, { direct: !!b.direct, name: String(b.name || 'Someone').slice(0, 40), addr, http: Number(b.http) || 0, voice: Number(b.voice) || 0, chan: Number(b.chan) || 1, seen: Date.now() });
    peers.set(p.id, p);
    if (!known) { push({ type: 'joined', peer: { id: p.id, name: p.name } }); beacon(); } // answer right away so they see us too
    if (changed) pushPeers();
    if (newer({ rev: Number(b.rev) || 0, by: String(b.by || '') }, shared)) lanGet(p, '/shared').then((s) => adoptShared(s, p.id)).catch(() => {});
  }

  function sweepPeers() {
    let gone = false;
    for (const [id, p] of peers) if (Date.now() - p.seen > PEER_TTL) { peers.delete(id); gone = true; push({ type: 'left', peer: { id, name: p.name } }); }
    if (gone) pushPeers();
    sweep();
    for (const [t, o] of outgoing) if (o.expires < Date.now()) outgoing.delete(t);
  }

  // ---------------------------------------------------------------- talking to other copies
  async function lanGet(p, url) {
    const r = await fetch(`http://${p.addr}:${p.http}${url}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  }
  async function lanPost(p, url, body) {
    const r = await fetch(`http://${p.addr}:${p.http}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status}`);
    return r.json();
  }

  function readSmall(req, limit = 256 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }
  const isFrom = (p, addr) => Date.now() - (p.addrs?.get(addr) || 0) < PEER_TTL * 2;
  const remote = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const jsonRes = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

  /** The LAN listener: only these few routes, for other copies. */
  async function onLan(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/hello') return jsonRes(res, 200, { app: 'bds-comms', id: me.id, name: me.name });
      if (req.method === 'GET' && url.pathname === '/shared') return jsonRes(res, 200, publicShared());
      if (req.method === 'GET' && url.pathname.startsWith('/file/')) {
        const o = outgoing.get(url.pathname.slice(6));
        if (!o || !isFrom(o.peer, remote(req))) return jsonRes(res, 404, { error: 'No such file' });
        const st = await fsp.stat(o.path).catch(() => null);
        if (!st?.isFile()) return jsonRes(res, 410, { error: 'The file is gone' });
        if (o.peer.keyChanged) return jsonRes(res, 403, { error: 'Their key changed: not sent until checked' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        patchMessage(o.mid, { file: { status: 'sending' } });
        // one piece held back, so the last one can be marked as last (an empty one if the file ends on a boundary)
        const key = fileKey(o.peer, o.mid);
        const src = fs.createReadStream(o.path, { highWaterMark: PIECE });
        let i = 0, held = null;
        src.on('data', (c) => {
          if (held && !res.write(sealPiece(key, i++, held, false))) { src.pause(); res.once('drain', () => src.resume()); }
          held = c;
        });
        src.on('end', () => res.end(sealPiece(key, i++, held || Buffer.alloc(0), true)));
        src.on('error', () => res.destroy());
        res.on('close', () => src.destroy());
        return;
      }
      if (req.method !== 'POST') return jsonRes(res, 404, { error: 'Not here' });
      const body = await readSmall(req);
      const p = peers.get(body.from);
      if (!p || !isFrom(p, remote(req))) return jsonRes(res, 403, { error: 'Unknown sender' });
      if (url.pathname === '/msg') {
        if (p.keyChanged) return jsonRes(res, 403, { error: 'Their key changed: not accepted until checked' });
        const m = { mid: String(body.mid).slice(0, 40), kind: 'msg', from: p.id, name: p.name, to: body.to === me.id ? me.id : null, t: Number(body.t) || Date.now() };
        let text;
        try { text = unseal(p, m, body.enc || {}).slice(0, MAX_TEXT); } catch { return jsonRes(res, 400, { error: 'Couldn’t decrypt' }); }
        if (!text.trim()) return jsonRes(res, 400, { error: 'Empty' });
        addMessage({ ...m, text, enc: true });
        return jsonRes(res, 200, { ok: true });
      }
      if (url.pathname === '/offer') {
        if (p.keyChanged) return jsonRes(res, 403, { error: 'Their key changed: not accepted until checked' });
        if (!shared.files) return jsonRes(res, 403, { error: 'Files are switched off in this room' });
        const size = Number(body.size) || 0;
        if (shared.maxFileMB && size > shared.maxFileMB * 1048576) return jsonRes(res, 413, { error: `Over the room’s ${shared.maxFileMB} MB limit` });
        const m = { mid: String(body.mid).slice(0, 40), kind: 'file', from: p.id, name: p.name, to: body.room ? null : me.id, t: Number(body.t) || Date.now() };
        let name;
        try { name = unseal(p, offerM(m), body.encName || {}); } catch { return jsonRes(res, 400, { error: 'Couldn’t decrypt' }); }
        addMessage({ ...m, enc: true, file: { name: safeName(name), size, token: String(body.token).slice(0, 64), status: 'offered' } });
        return jsonRes(res, 200, { ok: true });
      }
      if (url.pathname === '/file-status') {
        const m = history.find((x) => x.mid === body.mid && x.from === me.id);
        if (m && ['declined', 'done', 'failed'].includes(body.status)) patchMessage(m.mid, { file: { status: body.status === 'done' ? 'delivered' : body.status } });
        return jsonRes(res, 200, { ok: true });
      }
      if (url.pathname === '/shared') { adoptShared(body.shared, p.id); return jsonRes(res, 200, { ok: true }); }
      return jsonRes(res, 404, { error: 'Not here' });
    } catch (e) { if (!res.headersSent) jsonRes(res, 400, { error: e.message }); }
  }

  const safeName = (n) => (path.basename(String(n || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 180) || 'file');
  async function uniquePath(dir, name) {
    const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
    for (let i = 0; ; i++) {
      const p = path.join(dir, i ? `${base} (${i})${ext}` : name);
      try { await fsp.access(p); } catch { return p; }
    }
  }

  // ---------------------------------------------------------------- the radio
  let seq = 0;
  // packet: 24-byte header · 12-byte nonce · sealed PCM · 16-byte tag; the header and nonce are covered by the tag
  function onVoice(buf, rinfo) {
    if (buf.length < 52 || !buf.subarray(0, 4).equals(VOICE_MAGIC)) return;
    const id = buf.toString('ascii', 4, 20);
    const p = peers.get(id);
    if (!p || !p.pub || p.keyChanged || !isFrom(p, rinfo.address)) return;
    const chan = buf.readUInt8(20), flags = buf.readUInt8(23);
    if (chan !== me.chan) return;
    const nonce = buf.subarray(24, 36), prefix = nonce.toString('hex', 0, 8), n = nonce.readUInt32BE(8);
    if (p.vPrefix === prefix && n <= p.vLast) return; // a repeat or a late one
    let pcm;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', voiceKey(p), nonce);
      d.setAAD(buf.subarray(0, 36));
      d.setAuthTag(buf.subarray(buf.length - 16));
      pcm = Buffer.concat([d.update(buf.subarray(36, buf.length - 16)), d.final()]);
    } catch { return; }
    p.vPrefix = prefix; p.vLast = n;
    if (pcm.length) pushAudio(id, flags, pcm);
    const end = flags & 1;
    if (!end && !p.talking) { p.talking = true; push({ type: 'talk', id, on: true }); }
    clearTimeout(p.talkTimer);
    if (end) { if (p.talking) { p.talking = false; push({ type: 'talk', id, on: false }); } } else p.talkTimer = setTimeout(() => { p.talking = false; push({ type: 'talk', id, on: false }); }, 500);
  }
  function sendVoice(pcm, end) {
    if (!voice) return;
    const targets = [...peers.values()].filter((p) => p.chan === me.chan && p.voice && p.pub && !p.keyChanged);
    const frames = [];
    for (let i = 0; i + FRAME <= pcm.length; i += FRAME) frames.push(pcm.subarray(i, i + FRAME));
    if (end) frames.push(Buffer.alloc(0));
    frames.forEach((f, i) => {
      const head = Buffer.alloc(24);
      VOICE_MAGIC.copy(head, 0);
      head.write(me.id, 4, 'ascii');
      head.writeUInt8(me.chan, 20);
      head.writeUInt16LE(seq = (seq + 1) & 0xffff, 21);
      head.writeUInt8(end && i === frames.length - 1 ? 1 : 0, 23);
      for (const p of targets) {
        if (vCount >= 0xffffffff) { crypto.randomFillSync(vPrefix); vCount = 0; }
        const nonce = Buffer.alloc(12);
        vPrefix.copy(nonce, 0);
        nonce.writeUInt32BE(++vCount, 8);
        const c = crypto.createCipheriv('aes-256-gcm', voiceKey(p), nonce);
        c.setAAD(Buffer.concat([head, nonce]));
        voice.send(Buffer.concat([head, nonce, c.update(f), c.final(), c.getAuthTag()]), p.voice, p.addr, () => {});
      }
    });
  }

  // ---------------------------------------------------------------- start / stop
  async function start({ name, folder, chan, net, extra } = {}) {
    if (net !== undefined || extra !== undefined) {
      if (net !== undefined) me.net = String(net || '');
      if (Array.isArray(extra)) me.extra = [...new Set(extra.map((x) => String(x).trim()).filter((x) => /^[\w.-]{1,253}$/.test(x)))].slice(0, 100);
      resolvedAt = 0;
      // heard on a network no longer listened to: forget them; they come back if still in reach
      for (const [id, p] of peers) if (me.net && !p.direct && !netAddrs().some((a) => sameNet(p.addr, a)) && !extraIps.has(p.addr)) peers.delete(id);
    }
    if (name) me.name = String(name).trim().slice(0, 40) || me.name;
    if (folder) me.folder = String(folder);
    if (chan) me.chan = Math.max(1, Math.min(16, Number(chan) || 1));
    if (on) { beacon(); pushPeers(); push({ type: 'me', me: state().me }); return state(); }
    lan = http.createServer(onLan);
    await new Promise((resolve, reject) => { lan.once('error', reject); lan.listen(0, '0.0.0.0', resolve); });
    voice = dgram.createSocket('udp4');
    voice.on('message', onVoice);
    voice.on('error', (e) => log(`comms voice: ${e.message}`));
    await new Promise((resolve) => voice.bind(0, '0.0.0.0', resolve));
    disco = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    disco.on('message', onBeacon);
    disco.on('error', (e) => log(`comms discovery: ${e.message}`));
    await new Promise((resolve, reject) => { disco.once('error', reject); disco.bind(DISCO_PORT, '0.0.0.0', () => { disco.removeListener('error', reject); resolve(); }); });
    disco.setBroadcast(true);
    try { disco.setMulticastLoopback(true); } catch { /* ignore */ }
    for (const a of localAddrs()) { try { disco.addMembership(GROUP, a.address); } catch { /* not on this one */ } }
    on = true;
    beaconTimer = setInterval(() => beacon(), BEACON_MS);
    sweepTimer = setInterval(sweepPeers, 1000);
    beacon();
    log(`comms on: LAN port ${lan.address().port}, radio port ${voice.address().port}`);
    push({ type: 'state', state: state() });
    return state();
  }
  function stop() {
    if (!on) return state();
    beacon(true);
    clearInterval(beaconTimer); clearInterval(sweepTimer);
    for (const p of peers.values()) clearTimeout(p.talkTimer);
    const d = disco;
    setTimeout(() => { try { d.close(); } catch { /* ignore */ } }, 300); // let the goodbye go out first
    try { voice.close(); } catch { /* ignore */ }
    try { lan.close(); lan.closeAllConnections?.(); } catch { /* ignore */ }
    disco = voice = lan = null;
    peers.clear();
    on = false;
    push({ type: 'state', state: state() });
    return state();
  }

  const mid = () => `${me.id.slice(0, 6)}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const need = () => { if (!on) throw Object.assign(new Error('BoxComms is off'), { status: 409 }); };
  const targetsOf = (to) => (to ? [peers.get(to)].filter(Boolean) : [...peers.values()]);

  const routes = {
    'GET /api/comms/state': async () => state(),
    'GET /api/comms/networks': async () => {
      const by = new Map();
      for (const a of localAddrs()) { if (!by.has(a.name)) by.set(a.name, []); by.get(a.name).push(a.address); }
      return { networks: [...by].map(([name, addrs]) => ({ name, addrs })) };
    },
    'POST /api/comms/start': async (req, q, body) => start(body),
    /** Each network: is it a home one (marked private, a VPN, or a virtual one inside this PC)? */
    'GET /api/comms/network-check': async () => {
      const profiles = await platform.networkProfiles();
      const by = new Map();
      for (const a of localAddrs()) { if (!by.has(a.name)) by.set(a.name, []); by.get(a.name).push(a.address); }
      return { networks: [...by].map(([name, addrs]) => {
        const pr = profiles[name] || {};
        const vpn = !!pr.vpn || /hamachi|tailscale|zerotier|wireguard|^wg\d|openvpn|^tap|^tun\d|radmin|nordlynx|mullvad|proton|vpn/i.test(name);
        const local = /^vethernet|virtualbox|vmware|^vboxnet|^virbr|^docker|^br-|^veth|loopback/i.test(name); // only reaches VMs on this PC
        return { name, addrs, profile: pr.profile || '', category: pr.category || 'unknown', vpn, local, home: pr.category === 'private' || pr.category === 'domain' || vpn || local };
      }) };
    },
    'POST /api/comms/trust-key': async (req, q, body) => {
      const p = peers.get(body.id);
      if (!p) throw Object.assign(new Error('They’ve gone offline'), { status: 404 });
      pinned[p.id] = p.pub; p.keyChanged = false;
      await writeJSON(keysFile, pinned);
      pushPeers();
      return { ok: true };
    },
    'POST /api/comms/stop': async () => stop(),
    'POST /api/comms/radio': async (req, q, body) => { me.chan = Math.max(1, Math.min(16, Number(body.chan) || 1)); beacon(); push({ type: 'me', me: state().me }); return { ok: true }; },
    'POST /api/comms/say': async (req, q, body) => {
      need();
      const text = String(body.text || '').slice(0, MAX_TEXT);
      if (!text.trim()) throw Object.assign(new Error('Type something first'), { status: 400 });
      const to = body.to || null;
      if (to && !peers.has(to)) throw Object.assign(new Error('They’ve gone offline'), { status: 404 });
      if (to && peers.get(to).keyChanged) throw Object.assign(new Error(`${peers.get(to).name}’s key changed: check the safety code first`), { status: 409 });
      const m = { mid: mid(), kind: 'msg', from: me.id, name: me.name, to, text, t: Date.now(), enc: true };
      addMessage(m);
      // sealed separately for each person; anyone whose key changed is left out
      const fails = (await Promise.allSettled(targetsOf(to).filter((p) => !p.keyChanged).map((p) => lanPost(p, '/msg', { from: me.id, mid: m.mid, to, t: m.t, enc: seal(p, m, text) })))).filter((r) => r.status === 'rejected').length;
      if (fails) patchMessage(m.mid, { failed: fails });
      return { ok: true, mid: m.mid };
    },
    'POST /api/comms/send-file': async (req, q, body) => {
      need();
      if (!shared.files) throw Object.assign(new Error('Files are switched off in this room'), { status: 403 });
      const to = body.to || null;
      const sent = [];
      for (const raw of (Array.isArray(body.paths) ? body.paths : []).slice(0, 50)) {
        if (typeof raw !== 'string' || !path.isAbsolute(raw)) continue;
        const fp = path.normalize(raw);
        const st = await fsp.stat(fp).catch(() => null);
        if (!st?.isFile()) continue;
        if (shared.maxFileMB && st.size > shared.maxFileMB * 1048576) throw Object.assign(new Error(`${path.basename(fp)} is over the room’s ${shared.maxFileMB} MB limit`), { status: 413 });
        if (to && peers.get(to)?.keyChanged) throw Object.assign(new Error(`${peers.get(to).name}’s key changed: check the safety code first`), { status: 409 });
        for (const p of targetsOf(to).filter((x) => !x.keyChanged)) {
          const token = crypto.randomBytes(16).toString('hex');
          const m = { mid: mid(), kind: 'file', from: me.id, name: me.name, to: p.id, t: Date.now(), room: !to, file: { name: path.basename(fp), size: st.size, status: 'offered', path: fp } };
          outgoing.set(token, { path: fp, size: st.size, peer: p, mid: m.mid, expires: Date.now() + 3600e3 });
          addMessage(m);
          lanPost(p, '/offer', { from: me.id, mid: m.mid, token, encName: seal(p, offerM(m), m.file.name), size: st.size, room: !to, t: m.t })
            .catch((e) => patchMessage(m.mid, { file: { status: 'failed', error: e.message } }));
          sent.push(m.mid);
        }
      }
      if (!sent.length) throw Object.assign(new Error(peers.size ? 'Nothing to send' : 'Nobody’s online'), { status: 400 });
      return { ok: true, sent };
    },
    'POST /api/comms/answer': async (req, q, body) => {
      need();
      const m = history.find((x) => x.mid === body.mid && x.kind === 'file' && x.from !== me.id);
      if (!m || m.file.status !== 'offered') throw Object.assign(new Error('That offer is gone'), { status: 404 });
      const p = peers.get(m.from);
      if (!p) throw Object.assign(new Error(`${m.name} is offline`), { status: 404 });
      if (!body.accept) { patchMessage(m.mid, { file: { status: 'declined' } }); lanPost(p, '/file-status', { from: me.id, mid: m.mid, status: 'declined' }).catch(() => {}); return { ok: true }; }
      await fsp.mkdir(me.folder, { recursive: true });
      const dest = await uniquePath(me.folder, m.file.name);
      patchMessage(m.mid, { file: { status: 'receiving', got: 0 } });
      (async () => {
        let out = null;
        try {
          if (p.keyChanged) throw new Error('Their key changed: check the safety code first');
          const r = await fetch(`http://${p.addr}:${p.http}/file/${m.file.token}`);
          if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error || `${r.status}`);
          out = fs.createWriteStream(dest);
          // opened piece by piece as they arrive: only ever a piece or two in memory
          const key = fileKey(p, m.mid);
          let got = 0, last = 0, i = 0, done = false, buf = Buffer.alloc(0);
          for await (const chunk of r.body) {
            buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
            while (buf.length >= 5) {
              if (done) throw new Error('Extra data after the end');
              const len = buf.readUInt32BE(1);
              if (len > PIECE) throw new Error('Bad piece');
              if (buf.length < 5 + len + 16) break;
              let plain;
              try { plain = openPiece(key, i++, buf.subarray(0, 5 + len + 16)); } catch { throw new Error('Couldn’t decrypt: the file was changed on the way'); }
              done = !!(buf[0] & 1);
              buf = buf.subarray(5 + len + 16);
              got += plain.length;
              if (plain.length && !out.write(plain)) await new Promise((res) => out.once('drain', res));
            }
            if (Date.now() - last > 250) { last = Date.now(); push({ type: 'progress', mid: m.mid, got, size: m.file.size }); }
          }
          if (!done || buf.length) throw new Error('The transfer was cut short');
          await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
          patchMessage(m.mid, { file: { status: 'done', saved: dest, got } });
          lanPost(p, '/file-status', { from: me.id, mid: m.mid, status: 'done' }).catch(() => {});
        } catch (e) {
          if (out && !out.closed) await new Promise((res) => { out.once('close', res); out.destroy(); });
          await fsp.rm(dest, { force: true }).catch(() => {});
          patchMessage(m.mid, { file: { status: 'failed', error: e.message } });
          lanPost(p, '/file-status', { from: me.id, mid: m.mid, status: 'failed' }).catch(() => {});
        }
      })();
      return { ok: true, dest };
    },
    'POST /api/comms/delete': async (req, q, body) => { history = history.filter((m) => m.mid !== body.mid); saveHistory(); push({ type: 'history', history }); return { ok: true }; },
    'POST /api/comms/clear-mine': async () => { history = []; saveHistory(); push({ type: 'history', history }); return { ok: true }; },
    'POST /api/comms/shared': async (req, q, body) => { changeShared(body.patch || {}); return { ok: true, shared }; },
    'POST /api/comms/wipe': async () => { changeShared({ wipedAt: Date.now() }); return { ok: true }; },
  };

  /** GET /api/comms/stream: everything that happens, as it happens. */
  function stream(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.write(frame(1, Buffer.from(JSON.stringify({ type: 'state', state: state() }), 'utf8')));
    streams.add(res);
    const ping = setInterval(() => res.write(frame(1, Buffer.from('{"type":"ping"}'))), 15000);
    req.on('close', () => { clearInterval(ping); streams.delete(res); });
  }

  /** POST /api/comms/voice: whole 20 ms frames of the mic, sent on to everyone on this channel. ?end=1 ends a transmission. */
  function voiceIn(req, res, q) {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= FRAME * 50) chunks.push(c); });
    req.on('end', () => {
      if (on) sendVoice(Buffer.concat(chunks), q.get('end') === '1');
      res.writeHead(204); res.end();
    });
  }

  // the main API calls handlers with (req, q): read the JSON body for them
  for (const [key, fn] of Object.entries(routes)) routes[key] = async (req, q) => fn(req, q, key.startsWith('POST ') ? await readJSONBody(req) : {});

  return { routes, stream, voiceIn, stop };
};
