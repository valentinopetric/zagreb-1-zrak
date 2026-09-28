// ------------------------------------------------------------------ scalar dispersion (GPU steady advection-diffusion)
/*
 * What this file does
 * -------------------
 * The wind tunnel (wind-tunnel.js) gives the time-averaged flow through the city for one wind direction, as a
 * fraction of the 10 m reference wind. This file carries the traffic and heating emissions through that frozen
 * mean flow and returns, for every cell of the same tiled 3D grid, the steady concentration per unit emission
 * of four source groups at once (RGBA): A Vukovarska, B Miramarska, C other roads, D domestic heating
 * (docs/architecture.md §5.3). A second render target (MRT) carries four plume-age tracers, one per group, which
 * the NO-NO2-O3 chemistry needs (physics §5.6, §8).
 *
 * The equation (physics §2.1, §2.4), non-dimensionalised by the reference wind U_ref = U10:
 *
 *     div(û Γ_k) − div(K̂ grad Γ_k) = σ_k            û = ū / U10 [–],  K̂ = K / U10 [m],  σ_k [m⁻² or m⁻¹]
 *     div(û A_k) − div(K̂ grad A_k) = Γ_k            (age tracer, physics Eq. 5.8)
 *
 * and the physical increment is (architecture §5.3, physics Eq. 2.5, critic §4.4)
 *
 *     ΔC_k [µg/m³] = 1e6 · β · q_k · Γ_k / U_eff,   U_eff = √(U10² + U0²)
 *     τ [s] = Σ q_k A_k / (U_eff Σ q_k Γ_k)          (plume age for chemistry)
 *
 * Γ_k is in m⁻¹ for the line groups A–C (q_k in g m⁻¹ s⁻¹) and dimensionless for the area group D (q_D in
 * g m⁻² s⁻¹), because the per-cell source weights of voxel.js rasterizeSources() are a road length [m] (×AADT/10 000)
 * or a heating area [m²] (×w) inside the cell, i.e. σ_k·V. A_k has the units of Γ_k times metres; A_k/Γ_k is the
 * mean travel distance at unit wind speed, so the age in seconds is (A_k/Γ_k)/U_eff. One solve per (direction,
 * stability group) therefore serves every wind speed, traffic volume, fleet and emission factor.
 *
 * How (physics §3, §5; critic §4.4)
 * ---------------------------------
 * - Conservative cell-centred finite volumes on the tunnel's tiled atlas (reference layout, physics Eq. 1.1).
 *   Face flux F_f = A n·½(û_P + û_N), conductance D_f = (A/Δx)·harmonic mean of K̂ (physics Eq. 5.1).
 * - First-order upwind, implicit, in continuity-corrected form a_P = Σ a_f (physics Eq. 5.2): an M-matrix,
 *   bounded (no over- or undershoots) even where the time-averaged LBM flow is not discretely divergence-free.
 *   The price: mass is conserved only as well as the flow conserves it, so the flow divergence ε_div and the
 *   mass balance Φ_out/Φ_src are measured and reported with every result.
 * - Second-order van Leer TVD deferred correction (physics Eq. 5.3–5.4), blended in with γ = 0 → 1 over the
 *   first 200 sweeps (critic §4.4).
 * - Point-Jacobi with under-relaxation ω = 0.9 (physics Eq. 5.5, critic §4.5) = pseudo-time stepping with a
 *   local step. Where the TVD correction is on, the step is reduced locally to ω_P = ω·a_P/(a_P + γ F_out)
 *   (sc_relax below): without it the iteration falls into a limit cycle at high cell Péclet numbers.
 *   The fixed point, i.e. the solution, does not depend on ω_P.
 * - K-theory closure (physics §4, critic §4.4): K̂ = max(K̂_MO(z; turb), ℓ_m²|Ŝ|/Sc_t, K̂_min), with |Ŝ| from
 *   finite differences of the averaged velocity and a wall-distance-limited mixing length (K-prep pass,
 *   physics §5.5.1). Stability enters only here and through the mixing lid (physics §4.6).
 * - Boundaries (physics §5.3): zero increment at inflow, open (upwind, zero-gradient diffusion) outflow and
 *   lateral sides (NOT periodic, unlike the flow), no flux at the ground and at solids, and either an open top
 *   or a no-flux mixing lid at h_eff (from turb) when the lid is inside the domain.
 * - Convergence (physics §5.7): probe change < 1e-3 per 100 sweeps, together with a normalised L1 residual
 *   < 1e-4 or a settled mass balance (Φ_out/Φ_src changing by < 1e-3 per 100 sweeps). Whether the balance also
 *   closes to 2 % is reported (stats.massWithinTol): a persistent mismatch is the flow's own divergence error,
 *   reported, not hidden. Checked every 50 sweeps with a GPU reduction and an asynchronous 32×3 readback, so the
 *   page never stalls.
 *
 * Public interface (docs/architecture.md §6.2): ScalarSolver, ScalarField. Everything prefixed sc_ is
 * private to this file, except sc_cpuSolve, the pure-JS reference implementation of the very same
 * discretisation that the tests use to check the GPU solver cell by cell. docs/04-dispersion.md documents
 * the method, the parameters and the verification results.
 */

// ------------------------------------------------------------------ parameters
/*
 * Solver constants. Each is taken from the research reports (section in the comment) or is a derived
 * bookkeeping value whose reason is given. They can be overridden per solve through begin(..., opts).
 */
const sc_DEFAULTS = {
  omega: 0.9,          // Jacobi under-relaxation, physics §5.2 Eq. 5.5 ("0.8–1.0"), fixed at 0.9 by critic §4.4/§4.5
  ramp: 200,           // sweeps over which the TVD blend γ goes 0 → 1, physics §5.2, critic §4.4
  maxSweeps: 3000,     // hard cap, critic §4.5 ("max 3000 sweeps"); reaching it is reported as not converged
  checkEvery: 50,      // convergence checks every 50 sweeps, physics §5.7
  window: 100,         // probe change measured over the last 100 sweeps, physics §5.7 criterion 1
  tolProbe: 1e-3,      // physics §5.7 criterion 1, critic §4.5
  tolRes: 1e-4,        // physics §5.7 criterion 2 (normalised L1 residual)
  tolMass: 0.02,       // physics §5.7 criterion 3, critic §4.5 ("mass error < 2 %")
  minSweeps: 300,      // = ramp + window: no convergence claim before the TVD correction is fully on and a whole window has passed
  spongeFree: 100,     // m; sources inside the last 100 m before the outlet are dropped (physics §5.3: LBM sponge)
  tvd: true,           // false = first-order upwind only (used by the verification tests)
  keepFlow: false,     // a flow made by flowFromField() is disposed after the K-prep pass unless this is set
};
/*
 * sc_relax — the local relaxation factor ω_P = ω · a_P / (a_P + γ · F_out), F_out = Σ max(F_f, 0) over the faces to
 * open neighbours (the outflow faces that carry a deferred correction).
 *
 * A point-Jacobi sweep with the TVD deferred correction lagged is, cell by cell, one explicit step in pseudo-time.
 * Written in incremental form, Γ_P ← Γ_P + Σ_m c_m (Γ_m − Γ_P) + source, the van Leer correction (ψ ≤ 2, ψ/r ≤ 2,
 * Sweby 1984) only LOWERS the upwind coefficients on inflow faces, but adds up to γ F_f on every outflow face. Harten's
 * condition Σ c_m ≤ 1 then needs ω_P ≤ a_P / (a_P + γ F_out) (derivation in docs/04-dispersion.md §4.3). With the plain
 * ω = 0.9 it is violated wherever advection dominates, and the limiter switches back and forth without settling.
 * Measured on the GPU = CPU test grid: with stable K̂ (cell Péclet ≈ 60) the field still changed by 10–15 % per 50
 * sweeps after 2000 sweeps, and the age behind the T5 block drifted at the 1e-4 level. Scaling ω as above keeps
 * Σ c_m ≤ ω < 1:
 * - it leaves ω untouched while γ = 0 (upwind) and in diffusion-dominated cells;
 * - it halves the step only where advection dominates and the correction is fully on;
 * - it changes the path to the fixed point but never the fixed point (the steady solution) itself.
 * A tighter bound from the limiter's actual coefficients (outflow F/(1 + |r|), inflow −|F|ψ/2) converged T5 in 750
 * sweeps instead of 2050, but it depends on the solution. On the stable test case it still left a 6 % limit cycle,
 * and it made the GPU and CPU transients diverge (3.8e-3). It was therefore rejected (docs/04-dispersion.md §4.3).
 */

// Mask byte from which a cell is solid for the scalar: ≥ 250, the WindField.sample and voxel.js convention. voxel.js
// writes 255 for solids and stops porous bytes at 249, so this agrees with the LBM's own test (byte/255 > 0.99).
const sc_SOLID = 250;
const sc_SOLID_GLSL = ((sc_SOLID - 0.5) / 255).toFixed(6);   // the same threshold on the normalised R8 value
const sc_NP = 32;              // probe slots in the diagnostics target (18 receptor band cells, physics §5.9, plus spread probes)
const sc_EPS_AP = 1e-9;        // cells with a_P below this (fully enclosed) are set to zero, physics §5.2
const sc_BIG = 1e12;           // "infinite" squared distance for the distance transform (≫ 3·200², the largest grid diagonal²)
// Adaptive sweeps per frame, the reference's Aero.tick rule (maksimir-pod-kisom wind-tunnel.js): grow by 10 % while
// frames come faster than 26 fps, shrink by 10 % below 18 fps (ignoring hitches longer than 0.25 s).
const sc_ADAPT = { fast: 1 / 26, slow: 1 / 18, stall: 0.25, grow: 1.1, shrink: 0.9, startGPU: 8, startSoft: 1, maxGPU: 64, maxSoft: 8 };

