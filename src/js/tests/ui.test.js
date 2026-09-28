// ------------------------------------------------------------------ tests: ui (data.js, charts.js, main.js)
/*
 * Run: python3 tests/browser/run_selftest.py --only ui.
 * Every test here is pure (no network, no WebGL): synthetic inputs, detached DOM elements and a mocked fetch.
 */

// ---------------------------------------------------------------- data.js
test('ui.hist decodes a synthetic Int16 series', () => {
  // five hours: 10.0, missing, 25.0, -0.5, 3276.7 at scale 0.1 (architecture §4.2: -32768 = missing)
  const q = [100, -32768, 250, -5, 32767];
  const bytes = new Uint8Array(q.length * 2);
  const dv = new DataView(bytes.buffer);
  q.forEach((v, i) => dv.setInt16(i * 2, v, true));
  const b64 = btoa(String.fromCharCode(...bytes));
  const t0 = Date.UTC(2026, 0, 1, 1);
  const h = Hist.create({ meta: { t0, n: 5 }, series: { 'z1.no2': b64 }, scale: { 'z1.no2': 0.1 }, keys: ['z1.no2'], stats: { period: ['a', 'b'] }, latest: {} });
  assert(h.ok, 'store ok');
  const s = h.series('z1.no2');
  assert(s instanceof Float32Array && s.length === 5, 'Float32Array(n)');
  assertClose(s[0], 10, 1e-6, 's[0]');
  assert(Number.isNaN(s[1]), 'missing → NaN');
  assertClose(s[2], 25, 1e-6, 's[2]');
  assertClose(s[3], -0.5, 1e-6, 's[3]');
  assertClose(s[4], 3276.7, 1e-3, 's[4]');
  assert(h.series('z1.no2') === s, 'cached');
  assert(h.timeAt(2) === t0 + 2 * 3600e3, 'timeAt');
  assert(h.indexAt(t0 + 3 * 3600e3) === 3 && h.indexAt(t0 - 3600e3) === -1 && h.indexAt(t0 + 5 * 3600e3) === -1, 'indexAt');
  assert(h.indexAt(t0 + 3 * 3600e3 + 1000) === 3, 'indexAt rounds to the hour');
  assertClose(h.value('z1.no2', t0 + 2 * 3600e3), 25, 1e-6, 'value');
  const w = h.window('z1.no2', t0, t0 + 2 * 3600e3);
  assert(w.length === 2 && w[1].v === s[2], 'window skips missing');
  const u = h.series('nope');
  assert(u.length === 5 && u.every(Number.isNaN), 'unknown key → all NaN');
  const empty = Hist.create(null);
  assert(!empty.ok && empty.n === 0 && empty.series('z1.no2').length === 0 && empty.indexAt(t0) === -1, 'no archive');
  return { decoded: Array.from(s) };
});

test('ui.zgtime: DST offsets and hour-ending conventions', () => {
  // EU rule (Directive 2000/84/EC): 2026 summer time 29 Mar 01:00Z – 25 Oct 01:00Z
  assert(ZgTime.offset(Date.UTC(2026, 0, 15)) === 1, 'January CET');
  assert(ZgTime.offset(Date.UTC(2026, 6, 15)) === 2, 'July CEST');
  assert(ZgTime.offset(Date.UTC(2026, 2, 29, 0, 59)) === 1 && ZgTime.offset(Date.UTC(2026, 2, 29, 1, 0)) === 2, 'spring switch at 01:00Z');
  assert(ZgTime.offset(Date.UTC(2026, 9, 25, 0, 59)) === 2 && ZgTime.offset(Date.UTC(2026, 9, 25, 1, 0)) === 1, 'autumn switch at 01:00Z');
  // "24:00" of 27 Sep 2026 local = 22:00Z (iszz-api §4.3)
  assert(ZgTime.toUTC(2026, 9, 27, 24) === Date.UTC(2026, 8, 27, 22), 'toUTC 24:00');
  assert(ZgTime.toUTC(2026, 1, 13, 8) === Date.UTC(2026, 0, 13, 7), 'toUTC winter');
  // benzene sample of iszz-api §4.1: 1790445600000 = 26.09.2026 20:00 CEST, the hour 19–20 h
  const hs = ZgTime.hourStart(1790445600000);
  assert(hs.d === 26 && hs.h === 19, `hour start ${hs.d} ${hs.h}`);
  assert(localHour(1790445600000) === 20, 'localHour');
  assert(ZgTime.dayType(ZgTime.toUTC(2026, 9, 27, 12)) === 'sunday', '27.9.2026 is a Sunday');
  return { ok: true };
});

