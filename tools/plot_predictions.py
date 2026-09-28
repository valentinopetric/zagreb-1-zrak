"""Plot the calibrated model against ZAGREB-1 measurements: the 2025 fit period and the 2026 out-of-sample period.

    python3 tools/plot_predictions.py                     # the three figures below + docs/img/predictions_2025_2026.json
    python3 tools/plot_predictions.py --test-to 2026-09-27
    python3 tools/plot_predictions.py --zoom 2026-01-12 2026-07-06   # start days of the two 14-day zoom windows

Figures (docs/07-calibration.md §11.3):

    docs/img/predictions_2025_2026.png          daily means: NO₂ total and the local NOx increment
    docs/img/predictions_hourly_2025_2026.png   HOURLY, every modelled pollutant, both periods
    docs/img/predictions_hourly_zoom_2026.png   HOURLY, every modelled pollutant, a winter and a summer fortnight of 2026

What it does:

1. Takes β and U0 exactly as the page uses them: the top level of src/data/calibration.json, fitted on 2025 on the
   embedded receptor LUT (src/data/lut_receptor.json). The same β and U0 apply to every pollutant, as in model.js
   concentrations(): one fitted dispersion and traffic scale, with the pollutant-specific emission factors of
   emissions.js.
2. Rebuilds the hourly inputs with tools/calibrate.py's own functions (load_processed, build_hours, source_terms,
   predict, _tau), so every prediction is the page's prediction for that hour:
   - ΔC_p = 10⁶·β·Σ q_k^p·Γ_k / √(U² + U0²), where q_k^p comes from aqmodel.group_strengths(p, t, today's measures,
     heating 'auto'); CO is converted to mg/m³;
   - NO₂ and NOx total = the chemistry of chapter 06 on the measured ZAGREB-4 NO₂, NOx and O₃;
   - PM₁₀ and PM₂.₅ total = measured ZAGREB-4 + ΔC;
   - CO and benzene total = a constant background + ΔC. No background station measures them; the constants are
     model.js MOD_BG_DEFAULT: CO 0.19 mg/m³, benzene 0.35 µg/m³.
   The hours are calibrate.py's paired hours: NOx at both stations, IFS weather, and months with ≥ 75 % capture.
   SO₂ is measured at ZAGREB-1 but not modelled (no local SO₂ source in the model), so it is not shown.
3. Train = 2025 (the fit saw these hours, so its scores are in-sample). Test = 2026-01-01 up to the last processed
   hour, never seen by the fit, on raw (not yet validated) measurements.
4. For reference, the statistical baseline (hour-of-week × wind sector, physics §10.5) is fitted on 2025 and scored
   on both periods, for the NOx increment only (it is defined for ΔNOx).
5. Scores are on hourly pairs (docs/07 §6), with a per-pollutant floor near the reporting resolution for the log and
   FAC2 terms: 1 µg/m³, except CO 0.05 mg/m³ and benzene 0.1 µg/m³.

Needs matplotlib (dev only, requirements-dev.txt); everything else is stdlib plus tools/.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import calibrate as C  # noqa: E402  (reuses the calibration's exact data path and model)
from common import PROCESSED, ROOT, SRC_DATA, log, write_json  # noqa: E402

M = C.M
ZG = ZoneInfo("Europe/Zagreb")
MIN_HOURS_PER_DAY = 18
IMG = ROOT / "docs" / "img"

# model.js MOD_BG_DEFAULT (ZAGREB-4 2025 means; CO and benzene are not measured there). Keep in step with model.js.
BG_CONST = {"co": 0.19, "c6h6": 0.35}
# pollutant -> (label, unit, observed key, FAC2/log floor)
POLL = {
    "no2":  ("NO₂", "µg/m³", "z1.no2", 1.0),
    "nox":  ("NOx", "µg/m³", "z1.nox", 1.0),
    "pm10": ("PM₁₀", "µg/m³", "z1.pm10", 1.0),
    "pm25": ("PM₂.₅", "µg/m³", "z1.pm25", 1.0),
    "co":   ("CO", "mg/m³", "z1.co", 0.05),
    "c6h6": ("benzene", "µg/m³", "z1.c6h6", 0.1),
}
BACKGROUND_NOTE = {
    "no2": "ZAGREB-4 background + chemistry", "nox": "ZAGREB-4 background + local", "pm10": "ZAGREB-4 background + local",
    "pm25": "ZAGREB-4 background + local", "co": "constant background 0.19 + local", "c6h6": "constant background 0.35 + local",
}

# Colours: the dataviz skill's reference palette (validated), light mode. The measurements are the reference line in
# neutral ink; the model is categorical slot 1 (blue). The baseline is only a score, so it has no colour.
INK, INK_2, MUTED, GRID = "#0b0b0b", "#52514e", "#8a8984", "#e4e3df"
MODEL = "#2a78d6"
TEST_BAND = "#f1efe9"
SURFACE = "#fcfcfb"
SOURCES = ("Sources: ISZZ (MZOZT, measurements DHMZ); ZG3D 2022 (Grad Zagreb); © OpenStreetMap contributors; "
           "Open-Meteo (CC BY 4.0).")


# ------------------------------------------------------------------ model per hour
def period_hours(t0: str, t1: str, lut: dict, beta: float, U0: float, iszz: Path, ifs: Path) -> list[dict]:
    """Paired hours in [t0, t1] (hour-ending UTC ISO) with obs_<p> and mod_<p> for every pollutant in POLL."""
    obs, met = C.load_processed(iszz, ifs, t0, t1)
    hours, capture = C.build_hours(obs, met, t0, t1)
    log.info("%s … %s: %d paired hours; monthly capture %s", t0[:10], t1[:10], len(hours), capture)
    C.source_terms(hours, C.lut_rows(lut))
    pred = C.predict(hours, beta, U0)
    for h, inc in zip(hours, pred):
        h["mod_inc"] = inc
        z, ga = h["o"], h["ga"]
        ueff = math.sqrt(h["u"] * h["u"] + U0 * U0)
        for p, (_l, _u, key, _f) in POLL.items():
            h[f"obs_{p}"] = z.get(key, math.nan)
            h[f"mod_{p}"] = math.nan
        # NO2 and NOx: the chemistry on the measured ZAGREB-4 background (as calibrate.totals and model.js)
        if all(math.isfinite(z.get(k, math.nan)) for k in ("z4.no2", "z4.nox", "z4.o3")) and math.isfinite(inc):
            r = M.no2_chemistry(inc, z["z4.no2"], z["z4.nox"], z["z4.o3"], C._tau(h, U0), M.j_no2(h["sw"]),
                                M.k_no_o3(h["t2"]), C.F_NO2)
            h["mod_no2"], h["mod_nox"] = r["no2"], r["nox"]
        # the other pollutants: same β, U0 and Γ; their own q_k (emissions.js groupStrengths, heating 'auto')
        for p in ("pm10", "pm25", "co", "c6h6"):
            q = M.group_strengths(p, h["t"], {}, "auto")
            d = 1e6 * beta * sum(q[g] * ga["gamma"][k] for k, g in enumerate("ABCD")) / ueff
            if p == "co":
                d *= 1e-3                                   # µg/m³ -> mg/m³ (model.js)
            bg = z.get(f"z4.{p}", math.nan) if p in ("pm10", "pm25") else BG_CONST[p]
            h[f"mod_{p}"] = bg + d if math.isfinite(bg) else math.nan
            h[f"inc_{p}"] = d
    return hours


def scores(obs: list[float], mod: list[float], floor: float = 1.0) -> dict:
    pairs = [(o, m) for o, m in zip(obs, mod) if math.isfinite(o) and math.isfinite(m)]
    m = M.metrics([p[0] for p in pairs], [p[1] for p in pairs], floor)
    return {k: (round(m[k], 3) if isinstance(m.get(k), float) else m.get(k)) for k in ("R", "FAC2", "FB", "NMSE", "meanObs", "meanMod", "n")}


def local_day(tm: float) -> dt.date:
    """The local day of an hour-ending stamp (the hour START names the day)."""
    return dt.datetime.fromtimestamp((tm - 3600e3) / 1000, tz=dt.timezone.utc).astimezone(ZG).date()


def local_dt(tm: float) -> dt.datetime:
    """Hour-ending stamp -> naive local datetime of the hour's midpoint (for plotting)."""
    return dt.datetime.fromtimestamp((tm - 1800e3) / 1000, tz=dt.timezone.utc).astimezone(ZG).replace(tzinfo=None)