I18N.add({
  hr: {
    'phys.scalar.name': 'Disperzija onečišćenja',
    'phys.scalar.progress': 'Disperzija: {pct} % ({sweeps} iteracija)',
    'phys.scalar.converged': 'konvergiralo nakon {sweeps} iteracija',
    'phys.scalar.notConverged': 'nije konvergiralo nakon {sweeps} iteracija – rezultat je približan',
    'phys.scalar.status': '{state}; bilanca mase {mass} %; ostatak {res}; divergencija strujanja {div} %',
    'phys.scalar.unsupported': 'Ovaj preglednik ne može računati disperziju na grafičkoj kartici (nema float render targeta); koristi se približni model.',
  },
  en: {
    'phys.scalar.name': 'Pollutant dispersion',
    'phys.scalar.progress': 'Dispersion: {pct} % ({sweeps} sweeps)',
    'phys.scalar.converged': 'converged after {sweeps} sweeps',
    'phys.scalar.notConverged': 'did not converge after {sweeps} sweeps – the result is approximate',
    'phys.scalar.status': '{state}; mass balance {mass} %; residual {res}; flow divergence {div} %',
    'phys.scalar.unsupported': 'This browser cannot compute the dispersion on the GPU (no float render targets); the approximate model is used.',
  },
});

// ------------------------------------------------------------------ grids, frames and the atlas
/*
 * A grid in the tunnelGrid() format {dx, up, nx, ny, nz, tx, W, H} (architecture §5.1). sc_makeGrid builds one
 * for synthetic tests; sc_completeGrid fills in the atlas fields of a grid that lacks them. The atlas layout is
 * the reference's: layer k is tile (k % tx, floor(k / tx)), cell (i, j, k) at texel (i + (k % tx)·nx, j + floor(k / tx)·ny).
 */
function sc_completeGrid(T) {
  const tx = T.tx || Math.ceil(Math.sqrt(T.nz));
  return { up: (T.nx * T.dx) / 2, ...T, tx, W: T.W || T.nx * tx, H: T.H || T.ny * Math.ceil(T.nz / tx) };
}
function sc_makeGrid(nx, ny, nz, dx, extra = {}) { return sc_completeGrid({ nx, ny, nz, dx, ...extra }); }

// The tunnel frame of the reference (x downwind, y across, origin on the ground at the inlet's near corner, the
// centre `up` metres downwind and centred across). voxel.js owns tunnelFrame(); this copy serves synthetic tests.
function sc_makeFrame(T, fromDeg = 270, center = new THREE.Vector3()) {
  const b = fromDeg * DEG;
  const ex = new THREE.Vector3(-Math.sin(b), 0, Math.cos(b));
  const ey = new THREE.Vector3(-ex.z, 0, ex.x);
  const origin = center.clone().addScaledVector(ex, -T.up).addScaledVector(ey, (-T.ny * T.dx) / 2);
  origin.y = 0;
  return { from: fromDeg, ex, ey, origin };
}

// Grid order (index ((k·ny + j)·nx + i)·ch) → atlas order (index (row·W + col)·ch), and back.
function sc_toAtlas(g, T, ch = 4, Type = Float32Array) {
  const { nx, ny, nz, tx, W, H } = T, out = new Type(W * H * ch), row = nx * ch;
  for (let k = 0; k < nz; k++) {
    const ox = (k % tx) * nx, oy = Math.floor(k / tx) * ny;
    for (let j = 0; j < ny; j++) out.set(g.subarray(((k * ny + j) * nx) * ch, ((k * ny + j) * nx) * ch + row), ((oy + j) * W + ox) * ch);
  }
  return out;
}
function sc_fromAtlas(a, T, ch = 4, Type = Float32Array) {
  const { nx, ny, nz, tx, W } = T, out = new Type(nx * ny * nz * ch), row = nx * ch;
  for (let k = 0; k < nz; k++) {
    const ox = (k % tx) * nx, oy = Math.floor(k / tx) * ny;
    for (let j = 0; j < ny; j++) out.set(a.subarray(((oy + j) * W + ox) * ch, ((oy + j) * W + ox) * ch + row), ((k * ny + j) * nx) * ch);
  }
  return out;
}

// A nearest-filtered data texture (float by default) for uploads to the solver.
function sc_dataTex(data, w, h, format, type = THREE.FloatType) {
  const t = new THREE.DataTexture(data, w, h, format, type);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------ closure on the CPU (per layer)
/*
 * The turbulence parameters come from meteo.js turbParams() (architecture §6.2):
 * {cls, L, ustar_hat, h_eff, z0, d, Hbar, Sct, lambda, kmin, kappa}. Missing fields fall back to SITE.model_defaults
 * (critic §4.5: κ 0.40, Sc_t 0.7, λ 30 m, K̂_min 0.02 m; z0 1.5 m, d 7 m, H̄ 14 m), a neutral Obukhov length (L = ∞),
 * no lid (h_eff = ∞) and the neutral blending-height friction velocity of physics Eq. 6.2–6.3.
 */
function sc_neutralUstar(kappa, z0, d, z0r, zb) {
  const ustarR = kappa / Math.log(10 / z0r);                    // physics Eq. 6.2, neutral (ψ_m = 0), 10 m reference wind
  const uzb = (ustarR / kappa) * Math.log(zb / z0r);            // wind at the blending height
  return (kappa * uzb) / Math.log((zb - d) / z0);               // physics Eq. 6.3
}
function sc_turbDefaults(turb) {
  const tb = turb || {}, md = (typeof MD !== 'undefined' && MD) || {};
  const kappa = tb.kappa ?? md.kappa ?? 0.4, z0 = tb.z0 ?? md.z0_m ?? 1.5, d = tb.d ?? md.d_m ?? 7, Hbar = tb.Hbar ?? md.Hbar_m ?? 14;
  const L = Number.isFinite(tb.L) && tb.L !== 0 ? tb.L : Infinity;
  return {
    cls: tb.cls ?? 'D', kappa, z0, d, Hbar, L,
    ustar_hat: tb.ustar_hat ?? sc_neutralUstar(kappa, z0, d, md.z0r_m ?? 0.3, md.zb_m ?? 80),
    h_eff: tb.h_eff ?? Infinity,
    Sct: tb.Sct ?? md.Sct ?? 0.7, lambda: tb.lambda ?? md.lambda_m ?? 30, kmin: tb.kmin ?? md.kmin_m ?? 0.02,
  };
}
// Businger–Dyer φ_h, physics Eq. 4.3 (stable branch capped at ζ = 1).
function sc_phiH(zeta) { return zeta < 0 ? 1 / Math.sqrt(1 - 16 * zeta) : 1 + 5 * Math.min(zeta, 1); }
/*
 * K̂_MO per layer, physics Eq. 4.2: κ û* ẑ / φ_h(ẑ/L) · (1 − z/h_eff)², ẑ = max(z, H̄) − d, held at its roof-level
 * value below H̄ (the canopy is mixed by roof-level eddies, OSPM-like). ẑ is floored at z0 so a d ≥ H̄ never
 * gives a negative length. Zero at and above the lid (the K̂_min floor still applies in the K-prep pass).
 */
function sc_kmoProfile(T, tb) {
  const out = new Float32Array(T.nz), invL = Number.isFinite(tb.L) ? 1 / tb.L : 0;
  for (let k = 0; k < T.nz; k++) {
    const zz = Math.max((k + 0.5) * T.dx, tb.Hbar);
    if (zz >= tb.h_eff) continue;
    const zh = Math.max(zz - tb.d, tb.z0);
    const lid = 1 - zz / tb.h_eff;
    out[k] = ((tb.kappa * tb.ustar_hat * zh) / sc_phiH(zh * invL)) * lid * lid;
  }
  return out;
}
// First layer above the mixing lid, physics §5.3: the no-flux lid sits on the cell face nearest to h_eff. A lid at
// or above the top leaves the top open (nz).
function sc_lidK(T, hEff) {
  if (!(hEff < T.nz * T.dx)) return T.nz;
  return clamp(Math.round(hEff / T.dx), 1, T.nz);
}

// ------------------------------------------------------------------ wall distance
/*
 * d_w for the mixing length (physics Eq. 4.4): distance from each cell centre to the nearest solid face or the
 * ground. Exact Euclidean distance transform between cell centres (Felzenszwalb & Huttenlocher 2012, separable
 * lower envelope of parabolas, three 1D passes), minus half a cell to reach the solid cell's face, and at most the
 * height of the centre above the ground. Porous cells (trees) are not walls: their drag already shows in the
 * resolved shear. This is the fallback for voxel.js wallDistance() (sc_wallDist below); the two differ only next
 * to edges and corners, where the exact nearest point of a cube is up to 0.3 cells closer than centre − ½ cell.
 */
function sc_edt1d(f, n, out, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}
function sc_wallDistance(grid, T) {
  const { nx, ny, nz, dx } = T, n = nx * ny * nz, d2 = new Float64Array(n);
  for (let q = 0; q < n; q++) d2[q] = grid[q] >= sc_SOLID ? 0 : sc_BIG;
  const m = Math.max(nx, ny, nz), f = new Float64Array(m), o = new Float64Array(m), v = new Int32Array(m), zz = new Float64Array(m + 1);
  const run = (count, base, stride) => {
    for (let a = 0; a < count; a++) f[a] = d2[base + a * stride];
    sc_edt1d(f, count, o, v, zz);
    for (let a = 0; a < count; a++) d2[base + a * stride] = o[a];
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) run(nx, (k * ny + j) * nx, 1);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) run(ny, k * ny * nx + i, nx);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) run(nz, j * nx + i, nx * ny);
  const out = new Float32Array(n);
  for (let k = 0; k < nz; k++) {
    const ground = (k + 0.5) * dx;
    for (let q = k * nx * ny; q < (k + 1) * nx * ny; q++) {
      if (grid[q] >= sc_SOLID) continue;
      out[q] = d2[q] < sc_BIG / 2 ? Math.min(ground, (Math.sqrt(d2[q]) - 0.5) * dx) : ground;
    }
  }
  return out;
}

