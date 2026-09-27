# ISZZ air-quality data API: reference for station ZAGREB-1 (ISZZ id 155)

Portal: **Kvaliteta zraka u Republici Hrvatskoj** (ISZZ). The Ministry of Environmental Protection and Green Transition (MZOZT) runs it at <https://iszz.azo.hr/iskzl/>.
Operator of the ZAGREB-1 station: **DHMZ** (Državni hidrometeorološki zavod), state network ("Državna mreža za trajno praćenje kvalitete zraka").

Everything in this document was **tested on 2026-09-27** from a Linux host using Python 3.12 and curl, unless it is marked otherwise.
Local copies of every artefact are under `research/data/` (see §13).

---

## 0. TL;DR for the fetcher

| Fact | Value (tested) |
|---|---|
| Public data endpoint | `GET https://iszz.azo.hr/iskzl/rs/podatak/export/json?postaja=155&polutant=<code>&tipPodatka=<type>&vrijemeOd=dd.MM.yyyy&vrijemeDo=dd.MM.yyyy` (also `/export/xml`) |
| Auth / cookies / headers | None required. Any User-Agent works, including Python-urllib. CORS header `Access-Control-Allow-Origin: *` is set, so a browser app can call it directly. |
| **Hard cap** | **1000 records per response.** Extra rows are dropped silently: you get the first 1000 in ascending time order and no error. Hourly data therefore has to be requested in chunks of 41 days or less. A calendar month is at most 744 rows. |
| **Rate limit** | About **1 accepted request per second** across `/export/json` and `/export/xml` combined. Excess requests get `HTTP 429`, `text/plain`, body `Too many requests`, and **no `Retry-After` header**. The limit is shared: it looks per-IP or global, because a request after 10 s of idle time can still be refused when another client uses the same egress IP. `/frm/*`, `/podatak/data`, `/podatak/rawd` and `/eaqi/*` did not return 429 in testing. |
| Latency | 0.03–0.15 s per export call (1 month of hourly data is about 52 kB). |
| `vrijeme` (JSON) | Epoch **milliseconds, a correct UTC instant**. The XML variant gives the same instant as local ISO time, e.g. `2026-09-26T20:00:00+02:00`. |
| Hour convention | **Hour-ending.** A value stamped 20:00 local is the mean over 19:00–20:00 local. This was checked 100 % against meteo.hr and EEA E2a data (§4). |
| Date window | `vrijemeOd=D1&vrijemeDo=D2` returns hourly slots **D1 01:00 … (D2+1) 00:00 local**, i.e. whole local days in the 1:00–24:00 convention. |
| Daily / monthly types | Stamped at **00:00 local at the START** of the day (or month). This is the opposite of the hourly types. |
| Missing data | **Raw types:** missing rows are simply absent. **Validated types:** there is a row for *every* hour, and invalid or missing hours carry the **sentinel `vrijednost = -999`**. Filter out values ≤ −900. In 2023–2025 this affected NO2 1719, NOx 1715, SO2 2213, CO 2532, benzene 4090, PM10 377 and PM2.5 152 rows. `[]` means no data **or** unknown station, pollutant or type. |
| Negative values | Small negatives are kept as delivered: instrument noise near zero. Raw SO2 has 2635 of 30 587 values below 0. **Raw CO** has 3886 negative and 10 385 exactly 0.0, because it is 1-dp in mg/m3 with an uncorrected zero offset. Validated CO is fine (about 0.1 mg/m3, 3 dp). |
| Bad date format | `HTTP 204 No Content` with an empty body (e.g. ISO `2026-09-20`). |
| Precision | Raw hourly values are rounded to **1 decimal**. Validated hourly, daily and derived values have **3 decimals**. |
| Validation lag | Validated hourly data (`tipPodatka=1`) exists up to **2025-12-31 24:00**. 2026 is raw-only. Validated data are published yearly. |
| TLS | TLS 1.3, DigiCert wildcard `*.azo.hr` valid until 2027-01-27, standard CA chain with no issues. `http://` returns 302 to `https://`. |

---

## 1. Station ZAGREB-1: identity and metadata

| Field | Value | Source |
|---|---|---|
| ISZZ internal id (`postaja`) | **155** | `/rs/podatak/frm/gg` |
| Name | ZAGREB-1 (meteo.hr: "Zagreb 1") | ISZZ, DHMZ |
| National code | `ZAG001` | `/rs/postaja/pkod` |
| Station code (ISZZ/eReporting) | **`RH0101`** | `/rs/postaja/pkod`, `/rs/eaqi/indeks` |
| EEA EoI code (AirBase / e-Reporting) | **`HR0007A`**, EEA station id `HR_DOC_TYPE_D_STA_RH0101` | `/rs/postaja/pkod`, EEA metadata CSV |
| Classification | **Urban ("Gradska"), traffic ("Prometna")** | `/rs/postaja/eMetaList`, `/rs/eaqi/indeks`, EEA (`traffic` / `urban`) |
| Zone | Aglomeracija Zagreb (`zonaId` 4) | `/rs/eaqi/indeks` |
| Coordinates (ISZZ) | **45.800492 N, 15.974278 E**; 45°48'01.77" N, 15°58'27.40" E; Gauss-Krüger x=5 073 379, y=5 576 105 | `/rs/postaja/koordinate` |
| Coordinates (DHMZ page) | 45.800496 N, 15.97422 E | meteo.hr |
| Coordinates (EEA) | 45.800339 N, 15.974072 E (about 18 m from the ISZZ position) | EEA PanEuropean_metadata.csv |
| Altitude | **113 m** a.s.l. (ISZZ "Gauss.h"; EEA lists 0 = not reported) | `/rs/postaja/koordinate` |
| Address | "Raskrižje Sarajevske ulice i Kauzlarićevog prolaza" (DHMZ text, last edited 2017). **Check this:** in the OSM data under `research/data/osm_*`, the roads nearest to the ISZZ coordinates are **Miramarska cesta** (N–S, 4–6 lanes, about 18 m) and **Ulica grada Vukovara** (E–W, about 42 m). The EEA kerb distance of 9 m fits Miramarska. | meteo.hr, OSM |
| **Sampling inlet height** | **4 m** above ground for the automatic analysers (NO2/NOx, SO2, CO, benzene, PM10). Building distance 0 m, **kerb distance 9 m**. For the manual active samplers (heavy metals and PAH in PM10) EEA records inlet 0 (unknown), building 30 m, kerb 5 m. | EEA PanEuropean_metadata.csv (file dated 2024-03-11) |
| Instruments (EEA metadata, as of 2022) | Horiba APNA-360 (NO/NO2/NOx), Horiba APSA-360 (SO2), Horiba APMA-360 (CO), Airmo VOC BTX (benzene). PM10/PM2.5 are measured by an automatic analyser since 13.01.2023, plus gravimetric PM10. | EEA metadata, `/rs/postaja/eMetaList` |
| eReporting start | 11.02.2003 (gases, automatic PM10); 01.01.2005 (gravimetric PM10 and metals); 13.01.2023 (new automatic PM10/PM2.5) | `/rs/postaja/eMetaList` |
| EEA sampling points | NO2 `SPO_402`, NOx `SPO_401`, SO2 `SPO_403`, CO `SPO_405`, benzene `SPO_648`, PM10 `SPO_1075` (auto, 2023+) and `SPO_649` (gravimetric); `SPO_682..696` metals/PAH; `SPO_713` Hg | EEA metadata |
| Timezone used in EEA reporting | `UTC+01` (fixed) | EEA metadata |

