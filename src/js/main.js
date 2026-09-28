// ------------------------------------------------------------------ main (owner: ui)
/*
 * The app: state, UI strings, panel, split 3D views, cameras, the wind/dispersion job wiring, live data, boot and
 * the frame loop. Contract: docs/architecture.md §6.4; UI analogues of the reference controls: critic §4.8.
 *
 * Patterns adapted from maksimir-pod-kisom © 2026 Ivan Rezić (MIT, src/js/main.js): one master camera driven by
 * OrbitControls that both views copy, scissor-split rendering, the 16-step keyboard dial, the per-view busy card
 * with a progress bar, stale numbers while the tunnel computes, and the 350 ms debounce of direction changes.
 *
 * How a change flows (physics §11.5):
 *   - direction, stability group, scenario geometry → a new Aero job (debounced 350 ms). The dir index is
 *     round(from / 22.5) % 16; emission-only scenarios reuse today's field (architecture §6.2);
 *   - everything else (speed, time, traffic, measures, pollutant, background, calibration, slice height) is
 *     recomputed instantly from the cached fields and the receptor LUT, because concentrations are linear in the
 *     source strengths and scale with 1 / U_eff (physics §2.3–2.4).
 *
 * Every call into another owner's module goes through the guarded references in ui_X (typeof checks at load
 * time) and ui_try(), so the page still boots, with a visible notice, when a module is missing or throws.
 * The app does not boot when SELFTEST is set: dist/test.html runs the tests on the same markup.
 *
 * state (the single source of truth for the controls; everything shown is derived from it):
 *   mode        'explore' | 'now' | 'forecast'   explore = manual; now/forecast = weather from ECMWF IFS
 *   preset      id of the last preset applied (cleared by any manual change)
 *   u10, from   10 m wind [m/s] and meteorological "from" bearing [°]; the model's reference wind (IFS U10)
 *   stability   'auto' | 'A'..'F'      auto = SRDT by day, Turner by night (meteo.js stabilityClass)
 *   lid         'auto' | '100' | '315' mixingHeight mode (physics §6.5)
 *   time        epoch ms UTC, hour-ENDING (architecture §2)
 *   met         IFS row {t, u10, wd, blh, t2, cc, sw, source} pinned by "Now"/forecast hours, or null
 *   traffic, trafficA, trafficB   % of the modelled AADT: all roads, Vukovarska (A), Miramarska (B)
 *   congestion, resuspension      rush-hour queues (EF × 2.5, critic §4.6), winter sanding (+0.056 g/km PM10)
 *   heating     'auto' | 'on' | 'off'  domestic heating (group D), auto = October–March (critic §4.6)
 *   leaves      'auto' | 'on' | 'off'  tree crowns, auto = leaf-on May–October (critic §4.3)
 *   bgSource    'auto' | 'z4' | 'cams' | 'clim'  background at the station
 *   scenario    SCENARIOS id for the right view ('today' = emissions-only changes)
 *   measures    {lez, evShare %, eBus, carFreeMiramarska, trafficChange %}  right view only
 *   custom      {x, z, w, d, h, rot}   the user-placed block (scenario 'custom')
 *   pollutant   'no2' | 'nox' | 'pm10' | 'pm25' | 'co' | 'c6h6';  index 'eea' | 'iszz'
 *   calibrated  true = β from calibration.json, false = raw physics (β = 1)
 *   bandLevel   2..6  EAQI band for the street-area share
 *   slice, sliceWhat ('inc' local increment, the default | 'total' background + increment), sliceH,
 *   palette ('cb' colour-blind safe | 'eaqi' official EEA colours; bands of the total only), particles, streaks, xray, lod2,
 *   bcol ('plain'|'year'|'height'), cam, split ('split'|'today'|'scenario')
 *   dataView    'diurnal' | 'monthly' | 'annual' | 'rose'
 */

