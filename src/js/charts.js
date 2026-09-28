// ------------------------------------------------------------------ charts (owner: ui)
/*
 * Dependency-free SVG charts for the side panel (architecture §6.4):
 *
 *   lineChart(el, opts)     time series (hour-ending UTC ms on x) with an optional factor-2 band, limit lines,
 *                           a "now" line, a selected-hour marker, a crosshair tooltip and click/Enter to pick an hour
 *   diurnalChart(el, opts)  24 values by local hour-start (0–23) per series (weekday / Saturday / Sunday)
 *   roseChart(el, opts)     16-sector pollution rose: petals for one series, a polygon for the comparison
 *   barChart(el, opts)      columns with limit lines (mode 'column'), or horizontal stacked bars (mode 'stack')
 *
 * Design rules (dataviz skill, validated for this app's panel surfaces with scripts/validate_palette.py):
 *   - Colour is set only through CSS classes (.s1–.s4 categorical slots, .s0 the neutral "background"
 *     series), so style.css switches light and dark mode through the tokens on :root.
 *     Slots 1–4 = #2a78d6 #eb6834 #1baf7a #eda100 (light) / #3987e5 #d95926 #199e70 #c98500 (dark) pass the
 *     lightness, chroma, adjacent-CVD (worst ΔE 9.1 / 8.4) and normal-vision (22.9 / 19.8) checks on the panel
 *     surfaces #eef1f0 / #11191e. Three light slots are below 3:1 contrast, so every chart ships a legend,
 *     selective direct labels and a data table (the "relief rule").
 *   - 2 px lines, ≥ 8 px markers with a 2 px surface ring, columns ≤ 24 px with 4 px rounded data ends,
 *     2 px surface gaps between stacked segments, hairline solid grid. Dashed strokes are reserved for
 *     meaning: limit lines and the "validated" measurement series.
 *   - Every chart is an <svg role="img"> with an aria-label, has a hover/focus tooltip (values lead, labels
 *     follow) and a <details> table with the same numbers, so no value is reachable only by hovering.
 *   - Text never wears the series colour; labels come in through textContent, never innerHTML.
 *
 * Each function clears `el`, renders into it and returns {svg, update?}. Numbers use fmt() (core.js) so the
 * decimal separator follows the language.
 */

const chart_STRINGS = {
  hr: {
    'chart.table': 'Brojke u tablici',
    'chart.time': 'Sat (lokalno, kraj sata)',
    'chart.hour': 'Sat (početak)',
    'chart.dir': 'Smjer',
    'chart.nodata': 'Nema podataka za ovaj prikaz.',
    'chart.offscale': 'izvan ljestvice',
    'chart.negzero': 'Negativne vrijednosti nacrtane su na nuli; točne brojke su u tablici.',
    'chart.pick': 'Klikni ili pritisni Enter za odabir sata.',
    'chart.keys': 'Strelice pomiču oznaku.',
    'chart.total': 'Ukupno',
    'chart.share': 'udio',
    'chart.ratio': 'omjer',
  },
  en: {
    'chart.table': 'Numbers as a table',
    'chart.time': 'Hour (local, hour ending)',
    'chart.hour': 'Hour (start)',
    'chart.dir': 'Direction',
    'chart.nodata': 'No data for this view.',
    'chart.offscale': 'off scale',
    'chart.negzero': 'Negative values are drawn at zero; exact numbers are in the table.',
    'chart.pick': 'Click or press Enter to pick an hour.',
    'chart.keys': 'Arrow keys move the marker.',
    'chart.total': 'Total',
    'chart.share': 'share',
    'chart.ratio': 'ratio',
  },
};
I18N.add(chart_STRINGS);

const chart_NS = 'http://www.w3.org/2000/svg';
// viewBox width = the panel's content width: 372 px panel − 2 × 22 px padding (style.css #panel). The SVG is
// scaled to 100 % of its container, so at phone width (390 − 2 × 16 px) text grows by ~9 %.
const chart_W = 328;
const chart_M = { l: 36, r: 10, t: 14, b: 24 };   // plot margins: y tick labels, end labels, top note, x ticks

