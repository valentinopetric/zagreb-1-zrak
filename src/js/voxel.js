// ------------------------------------------------------------------ voxel
/*
 * The city, turned into the cells of one wind tunnel.
 *
 * Every wind direction gets its own tunnel, turned to face the wind (architecture §5.1), so for every
 * direction the city has to be cut into that tunnel's cells again: the buildings into solid and porous
 * cells for the flow, the roads and the heated houses into per-cell source weights for the pollutant, and
 * the solid cells into a distance-to-the-nearest-wall field for the mixing length of the scalar solver.
 * The reference app (maksimir-pod-kisom) voxelised only its two stadiums; the prism voxeliser for the
 * ~1,500 ZG3D building parts inside each 600 × 600 m tunnel is new code (critic §0, last paragraph).
 *
 * Grid conventions (shared with wind-tunnel.js and scalar.js):
 *   - cell (i, j, k): i along ex (downwind, 0 at the inlet), j along ey (across), k up (0 at the ground);
 *     cell i spans [i·dx, (i+1)·dx) along ex from the frame origin, likewise j and k;
 *   - grid arrays are indexed q = (k·ny + j)·nx + i (the WindField layout, architecture §5.2);
 *   - the 2D atlas puts layer k in the tile (k % tx, floor(k / tx)): cell (i, j, k) is the texel
 *     (i + (k % tx)·nx, j + floor(k / tx)·ny) of a W × H texture (architecture §5.1, physics Eq. 1.1);
 *   - mask bytes: 255 solid, 1–249 porous (solid fraction m = byte / 255), 0 fluid. The LBM treats
 *     bytes above 0.99·255 as solid and WindField/scalar treat ≥ 250 as solid, so porous bytes stop at 249.
 *
 * Contents: tunnelFrame (the frame), voxelize (buildings and trees → mask), rasterizeSources (roads and
 * heating → source weights), wallDistance (BFS), plus the private helpers vox_* used by them and by
 * aero.js (the ENV-based geometry fallback and the geometry hash).
 */

// Parameters of the voxeliser and the source rasteriser. Every value carries its source or its reason.
const VOX = Object.freeze({
  SOLID: 255,              // mask byte of a solid cell (architecture §5.2)
  POROUS_MAX: 249,         // highest porous byte, so no porous cell is ever read as solid (see header)
  SOLID_COVER: 0.5,        // a cell is solid when MORE than half of its plan area is covered (critic §4.3 item 5)
  COVER_EPS: 1e-6,         // … by more than this, so float rounding of an exactly half-covered cell never decides
  MIN_FRACTION: 0.5 / 255, // a solid fraction that rounds to byte 0 is left as fluid
  SUB_M: 0.625,            // scanline spacing across the tunnel, m: ≈ the 0.6 m RDP tolerance of the footprints (architecture §4.1)
  LAD_ON: 1.2,             // leaf area density in leaf, m²/m³ (site-context §9.1, critic §4.3)
  LAD_OFF: 0.3,            // leafless, November–April, m²/m³ (site-context §9.1, critic §4.3)
  // Porous fraction per unit LAD of a 5 m cell full of foliage. critic §4.3 says to START at a porous
  // fraction of 0.15 in leaf and 0.04 leafless; 0.125 m × LAD gives 0.150 at LAD 1.2 and 0.0375 at 0.3.
  // The LAD → porous-fraction mapping is a HEURISTIC, not sourced (critic §4.3): see docs/03-flow-lbm.md §4.3.
  PF_PER_LAD: 0.125,
  // The porous blend removes a fixed share of momentum per lattice step, and a crown of fixed size takes
  // 1/dx as many steps to cross on a finer grid (steps ∝ length / (dx · U_LATTICE)), so the fraction scales
  // ∝ dx to keep the drag through a crown independent of the grid. 5 m is the grid the critic's values are for.
  PF_DX_REF: 5,
  CROWN_BASE_MIN: 2.5,     // crown base at least 2.5 m up: the usual pruning clearance over footways (heuristic)
  CROWN_BASE_FRAC: 1 / 3,  // … or a third of the tree height (a live-crown ratio of 2/3, typical of open-grown street trees; heuristic)
  TREE_SUB: 4,             // sub-samples per cell axis (4³ = 64) for the crown's volume fraction in a cell
  SRC_SUB: 4,              // road sub-samples per cell length, along and across the carriageway (1.25 m at 5 m)
  LANE_W: 3.25,            // default lane width, m, when a road has no carriageway width (architecture §4.1)
  HEAT_Z: 8,               // heating source height = roof level of the low-rise houses, m (architecture §5.3)
  SRC_OUTLET_GAP: 100,     // no sources in the last 100 m before the outlet, the LBM sponge (physics §5.3)
});

