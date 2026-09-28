// ------------------------------------------------------------------ model
/*
 * The receptor model that turns unit responses into concentrations [owner: models]. Pure: no THREE, no DOM.
 * This is the one place where flow/dispersion (Γ, A), emissions (q_k), background and chemistry meet, for the
 * station receptor (concentrations) and for map slices (cellValue). Physics §2.4, §5.6, §5.8, §10.2.
 *
 *   ReceptorModel      Γ and A at the receptor for an hour: LUT (tools/export_lut.py) → live ScalarField
 *                      overrides per direction → CPU FallbackModel when neither exists; direction-smoothed
 *   increment          ΔC = 1e6 β Σ q_k Γ_k / U_eff and the plume age τ
 *   concentrations     background + increment for every pollutant, NO2 through chemistry (what the UI calls)
 *   sliceContext, cellValue    the same arithmetic per cell of a slice
 *   metrics, mqi       Chang & Hanna (2004) statistics and the FAIRMODE MQI (mirrored in tools/aqmodel.py)
 *   mod_calFor         which β/U0 applies to which source (calibration.json, architecture §4.3)
 */

// ------------------------------------------------------------------ calibration per source
/*
 * β and U0 for results from `source` ('lut' | 'field' | 'fallback'), read from calibration.json:
 *   fallback → cal.gauss (the Gaussian fallback's own fit; with status "fallback-only" also the top level);
 *   lut/field → the top level when model === 'lbm' and status === 'calibrated';
 *   anything else → the priors β = SITE beta_prior (1.0), U0 = SITE U0 (1.4 m/s), status 'uncalibrated'.
 * calibrated = false gives the "raw physics" priors with status 'raw' (the UI toggle, critic §4.8).
 * The 3D fit belongs to one LUT grid (calibration.json lbm.lut_meta.grid; Γ changes up to 3× between the 10 m and
 * 5 m grids, docs/03 §8.2): when the LUT in use (`lut`, default the embedded LUT) is on another grid, the fit is not
 * applied and the priors are returned as 'uncalibrated' (review 2026-09-28: a re-exported LUT used to inherit the old
 * grid's β silently until tools/calibrate.py was re-run).
 * Returns {beta, U0, fNO2, status, model}.
 */
function mod_calFor(source, cal = CAL, calibrated = true, lut = typeof LUT !== 'undefined' ? LUT : null) {
  const c = cal || {};
  const fin = Number.isFinite;
  const fNO2 = fin(c.f_no2) ? c.f_no2 : MD.f_no2;
  const model = source === 'fallback' ? 'gauss' : 'lbm';
  const prior = { beta: MD.beta_prior, U0: MD.U0, fNO2, status: calibrated ? 'uncalibrated' : 'raw', model };
  if (!calibrated) return prior;
  if (source === 'fallback') {
    const g = c.gauss && fin(c.gauss.beta) ? c.gauss : (c.model === 'gauss' && fin(c.beta) ? c : null);
    if (!g) return prior;
    return { beta: g.beta, U0: fin(g.U0) ? g.U0 : fin(c.U0) ? c.U0 : MD.U0, fNO2, status: 'calibrated', model };
  }
  if (c.model === 'lbm' && c.status === 'calibrated' && fin(c.beta)) {
    const calGrid = c.lbm && c.lbm.lut_meta && c.lbm.lut_meta.grid, lutGrid = lut && lut.meta && lut.meta.grid;
    if (calGrid && lutGrid && calGrid !== lutGrid) return prior;
    return { beta: c.beta, U0: fin(c.U0) ? c.U0 : MD.U0, fNO2, status: 'calibrated', model };
  }
  return prior;
}