def daily(hours: list[dict], ko: str, km: str) -> tuple[list[dt.date], list[float], list[float]]:
    """Local-day means of paired hourly values (a day needs >= MIN_HOURS_PER_DAY pairs)."""
    acc: dict[dt.date, list[tuple[float, float]]] = {}
    for h in hours:
        o, m = h[ko], h[km]
        if math.isfinite(o) and math.isfinite(m):
            acc.setdefault(local_day(h["t"]), []).append((o, m))
    days = sorted(d for d, v in acc.items() if len(v) >= MIN_HOURS_PER_DAY)
    return (days, [sum(p[0] for p in acc[d]) / len(acc[d]) for d in days],
            [sum(p[1] for p in acc[d]) / len(acc[d]) for d in days])


def with_gaps(xs: list, *series: list[float], max_step: dt.timedelta = dt.timedelta(days=1)):
    """Insert a NaN wherever consecutive x are more than max_step apart, so a line is broken where data are missing
    (e.g. September 2025, excluded from the fit for 54 % capture) instead of bridging the gap with an invented
    straight segment."""
    out_x, out_s = [], [[] for _ in series]
    for i, x in enumerate(xs):
        if i and (x - xs[i - 1]) > max_step:
            out_x.append(xs[i - 1] + max_step / 2)
            for o in out_s:
                o.append(math.nan)
        out_x.append(x)
        for o, s_ in zip(out_s, series):
            o.append(s_[i])
    return (out_x, *out_s)


