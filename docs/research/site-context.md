# ZAGREB-1 site context for a street-scale dispersion model

Research date: 2026-09-27. Local frame used throughout: origin = station (OSM way 1409603653 centroid,
45.8004912 N, 15.9742232 E), **x = east, y = north, metres** (1 deg lon = 77 629 m, 1 deg lat = 110 540 m).
(The reference repo `maksimir-pod-kisom` uses x = east, z = south; flip the sign of y when porting.)

All raw downloads are in `research/data/` (listed in section 11). The analysis scripts are in `research/`
(`analyze_osm.py`, `analyze_roads.py`, `analyze_land.py`, `canyon.py`, `canyon2.py`, `meteo_stats.py`).

---

## 0. TL;DR

* **Where the station is.** ZAGREB-1 (ISZZ id 155, national code RH0101, EoI **HR0007A**, operated by DHMZ)
  is a small container in the **NW corner of the Miramarska cesta x Ulica grada Vukovara (Vukovarska)
  intersection**. It sits at the east end of the small park *Park Drage Galića*. It is **not** at "Sarajevska /
  Kauzlarićev prolaz": that text on the DHMZ page is a copy error. It is the address of ZAGREB-3, per the City
  action plan 2015 (see 1.1).
* **Classification.** ISZZ lists it as *Gradska / Prometna* (urban traffic station). It has run since 11 Feb 2003.
  It measures NO2, NO, NOx, SO2, CO, PM10, PM2.5 (automatic since 13 Jan 2023), benzene/BTEX, O3 (per DHMZ),
  wind speed/direction, T, RH, UV, plus gravimetric PM10 with metals and PAHs. The sampling inlet is ~3 m
  above ground on the container roof (2012 metadata).
* **The geometry is not a street canyon.** Vukovarska is a **~75–80 m wide boulevard**. It has a central tram
  reservation (lines 3, 5, 13, 33) and 3 through lanes plus turn lanes per direction. Buildings along it are
  2–7 storeys, giving **H/W of about 0.1–0.3**, and the NE quadrant is open park. The streets are almost
  grid-aligned: Vukovarska runs **86°/266°** and Miramarska **176°/356°**.
* **Traffic.** No published AADT exists for these street links. Measured peak data do exist:
  * The intersection takes **5 471 PCU/h (07–08 h) and 5 958 PCU/h (16–17 h)**, with degree of saturation
    1.12 / 1.27, i.e. LOS F (FPZ traffic study, counted Apr/May 2017).
  * Miramarska carries **1 596 veh/h at a median 37 km/h** in the PM peak (Pejić et al. 2018).

  From these, my estimates (not published counts) are:
  * **Vukovarska ≈ 47 000 veh/day** (range 40–55 k), two-way.
  * **Miramarska (north leg) ≈ 20 000 veh/day** (range 15–25 k).
* **Fleet** (CVH 2025, Grad Zagreb, registered cars, n = 405 749): diesel 50.6 %, petrol incl. LPG 39.2 %,
  HEV 7.7 %, PHEV 1.3 %, BEV 1.1 %. Light commercial vehicles (N1) are 96 % diesel. Average car age in
  Croatia is 13.4 years, and 65 % of cars are 10 years or older.
* **Measured levels.**
  * 2023 (DHMZ annual report): NO2 35 µg/m³, PM10 25 µg/m³ (23 days over the daily limit), PM2.5 17 µg/m³,
    benzene 1.0 µg/m³.
  * 2025 (ISZZ validated hourly): NO2 31.7, NOx 71, PM10 27.0, PM2.5 18.4 µg/m³.
  * **Increment over suburban background ZAGREB-4** (2025): NOx +46, NO2 +15, PM10 +1.4, PM2.5 +2.7 µg/m³.
    In words: NOx is local traffic, PM is regional plus domestic heating.
* **Meteorology.**
  * Wind is weak and bimodal, **NE (NNE–ENE) vs SW (SSW–WSW)**. ERA5 2021–25 gives a mean 10 m wind of
    2.0 m/s, with 60 % of hours below 2 m/s.
  * Winter inversions are frequent: mixing layer below 1 000 m at 12 UTC on 44 % of days, 80 % of them in the
    cold season (Bešlić et al. 2026).
  * The **station anemometer is strongly site-affected**. The 2025 mean is 1.36 m/s, and there are no records
    at all from 280–15°. Directions are channelled along the Vukovarska axis. Use it only for validation, not
    as model inflow.
* **Other sources.**
  * Domestic heating is Oct–Mar. Households produced 74 % of city PM10 emissions (2010 inventory), 99 % of
    that from wood.
  * The EL-TO CHP (200 m stack) is 2.0 km WNW. The TE-TO CHP (202.5 m stack) is 3.9 km ESE. Both contribute
    less than 1 % of the PM10 limit at ground level.
  * Nearby point sources: an INA fuel station 151 m N (benzene), the main railway ~300 m N, and bus
    terminals at 430 m NE and 1.5 km E.

---

## 1. The station

### 1.1 Identity, position and siting

| Item | Value | Source |
|---|---|---|
| Name / ids | ZAGREB-1, ISZZ `postaja=155`, national RH0101, EoI HR0007A, nat_ref ZAG001 | ISZZ `rs/postaja/eMetaList`, OSM way 1409603653 |
| Operator | Državni hidrometeorološki zavod (DHMZ) | OSM, DHMZ |
| Coordinates | ISZZ: 45.800492 N, 15.974278 E, h = 113 m a.s.l. DHMZ page: 45.800496, 15.97422. OSM centroid: 45.8004912, 15.9742232. The three agree within 4 m. | `rs/postaja/koordinate`, DHMZ page, OSM |
| Classification | Area: *Gradska* (urban). Type: *Prometna* (traffic) | ISZZ eMetaList |
| Start of operation | 11.02.2003 (NO2, NOx, SO2, CO, PM10 auto, benzene). Gravimetric PM10 with metals and PAHs from 2005/2012. Hg from 2010. PM2.5 auto and new PM10 auto from 13.01.2023 (AirQ modernisation) | ISZZ eMetaList, DHMZ 2023 report |
| Parameters on DHMZ page | benzene, toluene, ethylbenzene, m,p-xylene, NO, NO2, NOx, PM (3 fractions), O3, SO2, CO, wind speed and direction, T, RH, direct UV | meteo.hr station page |
| Sampling height | 3 m, on the container roof (2012 metadata) | City of Zagreb Action Plan 2015, Tab. 1-2 |
| Location text | Action Plan 2015: "ZAGREB-1, raskrižje Ulice grada Vukovara i Miramarske ceste". The DHMZ page instead says "Raskrižje Sarajevske ulice i Kauzlarićevog prolaza" (last edited 2017). That is **ZAGREB-3's** address (the same plan lists ZAGREB-3 at "Sarajevske ulice i Kauzlarićeva prilaza"). Sarajevska is in Novi Zagreb, ~3.5 km SE; no Kauzlarićev prolaz exists in the 3 km box. | Action Plan PDF, Nominatim, OSM |
| Distance to roads (OSM geometry + Esri imagery) | Station centre to the southbound Miramarska line: **22 m**. With OSM lane placement, the west kerb is about **15–18 m** away. To the westbound Vukovarska line: **42 m**. To the tram track centreline: **52 m**. Kranjčić et al. 2022 are quoted (search snippet only, MDPI blocked) as "30 m from the nearest building and 5 m from the road edge". The 5 m probably refers to the footway/cycle path. | `analyze_roads.py`, `imagery/zagreb1_esri_z19.jpg` |
| Immediate surroundings | Grass and tall deciduous trees in Park Drage Galića, including one large crown ~10 m N of the container. A newsstand kiosk (iNovine) is 17 m SSE. A 9-storey protected modernist residential slab (OSM way 33730915, heritage Z-0675) is ~74 m NW. A 2-storey commercial building (Vukovarska 41) is 100 m W. | OSM, imagery |

