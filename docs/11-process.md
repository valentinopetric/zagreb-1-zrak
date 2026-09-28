# 11. How this repository was made: the process, step by step

This chapter records **how** the project was researched, designed, built and checked. You can use it to
reproduce the work, audit a decision, or run the same process for another monitoring station. The other
chapters describe **what** each part does.

The project was built on 2026-09-27 and 2026-09-28 by an AI coding agent (Claude Code), working for the
repository owner. Like the reference repo it follows, it was made with AI. The research reports, the design
contract and the tests below exist so that every number can be checked without trusting that process.

---

## 11.1 Starting point

The brief:

- Analyse `ivanrezic/maksimir-pod-kisom`. It is a single-HTML three.js app that compares today's Maksimir
  stadium with the winning design of the new one, in wind and rain. It uses a GPU Lattice-Boltzmann wind tunnel.
- Build the same kind of app for the **ZAGREB-1** air-quality station. Use its data from
  `meteo.hr` and the ISZZ API (`iszz.azo.hr/iskzl/podatak.htm`, `podatakexp.htm`), and LiDAR/3D geometry, so that
  one can see how pollution behaves.
- Offer a simple UI with toggles and settings, in place of the two stadiums.
- Make it extremely structured and well documented, with every step and process written down.

## 11.2 Step 1: scouting (by hand, about 30 min)

1. **Reference repo.** Cloned and read in full: `tools/build.py`, `extract_env.py`, `src/js/*.js` (3,852 lines).
   Architecture learned:
   - JS files concatenated into one ES module with a shared scope;
   - three.js from a CDN importmap;
   - `env.json` from OSM;
   - the D3Q19 LBM rotated to face the wind, with coarse spin-up and then fine grid;
   - a CPU ray-trace fallback;
   - two scissor-split views;
   - a right-hand panel of presets, sliders, a direction dial, comparison tables and an "8 directions" sweep.

   It was built and screenshotted headless to see the UI.
2. **ISZZ API.** The site's JavaScript (`/iskzl/js/data.js`) lists every REST endpoint. Three facts came out of it:
   - `…/rs/podatak/frm/gg` gives station, pollutant and data-type codes, and ZAGREB-1 is **155**;
   - `…/rs/podatak/export/json?postaja=155&polutant=1&tipPodatka=0&vrijemeOd=dd.mm.yyyy&vrijemeDo=…` returns hourly JSON
     without authentication;
   - the export sends `Access-Control-Allow-Origin: *`, so the page can fetch live data itself.
3. **meteo.hr page.** It gives the station coordinates, 45.800496 N 15.97422 E. Its address text was later found to be a
   copy error (step 3).
4. **Tooling.** The machine had Python 3.12 but no Node and no sudo. A headless Chromium with software WebGL2
   (SwiftShader, float render targets, 6 draw buffers) was made to work by extracting the missing system libraries
   from `.deb` packages into a local folder. That is how every browser test in this repo runs
   (`tests/browser/harness.py`, `Z1_BROWSER_LIBS`).

## 11.3 Step 2: research (4 parallel agents plus a critic, about 80 min)

Four research agents each wrote a report, now in `docs/research/`:

| Report | Question | Key outcome |
|---|---|---|
| `lidar-3d.md` | What LiDAR or 3D-building data covers the station, and can it be downloaded by script? | **ZG3D 2022**: the City of Zagreb's LoD2.2 model, updated against the 2022 national LiDAR. It is open and has an anonymous FeatureServer. Esri `binaryPatches` decode with the stdlib. Raw DGU LiDAR comes only on request, with a restrictive publication clause. Terrain comes from the DGU INSPIRE 20 m DTM by HTTP range. |
| `iszz-api.md` | Exactly how does the ISZZ API behave? | 1000-row cap, 429 rate limit, −999 sentinel in validated series, timestamps in epoch ms UTC marking the end of the hour. It includes a tested prototype fetcher. |
| `site-context.md` | What surrounds the station? | The station is at **Vukovarska × Miramarska**, not Sarajevska. The boulevard is 75–80 m wide, not a canyon. Traffic estimates come from peak counts; fleet, heating and meteorology are covered. |
| `physics.md` | How do we model dispersion in a browser, rigorously? | Steady RANS advection–diffusion on the frozen LBM mean flow, K-theory, linear unit responses for 4 source groups, a finite-time NO–NO₂–O₃ scheme, calibration protocol and metrics. |

A fifth agent, the **critic**, re-tested the four reports' claims (`docs/research/critic.md`). It found ten
problems that changed the build. Among them:

- the "ERA5" data were really ECMWF IFS;
- Mirogojska is a poor background, so **ZAGREB-4** is used instead;
- the primary NO₂ fraction is 0.10;
- the inlet is 4 m high and 9–12 m from the kerb;
- the frame constants mismatch the other layers;
- the default emissions under-predict by about 4×.

Its §4, "Decisions for implementation", became binding.

## 11.4 Step 3: the contract (by hand)

