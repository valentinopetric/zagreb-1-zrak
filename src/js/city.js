// ------------------------------------------------------------------ city
/*
 * The neighbourhood of ZAGREB-1 as 3D objects and as the geometry the wind tunnel voxelises
 * (docs/architecture.md §6.3, docs/12-rendering.md §3–§5).
 *
 * Two outputs from one source (ENV = src/data/env.json):
 *   1. Display objects, built once by buildCity(): ground layers, roads, the Vukovarska tram
 *      reservation, rail, LoD1 buildings (merged prisms), an optional LoD2 mesh (decoded lazily from
 *      LOD2_B64), instanced trees, the station container with its 4 m sampling inlet, and labels.
 *   2. cityGeometry(scenarioId): plain data {prisms, trees, roads, heating} for voxel.js. It never
 *      touches THREE or the GPU, so the flow code and the tests can call it before (or without)
 *      buildCity(). The station container is excluded (critic §4.2: "Container: excluded from the
 *      mask"), the current leaf mode sets the tree LAD (critic §4.3).
 *
 * Scenarios (SCENARIOS, docs/12-rendering.md §5). Each changes geometry, so each needs its own flow:
 *   'trees'   double rows of street trees along Vukovarska and Miramarska within 400 m, plus the
 *             median wherever it is wide enough; placed by rule, not by hand (ct_streetTrees);
 *   'block'   a 7-storey (22 m) closed perimeter block on the Park Drage Galića lawn, 10 m west of the
 *             inlet: the station would become a street-canyon site;
 *   'tower'   an 80 m tower on the surface car park 110 m north-east of the station, in the fetch of
 *             the most frequent (NNE–NE) winds;
 *   'notrees' every tree removed;
 *   'custom'  one user-placed box, setCustomBlock({x, z, w, d, h, rot}).
 * Emission-only measures (LEZ, EV share, …) are not scenarios here: they reuse the 'today' flow.
 *
 * Two views, one scene: the "today" view and the "scenario" view render the same city. What differs
 * lives in per-scenario groups, scenarioLayer(id). Call cityView(null) before drawing the today view
 * and cityView(id) before drawing the scenario view: it shows that layer and hides what the layer
 * replaces (e.g. the base trees when the block removes some of them). A layer lists what it hides in
 * layer.userData.hide, for a caller that prefers to manage visibility itself.
 *
 * Exports: SCENARIOS, CITY_SOURCE_GROUPS, buildCity, scenarioLayer, cityView, cityGeometry,
 * setCustomBlock, setLeaves, colorBuildings, setXray, setLod2, decodeLod2,
 * buildingLegendHTML. Private helpers carry the prefix ct_.
 */

// ------------------------------------------------------------------ constants
/*
 * Every number below has a source or a stated reason (docs/12-rendering.md §5 has the table).
 */
const ct_LOD2_R = SITE.extent.lod2_radius_m;          // 500 m: radius of the LoD2 mesh (architecture §4.1)
// The street grid around the station is turned 4° anticlockwise from true north: Vukovarska runs
// 86°/266°, Miramarska 176°/356° (site-context §3.1). Scenario volumes are aligned with it.
const ct_GRID_ROT = -4;
// Leaf area density of tree crowns, m²/m³: leaf-on (May–October) 1.2, leaf-off 0.3 (critic §4.3,
// site-context §9.1). 'none' removes the trees from the flow altogether.
const ct_LAD = { on: 1.2, off: 0.3 };
// A tree's crown starts at least 2.5 m above ground (clear stem over footways; design choice) and is
// drawn as an ellipsoid whose vertical semi-axis is at most 1.2× the crown radius.
const ct_TRUNK_MIN = 2.5, ct_CROWN_ASPECT = 1.2;
// Trees within this radius of the station get detailed, shadow-casting crowns and trunks (the
// reference used 430 m around its stadiums); farther ones are low-poly and shadowless.
const ct_TREE_NEAR_R = 450;
// Station container: a standard ISO container is 2.59 m high (8 ft 6 in); the sampling inlet sits on
// its roof (Action Plan 2015, critic §1.6) at 4.0 m above ground (EEA metadata, critic §1.6), so the
// mast rises 1.4 m above the roof. The yellow beacon reaches 40 m, above the 31 m slab just north of
// the park, so the station can be found from the air.
const ct_CONTAINER_H = 2.6, ct_BEACON_H = 40;
// Width fallbacks when a road has no w: lanes × 3.25 m (architecture §4.1), else the reference's
// per-class widths (m) for classes 0..4, and 2.5 m for footways and cycle tracks.
const ct_ROAD_W = [16, 9, 6, 4.5, 2.2, 2.5];
// Tram: the Vukovarska reservation is ≈ 7 m wide between the carriageways (measured on the 0.5 m city
// orthophoto, research/data/critic/zg_orto2022_300m.jpg, at x = −125 m). OSM maps each of its two
// tracks as a way ~3.3 m apart, so each track gets a 3.6 m bed and the two beds merge into ≈ 7 m.
// A tram way counts as "in the reservation" when it runs within 30 m of a Vukovarska carriageway.
// Track bands are 1.6 m (reference); a single street-running track gets a 2.8 m bed (sleeper length
// 2.4–2.6 m plus margin).
const ct_TRAM = { bedRes: 3.6, bed: 2.8, track: 1.6, nearVukovarska: 30 };
const ct_RAIL = { bed: 3.0, track: 1.6 };
// Label heights above ground (m), from the reference envLabels(): roads 3, water 4, POIs 14.
const ct_LABEL_Y = { road: 3, water: 4, poi: 14, park: 8 };

/*
 * Street-tree rule for the 'trees' scenario (ct_streetTrees). Candidates every 10 m along each
 * Vukovarska (group A) and Miramarska (group B) carriageway, on both sides, in two rows 2.5 m and
 * 8.5 m beyond the kerb (verge row and back-of-footway row); the inner-side candidates of a dual
 * carriageway fall in the median. A candidate is planted only where it is clear of everything:
 *   - 1.0 m beyond the kerb of any motor carriageway (so the 2.5 m row always clears its own kerb);
 *   - 3.0 m from a tram track centreline (outside the reservation);
 *   - 2.0 m from any building wall, and not inside a building;
 *   - 8 m from the sampling inlet: AAQD 2008/50/EC Annex III C asks for unrestricted flow around the
 *     inlet, "normally some metres away from … trees";
 *   - crowns may overlap a neighbour's by at most 25 % (spacing ≥ 0.75 (r1 + r2), and ≥ 6 m).
 * Size: 14 m tall, crown radius 4.5 m, the middle of the 12–18 m / 4–6 m range for mature Platanus
 * and Tilia, the commonest street trees here (site-context §5, §9.1). Spacing 10 m (design choice
 * within the usual 8–12 m for large-crowned avenue trees).
 */
const ct_STREET = { h: 14, r: 4.5, spacing: 10, rows: [2.5, 8.5], radius: 400, station: 8, overlap: 0.75, minGap: 6, building: 2.0, road: 1.0, tram: 3.0 };

/*
 * Scenario volumes, in the local frame (x east, z south, metres from the inlet), rot in degrees
 * clockwise seen from above (0 = sides along east and south). Chosen on the 2022 orthophotos
 * (research/data/critic/zg_orto2022_300m.jpg and the 1 m DGU mosaic) and the OSM land-use polygons;
 * docs/12-rendering.md §5 shows them on the plan.
 *
 * 'block': the Park Drage Galića lawn (OSM leisure=park, 5 428 m²) is the open ground between the
 *   station (x = 0), the 31 m slab to the north (z ≤ −32), the 9 m pavilion to the west (x ≤ −47) and
 *   the Vukovarska service road to the south (z ≥ +22). A 34 × 46 m closed block (x −44…−10,
 *   z −28…+18) fills it with 2–4 m to spare; its east facade is 10 m from the inlet, the station tree
 *   stays. Wings 11 m deep leave a 12 × 24 m courtyard. Height 22 m = ground floor 4 m + 6 × 3.0 m
 *   (G+6, flat roof; for comparison the ZG3D fit for existing 7-level buildings, 3.03·L + 5.81,
 *   gives 27 m with their tall storeys and pitched roofs, critic §1.9).
 * 'tower': the surface car park at x 74…105, z −83…−49 (OSM amenity=parking, 950 m²) north of the
 *   Trg Stjepana Radića access road, between the small park at Miramarska and the 28 m office block
 *   to the east (x ≥ 106). A 24 × 24 m tower, 80 m tall (within the range the district already has:
 *   the 96 m Eurotower stands 390 m SW, site-context §2), 110 m from the inlet at bearing 53°: upwind of the station
 *   in the most frequent NNE–NE winds (critic §4.5 default preset 45°), and inside every 600 m
 *   tunnel (≤ 300 m from the station) whatever the wind direction.
 * 'custom': a default box in Park Stjepana Srkulja across Miramarska, until the user moves it.
 */
