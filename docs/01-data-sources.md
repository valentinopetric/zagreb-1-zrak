# 01 · Data sources: measurements, weather and background

*First draft by the measurement-data owner [meas-data]. Covers `tools/fetch_iszz.py`, `tools/fetch_meteo.py`,
`tools/build_measurements.py`, `data/processed/*`, `src/data/measurements.json`, `tests/python/test_iszz.py` and
`.github/workflows/refresh-data.yml`. Everything below was run and checked on 2026-09-27.*

The research behind this chapter is in `docs/research/iszz-api.md` (the ISZZ service, tested endpoint by endpoint) and
`docs/research/critic.md` §1.1–1.5 and §4.1 (D1–D9). The decisions made there are binding: where they differ from the
other research reports, the critic's decisions apply.

---

## 1. Overview: what comes from where, and when

| # | What | Source | Fetched by | When | Stored as |
|---|---|---|---|---|---|
| D1 | ZAGREB-1 hourly air quality + station meteo (11 parameters) | ISZZ export service, station 155 | `tools/fetch_iszz.py` | build time, weekly Action | `data/processed/iszz_hourly.csv.gz` |
| D2 | ZAGREB-4 hourly background (NO2, NOx, O3, PM10, PM2.5) | ISZZ export service, station 303 | `tools/fetch_iszz.py` | build time, weekly Action | same table |
| D1′ | ZAGREB-1 daily gravimetric PM10 (EU reference method) | ISZZ export, daily types 17/16 | `tools/fetch_iszz.py` | build time, weekly Action | `data/processed/iszz_pm10_gravimetric.csv` |
| D3 | Offered (station, parameter, type) triples | ISZZ `/podatak/frm/gg` | `tools/fetch_iszz.py` | build time (cached 7 days) | `data/cache/iszz/frm_gg.json` |
| D7 | Hourly weather at the station, 2023 → now | Open-Meteo archive, `models=ecmwf_ifs` | `tools/fetch_meteo.py` | build time, weekly Action | `data/processed/ifs_hourly.csv.gz` |
| — | Baked history for the page (last 400 days + whole-period statistics) | the two tables above | `tools/build_measurements.py` | build time, weekly Action | `src/data/measurements.json` |
| D1/D2 live | Last 72 h of raw hourly values at both stations | ISZZ export service | the page, `Live.iszz()` / `Live.recent()` (data.js, [ui]) | in the browser | not stored |
| D4 | Current EAQI badge | ISZZ `/eaqi/indeks?h=0` | the page, `Live.eaqi()` | in the browser | not stored |
| D8 | Weather now and 72 h ahead | Open-Meteo forecast, `models=ecmwf_ifs` | the page, `Live.forecast()` | in the browser | not stored (a sample is a test fixture) |
| D9 | Background forecast (NO2, O3, PM10, PM2.5) | Open-Meteo air quality, `domains=cams_europe` | the page, `Live.cams()` | in the browser | not stored (a sample is a test fixture) |

Everything the page needs to work offline is baked into `measurements.json`. The live clients only add the last hours
and the forecast. When they fail (CORS, rate limit, network), the page falls back to the baked snapshot and says so
(architecture §7, "no silent caps").

```
ISZZ export (155, 303) ──► fetch_iszz.py ──► iszz_hourly.csv.gz ─┐
ISZZ export (155, types 16/17) ──────────► iszz_pm10_gravimetric.csv ─┤
Open-Meteo archive (ecmwf_ifs) ──► fetch_meteo.py ──► ifs_hourly.csv.gz ─┼─► build_measurements.py ──► src/data/measurements.json ──► tools/build.py ──► dist/index.html
                                                                        └─► tools/calibrate.py [models] (reads the full hourly tables)
```

---

## 2. ISZZ: the Croatian air-quality portal

Portal: *Kvaliteta zraka u Republici Hrvatskoj* (ISZZ), run by the Ministry of Environmental Protection and Green
Transition (MZOZT) at <https://iszz.azo.hr/iskzl/>. DHMZ operates both stations in the state network.

### 2.1 Stations and why ZAGREB-4 is the background

| | ZAGREB-1 (the receptor) | ZAGREB-4 (the background) |
|---|---|---|
| ISZZ id (`postaja`) | **155** | **303** |
| Codes | RH0101, EoI HR0007A | EoI HR0041A |
| Type | urban traffic | suburban background (reclassified 29.12.2022) |
| Position | NW corner of Vukovarska × Miramarska, inlet 4 m, kerb 9–12 m (critic §1.6) | 4.4 km SW, 114 m a.s.l. |
| Hourly parameters used | NO2, NOx, PM10, PM2.5, SO2, CO, benzene, wind speed, wind direction, temperature, RH | NO2, NOx, O3, PM10, PM2.5 |

ZAGREB-4 is the background for NOx, NO2, O3, PM10 and PM2.5 (critic §0.2, §1.2). Mirogojska (280), the obvious urban
alternative, fails as a background for three reasons:

- it has its own traffic peak: weekday NOx at 07–09 h is 76–85 µg/m³, against 39–42 at ZAGREB-4;
- it offers no raw hourly NOx at all, so it cannot drive a live increment;
- CAMS correlates better with ZAGREB-4 (NO2 0.63 against 0.56; O3 0.84 against 0.78; PM10 0.61 against 0.47).

With ZAGREB-4 as background, the chemistry test improves from RMSE 7.8 to 5.0 µg/m³ (critic §1.2). O3 is **not
measured** at ZAGREB-1 (critic §1.7), so it always comes from ZAGREB-4.

### 2.2 The export service (D1, D2)

```
GET https://iszz.azo.hr/iskzl/rs/podatak/export/json
      ?postaja=<station id>&polutant=<code>&tipPodatka=<type>&vrijemeOd=dd.MM.yyyy&vrijemeDo=dd.MM.yyyy
```

| Parameter | Meaning | Notes (iszz-api §3.1) |
|---|---|---|
| `postaja` | station id (155, 303) | unknown id → `[]` |
| `polutant` | parameter code (table in §2.9) | not measured → `[]` |
| `tipPodatka` | data type: **0** raw hourly, **1** validated hourly, **16/17** raw/validated daily gravimetric | if left out, the server silently returns type 0; we always send it |
| `vrijemeOd`, `vrijemeDo` | first and last **local** day, inclusive, `dd.MM.yyyy` | ISO dates give HTTP 204 with an empty body; a time of day is ignored |