// The wall distance used by a solve: voxel.js wallDistance() (the architecture's owner of d_w, §6.2) when it is
// loaded, else sc_wallDistance(). Both measure to the nearest solid face or the ground and treat porous cells as open.
function sc_wallDist(grid, T) {
  try { if (typeof wallDistance === 'function') return wallDistance(grid, T); } catch (e) { console.warn('scalar: voxel.js wallDistance failed, using sc_wallDistance', e); }
  return sc_wallDistance(grid, T);
}

// ------------------------------------------------------------------ sources
/*
 * The per-cell source weights σ_k·V from voxel.js (architecture §5.3), in grid order. Before the solve:
 * - a weight in a solid cell (a road under a passage roof, a heating layer inside a taller block) moves to the
 *   first open cell above it in the same column, so the emission is not silently lost; if the column has none
 *   below the lid it is dropped and counted;
 * - weights inside the last `spongeCells` columns before the outlet are dropped (physics §5.3: no sources in
 *   the LBM's sponge);
 * - the totals Φ_src,k = Σ σ_k V that remain are the reference for the mass balance.
 */
function sc_prepareSources(T, srcGrid, mask, lidK, spongeCells) {
  const { nx, ny, nz } = T, n = nx * ny * nz, src = new Float32Array(n * 4);
  const total = [0, 0, 0, 0], dropped = [0, 0, 0, 0], sponge = [0, 0, 0, 0];
  let moved = 0;
  const open = (q, k) => k < lidK && mask[q] < sc_SOLID;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const q = (k * ny + j) * nx + i;
    let any = false;
    for (let c = 0; c < 4; c++) if (srcGrid[q * 4 + c] !== 0) any = true;
    if (!any) continue;
    if (i >= nx - spongeCells) { for (let c = 0; c < 4; c++) sponge[c] += srcGrid[q * 4 + c]; continue; }
    let t = -1;
    for (let kk = k; kk < Math.min(nz, lidK); kk++) { const r = (kk * ny + j) * nx + i; if (open(r, kk)) { t = r; break; } }
    if (t < 0) { for (let c = 0; c < 4; c++) dropped[c] += srcGrid[q * 4 + c]; continue; }
    if (t !== q) moved++;
    for (let c = 0; c < 4; c++) { src[t * 4 + c] += srcGrid[q * 4 + c]; total[c] += srcGrid[q * 4 + c]; }
  }
  return { src, total, dropped, sponge, moved };
}

// ------------------------------------------------------------------ renderer
/*
 * Textures live in one WebGL context only, and the solver reads the wind tunnel's textures directly
 * (WindTunnel.flow()). So it draws with the page's renderer (scene.js) when there is one, else with the wind
 * tunnel's private one (WT_RENDERER, when wind-tunnel.js runs without the scene), and only when neither exists
 * (the scalar module on its own) with a 1×1 offscreen renderer of its own.
 */
function sc_renderer() {
  try { if (typeof renderer !== 'undefined' && renderer && renderer.isWebGLRenderer) return renderer; } catch (e) { /* not declared yet */ }
  try { if (typeof WT_RENDERER !== 'undefined' && WT_RENDERER && WT_RENDERER.isWebGLRenderer) return WT_RENDERER; } catch (e) { /* not declared yet */ }
  if (!sc_renderer.own) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    sc_renderer.own = new THREE.WebGLRenderer({ canvas: c, antialias: false, alpha: false, depth: false, stencil: false });
  }
  return sc_renderer.own;
}
function sc_isSoftware() {
  try { if (typeof LBM !== 'undefined' && LBM) return !!LBM.software; } catch (e) { /* not declared */ }
  try {
    const gl = sc_renderer().getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
    return /SwiftShader|llvmpipe|software/i.test(info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '');
  } catch (e) { return false; }
}

// ------------------------------------------------------------------ GLSL
/*
 * All fragment shaders run one fragment per atlas texel (a full-screen triangle, as in the reference). Grid sizes
 * are compiled in like the reference's lbmSources(). The stencil() function is shared by the sweep and the
 * residual pass so that the residual measures exactly the equations being iterated; sc_cpuSweep() below is its
 * line-by-line CPU twin.
 */
