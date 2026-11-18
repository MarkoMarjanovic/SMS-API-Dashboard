import { Router } from 'express';
import crypto from 'node:crypto';
import { get, getSettings } from '../db.js';
import { requireApiToken } from '../auth.js';
import { sendSms, sendVerify, checkVerifyCode, markVerified, phoneIdLookup, applyStatus } from '../sender.js';
import { handleInbound } from '../compliance.js';
import { verifyCallbackSignature } from '../telesign.js';
import { tick } from '../scheduler.js';

// ---------------- Gateway: your own systems send through the dashboard so every request is tracked & controlled ----------------
export const gateway = Router();
gateway.use(requireApiToken);

const view = (t) => ({
  id: t.id, reference_id: t.reference_id, product: t.product, phone: t.phone, country: t.country, segments: t.segments, encoding: t.encoding,
  status: { code: t.status_code, kind: t.status_kind, description: t.status_text }, cost: t.cost, created_at: t.created_at,
  ...(t.demo_code ? { demo_code: t.demo_code } : {}),
});

gateway.post('/sms', async (req, res) => {
  const { phone_number, phone, message, message_type = 'ARN', sender_id } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });
  const t = await sendSms({ phone: phone_number || phone, message, messageType: message_type, senderId: sender_id, source: 'gateway' });
  res.status(t.status_kind === 'blocked' ? 422 : 200).json(view(t));
});

gateway.post('/verify', async (req, res) => {
  const { phone_number, phone, channel = 'sms', verify_code } = req.body || {};
  const t = await sendVerify({ phone: phone_number || phone, channel, code: verify_code, source: 'gateway' });
  res.status(t.status_kind === 'blocked' ? 422 : 200).json(view(t));
});

gateway.post('/verify/:ref/check', async (req, res) => res.json(await checkVerifyCode(req.params.ref, req.body.verify_code ?? req.body.code)));

/** If your app validates codes itself, report successful verifications here so conversion / fraud metrics stay accurate. */
gateway.post('/verify/:ref/complete', async (req, res) => res.json({ updated: await markVerified(req.params.ref) }));

gateway.post('/phoneid', async (req, res) => {
  const out = await phoneIdLookup(req.body.phone_number || req.body.phone, 'gateway');
  res.json({ ...view(out.tx), result: out.result ?? null });
});

gateway.get('/messages/:ref', async (req, res) => {
  const t = await get('SELECT * FROM transactions WHERE reference_id = ?', req.params.ref);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(view(t));
});

// ---------------- Telesign callbacks: delivery reports + inbound (MO) messages ----------------
export const callbacks = Router();

callbacks.post('/telesign', async (req, res) => {
  const s = await getSettings();
  if (s.require_callback_signature === '1') {
    const ok = verifyCallbackSignature(req.rawBody || Buffer.from(''), req.headers.authorization, s.telesign_customer_id, s.telesign_api_key);
    if (!ok) return res.status(401).json({ error: 'Invalid signature' });
  }
  const b = req.body || {};
  const mo = b.user_response || b.mo || (b.mo_message ? b : null);
  if (mo && (mo.mo_message !== undefined || mo.message !== undefined)) {
    await handleInbound({ phone: mo.phone_number || b.phone_number || mo.from, body: mo.mo_message ?? mo.message, referenceId: b.reference_id, receivedAt: b.status?.updated_on });
    return res.json({ ok: true, type: 'inbound' });
  }
  if (b.reference_id && b.status?.code !== undefined) {
    const found = await applyStatus(b.reference_id, Number(b.status.code), b.status.description);
    return res.json({ ok: true, type: 'status', matched: found });
  }
  res.status(400).json({ error: 'Unrecognized callback payload' });
});

// ---------------- Background work trigger (Vercel Cron / external pinger) ----------------
export const cron = Router();

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Authorized by `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends this automatically) or `?key=$CRON_SECRET`. */
cron.all('/tick', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.key || '';
  if (!secret || !safeEqual(given, secret)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ ok: true, ...(await tick({ budgetMs: 240000 })) }); // function maxDuration is 300s
});
