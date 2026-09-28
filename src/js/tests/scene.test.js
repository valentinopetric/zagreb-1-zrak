// ------------------------------------------------------------------ tests: scene.js, city.js, visuals.js
/*
 * Run with: python3 tests/browser/run_selftest.py --only scene
 * All names start with "scene:" so the filter picks exactly these. Helpers carry the prefix sct_
 * (every test file shares one module scope). Tests that change city state (leaf mode, custom block,
 * palette) restore it before returning.
 */

// OKLab lightness of sRGB bytes (Ottosson 2020), for the colour-scale monotonicity test.
function sct_oklabL(r, g, b) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}
const sct_finite = (arr) => { for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false; return true; };
const sct_ringOk = (p) => Array.isArray(p) && p.length >= 3 && p.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));

test('scene: prisms match ENV.buildings', () => {
  const geo = cityGeometry('today'), base = ct_basePrisms(), sk = base.skipped;
  const n = (ENV.buildings || []).length;
  assert(geo.prisms.length === n - sk.invalid - sk.container, `prisms ${geo.prisms.length} vs ENV ${n} − ${sk.invalid} invalid − ${sk.container} container`);
  assert(sk.invalid <= Math.max(5, 0.01 * n), `too many invalid buildings dropped: ${sk.invalid} of ${n}`);
  for (const pr of geo.prisms) {
    assert(sct_ringOk(pr.p), `bad ring in ${pr.id}`);
    assert(Number.isFinite(pr.b) && Number.isFinite(pr.h) && pr.h > pr.b && pr.b >= 0, `bad heights in ${pr.id}: ${pr.b}..${pr.h}`);
    assert(pr.s === 1, 'prism s must be the solid fraction 1, not the source year');
  }
  return { env: n, prisms: geo.prisms.length, skipped: sk };
});

test('scene: LoD1 mesh has no NaN and outward/upward winding', () => {
  const city = buildCity();
  let tris = 0, bad = 0, verts = 0, drawn = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const m of [city.buildings.inner, city.buildings.outer]) {
    if (!m) continue;
    const pos = m.geometry.getAttribute('position').array, nrm = m.geometry.getAttribute('normal').array;
    assert(sct_finite(pos) && sct_finite(nrm), 'NaN in building geometry');
    verts += pos.length / 3;
    drawn += m.userData.list.length;
    for (let i = 0; i < pos.length; i += 9) {
      a.fromArray(pos, i); b.fromArray(pos, i + 3); c.fromArray(pos, i + 6);
      n.subVectors(b, a).cross(c.clone().sub(a));
      if (n.lengthSq() < 1e-8) continue;               // zero-width keyhole bridges
      tris++;
      if (n.x * nrm[i] + n.y * nrm[i + 1] + n.z * nrm[i + 2] <= 0) bad++;
    }
  }
  assert(drawn === city.buildings.count, `drawn ${drawn} vs count ${city.buildings.count}`);
  assert(bad === 0, `${bad} of ${tris} triangles wound against their normal`);
  return { verts, tris, drawn };
});

test('scene: cityGeometry for every scenario', () => {
  const today = cityGeometry('today');
  const out = {};
  for (const s of SCENARIOS) {
    const g = cityGeometry(s.id);
    assert(Array.isArray(g.prisms) && Array.isArray(g.trees) && Array.isArray(g.roads) && Array.isArray(g.heating), `${s.id}: missing arrays`);
    for (const pr of g.prisms) assert(sct_ringOk(pr.p) && pr.h > pr.b, `${s.id}: bad prism ${pr.id}`);
    for (const tr of g.trees) assert([tr.x, tr.z, tr.h, tr.r, tr.lad, tr.cb].every(Number.isFinite) && tr.cb < tr.h, `${s.id}: bad tree`);
    assert(s.geo === (s.id !== 'today'), `${s.id}: geo flag`);
    assert(I18N.has(s.label) && I18N.has(s.desc), `${s.id}: missing i18n`);
    out[s.id] = { prisms: g.prisms.length, trees: g.trees.length };
  }
  assert(out.block.prisms === today.prisms.length + 4, 'block adds four wings');
  assert(out.tower.prisms === today.prisms.length + 1 && cityGeometry('tower').prisms.some((p) => p.h === 80), 'tower adds one 80 m prism');
  assert(out.trees.trees > today.trees.length + 50, `trees scenario adds rows (${out.trees.trees} vs ${today.trees.length})`);
  assert(out.notrees.trees === 0, 'notrees has no trees');
  assert(out.block.trees < today.trees.length, 'the block removes the trees in its footprint');
  return out;
});

