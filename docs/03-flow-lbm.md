# 03 · Wind: the GPU wind tunnel, voxelisation and the job pipeline

This chapter describes how the page computes the mean wind through the 3D neighbourhood on the GPU: the rotated
tunnel and its grids, the Lattice-Boltzmann method and its inflow profile, how buildings, trees, roads and heating
become cells and source weights, the job queue and caches that deliver fields to the rest of the page, and the export
of the receptor lookup table (LUT) that the calibration and the forecast use. The pollutant solver that runs on this
flow is [04 Dispersion](04-dispersion.md); the calibration that uses the LUT is [07 Calibration](07-calibration.md).

*First draft by the flow owner [flow]. Covers `src/js/voxel.js`, `src/js/wind-tunnel.js`, `src/js/aero.js`,
`src/js/tests/flow.test.js` and `tools/export_lut.py`. All numbers below were computed or measured on 2026-09-27/28
with the code of this draft; the commands to reproduce them are in §11. The measurements over the real city (§5.2,
§5.3, §8) and the embedded 10 m LUT (§8.3) used the env.json of 2026-09-27T21:58:45Z (4,304 buildings, 1,828 trees),
before the frame fix of 2026-09-28 (docs/02 §2.3). The current env.json has 4,275 buildings and 1,807 trees; the
numbers are kept as measured, and the 5 m LUT export runs on the current geometry.*

