// ------------------------------------------------------------------ aero: job queue, caches, LUT export
/*
 * One GPU, many requests. Every request is a key {scenario, dir: 0..15, stab: 'AC' | 'D' | 'EF'}
 * (architecture §6.2). A job runs the pipeline
 *
 *   spin-up (SPINUP, 10 m) → fine flow (TUNNEL, 5 m) → scalar for key.stab (ScalarSolver) → readback
 *
 * and delivers res = {key, wind: WindField, conc: ScalarField, receptor: ScalarField.receptor(), mast}.
 * A receptor-only sweep job whose value is already in the receptor store is delivered at once with
 * wind = conc = null and stored = true (only the receptor numbers exist for it).
 * Geometry comes from cityGeometry(scenario) (scene-owned, city.js). The flow does not depend on the
 * stability group (v1 flow is neutral, physics §4.6), so it is cached per (scenario, dir), and another
 * group of the same direction goes straight to the scalar stage through ScalarSolver.flowFromField.
 *
 * Order, as in the reference's queue (maksimir-pod-kisom, src/js/wind-tunnel.js `Aero`): the views'
 * current keys first (a new view request for a scenario replaces that scenario's older one and cancels
 * it if it is running), then sweeps in the order asked. Each call of tick() issues one batch of lattice
 * steps (or scalar sweeps) sized from the GPU time the previous batch really took (see _tick): the
 * reference's ~22 frames a second where the page has the headroom, half the rest of a frame where it is
 * slower than that anyway (software WebGL), and 0.3 s batches when a LUT sweep drives the queue itself.
 *
 * Caches:
 *   - results: an in-memory LRU of 16 keys (architecture §6.2), checked against a hash of the geometry
 *     (vox_geoHash) so a moved custom block or a leaf toggle never gets a stale field;
 *   - flows: an LRU of 16 (scenario, dir) entries with the WindField, the source raster and the wall distance;
 *   - receptors: every receptor value ever computed (tiny), keyed by code version (AERO_VERSION and the automatic
 *     aero_codeHash()), grid, geometry hash,
 *     direction, group and turbulence parameters; optionally persisted in IndexedDB (try/catch, tolerant
 *     of an empty, blocked or missing store). exportLUT reads from here.
 *
 * Modules this file uses but does not own, each guarded so it runs alone: cityGeometry (city.js;
 * falls back to vox_envGeometry(ENV)), ScalarSolver (scalar.js; without it jobs end after the flow with
 * conc = null), turbParams and DIRS16 (meteo.js; local fallbacks from physics §6.2–6.6), SCENARIOS (city.js).
 */

const AERO_VERSION = 'aero-1';   // bump when the physics changes: keys the persisted receptor values
/*
 * aero_codeHash(): an automatic companion to AERO_VERSION (integration addition, 2026-09-28). A FNV-1a hash of the
 * source text (Function.prototype.toString, ES2019) of every function and the JSON of every constant table that
 * shapes a receptor value: the voxeliser, the LBM and its inflow, the scalar solver and its closure, the stability
 * mapping. It is part of the receptor-store key, so values persisted in IndexedDB by an older version of the code are
 * never delivered to the page (they are only ignored, not deleted). Computed once, on first use, when every file of
 * the module has run; names that a file does not declare are skipped (typeof).
 */
let aero_codeHashMemo = null;
function aero_codeHash() {
  if (aero_codeHashMemo) return aero_codeHashMemo;
  const fn = (x) => Function.prototype.toString.call(x);
  const src = (v) => { try { return typeof v === 'function' ? fn(v) : JSON.stringify(v, (k, x) => (typeof x === 'function' ? fn(x) : x)); } catch (e) { return '?'; } };
  const parts = [
    typeof tunnelFrame === 'function' ? tunnelFrame : null, typeof voxelize === 'function' ? voxelize : null,
    typeof rasterizeSources === 'function' ? rasterizeSources : null, typeof wallDistance === 'function' ? wallDistance : null,
    typeof vox_coverColumns === 'function' ? vox_coverColumns : null, typeof VOX !== 'undefined' ? VOX : null,
    typeof lbmSources === 'function' ? lbmSources : null, typeof WindTunnel === 'function' ? WindTunnel : null,
    typeof WindField === 'function' ? WindField : null, typeof inflowProfile === 'function' ? inflowProfile : null,
    typeof INFLOW !== 'undefined' ? INFLOW : null, typeof WT_RUN !== 'undefined' ? WT_RUN : null,
    typeof ScalarSolver === 'function' ? ScalarSolver : null, typeof ScalarField === 'function' ? ScalarField : null,
    typeof sc_glsl === 'function' ? sc_glsl : null, typeof sc_prepareSources === 'function' ? sc_prepareSources : null,
    typeof sc_kmoProfile === 'function' ? sc_kmoProfile : null, typeof sc_DEFAULTS !== 'undefined' ? sc_DEFAULTS : null,
    typeof turbParams === 'function' ? turbParams : null, typeof MOST !== 'undefined' ? MOST : null,
    typeof obukhovLength === 'function' ? obukhovLength : null, AERO_STAB,
  ].map(src).join('\u0000');
  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) { h ^= parts.charCodeAt(i); h = Math.imul(h, 16777619); }
  aero_codeHashMemo = (h >>> 0).toString(16).padStart(8, '0');
  return aero_codeHashMemo;
}
// Prefix of every receptor-store key (and of the IndexedDB keys this version loads).
const aero_storePrefix = () => `${AERO_VERSION}|${aero_codeHash()}|`;
const AERO_DIRS = (typeof DIRS16 !== 'undefined' && DIRS16 && DIRS16.length === 16)
  ? Array.from(DIRS16) : Array.from({ length: 16 }, (_, i) => i * 22.5);   // meteo.js, or the same 22.5° steps
const AERO_GROUPS = Array.isArray(MD.stability_groups) ? MD.stability_groups : ['AC', 'D', 'EF'];

