# Architecture and interface contract

This document is the **binding contract** between the parts of the repo. Every module implements
exactly the interface given here. A change to an interface is made here first, then in the code.

Background research, with every number sourced or tested, is in `docs/research/`. Read
`critic.md` §4 **first**: its "Decisions for implementation" override the other four reports
wherever they disagree. Two examples: ZAGREB-4 is the background, not Mirogojska, and
f_NO2 = 0.10.

---

## 1. What the app is

The app is the ZAGREB-1 counterpart of the reference repo `maksimir-pod-kisom`. The reference shows
two stadiums side by side, today's and a new one, under wind and rain. This app shows **two versions
of the neighbourhood around the ZAGREB-1 air-quality station**, the corner of Vukovarska and
Miramarska in Zagreb:

- **left view, "Danas / Today":** the city as built;
- **right view, "Scenarij / Scenario":** the same city with a chosen change. The change can be to
  the geometry (tree rows, a new building, a user-placed block, no trees) and/or to emissions
  (LEZ, EV share, electric buses, a car-free Miramarska, less traffic).

Both views share the weather and the hour. The GPU simulates the wind through the 3D city (buildings
from the LiDAR-updated ZG3D 2022 model), then the pollutant transport from roads and heating. The
page shows:

- concentration slices;
- the modelled value at the station inlet (4 m) next to what ISZZ measured;
- a 16-direction "sweep", i.e. a modelled vs measured pollution rose;
- a 72 h forecast that combines Open-Meteo ECMWF IFS weather, CAMS background and the precomputed
  receptor LUT.

Single HTML file, no build dependencies beyond Python 3 stdlib; three.js 0.170.0 from jsDelivr
through an importmap (same as the reference).

## 2. Frames, units and time (all modules)

| Item | Convention |
|---|---|
| World frame | x = east, y = up, z = south, metres. Origin = DHMZ station point 45.800496 N, 15.97422 E. `x = (lon − 15.97422)·77607.7`, `z = −(lat − 45.800496)·110540` (`tools/common.py:xz`). **Every** layer, including ZG3D, goes through this `xz()`. |
| Heights | metres above local ground; ground is flat (y = 0) in the model. Building part: `b` (base) … `h` (top). |
| Directions | meteorological "from" bearing, degrees clockwise from north. North = −z. Wind *blowing toward* vector = (−sin θ, 0, +cos θ) in (x, y, z). |
| Receptor | ZAGREB-1 inlet at (0, 4.0, 0) = `RECEPTOR` in core.js. |
| Time | Internally **UTC, hour-ending** (ISZZ convention: a value stamped 10:00Z is the mean of 09:00–10:00Z). `Date` objects or epoch ms. Display in Europe/Zagreb as local "HH:00", with a hint that it means the hour ending then. Model "hour of day" for traffic profiles = local hour-*start* (hour-ending minus 1 h, then in local time). |
| Concentrations | µg/m³ for everything except CO in mg/m³ (as ISZZ). Model internals may use µg/m³ for CO and convert only for display. |
| Emission rates | line sources g m⁻¹ s⁻¹; area source (heating) g m⁻² s⁻¹. |
| Traffic | AADT in veh/day for the carriageway as mapped (a one-way way carries its share). |

## 3. Repository layout and ownership

```
config/site.json            all constants (station, frame, API URLs, defaults). Embedded as SITE.
tools/                      Python 3 stdlib data pipeline (numpy optional only in calibrate.py)
  common.py                 paths, SITE, xz(), cached/paced HTTP get(), RDP, JSON writer
  fetch_iszz.py             ISZZ export → data/processed/iszz_hourly.csv.gz          [meas-data]
  fetch_meteo.py            Open-Meteo archive (ecmwf_ifs) → data/processed/ifs_hourly.csv.gz [meas-data]
  build_measurements.py     → src/data/measurements.json                            [meas-data]
  fetch_osm.py              Overpass → data/cache/osm/*.json                         [geo-data]
  fetch_zg3d.py             ZG3D FeatureServer → data/cache/zg3d/*.json               [geo-data]
  fetch_dtm.py              DGU 20 m DTM range reader → data/cache/dtm/*.json         [geo-data]
  build_env.py              → src/data/env.json (+ src/data/lod2.bin)                [geo-data]
  aqmodel.py                Python mirror of meteo/emissions/chemistry/fallback      [models]
  calibrate.py              LUT + measurements → src/data/calibration.json           [models]
  export_lut.py             drives the app headless (?sweep=lut) → src/data/lut_receptor.json [flow]
  build.py                  src/ → dist/index.html (+ dist/test.html)                [lead]
src/
  page.html style.css       markup + styles (placeholders: see tools/build.py)       [ui]
  data/                     env.json lod2.bin measurements.json calibration.json lut_receptor.json
  js/  i18n.js core.js      registry, shared utils                                   [lead]
       meteo.js chemistry.js emissions.js model.js fallback.js                        [models]
       scene.js city.js visuals.js                                                    [scene]
       voxel.js wind-tunnel.js aero.js                                                [flow]
       scalar.js                                                                      [scalar]
       data.js charts.js main.js  (+ UI strings in main.js via I18N.add)             [ui]
       tests/*.test.js          one file per owner (models.test.js, scalar.test.js, …); run.js [lead]
tests/python/test_*.py      unittest, run with `python3 -m unittest discover -s tests/python`
tests/browser/              harness.py, run_selftest.py, smoke.py (playwright, dev only)
docs/                       numbered chapters (§9), research/, architecture.md (this file)
```

