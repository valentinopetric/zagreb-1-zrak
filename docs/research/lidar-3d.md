# LiDAR, 3D buildings and terrain for the Zagreb-1 air-quality station

Research date: 2026-09-27. Every URL below was fetched from this machine (Linux, python3.12, curl) on that date unless it is marked *not tested*.

## 0. Summary

1. **Best data found: the City of Zagreb's ZG3D 2022 model.** It has LoD2.2 buildings for all 357,683 buildings in the city, re-modelled against the 2022 national LiDAR point cloud. It is open data under the Croatian Open Licence (Otvorena dozvola), and an anonymous ArcGIS FeatureServer can be queried by bounding box.
   - The full 3D roof and wall geometry (`multipatchOption=embedMaterials` → Esri `binaryPatches`) decodes with the Python stdlib (`base64` + `zlib` + `struct`).
   - Our 1.5 km box holds 4,385 building parts and about 369k faces. The 3D geometry downloads in about 23 s; footprints with heights download in about 4 s.
   - Checked against OSM `height` tags (n=21) the error is 0.2 m median and 2.1 m MAE. Base heights agree with the DGU terrain model to −0.06 m median (IQR ±0.2 m).
2. **Real national LiDAR (DGU "Multisenzorsko zračno snimanje RH", 2022/23) cannot be downloaded anonymously.** You fill in a request form (free) and receive classified LAS/LAZ, a 1 m DSM (DMP) and a 1 m DTM (DMR) for each 1:2000 sheet. Our box needs 6 sheets, listed below.
   - Licence catch: when you publish, "it must not be possible to directly obtain the coordinate and height of an individual point or object". Keep the raw DGU LiDAR out of the public repo. Use it locally for validation or upgrades unless DGU confirms otherwise.
   - The anonymous DGU services only give rendered pictures of the LiDAR terrain model (colour classes and hillshade). Feature-info queries and WCS are disabled.
3. **Terrain: the DGU INSPIRE DTM (20 m, open, anonymous).** It reads in about 2 s through HTTP range requests (`/vsicurl`), so the 34 MB tile never needs downloading. Zagreb is flat here (107–122 m). This is enough terrain detail, and it matches ZG3D base heights to about 0.1 m.
4. **Trees (the model has none by default):** the Meta/WRI 1 m canopy height map is anonymous, CC BY 4.0 and fast to window-read, but it must be masked with the building footprints. OSM has 1,785 `natural=tree` nodes in the box. ESA WorldCover (10 m) gives a coarse land-cover class.
5. **Global building-height datasets are not worth using here:**
   - Overture adds nothing over OSM (23 heights and 346 floor counts, all taken from OSM).
   - Microsoft ML footprints have no heights in Croatia.
   - Google Open Buildings 2.5D does not cover Europe.
   - GHS-BUILT-H is 100 m cells.
   - The Urban Atlas Building Height public ImageServer only serves height *classes*.
   - OSM alone covers heights for 18.8 % of buildings. Converting levels to metres needs about 4.8 m per level (median of p90 roof height ÷ levels) here, not 3.1 m.
6. **Recommendation:**
   - Primary: ZG3D FeatureServer → LoD1 building parts (top and base height above the DGU DTM) in the reference repo's `env.json` format, plus an optional LoD2 mesh for display.
   - Fallback 1: the ZG3D district shapefiles (MultiPatch, 8–15 MB each).
   - Fallback 2: OSM, with levels calibrated against ZG3D.
   - Optional private upgrade: DGU LiDAR DMP/DMR/LAZ → nDSM → per-footprint zonal statistics. The script is written and tested on a synthetic LAZ.

## 1. Area of interest

| | value |
|---|---|
| Station (DHMZ) | 45.800496 N, 15.97422 E |
| Station in HTRS96/TM (EPSG:3765, the Croatian national CRS) | E 459129.318, N 5073538.234 |
| Station in ETRS89/TM33 (EPSG:3045, the DGU INSPIRE DTM CRS; N-E axis order) | E 575706.67, N 5072343.07 |
| Box, WGS84 (±750 m) | S 45.793759, W 15.964556, N 45.807233, E 15.983884 |
| Box, EPSG:3765 | 458379.318, 5072788.234 – 459879.318, 5074288.234 |
| Ground height at the station | 115.6 m HVRS71 (DGU DTM); Copernicus GLO-30 gives 116.1 m |
| City districts in the box (ZG3D counts) | Trnje 3,338 parts, Donji grad 1,013, Trešnjevka sjever 45 |
| DGU 1:2000 sheets covering the box (needed for the LiDAR request) | **2-491-105-9, 2-492-105-9, 2-516-105-9, 2-517-105-9, 2-541-105-9, 2-542-105-9** (each sheet 1.2 km × 0.8 km; together E 458000–460400, N 5072400–5074800) |
| DGU 1:5000 sheets | 5-12-4-105-9 and 5-17-4-105-9, both named "Zagreb (istok)" |

## 2. Candidates

