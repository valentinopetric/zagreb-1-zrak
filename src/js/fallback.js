// ------------------------------------------------------------------ fallback
/*
 * CPU receptor and map model for browsers without float render targets, and whenever no GPU field or LUT
 * exists [owner: models]. Physics §9 with the critic's §4.4 decisions; mirrored in tools/aqmodel.py.
 *
 *   receptor(dirDeg, cls) → {gamma:[4], age:[4], queue:[4], canyon:[4], n}
 *   slice(dirDeg, cls, height, grid) → Float32Array(nx·nz·4)       (Γ of groups A–D, map view)
 *   sliceAsync(...) → Promise of the same, yielding to the event loop between rows
 *
 * Γ uses exactly the units and normalisation of the GPU scalar solver (architecture §5.3), so everything
 * downstream (model.js increment(), chemistry, calibration) is identical:
 *   ΔC_k [µg/m³] = 1e6 · β · q_k · Γ_k / U_eff,   Γ_k in m⁻¹ for road groups A–C (per 10 000 veh/day of AADT)
 *                                                  and dimensionless for the heating group D (per m² of w = 1).
 * The age A_k is normalised the same way as the solver's age tracer: τ = Σ q A / (U_eff Σ q Γ) seconds
 * (physics Eq. 5.8), which for a Gaussian plume makes A = Σ Γ_m x_m (x_m the travel distance).
 *
 * Model (labelled "approximate (no 3D flow)" in the UI, physics §9.2 last line):
 * 1. Gaussian plumes (physics Eq. 9.5). Every road with a source group is cut into point sources at most
 *    FB_SPACING = 4 m apart (as critic/gauss_sanity.py; ≈ 16 500 points within 800 m for the 2026-09-27
 *    env.json, heating included) and each heating polygon
 *    into FB_HEAT_CELL = 10 m cells. A point with weight W_m (= AADT/10 000 · Δs, or w · cell area) at height
 *    h_s contributes, for a receptor x_m > 0.5 m downwind and y_m crosswind,
 *      Γ_m = W_m / (2π σy σz) · exp(-y²/2σy²) · Σ_n [exp(-(z_r - h_s + 2n h)²/2σz²) + exp(-(z_r + h_s + 2n h)²/2σz²)]
 *    with ground reflection and lid images n = -3..3 at the class mixing height h (mixingHeight({cls, hMin})); the
 *    |n| >= 1 terms are only summed when σz > h/4 (below that they are < e^-30 of the n = 0 term).
 *    σy² = σy0² + σyB(x)², σz² = σz0² + σzB(x)², Briggs urban curves (McElroy–Pooler, physics §9.2 table),
 *    σy0 = W/2 for roads (carriageway width W, physics §9.2) or cell/2 for heating cells, σz0 = 2 m (vehicle
 *    wakes, physics §9.2). Road sources sit at h_s = 0.5 m (gauss_sanity.py), heating at roof level 8 m
 *    (architecture §5.3). The plume speed is U_eff of the 10 m wind, like the GPU normalisation; physics §9.2
 *    suggests U at the plume height instead, which would make Γ 2–3× larger near the ground: that shelter is
 *    what β absorbs for this model (critic §1.12 expects β ≈ 4 with this set-up).
 * 2. OSPM-type street-canyon term at the receptor (physics §9.1, Eqs. 9.3–9.4). For each road group, take the
 *    nearest stretch within FB_CANYON_RANGE = 60 m of the receptor and cast rays across it to the first
 *    buildings on both sides (up to 80 m). If both sides are built and the aspect ratio H/W >= 0.3 (the lower
 *    bound of the wake-interference regime, Oke 1988, Energy Build. 11, 103) the receptor is in a canyon and gets
 *    the recirculation box concentration
 *      Γ_r = Q_units · L_r / (W · σ̂_wt · L_t) · |cos φ|,  L_v = 2 H_upwind,  L_r = min(L_v, W),  L_t = min(L_v/2, W),
 *    σ̂_wt = λ_OSPM · û(H) (λ_OSPM = 0.1, physics Eq. 9.4, constants still to verify: gap G9), φ the angle between
 *    the wind and the street normal. The traffic-turbulence part of σ_wt is represented by U0 in U_eff, as
 *    everywhere in this model. A leeward receptor (on the upwind side of the street) always gets Γ_r; a
 *    windward one only when the vortex spans the street (L_v >= W). For today's geometry the term is zero at
 *    ZAGREB-1 (open park east of Miramarska, H/W ≈ 0.1–0.3 on Vukovarska, site-context §3.1), consistent with
 *    the SW–W minimum of the measured increment rose (physics F6); it switches on when a scenario closes a canyon.
 * 3. Congestion share (EM_CONGESTION): points of groups A and B that lie 15–75 m from the Vukovarska ×
 *    Miramarska intersection centre (60 m upstream of a stop line assumed 15 m from the centre) on an
 *    approaching carriageway are flagged; queue[k] is the part of Γ_k from them (two-way ways count half).
 *
 * Cost: receptor() on the full ENV (≈ 16 500 points) takes 2–13 ms and is cached per (direction, class);
 * slice() visits, per cell, only the sources upwind of it (sorted once per direction); see its comment for timings.
 */
