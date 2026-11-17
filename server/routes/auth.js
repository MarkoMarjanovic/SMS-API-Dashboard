import { Router } from 'express';
import { get, run, now, audit, setSettings } from '../db.js';
import { hashPassword, verifyPassword, createSession, destroySession, sessionCookie, clearCookie, getToken } from '../auth.js';
import { seedDemo } from '../demo.js';

const r = Router();

r.get('/state', (req, res) => {
  const n = get('SELECT COUNT(*) AS n FROM users').n;
  res.json({ needsSetup: n === 0, user: req.user || null });
});

// First-run setup: creates the first admin. Only works while no users exist.
r.post('/setup', (req, res) => {
  if (get('SELECT COUNT(*) AS n FROM users').n > 0) return res.status(409).json({ error: 'Setup already completed' });
  const { email, name, password, company, mode } = req.body || {};
  if (!email || !password || password.length < 8) return res.status(400).json({ error: 'Email and a password of at least 8 characters are required' });
  const id = Number(run('INSERT INTO users(email, name, password_hash, role, created_at) VALUES(?,?,?,?,?)',
    String(email).toLowerCase().trim(), name || '', hashPassword(password), 'admin', now()).lastInsertRowid);
  if (mode === 'demo') seedDemo();
  else setSettings({ demo_mode: '0' });
  if (company) setSettings({ company_name: company });
  audit(email, 'setup', `mode=${mode}`);
  const s = createSession(id);
  sessionCookie(res, s.token, s.expires);
  res.json({ ok: true });
});

const attempts = new Map(); // ip -> { n, until }
r.post('/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip);
  if (a && a.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { email, password } = req.body || {};
  const u = get('SELECT * FROM users WHERE email = ?', String(email || '').toLowerCase().trim());
  if (!u || !verifyPassword(String(password || ''), u.password_hash)) {
    const n = (a?.n || 0) + 1;
    attempts.set(ip, { n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 });
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  attempts.delete(ip);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), u.id);
  const s = createSession(u.id);
  sessionCookie(res, s.token, s.expires);
  audit(u.email, 'login');
  res.json({ ok: true });
});

r.post('/logout', (req, res) => {
  destroySession(getToken(req));
  clearCookie(res);
  res.json({ ok: true });
});

r.post('/password', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  const { current, next } = req.body || {};
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(String(current || ''), u.password_hash)) return res.status(400).json({ error: 'Current password is incorrect' });
  if (!next || next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), u.id);
  audit(u.email, 'password-change');
  res.json({ ok: true });
});

export default r;