Esri World Imagery (z19, 3 x 3 tiles, `imagery/zagreb1_esri_z19.jpg`) confirms the placement: the container
is on grass west of the Miramarska southbound queue. The broad Vukovarska intersection with tram tracks lies
~40 m south, and open parkland lies to the NE across Miramarska. (Imagery © Esri and its providers; it was
used only for visual verification.)

### 1.2 Measured concentrations (for calibration targets)

**Annual statistics 2023** (DHMZ, *Izvješće o praćenju kvalitete zraka ... za 2023.*):

| Pollutant | Mean | Median | P98 (hourly) | Max hourly | Notes |
|---|---|---|---|---|---|
| NO2 | 35 µg/m³ | 32 | 84 | 145 | 0 hours over 200 µg/m³ |
| PM10 (auto) | 25 µg/m³ | 20 | 88 | 169 | 23 days over 50 µg/m³ (daily) |
| PM2.5 | 17 µg/m³ | 12 | 68 | 135 | |
| Benzene | 1.0 µg/m³ | 0.5 | 6.5 | 15.3 | |
| SO2 | 2 µg/m³ | | | 81 | negligible |
| CO | 0.3 mg/m³ | | | 1.8 | |

**2025 validated hourly data** (ISZZ `tipPodatka=1`; files cached by the physics agent in
`data/physics/iszz/155_*_2025.json`; −999 sentinels removed):

| Pollutant | ZAGREB-1 mean | ZAGREB-4 (suburban bg, 4.4 km SW) | Increment over Z-4 | ZAGREB-3 (4.7 km SSE) | Mirogojska (3.5 km N) |
|---|---|---|---|---|---|
| NO2 | 31.7 | 16.6 | **+15.1** | 23.9 | 18.9 |
| NOx (as NO2) | 71.0 | 24.5 | **+46.0** | 47.2 | 34.8 |
| PM10 | 27.0 | 25.6 | **+1.4** | 41.1 | 19.1 |
| PM2.5 | 18.4 | 15.9 | **+2.7** | 23.4 | – |
| Benzene | 0.7 | | | | |
| CO (mg/m³) | 0.2 | | | | |

* **Trend.** In 2009–2013, Zagreb-1 and Đorđićeva exceeded the NO2 annual limit (40 µg/m³) by up to
  ~20 % (Action Plan 2015). The level has since fallen to 35 (2023) and ~32 (2025) µg/m³.
* **Seasonality 2025.** Monthly PM10 runs from 13 µg/m³ (May) to 52 µg/m³ (Feb), 51 µg/m³ in Dec. NOx runs
  from 36 (Jul) to 134 (Dec). NO2 runs from 24 (Jul) to 44 (Feb).
* **Weekday diurnal NOx increment (Z-1 minus Z-4, CET, 2025).**
  * Peaks at **08 h (89 µg/m³)** and **18–19 h (~68)**; minimum at 03 h (23).
  * NO2 peaks 07–09 and a larger peak at **18–21 h**. The Action Plan also notes that Zagreb-1's evening
    NO2 maximum comes later than at other sites, attributing it to domestic-heating NOx and evening
    stability.
* **Weekly NOx increment.** Saturday is 0.71 and Sunday 0.56 of the weekday mean.
* **PM10 and weekends.** PM10 is **not** lower at weekends. Both the Action Plan and the 2025 data show this.
  PM10 is dominated by background and heating.

---

## 2. Map description of the surroundings (1.5 km box, centred on the station)

```
                 N (y+)
     Lenuzzi Horseshoe / Tomislav sq. (~700 m N)  --  Glavni kolodvor (rail, ~450 m NE)
  ==== main railway (E-W, y ~ +300..+420) ==== Miramarski podvoznjak (x~+50, y~+300)
     Botanicki vrt (-200,+490)   Importanne (underground mall, 500 parking, +160,+500)
     Zelinska/ FER campus (-240,+20..+150)   Eurocentar 10 fl (+70,+190)  ZET bus terminal (+290,+320)
     Miramarska 22 office 7 fl (-30,+120) | MIRAMARSKA (N-S, 4+2 lanes) | Park A. Mosinskog, Park S. Srkulja
     9-fl slab (-57,+47)  [Park Drage Galica]  *ZAGREB-1 (0,0)* | open park / Trg S. Radica | Lisinski (+470,-10)
  ======= ULICA GRADA VUKOVARA (E-W, 86 deg; y ~ -42..-65; trams in median) ============================
     Vukovarska 41 comm 2 fl (-100,-16)      office 4 fl (+100..+175,-100)    City/Gov. offices (+500,-80)
     Hotel International / Miramarska 24, 11 fl (+3,-165); garage 447 places
     Cazmanska 2/4 18-fl towers (-140/-90,-210)   Trnje low-rise houses (Vrbaska, Plivska, +40..+400,-150..-400)
     96 m glass tower (Eurotower, -330,-220)   FSB / Filozofski fak. (-200,-500)   HRT (-25,-850)
     Slavonska avenija (E-W, ~650 m S) ...... Sava river (~1.2 km S)
```

* **Setting.** The station is on the boundary between the **Donji grad / Trnje** districts, just south of the
  main railway corridor.
* **North of Vukovarska.** Campus and office blocks (FER university, City offices, Eurocentar) plus a string
  of small parks.
* **South of Vukovarska.** 1960s–70s modernist slabs and towers along Vukovarska and Miramarska. Behind them
  is a low-rise Trnje neighbourhood of 1–2-storey houses, which is a likely domestic wood-burning area.
* **Large open spaces.** Trg Stjepana Radića, Park Stjepana Srkulja and the Lisinski forecourt lie NE and E of
  the intersection. They give **long unobstructed fetches from NE through E**.
* **Terrain.** Essentially flat, at 110–122 m a.s.l. The Medvednica ridge (Sljeme, 1 033 m) is ~11 km N.

---

## 3. Streets

### 3.1 Streets bounding the station

**Ulica grada Vukovara (Vukovarska avenija)**
* Axis: E-W, bearing 86°/266°.
* Cross-section near the station:
  * Dual carriageway. The two carriageway centrelines are 19–24 m apart, 23 m at the station.
  * Westbound: 3 through lanes, widening to 5 at the stop line (`turn:lanes` = left, through x3, right).
  * Eastbound: 3 through lanes, widening to 5 (`left|left|through|through|through;right`).
  * Central tram reservation, with stops "Miramarska" at (−41, −55) and (+86, −49).
  * Cycle tracks and footways on both sides.
* maxspeed: 60 km/h (OSM).
* Building-to-building width (`canyon2.py`, ray casting from the carriageway midline):
  * West of Miramarska (x = −125…−50): **W ≈ 77–78 m**. North face: 2-storey commercial Vukovarska 41
    (~8 m). South face: 7-storey office (~24 m).
  * At x = −250: W ≈ 26 m to the 4-storey FER building on the north. The south side is open.
  * East of Miramarska (x = +25…+400): north side **open** for more than 150 m (parks, square). South side:
    4-storey offices (Vukovarska 78) about 37 m from the midline.
* Aspect ratio **H/W ≈ 0.1–0.3**. This is an avenue, not a skimming canyon.

**Miramarska cesta**
* OSM `tertiary`, local road L10078.
* Axis: N-S, bearing 176°/356°.
* North of Vukovarska (the station side):
  * Divided: **southbound 4 lanes** (queue storage, LOS F) and **northbound 2 lanes**.
  * It leads 300 m north to the railway underpass (Miramarski podvožnjak, 2+2 lanes).
  * West side: 7–9-storey buildings about 27 m from the centreline. East side: open park.
* South of Vukovarska: 4 lanes two-way, maxspeed 30 km/h (OSM `residential` segment).
  W ≈ 27–56 m. The 11-storey Miramarska 24 (~37 m) and 7–8-storey blocks line it.
  **H/W ≈ 0.5–0.9** (wake-interference canyon).

