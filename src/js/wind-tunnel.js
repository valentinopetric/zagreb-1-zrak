// ------------------------------------------------------------------ wind tunnel
/*
 * GPU wind tunnel: adapted from maksimir-pod-kisom © 2026 Ivan Rezić, MIT
 * (https://github.com/ivanrezic/maksimir-pod-kisom, src/js/wind-tunnel.js).
 *
 * A 3D Lattice-Boltzmann wind tunnel on the GPU: D3Q19 (or D3Q15 where the GPU can only write four float
 * targets at once) with a Smagorinsky eddy viscosity (physics §1.2). The grid is turned to face the wind,
 * so the air always enters at x = 0 with the urban inflow profile of physics §6.2–6.3, wraps around
 * sideways (periodic), has the inlet wind of its top layer above its lid and leaves at x = nx through an
 * 80 m sponge (physics §1.3). The ground is free-slip, as in the reference (critic G12): the profile is
 * held back by the resolved buildings and trees, not by a 5 m no-slip floor that would wear it down.
 * Buildings are solid cells that bounce the air back; partly covered cells and tree crowns are porous
 * cells that bounce back a share of it (voxel.js). What we keep is the flow averaged over the last steps,
 * as a fraction of the 10 m reference wind U10, so one run per wind direction serves every wind speed
 * (Reynolds-number independence of sharp-edged flows, physics §1.5).
 *
 * Changes from the reference, for ZAGREB-1 (architecture §5.1–5.2, critic §4.4):
 *   - the tunnel is 600 m along × 600 m across × 160 m high with the station 300 m from the inlet
 *     (tunnelGrid, from SITE.extent.tunnel); fine cells 5 m, spin-up 10 m; ?grid=coarse or a software
 *     renderer uses 10 m as the fine grid (and 20 m for the spin-up), ?grid=fine forces 5 m;
 *   - the inlet and lid profile is inflowProfile(z): the log law over the city (z0 = 1.5 m, d = 7 m),
 *     matched to U10 at the blending height z_b = 80 m over the NWP roughness z0r = 0.3 m, with the
 *     exponential canopy profile below H̄ = 14 m. The same JS function fills a per-layer uniform table
 *     uInflow[NZ] of the shaders, so JS and GLSL use identical values;
 *   - the whole neighbourhood is voxelised (voxel.js), not only one object;
 *   - step counts are given in flow-through times of the tunnel, so they follow its length and cell size;
 *   - WindTunnel.flow() hands the averaged flow to the scalar solver on the GPU without a readback.
 *
 * Kept from the reference: D3Q19/D3Q15 detection, the Smagorinsky closure and its safeguards, porous
 * bounce-back, the coarse spin-up that seeds the fine run, the population offsets from the rest weights
 * (fp32 precision), the link bits, the outlet and the asynchronous readback.
 *
 * The distributions live in 2D float textures: each horizontal layer of the grid is one tile (voxel.js).
 */

// The renderer whose GL context runs the tunnel: the scene's (scene.js), or, when this file runs without
// it (the module tests in isolation), a private 1 × 1 one. Textures only work within one context, so the
// scalar solver must use the same renderer; in the app both use scene.js's `renderer`.
const WT_RENDERER = (() => {
  if (typeof renderer !== 'undefined' && renderer && typeof renderer.getContext === 'function') return renderer;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return new THREE.WebGLRenderer({ canvas: c, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  } catch (e) {
    console.warn('wind tunnel: no WebGL2 renderer', e);
    return null;
  }
})();

const LBM = (() => {
  const r = WT_RENDERER;
  if (!r) return { ok: false, q: 0, software: true, gpu: '' };
  const gl = r.getContext();
  const floatTargets = r.extensions.has('EXT_color_buffer_float');
  const drawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  // A GPU may also refuse that many float targets at once: phones before the iPhone 12 hold at most 64 bytes
  // per pixel across them, and D3Q19 writes 80. So draw a pixel into n targets and read the last one back.
  const works = (n) => {
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, count: n, depthBuffer: false });
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: 'in vec3 position;\nvoid main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp float;\n${Array.from({ length: n }, (_, k) => `layout(location = ${k}) out vec4 o${k};`).join('\n')}\nvoid main() { ${Array.from({ length: n }, (_, k) => `o${k} = vec4(${k}.5);`).join(' ')} }`,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat), px = new Float32Array(4);
    quad.frustumCulled = false;
    r.setRenderTarget(rt);
    r.render(quad, new THREE.Camera());
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + n - 1);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    r.setRenderTarget(null);
    rt.dispose(); mat.dispose(); quad.geometry.dispose();
    return px[0] === n - 0.5;
  };
  let q = 0;
  try { q = !floatTargets ? 0 : drawBuffers >= 5 && works(5) ? 19 : drawBuffers >= 4 && works(4) ? 15 : 0; } catch (e) { console.warn('wind tunnel: float target probe failed', e); }
  return { ok: q > 0, q, software: /SwiftShader|llvmpipe|software/i.test(gpu), gpu };
})();

