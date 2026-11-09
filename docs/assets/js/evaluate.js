/* Evaluate & learn: metrics vs measurements, ridge regression with blocked CV, decision-focused learning */
(function (A) {
  'use strict';
  const $ = A.$;
  const E = A.evaluate = {};
  let pending = null;   // measurement series {hours:[], p:[]} from file or demo

  /* ---------- measurements ---------- */
  E.parse = (text, asset) => {
    const rows = A.parseCSV(text);
    if (!rows.length) throw new Error('CSV has no rows');
    const keys = Object.keys(rows[0]);
    const tKey = keys.find((k) => /^(time|timestamp|datetime|date|time_utc)$/i.test(k)) || keys[0];
    const pKey = keys.find((k) => k.toLowerCase() === `${asset}_power_mw`) || keys.find((k) => /^power(_mw)?$/i.test(k))
      || keys.find((k) => new RegExp(asset, 'i').test(k) && /mw|power/i.test(k));
    if (!pKey) throw new Error(`No power column for ${asset}. Expected "${asset}_power_mw" or "power_mw"; found: ${keys.join(', ')}`);
    const acc = new Map();
    for (const r of rows) {
      const s = r[tKey].replace(' ', 'T'); const t = A.parseUTC(s.length === 16 ? s + ':00' : s);
      const v = parseFloat(String(r[pKey]).replace(',', '.'));
      if (!isFinite(t) || !isFinite(v)) continue;
      const h = Math.floor(t / A.HOUR) * A.HOUR, a = acc.get(h) || [0, 0]; a[0] += v; a[1]++; acc.set(h, a);
    }
    const hours = [...acc.keys()].sort((a, b) => a - b);
    if (hours.length < 72) throw new Error('Need at least 72 hourly values');
    return { hours, p: hours.map((h) => acc.get(h)[0] / acc.get(h)[1]), column: pKey };
  };

  /* ---------- metrics ---------- */
  E.metrics = (y, f, cap) => {
    const e = []; y.forEach((v, i) => { if (v != null && f[i] != null) e.push(f[i] - v); });
    const mae = A.mean(e.map(Math.abs)), rmse = Math.sqrt(A.mean(e.map((x) => x * x))), bias = A.mean(e);
    return { mae, rmse, bias, nmae: 100 * mae / cap, nrmse: 100 * rmse / cap, n: e.length };
  };
  E.pinball = (y, q, tau) => A.mean(y.map((v, i) => { const d = v - q[i]; return Math.max(tau * d, (tau - 1) * d); }));

  /* ---------- ridge regression ---------- */
  const design = (x, hrs, cap, deg) => x.map((v, i) => {
    const z = v / cap, row = [];
    for (let k = 1; k <= deg; k++) row.push(z ** k);
    const h = new Date(hrs[i]).getUTCHours();
    row.push(Math.sin(2 * Math.PI * h / 24), Math.cos(2 * Math.PI * h / 24));
    return row;
  });
  // Standardise on the training rows, centre y, solve (XᵀX + λI)β = Xᵀy — λI keeps it invertible
  E.ridgeFit = (X, y, lambda) => {
    const n = X.length, p = X[0].length;
    const mu = Array(p).fill(0), sd = Array(p).fill(0);
    X.forEach((r) => r.forEach((v, j) => { mu[j] += v / n; }));
    X.forEach((r) => r.forEach((v, j) => { sd[j] += (v - mu[j]) ** 2 / n; }));
    for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j]) || 1;
    const ym = A.mean(y);
    const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
    const M = Array.from({ length: p }, (_, a) => Array.from({ length: p }, (_, b) => Z.reduce((s, r) => s + r[a] * r[b], 0) + (a === b ? lambda * n : 0)));
    const rhs = Array.from({ length: p }, (_, a) => Z.reduce((s, r, i) => s + r[a] * (y[i] - ym), 0));
    const beta = A.solve(M, rhs);
    return { predict: (Xn) => Xn.map((r) => ym + r.reduce((s, v, j) => s + beta[j] * (v - mu[j]) / sd[j], 0)), beta };
  };
  E.cvSelect = (x, y, hrs, cap, folds = 5) => {
    const lambdas = A.linspace(-4, 2, 13).map((e) => 10 ** e), degs = [1, 2, 3, 4], n = x.length;
    const curves = {}; let best = { rmse: Infinity };
    for (const deg of degs) {
      const X = design(x, hrs, cap, deg);
      curves[deg] = lambdas.map((lam) => {
        let se = 0, cnt = 0;
        for (let f = 0; f < folds; f++) {          // blocked folds: contiguous chunks, no shuffling
          const a = Math.floor(f * n / folds), b = Math.floor((f + 1) * n / folds);
          const tr = [], te = [];
          for (let i = 0; i < n; i++) (i >= a && i < b ? te : tr).push(i);
          try {
            const m = E.ridgeFit(tr.map((i) => X[i]), tr.map((i) => y[i]), lam);
            const pr = m.predict(te.map((i) => X[i]));
            te.forEach((i, k) => { se += (A.clamp(pr[k], 0, cap) - y[i]) ** 2; cnt++; });
          } catch (e) { se = Infinity; }
        }
        const rmse = Math.sqrt(se / cnt);
        if (rmse < best.rmse) best = { rmse, deg, lam };
        return rmse;
      });
    }
    return { best, curves, lambdas };
  };

  /* ---------- decision-focused learning ---------- */
  // max Σ R(β0+β1x_t, p_t). With λ↑=λD+Δ↑, λ↓=λD−Δ↓ the subgradient wrt q is +Δ↓ (p>q) or −Δ↑ (p<q):
  // DFL with a linear model is therefore linear quantile regression at τ* — the two lectures meet.
  E.dfl = (x, p, lam, dUp, dDown, cap, init) => {
    const n = x.length, xs = x.map((v) => v / cap);
    let b0 = init[0] / cap, b1 = init[1];
    const R = (B0, B1) => { let s = 0; for (let i = 0; i < n; i++) { const q = A.clamp((B0 + B1 * xs[i]) * cap, 0, cap);
      s += lam[i] * q + (lam[i] - dDown) * Math.max(p[i] - q, 0) - (lam[i] + dUp) * Math.max(q - p[i], 0); } return s; };
    let best = [b0, b1, R(b0, b1)];
    for (let it = 1; it <= 4000; it++) {
      let g0 = 0, g1 = 0;
      for (let i = 0; i < n; i++) {
        const q = (b0 + b1 * xs[i]) * cap;
        if (q < 0 || q > cap) continue;              // clipped region: no gradient through the clip
        const g = p[i] > q ? dDown : p[i] < q ? -dUp : 0;
        g0 += g; g1 += g * xs[i];
      }
      const norm = Math.hypot(g0, g1) || 1, step = 0.05 / Math.sqrt(it);
      b0 += step * g0 / norm; b1 += step * g1 / norm;
      if (it % 20 === 0) { const r = R(b0, b1); if (r > best[2]) best = [b0, b1, r]; }
    }
    return { b0: best[0] * cap, b1: best[1], predict: (xn) => xn.map((v) => A.clamp(best[0] * cap + best[1] * v, 0, cap)) };
  };
  const revenue = (q, p, lam, dUp, dDown) => A.sum(q.map((qq, i) => lam[i] * qq + (lam[i] - dDown) * Math.max(p[i] - qq, 0) - (lam[i] + dUp) * Math.max(qq - p[i], 0)));

  /* ---------- run ---------- */
  E.run = async () => {
    const asset = $('evAsset').value;
    if (!pending) {
      const f = $('evFile').files[0];
      if (!f) throw new Error('Choose a measurements CSV first (or click "Make demo file").');
      pending = E.parse(await f.text(), asset);
    }
    const meas = pending;
    const site = A.site, W = A.windCfg(), S = A.solarCfg(), cap = asset === 'wind' ? W.capMW : S.capMW;
    let hours = meas.hours;
    if (hours.length > 24 * 400) { hours = hours.slice(-24 * 366); A.toast('Using the most recent 366 days of measurements', 'info'); }
    const start = new Date(hours[0] - A.DAY), end = new Date(Math.min(hours[hours.length - 1] + A.DAY, A.todayUTC().getTime()));
    A.status('evStatus', `Downloading archived forecasts ${A.isoDate(start)} … ${A.isoDate(end)}…`);
    const models = A.models(), fc = {};
    await Promise.all(models.map(async (m) => {
      try { const wx = await A.api.weather(m, site.lat, site.lon, start, end);
        const pr = A.forecast.toProducts(wx.time, A.physics.convert(wx, site, W, S));
        fc[m] = new Map(pr.hours.map((h, i) => [h, pr[asset][i]])); } catch (e) { A.toast(`${A.api.MODELS[m]}: ${e.message}`, 'warn'); }
    }));
    const ok = Object.keys(fc); if (!ok.length) throw new Error('No archived forecasts available for this period');
    const mIdx = new Map(meas.hours.map((h, i) => [h, meas.p[i]]));
    const rows = hours.filter((h) => ok.every((m) => fc[m].get(h) != null) && mIdx.get(h) != null);
    if (rows.length < 72) throw new Error('Too few overlapping hours between measurements and forecasts');
    const y = rows.map((h) => mIdx.get(h)), xm = rows.map((h) => A.mean(ok.map((m) => fc[m].get(h))));
    const nTest = Math.max(24, Math.round(rows.length * A.clamp(A.num('evTest'), 5, 60) / 100)), nTr = rows.length - nTest;
    const tr = (a) => a.slice(0, nTr), te = (a) => a.slice(nTr);

    // ridge with blocked CV on the training part
    A.status('evStatus', 'Cross-validating ridge models…');
    await new Promise((r) => setTimeout(r, 20));
    const cv = E.cvSelect(tr(xm), tr(y), tr(rows), cap);
    const ridge = E.ridgeFit(design(tr(xm), tr(rows), cap, cv.best.deg), tr(y), cv.best.lam);
    const fRidge = ridge.predict(design(te(xm), te(rows), cap, cv.best.deg)).map((v) => A.clamp(v, 0, cap));
    // OLS (simple linear) and DFL
    const ols = E.ridgeFit(tr(xm).map((v) => [v]), tr(y), 0);
    const olsB1 = ols.predict([[1]])[0] - ols.predict([[0]])[0], olsB0 = ols.predict([[0]])[0];
    const fOls = te(xm).map((v) => A.clamp(olsB0 + olsB1 * v, 0, cap));
    const mk = A.marketCfg();
    const { lam, src } = await A.market.prices(rows);
    const dfl = E.dfl(tr(xm), tr(y), tr(lam), mk.dUp, mk.dDown, cap, [olsB0, olsB1]);
    const fDfl = dfl.predict(te(xm));

    const yT = te(y), lamT = te(lam), tau = A.trading.tauStar(mk.dUp, mk.dDown);
    const cand = [
      ...ok.map((m) => [`${A.api.MODELS[m]} (physical)`, te(rows).map((h) => fc[m].get(h))]),
      ['Multi-model mean (physical)', te(xm)],
      [`OLS linear: ${A.fmt(olsB0, 2)} + ${A.fmt(olsB1, 3)}·x`, fOls],
      [`Ridge, degree ${cv.best.deg}, λ = ${cv.best.lam.toExponential(0)}`, fRidge],
      [`DFL offer: ${A.fmt(dfl.b0, 2)} + ${A.fmt(dfl.b1, 3)}·x`, fDfl],
    ];
    const res = cand.map(([n, f]) => ({ n, f, m: E.metrics(yT, f, cap), rev: revenue(f.map((v) => A.clamp(v, 0, cap)), yT, lamT, mk.dUp, mk.dDown), pin: E.pinball(yT, f, tau) }));
    const bestMae = Math.min(...res.map((r) => r.m.mae)), bestRev = Math.max(...res.map((r) => r.rev));
    A.table($('evTbl'), ['Model', 'MAE (MW)', 'RMSE (MW)', 'Bias (MW)', 'nMAE %', 'nRMSE %', `Pinball τ*=${A.fmt(tau, 2)}`, 'Revenue (€)'],
      res.map((r) => [r.n, (r.m.mae === bestMae ? '<b>' : '') + A.fmt(r.m.mae, 2), A.fmt(r.m.rmse, 2), A.fmt(r.m.bias, 2), A.fmt(r.m.nmae, 1), A.fmt(r.m.nrmse, 1), A.fmt(r.pin, 3),
        (r.rev === bestRev ? '<b>' : '') + A.fmt(r.rev, 0)]));
    const raw = res.find((r) => r.n.startsWith('Multi-model')), rg = res[res.length - 2], df = res[res.length - 1];
    const kpi = (l, v, u, x) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}<span class="u">${u}</span></div><div class="r">${x}</div></div>`;
    $('evKpis').innerHTML =
      kpi('Hours used', rows.length, '', `${nTr} train · ${nTest} test (chronological)`) +
      kpi('Ridge vs raw', A.fmt(100 * (1 - rg.m.rmse / raw.m.rmse), 1), '% RMSE', `nRMSE ${A.fmt(raw.m.nrmse)} → ${A.fmt(rg.m.nrmse)} %`) +
      kpi('DFL vs ridge', (df.rev - rg.rev >= 0 ? '+' : '') + A.fmt(df.rev - rg.rev, 0), '€', 'test-period revenue, same prices') +
      kpi('Prices', '', '', src);

    // charts
    A.chart('cCv', 'line', cv.lambdas.map((l) => l.toExponential(0)), Object.entries(cv.curves).map(([dg, c], i) =>
      ({ label: `degree ${dg}`, data: c, borderColor: A.series(i), borderWidth: +dg === cv.best.deg ? 2.6 : 1.4 })), { zero: false, xtitle: 'λ', unit: 'MW', digits: 3 });
    const sx = te(xm), pts = sx.map((v, i) => ({ x: v, y: yT[i] }));
    const grid = A.linspace(0, cap, 50);
    const hrsMid = Math.round(rows.length / 2);
    const curveR = ridge.predict(design(grid, grid.map(() => rows[hrsMid]), cap, cv.best.deg)).map((v, i) => ({ x: grid[i], y: A.clamp(v, 0, cap) }));
    A.chart('cScatter', 'scatter', undefined, [
      { label: 'Test hours', data: pts, pointRadius: 2, backgroundColor: A.alpha(A.series(0), 0.35), borderWidth: 0 },
      { label: 'Ridge fit', data: curveR, showLine: true, pointRadius: 0, borderColor: A.series(1) },
      { label: 'DFL offer', data: grid.map((g) => ({ x: g, y: A.clamp(dfl.b0 + dfl.b1 * g, 0, cap) })), showLine: true, pointRadius: 0, borderColor: A.series(6), borderDash: [5, 3] },
      { label: 'y = x', data: [{ x: 0, y: 0 }, { x: cap, y: cap }], showLine: true, pointRadius: 0, borderColor: A.css('--text-muted'), borderWidth: 1 },
    ], { xtitle: 'Forecast (multi-model mean), MW', ytitle: 'Measured, MW', unit: 'MW' });
    A.chart('cEvTs', 'line', te(rows).map((h) => A.fmtTime(h)), [
      { label: 'Measured', data: yT, borderColor: A.css('--text-primary'), borderWidth: 1.6 },
      { label: 'Physical mean', data: te(xm), borderColor: A.series(0), borderWidth: 1.2, borderDash: [4, 3] },
      { label: 'Ridge', data: fRidge, borderColor: A.series(1) },
      { label: 'DFL offer', data: fDfl, borderColor: A.series(6), stepped: 'before' },
    ], { unit: 'MW' });
    A.status('evStatus', `Done. CV picked degree ${cv.best.deg}, λ = ${cv.best.lam.toExponential(1)} (CV RMSE ${A.fmt(cv.best.rmse, 2)} MW). Revenue uses Δ↑ = ${mk.dUp}, Δ↓ = ${mk.dDown} €/MWh.`, 'ok');
  };

  // Demo: measurements simulated from the ECMWF archived forecast with bias, noise and AR(1) errors
  E.demo = async () => {
    const asset = $('evAsset').value, site = A.site, W = A.windCfg(), S = A.solarCfg(), cap = asset === 'wind' ? W.capMW : S.capMW;
    const end = A.addDays(A.todayUTC(), -2), start = A.addDays(end, -89);
    A.status('evStatus', 'Building a 90-day demo dataset from archived ECMWF forecasts…');
    const wx = await A.api.weather('ecmwf_ifs025', site.lat, site.lon, start, end);
    const pr = A.forecast.toProducts(wx.time, A.physics.convert(wx, site, W, S));
    const rnd = A.rng(42); const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    let ar = 0;
    const p = pr[asset].map((v) => { ar = 0.85 * ar + 0.5 * gauss();
      return v == null ? null : A.clamp(0.88 * v + 0.07 * cap * ar * (asset === 'solar' ? (v > 0 ? 1 : 0) : 1), 0, cap); });
    pending = { hours: pr.hours.filter((_, i) => p[i] != null), p: p.filter((v) => v != null), column: 'demo' };
    A.csvDownload(`demo_measurements_${asset}.csv`, ['time', `${asset}_power_mw`], pending.hours.map((h, i) => [new Date(h).toISOString().slice(0, 16) + 'Z', pending.p[i].toFixed(3)]));
    A.toast('Demo file created (and downloaded). Running the evaluation on it…', 'info');
    await E.run();
  };

  E.init = () => {
    $('evFile').addEventListener('change', () => { pending = null; });
    $('evAsset').addEventListener('change', () => { pending = null; });
    $('evRun').addEventListener('click', (e) => A.busy(e.target, E.run));
    $('evDemo').addEventListener('click', (e) => A.busy(e.target, E.demo));
  };
})(window.App);
