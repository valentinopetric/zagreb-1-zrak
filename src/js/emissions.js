// ------------------------------------------------------------------ emissions
/*
 * Pure emission model [owner: models]: traffic volumes in time, fleet emission factors, scenario measures,
 * domestic heating, and the per-group reference source strengths q_k that multiply the unit responses Γ_k.
 * No THREE, no DOM. Mirrored in tools/aqmodel.py (parity to 1e-6). Every number is from critic §4.6 unless
 * another source is given; docs/05-emissions.md explains each one.
 *
 * Source groups (architecture §5.3, SITE.model_defaults.source_groups):
 *   A Ulica grada Vukovara, B Miramarska cesta, C all other motor roads   line sources, g m⁻¹ s⁻¹
 *   D domestic heating over low-rise residential polygons                  area source,  g m⁻² s⁻¹
 *
 * Unit convention (architecture §5.3). The rasteriser gives each cell the weight Σ length·AADT/10 000
 * (roads) or Σ area·w (heating), so
 *   q_A..C = emission of ONE "unit" of 10 000 veh/day at this hour [g m⁻¹ s⁻¹]
 *          = (10 000 · f(t) / 24) [veh/h] · EF [g veh⁻¹ km⁻¹] / 3.6e6 [s/h · m/km]      (physics §5.8)
 *   q_D    = heating emission per m² of polygon with weight w = 1 at this hour [g m⁻² s⁻¹]
 * and the increment is ΔC [µg/m³] = 1e6 · β · Σ_k q_k Γ_k / U_eff (model.js increment()).
 *
 * Contents: EF_DEFAULT, TRAFFIC_PROFILES, trafficFactor, EM_MEASURES_TODAY, measureFactors, EM_HEATING,
 *           EM_CONGESTION, groupStrengths, POLLUTANTS, POLLUTANT_INFO.
 */

// ------------------------------------------------------------------ emission factors
/*
 * Fleet-average emission factors per vehicle, 2026 prior, g veh⁻¹ km⁻¹ (critic §4.6; physics §7.2–7.4):
 *   nox          0.50   EMEP/EEA 2023 Tier 2 with an assumed Zagreb Euro mix gives 0.46; raised for real-world
 *                       urban driving and cold starts (physics §7.2); β absorbs the rest (critic §1.12)
 *   pm10_exh     0.017  Tier 2 fleet PM exhaust (physics §7.2); exhaust PM counts entirely as PM2.5
 *   pm10_nonexh  0.029  tyre + brake + road wear, Tier 1 (EMEP 1.A.3.b.vi–vii Tables 3-1, 3-2), fleet-weighted
 *   pm10_resusp  0.056  road-dust resuspension, AP-42 §13.2.1 with sL = 0.03 g/m², W = 2.2 t (physics §7.4);
 *                       only with the "winter sanding" measure (measures.resuspension)
 *   pm25         0.032  = pm25_exh 0.017 + pm25_nonexh 0.015 (wear PM2.5, physics §7.3)
 *   pm25_resusp         = pm10_resusp · k_PM2.5/k_PM10 = 0.056 · 0.15/0.62 (AP-42 particle-size multipliers)
 *   co           0.49   = 0.98 × NOx (increment ratio with daily-P5 background, physics §7.6)
 *   c6h6         0.0036 = 0.0071 × NOx (same method)
 * PM10 total without resuspension = 0.046, i.e. PM10/NOx ≈ 0.09, inside the measured 0.07–0.19 (critic §1.4).
 */
const EF_DEFAULT = {
  nox: 0.50, pm10_exh: 0.017, pm10_nonexh: 0.029, pm10_resusp: 0.056, pm25: 0.032, co: 0.49, c6h6: 0.0036,
  pm25_exh: 0.017, pm25_nonexh: 0.015, pm25_resusp: 0.056 * 0.15 / 0.62,
};