| # | Source / product | Type | Resolution / LoD | Vertical accuracy | Epoch | Licence | Auth | Size for our box | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| A | **Grad Zagreb ZG3D 2022**, citywide FeatureServer `ZG3D_2022_3d_model_GZ` | 3D buildings (Esri MultiPatch), with attributes Z_Min, Z_Max, Z_Delta, Volume, SArea, source year | LoD2.2, building parts | Not stated. It inherits photogrammetry (2008), drone (2019/20) and LiDAR plus photogrammetry (2022). Checked here: 0.2 m median / 2.1 m MAE against OSM `height` | Modelled 2008–2022; data edited 2025-03-10; published 2025-04-28 | Otvorena dozvola (Croatian Open Licence) | none | Footprints plus heights 3.1 MB GeoJSON (4,333 parts). Full LoD2 3.6 MB gzip (43 MB JSON; 4,385 parts, 369k faces) | **PRIMARY** |
| A2 | ZG3D per-district downloads on data.zagreb.hr (SHP / FGDB / GeoJSON / CSV / XLSX) | ESRI shapefile type 31 MultiPatch, lon/lat + Z | LoD2.2 | as A | as A | Otvorena dozvola | none | Trnje SHP zip 8.3 MB (88 MB unzipped), Donji grad 11.9 MB, Trešnjevka sjever 15.1 MB | Fallback / offline mirror |
| B | **DGU national LiDAR 2022/23**: classified LAS/LAZ, DMP (DSM) 1 m, DMR (DTM) 1 m, per 1:2000 sheet | point cloud and rasters (TIFF+TFW) | ≥8 pts/m² in urban areas (spec minimum; reportedly denser in practice); 1 m grids | Spec ±0.1 m (68 %), ≤0.2 m (95 %) vertical; ±0.2 m horizontal | 2022 (orthophoto 2022/23) | Free. DGU "LIDAR" licence: commercial use allowed, but publication must not let anyone extract point or object coordinates and heights | Request form by email: `izdavanje.podataka@dgu.hr` | 6 sheets. Estimated DMP+DMR ≈ 2 × 3.8 MB per sheet (float32 1200×800). LAZ ≈ 15–60 MB per sheet (estimate) | Best raw LiDAR. **Private use / validation.** |
| B2 | DGU anonymous DMR WMS `services/dmr/wms` (layers DMR_BW, DMR_COLOR, Hillshade; keyword `DMR_LIDAR`) | rendered image | any, 8-bit | – | 2022 LiDAR | view service | none | – | Picture only. Feature-info forbidden in every format, WCS disabled |
| B3 | DGU LiDAR orthophoto WMS `services/inspire/orthophoto_lidar_2022_2023/wms` | RGB 25 cm | 25 cm | – | 2022/23 | view service (DGU) | none (anonymous version has a watermark) | 1500 px JPEG of the box = 0.64 MB | Optional ground texture; the watermark is a problem |
| C | **DGU INSPIRE Elevation (EL-COV) DTM** ATOM, `RH_ELEV_107.tif` | GeoTIFF float64, EPSG:3045 | 19.995 m | not stated (older DTM, lifespan 2015) | ≤2015 | Listed under DGU "Otvoreni podaci" with Otvorena dozvola; the ATOM `<rights>` still cites INSPIRE Art. 13(1)(e) | none | Window read is 86×86 px (52 KB). The whole tile is 34 MB | **Terrain PRIMARY** (enough for flat Zagreb) |
| D | Grad Zagreb geoportal WMS `TopoDMP_Public` / `TopoDMR_Public` (DSM/DTM 2012, "aerofotogrametrijsko i LIDAR snimanje") | rendered hillshade PNG | – | – | 2012 | data only on written request | none (WMS) | – | Picture only (not queryable; the proxy forces `service=wms`, so WCS is impossible) |
| E | Copernicus DEM GLO-30 (AWS COG) | DSM (a surface model, not bare earth) | 30 m | about 4 m | 2011–2015 | Copernicus DEM licence (free, attribution) | none | 49×70 px | Context only. It reads about 2.8 m above the DGU DTM over the box because buildings leak into it |
| E2 | Copernicus DEM EEA-10 | DSM | 10 m | – | – | restricted (eligible users) | yes | – | *not tested*; unsuitable for an open repo |
| F | Urban Atlas Building Height 2012, EEA ImageServer | raster **height classes** 1–10 (2–4 m … 100–368 m) | 10 m | derived from IRS-P5 stereo | 2012 | Copernicus data policy (free) | none for the ImageServer; raw metres need CLMS (EU Login) | 163×164 px | Coarse fallback. Its classes agree with ZG3D 36 % of the time exactly and 78 % within ±1 class |
| G | GHS-BUILT-H R2023A (JRC), average net building height (ANBH) | raster | 100 m | ML model | 2018 | CC BY 4.0 | none | 17×15 px (tile R4_C20, 26 MB zip) | Context only |
| H | ESA WorldCover 2021 v200 (AWS COG) | land-cover classes | 10 m | – | 2021 | CC BY 4.0 | none | 233×163 px | Land use / roughness (75 % built-up, 18 % trees) |
| I | Meta/WRI High-Resolution Canopy Height (AWS) | canopy height, uint8 metres | about 1.2 m (EPSG:3857) | ML (ALS-trained) | about 2018–2020 imagery | CC BY 4.0 | none | window 1816×1810 px; the whole quadkey tile is 636 MB, so always window-read | **Trees PRIMARY** (mask it with the ZG3D buildings) |
| J | Overture Maps buildings, release 2026-09-23.1 | GeoParquet on S3 | footprints; `height` / `num_floors` | – | – | ODbL (OSM-derived) | none | 1,939 buildings; 23 heights, 346 floor counts (1,882 from OSM, 57 from Microsoft) | Adds nothing over OSM |
| K | Microsoft Global ML Building Footprints (Croatia, quadkey 120230330) | GeoJSONL | footprints | height = −1 everywhere | – | ODbL | none | 1,028 footprints in the box, 0 with height | No heights |
| L | Google Open Buildings 2.5D Temporal | – | – | – | – | – | – | – | Europe not covered |
| M | OSM (Overpass) | tags | footprints | `height` 23 of 1,882, `building:levels` 346, either 353 (18.8 %) | live | ODbL | none | 1.3 MB JSON with geometry | Fallback, and the source of roads, trees and parks |
| N | DGU INSPIRE Buildings (TTB) ATOM / cadastre WFS `api.uredjenazemlja.hr/services/inspire/bu/wfs` | 2D GML | footprints | – | – | Otvorena dozvola | none | ATOM covers all of Croatia (286 MB zip); the WFS returned `ORA-01000` on 2 attempts | Not useful (2D, service broken) |

## 3. Tests performed (commands and results)

All raw outputs are saved under `research/data/lidar/`. The file list is in §9.