// ------------------------------------------------------------------ receptor unit responses
/*
 * ReceptorModel({lut, fallback, cal, env}): Γ_k and A_k at the station inlet for one hour.
 *
 * gammaAt(dirDeg, u10, cls, scenario = 'today') → {gamma:[4], age:[4], band:[[lo,hi]×4] | null, queue:[4] | null,
 *   source, coverage, parts, group}. Per run direction j (DIRS16, or the LUT's dirs) with kernel weight w_j
 *   (directionWeights, physics Eq. 10.1) the response is taken from, in order:
 *     1. a live field set for (scenario, j, group) with setField();
 *     2. for another scenario, a live 'today' field for (j, group), else
 *     3. the LUT (today's geometry), else
 *     4. FallbackModel.receptor(dir_j, cls) (built lazily from ENV).
 *   `source` is the source with the largest weight; `coverage` the weight share that came from fields of the
 *   requested scenario itself (so the UI can say "scenario not computed yet"); `parts` keeps the weighted
 *   sums per source, because each source has its own calibration (mod_calFor).
 *   `cls` may be a class 'A'..'F' (the fallback then uses that class's own σ curves) or a group.
 *
 * Grid consistency (integration rule, 2026-09-28; requested in the flow owner's report, docs/03-flow-lbm.md §9).
 * The receptor response depends strongly on the cell size (Γ_B at 5 m is 0.58× the 10 m value, heating 0.33×),
 * and β is fitted on the LUT's grid (calibrate.py). A live field is therefore used as it is only when its grid
 * equals LUT.meta.grid, or when either grid is unknown, or when there is no LUT. On another grid (a laptop GPU
 * runs 5 m while the committed LUT is 10 m):
 *   - a 'today' field never replaces the LUT (the today view stays on the calibrated table);
 *   - a scenario field is transferred onto the LUT as a relative change against the 'today' field of the same
 *     grid, direction and group (the "delta method" of mod_deltaOnLut); without that 'today' field the
 *     scenario field is used as it is, and coverage still counts it.
 */
/*
 * mod_deltaOnLut(L, s, t) → {gamma, age, band}: a scenario's live receptor result `s` carried onto the LUT's grid
 * through the 'today' result `t` of the same grid, direction and group (grid-consistency rule above). Per group k:
 *   Γ_k = L_k · s_k / t_k                     when t_k carries a real share of today's response here
 *                                             (t_k ≥ MOD_DELTA_SHARE · max_k t_k): the scenario's relative change;
 *   Γ_k = max(0, L_k + (s_k − t_k) · ΣL / Σt)  otherwise (a group that barely reaches the receptor today, e.g. an
 *                                             upwind road): the scenario's absolute change, scaled to the LUT's grid
 *                                             by the ratio of the total responses.
 * The age A_k is carried over the same way; the band is L's band scaled by Γ_k / L_k. The 5 % share is a
 * numerical guard against dividing by a near-zero response (design choice, not a physical constant).
 */
const MOD_DELTA_SHARE = 0.05;
function mod_deltaOnLut(L, s, t) {
  const move = (Lv, sv, tv) => {
    const sumL = Lv.reduce((a, v) => a + (v || 0), 0), sumT = tv.reduce((a, v) => a + (v || 0), 0);
    const scale = sumT > 0 ? sumL / sumT : 1, big = Math.max(0, ...tv.map((v) => v || 0));
    return Lv.map((lk, k) => {
      const l = lk || 0, sk = sv[k] || 0, tk = tv[k] || 0;
      return tk > 0 && tk >= MOD_DELTA_SHARE * big ? (l * sk) / tk : Math.max(0, l + (sk - tk) * scale);
    });
  };
  const gamma = move(L.gamma, s.gamma, t.gamma), age = move(L.age, s.age, t.age);
  const band = L.band ? L.band.map((b, k) => (L.gamma[k] > 0 ? [(b[0] * gamma[k]) / L.gamma[k], (b[1] * gamma[k]) / L.gamma[k]] : [gamma[k], gamma[k]])) : null;
  return { gamma, age, band, grid: null };
}

class ReceptorModel {
  constructor({ lut = LUT, fallback = null, cal = CAL, env = ENV } = {}) {
    this.lut = lut && Array.isArray(lut.gamma) && Array.isArray(lut.classes) ? lut : null;
    this.dirs = this.lut && Array.isArray(this.lut.dirs) && this.lut.dirs.length ? this.lut.dirs : DIRS16;
    this.fallback = fallback;
    this.env = env;
    this.cal = cal;
    this.fields = new Map();
  }

  // The process-wide default model (LUT, CAL and ENV as embedded in the page).
  static shared() {
    if (!ReceptorModel._shared) ReceptorModel._shared = new ReceptorModel();
    return ReceptorModel._shared;
  }

  get fallbackModel() {
    if (!this.fallback && typeof FallbackModel !== 'undefined') this.fallback = new FallbackModel(this.env);
    return this.fallback;
  }