const FB_RADIUS = 800;          // m, source radius around the receptor (critic §1.12)
const FB_SPACING = 4;           // m, point-source spacing along roads (critic §1.12)
const FB_HEAT_CELL = 10;        // m, heating area-source cell (2 × the 5 m LBM cell)
const FB_HS_ROAD = 0.5;         // m, road source height (critic/gauss_sanity.py)
const FB_HS_HEAT = 8;           // m, heating release height = roof level of low-rise houses (architecture §5.3)
const FB_SZ0 = 2;               // m, initial vertical spread from vehicle wakes (physics §9.2)
const FB_XMIN = 0.5;            // m, nearest downwind distance counted (critic/gauss_sanity.py)
const FB_YCUT = 6;              // crosswind cut-off in σy: exp(-18) = 1.5e-8 of the centre-line value
const FB_IMAGES = 3;            // lid image pairs (physics §9.2, n <= 3)
const FB_EXP_MAX = 40;          // image terms with exp(-40) = 4e-18 or less are not evaluated (speed only)
const FB_CANYON_RANGE = 60;     // m, a street farther from the receptor than this is not "its" canyon
const FB_CANYON_RAY = 80;       // m, search distance for the canyon walls on each side
const FB_CANYON_HW = 0.3;       // aspect-ratio threshold for a recirculating canyon (Oke 1988)
const FB_OSPM_LAMBDA = 0.1;     // σ_wt = λ U_roof (physics Eq. 9.4, [lit], gap G9)
const FB_QUEUE = [15, 75];      // m from the intersection centre: 60 m upstream of a stop line ~15 m out (critic §4.6)
const FB_GROUPS = { A: 0, B: 1, C: 2 };
// Leading coefficient of σyB (σyB <= c·x for every class): a cheap lateral bound that rejects far-off sources before
// the square roots; it never rejects a source the exact FB_YCUT test would keep (6(σy0 + c x) >= 6 σy).
const FB_SYC = { A: 0.32, B: 0.32, C: 0.22, D: 0.16, E: 0.11, F: 0.11 };

/*
 * Briggs urban dispersion parameters σy, σz [m] at downwind distance x [m] (McElroy & Pooler 1968 as fitted by
 * Briggs 1973; physics §9.2 table). Classes A and B share a curve, as do E and F.
 */
function fb_briggs(cls, x) {
  if (cls === 'A' || cls === 'B') return [0.32 * x / Math.sqrt(1 + 0.0004 * x), 0.24 * x * Math.sqrt(1 + 0.001 * x)];
  if (cls === 'C') return [0.22 * x / Math.sqrt(1 + 0.0004 * x), 0.20 * x];
  if (cls === 'D') return [0.16 * x / Math.sqrt(1 + 0.0004 * x), 0.14 * x / Math.sqrt(1 + 0.0003 * x)];
  return [0.11 * x / Math.sqrt(1 + 0.0004 * x), 0.08 * x / Math.sqrt(1 + 0.0015 * x)];
}

