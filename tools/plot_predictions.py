"""Plot the calibrated model against ZAGREB-1 measurements: the 2025 fit period and the 2026 out-of-sample period.

    python3 tools/plot_predictions.py                     # -> docs/img/predictions_2025_2026.png + a metrics JSON
    python3 tools/plot_predictions.py --test-to 2026-09-27 --out docs/img/predictions.png

What it does (docs/07-calibration.md §11.3):

1. Takes β and U0 exactly as the page uses them: the top level of src/data/calibration.json, which is fitted on
   2025 on the embedded receptor LUT (src/data/lut_receptor.json).
2. Rebuilds the hourly inputs with tools/calibrate.py's own functions (load_processed, build_hours, source_terms,
   predict, _tau), so every prediction here is the page's prediction:
   - ΔNOx = 10⁶·β·Σ q_k·Γ_k / √(U² + U0²), the local increment;
   - NO₂ at ZAGREB-1 = the chemistry of chapter 06 applied to that increment on the measured ZAGREB-4 background.
3. The train period is 2025 (the fit sees these hours, so its scores are in-sample). The test period is 2026-01-01 up
   to the last processed hour. The fit has never seen it, and 2026 measurements are raw (not yet validated).
4. For reference, the statistical baseline (hour-of-week × wind sector, physics §10.5) is fitted on 2025 and scored
   on both periods.
5. It plots daily means (local days with ≥ 18 paired hours) and computes the scores on HOURLY pairs, with the metrics
   of docs/07 §6.

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

# Colours: the dataviz skill's reference palette (validated), light mode. The measurements are the reference line in
# neutral ink; the model is categorical slot 1 (blue). The baseline is only a score, so it has no colour.
INK, INK_2, MUTED, GRID = "#0b0b0b", "#52514e", "#8a8984", "#e4e3df"
MODEL = "#2a78d6"
TEST_BAND = "#f1efe9"
SURFACE = "#fcfcfb"


def period_hours(t0: str, t1: str, lut: dict, beta: float, U0: float, iszz: Path, ifs: Path) -> list[dict]:
    """Paired hours in [t0, t1] (hour-ending UTC ISO) with the model's ΔNOx and total NO₂ attached."""
    obs, met = C.load_processed(iszz, ifs, t0, t1)
    hours, capture = C.build_hours(obs, met, t0, t1)
    log.info("%s … %s: %d paired hours; monthly capture %s", t0[:10], t1[:10], len(hours), capture)
    C.source_terms(hours, C.lut_rows(lut))
    pred = C.predict(hours, beta, U0)
    for h, inc in zip(hours, pred):
        h["mod_inc"] = inc
        z = h["o"]
        h["obs_no2"] = z.get("z1.no2", math.nan)
        h["mod_no2"] = math.nan
        if all(math.isfinite(z.get(k, math.nan)) for k in ("z4.no2", "z4.nox", "z4.o3")) and math.isfinite(inc):
            r = M.no2_chemistry(inc, z["z4.no2"], z["z4.nox"], z["z4.o3"], C._tau(h, U0), M.j_no2(h["sw"]),
                                M.k_no_o3(h["t2"]), C.F_NO2)
            h["mod_no2"] = r["no2"]
    return hours


def scores(obs: list[float], mod: list[float]) -> dict:
    pairs = [(o, m) for o, m in zip(obs, mod) if math.isfinite(o) and math.isfinite(m)]
    m = M.metrics([p[0] for p in pairs], [p[1] for p in pairs])
    return {k: (round(m[k], 3) if isinstance(m.get(k), float) else m.get(k)) for k in ("R", "FAC2", "FB", "NMSE", "n")}


def daily(hours: list[dict], ko: str, km: str) -> tuple[list[dt.date], list[float], list[float]]:
    """Local-day means of paired hourly values (a day needs >= MIN_HOURS_PER_DAY pairs)."""
    acc: dict[dt.date, list[tuple[float, float]]] = {}
    for h in hours:
        o, m = h[ko], h[km]
        if not (math.isfinite(o) and math.isfinite(m)):
            continue
        # the hour START in local time names the day (hour-ending stamps: subtract one hour first)
        d = dt.datetime.fromtimestamp((h["t"] - 3600e3) / 1000, tz=dt.timezone.utc).astimezone(ZG).date()
        acc.setdefault(d, []).append((o, m))
    days = sorted(d for d, v in acc.items() if len(v) >= MIN_HOURS_PER_DAY)
    return (days, [sum(p[0] for p in acc[d]) / len(acc[d]) for d in days],
            [sum(p[1] for p in acc[d]) / len(acc[d]) for d in days])


def with_gaps(days: list[dt.date], *series: list[float]):
    """Insert a NaN between days more than one day apart, so a line is broken where data are missing (e.g. September
    2025, excluded from the fit for 54 % capture) instead of bridging the gap with an invented straight segment."""
    out_d, out_s = [], [[] for _ in series]
    for i, d in enumerate(days):
        if i and (d - days[i - 1]).days > 1:
            out_d.append(days[i - 1] + dt.timedelta(days=1))
            for o in out_s:
                o.append(math.nan)
        out_d.append(d)
        for o, s_ in zip(out_s, series):
            o.append(s_[i])
    return (out_d, *out_s)


