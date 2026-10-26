import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { openDb } from './db.js';
import { createItunes } from './itunes.js';
import { createAuth } from './auth.js';
import { createApi } from './api.js';
import { createLibrary } from './library.js';
import { createRecordClub } from './recordclub.js';
import { createImporter } from './importer.js';
import { createBackup } from './backup.js';
import { createBandcamp } from './bandcamp.js';
import { createMusicBrainz } from './musicbrainz.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const db = openDb(config.dbPath);
const itunes = createItunes(db, { country: config.country, perMinute: config.itunesPerMinute });
const auth = createAuth(config);
const library = createLibrary(db);
const recordClub = createRecordClub(db, { delayMs: config.recordClubDelayMs });
const bandcamp = createBandcamp(db);
const musicbrainz = createMusicBrainz(db);
const backup = createBackup({ db, dataDir: config.dataDir, country: config.country });
const importer = createImporter({ db, itunes, recordClub, bandcamp, musicbrainz, library, autoSyncHours: config.autoSyncHours });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https://*.mzstatic.com https://*.bcbits.com; style-src 'self'; " +
      "script-src 'self'; connect-src 'self'; frame-src https://bandcamp.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  next();
});

// La restauración va antes del lector JSON general porque admite archivos más grandes.
app.use('/api/backup/restore', auth.requireAuth, backup.restoreRouter);
app.use(express.json({ limit: '15mb' })); // los Excel llegan en base64

// Huella del código de la interfaz: si cambia (nueva versión desplegada), la app abierta se recarga sola.
function hashDir(dir, hash = crypto.createHash('sha1')) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) hashDir(full, hash);
    else hash.update(name).update(fs.readFileSync(full));
  }
  return hash;
}
const appVersion = hashDir(publicDir).digest('hex').slice(0, 12);

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, version: appVersion });
});
app.use('/api/auth', auth.router);
app.use('/api/imports', auth.requireAuth, importer.router);
app.use('/api/backup', auth.requireAuth, backup.exportRouter);
app.use('/api', auth.requireAuth, createApi(db, itunes, library, bandcamp));
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

// Librería para arrastrar y soltar, servida desde node_modules (no se copia al repositorio).
const sortablePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'sortablejs', 'modular', 'sortable.esm.js');
app.get('/vendor/sortable.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('text/javascript').sendFile(sortablePath);
});

// El frontend es estático; "no-cache" hace que el navegador revalide y coja siempre la última versión.
app.use(express.static(publicDir, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500 && status !== 503) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Error interno del servidor.' : err.message });
});

const server = app.listen(config.port, () => {
  console.log(`Discoteca escuchando en http://localhost:${config.port}`);
  console.log(`Datos en ${config.dataDir} · tienda de Apple: ${config.country.toUpperCase()}`);
  if (!auth.enabled) console.warn('AVISO: APP_PASSWORD no está definida; la app no pide contraseña.');
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
