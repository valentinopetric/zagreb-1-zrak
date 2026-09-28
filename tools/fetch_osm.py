#!/usr/bin/env python3
"""fetch_osm.py - OpenStreetMap layers for the scene box through the Overpass API (stdlib only).

What OSM provides here (critic §4.1 D14, §4.3 step 2; site-context §2-6)
    roads      every highway=* way with highway, name, lanes, oneway, maxspeed (traffic sources + display)
    rail       railway=* ways (tram tracks in the Vukovarska median, the main railway N of the station)
    buildings  building / building:part footprints: the FALLBACK where ZG3D has no roof (cover < 0.5,
               critic §1.9, §4.3), plus house/detached tags for the heating polygons (critic §4.6)
    trees      natural=tree nodes and natural=tree_row ways (porous obstacles; ZG3D has no vegetation)
    landuse    parks, grass, water, landuse=residential (heating area source), parking, squares
    pois       schools, kindergartens, hospitals, fuel stations, and named landmarks for the labels
    station    the ZAGREB-1 container, way 1409603653 (SITE.station.osm_way; excluded from the flow mask)

Protocol
    - POST to SITE.overpass[0] (overpass-api.de); on failure fall back to SITE.overpass[1] (kumi.systems).
    - A User-Agent is mandatory: overpass-api.de answers HTTP 406 without one (lidar-3d §3.1).
    - The kumi mirror served stale data in September 2026 (site-context §11), so the base timestamp of
      every answer is stored and a warning is logged when it is older than 30 days.
    - One query at a time with a pause between queries (Overpass etiquette; 2 slots per IP).
    - Bounding box = scene half-size + 50 m so that features crossing the box edge come complete.

Output
    data/cache/osm/<layer>.json   raw Overpass JSON (elements with `out geom tags` / `out center tags`)
    data/cache/osm/fetch_meta.json  endpoint, osm_base timestamp, element counts, fetch time per layer

Usage
    python3 tools/fetch_osm.py                 # fetch the layers that are not cached yet
    python3 tools/fetch_osm.py --refresh       # re-fetch all layers
    python3 tools/fetch_osm.py --only roads    # one layer

Licence: © OpenStreetMap contributors, ODbL 1.0. Everything derived from OSM in env.json stays ODbL.
"""
from __future__ import annotations

import argparse
import calendar
import json
import sys
import time
import urllib.error
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CACHE, SITE, bbox_latlon, get, log, utcnow_iso, write_json  # noqa: E402

OSM_DIR = CACHE / "osm"
META_JSON = OSM_DIR / "fetch_meta.json"
MARGIN_M = 50.0          # extra metres around the scene box (features crossing the edge come complete)
PAUSE_S = 2.0            # pause between two Overpass queries
STALE_DAYS = 30          # warn when the endpoint's data are older than this


def bbox_str(half: float) -> str:
    """Overpass bbox '(south,west,north,east)' of the local square |x|,|z| <= half."""
    s, w, n, e = bbox_latlon(half)
    return f"{s:.6f},{w:.6f},{n:.6f},{e:.6f}"


def queries(half: float) -> dict[str, str]:
    """The Overpass QL per layer (inspired by research/data/q_*.txt)."""
    b = bbox_str(half + MARGIN_M)
    lat0, lon0 = SITE["station"]["lat"], SITE["station"]["lon"]
    head = "[out:json][timeout:180];"
    return {
        "roads": f"""{head}
(
  way["highway"]({b});
);
out geom tags;""",
        "rail": f"""{head}
(
  way["railway"]({b});
);
out geom tags;""",
        "buildings": f"""{head}
(
  way["building"]({b});
  relation["building"]({b});
  way["building:part"]({b});
  relation["building:part"]({b});
);
out geom tags;""",
        "trees": f"""{head}
(
  node["natural"="tree"]({b});
  way["natural"="tree_row"]({b});
);
out geom tags;""",
        "landuse": f"""{head}
(
  nwr["landuse"]({b});
  nwr["leisure"]({b});
  nwr["natural"]["natural"!="tree"]({b});
  nwr["waterway"]({b});
  nwr["water"]({b});
  nwr["amenity"="parking"]({b});
  way["area:highway"]({b});
  way["highway"="pedestrian"]["area"="yes"]({b});
  nwr["place"="square"]({b});
);
out geom tags;""",
        "pois": f"""{head}
(
  nwr["amenity"~"^(school|kindergarten|hospital|clinic|fuel|university|college|theatre|arts_centre|concert_hall|townhall|bus_station|library|place_of_worship)$"]({b});
  nwr["healthcare"="hospital"]({b});
  nwr["name"]["tourism"]({b});
  nwr["name"]["railway"~"^(station|halt)$"]({b});
  nwr["name"]["building"]({b});
  nwr["name"]["man_made"~"^(tower|chimney)$"]({b});
  nwr["name"]["office"]({b});
);
out center tags;""",
        "station": f"""{head}
(
  way({SITE["station"]["osm_way"]});
  nwr["man_made"="monitoring_station"](around:300,{lat0},{lon0});
);
out geom tags;""",
    }