test('ui.zgtime: day type follows the hour START', () => {
  // the hour ending Monday 00:00 (Sunday 24:00) belongs to Sunday; the one ending Monday 01:00 to Monday
  assert(ZgTime.dayType(ZgTime.toUTC(2026, 9, 28, 0)) === 'sunday', 'Sunday 24:00');
  assert(ZgTime.dayType(ZgTime.toUTC(2026, 9, 28, 2)) === 'weekday', 'Monday 01–02 h');
  assert(fmtLocal(ZgTime.toUTC(2026, 9, 28, 0), { ending: true, date: false }) === '24:00', 'ending label 24:00');
});

test('ui.live parsers: ISZZ rows, IFS hour-ending means, CAMS', () => {
  const rows = Live._parseIszz([
    { vrijednost: 48.1, mjernaJedinica: 'µg/m3', vrijeme: 1789858800000 },
    { vrijednost: -999, vrijeme: 1789862400000 },                                     // validated sentinel
    { Podatak: { vrijednost: '12,5', vrijeme: '2026-09-26T01:00:00+02:00' } },       // outdated PDF shape
  ]);
  assert(rows.length === 2, 'sentinel dropped');
  assert(rows[0].t === Date.parse('2026-09-26T01:00:00+02:00') || rows[1].t === Date.parse('2026-09-26T01:00:00+02:00'), 'ISO time parsed');
  assert(rows.some((r) => Math.abs(r.v - 12.5) < 1e-9), 'decimal comma');
  const fc = Live._parseForecast({ hourly: {
    time: ['2026-09-27T00:00', '2026-09-27T01:00', '2026-09-27T02:00'],
    wind_speed_10m: [2, 2, 4], wind_direction_10m: [350, 10, 90], boundary_layer_height: [100, 300, null],
    temperature_2m: [10, 12, 14], cloud_cover: [0, 100, 50], shortwave_radiation: [0, 5, 80],
  } });
  assert(fc.length === 2, 'n − 1 hour-ending rows');
  assert(fc[0].t === Date.UTC(2026, 8, 27, 1), 'hour-ending stamp = the later instant');
  assert(Math.abs(angDiff(fc[0].wd, 0)) < 1e-6, `vector mean of 350° and 10° is 0°, got ${fc[0].wd}`);
  assertClose(fc[0].u10, 2 * Math.cos(10 * DEG), 1e-6, 'vector-mean speed');
  assertClose(fc[0].blh, 200, 1e-9, 'BLH mean');
  assertClose(fc[0].t2, 11, 1e-9, 'T mean');
  assertClose(fc[0].cc, 50, 1e-9, 'cloud mean');
  assert(fc[0].sw === 5, 'radiation is already a preceding-hour mean');
  assert(Number.isNaN(fc[1].blh), 'missing BLH stays NaN');
  const cams = Live._parseCams({ hourly: { time: ['2026-09-27T00:00', '2026-09-27T01:00'], nitrogen_dioxide: [8, 10], ozone: [60, 62], pm10: [20, 22], pm2_5: [10, 12] } });
  assert(cams.length === 1 && cams[0].no2 === 9 && cams[0].pm25 === 11, 'CAMS t−1/t mean');
});