// ------------------------------------------------------------------ strings (hr + en)
const UI_STRINGS = {
  hr: {
    'ui.title': 'Zrak na raskrižju',
    'ui.intro': 'Mjerna postaja ZAGREB-1 stoji na uglu Vukovarske i Miramarske. Lijevo je kvart kakav jest, desno isti kvart s promjenom koju odabereš. Vjetar kroz 3D model grada (ZG3D 2022, ažuriran LiDAR-om) i širenje ispušnih plinova računa simulacija na grafičkoj kartici, a rezultat se uspoređuje sa stvarnim mjerenjima ISZZ-a.',
    'ui.lang.aria': 'Jezik',
    'ui.stage.aria': '3D usporedba kvarta danas i u odabranom scenariju',
    'ui.loading': 'Gradim kvart oko postaje…',
    'ui.north': 'Sjever',
    'ui.north.short': 'S',
    'ui.view.today': 'Danas',
    'ui.view.today.short': 'Danas',
    'ui.view.today.desc': 'Kvart kakav jest: zgrade iz ZG3D 2022, drvoredi i promet kakav je danas.',
    'ui.view.scenario': 'Scenarij',
    'ui.view.scenario.short': 'Scenarij',
    'ui.busy.aria': 'Izračun vjetra i onečišćenja',
    'ui.stat.inc': 'Od lokalnih izvora',
    'ui.stat.total': '{p} na ulazu postaje',
    'ui.stat.incSub': 'pozadina {bg}',
    'ui.mode.explore': '<b>Istraživanje:</b> vrijeme i vjetar namještaš sam.',
    'ui.mode.now': '<b>Sada:</b> vjetar i vrijeme iz modela ECMWF IFS za tekući sat.',
    'ui.mode.forecast': '<b>Prognoza:</b> sat iz prognoze ECMWF IFS, pozadina iz CAMS-a.',
    'ui.mode.line': '{mode} {time}',
    'ui.span': '{date}, {a}–{b} h',
    'ui.model.more': 'Koliko je točno?',
    'ui.model.lbm': 'Model: 3D simulacija vjetra i širenja, {cal}. {src}',
    'ui.model.cal': 'kalibrirana na mjerenjima iz {period} (β = {beta})',
    'ui.model.raw': 'sirova fizika (β = 1, bez kalibracije)',
    'ui.model.uncal': 'još nije kalibrirana (β = 1)',
    'ui.model.gcal': 'kalibriran (β = {beta})',
    'ui.model.src.lut': 'Brojke na postaji: tablica odziva na mreži od {grid}.',
    'ui.model.src.field': 'Brojke na postaji: polje izračunato u ovom pregledniku, mreža od {grid}.',
    'ui.model.src.fallback': 'Brojke na postaji zasad daje približni model.',
    'ui.model.approx': 'Model: približni (Gaussov, bez 3D strujanja), {cal}. Ovaj preglednik ne može pokrenuti 3D simulaciju vjetra.',
    // now at the station
    'ui.now.h': 'Sada na postaji ZAGREB-1',
    'ui.now.chips.aria': 'Zadnje izmjerene vrijednosti na postaji ZAGREB-1',
    'ui.now.use': 'Koristi sadašnje vrijeme',
    'ui.now.loading': 'Učitavam mjerenja s ISZZ-a…',
    'ui.now.time': 'Zadnji izmjereni sat: {span}',
    'ui.now.at': 'sat do {time}',
    'ui.now.age': 'prije {h} h',
    'ui.now.badge': 'Službeni indeks ISZZ-a: {name} (stare granice EEA, PM kao 24-satni prosjek).',
    'ui.now.badge.none': 'Službeni indeks ISZZ-a trenutno nije dostupan.',
    'ui.now.badge.aria': 'Indeks kvalitete zraka {n}: {name}',
    'ui.now.wind': 'Vjetar na postaji: {u} m/s {dir}. Samo za usporedbu: vjetrokaz stoji uz cestu i nepouzdan je za sjeverne smjerove, pa model uzima vjetar iz ECMWF IFS.',
    'ui.now.wind.none': 'Izmjereni vjetar na postaji nije dostupan.',
    'ui.now.bg': 'Pozadina (ZAGREB-4, prigradska): {list}',
    'ui.now.bg.none': 'Pozadina (ZAGREB-4) nije dostupna.',
    'ui.now.src.live': 'Izvor: ISZZ uživo, izvorni (nevalidirani) satni podaci, učitano {time}.',
    'ui.now.src.baked': 'Mreža nije dostupna: prikazujem zadnje vrijednosti iz ugrađene arhive (stanje {time}). To nisu današnji podaci.',
    'ui.now.src.none': 'Nema ni mjerenja uživo ni ugrađene arhive.',
    'ui.now.src.offline': 'Učitavanje uživo je isključeno (?live=0): prikazujem zadnje vrijednosti iz ugrađene arhive (stanje {time}).',
    'ui.now.src.bakedWait': 'Dok stignu mjerenja uživo: zadnje vrijednosti iz ugrađene arhive (stanje {time}).',
    'ui.now.pm24': '24-satni prosjek',
    'ui.now.missing': 'Nisu se učitali: {list} ({err}); ponovni pokušaj za minutu.',
    'ui.pol.name.ws': 'vjetar (brzina)', 'ui.pol.name.wd': 'vjetar (smjer)',
    'ui.now.hourly': 'satna vrijednost',
    'ui.now.noindex': 'nema indeksa',
    'ui.now.stale': 'zastarjelo',
    // presets
    'ui.presets.h': 'Gotove situacije',
    'ui.preset.winterRush': 'Jutarnja gužva, zima',
    'ui.preset.summerPm': 'Ljetno poslijepodne',
    'ui.preset.sundayNight': 'Nedjeljna noć',
    'ui.preset.ne': 'Sjeveroistočnjak',
    'ui.preset.sw': 'Jugozapadnjak',
    'ui.preset.now': 'Sada',
    'ui.preset.fc24': 'Prognoza +24 h',
    'ui.preset.hint.winterRush': 'Utorak u siječnju, 07–08 h: stabilna inverzija (F), poklopac 100 m, slab sjeveroistočnjak, grijanje i kolone.',
    'ui.preset.hint.summerPm': 'Srijeda u srpnju, 15–16 h: nestabilno (B), jugozapadnjak 2 m/s, bez grijanja.',
    'ui.preset.hint.sundayNight': 'Nedjelja u studenom, 23–24 h: slab noćni vjetar sa sjevera niz Medvednicu, malo prometa.',
    'ui.preset.hint.ne': 'Najčešći vjetar: sjeveroistočnjak 1,7 m/s (srednja brzina u IFS-u), neutralno (D).',
    'ui.preset.hint.sw': 'Drugi glavni smjer: jugozapadnjak 2 m/s, neutralno (D).',
    'ui.preset.hint.now': 'Vjetar, oblaci i visina sloja miješanja iz ECMWF IFS za tekući sat; pozadina sa ZAGREB-4.',
    'ui.preset.hint.fc24': 'Isti sat sutra iz prognoze ECMWF IFS; pozadina iz CAMS-a, korigirana prema ZAGREB-4.',
    'ui.preset.fail': 'Prognoza nije dostupna ({err}). Postavke su ostale nepromijenjene.',
    'ui.preset.offline': '„Sada” i „Prognoza +24 h” trebaju mjerenja i prognozu uživo, a učitavanje uživo je isključeno (?live=0).',
    // weather and time
    'ui.weather.h': 'Vjetar i doba dana',
    'ui.wind.speed': 'Vjetar na 10 m',
    'ui.wind.calm': 'Tišina: smjer nije određen, pa model uzima prosjek svih smjerova.',
    'ui.wind.bft': '{name}, {b} bofora na 10 m visine.',
    'ui.dial.aria': 'Smjer iz kojeg puše vjetar',
    'ui.dial.label': 'Smjer',
    'ui.dial.value': 'puše {dir}',
    'ui.dial.valuetext': 'puše {dir}, {deg} stupnjeva',
    'ui.dial.hint': 'Povuci po krugu ili koristi strelice (16 smjerova).',
    'ui.stab.label': 'Stabilnost',
    'ui.stab.auto': 'automatski',
    'ui.stab.A': 'A, vrlo nestabilno',
    'ui.stab.B': 'B, nestabilno',
    'ui.stab.C': 'C, blago nestabilno',
    'ui.stab.D': 'D, neutralno',
    'ui.stab.E': 'E, blago stabilno',
    'ui.stab.F': 'F, stabilno',
    'ui.stab.hint': 'Klasa {cls} ({src}), skupina {grp}. Sloj miješanja {h} m (prikaz); 3D proračun i brojke na postaji koriste poklopac skupine, {hg} m.',
    'ui.stab.src.auto': 'iz sunca, oblaka i vjetra',
    'ui.stab.src.manual': 'ručno',
    'ui.lid.label': 'Poklopac',
    'ui.lid.auto': 'auto',
    'ui.met.src.ifs': 'Oblaci {cc} %, sunčevo zračenje {sw} W/m², sloj miješanja iz IFS-a {blh} m ({src}).',
    'ui.met.src.none': 'Za ovaj sat nema podataka IFS-a: oblaci se pretpostavljaju (50 %), zračenje se procjenjuje iz položaja Sunca, a sloj miješanja uzima medijan klase.',
    'ui.met.src.hist': 'ugrađena arhiva',
    'ui.met.src.live': 'uživo',
    'ui.time.date': 'Datum',
    'ui.time.hour': 'Sat',
    'ui.time.prev': 'Sat ranije',
    'ui.time.next': 'Sat kasnije',
    'ui.time.hint': 'Sat je označen krajem, kao u ISZZ-u: „08:00” je prosjek od 07:00 do 08:00 po lokalnom vremenu.',
    'ui.time.out': '{end} · prosjek {a}–{b} h',
    'ui.time.derived': '{dow}, {daytype} · {month}{heat}',
    'ui.daytype.weekday': 'radni dan',
    'ui.daytype.saturday': 'subota',
    'ui.daytype.sunday': 'nedjelja',
    'ui.heatseason': ' · sezona grijanja',
    'ui.dow.0': 'Nedjelja', 'ui.dow.1': 'Ponedjeljak', 'ui.dow.2': 'Utorak', 'ui.dow.3': 'Srijeda', 'ui.dow.4': 'Četvrtak', 'ui.dow.5': 'Petak', 'ui.dow.6': 'Subota',
    'ui.month.1': 'siječanj', 'ui.month.2': 'veljača', 'ui.month.3': 'ožujak', 'ui.month.4': 'travanj', 'ui.month.5': 'svibanj', 'ui.month.6': 'lipanj',
    'ui.month.7': 'srpanj', 'ui.month.8': 'kolovoz', 'ui.month.9': 'rujan', 'ui.month.10': 'listopad', 'ui.month.11': 'studeni', 'ui.month.12': 'prosinac',
    'ui.mon.1': 'sij', 'ui.mon.2': 'velj', 'ui.mon.3': 'ožu', 'ui.mon.4': 'tra', 'ui.mon.5': 'svi', 'ui.mon.6': 'lip',
    'ui.mon.7': 'srp', 'ui.mon.8': 'kol', 'ui.mon.9': 'ruj', 'ui.mon.10': 'lis', 'ui.mon.11': 'stu', 'ui.mon.12': 'pro',
    // traffic and sources
    'ui.traffic.h': 'Promet i izvori',
    'ui.traffic.all': 'Promet, sve ceste',
    'ui.traffic.A': 'Vukovarska',
    'ui.traffic.B': 'Miramarska',
    'ui.traffic.hint': 'Postotak procijenjenog prometa (Vukovarska ≈ 47 000, Miramarska ≈ 20 000 vozila na dan; javnih brojanja nema). Vrijedi za oba prikaza.',
    'ui.traffic.congestion': 'Kolone u vršnim satima (radnim danom 07–09 h i 15–18 h, emisija × 2,5 kod semafora)',
    'ui.traffic.resusp': 'Zimsko posipanje: podizanje prašine s ceste (PM₁₀ +0,056 g/km)',
    'ui.heating.label': 'Kućna ložišta',
    'ui.heating.auto': 'auto (listopad–ožujak)',
    'ui.heating.on': 'uključena',
    'ui.heating.off': 'isključena',
    'ui.leaves.label': 'Krošnje',
    'ui.leaves.auto': 'auto (svibanj–listopad)',
    'ui.leaves.on': 's lišćem',
    'ui.leaves.off': 'bez lišća',
    'ui.bg.label': 'Pozadina na postaji',
    'ui.bg.auto': 'najbolje dostupno',
    'ui.bg.z4': 'ZAGREB-4 (izmjereno)',
    'ui.bg.cams': 'CAMS, korigiran',
    'ui.bg.clim': 'klimatologija ZAGREB-4',
    'ui.sources.hint': 'Kućna ložišta: {heat}. Krošnje: {leaves}. Pozadina: {bg}. Promjena krošanja traži novi izračun vjetra.',
    'ui.on': 'uključeno', 'ui.off': 'isključeno',
    'ui.bgsrc.z4live': 'ZAGREB-4 uživo',
    'ui.bgsrc.z4hist': 'ZAGREB-4, arhiva',
    'ui.bgsrc.cams': 'CAMS × omjer',
    'ui.bgsrc.clim': 'klimatologija',
    'ui.bgsrc.default': 'godišnji prosjek 2025.',
    'ui.bgsrc.derived': 'procjena',
    // scenario
    'ui.scen.h': 'Scenarij (desni prikaz)',
    'ui.scen.geo': 'Promjena u prostoru',
    'ui.scen.today': 'Bez promjene u prostoru',
    'ui.scen.today.desc': 'Isti kvart; mijenjaju se samo mjere za promet ispod.',
    'ui.scen.needsFlow': 'Mijenja zgrade ili drveće, pa se vjetar računa posebno za scenarij.',
    'ui.scen.emOnly': 'Mijenja samo emisije, pa koristi današnje strujanje.',
    'ui.scen.unavailable': 'Scenariji prostora nisu dostupni (modul city.js nije učitan); rade samo mjere za promet.',
    'ui.custom.h': 'Vlastita zgrada',
    'ui.custom.place': 'Postavi klikom na desni prikaz',
    'ui.custom.placing': 'Klikni na tlo u desnom prikazu. Esc odustaje.',
    'ui.custom.at': 'Položaj: {x} m {ew}, {z} m {ns} od postaje.',
    'ui.custom.north': 'sjeverno', 'ui.custom.south': 'južno', 'ui.custom.east': 'istočno', 'ui.custom.west': 'zapadno',
    'ui.custom.w': 'Širina', 'ui.custom.d': 'Dubina', 'ui.custom.hgt': 'Visina', 'ui.custom.rot': 'Zakret',
    'ui.measures.h': 'Mjere za promet',
    'ui.measures.lez': 'Zona niskih emisija (bez Euro ≤ 2 benzinaca i ≤ 3 dizelaša: NOₓ −40 %, ispušne čestice −75 %)',
    'ui.measures.ev': 'Udio električnih vozila',
    'ui.measures.ebus': 'Električni autobusi (autobusi čine oko 0,5 % prijeđenih kilometara, pa je NOₓ niži za samo oko 4 %)',
    'ui.measures.carfree': 'Miramarska bez automobila',
    'ui.measures.dtraffic': 'Promjena prometa',
    'ui.measures.hint': 'Mjere vrijede samo za desni prikaz i ne traže novi izračun vjetra. Električna vozila nemaju ispuha, ali i dalje troše gume i kočnice.',
    // pollutant
    'ui.pol.h': 'Onečišćujuća tvar',
    'ui.pol.c6h6': 'benzen',
    'ui.pol.name.no2': 'NO₂', 'ui.pol.name.nox': 'NOₓ', 'ui.pol.name.pm10': 'PM₁₀', 'ui.pol.name.pm25': 'PM₂.₅', 'ui.pol.name.co': 'CO', 'ui.pol.name.c6h6': 'benzen', 'ui.pol.name.o3': 'O₃',
    'ui.pol.hint.no2': 'Dušikov dioksid: dio iz ispuha, većina nastaje reakcijom NO s ozonom u zraku.',
    'ui.pol.hint.nox': 'NO + NO₂ izraženo kao NO₂: najčišći trag prometa.',
    'ui.pol.hint.pm10': 'Uglavnom pozadina iz regije i ložišta; lokalni doprinos prometa je mali.',
    'ui.pol.hint.pm25': 'Uglavnom pozadina; lokalni doprinos prometa je mali.',
    'ui.pol.hint.co': 'Ugljikov monoksid, u mg/m³ kao na ISZZ-u. Nije dio indeksa EAQI.',
    'ui.pol.hint.c6h6': 'Benzen, godišnja granica 5 µg/m³. Nije dio indeksa EAQI.',
    'ui.index.label': 'Indeks kvalitete zraka',
    'ui.index.eea': 'EEA 2024',
    'ui.index.iszz': 'ISZZ (stari)',
    'ui.index.hint': 'EEA je granice razreda postrožila 2024.; ISZZ još koristi stare, pa isti zrak može dobiti različit razred.',
    'ui.eaqi.0': 'nema podataka', 'ui.eaqi.1': 'dobro', 'ui.eaqi.2': 'prihvatljivo', 'ui.eaqi.3': 'umjereno', 'ui.eaqi.4': 'loše', 'ui.eaqi.5': 'vrlo loše', 'ui.eaqi.6': 'izuzetno loše',
    'ui.eaqi.ge': '≥ {name}',
    // comparison
    'ui.cmp.h': 'Usporedba: danas i scenarij',
    'ui.cmp.measure': 'Veličina',
    'ui.cmp.caption': 'Usporedba današnjeg kvarta i scenarija za odabrani sat',
    'ui.cmp.time': 'Odabrani sat: {span} (lokalno vrijeme).',
    'ui.cmp.total': 'Ukupno {p} na ulazu postaje (4 m), {unit}',
    'ui.cmp.inc.u': 'Od lokalnih izvora, {unit}',
    'ui.cmp.bg.u': 'Pozadina, {unit}',
    'ui.cmp.poi': '{name}, 1,5 m iznad tla, {unit}',
    'ui.cmp.poi.none': 'Najbliža škola ili vrtić',
    'ui.cmp.poi.nodata': 'nema u podacima',
    'ui.cmp.share': 'Ulice do 300 m, 1,5 m iznad tla, {band}',
    'ui.cmp.bandLevel': 'Razred za udio ulica',
    'ui.cmp.attr': 'Odakle dolazi (na ulazu postaje)',
    'ui.cmp.group.A': 'Vukovarska', 'ui.cmp.group.B': 'Miramarska', 'ui.cmp.group.C': 'ostale ceste', 'ui.cmp.group.D': 'ložišta', 'ui.cmp.group.bg': 'pozadina',
    'ui.cmp.outside': 'izvan polja',
    'ui.cmp.noband': 'nema indeksa',
    'ui.cmp.nofield': 'čeka polje',
    'ui.cmp.note.lut': 'Brojke na postaji: tablica odziva (LUT) izračunata za 16 smjerova, izglađena po smjeru.',
    'ui.cmp.note.field': 'Brojke na postaji: polje izračunato u ovom pregledniku za ovaj smjer i stabilnost.',
    'ui.cmp.note.fallback': 'Brojke su približne: Gaussov model bez 3D strujanja (nema tablice odziva ni izračunatog polja).',
    'ui.cmp.note.geo': 'Scenarij: {pct} % težine smjerova dolazi iz polja izračunatih za scenarij; ostatak iz današnjih polja ili tablice odziva.',
    'ui.cmp.note.no2split': 'Podjela NO₂ po izvorima razmjerna je podjeli NOₓ (kemija nije linearna).',
    'ui.cmp.note.pm': 'Za PM indeks koristi 24-satni prosjek; ovdje se uspoređuje satna vrijednost.',
    'ui.cmp.note.share': 'Udio ulica računa se na {n} točaka ulica unutar 300 m koje leže u izračunatom polju.',
    'ui.busy.run': 'Simuliram {what}, vjetar {dir}: {pct} %{left}.',
    'ui.busy.left': ', još {n} smjerova',
    'ui.busy.view.today': 'današnji kvart',
    'ui.busy.view.scenario': 'scenarij',
    'ui.busy.compute': 'Računam vjetar {dir}',
    'ui.busy.queued': 'Na redu',
    // model vs measurements
    'ui.val.h': 'Model i mjerenja',
    'ui.hind.title': '{p} na postaji, zadnja 72 sata, {unit}',
    'ui.hind.title.past': '{p} na postaji, 72 sata do {time}, {unit}',
    'ui.hind.meas': 'izmjereno (ISZZ, izvorno)',
    'ui.hind.meas.hist': 'izmjereno (arhiva, izvorno)',
    'ui.hind.valid': 'izmjereno (validirano)',
    'ui.hind.model': 'model',
    'ui.hind.bg': 'pozadina',
    'ui.hind.band': 'model × ½ … × 2',
    'ui.hind.note': 'Svaka točka je sat koji završava u njezino vrijeme (lokalno). Model: vjetar i sloj miješanja iz ECMWF IFS, pozadina sa ZAGREB-4, promet i izvori kako su postavljeni. Validirani podaci objavljuju se jednom godišnje; {valid}.',
    'ui.hind.valid.none': 'za ovo razdoblje još ne postoje',
    'ui.hind.valid.some': 'prikazani su crtkano',
    'ui.hind.valid.loading': 'učitavam ih',
    'ui.hind.loading': 'Učitavam mjerenja i vrijeme za zadnja 72 sata…',
    'ui.hind.none': 'Nema ni mjerenja uživo ni ugrađene arhive za usporedbu.',
    'ui.hind.nomodel': 'Model nije dostupan (model.js nije učitan), pa je prikazano samo mjerenje.',
    'ui.sweep.btn': 'Izračunaj svih 16 smjerova',
    'ui.sweep.running': 'Računam {n} od 16 smjerova…',
    'ui.sweep.done': 'Izračunano svih 16 smjerova za stabilnost {grp}.',
    'ui.sweep.nolbm': 'Bez simulacije strujanja ruža se računa iz tablice odziva ili približnog modela.',
    'ui.rose.title': 'Lokalni doprinos {p} po smjeru vjetra (IFS), {unit}',
    'ui.rose.meas': 'izmjereno (ZAGREB-1 − ZAGREB-4)',
    'ui.rose.model': 'model, isti sati',
    'ui.rose.model.now': 'model, sadašnji sat i brzina',
    'ui.rose.note': 'Isti sati iz ugrađene arhive ({period}): izmjereno je razlika ZAGREB-1 i ZAGREB-4, model je izračunat za svaki sat s njegovim vjetrom, stabilnošću i prometom; oboje je prosječno po smjeru vjetra iz IFS-a. Vjetrokaz postaje ne koristi se.',
    'ui.rose.note.noarchive': 'Nema arhive mjerenja: model je izračunan za odabrani sat i brzinu za svaki od 16 smjerova.',
    'ui.rose.fallbackPol': 'Za {p} nema mjerenja pozadine, pa ruža prikazuje NOₓ.',
    'ui.rose.computing': 'Računam modelnu ružu: {pct} %',
    'ui.rose.n': 'sati',
    'ui.rose.src': 'Za stabilnost {grp} model koristi polja izračunata u ovom pregledniku za {n} od 16 smjerova; ostale daje tablica odziva ili približni model.',
    'ui.cal.h': 'Koliko je točno?',
    'ui.cal.toggle': 'Model',
    'ui.cal.calibrated': 'kalibrirani',
    'ui.cal.raw': 'sirova fizika (β = 1)',
    'ui.cal.status.calibrated': 'Model je kalibriran na mjerenjima {period}: emisije su pomnožene s β = {beta}, a donja granica brzine vjetra je U₀ = {u0} m/s. Tablica pokazuje samo mjesece koji nisu korišteni za kalibraciju.',
    'ui.cal.status.uncalibrated': 'Model još nije kalibriran: β = 1 i U₀ = {u0} m/s su početne vrijednosti. Sirovi Gaussov model s istim emisijama podcjenjuje izmjereni lokalni NOₓ oko četiri puta, pa brojke treba čitati kao usporedbu scenarija, ne kao prognozu razine.',
    'ui.cal.status.fallback-only': 'Kalibriran je samo približni model (Gauss, β = {beta}, U₀ = {u0} m/s, mjerenja {period}); 3D model još nije, pa njegove vrijednosti koriste početni β = 1. Tablica pokazuje samo mjesece koji nisu korišteni za kalibraciju.',
    'ui.cal.model.gauss': 'Gauss',
    'ui.cal.rawShort': 'β = 1',
    'ui.cal.m.RMSE': 'RMSE, µg/m³', 'ui.cal.m.meanObs': 'prosjek izmjereno, µg/m³', 'ui.cal.m.meanMod': 'prosjek model, µg/m³',
    'ui.cal.metric': 'Mjera',
    'ui.cal.model': 'Model',
    'ui.cal.baseline': 'Referentni',
    'ui.cal.crit': 'Kriterij',
    'ui.cal.m.FB': 'FB, pristranost', 'ui.cal.m.NMSE': 'NMSE, raspršenje', 'ui.cal.m.MG': 'MG, geom. pristranost', 'ui.cal.m.VG': 'VG, geom. raspršenje',
    'ui.cal.m.FAC2': 'FAC2, unutar faktora 2', 'ui.cal.m.NAD': 'NAD', 'ui.cal.m.R': 'R, korelacija', 'ui.cal.m.n': 'n, sati',
    'ui.cal.note': 'Mjere po Chang i Hanna (2004), kriteriji za gradove po Hanna i Chang (2012). Referentni model je statistički (sat u tjednu × sektor / U_eff); fizikalni model mora ga nadmašiti prije tvrdnje o vještini. {notes}',
    'ui.cal.nometrics': 'Mjere na neviđenim podacima još ne postoje.',
    'ui.cal.what': 'Mjere su za satni lokalni doprinos NOₓ (ZAGREB-1 − ZAGREB-4) u mjesecima koji nisu korišteni za kalibraciju.',
    'ui.cal.same': 'Kalibracije još nema, pa oba izbora daju β = 1.',
    'ui.cal.verdict.all': 'Na neviđenim podacima model je bolji od referentnog na R, NMSE i VG, trima mjerama koje mora nadmašiti prije tvrdnje o vještini.',
    'ui.cal.verdict.partial': 'Prema referentnom modelu: bolji na {better}, lošiji na {worse}. Vještina iznad klimatologije zato još nije pokazana na sve tri mjere (R, NMSE, VG).',
    'ui.lut.h': 'Tablica odziva i rezervni model',
    'ui.lut.ok': 'Tablica odziva: {dirs} smjerova × {cls} skupine stabilnosti, mreža {grid}, izračunana {date}. Nova polja iz ovog preglednika zamjenjuju je za svoj smjer.',
    'ui.lut.none': 'Tablica odziva još nije izračunana. Brojke na postaji dolaze iz polja izračunatih u ovom pregledniku, a dok ih nema, iz približnog Gaussova modela.',
    'ui.lut.nolbm': 'Ovaj preglednik ne može pokrenuti simulaciju strujanja (nema float render targeta). Svi rezultati su iz približnog modela bez 3D strujanja.',
    'ui.lut.noaero': 'Modul simulacije (aero.js) nije učitan, pa se prikazuje približni model.',
    'ui.lut.export': 'Izvezi LUT (JSON)',
    'ui.lut.exported': 'Tablica odziva preuzeta.',
    // forecast
    'ui.fc.h': 'Prognoza',
    'ui.fc.title': '{p} na postaji, sljedeća 72 sata, {unit}',
    'ui.fc.today': 'danas',
    'ui.fc.scenario': 'scenarij',
    'ui.fc.bg': 'pozadina (CAMS, korigiran)',
    'ui.fc.note': 'Svaka točka je sat koji završava u njezino vrijeme (lokalno). Vrijeme: ECMWF IFS. Pozadina: CAMS pomnožen omjerom izmjerenog i CAMS-a na ZAGREB-4 u zadnjih 14 dana ({ratios}). Klikni sat da ga postaviš u 3D prikazu. Scenarij u prognozi uključuje samo mjere za promet.',
    'ui.fc.ratio.live': 'uživo',
    'ui.fc.ratio.default': 'omjeri iz 2025.',
    'ui.fc.nocams': 'CAMS Europe seže samo do 96 h od ponoćnog izračuna, pa za {n} h na kraju prognoze pozadina nije iz CAMS-a nego: {src}.',
    'ui.fc.loading': 'Učitavam prognozu…',
    'ui.fc.fail': 'Prognoza nije dostupna: {err}',
    'ui.fc.load': 'Osvježi prognozu',
    'ui.fc.offline': 'Učitavanje uživo je isključeno (?live=0).',
    // data
    'ui.data.h': 'Podaci',
    'ui.data.view': 'Prikaz podataka',
    'ui.data.diurnal': 'Dnevni hod',
    'ui.data.monthly': 'Mjesečno',
    'ui.data.annual': 'Godišnje',
    'ui.data.rose': 'Ruža',
    'ui.data.t.diurnal': '{p} po satu u danu, prosjek {period}, {unit}',
    'ui.data.t.monthly': '{p} po mjesecima, prosjek {period}, {unit}',
    'ui.data.t.annual': '{p}, godišnji prosjek i granice, {unit}',
    'ui.data.t.rose': '{p} po smjeru vjetra (IFS), {unit}',
    'ui.data.weekday': 'radni dan', 'ui.data.saturday': 'subota', 'ui.data.sunday': 'nedjelja', 'ui.data.bgweekday': 'ZAGREB-4, radni dan',
    'ui.data.mean': 'prosjek',
    'ui.data.note.diurnal': 'Sat je početak intervala po lokalnom vremenu. Jutarnji i večernji vrh su promet.',
    'ui.data.note.annual': 'Samo godine s barem 75 % sati. Crtkane linije: granica EU koja vrijedi sada, granica EU od 2030. i smjernica WHO 2021.',
    'ui.data.note.rose': 'Prosjek izmjerene vrijednosti na ZAGREB-1 po smjeru vjetra iz modela IFS (ne s vjetrokaza postaje).',
    'ui.data.exceed': 'Prekoračenja po godinama',
    'ui.data.period': 'Arhiva: {a} – {b}, pokrivenost {p} {cov} %.',
    'ui.data.none': 'Ova verzija stranice nema ugrađenu arhivu mjerenja (pokreni tools/build_measurements.py).',
    'ui.exc.no2_1h_200': 'NO₂, sati iznad 200 µg/m³ (dopušteno 18)',
    'ui.exc.pm10_24h_50': 'PM₁₀, dani iznad 50 µg/m³ (dopušteno 35)',
    'ui.exc.pm10_24h_45': 'PM₁₀, dani iznad 45 µg/m³ (od 2030. dopušteno 18)',
    'ui.exc.pm25_24h_25': 'PM₂.₅, dani iznad 25 µg/m³ (od 2030. dopušteno 18)',
    'ui.exc.no2_24h_50': 'NO₂, dani iznad 50 µg/m³ (od 2030. dopušteno 18)',
    'ui.exc.so2_1h_350': 'SO₂, sati iznad 350 µg/m³ (dopušteno 24)',
    'ui.exc.so2_24h_125': 'SO₂, dani iznad 125 µg/m³ (dopušteno 3)',
    'ui.exc.pm10_24h_50_ref': 'PM₁₀, referentna (gravimetrijska) metoda, dani iznad 50 µg/m³ (dopušteno 35)',
    'ui.exc.pm10_24h_45_ref': 'PM₁₀, referentna (gravimetrijska) metoda, dani iznad 45 µg/m³ (od 2030. dopušteno 18)',
    'ui.data.ytd': '{y}: do {d}, pa brojevi još nisu godišnji.',
    'ui.lim.eu': 'EU {v}',
    'ui.lim.eu2030': 'EU 2030. {v}',
    'ui.lim.who': 'WHO {v}',
    'ui.lim.eu1h': 'EU 1 h {v}',
    'ui.lim.eu24': 'EU 24 h {v}',
    'ui.lim.eu8h': 'EU 8 h {v}',
    'ui.lim.euyr': 'EU god. {v}',
    // on the map, groups
    'ui.map.h': 'Na karti',
    'ui.map.what': 'Boja presjeka prikazuje',
    'ui.map.what.inc': 'lokalne izvore',
    'ui.map.what.total': 'ukupno',
    'ui.map.what.hint.inc': 'Koliko promet i kućna ložišta dodaju povrh pozadine. Pozadina je ista na cijeloj karti, pa se tako vide ulice i kamo vjetar nosi ispuh.',
    'ui.map.what.hint.total': 'Pozadina + lokalni izvori, u razredima indeksa kvalitete zraka (za NOₓ, CO i benzen prema graničnim vrijednostima).',
    'ui.map.stale': 'Dok se računa novo polje, presjek je od prethodnog izračuna i prikazan je blijeđe.',
    'ui.map.approx': 'Presjek daje približni model bez 3D strujanja.',
    'ui.adv.h': 'Napredne postavke',
    'ui.adv.sub': 'stabilnost, promet i izvori, indeks, prikaz',
    'ui.adv.weather': 'Stabilnost i sloj miješanja',
    'ui.val.sub': 'zadnja 72 sata, ruža smjerova, točnost',
    'ui.fc.sub': 'sljedeća 72 sata (ECMWF IFS, CAMS)',
    'ui.data.sub': 'arhiva mjerenja postaje ZAGREB-1',
    // display
    'ui.disp.h': 'Prikaz',
    'ui.disp.slice': 'Presjek koncentracije na odabranoj visini',
    'ui.disp.sliceH': 'Visina presjeka',
    'ui.disp.sliceH.hint': 'Zadano 4 m, visina ulaza postaje; 1,5 m je visina disanja.',
    'ui.disp.palette': 'Boje presjeka',
    'ui.disp.palette.cb': 'jedna boja (za sve)',
    'ui.disp.palette.eaqi': 'boje indeksa EEA',
    'ui.disp.palette.hint': 'Vrijedi za kartu „ukupno”. Karta lokalnih izvora ima svoju ljestvicu (jedna ljubičasta boja, linearna od nule).',
    'ui.disp.particles': 'Čestice iz ispuha uz ceste (samo prikaz)',
    'ui.disp.streaks': 'Tragovi vjetra',
    'ui.disp.xray': 'Prozirne zgrade',
    'ui.disp.lod2': 'Detaljni krovovi (LoD2, do 500 m)',
    'ui.disp.bcol': 'Boja zgrada',
    'ui.disp.bcol.plain': 'jednobojno',
    'ui.disp.bcol.year': 'godina snimanja',
    'ui.disp.bcol.height': 'visina',
    'ui.disp.bcol.hint.year': 'Godina izvora u ZG3D: 2008, 2019 ili 2022 (LiDAR).',
    'ui.disp.bcol.hint.height': 'Visina zgrade iznad tla.',
    'ui.disp.legend.none': 'Legenda nije dostupna (visuals.js nije učitan).',
    'ui.cam.label': 'Pogled',
    'ui.cam.air': 'Iz zraka',
    'ui.cam.station': 'S postaje',
    'ui.cam.vukovarska': 'Niz Vukovarsku',
    'ui.cam.plan': 'Tlocrt',
    'ui.split.label': 'Prikazi',
    'ui.split.split': 'Oba',
    // footer
    'ui.foot.method': 'Vjetar računa 3D simulacija strujanja zraka (Lattice-Boltzmann D3Q19 s modelom turbulencije) kroz kvart od 600 × 600 m za odabrani smjer: najprije na mreži od {spin} m, zatim na ćelijama od {dx} m. Onečišćenje se širi po tom strujanju (stacionarna advekcija i difuzija) iz četiri skupine izvora: Vukovarska, Miramarska, ostale ceste i kućna ložišta. NO₂ nastaje reakcijom s ozonom iz pozadine. Jačina vjetra samo skalira rezultat, uz donju granicu U₀ za tišine.',
    'ui.foot.limits.pre': 'Model je alat za učenje i usporedbu scenarija, a ne službena prognoza.',
    'ui.foot.limits': 'Što model ne zna (ograničenja)',
    'ui.foot.notofficial': 'Službene podatke i upozorenja objavljuju DHMZ i Ministarstvo (iszz.azo.hr).',
    'ui.foot.credit': 'Prema projektu Maksimir pod kišom (Ivan Rezić, MIT): isti raspored, 3D prikaz i zračni tunel na grafičkoj kartici.',
    // notices and errors
    'ui.err.module': 'Dio stranice nije učitan: {m}',
    'ui.err.missing': 'Modul {m} nije dostupan: {what}.',
    'ui.err.what.scene': '3D prikaz se ne crta',
    'ui.err.what.city': 'grad se ne gradi',
    'ui.err.what.model': 'brojke na postaji nisu dostupne',
    'ui.err.what.visuals': 'presjek, čestice i oznake se ne crtaju',
    'ui.err.what.aero': 'strujanje se ne računa',
    'ui.err.what.fallback': 'nema rezervnog modela',
    'ui.err.what.chem': 'indeks i granice koriste ugrađenu tablicu',
    'ui.err.what.emissions': 'emisije nisu dostupne',
    'ui.err.live': 'Mjerenja uživo nisu dostupna',
    'ui.err.live.text': '{err}. Prikazane su vrijednosti iz ugrađene arhive gdje postoje.',
    'ui.err.fc': 'Prognoza nije dostupna',
    'ui.note.fallback': 'Približni model bez 3D strujanja: ovaj preglednik ne može pokrenuti simulaciju vjetra.',
    'ui.note.stale': 'Brojke su od prethodnog izračuna dok se novi ne završi.',
    'ui.note.software': 'Softverski WebGL: mreža je grublja, a dok se računa vjetar, 3D se crta najviše svakih {s} s (osim dok pomičeš pogled), da simulacija dobije procesor.',
  },
  en: {
    'ui.title': 'Air at the crossroads',
    'ui.intro': 'The ZAGREB-1 monitoring station stands on the corner of Vukovarska and Miramarska. On the left is the neighbourhood as it is, on the right the same neighbourhood with a change you choose. A GPU simulation computes the wind through the 3D city model (ZG3D 2022, updated with LiDAR) and how exhaust spreads, and compares the result with real ISZZ measurements.',
    'ui.lang.aria': 'Language',
    'ui.stage.aria': '3D comparison of the neighbourhood today and in the chosen scenario',
    'ui.loading': 'Building the neighbourhood around the station…',
    'ui.north': 'North',
    'ui.north.short': 'N',
    'ui.view.today': 'Today',
    'ui.view.today.short': 'Today',
    'ui.view.today.desc': 'The neighbourhood as it is: ZG3D 2022 buildings, street trees and today\'s traffic.',
    'ui.view.scenario': 'Scenario',
    'ui.view.scenario.short': 'Scenario',
    'ui.busy.aria': 'Computing wind and pollution',
    'ui.stat.inc': 'From local sources',
    'ui.stat.total': '{p} at the station inlet',
    'ui.stat.incSub': 'background {bg}',
    'ui.mode.explore': '<b>Explore:</b> you set the weather and the wind.',
    'ui.mode.now': '<b>Now:</b> wind and weather from ECMWF IFS for the current hour.',
    'ui.mode.forecast': '<b>Forecast:</b> an hour from the ECMWF IFS forecast, background from CAMS.',
    'ui.mode.line': '{mode} {time}',
    'ui.span': '{date}, {a}–{b} h',
    'ui.model.more': 'How good is it?',
    'ui.model.lbm': 'Model: 3D wind and dispersion simulation, {cal}. {src}',
    'ui.model.cal': 'calibrated on {period} measurements (β = {beta})',
    'ui.model.raw': 'raw physics (β = 1, not calibrated)',
    'ui.model.uncal': 'not calibrated yet (β = 1)',
    'ui.model.gcal': 'calibrated (β = {beta})',
    'ui.model.src.lut': 'Station numbers: response table on the {grid} grid.',
    'ui.model.src.field': 'Station numbers: a field computed in this browser on the {grid} grid.',
    'ui.model.src.fallback': 'Station numbers come from the approximate model for now.',
    'ui.model.approx': 'Model: approximate (Gaussian, no 3D flow), {cal}. This browser cannot run the 3D wind simulation.',
    'ui.now.h': 'Now at the ZAGREB-1 station',
    'ui.now.chips.aria': 'Latest measured values at ZAGREB-1',
    'ui.now.use': 'Use current conditions',
    'ui.now.loading': 'Loading measurements from ISZZ…',
    'ui.now.time': 'Latest measured hour: {span}',
    'ui.now.at': 'hour to {time}',
    'ui.now.age': '{h} h ago',
    'ui.now.badge': 'Official ISZZ index: {name} (legacy EEA bands, PM as a 24 h mean).',
    'ui.now.badge.none': 'The official ISZZ index is not available right now.',
    'ui.now.badge.aria': 'Air quality index {n}: {name}',
    'ui.now.wind': 'Wind at the station: {u} m/s {dir}. For reference only: the vane stands by the road and is unreliable for northerly winds, so the model uses the ECMWF IFS wind.',
    'ui.now.wind.none': 'Station wind is not available.',
    'ui.now.bg': 'Background (ZAGREB-4, suburban): {list}',
    'ui.now.bg.none': 'Background (ZAGREB-4) is not available.',
    'ui.now.src.live': 'Source: ISZZ live, raw (unvalidated) hourly data, loaded {time}.',
    'ui.now.src.baked': 'Network unavailable: showing the latest values from the baked archive (as of {time}). These are not today\'s data.',
    'ui.now.src.none': 'Neither live measurements nor a baked archive are available.',
    'ui.now.src.offline': 'Live loading is switched off (?live=0): showing the latest values from the baked archive (as of {time}).',
    'ui.now.src.bakedWait': 'Until the live measurements arrive: the latest values from the baked archive (as of {time}).',
    'ui.now.pm24': '24 h mean',
    'ui.now.missing': 'Not loaded: {list} ({err}); retrying in a minute.',
    'ui.pol.name.ws': 'wind speed', 'ui.pol.name.wd': 'wind direction',
    'ui.now.hourly': 'hourly value',
    'ui.now.noindex': 'no index',
    'ui.now.stale': 'stale',
    'ui.presets.h': 'Presets',
    'ui.preset.winterRush': 'Winter morning rush',
    'ui.preset.summerPm': 'Summer afternoon',
    'ui.preset.sundayNight': 'Sunday night',
    'ui.preset.ne': 'NE wind',
    'ui.preset.sw': 'SW wind',
    'ui.preset.now': 'Now',
    'ui.preset.fc24': 'Forecast +24 h',
    'ui.preset.hint.winterRush': 'A Tuesday in January, 07–08 h: stable inversion (F), 100 m lid, light NE wind, heating and queues.',
    'ui.preset.hint.summerPm': 'A Wednesday in July, 15–16 h: unstable (B), SW wind 2 m/s, no heating.',
    'ui.preset.hint.sundayNight': 'A Sunday in November, 23–24 h: light night wind from the north down Medvednica, little traffic.',
    'ui.preset.hint.ne': 'The most frequent wind: NE at 1.7 m/s (the IFS mean speed), neutral (D).',
    'ui.preset.hint.sw': 'The other main direction: SW at 2 m/s, neutral (D).',
    'ui.preset.hint.now': 'Wind, cloud and mixing height from ECMWF IFS for the current hour; background from ZAGREB-4.',
    'ui.preset.hint.fc24': 'The same hour tomorrow from the ECMWF IFS forecast; background from CAMS, corrected to ZAGREB-4.',
    'ui.preset.fail': 'The forecast is not available ({err}). Settings are unchanged.',
    'ui.preset.offline': '"Now" and "Forecast +24 h" need live measurements and the forecast, and live loading is switched off (?live=0).',
    'ui.weather.h': 'Wind and time of day',
    'ui.wind.speed': 'Wind at 10 m',
    'ui.wind.calm': 'Calm: the direction is undefined, so the model averages over all directions.',
    'ui.wind.bft': '{name}, force {b} on the Beaufort scale at 10 m.',
    'ui.dial.aria': 'Direction the wind blows from',
    'ui.dial.label': 'Direction',
    'ui.dial.value': 'blowing {dir}',
    'ui.dial.valuetext': 'blowing {dir}, {deg} degrees',
    'ui.dial.hint': 'Drag round the circle or use the arrow keys (16 directions).',
    'ui.stab.label': 'Stability',
    'ui.stab.auto': 'automatic',
    'ui.stab.A': 'A, very unstable',
    'ui.stab.B': 'B, unstable',
    'ui.stab.C': 'C, slightly unstable',
    'ui.stab.D': 'D, neutral',
    'ui.stab.E': 'E, slightly stable',
    'ui.stab.F': 'F, stable',
    'ui.stab.hint': 'Class {cls} ({src}), group {grp}. Mixing layer {h} m (shown); the 3D solve and the station numbers use the group’s lid, {hg} m.',
    'ui.stab.src.auto': 'from sun, cloud and wind',
    'ui.stab.src.manual': 'manual',
    'ui.lid.label': 'Lid',
    'ui.lid.auto': 'auto',
    'ui.met.src.ifs': 'Cloud {cc} %, solar radiation {sw} W/m², IFS mixing height {blh} m ({src}).',
    'ui.met.src.none': 'No IFS data for this hour: cloud is assumed (50 %), radiation is estimated from the sun\'s position, and the mixing height is the class median.',
    'ui.met.src.hist': 'baked archive',
    'ui.met.src.live': 'live',
    'ui.time.date': 'Date',
    'ui.time.hour': 'Hour',
    'ui.time.prev': 'One hour earlier',
    'ui.time.next': 'One hour later',
    'ui.time.hint': 'Hours are labelled by their end, as in ISZZ: "08:00" is the mean from 07:00 to 08:00 local time.',
    'ui.time.out': '{end} · mean {a}–{b} h',
    'ui.time.derived': '{dow}, {daytype} · {month}{heat}',
    'ui.daytype.weekday': 'weekday',
    'ui.daytype.saturday': 'Saturday',
    'ui.daytype.sunday': 'Sunday',
    'ui.heatseason': ' · heating season',
    'ui.dow.0': 'Sunday', 'ui.dow.1': 'Monday', 'ui.dow.2': 'Tuesday', 'ui.dow.3': 'Wednesday', 'ui.dow.4': 'Thursday', 'ui.dow.5': 'Friday', 'ui.dow.6': 'Saturday',
    'ui.month.1': 'January', 'ui.month.2': 'February', 'ui.month.3': 'March', 'ui.month.4': 'April', 'ui.month.5': 'May', 'ui.month.6': 'June',
    'ui.month.7': 'July', 'ui.month.8': 'August', 'ui.month.9': 'September', 'ui.month.10': 'October', 'ui.month.11': 'November', 'ui.month.12': 'December',
    'ui.mon.1': 'Jan', 'ui.mon.2': 'Feb', 'ui.mon.3': 'Mar', 'ui.mon.4': 'Apr', 'ui.mon.5': 'May', 'ui.mon.6': 'Jun',
    'ui.mon.7': 'Jul', 'ui.mon.8': 'Aug', 'ui.mon.9': 'Sep', 'ui.mon.10': 'Oct', 'ui.mon.11': 'Nov', 'ui.mon.12': 'Dec',
    'ui.traffic.h': 'Traffic and sources',
    'ui.traffic.all': 'Traffic, all roads',
    'ui.traffic.A': 'Vukovarska',
    'ui.traffic.B': 'Miramarska',
    'ui.traffic.hint': 'Percent of the estimated traffic (Vukovarska ≈ 47,000, Miramarska ≈ 20,000 vehicles a day; there are no public counts). Applies to both views.',
    'ui.traffic.congestion': 'Rush-hour queues (weekdays 07–09 h and 15–18 h, emissions × 2.5 near the lights)',
    'ui.traffic.resusp': 'Winter sanding: road dust resuspension (PM₁₀ +0.056 g/km)',
    'ui.heating.label': 'Domestic heating',
    'ui.heating.auto': 'auto (October–March)',
    'ui.heating.on': 'on',
    'ui.heating.off': 'off',
    'ui.leaves.label': 'Tree crowns',
    'ui.leaves.auto': 'auto (May–October)',
    'ui.leaves.on': 'in leaf',
    'ui.leaves.off': 'bare',
    'ui.bg.label': 'Background at the station',
    'ui.bg.auto': 'best available',
    'ui.bg.z4': 'ZAGREB-4 (measured)',
    'ui.bg.cams': 'CAMS, corrected',
    'ui.bg.clim': 'ZAGREB-4 climatology',
    'ui.sources.hint': 'Domestic heating: {heat}. Tree crowns: {leaves}. Background: {bg}. Changing the crowns needs a new wind run.',
    'ui.on': 'on', 'ui.off': 'off',
    'ui.bgsrc.z4live': 'ZAGREB-4 live',
    'ui.bgsrc.z4hist': 'ZAGREB-4, archive',
    'ui.bgsrc.cams': 'CAMS × ratio',
    'ui.bgsrc.clim': 'climatology',
    'ui.bgsrc.default': '2025 annual mean',
    'ui.bgsrc.derived': 'estimate',
    'ui.scen.h': 'Scenario (right view)',
    'ui.scen.geo': 'Change to the place',
    'ui.scen.today': 'No change to the place',
    'ui.scen.today.desc': 'The same neighbourhood; only the traffic measures below change.',
    'ui.scen.needsFlow': 'Changes buildings or trees, so the wind is computed separately for the scenario.',
    'ui.scen.emOnly': 'Changes emissions only, so it reuses today\'s flow.',
    'ui.scen.unavailable': 'Geometry scenarios are not available (city.js is not loaded); only the traffic measures work.',
    'ui.custom.h': 'Your own building',
    'ui.custom.place': 'Place by clicking the right view',
    'ui.custom.placing': 'Click the ground in the right view. Esc cancels.',
    'ui.custom.at': 'Position: {x} m {ew}, {z} m {ns} of the station.',
    'ui.custom.north': 'north', 'ui.custom.south': 'south', 'ui.custom.east': 'east', 'ui.custom.west': 'west',
    'ui.custom.w': 'Width', 'ui.custom.d': 'Depth', 'ui.custom.hgt': 'Height', 'ui.custom.rot': 'Rotation',
    'ui.measures.h': 'Traffic measures',
    'ui.measures.lez': 'Low-emission zone (no Euro ≤ 2 petrol or ≤ 3 diesel cars: NOₓ −40 %, exhaust particles −75 %)',
    'ui.measures.ev': 'Share of electric vehicles',
    'ui.measures.ebus': 'Electric buses (buses are about 0.5 % of vehicle-km, so NOₓ falls by only about 4 %)',
    'ui.measures.carfree': 'Car-free Miramarska',
    'ui.measures.dtraffic': 'Traffic change',
    'ui.measures.hint': 'Measures apply to the right view only and need no new wind run. Electric vehicles have no exhaust but still wear tyres and brakes.',
    'ui.pol.h': 'Pollutant',
    'ui.pol.c6h6': 'benzene',
    'ui.pol.name.no2': 'NO₂', 'ui.pol.name.nox': 'NOₓ', 'ui.pol.name.pm10': 'PM₁₀', 'ui.pol.name.pm25': 'PM₂.₅', 'ui.pol.name.co': 'CO', 'ui.pol.name.c6h6': 'benzene', 'ui.pol.name.o3': 'O₃',
    'ui.pol.hint.no2': 'Nitrogen dioxide: part of it comes from exhaust, most forms when NO reacts with ozone in the air.',
    'ui.pol.hint.nox': 'NO + NO₂ expressed as NO₂: the cleanest tracer of traffic.',
    'ui.pol.hint.pm10': 'Mostly regional background and domestic heating; the local traffic increment is small.',
    'ui.pol.hint.pm25': 'Mostly background; the local traffic increment is small.',
    'ui.pol.hint.co': 'Carbon monoxide, in mg/m³ as on ISZZ. Not part of the EAQI.',
    'ui.pol.hint.c6h6': 'Benzene, annual limit 5 µg/m³. Not part of the EAQI.',
    'ui.index.label': 'Air quality index',
    'ui.index.eea': 'EEA 2024',
    'ui.index.iszz': 'ISZZ (legacy)',
    'ui.index.hint': 'The EEA tightened the band limits in 2024; ISZZ still uses the old ones, so the same air can get a different band.',
    'ui.eaqi.0': 'no data', 'ui.eaqi.1': 'good', 'ui.eaqi.2': 'fair', 'ui.eaqi.3': 'moderate', 'ui.eaqi.4': 'poor', 'ui.eaqi.5': 'very poor', 'ui.eaqi.6': 'extremely poor',
    'ui.eaqi.ge': '≥ {name}',
    'ui.cmp.h': 'Comparison: today and scenario',
    'ui.cmp.measure': 'Quantity',
    'ui.cmp.caption': 'Today\'s neighbourhood and the scenario compared for the selected hour',
    'ui.cmp.time': 'Selected hour: {span} (local time).',
    'ui.cmp.total': 'Total {p} at the station inlet (4 m), {unit}',
    'ui.cmp.inc.u': 'From local sources, {unit}',
    'ui.cmp.bg.u': 'Background, {unit}',
    'ui.cmp.poi': '{name}, 1.5 m above ground, {unit}',
    'ui.cmp.poi.none': 'Nearest school or kindergarten',
    'ui.cmp.poi.nodata': 'none in the data',
    'ui.cmp.share': 'Streets within 300 m, 1.5 m above ground, {band}',
    'ui.cmp.bandLevel': 'Band for the street share',
    'ui.cmp.attr': 'Where it comes from (at the station inlet)',
    'ui.cmp.group.A': 'Vukovarska', 'ui.cmp.group.B': 'Miramarska', 'ui.cmp.group.C': 'other roads', 'ui.cmp.group.D': 'heating', 'ui.cmp.group.bg': 'background',
    'ui.cmp.outside': 'outside field',
    'ui.cmp.noband': 'no index',
    'ui.cmp.nofield': 'awaiting field',
    'ui.cmp.note.lut': 'Station numbers: the response table (LUT) computed for 16 directions, smoothed over direction.',
    'ui.cmp.note.field': 'Station numbers: a field computed in this browser for this direction and stability.',
    'ui.cmp.note.fallback': 'Numbers are approximate: a Gaussian model without 3D flow (no response table and no computed field).',
    'ui.cmp.note.geo': 'Scenario: {pct} % of the direction weighting comes from fields computed for the scenario; the rest from today\'s fields or the response table.',
    'ui.cmp.note.no2split': 'The NO₂ split by source is in proportion to the NOₓ split (the chemistry is not linear).',
    'ui.cmp.note.pm': 'For PM the index uses a 24 h mean; here the hourly value is compared.',
    'ui.cmp.note.share': 'The street share is computed on {n} street points within 300 m that lie inside the computed field.',
    'ui.busy.run': 'Simulating {what}, wind {dir}: {pct} %{left}.',
    'ui.busy.left': ', {n} directions to go',
    'ui.busy.view.today': 'today\'s neighbourhood',
    'ui.busy.view.scenario': 'the scenario',
    'ui.busy.compute': 'Computing wind {dir}',
    'ui.busy.queued': 'Queued',
    'ui.val.h': 'Model and measurements',
    'ui.hind.title': '{p} at the station, last 72 hours, {unit}',
    'ui.hind.title.past': '{p} at the station, 72 hours to {time}, {unit}',
    'ui.hind.meas': 'measured (ISZZ, raw)',
    'ui.hind.meas.hist': 'measured (archive, raw)',
    'ui.hind.valid': 'measured (validated)',
    'ui.hind.model': 'model',
    'ui.hind.bg': 'background',
    'ui.hind.band': 'model × ½ … × 2',
    'ui.hind.note': 'Each point is the hour ending at its time (local). Model: wind and mixing height from ECMWF IFS, background from ZAGREB-4, traffic and sources as set. Validated data are published once a year; {valid}.',
    'ui.hind.valid.none': 'they do not exist yet for this period',
    'ui.hind.valid.some': 'they are shown dashed',
    'ui.hind.valid.loading': 'loading them',
    'ui.hind.loading': 'Loading measurements and weather for the last 72 hours…',
    'ui.hind.none': 'No live measurements and no baked archive to compare with.',
    'ui.hind.nomodel': 'The model is not available (model.js is not loaded), so only the measurement is shown.',
    'ui.sweep.btn': 'Compute all 16 directions',
    'ui.sweep.running': 'Computing {n} of 16 directions…',
    'ui.sweep.done': 'All 16 directions computed for stability group {grp}.',
    'ui.sweep.nolbm': 'Without the flow simulation the rose comes from the response table or the approximate model.',
    'ui.rose.title': 'Local increment of {p} by wind direction (IFS), {unit}',
    'ui.rose.meas': 'measured (ZAGREB-1 − ZAGREB-4)',
    'ui.rose.model': 'model, same hours',
    'ui.rose.model.now': 'model, current hour and speed',
    'ui.rose.note': 'The same hours of the baked archive ({period}): measured is ZAGREB-1 minus ZAGREB-4, the model is evaluated for each hour with its own wind, stability and traffic; both are averaged by IFS wind direction. The station vane is not used.',
    'ui.rose.note.noarchive': 'No measurement archive: the model is evaluated at the selected hour and speed for each of the 16 directions.',
    'ui.rose.fallbackPol': 'There is no background measurement for {p}, so the rose shows NOₓ.',
    'ui.rose.computing': 'Computing the model rose: {pct} %',
    'ui.rose.n': 'hours',
    'ui.rose.src': 'For stability group {grp} the model uses fields computed in this browser for {n} of 16 directions; the others come from the response table or the approximate model.',
    'ui.cal.h': 'How good is it?',
    'ui.cal.toggle': 'Model',
    'ui.cal.calibrated': 'calibrated',
    'ui.cal.raw': 'raw physics (β = 1)',
    'ui.cal.status.calibrated': 'The model is calibrated on measurements {period}: emissions are multiplied by β = {beta}, and the low-wind floor is U₀ = {u0} m/s. The table shows only months not used for the fit.',
    'ui.cal.status.uncalibrated': 'The model is not calibrated yet: β = 1 and U₀ = {u0} m/s are prior values. A raw Gaussian model with the same emissions under-predicts the measured local NOₓ by about four times, so read the numbers as a comparison of scenarios, not as a forecast of levels.',
    'ui.cal.status.fallback-only': 'Only the approximate model is calibrated (Gaussian, β = {beta}, U₀ = {u0} m/s, measurements {period}); the 3D model is not yet, so its values use the prior β = 1. The table shows only months not used for the fit.',
    'ui.cal.model.gauss': 'Gaussian',
    'ui.cal.rawShort': 'β = 1',
    'ui.cal.m.RMSE': 'RMSE, µg/m³', 'ui.cal.m.meanObs': 'mean observed, µg/m³', 'ui.cal.m.meanMod': 'mean modelled, µg/m³',
    'ui.cal.metric': 'Metric',
    'ui.cal.model': 'Model',
    'ui.cal.baseline': 'Baseline',
    'ui.cal.crit': 'Criterion',
    'ui.cal.m.FB': 'FB, bias', 'ui.cal.m.NMSE': 'NMSE, scatter', 'ui.cal.m.MG': 'MG, geometric bias', 'ui.cal.m.VG': 'VG, geometric scatter',
    'ui.cal.m.FAC2': 'FAC2, within a factor of 2', 'ui.cal.m.NAD': 'NAD', 'ui.cal.m.R': 'R, correlation', 'ui.cal.m.n': 'n, hours',
    'ui.cal.note': 'Metrics after Chang and Hanna (2004), urban criteria after Hanna and Chang (2012). The baseline is statistical (hour of week × sector / U_eff); the physics model must beat it before claiming skill. {notes}',
    'ui.cal.nometrics': 'There are no held-out metrics yet.',
    'ui.cal.what': 'The metrics are for the hourly local NOₓ increment (ZAGREB-1 − ZAGREB-4) in months not used for the fit.',
    'ui.cal.same': 'There is no calibration yet, so both choices give β = 1.',
    'ui.cal.verdict.all': 'On held-out data the model beats the baseline on R, NMSE and VG, the three measures it must win before claiming skill.',
    'ui.cal.verdict.partial': 'Against the baseline: better on {better}, worse on {worse}. Skill beyond climatology is therefore not yet shown on all three measures (R, NMSE, VG).',
    'ui.lut.h': 'Response table and fallback',
    'ui.lut.ok': 'Response table: {dirs} directions × {cls} stability groups, grid {grid}, computed {date}. New fields from this browser replace it for their direction.',
    'ui.lut.none': 'The response table has not been computed yet. Station numbers come from fields computed in this browser and, until they exist, from the approximate Gaussian model.',
    'ui.lut.nolbm': 'This browser cannot run the flow simulation (no float render targets). All results come from the approximate model without 3D flow.',
    'ui.lut.noaero': 'The simulation module (aero.js) is not loaded, so the approximate model is shown.',
    'ui.lut.export': 'Export LUT (JSON)',
    'ui.lut.exported': 'Response table downloaded.',
    'ui.fc.h': 'Forecast',
    'ui.fc.title': '{p} at the station, next 72 hours, {unit}',
    'ui.fc.today': 'today',
    'ui.fc.scenario': 'scenario',
    'ui.fc.bg': 'background (CAMS, corrected)',
    'ui.fc.note': 'Each point is the hour ending at its time (local). Weather: ECMWF IFS. Background: CAMS times the ratio of measured to CAMS at ZAGREB-4 over the last 14 days ({ratios}). Click an hour to set it in the 3D view. The scenario in the forecast includes the traffic measures only.',
    'ui.fc.ratio.live': 'live',
    'ui.fc.ratio.default': '2025 ratios',
    'ui.fc.nocams': 'CAMS Europe reaches only 96 h from its 00 UTC run, so for the last {n} h of the forecast the background is not CAMS but: {src}.',
    'ui.fc.loading': 'Loading the forecast…',
    'ui.fc.fail': 'The forecast is not available: {err}',
    'ui.fc.load': 'Refresh forecast',
    'ui.fc.offline': 'Live loading is switched off (?live=0).',
    'ui.data.h': 'Data',
    'ui.data.view': 'Data view',
    'ui.data.diurnal': 'Daily cycle',
    'ui.data.monthly': 'Monthly',
    'ui.data.annual': 'Annual',
    'ui.data.rose': 'Rose',
    'ui.data.t.diurnal': '{p} by hour of day, mean {period}, {unit}',
    'ui.data.t.monthly': '{p} by month, mean {period}, {unit}',
    'ui.data.t.annual': '{p}, annual mean and limits, {unit}',
    'ui.data.t.rose': '{p} by wind direction (IFS), {unit}',
    'ui.data.weekday': 'weekday', 'ui.data.saturday': 'Saturday', 'ui.data.sunday': 'Sunday', 'ui.data.bgweekday': 'ZAGREB-4, weekday',
    'ui.data.mean': 'mean',
    'ui.data.note.diurnal': 'The hour is the start of the interval in local time. The morning and evening peaks are traffic.',
    'ui.data.note.annual': 'Only years with at least 75 % of hours. Dashed lines: the EU limit in force now, the EU limit from 2030 and the WHO 2021 guideline.',
    'ui.data.note.rose': 'Mean measured value at ZAGREB-1 by IFS model wind direction (not the station vane).',
    'ui.data.exceed': 'Exceedances by year',
    'ui.data.period': 'Archive: {a} – {b}, coverage {p} {cov} %.',
    'ui.data.none': 'This build of the page has no baked measurement archive (run tools/build_measurements.py).',
    'ui.exc.no2_1h_200': 'NO₂, hours above 200 µg/m³ (18 allowed)',
    'ui.exc.pm10_24h_50': 'PM₁₀, days above 50 µg/m³ (35 allowed)',
    'ui.exc.pm10_24h_45': 'PM₁₀, days above 45 µg/m³ (from 2030, 18 allowed)',
    'ui.exc.pm25_24h_25': 'PM₂.₅, days above 25 µg/m³ (from 2030, 18 allowed)',
    'ui.exc.no2_24h_50': 'NO₂, days above 50 µg/m³ (from 2030, 18 allowed)',
    'ui.exc.so2_1h_350': 'SO₂, hours above 350 µg/m³ (24 allowed)',
    'ui.exc.so2_24h_125': 'SO₂, days above 125 µg/m³ (3 allowed)',
    'ui.exc.pm10_24h_50_ref': 'PM₁₀, reference (gravimetric) method, days above 50 µg/m³ (35 allowed)',
    'ui.exc.pm10_24h_45_ref': 'PM₁₀, reference (gravimetric) method, days above 45 µg/m³ (from 2030, 18 allowed)',
    'ui.data.ytd': '{y}: up to {d}, so the counts are not yet annual.',
    'ui.lim.eu': 'EU {v}',
    'ui.lim.eu2030': 'EU 2030 {v}',
    'ui.lim.who': 'WHO {v}',
    'ui.lim.eu1h': 'EU 1 h {v}',
    'ui.lim.eu24': 'EU 24 h {v}',
    'ui.lim.eu8h': 'EU 8 h {v}',
    'ui.lim.euyr': 'EU annual {v}',
    'ui.map.h': 'On the map',
    'ui.map.what': 'The slice colour shows',
    'ui.map.what.inc': 'local sources',
    'ui.map.what.total': 'total',
    'ui.map.what.hint.inc': 'What traffic and domestic heating add on top of the background. The background is the same all over the map, so this is what shows the streets and where the wind takes the exhaust.',
    'ui.map.what.hint.total': 'Background + local sources, in the bands of the air-quality index (for NOₓ, CO and benzene, by the limit values).',
    'ui.map.stale': 'While a new field is computed, the slice is from the previous run and drawn paler.',
    'ui.map.approx': 'The slice comes from the approximate model without 3D flow.',
    'ui.adv.h': 'Advanced settings',
    'ui.adv.sub': 'stability, traffic and sources, index, display',
    'ui.adv.weather': 'Stability and mixing layer',
    'ui.val.sub': 'last 72 hours, direction rose, accuracy',
    'ui.fc.sub': 'next 72 hours (ECMWF IFS, CAMS)',
    'ui.data.sub': 'ZAGREB-1 measurement archive',
    'ui.disp.h': 'Display',
    'ui.disp.slice': 'Concentration slice at the chosen height',
    'ui.disp.sliceH': 'Slice height',
    'ui.disp.sliceH.hint': 'Default 4 m, the height of the station inlet; 1.5 m is breathing height.',
    'ui.disp.palette': 'Slice colours',
    'ui.disp.palette.cb': 'one hue (for everyone)',
    'ui.disp.palette.eaqi': 'EEA index colours',
    'ui.disp.palette.hint': 'For the "total" map. The local-sources map has its own scale (one violet hue, linear from zero).',
    'ui.disp.particles': 'Exhaust particles along the roads (display only)',
    'ui.disp.streaks': 'Wind streaks',
    'ui.disp.xray': 'See-through buildings',
    'ui.disp.lod2': 'Detailed roofs (LoD2, within 500 m)',
    'ui.disp.bcol': 'Building colour',
    'ui.disp.bcol.plain': 'plain',
    'ui.disp.bcol.year': 'survey year',
    'ui.disp.bcol.height': 'height',
    'ui.disp.bcol.hint.year': 'ZG3D source year: 2008, 2019 or 2022 (LiDAR).',
    'ui.disp.bcol.hint.height': 'Building height above ground.',
    'ui.disp.legend.none': 'The legend is not available (visuals.js is not loaded).',
    'ui.cam.label': 'View',
    'ui.cam.air': 'From the air',
    'ui.cam.station': 'From the station',
    'ui.cam.vukovarska': 'Down Vukovarska',
    'ui.cam.plan': 'Plan',
    'ui.split.label': 'Views',
    'ui.split.split': 'Both',
    'ui.foot.method': 'A 3D air-flow simulation (Lattice-Boltzmann D3Q19 with a turbulence model) computes the wind through a 600 × 600 m piece of the city for the chosen direction: first on a {spin} m grid, then on {dx} m cells. Pollution spreads along that flow (steady advection and diffusion) from four source groups: Vukovarska, Miramarska, other roads and domestic heating. NO₂ forms by reaction with background ozone. Wind speed only scales the result, with a low-wind floor U₀ for calms.',
    'ui.foot.limits.pre': 'The model is a tool for learning and for comparing scenarios, not an official forecast.',
    'ui.foot.limits': 'What the model does not know (limitations)',
    'ui.foot.notofficial': 'Official data and warnings are published by DHMZ and the Ministry (iszz.azo.hr).',
    'ui.foot.credit': 'After the project Maksimir pod kišom (Ivan Rezić, MIT): the same layout, 3D view and GPU wind tunnel.',
    'ui.err.module': 'Part of the page did not load: {m}',
    'ui.err.missing': 'Module {m} is not available: {what}.',
    'ui.err.what.scene': 'the 3D view is not drawn',
    'ui.err.what.city': 'the city is not built',
    'ui.err.what.model': 'station numbers are not available',
    'ui.err.what.visuals': 'slice, particles and labels are not drawn',
    'ui.err.what.aero': 'the flow is not computed',
    'ui.err.what.fallback': 'there is no fallback model',
    'ui.err.what.chem': 'index and limits use the built-in table',
    'ui.err.what.emissions': 'emissions are not available',
    'ui.err.live': 'Live measurements are not available',
    'ui.err.live.text': '{err}. Values from the baked archive are shown where they exist.',
    'ui.err.fc': 'The forecast is not available',
    'ui.note.fallback': 'Approximate model without 3D flow: this browser cannot run the wind simulation.',
    'ui.note.stale': 'Numbers are from the previous run until the new one finishes.',
    'ui.note.software': 'Software WebGL: the grid is coarser, and while the wind is computed the 3D is drawn at most every {s} s (except while you move the view), so the simulation gets the processor.',
  },
};
I18N.add(UI_STRINGS);

