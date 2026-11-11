/* Weather warnings / situational awareness for wind farms and PV plants */
(function (A) {
  'use strict';
  const $ = A.$;
  const Wn = A.warnings = {};
  const LEVELS = [
    { k: 0, name: 'none', icon: '', cls: '' },
    { k: 1, name: 'Watch', icon: '!', cls: 'lv-warning' },
    { k: 2, name: 'Warning', icon: '!!', cls: 'lv-serious' },
    { k: 3, name: 'Severe', icon: '⛔', cls: 'lv-critical' },
  ];
  const level = (p, a = 0.15, b = 0.4, c = 0.7) => (p >= c ? 3 : p >= b ? 2 : p >= a ? 1 : 0);

  // Each hazard returns, per hour, a probability-like score (share of scenarios / models meeting the rule)
  Wn.HAZARDS = [
    { id: 'storm', name: 'Storm / cut-out', asset: 'wind', icon: '🌬',
      rule: (W) => `hub wind ≥ cut-out ${A.fmt(W.vcut, 0)} m/s, or 10 m gusts ≥ 32 m/s`,
      action: 'Expect high-wind shutdowns (with hysteresis on restart); reduce day-ahead offers and check storm-control settings.' },
    { id: 'icing', name: 'Rotor icing', asset: 'wind', icon: '❄',
      rule: () => 'hub temperature −10…+1 °C with RH ≥ 95 %, fog (visibility < 1 km) or precipitation',
      action: 'Production losses and ice throw possible; check ice-detection / de-icing, adjust offers and site access.' },
    { id: 'cold', name: 'Low-temperature limit', asset: 'wind', icon: '🥶',
      rule: () => 'hub temperature below −20 °C (standard turbines stop)',
      action: 'Standard turbines derate/stop; cold-climate packages may operate.' },
    { id: 'thunder', name: 'Thunderstorm', asset: 'all', icon: '⚡',
      rule: () => 'weather code 95–99, or CAPE ≥ 1000 J/kg with ≥ 1 mm/h precipitation',
      action: 'Lightning and gust fronts: fast ramps, possible protective shutdowns; keep reserve margin.' },
    { id: 'snow', name: 'Snow on PV', asset: 'solar', icon: '🌨',
      rule: () => 'snowfall ≥ 0.5 cm/h or snow depth ≥ 3 cm',
      action: 'Modules may be covered; output near zero until melt/slide-off. Consider curtailment-tab snow derate.' },
    { id: 'fog', name: 'Fog / low stratus', asset: 'solar', icon: '🌫',
      rule: () => 'daylight with visibility < 1 km, or RH ≥ 97 % and cloud cover ≥ 95 %',
      action: 'Irradiance strongly over-forecast in fog; widen uncertainty and reduce morning offers.' },
  ];

  Wn.compute = () => {
    const d = A.data; if (!d) throw new Error('Run a forecast first (Forecast tab).');
    const W = d.W, site = A.site, n = d.hours.length;
    const out = Object.fromEntries(Wn.HAZARDS.map((h) => [h.id, new Array(n).fill(0)]));
    const ensWs = d.members.ws?.length >= 5 ? d.members.ws : null;
    for (let i = 0; i < n; i++) {
      const per = d.models.map((m) => {
        const x = d.det[m].wx || {}, g = (k) => x[k]?.[i];
        const t2 = g('temperature_2m'), th = t2 == null ? null : t2 - 0.0065 * W.hub;
        const rh = g('relative_humidity_2m'), vis = g('visibility'), pr = g('precipitation') ?? 0, code = g('weather_code');
        const day = 90 - A.physics.sunPos(d.hours[i] + 30 * 60e3, site.lat, site.lon).zen > 3;
        return {
          storm: (d.det[m].ws[i] ?? 0) >= W.vcut || (g('wind_gusts_10m') ?? 0) >= 32,
          icing: th != null && th >= -10 && th <= 1 && ((rh ?? 0) >= 95 || (vis != null && vis < 1000) || pr > 0.1),
          cold: th != null && th < -20,
          thunder: (code >= 95 && code <= 99) || ((g('cape') ?? 0) >= 1000 && pr >= 1),
          snow: (g('snowfall') ?? 0) >= 0.5 || (g('snow_depth') ?? 0) >= 0.03,
          fog: day && ((vis != null && vis < 1000) || ((rh ?? 0) >= 97 && (g('cloud_cover') ?? 0) >= 95)),
        };
      });
      const share = (k) => (per.length ? per.filter((p) => p[k]).length / per.length : 0);
      for (const h of Wn.HAZARDS) out[h.id][i] = share(h.id);
      if (ensWs) {                                   // storm probability from ensemble members (more scenarios)
        const vals = ensWs.map((m) => m[i]).filter((v) => v != null);
        if (vals.length) out.storm[i] = Math.max(out.storm[i] * 0.5, vals.filter((v) => v >= W.vcut).length / vals.length);
      }
    }
    // merge consecutive hours into events
    const events = [];
    for (const h of Wn.HAZARDS) {
      if (h.asset === 'wind' && !(d.cap.wind > 0)) continue;
      if (h.asset === 'solar' && !(d.cap.solar > 0)) continue;
      let cur = null;
      out[h.id].forEach((p, i) => {
        const lv = level(p);
        if (lv > 0) { if (!cur) cur = { h, i0: i, i1: i, pmax: p, lv }; else { cur.i1 = i; cur.pmax = Math.max(cur.pmax, p); cur.lv = Math.max(cur.lv, lv); } }
        else if (cur) { if (i - cur.i1 > 2) { events.push(cur); cur = null; } }
      });
      if (cur) events.push(cur);
    }
    events.sort((a, b) => b.lv - a.lv || a.i0 - b.i0);
    return { out, events, ens: !!ensWs };
  };

  Wn.run = () => {
    const d = A.data, R = Wn.compute(), W = d.W;
    // timeline grid: one row per hazard, one cell per hour, colour + icon + label (never colour alone)
    const step = Math.max(1, Math.ceil(d.hours.length / 168));
    const cols = d.hours.map((h, i) => i).filter((i) => i % step === 0);
    let html = `<div class="tl" style="grid-template-columns: 150px repeat(${cols.length}, minmax(4px,1fr))">`;
    html += '<div class="tl-h"></div>' + cols.map((i) => { const lh = A.localHour(d.hours[i]);
      return `<div class="tl-h">${lh === 0 ? A.fmtTime(d.hours[i], { weekday: 'short', day: 'numeric' }) : ''}</div>`; }).join('');
    for (const h of Wn.HAZARDS) {
      html += `<div class="tl-name">${h.icon} ${h.name}</div>`;
      html += cols.map((i) => { const p = R.out[h.id][i], lv = LEVELS[level(p)];
        return `<div class="tl-c ${lv.cls}" title="${h.name} · ${A.fmtTime(d.hours[i])} · ${lv.k ? lv.name : 'no risk'} (${Math.round(p * 100)} % of scenarios)"></div>`; }).join('');
    }
    $('wnTimeline').innerHTML = html + '</div>';
    const fmtSpan = (e) => `${A.fmtTime(d.hours[e.i0], { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} – ${A.fmtTime(d.hours[e.i1] + A.HOUR, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
    $('wnEvents').innerHTML = R.events.length ? R.events.map((e) => { const lv = LEVELS[e.lv];
      return `<div class="alert ${lv.cls}"><div class="alert-h"><span class="badge ${lv.cls}">${lv.icon} ${lv.name}</span><b>${e.h.icon} ${e.h.name}</b><span class="sub">${fmtSpan(e)} · up to ${Math.round(e.pmax * 100)} % of scenarios</span></div>
        <div class="alert-b">${e.h.action}<br><span class="sub">Rule: ${e.h.rule(W)}</span></div></div>`; }).join('')
      : '<div class="alert lv-good"><div class="alert-h"><span class="badge lv-good">✓ Clear</span><b>No weather risks detected</b><span class="sub">for the selected period and thresholds</span></div></div>';
    // plain-text situational report
    const lines = [`Situational report — ${A.site.name} (${A.site.lat.toFixed(3)}, ${A.site.lon.toFixed(3)})`,
      `Issued ${new Date().toLocaleString()} · period ${A.fmtTime(d.hours[0], { dateStyle: 'medium' })} – ${A.fmtTime(d.hours[d.hours.length - 1], { dateStyle: 'medium' })} (${A.tz})`,
      `Scenarios: ${R.ens ? 'ensemble members for storm risk, ' : ''}${d.models.length} deterministic models`, ''];
    if (!R.events.length) lines.push('No weather risks detected for wind or PV operation.');
    R.events.forEach((e) => lines.push(`[${LEVELS[e.lv].name.toUpperCase()}] ${e.h.name}: ${fmtSpan(e)}, up to ${Math.round(e.pmax * 100)} % of scenarios. ${e.h.action}`));
    lines.push('', `Energy outlook (P50): wind ${A.fmt(A.sum(d.q.wind.p50), 0)} MWh, solar ${A.fmt(A.sum(d.q.solar.p50), 0)} MWh.`);
    $('wnReport').value = lines.join('\n');
    const cnt = (lv) => R.events.filter((e) => e.lv === lv).length;
    const kpi = (l, v, x, cls) => `<div class="kpi"><div class="l">${l}</div><div class="v"><span class="badge ${cls}">${v}</span></div><div class="r">${x}</div></div>`;
    $('wnKpis').innerHTML = kpi('Severe', cnt(3), 'events ≥ 70 % of scenarios', 'lv-critical') + kpi('Warnings', cnt(2), 'events ≥ 40 %', 'lv-serious')
      + kpi('Watches', cnt(1), 'events ≥ 15 %', 'lv-warning') + kpi('Peak gust', A.fmt(Math.max(0, ...d.models.flatMap((m) => d.det[m].wx?.wind_gusts_10m || []).filter((x) => x != null)), 0) + ' m/s', 'max over models, 10 m', '');
    // tab badge
    const worst = Math.max(0, ...R.events.map((e) => e.lv));
    $('wnBadge').textContent = R.events.length ? String(R.events.length) : ''; $('wnBadge').className = 'tabbadge ' + (LEVELS[worst].cls || '');
  };

  Wn.init = () => {
    $('wnCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('wnReport').value); A.toast('Report copied', 'info'); }
      catch (e) { $('wnReport').select(); A.toast('Press Ctrl+C to copy the selected report', 'info'); } });
    document.addEventListener('forecast:ready', () => { try { Wn.run(); } catch (e) { console.error(e); } });
  };
})(window.App);