// ------------------------------------------------------------------ the tunnel frame
/*
 * The tunnel frame for wind FROM `fromDeg` (meteorological bearing, clockwise from north; architecture §2):
 *   ex = the direction the wind blows toward = (−sin θ, 0, cos θ) in world (x east, y up, z south);
 *   ey = ex turned 90° about the vertical = (−ex.z, 0, ex.x), across the tunnel;
 *   origin = the inlet's near corner on the ground, so that `center` (the station) sits T.up metres
 *   along ex and half the tunnel width across.
 * As in the reference, (ex, ey, up) is a left-handed triple in the right-handed world frame. Only the
 * mapping of velocity components depends on it (WindField.vel), and the lattice is mirror symmetric.
 */
function tunnelFrame(center, fromDeg, T = TUNNEL) {
  const b = fromDeg * DEG;
  const ex = new THREE.Vector3(-Math.sin(b), 0, Math.cos(b));
  const ey = new THREE.Vector3(-ex.z, 0, ex.x);
  const origin = new THREE.Vector3(center.x, 0, center.z)
    .addScaledVector(ex, -T.up)
    .addScaledVector(ey, -(T.ny * T.dx) / 2);
  origin.y = 0;
  return { from: fromDeg, ex, ey, origin };
}

// World point → tunnel metres: out = [along ex, across ey, up]. The inverse is vox_tunnelToWorld.
function vox_worldToTunnel(frame, p, out = [0, 0, 0]) {
  const rx = p.x - frame.origin.x, rz = p.z - frame.origin.z;
  out[0] = rx * frame.ex.x + rz * frame.ex.z;
  out[1] = rx * frame.ey.x + rz * frame.ey.z;
  out[2] = p.y;
  return out;
}
function vox_tunnelToWorld(frame, a, c, y = 0, out = new THREE.Vector3()) {
  return out.set(
    frame.origin.x + frame.ex.x * a + frame.ey.x * c,
    y,
    frame.origin.z + frame.ex.z * a + frame.ey.z * c,
  );
}

// ------------------------------------------------------------------ plan-area cover of the grid columns
/*
 * The share of each grid column's plan area covered by one polygon, by scanlines across the tunnel and
 * exact lengths along it: `sub` scanlines per cell row (at c = j + (s + 0.5)/sub) each cut the polygon's
 * edges, the crossings are paired even–odd, and every interval adds its exact overlap with each cell it
 * spans, divided by `sub`. The midpoint rule is exact for a convex polygon's straight edges except in the
 * few scanlines through a vertex, so the total area is right to well under 1 % (tested in flow.test.js).
 *
 * `pts` holds the polygon in grid units (cells from the origin corner) as [a0, c0, a1, c1, …]. Covers
 * accumulate into colCov[j·nx + i]; every column touched for the first time is appended to `touched`,
 * and the caller reads and zeroes those entries. Returns the number of touched columns.
 */