/*
 * The stability class and mixing height that stand for each group in a cached field (the key has only
 * the group, architecture §6.2): the group's most frequent class in 2025 and that class's median BLH,
 * floored at h_min (physics §6.4 table, which is IFS per critic §1.1; floor physics §6.5):
 *   A–C: B (17.5 % of hours; A 3.5 %, C 9.4 %), median BLH 520 m;
 *   D:   D (40.3 %), median BLH 135 m;
 *   E–F: F (25.9 %; E 3.4 %), median BLH 30 m → 100 m after the h_min floor.
 */
const AERO_STAB = Object.freeze({
  AC: Object.freeze({ cls: 'B', h_eff: 520 }),
  D: Object.freeze({ cls: 'D', h_eff: 135 }),
  EF: Object.freeze({ cls: 'F', h_eff: Math.max(30, MD.h_min_m) }),
});

// Shares of the progress bar per stage, from the measured costs on SwiftShader (docs/03-flow-lbm.md §8).
const AERO_SHARE = Object.freeze({ spin: 0.12, fine: 0.6, scalar: 0.28 });
/*
 * GPU time budget of one batch (ms), from the measured time of the previous batch of the same stage:
 *   frameMs  the reference's target of ~22 frames a second while the tunnel runs: the batch gets what is
 *            left of 1000/22 ms after the rest of the frame (scene drawing), at least minMs;
 *   share    where the rest of the frame alone exceeds that (software WebGL draws a frame in seconds), the
 *            batch gets this share of it, so the flow still advances without halving the frame rate again;
 *   batchMs  a self-driven LUT sweep (nothing else to draw): 0.3 s batches, short enough for a cancel or
 *            the progress to react within a second, long enough that per-batch overhead is small.
 * A batch grows or shrinks at most ×2 at a time (damping); the caps bound a batch in case a measurement
 * fails, as the reference's caps did.
 */
const AERO_PACE = Object.freeze({ frameMs: 1000 / 22, minMs: 4, share: 0.5, batchMs: 300 });
// Steps per batch: start values and caps, the reference's (spin 64 → 320, fine 16 → 64; software starts at 8 / 4).
const AERO_STEPS = Object.freeze({
  gpu: { start: { spin: 64, fine: 16, scalar: 16 }, cap: { spin: 320, fine: 64, scalar: 128 } },
  soft: { start: { spin: 8, fine: 4, scalar: 4 }, cap: { spin: 320, fine: 64, scalar: 128 } },
  batchCap: 16,   // self-driven: caps × 16
});

I18N.add({
  hr: {
    'phys.stage.wait': 'Čeka na red',
    'phys.stage.spinup': 'Vjetar: zagrijavanje na mreži {dx} m',
    'phys.stage.fine': 'Vjetar na mreži {dx} m',
    'phys.stage.scalar': 'Raspršenje onečišćenja',
    'phys.stage.read': 'Čitanje rezultata',
    'phys.unavailable': 'GPU simulacija nije dostupna (preglednik ne podržava float teksture); prikazuje se približni model.',
    'phys.noscalar': 'Modul raspršenja nije učitan: izračunat je samo vjetar.',
    'phys.software': 'Softverski WebGL: grublja mreža od {dx} m.',
    'phys.lut.progress': 'Tablica prijemnika: {done} od {total} ({pct} %)',
  },
  en: {
    'phys.stage.wait': 'Waiting in the queue',
    'phys.stage.spinup': 'Wind: spin-up on the {dx} m grid',
    'phys.stage.fine': 'Wind on the {dx} m grid',
    'phys.stage.scalar': 'Pollutant dispersion',
    'phys.stage.read': 'Reading the results',
    'phys.unavailable': 'GPU simulation unavailable (no float textures in this browser); showing the approximate model.',
    'phys.noscalar': 'Dispersion module not loaded: only the wind was computed.',
    'phys.software': 'Software WebGL: coarser {dx} m grid.',
    'phys.lut.progress': 'Receptor table: {done} of {total} ({pct} %)',
  },
});

// ------------------------------------------------------------------ guarded access to other modules
// The flow geometry of a scenario: the scene's, or ENV's own when the scene module is missing or fails.
function aero_geometry(scenario) {
  if (typeof cityGeometry === 'function') {
    try {
      const g = cityGeometry(scenario);
      if (g && Array.isArray(g.prisms)) return g;
    } catch (e) { console.warn(`aero: cityGeometry(${scenario}) failed, using ENV`, e); }
  }
  return vox_envGeometry(ENV);
}
// A scenario that changes only emissions (SCENARIOS[].geo === false) shares today's flow.
function aero_flowScenario(id) {
  if (typeof SCENARIOS !== 'undefined' && Array.isArray(SCENARIOS)) {
    const s = SCENARIOS.find((x) => x && x.id === id);
    if (s && s.geo === false) return 'today';
  }
  return id;
}
// The turbulence object for the scalar solver (architecture §6.2): turbParams() from meteo.js for the
// group's representative class and lid (AERO_STAB), over the site's surface parameters.
function aero_turb(stab) {
  const rep = AERO_STAB[stab] || AERO_STAB.D;
  const surf = { z0: MD.z0_m, d: MD.d_m, Hbar: MD.Hbar_m, h_eff: rep.h_eff };
  if (typeof turbParams === 'function') {
    try { const t = turbParams(rep.cls, surf); if (t) return t; } catch (e) { console.warn('aero: turbParams failed, using the local fallback', e); }
  }
  return aero_turbFallback(rep.cls, surf);
}
/*
 * Local stand-in for turbParams (meteo.js) when that module is missing: Golder (1972) L from the class
 * over z0' = min(z0, 0.5 m) (physics Eq. 6.6), and û* from blending-height matching with the
 * Businger–Dyer ψm (physics Eq. 6.2–6.4). Neutral: û* = 0.164, the inflow's (wind-tunnel.js).
 */
