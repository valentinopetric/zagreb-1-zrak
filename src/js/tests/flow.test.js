// ------------------------------------------------------------------ tests: flow (voxel.js, wind-tunnel.js, aero.js)
/*
 * In-page tests of the [flow] module, run by tests/browser/run_selftest.py --only flow.
 *
 *   flow.frame        tunnel frame orientation and world ↔ tunnel round trip; WindField index math
 *   flow.voxel.*      prism voxeliser against analytic prisms (axis-aligned, half-cell shifted, rotated 30°),
 *                     porous trees, speed on the real city
 *   flow.sources      source raster: length × aadt conservation for a rotated road, heating area × w
 *   flow.inflow       inflowProfile against the closed-form blending-height solution (physics §6.2–6.3)
 *   flow.wall         wallDistance (BFS) against a brute-force exact distance
 *   flow.lbm.*        GPU LBM smoke tests on tiny tunnels (empty: profile kept, no NaN; one block: wake)
 *   flow.aero.*       the job queue on a tiny tunnel (pipeline, caches, flow reuse, cancel, LUT export)
 *   flow.timing.*     [slow] one direction through the real pipeline at 10 m and at 5 m, with timings;
 *                     converge10m: the same with the fine warm-up doubled (run control)
 *   flow.trees.wake   [slow] wind reduction behind a row of porous crowns (plausibility of critic §4.3's values)
 *
 * Tests only read module state; every GPU object they create is disposed at the end.
 */
const ft_rng = rng(31337);

// A small grid (5 m cells unless given) and the frame for wind from the west, so tunnel axes are world
// axes: ex = +x (east), ey = +z (south), origin = (−up, 0, −across/2).
function ft_grid(dx = 5, o = {}) { return tunnelGrid(dx, { along: 200, across: 200, height: 60, up: 100, ...o }); }
function ft_rect(cx, cz, w, d, rotDeg = 0) {
  const c = Math.cos(rotDeg * DEG), s = Math.sin(rotDeg * DEG), out = [];
  for (const [u, v] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) out.push([cx + u * c - v * s, cz + u * s + v * c]);
  return out;
}
// Exact plan cover of a cell by a polygon, by brute-force point sampling (n × n points), for comparison.
function ft_cellCover(poly, frame, dx, i, j, n = 40) {
  let inside = 0;
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
    const p = vox_tunnelToWorld(frame, (i + (a + 0.5) / n) * dx, (j + (b + 0.5) / n) * dx, 0);
    if (pointInPoly(p.x, p.z, poly)) inside++;
  }
  return inside / (n * n);
}
// Volume of a mask: solid cells count 1, porous cells their fraction m = byte / 255.
function ft_maskVolume(grid, dx) {
  let v = 0;
  for (let q = 0; q < grid.length; q++) v += grid[q] === 255 ? 1 : grid[q] / 255;
  return v * dx * dx * dx;
}
// Poll a condition while ticking an Aero (or anything) until done or timeout.
async function ft_until(cond, step, timeoutMs = 120000) {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > timeoutMs) throw new Error('timeout');
    if (step) step();
    await new Promise((r) => setTimeout(r, 0));
  }
  return performance.now() - t0;
}

// ------------------------------------------------------------------ frame
test('flow.frame: orientation, station position, world ↔ tunnel round trip, WindField indexing', () => {
  const T = TUNNEL;
  for (let d = 0; d < 360; d += 22.5) {
    const f = tunnelFrame(WT_CENTER, d, T);
    assertClose(f.ex.length(), 1, 1e-12, 'ex unit');
    assertClose(f.ey.length(), 1, 1e-12, 'ey unit');
    assertClose(f.ex.dot(f.ey), 0, 1e-12, 'ex ⟂ ey');
    assertClose(f.ex.y, 0, 0, 'horizontal');
    // ex is the "blowing toward" vector of architecture §2: (−sin θ, 0, +cos θ).
    assertClose(f.ex.x, -Math.sin(d * DEG), 1e-12, `ex.x @${d}`);
    assertClose(f.ex.z, Math.cos(d * DEG), 1e-12, `ex.z @${d}`);
    const s = vox_worldToTunnel(f, WT_CENTER);
    assertClose(s[0], T.up, 1e-9, 'station along');
    assertClose(s[1], (T.ny * T.dx) / 2, 1e-9, 'station across');
    for (let n = 0; n < 25; n++) {
      const p = new THREE.Vector3((ft_rng() - 0.5) * 900, ft_rng() * 60, (ft_rng() - 0.5) * 900);
      const a = vox_worldToTunnel(f, p), q = vox_tunnelToWorld(f, a[0], a[1], a[2]);
      assertClose(q.distanceTo(p), 0, 1e-9, 'round trip');
    }
  }
  // Named cases: from N the wind blows south (+z); from W it blows east (+x).
  assertClose(tunnelFrame(WT_CENTER, 0, T).ex.z, 1, 1e-12, 'from N');
  assertClose(tunnelFrame(WT_CENTER, 270, T).ex.x, 1, 1e-12, 'from W');
  // Grid of the contract: 120×120×32 at 5 m, 60×60×16 at 10 m (architecture §5.1).
  const g5 = tunnelGrid(5), g10 = tunnelGrid(10);
  assert(g5.nx === 120 && g5.ny === 120 && g5.nz === 32 && g5.tx === 6 && g5.W === 720 && g5.H === 720, `5 m grid ${g5.id}`);
  assert(g10.nx === 60 && g10.ny === 60 && g10.nz === 16 && g10.tx === 4 && g10.W === 240 && g10.H === 240, `10 m grid ${g10.id}`);
  // WindField: a cell's value comes back when sampled at the cell's world centre (atlas → grid → world).
  const Tg = ft_grid(10), fr = tunnelFrame(WT_CENTER, 33, Tg), samples = 7;
  const buf = new Float32Array(Tg.W * Tg.H * 4), val = (i, j, k) => i + 100 * j + 10000 * k;
  for (let k = 0; k < Tg.nz; k++) for (let j = 0; j < Tg.ny; j++) for (let i = 0; i < Tg.nx; i++) {
    const s = ((j + Math.floor(k / Tg.tx) * Tg.ny) * Tg.W + i + (k % Tg.tx) * Tg.nx) * 4;
    buf[s] = val(i, j, k) * samples * U_LATTICE; buf[s + 3] = 1 * samples * U_LATTICE;
  }
  const wf = new WindField(33, fr, buf, new Uint8Array(Tg.nx * Tg.ny * Tg.nz), samples, Tg), out = new Float32Array(4);
  for (const [i, j, k] of [[1, 1, 0], [5, 7, 2], [18, 17, 4], [11, 3, 4]]) {   // inner cells (sample() clamps at edges)
    const p = vox_tunnelToWorld(fr, (i + 0.5) * Tg.dx, (j + 0.5) * Tg.dx, (k + 0.5) * Tg.dx);
    assert(wf.sample(p, out), 'inside');
    assertClose(out[0], val(i, j, k), 1e-3, `cell ${i},${j},${k}`);
  }
  // vel() maps tunnel axes to world axes: u along ex only.
  const v = wf.vel(vox_tunnelToWorld(fr, 55, 55, 25));
  assertClose(v.clone().normalize().dot(fr.ex), 1, 1e-6, 'vel along ex');
});

