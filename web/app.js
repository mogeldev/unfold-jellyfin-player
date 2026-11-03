// Frontend: 5 Spalten. Daten kommen über api (pywebview → main.py, oder MOCK im Browser).
(async () => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hue = s => [...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;

  const raw = await new Promise(res => {
    if (window.pywebview && window.pywebview.api) return res(window.pywebview.api);
    window.addEventListener('pywebviewready', () => res(window.pywebview.api));
    setTimeout(() => { if (!window.pywebview) res(window.MOCK); }, 1200);
  });
  const t = (k, v) => I18N.t(k, v);
  const APP = 'Unfold – Jellyfin Player';
  // Fehler vom Backend kommen als Code (+ Parameter) und werden hier übersetzt
  const call = async (n, ...a) => {
    const r = await raw[n](...a);
    if (!r.ok) throw new Error(r.code ? t('err_' + r.code, r.params) : r.error);
    return r.data;
  };

  const app = document.getElementById('app');
  const toast = document.createElement('div');
  toast.className = 'toast';
  document.body.append(toast);
  const say = (msg, ms = 4000) => {
    toast.textContent = msg; toast.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => toast.classList.remove('show'), ms);
  };
  const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { say(t('error', { msg: e.message }), 7000); } };

  // ---- Theme ----
  const THEMES = ['terminal', 'nord', 'blueprint'];
  let theme = THEMES[0];
  try { theme = localStorage.getItem('theme') || theme; } catch (_) {}
  if (!THEMES.includes(theme)) theme = THEMES[0];
  document.documentElement.dataset.theme = theme;

  // ---- Dialog (Login, Konto, Einstellungen) ----
  // Fensterrahmen (Titelleiste) in der Farbe des Themes, damit das Fenster mit der Oberfläche verschmilzt
  const chrome = () => { if (raw.set_chrome) raw.set_chrome(getComputedStyle(document.body).backgroundColor); };
  function setTheme(n) {
    theme = n; document.documentElement.dataset.theme = n;
    try { localStorage.setItem('theme', n); } catch (_) {}
    chrome();
  }
  chrome();
  const fieldHtml = f => `<label${f.flex ? ` style="flex:${f.flex}"` : ''}>${esc(f.label)}` + (f.type === 'select'
    ? `<select name="${f.k}">${f.options.map(o => `<option${o === f.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
    : `<input name="${f.k}" type="${f.type || 'text'}" value="${esc(f.value || '')}" autocomplete="off">`) + `</label>`;
  // Felder mit gleichem `row` stehen nebeneinander
  const fieldsHtml = fields => {
    let out = '', i = 0;
    while (i < fields.length) {
      const r = fields[i].row;
      if (!r) { out += fieldHtml(fields[i++]); continue; }
      let g = '';
      while (i < fields.length && fields[i].row === r) g += fieldHtml(fields[i++]);
      out += `<div class="inline">${g}</div>`;
    }
    return out;
  };
  // langs: Sprachwahl im Dialog; ein Klick schließt ihn mit { __lang }, der Aufrufer baut ihn neu auf
  function form(title, fields, { submit = t('ok'), cancel = null, note = '', error = '', themes = false, langs = false } = {}) {
    return new Promise(res => {
      const d = document.createElement('div');
      d.className = 'dlg';
      d.innerHTML = `<form><div class="h">${esc(title)}</div>${note ? `<div class="meta block">${esc(note)}</div>` : ''}
        ${fieldsHtml(fields)}
        ${themes ? `<div class="themes">${THEMES.map(n => `<a class="item${n === theme ? ' on' : ''}" data-th="${n}">${n}</a>`).join('')}</div>` : ''}
        ${langs ? `<div class="themes">${I18N.languages().map(l => `<a class="item${l.code === I18N.lang ? ' on' : ''}" data-lang="${l.code}">${esc(l.name)}</a>`).join('')}</div>` : ''}
        ${error ? `<div class="err">${esc(error)}</div>` : ''}
        <div class="row"><button class="play" type="submit">${esc(submit)}</button>${cancel ? `<button class="play alt" type="button" data-x>${esc(cancel)}</button>` : ''}</div></form>`;
      document.body.append(d);
      const f = d.querySelector('form');
      (f.querySelector('input') || f.querySelector('button')).focus();
      d.querySelectorAll('[data-th]').forEach(a => a.addEventListener('click', () => {
        setTheme(a.dataset.th);
        d.querySelectorAll('[data-th]').forEach(b => b.classList.toggle('on', b === a));
      }));
      const done = v => { d.remove(); res(v); };
      d.querySelectorAll('[data-lang]').forEach(a => a.addEventListener('click', () =>
        done({ ...Object.fromEntries(new FormData(f)), __lang: a.dataset.lang })));
      f.addEventListener('submit', e => { e.preventDefault(); done(Object.fromEntries(new FormData(f))); });
      d.querySelector('[data-x]')?.addEventListener('click', () => done(null));
    });
  }
  // Sprache wechseln und im Backend merken
  async function setLang(code) {
    I18N.set(code);
    try { await call('set_lang', I18N.lang); } catch (_) {}
  }
  async function login(st = {}) {
    let error = '';
    let p = { proto: 'http', host: '', port: '8096', user: st.user || '' };
    try {
      const u = new URL(st.server);
      p = { ...p, proto: u.protocol.slice(0, -1), host: u.hostname, port: u.port };
    } catch (_) {}
    for (;;) {
      const v = await form(APP, [
        { k: 'proto', label: t('protocol'), type: 'select', options: ['http', 'https'], value: p.proto, row: 'srv', flex: 1 },
        { k: 'host', label: t('server'), value: p.host, row: 'srv', flex: 3 },
        { k: 'port', label: t('port'), value: p.port, row: 'srv', flex: 1 },
        { k: 'user', label: t('user'), value: p.user },
        { k: 'password', label: t('password'), type: 'password' }], { submit: t('sign_in'), error, themes: true, langs: true });
      p = { proto: v.proto, host: v.host, port: v.port, user: v.user };
      if (v.__lang) { await setLang(v.__lang); error = ''; continue; } // Dialog in neuer Sprache neu aufbauen, Eingaben bleiben
      const host = v.host.trim().replace(/^https?:\/\//i, '').replace(/[\/:].*$/, '');
      const port = v.port.trim();
      try { await call('login', `${v.proto}://${host}${port ? ':' + port : ''}`, v.user, v.password); return; } catch (e) { error = e.message; }
    }
  }

  // ---- State ----
  let fcol = 'c1', keynav = false; // fokussierte Spalte für Tastatur
  // Suche: läuft über alle Bibliotheken, Ergebnisse erscheinen in Spalte 2 anstelle der Bibliotheksliste
  let searchOn = false, query = '', searching = false, focusSearch = false, searchToken = 0, searchTimer;
  let letter = null; // aktiver Buchstabenfilter ('0-9', 'A'…'Z', '…') in der Bibliotheksliste
  let libs = [], lib = -1, items = [], it = null, si = 0, ei = 0, sel = { v: 0, a: 0, s: 0 };
  const target = () => it.type === 'movie' ? it : it.seasons[si].eps[ei];
  const resetSel = () => { sel = { v: 0, a: 0, s: 0 }; };
  function pick() {
    si = 0; ei = 0; resetSel();
    if (it.type !== 'series') return;
    outer: for (let s = 0; s < it.seasons.length; s++)
      for (let e = 0; e < it.seasons[s].eps.length; e++)
        if (!it.seasons[s].eps[e].seen) { si = s; ei = e; break outer; }
  }
  const selectItem = guard(async i => { it = await call('detail', items[i].id); pick(); render(); });
  const selectLib = guard(async i => {
    searchOn = false; query = ''; searchToken++; letter = null;
    lib = i; items = await call('items', libs[i].id); it = null;
    render();
  });

  // ---- Suche ----
  const listItems = () => searchOn ? (query.trim() ? call('search', query.trim()) : []) : call('items', libs[lib].id);
  const refreshList = () => { const l = app.querySelector('.c2 .lst'); if (l) l.innerHTML = listHtml(); };
  const runSearch = guard(async () => {
    const tok = ++searchToken;
    if (!query.trim()) { items = []; searching = false; refreshList(); return; }
    searching = true;
    try {
      const res = await call('search', query.trim());
      if (tok !== searchToken) return; // inzwischen neu getippt
      items = res;
    } finally { if (tok === searchToken) { searching = false; refreshList(); } }
  });
  function openSearch() {
    searchOn = true; query = ''; lib = -1; items = []; it = null; focusSearch = true; fcol = 'c2';
    render();
  }
  function closeSearch() {
    searchOn = false; query = ''; items = []; it = null; searchToken++; fcol = 'c1';
    render();
  }
  app.addEventListener('input', e => {
    if (!e.target.classList.contains('q')) return;
    query = e.target.value;
    clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250);
  });
  app.addEventListener('keydown', e => {
    if (!e.target.classList.contains('q')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    else if ((e.key === 'Enter' || e.key === 'ArrowDown') && items.length) { // erstes Ergebnis öffnen, Tastatur wandert in die Liste
      e.preventDefault(); clearTimeout(searchTimer); e.target.blur(); fcol = 'c2'; keynav = true; selectItem(0);
    }
  });

  // Seitenumschlag der ganzen Oberfläche beim Öffnen/Verlassen von mpv (Drehung um die linke Kante)
  // Wie bei einem aufgeschlagenen Buch: ein Bild der Oberfläche; die linke Hälfte bleibt liegen, die rechte Hälfte
  // klappt als Blatt um die Mitte nach links (Vorderseite = Bild, Rückseite = Papier). Zurück = Animation rückwärts.
  let flip = null;
  async function pageOut() {
    if (reduceMotion || flip) return;
    const snap = raw.snapshot && (await raw.snapshot()).data;
    if (!snap) return;
    const img = new Image(); img.src = snap; await img.decode();
    const paper = getComputedStyle(document.body).backgroundColor;
    const bg = `background-image:url(${snap});background-size:200% 100%`;
    const el = document.createElement('div');
    el.className = 'flip';
    el.innerHTML = `<div class="fl" style="${bg};background-position:0 0"></div>
      <div class="fr"><div class="cast"></div></div>
      <div class="leaf"><div class="front" style="${bg};background-position:100% 0"><div class="shade"></div></div>
      <div class="back" style="background-color:${paper}"><div class="shade"></div></div></div>`;
    document.body.append(el);
    const leaf = el.querySelector('.leaf'), cast = el.querySelector('.cast'), shade = el.querySelector('.front .shade');
    const o = { duration: 1100, easing: 'cubic-bezier(.45,.05,.25,1)', fill: 'forwards' };
    flip = {
      el, anims: [
        leaf.animate([{ transform: 'rotateY(0)' }, { transform: 'rotateY(-180deg)' }], o),
        cast.animate([{ opacity: 0 }, { opacity: 1, offset: .4 }, { opacity: 0 }], o),
        shade.animate([{ opacity: 0 }, { opacity: 1 }], o)]
    };
    await flip.anims[0].finished;
  }
  // frame: letztes Videobild von mpv; es liegt am Anfang auf Blattrückseite und rechter Seite, sodass der Übergang nahtlos beginnt
  async function pageBack(frame) {
    if (!flip) return;
    const f = flip; flip = null;
    if (frame) try {
      const img = new Image(); img.src = frame; await img.decode();
      const set = (sel, pos) => Object.assign(f.el.querySelector(sel).style,
        { backgroundImage: `url(${frame})`, backgroundSize: '200% 100%', backgroundPosition: pos });
      set('.fr', '100% 0'); set('.back', '0 0');
    } catch { /* kaputtes Bild: Papierfarbe statt Video, der Umschlag muss trotzdem weg */ }
    f.anims.forEach(a => a.reverse());
    await f.anims[0].finished;
    f.el.remove();
  }

  // Nach Ende von mpv: Gesehen-Status neu laden, Auswahl behalten
  window.onPlaybackEnded = guard(async frame => {
    const back = pageBack(frame);
    if (!it) return back;
    const keep = { si, ei, sel };
    const [d, list] = await Promise.all([call('detail', it.id), listItems(), back]);
    it = d; items = list; ({ si, ei, sel } = keep); render();
  });

  // ---- Render ----
  // Liste in Spalte 2: Bibliothek alphabetisch mit Buchstaben-Trennern, Suchergebnisse in Serverreihenfolge (Relevanz)
  // Anfangs-Gruppe eines Titels: A–Z (Akzente ignoriert, Ä → A), Ziffern → '0-9', alles andere (z. B. Kana) → '…'
  const bucket = name => {
    const c = (name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
    return /[A-Z]/.test(c) ? c : /[0-9]/.test(c) ? '0-9' : '…';
  };
  const AZ = ['0-9', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  // Filterleiste 0-9, A–Z: Gruppen ohne Einträge sind abgeblendet, „…“ erscheint nur bei Bedarf
  function azHtml() {
    const have = new Set(items.map(x => bucket(x.name)));
    return `<div class="az">${(have.has('…') ? [...AZ, '…'] : AZ).map(k =>
      `<a class="az-k${have.has(k) ? '' : ' off'}${k === letter ? ' on' : ''}" data-az="${k}">${k}</a>`).join('')}</div>`;
  }
  const shownCount = () => letter ? items.filter(x => bucket(x.name) === letter).length : items.length;
  function listHtml() {
    if (searchOn && query.trim() && !items.length && !searching) return `<div class="letter">${esc(t('no_results'))}</div>`;
    let last = '';
    return (searchOn || !items.length ? '' : azHtml()) + items.map((x, i) => {
      const L = bucket(x.name);
      if (letter && L !== letter) return '';
      const hd = !searchOn && !letter && L !== last ? (last = L, `<div class="letter">${esc(L)}</div>`) : '';
      return hd + `<a class="item${it && x.id === it.id ? ' on' : ''}${x.seen ? ' seen' : ''}" data-item="${i}"><span>${esc(x.name)}</span><span class="mark">${x.type === 'series' ? t('series') : esc(x.year)}</span></a>`;
    }).join('');
  }
  function render() {
    const keep = Object.fromEntries([...app.querySelectorAll('.col')].map(c => [c.classList[1], c.scrollTop]));
    const c1 = `<div class="h">${t('libraries')}</div>` +
      libs.map((l, i) => `<a class="item${i === lib ? ' on' : ''}" data-lib="${i}">${esc(l.name)}</a>`).join('') +
      `<a class="item${searchOn ? ' on' : ''}" data-act="search"><span>${t('search')}</span><span class="mark">/</span></a>` +
      `<div class="foot"><div class="h">${t('theme')}</div>${THEMES.map(n => `<a class="item${n === theme ? ' on' : ''}" data-th="${n}">${n}</a>`).join('')}<div class="sp"></div><a class="item" data-act="account">${t('account')}</a><a class="item" data-act="settings">${t('settings')}</a></div>`;
    const c2 = (searchOn
      ? `<div class="h sh"><input class="q" size="14" placeholder="${esc(t('search_placeholder'))}" value="${esc(query)}" spellcheck="false" autocomplete="off"></div>`
      : `<div class="h">${esc(libs[lib]?.name)} · ${letter ? shownCount() + '/' : ''}${items.length}</div>`) + `<div class="lst">${listHtml()}</div>`;
    const section = ([n, c]) => `<section class="col c${n}">${c}</section>`;
    const before = new Set([...app.querySelectorAll('.col')].map(colNo));
    // Spalten, die neu dazukommen, klappen auf (beim allerersten Aufbau nicht)
    const commit = parts => {
      app.innerHTML = parts.map(section).join('');
      finish(keep, before.size ? parts.map(p => p[0]).filter(n => !before.has(n)) : []);
    };
    // Spalten erscheinen schrittweise: erst nur 1, nach Bibliothek-Klick 2, nach Eintrag-Klick alle
    if (!it) { commit(lib < 0 && !searchOn ? [[1, c1]] : [[1, c1], [2, c2]]); return; }
    const cur = target();
    const c3 = `<div class="d"><div class="poster" style="--hue:${hue(it.name)};${it.poster ? `background-image:url('${esc(it.poster)}')` : ''}"></div><h1>${esc(it.name)}</h1>
      <div class="meta">${esc(it.year)} · ${it.type === 'movie' ? esc(it.min) + ' ' + t('min') : t('seasons', { n: it.seasons.length })}${it.seen ? ' · ' + t('watched') : ''}</div><p>${esc(it.ov)}</p></div>`;
    const c4 = it.type !== 'series' ? '' : `<div class="h">${t('episodes')}</div>` + it.seasons.map((s, a) =>
      `<div class="letter">${esc(t('season', { n: s.n }))}</div>` + s.eps.map((e, b) =>
        `<a class="item${a === si && b === ei ? ' on' : ''}${e.seen ? ' seen' : ''}" data-ep="${a}.${b}"><span>${e.seen ? '✓' : '○'} ${esc(e.n)}. ${esc(e.t)}</span><span class="meta">${esc(e.min)} ${t('min')}</span></a>`).join('')).join('');
    const title = it.type === 'movie' ? it.name : `S${it.seasons[si].n}E${cur.n} · ${cur.t}`;
    // 'subs_off': der letzte Untertitel-Eintrag ist immer „Aus“, den Text liefert die Sprachdatei
    const list = (k, label) => `<div class="h">${label}</div>` + cur.st[k].map((n, i, arr) =>
      `<a class="item${sel[k] === i ? ' on' : ''}" data-st="${k}.${i}"><span>${esc(k === 's' && i === arr.length - 1 ? t('subs_off') : n)}</span><span class="mark">${sel[k] === i ? '●' : ''}</span></a>`).join('');
    const c5 = `<div class="d"><h1>${esc(title)}</h1><div class="meta">${it.type === 'series' ? esc(it.name) + ' · ' : ''}${esc(cur.min)} ${t('min')}</div></div>` +
      list('v', t('video')) + list('a', t('audio')) + list('s', t('subtitles')) +
      `<div class="foot"><button class="play" data-play>${t('play')}</button><div class="note">${t('play_note')}</div></div>`;
    commit([[1, c1], [2, c2], [3, c3], ...(it.type === 'series' ? [[4, c4]] : []), [5, c5]]);
  }

  function finish(keep, added) {
    layout(added);
    app.querySelectorAll('.col').forEach(c => c.scrollTop = keep[c.classList[1]] || 0);
    if (!app.querySelector('.col.' + fcol)) fcol = 'c1';
    const fc = app.querySelector('.col.' + fcol);
    fc.classList.add('focus');
    if (focusSearch) { // Suchfeld nach dem Neuaufbau wieder aktivieren (Cursor ans Ende)
      const q = app.querySelector('.q');
      if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      focusSearch = false;
    }
    if (keynav) { fc.querySelector('.item.on')?.scrollIntoView({ block: 'nearest' }); keynav = false; }
  }

  // ---- Tastatur: ←→ Spalte, ↑↓ Auswahl, Buchstabe springt in der Liste, Enter = Abspielen ----
  document.addEventListener('keydown', e => {
    if (document.querySelector('.dlg') || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.ctrlKey || e.altKey || e.metaKey) return;
    const cols = ['c1', 'c2', 'c4', 'c5'].filter(c => app.querySelector('.col.' + c));
    const attr = { c1: 'lib', c2: 'item', c4: 'ep' }[fcol];
    const k = e.key;
    if (k === '/') { e.preventDefault(); openSearch(); return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      fcol = cols[Math.max(0, Math.min(cols.length - 1, cols.indexOf(fcol) + (k === 'ArrowRight' ? 1 : -1)))];
      render(); return;
    }
    if (k === 'Enter') { e.preventDefault(); app.querySelector('[data-play]')?.click(); return; }
    if (!attr) return;
    const els = [...app.querySelectorAll(`.col.${fcol} [data-${attr}]`)];
    let i = els.findIndex(x => x.classList.contains('on'));
    if (k === 'ArrowDown') i = Math.min(els.length - 1, i + 1);
    else if (k === 'ArrowUp') i = Math.max(0, i - 1);
    else if (fcol === 'c2' && k.length === 1 && /\p{L}/u.test(k)) {
      i = items.findIndex(x => x.name.toUpperCase().startsWith(k.toUpperCase()));
      if (i < 0) return;
    } else return;
    e.preventDefault(); keynav = true; els[i]?.click();
  });

  // ---- Spaltenbreiten: automatisch passend zum Inhalt (fit-content, gedeckelt in % der Fensterbreite).
  // Per Ziehen setzt man eine feste Breite für diese Spalte, Doppelklick auf den Griff = wieder automatisch. ----
  const CAP = { 1: 220, 2: 340, 3: 380, 4: 340, 5: 400 }; // feste Obergrenzen in px: das Fenster passt sich den Spalten an, nicht umgekehrt
  let M = {};
  try { M = JSON.parse(localStorage.getItem('manualWidths')) || {}; } catch (_) {}
  const saveM = () => { try { localStorage.setItem('manualWidths', JSON.stringify(M)); } catch (_) {} };
  const colNo = c => +c.className.match(/\bc(\d)\b/)[1];
  function template() {
    app.style.gridTemplateColumns = [...app.querySelectorAll('.col')]
      .map(c => { const n = colNo(c); return M[n] ? M[n] + 'px' : `fit-content(${CAP[n]}px)`; }).join(' ') + ' 1fr';
  }
  function place() {
    app.querySelectorAll('.rz').forEach(h => {
      const c = app.querySelector('.c' + h.dataset.rz);
      h.style.left = (c.offsetLeft + c.offsetWidth - 3) + 'px';
    });
  }
  const handles = () => {
    app.querySelectorAll('.rz').forEach(h => h.remove());
    app.insertAdjacentHTML('beforeend', [...app.querySelectorAll('.col')].map(c => `<div class="rz" data-rz="${colNo(c)}"></div>`).join(''));
    place();
  };
  // Neue Spalten (added) klappen auf: ihre Breite wächst von 0 auf das Zielmaß, der Inhalt gleitet ein.
  // Dazu kurz feste px-Breiten animieren, danach zurück auf die automatische Breite (fit-content).
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let unfoldToken = 0;
  // Fensterbreite = Summe der sichtbaren Spalten (mindestens MINW); nur senden, wenn sie sich ändert
  const MINW = 420;
  let lastFit = MINW; // Startfenster ist bereits MINW breit
  const fit = sum => {
    const want = Math.max(Math.round(sum), MINW);
    if (!raw.fit_window || want === lastFit) return;
    lastFit = want;
    raw.fit_window(Math.round(want * devicePixelRatio));
  };
  function layout(added = []) {
    const token = ++unfoldToken;
    app.style.transition = '';
    app.querySelectorAll('.rz').forEach(h => h.remove());
    template();
    const cols = [...app.querySelectorAll('.col')];
    const fin = cols.map(c => c.offsetWidth); // Zielbreiten (erzwingt Layout)
    fit(fin.reduce((a, b) => a + b, 0));
    if (!added.length || reduceMotion) { handles(); return; }
    // Seitenumschlag: Spalte hat sofort ihre Breite, ihr Inhalt klappt wie eine Buchseite um die linke Kante auf
    cols.filter(c => added.includes(colNo(c))).forEach((c, k) => { c.style.setProperty('--i', k); c.classList.add('unfolding'); });
    handles();
    setTimeout(() => {
      if (token !== unfoldToken) return; // inzwischen neu gerendert
      cols.forEach(c => { c.classList.remove('unfolding'); c.style.removeProperty('--i'); });
    }, 1000);
  }
  app.addEventListener('pointerdown', e => {
    const h = e.target.closest('[data-rz]');
    if (!h) return;
    const n = +h.dataset.rz, x0 = e.clientX, w0 = app.querySelector('.c' + n).offsetWidth;
    h.setPointerCapture(e.pointerId);
    h.classList.add('drag'); document.body.classList.add('dragging');
    const move = m => { M[n] = Math.max(90, Math.min(900, w0 + m.clientX - x0)); template(); place(); };
    const up = () => {
      h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up);
      h.classList.remove('drag'); document.body.classList.remove('dragging'); saveM();
    };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
  });
  app.addEventListener('dblclick', e => {
    const h = e.target.closest('[data-rz]');
    if (h) { delete M[+h.dataset.rz]; template(); place(); saveM(); }
  });

  // ---- Klicks ----
  app.addEventListener('click', guard(async e => {
    const q = a => e.target.closest(`[data-${a}]`);
    let x;
    const col = e.target.closest('.col');
    if (col) { const c = [...col.classList].find(n => /^c\d$/.test(n)); fcol = c === 'c3' ? 'c2' : c; }
    if ((x = q('az'))) {
      if (x.classList.contains('off')) return;
      letter = letter === x.dataset.az ? null : x.dataset.az; // erneuter Klick hebt den Filter auf
      render(); app.querySelector('.c2').scrollTop = 0;
      return;
    } else if ((x = q('th'))) setTheme(x.dataset.th);
    else if ((x = q('lib'))) return selectLib(+x.dataset.lib);
    else if ((x = q('item'))) return selectItem(+x.dataset.item);
    else if ((x = q('ep'))) { [si, ei] = x.dataset.ep.split('.').map(Number); resetSel(); }
    else if ((x = q('st'))) { const [k, i] = x.dataset.st.split('.'); sel[k] = +i; }
    else if ((x = q('act'))) {
      if (x.dataset.act === 'search') { openSearch(); return; }
      const st = await call('state');
      if (x.dataset.act === 'account') {
        const v = await form(t('account'), [], { submit: t('sign_out'), cancel: t('close'), note: `${st.user} @ ${st.server}` });
        if (v) { await call('logout'); await login(); libs = await call('libraries'); lib = -1; items = []; it = null; searchOn = false; query = ''; render(); return; }
      } else {
        const EMB = t('play_embedded'), EXT = t('play_external');
        const langs = I18N.languages();
        const v = await form(t('settings'), [
          { k: 'lang', label: t('language'), type: 'select', options: langs.map(l => l.name), value: langs.find(l => l.code === I18N.lang)?.name },
          ...(st.can_embed ? [{ k: 'embed', label: t('playback'), type: 'select', options: [EMB, EXT], value: st.embed ? EMB : EXT }] : []),
          { k: 'mpv_opts', label: t('mpv_opts'), value: st.mpv_opts }], { submit: t('save'), cancel: t('cancel') });
        if (v) {
          await call('save_settings', { mpv_opts: v.mpv_opts.trim(), embed: v.embed !== EXT });
          const code = langs.find(l => l.name === v.lang)?.code;
          if (code && code !== I18N.lang) { await setLang(code); render(); }
          say(t('saved'));
        }
      }
      return;
    } else if (q('play')) {
      const cs = getComputedStyle(document.body);
      const s = await call('state');
      const flip = s.can_embed && s.embed; // eingebettet: Oberfläche schlägt wie eine Buchseite um, dahinter erscheint das Video
      if (flip) await pageOut();
      let r;
      try { r = await call('play', target().id, sel.v, sel.a, sel.s, { bg: cs.backgroundColor, fg: cs.color, back: t('back') }); }
      catch (err) { await pageBack(); throw err; }
      say(r.cmd || t('mpv_started'));
      return;
    } else return;
    render();
  }));

  // ---- Start ----
  await guard(async () => {
    const st = await call('state');
    I18N.set(st.lang || I18N.detect()); // gespeicherte Sprache, sonst Systemsprache
    if (!st.logged_in) await login(st);
    libs = await call('libraries');
    render();
  })();
})();
