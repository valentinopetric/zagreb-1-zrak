# 10. Runbook

Every command runs from the repository root. The pipeline and the page need only **Python 3.10+ (standard
library)**. The browser tests and the LUT export also need `playwright` and a Chromium (`requirements-dev.txt`). There
is no Node and no bundler.

```sh
python3 -m pip install -r requirements-dev.txt      # optional: browser tests, LUT export, numpy for calibrate.py
python3 -m playwright install chromium               # (add --with-deps on a fresh Debian/Ubuntu)
```

## 10.1 Quick reference

| Task | Command | Network | Time |
|---|---|---|---|
| Build the page | `make build` (= `python3 tools/build.py`) | no | 1 s |
| View locally | `make serve`, then open <http://localhost:8000> | three.js from jsDelivr | – |
| All Python tests | `make test-py` | no | 5 s |
| In-page tests (fast) | `make selftest` | three.js | 1–2 min |
| In-page tests incl. slow GPU verification | `python3 tests/browser/run_selftest.py --timeout 3600` | three.js | 20–60 min on SwiftShader |
| End to end (today + a scenario, 2 screen sizes) | `make e2e` | three.js | 2–5 min |
| Refresh measurements | `make measurements` | ISZZ, Open-Meteo | 1–3 min (incremental) |
| Refresh geometry | `make geometry` | ZG3D, DGU, Overpass | 2–5 min |
| Export the receptor LUT | `make lut` (= `python3 tools/export_lut.py`) | three.js | 15 min at 10 m, 3–5 h at 5 m on SwiftShader, minutes on a real GPU |
| Recalibrate | `make calibrate` | no | 10–60 s |

## 10.2 Refresh the measurements (weekly, automated)

`.github/workflows/refresh-data.yml` runs every Monday. By hand:

```sh
python3 tools/fetch_iszz.py              # incremental: only chunks that are not final (the last ~45 days + a validated probe)
python3 tools/fetch_meteo.py             # Open-Meteo ECMWF IFS archive, hour-ending means
python3 tools/build_measurements.py      # -> src/data/measurements.json
python3 tools/build.py
```

Variants:

- `fetch_iszz.py --refresh-validated` re-reads the validated series of the last years. Run it once DHMZ publishes
  validated data for a new year; it typically lands the following spring.
- `fetch_iszz.py --full` downloads everything again (about 1,260 requests, 25 min at the required 1.1 s pace).
- `fetch_iszz.py --dry-run` prints the URLs that would be requested.
- `fetch_iszz.py --offline` rebuilds the outputs from the cache or the committed table.

Politeness: ISZZ answers bursts with HTTP 429. The fetcher paces at 1.1 s and backs off on its own. Never run two
fetchers at once.

## 10.3 Refresh the geometry

```sh
python3 tools/fetch_osm.py               # 7 Overpass layers (cached; --refresh to re-fetch)
python3 tools/fetch_zg3d.py              # ZG3D 2022 FeatureServer pages (cached; --refresh)
python3 tools/fetch_dtm.py               # DGU INSPIRE DTM, one HTTP range request (cached; --refresh)
python3 tools/build_env.py               # -> src/data/env.json, src/data/lod2.bin, docs/img/geo_*.png
```

After a geometry change:

1. Look at `docs/img/geo_*.png` and the validation block that `build_env.py` logs.
2. **Re-export the LUT and recalibrate** (§10.4). The model's responses depend on the geometry, and the LUT records
   the geometry hash it was computed with.

## 10.4 Export the receptor LUT and recalibrate

The LUT holds Γ and plume age at the station inlet for 16 directions × 3 stability groups × 4 source groups. It comes
from the page's own GPU solvers. `export_lut.py` opens `index.html?sweep=lut` headless and waits for
`window.__lut`.

