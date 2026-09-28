// ------------------------------------------------------------------ meteo
/*
 * Pure meteorology for the receptor model and the GPU scalar solver [owner: models].
 * No THREE, no DOM. The only user-visible strings (direction, Beaufort and stability names) go through t().
 * Every formula is mirrored line by line in tools/aqmodel.py; tests/python/fixtures/parity_vectors.json
 * holds the Python outputs and src/js/tests/models.test.js checks this file against them to 1e-6.
 *
 * Conventions (docs/architecture.md §2):
 *   - directions are meteorological "from" bearings in degrees clockwise from north;
 *   - times are UTC epoch ms (or Date) marking the END of the averaging hour (ISZZ convention);
 *   - wind speeds are the 10 m reference wind U10 of ECMWF IFS (critic §1.1), m/s.
 *
 * Contents:
 *   DIRS16, dirIndex16, dirName, beaufort                  directions and names
 *   solarElevation                                         NOAA solar position
 *   stabilityClass, stabilityGroup                         SRDT (day) + Turner (night), physics §6.4
 *   obukhovLength                                          Golder (1972), physics Eq. 6.6
 *   mixingHeight                                           lid with urban floor, physics §6.5
 *   uEff, directionWeights                                 low-wind floor and direction kernel, physics §2.4, §10.2
 *   MOST (psiM, phiH, ustarHat, uHat, kHatMO), turbParams  what the scalar solver consumes, physics §4.2, §6.2
 *   jNO2, kNOO3                                            chemistry rate coefficients, physics Eqs. 8.4, 8.5
 *   vectorMeanWind                                         hour-ending averaging of instantaneous wind
 *   met_localParts                                         Europe/Zagreb calendar of the hour START (shared with emissions.js)
 */

// ------------------------------------------------------------------ directions
// The 16 run directions of the flow/scalar sweep (SITE.model_defaults.dirs = 16, spacing 22.5°).
const DIRS16 = Array.from({ length: 16 }, (_, i) => i * 22.5);

// Index 0..15 of the nearest of the 16 directions (0 = N, 4 = E, 8 = S, 12 = W). NaN gives 0.
function dirIndex16(deg) {
  if (!Number.isFinite(deg)) return 0;
  return Math.round(wrap360(deg) / 22.5) % 16;
}

// Localised name of a bearing on the 16-point rose: {short: "SI" | "NE", text: "sa sjeveroistoka" | "from the northeast"}.
// Croatian uses "sa" before s-, z-, š-, ž- words and "s" otherwise (as in the reference app's dirName).
function dirName(deg) {
  const i = dirIndex16(deg);
  return { short: t(`model.dir16.${i}`), text: t(`model.dirfrom16.${i}`) };
}

// Beaufort number and name from a 10 m wind speed in m/s. Upper limits of forces 0..11 are the WMO
// Beaufort scale (WMO-No. 306 / Manual on Codes), the same list as the reference app's beaufort().
const MET_BEAUFORT = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
function beaufort(v) {
  let b = 0;
  while (b < MET_BEAUFORT.length && v >= MET_BEAUFORT[b]) b++;
  return { b, name: t(`model.bft.${b}`) };
}

// ------------------------------------------------------------------ local calendar (Europe/Zagreb)
/*
 * The traffic and heating profiles are indexed by the LOCAL hour START (architecture §2): take the
 * hour-ending UTC stamp, subtract one hour, convert to Europe/Zagreb. The EU summer-time rule is coded
 * explicitly (Directive 2000/84/EC: CEST = UTC+2 from 01:00 UTC on the last Sunday of March to 01:00 UTC
 * on the last Sunday of October, CET = UTC+1 otherwise) so that the JS and the Python mirror agree to the
 * hour without depending on the platform's time-zone database.
 * Returns {year, month (1..12), day, hour (0..23), dow (0 = Monday .. 6 = Sunday), offset (h)}.
 */
