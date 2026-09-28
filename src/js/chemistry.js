// ------------------------------------------------------------------ chemistry
/*
 * Pure NO–NO2–O3 chemistry, unit conversions, limit values and air-quality index bands [owner: models].
 * No THREE, no DOM; labels go through t(). Mirrored in tools/aqmodel.py (parity to 1e-6).
 *
 * Contents:
 *   PPB                      µg/m³ per ppb at EU reporting conditions, with toPpb()/toUg()
 *   no2Chemistry             Riccati finite-reaction-time scheme with conserved oxidant (physics §8.2, critic §1.2)
 *   CHEM_TAU_DEFAULT         plume age used when no age tracer is available (60 s, critic §1.2)
 *   THRESHOLDS, thresholdLines   EU AAQD 2024/2881 (to 2029 and from 2030), HR NN 77/2020, WHO 2021 (iszz-api §9)
 *   EAQI_BANDS, EAQI_BANDS_ISZZ, eaqi   EEA 2024 index and the legacy bands ISZZ still uses (iszz-api §9.3)
 *
 * All concentrations are µg/m³ except CO, whose thresholds are in mg/m³ (as ISZZ reports it).
 */

// ------------------------------------------------------------------ unit conversion
/*
 * µg/m³ per ppb = M / V_m, with V_m = R T / p the molar volume at the EU reporting conditions for gases
 * (293.15 K, 101.325 kPa; Directive 2008/50/EC Annex VI, kept by AAQD 2024/2881): V_m = 24.055 L/mol.
 * Molar masses from IUPAC standard atomic weights (N 14.0067, O 15.9994, C 12.0107, H 1.00794, S 32.065).
 * Gives NO2 1.9125, NO 1.2474, O3 1.9953 (physics §5.8 prints 1.9956; the 0.01 % difference is immaterial).
 * NOx is reported "as NO2" by ISZZ, so its factor is that of NO2.
 */
const CHEM_VM = 8.314462618 * 293.15 / 101.325;   // L/mol
const PPB = {
  no2: 46.0055 / CHEM_VM,
  nox: 46.0055 / CHEM_VM,
  no: 30.0061 / CHEM_VM,
  o3: 47.9982 / CHEM_VM,
  so2: 64.0638 / CHEM_VM,
  co: 28.0101 / CHEM_VM,
  c6h6: 78.11184 / CHEM_VM,
  toPpb(p, ug) { return ug / PPB[p]; },
  toUg(p, ppb) { return ppb * PPB[p]; },
};

// Plume age [s] when the age tracer is unavailable: the best constant for ZAGREB-1 with ZAGREB-4 background
// (critic §1.2: f = 0.10, τ = 60 s gives RMSE 5.0 µg/m³, FB -0.01 on 2025 data).
const CHEM_TAU_DEFAULT = 60;

// ------------------------------------------------------------------ NO–NO2–O3
/*
 * NO2 at a receptor from background + local NOx increment (physics §8.2, Eqs. 8.1–8.3; critic §1.2).
 * Reactions NO2 + hν → NO + O(→O3) with frequency J, and NO + O3 → NO2 with rate k. NOx and the oxidant
 * Ox = NO2 + O3 are conserved, so in ppb
 *   N = NOx_bg + ΔNOx,   X = O3_bg + NO2_bg + f ΔNOx,   x0 = NO2_bg + f ΔNOx  (fresh plume mixed into background)
 *   dx/dt = k (N - x)(X - x) - J x = k (x - x1)(x - x2),  x1,2 = ½(N + X + A ∓ Δ),  Δ = √((N+X+A)² - 4NX),  A = J/k
 * with the exact Riccati solution after the plume age τ:
 *   x(τ) = (x1 - x2 R e^{-kΔτ}) / (1 - R e^{-kΔτ}),   R = (x0 - x1)/(x0 - x2).
 * τ → ∞ gives the photostationary state x1 (Leighton); J = 0 and τ → ∞ gives titration x = min(N, X).
 * For τ > 0 one always has |R e^{-kΔτ}| < 1, so the formula has no singularity.
 *
 * Inputs (µg/m³; NOx as NO2): noxInc (clipped at 0), no2Bg, noxBg, o3Bg; tau [s] (Infinity = PSS, <= 0 = no
 * reaction); J [1/s] from jNO2(); k [ppb⁻¹ s⁻¹] from kNOO3(); fNO2 primary NO2/NOx mass fraction (0.10, critic §1.2).
 * Returns µg/m³ {no2, no, o3, nox, ox} with no as NO mass and nox as NO2 mass. The result is clipped to the
 * physical range 0 <= NO2 <= min(NOx, Ox), which only matters for noisy inputs with NO2_bg > NOx_bg.
 */
