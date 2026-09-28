// ------------------------------------------------------------------ scene
/*
 * Renderer, scene graph root, lights, sky, fog, the shared material palette and the three small
 * geometry helpers every layer uses (docs/architecture.md §6.3, docs/12-rendering.md §2).
 *
 * The look is ported from the reference repo maksimir-pod-kisom (src/js/scene.js, © 2026 Ivan Rezić,
 * MIT): the same sand-grey ground, sage parks, light walls and warm roofs, ACES tone mapping, soft
 * PCF shadows from one sun, a hemisphere fill light and a gradient sky dome. What is new here:
 *   - setDaylight(dateUTC, cloud) moves the sun to its real position for the hour on screen (the
 *     reference had a fixed sun), dims it under cloud and at night, and keeps the scene legible;
 *   - the shadow frustum covers the whole ±500 m neighbourhood instead of one stadium;
 *   - ribbonGeometry() joins road segments with mitred corners, so 10–40 m wide carriageways
 *     (env.json roads[].w) do not overshoot at every vertex as the reference's per-segment quads do.
 *
 * Exports (shared module scope): canvas, renderer, scene, sun, hemi, sky, skyUniforms, M,
 * flatGeometry, ribbonGeometry, addMesh, timeUniform, setDaylight.
 * Private helpers carry the prefix sc_.
 */

// ------------------------------------------------------------------ renderer
// renderer is null only when the browser has no WebGL at all; every GPU module must then stand down
// (the UI shows the CPU fallback model, architecture §4.4). A missing float extension is handled by
// wind-tunnel.js (LBM.ok), not here.
const canvas = $('#gl') || (() => {
  const c = document.createElement('canvas');
  c.id = 'gl';
  document.body.appendChild(c);
  return c;
})();

const renderer = (() => {
  try {
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    // Pixel ratio capped at 1.75 as in the reference: two views share one full-window canvas, and a 3×
    // phone display would otherwise render 9× the pixels for no visible gain.
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.02;                 // reference value (maksimir-pod-kisom scene.js)
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    return r;
  } catch (e) {
    console.error('WebGL renderer could not be created', e);
    return null;
  }
})();

// A software rasteriser (SwiftShader, llvmpipe) is ~50× slower than a laptop GPU. It gets a smaller
// shadow map so interactive checks and headless tests stay usable (see docs/12-rendering.md §7).
const sc_SOFTWARE_GL = (() => {
  if (!renderer) return true;
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|software|softpipe/i.test(name);
  } catch (e) { return false; }
})();

// ------------------------------------------------------------------ scene, fog, environment light
const scene = new THREE.Scene();

// Sky colours (reference SKY table). "Dry" is the clear-sky pair, "wet" the overcast pair that the
// reference blended in with rain; here the blend weight is the cloud cover (setDaylight). The night
// pair is ours: a muted blue-grey, deliberately not black, because the 3D scene stays a daylight model
// whose job is legibility (architecture §7, theming).
const sc_SKY = {
  clearTop: new THREE.Color('#9fb6c8'), clearHorizon: new THREE.Color('#dde5e8'),
  greyTop: new THREE.Color('#6d7b86'), greyHorizon: new THREE.Color('#a9b3b8'),
  nightTop: new THREE.Color('#44536a'), nightHorizon: new THREE.Color('#8390a0'),
  duskHorizon: new THREE.Color('#e8cfb2'),
};

// Fog: the reference used 900–3600 m for a scene ±1.7 km wide. Our data covers ±750 m
// (SITE.extent.scene_half_m) and the "from the air" camera sits ~1 km out, so the fog starts at
// 1200 m and closes at 4200 m: the whole modelled neighbourhood stays crisp, the empty ground plane
// beyond it melts into the horizon.
const sc_FOG = { near: 1200, far: 4200 };
scene.fog = new THREE.Fog(sc_SKY.clearHorizon.clone(), sc_FOG.near, sc_FOG.far);
scene.background = sc_SKY.clearHorizon.clone();
if (renderer) {
  // RoomEnvironment reflections for the few MeshStandardMaterials (water, glass, steel); reference
  // values (blur 0.04, intensity 0.55).
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
}

