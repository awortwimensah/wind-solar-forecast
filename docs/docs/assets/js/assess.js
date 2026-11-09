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
    const eW = A.sum(pr.wind), eS = A.sum(pr.solar), H = pr.hours.length;
    const pairs = cfW.map((w, i) => [w, cfS[i]]).filter(([a, b]) => a != null && b != null);
    const mw = A.mean(pairs.map((p) => p[0])), ms = A.mean(pairs.map((p) => p[1]));
    const corr = A.sum(pairs.map(([a, b]) => (a - mw) * (b - ms))) / Math.sqrt(A.sum(pairs.map(([a]) => (a - mw) ** 2)) * A.sum(pairs.map(([, b]) => (b - ms) ** 2)));
    const kpi = (l, v, u, x) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}<span class="u">${u}</span></div><div class="r">${x}</div></div>`;
    $('asKpis').innerHTML =
      kpi('Wind capacity factor', A.fmt(100 * eW / (W.capMW * H)), '%', `${A.fmt(eW / 1000, 1)} GWh/yr · ${A.fmt(eW / W.capMW, 0)} full-load h`) +
      kpi('Solar capacity factor', A.fmt(100 * eS / (Sc.capMW * H)), '%', `${A.fmt(eS / 1000, 1)} GWh/yr · ${A.fmt(eS / (Sc.kwp / 1000), 0)} kWh/kWp`) +
      kpi('Mean hub wind speed', A.fmt(A.mean(pr.ws), 2), 'm/s', `at ${W.hub} m (ERA5)`) +
      kpi('Wind–solar correlation', A.fmt(corr, 2), '', corr < 0 ? 'complementary profiles' : 'co-varying profiles');

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
  };
})(window.App);
