// Cliente de la API JSON que usa la web de Record Club (api.record.club).
// No está documentada públicamente: si cambia, la importación por URL fallará y
// quedará la alternativa de pegar texto o subir un CSV/Excel.
//
// Uso respetuoso: una petición cada RC_DELAY_MS (por defecto 700 ms) y caché de los
// detalles de cada disco durante 30 días.

import { parseAppleAlbumId } from './itunes.js';
import { parseBandcampUrl } from './bandcamp.js';

const API = 'https://api.record.club';
const USER_AGENT = 'Discoteca/0.1 (self-hosted personal app; imports the owner\'s lists)';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RecordClubError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// https://record.club/usuario/lists/nombre-de-la-lista
export function parseListUrl(input) {
  const m = String(input ?? '').trim().match(/record\.club\/([^/?#\s]+)\/lists\/([^/?#\s]+)/i);
  return m ? { username: decodeURIComponent(m[1]), slug: decodeURIComponent(m[2]) } : null;
}

export function listUrl(username, slug) {
  return `https://record.club/${username}/lists/${slug}`;
}

export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function artistName(release) {
  const artists = [...(release.artists || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const name = artists.map((a) => `${a.name ?? a.artist?.name ?? ''}${a.join ?? ''}`).join('').trim();
  return name || 'Artista desconocido';
}

// /releases/albums/slug -> 'album' | 'single' | 'ep'
function releaseKind(uri) {
  const m = String(uri || '').match(/^\/releases\/([^/]+)\//);
  const kind = m?.[1];
  if (kind === 'singles') return 'single';
  if (kind === 'eps') return 'ep';
  return 'album';
}

export function createRecordClub(db, { delayMs = 700 } = {}) {
  const cacheGet = db.prepare('SELECT body, fetched_at FROM http_cache WHERE key = ?');
  const cacheSet = db.prepare(
    `INSERT INTO http_cache (key, body, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
  );

  let last = 0;
  let queue = Promise.resolve();
  const throttle = () => {
    const next = queue.then(async () => {
      const wait = last + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
    });
    queue = next.catch(() => {});
    return next;
  };

  async function get(path, { ttl = 0 } = {}) {
    const url = `${API}${path}`;
    if (ttl) {
      const hit = cacheGet.get(url);
      if (hit && Date.now() - hit.fetched_at < ttl) return JSON.parse(hit.body);
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      await throttle();
      let res;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(20000),
        });
      } catch {
        if (attempt < 3) {
          await sleep(3000 * attempt);
          continue;
        }
        throw new RecordClubError('No se pudo conectar con Record Club.');
      }
      if (res.status === 404) throw new RecordClubError('Record Club no encuentra esa lista. ¿Es pública y la URL es correcta?', 404);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) || 30 * attempt;
        if (attempt < 3) {
          await sleep(retryAfter * 1000);
          continue;
        }
      }
      const text = await res.text();
      if (!res.ok || !text.trim().startsWith('{')) {
        throw new RecordClubError(
          res.status === 403
            ? 'Record Club ha bloqueado la petición (protección anti-bots). Usa la importación por texto o CSV.'
            : `Record Club respondió con un error ${res.status}.`,
        );
      }
      if (ttl) cacheSet.run(url, text, Date.now());
      return JSON.parse(text);
    }
    throw new RecordClubError('Record Club no responde. Inténtalo más tarde.');
  }

  // Metadatos y discos de una lista, en su orden original, recorriendo todas las páginas.
  async function fetchList(username, slug, { onPage } = {}) {
    const meta = (await get(`/users/${encodeURIComponent(username)}/lists/${encodeURIComponent(slug)}`)).data;
    const items = [];
    for (let page = 1; page <= 100; page++) {
      const res = await get(`/lists/${meta.id}/items?page=${page}`);
      for (const it of res.data || []) {
        const r = it.release;
        if (!r) continue;
        items.push({
          position: it.position,
          sourceId: r.id,
          sourceUri: r.uri,
          sourceUrl: `https://record.club${r.uri}`,
          mbid: r.mbUrl?.match(/release-group\/([0-9a-f-]{36})/)?.[1] ?? null,
          artist: artistName(r),
          title: r.title || r.originalTitle || 'Sin título',
          year: r.releaseDate?.year ?? null,
          kind: releaseKind(r.uri),
        });
      }
      const pg = res.meta?.pagination;
      onPage?.(page, pg?.totalPages ?? page);
      if (!pg?.hasNextPage) break;
    }
    items.sort((a, b) => a.position - b.position);
    return {
      id: meta.id,
      title: meta.title,
      description: htmlToText(meta.description),
      itemCount: meta.itemCount,
      updatedAt: meta.updatedAt,
      url: listUrl(username, slug),
      items,
    };
  }

  // Enlaces que Record Club guarda para un disco: ID de Apple Music (puede estar desfasado)
  // y página de Bandcamp, si la hay.
  async function releaseLinks(sourceUri) {
    if (!/^\/releases\/[a-z]+\/[\w%.~-]+$/i.test(String(sourceUri))) return { appleId: null, bandcampUrl: null };
    const data = (await get(sourceUri, { ttl: 30 * 864e5 })).data;
    const link = (service) => (data?.streamingLinks || []).find((s) => s.service === service)?.url;
    const apple = link('apple');
    return { appleId: apple ? parseAppleAlbumId(apple) : null, bandcampUrl: parseBandcampUrl(link('bandcamp')) };
  }
  const appleHint = async (sourceUri) => (await releaseLinks(sourceUri)).appleId;

  // Listas públicas de un usuario, recorriendo todas las páginas.
  async function fetchUserLists(username) {
    const out = [];
    for (let page = 1; page <= 50; page++) {
      const res = await get(`/users/${encodeURIComponent(username)}/lists?page=${page}`);
      for (const l of res.data || []) {
        if (l.visibility && l.visibility !== 'public') continue;
        out.push({
          id: l.id,
          title: l.title,
          slug: l.slug,
          url: `https://record.club${l.uri}`,
          itemCount: l.itemCount,
          updatedAt: l.updatedAt,
        });
      }
      if (!res.meta?.pagination?.hasNextPage) break;
    }
    return out;
  }

  return { fetchList, fetchUserLists, appleHint, releaseLinks };
}