function aero_turbFallback(cls, { z0 = MD.z0_m, d = MD.d_m, Hbar = MD.Hbar_m, h_eff = MD.h_min_m } = {}) {
  const golder = { A: [-0.096, 0.029], B: [-0.037, 0.029], C: [-0.002, 0.018], D: [0, 0], E: [0.004, -0.018], F: [0.035, -0.036] }[cls] || [0, 0];
  const invL = golder[0] + golder[1] * Math.log10(Math.min(z0, 0.5));
  const L = invL === 0 ? Infinity : 1 / invL;
  const psi = (zeta) => {
    if (zeta < 0) { const x = Math.pow(1 - 16 * zeta, 0.25); return 2 * Math.log((1 + x) / 2) + Math.log((1 + x * x) / 2) - 2 * Math.atan(x) + Math.PI / 2; }
    return -5 * Math.min(zeta, 1);
  };
  const k = MD.kappa, z0r = MD.z0r_m, zb = MD.zb_m, zr = INFLOW.zref;
  const usr = k / (Math.log(zr / z0r) - psi(zr / L) + psi(z0r / L));
  const ub = (usr / k) * (Math.log(zb / z0r) - psi(zb / L) + psi(z0r / L));
  const ustar_hat = (k * ub) / (Math.log((zb - d) / z0) - psi((zb - d) / L) + psi(z0 / L));
  return { cls, L, ustar_hat, h_eff, z0, d, Hbar, Sct: MD.Sct, lambda: MD.lambda_m, kmin: MD.kmin_m, kappa: k, source: 'aero-fallback' };
}

// ------------------------------------------------------------------ small helpers
function aero_key(k) {
  const dir = ((Math.round(+((k && k.dir) || 0)) % 16) + 16) % 16;
  const stab = k && AERO_STAB[k.stab] ? k.stab : 'D';
  return { scenario: String((k && k.scenario) || 'today'), dir, stab };
}
const aero_id = (k) => `${k.scenario}:${k.dir}:${k.stab}`;
function aero_hashObj(o) {
  const s = JSON.stringify(o, Object.keys(o || {}).sort());
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const aero_round = (x) => (Number.isFinite(x) ? +(+x).toPrecision(6) : null);
function aero_lruSet(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}
function aero_lruGet(map, key) {
  const v = map.get(key);
  if (v !== undefined) { map.delete(key); map.set(key, v); }
  return v;
}
// Model wind at the mast (critic §4.2: 4 m and 10 m, the anemometer height is unknown, G3) as a fraction of
// U10: s = mean speed ⟨|u|⟩ (what a cup anemometer averages), dir = the "from" bearing of the mean vector.
function aero_mast(wind) {
  const out = {}, tmp = new Float32Array(4), v = new THREE.Vector3(), p = new THREE.Vector3();
  const hs = (SITE.station.mast_heights_m || [4, 10]).slice(0, 2);
  const names = [['s4', 'dir4'], ['s10', 'dir10']];
  hs.forEach((h, n) => {
    p.set(RECEPTOR.x, h, RECEPTOR.z);
    const inside = wind.sample(p, tmp);
    wind.vel(p, v);
    out[names[n][0]] = aero_round(inside ? tmp[3] : inflowProfile(h));
    out[names[n][1]] = aero_round(Math.hypot(v.x, v.z) > 1e-6 ? wrap360(Math.atan2(-v.x, v.z) / DEG) : wind.from);
  });
  return out;
}
// Receptor output of ScalarField.receptor() as plain arrays (for JSON and IndexedDB).
function aero_plainReceptor(r) {
  if (!r) return null;
  const arr = (a) => (a ? Array.from(a, (x) => (Array.isArray(x) || ArrayBuffer.isView(x) ? Array.from(x, aero_round) : aero_round(x))) : null);
  return { gamma: arr(r.gamma), age: arr(r.age), band: arr(r.band) };
}

// ------------------------------------------------------------------ IndexedDB (optional persistence)
/*
 * Receptor values only (a few hundred bytes per key); full fields are not persisted (tens of MB each).
 * Every call resolves, never throws: a private window, blocked storage or a missing API all give an
 * empty store, and the app then simply computes again.
 */
const AERO_IDB = Object.freeze({ name: 'z1-aero', store: 'receptor', version: 1, timeoutMs: 3000 });
function aero_idbOpen() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) { finish(null); return; }
      const req = indexedDB.open(AERO_IDB.name, AERO_IDB.version);
      req.onupgradeneeded = () => {
        try { const db = req.result; if (!db.objectStoreNames.contains(AERO_IDB.store)) db.createObjectStore(AERO_IDB.store); } catch (e) { /* ignore */ }
      };
      req.onsuccess = () => finish(req.result);
      req.onerror = () => finish(null);
      req.onblocked = () => finish(null);
      setTimeout(() => finish(null), AERO_IDB.timeoutMs);
    } catch (e) { finish(null); }
  });
}
async function aero_idbLoad(map) {
  const db = await aero_idbOpen();
  if (!db) return null;
  try {
    await new Promise((resolve) => {
      const tx = db.transaction(AERO_IDB.store, 'readonly'), os = tx.objectStore(AERO_IDB.store);
      const keys = os.getAllKeys(), vals = os.getAll();
      tx.oncomplete = () => {
        const K = keys.result || [], V = vals.result || [];
        const pre = aero_storePrefix();
        for (let i = 0; i < K.length; i++) if (typeof K[i] === 'string' && K[i].startsWith(pre) && !map.has(K[i])) map.set(K[i], V[i]);
        resolve();
      };
      tx.onerror = tx.onabort = () => resolve();
    });
  } catch (e) { /* empty store */ }
  return db;
}
function aero_idbPut(dbP, key, value) {
  Promise.resolve(dbP).then((db) => {
    if (!db) return;
    try { db.transaction(AERO_IDB.store, 'readwrite').objectStore(AERO_IDB.store).put(value, key); } catch (e) { /* full or blocked */ }
  }, () => {});
}