function no2Chemistry({ noxInc = 0, no2Bg = 0, noxBg = 0, o3Bg = 0, tau = CHEM_TAU_DEFAULT, J = 0, k = kNOO3(15), fNO2 = MD.f_no2 } = {}) {
  const P = PPB;
  const dN = Math.max(0, noxInc || 0) / P.no2;
  const Nb = Math.max(0, noxBg || 0) / P.no2;
  const xb = Math.max(0, no2Bg || 0) / P.no2;
  const ob = Math.max(0, o3Bg || 0) / P.o3;
  const N = Nb + dN;
  const X = ob + xb + fNO2 * dN;
  const x0 = xb + fNO2 * dN;
  let x;
  if (!(tau > 0) || !(k > 0)) {
    x = x0;
  } else {
    const A = Math.max(0, J || 0) / k;
    const s = N + X + A;
    const D = Math.sqrt(Math.max(s * s - 4 * N * X, 1e-12));
    const x1 = 0.5 * (s - D), x2 = 0.5 * (s + D);
    if (tau === Infinity) {
      x = x1;
    } else {
      const den = x0 - x2;
      if (Math.abs(den) < 1e-12) x = x1;
      else {
        const E = ((x0 - x1) / den) * Math.exp(-k * D * tau);
        x = (x1 - x2 * E) / (1 - E);
      }
    }
  }
  x = clamp(x, 0, Math.min(N, X));
  return { no2: x * P.no2, no: (N - x) * P.no, o3: (X - x) * P.o3, nox: N * P.no2, ox: X };
}

// ------------------------------------------------------------------ limit values and thresholds
/*
 * Air-quality standards (iszz-api §9.1–9.2, checked against the AAQD text in critic §1.14). Per pollutant and
 * averaging period a list of lines {v, kind, from, to, n, stat, ref}:
 *   v     value in µg/m³ (CO in mg/m³)
 *   kind  'limit' (EU/HR limit value), 'target' (O3 target value), 'info' / 'alert' (information and alert
 *         thresholds), 'who' (WHO Air Quality Guidelines 2021)
 *   from, to  first and last calendar year in which the line applies (null = open)
 *   n     permitted exceedances per calendar year (limit values)
 *   stat  'p99' where the WHO guideline is a 99th percentile (3–4 exceedance days per year)
 *   ref   'aaqd2008' = 2008/50/EC as kept in AAQD 2024/2881 Annex I Table 2 (= HR NN 77/2020), valid until
 *         31.12.2029; 'aaqd2030' = AAQD 2024/2881 Annex I Table 1 (limits from 1.1.2030) and Section 4
 *         (information/alert thresholds, to be transposed by 11.12.2026); 'hr77' = HR Uredba NN 77/2020;
 *         'who2021' / 'who2005' / 'who2000' = WHO guideline editions.
 * The 3-hour persistence condition of the NO2/SO2 alert thresholds and the 3-year averaging of the O3 target
 * are recorded in `note`; the app draws the value only.
 */
