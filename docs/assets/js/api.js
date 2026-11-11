/* Free data sources (no keys): Open-Meteo (weather), BigDataCloud (reverse geocoding), Energinet (DK prices) */
(function (A) {
  'use strict';
  const api = A.api = {};
  const OM = {
    forecast: 'https://api.open-meteo.com/v1/forecast',
    historical: 'https://historical-forecast-api.open-meteo.com/v1/forecast',
    ensemble: 'https://ensemble-api.open-meteo.com/v1/ensemble',
    archive: 'https://archive-api.open-meteo.com/v1/archive',
    geocode: 'https://geocoding-api.open-meteo.com/v1/search',
  };
  api.VARS = ['wind_speed_10m', 'wind_speed_100m', 'wind_direction_100m', 'wind_gusts_10m', 'temperature_2m', 'relative_humidity_2m', 'surface_pressure',
    'shortwave_radiation', 'cloud_cover', 'precipitation', 'snowfall', 'snow_depth', 'visibility', 'cape', 'weather_code'];
  api.ENS_VARS = ['wind_speed_10m', 'wind_speed_100m', 'wind_gusts_10m', 'temperature_2m', 'surface_pressure', 'shortwave_radiation'];
  api.MODELS = { ecmwf_ifs025: 'ECMWF IFS', gfs_seamless: 'NOAA GFS', icon_seamless: 'DWD ICON', meteofrance_seamless: 'Météo-France' };
  api.ENSEMBLES = { ecmwf_ifs025: 'ECMWF ENS', gfs025: 'GFS GEFS', icon_seamless: 'ICON EPS' };

  const cache = new Map();
  async function getJSON(url) {
    if (cache.has(url)) return cache.get(url);
    const r = await fetch(url);
    let j; try { j = await r.json(); } catch (e) { throw new Error(`Bad response from ${new URL(url).host} (HTTP ${r.status})`); }
    if (!r.ok || j.error) throw new Error(j.reason || j.message || `HTTP ${r.status} from ${new URL(url).host}`);
    if (cache.size > 60) cache.clear();
    cache.set(url, j);
    return j;
  }
  const qs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(Array.isArray(v) ? v.join(',') : v)}`).join('&');
  const frame = (h) => { const o = { time: h.time.map(A.parseUTC) }; for (const k in h) if (k !== 'time') o[k] = h[k]; return o; };

  /* ---------- location ---------- */
  api.search = async (q) => (await getJSON(`${OM.geocode}?${qs({ name: q, count: 6, language: 'en' })}`)).results || [];
  api.reverse = async (lat, lon) => {
    try {
      const j = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?${qs({ latitude: lat, longitude: lon, localityLanguage: 'en' })}`);
      return { name: j.city || j.locality || j.principalSubdivision || '', region: j.principalSubdivision || '', country: j.countryName || '', cc: j.countryCode || '' };
    } catch (e) { return { name: '', region: '', country: '', cc: '' }; }
  };
  api.siteInfo = async (lat, lon) => {   // timezone + model-grid elevation
    const j = await getJSON(`${OM.forecast}?${qs({ latitude: lat, longitude: lon, hourly: 'temperature_2m', forecast_days: 1, timezone: 'auto' })}`);
    return { tz: j.timezone || 'UTC', elevation: j.elevation };
  };

  /* ---------- weather ---------- */
  // Picks the right endpoint for the requested window: archived forecasts for the past,
  // live forecast API (start/end dates, ≤16 days ahead) for recent/future dates.
  api.weather = async (model, lat, lon, start, end) => {
    const today = A.todayUTC(), recent = A.addDays(today, -80);
    const parts = [];
    const base = { latitude: lat, longitude: lon, hourly: api.VARS, models: model, wind_speed_unit: 'ms', timezone: 'GMT' };
    if (start < recent) {
      const e = end < today ? end : A.addDays(today, -1);
      parts.push(getJSON(`${OM.historical}?${qs({ ...base, start_date: A.isoDate(start), end_date: A.isoDate(e) })}`));
      if (end >= today) parts.push(getJSON(`${OM.forecast}?${qs({ ...base, start_date: A.isoDate(today), end_date: A.isoDate(end) })}`));
    } else {
      parts.push(getJSON(`${OM.forecast}?${qs({ ...base, start_date: A.isoDate(start), end_date: A.isoDate(end) })}`));
    }
    const frames = (await Promise.all(parts)).map((j) => frame(j.hourly));
    if (frames.length === 1) return frames[0];
    const out = { time: [] };
    for (const f of frames) for (const k in f) out[k] = (out[k] || []).concat(f[k]);
    return out;
  };
  // Ensemble members (future only). Returns [{member, time, vars...}]
  api.ensemble = async (model, lat, lon, start, end) => {
    const today = A.todayUTC();
    if (end < today) return [];
    const days = Math.min(35, Math.round((end - today) / A.DAY) + 1);
    const j = await getJSON(`${OM.ensemble}?${qs({ latitude: lat, longitude: lon, hourly: api.ENS_VARS, models: model, forecast_days: days, wind_speed_unit: 'ms', timezone: 'GMT' })}`);
    const h = j.hourly, time = h.time.map(A.parseUTC), members = {};
    for (const key in h) {
      for (const v of api.ENS_VARS) {
        let id = null;
        if (key === v) id = '00';
        else if (key.startsWith(v + '_')) { const m = /^_member(\d+)$/.exec(key.slice(v.length)); if (m) id = m[1].padStart(2, '0'); }
        if (id == null) continue;
        (members[id] = members[id] || { member: `${model}:${id}`, time })[v] = h[key];
      }
    }
    return Object.values(members);
  };
  // ERA5 reanalysis for site assessment
  api.archive = async (lat, lon, start, end) => frame((await getJSON(`${OM.archive}?${qs({
    latitude: lat, longitude: lon, start_date: A.isoDate(start), end_date: A.isoDate(end),
    hourly: ['wind_speed_10m', 'wind_speed_100m', 'temperature_2m', 'surface_pressure', 'shortwave_radiation'], wind_speed_unit: 'ms', timezone: 'GMT',
  })}`)).hourly);

  /* ---------- day-ahead prices (Energinet / Energi Data Service, CC BY 4.0) ---------- */
  api.PRICE_AREAS = ['DK1', 'DK2', 'DE', 'NO1', 'NO2', 'NO3', 'NO4', 'NO5', 'SE1', 'SE2', 'SE3', 'SE4'];
  api.suggestArea = (cc, lon, lat) => {
    if (cc === 'DK') return lon < 11.0 ? 'DK1' : 'DK2';
    if (cc === 'DE') return 'DE';
    if (cc === 'SE') return lat > 65.5 ? 'SE1' : lat > 62 ? 'SE2' : lat > 57.2 ? 'SE3' : 'SE4';
    if (cc === 'NO') return lat > 66 ? 'NO4' : lat > 62.5 ? 'NO3' : lon < 7.5 ? 'NO5' : lat < 59.5 ? 'NO2' : 'NO1';
    return 'manual';
  };
  // Returns Map(utcHourMs -> EUR/MWh). 15-min values (from Oct 2025) are averaged to hourly.
  api.prices = async (area, start, end) => {
    const cut = Date.UTC(2025, 9, 1);
    const sets = [];
    if (start.getTime() < cut) sets.push(['Elspotprices', start, new Date(Math.min(end.getTime() + A.DAY, cut))]);
    if (end.getTime() + A.DAY > cut) sets.push(['DayAheadPrices', new Date(Math.max(start.getTime(), cut)), end]);
    const acc = new Map();
    for (const [ds, s, e] of sets) {
      const url = `https://api.energidataservice.dk/dataset/${ds}?${qs({
        start: A.isoDate(A.addDays(s, -1)) + 'T00:00', end: A.isoDate(A.addDays(e, 2)) + 'T00:00',
        filter: JSON.stringify({ PriceArea: [area] }), sort: 'TimeUTC asc', limit: 0 })}`;
      const j = await getJSON(url);
      const recs = j.records || [];
      if (!recs.length) continue;
      const keys = Object.keys(recs[0]);
      const tKey = keys.find((k) => /^(Time|Hour|Minutes?\d*)UTC$/i.test(k)) || keys.find((k) => /UTC/i.test(k));
      const pKey = keys.find((k) => /(DayAhead|Spot)Price.*EUR/i.test(k)) || keys.find((k) => /EUR/i.test(k));
      if (!tKey || !pKey) throw new Error(`Unexpected price columns: ${keys.join(', ')}`);
      for (const r of recs) {
        if (r[pKey] == null) continue;
        const h = Math.floor(A.parseUTC(r[tKey]) / A.HOUR) * A.HOUR;
        const a = acc.get(h) || [0, 0]; a[0] += +r[pKey]; a[1]++; acc.set(h, a);
      }
    }
    const out = new Map();
    for (const [h, [s, n]] of acc) out.set(h, s / n);
    return out;
  };
})(window.App);