Each file has exactly one owner, shown in brackets. An owner may read every file but edits only
their own. If you need something from another owner's module, code against the interface below. For
work in isolation, add a guarded stub in your own file, e.g. `typeof ScalarSolver === 'undefined'`.

The browser module is **one shared scope**. Files are concatenated in the `ORDER` of
`tools/build.py`. A top-level `const`/`function`/`class` is visible to every **later** file, and to
earlier files only at call time. Consequences:

- Never re-declare a name that another file owns.
- Prefix private helpers with the file's short name (`vox_`, `sc_`, `em_`, …) or keep them inside
  a class or IIFE.

## 4. Baked data schemas (tools → src/data)

### 4.1 `env.json` (geo-data)

```jsonc
{
  "meta": { "generated_utc": "...", "frame": {...copy of SITE.frame...},
            "sources": { "zg3d": {"fetched": "...", "parts": 4333}, "osm": {...}, "dtm": {...} },
            "attribution": ["© Grad Zagreb – ZG3D 2022 …", "© OpenStreetMap contributors (ODbL)", "..."] },
  "buildings": [ { "p": [[x,z],...],      // footprint ring, CCW or CW, no repeated end point, RDP 0.6 m
                   "b": 0.0, "h": 21.4,   // base and top above local ground, m
                   "s": 2022,             // source year (ZG3D Godina_izv) or 0 for OSM fallback
                   "k": "zg3d" | "osm",   // provenance
                   "id": "zg3d:123" } ],  // stable id (used by scenarios to remove buildings)
  "roads": [ { "p": [[x,z],...], "n": "Ulica grada Vukovara", "hw": "primary",
               "c": 0,              // 0 primary/trunk, 1 secondary, 2 tertiary, 3 residential/unclassified/living_street, 4 service, 5 non-motor (footway, cycleway, pedestrian, path)
               "l": 3,              // lanes on this way (default by class when missing)
               "o": 0,              // oneway: 1 = along p, -1 = against, 0 = two-way
               "w": 10.5,           // carriageway width, m (lanes × 3.25 by default; overrides near the station, critic §1.6)
               "g": "A",            // source group: "A" Vukovarska, "B" Miramarska, "C" other motor roads, null = no emissions
               "aadt": 23500 } ],   // veh/day carried by THIS way (one-way carriageways carry their share)
  "tram": [ [[x,z],...] ], "rail": [ [[x,z],...] ],
  "trees": [ { "x": 1.0, "z": 2.0, "h": 12, "r": 4, "k": "osm" | "chm" | "station" } ],
  "green": [ [[x,z],...] ], "water": [ [[x,z],...] ], "paved": [ [[x,z],...] ],
  "heating": [ { "p": [[x,z],...], "w": 0.8 } ],   // low-rise residential polygons, relative heating weight
  "pois": [ { "t": "school" | "kindergarten" | "hospital" | "fuel", "n": "OŠ …", "x": 0, "z": 0 } ],
  "labels": [ { "t": "Vukovarska", "x": 0, "z": 0, "k": "road" | "poi" | "park" | "water" } ],
  "station": { "x": 0, "z": 0, "inlet": 4.0, "container": [[x,z],...], "tree": {"x": -5, "z": -10, "h": 14, "r": 9} },
  "morph": { "lambda_p": 0.246, "lambda_f": 0.193, "Hbar": 14.2, "d": 6.8, "z0": 1.47,
             "sectors": [ {"from": 0, "z0": 1.35, "d": 5.6, "Hbar": 12.8}, … 8 sectors ] }
}
```

Coordinates are rounded to 0.1 m. Target size is under 1.5 MB.

As implemented (tools/build_env.py, docs/02-geometry.md; integration review 2026-09-28):

- `buildings[].p` is one ring per part. A courtyard is joined to its outer ring by a zero-width bridge (a "keyhole"
  ring with non-consecutive duplicate vertices). Even-odd fills, `pointInPoly`, the voxeliser and `THREE.Shape`
  handle it; code that offsets or outlines rings sees a double edge along each bridge.
- `heating[].w` is relative to the heating area: its area-weighted mean over all heating polygons is 1 (range
  0.22–2.5, capped at 3), so q_D is the mean areal rate over the heating area. The polygons are 50 m tiles clipped
  to `landuse=residential`.
- Group B also holds "Miramarski podvožnjak" (the southbound underpass of Miramarska N). The two orthophoto-checked
  carriageways at |z| ≤ 40 m (critic §1.6) are ordinary `roads` entries whose `w` is the measured width.
- Non-motor ways (`c` = 5) have `l` = 0 and a display width `w`. Trees carry `k` = `"osm"` or `"station"`
  (no `"chm"` trees); the station tree is in `trees[]` and in `station.tree` (city.js de-duplicates).
- `meta` also has `extent`, `notes` and more detail under `sources`; `morph.sectors[]` also carry `lambda_p`, `lambda_f`.

`lod2.bin` (optional, geo-data writes it, scene reads it) is little-endian:

- header: 16 bytes = magic `ZL2B`, `uint32` version = 1, `uint32` nTri, `uint32` 0;
- `Int16` positions `[nTri*9]` in **decimetres** (x, y, z per vertex, y above ground);
- `Uint8` per-triangle class `[nTri]` = source year − 2000 (0 = unknown);
- zero padding to a multiple of 4.

Radius is 500 m. Budget is about 2.5 MB.

### 4.2 `measurements.json` (meas-data)