const THRESHOLDS = {
  no2: {
    '1h': [
      { v: 200, kind: 'limit', to: 2029, n: 18, ref: 'aaqd2008' },
      { v: 200, kind: 'limit', from: 2030, n: 3, ref: 'aaqd2030' },
      { v: 150, kind: 'info', from: 2027, ref: 'aaqd2030' },
      { v: 200, kind: 'alert', from: 2027, note: '3h', ref: 'aaqd2030' },
      { v: 400, kind: 'alert', to: 2026, note: '3h', ref: 'hr77' },
      { v: 200, kind: 'who', ref: 'who2005' },
    ],
    '24h': [
      { v: 50, kind: 'limit', from: 2030, n: 18, ref: 'aaqd2030' },
      { v: 25, kind: 'who', stat: 'p99', ref: 'who2021' },
    ],
    year: [
      { v: 40, kind: 'limit', to: 2029, ref: 'aaqd2008' },
      { v: 20, kind: 'limit', from: 2030, ref: 'aaqd2030' },
      { v: 10, kind: 'who', ref: 'who2021' },
    ],
  },
  pm10: {
    '24h': [
      { v: 50, kind: 'limit', to: 2029, n: 35, ref: 'aaqd2008' },
      { v: 45, kind: 'limit', from: 2030, n: 18, ref: 'aaqd2030' },
      { v: 90, kind: 'info', from: 2027, ref: 'aaqd2030' },
      { v: 90, kind: 'alert', from: 2027, note: '3d', ref: 'aaqd2030' },
      { v: 45, kind: 'who', stat: 'p99', ref: 'who2021' },
    ],
    year: [
      { v: 40, kind: 'limit', to: 2029, ref: 'aaqd2008' },
      { v: 20, kind: 'limit', from: 2030, ref: 'aaqd2030' },
      { v: 15, kind: 'who', ref: 'who2021' },
    ],
  },
  pm25: {
    '24h': [
      { v: 25, kind: 'limit', from: 2030, n: 18, ref: 'aaqd2030' },
      { v: 50, kind: 'info', from: 2027, ref: 'aaqd2030' },
      { v: 50, kind: 'alert', from: 2027, note: '3d', ref: 'aaqd2030' },
      { v: 15, kind: 'who', stat: 'p99', ref: 'who2021' },
    ],
    year: [
      { v: 20, kind: 'limit', to: 2029, ref: 'hr77' },          // HR "2. stupanj" from 1.1.2020 (EU value: 25)
      { v: 10, kind: 'limit', from: 2030, ref: 'aaqd2030' },
      { v: 5, kind: 'who', ref: 'who2021' },
    ],
  },
  so2: {
    '1h': [
      { v: 350, kind: 'limit', to: 2029, n: 24, ref: 'aaqd2008' },
      { v: 350, kind: 'limit', from: 2030, n: 3, ref: 'aaqd2030' },
      { v: 275, kind: 'info', from: 2027, ref: 'aaqd2030' },
      { v: 350, kind: 'alert', from: 2027, note: '3h', ref: 'aaqd2030' },
      { v: 500, kind: 'alert', to: 2026, note: '3h', ref: 'hr77' },
    ],
    '24h': [
      { v: 125, kind: 'limit', to: 2029, n: 3, ref: 'aaqd2008' },
      { v: 50, kind: 'limit', from: 2030, n: 18, ref: 'aaqd2030' },
      { v: 40, kind: 'who', stat: 'p99', ref: 'who2021' },
    ],
    year: [{ v: 20, kind: 'limit', from: 2030, ref: 'aaqd2030' }],
  },
  co: {   // mg/m³
    '8h': [
      { v: 10, kind: 'limit', ref: 'aaqd2008' },
      { v: 10, kind: 'who', ref: 'who2000' },
    ],
    '24h': [
      { v: 4, kind: 'limit', from: 2030, n: 18, ref: 'aaqd2030' },
      { v: 4, kind: 'who', stat: 'p99', ref: 'who2021' },
    ],
    '1h': [{ v: 35, kind: 'who', ref: 'who2000' }],
  },
  c6h6: {
    year: [
      { v: 5, kind: 'limit', to: 2029, ref: 'aaqd2008' },
      { v: 3.4, kind: 'limit', from: 2030, ref: 'aaqd2030' },
    ],
  },
  o3: {
    '8h': [
      { v: 120, kind: 'target', to: 2029, n: 25, note: '3y', ref: 'aaqd2008' },
      { v: 120, kind: 'target', from: 2030, n: 18, note: '3y', ref: 'aaqd2030' },
      { v: 100, kind: 'who', stat: 'p99', ref: 'who2021' },
    ],
    '1h': [
      { v: 180, kind: 'info', ref: 'aaqd2008' },
      { v: 240, kind: 'alert', ref: 'aaqd2008' },
    ],
    season: [{ v: 60, kind: 'who', ref: 'who2021' }],
  },
};

/*
 * The lines to draw on a chart: the thresholds of one pollutant and averaging period that apply in `year`
 * (default: the current UTC year), each with a localised label, e.g. "EU granična vrijednost (od 2030.)".
 * `kinds` filters by kind. Returns [{v, kind, label, n, ref}], sorted by value.
 */
function thresholdLines(pollutant, avg = '1h', { year = new Date().getUTCFullYear(), kinds = null } = {}) {
  const list = ((THRESHOLDS[pollutant] || {})[avg]) || [];
  return list
    .filter((l) => (l.from == null || year >= l.from) && (l.to == null || year <= l.to) && (!kinds || kinds.includes(l.kind)))
    .map((l) => {
      const period = l.from != null ? t('model.thr.from', { y: l.from }) : l.to != null ? t('model.thr.to', { y: l.to }) : '';
      const label = t(`model.thr.${l.kind}`) + (l.n != null ? ' ' + t('model.thr.n', { n: l.n }) : '') + (period ? ` (${period})` : '');
      return { v: l.v, kind: l.kind, label, n: l.n ?? null, ref: l.ref };
    })
    .sort((a, b) => a.v - b.v);
}

// ------------------------------------------------------------------ air-quality index
/*
 * Band upper limits (µg/m³) of levels 1..5; level 6 is open above the last value. A value equal to a limit
 * belongs to the lower band. Colours are the published ones.
 *   EAQI_BANDS: revised European Air Quality Index, EEA / ETC HE Report 2024/17 (iszz-api §9.3), live on
 *               airindex.eea.europa.eu. Default in the app.
 *   EAQI_BANDS_ISZZ: the legacy bands the Croatian portal still uses (iszz-api §9.3: 190/190 normalised
 *               values at station 155 match them; ISZZ applies the PM bands to 24-h running means).
 * CO and benzene are not part of either index: eaqi() returns level 0 ("not in the index") for them, and the
 * UI colours them against their limit values instead (iszz-api §9.3 recommendation).
 */
