// ------------------------------------------------------------------ visuals
/*
 * What the simulation looks like in 3D (docs/architecture.md §6.3, docs/12-rendering.md §6):
 *   - concentration colour scales (CONC_SCALES, concColor, concBand, legendHTML);
 *   - ConcSlice: a horizontal cut through a ScalarField at a chosen height, in the tunnel frame;
 *   - Particles: display-only tracers released along the source roads (and heating areas) in
 *     proportion to their emission, carried by the simulated wind plus a random walk;
 *   - WindStreaks and LabelLayer, ported from the reference maksimir-pod-kisom (src/js/visuals.js,
 *     © 2026 Ivan Rezić, MIT) with a field-agnostic signature.
 *
 * Every data overlay here is drawn without tone mapping (toneMapped: false) and unlit, so the colour
 * on screen at full opacity is exactly the legend colour. The reference's wind slice went through
 * ACES, which shifts hues; a legend has to match.
 *
 * One scene, two views: each view needs its own ConcSlice / Particles / WindStreaks (they hold one
 * field each). Give each view a parent group and show only that view's group while drawing it (the
 * same way cityView() switches the city). Private helpers carry the prefix vis_.
 */

// ------------------------------------------------------------------ colour scales
/*
 * Bands. For NO2, PM10, PM2.5, O3 and SO2 the break points are the revised EEA European Air Quality
 * Index (ETC HE Report 2024/17), hourly µg/m³, as tabulated in iszz-api §9.3. They are read from
 * chemistry.js EAQI_BANDS when that module provides them (the models owner keeps the index in one
 * place) and fall back to the same table here.
 * NOx, CO and benzene have no EAQI band (iszz-api §9.3: "colour them against the limit value …
 * using a sequential ramp"):
 *   NOx   25, 50, 100, 200, 400 µg/m³: doubling steps from the ZAGREB-4 background (night hours
 *         ~16 µg/m³) to rush-hour ZAGREB-1 values (weekday 07 h mean 135 µg/m³, critic §1.2) and the
 *         peaks above; no health limit exists for NOx, so the bands are unnamed ranges;
 *   CO    0.5, 1, 2, 4, 10 mg/m³: 4 = AAQD 2024/2881 24-h limit, 10 = 8-h limit (iszz-api §9.1);
 *   C6H6  0.5, 1, 1.7, 3.4, 5 µg/m³: 1.7 = assessment threshold and WHO 1:100 000 lifetime risk,
 *         3.4 = 2030 annual limit, 5 = current annual limit (iszz-api §9.1).
 */
const vis_EAQI_TABLE = {
  pm25: [5, 15, 50, 90, 140], pm10: [15, 45, 120, 195, 270], no2: [10, 25, 60, 100, 150],
  o3: [60, 100, 120, 160, 180], so2: [20, 40, 125, 190, 275],
};
const vis_OTHER_TABLE = { nox: [25, 50, 100, 200, 400], co: [0.5, 1, 2, 4, 10], c6h6: [0.5, 1, 1.7, 3.4, 5] };
/*
 * Palettes, both six colours, band 1 (cleanest) first.
 *   'cb' (default): one hue (violet, OKLCH h = 310°), lightness stepping 0.68 → 0.305 in equal steps.
 *        Built for colour-blind safety: the order is carried by lightness alone, which protanopes,
 *        deuteranopes and tritanopes all see. Checked with the dataviz skill's validator as an
 *        ordinal ramp: monotone L, every adjacent ΔL ≥ 0.06, single hue, light end ≥ 2:1 against
 *        both the page (#fcfcfb, 3.0:1) and the 3D ground (#d6d4cb, 2.1:1). Violet is used nowhere
 *        else in the scene, so the slice never blends into roofs, grass or roads.
 *   'eaqi': the official EEA colours (iszz-api §9.3), for comparison with airindex.eea.europa.eu
 *        and the ISZZ portal. Their lightness is not monotone (yellow band 3 is lighter than teal
 *        band 2), so the legend always prints the band names too.
 */
const vis_PALETTES = {
  cb: ['#b679e1', '#9f62c8', '#884baf', '#723497', '#5c1c80', '#460067'],
  eaqi: ['#50F0E6', '#50CCAA', '#F0E641', '#FF5050', '#960032', '#7D2181'],
};
// Opacity per band on the slice (0–255): clean air is a faint veil, polluted air nearly opaque, so the
// eye goes where the concentration is and the city stays readable under a clean slice (design choice).
// Band 1–2 stay below 40 % because with a real background (NO2 ≈ 20 µg/m³ at ZAGREB-4, band 2) most
// of the domain sits there; a heavier veil hid the streets in the visual check (docs/12-rendering.md §7).
const vis_BAND_ALPHA = [56, 96, 140, 180, 208, 228];