  /*
   * Register (or with field = null remove) a live result for (scenario, direction index 0..15, group).
   * `field` is a ScalarField (its receptor() is sampled at RECEPTOR) or a plain {gamma:[4], age:[4], band?, grid?}.
   * The grid id ('120x120x32@5m', tunnelGrid().id) comes from field.grid or field.T.id; it decides whether the
   * field may stand in for the LUT (see the grid-consistency rule above).
   */
  setField(scenario, dirIdx, stabGroup, field) {
    const key = `${scenario}|${dirIdx}|${stabilityGroup(stabGroup)}`;
    if (!field) { this.fields.delete(key); return; }
    const r = typeof field.receptor === 'function' ? field.receptor() : field;
    if (!r || !r.gamma || !r.age) return;
    const grid = (typeof field.grid === 'string' && field.grid) || (field.T && field.T.id) || (typeof r.grid === 'string' && r.grid) || null;
    this.fields.set(key, { gamma: Array.from(r.gamma), age: Array.from(r.age), band: r.band || null, grid });
  }
  // The LUT's grid id (architecture §4.4 meta.grid), or null when unknown.
  get lutGrid() { return this.lut && this.lut.meta && typeof this.lut.meta.grid === 'string' ? this.lut.meta.grid : null; }
  // True when a live result may be used as it is next to the LUT (same grid, or a grid is unknown, or no LUT).
  _sameGrid(r) { const g = this.lutGrid; return !this.lut || !g || !r.grid || r.grid === g; }
  clearFields(scenario = null) {
    for (const k of [...this.fields.keys()]) if (scenario === null || k.startsWith(scenario + '|')) this.fields.delete(k);
  }
  hasField(scenario, dirIdx, stabGroup) { return this.fields.has(`${scenario}|${dirIdx}|${stabilityGroup(stabGroup)}`); }

  _lutAt(j, grp) {
    const L = this.lut, ci = L.classes.indexOf(grp);
    if (ci < 0 || !L.gamma[j] || !L.gamma[j][ci]) return null;
    const band = L.band && L.band[j] && L.band[j][ci] ? L.band[j][ci] : null;
    return { gamma: L.gamma[j][ci], age: (L.age && L.age[j] && L.age[j][ci]) || [0, 0, 0, 0], band };
  }

  gammaAt(dirDeg, u10, cls, scenario = 'today') {
    const grp = stabilityGroup(cls || 'D');
    const w = directionWeights(dirDeg, u10, this.dirs);
    const parts = {};
    const add = (src, wj, r) => {
      const P = parts[src] || (parts[src] = { source: src, weight: 0, gamma: [0, 0, 0, 0], age: [0, 0, 0, 0], band: null, queue: null });
      P.weight += wj;
      for (let k = 0; k < 4; k++) { P.gamma[k] += wj * (r.gamma[k] || 0); P.age[k] += wj * (r.age[k] || 0); }
      if (r.band) {
        P.band = P.band || [[0, 0], [0, 0], [0, 0], [0, 0]];
        for (let k = 0; k < 4; k++) { P.band[k][0] += wj * r.band[k][0]; P.band[k][1] += wj * r.band[k][1]; }
      }
      if (r.queue) { P.queue = P.queue || [0, 0, 0, 0]; for (let k = 0; k < 4; k++) P.queue[k] += wj * r.queue[k]; }
    };
    let own = 0;
    for (let j = 0; j < w.length; j++) {
      const wj = w[j];
      if (!(wj > 0)) continue;
      const L = this.lut ? this._lutAt(j, grp) : null;
      let r = this.fields.get(`${scenario}|${j}|${grp}`);
      if (r && (this._sameGrid(r) || !L)) { own += wj; add('field', wj, r); continue; }
      if (r) {                                   // a field on another grid than the LUT (see the rule above)
        const t0 = scenario === 'today' ? null : this.fields.get(`today|${j}|${grp}`);
        if (scenario !== 'today') {
          own += wj;
          add('field', wj, t0 && t0.grid === r.grid ? mod_deltaOnLut(L, r, t0) : r);
          continue;
        }
      }
      if (scenario !== 'today' && (r = this.fields.get(`today|${j}|${grp}`)) && (this._sameGrid(r) || !L)) { add('field', wj, r); continue; }
      if (L) { add('lut', wj, L); continue; }
      const fb = this.fallbackModel;
      if (fb) add('fallback', wj, fb.receptor(this.dirs[j], cls || grp));
    }
    const out = { gamma: [0, 0, 0, 0], age: [0, 0, 0, 0], band: null, queue: null, source: 'fallback', coverage: own, parts, group: grp };
    let best = -1;
    for (const P of Object.values(parts)) {
      for (let k = 0; k < 4; k++) { out.gamma[k] += P.gamma[k]; out.age[k] += P.age[k]; }
      if (P.weight > best) { best = P.weight; out.source = P.source; }
    }
    const all = Object.values(parts);
    if (all.length && all.every((P) => P.band)) {
      out.band = [0, 1, 2, 3].map((k) => [all.reduce((s, P) => s + P.band[k][0], 0), all.reduce((s, P) => s + P.band[k][1], 0)]);
    }
    if (parts.fallback && parts.fallback.queue) out.queue = parts.fallback.queue.slice();
    return out;
  }
}

