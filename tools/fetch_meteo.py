#!/usr/bin/env python3
"""Open-Meteo ECMWF IFS hourly weather at ZAGREB-1 -> data/processed/ifs_hourly.csv.gz

    python3 tools/fetch_meteo.py                       # archive 2022-12-31 .. today, models=ecmwf_ifs
    python3 tools/fetch_meteo.py --forecast            # forecast API sample (past_days 2, forecast_days 3)
    python3 tools/fetch_meteo.py --cams                # CAMS Europe air-quality sample (background forecast)
    python3 tools/fetch_meteo.py --forecast --save-fixture tests/python/fixtures/meteo_forecast_ifs.json

Why ECMWF IFS and not ERA5 (critic §0.1, §1.1): the "ERA5" file in physics.md was really Open-Meteo `best_match`,
i.e. ECMWF IFS 9 km (grid cell 45.79965 N, 15.924171 E). IFS and real ERA5 differ a lot here (calms < 1 m/s: 31 %
against 17 % in 2025; N/NNW against NNE/NE roses), the low-wind floor U0 fitted on IFS (1.3-1.65 m/s) does not
transfer to ERA5, and IFS explains the NOx increment slightly better (r = 0.25 against 0.22). IFS is available both in
the archive (calibration) and in the forecast API (the live page) and includes boundary-layer height. So both use
`models=ecmwf_ifs` explicitly (critic §4.1 D7, D8); every variable and URL comes from config/site.json -> openmeteo.

Time semantics (Open-Meteo docs, "Valid time" column, checked 2026-09-27; docs/01-data-sources.md §3.3):
- wind_speed_10m, wind_direction_10m, boundary_layer_height, temperature_2m, cloud_cover are INSTANTANEOUS values at
  the stamped hour (timezone=GMT, so the stamps are UTC);
- shortwave_radiation is the MEAN OF THE PRECEDING HOUR ("Shortwave solar radiation as average of the preceding hour").
ISZZ values are hour-ending means (a value stamped 10:00Z is the mean of 09:00-10:00Z, iszz-api §4). To match them the
value for hour-ending t is
- the mean of the instantaneous values at t−1 h and t (trapezoidal rule over the hour; SITE.openmeteo.note);
- for the wind, the VECTOR mean of the two samples: direction from the mean vector, speed = its magnitude;
- for shortwave_radiation, the value stamped t as delivered (it already is the mean over [t−1 h, t]).
A value is missing if either sample it needs is missing.

Outputs:
- data/processed/ifs_hourly.csv.gz        t_utc_end,u10,wd10,blh,t2,cc,sw (units m/s, ° from, m, °C, %, W/m²);
                                          deterministic gzip, time-ordered.
- data/processed/ifs_hourly.meta.json     model, grid cell actually used, variables and their semantics, coverage.
Cache: data/cache/meteo/ (gitignored). One request per calendar year; a year is final once it was fetched 7 days
after its end. Open-Meteo is not rate-limited like ISZZ (free tier < 10 000 calls/day, critic §1.16), so a fresh
checkout (the GitHub Action) simply downloads the four years again (4 requests).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import math
import os
import sys
import urllib.error
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CACHE, PROCESSED, SITE, get, log, utcnow_iso  # noqa: E402

# ------------------------------------------------------------------ constants (all sourced)
OM = SITE["openmeteo"]
MODEL: str = OM["model"]                          # "ecmwf_ifs", critic §1.1 / §4.1 D7-D8
HOURLY: list[str] = OM["hourly"]                  # the six variables of critic §4.1 D7
ARCHIVE_URL: str = OM["archive"]
FORECAST_URL: str = OM["forecast"]
AQ_URL: str = OM["air_quality"]
AQ_HOURLY: list[str] = OM["air_quality_hourly"]   # CAMS NO2, O3, PM10, PM2.5 (critic §4.1 D9)
AQ_DOMAIN: str = OM["air_quality_domain"]         # "cams_europe" (0.1°, critic §4.1 D9)
# Request point = the station, rounded to 4 decimals as in critic §4.1 D7 (45.8005, 15.9742); Open-Meteo returns the
# nearest IFS 9 km cell (45.79965 N, 15.924171 E), which is written to the meta file.
LAT = round(SITE["station"]["lat"], 4)
LON = round(SITE["station"]["lon"], 4)
PAST_DAYS, FORECAST_DAYS = 2, 3                   # live forecast window, critic §4.1 D8 / architecture §6.4 Live
CAMS_PAST_DAYS = 14                               # 14-day bias-correction window against ZAGREB-4, critic §4.1 D9
# The archive's IFS data are updated every 6 hours with no delay (Open-Meteo docs); 7 days of margin before a year's
# download is considered final covers late re-runs of the last analysis days.
SETTLE_DAYS = 7
MIN_AGE_H = 6.0                                    # do not re-download a non-final year within 6 h
HOUR_MS = 3_600_000
PERIOD_START = dt.date(2023, 1, 1)                 # same period as tools/fetch_iszz.py (critic §4.1 D1)

# Column name (the measurements.json key suffix, architecture §4.2 "ifs.*") and Open-Meteo valid-time semantics.
COLUMNS: dict[str, tuple[str, str]] = {
    "wind_speed_10m": ("u10", "instant"),
    "wind_direction_10m": ("wd10", "instant"),
    "boundary_layer_height": ("blh", "instant"),
    "temperature_2m": ("t2", "instant"),
    "cloud_cover": ("cc", "instant"),
    "shortwave_radiation": ("sw", "preceding_hour_mean"),
}
UNITS = {"u10": "m/s", "wd10": "°", "blh": "m", "t2": "°C", "cc": "%", "sw": "W/m²"}
DECIMALS = {"u10": 3, "wd10": 1, "blh": 1, "t2": 2, "cc": 1, "sw": 1}   # below the model's own precision
CAMS_COLUMNS = {"nitrogen_dioxide": "no2", "ozone": "o3", "pm10": "pm10", "pm2_5": "pm25"}   # all "Instant"

CACHE_DIR = CACHE / "meteo"
OUT_CSV = PROCESSED / "ifs_hourly.csv.gz"
OUT_META = PROCESSED / "ifs_hourly.meta.json"


# ================================================================== pure helpers (tested)
def vector_mean_wind(samples: list[tuple[float, float]]) -> tuple[float, float]:
    """Vector mean of wind samples [(speed, direction FROM, degrees)] -> (speed, direction FROM).

    Each sample becomes the blowing-toward vector (u east, v north) = (−s·sin θ, −s·cos θ) (architecture §2);
    the mean vector's magnitude is the speed and its from-direction atan2(−u, −v). If the mean vector vanishes
    (exactly opposite samples) the direction is undefined and returned as NaN."""
    if not samples:
        return math.nan, math.nan
    u = sum(-s * math.sin(math.radians(d)) for s, d in samples) / len(samples)
    v = sum(-s * math.cos(math.radians(d)) for s, d in samples) / len(samples)
    speed = math.hypot(u, v)
    if speed < 1e-9:
        return 0.0, math.nan
    return speed, math.degrees(math.atan2(-u, -v)) % 360.0


def parse_times(times: list[str]) -> list[int]:
    """Open-Meteo 'YYYY-MM-DDTHH:MM' with timezone=GMT -> epoch ms UTC."""
    out = []
    for s in times:
        d = dt.datetime.fromisoformat(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        out.append(int(round(d.timestamp() * 1000)))
    return out


def instantaneous(resp: dict) -> dict[int, dict[str, float | None]]:
    """{epoch ms: {open-meteo variable: value | None}} from one response's 'hourly' block."""
    h = resp.get("hourly") or {}
    times = parse_times(h.get("time", []))
    names = [k for k in h if k != "time"]
    return {t: {k: h[k][i] for k in names} for i, t in enumerate(times)}


