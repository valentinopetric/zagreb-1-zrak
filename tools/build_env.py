#!/usr/bin/env python3
"""build_env.py - the scene description src/data/env.json (+ the LoD2 display mesh src/data/lod2.bin).

Inputs (all cached by the fetch scripts; this script makes no network calls)
    data/cache/zg3d/raw/*   ZG3D 2022 parts: LoD2 multipatch and LoD1 footprints (tools/fetch_zg3d.py)
    data/cache/dtm/dtm_box.json   DGU 20 m DTM window (tools/fetch_dtm.py)
    data/cache/osm/*.json   OSM roads, rail, buildings, trees, landuse, POIs, station (tools/fetch_osm.py)

Outputs
    src/data/env.json   exactly the schema of docs/architecture.md §4.1 (frame: common.xz, 0.1 m rounding)
    src/data/lod2.bin   LoD2 triangles within SITE.extent.lod2_radius_m, the binary format of §4.1
    data/cache/validation/geometry_validation.json   every validation number quoted in docs/02-geometry.md
    docs/img/geo_*.png  top-down validation plots (stdlib PNG writer)

Steps (one function each, in this order; the numbers are the sections of docs/02-geometry.md)
    1. buildings  ZG3D parts -> LoD1 prisms: h = Z_Max - DTM(centroid), b = max(0, Z_Min - DTM), b = 0 if
                  b < 1 m, drop h < 1 m and Z = 0 records, RDP 0.6 m, holes kept as zero-width keyholes
                  (critic §4.3 step 1). OSM footprints with ZG3D roof cover < 0.5 are added with
                  h = 3.0*levels + 5.5 m (critic §1.9) or a type default. The station container is excluded.
    2. roads      class c, lanes l, oneway o, width w = l x 3.25 m, source group g (A Vukovarska,
                  B Miramarska, C other motor roads, null non-motor) and AADT (critic §4.6: named links,
                  class defaults, one-way carriageways carry their share), plus the Miramarska carriageway
                  override near the station from the 0.1 m orthophoto (critic §1.6).
    3. trees      OSM trees (h 12 m, r 4 m), tree rows sampled every 8 m, the station tree (critic §1.6, G8).
    4. layers     tram, rail, green, water, paved, heating polygons (critic §4.6), POIs, labels, station.
    5. morph      lambda_p, lambda_f, Hbar, d, z0 (Macdonald et al. 1998) in the 500 m disc and in 8 upwind
                  90° sectors (r <= 600 m), from a 1 m nDSM of the LoD2 roofs (critic §1.10 method).
    6. lod2.bin   LoD2 faces triangulated (tools/fetch_zg3d.triangulate_patches), heights above ground.
    7. validation ZG3D vs OSM height tags and levels, base heights, parts by source year, OSM/ZG3D frame
                  alignment (best shift), roads through buildings, PNG plots.

Usage
    python3 tools/build_env.py                 # everything
    python3 tools/build_env.py --no-lod2       # skip the LoD2 mesh
    python3 tools/build_env.py --no-plots      # skip the PNG plots
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import struct
import sys
import time
import zlib
from array import array
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (CACHE, ROOT, SITE, SRC_DATA, log, rdp, ring_area, round_pts, simplify_ring,  # noqa: E402
                    utcnow_iso, write_json, xz)
from fetch_dtm import DTM, DTM_JSON  # noqa: E402
from fetch_zg3d import META_JSON as ZG3D_META  # noqa: E402
from fetch_zg3d import _bridge_holes, load_footprints, load_parts, triangulate_patches  # noqa: E402

OSM_DIR = CACHE / "osm"
VALID_DIR = CACHE / "validation"
IMG_DIR = ROOT / "docs" / "img"
ENV_JSON = SRC_DATA / "env.json"
LOD2_BIN = SRC_DATA / "lod2.bin"

HALF = float(SITE["extent"]["scene_half_m"])          # 750 m: the display box (critic §4.2)
LOD2_R = float(SITE["extent"]["lod2_radius_m"])        # 500 m: LoD2 mesh radius (critic §4.3, lidar-3d §3.2)

# ------------------------------------------------------------------ parameters (each with its source)
RDP_BUILDING = 0.6          # m, footprint simplification (architecture §4.1, critic §4.3)
RDP_ROAD_MAIN = 0.5         # m, motor roads c <= 2: keeps lane geometry well below the 5 m LBM cell
RDP_ROAD = 1.0              # m, other ways (display; the reference used 1.5 m)
RDP_AREA = 1.0              # m, green/water/paved/heating polygons (display; reference 1.5-4 m)
MIN_H = 1.0                 # m, drop parts lower than this (critic §4.3)
MIN_BASE = 1.0              # m, bases below this are set to 0 (critic §4.3)
MIN_PART_AREA = 1.0         # m², smaller footprints are chimney-sized fragments (below any LBM cell)
MIN_HOLE_AREA = 4.0         # m², smaller courtyard holes are dropped (a 2 m x 2 m light well)
MIN_THICK = 0.2             # m, floating parts thinner than this (after 0.1 m rounding) are sheets, dropped
COVER_MIN = 0.5             # ZG3D roof cover below which an OSM footprint is added (critic §1.9, §4.3)
LEVEL_M, LEVEL_C = 3.0, 5.5  # H = 3.0 * levels + 5.5 m (critic §1.9 fit to ZG3D p90 roof heights)
LANE_W = 3.25               # m per lane (architecture §4.1)
TREE_H, TREE_R = 12.0, 4.0  # m, OSM tree defaults (critic §4.3)
TREE_ROW_STEP = 8.0         # m, spacing of trees sampled along natural=tree_row (brief; 2 crowns of r 4 m)
STATION_TREE = {"x": -5.0, "z": -10.0, "h": 14.0, "r": 9.0}   # critic §1.6 (orthophoto crown), G8 (14 m)
LOWRISE_H = 11.5            # m, "low-rise" = up to 2 storeys: 3.0 * 2 + 5.5 (critic §1.9 formula)
HEAT_MIN_AREA = 30.0        # m², buildings smaller than this (sheds, garages) are not heated dwellings
HEAT_TILE = 50.0            # m, residential polygons are cut into 50 m tiles (a Trnje house block, 10 LBM cells)
HEAT_TILE_MIN_LOW = 150.0   # m², a tile needs at least one house footprint of low-rise buildings (~150 m²)
HEAT_TILE_MIN_AREA = 100.0  # m², smaller clipped slivers are dropped
HEAT_W_MAX = 3.0            # cap of the relative weight (the densest tiles are ~2x the mean)

# Miramarska carriageways at the station, measured on the 0.1 m city orthophoto 2022 (critic §1.6,
# research/data/critic/zg_orto2022_80m_marked.jpg): southbound 4 lanes x = +12 ... +25.5 m, median,
# northbound 2 lanes x = +26.5 ... +34 m. The check covers |z| <= 40 m (the 80 m crop).
OVERRIDE_Z = 40.0
OVERRIDE_BOX_X = (5.0, 45.0)        # OSM Miramarska geometry inside this x range and |z| <= 40 m is replaced
MIRAMARSKA_SB = {"x0": 12.0, "x1": 25.5, "lanes": 4}
MIRAMARSKA_NB = {"x0": 26.5, "x1": 34.0, "lanes": 2}

# Traffic (critic §4.6; site-context §3.2-3.3). AADT in veh/day, two-way totals of the link.
NAME_A = "Ulica grada Vukovara"
NAMES_B = ("Miramarska cesta", "Miramarski podvožnjak")   # the underpass is the SB carriageway of Miramarska N
X_SPLIT_VUKOVARSKA = 25.0   # m, Vukovarska W/E legs split at the Miramarska axis (critic §1.6: +12 ... +34 m)
Z_SPLIT_MIRAMARSKA = 53.0   # m, Miramarska N/S legs split at the Vukovarska median (site-context §3.1, z 42-65 m)
AADT_LINKS = {              # critic §4.6 table
    "vukovarska_w": 47000, "vukovarska_e": 45000, "miramarska_n": 20000, "miramarska_s": 12000,
    "Trg Stjepana Radića": 4000, "Ulica Hrvatske bratske zajednice": 50000, "Ulica Ivana Lučića": 12000,
    "Savska cesta": 45000, "Slavonska avenija": 40000, "Ulica kneza Branimira": 25000,
}
MIRAMARSKA_N_SPLIT = {"sb": 0.60, "nb": 0.40}   # critic §4.6: southbound 60 % / northbound 40 % (4 vs 2 lanes)
ONEWAY_SHARE = 0.5          # a one-way carriageway of a dual carriageway carries half of the link (critic §4.6)
AADT_CLASS = {              # class defaults for unnamed / unlisted roads (critic §4.6, site-context §3.3)
    "trunk": 60000, "primary": 45000, "secondary": 25000, "tertiary": 12000, "unclassified": 3000,
    "residential": 1000, "living_street": 1000, "road": 1000, "service": 150, "busway": 150,
}
LINK_FRACTION = 0.25        # *_link slips carry one turning movement: 25 % of the class default (judgement, G1)

ROAD_CLASS = {              # architecture §4.1: 0 primary/trunk, 1 secondary, 2 tertiary, 3 residential...,
    "motorway": 0, "trunk": 0, "primary": 0, "motorway_link": 0, "trunk_link": 0, "primary_link": 0,
    "secondary": 1, "secondary_link": 1, "tertiary": 2, "tertiary_link": 2,
    "residential": 3, "unclassified": 3, "living_street": 3, "road": 3,
    "service": 4, "busway": 4,
    "footway": 5, "cycleway": 5, "pedestrian": 5, "path": 5, "steps": 5, "track": 5, "bridleway": 5,
}
LANES_DEFAULT = {0: 4, 1: 4, 2: 2, 3: 2, 4: 1}     # two-way lanes when `lanes` is missing (judgement)
NONMOTOR_W = {"footway": 2.0, "path": 1.5, "cycleway": 2.0, "steps": 2.0, "track": 3.0, "bridleway": 2.0,
              "pedestrian": 6.0}                   # display widths, m (judgement; c = 5 carries no emissions)

# OSM building type defaults when neither `height` nor `building:levels` is tagged
# (site-context §4.3 and §9.1: houses 7 m, flats 14.3 m = 4 storeys; small structures 3 m as in the
# reference extract_env.py; other types from the reference table).
TYPE_H = {"house": 7.0, "detached": 7.0, "semidetached_house": 7.0, "bungalow": 5.0, "terrace": 7.0,
          "apartments": 14.3, "residential": 14.3, "dormitory": 14.3, "hotel": 14.3,
          "garage": 3.0, "garages": 3.0, "shed": 3.0, "carport": 3.0, "kiosk": 3.0, "hut": 3.0, "cabin": 3.0,
          "toilets": 3.0, "container": 3.0, "service": 3.0, "transformer_tower": 3.0, "roof": 5.0,
          "commercial": 10.0, "retail": 10.0, "office": 14.3, "industrial": 9.0, "warehouse": 9.0,
          "school": 12.0, "university": 14.0, "college": 14.0, "church": 18.0, "hospital": 18.0,
          "public": 14.3, "civic": 14.3, "government": 14.3, "train_station": 12.0, "greenhouse": 4.0}
TYPE_H_YES_SMALL = 3.0      # untagged `building=yes` under 60 m² (kiosks, sheds; reference class "shed")
TYPE_H_YES = 14.3           # untagged `building=yes` otherwise: 4 storeys (site-context §4.3)
SMALL_AREA = 60.0           # m², threshold for the small `yes` rule (a 6 m x 10 m structure)

# Macdonald et al. (1998) constants as used by critic §1.10
MAC_A, MAC_BETA, MAC_CD, KAPPA = 4.43, 1.0, 1.2, 0.4
ROOF_NZ = 0.1               # faces with |n_y|/|n| >= 0.1 are roofs in the nDSM (research zg3d_to_ndsm.py)
BLD_MIN_NDSM = 2.0          # m, nDSM cells >= 2 m are "building" (critic §1.10)
MORPH_R = 500.0             # m, disc for the headline morphometry (critic §1.10)
SECTOR_R = 600.0            # m, upwind 90° wedges (critic §1.10)
RASTER_HALF = HALF + 10.0   # m, the 1 m rasters cover the box plus a margin

POI_TYPES = {"school": "school", "kindergarten": "kindergarten", "hospital": "hospital", "fuel": "fuel"}
LANDMARKS = {               # OSM name -> label text (names are proper nouns: not translated)
    "Koncertna dvorana Vatroslava Lisinskog": "Lisinski",
    "Zagreb Glavni kolodvor": "Glavni kolodvor",
    "Hotel International": "Hotel International",
    "Eurotower": "Eurotower",
    "Eurocentar": "Eurocentar",
    "Fakultet elektrotehnike i računarstva": "FER",
    "Nacionalna i sveučilišna knjižnica u Zagrebu": "NSK",
    "Hotel Esplanade": "Hotel Esplanade",
    "Paromlin": "Paromlin",
    "Palača pravde": "Palača pravde",
    "Grad Zagreb": "Gradska uprava",
    "Neboder Vjesnik": "Vjesnik", "Vjesnik": "Vjesnik",          # outside the box: skipped automatically
    "Filozofski fakultet": "Filozofski fakultet",
}


# ------------------------------------------------------------------ small utilities
def r1(v: float) -> float | int:
    """Round to 0.1 m; whole numbers are written without '.0' to keep env.json small."""
    v = round(v, 1)
    return int(v) if v == int(v) else v


def rpts(pts) -> list[list[float]]:
    """Round a list of (x, z) points to 0.1 m (env.json coordinates, architecture §4.1)."""
    return [[r1(x), r1(z)] for x, z in pts]


def in_box(x: float, z: float, half: float = HALF) -> bool:
    """True inside the square |x|, |z| <= half (the scene box by default)."""
    return abs(x) <= half and abs(z) <= half


def poly_centroid(ring) -> tuple[float, float]:
    """Area-weighted centroid of a simple ring (vertex mean for degenerate rings)."""
    a = cx = cz = 0.0
    n = len(ring)
    for i in range(n):
        x1, z1 = ring[i]
        x2, z2 = ring[(i + 1) % n]
        c = x1 * z2 - x2 * z1
        a += c
        cx += (x1 + x2) * c
        cz += (z1 + z2) * c
    if abs(a) < 1e-9:
        return sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n
    return cx / (3 * a), cz / (3 * a)


def point_in_ring(x: float, z: float, ring) -> bool:
    """Even-odd point-in-polygon test (same rule as core.js pointInPoly, so keyhole rings work)."""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, zi = ring[i]
        xj, zj = ring[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            inside = not inside
        j = i
    return inside


def polyline_length(pts) -> float:
    """Length of a polyline in metres."""
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def seg_dist(px, pz, ax, az, bx, bz) -> float:
    """Distance from point p to the segment ab."""
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz or 1e-12
    s = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / L2))
    return math.hypot(ax + s * dx - px, az + s * dz - pz)


def clip_polyline_box(pts, x0: float, x1: float, z0: float, z1: float, keep_inside: bool = True) -> list[list]:
    """Split a polyline into the pieces inside (keep_inside) or outside the axis-aligned box.

    Each segment is clipped parametrically (Liang-Barsky); consecutive kept pieces are joined.
    """
    def inside(p):
        return x0 <= p[0] <= x1 and z0 <= p[1] <= z1

    pieces: list[list] = []
    cur: list = []
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        dx, dz = b[0] - a[0], b[1] - a[1]
        ts = [0.0, 1.0]
        for p, q in ((-dx, a[0] - x0), (dx, x1 - a[0]), (-dz, a[1] - z0), (dz, z1 - a[1])):
            if abs(p) > 1e-12:
                t = q / p
                if 0.0 < t < 1.0:
                    ts.append(t)
        ts = sorted(set(ts))
        for k in range(len(ts) - 1):
            ta, tb = ts[k], ts[k + 1]
            pa = (a[0] + dx * ta, a[1] + dz * ta)
            pb = (a[0] + dx * tb, a[1] + dz * tb)
            mid = ((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2)
            if inside(mid) == keep_inside:
                if not cur:
                    cur = [pa]
                elif math.dist(cur[-1], pa) > 1e-9:
                    pieces.append(cur)
                    cur = [pa]
                cur.append(pb)
            elif cur:
                pieces.append(cur)
                cur = []
    if cur:
        pieces.append(cur)
    return [p for p in pieces if len(p) >= 2 and polyline_length(p) > 0.5]


def keyhole(outer, holes) -> list[tuple[float, float]]:
    """One ring = outer + holes joined by zero-width bridges (fetch_zg3d._bridge_holes).

    An even-odd point-in-polygon test (core.js pointInPoly, the voxeliser) then leaves the holes empty,
    and the shoelace area equals outer minus holes. Outer is made CCW, holes CW, as the bridging needs.
    """
    if not holes:
        return list(outer)
    P = [tuple(p) for p in outer] + [tuple(p) for h in holes for p in h]
    idx_outer = list(range(len(outer)))
    if ring_area([P[i] for i in idx_outer]) < 0:
        idx_outer.reverse()
    idx_holes, s = [], len(outer)
    for h in holes:
        ids = list(range(s, s + len(h)))
        s += len(h)
        if ring_area([P[i] for i in ids]) > 0:
            ids.reverse()
        idx_holes.append(ids)
    return [P[i] for i in _bridge_holes(idx_outer, idx_holes, P)]


def quantile(sorted_vals: list[float], q: float) -> float:
    """Linear-interpolated quantile q (0..1) of an ascending list; NaN when empty."""
    if not sorted_vals:
        return float("nan")
    k = (len(sorted_vals) - 1) * q
    f = math.floor(k)
    c = min(f + 1, len(sorted_vals) - 1)
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def parse_float(v) -> float | None:
    """'12', '12.5 m', '12;14' -> 12.0 / 12.5 / 12.0; anything else None."""
    if v is None:
        return None
    s = str(v).replace(",", ".").split(";")[0].strip().split(" ")[0].rstrip("m")
    try:
        f = float(s)
    except ValueError:
        return None
    return f if math.isfinite(f) else None


# ------------------------------------------------------------------ 1 m rasters (scanline, even-odd)
class Grid:
    """A square raster centred on the origin: cell (i, j) covers x in [x0+i*c, x0+(i+1)*c), z likewise.

    fill_rows(ring) yields (j, i0, i1) spans of cells whose CENTRES are inside the ring (even-odd rule,
    so keyhole rings work). Used for the ZG3D cover mask, the height rasters and the PNG plots.
    """

    def __init__(self, half: float, cell: float = 1.0):
        self.cell = cell
        self.n = int(round(2 * half / cell))
        self.x0 = -half

    def spans(self, ring):
        """Yield (row j, first column i0, last column i1) of the cells whose centres are inside ring."""
        n, c, x0 = self.n, self.cell, self.x0
        zs = [p[1] for p in ring]
        j0 = max(0, int(math.floor((min(zs) - x0) / c - 0.5)))
        j1 = min(n - 1, int(math.ceil((max(zs) - x0) / c - 0.5)))
        m = len(ring)
        for j in range(j0, j1 + 1):
            zc = x0 + (j + 0.5) * c
            xs = []
            for k in range(m):
                ax, az = ring[k]
                bx, bz = ring[(k + 1) % m]
                if (az > zc) != (bz > zc):
                    xs.append(ax + (zc - az) * (bx - ax) / (bz - az))
            xs.sort()
            for k in range(0, len(xs) - 1, 2):
                i0 = max(0, int(math.ceil((xs[k] - x0) / c - 0.5)))
                i1 = min(n - 1, int(math.floor((xs[k + 1] - x0) / c - 0.5)))
                if i1 >= i0:
                    yield j, i0, i1

    def index(self, x: float, z: float) -> int | None:
        """Flat index of the cell containing (x, z), or None outside the grid."""
        i = int((x - self.x0) / self.cell)
        j = int((z - self.x0) / self.cell)
        if 0 <= i < self.n and 0 <= j < self.n:
            return j * self.n + i
        return None


def paint_mask(grid: Grid, rings) -> bytearray:
    """Binary mask (bytearray, 1 = inside any ring) of cell centres on the grid."""
    m = bytearray(grid.n * grid.n)
    for ring in rings:
        for j, i0, i1 in grid.spans(ring):
            m[j * grid.n + i0:j * grid.n + i1 + 1] = b"\x01" * (i1 - i0 + 1)
    return m


def paint_heights(grid: Grid, prisms) -> array:
    """Max-height raster of LoD1 prisms: paint in ascending h so taller parts overwrite (a DSM)."""
    H = array("f", bytes(4 * grid.n * grid.n))
    for b in sorted(prisms, key=lambda p: p["h"]):
        val = array("f", [b["h"]])
        for j, i0, i1 in grid.spans(b["p"]):
            H[j * grid.n + i0:j * grid.n + i1 + 1] = val * (i1 - i0 + 1)
    return H


def paint_roofs(grid: Grid, tris) -> array:
    """nDSM from LoD2 roof triangles: at each cell centre the maximum roof height (critic §1.10 method).

    tris: iterable of ((x, y, z), (x, y, z), (x, y, z)) with y above local ground.
    """
    n, c, x0 = grid.n, grid.cell, grid.x0
    H = array("f", bytes(4 * n * n))
    for a, b, d in tris:
        ax, ay, az = a
        bx, by, bz = b
        dx, dy, dz = d
        det = (bx - ax) * (dz - az) - (dx - ax) * (bz - az)
        if abs(det) < 1e-9:
            continue
        i0 = max(0, int(math.ceil((min(ax, bx, dx) - x0) / c - 0.5)))
        i1 = min(n - 1, int(math.floor((max(ax, bx, dx) - x0) / c - 0.5)))
        j0 = max(0, int(math.ceil((min(az, bz, dz) - x0) / c - 0.5)))
        j1 = min(n - 1, int(math.floor((max(az, bz, dz) - x0) / c - 0.5)))
        for j in range(j0, j1 + 1):
            zc = x0 + (j + 0.5) * c
            row = j * n
            for i in range(i0, i1 + 1):
                xc = x0 + (i + 0.5) * c
                u = ((xc - ax) * (dz - az) - (dx - ax) * (zc - az)) / det
                v = ((bx - ax) * (zc - az) - (xc - ax) * (bz - az)) / det
                if u < -1e-9 or v < -1e-9 or u + v > 1 + 1e-9:
                    continue
                y = ay + u * (by - ay) + v * (dy - ay)
                if y > H[row + i]:
                    H[row + i] = y
    return H


# ------------------------------------------------------------------ OSM helpers
def load_osm(layer: str) -> list[dict]:
    """Elements of a cached Overpass layer (data/cache/osm/<layer>.json)."""
    p = OSM_DIR / f"{layer}.json"
    if not p.exists():
        raise SystemExit(f"{p} missing: run tools/fetch_osm.py first")
    return json.loads(p.read_text(encoding="utf-8")).get("elements", [])


def way_pts(e: dict) -> list[tuple[float, float]]:
    """Local (x, z) points of an element with `out geom` geometry (common.xz)."""
    return [xz(p["lat"], p["lon"]) for p in (e.get("geometry") or []) if p]


def join_rings(ways: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """Stitch relation member ways into closed rings (from the reference tools/extract_env.py)."""
    segs = [list(w) for w in ways if len(w) > 1]
    rings = []
    while segs:
        ring = segs.pop(0)
        changed = True
        while changed and ring[0] != ring[-1]:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[::-1][:-1] + ring
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        rings.append(ring)
    return rings


def osm_polygons(e: dict) -> list[tuple[list, list]]:
    """[(outer, [holes])] of a closed way or a multipolygon relation, rings without the end point."""
    def opened(r):
        return r[:-1] if len(r) > 1 and r[0] == r[-1] else r

    if e["type"] == "way":
        pts = way_pts(e)
        if len(pts) >= 4 and math.dist(pts[0], pts[-1]) < 0.01:
            return [(opened(pts), [])]
        return []
    if e["type"] == "relation":
        outers = [way_pts(m) for m in e.get("members", []) if m.get("role") == "outer" and m.get("geometry")]
        inners = [way_pts(m) for m in e.get("members", []) if m.get("role") == "inner" and m.get("geometry")]
        outs = [opened(r) for r in join_rings(outers) if len(r) >= 4 and math.dist(r[0], r[-1]) < 0.01]
        ins = [opened(r) for r in join_rings(inners) if len(r) >= 4 and math.dist(r[0], r[-1]) < 0.01]
        res = []
        for o in outs:
            hs = [h for h in ins if point_in_ring(*poly_centroid(h), o)]
            res.append((o, hs))
        return res
    return []


def elem_xy(e: dict) -> tuple[float, float] | None:
    """Representative local position of an OSM element: `center`, the node itself, or the ring centroid."""
    c = e.get("center") or (e if "lat" in e else None)
    if c:
        return xz(c["lat"], c["lon"])
    pts = way_pts(e)
    return poly_centroid(pts) if pts else None


# ------------------------------------------------------------------ 1. buildings
def build_zg3d(footprints: list[dict], dtm: DTM, stats: dict) -> tuple[list[dict], dict, list]:
    """LoD1 prisms from the ZG3D footprints. Returns (buildings, part_ground, cover_rings): part_ground maps
    OBJECTID -> (ground m a.s.l., base b, top h) for the LoD2 mesh (same ground as the prism); cover_rings
    are ALL valid footprints (also those outside the box or lower than 1 m) for the ZG3D cover mask, so
    that OSM buildings at the box edge are not mistaken for buildings missing in ZG3D."""
    out, ground, cover_rings = [], {}, []
    st = {"raw": len(footprints), "bad_z": 0, "outside": 0, "tiny": 0, "low": 0, "kept_parts": 0, "rings": 0,
          "holes": 0, "floating": 0, "base_minus_dtm": [], "by_year_raw": {}, "by_year": {}}
    for fp in footprints:
        yr = str(fp["year"] or 0)
        st["by_year_raw"][yr] = st["by_year_raw"].get(yr, 0) + 1
        zmin, zmax = fp["zmin"], fp["zmax"]
        if not zmin or not zmax or zmin <= 0 or zmax <= 0 or zmax < zmin:
            st["bad_z"] += 1                              # the Z = 0 records (lidar-3d §3.2)
            continue
        kept = False
        for k, (outer, *holes) in enumerate(fp["polys"]):
            cover_rings.append(keyhole(outer, holes) if holes else outer)
            ring = simplify_ring(outer, RDP_BUILDING)
            if not ring:
                st["tiny"] += 1
                continue
            cx, cz = poly_centroid(ring)
            if not in_box(cx, cz):
                st["outside"] += 1
                continue
            hs = [simplify_ring(h, RDP_BUILDING) for h in holes]
            hs = [h for h in hs if h and abs(ring_area(h)) >= MIN_HOLE_AREA]
            area = abs(ring_area(ring)) - sum(abs(ring_area(h)) for h in hs)
            if area < MIN_PART_AREA:
                st["tiny"] += 1
                continue
            g = dtm.at(cx, cz)
            h = zmax - g
            b = max(0.0, zmin - g)
            st["base_minus_dtm"].append(zmin - g)
            if b < MIN_BASE:
                b = 0.0
            if h < MIN_H:
                st["low"] += 1
                continue
            if round(h, 1) - round(b, 1) < MIN_THICK:      # a sheet (e.g. a roof edge part): no volume
                st["thin"] = st.get("thin", 0) + 1
                continue
            poly = keyhole(ring, hs) if hs else ring
            st["holes"] += len(hs)
            pid = f"zg3d:{fp['id']}" if k == 0 else f"zg3d:{fp['id']}.{k}"
            out.append({"p": rpts(poly), "b": r1(b), "h": r1(h), "s": fp["year"], "k": "zg3d", "id": pid})
            if b > 0:
                st["floating"] += 1
            st["rings"] += 1
            if not kept:
                ground[fp["id"]] = (g, b, h)
                kept = True
        if kept:
            st["kept_parts"] += 1
            st["by_year"][yr] = st["by_year"].get(yr, 0) + 1
    stats["zg3d"] = st
    return out, ground, cover_rings


def osm_building_height(tags: dict, area: float) -> tuple[float, float, str]:
    """(h, b, rule) of an OSM building without ZG3D cover (critic §1.9; site-context §4.3, §9.1).

    Order: `height` tag; small footprints (< 60 m²: kiosks, sheds, shelters) 3 m per level without the
    roof term, because the 5.5 m intercept of the critic §1.9 fit comes from pitched roofs and tall ground
    floors of ordinary buildings; `building:levels` -> 3.0 L + 5.5 m (critic §1.9); else the type table.
    Canopies (building=roof) are a 1 m slab under their top (the flow passes below).
    """
    kind = tags.get("building", "yes")
    h = parse_float(tags.get("height"))
    lv = parse_float(tags.get("building:levels"))
    rule = "height"
    if h is None or h <= 0:
        if kind == "roof":
            h, rule = TYPE_H["roof"], "type"
        elif area < SMALL_AREA:
            h, rule = TYPE_H_YES_SMALL * max(1.0, lv or 1.0), "small"
        elif lv is not None and lv > 0:
            h, rule = LEVEL_M * lv + LEVEL_C, "levels"
        elif kind in TYPE_H:
            h, rule = TYPE_H[kind], "type"
        else:
            h, rule = TYPE_H_YES, "type"
    b = parse_float(tags.get("min_height"))
    if b is None:
        ml = parse_float(tags.get("building:min_level"))
        b = LEVEL_M * ml if ml else 0.0
    if tags.get("building") == "roof" and b == 0.0:
        b = max(0.0, h - 1.0)                              # canopy: a 1 m slab, the flow passes below
    return h, (b if b >= MIN_BASE else 0.0), rule


def build_osm_fallback(elements: list[dict], cover: bytearray, grid: Grid, stats: dict) -> list[dict]:
    """OSM buildings that ZG3D does not cover (roof cover < 0.5)."""
    station_way = SITE["station"]["osm_way"]
    out = []
    st = {"osm_buildings": 0, "covered": 0, "added": 0, "rules": {}, "added_list": []}
    for e in elements:
        t = e.get("tags", {})
        if "building" not in t or e.get("id") == station_way or t.get("building") == "no":
            continue
        if t.get("building") in ("construction", "demolished", "ruins") and not (t.get("height") or t.get("building:levels")):
            continue                                       # state unknown: a building site is not a solid block
        for outer, holes in osm_polygons(e):
            cx, cz = poly_centroid(outer)
            if not in_box(cx, cz):
                continue
            st["osm_buildings"] += 1
            tot = cov = 0
            for j, i0, i1 in grid.spans(outer):
                tot += i1 - i0 + 1
                cov += cover[j * grid.n + i0:j * grid.n + i1 + 1].count(1)
            if tot == 0:
                continue
            if cov / tot >= COVER_MIN:
                st["covered"] += 1
                continue
            ring = simplify_ring(outer, RDP_BUILDING)
            if not ring:
                continue
            hs = [h for h in (simplify_ring(h, RDP_BUILDING) for h in holes) if h and abs(ring_area(h)) >= MIN_HOLE_AREA]
            area = abs(ring_area(ring)) - sum(abs(ring_area(h)) for h in hs)
            h, b, rule = osm_building_height(t, area)
            st["rules"][rule] = st["rules"].get(rule, 0) + 1
            pid = f"osm:{e['type'][0]}{e['id']}"
            out.append({"p": rpts(keyhole(ring, hs) if hs else ring), "b": r1(b), "h": r1(h), "s": 0, "k": "osm",
                        "id": pid})
            st["added"] += 1
            st["added_list"].append({"id": pid, "building": t.get("building"), "levels": t.get("building:levels"),
                                     "height_tag": t.get("height"), "h": r1(h), "rule": rule, "area": round(area),
                                     "cover": round(cov / tot, 2), "x": r1(cx), "z": r1(cz), "name": t.get("name")})
    stats["osm_fallback"] = st
    return out


# ------------------------------------------------------------------ 2. roads
def road_class(tags: dict) -> int | None:
    """Road class c (architecture §4.1) from the highway tag; None for areas and unsupported types."""
    hw = tags.get("highway")
    if hw is None or tags.get("area") == "yes":
        return None
    return ROAD_CLASS.get(hw)


def road_oneway(tags: dict) -> int:
    """Oneway o: 1 along the way, -1 against it, 0 two-way (roundabouts are one-way)."""
    ow = str(tags.get("oneway", "")).lower()
    if ow in ("yes", "true", "1"):
        return 1
    if ow in ("-1", "reverse"):
        return -1
    if tags.get("junction") in ("roundabout", "circular") and ow != "no":
        return 1
    return 0


def road_lanes(tags: dict, c: int, oneway: int) -> int:
    """Lanes on this way: the `lanes` tag (max of 'a;b'), else the class default (halved when one-way)."""
    if c == 5:
        return 0
    v = tags.get("lanes")
    if v:
        nums = [int(s) for s in str(v).replace(",", ";").split(";") if s.strip().isdigit()]
        if nums:
            return max(1, max(nums))
    d = LANES_DEFAULT.get(c, 1)
    return max(1, d // 2) if oneway else d


def road_group(name: str, c: int) -> str | None:
    """Source group (architecture §4.1, §5.3): A Vukovarska, B Miramarska, C other motor roads, None."""
    if c == 5:
        return None
    if name == NAME_A:
        return "A"
    if name in NAMES_B:
        return "B"
    return "C"


def road_aadt(tags: dict, c: int, oneway: int, mid: tuple[float, float], direction: tuple[float, float]) -> int:
    """AADT carried by THIS way (veh/day), critic §4.6.

    Named links first (Vukovarska W/E split at the Miramarska axis; Miramarska N/S split at the Vukovarska
    median; the N leg's one-way carriageways 60 % southbound / 40 % northbound), then class defaults.
    A one-way carriageway carries its share (50 %); *_link slips carry LINK_FRACTION of the class default.
    """
    if c == 5:
        return 0
    hw = tags.get("highway", "")
    name = tags.get("name", "")
    if hw.endswith("_link"):
        base = AADT_CLASS.get(hw[:-5], AADT_CLASS["service"])
        return int(round(LINK_FRACTION * base))
    share = ONEWAY_SHARE if oneway else 1.0
    if name == NAME_A:
        base = AADT_LINKS["vukovarska_w"] if mid[0] < X_SPLIT_VUKOVARSKA else AADT_LINKS["vukovarska_e"]
    elif name in NAMES_B:
        if mid[1] < Z_SPLIT_MIRAMARSKA:
            base = AADT_LINKS["miramarska_n"]
            if oneway:                                   # southbound = moving towards +z (south)
                share = MIRAMARSKA_N_SPLIT["sb"] if direction[1] * oneway > 0 else MIRAMARSKA_N_SPLIT["nb"]
        else:
            base = AADT_LINKS["miramarska_s"]
    elif name in AADT_LINKS:
        base = AADT_LINKS[name]
    else:
        base = AADT_CLASS.get(hw, AADT_CLASS["service"])
    return int(round(base * share))


def make_road(pts, tags: dict, c: int, oneway: int, lanes: int | None = None, width: float | None = None,
              aadt: int | None = None) -> dict:
    """One env.json road (architecture §4.1) from a clipped OSM polyline: n, hw, c, l, o, w, g, aadt.
    lanes/width/aadt override the tag-derived values (used by the Miramarska override)."""
    name = tags.get("name", "")
    hw = tags.get("highway", "")
    l = road_lanes(tags, c, oneway) if lanes is None else lanes
    if width is None:
        width = l * LANE_W if c < 5 else parse_float(tags.get("width")) or NONMOTOR_W.get(hw, 2.0)
        if c == 5 and not 0.5 <= width <= 20:
            width = NONMOTOR_W.get(hw, 2.0)
    mid_i = len(pts) // 2
    mid = ((pts[mid_i - 1][0] + pts[mid_i][0]) / 2, (pts[mid_i - 1][1] + pts[mid_i][1]) / 2) if len(pts) > 1 else pts[0]
    direction = (pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1])
    g = road_group(name, c)
    a = road_aadt(tags, c, oneway, mid, direction) if aadt is None else aadt
    return {"p": rpts(pts), "n": name, "hw": hw, "c": c, "l": l, "o": oneway, "w": r1(width), "g": g,
            "aadt": a if g else 0}


def miramarska_override() -> list[dict]:
    """The two Miramarska carriageways within |z| <= 40 m as measured on the 0.1 m orthophoto (critic §1.6).

    Southbound: x = +12 ... +25.5 m (4 lanes), drawn north -> south (o = 1 along p, +z).
    Northbound: x = +26.5 ... +34 m (2 lanes), drawn south -> north.
    AADT: Miramarska N leg 20 000 veh/day split 60 / 40 % (critic §4.6).
    """
    out = []
    for spec, z0, z1, share in ((MIRAMARSKA_SB, -OVERRIDE_Z, OVERRIDE_Z, MIRAMARSKA_N_SPLIT["sb"]),
                                (MIRAMARSKA_NB, OVERRIDE_Z, -OVERRIDE_Z, MIRAMARSKA_N_SPLIT["nb"])):
        xc = (spec["x0"] + spec["x1"]) / 2
        tags = {"name": "Miramarska cesta", "highway": "tertiary"}
        out.append(make_road([(xc, z0), (xc, z1)], tags, 2, 1, lanes=spec["lanes"], width=spec["x1"] - spec["x0"],
                             aadt=int(round(AADT_LINKS["miramarska_n"] * share))))
    return out


def build_roads(elements: list[dict], stats: dict) -> tuple[list[dict], list, list]:
    """Roads (+ tram and rail are handled in build_rail). Returns (roads, removed_pieces, override_roads)."""
    roads = []
    st = {"ways": 0, "by_class": {}, "by_group": {}, "aadt_len_km": {}, "override_replaced_m": 0.0}
    bx0, bx1 = OVERRIDE_BOX_X
    replaced = []
    for e in elements:
        if e.get("type") != "way":
            continue
        t = e.get("tags", {})
        c = road_class(t)
        if c is None:
            continue
        pts = way_pts(e)
        if len(pts) < 2:
            continue
        ow = road_oneway(t)
        pieces = clip_polyline_box(pts, -HALF, HALF, -HALF, HALF)
        if t.get("name") in NAMES_B:
            # cut out the OSM geometry of the orthophoto-checked band; it is replaced by miramarska_override()
            new = []
            for pc in pieces:
                outside = clip_polyline_box(pc, bx0, bx1, -OVERRIDE_Z, OVERRIDE_Z, keep_inside=False)
                inside_len = polyline_length(pc) - sum(polyline_length(q) for q in outside)
                if inside_len > 0.5:
                    replaced.append({"id": e["id"], "lanes": t.get("lanes"), "oneway": t.get("oneway"),
                                     "len_m": round(inside_len, 1),
                                     "x_at_z0": _x_at_z(pc, 0.0)})
                st["override_replaced_m"] += inside_len
                new += outside
            pieces = new
        for pc in pieces:
            tol = RDP_ROAD_MAIN if c <= 2 else RDP_ROAD
            pc = rdp(pc, tol)
            r = make_road(pc, t, c, ow)
            roads.append(r)
    ov = miramarska_override()
    roads += ov
    for r in roads:
        st["ways"] += 1
        st["by_class"][str(r["c"])] = st["by_class"].get(str(r["c"]), 0) + 1
        g = str(r["g"])
        st["by_group"][g] = st["by_group"].get(g, 0) + 1
        st["aadt_len_km"][g] = st["aadt_len_km"].get(g, 0.0) + r["aadt"] * polyline_length(r["p"]) / 1000.0
    st["aadt_len_km"] = {k: round(v) for k, v in st["aadt_len_km"].items()}
    st["override_replaced"] = replaced
    stats["roads"] = st
    return roads, replaced, ov


def _x_at_z(pts, z: float) -> float | None:
    """x where a polyline crosses the line z (first crossing), for the override report."""
    for i in range(len(pts) - 1):
        (ax, az), (bx, bz) = pts[i], pts[i + 1]
        if (az - z) * (bz - z) <= 0 and az != bz:
            return round(ax + (z - az) * (bx - ax) / (bz - az), 2)
    return None


# ------------------------------------------------------------------ 3. trees
def build_trees(elements: list[dict], cover: bytearray, grid: Grid, stats: dict) -> list[dict]:
    """OSM trees (critic §4.3: h 12 m, r 4 m unless tagged), tree rows every 8 m, the station tree."""
    trees = []
    st = {"nodes": 0, "rows": 0, "row_trees": 0, "dropped_in_building": 0, "dropped_station_crown": 0,
          "height_tagged": 0}
    sx, sz, sr = STATION_TREE["x"], STATION_TREE["z"], STATION_TREE["r"]

    def add(x, z, tags, kind="osm"):
        if not in_box(x, z):
            return
        k = grid.index(x, z)
        if k is not None and cover[k]:
            st["dropped_in_building"] += 1
            return
        if math.hypot(x - sx, z - sz) < sr:              # inside the station tree's crown: same tree
            st["dropped_station_crown"] += 1
            return
        h = parse_float(tags.get("height"))
        if h and 2 <= h <= 45:
            st["height_tagged"] += 1
        else:
            h = TREE_H
        r = parse_float(tags.get("diameter_crown"))
        r = r / 2 if r and 1 <= r <= 40 else TREE_R
        trees.append({"x": r1(x), "z": r1(z), "h": r1(h), "r": r1(r), "k": kind})

    for e in elements:
        t = e.get("tags", {})
        if e["type"] == "node" and t.get("natural") == "tree":
            st["nodes"] += 1
            add(*xz(e["lat"], e["lon"]), t)
        elif e["type"] == "way" and t.get("natural") == "tree_row":
            pts = way_pts(e)
            L = polyline_length(pts)
            if L <= 0:
                continue
            st["rows"] += 1
            n = max(1, int(round(L / TREE_ROW_STEP)))
            for s in ((i + 0.5) * L / n for i in range(n)):
                acc = 0.0
                for i in range(len(pts) - 1):
                    d = math.dist(pts[i], pts[i + 1])
                    if acc + d >= s and d > 0:
                        f = (s - acc) / d
                        add(pts[i][0] + f * (pts[i + 1][0] - pts[i][0]), pts[i][1] + f * (pts[i + 1][1] - pts[i][1]), t)
                        st["row_trees"] += 1
                        break
                    acc += d
    trees.append({"x": sx, "z": sz, "h": STATION_TREE["h"], "r": sr, "k": "station"})
    st["total"] = len(trees)
    stats["trees"] = st
    return trees


# ------------------------------------------------------------------ 4. other layers
def build_rail(elements: list[dict], stats: dict) -> tuple[list, list]:
    """Tram tracks (railway=tram, incl. sidings) and active railway tracks (rail incl. yard/siding/spur)."""
    tram, rail = [], []
    for e in elements:
        t = e.get("tags", {})
        kind = t.get("railway")
        if e.get("type") != "way" or kind not in ("tram", "rail", "light_rail"):
            continue
        for pc in clip_polyline_box(way_pts(e), -HALF, HALF, -HALF, HALF):
            (tram if kind == "tram" else rail).append(rpts(rdp(pc, RDP_ROAD)))
    stats["rail"] = {"tram": len(tram), "rail": len(rail)}
    return tram, rail


GREEN_TAGS = {"leisure": {"park", "garden", "nature_reserve"},
              "landuse": {"grass", "recreation_ground", "village_green", "meadow", "forest", "flowerbed",
                          "allotments", "cemetery", "orchard", "plant_nursery"},
              "natural": {"wood", "scrub", "grassland", "heath"}}
WATER_TAGS = {"natural": {"water"}, "landuse": {"basin", "reservoir"}, "waterway": {"riverbank", "dock"},
              "amenity": {"fountain"}, "leisure": {"swimming_pool"}}


def _matches(t: dict, spec: dict) -> bool:
    """True if any tag key in spec has one of the listed values."""
    return any(t.get(k) in v for k, v in spec.items())


def build_areas(elements: list[dict], stats: dict) -> tuple[list, list, list, list]:
    """green, water, paved polygons and the landuse=residential polygons (for heating). Holes are ignored
    for display layers (buildings and roads are drawn over them)."""
    green, water, paved, residential = [], [], [], []
    for e in elements:
        t = e.get("tags", {})
        if _matches(t, WATER_TAGS) and not t.get("location") == "indoor":
            dest = water
        elif _matches(t, GREEN_TAGS):
            dest = green
        elif (t.get("amenity") == "parking" and t.get("parking") not in ("underground", "multi-storey", "rooftop")) \
                or "area:highway" in t or (t.get("highway") == "pedestrian" and t.get("area") == "yes") \
                or t.get("place") == "square":
            dest = paved
        elif t.get("landuse") == "residential":
            dest = residential
        else:
            continue
        for outer, _holes in osm_polygons(e):
            xs, zs = [p[0] for p in outer], [p[1] for p in outer]
            if max(xs) < -HALF or min(xs) > HALF or max(zs) < -HALF or min(zs) > HALF:
                continue
            if min(xs) < -HALF or max(xs) > HALF or min(zs) < -HALF or max(zs) > HALF:
                outer = clip_ring_to_box(outer, -HALF, -HALF, HALF, HALF)   # parks reaching beyond the box
                if len(outer) < 3:
                    continue
            ring = simplify_ring(outer, RDP_AREA)
            if not ring or abs(ring_area(ring)) < 4.0:
                continue
            if dest is residential:
                residential.append({"ring": ring, "id": e["id"], "name": t.get("name")})
            else:
                dest.append(rpts(ring))
    stats["areas"] = {"green": len(green), "water": len(water), "paved": len(paved), "residential": len(residential)}
    return green, water, paved, residential


def clip_ring_to_box(ring, x0: float, z0: float, x1: float, z1: float) -> list[tuple[float, float]]:
    """Sutherland-Hodgman clip of a (possibly concave) ring to an axis-aligned box. The result may have
    zero-width connecting edges along the box border when the ring leaves and re-enters; its shoelace
    area and even-odd point tests are still correct."""
    pts = list(ring)
    for axis, val, keep_ge in ((0, x0, True), (0, x1, False), (1, z0, True), (1, z1, False)):
        if not pts:
            break
        out = []
        for i in range(len(pts)):
            a, b = pts[i - 1], pts[i]
            ina = a[axis] >= val if keep_ge else a[axis] <= val
            inb = b[axis] >= val if keep_ge else b[axis] <= val
            if inb:
                if not ina:
                    f = (val - a[axis]) / (b[axis] - a[axis])
                    out.append((a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])))
                out.append(b)
            elif ina:
                f = (val - a[axis]) / (b[axis] - a[axis])
                out.append((a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])))
        pts = out
    return pts


def build_heating(residential: list[dict], buildings: list[dict], house_rings: list, stats: dict) -> list[dict]:
    """Domestic-heating area sources (critic §4.6, G14): low-rise residential land, by 50 m tiles.

    1. Candidate polygons: landuse=residential with at least one OSM house/detached building, or with a
       low-rise area share >= 0.5 (low-rise: ground-standing, h <= 11.5 m, footprint >= 30 m²).
    2. Each candidate is cut into 50 m tiles (aligned to the origin). A tile is kept if it holds at least
       150 m² of low-rise footprint, i.e. at least one house. Parks, schools and blocks of flats inside a
       large residential polygon therefore carry no heating (one OSM polygon of 0.11 km² reaches the station).
    3. w = lambda_p,low(tile) / mean lambda_p,low over all kept tiles (area-weighted), capped at 3. The mean
       of w over the heating area is 1, so groupStrengths' q_D is the MEAN areal rate over that area and
       denser house quarters emit proportionally more (households: 74 % of city PM10, 99 % of it from wood;
       site-context §6). Order of magnitude only (critic G14).
    """
    low, tall = [], []
    for b in buildings:
        if b["b"] != 0:
            continue
        a = abs(ring_area(b["p"]))
        if a < HEAT_MIN_AREA:
            continue
        (low if b["h"] <= LOWRISE_H else tall).append((poly_centroid(b["p"]), a))
    house_c = [poly_centroid(r) for r in house_rings]

    def inside(items, ring, bb):
        x0, x1, z0, z1 = bb
        return [it for it in items if x0 <= it[0][0] <= x1 and z0 <= it[0][1] <= z1 and point_in_ring(it[0][0], it[0][1], ring)]

    st = {"candidates": len(residential), "polygons": 0, "tiles": 0, "area_m2": 0.0, "list": []}
    tiles = []
    for res in residential:
        ring = res["ring"]
        xs, zs = [p[0] for p in ring], [p[1] for p in ring]
        bb = (min(xs), max(xs), min(zs), max(zs))
        lo = sum(a for _, a in inside(low, ring, bb))
        hi = sum(a for _, a in inside(tall, ring, bb))
        n_house = sum(1 for c in house_c if bb[0] <= c[0] <= bb[1] and bb[2] <= c[1] <= bb[3] and point_in_ring(c[0], c[1], ring))
        share = lo / (lo + hi) if lo + hi > 0 else 0.0
        if lo <= 0 or (share < 0.5 and n_house == 0):
            continue
        st["polygons"] += 1
        n_t = 0
        for i in range(math.floor(bb[0] / HEAT_TILE), math.ceil(bb[1] / HEAT_TILE)):
            for j in range(math.floor(bb[2] / HEAT_TILE), math.ceil(bb[3] / HEAT_TILE)):
                tx0, tz0 = i * HEAT_TILE, j * HEAT_TILE
                piece = clip_ring_to_box(ring, tx0, tz0, tx0 + HEAT_TILE, tz0 + HEAT_TILE)
                if len(piece) < 3:
                    continue
                A = abs(ring_area(piece))
                if A < HEAT_TILE_MIN_AREA:
                    continue
                pbb = (tx0, tx0 + HEAT_TILE, tz0, tz0 + HEAT_TILE)
                L = sum(a for _, a in inside(low, piece, pbb))
                if L < HEAT_TILE_MIN_LOW:
                    continue
                tiles.append({"ring": piece, "A": A, "L": L})
                n_t += 1
        cx, cz = poly_centroid(ring)
        st["list"].append({"osm": res["id"], "x": r1(cx), "z": r1(cz), "area": round(abs(ring_area(ring))),
                           "lowrise_share": round(share, 2), "houses": n_house, "tiles": n_t})
    if not tiles:
        stats["heating"] = st
        return []
    lp_ref = sum(t["L"] for t in tiles) / sum(t["A"] for t in tiles)
    out = []
    for t in tiles:
        ring = [p for p in simplify_ring(t["ring"], 0.1)] or t["ring"]
        out.append({"p": rpts(ring), "w": round(min(HEAT_W_MAX, (t["L"] / t["A"]) / lp_ref), 2)})
    st["tiles"] = len(out)
    st["area_m2"] = round(sum(t["A"] for t in tiles))
    st["lambda_p_low_ref"] = round(lp_ref, 3)
    ws = sorted(o["w"] for o in out)
    st["w_quantiles"] = [ws[0], quantile(ws, 0.5), ws[-1]]
    dists = sorted(min(math.hypot(*p) for p in o["p"]) for o in out)
    st["nearest_tile_m"] = round(dists[0], 1)
    stats["heating"] = st
    return out


def build_house_tags(elements: list[dict]) -> list:
    """Rings of OSM buildings tagged house/detached/semidetached_house/bungalow/terrace (for heating)."""
    out = []
    for e in elements:
        t = e.get("tags", {})
        if t.get("building") in ("house", "detached", "semidetached_house", "bungalow", "terrace"):
            for outer, _ in osm_polygons(e):
                out.append(outer)
    return out


def build_pois(elements: list[dict], stats: dict) -> list[dict]:
    """Sensitive receptors and fuel stations (architecture §4.1 types)."""
    out, seen = [], set()
    for e in elements:
        t = e.get("tags", {})
        am = t.get("amenity")
        typ = POI_TYPES.get(am)
        if typ is None and (t.get("healthcare") == "hospital" or (am == "clinic" and "bolnica" in t.get("name", "").lower())):
            typ = "hospital"
        if typ is None:
            continue
        pos = elem_xy(e)
        if pos is None or not in_box(*pos):
            continue
        name = t.get("name") or t.get("brand") or t.get("operator") or ""
        key = (typ, name, round(pos[0] / 20), round(pos[1] / 20))
        if key in seen:
            continue
        seen.add(key)
        out.append({"t": typ, "n": name, "x": r1(pos[0]), "z": r1(pos[1])})
    stats["pois"] = {k: sum(1 for p in out if p["t"] == k) for k in POI_TYPES.values()}
    return out


def _cross_at(polys, axis: int, value: float) -> list[float]:
    """Other-axis coordinates where polylines cross axis == value (axis 0: x, 1: z)."""
    res = []
    for pts in polys:
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            if (a[axis] - value) * (b[axis] - value) <= 0 and a[axis] != b[axis]:
                f = (value - a[axis]) / (b[axis] - a[axis])
                res.append(a[1 - axis] + f * (b[1 - axis] - a[1 - axis]))
    return res


def build_labels(roads: list[dict], landuse: list[dict], pois_el: list[dict], stats: dict) -> list[dict]:
    """Street names (main roads), parks, water and landmarks. Names are proper nouns (not translated)."""
    labels = []
    # Vukovarska and Miramarska: two labels each, on the median between the carriageways
    vuk = [r["p"] for r in roads if r["g"] == "A"]
    mir = [r["p"] for r in roads if r["g"] == "B"]
    for x in (-170.0, 230.0):
        zs = [z for z in _cross_at(vuk, 0, x) if abs(z - Z_SPLIT_MIRAMARSKA) < 60]
        if zs:
            labels.append({"t": "Vukovarska", "x": r1(x), "z": r1(sum(zs) / len(zs)), "k": "road"})
    for z in (-150.0, 190.0):
        xs = [x for x in _cross_at(mir, 1, z) if abs(x - X_SPLIT_VUKOVARSKA) < 60]
        if xs:
            labels.append({"t": "Miramarska", "x": r1(sum(xs) / len(xs)), "z": r1(z), "k": "road"})
    # other named roads of class <= 2 (and Trg Stjepana Radića): midpoint of the longest piece
    by_name: dict[str, list] = {}
    for r in roads:
        if r["n"] and r["g"] == "C" and (r["c"] <= 2 or r["n"] == "Trg Stjepana Radića"):
            by_name.setdefault(r["n"], []).append(r["p"])
    for name, polys in sorted(by_name.items()):
        total = sum(polyline_length(p) for p in polys)
        if total < 150:
            continue
        best = max(polys, key=polyline_length)
        L = polyline_length(best)
        acc = 0.0
        for i in range(len(best) - 1):
            d = math.dist(best[i], best[i + 1])
            if acc + d >= L / 2 and d > 0:
                f = (L / 2 - acc) / d
                x = best[i][0] + f * (best[i + 1][0] - best[i][0])
                z = best[i][1] + f * (best[i + 1][1] - best[i][1])
                if in_box(x, z, HALF - 30):
                    labels.append({"t": name, "x": r1(x), "z": r1(z), "k": "road"})
                break
            acc += d
    # parks and water (named polygons)
    seen = set()
    for e in landuse:
        t = e.get("tags", {})
        name = t.get("name")
        if not name or name in seen:
            continue
        kind = "water" if _matches(t, WATER_TAGS) else "park" if t.get("leisure") in ("park", "garden") else None
        if kind is None:
            continue
        pos = elem_xy(e)
        polys = osm_polygons(e)
        if polys:
            pos = poly_centroid(max(polys, key=lambda pr: abs(ring_area(pr[0])))[0])
        if pos and in_box(*pos, HALF - 20):
            seen.add(name)
            labels.append({"t": name, "x": r1(pos[0]), "z": r1(pos[1]), "k": kind})
    # landmarks
    for e in pois_el:
        name = e.get("tags", {}).get("name")
        if name in LANDMARKS and LANDMARKS[name] not in seen:
            pos = elem_xy(e)
            if pos and in_box(*pos, HALF - 20):
                seen.add(LANDMARKS[name])
                labels.append({"t": LANDMARKS[name], "x": r1(pos[0]), "z": r1(pos[1]), "k": "poi"})
    stats["labels"] = {k: sum(1 for l in labels if l["k"] == k) for k in ("road", "park", "water", "poi")}
    return labels


def build_station(elements: list[dict]) -> dict:
    """The station: origin, inlet 4.0 m (critic §1.6), the container footprint (OSM way 1409603653,
    excluded from the flow mask, critic §4.2) and the big tree next to the inlet (critic §1.6, G8)."""
    container = [[-1.5, -1.2], [1.5, -1.2], [1.5, 1.2], [-1.5, 1.2]]   # fallback: a 3 m x 2.4 m container
    for e in elements:
        if e.get("type") == "way" and e.get("id") == SITE["station"]["osm_way"]:
            pts = way_pts(e)
            if len(pts) > 1 and pts[0] == pts[-1]:
                pts = pts[:-1]
            if len(pts) >= 3:
                container = rpts(pts)
    return {"x": 0, "z": 0, "inlet": SITE["station"]["inlet_height_m"], "container": container,
            "tree": dict(STATION_TREE)}


# ------------------------------------------------------------------ 5. morphometry (Macdonald 1998)
def macdonald(lp: float, lf: float, H: float) -> tuple[float, float]:
    """Zero-plane displacement d and roughness length z0 (Macdonald, Griffiths & Hall 1998, eqs. 23 and 26).

        d/H  = 1 + A^(-lambda_p) (lambda_p - 1)
        z0/H = (1 - d/H) exp{ -[0.5 beta (C_D / kappa^2) (1 - d/H) lambda_f]^(-1/2) }
    with A = 4.43, beta = 1.0, C_D = 1.2, kappa = 0.4 (critic §1.10).
    """
    if H <= 0 or lp <= 0:
        return 0.0, 0.0
    dH = 1.0 + MAC_A ** (-lp) * (lp - 1.0)
    arg = 0.5 * MAC_BETA * (MAC_CD / KAPPA ** 2) * (1.0 - dH) * lf
    z0H = (1.0 - dH) * math.exp(-arg ** -0.5) if arg > 0 else 0.0
    return dH * H, z0H * H


def region_stats(grid: Grid, H: array, from_deg: float, region: str, radius: float) -> dict:
    """lambda_p, Hbar, lambda_f for one wind-from direction over a disc or the upwind 90° wedge.

    The raster is sampled on a 1 m lattice aligned with the wind (u downwind, v across). lambda_f is the
    sum of positive height steps met when walking downwind (windward faces), times the 1 m lattice width,
    over the region area (critic §1.10 method). lambda_p and Hbar use nDSM >= 2 m cells.
    """
    th = math.radians(from_deg)
    dx, dz = -math.sin(th), math.cos(th)            # blowing-towards unit vector (architecture §2)
    px, pz = -dz, dx                                # across-wind unit vector
    n, x0, c = grid.n, grid.x0, grid.cell

    def h_at(x, z):
        i = int((x - x0) / c)
        j = int((z - x0) / c)
        return H[j * n + i] if 0 <= i < n and 0 <= j < n else 0.0

    R = int(radius)
    cells = bld = 0
    hsum = front = 0.0
    for v in range(-R, R + 1):
        umax = math.sqrt(max(0.0, radius * radius - v * v))
        if region == "disc":
            u_lo, u_hi = -umax, umax
        else:                                        # upwind wedge: u < 0 and |v| <= -u (bearing +-45°)
            u_lo, u_hi = -umax, -abs(v)
            if u_hi < u_lo:
                continue
        u = math.ceil(u_lo)
        prev = h_at((u - 1) * dx + v * px, (u - 1) * dz + v * pz)
        while u <= u_hi:
            h = h_at(u * dx + v * px, u * dz + v * pz)
            cells += 1
            if h >= BLD_MIN_NDSM:
                bld += 1
                hsum += h
            if h > prev:
                front += h - prev
            prev = h
            u += 1
    lp = bld / cells if cells else 0.0
    Hb = hsum / bld if bld else 0.0
    lf = front / cells if cells else 0.0
    return {"lambda_p": lp, "Hbar": Hb, "lambda_f": lf, "cells": cells}


def build_morph(grid: Grid, H: array, stats: dict, label: str = "lod2") -> dict:
    """The env.morph block (architecture §4.1) and the full numbers for the docs."""
    t0 = time.time()
    dirs16 = [i * 22.5 for i in range(16)]
    disc = [region_stats(grid, H, d, "disc", MORPH_R) for d in dirs16]
    lp = disc[0]["lambda_p"]
    Hb = disc[0]["Hbar"]
    lfs = [s["lambda_f"] for s in disc]
    lf = sum(lfs) / len(lfs)
    d, z0 = macdonald(lp, lf, Hb)
    disc300 = [region_stats(grid, H, dd, "disc", 300.0) for dd in dirs16[::2]]
    lf300 = sum(s["lambda_f"] for s in disc300) / len(disc300)
    d300, z0300 = macdonald(disc300[0]["lambda_p"], lf300, disc300[0]["Hbar"])
    sectors = []
    for frm in range(0, 360, 45):
        s = region_stats(grid, H, frm, "wedge", SECTOR_R)
        sd, sz0 = macdonald(s["lambda_p"], s["lambda_f"], s["Hbar"])
        sectors.append({"from": frm, "z0": round(sz0, 2), "d": round(sd, 1), "Hbar": round(s["Hbar"], 1),
                        "lambda_p": round(s["lambda_p"], 3), "lambda_f": round(s["lambda_f"], 3)})
    morph = {"lambda_p": round(lp, 3), "lambda_f": round(lf, 3), "Hbar": round(Hb, 1), "d": round(d, 1),
             "z0": round(z0, 2), "sectors": sectors}
    stats[f"morph_{label}"] = {
        "disc500": {**morph, "lambda_f_range": [round(min(lfs), 3), round(max(lfs), 3)],
                    "lambda_f_by_dir16": [round(v, 3) for v in lfs]},
        "disc300": {"lambda_p": round(disc300[0]["lambda_p"], 3), "Hbar": round(disc300[0]["Hbar"], 1),
                    "lambda_f": round(lf300, 3), "d": round(d300, 1), "z0": round(z0300, 2)},
        "seconds": round(time.time() - t0, 1)}
    return morph


# ------------------------------------------------------------------ 6. LoD2 mesh
def lod2_triangles(parts: list[dict], ground: dict, radius: float | None) -> tuple[list, dict]:
    """Triangles of every kept part, heights above local ground, oriented outward.

    - Ground: the same DTM(centroid) as the LoD1 prism of the part, so LoD1 and LoD2 tops agree.
      Ground-standing parts (b = 0) have their lowest vertices pulled to y = 0 (no floating or sunk walls).
    - Orientation: Esri rings are clockwise seen from outside, so most parts have a negative signed volume
      in the right-handed (x, y, z) frame; each part is flipped when its signed volume is negative, which
      makes (b - a) x (c - a) point outward (three.js front faces).
    - Bottom faces (all vertices on the ground) are dropped: they are never visible.
    Returns ([(tri, year)], stats). radius None = all parts (used for the nDSM).
    """
    out = []
    st = {"parts": 0, "tris": 0, "dropped_bottom": 0, "flipped_parts": 0}
    for p in parts:
        gb = ground.get(p["id"])
        if gb is None:
            continue
        g, b, _h = gb
        pts = [pt for _, ring in p["patches"] for pt in ring]
        if not pts:
            continue
        cx = sum(q[0] for q in pts) / len(pts)
        cz = sum(q[1] for q in pts) / len(pts)
        if radius is not None and math.hypot(cx, cz) > radius:
            continue
        zmin = p["zmin"]

        def y_of(Z):
            if b == 0 and Z - zmin < 0.05:
                return 0.0
            return max(0.0, Z - g)

        tris = triangulate_patches([(t, [(x, y_of(Z), z) for x, z, Z in ring]) for t, ring in p["patches"]])
        vol = 0.0
        cy = sum(y_of(q[2]) for q in pts) / len(pts)
        for a, bb, c in tris:
            ax, ay, az = a[0] - cx, a[1] - cy, a[2] - cz
            bx, by, bz = bb[0] - cx, bb[1] - cy, bb[2] - cz
            qx, qy, qz = c[0] - cx, c[1] - cy, c[2] - cz
            vol += ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)
        flip = vol < 0
        st["flipped_parts"] += flip
        st["parts"] += 1
        for a, bb, c in tris:
            if a[1] <= 0.05 and bb[1] <= 0.05 and c[1] <= 0.05:
                st["dropped_bottom"] += 1
                continue
            out.append(((a, c, bb) if flip else (a, bb, c), p["year"]))
    st["tris"] = len(out)
    return out, st


def write_lod2(path: Path, tris: list) -> dict:
    """architecture §4.1: 'ZL2B', uint32 version 1, uint32 nTri, uint32 0; Int16 xyz decimetres [nTri*9];
    Uint8 class = source year - 2000 [nTri]; zero padding to a multiple of 4. Little-endian."""
    n = len(tris)
    pos = array("h")
    cls = bytearray()
    clampd = 0
    for (a, b, c), yr in tris:
        for v in (a, b, c):
            for q in v:
                d = int(round(q * 10))
                if d > 32767 or d < -32768:
                    clampd += 1
                    d = max(-32768, min(32767, d))
                pos.append(d)
        cls.append(yr - 2000 if 2000 < yr < 2256 else 0)
    if sys.byteorder != "little":
        pos.byteswap()
    body = struct.pack("<4sIII", b"ZL2B", 1, n, 0) + pos.tobytes() + bytes(cls)
    body += b"\0" * (-len(body) % 4)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return {"triangles": n, "bytes": len(body), "clamped": clampd}


# ------------------------------------------------------------------ 7. validation
def alignment_shift(zg3d: list[dict], osm_rings: list, half: float = 300.0, cell: float = 0.25,
                    max_shift: float = 3.0) -> dict:
    """Best global (dx, dz) that maximises the overlap of the OSM and ZG3D footprint masks (0.25 m raster,
    +-3 m). Rows are Python integers used as bit sets, so each shift costs one AND + popcount per row.
    A best shift near (0, 0) confirms that both layers are in the same frame (critic §1.11, §4.2)."""
    g = Grid(half, cell)

    def rows_of(rings):
        rows = [0] * g.n
        for ring in rings:
            for j, i0, i1 in g.spans(ring):
                rows[j] |= ((1 << (i1 - i0 + 1)) - 1) << i0
        return rows

    zr = rows_of([b["p"] for b in zg3d if b["b"] == 0 and abs(b["p"][0][0]) < half + 20 and abs(b["p"][0][1]) < half + 20])
    orr = rows_of([r for r in osm_rings if abs(r[0][0]) < half + 20 and abs(r[0][1]) < half + 20])
    k = int(round(max_shift / cell))
    area_z = sum(r.bit_count() for r in zr)
    area_o = sum(r.bit_count() for r in orr)
    best = None
    grid_iou = {}
    for sj in range(-k, k + 1):
        for si in range(-k, k + 1):
            inter = 0
            for j in range(max(0, sj), min(g.n, g.n + sj)):
                o = orr[j - sj]
                o = o << si if si >= 0 else o >> -si
                inter += (zr[j] & o).bit_count()
            iou = inter / (area_z + area_o - inter)
            grid_iou[(si, sj)] = iou
            if best is None or iou > best[0]:
                best = (iou, si * cell, sj * cell)
    return {"iou_zero": round(grid_iou[(0, 0)], 4), "iou_best": round(best[0], 4), "dx_best": best[1],
            "dz_best": best[2], "cell_m": cell, "half_m": half, "zg3d_m2": round(area_z * cell * cell),
            "osm_m2": round(area_o * cell * cell),
            "note": "OSM mask shifted by (dx, dz) to best match ZG3D; the frames agree if both are ~0"}


def height_validation(osm_elements: list[dict], nd: array, grid: Grid, cover: bytearray, stats: dict) -> None:
    """ZG3D vs OSM `height` and `building:levels` (p90 of the LoD2 nDSM inside each OSM footprint, cover
    >= 0.8, as lidar-3d §3.2 and critic §1.9)."""
    pairs_h, pairs_l = [], []
    for e in osm_elements:
        t = e.get("tags", {})
        if "building" not in t:
            continue
        ht = parse_float(t.get("height"))
        lv = parse_float(t.get("building:levels"))
        if ht is None and lv is None:
            continue
        for outer, _ in osm_polygons(e):
            if not in_box(*poly_centroid(outer), RASTER_HALF - 5):
                continue
            vals, tot, cov = [], 0, 0
            for j, i0, i1 in grid.spans(outer):
                row = j * grid.n
                tot += i1 - i0 + 1
                cov += cover[row + i0:row + i1 + 1].count(1)
                vals += [nd[row + i] for i in range(i0, i1 + 1) if nd[row + i] > 1.0]
            if tot < 10 or cov / tot < 0.8 or len(vals) < 5:
                continue
            vals.sort()
            p90 = quantile(vals, 0.9)
            if ht is not None:
                pairs_h.append((ht, p90))
            elif lv is not None and lv >= 1:
                pairs_l.append((lv, p90))
    res = {}
    if pairs_h:
        diffs = sorted(z - o for o, z in pairs_h)
        res["height_tag"] = {"n": len(pairs_h), "bias_median": round(statistics.median(diffs), 2),
                             "mae": round(sum(abs(d) for d in diffs) / len(diffs), 2),
                             "worst": sorted(pairs_h, key=lambda p: -abs(p[1] - p[0]))[:3]}
    if len(pairs_l) > 3:
        n = len(pairs_l)
        mx = sum(l for l, _ in pairs_l) / n
        my = sum(h for _, h in pairs_l) / n
        sxx = sum((l - mx) ** 2 for l, _ in pairs_l)
        sxy = sum((l - mx) * (h - my) for l, h in pairs_l)
        a = sxy / sxx
        c = my - a * mx
        mae_fit = sum(abs(h - (a * l + c)) for l, h in pairs_l) / n
        mae_rule = sum(abs(h - (LEVEL_M * l + LEVEL_C)) for l, h in pairs_l) / n
        bias_rule = statistics.median([LEVEL_M * l + LEVEL_C - h for l, h in pairs_l])
        mae_31 = sum(abs(h - (3.1 * l + 1.5)) for l, h in pairs_l) / n
        res["levels"] = {"n": n, "fit_a": round(a, 2), "fit_c": round(c, 2), "fit_mae": round(mae_fit, 2),
                         "rule": f"{LEVEL_M}*L+{LEVEL_C}", "rule_mae": round(mae_rule, 2),
                         "rule_bias_median": round(bias_rule, 2), "ref_3.1L+1.5_mae": round(mae_31, 2),
                         "median_h_per_level": round(statistics.median([h / l for l, h in pairs_l]), 2)}
    stats["heights_vs_osm"] = res


def roads_in_buildings(roads: list[dict], cover: bytearray, grid: Grid, stats: dict) -> None:
    """Share of motor-road centreline length (c <= 3) that runs over ZG3D roofs: bridges, building passages
    and underpasses are expected; a large share would reveal a frame offset between OSM and ZG3D."""
    tot = inside = 0.0
    for r in roads:
        if r["c"] > 3:
            continue
        p = r["p"]
        for i in range(len(p) - 1):
            L = math.dist(p[i], p[i + 1])
            n = max(1, int(L))
            for s in range(n):
                f = (s + 0.5) / n
                k = grid.index(p[i][0] + f * (p[i + 1][0] - p[i][0]), p[i][1] + f * (p[i + 1][1] - p[i][1]))
                tot += L / n
                if k is not None and cover[k]:
                    inside += L / n
    stats["roads_over_roofs"] = {"motor_road_km": round(tot / 1000, 2), "over_zg3d_m": round(inside),
                                 "share": round(inside / tot, 4) if tot else None}


# ------------------------------------------------------------------ PNG plots (stdlib)
class Canvas:
    """RGB canvas in the local frame: pixel (i, j) <-> x = x0 + (i + 0.5) m, z = z0 + (j + 0.5) m (north up)."""

    def __init__(self, x0: float, z0: float, size_m: float, px: int, bg=(245, 245, 240)):
        self.x0, self.z0, self.w, self.h = x0, z0, px, px
        self.s = px / size_m
        self.buf = bytearray(bytes(bg) * (px * px))

    def to_px(self, x, z):
        return (x - self.x0) * self.s, (z - self.z0) * self.s

    def fill(self, ring, rgb):
        """Solid polygon fill (scanline, even-odd)."""
        pts = [self.to_px(x, z) for x, z in ring]
        zs = [p[1] for p in pts]
        j0, j1 = max(0, int(min(zs))), min(self.h - 1, int(max(zs)) + 1)
        col = bytes(rgb)
        m = len(pts)
        for j in range(j0, j1 + 1):
            zc = j + 0.5
            xs = []
            for k in range(m):
                (ax, az), (bx, bz) = pts[k], pts[(k + 1) % m]
                if (az > zc) != (bz > zc):
                    xs.append(ax + (zc - az) * (bx - ax) / (bz - az))
            xs.sort()
            for k in range(0, len(xs) - 1, 2):
                i0, i1 = max(0, int(math.ceil(xs[k] - 0.5))), min(self.w - 1, int(math.floor(xs[k + 1] - 0.5)))
                if i1 >= i0:
                    o = 3 * (j * self.w + i0)
                    self.buf[o:o + 3 * (i1 - i0 + 1)] = col * (i1 - i0 + 1)

    def dot(self, i, j, rgb, r=0):
        """A (2r+1)-pixel square at pixel (i, j)."""
        for jj in range(j - r, j + r + 1):
            for ii in range(i - r, i + r + 1):
                if 0 <= ii < self.w and 0 <= jj < self.h:
                    o = 3 * (jj * self.w + ii)
                    self.buf[o:o + 3] = bytes(rgb)

    def line(self, pts, rgb, r=0):
        """Polyline in local metres, drawn by dense sampling (DDA) with dots of half-width r."""
        for k in range(len(pts) - 1):
            (ax, az), (bx, bz) = self.to_px(*pts[k]), self.to_px(*pts[k + 1])
            n = int(max(abs(bx - ax), abs(bz - az))) + 1
            for s in range(n + 1):
                f = s / n
                self.dot(int(ax + f * (bx - ax)), int(az + f * (bz - az)), rgb, r)

    def outline(self, ring, rgb, r=0):
        """Closed ring outline."""
        self.line(list(ring) + [ring[0]], rgb, r)

    def band(self, pts, width, rgb):
        """Carriageway band: one quad per segment (width in m)."""
        for k in range(len(pts) - 1):
            (ax, az), (bx, bz) = pts[k], pts[k + 1]
            L = math.hypot(bx - ax, bz - az) or 1e-9
            nx, nz = -(bz - az) / L * width / 2, (bx - ax) / L * width / 2
            self.fill([(ax + nx, az + nz), (bx + nx, bz + nz), (bx - nx, bz - nz), (ax - nx, az - nz)], rgb)

    def save(self, path: Path):
        """Write an 8-bit RGB PNG with the stdlib (zlib + CRC32 chunks)."""
        raw = b"".join(b"\x00" + bytes(self.buf[3 * j * self.w:3 * (j + 1) * self.w]) for j in range(self.h))

        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0)) \
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(png)


YEAR_RGB = {2008: (150, 150, 150), 2019: (90, 140, 220), 2022: (235, 140, 40), 0: (200, 60, 200)}


def plot(env: dict, osm_rings: list, path: Path, x0: float, z0: float, size: float, px: int,
         bands: bool = False, grid_m: float = 0.0) -> None:
    """Top-down validation plot (north up) of the square [x0, x0+size] x [z0, z0+size] at px pixels.
    bands=True draws carriageways at their width and trees as crown circles; grid_m adds edge ticks."""
    cv = Canvas(x0, z0, size, px)
    for g in env["green"]:
        cv.fill(g, (205, 228, 195))
    for w in env["water"]:
        cv.fill(w, (170, 200, 235))
    for hpoly in env["heating"]:
        cv.outline(hpoly["p"], (170, 110, 60), 1 if bands else 0)
    for b in env["buildings"]:
        cv.fill(b["p"], YEAR_RGB.get(b["s"], YEAR_RGB[0]) if b["k"] == "zg3d" else YEAR_RGB[0])
    if bands:
        for r in env["roads"]:
            if r["c"] <= 4:
                cv.band(r["p"], r["w"], {"A": (120, 120, 200), "B": (200, 120, 120)}.get(r["g"], (160, 160, 160)))
    for ring in osm_rings:
        cv.outline(ring, (220, 30, 30))
    for r in env["roads"]:
        if r["c"] <= 4:
            cv.line(r["p"], {"A": (20, 20, 160), "B": (160, 20, 20)}.get(r["g"], (60, 60, 60)), 1 if bands else 0)
    for t in env["tram"]:
        cv.line(t, (0, 150, 0))
    for t in env["trees"]:
        if bands:                                   # crown outline of radius r
            cv.outline([(t["x"] + t["r"] * math.cos(a * math.pi / 12), t["z"] + t["r"] * math.sin(a * math.pi / 12))
                        for a in range(24)], (0, 110, 0))
        i, j = cv.to_px(t["x"], t["z"])
        cv.dot(int(i), int(j), (0, 110, 0), 1)
    st = env["station"]
    cv.outline(st["container"], (255, 0, 255), 1)
    i, j = cv.to_px(0, 0)
    cv.dot(int(i), int(j), (255, 0, 255), 3)
    if grid_m:
        k = math.ceil(x0 / grid_m)
        while k * grid_m < x0 + size:
            cv.line([(k * grid_m, z0), (k * grid_m, z0 + size * 0.02)], (0, 0, 0))
            cv.line([(x0, k * grid_m), (x0 + size * 0.02, k * grid_m)], (0, 0, 0))
            k += 1
    cv.save(path)


# ------------------------------------------------------------------ main
def main(argv: list[str] | None = None) -> int:
    """Run steps 1-7 (module docstring) and write env.json, lod2.bin, the validation JSON and the plots."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--no-lod2", action="store_true", help="do not write src/data/lod2.bin")
    ap.add_argument("--no-plots", action="store_true", help="do not write the validation PNGs")
    ap.add_argument("--out", type=Path, default=ENV_JSON, help="env.json path")
    args = ap.parse_args(argv)
    t0 = time.time()
    stats: dict = {"generated_utc": utcnow_iso()}

    dtm = DTM.load()
    dtm_meta = json.loads(DTM_JSON.read_text(encoding="utf-8"))
    zmeta = json.loads(ZG3D_META.read_text(encoding="utf-8")) if ZG3D_META.exists() else {}
    ometa = json.loads((OSM_DIR / "fetch_meta.json").read_text(encoding="utf-8")) if (OSM_DIR / "fetch_meta.json").exists() else {"layers": {}}

    # 1. buildings
    fps = load_footprints()
    zg3d, ground, cover_rings = build_zg3d(fps, dtm, stats)
    grid = Grid(RASTER_HALF, 1.0)
    cover = paint_mask(grid, cover_rings)
    osm_bld_el = load_osm("buildings")
    osm_fb = build_osm_fallback(osm_bld_el, cover, grid, stats)
    buildings = zg3d + osm_fb
    log.info("buildings: %d ZG3D parts (%d rings) + %d OSM fallback; %.1f s", stats["zg3d"]["kept_parts"],
             len(zg3d), len(osm_fb), time.time() - t0)

    # 2. roads, 3. trees, 4. layers
    roads, replaced, _ov = build_roads(load_osm("roads"), stats)
    tram, rail = build_rail(load_osm("rail"), stats)
    trees = build_trees(load_osm("trees"), cover, grid, stats)
    landuse_el = load_osm("landuse")
    green, water, paved, residential = build_areas(landuse_el, stats)
    houses = build_house_tags(osm_bld_el)
    heating = build_heating(residential, buildings, houses, stats)
    pois_el = load_osm("pois")
    pois = build_pois(pois_el, stats)
    labels = build_labels(roads, landuse_el, pois_el, stats)
    station = build_station(load_osm("station"))
    log.info("roads %d, tram %d, rail %d, trees %d, green %d, water %d, paved %d, heating %d, pois %d, labels %d",
             len(roads), len(tram), len(rail), len(trees), len(green), len(water), len(paved), len(heating),
             len(pois), len(labels))

    # 5. morphometry from the LoD2 roofs (nDSM), and from the LoD1 prisms for comparison
    t1 = time.time()
    parts = load_parts()
    all_tris, _ = lod2_triangles(parts, ground, None)
    roof = []
    for (a, b, c), _yr in all_tris:
        ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
        vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        nn = math.sqrt(nx * nx + ny * ny + nz * nz)
        if nn > 0 and abs(ny) / nn >= ROOF_NZ:
            roof.append((a, b, c))
    nd = paint_roofs(grid, roof)
    log.info("nDSM from %d roof triangles in %.1f s", len(roof), time.time() - t1)
    morph = build_morph(grid, nd, stats, "lod2")
    Hp = paint_heights(grid, [b for b in buildings])
    build_morph(grid, Hp, stats, "lod1")
    log.info("morph (LoD2 nDSM): %s; %.1f s", {k: v for k, v in morph.items() if k != "sectors"}, time.time() - t1)

    # env.json
    osm_layers = ometa.get("layers", {})
    osm_bases = sorted({v.get("osm_base", "") for v in osm_layers.values() if v.get("osm_base")})
    meta = {
        "generated_utc": stats["generated_utc"],
        "frame": dict(SITE["frame"]),
        "extent": {"half_m": HALF, "lod2_radius_m": LOD2_R},
        "sources": {
            "zg3d": {"fetched": zmeta.get("fetched"), "parts": len(zg3d), "service_parts": zmeta.get("count"),
                     "data_last_edit": zmeta.get("data_last_edit"), "service": SITE["zg3d"]["feature_server"]},
            "osm": {"fetched": min((v.get("fetched", "") for v in osm_layers.values()), default=None),
                    "osm_base": osm_bases[0] if osm_bases else None,
                    "endpoints": sorted({v.get("endpoint", "") for v in osm_layers.values()}),
                    "fallback_buildings": len(osm_fb)},
            "dtm": {"fetched": dtm_meta["meta"]["fetched"], "url": dtm_meta["meta"]["url"], "crs": "EPSG:3045",
                    "station_ground_m": dtm_meta["station"]["h"], "range_m": dtm_meta["range"]},
        },
        "attribution": [SITE["zg3d"]["attribution"], SITE["dtm"]["attribution"], SITE["attribution"]["osm"]],
        "notes": [
            "Heights in metres above local ground (DGU DTM at each part's centroid); ground is flat in the model.",
            "Building rings with courtyards are single keyhole rings (zero-width bridges; even-odd fill).",
            "Miramarska carriageways within |z| <= 40 m follow the 0.1 m orthophoto 2022 (critic §1.6).",
            "AADT are model defaults (critic §4.6), not counts: no public traffic counts exist (critic G1).",
        ],
    }
    env = {"meta": meta, "buildings": buildings, "roads": roads, "tram": tram, "rail": rail, "trees": trees,
           "green": green, "water": water, "paved": paved, "heating": heating, "pois": pois, "labels": labels,
           "station": station, "morph": morph}
    size = write_json(args.out, env)
    stats["env_bytes"] = size
    stats["env_bytes_by_key"] = {k: len(json.dumps(v, separators=(",", ":"), ensure_ascii=False).encode()) for k, v in env.items()}
    log.info("wrote %s: %.0f KB", args.out, size / 1024)
    if size > 1.5e6:
        log.warning("env.json is %.2f MB, above the 1.5 MB target (architecture §4.1)", size / 1e6)

    # 6. LoD2 mesh
    if not args.no_lod2:
        tris, lst = lod2_triangles(parts, ground, LOD2_R)
        info = write_lod2(LOD2_BIN, tris)
        stats["lod2"] = {**lst, **info, "radius_m": LOD2_R}
        log.info("wrote %s: %d triangles, %.2f MB (%d parts, %d bottom faces dropped)", LOD2_BIN, info["triangles"],
                 info["bytes"] / 1e6, lst["parts"], lst["dropped_bottom"])

    # 7. validation
    osm_rings = [o for e in osm_bld_el if "building" in e.get("tags", {}) and e.get("id") != SITE["station"]["osm_way"]
                 for o, _ in osm_polygons(e)]
    height_validation(osm_bld_el, nd, grid, cover, stats)
    stats["alignment"] = alignment_shift(zg3d, osm_rings)
    roads_in_buildings(roads, cover, grid, stats)
    bmd = sorted(stats["zg3d"].pop("base_minus_dtm"))
    stats["zg3d"]["base_minus_dtm"] = {"n": len(bmd), "median": round(quantile(bmd, 0.5), 2),
                                       "p25": round(quantile(bmd, 0.25), 2), "p75": round(quantile(bmd, 0.75), 2),
                                       "p5": round(quantile(bmd, 0.05), 2), "p95": round(quantile(bmd, 0.95), 2),
                                       "ge_1m": sum(1 for v in bmd if v >= 1.0), "gt_3m": sum(1 for v in bmd if v > 3.0)}
    gs = [v for v in bmd if v < 3.0]                   # ground-standing parts, as in lidar-3d §3.2
    stats["zg3d"]["base_minus_dtm_ground"] = {"n": len(gs), "median": round(quantile(gs, 0.5), 2),
                                              "p25": round(quantile(gs, 0.25), 2), "p75": round(quantile(gs, 0.75), 2),
                                              "p5": round(quantile(gs, 0.05), 2), "p95": round(quantile(gs, 0.95), 2)}
    hs = sorted(b["h"] for b in zg3d)
    stats["zg3d"]["h"] = {"median": quantile(hs, 0.5), "p95": round(quantile(hs, 0.95), 1), "max": hs[-1]}
    stats["dtm"] = {"station": dtm_meta["station"]["h"], "range_box": dtm_meta["range"],
                    "window_range": [min(dtm_meta["window"]["h"]), max(dtm_meta["window"]["h"])]}
    write_json(VALID_DIR / "geometry_validation.json", stats, compact=False)
    log.info("alignment %s; roads over roofs %s; heights %s", stats["alignment"], stats["roads_over_roofs"],
             stats["heights_vs_osm"])

    if not args.no_plots:
        t2 = time.time()
        plot(env, osm_rings, IMG_DIR / "geo_overview.png", -HALF, -HALF, 2 * HALF, 1000, grid_m=100)
        plot(env, osm_rings, IMG_DIR / "geo_station_200m.png", -100, -100, 200, 1000, bands=True, grid_m=10)
        plot(env, osm_rings, IMG_DIR / "geo_station_80m.png", -40, -40, 80, 800, bands=True, grid_m=10)
        log.info("plots in %s (%.1f s)", IMG_DIR, time.time() - t2)
    log.info("done in %.1f s", time.time() - t0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