**Trg Stjepana Radića** (`unclassified`): 2–3 lanes, E-W (261–268°), 46–83 m NE. Access road to City offices
and Lisinski. On-street parking for 316 places.

### 3.2 Street table with estimated AADT

AADT is two-way, all motor vehicles, veh/day. **Bold** figures are my recommended model defaults, not
published counts. Every derivation is shown.

| Street (OSM name) | OSM class | Lanes (OSM) | Axis | Dist. to station | Measured data | Est. AADT | Basis |
|---|---|---|---|---|---|---|---|
| Ulica grada Vukovara, west leg (station side) | secondary | 3+3 (5+5 at the stop lines), tram median | 86°/266° | 42–65 m S | Intersection PM peak 5 958 PCU/h total entering (FPZ 2017); >60 000 veh/day through the Savska–Vukovarska intersection (2009 counts, CIVITAS-ELAN, quoted in the Action Plan) | **47 000** (40–55 k) | (a) |
| Ulica grada Vukovara, east leg | secondary | 3+3 (up to 5) | 86°/266° | 40–63 m SE | as above | **45 000** (40–55 k) | (a) |
| Miramarska cesta, north leg | tertiary | 4 SB + 2 NB | 176°/356° | 22–27 m E | **1 596 veh/h at median 37 km/h**, PM peak 16:15–17:15, Feb/Mar 2017 (Pejić et al. 2018) | **20 000** (15–25 k) | (a), (b) |
| Miramarska cesta, south leg | residential/tertiary | 4 (2+2), 30 km/h | 177° | 70–150 m S | none | **12 000** (8–18 k) | (c) |
| Miramarski podvožnjak | tertiary | 2+2 | 175°/356° | 68 m N | the only N-S road link across the railway between Savska and Držićeva (FPZ 2017) | = Miramarska north, **20 000** | (b) |
| Trg Stjepana Radića | unclassified | 2–3 | 265° | 46 m NE | none | **4 000** (2–6 k) | (d) |
| Ulica Hrvatske bratske zajednice | secondary | 3–4 per direction | N-S | 340 m E | 2 296 veh/h PM peak at 50 km/h (Pejić 2018); intersection with Vukovarska 7 082 / 7 437 PCU/h, X = 1.88 (FPZ 2017) | **50 000** | (a) |
| Ulica Ivana Lučića | tertiary | 1–4 | N-S | 310 m W | none | **12 000** | (c) |
| Savska cesta | secondary | 4–7 | N-S | 790 m W | Savska–Vukovarska 4 937 / 5 266 PCU/h (2017); >60 000 veh/day through the intersection (2009) | **45 000** | (a) |
| Slavonska avenija | secondary, 70 km/h | 2–5 per direction | E-W | 650 m S | **39 243 veh/day**, automatic counter, Feb 2014 monthly mean (Action Plan); 2 059 veh/h at 72 km/h (2017) | **40 000** | measured |
| Avenija Marina Držića | secondary | 3 | N-S | 1.5 km E | 1 721 veh/h at 57 km/h; Držićeva–Vukovarska 7 582 / 7 427 PCU/h, X = 1.74 | **50 000** | (a) |
| Ulica kneza Branimira | secondary | 2–5 | E-W | 820 m N | Držićeva–Branimirova 5 671 / 6 008 PCU/h | **25 000** | (c) |
| Zelinska, Plivska, Čazmanska, Vrbaska, Koranska (local) | residential | 1–2, 30 km/h | mixed | 150–300 m | none | **800–2 000** | (e) |

Notes on the basis column:

* **(a) Intersection method.** Take the FPZ 2017 PM-peak entering volume and divide by the peak-to-daily
  ratio observed at Savska–Vukovarska: 5 266 PCU/h in the 2017 peak against >60 000 veh/day in 2009, a ratio
  of ≈ 0.088. For Miramarska–Vukovarska this gives about 68 000 veh/day entering. Summed over the four legs,
  each leg's two-way volume counts once as entering and once as exiting. So 68 000 × 2 ≈ 47 k + 45 k + 20 k +
  12 k (≈ 124 k plus turning flows).
* **(b) Miramarska.** 1 596 veh/h ÷ K = 0.08 ≈ 20 000. The paper does not state whether the observed section
  is one- or two-directional. The study region was a Zagreb LEZ-scenario analysis.
* **(c) Class/lanes analogy.** Scaled from comparable measured streets (Jadranska avenija, 2 lanes per
  direction: 22 286 veh/day, Feb 2014).
* **(d)** An access road with parking; judgement only.
* **(e)** Typical 30 km/h residential streets. Kept low on purpose so they add little.
* **Caution.** Every avenue near the station runs at **LOS F** in the peaks (FPZ 2017, tportal 2019). So peak
  flows are capacity-capped, and queues sit right next to the station (the Miramarska southbound queue in the
  imagery).

### 3.3 Defaults per OSM highway class (Zagreb, for streets without data)

Zagreb OSM tags its big avenues (Vukovarska, Slavonska, Savska, HBZ, Držićeva) as **`secondary`**, not
`primary`/`trunk`. So key on class **and** lanes.

| OSM class / lanes | Default AADT | Speed (free / peak) | HDV share | Justification |
|---|---|---|---|---|
| motorway / trunk | 60 000 | 90 / 60 | 12 % | not present within 3 km; A1 Lučko-jug is 47 443 (HC 2024) |
| secondary, ≥ 3 lanes per direction (avenije) | 45 000 | 60 / 25 | 4 % | Slavonska 39 243; intersection totals 60–80 k per day |
| secondary, 2 lanes per direction | 25 000 | 50 / 25 | 4 % | Jadranska 22 286 |
| tertiary (4 lanes) | 18 000 | 40 / 20 | 3 % | Miramarska 1 596 veh/h peak |
| tertiary (2 lanes) | 8 000 | 40 / 20 | 3 % | analogy |
| unclassified | 3 000 | 30 / 20 | 2 % | judgement |
| residential / living_street | 1 000 | 30 / 20 | 1 % | judgement |
| service / parking aisle | 150 | 20 | 0 % | judgement |
| tram (railway=tram) | 0 exhaust | – | – | electric. Add non-exhaust resuspension only (lines 3, 5, 13, 33 on Vukovarska). |

### 3.4 Temporal traffic profiles (defaults)

**Weekday hourly share of daily traffic (%), hour-ending local time.** These values are my synthesis. The
shape follows the LOTOS-EUROS factors used in the City Action Plan (peaks 08–09 and 17–18). It was checked
against the ZAGREB-1 minus ZAGREB-4 weekday NOx increment, whose normalised values are
0.63, 0.53, 0.48, 0.44, 0.51, 0.88, 1.22, 1.56, **1.73**, 1.49, 1.17, 0.96, 0.92, 0.84, 0.92, 0.93, 1.14, 1.24,
**1.34**, 1.30, 1.09, 1.01, 0.86, 0.81. That concentration profile also contains night-time stability, so
the emission profile below is steeper at night.

| h | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| % | 0.9 | 0.6 | 0.4 | 0.4 | 0.6 | 1.5 | 4.0 | 6.8 | 7.2 | 6.0 | 5.3 | 5.4 | 5.6 | 5.7 | 6.0 | 6.6 | 7.2 | 7.3 | 6.6 | 5.2 | 3.9 | 3.0 | 2.3 | 1.5 |

* **Day of week.** Mon–Thu 1.00, Fri 1.02, **Sat 0.90, Sun 0.70**. Source: Zagreb counts quoted in the Action
  Plan ("Saturday about 10 % lower, Sunday about 30 % lower"). The weekend NOx increment at the station is
  lower still (0.71 and 0.56).