// ------------------------------------------------------------------ guarded references to other modules
/*
 * Captured once, after every other file of the module has run (main.js is last in tools/build.py ORDER).
 * typeof is safe on names that a placeholder file never declared, so a missing module shows up as null here
 * instead of a ReferenceError that would stop the page.
 */
const ui_X = {
  renderer: typeof renderer !== 'undefined' ? renderer : null,
  scene: typeof scene !== 'undefined' ? scene : null,
  setDaylight: typeof setDaylight === 'function' ? setDaylight : null,
  timeUniform: typeof timeUniform !== 'undefined' ? timeUniform : null,
  buildCity: typeof buildCity === 'function' ? buildCity : null,
  SCENARIOS: typeof SCENARIOS !== 'undefined' && Array.isArray(SCENARIOS) ? SCENARIOS : null,
  scenarioLayer: typeof scenarioLayer === 'function' ? scenarioLayer : null,
  setCustomBlock: typeof setCustomBlock === 'function' ? setCustomBlock : null,
  setLeaves: typeof setLeaves === 'function' ? setLeaves : null,
  colorBuildings: typeof colorBuildings === 'function' ? colorBuildings : null,
  setXray: typeof setXray === 'function' ? setXray : null,
  setConcPalette: typeof setConcPalette === 'function' ? setConcPalette : null,
  setLod2: typeof setLod2 === 'function' ? setLod2 : null,
  cityView: typeof cityView === 'function' ? cityView : null,
  buildingLegendHTML: typeof buildingLegendHTML === 'function' ? buildingLegendHTML : null,
  ConcSlice: typeof ConcSlice === 'function' ? ConcSlice : null,
  Particles: typeof Particles === 'function' ? Particles : null,
  WindStreaks: typeof WindStreaks === 'function' ? WindStreaks : null,
  LabelLayer: typeof LabelLayer === 'function' ? LabelLayer : null,
  legendHTML: typeof legendHTML === 'function' ? legendHTML : null,
  particleLegendHTML: typeof particleLegendHTML === 'function' ? particleLegendHTML : null,
  CONC_SCALES: typeof CONC_SCALES !== 'undefined' ? CONC_SCALES : null,
  INC_SCALES: typeof INC_SCALES !== 'undefined' ? INC_SCALES : null,
  Aero: typeof Aero === 'function' ? Aero : null,
  LBM: typeof LBM !== 'undefined' ? LBM : null,
  TUNNEL: typeof TUNNEL !== 'undefined' ? TUNNEL : null,
  SPINUP: typeof SPINUP !== 'undefined' ? SPINUP : null,
  ReceptorModel: typeof ReceptorModel === 'function' ? ReceptorModel : null,
  FallbackModel: typeof FallbackModel === 'function' ? FallbackModel : null,
  concentrations: typeof concentrations === 'function' ? concentrations : null,
  cellValue: typeof cellValue === 'function' ? cellValue : null,
  sliceContext: typeof sliceContext === 'function' ? sliceContext : null,
  groupStrengths: typeof groupStrengths === 'function' ? groupStrengths : null,
  POLLUTANTS: typeof POLLUTANTS !== 'undefined' && Array.isArray(POLLUTANTS) ? POLLUTANTS : ['nox', 'no2', 'pm10', 'pm25', 'co', 'c6h6'],
  POLLUTANT_INFO: typeof POLLUTANT_INFO !== 'undefined' ? POLLUTANT_INFO : null,
  eaqi: typeof eaqi === 'function' ? eaqi : null,
  EAQI_BANDS: typeof EAQI_BANDS !== 'undefined' ? EAQI_BANDS : null,
  EAQI_BANDS_ISZZ: typeof EAQI_BANDS_ISZZ !== 'undefined' ? EAQI_BANDS_ISZZ : null,
  THRESHOLDS: typeof THRESHOLDS !== 'undefined' ? THRESHOLDS : null,
  stabilityClass: typeof stabilityClass === 'function' ? stabilityClass : null,
  stabilityGroup: typeof stabilityGroup === 'function' ? stabilityGroup : null,
  mixingHeight: typeof mixingHeight === 'function' ? mixingHeight : null,
  dirName: typeof dirName === 'function' ? dirName : null,
  beaufort: typeof beaufort === 'function' ? beaufort : null,
};

// ------------------------------------------------------------------ small pure helpers (tested in ui.test.js)
const UI_H = 3600000;                  // one hour in ms
const UI_DEBOUNCE_MS = 350;            // direction/stability/scenario debounce, as in the reference (main.js applyWeather)
const UI_DIR_STEP = 360 / MD.dirs;     // 22.5°: the 16 run directions (SITE.model_defaults.dirs)

/** Bearing (° from north, clockwise) of a pointer offset (dx right, dy down, screen px) from the dial centre. */
function ui_dialAngle(dx, dy) { return wrap360(Math.atan2(dx, -dy) / DEG); }
/** Snap a bearing to the 16 run directions. */
function ui_snap16(deg) { return (Math.round(wrap360(deg) / UI_DIR_STEP) % MD.dirs) * UI_DIR_STEP; }
/** Index 0..15 of the run direction for a bearing: round(from / 22.5) % 16 (architecture §6.2). */
function ui_dirIdx(from) { return Math.round(wrap360(from) / UI_DIR_STEP) % MD.dirs; }
/**
 * Dial keyboard (reference pattern, plus Page and Home/End): →/↑ one step clockwise, ←/↓ one step back,
 * PageUp/PageDown a quarter turn, Home north, End the last step. Returns the new bearing or null.
 */
function ui_dialKey(from, key) {
  const s = UI_DIR_STEP;
  const step = { ArrowRight: s, ArrowUp: s, ArrowLeft: -s, ArrowDown: -s, PageUp: 90, PageDown: -90 }[key];
  if (key === 'Home') return 0;
  if (key === 'End') return 360 - s;
  if (step === undefined) return null;
  return ui_snap16(ui_snap16(from) + step);
}
/**
 * Climatological 2 m temperature [°C] by month for hours without IFS data: a cosine through the Zagreb-Maksimir
 * means of January (−0.3 °C) and July (20.7 °C), 1949–2013 (site-context §7.1). Only the NO + O3 rate (kNOO3)
 * uses it, which changes by ~3 % per °C.
 */
function ui_climT(month) { return 10.2 + 10.5 * Math.cos((2 * Math.PI * (month - 7)) / 12); }
/** Heating season October–March (critic §4.6) and leaf-on May–October (critic §4.3) by local month. */
function ui_isHeatingMonth(m) { return m >= 10 || m <= 3; }
function ui_isLeafMonth(m) { return m >= 5 && m <= 10; }
/**
 * The hour ending at tMs as an explicit local interval, e.g. "28 Sep 2026, 08–09 h" (architecture §2: times are
 * hour-ending; the date is that of the hour's start, so the hour ending 24:00 reads "27 Sep, 23–24 h").
 */
function ui_span(tMs, year = false) {
  if (!Number.isFinite(tMs)) return '–';
  const hs = ZgTime.hourStart(tMs);
  return t('ui.span', { date: fmtLocal(tMs - UI_H, { time: false, year }), a: String(hs.h).padStart(2, '0'), b: String(ui_endHour(tMs)).padStart(2, '0') });
}
/** Local clock hour at the END of the hour ending at tMs, 1–24 (midnight is 24; on DST days it is not start + 1). */
function ui_endHour(tMs) {
  const p = ZgTime.parts(tMs);
  return p.h === 0 && p.mi === 0 ? 24 : p.h;
}
/** "60x60x16@10m" → "10 m" (the cell size of a grid id, architecture §5.1). */
function ui_gridLabel(id) {
  const m = /@(\d+(?:\.\d+)?)m/.exec(String(id || ''));
  return m ? `${fmt(+m[1])} m` : (id ? String(id) : '?');
}

// ------------------------------------------------------------------ fallbacks for missing pure modules
/*
 * EAQI band upper limits of levels 1..5 (µg/m³, hourly concentration), used only when chemistry.js (which owns
 * the index: EAQI_BANDS, EAQI_BANDS_ISZZ, eaqi()) is missing. Same convention as chemistry.js: a value equal to a
 * limit belongs to the lower band.
 *   eea  = revised EEA index, ETC HE Report 2024/17 (iszz-api §9.3), with the EEA colours;
 *   iszz = legacy bands that ISZZ still uses (iszz-api §9.3), with the ISZZ colours.
 * CO and benzene have no EAQI band (iszz-api §9.3). colors[0] is the ISZZ "no data" grey.
 */
const UI_EAQI = {
  eea: {
    colors: ['#6F6F6F', '#50F0E6', '#50CCAA', '#F0E641', '#FF5050', '#960032', '#7D2181'],
    hi: { pm25: [5, 15, 50, 90, 140], pm10: [15, 45, 120, 195, 270], no2: [10, 25, 60, 100, 150], o3: [60, 100, 120, 160, 180], so2: [20, 40, 125, 190, 275] },
  },
  iszz: {
    colors: ['#6F6F6F', '#55EFE5', '#54CAAA', '#EFE558', '#FE5355', '#940D36', '#7D2181'],
    hi: { pm25: [10, 20, 25, 50, 75], pm10: [20, 40, 50, 100, 150], no2: [40, 90, 120, 230, 340], o3: [50, 100, 130, 240, 380], so2: [100, 200, 350, 500, 750] },
  },
};
/** Band limits for pollutant p: chemistry.js tables when present, else the built-in copy. */
function ui_bandLimits(p, index = state.index) {
  const B = index === 'iszz' ? ui_X.EAQI_BANDS_ISZZ : ui_X.EAQI_BANDS;
  if (B && Array.isArray(B[p])) return B[p];
  return UI_EAQI[index === 'iszz' ? 'iszz' : 'eea'].hi[p] || null;
}
/*
 * Limit values for chart lines (iszz-api §9.1–9.2, critic §1.14): EU AAQD 2024/2881 Annex I Table 2 (valid now),
 * Table 1 (from 2030), WHO AQG 2021. CO in mg/m³, everything else µg/m³.
 */