def _mean2(a: float | None, b: float | None) -> float | None:
    return None if a is None or b is None else 0.5 * (a + b)


def hour_ending(inst: dict[int, dict[str, float | None]], semantics: dict[str, tuple[str, str]] = COLUMNS
                ) -> dict[int, dict[str, float | None]]:
    """Hour-ending means (module docstring): {t_end ms: {column: value}} for every t whose t−1 h sample exists.

    semantics maps an Open-Meteo variable to (column, 'instant' | 'preceding_hour_mean'); the two wind variables
    are combined as a vector. Variables not in the response are left out."""
    out: dict[int, dict[str, float | None]] = {}
    for t in sorted(inst):
        prev = inst.get(t - HOUR_MS)
        if prev is None:
            continue
        cur = inst[t]
        row: dict[str, float | None] = {}
        for var, (col, kind) in semantics.items():
            if var in ("wind_speed_10m", "wind_direction_10m") or var not in cur:
                continue
            row[col] = cur[var] if kind == "preceding_hour_mean" else _mean2(prev.get(var), cur[var])
        if "wind_speed_10m" in cur and "wind_direction_10m" in cur:
            pair = [(prev.get("wind_speed_10m"), prev.get("wind_direction_10m")),
                    (cur["wind_speed_10m"], cur["wind_direction_10m"])]
            if all(s is not None and d is not None for s, d in pair):
                s, d = vector_mean_wind(pair)   # type: ignore[arg-type]
                row["u10"] = s
                row["wd10"] = None if math.isnan(d) else d
            else:
                row["u10"] = row["wd10"] = None
        out[t] = row
    return out