* **Month.** Traffic dips in **August**, when residents are on holiday (Pejić et al. 2018 note lower PM in
  those months). Suggested factors: Jan 0.95, Feb 0.98, Mar–Jun 1.02, Jul 0.93, **Aug 0.85**, Sep–Nov 1.03,
  Dec 1.00. These are an assumption.

### 3.5 Fleet composition and emission factors

**Registered vehicles, Grad Zagreb, 31.12.2025** (CVH `s11_broj_vozila_2025_zupanije_vrstevozila_vrstegoriva.xlsx`):

| Category | Count | Share of fleet | Fuel split |
|---|---|---|---|
| M1 (cars) | 405 749 | 86.1 % | diesel 50.6 %, petrol 36.7 %, petrol-LPG 2.5 %, HEV 7.7 %, PHEV 1.3 %, BEV 1.1 % |
| N1 (vans) | 37 571 | 8.0 % | diesel 96.3 % |
| N2 + N3 (trucks) | 8 580 | 1.8 % | diesel ~100 % |
| M3 (buses) | 940 | 0.2 % | mostly diesel, some CNG, electric and hybrid |
| L (two-wheelers) | 18 626 | 4.0 % | petrol |

**Age** (CVH 2025, Croatia). M1 average age is **13.35 years**. 65.3 % of cars are 10 years or older, 17.5 %
are 6–9 years, 11.5 % are 2–5 years and 5.8 % are 1 year old. The average age of all vehicles is 14.6 years.

**Euro split, Zagreb M1 in PTI, 1 Jan 2018** (Pejić et al. 2018, Table 1):

| Fuel | Euro 0–1 | Euro 2 | Euro 3 | Euro 4 | Euro 5 | Euro 6 |
|---|---|---|---|---|---|---|
| All M1 | 8.6 % | 11.8 % | 19.4 % | 27.5 % | 19.8 % | 13.0 % |
| Diesel | 3.9 % | 7.3 % | 20.1 % | 26.4 % | 25.7 % | 16.7 % |

**Estimated 2026 Euro split** (my estimate from that 2018 split and the 2025 age structure; no
Euro-by-city table was found):

| Fuel | ≤ E3 | E4 | E5 | E6 a–c | E6d / 6e |
|---|---|---|---|---|---|
| Diesel cars | 12 % | 18 % | 30 % | 25 % | 15 % |
| Petrol cars | 15 % | 20 % | 20 % | 25 % | 20 % |

**Per-vehicle NOx factors implied by Pejić et al. 2018** (COPERT Street Level, 2017/18 fleet). Each is
g/km/h divided by veh/h:

| Road | Speed | NOx (g/veh/km) |
|---|---|---|
| Slavonska, free-flow | 72 km/h | 0.27 |
| HBZ | 50 km/h | 0.32 |
| **Miramarska** | **37 km/h** | **0.40** |
| Selska | 40 km/h | 0.35 |
| Slavonska, jam | 15 km/h | **0.95** |

PM (exhaust plus whatever COPERT SL includes) is 0.019–0.040 g/veh/km.

**Recommended model emission factors (2026, fleet average per vehicle)** in section 9.

---

## 4. Building statistics

Source: OSM (`osm_buildings_1500.json`, main Overpass, snapshot 2026-09-27T19:42Z;
`osm_context3000.json`).

### 4.1 1.5 km x 1.5 km box

* **Counts and tags.** 1 867 buildings plus 85 `building:part`. Only **22 have `height`** and **336 have
  `building:levels`** (18 % in total).
* **Estimated height** (H = height, or levels × 3.2 + 1.5 m): mean 13.6 m, **median 14.3 m (≈ 4 storeys)**,
  P90 20.7 m, max 96 m.
* **Levels distribution** (tagged buildings): 1 fl 60, 2 fl 47, 3 fl 51, **4 fl 94**, 5 fl 27, 6 fl 26,
  7 fl 10, 8–13 fl 17, 16–18 fl 4.
* **Types.** `yes` 1 199, apartments 281, house 105, detached 46, office 29, retail 24, service 23,
  residential 20, university 10, dormitory 10.
* **Plan-area fraction λp:** 0.236 over the box.

**Radial statistics:**

| Radius | n | λp | Area-weighted H | Height-tag coverage (by area) |
|---|---|---|---|---|
| 100 m | 4 | 0.07 | 30 m | 97 % |
| 200 m | 21 | 0.23 | 23 m | 88 % |
| 300 m | 97 | 0.20 | 23 m | 76 % |
| 500 m | 433 | 0.20 | 19 m | 53 % |
| 750 m | 1 306 | 0.21 | 17 m | 46 % |

**Tallest nearby buildings:**

| Building | Height / floors | Position (x, y) | Distance |
|---|---|---|---|
| 96 m glass tower (Eurotower, Ivana Lučića 2a; building:part) | 96 m, 26 fl | (−328, −218) | 390 m |
| Čazmanska 2 and 4 residential towers | 18 fl each | (−142, −212), (−91, −208) | 230–255 m |
| "Rakete", Zeleni trg 1 | 57 m, 16 fl (+ 60 m part) | (−752, −592) | 960 m |
| Hotel Westin | 18 fl (+ 54 m part) | (−613, +688) | 920 m |
| Unska 3 "Zgrada C" | 50 m, 13 fl | (−240, +107) | 263 m |
| **Miramarska 24** (Hotel International block) | 11 fl | (+3, −165) | **165 m** |
| Eurocentar, Miramarska 23 | 10 fl | (+71, +189) | 200 m |
| Two apartment slabs | 11 fl | (+143…+192, +240) | 280–310 m |

**Buildings within 150 m** (all low to mid-rise):

| Building | Floors | Footprint | Position (x, y) |
|---|---|---|---|
| Residential slab (heritage) | 9 fl | 2 029 m² | (−57, +47) |
| Commercial, Vukovarska 41 | 2 fl | 2 243 m² | (−101, −16) |
| Office | 4 fl | 931 m² | (+7, −113) |
| Office, Miramarska 22 | 7 fl | 2 145 m² | (−29, +120) |
| Office | 7 fl | 4 224 m² | (−75, −125) |

Kiosks, a roof canopy and the station container itself are also within 150 m.

### 4.2 3 km x 3 km box

7 525 buildings. 21 % carry height/levels tags; median estimated H is 14.3 m and λp = 0.233.

### 4.3 Implication for the 3D model

OSM heights are too sparse outside ~200 m. Use the DGU / City of Zagreb 3D or LiDAR products that the other
research agents are handling (`data/lidar`, `fetch_zg3d*.py`) for building heights. Keep OSM for footprints,
names and missing buildings. A defensible fallback is H = 4 floors = 14.3 m for untagged `apartments/yes`
and 7 m for `house/detached`.

---

## 5. Green areas, trees and surfaces (1.5 km box)

**Land cover, clipped areas (box = 2.25 km²):**

| Land cover | Share of box |
|---|---|
| landuse=residential | 19.5 % |
| **grass** | **13.6 %** (730 polygons) |
| commercial | 9.2 % |
| Lenuzzi horseshoe squares (unnamed tags) | 5.9 % |
| **parking** | **5.8 %** (291 polygons) |
| **leisure=park** | **5.5 %** (20) |
| railway | 4.2 % |
| construction | 2.9 % |
| gardens | 2.5 % |
| brownfield | 1.7 % |
| forest + wood | 1.5 % |
| water | 0.1 % |

**Named parks and green spaces:**

| Name | Area | Position (x, y) | Distance |
|---|---|---|---|
| **Park Drage Galića** (the station sits in it) | 5 428 m² | (−57, +7) | 57 m |
| **Park Stjepana Srkulja** (E of Miramarska) | 11 010 m² | (+119, +14) | 119 m |
| Martinovka | 4 777 m² | | 155 m |
| Park Adolfa Mošinskog | 6 176 m² | | 170 m |
| Park mira i prijateljstva | 4 705 m² | | 243 m |
| Park Brezje | 15 399 m² | | 297 m |
| Trg Stjepana Radića (square) | 29 882 m² | | 303 m |
| Sveučilišna livada | 26 591 m² | | 491 m |
| Botanički vrt | 46 535 m² | | 533 m |
| Lenuzzi horseshoe squares | | | 700–800 m |