test('ui.live bias ratios (physics §11.4)', () => {
  const t0 = Date.UTC(2026, 8, 13);
  const camsRows = [], z4 = { no2: [], o3: [], pm10: [], pm25: [], nox: [] };
  for (let i = 0; i < 60; i++) {
    const tt = t0 + i * 3600e3;
    camsRows.push({ t: tt, no2: 10, o3: 50, pm10: 20, pm25: 10 });
    z4.no2.push({ t: tt, v: 18 }); z4.nox.push({ t: tt, v: 27 }); z4.o3.push({ t: tt, v: 45 }); z4.pm10.push({ t: tt, v: 24 });
  }
  for (let i = 0; i < 10; i++) z4.pm25.push({ t: t0 + i * 3600e3, v: 9 });   // too few pairs → the 2025 ratio
  const r = Live.biasRatios(camsRows, z4);
  assertClose(r.no2, 1.8, 1e-9, 'NO2 ratio');
  assertClose(r.o3, 0.9, 1e-9, 'O3 ratio');
  assertClose(r.pm10, 1.2, 1e-9, 'PM10 ratio');
  assert(r.source.pm25 === 'default' && Math.abs(r.pm25 - 0.85) < 1e-9, 'PM2.5 falls back to 2025 (critic D9)');
  assertClose(r.nox_no2, 1.5, 1e-9, 'NOx/NO2');
  const none = Live.biasRatios(null, null);
  assert(none.source.no2 === 'default' && none.no2 === 1.77, 'no data → 2025 ratios');
});

test('ui.live iszz: window, 429 back-off, pacing, cache', async () => {
  const calls = [];
  let refused = false;
  Live._setFetch(async (url) => {
    calls.push({ url, at: performance.now() });
    if (!refused) { refused = true; return { status: 429, ok: false, json: async () => null }; }
    return { status: 200, ok: true, json: async () => [{ vrijednost: 30, vrijeme: Date.UTC(2026, 8, 26, 0) }, { vrijednost: 31, vrijeme: Date.UTC(2026, 8, 26, 1) }] };
  });
  try {
    // hours ending 26.9. 02:00 … 03:00 local = 00:00Z … 01:00Z: the export days are both 26.09.2026
    const rows = await Live.iszz(155, 'no2', Date.UTC(2026, 8, 26, 0), Date.UTC(2026, 8, 26, 1), 0);
    assert(rows.length === 2 && rows[0].v === 30, 'rows parsed');
    assert(calls.length === 2, `one refusal + one success, got ${calls.length}`);
    assert(/postaja=155&polutant=1&tipPodatka=0&vrijemeOd=26\.09\.2026&vrijemeDo=26\.09\.2026/.test(calls[1].url), calls[1].url);
    assert(calls[1].at - calls[0].at >= 1000, 'retry waited ≥ 1 s');
    const again = await Live.iszz(155, 'no2', Date.UTC(2026, 8, 26, 0), Date.UTC(2026, 8, 26, 1), 0);
    assert(calls.length === 2 && again.length === 2, 'served from the cache');
    await Live.iszz(303, 'o3', Date.UTC(2026, 8, 26, 0), Date.UTC(2026, 8, 26, 1), 0);
    assert(calls.length === 3 && calls[2].at - calls[1].at >= SITE.iszz.pace_s * 1000 - 20, 'requests paced ≥ 1.1 s');
  } finally {
    Live._setFetch((...a) => fetch(...a));
  }
  return { calls: calls.length };
});

test('ui.live iszz: a refusal without CORS headers (TypeError) is retried like a 429', async () => {
  // ISZZ sends its 429 WITHOUT Access-Control-Allow-Origin (checked with curl and in Chromium, 2026-09-28), so in a
  // browser fetch() rejects with TypeError "Failed to fetch" (net::ERR_FAILED) and the status is never visible.
  // Four refusals in a row exceed the generic network budget (1 + 2 + 4 s) but must still end in data.
  const calls = [];
  Live._setFetch(async () => {
    calls.push(performance.now());
    if (calls.length <= 4) throw new TypeError('Failed to fetch');
    return { status: 200, ok: true, json: async () => [{ vrijednost: 5, vrijeme: Date.UTC(2026, 8, 26, 0) }] };
  });
  try {
    const rows = await Live.iszz(155, 'so2', Date.UTC(2026, 8, 26, 0), Date.UTC(2026, 8, 26, 0), 0);
    assert(rows.length === 1 && rows[0].v === 5, `rows after four refusals: ${JSON.stringify(rows)}`);
    assert(calls.length === 5, `four refusals + one success, got ${calls.length}`);
    const gaps = calls.slice(1).map((c, i) => c - calls[i]);
    assert(gaps.every((g) => g >= 1000 - 20 && g < 3500), `1–2 s jittered retries, got ${gaps.map(Math.round)}`);
  } finally {
    Live._setFetch((...a) => fetch(...a));
  }
  return { calls: calls.length };
});

