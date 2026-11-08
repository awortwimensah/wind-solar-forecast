"""
Physical conversion of NWP output to wind-farm and PV-plant power.

Uses windpowerlib / pvlib when they are installed (and configured), otherwise
falls back to built-in implementations of the same textbook methods, so the
pipeline always runs.
"""
from __future__ import annotations

import logging
import numpy as np
import pandas as pd

log = logging.getLogger(__name__)
RHO0 = 1.225  # IEC standard air density, kg/m3

try:
    import pvlib  # type: ignore
    HAVE_PVLIB = True
except Exception:  # pragma: no cover
    HAVE_PVLIB = False

try:
    import windpowerlib  # type: ignore
    HAVE_WINDPOWERLIB = True
except Exception:  # pragma: no cover
    HAVE_WINDPOWERLIB = False


# --------------------------------------------------------------------------- #
# WIND
# --------------------------------------------------------------------------- #
def hub_height_wind(v10, v100, hub_m: float, alpha_default: float = 0.143) -> np.ndarray:
    """Power-law extrapolation to hub height.

    The shear exponent alpha is fitted every hour from the 10 m / 100 m pair,
    so stable nights (high alpha) and convective days (low alpha) are handled.
    """
    v10 = np.asarray(v10, dtype=float)
    v100 = np.asarray(v100, dtype=float)
    with np.errstate(all="ignore"):
        alpha = np.log(v100 / v10) / np.log(10.0)
    ok = np.isfinite(alpha) & (v10 > 0.5) & (v100 > 0.5)
    alpha = np.where(ok, np.clip(alpha, 0.0, 0.5), alpha_default)
    return np.where(
        np.isfinite(v100),
        v100 * (hub_m / 100.0) ** alpha,
        v10 * (hub_m / 10.0) ** alpha_default,
    )


def air_density(p_sfc_hpa, t2m_c, hub_m: float) -> np.ndarray:
    """Air density at hub height from surface pressure and 2 m temperature."""
    p = np.asarray(p_sfc_hpa, dtype=float) * 100.0
    t_sfc = np.asarray(t2m_c, dtype=float) + 273.15
    t_hub = t_sfc - 0.0065 * hub_m
    p_hub = p * (1 - 0.0065 * hub_m / t_sfc) ** 5.255
    rho = p_hub / (287.05 * t_hub)
    return np.where(np.isfinite(rho), rho, RHO0)


class PowerCurve:
    """Turbine power curve (kW) with IEC 61400-12-1 density correction."""

    def __init__(self, speeds_ms, power_kw):
        order = np.argsort(speeds_ms)
        self.v = np.asarray(speeds_ms, dtype=float)[order]
        self.p = np.asarray(power_kw, dtype=float)[order]
        self.rated_kw = float(self.p.max())
        # cut-out: last speed with non-zero power
        self.v_cutout = float(self.v[np.nonzero(self.p)[0][-1]])

    # -- constructors ------------------------------------------------------- #
    @classmethod
    def from_csv(cls, path: str) -> "PowerCurve":
        df = pd.read_csv(path)
        return cls(df["wind_speed_ms"].values, df["power_kw"].values)

    @classmethod
    def from_windpowerlib(cls, turbine_type: str, hub_m: float) -> "PowerCurve":
        """Load a manufacturer curve from the Open Energy Database via windpowerlib.
        Example turbine_type: 'E-126/4200', 'V112/3450' (see windpowerlib.get_turbine_types())."""
        from windpowerlib import WindTurbine  # type: ignore
        t = WindTurbine(hub_height=hub_m, turbine_type=turbine_type)
        pc = t.power_curve  # columns: wind_speed (m/s), value (W)
        return cls(pc["wind_speed"].values, pc["value"].values / 1000.0)

    @classmethod
    def generic(cls, rated_kw, v_in=3.0, v_rated=12.0, v_out=25.0) -> "PowerCurve":
        v = np.arange(0, v_out + 0.01, 0.5)
        p = np.where(v < v_in, 0, rated_kw * (v**3 - v_in**3) / (v_rated**3 - v_in**3))
        p = np.clip(p, 0, rated_kw)
        v = np.append(v, v_out + 0.01)
        p = np.append(p, 0)
        return cls(v, p)

    # -- evaluation ---------------------------------------------------------- #
    def __call__(self, ws, rho=RHO0) -> np.ndarray:
        ws = np.asarray(ws, dtype=float)
        v_eq = ws * np.cbrt(np.asarray(rho, dtype=float) / RHO0)
        out = np.interp(v_eq, self.v, self.p, left=0.0, right=0.0)
        out = np.where(ws > self.v_cutout, 0.0, out)
        return np.where(np.isfinite(ws), out, np.nan)