const UI_LIMITS = {
  no2: { annual: { eu: 40, eu2030: 20, who: 10 }, hourly: [{ k: 'ui.lim.eu1h', v: 200 }] },
  nox: { annual: {}, hourly: [] },
  pm10: { annual: { eu: 40, eu2030: 20, who: 15 }, hourly: [{ k: 'ui.lim.eu24', v: 50 }] },
  pm25: { annual: { eu: 20, eu2030: 10, who: 5 }, hourly: [{ k: 'ui.lim.eu24', v: 25 }] },   // 20 = HR NN 77/2020 2nd stage
  co: { annual: {}, hourly: [{ k: 'ui.lim.eu8h', v: 10 }] },
  c6h6: { annual: { eu: 5, eu2030: 3.4 }, hourly: [{ k: 'ui.lim.euyr', v: 5 }] },
};
/*
 * Short chart labels for limit values. The values come from chemistry.js THRESHOLDS (the one table of AAQD
 * 2024/2881, HR NN 77/2020 and WHO 2021 values, critic §1.14); UI_LIMITS is used only when it is missing.
 *   ui_limitLines(p, 'hourly') → the limit in force this year for the shortest averaging period the pollutant
 *     has (1 h for NO2, 24 h for PM, 8 h for CO, the year for benzene), drawn on hourly series as a reference;
 *   ui_limitLines(p, 'annual') → EU limit now, EU limit from 2030, WHO guideline.
 */
function ui_limitLines(p, which) {
  const T = ui_X.THRESHOLDS && ui_X.THRESHOLDS[p];
  const year = new Date().getUTCFullYear();
  const now = (l) => (l.from == null || year >= l.from) && (l.to == null || year <= l.to);
  const lab = (k, v) => t(k, { v: fmt(v, v % 1 ? 1 : 0) });
  if (T) {
    if (which === 'annual') {
      const y = T.year || [], out = [];
      const cur = y.find((l) => l.kind === 'limit' && now(l));
      const later = y.find((l) => l.kind === 'limit' && l.from >= 2030);
      const who = y.find((l) => l.kind === 'who');
      if (cur) out.push({ v: cur.v, label: lab('ui.lim.eu', cur.v) });
      if (later && (!cur || later.v !== cur.v)) out.push({ v: later.v, label: lab('ui.lim.eu2030', later.v) });
      if (who) out.push({ v: who.v, label: lab('ui.lim.who', who.v) });
      return out;
    }
    for (const [avg, key] of [['1h', 'ui.lim.eu1h'], ['24h', 'ui.lim.eu24'], ['8h', 'ui.lim.eu8h'], ['year', 'ui.lim.euyr']]) {
      const l = (T[avg] || []).find((q) => q.kind === 'limit' && now(q));
      if (l) return [{ v: l.v, label: lab(key, l.v) }];
    }
    return [];
  }
  const L = UI_LIMITS[p];
  if (!L) return [];
  if (which === 'annual') {
    return [['eu', 'ui.lim.eu'], ['eu2030', 'ui.lim.eu2030'], ['who', 'ui.lim.who']].filter(([k]) => Number.isFinite(L.annual[k])).map(([k, key]) => ({ v: L.annual[k], label: lab(key, L.annual[k]) }));
  }
  return L.hourly.map((q) => ({ v: q.v, label: lab(q.k, q.v) }));
}
/*
 * Last-resort background when neither ZAGREB-4 (live or archive) nor CAMS nor a climatology is available:
 * ZAGREB-4 2025 validated annual means (research/data/physics/iszz/303_*_1_2025.json): NO2 16.3, NOx 24.0,
 * O3 54.0, PM10 25.6, PM2.5 15.7 µg/m³. CO and benzene are not measured at ZAGREB-4: ZAGREB-1's 2025 means
 * (CO 0.24 mg/m³, benzene 0.68 µg/m³) minus the local increment from the ratios to ΔNOx = 46 µg/m³
 * (CO 0.98 × ΔNOx µg/m³, benzene 0.0071 × ΔNOx, critic §1.4) give CO 0.19 mg/m³ and benzene 0.35 µg/m³.
 */
const UI_BG_DEFAULT = { no2: 16.3, nox: 24.0, o3: 54.0, pm10: 25.6, pm25: 15.7, co: 0.19, c6h6: 0.35 };

/** Band 0..6 of a value for pollutant p under index ('eea' | 'iszz'), with a colour; level 0 = no band. */
function ui_band(p, v, index = state.index) {
  const I = UI_EAQI[index === 'iszz' ? 'iszz' : 'eea'];
  if (!Number.isFinite(v)) return { level: 0, color: I.colors[0] };
  if (ui_X.eaqi) {
    try {
      const r = ui_X.eaqi(p, v, '1h', index === 'iszz' ? 'iszz' : 'eea2024');
      if (r && Number.isFinite(r.level)) return { level: r.level, color: r.color || I.colors[r.level] };
    } catch (e) { /* fall back to the built-in table */ }
  }
  const hi = ui_bandLimits(p, index);
  if (!hi) return { level: 0, color: I.colors[0] };
  let level = 1;
  while (level <= hi.length && v > hi[level - 1]) level++;
  return { level, color: I.colors[level] };
}
/** Lower bound of band `level` (= upper limit of level − 1) for pollutant p, or NaN outside the EAQI. */
function ui_bandLo(p, level, index = state.index) {
  const hi = ui_bandLimits(p, index);
  return hi && level >= 2 && level <= 6 ? hi[level - 2] : NaN;
}

// ------------------------------------------------------------------ state
const state = {
  mode: 'explore', preset: 'ne',
  u10: 1.7, from: 45, stability: 'D', lid: 'auto',   // critic §4.5 default preset "Sjeveroistočnjak"
  time: ZgTime.currentHourEnding(), met: null,
  traffic: 100, trafficA: 100, trafficB: 100, congestion: false, resuspension: false,
  heating: 'auto', leaves: 'auto', bgSource: 'auto',
  scenario: 'today',
  measures: { lez: false, evShare: 0, eBus: false, carFreeMiramarska: false, trafficChange: 0 },
  // city.js's default block (ct_CUSTOM_DEFAULT: Park Stjepana Srkulja across Miramarska, 40 × 24 × 25 m), at rot 0 because
  // the rotation slider runs 0–175°. The earlier default (−70, −40) stood inside the 32 m slab north of the park
  // (integration check against env.json, 2026-09-28).
  custom: { x: 75, z: -10, w: 40, d: 24, h: 25, rot: 0 },
  pollutant: 'no2', index: 'eea', calibrated: true, bandLevel: 3,
  slice: true, sliceWhat: 'inc', sliceH: 4, palette: 'cb', particles: true, streaks: false, xray: false, lod2: false, bcol: 'plain', cam: 'air',
  split: 'split', dataView: 'diurnal',
};
window.__z1 = { ready: false, fields: 0, receptor: null, errors: [], state };

// ------------------------------------------------------------------ notices and guarded calls
/*
 * Errors from other modules are shown as cards at the top of the panel (and on window.__z1.errors), once per
 * source, so a failing per-frame call does not flood the page.
 */
const ui_noticeMap = new Map();
function ui_renderNotices() {
  const box = $('#notices');
  if (!box) return;
  box.textContent = '';
  for (const [, n] of ui_noticeMap) {
    const d = document.createElement('div');
    d.className = `notice ${n.level}`;
    d.setAttribute('role', n.level === 'error' ? 'alert' : 'status');
    const b = document.createElement('b');
    b.textContent = typeof n.title === 'function' ? n.title() : n.title;
    d.appendChild(b);
    d.appendChild(document.createTextNode(typeof n.text === 'function' ? n.text() : n.text));
    box.appendChild(d);
  }
}
function ui_notice(id, level, title, text) { ui_noticeMap.set(id, { level, title, text }); ui_renderNotices(); }
function ui_clearNotice(id) { if (ui_noticeMap.delete(id)) ui_renderNotices(); }
const ui_failed = new Set();
function ui_fail(where, err) {
  const msg = String((err && err.message) || err);
  if (ui_failed.has(where)) return;
  ui_failed.add(where);
  console.error(`[ui] ${where}:`, err);
  window.__z1.errors.push(`${where}: ${msg}`);
  ui_notice(`fail.${where}`, 'error', () => t('ui.err.module', { m: where }), msg);
}
function ui_try(where, fn, fallback = null) {
  try { return fn(); } catch (e) { ui_fail(where, e); return fallback; }
}
function ui_missing(mod, whatKey) {
  ui_notice(`missing.${mod}`, 'error', () => t('ui.err.missing', { m: mod, what: t(whatKey) }), '');
  window.__z1.errors.push(`missing ${mod}`);
}

// ------------------------------------------------------------------ formatting
function ui_polName(p) { return t(`ui.pol.name.${p}`); }
/**
 * Display unit of a pollutant: CO in mg/m³ like ISZZ (architecture §2), the rest µg/m³. concentrations() and
 * cellValue() already return CO in mg/m³ and take the CO background in mg/m³ (model.js), so no conversion.
 */
function ui_unit(p) { return p === 'co' ? 'mg/m³' : 'µg/m³'; }
function ui_dec(p, v) {
  if (!Number.isFinite(v)) return 0;
  if (p === 'co') return 2;
  const a = Math.abs(v);
  return a < 1 ? 2 : a < 10 ? 1 : 0;
}
function ui_fmtC(p, v, withUnit = false) {
  if (!Number.isFinite(v)) return '–';
  return fmt(v, ui_dec(p, v)) + (withUnit ? ` ${ui_unit(p)}` : '');
}
function ui_dir(deg) {
  if (ui_X.dirName) { try { const d = ui_X.dirName(deg); if (d && d.text) return d; } catch (e) { /* fall through */ } }
  return { short: `${fmt(deg)}°`, text: `${fmt(deg)}°` };
}
function ui_dirs16() { return Array.from({ length: 16 }, (_, k) => ui_dir(k * UI_DIR_STEP).short); }
function ui_setText(sel, text) { const e = typeof sel === 'string' ? $(sel) : sel; if (e && e.textContent !== text) e.textContent = text; }
function ui_setHTML(sel, html) { const e = typeof sel === 'string' ? $(sel) : sel; if (e && e.innerHTML !== html) e.innerHTML = html; }

// ------------------------------------------------------------------ i18n of the static markup
function ui_applyI18n(root = document) {
  for (const el of $$('[data-i18n]', root)) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-attr]', root)) {
    for (const pair of el.dataset.i18nAttr.split(',')) {
      const [a, k] = pair.split(':').map((s) => s.trim());
      if (a && k) el.setAttribute(a, t(k));
    }
  }
  document.title = `${t('ui.title')} · Zagreb-1`;
  document.documentElement.lang = I18N.lang;
  for (const b of $$('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === I18N.lang));
}

// ------------------------------------------------------------------ derived meteorology, background, measures
/*
 * Meteorology of the selected hour. The wind (u10, from) is always the state's. Cloud, radiation, mixing height
 * and temperature come, in order: from the IFS row pinned by "Now"/forecast (state.met), from the baked IFS
 * archive at that hour (Hist ifs.*), from the live IFS rows, else defaults (cloud missing → meteo.js assumes
 * 50 %, radiation from the solar elevation, BLH = class median; T from ui_climT).
 */
const ui_live = { recent: null, eaqi: null, fc: null, cams: null, ratios: null, valid: new Map(), status: 'idle', fcStatus: 'idle', fcErr: null, err: null };
/*
 * Hour lookups in the live row lists go through a Map per list (cached in a WeakMap keyed by the array), because
 * the rose comparison evaluates ~10 000 archive hours and a linear find() per hour and pollutant would dominate.
 */
const ui_tMaps = new WeakMap();
function ui_byT(rows) {
  if (!rows) return null;
  let m = ui_tMaps.get(rows);
  if (!m) { m = new Map(rows.map((r) => [r.t, r])); ui_tMaps.set(rows, m); }
  return m;
}
function ui_metRow(tMs) {
  if (state.met && state.met.t === tMs) return state.met;
  if (Hist.ok && Hist.indexAt(tMs) >= 0) {
    const r = { t: tMs, blh: Hist.value('ifs.blh', tMs), t2: Hist.value('ifs.t2', tMs), cc: Hist.value('ifs.cc', tMs), sw: Hist.value('ifs.sw', tMs),
      u10: Hist.value('ifs.u10', tMs), wd: Hist.value('ifs.wd10', tMs), source: 'hist' };
    if ([r.blh, r.cc, r.t2].some(Number.isFinite)) return r;
  }
  const r = ui_live.fc && ui_byT(ui_live.fc).get(tMs);
  return r ? { ...r, source: 'live' } : null;
}
/**
 * ui_met({t, u10, from, stab, lid, row}): every field defaults to the state (row defaults to ui_metRow(t)).
 * Returns the `met` object passed to concentrations(): {u10, from, dir, cls, group, blh, h_eff, t2, sw, cc, dateUTC, t, source}.
 */
function ui_met(o = {}) {
  const tMs = o.t ?? state.time, u10 = o.u10 ?? state.u10, from = o.from ?? state.from;
  const stab = o.stab ?? state.stability, lid = o.lid ?? state.lid;
  const row = o.row !== undefined ? o.row : ui_metRow(tMs);
  const month = ZgTime.hourStart(tMs).mo;
  const cc = row && Number.isFinite(row.cc) ? row.cc : NaN;
  const sw = row && Number.isFinite(row.sw) ? row.sw : NaN;
  const blh = row && Number.isFinite(row.blh) ? row.blh : NaN;
  const t2 = row && Number.isFinite(row.t2) ? row.t2 : ui_climT(month);
  const dateUTC = new Date(tMs);
  let cls = stab;
  if (stab === 'auto') cls = ui_X.stabilityClass ? ui_try('meteo.stabilityClass', () => ui_X.stabilityClass({ u10, sw, cloud: cc, dateUTC }), 'D') : 'D';
  const group = ui_X.stabilityGroup ? ui_X.stabilityGroup(cls) : (/[ABC]/.test(cls) ? 'AC' : /[EF]/.test(cls) ? 'EF' : 'D');
  const h_eff = ui_X.mixingHeight ? ui_try('meteo.mixingHeight', () => ui_X.mixingHeight({ cls, blh, mode: lid }), NaN) : NaN;
  return { u10, from, dir: from, cls, group, stab: group, blh, h_eff, t2, tempC: t2, sw, cc, cloud: cc, dateUTC, t: tMs, source: row ? row.source : null };
}

/*
 * Background at the station for the hour ending at tMs, per pollutant, with the source of each value.
 * 'auto' order: ZAGREB-4 live → ZAGREB-4 archive → CAMS × 14-day ratio → ZAGREB-4 climatology (MEAS.stats.diurnal
 * by day type and local hour) → UI_BG_DEFAULT. Choosing a source moves it to the front of the list.
 * NOx: ZAGREB-4 NOx; with CAMS it is NO2_bg × the ZAGREB-4 NOx/NO2 ratio (physics §11.4).
 */
function ui_bg(tMs = state.time, src = state.bgSource) {
  const out = { source: {} };
  const hs = ZgTime.hourStart(tMs), dt = ZgTime.dayType(tMs);
  const liveAt = (p) => { const rows = ui_live.recent && (ui_live.recent.z4long[p] || ui_live.recent.z4[p]); const r = rows && ui_byT(rows).get(tMs); return r ? r.v : NaN; };
  const camsAt = (p) => {
    if (!ui_live.cams || !ui_live.ratios) return NaN;
    const r = ui_byT(ui_live.cams).get(tMs);
    if (!r) return NaN;
    if (p === 'nox') return Number.isFinite(r.no2) ? r.no2 * ui_live.ratios.no2 * ui_live.ratios.nox_no2 : NaN;
    return Number.isFinite(r[p]) ? r[p] * ui_live.ratios[p] : NaN;
  };
  const climAt = (p) => { const d = Hist.stats && Hist.stats.diurnal && Hist.stats.diurnal[`z4.${p}`]; return d && d[dt] ? d[dt][hs.h] : NaN; };
  const getters = { z4live: liveAt, z4hist: (p) => Hist.value(`z4.${p}`, tMs), cams: camsAt, clim: climAt };
  const order = { auto: ['z4live', 'z4hist', 'cams', 'clim'], z4: ['z4live', 'z4hist', 'clim', 'cams'], cams: ['cams', 'z4live', 'z4hist', 'clim'], clim: ['clim', 'z4hist', 'z4live', 'cams'] }[src] || ['z4live', 'z4hist', 'cams', 'clim'];
  for (const p of ['no2', 'nox', 'o3', 'pm10', 'pm25']) {
    let v = NaN, s = 'default';
    for (const k of order) { const x = getters[k](p); if (Number.isFinite(x)) { v = x; s = k; break; } }
    out[p] = Number.isFinite(v) ? v : UI_BG_DEFAULT[p];
    out.source[p] = s;
  }
  // CO and benzene: not measured at ZAGREB-4 (SITE.iszz.params z4: false); regional estimate (CO in mg/m³).
  out.co = UI_BG_DEFAULT.co;
  out.c6h6 = UI_BG_DEFAULT.c6h6;
  out.source.co = out.source.c6h6 = 'derived';
  return out;
}

function ui_heatingOn(tMs = state.time) {
  return state.heating === 'on' || (state.heating === 'auto' && ui_isHeatingMonth(ZgTime.hourStart(tMs).mo));
}
function ui_leafMode() {
  if (state.leaves !== 'auto') return state.leaves;
  return ui_isLeafMonth(ZgTime.hourStart(state.time).mo) ? 'on' : 'off';
}
/*
 * Emission measures for one view (emissions.js measureFactors): the traffic sliders of "Traffic and sources"
 * apply to both views; the scenario measures only to the right view. Percentages stay percentages
 * (100 = the modelled AADT); evShare is 0–100 %.
 */
function ui_measuresFor(viewId) {
  const base = { lez: false, evShare: 0, eBus: false, carFreeMiramarska: false, trafficPct: state.traffic, trafficA: state.trafficA,
    trafficB: state.trafficB, congestion: state.congestion, resuspension: state.resuspension };
  if (viewId !== 'scenario') return base;
  const m = state.measures;
  return { ...base, lez: m.lez, evShare: m.evShare, eBus: m.eBus, carFreeMiramarska: m.carFreeMiramarska,
    trafficPct: state.traffic * (1 + m.trafficChange / 100) };
}
/*
 * Model options. Calibration is chosen by model.js per source (the LBM fit for LUT/field values, the Gaussian
 * fit for the fallback, mod_calFor); the UI only says calibrated or raw physics (β = 1, U0 prior).
 */
function ui_opts(tMs = state.time) {
  return { heating: ui_heatingOn(tMs), calibrated: state.calibrated };
}

// ------------------------------------------------------------------ scenarios
const UI_SCEN_FALLBACK = [{ id: 'today', geo: false }];
function ui_scenarios() { return ui_X.SCENARIOS && ui_X.SCENARIOS.length ? ui_X.SCENARIOS : UI_SCEN_FALLBACK; }
function ui_scen(id = state.scenario) { return ui_scenarios().find((s) => s.id === id) || UI_SCEN_FALLBACK[0]; }
function ui_scenGeo(id = state.scenario) { const s = ui_scen(id); return !!(s && s.geo && id !== 'today'); }
const ui_keyText = (k) => (typeof k === 'string' && k ? (I18N.has(k) ? t(k) : k) : '');
function ui_scenLabel(s) { return s.id === 'today' ? t('ui.scen.today') : ui_keyText(s.label || s.labelKey || s.name) || s.id; }
function ui_scenDesc(s) { return s.id === 'today' ? t('ui.scen.today.desc') : ui_keyText(s.desc || s.descKey); }

// ------------------------------------------------------------------ receptor model and fields
/*
 * ui_recv keeps the small receptor result {gamma, age, band} of every completed Aero job by key; ui_fields keeps
 * the full results (wind + scalar fields, tens of MB each) only for the last few keys, since Aero has its own
 * LRU (architecture §6.2).
 */
const UI_FIELD_KEEP = 6;
const ui_recv = new Map();
const ui_fields = new Map();
const ui_pending = new Set();
const ui_keyStr = (k) => `${k.scenario}|${k.dir}|${k.stab}`;
let ui_receptor = null, ui_fallback = null, ui_aero = null, ui_city = null;

function ui_viewKey(viewId, met = ui_met()) {
  const scen = viewId === 'scenario' && ui_scenGeo() ? state.scenario : 'today';
  return { scenario: scen, dir: ui_dirIdx(met.from), stab: met.group };
}
/** The full result for a key, or the latest result for the same scenario (shown stale), or null. */
function ui_fieldFor(key) {
  const exact = ui_fields.get(ui_keyStr(key));
  if (exact) return { res: exact, stale: false };
  let last = null;
  for (const [, r] of ui_fields) if (r.key.scenario === key.scenario) last = r;
  return last ? { res: last, stale: true } : null;
}
/*
 * Receptor response {gamma[4], age[4], source, coverage, parts} for a view: ReceptorModel.gammaAt(dir, u10, cls,
 * scenario), direction-smoothed over the 16 run directions. For a geometry scenario model.js uses that scenario's
 * own fields where they exist and today's fields or the LUT elsewhere; `coverage` is the share of the direction
 * weight that came from the scenario's own fields (model.js). The view is "pending" while the scenario's field for
 * the nearest direction is missing. Without a ReceptorModel: FallbackModel.receptor directly.
 */
function ui_gammaAge(viewId, met) {
  const geo = viewId === 'scenario' && ui_scenGeo();
  const scen = geo ? state.scenario : 'today';
  let ga = null;
  if (ui_receptor) ga = ui_try('model.gammaAt', () => ui_receptor.gammaAt(met.from, met.u10, met.cls, scen), null);
  if (!ga && ui_fallback) {
    const r = ui_try('fallback.receptor', () => ui_fallback.receptor(met.from, met.cls), null);
    if (r) ga = { gamma: r.gamma, age: r.age, source: 'fallback', coverage: 0 };
  }
  if (!ga) return null;
  const pending = geo && !!ui_aero && !ui_recv.has(ui_keyStr(ui_viewKey('scenario', met)));
  return { ...ga, geo, pending };
}

/** concentrations() for one view at the state's hour, or null when model.js is missing. */
function ui_evalView(viewId) {
  const met = ui_met(), bg = ui_bg();
  const ga = ui_gammaAge(viewId, met);
  if (!ga || !ui_X.concentrations) return { met, bg, ga, c: null };
  const c = ui_try('model.concentrations', () => ui_X.concentrations({
    met, dateUTC: met.dateUTC, measures: ui_measuresFor(viewId), background: bg, pollutant: 'all', gammaAge: ga, opts: ui_opts(),
  }), null);
  return { met, bg, ga, c };
}
/** Total, increment and background of pollutant p from a concentrations() result, in display units. */
function ui_pick(c, p) {
  if (!c) return { total: NaN, inc: NaN, bg: NaN, groups: null };
  const num = (x) => (Number.isFinite(x) ? x : NaN);
  const inc = c.inc ? num(typeof c.inc[p] === 'object' ? c.inc[p].total : c.inc[p]) : NaN;
  const bg = c.bg ? num(c.bg[p]) : NaN;
  let groups = null, split = false;
  const asList = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? ['A', 'B', 'C', 'D'].map((g) => x[g]) : null);
  if (c.byGroup) groups = asList(c.byGroup[p]);
  // NO2 has no linear split (chemistry): attribute its increment in proportion to the NOx increment by group.
  if (!groups && p === 'no2' && c.byGroup && c.byGroup.nox && c.inc && c.inc.nox > 0) {
    const nox = asList(c.byGroup.nox);
    if (nox) { groups = nox.map((v) => (v / c.inc.nox) * inc); split = true; }
  }
  return { total: num(c[p]), inc, bg, groups: groups ? groups.map(num) : null, split, meta: c.meta || null };
}

// ------------------------------------------------------------------ street-area share and nearest school
/*
 * Street points: every road of env.json (all classes, including footways) sampled on a 5 m grid across its
 * carriageway width w and along its length, kept when within 300 m of the station and deduplicated by 5 m
 * cell. 5 m = the fine LBM cell (architecture §5.1), so each point stands for one cell of street area.
 */
