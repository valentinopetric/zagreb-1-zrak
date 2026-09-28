# 09 · Limitations

This model is built to **compare situations and explain patterns** at one monitoring station: which wind brings the
Vukovarska plume to the inlet, how much a tree row or a building changes it, how the day's traffic shows in NO₂. It is
**not** a regulatory model or an exposure assessment, and it does not replace the station. Everything below is also
said where it matters in the chapters. Here it is in one place, ranked by how much it affects the numbers.

## 9.1 Biggest effects on the numbers

1. **Traffic volumes are estimates, not counts.** No public traffic count exists for Vukovarska, Miramarska or the
   side streets near the station (critic §1.15, gap G1). AADT comes from peak-hour counts (FPZ 2017) and class
   defaults, with ±25–40 % uncertainty. The fitted multiplier β absorbs it, and the UI has per-street sliders.
2. **One emission multiplier (β) is fitted to measurements.** Raw physics (β = 1) under-predicts the station's NOx
   increment by about 3× (3.3× for the 3D model on the 10 m grid, 3.9× for the Gaussian fallback;
   [05 Emissions](05-emissions.md) §10). That is typical for street-scale models with default emission factors and
   unresolved traffic turbulence. The page shows "raw physics" and "calibrated" separately
   ([07 Calibration](07-calibration.md)).
3. **Skill is modest.** On held-out months the 3D model (5 m grid) reaches r ≈ 0.48, FAC2 ≈ 0.57 and NMSE ≈ 1.45
   for hourly NOx increments.
   - That is only slightly better than a statistical hour-of-week × wind-sector baseline (r ≈ 0.46, NMSE 1.53). It is
     worse on VG and FAC2.
   - It is clearly better than the Gaussian fallback (r ≈ 0.37). The Gaussian fallback does **not** beat the baseline.
   - For total NO₂ the numbers look much better (r ≈ 0.74, 87 % within a factor of 2). Most of that comes from the
     measured background and the chemistry, not from the local model.
   - Hour-to-hour variability from traffic incidents, meandering winds and inversions is largely unexplained.
   - [docs/07 §9](07-calibration.md) is regenerated after each recalibration and holds the current numbers.
4. **The wind forcing is a 9 km weather model.** ECMWF IFS gives one wind for the whole neighbourhood. Its direction
   error against station vanes is 24–37° (median) and it has calm spells (31 % of hours below 1 m/s). The street-level
   flow is simulated, but the forcing is not local.
5. **Low wind is parameterised, not simulated.** Below about 1.5 m/s, dispersion is dominated by meandering and
   traffic-produced turbulence. The model represents both with one fitted speed U₀ in U_eff = √(U² + U₀²) and by
   averaging over directions. The fit puts U₀ at 1.3–1.8 m/s depending on the model (1.30 m/s for the Gaussian
   fallback, 1.95 m/s for the 3D model on the 5 m grid; docs/07). Most Zagreb hours are in this regime.
6. **Night-time is under-predicted.** Observed/modelled ratios are 2–3 at 02–06 h for the fallback model (docs/07
   §10), and about 2 for the 3D model on the 10 m grid (docs/07 §9). Likely reasons: stable layers shallower than
   the model's lid floor (100 m),
   night heating emissions, and an early-morning traffic ramp missing from the profile. In summer the model
   correlates better with the traffic profile shifted by +1 h (physics review, 2026-09-28), a sign that the diurnal
   shape is only approximate.
7. **PM is mostly not local.** At ZAGREB-1 the local PM₁₀ increment is about 1–3 µg/m³ on a background of about 25
   µg/m³. The model therefore says little about PM beyond "background plus a small traffic share". Winter PM episodes
   come from regional transport and domestic wood heating across the city, which is outside the 600 m domain.

8. **CO and benzene are not reproduced.** On hourly data both reach only r ≈ 0.2–0.3 in the fit year and in 2026
   ([docs/07 §11.3](07-calibration.md)). Their background is a constant, because no background station measures
   them. The model's domestic heating emits no benzene, yet the winter benzene peaks (up to ~14 µg/m³ in January
   2026) follow wood-burning PM. Treat the page's CO and benzene values as indicative.

## 9.2 Physics and numerics

- **Neutral flow only.** The LBM wind is computed for neutral stratification (v1). Stability enters only through the
  eddy diffusivity of the scalar solve, with three groups (AC, D, EF), each solved for one representative class and
  mixing height (docs/03, docs/04). The lid control in the UI is display-only: the 3D field, the LUT and the station
  numbers all use the group's representative lid (AC 520 m, D 135 m, EF 100 m; docs/08 §8.7).
- **Free-slip ground.** As in the reference repo, the ground does not slow the air. Buildings do. Near-ground wind over
  open areas is therefore too strong (critic G12). A no-slip variant is not implemented.
- **5 m cells.** The Miramarska kerb is 9–12 m (2–2.5 cells) from the inlet. Moving from the 10 m to the 5 m grid
  changes Γ at the receptor by about 30 % in the synthetic grid test (grid-convergence index 12.5 %,
  [docs/04 §9.1](04-dispersion.md)), and by up to 3× per source group over the real city ([docs/03 §8.2](03-flow-lbm.md)).
  The page shows a representativeness band (the range over the cells around the inlet).