def farm_efficiency_speed(ws, curve_name: str | None) -> np.ndarray:
    """Optional wind-farm (wake) efficiency via windpowerlib's dena / knorr curves.
    Note: these are aggregate farm-efficiency curves, not a full wake model
    (use PyWake / FLORIS for layout-resolved wakes)."""
    ws = np.asarray(ws, dtype=float)
    if not curve_name:
        return ws
    if not HAVE_WINDPOWERLIB:
        log.warning("windpowerlib not installed: efficiency curve '%s' skipped", curve_name)
        return ws
    try:
        from windpowerlib.wake_losses import reduce_wind_speed  # type: ignore
        return np.asarray(reduce_wind_speed(pd.Series(ws), wind_efficiency_curve_name=curve_name), dtype=float)
    except Exception as e:  # pragma: no cover
        log.warning("windpowerlib efficiency curve failed (%s); skipped", e)
        return ws


def load_power_curve(wcfg: dict) -> PowerCurve:
    tt = wcfg.get("windpowerlib_turbine_type")
    if tt and HAVE_WINDPOWERLIB:
        try:
            pc = PowerCurve.from_windpowerlib(tt, wcfg["hub_height_m"])
            log.info("Using windpowerlib/OEDB power curve for %s", tt)
            return pc
        except Exception as e:
            log.warning("windpowerlib curve for %s failed (%s); falling back to CSV", tt, e)
    return PowerCurve.from_csv(wcfg["power_curve_csv"])


def wind_farm_power(df: pd.DataFrame, wcfg: dict, pc: PowerCurve) -> pd.DataFrame:
    """df needs wind_speed_10m, wind_speed_100m [m/s], temperature_2m, surface_pressure."""
    hub = wcfg["hub_height_m"]
    ws = hub_height_wind(df.get("wind_speed_10m"), df.get("wind_speed_100m"),
                         hub, wcfg.get("default_shear_alpha", 0.143))
    rho = air_density(df.get("surface_pressure"), df.get("temperature_2m"), hub)
    out = pd.DataFrame(index=df.index)
    out["ws_hub"] = ws
    out["rho"] = rho
    out["power_mw"] = wind_power_from_speed(ws, rho, wcfg, pc)
    return out


def wind_power_from_speed(ws, rho, wcfg: dict, pc: PowerCurve) -> np.ndarray:
    ws_eff = farm_efficiency_speed(ws, wcfg.get("windpowerlib_efficiency_curve"))
    p_kw = pc(ws_eff, rho) * wcfg["n_turbines"]
    return p_kw / 1000.0 * (1 - wcfg.get("other_losses_pct", 0) / 100.0)


def wind_capacity_mw(wcfg: dict, pc: PowerCurve) -> float:
    return pc.rated_kw * wcfg["n_turbines"] / 1000.0 * (1 - wcfg.get("other_losses_pct", 0) / 100.0)


# --------------------------------------------------------------------------- #
# SOLAR
# --------------------------------------------------------------------------- #
def _solar_position_builtin(times_utc: pd.DatetimeIndex, lat: float, lon: float):
    """NOAA / Spencer approximation. Returns zenith, azimuth (deg, from north, clockwise)."""
    doy = times_utc.dayofyear.values
    hour = times_utc.hour.values + times_utc.minute.values / 60.0
    g = 2 * np.pi / 365.0 * (doy - 1 + (hour - 12) / 24.0)
    eqt = 229.18 * (0.000075 + 0.001868 * np.cos(g) - 0.032077 * np.sin(g)
                    - 0.014615 * np.cos(2 * g) - 0.040849 * np.sin(2 * g))
    decl = (0.006918 - 0.399912 * np.cos(g) + 0.070257 * np.sin(g) - 0.006758 * np.cos(2 * g)
            + 0.000907 * np.sin(2 * g) - 0.002697 * np.cos(3 * g) + 0.00148 * np.sin(3 * g))
    tst = hour * 60 + eqt + 4 * lon
    ha = np.radians(tst / 4.0 - 180.0)
    la = np.radians(lat)
    cosz = np.sin(la) * np.sin(decl) + np.cos(la) * np.cos(decl) * np.cos(ha)
    zen = np.degrees(np.arccos(np.clip(cosz, -1, 1)))
    az = np.degrees(np.arctan2(np.sin(ha), np.cos(ha) * np.sin(la) - np.tan(decl) * np.cos(la))) + 180.0
    return zen, az % 360


def _extra_radiation(times_utc: pd.DatetimeIndex) -> np.ndarray:
    return 1367.0 * (1 + 0.033 * np.cos(2 * np.pi * times_utc.dayofyear.values / 365.0))


