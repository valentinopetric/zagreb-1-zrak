# Critic review of the ZAGREB-1 research reports

Review date: 2026-09-27. Reviewed: `lidar-3d.md`, `iszz-api.md`, `site-context.md`, `physics.md`, plus the
reference clone (`scratchpad/ref`). Everything under "Verified corrections" was re-tested on this machine. The
commands and scripts are in `research/data/critic/` (5 MB; listed in §5).

Reading guide:

- **§1 Verified corrections**: what was wrong, ambiguous or unverified, and what the test showed.
- **§2 Contradictions**: every disagreement between the reports, with a resolution.
- **§3 Remaining gaps**: items that cannot be settled from here.
- **§4 Decisions for implementation**: the binding list for building the repo.

---

## 0. Summary: the ten findings that change the build

1. **The "ERA5" in `physics.md` is not ERA5.** The file came from Open-Meteo `best_match`, which is
   **ECMWF IFS 9 km** (grid cell 45.7997 N, 15.9242 E). `site-context.md` used real ERA5 (0.25°, 45.75 N, 16.00 E).
   - The two differ a lot for 2025: calms (< 1 m/s) are 31 % in IFS against 17 % in ERA5, and the IFS rose is N/NNW-dominated while ERA5 is NNE/NE.
   - The fitted low-wind floor **U0 depends on the wind source**: 1.3–1.65 m/s with IFS, 1.56–2.68 m/s with ERA5.
   - IFS explains the NOx increment better (r = 0.25 against 0.22 with ZAGREB-4).
   - **Decision:** use `models=ecmwf_ifs` explicitly in *both* the archive (calibration) and the forecast API. It is available in both and includes boundary-layer height.
2. **Mirogojska (280) is not a usable background. Use ZAGREB-4 (303).**
   - Mirogojska's weekday NOx roughly doubles at 07–09 h (76–85 µg/m³ against a 33.6 annual mean). It has **no raw hourly NOx at all** (type 0 is not offered), so it cannot drive a live mode.
   - CAMS correlates worse with it than with ZAGREB-4 for NO2, O3 and PM10.
   - Re-running the physics chemistry test with ZAGREB-4 as background *improves* NO2 RMSE from 7.8 to **5.0 µg/m³** (r = 0.966, FB −0.01).
3. **The physics "effective emission profile" (06 h peak, 0.52 at 09 h) is an artefact of the Mirogojska background.** Recomputed with ZAGREB-4 and IFS: weekday peaks at 06–08 h (1.65–1.70) and 15–17 h (≈1.45); Saturday 0.65, Sunday 0.52 (`critic/effective_emission_profile_z4_ifs_2025.csv`).
4. **ΔPM10/ΔNOx = 0.19 also depends on Mirogojska.** With ZAGREB-4 it is 0.07. The local PM increment is small with any background (+1.3 to +8.3 µg/m³ on a background of about 25). Use bottom-up PM emission factors instead (§4.6).
5. **Primary NO2 fraction: 0.10, not the 0.25 in `site-context.md`.** With ZAGREB-4 background: f = 0.10, τ = 60 s gives FB −0.01; f = 0.20 already gives FB +0.10 at τ = 60 s.
6. **The missing north sector in station wind direction is most likely a data-processing artefact, not Vukovarska channelling.**
   - ZAGREB-4, a suburban background site, has the same kind of gap: no values in 327°–26° in 2025, and 333°–30° in 2026. ZAGREB-1's gap (282°–16°) is present in 2024, 2025 and 2026.
   - When IFS/ERA5 give a strong northerly (> 3 m/s), 28–47 % of hours at ZAGREB-1, ZAGREB-2 and ZAGREB-4 are reported from the *opposite* half-circle. The figure for SW winds is 1–2 %.
   - This looks like 0°/360° wrap-around averaging. The station vane must not be used to validate channelling for N/NW flows.
