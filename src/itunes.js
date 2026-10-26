// Cliente de la iTunes Search API (pública, sin clave).
// - Limita el ritmo de peticiones (por defecto 20/min, el límite orientativo de Apple).
// - Cachea las respuestas en SQLite para no repetir llamadas.

const BASE = 'https://itunes.apple.com';
const USER_AGENT = 'Discoteca/0.1 (self-hosted personal app)';
const DAY = 864e5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ItunesError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Extrae el ID de álbum de un enlace de Apple Music / iTunes o de un ID numérico.
// Admite, entre otros:
//   https://music.apple.com/es/album/kind-of-blue/268443092?i=268443097
//   https://music.apple.com/es/album/268443092
//   https://music.apple.com/album1459438950
//   https://itunes.apple.com/es/album/kind-of-blue/id268443092
//   music://music.apple.com/es/album/kind-of-blue/268443092
export function parseAppleAlbumId(input) {
  const s = String(input ?? '').trim();
  if (/^\d{6,}$/.test(s)) return Number(s);
  const m =
    s.match(/\/album\/(?:[^/?#]+\/)?(?:id)?(\d{6,})(?:[/?#]|$)/i) ||
    s.match(/\/album(?:\/id)?(\d{6,})(?:[/?#]|$)/i);
  return m ? Number(m[1]) : null;
}

export function looksLikeAppleLink(input) {
  const s = String(input ?? '').trim();
  return /^\d{6,}$/.test(s) || /(apple\.com|^music:|^itms)/i.test(s);
}

function cleanUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.searchParams.delete('uo');
    return u.toString();
  } catch {
    return url;
  }
}

export function normalizeAlbum(r) {
  return {
    id: r.collectionId,
    title: r.collectionName,
    artist: r.artistName,
    artistId: r.artistId ?? null,
    year: r.releaseDate ? Number(r.releaseDate.slice(0, 4)) : null,
    releaseDate: r.releaseDate ? r.releaseDate.slice(0, 10) : null,
    genre: r.primaryGenreName ?? null,
    trackCount: r.trackCount ?? null,
    artworkUrl: r.artworkUrl100 ?? r.artworkUrl60 ?? null,
    appleUrl: cleanUrl(r.collectionViewUrl),
    explicit: r.collectionExplicitness === 'explicit',
    copyright: r.copyright ?? null,
    country: r.country ?? null,
  };
}

export function createItunes(db, { country, perMinute }) {
  const cacheGet = db.prepare('SELECT body, fetched_at FROM http_cache WHERE key = ?');
  const cacheSet = db.prepare(
    `INSERT INTO http_cache (key, body, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
  );

  // Álbumes vistos recientemente en búsquedas: evita un lookup extra al guardarlos.
  const recent = new Map();
  const remember = (album) => {
    recent.set(album.id, { album, at: Date.now() });
    if (recent.size > 3000) recent.delete(recent.keys().next().value);
    return album;
  };

  // Cubo de fichas: permite ráfagas cortas y mantiene la media por debajo del límite.
  const rate = perMinute / 60000;
  let tokens = perMinute;
  let lastRefill = Date.now();
  let pausedUntil = 0;
  let queue = Promise.resolve();

  function acquire({ interactive }) {
    const next = queue.then(async () => {
      for (;;) {
        const now = Date.now();
        if (now < pausedUntil) {
          if (interactive) {
            throw new ItunesError('Apple está limitando las peticiones. Espera un minuto y vuelve a intentarlo.', 503);
          }
          await sleep(pausedUntil - now);
          continue;
        }
        tokens = Math.min(perMinute, tokens + (now - lastRefill) * rate);
        lastRefill = now;
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        await sleep(Math.ceil((1 - tokens) / rate));
      }
    });
    queue = next.catch(() => {});
    return next;
  }

  async function fetchJson(url, { ttl = DAY, interactive = true } = {}) {
    const hit = cacheGet.get(url);
    if (hit && Date.now() - hit.fetched_at < ttl) return JSON.parse(hit.body);

    const attempts = interactive ? 1 : 4;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await acquire({ interactive });
      } catch (err) {
        if (hit) return JSON.parse(hit.body); // mejor datos viejos que nada
        throw err;
      }
      let res;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        if (attempt < attempts) {
          await sleep(2000 * attempt);
          continue;
        }
        if (hit) return JSON.parse(hit.body);
        throw new ItunesError('No se pudo conectar con Apple (iTunes Search API).');
      }
      if (res.status === 403 || res.status === 429 || res.status === 503) {
        pausedUntil = Date.now() + 60000 * attempt;
        if (attempt < attempts) continue;
        if (hit) return JSON.parse(hit.body);
        throw new ItunesError('Apple está limitando las peticiones. Espera un minuto y vuelve a intentarlo.', 503);
      }
      if (!res.ok) throw new ItunesError(`Apple respondió con un error ${res.status}.`);
      const text = await res.text();
      cacheSet.run(url, text, Date.now());
      return JSON.parse(text);
    }
    throw new ItunesError('No se pudo completar la petición a Apple.');
  }

  const collectionsOf = (data) =>
    (data.results || [])
      .filter((r) => r.wrapperType === 'collection' && r.collectionId)
      .map((r) => remember(normalizeAlbum(r)));

  async function searchAlbums(term, { limit = 50, ...opts } = {}) {
    const params = new URLSearchParams({ term, entity: 'album', country, limit: String(limit) });
    return collectionsOf(await fetchJson(`${BASE}/search?${params}`, opts));
  }

  // Devuelve un Map id -> álbum. Agrupa hasta 100 IDs por petición.
  async function lookupAlbums(ids, opts = {}) {
    const out = new Map();
    const pending = [];
    for (const id of new Set(ids)) {
      const r = recent.get(id);
      if (r && Date.now() - r.at < 3600e3) out.set(id, r.album);
      else pending.push(id);
    }
    for (let i = 0; i < pending.length; i += 100) {
      const chunk = pending.slice(i, i + 100);
      const data = await fetchJson(`${BASE}/lookup?id=${chunk.join(',')}&country=${country}`, opts);
      for (const album of collectionsOf(data)) out.set(album.id, album);
    }
    return out;
  }

  async function lookupAlbum(id, opts) {
    return (await lookupAlbums([id], opts)).get(id) ?? null;
  }

  async function artistAlbums(artistId, opts) {
    const data = await fetchJson(
      `${BASE}/lookup?id=${artistId}&entity=album&country=${country}&limit=200`,
      opts,
    );
    return collectionsOf(data).sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
  }

  async function searchArtists(term, opts) {
    const params = new URLSearchParams({ term, entity: 'musicArtist', country, limit: '5' });
    const data = await fetchJson(`${BASE}/search?${params}`, opts);
    return (data.results || [])
      .filter((r) => r.artistId)
      .map((r) => ({ id: r.artistId, name: r.artistName }));
  }

  // Apple sustituye a veces un álbum por otro con ID nuevo. La web redirige el ID antiguo al nuevo.
  async function resolveMovedId(id) {
    try {
      const res = await fetch(`https://music.apple.com/${country}/album/${id}`, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10000),
      });
      const location = res.headers.get('location');
      const newId = location ? parseAppleAlbumId(location) : null;
      return newId && newId !== id ? newId : null;
    } catch {
      return null;
    }
  }

  // Busca un álbum por ID; si el ID ya no existe en la tienda, prueba con su ID actual.
  async function resolveAlbum(id, opts) {
    const album = await lookupAlbum(id, opts);
    if (album) return album;
    const newId = await resolveMovedId(id);
    return newId ? lookupAlbum(newId, opts) : null;
  }

  return { country, searchAlbums, searchArtists, lookupAlbums, lookupAlbum, artistAlbums, resolveMovedId, resolveAlbum };
}