function sc_glsl(T) {
  const common = `precision highp float;
precision highp int;
precision highp sampler2D;
const int NX = ${T.nx}, NY = ${T.ny}, NZ = ${T.nz}, TX = ${T.tx};
const float DX = ${T.dx.toFixed(6)};
const float AF = DX * DX;          // face area [m²]
const float VC = DX * DX * DX;     // cell volume [m³]
ivec3 cellOf(ivec2 t) { int a = t.x / NX, b = t.y / NY; return ivec3(t.x - a * NX, t.y - b * NY, b * TX + a); }
ivec2 texOf(ivec3 c) { return ivec2(c.x + (c.z % TX) * NX, c.y + (c.z / TX) * NY); }
`;
  // K-prep, physics §5.5.1: û from the accumulated LBM mean, K̂ from the closure (Eq. 4.1–4.4); K̂ < 0 marks solids.
  const kprep = `${common}
uniform sampler2D uAvg;     // Σ lattice velocity over the samples (xyz), porous cells already divided as in the LBM acc pass
uniform sampler2D uMask;    // solid fraction, R8
uniform sampler2D uDw;      // wall distance [m], R32F
uniform float uAvgScale;    // 1 / (samples · U_lattice): lattice sum → fraction of U10
uniform float uKappa, uLambda, uSct, uKmin;
uniform float uKmo[NZ];     // K̂_MO(z_k) [m] for this stability class, physics Eq. 4.2
layout(location = 0) out vec4 oVK;
bool solid(ivec3 c) { return texelFetch(uMask, texOf(c), 0).r > ${sc_SOLID_GLSL}; }
bool open(ivec3 c) { return c.x >= 0 && c.y >= 0 && c.z >= 0 && c.x < NX && c.y < NY && c.z < NZ && !solid(c); }
vec3 U(ivec3 c) { return texelFetch(uAvg, texOf(c), 0).xyz * uAvgScale; }
// d û / d x_e: central differences, one-sided next to solids and the domain edges.
vec3 dU(ivec3 p, ivec3 e, vec3 up) {
  bool okH = open(p + e), okL = open(p - e);
  if (okH && okL) return (U(p + e) - U(p - e)) / (2.0 * DX);
  if (okH) return (U(p + e) - up) / DX;
  if (okL) return (up - U(p - e)) / DX;
  return vec3(0.0);
}
void main() {
  ivec3 p = cellOf(ivec2(gl_FragCoord.xy));
  if (p.z >= NZ || solid(p)) { oVK = vec4(0.0, 0.0, 0.0, -1.0); return; }
  vec3 up = U(p);
  mat3 G = mat3(dU(p, ivec3(1, 0, 0), up), dU(p, ivec3(0, 1, 0), up), dU(p, ivec3(0, 0, 1), up));  // G[j][i] = d û_i / d x_j
  mat3 S = 0.5 * (G + transpose(G));
  float s2 = dot(S[0], S[0]) + dot(S[1], S[1]) + dot(S[2], S[2]);
  float smag = sqrt(2.0 * s2);                                                                     // |Ŝ| [1/m]
  float dw = texelFetch(uDw, texOf(p), 0).r;
  float lm = 1.0 / (1.0 / (uKappa * max(dw, 0.5 * DX)) + 1.0 / uLambda);                           // physics Eq. 4.4
  float k = max(uKmo[p.z], lm * lm * smag / uSct);                                                // physics Eq. 4.1
  oVK = vec4(up, max(k, uKmin));
}`;
  // The finite-volume stencil of physics Eq. 5.1–5.3 with the boundary conditions of physics §5.3.
  const stencil = `
uniform sampler2D uVK, uSrc, uG, uA;
uniform float uGamma;       // TVD deferred-correction blend, 0 → 1 over the ramp
uniform int uLidK;          // first layer above the mixing lid; NZ = open top
const ivec3 E[6] = ivec3[6](ivec3(1, 0, 0), ivec3(-1, 0, 0), ivec3(0, 1, 0), ivec3(0, -1, 0), ivec3(0, 0, 1), ivec3(0, 0, -1));
bool inside(ivec3 c) { return c.x >= 0 && c.y >= 0 && c.z >= 0 && c.x < NX && c.y < NY && c.z < uLidK; }
vec4 VK(ivec3 c) { return texelFetch(uVK, texOf(c), 0); }
// Γ_f(TVD) − Γ_f(UD) for the face between upwind U and downwind D, far-upwind UU (van Leer, physics Eq. 5.3–5.4).
vec4 tvd(vec4 gU, vec4 gD, vec4 gUU) {
  vec4 den = gD - gU;
  vec4 r = (gU - gUU) * den / (den * den + 1e-30);
  return 0.5 * (r + abs(r)) / (1.0 + abs(r)) * den;
}
struct Stencil { float aP; float fout; vec4 sG; vec4 sA; vec4 dcG; vec4 dcA; vec4 outG; float netF; float absF; };
Stencil stencil(ivec3 p, vec4 vp, vec4 gP, vec4 aQ) {
  Stencil s;
  s.aP = 0.0; s.fout = 0.0; s.sG = vec4(0.0); s.sA = vec4(0.0); s.dcG = vec4(0.0); s.dcA = vec4(0.0); s.outG = vec4(0.0); s.netF = 0.0; s.absF = 0.0;
  for (int f = 0; f < 6; f++) {
    ivec3 n = p + E[f];
    if (n.z < 0) continue;                                   // ground: no flux (no deposition, physics §2.1)
    if (n.z >= uLidK && uLidK < NZ) continue;                // mixing lid inside the domain: no flux
    bool inDom = n.x >= 0 && n.y >= 0 && n.x < NX && n.y < NY && n.z < NZ;
    vec4 vn = vp;                                            // open boundary: the cell's own velocity
    if (inDom) { vn = VK(n); if (vn.w < 0.0) continue; }     // solid: no advective or diffusive flux
    float F = dot(0.5 * (vp.xyz + vn.xyz), vec3(E[f])) * AF; // outward normalised flux [m²], Eq. 5.1
    float D = inDom ? AF / DX * 2.0 * vp.w * vn.w / (vp.w + vn.w) : 0.0;   // zero-gradient at open boundaries
    float a = D + max(-F, 0.0);                              // Eq. 5.2
    s.aP += a; s.netF += F; s.absF += abs(F);
    if (inDom) {
      vec4 gN = texelFetch(uG, texOf(n), 0), aN = texelFetch(uA, texOf(n), 0);
      s.sG += a * gN; s.sA += a * aN;
      if (F > 0.0) s.fout += F;                              // outflow faces that can carry a correction (sc_relax)
      if (uGamma > 0.0 && F != 0.0) {                        // deferred correction, Eq. 5.3
        bool up = F > 0.0;                                   // flux leaves P: P is upwind
        ivec3 uu = up ? p - E[f] : n + E[f];
        if (inside(uu) && VK(uu).w >= 0.0) {                 // else r = 0: the face stays upwind
          vec4 gUU = texelFetch(uG, texOf(uu), 0), aUU = texelFetch(uA, texOf(uu), 0);
          s.dcG -= F * (up ? tvd(gP, gN, gUU) : tvd(gN, gP, gUU));
          s.dcA -= F * (up ? tvd(aQ, aN, aUU) : tvd(aN, aQ, aUU));
        }
      }
    } else if (F > 0.0) s.outG += F * gP;                    // outflow through an open face carries Γ_P (inflow brings 0)
  }
  return s;
}
`;
  // One Jacobi sweep (physics Eq. 5.5 and pseudocode §5.5.2): Γ and the age tracers A (MRT).
  const sweep = `${common}${stencil}
uniform float uOmega;
layout(location = 0) out vec4 oG;
layout(location = 1) out vec4 oA;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 p = cellOf(t);
  oG = vec4(0.0); oA = vec4(0.0);
  if (p.z >= uLidK) return;                                  // padding tiles and cells above the lid
  vec4 vp = texelFetch(uVK, t, 0);
  if (vp.w < 0.0) return;
  vec4 gP = texelFetch(uG, t, 0), aQ = texelFetch(uA, t, 0);
  Stencil s = stencil(p, vp, gP, aQ);
  if (s.aP < ${sc_EPS_AP.toExponential()}) return;
  vec4 src = texelFetch(uSrc, t, 0);                         // σ_k V [m or m²]
  vec4 gNew = (s.sG + src + uGamma * s.dcG) / s.aP;
  vec4 aNew = (s.sA + gP * VC + uGamma * s.dcA) / s.aP;     // age source Γ V (physics Eq. 5.8)
  float wP = uOmega * s.aP / (s.aP + uGamma * s.fout);       // local relaxation: Harten bound of the pseudo-time step (sc_relax)
  oG = max(mix(gP, gNew, wP), 0.0);
  oA = max(mix(aQ, aNew, wP), 0.0);
}`;
  // Residual, outflow and divergence per cell, to be summed by the reduction (physics §5.7).
  const resid = `${common}${stencil}
layout(location = 0) out vec4 oR;    // |a_P Γ_P − Σ a_f Γ_N − σV − γ b_DC| per group
layout(location = 1) out vec4 oOut;  // advective outflow F⁺ Γ_P through open boundary faces, per group
layout(location = 2) out vec4 oX;    // (|Σ_f F_f|, Σ_f |F_f|, 0, 1 per fluid cell)
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 p = cellOf(t);
  oR = vec4(0.0); oOut = vec4(0.0); oX = vec4(0.0);
  if (p.z >= uLidK) return;
  vec4 vp = texelFetch(uVK, t, 0);
  if (vp.w < 0.0) return;
  vec4 gP = texelFetch(uG, t, 0), aQ = texelFetch(uA, t, 0);
  Stencil s = stencil(p, vp, gP, aQ);
  oX = vec4(abs(s.netF), s.absF, 0.0, 1.0);
  if (s.aP < ${sc_EPS_AP.toExponential()}) return;
  vec4 src = texelFetch(uSrc, t, 0);
  oR = abs(s.aP * gP - (s.sG + src + uGamma * s.dcG));
  oOut = s.outG;
}`;
  // 4×4 block sums of three textures at once; repeated down to 1×1 (a log₄ reduction, physics §5.7).
  const reduce = `precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uR0, uR1, uR2;
uniform ivec2 uInSize;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy) * 4;
  vec4 s0 = vec4(0.0), s1 = vec4(0.0), s2 = vec4(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    ivec2 q = b + ivec2(i, j);
    if (q.x < uInSize.x && q.y < uInSize.y) { s0 += texelFetch(uR0, q, 0); s1 += texelFetch(uR1, q, 0); s2 += texelFetch(uR2, q, 0); }
  }
  o0 = s0; o1 = s1; o2 = s2;
}`;
  // The diagnostics target (NP × 3): row 0 Γ at the probes, row 1 A at the probes, row 2 the three reduced sums.
  const diag = `${common}
uniform sampler2D uG, uA, uR0, uR1, uR2;
uniform vec3 uProbe[${sc_NP}];   // probe cells (i, j, k); x < 0 = unused slot
layout(location = 0) out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  o = vec4(0.0);
  if (t.y == 2) {
    if (t.x == 0) o = texelFetch(uR0, ivec2(0), 0);
    else if (t.x == 1) o = texelFetch(uR1, ivec2(0), 0);
    else if (t.x == 2) o = texelFetch(uR2, ivec2(0), 0);
    return;
  }
  vec3 c = uProbe[t.x];
  if (c.x < 0.0) return;
  ivec2 q = texOf(ivec3(c + 0.5));
  o = t.y == 0 ? texelFetch(uG, q, 0) : texelFetch(uA, q, 0);
}`;
  // Start values: a prolongated coarser solution (physics §5.5.3) or zero.
  const init = `precision highp float;
precision highp sampler2D;
uniform sampler2D uSeedG, uSeedA;
uniform float uSeeded;
layout(location = 0) out vec4 oG;
layout(location = 1) out vec4 oA;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  oG = uSeeded > 0.5 ? texelFetch(uSeedG, t, 0) : vec4(0.0);
  oA = uSeeded > 0.5 ? texelFetch(uSeedA, t, 0) : vec4(0.0);
}`;
  // Copy one texture (e.g. one MRT attachment) into a single-attachment target for readback.
  const copy = `precision highp float;
precision highp sampler2D;
uniform sampler2D uCopy;
uniform float uCopyScale;
layout(location = 0) out vec4 o;
void main() { o = texelFetch(uCopy, ivec2(gl_FragCoord.xy), 0) * uCopyScale; }`;
  return { vertex: 'in vec3 position;\nvoid main() { gl_Position = vec4(position.xy, 0.0, 1.0); }', kprep, sweep, resid, reduce, diag, init, copy };
}

// ------------------------------------------------------------------ solver
/*
 * One solver per grid T (like one WindTunnel per grid). begin() prepares a solve, advance() runs sweeps (spread over
 * frames by the caller, or adaptively with advance()), done tells when it has converged or hit the cap, and
 * collect() reads the result back asynchronously into a ScalarField and frees the solver for the next job.
 *
 *   const s = new ScalarSolver(TUNNEL);
 *   s.begin(windTunnel.flow(), rasterizeSources(geo, frame, TUNNEL), turbParams('D', morph), frame);
 *   // each frame: s.advance();   when s.done: const field = await s.collect();
 */
class ScalarSolver {
  // Float render targets and three draw buffers (the residual pass) are needed.
  static get supported() {
    try {
      const r = sc_renderer(), gl = r.getContext();
      return !!(r.capabilities.isWebGL2 && r.extensions.has('EXT_color_buffer_float') && gl.getParameter(gl.MAX_DRAW_BUFFERS) >= 3);
    } catch (e) { return false; }
  }

  /*
   * A flow object (the shape WindTunnel.flow() returns) from a CPU WindField, so that a cached flow can serve
   * another stability group (architecture §6.2, aero.js). WindField.data already holds fractions of U10, hence
   * samples = uLattice = 1. The textures are freed after the next begin() unless opts.keepFlow is set; dispose()
   * frees them explicitly.
   */
  static flowFromField(wf) {
    const T = sc_completeGrid(wf.T || { nx: wf.nx, ny: wf.ny, nz: wf.nz, dx: wf.dx });
    const avg = sc_dataTex(sc_toAtlas(wf.data, T, 4), T.W, T.H, THREE.RGBAFormat);
    const mask = sc_dataTex(sc_toAtlas(wf.mask, T, 1, Uint8Array), T.W, T.H, THREE.RedFormat, THREE.UnsignedByteType);
    return {
      avg, mask, samples: 1, uLattice: 1, grid: wf.mask, T, frame: wf.frame, from: wf.from, sc_owned: true,
      dispose() { avg.dispose(); mask.dispose(); },
    };
  }

