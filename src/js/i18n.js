// ------------------------------------------------------------------ i18n
/*
 * One registry of UI strings in Croatian (hr) and English (en). Every file registers its own strings
 * with I18N.add({ hr: {...}, en: {...} }) at load time, so no two files ever edit the same table.
 * t('key', { n: 3 }) returns the string for the current language, with {n}-style placeholders filled;
 * a key missing in the current language falls back to the other one, then to the key itself.
 * Keys are namespaced by file: 'ui.*', 'scene.*', 'model.*', 'data.*', 'chart.*', 'phys.*'.
 */
const I18N = (() => {
  const strings = { hr: {}, en: {} };
  const params = new URLSearchParams(location.search);
  let stored = null;
  try { stored = localStorage.getItem('z1.lang'); } catch (e) { /* storage blocked */ }
  const nav = (navigator.language || 'hr').toLowerCase();
  let lang = params.get('lang') || stored || (nav.startsWith('hr') || nav.startsWith('bs') || nav.startsWith('sr') ? 'hr' : 'en');
  if (lang !== 'hr' && lang !== 'en') lang = 'hr';
  const listeners = [];
  return {
    get lang() { return lang; },
    add(dict) { for (const l of ['hr', 'en']) Object.assign(strings[l], dict[l] || {}); },
    has(key) { return key in strings[lang] || key in strings[lang === 'hr' ? 'en' : 'hr']; },
    t(key, vars) {
      let s = strings[lang][key];
      if (s === undefined) s = strings[lang === 'hr' ? 'en' : 'hr'][key];
      if (s === undefined) return key;
      if (typeof s === 'function') return s(vars || {});
      return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
    },
    set(l) {
      if (l !== 'hr' && l !== 'en' || l === lang) return;
      lang = l;
      try { localStorage.setItem('z1.lang', l); } catch (e) { /* storage blocked */ }
      document.documentElement.lang = l;
      for (const fn of listeners) fn(l);
    },
    onChange(fn) { listeners.push(fn); },
  };
})();
const t = (key, vars) => I18N.t(key, vars);
