// BoxMail server side: Gmail accounts (IMAP to read, SMTP to send) using Google app passwords.
// Passwords live in data/secrets.json and never go back to the page. Mailboxes are opened read-only,
// and messages are fetched with BODY.PEEK, so browsing never marks anything as read.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IMAP_HOST = 'imap.gmail.com';
const SMTP_HOST = 'smtp.gmail.com';
const MAX_SEND_BYTES = 25 * 1024 * 1024; // Gmail's attachment limit
const BOXES = ['inbox', 'starred', 'important', 'sent', 'drafts', 'all', 'spam', 'trash'];
const CATEGORIES = ['primary', 'updates', 'promotions', 'social', 'forums'];
const SPECIAL = { starred: '\\Flagged', important: '\\Important', sent: '\\Sent', drafts: '\\Drafts', all: '\\All', spam: '\\Junk', trash: '\\Trash' };

const fail = (status, message) => Object.assign(new Error(message), { status });

module.exports = function createMail({ secrets, saveSecrets, readBody, readJSONBody, requirePath, dumpFile, log }) {
  const { ImapFlow } = require('imapflow');
  const nodemailer = require('nodemailer');
  const { simpleParser } = require('mailparser');

  // ------------------------------------------------------------------ accounts

  const accounts = () => (secrets().mailAccounts || []).filter((a) => a && a.id && a.address && a.appPassword);
  const publicAccount = (a) => ({ id: a.id, address: a.address, name: a.name || '' });
  function account(id) {
    const list = accounts();
    const a = list.find((x) => x.id === id) || (!id && list[0]);
    if (!a) throw fail(400, list.length ? 'Unknown email account' : 'Add a Gmail account in Settings → Email first.');
    return a;
  }

  // ------------------------------------------------------------------ IMAP connections (one per account, reused)

  const clients = new Map(); // id -> { client, ready: Promise, folders }
  function imapFor(a) {
    let c = clients.get(a.id);
    if (c && c.client.usable) return c.ready.then(() => c);
    const client = new ImapFlow({
      host: IMAP_HOST, port: 993, secure: true,
      auth: { user: a.address, pass: a.appPassword },
      logger: false, emitLogs: false, disableAutoIdle: true,
      socketTimeout: 5 * 60 * 1000,
    });
    client.on('error', (e) => log(`mail ${a.address}: ${e.message}`));
    client.on('close', () => { if (clients.get(a.id)?.client === client) clients.delete(a.id); });
    c = { client, folders: null };
    c.ready = client.connect().then(async () => {
      const list = await client.list();
      const folders = { inbox: 'INBOX' };
      for (const [box, flag] of Object.entries(SPECIAL)) {
        const f = list.find((x) => x.specialUse === flag);
        if (f) folders[box] = f.path;
      }
      c.folders = folders;
    });
    clients.set(a.id, c);
    return c.ready.then(() => c, (e) => { clients.delete(a.id); throw friendlyAuthError(e); });
  }

  function friendlyAuthError(e) {
    const msg = String(e && (e.responseText || e.message) || e);
    if (/auth|credential|password|login/i.test(msg)) {
      return fail(401, 'Gmail rejected the sign-in. Use a 16-letter app password (not your normal password), and make sure IMAP is allowed for the account.');
    }
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(msg)) return fail(503, 'Couldn’t reach Gmail — check your internet connection.');
    return fail(502, msg.slice(0, 300));
  }

  async function withBox(a, box, fn) {
    if (!BOXES.includes(box)) throw fail(400, 'Unknown folder');
    const c = await imapFor(a);
    const mbox = c.folders[box];
    if (!mbox) throw fail(404, `This account has no ${box} folder`);
    const lock = await c.client.getMailboxLock(mbox, { readOnly: true });
    try { return await fn(c.client, mbox); } finally { lock.release(); }
  }

  // ------------------------------------------------------------------ parsing (shared by Gmail messages and .eml files)

  const parsedCache = new Map(); // key -> parsed message, newest last
  function remember(key, parsed) {
    parsedCache.delete(key);
    parsedCache.set(key, parsed);
    while (parsedCache.size > 25) parsedCache.delete(parsedCache.keys().next().value);
  }

  const addrList = (v) => (v?.value || []).map((x) => ({ name: x.name || '', address: x.address || '' }));

  async function parseMessage(source, key) {
    const p = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: false });
    remember(key, p);
    let html = p.html || '';
    // Inline (cid:) images become data URLs so the reader can show them without fetching anything.
    for (const att of p.attachments || []) {
      if (att.contentId && att.content && att.content.length < 6 * 1024 * 1024 && /^image\//.test(att.contentType)) {
        const cid = att.contentId.replace(/^<|>$/g, '');
        const dataUrl = `data:${att.contentType};base64,${att.content.toString('base64')}`;
        html = html.split(`cid:${cid}`).join(dataUrl);
      }
    }
    return {
      key,
      subject: p.subject || '',
      from: addrList(p.from), to: addrList(p.to), cc: addrList(p.cc), replyTo: addrList(p.replyTo),
      date: p.date ? p.date.getTime() : null,
      messageId: p.messageId || '',
      references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : [],
      html, text: p.text || '',
      attachments: (p.attachments || []).map((att, idx) => ({
        idx, filename: att.filename || `attachment-${idx + 1}`, contentType: att.contentType || 'application/octet-stream',
        size: att.size || att.content?.length || 0, inline: att.contentDisposition === 'inline' && !!att.contentId,
      })),
    };
  }

  // ------------------------------------------------------------------ sending

  async function attachmentsFor(list) {
    const out = [];
    let total = 0;
    for (const a of Array.isArray(list) ? list : []) {
      let item;
      if (a.dump) {
        const file = dumpFile(a.dump, a.name);
        item = { filename: path.basename(file), path: file, size: fs.statSync(file).size };
      } else if (a.path) {
        const file = requirePath(a.path);
        item = { filename: a.name || path.basename(file), path: file, size: fs.statSync(file).size };
      } else if (a.base64) {
        const content = Buffer.from(a.base64, 'base64');
        item = { filename: String(a.name || 'attachment').slice(0, 200), content, contentType: a.contentType || undefined, size: content.length };
      } else continue;
      total += item.size;
      if (total > MAX_SEND_BYTES) throw fail(413, 'Attachments are over Gmail’s 25 MB limit. Remove some, or share big files with a link instead.');
      delete item.size;
      out.push(item);
    }
    return out;
  }

  const ADDR_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
  function addresses(v) {
    const list = (Array.isArray(v) ? v : String(v || '').split(/[,;]/)).map((s) => String(s).trim()).filter(Boolean);
    for (const s of list) {
      const bare = (/<([^>]+)>/.exec(s) || [null, s])[1].trim();
      if (!ADDR_RE.test(bare)) throw fail(400, `“${s}” doesn’t look like an email address`);
    }
    return list;
  }

  // ------------------------------------------------------------------ routes

  return {
    'GET /api/mail/accounts': async () => ({ accounts: accounts().map(publicAccount) }),

    'POST /api/mail/accounts': async (req) => {
      const { address, appPassword, name } = await readJSONBody(req);
      const addr = String(address || '').trim().toLowerCase();
      const pass = String(appPassword || '').replace(/\s+/g, '');
      if (!ADDR_RE.test(addr)) throw fail(400, 'Enter the full Gmail address');
      if (!/^[a-z]{16}$/i.test(pass)) throw fail(400, 'An app password is 16 letters (spaces don’t matter). Create one at myaccount.google.com/apppasswords.');
      // Check both directions before saving.
      const probe = { id: 'probe-' + crypto.randomBytes(4).toString('hex'), address: addr, appPassword: pass };
      try {
        const c = await imapFor(probe);
        await c.client.logout().catch(() => {});
        clients.delete(probe.id);
        await nodemailer.createTransport({ host: SMTP_HOST, port: 465, secure: true, auth: { user: addr, pass } }).verify();
      } catch (e) {
        clients.delete(probe.id);
        throw e.status ? e : friendlyAuthError(e);
      }
      const s = secrets();
      const list = (s.mailAccounts || []).filter((a) => a.address !== addr);
      const acct = { id: crypto.randomBytes(6).toString('hex'), address: addr, appPassword: pass, name: String(name || '').trim().slice(0, 80) };
      list.push(acct);
      await saveSecrets({ ...s, mailAccounts: list });
      return { ok: true, account: publicAccount(acct), accounts: list.map(publicAccount) };
    },

    'POST /api/mail/accounts/remove': async (req) => {
      const { id } = await readJSONBody(req);
      const c = clients.get(id);
      if (c) { c.client.logout().catch(() => {}); clients.delete(id); }
      const s = secrets();
      const list = (s.mailAccounts || []).filter((a) => a.id !== id);
      await saveSecrets({ ...s, mailAccounts: list });
      return { ok: true, accounts: list.map(publicAccount) };
    },

    // Message list: newest first, paged with `before` (a UID). Inbox can be split by Gmail category.
    'GET /api/mail/list': async (req, q) => {
      const a = account(q.get('acct'));
      const box = q.get('box') || 'inbox';
      const cat = q.get('cat');
      const text = (q.get('q') || '').trim().slice(0, 300);
      const before = Number(q.get('before')) || Infinity;
      const limit = Math.min(100, Number(q.get('limit')) || 40);
      const raw = [box === 'inbox' && CATEGORIES.includes(cat) ? `category:${cat}` : '', text].filter(Boolean).join(' ');
      return withBox(a, box, async (client) => {
        const found = await client.search(raw ? { gmraw: raw } : { all: true }, { uid: true });
        const uids = (found || []).filter((u) => u < before).sort((x, y) => y - x);
        const page = uids.slice(0, limit);
        const items = [];
        if (page.length) {
          for await (const m of client.fetch(page.join(','), { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true, threadId: true }, { uid: true })) {
            const env = m.envelope || {};
            items.push({
              uid: m.uid,
              subject: env.subject || '(no subject)',
              from: (env.from || []).map((x) => ({ name: x.name || '', address: x.address || '' })),
              to: (env.to || []).map((x) => ({ name: x.name || '', address: x.address || '' })),
              date: (env.date || m.internalDate)?.getTime?.() || null,
              unread: !(m.flags && m.flags.has('\\Seen')),
              starred: !!(m.flags && m.flags.has('\\Flagged')),
              attachments: hasAttachment(m.bodyStructure),
              size: m.size || 0,
              thread: m.threadId || null,
            });
          }
        }
        items.sort((x, y) => y.uid - x.uid);
        return { items, total: uids.length, more: uids.length > limit, next: page.length ? page[page.length - 1] : null };
      });
    },

    // Unread counts for the inbox category tabs.
    'GET /api/mail/counts': async (req, q) => {
      const a = account(q.get('acct'));
      return withBox(a, 'inbox', async (client) => {
        const out = {};
        for (const cat of CATEGORIES) {
          const r = await client.search({ seen: false, gmraw: `category:${cat}` }, { uid: true }).catch(() => []);
          out[cat] = (r || []).length;
        }
        return { unread: out };
      });
    },

    'GET /api/mail/message': async (req, q) => {
      const a = account(q.get('acct'));
      const box = q.get('box') || 'inbox';
      const uid = Number(q.get('uid'));
      if (!uid) throw fail(400, 'Missing message');
      return withBox(a, box, async (client) => {
        const m = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
        if (!m || !m.source) throw fail(404, 'That message is gone');
        const out = await parseMessage(m.source, `${a.id}:${box}:${uid}`);
        out.unread = !(m.flags && m.flags.has('\\Seen'));
        out.account = a.address;
        return out;
      });
    },

    // Attachment bytes from a message opened earlier (Gmail or .eml).
    'GET /api/mail/attachment': async (req, q) => {
      const p = parsedCache.get(q.get('key') || '');
      if (!p) throw fail(404, 'Open the message again to get its attachments');
      const att = (p.attachments || [])[Number(q.get('idx'))];
      if (!att) throw fail(404, 'No such attachment');
      return { raw: att.content, type: att.contentType || 'application/octet-stream' };
    },

    // Read a saved .eml file (no account needed).
    'POST /api/mail/parse': async (req) => {
      const source = await readBody(req, 100 * 1024 * 1024);
      const key = 'eml:' + crypto.createHash('sha1').update(source).digest('hex').slice(0, 16);
      return parseMessage(source, key);
    },

    'POST /api/mail/send': async (req) => {
      const body = await readJSONBody(req);
      const a = account(body.acct);
      const to = addresses(body.to);
      const cc = addresses(body.cc);
      const bcc = addresses(body.bcc);
      if (!to.length && !cc.length && !bcc.length) throw fail(400, 'Add at least one recipient');
      const transport = nodemailer.createTransport({ host: SMTP_HOST, port: 465, secure: true, auth: { user: a.address, pass: a.appPassword } });
      const info = await transport.sendMail({
        from: a.name ? { name: a.name, address: a.address } : a.address,
        to, cc, bcc,
        subject: String(body.subject || '').slice(0, 998),
        text: String(body.text || ''),
        html: body.html ? String(body.html) : undefined,
        inReplyTo: body.inReplyTo || undefined,
        references: Array.isArray(body.references) && body.references.length ? body.references : undefined,
        attachments: await attachmentsFor(body.attachments),
      }).catch((e) => { throw e.status ? e : friendlyAuthError(e); });
      // Gmail files messages sent over SMTP into Sent Mail automatically.
      return { ok: true, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
    },
  };
};

function hasAttachment(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes || []).some(hasAttachment);
}