// ------------------------------------------------------------------ voxeliser
test('flow.voxel: axis-aligned prisms are exact (cell-aligned, half-cell shifted, raised base)', () => {
  const T = ft_grid(5), f = tunnelFrame(WT_CENTER, 270, T), dx = T.dx;
  // Tunnel axes = world axes here; origin at (−100, −100): world x = −100 + a, z = −100 + c.
  assertClose(f.origin.x, -100, 1e-9); assertClose(f.origin.z, -100, 1e-9);
  const A = voxelize({ prisms: [{ p: ft_rect(10, 15, 20, 30), b: 0, h: 20, s: 1 }], trees: [] }, f, T);
  let solid = 0, porous = 0;
  for (const m of A.grid) { if (m === 255) solid++; else if (m) porous++; }
  assert(solid === 4 * 6 * 4 && porous === 0, `cell-aligned: ${solid} solid, ${porous} porous (expect 96, 0)`);
  assertClose(ft_maskVolume(A.grid, dx), 20 * 30 * 20, 1e-6, 'cell-aligned volume');
  assertClose(A.stats.coverVolume, 20 * 30 * 20, 1e-3, 'cover volume');
  // The same box shifted by half a cell: edge cells are exactly half covered → porous 0.5 (not > 0.5 → not solid).
  const B = voxelize({ prisms: [{ p: ft_rect(12.5, 17.5, 20, 30), b: 0, h: 20, s: 1 }], trees: [] }, f, T);
  let sB = 0, halves = 0, quarters = 0;
  for (const m of B.grid) { if (m === 255) sB++; else if (m === 128) halves++; else if (m === 64) quarters++; }
  assert(sB === 3 * 5 * 4 && halves === (2 * 3 + 2 * 5) * 4 && quarters === 4 * 4, `shifted: ${sB} solid, ${halves} halves, ${quarters} quarters`);
  assertClose(ft_maskVolume(B.grid, dx), 20 * 30 * 20, 20 * 30 * 20 * 0.002, 'shifted volume (byte rounding)');
  // Raised base: b = 10, h = 20 fills only the layers centred at 12.5 and 17.5 m.
  const C = voxelize({ prisms: [{ p: ft_rect(10, 15, 20, 30), b: 10, h: 20, s: 1 }], trees: [] }, f, T);
  const nxy = T.nx * T.ny;
  for (let k = 0; k < T.nz; k++) {
    let n = 0;
    for (let q = k * nxy; q < (k + 1) * nxy; q++) if (C.grid[q] === 255) n++;
    assert(n === (k === 2 || k === 3 ? 24 : 0), `raised base layer ${k}: ${n}`);
  }
  // Too low for any cell centre (h < dx/2) → nothing; porous prism (s = 0.4) → never solid, 0.4 per full cell.
  const D = voxelize({ prisms: [{ p: ft_rect(10, 15, 20, 30), b: 0, h: 2.4, s: 1 }, { p: ft_rect(-40, -40, 10, 10), b: 0, h: 10, s: 0.4 }], trees: [] }, f, T);
  let dSolid = 0, dPor = 0;
  for (const m of D.grid) { if (m === 255) dSolid++; else if (m) { dPor++; assert(m === Math.round(0.4 * 255), `porous prism byte ${m}`); } }
  assert(dSolid === 0 && dPor === 2 * 2 * 2, `low/porous: ${dSolid} solid, ${dPor} porous`);
  // Atlas layout: cell (i, j, k) at texel (i + (k % tx)·nx, j + floor(k / tx)·ny).
  for (const [i, j, k] of [[20, 20, 0], [23, 25, 3], [0, 0, 5]]) {
    const q = (k * T.ny + j) * T.nx + i, tex = (j + Math.floor(k / T.tx) * T.ny) * T.W + i + (k % T.tx) * T.nx;
    assert(A.atlas[tex] === A.grid[q], `atlas ${i},${j},${k}`);
  }
});

test('flow.voxel: rotated prisms (30°) against analytic area and a brute-force cover per cell', () => {
  const T = ft_grid(5), dx = T.dx, nxy = T.nx * T.ny;
  const cases = [
    { name: 'prism rotated 30° in an axis-aligned tunnel', from: 270, poly: ft_rect(7, 3, 40, 20, 30) },
    { name: 'axis-aligned prism in a tunnel rotated 30°', from: 300, poly: ft_rect(-6, 11, 40, 20, 0) },
    { name: 'L-shaped footprint, 30°', from: 300, poly: [[0, 0], [30, 0], [30, 10], [10, 10], [10, 25], [0, 25]].map(([x, z]) => [x * Math.cos(0.5236) - z * Math.sin(0.5236) - 10, x * Math.sin(0.5236) + z * Math.cos(0.5236) - 5]) },
  ];
  const info = {};
  for (const c of cases) {
    const f = tunnelFrame(WT_CENTER, c.from, T), h = 15, layers = 3;   // centres 2.5, 7.5, 12.5 ≤ 15
    const area = Math.abs(polyArea(c.poly));
    const V = voxelize({ prisms: [{ p: c.poly, b: 0, h, s: 1 }], trees: [] }, f, T);
    // 1) the scan-converted cover integrates to the analytic volume
    const exact = area * layers * dx;
    assertClose(V.stats.coverVolume, exact, exact * 0.005, `${c.name}: cover volume`);
    // 2) every cell matches a brute-force cover: solid iff cover > 0.5, else porous with m = cover
    let mismatches = 0, maxErr = 0, maskV = 0;
    for (let j = 0; j < T.ny; j++) for (let i = 0; i < T.nx; i++) {
      const m = V.grid[j * T.nx + i];
      const cen = vox_tunnelToWorld(f, (i + 0.5) * dx, (j + 0.5) * dx);
      const b = bounds(c.poly);
      if (cen.x < b.x0 - dx || cen.x > b.x1 + dx || cen.z < b.z0 - dx || cen.z > b.z1 + dx) { if (m) mismatches++; continue; }
      const cov = ft_cellCover(c.poly, f, dx, i, j);
      maskV += m === 255 ? 1 : m / 255;
      if (Math.abs(cov - 0.5) < 0.02) continue;   // too close to the threshold to call
      const want = cov > 0.5 ? 255 : Math.round(cov * 255);
      const err = m === 255 || want === 255 ? (m === want ? 0 : 1) : Math.abs(m - want) / 255;
      maxErr = Math.max(maxErr, err);
      if (err > 0.03) mismatches++;
      for (let k = 1; k < layers; k++) if (V.grid[k * nxy + j * T.nx + i] !== m) mismatches++;
      if (V.grid[layers * nxy + j * T.nx + i] !== 0) mismatches++;
    }
    assert(mismatches === 0, `${c.name}: ${mismatches} cells differ from brute force (max err ${maxErr})`);
    // 3) the mask volume errs only by rounding partly covered cells up to solid (the 50 % rule)
    const maskVol = maskV * layers * dx * dx * dx;
    info[c.name] = { area: +area.toFixed(1), cover_err_pct: +((V.stats.coverVolume / exact - 1) * 100).toFixed(3), mask_err_pct: +((maskVol / exact - 1) * 100).toFixed(2) };
    assert(maskVol >= exact * 0.99 && maskVol <= exact * 1.2, `${c.name}: mask volume ${maskVol} vs ${exact}`);
  }
  return info;
});