**Trees.** 1 782 `natural=tree` points and 13 tree rows (680 m) are mapped.

| Within | Trees | Density |
|---|---|---|
| 50 m | 14 | 18 per ha |
| 100 m | 49 | 16 per ha |
| 200 m | 111 | 9 per ha |
| 500 m | 402 | 5 per ha |

* The Vukovarska corridor alone holds 104 trees (the band y = −80…−25).
* Genera, where tagged: *Acer* (73), *Tilia tomentosa* (40), *Platanus × acerifolia* (16), *Tilia × euchlora* (14).
* No tree heights are tagged. Suggested defaults: 12–18 m for mature *Platanus* and *Tilia*, 8–12 m for
  *Acer*. Crowns are deciduous, so model trees as porous drag only from May to October (LAD ≈ 1–1.5 m²/m³),
  with reduced drag in winter.

**Surfaces.** The intersection is a large sealed area of asphalt plus tram tracks. Parking lots and
hard-standing cover 6 % of the box.

---

## 6. Other emission sources (with coordinates)

| Source | Location (lat, lon) | Local (x, y) / dist, bearing | Relevance |
|---|---|---|---|
| **INA Zagreb-Miramarska fuel station** | 45.80181, 15.97474 | (+40, +146) / 151 m, N | benzene/VOC evaporation, turning traffic |
| INA Zagreb-Grada Vukovara fuel station | 45.80067, 15.98336 | 709 m, E | minor |
| Car washes (CER, Miramarska and others) | 45.79895, 15.97345 etc. | 181–850 m | negligible |
| **Hotel International garage** (447 places) | 45.79900, 15.97355 | 173 m, S | cold starts, ramp |
| Underground garages (Importanne Centar 500; others with 374, unknown…) | 45.80505, 15.97643 etc. | 130–770 m | cold starts |
| Surface and street parking (Zone II, 2 536 places in the FPZ study area) | many | 100–700 m | cruising traffic |
| **Main railway line and Zagreb Glavni kolodvor** | tracks at y ≈ +300…+420; station ≈ 45.8045, 15.9785 | 300–450 m, N/NE | mostly electric; diesel shunting/regional trains; brake dust |
| ZET bus terminal "Glavni kolodvor" (5 platforms) | 45.80340, 15.97792 | 431 m, NE | diesel/CNG buses idling |
| Autobusni kolodvor Zagreb (intercity) | near Držićeva/Avenija M. Držića | ~1.5 km, E | coaches |
| Tram lines 3, 5, 13 (33) in the Vukovarska median | tracks at y ≈ −52…−55 | 52 m, S | no exhaust; wheel/rail/brake PM, resuspension |
| **Domestic heating, Trnje / Donji grad** | area source; low-rise Trnje houses 150–700 m S/SE | area | winter PM10/PAH/BaP; Trnje, Donji grad and Trešnjevka-sjever have the highest specific PM10 emission (Action Plan Fig. 6-6) |
| **EL-TO Zagreb** CHP (HEP; gas, oil backup; 88.8 MWe / 439 MWth / 160 t/h steam per OSM; new 150 MWe/114 MWth gas unit L since Nov 2023) | plant 45.80736, 15.94951; **200 m stack** 45.80615, 15.94961 (built 1980) | 2.0 km, WNW (288°) | NOx elevated source; ground-level PM10 impact < 1 % of the limit (Action Plan) |
| **TE-TO Zagreb** CHP (HEP; gas, oil; 300 MWe / 733 MWth per OSM; since 1962) | plant 45.78127, 16.01644; **202.5 m stack** 45.78107, 16.01670; three 60 m stacks at 45.7822, 16.0163 | 3.9 km, ESE (123°) | as EL-TO |
| Other `man_made=chimney` (untagged boiler houses) | 45.79125, 15.98051 / 45.79871, 15.99604 / 45.79025, 15.95552 / 45.79499, 16.00974 | 1.1 km SSE / 1.7 km E / 1.8 km SW / 2.8 km E | minor gas boilers (> 100 kW, gas; Action Plan) |
| Construction sites (2026): Paromlin city library, FER B/C renovation, FSB renovation, GIK site | (+395, +248), (−236, +86), (−178, −559), (+450, −496) | 250–670 m | PM10 dust (toggle) |
| Zagreb Franjo Tuđman airport (ZAG) | 45.7406, 16.0652 | 9.7 km, SE (133°) | negligible at the site |
| Jakuševec landfill | 45.7632, 16.0290 | 5.9 km, SE | odour/CH4; negligible for NO2/PM |
| CUPOVZ central wastewater plant | 45.7882, 16.0887 | 9.0 km, E | negligible |
| Winter road sanding/salting | all avenues | line | PM10 resuspension episodes (Action Plan) |

**City emission inventory 2010** (EIHP 2013, in the Action Plan Tab. 5-1):

| Sector | NOx (t) | NOx share | PM10 (t) | PM10 share | SO2 (t) | SO2 share |
|---|---|---|---|---|---|---|
| Energy | 1 832 | 25 % | 134 | 6 % | 3 704 | 82 % |
| Industry | 325 | 5 % | 19 | 1 % | | 3 % |
| **Road traffic** | 4 052 | **56 %** | 407 | **18 %** | | 6 % |
| **Households** | 851 | **12 %** | 1 699 | **74 %** | | 3 % |
| Services | 163 | 2 % | 45 | 1 % | | 6 % |
| **Total** | 7 223 | | 2 304 | | 4 544 | |

* 99.4 % of household PM10 comes from **wood**. About 70 % of household NOx comes from natural gas.
* Winter emissions compared with summer: about 2 times for NOx and 4 times for PM10.
* Diurnal domestic-heating peaks are **08–10 h and 19–22 h**.
* **Heating mix of Zagreb households** (eko.zagreb.hr; year not stated): gas 47 %, district heating 33 %,
  fuel oil 8 %, **wood 7 %**, electricity 5 %.
* **Regional background** (EMEP 2011, NW Croatia): PM10 ≈ 14, NO2 ≈ 6, SO2 ≈ 2 µg/m³. **Up to 70 % of PM
  in the agglomeration is transported in from outside.**

---

## 7. Meteorology summary

### 7.1 Climate

Sources: Action Plan 2015, from DHMZ Zagreb-Maksimir 1949–2013, and Lisac 1984.

* Continental climate. Maksimir annual mean 10.6 °C (Jan −0.3 °C, Jul 20.7 °C); ERA5 2021–25 is warmer,
  at 13.4 °C.
* 852 mm of precipitation a year, 124 rain days, 22 snow-cover days and **46 fog days** (peaking Dec/Jan).
* **Winds are weak.**
  * The Maksimir rose is stretched N-S, with **calms above 10 %**.
  * The Grič rose (city centre, the closest analogue) is stretched **NE-SW**, following the Medvednica
    ridge, and has far fewer calms. The most frequent directions are the NE quadrant (ENE at Grič).
    S-SSW-SSE and WSW are secondary.
  * Medvednica drives a persistent slope circulation: an upslope, southerly component by day and a
    downslope, northerly component at night.
* **Frequent winter inversions** during calms. They cause accumulation "especially inside street canyons"
  (Action Plan).
* **Mixing height** (Bešlić et al. 2026, 5 years of Zagreb radiosondes at 12 UTC):
  * MLH < 1 000 m on **44 % of days**, with ~80 % of those in the cold season.
  * **62 of 69 PM10 daily exceedances** occurred on inversion days.

### 7.2 ERA5 reanalysis 2021–2025

Grid point 45.75 N, 16.00 E, 5.6 km SSE of the station
(`meteo/openmeteo_era5_zagreb1_2021_2025.json`, Open-Meteo archive API).

