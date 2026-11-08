"""
Train bias correction + ML models from your own measurements.

    python backend/train.py --measurements data/measurements.csv

Measurements CSV (hourly or finer, UTC timestamps, any subset of columns):
    time,wind_power_mw,wind_speed_hub,solar_power_mw
    2025-06-01T00:00Z,12.4,7.9,0
    ...
Values are averaged to hourly, labelled at the END of the hour (hour-ending),
matching Open-Meteo radiation conventions.

Writes models/bias.json, models/ml_models.joblib, models/metrics.json.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import openmeteo as om           # noqa: E402
import physics as ph             # noqa: E402
import postprocess as pp         # noqa: E402
from forecast import load_config, run_physics  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("train")


def load_measurements(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    t = pd.to_datetime(df.pop("time"), utc=True)
    df.index = t
    # hour-ending averages: (00:00, 01:00] -> 01:00
    return df.astype(float).resample("1h", label="right", closed="right").mean()


def skill(obs, pred, cap) -> dict:
    ok = np.isfinite(obs) & np.isfinite(pred)
    e = pred[ok] - obs[ok]
    return {"nMAE_pct": round(100 * np.abs(e).mean() / cap, 2),
            "nRMSE_pct": round(100 * np.sqrt((e ** 2).mean()) / cap, 2),
            "bias_pct": round(100 * e.mean() / cap, 2), "n_hours": int(ok.sum())}


def pinball(obs, q_pred: dict, cap) -> float:
    ok = np.isfinite(obs)
    tot = 0.0
    for q, p in ((0.1, q_pred["p10"]), (0.5, q_pred["p50"]), (0.9, q_pred["p90"])):
        d = obs[ok] - p[ok]
        tot += np.mean(np.maximum(q * d, (q - 1) * d))
    return round(100 * tot / 3 / cap, 3)


def fit_quantile_gbm(X, y, quantiles=pp.QUANTILES):
    from sklearn.ensemble import HistGradientBoostingRegressor
    models = {}
    for q in quantiles:
        est = HistGradientBoostingRegressor(loss="quantile", quantile=q, max_iter=400,
                                            learning_rate=0.05, max_leaf_nodes=31,
                                            min_samples_leaf=40, l2_regularization=1.0,
                                            early_stopping=True, validation_fraction=0.15,
                                            random_state=0)
        est.fit(X, y)
        models[q] = est
    return models


def main(argv=None, fetch=om.historical):
    ap = argparse.ArgumentParser()
    ap.add_argument("--measurements", required=True)
    ap.add_argument("--config", default="backend/config.json")
    ap.add_argument("--test-fraction", type=float, default=0.2)
    a = ap.parse_args(argv)

    cfg = load_config(a.config)
    s = cfg["site"]
    pc = ph.load_power_curve(cfg["wind"])
    cap_w, cap_s = ph.wind_capacity_mw(cfg["wind"], pc), ph.solar_capacity_mw(cfg["solar"])
    meas = load_measurements(a.measurements)
    start, end = meas.index.min().date(), meas.index.max().date()
    log.info("measurements %s .. %s (%d h)", start, end, len(meas))

    # ---- archived forecasts ------------------------------------------------ #
    raw = {}
    for m in cfg["deterministic_models"]:
        try:
            raw[m] = run_physics(fetch(m, s["latitude"], s["longitude"], start, end), cfg, pc)
            log.info("historical %s ok", m)
        except Exception as e:
            log.warning("historical %s unavailable: %s", m, e)
    if not raw:
        raise SystemExit("No historical forecasts downloaded")

    index = meas.index.intersection(next(iter(raw.values()))["wx"].index)
    meas = meas.reindex(index)
    n_test = int(len(index) * a.test_fraction)
    train_idx, test_idx = index[:-n_test], index[-n_test:]
    log.info("train %d h, test %d h (chronological split)", len(train_idx), len(test_idx))

    bias = {"wind_qm": {}, "solar_scale": {}}
    metrics = {"period": f"{start}..{end}", "test_hours": int(n_test), "wind": {}, "solar": {}}

    # ---- 1. bias correction (fit on TRAIN only) --------------------------- #
    has_ws = "wind_speed_hub" in meas and meas["wind_speed_hub"].notna().sum() > 200
    has_wp = "wind_power_mw" in meas and meas["wind_power_mw"].notna().sum() > 200
    has_sp = "solar_power_mw" in meas and meas["solar_power_mw"].notna().sum() > 200
    pooled_fc, pooled_ob = [], []
    for m, r in raw.items():
        if has_ws:
            fc = r["wind"]["ws_hub"].reindex(train_idx).values
            ob = meas["wind_speed_hub"].reindex(train_idx).values
            bias["wind_qm"][m] = pp.fit_qm(fc, ob)
            pooled_fc.append(fc); pooled_ob.append(ob)
        if has_sp:
            bias["solar_scale"][m] = pp.fit_scale(r["solar"]["power_mw"].reindex(train_idx).values,
                                                  meas["solar_power_mw"].reindex(train_idx).values)
    if pooled_fc:
        bias["wind_qm"]["_pooled"] = pp.fit_qm(np.concatenate(pooled_fc), np.concatenate(pooled_ob))
    if bias["solar_scale"]:
        bias["solar_scale"]["_pooled"] = round(float(np.mean(list(bias["solar_scale"].values()))), 4)

    # physical baselines on TEST: raw mean vs bias-corrected mean
    def phys_mean(corrected: bool):
        w, so = [], []
        for m, r in raw.items():
            ws = r["wind"]["ws_hub"].values
            if corrected:
                ws = pp.apply_qm(ws, pp.pick(bias["wind_qm"], m))
            w.append(pd.Series(ph.wind_power_from_speed(ws, r["wind"]["rho"].values, cfg["wind"], pc),
                               r["wx"].index).reindex(test_idx).values)
            k = pp.pick(bias["solar_scale"], m) if corrected else 1.0
            so.append(r["solar"]["power_mw"].reindex(test_idx).values * (k or 1.0))
        return np.nanmean(w, 0), np.clip(np.nanmean(so, 0), 0, cap_s)

    raw_w, raw_s = phys_mean(False)
    bc_w, bc_s = phys_mean(True)

    # ---- 2. machine learning ---------------------------------------------- #
    X = pp.build_features(raw, index)
    bundle = {}
    for key, target, cap, base_raw, base_bc, ok in (
            ("wind", "wind_power_mw", cap_w, raw_w, bc_w, has_wp),
            ("solar", "solar_power_mw", cap_s, raw_s, bc_s, has_sp)):
        if not ok:
            continue
        y = meas[target]
        obs_test = y.reindex(test_idx).values
        metrics[key]["physical_raw"] = skill(obs_test, base_raw, cap)
        metrics[key]["physical_bias_corrected"] = skill(obs_test, base_bc, cap)

        # solar: fit on daylight hours only (night = 0 is enforced by the zenith mask);
        # otherwise the many night zeros pull the lower quantiles to 0 all day
        use = y.notna() & (X["cos_zenith"] > 0.02) if key == "solar" else y.notna()
        tr = use.reindex(train_idx).values
        models = fit_quantile_gbm(X.loc[train_idx][tr], y.reindex(train_idx)[tr])
        b = {"features": list(X.columns), "q": models}
        if key == "solar":
            b["zenith_mask"] = True
        pred = pp.ml_predict(b, X.loc[test_idx], cap)
        metrics[key]["ml_p50"] = skill(obs_test, pred["p50"], cap)
        metrics[key]["ml_pinball_pct"] = pinball(obs_test, pred, cap)
        cover = np.isfinite(obs_test)
        metrics[key]["ml_p10_p90_coverage_pct"] = round(
            100 * np.mean((obs_test[cover] >= pred["p10"][cover]) & (obs_test[cover] <= pred["p90"][cover])), 1)

        # refit on ALL data for operational use
        allok = use.values
        bundle[key] = {"features": list(X.columns), "q": fit_quantile_gbm(X[allok], y[allok])}
        if key == "solar":
            bundle[key]["zenith_mask"] = True
        log.info("%s: physical nMAE %.2f%% -> bias-corr %.2f%% -> ML %.2f%%", key,
                 metrics[key]["physical_raw"]["nMAE_pct"],
                 metrics[key]["physical_bias_corrected"]["nMAE_pct"],
                 metrics[key]["ml_p50"]["nMAE_pct"])

    # ---- 3. save ------------------------------------------------------------ #
    os.makedirs("models", exist_ok=True)
    with open(pp.BIAS_PATH, "w") as f:
        json.dump(bias, f)
    if bundle:
        import joblib
        joblib.dump(bundle, pp.ML_PATH, compress=3)
    with open(pp.METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=2)
    log.info("saved %s, %s, %s", pp.BIAS_PATH, pp.ML_PATH, pp.METRICS_PATH)
    return metrics


if __name__ == "__main__":
    main()
