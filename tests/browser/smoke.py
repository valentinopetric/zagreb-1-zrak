"""End-to-end smoke test: load dist/index.html, wait for the app to report ready, screenshot it.

    python3 tests/browser/smoke.py [--wait 120] [--out dist/smoke.png] [--query "grid=coarse"] [--width 1440 --height 900]

The app sets window.__z1 = { ready, errors, fields, receptor } (see docs/architecture.md §6.4).
Passes when: no page errors, ready === true within --wait seconds, and (unless --no-field) at least
one wind+concentration field was computed with a finite, non-negative receptor value.
"""
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


async def run(a) -> int:
    if not a.no_build:
        subprocess.run([sys.executable, str(ROOT / "tools" / "build.py")], check=True)
    with serve(DIST) as base:
        async with browser_page(a.width, a.height) as page:
            await page.goto(f"{base}/index.html?{a.query}")
            t0, st = time.time(), None
            while time.time() - t0 < a.wait:
                st = await page.evaluate("() => window.__z1 ? JSON.parse(JSON.stringify(window.__z1)) : null")
                if st and st.get("ready") and (a.no_field or st.get("fields", 0) > 0):
                    break
                await asyncio.sleep(2.0)
            print(json.dumps(st, indent=1)[:4000])
            await page.screenshot(path=a.out, timeout=240000)
            print(f"screenshot -> {a.out}")
            ok = bool(st and st.get("ready")) and not page.errors
            if not a.no_field:
                rec = (st or {}).get("receptor")
                ok = ok and (st or {}).get("fields", 0) > 0 and isinstance(rec, (int, float)) and math.isfinite(rec) and rec >= 0
            print("SMOKE", "PASS" if ok else "FAIL", f"({len(page.errors)} page errors)")
            return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wait", type=float, default=240)
    ap.add_argument("--out", default=str(DIST / "smoke.png"))
    ap.add_argument("--query", default="")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--no-field", action="store_true")
    ap.add_argument("--no-build", action="store_true")
    sys.exit(asyncio.run(run(ap.parse_args())))


if __name__ == "__main__":
    main()
