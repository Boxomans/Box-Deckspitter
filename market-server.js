// BoxTicker: charts and ticker search from Yahoo Finance's public feeds (no key).

'use strict';

module.exports = function createMarket({ BROWSER_UA }) {
  /** BoxTicker: charts and ticker search from Yahoo Finance's public feeds (no key), kept a little while so an open
   *  tab (or two) asks Yahoo at most every 20 s. Symbols look like AAPL, ^GSPC, 7203.T, BTC-USD, EURUSD=X, ES=F. */
  const MARKET_SYMBOL = /^[\^A-Za-z0-9.\-=]{1,20}$/;
  const MARKET_STEP = { '1d': '5m', '5d': '15m', '1mo': '60m', '6mo': '1d', ytd: '1d', '1y': '1d', '5y': '1wk', max: '1mo' };
  const marketCache = new Map();
  async function marketChart(symbol, range) {
    if (!MARKET_SYMBOL.test(symbol) || !MARKET_STEP[range]) throw Object.assign(new Error('Unknown index or range'), { status: 400 });
    const key = `${symbol} ${range}`;
    const hit = marketCache.get(key);
    if (hit && Date.now() - hit.at < (range === '1d' ? 20000 : 300000)) return hit.data;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${MARKET_STEP[range]}&includePrePost=false`;
    let r, j;
    try {
      r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      j = await r.json();
    } catch {
      if (hit) return hit.data;
      throw Object.assign(new Error('Couldn’t reach Yahoo Finance'), { status: 502 });
    }
    const res = j?.chart?.result?.[0];
    if (!r.ok || !res) {
      if (hit) return hit.data;
      throw Object.assign(new Error(j?.chart?.error?.description || `Yahoo Finance answered ${r.status}`), { status: r.status === 404 ? 404 : 502 });
    }
    const m = res.meta || {};
    const ts = res.timestamp || [], close = res.indicators?.quote?.[0]?.close || [];
    const points = [];
    for (let i = 0; i < ts.length; i++) if (close[i] != null) points.push([ts[i] * 1000, close[i]]);
    const sessionLen = m.currentTradingPeriod?.regular ? (m.currentTradingPeriod.regular.end - m.currentTradingPeriod.regular.start) * 1000 : 0;
    // the feed's last bar can trail the live price by a few minutes (but a stamp from after the close isn't a new point)
    if (range === '1d' && m.regularMarketPrice != null && points.length && m.regularMarketTime * 1000 > points[points.length - 1][0]
      && m.regularMarketTime * 1000 <= points[0][0] + (sessionLen || 6.5 * 3600e3)) points.push([m.regularMarketTime * 1000, m.regularMarketPrice]);
    const p = m.currentTradingPeriod || {};
    const now = Date.now() / 1000;
    const inside = (x) => x && now >= x.start && now < x.end;
    const prevClose = m.previousClose ?? m.chartPreviousClose;
    const data = {
      symbol, range, name: m.longName || m.shortName || symbol, currency: m.currency || '', exchange: m.fullExchangeName || m.exchangeName || '',
      price: m.regularMarketPrice, prevClose, session: sessionLen,
      base: range === '1d' ? prevClose : (m.chartPreviousClose ?? points[0]?.[1]),
      dayHigh: m.regularMarketDayHigh, dayLow: m.regularMarketDayLow, high52: m.fiftyTwoWeekHigh, low52: m.fiftyTwoWeekLow,
      time: (m.regularMarketTime || 0) * 1000, tz: m.exchangeTimezoneName || 'America/New_York',
      state: inside(p.regular) ? 'open' : inside(p.pre) ? 'pre' : inside(p.post) ? 'post' : 'closed',
      points,
    };
    marketCache.set(key, { at: Date.now(), data });
    return data;
  }

  const searchCache = new Map();
  async function marketSearch(q) {
    q = String(q).trim().slice(0, 60);
    if (!q) return [];
    const hit = searchCache.get(q.toLowerCase());
    if (hit && Date.now() - hit.at < 600000) return hit.list;
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`;
    let j;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      j = await r.json();
    } catch { throw Object.assign(new Error('Couldn’t reach Yahoo Finance'), { status: 502 }); }
    const list = (j?.quotes || []).filter((x) => x.symbol && MARKET_SYMBOL.test(x.symbol) && x.quoteType !== 'OPTION')
      .map((x) => ({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, exchange: x.exchDisp || x.exchange || '', type: x.typeDisp || x.quoteType || '' }));
    searchCache.set(q.toLowerCase(), { at: Date.now(), list });
    if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
    return list;
  }

  const routes = {
    'GET /api/market': async (req, q) => marketChart(q.get('symbol') || '', q.get('range') || '1d'),
    'GET /api/market/search': async (req, q) => marketSearch(q.get('q') || ''),
  };

  return { routes };
};
