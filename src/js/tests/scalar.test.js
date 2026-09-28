// ------------------------------------------------------------------ scalar solver verification (src/js/scalar.js)
/*
 * Verification of the GPU steady advection–diffusion solver against exact solutions and against its own CPU twin
 * (physics §5.10, critic §4.4). All tests build small synthetic grids with prescribed flows, so they need no LBM,
 * except T3 and T4, which run the wind tunnel (flow-owned; skipped with a note when WindTunnel is missing) and are
 * marked slow.
 *
 *   python3 tests/browser/run_selftest.py --only scalar              # all of them
 *   python3 tests/browser/run_selftest.py --only scalar --skip-slow  # without T3/T4
 *
 * Every test returns its measured numbers (shown by the runner and copied into docs/04-dispersion.md §8).
 * Helpers are prefixed sct_ (the test files share one scope with the app).
 */

const sct_tick = () => new Promise((r) => setTimeout(r, 0));

// A WindField-like object (architecture §5.2) from a velocity function vel(i, j, k) → [û, v̂, ŵ] and an optional
// mask function solid(i, j, k) → byte (255 solid, 1–249 porous, 0 fluid). Velocities in solid cells are zeroed,
// as the LBM's acc pass leaves them.
function sct_field(T, vel, solid = null, fromDeg = 270) {
  T = sc_completeGrid(T);
  const { nx, ny, nz } = T, n = nx * ny * nz, data = new Float32Array(n * 4), mask = new Uint8Array(n);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const q = (k * ny + j) * nx + i, m = solid ? solid(i, j, k) : 0;
    mask[q] = m;
    if (m >= sc_SOLID) continue;
    const v = vel(i, j, k);
    data[q * 4] = v[0]; data[q * 4 + 1] = v[1]; data[q * 4 + 2] = v[2]; data[q * 4 + 3] = Math.hypot(v[0], v[1], v[2]);
  }
  return { T, nx, ny, nz, dx: T.dx, data, mask, frame: sc_makeFrame(T, fromDeg), from: fromDeg };
}
// Source weights σ_k V in grid order from fn(i, j, k) → [4] or null.
function sct_src(T, fn) {
  const { nx, ny, nz } = T, out = new Float32Array(nx * ny * nz * 4);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = fn(i, j, k);
    if (v) out.set(v, ((k * ny + j) * nx + i) * 4);
  }
  return out;
}
// A converged GPU solve (or one stopped by maxSweeps), exactly as the app runs it.
async function sct_solve(T, wf, srcGrid, turb, opts = {}) {
  T = sc_completeGrid(T);
  const s = new ScalarSolver(T);
  try {
    s.begin(ScalarSolver.flowFromField(wf), sc_toAtlas(srcGrid, T, 4), turb, wf.frame, opts);
    for (let guard = 0; !s.done; guard++) {
      s.advance(opts.perCall || 50);
      await sct_tick();
      if (guard > 100000) throw new Error('sct_solve: no end');
    }
    return await s.collect();
  } finally { s.dispose(); }
}
// Exactly `sweeps` sweeps on the GPU (no convergence stop), with the K-prep result, for the CPU comparison.
async function sct_gpuSweeps(T, wf, srcGrid, turb, sweeps, opts = {}) {
  T = sc_completeGrid(T);
  const s = new ScalarSolver(T);
  try {
    s.begin(ScalarSolver.flowFromField(wf), sc_toAtlas(srcGrid, T, 4), turb, wf.frame, { ...opts, checkEvery: 1e9, maxSweeps: sweeps + 1 });
    s.advance(sweeps);
    const vk = await s.readVK();
    return { vk, field: await s.collect() };
  } finally { s.dispose(); }
}
// max |a − b| / max |b| over channel c of two 4-channel arrays (all channels when c < 0).
function sct_relDiff(a, b, c = -1) {
  let top = 0, worst = 0;
  for (let q = 0; q < b.length; q++) if (c < 0 || q % 4 === c) top = Math.max(top, Math.abs(b[q]));
  for (let q = 0; q < b.length; q++) if (c < 0 || q % 4 === c) worst = Math.max(worst, Math.abs(a[q] - b[q]));
  return top > 0 ? worst / top : worst;
}
const sct_r = (x, d = 4) => Number(x.toPrecision(d));

