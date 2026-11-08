# Wind & Solar Power Forecast

A free, self-hosted forecasting system for wind farms and PV plants. It uses open NWP models
(ECMWF IFS, NOAA GFS, DWD ICON, Météo-France) through the free Open-Meteo API, runs every hour
on GitHub Actions and publishes a dashboard on GitHub Pages.

```
NWP (4 deterministic models + ensembles)            Open-Meteo, no API key
      │
      ▼
physics.py     hub-height shear, air density, manufacturer power curve, farm efficiency
               solar position, irradiance decomposition and transposition, cell temperature, inverter clipping
      │
      ▼
postprocess.py quantile-mapping bias correction (wind) and PV scale factor ← trained on your data
      │
      ├── ensemble members → P10 / P50 / P90
      └── gradient-boosting quantile models (P10/P50/P90) ← trained on your data
      │
      ▼
docs/data/forecast.json  →  docs/index.html (dashboard)
```

## Files

| Path | Purpose |
|---|---|
| `backend/config.json` | Site, models, wind farm and PV plant settings: **edit this first** |
| `backend/power_curve.csv` | Turbine power curve (m/s → kW). Replace it with your manufacturer's datasheet values |
| `backend/forecast.py` | Hourly operational run |
| `backend/train.py` | Fits bias correction and ML models from your measurements |
| `backend/physics.py` | Wind and PV conversion models (uses pvlib and windpowerlib when installed) |
| `backend/openmeteo.py` | API client for the forecast, ensemble and historical-forecast APIs |
| `docs/index.html` | Dashboard |
| `docs/live.html` | Browser-only calculator for any site (no backend needed) |
| `.github/workflows/forecast.yml` | Runs the forecast every hour |
| `.github/workflows/train.yml` | Retraining: run it manually, and it also runs monthly |

## Set up (about 15 minutes)

1. Create a GitHub repository and upload everything in this folder, **including the hidden `.github` folder**.
2. Edit `backend/config.json` with your coordinates, number of turbines, hub height, kWp, tilt and azimuth (180 = south).
3. **Settings → Actions → General → Workflow permissions →** select *Read and write permissions*.
4. **Settings → Pages →** *Deploy from a branch* → `main` / `/docs`.
5. **Actions → Hourly power forecast → Run workflow.** After 1–2 minutes the dashboard is live at
   `https://<user>.github.io/<repo>/`. From then on it updates every hour.

To run locally:

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
python backend/forecast.py              # writes docs/data/forecast.json
python -m http.server -d docs 8000      # open http://localhost:8000
```

## 1. Real power curve
Choose one of these:
* Replace `backend/power_curve.csv` with the datasheet values (`wind_speed_ms,power_kw`, including the cut-out row going to 0), **or**
* set `"windpowerlib_turbine_type"` in `config.json`, e.g. `"E-126/4200"` or `"V112/3450"`, to load the curve from the
  Open Energy Database. List the available types with
  `python -c "from windpowerlib import get_turbine_types; print(get_turbine_types(print_out=False))"`.

The curve is applied to density-corrected wind speed: v·(ρ/1.225)^⅓ (IEC 61400-12-1).
`"windpowerlib_efficiency_curve": "dena_mean"` applies an aggregate wind-farm efficiency curve. This is an
approximation. For layout-resolved wake losses, use PyWake or FLORIS.

## 2. Bias correction and 5. Machine learning
1. Export hourly (or 10-minute) plant data to `data/measurements.csv` in the format of `data/measurements_example.csv`.
   Timestamps must be in **UTC**. Any subset of the columns works.
2. Run `python backend/train.py --measurements data/measurements.csv`. It:
   * downloads archived forecasts for the same period from Open-Meteo's Historical Forecast API;
   * fits **quantile mapping** of hub-height wind speed for each model (needs `wind_speed_hub`) and a **PV scale factor** (needs `solar_power_mw`);
   * trains **gradient-boosting quantile regression** (scikit-learn `HistGradientBoostingRegressor`, P10/P50/P90) on features from all models;
   * validates on the most recent 20 % of the data (chronological split) and writes `models/metrics.json`, which the dashboard displays.
3. Commit the `models/` folder. The next hourly run uses the new models automatically.

Practical notes:
* Use at least 3 months of data, preferably 12 or more so the models see every season. Remove curtailment, outage and icing periods first, because the models should learn weather, not downtime.
* The Historical Forecast API stitches together the first hours of successive model runs. Errors measured on it are therefore smaller than what you will see at day-ahead lead times. For lead-time-specific training, use the Previous Runs API (`previous_day1`, `previous_day2`, … variables).
* **Data privacy:** GitHub Pages on a free account requires a *public* repository. `data/measurements.csv` is listed in `.gitignore`, so train on your own computer and commit only `models/`. Use the train workflow only in a private repository.

## 3. Probabilistic forecasts
Every member of each ensemble (ECMWF ENS 0.25°, GFS ensemble and ICON EPS, set in `ensemble_models`) is converted to power
individually, and the P10/P50/P90 are taken from the resulting member *power* values (not from the wind speed quantiles).
Daily P10/P90 are calculated from the members' daily sums. Raw ensembles are usually under-dispersive: the
`ml_p10_p90_coverage_pct` metric shows whether the trained quantiles reach the ideal 80 %.

## Licence and usage
Open-Meteo is free for **non-commercial** use (about 10,000 calls per day; this system uses about 7 per hourly run).
Commercial use requires an Open-Meteo API subscription. Attribution: *Weather data by Open-Meteo.com (CC BY 4.0)*.