const EAQI_BANDS = {
  scheme: 'eea2024',
  pm25: [5, 15, 50, 90, 140],
  pm10: [15, 45, 120, 195, 270],
  no2: [10, 25, 60, 100, 150],
  o3: [60, 100, 120, 160, 180],
  so2: [20, 40, 125, 190, 275],
  colors: ['#50F0E6', '#50CCAA', '#F0E641', '#FF5050', '#960032', '#7D2181'],
};
const EAQI_BANDS_ISZZ = {
  scheme: 'iszz',
  pm25: [10, 20, 25, 50, 75],
  pm10: [20, 40, 50, 100, 150],
  no2: [40, 90, 120, 230, 340],
  o3: [50, 100, 130, 240, 380],
  so2: [100, 200, 350, 500, 750],
  colors: ['#55EFE5', '#54CAAA', '#EFE558', '#FE5355', '#940D36', '#7D2181'],
};
const CHEM_NO_DATA_COLOR = '#6F6F6F';   // ISZZ "no data" grey (iszz-api §9.3)

/*
 * Index level of one concentration: {level 1..6, key, label, color, scheme, avg}. level 0 = no data or a
 * pollutant outside the index. `avg` is passed through for the caller (the EEA 2024 table is given for
 * hourly values; ISZZ evaluates PM on 24-h running means); it does not change the band limits.
 */
function eaqi(pollutant, value, avg = '1h', scheme = 'eea2024') {
  const B = scheme === 'iszz' ? EAQI_BANDS_ISZZ : EAQI_BANDS;
  const lim = B[pollutant];
  if (!lim || !Number.isFinite(value)) {
    const key = lim ? 'model.eaqi.0' : 'model.eaqi.na';
    return { level: 0, key, label: t(key), color: CHEM_NO_DATA_COLOR, scheme: B.scheme, avg };
  }
  let level = 1;
  while (level <= lim.length && value > lim[level - 1]) level++;
  const key = `model.eaqi.${level}`;
  return { level, key, label: t(key), color: B.colors[level - 1], scheme: B.scheme, avg };
}

// ------------------------------------------------------------------ strings (hr, en)
I18N.add({
  hr: {
    'model.eaqi.0': 'nema podataka', 'model.eaqi.na': 'nije u indeksu',
    'model.eaqi.1': 'dobro', 'model.eaqi.2': 'prihvatljivo', 'model.eaqi.3': 'umjereno',
    'model.eaqi.4': 'loše', 'model.eaqi.5': 'vrlo loše', 'model.eaqi.6': 'izuzetno loše',
    'model.eaqi.scheme.eea2024': 'Europski indeks kvalitete zraka (EEA 2024)',
    'model.eaqi.scheme.iszz': 'indeks ISZZ (stare granice EEA)',
    'model.thr.limit': 'granična vrijednost', 'model.thr.target': 'ciljna vrijednost',
    'model.thr.info': 'prag obavješćivanja', 'model.thr.alert': 'prag upozorenja', 'model.thr.who': 'smjernica SZO',
    'model.thr.from': 'od {y}.', 'model.thr.to': 'do {y}.', 'model.thr.n': '(dopušteno {n}× godišnje)',
    'model.chem.note': 'NO₂ iz NOx: kemija NO–NO₂–O₃ s konačnim vremenom reakcije, pozadinski O₃ sa ZAGREB-4',
  },
  en: {
    'model.eaqi.0': 'no data', 'model.eaqi.na': 'not in the index',
    'model.eaqi.1': 'good', 'model.eaqi.2': 'fair', 'model.eaqi.3': 'moderate',
    'model.eaqi.4': 'poor', 'model.eaqi.5': 'very poor', 'model.eaqi.6': 'extremely poor',
    'model.eaqi.scheme.eea2024': 'European Air Quality Index (EEA 2024)',
    'model.eaqi.scheme.iszz': 'ISZZ index (legacy EEA bands)',
    'model.thr.limit': 'limit value', 'model.thr.target': 'target value',
    'model.thr.info': 'information threshold', 'model.thr.alert': 'alert threshold', 'model.thr.who': 'WHO guideline',
    'model.thr.from': 'from {y}', 'model.thr.to': 'until {y}', 'model.thr.n': '({n} exceedances allowed per year)',
    'model.chem.note': 'NO₂ from NOx: finite-reaction-time NO–NO₂–O₃ chemistry, background O₃ from ZAGREB-4',
  },
});