const ct_BLOCK = { x: -27, z: -5, w: 34, d: 46, depth: 11, h: 22, rot: ct_GRID_ROT };
const ct_TOWER = { x: 89, z: -66, w: 24, d: 24, h: 80, rot: ct_GRID_ROT };
// Building ids a scenario demolishes (dropped from its prisms). None of the built-in scenarios needs
// one; the hook is here so a future "replace this building" scenario is one line.
const ct_REMOVE = {};
const ct_CUSTOM_DEFAULT = { x: 75, z: -10, w: 40, d: 24, h: 25, rot: ct_GRID_ROT };
// The LBM tunnel is 160 m high (architecture §5.1); keep a user block ≤ 100 m so ≥ 60 m of free air
// stays above it, and ≥ 3 m in plan (below one 5 m cell it would vanish in the voxeliser).
const ct_CUSTOM_LIMITS = { wd: [3, 300], h: [3, 100], r: SITE.extent.scene_half_m };

// Source groups (architecture §5.3) with a colour for overlays, particles and legends. A–C are the
// first three slots of the validated categorical palette (dataviz skill, palette.md; all-pairs CVD
// ΔE ≥ 9.2 on the #d6d4cb ground); D is a deliberate neutral smoke grey (heating is "the rest", and
// grey keeps the three traffic groups the only hues). Labels are i18n keys.
const CITY_SOURCE_GROUPS = [
  { id: 'A', color: '#2a78d6', label: 'scene.grp.A' },
  { id: 'B', color: '#eb6834', label: 'scene.grp.B' },
  { id: 'C', color: '#1baf7a', label: 'scene.grp.C' },
  { id: 'D', color: '#6b625a', label: 'scene.grp.D' },
];

// Building colour modes. 'year' classes are the ZG3D source years (Godina_izv): 2008 aerial
// photogrammetry, 2019 drone survey, 2022 LiDAR + multisensor survey (lidar-3d §3.2), plus the OSM
// fallback (s = 0, height from 3.0·levels + 5.5 m, critic §1.9) in neutral grey: "not measured".
// The three years take the validated categorical slots 1–3. 'height' uses the reference palette's
// blue sequential steps 100/200/300/400/500/650 with breaks around the ZG3D distribution
// (median 5.6 m, p95 24.4 m, max 98 m, lidar-3d §3.2): 1–2 storeys, 3–4, 5–6, 7–10, 11–15, taller.
const ct_YEAR_CLASSES = [
  { year: 2008, color: '#2a78d6', label: 'scene.bld.y2008' },
  { year: 2019, color: '#eb6834', label: 'scene.bld.y2019' },
  { year: 2022, color: '#1baf7a', label: 'scene.bld.y2022' },
  { year: 0, color: '#a19f98', label: 'scene.bld.yosm' },
];
const ct_HEIGHT_CLASSES = [
  { hi: 6, color: '#cde2fb' }, { hi: 12, color: '#9ec5f4' }, { hi: 20, color: '#6da7ec' },
  { hi: 30, color: '#3987e5' }, { hi: 45, color: '#256abf' }, { hi: Infinity, color: '#104281' },
];

I18N.add({
  hr: {
    'scene.sc.today': 'Danas', 'scene.sc.today.desc': 'Grad kakav jest: zgrade iz 3D modela ZG3D 2022, drveće iz OSM-a.',
    'scene.sc.trees': 'Drvoredi', 'scene.sc.trees.desc': 'Dvostruki drvoredi uz Vukovarsku i Miramarsku do 400 m od postaje, i u razdjelnom pojasu gdje ima mjesta (stabla 14 m, krošnja 9 m).',
    'scene.sc.block': 'Novi blok', 'scene.sc.block.desc': 'Zatvoreni blok od 7 etaža (22 m) na travnjaku Parka Drage Galića, 10 m zapadno od mjerne postaje. Zamišljen primjer, ne stvarni plan.',
    'scene.sc.tower': 'Neboder 80 m', 'scene.sc.tower.desc': 'Toranj visok 80 m na parkiralištu 110 m sjeveroistočno od postaje, u smjeru najčešćeg vjetra. Zamišljen primjer, ne stvarni plan.',
    'scene.sc.notrees': 'Bez drveća', 'scene.sc.notrees.desc': 'Sva stabla uklonjena, da se vidi koliko drveće mijenja strujanje.',
    'scene.sc.custom': 'Vlastiti blok', 'scene.sc.custom.desc': 'Jedan kvadar koji sami postavite: položaj, tlocrt, visina i zakret.',
    'scene.lbl.station': 'ZAGREB-1', 'scene.lbl.block': 'Novi blok · 22 m', 'scene.lbl.tower': 'Neboder · 80 m',
    'scene.lbl.custom': 'Vaš blok', 'scene.lbl.trees': 'Novi drvoredi',
    'scene.bld.plain': 'Obično', 'scene.bld.year': 'Izvor visine', 'scene.bld.height': 'Visina',
    'scene.bld.year.title': 'Izvor podataka o zgradi', 'scene.bld.height.title': 'Visina zgrade',
    'scene.bld.y2008': '2008 · aerofotogrametrija', 'scene.bld.y2019': '2019 · snimanje dronom',
    'scene.bld.y2022': '2022 · LiDAR i multisenzorsko snimanje', 'scene.bld.yosm': 'OSM, nema u ZG3D (3,0 m po katu + 5,5 m)',
    'scene.bld.range': '{lo}–{hi} m', 'scene.bld.over': 'više od {lo} m',
    'scene.grp.A': 'Vukovarska', 'scene.grp.B': 'Miramarska', 'scene.grp.C': 'Ostale ceste', 'scene.grp.D': 'Kućna ložišta',
  },
  en: {
    'scene.sc.today': 'Today', 'scene.sc.today.desc': 'The city as built: buildings from the ZG3D 2022 3D model, trees from OSM.',
    'scene.sc.trees': 'Tree rows', 'scene.sc.trees.desc': 'Double rows of street trees along Vukovarska and Miramarska within 400 m of the station, plus the median where there is room (trees 14 m tall, 9 m crowns).',
    'scene.sc.block': 'New block', 'scene.sc.block.desc': 'A closed 7-storey (22 m) perimeter block on the Park Drage Galića lawn, 10 m west of the monitoring station. A hypothetical example, not an actual plan.',
    'scene.sc.tower': 'Tower 80 m', 'scene.sc.tower.desc': 'An 80 m tower on the car park 110 m north-east of the station, in the direction of the most frequent wind. A hypothetical example, not an actual plan.',
    'scene.sc.notrees': 'No trees', 'scene.sc.notrees.desc': 'All trees removed, to show how much the trees change the flow.',
    'scene.sc.custom': 'Your own block', 'scene.sc.custom.desc': 'One box that you place yourself: position, footprint, height and rotation.',
    'scene.lbl.station': 'ZAGREB-1', 'scene.lbl.block': 'New block · 22 m', 'scene.lbl.tower': 'Tower · 80 m',
    'scene.lbl.custom': 'Your block', 'scene.lbl.trees': 'New tree rows',
    'scene.bld.plain': 'Plain', 'scene.bld.year': 'Height source', 'scene.bld.height': 'Height',
    'scene.bld.year.title': 'Building data source', 'scene.bld.height.title': 'Building height',
    'scene.bld.y2008': '2008 · aerial photogrammetry', 'scene.bld.y2019': '2019 · drone survey',
    'scene.bld.y2022': '2022 · LiDAR and multisensor survey', 'scene.bld.yosm': 'OSM, not in ZG3D (3.0 m per level + 5.5 m)',
    'scene.bld.range': '{lo}–{hi} m', 'scene.bld.over': 'over {lo} m',
    'scene.grp.A': 'Vukovarska', 'scene.grp.B': 'Miramarska', 'scene.grp.C': 'Other roads', 'scene.grp.D': 'Domestic heating',
  },
});

// Public scenario list (architecture §6.3). geo = the scenario changes geometry and needs its own flow.
const SCENARIOS = ['today', 'trees', 'block', 'tower', 'notrees', 'custom'].map((id) => ({
  id, geo: id !== 'today', label: `scene.sc.${id}`, desc: `scene.sc.${id}.desc`,
}));