def hourly(hours: list[dict], ko: str, km: str) -> tuple[list[dt.datetime], list[float], list[float]]:
    """Hourly pairs (both finite) as local datetimes, with NaN breaks at every missing hour."""
    rows = [(local_dt(h["t"]), h[ko], h[km]) for h in hours if math.isfinite(h[ko]) and math.isfinite(h[km])]
    rows.sort(key=lambda r: r[0])
    return with_gaps([r[0] for r in rows], [r[1] for r in rows], [r[2] for r in rows],
                     max_step=dt.timedelta(hours=1, minutes=30))


# ------------------------------------------------------------------ figures
def _style():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9.5, "axes.edgecolor": MUTED, "axes.labelcolor": INK_2,
                         "xtick.color": INK_2, "ytick.color": INK_2, "axes.titlecolor": INK, "figure.facecolor": SURFACE,
                         "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE})
    return plt


def _score_line(s: dict, unit: str) -> str:
    return (f"r {s['R']:.2f}   FAC2 {s['FAC2']:.2f}   FB {s['FB']:+.2f}   mean {s['meanObs']:.3g} / {s['meanMod']:.3g} {unit}")


def plot_daily(train: list[dict], test: list[dict], meta: dict, out: Path) -> None:
    import matplotlib.dates as mdates
    plt = _style()
    fig, axes = plt.subplots(2, 1, figsize=(13, 7.8), sharex=True, gridspec_kw={"hspace": 0.28})
    panels = [("obs_no2", "mod_no2", "NO₂ at ZAGREB-1 (background + local sources)", "no2"),
              ("obs", "mod_inc", "NOx from local sources (ZAGREB-1 − ZAGREB-4)", "inc")]
    t_split = dt.date(2026, 1, 1)
    for ax, (ko, km, title, key) in zip(axes, panels):
        d0, o0, m0 = daily(train, ko, km)
        d1, o1, m1 = daily(test, ko, km)
        days, o, m = with_gaps(d0 + d1, o0 + o1, m0 + m1)
        ax.axvspan(t_split, (d1[-1] if d1 else t_split) + dt.timedelta(days=1), color=TEST_BAND, zorder=0, lw=0)
        ax.plot(days, o, color=INK, lw=1.3, alpha=0.8, label="measured (ISZZ)", zorder=3)
        ax.plot(days, m, color=MODEL, lw=2.0, label="model", zorder=4)
        ax.axvline(t_split, color=MUTED, lw=1, ls=(0, (3, 3)), zorder=2)
        ax.set_title(title, loc="left", fontsize=11, fontweight="bold", pad=6)
        ax.set_ylabel("µg/m³, daily mean")
        ax.set_ylim(bottom=0)
        ax.grid(axis="y", color=GRID, lw=0.8)
        ax.spines[["top", "right"]].set_visible(False)
        s0, s1 = meta["scores"]["train"][key], meta["scores"]["test"][key]
        b0, b1 = (meta["scores"]["train"]["baseline"], meta["scores"]["test"]["baseline"]) if key == "inc" else (None, None)

        def fmt(s, b=None):
            t = f"hourly  r {s['R']:.2f}   FAC2 {s['FAC2']:.2f}   FB {s['FB']:+.2f}   n {s['n']:,}".replace(",", " ")
            return t + (f"\nbaseline  r {b['R']:.2f}   FAC2 {b['FAC2']:.2f}" if b else "")
        ytop = ax.get_ylim()[1]
        ax.text(dt.date(2025, 1, 8), ytop * 0.97, "TRAIN · 2025 (β and U₀ fitted here)\n" + fmt(s0, b0), va="top", ha="left",
                fontsize=8.6, color=INK_2, linespacing=1.45, zorder=5,
                bbox={"boxstyle": "round,pad=0.35", "fc": SURFACE, "ec": GRID, "alpha": 0.92})
        ax.text(t_split + dt.timedelta(days=7), ytop * 0.97, "TEST · 2026 (never seen by the fit; raw data)\n" + fmt(s1, b1),
                va="top", ha="left", fontsize=8.6, color=INK_2, linespacing=1.45, zorder=5,
                bbox={"boxstyle": "round,pad=0.35", "fc": TEST_BAND, "ec": GRID, "alpha": 0.95})
        if d1:
            ax.annotate("model", (d1[-1], m1[-1]), xytext=(6, 0), textcoords="offset points", color=INK, fontsize=8.5,
                        va="center", fontweight="bold")
            ax.annotate("measured", (d1[-1], o1[-1]), xytext=(6, -11 if o1[-1] < m1[-1] else 11), textcoords="offset points",
                        color=INK_2, fontsize=8.5, va="center")
    axes[0].legend(loc="upper right", frameon=False, ncol=2, fontsize=9, bbox_to_anchor=(1.0, 1.16))
    x_end = local_day(max(h["t"] for h in test)) if test else t_split
    axes[1].set_xlim(dt.date(2025, 1, 1), x_end + dt.timedelta(days=4))
    axes[1].xaxis.set_major_locator(mdates.MonthLocator())
    axes[1].xaxis.set_major_formatter(mdates.DateFormatter("%b\n%Y"))
    for lab in axes[1].get_xticklabels():
        lab.set_fontsize(8.5)
    fig.suptitle("Air at the crossroads · ZAGREB-1: the calibrated 3D model against the station (daily means)", x=0.07, ha="left",
                 fontsize=13, fontweight="bold", color=INK, y=0.985)
    fig.text(0.07, 0.918,
             f"3D GPU model on the {meta['lut_grid']} receptor LUT, β = {meta['beta']:.2f}, U₀ = {meta['U0']:.2f} m/s, fitted on 2025 "
             "only. Weather: ECMWF IFS (Open-Meteo). Background: ZAGREB-4.\nLines are daily means (gaps: days with fewer "
             "than 18 paired hours, and months excluded from the fit). Scores use hourly pairs (Chang & Hanna 2004).",
             fontsize=8.8, color=INK_2, linespacing=1.4)
    fig.text(0.07, 0.012, SOURCES + "\n2026 measurements are raw and may change when validated. "
             "Regenerate: python3 tools/plot_predictions.py (docs/07-calibration.md §11.3)", fontsize=7.5, color=MUTED, linespacing=1.4)
    fig.subplots_adjust(left=0.07, right=0.94, top=0.855, bottom=0.105)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=150)
    plt.close(fig)
    log.info("wrote %s", out)