Before any module was written, the lead wrote:

- `config/site.json`: every constant in one place, read by the Python tools and embedded in the page;
- `tools/common.py`, `tools/build.py`, `src/js/core.js`, `src/js/i18n.js`: the shared foundation;
- `docs/architecture.md`: the **interface contract**. It fixes the file ownership, the frame, the time
  conventions, every JSON schema, every cross-module function signature, the physics unit convention and the test plan;
- `tests/browser/{harness,run_selftest,smoke}.py`: the browser test harness;
- a provisional `env.json`, built from the research downloads so that every module could run from the first minute;
- placeholder files for every module, so that `tools/build.py` always succeeds.

## 11.5 Step 4: parallel build (7 module owners, about 2.5 h)

Seven agents worked at the same time. Each owned a disjoint set of files and coded against the contract:

| Owner | Files | Delivered |
|---|---|---|
| geo-data | `tools/fetch_{zg3d,dtm,osm}.py`, `build_env.py` | `env.json`: 4,300 building parts with heights above ground, roads with traffic groups and AADT, trees, land use, POIs, morphometry. `lod2.bin`: 73k LoD2 triangles. Validation plots. |
| meas-data | `tools/fetch_{iszz,meteo}.py`, `build_measurements.py`, `refresh-data.yml` | 463k ISZZ hourly rows (2023 onwards) and the IFS archive. `measurements.json` with a 400-day series and statistics. A weekly refresh workflow. |
| models | `meteo/chemistry/emissions/model/fallback.js`, `tools/aqmodel.py`, `calibrate.py` | The pure model layer and an exact Python mirror (1,286 parity vectors). The Gaussian/OSPM fallback. The calibration protocol. |
| scene | `scene/city/visuals.js` | The 3D city (LoD1 and LoD2), scenario geometry, concentration slice, particles, wind streaks, labels. |
| flow | `voxel/wind-tunnel/aero.js`, `tools/export_lut.py` | The LBM port with an urban inflow profile, a new city voxeliser and source rasteriser, the job queue with caches, and the receptor LUT export. |
| scalar | `scalar.js` | The GPU steady advection–diffusion solver: 4 groups plus 4 age tracers, a TVD scheme, a CPU reference implementation, and verification tests T1–T6. |
| ui | `page.html`, `style.css`, `data.js`, `charts.js`, `main.js` | The panel, live ISZZ, Open-Meteo and CAMS clients, SVG charts, forecast, presets, and the bilingual UI (hr/en). |

Each owner ran their own unit and browser tests and wrote the first draft of their docs chapter. Owners found and
resolved cross-module problems through the contract's "as implemented" notes. One example is the scene owner and
the scalar owner agreeing on the slice data layout.

While doing so, the flow owner exported a first **10 m receptor LUT** (16 directions × 3 stability groups × 4
source groups, 48 GPU runs, 15 min). The models owner then calibrated the 3D model against held-out ISZZ data.

## 11.6 Step 5: integration (the lead)

1. **Checkpoint commit.** 117 Python tests and 68 in-page tests pass. The end-to-end test (`tests/browser/e2e.py`)
   boots the page, computes the GPU fields for today and for the "tree rows" scenario, and screenshots both screen
   sizes.
2. **Frame fix.** The reference's equirectangular constants compress the map by 0.17 %/0.55 %. They were replaced by
   exact WGS84 metres per degree, and `env.json` was rebuilt offline from the caches (docs/02-geometry.md §2.3).
3. **5 m LUT export.** Started in a detached `tmux` session because it takes hours on software WebGL. Recalibration
   followed when it finished (docs/07-calibration.md).
4. **Independent review.** Three reviewers checked physics and units, data and time, and UI and accessibility. Each
   was told to verify every finding with a computation or test before reporting it, and to fix only confirmed bugs
   in its own scope, with a regression test.

## 11.7 How to repeat this for another station

1. Change `config/site.json`: the station id and coordinates, the background station, the frame origin, and the
   ZG3D/DTM sources if the station is outside Zagreb. Outside Zagreb, use the OSM building fallback or ask DGU for
   LiDAR.
2. `make data` (docs/10-runbook.md). Check `docs/img/geo_*.png` and the validation JSON.
3. Revisit the source groups (the two named streets in `tools/build_env.py`) and the AADT table (docs/05-emissions.md).
4. `make build`, `make lut`, `make calibrate`, `make test`.
5. Re-read `docs/09-limitations.md` and redo the site-specific checks: inlet height, kerb distance, anemometer quality.

## 11.8 Tools and effort

| | |
|---|---|
| Agents | 4 research + 1 critic + 7 module owners + reviewers |
| Code | about 18,000 lines (JS about 11,000, Python about 7,000) |
| Tests | 117 Python unit tests; 68 fast and 12 slow in-page tests; an end-to-end browser test |
| External data | ISZZ (about 1,300 paced requests for the full history), Open-Meteo (a few), ZG3D (18 pages), DGU DTM (1 range request), Overpass (7 queries) |