Measured at the site but **not available in ISZZ** (meteo.hr only, last 24 h): NO, toluene, ethylbenzene, m,p-xylene, PM1. See §8.
Listed by DHMZ but **not measured now**: O3 and "UV zračenje – direktno". They have no link on meteo.hr, are absent from ISZZ for 155, and are absent from the weekly status sheet.

---

## 2. Endpoint reference

Base: `https://iszz.azo.hr/iskzl/rs`. The site's full REST map is in `https://iszz.azo.hr/iskzl/js/data.js` (local copy `scratchpad/data.js`). About 300 routes exist; most are admin or eReporting routes that need a login (403).

| Endpoint | Anonymous? | Rate-limited? | 1000 cap? | What it returns | Useful? |
|---|---|---|---|---|---|
| `GET /podatak/export/json?postaja&polutant&tipPodatka&vrijemeOd&vrijemeDo[&test=true]` | yes | **yes (~1/s)** | **yes** | `[{"vrijednost":48.1,"mjernaJedinica":"µg/m3","vrijeme":1789858800000}, …]`. `test=true` limits the result to 10 rows. | **Primary data source** (documented service) |
| `GET /podatak/export/xml?…` (same params) | yes | yes (shares the json limiter) | yes | `<collection><Podatak><vrijednost>1.4</vrijednost><mjernaJedinica>µg/m3</mjernaJedinica><vrijeme>2026-09-26T01:00:00+02:00</vrijeme></Podatak>…` | Alternative. Gives local ISO timestamps. |
| `GET /podatak/frm/gg?t=false&i=false` | yes | no | – | Form metadata: `options[0]` stations `[id,name]`, `options[1]` pollutants `[code,name(unit)]`, `options[2]` data types `[id,name]`, `data` = valid `[station,pollutant,type]` triples (2453 rows) | **Yes.** Discovery and validation of codes. `t=true` gives the 187 gravimetric/indicative triples; `i=true` gives nothing. |
| `GET /podatak/frm/gm` | yes | no | – | Same shape, meteo parameters only (475/477/478/479, type 0) | yes |
| `GET /podatak/data?postaja&polutant&tipPodatka&vrijemeOd&vrijemeDo` | yes | no (not observed) | no (5 years in 6.9 s, 330 kB) | Table view: `data` = rows `[date, "h1".."h24"]` with **decimal-comma strings**; `minDate`/`minDateStr` (**first date with data**); `extData` = `{prosjek (mean), maksimum, najduziPrekid (longest gap, h), predvalidiranost, pokrivenost (coverage %)}`; `markerTypes` (1 alert threshold, 3 limit value), `flags`, `valid`, `corrections` | **Yes, for metadata**: first date and per-period coverage in one call. Column headers are literally `1:00 … 24:00`, which confirms the hour-ending convention. |
| `GET /podatak/data1?…` | yes | no | no | Long form `[date, "H:00", "value,with,comma"]` including null slots | meh |
| `GET /podatak/rawd?postaja&polutant&tipPodatka&vrijemeOd&vrijemeDo` | yes | no | **no** | **Complete hourly grid with nulls**: `[ms, 0, recordId, 0, value(3 dp)\|null, null, predvalidiran(bool), -1, null, x]` (col 9 is a derived value of unclear meaning). Window = **[D1 00:00, D2 00:00] local, inclusive**, e.g. one day gives 1 row. | Bulk alternative (1 year of NO2 in 6.8 s / 520 kB; **5 years in 155 s**). Undocumented, so use sparingly. |
| `GET /podatak/cdata?postaja&polutant&tipPodatka&vrijemeOd&vrijemeDo` | yes (404 if `t`/`i` params are added) | no | ? | Google-Charts JSON (`"new Date(ms)"` strings) | no |
| `GET /postaja/koordinate` | yes | no | – | All stations: network, name, Gauss x/y/h, DMS, decimal lat/lon (decimal comma) | yes (station geo) |
| `GET /postaja/pkod` | yes | no | – | `[name, national code, station code, EoI code]` | yes (codes) |
| `GET /postaja/eMetaList` | yes | no | – | Per station and pollutant: codes, zone, area type, station type, measurement type, sampling duration, start date (167 kB) | yes (classification) |
| `GET /postaja/mp` | yes | no | – | Meteo parameter dictionary (names, units, ISO codes) | minor |
| `GET /mreza/list?d=0` / `list/all` | yes | no | – | Networks (id, name, owner, county) | minor |
| `GET /map/indeks` | yes | no | – | All stations with lat/lon, network, type flags | minor |
| `GET /eaqi/indeks?h=0` | yes | no | – | **Current EAQI** per station: `{id:155, kod:"RH0101", indeks:0..6, vrijeme, tipPodrucja:"Gradska", tipPostaje:"Prometna", brojTvari, brojTvariZaIndeks, …}` | **Yes, for a live badge** |
| `GET /eaqi/tvari?p=155&h=0` | yes | no | – | Current sub-index: `[["NO₂",null,null],["SO₂",…],["PM₁₀",33.761,2],["PM₂.₅",20.93,3]]` = [pollutant, concentration, band 0..6] | yes |
| `GET /eaqi/7?p=155&h=0` | yes | no | – | Last 7 days (~190 h): `tvari` = [O3, PM2.5, NO2, SO2, PM10]; each row has `vrijednost` = 10 numbers = (concentration, normalised 0–100) pairs. PM uses 24-h running means. | yes (sparkline) |
| `GET /eaqi/100?p=155&h=0` | yes | no | – | Counts per index class `[[class,count],…]`. The counts sum to 366, which suggests a daily index over the last year (drawn as a pie chart on the portal). | minor |
| `GET /prognoza/list` | yes | no | – | Forecast availability for no2/o3/pm10/pm25: today, tomorrow, the day after | yes |
| `GET /iskzl/prog_data.kmz?t=no2&d=0&v=dd.MM.yyyy` (not under `/rs`) | yes | no | – | **Gridded daily forecast** as KMZ (≈6 km cells, 405 polygons, description "Dobro<br/>2 µg/m³") | Nice-to-have: background-concentration forecast |
| `GET /statusRadaPostaja/simpleList` + `GET /iskzl/datoteka?id=<id without dot>` | yes | no | – | Weekly "station instrument status" XLSX. Status is encoded as cell colour only. | low |
| `GET /obavijestpos/simpleList?d=1` | yes | no | – | **2.6 MB** JSON of all station notices (outages, calibrations). 109 mention ZAGREB-1. | Yes, for explaining gaps (fields `postajaNaslov`, `tekst`, `vrijemeOd`) |
| `GET /drwReport/filterParams` | yes | no | – | Years × pollutant × data type × exceedance-type tree | minor |
| `GET /agg/aei?p=155&lang=hrv` | yes | no | – | National PM2.5 average exposure indicator table (not station-specific) | no |
| `/agg/data`, `/agg/sgv`, `/podatak/pos/data` | yes | no | – | `{"status":"error"}` with naive params. They need exact form params; not pursued. | no |
| `/pokZ/z1/frm`, `/polutant/*`, `/kofekcijskiFaktor/*`, admin | **403** | – | – | Login required | no |