test('ui.live iszz: a range over chunk_days is split under the cap with no duplicate hours', async () => {
  // Fake export: whole local days D1..D2 give the hour-ending slots (D1 00:00, (D2+1) 00:00] (iszz-api §4.3).
  const sizes = [];
  const day = (s) => s.split('.').map(Number);   // dd.MM.yyyy → [d, m, y]
  Live._setFetch(async (url) => {
    const q = new URL(url).searchParams;
    const [d1, m1, y1] = day(q.get('vrijemeOd')), [d2, m2, y2] = day(q.get('vrijemeDo'));
    const rows = [];
    for (let tt = ZgTime.toUTC(y1, m1, d1, 0) + 3600e3; tt <= ZgTime.toUTC(y2, m2, d2, 24); tt += 3600e3) rows.push({ vrijednost: 1, vrijeme: tt });
    sizes.push(rows.length);
    return { status: 200, ok: true, json: async () => rows };
  });
  try {
    const from = Date.UTC(2026, 6, 1, 5), to = from + 45 * 24 * 3600e3;   // 45 days → two requests
    const rows = await Live.iszz(155, 'no2', from, to, 1);
    assert(sizes.length === 2 && sizes.every((k) => k < SITE.iszz.max_rows), `requests ${sizes}`);
    assert(new Set(rows.map((r) => r.t)).size === rows.length, `duplicate hours: ${rows.length - new Set(rows.map((r) => r.t)).size}`);
    assert(rows.length === (to - from) / 3600e3 + 1 && rows[0].t === from && rows[rows.length - 1].t === to, `rows ${rows.length}`);
    assert(rows.every((r, i) => i === 0 || r.t > rows[i - 1].t), 'time-ordered');
  } finally {
    Live._setFetch((...a) => fetch(...a));
  }
  return { requests: sizes };
});

test('ui.zgtime: parts() agrees with Intl Europe/Zagreb 2023–2027', () => {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zagreb', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let n = 0;
  for (let tt = Date.UTC(2023, 0, 1); tt < Date.UTC(2028, 0, 1); tt += 3600e3) {
    const p = ZgTime.parts(tt), q = {};
    for (const { type, value } of fmt.formatToParts(tt)) q[type] = value;
    const ok = p.y === +q.year && p.mo === +q.month && p.d === +q.day && p.h === +q.hour && p.dow === DOW[q.weekday];
    if (!ok) throw new Error(`${new Date(tt).toISOString()}: ZgTime ${JSON.stringify(p)} vs Intl ${JSON.stringify(q)}`);
    // round trip local → UTC for every hour that exists and is not the repeated autumn hour
    if (ZgTime.offset(tt) === ZgTime.offset(tt - 3600e3) && ZgTime.offset(tt) === ZgTime.offset(tt + 3600e3)) {
      assert(ZgTime.toUTC(p.y, p.mo, p.d, p.h) === tt, `toUTC round trip at ${new Date(tt).toISOString()}`);
    }
    n++;
  }
  return { hours: n };
});

// ---------------------------------------------------------------- charts.js
test('ui.charts lineChart: valid SVG with aria-label, band, limits and a table', () => {
  const el = document.createElement('div');
  const t0 = Date.UTC(2026, 8, 25, 0);
  const pts = (f) => Array.from({ length: 24 }, (_, i) => ({ t: t0 + i * 3600e3, v: f(i) }));
  const meas = pts((i) => (i === 5 ? NaN : 20 + i));
  const mod = pts((i) => 18 + i);
  lineChart(el, { label: 'NO2 test chart', unit: 'µg/m³', series: [{ label: 'measured', points: meas, cls: 's1' }, { label: 'model', points: mod, cls: 's2' }],
    band: { lo: mod.map((p) => ({ t: p.t, v: p.v / 2 })), hi: mod.map((p) => ({ t: p.t, v: p.v * 2 })), label: 'x2' },
    thresholds: [{ v: 40, label: 'EU 40' }, { v: 400, label: 'far' }] });
  const svg = el.querySelector('svg');
  assert(svg && svg.namespaceURI === 'http://www.w3.org/2000/svg', 'svg element');
  assert(svg.getAttribute('role') === 'img' && svg.getAttribute('aria-label').startsWith('NO2 test chart'), 'role + aria-label');
  assert(/^0 0 \d+ \d+$/.test(svg.getAttribute('viewBox')), 'viewBox');
  const lines = svg.querySelectorAll('path.ln');
  assert(lines.length === 2, 'two series');
  assert((lines[0].getAttribute('d').match(/M/g) || []).length === 2, 'the missing hour breaks the line');
  assert(svg.querySelector('path.band'), 'factor-2 band');
  assert(svg.querySelectorAll('line.thr').length === 1, 'in-scale limit drawn');
  assert([...svg.querySelectorAll('.thr-label')].some((e) => e.textContent.includes('far')), 'off-scale limit listed');
  const rows = el.querySelectorAll('details table tbody tr');
  assert(rows.length === 24, `table rows ${rows.length}`);
  assert(el.querySelector('.chart-legend') && el.querySelectorAll('.chart-legend span').length === 3, 'legend (2 series + band)');
  // no NaN leaked into any coordinate
  assert(![...svg.querySelectorAll('*')].some((e) => [...e.attributes].some((a) => /NaN|undefined/.test(a.value))), 'no NaN in attributes');
  new XMLSerializer().serializeToString(svg);
  return { paths: lines.length, rows: rows.length };
});

