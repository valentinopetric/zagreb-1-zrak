// ------------------------------------------------------------------ data (owner: ui)
/*
 * Data access for the page: the baked archive (Hist), the live clients (Live) and the Zagreb clock (ZgTime,
 * localHour, fmtLocal). Contract: docs/architecture.md §6.4. Nothing here touches THREE or the 3D scene.
 *
 * Time convention (architecture §2, iszz-api §4): every timestamp is epoch ms UTC and marks the END of the
 * averaging hour ("hour-ending"), exactly as ISZZ stamps it. A value at 10:00Z is the mean of 09:00–10:00Z.
 * Display is Europe/Zagreb local time. The model's "hour of day" is the local hour at which the averaging
 * interval STARTS (hour-ending minus 1 h), which ZgTime.hourStart() returns.
 *
 * Public names (all others are prefixed data_):
 *   ZgTime   Europe/Zagreb clock helpers (offset, parts, toUTC, hourStart, dayType, floor/ceil)
 *   localHour(ms) → 0..23 local wall-clock hour at the instant ms
 *   fmtLocal(ms, opts) → "27. 9. 20:00" (hr) / "27 Sep 20:00" (en)
 *   Hist     decoded measurements.json (§4.2): series(key) → Float32Array with NaN for missing
 *   Live     browser clients for ISZZ, Open-Meteo IFS and CAMS: serialised, paced, cached, with timeouts
 */

const data_STRINGS = {
  hr: {
    'data.err.timeout': 'Isteklo vrijeme čekanja ({s} s)',
    'data.err.http': 'HTTP {code}',
    'data.err.network': 'Mreža nedostupna',
    'data.err.ratelimit': 'Poslužitelj ograničava broj upita (429), pokušano {n} puta',
    'data.err.parse': 'Neočekivan oblik odgovora',
    'data.err.truncated': 'Odgovor je odrezan na {n} redaka',
    'data.src.live': 'uživo',
    'data.src.baked': 'ugrađena arhiva',
    'data.src.default': 'zadana vrijednost',
  },
  en: {
    'data.err.timeout': 'Timed out ({s} s)',
    'data.err.http': 'HTTP {code}',
    'data.err.network': 'Network unavailable',
    'data.err.ratelimit': 'Server rate limit (429), tried {n} times',
    'data.err.parse': 'Unexpected response shape',
    'data.err.truncated': 'Response truncated at {n} rows',
    'data.src.live': 'live',
    'data.src.baked': 'baked archive',
    'data.src.default': 'default value',
  },
};
I18N.add(data_STRINGS);

const data_HOUR = 3600000;   // ms in one hour
const data_DAY = 24 * data_HOUR;

// ------------------------------------------------------------------ Zagreb clock
/*
 * Europe/Zagreb is CET (UTC+1) with EU summer time (UTC+2) from 01:00 UTC on the last Sunday of March to
 * 01:00 UTC on the last Sunday of October (Directive 2000/84/EC, art. 2–3). Computing the offset from that rule
 * is exact for every date the app handles and about 100× faster than Intl.formatToParts, which matters when
 * the pollution-rose comparison evaluates ~10 000 archive hours.
 */
function data_lastSundayUTC(year, month0) {
  // 01:00 UTC on the last Sunday of the month (month0 = 0-based month).
  const last = new Date(Date.UTC(year, month0 + 1, 0, 1, 0, 0));
  return last.getTime() - last.getUTCDay() * data_DAY;
}
const data_dstCache = new Map();
function data_dstWindow(year) {
  let w = data_dstCache.get(year);
  if (!w) { w = [data_lastSundayUTC(year, 2), data_lastSundayUTC(year, 9)]; data_dstCache.set(year, w); }
  return w;
}