// ------------------------------------------------------------------ lights
// One sun with soft shadows plus a sky/ground hemisphere fill. Colours and daytime intensities are the
// reference's (sun #fff4e2 at 2.1, hemisphere #eef3f6 / #5f6452 at 1.15); setDaylight() scales them.
const sc_LIGHT = { sun: 2.1, hemi: 1.15 };
const hemi = new THREE.HemisphereLight('#eef3f6', '#5f6452', sc_LIGHT.hemi);
const sun = new THREE.DirectionalLight('#fff4e2', sc_LIGHT.sun);

// The shadow camera is an orthographic box centred on the station. Half-size 520 m covers the LoD2
// radius (SITE.extent.lod2_radius_m = 500 m) plus a margin; far enough for the sun at 15° elevation
// (the lowest we draw, see setDaylight) to cast the 98 m tallest part (lidar-3d §3.2) across it.
// A 4096² map gives 0.25 m texels, sharp enough for street trees; 2048² (0.5 m) on software GL.
const sc_SHADOW = { half: 520, dist: 1100, far: 2600, size: sc_SOFTWARE_GL ? 2048 : 4096 };
sun.castShadow = true;
sun.shadow.mapSize.set(sc_SHADOW.size, sc_SHADOW.size);
Object.assign(sun.shadow.camera, {
  left: -sc_SHADOW.half, right: sc_SHADOW.half, top: sc_SHADOW.half, bottom: -sc_SHADOW.half, near: 50, far: sc_SHADOW.far,
});
// Bias values from the reference, scaled for the 2× larger texel (its frustum was ±250 m at 2048²).
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = sc_SHADOW.size >= 4096 ? 0.35 : 0.6;
sun.target.position.set(0, 0, 0);
scene.add(hemi, sun, sun.target);

