/* Physical conversion: NWP -> wind farm and PV plant power (same methods as backend/physics.py) */
(function (A) {
  'use strict';
  const P = A.physics = {};
  const RHO0 = 1.225;
  const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;

  /* ---------- wind ---------- */
  // Power-law shear fitted hourly from the 10 m / 100 m pair
  P.hubWind = (v10, v100, hub, a0 = 0.143) => {
    if (v100 != null && v10 != null && v10 > 0.5 && v100 > 0.5) {
      const a = A.clamp(Math.log(v100 / v10) / Math.log(10), 0, 0.5);
      return v100 * Math.pow(hub / 100, a);
    }
    if (v100 != null) return v100 * Math.pow(hub / 100, a0);
    if (v10 != null) return v10 * Math.pow(hub / 10, a0);
    return null;
  };
  P.airDensity = (pHpa, tC, hub) => {
    if (pHpa == null || tC == null) return RHO0;
    const T0 = tC + 273.15, T = T0 - 0.0065 * hub;
    const p = pHpa * 100 * Math.pow(1 - 0.0065 * hub / T0, 5.255);
    return p / (287.05 * T);
  };
  P.parseCurve = (txt) => {
    const pts = (txt || '').split(/\n/).map((l) => l.trim().split(/[\s,;\t]+/).map(Number))
      .filter((p) => p.length >= 2 && isFinite(p[0]) && isFinite(p[1])).sort((a, b) => a[0] - b[0]);
    return pts.length >= 3 ? pts : null;
  };
  P.genericCurve = (ratedKW, vin, vr, vout) => {
    const pts = [];
    for (let v = 0; v <= vout + 1e-9; v += 0.5) pts.push([v, v < vin ? 0 : Math.min(ratedKW, ratedKW * (v ** 3 - vin ** 3) / (vr ** 3 - vin ** 3))]);
    pts.push([vout + 0.01, 0]);
    return pts;
  };
  const interp = (pts, v) => {
    if (v < pts[0][0] || v > pts[pts.length - 1][0]) return 0;
    for (let i = 1; i < pts.length; i++) if (v <= pts[i][0]) {
      const [v0, p0] = pts[i - 1], [v1, p1] = pts[i];
      return p0 + (p1 - p0) * (v - v0) / ((v1 - v0) || 1);
    }
    return 0;
  };
  // Wind farm config -> {curve, ratedKW, capMW}
  P.windSetup = (w) => {
    const custom = P.parseCurve(w.curve);
    const curve = custom || P.genericCurve(w.ratedMW * 1000, w.vin, w.vr, w.vout);
    const ratedKW = Math.max(...curve.map((p) => p[1]));
    const vcut = Math.max(...curve.filter((p) => p[1] > 0).map((p) => p[0]));
    return { ...w, curve, ratedKW, vcut, custom: !!custom, capMW: ratedKW * w.n / 1000 * (1 - w.loss / 100) };
  };
  // IEC density-corrected curve, MW for the whole farm
  P.windPower = (ws, rho, W) => {
    if (ws == null) return null;
    if (ws > W.vcut) return 0;
    const ve = ws * Math.cbrt(rho / RHO0);
    return interp(W.curve, ve) * W.n / 1000 * (1 - W.loss / 100);
  };

  /* ---------- solar ---------- */
  // NOAA/Spencer solar position; returns zenith & azimuth (deg from north, clockwise)
  P.sunPos = (ms, lat, lon) => {
    const d = new Date(ms);
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    const doy = Math.floor((ms - start) / A.DAY) + 1;
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
    const g = 2 * Math.PI / 365 * (doy - 1 + (hour - 12) / 24);
    const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
      + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const ha = rad((hour * 60 + eqt + 4 * lon) / 4 - 180), la = rad(lat);
    const cz = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha);
    const zen = deg(Math.acos(A.clamp(cz, -1, 1)));
    const az = (deg(Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(la) - Math.tan(decl) * Math.cos(la))) + 180) % 360;
    return { zen, az, i0: 1367 * (1 + 0.033 * Math.cos(2 * Math.PI * doy / 365)) };
  };
  // Erbs decomposition + isotropic transposition. Radiation is the mean of the PRECEDING hour -> sun at t-30 min.
  P.poa = (msEnd, ghi, lat, lon, tilt, aziCompass, albedo = 0.2) => {
    if (ghi == null || ghi <= 0) return 0;
    const s = P.sunPos(msEnd - 30 * 60e3, lat, lon);
    if (s.zen >= 90) return 0;
    const cz = Math.max(Math.cos(rad(s.zen)), 0.065);
    const kt = A.clamp(ghi / (s.i0 * cz), 0, 1);
    const fd = kt <= 0.22 ? 1 - 0.09 * kt : kt <= 0.8 ? 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4 : 0.165;
    const dhi = fd * ghi, dni = Math.max(0, (ghi - dhi) / cz);
    const tr = rad(tilt), zr = rad(s.zen);
    const cosAoi = Math.cos(zr) * Math.cos(tr) + Math.sin(zr) * Math.sin(tr) * Math.cos(rad(s.az - aziCompass));
    return Math.max(0, dni * Math.max(cosAoi, 0) + dhi * (1 + Math.cos(tr)) / 2 + ghi * albedo * (1 - Math.cos(tr)) / 2);
  };
  P.solarSetup = (s) => ({ ...s, capMW: Math.min(s.kwp, s.ackw || Infinity) / 1000 });
  // PVWatts-style DC model, Faiman cell temperature, losses, inverter clipping -> MW
  P.pvPower = (poa, tC, ws10, S) => {
    if (poa == null) return null;
    const tc = (tC ?? 25) + poa / (25 + 6.84 * (ws10 ?? 1));
    const kw = S.kwp * poa / 1000 * (1 + S.gamma / 100 * (tc - 25)) * (1 - S.loss / 100);
    return A.clamp(kw, 0, S.ackw || Infinity) / 1000;
  };

  /* ---------- whole series ---------- */
  // wx: {time:[ms], wind_speed_10m:[], wind_speed_100m:[], temperature_2m:[], surface_pressure:[], shortwave_radiation:[]}
  P.convert = (wx, site, W, S) => {
    const n = wx.time.length, out = { ws: new Array(n), wind: new Array(n), poa: new Array(n), solar: new Array(n) };
    const g = (k, i) => (wx[k] ? wx[k][i] : null);
    for (let i = 0; i < n; i++) {
      const ws = P.hubWind(g('wind_speed_10m', i), g('wind_speed_100m', i), W.hub);
      out.ws[i] = ws;
      out.wind[i] = P.windPower(ws, P.airDensity(g('surface_pressure', i), g('temperature_2m', i), W.hub), W);
      const ghi = g('shortwave_radiation', i);
      const poa = ghi == null ? null : P.poa(wx.time[i], ghi, site.lat, site.lon, S.tilt, S.azi);
      out.poa[i] = poa;
      out.solar[i] = P.pvPower(poa, g('temperature_2m', i), g('wind_speed_10m', i), S);
    }
    return out;
  };
})(window.App);