// ------------------------------------------------------------------ state
const ct_state = {
  leaves: 'on',                 // 'on' | 'off' | 'none'
  color: 'plain',               // 'plain' | 'year' | 'height'
  xray: false,
  lod2: false,
  view: null,                   // scenario id of the view being drawn (null = today)
  custom: { ...ct_CUSTOM_DEFAULT },
  customVersion: 0,
  geoCache: new Map(),
  city: null,                   // buildCity() result
  layers: new Map(),            // scenario id -> THREE.Group
  treeSets: [],                 // every tree mesh set, for setLeaves()
};

// ------------------------------------------------------------------ small geometry helpers
// Deterministic pseudo-random in [0, 1) from an integer (so colours and jitter never change between
// loads or between the two views).
function ct_hash(i, salt = 0) {
  let h = Math.imul((i + 1) ^ Math.imul(salt + 0x9e37, 0x85ebca6b), 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}
// Closed ring without a repeated end point, all coordinates finite; null if not a polygon.
function ct_ring(p) {
  if (!Array.isArray(p) || p.length < 3) return null;
  const out = [];
  for (const q of p) {
    if (!q || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return null;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - q[0]) < 1e-6 && Math.abs(last[1] - q[1]) < 1e-6) continue;
    out.push([q[0], q[1]]);
  }
  if (out.length > 3 && Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-6 && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();
  return out.length >= 3 && Math.abs(polyArea(out)) > 0.5 ? out : null;
}
// Rectangle ring centred on (cx, cz) with sides w (local x) and d (local z), rotated rot° clockwise.
// Local offsets (u, v) may be given to cut wings out of a larger rectangle.
function ct_rect(cx, cz, w, d, rot, u0 = -w / 2, u1 = w / 2, v0 = -d / 2, v1 = d / 2) {
  const c = Math.cos(rot * DEG), s = Math.sin(rot * DEG);
  const P = (u, v) => [+(cx + u * c - v * s).toFixed(2), +(cz + u * s + v * c).toFixed(2)];
  return [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)];
}
function ct_width(r) {
  if (Number.isFinite(r.w) && r.w > 0) return r.w;
  if (Number.isFinite(r.l) && r.l > 0 && r.c <= 4) return r.l * 3.25;
  return ct_ROAD_W[clamp(r.c | 0, 0, 5)];
}
// Distance from a point to a polygon boundary, and whether it is inside.
function ct_polyDist(x, z, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, segDist(x, z, poly[j][0], poly[j][1], poly[i][0], poly[i][1]));
  return pointInPoly(x, z, poly) ? -d : d;
}

// Uniform grid of buckets for proximity queries in the x/z plane.
class ct_Grid {
  constructor(cell) { this.cell = cell; this.map = new Map(); this.stamp = 0; this.tag = Symbol('seen'); }
  key(i, j) { return (i + 32768) * 65536 + (j + 32768); }
  add(x0, z0, x1, z1, item) {
    const c = this.cell;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++) for (let j = Math.floor(z0 / c); j <= Math.floor(z1 / c); j++) {
      const k = this.key(i, j);
      if (!this.map.has(k)) this.map.set(k, []);
      this.map.get(k).push(item);
    }
  }
  // Calls fn(item) once per item whose buckets overlap the square [x ± r, z ± r]; stops when fn returns true.
  any(x, z, r, fn) {
    const c = this.cell, st = ++this.stamp;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++) {
      const list = this.map.get(this.key(i, j));
      if (!list) continue;
      for (const it of list) {
        if (it[this.tag] === st) continue;             // per-grid symbol: never collides with another grid
        it[this.tag] = st;
        if (fn(it)) return true;
      }
    }
    return false;
  }
}

// ------------------------------------------------------------------ base data (today)
// True for the station container or anything that stands in its place: a building footprint that
// contains the inlet, or a small one (< 60 m², the container is 3 × 2.4 m) centred within 6 m of it,
// or the OSM way of the container itself (SITE.station.osm_way). It must never enter the flow.
function ct_isContainer(b, ring) {
  const st = ENV.station || { x: 0, z: 0 };
  const id = String(b.id || '');
  if (SITE.station.osm_way && id.endsWith(String(SITE.station.osm_way))) return true;
  if (pointInPoly(RECEPTOR.x, RECEPTOR.z, ring)) return true;
  const [cx, cz] = polyCentroid(ring);
  return Math.abs(polyArea(ring)) < 60 && Math.hypot(cx - st.x, cz - st.z) < 6;
}

// ENV.buildings as validated prisms {p, b, h, s: 1, year, id, k}. Note the rename: in env.json `s` is
// the source year; in cityGeometry() `s` is the solid fraction the voxeliser reads (1 = building).
let ct_basePrismCache = null;
function ct_basePrisms() {
  if (ct_basePrismCache) return ct_basePrismCache;
  const out = [], skipped = { invalid: 0, container: 0 };
  for (const b of ENV.buildings || []) {
    const ring = ct_ring(b.p);
    const h = +b.h, base = Math.max(0, +b.b || 0);
    if (!ring || !Number.isFinite(h) || h <= base) { skipped.invalid++; continue; }
    if (ct_isContainer(b, ring)) { skipped.container++; continue; }
    out.push({ p: ring, b: base, h, s: 1, year: b.s | 0, id: b.id || `env:${out.length}`, k: b.k || 'zg3d' });
  }
  ct_basePrismCache = out;
  ct_basePrismCache.skipped = skipped;
  return out;
}

// ENV.trees plus the station tree if the geo pipeline did not already include it (critic §1.6:
// an ~18 m crown centred ~5 m W and 10 m N of the inlet; env.station.tree carries its size).
let ct_baseTreeCache = null;
function ct_baseTrees() {
  if (ct_baseTreeCache) return ct_baseTreeCache;
  const out = [];
  for (const tr of ENV.trees || []) {
    if (!Number.isFinite(tr.x) || !Number.isFinite(tr.z)) continue;
    out.push({ x: tr.x, z: tr.z, h: Math.max(3, +tr.h || 12), r: Math.max(0.8, +tr.r || 4), k: tr.k || 'osm' });
  }
  const st = ENV.station && ENV.station.tree;
  if (st && !out.some((tr) => tr.k === 'station' || Math.hypot(tr.x - st.x, tr.z - st.z) < 1.5 && tr.r >= st.r * 0.8)) {
    out.push({ x: st.x, z: st.z, h: st.h, r: st.r, k: 'station' });
  }
  ct_baseTreeCache = out;
  return out;
}

// Crown base height for a tree of height h and crown radius r (see ct_TRUNK_MIN).
function ct_crown(tr) {
  const rv = clamp(0.5 * (tr.h - ct_TRUNK_MIN), 0.8, tr.r * ct_CROWN_ASPECT);
  return { rv, cb: tr.h - 2 * rv };
}

// ------------------------------------------------------------------ scenario geometry
// The added prisms of a scenario (data only).
function ct_addedPrisms(id) {
  const P = (p, h, tag) => ({ p, b: 0, h, s: 1, year: 0, id: `scenario:${tag}`, k: 'scenario' });
  if (id === 'block') {
    const { x, z, w, d, depth: t, h, rot } = ct_BLOCK;
    const u = w / 2, v = d / 2;
    // Four wings of a closed perimeter block (simple polygons, so the voxeliser needs no holes).
    return [
      P(ct_rect(x, z, w, d, rot, -u, u, -v, -v + t), h, 'block-n'),
      P(ct_rect(x, z, w, d, rot, -u, u, v - t, v), h, 'block-s'),
      P(ct_rect(x, z, w, d, rot, -u, -u + t, -v + t, v - t), h, 'block-w'),
      P(ct_rect(x, z, w, d, rot, u - t, u, -v + t, v - t), h, 'block-e'),
    ];
  }
  if (id === 'tower') {
    const { x, z, w, d, h, rot } = ct_TOWER;
    return [P(ct_rect(x, z, w, d, rot), h, 'tower')];
  }
  if (id === 'custom') {
    const c = ct_state.custom;
    return [P(ct_rect(c.x, c.z, c.w, c.d, c.rot), c.h, 'custom')];
  }
  return [];
}

