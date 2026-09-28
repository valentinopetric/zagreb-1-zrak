"""Export the receptor LUT by running the app headless in its ?sweep=lut mode.

    python3 tools/export_lut.py                      # grid chosen by the browser (10 m on software WebGL)
    python3 tools/export_lut.py --grid coarse        # 10 m fine grid (60x60x16), 20 m spin-up
    python3 tools/export_lut.py --grid fine          # 5 m fine grid (120x120x32), 10 m spin-up
    python3 tools/export_lut.py --timeout 43200      # seconds to wait for the sweep (SwiftShader is slow)
    python3 tools/export_lut.py --check src/data/lut_receptor.json   # validate an existing LUT, no browser

What it does (docs/03-flow-lbm.md §7, architecture §4.4 and §6.2):

1. builds dist/index.html (tools/build.py) unless --no-build;
2. serves dist/ on localhost and opens index.html?sweep=lut[&grid=...] in headless Chromium through
   tests/browser/harness.py (playwright, dev-only dependency; WebGL2 runs on SwiftShader when there is
   no GPU);
3. the page's main.js calls aero.sweepLUT() once booted; if no progress appears within --start-wait
   seconds, this tool starts the sweep itself through window.__z1_startLUT() (defined in aero.js);
4. polls window.__lutProgress every --poll seconds and logs it, until window.__lut is set;
5. validates the LUT's shape and writes it to src/data/lut_receptor.json (or --out). An incomplete LUT
   (missing Gamma entries, e.g. without the scalar solver) is written only with --allow-incomplete.

The browser needs network access for three.js (jsDelivr, as the page itself).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, SRC_DATA, log, write_json  # noqa: E402

DIRS = 16
GROUPS = ["A", "B", "C", "D"]
DEFAULT_CLASSES = ["AC", "D", "EF"]


# ------------------------------------------------------------------ validation (no browser)
def validate_lut(lut: dict) -> tuple[list[str], list[str]]:
    """Check a LUT against architecture §4.4. Returns (errors, warnings); errors mean the shape is wrong.

    Missing entries (null Gamma) are warnings, not errors: the app falls back per entry.
    """
    errors: list[str] = []
    warnings: list[str] = []
    for k in ("meta", "dirs", "classes", "groups", "gamma", "age", "band", "wind"):
        if k not in lut:
            errors.append(f"missing key '{k}'")
    if errors:
        return errors, warnings
    dirs, classes, groups = lut["dirs"], lut["classes"], lut["groups"]
    if len(dirs) != DIRS or any(abs(d - 22.5 * i) > 1e-9 for i, d in enumerate(dirs)):
        errors.append(f"dirs must be 0, 22.5, ... 337.5 (got {dirs})")
    if groups != GROUPS:
        errors.append(f"groups must be {GROUPS} (got {groups})")
    if not classes or any(c not in DEFAULT_CLASSES for c in classes):
        errors.append(f"classes must be a subset of {DEFAULT_CLASSES} (got {classes})")
    nc = len(classes)
    missing = 0
    for name, depth in (("gamma", 1), ("age", 1), ("band", 2)):
        arr = lut[name]
        if not isinstance(arr, list) or len(arr) != DIRS:
            errors.append(f"{name} must have {DIRS} directions")
            continue
        for d, row in enumerate(arr):
            if not isinstance(row, list) or len(row) != nc:
                errors.append(f"{name}[{d}] must have {nc} classes")
                continue
            for c, cell in enumerate(row):
                if cell is None:
                    if name == "gamma":
                        missing += 1
                    continue
                if not isinstance(cell, list) or len(cell) != len(GROUPS):
                    errors.append(f"{name}[{d}][{c}] must have {len(GROUPS)} groups")
                    continue
                vals = [v for g in cell for v in (g if depth == 2 else [g])]
                if depth == 2 and any(not isinstance(g, list) or len(g) != 2 for g in cell):
                    errors.append(f"band[{d}][{c}] must hold [min, max] pairs")
                if any(v is None or not isinstance(v, (int, float)) or not math.isfinite(v) for v in vals):
                    errors.append(f"{name}[{d}][{c}] has non-finite values")
                elif name == "gamma" and any(v < 0 for v in vals):
                    errors.append(f"gamma[{d}][{c}] has negative values")
    wind = lut["wind"]
    if not isinstance(wind, list) or len(wind) != DIRS:
        errors.append(f"wind must have {DIRS} directions")
    else:
        for d, w in enumerate(wind):
            if w is None:
                warnings.append(f"wind[{d}] missing")
            elif any(not isinstance(w.get(k), (int, float)) for k in ("s4", "s10", "dir4", "dir10")):
                errors.append(f"wind[{d}] needs s4, s10, dir4, dir10")
    if missing:
        warnings.append(f"{missing} of {DIRS * nc} gamma entries are null (meta.status: {lut['meta'].get('status')})")
    return errors, warnings


# ------------------------------------------------------------------ the headless sweep
async def run_sweep(args) -> dict | None:
    sys.path.insert(0, str(ROOT / "tests" / "browser"))
    try:
        from harness import DIST, browser_page, serve  # type: ignore
    except ImportError as e:  # pragma: no cover - dev dependency
        log.error("playwright harness unavailable (%s). pip install playwright && python -m playwright install chromium", e)
        return None
    query = "sweep=lut" + (f"&grid={args.grid}" if args.grid else "")
    with serve(DIST) as base:
        async with browser_page(1024, 768, log=lambda m: log.info("browser %s", m)) as page:
            url = f"{base}/index.html?{query}"
            log.info("opening %s", url)
            await page.goto(url, timeout=600_000)
            t0 = time.time()
            started = False
            last_log = 0.0
            while time.time() - t0 < args.timeout:
                lut = await page.evaluate("() => window.__lut || null")
                if lut:
                    log.info("LUT ready after %.0f s", time.time() - t0)
                    return lut
                prog = await page.evaluate("() => window.__lutProgress || null")
                if prog is None and not started and time.time() - t0 > args.start_wait:
                    has = await page.evaluate("() => typeof window.__z1_startLUT === 'function'")
                    if not has:
                        log.error("the page defines no window.__z1_startLUT (aero.js not loaded?)")
                        return None
                    log.warning("no sweep after %.0f s (main.js did not start it); starting it via window.__z1_startLUT()", args.start_wait)
                    await page.evaluate("() => { window.__z1_startLUT(); }")
                    started = True
                if prog is not None:
                    started = True
                if time.time() - last_log >= args.poll_log:
                    last_log = time.time()
                    if prog:
                        log.info("sweep %s: %s/%s done (%s failed), job %s %s %.0f %%, %s s elapsed, eta %s s",
                                 prog.get("grid"), prog.get("done"), prog.get("total"), prog.get("failed"), prog.get("job"),
                                 prog.get("stage"), 100 * (prog.get("prog") or 0), prog.get("elapsed_s"), prog.get("eta_s"))
                        for e in prog.get("errors") or []:
                            log.warning("job error: %s", e)
                    else:
                        log.info("waiting for the sweep to start (%.0f s)", time.time() - t0)
                if page.errors:  # type: ignore[attr-defined]
                    log.error("page error: %s", page.errors[-1])  # type: ignore[attr-defined]
                    if args.fail_on_error:
                        return None
                await asyncio.sleep(args.poll)
            log.error("timeout after %.0f s", args.timeout)
            return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--grid", choices=["coarse", "fine"], help="fine grid: coarse = 10 m, fine = 5 m (default: the app's choice)")
    ap.add_argument("--timeout", type=float, default=6 * 3600, help="seconds to wait for the sweep (default 6 h)")
    ap.add_argument("--start-wait", type=float, default=120, help="seconds before starting the sweep ourselves")
    ap.add_argument("--poll", type=float, default=5, help="seconds between polls")
    ap.add_argument("--poll-log", type=float, default=30, help="seconds between progress log lines")
    ap.add_argument("--out", type=Path, default=SRC_DATA / "lut_receptor.json")
    ap.add_argument("--no-build", action="store_true", help="use the existing dist/index.html")
    ap.add_argument("--allow-incomplete", action="store_true", help="write the LUT even if Gamma entries are missing")
    ap.add_argument("--fail-on-error", action="store_true", help="stop at the first page error")
    ap.add_argument("--check", type=Path, help="only validate an existing LUT file and exit")
    args = ap.parse_args()

    if args.check:
        lut = json.loads(args.check.read_text(encoding="utf-8"))
        errors, warnings = validate_lut(lut)
        for w in warnings:
            log.warning(w)
        for e in errors:
            log.error(e)
        log.info("%s: %s (%s)", args.check, "OK" if not errors else "INVALID", lut.get("meta", {}).get("grid"))
        return 1 if errors else 0

    if not args.no_build:
        subprocess.run([sys.executable, str(ROOT / "tools" / "build.py")], check=True)
    lut = asyncio.run(run_sweep(args))
    if not lut:
        return 2
    errors, warnings = validate_lut(lut)
    for w in warnings:
        log.warning(w)
    if errors:
        for e in errors:
            log.error(e)
        dump = args.out.with_suffix(".invalid.json")
        write_json(dump, lut, compact=False)
        log.error("invalid LUT written to %s for inspection", dump)
        return 1
    if not lut["meta"].get("complete") and not args.allow_incomplete:
        dump = args.out.with_suffix(".incomplete.json")
        write_json(dump, lut, compact=False)
        log.error("incomplete LUT (%s); written to %s. Use --allow-incomplete to install it.", lut["meta"].get("status"), dump)
        return 1
    n = write_json(args.out, lut, compact=False)
    timing = lut["meta"].get("timing") or {}
    log.info("wrote %s (%.1f kB), grid %s, %s jobs in %s s", args.out, n / 1024, lut["meta"].get("grid"), timing.get("jobs"), timing.get("total_s"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
