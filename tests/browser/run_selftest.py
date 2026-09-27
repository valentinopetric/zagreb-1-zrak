"""Build dist/test.html and run the in-page test suite in headless Chromium.

    python3 tests/browser/run_selftest.py                 # all tests
    python3 tests/browser/run_selftest.py --only chem     # tests whose name contains "chem"
    python3 tests/browser/run_selftest.py --skip-slow     # skip { slow: true } tests (GPU verification on full grids)
    python3 tests/browser/run_selftest.py --timeout 1800  # seconds (SwiftShader is slow)

Exit code 0 when every test passed. The JSON report goes to dist/selftest.json.
"""
import argparse
import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import DIST, ROOT, browser_page, serve  # noqa: E402


async def run(args) -> int:
    subprocess.run([sys.executable, str(ROOT / "tools" / "build.py"), "--test"], check=True)
    q = "selftest"
    if args.only:
        q += f"&only={args.only}"
    if args.skip_slow:
        q += "&skip-slow"
    with serve(DIST) as base:
        async with browser_page() as page:
            await page.goto(f"{base}/test.html?{q}")
            t0 = time.time()
            res = None
            while time.time() - t0 < args.timeout:
                res = await page.evaluate("() => window.__selftest || null")
                if res and res.get("done"):
                    break
                await asyncio.sleep(1.0)
            if not res or not res.get("done"):
                print("TIMEOUT: selftest did not finish", file=sys.stderr)
                partial = await page.evaluate("() => (document.getElementById('selftest-out') || {}).textContent || ''")
                print(partial)
                return 2
            (DIST / "selftest.json").write_text(json.dumps(res, indent=1), encoding="utf-8")
            for r in res["results"]:
                line = f"{r['status'].upper():7s} {r['name']}" + (f" ({r.get('ms')} ms)" if r.get("ms") is not None else "")
                print(line)
                if r.get("error"):
                    print("        " + r["error"].replace("\n", "\n        "))
                if r.get("info"):
                    print("        " + json.dumps(r["info"]))
            if page.errors:
                print(f"{len(page.errors)} page errors", file=sys.stderr)
            print(f"\n{res['passed']} passed, {res['failed']} failed")
            return 0 if res["failed"] == 0 and not page.errors else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--skip-slow", action="store_true")
    ap.add_argument("--timeout", type=float, default=1800)
    sys.exit(asyncio.run(run(ap.parse_args())))


if __name__ == "__main__":
    main()