let vox_xsBuf = new Float64Array(256);   // crossings of one scanline (grown on demand)
function vox_coverColumns(pts, n, nx, ny, sub, colCov, touched) {
  let cmin = Infinity, cmax = -Infinity;
  for (let v = 0; v < n; v++) { const c = pts[2 * v + 1]; if (c < cmin) cmin = c; if (c > cmax) cmax = c; }
  const r0 = Math.max(0, Math.floor(cmin * sub)), r1 = Math.min(ny * sub - 1, Math.ceil(cmax * sub));
  if (vox_xsBuf.length < n) vox_xsBuf = new Float64Array(2 * n);
  const xs = vox_xsBuf, w = 1 / sub;
  let nt = 0;
  for (let r = r0; r <= r1; r++) {
    const cr = (r + 0.5) / sub, j = Math.floor(cr);
    if (j < 0 || j >= ny) continue;
    // Crossings of the scanline with every edge, half-open in c so a vertex on the line counts once.
    let m = 0;
    for (let v = 0, u = n - 1; v < n; u = v++) {
      const c1 = pts[2 * u + 1], c2 = pts[2 * v + 1];
      if ((c1 <= cr) === (c2 <= cr)) continue;
      const a1 = pts[2 * u], a2 = pts[2 * v];
      xs[m++] = a1 + ((cr - c1) * (a2 - a1)) / (c2 - c1);
    }
    if (m < 2) continue;
    // Insertion sort: a footprint has a handful of crossings per line.
    for (let x = 1; x < m; x++) { const t = xs[x]; let y = x - 1; while (y >= 0 && xs[y] > t) { xs[y + 1] = xs[y]; y--; } xs[y + 1] = t; }
    const row = j * nx;
    for (let x = 0; x + 1 < m; x += 2) {
      const lo = Math.max(0, xs[x]), hi = Math.min(nx, xs[x + 1]);
      if (hi <= lo) continue;
      const i0 = Math.floor(lo), i1 = Math.min(nx - 1, Math.ceil(hi) - 1);
      for (let i = i0; i <= i1; i++) {
        const len = Math.min(hi, i + 1) - Math.max(lo, i);
        if (len <= 0) continue;
        const q = row + i;
        if (colCov[q] === 0) touched[nt++] = q;
        colCov[q] += len * w;
      }
    }
  }
  return nt;
}

// Per-grid scratch buffers, reused between calls on the same grid (a voxelisation runs per tunnel run).
const vox_scratch = new Map();
function vox_buffers(T) {
  const key = `${T.nx}x${T.ny}x${T.nz}`;
  let s = vox_scratch.get(key);
  if (!s) {
    const nxy = T.nx * T.ny;
    s = { colCov: new Float32Array(nxy), touched: new Int32Array(nxy), pts: new Float64Array(512) };
    vox_scratch.set(key, s);
  }
  return s;
}

// A footprint ring into grid units of `frame` (cells from the origin corner), with its bounding box.
// Returns the vertex count, 0 for a degenerate ring. Drops a repeated closing vertex.
function vox_ringToGrid(ring, frame, dx, s, box) {
  let n = ring.length;
  if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) n--;
  if (n < 3) return 0;
  if (s.pts.length < 2 * n) s.pts = new Float64Array(4 * n);
  const pts = s.pts, ox = frame.origin.x, oz = frame.origin.z;
  const exx = frame.ex.x / dx, exz = frame.ex.z / dx, eyx = frame.ey.x / dx, eyz = frame.ey.z / dx;
  let amin = Infinity, amax = -Infinity, cmin = Infinity, cmax = -Infinity;
  for (let v = 0; v < n; v++) {
    const rx = ring[v][0] - ox, rz = ring[v][1] - oz;
    const a = rx * exx + rz * exz, c = rx * eyx + rz * eyz;
    pts[2 * v] = a; pts[2 * v + 1] = c;
    if (a < amin) amin = a; if (a > amax) amax = a; if (c < cmin) cmin = c; if (c > cmax) cmax = c;
  }
  box[0] = amin; box[1] = amax; box[2] = cmin; box[3] = cmax;
  return n;
}

