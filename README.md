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
| `docs/index.html` | **WindSolar Studio**: browser app for any site (GPS/map/search, any dates), with tabs for forecast, trading, storage, evaluation and site assessment |
| `docs/plant.html` | Dashboard for your configured plant, fed by the hourly GitHub Action |
| `docs/assets/` | App styles and JavaScript modules (physics, APIs, one file per tab) |
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

## WindSolar Studio (docs/index.html)
Runs entirely in the browser. No backend is needed, so it works on GitHub Pages as it is.

| Tab | What it does | Course topic |
|---|---|---|
| Combination | Inverse-MSE model weights learned per weather situation (against ERA5 or your measurements), uncertainty band per situation, short-term correction from the latest measurement, 'Now' line | Regression, validation, ensembles |
| Warnings | Storm/cut-out, icing, low temperature, thunderstorm, snow on PV and fog; timeline, alerts and a copyable report | Probabilistic forecasting |
| Availability | Maintenance and grid plans, night mode, shadow flicker, snow derate, market curtailment → technically possible vs real feed-in | Electricity markets |
| Forecast | 4 NWP models + ECMWF/GFS/ICON ensembles → wind and PV power, P10/P50/P90, daily energy, CSV export | Regression, quantile forecasting |
| Day-ahead trading | Offers the τ* = (λD−λ↓)/(λ↑−λ↓) quantile, compares the expected revenue of different strategies, plots the E[R(q)] curve | Electricity markets, newsvendor problem |
| Battery storage | Backward-induction DP schedule using day-ahead prices (grid or own-plant charging); the lecture's Markov-price MDP solved by value and policy iteration | MDPs, value/policy iteration |
| Evaluate & learn | Upload measurements → MAE/RMSE/bias/pinball → ridge regression (degree and λ chosen by blocked CV) → decision-focused learning | Regression, regularisation, validation, DFL |
| Site assessment | Power curve (standard vs site density), Weibull fit, AEP (time series and Weibull), long-term P50/P90 from several years; one year of ERA5 → capacity factors → k-means representative days with weights, elbow plot, duration-curve check | Clustering for expansion planning |

Free data sources: Open-Meteo (forecasts, archived forecasts, ensembles, ERA5), Energinet Energi Data Service (DK1/DK2/DE/NO/SE day-ahead prices),
BigDataCloud (reverse geocoding of the GPS position) and OpenStreetMap tiles. The GPS button uses the browser's geolocation, which requires the
https site (GitHub Pages provides it).

## Methods and data

### Data sources (all free, no API key)
- **Open-Meteo**: Forecast API (up to 16 days), Historical Forecast API (archived forecasts), Ensemble API (ECMWF ENS, GEFS, ICON-EPS) and the ERA5 archive. CC BY 4.0, non-commercial use.
- **Energi Data Service (Energinet)**: day-ahead prices for DK1, DK2, DE, NO and SE. CC BY 4.0.
- **BigDataCloud**: turns the GPS position into a place name, in the browser. **OpenStreetMap** provides the map tiles (via Leaflet).

### Physical models
- **Hub-height wind:** a power-law shear exponent is fitted every hour between 10 m and 100 m. Air density comes from surface pressure and temperature, and the power curve is density-corrected (IEC 61400-12-1).
- **PV:** sun position at the middle of each hour, Erbs decomposition, isotropic transposition, Faiman cell temperature, a PVWatts DC model and inverter clipping.
- **Hourly energy:** the energy for hour [h, h+1) uses the radiation mean that ends at h+1 and the average of the instantaneous wind at h and h+1.

### Course methods used (DTU 46765 Machine Learning for Energy Systems)
| Method | Where in the app |
|---|---|
| Regression, regularisation, validation: ridge regression with polynomial features; λ and degree chosen by blocked k-fold cross-validation (no shuffling of time series). Ridge keeps XᵀX + λI invertible even with redundant features | Evaluate & learn |
| Error metrics: MAE (the median minimises it; robust) and RMSE (the mean minimises it; penalises large errors), both normalised by capacity | Evaluate & learn, Combination |
| Quantile forecasting: ensemble P10/P50/P90, pinball loss | Forecast, Evaluate & learn |
| Electricity markets: two-price balancing revenue R(q) = λD·q + λ↓(p−q)⁺ − λ↑(q−p)⁺; the optimal offer is the τ* = (λD−λ↓)/(λ↑−λ↓) quantile | Day-ahead trading |
| Decision-focused learning: a linear offer q = β₀ + β₁x trained to maximise realised revenue (projected subgradient ascent), compared with OLS. With additive penalties this is the same as linear quantile regression at τ* | Evaluate & learn |
| Combination forecast: weights ∝ (1/MSE)^p per weather situation, with the sharpness p chosen on held-out data; residual quantiles per situation as the uncertainty band; short-term correction that fades as e^(−Δt/τ) | Combination |
| Clustering: k-means++ on daily wind/solar profiles, weighted representative days, elbow plot, duration-curve check (the order of days is lost) | Site assessment |
| MDPs: finite-horizon backward induction for battery scheduling; value iteration and policy iteration for the Markov-price battery exercise | Battery storage |
| Warnings: rule-based hazards checked in every model and ensemble member; the warning level is the share of scenarios that meet the rule | Warnings |
| Availability: maintenance and grid plans, night-mode and shadow-flicker shutdowns (sun position plus clear-sky index), snow derate, market curtailment below a price threshold | Availability |
| AEP: time-series and Weibull (method of moments) AEP, density-corrected power curve, long-term P50/P90 from several ERA5 years | Site assessment |

### Limitations
Forecasts are indicative only. They have not been validated against plant measurements, the market model is simplified (fixed imbalance premiums, hourly resolution), and Open-Meteo's free tier is for non-commercial use. Do not use them for real trading without a backtest against measured data.

*Weather data by Open-Meteo.com · Prices from Energinet (www.energidataservice.dk) · Map © OpenStreetMap contributors.*

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
