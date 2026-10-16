// Translate: text you selected, through Google Translate's public web endpoint (no key). Only what you chose to
// translate is sent, when you ask.

'use strict';

module.exports = function createTranslate({ BROWSER_UA, readJSONBody }) {
  const LANG = /^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/;
  const MAX = 5000;

  async function translate(text, to, from = 'auto') {
    text = String(text || '');
    if (!text.trim()) return { text: '', from: from || 'auto' };
    if (text.length > MAX) throw Object.assign(new Error(`That’s too long to translate at once (${MAX.toLocaleString()} characters at most).`), { status: 400 });
    if (!LANG.test(to || '') || to === 'auto' || !LANG.test(from || 'auto')) throw Object.assign(new Error('Unknown language'), { status: 400 });
    const url = 'https://translate.googleapis.com/translate_a/single?' + new URLSearchParams({ client: 'gtx', sl: from || 'auto', tl: to, dt: 't' });
    let r, j;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': BROWSER_UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ q: text }).toString(),
        signal: AbortSignal.timeout(15000),
      });
      j = await r.json();
    } catch { throw Object.assign(new Error('Couldn’t reach Google Translate'), { status: 502 }); }
    if (!r.ok || !Array.isArray(j?.[0])) throw Object.assign(new Error(`Google Translate answered ${r.status}`), { status: 502 });
    return { text: j[0].map((part) => part?.[0] || '').join(''), from: typeof j[2] === 'string' ? j[2] : from };
  }

  const routes = {
    'POST /api/translate': async (req) => { const b = await readJSONBody(req); return translate(b.text, b.to, b.from); },
  };

  return { routes };
};
