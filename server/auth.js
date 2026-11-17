import crypto from 'node:crypto';
import { get, run, now } from './db.js';

const SESSION_DAYS = 7;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  run('INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)', sha256(token), userId, expires);
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  return { token, expires };
}

export function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token = ?', sha256(token));
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(res, token, expires) {
  const secure = (process.env.PUBLIC_URL || '').startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Expires=${new Date(expires).toUTCString()}${secure}`);
}

export function clearCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

export function getToken(req) {
  return parseCookies(req.headers.cookie).sid;
}

/** Attach req.user if a valid session cookie is present. */
export function loadUser(req, _res, next) {
  const token = getToken(req);
  if (token) {
    const row = get(
      `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`, sha256(token), now());
    if (row) req.user = row;
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

/** Viewers can read everything; only admins can change settings, send, or delete. */
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
  next();
}

// ---- API tokens for the gateway (customer's own systems sending through the dashboard) ----
export function createApiToken(name) {
  const raw = 'tsd_' + crypto.randomBytes(24).toString('hex');
  run('INSERT INTO api_tokens(name, token_hash, prefix, created_at) VALUES(?,?,?,?)', name, sha256(raw), raw.slice(0, 10), now());
  return raw;
}

export function requireApiToken(req, res, next) {
  const h = req.headers.authorization || '';
  const raw = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const row = raw && get('SELECT id, name FROM api_tokens WHERE token_hash = ? AND revoked = 0', sha256(raw));
  if (!row) return res.status(401).json({ error: 'Invalid or missing API token (Authorization: Bearer tsd_...)' });
  run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), row.id);
  req.apiToken = row;
  next();
}