// Street trees for the 'trees' scenario, placed by the rule documented at ct_STREET. Deterministic.
let ct_streetCache = null;
function ct_streetTrees() {
  if (ct_streetCache) return ct_streetCache;
  const S = ct_STREET, st = RECEPTOR;
  const roads = (ENV.roads || []).filter((r) => r && Array.isArray(r.p) && r.p.length >= 2);
  const roadGrid = new ct_Grid(25), tramGrid = new ct_Grid(25), bldGrid = new ct_Grid(25), treeGrid = new ct_Grid(20);
  for (const r of roads) {
    if (!(r.c <= 4)) continue;
    const hw = ct_width(r) / 2;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1], m = hw + S.road;
      roadGrid.add(Math.min(ax, bx) - m, Math.min(az, bz) - m, Math.max(ax, bx) + m, Math.max(az, bz) + m, { ax, az, bx, bz, hw });
    }
  }
  for (const line of ENV.tram || []) for (let i = 0; i < line.length - 1; i++) {
    const [ax, az] = line[i], [bx, bz] = line[i + 1], m = S.tram;
    tramGrid.add(Math.min(ax, bx) - m, Math.min(az, bz) - m, Math.max(ax, bx) + m, Math.max(az, bz) + m, { ax, az, bx, bz });
  }
  for (const b of ct_basePrisms()) {
    if (b.b > 3) continue;                                  // floating parts (canopies, bridges) do not block planting
    const bb = bounds(b.p), m = S.building;
    bldGrid.add(bb.x0 - m, bb.z0 - m, bb.x1 + m, bb.z1 + m, b);
  }
  const addTree = (tr) => treeGrid.add(tr.x - tr.r, tr.z - tr.r, tr.x + tr.r, tr.z + tr.r, tr);
  for (const tr of ct_baseTrees()) addTree({ ...tr });
  const maxR = Math.max(9, ...ct_baseTrees().map((t) => t.r));
  const ok = (x, z) => {
    if (Math.hypot(x - st.x, z - st.z) > S.radius || Math.hypot(x - st.x, z - st.z) < S.station) return false;
    if (roadGrid.any(x, z, 1, (s) => segDist(x, z, s.ax, s.az, s.bx, s.bz) < s.hw + S.road)) return false;
    if (tramGrid.any(x, z, 1, (s) => segDist(x, z, s.ax, s.az, s.bx, s.bz) < S.tram)) return false;
    if (bldGrid.any(x, z, 1, (b) => ct_polyDist(x, z, b.p) < S.building)) return false;
    if (treeGrid.any(x, z, maxR + S.r, (t) => Math.hypot(x - t.x, z - t.z) < Math.max(S.minGap, S.overlap * (t.r + S.r)))) return false;
    return true;
  };
  const out = [];
  for (const r of roads) {
    if (r.g !== 'A' && r.g !== 'B') continue;
    if (!r.p.some(([x, z]) => Math.hypot(x - st.x, z - st.z) < S.radius + 60)) continue;
    const hw = ct_width(r) / 2;
    let carry = S.spacing / 2;                              // arc length to the next candidate
    for (let i = 0; i < r.p.length - 1; i++) {
      const [x1, z1] = r.p[i], [x2, z2] = r.p[i + 1];
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 1e-3) continue;
      const tx = (x2 - x1) / len, tz = (z2 - z1) / len;
      let s = carry;
      for (; s <= len; s += S.spacing) {
        const x = x1 + tx * s, z = z1 + tz * s;
        for (const side of [-1, 1]) for (const off of S.rows) {
          const qx = x - tz * side * (hw + off), qz = z + tx * side * (hw + off);
          if (!ok(qx, qz)) continue;
          const tr = { x: +qx.toFixed(1), z: +qz.toFixed(1), h: S.h, r: S.r, k: 'scenario' };
          out.push(tr);
          addTree(tr);
        }
      }
      carry = s - len;
    }
  }
  ct_streetCache = out;
  return out;
}

/*
 * How a new volume treats the trees around it:
 *   - a trunk inside a new prism, or within 1.5 m of its wall, is removed (courtyard trees stay);
 *   - a crown that would reach into a new wall is pruned back to clear the facade by 0.5 m, down to
 *     a 1.5 m radius at least (the usual facade-clearance pruning; this is what happens to the
 *     station tree, 5 m from the block's east wing: its 9 m crown becomes 4.5 m).
 * Returns the tree unchanged, a pruned copy, or null when removed.
 */
const ct_PRUNE = { trunk: 1.5, clear: 0.5, rMin: 1.5 };
function ct_treeVsPrisms(tr, prisms) {
  let dMin = Infinity;
  for (const pr of prisms) {
    const bb = bounds(pr.p);
    if (tr.x < bb.x0 - tr.r - 1 || tr.x > bb.x1 + tr.r + 1 || tr.z < bb.z0 - tr.r - 1 || tr.z > bb.z1 + tr.r + 1) continue;
    const d = ct_polyDist(tr.x, tr.z, pr.p);
    if (d < ct_PRUNE.trunk) return null;
    dMin = Math.min(dMin, d);
  }
  if (dMin - ct_PRUNE.clear >= tr.r) return tr;
  return { ...tr, r: +Math.max(ct_PRUNE.rMin, dMin - ct_PRUNE.clear).toFixed(2), pruned: true };
}

// The tree list of a scenario, before the leaf mode (visual and flow share it).
function ct_scenarioTrees(id) {
  if (id === 'notrees') return [];
  const added = ct_addedPrisms(id);
  let list = ct_baseTrees();
  if (added.length) list = list.map((tr) => ct_treeVsPrisms(tr, added)).filter(Boolean);
  if (id === 'trees') list = list.concat(ct_streetTrees());
  return list;
}

/*
 * What voxel.js consumes for a scenario (architecture §6.2/§6.3):
 *   prisms  [{p: [[x, z], ...], b, h, s}]   s = solid fraction (1 = building); also year, id, k
 *   trees   [{x, z, h, r, lad, cb}]         lad from the leaf mode (m²/m³); cb = crown base height (m),
 *                                            the crown being the ellipsoid from cb to h, radius r
 *   roads   ENV.roads (source rasterisation, unchanged by these scenarios)
 *   heating ENV.heating
 * The container is excluded; removed buildings are dropped (none of the built-in scenarios removes
 * any, but a scenario may list ids in `remove`), added ones appended. The result is cached per
 * (scenario, leaf mode, custom-block version) and must be treated as read-only.
 */
function cityGeometry(scenarioId = 'today') {
  const id = SCENARIOS.some((s) => s.id === scenarioId) ? scenarioId : 'today';
  const key = `${id}|${ct_state.leaves}|${id === 'custom' ? ct_state.customVersion : 0}`;
  if (ct_state.geoCache.has(key)) return ct_state.geoCache.get(key);
  const remove = new Set(ct_REMOVE[id] || []);
  const prisms = ct_basePrisms().filter((b) => !remove.has(b.id)).concat(ct_addedPrisms(id));
  const lad = ct_LAD[ct_state.leaves];
  const trees = ct_state.leaves === 'none' ? [] : ct_scenarioTrees(id).map((tr) => ({
    x: tr.x, z: tr.z, h: tr.h, r: tr.r, lad, cb: +ct_crown(tr).cb.toFixed(2),
  }));
  const geo = { id, leaves: ct_state.leaves, prisms, trees, roads: ENV.roads || [], heating: ENV.heating || [] };
  ct_state.geoCache.set(key, geo);
  return geo;
}

// ------------------------------------------------------------------ building meshes
// Colour of one building for a mode; returns [wall, roof] THREE.Colors.
const ct_tmpA = new THREE.Color(), ct_tmpB = new THREE.Color();
function ct_buildingColors(b, i, mode, out = [new THREE.Color(), new THREE.Color()]) {
  if (b.k === 'scenario') { out[0].set(M.proposed.color); out[1].copy(out[0]).multiplyScalar(0.92); return out; }
  if (mode === 'year') {
    const cls = ct_YEAR_CLASSES.find((c) => c.year === (b.year | 0)) || ct_YEAR_CLASSES[ct_YEAR_CLASSES.length - 1];
    out[1].set(cls.color);
    out[0].copy(out[1]).lerp(ct_tmpA.set('#ffffff'), 0.3);   // walls a little lighter, so shading still reads
    return out;
  }
  if (mode === 'height') {
    const cls = ct_HEIGHT_CLASSES.find((c) => b.h < c.hi);
    out[1].set(cls.color);
    out[0].copy(out[1]).lerp(ct_tmpA.set('#ffffff'), 0.2);
    return out;
  }
  // 'plain' (reference): light warm walls; red tile roofs on small low houses (h ≤ 11 m, < 450 m²,
  // i.e. the Trnje family houses), light grey flat roofs on everything else.
  const r1 = ct_hash(i, 1), r2 = ct_hash(i, 2), r3 = ct_hash(i, 3);
  const small = b.h <= 11 && Math.abs(polyArea(b.p)) < 450;
  out[0].setHSL(0.1, 0.12, 0.84 + r1 * 0.06);
  if (small) out[1].setHSL(0.035 + r2 * 0.02, 0.42, 0.44 + r3 * 0.08);
  else out[1].setHSL(0.1, 0.05, 0.74 + r3 * 0.06);
  return out;
}

