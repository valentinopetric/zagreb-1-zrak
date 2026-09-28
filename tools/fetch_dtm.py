#!/usr/bin/env python3
"""fetch_dtm.py - terrain heights for the scene box from the DGU INSPIRE 20 m DTM (stdlib only).

Why this file exists
    Building heights must be *above local ground* (docs/architecture.md §2): h = Z_Max - DTM and
    b = Z_Min - DTM for every ZG3D part (critic §4.3 step 1). ZG3D gives absolute HVRS71 heights, so we
    need the terrain. The DGU INSPIRE Elevation tile RH_ELEV_107.tif (critic §4.1 D13, lidar-3d §3.3) is
    an uncompressed GeoTIFF, float64, one row per strip, EPSG:3045 (ETRS89 / UTM 33N), 34 MB. The server
    honours HTTP Range requests, so we read the TIFF header, parse the IFD, look up the strip offsets and
    fetch only the rows that cover the scene box (about 90 rows of 16.6 KB, one request).

What it writes
    data/cache/dtm/dtm_box.json
        meta    : url, CRS, fetch date, TIFF geometry (size, pixel, tie point, raster type, nodata)
        window  : the native raster window (row-major, north row first) in EPSG:3045, m a.s.l. (HVRS71)
        grid    : the same terrain resampled bilinearly onto a regular grid in the LOCAL frame
                  (x east, z south, SITE.frame; spacing 20 m = the native resolution) for display/diagnostics
        station : ground height at the ZAGREB-1 origin; range: min/max over the scene box
    data/cache/dtm/rows_<r0>_<r1>.bin  the raw bytes of the fetched rows (so re-runs need no network)

Map projection (implemented here, no pyproj)
    Both national CRSs are Transverse Mercator on GRS80 (ETRS89 datum; HTRS96 is its Croatian realisation):
        EPSG:3765 HTRS96/TM          lon0 = 16.5°, k0 = 0.9999, FE = 500 000 m, FN = 0
        EPSG:3045 ETRS89/UTM zone 33N lon0 = 15°,   k0 = 0.9996, FE = 500 000 m, FN = 0
    The forward and inverse mappings use Krüger's series in the third flattening n to order n^6, as given
    by Karney (2011, "Transverse Mercator with an accuracy of a few nanometers", J. Geodesy 85:475-485,
    eqs. 35-36 and the coefficient tables). Truncation error is < 1 mm within 4000 km of the central
    meridian. WGS84 lat/lon (OSM, ZG3D outSR=4326) is treated as ETRS89 (difference < 1 m, the same null
    transformation that ArcGIS and pyproj apply by default; critic §1.11 used the same assumption).
    Checked against the research values (lidar-3d §1): the DHMZ point 45.800496 N 15.97422 E maps to
    EPSG:3765 E 459129.318 N 5073538.234 and EPSG:3045 E 575706.67 N 5072343.07.

Usage
    python3 tools/fetch_dtm.py            # fetch (or reuse the cached rows) and write dtm_box.json
    python3 tools/fetch_dtm.py --refresh  # ignore cached rows
    python3 tools/fetch_dtm.py --file RH_ELEV_107.tif   # read a local copy of the tile instead of HTTP

Licence: DGU, Otvorena dozvola (critic §4.1 D13, lidar-3d §7).
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import time
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CACHE, SITE, get, latlon, log, utcnow_iso, write_json, xz  # noqa: E402

DTM_DIR = CACHE / "dtm"
DTM_JSON = DTM_DIR / "dtm_box.json"

# ------------------------------------------------------------------ ellipsoid and projections
# GRS80 (the ETRS89/HTRS96 ellipsoid): a = 6 378 137 m, 1/f = 298.257222101 (EPSG:7019).
GRS80_A = 6378137.0
GRS80_F = 1.0 / 298.257222101

# Transverse Mercator parameters of the two Croatian CRSs (EPSG registry definitions).
PROJ_3765 = {"name": "EPSG:3765 HTRS96/TM", "lon0": 16.5, "k0": 0.9999, "fe": 500000.0, "fn": 0.0}
PROJ_3045 = {"name": "EPSG:3045 ETRS89/UTM 33N", "lon0": 15.0, "k0": 0.9996, "fe": 500000.0, "fn": 0.0}


def _kruger_coefficients(f: float) -> tuple[float, list[float], list[float], list[float]]:
    """Rectifying radius A and the alpha, beta, delta series of Krüger (Karney 2011, order n^6).

    alpha: conformal -> TM (forward), beta: TM -> conformal (inverse), delta: conformal -> geodetic latitude.
    """
    n = f / (2.0 - f)
    n2, n3, n4, n5, n6 = n * n, n ** 3, n ** 4, n ** 5, n ** 6
    A = GRS80_A / (1.0 + n) * (1.0 + n2 / 4.0 + n4 / 64.0 + n6 / 256.0)
    alpha = [
        n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
        13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
        61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
        49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
        34729 * n5 / 80640 - 3418889 * n6 / 1995840,
        212378941 * n6 / 319334400,
    ]
    beta = [
        n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512 + 96199 * n6 / 604800,
        n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105 - 1118711 * n6 / 3870720,
        17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480 + 5569 * n6 / 90720,
        4397 * n4 / 161280 - 11 * n5 / 504 - 830251 * n6 / 7257600,
        4583 * n5 / 161280 - 108847 * n6 / 3991680,
        20648693 * n6 / 638668800,
    ]
    delta = [
        2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45 + 26 * n5 / 45 - 2854 * n6 / 675,
        7 * n2 / 3 - 8 * n3 / 5 - 227 * n4 / 45 + 2704 * n5 / 315 + 2323 * n6 / 945,
        56 * n3 / 15 - 136 * n4 / 35 - 1262 * n5 / 105 + 73814 * n6 / 2835,
        4279 * n4 / 630 - 332 * n5 / 35 - 399572 * n6 / 14175,
        4174 * n5 / 315 - 144838 * n6 / 6237,
        601676 * n6 / 22275,
    ]
    return A, alpha, beta, delta


_A, _ALPHA, _BETA, _DELTA = _kruger_coefficients(GRS80_F)
_N = GRS80_F / (2.0 - GRS80_F)
_E2N = 2.0 * math.sqrt(_N) / (1.0 + _N)   # first eccentricity e = 2*sqrt(n)/(1+n)


def tm_forward(lat: float, lon: float, proj: dict) -> tuple[float, float]:
    """Geodetic lat/lon (degrees, ETRS89 ~ WGS84) -> (Easting, Northing) in metres (Karney 2011 eq. 35)."""
    phi = math.radians(lat)
    lam = math.radians(lon - proj["lon0"])
    # conformal latitude via tau' (Karney eq. 7-9), written with atanh for clarity
    t = math.sinh(math.atanh(math.sin(phi)) - _E2N * math.atanh(_E2N * math.sin(phi)))
    xi_p = math.atan2(t, math.cos(lam))
    eta_p = math.atanh(math.sin(lam) / math.sqrt(1.0 + t * t))
    xi, eta = xi_p, eta_p
    for j, a in enumerate(_ALPHA, start=1):
        xi += a * math.sin(2 * j * xi_p) * math.cosh(2 * j * eta_p)
        eta += a * math.cos(2 * j * xi_p) * math.sinh(2 * j * eta_p)
    k0A = proj["k0"] * _A
    return proj["fe"] + k0A * eta, proj["fn"] + k0A * xi


def tm_inverse(e: float, n: float, proj: dict) -> tuple[float, float]:
    """(Easting, Northing) in metres -> geodetic (lat, lon) in degrees (Karney 2011 eq. 36)."""
    k0A = proj["k0"] * _A
    xi = (n - proj["fn"]) / k0A
    eta = (e - proj["fe"]) / k0A
    xi_p, eta_p = xi, eta
    for j, b in enumerate(_BETA, start=1):
        xi_p -= b * math.sin(2 * j * xi) * math.cosh(2 * j * eta)
        eta_p -= b * math.cos(2 * j * xi) * math.sinh(2 * j * eta)
    chi = math.asin(math.sin(xi_p) / math.cosh(eta_p))          # conformal latitude
    lam = math.atan2(math.sinh(eta_p), math.cos(xi_p))
    phi = chi
    for j, d in enumerate(_DELTA, start=1):
        phi += d * math.sin(2 * j * chi)
    return math.degrees(phi), proj["lon0"] + math.degrees(lam)


def local_to_3045(x: float, z: float) -> tuple[float, float]:
    """Local frame (x east, z south; common.xz) -> EPSG:3045 (E, N)."""
    lat, lon = latlon(x, z)
    return tm_forward(lat, lon, PROJ_3045)


# ------------------------------------------------------------------ TIFF parsing (classic TIFF, little/big endian)
TIFF_TYPES = {1: ("B", 1), 2: ("s", 1), 3: ("H", 2), 4: ("I", 4), 5: ("II", 8), 11: ("f", 4), 12: ("d", 8),
              16: ("Q", 8)}
TAG_NAMES = {256: "ImageWidth", 257: "ImageLength", 258: "BitsPerSample", 259: "Compression",
             262: "Photometric", 273: "StripOffsets", 277: "SamplesPerPixel", 278: "RowsPerStrip",
             279: "StripByteCounts", 284: "PlanarConfig", 322: "TileWidth", 323: "TileLength", 339: "SampleFormat",
             33550: "ModelPixelScale", 33922: "ModelTiepoint", 34735: "GeoKeyDirectory",
             34736: "GeoDoubleParams", 34737: "GeoAsciiParams", 42113: "GDAL_NODATA"}

Reader = Callable[[int, int], bytes]   # reader(offset, length) -> exactly `length` bytes


class TiffEntry:
    """One IFD entry. Small values are decoded eagerly; large arrays stay on disk/server until needed."""

    def __init__(self, tag: int, typ: int, count: int, raw_value: bytes, endian: str):
        self.tag, self.typ, self.count, self.endian = tag, typ, count, endian
        fmt, size = TIFF_TYPES[typ]
        self.item_size = size
        self.inline = size * count <= 4
        self.raw_value = raw_value
        self.offset = None if self.inline else struct.unpack(endian + "I", raw_value)[0]
        self._fmt = fmt

    def values(self, read: Reader, start: int = 0, n: int | None = None) -> list:
        """Decode items [start, start+n) of this entry, reading from `read` if the data is not inline."""
        n = self.count - start if n is None else n
        if self.inline:
            data = self.raw_value[start * self.item_size:(start + n) * self.item_size]
        else:
            data = read(self.offset + start * self.item_size, n * self.item_size)
        if self.typ == 2:
            return [data.split(b"\0", 1)[0].decode("latin-1")]
        if self.typ == 5:
            v = struct.unpack(self.endian + "%dI" % (2 * n), data)
            return [v[2 * i] / v[2 * i + 1] for i in range(n)]
        return list(struct.unpack(self.endian + "%d%s" % (n, self._fmt), data))


def parse_tiff_header(read: Reader) -> dict:
    """Parse the first IFD of a classic TIFF. Returns {'endian', 'entries': {tag: TiffEntry}, ...}.

    Only the features needed for the DGU tile are supported: classic (not Big) TIFF, one image,
    strips (not tiles). Anything else raises ValueError so that a changed tile format fails loudly.
    """
    head = read(0, 8)
    if head[:2] == b"II":
        endian = "<"
    elif head[:2] == b"MM":
        endian = ">"
    else:
        raise ValueError("not a TIFF file")
    magic, ifd = struct.unpack(endian + "HI", head[2:8])
    if magic != 42:
        raise ValueError(f"unsupported TIFF magic {magic} (BigTIFF is not supported)")
    n = struct.unpack(endian + "H", read(ifd, 2))[0]
    raw = read(ifd + 2, 12 * n)
    entries: dict[int, TiffEntry] = {}
    for i in range(n):
        tag, typ, count = struct.unpack_from(endian + "HHI", raw, 12 * i)
        if typ not in TIFF_TYPES:
            continue
        entries[tag] = TiffEntry(tag, typ, count, raw[12 * i + 8:12 * i + 12], endian)
    return {"endian": endian, "entries": entries}


def tiff_geometry(read: Reader) -> dict:
    """Image size, sample format, strip layout and GeoTIFF georeferencing of the first image."""
    hdr = parse_tiff_header(read)
    ent = hdr["entries"]

    def one(tag: int, default=None):
        return ent[tag].values(read)[0] if tag in ent else default

    if 322 in ent:
        raise ValueError("tiled TIFF not supported (expected strips)")
    g = {
        "endian": hdr["endian"],
        "width": one(256), "height": one(257), "bits": one(258), "compression": one(259, 1),
        "samples": one(277, 1), "rows_per_strip": one(278, 2 ** 32 - 1), "sample_format": one(339, 1),
        "nodata": None, "raster_type": 1, "epsg": None,
    }
    if g["compression"] != 1:
        raise ValueError(f"compressed TIFF (compression={g['compression']}) not supported")
    scale = ent[33550].values(read)
    tie = ent[33922].values(read)
    g["pixel"] = (scale[0], scale[1])
    g["tiepoint"] = tie                     # (i, j, k, X, Y, Z): raster (i, j) <-> model (X=E, Y=N)
    if 42113 in ent:
        try:
            g["nodata"] = float(ent[42113].values(read)[0].strip())
        except ValueError:
            g["nodata"] = None
    if 34735 in ent:                        # GeoKeyDirectory: header (4 shorts) + keys x 4 shorts
        keys = ent[34735].values(read)
        for k in range(keys[3]):
            key_id, loc, _cnt, val = keys[4 + 4 * k:8 + 4 * k]
            if loc == 0 and key_id == 1025:
                g["raster_type"] = val      # 1 = PixelIsArea (tie point at pixel corner), 2 = PixelIsPoint
            if loc == 0 and key_id == 3072:
                g["epsg"] = val
    g["_strip_offsets"] = ent[273]
    g["_strip_counts"] = ent[279]
    g["bytes_per_sample"] = g["bits"] // 8
    g["row_bytes"] = g["width"] * g["bytes_per_sample"] * g["samples"]
    return g


def pixel_centre(g: dict, col: float, row: float) -> tuple[float, float]:
    """Model (E, N) of the centre of pixel (col, row) (GeoTIFF: X = Easting, Y = Northing, row down)."""
    i0, j0, _k, X0, Y0, _Z = g["tiepoint"]
    sx, sy = g["pixel"]
    half = 0.5 if g["raster_type"] == 1 else 0.0
    return X0 + (col - i0 + half) * sx, Y0 - (row - j0 + half) * sy


def pixel_of(g: dict, e: float, n: float) -> tuple[float, float]:
    """Fractional (col, row) whose integer values are pixel centres (inverse of pixel_centre)."""
    i0, j0, _k, X0, Y0, _Z = g["tiepoint"]
    sx, sy = g["pixel"]
    half = 0.5 if g["raster_type"] == 1 else 0.0
    return (e - X0) / sx + i0 - half, (Y0 - n) / sy + j0 - half


def read_window(read: Reader, g: dict, r0: int, r1: int, c0: int, c1: int,
                read_rows: Callable[[int, int], bytes] | None = None) -> tuple[list[list[float]], dict]:
    """Read rows r0..r1 and columns c0..c1 (inclusive) of a 1-row-per-strip uncompressed float image.

    The strip offsets are read only for the needed rows. If the strips are contiguous (the usual GDAL
    layout: offset[r] = offset[r0] + (r - r0) * row_bytes) all rows come in ONE range request, otherwise
    one request per row restricted to the column window. Returns (rows, info).
    """
    if g["rows_per_strip"] != 1:
        raise ValueError("expected one row per strip")
    fmt = {(3, 8): "d", (3, 4): "f"}.get((g["sample_format"], g["bytes_per_sample"]))
    if fmt is None or g["samples"] != 1:
        raise ValueError("expected single-band IEEE float samples")
    nrows = r1 - r0 + 1
    offs = g["_strip_offsets"].values(read, r0, nrows)
    counts = g["_strip_counts"].values(read, r0, nrows)
    rb = g["row_bytes"]
    if any(c != rb for c in counts):
        raise ValueError("unexpected strip byte counts")
    contiguous = all(offs[i] == offs[0] + i * rb for i in range(nrows))
    bps = g["bytes_per_sample"]
    ncols = c1 - c0 + 1
    rows: list[list[float]] = []
    if contiguous:
        blob = (read_rows or read)(offs[0], nrows * rb)
        for i in range(nrows):
            rows.append(list(struct.unpack_from(g["endian"] + "%d%s" % (ncols, fmt), blob, i * rb + c0 * bps)))
    else:
        for i in range(nrows):
            data = read(offs[i] + c0 * bps, ncols * bps)
            rows.append(list(struct.unpack(g["endian"] + "%d%s" % (ncols, fmt), data)))
    return rows, {"contiguous": contiguous, "first_offset": offs[0], "bytes": nrows * rb if contiguous else nrows * ncols * bps}


# ------------------------------------------------------------------ readers (HTTP range or local file)
def http_reader(url: str) -> Reader:
    """reader(offset, length) through HTTP Range requests (common.get with the repo User-Agent, retries).

    common.get caches by URL only, so range requests are made with cache=False; this script caches the
    rows it needs itself (data/cache/dtm/rows_*.bin).
    """
    def read(offset: int, length: int) -> bytes:
        body = get(url, headers={"Range": f"bytes={offset}-{offset + length - 1}"}, cache=False, timeout=120)
        if len(body) != length:
            raise IOError(f"range {offset}+{length}: got {len(body)} bytes (server ignored Range?)")
        return body
    return read


def file_reader(path: Path) -> Reader:
    """reader(offset, length) on a local copy of the tile."""
    def read(offset: int, length: int) -> bytes:
        with open(path, "rb") as f:
            f.seek(offset)
            data = f.read(length)
        if len(data) != length:
            raise IOError(f"short read at {offset}")
        return data
    return read


def buffered(read: Reader, chunk: int = 65536) -> Reader:
    """Serve small reads from the first `chunk` bytes (the IFD and its arrays usually live there)."""
    head = {"data": None}

    def r(offset: int, length: int) -> bytes:
        if offset + length <= chunk:
            if head["data"] is None:
                head["data"] = read(0, chunk)
            return head["data"][offset:offset + length]
        return read(offset, length)
    return r


# ------------------------------------------------------------------ sampling
class DTM:
    """Bilinear terrain sampler in the local frame, backed by the native EPSG:3045 window.

    at(x, z) -> ground height (m a.s.l., HVRS71) at local (x east, z south). Outside the window the
    nearest edge value is used (the window has a margin of 3 pixels around the scene box).
    """

    def __init__(self, window: dict):
        self.e0, self.n0 = window["e0"], window["n0"]          # centre of pixel (0, 0) = NW pixel
        self.de, self.dn = window["de"], window["dn"]          # pixel size (dn > 0; rows go south)
        self.nc, self.nr = window["nc"], window["nr"]
        self.h = window["h"]
        self.nodata = window.get("nodata")

    @classmethod
    def load(cls, path: Path = DTM_JSON) -> "DTM":
        """The sampler for the cached window (tools/fetch_dtm.py must have run)."""
        if not path.exists():
            raise SystemExit(f"{path} missing: run tools/fetch_dtm.py first")
        return cls(json.loads(path.read_text(encoding="utf-8"))["window"])

    def at_en(self, e: float, n: float) -> float:
        """Bilinear height at EPSG:3045 (E, N); nodata neighbours are left out of the weights."""
        c = (e - self.e0) / self.de
        r = (self.n0 - n) / self.dn
        c = min(max(c, 0.0), self.nc - 1.000001)
        r = min(max(r, 0.0), self.nr - 1.000001)
        c0, r0 = int(c), int(r)
        fc, fr = c - c0, r - r0
        vals = [self.h[(r0 + dr) * self.nc + c0 + dc] for dr in (0, 1) for dc in (0, 1)]
        w = [(1 - fr) * (1 - fc), (1 - fr) * fc, fr * (1 - fc), fr * fc]
        good = [(v, wi) for v, wi in zip(vals, w) if v is not None and (self.nodata is None or v != self.nodata)]
        if not good:
            return float("nan")
        sw = sum(wi for _, wi in good) or 1.0
        return sum(v * wi for v, wi in good) / sw

    def at(self, x: float, z: float) -> float:
        """Bilinear height at local (x, z) (common.xz frame)."""
        e, n = local_to_3045(x, z)
        return self.at_en(e, n)


# ------------------------------------------------------------------ main
def box_window(g: dict, half: float, margin_px: int = 3) -> tuple[int, int, int, int]:
    """Pixel window (r0, r1, c0, c1) that covers the local square |x|,|z| <= half plus a margin."""
    cols, rows = [], []
    steps = 16
    for i in range(steps + 1):                      # sample the square's edges (TM is not affine)
        s = -half + 2 * half * i / steps
        for x, z in ((s, -half), (s, half), (-half, s), (half, s)):
            c, r = pixel_of(g, *local_to_3045(x, z))
            cols.append(c)
            rows.append(r)
    c0 = max(0, math.floor(min(cols)) - margin_px)
    c1 = min(g["width"] - 1, math.ceil(max(cols)) + margin_px)
    r0 = max(0, math.floor(min(rows)) - margin_px)
    r1 = min(g["height"] - 1, math.ceil(max(rows)) + margin_px)
    return r0, r1, c0, c1


def build(read: Reader, half: float, source: str, refresh: bool) -> dict:
    """Parse the tile, read the window covering the box and assemble the dtm_box.json content."""
    t0 = time.time()
    g = tiff_geometry(read)
    log.info("TIFF %dx%d, %d-bit float, pixel %.3f m, raster type %d, EPSG %s, nodata %s",
             g["width"], g["height"], g["bits"], g["pixel"][0], g["raster_type"], g["epsg"], g["nodata"])
    if g["epsg"] not in (None, 3045):
        raise SystemExit(f"unexpected CRS EPSG:{g['epsg']} (expected 3045)")
    r0, r1, c0, c1 = box_window(g, half)
    cache = DTM_DIR / f"rows_{r0}_{r1}.bin"

    def read_rows(offset: int, length: int) -> bytes:
        if cache.exists() and not refresh and cache.stat().st_size == length:
            return cache.read_bytes()
        data = read(offset, length)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(data)
        return data

    rows, info = read_window(read, g, r0, r1, c0, c1, read_rows)
    log.info("window rows %d-%d cols %d-%d (%d x %d px), %s, %.0f KB in %.1f s", r0, r1, c0, c1,
             c1 - c0 + 1, r1 - r0 + 1, "contiguous strips, one request" if info["contiguous"] else "per-row",
             info["bytes"] / 1024, time.time() - t0)
    e0, n0 = pixel_centre(g, c0, r0)
    flat = [v for row in rows for v in row]
    window = {"e0": round(e0, 3), "n0": round(n0, 3), "de": g["pixel"][0], "dn": g["pixel"][1],
              "nc": c1 - c0 + 1, "nr": r1 - r0 + 1, "nodata": g["nodata"], "h": [round(v, 3) for v in flat]}
    dtm = DTM(window)

    # Local-frame grid at the native spacing (20 m), nodes from -half-20 to +half+20 m.
    step = 20.0
    nx = int(round(2 * (half + step) / step)) + 1
    x0 = -(half + step)
    grid_h = [round(dtm.at(x0 + i * step, x0 + j * step), 2) for j in range(nx) for i in range(nx)]

    # Range over pixels whose centres fall inside the scene box, and the station value.
    inside = []
    for r in range(r1 - r0 + 1):
        for c in range(c1 - c0 + 1):
            e, n = pixel_centre(g, c0 + c, r0 + r)
            lat, lon = tm_inverse(e, n, PROJ_3045)
            x, z = xz(lat, lon)
            if abs(x) <= half and abs(z) <= half and flat[r * (c1 - c0 + 1) + c] != g["nodata"]:
                inside.append(flat[r * (c1 - c0 + 1) + c])
    station = dtm.at(0.0, 0.0)
    out = {
        "meta": {"url": source, "crs": "EPSG:3045", "vertical": "HVRS71 (m a.s.l.)", "fetched": utcnow_iso(),
                 "attribution": SITE["dtm"]["attribution"],
                 "tiff": {"width": g["width"], "height": g["height"], "pixel": g["pixel"], "tiepoint": g["tiepoint"],
                          "raster_type": g["raster_type"], "nodata": g["nodata"], "epsg": g["epsg"]},
                 "window_px": {"r0": r0, "r1": r1, "c0": c0, "c1": c1}, "strips_contiguous": info["contiguous"],
                 "half_m": half},
        "window": window,
        "grid": {"x0": x0, "z0": x0, "dx": step, "nx": nx, "nz": nx, "h": grid_h,
                 "note": "local frame (x east, z south), row-major by z; bilinear from the native window"},
        "station": {"x": 0.0, "z": 0.0, "h": round(station, 2)},
        "range": [round(min(inside), 2), round(max(inside), 2)],
        "mean": round(sum(inside) / len(inside), 2),
    }
    return out


def main(argv: list[str] | None = None) -> int:
    """Command line: fetch (or reuse cached rows) and write data/cache/dtm/dtm_box.json."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--refresh", action="store_true", help="ignore the cached rows and re-download")
    ap.add_argument("--file", type=Path, help="read a local copy of RH_ELEV_107.tif instead of HTTP")
    ap.add_argument("--half", type=float, default=SITE["extent"]["scene_half_m"], help="scene half-size, m")
    args = ap.parse_args(argv)
    url = SITE["dtm"]["url"]
    if args.file:
        read, source = file_reader(args.file), str(args.file)
    else:
        read, source = buffered(http_reader(url)), url
    out = build(read, args.half, source, args.refresh)
    n = write_json(DTM_JSON, out)
    log.info("ground at the station %.2f m, box range %.2f-%.2f m (mean %.2f); wrote %s (%d KB)",
             out["station"]["h"], out["range"][0], out["range"][1], out["mean"], DTM_JSON, n // 1024)
    return 0


if __name__ == "__main__":
    sys.exit(main())