```jsonc
{
  "meta": { "generated_utc": "...", "station": 155, "background": 303, "model": "ecmwf_ifs",
            "t0": 1759276800000,   // epoch ms UTC of index 0 (hour-ending)
            "n": 9600,             // hourly steps (the last ~400 days)
            "attribution": ["..."] },
  "series": { "z1.no2": "<base64 Int16 LE>", ... },   // value = int16 * scale; -32768 = missing
  "scale":  { "z1.no2": 0.1, "z1.co": 0.001, "ifs.blh": 1, ... },
  "keys": ["z1.no2","z1.nox","z1.pm10","z1.pm25","z1.so2","z1.co","z1.c6h6","z1.ws","z1.wd","z1.t","z1.rh",
           "z4.no2","z4.nox","z4.o3","z4.pm10","z4.pm25",
           "ifs.u10","ifs.wd10","ifs.blh","ifs.t2","ifs.cc","ifs.sw"],
  "stats": {
    "period": ["2023-01-01", "2026-09-27"],
    "annual": { "z1.no2": {"2023": 35.0, ...}, ... },               // means, only years with ≥ 75 % coverage
    "diurnal": { "z1.no2": { "weekday": [24], "saturday": [24], "sunday": [24] }, ... },  // by LOCAL hour-start
    "monthly": { "z1.no2": [12], ... },
    "rose":    { "inc.nox": { "sectors": 16, "mean": [16], "n": [16] }, "z1.no2": {...}, ... },  // by IFS wind-from sector; inc.* = Z1 − Z4
    "exceed":  { "no2_1h_200": {"2025": 0}, "pm10_24h_50": {"2025": 23}, ... },
    "coverage": { "z1.no2": 99.4, ... },
    "increment": { "nox": 46.1, "no2": 15.0, "pm10": 1.3, "pm25": 2.6 }   // annual mean Z1 − Z4, last full year
  },
  "latest": { "z1.no2": { "t": 1790535600000, "v": 41.2 }, ... }
}
```

The app decodes it with `Hist` (data.js). Tools keep the full 2023–present hourly tables in
`data/processed/*.csv.gz` for calibration.

As implemented (tools/build_measurements.py, docs/01-data-sources.md), fields a decoder may ignore are added:
`meta.time`, `meta.missing`, `meta.units` (per key, including `inc.*`), `meta.validated_until` (last validated
timestamp per ISZZ key, null for raw-only; the UI draws raw and validated data differently), `meta.sources`;
`stats.rose[k].calm {mean, n}` and `u_min` = 0.5 m/s, `stats.rose['ifs.u10']` (the wind rose), `stats.coverage_by_year`,
`stats.exceed_n`, `stats.exceed.pm10_24h_50_ref` / `pm10_24h_45_ref` (gravimetric reference method, the official
count), `stats.increment_year`, `stats.ytd {year, through, mean, coverage}`. Definitions: `annual` holds complete
calendar years only (≥ 75 % of hours; the running year is in `ytd`); wind-direction keys are left out of the means;
roses bin by the IFS direction and count hours with IFS U10 < 0.5 m/s as calm; a 24 h exceedance needs ≥ 18 valid
hours per local day; `increment` pairs each parameter on its own hours. `data/processed/` also holds
`iszz_pm10_gravimetric.csv` and `ifs_hourly.meta.json`; the IFS boundary-layer height is missing before 2024-09-01
and for 493 h in September–October 2025 (meteo.js then uses the class median BLH).

### 4.3 `calibration.json` (models, `tools/calibrate.py`)

```jsonc
{ "status": "calibrated" | "uncalibrated" | "fallback-only",
  "beta": 1.0, "U0": 1.4, "h_min": 100, "f_no2": 0.10,
  "model": "lbm" | "gauss",
  "period": ["2025-01-01","2025-12-31"], "fetch_date": "...",
  "metrics_test": { "FB":…, "NMSE":…, "MG":…, "VG":…, "FAC2":…, "NAD":…, "R":…, "n":… },
  "baseline_test": { …same keys… },
  "by_sector": [16], "by_hour": [24],        // obs/mod ratios on test data
  "gauss": { "beta": 4.2, "metrics_test": {...} },   // the fallback's own calibration
  "notes": "..." }
```

As implemented (tools/calibrate.py, docs/07-calibration.md): `status` is `"calibrated"` with `model: "lbm"` once a
receptor LUT exists (the top level is then the LBM fit), `"fallback-only"` with `model: "gauss"` before. Both `gauss`
and `lbm` (null without a LUT) carry `{beta, U0, U0_at_bound, n, metrics_test, metrics_lomo, baseline_test,
baseline_lomo, raw_physics_test, folds, lomo_params, totals_test, mean_obs, mean_mod_raw, by_sector, by_hour,
by_class, by_speed, by_month, by_daytype, baseline_diag}`; `lbm` also has `lut_meta`. Top-level additions:
`baseline`, `congestion_share`, `chemistry_check`, `inputs`, `generated_utc`. β is fitted on the LUT's grid
(`lbm.lut_meta.grid`), so live fields on another grid do not replace the LUT (model.js, §6.1).
tools/build.py `DEFAULT_CAL` is used only when calibration.json is missing.

### 4.4 `lut_receptor.json` (flow, via `tools/export_lut.py` → the app's `?sweep=lut` mode)

```jsonc
{ "meta": { "scenario": "today", "grid": "120x120x32@5m", "generated_utc": "...", "version": 1 },
  "dirs": [0, 22.5, …, 337.5], "classes": ["AC","D","EF"], "groups": ["A","B","C","D"],
  "gamma": [dir][class][group],     // Γ at RECEPTOR, units per §5.3
  "age":   [dir][class][group],     // plume age A at RECEPTOR (s·U_ref-normalised; see scalar.js docs)
  "band":  [dir][class][group][2],  // min/max over 3×3×2 cells (representativeness)
  "wind":  [dir] { "s4": 0.4, "s10": 0.6, "dir4": 250, "dir10": 245 }   // model wind at the mast as fraction of U10
}
```

