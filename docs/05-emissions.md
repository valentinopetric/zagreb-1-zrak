# 05 · Emissions: traffic, fleet, heating and scenario measures

*First draft by the models owner [models]. Covers `src/js/emissions.js`, its mirror in `tools/aqmodel.py`, and the
emission tests in `src/js/tests/models.test.js` and `tests/python/test_aqmodel.py`. Every number below was
recomputed from the code on 2026-09-28 (`python3 tools/aqmodel.py`).*

The binding sources are `docs/research/critic.md` §4.6 (the emission decisions) and §1.3–1.4, §1.12 (the checks behind
them). Background detail is in `docs/research/site-context.md` §3 and §6, and in `docs/research/physics.md` §7. Where
they disagree, the critic wins. For example, the NOx factor is 0.50 g/km and not the 0.35 of site-context, and PM
comes from bottom-up factors and not from the ΔPM10/ΔNOx ratio of physics §7.6.

---

## 1. Purpose

The dispersion side of the model (the GPU scalar solver, or the CPU fallback) computes **unit responses** Γ_k. Γ_k is
the concentration at a point per unit source strength of group k. It depends on the wind direction and the stability
group, but not on wind speed, traffic or fleet. The emission module supplies the other factor: the **reference source
strength q_k of each group for one pollutant and one hour**. The increment is

```
ΔC [µg/m³] = 1e6 · β · Σ_k q_k · Γ_k / U_eff,        U_eff = √(U10² + U0²)          (physics Eq. 2.5)
```

(`increment()` in model.js). Everything a user changes about traffic, fleet, heating or scenario measures goes through
q_k and is therefore instant: no flow or scalar solve is repeated (physics §11.5).

```
 env.json roads (AADT per carriageway, group A/B/C) ──► voxel.js rasterizeSources ──► GPU Γ_A..C ─┐
 env.json heating polygons (weight w)               ──► voxel.js rasterizeSources ──► GPU Γ_D    ─┤
                                                                                                 ├──► model.js increment()
 emissions.js groupStrengths(pollutant, hour, measures, opts) ─────────────────► q_A, q_B, q_C, q_D ─┘
       ▲ trafficFactor(hour): hour × day × month profiles        ▲ EF_DEFAULT × measureFactors(measures)
       ▲ EM_HEATING: season, diurnal shape, rates                ▲ EM_CONGESTION (rush-hour queues)
```

## 2. Inputs and outputs

| Function / constant | Input | Output |
|---|---|---|
| `groupStrengths(pollutant, dateUTC, measures, opts)` | pollutant `'nox'`, `'no2'`, `'no'`, `'pm10'`, `'pm25'`, `'co'`, `'c6h6'`; hour-ending UTC time; measures (§7); `opts.heating` (`true` \| `'auto'` \| `false`), `opts.ef` (EF overrides), `opts.heatingScale`, `opts.congestionShare` | `{A, B, C, D}`. A–C in g m⁻¹ s⁻¹ per 10 000 veh/day, D in g m⁻² s⁻¹ per m² of heating weight w = 1 |
| `trafficFactor(dateUTC, {month})` | hour-ending UTC | f, with veh/h = AADT · f / 24; the weekly mean of f is 1 |
| `measureFactors(measures)` | measures | `{exhaust:{nox, pm10, pm25, co, c6h6}, nonexhaust:{pm10, pm25}, resuspension, congestion, byGroup:{A, B, C}, evShare}` |
| `EF_DEFAULT` | – | fleet emission factors, g veh⁻¹ km⁻¹ (§6) |
| `TRAFFIC_PROFILES` | – | `{hour:{weekday, saturday, sunday}[24], day[7], month[12], raw}` (§5) |
| `EM_HEATING`, `EM_CONGESTION`, `EM_MEASURES_TODAY` | – | heating, queue and default measure constants (§8, §9, §7) |
| `POLLUTANTS`, `POLLUTANT_INFO[p]` | – | `['nox','no2','pm10','pm25','co','c6h6']`; `{short, unit, iszz, key, label}` (label localised with `t()`) |