// ------------------------------------------------------------------ increment
/*
 * Local increment at the receptor from unit responses and group strengths (physics Eqs. 2.5, 5.8):
 *   ΔC_k = 1e6 · β · q_k · Γ_k / U_eff   [µg/m³ when q is in g m⁻¹ s⁻¹ or g m⁻² s⁻¹],  U_eff = √(U10² + U0²)
 *   τ    = Σ_k q_k A_k / (U_eff Σ_k q_k Γ_k)   [s]   (CHEM_TAU_DEFAULT when there is no emission)
 * `cal` = {beta, U0} applies one calibration to everything. Without it, each part of gammaAge.parts (or the
 * whole, with gammaAge.source) gets mod_calFor(source); `calibrated = false` selects the raw-physics priors.
 * With several parts the age is the concentration-weighted mean, τ = Σ_p β_p Σ q A_p/U_p² ÷ Σ_p β_p Σ q Γ_p/U_p.
 * Returns {total, byGroup:[4], tau, beta, U0} (beta/U0 of the dominant part).
 */
function increment(gammaAge, strengths, u10, cal, calibrated = true) {
  const q = [strengths.A || 0, strengths.B || 0, strengths.C || 0, strengths.D || 0];
  const parts = cal || !gammaAge.parts || !Object.keys(gammaAge.parts).length
    ? [{ source: gammaAge.source || 'lut', weight: 1, gamma: gammaAge.gamma, age: gammaAge.age }]
    : Object.values(gammaAge.parts);
  const byGroup = [0, 0, 0, 0];
  let num = 0, den = 0, bestW = -1, beta = MD.beta_prior, U0 = MD.U0;
  for (const P of parts) {
    const c = cal || mod_calFor(P.source, CAL, calibrated);
    const U = uEff(u10, c.U0);
    for (let k = 0; k < 4; k++) {
      byGroup[k] += 1e6 * c.beta * q[k] * (P.gamma[k] || 0) / U;
      num += c.beta * q[k] * (P.age[k] || 0) / (U * U);
      den += c.beta * q[k] * (P.gamma[k] || 0) / U;
    }
    if (P.weight > bestW) { bestW = P.weight; beta = c.beta; U0 = c.U0; }
  }
  const total = byGroup[0] + byGroup[1] + byGroup[2] + byGroup[3];
  return { total, byGroup, tau: den > 0 ? num / den : CHEM_TAU_DEFAULT, beta, U0 };
}

// ------------------------------------------------------------------ background
/*
 * Background used when the caller has none (manual scenarios) or a value is missing: ZAGREB-4 2025 annual
 * means NOx 24.0, NO2 16.3, O3 54.0, PM10 25.6, PM2.5 15.7 µg/m³ (physics §7.9). ZAGREB-4 measures neither CO
 * nor benzene; their defaults are the ZAGREB-1 2025 means (CO 0.24 mg/m³, benzene 0.68 µg/m³, physics F3) minus
 * the mean local increment implied by the increment ratios (0.98 and 0.0071 × ΔNOx 46.1 µg/m³, physics §7.6,
 * critic §1.4): CO 0.19 mg/m³, benzene 0.35 µg/m³. A background with NO2 but no NOx (the CAMS forecast has no
 * usable NO, physics §11.4) gets NOx = 1.47 × NO2, the ZAGREB-4 2025 annual ratio 24.0/16.3.
 */