function met_lastSundayUTC(year, month0) {
  const last = new Date(Date.UTC(year, month0 + 1, 0, 1, 0, 0));   // last day of the month, 01:00 UTC
  return last.getTime() - last.getUTCDay() * 86400e3;              // getUTCDay: 0 = Sunday
}
function met_localParts(dateUTC, hourStart = true) {
  const ms = +dateUTC - (hourStart ? 3600e3 : 0);
  const y = new Date(ms).getUTCFullYear();
  const dst = ms >= met_lastSundayUTC(y, 2) && ms < met_lastSundayUTC(y, 9);
  const offset = dst ? 2 : 1;
  const d = new Date(ms + offset * 3600e3);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(),
    dow: (d.getUTCDay() + 6) % 7, offset };
}

// ------------------------------------------------------------------ sun
/*
 * Solar elevation angle in degrees (no refraction), from the NOAA Global Monitoring Laboratory "General
 * Solar Position Calculations" (Fourier series of Spencer 1971 for the equation of time and declination).
 * Accuracy is about 0.2°, far better than the hourly resolution needs. For an hour-ending stamp, pass the
 * hour mid-point (t - 30 min) when a representative elevation for the hour is wanted.
 */
function solarElevation(dateUTC, lat = SITE.station.lat, lon = SITE.station.lon) {
  const ms = +dateUTC;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const doy = Math.floor((ms - Date.UTC(y, 0, 1)) / 86400e3) + 1;
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const g = (2 * Math.PI / (leap ? 366 : 365)) * (doy - 1 + (hour - 12) / 24);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));                        // minutes
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g); // radians
  const tst = hour * 60 + eqtime + 4 * lon;                                             // true solar time, minutes
  const ha = (tst / 4 - 180) * DEG;                                                     // hour angle
  const cz = Math.sin(lat * DEG) * Math.sin(decl) + Math.cos(lat * DEG) * Math.cos(decl) * Math.cos(ha);
  return 90 - Math.acos(clamp(cz, -1, 1)) / DEG;
}

/*
 * Global horizontal irradiance estimate [W/m²] when no radiation value is available (manual scenarios):
 * Holtslag & van Ulden (1983, J. Clim. Appl. Meteorol. 22, 517), K = (a1 sin φ + a2)(1 + b1 N^b2) with
 * a1 = 990 W/m², a2 = -30 W/m², b1 = -0.75, b2 = 3.4, φ the solar elevation and N the cloud fraction 0..1.
 */
function met_shortwaveEstimate(elevDeg, cloudPct) {
  if (!(elevDeg > 0)) return 0;
  const N = clamp((Number.isFinite(cloudPct) ? cloudPct : 50) / 100, 0, 1);
  return Math.max(0, (990 * Math.sin(elevDeg * DEG) - 30) * (1 - 0.75 * Math.pow(N, 3.4)));
}

// ------------------------------------------------------------------ stability
/*
 * Pasquill–Gifford class 'A'..'F' from routine hourly data (physics §6.4, verified against EPA-454/R-99-005):
 *   day   (G > 0): US EPA solar-radiation / delta-T method (SRDT), Table 6-7: rows by global radiation G,
 *                  columns by U10 (< 2, 2–3, 3–5, 5–6, >= 6 m/s);
 *   night (G = 0): Turner (1964) net-radiation index from total cloud cover (EPA Tables 6-4/6-6), columns by
 *                  U10 (< 1.9, 1.9–3.4, 3.4–5.5, >= 5.5 m/s); class G is merged into F as EPA does;
 *                  overcast (10/10) gives D. Open-Meteo reports cloud in %, and our hour averages of two
 *                  instantaneous values rarely hit exactly 100, so ">= 95 %" (10/10 when rounded to tenths)
 *                  counts as overcast.
 * Inputs: {u10 [m/s], sw [W/m², hour-average global radiation, Open-Meteo shortwave_radiation],
 *          cloud [% total cover], dateUTC [hour-ending]}. When sw is missing, day/night comes from the solar
 * elevation at the hour mid-point and G from met_shortwaveEstimate(). Missing wind gives D (neutral); missing
 * cloud at night is treated as index -1 (cloud > 4/10), the less extreme of the two Turner rows.
 */