# Per-pollutant caveats printed above the hourly panels (verified in the data, 2026-09-28; docs/07 §11.3).
HOURLY_NOTES = {
    "nox": "17–23 Jun 2026: ≥ 118 µg/m³ day and night while ZAGREB-4 is normal: a continuous local source or an analyser fault (raw)",
    "co": "raw 2026 CO drifts to ≤ 0 in summer (analyser zero drift, docs/01 §10); reported to 0.1 mg/m³ only",
    "c6h6": "winter peaks are not in the model: heating emits no benzene there (docs/05); raw 2026 mean is 1.8× validated 2025",
}


def plot_hourly(train: list[dict], test: list[dict], meta: dict, out: Path) -> None:
    """Every modelled pollutant, hourly, over both periods: one row per pollutant, the y-axis clipped at the 99.7th
    percentile (the count of clipped hours is printed) so that a few spikes do not flatten the rest. Titles, scores
    and caveats sit above each panel so that nothing covers the data."""
    import matplotlib.dates as mdates
    import matplotlib.transforms as mtrans
    plt = _style()
    n = len(POLL)
    fig, axes = plt.subplots(n, 1, figsize=(13, 2.5 * n + 1.9), sharex=True, gridspec_kw={"hspace": 0.95})
    t_split = dt.datetime(2026, 1, 1)
    x_end = local_dt(max(h["t"] for h in test)) if test else t_split
    x0, x1 = dt.datetime(2025, 1, 1), x_end + dt.timedelta(days=3)
    handles = None
    for ax, (p, (label, unit, _key, _f)) in zip(axes, POLL.items()):
        x, o, m = hourly(train + test, f"obs_{p}", f"mod_{p}")
        vals = sorted(v for v in o + m if math.isfinite(v))
        cap = vals[int(0.997 * (len(vals) - 1))] * 1.08 if vals else 1
        clipped = sum(1 for v in o if math.isfinite(v) and v > cap)
        ax.axvspan(t_split, x_end + dt.timedelta(days=1), color=TEST_BAND, zorder=0, lw=0)
        l1, = ax.plot(x, o, color=INK, lw=0.45, alpha=0.75, label="measured (ISZZ), hourly", zorder=3)
        l2, = ax.plot(x, m, color=MODEL, lw=0.45, alpha=0.8, label="model, hourly", zorder=4)
        handles = handles or [l1, l2]
        ax.axvline(t_split, color=MUTED, lw=1, ls=(0, (3, 3)), zorder=2)
        lo = min(0.0, vals[0]) if vals else 0.0
        ax.set_ylim(lo, cap)
        ax.set_xlim(x0, x1)
        ax.grid(axis="y", color=GRID, lw=0.8)
        ax.spines[["top", "right"]].set_visible(False)
        above = lambda pts, tr=ax.transAxes: mtrans.offset_copy(tr, fig=fig, y=pts, units="points")
        ax.text(0, 1, f"{label} at ZAGREB-1, {unit}  ·  {BACKGROUND_NOTE[p]}", transform=above(29), ha="left", va="bottom",
                fontsize=10, fontweight="bold", color=INK)
        note = HOURLY_NOTES.get(p, "")
        if clipped:
            note = (note + "   ·   " if note else "") + f"{clipped} measured hours above {cap:.3g} not shown"
        if note:
            ax.text(0, 1, note, transform=above(16), ha="left", va="bottom", fontsize=7.6, color=MUTED)
        s0, s1 = meta["scores"]["train"][p], meta["scores"]["test"][p]
        bl = mtrans.blended_transform_factory(ax.transData, ax.transAxes)
        ax.text(0, 1, "TRAIN 2025   " + _score_line(s0, unit), transform=above(3), ha="left", va="bottom", fontsize=7.9, color=INK_2)
        ax.text(mdates.date2num(t_split), 1, "  TEST 2026   " + _score_line(s1, unit), transform=above(3, bl), ha="left",
                va="bottom", fontsize=7.9, color=INK_2)
    axes[-1].xaxis.set_major_locator(mdates.MonthLocator())
    axes[-1].xaxis.set_major_formatter(mdates.DateFormatter("%b\n%Y"))
    for lab in axes[-1].get_xticklabels():
        lab.set_fontsize(8.3)
    H = fig.get_figheight()
    fig.suptitle("ZAGREB-1, hourly: the calibrated 3D model against the station, every modelled pollutant", x=0.07,
                 ha="left", fontsize=13, fontweight="bold", color=INK, y=1 - 0.18 / H)
    fig.text(0.07, 1 - 0.62 / H,
             f"Fitted on 2025 only (β = {meta['beta']:.2f}, U₀ = {meta['U0']:.2f} m/s, {meta['lut_grid']} LUT); the same β and U₀ drive every "
             "pollutant through its own emission factors. Shaded: 2026, never seen by the fit (raw data).\n"
             "Scores on hourly pairs; mean = measured / model. Lines break at missing hours. SO₂ is measured but not "
             "modelled. CO and benzene have no measured background (constants).", fontsize=8.6, color=INK_2, linespacing=1.4)
    fig.legend(handles=handles, loc="upper left", bbox_to_anchor=(0.065, 1 - 0.93 / H), ncol=2, frameon=False, fontsize=8.8)
    fig.text(0.07, 0.25 / H, SOURCES + "  Regenerate: python3 tools/plot_predictions.py (docs/07-calibration.md §11.3)",
             fontsize=7.3, color=MUTED)
    fig.subplots_adjust(left=0.07, right=0.985, top=1 - 1.75 / H, bottom=0.75 / H)
    fig.savefig(out, dpi=150)
    plt.close(fig)
    log.info("wrote %s", out)


