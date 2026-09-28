#!/usr/bin/env python3
"""Fit β and U0 of the receptor model to ISZZ measurements -> src/data/calibration.json [owner: models].

    python3 tools/calibrate.py                     # 2025, data/processed/*.csv.gz, src/data/env.json (+ LUT if present)
    python3 tools/calibrate.py --period 2024-01-01 2025-12-31
    python3 tools/calibrate.py --dev               # research caches instead of data/processed (development only)
    python3 tools/calibrate.py --no-numpy          # force the pure-Python path (same results)

Protocol (critic §4.7, physics §10; docs/07-calibration.md is the long version):

1. Pairing. Observed increment ΔNOx_obs = NOx(ZAGREB-1) - NOx(ZAGREB-4), hour-ending UTC, validated where ISZZ has
   published it (the processed table already chooses validated over raw per year). Negative increments are kept
   (physics §10.1). Meteorology = ECMWF IFS hour-ending means (data/processed/ifs_hourly.csv.gz). A month enters only
   with >= 75 % of its hours paired (physics §10.1).
2. Model. For every hour: class = stability_class(IFS U10, SW, cloud); unit responses Γ_k smoothed over the 16 run
   directions (direction_weights); q_k = group_strengths('nox', t, today's measures, heating 'auto'); then
       ΔNOx_mod = 1e6 · β · Σ_k q_k Γ̃_k / √(U10² + U0²)                                      (physics Eq. 10.1)
   Γ comes from src/data/lut_receptor.json (the GPU LBM + scalar solver, model "lbm") when it exists, and always from
   the Gaussian fallback of tools/aqmodel.py (model "gauss"), which is what the app uses without a LUT.
3. Fit. J(β, U0) = Σ [ln(ΔC_obs + c0) - ln(ΔC_mod + c0)]², c0 = 10 µg/m³ (physics Eq. 10.2); U0 on a 0.05 m/s grid
   over [0.5, 3.0] m/s, β by golden-section search on ln β in [0.05, 50]. Hours with ΔC_obs <= -c0 cannot enter the
   log and are counted in `n_dropped_log`.
4. Validation, test data only. Two-fold split by half-year (train Jan–Jun / test Jul–Dec, and swapped) gives
   `metrics_test` on the union of the two test halves; leave-one-month-out gives `metrics_lomo`. The published β, U0
   are fitted on the whole period; the metrics never see their own training hours.
5. Baseline (physics §10.5, recomputed with ZAGREB-4 and IFS as critic G11 asks): ΔC = P(day type, local hour) ·
   S(IFS sector) / √(U² + 1.2²), P = median of ΔC·U_eff per (day type, hour), S = median of ΔC·U_eff / P per
   sector, fitted on the training half and scored exactly like the model.
6. Diagnostics on the test predictions: mean obs / mean mod by 16 IFS sectors (U > 1.5 m/s), by local hour, by
   class, by wind-speed bin and by month; end-to-end NO2 (chemistry with the ZAGREB-4 background) and its FAIRMODE
   MQI; the chemistry-only check with measured NOx (critic §1.2); the climatological congestion shares φ_A, φ_B.

Idempotent: the output is rewritten only when its content (everything except `generated_utc`) changes; the
results block of docs/07-calibration.md (between its CALIBRATION-RESULTS markers) is regenerated from it.
numpy is optional (architecture §3) and only speeds up the fit.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
import os
import statistics
import sys
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))
import aqmodel as M  # noqa: E402
from common import PROCESSED, ROOT, SITE, SRC_DATA, log, utcnow_iso, write_json  # noqa: E402

try:  # optional speed-up
    import numpy as np  # type: ignore
except Exception:  # pragma: no cover - numpy is optional
    np = None

# Development-only fallback inputs: the research caches of docs/research/ (not part of the repo). Override with the
# environment variable Z1_RESEARCH_DATA; the default is where the research agents left them on the build machine.
RESEARCH = Path(os.environ.get("Z1_RESEARCH_DATA", "/tmp/claude-1001/-home-valentino-lidar-zagreb-test/"
                               "3f3f8e4e-26fc-4ba8-bbdf-26d040362cb2/scratchpad/research/data"))
C0 = 10.0                           # µg/m³, log-objective offset (physics Eq. 10.2)
U0_GRID = [round(0.5 + 0.05 * i, 2) for i in range(51)]   # 0.50 .. 3.00 m/s (critic §4.5 range 1.0–2.0, widened)
LNB_RANGE = (math.log(0.05), math.log(50.0))               # β search range (critic §4.5: 0.5–8, widened)
BASELINE_U0 = 1.2                   # m/s, the baseline's fixed floor (physics §10.5)
CAPTURE_MIN = 0.75                  # monthly data capture (physics §10.1)
SECTOR_U_MIN = 1.5                  # m/s, rose diagnostics only above this speed (physics §10.6)
MIN_N_DIAG = 30                     # hours per diagnostic bin before a ratio is reported
F_NO2 = SITE["model_defaults"]["f_no2"]
H_MIN = SITE["model_defaults"]["h_min_m"]


# ------------------------------------------------------------------ data
def _f(s: str | None) -> float:
    try:
        v = float(s)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return math.nan
    return v if math.isfinite(v) else math.nan


def load_processed(iszz_path: Path, ifs_path: Path, t0: str, t1: str) -> tuple[dict, dict]:
    """Hourly dicts keyed by epoch ms (hour-ending UTC) from the meas-data owner's processed tables."""
    z = {155: "z1", 303: "z4"}
    obs: dict[float, dict] = {}
    with gzip.open(iszz_path, "rt", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            ts = r["t_utc_end"]
            if not (t0 <= ts <= t1):
                continue
            st = z.get(int(r["station"]))
            if st is None:
                continue
            obs.setdefault(M.to_ms(ts), {})[f"{st}.{r['param']}"] = _f(r["value"])
    met: dict[float, dict] = {}
    with gzip.open(ifs_path, "rt", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            ts = r["t_utc_end"]
            if not (t0 <= ts <= t1):
                continue
            met[M.to_ms(ts)] = {k: _f(r.get(k)) for k in ("u10", "wd10", "blh", "t2", "cc", "sw")}
    return obs, met


def load_dev(t0: str, t1: str) -> tuple[dict, dict]:
    """Development fallback: research caches (ZAGREB-1 csv, ZAGREB-4 2025 JSON, Open-Meteo best_match = IFS 2025)."""
    obs: dict[float, dict] = {}
    with open(RESEARCH / "zagreb1_hourly.csv", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            ts = r["timestamp_utc"]
            if t0 <= ts <= t1:
                obs.setdefault(M.to_ms(ts), {})[f"z1.{'c6h6' if r['param'] == 'benzene' else r['param']}"] = _f(r["value"])
    for code, key in ((38, "nox"), (1, "no2"), (31, "o3"), (5, "pm10"), (28, "pm25")):
        j = json.loads((RESEARCH / "physics" / "iszz" / f"303_{code}_1_2025.json").read_text())
        for tm, v in zip(j["t_ms"], j["v"]):
            if v is not None and v > -900:
                obs.setdefault(float(tm), {})[f"z4.{key}"] = float(v)
    om = json.loads((RESEARCH / "physics" / "openmeteo_archive_2025.json").read_text())["hourly"]
    met: dict[float, dict] = {}
    prev = None
    for i, ts in enumerate(om["time"]):
        cur = {k: om[k][i] for k in ("wind_speed_10m", "wind_direction_10m", "boundary_layer_height", "temperature_2m",
                                      "cloud_cover", "shortwave_radiation")}
        tm = M.to_ms(ts + "Z")
        if prev is not None:
            w = M.vector_mean_wind([{"u": prev["wind_speed_10m"], "dir": prev["wind_direction_10m"]},
                                    {"u": cur["wind_speed_10m"], "dir": cur["wind_direction_10m"]}])
            avg = lambda k: (prev[k] + cur[k]) / 2 if prev[k] is not None and cur[k] is not None else math.nan  # noqa: E731
            met[tm] = {"u10": w["u"], "wd10": w["dir"], "blh": avg("boundary_layer_height"), "t2": avg("temperature_2m"),
                       "cc": avg("cloud_cover"), "sw": _f(cur["shortwave_radiation"])}
        prev = cur
    return obs, met


# ------------------------------------------------------------------ hours
def build_hours(obs: dict, met: dict, t0: str, t1: str) -> tuple[list[dict], dict]:
    """Paired hours with ΔNOx_obs and IFS met, restricted to months with >= 75 % capture."""
    hours = []
    for tm in sorted(obs):
        o, m = obs[tm], met.get(tm)
        if m is None:
            continue
        z1, z4 = o.get("z1.nox", math.nan), o.get("z4.nox", math.nan)
        if not (math.isfinite(z1) and math.isfinite(z4) and math.isfinite(m["u10"]) and math.isfinite(m["wd10"])):
            continue
        lp = M.local_parts(tm)
        hours.append({"t": tm, "obs": z1 - z4, "u": m["u10"], "dir": m["wd10"], "sw": m["sw"], "cc": m["cc"], "t2": m["t2"],
                      "blh": m["blh"], "month": _utc_month(tm),
                      "lhour": lp["hour"], "dtype": M.day_type(lp), "o": o})
    # monthly capture (calendar months of the UTC hour-ending stamp minus 1 h, i.e. the hour start)
    cap: dict[int, int] = {}
    for h in hours:
        cap[h["month"]] = cap.get(h["month"], 0) + 1
    y0, y1 = int(t0[:4]), int(t1[:4])
    keep, report = set(), {}
    for mkey, n in sorted(cap.items()):
        y, mo = divmod(mkey, 100)
        days = [31, 29 if (y % 4 == 0 and y % 100 != 0) or y % 400 == 0 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
        frac = n / (24 * days)
        report[f"{y}-{mo:02d}"] = round(frac, 3)
        if frac >= CAPTURE_MIN and y0 <= y <= y1:
            keep.add(mkey)
    return [h for h in hours if h["month"] in keep], report


def _utc_month(tm: float) -> int:
    """yyyymm of the hour START in UTC (month of the averaging interval)."""
    import datetime as dt
    d = dt.datetime.fromtimestamp((tm - 3600e3) / 1000, tz=dt.timezone.utc)
    return d.year * 100 + d.month


# ------------------------------------------------------------------ unit responses per hour
def source_terms(hours: list[dict], rows_for: Callable[[str], list[dict]]) -> None:
    """Adds h['S'] = Σ q_k Γ̃_k (β = 1, before 1/U_eff) and h['qg'] (queue shares) for one Γ source."""
    for h in hours:
        cls = M.stability_class(h["u"], h["sw"], h["cc"], h["t"])
        h["cls"] = cls
        ga = M.smooth_gamma(rows_for(cls), h["dir"], h["u"])
        q = M.group_strengths("nox", h["t"], {}, "auto")
        h["S"] = sum(q[g] * ga["gamma"][k] for k, g in enumerate("ABCD"))
        h["ga"] = ga
        h["q"] = q


def gauss_rows(env: dict) -> Callable[[str], list[dict]]:
    fb = M.FallbackModel(env, h_min=H_MIN)
    log.info("gauss: %d point sources, intersection centre %s, canyons %s", fb.src["n"],
             [round(v, 1) for v in fb.center] if fb.center else None, [bool(c) for c in fb.canyons])
    table = M.gamma_table(fb)
    return lambda cls: table[M.met_class(cls)]


def lut_rows(lut: dict) -> Callable[[str], list[dict]]:
    classes = lut["classes"]
    if [float(d) for d in lut["dirs"]] != M.DIRS16:
        raise SystemExit("lut_receptor.json: dirs must be the 16 directions 0, 22.5, ... (architecture §4.4)")
    rows = {g: [{"gamma": lut["gamma"][j][classes.index(g)], "age": lut["age"][j][classes.index(g)]} for j in range(16)]
            for g in classes}
    return lambda cls: rows[M.stability_group(cls)]


# ------------------------------------------------------------------ fit
def _prep(hours: Sequence[dict]):
    S = [h["S"] for h in hours]
    u2 = [h["u"] * h["u"] for h in hours]
    lo = [math.log(h["obs"] + C0) if h["obs"] > -C0 else math.nan for h in hours]
    if np is not None:
        return np.array(S), np.array(u2), np.array(lo)
    return S, u2, lo


def _objective(S, u2, lo, beta: float, U0: float) -> float:
    if np is not None:
        m = 1e6 * beta * S / np.sqrt(u2 + U0 * U0)
        d = lo - np.log(m + C0)
        return float(np.nansum(d * d))
    s = 0.0
    for Si, ui, li in zip(S, u2, lo):
        if li == li:
            d = li - math.log(1e6 * beta * Si / math.sqrt(ui + U0 * U0) + C0)
            s += d * d
    return s


def _golden(f: Callable[[float], float], a: float, b: float, tol: float = 1e-4) -> float:
    g = (math.sqrt(5) - 1) / 2
    c, d = b - g * (b - a), a + g * (b - a)
    fc, fd = f(c), f(d)
    while b - a > tol:
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - g * (b - a)
            fc = f(c)
        else:
            a, c, fc = c, d, fd
            d = a + g * (b - a)
            fd = f(d)
    return (a + b) / 2


def fit(hours: Sequence[dict]) -> dict:
    """β, U0 minimising the log objective (physics Eq. 10.2)."""
    S, u2, lo = _prep(hours)
    best = (math.inf, 1.0, M.MD["U0"])
    for U0 in U0_GRID:
        # coarse bracket on ln β, then golden refinement
        grid = [LNB_RANGE[0] + (LNB_RANGE[1] - LNB_RANGE[0]) * i / 40 for i in range(41)]
        vals = [_objective(S, u2, lo, math.exp(x), U0) for x in grid]
        i = min(range(len(vals)), key=vals.__getitem__)
        a, b = grid[max(0, i - 1)], grid[min(len(grid) - 1, i + 1)]
        lb = _golden(lambda x: _objective(S, u2, lo, math.exp(x), U0), a, b)
        J = _objective(S, u2, lo, math.exp(lb), U0)
        if J < best[0]:
            best = (J, math.exp(lb), U0)
    J, beta, U0 = best
    return {"beta": beta, "U0": U0, "J": J, "n": len(hours), "n_dropped_log": sum(1 for h in hours if h["obs"] <= -C0),
            "U0_at_bound": U0 in (U0_GRID[0], U0_GRID[-1])}


def predict(hours: Sequence[dict], beta: float, U0: float) -> list[float]:
    return [1e6 * beta * h["S"] / math.sqrt(h["u"] * h["u"] + U0 * U0) for h in hours]


# ------------------------------------------------------------------ baseline (physics §10.5)
def _sector(d: float) -> int:
    return M.dir_index16(d)


def baseline_fit(train: Sequence[dict]) -> dict:
    P: dict[tuple, list] = {}
    for h in train:
        ue = math.sqrt(h["u"] ** 2 + BASELINE_U0 ** 2)
        P.setdefault((h["dtype"], h["lhour"]), []).append(h["obs"] * ue)
    Pm = {k: statistics.median(v) for k, v in P.items()}
    Sx: dict[int, list] = {}
    for h in train:
        p = Pm.get((h["dtype"], h["lhour"]))
        if p and p > 0:
            ue = math.sqrt(h["u"] ** 2 + BASELINE_U0 ** 2)
            Sx.setdefault(_sector(h["dir"]), []).append(h["obs"] * ue / p)
    Sm = {k: statistics.median(v) for k, v in Sx.items()}
    return {"P": Pm, "S": Sm}


def baseline_predict(b: dict, hours: Sequence[dict]) -> list[float]:
    out = []
    for h in hours:
        p, s = b["P"].get((h["dtype"], h["lhour"])), b["S"].get(_sector(h["dir"]))
        out.append(p * s / math.sqrt(h["u"] ** 2 + BASELINE_U0 ** 2) if p is not None and s is not None else math.nan)
    return out


# ------------------------------------------------------------------ cross-validation
def _half(h: dict) -> int:
    return 0 if h["month"] % 100 <= 6 else 1


def crossval(hours: list[dict]) -> dict:
    """Two half-year folds and leave-one-month-out for the physics model and the baseline."""
    pred = [math.nan] * len(hours)
    pred_u0 = [math.nan] * len(hours)   # U0 of the fold that predicted each test hour (for τ in totals())
    base = [math.nan] * len(hours)
    folds = []
    for test_half in (1, 0):
        tr = [h for h in hours if _half(h) != test_half]
        te_idx = [i for i, h in enumerate(hours) if _half(h) == test_half]
        if not tr or not te_idx:
            continue
        p = fit(tr)
        b = baseline_fit(tr)
        te = [hours[i] for i in te_idx]
        for i, v in zip(te_idx, predict(te, p["beta"], p["U0"])):
            pred[i] = v
            pred_u0[i] = p["U0"]
        for i, v in zip(te_idx, baseline_predict(b, te)):
            base[i] = v
        folds.append({"train": "Jan–Jun" if test_half == 1 else "Jul–Dec", "test": "Jul–Dec" if test_half == 1 else "Jan–Jun",
                      "beta": round(p["beta"], 3), "U0": p["U0"], "n_train": p["n"], "n_test": len(te_idx),
                      "metrics_test": _round(M.metrics([hours[i]["obs"] for i in te_idx], [pred[i] for i in te_idx]))})
    lomo = [math.nan] * len(hours)
    lomo_b = [math.nan] * len(hours)
    lomo_params = {}
    for mkey in sorted({h["month"] for h in hours}):
        tr = [h for h in hours if h["month"] != mkey]
        te_idx = [i for i, h in enumerate(hours) if h["month"] == mkey]
        p = fit(tr)
        b = baseline_fit(tr)
        te = [hours[i] for i in te_idx]
        for i, v in zip(te_idx, predict(te, p["beta"], p["U0"])):
            lomo[i] = v
        for i, v in zip(te_idx, baseline_predict(b, te)):
            lomo_b[i] = v
        lomo_params[f"{mkey // 100}-{mkey % 100:02d}"] = {"beta": round(p["beta"], 3), "U0": p["U0"]}
    return {"pred": pred, "pred_U0": pred_u0, "base": base, "lomo": lomo, "lomo_base": lomo_b, "folds": folds, "lomo_params": lomo_params}


# ------------------------------------------------------------------ diagnostics
def _ratio(obs: Iterable[float], mod: Iterable[float]) -> float | None:
    o, m = [], []
    for a, b in zip(obs, mod):
        if math.isfinite(a) and math.isfinite(b):
            o.append(a)
            m.append(b)
    if len(o) < MIN_N_DIAG or sum(m) <= 0:
        return None
    return round(sum(o) / sum(m), 3)


def diagnostics(hours: list[dict], pred: list[float]) -> dict:
    def by(key: Callable[[dict], Any], keys: Iterable[Any], cond: Callable[[dict], bool] = lambda h: True):
        out = []
        for k in keys:
            idx = [i for i, h in enumerate(hours) if cond(h) and key(h) == k]
            out.append(_ratio([hours[i]["obs"] for i in idx], [pred[i] for i in idx]))
        return out
    speed_bins = [(0, 0.5), (0.5, 1), (1, 2), (2, 3), (3, 5), (5, 99)]
    return {
        "by_sector": by(lambda h: _sector(h["dir"]), range(16), lambda h: h["u"] > SECTOR_U_MIN),
        "by_hour": by(lambda h: h["lhour"], range(24)),
        "by_class": dict(zip(M.MET_CLASSES, by(lambda h: h["cls"], M.MET_CLASSES))),
        "by_speed": {f"{a}-{b if b < 99 else '∞'}": r for (a, b), r in
                     zip(speed_bins, by(lambda h: next(i for i, (a, b) in enumerate(speed_bins) if a <= h["u"] < b), range(6)))},
        "by_month": {f"{m // 100}-{m % 100:02d}": r for m, r in
                     zip(sorted({h["month"] for h in hours}), by(lambda h: h["month"], sorted({h["month"] for h in hours})))},
        "by_daytype": dict(zip(("weekday", "saturday", "sunday"), by(lambda h: h["dtype"], ("weekday", "saturday", "sunday")))),
    }


def totals(hours: list[dict], pred: list[float], U0: float | Sequence[float]) -> dict:
    """End-to-end NO2 and NOx at ZAGREB-1 with the ZAGREB-4 background (test predictions).

    U0 is one value or, for held-out predictions, one per hour: the U0 of the fold that predicted it, so that the plume
    age τ of a test hour never uses a U0 fitted on that hour (review 2026-09-28: it used the whole-period U0).
    """
    o_no2, m_no2, o_nox, m_nox = [], [], [], []
    u0s = list(U0) if isinstance(U0, (list, tuple)) else [U0] * len(hours)
    for h, inc, u0 in zip(hours, pred, u0s):
        z = h["o"]
        if not (math.isfinite(inc) and all(math.isfinite(z.get(k, math.nan)) for k in ("z1.no2", "z4.no2", "z4.nox", "z4.o3"))):
            continue
        tau = _tau(h, u0)
        r = M.no2_chemistry(inc, z["z4.no2"], z["z4.nox"], z["z4.o3"], tau, M.j_no2(h["sw"]), M.k_no_o3(h["t2"]), F_NO2)
        o_no2.append(z["z1.no2"])
        m_no2.append(r["no2"])
        o_nox.append(z["z1.nox"])
        m_nox.append(r["nox"])
    return {"no2": {**_round(M.metrics(o_no2, m_no2)), "MQI": round(M.mqi(o_no2, m_no2, "no2"), 3)},
            "nox": _round(M.metrics(o_nox, m_nox))}


def _tau(h: dict, U0: float) -> float:
    ga, q = h["ga"], h["q"]
    num = sum(q[g] * ga["age"][k] for k, g in enumerate("ABCD"))
    den = sum(q[g] * ga["gamma"][k] for k, g in enumerate("ABCD"))
    # τ = Σ q A / (U_eff Σ q Γ) with the fitted U0 (β cancels; physics Eq. 5.8)
    return num / (M.u_eff(h["u"], U0) * den) if den > 0 else M.CHEM_TAU_DEFAULT


def chemistry_check(hours: list[dict]) -> dict:
    """Chemistry alone with MEASURED NOx (critic §1.2): f = 0.10, τ = 60 s, ZAGREB-4 background."""
    o, m = [], []
    for h in hours:
        z = h["o"]
        if not all(math.isfinite(z.get(k, math.nan)) for k in ("z1.nox", "z1.no2", "z4.no2", "z4.nox", "z4.o3")):
            continue
        if not (math.isfinite(h["sw"]) and math.isfinite(h["t2"])):
            continue
        r = M.no2_chemistry(z["z1.nox"] - z["z4.nox"], z["z4.no2"], z["z4.nox"], z["z4.o3"], M.CHEM_TAU_DEFAULT,
                            M.j_no2(h["sw"]), M.k_no_o3(h["t2"]), F_NO2)
        o.append(z["z1.no2"])
        m.append(r["no2"])
    mm = M.metrics(o, m)
    return {"f_no2": F_NO2, "tau_s": M.CHEM_TAU_DEFAULT, "n": mm["n"], "mean_obs": round(mm["meanObs"], 2),
            "mean_mod": round(mm["meanMod"], 2), "RMSE": round(mm["RMSE"], 2), "R": round(mm["R"], 3),
            "FB": round(mm["FB"], 3), "MQI": round(M.mqi(o, m, "no2"), 3)}


def congestion_share(hours: list[dict]) -> dict:
    """Climatological φ_k = Γ_queue/Γ over weekday rush hours (EM_CONGESTION.hours), Γ-weighted."""
    num = {"A": 0.0, "B": 0.0}
    den = {"A": 0.0, "B": 0.0}
    for h in hours:
        if h["dtype"] != "weekday" or h["lhour"] not in M.EM_CONGESTION["hours"]:
            continue
        for k, g in ((0, "A"), (1, "B")):
            num[g] += h["ga"]["queue"][k]
            den[g] += h["ga"]["gamma"][k]
    return {g: round(num[g] / den[g], 3) if den[g] > 0 else M.EM_CONGESTION["share"][g] for g in ("A", "B")}


def _round(m: dict, nd: int = 4) -> dict:
    return {k: (round(v, nd) if isinstance(v, float) and math.isfinite(v) else (None if isinstance(v, float) else v))
            for k, v in m.items()}


# ------------------------------------------------------------------ one model
def calibrate_model(name: str, hours: list[dict], rows_for: Callable[[str], list[dict]]) -> dict:
    source_terms(hours, rows_for)
    full = fit(hours)
    cv = crossval(hours)
    obs = [h["obs"] for h in hours]
    res = {
        "model": name, "beta": round(full["beta"], 3), "U0": full["U0"], "U0_at_bound": full["U0_at_bound"],
        "n": full["n"], "n_dropped_log": full["n_dropped_log"],
        "metrics_test": _round(M.metrics(obs, cv["pred"])),
        "metrics_lomo": _round(M.metrics(obs, cv["lomo"])),
        "baseline_test": _round(M.metrics(obs, cv["base"])),
        "baseline_lomo": _round(M.metrics(obs, cv["lomo_base"])),
        "raw_physics_test": _round(M.metrics(obs, predict(hours, 1.0, M.MD["U0"]))),
        "folds": cv["folds"], "lomo_params": cv["lomo_params"],
        "totals_test": totals(hours, cv["pred"], cv["pred_U0"]),
        "mean_obs": round(statistics.fmean(obs), 2),
        "mean_mod_raw": round(statistics.fmean(predict(hours, 1.0, M.MD["U0"])), 2),
        **diagnostics(hours, cv["pred"]),
    }
    res["baseline_diag"] = {"by_hour": diagnostics(hours, cv["base"])["by_hour"]}
    log.info("%s: beta %.3f U0 %.2f  test FB %.3f NMSE %.3f FAC2 %.3f R %.3f | baseline R %.3f", name, res["beta"], res["U0"],
             res["metrics_test"]["FB"], res["metrics_test"]["NMSE"], res["metrics_test"]["FAC2"], res["metrics_test"]["R"],
             res["baseline_test"]["R"])
    return res


# ------------------------------------------------------------------ docs/07-calibration.md results block
DOCS = ROOT / "docs" / "07-calibration.md"
DOCS_BEGIN, DOCS_END = "<!-- CALIBRATION-RESULTS-BEGIN (tools/calibrate.py writes this block) -->", "<!-- CALIBRATION-RESULTS-END -->"
SECTORS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def _fmt(v: Any, nd: int = 2) -> str:
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "–"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, int):
        return f"{v:,}".replace(",", " ")
    return f"{v:.{nd}f}"


def _metric_rows(cols: list[tuple[str, dict]]) -> list[str]:
    """Chang & Hanna table with the acceptance criteria of physics §10.4."""
    crit = {"FB": ("\\|FB\\| ≤ 0.3", "\\|FB\\| < 0.67"), "NMSE": ("≤ 1.5", "< 6"), "MG": ("0.7–1.3", "–"),
            "VG": ("≤ 4", "–"), "FAC2": ("≥ 0.5", "> 0.30"), "NAD": ("–", "< 0.50"), "R": ("–", "–"),
            "RMSE": ("–", "–"), "meanObs": ("–", "–"), "meanMod": ("–", "–"), "n": ("–", "–")}
    head = "| Metric | " + " | ".join(c for c, _ in cols) + " | Chang & Hanna 2004 \"good\" | Hanna & Chang 2012 urban |"
    out = [head, "|" + "---|" * (len(cols) + 3)]
    for k in ("FB", "NMSE", "MG", "VG", "FAC2", "NAD", "R", "RMSE", "meanObs", "meanMod", "n"):
        out.append(f"| {k} | " + " | ".join(_fmt(m.get(k), 3 if k not in ("RMSE", "meanObs", "meanMod") else 1) for _, m in cols)
                   + f" | {crit[k][0]} | {crit[k][1]} |")
    return out


def render_results(c: dict) -> str:
    g = c.get("lbm") or c["gauss"]
    L = [f"*Generated by `tools/calibrate.py` at {c.get('generated_utc', '?')} from `src/data/calibration.json`. "
         "Do not edit by hand.*", ""]
    inp = c["inputs"]
    L += [f"- **Status:** `{c['status']}`, model `{c['model']}`"
          + (" (Gaussian fallback: no GPU receptor LUT yet)" if c["status"] == "fallback-only" else "") + ".",
          f"- **Period:** {c['period'][0]} … {c['period'][1]}, {_fmt(inp['n_hours'])} paired hours in "
          f"{len([m for m, v in inp['capture'].items() if v >= CAPTURE_MIN])} months with ≥ 75 % capture "
          f"(excluded: {', '.join(f'{m} ({v:.0%})' for m, v in inp['capture'].items() if v < CAPTURE_MIN) or 'none'}).",
          f"- **Data:** `{inp['iszz']}`, `{inp['ifs']}`" + (" — **development caches**" if inp.get("dev_data") else "")
          + f"; ISZZ fetched {c.get('fetch_date') or '–'}; env.json of {inp.get('env_generated') or '–'}.",
          f"- **Fitted on the whole period:** β = **{c['beta']:.3f}**, U0 = **{c['U0']:.2f} m/s**"
          + (" (at the edge of the search grid)" if g.get("U0_at_bound") else "")
          + f"; h_min = {c['h_min']} m and f_NO2 = {c['f_no2']} fixed. {g['n_dropped_log']} hours with ΔNOx ≤ −c0 "
            "could not enter the log objective.",
          "- **Folds:** " + "; ".join(f"train {f['train']} → β {f['beta']:.3f}, U0 {f['U0']:.2f}" for f in g["folds"])
          + f". Leave-one-month-out: β {min(v['beta'] for v in g['lomo_params'].values()):.3f}–"
            f"{max(v['beta'] for v in g['lomo_params'].values()):.3f}, U0 {min(v['U0'] for v in g['lomo_params'].values()):.2f}–"
            f"{max(v['U0'] for v in g['lomo_params'].values()):.2f} m/s.", ""]
    L += ["**Local NOx increment ΔNOx = ZAGREB-1 − ZAGREB-4, held-out hours only** (two half-year folds; µg/m³):", ""]
    L += _metric_rows([("model, test", g["metrics_test"]), ("model, LOMO", g["metrics_lomo"]),
                       ("baseline, test", g["baseline_test"]), ("raw physics (β 1, U0 1.4)", g["raw_physics_test"])])
    t = g["totals_test"]
    L += ["", "**Totals at ZAGREB-1** (test increments + ZAGREB-4 background; NO2 through the chemistry of chapter 06):", ""]
    L += _metric_rows([("NO2", t["no2"]), ("NOx", t["nox"])])
    L += ["", f"FAIRMODE MQI for hourly NO2: **{_fmt(t['no2'].get('MQI'), 2)}** (objective ≤ 1). "
          f"Chemistry alone with measured NOx: RMSE {c['chemistry_check']['RMSE']} µg/m³, r {c['chemistry_check']['R']}, "
          f"MQI {c['chemistry_check']['MQI']} (n = {_fmt(c['chemistry_check']['n'])}).", ""]
    L += ["**Diagnostics: mean observed / mean modelled on the test predictions** (1 = unbiased; > 1 = under-prediction; "
          f"– = fewer than {MIN_N_DIAG} hours):", "",
          f"By IFS wind sector (U10 > {SECTOR_U_MIN} m/s):", "",
          "| " + " | ".join(SECTORS) + " |", "|" + "---|" * 16, "| " + " | ".join(_fmt(v) for v in g["by_sector"]) + " |", "",
          "By local hour start (model, then baseline):", "",
          "| h | " + " | ".join(f"{h:02d}" for h in range(24)) + " |", "|" + "---|" * 25,
          "| model | " + " | ".join(_fmt(v) for v in g["by_hour"]) + " |",
          "| baseline | " + " | ".join(_fmt(v) for v in g["baseline_diag"]["by_hour"]) + " |", "",
          "| By class | " + " | ".join(g["by_class"]) + " |", "|" + "---|" * (len(g["by_class"]) + 1),
          "| obs/mod | " + " | ".join(_fmt(v) for v in g["by_class"].values()) + " |", "",
          "| By U10 (m/s) | " + " | ".join(g["by_speed"]) + " |", "|" + "---|" * (len(g["by_speed"]) + 1),
          "| obs/mod | " + " | ".join(_fmt(v) for v in g["by_speed"].values()) + " |", "",
          "| By month | " + " | ".join(m[5:] for m in g["by_month"]) + " |", "|" + "---|" * (len(g["by_month"]) + 1),
          "| obs/mod | " + " | ".join(_fmt(v) for v in g["by_month"].values()) + " |", "",
          "| By day type | weekday | saturday | sunday |", "|---|---|---|---|",
          "| obs/mod | " + " | ".join(_fmt(g["by_daytype"][k]) for k in ("weekday", "saturday", "sunday")) + " |", "",
          f"Climatological congestion shares (weekday rush hours, Gaussian φ_k): A {c['congestion_share']['A']}, "
          f"B {c['congestion_share']['B']}. Mean ΔNOx: observed {g['mean_obs']}, raw physics {g['mean_mod_raw']} µg/m³.", ""]
    if c.get("lbm"):
        L += ["The Gaussian fallback's own fit (used when the page has no LUT or field): "
              f"β = {c['gauss']['beta']:.3f}, U0 = {c['gauss']['U0']:.2f} m/s, test R = {_fmt(c['gauss']['metrics_test']['R'], 3)}.", ""]
    return "\n".join(L)


def update_docs(cal: dict, path: Path = DOCS) -> None:
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    a, b = text.find(DOCS_BEGIN), text.find(DOCS_END)
    if a < 0 or b < a:
        log.warning("%s has no results markers; not updated", path)
        return
    new = text[:a + len(DOCS_BEGIN)] + "\n" + render_results(cal) + "\n" + text[b:]
    if new != text:
        path.write_text(new, encoding="utf-8")
        log.info("updated the results block of %s", path)


# ------------------------------------------------------------------ main
def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--period", nargs=2, default=["2025-01-01", "2025-12-31"], metavar=("FROM", "TO"),
                    help="local dates; hours ending in [FROM 01:00Z, TO+1 00:00Z] (default 2025)")
    ap.add_argument("--iszz", type=Path, default=PROCESSED / "iszz_hourly.csv.gz")
    ap.add_argument("--ifs", type=Path, default=PROCESSED / "ifs_hourly.csv.gz")
    ap.add_argument("--env", type=Path, default=SRC_DATA / "env.json")
    ap.add_argument("--lut", type=Path, default=SRC_DATA / "lut_receptor.json")
    ap.add_argument("--out", type=Path, default=SRC_DATA / "calibration.json")
    ap.add_argument("--dev", action="store_true", help="use the research caches (development only)")
    ap.add_argument("--no-numpy", action="store_true")
    ap.add_argument("--no-docs", action="store_true", help="do not refresh the results block of docs/07-calibration.md")
    a = ap.parse_args(argv)
    global np
    if a.no_numpy:
        np = None
    t0, t1 = a.period[0] + "T01:00:00Z", _next_day(a.period[1]) + "T00:00:00Z"
    dev = a.dev or not (a.iszz.exists() and a.ifs.exists())
    if dev:
        if not (RESEARCH / "zagreb1_hourly.csv").exists():
            raise SystemExit(f"no input data: {a.iszz} / {a.ifs} are missing and the research caches are not at {RESEARCH} "
                             "(run tools/fetch_iszz.py and tools/fetch_meteo.py, or set Z1_RESEARCH_DATA)")
        log.warning("using research caches (%s): data/processed tables %s", RESEARCH,
                    "not requested" if a.dev else "are missing")
        obs, met = load_dev(t0, t1)
        src = {"iszz": str(RESEARCH / "zagreb1_hourly.csv") + " + physics/iszz/303_*_2025.json",
               "ifs": str(RESEARCH / "physics/openmeteo_archive_2025.json") + " (best_match = ecmwf_ifs)", "dev_data": True}
    else:
        obs, met = load_processed(a.iszz, a.ifs, t0, t1)
        src = {"iszz": str(a.iszz.relative_to(ROOT)) if a.iszz.is_relative_to(ROOT) else str(a.iszz),
               "ifs": str(a.ifs.relative_to(ROOT)) if a.ifs.is_relative_to(ROOT) else str(a.ifs), "dev_data": False}
    hours, capture = build_hours(obs, met, t0, t1)
    if len(hours) < 500:
        raise SystemExit(f"only {len(hours)} paired hours in {a.period}: nothing to calibrate")
    log.info("%d paired hours, %d months, numpy %s", len(hours), len({h['month'] for h in hours}), np is not None)
    env = json.loads(a.env.read_text(encoding="utf-8"))
    gh = [dict(h) for h in hours]
    gauss = calibrate_model("gauss", gh, gauss_rows(env))
    cong = congestion_share(gh)
    lbm = None
    if a.lut.exists():
        lut = json.loads(a.lut.read_text(encoding="utf-8"))
        if lut and lut.get("gamma"):
            lbm = calibrate_model("lbm", [dict(h) for h in hours], lut_rows(lut))
            lbm["lut_meta"] = lut.get("meta")
    top = lbm or gauss
    fetch = None
    comp = PROCESSED / "iszz_completeness.json"
    if comp.exists() and not dev:
        try:
            fetch = json.loads(comp.read_text(encoding="utf-8")).get("generated_utc")
        except (ValueError, OSError):
            fetch = None
    lut_grid = ((lbm or {}).get("lut_meta") or {}).get("grid")
    notes = ("Calibrated on the Gaussian fallback only: no receptor LUT from the GPU model yet (export it with "
             "tools/export_lut.py, then re-run this script). " if lbm is None else
             # β depends on the LUT's grid (docs/03 §8.2: Γ changes up to 3× between 10 m and 5 m); model.js keeps live
             # fields on another grid from replacing the LUT (integration review, 2026-09-28).
             f"3D model fitted on the receptor LUT of grid {lut_grid}; re-run after exporting a LUT on another grid. ") + \
            ("Metrics are on held-out data only (two half-year folds; leave-one-month-out in *_lomo). "
             "ΔNOx = ZAGREB-1 − ZAGREB-4, IFS meteorology, c0 = 10 µg/m³. ") + \
            ("DEVELOPMENT DATA (research caches), not the processed tables. " if dev else "")
    out = {
        "status": "calibrated" if lbm else "fallback-only",
        "beta": top["beta"], "U0": top["U0"], "h_min": H_MIN, "f_no2": F_NO2,
        "model": top["model"],
        "period": list(a.period), "fetch_date": fetch,
        "metrics_test": top["metrics_test"], "baseline_test": top["baseline_test"],
        "by_sector": top["by_sector"], "by_hour": top["by_hour"],
        "gauss": {k: gauss[k] for k in gauss if k != "model"},
        "lbm": ({k: lbm[k] for k in lbm if k != "model"} if lbm else None),
        "baseline": {"U0": BASELINE_U0, "definition": "P(day type, local hour) · S(IFS sector) / √(U² + U0²), medians on the training half (physics §10.5, ZAGREB-4)",
                     "metrics_test": top["baseline_test"], "metrics_lomo": top["baseline_lomo"]},
        "congestion_share": cong,
        "chemistry_check": chemistry_check(hours),
        "inputs": {**src, "env_generated": (env.get("meta") or {}).get("generated_utc"), "lut": str(a.lut.name) if lbm else None,
                   "n_hours": len(hours), "capture": capture, "c0": C0, "u0_grid": [U0_GRID[0], U0_GRID[-1], 0.05],
                   "heating": "auto (October–March)", "measures": "today"},
        "notes": notes,
    }
    write_if_changed(a.out, out)
    if not a.no_docs:
        update_docs(json.loads(a.out.read_text(encoding="utf-8")))
    return 0


def _next_day(d: str) -> str:
    import datetime as dt
    return (dt.date.fromisoformat(d) + dt.timedelta(days=1)).isoformat()


def write_if_changed(path: Path, obj: dict) -> None:
    if path.exists():
        try:
            old = json.loads(path.read_text(encoding="utf-8"))
            old.pop("generated_utc", None)
            if old == json.loads(json.dumps(obj, ensure_ascii=False)):
                log.info("%s unchanged", path)
                return
        except ValueError:
            pass
    n = write_json(path, {**obj, "generated_utc": utcnow_iso()}, compact=False)
    log.info("wrote %s (%d bytes)", path, n)


if __name__ == "__main__":
    sys.exit(main())