When `LUT` is null, `model.js` falls back to `FallbackModel` receptor values, labelled "approximate".

As implemented (aero.js `exportLUT`, tools/export_lut.py): `age` is the raw age tracer A_k (units of Γ_k × m), and
model.js computes τ = Σ q_k A_k / (U_eff Σ q_k Γ_k) in seconds. `meta` also has `complete`, `missing`, `status`,
`code`, `code_hash` (aero.js `aero_codeHash()`, from exports after 2026-09-28), `geometry_hash`, `env_generated_utc`, `leaves` (the tree state it was computed with), `spinup`, `lbm`,
`inflow`, `stab` (the representative class and lid per group), `receptor`, `mast_heights_m` and `timing`.
`tools/export_lut.py --check` validates a file against this schema.

## 5. Physics contract (summary; the full spec is `docs/research/physics.md` with the critic's §4 corrections)

### 5.1 Grids

`tunnelGrid(dx)` gives `{dx, up, nx, ny, nz, tx, W, H, warm, avg, every}`. The fine grid is 5 m,
120×120×32 cells (600 × 600 × 160 m), with the station 300 m from the inlet. The coarse spin-up grid
is 10 m. `?grid=coarse`, or a software renderer, uses 10 m as the fine grid.

The atlas layout is identical to the reference: layer k is the tile `(k % tx, floor(k / tx))`, and
cell (x, y, k) sits at texel `(x + (k % tx)·nx, y + floor(k / tx)·ny)`. The tunnel frame (voxel.js)
is `{from, ex, ey, origin}`: `ex` points downwind, `ey` across, and `origin` is the inlet corner on
the ground, with the station at `up` metres along `ex` and centred across.

### 5.2 Flow

Reference LBM D3Q19 (D3Q15 fallback) with Smagorinsky: C_s = 0.17, τ0 = 0.506, U_LATTICE = 0.075.

- The inlet profile is `inflowProfile(z)` from physics §6.3: log law with urban z0 = 1.5 m and
  d = 7 m, canopy profile below H̄ = 14 m, as a fraction of the 10 m reference wind.
- The ground is free-slip, as in the reference.
- **New in this repo:** the surrounding buildings and trees are voxelised. In the reference only
  the stadiums were.
- The output is a `WindField` in the reference format: `data[(z*ny+y)*nx+x)*4] = (u, v, w, |u|)` as
  fractions of U10 in tunnel axes, plus `mask` (a Uint8Array grid: 255 solid, 1–249 porous, 0 fluid)
  and `frame`.

As implemented (wind-tunnel.js, voxel.js, docs/03-flow-lbm.md):

- `tunnelGrid()` also returns `id` (e.g. `"120x120x32@5m"`, the grid id every cache, the LUT and model.js compare)
  and `ft` (steps per flow-through); `warm` and `avg` are given in flow-throughs. `SPINUP` is twice the fine cell
  (20 m when the fine grid is 10 m).
- `inflowProfile(10)` is 0.357, not 1: the urban log law is matched to U10 at the blending height z_b = 80 m over the
  NWP roughness z0r = 0.3 m (physics §6.2, critic §4.4). The NWP profile itself is 1 at 10 m.
- Mask bytes: voxel.js writes 255 for solid cells and caps porous cells at 249; the LBM treats byte/255 > 0.99 as
  solid, WindField and the scalar solver ≥ 250, so the three agree.
- `WindTunnel.flow()` holds Σ over samples of the lattice velocity (porous cells already divided by
  1 − 1.2·m in the acc pass) in `avg.xyz` and Σ|u| in `avg.w`; û = avg.xyz / (samples · uLattice).
  `ScalarSolver.flowFromField()` gives the same shape from a WindField with samples = uLattice = 1.

### 5.3 Scalar

Steady advection–diffusion on the frozen mean flow, with K-theory closure.

- Four source groups go in RGBA: **A** Vukovarska, **B** Miramarska, **C** other roads, **D**
  heating. Four age tracers go in a second MRT target.
- Unit response Γ_k [m⁻¹ for line groups A–C, dimensionless for area group D] is defined by

  `ΔC_k [µg/m³] = 1e6 · β · q_k · Γ_k / U_eff`

  where q_k is the group's reference source strength and `U_eff = √(U10² + U0²)`.
- Per-cell source weights (voxel.js `rasterizeSources`):
  - groups A–C: `Σ_roads (length of the road inside the cell [m]) · aadt / SITE.model_defaults.aadt_unit (10 000)`, so q_k is the emission of 10 000 veh/day of the group's traffic, in g m⁻¹ s⁻¹;
  - group D: `Σ (heating polygon area inside the cell [m²]) · w`, so q_D is in g m⁻² s⁻¹.
  - Road sources fill the lowest cell layer (0–5 m) across the carriageway width. Heating sources
    go in the layer containing roof level of the low-rise buildings (default 8 m).
- Stability enters through the K field (Monin–Obukhov part, per group `AC`, `D`, `EF`), not through
  the flow (v1 flow is neutral). The ScalarSolver takes a `turb` object (§6.2).