NO2 and NO have no emission of their own in this model. `groupStrengths('no2', …)` returns the NOx strengths, and
model.js turns the NOx increment into NO2 through the chemistry (chapter 06). O3 returns zeros.

## 3. The unit convention: what q_k is

The source raster (voxel.js, flow owner) gives every cell the weight

- road groups A–C: `Σ_roads (length of road inside the cell [m]) · AADT / 10 000` (`SITE.model_defaults.aadt_unit`);
- heating group D: `Σ (heating-polygon area inside the cell [m²]) · w`.

The solver's Γ is the response to that weight pattern, so q_k must be the emission of **one weight unit**:

- **Roads.** One unit is 10 000 veh/day on 1 m of road. In the hour ending at t the traffic is
  `N = 10 000 · f(t) / 24` veh/h, and with the per-vehicle factor EF in g veh⁻¹ km⁻¹ the line-source strength is

  ```
  q_A..C = N · EF / 3.6e6   [g m⁻¹ s⁻¹]        (3.6e6 = 3600 s/h · 1000 m/km; physics §5.8)
  ```

  With f = 1 and EF_NOx = 0.50 this is **5.787 × 10⁻⁵ g m⁻¹ s⁻¹**. On a Tuesday in March at 08–09 h local time
  (f = 1.569) it is 9.08 × 10⁻⁵ g m⁻¹ s⁻¹.
- **Heating.** One unit is 1 m² of heating polygon with weight w = 1, so q_D is an areal emission rate in
  g m⁻² s⁻¹ (§9).

The AADT of each road, its source group and its share on one-way carriageways are set by `tools/build_env.py`
(geo-data owner, `env.json` `roads[].aadt`, `roads[].g`). The defaults (critic §4.6) are:

| Link | AADT (veh/day, both directions) | Group |
|---|---|---|
| Ulica grada Vukovara, west leg / east leg | 47 000 / 45 000 | A |
| Miramarska cesta north (60 % southbound, 40 % northbound) / south | 20 000 / 12 000 | B |
| Trg Stjepana Radića | 4 000 | C |
| Hrvatske bratske zajednice, Savska, Slavonska, Branimirova, Lučićeva | 50 000, 45 000, 40 000, 25 000, 12 000 | C |
| Class defaults: secondary, tertiary, unclassified, residential, service | 25 000, 12 000, 3 000, 1 000, 150 | C |

There are **no public traffic counts** (critic §1.15, gap G1), so AADT carries about ±25–40 % uncertainty. The
calibrated β absorbs a common error. The UI has separate sliders for all roads, Vukovarska and Miramarska.

## 4. Traffic in time: f(t)

```
f(t) = 24 · p_type(h) · F_day(d) · F_month(m)          (physics Eq. 7.2)
```

where h, d and m are the **local hour start**, day of week and month of the averaging hour (architecture §2): the
hour-ending UTC stamp minus one hour, converted to Europe/Zagreb.

- **Local time.** `met_localParts()` implements the EU summer-time rule directly (Directive 2000/84/EC: CEST = UTC+2
  from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday of October). JavaScript and Python then
  agree to the hour without a time-zone database. `test_local_time_matches_zoneinfo` checks it against `zoneinfo`
  every 7 h over 2024–2025.
- **Day type** is `weekday`, `saturday` or `sunday`. **Croatian public holidays** (Zakon o blagdanima, NN 110/19)
  count as Sundays: 1 Jan, 6 Jan, Easter Monday, 1 May, 30 May, Corpus Christi (Easter + 60 days), 22 Jun, 5 Aug,
  15 Aug, 1 Nov, 18 Nov, 25 Dec and 26 Dec. Easter comes from the Gregorian computus (Meeus, *Astronomical
  Algorithms*, ch. 8).