### 3.1 OSM / Overpass (height tag coverage)

```bash
curl -s -A "zagreb1-airquality-research/0.1 (python)" \
  --data-urlencode 'data=[out:json][timeout:120];way["building"](45.793759,15.964556,45.807233,15.983884);out tags geom;' \
  https://overpass-api.de/api/interpreter -o osm_buildings_bbox_geom.json
```

- The first try without a User-Agent returned **HTTP 406**. With a User-Agent it works, taking 1.8 s.
- 1,882 buildings (1,867 ways and 15 relations).
  - `height`: 23. `building:levels`: 346. Either tag: 353 (18.8 %).
  - `roof:*`: 104. `min_height`: 0. `building:part` ways: 86.
- 1,785 `natural=tree` nodes and 13 `tree_row` ways.
- Levels are mostly 1–7 (the top values are 4 ×97, 1 ×60, 3 ×53).

### 3.2 ZG3D, Grad Zagreb (winner)

**Discovery**

- CKAN API: `https://data.zagreb.hr/api/3/action/package_show?id=zg3d-2022-3d-model-gz`
  - Licence `open-license` = "Otvorena dozvola (OD)", http://data.gov.hr/otvorena-dozvola.
  - The whole-city GeoJSON is 229 MB. The resources point at ArcGIS FeatureServer replicas.
- `package_search?q=zg3d` finds 17 district datasets ("ZG3D Gradska četvrt … 2022") with SHP, FGDB, GeoJSON, CSV and XLSX.
- Service directory (933 services): `https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services?f=json` lists the citywide `ZG3D_2022_3d_model_GZ` plus a FeatureServer and a SceneServer (I3S) per district.

**Layer**

`…/ZG3D_2022_3d_model_GZ/FeatureServer/0`

- geometryType `esriGeometryMultiPatch`, hasZ, maxRecordCount 2000.
- Fields: `OBJECTID, Godina_izv, Izvor, Z_Min, Z_Max, SArea, Volume, Z_Delta`.
- Multipatch options: `embedMaterials, xyFootprint, externalizeTextures, stripMaterials`.
- Total count: 357,683. Data last edited 2025-03-10.

**Count in the box**

```bash
B=https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/ZG3D_2022_3d_model_GZ/FeatureServer/0/query
curl "$B?where=1%3D1&geometry=15.964556,45.793759,15.983884,45.807233&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&returnCountOnly=true&f=json"
# -> {"count":4333}
```

**Footprints plus heights (2D, fast)**

`research/fetch_zg3d.py` pages by 2000 with `multipatchOption=xyFootprint&f=geojson`.

- 3 pages, 4.1 s, 3.1 MB.
- Source mix: 3,130 parts from 2008 aerophotogrammetry, 973 from the 2022 "Multisenzorsko snimanje" (LiDAR + photo), 230 from drones in 2019.
- Z_Delta median 4.6 m, p90 18.8 m, max 95.2 m.

**Pitfall: without `multipatchOption` you do not get 3D**

A plain `f=json` query returns the rings with z=0.

**Full LoD2 (3D, done)**

`research/fetch_zg3d_lod2.py` uses `multipatchOption=embedMaterials&returnZ=true&outSR=3765&f=json`. Each feature returns `geometry.binaryPatches`, a base64 string. The decoder:

```python
b = base64.b64decode(b64); stype, usize, csize = struct.unpack_from("<Iii", b, 0)  # stype 0xC0800036 = GeneralMultiPatch|Z|M
raw = zlib.decompress(b[12:12+csize])        # Esri extended shape buffer
# raw: int type, 4×double bbox, int nParts, int nPoints, int parts[nParts], int partTypes[nParts],
#      2×nPoints doubles XY, 2 doubles zRange, nPoints doubles Z, (M range + M, …)
```

Results:

- 9 pages of 500 in 23.3 s → 4,385 parts, 369,330 faces.
- Part types: 321,275 FirstRing (4), 47,979 OuterRing (2), 52 InnerRing (3), 24 TriangleFan (1).
- Faces are mostly quads (5-vertex closed rings). Coordinates are EPSG:3765 and Z is HVRS71 orthometric height.
- One part has Z=0 (bad record). 374 parts "float" more than 3 m above the ground (roof superstructures and tower tops) and need a base height.

**District SHP fallback**

- Trnje zip, 8.3 MB, downloads in 0.5 s. `.shp` header shape type = 31 (MultiPatch), bbox Z 101.3–212.2 m.
- Its `.prj` says WGS84 (lon/lat), while `.shp.xml` says the source is HTRS96/TM.
- Parsed with `struct` in the stdlib; part types = 2.

**nDSM from LoD2**

`research/zg3d_to_ndsm.py` rasterises the non-vertical faces (|n_z|/|n| ≥ 0.1) onto a 1 m grid with PIL and plane-equation z, then takes the maximum.

- 138,422 roof faces in 33.5 s. 28.7 % of cells are building.
- Building nDSM: median 10.4 m, p95 29.6 m, max 97.9 m.
- Outputs: `zg3d_bld_dsm_1m.tif`, `zg3d_ndsm_1m.tif`, `zg3d_building_id_1m.tif`, `preview_zg3d_ndsm_1m.png`.
- Checked by eye against the DGU orthophoto and the Zagreb DMP hillshade: the railway, Vukovarska and the tower blocks line up.

**Validation (3 checks)**

1. **Against OSM tags** (`research/osm_zonal_heights.py`, p90 of the nDSM inside each footprint shrunk by 0.5 m):
   - 1,829 OSM footprints evaluated. 96 % have more than 50 % ZG3D roof cover and 91 % have more than 80 %.
   - Against `height` (n=21): bias +0.2 m, MAE 2.1 m. The misses are 22→31.8 and 29→42.2, probably OSM tags that mean eave height or are out of date.
   - Against `building:levels` (n=328): the median is **4.79 m per level** (IQR 3.93–5.70). `levels*3.2` underestimates by a median of 5.0 m (MAE 5.3 m). The Austro-Hungarian blocks have tall storeys and pitched roofs.