def year_chunks(start: dt.date, end: dt.date) -> list[tuple[dt.date, dt.date]]:
    """One request per calendar year. The first chunk starts one day early so that the first hour-ending value of
    the period (start 00:00Z, the mean of the hour before) has its t−1 h sample."""
    out, a = [], start
    while a <= end:
        b = min(dt.date(a.year, 12, 31), end)
        out.append((a, b))
        a = b + dt.timedelta(days=1)
    if out:
        out[0] = (start - dt.timedelta(days=1), out[0][1])   # the lead day rides along with the first year
    return out


def iso_z(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ================================================================== URLs
def _qs(params: dict) -> str:
    return urllib.parse.urlencode(params, safe=",")


def archive_url(first: dt.date, last: dt.date) -> str:
    """critic §4.1 D7."""
    return ARCHIVE_URL + "?" + _qs({"latitude": LAT, "longitude": LON, "start_date": first.isoformat(),
                                    "end_date": last.isoformat(), "hourly": ",".join(HOURLY),
                                    "wind_speed_unit": "ms", "timezone": "GMT", "models": MODEL})


def forecast_url() -> str:
    """critic §4.1 D8 (the page's Live.forecast() uses the same query)."""
    return FORECAST_URL + "?" + _qs({"latitude": LAT, "longitude": LON, "hourly": ",".join(HOURLY),
                                     "wind_speed_unit": "ms", "timezone": "GMT", "past_days": PAST_DAYS,
                                     "forecast_days": FORECAST_DAYS, "models": MODEL})


def cams_url() -> str:
    """critic §4.1 D9 (the page's Live.cams() uses the same query)."""
    return AQ_URL + "?" + _qs({"latitude": LAT, "longitude": LON, "hourly": ",".join(AQ_HOURLY),
                               "domains": AQ_DOMAIN, "past_days": CAMS_PAST_DAYS,
                               "forecast_days": FORECAST_DAYS, "timezone": "GMT"})


def fetch_json(url: str) -> dict:
    """GET through common.get (User-Agent, retries). Open-Meteo reports errors as {"error": true, "reason": ...}."""
    try:
        body = get(url, cache=False, retries=4, timeout=120)
    except urllib.error.HTTPError as e:
        reason = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"Open-Meteo HTTP {e.code}: {reason}") from e
    resp = json.loads(body.decode("utf-8"))
    if isinstance(resp, dict) and resp.get("error"):
        raise RuntimeError(f"Open-Meteo error: {resp.get('reason')}")
    return resp