7. **Inlet height is 4 m** (EEA metadata; 3 m was the 2012 value). **Kerb distance is 9–12 m.** The 0.1 m city orthophoto (2022) shows the Miramarska west kerb 12 m (±1 m) east of the DHMZ point; EEA gives 9 m. `site-context.md`'s 15–18 m (from OSM lane placement) is too far. The OSM southbound centreline sits about 3 m east of the true carriageway centre.
8. **ZG3D morphometry within 500 m** (replaces physics' OSM-based numbers, 80 % of which used default heights): λp = 0.25, λf = 0.19, H̄ = 14.2 m, **d = 6.8 m, z0 = 1.47 m** (Macdonald 1998). The physics defaults (d = 8, z0 = 1.4, H̄ = 14) are therefore confirmed to within 1 m. The per-sector table is in §1.10.
9. **Frame mismatch.** The reference's local equirectangular frame (x = east, z = south, KX = 111320·cos φ) and the lidar prototype's EPSG:3765 offsets disagree by up to **5–6 m at 750 m**: grid convergence is about 0.37° here, plus a scale difference. Build every layer in **one** frame (§4.2).
10. **Default emissions under-predict by about 4×.** A Gaussian line-source run for 2025 (site-context AADT, EF_NOx 0.50 g/km, U0 = 1.4 with IFS, Briggs urban, no buildings) gives a mean ΔNOx of **11 µg/m³ against 46 observed** (ZAGREB-1 minus ZAGREB-4).
    - The physics claim that 3000 veh/h gives about 44 µg/m³ holds only for a perpendicular, direct-downwind hour.
    - It also misses night accumulation (observed/modelled ≈ 3 at night) and peaks in the evening instead of the morning.
    - **β must be fitted and shown.** Expect β ≈ 4 for the Gaussian fallback and smaller for the LBM, since the 3D flow shelters the receptor.

Also found: **the reference app does not put the surrounding buildings into its LBM.** It voxelises only the stadiums (`st.voxels` / `st.solids`); its README says "Okolne zgrade i park nisu u simulaciji" ("the surrounding buildings and the park are not in the simulation"). A prism voxeliser for about 1,500 ZG3D parts per tunnel is **new code**, not a port.

---

## 1. Verified corrections (claim → test → result → consequence)

### 1.1 Reanalysis mislabel and wind statistics (physics F1, F4, F5, F11, §6.4, §6.5; site-context §7.2)

Test: Open-Meteo archive 2025 with `models=best_match | era5 | ecmwf_ifs | era5_seamless` (`critic/om_*.json`).

| Model | Grid cell returned | Mean U10 | < 1 m/s | Rose top sectors | BLH median / < 50 m |
|---|---|---|---|---|---|
| `best_match` = `ecmwf_ifs` (the physics file) | 45.79965, 15.924171 | 1.73 m/s | 31.0 % | NNW 11.6, N 10.6, NNE 8.9, SW 8.1 | 170 m / 28.9 % |
| `era5` = `era5_seamless` (the site-context file) | 45.75, 16.0 | 1.98 m/s | 17.0 % | NNE 12.3, NE 12.2, SW 10.4 | 220 m / 21.4 % |
| `era5_land` | – | no 10 m wind returned | | | |

- Every physics number labelled "ERA5" is IFS: U0, BLH, stability-class frequencies, the rose ratios and `pg_class_2025_era5.csv`. They are valid, but must be relabelled.
- Speed correlation with station anemometers (U > 2 m/s): ERA5 r = 0.61 / 0.69 / 0.68 and IFS r = 0.56 / 0.68 / 0.62 for ZAGREB-4 / ZAGREB-2 / ZAGREB-1. Median direction error is 24–37° for both. Neither is clearly better against the vanes.
- **U0 refit** (`u0_fit.py` logic, ΔNOx = A/√(U²+U0²)):

  | Wind source | Background | U0, all-hours fit | U0, median-bin fit |
  |---|---|---|---|
  | IFS | Mirogojska | 1.38 m/s | 1.65 m/s |
  | IFS | ZAGREB-4 | 1.31 m/s (r = 0.25) | 1.34 m/s |
  | ERA5 | Mirogojska | 2.53 m/s | 2.68 m/s |
  | ERA5 | ZAGREB-4 | 1.74 m/s (r = 0.22) | 1.56 m/s |

- Forecast API (`api.open-meteo.com/v1/forecast`), tested today:

  | `models=` | Grid cell | BLH returned? |
  |---|---|---|
  | `ecmwf_ifs` | 45.79965, 15.924171 (same as the archive) | yes |
  | `best_match` | 45.8, 15.98 | yes |
  | `ecmwf_ifs025` | – | no |
  | `icon_d2` | – | no |
  | `icon_eu` | – | no |

  All returned `Access-Control-Allow-Origin: *`.

**Consequence:** calibrate and forecast with the same model, `ecmwf_ifs`. The U0 prior stays at 1.4 m/s, but only for IFS.

### 1.2 Background station choice (physics §7.9, §8.3, §10, §11.4 against site-context §9.2)

Tests: 2025 validated data in `physics/iszz/`, ISZZ `/frm/gg` triples, live export calls, and `/podatak/data` coverage.

- **Classification.** Mirogojska (280) is "Gradska / Pozadinska" (urban background) in the special-purpose city network, at 169 m a.s.l., 3.5 km N, with no EoI code. ZAGREB-4 (303) is "Prigradska / Pozadinska" (suburban background), EoI HR0041A, 114 m a.s.l., 4.4 km SW, reclassified from 29.12.2022.
- **Weekday mean NOx by local hour start, 2025:**

  | Hour | 03 | 07 | 08 | 09 | 14 | 18 | 22 |
  |---|---|---|---|---|---|---|---|
  | ZAGREB-1 | 36 | 135 | 125 | 100 | 67 | 97 | 85 |
  | Mirogojska | 11 | **76** | **85** | **78** | 39 | 40 | 27 |
  | ZAGREB-4 | 16 | 39 | 42 | 36 | 16 | 27 | 38 |

  Mirogojska carries its own morning traffic peak.
- **Live availability.**
  - Mirogojska offers NOx (38) only as types 1 and 5 (validated), so there is no raw NOx. The export for 26–27.09.2026 returned 0 rows.
  - ZAGREB-4 returned 45 raw NOx rows up to 19:00Z today.
  - 2026 raw coverage: ZAGREB-4 NOx 99.2 %, O3 98.2 %; Mirogojska NO2 87.2 %.
- **CAMS correlation with each background** (physics output): NO2 0.632 (ZAGREB-4) vs 0.560 (Mirogojska); O3 0.839 vs 0.777; PM10 0.612 vs 0.469.
- **Chemistry re-run with ZAGREB-4 background** (`critic/chemistry_test_z4.py`, output in `critic/chemistry_test_z4_output.txt`):

  | Scheme | Mean (obs 31.8) | RMSE | r | FB |
  |---|---|---|---|---|
  | **Riccati, f = 0.10, τ = 60 s** | 31.5 | **5.0** | 0.966 | −0.011 |
  | Riccati, f = 0.15, τ = 60 s | 33.3 | 5.8 | 0.964 | +0.044 |
  | Riccati, f = 0.20, τ = 60 s | 35.0 | 8.0 | 0.955 | +0.095 |
  | PSS, f = 0.10 | 38.0 | 9.3 | 0.945 | +0.177 |
  | Derwent–Middleton | 33.7 | 9.1 | 0.898 | +0.057 |

  With Mirogojska as background, the best case was RMSE 7.8.

**Consequence:** ZAGREB-4 is the default background for NOx, NO2, O3, PM10 and PM2.5. Mirogojska stays as a selectable alternative for NO2, O3 and PM10 only, and is excluded from the live NOx increment.

### 1.3 Effective emission time profile (physics §7.7)

Test: the median of ΔNOx·U_eff by local hour start, with ZAGREB-4 background and IFS wind (output `critic/effective_emission_profile_z4_ifs_2025.csv`).

| Local hour start | 00 | 03 | 05 | 06 | 07 | 08 | 09 | 12 | 15 | 17 | 19 | 21 | 23 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Weekday (corrected) | 0.26 | 0.19 | 1.03 | 1.65 | **1.70** | 1.53 | 1.17 | 1.14 | 1.51 | 1.40 | 1.23 | 0.83 | 0.47 |
| Physics table (Mirogojska background) | 0.64 | 0.43 | 1.54 | **2.10** | 1.28 | 0.85 | 0.52 | 0.76 | 1.23 | 1.47 | 1.56 | 1.14 | 0.86 |

Day-type means relative to weekday: Saturday 0.65, Sunday 0.52.

The time handling in `profile_baseline.py` was correct: `tz_convert("Europe/Zagreb") − 30 min`. The distortion comes from the background station, not from a timezone bug.

**Consequence:** use the corrected profile as the data-derived fallback. The physics statistical baseline (§10.5) was trained with Mirogojska and must be recomputed with ZAGREB-4 (§3, gap G11).

### 1.4 PM, CO and benzene ratios to NOx (physics §7.6, F7)

Test: through-origin regression on hours with ΔNOx > 40 µg/m³, 2025.

| Background | ΔPM10/ΔNOx | ΔPM2.5/ΔNOx | Mean ΔPM10 | Mean ΔPM2.5 | Mean ΔNOx |
|---|---|---|---|---|---|
| ZAGREB-4 | **0.070** | 0.065 | +1.3 | +2.6 | +46.1 |
| Mirogojska (PM2.5 taken from ZAGREB-4) | 0.186 | 0.046 | +8.3 | +2.6 | +36.3 |

- With ZAGREB-4, ΔPM2.5/ΔNOx comes out higher than ΔPM10/ΔNOx, which is physically inconsistent. This shows the PM increment is dominated by background noise.
- The CO (0.98) and benzene (0.0071) ratios use a daily-P5 background and are not affected.

**Consequence:** use bottom-up PM emission factors, which give PM10/NOx ≈ 0.09 and PM2.5/NOx ≈ 0.064. That falls within the measured range of 0.07–0.19, and the PM2.5 ratio matches the ZAGREB-4 result (§4.6). The UI should describe PM as "mostly background, small local increment".

### 1.5 Station wind direction dead band (iszz-api §10, gotcha 21; site-context §7.3; physics F5, §10.6)

Tests: `/podatak/rawd` for stations 303 and 156, parameters 477/478, 2025 and 2026 (no rate limit, CORS `*`), plus `zagreb1_hourly.csv`.

| Station | Direction range | Years checked | Missing 16-point sectors (2025) |
|---|---|---|---|
| ZAGREB-1 | 16.3°–282.4° | 2024, 2025, 2026 | WNW, NW, NNW, N |
| ZAGREB-4 | 25.9°–326.7° (2025); 30.0°–333.2° (2026) | 2025, 2026 | NNW, N, NNE |
| ZAGREB-2 | 11.1°–351.9° | 2025 | N = 0.1 % only |

Share of hours reported from the opposite half-circle, by ERA5 sector at U > 3 m/s:

| ERA5 sector | ZAGREB-4 | ZAGREB-2 | ZAGREB-1 |
|---|---|---|---|
| N | 47 % | 29 % | 28 % |
| NE | 14 % | 8 % | 5 % |
| SW | 2 % | 1 % | 2 % |

**Consequence:**

- Treat all DHMZ AQ-station vanes as unreliable for N-sector flows.
- Validate the modelled near-station wind **only for 45°–270°** (NE through W).
- Remove the claim "the dead band shows channelling along Vukovarska" from the docs, or mark it unproven.
- Station wind is shown in the UI as measured, but it never drives the model.

### 1.6 Sampling inlet height, kerb distance and position (iszz-api §1; site-context §1.1, §10.3–10.4; physics §5.9)

**EEA `PanEuropean_metadata.csv`**, rows for HR0007A:

| Sampling points | Period | InletHeight | BuildingDistance | KerbDistance |
|---|---|---|---|---|
| Automatic analysers (SPO_401/402/403/405/648) | 2003-02-11 – 2022-12-29 | 4 | 0 | 9 |
| SPO_1075, automatic PM10 | from 2023-01-01 | 4 | 0 | 9 |
| Manual samplers (SPO_649, 686, 692–696, 713, 984) | – | 0 | 30 | 5 |

Other checks:

- **Action Plan 2015** (`lit/zg_akcijski_plan.txt`, line 298): "Zagreb-1 45º 48´ 18,1´´ N 15º 58´ 27,2´´ E, 3 m, Na krovu kontejnera" ("on the container roof"). That latitude is **504 m north** of the real site, a typo for 01.8″. The 3 m is the 2012 inlet height.
- **City orthophoto 2022 at 0.1 m** (`critic/zg_orto2022_80m_marked.jpg`, EPSG:3765, centred on the DHMZ point):
  - The footway/cycle strip is at +6.5 to +9 m, the **west kerb at +12 m**, and the southbound carriageway runs +12 to +25.5 m (4 lanes).
  - A median follows, then the northbound carriageway (+26.5 to +34 m).
  - EEA's 9 m is consistent if the inlet sits at the east end of the container.
  - The Esri z19 tile had suggested 14–16 m, but is too coarse to place the kerb.
- **Positions** in the EPSG:3765 offset frame (pyproj): DHMZ (0, 0); OSM container centroid (+0.2, +0.5 S); ISZZ (+4.5, +0.5 S); EEA (−11.6, +17.4 S) m. The ZG3D nDSM has no building cell within 39.9 m of the origin, so the container is not in ZG3D.
- **Tree.** A large crown (about 18 m diameter) is centred about 5 m W and 10 m N of the inlet. The Meta CHM reads only 7.6 m there, which is probably an under-estimate.

**Consequence:** the receptor goes at (0, 0) in the DHMZ frame, z_r = **4.0 m**. The representativeness band (±1 cell) covers the 4.5 m ISZZ offset. Put the Miramarska southbound source band at x = +12 to +25.5 m, not at the OSM line ±6.5 m.

### 1.7 Ozone and UV at ZAGREB-1 (site-context §0, §1.1 against iszz-api §1, §6.3)

Test: `dhmz_zagreb1.html` parsed.

- The "Mjerenja na postaji Zagreb 1" block lists "ozon" and "uv zracenje - direktno" as plain text only. There is no `id_komp` link for either, and the block says "Zadnja izmjena: 14.08.2017".
- The linked components are 256, 257, 258, 259, 263, 264, 270, 292, 293, 294, 302, 319, 352, 353, 355 and 359. No O3.
- ISZZ `/frm/gg` offers no pollutant 31 for station 155.

**Consequence:** O3 is **not measured** at ZAGREB-1. `iszz-api.md` is right. Take O3 from ZAGREB-4.

### 1.8 Station address (site-context §1.1)

Confirmed in `zg_akcijski_plan.txt`, lines 259–261:

- "ZAGREB-1, raskrižje Ulice grada Vukovara i Miramarske ceste"
- "ZAGREB-3, raskrižje Sarajevske ulice i Kauzlarićeva prilaza"

ISZZ puts ZAGREB-3 at 45.764947 N, 16.006469 E, 4.7 km SSE, in Novi Zagreb. The DHMZ page text (edited 2017) carries ZAGREB-3's address. Coordinates from DHMZ, ISZZ and OSM agree within 4.5 m.

### 1.9 OSM levels to height (lidar-3d 4.79 m/level; site-context 3.2·L + 1.5; reference 3.1·L + 1.5)

Test: 302 OSM ways with `building:levels`, no `height` tag, ZG3D roof cover ≥ 0.8 (`lidar/osm_footprint_heights_from_zg3d_ndsm.json`).

| Target height | Least-squares fit | MAE | Median H/levels |
|---|---|---|---|
| p90 (roof top) | H = 3.03·L + 5.81 | 3.1 m | 4.89 |
| Median (LoD1 mean) | H = 2.51·L + 6.11 | 3.3 m | 4.40 |

- `3.1·L + 1.5` under-estimates by 4.0 m median (MAE 4.5).
- `3.2·L + 1.5` under-estimates by 3.7 m.
- `4.0·L + 2.0` has a bias of +0.6 m (MAE 3.4).

"4.8 m per level" is a ratio, so it over-predicts tall buildings.

**Consequence:** the fallback is **H = 3.0·levels + 5.5 m**, used only where ZG3D is missing.

### 1.10 Urban morphometry from ZG3D (physics §6.1, site-context §9.2)

Test: `lidar/zg3d_ndsm_1m.tif` (EPSG:3765, 1 m, buildings ≥ 2 m). Frontal area comes from positive height steps along the wind axis after rotation; the rotation sense was checked on synthetic walls. Macdonald constants: A = 4.43, β = 1.0, C_D = 1.2, κ = 0.4.

| Area | λp | H̄ (area-weighted) | σH | λf (mean) | d | z0 |
|---|---|---|---|---|---|---|
| Disc r = 300 m | 0.267 | 16.3 m | 11.6 | 0.218 | 8.3 m | 1.66 m |
| **Disc r = 500 m** | **0.246** | **14.2 m** | 12.4 | **0.193** (0.159–0.211) | **6.8 m** | **1.47 m** |

Upwind 90° wedge, r ≤ 600 m, by wind-from direction:

| From | N | NE | E | SE | S | SW | W | NW |
|---|---|---|---|---|---|---|---|---|
| λp | 0.22 | 0.22 | 0.18 | 0.24 | 0.31 | 0.28 | 0.29 | 0.26 |
| H̄ (m) | 12.8 | 14.3 | 13.0 | 12.5 | 14.0 | 15.8 | 14.7 | 12.1 |
| λf | 0.17 | 0.19 | 0.11 | 0.18 | 0.21 | 0.26 | 0.20 | 0.24 |
| d (m) | 5.6 | 6.2 | 4.9 | 5.8 | 7.8 | 8.3 | 7.9 | 6.1 |
| z0 (m) | 1.35 | 1.70 | 1.07 | 1.28 | 1.13 | 1.73 | 1.26 | 1.34 |

The raster approach slightly inflates λf for diagonal directions. The upwind E wedge is the smoothest, which matches the parks and Lisinski square.

### 1.11 Coordinate frames (lidar-3d §5; site-context header; reference `extract_env.py`)

Test: pyproj EPSG:4326 → 3765 against the reference equirectangular xz(). Differences at the box edge, in metres:

| Equirectangular point | TM − equirectangular |
|---|---|
| (+750, 0) | (+1.2, +4.9) |
| (0, −750) | (+5.0, −4.1) |
| (+750, −750) | (+6.1, +0.9) |

Also:

- The origin conversion in `lidar-3d.md` is correct: DHMZ = E 459129.32, N 5073538.23.
- `site-context.md` uses KX = 77 629 m/°; the reference formula gives 77 608.

**Consequence:** use a single frame (§4.2). Never mix OSM equirectangular data with ZG3D EPSG:3765 offsets.

### 1.12 Emission magnitude sanity check (site-context §9.3 "10–20 µg/m³"; physics §2.4 "≈ 44 µg/m³")

Test: `critic/gauss_sanity.py` (output `gauss_sanity_output.txt`).

- **Sources:** 13,417 point sources on 57.6 km of OSM roads within 800 m. AADT from `site-context.md` §3.2/3.3, one-way carriageways at 50 %, hourly profile from §3.4, day factors normalised.
- **Emission factor:** EF_NOx 0.50 g/km.
- **Dispersion:** Briggs urban σ with IFS-based P-G class; σy0 = 3 m, σz0 = 2 m; source at 0.5 m, receptor at 4 m; U_eff = √(U²+1.4²) with IFS U10.

Results:

- 8,059 hours. Mean modelled ΔNOx 11.0 µg/m³ against 46.0 observed (ZAGREB-1 minus ZAGREB-4). **obs/mod = 4.2**, hourly r = 0.22.
- Normalised weekday diurnal cycle:

  | | 03 h | 07 h | 17 h | 22 h |
  |---|---|---|---|---|
  | Modelled | 0.11 | 1.29 | 1.99 | 0.64 |
  | Observed | 0.38 | 1.85 | 1.27 | 0.88 |

  The model is too high in the late afternoon (convective dilution is under-represented at the receptor) and too low at night.

**Consequence:** show β in the UI ("raw physics" against "calibrated"). The night deficit points to the stable-lid or U0 treatment and to evening domestic-heating NOx. It is not only a traffic-volume problem.

### 1.13 Numbers in `physics.md` recomputed by hand (all reproduce)

- Δt = 0.125 s and ν = 0.4 m²/s at Δx = 5 m, U = 3 m/s. Re_H ≈ 150.
- Golder L at z0′ = 0.5 m (m): A −9.6, B −22, C −135, E 106, F 22.
- u*^ = 0.162 for the neutral example. Inlet Mach 0.26 at 190 m.
- AERMOD urban mixing height 315 m for P = 7.7×10⁵. J(800 W/m²) = 8.7×10⁻³ s⁻¹ (9.1×10⁻³ with α).
- k(NO+O3) = 4.19×10⁻⁴ ppb⁻¹ s⁻¹ at 15 °C.
- ppb factors: NO2 1.9125, O3 1.995, NO 1.247 µg/m³ per ppb.
- Line-source example: q = 4.17×10⁻⁴ g m⁻¹ s⁻¹ gives ΔC = 44 µg/m³ (this is a worst-case hour; see §1.12).

### 1.14 AAQD 2024/2881 thresholds (iszz-api §9.2)

Checked in `thresholds/aaqd_2024_2881.txt`, Annex I Section 4. All match `iszz-api.md`.

| Pollutant | Alert | Information |
|---|---|---|
| SO2 (1 h) | 350 | 275 |
| NO2 (1 h) | 200 | 150 |
| PM2.5 (1 day) | 50 | 50 |
| PM10 (1 day) | 90 | 90 |
| O3 (1 h) | 240 | 180 |

### 1.15 Traffic figures (site-context §0, §3.2)

All confirmed in the saved texts:

- FPZ 2017, Tablica 2 (`lit/fpz_gredelj_prometna_studija.txt`, lines 1966–1988): Miramarska–Vukovarska 5471 / 5958 PCU/h, degree of saturation 1.12 / 1.27. Savska–Vukovarska 4937 / 5266. HBZ–Vukovarska 7082 / 7437.
- Pejić et al. 2018 (`lit/mvm_2018_44_4.txt`, line 623): "Miramarska Street 1596 37 0.58".
- Action Plan (`lit/zg_akcijski_plan.txt`, lines 1066–1072):
  - Slavonska avenija 39 243 veh/day and Jadranska avenija 22 286 veh/day (February 2014).
  - More than 60 000 veh/day through the Savska–Vukovarska intersection (April 2009).
  - "Na prometnicama uz koje su smještene mjerne postaje ... nije bilo mjerenja prometa" ("no traffic was measured on the roads where the monitoring stations are").

The city open-data portal (`data.zagreb.hr` CKAN) returned **0 results** for "brojač", "brojanje", "opterećenje", "PGDP", "semafor" and "biciklist". Its "promet" hits are closures, bus stops and similar. **There are no public traffic counts.**

### 1.16 Endpoint re-tests (today)

| Endpoint | Result |
|---|---|
| ISZZ `/rs/podatak/export/json` (155, NO2, t0, 26–27.09.2026) | 200. 45 rows, 26.09 01:00 → 27.09 21:00 CEST. `Access-Control-Allow-Origin: *` |
| ISZZ `/rs/podatak/rawd` | 200, CORS `*`, no rate limit hit. Column 4 has 3 decimals even for raw data. Column 9 is exactly column 4 ÷ 2 in the samples; meaning unknown, ignore it |
| ISZZ `/rs/eaqi/indeks?h=0` | 200, CORS `*` |
| ISZZ `/rs/podatak/data` (coverage) | 200. Used for the 2026 coverage figures in §1.2 |
| ZG3D FeatureServer `returnCountOnly` (1.5 km box) | `{"count":4333}` (unchanged). CORS `*` |
| DGU `RH_ELEV_107.tif` Range 0–15 | 206, `content-range: bytes 0-15/34428828`, little-endian TIFF |
| Open-Meteo archive / forecast / CAMS air quality | 200, CORS `*` (models as in §1.1) |
| Open-Meteo terms (https://open-meteo.com/en/terms) | Free API is non-commercial only; < 10 000 calls/day, 5 000/h, 600/min; CC BY 4.0 attribution |
| DHMZ `https://vrijeme.hr/hrvatska_n.xml` | 200 `text/xml`, **no CORS header**. Zagreb-Grič (45.814 N, 15.972 E; 1.5 km N), Zagreb-Maksimir and Zagreb-aerodrom. Wind as 8-point compass plus m/s, current hour only |
| City orthophoto WMS `geoportal.zagreb.hr/Public/Ortofoto2022_Public/MapServer/WMSServer`, layer `ZG_CDOF2022` | 200, EPSG:3765/4326, **no watermark**, `Fees NONE`, `AccessConstraints NONE`. **No CORS header**, so fetch it at build time |
| data.gov.hr CKAN, "kvaliteta zraka" | The ISZZ INSPIRE entries have **no licence field** (`license_title: None`) |

### 1.17 Reference repo facts (not stated in any report)

- **Licence:** MIT, © 2026 Ivan Rezić. OSM-derived `env.json` is ODbL.
- **Frontend:** a single ES module concatenated in this order: `scene.js, stadium.js, weather.js, wind-tunnel.js, visuals.js, main.js`. three.js **0.170.0** is loaded through an importmap from `cdn.jsdelivr.net`.
- **Build:** `tools/build.py` inlines CSS, `env.json` and a base64 `.bin` into `dist/index.html`. `.github/workflows/pages.yml` publishes on every push to `main`.
- **`env.json` keys:** `forest, water, grass, pitches, roads{c,n,p}, tram, buildings{h,p}, labels{t,x,z,k}, park`. Frame x = east, z = south, from the equirectangular `xz()`. Height fallback is `levels·3.1 + 1.5`.
- **Wind tunnel:** `up = 220, down = 300, width = 560, height = 140` m at dx = 5 m. The inlet is a power law `pow(max(h,2)/10, 0.22)`. Ground is free-slip. Only the stadium models are voxelised.
- **UI:** preset buttons, sliders for wind and rain, a sweep of 8 directions with a per-direction table, rain/wind mode buttons, camera buttons, an x-ray roofs checkbox, and a slice checkbox with a height slider.

---

## 2. Contradictions between reports, and how they are resolved

| # | Topic | lidar-3d | iszz-api | site-context | physics | **Resolution** |
|---|---|---|---|---|---|---|
| X1 | Meteorological forcing | – | – | ERA5 0.25° (true ERA5) | "ERA5", actually IFS 9 km | `models=ecmwf_ifs` for archive and forecast (§1.1) |
| X2 | Calm fraction / wind rose | – | – | 15 % < 1 m/s; NNE–NE and SW | 31 % < 1 m/s | Different models; use IFS numbers, relabelled |
| X3 | Background | – | O3 from ZAGREB-3 or ZAGREB-4 | ZAGREB-4 for everything | Mirogojska for NOx/NO2/O3; mean of Mirogojska and ZAGREB-4 for PM10 | **ZAGREB-4 for everything** (§1.2) |
| X4 | Primary f_NO2 | – | – | 0.25 | 0.10 | **0.10** (§1.2) |
| X5 | Inlet height | – | 4 m (EEA) | 3 m (2012) | 3.5 m (directive range) | **4 m** |
| X6 | Kerb distance | – | 9 m (EEA) | 15–18 m (OSM) | "22 m west of carriageway" (to the OSM line) | **9–12 m**; carriageway band +12…+25.5 m (§1.6) |
| X7 | O3 at ZAGREB-1 | – | not measured | "O3 (per DHMZ)" | – | **Not measured** (§1.7) |
| X8 | Station wind artefact | – | dead band; "street channelling" | channelling plus sheltering; vane "cannot be ruled out" | sheltered or channelled | **Probably processing artefact**; validate only 45°–270° (§1.5) |
| X9 | Levels to height | 4.79 m/level; also `3.5·L + 1.5` | – | `3.2·L + 1.5`; 14.3 m default | 10 m defaults | ZG3D primary; fallback `3.0·L + 5.5` (§1.9) |
| X10 | z0, d, H̄ | – | – | z0 1.0–1.5, d 7, H 15 | z0 1.4, d 8, H 14 (OSM) | **z0 1.5, d 7, H̄ 14** from ZG3D (§1.10) |
| X11 | EF_NOx | – | – | 0.35 g/km | 0.50 g/km | **0.50** prior; β fitted |
| X12 | PM10 EF | – | – | 0.010 exhaust + 0.030 non-exhaust | 0.19 × NOx ≈ 0.095 | Bottom-up **0.046** + resuspension toggle (§1.4, §4.6) |
| X13 | Time profile | – | NO2 peak 07–08 h | traffic profile, peaks 08–09 and 17–18 (hour-ending) | effective profile, 06 h peak | Site-context traffic profile for p_h; corrected effective profile as check (§1.3) |
| X14 | Domain | 1.5 km box downloaded | – | 1.2 km, ≥ 150 m, 2 m refine | 600×600×160 m at 5 m | **600×600×160 m at 5 m** tunnel per direction; 1.5 km for display; 2 m is future work |
| X15 | Station position | DHMZ point "on open ground next to Vukovarska" | ISZZ ±18 m spread (EEA) | OSM container centroid | ISZZ coordinates | **Origin = DHMZ point**; receptor = origin (OSM centroid 0.5 m away) |
| X16 | Frame constant | EPSG:3765 offsets | – | KX 77 629 | – | **One frame**, reference formula (§4.2) |
| X17 | Station anemometer use | – | "don't use as inflow" | validation target (channelling) | validation, "N/NW 22 % and 14 % in ERA5" (IFS) | Inflow never; validation only 45°–270° |

---

## 3. Remaining gaps (not resolvable from here)

| ID | Gap | Why it matters | Suggested action |
|---|---|---|---|
| G1 | **No traffic counts** for Vukovarska, Miramarska or Trg S. Radića. The City's traffic control centre and the FPZ VISSIM model are not public. The Vujić et al. 2025 counts (MDPI) returned 403 here | AADT carries about ±25–40 % uncertainty; β absorbs it | Ask Grad Zagreb (Gradski ured za mobilnost / Centar za nadzor prometa). Retry the MDPI PDF from another network. Keep AADT as UI sliders |
| G2 | DGU LiDAR (LAS/DMP/DMR) needs the request form. The publication clause is ambiguous | "LiDAR" is what the user asked for | Email `izdavanje.podataka@dgu.hr` for sheets 2-491-105-9, 2-492-105-9, 2-516-105-9, 2-517-105-9, 2-541-105-9, 2-542-105-9. Keep the raw data out of git. Document ZG3D as "LiDAR-updated 3D city model (22 % of parts from the 2022 LiDAR survey)" |
| G3 | **Anemometer height and the vane processing** (averaging method, offset) are unknown | Comparison height; confirming the §1.5 artefact | Ask DHMZ through the contact on meteo.hr (no address was verified here). Sample model wind at 4 m and 10 m until then |
| G4 | **ISZZ data licence**: none is stated on the portal or data.gov.hr | Can the repo bundle a data snapshot? | Cache only small derived files (calibration JSON, a compact 2024–present hourly array), attributed. Fetch live data in the browser (CORS works). Ask MZOZT for written confirmation |
| G5 | Licence of the city orthophoto 2022 WMS is not stated (only "Fees/AccessConstraints NONE") | Ground texture | Default ground = OSM landuse polygons, as in the reference. Orthophoto texture is an optional local build flag until clarified |
| G6 | **No GPU in CI**: the WebGL LBM cannot run in GitHub Actions (no node, no headless browser) | Calibration needs the Γ receptor LUT | v1: the app has an "Export LUT" button; the maintainer runs a 16-direction × 3-class sweep once and commits `data/lut_receptor.json`; `tools/calibrate.py` consumes it. v2 (optional): a numpy D3Q19 port at 10 m in `tools/precompute.py` |
| G7 | β for the LBM path is unknown until built. The Gaussian path needs ≈ 4.2 | Honest "raw vs calibrated" | Fit after G6. Report on held-out months |
| G8 | Tree heights next to the inlet: Meta CHM says 7.6 m, but the crown is about 18 m wide | Porous drag at the receptor | Default the station tree to 14 m. Add a tree-height slider. Confirm with DGU LiDAR classes 3–5 (G2) or a site photo |
| G9 | OSPM constants (α, λ, b, S_v, h0) quoted from memory (physics §13.1) | CPU fallback only | Check against Berkowicz 2000 before release |
| G10 | Validated 2025 series might still be revised | Calibration reproducibility | Re-fetch before publishing metrics. Store fetch date in `calibration.json` |
| G11 | The physics baseline (§10.5), sector factors and increment rose used Mirogojska | "How good is it?" panel | Recompute with ZAGREB-4 and IFS in `tools/calibrate.py` |
| G12 | Ground BC: the reference uses free-slip; physics adds a log/canopy inflow but does not decide the ground | Near-ground speed, and therefore Γ | v1: keep free-slip with resolved-building drag (the profile decays via buildings). Document it and test sensitivity with a no-slip variant |
| G13 | 5 m grid against a 12 m kerb distance (2.4 cells) | Receptor gradient | Show the representativeness band. v2: nested 2.5 m inner box (300×300×60 m) |
| G14 | Domestic heating inventory is from 2010; heating shares have no year | Winter PM2.5/BaP and evening NOx | Keep as a toggle with an order-of-magnitude rate. Flag it as low confidence |
| G15 | UI language: the reference is Croatian; the user writes in English | Audience | Use one i18n table with hr and en; default hr, with an EN toggle; docs in English |

---

## 4. Decisions for implementation

### 4.1 Data sources (exact URLs)

**Measurements**

| # | Purpose | URL / template | Auth | CORS | Limits and notes | Licence / attribution |
|---|---|---|---|---|---|---|
| D1 | ZAGREB-1 hourly measurements | `https://iszz.azo.hr/iskzl/rs/podatak/export/json?postaja=155&polutant={1,38,5,28,2,3,32,477,478,475,479}&tipPodatka={0\|1}&vrijemeOd=dd.MM.yyyy&vrijemeDo=dd.MM.yyyy` | none | `*` | ≤ 1000 rows (≤ 41 days hourly); pace ≥ 1.1 s; 429 without Retry-After; −999 in validated series; hour-ending UTC ms | "Izvor: MZOZT – Kvaliteta zraka u RH (iszz.azo.hr); mjerenja DHMZ". Licence unstated (G4) |
| D2 | Background (ZAGREB-4) | Same template, `postaja=303`, `polutant={1,38,31,5,28}` | none | `*` | Raw 2026 coverage 98–99 % | as D1 |
| D3 | Metadata and coverage | `https://iszz.azo.hr/iskzl/rs/podatak/frm/gg?t=false&i=false`, `…/rs/podatak/data?postaja=&polutant=&tipPodatka=&vrijemeOd=&vrijemeDo=` (coverage `extData.pokrivenost`), `…/rs/postaja/koordinate` | none | `*` | Not rate-limited | as D1 |
| D4 | Live EAQI badge | `https://iszz.azo.hr/iskzl/rs/eaqi/indeks?h=0` (filter `id==155`) | none | `*` | Legacy EAQI bands | as D1 |
| D5 | Bulk fallback, tools only | `https://iszz.azo.hr/iskzl/rs/podatak/rawd?postaja=&polutant=&tipPodatka=&vrijemeOd=&vrijemeDo=` | none | `*` | Undocumented; ≤ 1 year per call, one call at a time; window [D1 00:00, D2 00:00] | as D1 |
| D6 | NO, BTEX, PM1 (last 24 h only) | `https://meteo.hr/kvaliteta_zraka.php?section=podaci_kz&post=Zagreb%201&id_komp=<319\|292\|293\|294\|302>` | none | – (HTML) | Hourly poll at most, tools only | © DHMZ |

**Meteorology and background forecast**

| # | Purpose | URL / template | Auth | CORS | Limits and notes | Licence / attribution |
|---|---|---|---|---|---|---|
| D7 | Calibration meteorology | `https://archive-api.open-meteo.com/v1/archive?latitude=45.8005&longitude=15.9742&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&hourly=wind_speed_10m,wind_direction_10m,boundary_layer_height,temperature_2m,cloud_cover,shortwave_radiation&wind_speed_unit=ms&timezone=GMT&models=ecmwf_ifs` | none | `*` | Instantaneous values: average t−1 and t (vector-average the wind) | Open-Meteo CC BY 4.0; non-commercial free tier |
| D8 | Live and forecast meteorology | `https://api.open-meteo.com/v1/forecast?latitude=45.8005&longitude=15.9742&hourly=wind_speed_10m,wind_direction_10m,boundary_layer_height,temperature_2m,cloud_cover,shortwave_radiation&wind_speed_unit=ms&timezone=GMT&past_days=2&forecast_days=3&models=ecmwf_ifs` | none | `*` | < 10k calls/day | as D7 |
| D9 | Background forecast | `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=45.8005&longitude=15.9742&hourly=nitrogen_dioxide,ozone,pm10,pm2_5&domains=cams_europe&past_days=14&forecast_days=3&timezone=GMT` | none | `*` | Bias-correct with the 14-day ratio to ZAGREB-4. 2025 ratios: NO2 1.77, O3 0.86, PM10 1.20, PM2.5 0.85 | Copernicus CAMS + Open-Meteo |
| D10 | Optional synoptic snapshot (tools/Action only) | `https://vrijeme.hr/hrvatska_n.xml` (Zagreb-Grič, Zagreb-Maksimir) | none | **none** | Current hour, 8-point direction | © DHMZ |

**Geometry**

| # | Purpose | URL / template | Auth | CORS | Limits and notes | Licence / attribution |
|---|---|---|---|---|---|---|
| D11 | Buildings, LoD1 and LoD2 | `https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/ZG3D_2022_3d_model_GZ/FeatureServer/0/query?where=1%3D1&geometry=<xmin,ymin,xmax,ymax>&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&returnZ=true&multipatchOption=embedMaterials&orderByFields=OBJECTID&resultRecordCount=500&resultOffset=N&f=json` (`xyFootprint` + `f=geojson` for 2D) | none | `*` | maxRecordCount 2000; 3D decode per `research/fetch_zg3d_lod2.py`. **Fetch in lon/lat (`outSR=4326`)** so the reference frame works (§4.2) | "© Grad Zagreb – ZG3D 2022", Otvorena dozvola (lidar-3d §7) |
| D12 | Buildings fallback F1 | data.zagreb.hr district zips via `https://data.zagreb.hr/api/3/action/package_search?q=zg3d` (Trnje, Donji grad, Trešnjevka sjever) | none | – | SHP type 31, lon/lat Z | as D11 |
| D13 | Terrain | `https://geoportal.dgu.hr/services/atom/RH_ELEV_107.tif` (EPSG:3045, float64, 1-row strips, HTTP Range) | none | – | 107–122 m over the box. Used for base heights only; the LBM ground is flat | DGU, Otvorena dozvola |
| D14 | Roads, trams, landuse, trees, names | `https://overpass-api.de/api/interpreter` (send a User-Agent, else 406), queries `research/data/q_*.txt` | none | – | – | © OpenStreetMap contributors, ODbL |
| D15 | Trees, optional | `https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/120230330.tif` (window read only; mask with ZG3D) | none | – | Under-reads the station tree (G8) | Meta/WRI, CC BY 4.0 |
| D16 | Ground texture, optional | `https://geoportal.zagreb.hr/Public/Ortofoto2022_Public/MapServer/WMSServer?service=WMS&version=1.3.0&request=GetMap&layers=ZG_CDOF2022&styles=&crs=EPSG:3765&bbox=…&width=…&height=…&format=image/jpeg` | none | none | Build-time only, licence unclear (G5) | © Grad Zagreb |
| D17 | Private LiDAR | DGU request form (`dgu_zahtjev_lidar.pdf`), `izdavanje.podataka@dgu.hr` | form | – | Never commit | DGU LiDAR licence |

**Not used:** Mirogojska as a default background (§1.2), ERA5 for calibration (§1.1), the ZAGREB-1 vane as inflow (§1.5), Overture/Microsoft/Google/GHSL/UA (lidar-3d §2), EEA E2a (a cross-check only).

### 4.2 Frame and site constants

- **Origin:** DHMZ point, 45.800496 N, 15.97422 E (HTRS96/TM E 459129.318, N 5073538.234). Ground 115.6 m HVRS71 (DGU DTM).
- **Frame:** the reference's local frame for **every** layer: `x = (lon − 15.97422)·KX`, `z = −(lat − 45.800496)·110540`, with `KX = 111320·cos(45.800496°) = 77 607.7`. Heights are metres above local ground.
  - ZG3D is requested with `outSR=4326` and pushed through the same `xz()`.
  - Equivalent option: request EPSG:3765 and convert to lon/lat with pyproj before `xz()`.
  - True north is −z, so meteorological directions apply without a convergence correction.
- **Receptor (inlet):** (0, 0), z = 4.0 m. The ±1-cell band gives the representativeness range.
- **Mast probes:** (0, 0) at 4 m and 10 m. The anemometer height is unknown (G3).
- **Container:** excluded from the mask.
- **Scene extent:** 1.5 km × 1.5 km (±750 m) for display. The LBM tunnel is rotated per wind direction (§4.4).

### 4.3 Geometry pipeline (Python tools, reference style)

1. `tools/fetch_zg3d.py` (stdlib).
   - Page by 500 with `embedMaterials` and decode `binaryPatches`.
   - Per part: `h = Z_Max − DTM(centroid)`, `b = max(0, Z_Min − DTM)` (set b = 0 when b < 1 m); drop parts with h < 1 m.
   - Keep `s = Godina_izv` (source year).
   - Output `env.buildings = [{h, b, p, s}]`, with footprint `p` simplified by RDP at 0.6 m.
   - Optional LoD2 display mesh within 500 m (about 131k triangles, 2.4 MB int16) in `src/lod2.bin`.
2. `tools/fetch_osm.py`: the reference Overpass queries plus `lanes`, `oneway`, `highway`, `name`, `maxspeed`, and trees and parks.
   - Road `c` class codes as in the reference, plus `l` (lanes) and `o` (oneway).
   - Tram as its own list.
   - Buildings that ZG3D lacks (cover < 0.5) use `3.0·levels + 5.5`.
3. `tools/fetch_dtm.py`: a Range reader for RH_ELEV_107 (stdlib, no rasterio).
4. `tools/build_env.py`:
   - Writes `src/env.json`: the reference keys plus `buildings[].b/s` and `trees[] = {x, z, h, r}`.
   - The station tree is 14 m tall with a 9 m radius. OSM trees default to h 12 m, r 4 m. The CHM is optional.
   - Adds `sources` (§4.6) and `meta` (attribution strings, fetch dates).
   - **Carriageway override:** Miramarska southbound band at x ∈ [+12, +25.5] m within ±40 m of the station. That is the extent checked in the 0.1 m orthophoto. Beyond it, use the OSM centreline ± lanes × 3.25 m / 2, after a visual check against D16.
5. **Browser voxeliser (new code):**
   - Per tunnel frame, scan-convert each footprint, rotated into tunnel coordinates, onto the 5 m (and 10 m) grid.
   - Cell k is solid if `b ≤ z_k ≤ h`. Mark it solid when more than 50 % of the cell area is covered; write fractional cover to the existing porous channel otherwise.
   - Trees become porous cells. Leaf-on (May–October) LAD is 1.2 m²/m³, leaf-off 0.3 m²/m³ (site-context §9.1).
   - The LAD-to-porous-fraction mapping for the reference's porous bounce-back is **not sourced**. Start at 0.15 leaf-on and 0.04 leaf-off, and tune it so the wind reduction behind the crown looks plausible.

### 4.4 Model specification (summary; details in physics.md with the §1 corrections)

- **Flow:**
  - Reference D3Q19 LBM + Smagorinsky (C_s 0.17, τ0 0.506). Coarse 10 m spin-up, then fine 5 m.
  - **Tunnel 600 (along) × 600 (across) × 160 m = 120×120×32 cells**; station 300 m from the inlet.
  - Inlet profile: the log-law and canopy profile from physics §6.3 with z0 = 1.5 m, d = 7 m, H̄ = 14 m, z0r = 0.3 m, z_b = 80 m. **Neutral only in v1.**
  - Ground free-slip (G12). Lateral periodic (flow only). 80 m sponge.
  - 16 directions, run on demand. LRU cache plus IndexedDB (`try/catch`, tolerant of an empty cache).
- **Scalar:**
  - Steady finite volume: first-order upwind + van Leer TVD deferred correction, Jacobi ω = 0.9, γ ramp over 200 sweeps.
  - Open lateral boundaries, zero at inflow. Four source groups in RGBA plus four age tracers (MRT).
  - Groups: **A** Vukovarska + Miramarska (the main links at the station), **B** all other roads, **C** buses/tram corridor (non-exhaust only for tram), **D** domestic heating.
- **Closure:** K̂ = max(K̂_MO, ℓm²|Ŝ|/Sc_t), Sc_t = 0.7, λ = 30 m, K̂_min = 0.02 m. φh per Businger–Dyer. Golder L from the class.
- **Speed scaling:** ΔC = 10⁶ β Σ q_k Γ_k / √(U² + U0²), with U = IFS U10 averaged to the hour.
- **Direction:** Gaussian kernel over the 16 directions, σθ = min(60°, 22.5°·max(1, 2/U)). For U < 0.5 m/s use the frequency-weighted mean.
- **Stability:**
  - Class by SRDT (day) and Turner (night) from IFS U10, G and cloud.
  - Scalar solve per group: A–C, D, E–F.
  - Lid h_eff = max(h_IFS, 100 m); choices {NWP, 100 m, 315 m}.
- **Chemistry:** Riccati finite-time scheme, f_NO2 = 0.10, τ from the age tracer (plausibility ≈ 60 s). J from Trebs 2009 using `shortwave_radiation`. k from JPL with IFS T. O3, NO2 and NOx background from ZAGREB-4.
- **Total concentration:** C = C_bg(ZAGREB-4, or bias-corrected CAMS in forecast mode) + ΔC.
- **CPU fallback:** OSPM-type receptor model plus Gaussian map (physics §9), labelled "approximate (no 3D flow)".

### 4.5 Default parameter values

**Grid and flow**

| Parameter | Default | Range / options | Basis |
|---|---|---|---|
| Δx fine / coarse | 5 m / 10 m | – | reference, physics |
| Tunnel | 120×120×32 (600×600×160 m) | 100×100×20 at 10 m (mobile) … 160×160×32 | physics §5.1 |
| z0 / d / H̄ (inflow) | 1.5 m / 7 m / 14 m | per-sector table §1.10 | ZG3D §1.10 |
| z0r / z_b | 0.3 m / 80 m | 0.1–0.5 / 60–100 m | physics §6.2 |
| κ, Sc_t, λ, K̂_min | 0.40, 0.7, 30 m, 0.02 m | Sc_t 0.3–1.0 (advanced) | physics §4 |
| Scalar solver | ω 0.9, γ ramp 200, max 3000 sweeps | converge at probe Δ < 10⁻³ per 100 sweeps; mass error < 2 % | physics §5.7 |

**Meteorology and calibration**

| Parameter | Default | Range / options | Basis |
|---|---|---|---|
| U0 | 1.4 m/s | 1.0–2.0 (fitted) | IFS + ZAGREB-4 refit 1.31–1.34 (§1.1) |
| β (NOx emission scale) | fitted; Gaussian prior 4.2 | 0.5–8 | §1.12 |
| h_min (lid floor) | 100 m | NWP / 100 / 315 m | physics §6.5 |

**Chemistry and receptor**

| Parameter | Default | Range / options | Basis |
|---|---|---|---|
| f_NO2 | 0.10 | 0.05–0.20 | §1.2 |
| Receptor height | 4.0 m | 1.5–4 m | EEA (§1.6) |

**Wind presets**

| Preset | Direction | U10 |
|---|---|---|
| "Sjeveroistočnjak" (default) | 45° | 1.7 m/s |
| "Sjever" | 0° | 1.7 m/s |
| "Jugozapadnjak" | 225° | 2.0 m/s |
| "Niz Vukovarsku (W→E)" | 266° | 2.0 m/s |
| "Niz Vukovarsku (E→W)" | 86° | 2.0 m/s |
| "Tišina" (calm) | direction-averaged | 0.5 m/s |

IFS mean U10 is 1.73 m/s. The two main modes are N–NE and SW (both reanalyses).

**Stability presets**

| Preset | Class | U10 | Lid h_eff | IFS 2025 frequency |
|---|---|---|---|---|
| Neutral (default) | D | – | NWP | 40 % |
| "Zimska noć" (winter night) | F | 1.0 m/s | 100 m | 26 % |
| "Ljetno poslijepodne" (summer afternoon) | B | 1.3 m/s | 1000 m | 17.5 % |

**Time**

| Parameter | Default | Basis |
|---|---|---|
| Internal clock | UTC, hour-ending | iszz-api §4 |
| Display | Europe/Zagreb, "HH:00 = mean of the preceding hour" | – |

### 4.6 Emissions (defaults, all visible as sliders)

**Traffic volumes**

| Link | AADT (veh/day) |
|---|---|
| Vukovarska W | 47 000 |
| Vukovarska E | 45 000 |
| Miramarska N | 20 000 (southbound 60 % / northbound 40 %) |
| Miramarska S | 12 000 |
| Trg S. Radića | 4 000 |
| HBZ | 50 000 |
| Lučića | 12 000 |
| Savska | 45 000 |
| Slavonska | 40 000 |
| Branimirova | 25 000 |

- Class defaults for unnamed roads: secondary 25 000, tertiary 12 000, unclassified 3 000, residential 1 000, service 150 (site-context §3.3).
- A one-way carriageway gets its share of the link.

**Time factors**

- **Hourly:** the site-context §3.4 weekday table (hour-ending %).
- **Day of week:** Monday–Thursday 1.00, Friday 1.02, Saturday 0.90, Sunday 0.70, normalised to a weekly mean of 1.
- **Month:** January 0.95, February 0.98, March–June 1.02, July 0.93, August 0.85, September–November 1.03, December 1.00.
- **Check target:** the corrected effective profile (§1.3).
- **Congestion ("Jutarnja/popodnevna gužva", LOS F):** EF × 2.5 in cells within 60 m upstream of the Vukovarska and Miramarska stop lines, 07–09 h and 15–18 h on weekdays.

**Fleet-average emission factors per vehicle (2026 prior)**

| Pollutant | Default (g/veh/km) | Range / notes |
|---|---|---|
| NOx | **0.50** | 0.3–0.9 |
| PM10 exhaust | 0.017 | – |
| PM10 non-exhaust (tyre + brake + road) | 0.029 | – |
| **PM10 total** | **0.046** | – |
| PM10 winter resuspension (toggle, AP-42) | +0.056 | – |
| PM2.5 | **0.032** | – |
| CO | **0.49** | ratio 0.98 × NOx |
| Benzene | **0.0036** | ratio 0.0071 × NOx; plus an optional INA Miramarska point source at (+40, −146 z) |

**Scenarios**

- **EV share:** removes exhaust but keeps non-exhaust; BEV brake wear × 0.3.
- **LEZ:** Euro ≤ 2 petrol and ≤ 3 diesel out, giving NOx −40 % and exhaust PM −75 % (Pejić 2018).
- **Electric buses:** zero group C exhaust.
- **Tram:** zero exhaust; the non-exhaust slider defaults to 0.
- **Domestic heating (group D), October–March:**
  - Area source over `landuse=residential` with `house`/`detached` buildings, 150–700 m S/SE.
  - Evening-peak rates PM10 2 µg m⁻² s⁻¹ and NOx 1 µg m⁻² s⁻¹.
  - Peaks 08–10 h and 19–22 h. Marked "order of magnitude" (G14).

### 4.7 Calibration and validation protocol

- **Script:** `tools/calibrate.py` (stdlib; numpy optional).
- **Inputs:**
  - ISZZ 2025 validated data, ZAGREB-1 minus ZAGREB-4 for NOx.
  - IFS archive meteorology.
  - `data/lut_receptor.json` (Γ, A per direction × class × group) exported from the app (G6).
- **Fit:** β and U0 by log least squares with c0 = 10 µg/m³. Train January–June and test July–December, then swap. Also leave-one-month-out. **Publish test metrics only.**
- **Metrics:** FB, NMSE, MG, VG, FAC2, NAD, R (Chang & Hanna 2004; urban criteria from Hanna & Chang 2012). MQI for totals (FAIRMODE parameters in physics §10.4).
- **Baseline:** the hour-of-week × sector / U_eff model, **recomputed with ZAGREB-4** (G11). The physics model must beat it on R, VG and NMSE before claiming skill.
- **Diagnostics:** ratio by 16 sectors, by hour and by stability class. The wind check against the station vane covers **45°–270° only** (§1.5).
- **Output:** `src/calibration.json` = `{beta, U0, h_min, period, fetch_date, metrics_test, baseline_test}`, shown in the "Koliko je točno? / How good is it?" panel.

### 4.8 UI: analogues of the reference's controls

**Presets row** (like the reference's four weather buttons):

- "Jutarnja gužva, zima" (winter morning rush): 07 h Tuesday in January, class F, lid 100 m, NE 1.2 m/s, heating on.
- "Ljetno poslijepodne" (summer afternoon): 15 h in July, class B, SW 2 m/s.
- "Nedjeljna noć" (Sunday night).
- "Sjeveroistočnjak" and "Jugozapadnjak".
- "Sada" (live): ISZZ plus IFS for the current hour.
- "Prognoza +24 h" (forecast).

**Sliders and dials**

- Wind direction dial (16 steps) and wind speed (0–8 m/s).
- Hour of day, day type, month.
- Traffic multiplier (global, plus Vukovarska and Miramarska separately).
- EV share (0–100 %).
- Background (ZAGREB-4 live / CAMS forecast / manual).

**Toggles**

- Stability (auto / A–F), mixing lid (auto / 100 / 315 m).
- Rush-hour queues (congestion × 2.5), LEZ, electric buses, tram non-exhaust.
- Heating season, winter sanding.
- Trees leaf-on / leaf-off / off.
- Raw physics vs calibrated (β).
- Pollutant: NOx / NO2 / PM10 / PM2.5 / CO / benzene.
- Index: EEA 2024 / ISZZ legacy.

**Actions**

- "Izračunaj svih 16 smjerova" (compute all 16 directions; the reference's "Provjeri svih 8 smjerova").
- "Izvezi LUT" (export LUT).
- A `<details>` table per direction.

**Display**

- Concentration slice at a chosen height (3–40 m, default 4 m).
- Particles along roads (display only).
- Iso-surface. Wind slice (the reference's slice). X-ray buildings. LoD2 on/off. "Show source year" colouring (2008 / 2019 / 2022).

**Cameras**

- "Iz zraka" (from the air), "S postaje" (from the station, 1.7 m eye at the inlet looking E), "Niz Vukovarsku" (down Vukovarska), "Tlocrt" (plan view).

**Panels**

- Measured vs modelled 72 h time series (ISZZ raw, dashed validated) with a factor-of-2 band and limit lines.
- Live EAQI badge.
- "Koliko je točno?" (how good is it?).
- Data provenance and attribution.
- Limitations text (physics §10.7).

### 4.9 Repo layout, build and docs

```
README.md                 (hr + en; quick start, how it works, sources, licences)
LICENSE                   (MIT for code; data licences listed in DATA_LICENSES.md)
DATA_LICENSES.md          (ZG3D OD, DGU OD, OSM ODbL, Open-Meteo CC BY 4.0, CAMS, ISZZ attribution, Meta CC BY)
docs/ 00-overview.md  01-data-sources.md  02-geometry.md  03-flow-lbm.md  04-dispersion.md
      05-emissions.md  06-chemistry.md  07-calibration.md  08-ui.md  09-limitations.md  10-runbook.md
      research/ (these five research reports, copied verbatim)
tools/ config.py fetch_iszz.py fetch_meteo.py fetch_zg3d.py fetch_osm.py fetch_dtm.py build_env.py
       calibrate.py build.py   (stdlib first; numpy only in calibrate.py, optional)
       private/ (gitignored: DGU LiDAR)   cache/ (gitignored)
src/  page.html style.css env.json lod2.bin calibration.json lut_receptor.json
      js/ scene.js buildings.js wind-tunnel.js scalar.js emissions.js chemistry.js data.js ui.js visuals.js main.js
tests/ test_iszz_parse.py test_chemistry.py test_emissions.py (saved JSON samples) + in-app T1–T6 (physics §5.10)
.github/workflows/ pages.yml (as reference); refresh-data.yml (weekly: ISZZ snapshot ≤ 60 requests, paced 1.1 s)
```

- **Build:** keep the reference's single-file inline build. three.js is 0.170.0 from jsdelivr via importmap.
- **Target page size:** < 6 MB (env about 1 MB, LoD2 2.4 MB, data arrays < 1 MB).
- **Live data:** fetched from the browser (D1, D2, D4, D8, D9 are all CORS `*`). Serialise requests at 1.1 s with a 429 retry. The committed snapshot is the fallback.

---

## 5. Files produced by this review (`research/data/critic/`)

**Scripts and outputs**

- `gauss_sanity.py`, `gauss_sanity_output.txt`: default-emission magnitude check (§1.12).
- `chemistry_test_z4.py`, `chemistry_test_z4_output.txt`: NO2 chemistry with ZAGREB-4 background (§1.2).
- `effective_emission_profile_z4_ifs_2025.csv`: corrected effective profile (§1.3).

**Downloaded data**

- `om_{best_match,era5,era5_land,ecmwf_ifs,era5_seamless}.json`: Open-Meteo archive 2025 per model (§1.1).
- `om_fc_*.json/.hdr`: forecast API per model, with CORS headers.
- `rawd_303_477_2025.json`, `rawd_303_478_2025.json`, `rawd_303_478_2026.json`, `rawd_156_477_2025.json`, `rawd_156_478_2025.json`: ZAGREB-4 and ZAGREB-2 wind (§1.5).
- `iszz_no2_2627.json`, `live_303_nox.json`, `live_280_nox.json`: live export tests (§1.2, §1.16).
- `hrvatska_n.xml`, `hrvatska1_n.xml`: DHMZ current observations.
- `om_terms.html`, `dgh.json`, `zg_orto_caps.xml`, `orto.hdr`: terms, licence and capabilities checks.

**Imagery**

- `imagery_overlay.png`, `imagery_overlay_zoom.png`: Esri z19 tile with the station coordinates and OSM roads.
- `zg_orto2022_300m.jpg`, `zg_orto2022_80m.jpg`, `zg_orto2022_80m_marked.jpg`: city orthophoto 2022; the marked crop has 10 m ticks from the origin (§1.6).