- Each group is solved with one representative class and lid (aero.js `AERO_STAB`, the group's most frequent IFS
  2025 class and that class's median BLH, floored at h_min): AC → B with 520 m, D → D with 135 m, EF → F with
  100 m. The UI's lid control is therefore display-only (the Aero key has no lid).
- Sources in the last 100 m before the outlet (the LBM sponge, physics §5.3) are dropped by both
  `rasterizeSources` and the solver; a source in a solid cell moves to the first open cell above it. On the 10 m
  grid the 8 m heating layer is the ground layer, which is one reason Γ_D differs 3× between 10 m and 5 m.

## 6. JavaScript interfaces

`→` marks return values. Everything not listed is private to its file.

### 6.1 Pure modules [models] (no THREE, no DOM, except `dirName`, which uses `t()`)

**meteo.js**
- `DIRS16: number[16]` (0, 22.5, …) · `dirIndex16(deg) → 0..15` · `dirName(deg) → {short, text}` (i18n, e.g. "SI", "sa sjeveroistoka")
- `beaufort(v) → {b, name}` · `solarElevation(dateUTC, lat, lon) → deg`
- `stabilityClass({u10, sw, cloud, dateUTC}) → 'A'..'F'` (SRDT by day, Turner by night) · `stabilityGroup(cls) → 'AC'|'D'|'EF'`
- `obukhovLength(cls, z0) → L` (Golder) · `mixingHeight({cls, blh, mode}) → m` (mode 'nwp'|'100'|'315'; floor `h_min`)
- `uEff(u10, U0 = CAL.U0) → m/s` · `directionWeights(fromDeg, u10) → Float32Array(16)` (Gaussian kernel, σθ = min(60°, 22.5°·max(1, 2/U)); U < 0.5 → uniform)
- `turbParams(cls, {z0, d, Hbar, h_eff}) → turb` (the object the scalar solver takes, §6.2)
- `jNO2(sw) → s⁻¹` (Trebs 2009) · `kNOO3(tempC) → ppb⁻¹ s⁻¹`
- `vectorMeanWind(list of {u, dir}) → {u, dir}`

**chemistry.js**
- `PPB` conversions · `no2Chemistry({noxInc, no2Bg, noxBg, o3Bg, tau, J, k, fNO2}) → {no2, no, o3, nox}` (Riccati finite-time scheme with conserved oxidant, physics §8 / critic §1.2; all µg/m³)
- `THRESHOLDS` (EU limit/target values under AAQD 2024/2881, WHO 2021, information/alert thresholds; per pollutant and averaging time) · `EAQI_BANDS` (EEA 2024) · `eaqi(pollutant, value, avg='1h') → {level 1..6, key, color}`

**emissions.js**
- `EF_DEFAULT` (g/veh/km: nox 0.50, pm10_exh 0.017, pm10_nonexh 0.029, pm10_resusp 0.056, pm25 0.032, co 0.49, c6h6 0.0036)
- `TRAFFIC_PROFILES` (hour-of-day by day type, day-of-week, month; critic §4.6)
- `trafficFactor(dateUTC) → f`, where veh/h = AADT · f / 24; the weekly mean of f is 1
- `measureFactors(measures) → {exhaust, nonexhaust, byGroup:{A,B,C}}` (measures = `{lez, evShare, eBus, carFreeMiramarska, trafficPct, trafficA, trafficB, congestion, resuspension}`)
- `groupStrengths(pollutant, dateUTC, measures, opts) → {A, B, C, D}`. q_k for one pollutant at that hour: g m⁻¹ s⁻¹ (A–C) per 10 000 veh/day unit, g m⁻² s⁻¹ (D). Heating only when `opts.heating` (season toggle) is set.
- `POLLUTANTS = ['nox','no2','pm10','pm25','co','c6h6']` · `POLLUTANT_INFO[p] → {unit, label, iszz}`

**model.js**
- `class ReceptorModel { constructor({lut, fallback, cal}); gammaAt(dirDeg, u10, cls) → {gamma:[4], age:[4], source:'lut'|'field'|'fallback'} }`. Direction-smoothed over the 16 LUT directions; a live `ScalarField` can override the LUT via `setField(scenario, dirIdx, stabGroup, field)`.
- `increment({gamma, age}, strengths, u10, cal) → {total, byGroup:[4], tau}` (µg/m³)
- `concentrations({met, dateUTC, measures, background, pollutant: 'all', gammaAge, opts}) → { nox, no2, no, o3, pm10, pm25, co, c6h6, inc:{…}, byGroup:{…}, bg:{…} }`. This is the one function the UI calls for any receptor/hour.
- `cellValue(gamma4, age4, strengthsAll, met, bg, pollutant) → number` (for slices; NO₂ via chemistry per cell)
- `metrics(obs[], mod[]) → {FB, NMSE, MG, VG, FAC2, NAD, R, n}` (Chang & Hanna 2004; the same code is mirrored in `tools/aqmodel.py`)

**fallback.js**
- `class FallbackModel { constructor(env); receptor(dirDeg, cls) → {gamma:[4], age:[4]}; slice(dirDeg, cls, height, grid{x0,z0,dx,nx,nz}) → Float32Array(nx*nz*4) }`. Gaussian line source with Briggs urban σ plus OSPM-type receptor term (physics §9). Γ uses the same units and normalisation as the scalar solver, so everything downstream is identical.

**As implemented in the pure modules** (docs/05–07; integration review 2026-09-28):
- Measures are **percent**: `evShare` 0–100, `trafficPct`, `trafficA`, `trafficB` with 100 = today.
  `groupStrengths` opts: `heating: true | 'auto' | false` ('auto' = October–March), `ef` (EF overrides),
  `heatingScale`, `congestionShare {A, B}`.
- `concentrations()` returns CO in mg/m³ and expects background CO in mg/m³; temperature is `met.t2` (not `met.t`,
  which the UI uses for the time); extra outputs `band` and `meta {source, coverage, cls, group, uEff, beta, U0,
  status, …}`. A missing background value uses `MOD_BG_DEFAULT` (ZAGREB-4 2025 means).
- `ReceptorModel`: also `shared()`, `clearFields(scenario?)`, `hasField()`, `lutGrid`. `gammaAt(dir, u10, cls,
  scenario = 'today')` also returns `band, queue, coverage, parts, group`. `setField` records the field's grid id
  (`field.grid` or `field.T.id`). **Grid rule:** a live field replaces the LUT only on the LUT's grid (or when either
  grid is unknown, or there is no LUT); a scenario field on another grid is carried onto the LUT as a relative change
  against the same-grid 'today' field (`mod_deltaOnLut`), because β is fitted on the LUT's grid (Γ changes by up to
  3× between 10 m and 5 m).