const MOD_BG_DEFAULT = { nox: 24.0, no2: 16.3, o3: 54.0, pm10: 25.6, pm25: 15.7, co: 0.19, c6h6: 0.35 };
const MOD_NOX_PER_NO2 = 24.0 / 16.3;
function mod_background(bg) {
  const b = bg || {};
  const out = { defaulted: [] };
  for (const k of Object.keys(MOD_BG_DEFAULT)) {
    if (Number.isFinite(b[k])) out[k] = b[k];
    else if (k === 'nox' && Number.isFinite(b.no2)) { out.nox = b.no2 * MOD_NOX_PER_NO2; out.defaulted.push('nox'); }
    else { out[k] = MOD_BG_DEFAULT[k]; out.defaulted.push(k); }
  }
  out.source = b.source || (out.defaulted.length === Object.keys(MOD_BG_DEFAULT).length ? 'default' : 'given');
  return out;
}

// ------------------------------------------------------------------ concentrations at the receptor
/*
 * Total concentrations for one receptor/hour: C = C_bg + ΔC (Lenschow et al. 2001; physics Eq. 2.2).
 *   met         {u10, dir (or wd), sw, cc (or cloud), t2 [°C], blh, cls?}: IFS hour-ending means; cls forces a class
 *   dateUTC     hour-ending time (Date or ms)
 *   measures    EM_MEASURES_TODAY-like scenario measures
 *   background  {nox, no2, o3, pm10, pm25 [µg/m³], co [mg/m³], c6h6 [µg/m³]} (ZAGREB-4 or bias-corrected CAMS)
 *   pollutant   'all' or one of POLLUTANTS / 'o3' / 'no'
 *   gammaAge    optional result of ReceptorModel.gammaAt(); computed with opts.receptorModel || shared() if absent
 *   opts        {scenario, heating (true | 'auto' | false), ef, heatingScale, calibrated (default true), cal {beta, U0},
 *                fNO2, receptorModel}
 * Returns µg/m³ (CO in mg/m³): {nox, no2, no, o3, pm10, pm25, co, c6h6,
 *   inc: {nox, no2, pm10, pm25, co, c6h6, tau}, byGroup: {pollutant: [A, B, C, D]}, bg, band, meta}.
 * NO2/NO/O3 come from no2Chemistry with the NOx increment, its plume age τ, J(NO2) from sw (or the clear-sky
 * estimate when sw is missing) and k(NO + O3) from t2. `band` is the increment range from the LUT/field
 * representativeness band (null for the fallback). `meta` records source, class, group, U_eff, β, U0 and status.
 */