/*
 * Shares used by the measures (all derived from sourced numbers; docs/05-emissions.md §4):
 *   brake:  brake wear share of fleet non-exhaust PM, medium ICE car (EMEP 1.A.3.b.vi Tables 3-4/3-6 TSP
 *           tyre 0.0107, brake 0.0122 g/km × size fractions Tables 3-5/3-7 (tyre PM10 0.60, PM2.5 0.42; brake
 *           0.98, 0.39)) over tyre + brake + road wear (Tier 1 PC 0.0184 + 0.0075 PM10, 0.0093 + 0.0041 PM2.5)
 *   bevBrake: BEV brake wear relative to ICE, 0.0035/0.0122 ≈ 0.3 (Table 3-6 medium car; critic §4.6 "× 0.3")
 *   bus:    share of fleet exhaust from buses = s_bus · EF_bus / EF_fleet with s_bus = 0.5 % of vehicle-km on the
 *           avenues (site-context §9.3) and EF_bus the mean of a diesel and a CNG urban bus: NOx 3.713 (Tier 2
 *           mix 3.975 and EEV CNG 3.451, physics §7.2), PM 0.0636 (Tier 1 HDV diesel 0.119, CNG bus 0.0081),
 *           CO 1.47 (Tier 1 HDV 1.32, CNG bus 1.61); benzene from diesel/CNG buses is negligible
 *   lez:    low-emission zone (Euro <= 2 petrol and <= 3 diesel out): NOx -40 %, exhaust PM -75 % (Pejić et al.
 *           2018 via critic §4.6). CO and benzene take the NOx factor, an assumption (old petrol cars dominate
 *           both, so this is conservative).
 */
const EM_SHARES = {
  brake: {
    pm10: (0.0122 * 0.98) / (0.0184 + 0.0075),
    pm25: (0.0122 * 0.39) / (0.0093 + 0.0041),
  },
  bevBrake: 0.3,
  bus: {
    nox: 0.005 * 3.713 / EF_DEFAULT.nox,
    pm: 0.005 * 0.0636 / EF_DEFAULT.pm10_exh,
    co: 0.005 * 1.47 / EF_DEFAULT.co,
    c6h6: 0,
  },
  lez: { nox: 0.60, pm: 0.25, co: 0.60, c6h6: 0.60 },
};

// ------------------------------------------------------------------ traffic time profiles
/*
 * Traffic volume in time: veh/h = AADT · f(t) / 24 with f(t) = 24 · p_type(h) · F_day(d) · F_month(m), where h, d
 * and m are the LOCAL hour start, day and month (met_localParts).
 *   hour.weekday   site-context §3.4 weekday table, % of daily traffic by hour-ending 1..24, re-indexed here by
 *                  hour START 0..23 (critic §4.6 "Hourly"). Peaks 08–09 and 17–18.
 *   hour.saturday, hour.sunday   no counts exist (critic G1). Derived shape: the weekday table times the ratio
 *                  of the corrected effective emission profiles E_sat(h)/E_wd(h) and E_sun(h)/E_wd(h) (critic
 *                  §1.3, critic/effective_emission_profile_z4_ifs_2025.csv; median ΔNOx·U_eff by hour with the
 *                  ZAGREB-4 background and IFS wind). The ratio cancels the shared diurnal cycle of dispersion;
 *                  it was smoothed with a circular [1,2,1]/4 filter against sampling noise (≈ 52 days per bin).
 *                  Its daily sums (0.62, 0.50) match the NOx day ratios of critic §1.3 (0.65, 0.52).
 *   day            Mon–Thu 1.00, Fri 1.02, Sat 0.90, Sun 0.70 (Action Plan counts, site-context §3.4), divided by
 *                  their mean so that the weekly mean of f is exactly 1.
 *   month          Jan 0.95, Feb 0.98, Mar–Jun 1.02, Jul 0.93, Aug 0.85, Sep–Nov 1.03, Dec 1.00 (site-context
 *                  §3.4, an assumption), divided by their day-weighted mean over 365 days so that AADT stays the
 *                  annual average.
 * Croatian public holidays (Zakon o blagdanima, NN 110/19) use the Sunday shape and factor.
 * Every hour table is normalised to sum to exactly 1 here, so the rounded published values can be kept.
 */
