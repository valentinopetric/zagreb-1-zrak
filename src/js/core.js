// ------------------------------------------------------------------ core
/*
 * Shared foundation of the single page module (see tools/build.py for the file order).
 * Everything declared at the top level of any file is visible to all later files.
 *
 * Frames (docs/architecture.md §2):
 *   world: x = east, y = up, z = south, metres; origin = the ZAGREB-1 sampling point (DHMZ coordinates);
 *   y = 0 is local ground (the terrain varies ~14 m over 1.5 km and is treated as flat).
 *   Bearings/meteorological directions: 0 = from north, clockwise. North is -z.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
const readJSON = (id) => {
  const el = document.getElementById(id);
  if (!el) return null;
  try { return JSON.parse(el.textContent); } catch (e) { console.error(`bad JSON in #${id}`, e); return null; }
};

const SITE = readJSON('site-data');            // config/site.json
const ENV = readJSON('env-data');              // src/data/env.json (tools/build_env.py)
const MEAS = readJSON('meas-data');            // src/data/measurements.json (tools/build_measurements.py) or null
const CAL = readJSON('cal-data');              // src/data/calibration.json (tools/calibrate.py) or prior defaults
const LUT = readJSON('lut-data');              // src/data/lut_receptor.json (exported from the app) or null
const LOD2_B64 = (document.getElementById('lod2-data') || {}).textContent || '';

const PARAMS = new URLSearchParams(location.search);
const SELFTEST = PARAMS.has('selftest');       // dist/test.html?selftest : run tests, do not boot the app
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MD = SITE.model_defaults;
const RECEPTOR = new THREE.Vector3(0, SITE.station.inlet_height_m, 0);

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const fmt = (n, d = 0) => (Number.isFinite(n)
  ? n.toLocaleString(I18N.lang === 'hr' ? 'hr-HR' : 'en-GB', { minimumFractionDigits: d, maximumFractionDigits: d })
  : '–');
const wrap360 = (a) => ((a % 360) + 360) % 360;
const angDiff = (a, b) => { const d = wrap360(a - b); return d > 180 ? d - 360 : d; };

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let q = Math.imul(a ^ (a >>> 15), 1 | a);
    q = (q + Math.imul(q ^ (q >>> 7), 61 | q)) ^ q;
    return ((q ^ (q >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260927);

// ------------------------------------------------------------------ polygons (x/z plane)
function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length]; s += x1 * z2 - x2 * z1; }
  return s / 2;
}
function polyCentroid(poly) {
  let x = 0, z = 0;
  for (const p of poly) { x += p[0]; z += p[1]; }
  return [x / poly.length, z / poly.length];
}
function bounds(poly) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return { x0, x1, z0, z1 };
}
function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-12;
  const s = clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1);
  return Math.hypot(x - ax - dx * s, z - az - dz * s);
}

// ------------------------------------------------------------------ tiny event bus
const Bus = (() => {
  const map = new Map();
  return {
    on(evt, fn) { if (!map.has(evt)) map.set(evt, []); map.get(evt).push(fn); return () => map.set(evt, map.get(evt).filter((f) => f !== fn)); },
    emit(evt, data) { for (const fn of map.get(evt) || []) { try { fn(data); } catch (e) { console.error(`Bus ${evt}`, e); } } },
  };
})();

// ------------------------------------------------------------------ safe storage (per-viewer conveniences only)
const store = {
  get(k, d = null) { try { const v = localStorage.getItem('z1.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('z1.' + k, JSON.stringify(v)); } catch (e) { /* blocked */ } },
};

// ------------------------------------------------------------------ test registry (used only by dist/test.html)
// Files under src/js/tests/*.test.js call test('name', async () => {...}); src/js/tests/run.js runs them.
const TESTS = [];
function test(name, fn, opts = {}) { TESTS.push({ name, fn, ...opts }); }
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
function assertClose(a, b, tol, msg = '') {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg} expected ${b} ± ${tol}, got ${a}`);
}