def plot_zoom(test: list[dict], meta: dict, starts: list[dt.date], out: Path, days: int = 14) -> None:
    """Hourly detail of the out-of-sample year: two 14-day windows side by side, one row per pollutant."""
    import matplotlib.dates as mdates
    plt = _style()
    n = len(POLL)
    fig, axes = plt.subplots(n, len(starts), figsize=(13, 2.0 * n + 1.5), sharey="row", gridspec_kw={"hspace": 0.55, "wspace": 0.07})
    for c, start in enumerate(starts):
        a = dt.datetime.combine(start, dt.time())
        b = a + dt.timedelta(days=days)
        win = [h for h in test if a <= local_dt(h["t"]) < b]
        for r, (p, (label, unit, _key, _f)) in enumerate(POLL.items()):
            ax = axes[r][c]
            x, o, m = hourly(win, f"obs_{p}", f"mod_{p}")
            ax.plot(x, o, color=INK, lw=1.0, alpha=0.85, label="measured (ISZZ)", zorder=3)
            ax.plot(x, m, color=MODEL, lw=1.3, label="model", zorder=4)
            s = scores([h[f"obs_{p}"] for h in win], [h[f"mod_{p}"] for h in win], POLL[p][3])
            ax.set_title(f"{label}, {unit}" + (f"   ·   r {s['R']:.2f}, FAC2 {s['FAC2']:.2f} in this window" if s["n"] else ""),
                         loc="left", fontsize=9.3, fontweight="bold", pad=3)
            ax.grid(axis="y", color=GRID, lw=0.8)
            ax.spines[["top", "right"]].set_visible(False)
            ax.set_xlim(a, b - dt.timedelta(hours=2))
            ax.xaxis.set_major_locator(mdates.DayLocator(interval=2))
            ax.xaxis.set_minor_locator(mdates.DayLocator())
            ax.xaxis.set_major_formatter(mdates.DateFormatter("%a %d %b" if r == n - 1 else ""))
            ax.set_ylim(bottom=min(0.0, ax.get_ylim()[0]))
            if r == n - 1:
                for lab in ax.get_xticklabels():
                    lab.set_fontsize(7.8)
        axes[0][c].text(0, 1.42, f"{start:%d %b} – {(b - dt.timedelta(days=1)):%d %b %Y} (out of sample)",
                        transform=axes[0][c].transAxes, fontsize=10.5, fontweight="bold", color=INK)
    axes[0][-1].legend(loc="lower right", frameon=False, ncol=2, fontsize=8.5, bbox_to_anchor=(1.0, 1.36))
    H = fig.get_figheight()
    fig.suptitle("ZAGREB-1, hourly detail: two fortnights of 2026 the model has never seen", x=0.07, ha="left",
                 fontsize=13, fontweight="bold", color=INK, y=1 - 0.15 / H)
    fig.text(0.07, 1 - 0.5 / H,
             f"Model fitted on 2025 (β = {meta['beta']:.2f}, U₀ = {meta['U0']:.2f} m/s); local time, each point is one hourly mean. "
             "2026 measurements are raw. CO and benzene have constant model backgrounds.", fontsize=8.6, color=INK_2)
    fig.text(0.07, 0.22 / H, SOURCES + "  Regenerate: python3 tools/plot_predictions.py", fontsize=7.3, color=MUTED)
    fig.subplots_adjust(left=0.07, right=0.985, top=1 - 1.6 / H, bottom=0.72 / H)
    fig.savefig(out, dpi=150)
    plt.close(fig)
    log.info("wrote %s", out)


