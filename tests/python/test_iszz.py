"""Unit tests of the measurement pipeline: tools/fetch_iszz.py, tools/fetch_meteo.py, tools/build_measurements.py.

    python3 -m unittest discover -s tests/python -p 'test_iszz.py' -v

No network. HTTP responses are either real responses saved verbatim in tests/python/fixtures/ (iszz_*.json,
meteo_*.json; their URLs are listed in fixtures/iszz_fixtures.json and in each meteo file's "_fixture" block or
docs/01-data-sources.md §7) or a fake server that behaves like the ISZZ export service (window, 1000-row cap).

What is covered (task list of the [meas-data] role):
  1. chunk planning and the 1000-row split           TestChunks, TestTruncation
  2. −999 masking and the validated/raw merge         TestMerge
  3. hour-ending and local time on CET/CEST days       TestTime
  4. vector-mean wind and the hour-ending IFS values   TestMeteo
  5. Int16 base64 round trip                           TestEncoding
  6. rose sector assignment and statistics             TestStats
  7. incremental fetch rules and rehydration           TestIncremental
"""
from __future__ import annotations

import base64
import contextlib
import datetime as dt
import gzip
import io
import json
import logging
import math
import shutil
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))

import build_measurements as bm  # noqa: E402
import fetch_iszz as fi  # noqa: E402
import fetch_meteo as fm  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures"
H = fi.HOUR_MS
UTC = dt.timezone.utc
_TOOLS_LOG = logging.getLogger("tools")
_LEVEL = _TOOLS_LOG.level


def setUpModule():
    _TOOLS_LOG.setLevel(logging.CRITICAL)   # the tools log every series; the tests assert on results instead


def tearDownModule():
    _TOOLS_LOG.setLevel(_LEVEL)


def fixture(name: str):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def ms(y, m, d, h=0) -> int:
    return int(dt.datetime(y, m, d, h, tzinfo=UTC).timestamp() * 1000)


# ------------------------------------------------------------------ a fake ISZZ export service
class FakeServer:
    """Serves /podatak/export/json like ISZZ: rows whose hour-ending stamp is in (midnight(D1), midnight(D2+1)],
    in time order, silently truncated to the first 1000 (iszz-api §3.2). Records every requested URL."""

    def __init__(self, rows: dict[tuple[int, int, int], list[tuple[int, float, str]]], cap: int = 1000):
        self.rows, self.cap, self.urls = rows, cap, []

    def __call__(self, url: str) -> tuple[int, bytes]:
        self.urls.append(url)
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
        d1 = dt.datetime.strptime(q["vrijemeOd"], "%d.%m.%Y").date()
        d2 = dt.datetime.strptime(q["vrijemeDo"], "%d.%m.%Y").date()
        lo, hi = fi.Chunk(0, 0, 0, d1, d2).window_ms()
        key = (int(q["postaja"]), int(q["polutant"]), int(q["tipPodatka"]))
        sel = [r for r in self.rows.get(key, []) if lo < r[0] <= hi][: self.cap]
        body = [{"vrijednost": v, "mjernaJedinica": u, "vrijeme": t} for t, v, u in sel]
        return 200, json.dumps(body).encode()


def quiet_client(opener) -> fi.IszzClient:
    return fi.IszzClient(opener=opener, sleep=lambda s: None, jitter=lambda: 0.0)


# ================================================================== 1. chunks
class TestChunks(unittest.TestCase):
    def test_months_clipped_and_contiguous(self):
        c = fi.plan_chunks(dt.date(2023, 1, 1), dt.date(2023, 3, 15))
        self.assertEqual(c, [(dt.date(2023, 1, 1), dt.date(2023, 1, 31)), (dt.date(2023, 2, 1), dt.date(2023, 2, 28)),
                             (dt.date(2023, 3, 1), dt.date(2023, 3, 15))])

    def test_never_longer_than_max_days(self):
        for max_days in (1, 7, 10, 30, 40):
            c = fi.plan_chunks(dt.date(2024, 1, 15), dt.date(2024, 12, 31), max_days)
            self.assertTrue(all((b - a).days + 1 <= max_days for a, b in c), max_days)
            self.assertEqual(c[0][0], dt.date(2024, 1, 15))
            self.assertEqual(c[-1][1], dt.date(2024, 12, 31))
            for (a1, b1), (a2, _b2) in zip(c, c[1:]):
                self.assertEqual(a2, b1 + dt.timedelta(days=1))

    def test_full_period_uses_month_keys_under_the_cap(self):
        c = fi.plan_chunks(dt.date(2023, 1, 1), dt.date(2026, 9, 27))
        self.assertEqual(len(c), 45)                       # 2023-01 .. 2026-09
        self.assertTrue(all((b - a).days + 1 <= fi.CHUNK_DAYS for a, b in c))
        self.assertTrue(all(fi.Chunk(155, 1, 0, a, b).expected_hours(dt.datetime(2030, 1, 1, tzinfo=UTC))
                            < fi.MAX_ROWS for a, b in c))

    def test_url_format(self):
        u = fi.Chunk(155, 38, 1, dt.date(2025, 3, 1), dt.date(2025, 3, 31)).url
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(u).query))
        self.assertEqual(q, {"postaja": "155", "polutant": "38", "tipPodatka": "1",
                             "vrijemeOd": "01.03.2025", "vrijemeDo": "31.03.2025"})
        self.assertTrue(u.startswith(fi.SITE["iszz"]["export"]))