// ---------------------------------------------------------------- DOM helpers
function chart_svg(tag, attrs, parent) {
  const e = document.createElementNS(chart_NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function chart_html(tag, cls, text, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
const chart_r1 = (v) => Math.round(v * 10) / 10;   // SVG coordinates to 0.1 px

/*
 * "Nice" axis ticks (after Heckbert, "Nice numbers for graph labels", Graphics Gems 1990): the step is 1, 2, 2.5
 * or 5 times a power of ten. We take the smallest such step that covers [lo, hi] in at most n + 1 intervals, which
 * keeps the headroom above the data small (0–0.42 → 0–0.5 in 0.1 steps rather than 0–0.6 in 0.2 steps).
 * Ticks are rounded to the step's decimals so no float noise (0.6000000000000001) reaches a label.
 */
function chart_dec(step) {
  let d = 0;
  while (d < 6 && Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) > 1e-6 * 10 ** d) d++;
  return d;
}
function chart_nice(lo, hi, n = 4) {
  if (!(hi > lo)) hi = lo + 1;
  const mag = 10 ** Math.floor(Math.log10((hi - lo) / n));
  for (const m of [1, 2, 2.5, 5, 10, 20, 25, 50]) {
    const step = m * mag;
    const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step;
    if ((b - a) / step > n + 1 + 1e-9) continue;
    const d = chart_dec(step), ticks = [];
    for (let k = 0; a + k * step <= b + step * 1e-6; k++) ticks.push(Number((a + k * step).toFixed(d)) || 0);
    return { lo: Number(a.toFixed(d)), hi: Number(b.toFixed(d)), step, ticks };
  }
  return { lo, hi, step: hi - lo, ticks: [lo, hi] };
}

/** Container: a .chart wrapper with the svg, a tooltip and an sr-only live readout. */
function chart_frame(el, { label, height, focusable = false }) {
  el.textContent = '';
  const wrap = chart_html('div', 'chart', null, el);
  const svg = chart_svg('svg', { viewBox: `0 0 ${chart_W} ${height}`, role: 'img', 'aria-label': label }, wrap);
  if (focusable) svg.setAttribute('tabindex', '0');
  const tip = chart_html('div', 'tip', null, wrap);
  tip.hidden = true;
  const live = chart_html('div', 'sr', null, wrap);
  live.setAttribute('aria-live', 'polite');
  return { wrap, svg, tip, live, H: height };
}

/*
 * Tooltip: a title line, then one row per series with the value first (strong) and the series name after it,
 * keyed by a short stroke of the series colour. xFrac (0..1) positions it horizontally over the chart.
 */
function chart_tipShow(fr, xFrac, title, rows) {
  const { tip, live } = fr;
  tip.textContent = '';
  chart_html('div', 'tip-title', title, tip);
  const readout = [title];
  for (const r of rows) {
    const row = chart_html('div', 'tip-row', null, tip);
    if (r.cls) chart_html('i', `key ${r.kind || 'line'} ${r.cls}`, null, row);
    chart_html('b', null, r.value, row);
    chart_html('span', null, r.label, row);
    readout.push(`${r.label} ${r.value}`);
  }
  tip.hidden = false;
  tip.style.left = `${clamp(xFrac * 100, 20, 80)}%`;
  live.textContent = readout.join(', ');
}
function chart_tipHide(fr) { fr.tip.hidden = true; }

/** HTML legend above a chart: items [{cls, label, kind: 'line' | 'dash' | 'rect' | 'band' | 'dot'}]. */
function chart_legend(el, items) {
  const box = chart_html('div', 'chart-legend', null, el);
  for (const it of items) {
    const s = chart_html('span', null, null, box);
    chart_html('i', `key ${it.kind || 'line'} ${it.cls || ''}`, null, s);
    s.appendChild(document.createTextNode(it.label));
  }
  return box;
}

/** The <details> data-table twin of a chart. head: [string], rows: [[string|number]]. */
function chart_table(el, caption, head, rows) {
  const d = chart_html('details', 'chart-table', null, el);
  chart_html('summary', null, t('chart.table'), d);
  const sc = chart_html('div', 'table-scroll', null, d);
  const tb = chart_html('table', 'compare data-table', null, sc);
  if (caption) chart_html('caption', 'sr', caption, tb);
  const tr = chart_html('tr', null, null, chart_html('thead', null, null, tb));
  head.forEach((h, i) => { const th = chart_html('th', null, h, tr); th.scope = 'col'; if (i === 0) th.className = 'first'; });
  const body = chart_html('tbody', null, null, tb);
  for (const r of rows) {
    const row = chart_html('tr', null, null, body);
    r.forEach((c, i) => {
      const cell = chart_html(i === 0 ? 'th' : 'td', null, typeof c === 'number' ? fmt(c, Math.abs(c) < 10 ? 1 : 0) : (c ?? '–'), row);
      if (i === 0) cell.scope = 'row';
    });
  }
  return d;
}

function chart_empty(el, label) {
  el.textContent = '';
  const p = chart_html('p', 'chart-empty', t('chart.nodata'), el);
  p.setAttribute('role', 'note');
  p.setAttribute('aria-label', `${label}: ${t('chart.nodata')}`);
  return { svg: null };
}

// ---------------------------------------------------------------- shared x–y plot
/*
 * The line and diurnal charts share one x–y plot. x is either time (hour-ending UTC ms, ticks in Zagreb local
 * time) or the local hour 0–23. Series are drawn as 2 px polylines broken at missing values (NaN or gaps longer
 * than one step), so a missing hour is never bridged by an invented line.
 */
function chart_xy(el, o) {
  const series = (o.series || []).filter((s) => s.points && s.points.some((p) => Number.isFinite(p.v)));
  if (!series.length) return chart_empty(el, o.label);
  const H = o.height || 190;
  const fr = chart_frame(el, { label: o.label, height: H, focusable: true });
  const { svg } = fr;
  const L = chart_M.l, R = chart_W - chart_M.r, T = chart_M.t, B = H - chart_M.b;
  const step = o.step || 1;

  // x domain
  let x0 = Infinity, x1 = -Infinity;
  for (const s of series) for (const p of s.points) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; }
  if (o.domain) [x0, x1] = o.domain;
  if (!(x1 > x0)) x1 = x0 + step;
  const X = (x) => L + ((x - x0) / (x1 - x0)) * (R - L);

  // y domain: the data (+8 % headroom), plus limit lines that sit within 1.6× of the data so they stay readable.
  let dmax = 0, dmin = 0;
  for (const s of series) for (const p of s.points) if (Number.isFinite(p.v)) { dmax = Math.max(dmax, p.v); dmin = Math.min(dmin, p.v); }
  let ymax = o.yMax || dmax * 1.08 || 1;
  const thr = (o.thresholds || []).filter((q) => Number.isFinite(q.v));
  for (const q of thr) if (q.v > ymax && q.v <= dmax * 1.6) ymax = q.v * 1.04;
  const ny = chart_nice(Math.min(o.yMin ?? 0, dmin), ymax, 4);
  const Y = (v) => B - ((v - ny.lo) / (ny.hi - ny.lo)) * (B - T);
  const dec = chart_dec(ny.step);

  // clip so the factor-2 band and steep lines never paint outside the plot
  const cid = `c${Math.random().toString(36).slice(2, 9)}`;
  chart_svg('rect', { x: L, y: T, width: R - L, height: B - T }, chart_svg('clipPath', { id: cid }, chart_svg('defs', null, svg)));

  // grid + y ticks
  const g = chart_svg('g', { class: 'axis' }, svg);
  for (const v of ny.ticks) {
    chart_svg('line', { class: v === 0 ? 'base' : 'grid', x1: L, x2: R, y1: chart_r1(Y(v)), y2: chart_r1(Y(v)) }, g);
    chart_svg('text', { class: 'tick', x: L - 5, y: chart_r1(Y(v)) }, g).textContent = fmt(v, dec);
  }
  if (o.unit) chart_svg('text', { class: 'unit', x: L - 5, y: T - 6 }, g).textContent = o.unit;

  // x ticks
  for (const tk of o.xTicks(x0, x1, R - L)) {
    const x = chart_r1(X(tk.x));
    chart_svg('line', { class: tk.major ? 'grid major' : 'grid', x1: x, x2: x, y1: T, y2: B }, g);
    chart_svg('text', { class: `xtick${tk.major ? ' major' : ''}`, x, y: B + 14 }, g).textContent = tk.label;
  }

  const plot = chart_svg('g', { 'clip-path': `url(#${cid})` }, svg);

  // factor-2 band: a 10 % wash between lo and hi (dataviz: area fills are washes, never blocks)
  if (o.band && o.band.lo && o.band.hi) {
    const hiMap = new Map(o.band.hi.map((p) => [p.x, p.v]));
    let d = '', run = [];
    const flush = () => {
      if (run.length > 1) {
        d += 'M' + run.map((p) => `${chart_r1(X(p.x))},${chart_r1(Y(p.hi))}`).join('L');
        d += 'L' + run.slice().reverse().map((p) => `${chart_r1(X(p.x))},${chart_r1(Y(p.lo))}`).join('L') + 'Z';
      }
      run = [];
    };
    let prev = null;
    for (const p of o.band.lo) {
      const hi = hiMap.get(p.x);
      if (!Number.isFinite(p.v) || !Number.isFinite(hi) || (prev !== null && p.x - prev > step * 1.5)) flush();
      if (Number.isFinite(p.v) && Number.isFinite(hi)) run.push({ x: p.x, lo: p.v, hi });
      prev = p.x;
    }
    flush();
    if (d) chart_svg('path', { class: `band ${o.band.cls || 's2'}`, d }, plot);
  }

  // limit lines (dashed = a threshold, never a grid), labelled at the right end; off-scale ones listed at the top
  const off = [];
  for (const q of thr) {
    if (q.v > ny.hi) { off.push(q); continue; }
    const y = chart_r1(Y(q.v));
    chart_svg('line', { class: 'thr', x1: L, x2: R, y1: y, y2: y }, svg);
    chart_svg('text', { class: 'thr-label', x: R - 2, y: y - 4 }, svg).textContent = q.label;
  }
  if (off.length) {
    chart_svg('text', { class: 'thr-label', x: R - 2, y: T - 4 }, svg).textContent =
      '↑ ' + off.map((q) => q.label).join(', ') + ` (${t('chart.offscale')})`;
  }

  // "now" line and the selected-hour marker
  if (Number.isFinite(o.now) && o.now >= x0 && o.now <= x1) {
    const x = chart_r1(X(o.now));
    chart_svg('line', { class: 'now', x1: x, x2: x, y1: T, y2: B }, svg);
    if (o.nowLabel) chart_svg('text', { class: 'now-label', x: x + 3, y: T + 8 }, svg).textContent = o.nowLabel;
  }
  if (Number.isFinite(o.marker) && o.marker >= x0 && o.marker <= x1) {
    const x = chart_r1(X(o.marker));
    chart_svg('line', { class: 'marker', x1: x, x2: x, y1: T, y2: B }, svg);
  }

  // series
  const lookup = series.map((s) => new Map(s.points.map((p) => [p.x, p.v])));
  series.forEach((s) => {
    let d = '', prev = null, pen = false;
    for (const p of s.points) {
      if (!Number.isFinite(p.v)) { pen = false; prev = p.x; continue; }
      const gap = prev !== null && p.x - prev > step * 1.5;
      d += `${!pen || gap ? 'M' : 'L'}${chart_r1(X(p.x))},${chart_r1(Y(p.v))}`;
      pen = true; prev = p.x;
    }
    chart_svg('path', { class: `ln ${s.cls || 's1'}${s.dash ? ' dash' : ''}`, d }, plot);
    // a lone point (no neighbours) would be invisible as a path: mark it
    const fin = s.points.filter((p) => Number.isFinite(p.v));
    if (fin.length === 1) chart_svg('circle', { class: `dot ${s.cls || 's1'}`, cx: chart_r1(X(fin[0].x)), cy: chart_r1(Y(fin[0].v)), r: 4 }, svg);
  });

  // end labels: the last value of the first two series (selective direct labels)
  if (o.endLabels !== false) {
    const used = [];
    for (const s of series.slice(0, 2)) {
      const last = [...s.points].reverse().find((p) => Number.isFinite(p.v));
      if (!last) continue;
      let y = Y(last.v) - 6;
      if (used.some((u) => Math.abs(u - y) < 10)) continue;   // colliding labels: legend + tooltip carry it
      used.push(y);
      chart_svg('text', { class: 'end-label', x: chart_r1(Math.min(R - 2, X(last.x) - 2)), y: chart_r1(Math.max(T + 8, y)) }, svg).textContent = fmt(last.v, dec);
    }
  }

  // crosshair + tooltip; keyboard: ←/→ move, Home/End, Enter/Space pick, Esc hide
  const cross = chart_svg('g', { class: 'cross', visibility: 'hidden' }, svg);
  const cl = chart_svg('line', { y1: T, y2: B }, cross);
  const dots = series.map((s) => chart_svg('circle', { class: `dot ${s.cls || 's1'}`, r: 4 }, cross));
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
  let cur = -1;
  const show = (i) => {
    if (i < 0 || i >= xs.length) return;
    cur = i;
    const x = xs[i], px = X(x);
    cross.setAttribute('visibility', 'visible');
    cl.setAttribute('x1', chart_r1(px)); cl.setAttribute('x2', chart_r1(px));
    const rows = [];
    series.forEach((s, k) => {
      const v = lookup[k].get(x);
      if (Number.isFinite(v)) {
        dots[k].setAttribute('cx', chart_r1(px)); dots[k].setAttribute('cy', chart_r1(Y(v))); dots[k].setAttribute('visibility', 'visible');
        rows.push({ cls: s.cls || 's1', kind: s.dash ? 'dash' : 'line', label: s.label, value: `${fmt(v, dec)}${o.unit ? ' ' + o.unit : ''}` });
      } else dots[k].setAttribute('visibility', 'hidden');
    });
    if (o.band && o.band.lo) {
      const lo = o.band.lo.find((p) => p.x === x), hi = o.band.hi.find((p) => p.x === x);
      if (lo && hi && Number.isFinite(lo.v)) rows.push({ cls: o.band.cls || 's2', kind: 'band', label: o.band.label, value: `${fmt(lo.v, dec)}–${fmt(hi.v, dec)}` });
    }
    chart_tipShow(fr, (px) / chart_W, o.fmtX(x), rows);
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); chart_tipHide(fr); };
  const nearest = (evt) => {
    const r = svg.getBoundingClientRect();
    const xv = x0 + (((evt.clientX - r.left) / r.width) * chart_W - L) / (R - L) * (x1 - x0);
    let best = 0, bd = Infinity;
    for (let i = 0; i < xs.length; i++) { const dd = Math.abs(xs[i] - xv); if (dd < bd) { bd = dd; best = i; } }
    return best;
  };
  const hit = chart_svg('rect', { class: 'hit', x: L, y: T, width: R - L, height: B - T }, svg);
  hit.addEventListener('pointermove', (e) => show(nearest(e)));
  hit.addEventListener('pointerleave', hide);
  if (o.onPick) {
    hit.style.cursor = 'pointer';
    hit.addEventListener('click', (e) => { const i = nearest(e); o.onPick(xs[i]); });
  }
  svg.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowLeft' || k === 'Home' || k === 'End') {
      e.preventDefault();
      const start = cur < 0 ? (Number.isFinite(o.marker) ? Math.max(0, xs.findIndex((x) => x >= o.marker)) : 0) : cur;
      show(k === 'Home' ? 0 : k === 'End' ? xs.length - 1 : clamp(start + (k === 'ArrowRight' ? 1 : -1), 0, xs.length - 1));
    } else if ((k === 'Enter' || k === ' ') && o.onPick && cur >= 0) { e.preventDefault(); o.onPick(xs[cur]); }
    else if (k === 'Escape') hide();
  });
  svg.addEventListener('blur', hide);
  svg.setAttribute('aria-label', `${o.label}. ${t('chart.keys')}${o.onPick ? ' ' + t('chart.pick') : ''}`);

  if (o.legend !== false) {
    const items = series.map((s) => ({ cls: s.cls || 's1', label: s.label, kind: s.dash ? 'dash' : 'line' }));
    if (o.band && o.band.label) items.push({ cls: o.band.cls || 's2', label: o.band.label, kind: 'band' });
    el.insertBefore(chart_legend(document.createDocumentFragment(), items), fr.wrap);
  }
  if (o.table !== false) {
    const head = [o.xTitle, ...series.map((s) => s.label)];
    const rows = xs.map((x, i) => [o.fmtX(x), ...lookup.map((m) => { const v = m.get(x); return Number.isFinite(v) ? fmt(v, dec) : '–'; })]);
    chart_table(el, o.label, head, rows);
  }
  return { svg, show, hide };
}

