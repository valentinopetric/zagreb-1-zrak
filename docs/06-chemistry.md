# 06 · Chemistry: NO–NO₂–O₃, background, limit values and the air-quality index

*First draft by the models owner [models]. Covers `src/js/chemistry.js`, the chemistry parts of `src/js/meteo.js`
(`jNO2`, `kNOO3`) and `src/js/model.js` (background, `concentrations`), their mirror in `tools/aqmodel.py`, and the
chemistry tests. The test results below were recomputed on 2026-09-28 from `data/processed/`.*

Binding decisions: `docs/research/critic.md` §1.2 (ZAGREB-4 is the background; f_NO2 = 0.10; τ ≈ 60 s), §1.7 (O3 is not
measured at ZAGREB-1) and §1.14 (thresholds). The equations are physics.md §8. Thresholds and index bands are
iszz-api.md §9.

---

## 1. Purpose

The dispersion model transports **NOx** (as NO2 mass), an almost inert quantity on the 1–5 minute scale of the domain.
What the limit values and the public care about is **NO2**. At a kerbside site most of the NOx leaves the exhaust as
NO, which becomes NO2 only by reacting with ozone. The chemistry module converts

```
background NOx, NO2, O3 (ZAGREB-4)  +  modelled NOx increment ΔNOx  +  plume age τ  +  J(NO2), k(NO+O3)
      ──►  NO2, NO, O3 at the receptor
```

It runs per receptor and per slice cell in JavaScript, and costs a few multiplications and one exponential.

## 2. Inputs and outputs

`no2Chemistry({noxInc, no2Bg, noxBg, o3Bg, tau, J, k, fNO2}) → {no2, no, o3, nox, ox}`

| Argument | Unit | Where it comes from |
|---|---|---|
| `noxInc` | µg/m³ (as NO2) | `increment()` for NOx (model.js); clipped at 0 |
| `no2Bg`, `noxBg`, `o3Bg` | µg/m³ | ZAGREB-4 measurement (live or archive), or bias-corrected CAMS in forecast mode (data.js). Missing values: §6 |
| `tau` | s | plume age from the age tracer, τ = Σ q A/(U_eff Σ q Γ) (physics Eq. 5.8). `CHEM_TAU_DEFAULT` = 60 s when there is no emission. `Infinity` = photostationary state; ≤ 0 = no reaction |
| `J` | s⁻¹ | `jNO2(sw)` from the IFS hour-mean global radiation (§3) |
| `k` | ppb⁻¹ s⁻¹ | `kNOO3(t2)` from the IFS 2 m temperature (§3) |
| `fNO2` | – | primary NO2/NOx mass fraction of the exhaust, 0.10 (`calibration.json` `f_no2`) |

The outputs are µg/m³: `no2`, `o3`, `no` (as NO mass) and `nox` (as NO2 mass, = background + increment). `ox` is the
oxidant NO2 + O3 in ppb, which the tests check for conservation.

## 3. Equations

**Unit conversion** (`PPB`). µg/m³ per ppb = M / V_m. V_m = R T / p is the molar volume at the EU reporting
conditions for gases (293.15 K, 101.325 kPa; Directive 2008/50/EC Annex VI, kept by AAQD 2024/2881): V_m = 24.055 L/mol.
Molar masses are IUPAC standard values.

| Species | NO2 (and NOx as NO2) | NO | O3 | SO2 | CO | C6H6 |
|---|---|---|---|---|---|---|
| µg/m³ per ppb | 1.9125 | 1.2474 | 1.9953 | 2.6632 | 1.1644 | 3.2472 |

Physics §5.8 prints O3 as 1.9956. The 0.01 % difference comes from rounding the molar mass and is immaterial.
`PPB.toPpb(p, v)` and `PPB.toUg(p, v)` convert.

**Conserved quantities** (physics Eq. 8.1), in ppb. The fresh exhaust is mixed into background air with a primary NO2
fraction f:

```
N  = NOx_bg + ΔNOx                       total NOx (conserved)
X  = O3_bg + NO2_bg + f ΔNOx             oxidant Ox = NO2 + O3 (conserved)
x0 = NO2_bg + f ΔNOx                     NO2 right after mixing
```

**Kinetics.** NO2 + hν → NO + O(³P), O + O2 → O3 (frequency J); NO + O3 → NO2 + O2 (rate k). Written for x = NO2 (physics
Eq. 8.2):