const em_norm = (a) => { const s = a.reduce((x, y) => x + y, 0); return a.map((v) => v / s); };
const EM_PROFILE_RAW = {
  weekday: [0.9, 0.6, 0.4, 0.4, 0.6, 1.5, 4.0, 6.8, 7.2, 6.0, 5.3, 5.4, 5.6, 5.7, 6.0, 6.6, 7.2, 7.3, 6.6, 5.2, 3.9, 3.0, 2.3, 1.5],
  saturday: [2.72, 2.08, 1.49, 1.21, 1.07, 1.52, 2.98, 4.83, 5.35, 4.96, 4.56, 4.50, 4.71, 4.44, 3.81, 3.94, 5.33, 6.96, 7.40, 6.61, 5.44, 5.13, 5.04, 3.93],
  sunday: [4.10, 3.34, 2.32, 1.90, 1.55, 1.55, 1.93, 2.56, 3.15, 3.49, 3.43, 3.45, 3.79, 3.99, 4.01, 4.83, 6.69, 8.65, 9.27, 7.71, 5.86, 4.60, 3.76, 4.10],
  day: [1.00, 1.00, 1.00, 1.00, 1.02, 0.90, 0.70],
  month: [0.95, 0.98, 1.02, 1.02, 1.02, 1.02, 0.93, 0.85, 1.03, 1.03, 1.03, 1.00],
};
const EM_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const TRAFFIC_PROFILES = (() => {
  const R = EM_PROFILE_RAW;
  const dayMean = R.day.reduce((a, b) => a + b, 0) / 7;
  const monthMean = R.month.reduce((a, v, i) => a + v * EM_MONTH_DAYS[i], 0) / 365;
  return {
    hour: { weekday: em_norm(R.weekday), saturday: em_norm(R.saturday), sunday: em_norm(R.sunday) },
    day: R.day.map((v) => v / dayMean),
    month: R.month.map((v) => v / monthMean),
    raw: R,
  };
})();

// Easter Sunday (Gregorian; anonymous algorithm as given by Meeus, Astronomical Algorithms, ch. 8) → [month, day].
function em_easter(Y) {
  const a = Y % 19, b = Math.floor(Y / 100), c = Y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const x = h + l - 7 * m + 114;
  return [Math.floor(x / 31), (x % 31) + 1];
}
// Croatian public holidays (NN 110/19): fixed dates plus Easter Monday and Corpus Christi (Easter + 60 days).
const EM_HOLIDAYS_FIXED = ['1-1', '1-6', '5-1', '5-30', '6-22', '8-5', '8-15', '11-1', '11-18', '12-25', '12-26'];
function em_isHoliday(year, month, day) {
  if (EM_HOLIDAYS_FIXED.includes(`${month}-${day}`)) return true;
  const [em, ed] = em_easter(year);
  const e = Date.UTC(year, em - 1, ed), x = Date.UTC(year, month - 1, day);
  return x === e + 86400e3 || x === e + 60 * 86400e3;
}
// Day type of the local hour start: 'weekday' | 'saturday' | 'sunday' (holidays count as Sunday).
function em_dayType(p) {
  if (p.dow === 6 || em_isHoliday(p.year, p.month, p.day)) return 'sunday';
  return p.dow === 5 ? 'saturday' : 'weekday';
}

/*
 * f(t) with veh/h = AADT · f / 24 for the hour ending at dateUTC. {month: false} leaves out the monthly factor;
 * then the mean of f over any Monday–Sunday week without a holiday is exactly 1.
 */
function trafficFactor(dateUTC, { month = true } = {}) {
  const p = met_localParts(dateUTC);
  const type = em_dayType(p);
  const TP = TRAFFIC_PROFILES;
  const fd = type === 'sunday' ? TP.day[6] : TP.day[p.dow];
  return 24 * TP.hour[type][p.hour] * fd * (month ? TP.month[p.month - 1] : 1);
}

// ------------------------------------------------------------------ measures (scenarios)
/*
 * The emission side of a scenario (architecture §6.1). All fields optional; this object is "today":
 *   lez                 bool   low-emission zone over the whole domain (EM_SHARES.lez)
 *   evShare             %      additional battery-electric share of vehicle-km, 0–100 (like the UI slider):
 *                              removes exhaust, keeps tyre/road wear, brake wear × 0.3 (critic §4.6)
 *   eBus                bool   electric buses: bus exhaust removed on every road (EM_SHARES.bus)
 *   carFreeMiramarska   bool   group B traffic removed; no re-routing (an upper bound of the benefit)
 *   trafficPct          %      all road traffic, 100 = today
 *   trafficA, trafficB  %      Vukovarska / Miramarska traffic on top of trafficPct, 100 = today
 *   congestion          bool   rush-hour queues: exhaust × 2.5 near the stop lines (EM_CONGESTION)
 *   resuspension        bool   winter sanding: adds the AP-42 road-dust factor to PM10/PM2.5
 */
const EM_MEASURES_TODAY = Object.freeze({ lez: false, evShare: 0, eBus: false, carFreeMiramarska: false,
  trafficPct: 100, trafficA: 100, trafficB: 100, congestion: false, resuspension: false });