Documentation: `https://iszz.azo.hr/iskzl/doc/servis_uputa.pdf` ("Uputa za dohvat podataka putem RESTful servisa", 16 pages, lists station and pollutant ids). **The JSON example in that PDF is outdated.** It shows `[{"Podatak":{…,"vrijeme":"2016-08-10T01:00:00+02:00"}}]`, but the live service returns flat objects with epoch-ms `vrijeme`. The prototype parser accepts both.

---

## 3. Export service in detail (`/podatak/export/json|xml`)

### 3.1 Parameters

| Param | Required | Format | Notes (tested) |
|---|---|---|---|
| `postaja` | yes | int | 155 = ZAGREB-1. An unknown id returns `[]`. |
| `polutant` | yes | int | See §6. Unknown or not-measured codes return `[]`. |
| `tipPodatka` | effectively yes | int (0–18) | If omitted, the server returns **raw hourly** (type 0). Always send it. |
| `vrijemeOd` | yes | `dd.MM.yyyy` | `1.9.2026` also works. A trailing time (`26.09.2026 12:00`) is **ignored**, so whole days only. ISO `yyyy-MM-dd` gives **HTTP 204**. |
| `vrijemeDo` | yes | `dd.MM.yyyy` | Inclusive local day. If missing, the result is `[]`. If `vrijemeOd > vrijemeDo`, the result is `[]`. Future dates give `[]`. |
| `test` | no | `true` | Returns the first 10 rows only. This is the "Test" button on `exc.htm`. |

No paging, offset or limit parameters exist. The only way around the 1000-row cap is to split the date range.

### 3.2 Max range and timing (NO2, type 0)

| Requested range | HTTP | Time | Bytes | Rows returned | Last row |
|---|---|---|---|---|---|
| 1 month (Aug 2026) | 200 | 0.07 s | 51 980 | 743 (of 744; 1 missing hour) | 2026-09-01 00:00+02 |
| 1 year (2025) | 200 | 0.08 s | 69 909 | **1000 (truncated)** | 2025-02-11 16:00+01 |
| 5 years (2021–2025) | 200 | 0.10 s | 69 916 | **1000 (truncated)** | 2021-02-13 10:00+01 |
| 16+ years (2010–2026) | 200 | 0.14 s | 70 893 | **1000 (truncated)**, starting at the first available row, 2011-08-29 10:00 | 2011-10-13 |
| XML, 1 year | 200 | – | 129 988 | **1000 (truncated)** | – |

**Rule:** request at most 41 days of hourly data per call; calendar months are the natural unit. If a response has exactly 1000 rows, treat it as truncated and split the range. Daily types give 1000 days (about 2.7 years) per call.

### 3.3 Response shapes

JSON (`Content-Type: application/json`, UTF-8, `µ` = `C2 B5`):
```json
[{"vrijednost":1.1,"mjernaJedinica":"µg/m3","vrijeme":1790445600000},
 {"vrijednost":1.4,"mjernaJedinica":"µg/m3","vrijeme":1790449200000}]
```
XML (`application/xml`):
```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?><collection><Podatak><vrijednost>1.4</vrijednost>
<mjernaJedinica>µg/m3</mjernaJedinica><vrijeme>2026-09-26T01:00:00+02:00</vrijeme></Podatak>…</collection>
```
Units come as returned: `µg/m3`, `mg/m3` (CO), `ng/m3` (metals, PAH), `m/s`, `%`, wind direction as `degrees` and temperature as `degrees Celzius`. The prototype normalises the last two to `°` and `°C`.

### 3.4 Errors and edge cases

| Case | Result |
|---|---|
| No data in range, unknown station, pollutant not measured | `200 []` |
| Bad date format | `204` with an empty body |
| Too fast | `429 text/plain "Too many requests"` |
| Unknown sub-route | `404` JBoss HTML error page |
| Login-only route | `403` JBoss HTML error page |

---

## 4. Time semantics (verified)

1. **`vrijeme` is a true UTC instant.** Benzene on 26.09.2026 is `1790445600000` = 18:00Z = **20:00 CEST**, value 1.1. meteo.hr shows "26.9.2026. 20:00 (lokalno) 1.12". The next hour is 21:00 CEST: 1.4 in ISZZ and 1.36 on meteo.hr. The gap at 27.09 03:00 local is present in both.
2. **Independent check against EEA E2a** (EEA download API, sampling point `HR_DOC_TYPE_D_SPO_402`, NO2, 2026-01-01…2026-09-27, whose `End` field is in fixed UTC+01). For **6296 of 6296** hours, `ISZZ vrijeme (UTC) + 1 h == EEA End (UTC+01)` with identical values, in both summer (4237/4237) and winter (1404/1404). Other offsets match below 1 %. So ISZZ handles CET/CEST correctly and **timestamps mark the END of the averaging hour**.
3. **Hour-ending, 1:00…24:00 convention.** `/podatak/data` column headers are literally `1:00 … 24:00`. `vrijemeOd=01.08.2026&vrijemeDo=31.08.2026` returns 2026-08-01 01:00+02 … 2026-09-01 00:00+02, where the 00:00 value is "31.08. 24:00". Convert to the interval as **[t − 1 h, t)**.
4. **DST transitions.** The backend stores naive local wall-clock hours.
   - Spring (30.03.2025) gives **23 values**; 02:00 does not exist. `/rawd` shows a `null` placeholder that is serialised as a duplicate 03:00+02.
   - Autumn (26.10.2025) gives **24 values for a 25-hour day**. The first 02:00 (CEST) slot is missing: 01:00+02 is followed by 02:00+01. Record ids are consecutive, so one real hour per year is lost at source. Never expect 25 values.
5. **Daily types (4/5/16/17) and max-daily-8h (10/11)** carry `00:00 local` **of the day itself** (start-of-day label, e.g. `2026-09-20T00:00+02:00` = mean of 20.09.). **12-month types (12/13)** carry 00:00 on the 1st of each month. **8-h (2/3)** and **24-h running (18)** types are hourly-updated running means stamped hour-ending.
6. **`/podatak/rawd`** uses a different window, [D1 00:00, D2 00:00] inclusive, so it includes the previous day's 24:00 value. The export uses (D1 00:00, D2 24:00].
7. **Latency.** At 21:38 local the newest value was hour-ending 20:00, so data lag about 1–2 h. meteo.hr shows "Zadnja izmjena 20:50".

