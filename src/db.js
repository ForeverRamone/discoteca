import { DatabaseSync } from 'node:sqlite';

const now = "(strftime('%Y-%m-%dT%H:%M:%SZ','now'))";

// Cada elemento es una migración. Nunca modificar una ya publicada: añadir una nueva al final.
const MIGRATIONS = [
  `
  CREATE TABLE albums (
    id            INTEGER PRIMARY KEY,          -- ID de catálogo de Apple Music (collectionId)
    title         TEXT NOT NULL,
    artist        TEXT NOT NULL,
    artist_id     INTEGER,
    year          INTEGER,
    release_date  TEXT,
    genre         TEXT,
    track_count   INTEGER,
    artwork_url   TEXT,                         -- artworkUrl100; el tamaño se cambia al mostrarla
    apple_url     TEXT,                         -- collectionViewUrl sin parámetros de seguimiento
    explicit      INTEGER NOT NULL DEFAULT 0,
    copyright     TEXT,
    country       TEXT,
    created_at    TEXT NOT NULL DEFAULT ${now},
    updated_at    TEXT NOT NULL DEFAULT ${now}
  );

  CREATE TABLE folders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id   INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT ${now}
  );

  CREATE TABLE collections (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id       INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT,
    position        INTEGER NOT NULL DEFAULT 0,
    sort_mode       TEXT NOT NULL DEFAULT 'position',
    source_type     TEXT,                       -- 'recordclub' en colecciones importadas
    source_url      TEXT,
    source_ref      TEXT,
    last_synced_at  TEXT,
    created_at      TEXT NOT NULL DEFAULT ${now},
    updated_at      TEXT NOT NULL DEFAULT ${now}
  );

  CREATE TABLE collection_albums (
    collection_id      INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    album_id           INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    position           INTEGER NOT NULL,         -- orden manual
    original_position  INTEGER,                  -- orden en la fuente (p. ej. Record Club)
    added_at           TEXT NOT NULL DEFAULT ${now},
    PRIMARY KEY (collection_id, album_id)
  );
  CREATE INDEX collection_albums_album ON collection_albums(album_id);

  CREATE TABLE http_cache (
    key         TEXT PRIMARY KEY,
    body        TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL
  );
  `,
  // v2: importación (Record Club, texto, CSV/Excel) y memoria de emparejamientos.
  `
  CREATE TABLE match_memory (
    key         TEXT PRIMARY KEY,               -- 'rc:<id>', 'mb:<mbid>' o 'txt:<artista>|<título>'
    apple_id    INTEGER,                        -- NULL si status = 'not_found'
    status      TEXT NOT NULL,                  -- 'confirmed' (por ti), 'auto' o 'not_found'
    updated_at  TEXT NOT NULL DEFAULT ${now}
  );

  CREATE TABLE import_jobs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id  INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    folder_id      INTEGER,
    source_type    TEXT NOT NULL,               -- 'recordclub', 'text' o 'file'
    source_url     TEXT,
    source_ref     TEXT,
    title          TEXT,
    description    TEXT,
    status         TEXT NOT NULL,               -- 'fetching', 'matching', 'done' o 'error'
    detail         TEXT,
    error          TEXT,
    created_at     TEXT NOT NULL DEFAULT ${now},
    updated_at     TEXT NOT NULL DEFAULT ${now},
    finished_at    TEXT
  );

  CREATE TABLE import_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      INTEGER NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    source_id   TEXT,
    source_uri  TEXT,
    source_url  TEXT,
    mbid        TEXT,
    artist      TEXT NOT NULL,
    title       TEXT NOT NULL,
    year        INTEGER,
    kind        TEXT,
    status      TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'matched', 'review' o 'not_found'
    method      TEXT,                            -- 'memory', 'link', 'search', 'artist' o 'user'
    album_id    INTEGER,
    score       REAL,
    candidates  TEXT                             -- JSON con las mejores opciones
  );
  CREATE INDEX import_items_job ON import_items(job_id, position);
  `,
  // v3: sincronización con Record Club.
  `
  ALTER TABLE import_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'import';  -- 'import' o 'sync'
  ALTER TABLE import_jobs ADD COLUMN info TEXT;                            -- JSON con el resumen de la sincronización
  `,
  // v4: álbumes de Bandcamp (cuando no están en Apple Music). Sus ID son negativos.
  `
  ALTER TABLE albums ADD COLUMN provider TEXT NOT NULL DEFAULT 'apple';   -- 'apple' o 'bandcamp'
  ALTER TABLE albums ADD COLUMN external_url TEXT;                          -- página del álbum en Bandcamp
  `,
  // v5: cualquier disco (también los de Apple Music) puede tener asociada su copia de Bandcamp.
  `
  ALTER TABLE albums ADD COLUMN bandcamp_url TEXT;   -- página del álbum en Bandcamp
  ALTER TABLE albums ADD COLUMN bandcamp_id INTEGER; -- ID de álbum de Bandcamp (lo usa su reproductor)
  UPDATE albums SET bandcamp_url = external_url,
                    bandcamp_id = CASE WHEN -id < 1000000000000 THEN -id END
  WHERE provider = 'bandcamp';
  `,
  // v6: datos personales de cada disco (no vienen de Apple ni de Bandcamp; saveAlbum no los toca).
  `
  ALTER TABLE albums ADD COLUMN listened_at TEXT;                                   -- cuándo lo escuchaste (ISO 8601)
  ALTER TABLE albums ADD COLUMN rating INTEGER CHECK (rating BETWEEN 1 AND 5);      -- valoración de 1 a 5
  ALTER TABLE albums ADD COLUMN notes TEXT;                                         -- notas libres
  `,
];

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let i = version; i < MIGRATIONS.length; i++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  // Limpia la caché HTTP antigua al arrancar y cada 12 horas.
  const purge = db.prepare('DELETE FROM http_cache WHERE fetched_at < ?');
  const purgeCache = () => {
    try {
      purge.run(Date.now() - 30 * 864e5);
    } catch (err) {
      if (db.isOpen) console.error('Limpieza de la caché:', err.message);
    }
  };
  purgeCache();
  setInterval(purgeCache, 12 * 3600e3).unref();
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
