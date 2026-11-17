// Integration tests against an isolated temp database.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tsd-test-'));
let m;
before(async () => {
  m = {
    db: await import('../server/db.js'),
    pricing: await import('../server/pricing.js'),
    sender: await import('../server/sender.js'),
    compliance: await import('../server/compliance.js'),
    spend: await import('../server/spend.js'),
    telesign: await import('../server/telesign.js'),
  };
  m.db.setSettings({ demo_mode: '1', monthly_budget: '1', daily_budget: '0', hard_stop: '1' });
  m.db.run("INSERT INTO rates(product, country, price, carrier_fee) VALUES('sms','US',0.008,0.002),('sms','*',0.05,0)");
  m.pricing.invalidateRates();
});

test('phone parsing detects country', () => {
  assert.deepEqual(m.pricing.parsePhone('+14155550123'), { e164: '+14155550123', country: 'US' });
  assert.equal(m.pricing.parsePhone('14155550123').country, 'US');
  assert.equal(m.pricing.parsePhone('+447700900123').country, 'GB');
  assert.equal(m.pricing.parsePhone('abc'), null);
});

test('cost = rate incl. carrier fee x segments', () => {
  assert.equal(m.pricing.estimateCost('sms', 'US', { segments: 2 }), 0.02);
  assert.equal(m.pricing.estimateCost('sms', 'DE', { segments: 1 }), 0.05); // default row
});

test('demo send is logged and costed', async () => {
  const t = await m.sender.sendSms({ phone: '+14155550123', message: 'hi' });
  assert.equal(t.status_kind, 'pending');
  assert.equal(t.cost, 0.01);
  assert.equal(t.country, 'US');
});

test('STOP reply suppresses the number and blocks later sends', async () => {
  m.compliance.handleInbound({ phone: '+14155550199', body: ' stop ' });
  const t = await m.sender.sendSms({ phone: '+14155550199', message: 'promo', messageType: 'MKT' });
  assert.equal(t.status_code, 900);
  const otp = await m.sender.sendSms({ phone: '+14155550199', message: 'code 1234', messageType: 'OTP' });
  assert.notEqual(otp.status_code, 900, 'OTP still allowed');
  m.compliance.handleInbound({ phone: '+14155550199', body: 'START' });
  const again = await m.sender.sendSms({ phone: '+14155550199', message: 'promo', messageType: 'MKT' });
  assert.notEqual(again.status_code, 900);
});

test('blocked country is refused', async () => {
  m.db.setSettings({ blocked_countries: 'KG' });
  const t = await m.sender.sendSms({ phone: '+996555123456', message: 'x' });
  assert.equal(t.status_code, 902);
  m.db.setSettings({ blocked_countries: '' });
});

test('hard stop blocks sends over the monthly budget', async () => {
  m.db.setSettings({ monthly_budget: '0.03' });
  let last;
  for (let i = 0; i < 6; i++) last = await m.sender.sendSms({ phone: '+14155550123', message: 'hi' });
  assert.equal(last.status_code, 901);
  m.db.setSettings({ monthly_budget: '1000' });
});

test('callback signature verification', () => {
  const key = Buffer.from('secret-key').toString('base64');
  const body = Buffer.from('{"a":1}');

  const sig = crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(body).digest('base64');
  assert.ok(m.telesign.verifyCallbackSignature(body, `TSA CID:${sig}`, 'CID', key));
  assert.ok(!m.telesign.verifyCallbackSignature(body, `TSA CID:${sig}x`, 'CID', key));
});