test('ui.charts diurnal, rose, columns, stack and empty state', () => {
  const d = document.createElement('div');
  diurnalChart(d, { label: 'diurnal', unit: 'µg/m³', series: [{ label: 'weekday', values: Array.from({ length: 24 }, (_, h) => 20 + 10 * Math.sin(h / 4)), cls: 's1' }] });
  assert(d.querySelector('svg[role="img"]').getAttribute('aria-label').startsWith('diurnal'), 'diurnal aria');
  assert(d.querySelectorAll('.xtick').length === 8, '8 hour ticks');

  const r = document.createElement('div');
  const vals = Array.from({ length: 16 }, (_, k) => (k === 3 ? NaN : 10 + k));
  roseChart(r, { label: 'rose', unit: 'µg/m³', values: vals, compare: vals.map((v) => v * 0.8), valueLabel: 'meas', compareLabel: 'model', current: 2 });
  assert(r.querySelectorAll('path.petal').length === 15, 'one petal per finite sector');
  assert(r.querySelectorAll('path.hit').length === 16, '16 hit sectors');
  assert(r.querySelectorAll('details tbody tr').length === 16, '16 table rows');
  assert(r.querySelectorAll('text.dir').length === 16, '16 direction labels');

  const b = document.createElement('div');
  barChart(b, { label: 'annual', unit: 'µg/m³', bars: [{ label: '2023', value: 35 }, { label: '2024', value: 33 }, { label: '2025', value: NaN }], thresholds: [{ v: 40, label: 'EU 40' }] });
  assert(b.querySelectorAll('path.col').length === 2, 'two finite columns');
  assert(b.querySelectorAll('line.thr').length === 1, 'limit line within 2.2× of the data');

  const s = document.createElement('div');
  barChart(s, { mode: 'stack', label: 'attribution', unit: 'µg/m³', rows: [
    { label: 'today', segments: [{ id: 'A', label: 'A', value: 20, cls: 's1' }, { id: 'bg', label: 'bg', value: 16, cls: 's0' }] },
    { label: 'scenario', segments: [{ id: 'A', label: 'A', value: 10, cls: 's1' }, { id: 'bg', label: 'bg', value: 16, cls: 's0' }] }] });
  assert(s.querySelectorAll('rect.seg').length === 4, 'four segments');
  assert(s.querySelectorAll('details tbody tr').length === 2, 'stack table');

  const e = document.createElement('div');
  lineChart(e, { label: 'empty', series: [{ label: 'x', points: [] }] });
  assert(e.querySelector('.chart-empty') && !e.querySelector('svg'), 'empty data → a note, no svg');
});

test('ui.charts nice ticks', () => {
  const a = chart_nice(0, 87, 4);
  assert(a.step === 20 && a.hi === 100 && a.ticks.length === 6, JSON.stringify(a));
  const b = chart_nice(0, 0.42, 4);
  assert(Math.abs(b.step - 0.1) < 1e-12 && b.hi === 0.5 && b.ticks[3] === 0.3, JSON.stringify(b));
  const c = chart_nice(0, 9.2, 4);
  assert(c.step === 2 && c.hi === 10, JSON.stringify(c));
  assert(chart_dec(2.5) === 1 && chart_dec(0.25) === 2 && chart_dec(20) === 0, 'decimals follow the step');
  const e = chart_nice(-3, 41, 4);
  assert(e.lo === -20 && e.hi === 60 && e.ticks.includes(0), JSON.stringify(e));
});