2. **Against the DGU DTM**: part Z_Min minus the DTM for 3,907 ground-standing parts is −0.06 m median (IQR −0.28…+0.10; p5 −0.84, p95 +0.49). ZG3D base heights and the DGU DTM agree, both in HVRS71.
3. **Against Urban Atlas 2012 classes** (10 m averages): the median ZG3D height in each UA class is 4.0 / 4.6 / 6.8 / 10.3 / 16.1 / 19.9 / 30.1 m for classes 2–8, which is consistent.

**LoD1 in env.json form**

`research/zg3d_to_env_buildings.py`:

- 4,288 parts after dropping 50 bad or tiny ones. 422 parts have base > 0.
- Height above ground: median 5.6 m, p95 24.4 m, max 97.9 m.
- 875 KB JSON, 223 KB gzip.

**LoD2 mesh size by radius around the station** (int16, non-indexed estimate)

| radius | triangles | size |
|---|---|---|
| 300 m | 41k | 0.7 MB |
| 500 m | 131k | 2.4 MB |
| 750 m | 447k | 8.1 MB |
| whole box | 697k | 12.5 MB |

### 3.3 DGU (Državna geodetska uprava)

**Open-data page**

https://dgu.gov.hr/otvoreni-podaci/6596 lists these anonymous ATOM feeds, all under Otvorena dozvola:

- `atom/el-cov/xml` (elevation)
- `atom/bu-core2d/xml`
- `atom/au/xml`, `atom/ad/xml`, `atom/tn/xml`, `atom/hy-p/xml`, `atom/elu/xml`, `atom/gg/xml`

**Elevation ATOM**

`https://geoportal.dgu.hr/services/atom/el-cov/xml` points to 84 GeoTIFF tiles (`RH_ELEV_*.tif`, about 34 MB each) and the index `INSPIRE_Elevation_Grid_Coverage_(EL-COV).gml`, which gives the extent, offset vector 19.995 m and surfaceType DTM for each tile.

- The tile for the station is **RH_ELEV_107** (15.677–16.216 E, 45.486–45.864 N).
- `curl -I` shows `accept-ranges: bytes`. The file is an uncompressed GeoTIFF with 1-row strips, float64, nodata −9999.
- Window read:
  ```python
  rasterio.open("/vsicurl/https://geoportal.dgu.hr/services/atom/RH_ELEV_107.tif")  # + GDAL_HTTP_USERAGENT
  ```
  took 1.8 s for 86×86 px. Range 107.75–121.56 m, mean 115.25 m, station 115.58 m.
- Because the strips are uncompressed, a **stdlib-only** reader is also possible: parse the TIFF IFD (StripOffsets tag 273), then send `Range:` requests for the rows needed (86 rows × 16.6 KB ≈ 1.4 MB).

**LiDAR programme**

"Multisenzorsko zračno snimanje Republike Hrvatske za potrebe procjene smanjenja rizika od katastrofa" (KK.05.2.1.10.0001, EU OPKK): https://dgu.gov.hr/multisenzorsko-zracno-snimanje-republike-hrvatske/5700. Specification PDF (saved as `dgu_lidar_spec.pdf` / `.txt`):

- Density at least 4 pts/m² outside urban areas and **at least 8 pts/m² in urban areas, and for 3D models**.
- Vertical accuracy: at least 68 % of points ≤ 0.1 m and 95 % ≤ 0.2 m. Horizontal accuracy ≤ 0.2 m.
- **DMR and DMP on a 1 m grid.**
- CRS: HTRS96/TM (EPSG:3765) + HVRS71 (EPSG:5610, geoid HRG2009).
- LAS classes: 0, 1, 2 ground, 3/4/5 low/medium/high vegetation, 6 buildings, 7 noise, 9 water, 17 bridges. The DMR is built from ground (class 2); the DMP from the surface classes (ground, vegetation, buildings, water, bridges). The spec's class-to-grid table is only partly readable after PDF text extraction, so check the exact assignment in the PDF.

**Access to the raw LiDAR**

Form `https://dgu.gov.hr/UserDocsImages/dokumenti/Pristup%20informacijama/Podnesi%20zahtjev/PODACI%20ZA%20PONOVNU%20UPORABU/ZAHTJEV%20-%20LIDAR%20PODACI.pdf` (saved as `dgu_zahtjev_lidar.pdf`). It offers, per 1:2000 sheet:

- (a) classified source laser data as LAS or LAZ
- (b) DMP from laser scanning, 1×1 m, TIFF+TFW
- (c) DMR from laser scanning, 1×1 m, TIFF+TFW

You pick commercial or non-commercial use. There is no fee (Pravilnik NN 56/23, 106/25).

The attached licence allows any use, including commercial, but obliges the user:

> "kod javne objave prikazati podatke na način da nije moguće izravno dobiti podatak o pojedinoj koordinati i visini točke ili objekta"

In English: "when publishing publicly, present the data so that the coordinate and height of an individual point or object cannot be obtained directly". It also requires attribution plus the date of the last change. A press article (mjestoivrijeme.hr, May 2024) confirms the data are free, requested by email to `izdavanje.podataka@dgu.hr`. The sheet index is at `https://geoportal.dgu.hr/services/atom/podjele_na_listove.zip` (9.5 MB, shapefiles dof1/dof2/dof5/tk25…). The 6 sheets are listed in §1 and saved as `dgu_dof2_sheets_bbox_epsg3765.geojson`.

**Anonymous DMR WMS** (`https://geoportal.dgu.hr/services/dmr/wms`)