/*
 * Multipliers of a measure set: {exhaust: {nox, pm10, pm25, co, c6h6}, nonexhaust: {pm10, pm25},
 * resuspension: bool, congestion: bool, byGroup: {A, B, C} (traffic volume), evShare (as a fraction 0..1)}.
 * The factors of independent measures are multiplied (vehicles removed by the LEZ are ICE vehicles, so
 * the EV and LEZ reductions compound).
 */
function measureFactors(measures = {}) {
  const m = { ...EM_MEASURES_TODAY, ...(measures || {}) };
  const ev = clamp((Number(m.evShare) || 0) / 100, 0, 1);      // percent → fraction
  const S = EM_SHARES;
  const lez = (k) => (m.lez ? S.lez[k] : 1);
  const bus = (k) => (m.eBus ? 1 - S.bus[k] : 1);
  const pmExh = (1 - ev) * lez('pm') * bus('pm');
  const pct = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) / 100 : 1);
  const all = pct(m.trafficPct);
  return {
    exhaust: {
      nox: (1 - ev) * lez('nox') * bus('nox'),
      pm10: pmExh, pm25: pmExh,
      co: (1 - ev) * lez('co') * bus('co'),
      c6h6: (1 - ev) * lez('c6h6') * bus('c6h6'),
    },
    nonexhaust: {
      pm10: 1 - ev * S.brake.pm10 * (1 - S.bevBrake),
      pm25: 1 - ev * S.brake.pm25 * (1 - S.bevBrake),
    },
    resuspension: !!m.resuspension,
    congestion: !!m.congestion,
    byGroup: { A: all * pct(m.trafficA), B: m.carFreeMiramarska ? 0 : all * pct(m.trafficB), C: all },
    evShare: ev,
  };
}

// ------------------------------------------------------------------ congestion
/*
 * Rush-hour queues (critic §4.6): exhaust EF × 2.5 within 60 m upstream of the Vukovarska and Miramarska stop
 * lines, weekdays 07–09 h and 15–18 h local (hour starts 7, 8, 15, 16, 17). Pejić et al. 2018: 0.95 g/km at
 * 15 km/h against 0.40 at 37 km/h (site-context §3.5). The receptor models know only whole groups, so the
 * factor is applied to a group's exhaust as 1 + (2.5 - 1)·φ_k, φ_k = the share of the group's receptor
 * response Γ_k that comes from the queue stretches. The Gaussian fallback computes φ_k per direction exactly
 * (FallbackModel.receptor().queue); tools/calibrate.py stores its climatological mean in
 * calibration.json "congestion_share" for the LUT path; the value below is that climatological mean for the
 * env.json of 2026-09-27 (weekday rush hours of 2025, IFS winds) and is used only when neither is available.
 */
const EM_CONGESTION = {
  factor: 2.5,
  hours: [7, 8, 15, 16, 17],
  share: { A: 0.21, B: 0.37 },
};
const em_congestionShare = (opts) => (opts && opts.congestionShare)
  || (CAL && CAL.congestion_share && Number.isFinite(CAL.congestion_share.A) ? CAL.congestion_share : EM_CONGESTION.share);

// ------------------------------------------------------------------ domestic heating (group D)
/*
 * Order-of-magnitude area source (critic §4.6, gap G14; site-context §6, §9.4):
 *   season   October–March (heating 'auto'); opts.heating = true forces it on in any month
 *   peak     evening-peak rates for polygon weight w = 1: NOx 1 µg m⁻² s⁻¹, PM10 2 µg m⁻² s⁻¹ (from household
 *            emissions of the 2010 city inventory spread over the built-up area, site-context §9.4)
 *   ratios   PM2.5/PM10 and CO/NOx from EMEP/EEA 2023 1.A.4.b.i Tier 1 (Tables 3-4, 3-5, 3-6, g/GJ: gas NOx 51,
 *            CO 26, PM 1.2; liquid NOx 51, CO 57, PM 1.9; wood NOx 50, CO 4000, PM10 760, PM2.5 740) weighted by
 *            the Zagreb household heating mix gas 47 %, oil 8 %, wood 7 % (district heating 33 % and electricity
 *            5 % emit nothing locally; eko.zagreb.hr via site-context §6). Benzene is not given by EMEP Tier 1
 *            and is left at 0.
 *   hour     diurnal shape by local hour start, 1 = evening peak. The Action Plan gives the peaks (08–10 h and
 *            19–22 h, site-context §6); the hour values are an assumption shaped to those peaks with a
 *            peak/mean ratio of 2.1, inside the 2–3 of site-context §9.4.
 */
