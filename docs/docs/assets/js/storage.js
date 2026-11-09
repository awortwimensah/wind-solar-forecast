/* Battery storage: finite-horizon DP schedule + lecture MDP (value & policy iteration) */
(function (A) {
  'use strict';
  const $ = A.$;
  const B = A.storage = {};

  /* ---------- finite-horizon dynamic programming ---------- */
  // prices[t] €/MWh, chargeCap[t] MW limit on charging (Infinity = grid), returns optimal schedule
  B.dp = ({ prices, E, P, rte, s0, deg, chargeCap, K = 40 }) => {
    const T = prices.length, ds = E / K, eta = Math.sqrt(rte);
    const upMax = Math.floor((P * eta) / ds + 1e-9);   // SoC levels gained per hour at full charge power
    const dnMax = Math.floor((P / eta) / ds + 1e-9);   // SoC levels lost per hour at full discharge power
    const k0 = Math.round(s0 * K);
    const NEG = -1e15;
    let V = new Float64Array(K + 1).fill(NEG);
    for (let k = k0; k <= K; k++) V[k] = 0;            // terminal: end at least at the start SoC
    const pol = Array.from({ length: T }, () => new Int16Array(K + 1));
    const reward = (t, dk) => {
      const dE = dk * ds;
      if (dk > 0) return -prices[t] * dE / eta - deg * dE;
      if (dk < 0) return prices[t] * (-dE) * eta - deg * (-dE);
      return 0;
    };
    for (let t = T - 1; t >= 0; t--) {
      const Vn = new Float64Array(K + 1).fill(NEG);
      const up = Math.min(upMax, Math.floor((Math.min(chargeCap[t], P) * eta) / ds + 1e-9));
      for (let k = 0; k <= K; k++) {
        let best = NEG, arg = 0;
        for (let dk = -Math.min(dnMax, k); dk <= Math.min(up, K - k); dk++) {
          const v = V[k + dk]; if (v <= NEG / 2) continue;
          const val = reward(t, dk) + v;
          if (val > best + 1e-9 || (Math.abs(val - best) <= 1e-9 && Math.abs(dk) < Math.abs(arg))) { best = val; arg = dk; }
        }
        Vn[k] = best; pol[t][k] = arg;
      }
      V = Vn;
    }
    // forward pass
    const soc = [k0 * ds], grid = [];
    let k = k0, profit = 0, thru = 0, buy = 0, buyE = 0, sell = 0, sellE = 0;
    for (let t = 0; t < T; t++) {
      const dk = pol[t][k], dE = dk * ds;
      const g = dk > 0 ? -dE / eta : dk < 0 ? -dE * eta : 0;   // + export, − import (MW over 1 h)
      profit += reward(t, dk); thru += Math.abs(dE);
      if (g < 0) { buy += -g * prices[t]; buyE += -g; } else if (g > 0) { sell += g * prices[t]; sellE += g; }
      grid.push(g); k += dk; soc.push(k * ds);
    }
    return { soc, grid, profit, cycles: thru / (2 * E), buyAvg: buyE ? buy / buyE : null, sellAvg: sellE ? sell / sellE : null, feasible: V[k0] > NEG / 2 };
  };

  B.run = async () => {
    const d = A.data; if (!d) throw new Error('Run a forecast first (Forecast tab).');
    const { lam, src } = await A.market.prices(d.hours);
    const E = A.num('bE'), P = A.num('bP'), rte = A.clamp(A.num('bEta') / 100, 0.3, 1), s0 = A.clamp(A.num('bS0') / 100, 0, 1), deg = A.num('bDeg');
    const srcSel = $('bSrc').value;
    const cap = srcSel === 'grid' ? d.hours.map(() => Infinity) : d.q[srcSel].p50.map((x) => Math.max(0, x ?? 0));
    const r = B.dp({ prices: lam, E, P, rte, s0, deg, chargeCap: cap });
    const labels = d.hours.map((h) => A.fmtTime(h));
    A.chart('cSoc', 'line', [...labels, 'end'], [{ label: 'State of charge', data: r.soc, borderColor: A.series(2), fill: { target: 'origin', above: A.alpha(A.series(2), 0.12) } }],
      { unit: 'MWh', y: { max: E } });
    A.chart('cBat', 'bar', labels, [
      { label: 'Discharge (export)', data: r.grid.map((g) => (g > 0 ? g : 0)), backgroundColor: A.series(1), barPercentage: 0.9, categoryPercentage: 1 },
      { label: 'Charge (import)', data: r.grid.map((g) => (g < 0 ? g : 0)), backgroundColor: A.series(0), barPercentage: 0.9, categoryPercentage: 1 },
    ], { unit: 'MW', zero: false, stacked: true });
    const kpi = (l, v, u, x) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}<span class="u">${u}</span></div><div class="r">${x}</div></div>`;
    $('bKpis').innerHTML =
      kpi('Arbitrage profit', A.fmt(r.profit, 0), '€', `${d.hours.length} h · prices: ${src}`) +
      kpi('Full cycles', A.fmt(r.cycles, 2), '', `${A.fmt(r.cycles / (d.hours.length / 24), 2)} per day`) +
      kpi('Avg. buy price', A.fmt(r.buyAvg), '€/MWh', 'energy-weighted') +
      kpi('Avg. sell price', A.fmt(r.sellAvg), '€/MWh', `spread ${A.fmt((r.sellAvg ?? 0) - (r.buyAvg ?? 0))} €/MWh`);
    const spread = Math.max(...lam) - Math.min(...lam);
    A.status('bStatus', !r.feasible ? 'Infeasible: cannot return to the start SoC with the charging source chosen.'
      : spread < 1 ? 'Prices are flat in this period, so there is nothing to arbitrage. Select a price area (e.g. DK1) for real prices.'
        : `Optimal by backward induction over ${d.hours.length} stages × 41 SoC levels. End SoC ≥ start SoC enforced.`, r.feasible ? 'ok' : 'error');
  };

  /* ---------- lecture MDP: battery + two-state Markov price ---------- */
  B.mdp = ({ E, P, lo, hi, plh, phl, gamma }) => {
    const K = Math.max(1, Math.round(E / P));                 // SoC levels 0..K (steps of P)
    const prices = [lo, hi], Ptr = [[1 - plh, plh], [phl, 1 - phl]];
    const states = []; for (let k = 0; k <= K; k++) for (let j = 0; j < 2; j++) states.push([k, j]);
    const sid = (k, j) => k * 2 + j;
    const acts = { charge: 1, idle: 0, discharge: -1 };
    const avail = (k) => Object.keys(acts).filter((a) => k + acts[a] >= 0 && k + acts[a] <= K);
    const R = (k, j, a) => -acts[a] * prices[j] * P;           // charge pays, discharge earns
    const Q = (V, k, j, a) => R(k, j, a) + gamma * (Ptr[j][0] * V[sid(k + acts[a], 0)] + Ptr[j][1] * V[sid(k + acts[a], 1)]);

    // value iteration
    let V = new Array(states.length).fill(0); const deltas = [];
    for (let it = 0; it < 5000; it++) {
      const Vn = states.map(([k, j]) => Math.max(...avail(k).map((a) => Q(V, k, j, a))));
      const dlt = Math.max(...Vn.map((v, i) => Math.abs(v - V[i]))); deltas.push(dlt); V = Vn;
      if (dlt < 1e-6) break;
    }
    const greedy = (V) => states.map(([k, j]) => avail(k).reduce((b, a) => (Q(V, k, j, a) > Q(V, k, j, b) + 1e-9 ? a : b), 'idle'));
    const piVI = greedy(V);

    // policy iteration (exact evaluation: (I − γPπ)V = Rπ)
    let pi = states.map(() => 'idle'), piIters = 0, Vpi = null;
    for (; piIters < 100; piIters++) {
      const n = states.length, M = Array.from({ length: n }, (_, r) => Array(n).fill(0)), b = Array(n).fill(0);
      states.forEach(([k, j], r) => { const a = pi[r], k2 = k + acts[a];
        M[r][r] += 1; M[r][sid(k2, 0)] -= gamma * Ptr[j][0]; M[r][sid(k2, 1)] -= gamma * Ptr[j][1]; b[r] = R(k, j, a); });
      Vpi = A.solve(M, b);
      const newPi = greedy(Vpi);
      if (newPi.every((a, i) => a === pi[i])) break;
      pi = newPi;
    }
    return { K, states, V, piVI, piPI: pi, Vpi, deltas, viIters: deltas.length, piIters: piIters + 1 };
  };

  B.runMdp = () => {
    const p = { E: A.num('mE'), P: A.num('mP'), lo: A.num('mLo'), hi: A.num('mHi'), plh: A.clamp(A.num('mPlh'), 0, 1), phl: A.clamp(A.num('mPhl'), 0, 1), gamma: A.clamp(A.num('mGamma'), 0, 0.999) };
    if (p.P <= 0 || p.E <= 0) throw new Error('Capacity and power must be positive');
    const r = B.mdp(p);
    const tag = (a) => `<span class="tag ${a === 'charge' ? 'ch' : a === 'discharge' ? 'dis' : 'idle'}">${a}</span>`;
    const rows = [];
    for (let k = r.K; k >= 0; k--) {
      const i0 = k * 2, i1 = k * 2 + 1;
      rows.push([`SoC ${A.fmt(k * p.P, 0)} MWh`, `${tag(r.piVI[i0])} V*=${A.fmt(r.V[i0], 0)}`, `${tag(r.piVI[i1])} V*=${A.fmt(r.V[i1], 0)}`]);
    }
    A.table($('mPolicy'), ['State', `Low price (${p.lo})`, `High price (${p.hi})`], rows);
    const agree = r.piVI.every((a, i) => a === r.piPI[i]);
    $('mInfo').textContent = `Value iteration: ${r.viIters} sweeps to |ΔV| < 1e-6. Policy iteration: ${r.piIters} improvement steps. ` +
      (agree ? 'Both give the same optimal policy.' : 'Policies differ only where actions tie.');
    A.chart('cConv', 'line', r.deltas.map((_, i) => i + 1), [{ label: 'max |ΔV|', data: r.deltas, borderColor: A.series(6) }],
      { y: { type: 'logarithmic' }, zero: false, xtitle: 'iteration', digits: 4 });
  };

  B.init = () => {
    $('bRun').addEventListener('click', (e) => A.busy(e.target, B.run));
    $('mRun').addEventListener('click', (e) => A.busy(e.target, async () => B.runMdp()));
  };
})(window.App);
