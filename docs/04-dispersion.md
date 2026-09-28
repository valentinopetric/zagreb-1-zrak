# 04 · Dispersion: the GPU steady advection–diffusion solver

*First draft by the scalar owner [scalar]. Covers `src/js/scalar.js` and `src/js/tests/scalar.test.js`. All numbers
below were measured on 2026-09-28 in headless Chromium on SwiftShader (software WebGL2, 24-core Linux machine) with
the code as it stands; §14 gives the commands to reproduce them.*

The binding specification is `docs/architecture.md` §5.3 and §6.2, with `docs/research/physics.md` §2–§5 and
`docs/research/critic.md` §4.4–§4.5 (the critic's decisions override the other reports where they disagree). Where
this implementation deviates from the research specification, the deviation is argued and measured in §4.3 and listed in §13.

---

## 1. What this part does

The wind tunnel (chapter 03) delivers, for one wind direction, the time-averaged wind through the 3D city as a
fraction of the 10 m reference wind U10. This part carries the pollutant emissions through that frozen mean flow. For
every cell of the same 3D grid it returns the steady concentration per unit emission of four source groups at once:

| Group (RGBA channel) | Sources | Unit strength q_k | Γ_k units |
|---|---|---|---|
| A (R) | Ulica grada Vukovara | g m⁻¹ s⁻¹ of 10 000 veh/day | m⁻¹ |
| B (G) | Miramarska cesta | g m⁻¹ s⁻¹ of 10 000 veh/day | m⁻¹ |
| C (B) | all other motor roads | g m⁻¹ s⁻¹ of 10 000 veh/day | m⁻¹ |
| D (A) | domestic heating (area source at roof level) | g m⁻² s⁻¹ | – |

A second render target (multiple render targets, "MRT") carries four **plume-age tracers**, one per group. The
NO–NO₂–O₃ chemistry (chapter 06) needs the mean travel time from the source to the receptor.

Because the equation is linear in the sources and all wind-speed dependence is scaled out (§3), **one solve per
(scenario, wind direction, stability group) serves every hour, traffic volume, fleet, emission factor, pollutant
and wind speed.** Everything the user changes afterwards is arithmetic on Γ_k and A_k (model.js).

```
WindTunnel.flow()  ──┐   (or ScalarSolver.flowFromField(windField) for a cached flow)
rasterizeSources() ──┤
wallDistance()     ──┼─► ScalarSolver.begin() ─► K-prep pass ─► Jacobi + TVD sweeps (advance) ─► collect()
turbParams(cls)    ──┘        (CPU: sources,         (û, K̂)       every 50: residual, reduction,       │
                               wall distance, K̂_MO)                  probes → convergence              ▼
                                                                                              ScalarField
                                                    receptor() ─► model.js / LUT   slice(h) ─► visuals.js
```

### 1.1 Inputs and outputs

| | What | From / to | Format |
|---|---|---|---|
| in | Mean flow | `WindTunnel.flow()` → `{avg, samples, uLattice, mask, T, frame, grid, from}`, or `ScalarSolver.flowFromField(windField)` | `avg`: RGBA32F atlas, xyz = Σ lattice velocity over `samples` (porous cells already divided by max(1 − 1.2 m, 0.1) as in the LBM `acc` pass); `mask`: R8 atlas (255 solid, 1–249 porous, 0 fluid) |
| in | Source weights σ_k V per cell | `rasterizeSources(geo, frame, T)` (voxel.js) | `Float32Array(W·H·4)`, atlas layout; road length [m] × AADT/10 000 (A–C), heating area [m²] × weight (D) |
| in | Turbulence of the stability group | `turbParams(cls, morph)` (meteo.js) | `{cls, L, ustar_hat, h_eff, z0, d, Hbar, Sct, lambda, kmin, kappa}` |
| in | Tunnel frame | `tunnelFrame()` (voxel.js) | `{from, ex, ey, origin}` |
| in (opt.) | Wall distance, CPU mask, seed, probes, overrides | `begin(…, opts)` | see `sc_DEFAULTS` in scalar.js |
| out | `ScalarField` | `collect()` | `gamma`, `age`: `Float32Array(n·4)` in grid order `((k·ny + j)·nx + i)·4`; `mask`, `lidK`, `stats` |
| out | Receptor values | `ScalarField.receptor(p = RECEPTOR)` | `{gamma:[4], age:[4], band:[[min,max]×4], inside}` |
| out | Horizontal section | `ScalarField.slice(h)` | `{nx, ny, dx, h, frame, data: Float32Array(nx·ny·8), solid}` |
| out | Point values | `ScalarField.sample(p, out)` | `out[0..3] = Γ`, `out[4..7] = A`; trilinear over fluid cells, false outside |

`stats` = `{sweeps, converged, reason, residual, residualByGroup, mass[4], massErr, massWithinTol, divergence,
probeChange, massSrc[4], massOut[4], srcMoved, srcDropped[4], srcSponge[4], lidK, turb, tvd, ms}`, and
`ScalarField.describe()` renders it as a one-line status in hr/en for the UI ("no silent caps", architecture §7).

---

## 2. The governing equation

For an inert species with mean concentration C [g m⁻³], the Reynolds-averaged advection–diffusion equation is
(physics Eq. 2.1):

$$\frac{\partial C}{\partial t}+\nabla\cdot(\bar{\mathbf u}\,C)=\nabla\cdot(K\,\nabla C)+S .$$

- ū is the LBM mean velocity and K the scalar eddy diffusivity (§5).
- S [g m⁻³ s⁻¹] is the source density.
- Deposition and chemical loss are neglected. Residence times in the 600 m domain are minutes, and dry deposition
  removes < 5 % of PM10 over 100 s (physics §2.1).
- NO–NO₂ partitioning is done afterwards, because NOx and oxidant are conserved (chapter 06).

The solver computes only the **local increment** ΔC. It is zero at inflow, and the measured or forecast urban
background is added separately: C_tot = C_bg + ΔC (Lenschow et al. 2001; physics Eq. 2.2).

---

## 3. Non-dimensionalisation: why one solve serves every wind speed

Three assumptions of the whole model (physics §1.5, §2.4) make the problem speed-free:

1. **Reynolds-number independence** of the flow around sharp-edged buildings (Snyder 1981). The flow pattern is the
   same at every speed: ū(**x**) = U10 · û(**x**). û is exactly what the wind tunnel stores:
   `avg.xyz / (samples · U_LATTICE)`, the fraction of U10.
2. **Mechanical turbulence**: K ∝ U10, i.e. K(**x**) = U10 · K̂(**x**). K̂ has units of metres and is written "K̂ [m]"
   everywhere in the code. It is m² s⁻¹ of diffusivity per m s⁻¹ of U10.
3. **Linear superposition** of the sources: S = Σ_k q_k σ_k(**x**). q_k is the group's reference source strength and
   σ_k the fixed spatial pattern per unit strength.

Substituting into the steady equation and dividing by U10:

$$U_{10}\left[\nabla\cdot(\hat{\mathbf u}\,C)-\nabla\cdot(\hat K\,\nabla C)\right]=\sum_k q_k\,\sigma_k
\;\;\Rightarrow\;\; C=\sum_k \frac{q_k\,\Gamma_k}{U_{10}},\qquad
\nabla\cdot(\hat{\mathbf u}\,\Gamma_k)-\nabla\cdot(\hat K\,\nabla\Gamma_k)=\sigma_k .$$

**Units.** The cell source weight is σ_k V: a road length in metres (A–C), or an area in m² (D).
- A–C: σ_k has units m⁻², and since ∇·(ûΓ) has units of Γ per metre, Γ_k is in **m⁻¹**.
- D: σ_D is in m⁻¹, so Γ_D is **dimensionless**.
- Check: q [g m⁻¹ s⁻¹] · Γ [m⁻¹] / U [m s⁻¹] = g m⁻³ for A–C, and q [g m⁻² s⁻¹] · 1 / U = g m⁻³ for D.

**The low-wind floor.** Turbulence that does not scale with the wind (vehicle-induced turbulence, meandering, heat
island) is lumped into U0. U10 is replaced by U_eff = √(U10² + U0²), the OSPM form, with U0 = 1.4 m/s fitted
against IFS winds (critic §1.1). β is the calibrated emission multiplier (chapter 07). The increment the app uses is
therefore (architecture §5.3):

$$\boxed{\;\Delta C_k\,[\mu{\rm g\,m^{-3}}]=10^6\,\beta\,q_k\,\frac{\Gamma_k}{U_{\rm eff}},\qquad U_{\rm eff}=\sqrt{U_{10}^2+U_0^2}\;}$$

Stability does *not* break this scaling. It enters only through the shape of K̂ (φ_h, û*, the lid; §5). One solve
per stability group (AC, D, EF) is enough.

**Age.** C·τ (concentration times the mean time since emission) obeys the same equation with source C (the "age of
air" technique; physics §5.6). The same scaling gives A_k with

$$\nabla\cdot(\hat{\mathbf u}\,A_k)-\nabla\cdot(\hat K\,\nabla A_k)=\Gamma_k,\qquad
\tau=\frac{\sum_k q_k A_k}{U_{\rm eff}\sum_k q_k\Gamma_k}\;[{\rm s}] .$$

A_k has the units of Γ_k times metres. **A_k/Γ_k is the mean travel distance at unit wind speed**; dividing by U_eff
gives seconds. The LUT stores the raw A_k at the receptor (architecture §4.4).

---

## 4. The numerical scheme

### 4.1 Why a steady finite-volume solver (physics §3)

Three candidates were compared in physics §3.1:

- **(a) a D3Q7 LBM** in the same time loop as the flow;
- **(b) semi-Lagrangian** transport on the frozen flow;
- **(c) a steady, conservative, TVD finite-volume solver** on the frozen mean flow.

(c) was chosen, because:

- it is conservative in flux form;
- it is bounded (an M-matrix);
- it fits four groups in one RGBA target;
- it gives the steady field directly, which the superposition and speed scaling of §3 need.

The LBM's own Smagorinsky ν_t is < 1 m²/s almost everywhere and has no approach-flow turbulence (the inlet is
steady). A K closure is needed whatever the scheme (physics §3.3), which removes the main advantage of (a). (b) is not
conservative and is kept for the display particles only.

### 4.2 Discretisation (physics §5.2)

The grid is the wind tunnel's own: cell-centred cubes of side Δx (5 m fine, 10 m coarse/software), stored as the
reference's tiled 2D atlas. Layer k is tile (k mod t_x, ⌊k/t_x⌋) (physics Eq. 1.1). For a cell P with volume V = Δx³,
faces f ∈ {±x, ±y, ±z} of area A = Δx² with outward normal **n**_f, and neighbour N:

$$\hat F_f=A\,\mathbf n_f\cdot\tfrac12(\hat{\mathbf u}_P+\hat{\mathbf u}_N),\qquad
\hat D_f=\frac{A}{\Delta x}\,\frac{2\hat K_P\hat K_N}{\hat K_P+\hat K_N}\qquad\text{(Eq. 5.1)}$$

Both are zero on a face shared with a solid cell. First-order upwind, implicit, in **continuity-corrected
(advective) form**:

$$a_P\Gamma_P=\sum_f a_f\Gamma_{N_f}+\sigma_PV+b_P^{\rm DC},\qquad a_f=\hat D_f+\max(-\hat F_f,0),\qquad a_P=\sum_f a_f\qquad\text{(Eq. 5.2)}$$

- a_P = Σ a_f instead of the conservative Σ a_f + Σ F_f keeps the system an M-matrix, bounded without over- or
  undershoots, even though the time-averaged, weakly compressible LBM field is not discretely divergence-free
  (Patankar 1980).
- The two forms coincide where Σ_f F_f = 0. Where it is not zero, mass is conserved only as well as the flow conserves it.
- Hence the flow divergence ε_div = Σ_P|Σ_f F_f| / Σ_P Σ_f|F_f| and the mass balance are measured and reported with
  every result (§7), not hidden.

**Second-order van Leer TVD deferred correction** (Khosla & Rubin 1974; van Leer 1974; Sweby 1984):

$$b_P^{\rm DC}=-\gamma\sum_f\hat F_f\big(\Gamma_f^{\rm TVD}-\Gamma_f^{\rm UD}\big),\quad
\Gamma_f^{\rm TVD}=\Gamma_U+\tfrac12\psi(r_f)(\Gamma_D-\Gamma_U),\quad r_f=\frac{\Gamma_U-\Gamma_{UU}}{\Gamma_D-\Gamma_U},\quad
\psi(r)=\frac{r+|r|}{1+|r|}\qquad\text{(Eq. 5.3–5.4)}$$

- U, D and UU are the upwind, downwind and far-upwind cells of the face. If UU is solid, outside the domain or above
  the lid, r = 0 and the face stays upwind.
- The blend γ ramps from 0 to 1 over the first 200 sweeps (critic §4.4). A seeded start (§8) skips the ramp.
- In code, r = (Γ_U − Γ_UU)(Γ_D − Γ_U) / ((Γ_D − Γ_U)² + 10⁻³⁰). This is safe at Γ_D = Γ_U and keeps the iteration
  exactly homogeneous (T6).

Why the correction is mandatory: upwind alone adds a numerical diffusivity ≈ |u|Δx/2 in the flow direction and, for
oblique flow, across it. At 5 m and 1.5 m/s that is ≈ 4 m²/s, comparable to the physical K (physics §5.2). T1b
measures it: with upwind, the crosswind spread of a plume in 45° flow corresponds to K_eff = 2.8 K̂, the theory's 2.77;
with TVD it is 1.1–1.2 K̂.

**Point-Jacobi iteration with relaxation** (physics Eq. 5.5), which is pseudo-time stepping with a local step
Δτ_P = V/a_P:

$$\Gamma_P^{n+1}=(1-\omega_P)\,\Gamma_P^n+\omega_P\,\frac{\sum_f a_f\Gamma_{N_f}^n+\sigma_PV+b_P^{{\rm DC},n}}{a_P}$$

- Cells with a_P < 10⁻⁹ (fully enclosed) are set to 0, and the result is clamped at ≥ 0.
- The critic fixes ω = 0.9 (critic §4.5).
- This implementation uses ω_P = ω everywhere except where the TVD correction is active (§4.3).
- The same coefficients serve the four age tracers, with the source Γ_P V.

### 4.3 Stability of the Jacobi + deferred-correction iteration (a deviation, measured)

**The problem.** With ω_P = ω = 0.9 everywhere, as written in physics §5.5.2, the iteration **does not converge** at
high cell Péclet numbers. The GPU = CPU test grid (§9), with stable-class K̂ (K̂ ≈ 0.08 m near the ground, cell Péclet
|û|Δx/K̂ ≈ 60), shows it:
- the field still changed by 10–15 % per 50 sweeps after 2000 sweeps, on the CPU in float64 as well as on the GPU;
- the neutral case settled only to a 3·10⁻⁵ floor;
- because the limiter switches back and forth, GPU (fp32) and CPU iterates drifted apart by 10⁻³ … 10⁻².

**Why.** A Jacobi sweep with the correction lagged is one *explicit* step in pseudo-time. In incremental form,
Γ_P ← Γ_P + Σ_m c_m (Γ_m − Γ_P) + source, the van Leer correction contributes as follows (ψ(r) ∈ [0, 2],
ψ(r)/r ∈ [0, 2]):

- on an **inflow** face (F_f < 0, N upwind): −F_f·½ψ(r_f)(Γ_P − Γ_N) = −|F_f| α_f (Γ_N − Γ_P), with α_f = ψ/2 ∈ [0, 1].
  This *lowers* the upwind coefficient a_f to a_f − γα_f|F_f| ≥ 0. Harmless.
- on an **outflow** face (F_f > 0, P upwind, UU = P − **e**_f):
  −F_f·½ψ(r_f)(Γ_N − Γ_P) = F_f β_f (Γ_UU − Γ_P), with β_f = ψ/(2r) ∈ [0, 1]. This *adds* up to γF_f.

All coefficients are non-negative, and Harten's (1983) condition for a positive, TVD step is Σ c_m ≤ 1:

$$\sum_m c_m=\frac{\omega_P}{a_P}\Big[a_P-\gamma\sum_{\rm in}\alpha_f|\hat F_f|+\gamma\sum_{\rm out}\beta_f\hat F_f\Big]\;\le\;\omega_P\,\frac{a_P+\gamma F_{\rm out}}{a_P},\qquad F_{\rm out}=\sum_{\rm out}\hat F_f .$$

With ω_P = 0.9 in an advection-dominated cell (a_P ≈ F_in ≈ F_out) the bound reaches 1.8. This is the classic
statement that explicit MUSCL/TVD stepping needs a Courant number ≤ ½ (Sweby 1984; physics §5.4 notes the same for the
time-accurate mode).

**The fix (`sc_relax`).** Use the local relaxation

$$\omega_P=\omega\,\frac{a_P}{a_P+\gamma F_{\rm out}},\qquad F_{\rm out}=\sum_{f:\,N_f\ \text{open}}\max(\hat F_f,0),$$

which gives Σ c_m ≤ ω < 1 in every cell and every sweep.
- It equals ω for upwind (γ = 0) and in diffusion-dominated cells, and ≈ ω/2 where advection dominates and the
  correction is fully on.
- **The fixed point, i.e. the steady solution, does not depend on ω_P**: only the path to it changes.
- The oscillating test case now converges to fp32 round-off: zero change between sweeps 450 and 500, 1000, 2000.
- GPU and CPU agree to 1–2·10⁻⁶, and symmetric set-ups stay symmetric to 10⁻⁶ (T5).

**A rejected alternative.** I also tried a tighter, solution-dependent bound that uses the limiter's actual
coefficients: ω_P from a_P − γΣα|F| + γΣF/(1 + |r|).
- It converged T5 in 750 sweeps instead of 2050.
- But the stable test case kept a 6 % limit cycle after 1500 sweeps.
- And the GPU and CPU transients diverged (3.8·10⁻³ after 260 sweeps), because ω_P then switches with the sign of r.

Robustness was preferred over speed.

### 4.4 GPU implementation

The passes are full-screen triangles over the atlas, one fragment per cell, as in the reference. The grid sizes are
compiled into the shaders, and the shared `stencil()` function is used by both the sweep and the residual pass.

| Pass | When | Reads | Writes |
|---|---|---|---|
| `kprep` | once per `begin()` | `avg`, `mask`, d_w (R32F), `uKmo[NZ]` | `vk` RGBA32F: (û, v̂, ŵ, K̂); K̂ = −1 marks solids |
| `init` | once per `begin()` | seed textures (optional) | `ga[0]` MRT ×2: Γ (RGBA), A (RGBA) |
| `sweep` | every sweep | `vk`, `src`, `ga[cur]` | `ga[1−cur]` MRT ×2 |
| `resid` | every 50 sweeps | as `sweep` | MRT ×3: \|residual\| per group, outflow F⁺Γ at open faces, (\|ΣF\|, Σ\|F\|, ·, 1) |
| `reduce` | after `resid` | previous level | 4×4 block sums, 720² → 180² → 45² → 12² → 3² → 1² |
| `diag` | after `reduce` | `ga[cur]`, last level | 32×3 target: probes Γ (row 0), probes A (row 1), sums (row 2) |
| `copy` | `collect()`, `readVK()` | one MRT attachment | single-attachment readback target |

**Memory** for the 120×120×32 grid (atlas 720×720 texels, 8.3 MB per RGBA32F texture):
- `vk` 1 texture;
- `ga` 2 × 2 textures;
- `resid` 3 textures;
- `src` and readback 1 each;
- d_w a quarter of one.

That is ≈ 85 MB. On the 10 m grid (60×60×16, atlas 240×240) it is ≈ 10 MB.

**Texel reads per cell and sweep:** 3 (own), then per face 1 (VK) + 2 (Γ, A) and, where the correction is on,
1 + 2 (UU). That is ≤ 39 in all.

**Renderer.** Textures live in one WebGL context, and the solver reads the wind tunnel's textures directly. It
therefore draws with the page's `renderer` (scene.js). Without it, it uses the wind tunnel's private `WT_RENDERER`;
only when neither exists does it use a 1×1 renderer of its own (`sc_renderer`).

**Asynchronous readback and flow control.** Probes, residual and mass are read with
`renderer.readRenderTargetPixelsAsync` (three r170: a pixel-pack buffer plus a fence), like the reference's
`collect()`.
- At most one such readback is in flight. When the next check point is reached before it has arrived, `advance()`
  pauses there and returns without work until it does.
- Without this, a caller that submits sweeps faster than the GPU runs them (SwiftShader, or a tight loop) builds a long
  command queue. The fences are then only seen once the queue has drained. Measured: one result in 1500 sweeps, so
  convergence went unnoticed until the cap.
- With flow control, each readback returns in ≈ 0.5 s on SwiftShader, and the GPU queue stays short.
- three leaves its pixel-pack buffer bound while it waits. The solver unbinds it right after issuing the read, so that
  a synchronous `readPixels` elsewhere on the page is not redirected into it.

**Adaptive sweeps per frame.** `advance()` without an argument uses the reference's `Aero.tick` rule: grow the
per-frame count by 10 % while frames come faster than 26 fps, shrink it by 10 % below 18 fps (ignoring hitches
> 0.25 s). The count starts at 8 (GPU) or 1 (software) and is capped at 64 (GPU) or 8 (software). aero.js passes its
own adaptive count; both work.

---

## 5. Eddy-diffusivity closure (K-prep pass, physics §4 and §5.5.1)

$$\hat K=\max\!\Big[\hat K_{\rm MO}(z),\ \frac{\ell_m^2\,|\hat S|}{Sc_t},\ \hat K_{\min}\Big]\qquad\text{(Eq. 4.1; the max, not the sum, to avoid double counting)}$$

**Approach-flow part** (Eq. 4.2–4.3), computed per layer on the CPU (`sc_kmoProfile`) and uploaded as `uKmo[NZ]`:

$$\hat K_{\rm MO}(z)=\frac{\kappa\,\hat u_*\,\hat z}{\phi_h(\hat z/L)}\Big(1-\frac{z'}{h_{\rm eff}}\Big)^2,\qquad z'=\max(z,\bar H),\ \ \hat z=\max(z'-d,\ z_0),\qquad
\phi_h(\zeta)=\begin{cases}(1-16\zeta)^{-1/2}&\zeta<0\\1+5\min(\zeta,1)&\zeta\ge0\end{cases}$$

- K̂_MO is held at its roof-level value below H̄: the canopy is mixed by roof-level eddies, as in OSPM.
- It is zero at and above the lid.
- ẑ is floored at z0, so a displacement height d ≥ H̄ can never give a negative length.

**Resolved-shear part** (Eq. 4.4), per cell on the GPU:
- |Ŝ| = √(2 Ŝ_ij Ŝ_ij), from central differences of û (one-sided next to solids and the domain edges);
- ℓ_m = (1/(κ max(d_w, Δx/2)) + 1/λ)⁻¹;
- d_w is the distance to the nearest solid face or the ground: voxel.js `wallDistance()` when it is loaded, else
  the exact Euclidean distance transform `sc_wallDistance` (Felzenszwalb & Huttenlocher 2012). The two agree within
  0.37 cells, at corners;
- porous cells (trees) are not walls: their drag already shows in the resolved shear.

**Values** (test "CPU helpers"; neutral û* = 0.164, h_eff = 100 m, H̄ = 14 m, d = 7 m):
- K̂_MO = 0.340 m below roof level and 0.707 m at 27.5 m;
- at 27.5 m, stable (L = 30 m) gives 0.160 m and unstable (L = −30 m) gives 2.44 m;
- on the GPU = CPU grid, the strain part lifts K̂ to 5.7 m (stable) and 21 m (unstable) in the shear layers.

**Stability** (physics §4.6) enters only through û*, L (φ_h) and h_eff. The v1 flow is neutral for every class.
Missing `turb` fields fall back to `SITE.model_defaults`:
- a neutral L = ∞, and no lid (h_eff = ∞);
- the neutral blending-height friction velocity (physics Eq. 6.2–6.3): 0.164 for z0 = 1.5 m, d = 7 m, z0r = 0.3 m,
  z_b = 80 m (0.162 for the physics example's z0 = 1.4 m, d = 8 m, reproduced in the tests).

Vehicle-induced turbulence is **not** added to K̂. It is carried by U0 (physics §4.5, the default route), which keeps
the fields speed-invariant.

---

## 6. Boundary conditions (physics §5.3)

| Boundary | Advective flux | Diffusive flux | Implementation |
|---|---|---|---|
| Inflow face (x = 0) and any open face with F < 0 | brings Γ = 0 (increment only) | 0 (zero gradient) | own velocity on the missing side, a_f = \|F\|, no neighbour term |
| Outflow (x = n_x) | upwind: carries Γ_P out | 0 | counted in Φ_out |
| Lateral (y = 0, n_y) | **open**, upwind; inflow brings 0 | 0 | not periodic, unlike the flow (physics §1.6) |
| Top, h_eff ≥ n_z Δx | open, upwind (mean ŵ ≈ 0) | 0 | `uLidK = NZ` |
| Mixing lid, h_eff < n_z Δx | 0 | 0 | on the cell face nearest to h_eff: `lidK = round(h_eff/Δx)`; cells above are outside the solution |
| Ground | 0 | 0 | no deposition (§2) |
| Solid cells (mask ≥ 250) | 0 | 0 | K̂ = −1 from K-prep |
| Porous cells (1–249) | fluid, with the LBM's reduced velocity | fluid | as in the reference's porous treatment |

**Sources** (`sc_prepareSources`):
- a weight in a solid cell (a road under a passage, a heating layer inside a taller block) moves to the first open cell
  above it in the same column, so nothing is silently lost (`stats.srcMoved`);
- a weight with no open cell below the lid is dropped and counted (`stats.srcDropped`);
- weights in the last 100 m before the outlet are dropped (the LBM sponge, physics §5.3; `stats.srcSponge`).
  voxel.js already leaves that zone empty.

---

## 7. Convergence and diagnostics (physics §5.7)

Every 50 sweeps the residual pass, the reduction and the probes are read back asynchronously (§4.4). The criteria:

1. **Probes**: the largest change over the last 100 sweeps of Γ and A at 32 probe cells, each relative to the probe's
   value but never to less than 10⁻³ of the channel's largest probe. It must be < 10⁻³. The probes are:
   - the 3×3×2 receptor band;
   - 8 points along the tunnel centreline at the ground and at n_z/8;
   - 6 off-axis ground points.
2. **Residual**: ‖a_PΓ_P − Σa_fΓ_N − σV − γb^DC‖₁ / ‖σV‖₁ per group; it must be < 10⁻⁴.
3. **Mass**: Φ_out/Φ_src per group, with Φ_src = Σσ_PV and Φ_out = Σ_{open faces} F⁺Γ_P.

**Converged** = (1) ∧ [(2) ∨ (Φ_out/Φ_src changes by < 10⁻³ over the last 100 sweeps)], and never before
`minSweeps` = ramp + window = 300 sweeps (100 when seeded).
- Whether the balance also closes to 2 % (critic §4.5) is reported as `stats.massWithinTol`.
- A persistent mismatch is the flow's own divergence error. It is reported as `stats.massErr` next to
  `stats.divergence`, not hidden.
- The run stops unconverged at 3000 sweeps (critic §4.5), and `stats.converged = false` then says so.

At convergence the solution is at the fp32 fixed point: on the T1 grid, the result stopped by this rule differs by
8·10⁻⁸ (Γ) and 10⁻⁶ (A) from one iterated to a probe tolerance of 10⁻⁵.

**Progress** for the UI is an estimate: max(sweeps / 3000, sweeps / expected). "Expected" starts at ramp + 3 n_x and
is updated from the observed geometric decay of the probe change. It never decreases and stays below 1 until done.

---

## 8. The plume-age tracer and its use in the chemistry

In the slender-plume limit, with no along-wind diffusion, A = Γ · x/û exactly: every particle at x has travelled x/û.
With along-wind diffusion, the moments of the advection–diffusion Green's function give the exact steady result for a
ground point source in 2D. The Green's function is p = 2/(4πK̂t) · exp(−((x − ût)² + z²)/(4K̂t)), and
∫₀^∞ t^{ν−1} e^{−a/t − bt} dt = 2(a/b)^{ν/2} K_ν(2√(ab)):

$$\Gamma=\int_0^\infty p\,dt=\frac{1}{\pi\hat K}e^{\hat u x/2\hat K}K_0\!\Big(\frac{\hat u r}{2\hat K}\Big),\qquad
A=\int_0^\infty t\,p\,dt\;\Rightarrow\;\frac{A}{\Gamma}=\frac{r}{\hat u}\,\frac{K_1(s)}{K_0(s)}\approx\frac{r}{\hat u}+\frac{\hat K}{\hat u^2},\quad s=\frac{\hat u r}{2\hat K}.$$

The small offset K̂/û² is physical. Material that diffused upwind and came back is older. In 1D the offset is
2K̂/û², and in 3D it is zero.

**Use (chapter 06).** For a receptor, τ = Σ_k q_k A_k / (U_eff Σ_k q_k Γ_k) is the concentration-weighted mean travel
time of the local increment. It is the reaction time of the Riccati NO–NO₂–O₃ scheme (critic §4.4; plausibility
≈ 60 s). Because A_k is linear in the group strengths, scenario toggles stay instant. The measured numerical offset
at the source (≈ 1.3 m, §9) is 1 s at U_eff = 1.3 m/s, negligible against τ ≈ 60 s.

---

## 9. Verification results

All tests run in the page (`src/js/tests/scalar.test.js`). They build synthetic grids with prescribed flows and need
no LBM, except T3 and T4, which run the flow owner's `WindTunnel` on small custom grids and are marked `slow`.
Unless stated otherwise, the synthetic grids use Δx = 5 m, and the "neutral closure" is `sc_turbDefaults({})`.

| Test | Set-up | Criterion | Result | Pass |
|---|---|---|---|---|
| **GPU = CPU** | 32×16×12 grid, solid block, porous crown, smooth non-uniform flow, sources in all 4 groups, full closure; (a) stable L = 50 m, û* = 0.12, lid at 40 m (layer 8); (b) unstable L = −30 m, open top; 260 sweeps (whole γ ramp) | max \|Δ\| / max < 10⁻⁴ | K̂: 2.5·10⁻⁷ / 0; Γ: ≤ 7.8·10⁻⁷ / ≤ 2.7·10⁻⁷; A: ≤ 1.6·10⁻⁶ / ≤ 8.4·10⁻⁷ | ✔ |
| **T1** analytic | 96×24×24, û = 1, K̂ = 2 m constant, crosswind ground line source at x_s = 22.5 m | error < 5 % for x > 10Δx (55–350 m, all heights, relative to the ground value) | **TVD 1.86 %** (ground 1.54 %; 0.72 % against the full 2D solution with along-wind diffusion); **upwind 3.02 %** (ground 1.65 %; 1.88 % full); 800 / 650 sweeps | ✔ |
| **T1b** crosswind diffusion | 64×64×2, flow at 45°, K̂ = 1 m, vertical line (horizontal point) source | TVD better than upwind | axis error vs slender plume: **TVD 13.5 %**, upwind 40.4 %; K_eff/K̂ from the crosswind 2nd moment: **TVD 1.11–1.19**, upwind 2.81–2.85 (theory 2.77) | ✔ |
| **T2** mass | T1 | Φ_out/Φ_src = 1 ± 1 % | TVD 1.000000, upwind 0.999995, independent CPU count 1.000000; residual 5·10⁻⁶ | ✔ |
| **Age** | T1, ground cells | vs exact (r/û)K1/K0 < 3 % for x > 10Δx; vs x/û < 5 % for x ≥ 20Δx | TVD: vs exact **2.3 %**; vs x/û 6.0 % at x > 10Δx, **3.3 %** from 20Δx (A/Γ = 58.3, 103.3, 203.3, 303.3 m at x = 55, 100, 200, 300 m; exact 57.0, 102.0, 202.0, 302.0). Upwind 4.6 % / 8.2 % | ✔ |
| **T5** symmetry | 48×24×12, block j = 9…14 centred across, mirror-symmetric flow (û, ŵ symmetric, v̂ antisymmetric), symmetric sources in all groups, neutral closure, lid at 40 m | symmetric to 10⁻⁴ | Γ ≤ 7.7·10⁻⁷, A ≤ 1.2·10⁻⁶; 2050 sweeps | ✔ |
| **T6** linearity | T5 grid, RGBA = (σ1, σ2, σ1+σ2, 2σ1) | 2σ → 2Γ to 10⁻⁵; superposition | 2σ → 2Γ: **0 (bit-exact)**, TVD and upwind; Γ(σ1+σ2) − Γ(σ1) − Γ(σ2): upwind 2.5·10⁻⁷, **TVD 0.43 %** of max (A 0.18 %) | ✔ |
| **T4a** canyon (prescribed vortex) | 48×4×16, W/H = 1, H = 30 m, vortex ψ = −A sin πξ sin πζ, 0.3 û at the roof, floor-centre line source | leeward / windward > 1 | **2.41** (c⁺ = 11.3 leeward, 4.7 windward); 1350 sweeps | ✔ |
| ScalarField API | T1 result | band contains the value; sample = slice at cell centres | receptor Γ = 0.0266 m⁻¹, band [0.0256, 0.0270]; A/Γ = 220.8 m at 217.5 m downwind | ✔ |
| Seed | T1 on 10 m, prolongated to 5 m | same fixed point | start = prolongated field (< 10⁻⁶); result equal to 1.3·10⁻⁷; see §10 for sweeps | ✔ |
| **T3** grid (LBM) | 320×160×120 m box, 30×40×20 m block, road 100 m upwind; 10 m vs 5 m | Richardson estimate reported | Γ₁₀ = 0.0342, Γ₅ = 0.0263 m⁻¹; Richardson (p = 2) 0.0237; **GCI 12.5 %**; mass 1.021 / 1.010 (§9.1) | ✔ (slow) |
| **T4** canyon (LBM) | 320×80×120 m, two 30 m slabs, W/H = 1, perpendicular wind, lateral periodic flow | leeward / windward > 1 | **1.33** (c⁺ 47.0 / 35.4); mass 1.014 (§9.1) | ✔ (slow) |

Notes on the results:

- **T1.** The remaining 1–2 % is mostly the source discretisation. The line is released uniformly over the first
  cell (0–5 m), a top-hat with ⟨z²⟩ = 8.3 m². That shifts the virtual origin by ⟨z²⟩/(2K̂) ≈ 2 m, i.e. ≈ 2 % at 55 m.
  Against the full 2D solution, which includes along-wind diffusion like the numerics, the error halves. In this
  grid-aligned case, upwind is only slightly worse: its numerical diffusion acts along the wind, where it hardly
  matters. T1b is the case where it does matter.
- **T1b.** The axis error of 13.5 % with TVD comes from the coarse plume (σ_y ≈ 2–3 cells) and the residual
  crosswind diffusion (K_eff ≈ 1.15 K̂) of a dimension-by-dimension scheme at 45°, the worst angle. Upwind triples it.
- **T5 mass.** The same run reports Φ_out/Φ_src = 1.33 for group A (flow divergence ε_div = 0.56 %). This is the
  expected behaviour of the continuity-corrected form in a deliberately divergent synthetic flow (§4.2), and the reason
  mass and ε_div are always reported.
- **T6.** The van Leer limiter is nonlinear, so the superposition ΔC = Σ q_k Γ_k assumed by model.js holds to
  ≈ 0.4 % (documented limitation, §11). Homogeneity (scaling all emissions of one group) is exact.

### 9.1 Tests with the LBM flow (T3, T4)

Both run the flow owner's `WindTunnel` (D3Q19 on SwiftShader) on small custom grids, `tunnelGrid(dx, {along, across,
height, up, warm: 3, avg: 1})` (3 flow-throughs of warm-up, 1 of averaging), for wind from 270° (ex = east). The scalar
then solves on the tunnel's own GPU flow (`WindTunnel.flow()`), with the neutral closure, with no seeding and with the
default convergence rule.

**T3: grid convergence.** The box is 320 m along × 160 m across × 120 m high. A 30 m × 40 m × 20 m block stands at
x = −60 … −30 m, and a crosswind road line runs at x = −100 m. Γ is taken at the receptor RECEPTOR = (0, 4 m, 0).

| Grid | Γ at the receptor [m⁻¹] | Sweeps | Φ_out/Φ_src | ε_div |
|---|---|---|---|---|
| 10 m (32×16×12) | 0.0342 | 450 | 1.021 | 0.21 % |
| 5 m (64×32×24) | 0.0263 | 700 | 1.010 | 0.06 % |
| Richardson, p = 2 (formal order of the TVD scheme) | 0.0237 | | | |
| Richardson, p = 1 | 0.0184 | | | |

- The grid convergence index (Roache 1994) GCI₅ = 1.25 |Γ₅ − Γ₁₀| / Γ₅ / (2^p − 1) is **12.5 %** for p = 2 and
  38 % for p = 1.
- The 10 m grid over-predicts the receptor value by 30 % relative to 5 m: the coarse grid resolves the block's wake
  and the near-ground plume poorly.
- This is the main quantitative argument for the 5 m production grid. It also shows why the software fallback at
  10 m has to carry an "approximate" label.
- On LBM flows the mass balance closes to 1–2 %, and the stable relaxation of §4.3 costs few sweeps, because the flow
  is nearly divergence-free (F_out ≈ F_in in every cell).

**T4: street canyon, W/H = 1.** The box is 320 × 80 × 120 m, and the flow is laterally periodic, so the canyon is 2D.
Two 30 m slabs span x = −45 … −15 m and 15 … 45 m (H = W = 30 m = 6 cells), with a line source on the canyon floor
centre.

| Quantity | Value |
|---|---|
| mean Γ along the leeward wall (upwind building's lee face), 0–30 m | c⁺ = Γ H U_H/U_ref = **47.0** |
| mean Γ along the windward wall | c⁺ = **35.4** |
| leeward / windward | **1.33** (> 1, as in CODASC and the canyon literature) |
| U_H (LBM wind at roof height, 100 m upwind) | 0.96 U10 |
| sweeps, Φ_out/Φ_src, ε_div | 1350, 1.014, 0.20 % |

The ratio is smaller than with the prescribed vortex of T4a (2.41). The resolved canyon vortex at 6 cells per width
is weak, and the mixing-length closure mixes the canyon strongly. Wind-tunnel data for perpendicular flow over
W/H ≈ 1 canyons (CODASC) show a leeward/windward contrast of several times near the ground ([lit], quoted from
memory: to be checked against the CODASC database before release). So the model probably **under-estimates the
contrast**. The contrast matters at ZAGREB-1, where the inlet sits on the building side of Miramarska (§12,
limitation 4).

---

## 10. Performance

Sweeps per second on SwiftShader (ANGLE → Vulkan → SwiftShader Subzero, 24 cores), timed after warm-up with a
synchronous read (test "perf"). The values varied between runs on the shared machine:

| Grid | Cells | Sweeps/s | ms/sweep | Mcell-sweeps/s | `begin()` (K-prep, wall distance, uploads) |
|---|---|---|---|---|---|
| 60×60×16 (10 m, software default) | 57 600 | 63–103 (final run: 80.5) | 10–16 (12.4) | 3.6–5.9 (4.6) | 0.2 s |
| 120×120×32 (5 m, fine) | 460 800 | 9–15 (final run: 12.4) | 67–107 (80.8) | 4.3–6.9 (5.7) | 0.5–0.8 s |

Measured solve lengths:

| Case | Sweeps (TVD) | Sweeps (upwind) |
|---|---|---|
| T1 (96×24×24, open flow) | 800 | 650 |
| T5 (block, divergent synthetic flow) | 2050 | 750 |
| T4a (canyon vortex) | 1350 | – |
| T1 seeded from 10 m (ramp skipped) | 650 | – |
| T3, LBM flow, 10 m / 5 m | 450 / 700 | – |
| T4, LBM canyon, 5 m | 1350 | – |

A converged 5 m solve of 800–2000 sweeps therefore takes ≈ 1.5–3.5 min on SwiftShader, and a 10 m one ≈ 10–30 s.

On a discrete GPU, physics §5.7 estimates 2–5 ms per sweep at this size, i.e. 2–10 s per (direction, class). This is
cached afterwards.

The diagnostics cost one sweep-like pass plus five tiny reductions every 50 sweeps, ≈ 2 %.

---

## 11. Parameters

| Symbol / name | Value | Source |
|---|---|---|
| ω (Jacobi relaxation) | 0.9; locally ω·a_P/(a_P + γF_out) (§4.3) | physics Eq. 5.5, critic §4.5; §4.3 |
| γ ramp | 0 → 1 over 200 sweeps (skipped when seeded) | physics §5.2, critic §4.4 |
| max sweeps | 3000 | critic §4.5 |
| check interval / window | 50 / 100 sweeps | physics §5.7 |
| probe tolerance | 10⁻³ per 100 sweeps | physics §5.7, critic §4.5 |
| residual tolerance | 10⁻⁴ (normalised L1) | physics §5.7 |
| mass tolerance (reported) | 2 % | physics §5.7, critic §4.5 |
| min sweeps | ramp + window = 300 (seeded: 100) | derived |
| κ, Sc_t, λ, K̂_min | 0.40, 0.7, 30 m, 0.02 m | critic §4.4–§4.5, physics §4 |
| z0, d, H̄ (defaults) | 1.5 m, 7 m, 14 m | critic §4.5 (ZG3D morphometry §1.10) |
| z0r, z_b (neutral û* default) | 0.3 m, 80 m | physics §6.2 |
| h_eff | from turb (`mixingHeight`, floor 100 m); default ∞ | critic §4.4 |
| solid mask threshold | byte ≥ 250 | voxel.js / WindField convention (porous ≤ 249) |
| sponge (no sources) | last 100 m | physics §5.3 |
| probes | 32 (18 receptor band + 14 spread) | physics §5.9 |
| a_P floor | 10⁻⁹ | physics §5.2 |
| adaptive sweeps/frame | ×1.1 above 26 fps, ×0.9 below 18 fps; start 8 / 1, cap 64 / 8 (GPU / software) | reference `Aero.tick` |

---

## 12. Limitations

1. **Frozen, neutral mean flow.** No resolved unsteadiness, no buoyancy. Stability acts only through K̂ and the lid
   (physics §4.6). All turbulence is modelled by K-theory. Sc_t = 0.7 is not fitted (physics §4.4 suggests 0.3–0.5
   may suit urban arrays better).
2. **Advective form.** Mass is conserved only as well as the time-averaged LBM flow is divergence-free. Φ_out/Φ_src
   and ε_div are reported with every field; a mismatch shows up there.
3. **Superposition with TVD is approximate** (≈ 0.4 % in T6), because the limiter is nonlinear. Exact superposition
   would need a linear (non-TVD) second-order scheme, which is not bounded.
4. **Resolution.** Streets of 20–60 m span 4–12 cells at 5 m, and the receptor at 4 m lies between the first two
   cell centres. The 3×3×2 band quantifies that uncertainty. At 10 m (software) the canyon at the station is barely
   resolved.
5. **The lid is a hard no-flux face.** Material carried toward it by ŵ is redirected by the advective form, not
   accumulated.
6. **Convergence speed.** The stability-preserving relaxation (§4.3) roughly halves the pseudo-time step where
   advection dominates. Solves take 800–2000 sweeps, which on SwiftShader means minutes on the 5 m grid.
7. **Vehicle-induced turbulence** is only in U0, not in K̂. The optional re-solve mode of physics §4.5 is not implemented.

---

## 13. Deviations from the research specification

| Spec | Implementation | Why |
|---|---|---|
| ω = 0.9 in every cell (physics §5.5.2, critic §4.5) | ω_P = ω·a_P/(a_P + γF_out) | without it the iteration does not converge at high Péclet numbers (§4.3, measured); the solution is unchanged |
| convergence when probes < 10⁻³ and mass < 2 % | probes < 10⁻³ and (residual < 10⁻⁴ or mass balance settled); the 2 % is reported | a mass balance can pass through 2 % before the field has settled, and must be allowed to settle at the flow's own divergence error |
| top face skipped in the pseudocode | open top (upwind outflow) when h_eff is above the domain | physics §5.3 table: "Top … Upwind" |
| — | sources in solid cells moved up to the first open cell | nothing lost silently |
| — | a seeded start skips the γ ramp | the ramp is for a start from zero (−19 % sweeps measured) |

---

## 14. How to re-run

```bash
# all scalar tests except the LBM-based T3/T4 (≈ 2 min on SwiftShader)
python3 tests/browser/run_selftest.py --only scalar --skip-slow
# everything including T3/T4 (needs the flow module; tens of minutes on SwiftShader)
python3 tests/browser/run_selftest.py --only scalar --timeout 3600
# one test
python3 tests/browser/run_selftest.py --only "scalar T1:"
```

The runner prints each test's measured numbers (the `info` JSON), and `dist/selftest.json` keeps them. On a machine
without system libraries for Chromium, set `Z1_BROWSER_LIBS` (see `tests/browser/harness.py`).

---

## 15. References

- Felzenszwalb, P. F., Huttenlocher, D. P. (2012). Distance transforms of sampled functions. *Theory of Computing* 8, 415–428.
- Harten, A. (1983). High resolution schemes for hyperbolic conservation laws. *J. Comput. Phys.* 49, 357–393.
- Khosla, P. K., Rubin, S. G. (1974). A diagonally dominant second-order accurate implicit scheme. *Computers & Fluids* 2, 207–209.
- Lenschow, P. et al. (2001). Some ideas about the sources of PM10. *Atmos. Environ.* 35, S23–S33.
- Patankar, S. V. (1980). *Numerical Heat Transfer and Fluid Flow*. Hemisphere.
- Roache, P. J. (1994). Perspective: a method for uniform reporting of grid refinement studies. *J. Fluids Eng.* 116, 405–413.
- Snyder, W. H. (1981). *Guideline for fluid modeling of atmospheric diffusion*. EPA-600/8-81-009.
- Sweby, P. K. (1984). High resolution schemes using flux limiters for hyperbolic conservation laws. *SIAM J. Numer. Anal.* 21, 995–1011.
- van Leer, B. (1974). Towards the ultimate conservative difference scheme II. *J. Comput. Phys.* 14, 361–370.
- Abramowitz, M., Stegun, I. A. (1964). *Handbook of Mathematical Functions*, 7.1.26 (erf), 9.8.6/9.8.8 (K0, K1).
- Further closure and boundary-condition references: `docs/research/physics.md` §14.
