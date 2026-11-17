import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'dashboard.db');
export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer', created_at TEXT NOT NULL, last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0
);

-- Every billable (or blocked) event. Imported invoice/usage lines are stored here too with source='import'
-- and units = quantity, so all analytics run off one table.
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  reference_id TEXT,
  product TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'out',
  phone TEXT,
  country TEXT,
  contact_id INTEGER,
  campaign_id INTEGER,
  message TEXT,
  message_type TEXT,
  encoding TEXT,
  units INTEGER NOT NULL DEFAULT 1,
  segments INTEGER NOT NULL DEFAULT 1,
  status_code INTEGER,
  status_kind TEXT,
  status_text TEXT,
  cost REAL NOT NULL DEFAULT 0,
  cost_source TEXT NOT NULL DEFAULT 'rate_card',
  verified INTEGER,
  source TEXT NOT NULL DEFAULT 'app',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_tx_created ON transactions(created_at);
CREATE INDEX IF NOT EXISTS ix_tx_country ON transactions(country, created_at);
CREATE INDEX IF NOT EXISTS ix_tx_ref ON transactions(reference_id);
CREATE INDEX IF NOT EXISTS ix_tx_campaign ON transactions(campaign_id);
CREATE INDEX IF NOT EXISTS ix_tx_phone ON transactions(phone);

CREATE TABLE IF NOT EXISTS rates (
  id INTEGER PRIMARY KEY, product TEXT NOT NULL, country TEXT NOT NULL, price REAL NOT NULL,
  carrier_fee REAL NOT NULL DEFAULT 0, note TEXT, updated_at TEXT,
  UNIQUE(product, country)
);
CREATE TABLE IF NOT EXISTS fixed_costs (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other',
  amount REAL NOT NULL, frequency TEXT NOT NULL DEFAULT 'monthly', start_date TEXT NOT NULL, end_date TEXT, note TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE, country TEXT, first_name TEXT, last_name TEXT, email TEXT,
  tags TEXT NOT NULL DEFAULT '', custom TEXT NOT NULL DEFAULT '{}',
  consent_status TEXT NOT NULL DEFAULT 'unknown', consent_source TEXT, consent_at TEXT,
  opted_out_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppression (
  phone TEXT PRIMARY KEY, reason TEXT NOT NULL, source TEXT, note TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (id INTEGER PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, message_type TEXT NOT NULL DEFAULT 'MKT',
  sender_id TEXT, audience_tag TEXT, audience_countries TEXT, status TEXT NOT NULL DEFAULT 'draft',
  scheduled_at TEXT, rate_per_minute INTEGER NOT NULL DEFAULT 60, respect_quiet_hours INTEGER NOT NULL DEFAULT 1,
  total INTEGER NOT NULL DEFAULT 0, estimated_cost REAL NOT NULL DEFAULT 0,
  created_by TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS campaign_queue (
  id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', transaction_id INTEGER,
  UNIQUE(campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS ix_queue ON campaign_queue(campaign_id, status);

CREATE TABLE IF NOT EXISTS inbound (
  id INTEGER PRIMARY KEY, phone TEXT NOT NULL, country TEXT, body TEXT, reference_id TEXT, contact_id INTEGER,
  is_optout INTEGER NOT NULL DEFAULT 0, is_optin INTEGER NOT NULL DEFAULT 0, read INTEGER NOT NULL DEFAULT 0,
  replied INTEGER NOT NULL DEFAULT 0, received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS country_caps (country TEXT PRIMARY KEY, monthly_cap REAL);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, dedupe_key TEXT UNIQUE, level TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
  detail TEXT, country TEXT, created_at TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, user TEXT, action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);
`);

export const now = () => new Date().toISOString();

/** Run fn inside a transaction. */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

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
};

export function getSettings() {
  const rows = all('SELECT key, value FROM settings');
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  // Environment overrides (credentials kept out of the DB if preferred)
  if (process.env.TELESIGN_CUSTOMER_ID) s.telesign_customer_id = process.env.TELESIGN_CUSTOMER_ID;
  if (process.env.TELESIGN_API_KEY) s.telesign_api_key = process.env.TELESIGN_API_KEY;
  return s;
}

export function setSettings(obj) {
  const stmt = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  tx(() => {
    for (const [k, v] of Object.entries(obj)) {
      if (k in DEFAULT_SETTINGS) stmt.run(k, v === null || v === undefined ? '' : String(v));
    }
  });
}

export const listSetting = (s, key) => String(s[key] || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

export function audit(user, action, detail = '') {
  run('INSERT INTO audit_log(user, action, detail, created_at) VALUES(?,?,?,?)', user || 'system', action, typeof detail === 'string' ? detail : JSON.stringify(detail), now());
}