const MET_SRDT = ['AABCC', 'ABBCD', 'BCCDD', 'DDDDD'];   // rows: G >= 925, 675–925, 175–675, < 175 W/m²
const MET_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F'];
function stabilityClass({ u10, sw, cloud, dateUTC } = {}) {
  if (!Number.isFinite(u10)) return 'D';
  let G = sw;
  if (!Number.isFinite(G)) {
    G = dateUTC === undefined ? 0 : met_shortwaveEstimate(solarElevation(+dateUTC - 1800e3), cloud);
  }
  if (G > 0) {
    const row = G >= 925 ? 0 : G >= 675 ? 1 : G >= 175 ? 2 : 3;
    const col = u10 < 2 ? 0 : u10 < 3 ? 1 : u10 < 5 ? 2 : u10 < 6 ? 3 : 4;
    return MET_SRDT[row][col];
  }
  const cc = Number.isFinite(cloud) ? cloud : 50;
  if (cc >= 95) return 'D';
  if (cc > 40) return u10 < 1.9 ? 'F' : u10 < 3.4 ? 'E' : 'D';     // net radiation index -1
  return u10 < 3.4 ? 'F' : u10 < 5.5 ? 'E' : 'D';                  // index -2 (G merged into F)
}

// The three stability groups of the scalar solves and the LUT (SITE.model_defaults.stability_groups).
// A group passed in is returned unchanged.
function stabilityGroup(cls) {
  if (cls === 'AC' || cls === 'D' || cls === 'EF') return cls;
  return cls === 'A' || cls === 'B' || cls === 'C' ? 'AC' : cls === 'E' || cls === 'F' ? 'EF' : 'D';
}

/*
 * Representative class of each group: the most frequent class of the group in IFS 2025 (physics §6.4 table,
 * relabelled IFS per critic §1.1: A 3.5 %, B 17.5 %, C 9.4 %; E 3.4 %, F 25.9 %). One scalar solve per group
 * uses this class's Obukhov length and mixing height.
 */
const MET_GROUP_CLASS = { AC: 'B', D: 'D', EF: 'F' };
const met_class = (c) => (MET_GROUP_CLASS[c] || (MET_CLASSES.includes(c) ? c : 'D'));

/*
 * Obukhov length L [m] from the class and the roughness length (Golder 1972; physics Eq. 6.6):
 *   1/L = a + b log10(z0'),  z0' = min(z0, 0.5 m)  (the range of Golder's nomogram; without the cap class C
 *   turns slightly stable over central Zagreb, an extrapolation artefact, physics §6.4).
 * Coefficients (a, b): A (-0.096, 0.029), B (-0.037, 0.029), C (-0.002, 0.018), D (0, 0), E (0.004, -0.018),
 * F (0.035, -0.036). Neutral D returns Infinity. At z0' = 0.5 m: A -9.6, B -22, C -135, E 106, F 22 m
 * (re-computed in critic §1.13).
 */
const MET_GOLDER = { A: [-0.096, 0.029], B: [-0.037, 0.029], C: [-0.002, 0.018], D: [0, 0], E: [0.004, -0.018], F: [0.035, -0.036] };
function obukhovLength(cls, z0 = MD.z0_m) {
  const [a, b] = MET_GOLDER[met_class(cls)];
  const inv = a + b * Math.log10(Math.min(z0, 0.5));
  return Math.abs(inv) < 1e-12 ? Infinity : 1 / inv;
}

/*
 * Mixing height h_eff [m] (physics Eq. 6.7): h_eff = max(h_NWP, h_min).
 *   blh:  IFS boundary_layer_height [m], hour-averaged. When missing (manual scenarios) the 2025 IFS median
 *         of the class is used: A 1178, B 520, C 1060, D 135, E 278, F 30 m (physics §6.4, [data]).
 *   mode: 'auto' (default) floor = hMin ?? CAL.h_min ?? SITE h_min_m (100 m ≈ 7 H̄, physics §6.5);
 *         '100' / '315' floor at 100 m or the AERMOD urban nocturnal height for Zagreb, 315 m
 *         (z_iuc = 400 m (P/2e6)^(1/4), P ≈ 7.7e5, physics §6.5);
 *         'nwp' raw NWP value, floored only at 10 m, the lowest BLH IFS delivers here (physics §11.1,
 *         night values of 10–20 m), so that a lid always spans at least two 5 m cells.
 */