The response is a flat JSON array: `[{"vrijednost": 48.1, "mjernaJedinica": "µg/m3", "vrijeme": 1789858800000}, …]`.
The PDF documentation (`servis_uputa.pdf`) shows an older shape, `[{"Podatak": {…, "vrijeme": ISO}}]`. The parser
accepts both (`parse_export`, tested).

Other ISZZ endpoints used:

| Endpoint | Use | Limits |
|---|---|---|
| `/rs/podatak/frm/gg?t=false&i=false` (D3) | the valid (station, parameter, type) triples, so that the fetcher never asks for a type a station does not offer (e.g. the meteo parameters have no validated type) | not rate-limited; cached 7 days |
| `/rs/eaqi/indeks?h=0` (D4) | live EAQI badge in the page (filter `id == 155`) | not rate-limited, CORS `*`; ISZZ uses the **legacy** EAQI bands (iszz-api §9.3) |

### 2.3 Limits and politeness

| Fact (tested, iszz-api §0, §3.2, §7) | How the fetcher handles it |
|---|---|
| **Hard cap of 1000 rows per response**, silently truncated (the first 1000 in time order, HTTP 200, no warning) | Requests are calendar months (≤ 31 days ≤ 744 hourly rows, below `SITE.iszz.chunk_days` = 40). A response with **≥ 1000 rows is treated as truncated**: the chunk is split in halves, recursively, until every part is below the cap (`fetch_split`, tested on a real 1000-row response). |
| **About one accepted request per second**, per IP or global, shared by `/export/json` and `/export/xml` | One request at a time, **≥ 1.1 s after the previous response** (`SITE.iszz.pace_s`). |
| **HTTP 429 "Too many requests" without `Retry-After`** | Wait 1–2 s (1 s + uniform jitter) and retry, up to 60 times (the limiter window is about 1 s and counts only accepted requests). |
| 5xx and network errors | Exponential back-off 2, 4, 8, 16, 32, 60 s, six tries. |
| HTTP 204 with an empty body | "Bad parameters" (e.g. an ISO date). Raised as an error, never read as "no data". |
| CORS `Access-Control-Allow-Origin: *` | The page calls the same endpoint directly (data.js, [ui]). Each viewer then hits the limiter from their own IP, so the page serialises its requests at 1.1 s as well. |

The first full download (2023-01 → 2026-09, both stations, raw and validated) is about 1 260 requests, or 25 minutes.
In this build the ZAGREB-1 part (810 chunks) was seeded from the research prototype's cache, which has the same file
format, so the real run made 405 requests in 8.3 min: 0 × 429 and 1 connection reset, retried.

### 2.4 Time semantics

- `vrijeme` is epoch **milliseconds**, a true **UTC** instant, marking the **end** of the averaging hour. The value at
  10:00Z is the mean of 09:00–10:00Z. This was checked against meteo.hr and against 6 296 of 6 296 EEA E2a hours
  (iszz-api §4.1–4.2).
- A request for local days D1..D2 returns the hour-ending slots **D1 01:00 … (D2+1) 00:00 local**, which is ISZZ's
  "1:00 … 24:00" convention. The fetcher uses the window (midnight(D1), midnight(D2+1)] in UTC (`Chunk.window_ms`).
- **Local time** is Europe/Zagreb, computed with the EU summer-time rule: CEST from the last Sunday of March 01:00 UTC to
  the last Sunday of October 01:00 UTC (Directive 2000/84/EC). This needs no tzdata. `test_matches_zoneinfo` checks it
  against `zoneinfo` every 30 minutes over 2023–2026.
- The **local hour-start** of a value stamped t is local(t − 1 h). This is the "hour of day" for profiles
  (architecture §2), and the **local year and day** of a value are those of its hour-start. So the "31.12. 24:00" value
  belongs to the old year, as in ISZZ's own tables.
- **DST days** (iszz-api §4.4; both checked on real responses in `TestTime`):
  - spring (30.03.2025) has 23 values, and local hour-start 02 does not exist;
  - autumn (26.10.2025) has **24 values for a 25-hour day**. The instant 00:00Z (the hour 01:00–02:00 CEST) is lost at
    source, and hour-start 02 appears twice (CEST, then CET). The fetcher does not try to "fix" this.
- **Daily** types (the gravimetric PM10, types 16/17) are stamped **00:00 local at the start of the day**, the opposite
  of the hourly types (iszz-api §4.5). `daily_rows()` takes the local date of the stamp itself.
- Latency: the newest raw hour usually appears 1–2 h after it ends.

### 2.5 Missing data, precision and units

| Series | Missing hours | Precision | Notes |
|---|---|---|---|
| raw hourly (type 0) | rows are simply absent | 1 decimal | arrives within 1–2 h; may contain values that validation later rejects |
| validated hourly (type 1) | **a row for every hour**; rejected or missing hours carry **`vrijednost = −999`** | 3 decimals | published once a year for the whole previous year |
| raw / validated daily gravimetric (16/17) | −999 possible in validated | 3 decimals | released after lab analysis: none yet for 2026 |

- Every value ≤ −900 (`SITE.iszz.missing_sentinel_max`) is masked.
- `[]` means "no data" **or** an unknown station, parameter or type. The capability check (D3) tells the two apart.
- Small negative values near zero (SO2, raw CO) are instrument noise and are kept as delivered (iszz-api §0). Raw CO
  has only 0.1 mg/m³ resolution and a zero offset; the validated CO is fine.
- ISZZ spells units `µg/m3`, `mg/m3`, `degrees`, `degrees Celzius`. The table uses the spelling in `SITE.iszz.params`
  (`µg/m³`, `mg/m³`, `°`, `°C`), and the fetcher warns if ISZZ ever reports a different unit.
- **CO is in mg/m³**; every other concentration is in µg/m³.

### 2.6 Merging raw and validated data

Both hourly types are downloaded, and validated is preferred, **per station, parameter and local calendar year**:

> A year uses the validated series if it has rows at all and its rows (sentinels included) number at least 50 % of the
> raw rows of that year. Otherwise the year uses the raw series. Within the chosen series, sentinel hours are masked
> and are **never refilled from the raw series**.