- Layers DMR_BW, DMR_COLOR and Hillshade, marked queryable with keywords `DMR_LIDAR, WCS, ImageMosaic`.
- GetFeatureInfo in json, text/plain, text/html, gml and text/xml all return `ForbiddenFormat`.
- `dmr/ows?service=WCS` returns "Service WCS is disabled". `auth/dmr/wcs` returns "Unsupported OGC service".
- A GeoTIFF GetMap returns a 3-band uint8 rendering with discrete greys (value 120 over 93 % of the box), so it carries no usable heights.

**LiDAR orthophoto WMS** (`https://geoportal.dgu.hr/services/inspire/orthophoto_lidar_2022_2023/wms`, layer `OI.OrthoimageCoverage`, EPSG:3765)

A 1500×1500 JPEG of the box takes 0.64 MB and works, but there is a "GEOPORTAL" watermark in the middle. The registered-user version (`services/auth/...?...authKey=`) presumably has none; not tested.

**Buildings**

The INSPIRE BU ATOM is 286 MB for the whole country and 2D only. The cadastre WFS `api.uredjenazemlja.hr/services/inspire/bu/wfs` returns GetCapabilities fine, but GetFeature failed with `ORA-01000: maximum open cursors exceeded` (WFS 2.0 and 1.1).

### 3.4 Grad Zagreb geoportal (ZIPP)

The service list at https://geoportal.zagreb.hr/ProstorniServisi.aspx includes:

- `Public/TopoDMP_Public/MapServer/WMSServer` and `TopoDMR_Public`: GeoServer behind a proxy
- `Ortofoto2022_Public`
- `KatastarZelenila_Public`: the green-space register, with layer 8 "Stablo" (trees)

What the tests showed:

- NIPP metadata `4a1c8814-…` says "Digitalni model površina Grada Zagreba iz 2012. godine", lineage "Aerofotogrametrijsko i LIDAR snimanje", access "Pismeni zahtjev" (written request).
- The layer is `queryable="0"`, so GetFeatureInfo returns LayerNotQueryable.
- GetMap with `format=image/geotiff` returns an RGBA PNG hillshade (`zg_topodmp_wms_bbox_750px.png`), a good visual check.
- WCS through the proxy fails with "Single value expected for request parameter service but instead found: [WCS, wms]" because the proxy appends `service=wms`.
- No open-data trees: CKAN searches for "stabla", "drvece" and "zelenilo" return 0 results.

### 3.5 Copernicus / EU / global rasters

All are window-read with rasterio `/vsicurl/` and `GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR`.

**Copernicus DEM GLO-30**

`https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N45_00_E015_00_DEM/Copernicus_DSM_COG_10_N45_00_E015_00_DEM.tif`

- 1.2 s. 49×70 px, 109.3–135.7 m.
- Mean 118.1 m against the DGU DTM mean of 115.3 m, because GLO-30 is a DSM.

**ESA WorldCover 2021**

`https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N45E015_Map.tif`

- Class counts: 50 built-up 75 %, 10 tree 18 %, 30 grass 6 %, plus a few 60 and 80.
- The station pixel is class 30.

**Meta/WRI CHM**

`https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/120230330.tif`

- The tile is 636 MB, so always window-read it. EPSG:3857, 1.19 m, uint8, **not internally tiled**, yet the read still took only 3.7 s.
- 11.8 % of cells are above 3 m. 12 % of "tree" pixels fall on ZG3D roofs, so the mask is mandatory.
- Tile index: `…/alsgedi_global_v6_float/tiles.geojson`, 15 MB; the tile name is the level-9 quadkey.

**GHS-BUILT-H ANBH R2023A 100 m**

`https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_BUILT_H_GLOBE_R2023A/GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_54009_100/V1-0/tiles/GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_54009_100_V1_0_R4_C20.zip`

- 26 MB. Mollweide tile R4_C20, from col = ⌊(x+18041000)/1e6⌋+1 and row = ⌊(9e6−y)/1e6⌋+1.
- Box values 6.5–23.7 m, mean 13.6 m. Licence CC BY 4.0 (copyright.txt checked).

**Urban Atlas Building Height 2012**

ImageServer `https://copernicus.discomap.eea.europa.eu/arcgis/rest/services/UrbanAtlas/UA_BuildingHeights_2012_10m/ImageServer/exportImage` with `renderingRule={"rasterFunction":"None"}&pixelType=U16`.

- The values are class codes 2–9 (nodata 65535). The raster attribute table maps 1 = 2–4 m … 10 = 100–368 m.
- Raw metres need the CLMS download (EU Login / API token; *not tested*).

### 3.6 Overture, Microsoft, Google

**Overture**

- `pip install duckdb` works (1.5.5). `INSTALL httpfs; INSTALL spatial` download from extensions.duckdb.org without trouble.
- Latest release from `https://stac.overturemaps.org/catalog.json` is `2026-09-23.1`.
- Query with bbox-column pushdown:

```sql
SELECT id,height,num_floors,min_height,roof_height,sources[1].dataset src, ST_AsText(geometry)
FROM read_parquet('s3://overturemaps-us-west-2/release/2026-09-23.1/theme=buildings/type=building/*', hive_partitioning=1)
WHERE bbox.xmin<=15.983884 AND bbox.xmax>=15.964556 AND bbox.ymin<=45.807233 AND bbox.ymax>=45.793759;
```

- 47 s. 1,939 buildings: 1,882 from OpenStreetMap (23 with height) and 57 from Microsoft ML (0 with height). `num_floors` 346, `roof_height` 0.

**Microsoft**

`https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv` has 46 Croatia rows. Quadkey 120230330 is a 27.8 MB gzip file with 340,725 footprints, 1,028 of them in the box, all with `height: -1`.

**Google Open Buildings 2.5D**

The dataset page and blog say it covers Africa, South and South-East Asia, Latin America and the Caribbean only. Not downloaded.

### 3.7 pip installs (all worked, with `--user --break-system-packages`)

