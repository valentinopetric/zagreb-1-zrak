#!/usr/bin/env python3
"""ISZZ hourly measurements for ZAGREB-1 and its background ZAGREB-4 -> data/processed/iszz_hourly.csv.gz

    python3 tools/fetch_iszz.py                      # incremental (default): only what is not final yet
    python3 tools/fetch_iszz.py --full               # ignore every cache, download 2023-01-01 .. today again
    python3 tools/fetch_iszz.py --refresh-validated  # re-download validated years (critic §3 G10: revisions)
    python3 tools/fetch_iszz.py --dry-run            # print the requests it would make
    python3 tools/fetch_iszz.py --offline            # no network: rebuild the outputs from cache / processed table

What it does (docs/01-data-sources.md §2 is the long version):

1. Stations and parameters come from config/site.json (`iszz.params`): every parameter flagged `z1` is fetched for
   ZAGREB-1 (ISZZ id 155), every parameter flagged `z4` for ZAGREB-4 (303), the background station chosen in
   critic §1.2. Parameter codes, units, the 1000-row cap, the 40-day chunk limit, the 1.1 s pace and the −900 sentinel
   threshold are all read from `SITE.iszz`; none is hard-coded here.
2. The period 2023-01-01 .. today (local days) is cut into calendar-month chunks (≤ 31 days, under the 40-day limit of
   critic §4.1 D1). Each chunk is one call of the export service (iszz-api §3):
       GET {SITE.iszz.export}?postaja=<id>&polutant=<code>&tipPodatka=<0|1>&vrijemeOd=dd.MM.yyyy&vrijemeDo=dd.MM.yyyy
   A response with >= 1000 rows is treated as silently truncated (iszz-api §3.2) and the chunk is split in halves
   until every part is below the cap.
3. Politeness (iszz-api §7): one request at a time, >= 1.1 s between requests, HTTP 429 (no Retry-After) -> sleep 1-2 s
   with jitter and retry (up to 60 times), 5xx / network errors -> exponential back-off (2, 4, ... 60 s, 6 tries).
4. Both hourly types are fetched: raw (tipPodatka 0, 1 decimal, arrives within 1-2 h) and validated (tipPodatka 1,
   3 decimals, published once a year for the whole previous year; iszz-api §0). Validated series carry a row for
   every hour, with −999 for hours the validator rejected; every value <= −900 is masked (iszz-api §0, gotcha 16).
5. Merge, preferring validated, per (station, parameter, LOCAL calendar year): if the validated rows of that year
   (sentinels included) number at least half the raw rows, the year uses the validated series only, otherwise the
   raw series only (iszz-api §10). Raw and validated are never mixed inside one year because validation changes the
   values a lot (2024 NOx: mean |raw − validated| = 26 µg/m³, docs/01-data-sources.md §2.6) and a raw hour the
   validator rejected must not come back.
6. Incremental re-runs. A chunk is *final* once it was downloaded at least `--settle-days` (60) days after its last
   day. Non-final raw chunks are downloaded again (at most once per `--min-age-hours`); with weekly runs this means
   "the last ~60 days": 16 series x 3-4 months = 48-64 requests per run (critic §4.9 suggests <= 60; a 45-day settle
   window would always stay under it, docs/01-data-sources.md §2.7). Validated chunks are requested only for
   years that have ended; a year that is still empty or incomplete is probed with ONE request (its last month) on
   each run for `--validated-lookback` (2) years, and downloaded in full as soon as the probe returns data.
7. Cache: data/cache/iszz/<station>/p<code>_t<type>_<first>_<last>.json (gitignored; same format as the research
   prototype research/fetch_iszz_proto.py, so its cache can seed this one). On a fresh checkout (e.g. the GitHub
   Action) the cache is empty; chunks are then rebuilt ("rehydrated") from the committed processed table and the
   chunk manifest in the completeness report, so nothing that is final is downloaded twice.
8. Outputs:
   - data/processed/iszz_hourly.csv.gz   columns t_utc_end,station,param,value,unit,validated
       t_utc_end = ISO-8601 UTC instant that ENDS the averaging hour (ISZZ convention, iszz-api §4);
       station = ISZZ id; param = the key in SITE.iszz.params; unit as in SITE; validated = 1 | 0.
       Rows are time-major (t, station, param) and gzip is written with mtime 0, so the file is byte-identical when
       the data are, and weekly updates append at the end (small git deltas).
   - data/processed/iszz_completeness.json   per station, parameter and year: valid hours, expected hours, %,
       source (validated | raw) and masked sentinels; request statistics; failures; the chunk manifest.
   - data/processed/iszz_pm10_gravimetric.csv   ZAGREB-1 daily gravimetric PM10 (the EU reference method, daily
       types 17/16, stamped at the START of the local day): the basis of the official 24-h exceedance count.

Time handling (iszz-api §4, architecture §2): `vrijeme` is epoch ms UTC marking the END of the hour. The local
(Europe/Zagreb) calendar is computed with the EU summer-time rule (last Sunday of March / October, 01:00 UTC), so no
tzdata is needed; tests/python/test_iszz.py checks it against zoneinfo where available. The "local year" of a value
is the local year of its hour START, which puts the "31.12. 24:00" value into the old year, as ISZZ does.

Exit status: 0 = ok, 2 = some chunk failed (outputs still written from the best data available: cache or the previous
table, never less than before), 3 = refused to overwrite because a series would lose data (see --allow-shrink).
"""
from __future__ import annotations

import argparse
import calendar
import csv
import datetime as dt
import gzip
import io
import json
import math
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CACHE, PROCESSED, SITE, USER_AGENT, get, log, utcnow_iso  # noqa: E402

# ------------------------------------------------------------------ constants (all sourced)
ISZZ = SITE["iszz"]
EXPORT_URL: str = ISZZ["export"]                          # critic §4.1 D1, iszz-api §3
FORM_URL: str = ISZZ["base"] + "/podatak/frm/gg?t=false&i=false"   # critic §4.1 D3: offered (station, code, type)
MAX_ROWS: int = ISZZ["max_rows"]                          # 1000-row silent truncation, iszz-api §3.2
CHUNK_DAYS: int = ISZZ["chunk_days"]                      # <= 40 days per request, critic §4.1 D1
PACE_S: float = ISZZ["pace_s"]                            # >= 1.1 s between requests, iszz-api §7
SENTINEL_MAX: float = ISZZ["missing_sentinel_max"]        # values <= −900 are the −999 "invalid" flag, iszz-api §0
TIP_RAW: int = ISZZ["types"]["hourly_raw"]                # 0 = "Satni izvorni podaci", iszz-api §5
TIP_VAL: int = ISZZ["types"]["hourly_validated"]          # 1 = "Satni validirani podaci", iszz-api §5
PARAMS: dict[str, dict] = ISZZ["params"]                  # key -> {code, unit, z1, z4}
STATIONS: dict[str, int] = {"z1": SITE["station"]["iszz_id"], "z4": SITE["background"]["iszz_id"]}
STATION_NAMES: dict[int, str] = {SITE["station"]["iszz_id"]: SITE["station"]["name"],
                                 SITE["background"]["iszz_id"]: SITE["background"]["name"]}