// ---------------------------------------------------------------- main.js
test('ui.dial angle maths (16 steps, keyboard)', () => {
  assertClose(ui_dialAngle(0, -10), 0, 1e-9, 'up = north');
  assertClose(ui_dialAngle(10, 0), 90, 1e-9, 'right = east');
  assertClose(ui_dialAngle(0, 10), 180, 1e-9, 'down = south');
  assertClose(ui_dialAngle(-10, 0), 270, 1e-9, 'left = west');
  assertClose(ui_dialAngle(10, -10), 45, 1e-9, 'NE');
  assert(ui_snap16(11.2) === 0 && ui_snap16(11.3) === 22.5 && ui_snap16(359) === 0 && ui_snap16(-22.5) === 337.5, 'snap to 22.5°');
  assert(ui_dirIdx(0) === 0 && ui_dirIdx(45) === 2 && ui_dirIdx(266) === 12 && ui_dirIdx(349) === 0 && ui_dirIdx(337.5) === 15, 'round(from/22.5) % 16');
  assert(ui_dialKey(0, 'ArrowLeft') === 337.5 && ui_dialKey(337.5, 'ArrowRight') === 0 && ui_dialKey(0, 'ArrowUp') === 22.5, 'arrows wrap');
  assert(ui_dialKey(30, 'ArrowRight') === 45, 'snaps first, then steps');
  assert(ui_dialKey(0, 'PageUp') === 90 && ui_dialKey(0, 'PageDown') === 270 && ui_dialKey(200, 'Home') === 0 && ui_dialKey(0, 'End') === 337.5, 'page/home/end');
  assert(ui_dialKey(0, 'a') === null, 'other keys ignored');
});

test('ui.bands and climatology helpers', () => {
  assert(ui_band('no2', 30, 'eea').level === 3 && ui_band('no2', 30, 'iszz').level === 1, 'NO2 30: EEA moderate, ISZZ good');
  assert(ui_band('pm10', 60, 'eea').level === 3 && ui_band('pm10', 60, 'iszz').level === 4, 'PM10 60');
  assert(ui_band('no2', 25, 'eea').level === 2, 'a value equal to a limit is in the lower band (chemistry.js convention)');
  assert(ui_band('co', 1, 'eea').level === 0 && Number.isNaN(ui_bandLo('c6h6', 3)), 'no EAQI for CO/benzene');
  assert(ui_bandLo('no2', 3, 'eea') === 25 && ui_bandLo('pm25', 6, 'iszz') === 75, 'band lower bounds');
  assertClose(ui_climT(1), -0.3, 1e-9, 'Maksimir January');
  assertClose(ui_climT(7), 20.7, 1e-9, 'Maksimir July');
  assert(ui_isHeatingMonth(10) && ui_isHeatingMonth(3) && !ui_isHeatingMonth(4), 'heating Oct–Mar');
  assert(ui_isLeafMonth(5) && ui_isLeafMonth(10) && !ui_isLeafMonth(11), 'leaf-on May–Oct');
});