  constructor(T) {
    this.T = T = sc_completeGrid(T);
    this.r = sc_renderer();
    const rt = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false };
    this.rtOpts = rt;
    this.vk = new THREE.WebGLRenderTarget(T.W, T.H, rt);                              // (û, v̂, ŵ, K̂)
    this.ga = [0, 1].map(() => new THREE.WebGLRenderTarget(T.W, T.H, { ...rt, count: 2 }));   // (Γ, A) ping-pong
    this.res = new THREE.WebGLRenderTarget(T.W, T.H, { ...rt, count: 3 });            // residual pass
    this.levels = [];
    for (let w = T.W, h = T.H; w > 1 || h > 1;) {
      w = Math.ceil(w / 4); h = Math.ceil(h / 4);
      this.levels.push(new THREE.WebGLRenderTarget(w, h, { ...rt, count: 3 }));
    }
    this.diag = new THREE.WebGLRenderTarget(sc_NP, 3, rt);
    this.rb = null;                                                                    // W×H readback target, made on first collect()
    this.srcTex = sc_dataTex(new Float32Array(T.W * T.H * 4), T.W, T.H, THREE.RGBAFormat);
    this.dwTex = sc_dataTex(new Float32Array(T.W * T.H), T.W, T.H, THREE.RedFormat);
    this.seedTex = null;
    const src = sc_glsl(T);
    this.u = {
      uAvg: { value: null }, uMask: { value: null }, uDw: { value: this.dwTex }, uAvgScale: { value: 1 },
      uKappa: { value: 0.4 }, uLambda: { value: 30 }, uSct: { value: 0.7 }, uKmin: { value: 0.02 }, uKmo: { value: new Float32Array(T.nz) },
      uVK: { value: this.vk.texture }, uSrc: { value: this.srcTex }, uG: { value: null }, uA: { value: null },
      uGamma: { value: 0 }, uLidK: { value: T.nz }, uOmega: { value: sc_DEFAULTS.omega },
      uR0: { value: null }, uR1: { value: null }, uR2: { value: null }, uInSize: { value: new THREE.Vector2(T.W, T.H) },
      uProbe: { value: new Float32Array(sc_NP * 3).fill(-1) },
      uSeedG: { value: null }, uSeedA: { value: null }, uSeeded: { value: 0 }, uCopy: { value: null }, uCopyScale: { value: 1 },
    };
    const mat = (fs) => new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: src.vertex, fragmentShader: fs, uniforms: this.u, depthTest: false, depthWrite: false });
    this.mat = { kprep: mat(src.kprep), sweep: mat(src.sweep), resid: mat(src.resid), reduce: mat(src.reduce), diag: mat(src.diag), init: mat(src.init), copy: mat(src.copy) };
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(g, this.mat.init);
    this.quad.frustumCulled = false;
    this.qScene = new THREE.Scene();
    this.qScene.add(this.quad);
    this.qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.software = sc_isSoftware();
    this.perFrame = this.software ? sc_ADAPT.startSoft : sc_ADAPT.startGPU;
    this.lastCall = 0;
    this.job = null;
    this.seq = 0;
  }

  // One full-screen pass into a target. autoClear is suspended: every texel is written anyway.
  pass(m, target) {
    const r = this.r, ac = r.autoClear;
    r.autoClear = false;
    this.quad.material = m;
    r.setRenderTarget(target);
    r.render(this.qScene, this.qCam);
    r.autoClear = ac;
  }

  // The flow's solid mask as a CPU grid: given, on the flow, in its DataTexture, or read back from the GPU.
  maskGrid(flow, opts) {
    const T = this.T, n = T.nx * T.ny * T.nz;
    if (opts.grid && opts.grid.length === n) return opts.grid;
    if (flow.grid && flow.grid.length === n) return flow.grid;
    const img = flow.mask && flow.mask.image;
    if (img && img.data instanceof Uint8Array && img.data.length === T.W * T.H) return sc_fromAtlas(img.data, T, 1, Uint8Array);
    const tmp = new THREE.WebGLRenderTarget(T.W, T.H, { ...this.rtOpts, type: THREE.UnsignedByteType });
    this.u.uCopy.value = flow.mask; this.u.uCopyScale.value = 1;
    this.pass(this.mat.copy, tmp);
    const px = new Uint8Array(T.W * T.H * 4);
    this.r.readRenderTargetPixels(tmp, 0, 0, T.W, T.H, px);
    this.r.setRenderTarget(null);
    tmp.dispose();
    const atlas = new Uint8Array(T.W * T.H);
    for (let q = 0; q < atlas.length; q++) atlas[q] = px[q * 4];
    return sc_fromAtlas(atlas, T, 1, Uint8Array);
  }

  /*
   * Prepare a solve.
   *   flow  {avg, samples, uLattice, mask[, grid, T]}: WindTunnel.flow() or ScalarSolver.flowFromField()
   *   src   Float32Array(W·H·4): per-cell source weights σ_k V in the atlas layout (voxel.js rasterizeSources)
   *   turb  meteo.js turbParams() (defaults: sc_turbDefaults)
   *   frame the tunnel frame {from, ex, ey, origin} (world ↔ grid for probes and the ScalarField)
   *   opts  overrides of sc_DEFAULTS, plus: grid (Uint8Array mask), wallDist (Float32Array, m), lidK, probes
   *         ([[i,j,k], …]), seed (a ScalarField of the same direction on a coarser grid, prolongated trilinearly
   *         as the start; physics §5.5.3)
   */
  begin(flow, src, turb, frame, opts = {}) {
    const T = this.T, n = T.nx * T.ny * T.nz, o = { ...sc_DEFAULTS, ...opts }, u = this.u;
    // A seeded start is already a smooth TVD solution, so the γ ramp (meant for the start from zero, critic §4.4) is
    // skipped and convergence may be declared after one window: measured 650 instead of 800 sweeps on the T1 grid.
    if (o.seed && opts.ramp === undefined) o.ramp = 1;
    if (o.seed && opts.minSweeps === undefined) o.minSweeps = o.window;
    if (flow.T && (flow.T.nx !== T.nx || flow.T.ny !== T.ny || flow.T.nz !== T.nz)) throw new Error('ScalarSolver.begin: flow grid differs from the solver grid');
    if (!src || src.length !== T.W * T.H * 4) throw new Error(`ScalarSolver.begin: src must be Float32Array(${T.W * T.H * 4})`);
    const tb = sc_turbDefaults(turb), lidK = o.lidK ?? sc_lidK(T, tb.h_eff);
    const grid = this.maskGrid(flow, o);
    const dw = o.wallDist && o.wallDist.length === n ? o.wallDist : sc_wallDist(grid, T);
    const prep = sc_prepareSources(T, sc_fromAtlas(src, T, 4), grid, lidK, Math.round(o.spongeFree / T.dx));
    this.srcTex.image.data.set(sc_toAtlas(prep.src, T, 4)); this.srcTex.needsUpdate = true;
    this.dwTex.image.data.set(sc_toAtlas(dw, T, 1)); this.dwTex.needsUpdate = true;
    // K-prep (physics §5.5.1), once per flow and stability class.
    const uLat = flow.uLattice ?? (typeof U_LATTICE !== 'undefined' ? U_LATTICE : 0.075);   // U_LATTICE 0.075, architecture §5.2
    u.uAvg.value = flow.avg; u.uMask.value = flow.mask;
    u.uAvgScale.value = 1 / (Math.max(1, flow.samples || 0) * uLat);
    u.uKappa.value = tb.kappa; u.uLambda.value = tb.lambda; u.uSct.value = tb.Sct; u.uKmin.value = tb.kmin;
    u.uKmo.value.set(sc_kmoProfile(T, tb));
    u.uLidK.value = lidK; u.uOmega.value = o.omega;
    this.pass(this.mat.kprep, this.vk);
    // Start values.
    u.uSeeded.value = 0;
    if (o.seed) {
      const { g, a } = sc_prolong(o.seed, T, frame);
      if (!this.seedTex) this.seedTex = [0, 1].map(() => sc_dataTex(new Float32Array(T.W * T.H * 4), T.W, T.H, THREE.RGBAFormat));
      this.seedTex[0].image.data.set(sc_toAtlas(g, T, 4)); this.seedTex[0].needsUpdate = true;
      this.seedTex[1].image.data.set(sc_toAtlas(a, T, 4)); this.seedTex[1].needsUpdate = true;
      u.uSeedG.value = this.seedTex[0]; u.uSeedA.value = this.seedTex[1];
      u.uSeeded.value = 1;
    }
    this.pass(this.mat.init, this.ga[0]);
    this.r.setRenderTarget(null);
    if (flow.sc_owned && !o.keepFlow) flow.dispose();
    const probes = sc_probeCells(T, frame, o.probes);
    const pv = u.uProbe.value.fill(-1);
    probes.forEach((c, s) => pv.set(c, s * 3));
    this.job = {
      id: ++this.seq, frame, turb: tb, opts: o, grid, lidK, prep, probes, t0: performance.now(),
      sweeps: 0, cur: 0, pending: 0, checkDue: false, hist: [], diag: null, done: false, converged: false, reason: '',
      progress: 0, expected: o.ramp + 3 * T.nx,   // first guess: the ramp plus a few flow-throughs (physics §5.7)
    };
  }

  // The number of sweeps for this frame, adapted to the frame rate (sc_ADAPT, the reference's rule).
  autoCount() {
    const now = performance.now(), dt = (now - this.lastCall) / 1000, most = this.software ? sc_ADAPT.maxSoft : sc_ADAPT.maxGPU;
    this.lastCall = now;
    if (dt < sc_ADAPT.fast) this.perFrame = Math.min(most, Math.ceil(this.perFrame * sc_ADAPT.grow));
    else if (dt > sc_ADAPT.slow && dt < sc_ADAPT.stall) this.perFrame = Math.max(1, Math.floor(this.perFrame * sc_ADAPT.shrink));
    return this.perFrame;
  }

  /*
   * Run up to n sweeps (default: an adaptive number for this frame) and return the progress 0..1. A convergence
   * check is issued every checkEvery sweeps; its result arrives a few frames later and may set done.
   *
   * Flow control: at most one check's readback is on its way; when the next check point is reached before it has
   * arrived, advance() pauses there (returns without work) until it does. Without this, a caller that submits faster than the GPU runs
   * (SwiftShader, or a tight test loop) builds a long command queue, and the fences behind the asynchronous readbacks
   * are only seen once the queue has drained: convergence would go unnoticed until maxSweeps (measured: one result
   * in 1500 sweeps on SwiftShader). It also keeps the queue, and so the page's latency, short.
   */
  advance(n) {
    const j = this.job;
    if (!j) return 1;
    if (j.done) return 1;
    const count = n === undefined || n === null || n === 'auto' ? this.autoCount() : Math.max(0, Math.floor(n));
    const u = this.u;
    for (let s = 0; s < count && j.sweeps < j.opts.maxSweeps && !j.done; s++) {
      if (j.checkDue) {                       // a check point reached while the previous readback was out
        if (j.pending > 0) break;             // wait for it (flow control)
        this.check(); j.checkDue = false;
      }
      u.uGamma.value = j.opts.tvd ? Math.min(1, j.sweeps / j.opts.ramp) : 0;
      u.uG.value = this.ga[j.cur].textures[0]; u.uA.value = this.ga[j.cur].textures[1];
      this.pass(this.mat.sweep, this.ga[1 - j.cur]);
      j.cur = 1 - j.cur;
      j.sweeps++;
      if (j.sweeps % j.opts.checkEvery === 0) { if (j.pending > 0) j.checkDue = true; else this.check(); }
    }
    if (j.checkDue && j.pending === 0 && !j.done) { this.check(); j.checkDue = false; }
    if (j.sweeps >= j.opts.maxSweeps && !j.done) { j.done = true; j.reason = 'maxSweeps'; }
    this.r.setRenderTarget(null);
    return this.progress;
  }

  get done() { return !!(this.job && this.job.done); }
  get sweeps() { return this.job ? this.job.sweeps : 0; }
  get progress() {
    const j = this.job;
    if (!j) return 1;
    if (j.done) return 1;
    const p = Math.max(j.sweeps / j.opts.maxSweeps, j.sweeps / Math.max(j.expected, 1));
    j.progress = Math.max(j.progress, Math.min(0.99, p));
    return j.progress;
  }

  // Residual, reduction and diagnostics passes on the current iterate (physics §5.7); returns the diag target.
  diagPasses() {
    const j = this.job, u = this.u;
    u.uGamma.value = j.opts.tvd ? Math.min(1, j.sweeps / j.opts.ramp) : 0;
    u.uG.value = this.ga[j.cur].textures[0]; u.uA.value = this.ga[j.cur].textures[1];
    this.pass(this.mat.resid, this.res);
    let prev = this.res, w = this.T.W, h = this.T.H;
    for (const lv of this.levels) {
      u.uR0.value = prev.textures[0]; u.uR1.value = prev.textures[1]; u.uR2.value = prev.textures[2];
      u.uInSize.value.set(w, h);
      this.pass(this.mat.reduce, lv);
      prev = lv; w = lv.width; h = lv.height;
    }
    u.uR0.value = prev.textures[0]; u.uR1.value = prev.textures[1]; u.uR2.value = prev.textures[2];
    this.pass(this.mat.diag, this.diag);
    return this.diag;
  }

  // Asynchronous readback (reference: renderer.readRenderTargetPixelsAsync); synchronous where unavailable.
  readAsync(target, buf) {
    const r = this.r;
    if (typeof r.readRenderTargetPixelsAsync !== 'function') { r.readRenderTargetPixels(target, 0, 0, target.width, target.height, buf); return Promise.resolve(buf); }
    const p = r.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height, buf);
    // three leaves its pixel-pack buffer bound until the read completes; unbind so that any synchronous readPixels
    // elsewhere in the page (e.g. a capability probe) is not redirected into it. three rebinds it before reading.
    try { const gl = r.getContext(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); } catch (e) { /* no context */ }
    return p;
  }

  check() {
    const j = this.job, s = j.sweeps, buf = new Float32Array(sc_NP * 3 * 4);
    this.diagPasses();
    j.pending++;
    this.readAsync(this.diag, buf).then(() => { j.pending--; if (this.job === j) this.onDiag(s, buf); },
      (e) => { j.pending--; console.warn('ScalarSolver: diagnostics readback failed', e); });
  }

  // Interpret one diagnostics readback (physics §5.7) and decide convergence.
  onDiag(s, buf) {
    const j = this.job, o = j.opts, d = sc_parseDiag(buf, j.prep.total);
    d.s = s;
    j.hist.push(d);
    const prev = j.hist.filter((h) => h.s <= s - o.window).pop();
    if (prev) {
      d.probeChange = Math.max(sc_relChange(d.g, prev.g), sc_relChange(d.a, prev.a));
      d.massChange = 0;
      for (let c = 0; c < 4; c++) if (j.prep.total[c] > 0) d.massChange = Math.max(d.massChange, Math.abs(d.mass[c] - prev.mass[c]));
      // Remaining sweeps from the observed geometric decay of the probe change (progress estimate only).
      if (prev.probeChange > 0 && d.probeChange > 0 && d.probeChange < prev.probeChange) {
        const rate = Math.log(d.probeChange / prev.probeChange) / (s - prev.s);
        j.expected = Math.max(j.expected * 0.5, s + Math.max(0, Math.log(o.tolProbe / d.probeChange) / rate));
      } else if (d.probeChange > o.tolProbe) j.expected = Math.max(j.expected, s * 1.5);
    }
    j.hist = j.hist.filter((h) => h.s > s - 3 * o.window);
    j.diag = d;
    // Mass criterion: the balance has SETTLED (changes < tolProbe per window). Whether it also closes to tolMass is a
    // quality flag in stats (massWithinTol): a persistent mismatch is the flow's own divergence error (physics §5.7).
    const massSettled = d.massChange !== undefined && d.massChange < o.tolProbe;
    if (!j.done && s >= o.minSweeps && d.probeChange !== undefined && d.probeChange < o.tolProbe && (d.residual < o.tolRes || massSettled)) {
      j.converged = true; j.done = true; j.reason = 'converged';
    }
  }

  /*
   * Read the result back (asynchronously) and free the solver. A final diagnostics pass gives the stats of the state
   * actually returned. Collecting before done is allowed; stats.converged then says false.
   */
  async collect() {
    const j = this.job, T = this.T;
    if (!j) throw new Error('ScalarSolver.collect: no job');
    if (!this.rb) this.rb = new THREE.WebGLRenderTarget(T.W, T.H, this.rtOpts);
    const dbuf = new Float32Array(sc_NP * 3 * 4), gbuf = new Float32Array(T.W * T.H * 4), abuf = new Float32Array(T.W * T.H * 4);
    this.diagPasses();
    const pd = this.readAsync(this.diag, dbuf);
    this.u.uCopyScale.value = 1;
    this.u.uCopy.value = this.ga[j.cur].textures[0];
    this.pass(this.mat.copy, this.rb);
    const pg = this.readAsync(this.rb, gbuf);
    this.u.uCopy.value = this.ga[j.cur].textures[1];
    this.pass(this.mat.copy, this.rb);
    const pa = this.readAsync(this.rb, abuf);
    this.r.setRenderTarget(null);
    this.job = null;
    await Promise.all([pd, pg, pa]);
    const d = sc_parseDiag(dbuf, j.prep.total), last = j.diag || {};
    const stats = {
      sweeps: j.sweeps, converged: j.converged, reason: j.reason || 'stopped',
      residual: d.residual, residualByGroup: d.resByGroup, mass: d.mass, massErr: d.massErr, massWithinTol: d.massErr < j.opts.tolMass, divergence: d.div,
      probeChange: last.probeChange ?? null, massSrc: j.prep.total.slice(), massOut: d.out,
      srcMoved: j.prep.moved, srcDropped: j.prep.dropped.slice(), srcSponge: j.prep.sponge.slice(),
      lidK: j.lidK, turb: j.turb, tvd: j.opts.tvd, ms: Math.round(performance.now() - j.t0),
    };
    return new ScalarField({ T, frame: j.frame, gamma: sc_fromAtlas(gbuf, T, 4), age: sc_fromAtlas(abuf, T, 4), mask: j.grid, lidK: j.lidK, stats });
  }

  // (û, v̂, ŵ, K̂) after the K-prep pass, in grid order: a diagnostic for tests and the docs.
  async readVK() {
    const T = this.T, buf = new Float32Array(T.W * T.H * 4);
    if (!this.rb) this.rb = new THREE.WebGLRenderTarget(T.W, T.H, this.rtOpts);
    this.u.uCopy.value = this.vk.texture; this.u.uCopyScale.value = 1;
    this.pass(this.mat.copy, this.rb);
    this.r.setRenderTarget(null);
    await this.readAsync(this.rb, buf);
    return sc_fromAtlas(buf, T, 4);
  }

  dispose() {
    for (const t of [this.vk, ...this.ga, this.res, ...this.levels, this.diag, this.rb]) if (t) t.dispose();
    for (const t of [this.srcTex, this.dwTex, ...(this.seedTex || [])]) t.dispose();
    for (const m of Object.values(this.mat)) m.dispose();
    this.quad.geometry.dispose();
    this.job = null;
  }
}