- `increment(ga, q, u10, cal?, calibrated = true)`: without `cal` each source part gets its own calibration
  (`mod_calFor`: the Gaussian β is never applied to 3D values).
- Further public helpers: `thresholdLines()`, `EAQI_BANDS_ISZZ`, `eaqi(p, v, avg, scheme = 'eea2024' | 'iszz')`,
  `sliceContext()`, `mqi()`, `MOST`, `EM_MEASURES_TODAY`, `CHEM_TAU_DEFAULT`, `MOD_BG_DEFAULT`, `met_localParts`,
  `directionWeights(from, u10, dirs = DIRS16)`; `turbParams` also returns `group, invL, z0r, zb` (invL = 0 for
  neutral); `FallbackModel(env, {radius, spacing, heatCell, receptor, hMin})`, `receptor()` also returns
  `queue, canyon, n`, `slice()` samples cell centres, `sliceAsync()`.

### 6.2 GPU physics [flow] + [scalar]

**voxel.js** [flow]
- `tunnelFrame(center: Vector3, fromDeg, T) → {from, ex, ey, origin}`
- `voxelize(geo, frame, T) → {grid: Uint8Array(nx*ny*nz), atlas: Uint8Array(W*H)}`. `geo` = `cityGeometry()` (§6.3): prisms `{p, b, h, s}` with s = solid fraction (1 = building), trees `{x, z, h, r, lad}` → porous.
- `rasterizeSources(geo, frame, T) → Float32Array(W*H*4)` (per-cell group weights, §5.3)
- `wallDistance(grid, T) → Float32Array(nx*ny*nz)` (m)

**wind-tunnel.js** [flow], ported from the reference with its header credit kept
- `LBM = {ok, q, software}` · `tunnelGrid(dx, {warm, avg})` · `TUNNEL`, `SPINUP` · `U_LATTICE` · `inflowProfile(zMetres) → fraction of U10`
- `class WindTunnel { constructor(T, S?); begin(geo, fromDeg, seed?); advance(n) → progress; flow() → {avg: Texture, samples, mask: Texture, T, frame}; async collect() → WindField }`
- `class WindField { from, frame, T, nx, ny, nz, dx, data, mask; sample(p, out) → bool; vel(p, out) → Vector3 (world axes, fraction of U10); speed(p); solidAt(p) }`

**scalar.js** [scalar]
- `class ScalarSolver { constructor(T); static flowFromField(windField) → flow; begin(flow, src: Float32Array(W*H*4), turb, frame, opts?); advance(nSweeps) → progress 0..1; get done; async collect() → ScalarField }`
  - `flow`: `{avg: THREE.Texture (RGBA32F atlas: Σ lattice velocity over samples), samples, uLattice, mask: THREE.Texture (R8 atlas)}`. This is exactly what `WindTunnel.flow()` returns.
  - `turb`: `{cls, L, ustar_hat, h_eff, z0, d, Hbar, Sct, lambda, kmin, kappa}` from `turbParams()`.
- `class ScalarField { frame, T, nx, ny, nz, dx, gamma: Float32Array(n*4), age: Float32Array(n*4), mask, stats: {sweeps, residual, mass:[4]}; sample(p: Vector3, out: Float32Array(8)) → bool; receptor(p = RECEPTOR) → {gamma:[4], age:[4], band:[[min,max]×4]}; slice(hMetres) → {nx, ny, data: Float32Array(nx*ny*8)} }`

**aero.js** [flow]
- `class Aero { constructor({onResult(res), onProgress(job, prog, queue)}); request(key, priority='view'); sweep(keys); tick(); cancelView(scenario); get busy; cache; exportLUT(scenario='today', classes) → object (§4.4) }`
- `key = {scenario: 'today'|<id>, dir: 0..15, stab: 'AC'|'D'|'EF'}`. Geometry comes from `cityGeometry(scenario)`. `res = {key, wind: WindField, conc: ScalarField, receptor: ScalarField.receptor()}`.
- Pipeline: spin-up (10 m) → fine (5 m) → scalar for `key.stab`. The flow is cached per (scenario, dir), so another stability group reuses it through `ScalarSolver.flowFromField`.
- Caches: an in-memory LRU of 16 entries. IndexedDB persistence of receptor values and fields is optional and must tolerate an empty or blocked store (try/catch).
- `?sweep=lut` mode: once booted, compute all 16 dirs × 3 classes for 'today' and put `exportLUT()` on `window.__lut`, which `tools/export_lut.py` collects.

**As implemented in the GPU modules** (docs/03, docs/04):
- `voxelize()` also returns `stats`; `rasterizeSources(geo, frame, T, {outletGap = 100})`. Public helpers:
  `vox_worldToTunnel`, `vox_tunnelToWorld`, `vox_envGeometry`, `vox_geoHash`, `VOX`, `INFLOW`, `INFLOW_K`,
  `inflowConstants`, `WT_RENDERER`, `WT_RUN`, `WT_CENTER`, `WT_FINE_DX`.
