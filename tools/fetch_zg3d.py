#!/usr/bin/env python3
"""fetch_zg3d.py - ZG3D 2022 building parts (LoD2 multipatch + LoD1 footprints) for the scene box.

Source (critic §4.1 D11, lidar-3d §3.2)
    City of Zagreb, "ZG3D 2022 3D model Grada Zagreba": LoD2.2 building parts re-modelled against the 2022
    national LiDAR survey (22 % of the parts in our box carry source "Multisenzorsko snimanje" = LiDAR +
    photogrammetry 2022, the rest 2008 aerial photogrammetry or 2019 drone; critic G2). Anonymous ArcGIS
    FeatureServer, Otvorena dozvola (Croatian Open Licence). The URL is SITE.zg3d.feature_server.

Two queries, both paged and cached raw in data/cache/zg3d/raw/
    lod2_<offset>.json   multipatchOption=embedMaterials, returnZ, outSR=4326, 500 features per page.
                         Each feature has geometry.binaryPatches (base64 Esri shape buffer, zlib-compressed)
                         with the full roof and wall faces. Without multipatchOption the server returns
                         rings with z = 0 (lidar-3d §3.2 "pitfall").
    fp_<offset>.geojson  multipatchOption=xyFootprint, f=geojson, outSR=4326, 2000 per page (maxRecordCount):
                         the 2D footprint of every part plus its attributes (OBJECTID, Godina_izv = source
                         year, Izvor = source, Z_Min, Z_Max, Z_Delta, SArea, Volume).
    Both are requested in lon/lat (outSR=4326) so that EVERY coordinate goes through common.xz(), the one
    frame of the repo (critic §1.11, §4.2). Z is HVRS71 orthometric height (m a.s.l.).

Also here (used by build_env.py and the unit tests)
    decode_binary_patches()  stdlib decoder of the Esri extended shape buffer (base64 + zlib + struct)
    load_parts()             decoded LoD2 parts in the local frame
    load_footprints()        LoD1 footprints (outer ring + holes) in the local frame
    triangulate_patches()    triangles for every multipatch part type: TriangleStrip, TriangleFan,
                             Triangles, and OuterRing/InnerRing and FirstRing/Ring polygons (with holes),
                             via a small 3D ear-clipping triangulator (project onto the best-fit plane)

Usage
    python3 tools/fetch_zg3d.py              # fetch missing pages, verify the count, write fetch_meta.json
    python3 tools/fetch_zg3d.py --refresh    # re-download every page
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import struct
import sys
import time
import urllib.parse
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CACHE, SITE, bbox_latlon, get, log, utcnow_iso, write_json, xz  # noqa: E402

ZG3D_DIR = CACHE / "zg3d"
RAW_DIR = ZG3D_DIR / "raw"
META_JSON = ZG3D_DIR / "fetch_meta.json"
SERVICE = SITE["zg3d"]["feature_server"]            # .../FeatureServer/0/query
LAYER = SERVICE.rsplit("/", 1)[0]                   # .../FeatureServer/0
PAGE_3D = 500        # the 3D pages are large (up to ~6 MB JSON); 500 keeps each request < ~30 s (lidar-3d §3.2)
PAGE_FP = 2000       # = the layer's maxRecordCount (lidar-3d §3.2)

# Esri multipatch part types (low 4 bits of the part type word; Esri "Extended Shapefile" spec)
TRIANGLE_STRIP, TRIANGLE_FAN, OUTER_RING, INNER_RING, FIRST_RING, RING, TRIANGLES = range(7)
PART_NAMES = {0: "TriangleStrip", 1: "TriangleFan", 2: "OuterRing", 3: "InnerRing", 4: "FirstRing",
              5: "Ring", 6: "Triangles"}


# ------------------------------------------------------------------ query and paging
def envelope(half: float) -> str:
    """xmin,ymin,xmax,ymax in lon/lat of the local square |x|,|z| <= half (common.bbox_latlon)."""
    s, w, n, e = bbox_latlon(half)
    return f"{w},{s},{e},{n}"


def query_url(kind: str, offset: int, half: float) -> str:
    """The FeatureServer query for one page. kind = 'lod2' (3D multipatch) or 'fp' (2D footprints)."""
    q = {"where": "1=1", "geometry": envelope(half), "geometryType": "esriGeometryEnvelope", "inSR": 4326,
         "outSR": 4326, "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "returnGeometry": "true",
         "orderByFields": "OBJECTID", "resultOffset": offset}
    if kind == "lod2":
        q.update(returnZ="true", multipatchOption="embedMaterials", resultRecordCount=PAGE_3D, f="json")
    else:
        q.update(multipatchOption="xyFootprint", resultRecordCount=PAGE_FP, f="geojson")
    return SERVICE + "?" + urllib.parse.urlencode(q)


def count_url(half: float) -> str:
    """returnCountOnly query for the same envelope (completeness check of the paging)."""
    q = {"where": "1=1", "geometry": envelope(half), "geometryType": "esriGeometryEnvelope", "inSR": 4326,
         "spatialRel": "esriSpatialRelIntersects", "returnCountOnly": "true", "f": "json"}
    return SERVICE + "?" + urllib.parse.urlencode(q)


def page_path(kind: str, offset: int) -> Path:
    """Cache file of one raw page."""
    return RAW_DIR / (f"lod2_{offset:05d}.json" if kind == "lod2" else f"fp_{offset:05d}.geojson")


def fetch_pages(kind: str, half: float, refresh: bool = False) -> int:
    """Download all pages of one query into RAW_DIR (skipping cached ones). Returns the feature count."""
    offset, total = 0, 0
    while True:
        path = page_path(kind, offset)
        if path.exists() and not refresh:
            body = path.read_bytes()
        else:
            t = time.time()
            body = get(query_url(kind, offset, half), cache=False, timeout=300, pace_s=0.5)
            d = json.loads(body)
            if "error" in d:
                raise SystemExit(f"ZG3D error: {d['error']}")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
            log.info("zg3d %s offset %d: %d features, %.0f KB, %.1f s", kind, offset, len(d.get("features", [])),
                     len(body) / 1024, time.time() - t)
        d = json.loads(body)
        feats = d.get("features", [])
        total += len(feats)
        more = d.get("exceededTransferLimit") or d.get("properties", {}).get("exceededTransferLimit")
        if not feats or not more:
            break
        offset += len(feats)
    # remove stale pages beyond the end (e.g. after the box shrank)
    for p in RAW_DIR.glob(("lod2_" if kind == "lod2" else "fp_") + "*"):
        if int(p.stem.split("_")[1]) > offset:
            p.unlink()
    return total


def raw_pages(kind: str) -> list[dict]:
    """All cached raw pages of one query, in offset order."""
    files = sorted(RAW_DIR.glob("lod2_*.json" if kind == "lod2" else "fp_*.geojson"))
    if not files:
        raise SystemExit(f"no cached ZG3D {kind} pages in {RAW_DIR}: run tools/fetch_zg3d.py first")
    return [json.loads(p.read_bytes()) for p in files]


# ------------------------------------------------------------------ binaryPatches decoder
def decode_binary_patches(b64: str) -> list[tuple[int, list[tuple[float, float, float]]]]:
    """Decode an Esri `binaryPatches` string into [(part_type, [(X, Y, Z), ...]), ...].

    Layout (lidar-3d §3.2; Esri extended shape buffer):
        outer header : uint32 shape type (0xC0800036 = GeneralMultiPatch | HasZ | HasM),
                       int32 uncompressed size, int32 compressed size, then the zlib stream
        shape buffer : int32 type, 4 x double bbox, int32 nParts, int32 nPoints,
                       int32 parts[nParts] (first point of each part), int32 partTypes[nParts],
                       2 x nPoints doubles (X, Y), 2 doubles Z range, nPoints doubles Z, (M, normals, ...)
    X/Y are in the requested outSR (here lon/lat degrees), Z in metres. Part types use the low 4 bits.
    """
    b = base64.b64decode(b64)
    _stype, usize, csize = struct.unpack_from("<Iii", b, 0)
    raw = zlib.decompress(b[12:12 + csize]) if csize > 0 else b[12:12 + usize]
    if usize > 0 and len(raw) != usize:
        raise ValueError(f"binaryPatches: size mismatch {len(raw)} != {usize}")
    o = 4 + 32                                   # inner shape type + bbox
    nparts, npts = struct.unpack_from("<ii", raw, o)
    o += 8
    parts = struct.unpack_from("<%di" % nparts, raw, o)
    o += 4 * nparts
    ptypes = struct.unpack_from("<%di" % nparts, raw, o)
    o += 4 * nparts
    xy = struct.unpack_from("<%dd" % (2 * npts), raw, o)
    o += 16 * npts
    o += 16                                      # z range
    zs = struct.unpack_from("<%dd" % npts, raw, o)
    out = []
    for i, start in enumerate(parts):
        end = parts[i + 1] if i + 1 < nparts else npts
        out.append((ptypes[i] & 0xF, [(xy[2 * k], xy[2 * k + 1], zs[k]) for k in range(start, end)]))
    return out


def _year(v) -> int:
    """Godina_izv is a string such as '2008'; anything else -> 0 (unknown)."""
    try:
        return int(str(v).strip()[:4])
    except (TypeError, ValueError):
        return 0


def load_parts() -> list[dict]:
    """All cached LoD2 parts in the local frame.

    Returns [{'id', 'year', 'src', 'zmin', 'zmax', 'patches': [(type, [(x, z, Z), ...]), ...]}] where
    (x, z) = common.xz(lat, lon) and Z is the absolute height (m a.s.l.).
    """
    parts, seen = [], set()
    for page in raw_pages("lod2"):
        for f in page.get("features", []):
            a, g = f["attributes"], f.get("geometry") or {}
            if a["OBJECTID"] in seen or "binaryPatches" not in g:
                continue
            seen.add(a["OBJECTID"])
            patches = []
            for ptype, pts in decode_binary_patches(g["binaryPatches"]):
                patches.append((ptype, [(*xz(lat, lon), Z) for lon, lat, Z in pts]))
            parts.append({"id": a["OBJECTID"], "year": _year(a.get("Godina_izv")), "src": a.get("Izvor") or "",
                          "zmin": a.get("Z_Min"), "zmax": a.get("Z_Max"), "patches": patches})
    return parts


def load_footprints() -> list[dict]:
    """All cached xyFootprint features in the local frame.

    Returns [{'id', 'year', 'src', 'zmin', 'zmax', 'polys': [[outer, hole, hole, ...], ...]}] with rings as
    [(x, z), ...] lists without the repeated end point.
    """
    out, seen = [], set()
    for page in raw_pages("fp"):
        for f in page.get("features", []):
            a, g = f.get("properties") or {}, f.get("geometry")
            oid = a.get("OBJECTID", f.get("id"))
            if oid in seen or not g:
                continue
            seen.add(oid)
            polys_ll = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
            polys = []
            for poly in polys_ll:
                rings = []
                for ring in poly:
                    pts = [xz(lat, lon) for lon, lat, *_ in ring]
                    if len(pts) > 1 and pts[0] == pts[-1]:
                        pts = pts[:-1]
                    if len(pts) >= 3:
                        rings.append(pts)
                if rings:
                    polys.append(rings)
            out.append({"id": oid, "year": _year(a.get("Godina_izv")), "src": a.get("Izvor") or "",
                        "zmin": a.get("Z_Min"), "zmax": a.get("Z_Max"), "polys": polys})
    return out


# ------------------------------------------------------------------ triangulation
Vec3 = tuple[float, float, float]


def newell_normal(pts: list[Vec3]) -> Vec3:
    """Newell's method: robust (unnormalised) normal of a planar or nearly planar 3D polygon.
    Its length is twice the polygon area (for a planar polygon)."""
    nx = ny = nz = 0.0
    m = len(pts)
    for i in range(m):
        x1, y1, z1 = pts[i]
        x2, y2, z2 = pts[(i + 1) % m]
        nx += (y1 - y2) * (z1 + z2)
        ny += (z1 - z2) * (x1 + x2)
        nz += (x1 - x2) * (y1 + y2)
    return nx, ny, nz


def _area2(a, b, c) -> float:
    """Twice the signed area of the 2D triangle abc (> 0 counter-clockwise)."""
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def signed_area_2d(ring) -> float:
    """Signed shoelace area of a 2D ring (> 0 counter-clockwise)."""
    s = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        s += x1 * y2 - x2 * y1
    return s / 2


def _point_in_tri(p, a, b, c, eps: float) -> bool:
    """p inside or on the triangle abc (CCW), with a small tolerance."""
    return _area2(a, b, p) >= -eps and _area2(b, c, p) >= -eps and _area2(c, a, p) >= -eps


def _bridge_holes(outer: list[int], holes: list[list[int]], P: list[tuple[float, float]]) -> list[int]:
    """Merge holes into the outer ring with zero-width bridges (Eberly 2008, "Triangulation by ear
    clipping", §3), giving one weakly simple polygon of vertex indices. Outer must be CCW, holes CW.

    For each hole (right-most first): cast a ray from its right-most vertex M towards +x, take the
    nearest crossed edge and its right-most end point as the bridge target; if a reflex vertex lies
    inside the triangle (M, hit point, target) it would block the bridge, so the blocking reflex vertex
    with the smallest angle to the ray is used instead. Positions (not vertex ids) are tracked because
    bridge vertices appear twice after a splice.
    """
    poly = list(outer)
    for hole in sorted(holes, key=lambda h: -max(P[i][0] for i in h)):
        mi = max(range(len(hole)), key=lambda k: (P[hole[k]][0], -P[hole[k]][1]))
        M = P[hole[mi]]
        n = len(poly)
        best_t, target = math.inf, None
        for k in range(n):
            a, b = P[poly[k]], P[poly[(k + 1) % n]]
            if not ((a[1] <= M[1] < b[1]) or (b[1] <= M[1] < a[1])):
                continue                                  # half-open rule: each crossing counted once
            t = a[0] + (M[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
            if t < M[0] or t - M[0] >= best_t:
                continue
            best_t = t - M[0]
            if a[1] == M[1]:
                target = k                                # the ray hits vertex a exactly: visible
            elif b[1] == M[1]:
                target = (k + 1) % n
            else:
                target = k if a[0] > b[0] else (k + 1) % n
        if target is None:
            continue                                      # hole outside the outer ring: ignore it
        I = (M[0] + best_t, M[1])
        C = P[poly[target]]
        tri = (M, I, C) if _area2(M, I, C) > 0 else (M, C, I)
        best_ang = None
        if C != I:
            for j in range(n):
                pv = P[poly[j]]
                if j == target or pv == C:
                    continue
                if _area2(P[poly[j - 1]], pv, P[poly[(j + 1) % n]]) >= 0:
                    continue                              # convex vertices cannot block the bridge
                if _point_in_tri(pv, *tri, 1e-12):
                    ang = abs(math.atan2(pv[1] - M[1], pv[0] - M[0]))
                    if best_ang is None or ang < best_ang:
                        best_ang, target = ang, j
        target = _wedge_copy(poly, target, M, P)
        loop = hole[mi:] + hole[:mi] + [hole[mi]]
        poly = poly[:target + 1] + loop + poly[target:]
    return poly


def _wedge_copy(poly: list[int], pos: int, M: tuple[float, float], P: list[tuple[float, float]]) -> int:
    """After earlier bridges a vertex can occur several times in `poly`. Return the position of the copy
    whose interior wedge (CCW sweep from the outgoing to the incoming edge) contains the direction to M,
    so that successive bridges nest instead of crossing (the same rule as earcut's sectorContainsSector)."""
    C = P[poly[pos]]
    copies = [j for j in range(len(poly)) if P[poly[j]] == C]
    if len(copies) == 1:
        return pos
    n = len(poly)
    d = (M[0] - C[0], M[1] - C[1])

    def cross(u, v):
        return u[0] * v[1] - u[1] * v[0]

    for j in copies:
        pa, pb = P[poly[j - 1]], P[poly[(j + 1) % n]]
        a = (pa[0] - C[0], pa[1] - C[1])               # towards the previous vertex (incoming edge)
        b = (pb[0] - C[0], pb[1] - C[1])               # towards the next vertex (outgoing edge)
        if cross(b, a) > 0:                            # convex wedge
            inside = cross(b, d) > 0 and cross(d, a) > 0
        else:                                          # reflex wedge
            inside = cross(b, d) > 0 or cross(d, a) > 0
        if inside:
            return j
    return pos


def ear_clip(poly: list[int], P: list[tuple[float, float]]) -> list[tuple[int, int, int]]:
    """Ear clipping of a CCW (weakly) simple polygon given as vertex indices into P. O(n^2).

    Collinear vertices are dropped without a triangle. If no ear is found (degenerate input) the most
    convex vertex is clipped so that the loop always terminates.
    """
    V = list(poly)
    tris: list[tuple[int, int, int]] = []
    scale = max(1e-9, max(abs(c) for i in V for c in P[i]))
    eps = 1e-12 * scale * scale
    guard = 0
    while len(V) > 3 and guard < 10 * len(poly) + 100:
        guard += 1
        n = len(V)
        clipped = False
        for k in range(n):
            ia, ib, ic = V[k - 1], V[k], V[(k + 1) % n]
            a, b, c = P[ia], P[ib], P[ic]
            cr = _area2(a, b, c)
            if abs(cr) <= eps:                        # collinear (or duplicate): remove the middle vertex
                V.pop(k)
                clipped = True
                break
            if cr < 0:
                continue                              # reflex
            ear = True
            for j in range(n):
                iv = V[j]
                if iv in (ia, ib, ic):
                    continue
                pv = P[iv]
                if pv == a or pv == b or pv == c:     # bridge duplicates coincide with a triangle corner
                    continue
                if _point_in_tri(pv, a, b, c, eps):   # inside OR on the boundary blocks the ear (as earcut):
                    ear = False                       # collinear hole edges must not be swallowed
                    break
            if ear:
                tris.append((ia, ib, ic))
                V.pop(k)
                clipped = True
                break
        if not clipped:                               # degenerate: clip the most convex vertex anyway
            n = len(V)
            k = max(range(n), key=lambda q: _area2(P[V[q - 1]], P[V[q]], P[V[(q + 1) % n]]))
            if _area2(P[V[k - 1]], P[V[k]], P[V[(k + 1) % n]]) > eps:
                tris.append((V[k - 1], V[k], V[(k + 1) % n]))
            V.pop(k)
    if len(V) == 3 and _area2(P[V[0]], P[V[1]], P[V[2]]) > eps:
        tris.append((V[0], V[1], V[2]))
    return tris


def _clean_ring(ring: list[Vec3], tol: float = 1e-6) -> list[Vec3]:
    """Drop consecutive duplicate vertices and the closing vertex(es) of a 3D ring."""
    out: list[Vec3] = []
    for p in ring:
        if not out or max(abs(p[0] - out[-1][0]), abs(p[1] - out[-1][1]), abs(p[2] - out[-1][2])) > tol:
            out.append(p)
    while len(out) > 1 and max(abs(out[0][i] - out[-1][i]) for i in range(3)) <= tol:
        out.pop()
    return out


def triangulate_polygon_3d(outer: list[Vec3], holes: list[list[Vec3]] = ()) -> list[tuple[Vec3, Vec3, Vec3]]:
    """Triangulate a planar 3D polygon (with optional holes) by projecting it onto its best-fit plane.

    The Newell normal of the outer ring picks the projection: the coordinate axis with the largest normal
    component is dropped. Returned triangles keep the orientation of the outer ring (same normal sense).
    """
    outer = _clean_ring(outer)
    holes = [h for h in (_clean_ring(h) for h in holes) if len(h) >= 3]
    if len(outer) < 3:
        return []
    nrm = newell_normal(outer)
    ax = max(range(3), key=lambda i: abs(nrm[i]))
    if abs(nrm[ax]) < 1e-12:
        return []
    u, v = [(1, 2), (2, 0), (0, 1)][ax]               # right-handed projection: (u, v, ax) is cyclic
    pts3 = list(outer) + [p for h in holes for p in h]
    P = [(p[u], p[v]) for p in pts3]
    flip = nrm[ax] < 0                                  # projected outer ring is CW -> work mirrored
    if flip:
        P = [(x, -y) for x, y in P]
    idx_outer = list(range(len(outer)))
    if signed_area_2d([P[i] for i in idx_outer]) < 0:
        idx_outer.reverse()
    idx_holes, s = [], len(outer)
    for h in holes:
        ids = list(range(s, s + len(h)))
        s += len(h)
        if signed_area_2d([P[i] for i in ids]) > 0:
            ids.reverse()
        idx_holes.append(ids)
    poly = _bridge_holes(idx_outer, idx_holes, P) if idx_holes else idx_outer
    tris = ear_clip(poly, P)
    return [(pts3[a], pts3[b], pts3[c]) for a, b, c in tris]


def triangulate_patches(patches: list[tuple[int, list[Vec3]]]) -> list[tuple[Vec3, Vec3, Vec3]]:
    """Triangles of one multipatch part list [(type, [(x, y, z), ...]), ...] (any coordinate order).

    - TriangleStrip: (v_i, v_i+1, v_i+2) with alternating winding restored.
    - TriangleFan:   (v_0, v_i, v_i+1).
    - Triangles:     consecutive triples.
    - OuterRing + following InnerRings, and FirstRing + following Rings: one polygon with holes.
    """
    out: list[tuple[Vec3, Vec3, Vec3]] = []
    group: list[list[Vec3]] | None = None

    def flush():
        if group:
            out.extend(triangulate_polygon_3d(group[0], group[1:]))

    for ptype, pts in patches:
        if ptype in (OUTER_RING, FIRST_RING):
            flush()
            group = [list(pts)]
        elif ptype in (INNER_RING, RING):
            if group is None:
                group = [list(pts)]
            else:
                group.append(list(pts))
        else:
            flush()
            group = None
            if ptype == TRIANGLE_STRIP:
                for i in range(len(pts) - 2):
                    a, b, c = pts[i], pts[i + 1], pts[i + 2]
                    out.append((a, b, c) if i % 2 == 0 else (b, a, c))
            elif ptype == TRIANGLE_FAN:
                for i in range(1, len(pts) - 1):
                    out.append((pts[0], pts[i], pts[i + 1]))
            elif ptype == TRIANGLES:
                for i in range(0, len(pts) - 2, 3):
                    out.append((pts[i], pts[i + 1], pts[i + 2]))
    flush()
    return out


def tri_area_3d(a: Vec3, b: Vec3, c: Vec3) -> float:
    """Area of a 3D triangle."""
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    return 0.5 * math.sqrt((uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2 + (ux * vy - uy * vx) ** 2)


# ------------------------------------------------------------------ main
def main(argv: list[str] | None = None) -> int:
    """Fetch both queries (or reuse the cache), check the counts, decode once and write fetch_meta.json."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--refresh", action="store_true", help="re-download all pages")
    ap.add_argument("--half", type=float, default=SITE["extent"]["scene_half_m"], help="scene half-size, m")
    args = ap.parse_args(argv)
    t0 = time.time()
    count = json.loads(get(count_url(args.half), cache=False))["count"]
    log.info("ZG3D parts intersecting the %.0f m box: %d", 2 * args.half, count)
    try:
        layer = json.loads(get(LAYER + "?f=json", cache=False))
        edit = (layer.get("editingInfo") or {}).get("lastEditDate") or (layer.get("editingInfo") or {}).get("dataLastEditDate")
        edited = time.strftime("%Y-%m-%d", time.gmtime(edit / 1000)) if edit else None
    except Exception as e:                               # layer info is optional metadata
        log.warning("layer info unavailable: %s", e)
        edited = None
    n_fp = fetch_pages("fp", args.half, args.refresh)
    n_3d = fetch_pages("lod2", args.half, args.refresh)
    log.info("footprints %d, LoD2 parts %d (count query %d)", n_fp, n_3d, count)
    if n_fp != count or n_3d != count:
        log.warning("page totals differ from the count query: the service may have changed; use --refresh")
    # decode once as a check and report the part-type mix
    parts = load_parts()
    types: dict[str, int] = {}
    for p in parts:
        for t, _ in p["patches"]:
            types[PART_NAMES.get(t, str(t))] = types.get(PART_NAMES.get(t, str(t)), 0) + 1
    meta = {"fetched": utcnow_iso(), "service": SERVICE, "envelope_lonlat": envelope(args.half), "half_m": args.half,
            "count": count, "footprints": n_fp, "lod2_parts": n_3d, "part_types": types, "data_last_edit": edited,
            "attribution": SITE["zg3d"]["attribution"]}
    write_json(META_JSON, meta, compact=False)
    log.info("decoded %d parts, part types %s; data last edited %s; %.1f s", len(parts), types, edited, time.time() - t0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