const MET_BLH_MEDIAN = { A: 1178, B: 520, C: 1060, D: 135, E: 278, F: 30 };
const MET_H_RAW_FLOOR = 10;
function mixingHeight({ cls = 'D', blh, mode = 'auto', hMin } = {}) {
  const base = Number.isFinite(blh) ? blh : MET_BLH_MEDIAN[met_class(cls)];
  const m = String(mode);
  const floor = m === 'nwp' ? MET_H_RAW_FLOOR : m === '315' ? 315 : m === '100' ? 100
    : (Number.isFinite(hMin) ? hMin : Number.isFinite(CAL && CAL.h_min) ? CAL.h_min : MD.h_min_m);
  return Math.max(base, floor);
}

// ------------------------------------------------------------------ wind speed and direction smoothing
/*
 * Effective speed with the low-wind floor (physics Eqs. 2.4–2.5): U_eff = sqrt(U10² + U0²). U0 lumps the
 * turbulence that does not scale with the wind (vehicle-induced turbulence, meander, heat island); it is
 * fitted by tools/calibrate.py (prior 1.4 m/s for IFS winds, critic §1.1) and read from CAL.
 */
const met_U0 = () => (CAL && Number.isFinite(CAL.U0) ? CAL.U0 : MD.U0);
function uEff(u10, U0 = met_U0()) {
  const u = Number.isFinite(u10) ? Math.max(0, u10) : 0;
  return Math.sqrt(u * u + U0 * U0);
}

/*
 * Weights of the precomputed run directions for one hour (physics Eq. 10.1, critic §4.4):
 *   w_j ∝ exp(-δ(θ, θ_j)² / (2 σθ²)),  σθ = min(60°, 22.5° · max(1, 2 m/s / U)),
 * δ the wrapped angular difference. σθ represents the hourly meander plus the direction error of the NWP
 * wind. For U < 0.5 m/s the direction is undefined and every direction gets the same weight (architecture
 * §6.1). Weights sum to 1. `dirs` defaults to DIRS16; a LUT with other directions can pass its own list.
 */
function directionWeights(fromDeg, u10, dirs = DIRS16) {
  const n = dirs.length, w = new Float32Array(n);
  if (!(u10 >= 0.5) || !Number.isFinite(fromDeg)) { w.fill(1 / n); return w; }
  const s = Math.min(60, 22.5 * Math.max(1, 2 / u10));
  const tmp = new Array(n);
  let sum = 0;
  for (let j = 0; j < n; j++) {
    const d = angDiff(fromDeg, dirs[j]);
    tmp[j] = Math.exp(-(d * d) / (2 * s * s));
    sum += tmp[j];
  }
  for (let j = 0; j < n; j++) w[j] = tmp[j] / sum;
  return w;
}

/*
 * Vector mean of wind observations {u [m/s], dir [° from]} (e.g. the instantaneous IFS values at t-1 and t
 * that make up an ISZZ hour-ending mean, critic §4.1 D7). Returns {u: vector-mean speed, dir, scalar: mean
 * speed, n}. Non-finite entries are skipped; an empty list gives NaN.
 */
function vectorMeanWind(list) {
  let ue = 0, vn = 0, s = 0, n = 0;
  for (const o of list || []) {
    if (!o || !Number.isFinite(o.u) || !Number.isFinite(o.dir)) continue;
    ue += -o.u * Math.sin(o.dir * DEG);      // toward-east component
    vn += -o.u * Math.cos(o.dir * DEG);      // toward-north component
    s += o.u; n++;
  }
  if (!n) return { u: NaN, dir: NaN, scalar: NaN, n: 0 };
  ue /= n; vn /= n;
  return { u: Math.hypot(ue, vn), dir: wrap360(Math.atan2(-ue, -vn) / DEG), scalar: s / n, n };
}

