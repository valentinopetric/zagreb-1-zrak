"""End-to-end integration check: today's field AND a geometry scenario's field, both views, two screen sizes.

    python3 tests/browser/e2e.py                                   # grid chosen by the browser, scenario 'trees'
    python3 tests/browser/e2e.py --query "grid=coarse&live=0"      # 10 m grid, archive only (deterministic)
    python3 tests/browser/e2e.py --query "grid=fine" --wait 2400   # 5 m grid (slow on software WebGL)
    python3 tests/browser/e2e.py --scenario block --out dist/e2e_block

What smoke.py does not check, this does (docs/architecture.md §6.4, integration review 2026-09-28):

1. boot (window.__z1.ready) and the first Aero field for 'today' (window.__z1.fields > 0);
2. select a geometry scenario in the #scenario control and wait until the page holds a receptor result for it
   (window.__z1dbg.recv has a key "<scenario>|dir|group"); `?debug` is added to the query for that;
3. read both views' modelled NO2 at the station inlet (window.__z1dbg.res) and require finite, non-negative values,
   and a scenario coverage > 0 (the scenario's own field is used for its direction);
4. screenshots at 1440×900 (<out>_1440.png) and 390×844 (<out>_390.png), and no horizontal scroll at 390 px;
5. no page errors and no entries in window.__z1.errors.

The JSON report goes to <out>.json. Exit code 0 when every check passed. Needs playwright (dev only) as the other
browser tests; SwiftShader runs the GPU parts, slowly (about 1 min per field at 10 m, 5–7 min at 5 m).
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
from harness import DIST, ROOT, browser_page, serve  # noqa: E402

# A compact, JSON-safe summary of the page state (numbers of both views, keys the page holds, Aero progress).
JS_STATE = """() => {
  const d = window.__z1dbg, z = window.__z1;
  if (!d || !z) return null;
  const pick = (v) => { const r = d.res[v]; if (!r || !r.c) return null; const c = r.c, m = c.meta || {};
    return { no2: c.no2, nox: c.nox, inc_nox: c.inc && c.inc.nox, source: m.source, coverage: m.coverage, beta: m.beta, status: m.status }; };
  return { ready: z.ready, fields: z.fields, receptor: z.receptor, errors: z.errors, recv: [...d.recv.keys()],
    pending: [...d.pending], today: pick('today'), scenario: pick('scenario'), scen: d.state.scenario };
}"""


async def wait_for(page, cond_js: str, timeout: float, every: float, label: str) -> float:
    """Poll a JS predicate until it is truthy; returns the seconds waited. Raises TimeoutError."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if await page.evaluate(cond_js):
            return time.time() - t0
        await asyncio.sleep(every)
    raise TimeoutError(f"{label} not reached within {timeout:.0f} s")


def finite(x) -> bool:
    return isinstance(x, (int, float)) and math.isfinite(x) and x >= 0


async def run(a) -> int:
    if not a.no_build:
        subprocess.run([sys.executable, str(ROOT / "tools" / "build.py")], check=True)
    out = Path(a.out)
    rep: dict = {"query": a.query, "scenario": a.scenario, "checks": {}}
    ok = True
    with serve(DIST) as base:
        async with browser_page(1440, 900, log=lambda m: None if "GL Driver" in m else print(m)) as page:
            q = f"{a.query}&debug" if a.query else "debug"
            await page.goto(f"{base}/index.html?{q}")
            t0 = time.time()
            try:
                rep["t_ready_s"] = await wait_for(page, "() => !!(window.__z1 && window.__z1.ready)", 300, 1, "ready")
                rep["t_today_field_s"] = await wait_for(page, "() => window.__z1.fields > 0", a.wait, 3, "today field")
                await asyncio.sleep(3)
                rep["after_today"] = await page.evaluate(JS_STATE)
                await page.select_option("#scenario", a.scenario)
                rep["t_scenario_field_s"] = await wait_for(
                    page, f"() => [...window.__z1dbg.recv.keys()].some((k) => k.startsWith('{a.scenario}|'))", a.wait, 3, "scenario field")
                await asyncio.sleep(4)
                rep["after_scenario"] = st = await page.evaluate(JS_STATE)
                c = rep["checks"]
                c["today_no2_finite"] = finite((st.get("today") or {}).get("no2"))
                c["scenario_no2_finite"] = finite((st.get("scenario") or {}).get("no2"))
                c["scenario_coverage_positive"] = ((st.get("scenario") or {}).get("coverage") or 0) > 0
                c["receptor_finite"] = finite(st.get("receptor"))
                c["no_app_errors"] = not st.get("errors")
            except TimeoutError as e:
                rep["timeout"] = str(e)
                ok = False
            await page.evaluate("() => window.scrollTo(0, 0)")
            await asyncio.sleep(3)
            await page.screenshot(path=f"{out}_1440.png", timeout=240000)
            await page.set_viewport_size({"width": 390, "height": 844})
            await asyncio.sleep(6)
            await page.screenshot(path=f"{out}_390.png", timeout=240000)
            sw = await page.evaluate("() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]")
            rep["checks"]["no_horizontal_scroll_390"] = sw[0] <= sw[1]
            rep["page_errors"] = list(page.errors)
            rep["checks"]["no_page_errors"] = not page.errors
            rep["total_s"] = round(time.time() - t0, 1)
    ok = ok and all(rep["checks"].values())
    rep["pass"] = ok
    out.with_suffix(".json").write_text(json.dumps(rep, indent=1), encoding="utf-8")
    print(json.dumps({k: rep[k] for k in rep if k not in ("after_today",)}, indent=1)[:6000])
    print(f"screenshots -> {out}_1440.png, {out}_390.png")
    print("E2E", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--query", default="", help="extra URL parameters, e.g. 'grid=coarse&live=0'")
    ap.add_argument("--scenario", default="trees", help="a geometry scenario id of city.js SCENARIOS (default trees)")
    ap.add_argument("--wait", type=float, default=900, help="seconds to wait for each field (default 900)")
    ap.add_argument("--out", default=str(DIST / "e2e"), help="path prefix of the screenshots and the JSON report")
    ap.add_argument("--no-build", action="store_true")
    sys.exit(asyncio.run(run(ap.parse_args())))


if __name__ == "__main__":
    main()
