import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });

// Si no se define SESSION_SECRET, se genera uno y se guarda en el volumen de datos.
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(dataDir, '.session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

function parseTrustProxy(value) {
  if (!value) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // p. ej. "loopback" o una IP/subred
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  dataDir,
  dbPath: path.join(dataDir, 'discoteca.db'),
  password: process.env.APP_PASSWORD || '',
  sessionSecret: loadSessionSecret(),
  sessionDays: Number(process.env.SESSION_DAYS) || 180,
  country: (process.env.ITUNES_COUNTRY || 'es').toLowerCase(),
  itunesPerMinute: Number(process.env.ITUNES_RATE_PER_MINUTE) || 20,
  recordClubDelayMs: Number(process.env.RC_DELAY_MS) || 700,
  autoSyncHours: Number(process.env.AUTO_SYNC_HOURS) || 0, // 0 = desactivado
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
};