test('flow.voxel: trees become porous cells from their LAD (leaf-on, leaf-off, inside a building)', () => {
  const T = ft_grid(5), f = tunnelFrame(WT_CENTER, 270, T), dx = T.dx;
  const tree = { x: 1.3, z: -2.1, h: 12, r: 4 };
  const on = voxelize({ prisms: [], trees: [{ ...tree, lad: VOX.LAD_ON }] }, f, T);
  const off = voxelize({ prisms: [], trees: [{ ...tree, lad: VOX.LAD_OFF }] }, f, T);
  const sum = (g) => { let s = 0, n = 0, mx = 0, solid = 0; for (const m of g) { if (m === 255) solid++; else if (m) { s += m / 255; n++; mx = Math.max(mx, m / 255); } } return { s, n, mx, solid }; };
  const a = sum(on.grid), b = sum(off.grid);
  assert(a.solid === 0 && b.solid === 0, 'a tree is never solid');
  assert(a.n > 0 && a.mx <= 0.15 + 0.5 / 255, `leaf-on: ${a.n} porous cells, max m ${a.mx}`);
  // Σ m·V = PF_PER_LAD · LAD · (dx / 5) · V_crown, V_crown = 4/3·π·r²·rv with the crown from zb to h.
  const zb = Math.min(Math.max(VOX.CROWN_BASE_MIN, tree.h * VOX.CROWN_BASE_FRAC), tree.h / 2), rv = (tree.h - zb) / 2;
  const vCrown = (4 / 3) * Math.PI * tree.r * tree.r * rv;
  const want = (VOX.PF_PER_LAD * VOX.LAD_ON * dx / VOX.PF_DX_REF) * vCrown;
  assertClose(a.s * dx ** 3, want, want * 0.08, 'leaf-on porous volume');
  assertClose(b.s / a.s, VOX.LAD_OFF / VOX.LAD_ON, 0.03, 'leaf-off / leaf-on');
  // critic §4.3: a 5 m cell full of foliage gets 0.15 in leaf and ≈ 0.04 leafless.
  const big = voxelize({ prisms: [], trees: [{ x: 2.5, z: 2.5, h: 40, r: 30, lad: VOX.LAD_ON }] }, f, T);
  const cen = (4 * T.ny + 20) * T.nx + 20;   // layer 4 (22.5 m), centre of the big crown
  assertClose(big.grid[cen] / 255, 0.15, 0.5 / 255 + 1e-9, 'full cell, leaf-on');
  assertClose(voxelize({ prisms: [], trees: [{ x: 2.5, z: 2.5, h: 40, r: 30, lad: VOX.LAD_OFF }] }, f, T).grid[cen] / 255, 0.0375, 0.5 / 255 + 1e-9, 'full cell, leaf-off');
  // On the 10 m grid the fraction doubles (drag through the crown independent of the grid).
  const T10 = ft_grid(10), f10 = tunnelFrame(WT_CENTER, 270, T10);
  const big10 = voxelize({ prisms: [], trees: [{ x: 5, z: 5, h: 40, r: 30, lad: VOX.LAD_ON }] }, f10, T10);
  assertClose(big10.grid[(2 * T10.ny + 10) * T10.nx + 10] / 255, 0.3, 0.5 / 255 + 1e-9, 'full 10 m cell, leaf-on');
  // A crown inside a building stays solid; a crown over a half-covered cell adds to its fraction.
  const both = voxelize({ prisms: [{ p: ft_rect(0, 0, 20, 20), b: 0, h: 30, s: 1 }, { p: ft_rect(42.5, 1.25, 5, 2.5), b: 0, h: 30, s: 1 }], trees: [{ x: 0, z: 0, h: 20, r: 6, lad: 1.2 }, { x: 42.5, z: 2.5, h: 20, r: 6, lad: 1.2 }] }, f, T);
  const q0 = (2 * T.ny + 20) * T.nx + 20;   // inside the first building, 12.5 m
  assert(both.grid[q0] === 255, 'tree inside a building stays solid');
  const qh = (2 * T.ny + 20) * T.nx + 28;   // x = 40..45, z = 0..5 of the half-covered strip: cover 0.5 + foliage
  assert(both.grid[qh] > 128 && both.grid[qh] <= VOX.POROUS_MAX, `half cover + foliage: ${both.grid[qh]}`);
  return { leafOn: { cells: a.n, maxM: +a.mx.toFixed(3), volume: +(a.s * dx ** 3).toFixed(1), expected: +want.toFixed(1) }, leafOff: { maxM: +b.mx.toFixed(3) } };
});

