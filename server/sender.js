// Central send path: every outbound request (campaigns, test sends, gateway API) goes through here so that
// suppression, geo permissions, spending limits, logging and costing are applied consistently.
import crypto from 'node:crypto';
import { get, run, now, getSettings } from './db.js';
import { analyzeSms } from '../shared/sms.js';
import { describeStatus } from '../shared/statusCodes.js';
import { parsePhone, estimateCost } from './pricing.js';
import { checkSend } from './spend.js';
import { createClient, extractPrice } from './telesign.js';

export const isLive = (s) => s.demo_mode !== '1' && !!s.telesign_customer_id && !!s.telesign_api_key;

export async function client(s) {
  s ??= await getSettings();
  return createClient({ customerId: s.telesign_customer_id, apiKey: s.telesign_api_key });
}

export async function isSuppressed(e164) {
  return !!(await get('SELECT 1 AS x FROM suppression WHERE phone = ?', e164));
}

async function insertTx(t) {
  const status = describeStatus(t.status_code);
  return get(
    `INSERT INTO transactions(reference_id, product, direction, phone, country, contact_id, campaign_id, message, message_type,
       encoding, units, segments, status_code, status_kind, status_text, cost, cost_source, verified, demo_code, source, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    t.reference_id ?? null, t.product, t.direction ?? 'out', t.phone ?? null, t.country ?? null, t.contact_id ?? null,
    t.campaign_id ?? null, t.message ?? null, t.message_type ?? null, t.encoding ?? null, t.units ?? 1, t.segments ?? 1,
    t.status_code ?? null, t.status_kind ?? status.kind, t.status_text ?? status.text, t.cost ?? 0, t.cost_source ?? 'rate_card',
    t.verified ?? null, t.demo_code ?? null, t.source ?? 'app', t.created_at ?? now(), now());
}

/**
 * Map a Telesign send response to transaction fields. Telesign can answer HTTP 200 with
 * status 500 "Transaction not attempted" plus an errors[] array (e.g. unverified trial number):
 * that is a failure and is not billed.
 */
function fromResponse(resp, est) {
  const code = resp.status?.code ?? 290;
  const errText = resp.errors?.find((e) => e.description)?.description;
  const notAttempted = code === 500 || code >= 10000;
  const price = extractPrice(resp);
  return {
    reference_id: resp.reference_id,
    status_code: code,
    status_kind: notAttempted ? 'failed' : undefined,
    status_text: errText ? `${resp.status?.description || 'Error'}: ${errText}` : resp.status?.description,
    cost: notAttempted ? 0 : price ?? est,
    cost_source: price !== null && !notAttempted ? 'telesign' : 'rate_card',
  };
}

const demoRef = () => 'DEMO' + crypto.randomBytes(12).toString('hex').toUpperCase();

function blocked(base, code, reason) {
  return insertTx({ ...base, status_code: code, status_kind: 'blocked', status_text: reason, cost: 0, segments: base.segments ?? 0 });
}

/** Send an SMS. Returns the stored transaction row. Never throws for business-rule blocks. */
export async function sendSms({ phone, message, messageType = 'ARN', senderId, campaignId, contactId, source = 'app' }) {
  const s = await getSettings();
  const parsed = parsePhone(phone);
  const info = analyzeSms(message);
  const base = { product: 'sms', phone: parsed?.e164 ?? String(phone), country: parsed?.country, message, message_type: messageType,
    encoding: info.encoding, segments: info.segments, campaign_id: campaignId, contact_id: contactId, source };
  if (!parsed) return blocked(base, 903, 'Invalid phone number');
  if (messageType !== 'OTP' && (await isSuppressed(parsed.e164))) return blocked(base, 900, 'Recipient opted out / suppressed');

  const est = await estimateCost('sms', parsed.country, { segments: info.segments });
  const check = await checkSend(parsed.country, est);
  if (!check.ok) return blocked(base, check.code, check.reason);

  if (!isLive(s)) return insertTx({ ...base, reference_id: demoRef(), status_code: 290, cost: est, source: source === 'app' ? 'demo' : source });

  try {
    const resp = await (await client(s)).sendSms({ phone: parsed.e164, message, messageType, senderId: senderId || s.default_sender_id || undefined });
    return insertTx({ ...base, ...fromResponse(resp, est) });
  } catch (e) {
    return insertTx({ ...base, status_code: 904, status_kind: 'failed', status_text: `Telesign error: ${e.message}`, cost: 0 });
  }
}

/** Send a verification code via the Verify product (SMS or voice). */
export async function sendVerify({ phone, code, channel = 'sms', source = 'gateway' }) {
  const s = await getSettings();
  const product = channel === 'voice' ? 'verify_voice' : 'verify_sms';
  const parsed = parsePhone(phone);
  const base = { product, phone: parsed?.e164 ?? String(phone), country: parsed?.country, message_type: 'OTP', segments: 1, source };
  if (!parsed) return blocked(base, 903, 'Invalid phone number');
  const est = await estimateCost(product, parsed.country);
  const check = await checkSend(parsed.country, est);
  if (!check.ok) return blocked(base, check.code, check.reason);

  const verifyCode = code || String(crypto.randomInt(100000, 999999));
  if (!isLive(s)) {
    // Demo: the code is stored so the check endpoint works across serverless instances.
    const row = await insertTx({ ...base, reference_id: demoRef(), status_code: 290, cost: est, verified: 0, demo_code: verifyCode });
    return { ...row, demo_code: verifyCode };
  }
  try {
    const c = await client(s);
    const resp = channel === 'voice' ? await c.sendVerifyCall({ phone: parsed.e164, code: verifyCode })
      : await c.sendVerifySms({ phone: parsed.e164, code: verifyCode });
    const r = fromResponse(resp, est);
    return insertTx({ ...base, ...r, verified: r.status_kind === 'failed' ? null : 0 });
  } catch (e) {
    return insertTx({ ...base, status_code: 904, status_kind: 'failed', status_text: `Telesign error: ${e.message}`, cost: 0 });
  }
}

/** Check a verification code. Marks the transaction verified on success (drives the conversion / pumping metrics). */
export async function checkVerifyCode(referenceId, code) {
  const row = await get("SELECT * FROM transactions WHERE reference_id = ? AND product LIKE 'verify_%'", referenceId);
  if (!row) return { ok: false, error: 'Unknown reference_id' };
  let valid = false;
  if (referenceId.startsWith('DEMO')) valid = !!row.demo_code && row.demo_code === String(code);
  else {
    const resp = await (await client()).checkVerify(referenceId, code);
    valid = resp?.verify?.code_state === 'VALID';
  }
  if (valid) await run('UPDATE transactions SET verified = 1, updated_at = ? WHERE id = ?', now(), row.id);
  return { ok: true, valid };
}

export async function markVerified(referenceId) {
  return (await run("UPDATE transactions SET verified = 1, updated_at = ? WHERE reference_id = ? AND product LIKE 'verify_%'", now(), referenceId)).changes;
}

/** Phone ID lookup (billed per lookup). */
export async function phoneIdLookup(phone, source = 'gateway') {
  const s = await getSettings();
  const parsed = parsePhone(phone);
  const base = { product: 'phoneid', phone: parsed?.e164 ?? String(phone), country: parsed?.country, segments: 0, source };
  if (!parsed) return { tx: await blocked(base, 903, 'Invalid phone number') };
  const est = await estimateCost('phoneid', parsed.country);
  const check = await checkSend(parsed.country, est);
  if (!check.ok) return { tx: await blocked(base, check.code, check.reason) };
  if (!isLive(s)) {
    return { tx: await insertTx({ ...base, reference_id: demoRef(), status_code: 300, status_kind: 'delivered', status_text: 'Lookup completed (demo)', cost: est }),
      result: { phone_type: { description: 'MOBILE' }, location: { country: { iso2: parsed.country } }, demo: true } };
  }
  const resp = await (await client(s)).phoneId(parsed.e164);
  const r = fromResponse(resp, est);
  return { tx: await insertTx({ ...base, ...r, status_kind: r.status_kind ?? 'delivered', status_text: r.status_text || 'Lookup completed' }), result: resp };
}

/** Apply a delivery report (callback or polled status) to a stored transaction. */
export async function applyStatus(referenceId, code, description) {
  const st = describeStatus(code);
  const res = await run('UPDATE transactions SET status_code = ?, status_kind = ?, status_text = ?, updated_at = ? WHERE reference_id = ?',
    code, st.kind, description || st.text, now(), referenceId);
  return res.changes > 0;
}