class TestTruncation(unittest.TestCase):
    """The real service returns the first 1000 rows of a longer window with HTTP 200 and no warning."""

    def test_real_response_is_truncated(self):
        rows = fi.parse_export(fixture("iszz_155_477_t0_20250101_20250215.json"))
        self.assertEqual(len(rows), 1000)
        # the window asked for runs to 15.02 24:00, but the last row returned is in mid-February (iszz-api §3.2)
        self.assertLess(rows[-1][0], fi.Chunk(155, 477, 0, dt.date(2025, 1, 1), dt.date(2025, 2, 15)).window_ms()[1])

    def test_exactly_1000_rows_are_split(self):
        real = fi.parse_export(fixture("iszz_155_477_t0_20250101_20250215.json"))
        srv = FakeServer({(155, 477, 0): real})
        chunk = fi.Chunk(155, 477, 0, dt.date(2025, 1, 1), dt.date(2025, 2, 15))
        client = quiet_client(srv)
        got = fi.fetch_split(client, chunk)
        self.assertEqual([r[0] for r in got], [r[0] for r in real])   # nothing lost, nothing duplicated
        self.assertGreater(len(srv.urls), 1)
        self.assertEqual(client.stats["splits"], len(srv.urls) // 2)

    def test_split_recurses_until_below_cap(self):
        t0 = fi.local_midnight_utc(dt.date(2025, 1, 1))
        rows = [(int(t0.timestamp() * 1000) + (i + 1) * H, float(i), "m/s") for i in range(24 * 40)]
        srv = FakeServer({(155, 477, 0): rows}, cap=100)          # a stricter cap forces several levels
        got = fi.fetch_split(quiet_client(srv), fi.Chunk(155, 477, 0, dt.date(2025, 1, 1), dt.date(2025, 2, 9)), 100)
        self.assertEqual(len(got), len(rows))

    def test_single_day_at_cap_raises(self):
        t0 = int(fi.local_midnight_utc(dt.date(2025, 1, 1)).timestamp() * 1000)
        srv = FakeServer({(155, 1, 0): [(t0 + (i + 1) * H, 1.0, "") for i in range(24)]}, cap=10)
        with self.assertRaises(RuntimeError):
            fi.fetch_split(quiet_client(srv), fi.Chunk(155, 1, 0, dt.date(2025, 1, 1), dt.date(2025, 1, 1)), 10)

    def test_429_is_retried_with_pause(self):
        calls, sleeps = [], []

        def opener(url):
            calls.append(url)
            if len(calls) < 3:
                raise urllib.error.HTTPError(url, 429, "Too many requests", {}, None)
            return 200, b"[]"
        c = fi.IszzClient(opener=opener, sleep=sleeps.append, jitter=lambda: 0.5)
        self.assertEqual(c.get_json("https://x/"), [])
        self.assertEqual(len(calls), 3)
        self.assertEqual(c.stats["http_429"], 2)
        # two back-off pauses of SLEEP_429_S + jitter (1.5 s here); every other pause is the <= 1.1 s pacing
        self.assertEqual([s for s in sleeps if s > fi.PACE_S], [fi.SLEEP_429_S + 0.5] * 2)
        self.assertTrue(all(s <= fi.PACE_S for s in sleeps if s <= fi.PACE_S))

    def test_pacing_between_requests(self):
        clock = [0.0]
        sleeps = []

        def sleep(s):
            sleeps.append(s)
            clock[0] += s
        c = fi.IszzClient(opener=lambda u: (200, b"[]"), sleep=sleep, clock=lambda: clock[0])
        c.get_json("a")
        c.get_json("b")
        self.assertAlmostEqual(sum(sleeps), fi.PACE_S, places=6)

    def test_204_bad_parameters(self):
        f = fixture("iszz_fixtures.json")["iszz_bad_date_204"]
        c = quiet_client(lambda u: (f["status"], f["body"].encode()))
        with self.assertRaises(ValueError):
            c.get_json(f["url"])

    def test_old_documented_shape_is_accepted(self):
        # servis_uputa.pdf (iszz-api §2) documents [{"Podatak": {..., "vrijeme": ISO local}}]
        old = [{"Podatak": {"vrijednost": 12.5, "mjernaJedinica": "µg/m3", "vrijeme": "2016-08-10T01:00:00+02:00"}}]
        self.assertEqual(fi.parse_export(old), [(ms(2016, 8, 9, 23), 12.5, "µg/m3")])


# ================================================================== 2. masking and merge
class TestMerge(unittest.TestCase):
    def setUp(self):
        self.raw = fi.parse_export(fixture("iszz_155_1_t0_20250630_20250701.json"))
        self.val = fi.parse_export(fixture("iszz_155_1_t1_20250630_20250701.json"))
        self.chunk = lambda tip: fi.Chunk(155, 1, tip, dt.date(2025, 6, 30), dt.date(2025, 7, 1))
        self.now = dt.datetime(2026, 9, 27, tzinfo=UTC)

    def test_validated_has_a_row_per_hour_with_sentinels(self):
        self.assertEqual(len(self.val), 48)
        clean, n = fi.mask_sentinels(self.val)
        self.assertEqual(n, sum(1 for r in self.val if r[1] == -999))
        self.assertGreater(n, 0)
        self.assertTrue(all(r[1] > fi.SENTINEL_MAX for r in clean))

    def test_validated_preferred_and_sentinel_not_refilled_from_raw(self):
        raw = [fi.ChunkData(self.chunk(0), self.raw, self.now, "cache")]
        val = [fi.ChunkData(self.chunk(1), self.val, self.now, "cache")]
        out, info = fi.merge_series(raw, val)
        rejected = {r[0] for r in self.val if fi.is_sentinel(r[1])}
        raw_t = {r[0] for r in self.raw}
        self.assertTrue(rejected & raw_t, "fixture must contain hours the validator rejected but raw has")
        self.assertFalse(rejected & set(out), "a rejected hour came back from the raw series")
        self.assertTrue(all(f == 1 for _v, f in out.values()))
        vals = {r[0]: r[1] for r in self.val}
        self.assertTrue(all(out[t][0] == vals[t] for t in out))
        self.assertEqual(info[2025].source, "validated")
        self.assertEqual(info[2025].masked, len(rejected))
        self.assertEqual(info[2025].n, 48 - len(rejected))

    def test_raw_used_when_validated_missing(self):
        raw = [fi.ChunkData(self.chunk(0), self.raw, self.now, "cache")]
        out, info = fi.merge_series(raw, [])
        self.assertEqual(len(out), len(self.raw))
        self.assertTrue(all(f == 0 for _v, f in out.values()))
        self.assertEqual(info[2025].source, "raw")

    def test_stray_validated_value_does_not_win_the_year(self):
        # validated PM2.5 2024 at ZAGREB-1 has exactly one value (iszz-api §6.1): the year must stay raw
        raw = [fi.ChunkData(self.chunk(0), self.raw, self.now, "cache")]
        val = [fi.ChunkData(self.chunk(1), self.val[:1], self.now, "cache")]
        out, info = fi.merge_series(raw, val)
        self.assertEqual(info[2025].source, "raw")
        self.assertEqual(len(out), len(self.raw))

    def test_rehydrated_sentinels_count(self):
        clean, n = fi.mask_sentinels(self.val)
        val = [fi.ChunkData(self.chunk(1), clean, self.now, "processed", masked_extra=n)]
        out, info = fi.merge_series([], val)
        self.assertEqual(info[2025].masked, n)
        self.assertEqual(info[2025].source, "validated")

    def test_units_normalised(self):
        self.assertEqual({r[2] for r in self.raw}, {"µg/m3"})
        self.assertEqual(fi.norm_unit("µg/m3", "no2"), "µg/m³")
        self.assertEqual(fi.norm_unit("degrees Celzius", "t"), "°C")


# ================================================================== 3. time
class TestTime(unittest.TestCase):
    def test_offset_switch_instants(self):
        z = fi.zagreb_offset
        self.assertEqual(z(dt.datetime(2025, 3, 30, 0, 59, tzinfo=UTC)), dt.timedelta(hours=1))
        self.assertEqual(z(dt.datetime(2025, 3, 30, 1, 0, tzinfo=UTC)), dt.timedelta(hours=2))
        self.assertEqual(z(dt.datetime(2025, 10, 26, 0, 59, tzinfo=UTC)), dt.timedelta(hours=2))
        self.assertEqual(z(dt.datetime(2025, 10, 26, 1, 0, tzinfo=UTC)), dt.timedelta(hours=1))
        self.assertEqual(fi.last_sunday(2026, 3), dt.date(2026, 3, 29))
        self.assertEqual(fi.last_sunday(2026, 10), dt.date(2026, 10, 25))

    def test_matches_zoneinfo(self):
        try:
            from zoneinfo import ZoneInfo
            zi = ZoneInfo("Europe/Zagreb")
        except Exception:  # noqa: BLE001 - tzdata not installed
            self.skipTest("zoneinfo/tzdata not available")
        t = dt.datetime(2023, 1, 1, tzinfo=UTC)
        while t < dt.datetime(2027, 1, 1, tzinfo=UTC):
            self.assertEqual(fi.zagreb_offset(t), t.astimezone(zi).utcoffset(), t)
            t += dt.timedelta(minutes=30)

    def test_local_hour_starts_on_switch_days(self):
        def day_hours(day):
            lo, hi = fi.Chunk(0, 0, 0, day, day).window_ms()
            return [fi.hour_start_local(t).hour for t in range(lo + H, hi + 1, H)]
        self.assertEqual(day_hours(dt.date(2025, 3, 30)), [0, 1] + list(range(3, 24)))      # 23 h, no 02:00
        self.assertEqual(day_hours(dt.date(2025, 10, 26)), [0, 1, 2, 2] + list(range(3, 24)))  # 25 h, 02:00 twice
        self.assertEqual(day_hours(dt.date(2025, 7, 1)), list(range(24)))

    def test_expected_hours(self):
        now = dt.datetime(2030, 1, 1, tzinfo=UTC)
        self.assertEqual(fi.Chunk(0, 0, 0, dt.date(2025, 3, 30), dt.date(2025, 3, 30)).expected_hours(now), 23)
        self.assertEqual(fi.Chunk(0, 0, 0, dt.date(2025, 10, 26), dt.date(2025, 10, 26)).expected_hours(now), 25)
        self.assertEqual(fi.Chunk(0, 0, 0, dt.date(2025, 1, 1), dt.date(2025, 12, 31)).expected_hours(now), 8760)
        self.assertEqual(bm.hours_in_local_year(2024), 8784)

    def test_real_spring_response(self):
        """Real raw NO2 for 29.-31.03.2025: 30.03 has 23 local hours; ISZZ stamps are the END of each hour."""
        rows = fi.parse_export(fixture("iszz_155_1_t0_20250329_20250331.json"))
        first = rows[0][0]
        self.assertEqual(first, int(fi.local_midnight_utc(dt.date(2025, 3, 29)).timestamp() * 1000) + H)
        self.assertEqual(fi.to_local(first), dt.datetime(2025, 3, 29, 1))        # label "29.03. 01:00"
        self.assertEqual(fi.hour_start_local(first), dt.datetime(2025, 3, 29, 0))
        on30 = [fi.hour_start_local(t).hour for t, _v, _u in rows if fi.hour_start_local(t).date() == dt.date(2025, 3, 30)]
        self.assertNotIn(2, on30)
        self.assertLessEqual(len(on30), 23)
        self.assertEqual(len(set(on30)), len(on30))
        self.assertTrue(all(t % H == 0 for t, _v, _u in rows))

    def test_real_autumn_response(self):
        """Validated NO2 for 25.-27.10.2025: 72 rows for 73 real hours; one CEST hour is lost at source."""
        rows = fi.parse_export(fixture("iszz_155_1_t1_20251025_20251027.json"))
        self.assertEqual(len(rows), 72)
        on26 = [fi.hour_start_local(t).hour for t, _v, _u in rows if fi.hour_start_local(t).date() == dt.date(2025, 10, 26)]
        # iszz-api §4.4: 24 values for the 25-hour day. "01:00+02" is followed by "02:00+01": the instant 00:00Z (the
        # hour 01:00-02:00 CEST, hour-start 01) is lost at source, and both 02:00 hour-starts (CEST, CET) are present.
        self.assertEqual(on26, [0, 2, 2] + list(range(3, 24)))
        self.assertNotIn(ms(2025, 10, 26, 0), {t for t, _v, _u in rows})
        self.assertIn(ms(2025, 10, 26, 1), {t for t, _v, _u in rows})

    def test_year_of_the_24h_slot(self):
        t = int(fi.local_midnight_utc(dt.date(2026, 1, 1)).timestamp() * 1000)   # label "31.12.2025 24:00"
        self.assertEqual(fi.local_year(t), 2025)
        self.assertEqual(fi.local_year(t + H), 2026)

    def test_iso_round_trip(self):
        t = ms(2025, 6, 30, 22)
        self.assertEqual(fi.parse_iso_ms(fi.iso_z(t)), t)
        self.assertEqual(fi.parse_iso_ms("2026-09-26T20:00:00+02:00"), ms(2026, 9, 26, 18))


# ================================================================== 4. meteorology
class TestMeteo(unittest.TestCase):
    def test_vector_mean_across_north(self):
        s, d = fm.vector_mean_wind([(1.0, 350.0), (1.0, 10.0)])
        self.assertAlmostEqual(d % 360, 0.0, places=6)
        self.assertAlmostEqual(s, math.cos(math.radians(10)), places=9)

    def test_vector_mean_simple_and_opposite(self):
        s, d = fm.vector_mean_wind([(2.0, 90.0), (4.0, 90.0)])
        self.assertAlmostEqual(s, 3.0)
        self.assertAlmostEqual(d, 90.0)
        s, d = fm.vector_mean_wind([(1.0, 0.0), (1.0, 180.0)])
        self.assertAlmostEqual(s, 0.0)
        self.assertTrue(math.isnan(d))
        s, d = fm.vector_mean_wind([(3.0, 270.0), (1.0, 180.0)])   # W and S -> between, closer to W
        self.assertTrue(225 < d < 270, d)

    def test_hour_ending_on_real_archive(self):
        resp = fixture("meteo_archive_ifs_20250329_31.json")
        self.assertEqual((resp["latitude"], resp["longitude"]), (45.79965, 15.924171))   # critic §1.1 IFS cell
        inst = fm.instantaneous(resp)
        he = fm.hour_ending(inst)
        times = sorted(inst)
        self.assertNotIn(times[0], he)                    # the first stamp has no t-1 h sample
        self.assertEqual(len(he), len(times) - 1)
        h = resp["hourly"]
        for i in (1, 20, 50, 71):
            t = times[i]
            row = he[t]
            self.assertAlmostEqual(row["t2"], 0.5 * (h["temperature_2m"][i - 1] + h["temperature_2m"][i]))
            self.assertAlmostEqual(row["cc"], 0.5 * (h["cloud_cover"][i - 1] + h["cloud_cover"][i]))
            self.assertAlmostEqual(row["sw"], h["shortwave_radiation"][i])          # already a preceding-hour mean
            s, d = fm.vector_mean_wind([(h["wind_speed_10m"][i - 1], h["wind_direction_10m"][i - 1]),
                                        (h["wind_speed_10m"][i], h["wind_direction_10m"][i])])
            self.assertAlmostEqual(row["u10"], s)
            self.assertAlmostEqual(row["wd10"], d)

    def test_missing_sample_gives_missing(self):
        inst = {0: {"temperature_2m": None, "wind_speed_10m": 1.0, "wind_direction_10m": 90.0},
                H: {"temperature_2m": 10.0, "wind_speed_10m": None, "wind_direction_10m": 90.0}}
        he = fm.hour_ending(inst)
        self.assertIsNone(he[H]["t2"])
        self.assertIsNone(he[H]["u10"])

    def test_forecast_fixture_window(self):
        resp = fixture("meteo_forecast_ifs.json")
        he = fm.hour_ending(fm.instantaneous(resp))
        ts = sorted(he)
        self.assertEqual(len(ts), (fm.PAST_DAYS + fm.FORECAST_DAYS) * 24 - 1)
        self.assertTrue(all(b - a == H for a, b in zip(ts, ts[1:])))
        self.assertIn("boundary_layer_height", resp["hourly"])
        fm.check_units(resp)

    def test_cams_fixture_hour_ending(self):
        """CAMS values are instantaneous (Open-Meteo docs): hour-ending = mean of t−1 h and t, as for the weather."""
        resp = fixture("meteo_cams_europe.json")
        sem = {v: (c, "instant") for v, c in fm.CAMS_COLUMNS.items()}
        he = fm.hour_ending(fm.instantaneous(resp), sem)
        self.assertEqual(len(he), (fm.CAMS_PAST_DAYS + fm.FORECAST_DAYS) * 24 - 1)
        h = resp["hourly"]
        t = sorted(fm.instantaneous(resp))[30]
        i = 30
        for var, col in fm.CAMS_COLUMNS.items():
            a, b = h[var][i - 1], h[var][i]
            if a is not None and b is not None:
                self.assertAlmostEqual(he[t][col], 0.5 * (a + b))

    def test_year_chunks(self):
        c = fm.year_chunks(dt.date(2023, 1, 1), dt.date(2026, 9, 27))
        self.assertEqual(c[0], (dt.date(2022, 12, 31), dt.date(2023, 12, 31)))
        self.assertEqual(c[-1], (dt.date(2026, 1, 1), dt.date(2026, 9, 27)))
        self.assertEqual(len(c), 4)

    def test_urls_use_ecmwf_ifs(self):
        for u in (fm.archive_url(dt.date(2025, 1, 1), dt.date(2025, 1, 2)), fm.forecast_url()):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(u).query))
            self.assertEqual(q["models"], "ecmwf_ifs")
            self.assertEqual(q["timezone"], "GMT")
            self.assertEqual(q["wind_speed_unit"], "ms")
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(fm.forecast_url()).query))
        self.assertEqual((q["past_days"], q["forecast_days"]), ("2", "3"))