/*
 * Merged LoD1 geometry for a list of prisms: walls from b to h, a flat roof at h, and a floor at b
 * for floating parts (b > 0.5 m, e.g. canopies and bridges seen from below). Rings are made
 * counter-clockwise in the (x, z) shoelace sense, which makes the wall normals (dz, 0, −dx) point
 * outward; roof triangles are turned to face +y and floors −y (the same checks as the reference).
 * Returns the geometry plus, per vertex, the index of its building and whether it is a roof, so
 * colorBuildings() can recolour without rebuilding.
 */
function ct_prismGeometry(list, mode = 'plain') {
  let nv = 0;
  const rings = list.map((b) => {
    let p = b.p;
    if (polyArea(p) < 0) p = p.slice().reverse();
    let tris = [];
    try { tris = THREE.ShapeUtils.triangulateShape(p.map(([x, z]) => new THREE.Vector2(x, z)), []); } catch (e) { tris = []; }
    nv += p.length * 6 + tris.length * 3 * (b.b > 0.5 ? 2 : 1);
    return { p, tris };
  });
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  const vb = new Int32Array(nv), roof = new Uint8Array(nv);
  let v = 0;
  const cols = [new THREE.Color(), new THREE.Color()];
  const put = (x, y, z, nx, ny, nz, c, bi, isRoof) => {
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz;
    col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
    vb[v] = bi; roof[v] = isRoof; v++;
  };
  list.forEach((b, bi) => {
    const { p, tris } = rings[bi];
    const [wall, top] = ct_buildingColors(b, bi, mode, cols);
    const y0 = b.b, y1 = b.h;
    for (let i = 0; i < p.length; i++) {
      const [x1, z1] = p[i], [x2, z2] = p[(i + 1) % p.length];
      const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz) || 1;
      const nx = dz / len, nz = -dx / len;
      // two triangles per wall: (b1, t2, b2) and (b1, t1, t2), outward normal
      put(x1, y0, z1, nx, 0, nz, wall, bi, 0); put(x2, y1, z2, nx, 0, nz, wall, bi, 0); put(x2, y0, z2, nx, 0, nz, wall, bi, 0);
      put(x1, y0, z1, nx, 0, nz, wall, bi, 0); put(x1, y1, z1, nx, 0, nz, wall, bi, 0); put(x2, y1, z2, nx, 0, nz, wall, bi, 0);
    }
    for (const t of tris) {
      let a = p[t[0]], bb = p[t[1]], cc = p[t[2]];
      const cy = (bb[1] - a[1]) * (cc[0] - a[0]) - (bb[0] - a[0]) * (cc[1] - a[1]);
      if (cy < 0) [bb, cc] = [cc, bb];
      put(a[0], y1, a[1], 0, 1, 0, top, bi, 1); put(bb[0], y1, bb[1], 0, 1, 0, top, bi, 1); put(cc[0], y1, cc[1], 0, 1, 0, top, bi, 1);
      if (b.b > 0.5) {
        put(a[0], y0, a[1], 0, -1, 0, wall, bi, 0); put(cc[0], y0, cc[1], 0, -1, 0, wall, bi, 0); put(bb[0], y0, bb[1], 0, -1, 0, wall, bi, 0);
      }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(0, v * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, v * 3), 3));
  g.computeBoundingSphere();
  return { geo: g, vb: vb.subarray(0, v), roof: roof.subarray(0, v) };
}

// Rewrite the colour attribute of a prism mesh for a colour mode.
function ct_recolorPrisms(mesh, list, mode) {
  const { vb, roof } = mesh.userData;
  const col = mesh.geometry.getAttribute('color');
  const cols = [new THREE.Color(), new THREE.Color()];
  let last = -1, wall = null, top = null;
  for (let v = 0; v < vb.length; v++) {
    if (vb[v] !== last) { last = vb[v]; [wall, top] = ct_buildingColors(list[last], last, mode, cols); }
    const c = roof[v] ? top : wall;
    col.array[v * 3] = c.r; col.array[v * 3 + 1] = c.g; col.array[v * 3 + 2] = c.b;
  }
  col.needsUpdate = true;
}

function ct_prismMesh(list, parent, { shadow = 'both', mat = M.buildings, mode = ct_state.color } = {}) {
  if (!list.length) return null;
  const { geo, vb, roof } = ct_prismGeometry(list, mode);
  const m = addMesh(geo, mat, { shadow, parent });
  if (m) Object.assign(m.userData, { vb, roof, list });
  return m;
}

// ------------------------------------------------------------------ LoD2
/*
 * Decode lod2.bin (architecture §4.1): a 16-byte header ("ZL2B", uint32 version 1, uint32 nTri,
 * uint32 0), Int16 positions [nTri·9] in decimetres (x, y, z per vertex, y above ground), Uint8 class
 * per triangle (source year − 2000, 0 = unknown), zero padding to 4 bytes; all little-endian.
 * src: base64 text, ArrayBuffer or Uint8Array. Returns {version, nTri, pos: Float32Array metres,
 * cls: Uint8Array} or throws on a malformed buffer.
 */
function decodeLod2(src) {
  let bytes;
  if (src instanceof Uint8Array) bytes = src;
  else if (src instanceof ArrayBuffer) bytes = new Uint8Array(src);
  else {
    const bin = atob(String(src || '').replace(/\s+/g, ''));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  }
  if (bytes.length < 16) throw new Error('lod2: buffer shorter than its header');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'ZL2B') throw new Error(`lod2: bad magic "${magic}"`);
  const version = dv.getUint32(4, true), nTri = dv.getUint32(8, true);
  if (version !== 1) throw new Error(`lod2: unsupported version ${version}`);
  const need = 16 + nTri * 18 + nTri;
  if (bytes.length < need) throw new Error(`lod2: ${bytes.length} bytes, header promises ${need}`);
  const pos = new Float32Array(nTri * 9);
  for (let i = 0; i < pos.length; i++) pos[i] = dv.getInt16(16 + i * 2, true) / 10;
  const cls = bytes.slice(16 + nTri * 18, 16 + nTri * 18 + nTri);
  return { version, nTri, pos, cls };
}

// Per-vertex colours for the LoD2 mesh. 'plain': walls as LoD1; sloped roof faces below 12 m in red
// tile (the pitched family houses), other roofs light grey. 'year' from the triangle class,
// 'height' from the vertex height (LoD2 has no building ids; the colour shows the surface height).
function ct_lod2Colors(dec, nrm, mode, col) {
  const wall = new THREE.Color(), c = new THREE.Color();
  for (let t = 0; t < dec.nTri; t++) {
    const ny = Math.abs(nrm[t * 9 + 1]), ymax = Math.max(dec.pos[t * 9 + 1], dec.pos[t * 9 + 4], dec.pos[t * 9 + 7]);
    const isRoof = ny > 0.45;
    if (mode === 'year') {
      const yr = dec.cls[t] ? 2000 + dec.cls[t] : 0;
      const cls = ct_YEAR_CLASSES.find((k) => k.year === yr) || ct_YEAR_CLASSES[ct_YEAR_CLASSES.length - 1];
      c.set(cls.color);
      if (!isRoof) c.lerp(ct_tmpA.set('#ffffff'), 0.3);
    } else if (mode === 'height') {
      c.set(ct_HEIGHT_CLASSES.find((k) => ymax < k.hi).color);
      if (!isRoof) c.lerp(ct_tmpA.set('#ffffff'), 0.2);
    } else if (!isRoof) {
      c.copy(wall.setHSL(0.1, 0.12, 0.84 + ct_hash(t >> 6, 1) * 0.06));
    } else if (ny < 0.97 && ymax < 12) {
      c.setHSL(0.035 + ct_hash(t >> 4, 2) * 0.02, 0.42, 0.46 + ct_hash(t >> 4, 3) * 0.06);
    } else {
      c.setHSL(0.1, 0.05, 0.74 + ct_hash(t >> 6, 3) * 0.06);
    }
    for (let k = 0; k < 3; k++) { col[t * 9 + k * 3] = c.r; col[t * 9 + k * 3 + 1] = c.g; col[t * 9 + k * 3 + 2] = c.b; }
  }
}

