import dns from 'node:dns';
import { isIP, BlockList } from 'node:net';

// Integración con Bandcamp: buscar discos, leer la página de un álbum y su reproductor oficial.
//
// Bandcamp NO tiene API pública de búsqueda. Se usa el buscador interno de su web (el del
// autocompletado), que no está documentado y podría cambiar sin aviso: todo es best-effort y,
// si falla, la app sigue funcionando (queda pegar el enlace). Su robots.txt pide a los programas
// no usar /api/, así que solo se busca cuando tú buscas o, al importar, para los pocos discos que
// Apple Music no tiene; siempre espaciado y con caché.
//
// OJO: Bandcamp es sobre todo autoedición. Con discos clásicos devuelve bootlegs y versiones de
// otros sellos, así que la búsqueda manual enseña los resultados y eliges tú; la importación solo
// asigna uno si título y artista coinciden de verdad.

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

const SEARCH_API = 'https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic';

// URL https válida (los artistas con dominio propio se aceptan para enlazar, no para visitarlos).
function safeHttpsUrl(value) {
  try {
    const u = new URL(String(value ?? ''));
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// Resultado del buscador -> álbum (incompleto: el buscador no da año ni pistas).
function hitToAlbum(r) {
  const art = String(r.img ?? '').match(/\/img\/a?(\d+)_\d+\.jpg/)?.[1];
  const url = safeHttpsUrl(r.item_url_path);
  return {
    id: -Number(r.id),
    provider: 'bandcamp',
    title: String(r.name ?? '').trim(),
    artist: String(r.band_name ?? '').trim() || 'Artista desconocido',
    artistId: null,
    year: null,
    releaseDate: null,
    genre: null,
    trackCount: null,
    artworkUrl: art ? `https://f4.bcbits.com/img/a${art}_5.jpg` : null,
    appleUrl: null,
    externalUrl: url,
    bandcampUrl: url,
    bandcampId: Number(r.id),
    explicit: false,
    copyright: null,
    country: null,
    partial: true,
  };
}

export const looksLikeBandcampLink = (input) => /bandcamp\.com\//i.test(String(input ?? ''));

// Código numérico de una entidad -> carácter (los no válidos se descartan).
const fromCode = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

const decode = (s) =>
  String(s ?? '')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => fromCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => fromCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const meta = (html, attr, name) =>
  decode(html.match(new RegExp(`<meta[^>]+${attr}="${name}"[^>]*content="([^"]*)"`, 'i'))?.[1]
    ?? html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]*${attr}="${name}"`, 'i'))?.[1]);

// Convierte la página en un álbum con el mismo formato que los de Apple.
// Los ID son negativos para no chocar nunca con los ID de catálogo de Apple Music.
export function parseAlbumPage(html, url) {
  let props;
  try {
    props = JSON.parse(meta(html, 'name', 'bc-page-properties') || '{}') || {};
  } catch {
    throw new BandcampError('La página de Bandcamp no tiene el formato esperado.');
  }
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
    bandcampUrl: canonical,
    bandcampId: props.item_type === 't' ? null : itemId,
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

const MAX_BODY = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

// Host al que no se debe ir nunca (red local o del propio servidor). Las IP literales se rechazan
// todas: Bandcamp y los dominios propios de los artistas siempre usan nombres.
function forbiddenHost(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return isIP(h.replace(/^\[|\]$/g, '')) !== 0 || !h.includes('.') || h === 'localhost'
    || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h);
}

// Direcciones a las que nunca se conecta: loopback, redes privadas, enlace local, CGNAT, etc.
const internal = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]]) {
  internal.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fe80::', 10], ['fc00::', 7]]) internal.addSubnet(net, prefix, 'ipv6');

function internalAddress(address) {
  if (isIP(address) === 4) return internal.check(address, 'ipv4');
  const a = new URL(`http://[${address}]/`).hostname.slice(1, -1); // forma canónica (::ffff:7f00:1)
  const mapped = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const n = (parseInt(mapped[1], 16) << 16 >>> 0) + parseInt(mapped[2], 16);
    return internal.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), 'ipv4');
  }
  return internal.check(a, 'ipv6');
}

// Un nombre público puede apuntar a una IP interna (p. ej. 127.0.0.1.nip.io): se resuelve antes de
// cada salto. Queda un riesgo residual de «DNS rebinding» (que el nombre cambie de IP entre esta
// consulta y la conexión de fetch); se acepta, porque fijar la IP exigiría un agente HTTP propio.
async function resolvesInternal(hostname) {
  let addresses;
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch {
    throw new BandcampError('No se pudo conectar con Bandcamp.');
  }
  return !addresses.length || addresses.some((a) => internalAddress(a.address));
}