// ------------------------------------------------------------------ the queue
/*
 * new Aero({onResult(res, kind), onProgress(job, prog, queue), onFlow?, geometry?, T?, S?, maxEntries?, persist?, turbFor?})
 *   request(key, priority = 'view')   compute key soon ('view': first, replaces the scenario's older view job;
 *                                     'sweep': at the back); a cached result is delivered at once
 *   sweep(keys, {receptorOnly})       queue many keys ('sweep' priority)
 *   tick()                            call once per animation frame; advances the current job
 *   cancelView(scenario?)             drop the view jobs of a scenario (all when omitted)
 *   busy, cache (result LRU), flows, receptors, errors, timing
 *   exportLUT(scenario, classes)      the receptor LUT (architecture §4.4) from what has been computed
 *   sweepLUT(opts) → Promise<lut>     compute 16 directions × classes and publish window.__lut (see below)
 *
 * A job is {id, key, kind, stage, wait, prog, from, geo, hash, …}. The running job's stage is one of
 * 'spinup', 'fine', 'scalar' (the names main.js labels as ui.busy.stage.*); queued jobs are 'wait' and
 * jobs being read back 'read'. While stage is 'scalar', job.wait may be 'flow' (the cached flow's
 * readback is still on its way) or 'solver' (the solver is still reading back the previous result).
 * onProgress(null, 1, []) signals, once, that the queue ran dry.
 *   invalidate(scenario?)             forget the cached flows and results of a scenario (all when omitted)
 */
class Aero {
  constructor({ onResult, onProgress, onFlow, geometry, T, S, maxEntries = 16, persist = true, turbFor } = {}) {
    this.onResult = onResult || (() => {});
    this.onProgress = onProgress || (() => {});
    this.onFlow = onFlow || null;
    this.geometry = geometry || aero_geometry;
    this.turbFor = turbFor || aero_turb;
    this.T = T || TUNNEL;
    // The spin-up grid must cover the same box as T (the seed is interpolated by cell size only), so a
    // custom T without its own S runs without spin-up. S = null: the fine run starts from the inflow.
    this.S = S === undefined ? (T ? null : SPINUP) : S;
    this.max = maxEntries;
    this.tunnel = this.spin = this.solver = null;   // GPU objects, created on the first job
    this.queue = [];
    this.current = null;
    this.cache = new Map();
    this.flows = new Map();
    this.receptors = new Map();
    this.reading = new Set();
    this.waiters = new Map();
    this.errors = [];
    this.timing = [];
    this.solverBusy = null;
    const sw = LBM.software ? AERO_STEPS.soft : AERO_STEPS.gpu;
    this.steps = { ...sw.start };
    this.caps = sw.cap;
    this.last = performance.now();
    this.adapt = true;
    this.driver = false;
    this.idleSent = true;
    this.pending = null;      // the last issued batch, until the GPU has passed it
    this.batch = null;        // the batch being issued
    this.lastBatch = null;    // the last measured batch {phase, n, ms}
    this.marks = [];
    this.db = persist ? aero_idbLoad(this.receptors) : Promise.resolve(null);
  }
  get available() { return LBM.ok; }
  get busy() { return !!this.current || this.queue.length > 0 || this.reading.size > 0; }
  label(job) { return t(`phys.stage.${job ? job.stage : 'wait'}`, { dx: job && job.stage === 'spinup' && this.S ? this.S.dx : this.T.dx }); }

  // ---------------------------------------------------------------- requests
  request(key, priority = 'view') {
    if (!LBM.ok) return false;
    const kind = priority === 'view' ? 'view' : 'sweep';
    const job = this._job(key, kind);
    if (!job) return false;
    if (kind === 'view') {
      this.queue = this.queue.filter((j) => !(j.kind === 'view' && j.key.scenario === job.key.scenario));
      const cur = this.current;
      if (cur && cur.kind === 'view' && cur.key.scenario === job.key.scenario && cur.id !== job.id) this._cancelCurrent();
    }
    const hit = this._resultHit(job);
    if (hit) { this._deliver(hit, job); return true; }
    const cur = this.current;
    if (cur && cur.id === job.id && cur.hash === job.hash) { if (kind === 'view') cur.kind = 'view'; return true; }
    if (this.reading.has(job.id)) { this._wait(job); return true; }
    if (kind === 'view') this.queue.unshift(job);
    else if (!this.queue.some((j) => j.id === job.id)) this.queue.push(job);
    return true;
  }
  sweep(keys, { receptorOnly = false, useStored = true, batch = null } = {}) {
    if (!LBM.ok) return 0;
    let n = 0;
    for (const k of keys) {
      const job = this._job(k, 'sweep');
      if (!job) continue;
      Object.assign(job, { receptorOnly, useStored, batches: batch ? [batch] : [] });
      const twin = this.queue.find((j) => j.id === job.id) || (this.current && this.current.id === job.id ? this.current : null);
      if (twin) {   // already queued or running: that job reports to this batch too
        if (batch && !twin.batches.includes(batch)) twin.batches.push(batch);
        if (receptorOnly === false) twin.receptorOnly = false;
        continue;
      }
      this.queue.push(job);
      n++;
    }
    return n;
  }
  cancelView(scenario) {
    const match = (j) => j.kind === 'view' && (scenario === undefined || j.key.scenario === scenario);
    this.queue = this.queue.filter((j) => !match(j));
    if (this.current && match(this.current)) this._cancelCurrent();
  }
  // Forget what was computed for a scenario (all when omitted), e.g. after its geometry changed. Not needed
  // for correctness (every look-up checks the geometry hash) but frees memory and stops a stale running job.
  invalidate(scenario) {
    const sc = scenario === undefined ? null : aero_flowScenario(String(scenario));
    for (const k of [...this.cache.keys()]) if (sc === null || k.split('|')[1].startsWith(`${sc}:`)) this.cache.delete(k);
    for (const k of [...this.flows.keys()]) if (sc === null || k.startsWith(`${sc}:`)) this.flows.delete(k);
    if (this.current && (sc === null || this.current.fscen === sc)) {
      const cur = this.current;
      this._cancelCurrent();
      this.queue.unshift({ ...cur, stage: 'wait', wait: null, prog: 0, geo: null, hash: null, flow: null, gpuFlow: null, batchCounted: false });   // run again on the new geometry
    }
  }