const ZgTime = {
  /** UTC offset of Europe/Zagreb at the instant ms, in hours (1 or 2). */
  offset(ms) {
    const y = new Date(ms).getUTCFullYear();
    const [a, b] = data_dstWindow(y);
    return ms >= a && ms < b ? 2 : 1;
  },
  /** Local wall-clock fields at instant ms: {y, mo (1–12), d, h, mi, dow (0 = Sunday)}. */
  parts(ms) {
    const l = new Date(ms + ZgTime.offset(ms) * data_HOUR);
    return { y: l.getUTCFullYear(), mo: l.getUTCMonth() + 1, d: l.getUTCDate(), h: l.getUTCHours(),
      mi: l.getUTCMinutes(), dow: l.getUTCDay() };
  },
  /**
   * Local wall clock → UTC ms. h may be 24 (= 00:00 of the next day, the ISZZ "24:00" slot). For the hour that
   * does not exist in spring (02:00–03:00) the result is the instant one hour later, as a clock would show.
   */
  toUTC(y, mo, d, h = 0, mi = 0) {
    const naive = Date.UTC(y, mo - 1, d, h, mi);
    let t = naive - ZgTime.offset(naive - data_HOUR) * data_HOUR;
    t = naive - ZgTime.offset(t) * data_HOUR;
    return t;
  },
  /** Local fields of the START of the averaging hour that ends at msHourEnding (the model's hour of day). */
  hourStart(msHourEnding) { return ZgTime.parts(msHourEnding - data_HOUR); },
  /** 'weekday' | 'saturday' | 'sunday' of the averaging hour that ends at ms (by its local start). */
  dayType(msHourEnding) {
    const dow = ZgTime.hourStart(msHourEnding).dow;
    return dow === 0 ? 'sunday' : dow === 6 ? 'saturday' : 'weekday';
  },
  floorHour(ms) { return Math.floor(ms / data_HOUR) * data_HOUR; },
  ceilHour(ms) { return Math.ceil(ms / data_HOUR) * data_HOUR; },
  /** The hour-ending stamp of the hour now in progress (it ends at the next full hour). */
  currentHourEnding(now = Date.now()) { return Math.floor(now / data_HOUR) * data_HOUR + data_HOUR; },
  /** 'dd.MM.yyyy' of the local date at instant ms (the ISZZ export date format, iszz-api §3.1). */
  isoLocalDate(ms) {
    const p = ZgTime.parts(ms);
    return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  },
  iszzDate(ms) {
    const p = ZgTime.parts(ms);
    return `${String(p.d).padStart(2, '0')}.${String(p.mo).padStart(2, '0')}.${p.y}`;
  },
};

/** Local (Europe/Zagreb) wall-clock hour 0..23 at the instant ms. */
function localHour(ms) { return ZgTime.parts(ms).h; }