test('flow.voxel: the real city voxelises fast (all 16 directions, 5 m and 10 m)', () => {
  const geo = aero_geometry('today');
  const info = { prisms_in_geo: geo.prisms.length, trees_in_geo: geo.trees.length };
  for (const dx of [5, 10]) {
    const T = tunnelGrid(dx);
    let worst = 0, sum = 0, st = null;
    for (let d = 0; d < 16; d++) {
      const f = tunnelFrame(WT_CENTER, d * 22.5, T), t0 = performance.now();
      const v = voxelize(geo, f, T);
      const ms = performance.now() - t0;
      worst = Math.max(worst, ms); sum += ms;
      if (d === 2) st = v.stats;
      // The station's own column must stay open (the container is excluded, critic §4.2).
      const s = vox_worldToTunnel(f, RECEPTOR), i = Math.floor(s[0] / dx), j = Math.floor(s[1] / dx);
      assert(v.grid[j * T.nx + i] !== 255, `station cell solid at ${d * 22.5}°`);
    }
    const v45 = voxelize(geo, tunnelFrame(WT_CENTER, 45, T), T);
    let n0 = 0;
    for (let q = 0; q < T.nx * T.ny; q++) if (v45.grid[q] === 255) n0++;
    const lp = n0 / (T.nx * T.ny);
    info[`${dx}m`] = { worst_ms: Math.round(worst), mean_ms: Math.round(sum / 16), prisms: st.prisms, trees: st.trees, solid: st.solid, porous: st.porous, lambda_p_layer0: +lp.toFixed(3) };
    assert(worst < 1000, `voxelising one direction at ${dx} m took ${worst.toFixed(0)} ms (limit 1000)`);
    // Plan-area fraction of the lowest layer ≈ λp of the neighbourhood (critic §1.10: 0.25–0.27).
    assert(lp > 0.1 && lp < 0.45, `λp of layer 0 = ${lp}`);
  }
  // The other per-direction CPU work: sources and wall distance at 5 m.
  const T = tunnelGrid(5), f = tunnelFrame(WT_CENTER, 45, T), v = voxelize(geo, f, T);
  let t0 = performance.now();
  rasterizeSources(geo, f, T);
  info.sources_ms = Math.round(performance.now() - t0);
  t0 = performance.now();
  wallDistance(v.grid, T);
  info.wall_ms = Math.round(performance.now() - t0);
  t0 = performance.now();
  vox_geoHash(geo);
  info.hash_ms = Math.round(performance.now() - t0);
  return info;
});

// ------------------------------------------------------------------ sources
test('flow.sources: road length × aadt is conserved for a rotated road; heating area × w', () => {
  const T = ft_grid(5), dx = T.dx;
  const road = { p: [[-60, -20], [-20, 3.1], [35, 34.9]], g: 'A', aadt: 23500, w: 10.5 };   // two segments at ≈ 30°
  const len = Math.hypot(40, 23.1) + Math.hypot(55, 31.8);
  for (const from of [270, 300, 13, 222.5]) {
    const f = tunnelFrame(WT_CENTER, from, T);
    const src = rasterizeSources({ roads: [road, { p: [[-30, 40], [30, 40]], g: null, aadt: 5000, w: 7 }, { p: [[-30, -40], [30, -40]], g: 'B', aadt: 10000, w: 6.5 }], heating: [] }, f, T, { outletGap: 0 });
    const tot = [0, 0, 0, 0];
    let off = 0, cells = 0;
    for (let tIdx = 0; tIdx < T.W * T.H; tIdx++) {
      const x = tIdx % T.W, y = Math.floor(tIdx / T.W), k = Math.floor(y / T.ny) * T.tx + Math.floor(x / T.nx);
      for (let g = 0; g < 4; g++) {
        const v = src[tIdx * 4 + g];
        tot[g] += v;
        if (v && k !== 0) off += v;
      }
      if (src[tIdx * 4]) cells++;
    }
    assertClose(tot[0], (len * road.aadt) / MD.aadt_unit, 1e-4 * tot[0], `group A total @${from}`);
    assertClose(tot[1], (60 * 10000) / MD.aadt_unit, 1e-4, `group B total @${from}`);
    assert(tot[2] === 0 && tot[3] === 0 && off === 0, 'only A and B, only the lowest layer');
    // Spread across the carriageway: ≥ the road's plan area in cells (10.5 m × 118 m ≈ 50 cells).
    assert(cells >= (len * road.w) / (dx * dx) * 0.8, `spread over ${cells} cells`);
  }
  // Heating: a 50 m × 40 m polygon of weight 0.8 → Σ = 1600 m² at the roof layer (8 m → layer 1 at 5 m).
  const f = tunnelFrame(WT_CENTER, 300, T);
  const src = rasterizeSources({ roads: [], heating: [{ p: ft_rect(-10, 20, 50, 40, 17), w: 0.8 }] }, f, T, { outletGap: 0 });
  let heat = 0, wrong = 0;
  for (let tIdx = 0; tIdx < T.W * T.H; tIdx++) {
    const v = src[tIdx * 4 + 3];
    if (!v) continue;
    const x = tIdx % T.W, y = Math.floor(tIdx / T.W), k = Math.floor(y / T.ny) * T.tx + Math.floor(x / T.nx);
    heat += v;
    if (k !== Math.floor(VOX.HEAT_Z / dx)) wrong++;
  }
  assertClose(heat, 50 * 40 * 0.8, 50 * 40 * 0.8 * 0.005, 'heating area × w');
  assert(wrong === 0, 'heating at roof level');
  // Nothing inside the last 100 m before the outlet (physics §5.3), unless asked.
  const g0 = { roads: [{ p: [[80, -20], [80, 20]], g: 'C', aadt: 10000, w: 7 }], heating: [] };
  const f270 = tunnelFrame(WT_CENTER, 270, T);   // x = 80 → a = 180 m, inside the last 100 m of a 200 m tunnel
  assert(rasterizeSources(g0, f270, T).every((v) => v === 0), 'no sources in the sponge');
  assertClose(rasterizeSources(g0, f270, T, { outletGap: 0 }).reduce((s, v) => s + v, 0), 40, 1e-3, 'kept with outletGap 0');
  return { roadLength_m: +len.toFixed(2) };
});

// Regression (review 2026-09-28): env.json lists the station tree in trees[] (k 'station') AND in station.tree;
// the ENV-based geometry fallback voxelised it twice (double porous fraction over the inlet).
test('flow.voxel: vox_envGeometry keeps the station tree once', () => {
  const st = { x: -5, z: -10, h: 14, r: 9 };
  const near = (g) => g.trees.filter((tr) => Math.hypot(tr.x - st.x, tr.z - st.z) < 1.5).length;
  const listed = vox_envGeometry({ trees: [{ ...st, k: 'station' }, { x: 40, z: 40, h: 10, r: 3 }], station: { tree: st } });
  const notListed = vox_envGeometry({ trees: [{ x: 40, z: 40, h: 10, r: 3 }], station: { tree: st } });
  assert(near(listed) === 1, `station tree ${near(listed)}× when env.trees already has it`);
  assert(near(notListed) === 1 && notListed.trees.length === 2, 'station tree added when env.trees lacks it');
  assert(near(vox_envGeometry(ENV)) <= 1, 'real ENV: at most one station crown');
  return { real: near(vox_envGeometry(ENV)) };
});