- `pyproj 3.8.0`, `shapely 2.1.2`, `pyshp 3.1.6`
- `rasterio 1.5.0` (bundled GDAL, `/vsicurl` works), `tifffile`
- `laspy 2.7.0` + `lazrs 0.8.2` (`pip install "laspy[lazrs]"`, LAZ read/write verified)
- `duckdb 1.5.5` (+ httpfs/spatial extensions)
- `pypdf`
- `numpy 2.4.4` and `Pillow` were already present. No node or npm.

### 3.8 LiDAR processing code, tested on synthetic data

The DGU LAZ is not available without the request, so `research/laz_to_ndsm.py` was tested on a **synthetic** classified LAZ.

- Input: 2,000,000 points at 8 pts/m² over 500×500 m, point format 6, LAS 1.4, laspy+lazrs. Classes 2, 5 and 6 were generated from ZG3D DSM + DGU DTM + Meta CHM, with 5 cm noise.
- The script does chunked reading, `np.maximum.at` into the DSM, `np.minimum.at` into the ground DTM, DTM gap-filling, then nDSM and CHM.
- It ran in 0.9 s. The recovered nDSM on buildings differs from the reference by +0.12 m median (MAE 0.39 m).
- The synthetic LAZ was 11.6 MB for 2 M points (random noise compresses badly). The file was deleted afterwards.

## 4. Recommendation

**Primary pipeline (fully open, no credentials, reproducible in CI):**

1. **Buildings: ZG3D 2022 via the citywide FeatureServer.**
   - Store each part as a LoD1 prism with `h = Z_Max − DTM(centroid)` and `b = max(0, Z_Min − DTM)`. Parts are already split at height breaks, so LoD1 per part is roughly "LoD1.3" and good enough for the LBM voxel grid (2–5 m cells).
   - Keep the source year (`Godina_izv`) per part, so the UI can show "2008 / 2019 / 2022 LiDAR" and warn about old parts.
   - Optional **LoD2 display mesh**, loaded lazily behind a toggle and limited by radius (500 m ≈ 131k triangles ≈ 2.4 MB int16). Geometry decoded from `binaryPatches`; FirstRing/OuterRing polygons triangulated with earcut, TriangleFan handled natively, InnerRing treated as holes.
2. **Terrain: the DGU INSPIRE 20 m DTM** (`RH_ELEV_107.tif`), window-read by HTTP range and resampled bilinear to the simulation grid. The ground varies only about 14 m over the box, so the LBM can treat it as flat with a per-building ground offset. Export it anyway as a coarse height grid for the 3D view.
3. **Trees and vegetation:** Meta CHM 1 m, masked with the ZG3D building raster (dilated 1 m), then thresholded above 3 m. Use it as porous, drag-only cells in the LBM, or as instanced tree meshes. OSM `natural=tree` nodes and parks go on top for the visuals. WorldCover supplies the roughness length at the domain inflow.
4. **Traffic sources:** OSM roads, same as the reference `extract_env.py`, keeping `highway` class and lanes. That is outside this report's scope.

**Fallbacks, in order:**

- **F1**, if ArcGIS Online is unreachable or the service is renamed: the district SHP zips from data.zagreb.hr (Trnje + Donji grad + Trešnjevka sjever ≈ 35 MB). Parse shape type 31 with `struct` and clip to the box. Better still, commit the small clipped LoD1 result to the repo.
- **F2**, a non-Zagreb site or no ZG3D: OSM footprints with height = `height` tag, otherwise `levels × 3.5 + 1.5`. Calibrate this from the ZG3D fit here (median 4.8 m per level by p90), otherwise use type defaults. Optionally drape the Urban Atlas 2012 class midpoints.
- **Optional LiDAR upgrade, private:** request the 6 DGU sheets (DMP + DMR + LAZ). Run `laz_to_ndsm.py` or DMP − DMR, then per-footprint zonal statistics.
  - Use it to (a) validate and correct the ZG3D parts from 2008 (72 % of parts in the box), (b) get LiDAR tree heights (classes 3–5) instead of the ML CHM, and (c) find post-2022 changes.
  - Keep the raw files in a gitignored `tools/private/` and ask DGU before publishing derived per-building heights (see §7).

**Why not the others:** the reasons are in the §2 verdict column. In short, the global products are either coarse (GHSL 100 m, GLO-30 is a DSM, UA gives classes) or add no heights beyond OSM (Overture, Microsoft, Google).

## 5. Pipeline sketch (tools/ scripts)

```
tools/
  config.py              # STATION = (45.800496, 15.97422); HALF = 750 m; CRS = EPSG:3765; origin E0/N0
  fetch_zg3d.py          # stdlib: FeatureServer paging → cache/zg3d_raw_*.json.gz ; decode binaryPatches
  fetch_dtm.py           # stdlib Range-reader for RH_ELEV_107.tif (or rasterio /vsicurl if installed)
  fetch_osm.py           # Overpass (UA header!) → roads, trees, parks, water (like the reference repo)
  fetch_canopy.py        # optional (rasterio): Meta CHM window + WorldCover window
  lidar_dgu.py           # optional/private: LAZ or DMP/DMR tiles → nDSM/CHM (laspy[lazrs], numpy)
  build_env.py           # → src/env.json  (+ src/lod2.bin optional)
  cache/                 # raw downloads (gitignored except small, licence-clean extracts)
  private/               # DGU LiDAR (gitignored, never published)
```