// ------------------------------------------------------------------ special functions for the exact solutions
// erf, Abramowitz & Stegun 7.1.26 (|ε| ≤ 1.5e-7).
function sct_erf(x) {
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
// √s·eˢ·K0(s) and √s·eˢ·K1(s) for s ≥ 2, Abramowitz & Stegun 9.8.6 and 9.8.8 (|ε| < 2.2e-7).
function sct_k0s(s) { const y = 2 / s; return 1.25331414 + y * (-0.07832358 + y * (0.02189568 + y * (-0.01062446 + y * (0.00587872 + y * (-0.0025154 + y * 0.00053208))))); }
function sct_k1s(s) { const y = 2 / s; return 1.25331414 + y * (0.23498619 + y * (-0.0365562 + y * (0.01504268 + y * (-0.00780353 + y * (0.00325614 + y * -0.00068245))))); }
// 4-point Gauss–Legendre nodes and weights on [0, 1].
const sct_GL4 = [[0.0694318442, 0.1739274226], [0.3300094782, 0.3260725774], [0.6699905218, 0.3260725774], [0.9305681558, 0.1739274226]];

// ------------------------------------------------------------------ T1 set-up (shared by T1, T2 and the age test)
/*
 * A crosswind line source on the ground in uniform flow û = 1 with constant K̂ (K̂_MO = 0, K̂_min = K̂): the flow is
 * along x, the line spans the whole width, so the problem is two-dimensional (x, z). 96 × 24 × 24 cells of 5 m
 * (480 × 120 × 120 m), source in the ground cell of column 4 (x_s = 22.5 m), σV = Δx per cell (unit line strength).
 * K̂ = 2 m keeps the plume resolved (σ_z = √(2K̂x) = 14 m = 2.8 cells at x = 50 m) and is in the range the closure
 * gives above roof level (physics §4.2: κ û* ẑ ≈ 0.4 · 0.16 · 30 ≈ 2 m at 37 m).
 */
const sct_T1 = { nx: 96, ny: 24, nz: 24, dx: 5, K: 2, is: 4 };
let sct_t1cache = null;
async function sct_t1() {
  if (sct_t1cache) return sct_t1cache;
  const P = sct_T1, T = sc_makeGrid(P.nx, P.ny, P.nz, P.dx);
  const wf = sct_field(T, () => [1, 0, 0]);
  const src = sct_src(T, (i, j, k) => (i === P.is && k === 0 ? [P.dx, 0, 0, 0] : null));
  const turb = { ustar_hat: 0, kmin: P.K, h_eff: Infinity };
  const t0 = performance.now();
  const tvd = await sct_solve(T, wf, src, turb, { spongeFree: 0 });
  const t1 = performance.now();
  const up = await sct_solve(T, wf, src, turb, { spongeFree: 0, tvd: false });
  sct_t1cache = { T, wf, src, turb, tvd, up, msTVD: Math.round(t1 - t0), msUp: Math.round(performance.now() - t1) };
  return sct_t1cache;
}
/*
 * Errors against the slender-plume solution Γ = exp(−z²/(4K̂x))/√(πK̂x) (physics §5.10 T1), cell-averaged in z with
 * erf, and against the full 2D solution with along-wind diffusion Γ = (1/(πK̂)) e^{x/2K̂} K0(r/2K̂) (ground-reflected
 * steady point source in the (x, z) plane), cell-averaged with 4-point Gauss. Errors are relative to the ground-level
 * value at the same x, over x = 55 … 350 m (x > 10Δx) and all heights.
 */
function sct_t1Errors(field) {
  const P = sct_T1, { nx, ny, nz, dx } = field, K = P.K, j = ny >> 1;
  const out = { slender: 0, slenderGround: 0, full: 0, rows: [] };
  for (let i = P.is + 11; i <= P.is + 70; i++) {
    const x = (i - P.is) * dx, s2 = 2 * Math.sqrt(K * x);
    const an = (k) => (sct_erf(((k + 1) * dx) / s2) - sct_erf((k * dx) / s2)) / dx;
    const full = (k) => {
      let s = 0;
      for (const [u, w] of sct_GL4) {
        const z = (k + u) * dx, r = Math.hypot(x, z), sb = r / (2 * K);
        s += (w * (Math.exp((x - r) / (2 * K)) * sct_k0s(sb))) / Math.sqrt(sb) / (Math.PI * K);
      }
      return s;
    };
    const g0 = an(0), f0 = full(0);
    for (let k = 0; k < nz; k++) {
      const v = field.gamma[((k * ny + j) * nx + i) * 4];
      const e = Math.abs(v - an(k)) / g0, ef = Math.abs(v - full(k)) / f0;
      out.slender = Math.max(out.slender, e); out.full = Math.max(out.full, ef);
      if (k === 0) out.slenderGround = Math.max(out.slenderGround, e);
    }
    if ([55, 100, 200, 300].includes(x)) out.rows.push({ x, num: sct_r(field.gamma[(j * nx + i) * 4]), slender: sct_r(g0), full: sct_r(f0) });
  }
  return out;
}

// ------------------------------------------------------------------ unit checks of the CPU helpers
test('scalar: atlas layout, closure profile and wall distance (CPU helpers)', async () => {
  // Atlas round trip on a grid whose tiles do not fill the atlas (nz = 5, tx = 3).
  const T = sc_makeGrid(7, 4, 5, 5), n = 7 * 4 * 5, g = new Float32Array(n * 4).map((_, q) => q);
  const back = sc_fromAtlas(sc_toAtlas(g, T, 4), T, 4);
  for (let q = 0; q < g.length; q++) assert(back[q] === g[q], 'atlas round trip');
  // K̂_MO (physics Eq. 4.2): neutral, held at its roof-level value below H̄; zero above a lid; unstable > neutral > stable.
  const Tz = sc_makeGrid(4, 4, 32, 5);
  const neu = sc_kmoProfile(Tz, sc_turbDefaults({ ustar_hat: 0.164, h_eff: 100 }));
  const kappa = MD.kappa, H = MD.Hbar_m, d = MD.d_m;
  assertClose(neu[0], kappa * 0.164 * (H - d) * (1 - H / 100) ** 2, 1e-6, 'K_MO below roof');
  assertClose(neu[1], neu[0], 1e-9, 'constant in the canopy');
  assertClose(neu[5], kappa * 0.164 * (27.5 - d) * (1 - 27.5 / 100) ** 2, 1e-6, 'K_MO at 27.5 m');
  assert(neu[20] === 0 && neu[31] === 0, 'zero above the lid');
  const st = sc_kmoProfile(Tz, sc_turbDefaults({ ustar_hat: 0.164, h_eff: 100, L: 30 }));
  const un = sc_kmoProfile(Tz, sc_turbDefaults({ ustar_hat: 0.164, h_eff: 100, L: -30 }));
  assert(un[5] > neu[5] && neu[5] > st[5], 'stability ordering of K_MO');
  assertClose(st[5] * sc_phiH((27.5 - d) / 30), neu[5], 1e-6, 'phi_h stable');
  // Neutral blending-height friction velocity (physics §6.2 example: 0.162 for z0 1.4, d 8; here z0 1.5, d 7).
  assertClose(sc_neutralUstar(0.4, 1.4, 8, 0.3, 80), 0.162, 0.001, 'u*^ physics example');
  // Lid layer (physics §5.3): face nearest h_eff, open top above the domain.
  assert(sc_lidK(Tz, 100) === 20 && sc_lidK(Tz, 161) === 32 && sc_lidK(Tz, Infinity) === 32 && sc_lidK(Tz, 1) === 1, 'lidK');
  // Wall distance: one solid cell in the middle of an 11³ grid, and the ground.
  const Tw = sc_makeGrid(11, 11, 11, 2), m = new Uint8Array(11 ** 3);
  m[(5 * 11 + 5) * 11 + 5] = 255;
  const dw = sc_wallDistance(m, Tw), at = (i, j, k) => dw[(k * 11 + j) * 11 + i];
  assertClose(at(5, 5, 7), 1.5 * 2, 1e-6, 'face distance above the block');
  assertClose(at(6, 5, 5), 0.5 * 2, 1e-6, 'face neighbour');
  assertClose(at(6, 6, 5), (Math.SQRT2 - 0.5) * 2, 1e-6, 'edge neighbour');
  assertClose(at(0, 0, 3), 3.5 * 2, 1e-6, 'ground distance');
  const info = { kmoNeutral_m: [sct_r(neu[0]), sct_r(neu[5]), sct_r(neu[10])], kmoStable_m: sct_r(st[5]), kmoUnstable_m: sct_r(un[5]) };
  // voxel.js wallDistance (flow-owned) should agree to a fraction of a cell where both are defined.
  if (typeof wallDistance === 'function') {
    const dv = wallDistance(m, Tw);
    let worst = 0;
    for (let q = 0; q < dv.length; q++) worst = Math.max(worst, Math.abs(dv[q] - dw[q]));
    assert(worst <= 0.5 * 2 + 1e-6, `voxel.js wallDistance differs by ${worst} m`);
    info.voxelWallDistanceMaxDiff_cells = sct_r(worst / 2, 3);
  }
  return info;
});

// ------------------------------------------------------------------ GPU = CPU
/*
 * The GPU solver and sc_cpuSolve on the same inputs, cell by cell, after the same number of sweeps: a 32 × 16 × 12
 * grid with a solid block, a porous crown (fluid), a smooth non-uniform flow, sources in all four groups, the full
 * closure (K-prep from the strain and the wall distance), and two stability cases: stable with the lid inside the
 * domain (h_eff = 40 m → lid at layer 8) and unstable with an open top. 260 sweeps cover the whole γ ramp.
 */
test('scalar: GPU solver matches the CPU reference cell by cell', async () => {
  const T = sc_makeGrid(32, 16, 12, 5), sweeps = 260;
  const solid = (i, j, k) => (i >= 12 && i <= 15 && j >= 6 && j <= 9 && k <= 3 ? 255 : i >= 20 && i <= 22 && j >= 2 && j <= 4 && k <= 2 ? 120 : 0);
  const wf = sct_field(T, (i, j, k) => [0.8 + 0.2 * Math.sin(0.3 * i + 0.2 * k), 0.2 * Math.cos(0.25 * j + 0.1 * i), 0.05 * Math.sin(0.2 * i + 0.3 * j)], solid);
  const src = sct_src(T, (i, j, k) => {
    const v = [0, 0, 0, 0];
    if (i === 3 && k === 0) v[0] = 5;                                 // a crosswind road
    if (j === 11 && k === 0 && i < 24) v[1] = 5 * 0.7;                 // an along-wind road
    if (i === 14 && j === 7 && k === 0) v[2] = 2;                      // under the block: moved up to the first open cell
    if (k === 1 && i >= 4 && i <= 8 && j >= 2 && j <= 13) v[3] = 25;    // heating, area 25 m² per cell
    return v;
  });
  const cases = { stableLid: { ustar_hat: 0.12, L: 50, h_eff: 40 }, unstableOpen: { ustar_hat: 0.2, L: -30, h_eff: Infinity } };
  const info = {};
  for (const [name, turb] of Object.entries(cases)) {
    const gpu = await sct_gpuSweeps(T, wf, src, turb, sweeps, { spongeFree: 0 });
    const cpu = sc_cpuSolve({ T, vel: wf.data, mask: wf.mask, src, turb }, { sweeps, spongeFree: 0 });
    assert(gpu.field.lidK === cpu.lidK, 'same lid');
    const dK = sct_relDiff(gpu.vk, cpu.vk, 3), dU = sct_relDiff(gpu.vk, cpu.vk, 0);
    const dG = [0, 1, 2, 3].map((c) => sct_relDiff(gpu.field.gamma, cpu.gamma, c));
    const dA = [0, 1, 2, 3].map((c) => sct_relDiff(gpu.field.age, cpu.age, c));
    assert(dU < 1e-6, `velocity upload differs ${dU}`);
    assert(dK < 1e-5, `K-prep differs ${dK}`);
    for (let c = 0; c < 4; c++) { assert(dG[c] < 1e-4, `Gamma group ${c} differs ${dG[c]}`); assert(dA[c] < 1e-4, `age group ${c} differs ${dA[c]}`); }
    let kmax = 0;
    for (let q = 3; q < cpu.vk.length; q += 4) kmax = Math.max(kmax, cpu.vk[q]);
    info[name] = { lidK: cpu.lidK, maxRelDiffK: sct_r(dK, 2), maxRelDiffGamma: dG.map((x) => sct_r(x, 2)), maxRelDiffAge: dA.map((x) => sct_r(x, 2)), Kmax_m: sct_r(kmax, 3), srcMoved: gpu.field.stats.srcMoved };
  }
  return info;
});

// ------------------------------------------------------------------ T1 analytic line source
test('scalar T1: ground line source in uniform flow vs the analytic solution', async () => {
  const { tvd, up, msTVD, msUp } = await sct_t1();
  const eT = sct_t1Errors(tvd), eU = sct_t1Errors(up);
  assert(tvd.stats.converged, `TVD solve did not converge (${tvd.stats.sweeps} sweeps)`);
  assert(eT.slender < 0.05, `TVD error ${eT.slender} ≥ 5 %`);
  return {
    tvd: { maxErr: sct_r(eT.slender, 3), groundErr: sct_r(eT.slenderGround, 3), maxErrVsFull2D: sct_r(eT.full, 3), sweeps: tvd.stats.sweeps, ms: msTVD },
    upwind: { maxErr: sct_r(eU.slender, 3), groundErr: sct_r(eU.slenderGround, 3), maxErrVsFull2D: sct_r(eU.full, 3), sweeps: up.stats.sweeps, ms: msUp },
    groundTVD: eT.rows, groundUpwind: eU.rows.map((r) => r.num),
  };
});

// ------------------------------------------------------------------ T1b crosswind numerical diffusion
/*
 * The flow of T1 is aligned with the grid, so first-order upwind adds numerical diffusion only along the wind, where
 * it hardly matters. Here the flow runs diagonally (45°) through a 64 × 64 × 2 grid past a vertical line source
 * (a point source of the horizontal plane): upwind now diffuses ACROSS the plume, K_num ≈ (Δx/2)(|û| sin²θ + |v̂| cos²θ)
 * = 1.77 m against K̂ = 1 m, and the TVD correction has to remove it. Compared with the slender-plume solution
 * Γ = exp(−y'²/(4K̂x'))/√(4πK̂x') (cell-averaged, 4×4 Gauss) along the plume axis for x' = 57 … 283 m, plus the
 * effective diffusivity from the crosswind second moment, σ² = 2 K_eff x'.
 */
test('scalar T1b: diagonal flow, crosswind numerical diffusion (TVD vs upwind)', async () => {
  const n = 64, dx = 5, K = 1, is = 8, c = Math.SQRT1_2, T = sc_makeGrid(n, n, 2, dx);
  const wf = sct_field(T, () => [c, c, 0]);
  const src = sct_src(T, (i, j) => (i === is && j === is ? [dx, 0, 0, 0] : null));
  const turb = { ustar_hat: 0, kmin: K, h_eff: Infinity };
  const xs = (is + 0.5) * dx;
  const slender = (i, j) => {
    let s = 0;
    for (const [u, wu] of sct_GL4) for (const [v, wv] of sct_GL4) {
      const x = (i + u) * dx - xs, y = (j + v) * dx - xs, a = (x + y) * c, b = (y - x) * c;
      if (a > 0) s += wu * wv * Math.exp(-(b * b) / (4 * K * a)) / Math.sqrt(4 * Math.PI * K * a);
    }
    return s;
  };
  const evalField = (f) => {
    let worst = 0;
    const kEff = [];
    for (let m = 8; m <= 40; m++) {
      const i = is + m, v = f.gamma[(i * n + i) * 4], a = slender(i, i);
      worst = Math.max(worst, Math.abs(v - a) / a);
    }
    for (const m of [16, 24, 32]) {   // crosswind second moment through the axis point (is + m, is + m)
      let s0 = 0, s2 = 0;
      for (let d = -m; d <= m; d++) {
        const i = is + m + d, j = is + m - d;
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const v = f.gamma[(j * n + i) * 4], y = d * dx * Math.SQRT2;
        s0 += v; s2 += v * y * y;
      }
      kEff.push(sct_r(s2 / s0 / (2 * m * dx * Math.SQRT2) / K, 3));
    }
    return { maxAxisErr: sct_r(worst, 3), KeffOverK: kEff, sweeps: f.stats.sweeps };
  };
  const eT = evalField(await sct_solve(T, wf, src, turb, { spongeFree: 0 }));
  const eU = evalField(await sct_solve(T, wf, src, turb, { spongeFree: 0, tvd: false }));
  assert(eT.maxAxisErr < eU.maxAxisErr, 'TVD must beat upwind across the wind');
  return { tvd: eT, upwind: eU, KnumUpwindTheory: sct_r((dx / 2) * (c * 0.5 + c * 0.5) / K + 1, 3) };
});

// ------------------------------------------------------------------ T2 mass balance
test('scalar T2: mass balance (outflow = source)', async () => {
  const { tvd, up, T } = await sct_t1();
  const src = sct_T1.dx * T.ny;                     // Φ_src: unit line across the whole width
  assertClose(tvd.stats.massSrc[0], src, 1e-3, 'source total');
  // An independent CPU count of the outflow through the outlet face (û = 1, F = Δx² per cell).
  let out = 0;
  for (let k = 0; k < T.nz; k++) for (let j = 0; j < T.ny; j++) out += tvd.gamma[((k * T.ny + j) * T.nx + T.nx - 1) * 4] * T.dx * T.dx;
  const r = [tvd.stats.mass[0], up.stats.mass[0], out / src];
  for (const x of r) assert(Math.abs(x - 1) < 0.01, `mass ratio ${x} outside 1 ± 1 %`);
  return { massRatioTVD: sct_r(r[0], 6), massRatioUpwind: sct_r(r[1], 6), massRatioCPUcount: sct_r(r[2], 6), residualTVD: tvd.stats.residual, divergence: tvd.stats.divergence };
});

// ------------------------------------------------------------------ plume age
/*
 * In the slender-plume limit A = Γ·x/û exactly (every particle at x has travelled x/û). With along-wind diffusion,
 * the exact steady 2D result for a ground point source is A/Γ = (r/û)·K1(s)/K0(s), s = û r/(2K̂) ≈ r/û + K̂/û²
 * (moments of the advection–diffusion Green's function; docs/04-dispersion.md §6). Checked at the ground cells:
 * against the exact value within 3 % for x > 10Δx, and against the naive x/û within 5 % for x ≥ 20Δx (at 11Δx the
 * physical K̂/û² = 2 m plus a numerical ≈ 1.3 m source-cell offset are 6 % of x; both are reported).
 */
test('scalar age: age tracer A/Γ ≈ x/û in uniform flow', async () => {
  const { tvd, up } = await sct_t1();
  const P = sct_T1, K = P.K;
  const ev = (f) => {
    const { nx, ny, dx } = f, j = ny >> 1;
    let vsX = 0, vsX20 = 0, vsExact = 0;
    const rows = [];
    for (let i = P.is + 11; i <= P.is + 70; i++) {
      const q = (j * nx + i) * 4, x = (i - P.is) * dx, r = Math.hypot(x, 0.5 * dx), s = r / (2 * K);
      const ratio = f.age[q] / f.gamma[q], exact = (r * sct_k1s(s)) / sct_k0s(s);
      vsX = Math.max(vsX, Math.abs(ratio - x) / x); vsExact = Math.max(vsExact, Math.abs(ratio - exact) / x);
      if (i - P.is >= 20) vsX20 = Math.max(vsX20, Math.abs(ratio - x) / x);
      if ([55, 100, 200, 300].includes(x)) rows.push({ x, ageLen: sct_r(ratio), exact: sct_r(exact) });
    }
    return { maxRelErrVsX: sct_r(vsX, 3), maxRelErrVsXfrom20dx: sct_r(vsX20, 3), maxRelErrVsExact: sct_r(vsExact, 3), rows };
  };
  const eT = ev(tvd), eU = ev(up), info = { tvd: eT, upwind: eU };
  assert(eT.maxRelErrVsXfrom20dx < 0.05, `age differs from x/u: ${JSON.stringify(info)}`);
  assert(eT.maxRelErrVsExact < 0.03, `age differs from the exact solution: ${JSON.stringify(info)}`);
  return info;
});

// ------------------------------------------------------------------ T5 symmetry
/*
 * A block centred across the tunnel (cells j = 9 … 14 of 24), a flow that is mirror symmetric about the centre plane
 * (û and ŵ symmetric, v̂ antisymmetric: deflection around the block and an updraught upstream of it), mirror-symmetric
 * sources in all four groups, and the full closure with a lid: Γ and A must be mirror symmetric (physics §5.10 T5).
 */
function sct_blockCase() {
  const T = sc_makeGrid(48, 24, 12, 5), dx = 5, half = (24 * dx) / 2;
  const solid = (i, j, k) => (i >= 18 && i <= 23 && j >= 9 && j <= 14 && k <= 4 ? 255 : 0);
  const wf = sct_field(T, (i, j, k) => {
    const x = (i + 0.5) * dx, y = (j + 0.5) * dx - half, z = (k + 0.5) * dx;
    return [0.4 + 0.6 * (1 - Math.exp(-z / 20)), 0.25 * Math.tanh(y / 10) * Math.exp(-(((x - 105) / 25) ** 2)), 0.1 * Math.exp(-(((x - 85) / 10) ** 2)) * Math.exp(-z / 15)];
  }, solid);
  return { T, wf };
}
test('scalar T5: symmetric building gives a symmetric field', async () => {
  const { T, wf } = sct_blockCase(), { nx, ny, nz } = T;
  const src = sct_src(T, (i, j, k) => {
    const v = [0, 0, 0, 0];
    if (i === 6 && k === 0) v[0] = 5;
    if (i === 30 && (j === 11 || j === 12) && k === 0) v[1] = 5;
    if (k === 2 && i >= 10 && i <= 12 && j >= 3 && j <= 20) v[2] = 25;
    if (i === 40 && (j === 5 || j === 18) && k === 1) v[3] = 5;
    return v;
  });
  const f = await sct_solve(T, wf, src, { h_eff: 40 }, { spongeFree: 0 });
  let top = [0, 0, 0, 0, 0, 0, 0, 0], worst = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const q = ((k * ny + j) * nx + i) * 4, m = ((k * ny + ny - 1 - j) * nx + i) * 4;
    for (let c = 0; c < 4; c++) {
      top[c] = Math.max(top[c], f.gamma[q + c]); top[4 + c] = Math.max(top[4 + c], f.age[q + c]);
      worst[c] = Math.max(worst[c], Math.abs(f.gamma[q + c] - f.gamma[m + c])); worst[4 + c] = Math.max(worst[4 + c], Math.abs(f.age[q + c] - f.age[m + c]));
    }
  }
  const rel = worst.map((w, c) => w / top[c]);
  for (let c = 0; c < 8; c++) assert(rel[c] < 1e-4, `asymmetry ${rel[c]} in channel ${c} (${f.stats.sweeps} sweeps)`);
  return { maxRelAsymmetryGamma: rel.slice(0, 4).map((x) => sct_r(x, 2)), maxRelAsymmetryAge: rel.slice(4).map((x) => sct_r(x, 2)), sweeps: f.stats.sweeps, lidK: f.lidK, massRatio: f.stats.mass.map((x) => sct_r(x, 4)), divergence: sct_r(f.stats.divergence, 3) };
});