def plot(train: list[dict], test: list[dict], meta: dict, out: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.dates as mdates
    import matplotlib.pyplot as plt

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9.5, "axes.edgecolor": MUTED, "axes.labelcolor": INK_2,
                         "xtick.color": INK_2, "ytick.color": INK_2, "axes.titlecolor": INK, "figure.facecolor": SURFACE,
                         "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE})
    fig, axes = plt.subplots(2, 1, figsize=(13, 7.8), sharex=True, gridspec_kw={"hspace": 0.28})
    panels = [("obs_no2", "mod_no2", "NO₂ at ZAGREB-1 (background + local sources)", "total"),
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
        # scores per period, hourly pairs (in the band's corner, text ink)
        s0, s1 = meta["scores"]["train"][key], meta["scores"]["test"][key]
        b0, b1 = (meta["scores"]["train"].get("baseline"), meta["scores"]["test"].get("baseline")) if key == "inc" else (None, None)

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
        # direct labels at the right end (identity is never colour alone)
        if d1:
            days, o, m = d1, o1, m1
            ax.annotate("model", (days[-1], m[-1]), xytext=(6, 0), textcoords="offset points", color=INK, fontsize=8.5,
                        va="center", fontweight="bold")
            ax.annotate("measured", (days[-1], o[-1]), xytext=(6, -11 if o[-1] < m[-1] else 11), textcoords="offset points",
                        color=INK_2, fontsize=8.5, va="center")
    axes[0].legend(loc="upper right", frameon=False, ncol=2, fontsize=9, bbox_to_anchor=(1.0, 1.16))
    x_end = (max(h["t"] for h in test) if test else None)
    x_end = dt.datetime.fromtimestamp(x_end / 1000, tz=dt.timezone.utc).date() if x_end else dt.date(2026, 1, 1)
    axes[1].set_xlim(dt.date(2025, 1, 1), x_end + dt.timedelta(days=4))
    axes[1].xaxis.set_major_locator(mdates.MonthLocator())
    axes[1].xaxis.set_major_formatter(mdates.DateFormatter("%b\n%Y"))
    for lab in axes[1].get_xticklabels():
        lab.set_fontsize(8.5)
    fig.suptitle("Air at the crossroads · ZAGREB-1: the calibrated 3D model against the station", x=0.07, ha="left",
                 fontsize=13, fontweight="bold", color=INK, y=0.985)
    fig.text(0.07, 0.918,
             f"3D GPU model on the {meta['lut_grid']} receptor LUT, β = {meta['beta']:.2f}, U₀ = {meta['U0']:.2f} m/s, fitted on 2025 "
             "only. Weather: ECMWF IFS (Open-Meteo). Background: ZAGREB-4.\nLines are daily means (gaps: days with fewer "
             "than 18 paired hours, and months excluded from the fit). Scores use hourly pairs (Chang & Hanna 2004).",
             fontsize=8.8, color=INK_2, linespacing=1.4)
    fig.text(0.07, 0.012, "Sources: ISZZ (MZOZT, measurements DHMZ); ZG3D 2022 (Grad Zagreb); © OpenStreetMap contributors; "
             "Open-Meteo (CC BY 4.0).\n2026 measurements are raw and may change when validated. "
             "Regenerate: python3 tools/plot_predictions.py (docs/07-calibration.md §11.3)", fontsize=7.5, color=MUTED,
             linespacing=1.4)
    fig.subplots_adjust(left=0.07, right=0.94, top=0.855, bottom=0.105)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=150)
    log.info("wrote %s", out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--test-to", default=None, help="last local day of the test period (default: last processed hour)")
    ap.add_argument("--iszz", type=Path, default=PROCESSED / "iszz_hourly.csv.gz")
    ap.add_argument("--ifs", type=Path, default=PROCESSED / "ifs_hourly.csv.gz")
    ap.add_argument("--lut", type=Path, default=SRC_DATA / "lut_receptor.json")
    ap.add_argument("--cal", type=Path, default=SRC_DATA / "calibration.json")
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "img" / "predictions_2025_2026.png")
    a = ap.parse_args(argv)
    cal = json.loads(a.cal.read_text(encoding="utf-8"))
    lut = json.loads(a.lut.read_text(encoding="utf-8"))
    if cal.get("model") != "lbm" or (cal.get("lbm") or {}).get("lut_meta", {}).get("grid") != lut["meta"]["grid"]:
        raise SystemExit("calibration.json is not the 3D fit for this LUT's grid: run tools/calibrate.py first")
    beta, U0 = cal["beta"], cal["U0"]
    t1 = (C._next_day(a.test_to) + "T00:00:00Z") if a.test_to else "2100-01-01T00:00:00Z"
    train = period_hours("2025-01-01T01:00:00Z", "2026-01-01T00:00:00Z", lut, beta, U0, a.iszz, a.ifs)
    test = period_hours("2026-01-01T01:00:00Z", t1, lut, beta, U0, a.iszz, a.ifs)
    # the statistical baseline, fitted on 2025, scored on both periods (reference only)
    base = C.baseline_fit(train)
    sc = {}
    for name, hs in (("train", train), ("test", test)):
        sc[name] = {"total": scores([h["obs_no2"] for h in hs], [h["mod_no2"] for h in hs]),
                    "inc": scores([h["obs"] for h in hs], [h["mod_inc"] for h in hs]),
                    "baseline": scores([h["obs"] for h in hs], C.baseline_predict(base, hs))}
    last = max(h["t"] for h in test) if test else None
    meta = {"beta": beta, "U0": U0, "lut_grid": lut["meta"]["grid"], "calibration_generated": cal.get("generated_utc"),
            "train": ["2025-01-01", "2025-12-31"],
            "test": ["2026-01-01", dt.datetime.fromtimestamp(last / 1000, tz=dt.timezone.utc).isoformat() if last else None],
            "scores": sc, "note": "scores on hourly pairs; train = in-sample (the fit's own year), test = out-of-sample, raw data"}
    for name in ("train", "test"):
        log.info("%s: NO2 total %s | NOx increment %s | baseline %s", name, sc[name]["total"], sc[name]["inc"], sc[name]["baseline"])
    plot(train, test, meta, a.out)
    write_json(a.out.with_suffix(".json"), meta, compact=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