function concentrations({ met = {}, dateUTC, measures = {}, background = null, pollutant = 'all', gammaAge = null, opts = {} } = {}) {
  const tms = +dateUTC;
  const u10 = met.u10, dir = met.dir !== undefined ? met.dir : met.wd;
  const cloud = met.cc !== undefined ? met.cc : met.cloud, t2 = met.t2;   // not met.t: the UI uses t for the time
  const cls = met.cls || opts.cls || stabilityClass({ u10, sw: met.sw, cloud, dateUTC: tms });
  const calibrated = opts.calibrated !== false;
  const ga = gammaAge || (opts.receptorModel || ReceptorModel.shared()).gammaAt(dir, u10, cls, opts.scenario || 'today');
  const bg = mod_background(background);
  const sw = Number.isFinite(met.sw) ? met.sw : met_shortwaveEstimate(solarElevation(tms - 1800e3), cloud);
  const J = jNO2(sw), k = kNOO3(t2);
  const cal0 = opts.cal || mod_calFor(ga.source, CAL, calibrated);
  const fNO2 = Number.isFinite(opts.fNO2) ? opts.fNO2 : cal0.fNO2 ?? MD.f_no2;
  // Congestion share per direction when the fallback knows it (EM_CONGESTION).
  let congestionShare = opts.congestionShare;
  if (!congestionShare && ga.queue && ga.gamma[0] > 0 && ga.gamma[1] > 0) {
    congestionShare = { A: ga.queue[0] / ga.gamma[0], B: ga.queue[1] / ga.gamma[1] };
  }
  const sOpts = { heating: opts.heating, ef: opts.ef, heatingScale: opts.heatingScale, congestionShare };
  const want = pollutant === 'all' ? ['nox', 'pm10', 'pm25', 'co', 'c6h6']
    : ['no2', 'no', 'o3', 'nox'].includes(pollutant) ? ['nox'] : [pollutant];
  const inc = {}, byGroup = {}, incs = {};
  for (const p of want) {
    const q = groupStrengths(p, tms, measures, sOpts);
    const r = increment(ga, q, u10, opts.cal, calibrated);
    incs[p] = { r, q };
    const scale = p === 'co' ? 1e-3 : 1;                      // CO: µg/m³ → mg/m³
    inc[p] = r.total * scale;
    byGroup[p] = r.byGroup.map((v) => v * scale);
  }
  const out = { inc, byGroup, bg, band: null };
  if (incs.nox) {
    const chem = no2Chemistry({ noxInc: incs.nox.r.total, no2Bg: bg.no2, noxBg: bg.nox, o3Bg: bg.o3, tau: incs.nox.r.tau, J, k, fNO2 });
    Object.assign(out, { nox: chem.nox, no2: chem.no2, no: chem.no, o3: chem.o3 });
    inc.no2 = chem.no2 - bg.no2;
    inc.tau = incs.nox.r.tau;
  }
  for (const p of ['pm10', 'pm25', 'co', 'c6h6']) if (p in inc) out[p] = bg[p] + inc[p];
  if (ga.band) {
    out.band = {};
    for (const p of Object.keys(incs)) {
      const scale = p === 'co' ? 1e-3 : 1;
      const lo = increment({ ...ga, parts: null, gamma: ga.band.map((b) => b[0]) }, incs[p].q, u10, opts.cal || cal0).total * scale;
      const hi = increment({ ...ga, parts: null, gamma: ga.band.map((b) => b[1]) }, incs[p].q, u10, opts.cal || cal0).total * scale;
      out.band[p] = [lo, hi];
    }
    if (incs.nox) {
      out.band.no2 = out.band.nox.map((v) => no2Chemistry({ noxInc: v, no2Bg: bg.no2, noxBg: bg.nox, o3Bg: bg.o3,
        tau: incs.nox.r.tau, J, k, fNO2 }).no2 - bg.no2);
    }
  }
  const any = incs.nox || Object.values(incs)[0];
  out.meta = { source: ga.source, coverage: ga.coverage, cls, group: stabilityGroup(cls), uEff: uEff(u10, any ? any.r.U0 : cal0.U0),
    beta: any ? any.r.beta : cal0.beta, U0: any ? any.r.U0 : cal0.U0, status: cal0.status, J, k, sw, fNO2,
    label: ga.source === 'fallback' ? t('model.fallback.label') : t(`model.src.${ga.source}`) };
  return out;
}

// ------------------------------------------------------------------ slices
/*
 * Per-hour context for cellValue(): strengths of every pollutant, and the met/calibration numbers prepared once.
 * source = where the slice's Γ comes from ('field' for a GPU ScalarField, 'fallback' for FallbackModel.slice).
 * Returns {strengthsAll: {nox, pm10, pm25, co, c6h6}, met: {u10, uEff, beta, U0, J, k, fNO2, incOnly}, bg}.
 */
function sliceContext({ met = {}, dateUTC, measures = {}, background = null, opts = {}, source = 'field' } = {}) {
  const tms = +dateUTC;
  const cloud = met.cc !== undefined ? met.cc : met.cloud, t2 = met.t2;   // not met.t: the UI uses t for the time
  const c = opts.cal || mod_calFor(source, CAL, opts.calibrated !== false);
  const sw = Number.isFinite(met.sw) ? met.sw : met_shortwaveEstimate(solarElevation(tms - 1800e3), cloud);
  const sOpts = { heating: opts.heating, ef: opts.ef, heatingScale: opts.heatingScale, congestionShare: opts.congestionShare };
  const strengthsAll = {};
  for (const p of ['nox', 'pm10', 'pm25', 'co', 'c6h6']) strengthsAll[p] = groupStrengths(p, tms, measures, sOpts);
  return {
    strengthsAll,
    met: { u10: met.u10, uEff: uEff(met.u10, c.U0), beta: c.beta, U0: c.U0, J: jNO2(sw), k: kNOO3(t2),
      fNO2: Number.isFinite(opts.fNO2) ? opts.fNO2 : c.fNO2, incOnly: !!opts.incOnly },
    bg: mod_background(background),
  };
}