# ------------------------------------------------------------------ main
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--test-to", default=None, help="last local day of the test period (default: last processed hour)")
    ap.add_argument("--zoom", nargs=2, default=["2026-01-12", "2026-07-06"], metavar=("WINTER", "SUMMER"),
                    help="first local day of each 14-day zoom window (default 2026-01-12 2026-07-06, both Mondays)")
    ap.add_argument("--iszz", type=Path, default=PROCESSED / "iszz_hourly.csv.gz")
    ap.add_argument("--ifs", type=Path, default=PROCESSED / "ifs_hourly.csv.gz")
    ap.add_argument("--lut", type=Path, default=SRC_DATA / "lut_receptor.json")
    ap.add_argument("--cal", type=Path, default=SRC_DATA / "calibration.json")
    ap.add_argument("--outdir", type=Path, default=IMG)
    a = ap.parse_args(argv)
    cal = json.loads(a.cal.read_text(encoding="utf-8"))
    lut = json.loads(a.lut.read_text(encoding="utf-8"))
    if cal.get("model") != "lbm" or (cal.get("lbm") or {}).get("lut_meta", {}).get("grid") != lut["meta"]["grid"]:
        raise SystemExit("calibration.json is not the 3D fit for this LUT's grid: run tools/calibrate.py first")
    beta, U0 = cal["beta"], cal["U0"]
    t1 = (C._next_day(a.test_to) + "T00:00:00Z") if a.test_to else "2100-01-01T00:00:00Z"
    train = period_hours("2025-01-01T01:00:00Z", "2026-01-01T00:00:00Z", lut, beta, U0, a.iszz, a.ifs)
    test = period_hours("2026-01-01T01:00:00Z", t1, lut, beta, U0, a.iszz, a.ifs)
    base = C.baseline_fit(train)   # the statistical baseline, fitted on 2025 (reference only, ΔNOx)
    sc = {}
    for name, hs in (("train", train), ("test", test)):
        sc[name] = {p: scores([h[f"obs_{p}"] for h in hs], [h[f"mod_{p}"] for h in hs], POLL[p][3]) for p in POLL}
        sc[name]["inc"] = scores([h["obs"] for h in hs], [h["mod_inc"] for h in hs])
        sc[name]["baseline"] = scores([h["obs"] for h in hs], C.baseline_predict(base, hs))
        for p in POLL:
            log.info("%-5s %-5s %s", name, p, sc[name][p])
        log.info("%-5s ΔNOx model %s | baseline %s", name, sc[name]["inc"], sc[name]["baseline"])
    last = max(h["t"] for h in test) if test else None
    meta = {"beta": beta, "U0": U0, "lut_grid": lut["meta"]["grid"], "calibration_generated": cal.get("generated_utc"),
            "train": ["2025-01-01", "2025-12-31"],
            "test": ["2026-01-01", dt.datetime.fromtimestamp(last / 1000, tz=dt.timezone.utc).isoformat() if last else None],
            "scores": sc, "floors": {p: POLL[p][3] for p in POLL}, "background_constants": BG_CONST,
            "note": "scores on hourly pairs; train = in-sample (the fit's own year), test = out-of-sample, raw data; "
                    "'inc' and 'baseline' = the local NOx increment ZAGREB-1 − ZAGREB-4"}
    a.outdir.mkdir(parents=True, exist_ok=True)
    plot_daily(train, test, meta, a.outdir / "predictions_2025_2026.png")
    plot_hourly(train, test, meta, a.outdir / "predictions_hourly_2025_2026.png")
    plot_zoom(test, meta, [dt.date.fromisoformat(d) for d in a.zoom], a.outdir / "predictions_hourly_zoom_2026.png")
    write_json(a.outdir / "predictions_2025_2026.json", meta, compact=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