Prototype output convention: `timestamp_utc` = ISO-8601 `…Z` of the **end** of the hour. For display, convert to Europe/Zagreb. For wind-field forcing at hour *t*, use the value stamped *t + 1 h* or the average of the neighbouring values.

---

## 5. Data types (`tipPodatka`)

| id | Name (HR) | Meaning | Timestamp |
|---|---|---|---|
| 0 | Satni izvorni podaci | Hourly, raw (1 dp) | hour-ending |
| 1 | Satni validirani podaci | Hourly, validated (3 dp), yearly release | hour-ending |
| 2 / 3 | Osmosatni izvorni / validirani | 8-h running mean (CO) | hour-ending |
| 4 / 5 | Dnevni izvorni / validirani | Daily mean | 00:00 local, start of day |
| 10 / 11 | Maks. dnevne osmosatne sr. vrijednosti izv./val. | Max daily 8-h mean (CO) | 00:00 local |
| 12 / 13 | Dvanaestmjesečni prosjek izv./val. | 12-month running mean (benzene) | 00:00 on the 1st of the month |
| 16 / 17 | Dnevni izvorni / validirani – gravimetrija | Daily, gravimetric PM10 and metals/PAH in PM10 | 00:00 local |
| 18 | 24-satni izvorni podaci | 24-h running mean, hourly-updated (PM, used by EAQI) | hour-ending |

---

## 6. Parameters at station 155

**First date** = `minDateStr` from `/podatak/data` (type-specific). **Completeness** = ISZZ `pokrivenost` (% of hourly slots for hourly types, % of days for daily types), per calendar year. Source file: `research/data/station155_coverage.json`.

### 6.1 Hourly parameters (core for the app)

| Code | Param | Unit | Types | First data (raw t0 / validated t1) | Validated t1 coverage 2023 / 2024 / 2025 | Raw t0 coverage 2023 / 2024 / 2025 / 2026-ytd |
|---|---|---|---|---|---|---|
| 1 | NO2 | µg/m3 | 0,1,4,5 | 29.08.2011 / 01.01.2006 | 91.2 / 95.4 / 93.5 | 88.9 / 95.6 / 93.5 / 97.2 |
| 38 | NOx (as NO2) | µg/m3 | 0,1,4,5 | **01.01.2024** / 23.01.2012 | 91.2 / 95.4 / 93.5 | – / 95.5 / 93.5 / 97.2 |
| 2 | SO2 | µg/m3 | 0,1,4,5 | 17.03.2011 / 01.01.2006 | 88.6 / 95.1 / 90.9 | 89.2 / 96.2 / 91.6 / 97.2 |
| 3 | CO | **mg/m3** | 0,1,2,3,4,5,10,11 | 10.06.2011 / 01.01.2006 | 87.5 / 95.7 / 87.8 | 89.3 / 96.0 / 93.0 / 97.0 |
| 5 | PM10 (automatic) | µg/m3 | 0,1,4,5,18 (+16,17 grav.) | 17.03.2011 / 01.01.2006 | 92.0 / 97.4 / 98.3 | 89.5 / 96.6 / 98.2 / 96.4 |
| 28 | PM2.5 (automatic) | µg/m3 | 0,1,4,5,18 | 14.02.2023 / 13.01.2023 | 95.3 / **0.01** / 98.3 | 93.3 / 97.6 / 98.2 / 96.4 |
| 32 | Benzene | µg/m3 | 0,1,4,5,12,13 | 16.12.2011 / 01.01.2006 | 80.0 / 88.1 / 84.9 | 78.3 / 89.2 / 85.5 / 96.2 |
| 477 | Wind speed | m/s | 0 | 21.04.2016 | – | **0** / 89.3 / 98.2 / 97.3 |
| 478 | Wind direction | ° (from) | 0 | 21.04.2016 | – | **0** / 89.3 / 98.2 / 97.3 |
| 475 | Temperature | °C | 0 | 21.04.2016 | – | **0** / 83.9 / 99.3 / 97.3 |
| 479 | Relative humidity | % | 0 | 21.04.2016 | – | **0** / 83.9 / 99.3 / 97.3 |

Notable holes:
- **Meteo parameters have no data at all in 2023**; they restart in 2024.
- **Raw NOx only from 2024**; use validated data for earlier years.
- **Validated PM2.5 for 2024 was never published** (1 stray value); use raw.
- Benzene is the least complete series (78–89 %).
- 2026 validated data are empty, as expected.

### 6.2 Daily / low-frequency parameters

| Code | Param | Unit | Types | First data | Coverage (t17 validated) 2023 / 2024 / 2025 |
|---|---|---|---|---|---|
| 5 | PM10 gravimetric | µg/m3 | 16,17 | 01.01.2010 / 01.01.2009 | 94.5 / 100 / 100 |
| 30 | Pb in PM10 | µg/m3 | 17 | 01.01.2015 | 94.3 / 100 / 99.2 |
| 33 / 34 / 35 | Cd / As / Ni in PM10 | ng/m3 | 16,17 | 01.01.2009 | 94.3 / 100 / 99.2 |
| 80 | Benzo(a)pyrene in PM10 | ng/m3 | 16,17 | 01.01.2009 | 94.5 / 100 / 97.0 |
| 280, 283, 285, 287, 291, 295 | Other PAH in PM10 | ng/m3 | 16,17 (295: 17) | 2009 (295: 2018) | 94.5 / 100 / 97.0 |
| 244 | Total gaseous Hg | ng/m3 | 5 | 01.01.2013 | 0 / 0 / 0 (discontinued) |

Gravimetric and metal results are released only after lab analysis, so none exist yet for 2026 and they are not useful in real time.

### 6.3 Measured at the site but not in ISZZ

The ISZZ form lists no NO (code 196), O3 (31), toluene (60), ethylbenzene (61), m,p-xylene (62), o-xylene (63), PM1 (70), black carbon (201) or UV-B (476) for station 155. Querying the export directly with those codes returns `[]`. The only source is **meteo.hr (DHMZ), last 24 h, HTML**:

`https://meteo.hr/kvaliteta_zraka.php?section=podaci_kz&post=Zagreb%201&id_komp=<id>&komp=<name>`

| meteo.hr `id_komp` | Param | In ISZZ? |
|---|---|---|
| 256 | SO2 | yes (2) |
| 257 | NO2 | yes (1) |
| 258 | PM10 | yes (5) |
| 259 | PM2.5 | yes (28) |
| 263 | benzene | yes (32) |
| 264 | CO | yes (3) |
| 270 | NOx | yes (38) |
| **292** | **toluene** | **no** |
| **293** | **ethylbenzene** | **no** |
| **294** | **m,p-xylene** | **no** |
| **302** | **PM1** | **no** |
| **319** | **NO** | **no** |
| 352 / 353 / 355 / 359 | wind speed / direction / temperature / RH | yes (477 / 478 / 475 / 479) |