// ------------------------------------------------------------------ T6 linearity
/*
 * RGBA = (σ1, σ2, σ1 + σ2, 2σ1). The iteration is exactly homogeneous (the van Leer limiter depends only on ratios),
 * so Γ(2σ) = 2Γ(σ) to rounding, with or without TVD. Superposition Γ(σ1 + σ2) = Γ(σ1) + Γ(σ2) is exact for the
 * linear first-order upwind scheme; the TVD limiter is nonlinear, so there it holds only approximately: the error is
 * measured and reported (docs/04-dispersion.md §8), because ΔC = Σ q_k Γ_k assumes it.
 */
test('scalar T6: linearity (2σ → 2Γ, group sums)', async () => {
  const { T, wf } = sct_blockCase();
  const s1 = (i, j, k) => (i === 6 && k === 0 ? 5 : 0), s2 = (i, j, k) => (i === 30 && j >= 4 && j <= 8 && k === 0 ? 5 : 0);
  const src = sct_src(T, (i, j, k) => [s1(i, j, k), s2(i, j, k), s1(i, j, k) + s2(i, j, k), 2 * s1(i, j, k)]);
  const res = {};
  for (const tvd of [true, false]) {
    const f = await sct_solve(T, wf, src, { h_eff: 40 }, { spongeFree: 0, tvd });
    const n = T.nx * T.ny * T.nz;
    let top = [0, 0, 0, 0], hom = [0, 0], sum = [0, 0];
    for (let q = 0; q < n; q++) {
      const g = f.gamma, a = f.age, b = q * 4;
      top[0] = Math.max(top[0], g[b + 3]); top[1] = Math.max(top[1], g[b + 2]); top[2] = Math.max(top[2], a[b + 3]); top[3] = Math.max(top[3], a[b + 2]);
      hom[0] = Math.max(hom[0], Math.abs(g[b + 3] - 2 * g[b])); hom[1] = Math.max(hom[1], Math.abs(a[b + 3] - 2 * a[b]));
      sum[0] = Math.max(sum[0], Math.abs(g[b + 2] - g[b] - g[b + 1])); sum[1] = Math.max(sum[1], Math.abs(a[b + 2] - a[b] - a[b + 1]));
    }
    const r = { homogeneityGamma: hom[0] / top[0], homogeneityAge: hom[1] / top[2], superpositionGamma: sum[0] / top[1], superpositionAge: sum[1] / top[3], sweeps: f.stats.sweeps };
    assert(r.homogeneityGamma < 1e-5 && r.homogeneityAge < 1e-5, `2σ → 2Γ violated: ${JSON.stringify(r)}`);
    if (!tvd) assert(r.superpositionGamma < 1e-5 && r.superpositionAge < 1e-5, `upwind superposition violated: ${JSON.stringify(r)}`);
    else assert(r.superpositionGamma < 0.05, `TVD superposition error ${r.superpositionGamma} ≥ 5 %`);
    res[tvd ? 'tvd' : 'upwind'] = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'sweeps' ? v : sct_r(v, 2)]));
  }
  return res;
});