def check_units(resp: dict) -> None:
    """Fail loudly if Open-Meteo ever changes a unit we rely on."""
    want = {"wind_speed_10m": "m/s", "wind_direction_10m": "°", "boundary_layer_height": "m",
            "temperature_2m": "°C", "cloud_cover": "%", "shortwave_radiation": "W/m²"}
    got = resp.get("hourly_units") or {}
    for k, u in want.items():
        if k in got and got[k] != u:
            raise RuntimeError(f"unexpected unit for {k}: {got[k]!r} (want {u!r})")


# ================================================================== archive (cached per year)
def load_year(first: dt.date, last: dt.date, now: dt.datetime, full: bool) -> dict:
    """Cached archive response for one chunk; downloads when missing, not final and older than MIN_AGE_H."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / f"archive_{MODEL}_{first:%Y%m%d}_{last:%Y%m%d}.json"
    if path.exists() and not full:
        meta = json.loads(path.read_text(encoding="utf-8"))
        fetched = dt.datetime.fromisoformat(meta["fetched_at"])
        final = last < fetched.date() - dt.timedelta(days=SETTLE_DAYS)
        if final or (now - fetched).total_seconds() < MIN_AGE_H * 3600:
            return meta["response"]
    url = archive_url(first, last)
    log.info("GET %s", url)
    resp = fetch_json(url)
    check_units(resp)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"fetched_at": now.isoformat(), "url": url, "response": resp}), encoding="utf-8")
    os.replace(tmp, path)
    for old in CACHE_DIR.glob(f"archive_{MODEL}_{first:%Y%m%d}_*.json"):
        if old != path:
            old.unlink(missing_ok=True)
    return resp


def write_csv_gz(path: Path, rows: dict[int, dict[str, float | None]], cols: list[str],
                 decimals: dict[str, int]) -> int:
    """Deterministic gzip CSV (mtime 0), time-ordered; missing values are empty cells."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as gz, \
            io.TextIOWrapper(gz, encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["t_utc_end"] + cols)
        for t in sorted(rows):
            r = rows[t]
            w.writerow([iso_z(t)] + ["" if r.get(c) is None else f"{r[c]:.{decimals.get(c, 3)}f}" for c in cols])
    os.replace(tmp, path)
    return len(rows)


def read_ifs(path: Path = OUT_CSV) -> dict[str, dict[int, float]]:
    """Read ifs_hourly.csv.gz -> {column: {t_end ms: value}} (missing cells skipped). Used by build_measurements."""
    out: dict[str, dict[int, float]] = {}
    with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
        rd = csv.DictReader(f)
        cols = [c for c in rd.fieldnames or [] if c != "t_utc_end"]
        for c in cols:
            out[c] = {}
        for row in rd:
            t = int(round(dt.datetime.fromisoformat(row["t_utc_end"].replace("Z", "+00:00")).timestamp() * 1000))
            for c in cols:
                if row[c] != "":
                    out[c][t] = float(row[c])
    return out