// ------------------------------------------------------------------ Monin–Obukhov similarity (MOST)
/*
 * Surface-layer functions shared by turbParams(), the CPU fallback and any CPU reference of the GPU
 * K-prep pass. Kept in one namespace object so that no other file's top-level names can collide.
 *   psiM(ζ): Paulson (1970) for ζ < 0, -5ζ for ζ >= 0 with ζ capped at 1 (physics Eq. 6.4);
 *   phiH(ζ): Businger–Dyer, (1 - 16ζ)^(-1/2) for ζ < 0, 1 + 5ζ for 0 <= ζ <= 1, capped at ζ = 1 (Eq. 4.3);
 *   ustarHat(L, z0, d, z0r, zb, kappa): u_* / U10 over the city from blending-height matching at z_b between the
 *     NWP grid box (roughness z0r at 10 m) and the urban surface (z0, d) (physics Eqs. 6.2–6.3; neutral
 *     z0r 0.3, zb 80, d 8, z0 1.4 gives 0.162, critic §1.13);
 *   uHat(z, turb): log-law wind above the canopy as a fraction of U10 (Eq. 6.5, z >= H̄; below H̄ the value at
 *     H̄ is returned, the canopy decay belongs to the flow owner's inflowProfile);
 *   kHatMO(z, turb): approach-flow eddy diffusivity K̂_MO = K/U10 [m] (Eq. 4.2), held constant below H̄ and
 *     zero at and above h_eff.
 */
const MOST = {
  psiM(zeta) {
    if (zeta < 0) {
      const x = Math.pow(1 - 16 * zeta, 0.25);
      return 2 * Math.log((1 + x) / 2) + Math.log((1 + x * x) / 2) - 2 * Math.atan(x) + Math.PI / 2;
    }
    return -5 * Math.min(zeta, 1);
  },
  phiH(zeta) {
    return zeta < 0 ? 1 / Math.sqrt(1 - 16 * zeta) : 1 + 5 * Math.min(zeta, 1);
  },
  ustarHat(L, z0 = MD.z0_m, d = MD.d_m, z0r = MD.z0r_m, zb = MD.zb_m, kappa = MD.kappa) {
    const iL = Number.isFinite(L) && L !== 0 ? 1 / L : 0;
    const P = MOST.psiM;
    const usr = kappa / (Math.log(10 / z0r) - P(10 * iL) + P(z0r * iL));
    const ub = (usr / kappa) * (Math.log(zb / z0r) - P(zb * iL) + P(z0r * iL));
    return kappa * ub / (Math.log((zb - d) / z0) - P((zb - d) * iL) + P(z0 * iL));
  },
  uHat(z, turb) {
    const zz = Math.max(z, turb.Hbar, turb.d + 2 * turb.z0);
    const iL = turb.invL || 0, P = MOST.psiM;
    return (turb.ustar_hat / turb.kappa) * (Math.log((zz - turb.d) / turb.z0) - P((zz - turb.d) * iL) + P(turb.z0 * iL));
  },
  kHatMO(z, turb) {
    const ze = Math.max(z, turb.Hbar);
    if (ze >= turb.h_eff) return 0;
    const zh = ze - turb.d;
    const lid = 1 - ze / turb.h_eff;
    return turb.kappa * turb.ustar_hat * zh / MOST.phiH(zh * (turb.invL || 0)) * lid * lid;
  },
};