- **A 600 m domain.** The GPU tunnel covers 300 m upwind and ±300 m across, rotated with the wind. Roads and heating
  further away are in the background, not in the model. The Gaussian fallback sums roads within 800 m, so its group
  C and D responses are not directly comparable with the 3D model's. This matters most for heating (group D) with
  westerly winds: the heating tiles lie 300–600 m west (physics review, finding 4).
- **TVD non-linearity.** With the van Leer limiter, the response to two source groups together differs from the sum
  of the separate responses by about 0.4 % (T6). The model uses the sum.
- **Mass conservation depends on the flow.** The scalar scheme conserves mass as well as the LBM mean flow is
  divergence-free: 1–2 % on city flows (T2/T3).
- **Street-canyon contrast is under-stated.** In an idealised canyon (W/H = 1, 6 cells wide) the leeward/windward ratio
  is 1.33 with the LBM flow, against 2.4 with a prescribed vortex (T4). ZAGREB-1 is not in a canyon (Vukovarska is
  75–80 m wide), so this matters for the side streets, not for the station.
- **Trees are porous blocks.** The LAD → porosity mapping is heuristic (critic §4.3). The tree-row wake may be up to
  about 4× too strong (docs/03 §10). Tree sizes are defaults (12 m / 4 m) except the station tree (14 m, 9 m crown,
  estimated from the orthophoto; critic G8). No tree deposition is modelled.
- **Chemistry is simple.** NO–NO₂–O₃ with a finite reaction time and a primary NO₂ fraction of 0.10. There is no VOC
  chemistry, secondary aerosol, dry deposition or washout.

## 9.3 Data

- **ISZZ validation lags.** 2026 data are raw (not yet validated). Validated data typically change hourly NOx by
  3–26 µg/m³ on average (docs/01 §10).
- **Raw CO in 2026 drifts.** It is reported to 0.1 mg/m³ and its summer monthly means are slightly negative
  (analyser zero drift, to be corrected by DHMZ's validation). Treat live CO values as indicative.
- **The station vane is not reliable for northerly winds.** No directions are recorded between 282° and 16°, and
  28–47 % of strong northerly hours are reported from the opposite half-circle at three DHMZ stations. This is most
  likely a processing artefact (critic §1.5). The station wind is shown, never used as input, and validated only for
  45°–270°.
- **IFS boundary-layer height is missing** before 2024-09-01 and for 493 h in autumn 2025. Those hours use the class
  median.
- **CAMS background needs a correction.** CAMS NO₂ is about 2× too low for Zagreb's suburban background. The forecast
  multiplies it by a 14-day ratio to ZAGREB-4. The last hours of the 72 h forecast can fall back to climatology when
  CAMS has not yet published the day's run (the chart says so).
- **Licences.** ISZZ states no data licence ([DATA_LICENSES.md](../DATA_LICENSES.md)). The ZG3D geometry is 72 %
  from 2008 photogrammetry; only about 23 % of parts come from the 2022 LiDAR survey ([02 Geometry](02-geometry.md)
  §2.9.3). Raw DGU LiDAR was not used (it needs a request and has a publication clause).
- **The frame treats the ground as flat.** The terrain varies by 14 m over 1.5 km. Buildings stand on local ground,
  but the flow does not see slopes.

## 9.4 The app

- **Software WebGL is slow.** Without a GPU (SwiftShader, llvmpipe) one direction takes about half a minute at 10 m
  and about 6 min at 5 m, more while the page also draws its views (docs/03 §8.2). The page switches to 10 m by
  itself. The 16-direction sweep then takes a long time, and the rose fills in as directions arrive.
- **The fallback is approximate.** Without float render targets there is no 3D flow. The Gaussian/OSPM model has
  lower skill and ignores buildings except through a canyon term, which is zero at the station.
- **Scenarios are what-ifs, not designs.** The tree-row, block and tower scenarios are plausible placements chosen for
  illustration (docs/12 §5), not planning proposals. Geometry scenarios keep today's traffic unless you change it.
- **Labels are HTML overlays** and are not hidden behind buildings (same as the reference).
- **No holidays in the traffic profile.** Croatian public holidays are treated as weekdays in the measured diurnal
  profiles, and as Sundays in the model's traffic factor. The model's annual mean traffic factor is therefore 0.99.

## 9.5 What would improve it most

1. Traffic counts on Vukovarska and Miramarska (the City's traffic control centre; critic G1).
2. The DGU LiDAR point cloud for tree heights, and a check of the 2008 ZG3D parts (critic G2).
3. A stability-dependent LBM inflow, and no-slip ground with a wall function.
4. A nested 2.5 m inner grid around the station (critic G13).
5. A local wind measurement free of the vane artefact, e.g. a sonic anemometer on the container, confirmed with DHMZ
   (critic G3).

## 9.6 How to re-check these numbers

Every number above comes from a chapter that says how it was measured, and the commands are in
[10 Runbook](10-runbook.md): the calibration scores and diagnostics from `make calibrate` ([07](07-calibration.md) §9,
§13), the grid and solver tests from the in-page suite ([03](03-flow-lbm.md) §11, [04](04-dispersion.md) §14), the
data gaps from `make measurements` ([01](01-data-sources.md) §8) and the geometry checks from `make geometry`
([02](02-geometry.md) §2.9, §2.11).