// ------------------------------------------------------------------ buildings and trees → mask
/*
 * voxelize(geo, frame, T) → {grid: Uint8Array(nx·ny·nz), atlas: Uint8Array(W·H), stats}
 *
 * geo = cityGeometry(scenario) (architecture §6.3): prisms {p, b, h, s} and trees {x, z, h, r, lad, cb?}.
 *
 * Buildings (critic §4.3 item 5). Each prism's footprint is rotated into the tunnel and scan-converted
 * (vox_coverColumns) into a plan-area cover per grid column; the cover is added to every layer k whose
 * centre z_k = (k + 0.5)·dx satisfies b ≤ z_k ≤ h. Covers of different prisms add up (two parts of a
 * building meeting inside a cell fill it together). A cell whose summed cover exceeds 0.5 is solid;
 * otherwise the cover is its porous fraction. A prism with s < 1 (a screen, a hedge) is never solid and
 * adds s × cover to the porous fraction.
 *
 * Trees become porous cells from their leaf area density. The crown is an ellipsoid of horizontal
 * radius r from its base z_b to the top h, with z_b = tree.cb when the scene gives it (city.js draws the
 * same crown), else min(max(2.5 m, h/3), h/2). The volume share f of each cell inside the crown is
 * sampled on a 4 × 4 × 4 lattice, and the cell gets the porous fraction
 *     m = PF_PER_LAD · LAD · f · dx / 5 m            (heuristic, critic §4.3; see VOX above)
 * added to whatever porous fraction the buildings left there. Solid cells stay solid.
 *
 * Speed: a prism costs its scanlines (≈ 8 per cell row) times its edges, then one write per covered
 * column and layer; there is no per-cell point-in-polygon test. ~1,500 prisms and ~1,000 trees take a few
 * tens of milliseconds at 5 m (flow.test.js measures it).
 */