/*
 * turbParams(cls, {z0, d, Hbar, h_eff}) → turb: the stability description the GPU scalar solver takes
 * (architecture §5.3, §6.2). `cls` is a class 'A'..'F' or a group 'AC' | 'D' | 'EF' (a group uses its
 * representative class, MET_GROUP_CLASS). All lengths in metres; "hat" quantities are normalised by U10, so
 * K̂ = K/U10 has units of metres and the solve is done once for U10 = 1 m/s (physics §2.4).
 *
 *   cls        P-G class used (after mapping a group to its representative class)
 *   group      'AC' | 'D' | 'EF'
 *   L          Obukhov length [m], Golder (1972) at z0' = min(z0, 0.5 m); Infinity for neutral D
 *   invL       1/L [1/m], 0 for neutral: use this in shaders (ζ = ẑ·invL) to avoid Infinity
 *   ustar_hat  u_* / U10 [-], friction velocity over the city from blending-height matching (physics Eq. 6.3)
 *   h_eff      mixing height [m]; K̂_MO ∝ (1 - z/h_eff)² and a no-flux lid where h_eff lies inside the domain
 *   z0, d      urban roughness length and displacement height [m] (defaults SITE 1.5 / 7 m, critic §1.10)
 *   Hbar       mean building height [m]; K̂_MO is held constant below it; ẑ = max(z, Hbar) - d
 *   Sct        turbulent Schmidt number [-] dividing the mixing-length part ℓm²|Ŝ| (Eq. 4.1), 0.7
 *   lambda     Blackadar asymptotic mixing length λ [m] in ℓm = (1/(κ d_w) + 1/λ)^-1 (Eq. 4.4), 30 m
 *   kmin       floor on the total K̂ [m] (numerical floor, physics §12.2), 0.02 m
 *   kappa      von Kármán constant, 0.40
 *   z0r, zb    NWP-box roughness and blending height used for ustar_hat [m] (0.3 m, 80 m, physics §6.2)
 *
 * Closure the solver implements with these (physics Eq. 4.1):
 *   K̂(x) = max( kappa·ustar_hat·ẑ / phiH(ẑ·invL) · (1 - z'/h_eff)², ℓm²|Ŝ|/Sct ),  K̂ >= kmin,
 * with z' = max(z, Hbar) and ẑ = z' - d; MOST.kHatMO(z, turb) is the CPU reference of the first term.
 */
function turbParams(cls, { z0, d, Hbar, h_eff } = {}) {
  const c = met_class(cls);
  const zz0 = Number.isFinite(z0) ? z0 : MD.z0_m;
  const dd = Number.isFinite(d) ? d : MD.d_m;
  const H = Number.isFinite(Hbar) ? Hbar : MD.Hbar_m;
  const L = obukhovLength(c, zz0);
  return {
    cls: c, group: stabilityGroup(c), L, invL: Number.isFinite(L) ? 1 / L : 0,
    ustar_hat: MOST.ustarHat(L, zz0, dd, MD.z0r_m, MD.zb_m, MD.kappa),
    h_eff: Number.isFinite(h_eff) ? h_eff : mixingHeight({ cls: c }),
    z0: zz0, d: dd, Hbar: H, Sct: MD.Sct, lambda: MD.lambda_m, kmin: MD.kmin_m, kappa: MD.kappa,
    z0r: MD.z0r_m, zb: MD.zb_m,
  };
}

// ------------------------------------------------------------------ chemistry rate coefficients
/*
 * NO2 photolysis frequency [1/s] from global irradiance G [W/m²] (Trebs et al. 2009, AMT 2, 725; physics
 * Eq. 8.4, verified): J = (1 + α)(B1 G + B2 G²), B1 = 1.47e-5, B2 = -4.84e-9 W⁻² m⁴ s⁻¹, α = 0.05 (UV-A surface
 * albedo). Valid below 800 m a.s.l.; 8.7e-3 1/s at 800 W/m² without α (critic §1.13). Negative results
 * (G beyond the fit range) are clipped to 0.
 */
function jNO2(sw) {
  const G = Number.isFinite(sw) ? Math.max(0, sw) : 0;
  return Math.max(0, 1.05 * (1.47e-5 * G - 4.84e-9 * G * G));
}

