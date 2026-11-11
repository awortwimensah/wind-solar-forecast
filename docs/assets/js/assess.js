/* Site assessment: ERA5 year -> capacity factors -> k-means representative days */
(function (A) {
  'use strict';
  const $ = A.$;
  const S = A.assess = {};

  // k-means++ with restarts (seeded, reproducible)
  S.kmeans = (X, k, { restarts = 8, iters = 100, seed = 7 } = {}) => {
    const n = X.length, d = X[0].length, rnd = A.rng(seed);
    const dist2 = (a, b) => { let s = 0; for (let j = 0; j < d; j++) s += (a[j] - b[j]) ** 2; return s; };
    let best = null;
    for (let r = 0; r < restarts; r++) {
      const C = [X[Math.floor(rnd() * n)].slice()];
      while (C.length < k) {                         // k-means++ seeding
        const D = X.map((x) => Math.min(...C.map((c) => dist2(x, c)))), tot = A.sum(D);
        let u = rnd() * tot, i = 0; while (i < n - 1 && (u -= D[i]) > 0) i++;
        C.push(X[i].slice());
      }
      let lab = new Array(n).fill(-1);
      for (let it = 0; it < iters; it++) {
        let moved = false;
        for (let i = 0; i < n; i++) {                 // assignment step
          let bj = 0, bd = Infinity;
          for (let j = 0; j < k; j++) { const dd = dist2(X[i], C[j]); if (dd < bd) { bd = dd; bj = j; } }
          if (lab[i] !== bj) { lab[i] = bj; moved = true; }
        }
        for (let j = 0; j < k; j++) {                 // update step: centroid = cluster mean
          const m = X.filter((_, i) => lab[i] === j);
          if (m.length) for (let t = 0; t < d; t++) C[j][t] = A.mean(m.map((x) => x[t]));
        }
        if (!moved) break;
      }
      const inertia = A.sum(X.map((x, i) => dist2(x, C[lab[i]])));
      if (!best || inertia < best.inertia) best = { C, lab, inertia };
    }
    return best;
  };

  /* ---------- power curve, Weibull and AEP ---------- */
  const gammaFn = (z) => {   // Lanczos approximation
    const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
    z -= 1; let x = c[0]; for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5; return Math.sqrt(2 * Math.PI) * t ** (z + 0.5) * Math.exp(-t) * x;
  };
  S.weibull = (ws) => {        // method of moments (Justus): k = (σ/μ)^−1.086, c = μ / Γ(1 + 1/k)
    const v = ws.filter((x) => x != null), mu = A.mean(v), sd = Math.sqrt(A.mean(v.map((x) => (x - mu) ** 2)));
    const k = (sd / mu) ** -1.086; return { k, c: mu / gammaFn(1 + 1 / k), mu };
  };
  S.wpdf = (v, k, c) => (v <= 0 ? 0 : (k / c) * (v / c) ** (k - 1) * Math.exp(-((v / c) ** k)));
  S.aepWeibull = (W, k, c, rho) => {   // MWh/yr for the farm, net of farm losses
    let e = 0; const dv = 0.1;
    for (let v = dv / 2; v < 40; v += dv) e += A.physics.windPower(v, rho, W) * S.wpdf(v, k, c) * dv;
    return e * 8766;
  };
  function powerCurveSection(pr, wx, W) {
    const rhoSite = A.mean(wx.time.map((_, i) => A.physics.airDensity(wx.surface_pressure?.[i], wx.temperature_2m?.[i], W.hub)));
    const vs = A.linspace(0, Math.min(30, W.vcut + 3), 61);
    const perTurbine = (rho) => vs.map((v) => ({ x: v, y: A.physics.windPower(v, rho, W) * 1000 / W.n / (1 - W.loss / 100) }));
    A.chart('cPc', 'scatter', undefined, [
      { label: `${W.custom ? 'Manufacturer' : 'Generic'} curve at 1.225 kg/m³`, data: perTurbine(1.225), showLine: true, pointRadius: 0, borderColor: A.series(0) },
      { label: `At site mean density ${A.fmt(rhoSite, 3)} kg/m³`, data: perTurbine(rhoSite), showLine: true, pointRadius: 0, borderColor: A.series(1), borderDash: [5, 3] },
    ], { xtitle: 'Hub-height wind speed (m/s)', ytitle: 'kW per turbine', unit: 'kW', digits: 0, tooltip: { title: (c) => `${A.fmt(c[0].parsed.x, 1)} m/s` } });
    A.charts.cPc.options.interaction = { mode: 'nearest', intersect: false, axis: 'x' }; A.charts.cPc.update();
    const wb = S.weibull(pr.ws), bins = Array.from({ length: 30 }, (_, i) => i);
    const valid = pr.ws.filter((v) => v != null), hist = bins.map((b) => 100 * valid.filter((v) => v >= b && v < b + 1).length / valid.length);
    A.chart('cWdist', 'bar', bins.map((b) => `${b}–${b + 1}`), [
      { label: 'ERA5 hours', data: hist, backgroundColor: A.alpha(A.series(0), 0.55), barPercentage: 1, categoryPercentage: 0.95 },
      { label: `Weibull k = ${A.fmt(wb.k, 2)}, c = ${A.fmt(wb.c, 2)} m/s`, data: bins.map((b) => 100 * S.wpdf(b + 0.5, wb.k, wb.c)), type: 'line', borderColor: A.series(1), pointRadius: 0 },
    ], { unit: '%', xtitle: 'm/s', xticks: 15 });
    const gross = A.sum(pr.wind) / (1 - W.loss / 100), net = A.sum(pr.wind), weib = S.aepWeibull(W, wb.k, wb.c, rhoSite);
    S.pc = { wb, rhoSite, gross, net, weib };
    const inst = W.ratedKW * W.n / 1000;   // installed MW (before losses)
    const row = (n, e) => [n, A.fmt(e, 0), A.fmt(e / inst, 0), A.fmt(100 * e / (inst * 8760), 1) + ' %'];
    A.table($('aepTbl'), ['AEP estimate', 'MWh / year', 'Full-load hours', 'Capacity factor'], [
      row('Gross (time series, no losses)', gross), row(`Net (time series, −${W.loss} % losses)`, net), row('Net (Weibull × power curve)', weib)]);
  }
  // Long-term P50/P90 from inter-annual variability of several ERA5 years + other uncertainties
  S.longTerm = async () => {
    const site = A.site, W = A.windCfg(), Sc = A.solarCfg(), y0 = +$('asYear').value, n = A.clamp(Math.round(A.num('aepYears')), 3, 10);
    const other = A.num('aepUnc') / 100, years = Array.from({ length: n }, (_, i) => y0 - i);
    const res = [];
    for (const y of years) {
      A.status('asStatus', `Downloading ERA5 ${y} (${res.length + 1}/${n})…`);
      const wx = await A.api.archive(site.lat, site.lon, new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 11, 31)));
      const pr = A.forecast.toProducts(wx.time, A.physics.convert(wx, site, W, Sc));
      res.push({ y, e: A.sum(pr.wind) * 8760 / pr.hours.length, ws: A.mean(pr.ws) });
    }
    const es = res.map((r) => r.e), p50 = A.mean(es), sdY = Math.sqrt(A.sum(es.map((e) => (e - p50) ** 2)) / (es.length - 1));
    // σ of the long-term mean (n years) + future variability over the averaging period + other (model, losses, ...)
    const r = sdY / p50, sLt = r / Math.sqrt(es.length);
    const s10 = Math.sqrt(sLt ** 2 + (r / Math.sqrt(10)) ** 2 + other ** 2), s1 = Math.sqrt(sLt ** 2 + r ** 2 + other ** 2);
    const p90 = p50 * (1 - 1.2816 * s10), p90_1y = p50 * (1 - 1.2816 * s1);
    A.chart('cAep', 'bar', res.map((r) => String(r.y)).reverse(), [
      { label: 'Net AEP (ERA5 year)', data: res.map((r) => r.e).reverse(), backgroundColor: A.series(0) },
    ], { unit: 'MWh', digits: 0 });
    $('aepLt').innerHTML = `<b>P50 ${A.fmt(p50, 0)} MWh/yr</b> · P90 (10-yr) ${A.fmt(p90, 0)} · P90 (1-yr) ${A.fmt(p90_1y, 0)} MWh/yr · inter-annual σ ${A.fmt(100 * sdY / p50, 1)} % · other uncertainty ${A.fmt(100 * other, 1)} %`;
    A.status('asStatus', `Long-term estimate from ${n} ERA5 years. P90 = P50·(1 − 1.282·σ); the 1-year P90 adds inter-annual variability.`, 'ok');
  };

  S.run = async () => {
    const site = A.site, W = A.windCfg(), Sc = A.solarCfg();
    const year = +$('asYear').value, k = A.clamp(Math.round(A.num('asK')), 2, 8);
    A.status('asStatus', `Downloading ERA5 ${year} for ${site.name}…`);
    const wx = await A.api.archive(site.lat, site.lon, new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year, 11, 31)));
    const pr = A.forecast.toProducts(wx.time, A.physics.convert(wx, site, W, Sc));
    const cfW = pr.wind.map((v) => (v == null ? null : v / W.capMW)), cfS = pr.solar.map((v) => (v == null ? null : v / Sc.capMW));

    // daily 48-vectors in site-local time
    const days = new Map();
    pr.hours.forEach((h, i) => {
      const key = A.localDay(h), hr = A.localHour(h);
      if (!days.has(key)) days.set(key, { w: Array(24).fill(null), s: Array(24).fill(null) });
      const o = days.get(key); o.w[hr] = cfW[i]; o.s[hr] = cfS[i];
    });
    const keys = [...days.keys()].filter((k_) => k_.startsWith(String(year)) && days.get(k_).w.filter((v) => v != null).length >= 22);
    const fill = (a) => { const m = A.mean(a) ?? 0; return a.map((v) => v ?? m); };
    const X = keys.map((k_) => [...fill(days.get(k_).w), ...fill(days.get(k_).s)]);
    if (X.length < 60) throw new Error('Not enough ERA5 data for this year/site');

    A.status('asStatus', 'Clustering…'); await new Promise((r) => setTimeout(r, 20));
    const km = S.kmeans(X, k);
    const elbow = Array.from({ length: 10 }, (_, i) => S.kmeans(X, i + 1, { restarts: 4 }).inertia);

    // KPIs
    powerCurveSection(pr, wx, W);
    const eW = A.sum(pr.wind), eS = A.sum(pr.solar), H = pr.hours.length;
    const pairs = cfW.map((w, i) => [w, cfS[i]]).filter(([a, b]) => a != null && b != null);
    const mw = A.mean(pairs.map((p) => p[0])), ms = A.mean(pairs.map((p) => p[1]));
    const corr = A.sum(pairs.map(([a, b]) => (a - mw) * (b - ms))) / Math.sqrt(A.sum(pairs.map(([a]) => (a - mw) ** 2)) * A.sum(pairs.map(([, b]) => (b - ms) ** 2)));
    const kpi = (l, v, u, x) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}<span class="u">${u}</span></div><div class="r">${x}</div></div>`;
    $('asKpis').innerHTML =
      kpi('Wind capacity factor', A.fmt(100 * eW / (W.capMW * H)), '%', `${A.fmt(eW / 1000, 1)} GWh/yr · ${A.fmt(eW / W.capMW, 0)} full-load h`) +
      kpi('Solar capacity factor', A.fmt(100 * eS / (Sc.capMW * H)), '%', `${A.fmt(eS / 1000, 1)} GWh/yr · ${A.fmt(eS / (Sc.kwp / 1000), 0)} kWh/kWp`) +
      kpi('Mean hub wind speed', A.fmt(A.mean(pr.ws), 2), 'm/s', `at ${W.hub} m (ERA5)`) +
      kpi('Wind–solar correlation', A.fmt(corr, 2), '', Math.abs(corr) < 0.1 ? 'largely independent' : corr < 0 ? 'complementary profiles' : 'co-varying profiles');

    // monthly CF
    const mon = Array.from({ length: 12 }, () => ({ w: [], s: [] }));
    pr.hours.forEach((h, i) => { const m = new Date(h).getUTCMonth(); mon[m].w.push(cfW[i]); mon[m].s.push(cfS[i]); });
    const mNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    A.chart('cMonthly', 'bar', mNames, [
      { label: 'Wind', data: mon.map((m) => 100 * (A.mean(m.w) ?? 0)), backgroundColor: A.series(0), barPercentage: 0.85, categoryPercentage: 0.8 },
      { label: 'Solar', data: mon.map((m) => 100 * (A.mean(m.s) ?? 0)), backgroundColor: A.series(1), barPercentage: 0.85, categoryPercentage: 0.8 },
    ], { unit: '%' });
    A.chart('cElbow', 'line', elbow.map((_, i) => i + 1), [{ label: 'Inertia', data: elbow, borderColor: A.series(6), pointRadius: elbow.map((_, i) => (i + 1 === k ? 6 : 3)), pointBackgroundColor: A.series(6) }],
      { xtitle: 'k', digits: 1 });

    // representative days (centroids) weighted by days represented
    const size = Array(k).fill(0); km.lab.forEach((l) => size[l]++);
    const order = size.map((s, j) => j).sort((a, b) => size[b] - size[a]);
    const hrs = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
    const dsFor = (off) => order.map((j, r) => ({ label: `Day ${r + 1} (${size[j]} d)`, data: km.C[j].slice(off, off + 24).map((v) => 100 * v), borderColor: A.series(r), borderWidth: 2 }));
    A.chart('cRepW', 'line', hrs, dsFor(0), { unit: '%', y: { max: 100 } });
    A.chart('cRepS', 'line', hrs, dsFor(24), { unit: '%', y: { max: 100 } });

    // duration curve: full year vs weighted representative days
    const full = cfW.filter((v) => v != null).sort((a, b) => b - a);
    const rep = []; order.forEach((j) => { for (let c = 0; c < size[j]; c++) rep.push(...km.C[j].slice(0, 24)); });
    rep.sort((a, b) => b - a);
    const pct = A.linspace(0, 100, 101);
    const pick = (arr) => pct.map((p) => 100 * arr[Math.min(arr.length - 1, Math.round(p / 100 * (arr.length - 1)))]);
    const fullC = pick(full), repC = pick(rep);
    A.chart('cDur', 'line', pct.map((p) => p + '%'), [
      { label: 'Full year (hourly)', data: fullC, borderColor: A.series(0) },
      { label: `${k} representative days`, data: repC, borderColor: A.series(1), borderDash: [5, 3] },
    ], { unit: '% CF', xtitle: 'share of hours exceeding' });
    const rmse = Math.sqrt(A.mean(fullC.map((v, i) => (v - repC[i]) ** 2)));

    const monthsOf = (j) => { const c = Array(12).fill(0); km.lab.forEach((l, i) => { if (l === j) c[+keys[i].slice(5, 7) - 1]++; });
      return c.map((v, m) => [v, mNames[m]]).sort((a, b) => b[0] - a[0]).slice(0, 3).filter((x) => x[0]).map((x) => x[1]).join(', '); };
    A.table($('asTbl'), ['Representative day', 'Days', 'Weight', 'Wind CF', 'Solar CF', 'Mostly in'],
      order.map((j, r) => [`<span style="color:${A.series(r)}">●</span> Day ${r + 1}`, size[j], A.fmt(100 * size[j] / X.length, 1) + ' %',
        A.fmt(100 * A.mean(km.C[j].slice(0, 24)), 1) + ' %', A.fmt(100 * A.mean(km.C[j].slice(24)), 1) + ' %', monthsOf(j)]));
    A.status('asStatus', `${X.length} days → ${k} representative days. Duration-curve RMSE ${A.fmt(rmse, 1)} %-points. Note: centroids average out extremes, and chronology between days is lost.`, 'ok');
  };

  S.init = () => {
    const y = new Date().getUTCFullYear();
    $('asYear').innerHTML = Array.from({ length: 6 }, (_, i) => y - 1 - i).map((v) => `<option>${v}</option>`).join('');
    $('asRun').addEventListener('click', (e) => A.busy(e.target, S.run));
    $('aepRun').addEventListener('click', (e) => A.busy(e.target, S.longTerm));
  };
})(window.App);
