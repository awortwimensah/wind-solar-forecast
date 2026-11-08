"""Bias correction (quantile mapping / scaling) and ML feature engineering."""
from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

QUANTILES = (0.1, 0.5, 0.9)
BIAS_PATH = "models/bias.json"
ML_PATH = "models/ml_models.joblib"
METRICS_PATH = "models/metrics.json"


# --------------------------------------------------------------------------- #
# Bias correction
# --------------------------------------------------------------------------- #
def fit_qm(fc, obs, n: int = 99) -> dict:
    """Empirical quantile mapping: forecast-quantile -> observed-quantile."""
    fc, obs = np.asarray(fc, float), np.asarray(obs, float)
    ok = np.isfinite(fc) & np.isfinite(obs)
    qs = np.linspace(0.01, 0.99, n)
    return {"fq": np.quantile(fc[ok], qs).round(4).tolist(),
            "oq": np.quantile(obs[ok], qs).round(4).tolist(), "n": int(ok.sum())}


def apply_qm(x, qm: dict | None) -> np.ndarray:
    x = np.asarray(x, float)
    if not qm:
        return x
    fq, oq = np.asarray(qm["fq"]), np.asarray(qm["oq"])
    y = np.interp(x, fq, oq)
    y = np.where(x < fq[0], x + (oq[0] - fq[0]), y)      # constant-offset tails
    y = np.where(x > fq[-1], x + (oq[-1] - fq[-1]), y)
    return np.where(np.isfinite(x), np.clip(y, 0, None), np.nan)


def fit_scale(fc, obs) -> float:
    """Least-squares scale factor through the origin (daylight hours only)."""
    fc, obs = np.asarray(fc, float), np.asarray(obs, float)
    ok = np.isfinite(fc) & np.isfinite(obs) & (fc > 0)
    if ok.sum() < 24:
        return 1.0
    k = float((fc[ok] * obs[ok]).sum() / (fc[ok] ** 2).sum())
    return round(float(np.clip(k, 0.5, 1.5)), 4)


def load_bias() -> dict | None:
    if os.path.exists(BIAS_PATH):
        with open(BIAS_PATH) as f:
            return json.load(f)
    return None


def pick(table: dict | None, model: str):
    """Model-specific correction, else the pooled one (e.g. ensemble 'gfs025' -> pooled)."""
    if not table:
        return None
    return table.get(model, table.get("_pooled"))


# --------------------------------------------------------------------------- #
# ML features
# --------------------------------------------------------------------------- #
def build_features(raw: dict[str, dict], index: pd.DatetimeIndex) -> pd.DataFrame:
    """raw[model] = {'wx': weather df, 'wind': df(ws_hub, rho, power_mw), 'solar': df(poa, zenith, power_mw)}"""
    X = pd.DataFrame(index=index)
    ws_cols, poa_cols = [], []
    for m, r in raw.items():
        w, s, wx = r["wind"].reindex(index), r["solar"].reindex(index), r["wx"].reindex(index)
        X[f"ws_hub__{m}"] = w["ws_hub"]
        X[f"poa__{m}"] = s["poa"]
        X[f"cloud__{m}"] = wx.get("cloud_cover")
        ws_cols.append(f"ws_hub__{m}")
        poa_cols.append(f"poa__{m}")
    X["ws_hub_mean"] = X[ws_cols].mean(axis=1)
    X["ws_hub_spread"] = X[ws_cols].std(axis=1)
    X["poa_mean"] = X[poa_cols].mean(axis=1)
    X["poa_spread"] = X[poa_cols].std(axis=1)

    # shared meteorology from the first model that has it
    first = next(iter(raw.values()))
    wx = first["wx"].reindex(index)
    X["rho"] = first["wind"].reindex(index)["rho"]
    X["t2m"] = wx.get("temperature_2m")
    if "wind_direction_100m" in wx:
        d = np.radians(wx["wind_direction_100m"])
        X["dir_sin"], X["dir_cos"] = np.sin(d), np.cos(d)
    if "wind_speed_10m" in wx and "wind_speed_100m" in wx:
        with np.errstate(all="ignore"):
            X["shear_alpha"] = np.log(wx["wind_speed_100m"] / wx["wind_speed_10m"]) / np.log(10)
    X["cos_zenith"] = np.cos(np.radians(first["solar"].reindex(index)["zenith"]))
    h = index.hour.values
    X["hod_sin"], X["hod_cos"] = np.sin(2 * np.pi * h / 24), np.cos(2 * np.pi * h / 24)
    doy = index.dayofyear.values
    X["doy_sin"], X["doy_cos"] = np.sin(2 * np.pi * doy / 365.25), np.cos(2 * np.pi * doy / 365.25)
    return X.replace([np.inf, -np.inf], np.nan)


def ml_predict(bundle: dict, X: pd.DataFrame, cap: float) -> dict[str, np.ndarray]:
    Xa = X.reindex(columns=bundle["features"])
    preds = {f"p{int(q*100)}": np.clip(est.predict(Xa), 0, cap) for q, est in bundle["q"].items()}
    # enforce non-crossing quantiles
    stack = np.sort(np.vstack([preds["p10"], preds["p50"], preds["p90"]]), axis=0)
    preds["p10"], preds["p50"], preds["p90"] = stack
    if "zenith_mask" in bundle and "cos_zenith" in X:
        night = ~(X["cos_zenith"].values > 0.02)
        for k in preds:
            preds[k] = np.where(night, 0.0, preds[k])
    return preds