I18N.add({
  hr: {
    'scene.band.1': 'Dobro', 'scene.band.2': 'Prihvatljivo', 'scene.band.3': 'Umjereno',
    'scene.band.4': 'Loše', 'scene.band.5': 'Vrlo loše', 'scene.band.6': 'Izuzetno loše',
    'scene.legend.eaqi': 'razredi Europskog indeksa kvalitete zraka (EEA 2024), satne vrijednosti',
    'scene.legend.limit': 'nema europskog indeksa; razredi prema graničnim vrijednostima',
    'scene.legend.range': 'nema europskog indeksa ni zdravstvene granice; razredi obuhvaćaju izmjerene vrijednosti na postaji',
    'scene.legend.over': '> {lo}',
    'scene.legend.particles': 'Čestice po izvoru (samo prikaz)',
    'scene.legend.particles.note': 'Čestice se puštaju razmjerno emisiji svakog izvora i nose ih izračunati vjetar i turbulencija. Ne prikazuju koncentraciju.',
    'scene.pol.c6h6': 'benzen',
  },
  en: {
    'scene.band.1': 'Good', 'scene.band.2': 'Fair', 'scene.band.3': 'Moderate',
    'scene.band.4': 'Poor', 'scene.band.5': 'Very poor', 'scene.band.6': 'Extremely poor',
    'scene.legend.eaqi': 'bands of the European Air Quality Index (EEA 2024), hourly values',
    'scene.legend.limit': 'no European index; bands follow the limit values',
    'scene.legend.range': 'no European index or health limit; bands span the values measured at the station',
    'scene.legend.over': '> {lo}',
    'scene.legend.particles': 'Particles by source (display only)',
    'scene.legend.particles.note': 'Particles are released in proportion to each source’s emission and carried by the computed wind and turbulence. They do not show concentration.',
    'scene.pol.c6h6': 'benzene',
  },
});

// Read EAQI break points for one pollutant from chemistry.js if it offers them, in any of the shapes a
// band table commonly takes: [10, 25, …], [{hi|max|to|upper}, …], [[lo, hi], …], {breaks|bands|'1h': …}.
// Returns {breaks: [5 numbers], colors: [6]|null} or null.
function vis_eaqiFromChemistry(p) {
  if (typeof EAQI_BANDS === 'undefined' || !EAQI_BANDS) return null;
  try {
    let e = EAQI_BANDS[p] || EAQI_BANDS[p.toUpperCase()] || (EAQI_BANDS.eea2024 || EAQI_BANDS.eea || EAQI_BANDS.bands || {})[p];
    if (e && !Array.isArray(e)) e = e.breaks || e.bands || e['1h'] || e.hourly || e.levels;
    if (!Array.isArray(e)) return null;
    const his = e.map((x) => (typeof x === 'number' ? x
      : Array.isArray(x) ? x[1]
        : x && (x.hi ?? x.max ?? x.to ?? x.upper ?? x.high)));
    const colors = e.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? x.color || x.colour : null));
    let nums = his.filter((v) => Number.isFinite(v));
    if (nums.length === 6) nums = nums.slice(0, 5);            // six upper bounds: drop the open top band
    if (nums.length !== 5 || nums.some((v, i) => i && v <= nums[i - 1])) return null;
    return { breaks: nums, colors: colors.filter(Boolean).length === 6 ? colors : null };
  } catch (err) { return null; }
}

// '#rrggbb' → [r, g, b] sRGB bytes (the DataTexture is tagged sRGB, so bytes go in unconverted).
function vis_hexBytes(h) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(h).trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [128, 128, 128];
}

function vis_pollutantInfo(p) {
  const units = { co: 'mg/m³' };
  const labels = { nox: 'NOx', no2: 'NO₂', pm10: 'PM₁₀', pm25: 'PM₂.₅', co: 'CO', c6h6: 'C₆H₆', o3: 'O₃', so2: 'SO₂' };
  let info = null;
  if (typeof POLLUTANT_INFO !== 'undefined' && POLLUTANT_INFO && POLLUTANT_INFO[p]) info = POLLUTANT_INFO[p];
  const label = info && info.label ? (typeof info.label === 'string' && I18N.has(info.label) ? t(info.label) : info.label) : labels[p] || p;
  return { unit: (info && info.unit) || units[p] || 'µg/m³', label };
}

/*
 * CONC_SCALES[pollutant] = { pollutant, basis: 'eaqi'|'limit'|'range', breaks: [5 upper bounds],
 *   names: [6 i18n keys] | null, source, palette, colors: [6 hex], rgb: [6 [r,g,b]], version }.
 * Values are in the pollutant's display unit (µg/m³; CO in mg/m³, architecture §2).
 */
const CONC_SCALES = {};
let vis_palette = 'cb';
function vis_buildScales() {
  for (const p of ['nox', 'no2', 'pm10', 'pm25', 'co', 'c6h6', 'o3', 'so2']) {
    const chem = vis_EAQI_TABLE[p] ? vis_eaqiFromChemistry(p) : null;
    const eaqi = !!vis_EAQI_TABLE[p];
    const breaks = chem ? chem.breaks : eaqi ? vis_EAQI_TABLE[p] : vis_OTHER_TABLE[p];
    const colors = (vis_palette === 'eaqi' && chem && chem.colors) ? chem.colors : vis_PALETTES[vis_palette];
    const prev = CONC_SCALES[p];
    CONC_SCALES[p] = {
      pollutant: p, basis: eaqi ? 'eaqi' : p === 'nox' ? 'range' : 'limit', breaks: breaks.slice(),
      names: eaqi ? [1, 2, 3, 4, 5, 6].map((k) => `scene.band.${k}`) : null,
      source: chem ? 'chemistry.js EAQI_BANDS' : eaqi ? 'EEA 2024 (iszz-api §9.3)' : 'docs/12-rendering.md §6.1',
      palette: vis_palette, colors: colors.slice(),
      rgb: colors.map(vis_hexBytes),
      version: prev ? prev.version + 1 : 1,
    };
  }
}
vis_buildScales();

