#!/usr/bin/env python3
"""Processed ISZZ + IFS tables -> src/data/measurements.json (the page's baked history, architecture §4.2)

    python3 tools/build_measurements.py              # after tools/fetch_iszz.py and tools/fetch_meteo.py
    python3 tools/build_measurements.py --days 400   # length of the embedded hourly series (default 400 days)

Inputs (all written by this repo's tools, nothing is downloaded here):
    data/processed/iszz_hourly.csv.gz        ZAGREB-1 (155) and ZAGREB-4 (303), merged validated/raw, hour-ending UTC
    data/processed/iszz_completeness.json    period and fetch time (tools/fetch_iszz.py)
    data/processed/ifs_hourly.csv.gz         Open-Meteo ECMWF IFS, hour-ending means (tools/fetch_meteo.py)
    data/processed/ifs_hourly.meta.json      IFS grid cell and fetch time
    data/processed/iszz_pm10_gravimetric.csv ZAGREB-1 daily gravimetric PM10 (reference method, official counts)

Output: src/data/measurements.json, decoded in the page by `Hist` (data.js):
    meta    t0 (epoch ms UTC of index 0, hour-ending), n hourly steps, station ids, model, attribution
            (+ units, validated_until, sources, missing: the additive fields listed in docs/01-data-sources.md §5)
    series  the last ~400 days of every key as base64 Int16 little-endian, value = int16 · scale[key], −32768 missing
    scale   per-key quantisation step (see SCALE below)
    keys    the fixed key list of architecture §4.2 (z1.* ZAGREB-1, z4.* ZAGREB-4, ifs.* IFS)
    stats   computed over the WHOLE period (2023-01-01 .. last hour):
            annual     means per LOCAL calendar year, only complete years with >= 75 % of their hours
            diurnal    mean by LOCAL hour-start (architecture §2) for weekday / saturday / sunday
            monthly    mean by LOCAL calendar month (all years pooled)
            rose       16 sectors by IFS wind-FROM direction; hours with IFS U10 < 0.5 m/s are "calm" (no direction)
            exceed     counts per year: 1-h values or valid daily means above the EU limit values
                       (automatic analyser; the *_ref keys count the gravimetric reference method)
            coverage   % of the period's hours with a value
            increment  annual mean of ZAGREB-1 − ZAGREB-4 on paired hours, last full year (critic §1.2, §1.4)
    latest  last value and time of every key

Time: all stamps are the END of the averaging hour in UTC (ISZZ convention, iszz-api §4); "local" means Europe/Zagreb
(EU summer-time rule, tools/fetch_iszz.py) applied to the hour START, so the value stamped 00:00 local on 1 January
belongs to 23:00-24:00 on 31 December of the old year, as in ISZZ's own tables.
Wind direction keys (z1.wd, ifs.wd10) are circular and are left out of the arithmetic means (annual, diurnal, monthly);
the roses carry the direction information.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import math
import sys
from array import array
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import PROCESSED, SITE, SRC_DATA, log, utcnow_iso, write_json  # noqa: E402
from fetch_iszz import (HOUR_MS, OUT_CSV as ISZZ_CSV, OUT_REF as ISZZ_REF, OUT_REPORT as ISZZ_REPORT,  # noqa: E402
                        PARAMS, STATIONS, hour_start_local, local_midnight_utc, read_processed, read_reference)
from fetch_meteo import MODEL, OUT_CSV as IFS_CSV, OUT_META as IFS_META, UNITS as IFS_UNITS, read_ifs  # noqa: E402

# ------------------------------------------------------------------ constants (all sourced)
OUT = SRC_DATA / "measurements.json"
SERIES_DAYS = 400                       # "the last ~400 days" (architecture §4.2): a full year plus a month
INT16_MISSING = -32768                  # architecture §4.2
INT16_MAX = 32767
SIZE_BUDGET = 1_200_000                 # bytes; page budget: data arrays < 1 MB (critic §4.9), the task allows ~1.2 MB
ANNUAL_MIN_COVERAGE = 0.75              # architecture §4.2 (the AAQD's own objective is 85 %, Annex V B; coverage_by_year shows it)
DAILY_MIN_HOURS = 18                    # AAQD 2024/2881 Annex V C: a 24-h mean needs 75 % of the hours, i.e. >= 18
ROSE_SECTORS = SITE["model_defaults"]["dirs"]   # 16 (architecture §4.2, the model's 16 directions)
ROSE_U_MIN = 0.5                        # m/s; below it the direction carries no information: the model's direction
                                        # kernel becomes uniform below 0.5 m/s (architecture §6.1 directionWeights)
INC_PARAMS = ["nox", "no2", "pm10", "pm25"]     # measured at both stations; inc.* = Z1 − Z4 (critic §1.2)
STATION_ID, BACKGROUND_ID = STATIONS["z1"], STATIONS["z4"]

# Fixed key list of architecture §4.2 (order matters to the page only for display).
KEYS = ["z1.no2", "z1.nox", "z1.pm10", "z1.pm25", "z1.so2", "z1.co", "z1.c6h6", "z1.ws", "z1.wd", "z1.t", "z1.rh",
        "z4.no2", "z4.nox", "z4.o3", "z4.pm10", "z4.pm25",
        "ifs.u10", "ifs.wd10", "ifs.blh", "ifs.t2", "ifs.cc", "ifs.sw"]
# Quantisation step per parameter: at or below ISZZ's raw precision (1 decimal, iszz-api §0) and with Int16 headroom
# far above any value seen at the site (e.g. 0.1 µg/m³ -> ±3276.7 µg/m³; hourly NOx at ZAGREB-1 stays below ~1500).
SCALE_BY_PARAM = {
    "no2": 0.1, "nox": 0.1, "o3": 0.1, "pm10": 0.1, "pm25": 0.1, "so2": 0.1,   # µg/m³
    "co": 0.001,        # mg/m³: validated CO has 3 decimals and is ~0.1-3 mg/m³ (iszz-api §0); ±32.767 mg/m³ range
    "c6h6": 0.01,       # µg/m³: benzene is ~0.5-10 µg/m³; ±327 range
    "ws": 0.01, "wd": 0.1, "t": 0.01, "rh": 0.1,                                  # m/s, °, °C, %
    "u10": 0.01, "wd10": 0.1, "blh": 1.0, "t2": 0.01, "cc": 0.1, "sw": 0.1,      # m/s, °, m, °C, %, W/m²
}
DIRECTIONAL = {"z1.wd", "ifs.wd10"}      # circular: excluded from arithmetic means
ROSE_KEYS = ["z1.no2", "z1.nox", "z1.pm10", "z1.pm25", "z1.so2", "z1.co", "z1.c6h6",
             "z4.no2", "z4.nox", "z4.o3", "z4.pm10", "z4.pm25",
             "inc.nox", "inc.no2", "inc.pm10", "inc.pm25", "ifs.u10"]
# Exceedances at ZAGREB-1 (value strictly above the limit). Limits: Directive (EU) 2024/2881 Annex I (= 2008/50/EC
# until 2029, then the 2030 values), as tabulated in iszz-api §9.1 and checked in critic §1.14.
EXCEEDANCES = [
    # key            param   averaging  limit   note
    ("no2_1h_200",   "no2",  "1h",      200.0),   # 1-h limit, max 18/yr (3/yr from 2030)
    ("no2_24h_50",   "no2",  "24h",     50.0),    # 24-h limit from 2030, max 18/yr
    ("pm10_24h_50",  "pm10", "24h",     50.0),    # 24-h limit, max 35/yr until 2029
    ("pm10_24h_45",  "pm10", "24h",     45.0),    # 24-h limit from 2030, max 18/yr
    ("pm25_24h_25",  "pm25", "24h",     25.0),    # 24-h limit from 2030, max 18/yr
    ("so2_1h_350",   "so2",  "1h",      350.0),   # 1-h limit, max 24/yr (3/yr from 2030)
    ("so2_24h_125",  "so2",  "24h",     125.0),   # 24-h limit, max 3/yr
]
# The same PM10 24-h limits counted on the gravimetric reference method (EN 12341; tools/fetch_iszz.py
# REFERENCE_DAILY). The official compliance count uses these; the automatic analyser counts more days (2025: 42
# against 29 above 50 µg/m³, docs/01-data-sources.md §6.3). Keys get the suffix "_ref".
REFERENCE_EXCEEDANCES = [("pm10_24h_50_ref", "pm10", 50.0), ("pm10_24h_45_ref", "pm10", 45.0)]
# The research numbers this build must reproduce (docs/01-data-sources.md §6 explains any difference).
RESEARCH_CHECK = {("annual", "z1.no2", "2025"): 31.7, ("annual", "z1.nox", "2025"): 71.0,
                  ("annual", "z1.pm10", "2025"): 27.0, ("annual", "z1.pm25", "2025"): 18.4,
                  ("increment", "nox", None): 46.1}


def scale_of(key: str) -> float:
    return SCALE_BY_PARAM[key.split(".", 1)[1]]


def decimals_of(key: str) -> int:
    """Stats are rounded to the series' quantisation step (0.1 -> 1 decimal, 0.001 -> 3)."""
    s = scale_of(key)
    return max(0, -int(math.floor(math.log10(s) + 1e-9)))