```python
# fetch_zg3d.py (stdlib only; prototype = research/fetch_zg3d_lod2.py)
E0, N0, HALF = 459129.318, 5073538.234, 750
URL = "https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/ZG3D_2022_3d_model_GZ/FeatureServer/0/query"
params = dict(where="1=1", geometry=f"{E0-HALF},{N0-HALF},{E0+HALF},{N0+HALF}",
              geometryType="esriGeometryEnvelope", inSR=3765, outSR=3765,
              spatialRel="esriSpatialRelIntersects", outFields="*", returnGeometry="true", returnZ="true",
              multipatchOption="embedMaterials",           # ← required for 3D; "xyFootprint" for 2D
              orderByFields="OBJECTID", resultRecordCount=500, f="json")
for page in paginate(URL, params, key="resultOffset", until=lambda d: not d.get("exceededTransferLimit")):
    for feat in page["features"]:
        rings = decode_binary_patches(feat["geometry"]["binaryPatches"])  # [(partType, [(x,y,z),...]), ...]
        cache(feat["attributes"], rings)

# fetch_dtm.py (stdlib): TIFF header → IFD → StripOffsets/StripByteCounts (1 row per strip, float64)
tif = "https://geoportal.dgu.hr/services/atom/RH_ELEV_107.tif"          # EPSG:3045 (N,E axis order!)
hdr = http_range(tif, 0, 65535); ifd = parse_ifd(hdr)                    # ModelTiepoint/PixelScale → transform
rows = range(row_of(N_max), row_of(N_min)+1)
dtm = [unpack('<%dd' % W, http_range(tif, off[r], off[r]+cnt[r]-1))[c0:c1] for r in rows]
# station→3045 needs a projection: pyproj if available, else a small TM formula (EPSG:3765 and 3045 are
# both transverse Mercator on GRS80/ETRS89 → implement once, ~30 lines)

# build_env.py
ground = bilinear(dtm)                                                   # HVRS71 metres
for part in zg3d_parts:
    if part.zmax <= 0: continue                                          # 1 bad record in the bbox
    fp  = footprint(part)                                                # union of face XY projections, or xyFootprint query
    g   = ground(centroid(fp))
    top = part.zmax - g; base = max(0, part.zmin - g); base = 0 if base < 1 else base
    if top < 1: continue
    env["buildings"].append({"h": r1(top), "b": r1(base), "p": rdp(to_xz(fp), 0.6), "s": part.year})
# to_xz: x = E - E0, z = -(N - N0)   (reference frame: x east, z south, metres)
env["terrain"] = {"res": 20, "origin": [...], "z": grid(ground) - ground(E0, N0)}
env["trees"]   = canopy_cells(meta_chm & ~dilate(building_mask, 1), min_h=3) + osm_tree_nodes
env["meta"]    = {"sources": [...attribution strings...], "zg3d_edit": "2025-03-10"}
# optional LoD2: triangulate faces within R=500 m → Int16 xyz (5 cm) + Uint32 index → src/lod2.bin

# lidar_dgu.py (private; prototype = research/laz_to_ndsm.py, research/osm_zonal_heights.py)
#   LAZ: DSM = max z per 1 m cell (classes 2-6,9,17), DTM = min z of class 2 (gap-fill), nDSM = DSM − DTM,
#        CHM = max z classes 3-5 − DTM, building mask = class 6
#   or DMP/DMR TIFF+TFW: nDSM = DMP − DMR directly
#   per-footprint height = p90(nDSM inside footprint buffered −0.5 m); flag cover(nDSM>1 m) < 0.5 as "missing/demolished"
#   use to validate ZG3D parts with Godina_izv == "2008" and report |Δh| > 2 m
```

Voxelising for the LBM happens in the browser, as in the reference `wind-tunnel.js`. A cell is solid if its centre is inside footprint `p` and `b ≤ z_cell ≤ h`. The `b` field is the only format extension needed beyond the reference `{h, p}`.

## 6. How to derive per-building heights from real LiDAR (once the DGU tiles arrive)

1. Mosaic the 6 DMP and 6 DMR tiles (TIFF+TFW, EPSG:3765/HVRS71) with rasterio or tifffile. The TFW gives the affine transform.
2. nDSM = DMP − DMR. Set values < 0.5 m to 0.
3. For each footprint (ZG3D xyFootprint or OSM), buffered −0.5 m and rasterised at 1 m:
   - `h_p90` = the estimator, robust to chimneys and antennas
   - `h_med` = the LoD1 "mean roof" height
   - `h_max`
   - `cover` = share of cells with nDSM > 1 m
4. Starting from LAZ instead: `laz_to_ndsm.py` (tested) builds DSM, DTM, nDSM and CHM in one pass. Class 6 gives a building mask independent of footprints, and classes 3–5 give tree heights.
5. Quality flags: `cover < 0.5` means the building is missing in LiDAR (demolished or new). Also flag parts where |h_p90 − ZG3D (Z_Max − DTM)| > 2 m.

## 7. Licensing and attribution text (ready to paste into README / UI)

**ZG3D, Grad Zagreb (Otvorena dozvola)**

