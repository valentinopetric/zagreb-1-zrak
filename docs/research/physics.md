# Physics and numerics specification: pollutant dispersion around ZAGREB-1

*Research report, 2026-09-27. Basis for `docs/physics/` of the ZAGREB-1 app (modelled on
[ivanrezic/maksimir-pod-kisom](https://github.com/ivanrezic/maksimir-pod-kisom)).*

Station: **ZAGREB-1** (ISZZ `postaja=155`, national code RH0101, EoI **HR0007A**, class *urban / traffic*),
45.800492 N, 15.974278 E (ISZZ coordinates; DHMZ lists 45.800496 N, 15.97422 E), 113 m a.s.l.
The OSM footprint of the container (`way 1409603653`) lies 22 m west of the Miramarska cesta carriageway
(4 one-way lanes) and 43 m north of Ulica grada Vukovara (dual carriageway, 3 lanes each way). A tram track runs 53 m to the south.

How to read this document:

- Equations are numbered `(section.n)`. Parameter tables give the value, range and source.
- A statement marked **[data]** was computed here from real 2025 measurements. The scripts and outputs are in
  `research/data/physics/`, see Appendix A.
- A statement marked **[verified]** was checked against the primary document saved in `research/data/physics/refs/`.
- A statement marked **[lit]** is standard literature cited from memory. It is flagged in §13 where a check against
  the primary source is still advisable before release.

---

## 0. Executive summary

### 0.1 Recommended model in one paragraph

We reuse the reference app's GPU **Lattice-Boltzmann D3Q19 + Smagorinsky** wind tunnel. It runs one flow per wind
direction, rotated so that the wind enters at x = 0, and caches the time-averaged, speed-normalised velocity field. Inflow
turbulence and stability do not exist in the LBM, so we do not advect the pollutant inside it. Instead we solve a
**steady Reynolds-averaged advection–diffusion equation** on the *same tiled 3D texture grid*. The solver is a
**conservative finite-volume scheme** that is first-order upwind implicit with a TVD (van Leer) deferred correction, iterated as
point-Jacobi, which is the same as pseudo-time stepping with a local time step. It runs on the *frozen mean flow*, with a
**K-theory closure**: $K = \max(K_{\rm MO}(z;L,h),\ \ell_m^2|\bar S|/Sc_t)$, where $K_{\rm MO}$ is Monin–Obukhov
surface-layer diffusivity for the approach flow and $\ell_m^2|\bar S|$ is mixing-length diffusivity from the resolved
mean shear around buildings, with $Sc_t = 0.7$.

The transport equation is linear in the source, so the solver computes **unit-emission response fields
$\Gamma_k(\mathbf x)$ [m⁻¹] for four source groups at once**, one per RGBA channel. It also computes four **age-of-plume
fields** $A_k$ that give the mean travel time since emission. Everything the user changes afterwards is instant arithmetic:
traffic, fleet, emission factors, heating, background, wind *speed*, NO₂ chemistry. The formula is

$$\Delta C(\mathbf x,t)=\sum_k \beta_k\,q_k(t)\,\frac{\Gamma_k(\mathbf x;\theta,s)}{U_{\rm eff}},\qquad U_{\rm eff}=\sqrt{U_{10}^2+U_0^2}$$

Only a new wind *direction* or stability group needs a new flow and scalar solve (cached, about 5–60 s). NO₂ comes from a
**finite-reaction-time NO–NO₂–O₃ scheme** (Riccati solution with conserved oxidant, primary $f_{\rm NO_2}$ and the modelled
plume age). The total concentration is **measured urban background + modelled local increment** (Lenschow et al. 2001).
Browsers without float render targets get an **OSPM-type street-canyon model / Gaussian line-source** fallback.
Calibration fits one emission multiplier $\beta$ plus the low-wind floor $U_0$ to ISZZ hourly data. The fit is scored with
Chang & Hanna (2004) statistics, Hanna & Chang (2012) urban acceptance criteria and the FAIRMODE MQI, all reported on
held-out months. Forecasts use Open-Meteo weather and CAMS background. Both APIs were verified to work from a browser
(`Access-Control-Allow-Origin: *`).

### 0.2 Key facts established from real data (2025, hourly)

| # | Finding | Consequence for the model |
|---|---|---|
| F1 | ISZZ JSON caps at **1000 records per request**, flags missing hours as **−999**, and timestamps are **epoch ms UTC marking the end of the averaging hour** (best temperature and wind match to ERA5 at a +0.5 h shift in both CET and CEST) **[data]** | Fetch in ≤40-day chunks, mask −999, and align meteorology to the hour mid-point |
| F2 | ISZZ returns `Access-Control-Allow-Origin: *` on GET. A burst of requests gets **HTTP 429** **[verified]** | The browser can call ISZZ directly, but it must serialise and cache requests |
| F3 | Annual means at Z1: NOx 71.0, NO₂ 31.7, PM10 27.0, PM2.5 18.4 µg/m³, CO 0.24 mg/m³, benzene 0.68 µg/m³ **[data]** | Magnitudes the model must reproduce |
| F4 | NOx increment over urban background (Mirogojska): 36 µg/m³ annual. It falls with wind speed and fits $\Delta C = A/\sqrt{U^2+U_0^2}$ with **$U_0 = 1.4$ m/s** (ERA5 U10, all hours; 1.1–1.7 m/s across background choices and fit methods) **[data]** | Justifies the $U_{\rm eff}$ scaling and gives a prior for $U_0$ |
| F5 | Zagreb is a low-wind city: ERA5 U10 < 1 m/s in 31 % of hours and < 2 m/s in 69 %. The station anemometer averages 1.36 m/s with almost no N/NW directions (sheltered or channelled) **[data]** | The low-wind floor, direction smoothing and calm treatment matter. Use ERA5/Open-Meteo, not the station mast, as inflow |
| F6 | The pollution rose of the increment is highest for N–E–SE and lowest for SW–W approach winds. This holds with an upwind choice of background station too **[data]** | A validation target the 3D model must reproduce |
| F7 | Emission ratios from increments, which do not depend on dispersion: ΔPM10/ΔNOx = 0.19 (winter 0.17–0.25), ΔPM2.5/ΔNOx = 0.045, ΔCO/ΔNOx ≈ 1.0, Δbenzene/ΔNOx ≈ 0.007 **[data]** | Calibrate PM/CO/benzene emission factors relative to NOx |
| F8 | NO₂ from measured NOx: finite reaction time with $f_{\rm NO_2}=0.10$ and $\tau=60$ s gives RMSE 7.8 µg/m³, r = 0.92, mean bias −2.5 %. The photostationary state gives RMSE 10.9 with a **+15 %** bias. Derwent–Middleton gives RMSE 9.2, +6 %. The oxidant regression slope is 0.08–0.10 **[data]** | Use the finite-time scheme with $f_{\rm NO_2}\approx0.10$–0.15 |
| F9 | CAMS (Open-Meteo, cams_europe) against the urban background: NO₂ is **about 2× too low** (9.4 vs 18.3 µg/m³, r = 0.56), O₃ is 30 % too high, PM10 −11 % (r = 0.47) **[data]** | CAMS background must be bias-corrected with recent ISZZ background before use |
| F10 | ZAGREB-3 (157) is a poor background: PM10 41 µg/m³, above Z1. ZAGREB-4 and Mirogojska work better **[data]** | Choose background per pollutant (§7.9) |
| F11 | ERA5 BLH is < 50 m in 29 % of hours, with median F-class BLH of 30 m **[data]** | The mixing lid needs an urban floor (§6.5) |

### 0.3 Implementation order (details in §12)

1. Data layer: ISZZ and Open-Meteo clients, caching, −999 and hour-ending handling.
2. Geometry and sources: voxel mask from LiDAR/3D buildings, road rasterisation into source textures, wall-distance field.
3. Flow: port the LBM and replace the inflow profile with the blending-height/MO profile (§6). Accumulate the mean-strain magnitude.
4. Scalar solver: first-order upwind Jacobi, then TVD deferred correction, then the age tracer. Add probes, mass balance and
   the verification tests of §5.10.
5. Precompute sweep: 16 directions for the neutral profile, and optionally 16 more for the stable one. Cache Γ and A.
6. Emissions module and scenario toggles, then chemistry, then background.
7. Calibration script (Python, ISZZ 2025, held-out scoring) that publishes a JSON used by the app.
8. Forecast mode (Open-Meteo plus bias-corrected CAMS). 9. CPU fallback.

---

## 1. What the reference implementation does

Source: `ref/src/js/wind-tunnel.js` and `ref/src/js/main.js` (read in full).

### 1.1 Grid and texture layout

- The *tunnel* is a box turned to face the wind. $\mathbf e_x$ points downwind and $\mathbf e_y$ across. The origin sits at the
  inlet's near corner on the ground, `up = 220` m upwind of the target and `down = 300` m downwind of it. It is
  `width = 560` m wide and `height = 140` m tall. With Δx = 5 m that gives $n_x\times n_y\times n_z = 104\times112\times28$.
- Each horizontal layer is one tile of a 2D float texture. Tiles are laid out in `TX = ceil(sqrt(nz))` columns:

$$\text{texOf}(i,j,k) = \big(i + (k \bmod T_X)\,n_x,\; j + \lfloor k/T_X\rfloor\, n_y\big),\qquad W=n_xT_X,\ H=n_y\lceil n_z/T_X\rceil \tag{1.1}$$

- The populations are stored as offsets from their rest weights, $f_i - w_i$, for fp32 precision. D3Q19 needs
  $\lceil 19/4\rceil = 5$ RGBA32F targets written as MRT. **One of the 20 channels is unused** (15 of 16 for D3Q15). A
  capability probe falls back to D3Q15 when the GPU cannot write 80 bytes/pixel, and to a CPU ray heuristic without
  `EXT_color_buffer_float`.

### 1.2 Collision and streaming

BGK with the second-order equilibrium ($c_s^2=1/3$):

$$f_i^{\rm eq}=w_i\rho\left[1+3\,\mathbf c_i\!\cdot\!\mathbf u+\tfrac92(\mathbf c_i\!\cdot\!\mathbf u)^2-\tfrac32\,\mathbf u^2\right]\tag{1.2}$$

Smagorinsky closure (Hou et al. 1996). The local relaxation time comes from the non-equilibrium momentum flux
$\Pi^{\rm neq}_{\alpha\beta}=\sum_i c_{i\alpha}c_{i\beta}(f_i-f_i^{\rm eq})$, with $Q=\sqrt{\Pi^{\rm neq}:\Pi^{\rm neq}}$:

$$\tau=\tfrac12\Big(\tau_0+\sqrt{\tau_0^2+18\sqrt2\,C_s^2\,Q/\rho}\Big),\qquad \tau_0=0.506,\ C_s=0.17\ (C_s^2=0.0289)\tag{1.3}$$

$$\nu=c_s^2(\tau-\tfrac12),\qquad \nu_t=c_s^2(\tau-\tau_0)=\tfrac13(\tau-\tau_0)\quad\text{(lattice units)}\tag{1.4}$$

The code writes $18\sqrt2$ as `25.456`. Safeguards: $|\mathbf u|\le0.3$, a reset to inflow equilibrium if $\rho\notin(0.3,3)$ or
NaN, and a sponge over the last 80 m where $\tau_0\to\tau_0+0.3\,s_p^2$.

### 1.3 Boundary conditions

| Boundary | Reference treatment |
|---|---|
| Inlet (x = 0) | Equilibrium at $\rho=1$ with $u_x(z)=U_L\,(\max(z,2\,{\rm m})/10\,{\rm m})^{0.22}$, $U_L=0.075$ |
| Lid (top) | Equilibrium with the inflow velocity of the top layer (a moving lid carrying the inlet wind) |
| Outlet (x = nₓ) | Equilibrium at $\rho=1$ with the last cell's own velocity, plus the 80 m sponge |
| Lateral (y) | **Periodic** |
| Ground | **Free-slip** (a population arriving from below is the mirror image of one that left sideways). No-slip is avoided so the inflow profile survives |
| Solids | Link-wise bounce-back (link bits precomputed once per run). **Porous** cells (solid fraction m < 1) blend towards bounce-back with weight 0.6 m |

### 1.4 Run control and outputs

- Each job first spins up on a 10 m grid (2Δx): 1200 warm-up plus 300 averaging steps. The code states these as
  2400 and 600 for 5 m cells, scaled by 5 m/Δx. It then continues on the 5 m grid, seeded by trilinear interpolation of
  the coarse mean flow over open cells: 900 warm-up plus 300 averaging steps.
  Samples are taken every 3 steps. The steps per frame adapt to keep about 22 fps (up to 320 coarse, 64 fine).
- Output: $\langle\mathbf u\rangle$ and $\langle|\mathbf u|\rangle$ divided by $U_L$, that is, velocity **as a fraction of
  the 10 m inlet wind**. One run per direction serves every wind speed, cached in an LRU of 12. Readback is asynchronous.
  A job queue gives priority to the view's current direction, and a sweep option runs 8 directions.

### 1.5 Lattice-to-physical conversion

With reference wind $U_{\rm ref}$ (10 m inlet), the lattice time step and viscosity map to physical units as

$$\Delta t=\frac{\Delta x\,U_L}{U_{\rm ref}},\qquad \nu_{\rm phys}=\nu_L\frac{\Delta x^2}{\Delta t}=\nu_L\,\frac{\Delta x\,U_{\rm ref}}{U_L}\tag{1.5}$$

For Δx = 5 m and $U_{\rm ref}=3$ m/s: Δt = 0.125 s, and $\nu_0=0.002$ (lattice) corresponds to 0.4 m² s⁻¹. The building
Reynolds number is therefore $Re_H=U H/\nu\approx150$ for H = 20 m, whatever the physical speed. The approach rests on
Reynolds-number independence of flow around sharp-edged obstacles (Snyder 1981, **[lit]**). That is qualitatively right,
but the resolved turbulence is weak.

### 1.6 Implications for pollutant transport

1. The product is a **mean** flow. Without resolved inflow turbulence (the inlet is steady) the fluctuations that disperse
   pollutants are largely missing, so the scalar needs an **eddy-diffusivity (K) closure**, not the LBM's
   small Smagorinsky $\nu_t$ alone ($(C_s\Delta)^2=0.72$ m² at 5 m).
2. **Periodic lateral boundaries are wrong for a scalar**: a plume leaving one side would re-enter the other. The scalar
   solver uses its own open boundaries on the same grid.
3. **No buoyancy.** Stability enters only through the inflow profile, the K field and a mixing lid (§6).
4. Streets 20–60 m wide span 4–12 cells at 5 m. Canyon vortices are resolved coarsely, so the receptor should be sampled with care (§5.9).
5. **Spare capacity**: the free MRT channel and the averaging pass can accumulate $|\bar S|$ or $\nu_t$ without new targets
   (§5.1). The reference's CPU BFS wall-distance routine (`nearness()`) can be reused for $\ell_m$.
6. The grid is rotated per wind direction, so every direction has its own voxelisation and source rasterisation. This is
   cheap on the CPU (it is already done for the obstacle mask).

---

## 2. Governing equations for the pollutant

### 2.1 Reynolds-averaged advection–diffusion

For an inert species (NOx expressed as NO₂, PM, CO, benzene) with mean concentration $C$ [g m⁻³]:

$$\frac{\partial C}{\partial t}+\nabla\!\cdot(\bar{\mathbf u}\,C)=\nabla\!\cdot\!\big(K\,\nabla C\big)+S\tag{2.1}$$

Here $\bar{\mathbf u}$ is the LBM mean velocity, $K$ the scalar eddy diffusivity (§4), and $S$ [g m⁻³ s⁻¹] the source density.
Deposition and chemical loss are neglected: residence times in a 1 km domain are minutes, while dry deposition removes
under 5 % of PM10 over 100 s at $v_d\approx1$ cm/s through a 20 m layer. NO–NO₂ partitioning is handled afterwards, because
NOx and oxidant are conserved (§8).

### 2.2 Incremental decomposition

$$C_{\rm tot}(\mathbf x,t)=C_{\rm bg}(t)+\Delta C(\mathbf x,t)\tag{2.2}$$

$C_{\rm bg}$ is the urban background, measured (ISZZ) or forecast (CAMS, bias-corrected). $\Delta C$ is the local
increment from sources inside the domain, solved with **zero increment at inflow boundaries**. This is the standard
regional + urban + street decomposition of Lenschow et al. (2001) **[lit]**. It avoids double counting as long as the
background station is not itself dominated by the domain's own sources (§7.9).

### 2.3 Linearity: source groups and unit responses

Eq. (2.1) is linear in $S$. Split the sources into groups $k$ (for example: A = main roads, B = secondary/residential roads,
C = bus/HGV corridor or tram non-exhaust, D = heating area source). Each group has a fixed spatial pattern $\sigma_k(\mathbf x)$ [m⁻²]
per unit line strength and a time-varying strength $q_k(t)$ [g m⁻¹ s⁻¹]:

$$S(\mathbf x,t)=\sum_k q_k(t)\,\sigma_k(\mathbf x)\ \Rightarrow\ \Delta C(\mathbf x,t)=\sum_k q_k(t)\,G_k(\mathbf x)\tag{2.3}$$

### 2.4 Wind-speed scaling and the low-wind floor

If the flow pattern does not depend on Reynolds number (the reference's premise) and all turbulence is mechanical
($K\propto U$), then dividing (2.1) by $U_{\rm ref}$ shows that $G_k\propto1/U_{\rm ref}$. We therefore solve once at
$U_{\rm ref}=1$ m/s, in normalised velocity $\hat{\mathbf u}=\bar{\mathbf u}/U_{\rm ref}$ (exactly the field the reference stores)
and normalised diffusivity $\hat K=K/U_{\rm ref}$ [m]. The equation solved is

$$\nabla\!\cdot(\hat{\mathbf u}\,\Gamma_k)-\nabla\!\cdot(\hat K\nabla\Gamma_k)=\sigma_k(\mathbf x)\qquad[\Gamma_k]={\rm m^{-1}}\tag{2.4}$$

$$\Delta C=\sum_k q_k\,\frac{\Gamma_k}{U_{\rm eff}},\qquad U_{\rm eff}=\sqrt{U_{\rm ref}^2+U_0^2}\tag{2.5}$$

$U_0$ lumps the turbulence that does not scale with the wind: **vehicle-induced turbulence** (VIT), meandering, and
thermal/heat-island turbulence at calm. This is exactly the form OSPM gives. Its street-level turbulence is
$\sigma_w=\sqrt{(\alpha u_b)^2+\sigma_{w0}^2}$ (Berkowicz 2000, **[lit]**), so $C\propto1/\sigma_w\propto1/\sqrt{U^2+U_0^2}$
with $U_0=\sigma_{w0}/(\alpha\,u_b/U)$. The ZAGREB-1 NOx increments give **$U_0=1.4$ m/s** against ERA5 U10 **[data]**.
This is the fit to all 2025 hours with Mirogojska as background; 1.1–1.7 m/s across background choices and fit methods
(`u0_fit_output.txt`). For $U_{10}<0.5$ m/s the direction is undefined. Use the climatology-weighted mean of the
direction fields (§11.3).

Sanity check with the analytical infinite line source at ground in uniform wind:
$C=\sqrt{2/\pi}\,q/(U\sigma_z)$, so $\Gamma=\sqrt{2/\pi}/\sigma_z\approx0.16$ m⁻¹ for $\sigma_z=5$ m. Take 3000 veh/h at
0.5 g km⁻¹ veh⁻¹, so $q=4.2\times10^{-4}$ g m⁻¹ s⁻¹, and U = 1.5 m/s. Then ΔC ≈ 44 µg/m³, the observed order of
magnitude (F4).

### 2.5 Dimensionless concentration for benchmarks

For comparison with wind-tunnel canyon data (for example the CODASC database, KIT), use
$c^+=C\,U_H\,H/(Q/L)=\Gamma\,H\,U_H/U_{\rm ref}$ **[lit]**.

---

## 3. Choice of the scalar transport scheme

### 3.1 Candidates

| Criterion | (a) D3Q7 LBM "online" (same time loop as the flow) | (b) Semi-Lagrangian on the frozen mean flow | (c) **Finite volume, TVD, steady (Jacobi), frozen mean flow** |
|---|---|---|---|
| Conservation | Yes (local, exact up to BCs) | **No**: interpolation leaks mass, and back-traces enter solids | **Yes** (flux form), with a mass-balance diagnostic |
| Resolved unsteady transport | **Yes** (instantaneous LBM velocity) | No | No, so a K closure is needed (see §1.6: the LBM has little resolved turbulence anyway) |
| Time step | Tied to the acoustic LBM step ($U_L=0.075$) | Unconditionally stable | Local pseudo-time, monotone for any step (Jacobi form) |
| Iterations to steady state | 2–3 flow-throughs ≈ 5 000–8 000 steps for $n_x=200$ | ~ a few hundred | ~ 500–2 000 Jacobi sweeps (§5.7) |
| Memory per source group | 7 floats, ×2 ping-pong | 1 float | **1 float** (4 groups per RGBA texel) |
| Linear superposition / 4 groups in one pass | Needs 8 extra targets | Yes | **Yes, one RGBA target** |
| Numerical diffusion | Low (2nd order) | High (trilinear) | Low (TVD), with graceful degradation to upwind |
| Stability pitfalls | $\tau_g\to\tfrac12$ at low $K$, high Péclet → needs TRT | Few | None (M-matrix, bounded) |
| BCs | Anti-bounce-back is simple | Awkward near walls | Face-based, simple |

**Recommendation: (c).** It is conservative, bounded and cheap. Four groups fit in one RGBA target, it gives steady
fields directly, and it supports linear superposition and speed scaling, which is what makes the UI toggles instant.
Keep (a) as a documented optional "puff/animation" research mode. Use (b) only for visual particles (§5.11), never for
the numbers.

### 3.2 Option (a) for completeness: D3Q7 advection–diffusion LBM

Velocities $\mathbf c_0=0$, $\pm\mathbf e_{x,y,z}$. Weights $w_0=\tfrac14$, $w_{1..6}=\tfrac18$, so $c_s^2=\tfrac14$ (in general $c_s^2=(1-w_0)/3$) (Krüger et al. 2017, **[lit]**):

$$g_i(\mathbf x+\mathbf c_i,t+1)=g_i-\frac{g_i-g_i^{\rm eq}}{\tau_g}+w_i S\Delta t,\qquad g_i^{\rm eq}=w_iC\Big(1+\frac{\mathbf c_i\!\cdot\!\mathbf u}{c_s^2}\Big)\tag{3.1}$$

$$D_L=c_s^2\big(\tau_g-\tfrac12\big)\ \Rightarrow\ \tau_g=\tfrac12+4D_L,\qquad D_L=K\frac{\Delta t}{\Delta x^2}=\hat K\,\frac{U_L}{\Delta x}\tag{3.2}$$

Example: $\hat K=0.5$ m, Δx = 5 m, $U_L=0.075$ gives $D_L=0.0075$ and $\tau_g=0.53$. Stability needs $\tau_g>\tfrac12$. In
practice keep $\tau_g\ge0.51$ and use the **two-relaxation-time** variant with magic parameter
$\Lambda=(\tau^+-\tfrac12)(\tau^--\tfrac12)=\tfrac14$ (Ginzburg 2005, **[lit]**) wherever the cell Péclet number
$|\mathbf u|/D_L\gtrsim10$. Walls: plain bounce-back gives zero flux. Dirichlet walls use anti-bounce-back
$g_{\bar i}=-g_i^\*+2w_iC_w$. Inlet: equilibrium with C = 0. Outlet: zero-gradient copy. Steady state needs about
$2n_x/U_L$ steps (≈5 300 for $n_x=200$). The mean concentration is the time average during the flow's averaging window,
which must then be *extended*: the reference's 300 averaging steps are only 0.2 flow-throughs.

### 3.3 Why not advect inside the LBM with the Smagorinsky $\nu_t$ only

$\nu_t=(C_s\Delta)^2|S|$ with $C_s\Delta=0.85$ m is **< 1 m² s⁻¹** except in strong shear layers. The steady inlet adds
no approach-flow turbulence, so plume spread would be under-predicted by up to an order of magnitude
(atmospheric $K\approx\kappa u_*z\sim5$–10 m² s⁻¹ at 50–100 m). A K closure that represents *all* turbulence is needed
whatever the scheme, which removes the main advantage of (a).

---

## 4. Eddy-diffusivity closure

### 4.1 Total diffusivity (normalised units, metres)

$$\hat K(\mathbf x)=\max\!\Big[\hat K_{\rm MO}(z),\ \frac{\ell_m^2\,|\hat S|}{Sc_t}\Big]+\hat K_{\rm veh}(\mathbf x),\qquad \hat K\ge\hat K_{\min}=0.02\ {\rm m}\tag{4.1}$$

We take the **max**, not the sum. On an undisturbed log profile $\ell_m^2|\partial_z u|=\kappa u_*z$ reproduces
$K_{\rm MO}$ (the same eddies), while near buildings the resolved mean shear dominates. Summing would double count.

### 4.2 Approach-flow (Monin–Obukhov) part

$$\hat K_{\rm MO}(z)=\frac{\kappa\,\hat u_*\,\hat z}{\phi_h(\hat z/L)}\Big(1-\frac{z}{h_{\rm eff}}\Big)^2,\qquad \hat z=\max(z,\bar H)-d,\qquad z<h_{\rm eff}\tag{4.2}$$

$$\phi_h(\zeta)=\begin{cases}(1-16\zeta)^{-1/2}&\zeta<0\\ 1+5\zeta & 0\le\zeta\le1\ \text{(cap at }\zeta=1)\end{cases}\tag{4.3}$$

Here $\kappa=0.40$, $\hat u_*=u_*/U_{\rm ref}$ from §6.2, $\bar H$ is the mean building height and $d$ the displacement height
(§6.1). $L$ is from Golder (1972) per stability class (§6.4) and $h_{\rm eff}$ is the mixing height (§6.5). $\phi_h$ follows
Businger et al. (1971) and Dyer (1974) **[lit]**. The $(1-z/h)^2$ shape is the O'Brien / Troen & Mahrt (1986) profile
**[lit]**. $\hat K_{\rm MO}$ is held **constant below roof level** (at its value at $z=\bar H$). Mixing in the canopy is done by
roof-level shear-layer eddies of size about $\bar H$, as in OSPM, and the resolved canyon recirculation is added by the
mean flow itself.

### 4.3 Mixing-length part (resolved mean shear around buildings)

$$\ell_m=\Big(\frac{1}{\kappa d_w}+\frac1\lambda\Big)^{-1},\quad\lambda=30\ {\rm m};\qquad |\hat S|=\sqrt{2\hat S_{ij}\hat S_{ij}},\quad \hat S_{ij}=\tfrac12(\partial_j\hat u_i+\partial_i\hat u_j)\tag{4.4}$$

$d_w$ is the distance to the nearest solid face or the ground, from a BFS/chamfer transform of the voxel mask. The
reference already implements one for the rain mask. $\lambda$ is Blackadar's asymptotic length (Blackadar 1962,
**[lit]**); 30 m is on the low side of the usual 30–150 m for a shallow urban domain. Gradients use central differences
of the mean field, one-sided next to solids.

### 4.4 Turbulent Schmidt number

$Sc_t=0.7$ by default, with an "advanced" slider from 0.3 to 1.0. The optimum spans 0.2–1.3 across flows, and values of
0.3–0.5 often improve RANS predictions in urban arrays because RANS under-estimates turbulent mixing (Tominaga &
Stathopoulos 2007, **[lit]**). $Sc_t$ is a legitimate secondary calibration parameter. It is *not* fitted by default,
to avoid over-fitting a single station.

### 4.5 Vehicle-induced turbulence

The default is the **$U_0$ route** (Eq. 2.5), which keeps the fields speed-invariant. There is an optional "re-solve"
mode per wind-speed bin. In it, road cells in the lowest layer get

$$\hat K_{\rm veh}=\frac{\sigma_{w0}\,\ell_v}{U_{\rm ref}},\qquad \sigma_{w0}=b\sqrt{\frac{N\,V\,S_v}{W}},\quad b\approx0.3,\ \ell_v\approx2{-}3\ {\rm m}\tag{4.5}$$

with $N$ [veh s⁻¹], $V$ [m s⁻¹], $S_v$ [m²] the vehicle's horizontal area and $W$ [m] the street width (OSPM; Berkowicz 2000, Di
Sabatino et al. 2003, **[lit]**; constants to be checked, see §13).

### 4.6 How stability enters

| Mechanism | Unstable (A–C) | Neutral (D) | Stable (E–F) |
|---|---|---|---|
| Inflow profile $\hat u(z)$ (LBM inlet, §6.3) | Flatter ($\psi_m>0$) | Log | Steeper; optional separate LBM run |
| $\hat u_*$ | Larger | Reference | Smaller |
| $\hat K_{\rm MO}$ via $\phi_h$ | Enhanced $(1-16\zeta)^{-1/2}$ | $\kappa u_*\hat z$ | Reduced $1/(1+5\zeta)$ |
| Mixing lid $h_{\rm eff}$ (§6.5) | High; outside the domain | Moderate | Low, **inside the domain**: no-flux lid |
| LBM dynamics (buoyancy) | Not modelled | – | Not modelled; limitation |

Version 1 runs the LBM with the neutral profile only (16 directions) and applies stability through $\hat u_*$, $\phi_h$,
$h_{\rm eff}$. Version 2 adds 16 stable-profile flow runs.

---

## 5. Finite-volume discretisation and GPU implementation

### 5.1 Data layout (same tiled atlas as the reference, Eq. 1.1)

| Texture | Format | Content | Written by |
|---|---|---|---|
| `uVK` | RGBA32F (RGBA16F acceptable) | $\hat u,\hat v,\hat w$ (cell-centred mean velocity / $U_{\rm ref}$) and $\hat K$ [m]. **$\hat K<0$ flags a solid cell** | K-prep pass (§5.5.1) |
| `uSrc` | RGBA16F | $\sigma_kV$ [m] per group $k$ = length of each group's roads inside the cell (unit line strength, volume-integrated) | CPU rasteriser |
| `uG` ×2 | RGBA32F ping-pong | $\Gamma_{k}$ [m⁻¹], 4 groups | Scalar pass |
| `uA` ×2 | RGBA32F ping-pong | Plume-age tracers $A_k$ [–], 4 groups (§5.6) | Scalar pass (MRT output 2) |
| `uDw` | R16F | Wall distance $d_w$ [m] | CPU BFS |
| `uAvgS` | R32F (accumulated) | $\langle|\hat S|\rangle$ if taken from the LBM averaging pass (alternative to 5.5.1) | LBM `acc` pass (2nd MRT output) |

**Memory per cell:** the scalar solver adds about 88 B (5 × 16 B + 8 B), on top of the LBM's 2 × 80 B + 32 B.

| Grid (Δx) | Cells | LBM (D3Q19) | Scalar | Notes |
|---|---|---|---|---|
| 104×112×28 (5 m, reference) | 0.33 M | 64 MB | 29 MB | Reference size |
| 120×120×32 (5 m; 600×600×160 m) | 0.46 M | 88 MB | 41 MB | **Recommended default fine grid** |
| 160×160×32 (5 m; 800×800×160 m) | 0.82 M | 157 MB | 72 MB | Desktop "high" |
| 200×200×40 (5 m; 1000×1000×200 m) | 1.60 M | 307 MB | 141 MB | Only on discrete GPUs; atlas 1400×1200 |
| 100×100×20 (10 m; 1 km²) | 0.20 M | 38 MB | 18 MB | Spin-up, mobile, software renderers |

### 5.2 Discrete equations

Cell P with volume $V=\Delta x^3$ and faces $f\in\{\pm x,\pm y,\pm z\}$ of area $A=\Delta x^2$ and outward normal $\mathbf n_f$.
Neighbour N across $f$. Normalised face flux and conductance:

$$\hat F_f=A\,\mathbf n_f\!\cdot\!\tfrac12(\hat{\mathbf u}_P+\hat{\mathbf u}_N),\qquad \hat D_f=\frac{A}{\Delta x}\,\frac{2\hat K_P\hat K_N}{\hat K_P+\hat K_N}\tag{5.1}$$

Both are zero on a face shared with a solid cell (no-flux walls, §5.3). Discretising the steady Eq. (2.4) in *advective
(continuity-corrected) form* with an implicit first-order-upwind part:

$$a_P\,\Gamma_P=\sum_f a_f\,\Gamma_{N_f}+\sigma_PV+b_P^{\rm DC},\qquad a_f=\hat D_f+\max(-\hat F_f,0),\qquad a_P=\sum_f a_f\tag{5.2}$$

Using $a_P=\sum a_f$ rather than the conservative $a_P=\sum a_f+\sum_f\hat F_f$ removes spurious sources caused by the
small discrete divergence of the time-averaged, weakly compressible LBM field (Patankar 1980, **[lit]**). The two are
identical when $\sum_f\hat F_f=0$. The system is then an M-matrix: bounded, with no overshoots. The divergence error
$\varepsilon_{\rm div}=\sum_P|\sum_f\hat F_f|/\sum_P\sum_f|\hat F_f|$ is reported as a flow-quality metric.

**Second-order TVD deferred correction** (Khosla & Rubin 1974; Sweby 1984; van Leer 1974, **[lit]**):

$$b_P^{\rm DC}=-\gamma\sum_f\hat F_f\big(\Gamma_f^{\rm TVD}-\Gamma_f^{\rm UD}\big),\qquad \Gamma_f^{\rm TVD}=\Gamma_U+\tfrac12\psi(r_f)(\Gamma_D-\Gamma_U),\qquad r_f=\frac{\Gamma_U-\Gamma_{UU}}{\Gamma_D-\Gamma_U}\tag{5.3}$$

$$\psi(r)=\frac{r+|r|}{1+|r|}\ \ \text{(van Leer)}\tag{5.4}$$

U, D and UU are the upwind, downwind and far-upwind cells of face $f$; $\Gamma_f^{\rm UD}=\Gamma_U$. If UU is solid or outside,
$r=0$ and the face falls back to upwind. The blend $\gamma$ ramps from 0 to 1 over the first 200 sweeps. First-order
upwind alone adds numerical diffusion $K_{\rm num}\approx|u|\Delta x/2$, about 4 m² s⁻¹ for 1.5 m/s at 5 m, comparable to
the physical $K$. The TVD correction is therefore mandatory for quantitative output.

**Point-Jacobi iteration with relaxation** (= pseudo-time stepping with a local step $\Delta\tau_P=V/a_P$):

$$\Gamma_P^{n+1}=(1-\omega)\Gamma_P^n+\omega\,\frac{\sum_fa_f\Gamma_{N_f}^n+\sigma_PV+b_P^{{\rm DC},n}}{a_P},\qquad\omega=0.8{-}1.0\tag{5.5}$$

Cells with $a_P<10^{-9}$ (fully enclosed, stagnant) are set to 0.

### 5.3 Boundary conditions for the scalar

| Boundary | Advective flux | Diffusive flux | Rationale |
|---|---|---|---|
| Inflow face (x = 0) | $\hat F<0$: brings Γ = 0 (increment) | 0 (zero gradient) | Background is added separately (Eq. 2.2) |
| Outflow (x = nₓ) | $\hat F>0$: carries $\Gamma_P$ out (upwind) | 0 | Open. No sources in the last 100 m (LBM sponge) |
| Lateral (y = 0, y = n_y) | **Open** (upwind; inflow brings 0) | 0 | **Not periodic**, unlike the flow |
| Top (z = n_z) if $h_{\rm eff}\ge H_{\rm top}$ | Upwind (mean $\hat w\approx0$) | 0 | The plume exits via the outlet; $\sigma_z(500\,{\rm m})\approx40$–70 m ≪ 160–200 m |
| Mixing lid if $h_{\rm eff}<H_{\rm top}$ | 0 | 0 | Cells with $z>h_{\rm eff}$ are treated as blocked (uniform `uLidK`) |
| Ground | 0 | 0 | No deposition (§2.1) |
| Solid cells ($\hat K<0$) | 0 | 0 | No-flux walls |
| Porous cells (0 < m < 1) | Fluid, with the LBM's reduced velocity | Fluid | Consistent with the reference's porous treatment |

### 5.4 Stability constraints (for an optional time-accurate mode)

The steady Jacobi form (5.5) is unconditionally monotone. A **time-accurate** explicit variant (for animating how a
plume develops after a toggle) needs, per cell, with physical $\Delta t$:

$$\text{CFL}=\Delta t\sum_d\frac{|u_d|}{\Delta x}\le C_{\max}\ (0.5\text{ for TVD with SSP-RK2}),\qquad \text{Fo}=\frac{K\Delta t}{\Delta x^2}\le\frac16\ \text{(3D FTCS)}\tag{5.6}$$

$$\text{positivity (FOU + FTCS, forward Euler):}\quad \Delta t\Big[\sum_d\frac{|u_d|}{\Delta x}+\frac{6K}{\Delta x^2}\Big]\le1\tag{5.7}$$

The cell Péclet number $Pe_\Delta=|u|\Delta x/K$ is 5–50 here, so central differencing of advection ($Pe_\Delta\le2$) is
excluded. Example at 5 m: $U_{\rm top}=2.5U_{\rm ref}$ with $U_{\rm ref}=3$ m/s gives $\Delta t\le0.33$ s (CFL). $K_{\max}=20$ m² s⁻¹ gives
$\Delta t\le0.21$ s (Fo), so the time-accurate mode is diffusion-limited in the shear layers. Use local steps for steady runs.

### 5.5 GLSL-level pseudocode

#### 5.5.1 K-prep pass (once per flow field and stability class)

```glsl
#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
const int NX=__NX__, NY=__NY__, NZ=__NZ__, TX=__TX__;   // injected like the reference's lbmSources()
uniform sampler2D uAvg;      // accumulated <u> (xyz) from the LBM acc pass
uniform float uAvgScale;     // 1/(samples*U_LATTICE): converts to u/U_ref
uniform sampler2D uMask;     // solid fraction (R8), >0.99 = solid
uniform sampler2D uDw;       // wall distance [m]
uniform float uDX, uKappa, uLambda, uSct, uKmin;
uniform float uKmo[NZ];      // K_MO(z_k) [m] per layer for this class (CPU: Eq. 4.2)
layout(location=0) out vec4 oVK;
ivec3 cellOf(ivec2 t){ int a=t.x/NX, b=t.y/NY; return ivec3(t.x-a*NX, t.y-b*NY, b*TX+a); }
ivec2 texOf(ivec3 c){ return ivec2(c.x+(c.z%TX)*NX, c.y+(c.z/TX)*NY); }
bool solid(ivec3 c){ return texelFetch(uMask, texOf(c), 0).r > 0.99; }
vec3 U(ivec3 c){ return texelFetch(uAvg, texOf(c), 0).xyz * uAvgScale; }
// one-sided difference next to solids / domain edges, central otherwise
vec3 dU(ivec3 p, ivec3 e){
  ivec3 hi=p+e, lo=p-e;
  bool okH = all(lessThan(hi, ivec3(NX,NY,NZ))) && !solid(hi);
  bool okL = all(greaterThanEqual(lo, ivec3(0))) && !solid(lo);
  if (okH && okL) return (U(hi)-U(lo))/(2.0*uDX);
  if (okH) return (U(hi)-U(p))/uDX;
  if (okL) return (U(p)-U(lo))/uDX;
  return vec3(0.0);
}
void main(){
  ivec3 p = cellOf(ivec2(gl_FragCoord.xy));
  if (p.z>=NZ || solid(p)) { oVK = vec4(0.0,0.0,0.0,-1.0); return; }
  vec3 gx=dU(p,ivec3(1,0,0)), gy=dU(p,ivec3(0,1,0)), gz=dU(p,ivec3(0,0,1)); // columns: d/dx, d/dy, d/dz of (u,v,w)
  mat3 G = mat3(gx, gy, gz);                    // G[j][i] = d u_i / d x_j
  mat3 S = 0.5*(G + transpose(G));
  float S2 = 0.0; for(int i=0;i<3;i++) for(int j=0;j<3;j++) S2 += S[i][j]*S[i][j];
  float Smag = sqrt(2.0*S2);                    // |S_hat| [1/m]
  float dw = texelFetch(uDw, texOf(p), 0).r;
  float lm = 1.0/(1.0/(uKappa*max(dw,0.5*uDX)) + 1.0/uLambda);
  float K = max(uKmo[p.z], lm*lm*Smag/uSct);
  oVK = vec4(U(p), max(K, uKmin));
}
```

#### 5.5.2 Scalar Jacobi + TVD deferred-correction pass (4 groups, plus 4 age tracers via MRT)

```glsl
uniform sampler2D uVK, uSrc, uG, uA;
uniform float uDX, uOmega, uGamma;   // relaxation, deferred-correction blend (0 -> 1)
uniform int uLidK;                   // first blocked layer (NZ if the lid is above the domain)
layout(location=0) out vec4 oG;      // Gamma_k   [1/m]
layout(location=1) out vec4 oA;      // A_k       [-]  (age tracers, Section 5.6)
const ivec3 E[6] = ivec3[6](ivec3(1,0,0),ivec3(-1,0,0),ivec3(0,1,0),ivec3(0,-1,0),ivec3(0,0,1),ivec3(0,0,-1));
bool inDom(ivec3 c){ return all(greaterThanEqual(c,ivec3(0))) && c.x<NX && c.y<NY && c.z<uLidK; }
vec4 VK(ivec3 c){ return texelFetch(uVK, texOf(c), 0); }
bool fluid(ivec3 c){ return inDom(c) && VK(c).w >= 0.0; }
vec4 Gf(ivec3 c){ return fluid(c) ? texelFetch(uG, texOf(c), 0) : vec4(0.0); }
vec4 Af(ivec3 c){ return fluid(c) ? texelFetch(uA, texOf(c), 0) : vec4(0.0); }
vec4 psi(vec4 r){ return (r+abs(r))/(1.0+abs(r)); }                 // van Leer, component-wise
vec4 tvdFace(vec4 gU, vec4 gD, vec4 gUU, bool uuOK){                 // Gamma_f(TVD) - Gamma_f(UD)
  if (!uuOK) return vec4(0.0);
  vec4 den = gD-gU, r = (gU-gUU)*den/(den*den+1e-30);                // safe (gU-gUU)/(gD-gU)
  return 0.5*psi(r)*den;
}
void main(){
  ivec3 p = cellOf(ivec2(gl_FragCoord.xy));
  if (!fluid(p)) { oG=vec4(0.0); oA=vec4(0.0); return; }
  vec4 vp=VK(p), gP=Gf(p), aPv=Af(p);
  float Af2 = uDX*uDX;
  float aP = 0.0; vec4 sG=vec4(0.0), sA=vec4(0.0), dcG=vec4(0.0), dcA=vec4(0.0);
  for (int f=0; f<6; f++){
    ivec3 n = p + E[f];
    if (n.z < 0 || n.z >= uLidK) continue;                           // ground, lid: no flux
    bool inside = all(greaterThanEqual(n,ivec3(0))) && n.x<NX && n.y<NY;
    vec4 vn = inside ? VK(n) : vp;                                   // open boundary: own velocity
    if (inside && vn.w < 0.0) continue;                              // wall: no advective or diffusive flux
    float F = dot(0.5*(vp.xyz+vn.xyz), vec3(E[f]))*Af2;              // outward normalised flux [m^2]
    float D = inside ? Af2/uDX * 2.0*vp.w*vn.w/(vp.w+vn.w) : 0.0;    // zero-gradient at open boundaries
    float a = D + max(-F, 0.0);
    vec4 gN = inside ? Gf(n) : vec4(0.0), aN = inside ? Af(n) : vec4(0.0);   // inflow brings 0
    sG += a*gN; sA += a*aN; aP += a;
    if (uGamma > 0.0 && inside){                                     // deferred correction (5.3)
      bool up = F > 0.0;                                             // upwind cell is P if flux leaves P
      ivec3 uu = up ? p - E[f] : n + E[f];
      bool uuOK = fluid(uu);
      dcG -= F * (up ? tvdFace(gP, gN, Gf(uu), uuOK) : tvdFace(gN, gP, Gf(uu), uuOK));
      dcA -= F * (up ? tvdFace(aPv, aN, Af(uu), uuOK) : tvdFace(aN, aPv, Af(uu), uuOK));
    }
  }
  if (aP < 1e-9) { oG=vec4(0.0); oA=vec4(0.0); return; }
  vec4 src = texelFetch(uSrc, texOf(p), 0);                          // sigma_k * V  [m]
  vec4 gNew = (sG + src + uGamma*dcG)/aP;
  vec4 aNew = (sA + gP*(uDX*uDX*uDX) + uGamma*dcA)/aP;               // age source = Gamma * V
  oG = max(mix(gP, gNew, uOmega), 0.0);
  oA = max(mix(aPv, aNew, uOmega), 0.0);
}
```

#### 5.5.3 Driver (JavaScript, same pattern as `WindTunnel.advance`)

```js
// after the LBM job for (direction, stabilityGroup) has been collected:
kprep(avgTexture, classParams)                    // -> uVK
clear(G[0]); clear(A[0]); cur = 0
for (it = 0; it < maxIt && !converged; ) {        // spread over frames: n sweeps per frame, adapted to 22 fps
  for (s = 0; s < nPerFrame; s++, it++) {
    uniforms.uGamma = Math.min(1, it / 200)
    pass(scalarStep, {in: [G[cur], A[cur]], out: [G[1-cur], A[1-cur]]}); cur = 1 - cur
  }
  if (it % 50 === 0) probes = await readProbesAsync(G[cur], A[cur])   // N x 1 target, trilinear, fluid-weighted
  converged = relChange(probes, prevProbes) < 1e-3 && massBalanceOK()  // Section 5.7
}
```

A 10 m spin-up grid solve, prolongated trilinearly as the initial guess, roughly halves the fine-grid sweeps. This
mirrors the reference's coarse-to-fine flow seeding.

### 5.6 Plume-age tracer (for NO₂ chemistry)

The mean time since emission of the material at $\mathbf x$ is $\tau=\overline{C\tau}/C$ (the "age of air" technique).
$C\tau$ obeys Eq. (2.1) with source $C$. In normalised form, per group,

$$\nabla\!\cdot(\hat{\mathbf u}A_k)-\nabla\!\cdot(\hat K\nabla A_k)=\Gamma_k,\qquad \tau_{\rm mix}=\frac{\sum_k q_kA_k}{U_{\rm eff}\sum_kq_k\Gamma_k}\ [{\rm s}]\tag{5.8}$$

This stays linear in the group strengths $q_k$, so scenario toggles remain instant. It uses the same coefficients as
(5.2) and the second MRT output.

### 5.7 Convergence and steady-state detection

Run the checks every 50 sweeps (asynchronous readback, like the reference's `collect()`):

1. Relative change of Γ at the receptor probes over the last 100 sweeps < 10⁻³.
2. Global residual $\|a_P\Gamma_P-\sum a_f\Gamma_N-\sigma V-b^{\rm DC}\|_1/\|\sigma V\|_1<10^{-4}$. Compute it with a
   log₂ reduction pass: 4×4 block sums rendered into ever smaller targets, then a 1×1 read.
3. Mass balance: $\big|\Phi_{\rm out}-\Phi_{\rm src}\big|/\Phi_{\rm src}<2\,\%$, where
   $\Phi_{\rm src}=\sum_P\sigma_PV$ and $\Phi_{\rm out}=\sum_{\rm open\ faces}\hat F_f^+\Gamma_P$. A persistent mismatch
   equals the flow's $\varepsilon_{\rm div}$ and should be reported, not hidden.

The expected cost is 500–2 000 sweeps. Advection needs about $n_x/{\rm CFL}_{\rm eff}$ sweeps; canyon recirculation
zones are diffusion-dominated and converge in about $(W/\Delta x)^2$ sweeps. Each sweep reads about 25 texels per cell,
roughly 0.2–0.4 GB of texture traffic at 0.5–0.8 M cells, so 2–5 ms on a discrete GPU and 10–30 ms on an integrated one.
Total **2–10 s (desktop) / 10–40 s (laptop iGPU)** per (direction, class), cached afterwards.

### 5.8 Units and conversions

| Quantity | Formula | Units |
|---|---|---|
| Line source strength | $q=\dfrac{N\,[{\rm veh\,h^{-1}}]\cdot EF\,[{\rm g\,veh^{-1}km^{-1}}]}{3.6\times10^6}$ | g m⁻¹ s⁻¹ |
| Cell source (unit strength) | $\sigma_PV=\sum_{\rm segments} L_{\rm seg\cap P}$ | m |
| Increment | $\Delta C=10^6\sum_k q_k\Gamma_k/U_{\rm eff}$ | µg m⁻³ |
| Plume age | $\tau=\sum q_kA_k/(U_{\rm eff}\sum q_k\Gamma_k)$ | s |
| LBM → physical | Eq. (1.5); normalised velocity $\hat u=\langle u\rangle_L/U_L$ | – |
| ppb ↔ µg m⁻³ (EU reporting: 293.15 K, 101.325 kPa) | NO₂ 1.9125, O₃ 1.9956, NO 1.2473 µg m⁻³ per ppb | – |

### 5.9 Receptor sampling at the station

- The EU sampling-inlet rule is 1.5–4 m above ground (Directive 2008/50/EC, Annex III, **[lit]**). Use $z_r=3.5$ m until
  DHMZ confirms the actual height. It lies between the cell centres at 2.5 m and 7.5 m (Δx = 5 m), so use trilinear
  interpolation weighted over fluid cells only (as `WindField.sample`).
- The container (OSM `building=service`, way 1409603653) is **excluded** from the voxel mask. It is a 3 m box,
  sub-grid.
- Report a **representativeness band**: the min–max of Γ over the 3×3×2 cells around the receptor, shown as the model
  uncertainty from grid resolution.
- Also sample the model wind at the anemometer mast (height to be confirmed, probably about 10 m). Compare it with the
  measured station wind, which is sheltered and channelled (F5), as an independent check of the flow.

### 5.10 Verification tests (automated, before any calibration)

| Test | Set-up | Pass criterion |
|---|---|---|
| T1 analytic | Flat ground, uniform $\hat u=1$, constant $\hat K$, crosswind line source at the ground. Exact: $\Gamma(x,z)=\dfrac{1}{\sqrt{\pi \hat Kx}}\exp\!\Big(-\dfrac{z^2}{4\hat Kx}\Big)$ | Error < 5 % for $x>10\Delta x$ (TVD). Document the upwind error |
| T2 mass | T1 and full geometry | $\Phi_{\rm out}/\Phi_{\rm src}=1\pm1\,\%$ (T1), ±2 % (city) |
| T3 grid | 10 m vs 5 m, same direction | Report the Richardson estimate of Γ at the receptor |
| T4 canyon | Idealised canyon W/H = 1, H = 30 m (6 cells), perpendicular wind | Leeward/windward wall $c^+$ ratio > 1 (qualitative match to CODASC) |
| T5 symmetry | Symmetric building, wind along its axis | Symmetric Γ to 10⁻⁴ |
| T6 linearity | $\Gamma(2\sigma)=2\Gamma(\sigma)$; group sums | Exact to 10⁻⁵ |

### 5.11 Visual particles (display only)

For "see how the pollution behaves", release tracer particles along roads at a rate ∝ $q_k$. Move them with the mean
flow plus a random-displacement step (first-order Lagrangian model with drift correction):
$d\mathbf x=(\bar{\mathbf u}+\nabla K)\,dt+\sqrt{2K\,dt}\,\boldsymbol\xi$ (Wilson & Sawford 1996, **[lit]**). The reference's
wind streaks can be adapted. Colour them by local ΔC from the Eulerian field. Particles are **never** used for numbers.

---

## 6. Inflow wind profile, stability and mixing height

### 6.1 Urban surface parameters

The morphometric method of Macdonald, Griffiths & Hall (1998) **[lit]**, from the plan-area fraction $\lambda_p$, the
per-direction frontal-area index $\lambda_f$ and the mean height $\bar H$:

$$\frac d{\bar H}=1+A^{-\lambda_p}(\lambda_p-1),\qquad \frac{z_0}{\bar H}=\Big(1-\frac d{\bar H}\Big)\exp\!\Big[-\Big(\frac{\beta C_D}{2\kappa^2}\Big(1-\frac d{\bar H}\Big)\lambda_f\Big)^{-1/2}\Big]\tag{6.1}$$

with $A=4.43$, $\beta=1.0$ (staggered arrays) and $C_D=1.2$. The rule of thumb is $d\approx0.7\bar H$, $z_0\approx0.1\bar H$
(Grimmond & Oke 1999, **[lit]**).

A first estimate from OSM within 500 m **[data]** gives 432 buildings, $\lambda_p=0.195$, $\bar H\approx14$ m (area-weighted,
maximum 55 m), $\lambda_f=0.13$–0.16, $z_0=1.3$–1.6 m and $d=5.6$ m (Macdonald) or 9.9 m (rule of thumb). Of those
heights, **80 % are defaults (10 m)**. Recompute per 22.5° sector over the 500 m upwind fetch from the LiDAR/3D-city model
before use. **Default until then: $z_0=1.4$ m, $d=8$ m, $\bar H=14$ m.**

### 6.2 From the reference wind to urban friction velocity (blending-height matching)

The reference wind $U_{\rm ref}$ is the 10 m wind of the meteorological source (Open-Meteo/ERA5 grid, representative
roughness $z_{0r}$). It is transferred to the urban surface by matching log profiles at a blending height
$z_b\approx60$–100 m, above which the local roughness no longer matters (Wieringa 1986, **[lit]**):

$$\hat u_{*r}=\frac{\kappa}{\ln(10/z_{0r})-\psi_m(10/L)+\psi_m(z_{0r}/L)},\qquad \hat u(z_b)=\frac{\hat u_{*r}}\kappa\Big[\ln\frac{z_b}{z_{0r}}-\psi_m\Big(\frac{z_b}L\Big)+\psi_m\Big(\frac{z_{0r}}L\Big)\Big]\tag{6.2}$$

$$\hat u_{*}=\frac{\kappa\,\hat u(z_b)}{\ln\frac{z_b-d}{z_0}-\psi_m\big(\frac{z_b-d}L\big)+\psi_m\big(\frac{z_0}L\big)}\tag{6.3}$$

Paulson (1970) / Businger–Dyer stability functions **[lit]**:

$$\psi_m(\zeta)=\begin{cases}2\ln\frac{1+x}2+\ln\frac{1+x^2}2-2\arctan x+\frac\pi2,\ x=(1-16\zeta)^{1/4}&\zeta<0\\ -5\zeta\ (\zeta\le1,\ \text{capped})&\zeta\ge0\end{cases}\tag{6.4}$$

Example (neutral): $z_{0r}=0.3$ m, $z_b=80$ m, $d=8$ m, $z_0=1.4$ m give $\hat u_*=0.162$, so $u_*=0.49$ m/s at
$U_{\rm ref}=3$ m/s. $z_{0r}$ is not published per grid box. Default 0.3 m and treat it as a sensitivity. A cross-check
is the Eurocode EN 1991-1-4 terrain factor $k_r=0.19\,(z_0/0.05)^{0.07}$ **[lit]**.

### 6.3 Profile imposed at the LBM inlet (replaces `inflow(z)` of the reference)

$$\hat u(z)=\begin{cases}\dfrac{\hat u_*}{\kappa}\Big[\ln\dfrac{z-d}{z_0}-\psi_m\Big(\dfrac{z-d}L\Big)+\psi_m\Big(\dfrac{z_0}L\Big)\Big]&z\ge\bar H\\[6pt] \hat u(\bar H)\,\exp\!\big[a\,(z/\bar H-1)\big],\ a\approx1\text{–}3&z<\bar H\ \text{(canopy; Macdonald 2000, [lit])}\end{cases}\tag{6.5}$$

Implement it as a per-layer uniform array `uInflow[NZ]` (lattice velocity $U_L\,\hat u(z_k)$) used by `inflow()` for
the inlet and the lid. Check the Mach number: at 190 m $\hat u\approx2.0$, so $u_L=0.15$ and Ma = 0.26 < 0.3. The
**simple mode** keeps the reference's power law $\hat u=(z/10)^p$ with the Irwin (1979) urban exponents $p$ = 0.15 (A, B),
0.20 (C), 0.25 (D), 0.30 (E, F) **[lit]**.

### 6.4 Stability class from routinely available data

Inputs (Open-Meteo, hourly): 10 m wind $U$, global radiation $G$ (`shortwave_radiation`) and total cloud cover $N$.
**Daytime ($G>0$): US EPA SRDT method, EPA-454/R-99-005 Table 6-7 [verified].** Night: Turner (1964) net-radiation index
(EPA Tables 6-4/6-6 **[verified]**), using cloud cover because Open-Meteo gives no low-level ΔT.

Daytime, SRDT (solar radiation $G$ in W/m²):

| $U$ (m/s) | $G\ge925$ | 675–925 | 175–675 | < 175 |
|---|---|---|---|---|
| < 2 | A | A | B | D |
| 2–3 | A | B | C | D |
| 3–5 | B | B | C | D |
| 5–6 | C | C | D | D |
| ≥ 6 | C | D | D | D |

Night, Turner net-radiation index (G merged into F, as EPA does for regulatory use):

| $U$ (m/s) | < 1.9 | 1.9–3.4 | 3.4–5.5 | ≥ 5.5 |
|---|---|---|---|---|
| Total cloud > 4/10 (index −1) | F | E | D | D |
| Total cloud ≤ 4/10 (index −2) | F | F | E | D |

Overcast 10/10 with a low ceiling gives D, day or night. Obukhov length from class and roughness (Golder 1972, **[lit]**):

$$\frac1L=a+b\log_{10}z_0',\qquad z_0'=\min(z_0,0.5\ {\rm m})\ \ \text{(range of Golder's nomogram)}\tag{6.6}$$

| Class | A | B | C | D | E | F |
|---|---|---|---|---|---|---|
| a | −0.096 | −0.037 | −0.002 | 0 | 0.004 | 0.035 |
| b | 0.029 | 0.029 | 0.018 | 0 | −0.018 | −0.036 |
| L (m) at $z_0'=0.5$ m | −9.6 | −22 | −135 | ∞ | 106 | 22 |
| **Frequency 2025, Zagreb (ERA5) [data]** | 3.5 % | 17.5 % | 9.4 % | 40.3 % | 3.4 % | 25.9 % |
| Median ERA5 BLH (m) **[data]** | 1178 | 520 | 1060 | 135 | 278 | 30 |
| Median ERA5 U10 (m/s) **[data]** | 1.45 | 1.25 | 2.85 | 1.45 | 2.66 | 1.05 |

Without the cap $z_0'$, Golder's class C line crosses zero at $z_0\approx1.3$ m and would make class C slightly stable
over central Zagreb. This is an extrapolation artefact, hence the cap. Where the source provides surface sensible-heat
flux $H_s$, the direct $L=-u_*^3\rho c_pT/(\kappa gH_s)$ should replace the class-based estimate.

### 6.5 Mixing height

$$h_{\rm eff}=\max\big(h_{\rm NWP},\,h_{\min}\big)\tag{6.7}$$

$h_{\rm NWP}$ is Open-Meteo `boundary_layer_height` (forecast), or the ERA5 archive for calibration.

**ERA5 statistics for 2025 [data]:** median $h$ is 170 m. $h<50$ m in **29 %** of hours and $h<100$ m in 42 %. By
month the median at 12 UTC / 00 UTC is: January 550/145 m, April 1395/52 m, July 1385/60 m, October 1045/40 m.

The NWP value reflects a rural-like surface energy balance. A city has a convective-like nocturnal boundary layer from
the heat island. AERMOD models this as $z_{iuc}=z_{iuo}(P/P_0)^{1/4}$ with $z_{iuo}=400$ m and $P_0=2\times10^6$
(**[verified]**, AERMOD formulation, Eq. 110), which gives **315 m for Zagreb** ($P\approx7.7\times10^5$). Default
**$h_{\min}=100$ m** (≈ 7 $\bar H$), with a toggle offering {raw NWP, 100 m, AERMOD 315 m}. Choose it by the night-time
bias in calibration (§10). A lid at 30 m would trap ground emissions in the canopy and bias winter nights high.

The observed NOx increment rises only 2.3× from $h>800$ m (15 µg/m³) to $h<50$ m (35 µg/m³) **[data]**. That is a far
weaker dependence than $1/h$, as expected for a near-field receptor. It supports treating $h$ as a lid effect, not a
dilution volume.

Within the domain, $h_{\rm eff}$ acts through Eq. (4.2) and the lid (§5.3). Its main effect on *total* concentrations
comes through the background, which already carries it.

---

## 7. Emissions

### 7.1 Road line sources

For road segment $s$, vehicle category $c$ and pollutant $p$:

$$q_{s,p}(t)=\frac{1}{3.6\times10^6}\sum_cN_{s,c}(t)\;\Big[EF^{\rm exh}_{c,p}(V_s)+EF^{\rm tyre+brake}_{c,p}(V_s)+EF^{\rm road}_{c,p}+EF^{\rm resusp}_{p}(sL,W)\Big]\ \ [{\rm g\,m^{-1}s^{-1}}]\tag{7.1}$$

$$N_{s,c}(t)={\rm AADT}_s\;\phi_c\;f_{\rm day}(t)\;p_h(t)\ \ [{\rm veh\,h^{-1}}],\qquad \sum_hp_h=1,\ \ \tfrac17\big(5f_{\rm wd}+f_{\rm sat}+f_{\rm sun}\big)=1\tag{7.2}$$

$\phi_c$ is the category share and $V_s$ the mean speed. Segments come from OSM with `lanes`, `oneway` and
`highway` class. Each is rasterised into the **lowest fluid layer** of the per-direction rotated grid, spread across the
carriageway width, with $\sigma_PV$ = the segment length inside cell P (§5.8). Tram tracks are separate segments with
zero exhaust (§7.5).

**AADT** is not yet sourced. It needs City of Zagreb counts. Until then use class defaults, scaled by the calibration
factor β: primary/secondary 20 000–50 000, tertiary 10 000–20 000, residential 1 000–3 000 veh/day. **These are
placeholders.**

### 7.2 Exhaust emission factors

**Tier 1, converted to per-km** (EMEP/EEA Guidebook 2023, 1.A.3.b.i–iv update 2025: Tables 3-5 and 3-6 in g/kg fuel ×
Table 3-15 typical fuel consumption in g/km) **[verified]**:

| Category | FC (g/km) | NOx | PM exhaust | CO | NMVOC (g veh⁻¹ km⁻¹) |
|---|---|---|---|---|---|
| PC petrol | 61.9 | 0.246 | 0.0012 | 2.99 | 0.480 |
| PC diesel | 56.8 | 0.668 | 0.0443 | 0.137 | 0.029 |
| PC LPG | 58.1 | 0.318 | 0.0017 | 3.38 | 0.548 |
| LCV diesel | 79.0 | 1.065 | 0.0964 | 0.538 | 0.097 |
| HDV diesel | 216.8 | 5.63 | 0.119 | 1.32 | 0.195 |
| Urban CNG bus | 405.5 | 6.93 | 0.0081 | 1.61 | 0.057 |
| L-category (petrol) | 27.7 | 0.200 | 0.0141 | 6.78 | 2.57 |

NOx is given as NO₂-equivalent mass, consistent with the ISZZ "NOx izraženi kao NO₂". PM exhaust counts entirely
as PM2.5 = PM10.

**Tier 2 NOx by Euro class** (g/km; same chapter, Tables 3-17, 3-19, 3-21, 3-23) **[verified]**:

| Class | PC petrol (medium) | PC diesel (medium) | LCV diesel N1-II/III | HDV rigid 12–14 t | Urban diesel bus 15–18 t |
|---|---|---|---|---|---|
| Euro 3 / III | 0.105 | 0.786 | 1.037 | 4.128 | 9.175 |
| Euro 4 / IV | 0.064 | 0.599 | 0.839 | 2.855 | 5.748 |
| Euro 5 / V | 0.047 | 0.562 | 1.374 | 2.041 | 6.170 |
| Euro 6 a/b/c / VI A–C | 0.032 | 0.507 | 1.108 | 0.264 | 1.343 |
| Euro 6d / VI D–E | 0.032 | 0.074 | 0.142 | 0.198 | 1.263 |

Also verified: urban CNG bus (EEV) 3.451; diesel PC PM2.5 exhaust Euro 4 0.0383, Euro 5 and later 0.0002 (DPF).

**Example Croatian urban fleet** (vehicle-km shares, **ASSUMED**: PC petrol 40 %, PC diesel 45 %, LCV 8 %, HDV 2 %,
bus 2 %, L-category 3 %, with an ageing Euro mix; replace it with CVH registration statistics and ZET fleet data) **[data]**,
`emission_factors.py`:

| Quantity | Value (g veh⁻¹ km⁻¹) |
|---|---|
| Fleet NOx (Tier 2 mix) | **0.46** (PC petrol 0.08, PC diesel 0.51, LCV 0.98, HDV 1.87, diesel bus 3.98) |
| Fleet PM exhaust | 0.017 |
| Prior used in the app | **NOx 0.50 (range 0.3–0.9)**, since real-world urban driving and cold starts exceed the Tier 2 bulk values |

Croatia has more than 50 % diesel cars in its stock, while 78 % of new 2025 registrations were petrol or hybrid
(ACEA 2025, **[lit]**). Diesel therefore still dominates vehicle-km NOx.

### 7.3 Non-exhaust particles

Tier 1, 1.A.3.b.vi–vii (Tables 3-1, 3-2) **[verified]**, g veh⁻¹ km⁻¹:

| Category | Tyre + brake PM10 | Tyre + brake PM2.5 | Road wear PM10 | Road wear PM2.5 |
|---|---|---|---|---|
| Two-wheelers | 0.0064 | 0.0034 | 0.0030 | 0.0016 |
| Passenger cars | 0.0184 | 0.0093 | 0.0075 | 0.0041 |
| Light-duty trucks | 0.0271 | 0.0139 | 0.0105 | 0.0057 |
| Heavy-duty trucks | 0.0590 | 0.0316 | 0.0380 | 0.0205 |

Tier 2 speed corrections **[verified]**:

- Tyre: $S_T=1.39$ for $V<40$ km/h, $-0.00974V+1.78$ for 40–90 km/h, 0.902 above. Size fractions PM10 0.60, PM2.5 0.42.
- Brake: $S_B=1.67$ for $V<40$ km/h, $-0.0270V+2.75$ for 40–95 km/h, 0.185 above. Size fractions PM10 0.98, PM2.5 0.39.

The fleet wear totals (example fleet) are PM10 0.029 and PM2.5 0.015 g/km. The Guidebook explicitly **excludes
resuspension**.

### 7.4 Resuspension of road dust

US EPA AP-42 §13.2.1 (01/2011) **[verified]**:

$$E=k\,(sL)^{0.91}\,W^{1.02}\,\Big(1-\frac{1.2P}{N}\Big),\qquad k_{\rm PM10}=0.62,\ k_{\rm PM2.5}=0.15\ {\rm g/VKT}\tag{7.3}$$

$sL$ is the silt loading. Default is 0.03 g/m² for ADT > 10 000, 0.06 for 5 000–10 000 and 0.015 for limited-access
roads; the winter multiplier is ×1 for ADT > 10 000 and up to ×4 on low-volume roads. $W$ is the mean fleet weight in
short tons. $P$ is the number of hours with ≥ 0.254 mm of rain in the averaging period of $N$ hours. With $W\approx2.2$
t and $sL=0.03$: PM10 56 mg/km, PM2.5 14 mg/km. The more physical European alternative is NORTRIP (Denby et al. 2013,
**[lit]**), which is too heavy for v1.

**Bottom-up total** (example fleet): PM10 ≈ 0.10, PM2.5 ≈ 0.046 g veh⁻¹ km⁻¹.

### 7.5 Trams, buses and scenario categories

- **Tram**: zero exhaust. Wheel–rail, brake and pantograph wear have no Guidebook factor. Default 0, with a user
  value for sensitivity. A tram can take cars off a parallel road, and the "tram instead of cars" scenario is modelled
  that way (fewer cars) rather than through tram emissions.
- **Buses** (ZET): CNG (EEV) and diesel Euro V/VI. The bus corridor is its own source group, so "electric buses" zeroes
  its exhaust term.
- Toggles such as EV share, Euro 6d share and low-emission zone change $\phi_c$ and the Euro mix in Eq. (7.1). EVs keep
  tyre, road and resuspension terms. Brake wear for BEVs is lower (Table 3-6: 0.0035 vs 0.0122 g/km TSP for a medium car).

### 7.6 Calibrating other pollutants from the NOx increment

All traffic pollutants share one dispersion field Γ, so increment ratios equal emission-factor ratios (the NOx-tracer
method; Ketzel et al. 2003, 2007, **[lit]**). Regressing hours with ΔNOx > 40 µg/m³ through the origin
**[data]** gives:

| Ratio (Z1 − background) | Annual | Winter (Dec–Feb) | Implied EF at NOx 0.46 g/km | Bottom-up (§7.2–7.4) |
|---|---|---|---|---|
| ΔPM10/ΔNOx | 0.187 | 0.17–0.25 | 0.085 g/km | 0.10 g/km |
| ΔPM2.5/ΔNOx (vs ZAGREB-4) | 0.045 | 0.04–0.07 | 0.021 g/km | 0.046 g/km |
| ΔCO/ΔNOx (daily P5 background) | 0.98 | – | 0.44 g/km | 1–3 g/km (Tier 1, older fleet) |
| Δbenzene/ΔNOx | 0.0071 | – | 3.2 mg/km | – |

**Recommendation:** tie $EF_{\rm PM10}$, $EF_{\rm PM2.5}$, $EF_{\rm CO}$ and $EF_{\rm benzene}$ to $EF_{\rm NOx}$ through
these measured ratios, with a monthly PM10 resuspension factor. The absolute level then comes only from β for NOx
(§10). Bottom-up PM2.5 is about 2× the measured ratio, which suggests AP-42 over-predicts fine resuspension here.

### 7.7 Time profiles

A default profile can be derived from the data **[data]**: the median of ΔNOx·$U_{\rm eff}$ by local hour, normalised
to the weekday mean (`effective_emission_profile_z1_2025.csv`).

| Local hour | 00 | 03 | 05 | 06 | 07 | 09 | 12 | 15 | 17 | 19 | 21 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Weekday | 0.64 | 0.43 | 1.54 | **2.10** | 1.28 | 0.52 | 0.76 | 1.23 | 1.47 | 1.56 | 1.14 |
| Saturday | 0.99 | 0.67 | 0.91 | 0.99 | 0.59 | 0.32 | 0.46 | 0.57 | 0.85 | 1.01 | 1.09 |
| Sunday | 1.10 | 0.66 | 0.61 | 0.60 | 0.42 | 0.34 | 0.27 | 0.55 | 0.91 | 0.98 | 0.76 |

Caveat: this "effective" profile still contains the diurnal cycle of stability. The early-morning peak is traffic
under a shallow stable layer. Use traffic counts for $p_h$ when available, and this profile only as a fallback.

### 7.8 Domestic heating (area/volume source, group D)

$$E_{\rm heat}(\mathbf x,t)=\rho_Q(\mathbf x)\sum_f s_f\,EF_f\;\frac{{\rm HDD}(d)}{\sum_{\rm yr}{\rm HDD}}\;\frac{p^{\rm heat}_h}{3600}\ \ [{\rm g\,m^{-2}s^{-1}}],\qquad {\rm HDD}=\begin{cases}18-\bar T_d& \bar T_d\le15\,^\circ{\rm C}\\0&\text{else}\end{cases}\tag{7.4}$$

The HDD rule follows Eurostat **[lit]**. $\rho_Q$ is the annual heat demand per ground area [GJ m⁻² yr⁻¹], about
0.5–1.3 for dense 6–10-storey blocks. $s_f$ is the fuel share: **district heating (HEP Toplinarstvo) = 0 local
emission**. The source is released in the first fluid cell above each roof.

EMEP/EEA 1.A.4.b.i Tier 1 (Tables 3-4 and 3-6) **[verified]**:

| Fuel | NOx | CO | PM10 | PM2.5 (g/GJ) |
|---|---|---|---|---|
| Natural gas | 51 | 26 | 1.2 | 1.2 |
| Solid biomass | 50 | 4000 | 760 | 740 |
| Coal | 110 | 4600 | 404 | 398 |

In the station's district, gas and district heating dominate, so heating matters little for street-level NOx but can
matter for winter PM where wood is burnt. Most of it enters through the background.

### 7.9 Background concentrations

Candidates within 5 km, all data 2025 **[data]**. The last two rows are correlations with the Z1 series.

| Station (ISZZ id, class, position from Z1) | NOx | NO₂ | O₃ | PM10 | PM2.5 | r(NOx) with Z1 | r(PM10) with Z1 |
|---|---|---|---|---|---|---|---|
| Mirogojska cesta (280, urban background, 3.5 km N) | 33.6 | 18.3 | 47.9 | 19.0 | – | 0.65 | 0.68 |
| ZAGREB-4 (303, suburban background, 4.4 km SW) | 24.0 | 16.3 | 54.0 | 25.6 | 15.7 | 0.76 | 0.87 |
| ZAGREB-3 (157, suburban background, 4.7 km SE) | 46.2 | 23.6 | 42.5 | **40.9** | 23.3 | 0.83 | 0.51 |
| CAMS (Open-Meteo `cams_europe`) | – | 9.4 | 63.0 | 21.3 | 18.4 | – | 0.63 |

Recommendations:

1. NOx, NO₂ and O₃ background: **Mirogojska**, with ZAGREB-4 as fallback. ZAGREB-3 is excluded because its PM10 exceeds Z1's.
2. PM10: mean of Mirogojska and ZAGREB-4. PM2.5: ZAGREB-4.
3. Report the sensitivity to an "upwind station" rule. The rule picks the background whose bearing from Z1 is
   closest to the wind direction. It keeps the SW–W minimum of the increment rose (14–24 vs 30–35 µg/m³), so that
   pattern is partly real local geometry (`background_rose_output.txt`).
4. Forecast mode: CAMS scaled by a rolling 14-day ratio to the measured background (§11.4).

---

## 8. NO–NO₂–O₃ chemistry

### 8.1 Options considered

| Option | Inputs | Verdict |
|---|---|---|
| Fixed NO₂/NOx ratio | – | Too crude. The measured ratio ranges from 0.74 at NOx < 25 to 0.13 at 600–1000 µg/m³ **[data]** |
| Derwent–Middleton (1996) | NOx only | Easy fallback. Fitted to a 1991–92 London kerbside site; its high-NOx shape is uncertain |
| Photostationary state (PSS) + primary NO₂ | NOx, $O_3^{bg}$, $NO_2^{bg}$, J, k | Standard, but **over-predicts** at a kerbside site because equilibrium is not reached |
| **Finite reaction time (Riccati) + primary NO₂** | as PSS + plume age τ | **Recommended**: exact for a well-mixed parcel, cheap, uses the age tracer (§5.6) |
| Full GRS / CBM mechanisms | VOC, radicals | Not justified at this scale |

### 8.2 Equations

Reactions: $\mathrm{NO_2}+h\nu\xrightarrow{J}\mathrm{NO}+\mathrm O$, $\mathrm O+\mathrm O_2\to\mathrm O_3$,
$\mathrm{NO}+\mathrm O_3\xrightarrow{k}\mathrm{NO_2}+\mathrm O_2$. NOx and oxidant $\mathrm{O_x}=\mathrm{NO_2}+\mathrm O_3$
are conserved, so both are linear, transportable quantities. In ppb:

$$N=\mathrm{NO_x^{bg}}+\Delta\mathrm{NO_x},\qquad X=\mathrm{O_3^{bg}}+\mathrm{NO_2^{bg}}+f_{\rm NO_2}\,\Delta\mathrm{NO_x}\tag{8.1}$$

$$\frac{dx}{dt}=k(N-x)(X-x)-Jx=k(x-x_1)(x-x_2),\qquad x_{1,2}=\tfrac12\big(N+X+A\mp\Delta\big),\ \Delta=\sqrt{(N+X+A)^2-4NX},\ A=J/k\tag{8.2}$$

**PSS** (Leighton): $x_\infty=x_1$. At night ($J=0$), $x_1=\min(N,X)$, which is titration.

**Finite reaction time** (exact solution of the Riccati equation 8.2 from the initial mixed state $x_0$):

$$x(\tau)=\frac{x_1-x_2\,R\,e^{-k\Delta\tau}}{1-R\,e^{-k\Delta\tau}},\qquad R=\frac{x_0-x_1}{x_0-x_2},\qquad x_0=\mathrm{NO_2^{bg}}+f_{\rm NO_2}\Delta\mathrm{NO_x}\tag{8.3}$$

$\tau$ comes from the age tracer, Eq. (5.8). This is the parcel analogue of OSPM's residence-time chemistry and of the
non-photostationary street model of Soulhac et al. (2022) **[verified]**, which found non-PSS models clearly better in
busy canyons.

Rate coefficients:

$$J(\mathrm{NO_2})=(1+\alpha)\big(B_1G+B_2G^2\big),\ B_1=1.47\times10^{-5},\ B_2=-4.84\times10^{-9}\ {\rm W^{-2}m^4s^{-1}},\ \alpha\approx0.05\tag{8.4}$$

Eq. (8.4) is Trebs et al. (2009) **[verified]**, with $G$ in W/m² from Open-Meteo `shortwave_radiation`. It is valid below
800 m a.s.l. and gives about 8.7×10⁻³ s⁻¹ at 800 W/m².

$$k=3.0\times10^{-12}e^{-1500/T}\ {\rm cm^3molec^{-1}s^{-1}},\qquad k_{\rm ppb}=k\cdot10^{-9}\,\frac{7.2429\times10^{18}\,p_{\rm hPa}}{T}\ \ (\approx4.2\times10^{-4}\ {\rm ppb^{-1}s^{-1}}\text{ at }15\,^\circ{\rm C})\tag{8.5}$$

Eq. (8.5) is the JPL evaluation **[lit]**. The IUPAC value differs by < 10 %.

**Derwent–Middleton** fallback **[verified]** (via Middleton et al. 2007), ppb, $A_{10}=\log_{10}\mathrm{NO_x}$:

$$\mathrm{NO_2}=2.166-\mathrm{NO_x}\big(1.236-3.348A_{10}+1.933A_{10}^2-0.326A_{10}^3\big),\qquad 9<\mathrm{NO_x}<1141.5\ {\rm ppb}\tag{8.6}$$

Outside that range the ratio is limited to 0.723 below 9 ppb and 0.25 above 1141.5 ppb.

### 8.3 Test on ZAGREB-1, 2025

This test uses **measured** NOx, so it tests the chemistry only. Background from Mirogojska; J and T from ERA5 averaged
to the hour mid-point; 8 187 hours **[data]** (`chemistry_test.py`).

| Scheme | Mean NO₂ (obs 31.7) | Mean bias | RMSE (µg/m³) | r | FAC2 |
|---|---|---|---|---|---|
| PSS, $f=0.05$ | 35.2 | +11 % | 10.8 | 0.872 | 0.96 |
| PSS, $f=0.10$ | 36.6 | +15 % | 10.9 | 0.899 | 0.96 |
| PSS, $f=0.20$ | 39.4 | +24 % | 13.4 | 0.919 | 0.96 |
| Riccati, $f=0.10$, τ = 30 s | 28.2 | −11 % | 9.2 | 0.898 | 0.95 |
| **Riccati, $f=0.10$, τ = 60 s** | **30.9** | **−2.5 %** | **7.8** | **0.919** | 0.97 |
| Riccati, $f=0.10$, τ = 120 s | 33.5 | +5.7 % | 8.2 | 0.923 | 0.97 |
| Riccati, $f=0.15$, τ = 60 s | 32.4 | +2.2 % | 8.0 | 0.927 | 0.97 |
| Riccati, $f=0.20$, τ = 30 s | 31.5 | −0.6 % | 9.1 | 0.911 | 0.97 |
| Derwent–Middleton | 33.7 | +6.3 % | 9.2 | 0.895 | 0.99 |

The oxidant regression gives an upper-bound slope of $(\mathrm{NO_2}-\mathrm O_x^{bg})$ against ΔNOx: 0.083 for ΔNOx >
100 ppb, and 0.091 for night hours with ΔNOx > 60 ppb. These estimate $f_{\rm NO_2}\approx0.08$–0.10 **[data]**.

$f$ and τ are partly degenerate (both raise NO₂). Fix $f_{\rm NO_2}=0.10$ from the oxidant regression (range 0.05–0.20
for sensitivity) and take τ from the age tracer. The best constant, τ ≈ 60 s, is consistent with a 20–50 m travel
distance at street-level speeds of 0.3–1 m/s plus canyon residence. It is a **plausibility check** for the modelled τ.

### 8.4 Where it runs

Per displayed voxel or receptor, in the display shader or in JavaScript: convert to ppb, apply (8.1)–(8.5), convert
back. The cost is negligible. Inputs per hour: $\mathrm{NO_x^{bg}}$, $\mathrm{NO_2^{bg}}$, $\mathrm{O_3^{bg}}$, $G$, $T$
and the modelled ΔNOx and τ.

---

## 9. CPU fallback (no float render targets)

The reference falls back to ray heuristics when `EXT_color_buffer_float` is missing or MRT ≥ 4 fails (`LBM.ok = false`).
We need the same fallback. It runs in a Web Worker and uses the same emissions, background and chemistry.

### 9.1 OSPM-type street-canyon model (for receptors inside a street canyon, as at ZAGREB-1)

$$C=C_{\rm bg}+C_d+C_r\tag{9.1}$$

**Direct contribution** comes from integrating a ground-level line-source plume across the street along the
street-level wind. Take $\sigma_z(x)=h_0+\sigma_wx/u_b$ and emission $Q/W$ spread over the street width:

$$C_d=\sqrt{\frac2\pi}\,\frac{Q}{W\sigma_w}\,\ln\!\Big(1+\frac{\sigma_w\,L_d}{u_b\,h_0}\Big),\qquad h_0\approx2\ {\rm m}\tag{9.2}$$

$L_d$ is the upwind path length that contributes directly (the whole width for a receptor on the leeward side of the
vortex, the part outside the vortex for the windward side).

**Recirculation** is a box model: the inflow of emissions into the vortex equals the outflow through its top.

$$C_r=\frac{Q}{W}\,\frac{L_r}{\sigma_{wt}\,L_t},\qquad L_r=\min(L_v,W),\ L_v=2H_{\rm upwind},\ L_t=\min(L_v/2,W)\tag{9.3}$$

**Turbulence:**

$$\sigma_w=\sqrt{(\alpha u_b)^2+\sigma_{w0}^2},\qquad \sigma_{wt}=\sqrt{(\lambda U_{\rm roof})^2+0.4\,\sigma_{w0}^2},\qquad \sigma_{w0}=b\sqrt{NVS_v/W}\tag{9.4}$$

Constants: $\alpha\approx0.1$, $\lambda\approx0.1$, $b\approx0.3$, and $u_b=f_bU_{\rm roof}$ with $f_b\approx0.3$–0.5. The
vortex shrinks linearly below $U_{\rm roof}=2$ m/s.

Sources: Berkowicz et al. 1997, Berkowicz 2000 and the AU OSPM description **[verified for the structure: plume
+ trapezoidal recirculation box, vortex length 2× upwind building height, TPT]**. The **constants are [lit]**; see §13.
Eq. (9.2) is re-derived here and reduces to the line-source formula of §2.4. Roof-level wind:
$U_{\rm roof}=U_{\rm ref}\,\hat u(\bar H)$ from Eq. (6.5).

### 9.2 Gaussian line source with building-induced initial dilution (open receptors, and map view)

Each road segment is split into $M\approx10$ point sources $Q_m=q\,\Delta s$. A ground source with ground reflection gives

$$C(\mathbf x)=\sum_m\frac{Q_m}{\pi\,U_{\rm eff}(z_p)\,\sigma_y\sigma_z}\exp\!\Big(-\frac{y_m^2}{2\sigma_y^2}\Big)\Big[\exp\!\Big(-\frac{z^2}{2\sigma_z^2}\Big)+\text{lid images}\Big]\tag{9.5}$$

with $x_m>0$ downwind, $\sigma_y^2=\sigma_{y0}^2+\sigma_{yB}^2(x_m)$ and $\sigma_z^2=\sigma_{z0}^2+\sigma_{zB}^2(x_m)$.
Initial dilution: $\sigma_{y0}=W/2$ and $\sigma_{z0}=2$ m for vehicle wakes, $0.3H$ in canyons. The lid images are
reflections at $z=\pm2nh_{\rm eff}$, $n\le3$. $U_{\rm eff}$ is evaluated at $z_p=\max(\sigma_z,2\,{\rm m})$.

Briggs urban curves (McElroy–Pooler; e.g. Seinfeld & Pandis, **[lit]**), $x$ in m:

| Class | $\sigma_{yB}$ | $\sigma_{zB}$ |
|---|---|---|
| A–B | $0.32x(1+0.0004x)^{-1/2}$ | $0.24x(1+0.001x)^{1/2}$ |
| C | $0.22x(1+0.0004x)^{-1/2}$ | $0.20x$ |
| D | $0.16x(1+0.0004x)^{-1/2}$ | $0.14x(1+0.0003x)^{-1/2}$ |
| E–F | $0.11x(1+0.0004x)^{-1/2}$ | $0.08x(1+0.0015x)^{-1/2}$ |

Cost: about 500 segments × 10 points for a 100 × 100 map is 5×10⁷ kernel evaluations, which is 0.3–1 s in a worker.
The receptor time series costs nothing.

**The UI must label fallback results "approximate (no 3D flow)".**

---

## 10. Calibration and validation against ISZZ

### 10.1 Pairing and pre-processing (all verified on 2025 data)

- Calibrate on **validated** hourly data (`tipPodatka=1`). Use raw data (`0`) only for "now". Mask −999. Timestamps
  are UTC epoch ms at the end of the hour.
- ERA5/Open-Meteo instantaneous hourly values are averaged over $t-1$ and $t$ to match the averaging hour.
- A month enters the statistics only with ≥ 75 % data capture.
- The observed increment is $\Delta C_{\rm obs}=C_{\rm Z1}-C_{\rm bg}$ with the background of §7.9. Keep **negative
  increments**; they carry information about background mismatch. Do not clip them.

### 10.2 Modelled receptor increment

$$\Delta C_{\rm mod}(t)=\beta\sum_kq_k(t)\,\frac{\tilde\Gamma_k\big(\mathbf r;\theta(t),s(t)\big)}{\sqrt{U(t)^2+U_0^2}},\qquad \tilde\Gamma_k(\theta)=\frac{\sum_jw_j\Gamma_k(\theta_j)}{\sum_jw_j},\ \ w_j=\exp\!\Big[-\frac{\delta(\theta,\theta_j)^2}{2\sigma_\theta^2}\Big]\tag{10.1}$$

$\delta$ is the wrapped angular difference and $\theta_j$ are the 16 run directions. The kernel width is
$\sigma_\theta=\min\big(60^\circ,\ 22.5^\circ\max(1,2\,{\rm m\,s^{-1}}/U)\big)$, representing hourly meander and the
direction error of the meteorological source. For $U<0.5$ m/s, use the frequency-weighted mean over all directions.

### 10.3 What is fitted, and how

| Parameter | Fitted? | Method |
|---|---|---|
| β (NOx emission scale; absorbs AADT, EF and $z_{0r}$ errors) | **Yes** | Minimise (10.2) on the training months |
| $U_0$ (low-wind floor) | **Yes** | Jointly with β, prior 1.4 m/s (§2.4) |
| $h_{\min}$ ∈ {NWP, 100, 315 m} | Discrete choice | Night-time bias on the training months |
| PM10/PM2.5/CO/benzene EF ratios | Pre-fitted from increments (§7.6) | Independent of dispersion |
| $f_{\rm NO_2}$ | Fixed at 0.10 | Oxidant regression (§8.3). Sensitivity 0.05–0.20 |
| $Sc_t$, $\lambda$, $\sigma_\theta$ | **No** (defaults) | Sensitivity only, to avoid over-fitting one station |

$$J(\beta,U_0)=\sum_t\Big[\ln\big(\Delta C_{{\rm obs},t}+c_0\big)-\ln\big(\Delta C_{{\rm mod},t}+c_0\big)\Big]^2,\qquad c_0=10\ \mu{\rm g\,m^{-3}}\tag{10.2}$$

The log form treats factor errors symmetrically, and $c_0$ handles near-zero and negative increments. Two parameters
are fitted by grid search. **Cross-validate**: train on January–June and test on July–December, then swap. Also run
leave-one-month-out. **Only test-period metrics are published.**

### 10.4 Metrics (Chang & Hanna 2004 definitions [verified]; note the sign: FB > 0 means under-prediction)

$$FB=\frac{\overline{C_o}-\overline{C_p}}{0.5(\overline{C_o}+\overline{C_p})},\quad NMSE=\frac{\overline{(C_o-C_p)^2}}{\overline{C_o}\,\overline{C_p}},\quad MG=e^{\overline{\ln C_o}-\overline{\ln C_p}},\quad VG=e^{\overline{(\ln C_o-\ln C_p)^2}}\tag{10.3}$$

$$FAC2=\Pr\Big(0.5\le\frac{C_p}{C_o}\le2\Big),\qquad NAD=\frac{\overline{|C_o-C_p|}}{\overline{C_o}+\overline{C_p}},\qquad R=\frac{\overline{(C_o-\overline{C_o})(C_p-\overline{C_p})}}{\sigma_{C_o}\sigma_{C_p}}\tag{10.4}$$

MG and VG need a lower threshold (Chang & Hanna recommend the LOQ). Use 1 µg/m³ for increments.

**FAIRMODE MQI** applies to *total* concentrations. Parameters from Vitali et al. (2023), Table A1 **[verified]**:

$$MQI=\frac{RMSE}{\beta_F\,RMS_U},\qquad RMS_U=\sqrt{\overline{U(O_i)^2}},\qquad U(O_i)=U_r^{RV}\sqrt{(1-\alpha^2)O_i^2+\alpha^2RV^2},\qquad \beta_F=2\tag{10.5}$$

| Pollutant | $U_r^{RV}$ | RV (µg/m³) | α |
|---|---|---|---|
| NO₂ | 0.24 | 200 | 0.20 |
| O₃ | 0.18 | 120 | 0.79 |
| PM10 | 0.28 | 50 | 0.25 |
| PM2.5 | 0.36 | 25 | 0.50 |

**Acceptance targets**

| Source | Criteria |
|---|---|
| Chang & Hanna (2004) "good model" **[verified]** | About 50 % of predictions within FAC2, mean bias within ±30 %, random scatter a factor of 2–3. Often operationalised as FAC2 ≥ 0.5, \|FB\| ≤ 0.3, NMSE ≤ 1.5, 0.7 ≤ MG ≤ 1.3, VG ≤ 4 **[lit]** |
| Hanna & Chang (2012), urban **[verified]** | \|FB\| < 0.67, NMSE < 6, FAC2 > 0.30, NAD < 0.50 |
| FAIRMODE (assessment) | MQI ≤ 1 (for hourly NO₂ at this station) |

Context: the chemistry step alone, given measured NOx (§8.3), has RMSE 7.8 µg/m³ for NO₂. $RMS_U$ is about 13 µg/m³
here, so MQI ≈ 0.3. The error budget is therefore dominated by dispersion and emissions, not chemistry.

### 10.5 The baseline to beat [data]

A trivial statistical model for the NOx increment (Z1 − Mirogojska) is
$\Delta C=P(h,\text{day type})\,S(\text{sector})/U_{\rm eff}$: a median hour-of-week profile times 16 ERA5 sector factors,
divided by $U_{\rm eff}$ with $U_0=1.2$. Trained January–June and tested July–December (hours with ΔNOx > 1 µg/m³, n = 3066):

| | FB | NMSE | MG | VG | FAC2 | R |
|---|---|---|---|---|---|---|
| Baseline, training | 0.34 | 1.46 | 1.27 | 3.02 | 0.59 | 0.41 |
| **Baseline, test** | **0.21** | **1.96** | **0.95** | **3.56** | **0.53** | **0.31** |

The physics model has **no station-specific statistical fitting except β and U₀**. It should beat the test row on R, VG
and NMSE before any claim of skill beyond climatology. This honest benchmark must be shown in the app's "How good is it?" panel.

### 10.6 Diagnostics that reveal structural errors

- **Pollution-rose ratio**: $\overline{\Delta C_{\rm obs}}/\overline{\Delta C_{\rm mod}}$ per 16 sectors for $U>1.5$ m/s.
  A sector-dependent ratio points to a missing road, wrong AADT or wrong geometry. The measured rose has a pronounced
  SW–W minimum (F6).
- Ratios by hour of day, by wind-speed bin and by stability class. These test $p_h$, $U_0$ and the lid/$\phi_h$.
- **Wind at the mast**: the modelled direction distribution at the anemometer against the station's (N and NW are almost
  absent at the station but 22 % and 14 % in ERA5 **[data]**). This is an independent check that the LBM channelling is right.

### 10.7 Honest presentation rules

1. Always plot measured and modelled together, with the representativeness band (§5.9) and a factor-of-2 envelope.
2. State that β (and $U_0$) are fitted, with their values and the training period. Report test-period metrics and the
   baseline next to them.
3. Show data provenance: raw or validated, and the background station used.
4. Say what the model does not include: buoyancy, deposition, secondary aerosol, traffic congestion dynamics, indoor
   heating detail. Label it as a research and education tool, not an official forecast (DHMZ is the authority).
5. Never extrapolate calibration to other stations without re-validation.

---

## 11. Forecasting: "how will pollution behave"

### 11.1 Verified endpoints (tested 2026-09-27 with an `Origin:` header)

| Source | URL template | Used for | CORS | Notes |
|---|---|---|---|---|
| Open-Meteo forecast | `https://api.open-meteo.com/v1/forecast?latitude=45.8005&longitude=15.9742&hourly=wind_speed_10m,wind_direction_10m,boundary_layer_height,temperature_2m,cloud_cover,shortwave_radiation&wind_speed_unit=ms&timezone=GMT` | Wind, stability, lid, J, T | **`*`** | 168 h by default (`forecast_days` extends it). Wind in km/h unless `wind_speed_unit=ms`. Night BLH of 10–20 m on 27–28 Sep 2026, so the floor of §6.5 is needed |
| Open-Meteo archive (ERA5) | `https://archive-api.open-meteo.com/v1/archive?...&start_date=2025-01-01&end_date=2025-12-31` | Calibration meteorology | **`*`** | 8 760 h for 2025 retrieved. Grid point 45.80 N 15.92 E |
| Open-Meteo air quality (CAMS) | `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=45.8005&longitude=15.9742&hourly=pm10,pm2_5,nitrogen_dioxide,ozone&domains=cams_europe` | Background forecast | **`*`** | `past_days` and `start_date` work (2025 retrieved). Grid 45.8 N 16.0 E |
| ISZZ export | `https://iszz.azo.hr/iskzl/rs/podatak/export/json?postaja=…&polutant=…&tipPodatka=…&vrijemeOd=dd.mm.yyyy&vrijemeDo=dd.mm.yyyy` | Observations, background | **`*` (GET)** | ≤ 1000 rows per call, −999 flags, 429 on bursts. Send no custom headers, which avoids a preflight |

Open-Meteo's terms (free non-commercial use, CC BY 4.0 attribution, fair-use limits) and the Copernicus/CAMS licence
must be checked and cited in the app (§13).

### 11.2 Per-hour forecast pipeline

1. Meteorology $(U,\theta,T,N,G,h_{\rm NWP})$ gives the class $s$ (Table §6.4), then $L$, $\hat u_*$ and $h_{\rm eff}$.
2. $\tilde\Gamma_k$ and $\tilde A_k$ at the receptor and on the display slice come from the cache, with direction
   smoothing (10.1).
3. $q_k(t)$ from the hour of week, the month and the scenario.
4. ΔNOx and τ follow from Eqs. (2.5) and (5.8). The other pollutants follow from the ratios in §7.6.
5. Background comes from bias-corrected CAMS (§11.4).
6. NO₂ comes from Eq. (8.3). Totals are $C_{\rm bg}+\Delta C$.
7. Display a 72–168 h series with a factor-2 band and threshold lines: EU limit values, 24 h PM10 50 µg/m³, hourly
   NO₂ 200 µg/m³. Show the selected-hour 3D field.

### 11.3 Precomputation

16 directions × (1 neutral + optional 1 stable) flow runs. For each, one scalar solve per stability class
(K differs), or per group of classes A–C, D, E–F. Store:

- full-domain RGBA fields $\Gamma_k$ and $A_k$ for the map view (IndexedDB cache, a per-viewer convenience that must
  tolerate being empty);
- a small receptor LUT (JSON) with Γ and A at the station per (direction, class). The same LUT drives the offline Python
  calibration, so the app offers a "download LUT" button. An optional `tools/precompute.py` numpy port of the scalar
  solver can run at 10 m.

### 11.4 Background forecast

$$C_{\rm bg}^{\rm fc}(t)=r_p\,C_{\rm CAMS}(t),\qquad r_p=\frac{\sum_{\rm last\ 14\ d}C_{\rm bg,obs}}{\sum_{\rm last\ 14\ d}C_{\rm CAMS}}\tag{11.1}$$

The 2025 annual ratios **[data]** are NO₂ 1.96 (Mirogojska) or 1.77 (ZAGREB-4), O₃ 0.76–0.86, PM10 0.89–1.20 and
PM2.5 0.85. CAMS NO is unusable (hourly maximum 3.6 µg/m³). Therefore $\mathrm{NO_x^{bg}}=\mathrm{NO_2^{bg}}\cdot$ the
monthly × hourly NOx/NO₂ climatology at Mirogojska. Verify the forecast with the FAIRMODE forecast indicator
$MQI_f=RMSE_{\rm model}/RMSE_{\rm persistence}\le1$, where persistence is the previous day's observation (Vitali et al.
2023, **[verified]**).

### 11.5 UI toggles and what they change

| Control | Model quantity | Recompute? |
|---|---|---|
| Wind direction (dial / "live" / "forecast hour") | θ, so the flow and scalar cache entry | Cache miss: flow 20–60 s + scalar 2–10 s |
| Wind speed | $U$ in $U_{\rm eff}$ | No (instant) |
| Stability (auto / A–F) | $L$, $\hat u_*$, $\phi_h$, lid | Scalar re-solve per class (cached) |
| Mixing height (auto / manual) | $h_{\rm eff}$ (lid) | Scalar re-solve only if the lid is inside the domain |
| Traffic ×, per road group | $q_k$ | No |
| Fleet (EV %, Euro 6d %, diesel %) | $EF$ mix in (7.1) | No |
| Buses electric / trams on | Group C terms | No |
| Heating season / fuel mix | Group D | No |
| Background source (measured / CAMS / manual) | $C_{\rm bg}$ | No |
| Pollutant (NOx, NO₂, PM10, PM2.5, CO, benzene) | Ratios, chemistry | No |
| "Raw physics" vs "calibrated" | β = 1 vs fitted | No |
| Display: slice height, particles, iso-surface | – | No |

---

## 12. Final model specification and implementation order

### 12.1 Specification summary

| Component | Choice | Section |
|---|---|---|
| Flow | Reference LBM D3Q19 (D3Q15 fallback) + Smagorinsky, per direction, coarse 10 m → fine 5 m, time-averaged | §1 |
| Inflow | MO log profile via blending-height matching (neutral in v1), canopy exponential below $\bar H$ | §6.2–6.3 |
| Scalar | Steady FV, first-order upwind implicit + van Leer TVD deferred correction, Jacobi ω = 0.9, 4 groups RGBA + 4 age tracers (MRT) | §5 |
| Closure | $\hat K=\max(\hat K_{\rm MO},\ell_m^2|\hat S|/Sc_t)$, $Sc_t=0.7$, λ = 30 m | §4 |
| Low wind | $U_{\rm eff}=\sqrt{U^2+U_0^2}$, $U_0$ fitted (prior 1.4 m/s); calm → direction-averaged | §2.4 |
| Stability | SRDT (day) + Turner (night) → Golder L; lid $h_{\rm eff}=\max(h_{\rm NWP},100\,{\rm m})$ | §6.4–6.5 |
| Emissions | Line sources (7.1); prior NOx 0.50 g/veh/km; PM/CO/benzene tied to NOx by measured ratios; heating as roof-level volume source | §7 |
| Background | Mirogojska (NOx, NO₂, O₃), mean of Mirogojska and ZAGREB-4 (PM10), ZAGREB-4 (PM2.5); forecast = CAMS × rolling ratio | §7.9, §11.4 |
| Chemistry | Riccati finite-time with conserved Ox, $f_{\rm NO_2}=0.10$, τ from the age tracer; J from Trebs (2009); k from JPL | §8 |
| Fallback | OSPM-type (receptor) + Gaussian line source with Briggs urban σ (map) | §9 |
| Calibration | β, $U_0$ by log least squares, held-out months, Chang & Hanna / Hanna & Chang / FAIRMODE, baseline comparison | §10 |

### 12.2 Default parameters

| Symbol | Default | Range | Source |
|---|---|---|---|
| Δx fine / coarse | 5 m / 10 m | 5–10 m | Reference |
| Fine grid | 120×120×32 (600×600×160 m) | up to 200×200×40 | §5.1 |
| κ | 0.40 | – | [lit] |
| $Sc_t$ | 0.7 | 0.3–1.0 | Tominaga & Stathopoulos 2007 |
| λ (mixing length) | 30 m | 30–150 m | Blackadar 1962 |
| $\hat K_{\min}$ | 0.02 m | – | Numerical floor |
| $z_0$, $d$, $\bar H$ | 1.4 m, 8 m, 14 m | Per sector from LiDAR | §6.1 |
| $z_{0r}$, $z_b$ | 0.3 m, 80 m | 0.1–0.5 m; 60–100 m | §6.2 |
| $h_{\min}$ | 100 m | NWP / 100 / 315 m | §6.5 |
| $U_0$ | 1.4 m/s (fit) | 1.0–2.0 m/s | [data] |
| $EF_{\rm NOx}$ (fleet) | 0.50 g/veh/km | 0.3–0.9 | §7.2 |
| ΔPM10/ΔNOx, ΔPM2.5/ΔNOx, ΔCO/ΔNOx, Δbenzene/ΔNOx | 0.19, 0.045, 1.0, 0.007 | Monthly | [data] |
| $f_{\rm NO_2}$ | 0.10 | 0.05–0.20 | [data] |
| $z_r$ (inlet) | 3.5 m | 1.5–4 m | EU Directive |
| ω, γ ramp | 0.9, 200 sweeps | – | §5.2 |
| Convergence | Probe 10⁻³ / 100 sweeps, residual 10⁻⁴, mass 2 % | – | §5.7 |

### 12.3 Implementation order (each step testable on its own)

1. `data/`: ISZZ client (chunking, 429 back-off, −999, hour-ending), Open-Meteo clients, and a local cache. Unit tests
   with the saved JSON samples in `research/data/physics/`.
2. `geometry/`: voxel mask from buildings (LiDAR/3D model), exclusion of the container, wall distance, roads → `uSrc`
   rasteriser per direction, receptor and mast probes.
3. `flow/`: port `wind-tunnel.js`; `uInflow[]` from §6; add a second `acc` output for ⟨|S|⟩ (optional); sweep of 16 directions.
4. `scalar/`: K-prep (5.5.1) and the first-order upwind Jacobi. Then T1, T2, T5, T6. Then the TVD deferred correction
   (T1 accuracy), the age tracer, probes, reduction and mass balance. Then T3, T4.
5. `emissions/`, `background/`, `chemistry/` as pure functions with unit tests, reproducing the tables in §7–8 from the
   saved data.
6. `tools/calibrate.py` (stdlib + numpy optional): β and U₀ fit, metrics and baseline, `calibration.json` for the app.
7. `forecast/`: pipeline §11.2, CAMS ratio (11.1), $MQI_f$ monitor.
8. `fallback/`: OSPM-type + Gaussian worker.
9. `docs/`: this report split into `docs/physics/*.md`, plus a user-facing "How good is it?" page auto-filled from
   `calibration.json`.

---

## 13. Open issues and items to verify before release

1. **OSPM constants** ($\alpha$, $\lambda$, $b$, $S_v$, $h_0$, the $u_b$ formula) are quoted from secondary memory.
   Check them against Berkowicz (2000), *Environ. Monit. Assess.* 65:323–331, or the NERI 1997 report. The OSTI download
   (`etdeweb/servlets/purl/438467`) timed out twice.
2. **Station metadata**: inlet height, anemometer height and position, and instrument types. Ask DHMZ, or check the ISZZ
   station page `postaja.html?id=155`.
3. **AADT and fleet**: City of Zagreb traffic counts for Miramarska, Vukovarska and the other roads within 500 m; CVH
   registration statistics by Euro class; the ZET bus fleet (CNG, diesel Euro V/VI, electric).
4. **Building heights**: 80 % of the OSM heights within 500 m are defaults. Use the LiDAR/3D city model for the mask
   and for $z_0$ and $d$.
5. $z_{0r}$ of the Open-Meteo/ERA5 grid and the choice of $z_b$. Their effect is absorbed partly by β, but the vertical
   profile shape matters for the lid.
6. Chang & Hanna numeric thresholds (NMSE ≤ 1.5, VG ≤ 4) are the common operationalisation. The paper itself states the
   qualitative criteria quoted in §10.4.
7. Licences: Open-Meteo (CC BY 4.0, non-commercial free tier), CAMS/Copernicus, ISZZ/DHMZ data terms, OSM ODbL.
8. The JPL vs IUPAC NO + O₃ rate constant (< 10 % difference; absorbed by the τ check).
9. Whether ISZZ `tipPodatka=1` (validated) is final for 2025 or still being revised. Re-fetch before publishing metrics.

---

## 14. References

Items marked **[V]** were checked against the saved documents in `research/data/physics/refs/` or live endpoints.

- ACEA (2025). *Vehicles on European Roads*. (Croatia: diesel share of the stock > 50 %; 78 % petrol/hybrid new registrations.)
- Berkowicz, R. (2000). OSPM — a parameterised street pollution model. *Environ. Monit. Assess.* 65, 323–331.
- Berkowicz, R., Hertel, O., Larsen, S.E., Sørensen, N.N., Nielsen, M. (1997). *Modelling traffic pollution in streets*. NERI, Roskilde.
- Blackadar, A.K. (1962). The vertical distribution of wind and turbulent exchange in a neutral atmosphere. *J. Geophys. Res.* 67, 3095–3102.
- Businger, J.A., Wyngaard, J.C., Izumi, Y., Bradley, E.F. (1971). Flux-profile relationships in the atmospheric surface layer. *J. Atmos. Sci.* 28, 181–189.
- Chang, J.C., Hanna, S.R. (2004). Air quality model performance evaluation. *Meteorol. Atmos. Phys.* 87, 167–196. **[V]**
- Denby, B.R. et al. (2013). A coupled road dust and surface moisture model to predict non-exhaust road traffic induced particle emissions (NORTRIP). Part 1. *Atmos. Environ.* 77, 283–300.
- Derwent, R.G., Middleton, D.R. (1996). An empirical function for the ratio NO₂:NOx. *Clean Air* 26, 57–60. (Formula **[V]** via Middleton et al. 2007, Environment Agency review.)
- Di Sabatino, S., Kastner-Klein, P., Berkowicz, R., Britter, R.E., Fedorovich, E. (2003). The modelling of turbulence from traffic in urban dispersion models — Part I. *Environ. Fluid Mech.* 3, 129–143.
- Dyer, A.J. (1974). A review of flux-profile relationships. *Boundary-Layer Meteorol.* 7, 363–372.
- EMEP/EEA (2023). *Air pollutant emission inventory guidebook 2023*: 1.A.3.b.i–iv Road transport (update 2025) **[V]**; 1.A.3.b.vi–vii Tyre, brake and road wear **[V]**; 1.A.4 Small combustion **[V]**.
- European Union (2008). Directive 2008/50/EC on ambient air quality, Annex III (sampling-point criteria).
- Ginzburg, I. (2005). Equilibrium-type and link-type lattice Boltzmann models for generic advection and anisotropic-dispersion equation. *Adv. Water Resour.* 28, 1171–1195.
- Golder, D. (1972). Relations among stability parameters in the surface layer. *Boundary-Layer Meteorol.* 3, 47–58.
- Grimmond, C.S.B., Oke, T.R. (1999). Aerodynamic properties of urban areas derived from analysis of surface form. *J. Appl. Meteorol.* 38, 1262–1292.
- Hanna, S., Chang, J. (2012). Acceptance criteria for urban dispersion model evaluation. *Meteorol. Atmos. Phys.* 116, 133–146. **[V]** (abstract criteria)
- Hou, S., Sterling, J., Chen, S., Doolen, G.D. (1996). A lattice Boltzmann subgrid model for high Reynolds number flows. *Fields Inst. Commun.* 6, 151–166.
- Irwin, J.S. (1979). A theoretical variation of the wind profile power-law exponent as a function of surface roughness and stability. *Atmos. Environ.* 13, 191–194.
- Kakosimos, K.E., Hertel, O., Ketzel, M., Berkowicz, R. (2010). Operational Street Pollution Model (OSPM) — a review of performed application and validation studies, and future prospects. *Environ. Chem.* 7, 485–503.
- Ketzel, M., Wåhlin, P., Berkowicz, R., Palmgren, F. (2003). Particle and trace gas emission factors under urban driving conditions in Copenhagen based on street and roof-level observations. *Atmos. Environ.* 37, 2735–2749.
- Ketzel, M. et al. (2007). Estimation and validation of PM2.5/PM10 exhaust and non-exhaust emission factors for practical street pollution modelling. *Atmos. Environ.* 41, 9370–9385.
- Khosla, P.K., Rubin, S.G. (1974). A diagonally dominant second-order accurate implicit scheme. *Comput. Fluids* 2, 207–209.
- Krüger, T. et al. (2017). *The Lattice Boltzmann Method: Principles and Practice*. Springer.
- Lenschow, P. et al. (2001). Some ideas about the sources of PM10. *Atmos. Environ.* 35 (Suppl. 1), S23–S33.
- Macdonald, R.W., Griffiths, R.F., Hall, D.J. (1998). An improved method for the estimation of surface roughness of obstacle arrays. *Atmos. Environ.* 32, 1857–1864.
- Macdonald, R.W. (2000). Modelling the mean velocity profile in the urban canopy layer. *Boundary-Layer Meteorol.* 97, 25–45.
- Patankar, S.V. (1980). *Numerical Heat Transfer and Fluid Flow*. Hemisphere.
- Paulson, C.A. (1970). The mathematical representation of wind speed and temperature profiles in the unstable atmospheric surface layer. *J. Appl. Meteorol.* 9, 857–861.
- Seinfeld, J.H., Pandis, S.N. (2016). *Atmospheric Chemistry and Physics*, 3rd ed. Wiley. (Briggs–McElroy–Pooler σ; Golder table.)
- Snyder, W.H. (1981). *Guideline for fluid modeling of atmospheric diffusion*. EPA-600/8-81-009.
- Soulhac, L., Fellini, S., Nguyen, C.V., Salizzoni, P. (2022). Simple photochemical modelling of NOx pollution in a street canyon. arXiv:2210.11859. **[V]**
- Sweby, P.K. (1984). High resolution schemes using flux limiters for hyperbolic conservation laws. *SIAM J. Numer. Anal.* 21, 995–1011.
- Tominaga, Y., Stathopoulos, T. (2007). Turbulent Schmidt numbers for CFD analysis with various types of flowfield. *Atmos. Environ.* 41, 8091–8099.
- Trebs, I. et al. (2009). Relationship between the NO₂ photolysis frequency and the solar global irradiance. *Atmos. Meas. Tech.* 2, 725–739. **[V]**
- Troen, I., Mahrt, L. (1986). A simple model of the atmospheric boundary layer; sensitivity to surface evaporation. *Boundary-Layer Meteorol.* 37, 129–148.
- Turner, D.B. (1964). A diffusion model for an urban area. *J. Appl. Meteorol.* 3, 83–91.
- Middleton, D.R., Luhana, L., Sokhi, R.S. (2007). *Review of methods for NO to NO₂ conversion in plumes at short ranges*. Environment Agency Science Report SC030171/SR2. **[V]**
- US EPA (2000). *Meteorological Monitoring Guidance for Regulatory Modeling Applications*, EPA-454/R-99-005 (Tables 6-4 to 6-7). **[V]**
- US EPA (2004/2019). *AERMOD Model Formulation*; AERMOD Implementation Guide (urban option, Eq. 110). **[V]** (formula)
- US EPA (2011). AP-42 §13.2.1 *Paved Roads*. **[V]**
- van Leer, B. (1974). Towards the ultimate conservative difference scheme II. *J. Comput. Phys.* 14, 361–370.
- Vitali, L. et al. (2023). A standardized methodology for the validation of air quality forecast applications (F-MQO). *Geosci. Model Dev.* 16, 6029–6047. **[V]**
- Wieringa, J. (1986). Roughness-dependent geographical interpolation of surface wind speed averages. *Q. J. R. Meteorol. Soc.* 112, 867–889.
- Wilson, J.D., Sawford, B.L. (1996). Review of Lagrangian stochastic models for trajectories in the turbulent atmosphere. *Boundary-Layer Meteorol.* 78, 191–210.

---

## Appendix A. Data and scripts saved under `research/data/physics/`

| File | Content |
|---|---|
| `iszz/<station>_<pollutant>_<type>_2025.json` | 2025 hourly series, merged and deduplicated (`t_ms`, `v`, unit). Stations 155, 157, 280, 303. Pollutants 1 (NO₂), 3 (CO), 5 (PM10), 28 (PM2.5), 31 (O₃), 32 (benzene), 38 (NOx), 475/477/478 (T, wind speed, wind direction) |
| `iszz/postaja_koordinate.json`, `iszz/postaja_emetalist.json` | Station coordinates and metadata (type, EoI code) from `/iskzl/rs/postaja/koordinate` and `/eMetaList` |
| `openmeteo_forecast.json` / `.headers` | Forecast sample and CORS headers (2026-09-27) |
| `openmeteo_aq.json` / `.headers`, `openmeteo_aq_2025.json` | CAMS forecast sample, CORS headers, 2025 history |
| `openmeteo_archive_2025.json`, `openmeteo_archive_sample.json` | ERA5 hourly 2025 (wind 10/100 m, BLH, T, cloud, SW radiation) |
| `fetch_iszz.py`, `fetch_iszz_2.py` | Chunked ISZZ downloader with 429 back-off |
| `analyse.py`, `analyse2.py` (+ `analysis_output.txt`, `analysis2_output.txt`, `analysis3_output.txt`) | Coverage, timestamp lag, annual means, station vs ERA5 wind, roses, NO₂/NOx bins, CAMS comparison |
| `u0_fit.py` (+ output) | Low-wind floor $U_0$ for three backgrounds |
| `background_rose.py` (+ output) | Increment rose against background choice |
| `stability.py` (+ output, `pg_class_2025_era5.csv`) | P-G classes (SRDT + Turner), Golder L, BLH by class |
| `chemistry_test.py` (+ output) | PSS vs Riccati vs Derwent–Middleton on Z1 |
| `profile_baseline.py` (+ output, `effective_emission_profile_z1_2025.csv`) | Effective emission profile and statistical baseline |
| `emission_factors.py` (+ output) | Tier 1/2 fleet factors, non-exhaust, AP-42 |
| `morphometry_output.txt` | OSM-based λ_p, λ_f, H̄, z₀, d |
| `increment_ratios_output.txt`, `cams_vs_background_output.txt` | Emission-ratio method; CAMS bias table |
| `refs/*.pdf`, `refs/*.txt` | EMEP/EEA chapters, EPA SRDT guidance, AP-42, Trebs 2009, Chang & Hanna 2004, FAIRMODE F-MQO paper, UK EA NO₂ review, Soulhac et al. 2022 |

## Appendix B. Notation

$\hat{(\cdot)}$: normalised by $U_{\rm ref}$. $\Gamma_k$ [m⁻¹]: unit-emission response. $A_k$ [–]: age tracer.
$q_k$ [g m⁻¹ s⁻¹]: line-source strength. $\sigma_k$ [m⁻²]: source pattern. $U_{\rm ref}$: 10 m reference wind.
$U_0$: low-wind floor. $K$: scalar eddy diffusivity. $\ell_m$: mixing length. $d_w$: wall distance. $L$: Obukhov length.
$h_{\rm eff}$: mixing height. $f_{\rm NO_2}$: primary NO₂ fraction. $J$: NO₂ photolysis frequency. $k$: NO + O₃ rate
coefficient. τ: plume age. β: calibrated emission multiplier.
