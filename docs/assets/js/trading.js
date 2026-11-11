/* Day-ahead trading: prices, two-price balancing revenue, newsvendor-optimal offers */
(function (A) {
  'use strict';
  const $ = A.$;
  const M = A.market = {};
  const T = A.trading = {};
  const pcache = new Map();

  // Day-ahead price per delivery hour: Energinet if an area is selected, gaps filled with the
  // average price of the same hour-of-day, otherwise the flat price.
  M.prices = async (hours) => {
    const cfg = A.marketCfg();
    if (cfg.area === 'manual' || !hours.length) return { lam: hours.map(() => cfg.flat), src: `flat ${cfg.flat} €/MWh`, real: 0 };
    const s = new Date(hours[0]), e = new Date(hours[hours.length - 1]);
    const key = `${cfg.area}|${A.isoDate(s)}|${A.isoDate(e)}`;
    let map = pcache.get(key);
    if (!map) {
      try { map = await A.api.prices(cfg.area, s, e); pcache.set(key, map); }
      catch (err) { A.toast(`Price download failed (${err.message}) — using flat price.`, 'warn', 8000); map = new Map(); }
    }
    const byHod = Array.from({ length: 24 }, () => []);
    for (const [h, p] of map) byHod[new Date(h).getUTCHours()].push(p);
    const hodMean = byHod.map((a) => A.mean(a));
    let real = 0;
    const lam = hours.map((h) => {
      if (map.has(h)) { real++; return map.get(h); }
      return hodMean[new Date(h).getUTCHours()] ?? cfg.flat;
    });
    const src = real === hours.length ? `${cfg.area} day-ahead (Energinet)`
      : real ? `${cfg.area}: ${real}/${hours.length} h published, rest = hourly profile of published days`
        : `${cfg.area}: not yet published — ${map.size ? 'hourly profile of recent prices' : 'flat price'}`;
    return { lam, src, real };
  };

  // Lecture revenue function (two-price balancing)
  T.revenue = (q, p, lD, lUp, lDown) => lD * q + lDown * Math.max(p - q, 0) - lUp * Math.max(q - p, 0);
  T.tauStar = (dUp, dDown) => (dUp + dDown) > 0 ? A.clamp(dDown / (dUp + dDown), 0, 1) : 0.5;

  T.run = async () => {
    const d = A.data; if (!d) throw new Error('Run a forecast first (Forecast tab).');
    const asset = $('trAsset').value, cfg = A.marketCfg(), cap = d.cap[asset];
    const { lam, src } = await M.prices(d.hours);
    $('priceSrc').textContent = `€/MWh · ${src}`;
    const tau = T.tauStar(cfg.dUp, cfg.dDown);
    let scen = d.scen[asset];
    if (A.curtail.active()) { const map = await A.curtail.scenarioMapper(asset); scen = scen.map((s, i) => s.map((x) => map(i, x))); }
    const strategies = {
      opt: { name: `Optimal quantile τ* = ${A.fmt(tau, 2)}`, q: [] },
      p50: { name: 'Median forecast (P50)', q: [] },
      mean: { name: 'Mean forecast (MSE-optimal)', q: [] },
      cap: { name: 'Offer full capacity', q: [] },
    };
    const res = Object.fromEntries(Object.keys(strategies).map((k) => [k, 0]));
    let perfect = 0, nH = 0;
    d.hours.forEach((h, i) => {
      const s = scen[i]; const lD = lam[i], lUp = lD + cfg.dUp, lDn = lD - cfg.dDown;
      const qs = { opt: A.quantile(s, tau), p50: A.quantile(s, 0.5), mean: A.mean(s), cap };
      for (const k in qs) strategies[k].q.push(qs[k]);
      if (!s.length) return;
      nH++;
      for (const k in qs) res[k] += A.mean(s.map((p) => T.revenue(qs[k], p, lD, lUp, lDn)));
      perfect += A.mean(s.map((p) => lD * p));
    });
    T.last = { asset, lam, tau, strategies, cfg, cap };

    // KPIs
    const kpi = (l, v, u, r) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}<span class="u">${u}</span></div><div class="r">${r}</div></div>`;
    const gain = res.opt - res.mean;
    $('trKpis').innerHTML =
      kpi('Optimal quantile', 'τ* = ' + A.fmt(tau, 2), '', `(λD−λ↓)/(λ↑−λ↓) = ${cfg.dDown}/(${cfg.dUp}+${cfg.dDown})`) +
      kpi('Expected revenue (τ*)', A.fmt(res.opt, 0), '€', `${nH} delivery hours`) +
      kpi('Gain vs mean forecast', (gain >= 0 ? '+' : '') + A.fmt(gain, 0), '€', `${A.fmt(100 * gain / Math.abs(res.mean || 1), 2)} %`) +
      kpi('Cost of uncertainty', A.fmt(perfect - res.opt, 0), '€', 'vs perfect information');
    if (cfg.dUp === 0 || cfg.dDown === 0)
      A.status('trStatus', cfg.dUp === 0 && cfg.dDown === 0 ? 'Single-price case with λ↑ = λ↓ = λD: revenue does not depend on the offer.'
        : 'One penalty is zero: the revenue curve is flat on one side (lecture scenario 1), so a range of offers is optimal.', '');
    else A.status('trStatus', `Scenarios per hour: ${d.ensUsed.length ? 'ensemble members' : 'deterministic models only (run a future period for ensembles)'}.`, 'ok');

    // charts
    const labels = d.hours.map((h) => A.fmtTime(h));
    const color = asset === 'solar' ? A.series(1) : A.series(0);
    A.chart('cOffer', 'line', labels, [
      ...A.band('Forecast', { p10: scen.map((x) => A.quantile(x, 0.1)), p90: scen.map((x) => A.quantile(x, 0.9)) }, color),
      { label: strategies.opt.name, data: strategies.opt.q, borderColor: A.series(6), borderWidth: 2.6, stepped: 'before' },
      { label: 'P50', data: strategies.p50.q, borderColor: color, borderWidth: 1.4, borderDash: [5, 3], stepped: 'before' },
    ], { unit: 'MW', ytitle: 'MW' });
    A.chart('cPrice', 'line', labels, [
      { label: 'λD day-ahead', data: lam, borderColor: A.series(0), stepped: 'before' },
      { label: 'λ↑ up-regulation', data: lam.map((x) => x + cfg.dUp), borderColor: A.series(7), borderWidth: 1.2, borderDash: [4, 3], stepped: 'before' },
      { label: 'λ↓ down-regulation', data: lam.map((x) => x - cfg.dDown), borderColor: A.series(2), borderWidth: 1.2, borderDash: [4, 3], stepped: 'before' },
    ], { unit: '€/MWh', zero: false });

    const sel = $('trHour');
    const prev = sel.value;
    sel.innerHTML = d.hours.map((h, i) => `<option value="${i}">${A.fmtTime(h)}</option>`).join('');
    const peak = d.q[asset].p50.reduce((b, x, i) => ((x ?? -1) > (d.q[asset].p50[b] ?? -1) ? i : b), 0);
    sel.value = prev && +prev < d.hours.length ? prev : String(peak);
    T.curve();

    const rows = Object.entries(strategies).map(([k, s]) => [s.name, A.fmt(res[k], 0), A.fmt(res[k] - res.opt, 0),
      A.fmt(A.sum(s.q), 0)]);
    rows.push(['Perfect information (upper bound)', A.fmt(perfect, 0), A.fmt(perfect - res.opt, 0), '–']);
    A.table($('trTbl'), ['Strategy', 'Expected revenue (€)', 'Δ vs τ* (€)', 'Energy offered (MWh)'], rows);
    $('trTbl').querySelectorAll('tbody tr')[0]?.querySelectorAll('td').forEach((td) => td.classList.add('best'));
  };

  // E[R(q)] for one hour as a function of the offer
  T.curve = () => {
    const L = T.last, d = A.data; if (!L || !d) return;
    const i = +$('trHour').value, s = d.scen[L.asset][i];
    if (!s?.length) return;
    const lD = L.lam[i], lUp = lD + L.cfg.dUp, lDn = lD - L.cfg.dDown;
    const pts = A.linspace(0, L.cap, 81).map((q) => ({ x: q, y: A.mean(s.map((p) => T.revenue(q, p, lD, lUp, lDn))) }));
    const qo = L.strategies.opt.q[i], qm = L.strategies.mean.q[i];
    const at = (q) => A.mean(s.map((p) => T.revenue(q, p, lD, lUp, lDn)));
    A.chart('cRevCurve', 'scatter', undefined, [
      { label: 'E[R(q)]', data: pts, showLine: true, borderColor: A.series(0), pointRadius: 0 },
      { label: 'τ* offer', data: [{ x: qo, y: at(qo) }], pointRadius: 7, pointHoverRadius: 8, backgroundColor: A.series(6), borderColor: A.css('--surface-1'), borderWidth: 2 },
      { label: 'Mean forecast', data: [{ x: qm, y: at(qm) }], pointRadius: 7, pointHoverRadius: 8, pointStyle: 'rectRot', backgroundColor: A.series(1), borderColor: A.css('--surface-1'), borderWidth: 2 },
    ], { zero: false, xtitle: 'Offer q (MW)', ytitle: '€', unit: '€', digits: 0,
      tooltip: { title: (c) => `q = ${A.fmt(c[0].parsed.x, 1)} MW` } });
    A.charts.cRevCurve.options.interaction = { mode: 'nearest', intersect: false };
    A.charts.cRevCurve.update();
  };

  T.init = () => {
    $('trRun').addEventListener('click', (e) => A.busy(e.target, T.run));
    $('trHour').addEventListener('change', T.curve);
    document.querySelectorAll('[data-scn]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.scn === '1') { $('dUp').value = 0; $('dDown').value = 10; } else { $('dUp').value = 10; $('dDown').value = 10; }
      $('dUp').dispatchEvent(new Event('change', { bubbles: true })); $('dDown').dispatchEvent(new Event('change', { bubbles: true }));
      if (A.data) A.busy($('trRun'), T.run);
    }));
  };
})(window.App);
