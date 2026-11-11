/* Combination forecast: weather-situation-dependent model weighting + short-term correction */
(function (A) {
  'use strict';
  const $ = A.$;
  const K = A.combine = {};
  const REG = {
    wind: [{ id: 'low', name: 'Low wind (< 5 m/s)', test: (r) => r.ws < 5 }, { id: 'ramp', name: 'Power-curve slope (5–11 m/s)', test: (r) => r.ws >= 5 && r.ws < 11 },
      { id: 'high', name: 'High wind (≥ 11 m/s)', test: (r) => r.ws >= 11 }],
    solar: [{ id: 'clear', name: 'Clear sky (k ≥ 0.7)', test: (r) => r.kc >= 0.7 }, { id: 'broken', name: 'Broken clouds (0.35–0.7)', test: (r) => r.kc >= 0.35 && r.kc < 0.7 },
      { id: 'overcast', name: 'Overcast (k < 0.35)', test: (r) => r.kc < 0.35 }],
  };
  const regimeOf = (asset, r) => (asset === 'solar' && !(r.cs > 50) ? 'night' : (REG[asset].find((g) => g.test(r)) || REG[asset][0]).id);
  const colorOf = (m) => A.series(2 + Math.max(0, Object.keys(A.api.MODELS).indexOf(m)));
  let fit = null, training = null;

  // situation descriptors for one hour from all models: mean hub wind, clear-sky index
  const situ = (hour, models, getWs, getGhi) => {
    const ws = A.mean(models.map((m) => getWs(m))), ghi = A.mean(models.map((m) => getGhi(m)));
    const cs = A.clearSkyGHI(hour + A.HOUR, A.site.lat, A.site.lon);
    return { ws: ws ?? 0, cs, kc: cs > 50 && ghi != null ? ghi / cs : 0 };
  };
  // cache key: site + asset + reference + models + plant settings that change the power conversion
  const cacheKey = (asset, ref, models) => {
    const W = A.windCfg(), S = A.solarCfg();
    return JSON.stringify([A.site.lat, A.site.lon, asset, ref, [...models].sort(), W.hub, W.n, W.ratedKW, W.loss, S.kwp, S.tilt, S.azi, A.isoDate(A.todayUTC())]);
  };

  function steps() {
    const st = (ok, busy, label) => `<span class="step ${busy ? 'busy' : ok ? 'done' : 'todo'}">${label}</span>`;
    const corr = K.result?.corr;
    $('cbSteps').innerHTML = st(!!A.data, false, '1 · Forecast loaded') + st(!!fit, !!training, '2 · Weights learned') +
      st(!!corr, false, '3 · Short-term correction (optional)');
  }

  K.train = async () => {
    if (training) return training;
    training = (async () => {
      const asset = $('cbAsset').value, srcSel = $('cbRef').value, site = A.site, Wc = A.windCfg(), Sc = A.solarCfg();
      const models = A.models(); if (models.length < 2) throw new Error('Select at least two weather models (sidebar → Weather models) to combine');
      const key = cacheKey(asset, srcSel, models);
      if (srcSel === 'era5') { const c = A.store.get('cbfit', null); if (c && c.key === key) { fit = c.fit; return fit; } }
      steps();
      let truth, start, end, refName;
      if (srcSel === 'meas') {
        const m = A.evaluate.measurements();
        if (!m) throw new Error('No measurements loaded — load a CSV in "Evaluate & learn" first, or choose the ERA5 reference.');
        const off = Math.max(0, m.hours.length - 24 * 180), hrs = m.hours.slice(off);
        truth = new Map(hrs.map((h, i) => [h, m.p[off + i]]));
        start = new Date(hrs[0] - A.DAY); end = new Date(Math.min(hrs[hrs.length - 1] + A.DAY, A.todayUTC().getTime())); refName = 'your measurements';
      } else {
        end = A.addDays(A.todayUTC(), -6); start = A.addDays(end, -59); refName = 'ERA5 reanalysis (proxy)';
        A.status('cbStatus', 'Learning weights: downloading 60 days of ERA5 reference…');
        const wx = await A.api.archive(site.lat, site.lon, start, end);
        const pr = A.forecast.toProducts(wx.time, A.physics.convert(wx, site, Wc, Sc));
        truth = new Map(pr.hours.map((h, i) => [h, pr[asset][i]]));
      }
      A.status('cbStatus', `Learning weights: downloading archived forecasts ${A.isoDate(start)} … ${A.isoDate(end)}…`);
      const fc = {};
      await Promise.all(models.map(async (m) => {
        try { const wx = await A.api.weather(m, site.lat, site.lon, start, end);
          const pr = A.forecast.toProducts(wx.time, A.physics.convert(wx, site, Wc, Sc), wx);
          fc[m] = new Map(pr.hours.map((h, i) => [h, { p: pr[asset][i], ws: pr.ws[i], ghi: pr.wx.shortwave_radiation?.[i] }])); }
        catch (e) { console.warn(m, e); }
      }));
      const ok = Object.keys(fc); if (ok.length < 2) throw new Error('Fewer than two models have archived forecasts for this period');
      const rows = [...truth.keys()].sort((a, b) => a - b).filter((h) => truth.get(h) != null && ok.every((m) => fc[m].get(h)?.p != null))
        .map((h) => { const s = situ(h, ok, (m) => fc[m].get(h).ws, (m) => fc[m].get(h).ghi);
          return { h, y: truth.get(h), x: Object.fromEntries(ok.map((m) => [m, fc[m].get(h).p])), ...s, reg: null }; });
      rows.forEach((r) => { r.reg = regimeOf(asset, r); });
      const use = rows.filter((r) => r.reg !== 'night');
      if (use.length < 96) throw new Error(`Only ${use.length} overlapping hours — need at least 96 to learn weights`);
      const nTr = Math.floor(use.length * 0.7), tr = use.slice(0, nTr), te = use.slice(nTr);

      // weights ∝ (1/MSE)^p, globally and per weather situation (fallback to global if < 24 h).
      // The sharpness p is chosen on an inner hold-out (last 25 % of training): p = 0 is equal weights,
      // large p approaches "pick the best model" — so the data decide how strongly to favour the best model.
      const invMse = (set, p) => { const w = {}; ok.forEach((m) => { const mse = A.mean(set.map((r) => (r.x[m] - r.y) ** 2)) || 1e-9; w[m] = Math.max(mse, 1e-9) ** -p; });
        const s = A.sum(Object.values(w)); ok.forEach((m) => { w[m] /= s; }); return w; };
      const fitW = (set, p) => { const g = invMse(set, p), W = {}, C = {};
        for (const rg of REG[asset]) { const sub = set.filter((r) => r.reg === rg.id); C[rg.id] = sub.length; W[rg.id] = sub.length >= 24 ? invMse(sub, p) : g; }
        return { g, W, C }; };
      const combW = (r, w) => A.sum(ok.map((m) => w[m] * r.x[m]));
      const nIn = Math.floor(tr.length * 0.75), inTr = tr.slice(0, nIn), inVa = tr.slice(nIn);
      let bestP = 1, bestR = Infinity; const pScan = [];
      for (const p of [0, 0.5, 1, 2, 4, 8]) {
        const f = fitW(inTr, p), r = Math.sqrt(A.mean(inVa.map((x) => (combW(x, f.W[x.reg]) - x.y) ** 2)));
        pScan.push([p, r]); if (r < bestR - 1e-9) { bestR = r; bestP = p; }
      }
      const F = fitW(tr, bestP), global = F.g, weights = F.W, counts = F.C;
      const comb = (r, w) => A.sum(ok.map((m) => w[m] * r.x[m]));
      const allE = tr.map((r) => r.y - comb(r, global));
      const unc = {};
      for (const g of REG[asset]) { const e = tr.filter((r) => r.reg === g.id).map((r) => r.y - comb(r, weights[g.id]));
        const src = e.length >= 24 ? e : allE; unc[g.id] = { q10: A.quantile(src, 0.1), q90: A.quantile(src, 0.9) }; }
      const rmse = (f) => Math.sqrt(A.mean(te.map((r) => (f(r) - r.y) ** 2)));
      const cap = asset === 'wind' ? Wc.capMW : Sc.capMW;
      const skill = [...ok.map((m) => [A.api.MODELS[m], rmse((r) => r.x[m])]),
        ['Equal-weight mean', rmse((r) => A.mean(ok.map((m) => r.x[m])))],
        ['Inverse-MSE weights (global, p = 1)', rmse((r) => comb(r, invMse(tr, 1)))],
        [`Situation-dependent weights (p = ${bestP})`, rmse((r) => comb(r, weights[r.reg]))]];
      const cover = A.mean(te.map((r) => { const c = comb(r, weights[r.reg]), u = unc[r.reg]; return r.y >= c + u.q10 && r.y <= c + u.q90 ? 1 : 0; }));
      fit = { asset, models: ok, weights, global, unc, counts, cap, refName, skill, cover, nTr, nTe: te.length, p: bestP, pScan, period: `${A.isoDate(start)} … ${A.isoDate(end)}` };
      if (srcSel === 'era5') A.store.set('cbfit', { key, fit });
      K.truth = srcSel === 'meas' ? truth : null;
      return fit;
    })();
    try { return await training; } finally { training = null; steps(); }
  };

  function renderFit() {
    const f = fit; if (!f) return;
    const singles = f.skill.slice(0, f.models.length).map((s) => s[1]), bestSingle = Math.min(...singles), best = Math.min(...f.skill.map((s) => s[1]));
    const regs = REG[f.asset];
    A.table($('cbWeights'), ['Weather situation', 'Training h', ...f.models.map((m) => A.api.MODELS[m]), 'Error band P10…P90 (MW)'],
      regs.map((g) => [g.name, f.counts[g.id] + (f.counts[g.id] < 24 ? ' (uses global)' : ''), ...f.models.map((m) => A.fmt(100 * f.weights[g.id][m], 0) + ' %'),
        `${A.fmt(f.unc[g.id].q10, 1)} … +${A.fmt(f.unc[g.id].q90, 1)}`]));
    A.table($('cbSkill'), ['Forecast', 'RMSE (MW)', 'nRMSE %', 'vs best single model'],
      f.skill.map(([n, v]) => [(v === best ? '<b>' : '') + n, A.fmt(v, 2), A.fmt(100 * v / f.cap, 1), (v <= bestSingle ? '' : '+') + A.fmt(100 * (v / bestSingle - 1), 1) + ' %']));
    $('cbSkillEmpty').textContent = `Trained on ${f.nTr} h, tested on ${f.nTe} h (${f.period}) against ${f.refName}.`;
    $('cbWEmpty').hidden = true;
    A.chart('cCbW', 'bar', regs.map((g) => g.name.replace(/ \(.*/, '')), f.models.map((m) => ({
      label: A.api.MODELS[m], data: regs.map((g) => 100 * f.weights[g.id][m]), backgroundColor: colorOf(m), borderColor: A.css('--surface-1'), borderWidth: 2,
      barPercentage: 0.7, categoryPercentage: 0.9 })), { stacked: true, unit: '%', digits: 0, y: { max: 100 } });
    const combo = f.skill[f.skill.length - 1][1], eq = f.skill[f.models.length][1];
    const kpi = (l, v, u, x) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}<span class="u">${u}</span></div><div class="r">${x}</div></div>`;
    $('cbKpis').innerHTML =
      kpi('Combination RMSE', A.fmt(combo, 2), 'MW', `nRMSE ${A.fmt(100 * combo / f.cap, 1)} % on test hours`) +
      kpi('vs best single model', (combo <= bestSingle ? '−' : '+') + A.fmt(Math.abs(100 * (1 - combo / bestSingle)), 1), '%', f.skill[singles.indexOf(bestSingle)][0]) +
      kpi('vs equal weights', (combo <= eq ? '−' : '+') + A.fmt(Math.abs(100 * (1 - combo / eq)), 1), '%', 'simple model average') +
      kpi('Band coverage', A.fmt(100 * f.cover, 0), '%', 'P10–P90 on test, ideal 80 %') +
      kpi('Weight sharpness', 'p = ' + f.p, '', f.p === 0 ? 'equal weights won' : f.p >= 4 ? 'strongly favours the best model' : 'weights ∝ (1/MSE)^p');
  }

  K.sliders = (from) => {
    const ms = fit?.models || A.models();
    const base = from || fit?.global || Object.fromEntries(ms.map((m) => [m, 1 / (ms.length || 1)]));
    $('cbManual').innerHTML = ms.length ? ms.map((m) => `<label><span><span style="color:${colorOf(m)}">●</span> ${A.api.MODELS[m]}</span> <output id="cbo_${m}">${Math.round(100 * (base[m] ?? 0))}</output>
      <input type="range" min="0" max="100" value="${Math.round(100 * (base[m] ?? 0))}" data-model="${m}" aria-label="${A.api.MODELS[m]} weight"></label>`).join('')
      : '<p class="sub">Select weather models in the sidebar.</p>';
    $('cbManual').querySelectorAll('input').forEach((i) => i.addEventListener('input', () => {
      $('cbo_' + i.dataset.model).textContent = i.value; if ($('cbUseManual').checked && A.data) safeApply(); }));
  };

  // Apply to the current forecast in A.data
  K.apply = () => {
    const d = A.data; if (!d) { $('cbEmpty').hidden = false; steps(); return; }
    const asset = $('cbAsset').value;
    const useFit = fit && fit.asset === asset ? fit : null;
    const ms = d.models.filter((m) => !useFit || useFit.models.includes(m));
    if (!ms.length) throw new Error('The learned models are not in the current forecast — re-learn weights');
    const manual = $('cbUseManual').checked || !useFit;
    const mw = {}; $('cbManual').querySelectorAll('input').forEach((i) => { mw[i.dataset.model] = +i.value; });
    const cap = d.cap[asset];
    const p50 = [], p10 = [], p90 = [], regs = [];
    d.hours.forEach((h, i) => {
      const r = situ(h, ms, (m) => d.det[m].ws[i], (m) => d.det[m].wx?.shortwave_radiation?.[i]);
      const reg = regimeOf(asset, r); regs.push(reg);
      const w = manual ? Object.fromEntries(ms.map((m) => [m, mw[m] ?? 1])) : (useFit.weights[reg] || useFit.global);
      const s = A.sum(ms.map((m) => (d.det[m][asset][i] == null ? 0 : w[m] || 0))) || 1;
      const c = A.sum(ms.map((m) => (d.det[m][asset][i] ?? 0) * (w[m] || 0))) / s;
      const u = useFit?.unc[reg] || { q10: (d.q[asset].p10[i] ?? c) - (d.q[asset].p50[i] ?? c), q90: (d.q[asset].p90[i] ?? c) - (d.q[asset].p50[i] ?? c) };
      const night = reg === 'night';
      p50.push(night ? 0 : c); p10.push(night ? 0 : A.clamp(c + u.q10, 0, cap)); p90.push(night ? 0 : A.clamp(c + u.q90, 0, cap));
    });
    // short-term correction with the latest measurement: error decays as exp(−Δt/τ)
    const tau = Math.max(0.5, A.num('cbTau'));
    let tMeas = null, vMeas = null;
    if ($('cbMeasVal').value !== '') {
      const t = $('cbMeasTime').value ? A.localToUTC($('cbMeasTime').value) : Date.now();
      tMeas = Math.floor(t / A.HOUR) * A.HOUR; vMeas = A.num('cbMeasVal');
      if (tMeas < d.hours[0] - 6 * A.HOUR || tMeas > d.hours[d.hours.length - 1]) {
        A.status('cbStatus', 'The measurement time is outside the forecast period (or > 6 h before it) — correction not applied.', 'error'); tMeas = null;
      }
    } else if (K.truth) {
      const ts = [...K.truth.keys()].filter((h) => h >= d.hours[0] - 6 * A.HOUR && h <= d.hours[d.hours.length - 1]);
      if (ts.length) { tMeas = Math.max(...ts); vMeas = K.truth.get(tMeas); }
    }
    let corr = null, nowIdx = -1, e0 = 0;
    if (tMeas != null) {
      const i0 = Math.max(0, d.hours.findIndex((h) => h >= tMeas));
      e0 = vMeas - (d.hours[i0] === tMeas ? p50[i0] : p50[0]);
      nowIdx = d.hours.indexOf(tMeas);
      corr = p50.map((v, i) => (d.hours[i] < tMeas ? null : A.clamp(v + e0 * Math.exp(-(d.hours[i] - tMeas) / A.HOUR / tau), 0, cap)));
    } else {
      nowIdx = d.hours.indexOf(Math.floor(Date.now() / A.HOUR) * A.HOUR);
    }
    const meas = K.truth ? d.hours.map((h) => K.truth.get(h) ?? null) : null;
    K.result = { asset, p50, p10, p90, corr, regs, hours: d.hours };
    A.data.combo = A.data.combo || {}; A.data.combo[asset] = { p50: corr ? corr.map((v, i) => v ?? p50[i]) : p50, p10, p90 };
    const color = asset === 'solar' ? A.series(1) : A.series(0), labels = d.hours.map((h) => A.fmtTime(h));
    $('cbEmpty').hidden = true;
    A.chart('cCombo', 'line', labels, [
      ...A.band('Combination', { p10, p90 }, color),
      { label: 'Combination forecast', data: p50, borderColor: color, borderWidth: 2.6 },
      ...(corr ? [{ label: `Short-term corrected (τ = ${tau} h)`, data: corr, borderColor: A.series(6), borderWidth: 2 }] : []),
      ...(meas ? [{ label: 'Measured', data: meas, borderColor: A.css('--text-primary'), borderWidth: 1.8 }] : []),
      ...ms.map((m) => ({ label: A.api.MODELS[m], data: d.det[m][asset], borderColor: A.alpha(colorOf(m), 0.75), borderWidth: 1, borderDash: [3, 3] })),
    ], { unit: 'MW', ytitle: 'MW', nowIndex: nowIdx >= 0 ? nowIdx : null, nowLabel: tMeas != null ? 'Latest measurement' : 'Now' });
    const names = Object.fromEntries([...REG[asset], { id: 'night', name: 'Night' }].map((g) => [g.id, g.name.replace(/ \(.*/, '')]));
    const counts = {}; regs.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
    $('cbRegimes').textContent = 'MW · situations in this forecast: ' + Object.entries(counts).map(([k, v]) => `${names[k]} ${v} h`).join(' · ') +
      (manual ? (useFit ? ' · manual weights' : ' · equal/manual weights (not learned yet)') : ' · learned weights');
    if (corr) A.status('cbStatus', `Short-term correction: measured ${A.fmt(vMeas, 1)} MW vs forecast → error ${e0 >= 0 ? '+' : ''}${A.fmt(e0, 1)} MW, halves every ${A.fmt(tau * Math.LN2, 1)} h.`, 'ok');
    steps();
  };
  function safeApply() { try { K.apply(); } catch (e) { A.status('cbStatus', e.message, 'error'); } }

  async function learnAndApply() {
    try {
      await K.train();
      renderFit(); K.sliders(); safeApply();
      if (fit) A.status('cbStatus', `Weights learned against ${fit.refName} (${fit.period}). Test-period P10–P90 coverage ${A.fmt(100 * fit.cover, 0)} % (ideal 80 %).`, 'ok');
    } catch (e) { console.error(e); A.status('cbStatus', e.message, 'error'); safeApply(); }
  }

  K.init = () => {
    $('cbTrain').addEventListener('click', (e) => { A.store.set('cbfit', null); A.busy(e.target, learnAndApply); });
    $('cbApply').addEventListener('click', () => safeApply());
    $('cbUseManual').addEventListener('change', safeApply);
    $('cbEqual').addEventListener('click', () => { const ms = fit?.models || A.models(); K.sliders(Object.fromEntries(ms.map((m) => [m, 1 / ms.length]))); $('cbUseManual').checked = true; safeApply(); });
    $('cbFromLearned').addEventListener('click', () => { if (!fit) return A.toast('Learn weights first', 'warn'); K.sliders(fit.global); $('cbUseManual').checked = true; safeApply(); });
    ['cbAsset', 'cbRef'].forEach((id) => $(id).addEventListener('change', () => { fit = null; $('cbKpis').innerHTML = ''; $('cbWeights').innerHTML = ''; $('cbSkill').innerHTML = '';
      $('cbWEmpty').hidden = false; K.sliders(); if (A.data && $('cbAuto').checked) learnAndApply(); else safeApply(); }));
    try { $('cbMeasTime').value = A.toLocalInput(Math.floor(Date.now() / A.HOUR) * A.HOUR); } catch (e) { /* time zone not ready */ }
    document.addEventListener('forecast:ready', () => { K.sliders(); safeApply(); if ($('cbAuto').checked) learnAndApply(); });
    K.sliders(); steps();
  };
})(window.App);
