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

## 11.6 Step 5: integration and review (the lead, three reviewers)

The git history records the build in four commits (`git log --stat`):

| Commit | Local time | Content | Size |
|---|---|---|---|
| `361092c` Scaffold | 2026-09-27 23:08 | `config/site.json`, the shared tools, `tools/build.py`, `core.js`, `i18n.js`, the test harness, the architecture contract, the five research reports (§11.3–11.4) | 36 files, +5,205 lines |
| `e4e8563` Build all modules | 2026-09-28 08:56 | the seven owners' work (§11.5) after the lead's integration review (item 1 below): data pipelines, processed tables, pure models, 3D scene, GPU wind and dispersion, UI, chapters 01–08 and 12 | 81 files, +42,951 |
| `9a896b9` Integration | 2026-09-28 10:25 | the exact frame and the fixes from the physics and data reviews (items 3 and 5); chapters 00, 09, 10, 11, glossary, references, README, data licences; the CI workflows | 35 files, +1,237 / −56 |
| `920d739` UI review | 2026-09-28 11:01 | the fixes from the UI review (item 5); chapters 08 and 12 updated, fresh screenshots | 20 files, +1,238 / −373 |

1. **Integration review, before the checkpoint.** The lead ran the whole app headless and fixed what only shows when
   the modules run together. The fixes are marked "integration review / fix / addition, 2026-09-28" where they are
   documented:
   - a receptor-only sweep job answered from the receptor store is now delivered, so the 16-direction sweep no longer
     waits forever on a second visit (docs/03 §7.2);
   - the receptor store and the LUT carry a hash of the solver code (`aero_codeHash`) and the tree state
     (`meta.leaves`) (docs/03 §6.2, §7.1);
   - live fields on another grid than the LUT no longer replace it; a scenario field is carried onto the LUT as a
     relative change (architecture §6.1, `mod_deltaOnLut`);
   - the lid control is display-only, and the docs say so (docs/08 §8.7);
   - 3D labels are decluttered (docs/12 §6.4);
   - the 10 m LUT was re-exported on an idle machine and the 3D model was calibrated on it for the first time
     (docs/03 §8.3, docs/07 §11.1).
2. **Checkpoint commit** `e4e8563`. 117 Python tests and the 68 fast in-page tests pass (75 in-page tests in all,
   7 of them slow). The end-to-end test (`tests/browser/e2e.py`) boots the page, computes the GPU fields for today
   and for the "tree rows" scenario, and screenshots both screen sizes.
3. **Frame fix.** The reference's equirectangular constants compress the map by 0.17 %/0.55 %. They were replaced by
   exact WGS84 metres per degree (kx = 77 741.2, ky = 111 147.4 m per degree), and `env.json` was rebuilt offline
   from the caches (docs/02-geometry.md §2.3): 4,275 buildings instead of 4,304, 1,807 trees instead of 1,828. The
   embedded 10 m LUT and its calibration were computed on the geometry before the fix (docs/07 §11.1).
4. **5 m LUT export.** Started at 09:28 local, two minutes after the rebuilt `env.json`, in a detached `tmux`
   session, because it takes hours on software WebGL (docs/10-runbook.md §10.4). `export_lut.py` builds the page once
   at its start, so this export runs the current geometry with the code of 09:28. The band-centring and per-entry
   quality fixes of the physics review (item 5; `scalar.js` and `aero.js` were last written at 10:12–10:14) are not
   in it. They do not change Γ or the age A; the LUT's `band` is the first, shifted block and it has no `quality`.
   It finished at 12:34 (48/48 jobs, 11,160 s). It was installed as `src/data/lut_receptor.json`, and `tools/calibrate.py`
   refitted β = 2.98 and U0 = 1.95 m/s and regenerated docs/07-calibration.md §9 (item 7).