This is the policy of the research prototype (iszz-api §10). Validation changes the values a lot, so mixing raw and
validated data inside one year would mix two different calibrations, and a raw hour the validator rejected must not
come back:

| Mean \|raw − validated\| on hours present in both | 2023 | 2024 | 2025 |
|---|---|---|---|
| ZAGREB-1 NO2 (µg/m³) | 8.73 | 7.87 | 3.80 |
| ZAGREB-1 NOx | – (no raw) | **26.46** | 8.81 |
| ZAGREB-1 PM10 | 4.87 | 4.08 | 1.51 |
| ZAGREB-1 PM2.5 | 2.24 | – (not validated) | 0.77 |
| ZAGREB-1 SO2 | 1.23 | 2.11 | 1.57 |
| ZAGREB-1 CO (mg/m³) | 0.05 | 0.10 | 0.17 |
| ZAGREB-1 benzene | 0.37 | 0.30 | 0.10 |
| ZAGREB-4 NO2 | 4.23 | 3.99 | 1.96 |
| ZAGREB-4 NOx | – (no raw) | 7.82 | 3.36 |
| ZAGREB-4 O3 | 9.29 | 7.72 | 6.95 |
| ZAGREB-4 PM10 / PM2.5 | 3.58 / 2.44 | 3.66 / 2.47 | 1.83 / 0.88 |

Consequences, all visible in the completeness report:

- 2023–2025 are validated, and 2026 is raw (validated 2026 appears in 2027);
- ZAGREB-1 PM2.5 2024 is **raw**: validated 2024 PM2.5 was never published (one stray value, iszz-api §6.1);
- raw NOx exists only from 2024, so NOx 2023 is validated-only at both stations.

The CSV column `validated` (1/0) records the source of every value, and `measurements.json` carries the last validated
stamp per key (`meta.validated_until`). The page can therefore draw raw and validated data differently.

### 2.7 Incremental fetching, the cache and the manifest

| Rule | Value | Reason |
|---|---|---|
| Cache | `data/cache/iszz/<station>/p<code>_t<type>_<first>_<last>.json` = `{fetched_at, url, source, records: [[ms, value, unit], …]}` | same format as the research prototype, so its cache could seed this one; gitignored |
| A chunk is **final** | once it was downloaded ≥ **60 days** after its last day (`--settle-days`) | "re-fetch only the last ~60 days" |
| A non-final **raw** chunk | is downloaded again if its copy is older than **6 h** (`--min-age-hours`) | cheap repeated local runs |
| **Validated** chunks | requested only for years that have ended | validated data are published yearly |
| An ended year whose validated series is empty or below 50 % | is **probed** with one request (its last month) on each run, for 2 years (`--validated-lookback`); if the probe holds ≥ 50 % of its hours, the whole year is downloaded | a year becomes available all at once; a single stray value is not a release |
| Current month | the key ends "today", so it changes daily; older files of the same chunk start are deleted | keeps the cache clean |
| **Rehydration** | on a fresh checkout (the Action) the cache is empty. Final chunks are rebuilt from the committed `iszz_hourly.csv.gz` plus the **chunk manifest** in `iszz_completeness.json` (fetch time, rows and masked sentinels of every chunk) | nothing final is downloaded twice; the merge decision and the output are byte-identical (`test_rehydration_from_processed_table`) |
| **Shrink guard** | refuses to overwrite the table (exit 3) if a station-parameter-year with an unchanged source loses more than 48 valid hours; `--allow-shrink` overrides | an outage returning `[]`, or a bug, can never delete data |
| Failures | a failed chunk keeps its previous data; the run exits 2 and the Action does not commit | never less data than before |

**Request budget per weekly run** (measured with a simulated fresh checkout one week ahead):

- hourly raw chunks: 16 series × 3–4 non-final months = **48–64 requests**;
- about 1 validated probe (ZAGREB-1 PM2.5 2024, until it leaves the 2-year window);
- 2 gravimetric requests (the running year).

That is about 51–67 requests, or 1–1.5 min at 1.1 s. It is close to critic §4.9's "≤ 60 requests" and slightly above
it in weeks where four months are not yet final. A settle window of 45 days would keep every week under 60.

### 2.8 Gravimetric PM10: the reference method

The automatic analyser (types 0/1) and the gravimetric sampler (daily types 16/17, EN 12341 reference method) give
**different exceedance counts** (§6.3). The official 24-h limit assessment is based on the reference method, so the
fetcher also stores the gravimetric daily PM10 of ZAGREB-1 (`iszz_pm10_gravimetric.csv`). An ended year with
validated values for ≥ 90 % of its days is final and is reused from the committed file. The running year is requested
again on each run: validated first, raw as fallback. Lab results lag, so 2026 is still empty.

### 2.9 Parameters and completeness

Codes, units and the station flags come from `config/site.json` → `iszz.params`. Completeness = valid hours ÷ hour
slots of the local calendar year that have ended (2026 until 27.09, 21:00 local). **V** = the year uses validated data,
**R** = raw. "Masked" = −999 hours of the chosen validated series.