// Intersection point of segments p1p2 and p3p4 in the x/z plane, or null.
function fb_segX(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0], d1z = p2[1] - p1[1], d2x = p4[0] - p3[0], d2z = p4[1] - p3[1];
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const s = ((p3[0] - p1[0]) * d2z - (p3[1] - p1[1]) * d2x) / den;
  const u = ((p3[0] - p1[0]) * d1z - (p3[1] - p1[1]) * d1x) / den;
  if (s < 0 || s > 1 || u < 0 || u > 1) return null;
  return [p1[0] + s * d1x, p1[1] + s * d1z];
}

// Distance along a ray (origin o, unit direction d) to segment ab, or Infinity.
function fb_rayHit(ox, oz, dx, dz, a, b) {
  const ex = b[0] - a[0], ez = b[1] - a[1];
  const den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-12) return Infinity;
  const tt = ((a[0] - ox) * ez - (a[1] - oz) * ex) / den;
  const u = ((a[0] - ox) * dz - (a[1] - oz) * dx) / den;
  return tt > 1e-9 && u >= 0 && u <= 1 ? tt : Infinity;
}

let fb_lastX = 0;   // downwind distance of the last kernel evaluation (avoids allocating a pair per source)

class FallbackModel {
  /*
   * env: an env.json-like object {roads, buildings, heating} or a cityGeometry() result {roads, prisms, heating}.
   * opts: {radius, spacing, heatCell, receptor: {x, y, z}, hMin} (defaults above, RECEPTOR, SITE h_min_m). The lid
   * floor is fixed at construction (not read from CAL) so that the fallback's calibration stays reproducible.
   */
  constructor(env, opts = {}) {
    env = env || {};
    this.radius = opts.radius ?? FB_RADIUS;
    this.spacing = opts.spacing ?? FB_SPACING;
    this.heatCell = opts.heatCell ?? FB_HEAT_CELL;
    this.hMin = opts.hMin ?? MD.h_min_m;
    const r = opts.receptor || RECEPTOR;
    this.rx = r.x; this.ry = r.y; this.rz = r.z;
    this.roads = (env.roads || []).filter((rd) => rd && rd.g in FB_GROUPS && rd.aadt > 0 && rd.p && rd.p.length > 1);
    // env.json buildings carry s = source year; cityGeometry() prisms carry s = solid fraction (keep solid ones).
    const blds = env.buildings ? env.buildings : (env.prisms || []).filter((b) => !(b && b.s < 0.5));
    this.buildings = blds.filter((b) => b && b.p && b.p.length > 2 && b.h > 0);
    this.heating = (env.heating || []).filter((hp) => hp && hp.p && hp.p.length > 2);
    this.center = this._intersection();
    this._buildSources();
    this.canyons = [0, 1, 2].map((gi) => this._canyon(gi));
    this._cache = new Map();
  }

  // Centre of the Vukovarska × Miramarska intersection: mean crossing point of the group A and B segments that pass
  // within 150 m of the receptor (null if the two groups do not cross there).
  _intersection() {
    const segs = (g) => {
      const out = [];
      for (const rd of this.roads) if (rd.g === g) for (let i = 0; i + 1 < rd.p.length; i++) {
        const a = rd.p[i], b = rd.p[i + 1];
        if (segDist(this.rx, this.rz, a[0], a[1], b[0], b[1]) < 150) out.push([a, b]);
      }
      return out;
    };
    const A = segs('A'), B = segs('B');
    let sx = 0, sz = 0, n = 0;
    for (const [a1, a2] of A) for (const [b1, b2] of B) {
      const p = fb_segX(a1, a2, b1, b2);
      if (p) { sx += p[0]; sz += p[1]; n++; }
    }
    return n ? [sx / n, sz / n] : null;
  }