```
dx/dt = k (N − x)(X − x) − J x = k (x − x1)(x − x2)
x1,2  = ½ (N + X + A ∓ Δ),   Δ = √((N + X + A)² − 4 N X),   A = J / k
```

**Exact solution after the plume age τ** (Riccati; physics Eq. 8.3):

```
x(τ) = (x1 − x2 R e^{−kΔτ}) / (1 − R e^{−kΔτ}),      R = (x0 − x1) / (x0 − x2)
```

Properties, all checked by tests (§7):

- τ → ∞ gives the **photostationary state** x1 (Leighton). With J = 0 this is x1 = min(N, X): **titration**. NO2 = Ox
  when ozone is limiting, NO2 = NOx when NOx is limiting.
- τ = 0 gives x0 (background NO2 + primary NO2).
- For τ > 0, |R e^{−kΔτ}| < 1, so the denominator never vanishes. The code guards Δ ≥ 10⁻⁶ ppb and |x0 − x2| > 10⁻¹² and
  clips x to the physical range [0, min(N, X)]. The clip matters only when noisy inputs have NO2_bg > NOx_bg.
- With ΔNOx = 0 the scheme still relaxes the background towards its own photostationary state over τ. Example: night,
  NOx_bg 24, NO2_bg 16.3, O3 54 µg/m³ gives NO2 = 20.0 µg/m³, as the background NO titrates. This is part of the tested
  scheme (critic §1.2), not a separate correction.

**Rate coefficients** (meteo.js):

```
J(NO2) = (1 + α)(B1 G + B2 G²),   B1 = 1.47e-5, B2 = −4.84e-9 W⁻² m⁴ s⁻¹, α = 0.05     (Trebs et al. 2009; physics Eq. 8.4)
k      = 3.0e-12 exp(−1500/T) cm³ molec⁻¹ s⁻¹ × 1e-9 × 7.2429e18 p[hPa]/T              (JPL; physics Eq. 8.5)
```

- G is the IFS `shortwave_radiation`. Open-Meteo gives it as the mean of the preceding hour, which is already
  hour-ending (chapter 01 §3.3).
- α = 0.05 is the UV-A surface albedo term of Trebs et al. The fit is valid below 800 m a.s.l., and the station is at
  116 m.
- J(800 W/m²) = 9.10 × 10⁻³ s⁻¹ (8.66 × 10⁻³ without α, matching critic §1.13).
- k(15 °C, 1013.25 hPa) = 4.19 × 10⁻⁴ ppb⁻¹ s⁻¹; k(0 °C) = 3.32 × 10⁻⁴; k(30 °C) = 5.15 × 10⁻⁴. The IUPAC value differs by
  under 10 % (physics §13 item 8) and is absorbed by the τ check.
- When the radiation is missing (manual scenarios), model.js estimates G from the solar elevation at the hour mid-point
  and the cloud cover: Holtslag & van Ulden (1983), K↓ = (990 sin φ − 30)(1 − 0.75 N^3.4) W/m².

**Why not the photostationary state.** At a kerbside site the parcel reaches the inlet within one to two minutes. At
k ≈ 4 × 10⁻⁴ ppb⁻¹ s⁻¹ and O3 ≈ 25 ppb, the NO lifetime 1/(k O3) is about 100 s, so equilibrium is not reached.
Physics §8.3 and critic §1.2 found the PSS over-predicts NO2 by 15–18 %.

## 4. Parameters

| Parameter | Value | Range | Source |
|---|---|---|---|
| f_NO2 (primary NO2 / NOx, mass) | **0.10** | 0.05–0.20 (sensitivity) | Critic §1.2 (with the ZAGREB-4 background f = 0.10 gives FB −0.01; f = 0.20 gives +0.10). Physics §8.3 oxidant regression 0.08–0.10. It **replaces** the 0.25 of site-context |
| τ | age tracer; 60 s default | plausibility 30–120 s | Critic §1.2: best constant for ZAGREB-1 |
| α (UV albedo) | 0.05 | – | Trebs et al. 2009 |
| B1, B2 | 1.47e-5, −4.84e-9 | – | Trebs et al. 2009 (verified, physics §14) |
| k: A-factor, E/R | 3.0e-12 cm³ s⁻¹, 1500 K | – | JPL evaluation (Burkholder et al.) |
| p | 1013.25 hPa | – | the station is at 116 m a.s.l.; standard pressure |
| Reporting conditions | 293.15 K, 101.325 kPa | – | Directive 2008/50/EC Annex VI |

## 5. Background (model.js `mod_background`)

The total at the receptor is background + local increment (Lenschow et al. 2001; physics Eq. 2.2).