test('scene: the station container never enters the flow geometry', () => {
  for (const s of SCENARIOS) {
    for (const pr of cityGeometry(s.id).prisms) {
      assert(!pointInPoly(RECEPTOR.x, RECEPTOR.z, pr.p), `${s.id}: ${pr.id} contains the inlet`);
      const [cx, cz] = polyCentroid(pr.p);
      assert(Math.hypot(cx - RECEPTOR.x, cz - RECEPTOR.z) > 3, `${s.id}: ${pr.id} centred on the inlet`);
    }
  }
  // the filter itself, on the env container ring and on the OSM way id
  const ring = ct_ring(ENV.station && ENV.station.container) || ct_rect(0, 0, 3, 2.4, 0);
  assert(ct_isContainer({ id: 'osm:x' }, ring), 'container ring not recognised');
  assert(ct_isContainer({ id: `osm:${SITE.station.osm_way}` }, ct_rect(300, 300, 10, 10, 0)), 'container OSM id not recognised');
  assert(!ct_isContainer({ id: 'zg3d:1' }, ct_rect(40, 0, 20, 20, 0)), 'a normal building flagged as container');
});

test('scene: scenario volumes stand clear of existing buildings and the inlet', () => {
  const base = ct_basePrisms();
  const res = {};
  for (const id of ['block', 'tower']) {
    const added = ct_addedPrisms(id);
    let hits = 0;
    for (const a of added) {
      const bb = bounds(a.p);
      for (const b of base) {
        const cb = bounds(b.p);
        if (cb.x1 < bb.x0 || cb.x0 > bb.x1 || cb.z1 < bb.z0 || cb.z0 > bb.z1) continue;
        if (b.b > 3) continue;                         // floating parts (canopies) may overhang
        if (a.p.some(([x, z]) => pointInPoly(x, z, b.p)) || b.p.some(([x, z]) => pointInPoly(x, z, a.p))) hits++;
      }
      assert(ct_polyDist(RECEPTOR.x, RECEPTOR.z, a.p) > 8, `${id}: closer than 8 m to the inlet`);
    }
    res[id] = hits;
  }
  // The station tree survives the block, pruned so its crown clears the east wing (ct_PRUNE).
  const st = ENV.station && ENV.station.tree;
  if (st) {
    const kept = cityGeometry('block').trees.find((tr) => Math.hypot(tr.x - st.x, tr.z - st.z) < 0.5);
    assert(kept, 'the block removed the station tree');
    const wall = Math.min(...ct_addedPrisms('block').map((pr) => ct_polyDist(kept.x, kept.z, pr.p)));
    assert(kept.r < st.r && wall - kept.r >= ct_PRUNE.clear - 1e-6, `station tree crown ${kept.r} m vs wall at ${wall.toFixed(1)} m`);
    res.stationTree = { r: kept.r, wall: +wall.toFixed(1) };
  }
  // Tolerance: the env frame of the geo pipeline may move footprints by a metre or so; more than one
  // overlap means the scenario coordinates must be revisited (docs/12-rendering.md §5).
  assert(res.block <= 1 && res.tower <= 1, `scenario volumes overlap existing buildings: ${JSON.stringify(res)}`);
  return res;
});

test('scene: custom block via setCustomBlock', () => {
  const saved = { ...ct_state.custom };
  let evt = null;
  const off = Bus.on('city:changed', (e) => { evt = e; });
  try {
    const b = setCustomBlock({ x: 120, z: 60, w: 30, d: 20, h: 40, rot: 10 });
    assert(b.h === 40 && b.w === 30, 'returned block');
    const g = cityGeometry('custom');
    const pr = g.prisms.find((p) => p.id === 'scenario:custom');
    assert(pr && pr.h === 40, 'custom prism present with its height');
    const [cx, cz] = polyCentroid(pr.p);
    assertClose(cx, 120, 0.05, 'centre x'); assertClose(cz, 60, 0.05, 'centre z');
    assertClose(Math.abs(polyArea(pr.p)), 600, 0.5, 'footprint area');
    for (const tr of g.trees) assert(ct_polyDist(tr.x, tr.z, pr.p) >= ct_PRUNE.trunk && (ct_polyDist(tr.x, tr.z, pr.p) - tr.r >= ct_PRUNE.clear - 1e-6 || tr.r <= ct_PRUNE.rMin), 'a tree trunk or crown inside the custom block');
    assert(evt && evt.scenario === 'custom', 'Bus city:changed emitted');
    const c = setCustomBlock({ h: 999, w: 0.1 });
    assert(c.h === ct_CUSTOM_LIMITS.h[1] && c.w === ct_CUSTOM_LIMITS.wd[0], 'values clamped');
    const layer = scenarioLayer('custom');
    assert(layer.children.some((o) => o.isMesh), 'custom layer has a mesh');
  } finally {
    off();
    setCustomBlock(saved);
  }
});