def _parse_osm_time(ts: str) -> float | None:
    """Epoch seconds of an Overpass timestamp (YYYY-MM-DDTHH:MM:SSZ), None if unparsable."""
    try:
        return calendar.timegm(time.strptime(ts, "%Y-%m-%dT%H:%M:%SZ"))
    except (TypeError, ValueError):
        return None


def overpass(query: str) -> tuple[dict, str]:
    """Run one query, trying each endpoint in SITE.overpass in turn. Returns (json, endpoint)."""
    body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last: Exception | None = None
    for url in SITE["overpass"]:
        try:
            raw = get(url, data=body, cache=False, retries=3, timeout=240,
                      headers={"Content-Type": "application/x-www-form-urlencoded"})
            d = json.loads(raw)
            remark = d.get("remark", "")
            if "runtime error" in remark or "timed out" in remark:
                raise RuntimeError(f"Overpass remark: {remark}")
            return d, url
        except (urllib.error.URLError, RuntimeError, json.JSONDecodeError, TimeoutError, ConnectionError) as e:
            log.warning("Overpass %s failed: %s", url, e)
            last = e
    raise SystemExit(f"all Overpass endpoints failed: {last}")


def main(argv: list[str] | None = None) -> int:
    """Fetch the missing (or all, --refresh) layers and update fetch_meta.json."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--refresh", action="store_true", help="re-fetch every layer")
    ap.add_argument("--only", action="append", help="fetch only this layer (repeatable)")
    ap.add_argument("--half", type=float, default=SITE["extent"]["scene_half_m"], help="scene half-size, m")
    args = ap.parse_args(argv)
    meta = json.loads(META_JSON.read_text(encoding="utf-8")) if META_JSON.exists() else {"layers": {}}
    qs = queries(args.half)
    todo = [k for k in qs if not args.only or k in args.only]
    first = True
    for layer in todo:
        path = OSM_DIR / f"{layer}.json"
        if path.exists() and not args.refresh:
            log.info("osm %s: cached (%s)", layer, path.name)
            continue
        if not first:
            time.sleep(PAUSE_S)
        first = False
        t = time.time()
        d, url = overpass(qs[layer])
        base = (d.get("osm3s") or {}).get("timestamp_osm_base", "")
        n = write_json(path, d)
        age = time.time() - (_parse_osm_time(base) or time.time())
        if age > STALE_DAYS * 86400:
            log.warning("osm %s: data from %s is %.0f days old (stale mirror?)", layer, base, age / 86400)
        meta["layers"][layer] = {"endpoint": url, "osm_base": base, "elements": len(d.get("elements", [])),
                                 "fetched": utcnow_iso(), "bytes": n}
        log.info("osm %s: %d elements, %.0f KB, base %s, %s, %.1f s", layer, len(d.get("elements", [])), n / 1024,
                 base, urllib.parse.urlparse(url).netloc, time.time() - t)
    meta["bbox"] = bbox_str(args.half + MARGIN_M)
    meta["half_m"] = args.half
    meta["attribution"] = SITE["attribution"]["osm"]
    write_json(META_JSON, meta, compact=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
