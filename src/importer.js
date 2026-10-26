// Importación de listas como colecciones: lee la fuente, empareja cada disco con Apple Music
// y deja los dudosos para revisión. Los trabajos se ejecutan de uno en uno, en segundo plano,
// y se reanudan si el servidor se reinicia.
import express from 'express';
import { transaction } from './db.js';
import { HttpError } from './errors.js';
import { parseListUrl, listUrl } from './recordclub.js';
import { parseUpload } from './parsers.js';
import { findMatch, memoryKeys } from './matcher.js';

const CHUNK = 20;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toId(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, 'Identificador no válido.');
  return n;
}

export function createImporter({ db, itunes, recordClub, library, autoSyncHours = 0 }) {
  const q = {
    job: db.prepare('SELECT * FROM import_jobs WHERE id = ?'),
    jobs: db.prepare(`
      SELECT j.*, c.name AS collection_name FROM import_jobs j
      LEFT JOIN collections c ON c.id = j.collection_id
      ORDER BY j.id DESC LIMIT 100`),
    insertJob: db.prepare(`
      INSERT INTO import_jobs (collection_id, folder_id, source_type, source_url, title, description, status, mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    setJobInfo: db.prepare('UPDATE import_jobs SET info = ? WHERE id = ?'),
    activeJobFor: db.prepare("SELECT id FROM import_jobs WHERE collection_id = ? AND status IN ('fetching', 'matching') ORDER BY id DESC LIMIT 1"),
    knownItems: db.prepare(`
      SELECT i.source_id, i.album_id, i.status, i.artist, i.title FROM import_items i
      JOIN import_jobs j ON j.id = i.job_id
      WHERE j.collection_id = ? AND i.source_id IS NOT NULL ORDER BY i.id`),
    collectionRow: db.prepare('SELECT * FROM collections WHERE id = ?'),
    collectionAlbumRows: db.prepare('SELECT album_id, position, original_position FROM collection_albums WHERE collection_id = ?'),
    setCollectionPositions: db.prepare('UPDATE collection_albums SET original_position = ?, position = ? WHERE collection_id = ? AND album_id = ?'),
    markSynced: db.prepare('UPDATE collections SET last_synced_at = ?, source_ref = ?, source_url = ? WHERE id = ?'),
    rcCollections: db.prepare("SELECT * FROM collections WHERE source_type = 'recordclub' AND source_url IS NOT NULL ORDER BY name"),
    updateJob: db.prepare(`
      UPDATE import_jobs SET status = ?, detail = ?, error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        finished_at = CASE WHEN ? IN ('done', 'error') THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') ELSE finished_at END
      WHERE id = ?`),
    setJobSource: db.prepare(`
      UPDATE import_jobs SET collection_id = ?, title = ?, description = ?, source_ref = ? WHERE id = ?`),
    deleteJob: db.prepare('DELETE FROM import_jobs WHERE id = ?'),
    unfinishedJobs: db.prepare("SELECT id FROM import_jobs WHERE status IN ('fetching', 'matching') ORDER BY id"),
    counts: db.prepare('SELECT status, method, COUNT(*) AS n FROM import_items WHERE job_id = ? GROUP BY status, method'),

    insertItem: db.prepare(`
      INSERT INTO import_items (job_id, position, source_id, source_uri, source_url, mbid, artist, title, year, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    items: db.prepare(`
      SELECT i.*, a.id AS a_id, a.title AS a_title, a.artist AS a_artist, a.year AS a_year, a.genre AS a_genre,
             a.track_count AS a_track_count, a.artwork_url AS a_artwork_url, a.apple_url AS a_apple_url
      FROM import_items i LEFT JOIN albums a ON a.id = i.album_id
      WHERE i.job_id = ? ORDER BY i.position, i.id`),
    item: db.prepare('SELECT * FROM import_items WHERE id = ? AND job_id = ?'),
    pendingItems: db.prepare("SELECT * FROM import_items WHERE job_id = ? AND status = 'pending' ORDER BY position LIMIT ?"),
    updateItem: db.prepare(`
      UPDATE import_items SET status = ?, method = ?, album_id = ?, score = ?, candidates = ? WHERE id = ?`),
    otherUses: db.prepare(`
      SELECT COUNT(*) AS n FROM import_items i JOIN import_jobs j ON j.id = i.job_id
      WHERE j.collection_id = ? AND i.album_id = ? AND i.id <> ? AND i.status = 'matched'`),
    reviewItems: db.prepare("SELECT * FROM import_items WHERE job_id = ? AND status = 'review'"),
    notFoundItems: db.prepare("SELECT * FROM import_items WHERE job_id = ? AND status = 'not_found' ORDER BY position"),

    memory: db.prepare('SELECT * FROM match_memory WHERE key = ?'),
    rememberAuto: db.prepare('INSERT OR IGNORE INTO match_memory (key, apple_id, status) VALUES (?, ?, ?)'),
    rememberUser: db.prepare(`
      INSERT INTO match_memory (key, apple_id, status) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET apple_id = excluded.apple_id, status = excluded.status,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`),

    collection: db.prepare('SELECT id FROM collections WHERE id = ?'),
    folder: db.prepare('SELECT id FROM folders WHERE id = ?'),
    insertCollection: db.prepare(`
      INSERT INTO collections (folder_id, name, description, sort_mode, source_type, source_url, source_ref, last_synced_at)
      VALUES (?, ?, ?, 'position', ?, ?, ?, ?)`),
  };

  const setStatus = (id, status, detail = null, error = null) => q.updateJob.run(status, detail, error, status, id);

  function counts(jobId) {
    const c = { total: 0, pending: 0, matched: 0, auto: 0, user: 0, review: 0, notFound: 0 };
    for (const row of q.counts.all(jobId)) {
      c.total += row.n;
      if (row.status === 'pending') c.pending += row.n;
      if (row.status === 'review') c.review += row.n;
      if (row.status === 'not_found') c.notFound += row.n;
      if (row.status === 'matched') {
        c.matched += row.n;
        if (row.method === 'user') c.user += row.n;
        else c.auto += row.n;
      }
    }
    return c;
  }

  const jobInfo = (job) => (job.info ? JSON.parse(job.info) : null);

  function jobJson(job) {
    return {
      id: job.id,
      status: job.status,
      sourceType: job.source_type,
      sourceUrl: job.source_url,
      title: job.title,
      description: job.description,
      collectionId: job.collection_id,
      collectionName: job.collection_name ?? null,
      detail: job.detail,
      error: job.error,
      createdAt: job.created_at,
      finishedAt: job.finished_at,
      mode: job.mode,
      info: jobInfo(job),
      counts: counts(job.id),
    };
  }

  function itemJson(row) {
    return {
      id: row.id,
      position: row.position,
      artist: row.artist,
      title: row.title,
      year: row.year,
      sourceUrl: row.source_url,
      status: row.status,
      method: row.method,
      score: row.score,
      album: row.a_id
        ? {
          id: row.a_id, title: row.a_title, artist: row.a_artist, year: row.a_year, genre: row.a_genre,
          trackCount: row.a_track_count, artworkUrl: row.a_artwork_url, appleUrl: row.a_apple_url,
        }
        : null,
      candidates: row.candidates ? JSON.parse(row.candidates) : [],
    };
  }

  // ---------- Memoria de emparejamientos ----------

  function recall(item, sourceType) {
    let auto = null;
    for (const key of memoryKeys({ ...item, sourceType, sourceId: item.source_id })) {
      const m = q.memory.get(key);
      if (!m) continue;
      if (m.status !== 'auto') return m; // lo que confirmaste tú manda
      auto ??= m;
    }
    return auto;
  }

  function remember(item, sourceType, appleId, status) {
    const stmt = status === 'auto' ? q.rememberAuto : q.rememberUser;
    for (const key of memoryKeys({ ...item, sourceType, sourceId: item.source_id })) stmt.run(key, appleId, status);
  }

  // ---------- Aplicar resultados ----------

  function collectionOf(job) {
    return job.collection_id && q.collection.get(job.collection_id) ? job.collection_id : null;
  }

  function attach(job, item, albumId) {
    const cid = collectionOf(job);
    if (!cid) return;
    // Si reordenaste la colección a mano, los discos nuevos van al final; si no, a su sitio en la lista.
    const append = jobInfo(job)?.append;
    library.addAlbumToCollection(cid, albumId, { position: append ? undefined : item.position, originalPosition: item.position });
  }

  function detach(job, item) {
    const cid = collectionOf(job);
    if (cid && item.album_id && !q.otherUses.get(cid, item.album_id, item.id).n) {
      library.removeAlbumFromCollection(cid, item.album_id);
    }
  }

  function applyMatch(job, item, { status, method, album, score, candidates }) {
    transaction(db, () => {
      if (status === 'matched') {
        library.saveAlbum(album);
        attach(job, item, album.id);
      }
      q.updateItem.run(status, method, album?.id ?? null, score ?? null, candidates?.length ? JSON.stringify(candidates) : null, item.id);
    });
  }

  // ---------- Ejecución ----------

  const queue = [];
  let running = false;

  function enqueue(jobId) {
    if (!queue.includes(jobId)) queue.push(jobId);
    if (!running) runLoop();
  }

  async function runLoop() {
    running = true;
    while (queue.length) {
      const id = queue.shift();
      try {
        await runJob(id);
      } catch (err) {
        console.error(`Importación ${id}:`, err);
        if (q.job.get(id)) setStatus(id, 'error', null, err.message || 'Error desconocido');
      }
    }
    running = false;
  }

  // Sincronización: vuelve a leer la lista y solo añade los discos que no se habían importado.
  // Los que ya estaban conservan su emparejamiento; se actualiza su posición original y, si no has
  // reordenado la colección a mano, también su posición.
  async function syncRecordClub(job) {
    const ref = parseListUrl(job.source_url);
    setStatus(job.id, 'fetching', 'Leyendo la lista de Record Club…');
    const list = await recordClub.fetchList(ref.username, ref.slug, {
      onPage: (page, total) => setStatus(job.id, 'fetching', `Leyendo la lista: página ${page} de ${total}…`),
    });
    transaction(db, () => {
      const coll = q.collectionRow.get(job.collection_id);
      if (!coll) throw new Error('La colección ya no existe.');
      const known = new Map();
      for (const k of q.knownItems.all(coll.id)) known.set(k.source_id, k);

      const rows = new Map(q.collectionAlbumRows.all(coll.id).map((r) => [r.album_id, r]));
      const customized = [...rows.values()].some((r) => r.original_position == null || r.position !== r.original_position);
      const inList = new Set();
      const fresh = [];
      for (const it of list.items) {
        inList.add(it.sourceId);
        const k = known.get(it.sourceId);
        if (!k) fresh.push(it);
        else if (k.status === 'matched' && rows.has(k.album_id)) {
          const keep = customized ? rows.get(k.album_id).position : it.position;
          q.setCollectionPositions.run(it.position, keep, coll.id, k.album_id);
        }
      }
      const removed = [...known.values()].filter((k) => !inList.has(k.source_id));
      for (const it of fresh) {
        q.insertItem.run(job.id, it.position, it.sourceId, it.sourceUri, it.sourceUrl, it.mbid, it.artist, it.title, it.year, it.kind);
      }
      const info = {
        newCount: fresh.length,
        keptCount: list.items.length - fresh.length,
        append: customized,
        removed: removed.slice(0, 100).map((k) => ({ artist: k.artist, title: k.title })),
        removedCount: removed.length,
      };
      q.setJobInfo.run(JSON.stringify(info), job.id);
      q.setJobSource.run(coll.id, coll.name, list.description || null, String(list.id), job.id);
      q.markSynced.run(new Date().toISOString(), String(list.id), list.url, coll.id);
      if (fresh.length) setStatus(job.id, 'matching', `${fresh.length} disco${fresh.length === 1 ? '' : 's'} nuevo${fresh.length === 1 ? '' : 's'}: emparejando…`);
      else setStatus(job.id, 'done', 'Sin discos nuevos.');
    });
  }

  async function fetchRecordClub(job) {
    if (job.mode === 'sync') return syncRecordClub(job);
    const ref = parseListUrl(job.source_url);
    setStatus(job.id, 'fetching', 'Leyendo la lista de Record Club…');
    const list = await recordClub.fetchList(ref.username, ref.slug, {
      onPage: (page, total) => setStatus(job.id, 'fetching', `Leyendo la lista: página ${page} de ${total}…`),
    });
    if (!list.items.length) throw new Error('La lista está vacía.');
    transaction(db, () => {
      const folderId = job.folder_id && q.folder.get(job.folder_id) ? job.folder_id : null;
      const info = q.insertCollection.run(folderId, list.title, list.description || null, 'recordclub', list.url, String(list.id), new Date().toISOString());
      q.setJobSource.run(Number(info.lastInsertRowid), list.title, list.description || null, String(list.id), job.id);
      for (const it of list.items) {
        q.insertItem.run(job.id, it.position, it.sourceId, it.sourceUri, it.sourceUrl, it.mbid, it.artist, it.title, it.year, it.kind);
      }
      setStatus(job.id, 'matching', 'Emparejando con Apple Music…');
    });
  }

  async function runJob(id) {
    let job = q.job.get(id);
    if (!job) return;
    if (job.status === 'fetching') {
      await fetchRecordClub(job);
      job = q.job.get(id);
    }
    if (job.status !== 'matching') return;

    for (;;) {
      job = q.job.get(id);
      if (!job) return; // borrado mientras se importaba
      const batch = q.pendingItems.all(id, CHUNK);
      if (!batch.length) break;
      const c = counts(id);
      setStatus(id, 'matching', `Emparejando con Apple Music: ${c.total - c.pending} de ${c.total}…`);

      // 1. Memoria
      const work = [];
      const wantIds = new Set();
      for (const item of batch) {
        const m = recall(item, job.source_type);
        if (m?.status === 'not_found') {
          q.updateItem.run('not_found', 'memory', null, null, null, item.id);
          continue;
        }
        const w = { item, memoryId: m?.apple_id ?? null, hintId: null };
        if (w.memoryId) wantIds.add(w.memoryId);
        work.push(w);
      }

      // 2. Enlaces de Apple que trae Record Club
      if (job.source_type === 'recordclub') {
        for (const w of work) {
          if (w.memoryId || !w.item.source_uri) continue;
          try {
            w.hintId = await recordClub.appleHint(w.item.source_uri);
          } catch {
            w.hintId = null; // seguimos con la búsqueda
          }
          if (w.hintId) wantIds.add(w.hintId);
        }
      }

      // Una sola consulta a Apple para todos los IDs del lote; los que no existan, quizá han cambiado de ID.
      const toLookup = [...wantIds].filter((aid) => !library.getAlbum(aid));
      const found = toLookup.length ? await itunes.lookupAlbums(toLookup, { interactive: false }) : new Map();
      const albumFor = (aid) => library.getAlbum(aid) || found.get(aid) || null;
      for (const w of work) {
        if (w.hintId && !albumFor(w.hintId)) {
          const moved = await itunes.resolveMovedId(w.hintId);
          await sleep(300);
          w.hintId = moved;
          if (moved && !albumFor(moved)) {
            const a = await itunes.lookupAlbum(moved, { interactive: false });
            if (a) found.set(moved, a);
          }
        }
      }

      // 3-4. Búsqueda por texto y discografía
      for (const w of work) {
        if (!q.job.get(id)) return;
        const remembered = w.memoryId && albumFor(w.memoryId);
        if (remembered) {
          applyMatch(job, w.item, { status: 'matched', method: 'memory', album: remembered, score: 1 });
          continue;
        }
        const res = await findMatch(
          { artist: w.item.artist, title: w.item.title, year: w.item.year, kind: w.item.kind },
          itunes,
          { hintAlbum: w.hintId ? albumFor(w.hintId) : null },
        );
        applyMatch(job, w.item, res);
        if (res.status === 'matched') remember(w.item, job.source_type, res.album.id, 'auto');
      }
    }
    const c = counts(id);
    const parts = [];
    if (job.mode === 'sync') parts.push(`${c.total} disco${c.total === 1 ? '' : 's'} nuevo${c.total === 1 ? '' : 's'}`);
    if (c.review) parts.push(`${c.review} por revisar`);
    setStatus(id, 'done', parts.join(' · ') || null);
  }

  // Al arrancar, reanuda lo que se quedó a medias.
  for (const { id } of q.unfinishedJobs.all()) enqueue(id);

  // ---------- Acciones del usuario ----------

  async function resolveItem(jobId, itemId, { appleId, notFound }) {
    const job = q.job.get(jobId);
    if (!job) throw new HttpError(404, 'La importación no existe.');
    const item = q.item.get(itemId, jobId);
    if (!item) throw new HttpError(404, 'El disco no existe en esta importación.');

    if (notFound) {
      transaction(db, () => {
        detach(job, item);
        q.updateItem.run('not_found', 'user', null, null, item.candidates, item.id);
        remember(item, job.source_type, null, 'not_found');
      });
      return;
    }

    const id = toId(appleId);
    const fromCandidates = item.candidates ? JSON.parse(item.candidates).find((c) => c.id === id) : null;
    const album = fromCandidates || library.getAlbum(id) || (await itunes.resolveAlbum(id));
    if (!album) throw new HttpError(404, 'Ese álbum no está en la tienda de Apple Music.');
    transaction(db, () => {
      if (item.album_id !== album.id) detach(job, item);
      library.saveAlbum(album);
      attach(job, item, album.id);
      q.updateItem.run('matched', 'user', album.id, null, item.candidates, item.id);
      remember(item, job.source_type, album.id, 'confirmed');
    });
  }

  // Acepta la primera opción de todos los discos en revisión con puntuación suficiente.
  async function acceptSuggestions(jobId, minScore) {
    let accepted = 0;
    for (const item of q.reviewItems.all(jobId)) {
      const best = item.candidates ? JSON.parse(item.candidates)[0] : null;
      if (best && best.score >= minScore) {
        await resolveItem(jobId, item.id, { appleId: best.id });
        accepted++;
      }
    }
    return accepted;
  }

  // Colección ya importada desde esa misma lista (para no duplicarla).
  function importedCollectionFor(url) {
    const ref = parseListUrl(url);
    if (!ref) return null;
    const key = `${ref.username}/${ref.slug}`.toLowerCase();
    return q.rcCollections.all().find((c) => {
      const r = parseListUrl(c.source_url);
      return r && `${r.username}/${r.slug}`.toLowerCase() === key;
    }) || null;
  }

  function createSyncJob(collectionId) {
    const coll = q.collectionRow.get(collectionId);
    if (!coll) throw new HttpError(404, 'La colección no existe.');
    if (coll.source_type !== 'recordclub' || !parseListUrl(coll.source_url)) {
      throw new HttpError(400, 'Esta colección no se importó desde Record Club.');
    }
    const active = q.activeJobFor.get(coll.id);
    if (active) return active.id;
    const info = q.insertJob.run(coll.id, coll.folder_id, 'recordclub', coll.source_url, coll.name, null, 'fetching', 'sync');
    const id = Number(info.lastInsertRowid);
    enqueue(id);
    return id;
  }

  function createJob({ source, folderId, url, name, items }) {
    if (folderId != null && !q.folder.get(folderId)) throw new HttpError(400, 'La carpeta no existe.');
    if (source === 'recordclub') {
      const ref = parseListUrl(url);
      if (!ref) throw new HttpError(400, `No reconozco «${url}». Debe ser como https://record.club/usuario/lists/nombre-de-la-lista`);
      const existing = importedCollectionFor(url);
      if (existing) return { id: createSyncJob(existing.id), mode: 'sync', collectionId: existing.id };
      const info = q.insertJob.run(null, folderId ?? null, 'recordclub', listUrl(ref.username, ref.slug), null, null, 'fetching', 'import');
      const id = Number(info.lastInsertRowid);
      enqueue(id);
      return { id, mode: 'import' };
    }
    const id = transaction(db, () => {
      const c = q.insertCollection.run(folderId ?? null, name, null, source, null, null, null);
      const collectionId = Number(c.lastInsertRowid);
      const info = q.insertJob.run(collectionId, folderId ?? null, source, null, name, null, 'matching', 'import');
      const jobId = Number(info.lastInsertRowid);
      for (const it of items) q.insertItem.run(jobId, it.position, null, null, null, null, it.artist, it.title, it.year ?? null, 'album');
      return jobId;
    });
    enqueue(id);
    return { id, mode: 'import' };
  }

  // ---------- Actualización automática (opcional) ----------
  // Con AUTO_SYNC_HOURS > 0, las colecciones de Record Club se actualizan solas cada N horas.
  function autoSync() {
    const maxAge = autoSyncHours * 3600e3;
    for (const c of q.rcCollections.all()) {
      const last = c.last_synced_at ? Date.parse(c.last_synced_at) : 0;
      if (Date.now() - last < maxAge || q.activeJobFor.get(c.id)) continue;
      try {
        createSyncJob(c.id);
      } catch (err) {
        console.error(`Actualización automática de «${c.name}»:`, err.message);
      }
    }
  }
  if (autoSyncHours > 0) {
    setTimeout(autoSync, 60e3).unref();
    setInterval(autoSync, 30 * 60e3).unref();
  }

  // ---------- API ----------

  const r = express.Router();

  r.get('/', (req, res) => {
    res.json({ jobs: q.jobs.all().map(jobJson) });
  });

  // Vista previa de texto, CSV o Excel antes de importar.
  r.post('/preview', (req, res) => {
    const { filename, data, text, order } = req.body || {};
    let parsed;
    try {
      parsed = parseUpload({ filename, data, text, order });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    res.json({ count: parsed.items.length, skipped: parsed.skipped, sample: parsed.items.slice(0, 8) });
  });

  r.post('/', (req, res) => {
    const body = req.body || {};
    const folderId = body.folderId == null || body.folderId === '' ? null : toId(body.folderId);
    if (body.source === 'recordclub') {
      // Una o varias URL (importación masiva). Las ya importadas se actualizan en vez de duplicarse.
      const urls = (Array.isArray(body.urls) ? body.urls : [body.url])
        .map((u) => String(u ?? '').trim()).filter(Boolean);
      if (!urls.length) throw new HttpError(400, 'Pega al menos una URL de Record Club.');
      const seen = new Set();
      const jobs = [];
      const errors = [];
      for (const url of urls) {
        const ref = parseListUrl(url);
        const key = ref ? `${ref.username}/${ref.slug}`.toLowerCase() : url;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          jobs.push({ url, ...createJob({ source: 'recordclub', folderId, url }) });
        } catch (err) {
          errors.push({ url, error: err.message });
        }
      }
      if (!jobs.length) throw new HttpError(400, errors[0]?.error || 'No hay URL válidas.');
      return res.status(201).json({ id: jobs[0].id, jobs, errors });
    }
    if (body.source === 'text' || body.source === 'file') {
      const name = String(body.name || '').trim().slice(0, 200);
      if (!name) throw new HttpError(400, 'Ponle un nombre a la colección.');
      let parsed;
      try {
        parsed = parseUpload({ filename: body.filename, data: body.data, text: body.text, order: body.order });
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      if (!parsed.items.length) throw new HttpError(400, 'No he encontrado ningún disco. Usa una línea por disco: «Artista – Álbum».');
      return res.status(201).json(createJob({ source: body.source, folderId, name, items: parsed.items }));
    }
    throw new HttpError(400, 'Tipo de importación no válido.');
  });

  // Actualizar una colección (o todas) desde Record Club.
  r.post('/sync', (req, res) => {
    const ids = req.body?.all
      ? q.rcCollections.all().map((c) => c.id)
      : [toId(req.body?.collectionId)];
    if (!ids.length) throw new HttpError(400, 'No hay colecciones importadas desde Record Club.');
    const jobs = ids.map((cid) => ({ collectionId: cid, id: createSyncJob(cid) }));
    res.status(201).json({ id: jobs[0].id, jobs });
  });

  // Listas públicas de un usuario de Record Club, indicando cuáles ya están importadas.
  r.get('/recordclub/:username/lists', async (req, res) => {
    const username = String(req.params.username || '').trim().replace(/^@/, '');
    if (!/^[\w.-]{1,60}$/.test(username)) throw new HttpError(400, 'Nombre de usuario no válido.');
    const lists = await recordClub.fetchUserLists(username);
    res.json({
      lists: lists.map((l) => {
        const c = importedCollectionFor(l.url);
        return { ...l, collectionId: c?.id ?? null, collectionName: c?.name ?? null, lastSyncedAt: c?.last_synced_at ?? null };
      }),
    });
  });

  const requireJob = (req) => {
    const job = db.prepare(`
      SELECT j.*, c.name AS collection_name FROM import_jobs j
      LEFT JOIN collections c ON c.id = j.collection_id WHERE j.id = ?`).get(toId(req.params.id));
    if (!job) throw new HttpError(404, 'La importación no existe.');
    return job;
  };

  r.get('/:id', (req, res) => res.json({ job: jobJson(requireJob(req)) }));

  r.get('/:id/items', (req, res) => {
    const job = requireJob(req);
    res.json({ items: q.items.all(job.id).map(itemJson) });
  });

  r.post('/:id/items/:itemId', async (req, res) => {
    const job = requireJob(req);
    const { appleId, notFound } = req.body || {};
    await resolveItem(job.id, toId(req.params.itemId), { appleId, notFound: Boolean(notFound) });
    const row = q.items.all(job.id).find((i) => i.id === Number(req.params.itemId));
    res.json({ item: itemJson(row), job: jobJson(requireJob(req)) });
  });

  r.post('/:id/accept', async (req, res) => {
    const job = requireJob(req);
    const minScore = Math.min(1, Math.max(0.5, Number(req.body?.minScore) || 0.8));
    const accepted = await acceptSuggestions(job.id, minScore);
    res.json({ accepted, job: jobJson(requireJob(req)) });
  });

  r.post('/:id/retry', (req, res) => {
    const job = requireJob(req);
    if (job.status !== 'error') throw new HttpError(400, 'Solo se pueden reintentar las importaciones con error.');
    setStatus(job.id, job.collection_id || job.source_type !== 'recordclub' ? 'matching' : 'fetching');
    enqueue(job.id);
    res.json({ ok: true });
  });

  r.get('/:id/no-encontrados.csv', (req, res) => {
    const job = requireJob(req);
    // Un texto que empieza por = + - @ se trataría como fórmula en Excel: se antepone un apóstrofo.
    const esc = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [['posicion', 'artista', 'album', 'año', 'enlace'].join(',')];
    for (const it of q.notFoundItems.all(job.id)) {
      lines.push([it.position + 1, it.artist, it.title, it.year ?? '', it.source_url ?? ''].map(esc).join(','));
    }
    const filename = `no-encontrados-${(job.title || 'importacion').normalize('NFD').replace(/[^\w-]+/g, '-').slice(0, 60)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  });

  r.delete('/:id', (req, res) => {
    const job = requireJob(req);
    q.deleteJob.run(job.id);
    res.json({ ok: true });
  });

  return { router: r };
}