test('scene: leaf modes set LAD and visibility', () => {
  const prev = ct_state.leaves;
  const city = buildCity();
  try {
    setLeaves('on');
    assert(cityGeometry('today').trees.every((t) => t.lad === 1.2), 'leaf-on LAD 1.2');
    setLeaves('off');
    assert(cityGeometry('today').trees.every((t) => t.lad === 0.3), 'leaf-off LAD 0.3');
    setLeaves('none');
    assert(cityGeometry('today').trees.length === 0, 'none: no trees in the flow');
    cityView(null);
    assert(!city.trees.visible, 'none: base trees hidden');
    setLeaves('on');
    cityView(null);
    assert(city.trees.visible && city.treesRoot.visible, 'on: base trees shown');
    cityView('notrees');
    assert(!city.treesRoot.visible, 'notrees view hides the base trees');
    assert(scenarioLayer('notrees').userData.hides.includes(city.treesRoot), 'hides alias');
    cityView(null);
    assert(city.treesRoot.visible, 'today view shows them again');
  } finally {
    setLeaves(prev);
    cityView(null);
  }
});

test('scene: street trees follow the planting rule', () => {
  const extra = ct_streetTrees(), S = ct_STREET;
  assert(extra.length >= 50, `only ${extra.length} street trees`);
  const motor = (ENV.roads || []).filter((r) => r.c <= 4 && Array.isArray(r.p));
  let worst = Infinity;
  for (const tr of extra) {
    const d0 = Math.hypot(tr.x - RECEPTOR.x, tr.z - RECEPTOR.z);
    assert(d0 <= S.radius + 1e-6 && d0 >= S.station - 1e-6, `tree at ${d0.toFixed(1)} m from the inlet`);
    for (const r of motor) {
      const hw = ct_width(r) / 2;
      for (let i = 0; i < r.p.length - 1; i++) {
        const d = segDist(tr.x, tr.z, r.p[i][0], r.p[i][1], r.p[i + 1][0], r.p[i + 1][1]) - hw;
        worst = Math.min(worst, d);
      }
    }
  }
  assert(worst >= S.road - 0.1, `a street tree stands ${worst.toFixed(2)} m from a kerb`);
  return { trees: extra.length, minKerbClearance: +worst.toFixed(2) };
});

test('scene: LoD2 decode of a synthetic buffer', () => {
  const nTri = 2;
  const len = 16 + nTri * 18 + nTri, padded = Math.ceil(len / 4) * 4;
  const buf = new ArrayBuffer(padded), dv = new DataView(buf), u8 = new Uint8Array(buf);
  u8.set([90, 76, 50, 66]);                       // "ZL2B"
  dv.setUint32(4, 1, true); dv.setUint32(8, nTri, true); dv.setUint32(12, 0, true);
  const dm = [0, 0, 0, 100, 0, 0, 0, 0, 100, -12345, 55, 32000, 1, 2, 3, -1, -2, -3];
  dm.forEach((v, i) => dv.setInt16(16 + i * 2, v, true));
  u8[16 + nTri * 18] = 22; u8[16 + nTri * 18 + 1] = 8;
  let bin = '';
  for (const b of u8) bin += String.fromCharCode(b);
  for (const src of [btoa(bin), u8, buf]) {
    const d = decodeLod2(src);
    assert(d.nTri === 2 && d.version === 1, 'header');
    dm.forEach((v, i) => assertClose(d.pos[i], v / 10, 1e-4, `pos[${i}]`));
    assert(d.cls[0] === 22 && d.cls[1] === 8, 'classes');
  }
  let threw = 0;
  const bad = u8.slice(); bad[0] = 88;
  try { decodeLod2(bad); } catch (e) { threw++; }
  try { decodeLod2(u8.slice(0, 30)); } catch (e) { threw++; }
  assert(threw === 2, 'bad magic and truncation must throw');
});