// ------------------------------------------------------------------ constants of the lattice
/*
 * U_LATTICE: lattice speed of the 10 m reference wind (reference; architecture §5.2). The inflow reaches
 * û ≈ 1.9 at the lid (inflowProfile(157.5 m)), i.e. 0.14 in lattice units, Mach 0.25 < 0.3 (physics §6.3).
 * τ0 = 0.506 sets a small molecular viscosity and C_s = 0.17 the Smagorinsky constant (physics Eq. 1.3).
 * The porous blend weight 0.6 per unit solid fraction and the 80 m sponge are the reference's (physics §1.3).
 */
const U_LATTICE = 0.075;
const WT_TAU0 = 0.506, WT_CS = 0.17, WT_POROUS = 0.6, WT_SPONGE_M = 80;
const WT_CENTER = new THREE.Vector3(RECEPTOR.x, 0, RECEPTOR.z);   // the station: the point every tunnel is centred on

// ------------------------------------------------------------------ inflow profile (physics §6.2–6.3)
/*
 * The mean wind entering the tunnel, as a fraction û(z) = u(z)/U10 of the reference 10 m wind of the
 * weather model (IFS, whose grid box has roughness z0r). Neutral stability (v1: the flow is neutral,
 * stability enters through the scalar's K field; physics §4.6, critic §4.4). With ψ_m = 0:
 *
 *   û*_r   = κ / ln(z_ref / z0r)                                   friction velocity of the NWP profile (Eq. 6.2)
 *   û(z_b) = (û*_r / κ) · ln(z_b / z0r)                            its speed at the blending height (Eq. 6.2)
 *   û*     = κ · û(z_b) / ln((z_b − d) / z0)                       urban friction velocity (Eq. 6.3)
 *   û(z)   = (û* / κ) · ln((z − d) / z0)                  z ≥ H̄      urban log law (Eq. 6.5)
 *   û(z)   = û(H̄) · exp(a · (z/H̄ − 1))                 z < H̄      canopy profile (Eq. 6.5; Macdonald 2000)
 *
 * With the defaults: û*_r = 0.1141, û(z_b) = 1.593, û* = 0.1640 (physics §6.2's example gives 0.162 for
 * d = 8, z0 = 1.4), û(H̄) = 0.632, û(10 m) = 0.358, û(160 m) = 1.90.
 *
 * Note that û(10 m) is NOT 1: U10 is the 10 m wind over the NWP's smoother surface (z0r = 0.3 m); inside
 * the city's canopy, at 10 m, the wind is about a third of it. The two profiles agree at z_b (matching),
 * and the NWP profile itself, ruralProfile(z) below, is 1 at 10 m by construction.
 */
const INFLOW = Object.freeze({
  kappa: MD.kappa,   // 0.40, von Kármán constant (physics §4, critic §4.5)
  z0: MD.z0_m,       // 1.5 m, urban roughness length (critic §1.10: ZG3D Macdonald 1.47 m; critic §4.4)
  d: MD.d_m,         // 7 m, displacement height (critic §1.10: 6.8 m)
  Hbar: MD.Hbar_m,   // 14 m, mean building height (critic §1.10: 14.2 m)
  z0r: MD.z0r_m,     // 0.3 m, roughness of the NWP grid box (physics §6.2; sensitivity 0.1–0.5 m)
  zb: MD.zb_m,       // 80 m, blending height (physics §6.2, Wieringa 1986; 60–100 m)
  zref: 10,          // m, height of the reference wind U10
  a: 2.0,            // canopy attenuation: middle of physics §6.3's a ≈ 1–3. Macdonald (2000) ties a to λf
                     // (≈ 9.6 λf for staggered cubes, [lit, unverified]), 1.85 for λf = 0.193 (critic §1.10)
});

function inflowConstants(p = INFLOW) {
  const ustarR = p.kappa / Math.log(p.zref / p.z0r);
  const ub = (ustarR / p.kappa) * Math.log(p.zb / p.z0r);
  const ustar = (p.kappa * ub) / Math.log((p.zb - p.d) / p.z0);
  const uH = (ustar / p.kappa) * Math.log((p.Hbar - p.d) / p.z0);
  return { ustarR, ub, ustar, uH };
}
const INFLOW_K = inflowConstants(INFLOW);