* **10 m wind.**
  * Mean 2.03 m/s, median 1.77 m/s. 3.3 % of hours below 0.5 m/s, **15 % below 1 m/s, 60 % below 2 m/s**.
  * Rose (% of hours): N 6.4, **NNE 12.1, NE 11.8**, ENE 7.3, E 5.0, ESE 3.6, SE 3.5, SSE 3.1, S 4.3,
    SSW 6.5, **SW 10.0**, WSW 6.6, W 4.6, WNW 3.9, NW 4.1, NNW 4.0.
  * The distribution is **bimodal: NNE–NE (24 %) and SSW–WSW (23 %)**.
  * In winter SW rises to 12.4 % and SSW to 8.1 %. In summer NE and ENE are stronger.
  * Diurnal speed ranges from 1.7 m/s (08 h) to 2.5 m/s (15 h).
* **Boundary-layer height** (ERA5 median, m):

  | Period | All hours | Night (00–05 h) | Afternoon (12–15 h) |
  |---|---|---|---|
  | DJF | 145 | 85 | 415 |
  | SON | | 60 | 690 |
  | MAM | | | 1 150 |
  | JJA | | 60 | 1 275 |
  | All year | 220 | 65 | 900 |

### 7.3 ZAGREB-1 station anemometer, 2025

8 607 paired hourly values, from the physics agent's cache.

* Mean **1.36 m/s**, median 1.2 m/s, P90 2.4 m/s, max 7.7 m/s. **36.9 % of hours below 1 m/s** and 6.9 %
  below 0.5 m/s.
* Direction values span only **16°–279°**. There are **no records from WNW-NW-NNW-N**.
* The histogram peaks at **250–260° (WSW, 14.5 %)** and **60–80° (ENE, 13.4 %)**, which is almost exactly the
  Vukovarska axis (86°/266°). This points to **flow channelling by the avenue and intersection**, plus
  sheltering by the 9-storey slab to the NW and tall trees to the N. A vane or offset problem cannot be ruled
  out; it should be checked with DHMZ.
* **Consequence:** do not use the station wind as the model inflow boundary condition. Use ERA5, DHMZ Grič
  or Maksimir, or a rooftop mast. The station wind is a good **validation target** for the simulated
  near-surface flow, especially the along-street channelling.

---

## 8. Literature and key documents (with URLs)

**Station, network and official reports**

1. ISZZ station metadata export (classification, parameters, start dates):
   https://iszz.azo.hr/iskzl/rs/postaja/eMetaList?id=155 and coordinates:
   https://iszz.azo.hr/iskzl/rs/postaja/koordinate
2. DHMZ station page, Zagreb 1: https://meteo.hr/kvaliteta_zraka.php?section=podaci_kz&post=Zagreb+1
   (its location text is wrong, see 1.1).
3. DHMZ (2024), *Izvješće o praćenju kvalitete zraka na postajama Državne mreže ... za 2023.*:
   https://meteo.hr/kz/modeliranje/izvjesce_2023_kvaliteta_zraka.pdf. Source of the 2023 statistics in 1.2.
4. HAOP/ZZOP report for 2024 (national): https://www.haop.hr/hr/novosti/izvjesce-o-pracenju-kvalitete-zraka-na-teritoriju-republike-hrvatske-za-2024-godinu
5. Grad Zagreb (Ekonerg), *Akcijski plan za poboljšanje kvalitete zraka na području Grada Zagreba* (SGGZ 5/15):
   https://eko.zagreb.hr/UserDocsImages/arhiva/dokumenti/Okoli%C5%A1/Zrak/Akcijski%20plan%20pobolj%C5%A1anja%20kvalitete%20zraka%20u%20GZ/Akcijski%20plan%20za%20pobolj%C5%A1anje%20kvalitete%20zraka%20na%20podru%C4%8Dju%20Grada%20Zagreba.pdf
   Contains the emission inventory, time profiles, Zagreb-1 diurnal and weekly analysis, climate and wind
   (Lisac 1984), traffic counts (Slavonska and Jadranska 2014, intersection totals 2009) and the station
   list with addresses.

**Traffic**

6. Fakultet prometnih znanosti (Dec 2017), *Prometna studija područja omeđenog željezničkom prugom, Avenijom
   Marina Držića, Ulicom grada Vukovara i Savskom cestom*:
   https://www.zagreb.hr/UserDocsImages/arhiva/prostorni_planovi/savjetovanje%20s%20javnoscu/prometna%20studija/FPZ_Gredelj_Tesktualni_dio.pdf
   Intersection PCU/h (Tablica 2), degree of saturation (Tablica 3) and LOS, queues and CO/NOx per approach
   (Tablice 8–9) for Miramarska–Vukovarska. It cites the FPZ et al. 2017 central-Zagreb VISSIM model.
7. Pejić G., Bunjevac M., Pečet M., Lulić Z. (2018), *Impact of introduction of low emission zones in the City
   of Zagreb*, Mobility & Vehicle Mechanics 44(4) 27–42:
   https://journals.indexcopernicus.com/api/file/viewByFileId/589859. Peak flows, speeds, the Zagreb Euro
   fleet and COPERT SL emissions; it names Zagreb-1 as the densest-traffic crossing.
8. Vujić M., Dedić L., Majstorović M. (2025), *The Modeling and Application of Dynamic Lane Assignment in Urban
   Areas: A Case Study of Vukovar Street in Zagreb*, Applied Sciences 15(12) 6479, doi:10.3390/app15126479.
   Uses 15-min, 7-day counts on Vukovarska; numbers not extracted because MDPI returned 403.
9. tportal (2019), *Neka zagrebačka raskršća dobila su oznaku F*:
   https://www.tportal.hr/vijesti/clanak/neka-zagrebacka-raskrsca-dobila-su-oznaku-f-evo-sto-to-znaci-foto-20190523
10. Hrvatske ceste (2025), *Brojenje prometa na cestama RH 2024*:
    https://hrvatske-ceste.hr/uploads/documents/attachment_file/file/1827/Brojenje_prometa_na_cestama_Republike_Hrvatske_godine_2024.pdf
    Covers state and county roads only; it has no Zagreb city streets.
11. CVH vehicle statistics (fleet by county and fuel, age): https://www.cvh.hr/gradani/tehnicki-pregled/statistika/
    (xlsx files `/media/5439/…`, `/media/5423/…`, `/media/5429/…`, `/media/5431/…`).
12. Vukić L. (2025), *Mitigation of Urban Air Pollution in Croatia: Current Trends in Establishing Low-Emission
    Zones*, Transportation Research Procedia, doi:10.1016/j.trpro.2025.10.054

**Air quality science using Zagreb data**

13. Bešlić I., Sopčić S., Sever Štrukil Z., Mihajlović D. (2026), *Influence of Mixing Layer Height on Air
    Pollution in the City of Zagreb*, Climate 14(7) 133, doi:10.3390/cli14070133
14. Davila S., Sopčić S., Pehnec G., Bešlić I. (2026), *Annual Levoglucosan Variability ... Urban Background
    Site in Croatia*, Environments 13(4) 196, doi:10.3390/environments13040196. Wood-burning tracer; annual
    PM10 22 µg/m³ at the urban background site.
15. Sopčić S., Pehnec G., Bešlić I. (2024), *Specific biomass burning tracers in air pollution in Zagreb*,
    Atmos. Pollut. Res., doi:10.1016/j.apr.2024.102176
16. Račić N., Ružičić S., Terzić T., Pehnec G., Jakovljević I., Sever Štrukil Z. (2024), *Analyzing the
    relationship between gas consumption and airborne pollutants: case study of Zagreb*, AQAH,
    doi:10.1007/s11869-024-01655-7. Identifies heating and traffic as the main sources.