/*
 * Concentration of one pollutant in one cell from its Γ and A (4 groups each), e.g. inside
 * ConcSlice.update(field, (g, a) => cellValue(g, a, ctx.strengthsAll, ctx.met, ctx.bg, 'no2')).
 * met.incOnly returns the local increment instead of the total (for NO2: chemistry total minus NO2_bg).
 * CO is returned in mg/m³.
 */
function cellValue(gamma4, age4, strengthsAll, met, bg, pollutant) {
  const chem = pollutant === 'no2' || pollutant === 'no' || pollutant === 'o3';
  const q = strengthsAll[chem ? 'nox' : pollutant];
  if (!q) return NaN;
  const U = met.uEff || uEff(met.u10, met.U0);
  const beta = Number.isFinite(met.beta) ? met.beta : MD.beta_prior;
  const qs = [q.A || 0, q.B || 0, q.C || 0, q.D || 0];
  let s = 0, a = 0;
  for (let k = 0; k < 4; k++) { s += qs[k] * gamma4[k]; a += qs[k] * (age4 ? age4[k] : 0); }
  const dC = 1e6 * beta * s / U;
  const b = bg || MOD_BG_DEFAULT;
  if (!chem) {
    const v = pollutant === 'co' ? dC * 1e-3 : dC;
    return met.incOnly ? v : (b[pollutant] || 0) + v;
  }
  const tau = s > 0 && age4 ? a / (U * s) : CHEM_TAU_DEFAULT;
  const r = no2Chemistry({ noxInc: dC, no2Bg: b.no2, noxBg: b.nox, o3Bg: b.o3, tau, J: met.J || 0, k: met.k || kNOO3(15),
    fNO2: Number.isFinite(met.fNO2) ? met.fNO2 : MD.f_no2 });
  if (pollutant === 'no2') return met.incOnly ? r.no2 - (b.no2 || 0) : r.no2;
  if (pollutant === 'no') return r.no;
  return r.o3;
}

// ------------------------------------------------------------------ evaluation statistics
/*
 * Chang & Hanna (2004, Meteorol. Atmos. Phys. 87, 167) performance measures (physics Eqs. 10.3–10.4; FB > 0
 * means under-prediction), for paired observations Co and predictions Cp (non-finite pairs dropped):
 *   FB   = (mean Co - mean Cp) / (0.5 (mean Co + mean Cp))
 *   NMSE = mean((Co - Cp)²) / (mean Co · mean Cp)
 *   MG   = exp(mean ln Co - mean ln Cp),   VG = exp(mean (ln Co - ln Cp)²)
 *   FAC2 = fraction with 0.5 <= Cp/Co <= 2
 *   NAD  = mean |Co - Cp| / (mean Co + mean Cp)
 *   R    = Pearson correlation
 * MG, VG and FAC2 need a lower threshold (Chang & Hanna recommend the detection limit; physics §10.4 uses
 * 1 µg/m³ for increments): both series are clipped at `floor` for these three, so a pair with both values
 * below the floor counts as a FAC2 hit (the Hanna & Chang 2012 convention). FB, NMSE, NAD, R use raw values.
 * Also returned: n, RMSE, meanObs, meanMod.
 */