// ------------------------------------------------------------------ inflow profile
test('flow.inflow: blending-height log/canopy profile (physics §6.2–6.3), monotone, matched, same table in GLSL', () => {
  const p = INFLOW;
  // Closed form, written out independently of inflowConstants().
  const us = (p.kappa * (Math.log(p.zb / p.z0r) / Math.log(p.zref / p.z0r))) / Math.log((p.zb - p.d) / p.z0);
  const log = (z) => (us / p.kappa) * Math.log((z - p.d) / p.z0);
  assertClose(INFLOW_K.ustar, us, 1e-12, 'û*');
  for (const z of [14, 20, 40, 80, 120, 157.5]) assertClose(inflowProfile(z), log(z), 1e-12, `log law at ${z} m`);
  for (const z of [0, 2.5, 7.5, 10, 12.5]) assertClose(inflowProfile(z), log(p.Hbar) * Math.exp(p.a * (z / p.Hbar - 1)), 1e-12, `canopy at ${z} m`);
  // Matching: the urban and the NWP profile agree at the blending height; the NWP profile is 1 at 10 m.
  assertClose(inflowProfile(p.zb), wt_ruralProfile(p.zb), 1e-12, 'matched at z_b');
  assertClose(wt_ruralProfile(10), 1, 1e-12, 'NWP profile = 1 at 10 m');
  // Continuous at H̄, monotone increasing from the ground to the lid.
  assertClose(inflowProfile(p.Hbar - 1e-9), inflowProfile(p.Hbar + 1e-9), 1e-7, 'continuous at H̄');
  let prev = -1;
  for (let z = 0; z <= 200; z += 0.25) { const u = inflowProfile(z); assert(u > prev, `monotone at ${z}`); prev = u; }
  // physics §6.2 worked example: d = 8 m, z0 = 1.4 m → û* = 0.162.
  assertClose(inflowConstants({ ...p, d: 8, z0: 1.4 }).ustar, 0.162, 0.0005, 'physics §6.2 example');
  // Mach number at the lid below 0.3 (physics §6.3): U_LATTICE · û(top) / c_s.
  const ma = (U_LATTICE * inflowProfile(TUNNEL.nz * TUNNEL.dx - TUNNEL.dx / 2)) / Math.sqrt(1 / 3);
  assert(ma < 0.3, `Mach ${ma}`);
  return { ustar: +INFLOW_K.ustar.toFixed(4), u10: +inflowProfile(10).toFixed(4), uH: +INFLOW_K.uH.toFixed(4), u80: +inflowProfile(80).toFixed(4), u160: +inflowProfile(160).toFixed(4), mach_top: +ma.toFixed(3) };
});

// ------------------------------------------------------------------ wall distance
test('flow.wall: BFS wall distance against brute force (solids and ground)', () => {
  const T = tunnelGrid(5, { along: 100, across: 80, height: 40, up: 50 }), { nx, ny, nz, dx } = T;
  const grid = new Uint8Array(nx * ny * nz);
  const box = (i0, i1, j0, j1, k0, k1) => { for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) grid[(k * ny + j) * nx + i] = 255; };
  box(4, 6, 3, 5, 0, 3); box(12, 13, 10, 12, 0, 5); box(15, 15, 2, 2, 2, 2);
  grid[(1 * ny + 8) * nx + 9] = 120;   // porous: not a wall
  const d = wallDistance(grid, T);
  const solids = [];
  for (let q = 0; q < grid.length; q++) if (grid[q] >= 250) solids.push([q % nx, Math.floor(q / nx) % ny, Math.floor(q / (nx * ny))]);
  let maxErr = 0, sumErr = 0, n = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const q = (k * ny + j) * nx + i;
    let best = (k + 0.5) * dx;
    if (grid[q] >= 250) best = 0;
    else for (const [a, b, c] of solids) {
      const ex = Math.max(Math.abs(i - a) - 0.5, 0), ey = Math.max(Math.abs(j - b) - 0.5, 0), ez = Math.max(Math.abs(k - c) - 0.5, 0);
      best = Math.min(best, Math.hypot(ex, ey, ez) * dx);
    }
    const e = Math.abs(d[q] - best);
    maxErr = Math.max(maxErr, e); sumErr += e; n++;
  }
  assert(maxErr <= 0.25 * dx, `max error ${maxErr} m`);
  assert(sumErr / n <= 0.01 * dx, `mean error ${sumErr / n} m`);
  // A face neighbour is dx/2 from the wall; a cell next to the ground dx/2 above it.
  assertClose(d[(0 * ny + 4) * nx + 7], 0.5 * dx, 1e-6, 'face neighbour');
  return { maxErr_m: +maxErr.toFixed(4), meanErr_m: +(sumErr / n).toFixed(5) };
});

// ------------------------------------------------------------------ LBM on tiny tunnels
/*
 * The empty tunnel checks the boundary conditions and the inflow table. (a) A plug inflow (û = 1 at every
 * height) is an exact steady solution with these boundaries (inlet, lid, outlet, periodic sides, free-slip
 * ground), so it must come out unchanged. (b) The urban profile must survive above the canopy. Near the
 * ground it does not, in an EMPTY tunnel: the free-slip ground exerts no drag (critic G12), so the slow canopy
 * air is dragged forward by the faster air above it for as long as it takes to cross the tunnel. In the city
 * the buildings hold it back (see flow.timing.*: the profile over the city); the per-layer drift is reported.
 */
test('flow.lbm.empty: exact plug flow; the urban profile survives above the canopy; no NaN (D3Q19/D3Q15)', async () => {
  assert(LBM.ok, `float render targets unavailable (q = ${LBM.q}, gpu ${LBM.gpu})`);
  const T = tunnelGrid(10, { along: 200, across: 100, height: 80, up: 100, warm: 1.0, avg: 0.3 });
  const run = async (opts) => {
    const wt = new WindTunnel(T, null, opts);
    try {
      wt.begin({ prisms: [], trees: [] }, 250);
      while (wt.advance(50) < 1) await new Promise((r) => setTimeout(r, 0));
      const flow = wt.flow();
      assert(flow && flow.samples > 0 && flow.uLattice === U_LATTICE && flow.avg && flow.mask && flow.T === T, 'flow() shape');
      const w = await wt.collect();
      for (const v of w.data) assert(Number.isFinite(v), 'non-finite value');
      return { w, table: Array.from(wt.uniforms.uInflow.value) };
    } finally { wt.dispose(); }
  };
  const t0 = performance.now();
  // (a) plug flow: every fluid cell keeps û = 1 and no cross or vertical flow.
  const plug = await run({ profile: () => 1 });
  let maxDev = 0;
  for (let q = 0; q < plug.w.data.length; q += 4) maxDev = Math.max(maxDev, Math.abs(plug.w.data[q] - 1), Math.hypot(plug.w.data[q + 1], plug.w.data[q + 2]));
  assert(maxDev < 0.01, `plug flow deviates by ${maxDev}`);
  // (b) the urban profile: the shader's table is the JS profile; mid-tunnel means above 2·H̄ within 10 %.
  const urb = await run({});
  const errs = [];
  for (let k = 0; k < T.nz; k++) {
    const z = (k + 0.5) * T.dx, want = inflowProfile(z);
    assertClose(urb.table[k], U_LATTICE * want, 1e-7, `uInflow[${k}]`);
    let u = 0, vw = 0;
    for (let j = 0; j < T.ny; j++) { const q = ((k * T.ny + j) * T.nx + T.nx / 2) * 4; u += urb.w.data[q]; vw = Math.max(vw, Math.hypot(urb.w.data[q + 1], urb.w.data[q + 2])); }
    u /= T.ny;
    errs.push({ z, want: +want.toFixed(3), got: +u.toFixed(3) });
    if (z >= 2 * INFLOW.Hbar) assertClose(u, want, 0.1 * want, `layer ${k} (${z} m)`);
    assert(vw < 0.05, `cross/vertical flow ${vw} at layer ${k}`);
  }
  return { q: LBM.q, software: LBM.software, gpu: LBM.gpu, steps: T.warm + T.avg, plug_max_dev: +maxDev.toFixed(5), ms: Math.round(performance.now() - t0), mid_tunnel_profile: errs };
});