The binding specification is `docs/architecture.md` §5.1–5.2 and §6.2, with `docs/research/physics.md` §1, §6 and §11.3
and `docs/research/critic.md` §4.3–4.4 (the critic's decisions override the other reports where they disagree).
The GPU wind tunnel is **adapted from [maksimir-pod-kisom](https://github.com/ivanrezic/maksimir-pod-kisom) © 2026 Ivan
Rezić, MIT**; the header of `wind-tunnel.js` keeps that credit.

---

## 1. What this part does

For one wind direction, the app needs the mean wind through the real neighbourhood of ZAGREB-1, as a fraction of the
10 m reference wind U10, so that the pollutant solver (`scalar.js`, chapter 04) can carry the traffic emissions to the
inlet. This part:

1. turns a tunnel of 600 m × 600 m × 160 m to face the wind, with the station 300 m from the inlet (§2);
2. cuts the city into the tunnel's cells: buildings into solid and porous cells, trees into porous cells (§4.1–4.3),
   roads and heated houses into source weights (§4.4), and the solids into a wall-distance field (§4.5);
3. runs a Lattice-Boltzmann (LBM) simulation of the flow on the GPU: first on a coarse grid, then on the fine grid
   seeded from it (§3, §5);
4. hands the averaged flow to the scalar solver ([04 Dispersion](04-dispersion.md) §1.1 lists what it reads), reads
   the results back and caches them (§6);
5. in the `?sweep=lut` mode, computes all 16 directions × 3 stability groups and exports the receptor LUT that
   calibration and the forecast use (§7).

```
cityGeometry(scenario) ──► voxelize ──► mask ─┐
   (city.js)             rasterizeSources ──► src ─────────────────────┐
                         wallDistance ──► d_w ─────────────────────────┤
tunnelFrame(dir) ─────────────────────────────┤                          │
                                              ▼                          ▼
inflowProfile(z) ─► WindTunnel(SPINUP 10 m) ─► WindTunnel(TUNNEL 5 m) ─► flow() ─► ScalarSolver ─► ScalarField
                     spin-up                    seeded fine run          │           (scalar.js)      │
                                                                         └─► collect() ─► WindField   │
                                                                                            │          │
                               Aero: queue, LRU caches, IndexedDB, exportLUT/sweepLUT ◄──────┴──────────┘
```

### 1.1 Inputs and outputs

| | What | From / to | Format |
|---|---|---|---|
| in | Geometry of a scenario: prisms `{p, b, h, s}`, trees `{x, z, h, r, lad, cb}`, roads, heating | `cityGeometry(scenario)` (city.js); fallback `vox_envGeometry(ENV)` | architecture §6.3 |
| in | Site constants: tunnel box, z0, d, H̄, z0r, z_b, κ, AADT unit | `SITE.extent.tunnel`, `SITE.model_defaults` (config/site.json) | JSON |
| in | Turbulence object per stability group | `turbParams()` (meteo.js), fallback `aero_turbFallback` | architecture §6.2 |
| out | Mean flow for the scalar solver | `WindTunnel.flow()` → `{avg, samples, uLattice, mask, T, frame, grid, from}` | GPU textures (RGBA32F atlas, R8 atlas) |
| out | Mean flow on the CPU | `WindField`: `data[((z·ny+y)·nx+x)·4] = (u, v, w, ⟨|u|⟩)` / U10 in tunnel axes; `mask`, `frame`, `T` | Float32Array |
| out | Source weights | `rasterizeSources()` → `Float32Array(W·H·4)`, RGBA = groups A, B, C, D | atlas |
| out | Wall distance | `wallDistance()` → `Float32Array(nx·ny·nz)` in m | grid |
| out | Result per key `{scenario, dir, stab}` | `Aero.onResult(res)`: `{key, wind, conc, receptor, mast, timing}` | objects |
| out | Receptor LUT | `Aero.exportLUT()` → `src/data/lut_receptor.json` via `tools/export_lut.py` | architecture §4.4 |

---

## 2. Frames and grids

### 2.1 The tunnel frame (`tunnelFrame`, voxel.js)

For wind **from** bearing θ (meteorological, clockwise from north; architecture §2):

| Symbol | Definition | Meaning |
|---|---|---|
| **e**x | (−sin θ, 0, cos θ) | the direction the wind blows toward, i.e. downwind |
| **e**y | (−e_x,z, 0, e_x,x) | across the tunnel |
| **o** | station − **e**x·up − **e**y·(ny·dx/2), y = 0 | the inlet's near corner on the ground |

A world point **p** maps to tunnel metres (a, c, y) = ((**p**−**o**)·**e**x, (**p**−**o**)·**e**y, p_y), and cell
(i, j, k) spans [i·dx, (i+1)·dx) along **e**x, and likewise across and up. As in the reference, (**e**x, **e**y, up) is a
left-handed triple in the right-handed world frame. That only affects how `WindField.vel()` maps components back to the
world, and the lattice is mirror-symmetric. Test `flow.frame` checks the orientation for all 16 directions, the station
at (up, W/2), the world ↔ tunnel round trip to 10⁻⁹ m, and `WindField`'s atlas → grid → world indexing.

### 2.2 Grids (`tunnelGrid`, wind-tunnel.js)

`tunnelGrid(dx, {warm, avg, along, across, height, up})` returns `{dx, up, nx, ny, nz, tx, W, H, warm, avg, every, id, ft}`.
The box comes from `SITE.extent.tunnel` (600 × 600 × 160 m, `up` = 300 m). Each horizontal layer k is one tile of a 2D
texture at `(k % tx, floor(k/tx))`, with tx = ⌈√nz⌉ (physics Eq. 1.1).

| Grid | Use | nx × ny × nz | Cells | Atlas W × H | Flow-through ft (steps) |
|---|---|---|---|---|---|
| 5 m | fine (`TUNNEL`) on a GPU | 120 × 120 × 32 | 460 800 | 720 × 720 | 1600 |
| 10 m | spin-up (`SPINUP`) for 5 m; fine with `?grid=coarse` or on a software renderer | 60 × 60 × 16 | 57 600 | 240 × 240 | 800 |
| 20 m | spin-up for the 10 m fine grid | 30 × 30 × 8 | 7 200 | 90 × 90 | 400 |

The choice of fine grid: `?grid=coarse` → 10 m, `?grid=fine` → 5 m, otherwise 5 m unless the renderer is software
(SwiftShader, llvmpipe), which gets 10 m as in the reference. The spin-up grid always has twice the fine cell size.

---

## 3. The Lattice-Boltzmann method

The method is the reference's, unchanged except for the inflow and the geometry (physics §1).

### 3.1 Lattice and collision

- **Velocity set:** D3Q19. `LBM` probes whether the GPU can write 5 RGBA32F targets at once (19 populations need 80 bytes
  per cell); if not, D3Q15 with 4 targets; without `EXT_color_buffer_float`, `LBM.ok = false` and the app uses the CPU
  fallback model (fallback.js). SwiftShader passes the D3Q19 probe.
- **Storage:** each population as its offset from the rest weight, f_i − w_i, for fp32 precision.
- **Collision:** BGK with the second-order equilibrium (physics Eq. 1.2)

  f_i^eq = w_i ρ [1 + 3 **c**_i·**u** + 4.5 (**c**_i·**u**)² − 1.5 **u**²]

- **Smagorinsky** sub-grid viscosity through a local relaxation time (Hou et al. 1996; physics Eq. 1.3):

  τ = ½ (τ0 + √(τ0² + 18√2 · C_s² · Q/ρ)),  Q = √(Π^neq : Π^neq),  τ0 = 0.506, C_s = 0.17

- **Safeguards (reference):** |**u**| ≤ 0.3 in lattice units; a cell whose density leaves (0.3, 3) or goes NaN is reset to
  the inflow equilibrium.

### 3.2 Units

The inlet's 10 m-equivalent wind has the lattice speed U_L = `U_LATTICE` = 0.075. For a physical reference wind U_ref
(physics Eq. 1.5):

  Δt = dx · U_L / U_ref,  ν_phys = ν_L · dx · U_ref / U_L,  ν_L = (τ0 − ½)/3 = 0.002

At dx = 5 m and U_ref = 3 m/s: Δt = 0.125 s and ν = 0.4 m²/s, so the building Reynolds number is about 150 whatever the
wind speed. The method relies on the Reynolds-number independence of flow around sharp-edged obstacles (physics §1.5):
one run per direction serves every wind speed, and the output is normalised by U_L to fractions of U10. The inflow reaches
û ≈ 1.89 at the top cell centre (157.5 m), i.e. 0.142 in lattice units, Mach 0.245 < 0.3 (test `flow.inflow`).

### 3.3 Boundary conditions

| Boundary | Treatment | Source |
|---|---|---|
| Inlet (x = 0) | Equilibrium at ρ = 1 with u_x = U_L · û(z_k) from the inflow table (§4.6) | physics §6.3 |
| Lid (top) | Equilibrium with the inflow velocity of the top layer (a moving lid carrying the inlet wind) | reference |
| Outlet (x = nx) | Equilibrium at ρ = 1 with the last cell's own velocity; an 80 m sponge before it where τ0 → τ0 + 0.3 s² | reference, critic §4.4 |
| Sides (y) | Periodic | reference, critic §4.4 (flow only; the scalar has open sides) |
| Ground | **Free-slip:** a population arriving from below is the mirror image of one that left sideways | reference, **critic G12** |
| Solid cells | Link-wise bounce-back; the bits of the links that bounce are computed once per run | reference |
| Porous cells | After collision, blend toward bounce-back with weight 0.6 · m (m = solid fraction) | reference |

**Why free-slip (critic G12).** A no-slip floor at 5 m resolution would wear the inflow profile down within a few
hundred metres, because the first cell centre sits at 2.5 m, deep in what should be a log layer. The reference kept the
ground free-slip so that the drag comes from the resolved obstacles, and critic G12 keeps that decision for v1: in the
city the buildings (λp ≈ 0.25) and the tree crowns carry the drag. The price shows in an **empty** tunnel: with nothing to
hold it back, the slow canopy air near the ground is dragged forward by the faster air above it. Test `flow.lbm.empty`
measures this on a 200 × 100 × 80 m tunnel at 10 m, 100 m downstream of the inlet: the 5 m layer runs at 0.61 instead of
the inflow's 0.175, the 15 m layer at 0.77 instead of 0.69, and every layer from 25 m up stays within 8 % of the profile.
The same tunnel with a plug inflow (û = 1 at all heights), an exact steady solution of these boundary conditions, keeps
û = 1 to 1·10⁻⁵. Over the real city the near-ground flow is held back by the buildings instead (§5.3). A no-slip variant
is listed as a sensitivity test in §10.

---

## 4. Geometry into cells (voxel.js)

### 4.1 Buildings: the prism voxeliser

Rule (critic §4.3 item 5): a cell is **solid** when its centre height z_k = (k + ½)·dx lies between the part's base and
top, b ≤ z_k ≤ h, **and** more than 50 % of its plan area is covered. Otherwise the covered share is its **porous**
fraction m.

Algorithm, per prism (building part):

1. Rotate the footprint ring into tunnel grid units (cells from the origin corner); cull it if its box misses the tunnel.
2. Find the layers k0…k1 with b ≤ z_k ≤ h (k0 = ⌈b/dx − ½⌉, k1 = ⌊h/dx − ½⌋); skip if none.
3. **Scanlines.** Cut the polygon with `sub` lines across the tunnel per cell row (sub = max(4, ⌈dx/0.625 m⌉), i.e. 8 at
   5 m, 16 at 10 m; 0.625 m ≈ the 0.6 m RDP tolerance of the footprints). Pair the crossings even–odd. Each interval adds
   its **exact** overlap with every cell it spans, divided by `sub`. The result is the plan-area cover of each grid column.
   The midpoint rule is exact for straight edges except in the few scanlines through a vertex.
4. Add the column cover to every layer k0…k1. Covers of different prisms **add up**, so two parts of a building that meet
   inside a cell fill it together.
5. After all prisms: cover > 0.5 (+10⁻⁶, so float rounding never decides) → 255 (solid); otherwise byte round(255·m),
   capped at 249 (see §4.3), 0 when m < 0.5/255.

A prism with s < 1 (a screen or a hedge in a scenario) is never solid; it adds s × cover to the porous fraction. There
is no per-cell point-in-polygon test anywhere, which makes it fast (§8.1). The station container is not in the geometry
(critic §4.2), so the station cell stays open (checked for all 16 directions in `flow.voxel` "the real city").

### 4.2 Trees: porous crowns

Each tree is an ellipsoidal crown of horizontal radius r from its base z_b to its top h. z_b is the scene's `cb` when
city.js gives it (the same crown the 3D view draws); otherwise min(max(2.5 m, h/3), h/2). That fallback is a heuristic:
2.5 m is the usual pruning clearance over footways, and h/3 corresponds to a live-crown ratio of 2/3, typical of
open-grown street trees. The share f of each cell's volume inside the crown is sampled on a 4 × 4 × 4 lattice, and the
cell's porous fraction becomes

  m_tree = PF_PER_LAD · LAD · f · (dx / 5 m),  PF_PER_LAD = 0.125 m

which is added to whatever porous fraction the buildings left there. Solid cells stay solid.

| Leaf mode | LAD (site-context §9.1, critic §4.3) | m of a 5 m cell full of foliage | m at 10 m |
|---|---|---|---|
| In leaf (May–October) | 1.2 m²/m³ | **0.150** | 0.300 |
| Leafless (November–April) | 0.3 m²/m³ | **0.0375** (≈ 0.04) | 0.075 |

### 4.3 The porous fraction is a heuristic

The critic (§4.3) is explicit: the mapping from LAD to the reference's porous bounce-back is **not sourced**. It says to
start at 0.15 in leaf and 0.04 leafless and to tune it by the look of the wind reduction behind a crown. PF_PER_LAD =
0.125 m reproduces both starting values with one linear factor. Two further choices are ours and are documented here.

- **The volume share f.** A cell only partly inside a crown gets the corresponding share of the drag: the cell's mean
  leaf area density is LAD·f.
- **Scaling with dx.** The porous blend removes a fixed share of momentum per lattice step. A crown of a given size takes
  ℓ/(dx·U_L) steps to cross, so its total drag would halve on a grid twice as coarse. Scaling m ∝ dx keeps the drag
  through a crown grid-independent, with 5 m as the grid the critic's values refer to.

**Wake of a row of crowns** (slow test `flow.trees.wake`). An endless row of street trees (h = 12 m, r = 4 m, 8 m
apart, crown base 4 m) across a 5 m tunnel, compared with the same tunnel empty; u/u_empty, averaged across the row:

| Behind the row | 1 H | 2 H | 4 H | 6 H |
|---|---|---|---|---|
| In leaf, 7.5 m (crown height) | 0.41 | 0.51 | 0.55 | 0.59 |
| In leaf, 2.5 m (under the crowns) | 0.81 | 0.63 | 0.51 | 0.50 |
| Leafless, 7.5 m | 0.73 | 0.78 | 0.82 | 0.83 |
| Leafless, 2.5 m | 0.97 | 0.89 | 0.82 | 0.81 |

A continuous row in leaf thus acts like a medium-dense windbreak: the minimum is about half the open wind a few tree
heights behind it. Leafless crowns take 20 % off, and air flows freely under the crowns right behind the row. These
magnitudes are in the range usually quoted for tree windbreaks (e.g. Heisler & DeWalle 1988, [lit, from memory,
unverified]). The recovery by 6 H is slow because the free-slip ground does not re-energise the near-ground air. The
critic's starting values are kept. Real street trees stand in gaps between buildings rather than as an endless row, so
the city-wide effect is smaller.

A drag-based cross-check points the other way, towards a weaker value. Canopy drag du/dt = −C_d·LAD·|u|·u over one
lattice step Δt = dx·U_L/U_ref is C_d·LAD·dx·|û|·U_L. The porous blend's momentum loss per step is ≈ 2·0.6·m. Equating
the two with C_d = 0.2, LAD = 1.2 m²/m³, dx = 5 m and a canopy speed |û| ≈ 0.5 gives m ≈ 0.04 in leaf, about a quarter of
the critic's starting value. The quadratic drag also has no exact linear equivalent. The porous byte stops at 249
because the LBM treats a byte above 0.99·255 = 252.45 (so 253 and up) as solid, and `WindField`/the scalar treat ≥ 250 as solid. Tuning is
open (§10).

Test `flow.voxel` "trees" checks the rules: a tree is never solid; a full cell gets 0.150 / 0.0375 at 5 m and 0.300 at
10 m; the porous volume Σ m·dx³ equals PF_PER_LAD·LAD·(dx/5)·V_crown (39.2 against 40.2 m³, within the 8 % sampling
tolerance); leaf-off / leaf-on = 0.25; a crown inside a building stays solid; a crown over a half-covered cell adds to its
0.5.

### 4.4 Sources (`rasterizeSources`)

Per-cell weights of the four source groups in RGBA (architecture §5.3): **A** Vukovarska, **B** Miramarska, **C** other
motor roads, **D** domestic heating. They are read by the scalar solver as σ_P·V (physics §5.8).

- **Roads (A–C):** weight = (length of the road inside the cell, m) × aadt / 10 000 (`SITE.model_defaults.aadt_unit`), so
  the group's unit source q_g is the emission of 10 000 veh/day in g m⁻¹ s⁻¹. Each segment of length L is cut into
  n_l = ⌈L/(dx/4)⌉ pieces along it and n_w = ⌈w/(dx/4)⌉ points across its carriageway width w (`road.w`, or lanes ×
  3.25 m). Every point carries L·aadt/10 000/(n_l·n_w) into the cell below it in the **lowest layer** (0…dx). The points'
  weights sum exactly to the segment's L·aadt/10 000, so the total is conserved for every road inside the tunnel. Roads
  with `g = null` (footways, tram) carry nothing. The Miramarska southbound band at x = +12…+25.5 m (critic §1.6) comes
  from `road.p`/`road.w` in env.json (geo-data).
- **Heating (D):** weight = (plan area of the heating polygon inside the cell column, m², by the same scanline cover as the
  buildings) × w, in the layer that holds 8 m, the roof level of the low-rise houses (architecture §5.3). q_D is in
  g m⁻² s⁻¹.
- **No sources in the last 100 m before the outlet**, where the LBM sponge distorts the flow (physics §5.3).
  `opts.outletGap = 0` keeps them.

Test `flow.sources`: a two-segment road at ≈ 30° in four tunnel orientations (270°, 300°, 13°, 222.5°) conserves
length × aadt to 10⁻⁴ (float32 accumulation). It stays in its group and in layer 0 and spreads over its carriageway. A
group-B road and a `g = null` road land in the right channels. A rotated 50 × 40 m heating polygon with w = 0.8 sums to
1600 m² ± 0.5 % at the 8 m layer. Sources in the sponge are dropped.

### 4.5 Wall distance (`wallDistance`)

The distance d_w from each cell centre to the nearest solid surface or the ground, for the mixing length
ℓ_m = (1/(κ d_w) + 1/λ)⁻¹ of the scalar closure (physics §4.3). The method is a multi-source breadth-first search from
every solid cell over the 26 neighbours. Each cell inherits its neighbour's nearest solid cell and is queued again
whenever a neighbour offers a nearer one (nearest-seed propagation). The distance to a solid cell is to its nearest
point: per axis max(|Δ| − ½, 0) cells, so a face neighbour is dx/2 away. The ground counts as a wall at (k + ½)·dx.
Porous cells are not walls, and the tunnel edges are open.

Test `flow.wall` compares against brute force on a 20 × 16 × 8 grid with three blocks and one porous cell: the maximum
error was 0 m and the mean error 0 m (the propagation was exact on that case; the test allows 0.25·dx maximum and
0.01·dx mean). `scalar.js` uses this function when it is loaded, else its own fallback.

### 4.6 The inflow profile (`inflowProfile`, wind-tunnel.js)

The mean wind entering the tunnel is û(z) = u(z)/U10, where U10 is the 10 m wind of the weather model (IFS; critic §1.1)
over its own grid-box roughness z0r. v1 is neutral, ψ_m = 0 (physics §4.6, critic §4.4). The profile follows
physics §6.2–6.3, Eq. 6.2, 6.3 and 6.5:

| Step | Formula | Value |
|---|---|---|
| NWP friction velocity | û*_r = κ / ln(10 m / z0r) | 0.1141 |
| NWP wind at the blending height | û(z_b) = (û*_r/κ) ln(z_b/z0r) | 1.593 |
| Urban friction velocity (matched at z_b) | û* = κ û(z_b) / ln((z_b − d)/z0) | **0.1640** |
| Urban log law, z ≥ H̄ | û(z) = (û*/κ) ln((z − d)/z0) | |
| Canopy, z < H̄ (Macdonald 2000) | û(z) = û(H̄) exp(a (z/H̄ − 1)) | û(H̄) = 0.632 |

Parameters: κ = 0.40; z0 = 1.5 m, d = 7 m, H̄ = 14 m (ZG3D morphometry, critic §1.10: 1.47 m, 6.8 m, 14.2 m);
z0r = 0.3 m and z_b = 80 m (physics §6.2); canopy a = 2.0, the middle of physics §6.3's range a ≈ 1–3. Macdonald (2000)
relates a to λf, ≈ 9.6 λf for staggered cube arrays ([lit], unverified), which gives 1.85 for λf = 0.193. physics §6.2's
worked example (d = 8 m, z0 = 1.4 m) gives û* = 0.162, and the code reproduces it (test `flow.inflow`).

| z (m) | 2.5 | 5 | 7.5 | 10 | 15 | 25 | 50 | 80 | 100 | 157.5 |
|---|---|---|---|---|---|---|---|---|---|---|
| û(z), urban | 0.122 | 0.175 | 0.250 | **0.357** | 0.686 | 1.019 | 1.376 | 1.593 | 1.692 | 1.890 |
| NWP log profile over z0r | 0.605 | 0.802 | 0.918 | 1.000 | 1.116 | 1.261 | 1.459 | 1.593 | 1.657 | 1.786 |

**û(10 m) is 0.357, not 1.** U10 is the wind at 10 m over the smoother NWP surface (z0r = 0.3 m). At 10 m inside the
city's canopy the wind is about a third of it. The two profiles agree at z_b by construction, and the NWP profile is 1
at 10 m (both checked in `flow.inflow`). An earlier plan for this test expected inflowProfile(10) ≈ 1. That would drop
the blending-height matching that physics §6.2 and critic §4.4 require (z0r and z_b would then play no role), so the
test checks the matched profile instead.

**The same function in JS and GLSL.** The JS function fills a uniform table `uInflow[NZ]` (lattice velocity
U_L·û at each layer's centre) that the shaders' `inflow(k)` reads for the inlet, the lid and resets. Test `flow.lbm.empty`
checks the table against the function to 10⁻⁷. `WindField.speed/vel` use the same function outside the tunnel.
`new WindTunnel(T, S, {profile})` accepts another profile, used by the tests and by sensitivity runs.

---

## 5. Run control and convergence

### 5.1 The run

A job for one direction runs:

1. **Spin-up** on `SPINUP` (10 m for the 5 m grid), starting from the inflow everywhere: 1.75 flow-throughs of warm-up
   plus 0.43 of averaging (1400 + 344 steps at 10 m).
2. **Fine run** on `TUNNEL` (5 m), started from the spin-up's mean flow, interpolated trilinearly from its open cells:
   0.65 flow-throughs of warm-up plus 0.22 of averaging (1040 + 352 steps at 5 m).
3. **Sampling:** every 3rd step during averaging, Σ(u, v, w, |u|) is accumulated. The mean ÷ (samples·U_L) is the
   output as fractions of U10.

The step counts are given in flow-throughs ft = nx/U_L (steps for the 10 m wind to cross the tunnel once), so they
follow the tunnel length and the cell size. The fractions are the reference's, per flow-through: its 520 m tunnel used
1200 + 300 steps at 10 m and 900 + 300 at 5 m. The spin-up covers the same physical time as a fine run from scratch in
half the steps at an eighth of the cells.

### 5.2 Convergence at the station

Test `flow.timing.converge10m` runs the default NE direction (45°) over the real city at 10 m twice: once as above,
once with the fine warm-up doubled (0.65 → 1.3 flow-throughs).

Geometry: env.json generated 2026-09-27T21:58:45Z (4304 building parts, 1828 trees, 114 heating polygons; the first
build, before the frame fix).

| Quantity near the station | Standard run | Warm-up × 2 | Change |
|---|---|---|---|
| RMS change of ⟨|u|⟩, 1209 fluid points within ±100 m at 4, 10, 20 m | – | – | 9.7 % |
| Mast wind s4 / s10 (fraction of U10) | 0.361 / 0.479 | 0.334 / 0.448 | −7 % / −6 % |
| Mast direction dir4 / dir10 | 26.7° / 29.2° | 27.0° / 29.9° | < 1° |
| Γ_B (Miramarska, dominant for NE) | 0.4637 | 0.4612 | −0.5 % |
| Γ_C (other roads) | 0.0286 | 0.0292 | +2.0 % |
| Γ_D (heating) | 1.278 | 1.286 | +0.6 % |
| Γ_A (Vukovarska, downwind) | 6.6·10⁻⁴ | 6.0·10⁻⁴ | −9 % (of a negligible value) |

The receptor values that matter are converged to within ~2 %. The 6–10 % changes in local speed are mostly the finite
averaging window (0.22 flow-throughs) sampling resolved unsteadiness, not drift. The default run lengths are kept. At the
mast, a NE wind turns to come from 27–29° and slows to ~0.36–0.48 U10: the flow is channelled along Miramarska (bearing
176°/356°). Critic §1.5 warns that the station vane cannot validate N-sector flows.

**Determinism.** Two runs of the same direction on the same geometry gave identical mast winds and receptor Γ to six
significant digits (runs of 2026-09-28 00:0x); the number of scalar sweeps differed by 1 % (611 against 604) because
the scalar's convergence check depends on readback latency. An earlier run on an older env.json gave s4 = 0.428 and
Γ_B = 0.4675, a measure of how much a geometry update moves the numbers.

### 5.3 The profile over the city

Horizontally averaged along-wind speed over the fluid cells (same 10 m run, 45°), against the inflow:

| z (m) | 5 | 25 | 45 | 65 | 85 | 105 | 125 | 145 |
|---|---|---|---|---|---|---|---|---|
| inflow û(z) | 0.175 | 1.019 | 1.325 | 1.499 | 1.620 | 1.714 | 1.790 | 1.854 |
| near the inlet (5–15 % of the length) | 0.310 | 0.763 | 1.293 | 1.466 | 1.583 | 1.668 | 1.742 | 1.767 |
| mid-tunnel (45–55 %), at the station | 0.110 | 0.369 | 1.085 | 1.551 | 1.692 | 1.773 | 1.834 | 1.877 |

At 5 m (same direction), mid-tunnel: 0.135 at 2.5 m (inflow 0.122), 0.425 at 22.5 m (0.958), 1.042 at 42.5 m (1.297),
1.456 at 62.5 m (1.481), 1.682 at 82.5 m (1.607), 1.884 at 142.5 m (1.847).

The buildings slow the canopy layer (≤ 30 m) well below the inflow, and the air displaced upward speeds the layers above
by 3–4 %. The free-slip ground does **not** leave a fast near-ground jet over the city: at mid-tunnel the lowest layer runs
at 0.11 U10 on the 10 m grid (inflow 0.175 at its 5 m centre) and 0.135 on the 5 m grid (inflow 0.122 at 2.5 m), where an
empty tunnel accelerated it to 0.61 (§3.3). Near the inlet the lowest layer is faster (0.31 at 10 m) because the inflow
enters over open ground before meeting the first buildings.

### 5.4 Step pacing and GPU backpressure

The `Aero` queue advances a job by one **batch** of lattice steps (or scalar sweeps) per call of `tick()`, once per
animation frame. Two problems arise with the reference's rule, which grew the steps per frame by × 1.1 below 1/26 s and
shrank them by × 0.9 above 1/18 s, ignoring frames slower than 0.25 s:

1. **WebGL calls return at once and the GPU runs them later.** A self-driven loop (the LUT sweep) has no frame pacing,
   so it queued a whole 10 m LBM run in 0.6 s. Its stage timings then measured only the issuing, and the progress bar
   ran ahead of the GPU. This first measurement took 111 s per direction in total, against 33 s with the brake below.
2. **On software WebGL every frame is slower than 0.25 s.** SwiftShader draws the 3D scene in seconds, so the rule never
   adapted, and the tunnel crawled at its start values (8 spin-up / 4 fine steps per frame). In the full app the first
   field had not arrived after 8 minutes.

The pacing therefore measures the GPU time of each batch itself. Every batch is framed by two fences, one before and one
after. A short `setTimeout` poll (≈ 4 ms resolution) notes when each has passed, and the difference is the GPU time of the
batch alone, even when the page's own drawing shares the GPU. The next batch of the same stage gets n = budget / (time
per step), damped to × ½ … × 2:

| Situation | Budget per batch | Why |
|---|---|---|
| App, rest of the frame < 1000/22 ms | 1000/22 ms − rest (at least 4 ms) | the reference's ~22 frames a second |
| App, rest of the frame ≥ 1000/22 ms (software WebGL) | max(1000/22, ½ × rest) ms | the flow still advances without halving the frame rate again |
| Self-driven LUT sweep | 300 ms | short enough for progress and cancel to react within a second, long enough to amortise overhead |

No new batch is issued until the GPU has passed the last one, so a cancelled job stops within one batch. Stage end
times are stamped with the moment the GPU finished the stage's last batch. The start values are the reference's
(64/16 spin-up/fine steps, 8/4 on software renderers), and the caps (320/64/128 steps for spin-up/fine/scalar,
× 16 when self-driven) are only a safety bound. With this, the full app on SwiftShader at `?grid=coarse` delivers its
first field about 45 s after boot (`tests/browser/smoke.py --wait 300 --query grid=coarse`: PASS).

---

## 6. The job pipeline and caches (aero.js)

### 6.1 Keys, order and stages

A request is a key `{scenario, dir: 0..15, stab: 'AC' | 'D' | 'EF'}` (architecture §6.2). The direction is dir·22.5°
(`DIRS16`). The queue follows the reference: `request(key, 'view')` goes first, replaces the scenario's older view job
and cancels it if it is running; `sweep(keys)` appends. The running job's stage is `spinup`, `fine` or `scalar` (the
names main.js labels as `ui.busy.stage.*`). While in `scalar`, `job.wait` is `'flow'` when a cached flow's readback is
still on its way and `'solver'` when the solver is still reading back the previous result. After the GPU work the job is
read back asynchronously and the queue moves on at once. `onResult(res, kind)` delivers
`{key, wind, conc, receptor, mast, grid, hash, turb, timing}`; `onProgress(job, prog, queue)` reports progress, and
`onProgress(null, 1, [])` is sent once when the queue runs dry.

**Stability groups.** The flow is neutral (v1), so a direction's flow serves all three groups. The first group runs the
LBM; the others go straight to the scalar stage through `ScalarSolver.flowFromField(windField)`. Each group is
represented by its most frequent class in 2025 and that class's median BLH, floored at h_min (physics §6.4 table, IFS per
critic §1.1; floor physics §6.5):

