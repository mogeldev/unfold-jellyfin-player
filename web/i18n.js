// Translations: every language is a file locales/<code>.js that registers itself in window.LOCALES.
// New language: create locales/xx.js (keys as in en.js, plus _name) and include it in index.html via <script>.
// Missing keys fall back to English. Plurals: <key>_one / <key>_other etc. (Intl.PluralRules), call t('key', {n}).
(() => {
  const L = (window.LOCALES ||= {});
  let lang = 'en';
  const pick = code => { code = String(code || '').slice(0, 2).toLowerCase(); return L[code] ? code : 'en'; };
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
    detect() { return pick(navigator.language); },          // Systemsprache, sonst Englisch
    languages() { return Object.keys(L).map(code => ({ code, name: L[code]._name || code })); },
  };
})();