test('flow.lbm.block: a block stops the air inside it and leaves a slower wake behind it', async () => {
  assert(LBM.ok, 'float render targets unavailable');
  const T = tunnelGrid(10, { along: 300, across: 200, height: 100, up: 100, warm: 1.2, avg: 0.3 });
  const wt = new WindTunnel(T);
  try {
    const f = tunnelFrame(WT_CENTER, 270, T);   // ex = +x: the block at x = 0..40 sits 100–140 m from the inlet
    const geo = { prisms: [{ p: ft_rect(20, 0, 40, 40), b: 0, h: 30, s: 1 }], trees: [] };
    wt.begin(geo, 270);
    while (wt.advance(60) < 1) await new Promise((r) => setTimeout(r, 0));
    const w = await wt.collect();
    for (const v of w.data) assert(Number.isFinite(v), 'finite');
    const at = (x, y, z) => { const o = new Float32Array(4); w.sample(new THREE.Vector3(x, y, z), o); return o[0]; };
    const inside = w.data[((1 * T.ny + 10) * T.nx + 12) * 4];
    assert(inside === 0, `velocity inside the block ${inside}`);
    const upstream = at(-60, 15, 0), wake = at(70, 15, 0), side = at(70, 15, 80);
    assert(wake < 0.6 * upstream, `wake ${wake} vs upstream ${upstream}`);
    assert(side > wake, `side ${side} > wake ${wake}`);
    assert(w.solidAt(new THREE.Vector3(20, 10, 0)) && !w.solidAt(new THREE.Vector3(-60, 10, 0)), 'solidAt');
    return { upstream: +upstream.toFixed(3), wake: +wake.toFixed(3), side: +side.toFixed(3), frame_origin: [f.origin.x, f.origin.z] };
  } finally { wt.dispose(); }
});

// ------------------------------------------------------------------ the job queue on a tiny tunnel
function ft_tinyAero(events) {
  const T = tunnelGrid(10, { along: 200, across: 100, height: 80, up: 100, warm: 0.8, avg: 0.25 });
  const S = tunnelGrid(20, { along: 200, across: 100, height: 80, up: 100, warm: 1.0, avg: 0.25 });
  const geo = { prisms: [{ p: ft_rect(-40, 0, 20, 20), b: 0, h: 20, s: 1 }], trees: [{ x: 30, z: 20, h: 12, r: 4, lad: 1.2 }], roads: [{ p: [[-80, 12], [80, 12]], g: 'A', aadt: 20000, w: 10 }], heating: [] };
  return new Aero({
    T, S, persist: false, geometry: () => geo,
    onResult: (res, kind) => events.push({ res, kind }),
    onProgress: () => {},
  });
}

test('flow.aero.queue: pipeline, result cache, flow reuse across stability groups, view replacement', async () => {
  assert(LBM.ok, 'float render targets unavailable');
  const events = [], aero = ft_tinyAero(events);
  try {
    // A view request runs spin-up → fine → (scalar) → result.
    aero.request({ scenario: 'today', dir: 4, stab: 'D' });
    const ms1 = await ft_until(() => events.length >= 1, () => aero.tick());
    const r1 = events[0].res;
    assert(r1.key.dir === 4 && r1.key.stab === 'D' && events[0].kind === 'view', 'first result key');
    assert(r1.wind instanceof WindField && r1.wind.T === aero.T && r1.wind.from === 90, 'WindField');
    assert(r1.mast && Number.isFinite(r1.mast.s4) && Number.isFinite(r1.mast.dir10), 'mast wind');
    assert(Math.abs(angDiff(r1.mast.dir10, 90)) < 30, `mast direction ${r1.mast.dir10} vs 90`);
    const scalar = typeof ScalarSolver === 'function';
    assert(scalar ? !!(r1.conc && r1.receptor) : r1.conc === null, 'conc present iff ScalarSolver exists');
    // The same key again: delivered from the cache, synchronously.
    aero.request({ scenario: 'today', dir: 4, stab: 'D' });
    assert(events.length === 2 && events[1].res === r1, 'cache hit');
    // Another stability group of the same direction reuses the flow (no LBM run: straight to 'scalar').
    const stages = new Set();
    aero.onProgress = (job) => { if (job) stages.add(job.stage); };
    aero.request({ scenario: 'today', dir: 4, stab: 'EF' });
    assert(aero.queue.length === 1, 'queued');
    await ft_until(() => events.length >= 3, () => aero.tick());
    assert(events[2].res.wind === r1.wind, 'same WindField object');
    assert(!stages.has('spinup') && !stages.has('fine'), `flow reused (stages ${[...stages]})`);
    // The running job only ever shows the stages main.js labels (ui.busy.stage.*).
    aero.request({ scenario: 'today', dir: 5, stab: 'D' });
    await ft_until(() => events.length >= 4, () => aero.tick());
    assert([...stages].every((s) => ['spinup', 'fine', 'scalar'].includes(s)), `stages ${[...stages]}`);
    // invalidate() forgets a scenario: the same key is computed again.
    aero.invalidate('today');
    assert(aero.cache.size === 0 && aero.flows.size === 0, 'caches emptied');
    aero.request({ scenario: 'today', dir: 4, stab: 'D' });
    assert(events.length === 4 && aero.queue.length === 1, 'recomputed after invalidate');
    aero.cancelView();
    // A newer view request for the scenario replaces the older one and cancels it when running.
    aero.request({ scenario: 'today', dir: 7, stab: 'D' });
    aero.tick(); aero.tick();
    assert(aero.current && aero.current.key.dir === 7, 'dir 7 running');
    aero.request({ scenario: 'today', dir: 9, stab: 'D' });
    assert(!aero.current && aero.queue.length === 1 && aero.queue[0].key.dir === 9, 'dir 7 cancelled, dir 9 queued');
    aero.cancelView('today');
    assert(!aero.busy, 'cancelView empties the scenario');
    return { first_ms: Math.round(ms1), scalar, timing: aero.timing[0], mast: r1.mast };
  } finally { aero.dispose(); }
});