| Group | Class | Share of hours | Median BLH | h_eff used |
|---|---|---|---|---|
| AC | B | 17.5 % (A 3.5 %, C 9.4 %) | 520 m | 520 m |
| D | D | 40.3 % | 135 m | 135 m |
| EF | F | 25.9 % (E 3.4 %) | 30 m | 100 m (h_min) |

`turbParams(cls, {z0, d, Hbar, h_eff})` from meteo.js turns these into the scalar's `turb` object. Without meteo.js, a
local fallback applies Golder L (physics Eq. 6.6) and blending-height matching with the Businger–Dyer ψ_m (Eq. 6.2–6.4).

**Scenarios.** Geometry comes from `cityGeometry(scenario)` (city.js). A scenario with `SCENARIOS[].geo === false` shares
today's flow. Without city.js the geometry is built from ENV directly (`vox_envGeometry`).

### 6.2 Caches

| Cache | Key | Content | Size | Invalidation |
|---|---|---|---|---|
| `cache` (results) | grid \| scenario:dir:stab | `res` incl. `WindField` (7.4 MB at 5 m) and `ScalarField` | LRU 16 (architecture §6.2) | geometry hash on every look-up; `invalidate(scenario)` |
| `flows` | scenario:dir | `WindField`, source raster, wall distance, frame, mast wind | LRU 16 | geometry hash |
| `receptors` | code version \| grid \| geometry hash \| dir \| stab \| turb hash | `{gamma, age, band, wind}` (a few hundred bytes) | unbounded | the key itself |
| IndexedDB `z1-aero/receptor` | as `receptors` | as `receptors` | – | the key: `AERO_VERSION` plus `aero_codeHash()`, a hash of the source text of the voxeliser, LBM, scalar solver and closure (integration addition, 2026-09-28), so values stored by older code are ignored; `exportLUT` writes it as `meta.code_hash` |

