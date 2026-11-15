// Backend in JS for Android (WebView). Same interface as src/main.rs (App::call), answers as {ok, data|error}.
// Jellyfin calls go through fetch (the server must allow CORS, which is Jellyfin's default). Playback is done by the
// mpvkt-rolling player built into the app, started through window.Android (android/app/src/main/java/…/MainActivity.java).
// Browser preview against a real server: index.html#web (Play then only shows the stream URL).
(() => {
  if (!window.Android && location.hash !== '#web') return;
  const VERSION = '0.4';
  const MS = 1e4; // Jellyfin ticks per millisecond
  class AppError extends Error { constructor(code, params = {}) { super(code); this.code = code; this.params = params; } }

  // Accounts as in src/config.rs; the token lives in the WebView's app-private storage (no Credential Manager here)
  let cfg = { accounts: [], active: 0 };
  try { cfg = { ...cfg, ...JSON.parse(localStorage.getItem('cfg')) }; } catch (_) {}
  const save = () => localStorage.setItem('cfg', JSON.stringify(cfg));
  const acc = () => cfg.accounts[cfg.active];
  const need = () => { const a = acc(); if (!a) throw new AppError('not_logged_in'); return a; };

  async function req(a, method, path, params, body) {
    let r;
    try {
      r = await fetch(a.server + path + (params ? '?' + new URLSearchParams(params) : ''), {
        method, body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `MediaBrowser Client="Unfold", Device="Android", DeviceId="${a.device_id}", Version="${VERSION}"` + (a.token ? `, Token="${a.token}"` : ''),
          'Content-Type': 'application/json', Accept: 'application/json' } });
    } catch (e) { throw new AppError('unreachable', { reason: e.message }); }
    if (r.status === 401) throw new AppError('auth');
    if (!r.ok) throw new AppError('server_error', { code: r.status });
    const raw = await r.text();
    return raw ? JSON.parse(raw) : null;
  }
  const get = (path, params) => req(need(), 'GET', path, params);
  const detail = id => get(`/Users/${need().user_id}/Items/${id}`);

  // Jellyfin descriptions often contain HTML (<br>, <i> …): plain text with line breaks
  const text = s => new DOMParser().parseFromString((s || '').replace(/<br\s*\/?>/gi, '\n'), 'text/html').body.textContent.trim();
  const minutes = d => Math.round((d.RunTimeTicks || 0) / MS / 60000);
  const seen = d => !!d.UserData?.Played;
  const summary = i => ({ id: i.Id, name: i.Name, year: i.ProductionYear ?? '', type: i.Type === 'Series' ? 'series' : 'movie', seen: seen(i) });
  const list = async params => (await get('/Items', { userId: need().user_id, Recursive: 'true', IncludeItemTypes: 'Movie,Series', Fields: 'ProductionYear', ...params })).Items.map(summary);
  const SUB = { srt: 'srt', subrip: 'srt', ass: 'ass', ssa: 'ass', vtt: 'vtt', webvtt: 'vtt' }; // external text subtitles: codec → format of the stream URL
  const subFmt = s => SUB[(s.Codec || '').toLowerCase()];
  // Like streams() in src/jellyfin.rs: track names per type (embedded subtitles first, then the external text ones that mpv
  // loads afterwards, 'Off' last), the external subtitle streams and the MediaSourceId
  function streams(d) {
    const src = (d.MediaSources || [{}])[0], all = src.MediaStreams || d.MediaStreams || [];
    const name = s => s.DisplayTitle || s.Title || s.Language || '?';
    const of = (type, f = () => true) => all.filter(s => s.Type === type && f(s));
    const ext = of('Subtitle', s => s.IsExternal && subFmt(s));
    return { ext, msId: src.Id || d.Id, st: { v: of('Video').map(name), a: of('Audio').map(name),
      s: [...of('Subtitle', s => !s.IsExternal), ...ext].map(name).concat('Off') } };
  }

  const api = {
    state: () => ({ logged_in: !!acc(), server: acc()?.server || '', user: acc()?.user || '', can_embed: false,
      lang: cfg.lang || '', active: cfg.active, accounts: cfg.accounts.map(a => `${a.user} @ ${a.server}`) }),
    set_lang(lang) { cfg.lang = String(lang).slice(0, 16); save(); },
    save_settings() {}, // player options live in the player's own settings (player_settings)
    player_settings() { window.Android?.playerSettings(); },
    // Sign in a new account and activate it; the same account (server + user, case-insensitive) is only updated
    async login(server, user, password) {
      server = server.trim().replace(/\/+$/, '');
      let i = cfg.accounts.findIndex(a => a.server === server && a.user.toLowerCase() === user.toLowerCase());
      if (i < 0) i = cfg.accounts.length;
      const a = { server, user, device_id: cfg.accounts[i]?.device_id ||
        [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('') };
      const r = await req(a, 'POST', '/Users/AuthenticateByName', null, { Username: user, Pw: password });
      cfg.accounts[i] = { ...a, token: r.AccessToken, user_id: r.User.Id };
      cfg.active = i; save();
    },
    switch_account(i) { cfg.active = +i; save(); },
    async logout() {
      const a = acc();
      if (a) { await req(a, 'POST', '/Sessions/Logout').catch(() => {}); cfg.accounts.splice(cfg.active, 1); }
      cfg.active = 0; save();
    },
    libraries: async () => (await get('/UserViews', { userId: need().user_id })).Items
      .filter(v => !v.CollectionType || ['movies', 'tvshows', 'homevideos'].includes(v.CollectionType))
      .map(v => ({ id: v.Id, name: v.Name })),
    items: id => list({ ParentId: id, SortBy: 'SortName', SortOrder: 'Ascending' }),
    search: term => (term = (term || '').trim()) ? list({ searchTerm: term, Limit: 100 }) : [],
    async detail(id) {
      const a = need(), d = await detail(id), tag = d.ImageTags?.Primary;
      const base = { id: d.Id, name: d.Name, year: d.ProductionYear ?? '', ov: text(d.Overview), seen: seen(d), min: minutes(d),
        poster: tag ? `${a.server}/Items/${d.Id}/Images/Primary?maxHeight=500&tag=${tag}&api_key=${a.token}` : null };
      if (d.Type !== 'Series') return { ...base, type: 'movie', st: streams(d).st };
      const eps = (await get(`/Shows/${id}/Episodes`, { userId: a.user_id, IsMissing: 'false', IsVirtualUnAired: 'false' })).Items;
      const seasons = new Map();
      for (const e of eps) {
        const n = e.ParentIndexNumber || 0;
        if (!seasons.has(n)) seasons.set(n, []);
        seasons.get(n).push({ id: e.Id, n: e.IndexNumber || 0, t: e.Name, min: minutes(e), seen: seen(e) });
      }
      return { ...base, type: 'series', seasons: [...seasons].sort((x, y) => x[0] - y[0]).map(([n, eps]) => ({ n, eps: eps.sort((x, y) => x.n - y.n) })) };
    },
    tracks: async id => streams(await detail(id)).st,
    async play(id, v, a, sub) {
      const acct = need(), d = await detail(id), { st, ext, msId } = streams(d);
      const psid = (await req(acct, 'POST', `/Items/${id}/PlaybackInfo`, { UserId: acct.user_id }, { UserId: acct.user_id })).PlaySessionId;
      const url = `${acct.server}/Videos/${id}/stream?` + new URLSearchParams({ static: 'true', MediaSourceId: msId, PlaySessionId: psid, DeviceId: acct.device_id, api_key: acct.token });
      const resume = Math.round((d.UserData?.PlaybackPositionTicks || 0) / MS), runtime = d.RunTimeTicks;
      const title = d.Type === 'Episode' ? `${d.SeriesName || ''} S${d.ParentIndexNumber || 0}E${d.IndexNumber || 0} ${d.Name}` : d.Name;
      // mpv counts per track type from 1, in the same order as Jellyfin
      const p = { url, title, id, position: resume,
        ...(st.v.length ? { vid: String(v + 1) } : {}), ...(st.a.length ? { aid: String(a + 1) } : {}),
        ...(st.s.length > 1 ? { sid: sub === st.s.length - 1 ? 'no' : String(sub + 1) } : {}),
        subs: ext.map(s => `${acct.server}/Videos/${id}/${msId}/Subtitles/${s.Index}/Stream.${subFmt(s)}?api_key=${acct.token}`) };
      if (!window.Android) return { cmd: JSON.stringify({ ...p, url: undefined, subs: p.subs.length }) }; // browser preview
      // kind: '' (start), '/Progress' or '/Stopped'; reporting must never disturb playback
      const report = (kind, ms) => req(acct, 'POST', '/Sessions/Playing' + kind, null, {
        ItemId: id, MediaSourceId: msId, PlaySessionId: psid, PositionTicks: Math.round(ms * MS),
        PlayMethod: 'DirectStream', CanSeek: true, IsPaused: false, ...(runtime ? { RunTimeTicks: runtime } : {}) }).catch(() => {});
      const timer = setInterval(() => { const ms = window.Android.position(); if (ms >= 0) report('/Progress', ms); }, 10000);
      // Called by MainActivity when the player closes, with the last position in ms (-1: did not start).
      // "Watched" is decided by the server from the position.
      window.onPlayerResult = async pos => {
        clearInterval(timer);
        await report('/Stopped', pos < 0 ? resume : pos);
        window.onPlaybackEnded?.(null, false);
      };
      window.Android.play(JSON.stringify(p));
      report('', resume);
      return {};
    },
  };
  window.WEBAPI = Object.fromEntries(Object.entries(api).map(([k, f]) => [k, async (...a) => {
    try { return { ok: true, data: await f(...a) }; }
    catch (e) { return e.code ? { ok: false, code: e.code, params: e.params } : { ok: false, error: `${e.name}: ${e.message}` }; }
  }]));
})();
