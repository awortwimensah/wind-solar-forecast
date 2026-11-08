"""
Operational run: download NWP -> power -> bias correction -> ensemble quantiles -> ML
-> docs/data/forecast.json (read by the dashboard).

    python backend/forecast.py            # run from the repository root
"""
from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import openmeteo as om          # noqa: E402
import physics as ph            # noqa: E402
import postprocess as pp        # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("forecast")
OUT = "docs/data/forecast.json"


def load_config(path: str = "backend/config.json") -> dict:
    with open(path) as f:
        return json.load(f)


def run_physics(wx: pd.DataFrame, cfg: dict, pc: ph.PowerCurve) -> dict:
    s = cfg["site"]
    return {"wx": wx,
            "wind": ph.wind_farm_power(wx, cfg["wind"], pc),
            "solar": ph.pv_from_weather(wx, cfg["solar"], s["latitude"], s["longitude"])}


def corrected_power(r: dict, model: str, bias: dict | None, cfg: dict, pc: ph.PowerCurve):
    """Apply quantile mapping to hub wind speed and a scale factor to PV."""
    ws = pp.apply_qm(r["wind"]["ws_hub"].values, pp.pick(bias and bias.get("wind_qm"), model))
    wind = ph.wind_power_from_speed(ws, r["wind"]["rho"].values, cfg["wind"], pc)
    k = pp.pick(bias and bias.get("solar_scale"), model) or 1.0
    solar = np.clip(r["solar"]["power_mw"].values * k, 0, ph.solar_capacity_mw(cfg["solar"]))
    return ws, wind, solar


def clean(a, nd=3):
    return [None if (v is None or not np.isfinite(v)) else round(float(v), nd) for v in np.asarray(a, float)]