test('scene: LoD2 baked buffer decodes inside its radius', () => {
  if (!LOD2_B64) return { skipped: 'no lod2.bin baked into this page' };
  const d = decodeLod2(LOD2_B64);
  assert(d.nTri > 1000 && sct_finite(d.pos), 'triangles');
  let rmax = 0, ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < d.pos.length; i += 3) {
    rmax = Math.max(rmax, Math.hypot(d.pos[i], d.pos[i + 2]));
    ymin = Math.min(ymin, d.pos[i + 1]); ymax = Math.max(ymax, d.pos[i + 1]);
  }
  assert(rmax < SITE.extent.lod2_radius_m + 150, `LoD2 reaches ${rmax.toFixed(0)} m`);
  assert(ymin > -5 && ymax < 150, `LoD2 heights ${ymin}..${ymax}`);
  return { nTri: d.nTri, rmax: Math.round(rmax), ymin: +ymin.toFixed(1), ymax: +ymax.toFixed(1) };
});

test('scene: concColor is monotonic for every pollutant', async () => {
  const prev = vis_palette;
  try {
    for (const pal of ['cb', 'eaqi']) {
      setConcPalette(pal);
      for (const [p, s] of Object.entries(CONC_SCALES)) {
        assert(s.breaks.length === 5 && s.breaks.every((b, i) => !i || b > s.breaks[i - 1]), `${p}: breaks`);
        const top = s.breaks[4] * 2;
        let lastBand = 0, lastL = Infinity, lastA = -1;
        const out = new Uint8ClampedArray(4);
        for (let k = 0; k <= 400; k++) {
          const v = (top * k) / 400, band = concBand(v, s);
          concColor(v, s, out);
          assert(band >= lastBand && band >= 1 && band <= 6, `${p}: band not monotonic at ${v}`);
          assert(out[3] >= lastA, `${p}: alpha not monotonic at ${v}`);
          if (pal === 'cb') {
            const L = sct_oklabL(out[0], out[1], out[2]);
            assert(L <= lastL + 1e-9, `${p}: lightness rises at ${v}`);
            lastL = L;
          }
          lastBand = band; lastA = out[3];
        }
        assert(concBand(s.breaks[0] - 1e-9, s) === 1 && concBand(s.breaks[0], s) === 2, `${p}: break convention`);
        concColor(NaN, s, out);
        assert(out[3] === 0, `${p}: NaN must be transparent`);
        const html = legendHTML(p);
        assert((html.match(/<li>/g) || []).length === 6, `${p}: legend rows`);
      }
    }
  } finally { setConcPalette(prev); }
  return { pollutants: Object.keys(CONC_SCALES), no2: CONC_SCALES.no2.breaks, source: CONC_SCALES.no2.source };
});

test('scene: sun position and daylight', () => {
  // June solstice, local solar noon at 15.97 E ≈ 10:58 UTC: elevation 90 − 45.80 + 23.44 = 67.6°, azimuth 180°.
  const s = sc_sunPosition(new Date('2026-06-21T10:58:00Z'), SITE.station.lat, SITE.station.lon);
  assertClose(s.el, 67.6, 0.6, 'summer noon elevation');
  assertClose(s.az, 180, 4, 'summer noon azimuth');
  const w = sc_sunPosition(new Date('2026-12-21T11:03:00Z'), SITE.station.lat, SITE.station.lon);
  assertClose(w.el, 20.8, 0.6, 'winter noon elevation');
  const e = sc_sunPosition(new Date('2026-03-20T06:00:00Z'), SITE.station.lat, SITE.station.lon);
  assert(e.az > 80 && e.az < 110, `equinox morning sun in the east (${e.az.toFixed(1)}°)`);
  const night = setDaylight(new Date('2026-01-10T23:00:00Z'), 50);
  assert(night.night && !sun.castShadow && sun.intensity > 0, 'night: weak shadowless key light');
  const day = setDaylight(new Date('2026-06-21T10:58:00Z'), 0);
  assert(!day.night && sun.castShadow && sun.position.y > 0, 'day: sun above the horizon');
  return { summer: s, winter: w };
});

