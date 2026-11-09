/* Site selection (GPS, search, map), date range and configuration getters */
(function (A) {
  'use strict';
  const $ = A.$;
  const S = A.site = { lat: 55.6761, lon: 12.5683, name: 'Copenhagen', country: 'Denmark', cc: 'DK', tz: 'Europe/Copenhagen', elevation: null };
  let map = null, marker = null;

  /* ---------- config getters ---------- */
  A.windCfg = () => A.physics.windSetup({ n: A.num('wN'), ratedMW: A.num('wRated'), hub: A.num('wHub'), loss: A.num('wLoss'),
    vin: A.num('wVin'), vr: A.num('wVr'), vout: A.num('wVout'), curve: $('wCurve').value });
  A.solarCfg = () => A.physics.solarSetup({ kwp: A.num('sKwp'), ackw: A.num('sAc'), tilt: A.num('sTilt'), azi: A.num('sAzi'),
    gamma: A.num('sGamma'), loss: A.num('sLoss') });
  A.marketCfg = () => ({ area: $('priceArea').value, flat: A.num('flatPrice'), dUp: A.num('dUp'), dDown: A.num('dDown') });
  A.models = () => [...document.querySelectorAll('#modelBoxes input:checked')].map((i) => i.value);
  A.ensembles = () => $('useEns').checked ? [...document.querySelectorAll('#ensBoxes input:checked')].map((i) => i.value) : [];
  A.period = () => {
    const s = new Date($('startDate').value + 'T00:00:00Z'), e = new Date($('endDate').value + 'T00:00:00Z');
    if (!(s <= e)) throw new Error('Start date must be on or before the end date');
    return { start: s, end: e };
  };

  /* ---------- persistence of all inputs ---------- */
  const PERSIST = ['wN', 'wRated', 'wHub', 'wLoss', 'wVin', 'wVr', 'wVout', 'wCurve', 'sKwp', 'sAc', 'sTilt', 'sAzi', 'sGamma', 'sLoss',
    'flatPrice', 'dUp', 'dDown', 'bE', 'bP', 'bEta', 'bS0', 'bDeg', 'bSrc', 'trAsset', 'evAsset', 'evTest', 'asK'];
  S.restore = () => {
    const saved = A.store.get('inputs', {});
    for (const id of PERSIST) if (saved[id] != null && $(id)) $(id).value = saved[id];
    Object.assign(S, A.store.get('site', {}));
    document.addEventListener('change', (ev) => {
      if (!PERSIST.includes(ev.target.id)) return;
      const cur = A.store.get('inputs', {}); cur[ev.target.id] = ev.target.value; A.store.set('inputs', cur);
    });
  };

  /* ---------- location ---------- */
  S.set = async (lat, lon, label) => {
    S.lat = +(+lat).toFixed(4); S.lon = +(+lon).toFixed(4);
    $('lat').value = S.lat; $('lon').value = S.lon;
    if (marker) { marker.setLatLng([S.lat, S.lon]); map.panTo([S.lat, S.lon]); }
    $('siteChip').textContent = `${S.lat.toFixed(3)}, ${S.lon.toFixed(3)} · locating…`;
    const [geo, info] = await Promise.all([A.api.reverse(S.lat, S.lon), A.api.siteInfo(S.lat, S.lon).catch(() => ({ tz: 'UTC' }))]);
    S.name = label?.name || geo.name || 'Selected site';
    S.country = label?.country || geo.country || '';
    S.cc = label?.cc || geo.cc || '';
    S.tz = info.tz || 'UTC'; S.elevation = info.elevation;
    A.tz = S.tz;
    const area = A.api.suggestArea(S.cc, S.lon, S.lat);
    $('priceArea').value = area;
    A.store.set('site', { lat: S.lat, lon: S.lon, name: S.name, country: S.country, cc: S.cc, tz: S.tz });
    renderMeta();
  };
  function renderMeta() {
    $('siteChip').textContent = `📍 ${S.name}${S.country ? ', ' + S.country : ''} · ${S.lat.toFixed(3)}, ${S.lon.toFixed(3)}`;
    $('siteMeta').innerHTML = `Time zone <b>${S.tz}</b>${S.elevation != null ? ` · model elevation <b>${Math.round(S.elevation)} m</b>` : ''}` +
      ` · price area <b>${$('priceArea').value === 'manual' ? 'manual' : $('priceArea').value}</b>`;
  }
  S.renderMeta = renderMeta;

  function initMap() {
    if (!window.L) { $('map').innerHTML = '<p class="hint" style="padding:10px">Map library could not load — use search or coordinates.</p>'; return; }
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView([S.lat, S.lon], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
    marker = L.marker([S.lat, S.lon], { draggable: true }).addTo(map);
    marker.on('dragend', () => { const p = marker.getLatLng(); S.set(p.lat, p.lng); });
    map.on('click', (e) => S.set(e.latlng.lat, e.latlng.lng));
  }

  function initSearch() {
    const inp = $('placeInput'), list = $('placeResults');
    let timer = null, results = [];
    inp.addEventListener('input', () => {
      clearTimeout(timer);
      const q = inp.value.trim();
      if (q.length < 2) { list.hidden = true; return; }
      timer = setTimeout(async () => {
        try { results = await A.api.search(q); } catch (e) { results = []; }
        list.innerHTML = results.map((r, i) => `<li data-i="${i}">${r.name} <small>${[r.admin1, r.country].filter(Boolean).join(', ')}</small></li>`).join('')
          || '<li><small>No match</small></li>';
        list.hidden = false;
      }, 300);
    });
    list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]'); if (!li) return;
      const r = results[+li.dataset.i];
      list.hidden = true; inp.value = `${r.name}, ${r.country || ''}`;
      S.set(r.latitude, r.longitude, { name: r.name, country: r.country, cc: r.country_code });
      if (map) map.setView([r.latitude, r.longitude], 8);
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.search')) list.hidden = true; });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') list.querySelector('li[data-i]')?.click(); });
  }

  function initGPS() {
    $('gpsBtn').addEventListener('click', () => {
      if (!navigator.geolocation) return A.toast('This browser has no GPS/geolocation support', 'error');
      $('gpsBtn').textContent = '📍 Locating…';
      navigator.geolocation.getCurrentPosition(async (pos) => {
        await S.set(pos.coords.latitude, pos.coords.longitude);
        if (map) map.setView([S.lat, S.lon], 9);
        $('gpsBtn').textContent = '📍 Use my GPS location';
        A.toast(`Location found (±${Math.round(pos.coords.accuracy)} m): ${S.name}`, 'info');
      }, (err) => {
        $('gpsBtn').textContent = '📍 Use my GPS location';
        A.toast(err.code === 1 ? 'Location permission denied — allow it in the browser, or search / click the map instead.' : 'Could not get a GPS fix: ' + err.message, 'error', 8000);
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 300000 });
    });
    const manual = () => { const la = parseFloat($('lat').value), lo = parseFloat($('lon').value);
      if (isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) S.set(la, lo); };
    $('lat').addEventListener('change', manual); $('lon').addEventListener('change', manual);
  }

  /* ---------- dates ---------- */
  function setPreset(p) {
    const t = A.todayUTC();
    const map_ = { next7: [0, 6], next14: [0, 13], tomorrow: [1, 1], past7: [-7, -1], past30: [-30, -1] };
    const [a, b] = map_[p];
    $('startDate').value = A.isoDate(A.addDays(t, a)); $('endDate').value = A.isoDate(A.addDays(t, b));
    document.querySelectorAll('#datePresets .chip').forEach((c) => c.classList.toggle('active', c.dataset.preset === p));
    dateHint();
  }
  function dateHint() {
    try {
      const { start, end } = A.period(), t = A.todayUTC();
      const max = A.addDays(t, 15);
      if (end > max) { $('endDate').value = A.isoDate(max); A.toast('Weather forecasts reach 16 days ahead — end date shortened.', 'warn'); }
      const past = end < t, fut = start >= t;
      $('dateHint').textContent = past ? 'Past dates: archived model forecasts (as issued), no ensembles.'
        : fut ? 'Future dates: live forecasts plus ensembles for P10/P50/P90.'
          : 'Mixed period: archived forecasts for past days, live forecast for the rest.';
    } catch (e) { $('dateHint').textContent = e.message; }
  }
  function initDates() {
    document.querySelectorAll('#datePresets .chip').forEach((c) => c.addEventListener('click', () => setPreset(c.dataset.preset)));
    ['startDate', 'endDate'].forEach((id) => $(id).addEventListener('change', () => {
      document.querySelectorAll('#datePresets .chip').forEach((c) => c.classList.remove('active')); dateHint(); }));
    $('endDate').max = A.isoDate(A.addDays(A.todayUTC(), 15));
    setPreset('next7');
  }

  function initLists() {
    $('modelBoxes').innerHTML = Object.entries(A.api.MODELS).map(([k, v], i) =>
      `<label><input type="checkbox" value="${k}" ${i < 3 ? 'checked' : ''}> ${v}</label>`).join('');
    $('ensBoxes').innerHTML = Object.entries(A.api.ENSEMBLES).map(([k, v]) =>
      `<label><input type="checkbox" value="${k}" checked> ${v}</label>`).join('');
    $('priceArea').innerHTML = '<option value="manual">Manual flat price</option>' +
      A.api.PRICE_AREAS.map((a) => `<option value="${a}">${a} (Energinet)</option>`).join('');
    $('priceArea').addEventListener('change', renderMeta);
  }

  S.init = () => {
    initLists(); S.restore(); initDates(); initSearch(); initGPS(); initMap();
    $('lat').value = S.lat; $('lon').value = S.lon; A.tz = S.tz || 'UTC';
    $('priceArea').value = A.api.suggestArea(S.cc, S.lon, S.lat);
    renderMeta();
    if (marker) { marker.setLatLng([S.lat, S.lon]); map.setView([S.lat, S.lon], 6); }
  };
})(window.App);