/**
 * lineChart(el, {series: [{label, points: [{t, v}], cls, dash}], band: {lo, hi, label}, thresholds: [{v, label}],
 *   unit, yMax, label, now, nowLabel, marker, onPick(t), domain: [t0, t1], height, table, legend})
 * Times are hour-ending UTC ms; ticks every 3, 6, 12 or 24 local hours, the densest step that keeps labels at least
 * 44 px apart on the actual plot width (a date label such as "29 Sep" is ~40 px), with dates at local midnight.
 */
function lineChart(el, opts) {
  const toXY = (pts) => (pts || []).map((p) => ({ x: p.t, v: p.v }));
  const series = (opts.series || []).map((s) => ({ ...s, points: toXY(s.points) }));
  const band = opts.band ? { ...opts.band, lo: toXY(opts.band.lo), hi: toXY(opts.band.hi) } : null;
  return chart_xy(el, {
    ...opts, series, band, step: data_HOUR,
    domain: opts.domain,
    xTitle: t('chart.time'),
    fmtX: (x) => fmtLocal(x, { ending: true }),
    xTicks(a, b, widthPx = 300) {
      const span = Math.max(b - a, data_HOUR), pxPerHour = (widthPx * data_HOUR) / span;
      const every = [3, 6, 12, 24, 48, 96, 168, 336, 720, 1440, 2160, 4320, 8760].find((h) => h * pxPerHour >= 44) || 8760, out = [];
      let midnights = 0;
      for (let x = ZgTime.ceilHour(a); x <= b; x += data_HOUR) {
        const p = ZgTime.parts(x);
        if (every > 24) {   // multi-day steps: every (every / 24)-th local midnight
          if (p.h !== 0 || midnights++ % (every / 24) !== 0) continue;
        } else if (p.h % every !== 0) continue;
        out.push({ x, major: p.h === 0, label: p.h === 0 ? fmtLocal(x, { time: false }) : String(p.h).padStart(2, '0') });
      }
      return out;
    },
  });
}