The **geometry hash** (FNV-1a over prisms, trees including LAD, source roads and heating, at 0.1 m) means a moved custom
block or a leaf toggle never gets a stale flow, even if the caller forgets `invalidate()`. IndexedDB stores only receptor
values. Every call resolves and never throws, so a private window, blocked storage or a missing API give an empty store.
It is used only by receptor-only sweeps (`sweep(keys, {receptorOnly: true})`, as the LUT sweep does); view jobs always
compute full fields. Memory at 5 m: a full cache is ≈ 16 × (7.4 MB wind + 14.7 MB scalar) ≈ 350 MB, and 8× less at 10 m.

---

## 7. The receptor LUT

### 7.1 `exportLUT(scenario = 'today', classes = ['AC', 'D', 'EF'])`

Returns the architecture §4.4 JSON from the receptor values computed so far for the scenario's current geometry on this
grid:

```jsonc
{ "meta": { "scenario": "today", "grid": "120x120x32@5m", "generated_utc": "…", "version": 1,
            "complete": true, "missing": 0, "status": "complete", "code": "aero-1", "geometry_hash": "…",
            "env_generated_utc": "…", "leaves": "on", "spinup": "60x60x16@10m", "lbm": {"q": 19, "software": false, "gpu": "…"},
            "inflow": {…INFLOW, "ustar": 0.164}, "stab": {"AC": {"cls": "B", "h_eff": 520, …}, …},
            "receptor": [0, 4, 0], "mast_heights_m": [4, 10], "timing": {…} },
  "dirs": [0, 22.5, …, 337.5], "classes": ["AC", "D", "EF"], "groups": ["A", "B", "C", "D"],
  "gamma": [16][3][4], "age": [16][3][4], "band": [16][3][4][2],
  "wind": [16] { "s4": …, "s10": …, "dir4": …, "dir10": … } }
```