// ------------------------------------------------------------------ trees
/*
 * Instanced trees for a list [{x, z, h, r, k}]: ellipsoid crowns (icosahedron, detail 1 near the
 * station and shadow-casting, detail 0 beyond ct_TREE_NEAR_R) and trunks near the station. Crown and
 * trunk follow ct_crown(), the same shape cityGeometry() hands to the voxeliser; only the yaw and a
 * ±6 % horizontal squash are random (deterministic, per tree), for a less mechanical look.
 * Leaf-on colours are the reference's greens; trees added by a scenario are a fresher yellow-green,
 * so "new" reads at a glance; leaf-off crowns are grey-brown and translucent.
 */
function ct_treeSet(list, parent, { fresh = false } = {}) {
  const set = new THREE.Group();
  set.name = 'trees';
  const near = [], far = [];
  list.forEach((tr, i) => (Math.hypot(tr.x - RECEPTOR.x, tr.z - RECEPTOR.z) < ct_TREE_NEAR_R ? near : far).push([tr, i]));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
  const parts = [];
  for (const [items, detail, cast] of [[near, 1, true], [far, 0, false]]) {
    if (!items.length) continue;
    const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, detail), M.tree, items.length);
    const leaf = new Float32Array(items.length * 3), bare = new Float32Array(items.length * 3);
    items.forEach(([tr, i], n) => {
      const { rv, cb } = ct_crown(tr);
      const k = 0.94 + 0.12 * ct_hash(i, 7);
      sc.set(tr.r * k, rv, tr.r * (2 - k));
      q.setFromAxisAngle(UP, ct_hash(i, 8) * Math.PI);
      p.set(tr.x, cb + rv, tr.z);
      crowns.setMatrixAt(n, m4.compose(p, q, sc));
      if (fresh) c.setHSL(0.2 + ct_hash(i, 9) * 0.04, 0.42, 0.36 + ct_hash(i, 10) * 0.08);
      else c.setHSL(0.22 + ct_hash(i, 9) * 0.08, 0.3 + ct_hash(i, 10) * 0.18, 0.24 + ct_hash(i, 11) * 0.12);
      leaf.set([c.r, c.g, c.b], n * 3);
      c.setHSL(0.07 + ct_hash(i, 12) * 0.03, 0.12, 0.42 + ct_hash(i, 13) * 0.1);
      bare.set([c.r, c.g, c.b], n * 3);
      crowns.setColorAt(n, c.setRGB(leaf[n * 3], leaf[n * 3 + 1], leaf[n * 3 + 2]));
    });
    crowns.instanceMatrix.needsUpdate = true;
    crowns.computeBoundingSphere();
    crowns.castShadow = cast;
    crowns.receiveShadow = true;
    Object.assign(crowns.userData, { leaf, bare, cast, role: 'crowns' });
    set.add(crowns);
    parts.push(crowns);
  }
  if (near.length) {
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 1, 1, 5), M.trunk, near.length);
    near.forEach(([tr, i], n) => {
      const { cb, rv } = ct_crown(tr);
      const top = cb + rv * 0.6, rad = clamp(0.02 * tr.h, 0.12, 0.45);   // ~0.25 m radius at 12 m height
      sc.set(rad, top, rad);
      p.set(tr.x, top / 2, tr.z);
      trunks.setMatrixAt(n, m4.compose(p, q.identity(), sc));
    });
    trunks.instanceMatrix.needsUpdate = true;
    trunks.computeBoundingSphere();
    trunks.userData.role = 'trunks';
    set.add(trunks);
    parts.push(trunks);
  }
  set.userData.parts = parts;
  set.userData.show = ct_state.leaves !== 'none';
  set.visible = set.userData.show;
  ct_applyLeaves(set);
  parent.add(set);
  ct_state.treeSets.push(set);
  return set;
}

function ct_disposeTreeSet(set) {
  if (!set) return;
  set.parent && set.parent.remove(set);
  for (const m of set.userData.parts || []) m.geometry.dispose();
  ct_state.treeSets = ct_state.treeSets.filter((s) => s !== set);
}

// Apply the current leaf mode to one tree set.
function ct_applyLeaves(set) {
  const mode = ct_state.leaves;
  set.userData.show = mode !== 'none';
  for (const m of set.userData.parts || []) {
    if (m.userData.role !== 'crowns') continue;
    const src = mode === 'off' ? m.userData.bare : m.userData.leaf;
    m.instanceColor.array.set(src);
    m.instanceColor.needsUpdate = true;
    m.material = mode === 'off' ? M.treeBare : M.tree;
    m.castShadow = mode === 'on' && m.userData.cast;
  }
}

// ------------------------------------------------------------------ ground, roads, rail
function ct_buildGround(root) {
  // Ground disc: 6.5 km radius (reference), beyond the fog, so no edge is ever visible.
  addMesh(new THREE.CircleGeometry(6500, 72).rotateX(-Math.PI / 2), M.ground, { parent: root });
  addMesh(flatGeometry(ENV.green, 0.04), M.grass, { parent: root });
  addMesh(flatGeometry(ENV.paved, 0.07), M.paved, { parent: root });
  addMesh(flatGeometry(ENV.water, 0.08), M.water, { parent: root });

  const roads = (ENV.roads || []).filter((r) => r && Array.isArray(r.p) && r.p.length >= 2);
  const W = (r) => ct_width(r);
  addMesh(ribbonGeometry(roads.filter((r) => r.c === 5 && r.hw !== 'cycleway'), (r) => Math.min(W(r), 3), 0.1), M.footway, { parent: root });
  addMesh(ribbonGeometry(roads.filter((r) => r.c === 5 && r.hw === 'cycleway'), (r) => Math.min(W(r), 2.5), 0.11), M.cycleway, { parent: root });
  addMesh(ribbonGeometry(roads.filter((r) => r.c === 4), W, 0.14), M.gravel, { parent: root });
  addMesh(ribbonGeometry(roads.filter((r) => r.c === 2 || r.c === 3), W, 0.18), M.asphalt, { parent: root });
  addMesh(ribbonGeometry(roads.filter((r) => r.c === 0 || r.c === 1), W, 0.22), M.asphaltMain, { parent: root });

  // Tram: split each line into segments in / outside the Vukovarska reservation (ct_TRAM).
  const vuk = new ct_Grid(40);
  for (const r of roads) if (r.g === 'A') for (let i = 0; i < r.p.length - 1; i++) {
    const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1], m = ct_TRAM.nearVukovarska;
    vuk.add(Math.min(ax, bx) - m, Math.min(az, bz) - m, Math.max(ax, bx) + m, Math.max(az, bz) + m, { ax, az, bx, bz });
  }
  const res = [], street = [], tracks = [];
  for (const line of ENV.tram || []) {
    if (!Array.isArray(line) || line.length < 2) continue;
    tracks.push(line);
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      // long segments: test a few points along them, not just the midpoint
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 25));
      for (let k = 0; k < n; k++) {
        const s0 = k / n, s1 = (k + 1) / n;
        const p0 = [lerp(a[0], b[0], s0), lerp(a[1], b[1], s0)], p1 = [lerp(a[0], b[0], s1), lerp(a[1], b[1], s1)];
        const mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2;
        const inRes = vuk.any(mx, mz, 1, (s) => segDist(mx, mz, s.ax, s.az, s.bx, s.bz) < ct_TRAM.nearVukovarska);
        (inRes ? res : street).push([p0, p1]);
      }
    }
  }
  addMesh(ribbonGeometry(res, () => ct_TRAM.bedRes, 0.26), M.tramBed, { parent: root });
  addMesh(ribbonGeometry(street, () => ct_TRAM.bed, 0.25), M.tramBed, { parent: root });
  addMesh(ribbonGeometry(tracks, () => ct_TRAM.track, 0.3), M.tram, { parent: root });

  const rail = (ENV.rail || []).filter((l) => Array.isArray(l) && l.length >= 2);
  addMesh(ribbonGeometry(rail, () => ct_RAIL.bed, 0.12), M.railBed, { parent: root });
  addMesh(ribbonGeometry(rail, () => ct_RAIL.track, 0.16), M.rail, { parent: root });
}