test('flow.aero.lut: a 16-direction × 3-group sweep on a tiny tunnel gives the architecture §4.4 LUT', async () => {
  assert(LBM.ok, 'float render targets unavailable');
  const events = [], aero = ft_tinyAero(events);
  try {
    const t0 = performance.now();
    const batch = { total: 48, done: 0 };
    const keys = [];
    for (let d = 0; d < 16; d++) for (const stab of ['AC', 'D', 'EF']) keys.push({ scenario: 'today', dir: d, stab });
    aero.sweep(keys, { receptorOnly: true, batch });
    aero.driver = true;   // as sweepLUT does: big batches, self-driven
    await ft_until(() => batch.done >= batch.total && !aero.reading.size, () => aero._tick(), 600000);
    aero.driver = false;
    const lut = aero.exportLUT('today', ['AC', 'D', 'EF']);
    assert(lut.dirs.length === 16 && lut.dirs[4] === 90 && lut.classes.join() === 'AC,D,EF' && lut.groups.join() === 'A,B,C,D', 'axes');
    assert(lut.gamma.length === 16 && lut.gamma.every((r) => r.length === 3) && lut.wind.length === 16, 'shape');
    assert(lut.wind.every((w) => w && Number.isFinite(w.s4) && Number.isFinite(w.s10) && Number.isFinite(w.dir4) && Number.isFinite(w.dir10)), 'wind per direction');
    assert(lut.meta.grid === aero.T.id && lut.meta.version === 1 && typeof lut.meta.generated_utc === 'string', 'meta');
    const scalar = typeof ScalarSolver === 'function';
    if (scalar) {
      assert(lut.meta.complete && lut.gamma.every((r) => r.every((g) => g && g.length === 4 && g.every(Number.isFinite))), 'Γ complete');
      assert(lut.band.every((r) => r.every((b) => b && b.length === 4 && b.every((mm) => mm.length === 2))), 'band shape');
      assert(lut.quality.length === 16 && lut.quality.every((r) => r.length === 3 && r.every((q) => q && typeof q.converged === 'boolean' && Number.isFinite(q.sweeps))), 'per-entry solve quality');
    } else assert(!lut.meta.complete && lut.meta.status.startsWith('wind-only'), 'wind-only without the scalar solver');
    // Flows ran once per direction (16 jobs with an LBM stage), the other groups reused them.
    const lbmJobs = aero.timing.filter((x) => x.fine_s > 0).length;
    assert(lbmJobs === 16, `${lbmJobs} LBM runs for 16 directions`);
    JSON.parse(JSON.stringify(lut));
    // A second receptor-only sweep of the same keys is answered from the result cache (the last 16) and the
    // receptor store (the rest) and DELIVERED to onResult (integration fix: stored values used to be skipped silently).
    let stored = 0;
    if (scalar) {
      const n0 = events.length, again = { total: 48, done: 0 };
      aero.sweep(keys, { receptorOnly: true, batch: again });
      await ft_until(() => again.done >= again.total && !aero.reading.size, () => aero._tick(), 60000);
      const second = events.slice(n0);
      stored = second.filter((e) => e.res.stored).length;
      assert(second.length === 48, `${second.length} of 48 keys delivered on the second sweep`);
      assert(stored >= 32 && second.filter((e) => e.res.stored).every((e) => e.res.receptor && e.res.receptor.gamma.length === 4 && e.res.conc === null), 'stored results carry receptor values, no fields');
      assert(aero.timing.filter((x) => x.fine_s > 0).length === 16, 'no new LBM runs for stored keys');
    }
    return { ms: Math.round(performance.now() - t0), status: lut.meta.status, s10_mean: +(lut.wind.reduce((s, w) => s + w.s10, 0) / 16).toFixed(3), stored };
  } finally { aero.dispose(); }
});

// ------------------------------------------------------------------ timings of the real pipeline [slow]
/*
 * One direction (45°, the default NE wind) through the full Aero pipeline on the real city: spin-up and
 * fine flow (and the scalar stage when scalar.js is present). At 10 m (+20 m spin-up) and at 5 m
 * (+10 m spin-up). The numbers decide whether the LUT sweep runs at fine or coarse resolution
 * (docs/03-flow-lbm.md §8). Select one with ?flowdx=10 or ?flowdx=5.
 */
