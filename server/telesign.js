// Minimal Telesign REST client (Basic auth: Customer ID + API key).
// Docs: https://developer.telesign.com — endpoints used:
//   POST /v1/messaging              send SMS
//   GET  /v1/messaging/{ref}        SMS status
//   POST /v1/verify/sms             send SMS verification code
//   GET  /v1/verify/{ref}?verify_code=  check a code
//   POST /v1/verify/call            voice verification
//   POST /v1/phoneid/{phone}        Phone ID lookup
import crypto from 'node:crypto';

export class TelesignError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function digitsOnly(phone) {
  return String(phone || '').replace(/\D/g, '');
}

export function createClient({ customerId, apiKey, baseUrl }) {
  const base = (baseUrl || process.env.TELESIGN_BASE_URL || 'https://rest-api.telesign.com').replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(`${customerId}:${apiKey}`).toString('base64');

  async function call(method, path, params) {
    const headers = { Authorization: auth, Accept: 'application/json', 'User-Agent': 'telesign-usage-dashboard/1.0' };
    let url = base + path;
    let body;
    if (params && method === 'GET') url += '?' + new URLSearchParams(params);
    else if (params) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    }
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok && !(json && json.status && json.reference_id)) {
      const msg = json?.status?.description || json?.errors?.[0]?.description || `HTTP ${res.status}`;
      throw new TelesignError(msg, res.status, json);
    }
    return json;
  }

  return {
    sendSms: ({ phone, message, messageType = 'ARN', senderId }) =>
      call('POST', '/v1/messaging', { phone_number: digitsOnly(phone), message, message_type: messageType, sender_id: senderId }),
    smsStatus: (ref) => call('GET', `/v1/messaging/${encodeURIComponent(ref)}`),
    sendVerifySms: ({ phone, code, template }) =>
      call('POST', '/v1/verify/sms', { phone_number: digitsOnly(phone), verify_code: code, template }),
    checkVerify: (ref, code) => call('GET', `/v1/verify/${encodeURIComponent(ref)}`, { verify_code: code }),
    sendVerifyCall: ({ phone, code }) => call('POST', '/v1/verify/call', { phone_number: digitsOnly(phone), verify_code: code }),
    phoneId: (phone) => call('POST', `/v1/phoneid/${digitsOnly(phone)}`, {}),
  };
}

/** Telesign responses may include a price; use it when present, otherwise the rate card applies. */
export function extractPrice(resp) {
  const candidates = [resp?.additional_info?.price, resp?.price, resp?.additional_info?.cost];
  for (const c of candidates) {
    const n = Number(c);
    if (c !== undefined && c !== null && c !== '' && Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Verify a Telesign callback signature. Telesign signs callbacks with
 * Authorization: "TSA <customer_id>:<base64 HMAC-SHA256(body, base64-decoded api key)>".
 */
export function verifyCallbackSignature(rawBody, authHeader, customerId, apiKey) {
  if (!authHeader || !authHeader.startsWith('TSA ')) return false;
  const [cid, sig] = authHeader.slice(4).split(':');
  if (!sig || cid !== customerId) return false;
  const expected = crypto.createHmac('sha256', Buffer.from(apiKey, 'base64')).update(rawBody).digest('base64');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