// Hidden overlays the UI can switch on: the emission source groups (roads coloured A/B/C, heating
// polygons D). Drawn just above the roads, without lighting, so the colours match the legend.
function ct_buildOverlays(root) {
  const group = new THREE.Group();
  group.name = 'sources';
  group.visible = false;
  const roads = (ENV.roads || []).filter((r) => r && Array.isArray(r.p) && r.p.length >= 2);
  for (const g of CITY_SOURCE_GROUPS) {
    const mat = new THREE.MeshBasicMaterial({ color: g.color, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -24 });
    if (g.id === 'D') {
      const polys = (ENV.heating || []).map((h) => h && h.p).filter(Boolean);
      mat.opacity = 0.45;
      addMesh(flatGeometry(polys, 0.45), mat, { parent: group, shadow: 'none', order: 3 });
    } else {
      addMesh(ribbonGeometry(roads.filter((r) => r.g === g.id), (r) => ct_width(r), 0.5), mat, { parent: group, shadow: 'none', order: 3 });
    }
  }
  root.add(group);
  return group;
}

// ------------------------------------------------------------------ station
/*
 * The monitoring container (env.station.container, 2.6 m high), the sampling mast to the inlet at
 * RECEPTOR (4.0 m), a small yellow inlet head with a halo ring, and a thin translucent beacon up to
 * 40 m with the "ZAGREB-1" label at its top. None of it enters cityGeometry().
 */
function ct_buildStation(root) {
  const g = new THREE.Group();
  g.name = 'station';
  const st = ENV.station || {};
  const ring = ct_ring(st.container) || ct_rect(st.x || 0, st.z || 0, 3.0, 2.4, 0);
  const box = ct_prismGeometry([{ p: ring, b: 0, h: ct_CONTAINER_H, k: 'station', year: 0 }], 'plain').geo;
  addMesh(box, M.container, { parent: g, shadow: 'both' });
  const inletY = RECEPTOR.y;
  const mastH = Math.max(0.2, inletY - ct_CONTAINER_H);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, mastH, 8), M.steel);
  mast.position.set(RECEPTOR.x, ct_CONTAINER_H + mastH / 2, RECEPTOR.z);
  mast.castShadow = true;
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.1, 0.3, 12), M.inlet);
  head.position.set(RECEPTOR.x, inletY, RECEPTOR.z);
  const halo = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.12, 8, 32), M.inlet);
  halo.rotation.x = Math.PI / 2;
  halo.position.copy(head.position);
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, ct_BEACON_H - inletY - 0.4, 8, 1, true), M.beacon);
  beacon.position.set(RECEPTOR.x, (ct_BEACON_H + inletY + 0.4) / 2, RECEPTOR.z);
  g.add(mast, head, halo, beacon);
  root.add(g);
  return { group: g, inlet: RECEPTOR.clone(), mast, head, halo, beacon };
}

// ------------------------------------------------------------------ labels
// [{text, key?, pos: Vector3, kind}] for LabelLayer. Road/park/water/POI labels come from env.json;
// the station label is ours. A label with `key` is re-translated when the language changes.
function ct_labels() {
  const out = [];
  for (const l of ENV.labels || []) {
    if (!l || !l.t || !Number.isFinite(l.x) || !Number.isFinite(l.z)) continue;
    const kind = ['road', 'poi', 'park', 'water'].includes(l.k) ? l.k : 'poi';
    out.push({ text: l.t, pos: new THREE.Vector3(l.x, ct_LABEL_Y[kind], l.z), kind });
  }
  for (const p of ENV.pois || []) {
    if (!p || !p.n || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    if (out.some((l) => l.text === p.n)) continue;
    out.push({ text: p.n, pos: new THREE.Vector3(p.x, ct_LABEL_Y.poi, p.z), kind: `poi ${p.t || ''}`.trim() });
  }
  out.push({ text: t('scene.lbl.station'), key: 'scene.lbl.station', pos: new THREE.Vector3(RECEPTOR.x, ct_BEACON_H + 1, RECEPTOR.z), kind: 'station' });
  return out;
}

// ------------------------------------------------------------------ build
/*
 * Build every display object once and add it to the scene under one root group.
 * Returns (and caches) {root, buildings, lod2, trees, station, labels, overlays}:
 *   buildings  {inner, outer: Mesh, count, skipped}  LoD1 split at the LoD2 radius, so LoD2 can
 *              replace the inner part; count = prisms drawn (ENV.buildings minus invalid/container)
 *   lod2       {available, loaded, mesh, load(): Promise<Mesh|null>}
 *   trees      the base tree set (THREE.Group, userData.list = the base tree list), inside
 *   treesRoot  the wrapper group that scenario views hide
 *   station    {group, inlet: Vector3, mast, head, halo, beacon}
 *   labels     [{text, key?, pos, kind}]
 *   overlays   {sources: Group}  hidden by default
 */
function buildCity() {
  if (ct_state.city) return ct_state.city;
  const root = new THREE.Group();
  root.name = 'city';
  scene.add(root);
  ct_buildGround(root);

  const prisms = ct_basePrisms();
  const R = ct_LOD2_R;
  const innerList = [], outerList = [];
  for (const b of prisms) {
    const [cx, cz] = polyCentroid(b.p);
    (Math.hypot(cx - RECEPTOR.x, cz - RECEPTOR.z) <= R ? innerList : outerList).push(b);
  }
  const buildings = {
    inner: ct_prismMesh(innerList, root), outer: ct_prismMesh(outerList, root),
    count: prisms.length, skipped: prisms.skipped,
  };
  for (const m of [buildings.inner, buildings.outer]) if (m) { m.name = 'lod1'; m.userData.show = true; }

  const lod2 = {
    available: !!(LOD2_B64 && LOD2_B64.length > 16), loaded: false, mesh: null, error: null,
    load() {
      if (this.loaded || !this.available) return Promise.resolve(this.mesh);
      // Decode after the current frame so the first render is never held up by 2–3 MB of base64.
      return new Promise((resolve) => setTimeout(() => {
        try {
          const dec = decodeLod2(LOD2_B64);
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(dec.pos, 3));
          g.computeVertexNormals();                 // non-indexed: one flat normal per triangle
          const col = new Float32Array(dec.pos.length);
          ct_lod2Colors(dec, g.getAttribute('normal').array, ct_state.color, col);
          g.setAttribute('color', new THREE.BufferAttribute(col, 3));
          g.computeBoundingSphere();
          const m = addMesh(g, M.lod2, { parent: root, shadow: 'both' });
          m.name = 'lod2';
          m.userData.dec = dec;
          m.userData.show = ct_state.lod2;
          m.visible = ct_state.lod2;
          this.mesh = m;
        } catch (e) {
          console.error('LoD2 decode failed', e);
          this.error = String(e);
          this.available = false;
        }
        this.loaded = true;
        resolve(this.mesh);
      }, 0));
    },
  };

  // The base trees sit in their own wrapper group. A scenario view hides the wrapper; the leaf mode
  // hides the tree set inside it. Keeping the two switches on different objects means a caller that
  // toggles userData.hide itself can never undo leaf mode 'none'.
  const treesRoot = new THREE.Group();
  treesRoot.name = 'trees-root';
  root.add(treesRoot);
  const trees = ct_treeSet(ct_baseTrees(), treesRoot);
  trees.userData.list = ct_baseTrees();
  trees.userData.base = true;
  const station = ct_buildStation(root);
  const overlays = { sources: ct_buildOverlays(root) };
  ct_state.city = { root, buildings, lod2, trees, treesRoot, station, labels: ct_labels(), overlays };
  return ct_state.city;
}

// ------------------------------------------------------------------ scenario layers
/*
 * The THREE.Group with what only the scenario view of `id` shows (built lazily, cached):
 *   'trees'   the added street trees;
 *   'block', 'tower', 'custom'  the new volumes (pale ochre, with outlines) and, because they remove
 *             trees standing in their footprint, their own copy of the tree set;
 *   'notrees' nothing (it only hides).
 * userData.hide   objects the scenario view must hide (the base-tree wrapper when the scenario
 *                 replaces or removes trees); userData.hides is the same array (alias);
 * userData.labels [{text, key, pos, kind}] for that view's LabelLayer.
 * 'today' (or an unknown id) returns an empty group.
 */
function scenarioLayer(id) {
  const city = buildCity();
  if (ct_state.layers.has(id)) return ct_state.layers.get(id);
  const g = new THREE.Group();
  g.name = `scenario:${id}`;
  g.visible = false;
  g.userData = { id, hide: [], labels: [] };
  Object.defineProperty(g.userData, 'hides', { get() { return this.hide; }, enumerable: false });
  city.root.add(g);
  ct_state.layers.set(id, g);
  ct_fillLayer(g, id);
  return g;
}