```sh
python3 tools/export_lut.py --grid fine --timeout 30000        # 5 m grid, the app's default on a real GPU
python3 tools/export_lut.py --grid coarse                      # 10 m grid (the software-WebGL default), about 15 min
python3 tools/export_lut.py --check src/data/lut_receptor.json # validate a file
python3 tools/calibrate.py                                     # fit β and U0, held-out metrics -> src/data/calibration.json
python3 tools/build.py
```

On a machine without a GPU, the 5 m export takes hours. Run it detached, so that closing the terminal or the SSH
session does not stop it:

```sh
tmux new -d -s lut 'python3 tools/export_lut.py --grid fine --timeout 30000 --out data/cache/lut/lut_fine.json 2>&1 | tee data/cache/lut/lut_fine.log'
tail -f data/cache/lut/lut_fine.log              # progress: "k/48 done", ETA
cp data/cache/lut/lut_fine.json src/data/lut_receptor.json && python3 tools/calibrate.py && python3 tools/build.py
```

You can also export the LUT from the page itself on a real GPU. The "Compute all 16 directions" sweep in *Model vs
measurements*, followed by the LUT download button, produces the same file.

## 10.5 Tests

```sh
python3 -m unittest discover -s tests/python -v          # tools: parsing, time, geometry, model parity (fixtures, no network)
python3 tests/browser/run_selftest.py --skip-slow         # in-page: models, scene, flow, scalar, ui
python3 tests/browser/run_selftest.py --only scalar       # one owner's tests (substring match)
python3 tests/browser/smoke.py --query "grid=coarse&live=0"
python3 tests/browser/e2e.py --query "grid=coarse&live=0"
```

- If the system lacks the libraries Chromium needs and you have no root, extract them from the `.deb` packages into a
  folder and point `Z1_BROWSER_LIBS` at its `usr/lib/x86_64-linux-gnu` (docs/11-process.md §11.2).
- `Z1_CHROMIUM` selects a specific browser binary.
- The in-page test report is written to `dist/selftest.json`.

## 10.6 Deploy

`.github/workflows/pages.yml` builds `dist/index.html` on every push to `main` and publishes it to GitHub Pages,
together with `docs/`. The data refresh workflow dispatches it after each data commit. To enable it, go to Settings →
Pages → Source: *GitHub Actions*.

## 10.7 URL parameters

| Parameter | Effect |
|---|---|
| `?lang=hr` / `?lang=en` | UI language (default: the browser language, else Croatian) |
| `?grid=coarse` / `?grid=fine` | 10 m or 5 m fine grid (the default is 5 m, or 10 m on a software renderer) |
| `?live=0` | no network requests for data; the archive only (deterministic screenshots and tests) |
| `?debug` | exposes internals on `window.__z1dbg` |
| `?sweep=lut` | computes the full receptor LUT and publishes it on `window.__lut` (used by `export_lut.py`) |
| `test.html?selftest[&only=…][&skip-slow]` | runs the in-page tests |

## 10.8 Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "approximate model" notice, no 3D field | The browser cannot render to float textures (WebGL2 + `EXT_color_buffer_float`). The page falls back to the Gaussian/OSPM model. Use a desktop browser with hardware acceleration. |
| The 3D field takes minutes | Software WebGL (SwiftShader, llvmpipe). The page switches to the 10 m grid by itself. Close other GPU-heavy tabs. |
| Live values say "not available" | ISZZ or Open-Meteo is unreachable or rate-limited (429). The page shows the baked archive values instead and says so. Wait a minute. |
| `fetch_iszz.py` stops with 429 | Another fetcher, or too many browser tabs, share your IP. Wait and re-run; it resumes from its cache. |
| `export_lut.py` times out | Raise `--timeout`. Check `data/cache/lut/*.log` for page errors. |
| Overpass fails | `fetch_osm.py` falls back to the second endpoint. It needs a User-Agent (HTTP 406 without one; `tools/common.py` sets it). |
| The ZG3D FeatureServer is gone | Use the district shapefiles on data.zagreb.hr (docs/02-geometry.md, fallback F1), or the committed `env.json`. |
