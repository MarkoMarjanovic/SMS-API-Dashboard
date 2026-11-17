// Postgres data layer.
//  - DATABASE_URL set  -> real Postgres (Neon in production) via node-postgres
//  - otherwise          -> PGlite (embedded Postgres) in ./data/pglite, or in memory when PGLITE_DIR=memory://
// Queries use `?` placeholders (translated to $1..$n). All functions are async.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NUMERIC_TYPES = new Set([20, 21, 23, 700, 701, 1700]); // int8, int2, int4, float4, float8, numeric

let driver; // { query(sql, params) -> { rows, fields, rowCount }, transaction(fn), exec(sql), close() }

async function createDriver() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    // TLS is configured explicitly (full certificate verification) instead of via ?sslmode in the URL.
    const url = new URL(process.env.DATABASE_URL.trim().replace(/^["']|["']$/g, '')); // tolerate quoted values from dashboards
    const local = url.searchParams.get('sslmode') === 'disable' || /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
    url.searchParams.delete('sslmode');
    const pool = new pg.Pool({
      connectionString: url.toString(),
      max: Number(process.env.PG_POOL_MAX) || 5,
      ssl: local ? false : { rejectUnauthorized: true },
      idleTimeoutMillis: 10000,
    });
    const wrap = (c) => ({ query: async (sql, params) => { const r = await c.query(sql, params); return { rows: r.rows, fields: r.fields, rowCount: r.rowCount }; } });
    return {
      ...wrap(pool),
      exec: (sql) => pool.query(sql),
      async transaction(fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const out = await fn(wrap(c));
          await c.query('COMMIT');
          return out;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  let dir = process.env.PGLITE_DIR;
  if (!dir) {
    dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'pglite');
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new PGlite(dir);
  const wrap = (c) => ({ query: async (sql, params) => { const r = await c.query(sql, params); return { rows: r.rows, fields: r.fields, rowCount: r.affectedRows ?? 0 }; } });
  return { ...wrap(db), exec: (sql) => db.exec(sql), transaction: (fn) => db.transaction((t) => fn(wrap(t))), close: () => db.close() };
}

/** `?` -> `$n` (ignoring `?` inside single-quoted literals); LIKE -> ILIKE for SQLite-style case-insensitive search. */
function translate(sql) {
  let out = '', n = 0, inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") inStr = !inStr;
    if (ch === '?' && !inStr) { out += '$' + ++n; continue; }
    out += ch;
  }
  return out.replace(/\bLIKE\b/g, 'ILIKE');
}

function normalize(r) {
  const numeric = (r.fields || []).filter((f) => NUMERIC_TYPES.has(f.dataTypeID)).map((f) => f.name);
  if (numeric.length) for (const row of r.rows) for (const k of numeric) if (row[k] !== null && row[k] !== undefined) row[k] = Number(row[k]);
  return r;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer', created_at TEXT NOT NULL, last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_tokens (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0
);
-- Every billable (or blocked) event. Imported invoice/usage lines live here too (source='import', units = quantity).
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY, reference_id TEXT, product TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'out',
  phone TEXT, country TEXT, contact_id INTEGER, campaign_id INTEGER, message TEXT, message_type TEXT, encoding TEXT,
  units INTEGER NOT NULL DEFAULT 1, segments INTEGER NOT NULL DEFAULT 1,
  status_code INTEGER, status_kind TEXT, status_text TEXT,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0, cost_source TEXT NOT NULL DEFAULT 'rate_card',
  verified INTEGER, demo_code TEXT, source TEXT NOT NULL DEFAULT 'app', created_at TEXT NOT NULL, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_tx_created ON transactions(created_at);
CREATE INDEX IF NOT EXISTS ix_tx_country ON transactions(country, created_at);
CREATE INDEX IF NOT EXISTS ix_tx_ref ON transactions(reference_id);
CREATE INDEX IF NOT EXISTS ix_tx_campaign ON transactions(campaign_id);
CREATE INDEX IF NOT EXISTS ix_tx_phone ON transactions(phone);
CREATE INDEX IF NOT EXISTS ix_tx_pending ON transactions(status_kind) WHERE status_kind = 'pending';
CREATE TABLE IF NOT EXISTS rates (
  id SERIAL PRIMARY KEY, product TEXT NOT NULL, country TEXT NOT NULL, price DOUBLE PRECISION NOT NULL,
  carrier_fee DOUBLE PRECISION NOT NULL DEFAULT 0, note TEXT, updated_at TEXT, UNIQUE(product, country)
);
CREATE TABLE IF NOT EXISTS fixed_costs (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other', amount DOUBLE PRECISION NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly', start_date TEXT NOT NULL, end_date TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY, phone TEXT NOT NULL UNIQUE, country TEXT, first_name TEXT, last_name TEXT, email TEXT,
  tags TEXT NOT NULL DEFAULT '', custom TEXT NOT NULL DEFAULT '{}',
  consent_status TEXT NOT NULL DEFAULT 'unknown', consent_source TEXT, consent_at TEXT, opted_out_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppression (phone TEXT PRIMARY KEY, reason TEXT NOT NULL, source TEXT, note TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS templates (id SERIAL PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, message_type TEXT NOT NULL DEFAULT 'MKT',
  sender_id TEXT, audience_tag TEXT, audience_countries TEXT, status TEXT NOT NULL DEFAULT 'draft',
  scheduled_at TEXT, rate_per_minute INTEGER NOT NULL DEFAULT 60, respect_quiet_hours INTEGER NOT NULL DEFAULT 1,
  total INTEGER NOT NULL DEFAULT 0, estimated_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_by TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, note TEXT,
  last_tick_at TEXT, send_credit DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS campaign_queue (
  id SERIAL PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', transaction_id INTEGER, UNIQUE(campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS ix_queue ON campaign_queue(campaign_id, status);
CREATE TABLE IF NOT EXISTS inbound (
  id SERIAL PRIMARY KEY, phone TEXT NOT NULL, country TEXT, body TEXT, reference_id TEXT, contact_id INTEGER,
  is_optout INTEGER NOT NULL DEFAULT 0, is_optin INTEGER NOT NULL DEFAULT 0, read INTEGER NOT NULL DEFAULT 0,
  replied INTEGER NOT NULL DEFAULT 0, received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_inbound_phone ON inbound(phone);
CREATE TABLE IF NOT EXISTS country_caps (country TEXT PRIMARY KEY, monthly_cap DOUBLE PRECISION);
CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY, dedupe_key TEXT UNIQUE, level TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
  detail TEXT, country TEXT, created_at TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit_log (id SERIAL PRIMARY KEY, "user" TEXT, action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, until TEXT);
`;

let readyPromise;
/** Connect and create the schema once per process (cold start on serverless). */
export function ready() {
  readyPromise ??= (async () => {
    driver = await createDriver();
    await driver.exec(SCHEMA);
  })().catch((e) => { readyPromise = null; throw e; });
  return readyPromise;
}

async function q(sql, params, c) {
  await ready();
  return normalize(await (c || driver).query(translate(sql), params));
}

const api = (c) => ({
  all: async (sql, ...p) => (await q(sql, p, c)).rows,
  get: async (sql, ...p) => (await q(sql, p, c)).rows[0],
  run: async (sql, ...p) => ({ changes: (await q(sql, p, c)).rowCount }),
  /** INSERT ... and return the new row's id. */
  insert: async (sql, ...p) => (await q(sql + ' RETURNING id', p, c)).rows[0]?.id,
});

export const { all, get, run, insert } = api(null);

/** Run fn({ all, get, run, insert }) in a transaction. */
export async function tx(fn) {
  await ready();
  return driver.transaction((c) => fn(api(c)));
}

export async function exec(sql) {
  await ready();
  return driver.exec(sql);
}

/** Insert many rows efficiently: columns = ['a','b'], rows = [[1,2],...]. Optional suffix e.g. 'ON CONFLICT DO NOTHING'. */
export async function bulkInsert(table, columns, rows, suffix = '', c) {
  const chunk = Math.max(1, Math.floor(30000 / columns.length));
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const values = part.map((_, r) => '(' + columns.map((__, k) => '$' + (r * columns.length + k + 1)).join(',') + ')').join(',');
    await ready();
    await (c || driver).query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values} ${suffix}`, part.flat());
  }
}

export async function closeDb() {
  if (driver) await driver.close();
  driver = null;
  readyPromise = null;
}

export const now = () => new Date().toISOString();

// ---- settings ----
const DEFAULT_SETTINGS = {
  company_name: 'My Company',
  currency: 'USD',
  demo_mode: '1',
  telesign_customer_id: '',
  telesign_api_key: '',
  default_sender_id: '',
  monthly_budget: '1500',
  daily_budget: '120',
  hard_stop: '1',
  alert_webhook_url: '',
  country_policy: 'all', // 'all' | 'allowlist'
  allowed_countries: '',
  blocked_countries: '',
  quiet_hours_start: '21',
  quiet_hours_end: '8',
  optout_keywords: 'STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT,OPTOUT',
  optin_keywords: 'START,UNSTOP,YES',
  optout_footer: 'Reply STOP to opt out',
  require_callback_signature: '0',
  verify_conversion_alert: '50',
  spike_multiplier: '2.5',
  last_alert_eval: '',
};

export async function getSettings() {
  const rows = await all('SELECT key, value FROM settings');
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  // Environment overrides (credentials kept out of the DB if preferred)
  if (process.env.TELESIGN_CUSTOMER_ID) s.telesign_customer_id = process.env.TELESIGN_CUSTOMER_ID;
  if (process.env.TELESIGN_API_KEY) s.telesign_api_key = process.env.TELESIGN_API_KEY;
  return s;
}

export async function setSettings(obj) {
  const rows = Object.entries(obj).filter(([k]) => k in DEFAULT_SETTINGS).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]);
  if (rows.length) await bulkInsert('settings', ['key', 'value'], rows, 'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value');
}

export const listSetting = (s, key) => String(s[key] || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

export async function audit(user, action, detail = '') {
  await run('INSERT INTO audit_log("user", action, detail, created_at) VALUES(?,?,?,?)', user || 'system', action, typeof detail === 'string' ? detail : JSON.stringify(detail), now());
}
