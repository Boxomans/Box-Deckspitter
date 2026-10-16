// Weather: forecasts and place search from Open-Meteo (free, no key; data under CC BY 4.0, credited in the app).

'use strict';

module.exports = function createWeather({ BROWSER_UA }) {
  const get = async (url, what) => {
    let r, j;
    try {
      r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      j = await r.json();
    } catch { throw Object.assign(new Error(`Couldn’t reach ${what}`), { status: 502 }); }
    if (!r.ok || j?.error) throw Object.assign(new Error(j?.reason || `${what} answered ${r.status}`), { status: 502 });
    return j;
  };

  /** A place's weather now, the next 24 hours and 7 days. Kept 10 minutes, so open windows share one ask. */
  const cache = new Map();
  async function forecast(lat, lon, unit) {
    lat = Number(lat); lon = Number(lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw Object.assign(new Error('Unknown place'), { status: 400 });
    const c = unit === 'c';
    const key = `${lat.toFixed(3)},${lon.toFixed(3)},${c ? 'c' : 'f'}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 600000) return hit.data;
    const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
      latitude: lat.toFixed(4), longitude: lon.toFixed(4),
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day,precipitation',
      hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
      timezone: 'auto', timeformat: 'unixtime', forecast_days: '7',
      temperature_unit: c ? 'celsius' : 'fahrenheit', wind_speed_unit: c ? 'kmh' : 'mph', precipitation_unit: c ? 'mm' : 'inch',
    });
    let j;
    try { j = await get(url, 'Open-Meteo'); } catch (e) { if (hit) return hit.data; throw e; }
    const cur = j.current || {}, hr = j.hourly || {}, dy = j.daily || {};
    const now = Date.now() / 1000;
    const hourly = [];
    for (let i = 0; i < (hr.time || []).length && hourly.length < 25; i++) {
      if (hr.time[i] + 3600 <= now) continue;
      hourly.push({ t: hr.time[i] * 1000, temp: hr.temperature_2m[i], code: hr.weather_code[i], pop: hr.precipitation_probability?.[i] ?? null, day: !!hr.is_day?.[i] });
    }
    const daily = (dy.time || []).map((t, i) => ({
      t: t * 1000, code: dy.weather_code[i], hi: dy.temperature_2m_max[i], lo: dy.temperature_2m_min[i],
      pop: dy.precipitation_probability_max?.[i] ?? null, sunrise: (dy.sunrise?.[i] || 0) * 1000, sunset: (dy.sunset?.[i] || 0) * 1000,
    }));
    const data = {
      tz: j.timezone || 'UTC', at: Date.now(),
      units: { temp: c ? '°C' : '°F', wind: c ? 'km/h' : 'mph', rain: c ? 'mm' : 'in' },
      current: { temp: cur.temperature_2m, feels: cur.apparent_temperature, humidity: cur.relative_humidity_2m, wind: cur.wind_speed_10m, code: cur.weather_code, day: !!cur.is_day, rain: cur.precipitation },
      hourly, daily,
    };
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 50) cache.delete(cache.keys().next().value);
    return data;
  }

  /** Places by name: towns, cities, regions. */
  async function search(q) {
    q = String(q).trim().slice(0, 80);
    if (q.length < 2) return [];
    const j = await get('https://geocoding-api.open-meteo.com/v1/search?' + new URLSearchParams({ name: q, count: '10', language: 'en', format: 'json' }), 'Open-Meteo');
    return (j.results || []).map((x) => ({ name: x.name, admin: x.admin1 || '', country: x.country || '', lat: x.latitude, lon: x.longitude }));
  }

  const routes = {
    'GET /api/weather': async (req, q) => forecast(q.get('lat'), q.get('lon'), q.get('unit')),
    'GET /api/weather/search': async (req, q) => search(q.get('q') || ''),
  };

  return { routes };
};
