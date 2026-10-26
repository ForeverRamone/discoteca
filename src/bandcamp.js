// Lector de páginas de álbum de Bandcamp.
//
// Bandcamp no tiene API pública y su robots.txt prohíbe a los programas usar /search y /api/,
// así que esta app NUNCA busca en Bandcamp. Solo visita la página de un álbum cuando ya conoce
// su URL (porque la trae Record Club o MusicBrainz, o porque la pegas tú): una petición por
// álbum, espaciada y guardada en caché, igual que si abrieras la página en el navegador.

const USER_AGENT = 'Mozilla/5.0 (compatible; Discoteca/0.1; +https://github.com/ForeverRamone/discoteca)';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CACHE_TTL = 30 * 864e5;

export class BandcampError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Solo páginas de álbum o de tema en subdominios de bandcamp.com.
export function parseBandcampUrl(input) {
  let u;
  try {
    u = new URL(String(input ?? '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!/^[a-z0-9-]+\.bandcamp\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(album|track)\/([\w%.~-]+)\/?$/i);
  return m ? `https://${u.hostname.toLowerCase()}/${m[1].toLowerCase()}/${m[2]}` : null;
}

export const looksLikeBandcampLink = (input) => /bandcamp\.com\//i.test(String(input ?? ''));

const decode = (s) =>
  String(s ?? '')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const meta = (html, attr, name) =>
  decode(html.match(new RegExp(`<meta[^>]+${attr}="${name}"[^>]*content="([^"]*)"`, 'i'))?.[1]
    ?? html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]*${attr}="${name}"`, 'i'))?.[1]);

// Convierte la página en un álbum con el mismo formato que los de Apple.
// Los ID son negativos para no chocar nunca con los ID de catálogo de Apple Music.
export function parseAlbumPage(html, url) {
  const props = JSON.parse(meta(html, 'name', 'bc-page-properties') || '{}');
  const itemId = Number(props.item_id);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) return null;
  const ogTitle = meta(html, 'property', 'og:title');
  const sep = ogTitle.lastIndexOf(', by ');
  const title = sep > 0 ? ogTitle.slice(0, sep) : ogTitle;
  const artist = sep > 0 ? ogTitle.slice(sep + 5) : '';
  if (!title) return null;
  const description = meta(html, 'property', 'og:description');
  const tracks = Number(description.match(/(\d+)\s+track/i)?.[1]) || (props.item_type === 't' ? 1 : null);
  const text = html.replace(/<[^>]+>/g, ' ');
  const year = Number(text.match(/\breleased\s+(?:[A-Za-z]+\s+)?(?:\d{1,2}(?:,|\s)\s*)?(?:[A-Za-z]+\s+)?(\d{4})\b/i)?.[1]) || null;
  const canonical = parseBandcampUrl(meta(html, 'property', 'og:url')) || url;
  return {
    id: props.item_type === 't' ? -(itemId + 1e12) : -itemId,
    provider: 'bandcamp',
    title: decode(title).trim(),
    artist: decode(artist).trim() || 'Artista desconocido',
    artistId: null,
    year,
    releaseDate: null,
    genre: null,
    trackCount: tracks,
    artworkUrl: meta(html, 'property', 'og:image') || null,
    appleUrl: null,
    externalUrl: canonical,
    explicit: false,
    copyright: null,
    country: null,
  };
}

export function createBandcamp(db, { delayMs = 1500 } = {}) {
  const cacheGet = db.prepare('SELECT body, fetched_at FROM http_cache WHERE key = ?');
  const cacheSet = db.prepare(
    `INSERT INTO http_cache (key, body, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
  );
  const recent = new Map(); // id -> álbum, para guardar sin volver a pedir la página

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

  // Devuelve el álbum o null si la página ya no existe.
  async function fetchAlbum(input, { force = false } = {}) {
    const url = parseBandcampUrl(input);
    if (!url) throw new BandcampError('No reconozco ese enlace de Bandcamp. Debe ser la página de un álbum: https://artista.bandcamp.com/album/…', 400);
    const key = `bandcamp:${url}`;
    const hit = cacheGet.get(key);
    if (hit && !force && Date.now() - hit.fetched_at < CACHE_TTL) {
      const album = JSON.parse(hit.body);
      if (album) recent.set(album.id, album);
      return album;
    }
    await throttle();
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
    } catch {
      throw new BandcampError('No se pudo conectar con Bandcamp.');
    }
    if (res.status === 404 || res.status === 410) {
      cacheSet.run(key, 'null', Date.now());
      return null;
    }
    if (!res.ok) throw new BandcampError(`Bandcamp respondió con un error ${res.status}.`);
    const html = await res.text();
    if (/Client Challenge/i.test(html.slice(0, 5000))) throw new BandcampError('Bandcamp ha pedido una verificación anti-bots. Inténtalo más tarde.');
    const album = parseAlbumPage(html, url);
    cacheSet.run(key, JSON.stringify(album), Date.now());
    if (album) recent.set(album.id, album);
    return album;
  }

  const recentAlbum = (id) => recent.get(id) ?? null;

  return { fetchAlbum, recentAlbum };
}
