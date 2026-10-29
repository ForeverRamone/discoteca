// Protección con una contraseña única (APP_PASSWORD).
// La sesión es una cookie firmada con HMAC; cambiar la contraseña invalida todas las sesiones.
import crypto from 'node:crypto';
import express from 'express';

const COOKIE = 'discoteca_session';

export function createAuth(config) {
  const enabled = Boolean(config.password);
  const key = crypto.createHash('sha256').update(`${config.sessionSecret}|${config.password}`).digest();
  const maxAgeMs = config.sessionDays * 864e5;

  const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

  function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  }

  function makeToken() {
    const payload = `v1.${Date.now() + maxAgeMs}`;
    return `${payload}.${sign(payload)}`;
  }

  function isValidToken(token) {
    if (!token) return false;
    const i = token.lastIndexOf('.');
    if (i < 0) return false;
    const payload = token.slice(0, i);
    const expires = Number(payload.split('.')[1]);
    return safeEqual(token.slice(i + 1), sign(payload)) && expires > Date.now();
  }

  function readCookie(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name !== COOKIE) continue;
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return null; // cookie mal codificada: como si no hubiera sesión
      }
    }
    return null;
  }

  const isAuthenticated = (req) => !enabled || isValidToken(readCookie(req));

  function setCookie(req, res, value, maxAgeSeconds) {
    const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
    if (req.secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  // Freno contra fuerza bruta: 10 fallos por IP cada 15 minutos y, por si la IP se puede falsear,
  // 50 fallos en total en ese tiempo.
  const failures = new Map();
  const WINDOW = 15 * 60e3;
  const PER_IP = 10;
  const GLOBAL = 50;
  let total = { first: 0, count: 0 };
  const fresh = (f) => f && Date.now() - f.first <= WINDOW;
  function tooManyFailures(ip) {
    if (fresh(total) && total.count >= GLOBAL) return true;
    const f = failures.get(ip);
    return fresh(f) && f.count >= PER_IP;
  }
  function recordFailure(ip) {
    const now = Date.now();
    for (const [k, f] of failures) if (!fresh(f)) failures.delete(k); // purga las caducadas
    if (fresh(total)) total.count++;
    else total = { first: now, count: 1 };
    const f = failures.get(ip);
    if (f) f.count++;
    else failures.set(ip, { first: now, count: 1 });
  }

  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json({ authRequired: enabled, authenticated: isAuthenticated(req), country: config.country });
  });

  router.post('/login', (req, res) => {
    if (!enabled) return res.json({ ok: true });
    const ip = req.ip;
    if (tooManyFailures(ip)) {
      return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
    }
    if (!safeEqual(req.body?.password ?? '', config.password)) {
      recordFailure(ip);
      return res.status(401).json({ error: 'Contraseña incorrecta.' });
    }
    failures.delete(ip);
    setCookie(req, res, makeToken(), Math.floor(maxAgeMs / 1000));
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  function requireAuth(req, res, next) {
    if (isAuthenticated(req)) return next();
    res.status(401).json({ error: 'No has iniciado sesión.' });
  }

  return { enabled, router, requireAuth };
}