// û(z) = u(z) / U10 at height z (m above ground) entering the tunnel.
function inflowProfile(z, p = INFLOW, k = p === INFLOW ? INFLOW_K : inflowConstants(p)) {
  const h = Math.max(0, z);
  if (h >= p.Hbar) return (k.ustar / p.kappa) * Math.log((h - p.d) / p.z0);
  return k.uH * Math.exp(p.a * (h / p.Hbar - 1));
}
// The NWP's own log profile over z0r (1 at z_ref), for checks and docs only.
function wt_ruralProfile(z, p = INFLOW) { return Math.log(Math.max(z, p.z0r) / p.z0r) / Math.log(p.zref / p.z0r); }

// ------------------------------------------------------------------ grids
/*
 * tunnelGrid(dx, {warm, avg, along, across, height, up}) → {dx, up, nx, ny, nz, tx, W, H, warm, avg, every, id, ft}
 *
 * The tunnel box from SITE.extent.tunnel (600 × 600 × 160 m, station 300 m from the inlet) unless given.
 * The atlas has tx = ceil(√nz) tiles per row (physics Eq. 1.1). warm and avg are in flow-through times
 * ft = nx / U_LATTICE steps (the steps the 10 m wind needs to cross the tunnel once), so a coarser grid
 * needs proportionally fewer steps for the same physical time. The flow is sampled every 3 steps.
 *
 * The run lengths are the reference's, per flow-through (its tunnel was 520 m long): spin-up 1200 + 300
 * steps of 10 m = 1.73 + 0.43 flow-throughs; fine run 900 + 300 steps of 5 m = 0.65 + 0.22 flow-throughs.
 * docs/03-flow-lbm.md §5 checks that this is converged at the station.
 */
const WT_RUN = Object.freeze({
  spin: { warm: 1.75, avg: 0.43 },
  fine: { warm: 0.65, avg: 0.22 },
});
function tunnelGrid(dx, opts = {}) {
  const X = SITE.extent.tunnel;
  const along = opts.along || X.along_m, across = opts.across || X.across_m, height = opts.height || X.height_m;
  const up = opts.up === undefined ? X.up_m : opts.up;
  const warm = opts.warm === undefined ? WT_RUN.fine.warm : opts.warm, avg = opts.avg === undefined ? WT_RUN.fine.avg : opts.avg;
  const nx = Math.round(along / dx), ny = Math.round(across / dx), nz = Math.round(height / dx);
  const tx = Math.ceil(Math.sqrt(nz));
  const ft = nx / U_LATTICE;
  return {
    dx, up, nx, ny, nz, tx, W: nx * tx, H: ny * Math.ceil(nz / tx),
    warm: Math.round(warm * ft), avg: Math.max(3, Math.round(avg * ft)), every: 3,
    id: `${nx}x${ny}x${nz}@${dx}m`, ft,
  };
}
// The fine grid: 5 m, or 10 m on a software renderer or with ?grid=coarse; ?grid=fine forces 5 m.
const WT_FINE_DX = (() => {
  const X = SITE.extent.tunnel, g = PARAMS.get('grid');
  if (g === 'coarse') return X.dx_coarse;
  if (g === 'fine') return X.dx_fine;
  return LBM.software ? X.dx_coarse : X.dx_fine;
})();
const TUNNEL = tunnelGrid(WT_FINE_DX, WT_RUN.fine);
const SPINUP = tunnelGrid(TUNNEL.dx * 2, WT_RUN.spin);

// ------------------------------------------------------------------ lattice
function velocitySet(q) {
  const c = q === 19
    ? [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, -1, 0], [1, -1, 0], [-1, 1, 0],
      [1, 0, 1], [-1, 0, -1], [1, 0, -1], [-1, 0, 1], [0, 1, 1], [0, -1, -1], [0, 1, -1], [0, -1, 1]]
    : [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 1], [-1, -1, -1], [1, 1, -1], [-1, -1, 1],
      [1, -1, 1], [-1, 1, -1], [-1, 1, 1], [1, -1, -1]];
  const w = c.map((v) => {
    const n = Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]);
    return q === 19 ? [1 / 3, 1 / 18, 1 / 36][n] : [2 / 9, 1 / 9, 0, 1 / 72][n];
  });
  const opp = c.map((v) => c.findIndex((u) => u[0] === -v[0] && u[1] === -v[1] && u[2] === -v[2]));
  const mir = c.map((v) => c.findIndex((u) => u[0] === v[0] && u[1] === v[1] && u[2] === -v[2]));
  return { c, w, opp, mir };
}