### 4.1 Hourly shares p_type(h), % of the day's traffic, by local hour start

| h | 00 | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| weekday | 0.9 | 0.6 | 0.4 | 0.4 | 0.6 | 1.5 | 4.0 | 6.8 | 7.2 | 6.0 | 5.3 | 5.4 | 5.6 | 5.7 | 6.0 | 6.6 | 7.2 | 7.3 | 6.6 | 5.2 | 3.9 | 3.0 | 2.3 | 1.5 |
| saturday | 2.72 | 2.08 | 1.49 | 1.21 | 1.07 | 1.52 | 2.98 | 4.83 | 5.35 | 4.96 | 4.56 | 4.50 | 4.71 | 4.44 | 3.81 | 3.94 | 5.33 | 6.96 | 7.40 | 6.61 | 5.44 | 5.13 | 5.04 | 3.93 |
| sunday | 4.10 | 3.34 | 2.32 | 1.90 | 1.55 | 1.55 | 1.93 | 2.56 | 3.15 | 3.49 | 3.43 | 3.45 | 3.79 | 3.99 | 4.01 | 4.83 | 6.69 | 8.65 | 9.27 | 7.71 | 5.86 | 4.60 | 3.76 | 4.10 |

- **Weekday:** the site-context §3.4 table (published as hour-ending 1…24, re-indexed here to hour start 0…23), as
  critic §4.6 decides. It is the author's synthesis of the LOTOS-EUROS factors of the City Action Plan (peaks
  08–09 h and 17–18 h), not a count.
- **Saturday and Sunday:** there is no table in any report, so the shape was **derived** here. Each weekend share is
  the weekday share times the ratio of the corrected effective emission profiles, E_sat(h)/E_wd(h) and
  E_sun(h)/E_wd(h). Those profiles are the median of ΔNOx·U_eff per local hour with the ZAGREB-4 background and IFS
  wind (critic §1.3, `critic/effective_emission_profile_z4_ifs_2025.csv`).
  - Rationale: E(h) = emission(h) × dispersion(h), and the diurnal cycle of dispersion is shared by all day types,
    so it cancels in the ratio.
  - The ratio was smoothed with a circular [1, 2, 1]/4 filter against the sampling noise of hourly medians over
    about 52 days, then renormalised.
  - Check: the daily sums of the unnormalised products are 0.62 (Saturday) and 0.50 (Sunday), close to the NOx day
    ratios 0.65 and 0.52 of critic §1.3.
  - The derived shapes show a late start, an evening maximum (Sunday 18 h: 9.3 %) and Saturday-night traffic, which is
    plausible.
- Every row is renormalised in code to sum to exactly 1, so the rounded values above can stay as published.

### 4.2 Day and month factors

| Factor | Published (site-context §3.4, critic §4.6) | In the code, normalised |
|---|---|---|
| F_day Mon–Thu, Fri, Sat, Sun | 1.00, 1.02, 0.90, 0.70 | 1.0574, 1.0785, 0.9517, 0.7402 (divided by their mean 0.9457, so the weekly mean of f is 1) |
| F_month Jan, Feb, Mar–Jun, Jul, Aug, Sep–Nov, Dec | 0.95, 0.98, 1.02, 0.93, 0.85, 1.03, 1.00 | 0.9599, 0.9902, 1.0306, 0.9397, 0.8588, 1.0407, 1.0104 (divided by the day-weighted mean 0.98970 over 365 days, so AADT stays the annual average) |