  // ---------------------------------------------------------------- the frame loop
  tick() { if (!this.driver) this._tick(); }
  /*
   * One batch of GPU work. WebGL calls return at once and the GPU runs them later, so without a brake the
   * page could queue a whole run in a few frames (a self-driven loop has no frame pacing at all) and every
   * progress figure and timing would be fiction. So a batch is framed by two fences: one before it, one
   * after it. A short setTimeout poll (~4 ms resolution) notes when each has passed; the difference
   * is the GPU time of the batch itself, even when the page's own drawing shares the GPU, and it sizes the
   * next batch (_steps). No new batch is issued until the GPU has passed the last one, so a cancelled job
   * stops within one batch, and stage end times ("marks") are stamped with the moment the GPU finished the
   * stage's last batch.
   */
  _tick() {
    if (!LBM.ok) return;
    const now = performance.now();
    if (!this._gpuReady(now)) return;
    const dt = (now - this.last) / 1000;
    this.last = now;
    if (!this.current && !this._startNext()) { this._idle(); return; }
    const job = this.current;
    this._batchBegin(now);
    try { this._advance(job, dt); } catch (e) { this._fail(job, e); }
    this._batchEnd();
    if (this.current === job) this.onProgress(job, job.prog, this.queue);
  }
  _gpuReady(now) {
    const b = this.pending;
    if (!b) return true;
    // A lost poll (context loss) must not stall the queue for good: give up on the brake after 2 minutes.
    if (!b.done && now - b.t0 < 120000) return false;
    this.pending = null;
    for (const [job, name] of this.marks) if (job.t) job.t[name] = b.done ? b.tB : now;
    this.marks.length = 0;
    return true;
  }
  _sync() {
    try { const gl = WT_RENDERER.getContext(); return gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); } catch (e) { return null; }
  }
  _batchBegin(now) { this.batch = { t0: now, fA: this._sync(), fB: null, phase: null, n: 0, done: false }; }
  _batchEnd() {
    const b = this.batch;
    this.batch = null;
    if (!b) return;
    b.fB = this._sync();
    const gl = WT_RENDERER.getContext();
    try { gl.flush(); } catch (e) { /* lost */ }
    if (!b.fA || !b.fB) { b.done = true; b.tB = performance.now(); return; }
    this.pending = b;
    const passed = (f) => gl.getSyncParameter(f, gl.SYNC_STATUS) === gl.SIGNALED;
    const poll = () => {
      try {
        const t = performance.now();
        if (b.tA === undefined && passed(b.fA)) b.tA = t;
        if (passed(b.fB)) {
          b.tB = t;
          if (b.tA === undefined) b.tA = t;
          b.ms = b.tB - b.tA;
          gl.deleteSync(b.fA); gl.deleteSync(b.fB);
          b.done = true;
          if (b.phase && b.n > 0) this.lastBatch = b;
          return;
        }
      } catch (e) { b.done = true; b.tB = performance.now(); return; }
      setTimeout(poll, 2);
    };
    setTimeout(poll, 0);
  }
  _mark(job, name) { this.marks.push([job, name]); }
  // Steps (or sweeps) for this batch: the GPU time budget (AERO_PACE) over the measured time per step of the
  // previous batch of the same stage, damped to ×½…×2. dt is the time since the previous batch was issued.
  _steps(phase, dt) {
    const cap = this.caps[phase] * (this.driver ? AERO_STEPS.batchCap : 1);
    let n = this.steps[phase];
    const last = this.lastBatch;
    if (this.adapt && last && last.phase === phase && last.ms > 0 && last.n > 0) {
      const perStep = last.ms / last.n, rest = Math.max(0, dt * 1000 - last.ms);
      const budget = this.driver ? AERO_PACE.batchMs
        : rest < AERO_PACE.frameMs ? Math.max(AERO_PACE.minMs, AERO_PACE.frameMs - rest) : Math.max(AERO_PACE.frameMs, AERO_PACE.share * rest);
      n = clamp(Math.round(budget / perStep), Math.max(1, Math.floor(n / 2)), n * 2);
    }
    n = Math.max(1, Math.min(cap, n));
    this.adapt = true;
    this.steps[phase] = n;
    if (this.batch) { this.batch.phase = phase; this.batch.n = n; }
    return n;
  }
  _startNext() {
    while (this.queue.length) {
      const job = this.queue.shift();
      if (!this._resolve(job)) { this._batchDone(job, 'failed'); continue; }
      const hit = this._resultHit(job);
      if (hit) { this._deliver(hit, job); this._batchDone(job, 'cached'); continue; }
      if (job.receptorOnly && job.useStored) {
        const st = this._storedReceptor(job);
        if (st) { this._deliverStored(job, st); this._batchDone(job, 'stored'); continue; }
      }
      if (this.reading.has(job.id)) { this._wait(job); continue; }
      this.current = job;
      this.idleSent = false;
      try { this._begin(job); } catch (e) { this._fail(job, e); continue; }
      return true;
    }
    return false;
  }
  _begin(job) {
    job.t = { start: performance.now() };
    const fl = this._flowEntry(job);
    if (fl) { job.flow = fl; job.stage = 'scalar'; job.wait = 'flow'; job.base = 0; job.share = 1; return; }
    this._gpu();
    job.base = 0;
    job.share = AERO_SHARE.scalar;
    if (this.spin) { this.spin.begin(job.geo, job.from); job.stage = 'spinup'; }
    else { this.tunnel.begin(job.geo, job.from); job.stage = 'fine'; }
    this.adapt = false;   // the voxelisation took this frame; do not count it
  }
  _advance(job, dt) {
    const now = performance.now();   // the scalar's end is known from its own readback, so it is stamped now
    switch (job.stage) {
      case 'spinup': {
        const p = this.spin.advance(this._steps('spin', dt));
        job.prog = AERO_SHARE.spin * p;
        if (p >= 1) {
          this._mark(job, 'spin');
          this.tunnel.begin(job.geo, job.from, this.spin);
          this.spin.job = null;
          job.stage = 'fine';
          this.adapt = false;
        }
        break;
      }
      case 'fine': {
        const sp = this.spin ? AERO_SHARE.spin : 0, fs = AERO_SHARE.fine + (this.spin ? 0 : AERO_SHARE.spin);
        const p = this.tunnel.advance(this._steps('fine', dt));
        job.prog = sp + fs * p;
        if (p >= 1) { this._mark(job, 'fine'); this._flowDone(job); }
        break;
      }
      case 'scalar': {
        if (job.wait === 'flow') {   // the cached flow is still being read back
          if (job.flow.failed) throw job.flow.failed;
          if (job.flow.wind) this._beginScalar(job, null);
          break;
        }
        if (job.wait === 'solver') {   // the solver is still reading back the previous job's result
          if (!this.solverBusy) this._beginScalar(job, job.gpuFlow || null);
          break;
        }
        const p = this.solver.advance(this._steps('scalar', dt));
        job.prog = job.base + job.share * Math.min(1, Math.max(0, +p || 0));
        if (this.solver.done || p >= 1) { job.t.scalar = now; job.sweeps = this.solver.sweeps; this._read(job, true); }
        break;
      }
      default: break;
    }
  }
  // The fine run is done: keep its flow (read back asynchronously), then the scalar stage.
  _flowDone(job) {
    const flow = this.tunnel.flow();
    const entry = {
      id: `${job.fscen}:${job.key.dir}`, hash: job.hash, grid: this.T.id, frame: flow.frame, voxgrid: flow.grid,
      wind: null, windP: null, src: null, wall: null, mast: null, failed: null,
    };
    entry.windP = this.tunnel.collect().then((w) => {
      entry.wind = w;
      entry.mast = aero_mast(w);
      if (this.onFlow) { try { this.onFlow({ key: job.requested, wind: w, mast: entry.mast }); } catch (e) { console.error('aero onFlow', e); } }
      return w;
    }, (e) => { entry.failed = e; throw e; });
    entry.windP.catch(() => {});
    aero_lruSet(this.flows, entry.id, entry, this.max);
    job.flow = entry;
    job.base = job.prog;
    job.share = 1 - job.prog;
    this._beginScalar(job, flow);
  }
  _beginScalar(job, gpuFlow) {
    const e = job.flow, T = this.T;
    if (!e.src) e.src = rasterizeSources(job.geo, e.frame, T);
    if (!e.wall) e.wall = wallDistance(e.voxgrid, T);
    this.adapt = false;
    if (typeof ScalarSolver !== 'function') { this._read(job, false); return; }
    job.stage = 'scalar';
    if (this.solverBusy) { job.gpuFlow = gpuFlow; job.wait = 'solver'; return; }
    job.wait = null;
    const flow = gpuFlow || ScalarSolver.flowFromField(e.wind);
    if (!this.solver) this.solver = new ScalarSolver(T);
    job.turb = this.turbFor(job.key.stab, job.geo);
    job.gpuFlow = null;
    this.solver.begin(flow, e.src, job.turb, e.frame, { wallDist: e.wall, grid: e.voxgrid });
  }
  // GPU work done: read back and deliver; the queue moves on at once (as the reference's `reading`).
  _read(job, withScalar) {
    job.stage = 'read';
    this.current = null;
    this.reading.add(job.id);
    let concP = Promise.resolve(null);
    if (withScalar) {
      concP = Promise.resolve(this.solver.collect());
      const busy = concP.then(() => {}, () => {});
      this.solverBusy = busy;
      busy.then(() => { if (this.solverBusy === busy) this.solverBusy = null; });
    }
    Promise.all([job.flow.windP, concP]).then(
      ([wind, conc]) => this._finish(job, wind, conc),
      (e) => this._fail(job, e, true),
    ).finally(() => { this.reading.delete(job.id); this._flushWaiters(job.id); this._idle(); });
  }
  _finish(job, wind, conc) {
    const rec = conc && typeof conc.receptor === 'function' ? aero_plainReceptor(conc.receptor(RECEPTOR)) : null;
    const t0 = job.t.start, tEnd = performance.now();
    const timing = {
      spin_s: job.t.spin ? (job.t.spin - t0) / 1000 : 0,
      fine_s: job.t.fine ? (job.t.fine - (job.t.spin || t0)) / 1000 : 0,
      scalar_s: job.t.scalar ? (job.t.scalar - (job.t.fine || t0)) / 1000 : 0,
      total_s: (tEnd - t0) / 1000,
      sweeps: job.sweeps || 0,
    };
    const res = { key: job.key, wind, conc: conc || null, receptor: rec, mast: job.flow.mast, grid: this.T.id, hash: job.hash, turb: job.turb || null, timing };
    aero_lruSet(this.cache, this._rid(job), res, this.max);
    if (rec) {
      // q: the solve's quality, carried into the LUT so that an entry that stopped at maxSweeps or has a large mass
      // error is visible to tools/export_lut.py and tools/calibrate.py (physics review 2026-09-28, finding 6).
      const st = (conc && conc.stats) || {};
      const q = { sweeps: st.sweeps ?? null, converged: st.converged ?? null, reason: st.reason ?? null,
        mass_err: Number.isFinite(st.massErr) ? aero_round(st.massErr) : null, mass_ok: st.massWithinTol ?? null };
      const val = { ...rec, q, wind: job.flow.mast, t: Date.now() };
      const sk = this._storeKey(job);
      this.receptors.set(sk, val);
      aero_idbPut(this.db, sk, val);
    }
    this.timing.push({ id: job.id, grid: this.T.id, ...timing });
    this._deliver(res, job);
    this._batchDone(job, 'computed');
  }
  _fail(job, e, detached = false) {
    console.error(`aero: job ${job && job.id} failed in stage ${job && job.stage}`, e);
    this.errors.push({ id: job && job.id, stage: job && job.stage, message: String((e && e.message) || e) });
    if (!detached && this.current === job) {
      this.current = null;
      if (this.tunnel) this.tunnel.job = null;
      if (this.spin) this.spin.job = null;
    }
    this._batchDone(job, 'failed');
  }
  _cancelCurrent() {
    if (this.tunnel) this.tunnel.job = null;
    if (this.spin) this.spin.job = null;
    this.current = null;
  }
  // Tell the page once when the queue runs dry (not every idle frame).
  _idle() {
    if (this.busy || this.idleSent) return;
    this.idleSent = true;
    this.onProgress(null, 1, []);
  }
  _deliver(res, job) {
    const out = job.requested && aero_id(job.requested) !== aero_id(res.key) ? { ...res, key: job.requested } : res;
    try { this.onResult(out, job.kind); } catch (e) { console.error('aero onResult', e); }
  }
  /*
   * A receptor-only sweep job answered from the receptor store (a value computed earlier in this session or
   * restored from IndexedDB) is delivered like a computed one, without fields: res = {key, wind: null,
   * conc: null, receptor, mast, grid, hash, stored: true}. Without this the page never heard of such keys and
   * a "compute all 16 directions" sweep on a second visit waited for results that had been skipped
   * (integration fix, 2026-09-28).
   */
  _deliverStored(job, st) {
    const res = { key: job.key, wind: null, conc: null, receptor: { gamma: st.gamma, age: st.age, band: st.band || null },
      mast: st.wind || null, grid: this.T.id, hash: job.hash, turb: null, timing: null, stored: true };
    this._deliver(res, job);
  }
  _wait(job) { if (!this.waiters.has(job.id)) this.waiters.set(job.id, []); this.waiters.get(job.id).push(job); }
  _flushWaiters(id) {
    const list = this.waiters.get(id);
    if (!list) return;
    this.waiters.delete(id);
    for (const job of list) {
      const hit = this._resultHit(job);
      if (hit) { this._deliver(hit, job); this._batchDone(job, 'cached'); } else this.queue.push(job);
    }
  }
  _batchDone(job, how) {
    if (!job || !job.batches || job.batchCounted) return;
    job.batchCounted = true;
    for (const b of job.batches) { b.done++; b[how] = (b[how] || 0) + 1; }
  }

  // ---------------------------------------------------------------- jobs, geometry and cache look-ups
  _job(key, kind) {
    const requested = aero_key(key);
    const fscen = aero_flowScenario(requested.scenario);
    const k = { ...requested, scenario: fscen };
    return { id: aero_id(k), key: k, requested, fscen, kind, stage: 'wait', wait: null, prog: 0, from: AERO_DIRS[k.dir], batches: [] };
  }
  _resolve(job) {
    try {
      // Hashed every time (a few ms): the scene may mutate a geometry object in place (custom block).
      const geo = this.geometry(job.fscen);
      job.geo = geo;
      job.hash = vox_geoHash(geo);
      return true;
    } catch (e) {
      this.errors.push({ id: job.id, stage: 'geometry', message: String((e && e.message) || e) });
      return false;
    }
  }
  _rid(job) { return `${this.T.id}|${job.id}`; }
  _resultHit(job) {
    if (!job.hash && !this._resolve(job)) return null;
    const r = aero_lruGet(this.cache, this._rid(job));
    return r && r.hash === job.hash ? r : null;
  }
  _flowEntry(job) {
    const e = aero_lruGet(this.flows, `${job.fscen}:${job.key.dir}`);
    return e && e.hash === job.hash && e.grid === this.T.id && !e.failed ? e : null;
  }
  _storeKey(job, turb = job.turb || this.turbFor(job.key.stab, job.geo)) {
    return `${aero_storePrefix()}${this.T.id}|${job.hash}|${job.key.dir}|${job.key.stab}|${aero_hashObj(turb)}`;
  }
  _storedReceptor(job) { return this.receptors.get(this._storeKey(job)) || null; }
  _gpu() {
    if (!this.tunnel) this.tunnel = new WindTunnel(this.T, this.S || null);
    if (this.S && !this.spin) this.spin = new WindTunnel(this.S);
  }
  dispose() {
    this._cancelCurrent();
    for (const w of [this.tunnel, this.spin]) if (w) w.dispose();
    if (this.solver && typeof this.solver.dispose === 'function') this.solver.dispose();
    this.tunnel = this.spin = this.solver = null;
  }

  // ---------------------------------------------------------------- the receptor LUT (architecture §4.4)
  /*
   * exportLUT(scenario = 'today', classes = ['AC', 'D', 'EF']) → {meta, dirs, classes, groups, gamma, age,
   * band, wind}, from the receptor values computed so far for the scenario's current geometry on this grid.
   * Missing entries are null and counted in meta.missing; meta.complete tells whether none is missing.
   * wind[dir] = {s4, s10, dir4, dir10}: the model wind at the mast as a fraction of U10 (neutral flow, so
   * the same for every class).
   */
  exportLUT(scenario = 'today', classes = AERO_GROUPS) {
    const probe = this._job({ scenario, dir: 0, stab: 'D' }, 'sweep');
    this._resolve(probe);
    const gamma = [], age = [], band = [], wind = [], quality = [];
    let missing = 0;
    for (let d = 0; d < 16; d++) {
      const g = [], a = [], b = [], qq = [];
      let w = null;
      for (const stab of classes) {
        const job = this._job({ scenario, dir: d, stab }, 'sweep');
        job.geo = probe.geo; job.hash = probe.hash;
        const e = this._storedReceptor(job);
        if (!e || !e.gamma) missing++;
        g.push(e && e.gamma ? e.gamma : null);
        a.push(e && e.age ? e.age : null);
        b.push(e && e.band ? e.band : null);
        qq.push(e && e.q ? e.q : null);
        if (!w && e && e.wind) w = e.wind;
      }
      if (!w) { const fl = this._flowEntry({ fscen: probe.fscen, key: { dir: d }, hash: probe.hash }); if (fl && fl.mast) w = fl.mast; }
      gamma.push(g); age.push(a); band.push(b); wind.push(w); quality.push(qq);
    }
    const scalar = typeof ScalarSolver === 'function';
    return {
      meta: {
        scenario, grid: this.T.id, generated_utc: new Date().toISOString(), version: 1,
        complete: missing === 0, missing, status: !scalar ? 'wind-only (no ScalarSolver)' : missing ? 'incomplete' : 'complete',
        code: AERO_VERSION, code_hash: aero_codeHash(), geometry_hash: probe.hash, env_generated_utc: (ENV && ENV.meta && ENV.meta.generated_utc) || null,
        // the tree state the LUT was computed with ('on' | 'off' | 'none'; city.js cityGeometry().leaves), so a
        // reader knows which season's crowns are in it (integration addition, 2026-09-28)
        leaves: (probe.geo && probe.geo.leaves) || null,
        spinup: this.S ? this.S.id : null, lbm: { q: LBM.q, software: LBM.software, gpu: LBM.gpu },
        inflow: { ...INFLOW, ustar: aero_round(INFLOW_K.ustar) },
        stab: Object.fromEntries(classes.map((c) => [c, { ...(AERO_STAB[c] || {}), turb_source: (this.turbFor(c, probe.geo) || {}).source || 'turbParams' }])),
        receptor: [RECEPTOR.x, RECEPTOR.y, RECEPTOR.z], mast_heights_m: SITE.station.mast_heights_m,
      },
      dirs: AERO_DIRS.slice(), classes: classes.slice(), groups: (MD.source_groups || ['A', 'B', 'C', 'D']).slice(),
      gamma, age, band, wind,
      // [dir][class] {sweeps, converged, reason, mass_err, mass_ok} of each solve (null for entries from older stores)
      quality,
    };
  }

  /*
   * sweepLUT({scenario = 'today', classes, useStored = true}) → Promise<lut>, the ?sweep=lut boot mode.
   *
   * Contract with main.js (ui) and tools/export_lut.py (flow):
   *   - main.js, once booted, calls `if (PARAMS.get('sweep') === 'lut') aero.sweepLUT()` on its Aero;
   *   - the sweep queues 16 directions × classes for the scenario (direction-major, so the three groups of
   *     a direction share one flow), then drives the queue itself with setTimeout (tick() calls from the
   *     page's frame loop are ignored meanwhile, so the step adaptation sees only this loop);
   *   - progress goes to window.__lutProgress = {state, done, total, failed, job, stage, prog, elapsed_s,
   *     eta_s, grid}; the finished LUT (exportLUT) to window.__lut, and state becomes 'done';
   *   - a second call returns the same promise. If main.js never starts it, export_lut.py calls
   *     window.__z1_startLUT(), which makes an Aero of its own (defined at the end of this file).
   */
  sweepLUT({ scenario = 'today', classes = AERO_GROUPS, useStored = true } = {}) {
    if (AERO_LUT.promise) return AERO_LUT.promise;
    AERO_LUT.aero = this;
    const keys = [];
    for (let d = 0; d < 16; d++) for (const stab of classes) keys.push({ scenario, dir: d, stab });
    const batch = { total: keys.length, done: 0 };
    const t0 = performance.now();
    const publish = (state) => {
      const el = (performance.now() - t0) / 1000, cur = this.current;
      const frac = (batch.done + (cur && cur.batches.includes(batch) ? cur.prog || 0 : 0)) / batch.total;
      const p = {
        state, done: batch.done, total: batch.total, failed: batch.failed || 0, computed: batch.computed || 0,
        job: cur ? cur.id : null, stage: cur ? cur.stage : null, prog: cur ? aero_round(cur.prog) : null,
        elapsed_s: Math.round(el), eta_s: frac > 0.01 ? Math.round((el * (1 - frac)) / frac) : null, grid: this.T.id,
        errors: this.errors.slice(-5),
      };
      try { window.__lutProgress = p; } catch (e) { /* no window */ }
      return p;
    };
    AERO_LUT.promise = new Promise((resolve) => {
      if (!LBM.ok) {
        const lut = this.exportLUT(scenario, classes);
        lut.meta.status = 'unavailable (no float render targets)';
        try { window.__lut = lut; } catch (e) { /* no window */ }
        publish('done');
        resolve(lut);
        return;
      }
      this.db.then(() => {
        this.sweep(keys, { receptorOnly: true, useStored, batch });
        this.driver = true;
        const loop = () => {
          try { this._tick(); } catch (e) { console.error('aero sweepLUT', e); }
          if (batch.done < batch.total || this.reading.size) { publish('running'); setTimeout(loop, 0); return; }
          this.driver = false;
          const lut = this.exportLUT(scenario, classes);
          const tm = this.timing.filter((x) => x.grid === this.T.id);
          lut.meta.timing = {
            total_s: aero_round((performance.now() - t0) / 1000),
            jobs: tm.length,
            flow_s_mean: aero_round(mean(tm.filter((x) => x.fine_s > 0).map((x) => x.spin_s + x.fine_s))),
            scalar_s_mean: aero_round(mean(tm.filter((x) => x.scalar_s > 0).map((x) => x.scalar_s))),
            from_store: batch.stored || 0, failed: batch.failed || 0,
          };
          try { window.__lut = lut; } catch (e) { /* no window */ }
          publish('done');
          resolve(lut);
        };
        const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
        publish('running');
        loop();
      });
    });
    return AERO_LUT.promise;
  }
}

// The one LUT sweep of this page (sweepLUT), and the export tool's fallback starter.
const AERO_LUT = { promise: null, aero: null };
try {
  window.__z1_startLUT = (opts) => (AERO_LUT.promise || (AERO_LUT.aero || new Aero({ persist: false })).sweepLUT(opts));
} catch (e) { /* no window */ }