function voxelize(geo, frame, T) {
  const t0 = performance.now();
  const { nx, ny, nz, dx, tx, W, H } = T;
  const nxy = nx * ny, n = nxy * nz;
  const cover = new Float32Array(n), poro = new Float32Array(n);
  const s = vox_buffers(T), box = [0, 0, 0, 0];
  const sub = Math.max(4, Math.ceil(dx / VOX.SUB_M));
  let nPrisms = 0, nTrees = 0, coverVolume = 0;

  for (const pr of (geo && geo.prisms) || []) {
    if (!pr || !pr.p || !(pr.h > 0)) continue;
    const b = Math.max(0, pr.b || 0);
    const k0 = Math.max(0, Math.ceil(b / dx - 0.5)), k1 = Math.min(nz - 1, Math.floor(pr.h / dx - 0.5));
    if (k1 < k0) continue;
    const nv = vox_ringToGrid(pr.p, frame, dx, s, box);
    if (!nv || box[1] <= 0 || box[0] >= nx || box[3] <= 0 || box[2] >= ny) continue;
    const nt = vox_coverColumns(s.pts, nv, nx, ny, sub, s.colCov, s.touched);
    if (!nt) continue;
    nPrisms++;
    const solid = !(pr.s < 1), sf = solid ? 1 : Math.max(0, pr.s);
    const target = solid ? cover : poro;
    for (let t = 0; t < nt; t++) {
      const q = s.touched[t], v = s.colCov[q] * sf;
      s.colCov[q] = 0;
      if (solid) coverVolume += v * (k1 - k0 + 1);
      for (let k = k0; k <= k1; k++) target[k * nxy + q] += v;
    }
  }

  // Trees: porous crowns (see the block comment above).
  const TS = VOX.TREE_SUB, gp = [0, 0, 0], ctr = new THREE.Vector3();
  for (const tr of (geo && geo.trees) || []) {
    if (!tr || !(tr.h > 0) || !(tr.r > 0)) continue;
    const lad = tr.lad === undefined ? VOX.LAD_ON : tr.lad;
    if (!(lad > 0)) continue;
    const zb = tr.cb >= 0 && tr.cb < tr.h ? tr.cb : Math.min(Math.max(VOX.CROWN_BASE_MIN, tr.h * VOX.CROWN_BASE_FRAC), tr.h / 2);
    const rv = (tr.h - zb) / 2, yc = (tr.h + zb) / 2;
    vox_worldToTunnel(frame, ctr.set(tr.x, 0, tr.z), gp);
    const ga = gp[0] / dx, gc = gp[1] / dx, rr = tr.r / dx;
    const i0 = Math.max(0, Math.floor(ga - rr)), i1 = Math.min(nx - 1, Math.floor(ga + rr));
    const j0 = Math.max(0, Math.floor(gc - rr)), j1 = Math.min(ny - 1, Math.floor(gc + rr));
    const k0 = Math.max(0, Math.floor(zb / dx)), k1 = Math.min(nz - 1, Math.floor(tr.h / dx));
    if (i1 < i0 || j1 < j0 || k1 < k0) continue;
    nTrees++;
    const m0 = (VOX.PF_PER_LAD * lad * dx) / VOX.PF_DX_REF;
    const ir2 = 1 / (rr * rr), irv = dx / rv;   // horizontal in cells, vertical in cell units → unit sphere
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      let inside = 0;
      for (let sk = 0; sk < TS; sk++) {
        const zz = (k + (sk + 0.5) / TS - yc / dx) * irv, z2 = zz * zz;
        if (z2 > 1) continue;
        for (let sj = 0; sj < TS; sj++) {
          const cc = j + (sj + 0.5) / TS - gc;
          for (let si = 0; si < TS; si++) {
            const aa = i + (si + 0.5) / TS - ga;
            if ((aa * aa + cc * cc) * ir2 + z2 <= 1) inside++;
          }
        }
      }
      if (inside) poro[(k * ny + j) * nx + i] += (m0 * inside) / (TS * TS * TS);
    }
  }

  // Encode: solid above half cover, else the summed porous fraction.
  const grid = new Uint8Array(n);
  let nSolid = 0, nPorous = 0;
  for (let q = 0; q < n; q++) {
    const c = cover[q];
    if (c > VOX.SOLID_COVER + VOX.COVER_EPS) { grid[q] = VOX.SOLID; nSolid++; continue; }
    const m = c + poro[q];
    if (m < VOX.MIN_FRACTION) continue;
    grid[q] = Math.min(VOX.POROUS_MAX, Math.max(1, Math.round(m * 255)));
    nPorous++;
  }
  const atlas = vox_toAtlas(grid, T);
  return {
    grid, atlas,
    stats: { prisms: nPrisms, trees: nTrees, solid: nSolid, porous: nPorous, coverVolume: coverVolume * dx * dx * dx, ms: performance.now() - t0 },
  };
}

// A grid array (q = (k·ny + j)·nx + i) laid out as the 2D atlas (architecture §5.1).
function vox_toAtlas(grid, T) {
  const { nx, ny, nz, tx, W, H } = T;
  const atlas = new Uint8Array(W * H);
  for (let k = 0; k < nz; k++) {
    const ox = (k % tx) * nx, oy = Math.floor(k / tx) * ny;
    for (let j = 0; j < ny; j++) atlas.set(grid.subarray((k * ny + j) * nx, (k * ny + j + 1) * nx), (oy + j) * W + ox);
  }
  return atlas;
}

