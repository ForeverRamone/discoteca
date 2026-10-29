// Protección con una contraseña única (APP_PASSWORD).
// La sesión es una cookie firmada con HMAC; cambiar la contraseña invalida todas las sesiones.
import crypto from 'node:crypto';
import net from 'node:net';
import express from 'express';

const COOKIE = 'discoteca_session';

// Clave para contar los fallos de una IP: la IPv4 tal cual (también si llega como ::ffff:a.b.c.d) y,
// para IPv6, su prefijo /64, porque cualquier conexión dispone de millones de direcciones dentro de él.
export function ipKey(ip) {
  const s = String(ip ?? '').split('%')[0];
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1];
  if (!net.isIPv6(s)) return s;
  const groups = (part) => (part ? part.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const [head, tail] = s.split('::');
  const h = groups(head);
  const full = tail === undefined ? h : [...h, ...Array(8 - h.length - groups(tail).length).fill('0'), ...groups(tail)];
  return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

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

  // Freno contra fuerza bruta, sin dejar fuera al dueño:
  // - 10 fallos cada 15 minutos por IP (las IPv6 se agrupan por su /64, que suele ser una sola conexión);
  // - en total, como mucho una respuesta de «contraseña incorrecta» por segundo: los fallos esperan su
  //   turno (cada IP, uno en cola como mucho). La contraseña correcta no hace cola, así que un ataque
  //   desde muchas IP no deja fuera al dueño.
  const failures = new Map();
  const WINDOW = 15 * 60e3;
  const PER_IP = 10;
  const FAIL_GAP = 1000; // ms entre una comprobación fallida y la siguiente
  const MAX_QUEUE = 1000; // tope de memoria: intentos esperando turno
  const fresh = (f) => f && Date.now() - f.first <= WINDOW;
  const tooManyFailures = (key) => {
    const f = failures.get(key);
    return fresh(f) && f.count >= PER_IP;
  };
  function recordFailure(key) {
    const now = Date.now();
    for (const [k, f] of failures) if (!fresh(f)) failures.delete(k); // purga las caducadas
    const f = failures.get(key);
    if (f) f.count++;
    else failures.set(key, { first: now, count: 1 });
  }

  let gate = Promise.resolve(); // cola de fallos
  let nextSlot = 0; // antes de este instante no se responde a ningún fallo
  const waiting = new Set(); // claves de IP con un intento en cola
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function failInTurn() {
    const turn = gate.then(async () => {
      const wait = nextSlot - Date.now();
      if (wait > 0) await sleep(wait);
      nextSlot = Date.now() + FAIL_GAP;
    });
    gate = turn.catch(() => {});
    return turn;
  }

  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json({ authRequired: enabled, authenticated: isAuthenticated(req), country: config.country });
  });

  router.post('/login', async (req, res) => {
    if (!enabled) return res.json({ ok: true });
    const key = ipKey(req.ip);
    if (tooManyFailures(key)) {
      return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
    }
    // La contraseña correcta entra al momento; solo los fallos esperan su turno (uno por segundo en
    // total), así que un ataque desde muchas IP se frena sin dejar fuera al dueño.
    if (safeEqual(req.body?.password ?? '', config.password)) {
      failures.delete(key);
      setCookie(req, res, makeToken(), Math.floor(maxAgeMs / 1000));
      return res.json({ ok: true });
    }
    if (waiting.has(key)) return res.status(429).json({ error: 'Ya hay un intento en curso. Espera un momento.' });
    if (waiting.size >= MAX_QUEUE) return res.status(503).json({ error: 'Hay demasiados intentos ahora mismo. Vuelve a probar en un momento.' });
    waiting.add(key);
    try {
      await failInTurn();
    } finally {
      waiting.delete(key);
    }
    recordFailure(key);
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
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