// ------------------------------------------------------------------ diagnostics helpers
/*
 * sc_parseDiag turns the 32×3 diagnostics readback into numbers: the probe values, the residual per group
 * normalised by the group's source Φ_src (physics §5.7 criterion 2), the mass ratio Φ_out/Φ_src per group
 * (criterion 3; NaN for a group without sources) and the flow divergence ε_div (physics §5.2).
 */
function sc_parseDiag(buf, total) {
  const NP = sc_NP, row2 = buf.subarray(8 * NP);
  const res = row2.subarray(0, 4), out = row2.subarray(4, 8), x = row2.subarray(8, 12);
  const d = { g: buf.slice(0, 4 * NP), a: buf.slice(4 * NP, 8 * NP), resByGroup: [], mass: [], out: Array.from(out), residual: 0, massErr: 0 };
  for (let c = 0; c < 4; c++) {
    if (total[c] > 0) {
      d.resByGroup.push(res[c] / total[c]); d.mass.push(out[c] / total[c]);
      d.residual = Math.max(d.residual, res[c] / total[c]); d.massErr = Math.max(d.massErr, Math.abs(out[c] / total[c] - 1));
    } else { d.resByGroup.push(NaN); d.mass.push(NaN); }
  }
  d.div = x[1] > 0 ? x[0] / x[1] : 0;
  d.fluidCells = x[3];
  return d;
}
// Largest change of the probes between two readbacks, relative to each probe's value but never to less than 1e-3
// of the channel's largest probe (so a probe at the plume edge does not dominate). Channels without values are skipped.
function sc_relChange(now, prev) {
  let worst = 0;
  for (let c = 0; c < 4; c++) {
    let top = 0;
    for (let p = 0; p < sc_NP; p++) top = Math.max(top, Math.abs(now[p * 4 + c]));
    if (!(top > 1e-30)) continue;
    for (let p = 0; p < sc_NP; p++) {
      const v = now[p * 4 + c];
      worst = Math.max(worst, Math.abs(v - prev[p * 4 + c]) / Math.max(Math.abs(v), 1e-3 * top));
    }
  }
  return worst;
}
/*
 * Probe cells: the 3×3×2 representativeness band around the receptor (physics §5.9, critic §1.6), then points
 * spread along and across the tunnel near the ground (they watch the plume develop), then any given in opts.
 */