Missing entries are `null`. `meta.leaves` is the tree state of the geometry the LUT was computed with (city.js
`cityGeometry().leaves`; the page's 'auto' leaf mode follows the month of the hour shown, so an export in
May–October is leaf-on). `wind[dir]` is the model wind at the mast at 4 m and 10 m (critic §4.2; the anemometer
height is unknown, G3). `s` is the mean speed ⟨|u|⟩ as a fraction of U10, which is what a cup anemometer averages;
`dir` is the "from" bearing of the mean vector.

### 7.2 `?sweep=lut` and `sweepLUT()`: the boot contract

- main.js, once booted, calls `if (PARAMS.get('sweep') === 'lut') aero.sweepLUT()` on its `Aero` (implemented in
  main.js `ui_startLutSweep`).
- `sweepLUT({scenario = 'today', classes, useStored = true})` queues 16 directions × classes, direction-major, so the
  three groups of a direction share one flow. It then drives the queue itself with `setTimeout`; `tick()` calls from
  the page's frame loop are ignored meanwhile.
- Progress: `window.__lutProgress = {state, done, total, failed, computed, job, stage, prog, elapsed_s, eta_s, grid,
  errors}`.
- Result: `window.__lut = exportLUT(…)` plus `meta.timing`; `state` becomes `'done'`. A second call returns the same
  promise.
