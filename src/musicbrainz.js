// Cliente mínimo de MusicBrainz (https://musicbrainz.org/doc/MusicBrainz_API) para encontrar
// enlaces de Bandcamp de un disco. MusicBrainz pide como máximo una petición por segundo y
// que la app se identifique (se usa la URL del proyecto, sin datos personales).
import { parseBandcampUrl } from './bandcamp.js';

const API = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'Discoteca/0.1 ( https://github.com/ForeverRamone/discoteca )';
const CACHE_TTL = 30 * 864e5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMusicBrainz(db) {
  const cacheGet = db.prepare('SELECT body, fetched_at FROM http_cache WHERE key = ?');
  const cacheSet = db.prepare(
    `INSERT INTO http_cache (key, body, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
  );

  let last = 0;
  let queue = Promise.resolve();
  const throttle = () => {
    const next = queue.then(async () => {
      const wait = last + 1100 - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
    });
    queue = next.catch(() => {});
    return next;
  };

  async function get(path) {
    const url = `${API}/${path}${path.includes('?') ? '&' : '?'}fmt=json`;
    const hit = cacheGet.get(url);
    if (hit && Date.now() - hit.fetched_at < CACHE_TTL) return JSON.parse(hit.body);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await throttle();
      let res;
      try {
        res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      } catch {
        if (attempt === 3) return null;
        continue;
      }
      if (res.status === 503 || res.status === 429) {
        await sleep(3000 * attempt);
        continue;
      }
      if (!res.ok) return null;
      const text = await res.text();
      cacheSet.run(url, text, Date.now());
      return JSON.parse(text);
    }
    return null;
  }

  const bandcampOf = (relations) =>
    (relations || []).map((r) => parseBandcampUrl(r.url?.resource)).filter(Boolean);

  // Enlaces de Bandcamp de un release-group (el «disco» de MusicBrainz) y de sus ediciones.
  async function bandcampLinks(mbid) {
    if (!/^[0-9a-f-]{36}$/i.test(String(mbid))) return [];
    const urls = new Set();
    const rg = await get(`release-group/${mbid}?inc=url-rels`);
    for (const u of bandcampOf(rg?.relations)) urls.add(u);
    const rels = await get(`release?release-group=${mbid}&inc=url-rels&limit=50`);
    for (const r of rels?.releases || []) for (const u of bandcampOf(r.relations)) urls.add(u);
    // Primero las páginas de álbum.
    return [...urls].sort((a, b) => Number(b.includes('/album/')) - Number(a.includes('/album/')));
  }

  // Busca el disco por artista y título (para listas de texto o CSV, que no traen ID de MusicBrainz).
  async function findReleaseGroup(artist, title) {
    const esc = (s) => String(s).replace(/(["\\])/g, '\\$1');
    const q = encodeURIComponent(`releasegroup:"${esc(title)}" AND artist:"${esc(artist)}"`);
    const res = await get(`release-group?query=${q}&limit=3`);
    const best = (res?.['release-groups'] || []).find((g) => (g.score ?? 0) >= 90);
    return best?.id ?? null;
  }

  return { bandcampLinks, findReleaseGroup };
}