// fetch que sigue como mucho 3 redirecciones, solo a https y a hosts públicos: Bandcamp redirige a
// veces a los dominios propios de los artistas, pero no debe poder llevarnos a la red interna.
async function safeFetch(url, options) {
  let current = url;
  for (let hop = 0; ; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'https:' || forbiddenHost(u.hostname) || (await resolvesInternal(u.hostname))) {
      throw new BandcampError('Bandcamp ha redirigido a una dirección no permitida.');
    }
    const res = await fetch(u, { ...options, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (!location) throw new BandcampError(`Bandcamp respondió con un error ${res.status}.`);
    if (hop >= MAX_REDIRECTS) throw new BandcampError('Bandcamp ha redirigido demasiadas veces.');
    current = new URL(location, u).href;
    // Como haría el navegador: tras 301/302/303 un POST pasa a GET sin cuerpo.
    if (res.status !== 307 && res.status !== 308 && options.method && options.method !== 'GET') {
      options = { ...options, method: 'GET', body: undefined };
    }
  }
}

// Lee el cuerpo como texto, cortando si supera el tope.
async function readText(res, max = MAX_BODY) {
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel().catch(() => {});
    throw new BandcampError('La respuesta de Bandcamp es demasiado grande.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > max) {
      await res.body.cancel().catch(() => {});
      throw new BandcampError('La respuesta de Bandcamp es demasiado grande.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createBandcamp(db, { delayMs = 1500 } = {}) {
  const cacheGet = db.prepare('SELECT body, fetched_at FROM http_cache WHERE key = ?');
  const cacheSet = db.prepare(
    `INSERT INTO http_cache (key, body, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
  );
  // id -> álbum, para guardar sin volver a pedir la página (con tope: se olvidan los más antiguos).
  const recent = new Map();
  const remember = (album) => {
    recent.delete(album.id);
    recent.set(album.id, album);
    if (recent.size > 3000) recent.delete(recent.keys().next().value);
  };

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
      if (album) remember(album);
      return album;
    }
    await throttle();
    let res;
    try {
      res = await safeFetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
    } catch (err) {
      if (err instanceof BandcampError) throw err;
      throw new BandcampError('No se pudo conectar con Bandcamp.');
    }
    if (res.status === 404 || res.status === 410) {
      cacheSet.run(key, 'null', Date.now());
      return null;
    }
    if (!res.ok) throw new BandcampError(`Bandcamp respondió con un error ${res.status}.`);
    const html = await readText(res);
    if (/Client Challenge/i.test(html.slice(0, 5000))) throw new BandcampError('Bandcamp ha pedido una verificación anti-bots. Inténtalo más tarde.');
    const album = parseAlbumPage(html, url);
    cacheSet.run(key, JSON.stringify(album), Date.now());
    if (album) remember(album);
    return album;
  }

  const recentAlbum = (id) => recent.get(id) ?? null;

  // Busca álbumes en Bandcamp. Lista vacía si no hay nada; error si Bandcamp no responde.
  async function search(query, { limit = 10 } = {}) {
    const text = String(query ?? '').trim().slice(0, 200);
    if (text.length < 2) return [];
    const key = `bandcamp-search:${text.toLowerCase()}`;
    const hit = cacheGet.get(key);
    let results;
    if (hit && Date.now() - hit.fetched_at < 864e5) {
      results = JSON.parse(hit.body);
    } else {
      await throttle();
      let res;
      try {
        res = await safeFetch(SEARCH_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, Accept: 'application/json' },
          // search_filter "a" = solo álbumes (ni artistas, ni pistas, ni merchandising).
          body: JSON.stringify({ search_text: text, search_filter: 'a', full_page: false, fan_id: null }),
          signal: AbortSignal.timeout(15000),
        });
      } catch (err) {
        if (err instanceof BandcampError) throw err;
        throw new BandcampError('No se pudo conectar con Bandcamp.');
      }
      if (!res.ok) throw new BandcampError(`El buscador de Bandcamp respondió con un error ${res.status}.`);
      let data = null;
      try {
        data = JSON.parse(await readText(res));
      } catch (err) {
        if (err instanceof BandcampError) throw err;
      }
      if (!data) throw new BandcampError('El buscador de Bandcamp ha cambiado o no responde como se esperaba.');
      results = (data.auto?.results ?? []).filter((r) => r.type === 'a' && r.id && r.item_url_path);
      cacheSet.run(key, JSON.stringify(results), Date.now());
    }
    const albums = results.slice(0, limit).map(hitToAlbum).filter((a) => a.title && a.externalUrl);
    for (const a of albums) if (!recent.has(a.id)) remember(a);
    return albums;
  }

  // Completa un resultado del buscador con los datos de su página (año, pistas…) si es posible.
  async function complete(album) {
    if (!album?.partial) return album;
    const { partial, score, ...rest } = album;
    if (!parseBandcampUrl(album.externalUrl)) return rest; // dominio propio: no se visita
    try {
      const full = await fetchAlbum(album.externalUrl);
      return full && full.id === album.id ? full : rest;
    } catch {
      return rest;
    }
  }

  return { fetchAlbum, recentAlbum, search, complete };
}