# ================================================================== 5. encoding
class TestEncoding(unittest.TestCase):
    def test_round_trip(self):
        vals = [0.0, 12.34, -3.2, None, float("nan"), 3276.7, 1e9, -1e9]
        b64, clipped = bm.encode_int16(vals, 0.1)
        back = bm.decode_int16(b64, 0.1)
        self.assertEqual(clipped, 2)
        self.assertAlmostEqual(back[1], 12.3, places=9)
        self.assertAlmostEqual(back[2], -3.2, places=9)
        self.assertIsNone(back[3])
        self.assertIsNone(back[4])
        self.assertAlmostEqual(back[5], 3276.7, places=6)
        self.assertAlmostEqual(back[6], 3276.7, places=6)        # clipped to +32767, never onto the sentinel
        self.assertAlmostEqual(back[7], -3276.7, places=6)
        for v, b in zip(vals, back):
            if v is not None and not math.isnan(v) and abs(v) < 3276:
                self.assertLessEqual(abs(v - b), 0.05 + 1e-9)

    def test_little_endian_and_missing_code(self):
        self.assertEqual(bm.encode_int16([1], 1.0)[0], base64.b64encode(b"\x01\x00").decode())
        self.assertEqual(bm.encode_int16([None], 1.0)[0], base64.b64encode(b"\x00\x80").decode())   # −32768
        self.assertEqual(bm.encode_int16([-1], 1.0)[0], base64.b64encode(b"\xff\xff").decode())

    def test_every_key_has_a_scale_with_headroom(self):
        for k in bm.KEYS:
            s = bm.scale_of(k)
            self.assertGreater(s, 0)
        self.assertGreaterEqual(bm.INT16_MAX * bm.scale_of("z1.nox"), 3000)   # µg/m³
        self.assertGreaterEqual(bm.INT16_MAX * bm.scale_of("z1.co"), 30)      # mg/m³
        self.assertEqual(bm.decimals_of("z1.co"), 3)
        self.assertEqual(bm.decimals_of("z1.no2"), 1)
        self.assertEqual(bm.decimals_of("ifs.blh"), 0)