function ct_fillLayer(g, id) {
  const city = ct_state.city;
  for (const c of g.children.slice()) {
    g.remove(c);
    if (c.name === 'trees') ct_disposeTreeSet(c);
    else if (c.geometry) c.geometry.dispose();
  }
  g.userData.hide = [];
  const added = ct_addedPrisms(id);
  if (added.length) {
    const m = ct_prismMesh(added, g, { mat: M.proposed, mode: 'plain' });
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), M.proposedEdge);
    g.add(edges);
    // Label at the top of the tallest added volume (a live Vector3, so a moved custom block's label follows).
    const top = added.reduce((a, b) => (b.h > a.h ? b : a));
    const [cx, cz] = id === 'block' ? [ct_BLOCK.x, ct_BLOCK.z] : polyCentroid(top.p);
    const key = `scene.lbl.${id}`;
    const pos = (g.userData.labelPos = g.userData.labelPos || new THREE.Vector3());
    pos.set(cx, top.h + 4, cz);
    if (!g.userData.labels.length) g.userData.labels.push({ text: t(key), key, pos, kind: 'scenario' });
    const trees = ct_scenarioTrees(id);
    if (trees.length !== ct_baseTrees().length || trees.some((tr) => tr.pruned)) {
      ct_treeSet(trees, g);
      g.userData.hide.push(city.treesRoot);
    }
  } else if (id === 'trees') {
    const extra = ct_streetTrees();
    ct_treeSet(extra, g, { fresh: true });
    if (!g.userData.labels.length && extra.length) {
      // Label the new rows at the added tree nearest to a point 60 m west along Vukovarska: close enough to the station
      // to stay inside the scenario view of the default air camera (at 120 m it was clipped at the view split,
      // integration check 2026-09-28), far enough not to crowd the station label.
      const best = extra.reduce((a, b) => (Math.hypot(b.x + 60, b.z - 40) < Math.hypot(a.x + 60, a.z - 40) ? b : a));
      g.userData.labels.push({ text: t('scene.lbl.trees'), key: 'scene.lbl.trees', pos: new THREE.Vector3(best.x, best.h + 3, best.z), kind: 'scenario' });
    }
  } else if (id === 'notrees') {
    g.userData.hide.push(city.treesRoot);
  }
}

/*
 * Set the city's visibility for drawing one view: null/'today' = the city as built; a scenario id =
 * that scenario's layer on, and what it replaces off. Call it right before renderer.render() of each
 * view. Leaf mode 'none' and the LoD2 toggle are respected either way.
 */
function cityView(id = null) {
  const city = buildCity();
  ct_state.view = id && id !== 'today' ? id : null;
  const active = ct_state.view ? scenarioLayer(ct_state.view) : null;
  const hidden = new Set(active ? active.userData.hide : []);
  for (const [lid, layer] of ct_state.layers) layer.visible = lid === ct_state.view;
  city.treesRoot.visible = !hidden.has(city.treesRoot);
  for (const set of ct_state.treeSets) set.visible = set.userData.show;
  const b = city.buildings;
  if (b.inner) b.inner.visible = !(ct_state.lod2 && city.lod2.mesh);
  if (city.lod2.mesh) city.lod2.mesh.visible = ct_state.lod2;
  return active;
}

// ------------------------------------------------------------------ public setters
/*
 * Place the user's block: {x, z} centre (m, local frame), w × d footprint (m), h height (m), rot (deg,
 * clockwise). Missing fields keep their previous value; values are clamped to ct_CUSTOM_LIMITS.
 * Rebuilds the 'custom' layer, invalidates its cached geometry and emits Bus 'city:changed'
 * {scenario: 'custom', block} so the flow cache for 'custom' can be dropped. Returns the block.
 */
function setCustomBlock(o = {}) {
  const c = ct_state.custom, L = ct_CUSTOM_LIMITS;
  const num = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
  c.x = clamp(num(o.x, c.x), -L.r, L.r);
  c.z = clamp(num(o.z, c.z), -L.r, L.r);
  c.w = clamp(num(o.w, c.w), L.wd[0], L.wd[1]);
  c.d = clamp(num(o.d, c.d), L.wd[0], L.wd[1]);
  c.h = clamp(num(o.h, c.h), L.h[0], L.h[1]);
  c.rot = wrap360(num(o.rot, c.rot) + 180) - 180;
  ct_state.customVersion++;
  for (const k of ct_state.geoCache.keys()) if (k.startsWith('custom|')) ct_state.geoCache.delete(k);
  if (ct_state.layers.has('custom')) {
    ct_fillLayer(ct_state.layers.get('custom'), 'custom');
    if (ct_state.view) cityView(ct_state.view);
  }
  Bus.emit('city:changed', { scenario: 'custom', block: { ...c } });
  return { ...c };
}

/*
 * Leaf mode for display and flow: 'on' (May–October, LAD 1.2), 'off' (LAD 0.3, translucent grey-brown
 * crowns, no tree shadows) or 'none' (trees hidden and dropped from cityGeometry). Emits Bus
 * 'city:changed' {scenario: '*', leaves} because every scenario's flow depends on it.
 */
function setLeaves(mode) {
  if (!['on', 'off', 'none'].includes(mode) || mode === ct_state.leaves) return ct_state.leaves;
  ct_state.leaves = mode;
  ct_state.geoCache.clear();
  for (const set of ct_state.treeSets) ct_applyLeaves(set);
  if (ct_state.city) cityView(ct_state.view);
  Bus.emit('city:changed', { scenario: '*', leaves: mode });
  return mode;
}

// Building colours: 'plain' (reference palette), 'year' (ZG3D source year) or 'height'. LoD1, and
// LoD2 when loaded. Scenario volumes always stay in the "proposed" colour.
function colorBuildings(mode) {
  if (!['plain', 'year', 'height'].includes(mode)) return ct_state.color;
  ct_state.color = mode;
  const city = ct_state.city;
  if (!city) return mode;
  for (const m of [city.buildings.inner, city.buildings.outer]) if (m) ct_recolorPrisms(m, m.userData.list, mode);
  const l2 = city.lod2.mesh;
  if (l2) {
    ct_lod2Colors(l2.userData.dec, l2.geometry.getAttribute('normal').array, mode, l2.geometry.getAttribute('color').array);
    l2.geometry.getAttribute('color').needsUpdate = true;
  }
  return mode;
}

// X-ray: existing buildings drawn translucent so the slice, particles and streaks inside the street
// canyons stay visible (the reference's "x-ray roofs" toggle). Buildings then cast no shadows.
function setXray(on) {
  ct_state.xray = !!on;
  const city = ct_state.city;
  if (!city) return ct_state.xray;
  for (const m of [city.buildings.inner, city.buildings.outer, city.lod2.mesh]) {
    if (!m) continue;
    m.material = on ? M.buildingsXray : m.name === 'lod2' ? M.lod2 : M.buildings;
    m.castShadow = !on;
  }
  return ct_state.xray;
}

// LoD2 on/off. Turning it on decodes the mesh the first time (async). Resolves to true when LoD2 is
// now shown, false when it is off or unavailable (no lod2.bin baked in, or a bad buffer).
async function setLod2(on) {
  const city = buildCity();
  ct_state.lod2 = !!on;
  if (on && !city.lod2.loaded) await city.lod2.load();
  if (!city.lod2.mesh) ct_state.lod2 = false;
  if (city.lod2.mesh && ct_state.xray) setXray(true);
  cityView(ct_state.view);
  return ct_state.lod2;
}

// Legend for the building colour mode, as HTML (a list with swatches and text; colour is never the
// only carrier). 'plain' has no legend and returns ''.
function buildingLegendHTML(mode = ct_state.color) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const row = (color, text) => `<li><span class="legend-swatch" style="background:${color}" aria-hidden="true"></span>${esc(text)}</li>`;
  if (mode === 'year') {
    return `<div class="legend legend-buildings"><p class="legend-title">${esc(t('scene.bld.year.title'))}</p><ul>${ct_YEAR_CLASSES.map((c) => row(c.color, t(c.label))).join('')}</ul></div>`;
  }
  if (mode === 'height') {
    let lo = 0;
    const rows = ct_HEIGHT_CLASSES.map((c) => {
      const text = Number.isFinite(c.hi) ? t('scene.bld.range', { lo, hi: c.hi }) : t('scene.bld.over', { lo });
      lo = c.hi;
      return row(c.color, text);
    });
    return `<div class="legend legend-buildings"><p class="legend-title">${esc(t('scene.bld.height.title'))}</p><ul>${rows.join('')}</ul></div>`;
  }
  return '';
}
