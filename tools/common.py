"""Shared helpers for every tools/*.py script (Python 3.10+, standard library only).

- Paths: ROOT, CONFIG, CACHE (gitignored raw downloads), PROCESSED, SRC_DATA.
- SITE: the parsed config/site.json (the single source of truth for constants).
- Frame: xz(lat, lon) -> (x east, z south) in metres, the one frame every layer uses.
- HTTP: get() with a User-Agent, retries with back-off (including HTTP 429), optional pacing
  per host and an on-disk cache keyed by URL.
- Geometry: RDP simplification and polygon helpers shared by the geometry scripts.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "site.json"
CACHE = ROOT / "data" / "cache"          # raw downloads, gitignored
PROCESSED = ROOT / "data" / "processed"  # tidy, committed derived tables
SRC_DATA = ROOT / "src" / "data"         # what the page embeds

SITE = json.loads(CONFIG.read_text(encoding="utf-8"))
FRAME = SITE["frame"]
LAT0, LON0, KX, KY = FRAME["lat0"], FRAME["lon0"], FRAME["kx"], FRAME["ky"]

USER_AGENT = f"{SITE['repo']}-tools/1.0 (+https://github.com/; air-quality research, contact via repo)"

log = logging.getLogger("tools")
if not log.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")


# ------------------------------------------------------------------ frame
def xz(lat: float, lon: float) -> tuple[float, float]:
    """WGS84 lat/lon -> local metres. x = east, z = south (three.js convention, y up)."""
    return ((lon - LON0) * KX, -(lat - LAT0) * KY)


def latlon(x: float, z: float) -> tuple[float, float]:
    """Inverse of xz()."""
    return (LAT0 - z / KY, LON0 + x / KX)


def bbox_latlon(half_m: float) -> tuple[float, float, float, float]:
    """(south, west, north, east) of a square of half-size half_m around the origin."""
    s, w = latlon(-half_m, half_m)
    n, e = latlon(half_m, -half_m)
    return (min(s, n), min(w, e), max(s, n), max(w, e))


# ------------------------------------------------------------------ http
_last_call: dict[str, float] = {}


def _cache_path(url: str, suffix: str) -> Path:
    h = hashlib.sha1(url.encode("utf-8")).hexdigest()[:20]
    host = urllib.parse.urlparse(url).netloc.replace(":", "_")
    return CACHE / "http" / host / f"{h}{suffix}"


def get(url: str, *, data: bytes | None = None, headers: dict | None = None, cache: bool = True,
        pace_s: float = 0.0, retries: int = 6, timeout: float = 120.0, suffix: str = ".bin",
        max_age_s: float | None = None) -> bytes:
    """HTTP GET (or POST when data is given) with caching, pacing and retries.

    cache: store the body under data/cache/http/<host>/<sha1>; a cached body younger than max_age_s
           (or any age when max_age_s is None) is returned without a request.
    pace_s: minimum seconds between two requests to the same host (ISZZ needs >= 1.1 s).
    """
    key = url + ("#POST:" + hashlib.sha1(data).hexdigest() if data else "")
    path = _cache_path(key, suffix)
    if cache and path.exists():
        if max_age_s is None or time.time() - path.stat().st_mtime < max_age_s:
            return path.read_bytes()
    host = urllib.parse.urlparse(url).netloc
    delay = 2.0
    for attempt in range(retries):
        wait = _last_call.get(host, 0) + pace_s - time.time()
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            _last_call[host] = time.time()
            if cache:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)
            return body
        except urllib.error.HTTPError as e:
            _last_call[host] = time.time()
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                log.warning("HTTP %s for %s, retry in %.0f s", e.code, url[:120], delay)
                time.sleep(delay)
                delay = min(delay * 2, 60)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            _last_call[host] = time.time()
            if attempt < retries - 1:
                log.warning("%s for %s, retry in %.0f s", e, url[:120], delay)
                time.sleep(delay)
                delay = min(delay * 2, 60)
                continue
            raise
    raise RuntimeError("unreachable")


def get_json(url: str, **kw):
    return json.loads(get(url, suffix=".json", **kw).decode("utf-8"))


# ------------------------------------------------------------------ geometry
def rdp(pts: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """Ramer-Douglas-Peucker for an open polyline (keeps the end points)."""
    if len(pts) < 3:
        return list(pts)
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, z1), (x2, z2) = pts[a], pts[b]
        dx, dz = x2 - x1, z2 - z1
        L = math.hypot(dx, dz) or 1e-12
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            x, z = pts[i]
            d = abs(dz * (x - x1) - dx * (z - z1)) / L
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def simplify_ring(ring: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """RDP for a closed ring given without the repeated end point. Returns >= 3 points or []."""
    if len(ring) and ring[0] == ring[-1]:
        ring = ring[:-1]
    if len(ring) < 4:
        return list(ring) if len(ring) == 3 else []
    far = max(range(len(ring)), key=lambda i: math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]))
    a = rdp(ring[:far + 1], tol)
    b = rdp(ring[far:] + [ring[0]], tol)
    out = a[:-1] + b[:-1]
    return out if len(out) >= 3 else []


def ring_area(ring) -> float:
    """Signed shoelace area (positive = counter-clockwise in x/z)."""
    s = 0.0
    for i in range(len(ring)):
        x1, z1 = ring[i]
        x2, z2 = ring[(i + 1) % len(ring)]
        s += x1 * z2 - x2 * z1
    return s / 2


def centroid(ring) -> tuple[float, float]:
    n = len(ring)
    return (sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n)


def round_pts(pts, nd: int = 1):
    return [[round(x, nd), round(z, nd)] for x, z in pts]


def write_json(path: Path, obj, *, compact: bool = True) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False) if compact else json.dumps(obj, indent=1, ensure_ascii=False)
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def utcnow_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