# ================================================================== 6. statistics
class TestStats(unittest.TestCase):
    def test_sector_boundaries(self):
        cases = {0: 0, 11.24: 0, 11.25: 1, 22.5: 1, 33.74: 1, 33.75: 2, 90: 4, 180: 8, 270: 12,
                 348.74: 15, 348.75: 0, 359.99: 0, 360: 0, -5: 0, 725: 0}
        for d, k in cases.items():
            self.assertEqual(bm.sector_of(d), k, d)

    def _year(self, year, frac, value=10.0):
        """Hourly series over a local year with the first `frac` of hours present."""
        lo = int(fi.local_midnight_utc(dt.date(year, 1, 1)).timestamp() * 1000)
        n = bm.hours_in_local_year(year)
        return {lo + (i + 1) * H: value for i in range(int(frac * n))}

    def test_annual_coverage_rule(self):
        cal = bm.Calendar()
        s = {**self._year(2023, 0.80, 10.0), **self._year(2024, 0.70, 20.0), **self._year(2025, 1.0, 30.0)}
        means, cover = bm.annual_stats(s, cal, last_full_year=2024, nd=1)
        self.assertEqual(means, {"2023": 10.0})                       # 2024 < 75 %; 2025 not a full year yet
        self.assertEqual(cover["2024"], 70.0)
        self.assertEqual(cover["2025"], 100.0)

    def test_diurnal_by_local_hour_start_and_day_type(self):
        cal = bm.Calendar()
        # Friday 2025-07-04 .. Sunday 2025-07-06; value = local hour-start + 100 * day index
        s = {}
        for day, base in ((dt.date(2025, 7, 4), 0), (dt.date(2025, 7, 5), 100), (dt.date(2025, 7, 6), 200)):
            lo, hi = fi.Chunk(0, 0, 0, day, day).window_ms()
            for t in range(lo + H, hi + 1, H):
                s[t] = base + fi.hour_start_local(t).hour
        d = bm.diurnal_stats(s, cal, 1)
        self.assertEqual(d["weekday"], [float(h) for h in range(24)])
        self.assertEqual(d["saturday"], [100.0 + h for h in range(24)])
        self.assertEqual(d["sunday"], [200.0 + h for h in range(24)])
        self.assertEqual(bm.monthly_stats(s, cal, 1)[6], round(sum(s.values()) / len(s), 1))
        self.assertIsNone(bm.monthly_stats(s, cal, 1)[0])

    def test_rose_with_calms(self):
        t = [ms(2025, 5, 1, h) for h in range(6)]
        conc = dict(zip(t, [10, 20, 30, 40, 50, 60]))
        wd = dict(zip(t, [0, 5, 90, 180, 350, 10]))
        u = dict(zip(t, [2.0, 2.0, 3.0, 0.2, 1.0, 0.49]))
        r = bm.rose_stats(conc, wd, u, 1)
        self.assertEqual(r["n"][0], 3)                        # 0°, 5°, 350° with U >= 0.5
        self.assertEqual(r["mean"][0], round((10 + 20 + 50) / 3, 1))
        self.assertEqual(r["n"][4], 1)
        self.assertEqual(r["calm"], {"mean": 50.0, "n": 2})   # 0.2 and 0.49 m/s
        self.assertIsNone(r["mean"][8])
        self.assertEqual(sum(r["n"]) + r["calm"]["n"], 6)

    def test_exceedances_and_daily_validity(self):
        cal = bm.Calendar()
        pm10, no2 = {}, {}
        # 2025-01-10: 18 valid hours at 60 -> valid day above 50 and 45
        lo, _ = fi.Chunk(0, 0, 0, dt.date(2025, 1, 10), dt.date(2025, 1, 10)).window_ms()
        for i in range(18):
            pm10[lo + (i + 1) * H] = 60.0
        # 2025-01-11: 17 hours at 100 -> not a valid day (AAQD Annex V C: >= 18 hours)
        lo, _ = fi.Chunk(0, 0, 0, dt.date(2025, 1, 11), dt.date(2025, 1, 11)).window_ms()
        for i in range(17):
            pm10[lo + (i + 1) * H] = 100.0
        # 2025-01-12: 24 hours at 47 -> above 45 only
        lo, _ = fi.Chunk(0, 0, 0, dt.date(2025, 1, 12), dt.date(2025, 1, 12)).window_ms()
        for i in range(24):
            pm10[lo + (i + 1) * H] = 47.0
        no2 = {ms(2025, 2, 1, 8): 200.0, ms(2025, 2, 1, 9): 200.1, ms(2026, 2, 1, 9): 250.0}
        counts, valid = bm.exceedance_stats({"pm10": pm10, "no2": no2}, cal)
        self.assertEqual(counts["pm10_24h_50"], {"2025": 1})
        self.assertEqual(counts["pm10_24h_45"], {"2025": 2})
        self.assertEqual(valid["pm10_24h"], {"2025": 2})
        self.assertEqual(counts["no2_1h_200"], {"2025": 1, "2026": 1})   # strictly above the limit
        self.assertEqual(valid["no2_1h"], {"2025": 2, "2026": 1})

    def test_gravimetric_daily_stamps_and_counts(self):
        """Daily types are stamped 00:00 local at the START of the day (iszz-api §4.5): real January 2025."""
        recs = fi.parse_export(fixture("iszz_155_5_t17_20250101_20250131.json"))
        rows = fi.daily_rows(recs, 155, "pm10", 1)
        self.assertEqual(len(rows), 31)
        self.assertEqual([r[0] for r in rows], [dt.date(2025, 1, d) for d in range(1, 32)])
        self.assertEqual(fi.to_local(recs[0][0]), dt.datetime(2025, 1, 1, 0, 0))
        counts, valid = bm.reference_exceedances(rows)
        self.assertEqual(counts["pm10_24h_50_ref"], {"2025": sum(1 for r in rows if r[3] > 50)})
        self.assertEqual(valid["pm10_24h_ref"], {"2025": 31})

    def test_reference_prefers_validated_then_raw(self):
        day = lambda d: int(fi.local_midnight_utc(d).timestamp() * 1000)   # noqa: E731 - start-of-day stamps
        srv = FakeServer({(155, 5, 17): [(day(dt.date(2025, 3, 1)), 40.0, "µg/m3")],
                          (155, 5, 16): [(day(dt.date(2025, 3, 1)), 99.0, "µg/m3"),
                                         (day(dt.date(2026, 3, 1)), 55.0, "µg/m3")]})
        srv_window = srv.__call__

        def opener(url):   # daily stamps sit ON local midnight: widen the fake window by one hour
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
            d1 = dt.datetime.strptime(q["vrijemeOd"], "%d.%m.%Y").date()
            q["vrijemeOd"] = (d1 - dt.timedelta(days=1)).strftime("%d.%m.%Y")
            return srv_window(url.split("?")[0] + "?" + urllib.parse.urlencode(q))
        rows = fi.fetch_reference_daily(quiet_client(opener), dt.date(2025, 1, 1), dt.date(2026, 9, 27), fi.Options(),
                                        None, {(155, "pm10")}, [], [])
        self.assertEqual(rows, [(dt.date(2025, 3, 1), 155, "pm10", 40.0, 1), (dt.date(2026, 3, 1), 155, "pm10", 55.0, 0)])
        self.assertIsNone(fi.fetch_reference_daily(quiet_client(opener), dt.date(2025, 1, 1), dt.date(2025, 2, 1),
                                                   fi.Options(), None, {(155, "no2")}, [], []))

    def test_paired_increment(self):
        a = {1: 10.0, 2: 20.0, 3: 5.0}
        b = {2: 4.0, 3: 7.0, 4: 1.0}
        self.assertEqual(bm.paired_increment(a, b), {2: 16.0, 3: -2.0})

    def test_build_on_tiny_fixture(self):
        """End-to-end build() on a two-week synthetic set: schema, decoding and the increment."""
        t_end = ms(2026, 9, 27, 18)
        n = 24 * 14
        ts = [t_end - i * H for i in range(n)][::-1]
        data = {k: {} for k in bm.KEYS}
        for i, t in enumerate(ts):
            data["z1.nox"][t] = 80.0 + (i % 24)
            data["z4.nox"][t] = 30.0
            data["z1.no2"][t] = 35.0
            data["ifs.u10"][t] = 2.0
            data["ifs.wd10"][t] = 45.0
            if i % 5:
                data["z4.no2"][t] = 20.0
        for p in bm.INC_PARAMS:
            data[f"inc.{p}"] = bm.paired_increment(data.get(f"z1.{p}", {}), data.get(f"z4.{p}", {}))
        m = bm.build(data, {"z1.nox": ts[100]}, 7, dt.date(2026, 9, 1), {})
        self.assertEqual(set(m), {"meta", "series", "scale", "keys", "stats", "latest"})
        self.assertEqual(m["keys"], bm.KEYS)
        self.assertEqual(m["meta"]["n"], 7 * 24)
        self.assertEqual(m["meta"]["t0"], t_end - (7 * 24 - 1) * H)
        for k in ("annual", "diurnal", "monthly", "rose", "exceed", "coverage", "increment", "period"):
            self.assertIn(k, m["stats"])
        back = bm.decode_int16(m["series"]["z1.nox"], m["scale"]["z1.nox"])
        self.assertEqual(len(back), 7 * 24)
        self.assertAlmostEqual(back[-1], data["z1.nox"][t_end], places=6)
        self.assertIsNone(bm.decode_int16(m["series"]["z1.so2"], m["scale"]["z1.so2"])[0])
        self.assertEqual(m["latest"]["z1.nox"], {"t": t_end, "v": data["z1.nox"][t_end]})
        r = m["stats"]["rose"]["inc.nox"]
        self.assertEqual(r["n"][2], n)                                         # 45° = NE sector
        self.assertAlmostEqual(r["mean"][2], round(sum(data["inc.nox"].values()) / n, 1))
        self.assertEqual(m["stats"]["increment_year"], None)                  # no full year in two weeks
        self.assertEqual(m["stats"]["period"], ["2026-09-01", "2026-09-27"])