The page is about 70 kB of HTML. Each row is `<td>26.9.2026.  21:00</td><td>21.06</td>`: local time, hour-ending, 2 decimals, raw data, 23–24 rows. A simple regex parser works (tested for 319, 292, 302, 293, 294). DHMZ's "XML za korisnike" list has **no air-quality feeds**, and DHMZ points to ISZZ for archives. To keep NO, BTEX or PM1 history, poll meteo.hr at most **once per hour** and archive the rows. Alternatively, derive NO ≈ (NOx − NO2)·(30/46) from ISZZ NOx and NO2, both in µg/m3 as NO2.

---

## 7. Limits, politeness, headers, SSL

- **Measured limiter** (`/podatak/export/json` and `/xml` share it):
  - 8 requests back-to-back: 1 × 200, 7 × 429.
  - 0.5 s spacing: every second request is refused.
  - 0.9 s spacing: requests alternate between 200 and 429.
  - 1.0 s spacing: 7/8 accepted.
  - 1.5 s spacing: 5/6 accepted. The first request after a pause was refused, because other agents on the same IP were fetching at the same time.
  - The limiter counts accepted requests, and rejected ones do not extend the window. The window is about 1 s.
- **Recommended client behaviour** (implemented in the prototype):
  - At least **1.1 s between requests**.
  - On 429, sleep 1–2 s with jitter and retry, with no retry cap below about 60.
  - Exponential backoff on 5xx and network errors.
  - Month chunks with an on-disk cache.
  - Never run more than one fetcher in parallel from the same IP.
  - A full 2023-01…2026-09 download (11 params, raw and validated) is about 810 requests and takes about 15 minutes.
- `/podatak/rawd` is not rate-limited, but a 5-year query kept the server busy for 155 s. Do not hammer it. Use at most one year per call and one call at a time.
- Headers: nothing special is needed. A descriptive `User-Agent` is polite. The server sets an F5 BIG-IP cookie (`TS01…`) and `JSESSIONID`; neither is needed.
- CORS: `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Methods: GET, HEAD, OPTIONS, POST, PUT`. The browser UI can fetch live data directly. Each viewer's browser then hits the limiter from its own IP, so debounce requests.
- SSL: valid chain (DigiCert Global G2 TLS RSA SHA256 2020 CA1, `*.azo.hr`, valid until 27.01.2027, TLS 1.3). Python's default `ssl` context works without `verify=False`.
- Terms: the portal does not publish API terms or limits. Data are public government data. Attribute as "Izvor: Ministarstvo zaštite okoliša i zelene tranzicije – Kvaliteta zraka u RH (iszz.azo.hr); mjerenja DHMZ".

---

## 8. Alternative and complementary sources

| Source | What | Access | Notes |
|---|---|---|---|
| meteo.hr `kvaliteta_zraka.php` | Last 24 h, all ZAGREB-1 params including NO, toluene, ethylbenzene, m,p-xylene, PM1 | HTML scrape | Local time, hour-ending, 2 dp |
| EEA Air Quality Download Service | E2a (up-to-date, unverified) and E1a (verified) for HR0007A | `POST https://eeadmz1-downloads-api-appservice.azurewebsites.net/ParquetFile/urls` with `{"countries":["HR"],"cities":[],"pollutants":["NO2"],"dataset":1,"source":"API","dateTimeStart":"…Z","dateTimeEnd":"…Z","aggregationType":"hour"}` returns Parquet URLs such as `…/airquality-p/HR/HR_DOC_TYPE_D_SPO_402.parquet` | Needs pyarrow (not stdlib). Times are fixed UTC+01 in `Start`/`End`. Values are identical to ISZZ. A good cross-check or backup. |
| EEA PanEuropean_metadata.csv | Sampling-point metadata (inlet height, kerb distance, equipment) | `https://discomap.eea.europa.eu/map/fme/metadata/PanEuropean_metadata.csv` (27 MB, TSV) | File dated 2024-03 |
| ISZZ forecast KMZ | Daily gridded forecast for NO2/O3/PM10/PM2.5, today to the day after tomorrow | `https://iszz.azo.hr/iskzl/prog_data.kmz?t=no2&d=0&v=27.09.2026` | Can drive "background" concentration in the app |

---

## 9. Thresholds for UI colouring

### 9.1 Limit, target and guideline values (µg/m3 unless noted)

| Pollutant | Averaging | EU 2008/50/EC = AAQD 2024/2881 Annex I Table 2 (**valid now, until 2029**) = HR NN 77/2020 | **EU AAQD 2024/2881 from 1.1.2030** (Table 1) | **WHO AQG 2021** |
|---|---|---|---|---|
| NO2 | 1 h | 200, max 18 exceedances per year | 200, max 3 per year | (200, 2005 AQG retained) |
| NO2 | 24 h | – | 50, max 18 per year | **25** (99th percentile) |
| NO2 | year | 40 | **20** | **10** |
| PM10 | 24 h | 50, max 35 per year | **45, max 18 per year** | **45** (99th percentile) |
| PM10 | year | 40 | **20** | **15** |
| PM2.5 | 24 h | – | **25, max 18 per year** | **15** (99th percentile) |
| PM2.5 | year | 25 (EU); **HR: 20 from 1.1.2020** ("2. stupanj") | **10** | **5** |
| SO2 | 1 h | 350, max 24 per year | 350, max 3 per year | – (500 over 10 min, 2005 AQG) |
| SO2 | 24 h | 125, max 3 per year | **50, max 18 per year** | **40** |
| SO2 | year | – | 20 | – |
| CO | max daily 8-h mean | 10 mg/m3 | 10 mg/m3 | (10 mg/m3 8 h; 35 mg/m3 1 h; 100 mg/m3 15 min, 2000 AQG) |
| CO | 24 h | – | **4 mg/m3, max 18 per year** | **4 mg/m3** |
| Benzene | year | 5 | **3.4** | no safe level (1.7 µg/m3 ≈ 1:100 000 lifetime risk; equals the AAQD assessment threshold) |
| O3 | max daily 8-h mean | target 120 on no more than 25 days per year (3-year average) | target 120 on no more than 18 days per year; long-term objective 100 (99th percentile) by 2050 | **100** (8 h, 99th percentile); **60** peak-season mean |
| BaP (in PM10) | year | target 1 ng/m3 | limit 1.0 ng/m3 | – |
| Pb / As / Cd / Ni (in PM10) | year | 0.5 µg/m3 / 6 / 5 / 20 ng/m3 (As, Cd, Ni are target values) | 0.5 µg/m3 / 6.0 / 5.0 / 20 ng/m3 (all become limit values) | – |

### 9.2 Information and alert thresholds