- `new WindTunnel(T, S?, {profile})`, `begin(geo, from, seed?, {center, voxels})`, `dispose()`; `flow()` also returns
  `T, frame, grid (Uint8Array mask), from`. WindField also carries `T, samples, uLattice`.
- `ScalarSolver`: static `supported`, getters `sweeps`, `progress`, `readVK()`, `dispose()`; `begin()` opts `grid,
  wallDist, lidK, probes, seed, tvd, keepFlow` plus any solver parameter. It must draw with the same WebGL context as
  the tunnel (`sc_renderer()`: scene.js `renderer`, else `WT_RENDERER`). `ScalarField.receptor()` also returns
  `inside`; `slice(h)` returns `{nx, ny, dx, h, frame, data, solid}` with **8 values per column** (Γ_A..D, A_A..D);
  `stats` holds `{sweeps, converged, reason, residual, mass[4], massErr, massWithinTol, divergence, …}`; `describe()`.
- `Aero({onResult(res, kind), onProgress, onFlow, geometry, T, S, maxEntries, persist, turbFor})`; `res` also has
  `mast, grid, hash, turb, timing`; a receptor-only sweep job answered from the receptor store (this session or
  IndexedDB) is delivered with `wind = conc = null, stored: true`. Methods `invalidate(scenario?)`, `sweepLUT(opts)`,
  `label(job)`, `dispose()`, getter `available`. Job stages `'wait' | 'spinup' | 'fine' | 'scalar' | 'read'`.
  `sweepLUT` publishes `window.__lutProgress` and `window.__lut`; `window.__z1_startLUT()` starts one if main.js did not.

### 6.3 Scene [scene] (scene.js, city.js, visuals.js)

- scene.js: `renderer`, `canvas`, `scene`, `sun`, `hemi`, `sky`, `skyUniforms`, `M` (materials), `flatGeometry`, `ribbonGeometry`, `addMesh`, `timeUniform`, `setDaylight(dateUTC, cloud)` (sun position from `solarElevation`).
- city.js:
  - `SCENARIOS: [{id, geo: bool (needs its own flow), label key, desc key}]` with ids `'today', 'trees', 'block', 'tower', 'notrees', 'custom'`
  - `buildCity() → {root, buildings, lod2 (lazy), trees, station, labels:[{text,pos,kind}]}`
  - `scenarioLayer(id) → THREE.Group` (objects that only the scenario view shows or hides)
  - `cityGeometry(scenarioId) → {prisms:[{p,b,h,s}], trees:[{x,z,h,r,lad}], roads, heating}`. This is what voxel.js consumes. The container is excluded. Removed buildings are dropped, added ones appended.
  - `setCustomBlock({x, z, w, d, h, rot})`
  - `setLeaves(mode: 'on'|'off'|'none')`
  - `colorBuildings(mode: 'plain'|'year'|'height')`
- visuals.js:
  - `class ConcSlice { constructor(parent); update(field|null, valueFn(gamma4, age4) → number, heightM, visible, scale) }` (texture on a plane in the tunnel frame, fades at the edges)
  - `class Particles { constructor(parent, env); update(dt, windField, u10, visible) }` (display only, released along source roads)
  - `class WindStreaks` (port)
  - `class LabelLayer` (port)
  - `concColor(value, scale, out)` · `CONC_SCALES[pollutant]` (break points from EAQI bands) · `legendHTML(pollutant)`
- As implemented (docs/12-rendering.md): city.js also exports `cityView(id)` (call before drawing each view),
  `setXray(on)`, `async setLod2(on) → bool`, `decodeLod2(src)`, `buildingLegendHTML(mode)`, `CITY_SOURCE_GROUPS`;
  `buildCity()` also returns `treesRoot` and `overlays.sources`; `cityGeometry().trees[]` carry the crown base `cb`
  (voxel.js reads it) and prisms keep the ZG3D year as `year` (`s` is the solid fraction); scenario layers list what
  they hide in `userData.hide` (alias `hides`) and their labels in `userData.labels`; `Bus 'city:changed'` fires on
  `setCustomBlock` and `setLeaves`. visuals.js also exports `concBand`, `setConcPalette('cb' | 'eaqi')`,
  `particleLegendHTML()`, `ConcSlice.gridField(grid, data, stride)`, `Particles.setStrengths({A, B, C, D})` and
  `LabelLayer.addAll/remove/clear/relabel`; `LabelLayer.update` hides labels that would overlap a label of higher
  priority (station, scenario, road, park, water, POI). `Particles.update` and `WindStreaks.update` take
  `(dt, windField, u10, visible)`; `new WindStreaks(parent)`.

### 6.4 UI [ui] (page.html, style.css, data.js, charts.js, main.js)

- data.js:
  - `Hist` (decodes MEAS: `series(key) → Float32Array` with NaN for missing; `t0`, `n`, `timeAt(i)`, `indexAt(ms)`, `stats`)
  - `Live` (browser clients with requests serialised at 1.1 s and 429 back-off):
    - `iszz(station, param, fromMs, toMs, type=0) → [{t, v}]`
    - `recent(hours=72) → {z1:{…}, z4:{…}}`
    - `eaqi() → {…}`
    - `forecast() → [{t, u10, wd, blh, t2, cc, sw}]` (ecmwf_ifs, past_days=2, forecast_days=3, hour-ending averages)
    - `cams() → [{t, no2, o3, pm10, pm25}]`
  - `localHour(ms)`, `fmtLocal(ms)`