// ------------------------------------------------------------------ T4a street canyon with a prescribed vortex
/*
 * A 2D street canyon W/H = 1 (H = W = 30 m = 6 cells) between two 30 m blocks, with a prescribed canyon vortex from
 * the streamfunction ψ = −A sin(πξ) sin(πζ) (ξ across the canyon, ζ = z/H): wind along the roofs, down the windward
 * wall, back along the floor, up the leeward wall. A line source at the canyon floor centre must then give higher
 * concentrations at the leeward wall than at the windward wall, the textbook canyon result (physics §5.10 T4,
 * CODASC). This isolates the scalar solver; T4 below repeats it with the LBM's own flow.
 */
test('scalar T4a: canyon W/H = 1 with a prescribed vortex, leeward > windward', async () => {
  const dx = 5, T = sc_makeGrid(48, 4, 16, dx), H = 30, W = 30, x0 = 20 * dx, Uc = 0.3, A = (Uc * H) / Math.PI;
  const solid = (i, j, k) => (k <= 5 && ((i >= 14 && i <= 19) || (i >= 26 && i <= 31)) ? 255 : 0);
  const wf = sct_field(T, (i, j, k) => {
    const x = (i + 0.5) * dx, z = (k + 0.5) * dx;
    if (k >= 6) return [clamp(0.3 + (0.7 * (z - H)) / 50, 0.3, 1), 0, 0];
    if (i >= 20 && i <= 25) {
      const xi = (x - x0) / W, ze = z / H;
      return [-(A * Math.PI / H) * Math.sin(Math.PI * xi) * Math.cos(Math.PI * ze), 0, (A * Math.PI / W) * Math.cos(Math.PI * xi) * Math.sin(Math.PI * ze)];
    }
    return [0.3, 0, 0];
  }, solid);
  const src = sct_src(T, (i, j, k) => ((i === 22 || i === 23) && k === 0 ? [dx, 0, 0, 0] : null));
  const f = await sct_solve(T, wf, src, {}, { spongeFree: 0 });
  const wall = (i) => { let s = 0; for (let k = 0; k <= 5; k++) for (let j = 0; j < 4; j++) s += f.gamma[((k * 4 + j) * T.nx + i) * 4]; return s / 24; };
  const lee = wall(20), wind = wall(25), UH = 0.3;
  assert(lee > wind, `leeward ${lee} not above windward ${wind}`);
  return { leewardOverWindward: sct_r(lee / wind, 3), cPlusLeeward: sct_r(lee * H * UH, 3), cPlusWindward: sct_r(wind * H * UH, 3), sweeps: f.stats.sweeps, converged: f.stats.converged };
});