/**
 * diurnalChart(el, {series: [{label, values: [24], cls}], unit, label, thresholds, height, table})
 * x = local hour at the START of the averaging interval (architecture §2), as in MEAS.stats.diurnal.
 */
function diurnalChart(el, opts) {
  const series = (opts.series || []).map((s) => ({ ...s, points: (s.values || []).map((v, h) => ({ x: h, v: Number.isFinite(v) ? v : NaN })) }));
  return chart_xy(el, {
    ...opts, series, step: 1, domain: [0, 23],
    xTitle: t('chart.hour'),
    fmtX: (h) => `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00`,
    xTicks: () => [0, 3, 6, 9, 12, 15, 18, 21].map((h) => ({ x: h, major: h === 0 || h === 12, label: String(h).padStart(2, '0') })),
  });
}

// ---------------------------------------------------------------- rose
/**
 * roseChart(el, {values: [16], compare: [16] | null, labels: [16], valueLabel, compareLabel, unit, current: 0..15,
 *   label, table, size})
 * Sector k is centred on k × 22.5° (the "from" direction, clockwise from north, architecture §2). Petal radius is
 * linear in the value (the values are means, not frequencies). Petals span 18° of the 22.5° sector, which leaves
 * the surface gap between neighbours.
 */
function roseChart(el, opts) {
  const vals = (opts.values || []).map(Number);
  const cmp = opts.compare ? opts.compare.map(Number) : null;
  const all = [...vals, ...(cmp || [])].filter(Number.isFinite);
  if (!all.length) return chart_empty(el, opts.label);
  const H = opts.size || 272, cx = chart_W / 2, cy = H / 2, Rr = Math.min(cx, cy) - 26;
  const fr = chart_frame(el, { label: opts.label, height: H, focusable: true });
  const { svg } = fr;
  const nr = chart_nice(0, Math.max(...all, 1e-6), 3);
  const r = (v) => (Math.max(0, v) / nr.hi) * Rr;
  const pt = (deg, rad) => [cx + Math.sin(deg * DEG) * rad, cy - Math.cos(deg * DEG) * rad];
  const dec = chart_dec(nr.step);
  const labels = opts.labels || chart_dirLabels();

  const g = chart_svg('g', { class: 'axis' }, svg);
  for (const v of nr.ticks.slice(1)) chart_svg('circle', { class: 'grid', cx, cy, r: chart_r1(r(v)) }, g);
  for (let k = 0; k < 16; k++) {
    const [x, y] = pt(k * 22.5, Rr);
    chart_svg('line', { class: 'grid', x1: cx, y1: cy, x2: chart_r1(x), y2: chart_r1(y) }, g);
    const [lx, ly] = pt(k * 22.5, Rr + 13);
    chart_svg('text', { class: `dir${k % 4 === 0 ? ' main' : ''}${k === opts.current ? ' cur' : ''}`, x: chart_r1(lx), y: chart_r1(ly) }, g).textContent = labels[k] || '';
  }
  for (const v of nr.ticks.slice(1)) {
    const [x, y] = pt(11.25, r(v));
    chart_svg('text', { class: 'tick rose-tick', x: chart_r1(x + 2), y: chart_r1(y) }, g).textContent = fmt(v, dec);
  }
  if (opts.unit) chart_svg('text', { class: 'unit', x: 4, y: 12 }, g).textContent = opts.unit;

  // petals (series 1)
  const half = 9;   // degrees: 18° of each 22.5° sector
  vals.forEach((v, k) => {
    if (!Number.isFinite(v) || v <= 0) return;
    const a0 = k * 22.5 - half, a1 = k * 22.5 + half, rr = r(v);
    const [x0, y0] = pt(a0, rr), [x1, y1] = pt(a1, rr);
    chart_svg('path', { class: `petal s1${k === opts.current ? ' cur' : ''}`, d: `M${cx},${cy}L${chart_r1(x0)},${chart_r1(y0)}A${chart_r1(rr)},${chart_r1(rr)} 0 0 1 ${chart_r1(x1)},${chart_r1(y1)}Z` }, svg);
  });
  // comparison polygon (series 2), broken where values are missing
  if (cmp) {
    let d = '', pen = false;
    for (let k = 0; k <= 16; k++) {
      const v = cmp[k % 16];
      if (!Number.isFinite(v)) { pen = false; continue; }
      const [x, y] = pt((k % 16) * 22.5, r(v));
      d += `${pen ? 'L' : 'M'}${chart_r1(x)},${chart_r1(y)}`;
      pen = true;
    }
    chart_svg('path', { class: 'ln s2 rose-line', d }, svg);
    cmp.forEach((v, k) => {
      if (!Number.isFinite(v)) return;
      const [x, y] = pt(k * 22.5, r(v));
      chart_svg('circle', { class: 'dot s2', cx: chart_r1(x), cy: chart_r1(y), r: 4 }, svg);
    });
  }

  // per-sector hit wedges + keyboard cycling
  const hl = chart_svg('path', { class: 'rose-hl', visibility: 'hidden' }, svg);
  const show = (k) => {
    const a0 = k * 22.5 - 11.25, a1 = k * 22.5 + 11.25, rr = Rr;
    const [x0, y0] = pt(a0, rr), [x1, y1] = pt(a1, rr);
    hl.setAttribute('d', `M${cx},${cy}L${chart_r1(x0)},${chart_r1(y0)}A${rr},${rr} 0 0 1 ${chart_r1(x1)},${chart_r1(y1)}Z`);
    hl.setAttribute('visibility', 'visible');
    const rows = [];
    const u = opts.unit ? ' ' + opts.unit : '';
    if (Number.isFinite(vals[k])) rows.push({ cls: 's1', kind: 'rect', label: opts.valueLabel || '', value: fmt(vals[k], dec) + u });
    if (cmp && Number.isFinite(cmp[k])) rows.push({ cls: 's2', kind: 'line', label: opts.compareLabel || '', value: fmt(cmp[k], dec) + u });
    if (cmp && Number.isFinite(vals[k]) && Number.isFinite(cmp[k]) && cmp[k] !== 0) rows.push({ label: t('chart.ratio'), value: fmt(vals[k] / cmp[k], 2) });
    const [px] = pt(k * 22.5, Rr * 0.6);
    chart_tipShow(fr, px / chart_W, labels[k] || String(k * 22.5), rows);
  };
  const hide = () => { hl.setAttribute('visibility', 'hidden'); chart_tipHide(fr); };
  let cur = -1;
  for (let k = 0; k < 16; k++) {
    const a0 = k * 22.5 - 11.25, a1 = k * 22.5 + 11.25, rr = Rr + 20;
    const [x0, y0] = pt(a0, rr), [x1, y1] = pt(a1, rr);
    const w = chart_svg('path', { class: 'hit', d: `M${cx},${cy}L${chart_r1(x0)},${chart_r1(y0)}A${rr},${rr} 0 0 1 ${chart_r1(x1)},${chart_r1(y1)}Z` }, svg);
    w.addEventListener('pointerenter', () => { cur = k; show(k); });
    w.addEventListener('pointerleave', hide);
  }
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); cur = (cur + 1 + 16) % 16; show(cur); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); cur = (cur - 1 + 32) % 16; show(cur); }
    else if (e.key === 'Escape') hide();
  });
  svg.addEventListener('blur', hide);
  svg.setAttribute('aria-label', `${opts.label}. ${t('chart.keys')}`);

  const items = [{ cls: 's1', label: opts.valueLabel || '', kind: 'rect' }];
  if (cmp) items.push({ cls: 's2', label: opts.compareLabel || '', kind: 'line' });
  el.insertBefore(chart_legend(document.createDocumentFragment(), items), fr.wrap);
  if (vals.some((v) => v < 0) || (cmp && cmp.some((v) => v < 0))) chart_html('p', 'hint', t('chart.negzero'), el);
  if (opts.table !== false) {
    const head = [t('chart.dir'), opts.valueLabel || ''];
    if (cmp) head.push(opts.compareLabel || '', t('chart.ratio'));
    const rows = vals.map((v, k) => {
      const row = [labels[k] || String(k * 22.5), Number.isFinite(v) ? fmt(v, dec) : '–'];
      if (cmp) row.push(Number.isFinite(cmp[k]) ? fmt(cmp[k], dec) : '–', Number.isFinite(v) && Number.isFinite(cmp[k]) && cmp[k] ? fmt(v / cmp[k], 2) : '–');
      return row;
    });
    if (opts.extraColumns) opts.extraColumns(head, rows);
    chart_table(el, opts.label, head, rows);
  }
  return { svg, show, hide };
}
// Direction labels when the caller passes none: dirName() from meteo.js if present, else bearings in degrees.
function chart_dirLabels() {
  return Array.from({ length: 16 }, (_, k) => {
    if (typeof dirName === 'function') { try { return dirName(k * 22.5).short; } catch (e) { /* fall through */ } }
    return `${fmt(k * 22.5, k % 2 ? 1 : 0)}°`;
  });
}