test('scene: ribbonGeometry faces up and covers the polyline', () => {
  const line = [[0, 0], [100, 0], [100, 60]];
  const g = ribbonGeometry([line], () => 10, 0.2);
  const pos = g.getAttribute('position').array, nrm = g.getAttribute('normal').array;
  let area = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i], az = pos[i + 2], bx = pos[i + 3], bz = pos[i + 5], cx = pos[i + 6], cz = pos[i + 8];
    const cy = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    assert(cy >= -1e-6, 'a ribbon triangle faces down');
    area += Math.abs(cy) / 2;
    assert(nrm[i + 1] === 1, 'normal up');
  }
  // 160 m of centreline at 10 m, plus the 3 m end extensions: 1600 + 2·30 = 1660 m²
  assertClose(area, 1660, 30, 'ribbon area');
});

test('scene: ConcSlice masks solids and fades at the edges', () => {
  const nx = 40, ny = 30, nz = 4, dx = 5, mask = new Uint8Array(nx * ny * nz);
  mask[(0 * ny + 15) * nx + 20] = 255;             // one solid cell in the first layer
  const data = new Float32Array(nx * ny * 8).fill(0.5);
  const field = {
    frame: { origin: new THREE.Vector3(-100, 0, -75), ex: new THREE.Vector3(1, 0, 0), ey: new THREE.Vector3(0, 0, 1) },
    nx, ny, nz, dx, mask, slice: () => ({ nx, ny, data, stride: 8 }),
  };
  const g = new THREE.Group();
  const cs = new ConcSlice(g);
  const fn = (g4, a4) => 100 * g4[0] + (a4 ? 0 : 1000);
  assert(cs.update(field, fn, 4, true, 'no2') === true, 'first update builds the texture');
  assert(cs.update(field, fn, 4, true, 'no2') === false, 'unchanged inputs do not rebuild');
  const a = (i, j) => cs.data[(j * nx + i) * 4 + 3];
  assert(a(20, 15) === 0, 'solid cell transparent');
  assert(a(0, 0) < a(20, 5) && a(20, 5) > 0, 'edge fades');
  assert(cs.mesh.visible && Math.abs(cs.mesh.position.x - 0) < 1e-6 && Math.abs(cs.mesh.position.z - 0) < 1e-6, 'plane centred on the domain');
  cs.update(null, fn, 4, true, 'no2');
  assert(!cs.mesh.visible, 'no field: hidden');
  const gf = ConcSlice.gridField({ x0: 0, z0: 0, dx: 10, nx: 4, nz: 3 }, new Float32Array(48).fill(1), 4);
  assert(cs.update(gf, (g4, a4) => (a4 === null ? 30 : -1), 4, true, CONC_SCALES.no2), 'grid field accepted');
  assert(concBand(30, 'no2') === 3 && cs.data[3] > 0, 'grid field coloured');
  cs.dispose();
});

test('scene: Particles release by emission weight and move with the wind', () => {
  const g = new THREE.Group();
  const P = new Particles(g, ENV, { n: 300 });
  const fr = { origin: new THREE.Vector3(-300, 0, -300), ex: new THREE.Vector3(1, 0, 0), ey: new THREE.Vector3(0, 0, 1) };
  const wind = {
    frame: fr, nx: 120, ny: 120, nz: 32, dx: 5,
    sample(p, out) { const inside = p.x > -300 && p.x < 300 && p.z > -300 && p.z < 300 && p.y < 160; if (inside) { out[0] = 0.5; out[1] = out[2] = 0; out[3] = 0.5; } return inside; },
    vel(p, out) { return out.set(0.5, 0, 0); }, solidAt() { return false; },
  };
  P.setStrengths({ A: 1, B: 0, C: 0, D: 0 });
  P.update(0.016, wind, 2, true);
  let n = 0;
  for (let i = 0; i < P.n; i++) if (P.alive[i]) { n++; assert(P.grp[i] === 0, 'only group A released'); }
  assert(n === P.n, `all particles alive (${n})`);
  const x0 = Array.from(P.p.filter((_, i) => i % 3 === 0));
  if (!REDUCED_MOTION) {
    for (let k = 0; k < 10; k++) P.update(0.05, wind, 2, true);
    const x1 = Array.from(P.p.filter((_, i) => i % 3 === 0));
    const dxMean = x1.reduce((s, x, i) => s + (x - x0[i]), 0) / x1.length;
    assert(dxMean > 0.5, `particles drift downwind (mean dx ${dxMean.toFixed(2)} m)`);
  }
  P.update(0.016, null, 2, true);
  assert(!P.points.visible, 'no field: hidden');
});
