// Discord Rich Presence (opt-in). Talks to the local Discord client over its IPC pipe.
// The UI only ever sends generic phrases ("editing a .pdf"), never file names.

'use strict';

const crypto = require('crypto');
const path = require('path');

module.exports = function createPresence({ IS_WIN, readJSONBody }) {
  const net = require('net');

  class DiscordPresence {
    constructor() {
      this.sock = null;
      this.clientId = null;
      this.ready = false;
      this.connecting = false;
      this.activity = null;
      this.lastSent = 0;
      this.sendTimer = null;
      this.status = 'off';
      this.buf = Buffer.alloc(0);
    }

    pipePath(i) {
      if (IS_WIN) return `\\\\?\\pipe\\discord-ipc-${i}`;
      const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
      return path.join(base, `discord-ipc-${i}`);
    }

    frame(op, payload) {
      const json = Buffer.from(JSON.stringify(payload), 'utf8');
      const head = Buffer.alloc(8);
      head.writeInt32LE(op, 0);
      head.writeInt32LE(json.length, 4);
      return Buffer.concat([head, json]);
    }

    disconnect(status = 'off') {
      if (this.sock) { try { this.sock.destroy(); } catch { /* ignore */ } }
      this.sock = null;
      this.ready = false;
      this.connecting = false;
      this.status = status;
    }

    async connect() {
      if (this.sock || this.connecting || !this.clientId) return;
      this.connecting = true;
      this.status = 'connecting';
      for (let i = 0; i < 10; i++) {
        const sock = await new Promise((resolve) => {
          const s = net.createConnection(this.pipePath(i));
          const t = setTimeout(() => { s.destroy(); resolve(null); }, 800);
          s.once('connect', () => { clearTimeout(t); resolve(s); });
          s.once('error', () => { clearTimeout(t); resolve(null); });
        });
        if (!sock) continue;
        this.sock = sock;
        this.buf = Buffer.alloc(0);
        sock.on('data', (d) => this.onData(d));
        sock.on('close', () => { this.sock = null; this.ready = false; if (this.status !== 'off' && this.status !== 'bad-id') this.status = 'discord-closed'; });
        sock.on('error', () => {});
        sock.write(this.frame(0, { v: 1, client_id: this.clientId }));
        this.connecting = false;
        return;
      }
      this.connecting = false;
      this.status = 'discord-not-running';
    }

    onData(d) {
      this.buf = Buffer.concat([this.buf, d]);
      while (this.buf.length >= 8) {
        const op = this.buf.readInt32LE(0);
        const len = this.buf.readInt32LE(4);
        if (this.buf.length < 8 + len) break;
        let msg = {};
        try { msg = JSON.parse(this.buf.subarray(8, 8 + len).toString('utf8')); } catch { /* ignore */ }
        this.buf = this.buf.subarray(8 + len);
        if (op === 1 && msg.evt === 'READY') { this.ready = true; this.status = 'connected'; this.flush(true); }
        else if (op === 1 && msg.evt === 'ERROR') { this.status = 'error: ' + (msg.data?.message || 'unknown'); }
        else if (op === 2) { this.disconnect(/client id/i.test(msg.message || '') ? 'bad-id' : 'discord-closed'); }
        else if (op === 3) { this.sock?.write(this.frame(4, msg)); } // ping → pong
      }
    }

    /** Discord allows ~5 updates / 20s; coalesce to one every 4s. */
    flush(now = false) {
      clearTimeout(this.sendTimer);
      if (!this.ready || !this.sock) return;
      const wait = now ? 0 : Math.max(0, 4000 - (Date.now() - this.lastSent));
      this.sendTimer = setTimeout(() => {
        if (!this.ready || !this.sock) return;
        this.lastSent = Date.now();
        this.sock.write(this.frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: this.activity }, nonce: crypto.randomUUID() }));
      }, wait);
    }

    async update({ enabled, clientId, activity }) {
      const id = String(clientId || '').trim();
      if (!enabled || !/^\d{15,22}$/.test(id)) {
        if (this.sock && this.ready) this.sock.write(this.frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: crypto.randomUUID() }));
        setTimeout(() => this.disconnect(enabled ? 'bad-id' : 'off'), 200);
        return this.status = enabled ? 'bad-id' : 'off';
      }
      if (id !== this.clientId) { this.disconnect('connecting'); this.clientId = id; }
      this.activity = sanitizeActivity(activity);
      if (!this.sock) await this.connect();
      else this.flush();
      return this.status;
    }
  }

  function sanitizeActivity(a) {
    if (!a) return null;
    const clip = (s, n = 120) => (s == null ? undefined : String(s).slice(0, n));
    const out = { details: clip(a.details), state: clip(a.state), instance: false };
    if (a.start) out.timestamps = { start: Math.floor(Number(a.start) / 1000) * 1000 };
    const assets = {};
    if (a.largeImage) { assets.large_image = clip(a.largeImage, 256); assets.large_text = clip(a.largeText || 'Box-Deckspitter'); }
    if (a.smallImage) { assets.small_image = clip(a.smallImage, 256); assets.small_text = clip(a.smallText); }
    if (Object.keys(assets).length) out.assets = assets;
    return out;
  }

  const presence = new DiscordPresence();

  const routes = {
    'POST /api/presence': async (req) => ({ status: await presence.update(await readJSONBody(req)) }),
    'GET /api/presence': async () => ({ status: presence.status }),
  };

  return { routes, presence };
};
