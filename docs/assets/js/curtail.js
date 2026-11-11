/* Availability & curtailment: weather potential -> technically possible feed-in -> real feed-in */
(function (A) {
  'use strict';
  const $ = A.$;
  const C = A.curtail = {};
  const DEF = { plan: [], nightOn: false, nightFrom: 22, nightTo: 6, nightPct: 70, shadowOn: false, shAz1: 90, shAz2: 150, shElev: 25, shPct: 20,
    marketOn: true, marketThr: 0, marketScope: 'all', gridCap: 0, snowOn: true, snowDepth: 3, snowPct: 10 };
  let cfg = { ...DEF, ...A.store.get('curtail', {}) };

  const save = () => A.store.set('curtail', cfg);
  const readUI = () => {
    const g = (id) => $(id), n = (id) => A.num(id);
    Object.assign(cfg, { nightOn: g('cuNightOn').checked, nightFrom: n('cuNightFrom'), nightTo: n('cuNightTo'), nightPct: n('cuNightPct'),
      shadowOn: g('cuShOn').checked, shAz1: n('cuShAz1'), shAz2: n('cuShAz2'), shElev: n('cuShElev'), shPct: n('cuShPct'),
      marketOn: g('cuMkOn').checked, marketThr: n('cuMkThr'), marketScope: g('cuMkScope').value, gridCap: n('cuGrid'),
      snowOn: g('cuSnowOn').checked, snowDepth: n('cuSnowDepth'), snowPct: n('cuSnowPct') });
    cfg.plan = [...document.querySelectorAll('#cuPlan tbody tr')].map((tr) => ({
      type: tr.querySelector('[data-k=type]').value, asset: tr.querySelector('[data-k=asset]').value,
      start: tr.querySelector('[data-k=start]').value, end: tr.querySelector('[data-k=end]').value, mw: +tr.querySelector('[data-k=mw]').value || 0,
      note: tr.querySelector('[data-k=note]').value })).filter((r) => r.start && r.end);
    save();
  };
  const writeUI = () => {
    const s = (id, v) => { if ($(id).type === 'checkbox') $(id).checked = v; else $(id).value = v; };
    s('cuNightOn', cfg.nightOn); s('cuNightFrom', cfg.nightFrom); s('cuNightTo', cfg.nightTo); s('cuNightPct', cfg.nightPct);
    s('cuShOn', cfg.shadowOn); s('cuShAz1', cfg.shAz1); s('cuShAz2', cfg.shAz2); s('cuShElev', cfg.shElev); s('cuShPct', cfg.shPct);
    s('cuMkOn', cfg.marketOn); s('cuMkThr', cfg.marketThr); s('cuMkScope', cfg.marketScope); s('cuGrid', cfg.gridCap);
    s('cuSnowOn', cfg.snowOn); s('cuSnowDepth', cfg.snowDepth); s('cuSnowPct', cfg.snowPct);
    renderPlan();
  };
  function rowHTML(r = {}) {
    const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    return `<tr>
      <td><select data-k="type">${opt('maint', r.type, 'Maintenance / outage')}${opt('grid', r.type, 'Grid restriction (cap)')}</select></td>
      <td><select data-k="asset">${opt('wind', r.asset, 'Wind')}${opt('solar', r.asset, 'Solar')}${opt('all', r.asset, 'Whole plant')}</select></td>
      <td><input data-k="start" type="datetime-local" value="${r.start || ''}"></td>
      <td><input data-k="end" type="datetime-local" value="${r.end || ''}"></td>
      <td><input data-k="mw" type="number" step="0.1" value="${r.mw ?? ''}" style="width:90px"></td>
      <td><input data-k="note" value="${r.note || ''}" placeholder="e.g. gearbox T03"></td>
      <td><button class="btn ghost sm" data-del>✕</button></td></tr>`;
  }
  function renderPlan() {
    $('cuPlan').innerHTML = '<thead><tr><th>Type</th><th>Asset</th><th>Start (site time)</th><th>End</th><th>MW (unavailable / cap)</th><th>Note</th><th></th></tr></thead><tbody>' +
      (cfg.plan.length ? cfg.plan.map(rowHTML).join('') : '') + '</tbody>';
  }

  /* ---------- core model ---------- */
  // Per-hour availability factors and caps. Returns functions usable for any scenario value.
  C.model = async () => {
    const d = A.data; if (!d) throw new Error('Run a forecast first (Forecast tab).');
    const capW = d.cap.wind, capS = d.cap.solar, site = A.site;
    const { lam, src } = await A.market.prices(d.hours);
    const plan = cfg.plan.map((r) => ({ ...r, s: A.localToUTC(r.start), e: A.localToUTC(r.end) }));
    const m0 = d.models[0];
    const mean = (k, i) => A.mean(d.models.map((m) => d.det[m].wx?.[k]?.[i]));
    const H = d.hours.map((h, i) => {
      const mid = h + 30 * 60e3;
      let maintW = 0, maintS = 0, cap = cfg.gridCap > 0 ? cfg.gridCap : Infinity;
      for (const r of plan) {
        if (!(mid >= r.s && mid < r.e)) continue;
        if (r.type === 'maint') {
          if (r.asset === 'wind') maintW += r.mw; else if (r.asset === 'solar') maintS += r.mw;
          else { maintW += r.mw * capW / (capW + capS); maintS += r.mw * capS / (capW + capS); }
        } else cap = Math.min(cap, r.mw);
      }
      const avW = A.clamp(1 - maintW / (capW || 1), 0, 1), avS = A.clamp(1 - maintS / (capS || 1), 0, 1);
      // scheduled: noise-driven night mode (local hours) and shadow-flicker shutdown (sun geometry + sunshine)
      const lh = A.localHour(mid);
      const night = cfg.nightOn && (cfg.nightFrom > cfg.nightTo ? (lh >= cfg.nightFrom || lh < cfg.nightTo) : (lh >= cfg.nightFrom && lh < cfg.nightTo));
      const fNight = night ? cfg.nightPct / 100 : 1;
      const sp = A.physics.sunPos(mid, site.lat, site.lon), elev = 90 - sp.zen;
      const ghi = mean('shortwave_radiation', i), cs = A.clearSkyGHI(h + A.HOUR, site.lat, site.lon);
      const sunny = cs > 50 && ghi != null && ghi / cs > 0.6;
      const shadow = cfg.shadowOn && sunny && elev > 2 && elev < cfg.shElev && sp.az >= cfg.shAz1 && sp.az <= cfg.shAz2;
      const fShadow = shadow ? 1 - cfg.shPct / 100 : 1;
      const snowDepth = mean('snow_depth', i);           // metres in Open-Meteo
      const snow = cfg.snowOn && snowDepth != null && snowDepth * 100 >= cfg.snowDepth;
      const fSnow = snow ? cfg.snowPct / 100 : 1;
      const market = cfg.marketOn && lam[i] < cfg.marketThr;
      return { avW, avS, fNight, fShadow, fSnow, cap, market, lam: lam[i], night, shadow, snow };
    });
    // apply to one hour: input weather-potential wind & solar MW -> {techW, techS, realW, realS}
    const apply = (i, w, s) => {
      const h = H[i];
      const tW = (w ?? 0) * h.avW * h.fNight * h.fShadow, tS = (s ?? 0) * h.avS * h.fSnow;
      let rW = tW, rS = tS;
      if (h.market) { if (cfg.marketScope !== 'solar') rW = 0; if (cfg.marketScope !== 'wind') rS = 0; }
      const tot = rW + rS;
      if (tot > h.cap) { const f = h.cap / tot; rW *= f; rS *= f; }
      return { tW, tS, rW, rS };
    };
    return { H, apply, lam, src, m0 };
  };

  // Used by the trading tab: scale scenario values of one asset at hour i
  C.scenarioMapper = async (asset) => {
    const M = await C.model(), d = A.data;
    return (i, x) => {
      if (asset === 'wind') return M.apply(i, x, 0).rW;
      if (asset === 'solar') return M.apply(i, 0, x).rS;
      const w = d.q.wind.p50[i] ?? 0, s = d.q.solar.p50[i] ?? 0, sh = w + s > 0 ? w / (w + s) : 0.5;
      const r = M.apply(i, x * sh, x * (1 - sh)); return r.rW + r.rS;
    };
  };
  C.active = () => $('trCurt')?.checked;

  C.run = async () => {
    readUI();
    const d = A.data, M = await C.model();
    const pw = d.q.wind.p50, ps = d.q.solar.p50;
    const R = d.hours.map((_, i) => M.apply(i, pw[i], ps[i]));
    const tech = { w: R.map((r) => r.tW), s: R.map((r) => r.tS) }, real = { w: R.map((r) => r.rW), s: R.map((r) => r.rS) };
    // loss attribution (sequential, on P50)
    const L = { maint: 0, sched: 0, snow: 0, market: 0, grid: 0 };
    d.hours.forEach((_, i) => {
      const h = M.H[i], w = pw[i] ?? 0, s = ps[i] ?? 0;
      L.maint += w * (1 - h.avW) + s * (1 - h.avS);
      L.sched += w * h.avW * (1 - h.fNight * h.fShadow);
      L.snow += s * h.avS * (1 - h.fSnow);
      const tW = R[i].tW, tS = R[i].tS;
      const afterMarket = h.market ? (cfg.marketScope === 'solar' ? tW : cfg.marketScope === 'wind' ? tS : 0) : tW + tS;
      L.market += tW + tS - afterMarket;
      L.grid += afterMarket - (R[i].rW + R[i].rS);
    });
    const pot = A.sum(pw) + A.sum(ps), te = A.sum(tech.w) + A.sum(tech.s), re = A.sum(real.w) + A.sum(real.s);
    const kpi = (l, v, u, x) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}<span class="u">${u}</span></div><div class="r">${x}</div></div>`;
    $('cuKpis').innerHTML =
      kpi('Weather potential', A.fmt(pot, 0), 'MWh', 'P50, no restrictions') +
      kpi('Technically possible', A.fmt(te, 0), 'MWh', `−${A.fmt(100 * (1 - te / (pot || 1)), 1)} % (outages, scheduled)`) +
      kpi('Real feed-in', A.fmt(re, 0), 'MWh', `−${A.fmt(100 * (1 - re / (pot || 1)), 1)} % incl. grid & market`) +
      kpi('Market curtailment', A.fmt(L.market, 0), 'MWh', `${M.H.filter((h) => h.market).length} h with λD < ${cfg.marketThr} €/MWh`) +
      kpi('Grid restriction', A.fmt(L.grid, 0), 'MWh', cfg.gridCap > 0 ? `export cap ${cfg.gridCap} MW` : 'plan windows only');
    const labels = d.hours.map((h) => A.fmtTime(h));
    const ds = (pot_, te_, re_, color) => [
      { label: 'Weather potential', data: pot_, borderColor: A.css('--text-muted'), borderWidth: 1.2, borderDash: [4, 3] },
      { label: 'Technically possible', data: te_, borderColor: color, borderWidth: 1.6 },
      { label: 'Real feed-in', data: re_, borderColor: color, borderWidth: 2.4, backgroundColor: A.alpha(color, 0.28), fill: 'origin' },
    ];
    A.chart('cCuW', 'line', labels, ds(pw, tech.w, real.w, A.series(0)), { unit: 'MW' });
    A.chart('cCuS', 'line', labels, ds(ps, tech.s, real.s, A.series(1)), { unit: 'MW' });
    A.table($('cuLoss'), ['Cause', 'Energy lost (MWh)', 'Share of potential', 'Version affected'], [
      ['Maintenance / outages (plan)', A.fmt(L.maint, 1), A.fmt(100 * L.maint / (pot || 1), 2) + ' %', 'both'],
      ['Scheduled shutdowns (night mode, shadow flicker)', A.fmt(L.sched, 1), A.fmt(100 * L.sched / (pot || 1), 2) + ' %', 'both'],
      ['Snow on PV modules', A.fmt(L.snow, 1), A.fmt(100 * L.snow / (pot || 1), 2) + ' %', 'both'],
      ['Market-driven (negative / low prices)', A.fmt(L.market, 1), A.fmt(100 * L.market / (pot || 1), 2) + ' %', 'real feed-in only'],
      ['Grid restrictions / export cap', A.fmt(L.grid, 1), A.fmt(100 * L.grid / (pot || 1), 2) + ' %', 'real feed-in only'],
    ]);
    C.last = { tech, real, d };
    A.status('cuStatus', `Prices: ${M.src}. Hours flagged — night: ${M.H.filter((h) => h.night).length}, shadow flicker: ${M.H.filter((h) => h.shadow).length}, snow: ${M.H.filter((h) => h.snow).length}.`, 'ok');
  };
  C.csv = () => {
    const L = C.last; if (!L) return A.toast('Compute the curtailment forecast first', 'warn');
    const f = (x) => (x == null ? '' : x.toFixed(3));
    A.csvDownload('feed_in_versions.csv', ['time_utc', 'wind_potential', 'wind_technical', 'wind_real', 'solar_potential', 'solar_technical', 'solar_real'],
      L.d.hours.map((h, i) => [new Date(h).toISOString(), f(L.d.q.wind.p50[i]), f(L.tech.w[i]), f(L.real.w[i]), f(L.d.q.solar.p50[i]), f(L.tech.s[i]), f(L.real.s[i])]));
  };

  C.init = () => {
    writeUI();
    $('cuAdd').addEventListener('click', () => {
      const t0 = A.data?.hours?.[24] ?? (Date.now() + A.DAY);
      $('cuPlan').querySelector('tbody').insertAdjacentHTML('beforeend', rowHTML({ type: 'maint', asset: 'wind', start: A.toLocalInput(t0), end: A.toLocalInput(t0 + 8 * A.HOUR), mw: 3.6 }));
    });
    $('cuPlan').addEventListener('click', (e) => { if (e.target.matches('[data-del]')) { e.target.closest('tr').remove(); readUI(); } });
    $('tab-curtail').addEventListener('change', readUI);
    $('cuRun').addEventListener('click', (e) => A.busy(e.target, C.run));
    $('cuCsv').addEventListener('click', C.csv);
  };
})(window.App);