// ---------------------------------------------------------------- bars
/*
 * Column path with 4 px rounded data end and a square baseline (dataviz marks spec).
 */
function chart_colPath(x, y0, y1, w) {
  const h = y0 - y1;
  if (h <= 0.5) return `M${x},${y0}H${x + w}`;
  const rr = Math.min(4, w / 2, h);
  return `M${chart_r1(x)},${chart_r1(y0)}V${chart_r1(y1 + rr)}Q${chart_r1(x)},${chart_r1(y1)} ${chart_r1(x + rr)},${chart_r1(y1)}`
    + `H${chart_r1(x + w - rr)}Q${chart_r1(x + w)},${chart_r1(y1)} ${chart_r1(x + w)},${chart_r1(y1 + rr)}V${chart_r1(y0)}Z`;
}

/**
 * barChart(el, opts)
 *  mode 'column' (default): {bars: [{label, value, cls, note}], thresholds: [{v, label}], unit, label, highlight, height}
 *  mode 'stack':            {rows: [{label, segments: [{id, label, value, cls}]}], unit, label, legend: true}
 */
function barChart(el, opts) {
  return opts.mode === 'stack' ? chart_stack(el, opts) : chart_columns(el, opts);
}

function chart_columns(el, o) {
  const bars = (o.bars || []);
  if (!bars.some((b) => Number.isFinite(b.value))) return chart_empty(el, o.label);
  const H = o.height || 170;
  const fr = chart_frame(el, { label: o.label, height: H, focusable: true });
  const { svg } = fr;
  const L = chart_M.l, R = chart_W - chart_M.r, T = chart_M.t + 4, B = H - chart_M.b;
  const dmax = Math.max(0, ...bars.map((b) => (Number.isFinite(b.value) ? b.value : 0)));
  let ymax = o.yMax || dmax * 1.1 || 1;
  const thr = (o.thresholds || []).filter((q) => Number.isFinite(q.v));
  for (const q of thr) if (q.v > ymax && q.v <= Math.max(dmax, 1) * 2.2) ymax = q.v * 1.05;   // annual limits are close to the data
  const ny = chart_nice(0, ymax, 4);
  const Y = (v) => B - (v / ny.hi) * (B - T);
  const dec = chart_dec(ny.step);
  const g = chart_svg('g', { class: 'axis' }, svg);
  for (const v of ny.ticks) {
    chart_svg('line', { class: v === 0 ? 'base' : 'grid', x1: L, x2: R, y1: chart_r1(Y(v)), y2: chart_r1(Y(v)) }, g);
    chart_svg('text', { class: 'tick', x: L - 5, y: chart_r1(Y(v)) }, g).textContent = fmt(v, dec);
  }
  if (o.unit) chart_svg('text', { class: 'unit', x: L - 5, y: T - 8 }, g).textContent = o.unit;
  const band = (R - L) / bars.length, w = Math.min(24, band * 0.62);
  const maxI = bars.reduce((bi, b, i) => (Number.isFinite(b.value) && b.value > (bars[bi].value ?? -Infinity) ? i : bi), 0);
  const labelAll = bars.length <= 6;
  const hits = [];
  bars.forEach((b, i) => {
    const cx = L + band * (i + 0.5);
    chart_svg('text', { class: `xtick${i === o.highlight ? ' major' : ''}`, x: chart_r1(cx), y: B + 14 }, g).textContent = b.label;
    if (!Number.isFinite(b.value)) {
      chart_svg('text', { class: 'val muted', x: chart_r1(cx), y: B - 4 }, svg).textContent = '–';
      return;
    }
    chart_svg('path', { class: `col ${b.cls || 's1'}${i === o.highlight ? ' cur' : ''}`, d: chart_colPath(cx - w / 2, Y(0), Y(Math.max(0, b.value)), w) }, svg);
    if (labelAll || i === maxI || i === o.highlight) chart_svg('text', { class: 'val', x: chart_r1(cx), y: chart_r1(Y(Math.max(0, b.value)) - 5) }, svg).textContent = fmt(b.value, b.value < 10 ? 1 : 0);
    hits.push({ i, x: cx - band / 2 });
  });
  const off = [];
  for (const q of thr) {
    if (q.v > ny.hi) { off.push(q); continue; }
    const y = chart_r1(Y(q.v));
    chart_svg('line', { class: 'thr', x1: L, x2: R, y1: y, y2: y }, svg);
    chart_svg('text', { class: 'thr-label', x: R - 2, y: y - 4 }, svg).textContent = q.label;
  }
  if (off.length) chart_svg('text', { class: 'thr-label', x: R - 2, y: T - 8 }, svg).textContent = '↑ ' + off.map((q) => q.label).join(', ') + ` (${t('chart.offscale')})`;
  const show = (i) => {
    const b = bars[i];
    const rows = [{ cls: b.cls || 's1', kind: 'rect', label: o.seriesLabel || '', value: Number.isFinite(b.value) ? `${fmt(b.value, b.value < 10 ? 1 : 0)}${o.unit ? ' ' + o.unit : ''}` : '–' }];
    if (b.note) rows.push({ label: b.note, value: '' });
    chart_tipShow(fr, (L + band * (i + 0.5)) / chart_W, b.label, rows);
  };
  let cur = -1;
  for (const h of hits) {
    const r = chart_svg('rect', { class: 'hit', x: chart_r1(h.x), y: T, width: chart_r1(band), height: B - T }, svg);
    r.addEventListener('pointerenter', () => { cur = h.i; show(h.i); });
    r.addEventListener('pointerleave', () => chart_tipHide(fr));
  }
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); cur = clamp(cur + (e.key === 'ArrowRight' ? 1 : -1), 0, bars.length - 1); show(cur); }
    else if (e.key === 'Escape') chart_tipHide(fr);
  });
  svg.addEventListener('blur', () => chart_tipHide(fr));
  if (o.table !== false) chart_table(el, o.label, [o.xTitle || '', o.seriesLabel || o.unit || ''], bars.map((b) => [b.label, Number.isFinite(b.value) ? fmt(b.value, b.value < 10 ? 1 : 0) : '–']));
  return { svg, show };
}