| Station | Key | Code | Unit | 2023 | 2024 | 2025 | 2026 (ytd) | Total % | Masked 2023/24/25 | First value (UTC) |
|---|---|---|---|---|---|---|---|---|---|---|
| ZAGREB-1 | no2 | 1 | µg/m³ | 91.4 V | 95.5 V | 93.5 V | 97.2 R | 94.2 | 750/399/570 | 2023-01-13 12:00 |
| ZAGREB-1 | nox | 38 | µg/m³ | 91.4 V | 95.5 V | 93.5 V | 97.2 R | 94.2 | 750/395/570 | 2023-01-13 12:00 |
| ZAGREB-1 | pm10 | 5 | µg/m³ | 92.0 V | 97.4 V | 98.2 V | 96.4 R | 96.0 | 0/225/152 | 2023-01-13 12:00 |
| ZAGREB-1 | pm25 | 28 | µg/m³ | 92.0 V | 97.6 **R** | 98.2 V | 96.4 R | 96.0 | 0/–/152 | 2023-01-13 12:00 |
| ZAGREB-1 | so2 | 2 | µg/m³ | 88.8 V | 95.0 V | 90.9 V | 97.2 R | 92.7 | 981/434/798 | 2023-01-15 12:00 |
| ZAGREB-1 | co | 3 | mg/m³ | 87.5 V | 95.7 V | 87.8 V | 97.0 R | 91.7 | 1091/375/1066 | 2023-01-31 13:00 |
| ZAGREB-1 | c6h6 | 32 | µg/m³ | 80.4 V | 88.1 V | 84.9 V | 96.2 R | 86.8 | 1718/1047/1325 | 2023-01-31 16:00 |
| ZAGREB-1 | ws | 477 | m/s | 0 | 89.3 R | 98.2 R | 97.3 R | 69.4 | – | 2024-01-31 15:00 |
| ZAGREB-1 | wd | 478 | ° (from) | 0 | 89.3 R | 98.2 R | 97.3 R | 69.4 | – | 2024-01-31 15:00 |
| ZAGREB-1 | t | 475 | °C | 0 | 83.9 R | 99.3 R | 97.3 R | 68.2 | – | 2024-01-31 15:00 |
| ZAGREB-1 | rh | 479 | % | 0 | 83.9 R | 99.3 R | 97.3 R | 68.2 | – | 2024-01-31 15:00 |
| ZAGREB-4 | no2 | 1 | µg/m³ | 90.8 V | 97.0 V | 98.2 V | 99.2 R | 96.1 | 803/258/152 | 2023-01-01 00:00 |
| ZAGREB-4 | nox | 38 | µg/m³ | 90.8 V | 97.1 V | 98.2 V | 99.2 R | 96.2 | 803/250/152 | 2023-01-01 00:00 |
| ZAGREB-4 | o3 | 31 | µg/m³ | 94.2 V | 97.2 V | 94.9 V | 98.3 R | 96.0 | 507/246/445 | 2023-01-01 00:00 |
| ZAGREB-4 | pm10 | 5 | µg/m³ | 96.5 V | 98.9 V | 99.4 V | 99.2 R | 98.5 | 0/98/51 | 2023-01-01 00:00 |
| ZAGREB-4 | pm25 | 28 | µg/m³ | 96.5 V | 98.9 V | 99.4 V | 99.3 R | 98.5 | 0/98/51 | 2023-01-01 00:00 |

ZAGREB-1 gravimetric PM10 (validated daily): 2023 345 days (from 4 January), 2024 366, 2025 365; 2026 not yet
released.

Known holes:

- at ZAGREB-1, every automatic series starts on 13.01.2023, when the new PM analyser went in; CO and benzene start on
  31.01.2023;
- the ZAGREB-1 meteo sensors have **no data in 2023** and restart on 31.01.2024;
- benzene is the least complete series.

The station **wind vane** has a dead band (no direction in 283°–16° at ZAGREB-1). It is most likely a processing
artefact (critic §1.5): the same gap appears at ZAGREB-4, and strong northerlies are reported from the opposite
half-circle. Station wind is therefore shown as measured but **never drives the model**.

---

## 3. Open-Meteo: weather and background

### 3.1 Why ECMWF IFS, not ERA5 (critic §0.1, §1.1)

The research's "ERA5" file was really Open-Meteo `best_match`, which is **ECMWF IFS 9 km**. Real ERA5 (0.25°) differs
a lot at this site:

| 2025 | `ecmwf_ifs` (= `best_match` for wind) | `era5` |
|---|---|---|
| Grid cell | 45.79965 N, 15.924171 E (3.9 km W of the station) | 45.75 N, 16.00 E |
| Mean U10 | 1.73 m/s | 1.98 m/s |
| Calms < 1 m/s | 31.0 % | 17.0 % |
| Rose, top sectors | NNW 11.6, N 10.6, NNE 8.9, SW 8.1 % | NNE 12.3, NE 12.2, SW 10.4 % |

- The low-wind floor U0 fitted with IFS (1.31–1.65 m/s) does not carry over to ERA5 (1.56–2.68 m/s).
- IFS explains the NOx increment slightly better (r = 0.25 against 0.22).
- IFS is available in both the archive and the forecast API, and includes boundary-layer height.

So calibration (archive) and the live page (forecast) both ask for `models=ecmwf_ifs` **explicitly**.

### 3.2 The archive (D7): used at build time

```
GET https://archive-api.open-meteo.com/v1/archive?latitude=45.8005&longitude=15.9742
    &start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
    &hourly=wind_speed_10m,wind_direction_10m,boundary_layer_height,temperature_2m,cloud_cover,shortwave_radiation
    &wind_speed_unit=ms&timezone=GMT&models=ecmwf_ifs
```

- Point: the station rounded to 4 decimals (critic D7). The response names the IFS cell actually used, and
  `ifs_hourly.meta.json` records it.
- One request per calendar year. The first request starts one day early (2022-12-31), so that the first hour-ending
  value has its t − 1 h sample.
- IFS in the archive is "updated every 6 hours with no delay" (Open-Meteo docs), so values reach the current hour. A
  year is final once it was fetched 7 days after its end.
- Limits: free tier, non-commercial use only, < 10 000 calls/day, < 5 000/hour, < 600/minute. A long request counts as
  several calls. CORS `*`. Four requests per run.

### 3.3 Time semantics and the hour-ending conversion

Open-Meteo's documentation ("Valid time" column, checked 2026-09-27) gives:

| Variable | Valid time | Hour-ending value for t (matches ISZZ) |
|---|---|---|
| `wind_speed_10m`, `wind_direction_10m` | instant | **vector mean** of the samples at t − 1 h and t |
| `boundary_layer_height` | instant (IFS HRES only) | mean of t − 1 h and t |
| `temperature_2m` | instant | mean of t − 1 h and t |
| `cloud_cover` | instant | mean of t − 1 h and t |
| `shortwave_radiation` | **mean of the preceding hour** | the value stamped t, **as delivered** (it already is the [t − 1 h, t] mean) |

With `timezone=GMT` the stamps are UTC. The mean of the two instantaneous samples at the ends of the hour is the
trapezoidal estimate of the hourly mean (`SITE.openmeteo.note`).

The vector mean follows architecture §2:

- each sample (s, θ) becomes the blowing-toward vector (u, v) = (−s sin θ, −s cos θ);
- the components are averaged;
- speed = √(ū² + v̄²) and direction (from) = atan2(−ū, −v̄) mod 360°;
- if the mean vector vanishes (exactly opposite samples), the direction is left empty (3 hours in 2023–2026).

For two equal speeds, the vector-mean speed is s·cos(Δθ/2). So the hour-ending mean U10 of 2025 is 1.70 m/s, against
1.73 for the instantaneous values, with calms 32.1 % against 31.0 %.

> **Note for data.js [ui] and meteo.js [models]:** use the same conversion for the forecast. In particular, do **not**
> average `shortwave_radiation` over t − 1 h and t: it is already a preceding-hour mean.

A value is missing if either sample it needs is missing. Trailing hours with no data at all are dropped.

### 3.4 Boundary-layer height: availability

`ecmwf_ifs` in the archive has BLH only **from 2024-09-01 02:00Z**, and has a gap from **2025-09-18 00:00Z to
2025-10-08 12:00Z** (493 h). Overall coverage 2023–2026 is 53.9 %, and 94.4 % for 2025. Wind, temperature, cloud and
radiation are 100 % covered.

`best_match` fills those hours silently from ERA5: in June 2023 its BLH equals ERA5's while its wind is IFS. Where both
exist, `best_match` BLH = IFS BLH for 8 265 of 8 268 hours in 2025. That is why the research file had full BLH (2025
median 170 m), while the IFS-only series gives 160 m. Following critic §1.1, **`ifs.blh` stays IFS-only, with its gaps**.
Consumers must handle a missing BLH, for example with the lid floor `h_min` or the fixed 315 m mode of
`mixingHeight()`. An explicit, labelled ERA5 fill would be a decision for the lead (see §10).

### 3.5 The forecast (D8): live in the browser

```
GET https://api.open-meteo.com/v1/forecast?latitude=45.8005&longitude=15.9742
    &hourly=wind_speed_10m,wind_direction_10m,boundary_layer_height,temperature_2m,cloud_cover,shortwave_radiation
    &wind_speed_unit=ms&timezone=GMT&past_days=2&forecast_days=3&models=ecmwf_ifs
```

It returns the same IFS cell as the archive, with BLH, and CORS `*`. It is 5 days × 24 = 120 instantaneous stamps,
which give 119 hour-ending values. `python3 tools/fetch_meteo.py --forecast` fetches and converts it, for tests and
docs only. The saved sample is `tests/python/fixtures/meteo_forecast_ifs.json`.

### 3.6 CAMS background forecast (D9): live in the browser

```
GET https://air-quality-api.open-meteo.com/v1/air-quality?latitude=45.8005&longitude=15.9742
    &hourly=nitrogen_dioxide,ozone,pm10,pm2_5&domains=cams_europe&past_days=14&forecast_days=3&timezone=GMT
```

- CAMS European air-quality forecast, 0.1° (about 11 km), available from October 2023, updated every 24 h with 4
  forecast days.
- All four variables are **instantaneous** (Open-Meteo docs), so the hour-ending conversion is the mean of t − 1 h and
  t (`--cams` does this).
- Critic D9: bias-correct with the 14-day ratio to ZAGREB-4 (2025 ratios: NO2 1.77, O3 0.86, PM10 1.20, PM2.5 0.85).
- The saved sample is `tests/python/fixtures/meteo_cams_europe.json` (`python3 tools/fetch_meteo.py --cams`).

---

## 4. Build time against live

| | Build time (tools, weekly Action) | Live (the page, data.js [ui]) |
|---|---|---|
| ISZZ | full 2023 → now hourly history of both stations; gravimetric PM10 | raw hourly, last 72 h, both stations (`tipPodatka=0`), serialised at 1.1 s with 429 back-off; EAQI badge |
| Weather | IFS archive 2023 → now | IFS forecast, past 2 + next 3 days |
| Background | measured ZAGREB-4 | measured ZAGREB-4 for the past; bias-corrected CAMS for the future |
| Fallback | – | the baked snapshot, labelled as such, with its `meta.generated_utc` |

The weekly Action keeps the snapshot at most about 7 days old. The live layer fills in the rest.

---

## 5. Outputs and schema

### 5.1 `data/processed/` (committed, for calibration and audit)

| File | Content | Size |
|---|---|---|
| `iszz_hourly.csv.gz` | `t_utc_end,station,param,value,unit,validated`: 462 917 rows, 2023-01-01 → now, time-major (t, station, parameter); gzip with mtime 0, so the file is byte-identical when the data are, and weekly updates change only the tail | 2.6 MB |
| `iszz_completeness.json` | per station, parameter and year: `n`, `expected`, `pct`, `source`, `masked`; `validated_until`; request statistics; failures; gravimetric summary; the **chunk manifest** used for rehydration | 138 KB |
| `iszz_pm10_gravimetric.csv` | `date_local,station,param,value,unit,validated`: ZAGREB-1 daily gravimetric PM10 | 40 KB |
| `ifs_hourly.csv.gz` | `t_utc_end,u10,wd10,blh,t2,cc,sw` (m/s, ° from, m, °C, %, W/m²), hour-ending, empty = missing | 0.44 MB |
| `ifs_hourly.meta.json` | model, request point, **grid cell**, per-column semantics, coverage, attribution | 2 KB |

`t_utc_end` is ISO-8601 UTC, e.g. `2025-01-01T01:00:00Z`: the end of the averaging hour. `tools/fetch_iszz.py:read_processed()`
and `tools/fetch_meteo.py:read_ifs()` read them back into `{t_end_ms: value}` dictionaries.

### 5.2 `src/data/measurements.json` (architecture §4.2)

The file is 573 KB. It has the fields and meaning of architecture §4.2 exactly, and adds the following. Every addition
is additive; a decoder that ignores them works unchanged.

