// Opt-out / opt-in handling, suppression list and inbound replies.
import { get, run, now, getSettings, listSetting, audit } from './db.js';
import { parsePhone } from './pricing.js';

export function suppress(phone, reason = 'opt-out', source = 'manual', note = '') {
  const p = parsePhone(phone);
  if (!p) return false;
  run('INSERT INTO suppression(phone, reason, source, note, created_at) VALUES(?,?,?,?,?) ON CONFLICT(phone) DO NOTHING',
    p.e164, reason, source, note, now());
  run("UPDATE contacts SET consent_status = 'opted_out', opted_out_at = ? WHERE phone = ?", now(), p.e164);
  return true;
}

export function unsuppress(phone) {
  const p = parsePhone(phone);
  if (!p) return false;
  run('DELETE FROM suppression WHERE phone = ?', p.e164);
  run("UPDATE contacts SET consent_status = 'opted_in', opted_out_at = NULL, consent_source = 'keyword', consent_at = ? WHERE phone = ? AND consent_status = 'opted_out'", now(), p.e164);
  return true;
}

/** Process an inbound (MO) SMS: store it, apply STOP/START keywords. */
export function handleInbound({ phone, body, referenceId, receivedAt }) {
  const s = getSettings();
  const p = parsePhone(phone);
  const e164 = p?.e164 ?? String(phone);
  const word = String(body || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  const isOptout = listSetting(s, 'optout_keywords').includes(word);
  const isOptin = !isOptout && listSetting(s, 'optin_keywords').includes(word);
  const contact = get('SELECT id FROM contacts WHERE phone = ?', e164);
  run(`INSERT INTO inbound(phone, country, body, reference_id, contact_id, is_optout, is_optin, received_at) VALUES(?,?,?,?,?,?,?,?)`,
    e164, p?.country ?? null, body ?? '', referenceId ?? null, contact?.id ?? null, isOptout ? 1 : 0, isOptin ? 1 : 0, receivedAt || now());
  if (isOptout) {
    suppress(e164, 'opt-out', 'keyword', `Replied "${String(body).trim()}"`);
    audit('system', 'opt-out', `${e164} replied ${word}`);
  } else if (isOptin) {
    unsuppress(e164);
    audit('system', 'opt-in', `${e164} replied ${word}`);
  }
  return { isOptout, isOptin };
}
