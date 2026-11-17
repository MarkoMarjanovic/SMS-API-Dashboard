import { Router } from 'express';
import crypto from 'node:crypto';
import { db, all, get, run, tx, now, audit, getSettings, setSettings } from '../db.js';
import { requireAdmin, hashPassword, createApiToken } from '../auth.js';
import { sendCsv, int, ah } from '../util.js';
import { invalidateRates, fixedCostsForMonth, round, parsePhone } from '../pricing.js';
import { spendSince, evaluateAlerts } from '../spend.js';
import { seedDemo, clearOperationalData } from '../demo.js';
import { createClient, TelesignError } from '../telesign.js';
import { PRODUCT_KEYS, guessProduct } from '../../shared/products.js';

const r = Router();

// ---------------- Rate card ----------------
r.get('/rates', (_req, res) => res.json(all('SELECT * FROM rates ORDER BY product, country = \'*\' DESC, country')));

/** Upsert one or many rates: [{ product, country, price, carrier_fee, note }] */
r.put('/rates', requireAdmin, (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : req.body.rows || [];
  let n = 0, skipped = 0;
  tx(() => {
    const stmt = db.prepare(`INSERT INTO rates(product, country, price, carrier_fee, note, updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(product, country) DO UPDATE SET price = excluded.price, carrier_fee = excluded.carrier_fee, note = excluded.note, updated_at = excluded.updated_at`);
    for (const x of rows) {
      const product = PRODUCT_KEYS.includes(x.product) ? x.product : guessProduct(x.product);
      const country = String(x.country || '').trim().toUpperCase();
      const price = Number(String(x.price).replace(/[^0-9.\-]/g, ''));
      if (!country || !Number.isFinite(price)) { skipped++; continue; }
      stmt.run(product, country, price, Number(x.carrier_fee) || 0, x.note || null, now());
      n++;
    }
  });
  invalidateRates();
  audit(req.user.email, 'rates-update', `${n} rates`);
  res.json({ updated: n, skipped });
});

r.delete('/rates/:id', requireAdmin, (req, res) => {
  run('DELETE FROM rates WHERE id = ?', req.params.id);
  invalidateRates();
  res.json({ ok: true });
});

/** Re-price stored transactions in a date range using the current rate card (e.g. after a contract change). */
r.post('/rates/reprice', requireAdmin, (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  const rows = all(`SELECT id, product, country, segments, units FROM transactions WHERE created_at >= ? AND created_at < date(?, '+1 day')
    AND cost_source = 'rate_card' AND source != 'import' AND status_kind IS NOT 'blocked'`, from, to);
  const rates = new Map(all('SELECT product, country, price + carrier_fee AS p FROM rates').map((x) => [`${x.product}|${x.country}`, x.p]));
  tx(() => {
    const st = db.prepare('UPDATE transactions SET cost = ? WHERE id = ?');
    for (const t of rows) {
      const p = rates.get(`${t.product}|${t.country}`) ?? rates.get(`${t.product}|*`) ?? 0;
      st.run(round(p * (t.product === 'sms' || t.product === 'whatsapp' ? t.segments : t.units)), t.id);
    }
  });
  audit(req.user.email, 'reprice', `${rows.length} transactions ${from}..${to}`);
  res.json({ repriced: rows.length });
});