const EM_HEAT_MIX = { gas: 0.47, oil: 0.08, wood: 0.07 };
const EM_HEAT_EF = {       // g/GJ, EMEP/EEA 2023 1.A.4.b.i Tier 1
  gas: { nox: 51, co: 26, pm10: 1.2, pm25: 1.2 },
  oil: { nox: 51, co: 57, pm10: 1.9, pm25: 1.9 },
  wood: { nox: 50, co: 4000, pm10: 760, pm25: 740 },
};
const em_mixEF = (p) => Object.keys(EM_HEAT_MIX).reduce((s, f) => s + EM_HEAT_MIX[f] * EM_HEAT_EF[f][p], 0);
const EM_HEATING = {
  months: [10, 11, 12, 1, 2, 3],
  rate: {                   // µg m⁻² s⁻¹ at the evening peak, weight w = 1
    nox: 1.0,
    pm10: 2.0,
    pm25: 2.0 * em_mixEF('pm25') / em_mixEF('pm10'),
    co: 1.0 * em_mixEF('co') / em_mixEF('nox'),
    c6h6: 0,
  },
  hour: [0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.30, 0.60, 0.80, 0.80, 0.60, 0.30,
    0.30, 0.30, 0.30, 0.30, 0.40, 0.60, 0.80, 1.00, 1.00, 1.00, 0.60, 0.30],
};
function em_heatingOn(setting, month) {
  if (setting === true) return true;
  if (setting === 'auto') return EM_HEATING.months.includes(month);
  return false;
}

// ------------------------------------------------------------------ group source strengths
/*
 * q_k for one pollutant in the hour ending at dateUTC (units in the file header): {A, B, C, D}.
 *   pollutant  'nox' | 'no2' | 'no' (all three return the NOx emission: NO2 is formed by chemistry from the NOx
 *              increment) | 'pm10' | 'pm25' | 'co' | 'c6h6'. CO is in g (so ΔCO comes out in µg/m³). Other
 *              species (o3) have no primary emission and give zeros.
 *   measures   see EM_MEASURES_TODAY
 *   opts.heating         true | 'auto' | false (default false: the heating toggle of the UI; 'auto' = in season)
 *   opts.ef              partial override of EF_DEFAULT (UI sliders), same keys
 *   opts.heatingScale    multiplier on the heating rates (default 1)
 *   opts.congestionShare {A, B} override of φ_k (see EM_CONGESTION)
 */
function groupStrengths(pollutant, dateUTC, measures = {}, opts = {}) {
  const p = pollutant === 'no2' || pollutant === 'no' ? 'nox' : pollutant;
  const out = { A: 0, B: 0, C: 0, D: 0 };
  if (!['nox', 'pm10', 'pm25', 'co', 'c6h6'].includes(p)) return out;
  const mf = measureFactors(measures);
  const ef = { ...EF_DEFAULT, ...((opts && opts.ef) || {}) };
  const exh = p === 'nox' ? ef.nox : p === 'pm10' ? ef.pm10_exh : p === 'pm25' ? ef.pm25_exh : ef[p];
  const ne = p === 'pm10' ? ef.pm10_nonexh : p === 'pm25' ? ef.pm25_nonexh : 0;
  const rs = !mf.resuspension ? 0 : p === 'pm10' ? ef.pm10_resusp : p === 'pm25' ? ef.pm25_resusp : 0;
  const lp = met_localParts(dateUTC);
  const queue = mf.congestion && em_dayType(lp) === 'weekday' && EM_CONGESTION.hours.includes(lp.hour);
  const share = em_congestionShare(opts);
  const veh = MD.aadt_unit * trafficFactor(dateUTC) / 24;          // veh/h in one 10 000 veh/day unit
  for (const g of ['A', 'B', 'C']) {
    const cong = queue && g !== 'C' ? 1 + (EM_CONGESTION.factor - 1) * (share[g] || 0) : 1;
    const EF = exh * mf.exhaust[p] * cong + ne * (mf.nonexhaust[p] ?? 1) + rs;
    out[g] = veh * EF / 3.6e6 * mf.byGroup[g];
  }
  if (em_heatingOn(opts && opts.heating, lp.month)) {
    const scale = Number.isFinite(opts.heatingScale) ? opts.heatingScale : 1;
    out.D = EM_HEATING.rate[p] * 1e-6 * EM_HEATING.hour[lp.hour] * scale;
  }
  return out;
}