// ------------------------------------------------------------------ shaders
// T is the grid; S, if given, the coarser grid whose averaged flow a run may start from.
function lbmSources(set, T, S = null) {
  const Q = set.c.length, NT = Math.ceil(Q / 4), CH = 'xyzw';
  const range = (n) => Array.from({ length: n }, (_, k) => k);
  const common = `precision highp float;
precision highp int;
precision highp sampler2D;
#define Q ${Q}
const int NX = ${T.nx}, NY = ${T.ny}, NZ = ${T.nz}, TX = ${T.tx};
const vec3 C[Q] = vec3[Q](${set.c.map((v) => `vec3(${v.map((x) => x.toFixed(1)).join(', ')})`).join(', ')});
const float WT[Q] = float[Q](${set.w.map((x) => x.toFixed(9)).join(', ')});
const int OPP[Q] = int[Q](${set.opp.join(', ')});
uniform sampler2D uMask;
${range(NT).map((k) => `uniform sampler2D uF${k};`).join('\n')}
// Lattice velocity of the inflow per layer: U_LATTICE · inflowProfile((k + 0.5) dx), filled from JS.
uniform float uInflow[NZ];
ivec3 cellOf(ivec2 t) { int a = t.x / NX, b = t.y / NY; return ivec3(t.x - a * NX, t.y - b * NY, b * TX + a); }
ivec2 texOf(ivec3 c) { return ivec2(c.x + (c.z % TX) * NX, c.y + (c.z / TX) * NY); }
float feq(int i, float rho, vec3 u) { float cu = dot(C[i], u); return WT[i] * rho * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * dot(u, u)); }
vec3 inflow(int z) { return vec3(uInflow[clamp(z, 0, NZ - 1)], 0.0, 0.0); }
${S ? `uniform bool uSeeded;
uniform sampler2D uSeed;
uniform sampler2D uSeedMask;
uniform float uSeedScale;
const int SNX = ${S.nx}, SNY = ${S.ny}, SNZ = ${S.nz}, STX = ${S.tx};
// The coarse run's mean velocity at a cell of this grid, interpolated from its open cells around it.
// Both grids use the same U_LATTICE for U10, so their lattice velocities are directly comparable.
vec3 coarse(ivec3 p) {
  vec3 g = clamp((vec3(p) + 0.5) * ${(T.dx / S.dx).toFixed(6)} - 0.5, vec3(0.0), vec3(float(SNX), float(SNY), float(SNZ)) - 1.001);
  ivec3 b = ivec3(g);
  vec3 f = g - vec3(b), u = vec3(0.0);
  float ws = 0.0;
  for (int n = 0; n < 8; n++) {
    ivec3 o = ivec3(n & 1, (n >> 1) & 1, n >> 2), c = b + o;
    ivec2 q = ivec2(c.x + (c.z % STX) * SNX, c.y + (c.z / STX) * SNY);
    if (texelFetch(uSeedMask, q, 0).r > 0.99) continue;
    vec3 w3 = mix(1.0 - f, f, vec3(o));
    float w = w3.x * w3.y * w3.z;
    u += w * texelFetch(uSeed, q, 0).xyz;
    ws += w;
  }
  return ws > 1e-3 ? u * uSeedScale / ws : vec3(0.0);
}` : ''}
`;
  const outs = range(NT).map((k) => `layout(location = ${k}) out vec4 o${k};`).join('\n');
  // The textures hold each population's offset from its rest weight, for precision.
  const write = (a) => range(NT).map((k) => `o${k} = vec4(${range(4).map((j) => (4 * k + j < Q ? `${a}[${4 * k + j}] - WT[${4 * k + j}]` : '0.0')).join(', ')});`).join(' ');
  const load = (a) => range(NT).map((k) => `vec4 L${k} = texelFetch(uF${k}, t, 0);`).join(' ') + '\n  ' +
    set.c.map((_, i) => `${a}[${i}] = L${i >> 2}.${CH[i & 3]} + WT[${i}];`).join(' ');
  // Pull streaming: each direction reads the neighbour it arrives from. The ground is free-slip:
  // a population arriving from below is the mirror image of one that left sideways a step earlier,
  // so the inlet profile is held back by the buildings instead of being worn down by a 5 m no-slip floor.
  const pulls = set.c.map((c, i) => {
    if (i === 0) return 'f[0] = me[0];';
    const o = set.opp[i], r = set.mir[i];
    return `s = p - ivec3(${c.join(', ')});
  if (s.z < 0) { q = texOf(ivec3(clamp(s.x, 0, NX - 1), (s.y + NY) % NY, 0)); f[${i}] = (links & ${1 << i}) != 0 ? me[${o}] : texelFetch(uF${r >> 2}, q, 0).${CH[r & 3]} + WT[${r}]; }
  else if (s.z >= NZ) f[${i}] = feq(${i}, 1.0, inflow(NZ - 1));
  else if (s.x < 0) f[${i}] = feq(${i}, 1.0, inflow(s.z));
  else if (s.x >= NX) f[${i}] = feq(${i}, 1.0, uo);
  else { s.y = (s.y + NY) % NY; q = texOf(s); f[${i}] = (links & ${1 << i}) != 0 ? me[${o}] : texelFetch(uF${i >> 2}, q, 0).${CH[i & 3]} + WT[${i}]; }`;
  }).join('\n  ');
  // Which directions stream in from a solid cell and so bounce back: worked out once per run, one bit each.
  const linkBits = set.c.map((c, i) => i === 0 ? '' : `s = p - ivec3(${c.join(', ')});
  if (s.z < 0) { if (texelFetch(uMask, texOf(ivec3(clamp(s.x, 0, NX - 1), (s.y + NY) % NY, 0)), 0).r > 0.99) bits |= ${1 << i}; }
  else if (s.z < NZ && s.x >= 0 && s.x < NX) { s.y = (s.y + NY) % NY; if (texelFetch(uMask, texOf(s), 0).r > 0.99) bits |= ${1 << i}; }`).join('\n  ');
  const spongeCells = Math.round(WT_SPONGE_M / T.dx);

  return {
    vertex: 'in vec3 position;\nvoid main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    init: `${common}
${outs}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 p = cellOf(t);
  float o[Q];
  vec3 u = (p.z >= NZ || texelFetch(uMask, t, 0).r > 0.99) ? vec3(0.0) : ${S ? 'uSeeded ? coarse(p) : ' : ''}inflow(p.z);
  for (int i = 0; i < Q; i++) o[i] = feq(i, 1.0, u);
  ${write('o')}
}`,
    // The cell's solid fraction and, in the other channels, the bits of the directions that bounce back.
    links: `${common}
layout(location = 0) out vec4 oLinks;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 p = cellOf(t);
  int bits = 0;
  ivec3 s;
  if (p.z < NZ) {
  ${linkBits}
  }
  oLinks = vec4(texelFetch(uMask, t, 0).r, float(bits & 255) / 255.0, float((bits >> 8) & 255) / 255.0, float(bits >> 16) / 255.0);
}`,
    step: `${common}