| Pollutant | HR NN 77/2020 (in force now) | EU AAQD 2024/2881 (to be transposed by 11.12.2026) |
|---|---|---|
| SO2 | **alert 500** (1 h, 3 consecutive hours) | information **275** (1 h); alert **350** (1 h, 3 consecutive hours) |
| NO2 | **alert 400** (1 h, 3 consecutive hours) | information **150** (1 h); alert **200** (1 h, 3 consecutive hours) |
| PM10 | – | information **90** (daily); alert **90** (daily, 3 consecutive days or fewer) |
| PM2.5 | – | information **50** (daily); alert **50** (daily, 3 consecutive days or fewer) |
| O3 | information 180 (1 h); alert 240 (1 h) | information 180 (1 h); alert 240 (1 h) |

ISZZ's `/podatak/data` itself flags cells against "Prag upozorenja" (alert threshold, markerType 1) and "Granična vrijednost" (limit value, markerType 3).

### 9.3 European Air Quality Index bands (hourly concentration, µg/m3)

**Revised EEA EAQI (ETC HE Report 2024/17, live on airindex.eea.europa.eu).** Use this for new UIs.

| Band | PM2.5 | PM10 | NO2 | O3 | SO2 | Colour (EEA) |
|---|---|---|---|---|---|---|
| 1 Good | 0–5 | 0–15 | 0–10 | 0–60 | 0–20 | `#50F0E6` |
| 2 Fair | 5–15 | 15–45 | 10–25 | 60–100 | 20–40 | `#50CCAA` |
| 3 Moderate | 15–50 | 45–120 | 25–60 | 100–120 | 40–125 | `#F0E641` |
| 4 Poor | 50–90 | 120–195 | 60–100 | 120–160 | 125–190 | `#FF5050` |
| 5 Very poor | 90–140 | 195–270 | 100–150 | 160–180 | 190–275 | `#960032` |
| 6 Extremely poor | >140 | >270 | >150 | >180 | >275 | `#7D2181` |

**Legacy EAQI bands, which ISZZ still uses** (`/eaqi/*`, verified: 190/190 normalised values in `/eaqi/7` for station 155 match these bands and 0/190 match the revised ones). ISZZ computes PM from 24-h running means (type 18) and NO2/SO2/O3 from hourly values.

| Band | PM2.5 | PM10 | NO2 | O3 | SO2 | ISZZ colour |
|---|---|---|---|---|---|---|
| 1 Dobro / Good | 0–10 | 0–20 | 0–40 | 0–50 | 0–100 | `#55EFE5` |
| 2 Prihvatljivo / Fair | 10–20 | 20–40 | 40–90 | 50–100 | 100–200 | `#54CAAA` |
| 3 Umjereno / Moderate | 20–25 | 40–50 | 90–120 | 100–130 | 200–350 | `#EFE558` |
| 4 Loše / Poor | 25–50 | 50–100 | 120–230 | 130–240 | 350–500 | `#FE5355` |
| 5 Vrlo loše / Very poor | 50–75 | 100–150 | 230–340 | 240–380 | 500–750 | `#940D36` |
| 6 Izuzetno loše / Extremely poor | 75–800 | 150–1200 | 340–1000 | 380–800 | 750–1250 | `#7D2181` |
| 0 no data | | | | | | `#6F6F6F` |

Recommendation for the UI: a toggle between "EEA 2024 index" (default) and "ISZZ index" (matches the official Croatian portal). CO and benzene are not part of the EAQI. Colour them against the limit value (CO 10 mg/m3 8-h; benzene 5, or 3.4 from 2030, annual) using a sequential ramp, not the index colours.

---

## 10. Prototype fetcher and results

File: `research/fetch_iszz_proto.py` (Python 3.12, stdlib only).

- Calendar-month chunking, with automatic split if a response reaches the 1000-row cap.
- 1.1 s pacing, 429 retry with jitter, 5xx and network backoff.
- Atomic JSON cache per chunk (`data/cache_iszz/155/p<code>_t<type>_<from>_<to>.json`). A chunk is final 3 days after its end. Empty validated chunks are re-checked after 30 days, because yearly validation arrives later.
- Station capabilities come from `/frm/gg`, so types the station does not offer are never requested.
- Drops the validated-series sentinel `-999`. Small negative values are kept unless `--drop-negative` is given.
- Modes: `merged` (default: validated per calendar year when it has at least 50 % of the raw count, otherwise raw), `raw`, `validated`, `both`.
- CSV columns: `timestamp_utc,param,value,unit,data_type`. The first four match the spec. `data_type` is `raw` or `validated`.
- A completeness report per param and year goes to stdout and to `<out>.completeness.json`.
- Useful flags: `--list-params`, `--dry-run`, `--params no2,pm10,477`, `--station`.

Command that was run:
```
python3 fetch_iszz_proto.py --start 2023-01-01 --end 2026-09-27 --out data/zagreb1_hourly.csv
```

**Output:** `research/data/zagreb1_hourly.csv` has **303 850 rows** and is 13.7 MB. The completeness report is in `zagreb1_hourly.completeness.json`.

The first download pass made **823 HTTP requests for 810 month-chunks** in about 15 min, with only 13 × 429 responses and 1 transient network error. Re-runs from the cache take 5 s.

The fetcher dropped these −999 sentinel rows from the validated series: NO2 1719, NOx 1715, PM10 377, PM2.5 152, SO2 2213, CO 2532, benzene 4090.

Completeness is rows divided by the expected hour-ending slots in the local calendar year. For 2026 the period is 1 Jan – 27 Sep 20:00. V means the validated series was used for that year; R means raw.

| param | 2023 | 2024 | 2025 | 2026 (ytd) | total rows | total % | first row (UTC) |
|---|---|---|---|---|---|---|---|
| no2 | 8009 · 91.4 % V | 8384 · 95.4 % V | 8189 · 93.5 % V | 6297 · 97.2 % R | 30 879 | 94.2 | 2023-01-13T12Z |
| nox | 8009 · 91.4 % V | 8388 · 95.5 % V | 8189 · 93.5 % V | 6297 · 97.2 % R | 30 883 | 94.2 | 2023-01-13T12Z |
| pm10 | 8063 · 92.0 % V | 8558 · 97.4 % V | 8607 · 98.3 % V | 6244 · 96.4 % R | 31 472 | 96.0 | 2023-01-13T12Z |
| pm25 | 8063 · 92.0 % V | 8570 · 97.6 % **R** | 8607 · 98.3 % V | 6245 · 96.4 % R | 31 485 | 96.0 | 2023-01-13T12Z |
| so2 | 7778 · 88.8 % V | 8349 · 95.0 % V | 7961 · 90.9 % V | 6300 · 97.3 % R | 30 388 | 92.7 | 2023-01-15T12Z |
| co | 7668 · 87.5 % V | 8408 · 95.7 % V | 7693 · 87.8 % V | 6284 · 97.0 % R | 30 053 | 91.7 | 2023-01-31T13Z |
| benzene | 7041 · 80.4 % V | 7736 · 88.1 % V | 7434 · 84.9 % V | 6231 · 96.2 % R | 28 442 | 86.8 | 2023-01-31T16Z |
| ws | **0** | 7844 · 89.3 % R | 8607 · 98.3 % R | 6302 · 97.3 % R | 22 753 | 69.4 | 2024-01-31T15Z |
| wd | **0** | 7842 · 89.3 % R | 8607 · 98.3 % R | 6303 · 97.3 % R | 22 752 | 69.4 | 2024-01-31T15Z |
| t | **0** | 7366 · 83.9 % R | 8702 · 99.3 % R | 6303 · 97.3 % R | 22 371 | 68.2 | 2024-01-31T15Z |
| rh | **0** | 7367 · 83.9 % R | 8703 · 99.3 % R | 6302 · 97.3 % R | 22 372 | 68.3 | 2024-01-31T15Z |