const data_MONTHS = {
  hr: ['sij', 'velj', 'ožu', 'tra', 'svi', 'lip', 'srp', 'kol', 'ruj', 'lis', 'stu', 'pro'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};
/**
 * Local date and time for display: hr "27. 9. 20:00", en "27 Sep 20:00". opts.date / opts.time switch the
 * parts; opts.year adds the year. A stamp at local midnight is shown as "24:00" of the previous day when
 * opts.ending is set, the ISZZ way of labelling the last hour of a day (iszz-api §4.3).
 */
function fmtLocal(ms, opts = {}) {
  if (!Number.isFinite(ms)) return '–';
  const { date = true, time = true, year = false, ending = false } = opts;
  let p = ZgTime.parts(ms), hh = p.h;
  if (ending && p.h === 0 && p.mi === 0) { p = ZgTime.parts(ms - data_HOUR); hh = 24; }
  const hm = `${String(hh).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
  const en = I18N.lang === 'en';
  const d = en ? `${p.d} ${data_MONTHS.en[p.mo - 1]}${year ? ' ' + p.y : ''}` : `${p.d}. ${p.mo}.${year ? ' ' + p.y + '.' : ''}`;
  return [date ? d : '', time ? hm : ''].filter(Boolean).join(' ');
}

// ------------------------------------------------------------------ Hist: the baked archive (§4.2)
/*
 * measurements.json stores each hourly series as base64 little-endian Int16, value = int16 × scale, with
 * -32768 meaning missing (architecture §4.2). series(key) decodes once and caches a Float32Array of length n
 * with NaN for missing hours. Index i is the hour ENDING at t0 + i h.
 *
 * Hist.create(meas) builds a separate store from any object with the same schema (used by the tests). When the
 * page was built without measurements.json (MEAS = null), Hist.ok is false and every series is empty.
 */
const Hist = (() => {
  const MISSING = -32768;   // architecture §4.2
  function b64bytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  class HistStore {
    constructor(meas) {
      const ok = !!(meas && meas.meta && meas.series && Number.isFinite(meas.meta.t0) && Number.isFinite(meas.meta.n));
      this.ok = ok;
      this.meta = ok ? meas.meta : null;
      this.t0 = ok ? meas.meta.t0 : NaN;
      this.n = ok ? meas.meta.n : 0;
      this.stats = (meas && meas.stats) || null;
      this.latest = (meas && meas.latest) || {};
      this.keys = ok ? (meas.keys || Object.keys(meas.series)) : [];
      this._series = ok ? meas.series : {};
      this._scale = (meas && meas.scale) || {};
      this._cache = new Map();
    }
    /** Hour-ending time of the last index, or NaN. */
    get tEnd() { return this.ok ? this.timeAt(this.n - 1) : NaN; }
    has(key) { return this.ok && typeof this._series[key] === 'string'; }
    /** Float32Array(n), NaN for missing hours. Unknown keys give an all-NaN array (never throws). */
    series(key) {
      if (this._cache.has(key)) return this._cache.get(key);
      const out = new Float32Array(this.n).fill(NaN);
      if (this.has(key)) {
        const bytes = b64bytes(this._series[key]);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const scale = Number.isFinite(this._scale[key]) ? this._scale[key] : 1;
        const m = Math.min(this.n, bytes.byteLength >> 1);
        for (let i = 0; i < m; i++) {
          const q = dv.getInt16(i * 2, true);
          out[i] = q === MISSING ? NaN : q * scale;
        }
        if (m !== this.n) console.warn(`Hist: ${key} has ${m} values, meta.n = ${this.n}; padded with NaN`);
      }
      this._cache.set(key, out);
      return out;
    }
    timeAt(i) { return this.t0 + i * data_HOUR; }
    /** Index of the hour ending at ms (rounded to the nearest hour), or -1 outside the archive. */
    indexAt(ms) {
      if (!this.ok || !Number.isFinite(ms)) return -1;
      const i = Math.round((ms - this.t0) / data_HOUR);
      return i >= 0 && i < this.n ? i : -1;
    }
    /** Value of key for the hour ending at ms, NaN when missing or outside the archive. */
    value(key, ms) {
      const i = this.indexAt(ms);
      return i < 0 ? NaN : this.series(key)[i];
    }
    /** Finite points [{t, v}] of key with fromMs ≤ t ≤ toMs. */
    window(key, fromMs, toMs) {
      const out = [];
      if (!this.has(key)) return out;
      const s = this.series(key);
      const i0 = Math.max(0, Math.ceil((fromMs - this.t0) / data_HOUR)), i1 = Math.min(this.n - 1, Math.floor((toMs - this.t0) / data_HOUR));
      for (let i = i0; i <= i1; i++) if (Number.isFinite(s[i])) out.push({ t: this.timeAt(i), v: s[i] });
      return out;
    }
  }
  const h = new HistStore(typeof MEAS === 'undefined' ? null : MEAS);
  h.create = (meas) => new HistStore(meas);
  return h;
})();

// ------------------------------------------------------------------ Live: browser clients
/*
 * All sources send Access-Control-Allow-Origin: * (critic §1.16), so the page calls them directly. Rules:
 *
 *  - Requests are serialised per lane and started at least `pace` ms apart. ISZZ's export limiter accepts about
 *    one request per second per IP and answers bursts with 429 and no Retry-After (iszz-api §7), so its lane
 *    uses SITE.iszz.pace_s = 1.1 s. Open-Meteo allows 600 calls/min (critic §1.16); its lane is paced the same
 *    way to stay polite. The ISZZ EAQI routes are not rate limited (iszz-api §2) and use an unpaced lane.
 *  - 429 → wait 1–2 s with jitter and retry, up to data_RETRY_429 times (iszz-api §7 recommends 1–2 s).
 *    Network errors and 5xx → exponential back-off 1, 2, 4 s, up to data_RETRY_NET times.
 *  - Each attempt has an AbortController timeout (data_TIMEOUT_MS).
 *  - Responses are cached in memory by URL. Windows that end more than 3 days ago never change (iszz-api §10:
 *    a chunk is final 3 days after its end) and are kept for the session; recent windows expire after
 *    data_TTL_RECENT_MS. Identical requests in flight are shared.
 *  - No custom request headers are sent, so no CORS preflight is triggered (physics §11.1).
 */
const data_TIMEOUT_MS = 20000;          // one attempt; ISZZ answers in 0.03–0.15 s (iszz-api §0), Open-Meteo < 1 s
const data_RETRY_429 = 8;               // 1–2 s each: gives up after ~12 s of refusals
const data_RETRY_NET = 3;               // 1 + 2 + 4 s back-off
const data_TTL_RECENT_MS = 10 * 60000;  // ISZZ publishes hourly with a 1–2 h lag (iszz-api §4.7); 10 min is ample
const data_FINAL_AFTER_MS = 3 * data_DAY;
// Grid point for Open-Meteo: the station rounded to 4 decimals (≈ 10 m), as in critic §4.1 D8/D9.
const data_LAT = Math.round(SITE.station.lat * 1e4) / 1e4;
const data_LON = Math.round(SITE.station.lon * 1e4) / 1e4;
// Bias ratios observed/CAMS for 2025 at ZAGREB-4 (critic §4.1 D9), used when the live 14-day ratio is unavailable.
const data_CAMS_RATIO_2025 = { no2: 1.77, o3: 0.86, pm10: 1.20, pm25: 0.85 };
// NOx/NO2 at ZAGREB-4, 2025 validated annual means 23.96 / 16.32 µg/m³ (research/data/physics/iszz/303_*_1_2025.json).
const data_NOX_NO2_Z4_2025 = 23.96 / 16.32;
const data_MIN_PAIRS = 48;              // a live 14-day ratio needs ≥ 2 days of matched hours, else the 2025 ratio

class data_HttpError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

const Live = (() => {
  const lanes = {
    iszz: { pace: SITE.iszz.pace_s * 1000, next: 0, chain: Promise.resolve() },
    free: { pace: 0, next: 0, chain: Promise.resolve() },
    om: { pace: 1100, next: 0, chain: Promise.resolve() },
  };
  const cache = new Map();      // url → {t, ttl, data}
  const inflight = new Map();   // url → Promise
  const status = {};            // source → {ok, t, error}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let fetchImpl = (...a) => fetch(...a);

  // Run fn in the lane, no earlier than `pace` ms after the previous request of the lane started.
  function enqueue(laneName, fn) {
    const lane = lanes[laneName];
    const run = lane.chain.then(async () => {
      const wait = lane.next - performance.now();
      if (wait > 0) await sleep(wait);
      lane.next = performance.now() + lane.pace;
      return fn();
    });
    lane.chain = run.catch(() => {});
    return run;
  }

  async function attempt(url, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { signal: ctl.signal, cache: 'no-store' });
      if (r.status === 204) return { status: 204, body: null };     // ISZZ: bad date format (iszz-api §3.4)
      if (!r.ok) return { status: r.status, body: null };
      return { status: r.status, body: await r.json() };
    } catch (e) {
      if (e && e.name === 'AbortError') throw new data_HttpError(t('data.err.timeout', { s: Math.round(timeoutMs / 1000) }), 'timeout');
      if (e instanceof SyntaxError) throw new data_HttpError(t('data.err.parse'), 'parse');
      throw new data_HttpError(t('data.err.network'), 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET url as JSON through a lane with pacing, retries, timeout and caching.
   * opts: {lane, ttl (ms; Infinity = session), source (status key), timeout}
   */
  async function getJSON(url, opts = {}) {
    const { lane = 'om', ttl = data_TTL_RECENT_MS, source = lane, timeout = data_TIMEOUT_MS } = opts;
    const hit = cache.get(url);
    if (hit && performance.now() - hit.t < hit.ttl) return hit.data;
    if (inflight.has(url)) return inflight.get(url);
    const job = (async () => {
      let n429 = 0, nNet = 0;
      for (;;) {
        let res;
        try {
          res = await enqueue(lane, () => attempt(url, timeout));
        } catch (e) {
          if (e.code === 'parse' || nNet >= data_RETRY_NET) throw e;
          await sleep(1000 * 2 ** nNet++);
          continue;
        }
        if (res.status === 429) {
          if (++n429 > data_RETRY_429) throw new data_HttpError(t('data.err.ratelimit', { n: n429 }), 429);
          await sleep(1000 + Math.random() * 1000);
          continue;
        }
        if (res.status >= 500 && nNet < data_RETRY_NET) { await sleep(1000 * 2 ** nNet++); continue; }
        if (res.status !== 200 && res.status !== 204) throw new data_HttpError(t('data.err.http', { code: res.status }), res.status);
        const data = res.body;
        cache.set(url, { t: performance.now(), ttl, data });
        return data;
      }
    })();
    inflight.set(url, job);
    try {
      const d = await job;
      status[source] = { ok: true, t: Date.now(), error: null };
      return d;
    } catch (e) {
      status[source] = { ok: false, t: Date.now(), error: String(e.message || e) };
      throw e;
    } finally {
      inflight.delete(url);
    }
  }

  // ---------------------------------------------------------------- ISZZ export
  function paramCode(param) {
    if (typeof param === 'number') return param;
    const p = SITE.iszz.params[param];
    if (!p) throw new Error(`unknown ISZZ parameter ${param}`);
    return p.code;
  }
  // Rows arrive flat ({vrijednost, vrijeme}) or, per the outdated PDF, wrapped as {Podatak: {...}} with ISO time
  // (iszz-api §2, gotcha 13). Values ≤ −900 are the validated-series sentinel −999 (iszz-api §0).
  function parseIszz(rows) {
    if (!Array.isArray(rows)) throw new data_HttpError(t('data.err.parse'), 'parse');
    const out = [];
    for (const r0 of rows) {
      const r = r0 && r0.Podatak ? r0.Podatak : r0;
      if (!r) continue;
      const v = typeof r.vrijednost === 'string' ? parseFloat(r.vrijednost.replace(',', '.')) : r.vrijednost;
      const tt = typeof r.vrijeme === 'number' ? r.vrijeme : Date.parse(r.vrijeme);
      if (!Number.isFinite(v) || !Number.isFinite(tt) || v <= SITE.iszz.missing_sentinel_max) continue;
      out.push({ t: tt, v });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /**
   * Hourly values [{t, v}] (hour-ending UTC ms) of one parameter at one station with fromMs ≤ t ≤ toMs.
   * The export returns whole local days: vrijemeOd=D1&vrijemeDo=D2 gives the slots D1 01:00 … (D2+1) 00:00
   * (iszz-api §4.3), so D1 is the local date of fromMs − 1 h and D2 that of toMs − 1 h. Ranges longer than
   * SITE.iszz.chunk_days are split, because the service silently truncates at max_rows rows (iszz-api §3.2).
   */
  async function iszz(station, param, fromMs, toMs, type = 0) {
    const code = paramCode(param);
    const chunks = [];
    const step = SITE.iszz.chunk_days * data_DAY;
    for (let a = fromMs; a <= toMs; a += step) chunks.push([a, Math.min(toMs, a + step - data_HOUR)]);
    const out = [];
    for (const [a, b] of chunks) {
      const url = `${SITE.iszz.export}?postaja=${station}&polutant=${code}&tipPodatka=${type}`
        + `&vrijemeOd=${ZgTime.iszzDate(a - data_HOUR)}&vrijemeDo=${ZgTime.iszzDate(b - data_HOUR)}`;
      const final = Date.now() - b > data_FINAL_AFTER_MS;
      const rows = await getJSON(url, { lane: 'iszz', ttl: final ? Infinity : data_TTL_RECENT_MS, source: 'iszz' });
      if (Array.isArray(rows) && rows.length >= SITE.iszz.max_rows) console.warn(t('data.err.truncated', { n: rows.length }), url);
      for (const p of parseIszz(rows || [])) if (p.t >= fromMs && p.t <= toMs) out.push(p);
    }
    return out;
  }

  // Parameters fetched by recent(): the model's pollutants plus the station wind (display only, critic §1.5).
  // ZAGREB-4 supplies the background, including O3, which ZAGREB-1 does not measure (critic §1.7).
  const Z1_KEYS = ['no2', 'nox', 'pm10', 'pm25', 'co', 'c6h6', 'ws', 'wd'];
  const Z4_KEYS = ['no2', 'nox', 'o3', 'pm10', 'pm25'];

  /**
   * Recent measurements. ZAGREB-1 over the last `hours`, ZAGREB-4 over the last bgDays (14 by default, the CAMS
   * bias window of physics §11.4) so one request per parameter serves both the background and the ratio.
   * onPartial(station 'z1'|'z4', key, rows) is called as each series arrives, in priority order.
   * Returns {z1: {key: [{t,v}]}, z4: {...} (last `hours`), z4long: {...} (bgDays), errors: [{station, key, error}], t}.
   */
  async function recent(hours = 72, opts = {}) {
    const { onPartial = null, bgDays = 14 } = opts;
    const to = ZgTime.currentHourEnding();
    const from = to - hours * data_HOUR, fromBg = to - bgDays * data_DAY;
    const res = { z1: {}, z4: {}, z4long: {}, errors: [], t: Date.now() };
    const jobs = [];
    for (const k of Z1_KEYS) jobs.push(['z1', k, SITE.station.iszz_id, from]);
    for (const k of Z4_KEYS) jobs.push(['z4', k, SITE.background.iszz_id, fromBg]);
    await Promise.all(jobs.map(async ([st, k, id, a]) => {
      try {
        const rows = await iszz(id, k, a, to, SITE.iszz.types.hourly_raw);
        if (st === 'z1') res.z1[k] = rows;
        else { res.z4long[k] = rows; res.z4[k] = rows.filter((p) => p.t >= from); }
        if (onPartial) { try { onPartial(st, k, st === 'z1' ? rows : res.z4[k]); } catch (e) { console.error(e); } }
      } catch (e) {
        res.errors.push({ station: st, key: k, error: String(e.message || e) });
      }
    }));
    return res;
  }

  /**
   * Current ISZZ EAQI badge (legacy EEA bands, iszz-api §9.3) for ZAGREB-1 and ZAGREB-4:
   * {z1: {index 0..6, t, raw}, z4: {...}}. index 0 = no data.
   */
  async function eaqi() {
    const list = await getJSON(SITE.iszz.eaqi, { lane: 'free', source: 'eaqi' });
    if (!Array.isArray(list)) throw new data_HttpError(t('data.err.parse'), 'parse');
    const pick = (id) => {
      const r = list.find((x) => x && x.id === id);
      return r ? { index: Number(r.indeks) || 0, t: r.vrijeme, name: r.naziv, raw: r } : null;
    };
    return { z1: pick(SITE.station.iszz_id), z4: pick(SITE.background.iszz_id) };
  }

  // ---------------------------------------------------------------- Open-Meteo
  // Open-Meteo returns GMT times 'YYYY-MM-DDTHH:MM' with timezone=GMT.
  const omTime = (s) => Date.parse(s + ':00Z');
  function vecMean(list) {
    if (typeof vectorMeanWind === 'function') {
      try { const r = vectorMeanWind(list); if (r && Number.isFinite(r.u)) return r; } catch (e) { /* fall through */ }
    }
    // Mean of the "blowing toward" vectors (−sin θ, −cos θ)·u (architecture §2), converted back to a "from" bearing.
    let sx = 0, sy = 0;
    for (const { u, dir } of list) { sx -= u * Math.sin(dir * DEG); sy -= u * Math.cos(dir * DEG); }
    sx /= list.length; sy /= list.length;
    return { u: Math.hypot(sx, sy), dir: wrap360(Math.atan2(-sx, -sy) / DEG) };
  }
  const mean2 = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2 : NaN);
  const num = (x) => (x === null || x === undefined ? NaN : Number(x));

  /**
   * Instantaneous model values → hour-ending means, the ISZZ convention (critic §4.1 D7): the value for the
   * hour ending at t is the mean of the values at t − 1 h and t, with the wind vector-averaged. Radiation is
   * already a preceding-hour mean in Open-Meteo, so shortwave_radiation at t is used as is.
   */
  function parseForecast(j) {
    const h = j && j.hourly;
    if (!h || !Array.isArray(h.time)) throw new data_HttpError(t('data.err.parse'), 'parse');
    const out = [];
    for (let i = 1; i < h.time.length; i++) {
      const u0 = num(h.wind_speed_10m[i - 1]), u1 = num(h.wind_speed_10m[i]);
      const d0 = num(h.wind_direction_10m[i - 1]), d1 = num(h.wind_direction_10m[i]);
      let u10 = NaN, wd = NaN;
      if ([u0, u1, d0, d1].every(Number.isFinite)) {
        const m = vecMean([{ u: u0, dir: d0 }, { u: u1, dir: d1 }]);
        u10 = m.u; wd = m.dir;
      }
      out.push({
        t: omTime(h.time[i]), u10, wd,
        blh: mean2(num(h.boundary_layer_height?.[i - 1]), num(h.boundary_layer_height?.[i])),
        t2: mean2(num(h.temperature_2m?.[i - 1]), num(h.temperature_2m?.[i])),
        cc: mean2(num(h.cloud_cover?.[i - 1]), num(h.cloud_cover?.[i])),
        sw: num(h.shortwave_radiation?.[i]),
      });
    }
    return out;
  }
  function parseCams(j) {
    const h = j && j.hourly;
    if (!h || !Array.isArray(h.time)) throw new data_HttpError(t('data.err.parse'), 'parse');
    const out = [];
    const f = (arr, i) => mean2(num(arr?.[i - 1]), num(arr?.[i]));
    for (let i = 1; i < h.time.length; i++) {
      out.push({ t: omTime(h.time[i]), no2: f(h.nitrogen_dioxide, i), o3: f(h.ozone, i), pm10: f(h.pm10, i), pm25: f(h.pm2_5, i) });
    }
    return out;
  }

  /** ECMWF IFS hourly (models=ecmwf_ifs, critic §1.1): [{t, u10, wd, blh, t2, cc, sw}], hour-ending means. */
  async function forecast(opts = {}) {
    const { pastDays = 2, forecastDays = 3 } = opts;
    const url = `${SITE.openmeteo.forecast}?latitude=${data_LAT}&longitude=${data_LON}&hourly=${SITE.openmeteo.hourly.join(',')}`
      + `&wind_speed_unit=ms&timezone=GMT&past_days=${pastDays}&forecast_days=${forecastDays}&models=${SITE.openmeteo.model}`;
    return parseForecast(await getJSON(url, { lane: 'om', source: 'forecast' }));
  }

  /** CAMS Europe background (critic §4.1 D9): [{t, no2, o3, pm10, pm25}], hour-ending means, µg/m³. */
  async function cams(opts = {}) {
    const { pastDays = 14, forecastDays = 3 } = opts;
    const url = `${SITE.openmeteo.air_quality}?latitude=${data_LAT}&longitude=${data_LON}&hourly=${SITE.openmeteo.air_quality_hourly.join(',')}`
      + `&domains=${SITE.openmeteo.air_quality_domain}&past_days=${pastDays}&forecast_days=${forecastDays}&timezone=GMT`;
    return parseCams(await getJSON(url, { lane: 'om', source: 'cams' }));
  }

  /**
   * Bias ratios for CAMS (physics §11.4, Eq. 11.1): r_p = Σ C_obs / Σ C_CAMS over the hours of the last 14 days
   * where both ZAGREB-4 and CAMS have a value. NOx has no usable CAMS field (CAMS NO is near zero, physics
   * §11.4), so the NOx background is NO2_bg × the observed ZAGREB-4 NOx/NO2 ratio of the same window.
   * Returns {no2, o3, pm10, pm25, nox_no2, n: {p: pairs}, source: {p: 'live'|'default'}}.
   */
  function biasRatios(camsRows, z4long) {
    const out = { n: {}, source: {} };
    const byT = new Map((camsRows || []).map((r) => [r.t, r]));
    for (const p of ['no2', 'o3', 'pm10', 'pm25']) {
      let so = 0, sm = 0, n = 0;
      for (const o of (z4long && z4long[p]) || []) {
        const c = byT.get(o.t);
        if (c && Number.isFinite(c[p]) && c[p] > 0 && Number.isFinite(o.v)) { so += o.v; sm += c[p]; n++; }
      }
      const live = n >= data_MIN_PAIRS && sm > 0;
      out[p] = live ? so / sm : data_CAMS_RATIO_2025[p];
      out.n[p] = n;
      out.source[p] = live ? 'live' : 'default';
    }
    const nox = new Map(((z4long && z4long.nox) || []).map((r) => [r.t, r.v]));
    let sn = 0, s2 = 0, n2 = 0;
    for (const o of (z4long && z4long.no2) || []) {
      const v = nox.get(o.t);
      if (Number.isFinite(v) && Number.isFinite(o.v)) { sn += v; s2 += o.v; n2++; }
    }
    const live = n2 >= data_MIN_PAIRS && s2 > 0;
    out.nox_no2 = live ? sn / s2 : data_NOX_NO2_Z4_2025;
    out.n.nox_no2 = n2;
    out.source.nox_no2 = live ? 'live' : 'default';
    return out;
  }

  return {
    iszz, recent, eaqi, forecast, cams, biasRatios, status,
    // for tests and diagnostics
    _parseIszz: parseIszz, _parseForecast: parseForecast, _parseCams: parseCams, _getJSON: getJSON,
    _setFetch(fn) { fetchImpl = fn; cache.clear(); },
    _clearCache() { cache.clear(); },
    Z1_KEYS, Z4_KEYS,
  };
})();