async function ft_timeDirection(dx) {
  const T = tunnelGrid(dx, WT_RUN.fine), S = tunnelGrid(dx * 2, WT_RUN.spin);
  const events = [];
  const aero = new Aero({ T, S, persist: false, onResult: (r) => events.push(r) });
  try {
    aero.driver = true;
    const t0 = performance.now();
    aero.request({ scenario: 'today', dir: 2, stab: 'D' });
    await ft_until(() => events.length > 0 || aero.errors.length > 0, () => aero._tick(), 3 * 3600 * 1000);
    assert(!aero.errors.length, JSON.stringify(aero.errors));
    const r = events[0], tm = aero.timing[0];
    // Horizontally averaged along-wind speed over the fluid cells near the inlet and mid-tunnel, per layer,
    // against the inflow: how the free-slip ground and the resolved city shape the profile (critic G12).
    const prof = (x0, x1) => {
      const w = r.wind, out = [];
      for (let k = 0; k < T.nz; k += Math.max(1, Math.round(T.nz / 8))) {
        let s = 0, n = 0;
        for (let j = 0; j < T.ny; j++) for (let i = Math.round(x0 * T.nx); i < Math.round(x1 * T.nx); i++) {
          const q = (k * T.ny + j) * T.nx + i;
          if (w.mask[q] >= 250) continue;
          s += w.data[q * 4]; n++;
        }
        out.push([(k + 0.5) * T.dx, +(n ? s / n : 0).toFixed(3), +inflowProfile((k + 0.5) * T.dx).toFixed(3)]);
      }
      return out;
    };
    const lbmSteps = S.warm + S.avg + T.warm + T.avg;
    const cellSteps = (S.warm + S.avg) * S.nx * S.ny * S.nz + (T.warm + T.avg) * T.nx * T.ny * T.nz;
    return {
      grid: T.id, spinup: S.id, steps: { spin: S.warm + S.avg, fine: T.warm + T.avg }, total_s: +((performance.now() - t0) / 1000).toFixed(1),
      spin_s: +tm.spin_s.toFixed(1), fine_s: +tm.fine_s.toFixed(1), scalar_s: +tm.scalar_s.toFixed(1), scalar_sweeps: tm.sweeps,
      read_s: +(tm.total_s - tm.spin_s - tm.fine_s - tm.scalar_s).toFixed(1),
      Mcell_steps_per_s: +(cellSteps / 1e6 / (tm.spin_s + tm.fine_s)).toFixed(2), lbm_steps: lbmSteps,
      mast: r.mast, receptor: r.receptor, gpu: LBM.gpu,
      profile_z_mean_inflow: { inlet_5_15pct: prof(0.05, 0.15), mid_45_55pct: prof(0.45, 0.55) },
      wind: r.wind,
    };
  } finally { aero.dispose(); }
}
const ft_timings = {};
test('flow.timing.10m: one direction at 10 m through the full pipeline [slow]', async () => {
  if (PARAMS.get('flowdx') && PARAMS.get('flowdx') !== '10') return { skipped: 'flowdx' };
  const { wind, ...info } = await ft_timeDirection(10);
  ft_timings[10] = { wind, info };
  return info;
}, { slow: true });
test('flow.timing.5m: one direction at 5 m through the full pipeline [slow]', async () => {
  if (PARAMS.get('flowdx') && PARAMS.get('flowdx') !== '5') return { skipped: 'flowdx' };
  const { wind, ...info } = await ft_timeDirection(5);
  ft_timings[5] = { wind, info };
  return info;
}, { slow: true });
/*
 * Run control: is the fine run converged at the station? The same direction at 10 m with the fine warm-up
 * doubled (0.65 → 1.3 flow-throughs), compared with the standard run within 100 m of the station:
 * relative RMS difference of the speed ⟨|u|⟩ and the mast winds (docs/03-flow-lbm.md §5).
 */
test('flow.timing.converge10m: doubling the fine warm-up changes the flow near the station little [slow]', async () => {
  if (PARAMS.get('flowdx') && PARAMS.get('flowdx') !== '10') return { skipped: 'flowdx' };
  const base = ft_timings[10] || { wind: (await ft_timeDirection(10)).wind };
  const T = tunnelGrid(10, { ...WT_RUN.fine, warm: 2 * WT_RUN.fine.warm }), S = tunnelGrid(20, WT_RUN.spin);
  const events = [], aero = new Aero({ T, S, persist: false, onResult: (r) => events.push(r) });
  try {
    aero.driver = true;
    aero.request({ scenario: 'today', dir: 2, stab: 'D' });
    await ft_until(() => events.length > 0 || aero.errors.length > 0, () => aero._tick(), 3 * 3600 * 1000);
    assert(!aero.errors.length, JSON.stringify(aero.errors));
    const a = base.wind, b = events[0].wind, p = new THREE.Vector3(), oa = new Float32Array(4), ob = new Float32Array(4);
    let d2 = 0, s2 = 0, n = 0;
    for (let x = -100; x <= 100; x += 10) for (let z = -100; z <= 100; z += 10) for (const y of [4, 10, 20]) {
      p.set(x, y, z);
      if (a.solidAt(p) || !a.sample(p, oa) || !b.sample(p, ob)) continue;
      d2 += (oa[3] - ob[3]) ** 2; s2 += oa[3] ** 2; n++;
    }
    const rel = Math.sqrt(d2 / s2);
    const m1 = aero_mast(a), m2 = aero_mast(b);
    assert(rel < 0.15, `relative RMS change ${rel}`);
    return { points: n, rel_rms_speed_change: +rel.toFixed(4), mast_standard: m1, mast_double_warm: m2, receptor_standard: base.info ? base.info.receptor : null, receptor_double_warm: events[0].receptor };
  } finally { aero.dispose(); }
}, { slow: true });

/*
 * Plausibility of the porous trees (critic §4.3: "tune it so the wind reduction behind the crown looks
 * plausible"). A continuous row of street-tree crowns (h 12 m, r 4 m, 8 m apart, crown base 4 m) across a
 * small 5 m tunnel (periodic sides make it an endless row), in leaf and leafless, against the same tunnel
 * empty. Reported: u(with trees)/u(empty) at crown height (7.5 m) and at 2.5 m, 1 H to 6 H behind the row.
 * Only the ordering is asserted (leafless reduces less than in leaf); the numbers go to docs/03 §4.3.
 */
test('flow.trees.wake: wind reduction behind a row of porous crowns, in leaf and leafless [slow]', async () => {
  assert(LBM.ok, 'float render targets unavailable');
  const T = tunnelGrid(5, { along: 300, across: 80, height: 60, up: 100, warm: 1.5, avg: 0.4 });
  const row = (lad) => ({ prisms: [], trees: Array.from({ length: 10 }, (_, n) => ({ x: 0, z: -40 + 4 + 8 * n, h: 12, r: 4, cb: 4, lad })) });
  const run = async (geo) => {
    const wt = new WindTunnel(T);
    try {
      wt.begin(geo, 270);
      while (wt.advance(60) < 1) await new Promise((r) => setTimeout(r, 0));
      return await wt.collect();
    } finally { wt.dispose(); }
  };
  const empty = await run(row(0)), on = await run(row(VOX.LAD_ON)), off = await run(row(VOX.LAD_OFF));
  const o = new Float32Array(4), p = new THREE.Vector3();
  const ratio = (w, x, y) => {
    let a = 0, b = 0;
    for (let z = -36; z <= 36; z += 8) { p.set(x, y, z); w.sample(p, o); a += o[0]; empty.sample(p, o); b += o[0]; }
    return +(a / b).toFixed(3);
  };
  const H = 12, out = { m_full_cell: { on: +(VOX.PF_PER_LAD * VOX.LAD_ON).toFixed(3), off: +(VOX.PF_PER_LAD * VOX.LAD_OFF).toFixed(4) } };
  for (const [name, w] of [['leaf_on', on], ['leaf_off', off]]) {
    out[name] = {};
    for (const xH of [1, 2, 4, 6]) out[name][`${xH}H`] = { z7_5: ratio(w, 4 + xH * H, 7.5), z2_5: ratio(w, 4 + xH * H, 2.5) };
  }
  assert(out.leaf_on['2H'].z7_5 < out.leaf_off['2H'].z7_5 && out.leaf_off['2H'].z7_5 <= 1.01, 'leafless crowns reduce the wind less');
  return out;
}, { slow: true });
