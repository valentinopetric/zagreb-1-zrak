// ------------------------------------------------------------------ test runner (dist/test.html?selftest)
/*
 * Runs every registered test in order and publishes the outcome on window.__selftest, which
 * tests/browser/run_selftest.py reads. ?only=<substring> runs a subset; ?skip-slow skips tests
 * registered with { slow: true } (the GPU solver verification T3/T4 on the full grid).
 */
if (SELFTEST) {
  (async () => {
    const only = PARAMS.get('only'), skipSlow = PARAMS.has('skip-slow');
    const results = [];
    const out = document.createElement('pre');
    out.id = 'selftest-out';
    out.style.cssText = 'position:fixed;inset:0;margin:0;padding:16px;overflow:auto;background:#fff;color:#111;font:12px/1.4 monospace;z-index:99';
    document.body.appendChild(out);
    for (const tc of TESTS) {
      if (only && !tc.name.includes(only)) continue;
      if (skipSlow && tc.slow) { results.push({ name: tc.name, status: 'skipped' }); continue; }
      const t0 = performance.now();
      try {
        const info = await tc.fn();
        results.push({ name: tc.name, status: 'passed', ms: Math.round(performance.now() - t0), info: info === undefined ? null : info });
      } catch (e) {
        results.push({ name: tc.name, status: 'failed', ms: Math.round(performance.now() - t0), error: String(e && e.stack || e) });
      }
      const r = results[results.length - 1];
      out.textContent += `${r.status.toUpperCase().padEnd(7)} ${r.name}${r.ms !== undefined ? ` (${r.ms} ms)` : ''}${r.error ? `\n        ${r.error}` : ''}${r.info ? `\n        ${JSON.stringify(r.info)}` : ''}\n`;
    }
    const passed = results.filter((r) => r.status === 'passed').length, failed = results.filter((r) => r.status === 'failed').length;
    out.textContent += `\n${passed} passed, ${failed} failed, ${results.length - passed - failed} skipped\n`;
    window.__selftest = { done: true, passed, failed, results };
  })();
}