def run_archive(start: dt.date, end: dt.date, full: bool = False) -> int:
    now = dt.datetime.now(dt.timezone.utc)
    inst: dict[int, dict[str, float | None]] = {}
    cell = {}
    for a, b in year_chunks(start, end):
        resp = load_year(a, b, now, full)
        cell = {k: resp.get(k) for k in ("latitude", "longitude", "elevation")}
        inst.update(instantaneous(resp))
    he = hour_ending(inst)
    # keep hour-ending stamps from start 00:00Z (the first ISZZ slot, 01:00 local) up to the last complete hour
    t_lo = int(dt.datetime.combine(start, dt.time(0), dt.timezone.utc).timestamp() * 1000)
    t_hi = int(now.timestamp() * 1000) // HOUR_MS * HOUR_MS
    rows = {t: r for t, r in he.items() if t_lo <= t <= t_hi}
    # trailing hours with no data at all (beyond the archive's latest analysis) are dropped
    while rows and all(v is None for v in rows[max(rows)].values()):
        rows.pop(max(rows))
    cols = [COLUMNS[v][0] for v in HOURLY if v in COLUMNS]
    n = write_csv_gz(OUT_CSV, rows, cols, DECIMALS)
    cover = {c: round(100.0 * sum(1 for r in rows.values() if r.get(c) is not None) / max(1, len(rows)), 2)
             for c in cols}
    meta = {"generated_utc": utcnow_iso(), "model": MODEL, "request_point": [LAT, LON], "grid_cell": cell,
            "period": [start.isoformat(), end.isoformat()],
            "first": iso_z(min(rows)) if rows else None, "last": iso_z(max(rows)) if rows else None, "n": n,
            "columns": {COLUMNS[v][0]: {"open_meteo": v, "unit": UNITS[COLUMNS[v][0]], "valid_time": COLUMNS[v][1],
                                        "hour_ending": "value at t" if COLUMNS[v][1] == "preceding_hour_mean"
                                        else ("vector mean of t-1 h and t" if v.startswith("wind")
                                              else "mean of t-1 h and t")}
                        for v in HOURLY if v in COLUMNS},
            "coverage_pct": cover, "source": archive_url(start - dt.timedelta(days=1), end),
            "attribution": SITE["attribution"]["openmeteo"]}
    OUT_META.write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    log.info("wrote %s (%d hours %s .. %s, grid cell %s) coverage %s", OUT_CSV.name, n, meta["first"], meta["last"],
             cell, cover)
    return 0


# ================================================================== samples for docs and tests
def run_sample(kind: str, out: Path | None, fixture: Path | None) -> int:
    """--forecast / --cams: one request, hour-ending conversion, a short table on stdout."""
    url = forecast_url() if kind == "forecast" else cams_url()
    log.info("GET %s", url)
    resp = fetch_json(url)
    if fixture:
        fixture.parent.mkdir(parents=True, exist_ok=True)
        fixture.write_text(json.dumps(resp, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
        log.info("saved raw response to %s", fixture)
    if kind == "forecast":
        check_units(resp)
        sem, dec = COLUMNS, DECIMALS
    else:
        sem = {v: (c, "instant") for v, c in CAMS_COLUMNS.items()}
        dec = {c: 1 for c in CAMS_COLUMNS.values()}
    rows = hour_ending(instantaneous(resp), sem)
    cols = [c for c, _k in sem.values()]
    out = out or CACHE_DIR / f"{kind}_{MODEL if kind == 'forecast' else AQ_DOMAIN}.csv.gz"
    write_csv_gz(out, rows, cols, dec)
    ts = sorted(rows)
    log.info("%s: grid cell %.5f N %.5f E, %d hour-ending rows %s .. %s -> %s", kind, resp.get("latitude", 0),
             resp.get("longitude", 0), len(ts), iso_z(ts[0]) if ts else "-", iso_z(ts[-1]) if ts else "-", out)
    for t in ts[:: max(1, len(ts) // 8)]:
        print(iso_z(t), {c: (None if rows[t].get(c) is None else round(rows[t][c], 2)) for c in cols})
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", default=PERIOD_START.isoformat(), help="first day (UTC), YYYY-MM-DD")
    ap.add_argument("--end", default=None, help="last day (UTC), default today")
    ap.add_argument("--full", action="store_true", help="ignore the cache")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--forecast", action="store_true", help="forecast API sample instead of the archive")
    g.add_argument("--cams", action="store_true", help="CAMS Europe air-quality sample instead of the archive")
    ap.add_argument("--out", default=None, help="output for --forecast/--cams (default data/cache/meteo/...)")
    ap.add_argument("--save-fixture", default=None, help="also save the raw response JSON here (tests)")
    a = ap.parse_args(argv)
    if a.forecast or a.cams:
        return run_sample("forecast" if a.forecast else "cams", Path(a.out) if a.out else None,
                          Path(a.save_fixture) if a.save_fixture else None)
    start = dt.date.fromisoformat(a.start)
    end = dt.date.fromisoformat(a.end) if a.end else dt.datetime.now(dt.timezone.utc).date()
    if end < start:
        ap.error("--end is before --start")
    return run_archive(start, end, a.full)


if __name__ == "__main__":
    sys.exit(main())
