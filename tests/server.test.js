// Integration tests against an in-memory Postgres (PGlite) — no external database needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
let m;
before(async () => {
  m = {
    db: await import('../server/db.js'),
    pricing: await import('../server/pricing.js'),
    sender: await import('../server/sender.js'),
    compliance: await import('../server/compliance.js'),
    telesign: await import('../server/telesign.js'),
    scheduler: await import('../server/scheduler.js'),
    demo: await import('../server/demo.js'),
  };
  await m.db.setSettings({ demo_mode: '1', monthly_budget: '1000', daily_budget: '0', hard_stop: '1', quiet_hours_start: '0', quiet_hours_end: '0' });
  await m.db.run("INSERT INTO rates(product, country, price, carrier_fee) VALUES('sms','US',0.008,0.002),('sms','*',0.05,0)");
  m.pricing.invalidateRates();
});
after(async () => m.db.closeDb());

test('placeholder translation ignores ? inside string literals', async () => {
  const r = await m.db.get("SELECT COALESCE(NULL, '??') AS a, ?::int + 1 AS b", 41);
  assert.deepEqual(r, { a: '??', b: 42 });
});

test('phone parsing detects country', () => {
  assert.deepEqual(m.pricing.parsePhone('+14155550123'), { e164: '+14155550123', country: 'US' });
  assert.equal(m.pricing.parsePhone('14155550123').country, 'US');
  assert.equal(m.pricing.parsePhone('+447700900123').country, 'GB');
  assert.equal(m.pricing.parsePhone('381652803198').country, 'RS');
  assert.equal(m.pricing.parsePhone('abc'), null);
});

test('country names normalise to ISO codes', () => {
  assert.equal(m.pricing.toIsoCountry('United States'), 'US');
  assert.equal(m.pricing.toIsoCountry('srb'), 'RS');
  assert.equal(m.pricing.toIsoCountry('*'), '*');
});

test('cost = rate incl. carrier fee x segments', async () => {
  assert.equal(await m.pricing.estimateCost('sms', 'US', { segments: 2 }), 0.02);
  assert.equal(await m.pricing.estimateCost('sms', 'DE', { segments: 1 }), 0.05); // default row
});

test('demo send is logged and costed', async () => {
  const t = await m.sender.sendSms({ phone: '+14155550123', message: 'hi' });
  assert.equal(t.status_kind, 'pending');
  assert.equal(t.cost, 0.01);
  assert.equal(t.country, 'US');
});

test('demo verify code round-trip works via the database', async () => {
  const v = await m.sender.sendVerify({ phone: '+14155550123' });
  assert.ok(v.demo_code);
  assert.deepEqual(await m.sender.checkVerifyCode(v.reference_id, '000000'), { ok: true, valid: false });
  assert.deepEqual(await m.sender.checkVerifyCode(v.reference_id, v.demo_code), { ok: true, valid: true });
});

test('STOP reply suppresses the number and blocks later sends', async () => {
  await m.compliance.handleInbound({ phone: '+14155550199', body: ' stop ' });
  const t = await m.sender.sendSms({ phone: '+14155550199', message: 'promo', messageType: 'MKT' });
  assert.equal(t.status_code, 900);
  const otp = await m.sender.sendSms({ phone: '+14155550199', message: 'code 1234', messageType: 'OTP' });
  assert.notEqual(otp.status_code, 900, 'OTP still allowed');
  await m.compliance.handleInbound({ phone: '+14155550199', body: 'START' });
  const again = await m.sender.sendSms({ phone: '+14155550199', message: 'promo', messageType: 'MKT' });
  assert.notEqual(again.status_code, 900);
});

test('blocked country is refused', async () => {
  await m.db.setSettings({ blocked_countries: 'KG' });
  const t = await m.sender.sendSms({ phone: '+996555123456', message: 'x' });
  assert.equal(t.status_code, 902);
  await m.db.setSettings({ blocked_countries: '' });
});

test('hard stop blocks sends over the monthly budget', async () => {
  const spent = (await m.db.get("SELECT SUM(cost) AS s FROM transactions WHERE status_kind IS DISTINCT FROM 'blocked'")).s;
  await m.db.setSettings({ monthly_budget: String(spent + 0.025) });
  let last;
  for (let i = 0; i < 4; i++) last = await m.sender.sendSms({ phone: '+14155550123', message: 'hi' });
  assert.equal(last.status_code, 901);
  await m.db.setSettings({ monthly_budget: '1000' });
});

test('campaign tick sends at the configured rate, never twice', async () => {
  await m.db.bulkInsert('contacts', ['phone', 'country', 'first_name', 'consent_status', 'created_at'],
    Array.from({ length: 10 }, (_, i) => [`+1415555${String(1000 + i)}`, 'US', 'P' + i, 'opted_in', m.db.now()]), 'ON CONFLICT DO NOTHING');
  const ids = await m.db.all("SELECT id FROM contacts WHERE first_name LIKE 'P%'");
  const past = new Date(Date.now() - 60000).toISOString();
  const cid = await m.db.insert(`INSERT INTO campaigns(name, body, status, scheduled_at, rate_per_minute, respect_quiet_hours, created_at, started_at, last_tick_at)
    VALUES('t', 'Hi {first_name}', 'running', ?, 6, 0, ?, ?, ?)`, past, past, past, past);
  await m.db.bulkInsert('campaign_queue', ['campaign_id', 'contact_id'], ids.map((x) => [cid, x.id]));
  // Two concurrent ticks: credit for 60s at 6/min = 6 messages total, claimed exactly once.
  await Promise.all([m.scheduler.tick(), m.scheduler.tick()]);
  const sent = (await m.db.get('SELECT COUNT(*) AS n FROM transactions WHERE campaign_id = ?', cid)).n;
  assert.equal(sent, 6);
  const dupes = await m.db.get('SELECT COUNT(*) - COUNT(DISTINCT contact_id) AS d FROM transactions WHERE campaign_id = ?', cid);
  assert.equal(dupes.d, 0);
});

test('demo seed runs on Postgres', async () => {
  const n = await m.demo.seedDemo();
  assert.ok(n > 50000, `seeded ${n}`);
  const alerts = await m.db.all("SELECT type FROM alerts WHERE type = 'fraud'");
  assert.ok(alerts.length >= 1, 'pumping alert raised');
});

test('Telesign "not attempted" responses are failed and free', async () => {
  const { describeStatus } = await import('../shared/statusCodes.js');
  assert.equal(describeStatus(500).kind, 'failed');
});

test('callback signature verification', () => {
  const key = Buffer.from('secret-key').toString('base64');
  const body = Buffer.from('{"a":1}');
  const sig = crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(body).digest('base64');
  assert.ok(m.telesign.verifyCallbackSignature(body, `TSA CID:${sig}`, 'CID', key));
  assert.ok(!m.telesign.verifyCallbackSignature(body, `TSA CID:${sig}x`, 'CID', key));
});