The last row is 2026-09-27T18:00Z (20:00 CEST) for all series.

All series have no data 1–13 January 2023. This coincides with the new automatic PM analyser, which `eMetaList` dates to 13.01.2023. CO and benzene have no data until 31 January 2023. The meteo sensors returned only on 31 January 2024.

**Cross-check against the portal's own statistics.** The annual means computed from the CSV equal ISZZ's `/podatak/data` `prosjek` for the same series:

| Series | CSV mean | ISZZ `prosjek` |
|---|---|---|
| NO2 2025 (validated) | 31.705 | 31.7052 |
| PM10 2024 (validated) | 28.93 | 28.9271 |
| PM2.5 2025 (validated) | 18.424 | 18.4333 |
| benzene 2025 (validated) | 0.680 | 0.6799 |
| NO2 2026-ytd (raw) | 32.719 | 32.7197 |

The spot check benzene 2026-09-26T18:00Z = 1.1 matches meteo.hr 20:00 local = 1.12.

**Quick climatology of the station data (2024-01 … 2026-09)**, useful for defaults in the app:

- **Wind speed** (roadside sensor, height not published): median 1.2 m/s, mean 1.38 m/s, p90 2.4 m/s, 7.2 % calm (< 0.5 m/s).
- **Wind direction** is **confined to 16°–282°**: there is not a single hourly value in 283°–16°. This looks like a sensor or mounting artefact (dead band) or extreme canyon sheltering. Main sectors are ENE (14.7 %) and WSW (14.6 %). That is roughly the axis of Ulica grada Vukovara (OSM bearing about 85°, 42 m from the station), which is consistent with street channelling. **Do not use the station vane as the model inflow direction.** Take the inflow from DHMZ synoptic data (Zagreb-Maksimir / Grič) or reanalysis, and use the station wind only for comparison.
- **Weekday NO2 diurnal cycle** (local hour at the start of the averaging interval): minimum about 21 µg/m3 at 02–03 h; morning peak about 46 µg/m3 at 07–08 h; evening plateau about 46 µg/m3 at 18–20 h. This is a clear traffic signature and makes a good target for the traffic-emission toggle.


---

## 11. Example requests and responses

```bash
# hourly raw benzene, two local days (returns 26.09 01:00 … 27.09 latest)
curl 'https://iszz.azo.hr/iskzl/rs/podatak/export/json?postaja=155&polutant=32&tipPodatka=0&vrijemeOd=26.09.2026&vrijemeDo=27.09.2026'
# [{"vrijednost":1.4,"mjernaJedinica":"µg/m3","vrijeme":1790377200000}, ...]   1790377200000 = 2026-09-25T23:00Z = 26.09 01:00 CEST

# validated hourly NO2 (3 decimals), last two days of 2025
curl '…/export/json?postaja=155&polutant=1&tipPodatka=1&vrijemeOd=30.12.2025&vrijemeDo=31.12.2025'
# 48 rows, first {"vrijednost":47.525,…, 2025-12-30 01:00+01}, last {"vrijednost":39.77,…, 2026-01-01 00:00+01}

# daily raw NO2: stamped at local midnight at the START of the day
curl '…/export/json?postaja=155&polutant=1&tipPodatka=4&vrijemeOd=20.09.2026&vrijemeDo=26.09.2026'
# 7 rows: 2026-09-20 00:00+02 = 28.854, … 2026-09-26 00:00+02 = 40.35

# first date + coverage for any period (no rate limit, no cap)
curl '…/podatak/data?postaja=155&polutant=1&tipPodatka=0&vrijemeOd=01.01.2025&vrijemeDo=31.12.2025'
# {"minDateStr":"29.08.2011","extData":{"prosjek":"31,1389","maksimum":"132,4","najduziPrekid":399,"predvalidiranost":"0,00","pokrivenost":"93,52"}, "data":[["01.01.2025","…"]…]}

# current EAQI for all stations (ZAGREB-1 = id 155)
curl 'https://iszz.azo.hr/iskzl/rs/eaqi/indeks?h=0'
# {"id":155,"naziv":"ZAGREB-1","kod":"RH0101","indeks":3,"vrijeme":1790535600000,"tipPodrucja":"Gradska","tipPostaje":"Prometna",…}

# rate-limit response
# HTTP/1.1 429   Content-Type: text/plain;charset=UTF-8   body: Too many requests
```

Python (stdlib) minimal:
```python
import json, urllib.request, datetime as dt
u = ("https://iszz.azo.hr/iskzl/rs/podatak/export/json?postaja=155&polutant=1"
     "&tipPodatka=0&vrijemeOd=01.09.2026&vrijemeDo=30.09.2026")
rows = json.load(urllib.request.urlopen(u, timeout=60))
for r in rows[:3]:
    end_utc = dt.datetime.fromtimestamp(r["vrijeme"]/1000, dt.timezone.utc)  # end of hour
    print(end_utc.isoformat(), r["vrijednost"], r["mjernaJedinica"])
```

---

## 12. Gotchas (checklist)