  // Point sources: parallel typed arrays (x, z, weight, source height, σy0, group 0..3, queue fraction).
  _buildSources() {
    const X = [], Z = [], W = [], H = [], S = [], G = [], Q = [];
    const R2 = this.radius * this.radius, C = this.center;
    for (const rd of this.roads) {
      const gi = FB_GROUPS[rd.g], a = rd.aadt / MD.aadt_unit;
      const sy0 = (rd.w > 0 ? rd.w : 3.25 * (rd.l > 0 ? rd.l : 2)) / 2;   // default 3.25 m lanes (architecture §4.1)
      const o = rd.o || 0;
      for (let i = 0; i + 1 < rd.p.length; i++) {
        const [x1, z1] = rd.p[i], [x2, z2] = rd.p[i + 1];
        const L = Math.hypot(x2 - x1, z2 - z1);
        if (!(L > 0)) continue;
        const n = Math.max(1, Math.ceil(L / this.spacing)), ds = L / n;
        for (let k = 0; k < n; k++) {
          const s = (k + 0.5) / n, px = x1 + (x2 - x1) * s, pz = z1 + (z2 - z1) * s;
          const ex = px - this.rx, ez = pz - this.rz;
          if (ex * ex + ez * ez > R2) continue;
          let qf = 0;
          if (C && gi < 2) {
            const d = Math.hypot(px - C[0], pz - C[1]);
            if (d >= FB_QUEUE[0] && d <= FB_QUEUE[1]) {
              if (o === 0) qf = 0.5;
              else {
                const tx = o * (x2 - x1) / L, tz = o * (z2 - z1) / L;
                qf = tx * (C[0] - px) + tz * (C[1] - pz) > 0 ? 1 : 0;
              }
            }
          }
          X.push(px); Z.push(pz); W.push(a * ds); H.push(FB_HS_ROAD); S.push(sy0); G.push(gi); Q.push(qf);
        }
      }
    }
    const c = this.heatCell;
    for (const hp of this.heating) {
      const wt = (Number.isFinite(hp.w) ? hp.w : 1) * c * c;
      const bb = bounds(hp.p);
      const i0 = Math.ceil((bb.x0 - c / 2) / c), i1 = Math.floor((bb.x1 - c / 2) / c);
      const j0 = Math.ceil((bb.z0 - c / 2) / c), j1 = Math.floor((bb.z1 - c / 2) / c);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = i * c + c / 2, pz = j * c + c / 2;
        const ex = px - this.rx, ez = pz - this.rz;
        if (ex * ex + ez * ez > R2 || !pointInPoly(px, pz, hp.p)) continue;
        X.push(px); Z.push(pz); W.push(wt); H.push(FB_HS_HEAT); S.push(c / 2); G.push(3); Q.push(0);
      }
    }
    this.src = { x: Float64Array.from(X), z: Float64Array.from(Z), w: Float64Array.from(W), hs: Float64Array.from(H),
      sy0: Float64Array.from(S), g: Uint8Array.from(G), q: Float64Array.from(Q), n: X.length };
  }

  // First building wall hit by a ray from (ox, oz) along (dx, dz) within FB_CANYON_RAY: {dist, h} or null.
  _wall(ox, oz, dx, dz) {
    let best = Infinity, h = 0;
    const reach = FB_CANYON_RAY;
    for (const b of this.buildings) {
      const bb = bounds(b.p);
      if (bb.x1 < Math.min(ox, ox + dx * reach) - 1 || bb.x0 > Math.max(ox, ox + dx * reach) + 1
        || bb.z1 < Math.min(oz, oz + dz * reach) - 1 || bb.z0 > Math.max(oz, oz + dz * reach) + 1) continue;
      for (let i = 0; i < b.p.length; i++) {
        const tt = fb_rayHit(ox, oz, dx, dz, b.p[i], b.p[(i + 1) % b.p.length]);
        if (tt < best && tt <= reach) { best = tt; h = b.h; }
      }
    }
    return best <= reach ? { dist: best, h } : null;
  }

  // Street-canyon description of group gi at the receptor (see header, item 2), or null.
  _canyon(gi) {
    let best = Infinity, P0 = null, seg = null;
    for (const rd of this.roads) {
      if (FB_GROUPS[rd.g] !== gi) continue;
      for (let i = 0; i + 1 < rd.p.length; i++) {
        const [ax, az] = rd.p[i], [bx, bz] = rd.p[i + 1];
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
        if (!(L2 > 0)) continue;
        const s = clamp(((this.rx - ax) * dx + (this.rz - az) * dz) / L2, 0, 1);
        const px = ax + dx * s, pz = az + dz * s, d = Math.hypot(this.rx - px, this.rz - pz);
        if (d < best) { best = d; P0 = [px, pz]; seg = [dx, dz, Math.sqrt(L2)]; }
      }
    }
    if (!P0 || best > FB_CANYON_RANGE) return null;
    let nx, nz;
    if (best > 0.1) { nx = (this.rx - P0[0]) / best; nz = (this.rz - P0[1]) / best; }
    else { nx = -seg[1] / seg[2]; nz = seg[0] / seg[2]; }
    const near = this._wall(P0[0], P0[1], nx, nz), far = this._wall(P0[0], P0[1], -nx, -nz);
    if (!near || !far || near.dist <= best) return null;
    const Wc = near.dist + far.dist, Hc = (near.h + far.h) / 2;
    if (Hc / Wc < FB_CANYON_HW) return null;
    let Q = 0;                                  // AADT units of this group inside the canyon cross-section
    for (const rd of this.roads) {
      if (FB_GROUPS[rd.g] !== gi) continue;
      let dmin = Infinity;
      for (let i = 0; i + 1 < rd.p.length; i++) {
        dmin = Math.min(dmin, segDist(P0[0], P0[1], rd.p[i][0], rd.p[i][1], rd.p[i + 1][0], rd.p[i + 1][1]));
      }
      if (dmin <= Math.max(near.dist, far.dist)) Q += rd.aadt / MD.aadt_unit;
    }
    return { nx, nz, W: Wc, H: Hc, hNear: near.h, hFar: far.h, Q, dist: best };
  }

  /*
   * Unit responses at the receptor for wind from dirDeg and class (or group) cls. Cached; returns copies.
   * queue[k] = the part of gamma[k] from the congestion stretches; canyon[k] = the OSPM recirculation part.
   */
  receptor(dirDeg, cls) {
    const c = met_class(cls);
    const key = `${Math.round(wrap360(dirDeg) * 10)}|${c}`;
    let r = this._cache.get(key);
    if (!r) { r = this._receptor(wrap360(dirDeg), c); this._cache.set(key, r); }
    return { gamma: r.gamma.slice(), age: r.age.slice(), queue: r.queue.slice(), canyon: r.canyon.slice(), n: r.n };
  }

  _receptor(dirDeg, c) {
    const out = { gamma: [0, 0, 0, 0], age: [0, 0, 0, 0], queue: [0, 0, 0, 0], canyon: [0, 0, 0, 0], n: 0 };
    const h = mixingHeight({ cls: c, hMin: this.hMin });
    const bx = -Math.sin(dirDeg * DEG), bz = Math.cos(dirDeg * DEG);    // wind blowing-toward unit vector (x, z)
    const S = this.src;
    for (let m = 0; m < S.n; m++) {
      const g = this._kernel(S, m, this.rx, this.ry, this.rz, bx, bz, c, h);
      if (!g) continue;
      const k = S.g[m];
      out.gamma[k] += g;
      out.age[k] += g * fb_lastX;
      out.queue[k] += g * S.q[m];
      out.n++;
    }
    // OSPM-type recirculation term (header item 2)
    const turb = turbParams(c);
    for (let gi = 0; gi < 3; gi++) {
      const cy = this.canyons[gi];
      if (!cy) continue;
      const bn = bx * cy.nx + bz * cy.nz;          // < 0: wind blows from the receptor side across the street (leeward receptor)
      const leeward = bn < 0;
      const Lv = 2 * (leeward ? cy.hNear : cy.hFar);
      if (!leeward && Lv < cy.W) continue;
      const Lr = Math.min(Lv, cy.W), Lt = Math.min(Lv / 2, cy.W);
      if (!(Lt > 0)) continue;
      const swt = FB_OSPM_LAMBDA * MOST.uHat(cy.H, turb);
      const gr = cy.Q * Lr / (cy.W * swt * Lt) * Math.abs(bn);
      out.gamma[gi] += gr;
      out.age[gi] += gr * (Lr * cy.H) / (swt * Lt);
      out.canyon[gi] += gr;
    }
    return out;
  }

  // Γ contribution of source m at receptor (x, y, z); sets fb_lastX to the downwind distance. 0 if outside the plume.
  _kernel(S, m, rx, ry, rz, bx, bz, c, h) {
    const dx = rx - S.x[m], dz = rz - S.z[m];
    const x = dx * bx + dz * bz;
    if (x <= FB_XMIN) return 0;
    const y = -dx * bz + dz * bx;
    const sy0 = S.sy0[m];
    if (Math.abs(y) > FB_YCUT * (sy0 + FB_SYC[c] * x)) return 0;
    const [syb, szb] = fb_briggs(c, x);
    const sy = Math.sqrt(sy0 * sy0 + syb * syb);
    if (Math.abs(y) > FB_YCUT * sy) return 0;
    const sz = Math.sqrt(FB_SZ0 * FB_SZ0 + szb * szb);
    const hs = S.hs[m], s2 = 2 * sz * sz;
    let V = 0;
    const nI = sz > h / 4 ? FB_IMAGES : 0;
    for (let n = -nI; n <= nI; n++) {
      const a = ry - hs + 2 * n * h, b = ry + hs + 2 * n * h;
      const ea = (a * a) / s2, eb = (b * b) / s2;
      if (ea < FB_EXP_MAX) V += Math.exp(-ea);
      if (eb < FB_EXP_MAX) V += Math.exp(-eb);
    }
    fb_lastX = x;
    return S.w[m] / (2 * Math.PI * sy * sz) * Math.exp(-(y * y) / (2 * sy * sy)) * V;
  }

  /*
   * Γ of the four groups on a horizontal slice at `height` m: grid {x0, z0, dx, nx, nz} in world metres, samples
   * at the cell centres (x0 + (i + ½)dx, z0 + (j + ½)dx). Output index ((j·nx + i)·4 + k). Gaussian part only
   * (the canyon term is a receptor model). rows = [j0, j1) restricts the work (used by sliceAsync).
   * Speed: the sources are rotated into wind coordinates (along a, across c) and sorted by a once per direction,
   * so each cell only visits the sources upwind of it (binary search) and rejects far-off ones with the cheap
   * lateral bound FB_SYC before any square root. The kernel is the same as _kernel(), written out inline.
   * Measured on the full ENV under heavy machine load (models.test.js, slow test): 60 × 60 cells at 10 m ≈ 2 s,
   * 120 × 120 at 5 m ≈ 8.5 s; use sliceAsync() so the page stays responsive.
   */
  _rotated(dirDeg) {
    const key = Math.round(wrap360(dirDeg) * 10);
    if (this._rot && this._rot.key === key) return this._rot;
    const bx = -Math.sin(dirDeg * DEG), bz = Math.cos(dirDeg * DEG), S = this.src, n = S.n;
    const along = new Float64Array(n);
    for (let m = 0; m < n; m++) along[m] = S.x[m] * bx + S.z[m] * bz;
    const idx = Array.from({ length: n }, (_, m) => m).sort((p, q) => along[p] - along[q]);
    const R = { key, bx, bz, n, a: new Float64Array(n), c: new Float64Array(n), w: new Float64Array(n), hs: new Float64Array(n),
      sy0: new Float64Array(n), g: new Uint8Array(n) };
    idx.forEach((m, i) => {
      R.a[i] = along[m]; R.c[i] = -S.x[m] * bz + S.z[m] * bx; R.w[i] = S.w[m]; R.hs[i] = S.hs[m]; R.sy0[i] = S.sy0[m]; R.g[i] = S.g[m];
    });
    this._rot = R;
    return R;
  }

  slice(dirDeg, cls, height, grid, out = null, rows = null) {
    const c = met_class(cls), h = mixingHeight({ cls: c, hMin: this.hMin });
    const { x0, z0, dx, nx, nz } = grid;
    const res = out || new Float32Array(nx * nz * 4);
    const R = this._rotated(wrap360(dirDeg));
    const cyc = FB_SYC[c], kind = c === 'A' || c === 'B' ? 0 : c === 'C' ? 1 : c === 'D' ? 2 : 3;
    const nI = FB_IMAGES, sz02 = FB_SZ0 * FB_SZ0, acc = [0, 0, 0, 0];
    const [ja, jb] = rows || [0, nz];
    for (let j = ja; j < jb; j++) {
      const z = z0 + (j + 0.5) * dx;
      for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * dx;
        const ar = x * R.bx + z * R.bz, cr = -x * R.bz + z * R.bx;
        let lo = 0, hi = R.n;                                  // first source with a >= ar - FB_XMIN
        while (lo < hi) { const mid = (lo + hi) >> 1; if (R.a[mid] < ar - FB_XMIN) lo = mid + 1; else hi = mid; }
        acc[0] = acc[1] = acc[2] = acc[3] = 0;
        for (let m = 0; m < lo; m++) {
          const xx = ar - R.a[m];
          if (xx <= FB_XMIN) continue;
          const yy = cr - R.c[m], sy0 = R.sy0[m];
          if (Math.abs(yy) > FB_YCUT * (sy0 + cyc * xx)) continue;
          let syb, szb;
          if (kind === 0) { syb = 0.32 * xx / Math.sqrt(1 + 0.0004 * xx); szb = 0.24 * xx * Math.sqrt(1 + 0.001 * xx); }
          else if (kind === 1) { syb = 0.22 * xx / Math.sqrt(1 + 0.0004 * xx); szb = 0.20 * xx; }
          else if (kind === 2) { syb = 0.16 * xx / Math.sqrt(1 + 0.0004 * xx); szb = 0.14 * xx / Math.sqrt(1 + 0.0003 * xx); }
          else { syb = 0.11 * xx / Math.sqrt(1 + 0.0004 * xx); szb = 0.08 * xx / Math.sqrt(1 + 0.0015 * xx); }
          const sy = Math.sqrt(sy0 * sy0 + syb * syb);
          if (Math.abs(yy) > FB_YCUT * sy) continue;
          const sz = Math.sqrt(sz02 + szb * szb), hs = R.hs[m], s2 = 2 * sz * sz;
          let V = 0;
          const nn = sz > h / 4 ? nI : 0;
          for (let n = -nn; n <= nn; n++) {
            const aa = height - hs + 2 * n * h, bb = height + hs + 2 * n * h;
            const ea = (aa * aa) / s2, eb = (bb * bb) / s2;
            if (ea < FB_EXP_MAX) V += Math.exp(-ea);
            if (eb < FB_EXP_MAX) V += Math.exp(-eb);
          }
          acc[R.g[m]] += R.w[m] / (2 * Math.PI * sy * sz) * Math.exp(-(yy * yy) / (2 * sy * sy)) * V;
        }
        const o = (j * nx + i) * 4;
        res[o] = acc[0]; res[o + 1] = acc[1]; res[o + 2] = acc[2]; res[o + 3] = acc[3];
      }
    }
    return res;
  }

  // Same as slice(), a few rows at a time so the page stays responsive; onProgress(fraction) after each chunk.
  async sliceAsync(dirDeg, cls, height, grid, onProgress = null, rowsPerChunk = 4) {
    const res = new Float32Array(grid.nx * grid.nz * 4);
    for (let j = 0; j < grid.nz; j += rowsPerChunk) {
      this.slice(dirDeg, cls, height, grid, res, [j, Math.min(grid.nz, j + rowsPerChunk)]);
      if (onProgress) onProgress(Math.min(1, (j + rowsPerChunk) / grid.nz));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return res;
  }
}

I18N.add({
  hr: {
    'model.fallback.label': 'približno (bez 3D strujanja)',
    'model.fallback.desc': 'Gaussov model linijskih izvora s Briggsovim gradskim disperzijskim krivuljama i OSPM-ovim članom za ulične kanjone; zgrade ne mijenjaju vjetar.',
  },
  en: {
    'model.fallback.label': 'approximate (no 3D flow)',
    'model.fallback.desc': 'Gaussian line-source model with Briggs urban dispersion curves and an OSPM-type street-canyon term; buildings do not change the wind.',
  },
});