test('ui.model adapters: NO2 split, limit lines, street points', () => {
  // NO2 has no byGroup in concentrations(): its increment is split in proportion to NOx (A 30, B 10 of NOx 40)
  const c = { no2: 30, nox: 60, inc: { nox: 40, no2: 12 }, bg: { no2: 18 }, byGroup: { nox: [30, 10, 0, 0] } };
  const pk = ui_pick(c, 'no2');
  assert(pk.split && Math.abs(pk.groups[0] - 9) < 1e-9 && Math.abs(pk.groups[1] - 3) < 1e-9, JSON.stringify(pk.groups));
  assert(pk.total === 30 && pk.inc === 12 && pk.bg === 18, 'total, increment, background');
  const nox = ui_pick({ nox: 60, inc: { nox: 40 }, bg: { nox: 20 }, byGroup: { nox: [30, 10, 0, 0] } }, 'nox');
  assert(!nox.split && nox.groups[0] === 30, 'NOx uses its own split');
  assert(ui_pick(null, 'no2').total !== ui_pick(null, 'no2').total, 'no result → NaN');
  // annual lines: EU now, EU 2030, WHO (chemistry.js THRESHOLDS when loaded, else the built-in copy)
  const a = ui_limitLines('no2', 'annual').map((q) => q.v);
  assert(a.length === 3 && a[0] === 40 && a[1] === 20 && a[2] === 10, JSON.stringify(a));
  const h = ui_limitLines('no2', 'hourly');
  assert(h.length === 1 && h[0].v === 200 && /200/.test(h[0].label), JSON.stringify(h));
  assert(ui_limitLines('pm10', 'hourly')[0].v === 50 && ui_limitLines('nox', 'hourly').length === 0, 'PM10 24 h line, none for NOx');
  // street points: inside 300 m, deduplicated to 5 m cells
  ui_buildStreetPoints();
  const n = ui_streetPts.length / 2;
  let far = 0;
  const cells = new Set();
  for (let i = 0; i < ui_streetPts.length; i += 2) {
    if (Math.hypot(ui_streetPts[i], ui_streetPts[i + 1]) > UI_STREET_R + 1e-6) far++;
    cells.add(`${Math.round(ui_streetPts[i] / UI_STREET_DX)},${Math.round(ui_streetPts[i + 1] / UI_STREET_DX)}`);
  }
  assert(n > 100 && far === 0 && cells.size === n, `n=${n} far=${far} cells=${cells.size}`);
  return { streetPoints: n, annual: a };
});

test('ui.presets give hour-ending times on the right local day', () => {
  const tt = ui_presetTime(1, 2, 7);
  const hs = ZgTime.hourStart(tt);
  assert(hs.mo === 1 && hs.dow === 2 && hs.h === 7, `winter rush → ${JSON.stringify(hs)}`);
  const s = ZgTime.hourStart(ui_presetTime(11, 0, 23));
  assert(s.mo === 11 && s.dow === 0 && s.h === 23, `Sunday night → ${JSON.stringify(s)}`);
  for (const id of Object.keys(UI_PRESETS)) { const p = UI_PRESETS[id](); assert(p.u10 >= 0 && p.u10 <= 8 && p.from >= 0 && p.from < 360, id); }
});

test('ui.i18n completeness: every ui/chart/data key in hr and en, every markup key defined', () => {
  const missing = [];
  for (const [name, dict] of [['ui', UI_STRINGS], ['chart', chart_STRINGS], ['data', data_STRINGS]]) {
    const hr = Object.keys(dict.hr), en = Object.keys(dict.en);
    for (const k of hr) if (!(k in dict.en) || !String(dict.en[k]).trim()) missing.push(`${name} en:${k}`);
    for (const k of en) if (!(k in dict.hr) || !String(dict.hr[k]).trim()) missing.push(`${name} hr:${k}`);
    for (const k of hr) if (!k.startsWith(`${name}.`)) missing.push(`namespace ${k}`);
  }
  const used = new Set();
  for (const el of document.querySelectorAll('[data-i18n]')) used.add(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-attr]')) for (const pair of el.dataset.i18nAttr.split(',')) used.add(pair.split(':')[1].trim());
  for (const k of used) if (!(k in UI_STRINGS.hr) || !(k in UI_STRINGS.en)) missing.push(`markup ${k}`);
  // keys built at run time from state values
  const dyn = [...['winterRush', 'summerPm', 'sundayNight', 'ne', 'sw', 'now', 'fc24'].map((p) => `ui.preset.hint.${p}`),
    ...['no2', 'nox', 'pm10', 'pm25', 'co', 'c6h6'].flatMap((p) => [`ui.pol.hint.${p}`, `ui.pol.name.${p}`]),
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => `ui.eaqi.${i}`), ...[0, 1, 2, 3, 4, 5, 6].map((i) => `ui.dow.${i}`),
    ...Array.from({ length: 12 }, (_, i) => `ui.month.${i + 1}`), ...Array.from({ length: 12 }, (_, i) => `ui.mon.${i + 1}`),
    ...['calibrated', 'uncalibrated', 'fallback-only'].map((s) => `ui.cal.status.${s}`),
    ...['FB', 'NMSE', 'MG', 'VG', 'FAC2', 'NAD', 'R', 'n'].map((m) => `ui.cal.m.${m}`),
    ...['z4live', 'z4hist', 'cams', 'clim', 'default', 'derived'].map((s) => `ui.bgsrc.${s}`),
    ...['diurnal', 'monthly', 'annual', 'rose'].map((v) => `ui.data.t.${v}`), 'ui.leaves.on', 'ui.leaves.off'];
  for (const k of dyn) if (!(k in UI_STRINGS.hr) || !(k in UI_STRINGS.en)) missing.push(`dynamic ${k}`);
  assert(!missing.length, `missing strings: ${missing.join(', ')}`);
  return { ui: Object.keys(UI_STRINGS.hr).length, chart: Object.keys(chart_STRINGS.hr).length, data: Object.keys(data_STRINGS.hr).length, markup: used.size };
});