The day factors come from Zagreb counts quoted in the Action Plan ("Saturday about 10 % lower, Sunday about 30 %
lower"). The month factors are an **assumption** (site-context §3.4), shaped by the August holiday dip.

## 5. Emission factors

Fleet-average factors per vehicle, 2026 prior (`EF_DEFAULT`, critic §4.6), in g veh⁻¹ km⁻¹. NOx is expressed as NO2 mass,
consistent with ISZZ "NOx izraženi kao NO2".

| Key | Value | Source and derivation |
|---|---|---|
| `nox` | **0.50** | EMEP/EEA Guidebook 2023 (update 2025) Tier 2 with an assumed Zagreb Euro mix gives 0.46 (physics §7.2, `emission_factors.py`). It is raised for real-world urban driving and cold starts. Range 0.3–0.9. β absorbs the rest (critic §1.12) |
| `pm10_exh` = `pm25_exh` | 0.017 | Tier 2 fleet PM exhaust (physics §7.2). Exhaust PM counts entirely as PM2.5 |
| `pm10_nonexh` | 0.029 | Tyre + brake + road wear, EMEP 1.A.3.b.vi–vii Tier 1 Tables 3-1 and 3-2, fleet-weighted (physics §7.3) |
| `pm25_nonexh` | 0.015 | Same tables, PM2.5 |
| `pm25` | 0.032 | = 0.017 + 0.015 (the interface total) |
| `pm10_resusp` | 0.056 | Road-dust resuspension, US EPA AP-42 §13.2.1: E = k sL^0.91 W^1.02 with sL = 0.03 g/m², W = 2.2 t, k = 0.62 g/VKT (physics §7.4). **Only with the winter-sanding measure** |
| `pm25_resusp` | 0.0135 | = 0.056 × 0.15/0.62, the AP-42 particle-size multipliers k_PM2.5/k_PM10 |
| `co` | 0.49 | = 0.98 × NOx: the ΔCO/ΔNOx increment ratio with a daily-P5 background (physics §7.6; not affected by the background-station change, critic §1.4) |
| `c6h6` | 0.0036 | = 0.0071 × NOx: the Δbenzene/ΔNOx ratio, same method |

PM10 without resuspension is 0.046, so **PM10/NOx ≈ 0.09**. This lies inside the measured 0.07–0.19 range of
critic §1.4. PM2.5/NOx = 0.064 matches the ZAGREB-4-based ratio 0.065. The local PM increment is small against a
background of about 25 µg/m³, and the UI says so ("PM is mostly background").

All factors can be overridden per call with `opts.ef` (the UI's EF sliders), using the same keys.

## 6. Measures (scenarios)

A measure set is an object. `EM_MEASURES_TODAY` is "today":

```js
{ lez: false, evShare: 0, eBus: false, carFreeMiramarska: false,
  trafficPct: 100, trafficA: 100, trafficB: 100, congestion: false, resuspension: false }
```

`measureFactors()` turns it into multipliers. **Units:** `evShare`, `trafficPct`, `trafficA` and `trafficB` are
percentages (100 = today), matching the UI sliders.

| Measure | Effect | Source / reason |
|---|---|---|
| `lez` | Exhaust NOx × 0.60, exhaust PM × 0.25; CO and benzene × 0.60 | Low-emission zone (Euro ≤ 2 petrol and ≤ 3 diesel out): Pejić et al. 2018 via critic §4.6. CO and benzene are not given; they take the NOx factor, an **assumption**. It is conservative, because old petrol cars dominate both |
| `evShare` (%) | Exhaust × (1 − e). Non-exhaust PM × (1 − e · b · (1 − 0.3)) | Critic §4.6: "removes exhaust but keeps non-exhaust; BEV brake wear × 0.3". b = brake share of fleet non-exhaust PM (below). 0.3 = 0.0035/0.0122, BEV/ICE brake TSP for a medium car (EMEP Table 3-6) |
| `eBus` | Exhaust × (1 − s_bus,p) on every road | Bus share of fleet exhaust (below). The architecture's groups have no bus corridor, so buses are part of all traffic |
| `carFreeMiramarska` | Group B traffic × 0 | No re-routing: the traffic disappears, an **upper bound** on the benefit (where it would go is unknown) |
| `trafficPct` | Groups A–C × trafficPct/100 | "Less traffic" scenarios and the global slider |
| `trafficA`, `trafficB` | Group A × trafficA/100, group B × trafficB/100, on top of trafficPct | Vukovarska and Miramarska sliders |
| `congestion` | Exhaust of A and B × (1 + 1.5 φ_k) at weekday rush hours | §7 |
| `resuspension` | + `pm10_resusp` / `pm25_resusp` on every road | Winter sanding (Action Plan, site-context §6) |

Independent measures are multiplied: the vehicles an LEZ removes are ICE vehicles, so the EV and LEZ reductions
compound.

**Derived shares** (`EM_SHARES`, all computed in code from the cited numbers):

| Share | Formula | Value |
|---|---|---|
| b, brake share of non-exhaust PM10 | (brake TSP 0.0122 × PM10 fraction 0.98) / (Tier 1 PC tyre+brake 0.0184 + road 0.0075) | 0.462 |
| b, brake share of non-exhaust PM2.5 | (0.0122 × 0.39) / (0.0093 + 0.0041) | 0.355 |
| s_bus, NOx | 0.5 % of vehicle-km (site-context §9.3) × 3.713 g/km (mean of the Tier 2-mix diesel bus 3.975 and the EEV CNG bus 3.451, physics §7.2) / 0.50 | 0.037 |
| s_bus, PM exhaust | 0.005 × 0.0636 (mean of the Tier 1 HDV diesel 0.119 and the CNG bus 0.0081) / 0.017 | 0.019 |
| s_bus, CO | 0.005 × 1.47 (mean of the Tier 1 HDV 1.32 and the CNG bus 1.61) / 0.49 | 0.015 |
| s_bus, benzene | diesel/CNG buses emit negligible benzene | 0 |

The tyre and brake TSP values (medium ICE car, 0.0107 and 0.0122 g/km) and the size fractions (tyre PM10 0.60,
PM2.5 0.42; brake 0.98, 0.39) are EMEP 1.A.3.b.vi Tables 3-4 to 3-7. They reproduce the Tier 1 PC tyre+brake values
0.0184 (PM10) and 0.0093 (PM2.5) to three digits, a consistency check.

So **electric buses change little** (NOx −3.7 %), because buses are only 0.5 % of vehicle-km on these avenues. The
honest message for the UI is that the fleet share, not the bus technology, dominates.

The **tram** is not a source group. It has no exhaust, and wheel, rail and brake wear have no Guidebook factor
(physics §7.5), so the "tram non-exhaust" toggle of critic §4.8 is not modelled; its default would be 0 anyway.

## 7. Rush-hour queues (congestion)

Critic §4.6: "EF × 2.5 in cells within 60 m upstream of the Vukovarska and Miramarska stop lines, 07–09 h and
15–18 h on weekdays". The factor 2.5 comes from Pejić et al. 2018: 0.95 g/km at 15 km/h against 0.40 at 37 km/h on
Miramarska (site-context §3.5). Hours are local hour starts 7, 8, 15, 16 and 17, on weekdays that are not holidays.

The receptor models only know whole groups, not cells. The factor is therefore applied to a group's **exhaust**
emission as

```
EF_exh,k → EF_exh,k · (1 + (2.5 − 1) · φ_k),     k ∈ {A, B}
```

where φ_k is the share of the group's receptor response Γ_k that comes from the queue stretches:

- **Queue stretches** (fallback.js, `FB_QUEUE`) are road points of groups A and B between 15 and 75 m from the
  Vukovarska × Miramarska intersection centre, on a carriageway that approaches it. The stop line is assumed 15 m
  from the centre, plus the 60 m of the critic. The centre is the mean crossing point of the A and B segments within
  150 m of the station. For the 2026-09-27 env.json it is (x, z) = (+28.7, +50.8) m. Two-way ways count half, and
  one-way ways count when their travel direction points at the centre.
- **With the Gaussian fallback**, φ_k is exact for every hour: `FallbackModel.receptor().queue[k] / gamma[k]`, and
  model.js passes it on.
- **With the LUT or live GPU fields**, the solver does not track the queue cells separately. `calibration.json`
  `congestion_share` holds the climatological mean of the fallback's φ_k over all weekday rush hours of 2025 (IFS
  winds): **φ_A = 0.21, φ_B = 0.37**. The same values are the built-in default `EM_CONGESTION.share`.

Congestion is off by default and is **not** part of the calibration: β was fitted without it, so switching it on adds
emissions beyond the calibrated state. That is the intended "what if the queues were modelled" sensitivity.

## 8. Domestic heating (group D)

This is an order-of-magnitude area source (critic §4.6; gap G14: the inventory is from 2010).

| Item | Value | Source |
|---|---|---|
| Polygons | `env.heating[] = {p, w}`: low-rise residential areas with a relative weight w (geo-data owner) | critic §4.6: `landuse=residential` with house/detached buildings, 150–700 m S/SE |
| Season (`opts.heating = 'auto'`) | October–March by local month | critic §4.6 |
| Evening-peak rate, w = 1 | NOx **1.0**, PM10 **2.0** µg m⁻² s⁻¹ | site-context §9.4: household PM10 1 699 t/yr and NOx 851 t/yr (2010 city inventory), about 90 % emitted October–March, spread over ~150 km² of built-up area. That gives ~0.65 (PM10) and ~0.3 (NOx) µg m⁻² s⁻¹ season means, and 2–3× that at the evening peak |
| PM2.5 rate | 1.948 µg m⁻² s⁻¹ = 2.0 × 52.516/53.916 | EMEP/EEA 2023 1.A.4.b.i Tier 1 (Tables 3-4 to 3-6), weighted by the household heating mix (next row) |
| CO rate | 9.41 µg m⁻² s⁻¹ = 1.0 × 296.78/31.55 | Same weighting |
| Benzene | 0 | EMEP Tier 1 gives no benzene factor for small combustion |
| Heating mix | gas 47 %, oil 8 %, wood 7 % (district heating 33 % and electricity 5 % emit nothing locally) | eko.zagreb.hr via site-context §6 (year not stated) |
| Tier 1 EFs, g/GJ | gas NOx 51, CO 26, PM 1.2; liquid NOx 51, CO 57, PM 1.9; wood NOx 50, CO 4 000, PM10 760, PM2.5 740 | EMEP/EEA 2023 1.A.4.b.i, verified in `physics/refs/emep_1A4_small_combustion_2023.txt` |
| Release height | roof level of the low-rise houses, 8 m | architecture §5.3 |

The mix-weighted EFs are NOx 31.55, CO 296.78, PM10 53.92 and PM2.5 52.52 g/GJ. They give PM10/NOx = 1.71 in mass.
This agrees with the critic's 2 : 1 rate ratio to within its "order of magnitude" label. 99 % of the PM comes from the
7 % of households that burn wood (site-context §6: 99.4 % of household PM10 is from wood).

**Diurnal shape** `EM_HEATING.hour` (1 = evening peak), by local hour start:

| h | 00–05 | 06 | 07 | 08 | 09 | 10 | 11–15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| factor | 0.15 | 0.30 | 0.60 | 0.80 | 0.80 | 0.60 | 0.30 | 0.40 | 0.60 | 0.80 | 1.00 | 1.00 | 1.00 | 0.60 | 0.30 |

- The peaks (08–10 h and 19–22 h) are the Action Plan's (site-context §6).
- The individual hour values are an **assumption** shaped to those peaks. The mean is 0.467, i.e. peak/mean = 2.1,
  inside the 2–3 of site-context §9.4.
- q_D = rate × 10⁻⁶ × hour factor × `opts.heatingScale`, in g m⁻² s⁻¹.

**Switch.** `opts.heating = true` forces heating on in any month (the UI's "heating season" toggle). `'auto'` uses
the October–March season, and `false` (the default) turns it off. The calibration uses `'auto'`, and the UI should
too when the toggle is on "auto".

## 9. Parameters (all in `src/js/emissions.js`, mirrored in `tools/aqmodel.py`)

| Constant | Value | Range / note | Source |
|---|---|---|---|
| `SITE.model_defaults.aadt_unit` | 10 000 veh/day | fixed by the raster convention | architecture §5.3 |
| `EF_DEFAULT` | see §5 | UI sliders | critic §4.6 |
| `TRAFFIC_PROFILES` | see §4 | – | site-context §3.4; critic §1.3, §4.6 |
| `EM_SHARES.lez` | NOx 0.60, PM 0.25, CO/benzene 0.60 | – | Pejić 2018 (critic §4.6); assumption for CO/benzene |
| `EM_SHARES.bevBrake` | 0.3 | – | EMEP Table 3-6 |
| `EM_SHARES.brake` | PM10 0.462, PM2.5 0.355 | – | EMEP Tables 3-1, 3-2, 3-4 to 3-7 |
| `EM_SHARES.bus` | NOx 0.037, PM 0.019, CO 0.015, benzene 0 | – | site-context §9.3; EMEP Tier 1/2 |
| `EM_CONGESTION` | factor 2.5; hours 7, 8, 15, 16, 17 (weekdays); φ_A 0.21, φ_B 0.37 | φ from `calibration.json` when present | critic §4.6; `tools/calibrate.py` |
| `FB_QUEUE` (fallback.js) | 15–75 m from the intersection centre | – | critic §4.6 (60 m) + assumed 15 m stop-line offset |
| `EM_HEATING` | season Oct–Mar; rates NOx 1.0, PM10 2.0, PM2.5 1.948, CO 9.41 µg m⁻² s⁻¹; diurnal table §8 | `opts.heatingScale` | critic §4.6; EMEP 1.A.4; site-context §6, §9.4 |
| `EM_HOLIDAYS_FIXED` + Easter Monday, Corpus Christi | Croatian public holidays → Sunday profile | – | NN 110/19 |

## 10. Validation

**Automated tests** (JS: `python3 tests/browser/run_selftest.py --only models`; Python:
`python3 -m unittest tests/python/test_aqmodel.py`):

| Test | Result (2026-09-28) |
|---|---|
| Weekly mean of `trafficFactor(t, {month: false})` over a holiday-free Monday–Sunday week | 1 to 1e-12 (JS and Python) |
| Hour tables sum to 1; day factors mean 1; month factors day-weighted mean 1 | to 1e-12 |
| Annual mean of `trafficFactor` over 2025 (months and holidays included) | 0.990 (holidays lower it by 1 %) |
| `groupStrengths('nox')` at f = 1.569 equals 10 000 · f/24 · 0.5/3.6e6 | exact |
| Heating evening peak (15 Jan, 19 h local) = 1.0e-6 (NOx), 2.0e-6 (PM10) g m⁻² s⁻¹; zero in July with `'auto'` | pass |
| Measures: car-free Miramarska → B = 0; `evShare` 100 → NOx 0 and wear PM kept; `evShare` 1 → 0.99 × NOx; LEZ → 0.6 × NOx; congestion → A × (1 + 1.5 φ_A); sanding → PM10 × (0.046 + 0.056)/0.046 | pass |
| Python ↔ JS parity: `traffic_factor` (32 cases incl. DST switches and holidays), `measure_factors` (7), `group_strengths` (315 = 7 pollutants × 5 hours × 3 measure sets × 3 heating modes) | all within 1e-6 relative |
| Easter 2025 = 20 Apr, 2026 = 5 Apr; Easter Monday 2025 and Corpus Christi 2026 are holidays | pass |

**Consistency with the data.** The weekday traffic shape against the corrected effective emission profile
(critic §1.3), both normalised to a weekday mean of 1, by local hour start:

| hour | 00 | 03 | 05 | 06 | 07 | 08 | 09 | 12 | 15 | 17 | 19 | 21 | 23 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| traffic 24·p_h | 0.22 | 0.10 | 0.36 | 0.96 | 1.63 | 1.73 | 1.44 | 1.34 | 1.58 | 1.75 | 1.25 | 0.72 | 0.36 |
| effective (critic §1.3) | 0.26 | 0.19 | 1.03 | 1.65 | 1.70 | 1.53 | 1.17 | 1.15 | 1.51 | 1.40 | 1.23 | 0.83 | 0.47 |
| ratio | 1.22 | 2.01 | 2.87 | 1.72 | 1.04 | 0.88 | 0.81 | 0.85 | 0.96 | 0.80 | 0.99 | 1.15 | 1.29 |

The effective profile also contains the diurnal cycle of dispersion, so the two need not match. The early morning
(03–06 h) is still the clearest structural gap. The measured increment rises about an hour before the traffic table:
early commuters and delivery traffic under the shallow night-time layer. The calibration diagnostics show the same
thing (chapter 07: obs/mod ≈ 2–3 at 02–06 h).

**Magnitude.** With these factors the raw physics (β = 1, U0 = 1.4) gives a mean ΔNOx of 11.9 µg/m³ against 46.7
observed in 2025, obs/mod = 3.9. The critic's independent sanity run gave 11.0 against 46.0, i.e. 4.2
(critic §1.12). With the GPU model (the 10 m receptor LUT) the same emissions give 14.1 µg/m³, obs/mod = 3.3
(integration review, 2026-09-28). The fitted β is in chapter 07 (§9, §11.1).

## 11. Limitations

- **No traffic counts.** AADT, the hourly tables (weekday: a synthesis; weekend: derived from air-quality data) and
  the month factors are not counts (critic G1). β absorbs a common scale error, not a shape error.
- **One fleet for all roads.** There is no HDV/bus split by road. Buses are a 0.5 % share everywhere. Speed
  dependence of EFs appears only through the congestion toggle.
- **Congestion as a group factor.** φ_k is exact per direction only for the fallback. The GPU path uses a
  climatological mean.
- **Heating** is an order-of-magnitude, 2010-inventory estimate over polygons chosen by building type (G14). Evening
  NOx at night is partly heating, and the calibration diagnostics suggest the night emissions are too low.
- **CO and benzene** are tied to NOx by fixed increment ratios. The INA Miramarska fuel-station benzene point source
  (critic §4.6, optional) is not implemented.
- **Resuspension** uses one AP-42 silt loading for all roads and seasons when switched on. There is no rain or
  moisture dependence (NORTRIP would be the physical alternative, physics §7.4).
- **Car-free Miramarska** assumes the traffic disappears.

## 12. How to change or re-run

- Change a factor or a profile in `src/js/emissions.js` **and** `tools/aqmodel.py` (same names, snake_case in
  Python), then:
  ```
  python3 tools/aqmodel.py --write-parity          # regenerates the vectors and the copy inside models.test.js
  python3 -m unittest tests/python/test_aqmodel.py
  python3 tests/browser/run_selftest.py --only models
  python3 tools/calibrate.py                       # β, U0 and the congestion shares depend on the emissions
  ```
- A new AADT or source group assignment belongs in `tools/build_env.py` (geo-data owner). Re-run
  `tools/calibrate.py` afterwards; it also refreshes `congestion_share`.
- Inspect one hour from the command line:
  `python3 tools/aqmodel.py --hour 2025-01-14T08:00Z --u10 1.2 --dir 45 --sw 50 --cc 90 --t2 0`.
