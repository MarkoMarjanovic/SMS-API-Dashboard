import { Router } from 'express';
import { get, run, now, audit, setSettings } from '../db.js';
import { hashPassword, verifyPassword, createSession, destroySession, sessionCookie, clearCookie, getToken } from '../auth.js';
import { seedDemo } from '../demo.js';

const r = Router();

r.get('/state', async (req, res) => {
  const n = (await get('SELECT COUNT(*) AS n FROM users')).n;
  res.json({ needsSetup: n === 0, user: req.user || null });
});

// First-run setup: creates the first admin. Only works while no users exist.
r.post('/setup', async (req, res) => {
  const { email, name, password, company, mode } = req.body || {};
  if (!email || !password || password.length < 8) return res.status(400).json({ error: 'Email and a password of at least 8 characters are required' });
  // Atomic "only if no users exist" so two simultaneous visitors can't both become admin.
  const created = await get(`INSERT INTO users(email, name, password_hash, role, created_at)
    SELECT ?,?,?,'admin',? WHERE NOT EXISTS (SELECT 1 FROM users) RETURNING id`,
    String(email).toLowerCase().trim(), name || '', hashPassword(password), now());
  if (!created) return res.status(409).json({ error: 'Setup already completed' });
  if (mode === 'demo') await seedDemo();
  else await setSettings({ demo_mode: '0' });
  if (company) await setSettings({ company_name: company });
  await audit(email, 'setup', `mode=${mode}`);
  const s = await createSession(created.id);
  sessionCookie(res, s.token, s.expires);
  res.json({ ok: true });
});

// Login throttling is stored in the database so it holds across serverless instances.
r.post('/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  const a = await get('SELECT n, until FROM login_attempts WHERE ip = ?', ip);
  if (a?.until && Date.parse(a.until) > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { email, password } = req.body || {};
  const u = await get('SELECT * FROM users WHERE email = ?', String(email || '').toLowerCase().trim());
  if (!u || !verifyPassword(String(password || ''), u.password_hash)) {
    const n = (a?.n || 0) + 1;
    await run(`INSERT INTO login_attempts(ip, n, until) VALUES(?,?,?) ON CONFLICT (ip) DO UPDATE SET n = EXCLUDED.n, until = EXCLUDED.until`,
      ip, n >= 5 ? 0 : n, n >= 5 ? new Date(Date.now() + 5 * 60e3).toISOString() : null);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  await run('DELETE FROM login_attempts WHERE ip = ?', ip);
  await run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), u.id);
  const s = await createSession(u.id);
  sessionCookie(res, s.token, s.expires);
  await audit(u.email, 'login');
  res.json({ ok: true });
});

r.post('/logout', async (req, res) => {
  await destroySession(getToken(req));
  clearCookie(res);
  res.json({ ok: true });
});

r.post('/password', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  const { current, next } = req.body || {};
  const u = await get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(String(current || ''), u.password_hash)) return res.status(400).json({ error: 'Current password is incorrect' });
  if (!next || next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  await run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), u.id);
  await audit(u.email, 'password-change');
  res.json({ ok: true });
});

export default r;