test('ui.time labels: explicit hour spans, midnight and DST', () => {
  assert(ui_span(ZgTime.toUTC(2026, 9, 28, 9)).includes('08–09 h'), ui_span(ZgTime.toUTC(2026, 9, 28, 9)));
  const mid = ui_span(ZgTime.toUTC(2026, 9, 27, 24));
  assert(mid.includes('23–24 h') && /27/.test(mid), `hour ending 24:00 belongs to the 27th: ${mid}`);
  // 29 Mar 2026: the hour 00:00Z–01:00Z starts at 01:00 CET and ends at 03:00 CEST
  assert(ui_span(Date.UTC(2026, 2, 29, 1)).includes('01–03 h'), `spring switch: ${ui_span(Date.UTC(2026, 2, 29, 1))}`);
  assert(ui_endHour(Date.UTC(2026, 2, 29, 1)) === 3 && ui_endHour(ZgTime.toUTC(2026, 9, 27, 24)) === 24, 'end hours');
  // the hour slider (local hour start + 1) maps back to the same hour on a switch day
  assert(ZgTime.toUTC(2026, 3, 29, 2 - 1) + UI_H === Date.UTC(2026, 2, 29, 1), 'slider 2 on 29 Mar = the hour 01–03 h');
  assert(ui_gridLabel('60x60x16@10m') === '10 m' && ui_gridLabel('120x120x32@5m') === '5 m' && ui_gridLabel(null) === '?', 'grid labels');
  assert(state.sliceWhat === 'inc', 'the map shows the local increment by default');
});

test('ui.boot guard: the app does not boot under SELFTEST', () => {
  assert(SELFTEST, 'this runs under ?selftest');
  assert(window.__z1 && window.__z1.ready === false && window.__z1.fields === 0, 'window.__z1 exists but the app is not booted');
  assert(typeof state === 'object' && state.pollutant === 'no2' && state.from === 45 && state.u10 === 1.7, 'default state = critic §4.5 NE preset');
});


// x-axis ticks never crowd: at least 44 px between labels at any width and span (integration review 2026-09-28:
// '18 29 Sep 06' overlapped on the 327 px panel).
test('ui.charts time ticks keep 44 px apart', async () => {
  const el = document.createElement('div');
  const t0 = Date.UTC(2026, 8, 25, 0), mk = (h) => Array.from({ length: h }, (_, i) => ({ t: t0 + i * 3600e3, v: 10 + (i % 24) }));
  for (const [hours, width] of [[72, 327], [72, 900], [24 * 14, 327], [24 * 400, 327]]) {
    el.style.width = `${width}px`;
    document.body.appendChild(el);
    lineChart(el, { series: [{ label: 'x', points: mk(hours) }], unit: 'µg/m³', label: 'test', width });
    // The SVG has a fixed viewBox that scales as a whole (labels included), so spacing is checked in viewBox units.
    const xs = Array.from(el.querySelectorAll('text.xtick')).map((n) => Number(n.getAttribute('x'))).sort((p, q) => p - q);
    assert(xs.length >= 2, `${hours} h at ${width} px: ${xs.length} ticks`);
    for (let i = 1; i < xs.length; i++) assert(xs[i] - xs[i - 1] >= 43, `${hours} h at ${width} px: ticks ${Math.round(xs[i] - xs[i - 1])} px apart`);
    el.remove();
  }
});