function sc_probeCells(T, frame, extra) {
  const cells = [], seen = new Set(), add = (i, j, k) => {
    i = clamp(Math.round(i), 0, T.nx - 1); j = clamp(Math.round(j), 0, T.ny - 1); k = clamp(Math.round(k), 0, T.nz - 1);
    const key = `${i},${j},${k}`;
    if (!seen.has(key) && cells.length < sc_NP) { seen.add(key); cells.push([i, j, k]); }
  };
  const rc = frame && typeof RECEPTOR !== 'undefined' ? sc_worldToGrid(frame, T, RECEPTOR) : null;
  if (rc && rc[0] >= 0 && rc[1] >= 0 && rc[0] <= T.nx - 1 && rc[1] <= T.ny - 1) {
    const i0 = Math.round(rc[0]), j0 = Math.round(rc[1]), k0 = Math.floor(clamp(rc[2], 0, T.nz - 1.001));
    for (let dk = 0; dk < 2; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) add(i0 + di, j0 + dj, k0 + dk);
  }
  for (const f of [0.25, 0.5, 0.75, 0.9]) for (const k of [0, T.nz / 8]) add(f * T.nx, T.ny / 2, k);
  for (const [fi, fj] of [[0.5, 0.25], [0.5, 0.75], [0.75, 0.3], [0.75, 0.7], [0.6, 0.5], [0.4, 0.5]]) add(fi * T.nx, fj * T.ny, 0);
  for (const c of extra || []) add(c[0], c[1], c[2]);
  return cells;
}
// World point → fractional cell coordinates (cell centres at integers), the WindField.sample convention.
function sc_worldToGrid(f, T, p) {
  const rx = p.x - f.origin.x, rz = p.z - f.origin.z;
  return [(rx * f.ex.x + rz * f.ex.z) / T.dx - 0.5, (rx * f.ey.x + rz * f.ey.z) / T.dx - 0.5, p.y / T.dx - 0.5];
}
// A coarser ScalarField sampled at the centres of this grid (initial guess, physics §5.5.3).
function sc_prolong(seed, T, frame) {
  const { nx, ny, nz, dx } = T, g = new Float32Array(nx * ny * nz * 4), a = new Float32Array(nx * ny * nz * 4), out = new Float32Array(8), p = new THREE.Vector3();
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    p.copy(frame.origin).addScaledVector(frame.ex, (i + 0.5) * dx).addScaledVector(frame.ey, (j + 0.5) * dx);
    p.y = (k + 0.5) * dx;
    if (!seed.sample(p, out)) continue;
    const q = ((k * ny + j) * nx + i) * 4;
    for (let c = 0; c < 4; c++) { g[q + c] = out[c]; a[q + c] = out[4 + c]; }
  }
  return { g, a };
}

// ------------------------------------------------------------------ the result
/*
 * The steady unit responses of one (scenario, direction, stability group) on the tunnel grid (architecture §6.2):
 * gamma = Γ_k and age = A_k per cell, 4 groups each, in grid order ((k·ny + j)·nx + i)·4. Units: see the file header.
 * sample() interpolates trilinearly over the fluid cells only (like WindField.sample), receptor() adds the 3×3×2
 * representativeness band (physics §5.9), slice() gives a horizontal section for the concentration map.
 */
class ScalarField {
  constructor({ T, frame, gamma, age, mask, lidK, stats, from }) {
    T = sc_completeGrid(T);
    const { nx, ny, nz, dx } = T, n = nx * ny * nz;
    Object.assign(this, { T, frame, nx, ny, nz, dx, gamma, age, mask: mask || new Uint8Array(n), lidK: lidK ?? nz, stats: stats || {} });
    this.from = from ?? (frame ? frame.from : null);
    // The cells the solve covers: open (mask below the solid threshold) and below the mixing lid.
    this.fluid = new Uint8Array(n);
    for (let q = 0; q < n; q++) this.fluid[q] = this.mask[q] < sc_SOLID && Math.floor(q / (nx * ny)) < this.lidK ? 1 : 0;
  }

  // Trilinear average over the fluid neighbours into out[0..3] = Γ, out[4..7] = A. False outside the tunnel.
  sample(p, out) {
    if (!this.frame) return false;
    const { nx, ny, nz } = this;
    const [gx, gy, gz0] = sc_worldToGrid(this.frame, this.T, p), gz = clamp(gz0, 0, nz - 1.001);
    if (!(gx >= 0 && gy >= 0 && gx <= nx - 1.001 && gy <= ny - 1.001)) return false;
    const i0 = Math.floor(gx), j0 = Math.floor(gy), k0 = Math.floor(gz), tx = gx - i0, ty = gy - j0, tz = gz - k0;
    for (let c = 0; c < 8; c++) out[c] = 0;
    let ws = 0;
    for (let c = 0; c < 8; c++) {
      const i = i0 + (c & 1), j = j0 + ((c >> 1) & 1), k = Math.min(nz - 1, k0 + (c >> 2)), q = (k * ny + j) * nx + i;
      if (!this.fluid[q]) continue;
      const w = (c & 1 ? tx : 1 - tx) * ((c >> 1) & 1 ? ty : 1 - ty) * (c >> 2 ? tz : 1 - tz);
      for (let g = 0; g < 4; g++) { out[g] += w * this.gamma[q * 4 + g]; out[4 + g] += w * this.age[q * 4 + g]; }
      ws += w;
    }
    if (ws > 1e-4) for (let c = 0; c < 8; c++) out[c] /= ws;
    return true;
  }

  /*
   * Γ and A at the receptor (default: the ZAGREB-1 inlet, RECEPTOR = (0, 4 m, 0)), plus the band [min, max] of Γ
   * over the 3×3×2 cells around it (fluid cells only): the grid-resolution uncertainty shown in the UI (physics §5.9,
   * critic §1.6; the ±1-cell band also covers the 4.5 m offset between the DHMZ and ISZZ coordinates).
   */
  receptor(p = RECEPTOR) {
    const out = new Float32Array(8), inside = this.sample(p, out);
    const gamma = Array.from(out.subarray(0, 4)), age = Array.from(out.subarray(4, 8));
    const band = gamma.map((v) => [v, v]);
    if (inside) {
      const { nx, ny, nz } = this, [gx, gy, gz] = sc_worldToGrid(this.frame, this.T, p);
      const ic = Math.round(gx), jc = Math.round(gy), k0 = Math.floor(clamp(gz, 0, nz - 1.001));
      const lo = [Infinity, Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity, -Infinity];
      for (let dk = 0; dk < 2; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const i = ic + di, j = jc + dj, k = Math.min(nz - 1, k0 + dk);
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const q = (k * ny + j) * nx + i;
        if (!this.fluid[q]) continue;
        for (let g = 0; g < 4; g++) { lo[g] = Math.min(lo[g], this.gamma[q * 4 + g]); hi[g] = Math.max(hi[g], this.gamma[q * 4 + g]); }
      }
      for (let g = 0; g < 4; g++) if (lo[g] <= hi[g]) band[g] = [Math.min(lo[g], gamma[g]), Math.max(hi[g], gamma[g])];
    }
    return { gamma, age, band, inside };
  }