// ---------------- Fixed / recurring costs ----------------
r.get('/fixed-costs', (_req, res) => res.json(all('SELECT * FROM fixed_costs ORDER BY start_date DESC')));
r.post('/fixed-costs', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.name || !Number.isFinite(Number(b.amount))) return res.status(400).json({ error: 'Name and amount are required' });
  run('INSERT INTO fixed_costs(name, category, amount, frequency, start_date, end_date, note) VALUES(?,?,?,?,?,?,?)',
    b.name, b.category || 'other', Number(b.amount), b.frequency || 'monthly', b.start_date || now().slice(0, 10), b.end_date || null, b.note || null);
  res.json({ ok: true });
});
r.put('/fixed-costs/:id', requireAdmin, (req, res) => {
  const b = req.body || {};
  run('UPDATE fixed_costs SET name=?, category=?, amount=?, frequency=?, start_date=?, end_date=?, note=? WHERE id=?',
    b.name, b.category, Number(b.amount), b.frequency, b.start_date, b.end_date || null, b.note || null, req.params.id);
  res.json({ ok: true });
});
r.delete('/fixed-costs/:id', requireAdmin, (req, res) => {
  run('DELETE FROM fixed_costs WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// ---------------- Spending controls & geo permissions ----------------
const CONTROL_KEYS = ['monthly_budget', 'daily_budget', 'hard_stop', 'country_policy', 'allowed_countries', 'blocked_countries',
  'quiet_hours_start', 'quiet_hours_end', 'verify_conversion_alert', 'spike_multiplier', 'alert_webhook_url', 'optout_keywords', 'optin_keywords', 'optout_footer'];

r.get('/controls', (_req, res) => {
  const s = getSettings();
  const ms = new Date().toISOString().slice(0, 7) + '-01';
  res.json({
    settings: Object.fromEntries(CONTROL_KEYS.map((k) => [k, s[k]])),
    caps: all(`SELECT cc.country, cc.monthly_cap, COALESCE((SELECT SUM(cost) FROM transactions t WHERE t.country = cc.country AND t.created_at >= ? AND t.status_kind IS NOT 'blocked'), 0) AS spent
      FROM country_caps cc ORDER BY country`, ms),
    month_spend: round(spendSince(ms), 2),
    today_spend: round(spendSince(new Date().toISOString().slice(0, 10)), 2),
    blocked_month: get("SELECT COUNT(*) AS n FROM transactions WHERE status_kind = 'blocked' AND created_at >= ?", ms).n,
    currency: s.currency,
  });
});

r.put('/controls', requireAdmin, (req, res) => {
  const b = req.body || {};
  const patch = Object.fromEntries(Object.entries(b).filter(([k]) => CONTROL_KEYS.includes(k)));
  for (const k of ['allowed_countries', 'blocked_countries']) if (k in patch) patch[k] = String(patch[k]).toUpperCase().replace(/[^A-Z,]/g, '');
  setSettings(patch);
  audit(req.user.email, 'controls-update', patch);
  evaluateAlerts();
  res.json({ ok: true });
});

r.put('/controls/caps', requireAdmin, (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [];
  tx(() => {
    db.exec('DELETE FROM country_caps');
    const st = db.prepare('INSERT INTO country_caps(country, monthly_cap) VALUES(?, ?)');
    for (const x of rows) if (x.country && Number(x.monthly_cap) > 0) st.run(String(x.country).toUpperCase(), Number(x.monthly_cap));
  });
  audit(req.user.email, 'caps-update', rows);
  res.json({ ok: true });
});

// ---------------- Alerts ----------------
r.get('/alerts', (req, res) => {
  const where = req.query.open ? 'WHERE acknowledged = 0' : '';
  res.json(all(`SELECT * FROM alerts ${where} ORDER BY acknowledged, created_at DESC LIMIT 200`));
});
r.post('/alerts/:id/ack', (req, res) => {
  run('UPDATE alerts SET acknowledged = 1 WHERE id = ?', req.params.id);
  res.json({ ok: true });
});
r.post('/alerts/ack-all', (_req, res) => {
  run('UPDATE alerts SET acknowledged = 1');
  res.json({ ok: true });
});

// ---------------- Reports ----------------
function monthlyReport(ym) {
  const start = `${ym}-01`;
  const [y, m] = ym.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const prevYm = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const lines = all(`SELECT product, COALESCE(country, '??') AS country, SUM(units) AS units, SUM(segments) AS segments, SUM(cost) AS cost,
      SUM(CASE WHEN status_kind='delivered' THEN units ELSE 0 END) AS delivered, SUM(CASE WHEN status_kind='failed' THEN units ELSE 0 END) AS failed
    FROM transactions WHERE created_at >= ? AND created_at < ? AND status_kind IS NOT 'blocked' GROUP BY product, country ORDER BY product, cost DESC`, start, next);
  const usage = lines.reduce((a, x) => a + x.cost, 0);
  const fixed = fixedCostsForMonth(ym);
  const prevUsage = get("SELECT COALESCE(SUM(cost),0) AS s FROM transactions WHERE created_at >= ? AND created_at < ? AND status_kind IS NOT 'blocked'", `${prevYm}-01`, start).s;
  const byProduct = {};
  for (const l of lines) {
    byProduct[l.product] ??= { product: l.product, units: 0, segments: 0, cost: 0 };
    byProduct[l.product].units += l.units;
    byProduct[l.product].segments += l.segments;
    byProduct[l.product].cost += l.cost;
  }
  return {
    month: ym, lines: lines.map((l) => ({ ...l, cost: round(l.cost, 4) })),
    by_product: Object.values(byProduct).map((x) => ({ ...x, cost: round(x.cost, 2) })).sort((a, b) => b.cost - a.cost),
    usage_total: round(usage, 2), fixed, total: round(usage + fixed.total, 2), previous_usage: round(prevUsage, 2),
    company: getSettings().company_name, currency: getSettings().currency, generated_at: now(),
  };
}

r.get('/reports/months', (_req, res) => res.json(all('SELECT DISTINCT substr(created_at, 1, 7) AS month FROM transactions ORDER BY month DESC').map((x) => x.month)));
r.get('/reports/monthly', (req, res) => res.json(monthlyReport(/^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : now().slice(0, 7))));
r.get('/reports/monthly.csv', (req, res) => {
  const rep = monthlyReport(/^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : now().slice(0, 7));
  const rows = [...rep.lines.map((l) => ({ type: 'usage', ...l, cost: round(l.cost, 4) })),
    ...rep.fixed.items.map((f) => ({ type: 'fixed', product: f.category, country: '', units: '', segments: '', cost: f.month_amount, name: f.name }))];
  sendCsv(res, `usage_report_${rep.month}.csv`, rows, ['type', 'product', 'country', 'units', 'segments', 'delivered', 'failed', 'cost', 'name']);
});

// ---------------- Usage import (Telesign Portal / invoice exports) ----------------
r.get('/import/batches', (_req, res) => {
  res.json(all(`SELECT reference_id AS batch, MIN(status_text) AS file, COUNT(*) AS lines, SUM(units) AS units, SUM(cost) AS cost,
    MIN(created_at) AS first, MAX(created_at) AS last, MAX(updated_at) AS imported_at
    FROM transactions WHERE source = 'import' GROUP BY reference_id ORDER BY imported_at DESC`));
});

/** rows: [{ date, product, country | phone, quantity, cost, segments, status }] — cost is optional (rate card used if missing). */
r.post('/import/usage', requireAdmin, (req, res) => {
  const { rows = [], file_name = 'import.csv' } = req.body || {};
  const batch = 'IMPORT-' + crypto.randomBytes(5).toString('hex');
  const rates = new Map(all('SELECT product, country, price + carrier_fee AS p FROM rates').map((x) => [`${x.product}|${x.country}`, x.p]));
  const stats = { imported: 0, skipped: 0, cost: 0, batch };
  tx(() => {
    const st = db.prepare(`INSERT INTO transactions(reference_id, product, phone, country, units, segments, status_code, status_kind, status_text, cost, cost_source, source, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?, 'import', ?, ?)`);
    for (const x of rows) {
      const d = new Date(x.date);
      if (Number.isNaN(d.getTime())) { stats.skipped++; continue; }
      const product = PRODUCT_KEYS.includes(x.product) ? x.product : guessProduct(x.product);
      const p = x.phone ? parsePhone(x.phone) : null;
      let country = String(x.country || p?.country || '').trim().toUpperCase().slice(0, 2) || null;
      const qty = Math.max(int(String(x.quantity ?? '1').replace(/[^0-9.]/g, ''), 1), 0);
      const segments = int(x.segments, qty);
      const rawCost = x.cost === undefined || x.cost === '' ? NaN : Number(String(x.cost).replace(/[^0-9.\-]/g, ''));
      const hasCost = Number.isFinite(rawCost);
      const unit = rates.get(`${product}|${country}`) ?? rates.get(`${product}|*`) ?? 0;
      const cost = hasCost ? rawCost : unit * (product === 'sms' ? segments : qty);
      const code = x.status && /^\d+$/.test(String(x.status)) ? Number(x.status) : null;
      st.run(batch, product, p?.e164 ?? null, country, qty, segments, code, 'imported', file_name, round(cost), hasCost ? 'invoice' : 'rate_card', d.toISOString(), now());
      stats.imported++;
      stats.cost += cost;
    }
  });
  stats.cost = round(stats.cost, 2);
  audit(req.user.email, 'usage-import', `${file_name}: ${stats.imported} lines`);
  res.json(stats);
});

r.delete('/import/batches/:batch', requireAdmin, (req, res) => {
  const n = run("DELETE FROM transactions WHERE source = 'import' AND reference_id = ?", req.params.batch).changes;
  audit(req.user.email, 'usage-import-delete', `${req.params.batch}: ${n} lines`);
  res.json({ deleted: n });
});

// ---------------- Settings ----------------
const SETTINGS_KEYS = ['company_name', 'currency', 'demo_mode', 'telesign_customer_id', 'telesign_api_key', 'default_sender_id', 'require_callback_signature'];
const mask = (k) => (k ? k.slice(0, 4) + '•'.repeat(Math.max(4, k.length - 8)) + k.slice(-4) : '');

r.get('/settings', (req, res) => {
  const s = getSettings();
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  res.json({
    ...Object.fromEntries(SETTINGS_KEYS.map((k) => [k, s[k]])),
    telesign_api_key: mask(s.telesign_api_key),
    has_api_key: !!s.telesign_api_key,
    credentials_from_env: !!process.env.TELESIGN_API_KEY,
    callback_url: `${base}/api/callbacks/telesign`,
    gateway_url: `${base}/api/gateway/v1`,
  });
});

r.put('/settings', requireAdmin, (req, res) => {
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => SETTINGS_KEYS.includes(k)));
  if (patch.telesign_api_key && patch.telesign_api_key.includes('•')) delete patch.telesign_api_key;
  setSettings(patch);
  audit(req.user.email, 'settings-update', Object.keys(patch).join(', '));
  res.json({ ok: true });
});

/** Checks credentials by requesting the status of a non-existent message: 401 = bad credentials, 404 = credentials OK. */
r.post('/settings/test-connection', requireAdmin, ah(async (_req, res) => {
  const s = getSettings();
  if (!s.telesign_customer_id || !s.telesign_api_key) return res.json({ ok: false, message: 'Customer ID and API key are required' });
  try {
    await createClient({ customerId: s.telesign_customer_id, apiKey: s.telesign_api_key }).smsStatus('0123456789ABCDEF0123456789ABCDEF');
    res.json({ ok: true, message: 'Connected to Telesign' });
  } catch (e) {
    if (e instanceof TelesignError && (e.status === 401 || e.status === 403)) return res.json({ ok: false, message: 'Telesign rejected the credentials (401/403). Check Customer ID and API key.' });
    if (e instanceof TelesignError) return res.json({ ok: true, message: `Credentials accepted (test lookup returned HTTP ${e.status}, as expected)` });
    res.json({ ok: false, message: `Could not reach Telesign: ${e.message}` });
  }
}));

r.post('/settings/demo/reset', requireAdmin, (req, res) => {
  const n = seedDemo();
  audit(req.user.email, 'demo-reset', `${n} transactions`);
  res.json({ ok: true, transactions: n });
});

r.post('/settings/demo/clear', requireAdmin, (req, res) => {
  clearOperationalData();
  db.exec('DELETE FROM rates; DELETE FROM fixed_costs;');
  invalidateRates();
  setSettings({ demo_mode: '0', company_name: getSettings().company_name.replace(/\s*\(demo\)$/, '') });
  audit(req.user.email, 'demo-clear', 'All demo data removed; ready for live use');
  res.json({ ok: true });
});

// ---------------- Users ----------------
r.get('/users', requireAdmin, (_req, res) => res.json(all('SELECT id, email, name, role, created_at, last_login_at FROM users ORDER BY created_at')));
r.post('/users', requireAdmin, (req, res) => {
  const { email, name, password, role = 'viewer' } = req.body || {};
  if (!email || !password || password.length < 8) return res.status(400).json({ error: 'Email and a password of at least 8 characters are required' });
  try {
    run('INSERT INTO users(email, name, password_hash, role, created_at) VALUES(?,?,?,?,?)', email.toLowerCase().trim(), name || '', hashPassword(password), role === 'admin' ? 'admin' : 'viewer', now());
  } catch {
    return res.status(409).json({ error: 'A user with that email already exists' });
  }
  audit(req.user.email, 'user-create', `${email} (${role})`);
  res.json({ ok: true });
});
r.put('/users/:id', requireAdmin, (req, res) => {
  const { role, password } = req.body || {};
  if (role) {
    if (Number(req.params.id) === req.user.id && role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own admin role' });
    run('UPDATE users SET role = ? WHERE id = ?', role === 'admin' ? 'admin' : 'viewer', req.params.id);
  }
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), req.params.id);
    run('DELETE FROM sessions WHERE user_id = ?', req.params.id);
  }
  audit(req.user.email, 'user-update', `id ${req.params.id}`);
  res.json({ ok: true });
});
r.delete('/users/:id', requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  run('DELETE FROM users WHERE id = ?', req.params.id);
  audit(req.user.email, 'user-delete', `id ${req.params.id}`);
  res.json({ ok: true });
});

// ---------------- API tokens (gateway) ----------------
r.get('/tokens', requireAdmin, (_req, res) => res.json(all('SELECT id, name, prefix, created_at, last_used_at, revoked FROM api_tokens ORDER BY created_at DESC')));
r.post('/tokens', requireAdmin, (req, res) => {
  const token = createApiToken(req.body.name || 'API token');
  audit(req.user.email, 'token-create', req.body.name);
  res.json({ token });
});
r.delete('/tokens/:id', requireAdmin, (req, res) => {
  run('UPDATE api_tokens SET revoked = 1 WHERE id = ?', req.params.id);
  audit(req.user.email, 'token-revoke', `id ${req.params.id}`);
  res.json({ ok: true });
});

r.get('/audit', requireAdmin, (_req, res) => res.json(all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300')));

export default r;
