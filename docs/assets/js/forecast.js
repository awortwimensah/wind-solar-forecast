/* Forecast tab: download models + ensembles, convert to power, quantiles, charts */
(function (A) {
  'use strict';
  const $ = A.$;
  const F = A.forecast = {};

  // Instantaneous/preceding-hour-mean series -> hourly delivery products [h, h+1)
  A.EXTRAS = ['shortwave_radiation', 'wind_gusts_10m', 'temperature_2m', 'relative_humidity_2m', 'cloud_cover', 'precipitation', 'snowfall', 'snow_depth', 'visibility', 'cape', 'weather_code'];
  function toProducts(time, conv, wx) {
    const out = { hours: [], ws: [], wind: [], solar: [], wx: {} };
    const ex = wx ? A.EXTRAS.filter((k) => wx[k]) : [];
    ex.forEach((k) => { out.wx[k] = []; });
    const avg = (a, b) => (a == null || b == null ? (a ?? b) : (a + b) / 2);
    for (let i = 0; i + 1 < time.length; i++) {
      if (time[i + 1] - time[i] !== A.HOUR) continue;
      out.hours.push(time[i]);
      out.ws.push(avg(conv.ws[i], conv.ws[i + 1]));
      out.wind.push(avg(conv.wind[i], conv.wind[i + 1]));
      out.solar.push(conv.solar[i + 1]);
      ex.forEach((k) => out.wx[k].push(wx[k][i + 1]));   // end-of-hour value (accumulations cover the hour)
    }
    return out;
  }
  F.toProducts = toProducts;

  F.run = async () => {
    const site = A.site, W = A.windCfg(), S = A.solarCfg(), models = A.models();
    if (!models.length) throw new Error('Select at least one weather model');
    const { start, end } = A.period();
    const reqEnd = new Date(Math.min(A.addDays(end, 1).getTime(), A.addDays(A.todayUTC(), 15).getTime()));
    const reqStart = A.addDays(start, -1);
    const inPeriod = (ms) => { const d = A.localDay(ms); return d >= A.isoDate(start) && d <= A.isoDate(end); };
    A.status('runStatus', `Downloading ${models.length} models…`);

    // deterministic models in parallel
    const det = {}, warn = [];
    await Promise.all(models.map(async (m) => {
      try {
        const wx = await A.api.weather(m, site.lat, site.lon, reqStart, reqEnd);
        det[m] = toProducts(wx.time, A.physics.convert(wx, site, W, S), wx);
      } catch (e) { warn.push(`${A.api.MODELS[m]}: ${e.message}`); }
    }));
    const okModels = models.filter((m) => det[m]);
    if (!okModels.length) throw new Error('No model data: ' + warn.join('; '));

    // common hour axis restricted to the selected local days
    const hours = det[okModels[0]].hours.filter(inPeriod);
    const idx = new Map(hours.map((h, i) => [h, i]));
    const align = (p, key) => { const a = new Array(hours.length).fill(null); p.hours.forEach((h, i) => { if (idx.has(h)) a[idx.get(h)] = p[key][i]; }); return a; };
    const D = {};
    const alignWx = (p, k) => { const a = new Array(hours.length).fill(null); p.hours.forEach((h, i) => { if (idx.has(h)) a[idx.get(h)] = p.wx[k][i]; }); return a; };
    for (const m of okModels) {
      D[m] = { ws: align(det[m], 'ws'), wind: align(det[m], 'wind'), solar: align(det[m], 'solar'), wx: {} };
      for (const k in det[m].wx) D[m].wx[k] = alignWx(det[m], k);
    }

    // ensembles
    const members = { wind: [], solar: [], ws: [], gust: [] }, ensUsed = [];
    const ens = A.ensembles();
    if (ens.length && end >= A.todayUTC()) {
      A.status('runStatus', 'Downloading ensembles…');
      await Promise.all(ens.map(async (m) => {
        try {
          const list = await A.api.ensemble(m, site.lat, site.lon, reqStart, reqEnd);
          for (const mem of list) {
            const p = toProducts(mem.time, A.physics.convert(mem, site, W, S), mem);
            members.wind.push(align(p, 'wind')); members.solar.push(align(p, 'solar')); members.ws.push(align(p, 'ws'));
            if (p.wx.wind_gusts_10m) members.gust.push(alignWx(p, 'wind_gusts_10m'));
          }
          if (list.length) ensUsed.push(`${A.api.ENSEMBLES[m]} (${list.length})`);
        } catch (e) { warn.push(`${A.api.ENSEMBLES[m]}: ${e.message}`); }
      }));
    }
    members.hybrid = members.wind.map((w, k) => w.map((x, i) => (x == null || members.solar[k][i] == null ? null : x + members.solar[k][i])));

    // scenario sets per hour: ensemble members where available, otherwise deterministic models
    const detSet = (key) => okModels.map((m) => key === 'hybrid' ? D[m].wind.map((x, i) => (x == null || D[m].solar[i] == null ? null : x + D[m].solar[i])) : D[m][key]);
    const scen = {}, q = {};
    for (const key of ['wind', 'solar', 'hybrid']) {
      const ensK = members[key], detK = detSet(key);
      scen[key] = hours.map((_, i) => {
        const e = ensK.map((m) => m[i]).filter((x) => x != null);
        return e.length >= 5 ? e : detK.map((m) => m[i]).filter((x) => x != null);
      });
      q[key] = { p10: scen[key].map((s) => A.quantile(s, 0.1)), p50: scen[key].map((s) => A.quantile(s, 0.5)), p90: scen[key].map((s) => A.quantile(s, 0.9)),
        mean: scen[key].map((s) => A.mean(s)), det: hours.map((_, i) => A.mean(detK.map((m) => m[i]))) };
    }
    A.data = { hours, det: D, models: okModels, scen, q, members, ensUsed, cap: { wind: W.capMW, solar: S.capMW, hybrid: W.capMW + S.capMW }, W, S, warn };
    F.render();
    const msg = `${hours.length} h · ${okModels.length} models${ensUsed.length ? ' · ensembles: ' + ensUsed.join(', ') : ' · no ensembles (P10–P90 = model spread)'}`;
    A.status('runStatus', msg, 'ok');
    if (warn.length) A.toast('Some sources were unavailable: ' + warn.join(' | '), 'warn', 9000);
    document.dispatchEvent(new CustomEvent('forecast:ready'));
  };

  F.daily = (key) => {
    const d = A.data, days = new Map();
    d.hours.forEach((h, i) => { const k = A.localDay(h); if (!days.has(k)) days.set(k, []); days.get(k).push(i); });
    const ensK = d.members[key]?.length >= 5 ? d.members[key] : null;
    return [...days.entries()].map(([day, ix]) => {
      const p50 = A.sum(ix.map((i) => d.q[key].p50[i]));
      let p10 = A.sum(ix.map((i) => d.q[key].p10[i])), p90 = A.sum(ix.map((i) => d.q[key].p90[i]));
      if (ensK) { const sums = ensK.map((m) => A.sum(ix.map((i) => m[i]))); p10 = A.quantile(sums, 0.1); p90 = A.quantile(sums, 0.9); }
      return { day, hours: ix.length, p50, p10, p90 };
    });
  };

  F.render = () => {
    const d = A.data; if (!d) return;
    $('emptyState').hidden = true;
    const labels = d.hours.map((h) => A.fmtTime(h));
    const wantLines = (key) => d.models.map((m, i) => ({ label: A.api.MODELS[m], data: d.det[m][key], borderColor: A.series(i + 2), borderWidth: 1.2, borderDash: [4, 3] }));
    const main = (key, color) => [
      ...A.band(key === 'wind' ? 'Wind' : 'Solar', d.q[key], color),
      { label: 'P50 (best estimate)', data: d.q[key].p50, borderColor: color, borderWidth: 2.6 },
      ...wantLines(key),
    ];
    A.chart('cWind', 'line', labels, main('wind', A.series(0)), { unit: 'MW', ytitle: 'MW' });
    A.chart('cSolar', 'line', labels, main('solar', A.series(1)), { unit: 'MW', ytitle: 'MW' });
    A.chart('cWs', 'line', labels, d.models.map((m, i) => ({ label: A.api.MODELS[m], data: d.det[m].ws, borderColor: A.series(i + 2) })), { unit: 'm/s' });

    const dw = F.daily('wind'), ds = F.daily('solar');
    A.table($('dailyTbl'), ['Day', 'Wind P50', 'P10–P90', 'Solar P50', 'P10–P90', 'Total'],
      dw.map((r, i) => [r.day, A.fmt(r.p50), `${A.fmt(r.p10, 0)}–${A.fmt(r.p90, 0)}`, A.fmt(ds[i].p50), `${A.fmt(ds[i].p10, 0)}–${A.fmt(ds[i].p90, 0)}`, A.fmt(r.p50 + ds[i].p50)]));

    const H = d.hours.length, eW = A.sum(d.q.wind.p50), eS = A.sum(d.q.solar.p50);
    const peak = d.q.hybrid.p50.reduce((b, x, i) => (x > (d.q.hybrid.p50[b] ?? -1) ? i : b), 0);
    const kpi = (l, v, u, r) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}<span class="u">${u}</span></div><div class="r">${r}</div></div>`;
    $('fcKpis').innerHTML =
      kpi('Wind energy', A.fmt(eW, 0), 'MWh', `CF ${A.fmt(100 * eW / (d.cap.wind * H))} % · ${A.fmt(d.cap.wind)} MW`) +
      kpi('Solar energy', A.fmt(eS, 0), 'MWh', `CF ${A.fmt(100 * eS / (d.cap.solar * H))} % · ${A.fmt(d.cap.solar)} MW AC`) +
      kpi('Peak hybrid output', A.fmt(d.q.hybrid.p50[peak]), 'MW', A.fmtTime(d.hours[peak])) +
      kpi('Uncertainty (wind)', A.fmt(A.mean(d.q.wind.p90.map((x, i) => x - d.q.wind.p10[i]))), 'MW', 'mean P90 − P10 width') +
      kpi('Scenarios', d.ensUsed.length ? A.sum(d.members.wind.map(() => 1)) : d.models.length, '', d.ensUsed.length ? 'ensemble members' : 'deterministic models');
  };

  F.csv = () => {
    const d = A.data; if (!d) return A.toast('Run a forecast first', 'warn');
    const head = ['time_utc', 'time_local', ...d.models.flatMap((m) => [`ws_hub_${m}`, `wind_mw_${m}`, `solar_mw_${m}`]),
      'wind_p10', 'wind_p50', 'wind_p90', 'solar_p10', 'solar_p50', 'solar_p90'];
    const f = (x) => (x == null ? '' : x.toFixed(3));
    A.csvDownload(`forecast_${A.site.name.replace(/\W+/g, '_')}.csv`, head, d.hours.map((h, i) => [new Date(h).toISOString(), A.fmtTime(h, { dateStyle: 'short', timeStyle: 'short' }).replace(',', ''),
      ...d.models.flatMap((m) => [f(d.det[m].ws[i]), f(d.det[m].wind[i]), f(d.det[m].solar[i])]),
      f(d.q.wind.p10[i]), f(d.q.wind.p50[i]), f(d.q.wind.p90[i]), f(d.q.solar.p10[i]), f(d.q.solar.p50[i]), f(d.q.solar.p90[i])]));
  };
})(window.App);