5. **Three independent reviews**, while the 5 m export ran. Three reviewers checked (a) physics and units, (b) data
   and time, and (c) UI and accessibility. Each was told to verify every finding with a computation or test before
   reporting it, and to fix only confirmed bugs in its own scope, with a regression test. The confirmed findings and
   their fixes:
   - *Physics and units* (commit `9a896b9`):
     - the 3D β and U0 of `calibration.json` were applied to any LUT; they now apply only to a LUT on the grid they
       were fitted on (model.js `mod_calFor`, finding 1; docs/07 §12, architecture §6.1);
     - the representativeness band was a 3×3×2 block shifted half a cell downstream; it is now centred on the inlet
       (scalar.js `ScalarField.receptor`; architecture §4.4);
     - every LUT entry now carries its solve quality, and `export_lut.py --check` warns about entries that did not
       converge (aero.js, finding 6);
     - documented, not changed: the Gaussian fallback and the GPU tunnel see different source areas, which matters
       for heating with westerly winds (finding 4; docs/07 §12, docs/09 §9.2), and the summer model correlates better
       with the traffic profile shifted by +1 h (docs/09 §9.1).
   - *Data and time* (commit `9a896b9`; the browser regression tests are in `ui.test.js`, commit `920d739`):
     - ISZZ sends its HTTP 429 without CORS headers, so the browser sees a network error; data.js now retries it like
       a 429 (docs/08 §7);
     - a request range longer than `chunk_days` is split under the 1000-row cap without duplicate hours (data.js);
     - three implausible raw station wind values (57, 127.6 and 219.5 m/s, May–June 2024) are dropped and counted
       (`build_measurements.py`, docs/01 §10);
     - documented: raw 2026 CO shows analyser zero drift (docs/01 §10, docs/09 §9.3).
   - *Also fixed from the reviews in commit `9a896b9`*: the held-out totals of `calibrate.py` used the whole-period U0
     for the plume age of a test hour, now the fold's U0 (no test leakage); the ENV fallback geometry voxelised the
     station tree twice (voxel.js `vox_envGeometry`).
   - *UI and accessibility* (commit `920d739`):
     - the slice shows the local sources by default, on linear per-pollutant scales, with a total/EAQI switch and a
       labelled legend (docs/08 §3.8, docs/12 §6.1);
     - the panel puts the essentials first and the advanced, model, forecast and data sections in collapsible groups
       (docs/08 §1, §3);
     - 3D labels stay inside their view and give way to the cards (docs/12 §6.4);
     - the model status and explicit hour intervals appear wherever numbers do; the forecast states which hours lack
       CAMS; the hour slider is safe on daylight-saving days; the 3D sun stands at the middle of the hour
       (docs/08 §2–§3);
     - chart time axes choose their tick step from the plot width, so date labels never overlap.

   With the regression tests the suite grew from 117 to 120 Python tests and from 75 to 85 in-page tests.
6. **Documentation consistency pass** (commit `683c920`):
   - a link checker found 0 broken links among 168 relative links and images, and 3 stale section references, which
     were fixed;
   - every number was re-checked against the current data;
   - every runbook command was checked against its `--help`;
   - one contradiction was fixed: the lid control is display-only.
7. **5 m LUT and final calibration.**
   - The 5 m export finished at 12:34: 48/48 jobs, 11,160 s, no page errors, `--check` OK.
   - It was installed, the 10 m LUT was kept in `data/cache/lut/`, and `tools/calibrate.py` was re-run:
     - β = 2.98, U0 = 1.95 m/s;
     - held-out NOx increment: r 0.48, NMSE 1.45, FAC2 0.57, against the baseline's r 0.46, NMSE 1.53, FAC2 0.58;
     - held-out total NO₂: r 0.74, FAC2 0.87, MQI 0.54 (docs/07 §11.2).
   - Then the full test suite ran, including the slow GPU verification, and the end-to-end test ran on both grids
     (§11.8).

## 11.7 How to repeat this for another station

1. Change `config/site.json`: the station id and coordinates, the background station, the frame origin, and the
   ZG3D/DTM sources if the station is outside Zagreb. Outside Zagreb, use the OSM building fallback or ask DGU for
   LiDAR.