# The analysis period starts 2023-01-01: the new automatic PM10/PM2.5 analyser at ZAGREB-1 dates from 13.01.2023
# (iszz-api §1, §12 gotcha 22), so 2023+ is one consistent instrument set; the task and critic §4.1 fix this start.
PERIOD_START = dt.date(2023, 1, 1)
# A chunk is final once it was fetched >= 60 days after its end ("re-fetch only the last ~60 days", the task spec). With
# weekly runs 3-4 months per raw series stay non-final: 48-64 requests (critic §4.9 suggests <= 60 per refresh).
SETTLE_DAYS = 60
# A non-final chunk is not downloaded again within 6 h: repeated local runs stay cheap. ISZZ lags 1-2 h (iszz-api §4.7).
MIN_AGE_H = 6.0
# Validated data for year Y are published during Y+1 (iszz-api §0: validated 2025 exists, 2026 does not). A year that
# is still empty is probed for 2 years; after that a permanent hole (e.g. validated PM2.5 2024, iszz-api §6.1) is final.
VALIDATED_LOOKBACK_Y = 2
# Per-year merge rule of the research prototype (iszz-api §10): validated if its rows >= 50 % of the raw rows.
VALIDATED_MIN_SHARE = 0.5
# Retry policy measured in iszz-api §7: the limiter window is ~1 s and counts only accepted requests.
RETRY_429 = 60            # "no retry cap below about 60"
SLEEP_429_S = 1.0         # + U(0, 1) s jitter -> 1-2 s
RETRY_ERR = 6             # 5xx / network errors: 2, 4, 8, 16, 32, 60 s
HTTP_TIMEOUT_S = 120.0
FORM_MAX_AGE_S = 7 * 86400.0   # /frm/gg changes only when a station gains or loses an instrument
# Refuse to overwrite the table when a (station, param, year) with an unchanged source loses more than two days of
# hours: that only happens when something went wrong (an outage returning [] for a settled chunk, a bug).
SHRINK_TOLERANCE_H = 48

# Gravimetric PM10 (daily types 17 validated / 16 raw, iszz-api §5, §6.2) is the EU reference method (EN 12341) behind
# the official 24-h exceedance count. The automatic analyser counts more days above 50 µg/m³ (2025: 42 against 29,
# docs/01-data-sources.md §6.3), so the page must be able to show both. One request per year and type (<= 366 rows,
# under the cap). A year that has ended and has validated values for >= 90 % of its days is final and is reused from
# the committed CSV (2023 has 345 of 365 days = 94.5 %, sampling started on 4 January); only the running year and an
# incomplete last year are downloaded again (1-3 requests per run).
REFERENCE_DAILY: list[tuple[str, str, int, int]] = [("z1", "pm10", 17, 16)]   # (station, param, validated, raw type)
REF_COMPLETE_SHARE = 0.9

HOUR_MS = 3_600_000
CACHE_DIR = CACHE / "iszz"
OUT_CSV = PROCESSED / "iszz_hourly.csv.gz"
OUT_REPORT = PROCESSED / "iszz_completeness.json"
OUT_REF = PROCESSED / "iszz_pm10_gravimetric.csv"
REF_COLUMNS = ["date_local", "station", "param", "value", "unit", "validated"]
CSV_COLUMNS = ["t_utc_end", "station", "param", "value", "unit", "validated"]
# ISZZ spells units in ASCII or Croatian; the table uses the SITE spelling (iszz-api §3.3).
UNIT_FIX = {"µg/m3": "µg/m³", "mg/m3": "mg/m³", "ng/m3": "ng/m³", "degrees": "°", "degrees Celzius": "°C"}

Rec = tuple[int, float, str]   # (epoch ms UTC hour-ending, value, unit as delivered)


# ================================================================== time (Europe/Zagreb without tzdata)
def last_sunday(year: int, month: int) -> dt.date:
    """Last Sunday of a month (the EU summer-time switch days, Directive 2000/84/EC)."""
    last = dt.date(year, month, calendar.monthrange(year, month)[1])
    return last - dt.timedelta(days=(last.weekday() + 1) % 7)


def zagreb_offset(utc: dt.datetime) -> dt.timedelta:
    """UTC offset of Europe/Zagreb at a UTC instant: +2 h from the last Sunday of March 01:00 UTC to the last Sunday
    of October 01:00 UTC (CEST), else +1 h (CET). Directive 2000/84/EC; Croatia has followed it since 1996."""
    if utc.tzinfo is None:
        utc = utc.replace(tzinfo=dt.timezone.utc)
    y = utc.year
    start = dt.datetime.combine(last_sunday(y, 3), dt.time(1), dt.timezone.utc)
    end = dt.datetime.combine(last_sunday(y, 10), dt.time(1), dt.timezone.utc)
    return dt.timedelta(hours=2 if start <= utc < end else 1)


def ms_to_utc(ms: int) -> dt.datetime:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc)


def to_local(ms: int) -> dt.datetime:
    """Naive Europe/Zagreb wall-clock time of an instant."""
    u = ms_to_utc(ms)
    return (u + zagreb_offset(u)).replace(tzinfo=None)


def hour_start_local(t_end_ms: int) -> dt.datetime:
    """Local wall-clock START of the hour that ends at t_end_ms (architecture §2: the model's 'hour of day').
    On the spring switch day local 02 never appears; on the autumn switch day local 02 appears twice."""
    return to_local(t_end_ms - HOUR_MS)


def local_year(t_end_ms: int) -> int:
    """Calendar year an hour-ending value belongs to: ISZZ's "31.12. 24:00" slot is still the old year."""
    return hour_start_local(t_end_ms).year


