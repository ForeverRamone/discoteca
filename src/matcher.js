// Emparejamiento de discos (de Record Club, texto o CSV) con álbumes de Apple Music.
//
// Orden de intentos para cada disco:
//   1. Memoria: emparejamientos anteriores (confirmados por ti o automáticos).
//   2. Enlace de Apple que trae Record Club (validado en la tienda configurada).
//   3. Búsqueda por «artista + título» en la iTunes Search API.
//   4. Discografía completa del artista (la búsqueda por texto de Apple no encuentra todo).
// Si la mejor puntuación no es segura, el disco va a revisión con las mejores opciones.

export const AUTO_SCORE = 0.9;
const MIN_CANDIDATE_SCORE = 0.3;
const MAX_CANDIDATES = 5;

const EDITION_RE =
  /\b(deluxe|remaster(ed)?|remasterizad[oa]|expanded|anniversary|aniversario|anniversaire|jubilaum|edition|edici[oó]n|bonus|version|versi[oó]n|reissue|mono|stereo|legacy|special|collector'?s|super|remix(ed)?|mix|reedici[oó]n|\d{1,3}(st|nd|rd|th))\b/i;
const COMPILATION_RE = /\b(greatest hits|best of|lo mejor de|grandes [eé]xitos|essential|anthology|antolog[ií]a|collection|colecci[oó]n|hits)\b/i;

// Texto comparable: sin acentos, minúsculas, sin puntuación, «&» = «and», sin «The» inicial.
export function normText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\by\b/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

// Título base: quita « - Single», « - EP» y los paréntesis o sufijos de edición
// («(Deluxe Edition)», «[2009 Remaster]», « - Remastered»…). Los paréntesis que forman
// parte del título («(What's the Story) Morning Glory?») se conservan.
const plain = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

export function baseTitle(title) {
  let t = String(title ?? '');
  let edition = false;
  t = t.replace(/\s+-\s+(Single|EP)\s*$/i, '');
  t = t.replace(/\s*[([]([^)\]]*)[)\]]/g, (whole, inner) => {
    if (EDITION_RE.test(plain(inner))) {
      edition = true;
      return '';
    }
    return whole;
  });
  t = t.replace(/\s+[-–—]\s+([^-–—]+)$/, (whole, tail) => {
    if (EDITION_RE.test(plain(tail))) {
      edition = true;
      return '';
    }
    return whole;
  });
  return { title: t.trim(), edition };
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Parecido entre dos textos ya normalizados, de 0 a 1.
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  // Un texto contenido en el otro por palabras completas («Lou Reed» ⊂ «Lou Reed and John Cale»).
  const ta = a.split(' ');
  const tb = b.split(' ');
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const longSet = new Set(long);
  let contain = 0;
  if (short.join('').length >= 3 && short.every((w) => longSet.has(w))) {
    contain = 0.6 + 0.3 * (short.join(' ').length / long.join(' ').length);
  }
  return Math.max(lev, contain);
}

const isSingleOrEp = (title) => /\s-\s(Single|EP)\s*$/i.test(title);

// Puntuación de un álbum de Apple frente al disco buscado.
export function scoreCandidate(source, album) {
  const src = baseTitle(source.title);
  const cand = baseTitle(album.title);
  const titleSim = similarity(normText(src.title), normText(cand.title));
  const artistSim = similarity(normText(source.artist), normText(album.artist));
  let score = 0.6 * titleSim + 0.4 * artistSim;
  if (source.year && album.year && Math.abs(source.year - album.year) <= 1) score += 0.05;
  if (cand.edition && !src.edition) score -= 0.03; // prefiere la edición normal
  if ((source.kind ?? 'album') === 'album' && isSingleOrEp(album.title)) score -= 0.2;
  if (COMPILATION_RE.test(album.title) && !COMPILATION_RE.test(source.title)) score -= 0.1;
  // Sin tope superior: así, ante dos coincidencias perfectas, gana la edición normal.
  return { score: Math.max(0, score), titleSim, artistSim };
}

export const isSafe = (s) => s.score >= AUTO_SCORE && s.titleSim >= 0.85 && s.artistSim >= 0.8;

// Claves con las que se recuerda un emparejamiento.
export function memoryKeys(item) {
  const keys = [];
  if (item.sourceType === 'recordclub' && item.sourceId) keys.push(`rc:${item.sourceId}`);
  if (item.mbid) keys.push(`mb:${item.mbid}`);
  keys.push(`txt:${normText(item.artist)}|${normText(baseTitle(item.title).title)}`);
  return keys;
}

// Busca el mejor álbum de Apple para un disco. No consulta la memoria (eso lo hace el importador).
// hintAlbum: álbum al que apunta el enlace de Record Club, ya validado (o null).
export async function findMatch(item, itunes, { hintAlbum = null, background = true } = {}) {
  const opts = { interactive: !background };
  const pool = new Map();
  const consider = (albums, method) => {
    for (const album of albums) {
      const s = scoreCandidate(item, album);
      const prev = pool.get(album.id);
      if (!prev || prev.score < s.score) pool.set(album.id, { album, method, ...s });
    }
  };
  const best = () => [...pool.values()].sort((a, b) => b.score - a.score || (a.album.releaseDate || '').localeCompare(b.album.releaseDate || ''))[0];
  const result = (method) => {
    const b = best();
    const candidates = [...pool.values()]
      .filter((c) => c.score >= MIN_CANDIDATE_SCORE)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, MAX_CANDIDATES)
      .map((c) => ({ ...c.album, score: Math.round(Math.min(1, c.score) * 100) / 100 }));
    const shown = Math.min(1, b?.score ?? 0);
    if (b && (method === 'link' || isSafe(b))) return { status: 'matched', method: b.method, album: b.album, score: shown, candidates };
    return { status: 'review', method: null, album: null, score: shown, candidates };
  };

  // 2. Enlace de Record Club: se acepta si el título coincide (salvo la edición) y el artista se parece.
  //    Si no (p. ej. enlaza la versión «Instrumental»), se sigue buscando y queda como una opción más.
  if (hintAlbum) {
    consider([hintAlbum], 'link');
    const h = pool.get(hintAlbum.id);
    if (h.titleSim >= 0.9 && h.artistSim >= 0.6) return result('link');
  }

  // 3. Búsqueda por texto.
  const { title } = baseTitle(item.title);
  consider(await itunes.searchAlbums(`${item.artist} ${title}`, { limit: 25, ...opts }), 'search');
  if (best() && isSafe(best())) return result('search');

  // 4. Discografía del artista.
  let artistId = [...pool.values()].find((c) => c.artistSim >= 0.85)?.album.artistId;
  if (!artistId) {
    const artists = await itunes.searchArtists(item.artist, opts);
    artistId = artists.find((a) => similarity(normText(a.name), normText(item.artist)) >= 0.85)?.id;
  }
  if (artistId) consider(await itunes.artistAlbums(artistId, opts), 'artist');
  return result('artist');
}