2. `make data` ([10 Runbook](10-runbook.md) §10.2–10.3). Check `docs/img/geo_*.png` and the validation JSON
   ([02 Geometry](02-geometry.md) §2.9).
3. Revisit the source groups (the two named streets in `tools/build_env.py`) and the AADT table
   ([02 Geometry](02-geometry.md) §2.7.2, [05 Emissions](05-emissions.md) §3).
4. `make build`, `make lut`, `make calibrate`, `make test` ([10 Runbook](10-runbook.md) §10.4–10.5).
5. Re-read [09 Limitations](09-limitations.md) and redo the site-specific checks: inlet height, kerb distance,
   anemometer quality.

## 11.8 Tools and effort

| | |
|---|---|
| Agents | 4 research + 1 critic + 7 module owners + 3 reviewers (physics and units, data and time, UI) |
| Code | about 18,800 lines (JS about 11,700 in `src/js/`, Python about 7,100 in `tools/`), plus about 4,600 lines of tests |
| Tests (commit `920d739`) | 120 Python unit tests (`test_iszz.py` 54, `test_geometry.py` 44, `test_aqmodel.py` 22); 85 in-page tests (78 fast, 7 slow: flow 17, models 16, scalar 14, scene 18, ui 20); an end-to-end browser test |
| Documentation | chapters 00–12, the architecture contract, glossary and references (about 6,600 lines), plus the five research reports (about 3,900 lines) |
| External data | ISZZ (about 1,300 paced requests for the full history), Open-Meteo (a few), ZG3D (12 pages and a count query), DGU DTM (1 range request), Overpass (7 queries) |

### 11.8.1 Final verification (2026-09-28, 12:41–13:11, on the 5 m LUT)

Everything below was run by `data/cache/full_tests.sh` (not in git) in one detached session, after the 5 m LUT and
its calibration were installed:

| Check | Command | Result |
|---|---|---|
| Python unit tests | `python3 -m unittest discover -s tests/python` | **120 / 120 OK** |
| In-page suite, all tests incl. slow GPU verification | `tests/browser/run_selftest.py --timeout 7200` | **85 passed, 0 failed**, no page errors (10 min on SwiftShader) |
| End to end, 10 m grid | `tests/browser/e2e.py --query "grid=coarse&live=0"` | **PASS**: station NO₂ 37.8 µg/m³ today, 41.2 with tree rows (LUT, calibrated β 2.98) |
| End to end, 5 m grid | `tests/browser/e2e.py --query "grid=fine&live=0" --wait 3000` | **PASS**: 37.8 today, 43.0 with tree rows (the scenario's own 5 m field); 17.5 min |
| LUT schema | `tools/export_lut.py --check src/data/lut_receptor.json` | OK (`120x120x32@5m`); warns that it has no per-entry `quality` (exported before that fix) |

Numbers the slow tests measured (docs/04 §9 and docs/03 §8):

| Test | Measured | Criterion |
|---|---|---|
| T1: analytic ground line source | max error 1.9 % (TVD), 3.0 % (upwind) | < 5 % |
| T2: mass balance | outflow/source 1.000 | ± 1 % |
| T3: grid convergence 10 m → 5 m, LBM flow | Γ 0.0342 → 0.0263, GCI 12.5 % (p = 2) | reported |
| T4: canyon W/H = 1, LBM flow | leeward/windward 1.33 (2.41 with a prescribed vortex) | > 1 |
| T5: symmetry | 7.7·10⁻⁷ | 10⁻⁴ |
| T6: linearity | homogeneity exact; superposition 0.43 % (TVD non-linearity) | documented |
| One direction, full pipeline, SwiftShader | 20.5 s at 10 m, 364.5 s at 5 m (3.0 M cell-steps/s) | – |
| Doubling the fine warm-up (10 m) | 9.6 % RMS speed change within 100 m of the station | reported |
| Tree-row wake at 7.5 m | 0.41–0.59 of the free wind in leaf, 0.73–0.83 leafless (1–6 tree heights behind) | plausible windbreak |
