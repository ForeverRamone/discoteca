import express from 'express';
import { transaction } from './db.js';
import { parseAppleAlbumId, looksLikeAppleLink } from './itunes.js';
import { looksLikeBandcampLink, parseBandcampUrl } from './bandcamp.js';
import { albumFromRow } from './library.js';

import { HttpError } from './errors.js';

const SORT_MODES = new Set(['position', 'original', 'artist', 'year', 'title', 'added']);

// ID de álbum: positivo (Apple Music) o negativo (Bandcamp).
function toAlbumId(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n === 0) throw new HttpError(400, 'Identificador de álbum no válido.');
  return n;
}

function toId(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, 'Identificador no válido.');
  return n;
}

function cleanName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new HttpError(400, 'El nombre no puede estar vacío.');
  if (name.length > 200) throw new HttpError(400, 'El nombre es demasiado largo.');
  return name;
}

function collectionFromRow(row) {
  return {
    id: row.id,
    folderId: row.folder_id,
    name: row.name,
    description: row.description,
    sortMode: row.sort_mode,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
  };
}

export function createApi(db, itunes, library, bandcamp) {
  const { saveAlbum } = library;
  const q = {
    album: db.prepare('SELECT * FROM albums WHERE id = ?'),
    library: db.prepare(`
      SELECT a.*, (SELECT COUNT(*) FROM collection_albums ca WHERE ca.album_id = a.id) AS collection_count
      FROM albums a ORDER BY a.created_at DESC, a.id DESC`),
    deleteAlbum: db.prepare('DELETE FROM albums WHERE id = ?'),
    membership: db.prepare('SELECT collection_id FROM collection_albums WHERE album_id = ?'),

    folders: db.prepare('SELECT * FROM folders'),
    folder: db.prepare('SELECT * FROM folders WHERE id = ?'),
    insertFolder: db.prepare('INSERT INTO folders (parent_id, name) VALUES (?, ?)'),
    renameFolder: db.prepare('UPDATE folders SET name = ? WHERE id = ?'),
    moveFolder: db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?'),
    deleteFolder: db.prepare('DELETE FROM folders WHERE id = ?'),

    collections: db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM collection_albums ca WHERE ca.collection_id = c.id) AS album_count
      FROM collections c`),
    covers: db.prepare(`
      SELECT collection_id, artwork_url FROM (
        SELECT ca.collection_id, a.artwork_url,
               ROW_NUMBER() OVER (PARTITION BY ca.collection_id ORDER BY ca.position) AS rn
        FROM collection_albums ca JOIN albums a ON a.id = ca.album_id
      ) WHERE rn <= 4`),
    collection: db.prepare('SELECT * FROM collections WHERE id = ?'),
    insertCollection: db.prepare('INSERT INTO collections (folder_id, name) VALUES (?, ?)'),
    deleteCollection: db.prepare('DELETE FROM collections WHERE id = ?'),
    collectionAlbums: db.prepare(`
      SELECT a.*, ca.position, ca.original_position, ca.added_at
      FROM collection_albums ca JOIN albums a ON a.id = ca.album_id
      WHERE ca.collection_id = ? ORDER BY ca.position`),
    removeFromCollection: db.prepare('DELETE FROM collection_albums WHERE collection_id = ? AND album_id = ?'),
    setPosition: db.prepare('UPDATE collection_albums SET position = ? WHERE collection_id = ? AND album_id = ?'),
    lastImport: db.prepare(`
      SELECT j.id, (SELECT COUNT(*) FROM import_items i WHERE i.job_id = j.id AND i.status = 'review') AS review
      FROM import_jobs j WHERE j.collection_id = ? ORDER BY review > 0 DESC, j.id DESC LIMIT 1`),
    reviewCount: db.prepare(`
      SELECT COUNT(*) AS n FROM import_items i JOIN import_jobs j ON j.id = i.job_id
      WHERE j.collection_id = ? AND i.status = 'review'`),
    touchCollection: db.prepare("UPDATE collections SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"),
  };

  const requireFolder = (id) => {
    const folder = q.folder.get(id);
    if (!folder) throw new HttpError(404, 'La carpeta no existe.');
    return folder;
  };
  const requireCollection = (id) => {
    const c = q.collection.get(id);
    if (!c) throw new HttpError(404, 'La colección no existe.');
    return c;
  };
  const optionalFolderId = (value) => {
    if (value === null || value === undefined || value === '') return null;
    return requireFolder(toId(value)).id;
  };

  const addAlbumToCollection = (collectionId, albumId) => library.addAlbumToCollection(collectionId, albumId);

  function setMembership(albumId, collectionIds) {
    const want = new Set(collectionIds.map(toId));
    for (const id of want) requireCollection(id);
    transaction(db, () => {
      const have = new Set(q.membership.all(albumId).map((r) => r.collection_id));
      for (const id of have) if (!want.has(id)) q.removeFromCollection.run(id, albumId);
      for (const id of want) if (!have.has(id)) addAlbumToCollection(id, albumId);
    });
  }

  const membershipOf = (albumId) => q.membership.all(albumId).map((r) => r.collection_id);

  // Añade a cada resultado de Apple si ya está guardado y en qué colecciones.
  const annotate = (albums) =>
    albums.map((a) => {
      const saved = Boolean(q.album.get(a.id));
      return { ...a, saved, collectionIds: saved ? membershipOf(a.id) : [] };
    });

  const r = express.Router();

  // ---------- Árbol de carpetas y colecciones ----------
  r.get('/tree', (req, res) => {
    const covers = new Map();
    for (const row of q.covers.all()) {
      if (!covers.has(row.collection_id)) covers.set(row.collection_id, []);
      if (row.artwork_url) covers.get(row.collection_id).push(row.artwork_url);
    }
    res.json({
      folders: q.folders.all().map((f) => ({ id: f.id, parentId: f.parent_id, name: f.name })),
      collections: q.collections.all().map((c) => ({
        id: c.id,
        folderId: c.folder_id,
        name: c.name,
        albumCount: c.album_count,
        covers: covers.get(c.id) || [],
        sourceType: c.source_type,
      })),
    });
  });

  // ---------- Carpetas ----------
  r.post('/folders', (req, res) => {
    const parentId = optionalFolderId(req.body?.parentId);
    const info = q.insertFolder.run(parentId, cleanName(req.body?.name));
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  r.patch('/folders/:id', (req, res) => {
    const folder = requireFolder(toId(req.params.id));
    const body = req.body || {};
    if ('name' in body) q.renameFolder.run(cleanName(body.name), folder.id);
    if ('parentId' in body) {
      const parentId = optionalFolderId(body.parentId);
      // Evita meter una carpeta dentro de sí misma o de una de sus subcarpetas.
      for (let p = parentId; p != null; p = q.folder.get(p)?.parent_id) {
        if (p === folder.id) throw new HttpError(400, 'No puedes mover una carpeta dentro de sí misma.');
      }
      q.moveFolder.run(parentId, folder.id);
    }
    res.json({ ok: true });
  });

  r.delete('/folders/:id', (req, res) => {
    const folder = requireFolder(toId(req.params.id));
    q.deleteFolder.run(folder.id); // borra en cascada subcarpetas y colecciones (no los álbumes)
    res.json({ ok: true });
  });

  // ---------- Colecciones ----------
  r.post('/collections', (req, res) => {
    const folderId = optionalFolderId(req.body?.folderId);
    const info = q.insertCollection.run(folderId, cleanName(req.body?.name));
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  r.get('/collections/:id', (req, res) => {
    const c = requireCollection(toId(req.params.id));
    const lastImport = q.lastImport.get(c.id);
    res.json({
      collection: { ...collectionFromRow(c), importJobId: lastImport?.id ?? null, reviewCount: q.reviewCount.get(c.id).n },
      albums: q.collectionAlbums.all(c.id).map(albumFromRow),
    });
  });

  r.patch('/collections/:id', (req, res) => {
    const c = requireCollection(toId(req.params.id));
    const body = req.body || {};
    const sets = [];
    const values = [];
    if ('name' in body) {
      sets.push('name = ?');
      values.push(cleanName(body.name));
    }
    if ('folderId' in body) {
      sets.push('folder_id = ?');
      values.push(optionalFolderId(body.folderId));
    }
    if ('description' in body) {
      sets.push('description = ?');
      values.push(body.description ? String(body.description).slice(0, 5000) : null);
    }
    if ('sortMode' in body) {
      if (!SORT_MODES.has(body.sortMode)) throw new HttpError(400, 'Orden no válido.');
      sets.push('sort_mode = ?');
      values.push(body.sortMode);
    }
    if (sets.length) {
      sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
      db.prepare(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`).run(...values, c.id);
    }
    res.json({ ok: true });
  });

  r.delete('/collections/:id', (req, res) => {
    const c = requireCollection(toId(req.params.id));
    q.deleteCollection.run(c.id);
    res.json({ ok: true });
  });

  r.post('/collections/:id/albums', (req, res) => {
    const c = requireCollection(toId(req.params.id));
    const ids = Array.isArray(req.body?.albumIds) ? req.body.albumIds.map(toAlbumId) : [];
    transaction(db, () => {
      for (const id of ids) {
        if (!q.album.get(id)) throw new HttpError(400, `El álbum ${id} no está en la biblioteca.`);
        addAlbumToCollection(c.id, id);
      }
    });
    res.json({ ok: true });
  });

  r.delete('/collections/:id/albums/:albumId', (req, res) => {
    const c = requireCollection(toId(req.params.id));
    q.removeFromCollection.run(c.id, toAlbumId(req.params.albumId));
    q.touchCollection.run(c.id);
    res.json({ ok: true });
  });

  // Guarda un orden manual completo (lista de IDs de álbum en el orden deseado).
  r.put('/collections/:id/order', (req, res) => {
    const c = requireCollection(toId(req.params.id));
    const ids = Array.isArray(req.body?.albumIds) ? req.body.albumIds.map(toAlbumId) : [];
    transaction(db, () => {
      const current = q.collectionAlbums.all(c.id).map((a) => a.id);
      const listed = new Set(ids);
      const ordered = [...ids.filter((id) => current.includes(id)), ...current.filter((id) => !listed.has(id))];
      ordered.forEach((id, i) => q.setPosition.run(i, c.id, id));
    });
    res.json({ ok: true });
  });

  // ---------- Biblioteca de álbumes ----------
  r.get('/albums', (req, res) => {
    res.json({ albums: q.library.all().map(albumFromRow) });
  });

  r.get('/albums/:id', (req, res) => {
    const id = toAlbumId(req.params.id);
    const album = albumFromRow(q.album.get(id));
    if (!album) throw new HttpError(404, 'El álbum no está en la biblioteca.');
    res.json({ album, collectionIds: membershipOf(id) });
  });

  // Busca un álbum de Apple Music (ID positivo) o de Bandcamp (ID negativo, o enlace).
  async function resolveRequested({ id, url }) {
    if (!id && looksLikeBandcampLink(url)) {
      const found = await bandcamp.fetchAlbum(url);
      if (!found) throw new HttpError(404, 'Esa página de Bandcamp no existe o ya no está disponible.');
      return found;
    }
    const requestedId = id ? toAlbumId(id) : parseAppleAlbumId(url);
    if (!requestedId) throw new HttpError(400, 'No reconozco ese enlace. Pega un enlace de un álbum de Apple Music o de Bandcamp.');
    const saved = albumFromRow(q.album.get(requestedId));
    if (saved) return saved;
    if (requestedId < 0) {
      const recent = bandcamp.recentAlbum(requestedId);
      if (!recent) throw new HttpError(404, 'No encuentro ese álbum de Bandcamp. Vuelve a buscarlo.');
      return bandcamp.complete(recent); // el buscador no da año ni pistas: se leen de su página
    }
    const found = await itunes.resolveAlbum(requestedId);
    if (!found) throw new HttpError(404, `No encuentro ese álbum en la tienda de Apple Music (${itunes.country.toUpperCase()}).`);
    return found;
  }

  // Guarda un álbum (por ID o enlace de Apple Music o Bandcamp) y, opcionalmente, fija sus colecciones.
  //   collectionIds: lista completa de colecciones (sustituye a las actuales)
  //   addTo: colecciones a las que añadirlo, sin quitarlo de otras
  r.post('/albums', async (req, res) => {
    const body = req.body || {};
    let album = await resolveRequested(body);
    if (!q.album.get(album.id)) saveAlbum(album);
    album = albumFromRow(q.album.get(album.id));
    if (Array.isArray(body.collectionIds)) setMembership(album.id, body.collectionIds);
    if (Array.isArray(body.addTo)) {
      const ids = body.addTo.map(toId);
      ids.forEach(requireCollection);
      transaction(db, () => ids.forEach((cid) => addAlbumToCollection(cid, album.id)));
    }
    res.status(201).json({ album, collectionIds: membershipOf(album.id) });
  });

  r.put('/albums/:id/collections', (req, res) => {
    const id = toAlbumId(req.params.id);
    if (!q.album.get(id)) throw new HttpError(404, 'El álbum no está en la biblioteca.');
    if (!Array.isArray(req.body?.collectionIds)) throw new HttpError(400, 'Falta la lista de colecciones.');
    setMembership(id, req.body.collectionIds);
    res.json({ collectionIds: membershipOf(id) });
  });

  // Vuelve a pedir los metadatos a Apple o a Bandcamp (por si han cambiado la portada, etc.).
  r.post('/albums/:id/refresh', async (req, res) => {
    const id = toAlbumId(req.params.id);
    const row = q.album.get(id);
    if (!row) throw new HttpError(404, 'El álbum no está en la biblioteca.');
    const found = row.provider === 'bandcamp'
      ? await bandcamp.fetchAlbum(row.external_url, { force: true })
      : await itunes.lookupAlbum(id);
    if (!found) throw new HttpError(404, row.provider === 'bandcamp' ? 'La página de Bandcamp ya no existe.' : 'Apple ya no ofrece este álbum en tu tienda.');
    if (found.id !== id) throw new HttpError(409, 'La página de Bandcamp ahora corresponde a otro álbum.');
    saveAlbum(found);
    res.json({ album: albumFromRow(q.album.get(id)) });
  });

  r.delete('/albums/:id', (req, res) => {
    q.deleteAlbum.run(toAlbumId(req.params.id));
    res.json({ ok: true });
  });

  // ---------- Bandcamp ----------

  // Buscador de Bandcamp dentro de la app.
  r.get('/bandcamp/search', async (req, res) => {
    const term = String(req.query.q ?? '').trim();
    if (term.length < 2) return res.json({ results: [] });
    if (looksLikeBandcampLink(term)) {
      const album = await bandcamp.fetchAlbum(term);
      return res.json({ results: annotate(album ? [album] : []) });
    }
    res.json({ results: annotate(await bandcamp.search(term)) });
  });

  // Asocia a un disco su copia de Bandcamp: un resultado del buscador (bandcampId) o un enlace (url).
  r.put('/albums/:id/bandcamp', async (req, res) => {
    const id = toAlbumId(req.params.id);
    const row = q.album.get(id);
    if (!row) throw new HttpError(404, 'El álbum no está en la biblioteca.');
    if (row.provider === 'bandcamp') throw new HttpError(400, 'Este disco ya es de Bandcamp.');
    const body = req.body || {};
    let url = null;
    let bcId = null;
    if (body.bandcampId) {
      const hit = bandcamp.recentAlbum(-toId(body.bandcampId));
      if (!hit) throw new HttpError(404, 'Vuelve a buscar el disco en Bandcamp.');
      ({ bandcampUrl: url, bandcampId: bcId } = hit);
    } else if (body.url) {
      const found = await bandcamp.fetchAlbum(body.url);
      if (!found) throw new HttpError(404, 'Esa página de Bandcamp no existe o ya no está disponible.');
      ({ bandcampUrl: url, bandcampId: bcId } = found);
    } else {
      throw new HttpError(400, 'Falta el disco de Bandcamp.');
    }
    library.setBandcamp(id, url, bcId);
    res.json({ album: albumFromRow(q.album.get(id)) });
  });

  r.delete('/albums/:id/bandcamp', (req, res) => {
    const id = toAlbumId(req.params.id);
    const row = q.album.get(id);
    if (!row) throw new HttpError(404, 'El álbum no está en la biblioteca.');
    if (row.provider === 'bandcamp') throw new HttpError(400, 'Este disco es de Bandcamp: para quitarlo, elimínalo de la biblioteca.');
    library.setBandcamp(id, null, null);
    res.json({ album: albumFromRow(q.album.get(id)) });
  });

  // Datos del reproductor oficial de Bandcamp. Su ID no siempre se conoce (los enlaces de Record
  // Club no lo traen): se saca de la página la primera vez y se guarda.
  r.get('/albums/:id/bandcamp-player', async (req, res) => {
    const id = toAlbumId(req.params.id);
    const row = q.album.get(id);
    if (!row?.bandcamp_url) return res.json({ player: null });
    let bcId = row.bandcamp_id;
    if (!bcId && parseBandcampUrl(row.bandcamp_url)) {
      try {
        const found = await bandcamp.fetchAlbum(row.bandcamp_url);
        if (found?.bandcampId) {
          bcId = found.bandcampId;
          library.setBandcamp(id, row.bandcamp_url, bcId);
        }
      } catch {
        // sin reproductor: queda el botón «Abrir en Bandcamp»
      }
    }
    res.json({ player: bcId ? { albumId: bcId, url: row.bandcamp_url } : null });
  });

  // ---------- Búsqueda en Apple Music ----------
  r.get('/search', async (req, res) => {
    const term = String(req.query.q ?? '').trim();
    if (term.length < 2) return res.json({ kind: 'search', results: [] });
    if (looksLikeBandcampLink(term)) {
      const album = await bandcamp.fetchAlbum(term);
      return res.json({ kind: 'link', results: annotate(album ? [album] : []), error: album ? undefined : 'Esa página de Bandcamp no existe o ya no está disponible.' });
    }
    if (looksLikeAppleLink(term)) {
      const id = parseAppleAlbumId(term);
      if (!id) return res.json({ kind: 'link', results: [], error: 'No reconozco ese enlace como un álbum de Apple Music.' });
      const album = await itunes.resolveAlbum(id);
      return res.json({ kind: 'link', results: annotate(album ? [album] : []) });
    }
    res.json({ kind: 'search', results: annotate(await itunes.searchAlbums(term)) });
  });

  // Discografía completa de un artista: encuentra discos que la búsqueda por texto no devuelve.
  r.get('/artists/:id/albums', async (req, res) => {
    res.json({ results: annotate(await itunes.artistAlbums(toId(req.params.id))) });
  });

  return r;
}