// Switch the slice palette ('cb' default, 'eaqi' official); returns the active name.
function setConcPalette(name) {
  if (vis_PALETTES[name] && name !== vis_palette) { vis_palette = name; vis_buildScales(); }
  return vis_palette;
}

// Band 1..6 of a value (a value equal to a break point falls in the upper band); 0 for NaN.
function concBand(value, scale) {
  const s = typeof scale === 'string' ? CONC_SCALES[scale] : scale;
  if (!s || !Number.isFinite(value)) return 0;
  let b = 1;
  for (const br of s.breaks) if (value >= br) b++;
  return b;
}

// Colour of a value: out = [r, g, b, a] in 0–255 (sRGB bytes, alpha per band). Returns out.
// A non-finite value gives a fully transparent [0, 0, 0, 0].
function concColor(value, scale, out = new Uint8ClampedArray(4)) {
  const s = typeof scale === 'string' ? CONC_SCALES[scale] : scale;
  const b = s ? concBand(value, s) : 0;
  if (!b) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
  const c = s.rgb[b - 1];
  out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = vis_BAND_ALPHA[b - 1];
  return out;
}

const vis_esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Legend for one pollutant as HTML: title with unit, one row per band (swatch + range + band name for
// EAQI pollutants), and a note saying where the bands come from. The swatch is decorative; the text
// carries the meaning (architecture §7).
function legendHTML(pollutant) {
  const s = CONC_SCALES[pollutant] || CONC_SCALES.no2;
  const info = vis_pollutantInfo(s.pollutant);
  const dec = s.breaks[0] < 1 ? 1 : 0;
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const lo = i ? s.breaks[i - 1] : 0, hi = s.breaks[i];
    const range = i < 5 ? `${fmt(lo, lo % 1 ? dec : 0)}–${fmt(hi, hi % 1 ? dec : 0)}` : t('scene.legend.over', { lo: fmt(lo, lo % 1 ? dec : 0) });
    const name = s.names ? ` <span class="legend-name">${vis_esc(t(s.names[i]))}</span>` : '';
    rows.push(`<li><span class="legend-swatch" style="background:${s.colors[i]}" aria-hidden="true"></span><span class="legend-range">${vis_esc(range)}</span>${name}</li>`);
  }
  const note = t(s.basis === 'eaqi' ? 'scene.legend.eaqi' : s.basis === 'range' ? 'scene.legend.range' : 'scene.legend.limit');
  return `<div class="legend legend-conc" data-pollutant="${s.pollutant}"><p class="legend-title">${vis_esc(info.label)} · ${vis_esc(info.unit)}</p>`
    + `<ul>${rows.join('')}</ul><p class="legend-note">${vis_esc(note)}</p></div>`;
}

// Legend for the particle colours (source groups A–D, CITY_SOURCE_GROUPS in city.js).
function particleLegendHTML() {
  const rows = CITY_SOURCE_GROUPS.map((g) => `<li><span class="legend-swatch legend-dot" style="background:${g.color}" aria-hidden="true"></span>${vis_esc(t(g.label))}</li>`);
  return `<div class="legend legend-particles"><p class="legend-title">${vis_esc(t('scene.legend.particles'))}</p><ul>${rows.join('')}</ul>`
    + `<p class="legend-note">${vis_esc(t('scene.legend.particles.note'))}</p></div>`;
}

// ------------------------------------------------------------------ frames
// A tunnel frame's vectors may be THREE.Vector3 or plain {x, y, z}; normalise to Vector3.
function vis_v3(v) { return v instanceof THREE.Vector3 ? v : new THREE.Vector3(v.x || 0, v.y || 0, v.z || 0); }

// ------------------------------------------------------------------ concentration slice
/*
 * ConcSlice(parent): a horizontal plane in the tunnel frame of a field, textured with one texel per
 * cell and coloured by concColor.
 *
 * update(field, valueFn, heightM, visible, scale)
 *   field    a ScalarField (scalar.js) or anything with {frame: {origin, ex, ey}, dx, nx, ny, nz?,
 *            mask?, slice(h) → {nx, ny, data, stride?}}; data holds per cell γ_A..γ_D then (stride 8)
 *            the ages A_A..A_D. A field without slice() but with gamma/age arrays is sliced here.
 *            ConcSlice.gridField() wraps a world-aligned grid such as FallbackModel.slice().
 *   valueFn  (gamma4, age4) → value in display units (µg/m³, CO mg/m³); e.g. model.js cellValue.
 *            age4 is null for stride-4 data. Pass the same function object until its inputs change:
 *            the texture is rebuilt only when field, height, valueFn or scale change.
 *   heightM  slice height above ground (m); cells inside buildings (mask 255) are transparent.
 *   scale    a CONC_SCALES entry or a pollutant key.
 * Edges fade over vis_SLICE_FADE_M: the outer cells feel the boundary conditions (zero at the inflow,
 * open sides, the 80 m outflow sponge, critic §4.4), so they are shown faintly rather than cut hard.
 * Returns true when the texture was rebuilt.
 */
