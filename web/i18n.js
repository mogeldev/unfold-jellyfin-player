// Übersetzungen: jede Sprache ist eine Datei locales/<code>.js, die sich in window.LOCALES einträgt.
// Neue Sprache: locales/xx.js anlegen (Schlüssel wie en.js, dazu _name) und in index.html per <script> einbinden.
// Fehlende Schlüssel fallen auf Englisch zurück. Mehrzahl: <key>_one / <key>_other usw. (Intl.PluralRules), Aufruf t('key', {n}).
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