// ------------------------------------------------------------------ pollutants
/*
 * The pollutants the app models (architecture §6.1) and their display metadata. `iszz` is the ISZZ parameter
 * code (SITE.iszz.params); `unit` is the display unit (CO in mg/m³ as ISZZ reports it); `label` is localised
 * at access time. O3 and NO are listed for display of the chemistry outputs, not modelled as emissions.
 */
const POLLUTANTS = ['nox', 'no2', 'pm10', 'pm25', 'co', 'c6h6'];
const POLLUTANT_INFO = Object.fromEntries(
  [['nox', 'NOx'], ['no2', 'NO₂'], ['pm10', 'PM10'], ['pm25', 'PM2.5'], ['co', 'CO'], ['c6h6', 'C₆H₆'], ['o3', 'O₃'], ['no', 'NO']]
    .map(([p, short]) => [p, {
      short,
      unit: p === 'co' ? 'mg/m³' : 'µg/m³',
      iszz: SITE.iszz.params[p] ? SITE.iszz.params[p].code : null,
      key: `model.pol.${p}`,
      get label() { return t(`model.pol.${p}`); },
    }]));

// ------------------------------------------------------------------ strings (hr, en)
I18N.add({
  hr: {
    'model.pol.nox': 'dušikovi oksidi (NOx, kao NO₂)', 'model.pol.no2': 'dušikov dioksid (NO₂)',
    'model.pol.pm10': 'lebdeće čestice PM10', 'model.pol.pm25': 'lebdeće čestice PM2,5',
    'model.pol.co': 'ugljikov monoksid (CO)', 'model.pol.c6h6': 'benzen (C₆H₆)', 'model.pol.o3': 'ozon (O₃)',
    'model.pol.no': 'dušikov monoksid (NO)',
    'model.group.A': 'Vukovarska', 'model.group.B': 'Miramarska', 'model.group.C': 'ostale ceste', 'model.group.D': 'kućna ložišta',
    'model.measure.lez': 'zona niskih emisija', 'model.measure.evShare': 'udio električnih vozila',
    'model.measure.eBus': 'električni autobusi', 'model.measure.carFreeMiramarska': 'Miramarska bez automobila',
    'model.measure.trafficPct': 'promet (sve ceste)', 'model.measure.trafficA': 'promet Vukovarskom',
    'model.measure.trafficB': 'promet Miramarskom', 'model.measure.congestion': 'gužve u vršnim satima',
    'model.measure.resuspension': 'zimsko posipanje (resuspenzija prašine)', 'model.measure.heating': 'sezona grijanja',
    'model.heating.note': 'kućna ložišta: procjena reda veličine (inventar 2010.)',
    'model.pm.note': 'PM je uglavnom pozadina; lokalni doprinos prometa je mali',
  },
  en: {
    'model.pol.nox': 'nitrogen oxides (NOx, as NO₂)', 'model.pol.no2': 'nitrogen dioxide (NO₂)',
    'model.pol.pm10': 'particulate matter PM10', 'model.pol.pm25': 'particulate matter PM2.5',
    'model.pol.co': 'carbon monoxide (CO)', 'model.pol.c6h6': 'benzene (C₆H₆)', 'model.pol.o3': 'ozone (O₃)',
    'model.pol.no': 'nitric oxide (NO)',
    'model.group.A': 'Vukovarska', 'model.group.B': 'Miramarska', 'model.group.C': 'other roads', 'model.group.D': 'domestic heating',
    'model.measure.lez': 'low-emission zone', 'model.measure.evShare': 'electric vehicle share',
    'model.measure.eBus': 'electric buses', 'model.measure.carFreeMiramarska': 'car-free Miramarska',
    'model.measure.trafficPct': 'traffic (all roads)', 'model.measure.trafficA': 'traffic on Vukovarska',
    'model.measure.trafficB': 'traffic on Miramarska', 'model.measure.congestion': 'rush-hour queues',
    'model.measure.resuspension': 'winter sanding (road-dust resuspension)', 'model.measure.heating': 'heating season',
    'model.heating.note': 'domestic heating: order-of-magnitude estimate (2010 inventory)',
    'model.pm.note': 'PM is mostly background; the local traffic increment is small',
  },
});