- charts.js: all SVG with `role="img"` and aria-label, themed through CSS variables:
  - `lineChart(el, {series, band, thresholds, unit, yMax})`
  - `roseChart(el, {values, compare, labels})`
  - `barChart`
  - `diurnalChart`
- main.js: `state`, UI binding, views, cameras, boot, frame loop. It must:
  - set `window.__z1 = {ready, fields, receptor, errors, state}`. `ready` is true after boot. `fields` counts completed Aero results. `receptor` is the latest modelled total at the station for the selected pollutant (a number).
  - **not** boot when `SELFTEST` is true (tests run on the same page).
- As implemented (docs/08-user-guide.md): data.js also exports `ZgTime` (Europe/Zagreb clock: `offset, parts,
  toUTC, hourStart, dayType, floor/ceil, currentHourEnding, iszzDate, isoLocalDate`), `Hist.create(meas)` and the test
  hooks `Live._setFetch`, `Live._parse*`, `Live.biasRatios`, `Live.status`. main.js calls `Live.forecast()` with
  3 past and 4 forecast days (the 72 h hindcast and forecast both fit) and `Live.cams()` with 14 past days (bias
  ratio). `barChart` also has `mode: 'stack'`. URL parameters: `lang=hr|en`, `grid=coarse|fine`, `live=0` (archive
  only, deterministic), `debug` (internals on `window.__z1dbg`), `sweep=lut`, and for dist/test.html `selftest`,
  `only=`, `skip-slow`. On a software renderer the 3D is redrawn at most every 1.5 s while Aero is busy (every 10 s
  under `?sweep=lut`), because drawing starves the LBM (measured ~80× faster without drawing).

## 7. Conventions

- Code style follows the reference: explanatory block comments above each unit, short lines of intent, no
  frameworks, no bundler. Modern JS (ES2022), no TypeScript.
- Every user-visible string goes through `t()`, with hr and en entries.
- **Accessibility:**
  - every control has a label;
  - the dial is keyboard operable (as in the reference);
  - charts have `aria-label` and a data-table fallback in `<details>`;
  - `prefers-reduced-motion` is respected;
  - colour is never the only carrier of meaning (EAQI chips show text).
- **Theming:** CSS tokens on `:root`, with dark mode through `prefers-color-scheme`, as in the reference. The 3D scene stays a daylight model.
- **No silent caps:** if anything is truncated or approximated (LUT missing, fallback model, stale data), the UI says so.
- **Honesty:**
  - "raw physics" vs "calibrated" is visible;
  - the model/measured comparison shows held-out metrics only;
  - limitations are linked from the footer.
- **Python:** stdlib, type hints, `if __name__ == "__main__"`, argparse, logging via `common.log`. No network in unit tests: use saved fixtures under `tests/python/fixtures/`.
- **Attribution strings** come from `SITE.attribution` and `ENV.meta.attribution`, and are shown in the footer.

## 8. Testing

| Layer | Where | How |
|---|---|---|
| Python tools | `tests/python/test_*.py` | `python3 -m unittest discover -s tests/python` (fixtures, no network) |
| Pure JS models | `src/js/tests/models.test.js` | `python3 tests/browser/run_selftest.py --only models` |
| Python ↔ JS parity | `tests/python/fixtures/parity_vectors.json` (written by the models owner), checked by both `test_aqmodel.py` and `models.test.js` | same inputs give the same outputs to 1e-6 relative |
| Scalar solver verification | `src/js/tests/scalar.test.js` | T1 analytic line source, T2 mass, T5 symmetry, T6 linearity (small synthetic grids). T3/T4 are `slow` |
| Flow + voxeliser | `src/js/tests/flow.test.js` | voxeliser against analytic prism volumes, frame round-trip, LBM uniform-flow sanity, source-raster length conservation |
| Scene/UI | `src/js/tests/ui.test.js` + `tests/browser/smoke.py` | boot, first field, no page errors, screenshot |
| End to end | `tests/browser/e2e.py` (`make e2e`) | today's field and one geometry scenario's field, finite station values in both views, scenario coverage > 0, no page or app errors, no horizontal scroll at 390 px, screenshots at 1440×900 and 390×844 |

## 9. Documentation chapters (docs/)

| File | Owner (first draft) | Content |
|---|---|---|
| `00-overview.md` | lead | What the app does, how the pieces fit, a diagram |
| `01-data-sources.md` | meas-data | ISZZ API (the endpoints we use, time semantics, limits), Open-Meteo, CAMS, what is fetched when |
| `02-geometry.md` | geo-data | ZG3D/LiDAR, DTM, OSM, frame, env.json build, height fallbacks, validation numbers |
| `03-flow-lbm.md` | flow | LBM, inflow profile, voxelisation, run control, caching, LUT export |
| `04-dispersion.md` | scalar | Governing equation, scheme, closure, BCs, convergence, verification results (T1–T6) |
| `05-emissions.md` | models | Traffic, fleet, EFs, profiles, heating, scenarios/measures |
| `06-chemistry.md` | models | NO–NO₂–O₃, background, thresholds, EAQI |
| `07-calibration.md` | models | Protocol, metrics, results (auto from calibration.json), baseline |
| `08-user-guide.md` | ui | Every control explained, with screenshots |
| `12-rendering.md` | scene | Renderer, materials, city meshes, scenarios, colour scales, slice, particles, labels |
| `09-limitations.md` | lead | Honest list |
| `10-runbook.md` | lead | Refresh data, recalibrate, export the LUT, build, deploy, troubleshoot |
| `11-process.md` | lead | The step-by-step process by which this repo was researched and built |
| `glossary.md`, `references.md` | lead | |