// ------------------------------------------------------------------ ScalarField API and convergence bookkeeping
test('scalar: ScalarField sample / receptor band / slice and convergence stats', async () => {
  const { tvd: f, T } = await sct_t1();
  const s = f.stats;
  assert(s.converged && s.reason === 'converged', 'converged');
  assert(s.sweeps >= sc_DEFAULTS.minSweeps && s.sweeps < sc_DEFAULTS.maxSweeps, `sweeps ${s.sweeps}`);
  assert(s.probeChange < sc_DEFAULTS.tolProbe, 'probe criterion');
  // RECEPTOR (0, 4 m, 0) is 240 m along the T1 tunnel (x = 217.5 m from the source), centred across.
  const r = f.receptor();
  assert(r.inside, 'receptor inside the tunnel');
  for (let g = 0; g < 4; g++) assert(r.band[g][0] <= r.gamma[g] + 1e-12 && r.gamma[g] <= r.band[g][1] + 1e-12, 'band contains the value');
  assert(r.gamma[0] > 0 && r.band[0][1] > r.band[0][0], 'non-trivial band');
  // The band is centred: brute force over every fluid cell whose centre is within 1.5 cells of the receptor, in the
  // two layers around its height (physics review 2026-09-28; the inlet sits on a cell face, so this is a 4×4×2 block).
  {
    const [gx, gy, gz] = sc_worldToGrid(f.frame, T, RECEPTOR), k0 = Math.floor(clamp(gz, 0, T.nz - 1.001));
    let lo = Infinity, hi = -Infinity, cells = 0;
    for (let k = k0; k <= Math.min(T.nz - 1, k0 + 1); k++) for (let j = 0; j < T.ny; j++) for (let i = 0; i < T.nx; i++) {
      if (Math.abs(i - gx) > 1.5 + 1e-6 || Math.abs(j - gy) > 1.5 + 1e-6) continue;
      const q = (k * T.ny + j) * T.nx + i;
      if (!f.fluid[q]) continue;
      cells++; lo = Math.min(lo, f.gamma[q * 4]); hi = Math.max(hi, f.gamma[q * 4]);
    }
    assert(cells >= 18, `band cells ${cells}`);
    assertClose(r.band[0][0], Math.min(lo, r.gamma[0]), 1e-9, 'band min = brute-force min over the centred block');
    assertClose(r.band[0][1], Math.max(hi, r.gamma[0]), 1e-9, 'band max = brute-force max over the centred block');
  }
  // sample() at a cell centre equals slice() of that cell's column at the cell's height.
  const out = new Float32Array(8), i = 50, j = 12, k = 1, fr = f.frame;
  const p = fr.origin.clone().addScaledVector(fr.ex, (i + 0.5) * T.dx).addScaledVector(fr.ey, (j + 0.5) * T.dx);
  p.y = (k + 0.5) * T.dx;
  assert(f.sample(p, out), 'sample inside');
  assertClose(out[0], f.gamma[((k * T.ny + j) * T.nx + i) * 4], 1e-7, 'sample at a cell centre');
  const sl = f.slice(p.y);
  assertClose(sl.data[(j * T.nx + i) * 8], out[0], 1e-7, 'slice = sample');
  assertClose(sl.data[(j * T.nx + i) * 8 + 4], out[4], 1e-4, 'slice age = sample age');
  assert(!f.sample(new THREE.Vector3(1e4, 4, 0), out), 'outside is false');
  assert(typeof f.describe() === 'string' && f.describe().length > 10, 'describe');
  return { receptor: { gamma: sct_r(r.gamma[0]), band: r.band[0].map((x) => sct_r(x)), ageLen_m: sct_r(r.age[0] / r.gamma[0]) }, sweeps: s.sweeps, residual: s.residual, massErr: s.massErr, probeChange: s.probeChange, text: f.describe() };
});