uniform sampler2D uLinks;
uniform float uTau0;
uniform float uCs2;
${outs}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 p = cellOf(t);
  float o[Q];
  if (p.z >= NZ) { for (int i = 0; i < Q; i++) o[i] = WT[i]; ${write('o')} return; }
  vec4 lk = texelFetch(uLinks, t, 0);
  float m = lk.r;
  if (m > 0.99) { for (int i = 0; i < Q; i++) o[i] = WT[i]; ${write('o')} return; }
  int links = int(lk.g * 255.0 + 0.5) | (int(lk.b * 255.0 + 0.5) << 8) | (int(lk.a * 255.0 + 0.5) << 16);
  float me[Q];
  float f[Q];
  ${load('me')}
  // The outlet lets in the equilibrium at rest density with the last cell's own velocity. Copying the cell's
  // populations instead fed a wake that reached the end back into itself, until the flow ran away.
  vec3 uo = vec3(0.0);
  if (p.x == NX - 1) { float r = 0.0; for (int i = 0; i < Q; i++) { r += me[i]; uo += me[i] * C[i]; } uo /= r; }
  ivec3 s;
  ivec2 q;
  ${pulls}
  float rho = 0.0;
  vec3 mom = vec3(0.0);
  for (int i = 0; i < Q; i++) { rho += f[i]; mom += f[i] * C[i]; }
  vec3 u = mom / max(rho, 1e-3);
  // Safeguards (reference, physics §1.2): reset a cell whose density left (0.3, 3) or went NaN, cap |u| at 0.3.
  if (!(rho > 0.3 && rho < 3.0) || any(isnan(u))) { rho = 1.0; u = inflow(p.z); for (int i = 0; i < Q; i++) f[i] = feq(i, 1.0, u); }
  float un = length(u);
  if (un > 0.3) u *= 0.3 / un;
  float fe[Q];
  float pxx = 0.0, pyy = 0.0, pzz = 0.0, pxy = 0.0, pxz = 0.0, pyz = 0.0;
  for (int i = 0; i < Q; i++) {
    fe[i] = feq(i, rho, u);
    float n = f[i] - fe[i];
    vec3 c = C[i];
    pxx += c.x * c.x * n; pyy += c.y * c.y * n; pzz += c.z * c.z * n;
    pxy += c.x * c.y * n; pxz += c.x * c.z * n; pyz += c.y * c.z * n;
  }
  // Smagorinsky (physics Eq. 1.3; 25.456 = 18·√2): relax more where the flow is shearing hard. Over the
  // last ${WT_SPONGE_M} m a sponge thickens the air so the wake leaves the tunnel quietly.
  float qn = sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2.0 * (pxy * pxy + pxz * pxz + pyz * pyz));
  float sp = max(0.0, float(p.x - NX + ${spongeCells + 1}) / ${spongeCells}.0), t0 = uTau0 + 0.3 * sp * sp;
  float tau = 0.5 * (t0 + sqrt(t0 * t0 + 25.456 * uCs2 * qn / rho));
  // Porous cells (partly covered cells, tree crowns) bounce part of the air back.
  float ns = ${WT_POROUS.toFixed(3)} * m;
  for (int i = 0; i < Q; i++) o[i] = mix(f[i] - (f[i] - fe[i]) / tau, f[OPP[i]], ns);
  ${write('o')}
}`,
    acc: `${common}