function metrics(obs, mod, { floor = 1 } = {}) {
  const o = [], p = [];
  for (let i = 0; i < Math.min(obs.length, mod.length); i++) {
    if (Number.isFinite(obs[i]) && Number.isFinite(mod[i])) { o.push(obs[i]); p.push(mod[i]); }
  }
  const n = o.length;
  const nan = { FB: NaN, NMSE: NaN, MG: NaN, VG: NaN, FAC2: NaN, NAD: NaN, R: NaN, n, RMSE: NaN, meanObs: NaN, meanMod: NaN };
  if (!n) return nan;
  let so = 0, sp = 0;
  for (let i = 0; i < n; i++) { so += o[i]; sp += p[i]; }
  const mo = so / n, mp = sp / n;
  let se = 0, sa = 0, lg = 0, lg2 = 0, f2 = 0, cov = 0, vo = 0, vp = 0;
  for (let i = 0; i < n; i++) {
    const d = o[i] - p[i];
    se += d * d; sa += Math.abs(d);
    const lo = Math.log(Math.max(o[i], floor)), lp = Math.log(Math.max(p[i], floor));
    lg += lo - lp; lg2 += (lo - lp) * (lo - lp);
    const ratio = Math.max(p[i], floor) / Math.max(o[i], floor);
    if (ratio >= 0.5 && ratio <= 2) f2++;
    cov += (o[i] - mo) * (p[i] - mp); vo += (o[i] - mo) * (o[i] - mo); vp += (p[i] - mp) * (p[i] - mp);
  }
  return {
    FB: (mo - mp) / (0.5 * (mo + mp)),
    NMSE: (se / n) / (mo * mp),
    MG: Math.exp(lg / n),
    VG: Math.exp(lg2 / n),
    FAC2: f2 / n,
    NAD: (sa / n) / (mo + mp),
    R: vo > 0 && vp > 0 ? cov / Math.sqrt(vo * vp) : NaN,
    n, RMSE: Math.sqrt(se / n), meanObs: mo, meanMod: mp,
  };
}

/*
 * FAIRMODE model quality indicator for total concentrations (physics Eq. 10.5, Vitali et al. 2023 Table A1):
 *   MQI = RMSE / (β_F · RMS_U),  RMS_U = √mean(U(O_i)²),  U(O) = U_r · √((1 - α²) O² + α² RV²),  β_F = 2.
 * Parameters (U_r, RV µg/m³, α): NO2 (0.24, 200, 0.20), O3 (0.18, 120, 0.79), PM10 (0.28, 50, 0.25),
 * PM2.5 (0.36, 25, 0.50). MQI <= 1 meets the assessment objective. Returns NaN for other pollutants.
 */
const MOD_MQI = { no2: [0.24, 200, 0.20], o3: [0.18, 120, 0.79], pm10: [0.28, 50, 0.25], pm25: [0.36, 25, 0.50] };
function mqi(obs, mod, pollutant) {
  const P = MOD_MQI[pollutant];
  if (!P) return NaN;
  const [Ur, RV, al] = P;
  let se = 0, su = 0, n = 0;
  for (let i = 0; i < Math.min(obs.length, mod.length); i++) {
    if (!Number.isFinite(obs[i]) || !Number.isFinite(mod[i])) continue;
    const d = obs[i] - mod[i];
    se += d * d;
    su += Ur * Ur * ((1 - al * al) * obs[i] * obs[i] + al * al * RV * RV);
    n++;
  }
  return n ? Math.sqrt(se / n) / (2 * Math.sqrt(su / n)) : NaN;
}

// ------------------------------------------------------------------ strings (hr, en)
I18N.add({
  hr: {
    'model.src.lut': 'unaprijed izračunata 3D simulacija (LUT)', 'model.src.field': '3D simulacija uživo',
    'model.src.fallback': 'približno (bez 3D strujanja)',
    'model.status.calibrated': 'kalibrirano (β i U₀ prilagođeni mjerenjima)', 'model.status.uncalibrated': 'nekalibrirano (početne vrijednosti)',
    'model.status.raw': 'sirova fizika (β = 1)', 'model.status.fallback-only': 'kalibriran samo približni model',
    'model.bg.default': 'pozadina: godišnji prosjeci ZAGREB-4 (2025.)', 'model.bg.given': 'pozadina: izmjereno / prognoza',
    'model.scenario.pending': 'scenarij još nije izračunat za ovaj smjer – prikazana je današnja geometrija',
  },
  en: {
    'model.src.lut': 'precomputed 3D simulation (LUT)', 'model.src.field': 'live 3D simulation',
    'model.src.fallback': 'approximate (no 3D flow)',
    'model.status.calibrated': 'calibrated (β and U₀ fitted to measurements)', 'model.status.uncalibrated': 'uncalibrated (prior values)',
    'model.status.raw': 'raw physics (β = 1)', 'model.status.fallback-only': 'only the approximate model is calibrated',
    'model.bg.default': 'background: ZAGREB-4 annual means (2025)', 'model.bg.given': 'background: measured / forecast',
    'model.scenario.pending': 'scenario not computed for this direction yet – showing today\'s geometry',
  },
});