def _erbs(ghi, zen, i0):
    cosz = np.cos(np.radians(zen))
    with np.errstate(all="ignore"):
        kt = np.clip(ghi / (i0 * np.maximum(cosz, 0.065)), 0, 1)
    df = np.where(kt <= 0.22, 1 - 0.09 * kt,
         np.where(kt <= 0.8, 0.9511 - 0.1604 * kt + 4.388 * kt**2 - 16.638 * kt**3 + 12.336 * kt**4,
                  0.165))
    dhi = df * ghi
    dni = np.where(cosz > 0.065, (ghi - dhi) / np.maximum(cosz, 0.065), 0.0)
    return np.clip(dni, 0, None), dhi


def plane_of_array(times_end_utc: pd.DatetimeIndex, ghi, scfg: dict, lat: float, lon: float,
                   dni=None, dhi=None) -> pd.DataFrame:
    """Transpose horizontal irradiance to the module plane.

    Open-Meteo radiation is the mean of the PRECEDING hour, so the sun position
    is evaluated at the middle of that hour (t - 30 min)."""
    t_mid = times_end_utc - pd.Timedelta(minutes=30)
    ghi = np.nan_to_num(np.asarray(ghi, dtype=float), nan=0.0)
    tilt, surf_az, albedo = scfg["tilt_deg"], scfg["azimuth_deg"], scfg.get("albedo", 0.2)

    if HAVE_PVLIB:
        sp = pvlib.solarposition.get_solarposition(t_mid, lat, lon)
        zen, az = sp["apparent_zenith"].values, sp["azimuth"].values
        if dni is None or dhi is None:
            e = pvlib.irradiance.erbs(ghi, zen, t_mid)
            dni, dhi = np.asarray(e["dni"]), np.asarray(e["dhi"])
        irr = pvlib.irradiance.get_total_irradiance(
            tilt, surf_az, zen, az, np.nan_to_num(dni), ghi, np.nan_to_num(dhi),
            dni_extra=pvlib.irradiance.get_extra_radiation(t_mid),
            albedo=albedo, model="haydavies")
        poa = np.asarray(irr["poa_global"], dtype=float)
    else:
        zen, az = _solar_position_builtin(t_mid, lat, lon)
        if dni is None or dhi is None:
            dni, dhi = _erbs(ghi, zen, _extra_radiation(t_mid))
        dni, dhi = np.nan_to_num(np.asarray(dni, float)), np.nan_to_num(np.asarray(dhi, float))
        tr, zr = np.radians(tilt), np.radians(zen)
        cos_aoi = np.cos(zr) * np.cos(tr) + np.sin(zr) * np.sin(tr) * np.cos(np.radians(az - surf_az))
        poa = (dni * np.clip(cos_aoi, 0, None)
               + dhi * (1 + np.cos(tr)) / 2
               + ghi * albedo * (1 - np.cos(tr)) / 2)
    poa = np.where(zen < 90, poa, 0.0)
    return pd.DataFrame({"poa": np.clip(poa, 0, None), "zenith": zen}, index=times_end_utc)


def pv_plant_power(poa, t_air_c, wind10_ms, scfg: dict) -> np.ndarray:
    """PVWatts-style DC model with Faiman cell temperature, losses and inverter clipping (MW)."""
    poa = np.asarray(poa, dtype=float)
    ta = np.nan_to_num(np.asarray(t_air_c, dtype=float), nan=25.0)
    ws = np.nan_to_num(np.asarray(wind10_ms, dtype=float), nan=1.0)
    t_cell = ta + poa / (scfg.get("faiman_u0", 25.0) + scfg.get("faiman_u1", 6.84) * ws)
    gamma = scfg.get("gamma_pdc_pct_per_c", -0.35) / 100.0
    p_dc_kw = scfg["dc_capacity_kwp"] * poa / 1000.0 * (1 + gamma * (t_cell - 25.0))
    p_kw = p_dc_kw * (1 - scfg.get("losses_pct", 0) / 100.0)
    p_kw = np.clip(p_kw, 0, scfg.get("ac_capacity_kw", np.inf))
    return p_kw / 1000.0


def solar_capacity_mw(scfg: dict) -> float:
    return min(scfg["dc_capacity_kwp"], scfg.get("ac_capacity_kw", np.inf)) / 1000.0


def pv_from_weather(df: pd.DataFrame, scfg: dict, lat: float, lon: float) -> pd.DataFrame:
    """df (index = UTC hour-ending) needs shortwave_radiation; optional DNI/DHI, temperature_2m, wind_speed_10m."""
    dni = df["direct_normal_irradiance"].values if "direct_normal_irradiance" in df else None
    dhi = df["diffuse_radiation"].values if "diffuse_radiation" in df else None
    if dni is not None and np.isnan(dni).all():
        dni = dhi = None
    pa = plane_of_array(df.index, df["shortwave_radiation"].values, scfg, lat, lon, dni, dhi)
    pa["power_mw"] = pv_plant_power(pa["poa"], df.get("temperature_2m"), df.get("wind_speed_10m"), scfg)
    return pa