const UI_STREET_R = 300, UI_STREET_DX = 5, UI_POI_Y = 1.5;
let ui_streetPts = null;
function ui_buildStreetPoints() {
  const seen = new Set(), pts = [];
  for (const r of (ENV && ENV.roads) || []) {
    const w = Number.isFinite(r.w) ? r.w : 6;
    const p = r.p || [];
    for (let i = 0; i + 1 < p.length; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      if (Math.min(Math.hypot(ax, az), Math.hypot(bx, bz)) > UI_STREET_R + 100) continue;
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.1) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux;
      const nAcross = Math.max(1, Math.round(w / UI_STREET_DX));
      for (let s = 0; s <= L; s += UI_STREET_DX) {
        for (let j = 0; j < nAcross; j++) {
          const off = (j + 0.5) * (w / nAcross) - w / 2;
          const x = ax + ux * s + nx * off, z = az + uz * s + nz * off;
          if (Math.hypot(x, z) > UI_STREET_R) continue;
          const key = `${Math.round(x / UI_STREET_DX)},${Math.round(z / UI_STREET_DX)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pts.push(x, z);
        }
      }
    }
  }
  ui_streetPts = new Float32Array(pts);
}
function ui_nearestPoi() {
  let best = null, bd = Infinity;
  for (const q of (ENV && ENV.pois) || []) {
    if (q.t !== 'school' && q.t !== 'kindergarten') continue;
    const d = Math.hypot(q.x, q.z);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

// ------------------------------------------------------------------ approximate field (no GPU flow)
/*
 * When there is no 3D field (LBM.ok false, or aero.js missing), the slice, the school value and the street share
 * come from FallbackModel.slice on a world-aligned 600 m square around the station, wrapped in a ScalarField-
 * shaped object so the rest of the page does not care. Cell size 10 m = the coarse grid (SITE.extent.tunnel.dx_coarse).
 * FallbackModel gives Γ only; the age channel carries the receptor's age per group (a stated approximation used
 * only by the NO2 chemistry).
 */
const UI_FB_HALF = SITE.extent.tunnel.across_m / 2, UI_FB_DX = SITE.extent.tunnel.dx_coarse;
/*
 * FallbackModel.slice costs ~3 s for this 60 × 60 grid on a laptop CPU (measured in the headless check), so it runs
 * through sliceAsync (2 rows per chunk, the page stays responsive) and is cached per (direction, class, height).
 * Until a slice is ready the last finished slice of the same direction and class is shown (any height), else none.
 */
const UI_FB_ROWS = 2;
const ui_fbCache = new Map(), ui_fbPending = new Set();
function ui_fallbackField(met, h) {
  if (!ui_fallback) return null;
  const base = `${ui_dirIdx(met.from)}|${met.cls}`, key = `${base}|${h}`;
  if (ui_fbCache.has(key)) return ui_fbCache.get(key);
  if (!ui_fbPending.has(key) && typeof ui_fallback.sliceAsync === 'function') {
    ui_fbPending.add(key);
    const n = Math.round((2 * UI_FB_HALF) / UI_FB_DX);
    ui_fallback.sliceAsync(ui_snap16(met.from), met.cls, h, { x0: -UI_FB_HALF, z0: -UI_FB_HALF, dx: UI_FB_DX, nx: n, nz: n }, null, UI_FB_ROWS)
      .then((g) => { ui_fbPending.delete(key); const f = ui_fbWrap(met, h, g, n); if (f) { ui_fbStore(key, f); ui_invalidate('slices', 'points'); } })
      .catch((e) => { ui_fbPending.delete(key); ui_fail('fallback.sliceAsync', e); });
  }
  let last = null;
  for (const [k, f] of ui_fbCache) if (k.startsWith(`${base}|`)) last = f;
  return last;
}
function ui_fbStore(key, f) {
  ui_fbCache.delete(key);
  ui_fbCache.set(key, f);
  if (ui_fbCache.size > 24) ui_fbCache.delete(ui_fbCache.keys().next().value);
}
function ui_fbWrap(met, h, g, n) {
  if (!g) return null;
  const x0 = -UI_FB_HALF, z0 = -UI_FB_HALF;
  const rec = ui_try('fallback.receptor', () => ui_fallback.receptor(ui_snap16(met.from), met.cls), null);
  const age = rec ? rec.age : [60, 60, 60, 60];
  const data = new Float32Array(n * n * 8);
  for (let i = 0; i < n * n; i++) { for (let k = 0; k < 4; k++) { data[i * 8 + k] = g[i * 4 + k]; data[i * 8 + 4 + k] = age[k]; } }
  const f = {
    approximate: true, nx: n, ny: n, nz: 1, dx: UI_FB_DX, heightM: h,
    frame: { from: ui_snap16(met.from), ex: new THREE.Vector3(1, 0, 0), ey: new THREE.Vector3(0, 0, 1), origin: new THREE.Vector3(x0, 0, z0) },
    slice() { return { nx: n, ny: n, data }; },
    sample(p, out) {
      const fx = (p.x - x0) / UI_FB_DX - 0.5, fz = (p.z - z0) / UI_FB_DX - 0.5;
      if (fx < 0 || fz < 0 || fx > n - 1 || fz > n - 1) return false;
      const i0 = Math.floor(fx), j0 = Math.floor(fz), i1 = Math.min(n - 1, i0 + 1), j1 = Math.min(n - 1, j0 + 1), a = fx - i0, b = fz - j0;
      for (let k = 0; k < 8; k++) {
        const v00 = data[(j0 * n + i0) * 8 + k], v10 = data[(j0 * n + i1) * 8 + k], v01 = data[(j1 * n + i0) * 8 + k], v11 = data[(j1 * n + i1) * 8 + k];
        out[k] = (v00 * (1 - a) + v10 * a) * (1 - b) + (v01 * (1 - a) + v11 * a) * b;
      }
      return true;
    },
  };
  return f;
}

/** The scalar field a view shows (its own for a geometry scenario, else today's), or the approximate one. */
function ui_viewField(viewId, met) {
  if (ui_aero) {
    const f = ui_fieldFor(ui_viewKey(viewId, met));
    if (f && f.res && f.res.conc) return { field: f.res.conc, wind: f.res.wind, stale: f.stale, approximate: false };
    return null;
  }
  const f = ui_fallbackField(met, UI_POI_Y);
  return f ? { field: f, wind: null, stale: f.heightM !== UI_POI_Y, approximate: true } : null;
}
/** Strengths of every pollutant for a view at the state's hour (cellValue needs NOx and the pollutant). */
function ui_strengthsAll(viewId, tMs = state.time) {
  if (!ui_X.groupStrengths) return null;
  const out = {};
  const m = ui_measuresFor(viewId), o = ui_opts(tMs), d = new Date(tMs);
  for (const p of ui_X.POLLUTANTS) out[p] = ui_try('emissions.groupStrengths', () => ui_X.groupStrengths(p, d, m, o), null);
  return out;
}
/**
 * A value function (gamma4, age4) → concentration of p (display units, CO mg/m³) for slices and point samples.
 * model.js sliceContext() prepares the strengths of every pollutant, U_eff, β, J(NO2) and k(NO+O3) once per hour
 * and view; cellValue() then does the per-cell arithmetic. source = 'field' (GPU) or 'fallback' (approximate
 * slice), so each gets its own calibration.
 */
function ui_valueFn(viewId, met, bg, p, source = 'field', incOnly = false) {
  if (!ui_X.cellValue) return null;
  if (ui_X.sliceContext) {
    // incOnly: the local increment (model.js cellValue with met.incOnly; for NO2 the chemistry total minus NO2_bg)
    const ctx = ui_try('model.sliceContext', () => ui_X.sliceContext({ met, dateUTC: met.dateUTC, measures: ui_measuresFor(viewId), background: bg, opts: { ...ui_opts(), incOnly }, source }), null);
    if (!ctx) return null;
    return (g4, a4) => ui_X.cellValue(g4, a4, ctx.strengthsAll, ctx.met, ctx.bg, p);
  }
  const S = ui_strengthsAll(viewId);
  if (!S) return null;
  const m = { ...met, incOnly };
  return (g4, a4) => ui_X.cellValue(g4, a4, S, m, bg, p);
}
/** Street share above the band and the school value for one view. */
function ui_pointStats(viewId, met, bg) {
  const p = state.pollutant;
  const vf = ui_viewField(viewId, met);
  const fn = vf ? ui_valueFn(viewId, met, bg, p, vf.approximate ? 'fallback' : 'field') : null;
  const out = { share: NaN, n: 0, poi: NaN, poiInside: false, stale: vf ? vf.stale : true, nofield: !vf || !fn };
  if (!vf || !fn) return out;
  const f = vf.field;
  if (typeof f.sample !== 'function') return out;
  const q = new THREE.Vector3(), s8 = new Float32Array(8);
  const g4 = new Float32Array(4), a4 = new Float32Array(4);
  const val = (x, z) => {
    q.set(x, UI_POI_Y, z);
    if (!f.sample(q, s8)) return NaN;
    for (let k = 0; k < 4; k++) { g4[k] = s8[k]; a4[k] = s8[4 + k]; }
    return fn(g4, a4);
  };
  const poi = ui_nearestPoi();
  if (poi) { const v = ui_try('field.sample', () => val(poi.x, poi.z), NaN); out.poi = v; out.poiInside = Number.isFinite(v); }
  const lo = ui_bandLo(p, state.bandLevel);
  if (ui_streetPts && Number.isFinite(lo)) {
    let n = 0, above = 0;
    ui_try('field.sample', () => {
      for (let i = 0; i < ui_streetPts.length; i += 2) {
        const v = val(ui_streetPts[i], ui_streetPts[i + 1]);
        if (!Number.isFinite(v)) continue;
        n++;
        if (v > lo) above++;
      }
    });
    out.n = n;
    out.share = n ? above / n : NaN;
  }
  return out;
}

// ------------------------------------------------------------------ view results (instant path)
const ui_res = { today: null, scenario: null };
let ui_dirty = { model: true, slices: true, points: true, charts: true, data: true, request: false };
function ui_invalidate(...what) { for (const w of what) ui_dirty[w] = true; }

function ui_recomputeModel() {
  ui_res.today = ui_evalView('today');
  ui_res.scenario = ui_evalView('scenario');
  const p = state.pollutant, pt = ui_pick(ui_res.today.c, p);
  window.__z1.receptor = Number.isFinite(pt.total) ? pt.total : null;
  // particles are released in proportion to each group's emission of the pollutant on screen (NOx for NO2)
  if (ui_X.groupStrengths) {
    const d = new Date(state.time), q = p === 'no2' ? 'nox' : p;
    for (const v of ui_views) {
      if (!v.particles || typeof v.particles.setStrengths !== 'function') continue;
      const s = ui_try('emissions.groupStrengths', () => ui_X.groupStrengths(q, d, ui_measuresFor(v.id), ui_opts()), null);
      const key = s ? JSON.stringify(s) : '';
      if (s && key !== v.qKey) { v.qKey = key; ui_try('visuals.Particles.setStrengths', () => v.particles.setStrengths(s)); }
    }
  }
}
let ui_lastPoints = 0, ui_pointsRes = { today: null, scenario: null };
function ui_recomputePoints() {
  for (const v of ['today', 'scenario']) {
    const r = ui_res[v];
    ui_pointsRes[v] = r ? ui_pointStats(v, r.met, r.bg) : null;
  }
}

// ------------------------------------------------------------------ panel: comparison and view cards
function ui_isStale(viewId) {
  if (!ui_aero) return false;
  const k = ui_viewKey(viewId);
  return !!(ui_pending.has(ui_keyStr(k)) || (viewId === 'scenario' && ui_res.scenario && ui_res.scenario.ga && ui_res.scenario.ga.pending));
}
function ui_renderCompare() {
  const p = state.pollutant, u = ui_unit(p);
  ui_setText('#cmp-total-h', t('ui.cmp.total', { p: ui_polName(p), unit: u }));
  ui_setText('#cmp-inc-h', t('ui.cmp.inc.u', { unit: u }));
  ui_setText('#cmp-bg-h', t('ui.cmp.bg.u', { unit: u }));
  const poi = ui_nearestPoi();
  ui_setText('#cmp-poi-h', poi ? t('ui.cmp.poi', { name: poi.n || poi.t, unit: u }) : t('ui.cmp.poi.none'));
  const lvl = state.bandLevel, hasBand = Number.isFinite(ui_bandLo(p, lvl));
  ui_setText('#cmp-share-h', t('ui.cmp.share', { band: hasBand ? t('ui.eaqi.ge', { name: t(`ui.eaqi.${lvl}`) }) : t('ui.cmp.noband') }));
  const vals = {};
  for (const v of ['today', 'scenario']) {
    const r = ui_res[v], pk = ui_pick(r && r.c, p), ps = ui_pointsRes[v];
    vals[v] = pk;
    const stale = ui_isStale(v);
    const set = (k, text, small) => {
      const td = $(`[data-c="${v}.${k}"]`);
      if (!td) return;
      td.textContent = text;
      if (small) { const s = document.createElement('small'); s.textContent = small; td.appendChild(s); }
      const st = stale || (k !== 'bg' && !!(ps && ps.stale && (k === 'poi' || k === 'share')));
      td.classList.toggle('stale', st);
      if (st) td.title = t('ui.note.stale'); else td.removeAttribute('title');
    };
    set('total', ui_fmtC(p, pk.total));
    set('inc', ui_fmtC(p, pk.inc));
    set('bg', ui_fmtC(p, pk.bg), r ? t(`ui.bgsrc.${r.bg.source[p] === 'derived' ? 'derived' : r.bg.source[p]}`) : '');
    if (!poi) set('poi', '–', t('ui.cmp.poi.nodata'));
    else if (!ps || ps.nofield) set('poi', '…', t('ui.cmp.nofield'));
    else set('poi', ps.poiInside ? ui_fmtC(p, ps.poi) : '–', ps.poiInside ? '' : t('ui.cmp.outside'));
    if (!hasBand) set('share', '–', t('ui.cmp.noband'));
    else if (!ps || ps.nofield || !Number.isFinite(ps.share)) set('share', '…', t('ui.cmp.nofield'));
    else set('share', `${fmt(ps.share * 100, ps.share < 0.1 ? 1 : 0)} %`, '');
  }
  // scenario − today, under the scenario's total, when it shows at the display resolution
  const dT = vals.scenario.total - vals.today.total;
  const tdS = $('[data-c="scenario.total"]');
  if (tdS && Number.isFinite(dT) && Math.abs(dT) >= 0.5 * 10 ** -ui_dec(p, vals.today.total)) {
    const s = document.createElement('span');
    s.className = 'delta';
    s.textContent = `${dT >= 0 ? '+' : '−'}${ui_fmtC(p, Math.abs(dT))} (${dT >= 0 ? '+' : '−'}${fmt(Math.abs(dT / (vals.today.total || 1)) * 100)} %)`;
    tdS.insertBefore(s, tdS.querySelector('small'));
  }
  // attribution chart
  const seg = (pk) => {
    const g = pk.groups || [NaN, NaN, NaN, NaN];
    return [
      { id: 'A', label: t('ui.cmp.group.A'), value: g[0], cls: 's1' },
      { id: 'B', label: t('ui.cmp.group.B'), value: g[1], cls: 's2' },
      { id: 'C', label: t('ui.cmp.group.C'), value: g[2], cls: 's3' },
      { id: 'D', label: t('ui.cmp.group.D'), value: g[3], cls: 's4' },
      { id: 'bg', label: t('ui.cmp.group.bg'), value: pk.bg, cls: 's0' },
    ];
  };
  ui_try('charts.attr', () => barChart($('#attr-chart'), {
    mode: 'stack', unit: u, label: t('ui.cmp.attr'),
    rows: [{ label: t('ui.view.today.short'), segments: seg(vals.today) }, { label: t('ui.view.scenario.short'), segments: seg(vals.scenario) }],
  }));
  // provenance note
  const src = ui_res.today && ui_res.today.ga ? ui_res.today.ga.source : null;
  const notes = [];
  if (src === 'lut') notes.push(t('ui.cmp.note.lut'));
  else if (src === 'field') notes.push(t('ui.cmp.note.field'));
  else if (src) notes.push(t('ui.cmp.note.fallback'));
  const sga = ui_res.scenario && ui_res.scenario.ga;
  if (ui_scenGeo() && sga) notes.push(t('ui.cmp.note.geo', { pct: fmt((sga.coverage || 0) * 100) }));
  if (vals.today.split) notes.push(t('ui.cmp.note.no2split'));
  if ((p === 'pm10' || p === 'pm25') && hasBand) notes.push(t('ui.cmp.note.pm'));
  const ps = ui_pointsRes.today;
  if (ps && ps.n) notes.push(t('ui.cmp.note.share', { n: fmt(ps.n) }));
  ui_setText('#cmp-note', notes.join(' '));
}
function ui_renderViewCards() {
  const p = state.pollutant;
  for (const v of ['today', 'scenario']) {
    const box = $(`.view-stats[data-for="${v}"]`);
    if (!box) continue;
    const r = ui_res[v], pk = ui_pick(r && r.c, p);
    box.classList.toggle('stale', ui_isStale(v));
    ui_setText($('[data-k="totalLabel"]', box), t('ui.stat.total', { p: ui_polName(p) }));
    const tot = $('[data-k="total"]', box), inc = $('[data-k="inc"]', box);
    tot.textContent = ui_fmtC(p, pk.total);
    inc.textContent = ui_fmtC(p, pk.inc);
    for (const e of [tot, inc]) { const s = document.createElement('small'); s.textContent = ui_unit(p); e.appendChild(s); }
    const bd = $('[data-k="band"]', box);
    bd.textContent = '';
    const b = ui_band(p, pk.total);
    if (b.level > 0) {
      const sw = document.createElement('i'); sw.className = 'sw-band'; sw.style.background = b.color; bd.appendChild(sw);
      bd.appendChild(document.createTextNode(t(`ui.eaqi.${b.level}`)));
    } else bd.textContent = Number.isFinite(pk.total) ? t('ui.now.noindex') : ' ';
    ui_setText($('[data-k="incSub"]', box), Number.isFinite(pk.bg) ? t('ui.stat.incSub', { bg: `${ui_fmtC(p, pk.bg)} ${ui_unit(p)}` }) : ' ');
  }
  const s = ui_scen();
  ui_setText('#scen-title', state.scenario === 'today' ? t('ui.view.scenario') : `${t('ui.view.scenario')}: ${ui_scenLabel(s)}`);
  const parts = [ui_scenDesc(s)];
  const m = state.measures, ms = [];
  if (m.lez) ms.push(t('ui.measures.lez').split(' (')[0]);
  if (m.evShare) ms.push(`${t('ui.measures.ev')} ${m.evShare} %`);
  if (m.eBus) ms.push(t('ui.measures.ebus').split(' (')[0]);   // the note in brackets (emissions.js EM_SHARES.bus) stays with the control
  if (m.carFreeMiramarska) ms.push(t('ui.measures.carfree'));
  if (m.trafficChange) ms.push(`${t('ui.measures.dtraffic')} ${m.trafficChange > 0 ? '+' : ''}${m.trafficChange} %`);
  if (ms.length) parts.push(ms.join(' · '));
  ui_setText('#scen-desc', parts.filter(Boolean).join(' '));
}

// ------------------------------------------------------------------ panel: weather, time, sources text
function ui_renderWeather() {
  const met = ui_met();
  ui_setText('#u10-out', `${fmt(state.u10, 1)} m/s`);
  let hint = t('ui.wind.calm');
  if (state.u10 >= 0.5) {
    const bf = ui_X.beaufort ? ui_try('meteo.beaufort', () => ui_X.beaufort(state.u10), null) : null;
    hint = bf ? t('ui.wind.bft', { name: bf.name.charAt(0).toUpperCase() + bf.name.slice(1), b: bf.b }) : '';
  }
  ui_setText('#u10-hint', hint);
  const d = ui_dir(state.from);
  ui_setText('#dial-value', t('ui.dial.value', { dir: d.text }));
  const dial = $('#dial');
  if (dial) {
    dial.setAttribute('aria-valuenow', String(Math.round(state.from * 10) / 10));
    dial.setAttribute('aria-valuetext', t('ui.dial.valuetext', { dir: d.text, deg: fmt(state.from) }));
    const arr = $('.dial-arrow', dial);
    if (arr) arr.setAttribute('transform', `rotate(${state.from})`);
  }
  const src = state.stability === 'auto' ? t('ui.stab.src.auto') : t('ui.stab.src.manual');
  const metLine = met.source
    ? t('ui.met.src.ifs', { cc: fmt(met.cc), sw: fmt(met.sw), blh: fmt(met.blh), src: t(`ui.met.src.${met.source === 'hist' ? 'hist' : 'live'}`) })
    : t('ui.met.src.none');
  // The lid shown is mixingHeight() for the hour; the 3D solve (and so the LUT and the station numbers) uses the stability
  // group's representative lid (aero.js AERO_STAB: AC 520 m, D 135 m, EF 100 m), because the Aero key has no lid.
  const hg = typeof AERO_STAB !== 'undefined' && AERO_STAB[met.group] ? AERO_STAB[met.group].h_eff : NaN;
  ui_setText('#stab-hint', `${t('ui.stab.hint', { cls: met.cls, src, grp: met.group, h: fmt(met.h_eff), hg: fmt(hg) })} ${metLine}`);
  // date / hour (hour-ending semantics: 24:00 belongs to the previous day)
  const hs = ZgTime.hourStart(state.time);
  const he = hs.h + 1;                     // slider position: local hour START + 1 (1–24)
  const hend = ui_endHour(state.time);     // the clock at the hour's end (differs from he on DST switch days)
  const dateEl = $('#date');
  const iso = `${hs.y}-${String(hs.mo).padStart(2, '0')}-${String(hs.d).padStart(2, '0')}`;
  if (dateEl && dateEl.value !== iso) dateEl.value = iso;
  const hourEl = $('#hour');
  if (hourEl && +hourEl.value !== he) hourEl.value = String(he);
  ui_setText('#hour-out', t('ui.time.out', { end: `${String(hend).padStart(2, '0')}:00`, a: String(hs.h).padStart(2, '0'), b: String(hend).padStart(2, '0') }));
  const dt = ZgTime.dayType(state.time);
  ui_setText('#daytype', t('ui.time.derived', { dow: t(`ui.dow.${hs.dow}`), daytype: t(`ui.daytype.${dt}`), month: t(`ui.month.${hs.mo}`), heat: ui_isHeatingMonth(hs.mo) ? t('ui.heatseason') : '' }));
  const ml = { explore: 'ui.mode.explore', now: 'ui.mode.now', forecast: 'ui.mode.forecast' }[state.mode];
  ui_setHTML('#mode-line', t('ui.mode.line', { mode: t(ml), time: ui_span(state.time, true) }));
  ui_setText('#cmp-time', t('ui.cmp.time', { span: ui_span(state.time, true) }));
}
function ui_renderSources() {
  for (const k of ['traffic', 'trafficA', 'trafficB']) ui_setText(`#${k}-out`, `${state[k]} %`);
  ui_setText('#traffic-hint', t('ui.traffic.hint'));
  const bg = ui_bg();
  ui_setText('#sources-hint', t('ui.sources.hint', {
    heat: ui_heatingOn() ? t('ui.on') : t('ui.off'),
    leaves: t(`ui.leaves.${ui_leafMode()}`),
    bg: t(`ui.bgsrc.${bg.source[state.pollutant === 'co' || state.pollutant === 'c6h6' ? 'no2' : state.pollutant]}`),
  }));
  ui_setText('#ev-out', `${state.measures.evShare} %`);
  ui_setText('#dtraffic-out', `${state.measures.trafficChange > 0 ? '+' : ''}${state.measures.trafficChange} %`);
  const c = state.custom;
  ui_setText('#cw-out', `${c.w} m`); ui_setText('#cd-out', `${c.d} m`); ui_setText('#ch-out', `${c.h} m`); ui_setText('#cr-out', `${c.rot}°`);
  ui_setText('#place-hint', ui_placing ? t('ui.custom.placing')
    : t('ui.custom.at', { x: fmt(Math.abs(c.x)), ew: c.x >= 0 ? t('ui.custom.east') : t('ui.custom.west'), z: fmt(Math.abs(c.z)), ns: c.z <= 0 ? t('ui.custom.north') : t('ui.custom.south') }));
  const s = ui_scen();
  ui_setText('#scenario-desc', !ui_X.SCENARIOS ? t('ui.scen.unavailable')
    : [ui_scenDesc(s), state.scenario === 'today' ? '' : (ui_scenGeo() ? t('ui.scen.needsFlow') : t('ui.scen.emOnly'))].filter(Boolean).join(' '));
  $('#custom-box').hidden = state.scenario !== 'custom';
  ui_setText('#pol-hint', t(`ui.pol.hint.${state.pollutant}`));
  ui_setText('#slice-out', `${fmt(state.sliceH, 1)} m`);
  const bl = ui_X.buildingLegendHTML && state.bcol !== 'plain' ? ui_try('city.buildingLegendHTML', () => ui_X.buildingLegendHTML(state.bcol), '') : '';
  if (typeof bl === 'string' && bl) ui_setHTML('#bcol-hint', bl);
  else ui_setText('#bcol-hint', state.bcol === 'plain' ? '' : t(`ui.disp.bcol.hint.${state.bcol}`));
  ui_setText('#preset-hint', [state.preset ? t(`ui.preset.hint.${state.preset}`) : '', UI_OFFLINE ? t('ui.preset.offline') : ''].filter(Boolean).join(' '));
  ui_setText('#slicewhat-hint', t(state.sliceWhat === 'inc' ? 'ui.map.what.hint.inc' : 'ui.map.what.hint.total'));
  ui_setText('#palette-hint', t('ui.disp.palette.hint'));
}
/** aria-pressed on every segmented control and preset from the state. */
function ui_syncControls() {
  const map = { lid: state.lid, pollutant: state.pollutant, index: state.index, calib: state.calibrated ? 'cal' : 'raw', bcol: state.bcol, split: state.split, dataView: state.dataView, palette: state.palette, sliceWhat: state.sliceWhat };
  for (const g of $$('[data-group]')) for (const b of $$('button[data-value]', g)) b.setAttribute('aria-pressed', String(b.dataset.value === map[g.dataset.group]));
  for (const b of $$('[data-preset]')) b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset));
  // "Now" and "Forecast +24 h" need live data: disabled (with the reason as a tooltip) under ?live=0
  for (const b of [...$$('[data-preset="now"], [data-preset="fc24"]'), $('#use-now'), $('#fc-load')]) {
    if (!b) continue;
    b.disabled = UI_OFFLINE;
    if (UI_OFFLINE) b.title = t('ui.preset.offline'); else b.removeAttribute('title');
  }
  // the palette choice colours the bands of the total; the local-increment map has one fixed ramp
  for (const b of $$('[data-group="palette"] button')) b.disabled = state.sliceWhat !== 'total';
  for (const b of $$('[data-cam]')) b.setAttribute('aria-pressed', String(b.dataset.cam === state.cam));
  const vals = { u10: state.u10, traffic: state.traffic, trafficA: state.trafficA, trafficB: state.trafficB, ev: state.measures.evShare,
    dtraffic: state.measures.trafficChange, 'slice-h': state.sliceH, cw: state.custom.w, cd: state.custom.d, ch: state.custom.h, cr: state.custom.rot };
  for (const [id, v] of Object.entries(vals)) { const e = document.getElementById(id); if (e && +e.value !== v) e.value = String(v); }
  const sel = { stab: state.stability, heating: state.heating, leaves: state.leaves, bgsrc: state.bgSource, scenario: state.scenario, 'band-level': String(state.bandLevel) };
  for (const [id, v] of Object.entries(sel)) { const e = document.getElementById(id); if (e && e.value !== v) e.value = v; }
  const chk = { congestion: state.congestion, resusp: state.resuspension, lez: state.measures.lez, ebus: state.measures.eBus, carfree: state.measures.carFreeMiramarska,
    slice: state.slice, particles: state.particles, streaks: state.streaks, xray: state.xray, lod2: state.lod2 };
  for (const [id, v] of Object.entries(chk)) { const e = document.getElementById(id); if (e) e.checked = v; }
  const views = $('#views');
  if (views) {
    views.classList.toggle('single', state.split !== 'split');
    $('#view-a').hidden = state.split === 'scenario';
    $('#view-b').hidden = state.split === 'today';
  }
}

// ------------------------------------------------------------------ panel: now at the station
const UI_NOW_POLS = ['no2', 'pm10', 'pm25', 'nox', 'co', 'c6h6'];
/** 24 h running mean ending at the last value when ≥ 18 of 24 hours exist (the 75 % rule), else NaN. */
function ui_mean24(rows) {
  if (!rows || !rows.length) return NaN;
  const end = rows[rows.length - 1].t;
  const w = rows.filter((r) => r.t > end - 24 * UI_H);
  return w.length >= 18 ? w.reduce((a, r) => a + r.v, 0) / w.length : NaN;
}
function ui_renderNow() {
  const chips = $('#now-chips');
  if (!chips) return;
  const live = ui_live.recent;
  const hasLive = live && Object.values(live.z1).some((r) => r && r.length);
  const src = hasLive ? 'live' : (Hist.ok && Object.keys(Hist.latest || {}).length ? 'baked' : 'none');
  const latest = (st, p) => {
    if (src === 'live') { const r = live[st][p]; return r && r.length ? r[r.length - 1] : null; }
    if (src === 'baked') { const l = Hist.latest[`${st}.${p}`]; return l && Number.isFinite(l.v) ? l : null; }
    return null;
  };
  chips.textContent = '';
  let tLast = -Infinity;
  for (const p of UI_NOW_POLS) { const l = latest('z1', p); if (l) tLast = Math.max(tLast, l.t); }
  for (const p of UI_NOW_POLS) {
    const l = latest('z1', p);
    const li = document.createElement('li');
    li.className = 'chip';
    const nm = document.createElement('span'); nm.className = 'chip-name'; nm.textContent = ui_polName(p); li.appendChild(nm);
    const vv = document.createElement('span'); vv.className = 'chip-val';
    const b = document.createElement('b');
    b.textContent = l ? fmt(l.v, p === 'co' ? 2 : l.v < 10 ? 1 : 0) : '–';
    vv.appendChild(b); vv.appendChild(document.createTextNode(` ${ui_unit(p)}`)); li.appendChild(vv);
    const band = document.createElement('span'); band.className = 'chip-band';
    // PM bands use the 24 h running mean (iszz-api §9.3); NO2 the hourly value.
    const isPM = p === 'pm10' || p === 'pm25';
    const v24 = !isPM || !l ? NaN : src === 'live' ? ui_mean24(live.z1[p]) : ui_mean24(Hist.window(`z1.${p}`, l.t - 23 * UI_H, l.t));
    const vb = isPM ? v24 : (l ? l.v : NaN);
    const bd = ui_band(p, vb);
    const sw = document.createElement('i'); sw.className = 'sw-band'; sw.style.background = bd.level ? bd.color : 'transparent';
    band.appendChild(sw);
    band.appendChild(document.createTextNode(ui_bandLimits(p)
      ? (bd.level ? `${t(`ui.eaqi.${bd.level}`)} · ${isPM ? t('ui.now.pm24') : t('ui.now.hourly')}` : t('ui.eaqi.0'))
      : t('ui.now.noindex')));
    // a value from another hour than the card's header says so (e.g. CO often arrives an hour later)
    if (l && l.t !== tLast) band.appendChild(document.createTextNode(` · ${t('ui.now.at', { time: fmtLocal(l.t, { ending: true, date: false }) })}`));
    li.appendChild(band);
    if (l && Date.now() - l.t > 6 * UI_H && src === 'live') li.classList.add('stale');
    chips.appendChild(li);
  }
  ui_setText('#now-time', Number.isFinite(tLast) ? `${t('ui.now.time', { span: ui_span(tLast) })} · ${t('ui.now.age', { h: fmt(Math.max(0, (Date.now() - tLast) / UI_H), (Date.now() - tLast) / UI_H < 10 ? 1 : 0) })}` : t(ui_live.status === 'loading' ? 'ui.now.loading' : 'ui.now.src.none'));
  // badge: the official ISZZ index (legacy bands); shown only when ISZZ published one (the note says so otherwise)
  const badge = $('#now-badge');
  const ez = ui_live.eaqi && ui_live.eaqi.z1;
  const lvl = ez ? ez.index : 0;
  badge.hidden = !lvl;
  badge.textContent = lvl ? String(lvl) : '–';
  badge.dataset.level = String(lvl);
  badge.style.background = lvl ? UI_EAQI.iszz.colors[lvl] : '';
  badge.style.color = lvl >= 5 ? '#ffffff' : lvl ? '#16222a' : '';
  badge.setAttribute('aria-label', t('ui.now.badge.aria', { n: lvl, name: t(`ui.eaqi.${lvl}`) }));
  badge.setAttribute('role', 'img');
  ui_setText('#now-badge-note', lvl ? t('ui.now.badge', { name: t(`ui.eaqi.${lvl}`) }) : t('ui.now.badge.none'));
  // measured wind (display only, critic §1.5)
  const ws = latest('z1', 'ws'), wd = latest('z1', 'wd');
  ui_setText('#now-wind', ws && wd ? t('ui.now.wind', { u: fmt(ws.v, 1), dir: ui_dir(wd.v).text }) : t('ui.now.wind.none'));
  const bgl = ['no2', 'nox', 'o3', 'pm10', 'pm25'].map((p) => { const l = latest('z4', p); return l ? `${ui_polName(p)} ${fmt(l.v, l.v < 10 ? 1 : 0)}` : null; }).filter(Boolean);
  ui_setText('#now-bg', bgl.length ? t('ui.now.bg', { list: `${bgl.join(', ')} µg/m³` }) : t('ui.now.bg.none'));
  const tb = Hist.ok ? Math.max(...Object.values(Hist.latest || {}).map((l) => l.t || 0), 0) : 0;
  const bakedKey = UI_OFFLINE ? 'ui.now.src.offline' : ui_live.status === 'loading' ? 'ui.now.src.bakedWait' : 'ui.now.src.baked';
  // series that did not load (network, rate limit): named, never silently missing (architecture §7)
  const errs = (live && live.errors) || [];
  const missing = errs.map((e) => `${e.station === 'z4' ? 'ZAGREB-4' : 'ZAGREB-1'} ${ui_polName(e.key) !== `ui.pol.name.${e.key}` ? ui_polName(e.key) : e.key}`);
  const missNote = missing.length ? ` ${t('ui.now.missing', { list: missing.join(', '), err: errs[0].error })}` : '';
  ui_setText('#now-src', (src === 'live' ? t('ui.now.src.live', { time: fmtLocal(live.t) }) : src === 'baked' ? t(bakedKey, { time: fmtLocal(tb, { year: true }) }) : (ui_live.status === 'loading' ? t('ui.now.loading') : t('ui.now.src.none'))) + missNote);
}

// ------------------------------------------------------------------ panel: hindcast (model vs measurements, 72 h)
/*
 * Window: the last 72 h (live) or, in explore mode on a past hour, the 72 h ending at the selected hour.
 * Measured, raw drawn solid and validated dashed (ISZZ publishes validated data once a year, iszz-api §0):
 *   - recent window: the live raw ISZZ rows (tipPodatka 0);
 *   - inside the baked archive: its series, which are validated up to MEAS.meta.validated_until[key] and raw after
 *     (tools/build_measurements.py), split at that time;
 *   - outside both: raw and validated fetched from ISZZ for the window on demand.
 * Model: ReceptorModel + concentrations() at each hour with that hour's IFS wind, stability and mixing height, the
 * ZAGREB-4 background, and the traffic/source settings of the panel.
 */
function ui_hindMeasured(p, w) {
  const liveRows = ui_live.recent && ui_live.recent.z1[p];
  if (!w.past && liveRows && liveRows.length) return { raw: liveRows.filter((r) => r.t >= w.from && r.t <= w.to), valid: [], src: 'live' };
  const vu = Hist.meta && Hist.meta.validated_until ? Hist.meta.validated_until[`z1.${p}`] : null;
  if (Hist.ok && Hist.indexAt(w.from) >= 0) {
    const all = Hist.window(`z1.${p}`, w.from, w.to);
    return { raw: all.filter((q) => !(vu && q.t <= vu)), valid: all.filter((q) => vu && q.t <= vu), src: 'hist' };
  }
  if (UI_OFFLINE) return { raw: [], valid: [], src: 'none' };
  const kr = `${p}|${w.from}|0`, kv = `${p}|${w.from}|1`;
  if (!ui_live.valid.has(kr)) ui_loadWindow(p, w.from, w.to, kr, SITE.iszz.types.hourly_raw);
  if (!ui_live.valid.has(kv)) ui_loadWindow(p, w.from, w.to, kv, SITE.iszz.types.hourly_validated);
  const g = (k) => { const v = ui_live.valid.get(k); return Array.isArray(v) ? v : []; };
  const loading = ui_live.valid.get(kr) === 'loading' || ui_live.valid.get(kv) === 'loading';
  return { raw: g(kr), valid: g(kv), src: loading ? 'loading' : 'fetched' };
}
function ui_hindWindow() {
  const now = ZgTime.currentHourEnding() - UI_H;
  const past = state.mode === 'explore' && state.time < now - 3 * UI_H;
  const end = past ? state.time : now;
  return { from: end - 71 * UI_H, to: end, past };
}
/**
 * The modelled receptor values at one hour with that hour's own weather: metRow = {u10, wd[, blh, t2, cc, sw]}
 * (an IFS row; when it has no cloud/BLH the archive or live row of that hour supplies them). Stability and lid
 * are 'auto' for the hour, whatever the manual controls say. Returns ui_pick() of the pollutant, or null.
 */
function ui_modelAt(tMs, metRow, viewId = 'today', pollutant = state.pollutant, bgOverride = null) {
  if (!ui_X.concentrations || !metRow || !Number.isFinite(metRow.u10) || !Number.isFinite(metRow.wd)) return null;
  const row = metRow.blh !== undefined || metRow.cc !== undefined ? metRow : ui_metRow(tMs);
  const met = ui_met({ t: tMs, u10: metRow.u10, from: metRow.wd, stab: 'auto', lid: 'auto', row });
  const bg = bgOverride || ui_bg(tMs, 'auto');
  let ga = null;
  if (ui_receptor) ga = ui_try('model.gammaAt', () => ui_receptor.gammaAt(met.from, met.u10, met.cls), null);
  else if (ui_fallback) { const r = ui_try('fallback.receptor', () => ui_fallback.receptor(met.from, met.cls), null); if (r) ga = { gamma: r.gamma, age: r.age, source: 'fallback' }; }
  if (!ga) return null;
  const c = ui_try('model.concentrations', () => ui_X.concentrations({ met, dateUTC: met.dateUTC, measures: ui_measuresFor(viewId), background: bg, pollutant, gammaAge: ga, opts: ui_opts(tMs) }), null);
  return c ? ui_pick(c, pollutant) : null;
}
function ui_renderHindcast() {
  const el = $('#hind-chart');
  if (!el) return;
  const p = state.pollutant, w = ui_hindWindow();
  const title = w.past ? t('ui.hind.title.past', { p: ui_polName(p), time: fmtLocal(w.to, { ending: true, year: true }), unit: ui_unit(p) }) : t('ui.hind.title', { p: ui_polName(p), unit: ui_unit(p) });
  ui_setText('#hind-title', title);
  // measured
  const M = ui_hindMeasured(p, w);
  const meas = M.raw, valid = M.valid;
  const measLabel = M.src === 'hist' ? t('ui.hind.meas.hist') : t('ui.hind.meas');
  // model rows
  const model = [], bgs = [];
  for (let tt = w.from; tt <= w.to; tt += UI_H) {
    let row = null;
    if (Hist.ok && Hist.indexAt(tt) >= 0) { const u = Hist.value('ifs.u10', tt), d = Hist.value('ifs.wd10', tt); if (Number.isFinite(u) && Number.isFinite(d)) row = { u10: u, wd: d }; }
    if (!row && ui_live.fc) row = ui_byT(ui_live.fc).get(tt) || null;
    const pk = row ? ui_modelAt(tt, row) : null;
    model.push({ t: tt, v: pk && Number.isFinite(pk.total) ? pk.total : NaN });
    bgs.push({ t: tt, v: pk && Number.isFinite(pk.bg) ? pk.bg : NaN });
  }
  const hasModel = model.some((q) => Number.isFinite(q.v));
  if (!meas.length && !valid.length && !hasModel) {
    el.textContent = '';
    const pp = document.createElement('p'); pp.className = 'chart-empty';
    pp.textContent = ui_live.status === 'loading' ? t('ui.hind.loading') : t('ui.hind.none');
    el.appendChild(pp);
    ui_setText('#hind-note', '');
    return;
  }
  const series = [];
  if (meas.length) series.push({ label: measLabel, points: meas, cls: 's1' });
  if (valid.length) series.push({ label: t('ui.hind.valid'), points: valid, cls: 's1', dash: true });
  if (hasModel) series.push({ label: t('ui.hind.model'), points: model, cls: 's2' }, { label: t('ui.hind.bg'), points: bgs, cls: 's0' });
  const lim = ui_limitLines(p, 'hourly');
  ui_try('charts.hindcast', () => lineChart(el, {
    label: title, unit: ui_unit(p), series, thresholds: lim, domain: [w.from, w.to],
    band: hasModel ? { lo: model.map((q) => ({ t: q.t, v: q.v / 2 })), hi: model.map((q) => ({ t: q.t, v: q.v * 2 })), label: t('ui.hind.band'), cls: 's2' } : null,
    marker: state.time >= w.from && state.time <= w.to ? state.time : NaN,
  }));
  const vs = M.src === 'loading' ? t('ui.hind.valid.loading') : valid.length ? t('ui.hind.valid.some') : t('ui.hind.valid.none');
  ui_setText('#hind-note', `${hasModel ? '' : t('ui.hind.nomodel') + ' '}${t('ui.hind.note', { valid: vs })}`);
}
async function ui_loadWindow(p, from, to, key, type) {
  ui_live.valid.set(key, 'loading');
  try {
    const rows = await Live.iszz(SITE.station.iszz_id, p, from, to, type);
    ui_live.valid.set(key, rows);
  } catch (e) {
    ui_live.valid.set(key, []);
  }
  ui_invalidate('charts');
}

// ------------------------------------------------------------------ panel: sweep + model/measured rose
/*
 * Like for like over the hours of the baked archive (the last ~400 days, MEAS.meta.t0 … t0 + n h): for every hour with
 * a measured increment (ZAGREB-1 − ZAGREB-4) and IFS wind, the model increment is evaluated with that hour's own
 * wind, class, lid and emissions; both are averaged per IFS "from" sector (16 sectors, the binning of
 * MEAS.stats.rose). Computed in chunks so the page stays responsive (~0.5 s in the headless check). Without an
 * archive the model rose is the increment at the selected hour and speed for each direction, with no measurement.
 */
const ui_sweep = { active: false, keys: [], group: null };
const ui_rose = { key: null, model: null, progress: 0, running: false };
/** The rose needs a background measurement for the increment: ZAGREB-4 has NOx, NO2, PM10, PM2.5 (else NOx). */
function ui_rosePollutant() {
  const p = state.pollutant;
  return Hist.has(`z4.${p}`) || !Hist.ok ? (SITE.iszz.params[p] && SITE.iszz.params[p].z4 ? p : 'nox') : 'nox';
}
function ui_roseKey() {
  return [ui_rosePollutant(), state.calibrated, state.traffic, state.trafficA, state.trafficB, state.congestion, state.heating, state.resuspension, window.__z1.fields].join('|');
}
async function ui_computeRose() {
  const key = ui_roseKey();
  if (ui_rose.running || ui_rose.key === key) return;
  ui_rose.running = true;
  const p = ui_rosePollutant();
  const sum = new Float64Array(16), cnt = new Float64Array(16), msum = new Float64Array(16);
  try {
    if (Hist.ok && Hist.has('ifs.u10') && ui_X.concentrations) {
      const u = Hist.series('ifs.u10'), d = Hist.series('ifs.wd10');
      const z1 = Hist.series(`z1.${p}`), z4 = Hist.series(`z4.${p}`);
      const CH = 400;
      for (let i0 = 0; i0 < Hist.n; i0 += CH) {
        for (let i = i0; i < Math.min(Hist.n, i0 + CH); i++) {
          if (!Number.isFinite(u[i]) || !Number.isFinite(d[i]) || !Number.isFinite(z1[i]) || !Number.isFinite(z4[i])) continue;
          const tt = Hist.timeAt(i);
          const pk = ui_modelAt(tt, { u10: u[i], wd: d[i] }, 'today', p);   // this hour's own class, lid and emissions
          if (!pk || !Number.isFinite(pk.inc)) continue;
          const k = ui_dirIdx(d[i]);
          sum[k] += pk.inc; msum[k] += z1[i] - z4[i]; cnt[k]++;
        }
        ui_rose.progress = Math.min(1, (i0 + CH) / Hist.n);
        ui_setText('#rose-note', t('ui.rose.computing', { pct: fmt(ui_rose.progress * 100) }));
        await new Promise((r) => setTimeout(r, 0));
        if (ui_roseKey() !== key) { ui_rose.running = false; return ui_computeRose(); }
      }
      ui_rose.model = Array.from(sum, (s, k) => (cnt[k] ? s / cnt[k] : NaN));
      ui_rose.meas = Array.from(msum, (s, k) => (cnt[k] ? s / cnt[k] : NaN));
      ui_rose.n = Array.from(cnt);
      ui_rose.archive = true;
    } else {
      ui_rose.model = Array.from({ length: 16 }, (_, k) => { const pk = ui_modelAt(state.time, { u10: Math.max(state.u10, 0.5), wd: k * UI_DIR_STEP }, 'today', p); return pk ? pk.inc : NaN; });
      ui_rose.meas = null; ui_rose.n = null;
      ui_rose.archive = false;
    }
    ui_rose.key = key;
  } finally {
    ui_rose.running = false;
  }
  ui_renderRose();
}
function ui_renderRose() {
  const box = $('#sweep-box');
  box.hidden = !ui_rose.model;
  if (box.hidden) return;
  const p = ui_rosePollutant();
  const title = t('ui.rose.title', { p: ui_polName(p), unit: ui_unit(p) });
  ui_setText('#rose-title', title);
  const meas = ui_rose.meas, N = ui_rose.n;
  ui_try('charts.rose', () => roseChart($('#rose-chart'), {
    label: title, unit: ui_unit(p), labels: ui_dirs16(), current: ui_dirIdx(state.from),
    values: meas || ui_rose.model, valueLabel: meas ? t('ui.rose.meas') : t('ui.rose.model.now'),
    compare: meas ? ui_rose.model : null, compareLabel: ui_rose.archive ? t('ui.rose.model') : t('ui.rose.model.now'),
    extraColumns: N ? (head, rows) => { head.push(t('ui.rose.n')); rows.forEach((r, k) => r.push(fmt(N[k]))); } : null,
  }));
  const notes = [];
  if (p !== state.pollutant) notes.push(t('ui.rose.fallbackPol', { p: ui_polName(state.pollutant) }));
  const per = Hist.ok ? `${fmtLocal(Hist.t0, { time: false, year: true })} – ${fmtLocal(Hist.tEnd, { time: false, year: true })}` : '';
  notes.push(ui_rose.archive && meas ? t('ui.rose.note', { period: per }) : t('ui.rose.note.noarchive'));
  if (ui_aero && ui_sweep.group) {
    let n = 0;
    for (let d = 0; d < 16; d++) if (ui_recv.has(ui_keyStr({ scenario: 'today', dir: d, stab: ui_sweep.group }))) n++;
    notes.push(t('ui.rose.src', { n, grp: ui_sweep.group }));
  }
  ui_setText('#rose-note', notes.join(' '));
}
function ui_sweepDone() {
  if (!ui_aero || !ui_sweep.group) return false;
  for (let d = 0; d < 16; d++) if (!ui_recv.has(ui_keyStr({ scenario: 'today', dir: d, stab: ui_sweep.group }))) return false;
  return true;
}
function ui_startSweep() {
  if (!ui_aero) { ui_computeRose(); ui_setText('#sweep-note', t('ui.sweep.nolbm')); $('#sweep-box').hidden = false; return; }
  const grp = ui_met().group;
  ui_sweep.group = grp;
  const keys = [];
  const scen = ['today', ...(ui_scenGeo() ? [state.scenario] : [])];
  for (const s of scen) for (let d = 0; d < 16; d++) {
    const k = { scenario: s, dir: d, stab: grp };
    if (!ui_recv.has(ui_keyStr(k))) { keys.push(k); ui_pending.add(ui_keyStr(k)); }
  }
  ui_sweep.active = keys.length > 0;
  ui_sweep.keys = keys;
  ui_computeRose();   // at once from what exists (LUT, fields, fallback); refined as the sweep delivers
  // receptor values are all the rose needs, so the sweep keeps no fields (Aero sweep {receptorOnly})
  if (keys.length) ui_try('aero.sweep', () => ui_aero.sweep(keys, { receptorOnly: true }));
  ui_renderSweepNote();
}
function ui_renderSweepNote() {
  const btn = $('#sweep');
  if (!ui_aero) { ui_setText('#sweep-note', t('ui.sweep.nolbm')); return; }
  const grp = ui_sweep.group;
  if (!grp) { ui_setText('#sweep-note', ''); btn.disabled = false; return; }
  let n = 0;
  for (let d = 0; d < 16; d++) if (ui_recv.has(ui_keyStr({ scenario: 'today', dir: d, stab: grp }))) n++;
  btn.disabled = ui_sweep.active && n < 16;
  ui_setText('#sweep-note', n >= 16 ? t('ui.sweep.done', { grp }) : ui_sweep.active ? t('ui.sweep.running', { n }) : '');
  if (n >= 16 && ui_sweep.active) { ui_sweep.active = false; ui_computeRose(); }
}

// ------------------------------------------------------------------ panel: how good is it, LUT status
/*
 * Urban acceptance criteria of Hanna & Chang (2012), as quoted in physics §10.4: |FB| < 0.67, NMSE < 6,
 * FAC2 > 0.30, NAD < 0.50. MG, VG and R have no urban criterion; they are shown for comparison with the baseline.
 */
const UI_CRIT = { FB: (v) => Math.abs(v) < 0.67, NMSE: (v) => v < 6, FAC2: (v) => v > 0.3, NAD: (v) => v < 0.5 };
const UI_CRIT_TXT = { FB: '|FB| < 0,67', NMSE: '< 6', FAC2: '> 0,30', NAD: '< 0,50' };
function ui_renderCal() {
  const cal = CAL || {};
  const status = cal.status || 'uncalibrated';
  const per = Array.isArray(cal.period) ? cal.period.join(' – ') : '';
  const beta = status === 'fallback-only' && cal.gauss && Number.isFinite(cal.gauss.beta) ? cal.gauss.beta : cal.beta;
  const u0 = status === 'fallback-only' && cal.gauss && Number.isFinite(cal.gauss.U0) ? cal.gauss.U0 : (cal.U0 ?? MD.U0);
  ui_setText('#cal-status', t(`ui.cal.status.${status}`, { period: per, beta: fmt(beta, 2), u0: fmt(u0, 2) }));
  const tb = $('#cal-table');
  tb.textContent = '';
  // With "raw physics" the table shows the held-out metrics at β = 1 when calibrate.py wrote them: lbm.raw_physics_test
  // when the top level is the LBM fit (status "calibrated"), gauss.raw_physics_test for the Gaussian fallback.
  const g = cal.gauss || {};
  const top = cal.model === 'lbm' && cal.lbm ? cal.lbm : g;
  const rawM = cal.raw_physics_test || top.raw_physics_test || null;
  const m = !state.calibrated && rawM ? rawM : (cal.metrics_test || g.metrics_test), b = cal.baseline_test || g.baseline_test;
  const modelHead = t(cal.model === 'gauss' || status === 'fallback-only' ? 'ui.cal.model.gauss' : 'ui.cal.model')
    + (!state.calibrated && rawM ? ` (${t('ui.cal.rawShort')})` : '');
  if (m) {
    const thead = tb.createTHead().insertRow();
    for (const [i, h] of [t('ui.cal.metric'), modelHead, t('ui.cal.baseline'), t('ui.cal.crit')].entries()) {
      const th = document.createElement('th'); th.scope = 'col'; th.textContent = h; if (i === 0) th.className = 'first'; thead.appendChild(th);
    }
    const body = tb.createTBody();
    for (const k of ['FB', 'NMSE', 'MG', 'VG', 'FAC2', 'NAD', 'R', 'RMSE', 'meanObs', 'meanMod', 'n']) {
      if (!Number.isFinite(m[k]) && !(b && Number.isFinite(b[k]))) continue;
      const r = body.insertRow();
      const th = document.createElement('th'); th.scope = 'row'; th.textContent = t(`ui.cal.m.${k}`); r.appendChild(th);
      for (const src of [m, b]) {
        const td = r.insertCell();
        const v = src ? src[k] : NaN;
        td.textContent = Number.isFinite(v) ? fmt(v, k === 'n' ? 0 : ['RMSE', 'meanObs', 'meanMod'].includes(k) ? 1 : 2) : '–';
        if (UI_CRIT[k] && Number.isFinite(v)) td.className = UI_CRIT[k](v) ? 'pass' : 'fail';
      }
      r.insertCell().textContent = UI_CRIT_TXT[k] ? UI_CRIT_TXT[k].replace(/,/g, I18N.lang === 'en' ? '.' : ',') : '–';
    }
  }
  // Verdict against the baseline on the three measures critic §4.7 names (R higher, NMSE and VG lower = better).
  let verdict = '';
  if (m && b) {
    const better = [], worse = [];
    for (const [k, higher] of [['R', true], ['NMSE', false], ['VG', false]]) {
      if (!Number.isFinite(m[k]) || !Number.isFinite(b[k])) continue;
      ((higher ? m[k] > b[k] : m[k] < b[k]) ? better : worse).push(k);
    }
    if (better.length + worse.length) verdict = worse.length ? t('ui.cal.verdict.partial', { better: better.join(', ') || '–', worse: worse.join(', ') }) : t('ui.cal.verdict.all');
  }
  ui_setText('#cal-note', `${m ? t('ui.cal.what') + ' ' : t('ui.cal.nometrics') + ' '}${verdict ? verdict + ' ' : ''}${t('ui.cal.note', { notes: cal.notes || cal.note || '' })}${status === 'uncalibrated' ? ' ' + t('ui.cal.same') : ''}`);
  // LUT / fallback status, stated honestly
  let lut;
  if (ui_X.LBM && ui_X.LBM.ok === false) lut = t('ui.lut.nolbm');
  else if (!ui_X.Aero) lut = t('ui.lut.noaero');
  else if (LUT && LUT.meta) lut = t('ui.lut.ok', { dirs: (LUT.dirs || []).length, cls: (LUT.classes || []).length, grid: LUT.meta.grid || '?', date: String(LUT.meta.generated_utc || '').slice(0, 10) });
  else lut = t('ui.lut.none');
  if (ui_X.LBM && ui_X.LBM.software && ui_X.LBM.ok) lut += ` ${t('ui.note.software', { s: fmt(UI_SOFT_DRAW_MS / 1000, 1) })}`;
  ui_setText('#lut-status', lut);
  $('#export-lut').hidden = !(ui_aero && typeof ui_aero.exportLUT === 'function');
}

// ------------------------------------------------------------------ panel: forecast
function ui_forecastRows() {
  if (!ui_live.fc) return [];
  const now = ZgTime.currentHourEnding() - UI_H;
  return ui_live.fc.filter((r) => r.t > now && r.t <= now + 72 * UI_H);
}
function ui_renderForecast() {
  const el = $('#fc-chart');
  const p = state.pollutant;
  const title = t('ui.fc.title', { p: ui_polName(p), unit: ui_unit(p) });
  ui_setText('#fc-title', title);
  if (UI_OFFLINE) { el.textContent = ''; ui_setText('#fc-note', t('ui.fc.offline')); return; }
  if (ui_live.fcStatus === 'loading' && !ui_live.fc) { el.textContent = ''; ui_setText('#fc-note', t('ui.fc.loading')); return; }
  if (!ui_live.fc) { el.textContent = ''; ui_setText('#fc-note', ui_live.fcErr ? t('ui.fc.fail', { err: ui_live.fcErr }) : ''); return; }
  const rows = ui_forecastRows();
  const today = [], scen = [], bg = [];
  const scenDiffers = JSON.stringify(ui_measuresFor('scenario')) !== JSON.stringify(ui_measuresFor('today'));
  let noCams = 0;   // hours beyond the CAMS Europe forecast (the 00Z run + 96 h): the background falls back
  for (const r of rows) {
    const b = ui_bg(r.t, 'cams');
    if (b.source.no2 !== 'cams') noCams++;
    const a = ui_modelAt(r.t, r, 'today', p, b);
    today.push({ t: r.t, v: a ? a.total : NaN });
    bg.push({ t: r.t, v: a ? a.bg : NaN });
    if (scenDiffers) { const s = ui_modelAt(r.t, r, 'scenario', p, b); scen.push({ t: r.t, v: s ? s.total : NaN }); }
  }
  const series = [{ label: t('ui.fc.today'), points: today, cls: 's2' }];
  if (scenDiffers) series.push({ label: t('ui.fc.scenario'), points: scen, cls: 's3' });
  series.push({ label: t('ui.fc.bg'), points: bg, cls: 's0' });
  const lim = ui_limitLines(p, 'hourly');
  ui_try('charts.forecast', () => lineChart(el, {
    label: title, unit: ui_unit(p), series, thresholds: lim,
    marker: state.mode === 'forecast' ? state.time : NaN,
    onPick: (tt) => ui_setForecastHour(tt),
  }));
  const R = ui_live.ratios;
  const rtxt = R ? ['no2', 'o3', 'pm10', 'pm25'].map((q) => `${ui_polName(q)} ${fmt(R[q], 2)}`).join(', ') + ` (${t(R.source.no2 === 'live' ? 'ui.fc.ratio.live' : 'ui.fc.ratio.default')})` : '–';
  ui_setText('#fc-note', t('ui.fc.note', { ratios: rtxt }) + (noCams ? ` ${t('ui.fc.nocams', { n: fmt(noCams), src: t(`ui.bgsrc.${ui_bg(rows[rows.length - 1].t, 'cams').source.no2}`) })}` : ''));
}
function ui_setForecastHour(tt) {
  const r = ui_live.fc && ui_byT(ui_live.fc).get(tt);
  if (!r || !Number.isFinite(r.u10) || !Number.isFinite(r.wd)) return;
  Object.assign(state, { mode: 'forecast', preset: null, time: tt, u10: Math.round(r.u10 * 10) / 10, from: r.wd, stability: 'auto', lid: 'auto', met: { ...r, source: 'live' } });
  ui_changed({ request: true });
}

// ------------------------------------------------------------------ panel: data (baked statistics)
function ui_renderData() {
  const el = $('#data-chart');
  const p = state.pollutant, S = Hist.stats, u = ui_unit(p);
  if (!S) {
    el.textContent = '';
    const pp = document.createElement('p'); pp.className = 'chart-empty'; pp.textContent = t('ui.data.none'); el.appendChild(pp);
    ui_setText('#data-title', ''); ui_setText('#data-note', ''); ui_setText('#data-period', '');
    $('#exceed-table').textContent = '';
    return;
  }
  const per = S.period ? S.period.map((s) => s.slice(0, 4)).filter((v, i, a) => a.indexOf(v) === i).join('–') : '';
  const k = `z1.${p}`, view = state.dataView;
  const title = t(`ui.data.t.${view}`, { p: ui_polName(p), period: per, unit: u });
  ui_setText('#data-title', title);
  // MEAS statistics are in measurement units already (CO in mg/m³, iszz-api §3.3): no conversion.
  const same = (v) => (Number.isFinite(v) ? v : NaN);
  if (view === 'diurnal') {
    const d = S.diurnal && S.diurnal[k];
    const d4 = S.diurnal && S.diurnal[`z4.${p}`];
    const series = d ? [
      { label: t('ui.data.weekday'), values: (d.weekday || []).map(same), cls: 's1' },
      { label: t('ui.data.saturday'), values: (d.saturday || []).map(same), cls: 's2' },
      { label: t('ui.data.sunday'), values: (d.sunday || []).map(same), cls: 's3' },
    ] : [];
    if (d4 && d4.weekday) series.push({ label: t('ui.data.bgweekday'), values: d4.weekday.map(same), cls: 's0' });
    ui_try('charts.diurnal', () => diurnalChart(el, { label: title, unit: u, series }));
    ui_setText('#data-note', t('ui.data.note.diurnal'));
  } else if (view === 'monthly') {
    const m = S.monthly && S.monthly[k];
    const cur = ZgTime.hourStart(state.time).mo - 1;
    ui_try('charts.monthly', () => barChart(el, { label: title, unit: u, seriesLabel: t('ui.data.mean'), xTitle: '', highlight: cur,
      bars: (m || []).map((v, i) => ({ label: t(`ui.mon.${i + 1}`), value: same(v) })) }));
    ui_setText('#data-note', '');
  } else if (view === 'annual') {
    const a = (S.annual && S.annual[k]) || {};
    const thr = ui_limitLines(p, 'annual');
    ui_try('charts.annual', () => barChart(el, { label: title, unit: u, seriesLabel: t('ui.data.mean'), thresholds: thr,
      bars: Object.keys(a).sort().map((y) => ({ label: y, value: same(a[y]) })) }));
    ui_setText('#data-note', t('ui.data.note.annual'));
  } else {
    const r = S.rose && S.rose[k];
    ui_try('charts.mrose', () => roseChart(el, { label: title, unit: u, labels: ui_dirs16(), current: ui_dirIdx(state.from),
      values: r ? r.mean.map(same) : [], valueLabel: t('ui.data.mean'),
      extraColumns: r && r.n ? (head, rows) => { head.push(t('ui.rose.n')); rows.forEach((row, i) => row.push(fmt(r.n[i]))); } : null }));
    ui_setText('#data-note', t('ui.data.note.rose'));
  }
  // exceedances
  const tb = $('#exceed-table');
  tb.textContent = '';
  const ex = S.exceed || {};
  const years = [...new Set(Object.values(ex).flatMap((o) => Object.keys(o || {})))].sort();
  if (years.length) {
    const hr = tb.createTHead().insertRow();
    const th0 = document.createElement('th'); th0.scope = 'col'; th0.className = 'first'; hr.appendChild(th0);
    const ytd = S.ytd && S.ytd.year ? String(S.ytd.year) : null;
    for (const y of years) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = y === ytd ? `${y}*` : y; hr.appendChild(th); }
    const body = tb.createTBody();
    for (const key of Object.keys(ex)) {
      const r = body.insertRow();
      const th = document.createElement('th'); th.scope = 'row'; th.textContent = I18N.has(`ui.exc.${key}`) ? t(`ui.exc.${key}`) : key; r.appendChild(th);
      for (const y of years) r.insertCell().textContent = Number.isFinite(ex[key][y]) ? fmt(ex[key][y]) : '–';
    }
  }
  const cov = S.coverage && S.coverage[k];
  const ytdNote = S.ytd && S.ytd.year && years.includes(String(S.ytd.year)) ? ` * ${t('ui.data.ytd', { y: S.ytd.year, d: S.ytd.through })}` : '';
  ui_setText('#data-period', S.period ? t('ui.data.period', { a: S.period[0], b: S.period[1], p: ui_polName(p), cov: fmt(cov, 1) }) + ytdNote : '');
}