> Zgrade: © Grad Zagreb – *ZG3D 2022 3D model Grada Zagreba* (https://data.zagreb.hr/dataset/zg3d-2022-3d-model-gz), Otvorena dozvola (https://data.gov.hr/otvorena-dozvola). Sadrži informacije tijela javne vlasti u skladu s dozvolom. Podaci su prilagođeni: visine iznad terena izračunate pomoću DMR-a DGU-a, tlocrti pojednostavljeni. Stanje podataka: 2025-03-10.
>
> EN: Buildings: contains information of the City of Zagreb (ZG3D 2022 3D city model), used under the Croatian Open Licence; modified (heights above DGU DTM, simplified footprints).

**DGU INSPIRE DTM (Otvorena dozvola)**

> Teren: Sadrži informacije Državne geodetske uprave (*Visine – INSPIRE DMR*, https://geoportal.dgu.hr/services/atom/el-cov/xml) u skladu s Otvorenom dozvolom; podaci su prerađeni (izrezani i preuzorkovani).

**DGU LiDAR (only if obtained)**

> Sadrži informacije Državne geodetske uprave (LiDAR snimanje 2022., projekt *Multisenzorsko zračno snimanje RH*, KK.05.2.1.10.0001) u skladu s dozvolom za ponovnu uporabu LIDAR podataka; datum zadnje izmjene: <from delivery>.

Plus the obligation that published output must not reveal individual point or object coordinates and heights, so do **not** publish raw LiDAR or exact derived heights without DGU consent.

**DGU orthophoto (if used as a texture)**

> Ortofoto: © Državna geodetska uprava, *Digitalni ortofoto LIDAR 2022./23.* (WMS), https://geoportal.dgu.hr/

**Other sources**

- **OpenStreetMap:** "© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)". env.json parts derived from OSM stay under ODbL, as in the reference repo.
- **Meta/WRI canopy height:** "Meta and World Resources Institute (WRI). 2024. High Resolution Canopy Height Maps. CC BY 4.0. Tolan et al. (2024), Remote Sensing of Environment 300:113888."
- **ESA WorldCover:** "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium. CC BY 4.0."
- **Copernicus DEM:** "Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved."
- **GHSL:** "© European Union, 1995-2026. GHS-BUILT-H R2023A, European Commission JRC. CC BY 4.0."
- **Urban Atlas BH 2012:** "© European Union, Copernicus Land Monitoring Service 2012, European Environment Agency (EEA)."
- **Overture (if used):** ODbL for the OSM-derived buildings; see the per-feature `sources`.

## 8. Open questions

1. **Does the DGU LiDAR licence allow publishing derived per-building heights or voxel grids in a public repo?** The non-extractability clause is ambiguous for 3D visualisations. Ask `izdavanje.podataka@dgu.hr`. Until they answer, use DGU LiDAR only locally for validation.
2. **ZG3D was mostly modelled in 2008 (72 % of parts in the box).** The City says the 2022 version was "based on" the 2022 LiDAR point cloud, but `Izvor` says 2008 for most parts. It is unclear whether the 2008 parts were checked against the LiDAR or only kept. A DGU DMP 1 m comparison would settle it. The OSM checks (2.1 m MAE) suggest the heights are fine.
3. **Stability of the ArcGIS Online item** (`services8.arcgis.com/Usi0jGQwMmBUpFjr`, item `2ef387b28ebf415690189f4b5f2bb44f`). Service names may change with the next ZG3D release. Mitigation: commit the clipped LoD1 output, and keep the data.zagreb.hr district zips as fallback F1.
4. **ZG3D terrain, vegetation and bridges** are advertised but not found as open data; only buildings are on data.zagreb.hr. Maybe they are in the ZG3D app or the SceneServer layers (SceneServer I3S not inspected). Trees are in the green-space register WMS (`KatastarZelenila_Public`, layer "Stablo"), but only as rendered images.
5. **Height system:** ZG3D Z and the DGU DTM agree to 0.1 m, so both look like HVRS71. Confirm the vertical datum of the INSPIRE EL-COV tile if absolute heights ever matter (they do not for heights above ground).
6. **Orthophoto watermark:** check whether the free DGU registration (authKey) WMS removes the "GEOPORTAL" watermark, or use the Zagreb `Ortofoto2022_Public` WMS instead (not tested for a watermark).
7. **Station position:** in the ZG3D and orthophoto grid, 45.800496 N / 15.97422 E sits on open ground next to Vukovarska. The DHMZ address (Sarajevska × Kauzlarićev prolaz) should be cross-checked by the station-data researcher, because the sampling inlet position matters for the model's comparison point.
8. **Overture query cost:** 47 s per run over S3. That is fine for a one-off, but should not be in CI.

## 9. Files saved (`research/data/lidar/`, about 47 MB)

**Core outputs**

- `zg3d_bbox_footprints.geojson` (ZG3D 2D + attributes, 4,333 parts)
- `zg3d_lod2_bbox.json.gz` (decoded LoD2 faces, EPSG:3765 relative to the station, 4,385 parts)
- `env_buildings_zg3d_lod1.json` / `.gz` (sample env-format output)
- `zg3d_ndsm_1m.tif`, `zg3d_bld_dsm_1m.tif`, `zg3d_building_id_1m.tif`, `dtm_dgu20m_on_1m_grid.tif`, `meta_chm_on_1m_grid.tif` (all EPSG:3765, 1 m, 1500×1500)
- `osm_footprint_heights_from_zg3d_ndsm.json` (zonal statistics per OSM way)
- previews: `preview_zg3d_ndsm_1m.png`, `preview_buildings_plus_meta_trees.png`

**Source extracts**

- `dgu_inspire_dtm20m_bbox_epsg3045.tif`, `cop_glo30_bbox.tif`, `esa_worldcover2021_bbox.tif`, `meta_chm_1m_bbox_3857.tif`, `ghs_built_h_anbh_2018_bbox_54009.tif`, `ua_bh2012_bbox_3035.tif`
- `osm_buildings_bbox_geom.json`, `overture_buildings_bbox.parquet`
- `dgu_dof_lidar_2022_bbox_1500px.jpg`, `zg_topodmp_wms_bbox_750px.png`, `dgu_dmr_bw_getmap.tif`
- `zg3d_trnje/trnje_shp.zip` (MultiPatch SHP sample)

**Metadata and documents**

- `zg3d_pkg.json`, `zg3d_search.json`, `zg3d_fs.json`, `zg3d_layer0.json`, `zg3d_multipatch_*sample.json`, `zg_arcgis_services.json`
- `dgu_*caps.xml`, `dgu_atom_*.xml`, `dgu_elcov.gml`
- `dgu_lidar_spec.pdf/.txt`, `dgu_zahtjev_lidar.pdf`
- `dgu_dof2_sheets_bbox_epsg3765.geojson`, `dgu_sheets/podjele_na_listove.zip`
- `GHSL_Data_Package_2023_light.pdf`

**Prototype scripts (`research/`)**

- `fetch_zg3d.py` (stdlib, 2D)
- `fetch_zg3d_lod2.py` (stdlib, 3D binaryPatches decoder)
- `zg3d_to_ndsm.py` (numpy/PIL/rasterio)
- `zg3d_to_env_buildings.py`
- `osm_zonal_heights.py`
- `laz_to_ndsm.py` (laspy[lazrs])