const vis_SLICE_FADE_M = 80;
class ConcSlice {
  constructor(parent) {
    this.parent = parent || scene;
    this.mesh = null;
    this.g4 = new Float32Array(4);
    this.a4 = new Float32Array(4);
    this.rgba = new Uint8ClampedArray(4);
    this.stats = null;
  }
  _ensure(nx, ny, dx) {
    if (this.mesh && this.nx === nx && this.ny === ny && this.dx === dx) return;
    if (this.mesh) { this.parent.remove(this.mesh); this.mesh.geometry.dispose(); this.tex.dispose(); }
    this.nx = nx; this.ny = ny; this.dx = dx;
    this.data = new Uint8Array(nx * ny * 4);
    this.tex = new THREE.DataTexture(this.data, nx, ny, THREE.RGBAFormat);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.magFilter = this.tex.minFilter = THREE.LinearFilter;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(nx * dx, ny * dx),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false }));
    this.mesh.renderOrder = 4;
    this.mesh.name = 'conc-slice';
    this.parent.add(this.mesh);
  }
  invalidate() { this.f = null; }
  update(field, valueFn, heightM, visible, scale) {
    const show = !!(visible && field && typeof valueFn === 'function');
    if (this.mesh) this.mesh.visible = show;
    if (!show) return false;
    const s = typeof scale === 'string' ? CONC_SCALES[scale] : scale || CONC_SCALES.no2;
    const h = clamp(+heightM || 4, 0.5, 1e4);
    if (field === this.f && h === this.h && valueFn === this.fn && s === this.s && s.version === this.sv) return false;
    const sl = typeof field.slice === 'function' ? field.slice(h) : vis_sliceArrays(field, h);
    if (!sl || !sl.data) return false;
    const nx = sl.nx, ny = sl.ny, stride = sl.stride || Math.round(sl.data.length / (nx * ny));
    const dx = field.dx || (field.T && field.T.dx) || 5;
    this._ensure(nx, ny, dx);
    this.mesh.visible = true;
    Object.assign(this, { f: field, h, fn: valueFn, s, sv: s.version });
    const nz = field.nz || (field.T && field.T.nz) || 0;
    const mask = field.mask && field.mask.length >= nx * ny * Math.max(nz, 1) ? field.mask : null;
    const k = clamp(Math.floor(h / dx), 0, Math.max(0, nz - 1));
    const fadeCells = vis_SLICE_FADE_M / dx;
    const { g4, a4, rgba, data } = this;
    let vmin = Infinity, vmax = -Infinity;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i, o = c * 4;
      if (mask && mask[(k * ny + j) * nx + i] >= 250) { data[o + 3] = 0; continue; }
      const base = c * stride;
      for (let q = 0; q < 4; q++) g4[q] = sl.data[base + q];
      if (stride >= 8) for (let q = 0; q < 4; q++) a4[q] = sl.data[base + 4 + q];
      const v = valueFn(g4, stride >= 8 ? a4 : null);
      if (Number.isFinite(v)) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
      concColor(v, s, rgba);
      const edge = Math.min(i + 0.5, nx - i - 0.5, j + 0.5, ny - j - 0.5);
      data[o] = rgba[0]; data[o + 1] = rgba[1]; data[o + 2] = rgba[2];
      data[o + 3] = Math.round(rgba[3] * smoothstep(0, fadeCells, edge));
    }
    this.tex.needsUpdate = true;
    this.stats = { min: vmin, max: vmax, h };
    const fr = field.frame, ex = vis_v3(fr.ex), ey = vis_v3(fr.ey), org = vis_v3(fr.origin);
    const n = new THREE.Vector3().crossVectors(ex, ey);
    this.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ex, ey, n));
    this.mesh.position.copy(org).addScaledVector(ex, (nx * dx) / 2).addScaledVector(ey, (ny * dx) / 2);
    this.mesh.position.y = h;
    return true;
  }
  dispose() { if (this.mesh) { this.parent.remove(this.mesh); this.mesh.geometry.dispose(); this.tex.dispose(); this.mesh = null; } }
  /*
   * Wrap a world-aligned grid as a field for update(): grid {x0, z0, dx, nx, nz} with (x0, z0) the
   * corner of cell (0, 0), cells along +x (i) and +z (j); data per cell γ_A..γ_D (stride 4) or
   * γ then ages (stride 8), e.g. the Float32Array from FallbackModel.slice().
   */
  static gridField(grid, data, stride = 4) {
    return {
      frame: { origin: new THREE.Vector3(grid.x0, 0, grid.z0), ex: new THREE.Vector3(1, 0, 0), ey: new THREE.Vector3(0, 0, 1) },
      dx: grid.dx, nx: grid.nx, ny: grid.nz, nz: 0, mask: null,
      slice: () => ({ nx: grid.nx, ny: grid.nz, data, stride }),
    };
  }
}