// ------------------------------------------------------------------ panel: display legend, footer
/*
 * The slice legend, in the panel (full: title with height, ramp or bands, a note naming the background) and on
 * the 3D view (compact, in the card of the first visible view; style.css hides the second view's copy in split
 * view). What it says follows state.sliceWhat: the local increment (the default map) or the total.
 */
function ui_renderLegend() {
  const el = $('#legend');
  if (!el) return;
  const p = state.pollutant, what = state.sliceWhat;
  const r = ui_res.today, bgv = r && r.bg ? r.bg[p] : NaN;
  const bg = Number.isFinite(bgv) ? `${ui_fmtC(p, bgv)} ${ui_unit(p)}` : null;
  const vf = r && ui_views.length ? ui_viewField('today', r.met) : null;
  const extra = [];
  if (vf && vf.approximate) extra.push(t('ui.map.approx'));
  if (vf && vf.stale && !vf.approximate) extra.push(t('ui.map.stale'));
  let html = null, compact = '';
  if (ui_X.legendHTML) {
    html = ui_try('visuals.legendHTML', () => ui_X.legendHTML(p, { what, bg, h: state.sliceH }), null);
    compact = ui_try('visuals.legendHTML', () => ui_X.legendHTML(p, { what, compact: true }), '') || '';
  }
  if (typeof html === 'string') ui_setHTML(el, html + (extra.length ? `<p class="legend-note">${extra.join(' ')}</p>` : ''));
  else ui_setText(el, t('ui.disp.legend.none'));
  for (const v of $$('.view-legend')) { v.hidden = !state.slice || !compact; if (compact) ui_setHTML(v, compact); }
}
function ui_renderParticleLegend() {
  const el = $('#particle-legend');
  if (!el) return;
  const html = ui_X.particleLegendHTML ? ui_try('visuals.particleLegendHTML', () => ui_X.particleLegendHTML(), '') : '';
  el.hidden = !(typeof html === 'string' && html && state.particles);
  if (!el.hidden) ui_setHTML(el, html);
}
function ui_renderFooter() {
  const dx = ui_X.TUNNEL ? ui_X.TUNNEL.dx : SITE.extent.tunnel.dx_fine, spin = ui_X.SPINUP ? ui_X.SPINUP.dx : SITE.extent.tunnel.dx_coarse;
  ui_setText('#method-note', t('ui.foot.method', { dx, spin }));
  const list = $('#attrib');
  list.textContent = '';
  const items = [...Object.values(SITE.attribution || {}), SITE.zg3d && SITE.zg3d.attribution, SITE.dtm && SITE.dtm.attribution,
    ...((ENV && ENV.meta && ENV.meta.attribution) || []), ...((Hist.meta && Hist.meta.attribution) || [])].filter(Boolean);
  for (const a of [...new Set(items)]) { const li = document.createElement('li'); li.textContent = a; list.appendChild(li); }
}