// ------------------------------------------------------------------ coarse-grid seed (physics §5.5.3)
/*
 * physics §5.5.3: a 10 m solution, prolongated, as the start of the 5 m solve. The start must really be the prolongated
 * field, and the result must be the same fixed point; the number of sweeps with and without the seed is reported.
 */
test('scalar: a 10 m solution as the start of the 5 m solve (seed)', async () => {
  const { tvd: fine, turb } = await sct_t1();
  const P = sct_T1, Tc = sc_makeGrid(P.nx / 2, P.ny / 2, P.nz / 2, 2 * P.dx);
  const wfc = sct_field(Tc, () => [1, 0, 0]);
  const srcc = sct_src(Tc, (i, j, k) => (i === P.is / 2 && k === 0 ? [2 * P.dx, 0, 0, 0] : null));
  const coarse = await sct_solve(Tc, wfc, srcc, turb, { spongeFree: 0 });
  const T = sc_makeGrid(P.nx, P.ny, P.nz, P.dx), wf = sct_field(T, () => [1, 0, 0]);
  const src = sct_src(T, (i, j, k) => (i === P.is && k === 0 ? [P.dx, 0, 0, 0] : null));
  // The start field really is the prolongated coarse solution: collect after 0 sweeps.
  const s0 = new ScalarSolver(T);
  let start;
  try { s0.begin(ScalarSolver.flowFromField(wf), sc_toAtlas(src, T, 4), turb, wf.frame, { spongeFree: 0, seed: coarse }); start = await s0.collect(); } finally { s0.dispose(); }
  const pr = sc_prolong(coarse, T, wf.frame).g, dStart = sct_relDiff(start.gamma, pr, 0);
  assert(dStart < 1e-6, `seed not applied (${dStart})`);
  const seeded = await sct_solve(T, wf, src, turb, { spongeFree: 0, seed: coarse });
  const d = sct_relDiff(seeded.gamma, fine.gamma, 0), info = { sweepsCoarse: coarse.stats.sweeps, sweepsFineFromZero: fine.stats.sweeps, sweepsFineSeeded: seeded.stats.sweeps, startVsFinalFine: sct_r(sct_relDiff(pr, fine.gamma, 0), 2), maxRelDiff: sct_r(d, 2) };
  assert(seeded.stats.converged, `seeded solve did not converge: ${JSON.stringify(info)}`);
  assert(d < 0.02, `seeded result differs: ${JSON.stringify(info)}`);
  return info;
});