// Slice a field that has gamma/age arrays but no slice(): linear between the two layers around h
// (cell centres at (k + 0.5)·dx), cell layout (k·ny + j)·nx + i as the wind field (architecture §5.1).
function vis_sliceArrays(field, h) {
  const { nx, ny, nz, dx } = field;
  if (!field.gamma || !nx || !ny || !nz) return null;
  const kz = clamp(h / dx - 0.5, 0, nz - 1.001), k0 = Math.floor(kz), w = kz - k0;
  const data = new Float32Array(nx * ny * 8);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const q0 = (k0 * ny + j) * nx + i, q1 = q0 + nx * ny, o = (j * nx + i) * 8;
    for (let a = 0; a < 4; a++) {
      data[o + a] = lerp(field.gamma[q0 * 4 + a], field.gamma[q1 * 4 + a], w);
      data[o + 4 + a] = field.age ? lerp(field.age[q0 * 4 + a], field.age[q1 * 4 + a], w) : 0;
    }
  }
  return { nx, ny, data, stride: 8 };
}

// ------------------------------------------------------------------ tracer particles
/*
 * Particles(parent, env): display-only tracers.
 *   Release: from the source groups of architecture §5.3, in proportion to emission. A road segment's
 *     weight is length × aadt / aadt_unit (the same unit voxel.js rasterises), a heating triangle's
 *     is area × w; each is multiplied by the group's strength q_k from setStrengths() (default
 *     A = B = C = 1, D = 0, i.e. equal per-vehicle emission and heating off). With q_k from
 *     emissions.js groupStrengths() the weights become g/s, so the colour mix on screen is the
 *     emission mix. Roads release across the carriageway width at 0.5–2 m, heating at roof level
 *     (8 m, architecture §5.3). Only sources inside the field's tunnel are used.
 *   Motion: dp = u(p)·U10·dt + √(2 K dt) ξ, with u = WindField.vel (fraction of U10, world axes) and
 *     the neutral K-theory diffusivity of physics §4 eq. 4.2, K = κ û* U10 (max(z, H̄) − d), with
 *     κ = 0.4, û* = 0.162 (physics §6.2 neutral example), H̄ = 14 m, d = 7 m (SITE.model_defaults).
 *     Time runs vis_PARTICLES.speedup = 6× faster than real (1 s on screen = 6 s of flow), so a
 *     parcel moving at 0.5 m/s is visibly moving; lifetimes of 15–30 screen seconds (90–180 s of
 *     flow) cover the ~60 s plume age typical at the receptor (critic §4.4).
 *   Colour tells the group (CITY_SOURCE_GROUPS); opacity fades in at release and out with age.
 * update(dt, windField, u10, visible): dt in screen seconds. Frozen under prefers-reduced-motion.
 */