1. **Silent 1000-row truncation.** A 1-year request "works" but ends in mid-February. Always chunk to at most 41 days and treat exactly 1000 rows as truncated.
2. **HTTP 429 without `Retry-After`**, shared between json and xml, and possibly shared with other clients on your IP. Pace at 1.1 s or more and retry.
3. **Hourly timestamps are hour-ending; daily ones are start-of-day.** Do not shift them the same way.
4. **`vrijemeDo` is an inclusive local day** and ends at the next day's 00:00 (the "24:00" value). **`/rawd` ends at D2 00:00**, a different convention.
5. **Autumn DST day has 24 values, not 25**; one real hour is lost at source. Spring day has 23. Do not "fix" the gap.
6. **Raw values have 1 decimal, validated have 3.** Do not treat the rounding difference as a data change when you switch series.
7. **Validated data arrive once a year.** 2026 is raw-only. Re-check empty validated chunks later.
8. **Year-specific holes:** validated PM2.5 2024 missing; raw NOx before 2024 missing; all 4 meteo params absent for the whole of 2023; benzene only 78–89 % complete.
9. **`tipPodatka` omitted** silently means type 0. **ISO dates** give 204 with an empty body. **Time-of-day in the date** is ignored.
10. **Units:** CO is in **mg/m3**, not µg/m3. Temperature comes as "degrees Celzius" and wind direction as "degrees". Metals and PAH are in ng/m3, but **Pb is in µg/m3**.
11. **Wind direction** is the direction the wind comes **from**, in degrees. Wind is measured at a roadside traffic station; the sensor height is not published (the air inlet is at 4 m, 9 m from the kerb). Do **not** use it as the undisturbed inflow for the LBM domain; use a synoptic or reanalysis wind instead and use the station wind for validation.
12. **`/podatak/data` numbers are strings with decimal commas** (`"20,4"`). Its coverage metric also counts the previous day's 24:00 slot.
13. **The official PDF documentation shows an outdated JSON shape** (`{"Podatak":{…}}` with ISO time). Accept both shapes.
14. **NO, BTEX (except benzene), PM1** are not in ISZZ; meteo.hr keeps 24 h only.
15. **O3 is not measured at ZAGREB-1.** Zagreb stations with O3 (code 31, types 0/1/2/3/4/5/10/11 in `/frm/gg`) are ZAGREB-3 (157), ZAGREB-4 (303), Ksaverska cesta (41), Đorđićeva (101), Pešćenica (102), Mirogojska (280), Airport (279) and Sesvete (314, raw only). Borrow the urban-background O3 from ZAGREB-3 or ZAGREB-4 if the model needs NO–NO2–O3 chemistry.
16. **Validated series use `-999` for invalid hours.** You get one row per hour for the whole year, so filter them out. Raw series never contain −999.
17. **Raw CO has poor resolution** (0.1 mg/m3 steps, a zero offset, and many 0.0 or negative values). Use validated CO where it exists. For 2026, treat raw CO below 0.2 mg/m3 as "below detection" in the UI.
18. **ISZZ EAQI uses the legacy EEA bands**, so its index can differ from airindex.eea.europa.eu.
19. **Station coordinates differ slightly** between sources: ISZZ 45.800492/15.974278, DHMZ 45.800496/15.97422, EEA 45.800339/15.974072. The spread is about 18 m, which matters for placing the inlet in a 1–2 m LBM grid. Use ISZZ/DHMZ and verify against the building outline.
20. `http://` redirects to `https://`, so always use https.
21. **ZAGREB-1 wind direction never falls in 283°–16°** (2024–2026), and wind speed is low (median 1.2 m/s) at this roadside site. It is not representative of the free-stream wind; see §10.
22. **All automatic series start 2023-01-13** (1–12 Jan 2023 are missing). The meteo sensors only restart on 2024-01-31.
23. **Address vs. coordinates:** the DHMZ text says Sarajevska / Kauzlarićev prolaz, but the coordinates sit about 18 m from Miramarska cesta, near Vukovarska. Confirm the inlet position against aerial imagery and LiDAR before placing it in the 3D model.

---

## 13. Files saved locally (`research/data/`)

| Path | Content |
|---|---|
| `zagreb1_hourly.csv` | Tidy hourly dataset 2023-01-01 … 2026-09-27 (output of the prototype) |
| `zagreb1_hourly.completeness.json` | Completeness per param and year plus HTTP stats |
| `cache_iszz/155/*.json` | Per-month raw API responses (the fetcher cache) |
| `station155_coverage.json` | `minDateStr` and ISZZ coverage for **every** (pollutant, type) of station 155, 2023–2026 |
| `iszz_raw/servis_uputa.pdf`, `.txt` | Official service documentation and its text |
| `iszz_raw/frm_gg_*.json`, `frm_gm.json` | Form metadata (stations, pollutants, types, triples) |
| `iszz_raw/ep_*.json` | Samples of every probed endpoint (koordinate, pkod, eMetaList, eaqi, map, obavijestpos, drwReport, rawd, data, …) |
| `iszz_raw/bz_26_27.json`, `bz_26_xml.xml` | Benzene alignment sample (JSON and XML) |
| `iszz_raw/prog_no2_d0.kmz` | Forecast KMZ sample |
| `iszz_raw/status_postaja_2026-09-25.xlsx` | Weekly instrument status sheet |
| `iszz_raw/exc.js`, `eindeks.js`, `prognoza.js`, `status.js` | Portal JS used to reverse-engineer endpoints, colours and bands |
| `meteohr/zagreb1_319.html`, `proizvodi*.html` | meteo.hr NO page and DHMZ XML-list pages |
| `eea/HR0007A_metadata.tsv` | EEA sampling-point metadata rows for ZAGREB-1 (the full 27 MB CSV is also kept) |
| `eea/HR_SPO_402_NO2_E2a.parquet` | EEA E2a NO2 2026 (used for the time-basis check) |
| `thresholds/aaqd_2024_2881.txt` (`.xhtml`) | Full text of Directive (EU) 2024/2881 (Publications Office cellar) |
| `thresholds/nn_77_2020_uredba.txt` (`.html`) | Croatian decree NN 77/2020 |
| `thresholds/palas_aaqd_summary.pdf` | Secondary summary of the AAQD |
| `../probes/*.py`, `*.log` | Probe scripts (rate limit, coverage) and logs |

---

## 14. Sources

- ISZZ portal and REST routes: <https://iszz.azo.hr/iskzl/>, <https://iszz.azo.hr/iskzl/js/data.js>, services page <https://iszz.azo.hr/iskzl/exc.htm>, documentation <https://iszz.azo.hr/iskzl/doc/servis_uputa.pdf>
- DHMZ ZAGREB-1 page: <https://meteo.hr/kvaliteta_zraka.php?section=podaci_kz&post=Zagreb+1>; DHMZ XML list: <https://meteo.hr/proizvodi.php?section=podaci&param=xml_korisnici>
- Directive (EU) 2024/2881, Annex I (limit values, O3 targets, information and alert thresholds) and Annex IV (micro-siting): <https://eur-lex.europa.eu/eli/dir/2024/2881/oj>; machine copy from <http://publications.europa.eu/resource/oj/L_202402881.ENG.xhtml>
- Croatian Uredba o razinama onečišćujućih tvari u zraku, NN 77/2020: <https://narodne-novine.nn.hr/clanci/sluzbeni/2020_07_77_1465.html>
- EEA European Air Quality Index (revised bands): <https://airindex.eea.europa.eu/AQI/index.html>; ETC HE Report 2024/17 "EEA's revision of the European air quality index bands": <https://www.eionet.europa.eu/etcs/etc-he/products/etc-he-products/etc-he-reports/etc-he-report-2024-17-eeas-revision-of-the-european-air-quality-index-bands>
- EEA comparison of 2008/50 and 2024/2881 standards: <https://www.eea.europa.eu/en/analysis/publications/air-quality-status-report-2025/benchmark-analysis-against-the-standards-in-the-revised-directive-eu-2024-2881>
- WHO global air quality guidelines 2021: <https://apps.who.int/iris/handle/10665/345329> (values cross-checked with <https://pmc.ncbi.nlm.nih.gov/articles/PMC8553929>)
- EEA station metadata: <https://discomap.eea.europa.eu/map/fme/metadata/PanEuropean_metadata.csv>; EEA download API: <https://eeadmz1-downloads-api-appservice.azurewebsites.net/>