- **Station.** ZAGREB-4 (ISZZ 303, suburban background, EoI HR0041A, 4.4 km SW) supplies NOx, NO2, O3, PM10 and PM2.5.
  Critic §1.2: Mirogojska carries its own morning traffic peak and has no raw hourly NOx; ZAGREB-3 has PM10 above
  ZAGREB-1. **O3 is not measured at ZAGREB-1** (critic §1.7), so the receptor's O3 is always the chemistry's output
  from the ZAGREB-4 value.
- **Forecast mode.** The UI (data.js, [ui]) passes CAMS Europe × the rolling 14-day ratio to ZAGREB-4 (physics
  Eq. 11.1; 2025 ratios NO2 1.77, O3 0.86, PM10 1.20, PM2.5 0.85, critic §4.1 D9). CAMS NO is unusable, so a
  background with NO2 but without NOx gets **NOx = 1.47 × NO2**, the ZAGREB-4 2025 annual ratio 24.0/16.3. This
  simplifies physics §11.4, which suggests a monthly × hourly climatology.
- **Defaults** when a value is missing (`MOD_BG_DEFAULT`, reported in `bg.defaulted`):

| Species | Default | Basis |
|---|---|---|
| NOx, NO2, O3, PM10, PM2.5 | 24.0, 16.3, 54.0, 25.6, 15.7 µg/m³ | ZAGREB-4 2025 annual means (physics §7.9) |
| CO | 0.19 mg/m³ | ZAGREB-1 2025 mean 0.24 mg/m³ (physics F3) minus the mean local increment 0.98 × 46.1 µg/m³ = 0.045 mg/m³ (ratio of physics §7.6, ΔNOx of critic §1.4). ZAGREB-4 does not measure CO |
| Benzene | 0.35 µg/m³ | 0.68 − 0.0071 × 46.1 = 0.35, same method |

## 6. Limit values, thresholds and index bands (`THRESHOLDS`, `thresholdLines`, `EAQI_BANDS`, `eaqi`)

### 6.1 Limit values and WHO guidelines (µg/m³; CO mg/m³)

`THRESHOLDS[pollutant][averaging] = [{v, kind, from, to, n, stat, note, ref}]`. `thresholdLines(p, avg, {year})`
returns the lines valid in a given year, with localised labels, for the charts.

| Pollutant | Averaging | EU/HR until 31.12.2029 (2008/50/EC = AAQD 2024/2881 Annex I Table 2 = NN 77/2020) | EU from 1.1.2030 (AAQD 2024/2881 Table 1) | WHO AQG 2021 |
|---|---|---|---|---|
| NO2 | 1 h | 200, max 18/yr | 200, max 3/yr | (200, AQG 2005) |
| NO2 | 24 h | – | 50, max 18/yr | 25 (99th pct.) |
| NO2 | year | 40 | 20 | 10 |
| PM10 | 24 h | 50, max 35/yr | 45, max 18/yr | 45 (99th pct.) |
| PM10 | year | 40 | 20 | 15 |
| PM2.5 | 24 h | – | 25, max 18/yr | 15 (99th pct.) |
| PM2.5 | year | 20 (HR "2. stupanj" from 2020; EU 25) | 10 | 5 |
| SO2 | 1 h | 350, max 24/yr | 350, max 3/yr | – |
| SO2 | 24 h | 125, max 3/yr | 50, max 18/yr | 40 (99th pct.) |
| SO2 | year | – | 20 | – |
| CO (mg/m³) | max daily 8 h | 10 | 10 | 10 (AQG 2000) |
| CO (mg/m³) | 24 h | – | 4, max 18/yr | 4 (99th pct.) |
| CO (mg/m³) | 1 h | – | – | 35 (AQG 2000) |
| Benzene | year | 5 | 3.4 | no safe level |
| O3 | max daily 8 h (target) | 120 on ≤ 25 days/yr (3-year mean) | 120 on ≤ 18 days/yr | 100 (99th pct.); 60 peak-season mean |

### 6.2 Information and alert thresholds

| Pollutant | HR NN 77/2020 (in force) | AAQD 2024/2881 Annex I §4 (to be transposed by 11.12.2026; in the code from 2027) |
|---|---|---|
| NO2 (1 h) | alert 400 (3 h) | information 150; alert 200 (3 consecutive h) |
| SO2 (1 h) | alert 500 (3 h) | information 275; alert 350 (3 consecutive h) |
| PM10 (24 h) | – | information 90; alert 90 (≤ 3 days) |
| PM2.5 (24 h) | – | information 50; alert 50 (≤ 3 days) |
| O3 (1 h) | information 180; alert 240 | information 180; alert 240 |