| Field | Meaning |
|---|---|
| `meta.time`, `meta.missing` | reminders: epoch ms UTC hour-ending; −32768 = missing |
| `meta.units` | unit per key (µg/m³, CO mg/m³, m/s, °, °C, %, m, W/m²), also for `inc.*` |
| `meta.validated_until` | last validated stamp per ISZZ key (null = raw only, e.g. station meteo). Values at or before it are validated. |
| `meta.sources` | fetch times, the ISZZ export URL, station names, the IFS grid cell and its BLH coverage |
| `stats.rose[k].calm`, `stats.rose[k].u_min` | hours with IFS U10 < 0.5 m/s have no meaningful direction: they are counted in `calm = {mean, n}` instead of a sector. `rose["ifs.u10"]` gives the wind rose itself: `n` = frequency per sector, `mean` = mean speed. |
| `stats.coverage_by_year` | coverage % per key and local year (full-year denominator); explains missing annual means |
| `stats.exceed_n` | valid hours (1-h) or valid days (24-h) behind each exceedance count, per year |
| `stats.exceed["pm10_24h_50_ref"]`, `["pm10_24h_45_ref"]` | the same 24-h PM10 limits counted on the **gravimetric reference method** (§6.3) |
| `stats.increment_year` | the year of `stats.increment` |
| `stats.ytd` | `{year, through, mean: {key: v}, coverage: {key: %}}`: year-to-date means of the running year (`annual` holds complete years only) |

Definitions:

| Item | Definition | Source of the rule |
|---|---|---|
| `series` | last **400 days** = 9 600 hours ending at the newest measured hour. Int16 little-endian, base64; value = int16 × `scale[key]`; −32768 = missing; values beyond ±32767 steps are clipped, and the build logs them (none so far) | architecture §4.2 |
| `scale` | 0.1 for µg/m³ pollutants; CO 0.001 mg/m³; benzene 0.01; wind speed 0.01 m/s; directions 0.1°; temperatures 0.01 °C; RH and cloud 0.1 %; BLH 1 m; radiation 0.1 W/m². Every step is at or below ISZZ's raw precision (1 decimal), with Int16 headroom far above any observed value (NOx ±3 276.7 µg/m³) | iszz-api §0 |
| `annual` | mean per local calendar year, **complete years only**, with ≥ 75 % of the year's hours. The AAQD's own objective is 85 % (Directive 2024/2881 Annex V B); `coverage_by_year` lets the page flag 75–85 %. | architecture §4.2 |
| `diurnal` | mean by **local hour-start** (0–23) for weekday (Mon–Fri), Saturday and Sunday, by calendar day of week (public holidays are not treated as Sundays) | architecture §2 |
| `monthly` | mean by local calendar month, all years pooled | – |
| `rose` | 16 sectors centred on 0°, 22.5°, … (sector k covers [22.5k − 11.25°, 22.5k + 11.25°)), by the **IFS** hour-ending wind-from direction; calms (U10 < 0.5 m/s) apart. `inc.*` = Z1 − Z4 on paired hours. | architecture §4.2, §6.1 (`directionWeights` becomes uniform below 0.5 m/s) |
| `exceed` | counts of values strictly above the limit per year. 1-h limits on hourly values. 24-h limits on local-day means (hour-starts 00–23) with **≥ 18 valid hours** | Directive 2024/2881 Annex I (limits), Annex V C (18 of 24 hours) |
| `coverage` | % of the hours from the period start to the newest hour that have a value | – |
| `increment` | paired-hour mean of Z1 − Z4, per parameter on its own paired hours, for the latest ended year with ≥ 75 % paired NOx coverage | critic §1.2, §1.4 |
| `latest` | last value and stamp of every key | – |
| Circular keys | `z1.wd`, `ifs.wd10` are left out of `annual`, `diurnal`, `monthly` (an arithmetic mean of directions is meaningless); roses carry direction | – |

Exceedance keys: `no2_1h_200`, `no2_24h_50` (2030 limit), `pm10_24h_50`, `pm10_24h_45` (2030), `pm25_24h_25` (2030),
`so2_1h_350`, `so2_24h_125`, plus the two `_ref` keys.

---

## 6. Validation results

All of these were reproduced by this pipeline on 2026-09-27.

### 6.1 Annual means (ZAGREB-1, 2025, validated)

| | This build | Research (iszz-api §10, critic) | ISZZ's own `prosjek` |
|---|---|---|---|
| NO2 | **31.7** | 31.7 | 31.7052 |
| NOx | **71.0** | 71.0 | – |
| PM10 | **27.0** | 27.0 | – |
| PM2.5 | **18.4** | 18.4 | 18.4333 |
| PM10 2024 | 28.9 | – | 28.9271 |
| NO2 2026 (ytd, raw) | 32.7 | – | 32.7197 |

The row counts per series (NO2 30 879 h, NOx 30 883 h, PM10 31 472 h, …) are identical to the research prototype's,
so the merge rule reproduces it.

Other annual means (µg/m³):

| | 2023 | 2024 | 2025 |
|---|---|---|---|
| ZAGREB-1 NO2 | 35.1 | 38.0 | 31.7 |
| ZAGREB-1 NOx | 81.7 | 86.5 | 71.0 |
| ZAGREB-1 PM10 | 25.3 | 28.9 | 27.0 |
| ZAGREB-1 PM2.5 | 16.7 | 18.4 | 18.4 |
| ZAGREB-1 CO (mg/m³) | 0.189 | 0.253 | 0.244 |
| ZAGREB-4 NO2 | 16.8 | 17.4 | 16.3 |
| ZAGREB-4 O3 | 49.4 | 49.9 | 54.0 |

### 6.2 The local increment (ZAGREB-1 − ZAGREB-4, 2025)

| | This build (each parameter on its own paired hours) | Hours | Research (critic §1.4) |
|---|---|---|---|
| ΔNOx | **46.0** | 8 060 | 46.1 |
| ΔNO2 | 15.1 | 8 060 | – |
| ΔPM10 | 1.4 | 8 579 | 1.3 |
| ΔPM2.5 | 2.7 | 8 579 | 2.6 |

