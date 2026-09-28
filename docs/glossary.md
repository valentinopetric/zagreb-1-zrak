# Glossary

Terms and abbreviations used across the chapters, with the chapter where each is explained in full. Section
references like "physics §6.2" or "critic §4.3" point to the research reports in [research/](research/).

| Term | Meaning |
|---|---|
| **AADT** | Annual average daily traffic: vehicles per day on a road, averaged over the year. The model's traffic unit (docs/05). |
| **Age tracer (A)** | A second scalar solved alongside Γ that accumulates travel time. τ = Σ q A / (U_eff Σ q Γ) is the mean time since emission of the air at a point, in seconds. It drives the NO₂ chemistry (docs/04 §8). |
| **As implemented** | A note in [architecture.md](architecture.md) that records where the code deviates from, or adds to, the original contract. Where they differ, the note is authoritative. |
| **β (beta)** | The single emission multiplier fitted to measurements (docs/07). It absorbs the uncertainty in AADT, emission factors and dispersion. A value of 1 is "raw physics". |
| **Background** | The concentration the air already carries before it reaches the neighbourhood. Here: the suburban background station ZAGREB-4 (live and archive), or the CAMS forecast bias-corrected to ZAGREB-4. |
| **Band (representativeness band)** | The min–max of Γ over the grid cells around the inlet (within 1.5 cells horizontally, the two layers around 4 m; a 4×4×2 block at ZAGREB-1). The page shows it as the grid-resolution uncertainty (docs/04 §12, architecture §4.4). |
| **Blending height (z_b)** | The height (80 m) where the urban wind profile is matched to the weather model's 10 m wind (docs/03, physics §6.2). |
| **CAMS** | Copernicus Atmosphere Monitoring Service. Its European ensemble forecast is used for the background forecast. |
| **D3Q19 / D3Q15** | Lattice-Boltzmann velocity sets: 3 dimensions, 19 (or 15) discrete velocities per cell. |
| **DGU** | Državna geodetska uprava, the Croatian State Geodetic Administration (terrain, national LiDAR). |
| **DHMZ** | Državni hidrometeorološki zavod, the Croatian Meteorological and Hydrological Service. It operates ZAGREB-1. |
| **DTM / DSM / nDSM** | Digital terrain model (bare ground), digital surface model (top of everything), normalised DSM = DSM − DTM (heights above ground). |
| **EAQI** | European Air Quality Index (EEA). Six bands from "good" to "extremely poor" per pollutant. |
| **EF** | Emission factor: grams emitted per vehicle per kilometre (g/veh/km). |
| **EoI code** | The station code used in EU air-quality reporting (ZAGREB-1 = HR0007A). |
| **FAC2, FB, NMSE, MG, VG, R** | Model-evaluation metrics (Chang & Hanna 2004): fraction within a factor of 2, fractional bias, normalised mean square error, geometric mean bias and variance, correlation (docs/07 §6). |
| **f_NO₂** | The primary NO₂ fraction: the share of NOx emitted directly as NO₂ (0.10 here). |
| **Frame (local)** | x east, y up, z south, metres from the DHMZ station point; x = (lon − 15.97422)·77 741.2, z = −(lat − 45.800496)·111 147.4, the exact WGS84 metres per degree since 2026-09-28 (docs/02 §2.3, architecture §2). |
| **Γ (Gamma)** | The unit response: the concentration field for a unit source strength, normalised so that ΔC = 10⁶ β q Γ / U_eff (docs/04 §3). |
| **Hour-ending** | The ISZZ time convention: a value stamped 10:00 is the mean of 09:00–10:00. |
| **IFS** | ECMWF's Integrated Forecasting System. The `ecmwf_ifs` model on Open-Meteo (9 km) is used for the archive and the forecast alike. |
| **Increment (ΔC)** | The local contribution: ZAGREB-1 minus background (measured), or the model's local sources. |
| **ISZZ** | Informacijski sustav zaštite zraka, the Croatian air-quality portal at iszz.azo.hr (Ministry of Environmental Protection and Green Transition, MZOZT). |
| **K, K̂** | Eddy diffusivity (m²/s). K̂ = K / U10 is in metres, which makes one solve serve every wind speed (docs/04 §3). |
| **LAD** | Leaf area density (m²/m³). It sets the porosity of tree cells. |
| **LBM** | Lattice-Boltzmann method: a kinetic scheme for fluid flow that suits the GPU (docs/03). |
| **LEZ** | Low-emission zone. |
| **LoD1 / LoD2** | Level of detail in 3D city models: LoD1 = flat-roof prisms, LoD2 = real roof shapes. |
| **LUT** | Lookup table, here `lut_receptor.json`: Γ and A at the station inlet for 16 directions × 3 stability groups × 4 source groups, computed by the page's own GPU solvers on one grid (`meta.grid`: 10 m or 5 m; docs/03 §7). |
| **Mixing height / lid (h_eff)** | The depth of the turbulent layer that dilutes pollution. Floored at 100 m. |
| **Monin–Obukhov length (L)** | The atmospheric-stability length scale. Negative is unstable (day), positive is stable (night). |
| **OSPM** | Operational Street Pollution Model: a street-canyon model, used in the CPU fallback. |
| **Pasquill–Gifford classes (A–F)** | Stability classes: A very unstable … D neutral … F stable. Grouped here as AC, D, EF. |
| **Raw physics** | The model with β = 1 and the prior U₀ = 1.4 m/s, i.e. without calibration. The page can show it next to the calibrated values (docs/07 §8). |
| **Receptor** | The point where concentrations are evaluated: the ZAGREB-1 inlet at (0, 4 m, 0). |
| **Sc_t** | Turbulent Schmidt number: the ratio of eddy viscosity to eddy diffusivity (0.7). |
| **Smagorinsky** | A sub-grid turbulence model used inside the LBM. |
| **Source groups A–D** | A Vukovarska, B Miramarska, C all other motor roads, D domestic heating (docs/04 §1, docs/05). |
| **Stability groups AC, D, EF** | The three groups the GPU solves: AC (classes A–C, represented by class B with a 520 m lid), D (class D, 135 m) and EF (classes E–F, represented by F with the 100 m floor) (docs/03 §6.1). |
| **SwiftShader** | A software (CPU) implementation of WebGL. It is used for headless tests; it is slow but exact. |
| **TVD / van Leer** | A total-variation-diminishing flux limiter that makes the advection scheme second-order without oscillations. |
| **U_eff, U₀** | Effective wind speed √(U² + U₀²). U₀ stands for the meandering and traffic turbulence that keep dispersing pollution when the wind is calm. It is fitted with β: 1.30 m/s for the Gaussian fallback and 1.80 m/s for the 3D model on the 10 m grid in the first calibration; the current values are in docs/07 §9. The prior is 1.4 m/s. |
| **ZG3D** | The City of Zagreb's 3D city model (2022 edition, LoD2.2, updated against the 2022 LiDAR survey). |
| **ZAGREB-1 / ZAGREB-4** | The traffic station at Vukovarska × Miramarska (ISZZ 155), and the suburban background station (ISZZ 303). |