// ------------------------------------------------------------------ the dial
function ui_buildDial() {
  const g = $('.dial-ticks');
  if (!g) return;
  g.textContent = '';
  const ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 16; i++) {
    const a = i * UI_DIR_STEP * DEG, r0 = i % 2 ? 43 : 40;
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', String(Math.sin(a) * r0)); l.setAttribute('y1', String(-Math.cos(a) * r0));
    l.setAttribute('x2', String(Math.sin(a) * 46)); l.setAttribute('y2', String(-Math.cos(a) * 46));
    if (i % 4 === 0) l.setAttribute('class', 'main');
    g.appendChild(l);
  }
  for (let i = 0; i < 8; i++) {
    const a = i * 45 * DEG;
    const tx = document.createElementNS(ns, 'text');
    tx.setAttribute('x', String(Math.sin(a) * 55)); tx.setAttribute('y', String(-Math.cos(a) * 55));
    if (i % 2 === 0) tx.setAttribute('class', 'main');
    tx.textContent = ui_dir(i * 45).short;
    g.appendChild(tx);
  }
}
function ui_bindDial() {
  const dial = $('#dial');
  const setFrom = (e) => {
    const r = dial.getBoundingClientRect();
    state.from = ui_snap16(ui_dialAngle(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)));
    ui_manual({ request: true });
  };
  dial.addEventListener('pointerdown', (e) => { dial.setPointerCapture(e.pointerId); setFrom(e); });
  dial.addEventListener('pointermove', (e) => { if (dial.hasPointerCapture(e.pointerId)) setFrom(e); });
  dial.addEventListener('keydown', (e) => {
    const v = ui_dialKey(state.from, e.key);
    if (v === null) return;
    e.preventDefault();
    state.from = v;
    ui_manual({ request: true });
  });
}

// ------------------------------------------------------------------ presets
/*
 * Presets of critic §4.8, with the defaults of critic §4.5. Dated presets pick the most recent matching day inside
 * the baked archive (so the hour has real IFS meteorology and ZAGREB-4 background), else the most recent one
 * before today. Hours are local hour STARTS as in critic §4.8 ("07 h"), so 07 h → the hour ending 08:00.
 */
function ui_presetTime(month, dow, hourStart) {
  const end = Hist.ok ? Hist.tEnd : Date.now();
  let p = ZgTime.parts(end - 2 * UI_H);
  for (let k = 0; k < 800; k++) {
    const t0 = ZgTime.toUTC(p.y, p.mo, p.d, 12) - k * 24 * UI_H;
    const q = ZgTime.parts(t0);
    if (q.mo === month && q.dow === dow) {
      const tt = ZgTime.toUTC(q.y, q.mo, q.d, hourStart + 1);
      if (tt <= end) return tt;
    }
  }
  return ZgTime.currentHourEnding();
}
const UI_PRESETS = {
  winterRush: () => ({ u10: 1.2, from: 45, stability: 'F', lid: '100', heating: 'on', congestion: true, time: ui_presetTime(1, 2, 7) }),
  summerPm: () => ({ u10: 2.0, from: 225, stability: 'B', lid: 'auto', heating: 'off', congestion: true, time: ui_presetTime(7, 3, 15) }),
  // night-time downslope flow from Medvednica has a northerly component (site-context §7.1)
  sundayNight: () => ({ u10: 1.0, from: 0, stability: 'auto', lid: 'auto', heating: 'auto', congestion: false, time: ui_presetTime(11, 0, 23) }),
  ne: () => ({ u10: 1.7, from: 45, stability: 'D', lid: 'auto' }),
  sw: () => ({ u10: 2.0, from: 225, stability: 'D', lid: 'auto' }),
};
async function ui_applyPreset(id) {
  if (id === 'now' || id === 'fc24') {
    await ui_loadForecast();
    const target = ZgTime.currentHourEnding() + (id === 'fc24' ? 24 * UI_H : 0);
    const r = ui_live.fc && ui_live.fc.find((q) => q.t === target);
    if (!r || !Number.isFinite(r.u10)) {
      ui_notice('preset', 'warn', t('ui.err.fc'), t('ui.preset.fail', { err: ui_live.fcErr || '–' }));
      return;
    }
    ui_clearNotice('preset');
    Object.assign(state, { mode: id === 'now' ? 'now' : 'forecast', preset: id, time: target, u10: Math.round(r.u10 * 10) / 10, from: r.wd, stability: 'auto', lid: 'auto', met: { ...r, source: 'live' } });
    if (id === 'now') ui_loadLive();
  } else {
    Object.assign(state, UI_PRESETS[id](), { mode: 'explore', preset: id, met: null });
  }
  ui_changed({ request: true });
}

// ------------------------------------------------------------------ change handling
/*
 * ui_changed(): re-render the panel from the state and mark what to recompute. `request` = something that needs
 * a new field (direction, stability group, scenario geometry, leaves); it is debounced (UI_DEBOUNCE_MS).
 * ui_manual(): the same for a manual edit, which ends a preset and the now/forecast mode (the hour stays).
 */
function ui_changed({ request = false } = {}) {
  ui_wantDraw = true;
  if (ui_leafMode() !== ui_leafApplied) { ui_applyLeaves(); request = true; }
  ui_syncControls();
  ui_renderWeather();
  ui_renderSources();
  ui_invalidate('model', 'slices', 'points', 'charts', 'data');
  if (request) ui_scheduleRequest();
  else ui_maybeRequest();
  // the sun at the middle of the hour (state.time is the hour's end)
  if (ui_X.setDaylight) ui_try('scene.setDaylight', () => ui_X.setDaylight(new Date(state.time - UI_H / 2), ui_met().cc));
}
function ui_manual(opts) {
  state.preset = null;
  if (state.mode !== 'explore') { state.mode = 'explore'; }
  ui_changed(opts);
}
let ui_reqTimer = 0, ui_lastReq = null;
function ui_scheduleRequest() {
  clearTimeout(ui_reqTimer);
  ui_reqTimer = setTimeout(ui_requestFields, ui_lastReq === null ? 0 : UI_DEBOUNCE_MS);
}
/** Request only when the needed keys changed since the last request (e.g. auto stability moved with the hour). */
function ui_maybeRequest() {
  const met = ui_met();
  const want = ['today', 'scenario'].map((v) => ui_keyStr(ui_viewKey(v, met))).join(',');
  if (want !== ui_lastReq) ui_scheduleRequest();
}
function ui_requestFields() {
  const met = ui_met();
  const keys = [ui_viewKey('today', met)];
  if (ui_scenGeo()) keys.push(ui_viewKey('scenario', met));
  ui_lastReq = ['today', 'scenario'].map((v) => ui_keyStr(ui_viewKey(v, met))).join(',');
  if (!ui_aero) return;
  // a scenario that is no longer shown: drop its queued view jobs (sweep jobs stay)
  const wanted = new Set(keys.map((k) => k.scenario));
  for (const pk of [...ui_pending]) {
    const sc = pk.split('|')[0];
    if (wanted.has(sc) || ui_sweep.keys.some((q) => ui_keyStr(q) === pk)) continue;
    ui_try('aero.cancelView', () => ui_aero.cancelView && ui_aero.cancelView(sc));
    ui_pending.delete(pk);
  }
  for (const k of keys) {
    const ks = ui_keyStr(k);
    if ((ui_recv.has(ks) && ui_fields.has(ks)) || ui_pending.has(ks)) continue;
    ui_try('aero.cancelView', () => ui_aero.cancelView && ui_aero.cancelView(k.scenario));
    for (const p of [...ui_pending]) if (p.startsWith(`${k.scenario}|`) && !ui_sweep.keys.some((q) => ui_keyStr(q) === p)) ui_pending.delete(p);
    ui_pending.add(ks);
    ui_try('aero.request', () => ui_aero.request(k, 'view'));
  }
  ui_renderBusy();
}

// ------------------------------------------------------------------ Aero callbacks and busy UI
function ui_onResult(res) {
  if (!res || !res.key) return;
  const ks = ui_keyStr(res.key);
  let rec = res.receptor;
  if (!rec && res.conc && typeof res.conc.receptor === 'function') rec = ui_try('scalar.receptor', () => res.conc.receptor(RECEPTOR), null);
  if (rec) ui_recv.set(ks, rec);
  if (res.conc) {   // receptor-only sweep results (Aero sweep {receptorOnly}) carry no field
    ui_fields.delete(ks);
    ui_fields.set(ks, res);
    while (ui_fields.size > UI_FIELD_KEEP) ui_fields.delete(ui_fields.keys().next().value);
  }
  ui_pending.delete(ks);
  window.__z1.fields++;
  // The field's grid id (ScalarField.T.id, or res.grid for a receptor-only result) lets model.js keep a field on another
  // grid than the LUT from replacing the calibrated LUT (model.js "Grid consistency").
  if (ui_receptor && typeof ui_receptor.setField === 'function' && (res.conc || rec)) {
    ui_try('model.setField', () => ui_receptor.setField(res.key.scenario, res.key.dir, res.key.stab, res.conc || { ...rec, grid: res.grid || null }));
  }
  if (UI_SWEEP_LUT) ui_checkLutSweep();
  ui_invalidate('model', 'slices', 'points', 'charts');
  ui_renderSweepNote();
  ui_renderBusy();
}
const ui_prog = { job: null, prog: 0, queue: [] };
function ui_onProgress(job, prog, queue) {
  ui_prog.job = job || null; ui_prog.prog = prog || 0; ui_prog.queue = queue || [];
  ui_renderBusy();
}
const ui_jobKey = (j) => (j && (j.key || (j.scenario !== undefined ? j : null))) || null;
function ui_renderBusy() {
  const job = ui_prog.job, jk = ui_jobKey(job);
  const met = ui_met();
  for (const v of ['today', 'scenario']) {
    const box = $(`.view-busy[data-for="${v}"]`);
    if (!box) continue;
    const bar = $('.view-bar', box);
    const k = ui_viewKey(v, met), ks = ui_keyStr(k);
    let text = null, prog = null;
    if (ui_aero && jk && ui_keyStr(jk) === ks) {
      const stage = typeof ui_aero.label === 'function' ? ui_try('aero.label', () => ui_aero.label(job), '') : '';
      text = t('ui.busy.compute', { dir: ui_dir(k.dir * UI_DIR_STEP).text }) + (stage ? ` · ${stage}` : '');
      prog = ui_prog.prog;
    } else if (ui_aero && ui_pending.has(ks)) {
      text = t('ui.busy.queued');
    }
    box.hidden = !text;
    if (!text) continue;
    ui_setText($('.view-busy-text', box), text);
    ui_setText($('.view-busy-pct', box), prog === null ? '' : `${fmt(prog * 100)} %`);
    bar.classList.toggle('wait', prog === null);
    $('i', bar).style.width = prog === null ? '' : `${prog * 100}%`;
    if (prog === null) bar.removeAttribute('aria-valuenow'); else bar.setAttribute('aria-valuenow', String(Math.round(prog * 100)));
  }
  const el = $('#busy');
  if (!el) return;
  if (!jk) { el.hidden = true; return; }
  el.hidden = false;
  const sweeping = ui_sweep.active;
  const left = sweeping ? t('ui.busy.left', { n: [...ui_pending].length }) : '';
  el.textContent = t('ui.busy.run', { what: t(`ui.busy.view.${jk.scenario === 'today' ? 'today' : 'scenario'}`), dir: ui_dir((jk.dir || 0) * UI_DIR_STEP).text, pct: fmt(ui_prog.prog * 100), left });
}

// ------------------------------------------------------------------ ?sweep=lut (tools/export_lut.py)
const UI_SWEEP_LUT = PARAMS.get('sweep') === 'lut';
const UI_OFFLINE = PARAMS.get('live') === '0';
function ui_startLutSweep() {
  if (!ui_aero) { window.__lut = { error: 'no Aero (LBM unavailable or aero.js missing)' }; return; }
  if (typeof ui_aero.sweepLUT === 'function') { ui_try('aero.sweepLUT', () => ui_aero.sweepLUT()); return; }
  const keys = [];
  for (const stab of MD.stability_groups) for (let d = 0; d < 16; d++) keys.push({ scenario: 'today', dir: d, stab });
  ui_try('aero.sweep', () => ui_aero.sweep(keys));
}
function ui_checkLutSweep() {
  if (!ui_aero || typeof ui_aero.sweepLUT === 'function' || window.__lut) return;
  for (const stab of MD.stability_groups) for (let d = 0; d < 16; d++) if (!ui_recv.has(ui_keyStr({ scenario: 'today', dir: d, stab }))) return;
  window.__lut = ui_try('aero.exportLUT', () => ui_aero.exportLUT('today', MD.stability_groups), { error: 'exportLUT failed' });
}

// ------------------------------------------------------------------ live data
const UI_LIVE_RETRY_MS = 60000;   // one minute: well past ISZZ's ~1 s limiter window and a burst from another client
let ui_liveRetried = false;
async function ui_loadLive() {
  if (UI_OFFLINE) return;
  ui_live.status = 'loading';
  ui_renderNow();
  Live.eaqi().then((e) => { ui_live.eaqi = e; ui_renderNow(); }).catch(() => { /* the badge says "not available" */ });
  try {
    const r = await Live.recent(72, {
      onPartial: (st, k, rows) => {
        if (!ui_live.recent) ui_live.recent = { z1: {}, z4: {}, z4long: {}, errors: [], t: Date.now() };
        ui_live.recent[st][k] = rows;
        if (st === 'z4') ui_live.recent.z4long[k] = rows;
        ui_renderNow();
      },
    });
    ui_live.recent = r;
    ui_live.status = 'ok';
    // one automatic retry after UI_LIVE_RETRY_MS when some series failed (ISZZ refuses bursts per IP, iszz-api §7)
    if (r.errors.length && !ui_liveRetried) { ui_liveRetried = true; setTimeout(ui_loadLive, UI_LIVE_RETRY_MS); }
    const nOk = Object.values(r.z1).filter((x) => x && x.length).length;
    if (!nOk) throw new Error(r.errors.length ? r.errors[0].error : t('data.err.network'));
    ui_clearNotice('live');
  } catch (e) {
    ui_live.status = 'failed';
    ui_live.err = String(e.message || e);
    ui_notice('live', 'warn', () => t('ui.err.live'), () => t('ui.err.live.text', { err: ui_live.err }));
  }
  if (ui_live.cams) ui_live.ratios = Live.biasRatios(ui_live.cams, ui_live.recent && ui_live.recent.z4long);
  ui_renderNow();
  ui_invalidate('model', 'charts', 'points');
}
let ui_fcPromise = null;
function ui_loadForecast(force = false) {
  if (UI_OFFLINE) return Promise.resolve();
  if (ui_fcPromise && !force) return ui_fcPromise;
  ui_live.fcStatus = 'loading';
  ui_invalidate('charts');
  ui_fcPromise = (async () => {
    try {
      // past_days = 3 so the 72 h hindcast has IFS weather for every hour (the Live default is 2, architecture §6.4)
      const [fc, cams] = await Promise.all([Live.forecast({ pastDays: 3, forecastDays: 4 }), Live.cams({ forecastDays: 4 }).catch(() => null)]);
      ui_live.fc = fc;
      ui_live.cams = cams;
      ui_live.ratios = Live.biasRatios(cams, ui_live.recent && ui_live.recent.z4long);
      ui_live.fcStatus = 'ok'; ui_live.fcErr = null;
    } catch (e) {
      ui_live.fcStatus = 'failed'; ui_live.fcErr = String(e.message || e);
      ui_fcPromise = null;
    }
    ui_invalidate('model', 'charts', 'points');
  })();
  return ui_fcPromise;
}

// ------------------------------------------------------------------ control binding
let ui_placing = false;
function ui_bindControls() {
  for (const b of $$('[data-lang]')) b.addEventListener('click', () => I18N.set(b.dataset.lang));
  $('#u10').addEventListener('input', (e) => { state.u10 = +e.target.value; ui_manual(); });
  ui_bindDial();
  $('#stab').addEventListener('change', (e) => { state.stability = e.target.value; ui_manual({ request: true }); });
  $('#date').addEventListener('change', (e) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.target.value);
    if (!m) return;
    state.time = ZgTime.toUTC(+m[1], +m[2], +m[3], +$('#hour').value - 1) + UI_H;   // slider = local hour start + 1
    state.met = null;
    ui_manual();
  });
  $('#hour').addEventListener('input', (e) => {
    const hs = ZgTime.hourStart(state.time);
    state.time = ZgTime.toUTC(hs.y, hs.mo, hs.d, +e.target.value - 1) + UI_H;   // slider = local hour start + 1 (DST-safe)
    state.met = null;
    ui_manual();
  });
  $('#hour-prev').addEventListener('click', () => { state.time -= UI_H; state.met = null; ui_manual(); });
  $('#hour-next').addEventListener('click', () => { state.time += UI_H; state.met = null; ui_manual(); });
  for (const k of ['traffic', 'trafficA', 'trafficB']) $(`#${k}`).addEventListener('input', (e) => { state[k] = +e.target.value; ui_manual(); });
  $('#congestion').addEventListener('change', (e) => { state.congestion = e.target.checked; ui_manual(); });
  $('#resusp').addEventListener('change', (e) => { state.resuspension = e.target.checked; ui_manual(); });
  $('#heating').addEventListener('change', (e) => { state.heating = e.target.value; ui_manual(); });
  $('#leaves').addEventListener('change', (e) => { state.leaves = e.target.value; ui_manual({ request: true }); });
  $('#bgsrc').addEventListener('change', (e) => { state.bgSource = e.target.value; ui_manual(); });
  $('#scenario').addEventListener('change', (e) => { state.scenario = e.target.value; ui_applyScenario(); ui_changed({ request: true }); });
  $('#lez').addEventListener('change', (e) => { state.measures.lez = e.target.checked; ui_changed(); });
  $('#ev').addEventListener('input', (e) => { state.measures.evShare = +e.target.value; ui_changed(); });
  $('#ebus').addEventListener('change', (e) => { state.measures.eBus = e.target.checked; ui_changed(); });
  $('#carfree').addEventListener('change', (e) => { state.measures.carFreeMiramarska = e.target.checked; ui_changed(); });
  $('#dtraffic').addEventListener('input', (e) => { state.measures.trafficChange = +e.target.value; ui_changed(); });
  for (const [id, k] of [['cw', 'w'], ['cd', 'd'], ['ch', 'h'], ['cr', 'rot']]) {
    $(`#${id}`).addEventListener('input', (e) => { state.custom[k] = +e.target.value; ui_customChanged(); });
  }
  $('#place').addEventListener('click', () => ui_setPlacing(!ui_placing));
  $('#band-level').addEventListener('change', (e) => { state.bandLevel = +e.target.value; ui_changed(); });
  for (const g of $$('[data-group]')) {
    for (const b of $$('button[data-value]', g)) b.addEventListener('click', () => {
      const v = b.dataset.value, grp = g.dataset.group;
      if (grp === 'lid') { state.lid = v; ui_manual({ request: true }); return; }
      if (grp === 'pollutant') state.pollutant = v;
      else if (grp === 'index') state.index = v;
      else if (grp === 'calib') { state.calibrated = v === 'cal'; ui_renderCal(); }
      else if (grp === 'bcol') { state.bcol = v; if (ui_X.colorBuildings) ui_try('city.colorBuildings', () => ui_X.colorBuildings(v)); }
      else if (grp === 'split') { state.split = v; }
      else if (grp === 'palette') {
        state.palette = v;
        if (ui_X.setConcPalette) ui_try('visuals.setConcPalette', () => ui_X.setConcPalette(v));
        ui_renderLegend(); ui_invalidate('slices');
      }
      else if (grp === 'sliceWhat') { state.sliceWhat = v; ui_renderLegend(); ui_invalidate('slices'); }
      else if (grp === 'dataView') state.dataView = v;
      ui_changed();
      if (grp === 'pollutant') { ui_renderLegend(); ui_rose.key = null; if (ui_rose.model) ui_computeRose(); }
    });
  }
  for (const b of $$('[data-preset]')) b.addEventListener('click', () => ui_applyPreset(b.dataset.preset));
  $('#use-now').addEventListener('click', () => ui_applyPreset('now'));
  $('#fc-load').addEventListener('click', () => { ui_loadLive(); ui_loadForecast(true); });
  $('#sweep').addEventListener('click', ui_startSweep);
  $('#export-lut').addEventListener('click', ui_exportLUT);
  $('#slice').addEventListener('change', (e) => { state.slice = e.target.checked; ui_invalidate('slices'); ui_renderLegend(); });
  $('#slice-h').addEventListener('input', (e) => { state.sliceH = +e.target.value; ui_renderSources(); ui_invalidate('slices'); });
  $('#particles').addEventListener('change', (e) => { state.particles = e.target.checked; ui_renderParticleLegend(); ui_wantDraw = true; });
  $('#streaks').addEventListener('change', (e) => { state.streaks = e.target.checked; });
  $('#xray').addEventListener('change', (e) => { state.xray = e.target.checked; ui_applyXray(); });
  $('#lod2').addEventListener('change', (e) => { state.lod2 = e.target.checked; ui_applyLod2(); });
  for (const b of $$('[data-cam]')) b.addEventListener('click', () => ui_goTo(b.dataset.cam));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui_placing) ui_setPlacing(false); });
  I18N.onChange(() => { ui_applyI18n(); ui_buildDial(); ui_fillScenarioSelect(); ui_fillBandSelect(); ui_changed(); ui_renderNow(); ui_renderCal(); ui_renderFooter(); ui_renderLegend(); ui_renderParticleLegend(); ui_renderNotices(); ui_renderRose(); ui_renderModelLine(); });
  ui_bindGroups();
}
/*
 * Collapsible groups (<details class="group">): which ones are open is remembered per viewer (localStorage, a
 * convenience only: blocked storage just means all start closed). Their charts are drawn only while open, and
 * again when opened. "How good is it?" in the model line opens the model group at its accuracy section.
 */