def main(cfg: dict | None = None, out_path: str = OUT) -> dict:
    cfg = cfg or load_config()
    s, days = cfg["site"], cfg["forecast_days"]
    lat, lon = s["latitude"], s["longitude"]
    pc = ph.load_power_curve(cfg["wind"])
    cap_w, cap_s = ph.wind_capacity_mw(cfg["wind"], pc), ph.solar_capacity_mw(cfg["solar"])
    bias = pp.load_bias()
    warnings: list[str] = []

    # ---- 1. deterministic models ------------------------------------------ #
    raw, det = {}, {}
    for m in cfg["deterministic_models"]:
        try:
            raw[m] = run_physics(om.deterministic(m, lat, lon, days), cfg, pc)
            log.info("deterministic %s ok", m)
        except Exception as e:
            warnings.append(f"Model {m} unavailable: {e}")
            log.warning(warnings[-1])
    if not raw:
        raise SystemExit("No deterministic model could be downloaded")
    index = next(iter(raw.values()))["wx"].index
    for m, r in raw.items():
        ws, w, so = corrected_power(r, m, bias, cfg, pc)
        det[m] = {"ws": pd.Series(ws, r["wx"].index).reindex(index).values,
                  "wind": pd.Series(w, r["wx"].index).reindex(index).values,
                  "solar": pd.Series(so, r["wx"].index).reindex(index).values}

    det_mean_w = np.nanmean([d["wind"] for d in det.values()], axis=0)
    det_mean_s = np.nanmean([d["solar"] for d in det.values()], axis=0)

    # ---- 2. ensembles -> P10/P50/P90 -------------------------------------- #
    mem_w, mem_s, ens_used = [], [], []
    for m in cfg.get("ensemble_models", []):
        try:
            members = om.ensemble(m, lat, lon, days)
        except Exception as e:
            warnings.append(f"Ensemble {m} unavailable: {e}")
            log.warning(warnings[-1])
            continue
        for mid, wx in members.items():
            wx = wx.reindex(index)
            r = run_physics(wx, cfg, pc)
            _, w, so = corrected_power(r, m, bias, cfg, pc)
            mem_w.append(w)
            mem_s.append(so)
        ens_used.append(f"{m} ({len(members)} members)")
        log.info("ensemble %s: %d members", m, len(members))

    def quant(stack, fallback):
        if len(stack) >= 5:
            a = np.vstack(stack)
            with np.errstate(all="ignore"):
                return {f"p{q}": np.nanpercentile(a, q, axis=0) for q in (10, 50, 90)}, a
        a = np.vstack(fallback)  # few members: use deterministic min/mean/max
        return {"p10": np.nanmin(a, 0), "p50": np.nanmean(a, 0), "p90": np.nanmax(a, 0)}, a

    ens_w, arr_w = quant(mem_w, [d["wind"] for d in det.values()])
    ens_s, arr_s = quant(mem_s, [d["solar"] for d in det.values()])
    if not mem_w:
        warnings.append("No ensemble data: P10/P90 show deterministic model min/max instead")

    # ---- 3. machine learning ---------------------------------------------- #
    ml = {"wind": None, "solar": None}
    if os.path.exists(pp.ML_PATH):
        import joblib
        bundle = joblib.load(pp.ML_PATH)
        X = pp.build_features(raw, index)
        for k, cap in (("wind", cap_w), ("solar", cap_s)):
            if k in bundle:
                ml[k] = pp.ml_predict(bundle[k], X, cap)
        log.info("ML models applied")

    # ---- 4. best estimate & daily totals ---------------------------------- #
    best_w = ml["wind"]["p50"] if ml["wind"] else ens_w["p50"]
    best_s = ml["solar"]["p50"] if ml["solar"] else ens_s["p50"]
    tz = s.get("timezone", "UTC")
    local_day = index.tz_convert(tz).strftime("%Y-%m-%d")

    def daily(arr_members, best):
        df = pd.DataFrame(arr_members.T, index=local_day).groupby(level=0).sum(min_count=1)
        b = pd.Series(best, index=local_day).groupby(level=0).sum(min_count=1)
        return {"date": list(b.index), "best": clean(b.values, 2),
                "p10": clean(df.quantile(0.1, axis=1).values, 2),
                "p90": clean(df.quantile(0.9, axis=1).values, 2)}

    metrics = None
    if os.path.exists(pp.METRICS_PATH):
        with open(pp.METRICS_PATH) as f:
            metrics = json.load(f)

    result = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "site": s,
        "capacity_mw": {"wind": round(cap_w, 2), "solar": round(cap_s, 2)},
        "time_utc": [t.strftime("%Y-%m-%dT%H:%MZ") for t in index],
        "wind": {
            "ws_hub": {m: clean(d["ws"], 2) for m, d in det.items()},
            "models": {m: clean(d["wind"]) for m, d in det.items()},
            "det_mean": clean(det_mean_w),
            "ens": {k: clean(v) for k, v in ens_w.items()},
            "ml": {k: clean(v) for k, v in ml["wind"].items()} if ml["wind"] else None,
            "best": clean(best_w),
            "daily": daily(arr_w, best_w),
        },
        "solar": {
            "models": {m: clean(d["solar"]) for m, d in det.items()},
            "det_mean": clean(det_mean_s),
            "ens": {k: clean(v) for k, v in ens_s.items()},
            "ml": {k: clean(v) for k, v in ml["solar"].items()} if ml["solar"] else None,
            "best": clean(best_s),
            "daily": daily(arr_s, best_s),
        },
        "status": {
            "bias_correction": bool(bias),
            "ml": bool(ml["wind"] or ml["solar"]),
            "ensembles": ens_used,
            "pvlib": ph.HAVE_PVLIB,
            "windpowerlib": ph.HAVE_WINDPOWERLIB,
            "warnings": warnings,
        },
        "metrics": metrics,
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(result, f, separators=(",", ":"))
    log.info("wrote %s (%d hours)", out_path, len(index))
    return result


if __name__ == "__main__":
    main()