17. Jakovljević I., Sever Štrukil Z., Godec R., Davila S., Pehnec G. (2020), *Influence of lockdown caused by the
    COVID-19 pandemic on air pollution and carcinogenic content of PM observed in Croatia*, AQAH,
    doi:10.1007/s11869-020-00950-3. Reports NO2 about −35 % at the traffic site during the lockdown (from a
    search snippet).
18. Lovrić M. et al. (2022), *Machine Learning and Meteorological Normalization for Assessment of PM Changes
    during the COVID-19 Lockdown in Zagreb*, IJERPH 19, 6937, doi:10.3390/ijerph19116937
19. Šišović A., Pehnec G., Jakovljević I. et al. (2012), *Polycyclic Aromatic Hydrocarbons at Different
    Crossroads in Zagreb*, Bull. Environ. Contam. Toxicol., doi:10.1007/s00128-011-0516-4. PAHs at traffic
    crossroads.
20. Kranjčić N., Dogančić D., Đurin B., Ptiček Siročić A. (2022), *Analyzing Air Pollutant Reduction
    Possibilities in the City of Zagreb*, ISPRS IJGI 11(4) 259, doi:10.3390/ijgi11040259. Uses Zagreb-1 and
    describes its siting (see 1.1).
21. Petrić V., Račić N., Hrga I., Grgec D., Marić M., Krivohlavek A. (2025), *Assessment of Sensor Data from an
    Air Quality Monitoring Network — ML-Based Recalibration*, Atmosphere 16(12) 1358,
    doi:10.3390/atmos16121358. 35 sensors in Zagreb against national reference stations; uses traffic
    proxies.
22. Davila S. et al. (2025), *Comparison of Sensors for Air Quality Monitoring with Reference Methods in Zagreb*,
    Atmosphere 16(4) 472, doi:10.3390/atmos16040472
23. Perrone M.G. et al. (2018), *Sources and geographic origin of PM in urban areas of the Danube macro-region:
    Zagreb, Budapest and Sofia*: https://pmc.ncbi.nlm.nih.gov/articles/PMC5821697/. Receptor modelling finds
    traffic, biomass burning and secondary aerosol to be the main PM sources in Zagreb.
24. Belis C.A. et al. (2019), *Urban pollution in the Danube and Western Balkans regions: the impact of major
    PM2.5 sources*: https://pmc.ncbi.nlm.nih.gov/articles/PMC6839612/
25. Levels of nitrogen dioxide in the Zagreb air, 1994–1998: https://pubmed.ncbi.nlm.nih.gov/11103527/
26. Lisac I. (1984), *Vjetar u Zagrebu (Prilog poznavanju klime grada Zagreba, II)*, Geofizika 1. Wind
    climatology, cited via the Action Plan.

**Power and heating**

27. HEP, EL-TO new CCGT unit L (150 MWe / 114 MWth, gas, from Nov 2023):
    https://balkangreenenergynews.com/croatias-hep-starts-up-new-unit-at-cogeneration-plant-in-zagreb/ ;
    https://www.hep.hr/projects/el-to-zagreb-ccpp/2549
28. Eko Zagreb, household heating shares: https://eko.zagreb.hr/grijanje/105

---

## 9. Recommended defaults for the model (with justification)

### 9.1 Domain and geometry

* **Domain:** 1.2 km x 1.2 km centred on the station (a 1.5 km box is already downloaded), height ≥ 150 m,
  i.e. more than 5 times the tallest nearby buildings (the 96 m tower is 390 m away and can stay inside).
  The reference LBM runs about 256 x 256 x 64 cells at 4–5 m.
  * **Refine to 2 m** if the GPU allows. The station lies 15–20 m from the Miramarska kerb, and a 4–5 m grid
    barely resolves that gap.
  * Keep the grid **north-up**. Vukovarska (86°) and Miramarska (176°) are within 4° of the grid axes, so
    staircase artefacts are negligible.
* **Buildings:** use DGU / Zagreb 3D or LiDAR heights; OSM tags cover only 18 %. Fallback: 3.2 m per floor
  plus 1.5 m; `house`/`detached` 7 m; `apartments`/`yes` untagged 14.3 m (4 floors).
* **Trees:** porous drag cells for mapped `natural=tree` points (crown radius 4–6 m, height 12–16 m,
  LAD 1.2 m²/m³ in leaf, 0.3 m²/m³ leafless Nov–Apr). Include the large crowns in Park Drage Galića. These
  matter for the station's local flow.

### 9.2 Inflow and meteorology

* **Inflow profile:** log law, with u* from U10.
  * **z0 ≈ 1.0–1.5 m and d ≈ 7 m**. Macdonald et al. (1998) with H ≈ 15 m, λp ≈ 0.23 and λf ≈ 0.18
    gives d/H ≈ 0.45 and z0/H ≈ 0.10.
  * If the inflow is resolved over the explicit buildings, use z0 = 0.5 m upstream.
* **Wind presets:**

  | Preset | Direction | U10 | Notes |
  |---|---|---|---|
  | Default | **045° (NE)** | 2.0 m/s | most frequent (NNE–NE 24 %); oblique to both street axes |
  | SW | 225° | 2.0 m/s | 23 %; winter-favoured |
  | Along Vukovarska | 266° or 86° | | channelling test |
  | Along Miramarska | 356° | | |
  | Calm / stagnant | | 0.7 m/s | 15 % of ERA5 hours < 1 m/s; 37 % at the station |

* **Stability presets:**

  | Preset | Conditions | Mixing lid | Typical season |
  |---|---|---|---|
  | Neutral (default) | | | |
  | Winter stable night | U10 1.0 m/s, L ≈ +50 m | h ≈ 100 m | DJF, ERA5 night median 85 m |
  | Winter day | | h ≈ 400 m | |
  | Summer convective afternoon | U10 2.5 m/s, L ≈ −100 m | h ≈ 1 200 m | |

  Simple toggle rule: cold season plus night gives stable; summer plus 11–17 h gives unstable.
* **Background concentrations:** use **ZAGREB-4** (ISZZ id 303, suburban background) hourly data as the
  inflow background: NO2 ≈ 17, NOx ≈ 25, PM10 ≈ 26, PM2.5 ≈ 16 µg/m³ annual (2025). Mirogojska (id 280) and
  ZAGREB-3 (157) are alternatives. Ozone should also come from ZAGREB-4 (it measures O3).
* **NO2 chemistry:** a primary NO2/NOx of **0.25** (diesel-heavy fleet with a large Euro 4–6 share; typical
  European urban value 0.2–0.3), plus photostationary NO–NO2–O3 titration with background O3. The measured
  annual NO2/NOx at the station is 0.45; it should come out of the chemistry, not be imposed.

### 9.3 Traffic emissions

* **Links and AADT:** see the table in 3.2.

  | Link | AADT (veh/day) |
  |---|---|
  | Vukovarska W | 47 000 |
  | Vukovarska E | 45 000 |
  | Miramarska N | 20 000 |
  | Miramarska S | 12 000 |
  | Trg S. Radića | 4 000 |
  | Residential streets | 1 000 |
  | HBZ | 50 000 |
  | Lučića | 12 000 |

  Split each link by lane geometry, with 50/50 directions. On Miramarska north, put 60 % of the flow on the
  southbound carriageway: it has 4 lanes and a queue.
* **Vehicle mix on the avenues:** cars 86 %, vans 9 %, HDV 3 %, buses 0.5 %, motorcycles 1.5 %. Taken from
  the registered fleet, with HDV raised to the typical urban-arterial level. Diesel shares: 51 % of cars,
  96 % of vans, 100 % of HDVs.