  /*
   * A horizontal section at h metres above the ground in the tunnel's own grid (x downwind, y across): data holds
   * 8 values per column (Γ_A..D, A_A..D), linearly interpolated between the two layers around h over fluid cells.
   * solid marks columns where both layers are solid (data stays 0 there). frame and dx place it in the world.
   */
  slice(h) {
    const { nx, ny, nz, dx } = this, data = new Float32Array(nx * ny * 8), solid = new Uint8Array(nx * ny);
    const gz = clamp(h / dx - 0.5, 0, nz - 1.001), k0 = Math.floor(gz), k1 = Math.min(nz - 1, k0 + 1), tz = gz - k0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const q0 = (k0 * ny + j) * nx + i, q1 = (k1 * ny + j) * nx + i, s = j * nx + i;
      const w0 = this.fluid[q0] ? 1 - tz : 0, w1 = this.fluid[q1] ? tz : 0, ws = w0 + w1;
      if (!(ws > 1e-6)) { solid[s] = 1; continue; }
      for (let c = 0; c < 4; c++) {
        data[s * 8 + c] = (w0 * this.gamma[q0 * 4 + c] + w1 * this.gamma[q1 * 4 + c]) / ws;
        data[s * 8 + 4 + c] = (w0 * this.age[q0 * 4 + c] + w1 * this.age[q1 * 4 + c]) / ws;
      }
    }
    return { nx, ny, dx, h, frame: this.frame, data, solid };
  }

  // A one-line status for the UI ("no silent caps", architecture §7).
  describe() {
    const s = this.stats, state = s.converged ? t('phys.scalar.converged', { sweeps: s.sweeps }) : t('phys.scalar.notConverged', { sweeps: s.sweeps });
    const mass = (s.mass || []).filter(Number.isFinite), m = mass.length ? mass.reduce((a, b) => a + b, 0) / mass.length : NaN;
    return t('phys.scalar.status', { state, mass: fmt(m * 100, 1), res: Number.isFinite(s.residual) ? s.residual.toExponential(1) : '–', div: fmt((s.divergence || 0) * 100, 1) });
  }
}

// ------------------------------------------------------------------ CPU reference implementation
/*
 * The same discretisation in plain JavaScript, statement for statement (K-prep: the kprep shader; sweep: the sweep
 * shader with stencil()). It is slow (≈ 1 µs per cell and sweep) and meant for small grids: the tests run both on
 * the same inputs and compare cell by cell. Arrays are in grid order; vel holds (û, v̂, ŵ, ·) per cell.
 */
function sc_cpuKprep(T, vel, mask, dw, kmo, tb) {
  const { nx, ny, nz, dx } = T, n = nx * ny * nz, out = new Float32Array(n * 4);
  const idx = (i, j, k) => (k * ny + j) * nx + i;
  const open = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && mask[idx(i, j, k)] < sc_SOLID;
  const E = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], G = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const q = idx(i, j, k);
    if (mask[q] >= sc_SOLID) { out[q * 4 + 3] = -1; continue; }
    for (let e = 0; e < 3; e++) {
      const [a, b, c] = E[e], okH = open(i + a, j + b, k + c), okL = open(i - a, j - b, k - c);
      const qh = okH ? idx(i + a, j + b, k + c) : -1, ql = okL ? idx(i - a, j - b, k - c) : -1;
      for (let m = 0; m < 3; m++) {
        const up = vel[q * 4 + m];
        G[e][m] = okH && okL ? (vel[qh * 4 + m] - vel[ql * 4 + m]) / (2 * dx) : okH ? (vel[qh * 4 + m] - up) / dx : okL ? (up - vel[ql * 4 + m]) / dx : 0;
      }
    }
    let s2 = 0;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) { const s = 0.5 * (G[a][b] + G[b][a]); s2 += s * s; }
    const smag = Math.sqrt(2 * s2);
    const lm = 1 / (1 / (tb.kappa * Math.max(dw[q], 0.5 * dx)) + 1 / tb.lambda);
    const K = Math.max(kmo[k], (lm * lm * smag) / tb.Sct);
    out[q * 4] = vel[q * 4]; out[q * 4 + 1] = vel[q * 4 + 1]; out[q * 4 + 2] = vel[q * 4 + 2]; out[q * 4 + 3] = Math.max(K, tb.kmin);
  }
  return out;
}
function sc_cpuTvd(gU, gD, gUU) {
  const den = gD - gU, r = ((gU - gUU) * den) / (den * den + 1e-30);
  return (0.5 * (r + Math.abs(r))) / (1 + Math.abs(r)) * den;
}
function sc_cpuSweep(T, vk, src, G, A, G2, A2, gam, omega, lidK) {
  const { nx, ny, nz, dx } = T, AF = dx * dx, VC = dx * dx * dx;
  const E = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const sG = new Float64Array(4), sA = new Float64Array(4), dcG = new Float64Array(4), dcA = new Float64Array(4);
  const inside = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < lidK;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = (k * ny + j) * nx + i, P = p * 4;
    for (let c = 0; c < 4; c++) { G2[P + c] = 0; A2[P + c] = 0; }
    if (k >= lidK || vk[P + 3] < 0) continue;
    let aP = 0, fout = 0;
    sG.fill(0); sA.fill(0); dcG.fill(0); dcA.fill(0);
    for (let f = 0; f < 6; f++) {
      const [ex, ey, ez] = E[f], ni = i + ex, nj = j + ey, nk = k + ez;
      if (nk < 0) continue;
      if (nk >= lidK && lidK < nz) continue;
      const inDom = ni >= 0 && nj >= 0 && ni < nx && nj < ny && nk < nz;
      const N = inDom ? ((nk * ny + nj) * nx + ni) * 4 : P;
      if (inDom && vk[N + 3] < 0) continue;
      const F = (0.5 * (vk[P] + vk[N]) * ex + 0.5 * (vk[P + 1] + vk[N + 1]) * ey + 0.5 * (vk[P + 2] + vk[N + 2]) * ez) * AF;
      const D = inDom ? (AF / dx) * ((2 * vk[P + 3] * vk[N + 3]) / (vk[P + 3] + vk[N + 3])) : 0;
      const a = D + Math.max(-F, 0);
      aP += a;
      if (!inDom) continue;
      if (F > 0) fout += F;
      for (let c = 0; c < 4; c++) { sG[c] += a * G[N + c]; sA[c] += a * A[N + c]; }
      if (gam > 0 && F !== 0) {
        const up = F > 0, ui = up ? i - ex : ni + ex, uj = up ? j - ey : nj + ey, uk = up ? k - ez : nk + ez;
        if (inside(ui, uj, uk) && vk[((uk * ny + uj) * nx + ui) * 4 + 3] >= 0) {
          const UU = ((uk * ny + uj) * nx + ui) * 4;
          for (let c = 0; c < 4; c++) {
            dcG[c] -= F * (up ? sc_cpuTvd(G[P + c], G[N + c], G[UU + c]) : sc_cpuTvd(G[N + c], G[P + c], G[UU + c]));
            dcA[c] -= F * (up ? sc_cpuTvd(A[P + c], A[N + c], A[UU + c]) : sc_cpuTvd(A[N + c], A[P + c], A[UU + c]));
          }
        }
      }
    }
    if (aP < sc_EPS_AP) continue;
    const wP = (omega * aP) / (aP + gam * fout);   // sc_relax: the local relaxation of the GLSL sweep
    for (let c = 0; c < 4; c++) {
      const gNew = (sG[c] + src[P + c] + gam * dcG[c]) / aP, aNew = (sA[c] + G[P + c] * VC + gam * dcA[c]) / aP;
      G2[P + c] = Math.max(G[P + c] * (1 - wP) + gNew * wP, 0);   // GLSL mix(gP, gNew, ω_P)
      A2[P + c] = Math.max(A[P + c] * (1 - wP) + aNew * wP, 0);
    }
  }
}
/*
 * sc_cpuSolve({T, vel, mask, src, turb, wallDist?, lidK?}, {sweeps, omega, ramp, tvd, spongeFree})
 *   → {gamma, age, vk, src, lidK, sweeps}. src is σ_k V in GRID order (the GPU solver takes the atlas); the same
 *   source preparation, K-prep, γ ramp and sweep count as the GPU solver, so both return the same iterate.
 */
function sc_cpuSolve(prob, opts = {}) {
  const T = sc_completeGrid(prob.T), n = T.nx * T.ny * T.nz, o = { ...sc_DEFAULTS, sweeps: 1000, ...opts };
  const tb = sc_turbDefaults(prob.turb), lidK = prob.lidK ?? sc_lidK(T, tb.h_eff);
  const mask = prob.mask || new Uint8Array(n), dw = prob.wallDist || sc_wallDist(mask, T);
  const vk = prob.vk || sc_cpuKprep(T, prob.vel, mask, dw, sc_kmoProfile(T, tb), tb);
  const prep = sc_prepareSources(T, prob.src, mask, lidK, Math.round(o.spongeFree / T.dx));
  let G = new Float32Array(n * 4), A = new Float32Array(n * 4), G2 = new Float32Array(n * 4), A2 = new Float32Array(n * 4);
  for (let s = 0; s < o.sweeps; s++) {
    sc_cpuSweep(T, vk, prep.src, G, A, G2, A2, o.tvd ? Math.min(1, s / o.ramp) : 0, o.omega, lidK);
    [G, G2] = [G2, G]; [A, A2] = [A2, A];
  }
  return { gamma: G, age: A, vk, src: prep.src, total: prep.total, lidK, sweeps: o.sweeps };
}
