"""Inline style, site config, scene data, measurements, calibration and app code into one HTML file.

    python3 tools/build.py          # src/ -> dist/index.html (the published page)
    python3 tools/build.py --test   # also dist/test.html = page + src/js/tests/*.test.js + run.js (?selftest)

src/page.html is a fragment: everything before '\n<div id="app">' goes into <head>, the rest into <body>.
Placeholders (each must appear exactly once in page.html):
    {{STYLE}} {{SITE}} {{ENV}} {{MEAS}} {{CAL}} {{LUT}} {{LOD2}} {{APP}}
All JS files in ORDER are joined into ONE ES module and share its top-level scope (like the reference
repo maksimir-pod-kisom), so the order below is the dependency order.
"""
import base64
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC, DIST, DATA = ROOT / "src", ROOT / "dist", ROOT / "src" / "data"

# Dependency order of the shared-scope module. See docs/architecture.md §3.
ORDER = [
    "i18n.js",        # UI agent: STRINGS + t() registry (I18N.add used by every other file)
    "core.js",        # imports, SITE/ENV/MEAS/CAL/LUT, utils, test registry
    "meteo.js",       # pure: stability, directions, sun, kernels
    "chemistry.js",   # pure: NO-NO2-O3, units, thresholds, EAQI
    "emissions.js",   # pure: traffic profiles, emission factors, group source strengths
    "model.js",       # pure: combine LUT/fields + emissions + chemistry + background
    "fallback.js",    # CPU Gaussian/OSPM model (no float render targets)
    "scene.js",       # renderer, scene, lights, sky, materials, geometry helpers
    "city.js",        # buildings (LoD1/LoD2), roads, trees, station, scenarios
    "voxel.js",       # tunnel frames, voxeliser, source rasteriser, wall distance
    "wind-tunnel.js", # GPU LBM D3Q19 (adapted from maksimir-pod-kisom, MIT)
    "scalar.js",      # GPU steady advection-diffusion (4 groups + 4 age tracers)
    "aero.js",        # job queue: wind -> scalar per (scenario, direction, stability), caches, LUT export
    "data.js",        # live ISZZ / Open-Meteo / CAMS clients, baked history access, time helpers
    "charts.js",      # SVG charts
    "visuals.js",     # concentration slice, particles, wind streaks, labels, legends
    "main.js",        # state, UI, views, boot, frame loop
]
PLACEHOLDERS = ["{{STYLE}}", "{{SITE}}", "{{ENV}}", "{{MEAS}}", "{{CAL}}", "{{LUT}}", "{{LOD2}}", "{{APP}}"]
DEFAULT_CAL = {"status": "uncalibrated", "beta": 1.0, "U0": 1.4, "h_min": 100, "f_no2": 0.10,
               "note": "Prior values; run tools/calibrate.py after exporting the receptor LUT."}


def script_json(text: str) -> str:
    """Make JSON safe inside <script type="application/json">."""
    return text.replace("</", "<\\/")


def read_json_text(path: Path, default) -> str:
    if path.exists():
        return path.read_text(encoding="utf-8")
    return json.dumps(default)


def app_code(test: bool) -> str:
    parts = []
    for f in ORDER:
        p = SRC / "js" / f
        if not p.exists():
            raise SystemExit(f"missing src/js/{f}")
        parts.append(f"// ===== {f} =====\n" + p.read_text(encoding="utf-8"))
    if test:
        for p in sorted((SRC / "js" / "tests").glob("*.test.js")):
            parts.append(f"// ===== tests/{p.name} =====\n" + p.read_text(encoding="utf-8"))
        parts.append("// ===== tests/run.js =====\n" + (SRC / "js" / "tests" / "run.js").read_text(encoding="utf-8"))
    return "\n".join(parts)


def body(test: bool) -> str:
    page = (SRC / "page.html").read_text(encoding="utf-8")
    for ph in PLACEHOLDERS:
        n = page.count(ph)
        if n != 1:
            raise SystemExit(f"src/page.html must contain {ph} exactly once (found {n})")
    lod2 = DATA / "lod2.bin"
    subs = {
        "{{STYLE}}": (SRC / "style.css").read_text(encoding="utf-8"),
        "{{SITE}}": script_json((ROOT / "config" / "site.json").read_text(encoding="utf-8")),
        "{{ENV}}": script_json((DATA / "env.json").read_text(encoding="utf-8")),
        "{{MEAS}}": script_json(read_json_text(DATA / "measurements.json", None)),
        "{{CAL}}": script_json(read_json_text(DATA / "calibration.json", DEFAULT_CAL)),
        "{{LUT}}": script_json(read_json_text(DATA / "lut_receptor.json", None)),
        "{{LOD2}}": base64.b64encode(lod2.read_bytes()).decode() if lod2.exists() else "",
        "{{APP}}": app_code(test),
    }
    # Substitute the code last so that placeholder-like text inside data or code is never touched.
    for ph in PLACEHOLDERS:
        if ph == "{{APP}}":
            continue
        page = page.replace(ph, subs[ph])
    return page.replace("{{APP}}", subs["{{APP}}"])


def wrap(b: str, lang: str = "hr") -> str:
    site = json.loads((ROOT / "config" / "site.json").read_text(encoding="utf-8"))
    desc = ("3D simulacija strujanja zraka i onečišćenja oko mjerne postaje Zagreb-1 (Vukovarska × Miramarska), "
            "s mjerenjima iz ISZZ-a, 3D modelom grada ZG3D i prognozom.")
    head, app = b.split('\n<div id="app">', 1)
    return ('<!doctype html>\n<html lang="' + lang + '">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            f'<meta name="description" content="{desc}">\n'
            f'<meta property="og:title" content="{site["name"]} · Zagreb-1">\n'
            f'<meta property="og:description" content="{desc}">\n'
            + head + '\n</head>\n<body>\n<div id="app">' + app + "\n</body>\n</html>\n")


def main():
    test = "--test" in sys.argv
    DIST.mkdir(exist_ok=True)
    out = wrap(body(False))
    (DIST / "index.html").write_text(out, encoding="utf-8")
    print(f"built dist/index.html {len(out.encode()) / 1024:.0f} KB")
    if test:
        t = wrap(body(True))
        (DIST / "test.html").write_text(t, encoding="utf-8")
        print(f"built dist/test.html {len(t.encode()) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