- If main.js never starts the sweep, `tools/export_lut.py` calls `window.__z1_startLUT()` (defined in aero.js), which
  makes its own `Aero`.
- A receptor-only sweep job whose value is already in the receptor store (computed earlier in the session or
  restored from IndexedDB) is delivered to `onResult` at once as `{key, wind: null, conc: null, receptor, mast,
  grid, hash, stored: true}` (integration fix, 2026-09-28: before, such jobs were counted but never delivered,
  so the page's 16-direction sweep waited for them forever on a second visit).
- Under `?sweep=lut` main.js draws the 3D views at most every 10 s, leaving the GPU to the sweep.

### 7.3 `tools/export_lut.py`

```
python3 tools/export_lut.py [--grid coarse|fine] [--timeout 21600] [--out src/data/lut_receptor.json]
                            [--no-build] [--allow-incomplete] [--start-wait 120] [--poll 5]
python3 tools/export_lut.py --check src/data/lut_receptor.json      # validate only, no browser
```

It builds the page, serves `dist/` and opens `index.html?sweep=lut[&grid=…]` in headless Chromium through
`tests/browser/harness.py` (playwright is a dev-only dependency). It logs `__lutProgress` every 30 s, validates the
result's shape (16 directions, groups A–D, classes, finite non-negative Γ, [min, max] bands, a mast wind per direction)
and writes it. An incomplete LUT is written only with `--allow-incomplete`; otherwise it goes to
`lut_receptor.incomplete.json` for inspection. The browser needs network access for three.js (jsDelivr).

---

## 8. Timings

### 8.1 CPU work per direction (JS, SwiftShader machine, test `flow.voxel` "the real city")

| Step | 5 m | 10 m |
|---|---|---|
| Voxelise (env.json of 2026-09-27T21:58Z, the first build: 4304 prisms, 1828 trees in the geometry; 385 prisms and 267 trees inside the 45° tunnel) | 8 ms mean, 32 ms worst of 16 directions | 2 ms |
| Source raster | 12 ms | – |
| Wall distance (BFS) | 159 ms | – |
| Geometry hash | 4 ms | – |

The plan-area fraction of the lowest solid layer at 5 m is 0.246, the same as the ZG3D λp within 500 m (critic §1.10).
At 10 m it is 0.207: the 50 % rule loses small parts on the coarse grid. An independent Python count gives 404 parts
of h ≥ 2.5 m whose bounding box meets the 45° tunnel; the voxeliser touches 385 (bounding boxes over-count rotated
footprints, and parts thinner than a scanline or too low for a cell centre add nothing).

### 8.2 GPU work per direction on SwiftShader

Measured with test `flow.timing.*` (direction 45°, the default NE wind, over the real city, the full `Aero` pipeline
including the scalar stage for group D). Headless Chromium on SwiftShader (ANGLE → Vulkan → SwiftShader "Subzero",
D3Q19 path) on a 24-core Linux machine. **The machine was shared** with other module owners' headless browsers: the
load average was 10–15 during the final measurements in the table and 31–41 during earlier ones, so these are upper
bounds. Stage times are stamped when the GPU fence after the stage's last batch has passed (§5.4).

| Fine grid | Spin-up | LBM steps (spin + fine) | Spin-up | Fine flow | Scalar (sweeps) | Total per direction |
|---|---|---|---|---|---|---|
| 10 m (60×60×16) | 20 m (30×30×8) | 872 + 696 | 2.6 s | 13.4 s | 5.9 s (614) | **22.0 s** |
| 5 m (120×120×32) | 10 m (60×60×16) | 1744 + 1392 | 31.5 s | 214.7 s | 120.5 s (1751) | **367 s (6.1 min)** |

LBM throughput on SwiftShader is ≈ 3 M cell-steps/s on both grids: 19 ms per 57 600-cell step at 10 m, 154 ms per
460 800-cell step at 5 m. A 5 m direction costs 16.7× a 10 m one: 16× the cell-steps of the LBM, 8× the cells and 2.9× the
sweeps of the scalar. The earlier 5 m measurement with the frame-time rule took 414 s, with identical output.
History of the 10 m figure: 111 s unfenced (the whole run queued at once; on an older env.json), 32.9–35.7 s fenced with
the reference's frame-time rule, 22.0 s with the GPU-time pacing of §5.4. The last two gave bit-identical mast winds and Γ.
A desktop GPU was not available here; physics §5.7 estimates 2–10 s per scalar solve at 5 m on one.

**Whole LUT (16 directions × 3 groups; the flow once per direction, the scalar three times):**

| Grid | Estimate from the table | Recommendation |
|---|---|---|
| 10 m | 16 × (16 s flow + 3 × 6 s scalar) ≈ 9 min, plus the page's own 3D rendering; measured end to end in §8.3 | run on SwiftShader: `tools/export_lut.py --grid coarse` |
| 5 m | 16 × (246 s flow + 3 × 120 s scalar) ≈ 2.7 h; ≈ 3.5–4.5 h in the app, which also draws its views (the 10 m export took 1.6× its estimate) | feasible on SwiftShader as a one-off, and consistent with the app's default grid on a GPU: `tools/export_lut.py --grid fine --timeout 30000` (seconds; docs/10 §10.4) |

**Grid dependence: why the LUT grid matters.** The same direction (45°, group D) on the two grids:

| At the receptor | 10 m | 5 m | 5 m / 10 m |
|---|---|---|---|
| Mast wind s4 / s10 | 0.361 / 0.479 | 0.376 / 0.479 | 1.04 / 1.00 |
| Mast direction dir4 / dir10 | 26.7° / 29.2° | 23.0° / 29.9° | |
| Γ_A (Vukovarska) | 6.6·10⁻⁴ | 1.8·10⁻³ | 2.7 |
| Γ_B (Miramarska) | 0.464 | 0.268 | 0.58 |
| Γ_C (other roads) | 0.0286 | 0.0397 | 1.39 |
| Γ_D (heating) | 1.278 | 0.416 | 0.33 |

The wind at the mast hardly depends on the grid. The concentration response does: the Miramarska kerb is about one
10 m cell from the inlet, so on the coarse grid the source cell almost touches the receptor cell. Γ_D differs 3× for a
specific reason: the heating layer is the one containing 8 m (§4.4), which is the ground layer (0–10 m) at 10 m but the
second layer (5–10 m) at 5 m. Consequences:

1. A LUT and the live fields it is compared with must come from the **same grid**. `meta.grid` says which.
   Implemented in model.js (integration review, 2026-09-28): `ReceptorModel.setField` records the field's grid
   (`field.T.id`), a 'today' field replaces the LUT only on the LUT's grid, and a scenario field on another grid is
   carried onto the LUT as a relative change against the same-grid 'today' field (`mod_deltaOnLut`; architecture §6.1).
2. Calibration (β, U0) must be redone whenever the LUT grid changes.
3. The **recommended production LUT is 5 m**: it is the grid the app uses on any real GPU, and it resolves the 9–12 m
   kerb distance with 2 cells instead of 1. The 10 m LUT is a stop-gap for machines without a GPU and is labelled as such.

The 10 m LUT exported with `tools/export_lut.py --grid coarse` is reported in §8.3. The 5 m production LUT is in §8.4.

### 8.3 The 10 m LUT, exported end to end

`tools/export_lut.py --grid coarse` on 2026-09-28 00:30–00:45: the full app booted headless on SwiftShader at
`index.html?sweep=lut&grid=coarse`, main.js started `aero.sweepLUT()`, and the sweep ran **48 of 48 jobs in 874.8 s
(14.6 min)**. Mean times per job were 17.0 s for the flow (16 runs) and 12.5 s for the scalar (48 solves); they are longer
than the test figures because the page also draws its 3D views. No job failed and the LUT is complete. It was written to
`src/data/lut_receptor.json` (17.8 kB, `meta.grid` = `60x60x16@10m`, geometry hash `864887b6`, env.json of
2026-09-27T21:58:45Z) and passes `--check`.

Re-export in the integration review (2026-09-28 01:16–01:29 local, otherwise idle machine, main.js drawing at most
every 10 s under `?sweep=lut`): **48 of 48 jobs in 772 s (12.9 min)**, 15.2 s per flow and 11.0 s per scalar solve on
average, `meta.leaves` = `on`. Γ and A agree with the first export to 1.0·10⁻⁴ relative (same geometry hash; the
small differences come from where the asynchronous convergence check stopped), and `tools/calibrate.py` then gives the
same β and U0 to four digits (docs/07 §11.1).

Mean over the 16 directions:

| Group | Γ_A (Vukovarska) | Γ_B (Miramarska) | Γ_C (other roads) | Γ_D (heating) | Age A_A / A_B (raw tracer, Γ × m) |
|---|---|---|---|---|---|
| AC (class B, lid 520 m) | 0.097 | 0.184 | 0.0089 | 0.125 | 28.7 / 28.2 |
| D (class D, lid 135 m) | 0.179 | 0.399 | 0.0215 | 0.549 | 108 / 126 |
| EF (class F, lid 100 m) | 0.181 | 0.572 | 0.0279 | 0.783 | 160 / 265 |

The age columns are the raw tracer A_k of architecture §4.4 (units of Γ_k × m); model.js turns them into the plume
age τ = Σ q_k A_k / (U_eff Σ q_k Γ_k) in seconds ([04 Dispersion](04-dispersion.md) §3, §8). Γ rises from unstable
to stable for every group, as it should. By direction (group D): Vukovarska (A, south of the
station) dominates for winds from SSE–S (Γ_A 0.59 at 157.5°, 0.43 at 180°) and is near zero for N–E winds. Miramarska
(B, east) dominates for N–E winds (0.46–0.65) and is low for SW–W (0.008–0.06). The mast wind shows where the station is
sheltered. For approach winds from NW to N (315°–0°), s4 is only 0.02–0.06 U10 and the local wind comes from the far
side (dir4 102° for a 315° approach): the station sits in the recirculating wake of the buildings to its north-west,
which carries Miramarska's air back to the inlet (Γ_B 0.82 at 315°). The station vane cannot confirm this, because it is
unreliable for N-sector flows (critic §1.5). For SW–W winds the mast wind turns to 253–271° at 0.07–0.35 U10.

This LUT is a **stop-gap**. It uses the 10 m grid (see "Grid dependence" above), the provisional geometry of 2026-09-27
(before the frame fix) and the scalar solver as of the same night, so its `band` is the first, half-cell-shifted 3×3×2
block and it has no per-entry `quality` (architecture §4.4). Re-export at 5 m (`--grid fine`, ≈ 3.5–4.5 h on
SwiftShader) once geometry and solver are final, and re-run the calibration afterwards ([10 Runbook](10-runbook.md)
§10.4). That 5 m export was started on 2026-09-28 at 09:28 local on the current geometry; it runs the code of that
moment, so it also has the first band and no `quality` (docs/11 §11.6 item 4).

---

### 8.4 The 5 m LUT (production), exported end to end

`tools/export_lut.py --grid fine --timeout 30000`, run on 2026-09-28 from 09:28 to 12:34 in a detached tmux session
(docs/10 §10.4). The machine was shared with review agents and headless test runs, and the 3D views were drawn at
most every 10 s.

| | |
|---|---|
| Result | **48 of 48 jobs in 11,160 s (3.1 h), 0 failed, complete** |
| Output | `src/data/lut_receptor.json` (18 kB, `meta.grid` = `120x120x32@5m`) |
| Geometry | the rebuilt env.json of 2026-09-28T07:26:42Z (exact frame constants, 4,275 building parts) |
| Timing | about 7 min per new direction (spin-up, fine flow and first scalar solve); 2–3 min for each further stability group, which reuses the flow |
| Validation | `--check` OK; no page errors in the log |
| Known gaps | exported with the page as built at 09:28, so it has no per-entry `quality` and its band is the pre-fix one (`meta.notes`). Γ and A are unaffected |

Γ(5 m)/Γ(10 m), median over the 16 directions:

| Class | A | B | C | D |
|---|---|---|---|---|
| AC | 0.88 | 0.95 | 0.91 | 0.75 |
| D | 1.28 | 0.83 | 0.87 | 0.61 |
| EF | 1.39 | 0.85 | 0.88 | 0.64 |

The calibration on this LUT is in docs/07 §9 and §11.2.

## 9. Parameters

| Parameter | Value | Where | Source |
|---|---|---|---|
| Tunnel box | 600 × 600 × 160 m, station 300 m from the inlet | `SITE.extent.tunnel` | critic §4.4, architecture §5.1 |
| Fine / spin-up cell | 5 m / 10 m (10 / 20 m with `?grid=coarse` or software) | `tunnelGrid`, `WT_FINE_DX` | architecture §5.1 |
| Velocity set | D3Q19 (D3Q15 fallback) | `LBM`, `velocitySet` | reference, physics §1.1 |
| U_LATTICE | 0.075 | wind-tunnel.js | reference, architecture §5.2 |
| τ0, C_s | 0.506, 0.17 | `WT_TAU0`, `WT_CS` | reference, physics Eq. 1.3 |
| Porous blend | 0.6 · m | `WT_POROUS` | reference |
| Sponge | 80 m, τ0 + 0.3 s² | `WT_SPONGE_M` | reference, critic §4.4 |
| Spin-up run | 1.75 + 0.43 flow-throughs | `WT_RUN.spin` | reference, per flow-through |
| Fine run | 0.65 + 0.22 flow-throughs, sampled every 3 steps | `WT_RUN.fine` | reference, per flow-through; §5.2 |
| z0, d, H̄ | 1.5 m, 7 m, 14 m | `SITE.model_defaults` | critic §1.10, §4.5 |
| z0r, z_b, κ | 0.3 m, 80 m, 0.40 | `SITE.model_defaults` | physics §6.2 |
| Canopy a | 2.0 | `INFLOW.a` | physics §6.3 (a ≈ 1–3) |
| Solid cover threshold | > 0.5 | `VOX.SOLID_COVER` | critic §4.3 |
| Scanline spacing | 0.625 m | `VOX.SUB_M` | ≈ RDP 0.6 m, architecture §4.1 |
| LAD in leaf / leafless | 1.2 / 0.3 m²/m³ | `VOX.LAD_ON/OFF` (city.js `ct_LAD`) | site-context §9.1, critic §4.3 |
| Porous fraction per LAD | 0.125 m at 5 m, ∝ dx | `VOX.PF_PER_LAD`, `PF_DX_REF` | critic §4.3 (heuristic) |
| Crown base (fallback) | min(max(2.5 m, h/3), h/2) | `VOX.CROWN_BASE_*` | heuristic (§4.2) |
| Road sub-sampling | dx/4 along and across | `VOX.SRC_SUB` | conservation exact at any spacing |
| Heating height | 8 m | `VOX.HEAT_Z` | architecture §5.3 |
| Source-free outlet zone | 100 m | `VOX.SRC_OUTLET_GAP` | physics §5.3 |
| Group representatives | AC: B, 520 m; D: D, 135 m; EF: F, 100 m | `AERO_STAB` | physics §6.4–6.5 |
| Caches | LRU 16 results, LRU 16 flows | `Aero` | architecture §6.2 |

---

## 10. Limitations

1. **Neutral flow only.** Stability enters through the scalar's K field and lid (chapter 04), not the flow. Stable
   nights would have a steeper inflow profile and weaker canyon exchange; v2 could add 16 stable-profile runs (physics
   §4.6).
2. **Free-slip ground (critic G12).** The drag comes from resolved buildings and trees only. In open areas (parks,
   Lisinski square, wide intersections) the near-ground air is too free; see §3.3 and §5.3. A no-slip or wall-function
   ground variant is the sensitivity test the critic asks for, and it is not implemented yet.
3. **5 m cells against the 9–12 m kerb distance (critic §1.6, G13).** The Miramarska kerb is 2–2.5 cells from the inlet,
   and the receptor at 4 m lies between the cell centres at 2.5 and 7.5 m. The canyon vortex is resolved coarsely.
   The scalar solver reports the representativeness band (min–max over the cells within 1.5 cells of the inlet in the
   two layers around 4 m: 4×4×2 at the ZAGREB-1 inlet, architecture §4.4). A nested 2.5 m inner box is v2. On
   software renderers the fine grid is 10 m, so the kerb is about one cell away; that LUT is correspondingly coarser and
   is marked in `meta.grid`.
4. **Porous trees are heuristic (critic §4.3).** The porous fraction is the critic's unsourced starting value. A row of
   crowns gives a plausible windbreak-like wake (§4.3), but a drag-based cross-check suggests the fraction may be up to
   about 4× too strong, and it has not been compared with a measured crown wake. The station tree (h 14 m, r 9 m, next
   to the inlet) makes this matter for the receptor.
5. **Weak resolved turbulence.** The inlet is steady and the Smagorinsky ν_t is small, so the LBM gives a mean flow
   with little turbulence. The scalar therefore uses a K closure (physics §1.6).
6. **Reynolds number ≈ 150.** Flow around sharp edges is taken to be Reynolds-independent. Separation on rounded or
   porous features is not.
7. **Flat ground.** The 14 m of terrain variation over 1.5 km is ignored (architecture §2).
8. **Short averaging window.** The mean is taken over 0.22 flow-throughs, so local speeds carry a few per cent of
   sampling noise (§5.2).
9. **Staircase geometry.** Rotated footprints become 5 m staircases, softened only by the porous edge cells. At 10 m,
   small parts under 5 m tall disappear (λp 0.21 instead of 0.25).

---

## 11. How to re-run

```bash
export Z1_BROWSER_LIBS=…   # only on machines without the system libraries (see tests/browser/harness.py)
python3 tests/browser/run_selftest.py --only flow. --skip-slow       # the 13 fast flow tests (~30 s on SwiftShader)
python3 tests/browser/run_selftest.py --only flow.timing.10m         # one direction at 10 m + timings  [slow, ~25 s]
python3 tests/browser/run_selftest.py --only flow.timing.5m          # one direction at 5 m + timings   [slow, ~7 min]
python3 tests/browser/run_selftest.py --only flow.timing             # both, plus the convergence check [slow]
python3 tests/browser/run_selftest.py --only flow.trees              # tree-row wake                    [slow, ~35 s]
python3 tests/browser/smoke.py --wait 300 --query "grid=coarse"      # the whole app: first field on SwiftShader
python3 tools/export_lut.py --grid coarse                            # the LUT at 10 m
python3 tools/export_lut.py --grid fine --timeout 30000              # the LUT at 5 m (seconds; hours on SwiftShader)
python3 tools/export_lut.py --check src/data/lut_receptor.json       # validate a LUT
```

Test list (`src/js/tests/flow.test.js`, all names start with `flow.`):

| Test | Checks | Result (2026-09-28) |
|---|---|---|
| `flow.frame` | frame orientation for 16 directions, station position, round trip, grid sizes, `WindField` indexing | passed |
| `flow.voxel` axis-aligned | cell-aligned box exact (96 solid cells); half-cell shift gives halves/quarters; raised base; low and porous prisms; atlas layout | passed |
| `flow.voxel` rotated 30° | cover volume vs analytic area (error 0.000 %) for a rotated rectangle, a rectangle in a rotated tunnel and an L shape; every cell matches a 40×40-point brute-force cover | passed; mask volume +7.6 / +8.3 / +10.3 % (the 50 % rule rounds partly covered cells up to solid) |
| `flow.voxel` trees | §4.2–4.3 rules | passed |
| `flow.voxel` real city | speed, station cell open, λp | passed (§8.1) |
| `flow.voxel: vox_envGeometry keeps the station tree once` | regression (review 2026-09-28): the ENV fallback geometry lists the station tree once, not twice | passed |
| `flow.sources` | length × aadt conservation, groups, layer, heating, sponge | passed |
| `flow.inflow` | closed form, matching at z_b, NWP profile = 1 at 10 m, continuity, monotone, physics §6.2 example, Mach | passed |
| `flow.wall` | BFS vs brute force | passed (max error 0) |
| `flow.lbm.empty` | plug flow exact; profile above 2H̄ within 10 %; inflow table = JS; no NaN | passed (see §3.3) |
| `flow.lbm.block` | zero velocity inside a block, wake < 0.6 × upstream, side flow faster than the wake | passed: upstream 0.687, wake −0.04 (recirculation), side 0.903 |
| `flow.aero.queue` | pipeline incl. the real ScalarSolver, cache hit, flow reuse, stage names, invalidate, view replacement, cancel | passed |
| `flow.aero.lut` | 16 × 3 sweep on a tiny tunnel, §4.4 shape, 16 LBM runs for 48 keys, complete Γ with the scalar solver | passed |
| `flow.timing.10m`, `flow.timing.5m` [slow] | one direction through the full pipeline, timings, profile over the city | passed; §5.3, §8.2 |
| `flow.timing.converge10m` [slow] | fine warm-up doubled: change near the station | passed (RMS 9.7 %, Γ_B −0.5 %); §5.2 |
| `flow.trees.wake` [slow] | wake of a row of porous crowns, in leaf and leafless | passed; §4.3 |

Note: `run_selftest.py --only flow` selects by substring and so also runs other owners' tests whose names contain "flow"
(scalar T1/T1b/T2/age, a scene test). Use `--only flow.` for this chapter's tests alone.

The same commands, with the other pipelines, are in [10 Runbook](10-runbook.md) (§10.4 for the LUT, §10.5 for the
tests).
