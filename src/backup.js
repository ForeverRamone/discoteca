// Copia de seguridad en JSON: álbumes, carpetas, colecciones, su contenido y la memoria de emparejamientos.
// El historial de importaciones no se incluye (se puede volver a importar o actualizar desde Record Club).
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { transaction } from './db.js';
import { HttpError } from './errors.js';

const FORMAT = 1;

// Orden de inserción (los padres antes que los hijos) y nombre de cada tabla en el JSON.
const TABLES = [
  ['albums', 'albums'],
  ['folders', 'folders'],
  ['collections', 'collections'],
  ['collection_albums', 'collectionAlbums'],
  ['match_memory', 'matchMemory'],
];

export function createBackup({ db, dataDir, country }) {
  const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  function exportAll() {
    const data = {};
    const counts = {};
    for (const [table, key] of TABLES) {
      data[key] = db.prepare(`SELECT * FROM ${table}`).all().map((row) => ({ ...row }));
      counts[key] = data[key].length;
    }
    return {
      app: 'discoteca',
      format: FORMAT,
      schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
      exportedAt: new Date().toISOString(),
      country,
      counts,
      data,
    };
  }

  // Copia exacta de la base de datos actual, por si la restauración no era lo que querías.
  function safetyCopy() {
    const dir = path.join(dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `antes-de-restaurar-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    db.exec(`VACUUM INTO '${file.replace(/\\/g, '/').replace(/'/g, "''")}'`);
    // Conserva solo las 10 copias más recientes.
    const old = fs.readdirSync(dir).filter((f) => f.startsWith('antes-de-restaurar-')).sort().slice(0, -10);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    return path.basename(file);
  }

  function validate(backup) {
    if (!backup || backup.app !== 'discoteca' || !backup.data) {
      throw new HttpError(400, 'Este archivo no es una copia de seguridad de Discoteca.');
    }
    if (backup.format > FORMAT) {
      throw new HttpError(400, 'La copia es de una versión más nueva de la app. Actualiza Discoteca antes de restaurarla.');
    }
    for (const [, key] of TABLES) {
      const rows = backup.data[key] ?? [];
      if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
        throw new HttpError(400, `La copia está dañada (sección «${key}»).`);
      }
    }
    // Carpetas: ninguna puede colgar de sí misma ni de una de sus subcarpetas.
    const parent = new Map((backup.data.folders ?? []).map((f) => [Number(f.id), f.parent_id == null ? null : Number(f.parent_id)]));
    for (const start of parent.keys()) {
      const seen = new Set();
      for (let p = start; p != null && parent.has(p); p = parent.get(p)) {
        if (seen.has(p)) throw new HttpError(400, 'La copia está dañada: hay carpetas que se contienen a sí mismas.');
        seen.add(p);
      }
    }
  }

  function restore(backup) {
    validate(backup);
    const active = db.prepare("SELECT COUNT(*) AS n FROM import_jobs WHERE status IN ('fetching', 'matching')").get().n;
    if (active) throw new HttpError(409, 'Hay importaciones en marcha. Espera a que terminen para restaurar.');

    const savedAs = safetyCopy();
    const counts = {};
    db.exec('PRAGMA foreign_keys = OFF'); // se comprueban todas al final
    try {
      transaction(db, () => {
        // Con las claves foráneas desactivadas no hay borrado en cascada: se borra todo explícitamente.
        db.exec('DELETE FROM import_items; DELETE FROM import_jobs; DELETE FROM collection_albums; DELETE FROM collections; DELETE FROM folders; DELETE FROM albums; DELETE FROM match_memory;');
        for (const [table, key] of TABLES) {
          const cols = columnsOf(table);
          const rows = backup.data[key] ?? [];
          counts[key] = rows.length;
          if (!rows.length) continue;
          // Solo las columnas que existen en esta versión; las que falten en una fila toman su valor por defecto.
          const stmts = new Map();
          for (const row of rows) {
            const present = cols.filter((c) => row[c] !== undefined);
            const key = present.join(',');
            if (!stmts.has(key)) {
              stmts.set(key, db.prepare(`INSERT INTO ${table} (${present.join(', ')}) VALUES (${present.map((c) => `:${c}`).join(', ')})`));
            }
            const params = {};
            for (const c of present) params[c] = typeof row[c] === 'boolean' ? Number(row[c]) : row[c];
            stmts.get(key).run(params);
          }
        }
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new HttpError(400, `La copia tiene referencias rotas (${broken.length}). No se ha restaurado nada.`);
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, `No se pudo restaurar la copia: ${err.message}. No se ha cambiado nada.`);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
    return { counts, safetyCopy: savedAs };
  }

  const exportRouter = express.Router();
  exportRouter.get('/', (req, res) => {
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="discoteca-${date}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/json').send(JSON.stringify(exportAll(), null, 1));
  });

  // Necesita su propio límite de tamaño: una biblioteca grande ocupa varios MB.
  const restoreRouter = express.Router();
  restoreRouter.post('/', express.json({ limit: '100mb' }), (req, res) => {
    res.json(restore(req.body));
  });

  return { exportRouter, restoreRouter, exportAll, restore };
}