# ================================================================== 7. incremental fetching
class TestIncremental(unittest.TestCase):
    """The fetch rules of tools/fetch_iszz.py with a fake server and a temporary cache."""

    NOW = dt.datetime(2026, 9, 27, 20, 0, tzinfo=UTC)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="z1test_"))
        self.cache = self.tmp / "cache"
        self.cache.mkdir()
        # capabilities as /frm/gg reports them for ZAGREB-1 NO2 (fixtures/iszz_fixtures.json)
        (self.cache / "frm_gg.json").write_text(json.dumps(fixture("iszz_fixtures.json")["frm_gg_subset"]))
        # 2025 raw + validated (a row per hour, some −999); 2026 raw only
        lo = int(fi.local_midnight_utc(dt.date(2025, 1, 1)).timestamp() * 1000)
        hi = int(self.NOW.timestamp() * 1000) // H * H - 2 * H
        raw, val = [], []
        end25 = int(fi.local_midnight_utc(dt.date(2026, 1, 1)).timestamp() * 1000)
        for i, t in enumerate(range(lo + H, hi + 1, H)):
            raw.append((t, round(20 + (i % 17) * 1.5, 1), "µg/m3"))
            if t <= end25:
                val.append((t, -999.0 if i % 50 == 0 else round(21 + (i % 17) * 1.5, 3), "µg/m3"))
        self.srv = FakeServer({(155, 1, 0): raw, (155, 1, 1): val})
        self.raw, self.val = raw, val

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_fetch(self, now, **kw):
        self.srv.urls.clear()
        with contextlib.redirect_stdout(io.StringIO()):   # run() prints its completeness table
            return fi.run(dt.date(2025, 1, 1), fi.local_today(now), fi.Options(**kw), stations=("z1",),
                          params=["no2"], cache_dir=self.cache, out_csv=self.tmp / "t.csv.gz",
                          out_report=self.tmp / "r.json", client=quiet_client(self.srv), now=now)

    def table(self):
        return fi.read_processed(self.tmp / "t.csv.gz")[(155, "no2")]

    def test_first_run_then_incremental(self):
        self.assertEqual(self.run_fetch(self.NOW), 0)
        n_raw = len(fi.plan_chunks(dt.date(2025, 1, 1), dt.date(2026, 9, 27)))
        urls = self.srv.urls
        self.assertEqual(sum("tipPodatka=0" in u for u in urls), n_raw)
        self.assertEqual(sum("tipPodatka=1" in u for u in urls), 12)          # 2025 only: 2026 is never requested
        rows = self.table()
        by_year = {}
        for t, _v, f in rows:
            by_year.setdefault(fi.local_year(t), set()).add(f)
        self.assertEqual(by_year, {2025: {1}, 2026: {0}})
        self.assertFalse(any(v == -999.0 for _t, v, _f in rows))
        report = json.loads((self.tmp / "r.json").read_text())
        y25 = report["stations"]["155"]["params"]["no2"]["years"]["2025"]
        self.assertEqual(y25["source"], "validated")
        self.assertEqual(y25["masked"], sum(1 for r in self.val if r[1] == -999.0))
        # a week later: only chunks that were not final get downloaded (Jul-Sep 2026 + the new days)
        later = self.NOW + dt.timedelta(days=7)
        self.assertEqual(self.run_fetch(later), 0)
        months = sorted({dict(urllib.parse.parse_qsl(urllib.parse.urlparse(u).query))["vrijemeOd"] for u in self.srv.urls})
        self.assertEqual(months, ["01.07.2026", "01.08.2026", "01.09.2026", "01.10.2026"])
        self.assertTrue(all("tipPodatka=0" in u for u in self.srv.urls))

    def test_rerun_within_min_age_makes_no_request(self):
        self.run_fetch(self.NOW)
        self.run_fetch(self.NOW + dt.timedelta(hours=1))
        self.assertEqual(self.srv.urls, [])

    def test_rehydration_from_processed_table(self):
        """A fresh checkout (no cache) downloads only what is not final, and writes the same table."""
        self.run_fetch(self.NOW)
        before = gzip.decompress((self.tmp / "t.csv.gz").read_bytes())
        shutil.rmtree(self.cache / "155")
        self.run_fetch(self.NOW + dt.timedelta(days=1))
        self.assertTrue(all("tipPodatka=0" in u for u in self.srv.urls))
        self.assertEqual(len(self.srv.urls), 3)                               # Jul, Aug, Sep 2026
        after = gzip.decompress((self.tmp / "t.csv.gz").read_bytes())
        self.assertEqual(after, before)

    def test_unpublished_validated_year_costs_one_probe(self):
        self.srv.rows[(155, 1, 1)] = []                                       # validated 2025 not published yet
        self.run_fetch(self.NOW)
        self.assertEqual(sum("tipPodatka=1" in u for u in self.srv.urls), 1)
        self.assertIn("vrijemeOd=01.12.2025", [u for u in self.srv.urls if "tipPodatka=1" in u][0])
        # published later: the probe sees it and the whole year is downloaded
        self.srv.rows[(155, 1, 1)] = self.val
        self.run_fetch(self.NOW + dt.timedelta(days=7))
        self.assertEqual(sum("tipPodatka=1" in u for u in self.srv.urls), 12)
        by_year = {fi.local_year(t): f for t, _v, f in self.table()}
        self.assertEqual(by_year[2025], 1)

    def test_shrink_guard(self):
        self.run_fetch(self.NOW)
        self.srv.rows[(155, 1, 0)] = [r for r in self.raw if fi.local_year(r[0]) != 2026 or r[0] % (2 * H)]
        rc = self.run_fetch(self.NOW + dt.timedelta(days=7), full=True)
        self.assertEqual(rc, 3)                                               # refused: 2026 raw lost hours

    def test_stale_sibling_removed(self):
        self.run_fetch(self.NOW)
        self.run_fetch(self.NOW + dt.timedelta(days=2))
        sep = sorted(p.name for p in (self.cache / "155").glob("p1_t0_20260901_*.json"))
        self.assertEqual(sep, ["p1_t0_20260901_20260929.json"])


if __name__ == "__main__":
    unittest.main()