const UI_GROUPS_KEY = 'z1.groups';
function ui_groupOpen(id) { const d = document.getElementById(id); return !d || d.tagName !== 'DETAILS' || d.open; }
function ui_bindGroups() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(UI_GROUPS_KEY) || '{}') || {}; } catch (e) { saved = {}; }
  for (const d of $$('details.group')) {
    if (saved[d.id]) d.open = true;
    d.addEventListener('toggle', () => {
      try {
        const o = JSON.parse(localStorage.getItem(UI_GROUPS_KEY) || '{}') || {};
        o[d.id] = d.open;
        localStorage.setItem(UI_GROUPS_KEY, JSON.stringify(o));
      } catch (e) { /* storage blocked: nothing to remember */ }
      if (d.open) { ui_invalidate('charts', 'data'); if (d.id === 'grp-val') { ui_renderRose(); ui_renderSweepNote(); } }
    });
  }
  const more = $('#model-more');
  if (more) more.addEventListener('click', () => {
    const g = $('#grp-val');
    if (g) g.open = true;
    const h = $('#h-cal');
    if (h) h.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
  });
}
/*
 * The model status in one line under the title (architecture §7 "raw physics vs calibrated is visible"): what
 * model runs, whether it is calibrated, and where the station numbers of the current hour come from (the receptor
 * LUT and its grid, a field computed in this browser, or the approximate model). Details: "How good is it?".
 */
function ui_calPeriod() {
  const per = Array.isArray(CAL && CAL.period) ? CAL.period : [];
  const ys = [...new Set(per.map((q) => String(q).slice(0, 4)))].filter(Boolean);
  return ys.map((y) => (I18N.lang === 'hr' ? `${y}.` : y)).join('–') || '–';
}
function ui_renderModelLine() {
  const cal = CAL || {}, status = cal.status || 'uncalibrated';
  const src = ui_res.today && ui_res.today.ga ? ui_res.today.ga.source : null;
  let text;
  if (!ui_aero) {
    const gb = cal.gauss && Number.isFinite(cal.gauss.beta) ? cal.gauss.beta : NaN;
    const c = !state.calibrated ? t('ui.model.raw') : Number.isFinite(gb) ? t('ui.model.gcal', { beta: fmt(gb, 2) }) : t('ui.model.uncal');
    text = t('ui.model.approx', { cal: c });
  } else {
    const c = !state.calibrated ? t('ui.model.raw')
      : status === 'calibrated' && Number.isFinite(cal.beta) ? t('ui.model.cal', { period: ui_calPeriod(), beta: fmt(cal.beta, 2) }) : t('ui.model.uncal');
    const grid = src === 'lut' ? ui_gridLabel(LUT && LUT.meta && LUT.meta.grid) : ui_gridLabel(ui_X.TUNNEL && ui_X.TUNNEL.id);
    const where = src === 'lut' ? t('ui.model.src.lut', { grid }) : src === 'field' ? t('ui.model.src.field', { grid }) : src ? t('ui.model.src.fallback') : '';
    text = t('ui.model.lbm', { cal: c, src: where });
  }
  ui_setText('#model-text', text.trim());
  const line = $('#model-line');
  if (line) line.classList.toggle('warn', !ui_aero);
}
function ui_fillScenarioSelect() {
  const sel = $('#scenario');
  sel.textContent = '';
  for (const s of ui_scenarios()) {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = ui_scenLabel(s);
    sel.appendChild(o);
  }
  sel.value = state.scenario;
  if (!ui_X.SCENARIOS) { sel.disabled = true; ui_setText('#scenario-desc', t('ui.scen.unavailable')); }
}
function ui_fillBandSelect() {
  for (const o of $$('#band-level option')) o.textContent = t('ui.eaqi.ge', { name: t(`ui.eaqi.${o.value}`) });
}

// ------------------------------------------------------------------ scene-side toggles (guarded)
let ui_leafApplied = null;
function ui_applyLeaves() {
  const mode = ui_leafMode();
  const first = ui_leafApplied === null;
  ui_leafApplied = mode;
  if (ui_X.setLeaves) ui_try('city.setLeaves', () => ui_X.setLeaves(mode));
  if (first) return;
  // The flow depends on the crowns. Aero keys its caches by a geometry hash and recomputes by itself; the page's
  // own receptor/field caches and the model's live fields are keyed only by (scenario, dir, group): drop them.
  ui_recv.clear(); ui_fields.clear(); ui_pending.clear();
  if (ui_receptor && typeof ui_receptor.clearFields === 'function') ui_try('model.clearFields', () => ui_receptor.clearFields());
  ui_lastReq = null;
}
function ui_applyXray() {
  if (ui_X.setXray) { ui_try('city.setXray', () => ui_X.setXray(state.xray)); return; }
  if (!ui_city || !ui_city.buildings) return;
  ui_try('city.xray', () => ui_city.buildings.traverse((o) => {
    if (!o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      m.transparent = state.xray; m.opacity = state.xray ? 0.18 : 1; m.depthWrite = !state.xray; m.needsUpdate = true;
    }
  }));
}
function ui_applyLod2() {
  if (ui_X.setLod2) {
    const r = ui_try('city.setLod2', () => ui_X.setLod2(state.lod2), null);
    // setLod2 is async (the mesh is decoded on first use) and answers false when there is no LoD2 in the build
    if (r && typeof r.then === 'function') r.then((on) => { if (state.lod2 && on === false) { state.lod2 = false; ui_syncControls(); } }).catch((e) => ui_fail('city.setLod2', e));
    return;
  }
  if (!ui_city) return;
  ui_try('city.lod2', () => {
    let l = ui_city.lod2;
    if (typeof l === 'function') { l = l(); ui_city.lod2obj = l; }
    else if (ui_city.lod2obj) l = ui_city.lod2obj;
    if (l && l.isObject3D) { if (!l.parent && ui_city.root) ui_city.root.add(l); l.visible = state.lod2; }
  });
}
let ui_scenLayers = new Map();
function ui_applyScenario() {
  if (!ui_X.scenarioLayer) return;
  for (const [id, g] of ui_scenLayers) {
    g.visible = false;
    for (const it of g.userData.uiLabels || []) if (it && it.e) it.e.hidden = id !== state.scenario;
  }
  if (state.scenario === 'today') return;
  let g = ui_scenLayers.get(state.scenario);
  if (!g) {
    g = ui_try('city.scenarioLayer', () => ui_X.scenarioLayer(state.scenario), null);
    if (g && g.isObject3D) {
      if (!g.parent && ui_X.scene) ui_X.scene.add(g);
      ui_scenLayers.set(state.scenario, g);
      // the layer's labels (e.g. "new tower") go to the scenario view's label layer only, shown with the layer
      const v = ui_views.find((q) => q.id === 'scenario');
      g.userData.uiLabels = [];
      if (v && v.labels) for (const l of (g.userData.labels || [])) g.userData.uiLabels.push(ui_try('visuals.LabelLayer.add', () => v.labels.add(l.text, l.pos, l.kind, l.key || null), null));
    }
  }
  if (state.scenario === 'custom') ui_customChanged(true);
}
let ui_customTimer = 0;
function ui_customChanged(noInvalidate = false) {
  ui_renderSources();
  if (ui_X.setCustomBlock) ui_try('city.setCustomBlock', () => ui_X.setCustomBlock({ ...state.custom }));
  if (noInvalidate) return;
  // new geometry for 'custom': forget its fields (debounced like a direction change)
  clearTimeout(ui_customTimer);
  ui_customTimer = setTimeout(() => {
    for (const k of [...ui_recv.keys()]) if (k.startsWith('custom|')) ui_recv.delete(k);
    for (const k of [...ui_fields.keys()]) if (k.startsWith('custom|')) ui_fields.delete(k);
    for (const k of [...ui_pending]) if (k.startsWith('custom|')) ui_pending.delete(k);
    if (ui_receptor && typeof ui_receptor.clearFields === 'function') ui_try('model.clearFields', () => ui_receptor.clearFields('custom'));
    ui_lastReq = null;
    ui_changed({ request: true });
  }, UI_DEBOUNCE_MS);
}
function ui_setPlacing(on) {
  ui_placing = on;
  $('#place').setAttribute('aria-pressed', String(on));
  $('#stage').classList.toggle('placing', on);
  ui_renderSources();
}
function ui_exportLUT() {
  if (!ui_aero || typeof ui_aero.exportLUT !== 'function') return;
  const lut = ui_try('aero.exportLUT', () => ui_aero.exportLUT('today', MD.stability_groups), null);
  if (!lut) return;
  const blob = new Blob([JSON.stringify(lut)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lut_receptor.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  ui_setText('#lut-status', `${$('#lut-status').textContent} ${t('ui.lut.exported')}`);
}

// ------------------------------------------------------------------ 3D: master camera, views, cameras
/*
 * One master camera and OrbitControls on the canvas; each view copies the master's pose into its own camera
 * with its own aspect and renders into its scissor rectangle (reference main.js). Both views look at the same
 * place, the station; they differ only in what they show (view roots, the scenario layer).
 */
let ui_master = null, ui_controls = null, ui_tween = null;
const ui_views = [];
function ui_camPoses() {
  const narrow = window.innerWidth < 880;
  const off = (bearing, elev, dist) => { const b = bearing * DEG, e = elev * DEG; return new THREE.Vector3(Math.sin(b) * Math.cos(e) * dist, Math.sin(e) * dist, -Math.cos(b) * Math.cos(e) * dist); };
  // Vukovarska centreline z near the station, from env.json (the road named "…Vukovara" closest to the origin)
  let zv = 30;
  let bd = Infinity;
  for (const r of (ENV && ENV.roads) || []) if (/Vukovar/.test(r.n || '')) for (const [x, z] of r.p) { const d = Math.hypot(x, z); if (d < bd && Math.abs(x) < 120) { bd = d; zv = z; } }
  return {
    // from the SSW, so Vukovarska (86°/266°) runs across the view and Miramarska into it (site-context §0)
    // narrow screens stack the views, so each is wide and short and shows more of the city: come closer
    air: { pos: off(200, 36, narrow ? 430 : 540), target: new THREE.Vector3(0, 0, 0) },
    // eye 1.7 m above ground at the inlet, looking east (critic §4.8)
    station: { pos: new THREE.Vector3(0, 1.7, 0), target: new THREE.Vector3(60, 3, 0) },
    // from the west end, looking east along Vukovarska toward the station
    vukovarska: { pos: new THREE.Vector3(-380, 26, zv), target: new THREE.Vector3(40, 4, zv) },
    // straight down, north up (the 0.5 m offset fixes the azimuth, reference PRESETS.tlocrt)
    plan: { pos: new THREE.Vector3(0, narrow ? 1100 : 900, 0.5), target: new THREE.Vector3(0, 0, 0) },
  };
}
function ui_goTo(name, instant = false) {
  if (!ui_master) { state.cam = name; ui_syncControls(); return; }
  const pose = ui_camPoses()[name];
  if (!pose) return;
  state.cam = name;
  ui_syncControls();
  if (instant || REDUCED_MOTION) {
    ui_master.position.copy(pose.pos); ui_controls.target.copy(pose.target); ui_controls.update(); ui_tween = null; return;
  }
  ui_tween = { p0: ui_master.position.clone(), p1: pose.pos, t0: ui_controls.target.clone(), t1: pose.target, k: 0 };
}
function ui_init3D() {
  const R = ui_X.renderer, S = ui_X.scene;
  if (!R || !S) { ui_missing('scene.js', 'ui.err.what.scene'); return false; }
  const canvasEl = R.domElement || $('#gl');
  ui_master = new THREE.PerspectiveCamera(36, 1, 2, 12000);   // reference camera
  ui_controls = new OrbitControls(ui_master, canvasEl);
  ui_controls.enableDamping = true;
  ui_controls.dampingFactor = 0.08;
  ui_controls.minDistance = 25;
  ui_controls.maxDistance = 2200;
  ui_controls.maxPolarAngle = 88 * DEG;
  ui_controls.addEventListener('start', () => { ui_tween = null; });
  ui_controls.addEventListener('change', () => { ui_wantDraw = true; });
  for (const [id, sel] of [['today', '#view-a'], ['scenario', '#view-b']]) {
    const root = new THREE.Group();
    root.name = `view-${id}`;
    S.add(root);
    const v = { id, el: $(sel), root, cam: new THREE.PerspectiveCamera(36, 1, 2, 12000), slice: null, particles: null, streaks: null, labels: null };
    if (ui_X.ConcSlice) v.slice = ui_try('visuals.ConcSlice', () => new ui_X.ConcSlice(root), null);
    if (ui_X.Particles) v.particles = ui_try('visuals.Particles', () => new ui_X.Particles(root, ENV), null);
    if (ui_X.WindStreaks) v.streaks = ui_try('visuals.WindStreaks', () => new ui_X.WindStreaks(root), null);
    if (ui_X.LabelLayer) {
      v.labels = ui_try('visuals.LabelLayer', () => new ui_X.LabelLayer($('.labels', v.el)), null);
      if (v.labels) {
        ui_try('visuals.LabelLayer.add', () => {
          for (const l of (ui_city && ui_city.labels) || []) v.labels.add(l.text, l.pos, l.kind, l.key || null);
        });
      }
    }
    ui_views.push(v);
  }
  if (!ui_X.ConcSlice || !ui_X.LabelLayer) ui_missing('visuals.js', 'ui.err.what.visuals');
  // click-to-place for the custom block: a click (< 5 px of movement) on the scenario view while placing
  let down = null;
  canvasEl.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  canvasEl.addEventListener('pointerup', (e) => {
    if (!ui_placing || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const v = ui_views.find((q) => q.id === 'scenario');
    const r = v.el.getBoundingClientRect();
    if (v.el.hidden || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, v.cam);
    const hit = new THREE.Vector3();
    if (ray.ray.intersectPlane(new THREE.Plane(UP, 0), hit)) {
      state.custom.x = Math.round(hit.x); state.custom.z = Math.round(hit.z);
      ui_setPlacing(false);
      ui_customChanged();
    }
  });
  const resize = () => { const r = canvasEl.getBoundingClientRect(); R.setSize(r.width, r.height, false); ui_wantDraw = true; };
  new ResizeObserver(resize).observe(canvasEl);
  resize();
  ui_goTo(state.cam, true);
  return true;
}

// ------------------------------------------------------------------ per-frame work
let ui_lastSlice = 0;
/*
 * The slice of each view. Default: the local increment on the continuous linear scale of visuals.js INC_SCALES (the
 * background is one number for the whole domain, so only the increment shows the street-scale structure); with
 * "total", background + increment in the bands of CONC_SCALES. A stale field (the previous run, shown while the new
 * one computes) is drawn paler, like the grey numbers.
 */
function ui_updateSlices() {
  const met = ui_res.today ? ui_res.today.met : ui_met();
  const inc = state.sliceWhat === 'inc' && !!ui_X.INC_SCALES;
  for (const v of ui_views) {
    if (!v.slice) continue;
    const r = ui_res[v.id];
    const vf = state.slice ? ui_viewField(v.id, met) : null;
    let field = vf ? vf.field : null;
    if (vf && vf.approximate && Math.abs(state.sliceH - UI_POI_Y) > 1e-6) field = ui_fallbackField(met, state.sliceH);
    const fn = r && field ? ui_valueFn(v.id, r.met, r.bg, state.pollutant, vf.approximate ? 'fallback' : 'field', inc) : null;
    const scale = inc ? ui_X.INC_SCALES[state.pollutant] : ui_X.CONC_SCALES ? ui_X.CONC_SCALES[state.pollutant] : null;
    ui_try('visuals.ConcSlice.update', () => v.slice.update(field && fn ? field : null, fn || (() => 0), state.sliceH, state.slice && !!field && !!fn, scale));
    if (typeof v.slice.setDim === 'function') ui_try('visuals.ConcSlice.setDim', () => v.slice.setDim(!!(vf && vf.stale && !vf.approximate)));
  }
  ui_renderLegend();
}
function ui_frameUI(now) {
  if (ui_dirty.model) { ui_dirty.model = false; ui_recomputeModel(); ui_renderCompare(); ui_renderViewCards(); ui_renderSources(); ui_renderModelLine(); ui_renderLegend(); }
  if (ui_dirty.points && now - ui_lastPoints > 150) { ui_dirty.points = false; ui_lastPoints = now; ui_recomputePoints(); ui_renderCompare(); }
  if (ui_dirty.slices && now - ui_lastSlice > 100) { ui_dirty.slices = false; ui_lastSlice = now; ui_updateSlices(); }
  if (ui_dirty.charts && !ui_chartTimer) {
    ui_chartTimer = setTimeout(() => {
      ui_chartTimer = 0; ui_dirty.charts = false;
      // charts in a closed group wait until it opens (the toggle handler invalidates them again)
      if (ui_groupOpen('grp-val')) ui_try('ui.hindcast', ui_renderHindcast);
      if (ui_groupOpen('grp-fc')) ui_try('ui.forecast', ui_renderForecast);
      if (ui_rose.model && ui_roseKey() !== ui_rose.key) ui_computeRose();
    }, 200);
  }
  if (ui_dirty.data) { ui_dirty.data = false; if (ui_groupOpen('grp-data')) ui_try('ui.data', ui_renderData); }
}
let ui_chartTimer = 0;
const ui_fwd = new THREE.Vector3();
/*
 * Draw throttling on software WebGL. With SwiftShader one draw of the two views costs ~300 ms, and the wind tunnel
 * shares the same GL context: measured headless on the coarse grid, 3.2 frames/s with drawing against 57 without,
 * and the LBM advanced ~80× faster without drawing. So while Aero is busy on a software renderer (LBM.software) the
 * 3D is redrawn at most every UI_SOFT_DRAW_MS, and at once whenever the camera moves or a control changes
 * (ui_wantDraw). Hardware GPUs draw every frame, as in the reference.
 */
const UI_SOFT_DRAW_MS = 1500;
// ?sweep=lut (tools/export_lut.py) runs headless and nobody looks at it: one frame every 10 s is enough for a
// progress screenshot, and it leaves the GPU to the sweep (the flow owner measured the in-app export ~1.6× slower
// with the normal drawing; docs/03-flow-lbm.md §8).
const UI_LUT_DRAW_MS = 10000;
let ui_lastDraw = 0, ui_wantDraw = true, ui_lastFrame = 0;
function ui_frame(now) {
  ui_try('ui.frameUI', () => ui_frameUI(now));
  if (ui_aero && typeof ui_aero.tick === 'function') ui_try('aero.tick', () => ui_aero.tick());
  const soft = !!(ui_X.LBM && ui_X.LBM.software && ui_aero && ui_aero.busy);
  const draw = UI_SWEEP_LUT ? now - ui_lastDraw > UI_LUT_DRAW_MS
    : !soft || ui_wantDraw || !!ui_tween || now - ui_lastDraw > UI_SOFT_DRAW_MS;
  if (ui_master && draw && !(window.__z1dbg && window.__z1dbg.noRender)) {
    // dt since the previous draw (particles and camera tweens move by it), capped at 0.1 s so a long pause does not jump
    const dt = clamp((now - (ui_lastDraw || now)) / 1000, 0, 0.1);
    ui_wantDraw = false; ui_lastDraw = now;
    ui_try('ui.render', () => ui_render(dt));
  }
  ui_lastFrame = now;
  requestAnimationFrame(ui_frame);
}
function ui_render(dt) {
  const R = ui_X.renderer, S = ui_X.scene;
  if (ui_X.timeUniform && !REDUCED_MOTION) ui_X.timeUniform.value += dt;
  if (ui_tween) {
    ui_tween.k = Math.min(1, ui_tween.k + dt / 1.3);
    const k = ui_tween.k, e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;   // cubic in-out (reference)
    ui_master.position.copy(ui_tween.p0).lerp(ui_tween.p1, e);
    ui_controls.target.copy(ui_tween.t0).lerp(ui_tween.t1, e);
    if (k >= 1) ui_tween = null;
  }
  ui_controls.update();
  const met = ui_res.today ? ui_res.today.met : null;
  for (const v of ui_views) {
    const vf = met ? ui_viewField(v.id, met) : null;
    const wind = vf ? vf.wind : null;
    if (v.particles) ui_try('visuals.Particles.update', () => v.particles.update(dt, wind, state.u10, state.particles && !REDUCED_MOTION));
    if (v.streaks) ui_try('visuals.WindStreaks.update', () => v.streaks.update(dt, wind, state.u10, state.streaks && !!wind && !REDUCED_MOTION));
  }
  const canvasEl = R.domElement;
  const cr = canvasEl.getBoundingClientRect();
  R.setScissorTest(true);
  const scenLayer = ui_scenLayers.get(state.scenario);
  for (const v of ui_views) {
    if (v.el.hidden) continue;
    const r = v.el.getBoundingClientRect();
    const x = r.left - cr.left, y = cr.bottom - r.bottom, w = r.width, h = r.height;
    if (w < 2 || h < 2) continue;
    v.cam.position.copy(ui_master.position);
    v.cam.quaternion.copy(ui_master.quaternion);
    v.cam.aspect = w / h;
    v.cam.updateProjectionMatrix();
    v.cam.updateMatrixWorld();
    ui_master.aspect = v.cam.aspect;
    for (const q of ui_views) q.root.visible = q === v;
    const scenId = v.id === 'scenario' && state.scenario !== 'today' ? state.scenario : null;
    if (ui_X.cityView) ui_try('city.cityView', () => ui_X.cityView(scenId));
    else if (scenLayer) {
      scenLayer.visible = !!scenId;
      const hides = scenLayer.userData && (scenLayer.userData.hide || scenLayer.userData.hides);
      if (Array.isArray(hides)) for (const o of hides) o.visible = !scenId;
    }
    R.setViewport(x, y, w, h);
    R.setScissor(x, y, w, h);
    R.render(S, v.cam);
    if (v.labels) ui_try('visuals.LabelLayer.update', () => v.labels.update(v.cam, w, h, ui_blockers(v.el, r)));
  }
  R.setScissorTest(false);
  ui_master.getWorldDirection(ui_fwd);
  const north = $('#north svg');
  if (north) north.style.transform = `rotate(${-Math.atan2(ui_fwd.x, -ui_fwd.z) / DEG}deg)`;
}

/** Rectangles [x0, y0, x1, y1] in view pixels of the cards over a view (and the north arrow), for LabelLayer. */
function ui_blockers(el, r) {
  const out = [];
  for (const c of [...el.querySelectorAll('.view-head, .view-stats'), $('#north')]) {
    if (!c) continue;
    const b = c.getBoundingClientRect();
    if (b.width > 0 && b.height > 0 && b.right > r.left && b.left < r.right) out.push([b.left - r.left, b.top - r.top, b.right - r.left, b.bottom - r.top]);
  }
  return out;
}

// ------------------------------------------------------------------ boot
function ui_boot() {
  ui_applyI18n();
  ui_buildDial();
  ui_fillBandSelect();
  // modules
  if (!ui_X.concentrations || !ui_X.ReceptorModel) ui_missing('model.js', 'ui.err.what.model');
  if (!ui_X.groupStrengths) ui_missing('emissions.js', 'ui.err.what.emissions');
  if (!ui_X.eaqi) ui_missing('chemistry.js', 'ui.err.what.chem');
  if (ui_X.FallbackModel) ui_fallback = ui_try('fallback.FallbackModel', () => new ui_X.FallbackModel(ENV), null);
  else ui_missing('fallback.js', 'ui.err.what.fallback');
  if (ui_X.ReceptorModel) ui_receptor = ui_try('model.ReceptorModel', () => new ui_X.ReceptorModel({ lut: LUT, fallback: ui_fallback, cal: CAL }), null);
  if (ui_X.buildCity) {
    ui_city = ui_try('city.buildCity', () => ui_X.buildCity(), null);
    if (ui_city && ui_city.root && ui_X.scene && !ui_city.root.parent) ui_X.scene.add(ui_city.root);
  } else ui_missing('city.js', 'ui.err.what.city');
  ui_fillScenarioSelect();
  ui_init3D();
  ui_applyLeaves();
  // flow + dispersion on the GPU where it runs; otherwise the approximate model, with a visible notice
  if (ui_X.LBM && ui_X.LBM.ok && ui_X.Aero) {
    ui_aero = ui_try('aero.Aero', () => new ui_X.Aero({ onResult: ui_onResult, onProgress: ui_onProgress }), null);
  } else if (!ui_X.Aero) {
    ui_missing('aero.js', 'ui.err.what.aero');
  } else if (!ui_X.LBM) {
    ui_missing('wind-tunnel.js', 'ui.err.what.aero');
  }
  if (!ui_aero) {
    const note = $('#stage-note');
    note.hidden = false;
    const why = () => (ui_X.LBM && ui_X.LBM.ok === false ? t('ui.note.fallback')
      : !ui_X.LBM ? t('ui.err.missing', { m: 'wind-tunnel.js', what: t('ui.err.what.aero') }) : t('ui.lut.noaero'));
    note.textContent = why();
    I18N.onChange(() => { note.textContent = why(); });
  }
  ui_buildStreetPoints();
  ui_bindControls();
  ui_changed({ request: true });
  ui_renderNow();
  ui_renderCal();
  ui_renderFooter();
  ui_renderLegend();
  ui_renderParticleLegend();
  ui_renderSweepNote();
  ui_renderModelLine();
  if (UI_SWEEP_LUT) ui_startLutSweep();
  const loading = $('#loading');
  if (loading) loading.remove();
  window.__z1.ready = true;
  requestAnimationFrame(ui_frame);
  // live data last, so a slow network never delays the first frame
  ui_loadLive();
  ui_loadForecast();
}

// ?debug exposes a few internals on window.__z1dbg for diagnosis from the console or a test harness.
if (PARAMS.has('debug')) {
  window.__z1dbg = { state, res: ui_res, points: () => ui_pointsRes, met: ui_met, bg: ui_bg, viewField: ui_viewField, valueFn: ui_valueFn,
    fallbackField: ui_fallbackField, pick: ui_pick, live: ui_live, recv: ui_recv, fields: ui_fields, views: ui_views, modelAt: ui_modelAt,
    aero: () => ui_aero, prog: ui_prog, pending: ui_pending, renderer: ui_X.renderer, scene: ui_X.scene, LBM: ui_X.LBM };
}

if (!SELFTEST) {
  try { ui_boot(); } catch (e) {
    ui_fail('ui.boot', e);
    window.__z1.ready = true;   // the page is up (with the error card); smoke tests read the error list
  }
}