// ------------------------------------------------------------------ performance
/*
 * Sweeps per second for the two production grids (architecture §5.1: 120 × 120 × 32 at 5 m, 60 × 60 × 16 at 10 m),
 * timed after a few warm-up sweeps with a synchronous 1-pixel read to make sure the GPU has finished. On SwiftShader
 * this measures the software renderer, which is what the headless tests and the LUT export use.
 */
test('scalar perf: sweeps per second on the production grids', async () => {
  const res = { renderer: '' };
  try { const gl = sc_renderer().getContext(), inf = gl.getExtension('WEBGL_debug_renderer_info'); res.renderer = inf ? String(gl.getParameter(inf.UNMASKED_RENDERER_WEBGL)) : ''; } catch (e) { /* none */ }
  for (const [nx, ny, nz, dx, n] of [[60, 60, 16, 10, 40], [120, 120, 32, 5, 12]]) {
    const T = sc_makeGrid(nx, ny, nz, dx), wf = sct_field(T, () => [1, 0.1, 0]);
    const src = sct_src(T, (i, j, k) => (i === 10 && k === 0 ? [dx, 0, 0, 0] : null));
    const s = new ScalarSolver(T), px = new Float32Array(4);
    try {
      const tb = performance.now();
      s.begin(ScalarSolver.flowFromField(wf), sc_toAtlas(src, T, 4), {}, wf.frame, { checkEvery: 1e9 });
      s.advance(3);
      s.r.readRenderTargetPixels(s.ga[s.job.cur], 0, 0, 1, 1, px);   // a synchronous read waits for the GPU
      const t0 = performance.now();
      s.advance(n);
      s.r.readRenderTargetPixels(s.ga[s.job.cur], 0, 0, 1, 1, px);
      const dt = (performance.now() - t0) / 1000;
      res[`${nx}x${ny}x${nz}`] = { sweepsPerSecond: sct_r(n / dt, 3), msPerSweep: sct_r((dt * 1000) / n, 3), McellsPerSecond: sct_r((n * nx * ny * nz) / dt / 1e6, 3), beginMs: Math.round(t0 - tb) };
    } finally { s.dispose(); }
  }
  return res;
});

// ------------------------------------------------------------------ with the LBM flow (flow-owned WindTunnel): slow
/*
 * Run the wind tunnel on a small custom grid (tunnelGrid(dx, {along, across, height, up, warm, avg})) around the
 * given prisms, for wind from the west (270°, so ex = +x = east), and return its flow on the GPU.
 */