// ------------------------------------------------------------------ roads and heating → source weights
/*
 * rasterizeSources(geo, frame, T) → Float32Array(W·H·4): per-cell weights of the four source groups in
 * RGBA = A (Vukovarska), B (Miramarska), C (other motor roads), D (domestic heating), laid out as the atlas
 * (architecture §5.3). The scalar solver reads them as σ_P·V (physics §5.8).
 *
 * Groups A–C: a road of group g contributes (its length inside the cell, m) × aadt / aadt_unit, so the
 * group's unit source q_g is the emission of 10 000 veh/day (SITE.model_defaults.aadt_unit). Each segment
 * is cut into n_l pieces along and n_w points across its carriageway width w (both ≈ dx/4 apart); every
 * point carries L·aadt/unit / (n_l·n_w) into the lowest cell layer (0 … dx). The sum over the points is the
 * segment's L·aadt/unit exactly, so the total is conserved for every road inside the tunnel.
 *
 * Group D: a heating polygon contributes (its plan area inside the cell column, m²) × w, in the layer that
 * holds the roof level of the low-rise houses (VOX.HEAT_Z = 8 m), so q_D is in g m⁻² s⁻¹.
 *
 * Nothing is placed in the last 100 m before the outlet (the LBM sponge, physics §5.3); pass
 * opts.outletGap = 0 to keep everything. Roads with g = null (footways, tram) carry no emissions.
 */