def unit_of(key: str) -> str:
    prefix, p = key.split(".", 1)
    return IFS_UNITS[p] if prefix == "ifs" else PARAMS[p]["unit"]


# ================================================================== encoding (tested)
def encode_int16(values: list[float | None], scale: float) -> tuple[str, int]:
    """[value | None] -> (base64 of Int16 little-endian, number of clipped values). None / NaN -> −32768."""
    a = array("h", [INT16_MISSING]) * len(values)
    clipped = 0
    for i, v in enumerate(values):
        if v is None or (isinstance(v, float) and math.isnan(v)):
            continue
        q = int(round(v / scale))
        if q > INT16_MAX or q < -INT16_MAX:
            clipped += 1
            q = max(-INT16_MAX, min(INT16_MAX, q))
        a[i] = q
    if sys.byteorder == "big":
        a.byteswap()
    return base64.b64encode(a.tobytes()).decode("ascii"), clipped


def decode_int16(b64: str, scale: float) -> list[float | None]:
    """Inverse of encode_int16 (what Hist.series() does in the page)."""
    a = array("h")
    a.frombytes(base64.b64decode(b64))
    if sys.byteorder == "big":
        a.byteswap()
    return [None if q == INT16_MISSING else q * scale for q in a]


def sector_of(deg: float, sectors: int = ROSE_SECTORS) -> int:
    """Wind-from direction -> sector index, sector k centred on k·(360/sectors) (0 = N, 4 = E for 16 sectors).
    Sector 0 covers [−11.25°, 11.25°) for 16 sectors; the upper edge belongs to the next sector."""
    w = 360.0 / sectors
    return int(((deg % 360.0) + w / 2) // w) % sectors


# ================================================================== local calendar (cached per hour)
class Calendar:
    """Local (Europe/Zagreb) calendar facts of hour-ending stamps, computed once per stamp."""

    def __init__(self):
        self._c: dict[int, tuple[int, int, int, str, dt.date]] = {}

    def __call__(self, t_end: int) -> tuple[int, int, int, str, dt.date]:
        """-> (year, month 1..12, hour-start 0..23, day type, local date of the hour start)."""
        c = self._c.get(t_end)
        if c is None:
            ls = hour_start_local(t_end)
            wd = ls.weekday()
            c = (ls.year, ls.month, ls.hour, "sunday" if wd == 6 else "saturday" if wd == 5 else "weekday", ls.date())
            self._c[t_end] = c
        return c


def hours_in_local_year(year: int) -> int:
    return int((local_midnight_utc(dt.date(year + 1, 1, 1)) - local_midnight_utc(dt.date(year, 1, 1))).total_seconds()
               // 3600)


def _rnd(x: float | None, nd: int) -> float | None:
    return None if x is None else round(x, nd)


def _mean(s: float, n: int) -> float | None:
    return s / n if n else None


# ================================================================== statistics (tested on a tiny fixture)
def annual_stats(series: dict[int, float], cal: Calendar, last_full_year: int, nd: int
                 ) -> tuple[dict[str, float], dict[str, float]]:
    """-> (annual means of complete years with >= 75 % coverage, coverage % per year incl. the running year)."""
    s: dict[int, float] = defaultdict(float)
    n: dict[int, int] = defaultdict(int)
    for t, v in series.items():
        y = cal(t)[0]
        s[y] += v
        n[y] += 1
    means, cover = {}, {}
    for y in sorted(n):
        hy = hours_in_local_year(y)
        cover[str(y)] = round(100.0 * n[y] / hy, 1)
        if y <= last_full_year and n[y] >= ANNUAL_MIN_COVERAGE * hy:
            means[str(y)] = round(s[y] / n[y], nd)
    return means, cover


def diurnal_stats(series: dict[int, float], cal: Calendar, nd: int) -> dict[str, list[float | None]]:
    s = {k: [0.0] * 24 for k in ("weekday", "saturday", "sunday")}
    n = {k: [0] * 24 for k in s}
    for t, v in series.items():
        _y, _m, h, typ, _d = cal(t)
        s[typ][h] += v
        n[typ][h] += 1
    return {k: [_rnd(_mean(s[k][h], n[k][h]), nd) for h in range(24)] for k in s}


def monthly_stats(series: dict[int, float], cal: Calendar, nd: int) -> list[float | None]:
    s, n = [0.0] * 12, [0] * 12
    for t, v in series.items():
        m = cal(t)[1] - 1
        s[m] += v
        n[m] += 1
    return [_rnd(_mean(s[m], n[m]), nd) for m in range(12)]


def rose_stats(series: dict[int, float], wd: dict[int, float], u: dict[int, float], nd: int) -> dict:
    """Mean of the series by IFS wind-from sector; hours with U10 < ROSE_U_MIN go to 'calm'."""
    s, n = [0.0] * ROSE_SECTORS, [0] * ROSE_SECTORS
    cs, cn = 0.0, 0
    for t, v in series.items():
        d, sp = wd.get(t), u.get(t)
        if sp is None:
            continue
        if sp < ROSE_U_MIN or d is None:
            cs += v
            cn += 1
            continue
        k = sector_of(d)
        s[k] += v
        n[k] += 1
    return {"sectors": ROSE_SECTORS, "mean": [_rnd(_mean(s[k], n[k]), nd) for k in range(ROSE_SECTORS)], "n": n,
            "calm": {"mean": _rnd(_mean(cs, cn), nd), "n": cn}, "u_min": ROSE_U_MIN}


def daily_means(series: dict[int, float], cal: Calendar) -> dict[dt.date, float]:
    """Local-day means (hour starts 00..23 = ISZZ labels 01:00..24:00) with >= DAILY_MIN_HOURS values."""
    s: dict[dt.date, float] = defaultdict(float)
    n: dict[dt.date, int] = defaultdict(int)
    for t, v in series.items():
        d = cal(t)[4]
        s[d] += v
        n[d] += 1
    return {d: s[d] / n[d] for d in s if n[d] >= DAILY_MIN_HOURS}


def exceedance_stats(z1: dict[str, dict[int, float]], cal: Calendar) -> tuple[dict, dict]:
    """-> ({key: {year: count}}, {"<param>_<avg>": {year: valid hours or days}})."""
    counts: dict[str, dict[str, int]] = {}
    valid: dict[str, dict[str, int]] = {}
    days_cache: dict[str, dict[dt.date, float]] = {}
    for key, p, avg, limit in EXCEEDANCES:
        series = z1.get(p, {})
        c: dict[str, int] = defaultdict(int)
        nv: dict[str, int] = defaultdict(int)
        if avg == "1h":
            for t, v in series.items():
                y = str(cal(t)[0])
                nv[y] += 1
                c[y] += v > limit
        else:
            days = days_cache.setdefault(p, daily_means(series, cal))
            for d, v in days.items():
                y = str(d.year)
                nv[y] += 1
                c[y] += v > limit
        counts[key] = {y: int(c[y]) for y in sorted(nv)}
        valid[f"{p}_{avg}"] = {y: nv[y] for y in sorted(nv)}
    return counts, valid


def reference_exceedances(ref_rows: list[tuple[dt.date, int, str, float, int]]) -> tuple[dict, dict]:
    """Counts of gravimetric days above the limits, per year: ({key: {year: n}}, {"pm10_24h_ref": {year: days}})."""
    counts: dict[str, dict[str, int]] = {}
    valid: dict[str, dict[str, int]] = {}
    for key, p, limit in REFERENCE_EXCEEDANCES:
        days = [(d, v) for d, st, q, v, _f in ref_rows if q == p and st == STATION_ID]
        years = sorted({str(d.year) for d, _v in days})
        counts[key] = {y: sum(1 for d, v in days if str(d.year) == y and v > limit) for y in years}
        valid[f"{p}_24h_ref"] = {y: sum(1 for d, _v in days if str(d.year) == y) for y in years}
    return counts, valid


def paired_increment(a: dict[int, float], b: dict[int, float]) -> dict[int, float]:
    """Hourly Z1 − Z4 where both stations have a value."""
    return {t: v - b[t] for t, v in a.items() if t in b}


# ================================================================== plausibility
# Physical limits for the station's meteorological sensors. Values outside them are instrument or transmission errors
# (e.g. raw z1.ws of 127.6, 57.0 and 219.5 m/s in May–June 2024, found in the data review of 2026-09-28). They are
# dropped before any statistic, and the counts are reported in meta.sources.plausibility. Pollutant concentrations
# are NOT filtered: small negative raw values are normal analyser noise around zero, and high values are real episodes.
# 40 m/s as an HOURLY MEAN is far above anything recorded in Zagreb (the strongest gusts on record are ~30 m/s).
PLAUSIBLE = {"ws": (0.0, 40.0), "wd": (0.0, 360.0), "t": (-40.0, 50.0), "rh": (0.0, 100.5)}
DROPPED: dict[str, int] = {}


def plausible(key: str, s: dict[int, float]) -> dict[int, float]:
    """Drop values outside PLAUSIBLE for station keys like 'z1.ws'; record how many were dropped in DROPPED."""
    lim = PLAUSIBLE.get(key.split(".", 1)[1]) if key.startswith(("z1.", "z4.")) else None
    if not lim:
        return s
    lo, hi = lim
    out = {t: v for t, v in s.items() if lo <= v <= hi}
    if len(out) != len(s):
        DROPPED[key] = len(s) - len(out)
        log.warning("%s: dropped %d implausible values outside [%g, %g]", key, len(s) - len(out), lo, hi)
    return out


def load_inputs(iszz_csv: Path, ifs_csv: Path) -> tuple[dict[str, dict[int, float]], dict[str, int | None]]:
    """-> ({key: {t_end ms: value}} for z1.*, z4.*, ifs.*, inc.*), {key: last validated t or None})."""
    table = read_processed(iszz_csv)
    if not table:
        raise SystemExit(f"{iszz_csv} is missing or empty: run tools/fetch_iszz.py first")
    prefix = {v: k for k, v in STATIONS.items()}
    data: dict[str, dict[int, float]] = {}
    validated_until: dict[str, int | None] = {}
    for (st, p), rows in table.items():
        if st not in prefix:
            continue
        key = f"{prefix[st]}.{p}"
        data[key] = plausible(key, {t: v for t, v, _f in rows})
        vt = [t for t, _v, f in rows if f == 1]
        validated_until[key] = max(vt) if vt else None
    if not ifs_csv.exists():
        raise SystemExit(f"{ifs_csv} is missing: run tools/fetch_meteo.py first")
    for col, s in read_ifs(ifs_csv).items():
        data[f"ifs.{col}"] = s
    for p in INC_PARAMS:
        data[f"inc.{p}"] = paired_increment(data.get(f"z1.{p}", {}), data.get(f"z4.{p}", {}))
    for key, s in data.items():
        bad = [t for t in s if t % HOUR_MS]
        if bad:
            raise SystemExit(f"{key}: {len(bad)} stamps are not on the hour, e.g. {bad[0]}")
    return data, validated_until


def build(data: dict[str, dict[int, float]], validated_until: dict[str, int | None], days: int,
          period_start: dt.date, sources: dict, ref_rows: list | None = None) -> dict:
    cal = Calendar()
    meas_keys = [k for k in data if k.startswith(("z1.", "z4."))]
    t_last = max(max(data[k]) for k in meas_keys if data[k])
    n = days * 24
    t0 = t_last - (n - 1) * HOUR_MS
    today_local = cal(t_last)[4]
    last_full_year = today_local.year - 1
    log.info("series: %d h from %s to %s (hour-ending UTC)", n, _iso(t0), _iso(t_last))

    # ---- series (architecture §4.2)
    series, scale, clipped = {}, {}, {}
    for key in KEYS:
        s = data.get(key, {})
        vals = [s.get(t0 + i * HOUR_MS) for i in range(n)]
        series[key], clipped[key] = encode_int16(vals, scale_of(key))
        scale[key] = scale_of(key)
        if clipped[key]:
            log.warning("%s: %d values clipped to the Int16 range", key, clipped[key])
        if key not in data:
            log.warning("%s: no data at all (series is all missing)", key)

    # ---- stats over the whole period
    stat_keys = [k for k in KEYS if k not in DIRECTIONAL] + [f"inc.{p}" for p in INC_PARAMS]
    nd = {k: decimals_of(k if not k.startswith("inc.") else "z1." + k[4:]) for k in stat_keys + ROSE_KEYS}
    annual, cover_year, diurnal, monthly = {}, {}, {}, {}
    for k in stat_keys:
        s = data.get(k, {})
        annual[k], cover_year[k] = annual_stats(s, cal, last_full_year, nd[k])
        diurnal[k] = diurnal_stats(s, cal, nd[k])
        monthly[k] = monthly_stats(s, cal, nd[k])
    rose = {k: rose_stats(data.get(k, {}), data.get("ifs.wd10", {}), data.get("ifs.u10", {}), nd[k])
            for k in ROSE_KEYS}
    z1 = {k[3:]: v for k, v in data.items() if k.startswith("z1.")}
    exceed, exceed_n = exceedance_stats(z1, cal)
    ref_counts, ref_valid = reference_exceedances(ref_rows or [])
    exceed.update(ref_counts)
    exceed_n.update(ref_valid)

    lo = int(local_midnight_utc(period_start).timestamp() * 1000)
    period_hours = max(1, (t_last - lo) // HOUR_MS)
    coverage = {k: round(100.0 * sum(1 for t in data.get(k, {}) if lo < t <= t_last) / period_hours, 1)
                for k in KEYS + [f"inc.{p}" for p in INC_PARAMS]}

    # increment: the latest ended year in which the NOx increment has >= 75 % paired coverage
    inc_year = max((int(y) for y in annual.get("inc.nox", {})), default=None)
    increment = {p: annual[f"inc.{p}"].get(str(inc_year)) if inc_year else None for p in INC_PARAMS}

    # year-to-date means of the running year (annual[] holds complete years only)
    ytd_year = today_local.year
    ytd = {"year": ytd_year, "through": today_local.isoformat(), "mean": {}, "coverage": {}}
    ytd_hours = (t_last - int(local_midnight_utc(dt.date(ytd_year, 1, 1)).timestamp() * 1000)) // HOUR_MS
    for k in stat_keys:
        vals = [v for t, v in data.get(k, {}).items() if cal(t)[0] == ytd_year]
        ytd["mean"][k] = _rnd(sum(vals) / len(vals), nd[k]) if vals else None
        ytd["coverage"][k] = round(100.0 * len(vals) / ytd_hours, 1) if ytd_hours else 0.0

    latest = {}
    for k in KEYS + [f"inc.{p}" for p in INC_PARAMS]:
        s = data.get(k, {})
        if s:
            t = max(s)
            latest[k] = {"t": t, "v": round(s[t], decimals_of(k if not k.startswith("inc.") else "z1." + k[4:]))}

    first_local = period_start.isoformat()
    meta = {
        "generated_utc": utcnow_iso(), "station": STATION_ID, "background": BACKGROUND_ID, "model": MODEL,
        "t0": t0, "n": n,
        "attribution": [SITE["attribution"]["iszz"], SITE["attribution"]["openmeteo"]],
        # additive fields (docs/01-data-sources.md §5):
        "time": "epoch ms UTC, hour-ending (a value at t is the mean of [t-1h, t])",
        "missing": INT16_MISSING,
        "units": {k: unit_of(k if not k.startswith("inc.") else "z1." + k[4:])
                  for k in KEYS + [f"inc.{p}" for p in INC_PARAMS]},
        "validated_until": {k: validated_until.get(k) for k in KEYS if not k.startswith("ifs.")},
        "sources": sources,
    }
    return {
        "meta": meta, "series": series, "scale": scale, "keys": KEYS,
        "stats": {
            "period": [first_local, today_local.isoformat()],
            "annual": annual, "diurnal": diurnal, "monthly": monthly, "rose": rose,
            "exceed": exceed, "coverage": coverage, "increment": increment,
            # additive fields:
            "increment_year": inc_year, "coverage_by_year": cover_year, "exceed_n": exceed_n, "ytd": ytd,
        },
        "latest": latest,
    }


def _iso(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def research_check(m: dict) -> list[str]:
    """Compare with the numbers of iszz-api §10 / critic §1.4 (printed; differences are explained in the docs)."""
    lines = []
    for (sect, key, year), want in RESEARCH_CHECK.items():
        got = m["stats"]["annual"].get(key, {}).get(year) if sect == "annual" else m["stats"]["increment"].get(key)
        diff = None if got is None else round(got - want, 2)
        lines.append(f"{sect:9s} {key:8s} {year or m['stats']['increment_year']}: {got} (research {want}, diff {diff})")
    return lines


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=SERIES_DAYS, help="days of hourly series to embed")
    ap.add_argument("--iszz", default=str(ISZZ_CSV))
    ap.add_argument("--ifs", default=str(IFS_CSV))
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args(argv)

    report = json.loads(ISZZ_REPORT.read_text(encoding="utf-8")) if ISZZ_REPORT.exists() else {}
    ifs_meta = json.loads(IFS_META.read_text(encoding="utf-8")) if IFS_META.exists() else {}
    period_start = dt.date.fromisoformat(report.get("period", {}).get("start", "2023-01-01"))
    sources = {"iszz": {"fetched_utc": report.get("generated_utc"), "export": SITE["iszz"]["export"],
                        "stations": {str(STATION_ID): SITE["station"]["name"],
                                     str(BACKGROUND_ID): SITE["background"]["name"]}},
               "ifs": {"fetched_utc": ifs_meta.get("generated_utc"), "grid_cell": ifs_meta.get("grid_cell"),
                       "api": SITE["openmeteo"]["archive"], "blh_coverage_pct": (ifs_meta.get("coverage_pct")
                                                                                   or {}).get("blh")}}
    data, vuntil = load_inputs(Path(a.iszz), Path(a.ifs))
    sources["plausibility"] = {"limits": PLAUSIBLE, "dropped": dict(DROPPED)}
    ref_rows = read_reference(ISZZ_REF)
    if not ref_rows:
        log.warning("%s missing: no gravimetric (reference-method) PM10 exceedance counts", ISZZ_REF.name)
    m = build(data, vuntil, a.days, period_start, sources, ref_rows)
    size = write_json(Path(a.out), m)
    for line in research_check(m):
        log.info("check %s", line)
    log.info("wrote %s: %.0f KB (%d keys x %d h + stats)", a.out, size / 1024, len(m["keys"]), m["meta"]["n"])
    if size > SIZE_BUDGET:
        log.error("measurements.json is %.2f MB, over the %.1f MB budget", size / 1e6, SIZE_BUDGET / 1e6)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
