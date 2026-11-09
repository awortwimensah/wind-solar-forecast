/* Shared helpers, app state and chart factory. Global namespace: App */
window.App = window.App || {};
(function (A) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  A.$ = $;
  A.HOUR = 3600e3;
  A.DAY = 24 * A.HOUR;

  /* ---------------- numbers & arrays ---------------- */
  A.fmt = (x, d = 1) => (x == null || !isFinite(x)) ? '–'
    : Number(x).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  A.sum = (a) => a.reduce((s, x) => s + (x == null || !isFinite(x) ? 0 : x), 0);
  A.mean = (a) => { const v = a.filter((x) => x != null && isFinite(x)); return v.length ? A.sum(v) / v.length : null; };
  A.clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  A.quantile = (arr, q) => {            // linear interpolation, ignores null
    const v = arr.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  };
  A.linspace = (a, b, n) => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));
  // deterministic RNG (mulberry32) so clustering results are reproducible
  A.rng = (seed) => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

  /* ---------------- linear algebra ---------------- */
  // Solve M x = b by Gaussian elimination with partial pivoting (M: array of rows)
  A.solve = (M, b) => {
    const n = b.length, a = M.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      if (Math.abs(a[p][c]) < 1e-12) throw new Error('Singular matrix (redundant features?)');
      [a[c], a[p]] = [a[p], a[c]];
      for (let r = 0; r < n; r++) if (r !== c) { const f = a[r][c] / a[c][c]; if (f) for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k]; }
    }
    return a.map((r, i) => r[n] / r[i]);
  };

  /* ---------------- dates ---------------- */
  A.isoDate = (d) => new Date(d).toISOString().slice(0, 10);
  A.todayUTC = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };
  A.addDays = (d, n) => new Date(new Date(d).getTime() + n * A.DAY);
  A.parseUTC = (s) => new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z').getTime();
  A.tz = 'UTC';
  A.fmtTime = (ms, opts = { weekday: 'short', day: 'numeric', hour: '2-digit' }) =>
    new Intl.DateTimeFormat(undefined, { timeZone: A.tz, ...opts }).format(ms);
  A.localDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: A.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  A.localHour = (ms) => +new Intl.DateTimeFormat('en-GB', { timeZone: A.tz, hour: '2-digit', hourCycle: 'h23' }).format(ms);

  /* ---------------- persistence (best effort) ---------------- */
  A.store = {
    get(k, d) { try { const v = localStorage.getItem('rf_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('rf_' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  /* ---------------- UI helpers ---------------- */
  A.toast = (msg, kind = 'info', ms = 5000) => {
    const t = document.createElement('div');
    t.className = 'toast ' + kind; t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), ms);
  };
  A.status = (id, msg, kind = '') => { const e = $(id); if (e) { e.textContent = msg; e.className = 'status ' + kind; } };
  A.num = (id) => { const v = parseFloat($(id).value); return isFinite(v) ? v : 0; };
  A.busy = async (btn, fn) => {
    const label = btn.textContent; btn.disabled = true; btn.textContent = 'Working…';
    try { return await fn(); } catch (e) { console.error(e); A.toast(e.message || String(e), 'error', 8000); }
    finally { btn.disabled = false; btn.textContent = label; }
  };
  A.table = (el, head, rows) => {
    el.innerHTML = '<thead><tr>' + head.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody>';
  };
  A.csvDownload = (name, header, rows) => {
    const blob = new Blob([[header.join(','), ...rows.map((r) => r.join(','))].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  };
  A.parseCSV = (text) => {
    const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
    const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
    const head = lines[0].split(sep).map((h) => h.trim().replace(/^"|"$/g, ''));
    return lines.slice(1).map((l) => { const c = l.split(sep); const o = {};
      head.forEach((h, i) => { o[h] = (c[i] || '').trim().replace(/^"|"$/g, ''); }); return o; });
  };

  /* ---------------- theme-aware colours (validated reference palette) ---------------- */
  A.css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  A.series = (i) => A.css('--series-' + (((i % 8) + 8) % 8 + 1));
  A.alpha = (hex, a) => { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };

  /* ---------------- charts (Chart.js) ---------------- */
  A.charts = {};
  A.chart = (id, type, labels, datasets, extra = {}) => {
    if (!window.Chart) return null;
    A.charts[id]?.destroy();
    const ink = A.css('--text-secondary'), grid = A.css('--grid');
    const opts = {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      elements: { point: { radius: 0, hoverRadius: 4 }, line: { borderWidth: 2, tension: 0.15 }, bar: { borderRadius: 4, borderSkipped: 'start' } },
      plugins: {
        legend: { position: 'top', align: 'start', labels: { color: ink, boxWidth: 12, boxHeight: 12, usePointStyle: true, filter: (i) => !i.text.startsWith('_') } },
        tooltip: { filter: (i) => !i.dataset.label.startsWith('_'), callbacks: Object.assign({
          label: (c) => { const ds = c.dataset, v = c.parsed.y;
            if (ds.bandLow) return ` ${ds.label}: ${A.fmt(ds.bandLow[c.dataIndex], 1)} – ${A.fmt(v, 1)}`;
            return ` ${ds.label}: ${A.fmt(v, extra.digits ?? 1)}${extra.unit ? ' ' + extra.unit : ''}`; },
        }, extra.tooltip || {}) },
      },
      scales: {
        x: { ticks: { color: ink, maxRotation: 0, autoSkip: true, maxTicksLimit: extra.xticks || 10 }, grid: { display: false }, title: extra.xtitle ? { display: true, text: extra.xtitle, color: ink } : undefined },
        y: { beginAtZero: extra.zero !== false, ticks: { color: ink }, grid: { color: grid }, title: extra.ytitle ? { display: true, text: extra.ytitle, color: ink } : undefined, ...(extra.y || {}) },
      },
    };
    if (extra.stacked) { opts.scales.x.stacked = true; opts.scales.y.stacked = true; }
    A.charts[id] = new Chart($(id), { type, data: { labels, datasets }, options: opts });
    return A.charts[id];
  };
  // P10–P90 band + P50 line helper
  A.band = (label, q, color) => ([
    { label: `${label} P10–P90`, data: q.p90, bandLow: q.p10, borderColor: 'transparent', backgroundColor: A.alpha(color, 0.18), fill: '+1', pointRadius: 0 },
    { label: `_${label} p10`, data: q.p10, borderColor: 'transparent', fill: false, pointRadius: 0 },
  ]);
})(window.App);
