# 12 · Rendering: the 3D scene, the scenarios and the visual encodings

*First draft by the scene owner (`src/js/scene.js`, `src/js/city.js`, `src/js/visuals.js`,
`src/js/tests/scene.test.js`). The binding interface is `docs/architecture.md` §6.3; this chapter
explains what is behind it, why each number has the value it has, and how to check it.*

---

## 1. Purpose, inputs and outputs

The scene turns the baked neighbourhood data into the 3D picture of the two views ("Danas / Today"
and "Scenarij / Scenario"). It also turns the same data into the plain geometry the wind tunnel
voxelises. That is the one place where rendering and physics meet.

| | What | From / to |
|---|---|---|
| **In** | `ENV` = `src/data/env.json`: buildings (LoD1 prisms), roads with widths, tram, rail, trees, green, water, paved, heating polygons, POIs, labels, station | `tools/build_env.py` (geo-data), architecture §4.1 |
| **In** | `LOD2_B64` = `src/data/lod2.bin`, a triangle mesh of ZG3D LoD2 within 500 m | geo-data, architecture §4.1 |
| **In** | `SITE` (station, inlet height, extents, model defaults) | `config/site.json` |
| **In** | `solarElevation()` (meteo.js), `EAQI_BANDS` (chemistry.js), `POLLUTANT_INFO` (emissions.js) | models; each is optional (guarded with `typeof`) |
| **In** | `WindField`, `ScalarField` | wind-tunnel.js, scalar.js (flow, scalar) |
| **Out** | display objects in the shared `scene` | main.js renders them |
| **Out** | `cityGeometry(scenario)` = `{prisms, trees, roads, heating}` | voxel.js / aero.js |
| **Out** | colour scales, legends (HTML) | main.js puts them in the page |

The three files and their public names:

| File | Public names |
|---|---|
| `scene.js` | `canvas`, `renderer`, `scene`, `sun`, `hemi`, `sky`, `skyUniforms`, `M`, `flatGeometry`, `ribbonGeometry`, `addMesh`, `timeUniform`, `setDaylight` |
| `city.js` | `SCENARIOS`, `CITY_SOURCE_GROUPS`, `buildCity`, `scenarioLayer`, `cityView`, `cityGeometry`, `setCustomBlock`, `setLeaves`, `colorBuildings`, `setXray`, `setLod2`, `decodeLod2`, `buildingLegendHTML` |
| `visuals.js` | `CONC_SCALES`, `concColor`, `concBand`, `setConcPalette`, `legendHTML`, `particleLegendHTML`, `ConcSlice`, `Particles`, `WindStreaks`, `LabelLayer` |

Private helpers are prefixed `sc_` (scene.js), `ct_` (city.js) and `vis_` (visuals.js). The module
is one shared scope (architecture §3), so the prefixes are what keeps the names apart.

---

## 2. The scene (scene.js)

### 2.1 Look

The look is ported from the reference repo *maksimir-pod-kisom* (`src/js/scene.js`, © 2026 Ivan
Rezić, MIT). The reference shows a stadium; here the same visual language shows a neighbourhood:

- sand-grey ground `#d6d4cb`, sage grass `#b8cea0`, park `#c3d3aa`, water `#6f94a6`;
- light warm walls, HSL(0.10, 0.12, 0.84–0.90);
- red-tile roofs on small low houses and light grey flat roofs on everything else (§3.2);
- asphalt `#8d9193`; low-poly icosahedron trees in varied greens;
- ACES filmic tone mapping at exposure 1.02;
- one sun with soft PCF shadows, a sky/ground hemisphere fill and a gradient sky dome.

The data overlays are the only saturated things on screen: the concentration slice, particles and
wind streaks.

| Element | Setting | Source / reason |
|---|---|---|
| Renderer | antialias, sRGB output, ACES, exposure 1.02, pixel ratio ≤ 1.75 | reference; the cap keeps two views on one full-window canvas affordable |
| Sun | `#fff4e2`, intensity 2.1 by day | reference |
| Hemisphere | sky `#eef3f6`, ground `#5f6452`, 1.15 | reference |
| Environment | RoomEnvironment PMREM, blur 0.04, intensity 0.55 | reference (reflections on water, glass, steel) |
| Sky dome | radius 7 km, vertical gradient (reference shader); it follows the camera of the view being drawn (`onBeforeRender`) | – |
| Fog | linear, 1200 → 4200 m | data covers ±750 m and the "from the air" camera sits ~1 km out, so the model area stays crisp and the empty ground plane beyond it melts into the horizon (the reference used 900–3600 m for a smaller scene) |
| Shadow camera | orthographic ±520 m around the station, far 2600 m | covers the 500 m LoD2 radius plus a margin |
| Shadow map | 4096² (0.25 m texels); 2048² on software GL | sharp enough for street trees; SwiftShader/llvmpipe is ~50× slower |
| Shadow bias | −0.0004, normal bias 0.35 (4096) / 0.6 (2048) | reference values, scaled for the texel size |

### 2.2 Daylight: `setDaylight(dateUTC, cloud)`

The reference had a fixed sun. Here the sun goes where it really is for the hour on screen, so a
winter-morning preset looks like a winter morning.

1. **Solar position.** The azimuth comes from `sc_sunPosition`, using the U.S. Naval Observatory
   low-precision formulas ("Approximate Solar Coordinates"), with *d* = days from J2000.0:

   - mean anomaly *g* = 357.529° + 0.98560028° *d*;
   - mean longitude *q* = 280.459° + 0.98564736° *d*;
   - ecliptic longitude *L* = *q* + 1.915° sin *g* + 0.020° sin 2*g*;
   - obliquity ε = 23.439° − 3.6·10⁻⁷ *d*;
   - α = atan2(cos ε sin *L*, cos *L*), δ = asin(sin ε sin *L*);
   - GMST = 18.697374558 h + 24.06570982441908 h · *d*;
   - hour angle *H* = GMST·15° + λ − α.

   Then elevation *e* = asin(sin φ sin δ + cos φ cos δ cos *H*) and azimuth
   *A* = atan2(−sin *H*, tan δ cos φ − sin φ cos *H*), clockwise from north.

   The elevation is taken from meteo.js `solarElevation()` when that exists. The sun on screen and
   the stability class (SRDT by day) then agree.
