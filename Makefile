# Zrak na raskrižju / Air at the crossroads — common tasks. Everything is plain Python 3 (stdlib).
PY ?= python3

.PHONY: all data geometry measurements lut calibrate build test test-py selftest smoke e2e serve clean

all: build

## Data pipeline (network). See docs/10-runbook.md.
data: geometry measurements

geometry:
	$(PY) tools/fetch_osm.py
	$(PY) tools/fetch_zg3d.py
	$(PY) tools/fetch_dtm.py
	$(PY) tools/build_env.py

measurements:
	$(PY) tools/fetch_iszz.py
	$(PY) tools/fetch_meteo.py
	$(PY) tools/build_measurements.py

## Receptor LUT from the GPU model (runs the app headless; slow on software WebGL), then calibration.
lut: build
	$(PY) tools/export_lut.py

calibrate:
	$(PY) tools/calibrate.py

## Page
build:
	$(PY) tools/build.py

serve: build
	$(PY) -m http.server 8000 -d dist

## Tests
test: test-py selftest

test-py:
	$(PY) -m unittest discover -s tests/python -v

selftest:
	$(PY) tests/browser/run_selftest.py --skip-slow

smoke:
	$(PY) tests/browser/smoke.py

## Today + one geometry scenario end to end, both views, 1440×900 and 390×844 screenshots (dist/e2e_*.png)
e2e:
	$(PY) tests/browser/e2e.py --query "grid=coarse&live=0"

clean:
	rm -rf dist