// ------------------------------------------------------------------ sky dome
// A back-faced sphere with a vertical gradient (reference shader). It follows the camera of whichever
// view is being drawn (onBeforeRender below), so main.js does not need to move it per view.
const skyUniforms = { uTop: { value: sc_SKY.clearTop.clone() }, uHorizon: { value: sc_SKY.clearHorizon.clone() } };
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(7000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyUniforms,
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uTop; uniform vec3 uHorizon; varying vec3 vP;
      void main() {
        float h = clamp(vP.y * 2.2, 0.0, 1.0);
        gl_FragColor = vec4(mix(uHorizon, uTop, pow(h, 0.7)), 1.0);
        #include <colorspace_fragment>
      }`,
  }),
);
sky.renderOrder = -1;
sky.frustumCulled = false;
sky.onBeforeRender = (r, s, cam) => { sky.position.copy(cam.position); sky.updateMatrixWorld(); };
scene.add(sky);

// ------------------------------------------------------------------ shared animation clock
// Seconds of animation time; main.js advances it (and freezes it under prefers-reduced-motion).
// Shaders that animate (none in v1 besides the station beacon) read it as a uniform.
const timeUniform = { value: 0 };

// ------------------------------------------------------------------ materials
/*
 * The palette. Ground, park, water, asphalt, paving, gravel and tram are the reference's hex values;
 * the rest are additions, each chosen to stay in the same low-chroma family so that the data layers
 * (concentration slice, particles, streaks) are the only saturated things on screen.
 * Layered flat surfaces use polygonOffset (sc_flat) on top of small y offsets so that they never
 * z-fight from the "plan" camera 1 km up (24-bit depth at 1 km with near = 2 m resolves ~3 cm).
 */
function sc_flat(color, layer, extra = {}) {
  return new THREE.MeshLambertMaterial({ color, polygonOffset: true, polygonOffsetFactor: -layer, polygonOffsetUnits: -layer * 2, ...extra });
}
const M = {
  // ground layers (reference colours)
  ground: new THREE.MeshLambertMaterial({ color: '#d6d4cb' }),
  park: sc_flat('#c3d3aa', 1),
  grass: sc_flat('#b8cea0', 1),
  paved: sc_flat('#cbc6ba', 2),
  water: new THREE.MeshStandardMaterial({ color: '#6f94a6', roughness: 0.12, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }),
  // transport
  footway: sc_flat('#dcd8cd', 3),                 // lighter than the reference paving so paths read as paths
  cycleway: sc_flat('#c99a8e', 3),                // muted brick: the cycle tracks are red-surfaced (2022 orthophoto)
  gravel: sc_flat('#ddd2b6', 4),                  // reference "gravel", used for service roads
  asphalt: sc_flat('#8d9193', 5),                 // reference asphalt (tertiary, residential)
  asphaltMain: sc_flat('#80858a', 6),             // a step darker for primary/secondary: the arterials read first
  tramBed: sc_flat('#a7a197', 7),                 // tram reservation (ballast / concrete slab)
  tram: sc_flat('#5a5f63', 8),                    // reference tram-track colour
  railBed: sc_flat('#b3ab9c', 4),
  rail: sc_flat('#6d6862', 5),
  // buildings and trees
  buildings: new THREE.MeshLambertMaterial({ vertexColors: true }),
  buildingsXray: new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.28, depthWrite: false }),
  lod2: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  tree: new THREE.MeshLambertMaterial({ flatShading: true }),
  treeBare: new THREE.MeshLambertMaterial({ flatShading: true, transparent: true, opacity: 0.42, depthWrite: false }),
  trunk: new THREE.MeshLambertMaterial({ color: '#6b5a48' }),
  // scenario additions: a pale ochre "planning model" tint, so new volumes never pass for existing ones
  proposed: new THREE.MeshLambertMaterial({ color: '#f1cf9c' }),
  proposedEdge: new THREE.LineBasicMaterial({ color: '#8a5a1c', transparent: true, opacity: 0.55 }),
  // station
  container: new THREE.MeshStandardMaterial({ color: '#eceeed', roughness: 0.7 }),
  steel: new THREE.MeshStandardMaterial({ color: '#9aa4ab', roughness: 0.5, metalness: 0.6 }),
  inlet: new THREE.MeshBasicMaterial({ color: '#ffc21a', toneMapped: false }),
  beacon: new THREE.MeshBasicMaterial({ color: '#ffc21a', transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false }),
  // generic (reference)
  concrete: new THREE.MeshStandardMaterial({ color: '#d7d3ca', roughness: 0.92 }),
  white: new THREE.MeshStandardMaterial({ color: '#f4f4f1', roughness: 0.6 }),
  glass: new THREE.MeshStandardMaterial({ color: '#2f4e70', roughness: 0.15, metalness: 0.4 }),
  overlay: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -20 }),
};

// ------------------------------------------------------------------ flat ground layers
// Polygons [[x, z], ...] triangulated into one merged, upward-facing geometry at height y (reference).
// THREE.Shape lives in the x/y plane, so z is mirrored into −y and the result rotated flat.
function flatGeometry(polys, y) {
  const geos = [];
  for (const p of polys || []) {
    if (!p || p.length < 3) continue;
    const shape = new THREE.Shape(p.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    geos.push(g);
  }
  return geos.length ? mergeGeometries(geos) : null;
}

/*
 * Flat ribbons along polylines, e.g. roads with their carriageway width.
 *   lines:   array of polylines [[x, z], ...] or objects with a .p polyline
 *   widthOf: (line) => full width in metres
 *   y:       height of the ribbon
 * Interior vertices get a mitred join (offset along the bisector, length w/2 / cos(half-angle)); a turn
 * sharper than ~100° (mitre factor > sc_MITRE_LIMIT) falls back to a bevel so a hairpin cannot spike
 * out. Both ends are extended by 0.3·w, at most 3 m, which closes the gap where a way meets another
 * one at a T (the reference extended every segment by 0.3·w instead).
 * All triangles face up (+y); normals are constant (0, 1, 0).
 */
const sc_MITRE_LIMIT = 1.6;
function ribbonGeometry(lines, widthOf, y) {
  const pos = [];
  const tri = (a, b, c) => {
    // Keep the triangle counter-clockwise seen from above so its face normal is +y (reference test).
    const cy = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
    if (cy < 0) [b, c] = [c, b];
    pos.push(a[0], y, a[1], b[0], y, b[1], c[0], y, c[1]);
  };
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
  for (const L of lines || []) {
    const p = L && (L.p || L);
    if (!p || p.length < 2) continue;
    const hw = widthOf(L) / 2;
    if (!(hw > 0)) continue;
    // Drop repeated points; a zero-length segment has no direction.
    const q = [p[0]];
    for (let i = 1; i < p.length; i++) if (Math.hypot(p[i][0] - q[q.length - 1][0], p[i][1] - q[q.length - 1][1]) > 0.05) q.push(p[i]);
    if (q.length < 2) continue;
    const n = q.length;
    const dir = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = q[i + 1][0] - q[i][0], dz = q[i + 1][1] - q[i][1], len = Math.hypot(dx, dz);
      dir.push([dx / len, dz / len]);
    }
    const ext = Math.min(0.6 * hw, 3);
    // Left/right offset points per vertex; null marks a bevelled vertex.
    const left = [], right = [];
    for (let i = 0; i < n; i++) {
      let [x, z] = q[i];
      if (i === 0) { x -= dir[0][0] * ext; z -= dir[0][1] * ext; }
      if (i === n - 1) { x += dir[n - 2][0] * ext; z += dir[n - 2][1] * ext; }
      if (i === 0 || i === n - 1) {
        const d = dir[Math.min(i, n - 2)], nx = -d[1] * hw, nz = d[0] * hw;
        left.push([x + nx, z + nz]); right.push([x - nx, z - nz]);
        continue;
      }
      const a = dir[i - 1], b = dir[i];
      const bx = -(a[1] + b[1]), bz = a[0] + b[0], bl = Math.hypot(bx, bz);
      const cosHalf = bl / 2;                      // |a + b| / 2 = cos(turn / 2)
      if (bl < 1e-6 || 1 / cosHalf > sc_MITRE_LIMIT) { left.push(null); right.push(null); continue; }
      const m = hw / cosHalf;
      left.push([x + (bx / bl) * m, z + (bz / bl) * m]); right.push([x - (bx / bl) * m, z - (bz / bl) * m]);
    }
    for (let i = 0; i < n - 1; i++) {
      const d = dir[i], nx = -d[1] * hw, nz = d[0] * hw;
      const [x1, z1] = q[i], [x2, z2] = q[i + 1];
      const l1 = left[i] || [x1 + nx, z1 + nz], r1 = right[i] || [x1 - nx, z1 - nz];
      const l2 = left[i + 1] || [x2 + nx, z2 + nz], r2 = right[i + 1] || [x2 - nx, z2 - nz];
      quad(l1, l2, r2, r1);
      if (!left[i + 1] && i + 1 < n - 1) {
        // Bevel: fill the wedge between this segment's end and the next one's start on both sides.
        const e = dir[i + 1], mx = -e[1] * hw, mz = e[0] * hw;
        tri([x2, z2], [x2 + nx, z2 + nz], [x2 + mx, z2 + mz]);
        tri([x2, z2], [x2 - nx, z2 - nz], [x2 - mx, z2 - mz]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

// Wrap a geometry in a mesh and add it to a parent (default: the scene). shadow = 'receive' | 'cast' |
// 'both' | 'none'. Returns null for an empty geometry, so callers can pass a null from flatGeometry().
function addMesh(geo, mat, { shadow = 'receive', parent = scene, order } = {}) {
  if (!geo) return null;
  const pa = geo.getAttribute && geo.getAttribute('position');
  if (!pa || pa.count === 0) return null;
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = shadow === 'receive' || shadow === 'both';
  m.castShadow = shadow === 'cast' || shadow === 'both';
  if (order !== undefined) m.renderOrder = order;
  parent.add(m);
  return m;
}

// ------------------------------------------------------------------ sun position
/*
 * Apparent solar position for a UTC instant at (lat, lon), degrees.
 * Low-precision formulas of the U.S. Naval Observatory ("Approximate Solar Coordinates"), good to
 * about 1 arcminute within two centuries of 2000, then the standard equatorial → horizontal conversion.
 * meteo.js owns solarElevation() for the stability class; the scene uses it for the elevation when it
 * exists (so the sun on screen and the stability class agree) and this function for the azimuth,
 * which meteo.js does not provide.
 * Returns { el, az } with az clockwise from north (the same convention as wind directions).
 */
function sc_sunPosition(date, lat, lon) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;          // days from J2000.0
  const g = (357.529 + 0.98560028 * d) * DEG;                            // mean anomaly
  const q = 280.459 + 0.98564736 * d;                                    // mean longitude, deg
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;   // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * DEG;                             // obliquity of the ecliptic
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = wrap360((18.697374558 + 24.06570982441908 * d) * 15);    // Greenwich mean sidereal time, deg
  const H = (gmst + lon) * DEG - ra;                                     // local hour angle
  const phi = lat * DEG;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { el: el / DEG, az: wrap360(az / DEG) };
}

/*
 * Put the sun where it is at `dateUTC` (a Date or epoch ms) under `cloud` cover (0–1, or 0–100 %
 * as Open-Meteo reports it), and set the sky, fog and fill light to match.
 *
 *   - Direction: the true azimuth; the elevation used for the *light* is max(true, 15°). At 5° a 30 m
 *     slab throws a 340 m shadow and the streets vanish in it; 15° still reads as "low evening sun"
 *     (shadow ≈ 3.7 H) while keeping the ground visible.
 *   - Intensity: full reference sun (2.1) above 20°, fading to 0 at −4° (civil twilight is −6°; the
 *     sky stays bright a little after sunset) and scaled by (1 − 0.7·cloud). The 0.7 keeps a trace of
 *     direction under overcast, as the reference kept 0.55/2.1 ≈ 26 % under heavy rain.
 *   - Night (true elevation below −6°): a weak, cool, shadowless key from high up plus a brighter
 *     hemisphere, so the city stays readable. The scene is a daylight model (architecture §7).
 *   - Sky: clear → grey by cloud (the reference's rain blend), warm horizon at dusk, blue-grey at night.
 * Returns { el, az, lightEl, night } in degrees for the UI.
 */
function setDaylight(dateUTC, cloud = 0) {
  const date = dateUTC instanceof Date ? dateUTC : new Date(Number.isFinite(dateUTC) ? dateUTC : Date.now());
  let c = Number.isFinite(cloud) ? cloud : 0;
  if (c > 1) c /= 100;
  c = clamp(c, 0, 1);
  const lat = SITE.station.lat, lon = SITE.station.lon;
  const pos = sc_sunPosition(date, lat, lon);
  let el = pos.el;
  if (typeof solarElevation === 'function') {
    const e = solarElevation(date, lat, lon);
    if (Number.isFinite(e)) el = e;
  }
  const night = el < -6;
  const dayK = smoothstep(-4, 20, el);                    // 0 at night … 1 in full day
  const duskK = night ? 0 : clamp(1 - Math.abs(el - 3) / 12, 0, 1);  // peaks near sunrise/sunset
  const lightEl = night ? 55 : Math.max(el, 15);
  const lightAz = night ? 200 : pos.az;                   // "moonlight" from the SSW when the sun is down
  const b = lightAz * DEG, e = lightEl * DEG;
  const dir = new THREE.Vector3(Math.sin(b) * Math.cos(e), Math.sin(e), -Math.cos(b) * Math.cos(e));
  sun.position.copy(sun.target.position).addScaledVector(dir, sc_SHADOW.dist);
  sun.updateMatrixWorld();

  const nightSun = 0.35, nightHemi = 1.0;                  // legibility floors (see comment above)
  sun.intensity = lerp(nightSun, sc_LIGHT.sun * (1 - 0.7 * c), dayK);
  sun.castShadow = !night;
  sun.color.set('#fff4e2').lerp(new THREE.Color('#ffc58f'), duskK * 0.6).lerp(new THREE.Color('#b8c6e0'), 1 - dayK);
  hemi.intensity = lerp(nightHemi, sc_LIGHT.hemi * (1 + 0.35 * c), dayK);

  const top = sc_SKY.clearTop.clone().lerp(sc_SKY.greyTop, c).lerp(sc_SKY.nightTop, 1 - dayK);
  const hor = sc_SKY.clearHorizon.clone().lerp(sc_SKY.greyHorizon, c).lerp(sc_SKY.duskHorizon, duskK * (1 - c) * 0.7).lerp(sc_SKY.nightHorizon, 1 - dayK);
  skyUniforms.uTop.value.copy(top);
  skyUniforms.uHorizon.value.copy(hor);
  scene.fog.color.copy(hor);
  scene.background.copy(hor);
  // Overcast shortens the view a little (reference: 900→320 m near under rain; we only go to 70 %).
  scene.fog.near = lerp(sc_FOG.near, sc_FOG.near * 0.7, c);
  scene.fog.far = lerp(sc_FOG.far, sc_FOG.far * 0.8, c);
  if (renderer) renderer.toneMappingExposure = lerp(1.1, 1.02, dayK) * (1 + 0.08 * c);
  return { el, az: pos.az, lightEl, night };
}

// Start with a fixed, flattering sun (south-west, 45°: the reference's direction) until the UI sets
// the hour. setDaylight() replaces it.
sun.position.set(-240, 420, 260).normalize().multiplyScalar(sc_SHADOW.dist);

I18N.add({
  hr: { 'scene.noWebGL': 'Preglednik ne podržava WebGL, pa se 3D prikaz ne može nacrtati.' },
  en: { 'scene.noWebGL': 'This browser does not support WebGL, so the 3D view cannot be drawn.' },
});