2. **Light elevation.** The light's elevation is max(*e*, 15°). At 5° a 30 m slab throws a 340 m
   shadow and the streets disappear in it. At 15° the shadow is 3.7 H, which still reads as a low
   evening sun.
3. **Intensity.** *I*_sun = lerp(0.35, 2.1·(1 − 0.7 *c*), *k*), with *k* = smoothstep(−4°, 20°, *e*)
   and *c* the cloud cover as 0–1 (Open-Meteo's 0–100 % is accepted too). The factor 0.7 keeps a
   trace of direction under overcast, as the reference kept 26 % of its sun under heavy rain.
   The hemisphere is scaled by (1 + 0.35 *c*) by day.
4. **Night** (*e* < −6°, civil twilight). A weak, cool, shadowless key light comes from high in the
   SSW, and the hemisphere is set to 1.0. The scene is a daylight model (architecture §7): it has to
   stay readable at 03:00, when the pollution often peaks.
5. **Sky and fog.**
   - The clear pair (`#9fb6c8` / `#dde5e8`) blends toward the reference's overcast pair
     (`#6d7b86` / `#a9b3b8`) with *c*.
   - The horizon warms (`#e8cfb2`) near sunrise and sunset, and goes blue-grey (`#44536a` /
     `#8390a0`) at night.
   - Overcast brings the fog in to 70 % / 80 % of its clear distances.

Before the UI first sets the hour, a fixed sun from the south-west at about 45° is used (the
reference's direction).

**Validation** (`scene: sun position and daylight`):

| Case | Model | Expected |
|---|---|---|
| June solstice, 10:58 UTC | elevation 67.63°, azimuth 180.05° | 90 − 45.80 + 23.44 = 67.64°, 180° |
| December solstice, 11:03 UTC | 20.74° | 20.76° |

### 2.3 Materials (`M`)

Flat ground layers use `polygonOffset` (factor −*layer*, units −2·*layer*) on top of small height
offsets of 4–30 cm. With near = 2 m and a 24-bit depth buffer, depth resolves only about 3 cm at 1 km,
and the "plan" camera sits 1 km up. The offsets keep the layers from flickering.

| Layer (bottom → top) | Material | y (m) | Colour |
|---|---|---|---|
| ground disc (6.5 km) | `M.ground` | 0 | `#d6d4cb` |
| green (parks, grass) | `M.grass` | 0.04 | `#b8cea0` |
| paved squares | `M.paved` | 0.07 | `#cbc6ba` |
| water | `M.water` (standard) | 0.08 | `#6f94a6` |
| footways, cycle tracks | `M.footway`, `M.cycleway` | 0.10–0.11 | `#dcd8cd`, `#c99a8e` (the cycle tracks are red-surfaced on the 2022 orthophoto) |
| rail bed, rail | `M.railBed`, `M.rail` | 0.12–0.16 | `#b3ab9c`, `#6d6862` |
| service roads | `M.gravel` | 0.14 | `#ddd2b6` (reference) |
| tertiary, residential | `M.asphalt` | 0.18 | `#8d9193` (reference) |
| primary, secondary | `M.asphaltMain` | 0.22 | `#80858a` |
| tram bed | `M.tramBed` | 0.25–0.26 | `#a7a197` |
| tram tracks | `M.tram` | 0.30 | `#5a5f63` (reference) |
| source overlay (hidden by default) | per group | 0.45–0.5 | `CITY_SOURCE_GROUPS` |

### 2.4 Geometry helpers

- **`flatGeometry(polys, y)`** triangulates `[[x, z], …]` rings with `THREE.Shape`, which lies in
  the x/y plane, so z is mirrored into −y. The shapes are rotated flat and merged into one
  upward-facing geometry (reference).
- **`ribbonGeometry(lines, widthOf, y)`** draws a flat band of full width *w* along each polyline.
  - Interior vertices get a **mitred join**: offset along the bisector by *w*/2 / cos(θ/2), where θ
    is the turn angle.
  - A turn sharper than about 100° (mitre factor > 1.6) falls back to a bevel, so a hairpin cannot
    spike out.
  - Only the two ends are extended, by min(0.3 *w*, 3 m), which closes the gap at a T-junction.
  - The reference instead extended *every segment* by 0.3 *w*. That is fine at its 4–16 m road
    widths, but it overshoots badly with the 20–40 m carriageways of `env.json`.
  - All triangles are wound to face +y.
- **`addMesh(geo, mat, {shadow, parent, order})`** is the reference helper. It returns `null` for an
  empty geometry.

---

## 3. The city (city.js)

### 3.1 LoD1 or LoD2?

ZG3D 2022 (Grad Zagreb, LiDAR-updated) offers both a LoD2 multipatch (roof shapes) and the LoD1
extents derived from it (lidar-3d §3.2).

| | LoD1 prisms (default) | LoD2 mesh (optional) |
|---|---|---|
| What | footprint (RDP 0.6 m) extruded from `b` to `h` (`h` = Z_Max − DTM) | ZG3D faces triangulated, int16 decimetres |
| Coverage | all 4,309 parts in the ±750 m box | 72,947 triangles within 500 m (1.39 MB) |
| Used by the flow | **yes**: `cityGeometry()` → voxel.js | no |
| Why | the LBM runs on 5 m cells; roof shape below one cell is not resolved, and a prism is what the voxeliser scan-converts. The display then shows exactly the obstacles the flow sees. | pitched roofs, towers and setbacks make the neighbourhood recognisable close up |

`setLod2(true)` decodes the mesh the first time, after the current frame. It then shows the mesh
and **hides the LoD1 prisms within 500 m**: the LoD1 set is split at build time by footprint
centroid into an inner mesh (≤ `SITE.extent.lod2_radius_m`) and an outer mesh. Outside the radius
the LoD1 prisms stay, so the city has no hole. The UI must say that LoD2 is display-only. LoD1 is
what the wind simulation uses.

### 3.2 LoD1 prisms

For each `ENV.buildings[i] = {p, b, h, s, k, id}`:

1. **Validate.** The ring must have ≥ 3 finite points and area > 0.5 m², with the repeated end point
   dropped, and *h* > *b* ≥ 0. Two of the 4,309 parts fail this and are dropped (see `skipped`).
2. **Station container filter** (critic §4.2, "Container: excluded from the mask"). A part is
   treated as the container, or as something standing in its place, and dropped when:
   - its OSM id ends in `SITE.station.osm_way` (1409603653); or
   - its footprint contains the inlet; or
   - its footprint is < 60 m² and centred within 6 m of `env.station`.

   None of today's parts matches. The rule protects against an OSM fallback that maps the container
   as a building.
3. **Orient.** The ring is made counter-clockwise in the (x, z) shoelace sense.
   - Wall normals (Δz, 0, −Δx)/ℓ then point outward. Each wall is two triangles (b1, t2, b2) and
     (b1, t1, t2).
   - The roof is triangulated with `THREE.ShapeUtils` (earcut). Each triangle is turned to face
     +y; floors are drawn for floating parts (*b* > 0.5 m, e.g. canopies and bridges) facing −y.
   - `env.json` stores courtyards as single keyhole rings with zero-width bridges (even-odd fill).
     Earcut triangulates them directly. The inner walls get courtyard-facing normals automatically,
     because the hole is traversed the other way. The bridge walls have zero area.
4. **Colour** (vertex colours, reference rule):
   - walls HSL(0.10, 0.12, 0.84 + 0.06·*r*);
   - "small" parts (*h* ≤ 11 m and < 450 m², the Trnje family houses) get red-tile roofs
     HSL(0.035–0.055, 0.42, 0.44–0.52);
   - the rest get light grey roofs HSL(0.10, 0.05, 0.74–0.80).

   Here *r* is a deterministic hash of the building index, so both views and every reload look
   identical.
5. **Merge** into two meshes (inner/outer, §3.1) that cast and receive shadows. Per vertex, the mesh
   keeps the building index and a roof flag, so `colorBuildings()` rewrites the colour attribute
   without rebuilding.

Result for the current `env.json`: 4,307 prisms, 222,549 vertices, 74,175 triangles, 2 draw calls.

**Colour modes** (`colorBuildings(mode)`, legend from `buildingLegendHTML(mode)`):

| Mode | Classes and colours | Reason |
|---|---|---|
| `plain` | reference palette above | – |
| `year` | 2008 aerial photogrammetry `#2a78d6` (3,042 parts) · 2019 drone survey `#eb6834` (231) · 2022 LiDAR + multisensor `#1baf7a` (953) · OSM fallback, not in ZG3D `#a19f98` (78) | ZG3D `Godina_izv` (lidar-3d §3.2). The three years use slots 1–3 of the validated categorical palette (dataviz skill; all-pairs CVD ΔE ≥ 9.2). The OSM fallback (height 3.0·levels + 5.5 m, critic §1.9) is neutral grey on purpose: "not measured". |
| `height` | < 6, 6–12, 12–20, 20–30, 30–45, ≥ 45 m on blue steps 100/200/300/400/500/650 of the reference palette | breaks around the ZG3D distribution (median 5.6 m, p95 24.4 m, max 98 m; lidar-3d §3.2): 1–2 storeys, 3–4, 5–6, 7–10, 11–15, taller |

Walls are 20–30 % lighter than roofs in the data modes, so the shading still shows the form.
Proposed (scenario) volumes keep their own colour in every mode.

**X-ray** (`setXray(on)`) draws the existing buildings at 28 % opacity with no shadow casting, so the
slice, particles and streaks stay visible inside street canyons. It is the reference's "x-ray roofs"
toggle.

### 3.3 LoD2 (`decodeLod2`)

The `lod2.bin` format (architecture §4.1, little-endian):

| Bytes | Content |
|---|---|
| 16 | header: `ZL2B`, uint32 version = 1, uint32 nTri, uint32 0 |
| nTri × 18 | Int16 x, y, z per vertex, in decimetres; y is above ground |
| nTri | Uint8 class = source year − 2000 (0 = unknown) |
| – | zero padding to 4 bytes |

`decodeLod2(src)` accepts base64 text, an `ArrayBuffer` or a `Uint8Array`. It returns
`{version, nTri, pos (m), cls}` and **throws** on a bad magic number, an unknown version or a buffer
shorter than its header promises. If the mesh fails to decode, `setLod2` resolves `false` and the
city stays LoD1.

The mesh is non-indexed, with one flat normal per triangle (`computeVertexNormals`), and uses
`DoubleSide`, because multipatch ring orientation is not guaranteed.

Colours:

| Mode | Rule |
|---|---|
| `plain` | walls (\|n_y\| ≤ 0.45) as LoD1; sloped roof faces below 12 m in red tile; other roofs light grey |
| `year` | from the triangle class |
| `height` | from the vertex height (LoD2 has no building ids) |

### 3.4 Roads, tram, rail

| Class `c` | Drawn as | Width |
|---|---|---|
| 0–1 primary/trunk/secondary | `asphaltMain` | `w` from env.json |
| 2–3 tertiary/residential | `asphalt` | `w` |
| 4 service | `gravel` | `w` |
| 5 footway/path/pedestrian | `footway` | min(`w`, 3 m) |
| 5 cycleway | `cycleway` | min(`w`, 2.5 m) |

When `w` is missing: lanes × 3.25 m (architecture §4.1), else the reference's per-class widths
16/9/6/4.5/2.2 m, and 2.5 m for non-motor ways.

`env.json` already carries the orthophoto-checked Miramarska carriageways near the station (critic
§1.6: southbound band at x = +12…+25.5 m).

**Tram.** The Vukovarska tram runs on its own reservation between the carriageways.

- **Width.** The reservation is ≈ 7 m wide, measured on the 0.5 m city orthophoto
  (`research/data/critic/zg_orto2022_300m.jpg`) at x = −125 m, where it spans z ≈ +55…+62 m.
- **Mapping.** OSM maps its two tracks as separate ways ~3.3 m apart (z = +52.8 and +56.0 at x = 0).
  Each track in the reservation gets a 3.6 m bed (half of 7 m, plus the overlap), and the two beds
  merge into a ≈ 7 m strip.
- **In or out.** A tram segment counts as "in the reservation" when it runs within 30 m of a
  Vukovarska (group A) carriageway. Other tram segments get a 2.8 m bed: sleeper length 2.4–2.6 m
  plus a margin.
- **Tracks.** The tracks themselves are 1.6 m dark bands (reference).
- **Rail.** Rail gets a 3.0 m bed and a 1.6 m track.

### 3.5 Trees

- **Sources.** Trees come from `ENV.trees` (1,828 today: 1,827 OSM plus the station tree). If the
  geo pipeline did not already include the station tree (`env.station.tree`, critic §1.6: an ≈ 18 m
  crown 5 m W and 10 m N of the inlet), it is added.
- **Crown model.** The crown is an ellipsoid with horizontal radius *r* and vertical semi-axis
  *r*_v = clamp(½(*h* − 2.5 m), 0.8 m, 1.2 *r*), sitting on a crown base *c*_b = *h* − 2 *r*_v.
  - The 2.5 m clear stem is the usual footway clearance (a design choice).
  - The 1.2 cap keeps crowns from turning into columns.
  - `cityGeometry()` hands exactly this crown (`cb`) to the voxeliser, and voxel.js uses `tr.cb`
    when present. The drawn crown and the porous crown are therefore the same.
- **Instancing.** One `InstancedMesh` per detail level:
  - within 450 m of the station: icosahedron detail 1 (80 triangles), shadow-casting, with a trunk
    (5-sided cylinder, radius 0.02 *h*, 0.12–0.45 m);
  - beyond 450 m: detail 0 (20 triangles), no shadow (the reference used 430 m around its stadium).
- **Variation.** Only the yaw and a ±6 % horizontal squash are random (deterministic per tree).
- **Leaf modes** (`setLeaves`, critic §4.3):

  | Mode | Display | Flow (`lad`, m²/m³) |
  |---|---|---|
  | `on` (May–October) | reference greens; scenario-added trees a fresher yellow-green | 1.2 |
  | `off` | grey-brown crowns at 42 % opacity, no tree shadows | 0.3 |
  | `none` | trees hidden | trees removed from `cityGeometry` |

  `setLeaves` emits `Bus 'city:changed' {scenario: '*', leaves}`, because every scenario's flow
  depends on the leaf mode.

### 3.6 The station

The station is drawn from `env.station`. None of it enters `cityGeometry()`.

- **Container.** The `container` ring, 2.6 m high: an ISO container is 2.59 m (8 ft 6 in).
- **Mast.** A steel mast from the roof to the inlet at `RECEPTOR` (4.0 m; EEA metadata, critic
  §1.6), so it rises 1.4 m above the roof. The Action Plan 2015 (critic §1.6) says the inlet is "na
  krovu kontejnera", on the container roof.
- **Inlet.** A yellow inlet head, drawn without tone mapping, with a 1.4 m halo ring.
- **Beacon.** A thin translucent beacon up to 40 m, above the 31 m slab north of the park, with the
  label "ZAGREB-1" at its top. From the air the station is otherwise a 3 m box.

### 3.7 Labels

`buildCity().labels` = `[{text, key?, pos, kind}]`. The entries come from:

- `ENV.labels` (roads at 3 m, water at 4 m, parks at 8 m, POIs at 14 m; reference heights);
- `ENV.pois` whose name is not already a label;
- the station label (with an i18n key).

Scenario layers carry their own labels in `userData.labels` (kind `scenario`). The kinds become CSS
classes: `lbl lbl-road`, `lbl-park`, `lbl-water`, `lbl-poi`, `lbl-station`, `lbl-scenario`.

---

## 4. `cityGeometry(scenarioId)`: what the flow sees

```jsonc
{ "id": "block", "leaves": "on",
  "prisms":  [ { "p": [[x, z], …], "b": 0, "h": 22, "s": 1, "year": 0, "id": "scenario:block-n", "k": "scenario" }, … ],
  "trees":   [ { "x": -5, "z": -10, "h": 14, "r": 4.79, "lad": 1.2, "cb": 2.5 }, … ],
  "roads":   ENV.roads, "heating": ENV.heating }
```

- **`s` is the solid fraction** read by voxel.js (1 = building). In `env.json`, `s` is the ZG3D
  source year, so the year is carried as `year` instead.
- **What changes per scenario.**
  - The container never appears (§3.2). Test `scene: the station container never enters the flow
    geometry` checks this for every scenario.
  - Removed buildings (`ct_REMOVE`, empty for the built-in scenarios) are dropped, and added volumes
    are appended.
  - Trees follow the scenario (§5) and the leaf mode.
- **Caching.** The result is cached per (scenario, leaf mode, custom-block version) and must be
  treated as read-only.
- **Custom block.** `setCustomBlock()` bumps the version and emits
  `Bus 'city:changed' {scenario: 'custom', block}`.
- **No renderer needed.** The function never touches THREE or the GPU, so voxel.js, aero.js and the
  tests can call it without `buildCity()`.

---

## 5. Scenarios

All scenario volumes are **hypothetical examples, not plans**, and the scenario description text in
the UI says so.

Coordinates are in the local frame: x east, z south, metres from the inlet. `rot` is in degrees,
clockwise seen from above. The street grid here is turned −4° from true north (Vukovarska
86°/266°, Miramarska 176°/356°; site-context §3.1), and the volumes are aligned with it.

The locations were chosen on the 0.1 m and 0.5 m 2022 city orthophotos
(`research/data/critic/zg_orto2022_80m_marked.jpg`, `zg_orto2022_300m.jpg`), the 1 m DGU mosaic
(`research/data/lidar/dgu_dof_lidar_2022_bbox_1500px.jpg`) and the OSM land-use polygons. They were
checked against the final `env.json` footprints.

```
            z = −90 ┌──────────────────┐ 28 m offices        N (−z)
                    │ tower 80 m       │                     ↑
            z = −54 └──────────────────┘ x 77…101
  ═══════ 31 m slab (z −43…−33) ═══════   Trg S. Radića road (z ≈ −41)
   ┌─────────── block 22 m ──────────┐ ║ M ║    Park Stjepana Srkulja
   │   ┌─── courtyard 12 × 24 ───┐   │ ║ i ║    ┌ custom (default) ┐
   │   └─────────────────────────┘   │ ✚ r ║    └──────────────────┘
   └──── x −44 … −10, z −28 … +18 ───┘ ║ a ║
  ─ path / service road (z ≈ +22…+44) ─────────────────────────────
  ════ Vukovarska WB ════ tram reservation (≈ 7 m) ════ EB ═══════
                         ✚ = ZAGREB-1 inlet (0, 0)
```

| id | What | Geometry | Why here |
|---|---|---|---|
| `today` | the city as built | env.json | – |
| `trees` | double rows of street trees along Vukovarska and Miramarska within 400 m, plus the median where there is room | 365 new trees, 14 m tall, crown radius 4.5 m (§5.1) | the most common real-world greening measure for a traffic hot spot. Street trees can trap traffic pollution in a street as well as filter it (wind-tunnel work by Gromke & Ruck 2007, *Atmos. Environ.* 41; review by Vos et al. 2013, *Environ. Pollut.* 183), which is exactly what the 3D flow can show |
| `block` | a closed 7-storey perimeter block | 34 × 46 m outer, wings 11 m deep, courtyard 12 × 24 m, centre (−27, −5), rot −4°, 22 m; four wing prisms | see §5.2 |
| `tower` | an 80 m tower | 24 × 24 m, centre (89, −66), rot −4°, 80 m | see §5.3 |
| `notrees` | all trees removed | – | shows what the trees do to the flow |
| `custom` | one user-placed box | default 40 × 24 m, centre (75, −10), 25 m, rot −4° (Park Stjepana Srkulja, across Miramarska); limits: side 3–300 m, height 3–100 m, centre within ±750 m | the 160 m tunnel (architecture §5.1) keeps ≥ 60 m of free air above a 100 m block; below 3 m a block vanishes in the 5 m voxels |

**How new volumes treat trees** (`ct_treeVsPrisms`):

- A trunk inside a new prism, or within 1.5 m of its wall, is removed. Courtyard trees stay.
- A crown that would reach into a new wall is **pruned** to clear the facade by 0.5 m, down to a
  1.5 m radius at least (ordinary facade-clearance pruning).

The block removes 9 trees and prunes the station tree from 9 m to 4.8 m, because its trunk is 5.3 m
from the east wing. The custom default removes 6.

### 5.1 The street-tree rule (`trees`)

The trees are placed by rule, not by hand, so the same rule works on any future `env.json`:

1. **Candidates.** Along every group-A (Vukovarska) and group-B (Miramarska) carriageway with a
   vertex within 460 m of the station, every 10 m of arc length, on both sides, in two rows 2.5 m
   and 8.5 m beyond the kerb: the verge row and the back-of-footway row.
   - The 10 m spacing is a design choice within the usual 8–12 m for large-crowned avenue trees.
   - On a dual carriageway, the inner-side candidates fall into the median.
2. **Keep a candidate only where it is clear of everything.** Each check is an equation on the
   distances:

   | Keep-out | Distance | Source / reason |
   |---|---|---|
   | Any motor carriageway (c ≤ 4) | ≥ *w*/2 + 1.0 m from its centreline | – |
   | Tram track centreline | ≥ 3.0 m (outside the reservation) | – |
   | Building footprints | ≥ 2.0 m, and never inside one; floating parts with b > 3 m are ignored | – |
   | Sampling inlet | ≥ 8 m | AAQD 2008/50/EC Annex III C: unrestricted flow around the inlet, "normally some metres away from … trees" |
   | Neighbouring crowns (existing trees and those already placed) | spacing ≥ max(6 m, 0.75 (*r*₁ + *r*₂)), i.e. at most 25 % crown overlap | – |
   | Radius | within 400 m of the inlet | the task definition |

3. **Size.** Height 14 m and crown radius 4.5 m, the middle of the 12–18 m and 4–6 m range for
   mature *Platanus* and *Tilia*, the commonest street trees here (site-context §5, §9.1).

**Result:** 365 trees; the smallest kerb clearance is 1.03 m (test `scene: street trees follow the
planting rule`).

**Median: none planted, and this is a finding, not a bug.** Within 400 m no median has room under
the rule:

- Miramarska's median north of Vukovarska is 0.5–1 m wide (the SB/NB carriageway edges at +25.75
  and +26.25 m; critic §1.6: "+25.5 to +26.5 m").
- Vukovarska's 8.4 m median is taken by the two tram tracks, which leave < 2.5 m on either side.

A median row would need a road redesign (e.g. one fewer lane), which changes the emission sources.
That is beyond a geometry scenario. The rule plants median trees automatically if a future
`env.json` maps a wider median.

### 5.2 The block

**Site.** The Park Drage Galića lawn (OSM `leisure=park`, 5,428 m²), where the station stands. It is
the open ground between:

- the station (x = 0);
- the 31 m slab to the north (z ≤ −33 in the final env);
- the 9 m pavilion to the west (x ≤ −47);
- the path and Vukovarska service road to the south (z ≥ +22).

**Footprint.** A 34 × 46 m closed block (x −44…−10, z −28…+18) fills the lawn with 2–5 m to spare.
Test `scene: scenario volumes stand clear of existing buildings and the inlet` reports 0 overlaps.
Its east facade is 10 m from the inlet.

**Height.** 22 m = a 4 m ground floor + 6 × 3.0 m (G+6, flat roof). For comparison, the ZG3D fit for
existing 7-level buildings (3.03·L + 5.81 m, critic §1.9) gives 27 m, with their tall storeys and
pitched roofs.

**Why this site.** The block turns the station into a street-canyon site. That is the classic
representativeness question for a traffic station: how much does the value measured depend on what
stands next to the inlet?

### 5.3 The tower

**Site.** The surface car park at x 74…105, z −83…−49 (OSM `amenity=parking`, 950 m²). It lies north
of the Trg Stjepana Radića access road, between the small park at Miramarska and the 28 m office
block to the east (x ≥ 106).

**Size.** A 24 × 24 m tower, 4 m clear of that block. 80 m is within the height range the district
already has: the 96 m Eurotower stands 390 m to the SW (site-context §2).

**Why this site.**

- It is 110 m from the inlet at bearing 53°, so it is upwind of the station in the most frequent
  NNE–NE winds (critic §4.5, default preset 45° at 1.7 m/s).
- It sits inside every 600 m tunnel, whatever the wind direction: it is ≤ 300 m from the station,
  and the tunnel has the station 300 m from the inlet, centred across.
- The candidate brownfields (Geofizika at Bednjanska, 275 m NW; the former Vage factory, 400 m N)
  were rejected because they lie at the tunnel inlet for their own wind directions.

### 5.4 Two views, one scene

Both views render the same `scene`. What differs lives in per-scenario groups:

| Layer | Contents | `userData.hide` (alias `hides`) |
|---|---|---|
| `scenarioLayer('trees')` | the added trees | – |
| `block`, `tower`, `custom` | the proposed volumes (pale ochre `#f1cf9c` "planning model" tint with dark outlines) and, because they remove or prune trees, their own copy of the tree set | the base-tree wrapper group |
| `notrees` | nothing | the base-tree wrapper group |

Before drawing each view, either:

- call `cityView(null)` for the today view and `cityView(id)` for the scenario view; or
- toggle `layer.visible` and the objects in `layer.userData.hides` yourself (main.js does this).

The base trees sit inside a wrapper group (`city.treesRoot`), and only that wrapper is ever hidden by
a scenario. The leaf mode switches the tree set *inside* it. The two switches are on different
objects, so a caller that toggles `hides` can never undo leaf mode `none`.

Per-view data overlays (a `ConcSlice`, `Particles` and `WindStreaks` each) go under one group per
view, shown only while that view is drawn.

---

## 6. Visual encodings (visuals.js)

### 6.1 Concentration colour scales

`CONC_SCALES[p]` holds, for each of nox, no2, pm10, pm25, co, c6h6, o3 and so2:

- five break points (upper bounds of bands 1–5) and six colours;
- the band names (EAQI pollutants only);
- the source of the breaks.

Values are in display units (µg/m³, CO in mg/m³; architecture §2). A value equal to a break falls in
the upper band. `concBand(v, s)` gives 1…6, and `concColor(v, s, out)` gives sRGB bytes plus the
band's opacity (non-finite values give a fully transparent colour).

| Pollutant | Breaks (upper bounds of bands 1–5) | Source |
|---|---|---|
| NO₂ | 10, 25, 60, 100, 150 µg/m³ | revised EEA EAQI, ETC HE Report 2024/17, hourly (iszz-api §9.3); read from chemistry.js `EAQI_BANDS` when present (it is), else the same table here |
| PM₁₀ | 15, 45, 120, 195, 270 | as NO₂ |
| PM₂.₅ | 5, 15, 50, 90, 140 | as NO₂ |
| O₃ | 60, 100, 120, 160, 180 | as NO₂ |
| SO₂ | 20, 40, 125, 190, 275 | as NO₂ |
| NOx | 25, 50, 100, 200, 400 µg/m³ (unnamed ranges) | no EAQI and no health limit. Doubling steps span the ZAGREB-4 night background (~16) up to ZAGREB-1 rush hour (weekday 07 h mean 135, critic §1.2) and its peaks. |
| CO | 0.5, 1, 2, 4, 10 mg/m³ | 4 = AAQD 2024/2881 24-h limit, 10 = 8-h limit (iszz-api §9.1) |
| Benzene | 0.5, 1, 1.7, 3.4, 5 µg/m³ | 1.7 = assessment threshold and WHO 1:100,000 lifetime risk; 3.4 = 2030 annual limit; 5 = current annual limit (iszz-api §9.1) |

**Palettes** (`setConcPalette`), both with six colours, band 1 first:

- **`cb` (default)**, colour-blind safe: `#b679e1 #9f62c8 #884baf #723497 #5c1c80 #460067`.
  - One hue (violet, OKLCH h = 310°). OKLab lightness steps in equal intervals from 0.68 to 0.305,
    so the order is carried by lightness alone, which people with any type of colour-vision
    deficiency see.
  - Checked with the dataviz skill's validator as an ordinal ramp:

    | Check | Page surface `#fcfcfb` | 3D ground `#d6d4cb` |
    |---|---|---|
    | Lightness monotone | pass | pass |
    | Every adjacent ΔL ≥ 0.06 | pass | pass |
    | Single hue | pass | pass |
    | Light-end contrast ≥ 2:1 | 3.0:1 | 2.1:1 |

  - Violet appears nowhere else in the scene, so the slice never blends into roofs, grass or roads.
  - One-hue ramps in orange and red also passed, but they make "good" air look alarming.
- **`eaqi`**: the official EEA colours `#50F0E6 #50CCAA #F0E641 #FF5050 #960032 #7D2181`, for
  comparison with airindex.eea.europa.eu and the ISZZ portal. Their lightness is not monotone
  (yellow band 3 is lighter than teal band 2), so the legend always prints the band names too.
- **Opacity per band on the slice:** 56, 96, 140, 180, 208, 228 (out of 255). With a real
  background (NO₂ ≈ 20 µg/m³ at ZAGREB-4, band 2), most of the domain sits in bands 1–2. The visual
  check showed that a heavier veil there hid the streets, so the low bands stay below 40 %.

**Legend** (`legendHTML(p)`): a title with the label and unit (from `POLLUTANT_INFO` when present),
six rows (swatch, range text and, for EAQI pollutants, the band name) and a note naming the band
source. The swatch is `aria-hidden`; the text carries the meaning (architecture §7).

CSS classes used: `legend`, `legend-conc`, `legend-title`, `legend-swatch`, `legend-range`,
`legend-name`, `legend-note`. `buildingLegendHTML()` and `particleLegendHTML()` use the same classes,
plus `legend-buildings`, `legend-particles` and `legend-dot`.

### 6.2 Concentration slice (`ConcSlice`)

- **Plane.** One texel per cell, `DataTexture` in sRGB with linear filtering, on a plane in the
  field's tunnel frame. The basis is (e_x, e_y, e_x × e_y), centred on the domain, at the chosen
  height (reference `SliceView`).
- **Input.** Any field with `{frame, dx, nx, ny, nz?, mask?, slice(h)}`:
  - `slice(h)` returns per cell γ_A…γ_D followed by the ages (stride 8), or γ only (stride 4);
  - a field with only `gamma`/`age` arrays is sliced here, linearly between the two layers around
    *h*;
  - `ConcSlice.gridField(grid, data, stride)` wraps a world-aligned grid such as
    `FallbackModel.slice()`, with (x0, z0) the corner of cell (0, 0).
- **Colour.** `valueFn(γ4, age4)` (e.g. model.js `cellValue`) turns each cell into a concentration,
  which `concColor` colours.
- **Solids.** Cells inside buildings (mask ≥ 250 at layer ⌊*h*/dx⌋) are transparent.
- **Edge fade.** The edges fade over 80 m, the outflow sponge length (critic §4.4): the outer cells
  feel the boundary conditions (zero at the inflow, open sides, the sponge), so they are shown
  faintly rather than cut hard.
- **Rebuilds.** The texture is rebuilt only when the field, height, `valueFn` or scale change, so
  the caller should keep the same function object until its inputs change.
- **No tone mapping.** The slice is drawn with `toneMapped: false`, so at full opacity the screen
  colour is the legend colour. (The reference's wind slice went through ACES, which shifts hues.)

### 6.3 Particles (display only)

**Release.** Tracers are released in proportion to emission.

- A road segment weighs length × AADT / 10,000 (the same unit voxel.js rasterises, architecture
  §5.3). A heating triangle weighs area × *w*.
- Each weight is multiplied by the group's strength *q*_k from `setStrengths()`. The default is
  A = B = C = 1, D = 0: equal per-vehicle emission, heating off.
- With *q*_k from emissions.js `groupStrengths()`, the weights become g/s, so the colour mix on
  screen is the emission mix.
- Roads release across the carriageway width at 0.5–2 m. Heating releases at roof level, 8 m
  (architecture §5.3).
- Only sources inside the field's tunnel are used.

**Motion.** Each step is

> **p** ← **p** + **u**(**p**) *U*₁₀ Δ*t* + √(2 *K* Δ*t*) **ξ**,
> with *K* = κ û\* *U*₁₀ (max(*z*, H̄) − *d*)

- **u** = `WindField.vel`, the fraction of *U*₁₀ in world axes.
- *K* is the neutral K-theory diffusivity of physics §4 eq. 4.2, with κ = 0.4, û\* = 0.162 (the
  physics §6.2 neutral example), H̄ = 14 m and *d* = 7 m (`SITE.model_defaults`).
- **ξ** is a standard normal deviate from the seeded `rand()`, so screenshots repeat.
- Particles reflect at the ground and respawn when they die, leave the domain or enter a building.

**Time.** Time runs 6× real (1 s on screen = 6 s of flow), so a parcel at 0.5 m/s visibly moves.
Lifetimes of 15–30 screen seconds (90–180 s of flow) cover the ~60 s plume age typical at the
receptor (critic §4.4).

**Colour and opacity.** Colour tells the source group (`CITY_SOURCE_GROUPS`):

| Group | Colour |
|---|---|
| A, Vukovarska | `#2a78d6` |
| B, Miramarska | `#eb6834` |
| C, other roads | `#1baf7a` |
| D, heating | `#6b625a` |

A–C are slots 1–3 of the validated categorical palette: all-pairs CVD ΔE ≥ 9.2 on the ground colour
(worst pair aqua/orange under deutan). D is a deliberate neutral smoke grey, the "rest" class, so the
three traffic groups are the only hues. Their contrast on the light ground is below 3:1, so
`particleLegendHTML()` names every group (the relief rule of the dataviz method).

Opacity fades in over 0.8 s and out over the last 35 % of life. Point size is 1.6 m in world
units, 2–10 px. 4,000 particles per view.

**Reduced motion.** Particles and streaks freeze under `prefers-reduced-motion`.

### 6.4 Wind streaks and labels (reference ports)

- **`WindStreaks`**: 700 trails of 9 points, history shifted every 0.11 s, speed × 2.2, lifetimes
  2.5–6.5 s, heights 2–57 m biased low (all reference values). The field is passed to
  `update(dt, windField, u10, visible)`. Trails start in the tunnel's central 80 % × 74 %: the
  reference's −240…+180 m along and ±220 m across its tunnel, scaled to the 600 × 600 m tunnel.
- **`LabelLayer`** places HTML labels pinned to 3D points. They are hidden behind the camera or off
  screen, and fade between 1.5 and 2.6 km (reference). New in the port:
  - `add(text, pos, kind, key)`: a label with an i18n key is re-translated on a language change;
  - `addAll(list)`, `remove(item)`, `clear()`;
  - decluttering (integration review, 2026-09-28): after placing, labels are taken greedily by kind (station,
    scenario, road, park, water, POI) and, within a kind, nearest first; a label whose box would overlap an
    already placed one (plus a 3 px gap) is hidden for that frame. This removed the overlaps of the air view,
    e.g. "INA Zagreb-Miramarska" over "Park Adolfa Mošinskog".

---

## 7. Performance

Target: 60 fps on a laptop GPU with the whole neighbourhood and two views.

| Item | Count (current env.json) | How |
|---|---|---|
| LoD1 buildings | 4,307 prisms → 74,175 triangles in **2** draw calls | merged, vertex colours, no per-building objects |
| Trees | 1,828 → 4 draw calls (near/far crowns + trunks) | `InstancedMesh`, 80 / 20 triangles per crown |
| Roads, ground layers | ~15 draw calls | one merged ribbon per material |
| LoD2 (optional) | 72,947 triangles, 1 draw call | one mesh; LoD1 inner mesh hidden |
| **Per view** | 22–27 draw calls, 94k (no trees) to 191k (tree scenario) triangles | measured in the harness from `renderer.info` |

- **Shadow pass.** It repeats the geometry once per view. That is ~0.4 M triangles per view,
  < 1 M per frame for two views: well inside a laptop GPU's budget.
- **Recolouring.** `colorBuildings()` rewrites 222k vertex colours in a few milliseconds.
- **Scenario layers** are built on first use; the custom layer is rebuilt on each `setCustomBlock`.
- **Software GL.** On SwiftShader (headless tests) both views render in 74–120 ms per frame at
  1440 × 900 with the 2048² shadow map. That is interactive enough for checks. Use `?grid=coarse`
  for the LBM on software renderers.
- **Build time.** `buildCity()` takes 140–210 ms on SwiftShader, mostly triangulation.
- **Slice and particles.** The slice texture (14,400 cells at 5 m) is rebuilt only on input
  changes. Particles cost one trilinear `vel()` and one `sample()` per particle per frame.

---

## 8. Validation

**In-page tests.** `python3 tests/browser/run_selftest.py --only scene` (SwiftShader) runs 15 tests
in `src/js/tests/scene.test.js`. All pass with the current data:

| Test | Result |
|---|---|
| prisms match ENV.buildings | 4,309 → 4,307 prisms (2 invalid, 0 container) |
| LoD1 mesh: no NaN, winding | 74,175 triangles, 0 wound against their normal |
| cityGeometry for every scenario | today 4,307 prisms / 1,828 trees · trees +365 trees · block +4 prisms, −9 trees · tower +1 (80 m) · notrees 0 trees · custom +1 |
| container never in the flow | no prism contains the inlet in any scenario; filter recognises the ring and the OSM id |
| scenario volumes clear | 0 overlaps with existing buildings; ≥ 8 m from the inlet; station tree pruned to 4.79 m, 5.3 m from the wall |
| custom block | position, area and clamping; `Bus` event; trunks and crowns clear of it |
| leaf modes | LAD 1.2 / 0.3 / none; visibility with `cityView` and the `hides` alias |
| street-tree rule | 365 trees, min kerb clearance 1.03 m, all 8–400 m from the inlet |
| LoD2 decode, synthetic | decimetre scaling, classes, three input types; bad magic and truncation throw |
| LoD2 decode, baked | 72,947 triangles, max radius 527 m, heights 0–97.9 m |
| concColor monotonic | 8 pollutants × 2 palettes: band and opacity non-decreasing, OKLab L non-increasing (`cb`); NaN transparent; 6 legend rows |
| sun position | see §2.2 |
| ribbonGeometry | all up-facing; area 1,660 ± 30 m² for an L of 160 m × 10 m |
| ConcSlice | solid cells transparent, edge fade, rebuild only on change, grid-field adapter |
| Particles | release only from groups with weight, downwind drift |

**Visual checks.** Screenshots of a scratch harness (the scene files plus a minimal boot, outside the
repo) and of the full app (`tests/browser/smoke.py`) were compared with the reference's look. They
covered:

- the air, plan, close and eye-level cameras;
- every scenario;
- LoD2 on;
- the year colouring;
- night with overcast and leaf-off;
- slice, particles and streaks on a mock field.

Two changes came out of them: the lower slice opacity for bands 1–2, and the facade pruning of the
station tree in the block scenario.

---

## 9. Limitations

- **Hypothetical scenarios.** The scenario volumes are illustrations placed on real open ground. They
  are not planning proposals, and the block and tower have no internal detail: they are LoD1 boxes,
  like everything the flow sees.
- **No median trees.** With today's geometry, the "median" part of the tree scenario plants nothing
  (§5.1).
- **Display-only LoD2.** LoD2 is for display only. Near the 500 m boundary a building can show a
  seam where the LoD1 inner/outer split (by footprint centroid) and the LoD2 radius (by triangle)
  disagree.
- **Heuristic crowns.** The crown shape, and the 2.5 m clear stem, is a heuristic shared with
  voxel.js. OSM gives no heights or crown sizes (12 m / 4 m defaults), and the Meta CHM under-reads
  the station tree (critic G8).
- **Particles do not show concentration.** Particles show where emitted air goes, not how much of
  it there is. Their turbulence is the neutral K of the scalar solver, not the class-dependent one.
- **Not the solar-position standard.** The sun position is the USNO low-precision formula (about 1′
  within two centuries of 2000). That is ample for lighting, but it is not the NOAA/SPA standard;
  it matters only if meteo.js `solarElevation()` is ever missing.
- **Night lighting is not physical.** It is a legibility choice.
- **Label occlusion.** Labels are HTML and are not occlusion-tested; a label can show through a
  building (as in the reference). Labels no longer overlap each other (decluttering, §6), but a
  lower-priority label then disappears until the camera moves.

## 10. How to re-run

```bash
# in-page tests for this chapter (builds dist/test.html first)
python3 tests/browser/run_selftest.py --only scene

# the whole app, headless, with a screenshot (software WebGL: use the coarse grid)
python3 tests/browser/smoke.py --wait 300 --query "grid=coarse"

# interactive
make serve    # then open http://localhost:8000/?grid=coarse
```

Changing the data needs no code change:

- a new `env.json` or `lod2.bin` from `tools/build_env.py` is picked up by `python3 tools/build.py`;
- the street trees are regenerated by rule;
- the tests re-check the scenario volumes against the new footprints. `scene: scenario volumes
  stand clear…` fails if a future env frame shift makes the block or tower overlap a building. The
  coordinates in `ct_BLOCK` / `ct_TOWER` (city.js) are then the only thing to revisit.

## 11. Parameters (all in code with the same sources)

| Constant | Value | Source / reason | File |
|---|---|---|---|
| `ct_GRID_ROT` | −4° | Vukovarska 86°, Miramarska 176° (site-context §3.1) | city.js |
| `ct_LAD` | on 1.2, off 0.3 m²/m³ | critic §4.3, site-context §9.1 | city.js |
| `ct_TRUNK_MIN`, `ct_CROWN_ASPECT` | 2.5 m, 1.2 | footway clearance; crown shape (heuristic) | city.js |
| `ct_TREE_NEAR_R` | 450 m | detail / shadow radius (reference 430 m) | city.js |
| `ct_CONTAINER_H`, `ct_BEACON_H` | 2.6 m, 40 m | ISO container; above the 31 m slab | city.js |
| `ct_ROAD_W` | 16, 9, 6, 4.5, 2.2, 2.5 m | reference per-class widths (fallback) | city.js |
| `ct_TRAM` | bed 3.6 m (reservation) / 2.8 m, track 1.6 m, 30 m | orthophoto 7 m reservation; sleeper length; reference | city.js |
| `ct_STREET` | 14 m, r 4.5 m, 10 m, rows 2.5/8.5 m, 400 m, clearances 8 / 3.0 / 2.0 / 1.0 m, overlap 0.75, min gap 6 m | §5.1 | city.js |
| `ct_PRUNE` | trunk 1.5 m, clearance 0.5 m, r ≥ 1.5 m | facade clearance | city.js |
| `ct_BLOCK` | (−27, −5), 34 × 46 m, depth 11 m, 22 m | §5.2 | city.js |
| `ct_TOWER` | (89, −66), 24 × 24 m, 80 m | §5.3 | city.js |
| `ct_CUSTOM_DEFAULT`, `ct_CUSTOM_LIMITS` | (75, −10), 40 × 24 × 25 m; 3–300 m, 3–100 m | §5 | city.js |
| `sc_SHADOW` | ±520 m, 4096² (2048² software) | §2.1 | scene.js |
| `sc_FOG` | 1200–4200 m | §2.1 | scene.js |
| `sc_MITRE_LIMIT` | 1.6 | bevel beyond ~100° turns | scene.js |
| light elevation floor | 15° | §2.2 | scene.js |
| `vis_PALETTES`, `vis_BAND_ALPHA` | §6.1 | validator; visual check | visuals.js |
| `vis_SLICE_FADE_M` | 80 m | outflow sponge (critic §4.4) | visuals.js |
| `vis_PARTICLES` | 4,000, ×6, 15–30 s, 1.6 m, û\* 0.162, 8 m | §6.3 | visuals.js |