const vis_PARTICLES = { n: 4000, speedup: 6, life: [15, 30], size: 1.6, ustarHat: 0.162, heatY: 8 };
class Particles {
  constructor(parent, env = ENV, opts = {}) {
    this.parent = parent || scene;
    this.n = opts.n || vis_PARTICLES.n;
    this.p = new Float32Array(this.n * 3);
    this.age = new Float32Array(this.n);
    this.life = new Float32Array(this.n);
    this.grp = new Uint8Array(this.n);
    this.alive = new Uint8Array(this.n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.n * 3), 3));
    g.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(this.n), 1));
    this.geo = g;
    this.uniforms = { uSize: { value: vis_PARTICLES.size }, uScale: { value: 400 } };
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: this.uniforms,
      vertexShader: `uniform float uSize; uniform float uScale; attribute float alpha; attribute vec3 color;
        varying vec3 vC; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(uSize * uScale / -mv.z, 2.0, 10.0);
          vC = color; vA = alpha;
        }`,
      fragmentShader: `varying vec3 vC; varying float vA;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d);
          if (r > 0.25 || vA < 0.01) discard;
          gl_FragColor = vec4(vC, vA * smoothstep(0.25, 0.12, r));
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.points.visible = false;
    this.points.name = 'particles';
    // Point size in pixels = uSize · (projection scale × viewport height / 2) / depth, set per view.
    const vp = new THREE.Vector4();
    this.points.onBeforeRender = (r, s, cam) => {
      r.getCurrentViewport(vp);
      this.uniforms.uScale.value = cam.projectionMatrix.elements[5] * vp.w / 2;
    };
    this.parent.add(this.points);
    this.groupColors = CITY_SOURCE_GROUPS.map((gr) => new THREE.Color(gr.color));
    this.strength = { A: 1, B: 1, C: 1, D: 0 };
    this.sources = vis_sources(env);
    this.cdf = null;
    this.field = null;
    this.v = new THREE.Vector3();
    this.q = new THREE.Vector3();
  }
  // Group strengths q_k (any consistent unit, e.g. groupStrengths() for the pollutant on screen).
  setStrengths(q) {
    for (const k of ['A', 'B', 'C', 'D']) if (q && Number.isFinite(q[k])) this.strength[k] = Math.max(0, q[k]);
    this.cdf = null;
  }
  _cdf(field) {
    const fr = field.frame, org = vis_v3(fr.origin), ex = vis_v3(fr.ex), ey = vis_v3(fr.ey);
    const Lx = field.nx * field.dx, Ly = field.ny * field.dx;
    const inside = (x, z) => {
      const rx = x - org.x, rz = z - org.z, a = rx * ex.x + rz * ex.z, b = rx * ey.x + rz * ey.z;
      return a > 0 && a < Lx && b > 0 && b < Ly;
    };
    const list = [], acc = [];
    let sum = 0;
    for (const s of this.sources) {
      const w = s.w * (this.strength[s.g] || 0);
      if (!(w > 0) || !inside(s.cx, s.cz)) continue;
      sum += w; list.push(s); acc.push(sum);
    }
    this.cdf = { list, acc: Float64Array.from(acc), sum, gIndex: { A: 0, B: 1, C: 2, D: 3 } };
  }
  _spawn(i) {
    const c = this.cdf;
    if (!c || !c.list.length) { this.alive[i] = 0; return; }
    const u = rand() * c.sum;
    let lo = 0, hi = c.acc.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (c.acc[m] < u) lo = m + 1; else hi = m; }
    const s = c.list[lo];
    let x, y, z;
    if (s.tri) {
      // uniform point in a triangle (heating area)
      let a = rand(), b = rand();
      if (a + b > 1) { a = 1 - a; b = 1 - b; }
      x = s.ax + (s.bx - s.ax) * a + (s.qx - s.ax) * b;
      z = s.az + (s.bz - s.az) * a + (s.qz - s.az) * b;
      y = vis_PARTICLES.heatY;
    } else {
      const f = rand(), off = (rand() * 2 - 1) * s.hw;
      x = s.ax + (s.bx - s.ax) * f + s.nx * off;
      z = s.az + (s.bz - s.az) * f + s.nz * off;
      y = 0.5 + rand() * 1.5;
    }
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.age[i] = 0;
    this.life[i] = lerp(vis_PARTICLES.life[0], vis_PARTICLES.life[1], rand());
    this.grp[i] = c.gIndex[s.g];
    this.alive[i] = 1;
    const col = this.geo.getAttribute('color').array, gc = this.groupColors[this.grp[i]];
    col[i * 3] = gc.r; col[i * 3 + 1] = gc.g; col[i * 3 + 2] = gc.b;
  }
  update(dt, windField, u10, visible) {
    const show = !!(visible && windField && typeof windField.vel === 'function');
    this.points.visible = show;
    if (!show) return;
    if (windField !== this.field || !this.cdf) {
      const fresh = windField !== this.field;
      this.field = windField;
      this._cdf(windField);
      // New field: spread the population over its lifetimes so it does not pulse.
      for (let i = 0; i < this.n; i++) { this._spawn(i); if (fresh) this.age[i] = rand() * this.life[i]; }
      this.geo.getAttribute('color').needsUpdate = true;
    }
    if (REDUCED_MOTION) return;
    const U = Math.max(0, +u10 || 0), T = Math.min(dt, 0.1) * vis_PARTICLES.speedup;
    const K0 = MD.kappa * vis_PARTICLES.ustarHat * Math.max(U, 0.3), H = MD.Hbar_m, d = MD.d_m;
    const f = windField, v = this.v, q = this.q, alpha = this.geo.getAttribute('alpha').array;
    let recolor = false;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) { alpha[i] = 0; continue; }
      q.set(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]);
      if (!f.vel(q, v)) v.set(0, 0, 0);
      const K = K0 * (Math.max(q.y, H) - d), sig = Math.sqrt(2 * K * T);
      q.x += v.x * U * T + sig * vis_gauss();
      q.y += v.y * U * T + sig * vis_gauss();
      q.z += v.z * U * T + sig * vis_gauss();
      if (q.y < 0.3) q.y = 0.6 - q.y;                         // reflect at the ground
      this.age[i] += dt;
      const out = !f.sample || !f.sample(q, vis_tmp4);
      if (this.age[i] > this.life[i] || out || (f.solidAt && f.solidAt(q))) { this._spawn(i); recolor = true; continue; }
      this.p[i * 3] = q.x; this.p[i * 3 + 1] = q.y; this.p[i * 3 + 2] = q.z;
      const a = this.age[i], L = this.life[i];
      alpha[i] = 0.9 * smoothstep(0, 0.8, a) * (1 - smoothstep(0.65 * L, L, a));
    }
    this.geo.getAttribute('position').needsUpdate = true;
    this.geo.getAttribute('alpha').needsUpdate = true;
    if (recolor) this.geo.getAttribute('color').needsUpdate = true;
  }
}
const vis_tmp4 = new Float32Array(4);
// Standard normal deviate (Box–Muller) from the seeded core rand(), so screenshots are repeatable.
function vis_gauss() { return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand()); }

// Emission sources as weighted segments / triangles (see Particles). Roads without a group emit nothing.
function vis_sources(env) {
  const out = [], unit = MD.aadt_unit || 10000;
  for (const r of (env && env.roads) || []) {
    if (!r || !r.g || !Array.isArray(r.p) || !(r.aadt > 0)) continue;
    const hw = ((Number.isFinite(r.w) && r.w > 0) ? r.w : 6) / 2;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1], len = Math.hypot(bx - ax, bz - az);
      if (len < 0.1) continue;
      out.push({ g: r.g, ax, az, bx, bz, hw, nx: -(bz - az) / len, nz: (bx - ax) / len, cx: (ax + bx) / 2, cz: (az + bz) / 2, w: len * r.aadt / unit });
    }
  }
  for (const h of (env && env.heating) || []) {
    const ring = h && h.p;
    if (!Array.isArray(ring) || ring.length < 3) continue;
    let tris = [];
    try { tris = THREE.ShapeUtils.triangulateShape(ring.map(([x, z]) => new THREE.Vector2(x, z)), []); } catch (e) { tris = []; }
    for (const [a, b, c] of tris) {
      const A = ring[a], B = ring[b], C = ring[c];
      const area = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) / 2;
      if (area < 0.1) continue;
      out.push({ g: 'D', tri: true, ax: A[0], az: A[1], bx: B[0], bz: B[1], qx: C[0], qz: C[1], cx: (A[0] + B[0] + C[0]) / 3, cz: (A[1] + B[1] + C[1]) / 3, w: area * (Number.isFinite(h.w) ? h.w : 1) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ wind streaks (reference port)
/*
 * Wind shown as trails that follow the simulated flow: each particle remembers where it was over the
 * last second, so the line bends where air is pushed over a roof or squeezed through a corner.
 * Ported from the reference (700 trails of 9 points, history shifted every 0.11 s, speeds × 2.2,
 * lifetimes 2.5–6.5 s, heights 2–57 m biased low). Changes: the field is passed to update() instead
 * of living on a stadium object; trails start anywhere in the tunnel's central 80 % × 74 % (the
 * reference's −240…+180 m along, ±220 m across its 520 × 560 m tunnel, scaled to ours); they are
 * drawn without tone mapping.
 * update(dt, windField, u10, visible). Frozen under prefers-reduced-motion.
 */
class WindStreaks {
  constructor(parent, opts = {}) {
    this.parent = parent || scene;
    this.n = opts.n || 700;
    this.K = 9;
    this.p = new Float32Array(this.n * 3);
    this.hist = new Float32Array(this.n * this.K * 3);
    this.age = new Float32Array(this.n);
    this.life = new Float32Array(this.n);
    this.clock = 0;
    const segs = this.K - 1;
    const pos = new Float32Array(this.n * segs * 6), col = new Float32Array(this.n * segs * 8);
    for (let i = 0; i < this.n; i++) for (let k = 0; k < segs; k++) {
      const a0 = 0.85 * (1 - k / segs), a1 = 0.85 * (1 - (k + 1) / segs);
      col.set([1, 0.83, 0.5, a0, 1, 0.83, 0.5, a1], (i * segs + k) * 8);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    this.geo = g;
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 6;
    this.lines.visible = false;
    this.lines.name = 'wind-streaks';
    this.parent.add(this.lines);
    this.v = new THREE.Vector3();
    this.q = new THREE.Vector3();
  }
  spawn(i) {
    const f = this.field, fr = f.frame, ex = vis_v3(fr.ex), ey = vis_v3(fr.ey), o = vis_v3(fr.origin);
    const Lx = f.nx * f.dx, Ly = f.ny * f.dx;
    const along = Lx * (0.08 + rand() * 0.8), across = Ly * (0.13 + rand() * 0.74);
    const x = o.x + ex.x * along + ey.x * across, z = o.z + ex.z * along + ey.z * across;
    const y = 2 + Math.pow(rand(), 1.7) * 55;
    this.p.set([x, y, z], i * 3);
    for (let k = 0; k < this.K; k++) this.hist.set([x, y, z], (i * this.K + k) * 3);
    this.age[i] = 0;
    this.life[i] = 2.5 + rand() * 4;
  }
  update(dt, windField, u10, visible) {
    const U = +u10 || 0;
    this.lines.visible = !!(visible && windField && typeof windField.vel === 'function' && U > 0.4);
    if (!this.lines.visible || REDUCED_MOTION) return;
    const f = windField;
    if (f !== this.field) { this.field = f; for (let i = 0; i < this.n; i++) { this.spawn(i); this.age[i] = rand() * this.life[i]; } }
    this.clock += dt;
    const shift = this.clock > 0.11;
    if (shift) this.clock = 0;
    const v = this.v, q = this.q, scale = U * 2.2;
    for (let i = 0; i < this.n; i++) {
      q.set(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]);
      if (!f.vel(q, v)) { this.spawn(i); continue; }
      q.addScaledVector(v, scale * dt);
      this.age[i] += dt;
      if (this.age[i] > this.life[i] || q.y < 0.5 || !f.sample(q, vis_tmp4) || (f.solidAt && f.solidAt(q))) { this.spawn(i); continue; }
      this.p[i * 3] = q.x; this.p[i * 3 + 1] = q.y; this.p[i * 3 + 2] = q.z;
      const h = i * this.K * 3;
      if (shift) this.hist.copyWithin(h + 3, h, h + (this.K - 1) * 3);
      this.hist[h] = q.x; this.hist[h + 1] = q.y; this.hist[h + 2] = q.z;
    }
    const pos = this.geo.getAttribute('position').array, segs = this.K - 1;
    for (let i = 0; i < this.n; i++) {
      const h = i * this.K * 3;
      for (let k = 0; k < segs; k++) {
        const o = (i * segs + k) * 6;
        for (let a = 0; a < 6; a++) pos[o + a] = this.hist[h + k * 3 + a];
      }
    }
    this.geo.getAttribute('position').needsUpdate = true;
  }
}

// ------------------------------------------------------------------ labels (reference port)
/*
 * HTML labels pinned to 3D points, one layer per view: new LabelLayer(el) with el the view's
 * absolutely positioned .labels container. add(text, pos, kind, key) gives each label the classes
 * "lbl lbl-<kind>…" (kinds: road, park, water, poi, station, scenario); a label added with an i18n
 * key is re-translated on a language change. update(cam, w, h) places them each frame: hidden behind
 * the camera or off-screen, faded out between 1.5 and 2.6 km (reference distances).
 * The layer is aria-hidden in the reference markup; the same names appear in the UI text.
 */
class LabelLayer {
  constructor(el) {
    this.el = el;
    this.items = [];
    this.v = new THREE.Vector3();
    I18N.onChange(() => this.relabel());
  }
  add(text, pos, kind = 'poi', key = null) {
    if (!this.el) return null;
    const e = document.createElement('span');
    e.className = 'lbl ' + String(kind).split(' ').filter(Boolean).map((k) => (k.startsWith('lbl-') ? k : 'lbl-' + k)).join(' ');
    e.textContent = key ? t(key) : text;
    this.el.appendChild(e);
    const it = { e, pos, key, shown: true };
    this.items.push(it);
    return it;
  }
  addAll(list) { for (const l of list || []) this.add(l.text, l.pos, l.kind, l.key || null); }
  remove(it) {
    if (!it) return;
    it.e.remove();
    this.items = this.items.filter((x) => x !== it);
  }
  clear() { for (const it of this.items) it.e.remove(); this.items = []; }
  relabel() { for (const it of this.items) { if (it.key) it.e.textContent = t(it.key); it.size = null; } }
  /*
   * Place every label, then declutter (integration addition, 2026-09-28; the reference drew overlapping labels,
   * e.g. "INA Zagreb-Miramarska" over "Park Adolfa Mošinskog" in the air view). Labels are taken greedily in the
   * order of vis_LABEL_PRIORITY (the station and scenario labels always win), nearer ones first within a class;
   * a label whose box overlaps an already placed one, plus vis_LABEL_PAD px, is hidden for this frame. Hidden
   * labels use visibility (not display) so their size stays measurable; sizes are measured once per text.
   */
  update(cam, w, h) {
    const v = this.v, cand = [];
    for (const it of this.items) {
      v.copy(it.pos).project(cam);
      const d = cam.position.distanceTo(it.pos);
      const show = !it.e.hidden && v.z < 1 && v.x > -1.05 && v.x < 1.05 && v.y > -1.05 && v.y < 1.1 && d < 2600;
      if (show !== it.shown) { it.e.style.display = show ? '' : 'none'; it.shown = show; }
      if (!show) continue;
      const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      it.e.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      it.e.style.opacity = d > 1500 ? String(clamp(1 - (d - 1500) / 1100, 0, 1)) : '1';
      cand.push({ it, x, y, d, pr: vis_labelPriority(it.e.className) });
    }
    cand.sort((a, b) => a.pr - b.pr || a.d - b.d);
    const boxes = [], P = vis_LABEL_PAD;
    for (const c of cand) {
      const it = c.it;
      if (!it.size || !it.size[0]) it.size = [it.e.offsetWidth, it.e.offsetHeight];
      const [bw, bh] = it.size;
      const box = [c.x - bw / 2 - P, c.y - bh - P, c.x + bw / 2 + P, c.y + P];
      const clash = boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
      const vis = clash ? 'hidden' : '';
      if (it.e.style.visibility !== vis) it.e.style.visibility = vis;
      if (!clash) boxes.push(box);
    }
  }
}
// Declutter order of LabelLayer (lower first) by the label's kind class, and the gap kept between labels (px).
const vis_LABEL_ORDER = ['lbl-station', 'lbl-scenario', 'lbl-road', 'lbl-park', 'lbl-water', 'lbl-poi'];
const vis_LABEL_PAD = 3;
function vis_labelPriority(cls) {
  const i = vis_LABEL_ORDER.findIndex((k) => cls.includes(k));
  return i < 0 ? vis_LABEL_ORDER.length : i;
}