function rasterizeSources(geo, frame, T, opts = {}) {
  const { nx, ny, nz, dx, tx, W, H } = T;
  const out = new Float32Array(W * H * 4);
  const unit = MD.aadt_unit;
  const aEnd = nx - (opts.outletGap === undefined ? VOX.SRC_OUTLET_GAP : opts.outletGap) / dx;
  const texel = (i, j, k) => ((Math.floor(k / tx) * ny + j) * W + (k % tx) * nx + i) * 4;
  const GROUP = { A: 0, B: 1, C: 2 };
  const step = dx / VOX.SRC_SUB;
  const ox = frame.origin.x, oz = frame.origin.z;
  const exx = frame.ex.x / dx, exz = frame.ex.z / dx, eyx = frame.ey.x / dx, eyz = frame.ey.z / dx;

  for (const r of (geo && geo.roads) || []) {
    const g = GROUP[r && r.g];
    if (g === undefined || !(r.aadt > 0) || !r.p || r.p.length < 2) continue;
    const w = r.w > 0 ? r.w : Math.max(1, r.l || 1) * VOX.LANE_W;
    const perM = r.aadt / unit, nw = Math.max(1, Math.ceil(w / step)), wc = w / dx;
    for (let v = 1; v < r.p.length; v++) {
      const x1 = r.p[v - 1][0] - ox, z1 = r.p[v - 1][1] - oz, x2 = r.p[v][0] - ox, z2 = r.p[v][1] - oz;
      const a1 = x1 * exx + z1 * exz, c1 = x1 * eyx + z1 * eyz, a2 = x2 * exx + z2 * exz, c2 = x2 * eyx + z2 * eyz;
      const da = a2 - a1, dc = c2 - c1, lc = Math.hypot(da, dc), L = lc * dx;
      if (!(L > 0)) continue;
      // Quick reject: the carriageway band lies outside the tunnel.
      if (Math.max(a1, a2) + wc < 0 || Math.min(a1, a2) - wc >= nx || Math.max(c1, c2) + wc < 0 || Math.min(c1, c2) - wc >= ny) continue;
      const nl = Math.max(1, Math.ceil(L / step)), wt = (L * perM) / (nl * nw);
      const na = -dc / lc, nc = da / lc;   // unit normal in grid units
      for (let u = 0; u < nl; u++) {
        const t = (u + 0.5) / nl, a = a1 + t * da, c = c1 + t * dc;
        for (let s = 0; s < nw; s++) {
          const off = ((s + 0.5) / nw - 0.5) * wc;
          const aa = a + na * off, cc = c + nc * off;
          if (aa < 0 || cc < 0 || aa >= aEnd || cc >= ny) continue;
          out[texel(Math.floor(aa), Math.floor(cc), 0) + g] += wt;
        }
      }
    }
  }

  // Group D: heating polygons, area × weight, at roof level.
  const heat = (geo && geo.heating) || [];
  if (heat.length) {
    const s = vox_buffers(T), box = [0, 0, 0, 0];
    const sub = Math.max(4, Math.ceil(dx / VOX.SUB_M));
    const kH = clamp(Math.floor(VOX.HEAT_Z / dx), 0, nz - 1), area = dx * dx;
    for (const hp of heat) {
      const wgt = hp && hp.w !== undefined ? hp.w : 1;
      if (!hp || !(wgt > 0) || !hp.p) continue;
      const nv = vox_ringToGrid(hp.p, frame, dx, s, box);
      if (!nv || box[1] <= 0 || box[0] >= nx || box[3] <= 0 || box[2] >= ny) continue;
      const nt = vox_coverColumns(s.pts, nv, nx, ny, sub, s.colCov, s.touched);
      for (let t = 0; t < nt; t++) {
        const q = s.touched[t], cv = s.colCov[q];
        s.colCov[q] = 0;
        const i = q % nx, j = (q - i) / nx;
        if (i + 0.5 >= aEnd) continue;
        out[texel(i, j, kH) + 3] += cv * area * wgt;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ distance to the nearest wall
/*
 * wallDistance(grid, T) → Float32Array(nx·ny·nz), metres from each cell centre to the nearest solid
 * surface or the ground, for the mixing length ℓm = (1/(κ d_w) + 1/λ)⁻¹ (physics §4.3). Solid cells get 0.
 *
 * A multi-source breadth-first search from every solid cell (mask ≥ 250) over the 26 neighbours. Each cell
 * inherits the nearest solid cell of the neighbour it is reached from, and is queued again whenever a
 * neighbour offers a nearer one, so the result is close to the exact Euclidean distance (the classic
 * nearest-seed propagation; errors are a small fraction of a cell). The distance to a solid cell is to
 * its nearest point, the cube [s − ½, s + ½]³: per axis max(|Δ| − ½, 0), so a face neighbour is dx/2
 * away. The ground is a wall too: (k + ½)·dx. Porous cells (trees) are not walls. Tunnel edges are open.
 */
function wallDistance(grid, T) {
  const { nx, ny, nz, dx } = T, nxy = nx * ny, n = nxy * nz;
  const out = new Float32Array(n);
  const best = new Float32Array(n).fill(Infinity);   // squared distance in cells²
  const seed = new Int32Array(n).fill(-1);
  let cap = Math.max(1024, n), queue = new Int32Array(cap), head = 0, count = 0;
  const push = (q) => {
    if (count === cap) {   // grow the ring buffer, unrolled from head
      const bigger = new Int32Array(cap * 2);
      for (let x = 0; x < count; x++) bigger[x] = queue[(head + x) % cap];
      queue = bigger; head = 0; cap *= 2;
    }
    queue[(head + count) % cap] = q; count++;
  };
  for (let q = 0; q < n; q++) if (grid[q] >= 250) { best[q] = 0; seed[q] = q; push(q); }
  while (count) {
    const q = queue[head]; head = (head + 1) % cap; count--;
    const sq = seed[q], si = sq % nx, sj = Math.floor(sq / nx) % ny, sk = Math.floor(sq / nxy);
    const i = q % nx, j = Math.floor(q / nx) % ny, k = Math.floor(q / nxy);
    for (let c = Math.max(0, k - 1); c <= Math.min(nz - 1, k + 1); c++) {
      const dz = Math.max(Math.abs(c - sk) - 0.5, 0), dz2 = dz * dz;
      for (let b = Math.max(0, j - 1); b <= Math.min(ny - 1, j + 1); b++) {
        const dy = Math.max(Math.abs(b - sj) - 0.5, 0), dyz2 = dy * dy + dz2;
        for (let a = Math.max(0, i - 1); a <= Math.min(nx - 1, i + 1); a++) {
          const r = (c * ny + b) * nx + a;
          if (grid[r] >= 250) continue;
          const dxa = Math.max(Math.abs(a - si) - 0.5, 0), d2 = dxa * dxa + dyz2;
          if (d2 < best[r] - 1e-6) { best[r] = d2; seed[r] = sq; push(r); }
        }
      }
    }
  }
  for (let k = 0; k < nz; k++) {
    const ground = (k + 0.5) * dx;
    for (let q = k * nxy, e = q + nxy; q < e; q++) out[q] = grid[q] >= 250 ? 0 : Math.min(Math.sqrt(best[q]) * dx, ground);
  }
  return out;
}

// ------------------------------------------------------------------ geometry without the scene module
/*
 * The flow geometry straight from ENV, used by aero.js only when the scene module's cityGeometry() is
 * missing (running in isolation) or fails: every ZG3D/OSM part as a solid prism, every mapped tree plus
 * the station tree (critic §1.6: ≈ 18 m crown next to the inlet; 14 m tall by default, critic G8) as a
 * porous crown with the leaf-on LAD, the roads and the heating polygons as they are. The container is
 * not in ENV.buildings, so it stays out of the mask (critic §4.2).
 */
function vox_envGeometry(env = ENV, leaves = 'on') {
  const lad = leaves === 'off' ? VOX.LAD_OFF : VOX.LAD_ON;
  const e = env || {};
  const prisms = (e.buildings || []).map((b) => ({ p: b.p, b: b.b || 0, h: b.h, s: 1 }));
  const trees = leaves === 'none' ? [] : (e.trees || []).map((tr) => ({ x: tr.x, z: tr.z, h: tr.h, r: tr.r, lad }));
  // The station tree only if ENV.trees does not already hold it (env.json lists it there with k 'station';
  // the same test as city.js ct_baseTrees, so the crown is not voxelised twice with double porosity).
  const st = e.station && e.station.tree;
  const listed = st && (e.trees || []).some((tr) => tr && (tr.k === 'station' || (Math.hypot(tr.x - st.x, tr.z - st.z) < 1.5 && tr.r >= st.r * 0.8)));
  if (st && !listed && leaves !== 'none') trees.push({ x: st.x, z: st.z, h: st.h, r: st.r, lad });
  return { prisms, trees, roads: e.roads || [], heating: e.heating || [] };
}

// A 32-bit FNV-1a hash of everything in a geometry that changes the flow or the sources, on 0.1 m
// (the precision of env.json, architecture §4.1). Keys the flow cache, so a moved custom block or a
// leaf-off toggle never reuses a stale flow.
function vox_geoHash(geo) {
  let h = 0x811c9dc5;
  const mix = (v) => { const x = Math.round(v * 10) | 0; for (let s = 0; s < 32; s += 8) { h ^= (x >>> s) & 255; h = Math.imul(h, 16777619); } };
  const g = geo || {};
  for (const p of g.prisms || []) { mix(p.b || 0); mix(p.h); mix(p.s === undefined ? 1 : p.s); for (const v of p.p || []) { mix(v[0]); mix(v[1]); } }
  mix(-1);
  for (const tr of g.trees || []) { mix(tr.x); mix(tr.z); mix(tr.h); mix(tr.r); mix(tr.lad === undefined ? VOX.LAD_ON : tr.lad); }
  mix(-2);
  for (const r of g.roads || []) { if (!r || !r.g) continue; mix(r.aadt || 0); mix(r.w || 0); mix(r.g.charCodeAt(0)); for (const v of r.p || []) { mix(v[0]); mix(v[1]); } }
  mix(-3);
  for (const hp of g.heating || []) { mix(hp.w === undefined ? 1 : hp.w); for (const v of hp.p || []) { mix(v[0]); mix(v[1]); } }
  return (h >>> 0).toString(16).padStart(8, '0');
}