async function sct_lbmFlow(dx, geo, box, runs) {
  const T = tunnelGrid(dx, { ...box, ...runs });
  const wt = new WindTunnel(T);
  wt.begin(geo, 270);
  for (let g = 0; wt.advance(LBM.software ? 16 : 64) < 1; g++) { if (g % 4 === 0) await sct_tick(); }
  return { T, wt, flow: wt.flow() };
}
// A crosswind line source (unit strength) across the whole tunnel at world x = xw, in the ground layer.
function sct_lineAt(T, frame, xw) {
  const i = Math.round(sc_worldToGrid(frame, T, new THREE.Vector3(xw, 0, 0))[0]);
  return sct_src(T, (a, j, k) => (a === i && k === 0 ? [T.dx, 0, 0, 0] : null));
}
async function sct_solveFlow(T, flow, src, turb, opts = {}) {
  const s = new ScalarSolver(T);
  try {
    s.begin(flow, sc_toAtlas(src, T, 4), turb, flow.frame, opts);
    for (let g = 0; !s.done; g++) { s.advance(LBM.software ? 8 : 50); await sct_tick(); }
    return await s.collect();
  } finally { s.dispose(); }
}
const sct_rect = (x0, x1, z0, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

/*
 * T3 (physics §5.10): the same block and road on a 10 m and a 5 m grid; Γ at the receptor and the Richardson
 * estimate with the scheme's formal order p = 2 (TVD) and the conservative p = 1, and the grid convergence index
 * GCI = 1.25 |Γ5 − Γ10| / Γ5 / (2^p − 1) (Roache 1994).
 */
test('scalar T3: grid convergence 10 m vs 5 m with the LBM flow', async () => {
  if (typeof WindTunnel === 'undefined' || typeof tunnelGrid !== 'function' || !(typeof LBM !== 'undefined' && LBM.ok)) return { status: 'not run: WindTunnel (flow) unavailable' };
  const geo = { prisms: [{ p: sct_rect(-60, -30, -20, 20), b: 0, h: 20, s: 1 }], trees: [], roads: [], heating: [] };
  const box = { along: 320, across: 160, height: 120, up: 160 }, runs = { warm: 3, avg: 1 };
  const out = {};
  for (const dx of [10, 5]) {
    const { T, wt, flow } = await sct_lbmFlow(dx, geo, box, runs);
    const f = await sct_solveFlow(T, flow, sct_lineAt(T, flow.frame, -100), {}, { spongeFree: 0 });
    wt.dispose && wt.dispose();
    out[dx] = { gamma: f.receptor().gamma[0], sweeps: f.stats.sweeps, mass: sct_r(f.stats.mass[0], 4), divergence: sct_r(f.stats.divergence, 3), converged: f.stats.converged };
  }
  const g10 = out[10].gamma, g5 = out[5].gamma, rich = (p) => g5 + (g5 - g10) / (2 ** p - 1), gci = (p) => (1.25 * Math.abs(g5 - g10)) / g5 / (2 ** p - 1);
  assert(g5 > 0 && g10 > 0, 'receptor sees the plume');
  return { grid10: out[10], grid5: out[5], richardsonP2: sct_r(rich(2)), richardsonP1: sct_r(rich(1)), gciP2: sct_r(gci(2), 3), gciP1: sct_r(gci(1), 3) };
}, { slow: true });

/*
 * T4 (physics §5.10): an infinite street canyon W/H = 1, H = 30 m (6 cells), perpendicular wind, LBM flow (lateral
 * periodic, so the canyon is two-dimensional), line source on the canyon floor centre: the leeward/windward wall
 * ratio of c⁺ = Γ H U_H / U_ref must exceed 1 (CODASC, qualitative).
 */
test('scalar T4: canyon W/H = 1 with the LBM flow, leeward > windward', async () => {
  if (typeof WindTunnel === 'undefined' || typeof tunnelGrid !== 'function' || !(typeof LBM !== 'undefined' && LBM.ok)) return { status: 'not run: WindTunnel (flow) unavailable' };
  const H = 30, geo = { prisms: [{ p: sct_rect(-45, -15, -400, 400), b: 0, h: H, s: 1 }, { p: sct_rect(15, 45, -400, 400), b: 0, h: H, s: 1 }], trees: [], roads: [], heating: [] };
  const { T, wt, flow } = await sct_lbmFlow(5, geo, { along: 320, across: 80, height: 120, up: 160 }, { warm: 3, avg: 1 });
  // Floor-centre source: the two cells either side of x = 0.
  const iC = Math.round((0 - flow.frame.origin.x) / T.dx);
  const src = sct_src(T, (i, j, k) => ((i === iC - 1 || i === iC) && k === 0 ? [T.dx, 0, 0, 0] : null));
  const f = await sct_solveFlow(T, flow, src, {}, { spongeFree: 0 });
  const wall = (i) => { let s = 0, n = 0; for (let k = 0; k < H / T.dx; k++) for (let j = 0; j < T.ny; j++) { s += f.gamma[((k * T.ny + j) * T.nx + i) * 4]; n++; } return s / n; };
  const iLee = Math.round((-15 - flow.frame.origin.x) / T.dx), iWind = Math.round((15 - flow.frame.origin.x) / T.dx) - 1;
  const lee = wall(iLee), wind = wall(iWind);
  // U_H: the mean LBM speed at roof height upstream of the canyon, as a fraction of U10.
  let UH = 0;
  const wfield = wt.collect ? await wt.collect() : null;
  if (wfield) { const o = new Float32Array(4); wfield.sample(new THREE.Vector3(-100, H, 0), o); UH = o[0]; }
  wt.dispose && wt.dispose();
  assert(lee > wind, `leeward ${lee} not above windward ${wind}`);
  return { leewardOverWindward: sct_r(lee / wind, 3), cPlusLeeward: sct_r(lee * H * UH, 3), cPlusWindward: sct_r(wind * H * UH, 3), UH: sct_r(UH, 3), sweeps: f.stats.sweeps, mass: sct_r(f.stats.mass[0], 4), divergence: sct_r(f.stats.divergence, 3) };
}, { slow: true });