* **Emission factors, per vehicle** (fleet-average 2026, urban arterial at 30–40 km/h):

  | Pollutant | Default (g/veh/km) | Range | Justification |
  |---|---|---|---|
  | NOx (as NO2) | **0.35** | 0.25–0.45 | Pejić 2018 COPERT SL gives 0.32–0.40 at 37–50 km/h for the 2017 fleet; about −10 % for fleet renewal, offset by heavier congestion |
  | NOx, congested/queue (< 20 km/h) | **0.9** (factor ×2.5) | | Pejić: 0.95 at 15 km/h. Apply within 60 m upstream of stop lines in peak hours (LOS F). |
  | PM10 exhaust | 0.010 | 0.005–0.02 | Euro 4–6 DPF share |
  | PM10 non-exhaust (tyre + brake + road) | **0.030** | | EMEP/EEA guidebook urban LDV ≈ 0.02–0.04 |
  | PM10 resuspension, winter (sanding) | +0.03 (toggle) | | Action Plan notes sand/salt episodes |
  | PM2.5 total | 0.020 | | |
  | CO | 0.6 | | |
  | Benzene | 0.004 | | petrol cold start; plus a point-source toggle at the INA station |

  Calibration check: with these defaults, a simple line-source estimate gives a NOx increment of about
  10–20 µg/m³, against a measured +46 µg/m³ over ZAGREB-4. Expect to need the intersection and congestion
  factor, and to fine-tune a **global traffic multiplier** against the ZAGREB-1 minus ZAGREB-4 NOx increment.
  That multiplier should be a visible setting in the UI.
* **Time profiles:** use the weekday hourly table in 3.4, the weekday factors (Sat 0.90, Sun 0.70) and the
  monthly factors (Aug 0.85).

### 9.4 Other sources (toggles)

* **Domestic heating (Oct–Mar):** a volume/area source over low-rise Trnje. As a first cut, spread it
  uniformly over `landuse=residential` with `house`/`detached` buildings.
  * Emission rates: PM10 ≈ 2 µg/m²/s and NOx ≈ 1 µg/m²/s at the evening peak. These come from the 2010
    household PM10 of 1 699 t/yr (74 % of the city total; about 90 % emitted Oct–Mar), spread over ~150 km²
    of built-up area. That averages ~0.65 µg/m²/s in season, rising to 2–3 times that at the evening peak in
    dense Trnje/Donji grad. Household NOx is 851 t/yr, which gives ~0.3 µg/m²/s mean and ~1 at peak. These
    are order-of-magnitude figures, to be calibrated.
  * Diurnal shape: peaks at 08–10 h and 19–22 h.
  * Realistically, much of the station's winter PM10 is the background (ZAGREB-4) term, so the heating toggle
    mainly adds PM2.5, BaP and evening NOx.
* **CHP stacks (EL-TO, TE-TO):** outside the domain. Treat them as a background contribution only; ground
  impact is < 1 % of the PM10 limit.
* **Fuel station (INA Miramarska):** a benzene point source at 151 m N. Optional.
* **Construction dust:** optional PM10 area sources at the four listed sites.

### 9.5 Validation targets

* **Hourly:** NO2, NOx, PM10 and PM2.5 from ISZZ (`postaja=155`; `tipPodatka=1` validated,
  `tipPodatka=0` raw). Compare the model increment against ZAGREB-4.
* **Diurnal:** the weekday NOx increment should peak at 08 h and 18–19 h, with a morning/evening ratio of
  about 1.3.
* **Winter vs summer increment:** NOx is about 66 µg/m³ in DJF and 24 in JJA (2025).
* **Station wind:** channelled ENE/WSW flow at about 1.4 m/s mean.

### 9.6 UI toggles and settings (analogues of the reference repo's stadium features)

| Toggle / setting | Effect |
|---|---|
| Wind direction / speed | presets from 9.2 |
| Stability class | presets from 9.2 |
| Time of day / weekday / month | drives the traffic and heating profiles |
| Traffic multiplier per street | Vukovarska, Miramarska, others |
| "Rush-hour queue" (LOS F) | congestion factor ×2.5 near stop lines |
| LEZ scenario | ban Euro ≤ 2 petrol and Euro ≤ 3 diesel: NOx −38…−46 %, PM −75…−80 % (Pejić et al. 2018) |
| EV / hybrid share | slider; reduces exhaust but not non-exhaust PM |
| Heating season on/off | domestic heating source |
| Winter road sanding | adds resuspension PM10 |
| Trees on/off, leaf-on/leaf-off | porous drag |
| Tram line on/off | resuspension only |
| Background source | ZAGREB-4 live or custom |
| Show measured ZAGREB-1 value | live from ISZZ |

---

## 10. Open issues and uncertainties

1. **No official AADT exists for the Vukovarska and Miramarska links.** The City's Centar za nadzor i
   upravljanje prometom and the FPZ 2017 VISSIM model hold link counts but do not publish them. The Vujić et
   al. 2025 counts (7 days, 15-min intervals) are in the paper, which MDPI blocks from this environment.
   Estimates here carry about ±25 % uncertainty.
2. **Station wind direction:** the complete absence of 280–15° in 2025 needs checking with DHMZ
   (vane or offset versus a sheltering artefact). Check other years as well.
3. **Sampling inlet height after the 2023 modernisation** is unknown; 3 m is the 2012 value.
4. **Road distance:** OSM gives 15–20 m to the Miramarska kerb, while the literature says 5 m. The EoI
   metadata (EEA "distance to kerb") should be checked.
5. **Heating shares** (47 % gas, 33 % district heating, 7 % wood) have no year attached. The 2010 inventory
   is old, though the pattern (wood behind PM10) is supported by the 2024–2026 levoglucosan papers.
6. **Euro-class split for 2026 is estimated**, not published.

---

## 11. Data files saved (`research/data/`)

| File | Contents |
|---|---|
| `osm_station.json` | monitoring stations within 1.5–3 km (ZAGREB-1 = way 1409603653; Vukovarska bicycle counter node 3483644931; Grič meteorological column) |
| `osm_buildings_1500.json` (1.4 MB) | all `building`/`building:part` in the 1.5 km box, with geometry |
| `osm_transport_1500.json` (2.1 MB) | highways, railways and trams, signals (65), stops |
| `osm_landuse_1500.json` (1.6 MB) | landuse, leisure, natural (incl. 1 782 trees), amenity, man_made, power, waterway |
| `osm_context3000.json` (11.7 MB) | 3 km box: buildings, major roads, tram, rail, landuse, parks, water, parking, fuel, chimneys, power |
| `osm_citywide.json` | power plants, chimneys, AQ stations, aerodromes, landfills, WWTPs for the whole city |
| `osm_routes_near_station.json` | route relations on the nearby ways (trams 3, 5, 13, 33; road L10078) |
| `q_*.txt` | the Overpass queries (re-runnable: `curl -A <UA> --data-urlencode data@q_x.txt https://overpass-api.de/api/interpreter`) |
| `iszz_emeta_all.json`, `iszz_koordinate.json` | ISZZ station metadata and coordinates, all stations |
| `dhmz_zagreb1.html` | DHMZ station page |
| `meteo/openmeteo_era5_zagreb1_2021_2025.json` | ERA5 hourly T2, U10, dir, BLH, SW radiation, cloud (Open-Meteo, CC-BY 4.0) |
| `imagery/zagreb1_esri_z19.jpg` | Esri World Imagery mosaic (visual check only; Esri terms) |
| `lit/` | FPZ 2017 traffic study; Pejić 2018; City Action Plan 2015; DHMZ 2023 report; HC 2024 counts (45 MB); CVH xlsx (s01, s11, s12, s14 for 2025), with `.txt` extractions |

Overpass notes:
* overpass-api.de returns **406 without a User-Agent** and intermittent dispatcher timeouts.
* The kumi.systems mirror served stale data (July 2026), so the final files come from the main server
  (base timestamp 2026-09-27T19:42Z).

ISZZ note: the export endpoint rate-limits hard (HTTP 429 "Too many requests" when calls are less than ~1 s
apart, shared across agents on the same IP) and truncates responses at 1 000 rows. Fetch month by month with
pacing; see `fetch_iszz_proto.py`.
