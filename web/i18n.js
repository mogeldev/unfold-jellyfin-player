// Translations: every language is a file locales/<code>.js that registers itself in window.LOCALES.
// New language: create locales/xx.js (keys as in en.js, plus _name) and include it in index.html via <script>.
// Regional variants use the full code, e.g. locales/pt-BR.js registering LOCALES['pt-BR']; a code without its own file falls back to the base language (zh-TW → zh).
// Missing keys fall back to English. Plurals: <key>_one / <key>_other etc. (Intl.PluralRules), call t('key', {n}).
(() => {
  const L = (window.LOCALES ||= {});
  let lang = 'en';
  const pick = code => {
    code = String(code || '').toLowerCase();
    const has = c => Object.keys(L).find(k => k.toLowerCase() === c);
    return has(code) || has(code.split('-')[0]) || 'en';
  };
  const find = (code, key, n) => {
    const d = L[code] || {};
    if (n !== undefined) {
      const rule = new Intl.PluralRules(code).select(n);
      return d[`${key}_${rule}`] ?? d[`${key}_other`] ?? d[key];
    }
    return d[key];
  };
  window.I18N = {
    t(key, vars = {}) {
      const s = find(lang, key, vars.n) ?? find('en', key, vars.n) ?? key;
      return s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
    },
    get lang() { return lang; },
    set(code) { lang = pick(code); document.documentElement.lang = lang; return lang; },
    detect() { return pick(navigator.language); },          // system language, otherwise English
    languages() { return Object.keys(L).map(code => ({ code, name: L[code]._name || code })); },
  };
})();