/*
 * Horizontal stacked bars on one common scale (so today and the scenario compare by length). Segments are
 * separated by a 2 px surface gap; a segment's value label is drawn inside only when it fits with 4 px padding
 * either side (estimated at 5.6 px per character of the 10 px tabular font), otherwise the legend, the tooltip
 * and the table carry it.
 */
function chart_stack(el, o) {
  const rows = (o.rows || []).filter((r) => r.segments && r.segments.some((s) => Number.isFinite(s.value) && s.value > 0));
  if (!rows.length) return chart_empty(el, o.label);
  const rowH = 18, gapRow = 26, top = 6;
  const H = top + rows.length * (rowH + gapRow) + 4;
  const fr = chart_frame(el, { label: o.label, height: H, focusable: true });
  const { svg } = fr;
  const L = 2, R = chart_W - 52;   // room for the total at the right end
  const totals = rows.map((r) => r.segments.reduce((a, s) => a + (Number.isFinite(s.value) && s.value > 0 ? s.value : 0), 0));
  const maxT = Math.max(...totals, 1e-9);
  const Xs = (v) => (v / maxT) * (R - L);
  const u = o.unit ? ' ' + o.unit : '';
  const segs = [];
  rows.forEach((row, ri) => {
    const y = top + ri * (rowH + gapRow) + 12;
    chart_svg('text', { class: 'row-label', x: L, y: y - 4 }, svg).textContent = row.label;
    let x = L;
    row.segments.forEach((s) => {
      if (!(Number.isFinite(s.value) && s.value > 0)) return;
      const w = Xs(s.value);
      const wDraw = Math.max(0.5, w - 2);   // 2 px surface gap after each segment
      chart_svg('rect', { class: `seg ${s.cls || 's1'}`, x: chart_r1(x), y, width: chart_r1(wDraw), height: rowH, rx: 2 }, svg);
      const share = totals[ri] > 0 ? s.value / totals[ri] : 0;
      const txt = `${fmt(share * 100)} %`;
      if (txt.length * 5.6 + 8 <= wDraw) chart_svg('text', { class: `seg-label ${s.cls || 's1'}`, x: chart_r1(x + wDraw / 2), y: y + rowH / 2 }, svg).textContent = txt;
      segs.push({ ri, s, x, w: wDraw, y, share });
      x += w;
    });
    chart_svg('text', { class: 'total', x: chart_r1(x + 4), y: y + rowH / 2 }, svg).textContent = fmt(totals[ri], totals[ri] < 10 ? 1 : 0);
  });
  const show = (k) => {
    const q = segs[k];
    chart_tipShow(fr, (q.x + q.w / 2) / chart_W, `${rows[q.ri].label} · ${q.s.label}`,
      [{ cls: q.s.cls || 's1', kind: 'rect', label: `${fmt(q.share * 100)} % ${t('chart.share')}`, value: `${fmt(q.s.value, q.s.value < 10 ? 1 : 0)}${u}` }]);
  };
  let cur = -1;
  segs.forEach((q, k) => {
    const r = chart_svg('rect', { class: 'hit', x: chart_r1(q.x), y: q.y - 4, width: chart_r1(Math.max(q.w + 2, 6)), height: rowH + 8 }, svg);
    r.addEventListener('pointerenter', () => { cur = k; show(k); });
    r.addEventListener('pointerleave', () => chart_tipHide(fr));
  });
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); cur = clamp(cur + (e.key === 'ArrowRight' ? 1 : -1), 0, segs.length - 1); show(cur); }
    else if (e.key === 'Escape') chart_tipHide(fr);
  });
  svg.addEventListener('blur', () => chart_tipHide(fr));
  if (o.legend !== false) {
    const seen = new Map();
    for (const r of rows) for (const s of r.segments) if (!seen.has(s.id || s.label)) seen.set(s.id || s.label, { cls: s.cls, label: s.label, kind: 'rect' });
    el.insertBefore(chart_legend(document.createDocumentFragment(), [...seen.values()]), fr.wrap);
  }
  if (o.table !== false) {
    const ids = [...new Set(rows.flatMap((r) => r.segments.map((s) => s.id || s.label)))];
    const labelOf = (id) => rows.flatMap((r) => r.segments).find((s) => (s.id || s.label) === id).label;
    chart_table(el, o.label, ['', ...ids.map(labelOf), t('chart.total')], rows.map((r, ri) => [r.label,
      ...ids.map((id) => { const s = r.segments.find((q) => (q.id || q.label) === id); return s && Number.isFinite(s.value) ? fmt(s.value, s.value < 10 ? 1 : 0) : '–'; }),
      fmt(totals[ri], totals[ri] < 10 ? 1 : 0)]));
  }
  return { svg, show };
}