uniform sampler2D uAvg;
layout(location = 0) out vec4 oAvg;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 p = cellOf(t);
  vec4 prev = texelFetch(uAvg, t, 0);
  if (p.z >= NZ || texelFetch(uMask, t, 0).r > 0.99) { oAvg = prev; return; }
  float me[Q];
  ${load('me')}
  float rho = 0.0;
  vec3 mom = vec3(0.0);
  for (int i = 0; i < Q; i++) { rho += me[i]; mom += me[i] * C[i]; }
  // A porous cell's stored populations keep 1 - 2·${WT_POROUS.toFixed(1)}·m of the momentum it streams with (see the step).
  vec3 u = mom / max(rho, 1e-3) / max(1.0 - ${(2 * WT_POROUS).toFixed(3)} * texelFetch(uMask, t, 0).r, 0.1);
  oAvg = prev + vec4(u, length(u));
}`,
  };
}

// ------------------------------------------------------------------ the tunnel
/*
 * new WindTunnel(T, S?, {profile}?) holds the textures and shaders of one grid T; given the coarser grid S it
 * can start a run from the averaged flow of a tunnel on S (the reference's spin-up → fine seeding).
 * `profile(z) → û` replaces inflowProfile at the inlet and lid (tests, sensitivity runs); the default is
 * inflowProfile. The WindField fallback outside the tunnel always uses inflowProfile.
 *
 *   begin(geo, fromDeg, seed?, {center, voxels}?)  voxelise geo (cityGeometry) in the frame for fromDeg and
 *                                                  start from the inflow everywhere (or from `seed`'s flow);
 *   advance(n) → progress 0..1                     n lattice steps (fewer at the end), then samples the mean;
 *   flow() → {avg, samples, uLattice, mask, T, frame, grid, from}   the averaged flow for the scalar solver,
 *                                                  on the GPU (architecture §6.2); valid until the next begin();
 *   async collect() → WindField                    the averaged flow read back without stalling the page;
 *                                                  the tunnel is free for the next run at once;
 *   dispose()                                      frees the GPU memory.
 */
class WindTunnel {
  constructor(T, S = null, { profile = inflowProfile } = {}) {
    if (!LBM.ok) throw new Error('WindTunnel: no float render targets (LBM.ok = false)');
    this.T = T;
    this.S = S;
    this.set = velocitySet(LBM.q);
    this.nTex = Math.ceil(this.set.c.length / 4);
    const opts = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false };
    this.f = [0, 1].map(() => new THREE.WebGLRenderTarget(T.W, T.H, { ...opts, count: this.nTex }));
    this.avg = [0, 1].map(() => new THREE.WebGLRenderTarget(T.W, T.H, opts));
    this.links = new THREE.WebGLRenderTarget(T.W, T.H, { ...opts, type: THREE.UnsignedByteType });
    const tex = (data, format, type) => {
      const t = new THREE.DataTexture(data, T.W, T.H, format, type);
      t.unpackAlignment = 1;
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      return t;
    };
    this.maskTex = tex(new Uint8Array(T.W * T.H), THREE.RedFormat, THREE.UnsignedByteType);
    const src = lbmSources(this.set, T, S);
    const table = new Float32Array(T.nz);
    for (let k = 0; k < T.nz; k++) table[k] = U_LATTICE * profile((k + 0.5) * T.dx);
    this.uniforms = {
      uMask: { value: this.maskTex }, uLinks: { value: this.links.texture }, uInflow: { value: table },
      uTau0: { value: WT_TAU0 }, uCs2: { value: WT_CS * WT_CS }, uAvg: { value: null },
    };
    if (S) Object.assign(this.uniforms, { uSeeded: { value: false }, uSeed: { value: null }, uSeedMask: { value: null }, uSeedScale: { value: 1 } });
    for (let k = 0; k < this.nTex; k++) this.uniforms['uF' + k] = { value: null };
    const mat = (fs) => new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: src.vertex, fragmentShader: fs, uniforms: this.uniforms, depthTest: false, depthWrite: false });
    this.mInit = mat(src.init);
    this.mLinks = mat(src.links);
    this.mStep = mat(src.step);
    this.mAcc = mat(src.acc);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(g, this.mInit);
    this.quad.frustumCulled = false;
    this.qScene = new THREE.Scene();
    this.qScene.add(this.quad);
    this.qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.job = null;
  }
  get total() { return this.T.warm + this.T.avg; }
  pass(mat, target) { this.quad.material = mat; WT_RENDERER.setRenderTarget(target); WT_RENDERER.render(this.qScene, this.qCam); }
  bind(rt) { for (let k = 0; k < this.nTex; k++) this.uniforms['uF' + k].value = rt.textures[k]; }
  // Start from the inlet wind everywhere, or from the averaged flow of a coarser tunnel's current run.
  begin(geo, fromDeg, seed = null, { center = WT_CENTER, voxels = null } = {}) {
    const frame = tunnelFrame(center, fromDeg, this.T);
    const vox = voxels || voxelize(geo, frame, this.T);
    this.maskTex.image.data.set(vox.atlas);
    this.maskTex.needsUpdate = true;
    if (this.uniforms.uSeeded) {
      this.uniforms.uSeeded.value = !!(seed && seed.job);
      if (seed && seed.job) {
        this.uniforms.uSeed.value = seed.avg[seed.job.acur].texture;
        this.uniforms.uSeedMask.value = seed.maskTex;
        this.uniforms.uSeedScale.value = 1 / Math.max(1, seed.job.samples);
      }
    }
    this.job = { geo, from: fromDeg, frame, grid: vox.grid, vox: vox.stats || null, step: 0, cur: 0, acur: 0, samples: 0, t0: performance.now() };
    this.pass(this.mLinks, this.links);
    this.pass(this.mInit, this.f[0]);
    const r = WT_RENDERER, cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const rt of this.avg) { r.setRenderTarget(rt); r.clear(true, false, false); }
    r.setClearColor(cc, ca);
    r.setRenderTarget(null);
    return this.job;
  }
  advance(n) {
    const j = this.job, T = this.T;
    if (!j) return 1;
    for (let s = 0; s < n && j.step < this.total; s++) {
      this.bind(this.f[j.cur]);
      this.pass(this.mStep, this.f[1 - j.cur]);
      j.cur = 1 - j.cur;
      j.step++;
      if (j.step > T.warm && j.step % T.every === 0) {
        this.bind(this.f[j.cur]);
        this.uniforms.uAvg.value = this.avg[j.acur].texture;
        this.pass(this.mAcc, this.avg[1 - j.acur]);
        j.acur = 1 - j.acur;
        j.samples++;
      }
    }
    WT_RENDERER.setRenderTarget(null);
    return j.step / this.total;
  }
  // The averaged flow as GPU textures, for ScalarSolver.begin (architecture §6.2). `avg` holds Σ lattice
  // velocity (u, v, w, |u|) over `samples`; divide by samples · uLattice for fractions of U10.
  flow() {
    const j = this.job;
    if (!j) return null;
    return { avg: this.avg[j.acur].texture, samples: j.samples, uLattice: U_LATTICE, mask: this.maskTex, T: this.T, frame: j.frame, grid: j.grid, from: j.from };
  }
  // The averaged flow, read back without stalling the page; the tunnel is free for the next run at once.
  async collect() {
    const j = this.job, T = this.T, buf = new Float32Array(T.W * T.H * 4);
    this.job = null;
    const read = WT_RENDERER.readRenderTargetPixelsAsync(this.avg[j.acur], 0, 0, T.W, T.H, buf);
    // three.js keeps its pixel-pack buffer bound until the read completes; unbind it so a synchronous
    // readPixels elsewhere in the page meanwhile is not redirected into it (three rebinds it to finish).
    try { const gl = WT_RENDERER.getContext(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); } catch (e) { /* no context */ }
    await read;
    return new WindField(j.from, j.frame, buf, j.grid, j.samples, T);
  }
  dispose() {
    for (const rt of [...this.f, ...this.avg, this.links]) rt.dispose();
    this.maskTex.dispose();
    for (const m of [this.mInit, this.mLinks, this.mStep, this.mAcc]) m.dispose();
    this.quad.geometry.dispose();
    this.job = null;
  }
}

// ------------------------------------------------------------------ the averaged flow on the CPU
/*
 * The averaged flow of one run, as fractions of U10 in tunnel axes (architecture §5.2):
 *   data[((z·ny + y)·nx + x)·4] = (u along ex, v along ey, w up, ⟨|u|⟩), mask = the voxel grid (Uint8Array),
 *   frame = the tunnel frame, T = the grid, samples = number of averaged steps.
 * The values right at the inlet are a few per cent below the profile: the city downstream holds the air back.
 */
class WindField {
  constructor(from, frame, buf, grid, samples, T) {
    const { nx, ny, nz, tx, W, dx } = T;
    Object.assign(this, { from, frame, mask: grid, nx, ny, nz, dx, T, samples, uLattice: U_LATTICE });
    const data = new Float32Array(nx * ny * nz * 4);
    const k = 1 / Math.max(samples, 1) / U_LATTICE;
    for (let z = 0; z < nz; z++) {
      const ox = (z % tx) * nx, oy = Math.floor(z / tx) * ny;
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const s = ((oy + y) * W + ox + x) * 4, d = ((z * ny + y) * nx + x) * 4;
        data[d] = buf[s] * k; data[d + 1] = buf[s + 1] * k; data[d + 2] = buf[s + 2] * k; data[d + 3] = buf[s + 3] * k;
      }
    }
    this.data = data;
    this.tmp = new Float32Array(4);
  }
  // Trilinear average over the fluid neighbours of a world point. Returns false outside the tunnel.
  sample(p, out) {
    const f = this.frame, dx = this.dx;
    const rx = p.x - f.origin.x, rz = p.z - f.origin.z;
    const gx = (rx * f.ex.x + rz * f.ex.z) / dx - 0.5, gy = (rx * f.ey.x + rz * f.ey.z) / dx - 0.5;
    const gz = clamp(p.y / dx - 0.5, 0, this.nz - 1.001);
    if (gx < 0 || gy < 0 || gx > this.nx - 1.001 || gy > this.ny - 1.001) return false;
    const i0 = Math.floor(gx), j0 = Math.floor(gy), k0 = Math.floor(gz);
    const tx = gx - i0, ty = gy - j0, tz = gz - k0;
    out[0] = out[1] = out[2] = out[3] = 0;
    let ws = 0;
    for (let c = 0; c < 8; c++) {
      const i = i0 + (c & 1), j = j0 + ((c >> 1) & 1), k = Math.min(this.nz - 1, k0 + (c >> 2));
      const q = (k * this.ny + j) * this.nx + i;
      if (this.mask[q] >= 250) continue;
      const w = (c & 1 ? tx : 1 - tx) * ((c >> 1) & 1 ? ty : 1 - ty) * (c >> 2 ? tz : 1 - tz);
      out[0] += w * this.data[q * 4]; out[1] += w * this.data[q * 4 + 1]; out[2] += w * this.data[q * 4 + 2]; out[3] += w * this.data[q * 4 + 3];
      ws += w;
    }
    if (ws > 1e-4) for (let a = 0; a < 4; a++) out[a] /= ws;
    return true;
  }
  solidAt(p) {
    const f = this.frame, dx = this.dx;
    const rx = p.x - f.origin.x, rz = p.z - f.origin.z;
    const i = Math.floor((rx * f.ex.x + rz * f.ex.z) / dx), j = Math.floor((rx * f.ey.x + rz * f.ey.z) / dx), k = Math.floor(p.y / dx);
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return false;
    return this.mask[(k * this.ny + j) * this.nx + i] >= 250;
  }
  // Mean speed felt at a point (resolved fluctuations included), as a fraction of U10; the inflow outside.
  speed(p) { return this.sample(p, this.tmp) ? this.tmp[3] : inflowProfile(p.y); }
  // Mean velocity in world axes, as a fraction of U10; the undisturbed inflow outside the tunnel.
  vel(p, out = new THREE.Vector3()) {
    const f = this.frame;
    if (!this.sample(p, this.tmp)) return out.copy(f.ex).multiplyScalar(inflowProfile(p.y));
    const t = this.tmp;
    return out.set(f.ex.x * t[0] + f.ey.x * t[1], t[2], f.ex.z * t[0] + f.ey.z * t[1]);
  }
}