def local_midnight_utc(day: dt.date) -> dt.datetime:
    """UTC instant of 00:00 local on `day`. The switches happen at 01:00 UTC, so local midnight is never ambiguous;
    evaluating the offset one hour before UTC midnight gives the offset in force at local midnight."""
    naive = dt.datetime.combine(day, dt.time(0), dt.timezone.utc)
    return naive - zagreb_offset(naive - dt.timedelta(hours=1))


def local_today(now_utc: dt.datetime | None = None) -> dt.date:
    now_utc = now_utc or dt.datetime.now(dt.timezone.utc)
    return (now_utc + zagreb_offset(now_utc)).date()


def iso_z(ms: int) -> str:
    return ms_to_utc(ms).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso_ms(s: str) -> int:
    """'2025-01-01T01:00:00Z' (or with an offset) -> epoch ms."""
    d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return int(round(d.timestamp() * 1000))


def hr_date(d: dt.date) -> str:
    """ISZZ date format dd.MM.yyyy; ISO dates give HTTP 204 (iszz-api §3.1)."""
    return d.strftime("%d.%m.%Y")


# ================================================================== chunks
@dataclass(frozen=True, order=True)
class Chunk:
    """One export request: whole LOCAL days first..last (inclusive). The service returns the hour-ending slots
    first 01:00 .. (last+1) 00:00 local (iszz-api §4.3), i.e. t_end in (midnight(first), midnight(last+1)]."""
    station: int
    code: int
    tip: int
    first: dt.date
    last: dt.date

    @property
    def url(self) -> str:
        q = {"postaja": self.station, "polutant": self.code, "tipPodatka": self.tip,
             "vrijemeOd": hr_date(self.first), "vrijemeDo": hr_date(self.last)}
        return EXPORT_URL + "?" + urllib.parse.urlencode(q)

    @property
    def id(self) -> str:
        """Stable key for the manifest in the completeness report."""
        return f"{self.station}/{self.code}/{self.tip}/{self.first:%Y%m%d}-{self.last:%Y%m%d}"

    def cache_path(self, root: Path) -> Path:
        return root / str(self.station) / f"p{self.code}_t{self.tip}_{self.first:%Y%m%d}_{self.last:%Y%m%d}.json"

    def window_ms(self) -> tuple[int, int]:
        """(lo, hi]: hour-ending epoch ms the chunk can contain."""
        lo = local_midnight_utc(self.first)
        hi = local_midnight_utc(self.last + dt.timedelta(days=1))
        return int(lo.timestamp() * 1000), int(hi.timestamp() * 1000)

    def expected_hours(self, now_utc: dt.datetime) -> int:
        """Hour slots in the window that have already ended (23 on the spring switch day, 25 in autumn)."""
        lo, hi = self.window_ms()
        now_ms = int(now_utc.timestamp() * 1000) // HOUR_MS * HOUR_MS
        return max(0, (min(hi, now_ms) - lo) // HOUR_MS)

    def halves(self) -> tuple["Chunk", "Chunk"]:
        """Split for a truncated response (>= MAX_ROWS rows)."""
        mid = self.first + (self.last - self.first) // 2
        return (Chunk(self.station, self.code, self.tip, self.first, mid),
                Chunk(self.station, self.code, self.tip, mid + dt.timedelta(days=1), self.last))


def plan_chunks(start: dt.date, end: dt.date, max_days: int = CHUNK_DAYS) -> list[tuple[dt.date, dt.date]]:
    """Calendar months clipped to [start, end]; a piece longer than max_days is cut into equal parts.
    Months keep cache keys stable between runs; with max_days = 40 a month (<= 31 days) is never cut."""
    if max_days < 1:
        raise ValueError("max_days must be >= 1")
    out: list[tuple[dt.date, dt.date]] = []
    d = start
    while d <= end:
        last = min(dt.date(d.year, d.month, calendar.monthrange(d.year, d.month)[1]), end)
        n = (last - d).days + 1
        parts = math.ceil(n / max_days)
        size = math.ceil(n / parts)
        a = d
        while a <= last:
            b = min(a + dt.timedelta(days=size - 1), last)
            out.append((a, b))
            a = b + dt.timedelta(days=1)
        d = last + dt.timedelta(days=1)
    return out


# ================================================================== parsing
def parse_export(payload) -> list[Rec]:
    """Parse an export response. Accepts the live shape [{vrijednost, mjernaJedinica, vrijeme: epoch ms}] and the
    outdated shape of servis_uputa.pdf [{"Podatak": {..., "vrijeme": ISO}}] (iszz-api §2, gotcha 13)."""
    if not isinstance(payload, list):
        raise ValueError(f"unexpected export payload type {type(payload).__name__}")
    out: list[Rec] = []
    for item in payload:
        rec = item.get("Podatak", item) if isinstance(item, dict) else None
        if not rec or rec.get("vrijednost") is None or rec.get("vrijeme") is None:
            continue
        t = rec["vrijeme"]
        ms = parse_iso_ms(t) if isinstance(t, str) else int(t)
        out.append((ms, float(rec["vrijednost"]), str(rec.get("mjernaJedinica") or "")))
    return out


def is_sentinel(v: float) -> bool:
    """Validated series flag rejected hours with −999 (iszz-api §0); raw series never do."""
    return v <= SENTINEL_MAX


def mask_sentinels(records: Iterable[Rec]) -> tuple[list[Rec], int]:
    """Drop sentinel rows; return (clean records, number masked)."""
    clean, n = [], 0
    for r in records:
        if is_sentinel(r[1]):
            n += 1
        else:
            clean.append(r)
    return clean, n


def norm_unit(unit: str, key: str) -> str:
    """SITE spelling of a unit; logs once if ISZZ reports a unit that differs from config/site.json."""
    want = PARAMS[key]["unit"]
    got = UNIT_FIX.get(unit, unit)
    if got and got != want and (key, got) not in _unit_warned:
        _unit_warned.add((key, got))
        log.warning("ISZZ unit %r for %s differs from SITE unit %r (kept SITE unit)", unit, key, want)
    return want


_unit_warned: set[tuple[str, str]] = set()


# ================================================================== HTTP client (iszz-api §7)
Opener = Callable[[str], tuple[int, bytes]]


def urlopen_bytes(url: str) -> tuple[int, bytes]:
    """Plain GET with the repo User-Agent; raises urllib.error.HTTPError for 4xx/5xx."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
        return r.status, r.read()


class IszzClient:
    """Serialised, paced client for the rate-limited export service.

    ISZZ answers too-fast requests with HTTP 429 and no Retry-After; the window is about 1 s and is shared by
    everybody on the same IP (iszz-api §7). The generic common.get() backs off exponentially, which is right for
    other hosts but needlessly slow here, so this client follows the measured policy: pace >= 1.1 s after the
    previous response, on 429 wait 1-2 s and retry (up to 60 times), on 5xx / network errors back off 2..60 s.
    The opener, sleep, clock and jitter are injectable so the tests run without network or waiting."""

    def __init__(self, opener: Opener | None = None, pace_s: float = PACE_S,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic,
                 jitter: Callable[[], float] = random.random):
        self.opener = opener or urlopen_bytes
        self.pace_s, self.sleep, self.clock, self.jitter = pace_s, sleep, clock, jitter
        self._last = -math.inf
        self.stats: dict[str, int] = defaultdict(int)

    def _pace(self) -> None:
        wait = self._last + self.pace_s - self.clock()
        if wait > 0:
            self.sleep(wait)

    def get_json(self, url: str):
        n429 = nerr = 0
        while True:
            self._pace()
            try:
                status, body = self.opener(url)
            except urllib.error.HTTPError as e:
                self._last = self.clock()
                self.stats["requests"] += 1
                if e.code == 429:
                    self.stats["http_429"] += 1
                    n429 += 1
                    if n429 > RETRY_429:
                        raise RuntimeError(f"gave up after {n429} x HTTP 429: {url}") from e
                    self.sleep(SLEEP_429_S + self.jitter())
                    continue
                if e.code >= 500 and nerr < RETRY_ERR:
                    nerr += 1
                    self.stats["http_5xx"] += 1
                    self.sleep(min(60.0, 2.0 ** nerr))
                    continue
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                self._last = self.clock()
                if nerr < RETRY_ERR:
                    nerr += 1
                    self.stats["net_errors"] += 1
                    log.warning("%s for %s, retry %d", e, url[:110], nerr)
                    self.sleep(min(60.0, 2.0 ** nerr))
                    continue
                raise
            self._last = self.clock()
            self.stats["requests"] += 1
            if status == 204 or not body:
                # 204 No Content = the server could not parse the parameters, e.g. an ISO date (iszz-api §3.4)
                raise ValueError(f"HTTP {status} with empty body (bad parameters?) for {url}")
            return json.loads(body.decode("utf-8"))


def fetch_split(client: IszzClient, chunk: Chunk, max_rows: int = MAX_ROWS) -> list[Rec]:
    """Download a chunk; a response with >= max_rows rows is truncated (iszz-api §3.2), so split and recurse.
    Rows outside the chunk's window are dropped (defensive; the service returns exactly the window)."""
    payload = client.get_json(chunk.url)
    if not isinstance(payload, list):
        raise ValueError(f"unexpected payload {type(payload).__name__} for {chunk.url}")
    if len(payload) >= max_rows:
        if chunk.first == chunk.last:
            raise RuntimeError(f"a single day returned {len(payload)} rows (>= {max_rows}): {chunk.url}")
        client.stats["splits"] += 1
        a, b = chunk.halves()
        return fetch_split(client, a, max_rows) + fetch_split(client, b, max_rows)
    lo, hi = chunk.window_ms()
    return [r for r in parse_export(payload) if lo < r[0] <= hi]


# ================================================================== cache and processed-table rehydration
@dataclass
class ChunkData:
    """What is known about one chunk in this run."""
    chunk: Chunk
    records: list[Rec]
    fetched_at: dt.datetime
    source: str                 # 'export' (downloaded now), 'cache', 'processed' (rehydrated)
    masked_extra: int = 0       # sentinel rows that a rehydrated chunk no longer contains (from the manifest)
    orig_rows: int | None = None   # rows ISZZ delivered, when the records are a rehydrated subset (manifest only)

    @property
    def rows(self) -> int:
        """Rows as delivered by ISZZ, sentinels included."""
        return len(self.records) + self.masked_extra

    @property
    def masked(self) -> int:
        return sum(1 for r in self.records if is_sentinel(r[1])) + self.masked_extra


def read_cache(chunk: Chunk, root: Path) -> ChunkData | None:
    p = chunk.cache_path(root)
    if not p.exists():
        return None
    try:
        meta = json.loads(p.read_text(encoding="utf-8"))
        fetched = dt.datetime.fromisoformat(meta["fetched_at"].replace("Z", "+00:00"))
        if fetched.tzinfo is None:
            fetched = fetched.replace(tzinfo=dt.timezone.utc)
        recs = [(int(a), float(b), str(c)) for a, b, c in meta["records"]]
        orig = meta.get("orig_rows")
        return ChunkData(chunk, recs, fetched, "cache", int(meta.get("masked_rows", 0)),
                         int(orig) if orig is not None else None)
    except (ValueError, KeyError, TypeError) as e:
        log.warning("corrupt cache %s (%s), will re-fetch", p.name, e)
        return None


def write_cache(cd: ChunkData, root: Path) -> None:
    """Atomic write; removes older files of the same chunk start (the current month's end date moves daily)."""
    p = cd.chunk.cache_path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    body = {"fetched_at": cd.fetched_at.isoformat(), "url": cd.chunk.url, "source": cd.source,
            "records": [list(r) for r in cd.records]}
    if cd.masked_extra:
        body["masked_rows"] = cd.masked_extra
    if cd.orig_rows is not None:
        body["orig_rows"] = cd.orig_rows
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(body, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, p)
    prefix = f"p{cd.chunk.code}_t{cd.chunk.tip}_{cd.chunk.first:%Y%m%d}_"
    for old in p.parent.glob(prefix + "*.json"):
        if old != p:
            old.unlink(missing_ok=True)


def read_processed(path: Path) -> dict[tuple[int, str], list[tuple[int, float, int]]]:
    """Read iszz_hourly.csv.gz -> {(station, param): [(t_end_ms, value, validated 0|1), ...] sorted by time}."""
    out: dict[tuple[int, str], list[tuple[int, float, int]]] = defaultdict(list)
    if not path.exists():
        return out
    with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            out[(int(row["station"]), row["param"])].append(
                (parse_iso_ms(row["t_utc_end"]), float(row["value"]), int(row["validated"])))
    for v in out.values():
        v.sort()
    return out


class Rehydrator:
    """Rebuilds chunks from the committed processed table when the (gitignored) cache is empty.

    The manifest (report['chunks']) records when each chunk was downloaded and how many sentinel rows it had. The
    table holds the merged series: validated rows of validated years and raw rows of raw years. Rebuilding a chunk
    from it gives exactly the rows the merge used, so the merge decision and output are unchanged; the raw rows of a
    validated year are not needed again (the year stays validated)."""

    def __init__(self, csv_path: Path, report_path: Path):
        self.manifest: dict[str, dict] = {}
        if report_path.exists():
            try:
                self.manifest = json.loads(report_path.read_text(encoding="utf-8")).get("chunks", {})
            except ValueError:
                log.warning("unreadable %s: no rehydration", report_path)
        self._csv_path = csv_path
        self._table: dict[tuple[int, str], list[tuple[int, float, int]]] | None = None
        self._code_to_key = {p["code"]: k for k, p in PARAMS.items()}

    def table(self) -> dict[tuple[int, str], list[tuple[int, float, int]]]:
        if self._table is None:
            self._table = read_processed(self._csv_path) if self.manifest else {}
        return self._table

    def load(self, chunk: Chunk) -> ChunkData | None:
        m = self.manifest.get(chunk.id)
        key = self._code_to_key.get(chunk.code)
        if not m or key is None or not self._csv_path.exists():
            return None
        lo, hi = chunk.window_ms()
        want = 1 if chunk.tip == TIP_VAL else 0
        unit = PARAMS[key]["unit"]
        recs = [(t, v, unit) for t, v, f in self.table().get((chunk.station, key), []) if f == want and lo < t <= hi]
        fetched = dt.datetime.fromisoformat(m["fetched"].replace("Z", "+00:00"))
        masked = int(m.get("masked", 0))
        return ChunkData(chunk, recs, fetched, "processed", masked, int(m.get("rows", len(recs) + masked)))


# ================================================================== fetch planning (incremental rules)
@dataclass
class Options:
    full: bool = False
    refresh_validated: bool = False
    offline: bool = False
    dry_run: bool = False
    settle_days: int = SETTLE_DAYS
    min_age_h: float = MIN_AGE_H
    lookback_y: int = VALIDATED_LOOKBACK_Y


def is_final(chunk: Chunk, fetched_at: dt.datetime, settle_days: int) -> bool:
    """Final = downloaded at least settle_days after the chunk's last local day."""
    return chunk.last < local_today(fetched_at) - dt.timedelta(days=settle_days)


@dataclass
class Fetcher:
    """Decides, per chunk, between cache / rehydrated table / download, and downloads what is needed."""
    client: IszzClient
    cache_dir: Path
    now: dt.datetime
    opts: Options
    rehydrator: Rehydrator | None = None
    failures: list[dict] = field(default_factory=list)
    planned: list[str] = field(default_factory=list)

    def load(self, chunk: Chunk) -> ChunkData | None:
        if self.opts.full:
            return None
        cd = read_cache(chunk, self.cache_dir)
        if cd is not None:
            self.client.stats["cache_hits"] += 1
            return cd
        if self.rehydrator is not None:
            cd = self.rehydrator.load(chunk)
            if cd is not None:
                self.client.stats["rehydrated"] += 1
                write_cache(cd, self.cache_dir)
                return cd
        return None

    def age_h(self, cd: ChunkData) -> float:
        return (self.now - cd.fetched_at).total_seconds() / 3600.0

    def download(self, chunk: Chunk, fallback: ChunkData | None) -> ChunkData | None:
        """Download a chunk; on failure keep the fallback (older) data so that nothing is lost."""
        if self.opts.offline:
            return fallback
        if self.opts.dry_run:
            self.planned.append(chunk.url)
            return fallback
        try:
            recs = fetch_split(self.client, chunk)
        except Exception as e:  # noqa: BLE001 - any failure is reported and the run continues
            self.failures.append({"chunk": chunk.id, "url": chunk.url, "error": repr(e)[:300]})
            log.error("FAILED %s: %r", chunk.id, e)
            return fallback
        cd = ChunkData(chunk, recs, self.now, "export")
        write_cache(cd, self.cache_dir)
        return cd

    def raw_series(self, chunks: list[Chunk]) -> list[ChunkData]:
        """Raw: download a chunk if it is unknown, or not final and older than min_age_h."""
        out = []
        for c in chunks:
            cd = self.load(c)
            stale = cd is None or (not is_final(c, cd.fetched_at, self.opts.settle_days)
                                   and self.age_h(cd) >= self.opts.min_age_h)
            if stale:
                cd = self.download(c, cd)
            if cd is not None:
                out.append(cd)
        return out

    def validated_series(self, chunks: list[Chunk]) -> list[ChunkData]:
        """Validated: per ended year, keep complete years; probe incomplete recent years with one request."""
        today = local_today(self.now)
        out = []
        by_year: dict[int, list[Chunk]] = defaultdict(list)
        for c in chunks:
            by_year[c.first.year].append(c)
        for year, cs in sorted(by_year.items()):
            if year >= today.year:
                continue   # validated data for the running year do not exist (published yearly, iszz-api §0)
            loaded = {c: self.load(c) for c in cs}
            rows = sum(cd.rows for cd in loaded.values() if cd)
            expected = sum(c.expected_hours(self.now) for c in cs)
            complete = all(loaded.values()) and rows >= VALIDATED_MIN_SHARE * expected
            recent = year >= today.year - self.opts.lookback_y
            if self.opts.full or (self.opts.refresh_validated and recent):
                todo = list(cs)
            elif complete:
                todo = []
            else:
                todo = [c for c in cs if loaded[c] is None]          # never seen: always fetch once
                if recent:
                    probe = cs[-1]                                   # last month of the year
                    pcd = loaded[probe]
                    # "Published" = the probe month is mostly there (a validated series has a row per hour);
                    # a stray value (validated PM2.5 2024 has exactly one, iszz-api §6.1) is not a release.
                    need = VALIDATED_MIN_SHARE * probe.expected_hours(self.now)
                    if pcd is None or (pcd.rows < need and self.age_h(pcd) >= self.opts.min_age_h):
                        pcd = self.download(probe, pcd)
                        loaded[probe] = pcd
                    todo = [c for c in todo if c != probe]
                    published = pcd is not None and pcd.rows >= need
                    if published:                                    # fetch every month that is still empty
                        todo = [c for c in cs if c != probe and (loaded[c] is None or loaded[c].rows == 0)]
                    elif pcd is not None:
                        todo = []                                    # not published yet: wait for the next run
            for c in todo:
                loaded[c] = self.download(c, loaded[c])
            out += [cd for cd in loaded.values() if cd is not None]
        return out


# ================================================================== merge (validated preferred, per local year)
@dataclass
class YearInfo:
    source: str | None = None     # 'validated' | 'raw' | None
    n: int = 0                    # valid (non-sentinel) values kept
    masked: int = 0               # sentinel rows of the chosen series
    raw_rows: int = 0
    val_rows: int = 0


def merge_series(raw: list[ChunkData], val: list[ChunkData]) -> tuple[dict[int, tuple[float, int]], dict[int, YearInfo]]:
    """Merge one (station, param): {t_end_ms: (value, validated)} and per-year bookkeeping.

    Year rule (iszz-api §10): validated if it has rows at all and its rows (sentinels included) >= 50 % of the raw
    rows of that year, else raw. Within the chosen series, sentinels (<= −900) are masked, never replaced by raw."""
    per: dict[int, dict[str, list[Rec]]] = defaultdict(lambda: {"raw": [], "val": []})
    extra: dict[int, int] = defaultdict(int)
    for cd in raw:
        per[cd.chunk.first.year]["raw"] += cd.records
    for cd in val:
        per[cd.chunk.first.year]["val"] += cd.records
        extra[cd.chunk.first.year] += cd.masked_extra
    out: dict[int, tuple[float, int]] = {}
    info: dict[int, YearInfo] = {}
    for year in sorted(per):
        r, v = per[year]["raw"], per[year]["val"]
        yi = YearInfo(raw_rows=len(r), val_rows=len(v) + extra[year])
        use_val = yi.val_rows > 0 and yi.val_rows >= VALIDATED_MIN_SHARE * yi.raw_rows
        pick = v if use_val else r
        clean, masked = mask_sentinels(pick)
        yi.masked = masked + (extra[year] if use_val else 0)
        for t, x, _u in clean:
            out.setdefault(t, (x, 1 if use_val else 0))
        yi.n = len({c[0] for c in clean})   # unique hours (chunks never overlap, this is only defensive)
        yi.source = ("validated" if use_val else "raw") if (clean or yi.masked) else None
        info[year] = yi
    return out, info


# ================================================================== outputs
def write_table(path: Path, merged: dict[tuple[int, str], dict[int, tuple[float, int]]]) -> int:
    """Deterministic gzip CSV, time-major. Returns the number of rows."""
    order = {k: i for i, k in enumerate(PARAMS)}
    rows = sorted(((t, st, key, v, f) for (st, key), s in merged.items() for t, (v, f) in s.items()),
                  key=lambda r: (r[0], r[1], order.get(r[2], 99)))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as gz, \
            io.TextIOWrapper(gz, encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(CSV_COLUMNS)
        for t, st, key, v, flag in rows:
            w.writerow([iso_z(t), st, key, f"{v:.10g}", PARAMS[key]["unit"], flag])
    os.replace(tmp, path)
    return len(rows)


def year_expected(year: int, start: dt.date, end: dt.date, now: dt.datetime) -> int:
    """Hour slots of a local year inside [start, end] that have ended by `now`."""
    a, b = max(start, dt.date(year, 1, 1)), min(end, dt.date(year, 12, 31))
    if a > b:
        return 0
    return Chunk(0, 0, 0, a, b).expected_hours(now)


def build_report(merged, infos, series_list, chunks_used, start, end, now, client, failures) -> dict:
    stations: dict[str, dict] = {}
    for st, key in series_list:
        s = merged.get((st, key), {})
        yinfo = infos.get((st, key), {})
        years = {}
        tot_n = tot_e = 0
        for y in range(start.year, end.year + 1):
            e = year_expected(y, start, end, now)
            yi = yinfo.get(y, YearInfo())
            years[str(y)] = {"n": yi.n, "expected": e, "pct": round(100.0 * yi.n / e, 2) if e else 0.0,
                             "source": yi.source, "masked": yi.masked}
            tot_n += yi.n
            tot_e += e
        ts = sorted(s)
        val_ts = [t for t in ts if s[t][1] == 1]
        entry = stations.setdefault(str(st), {"name": STATION_NAMES.get(st, str(st)), "params": {}})
        entry["params"][key] = {
            "code": PARAMS[key]["code"], "unit": PARAMS[key]["unit"], "n": tot_n, "expected": tot_e,
            "pct": round(100.0 * tot_n / tot_e, 2) if tot_e else 0.0,
            "first": iso_z(ts[0]) if ts else None, "last": iso_z(ts[-1]) if ts else None,
            "validated_until": iso_z(val_ts[-1]) if val_ts else None,
            "years": years}
    manifest = {cd.chunk.id: {"fetched": cd.fetched_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
                              "rows": cd.orig_rows if cd.orig_rows is not None else cd.rows, "masked": cd.masked}
                for cd in sorted(chunks_used, key=lambda c: c.chunk)}
    return {
        "generated_utc": utcnow_iso(),
        "period": {"start": start.isoformat(), "end": end.isoformat()},
        "rules": {
            "time": "t_utc_end = end of the averaging hour, UTC (iszz-api §4)",
            "year": "local (Europe/Zagreb) year of the hour START",
            "merge": f"per station/param/local year: validated if its rows (sentinels included) >= "
                     f"{VALIDATED_MIN_SHARE:.0%} of the raw rows, else raw; never mixed within a year",
            "sentinel": f"values <= {SENTINEL_MAX} masked (validated −999)",
            "expected": "hour slots of the local calendar year within the period that have ended",
        },
        "stations": stations,
        "http": dict(sorted(client.stats.items())),
        "failures": failures,
        "chunks": manifest,
    }


def shrink_check(prev: dict, new: dict) -> list[str]:
    """Series-years with an unchanged source that lost more than SHRINK_TOLERANCE_H valid hours."""
    problems = []
    for st, sd in prev.get("stations", {}).items():
        for key, pd in sd.get("params", {}).items():
            nd = new.get("stations", {}).get(st, {}).get("params", {}).get(key)
            if nd is None:
                continue
            for y, py in pd.get("years", {}).items():
                ny = nd["years"].get(y)
                if ny and py.get("source") and py.get("source") == ny.get("source") \
                        and ny["n"] < py["n"] - SHRINK_TOLERANCE_H:
                    problems.append(f"{st}/{key}/{y}: {py['n']} -> {ny['n']} valid hours ({py['source']})")
    return problems


# ================================================================== daily reference method (gravimetric PM10)
RefRow = tuple[dt.date, int, str, float, int]   # (local date, station, param, value, validated 0|1)


def daily_rows(records: list[Rec], st: int, key: str, validated: int) -> list[RefRow]:
    """Daily types are stamped 00:00 local at the START of the day (iszz-api §4.5), unlike the hourly ones."""
    return [(to_local(t).date(), st, key, v, validated) for t, v, _u in records if not is_sentinel(v)]


def fetch_reference_daily(client: IszzClient, start: dt.date, end: dt.date, opts: Options,
                          offered: dict[tuple[int, int], set[int]] | None, selected: set[tuple[int, str]],
                          planned: list[str], failures: list[dict], previous: list[RefRow] | None = None,
                          today: dt.date | None = None) -> list[RefRow] | None:
    """Gravimetric daily PM10 per year, validated (17) preferred over raw (16); final years come from `previous`.
    None = keep the previous file (offline, dry run, the series not selected, or a failed request, which is added
    to `failures`)."""
    if opts.offline:
        return None
    today = today or local_today()
    prev_by: dict[tuple[int, str, int], list[RefRow]] = defaultdict(list)
    for r in previous or []:
        prev_by[(r[1], r[2], r[0].year)].append(r)
    rows: list[RefRow] = []
    any_selected = False
    for prefix, key, tip_val, tip_raw in REFERENCE_DAILY:
        st, code = STATIONS[prefix], PARAMS[key]["code"]
        if (st, key) not in selected:
            continue
        any_selected = True
        for year in range(start.year, end.year + 1):
            a, b = max(start, dt.date(year, 1, 1)), min(end, dt.date(year, 12, 31))
            old = [r for r in prev_by.get((st, key, year), []) if a <= r[0] <= b]
            if (not opts.full and not opts.refresh_validated and year < today.year
                    and sum(r[4] for r in old) >= REF_COMPLETE_SHARE * ((b - a).days + 1)):
                rows += old          # final: validated and complete
                continue
            for tip in (tip_val, tip_raw):
                if offered is not None and tip not in offered.get((st, code), set()):
                    continue
                url = Chunk(st, code, tip, a, b).url
                if opts.dry_run:
                    planned.append(url)
                    continue
                try:
                    payload = client.get_json(url)
                except Exception as e:  # noqa: BLE001
                    failures.append({"chunk": f"reference/{st}/{code}/{tip}/{year}", "url": url, "error": repr(e)[:300]})
                    log.error("reference series %s failed (%r): keeping the previous file", url, e)
                    return None
                recs = [r for r in parse_export(payload) if a <= to_local(r[0]).date() <= b]
                if recs:
                    rows += daily_rows(recs, st, key, 1 if tip == tip_val else 0)
                    break   # validated found (or raw for the running year): the next type is not needed
    return rows if any_selected and not opts.dry_run else None


def write_reference(path: Path, rows: list[RefRow]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(REF_COLUMNS)
        for d, st, key, v, flag in sorted(rows):
            w.writerow([d.isoformat(), st, key, f"{v:.10g}", PARAMS[key]["unit"], flag])
    os.replace(tmp, path)


def read_reference(path: Path = OUT_REF) -> list[RefRow]:
    if not path.exists():
        return []
    with open(path, encoding="utf-8", newline="") as f:
        return [(dt.date.fromisoformat(r["date_local"]), int(r["station"]), r["param"], float(r["value"]),
                 int(r["validated"])) for r in csv.DictReader(f)]


# ================================================================== station capabilities
def offered_types(cache_dir: Path, offline: bool) -> dict[tuple[int, int], set[int]] | None:
    """{(station, code): {types}} from /frm/gg (not rate limited, iszz-api §2). None = unknown (assume offered)."""
    path = cache_dir / "frm_gg.json"
    meta = None
    if path.exists() and (offline or time.time() - path.stat().st_mtime < FORM_MAX_AGE_S):
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            meta = None
    if meta is None and not offline:
        try:
            meta = json.loads(get(FORM_URL, cache=False, retries=3, timeout=60).decode("utf-8"))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            log.warning("could not read %s (%s): assuming every configured type is offered", FORM_URL, e)
    if meta is None:
        return None
    out: dict[tuple[int, int], set[int]] = defaultdict(set)
    for s, p, t in meta.get("data", []):
        out[(int(s), int(p))].add(int(t))
    return out


def series_plan(stations: Iterable[str], params: Iterable[str] | None) -> list[tuple[int, str]]:
    """[(station id, param key)] in SITE order: z1 params for ZAGREB-1, z4 params for ZAGREB-4."""
    want = set(params) if params else None
    out = []
    for prefix in stations:
        st = STATIONS[prefix]
        for key, p in PARAMS.items():
            if p.get(prefix) and (want is None or key in want):
                out.append((st, key))
    return out


# ================================================================== main
def run(start: dt.date, end: dt.date, opts: Options, *, stations=("z1", "z4"), params=None,
        cache_dir: Path = CACHE_DIR, out_csv: Path = OUT_CSV, out_report: Path = OUT_REPORT,
        client: IszzClient | None = None, now: dt.datetime | None = None, allow_shrink: bool = False,
        rehydrate: bool = True) -> int:
    now = now or dt.datetime.now(dt.timezone.utc)
    client = client or IszzClient()
    prev_report = json.loads(out_report.read_text(encoding="utf-8")) if out_report.exists() else {}
    rehydrator = Rehydrator(out_csv, out_report) if rehydrate and not opts.full else None
    fetcher = Fetcher(client, cache_dir, now, opts, rehydrator)
    offered = offered_types(cache_dir, opts.offline)
    selected = set(series_plan(stations, params))
    everything = series_plan(("z1", "z4"), None)
    spans = plan_chunks(start, end)

    merged: dict[tuple[int, str], dict[int, tuple[float, int]]] = {}
    infos: dict[tuple[int, str], dict[int, YearInfo]] = {}
    used: list[ChunkData] = []
    for st, key in everything:
        code = PARAMS[key]["code"]
        # Series not selected on the command line are rebuilt offline so the table stays complete.
        fetcher.opts = opts if (st, key) in selected else Options(offline=True, settle_days=opts.settle_days,
                                                                  lookback_y=opts.lookback_y)
        t0 = time.monotonic()
        parts: dict[int, list[ChunkData]] = {TIP_RAW: [], TIP_VAL: []}
        for tip in (TIP_RAW, TIP_VAL):
            if offered is not None and tip not in offered.get((st, code), set()):
                continue   # e.g. no raw NOx at Mirogojska; meteo parameters have no validated type (iszz-api §6)
            cs = [Chunk(st, code, tip, a, b) for a, b in spans]
            parts[tip] = fetcher.raw_series(cs) if tip == TIP_RAW else fetcher.validated_series(cs)
            for cd in parts[tip]:
                if cd.records:
                    norm_unit(cd.records[0][2], key)   # warn once if ISZZ changes a unit
                    break
        merged[(st, key)], infos[(st, key)] = merge_series(parts[TIP_RAW], parts[TIP_VAL])
        used += parts[TIP_RAW] + parts[TIP_VAL]
        if (st, key) in selected:
            log.info("%-4s %-5s %6d h  (%.1f s, %d requests so far)", st, key, len(merged[(st, key)]),
                     time.monotonic() - t0, client.stats.get("requests", 0))
    fetcher.opts = opts
    ref_path = out_csv.parent / OUT_REF.name
    ref_rows = fetch_reference_daily(client, start, end, opts, offered, selected, fetcher.planned, fetcher.failures,
                                     read_reference(ref_path), local_today(now))

    if opts.dry_run:
        for u in fetcher.planned:
            print("GET", u)
        log.info("dry run: %d requests planned", len(fetcher.planned))
        return 0

    report = build_report(merged, infos, everything, used, start, end, now, client, fetcher.failures)
    ref_final = ref_rows if ref_rows is not None else read_reference(ref_path)
    ref_years: dict[str, dict[str, int]] = defaultdict(lambda: {"days": 0, "validated": 0})
    for d, _st, _key, _v, flag in ref_final:
        ref_years[str(d.year)]["days"] += 1
        ref_years[str(d.year)]["validated"] += flag
    report["reference_daily"] = {"pm10_gravimetric": {"file": OUT_REF.name, "station": STATIONS["z1"],
                                                      "years": dict(sorted(ref_years.items()))}}
    problems = shrink_check(prev_report, report)
    if problems and not allow_shrink:
        for p in problems:
            log.error("would lose data: %s", p)
        log.error("refusing to overwrite %s (use --allow-shrink if this is intended)", out_csv)
        return 3
    n = write_table(out_csv, merged)
    if ref_rows is not None:
        write_reference(ref_path, ref_rows)
    out_report.write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    log.info("wrote %s (%d rows, %.1f MB) and %s", out_csv.name, n, out_csv.stat().st_size / 1e6, out_report.name)
    print_summary(report)
    if fetcher.failures:
        log.error("%d chunk(s) failed; outputs keep the previous data for them. Re-run to retry.", len(fetcher.failures))
        return 2
    return 0


def print_summary(report: dict) -> None:
    """Completeness table on stdout (V = validated year, R = raw year)."""
    years = sorted({y for sd in report["stations"].values() for pd in sd["params"].values() for y in pd["years"]})
    print(f"{'series':12s} " + " ".join(f"{y:>13s}" for y in years) + f" {'total':>13s}")
    for st, sd in report["stations"].items():
        for key, pd in sd["params"].items():
            cells = []
            for y in years:
                yd = pd["years"][y]
                tag = {"validated": "V", "raw": "R"}.get(yd["source"], "-")
                cells.append(f"{yd['n']:6d} {yd['pct']:5.1f}{tag}")
            print(f"{sd['name']:8s} {key:4s}" + " ".join(cells) + f" {pd['n']:6d} {pd['pct']:5.1f}%")
    for name, rd in report.get("reference_daily", {}).items():
        print(f"{name}: " + ", ".join(f"{y} {d['days']} d ({d['validated']} validated)" for y, d in rd["years"].items()))
    print(f"http: {report['http']}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", default=PERIOD_START.isoformat(), help="first local day (YYYY-MM-DD)")
    ap.add_argument("--end", default=None, help="last local day (default: today in Europe/Zagreb)")
    ap.add_argument("--stations", default="z1,z4", help="comma list of z1 (ZAGREB-1), z4 (ZAGREB-4)")
    ap.add_argument("--params", default=None, help="comma list of parameter keys (default: all in SITE.iszz.params)")
    ap.add_argument("--full", action="store_true", help="ignore cache and processed table; download everything")
    ap.add_argument("--refresh-validated", action="store_true",
                    help="re-download the validated series of the last --validated-lookback years (revisions)")
    ap.add_argument("--offline", action="store_true", help="no network; rebuild outputs from cache/processed table")
    ap.add_argument("--dry-run", action="store_true", help="print the export URLs that would be requested")
    ap.add_argument("--settle-days", type=int, default=SETTLE_DAYS, help="days after which a chunk is final")
    ap.add_argument("--min-age-hours", type=float, default=MIN_AGE_H, help="min hours between downloads of a chunk")
    ap.add_argument("--validated-lookback", type=int, default=VALIDATED_LOOKBACK_Y,
                    help="years back to probe for newly published validated data")
    ap.add_argument("--cache-dir", default=str(CACHE_DIR))
    ap.add_argument("--out", default=str(OUT_CSV))
    ap.add_argument("--report", default=str(OUT_REPORT))
    ap.add_argument("--no-rehydrate", action="store_true", help="do not rebuild missing cache from the table")
    ap.add_argument("--allow-shrink", action="store_true", help="write even if a series loses valid hours")
    a = ap.parse_args(argv)
    start = dt.date.fromisoformat(a.start)
    end = dt.date.fromisoformat(a.end) if a.end else local_today()
    if end < start:
        ap.error("--end is before --start")
    stations = [s.strip() for s in a.stations.split(",") if s.strip()]
    for s in stations:
        if s not in STATIONS:
            ap.error(f"unknown station {s!r} (use z1, z4)")
    params = [p.strip() for p in a.params.split(",")] if a.params else None
    for p in params or []:
        if p not in PARAMS:
            ap.error(f"unknown param {p!r}; known: {', '.join(PARAMS)}")
    opts = Options(full=a.full, refresh_validated=a.refresh_validated, offline=a.offline, dry_run=a.dry_run,
                   settle_days=a.settle_days, min_age_h=a.min_age_hours, lookback_y=a.validated_lookback)
    return run(start, end, opts, stations=stations, params=params, cache_dir=Path(a.cache_dir),
               out_csv=Path(a.out), out_report=Path(a.report), allow_shrink=a.allow_shrink,
               rehydrate=not a.no_rehydrate)


if __name__ == "__main__":
    sys.exit(main())
