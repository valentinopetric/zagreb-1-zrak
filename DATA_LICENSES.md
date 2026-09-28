# Data licences and attribution

The **code** in this repository is under the MIT licence (`LICENSE`). The **data** it downloads, derives and embeds
in the page is not. Each dataset keeps its own licence, listed below. The page footer shows every attribution string
(from `config/site.json` → `attribution`, and `src/data/env.json` → `meta.attribution`).

| Dataset | Where it ends up | Licence / terms | Attribution string | Notes |
|---|---|---|---|---|
| **ZG3D 2022**, 3D model of the City of Zagreb (LoD2.2 buildings, updated against the 2022 LiDAR survey) | `src/data/env.json` → `buildings`, `morph`; `src/data/lod2.bin` | Otvorena dozvola (Croatian Open Licence, <https://data.gov.hr/otvorena-dozvola>) | © Grad Zagreb – ZG3D 2022 (3D model grada, LiDAR-ažuriran), Otvorena dozvola | docs/02-geometry.md §2.2 |
| **DGU INSPIRE digital terrain model**, 20 m (`RH_ELEV_107.tif`) | base heights inside `env.json` (not shipped as a grid) | Otvorena dozvola (DGU open data) | © DGU – INSPIRE digitalni model reljefa 20 m, Otvorena dozvola | docs/02-geometry.md §2.5 |
| **OpenStreetMap** (roads, trams, rail, trees, land use, names, POIs, fallback buildings) | `env.json` → `roads`, `tram`, `rail`, `trees`, `green`, `water`, `paved`, `heating`, `pois`, `labels`, some `buildings` (`k: "osm"`) | Open Database License (ODbL 1.0) | © OpenStreetMap contributors (ODbL) | Everything in `env.json` derived from OSM stays under the ODbL, as in the reference repo |
| **ISZZ**, Kvaliteta zraka u Republici Hrvatskoj (MZOZT), measurements by DHMZ: stations ZAGREB-1 (155) and ZAGREB-4 (303) | `data/processed/iszz_*.csv(.gz)`, `iszz_completeness.json`; `src/data/measurements.json`; fetched live by the page | **No licence stated** on the portal or on data.gov.hr (docs/research/critic.md gap G4). Public government data; redistribution terms unconfirmed | Izvor podataka: MZOZT – Kvaliteta zraka u Republici Hrvatskoj (iszz.azo.hr); mjerenja DHMZ | **Open action:** ask MZOZT for written confirmation (docs/01-data-sources.md §9). If they object, drop `data/processed/iszz_hourly.csv.gz` from git: the tools re-download it |
| **Open-Meteo**, ECMWF IFS archive and forecast | `data/processed/ifs_hourly.csv.gz`; `measurements.json` → `ifs.*`; fetched live by the page | CC BY 4.0. The free API is for non-commercial use (< 10 000 calls/day) | Weather data: Open-Meteo.com (CC BY 4.0), ECMWF IFS | Commercial use needs an Open-Meteo API plan |
| **CAMS European air-quality forecast** via Open-Meteo | fetched live by the page (forecast background) | Copernicus licence (free, attribution) + Open-Meteo CC BY 4.0 | Background forecast: Copernicus Atmosphere Monitoring Service (CAMS) via Open-Meteo | Bias-corrected against ZAGREB-4 (docs/06-chemistry.md §5) |
| **Receptor LUT and calibration** (`src/data/lut_receptor.json`, `src/data/calibration.json`) | page | Derived by this project from the data above; share under the terms of its inputs (ODbL for the OSM-derived geometry) | – | Produced by `tools/export_lut.py` and `tools/calibrate.py` |

## Not shipped

- **City of Zagreb orthophoto 2022** (0.1 m WMS `Ortofoto2022_Public`). No licence is stated (critic G5). It was used
  only as a build-time visual check of the Miramarska carriageway position. No image derived from it is in the repo.
- **Raw DGU LiDAR** (LAS/LAZ, DMP/DMR 1 m). It is available free on request (form, `izdavanje.podataka@dgu.hr`), but
  the licence forbids publications that let anyone extract the coordinates and heights of individual points or
  objects. Keep it in the gitignored `tools/private/` and ask DGU before publishing anything derived from it
  (docs/02-geometry.md §2.2.2).

## Adapted code

The GPU wind tunnel and parts of the page structure are adapted from
[maksimir-pod-kisom](https://github.com/ivanrezic/maksimir-pod-kisom) © 2026 Ivan Rezić, MIT. The licence notice is
reproduced in `LICENSE`.
