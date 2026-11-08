"""Thin client for the free Open-Meteo APIs (no key, non-commercial use)."""
from __future__ import annotations

import logging
import re
import time
from datetime import date, timedelta

import pandas as pd
import requests

log = logging.getLogger(__name__)

URLS = {
    "forecast": "https://api.open-meteo.com/v1/forecast",
    "ensemble": "https://ensemble-api.open-meteo.com/v1/ensemble",
    "historical": "https://historical-forecast-api.open-meteo.com/v1/forecast",
}

DET_VARS = [
    "wind_speed_10m", "wind_speed_100m", "wind_direction_100m", "wind_gusts_10m",
    "temperature_2m", "surface_pressure", "cloud_cover",
    "shortwave_radiation", "direct_normal_irradiance", "diffuse_radiation",
]
ENS_VARS = ["wind_speed_10m", "wind_speed_100m", "temperature_2m",
            "surface_pressure", "shortwave_radiation"]

_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "renewable-forecast/1.0 (open-source)"


def _get(kind: str, params: dict, retries: int = 3) -> dict:
    p = {"wind_speed_unit": "ms", "timezone": "GMT", **params}
    for k, v in list(p.items()):
        if isinstance(v, (list, tuple)):
            p[k] = ",".join(map(str, v))
    for attempt in range(retries):
        try:
            r = _SESSION.get(URLS[kind], params=p, timeout=60)
            j = r.json()
            if r.status_code != 200 or j.get("error"):
                raise RuntimeError(j.get("reason", f"HTTP {r.status_code}"))
            return j
        except Exception as e:
            if attempt == retries - 1:
                raise
            log.warning("%s request failed (%s), retrying…", kind, e)
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("unreachable")


def _frame(hourly: dict) -> pd.DataFrame:
    idx = pd.DatetimeIndex(pd.to_datetime(hourly["time"]), name="time").tz_localize("UTC")
    return pd.DataFrame({k: v for k, v in hourly.items() if k != "time"}, index=idx).astype(float)


def deterministic(model: str, lat: float, lon: float, days: int) -> pd.DataFrame:
    j = _get("forecast", {"latitude": lat, "longitude": lon, "hourly": DET_VARS,
                          "models": model, "forecast_days": days})
    return _frame(j["hourly"])


def historical(model: str, lat: float, lon: float, start: date, end: date,
               chunk_days: int = 90) -> pd.DataFrame:
    """Archived forecasts (for bias correction / ML training), downloaded in chunks."""
    parts, s = [], start
    while s <= end:
        e = min(s + timedelta(days=chunk_days - 1), end)
        j = _get("historical", {"latitude": lat, "longitude": lon, "hourly": DET_VARS,
                                "models": model, "start_date": s.isoformat(), "end_date": e.isoformat()})
        parts.append(_frame(j["hourly"]))
        s = e + timedelta(days=1)
        time.sleep(1)  # be polite to the free service
    return pd.concat(parts).sort_index()


_MEMBER = re.compile(r"^_member(\d+)$")


def ensemble(model: str, lat: float, lon: float, days: int) -> dict[str, pd.DataFrame]:
    """Returns {member_id: DataFrame(variables)}. Control run = member '00'."""
    j = _get("ensemble", {"latitude": lat, "longitude": lon, "hourly": ENS_VARS,
                          "models": model, "forecast_days": days})
    h = j["hourly"]
    idx = pd.DatetimeIndex(pd.to_datetime(h["time"])).tz_localize("UTC")
    members: dict[str, dict] = {}
    for key, vals in h.items():
        for var in ENS_VARS:
            # exact prefix match (so wind_speed_10m does not swallow wind_speed_100m)
            if key == var:
                mid = "00"
            elif key.startswith(var + "_") and (m := _MEMBER.match(key[len(var):])):
                mid = m.group(1).zfill(2)
            else:
                continue
            members.setdefault(mid, {})[var] = vals
    return {mid: pd.DataFrame(d, index=idx).astype(float) for mid, d in sorted(members.items())}
