// Frontend: 5 columns. Data comes through api (pywebview → main.py, or MOCK in the browser).
(async () => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hue = s => [...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;

  // Backend: pywebview in the app; the browser preview opens index.html#mock (web/mock.js)
  const raw = location.hash === '#mock' ? window.MOCK : await new Promise(res => {
    if (window.pywebview && window.pywebview.api) return res(window.pywebview.api);
    window.addEventListener('pywebviewready', () => res(window.pywebview.api));
  });
  const t = (k, v) => I18N.t(k, v);
  const APP = 'Unfold – Jellyfin Player';
  // Backend errors arrive as a code (+ params) and are translated here
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

  // Text size in %, 50–200 in steps of 10; acts via --sc on font, spacing and column caps (CAP)
  let fsOn = false; // fullscreen switch (library); the window itself cannot be queried
  let scale = 100;
  try { scale = +localStorage.getItem('scale') || scale; } catch (_) {}
  scale = Math.min(200, Math.max(50, Math.round(scale / 10) * 10));
  function setScale(p) {
    scale = Math.min(200, Math.max(50, p));
    document.documentElement.style.setProperty('--sc', scale / 100);
    try { localStorage.setItem('scale', scale); } catch (_) {}
  }
  setScale(scale);

  // ---- Dialog (login, account, settings) ----
  // Window frame (title bar) in the theme colour so the window blends into the UI
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
  // Fields with the same `row` sit side by side
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
  // langs: language choice in the dialog; a click closes it with { __lang }, the caller rebuilds it
  function form(title, fields, { submit = t('ok'), cancel = null, note = '', error = '', themes = false, langs = false, accounts = null, out = '' } = {}) {
    return new Promise(res => {
      const d = document.createElement('div');
      d.className = 'dlg';
      d.innerHTML = `<form><div class="h">${esc(title)}</div>${note ? `<div class="meta block">${esc(note)}</div>` : ''}
        ${fieldsHtml(fields)}
        ${themes ? `<div class="themes">${THEMES.map(n => `<a class="item${n === theme ? ' on' : ''}" data-th="${n}">${n}</a>`).join('')}</div>` : ''}
        ${langs ? `<div class="themes">${I18N.languages().map(l => `<a class="item${l.code === I18N.lang ? ' on' : ''}" data-lang="${l.code}">${esc(l.name)}</a>`).join('')}</div>` : ''}
        ${accounts ? `<div class="accs">${accounts.list.map((n, i) => `<a class="item${i === accounts.on ? ' on' : ''}" data-acc="${i}">${esc(n)}</a>`).join('')}</div>` : ''}
        ${error ? `<div class="err">${esc(error)}</div>` : ''}
        <div class="row"><button class="play" type="submit">${esc(submit)}</button>${out ? `<button class="play alt" type="button" data-out>${esc(out)}</button>` : ''}${cancel ? `<button class="play alt" type="button" data-x>${esc(cancel)}</button>` : ''}</div></form>`;
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
      d.querySelectorAll('[data-acc]').forEach(a => a.addEventListener('click', () => done({ __acc: +a.dataset.acc })));
      d.querySelector('[data-out]')?.addEventListener('click', () => done({ __out: true }));
      d.querySelector('[data-x]')?.addEventListener('click', () => done(null));
    });
  }
  // Switch language and remember it in the backend
  async function setLang(code) {
    I18N.set(code);
    try { await call('set_lang', I18N.lang); } catch (_) {}
  }
  // canCancel (add account): cancelling returns false
  async function login(st = {}, canCancel = false) {
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
        { k: 'password', label: t('password'), type: 'password' }], { submit: t('sign_in'), cancel: canCancel ? t('cancel') : null, error, themes: true, langs: true });
      if (!v) return false;
      p = { proto: v.proto, host: v.host, port: v.port, user: v.user };
      if (v.__lang) { await setLang(v.__lang); error = ''; continue; } // rebuild the dialog in the new language, keeping the input
      const host = v.host.trim().replace(/^https?:\/\//i, '').replace(/[\/:].*$/, '');
      const port = v.port.trim();
      try { await call('login', `${v.proto}://${host}${port ? ':' + port : ''}`, v.user, v.password); return true; } catch (e) { error = e.message; }
    }
  }

  // ---- State ----
  let fcol = 'c1', keynav = false; // focused column for the keyboard
  // Search: runs across all libraries, results appear in column 2 instead of the library list
  let searchOn = false, query = '', searching = false, focusSearch = false, searchToken = 0, searchTimer;
  let letter = null; // active letter filter ('0-9', 'A'…'Z', '…') in the library list
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
  // Episodes come without tracks (long series stay fast): load them for the selected episode
  const ensureTracks = async () => { const c = target(); if (!c.st) c.st = await call('tracks', c.id); };
  const selectItem = guard(async i => { it = await call('detail', items[i].id); pick(); await ensureTracks(); render(); });
  const selectLib = guard(async i => {
    searchOn = false; query = ''; searchToken++; letter = null;
    lib = i; items = await call('items', libs[i].id); it = null;
    render();
  });

  // ---- Search ----
  const listItems = () => searchOn ? (query.trim() ? call('search', query.trim()) : []) : call('items', libs[lib].id);
  const refreshList = () => { const l = app.querySelector('.c2 .lst'); if (l) l.innerHTML = listHtml(); };
  const runSearch = guard(async () => {
    const tok = ++searchToken;
    if (!query.trim()) { items = []; searching = false; refreshList(); return; }
    searching = true;
    try {
      const res = await call('search', query.trim());
      if (tok !== searchToken) return; // typed again in the meantime
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
    else if ((e.key === 'Enter' || e.key === 'ArrowDown') && items.length) { // open the first result, keyboard moves into the list
      e.preventDefault(); clearTimeout(searchTimer); e.target.blur(); fcol = 'c2'; keynav = true; selectItem(0);
    }
  });

  // Like an open book: one image of the UI; the left half stays, the right half
  // turns as a leaf around the middle to the left (front = image, back = paper). Back = animation in reverse.
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
  // frame: last video frame from mpv; at the start it covers the leaf back and the right side so the transition begins seamlessly
  async function pageBack(frame) {
    if (!flip) return;
    const f = flip; flip = null;
    if (frame) try {
      const img = new Image(); img.src = frame; await img.decode();
      const set = (sel, pos) => Object.assign(f.el.querySelector(sel).style,
        { backgroundImage: `url(${frame})`, backgroundSize: '200% 100%', backgroundPosition: pos });
      set('.fr', '100% 0'); set('.back', '0 0');
    } catch { /* broken image: paper colour instead of video, the cover must go away anyway */ }
    f.anims.forEach(a => a.reverse());
    await f.anims[0].finished;
    f.el.remove();
  }

  // After mpv ends: reload the watched state, keep the selection
  window.onPlaybackEnded = guard(async (frame, fs) => {
    fsOn = !!fs; // fullscreen may have been toggled in the video: update the switch
    app.querySelector('[data-fs]')?.classList.toggle('swon', fsOn);
    const back = pageBack(frame);
    if (!it) return back;
    const keep = { si, ei, sel };
    const [d, list] = await Promise.all([call('detail', it.id), listItems(), back]);
    it = d; items = list; ({ si, ei, sel } = keep); await ensureTracks(); render();
  });

  // ---- Render ----
  // List in column 2: library alphabetical with letter dividers, search results in server order (relevance)
  // Initial group of a title: A–Z (accents ignored, Ä → A), digits → '0-9', everything else (e.g. kana) → '…'
  const bucket = name => {
    const c = (name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
    return /[A-Z]/.test(c) ? c : /[0-9]/.test(c) ? '0-9' : '…';
  };
  const AZ = ['0-9', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  // Filter bar 0-9, A–Z: groups without entries are dimmed, “…” appears only when needed
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
      `<div class="foot"><a class="item sw${fsOn ? ' swon' : ''}" data-fs title="F11"><span>${t('fullscreen')}</span><i class="tg"></i></a>
      <div class="item row"><span>${t('theme')}</span><span class="dd"><select class="sel" data-theme-sel>${THEMES.map(n => `<option${n === theme ? ' selected' : ''}>${n}</option>`).join('')}</select></span></div>
      <div class="item row"><span>${t('scale')}</span><span class="stp"><a class="${scale <= 50 ? 'off' : ''}" data-sc="-10">−</a><span>${scale}%</span><a class="${scale >= 200 ? 'off' : ''}" data-sc="10">+</a></span></div>
      <a class="item" data-act="account">${t('account')}</a><a class="item" data-act="settings">${t('settings')}</a></div>`;
    const c2 = (searchOn
      ? `<div class="h sh"><input class="q" size="14" placeholder="${esc(t('search_placeholder'))}" value="${esc(query)}" spellcheck="false" autocomplete="off"></div>`
      : `<div class="h">${esc(libs[lib]?.name)} · ${letter ? shownCount() + '/' : ''}${items.length}</div>`) + `<div class="lst">${listHtml()}</div>`;
    const section = ([n, c]) => `<section class="col c${n}">${c}</section>`;
    const old = [...app.querySelectorAll('.col')].map(c => [c, c.getBoundingClientRect(), c.scrollTop]);
    const before = new Set(old.map(([c]) => colNo(c)));
    // Columns that are added unfold (not on the very first build); columns that go away fold shut
    const commit = parts => {
      app.innerHTML = parts.map(section).join('');
      const fresh = it && it.id !== shownId; // another entry selected: columns 3–5 unfold again
      shownId = it?.id;
      finish(keep, before.size ? parts.map(p => p[0]).filter(n => !before.has(n) || (fresh && n >= 3)) : []);
      foldAway(old.filter(([c]) => !parts.some(p => p[0] === colNo(c))));
    };
    // Columns appear step by step: only 1 at first, 2 after a library click, all after an entry click
    if (!it) { commit(lib < 0 && !searchOn ? [[1, c1]] : [[1, c1], [2, c2]]); return; }
    const cur = target();
    const c3 = `<div class="d"><div class="poster" style="--hue:${hue(it.name)};${it.poster ? `background-image:url('${esc(it.poster)}')` : ''}"></div><h1>${esc(it.name)}</h1>
      <div class="meta">${esc(it.year)} · ${it.type === 'movie' ? esc(it.min) + ' ' + t('min') : t('seasons', { n: it.seasons.length })}${it.seen ? ' · ' + t('watched') : ''}</div><p>${esc(it.ov)}</p></div>`;
    const c4 = it.type !== 'series' ? '' : `<div class="h">${t('episodes')}</div>` + it.seasons.map((s, a) =>
      `<div class="letter">${esc(t('season', { n: s.n }))}</div>` + s.eps.map((e, b) =>
        `<a class="item${a === si && b === ei ? ' on' : ''}${e.seen ? ' seen' : ''}" data-ep="${a}.${b}"><span>${e.seen ? '✓' : '○'} ${esc(e.n)}. ${esc(e.t)}</span><span class="meta">${esc(e.min)} ${t('min')}</span></a>`).join('')).join('');
    const title = it.type === 'movie' ? it.name : `S${it.seasons[si].n}E${cur.n} · ${cur.t}`;
    // 'subs_off': the last subtitle entry is always “Off”, the text comes from the language file
    const list = (k, label) => `<div class="h">${label}</div>` + (cur.st?.[k] || []).map((n, i, arr) =>
      `<a class="item${sel[k] === i ? ' on' : ''}" data-st="${k}.${i}"><span>${esc(k === 's' && i === arr.length - 1 ? t('subs_off') : n)}</span><span class="mark">${sel[k] === i ? '●' : ''}</span></a>`).join('');
    const c5 = `<div class="d"><h1>${esc(title)}</h1><div class="meta">${it.type === 'series' ? esc(it.name) + ' · ' : ''}${esc(cur.min)} ${t('min')}</div></div>` +
      list('v', t('video')) + list('a', t('audio')) + list('s', t('subtitles')) +
      `<div class="foot"><button class="play" data-play>${t('play')}</button><div class="note">${t('play_note')}</div></div>`;
    commit([[1, c1], [2, c2], [3, c3], ...(it.type === 'series' ? [[4, c4]] : []), [5, c5]]);
  }

  // Back: the old columns (always the trailing ones) stay as a copy on top of the window and fold shut from right to left
  let shownId = null;
  function foldAway(gone) {
    if (reduceMotion) return;
    gone.forEach(([c, r, top], k) => {
      Object.assign(c.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      c.style.setProperty('--i', gone.length - 1 - k);
      c.classList.add('folding');
      document.body.append(c); // outside #app so render()/layout() do not count them
      c.scrollTop = top;
      setTimeout(() => c.remove(), 1000);
    });
  }

  function finish(keep, added) {
    layout(added);
    app.querySelectorAll('.col').forEach(c => c.scrollTop = keep[c.classList[1]] || 0);
    if (!app.querySelector('.col.' + fcol)) fcol = 'c1';
    const fc = app.querySelector('.col.' + fcol);
    fc.classList.add('focus');
    if (focusSearch) { // re-activate the search field after the rebuild (cursor at the end)
      const q = app.querySelector('.q');
      if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      focusSearch = false;
    }
    if (keynav) { fc.querySelector('.item.on')?.scrollIntoView({ block: 'nearest' }); keynav = false; }
  }

  // ---- Keyboard: ←→ column, ↑↓ selection, a letter jumps in the list, Enter = play ----
  document.addEventListener('keydown', e => {
    if (e.key === 'F11') { e.preventDefault(); app.querySelector('[data-fs]')?.click(); return; }
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

  // ---- Column widths: automatic to fit the content (fit-content, capped).
  // Dragging sets a fixed width for that column, double-click on the handle = automatic again. ----
  const CAP = { 1: 220, 2: 340, 3: 380, 4: 340, 5: 400 }; // fixed caps in px: the window adapts to the columns, not the other way round
  let M = {};
  try { M = JSON.parse(localStorage.getItem('manualWidths')) || {}; } catch (_) {}
  const saveM = () => { try { localStorage.setItem('manualWidths', JSON.stringify(M)); } catch (_) {} };
  const colNo = c => +c.className.match(/\bc(\d)\b/)[1];
  function template() {
    app.style.gridTemplateColumns = [...app.querySelectorAll('.col')]
      .map(c => { const n = colNo(c); return M[n] ? M[n] + 'px' : `fit-content(${Math.round(CAP[n] * scale / 100)}px)`; }).join(' ') + ' 1fr';
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
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let unfoldToken = 0;
  // Window width = sum of the visible columns (at least MINW); only send when it changes
  const MINW = 420;
  let lastFit = MINW; // the start window is already MINW wide
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
    const fin = cols.map(c => c.offsetWidth); // target widths (forces layout)
    fit(fin.reduce((a, b) => a + b, 0));
    if (!added.length || reduceMotion) { handles(); return; }
    // Page turn: the column has its width at once, its content opens like a book page around the left edge
    cols.filter(c => added.includes(colNo(c))).forEach((c, k) => { c.style.setProperty('--i', k); c.classList.add('unfolding'); });
    handles();
    setTimeout(() => {
      if (token !== unfoldToken) return; // rendered again in the meantime
      cols.forEach(c => { c.classList.remove('unfolding'); c.style.removeProperty('--i'); });
    }, 1000);
  }
  window.refit = () => { lastFit = 0; layout(); }; // after fullscreen: fit the window width to the columns again
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

  // ---- Clicks ----
  app.addEventListener('click', guard(async e => {
    const q = a => e.target.closest(`[data-${a}]`);
    let x;
    const col = e.target.closest('.col');
    if (col) { const c = [...col.classList].find(n => /^c\d$/.test(n)); fcol = c === 'c3' ? 'c2' : c; }
    if ((x = q('az'))) {
      if (x.classList.contains('off')) return;
      letter = letter === x.dataset.az ? null : x.dataset.az; // clicking again clears the filter
      render(); app.querySelector('.c2').scrollTop = 0;
      return;
    } else if ((x = q('fs'))) { // no render(): the switch should flip with a transition
      if (raw.toggle_fullscreen) await call('toggle_fullscreen');
      fsOn = !fsOn; x.classList.toggle('swon', fsOn);
      return;
    }
    else if ((x = q('sc'))) setScale(scale + +x.dataset.sc);
    else if ((x = q('lib'))) return selectLib(+x.dataset.lib);
    else if ((x = q('item'))) return selectItem(+x.dataset.item);
    else if ((x = q('ep'))) { [si, ei] = x.dataset.ep.split('.').map(Number); resetSel(); await ensureTracks(); }
    else if ((x = q('st'))) { const [k, i] = x.dataset.st.split('.'); sel[k] = +i; }
    else if ((x = q('act'))) {
      if (x.dataset.act === 'search') { openSearch(); return; }
      const st = await call('state');
      if (x.dataset.act === 'account') {
        const v = await form(t('account'), [], { submit: t('add_account'), cancel: t('close'), out: t('sign_out'),
          accounts: { list: st.accounts, on: st.active } });
        if (!v) return;
        if (v.__acc !== undefined) { if (v.__acc === st.active) return; await call('switch_account', v.__acc); }
        else if (v.__out) await call('logout');
        else if (!(await login({ server: st.server }, true))) return;
        if (!(await call('state')).logged_in) await login();
        libs = await call('libraries'); lib = -1; items = []; it = null; searchOn = false; query = ''; render();
        return;
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
      const flip = s.can_embed && s.embed; // embedded: the UI turns like a book page, the video appears behind it
      if (flip) await pageOut();
      let r;
      try { r = await call('play', target().id, sel.v, sel.a, sel.s, { bg: cs.backgroundColor, fg: cs.color, back: t('back') }); }
      catch (err) { await pageBack(); throw err; }
      say(r.cmd || t('mpv_started'));
      return;
    } else return;
    render();
  }));

  app.addEventListener('change', e => {
    if (e.target.matches('[data-theme-sel]')) { setTheme(e.target.value); render(); }
  });

  // ---- Start ----
  await guard(async () => {
    const st = await call('state');
    I18N.set(st.lang || I18N.detect()); // saved language, otherwise the system language
    if (!st.logged_in) await login(st);
    libs = await call('libraries');
    render();
  })();
})();