The difference is fully explained by the choice of hours. On the 7 989 hours where the NOx, PM10 and PM2.5
increments all exist (the critic's subset for its ratio regression), this pipeline gives **ΔNOx 46.13, ΔPM10 1.29,
ΔPM2.5 2.59**, exactly the critic's figures. `critic/gauss_sanity.py` pairs NOx alone (8 059 h) and reports 46.0, as
here. The difference of the two annual means (47.1) is larger, because the stations' gaps do not coincide. The
increment in `measurements.json` is the paired one. Earlier years: ΔNOx 56.6 (2023), 59.8 (2024).

The ΔNOx rose by IFS sector (µg/m³) is highest for NNW (64) and SE–SSE (57), lowest for SW (28), and 72 in calms. It
agrees with the expectation that calm, stable hours accumulate traffic NOx (critic §1.12).

### 6.3 Exceedances: automatic analyser against the reference method

The daily means from the hourly automatic PM10 reproduce ISZZ's own daily validated automatic series (type 5) exactly:
355 of 355 valid days in 2025, max |Δ| 0.0005 µg/m³. The **gravimetric** sampler (type 17, the EN 12341 reference
method) counts fewer days above the limits:

| ZAGREB-1 PM10 | 2023 | 2024 | 2025 | 2026 (ytd) |
|---|---|---|---|---|
| days > 50, automatic (`pm10_24h_50`) | 23 | 44 | 42 | 26 |
| days > 50, gravimetric (`pm10_24h_50_ref`) | 14 | 43 | 29 | – |
| days > 45 (2030 limit), automatic / gravimetric | 31 / 23 | 60 / 59 | 54 / 41 | 32 / – |
| valid days, automatic / gravimetric | 338 / 345 | 355 / 366 | 355 / 365 | 255 / – |

The limit allows 35 days > 50 per year until 2029. Counted automatically, 2024 and 2025 are above it; counted
gravimetrically, **2025 is not** (29). **The page must label the automatic count as indicative and show the reference
count where it exists.**

Other counts: NO2 1 h > 200: 0 in every year; SO2: 0. NO2 24 h > 50 (the 2030 limit, 18 allowed): 43 / 72 / 33 days.
PM2.5 24 h > 25 (2030, 18 allowed): 54 / 82 / 82 days.

### 6.4 Diurnal cycle (weekday NOx by local hour-start, 2025; critic §1.2)

| Hour | 03 | 07 | 08 | 09 | 14 | 18 | 22 |
|---|---|---|---|---|---|---|---|
| ZAGREB-1, this build | 37 | 135 | 125 | 100 | 67 | 97 | 85 |
| ZAGREB-1, critic §1.2 | 36 | 135 | 125 | 100 | 67 | 97 | 85 |
| ZAGREB-4, this build | 16 | 39 | 42 | 36 | 16 | 27 | 38 |
| ZAGREB-4, critic §1.2 | 16 | 39 | 42 | 36 | 16 | 27 | 38 |

The one difference (03 h: 37 against 36) is a rounding edge. The local-time handling is therefore consistent with the
research (which used `tz_convert("Europe/Zagreb")`).

### 6.5 IFS weather (2025, critic §1.1)

| | Instantaneous values, this archive | critic §1.1 |
|---|---|---|
| Grid cell | 45.79965 N, 15.924171 E | same |
| Mean U10 | 1.73 m/s | 1.73 |
| U10 < 1 m/s | 31.0 % | 31.0 % |
| Top sectors | NNW 11.6, N 10.6, NNE 8.9, SW 8.1 % | same |
| BLH median / < 50 m | 160 m / 29.5 % (IFS only, 493 h gap) | 170 m / 28.9 % (`best_match`, gap filled from ERA5; §3.4) |

### 6.6 Encoding

The series decoded in headless Chromium (`atob` + `DataView.getInt16(…, true)`, as `Hist` should do) are identical to
Python's `decode_int16` for `z1.no2`, `z1.co`, `z1.t`, `ifs.blh` and `z4.o3` (9 600 values each).

---

## 7. Tests and fixtures

`python3 -m unittest discover -s tests/python -p 'test_iszz.py' -v` runs 52 tests in about 3 s, without network:

| Group | What it checks |
|---|---|
| `TestChunks` | month chunks, clipping, ≤ 40 days, 45 chunks for 2023-01 → 2026-09, URL parameters |
| `TestTruncation` | a **real** 1000-row truncated response; ≥ 1000 rows → recursive split without loss or duplicates; a single day at the cap raises; 429 retried after ≥ 1 s; 1.1 s pacing; HTTP 204 = bad parameters; the old documented JSON shape |
| `TestMerge` | real validated response with −999 rows and the matching raw response: validated preferred, **rejected hours not refilled from raw**, masked counts, raw when validated is missing, a stray validated value does not win a year, rehydrated sentinels, unit spelling |
| `TestTime` | switch instants; against `zoneinfo` every 30 min 2023–2026; 23-hour spring and 25-hour autumn days; expected hours; **real** spring (71 rows) and autumn (72 rows, instant 00:00Z missing) responses; the "24:00" slot's year; ISO round trip |
| `TestMeteo` | vector mean across north, opposite winds (NaN direction), the **real** archive slice converted by hand (instantaneous means, radiation as delivered), missing samples, the real forecast window (119 values), the real CAMS sample (instantaneous → mean of t − 1 h and t), one request per year, `models=ecmwf_ifs` in every URL |
| `TestEncoding` | Int16 base64 round trip with NaN, None and clipping; little-endian byte order and the −32768 code; scale headroom |
| `TestStats` | sector boundaries (11.25° → 1, 348.75° → 0); the annual 75 % rule and full-years-only; diurnal day types by local hour-start; monthly means; rose with calms; 24-h exceedances with the 18-hour rule; **real** gravimetric daily stamps; validated-then-raw preference for the reference series; paired increment; `build()` end to end on a two-week fixture |
| `TestIncremental` | with a fake ISZZ server: first run (validated 2025, raw 2026, never validated 2026); a week later only Jul–Oct 2026 are downloaded; no request within 6 h; **rehydration** from the table gives a byte-identical file with only 3 requests; an unpublished validated year costs one probe and is fetched in full once published; the shrink guard; stale cache siblings removed |

Fixtures (real responses saved verbatim on 2026-09-27; URLs in `fixtures/iszz_fixtures.json` and in each meteo
file's `_fixture` block):

| File | Request |
|---|---|
| `iszz_155_1_t0_20250329_20250331.json` | raw NO2 around the spring switch |
| `iszz_155_1_t1_20251025_20251027.json` | validated NO2 around the autumn switch |
| `iszz_155_1_t0_20250630_20250701.json`, `iszz_155_1_t1_20250630_20250701.json` | raw and validated NO2 on two days with 7 rejected hours that raw still has |
| `iszz_155_477_t0_20250101_20250215.json` | a truncated 1000-row response (46 days of wind speed asked for) |
| `iszz_303_38_t0_20260925_20260926.json` | raw NOx at ZAGREB-4 |
| `iszz_155_5_t17_20250101_20250131.json` | validated daily gravimetric PM10 (start-of-day stamps) |
| `iszz_fixtures.json` | URL index, the real HTTP 204 answer to an ISO date, and the `/frm/gg` rows for 155 and 303 |
| `meteo_archive_ifs_20250329_31.json` | IFS archive, 3 days |
| `meteo_forecast_ifs.json` | IFS forecast, past 2 + next 3 days |
| `meteo_cams_europe.json` | CAMS Europe, past 14 + next 3 days |

---

## 8. How to refresh

Locally (Python 3.10+, standard library only):

```bash
python3 tools/fetch_iszz.py              # incremental; first run from scratch ~25 min, weekly ~1-1.5 min
python3 tools/fetch_meteo.py             # IFS archive, 4 requests
python3 tools/build_measurements.py      # src/data/measurements.json (+ prints the research cross-check)
python3 tools/build.py                   # dist/index.html
# or: make measurements build
```

Useful flags of `tools/fetch_iszz.py`:

| Flag | Effect |
|---|---|
| `--dry-run` | print the export URLs a run would request, without requesting anything |
| `--offline` | no network; rebuild the outputs from the cache or the committed table |
| `--refresh-validated` | re-download the validated series of the last 2 years (DHMZ revisions, critic G10) |
| `--full` | ignore the cache and the table, download everything (~1 260 requests) |
| `--stations z1 --params no2,nox` | refresh a subset; the other series are carried over offline |
| `--settle-days N`, `--min-age-hours H`, `--validated-lookback Y` | the incremental rules of §2.7 |
| `--allow-shrink` | accept a table that loses data (only after checking why) |

`tools/fetch_meteo.py --forecast` and `--cams` fetch one sample of the live endpoints. `--save-fixture PATH` also
stores the raw response.

Automatically: `.github/workflows/refresh-data.yml` runs on **Mondays at 04:37 UTC** and on demand (`workflow_dispatch`
with mode `incremental`, `refresh-validated` or `full`). Each run:

1. runs `test_iszz.py`;
2. runs the three tools and `tools/build.py`;
3. commits `src/data/measurements.json` and `data/processed/` if they changed;
4. dispatches `pages.yml` if it exists, because commits made with `GITHUB_TOKEN` do not trigger other workflows.

It needs no secret. A failed or refused fetch (exit 2 or 3) stops the job before the commit step.

---

## 9. Attribution and licences

| Source | Attribution (shown in the footer, `SITE.attribution`) | Licence / terms |
|---|---|---|
| ISZZ / DHMZ | "Izvor podataka: MZOZT – Kvaliteta zraka u Republici Hrvatskoj (iszz.azo.hr); mjerenja DHMZ" | **No licence is stated**, neither on the portal nor on data.gov.hr (critic §1.16, gap G4). They are public government data, but redistribution terms are unconfirmed. |
| Open-Meteo, ECMWF IFS | "Weather data: Open-Meteo.com (CC BY 4.0), ECMWF IFS" | CC BY 4.0; the free API is for non-commercial use (critic §1.16) |
| CAMS via Open-Meteo | "Background forecast: Copernicus Atmosphere Monitoring Service (CAMS) via Open-Meteo" | Copernicus licence (free, attribution required) + Open-Meteo CC BY 4.0 |

About G4: the repo commits a **derived snapshot** of ISZZ data. That is the merged hourly table of the two stations
(needed to reproduce the calibration) and the compact 400-day series in `measurements.json`, attributed as above.
Critic G4 advises keeping the committed ISZZ data small and derived, and asking MZOZT for written confirmation. The
hourly table (2.6 MB) is more than "compact". If MZOZT objects, `data/processed/iszz_hourly.csv.gz` can be dropped
from git: the tools would then re-download on each run (about 25 min) and the page would keep only `measurements.json`.
**Asking MZOZT is an open action for the maintainers.**

---

## 10. Limitations and open issues

1. **BLH gaps** in the IFS archive (§3.4): none before 2024-09-01, and 493 h missing in September–October 2025.
   Filling them from ERA5 would mix models against critic §1.1. It is left to the lead to decide, either a labelled
   `blh_era5` fill column, or a model fallback when BLH is missing.
2. **PM10 exceedances** differ between the automatic analyser and the reference method (§6.3). Both are in the data;
   the UI must say which one it shows.
3. **2026 is raw.** Raw values differ from the later validated ones by a few µg/m³ (NOx up to ~26 µg/m³ on average,
   §2.6). The weekly probe will switch 2026 to validated automatically once DHMZ publishes it (expected in 2027).
   **Raw CO in 2026 shows analyser zero drift.** It is reported to 0.1 mg/m³ only, and its monthly means fall to
   −0.07 and −0.09 mg/m³ in July and August 2026 (June 0.03), with 33–75 % of the hours at exactly 0. Validated CO in
   2025 was 0.09–0.47 mg/m³ by month (integration check, 2026-09-28). The page shows raw CO as published. The
   calibration uses validated 2025 data only, so it is not affected.
3b. **Station meteorology is range-checked** in `build_measurements.py` (`PLAUSIBLE`: wind 0–40 m/s, direction 0–360°,
   T −40…50 °C, RH 0–100.5 %). Three raw wind spikes of 57, 127.6 and 219.5 m/s (May–June 2024) are dropped, and
   the count is in `meta.sources.plausibility`. Pollutants are not filtered.
4. The **annual threshold** is 75 % (architecture §4.2), looser than the AAQD's 85 %. `coverage_by_year` makes this
   visible. Benzene 2023 (80.4 %) and 2025 (84.9 %) fall into that band.
5. **Rose sectors** use the IFS cell 3.9 km west of the station. Near-station channelling is not in IFS, and the
   station vane is unusable for N-sector flows (critic §1.5).
6. **Day types** follow the calendar; Croatian public holidays count as weekdays.
7. **Licence** of the ISZZ data (G4, §9).
8. The request budget in weeks with four non-final months is about 67 requests, slightly above critic §4.9's 60 (§2.7).
