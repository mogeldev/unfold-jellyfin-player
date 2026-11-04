// Mock backend for the browser preview without pywebview. Same interface as main.py (Api), answers as {ok, data|error}.
(() => {
  const A = ['Deutsch · EAC3 5.1', 'English · TrueHD 7.1', 'English · AAC 2.0'];
  const S = ['Deutsch · SRT', 'English · SRT', 'English · SDH', 'Aus'];
  const st = h => ({ v: [h ? 'HEVC 2160p · HDR10' : 'H.264 1080p', 'H.264 1080p'], a: A, s: S });
  const OV = 'Short synopsis from the Jellyfin metadata. This is where the description text of the movie or series goes.';
  const mv = (name, year, min, seen) => ({ id: 'm:' + name, type: 'movie', name, year, min, ov: OV, seen: !!seen, st: st(year > 2010) });
  const sr = (name, year, seasons) => ({
    id: 's:' + name, type: 'series', name, year, ov: OV, seen: false,
    seasons: seasons.map(([n, min, seen], a) => ({
      n: a + 1, eps: Array.from({ length: n }, (_, k) => ({ id: `e:${name}:${a}:${k}`, n: k + 1, t: `Folge ${k + 1}`, min, seen: k < seen, st: st(year > 2010) }))
    }))
  });
  const LIBS = [
    { id: 'l0', name: 'Movies', items: [mv('Alien', 1979, 117), mv('Blade Runner', 1982, 117, 1), mv('Casablanca', 1942, 102), mv('Dune', 2021, 155), mv('Heat', 1995, 170), mv('Metropolis', 1927, 153), mv('Parasite', 2019, 132, 1), mv('Stalker', 1979, 162)] },
    { id: 'l1', name: 'Series', items: [sr('Breaking Bad', 2008, [[7, 47, 7], [13, 47, 4]]), sr('Dark', 2017, [[10, 55, 10], [8, 55, 2]]), sr('Severance', 2022, [[9, 50, 9], [10, 50, 0]]), sr('The Wire', 2002, [[13, 58, 0]]), sr('Chernobyl', 2019, [[5, 65, 5]])] },
    { id: 'l2', name: 'Anime', items: [mv('Akira', 1988, 124), sr('Cowboy Bebop', 1998, [[26, 24, 3]]), sr('Monster', 2004, [[12, 24, 0]]), mv('Perfect Blue', 1997, 81), mv('91 Days', 2016, 24), mv('Étude in Blue', 2001, 90), mv('日本', 2010, 100), mv('Spirited Away', 2001, 125, 1)] },
  ];
  LIBS.forEach(l => l.items.sort((a, b) => a.name.localeCompare(b.name)));
  let user = { server: 'http://demo.local:8096', user: 'demo' };
  const impl = {
    state: () => ({ logged_in: true, ...user, mpv_opts: '' }),
    login: () => ({}),
    logout: () => ({}),
    save_settings: () => ({}),
    set_lang: () => ({}),
    libraries: () => LIBS.map(({ id, name }) => ({ id, name })),
    items: id => LIBS.find(l => l.id === id).items.map(({ id, name, year, type, seen }) => ({ id, name, year, type, seen })),
    search: q => LIBS.flatMap(l => l.items).filter(x => x.name.toLowerCase().includes(q.toLowerCase()))
      .map(({ id, name, year, type, seen }) => ({ id, name, year, type, seen })),
    detail: id => LIBS.flatMap(l => l.items).find(x => x.id === id),
    play: (id, v, a, s) => ({ cmd: `mpv --vid=${v + 1} --aid=${a + 1} --sid=${s + 1} <stream-url>` }),
  };
  window.MOCK = Object.fromEntries(Object.entries(impl).map(([k, f]) => [k, async (...a) => ({ ok: true, data: f(...a) })]));
})();