The values were checked against the AAQD text in critic §1.14. The persistence conditions (3 h, 3 days) and the O3
3-year averaging are stored in `note`. The app draws the value only, and the UI states the condition in its label.

### 6.3 European Air Quality Index

`eaqi(pollutant, value, avg = '1h', scheme = 'eea2024') → {level 1..6, key, label, color, scheme, avg}`. Level 0 means
no data, or a pollutant outside the index (CO, benzene: iszz-api §9.3 recommends colouring them against their limit
values instead). A value equal to a band limit belongs to the lower band.

**EEA 2024 revised index** (ETC HE Report 2024/17; the app's default), upper limits in µg/m³:

| Band | PM2.5 | PM10 | NO2 | O3 | SO2 | Colour |
|---|---|---|---|---|---|---|
| 1 good / dobro | 5 | 15 | 10 | 60 | 20 | `#50F0E6` |
| 2 fair / prihvatljivo | 15 | 45 | 25 | 100 | 40 | `#50CCAA` |
| 3 moderate / umjereno | 50 | 120 | 60 | 120 | 125 | `#F0E641` |
| 4 poor / loše | 90 | 195 | 100 | 160 | 190 | `#FF5050` |
| 5 very poor / vrlo loše | 140 | 270 | 150 | 180 | 275 | `#960032` |
| 6 extremely poor / izuzetno loše | > 140 | > 270 | > 150 | > 180 | > 275 | `#7D2181` |

**Legacy bands** that the Croatian portal still uses (`scheme = 'iszz'`; iszz-api §9.3: all 190 normalised values at
station 155 match them, none match the revised ones; ISZZ applies the PM bands to 24-h running means):

| Band | PM2.5 | PM10 | NO2 | O3 | SO2 | Colour |
|---|---|---|---|---|---|---|
| 1 | 10 | 20 | 40 | 50 | 100 | `#55EFE5` |
| 2 | 20 | 40 | 90 | 100 | 200 | `#54CAAA` |
| 3 | 25 | 50 | 120 | 130 | 350 | `#EFE558` |
| 4 | 50 | 100 | 230 | 240 | 500 | `#FE5355` |
| 5 | 75 | 150 | 340 | 380 | 750 | `#940D36` |
| 6 | > 75 | > 150 | > 340 | > 380 | > 750 | `#7D2181` |

The `avg` argument is passed through, so the caller can state which averaging it applied. It does not change the band
limits.

## 7. Validation

### 7.1 Chemistry alone, with measured NOx (reproducing critic §1.2)

- **Method.** NO2 at ZAGREB-1 is computed from the *measured* ΔNOx = NOx(Z1) − NOx(Z4), with the ZAGREB-4 NO2, NOx and
  O3 as background and J and k from the IFS hour-ending SW and T2. This tests the chemistry only.
- **Data.** 2025, `data/processed/` (validated), 7 811 hours with all inputs.
- **Script.** Critic's `chemistry_test_z4.py`, re-run with `tools/aqmodel.py`. `tools/calibrate.py` writes the default
  row to `calibration.json` `chemistry_check`.

| Scheme | Mean NO2 (obs 31.8) | RMSE (µg/m³) | r | FB (mod − obs) |
|---|---|---|---|---|
| **Riccati, f = 0.10, τ = 60 s (default)** | **31.6** | **5.10** | **0.965** | **−0.009** |
| Riccati, f = 0.10, τ = 30 s | 28.2 | 6.77 | 0.956 | −0.120 |
| Riccati, f = 0.10, τ = 120 s | 34.6 | 5.99 | 0.964 | +0.083 |
| Riccati, f = 0.05, τ = 60 s | 29.8 | 6.20 | 0.957 | −0.067 |
| Riccati, f = 0.15, τ = 60 s | 33.3 | 5.89 | 0.963 | +0.045 |
| Riccati, f = 0.20, τ = 60 s | 35.1 | 8.00 | 0.955 | +0.097 |
| Photostationary state (τ = ∞), f = 0.10 | 38.3 | 9.68 | 0.941 | +0.184 |

- **Comparison with the critic.** It reported RMSE 5.0, r 0.966, FB −0.011 for the default, and PSS FB +0.177.
- **Why the small differences.** The processed IFS table uses the correct time semantics for `shortwave_radiation`
  (already a preceding-hour mean, so it is not averaged again). Also, hours with Z1 < Z4 enter with ΔNOx clipped at 0,
  as they do in the app.
- **Result.** The default reproduces the critic's result within 0.1 µg/m³.
- **FAIRMODE.** On the calibration months (7 422 hours) the same check gives RMSE 5.11, r 0.966 and **MQI 0.20**
  (physics Eq. 10.5): far inside the FAIRMODE objective MQI ≤ 1. The error budget of the full model is dominated by
  dispersion and emissions, not by the chemistry (physics §10.4).

### 7.2 End to end, with the modelled NOx

- **Method.** With the calibrated Gaussian model (chapter 07), the held-out test predictions of ΔNOx go through the
  same chemistry with the ZAGREB-4 background.
- **NO2 at ZAGREB-1, 2025, 7 422 test hours.** FB −0.009, NMSE 0.18, FAC2 0.86, R 0.75, RMSE 13.7 µg/m³, **MQI 0.53**
  (`calibration.json` → `gauss.totals_test.no2`).
- **Reading.** Most of that skill is the background's. The local increment is what the 3D model has to improve.

### 7.3 Automated tests

| Test | Result |
|---|---|
| NOx → 0 (no increment, no background NOx): NO2 → 0, O3 unchanged | pass (JS, Python) |
| O3-limited titration at night (J = 0, τ = ∞): NO2 = Ox, O3 = 0 | pass |
| NOx-limited at night: NO2 = NOx | pass |
| PSS satisfies k (N − x)(X − x) = J x | to 1e-9 relative |
| Conservation: NOx out = in; Ox and NO + NO2 conserved (ppb) | to 1e-9 |
| τ = 0 gives background + primary NO2 | exact |
| k(15 °C) = 4.19e-4; J(800)/1.05 = 8.7e-3; NO2 1.9125, NO 1.2474, O3 1.9953 µg/m³ per ppb | pass |
| Parity Python ↔ JS: `no2_chemistry` 40 random cases (τ incl. 0 and ∞), `chem_sample` 301 real 2025 hours (J and k recomputed in JS from SW, T2), `ppb`, `eaqi` 132 cases, `j_no2`, `k_no_o3` | all within 1e-6 relative |
| RMSE on the 301-hour sample < 6.5, r > 0.94, \|FB\| < 0.05; on all 2025 hours RMSE = 5.0 ± 0.4, r > 0.955 | pass (5.10, r 0.965) |
| EAQI: NO2 10 → 1, 10.01 → 2, 151 → 6; legacy NO2 41 → 2, PM10 55 → 4; CO → 0; threshold lines for 2026 and 2031 | pass |

## 8. Limitations

- One well-mixed parcel per receptor/cell. Segregation of the plume and the O3 deficit inside it are not resolved.
  This is standard for street models (OSPM, Soulhac et al. 2022).
- No VOC/HO2/RO2 chemistry (NO + HO2/RO2 → NO2). That is justified at this scale (physics §8.1), but it may cause part
  of the summer-afternoon bias.
- f_NO2 is one fleet-average value. Diesel Euro 5/6a–c cars emit more primary NO2 than petrol cars, so an EV or LEZ
  scenario would also change f. That is not modelled.
- τ comes from the age tracer (GPU) or from the Gaussian travel time (fallback). The fallback's travel time uses
  U_eff of the 10 m wind, so it is shorter than the street-level residence time.
- The background comes from a station 4.4 km away. On some wind directions ZAGREB-4 is itself downwind of the city
  centre, which reduces the observed increment.
- The index and threshold tables are as of 2026-09. AAQD 2024/2881 is to be transposed into Croatian law by
  11.12.2026. The code assumes its information/alert thresholds apply from 2027.

## 9. How to change or re-run

- Change f_NO2 in `SITE.model_defaults.f_no2` (and `calibration.json` via `tools/calibrate.py`), or pass `opts.fNO2`
  to `concentrations()` for a sensitivity run.
- After changing any formula in `chemistry.js` or `meteo.js`, make the same change in `tools/aqmodel.py`, then run
  `python3 tools/aqmodel.py --write-parity`, `python3 -m unittest tests/python/test_aqmodel.py` and
  `python3 tests/browser/run_selftest.py --only models`.
- The chemistry-only check is re-run by `python3 tools/calibrate.py` (field `chemistry_check`). The variants table in
  §7.1 comes from the loop in `tests/python/test_aqmodel.py::TestChemistry` (default row), extended by hand for the
  other f and τ values.