/*
 * NO + O3 → NO2 + O2 rate coefficient in ppb⁻¹ s⁻¹ (JPL evaluation, physics Eq. 8.5):
 *   k = 3.0e-12 exp(-1500/T) cm³ molec⁻¹ s⁻¹, × n_air·1e-9 with n_air = 7.2429e18 · p[hPa] / T molec cm⁻³
 * (7.2429e18 = 1e2 Pa/hPa · 1e-6 m³/cm³ / k_B). 4.19e-4 ppb⁻¹ s⁻¹ at 15 °C and 1013.25 hPa (critic §1.13).
 * The station is at 116 m a.s.l., so the standard pressure is used unless given.
 */
function kNOO3(tempC, pHPa = 1013.25) {
  const T = (Number.isFinite(tempC) ? tempC : 15) + 273.15;
  return 3.0e-12 * Math.exp(-1500 / T) * (7.2429e18 * pHPa / T) * 1e-9;
}

// ------------------------------------------------------------------ strings (hr, en)
I18N.add({
  hr: {
    ...Object.fromEntries(['S', 'SSI', 'SI', 'ISI', 'I', 'IJI', 'JI', 'JJI', 'J', 'JJZ', 'JZ', 'ZJZ', 'Z', 'ZSZ', 'SZ', 'SSZ']
      .map((s, i) => [`model.dir16.${i}`, s])),
    ...Object.fromEntries(['sa sjevera', 'sa sjever-sjeveroistoka', 'sa sjeveroistoka', 's istok-sjeveroistoka', 's istoka',
      's istok-jugoistoka', 's jugoistoka', 's jug-jugoistoka', 's juga', 's jug-jugozapada', 's jugozapada',
      'sa zapad-jugozapada', 'sa zapada', 'sa zapad-sjeverozapada', 'sa sjeverozapada', 'sa sjever-sjeverozapada']
      .map((s, i) => [`model.dirfrom16.${i}`, s])),
    ...Object.fromEntries(['tišina', 'lahor', 'povjetarac', 'slab vjetar', 'umjeren vjetar', 'umjereno jak vjetar', 'jak vjetar',
      'žestok vjetar', 'olujni vjetar', 'jak olujni vjetar', 'žestok olujni vjetar', 'orkanski vjetar', 'orkan']
      .map((s, i) => [`model.bft.${i}`, s])),
    'model.stab.A': 'A – vrlo nestabilno', 'model.stab.B': 'B – umjereno nestabilno', 'model.stab.C': 'C – slabo nestabilno',
    'model.stab.D': 'D – neutralno', 'model.stab.E': 'E – slabo stabilno', 'model.stab.F': 'F – stabilno',
    'model.stabgrp.AC': 'nestabilno (A–C)', 'model.stabgrp.D': 'neutralno (D)', 'model.stabgrp.EF': 'stabilno (E–F)',
    'model.calm': 'tišina (smjer nedefiniran)',
  },
  en: {
    ...Object.fromEntries(['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
      .map((s, i) => [`model.dir16.${i}`, s])),
    ...Object.fromEntries(['from the north', 'from north-northeast', 'from the northeast', 'from east-northeast', 'from the east',
      'from east-southeast', 'from the southeast', 'from south-southeast', 'from the south', 'from south-southwest',
      'from the southwest', 'from west-southwest', 'from the west', 'from west-northwest', 'from the northwest',
      'from north-northwest'].map((s, i) => [`model.dirfrom16.${i}`, s])),
    ...Object.fromEntries(['calm', 'light air', 'light breeze', 'gentle breeze', 'moderate breeze', 'fresh breeze', 'strong breeze',
      'near gale', 'gale', 'strong gale', 'storm', 'violent storm', 'hurricane force']
      .map((s, i) => [`model.bft.${i}`, s])),
    'model.stab.A': 'A – very unstable', 'model.stab.B': 'B – moderately unstable', 'model.stab.C': 'C – slightly unstable',
    'model.stab.D': 'D – neutral', 'model.stab.E': 'E – slightly stable', 'model.stab.F': 'F – stable',
    'model.stabgrp.AC': 'unstable (A–C)', 'model.stabgrp.D': 'neutral (D)', 'model.stabgrp.EF': 'stable (E–F)',
    'model.calm': 'calm (direction undefined)',
  },
});
