import { Router } from 'express';
import { db, all, get, run, tx, now, audit, getSettings } from '../db.js';
import { requireAdmin } from '../auth.js';
import { txFilters, sendCsv, ah, int } from '../util.js';
import { analyzeSms, renderTemplate } from '../../shared/sms.js';
import { STATUS_ADVICE } from '../../shared/statusCodes.js';
import { parsePhone, estimateCost, round } from '../pricing.js';
import { countryAllowed, spendSince } from '../spend.js';
import { sendSms, sendVerify, phoneIdLookup, isLive } from '../sender.js';
import { suppress, unsuppress } from '../compliance.js';

const r = Router();

// ---------------- Message log ----------------
r.get('/messages', (req, res) => {
  const f = txFilters(req.query, { range: !req.query.all });
  const limit = Math.min(int(req.query.limit, 50), 500);
  const offset = int(req.query.offset, 0);
  const rows = all(`SELECT t.*, c.name AS campaign_name FROM transactions t LEFT JOIN campaigns c ON c.id = t.campaign_id
    ${f.sql.replace(/\b(created_at|product|country|status_kind|campaign_id|source|status_code|phone|message|reference_id)\b/g, 't.$1')}
    ORDER BY t.created_at DESC LIMIT ? OFFSET ?`, ...f.params, limit, offset);
  const total = get(`SELECT COUNT(*) AS n FROM transactions ${f.sql}`, ...f.params).n;
  res.json({ total, rows: rows.map((x) => ({ ...x, advice: STATUS_ADVICE[x.status_code] || null })) });
});

r.get('/messages/export.csv', (req, res) => {
  const f = txFilters(req.query);
  const rows = all(`SELECT created_at, reference_id, product, phone, country, message_type, encoding, segments, units, status_code, status_kind, status_text, cost, cost_source, verified, campaign_id, source, message
    FROM transactions ${f.sql} ORDER BY created_at DESC LIMIT 200000`, ...f.params);
  sendCsv(res, `messages_${new Date().toISOString().slice(0, 10)}.csv`, rows);
});

/** One-off send from the UI (quick send / test). */
r.post('/send', requireAdmin, ah(async (req, res) => {
  const { product = 'sms', phone, message, message_type = 'ARN' } = req.body || {};
  let out;
  if (product === 'sms') {
    if (!message) return res.status(400).json({ error: 'Message is required' });
    out = await sendSms({ phone, message, messageType: message_type, source: 'app' });
  } else if (product === 'verify_sms' || product === 'verify_voice') {
    out = await sendVerify({ phone, channel: product === 'verify_voice' ? 'voice' : 'sms', source: 'app' });
  } else if (product === 'phoneid') {
    const r2 = await phoneIdLookup(phone, 'app');
    out = { ...r2.tx, result: r2.result };
  } else return res.status(400).json({ error: 'Unsupported product' });
  audit(req.user.email, 'send', `${product} to ${out.phone}: ${out.status_text}`);
  res.json({ ...out, live: isLive() });
}));

// ---------------- Templates ----------------
r.get('/templates', (_req, res) => res.json(all('SELECT * FROM templates ORDER BY name')));
r.post('/templates', requireAdmin, (req, res) => {
  const { name, body } = req.body || {};
  if (!name || !body) return res.status(400).json({ error: 'Name and body are required' });
  const id = Number(run('INSERT INTO templates(name, body, created_at) VALUES(?,?,?)', name, body, now()).lastInsertRowid);
  res.json(get('SELECT * FROM templates WHERE id = ?', id));
});
r.put('/templates/:id', requireAdmin, (req, res) => {
  run('UPDATE templates SET name = ?, body = ? WHERE id = ?', req.body.name, req.body.body, req.params.id);
  res.json(get('SELECT * FROM templates WHERE id = ?', req.params.id));
});
r.delete('/templates/:id', requireAdmin, (req, res) => {
  run('DELETE FROM templates WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// ---------------- Campaigns ----------------
const list = (v) => String(v || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

/** Resolve the recipients of a campaign and the reasons others were excluded. */
function audience(c) {
  const s = getSettings();
  const where = [];
  const params = [];
  if (c.audience_tag) { where.push("(',' || tags || ',') LIKE ?"); params.push(`%,${c.audience_tag},%`); }
  const countries = list(c.audience_countries);
  if (countries.length) { where.push(`country IN (${countries.map(() => '?').join(',')})`); params.push(...countries); }
  const contacts = all(`SELECT c.*, (SELECT 1 FROM suppression s WHERE s.phone = c.phone) AS suppressed FROM contacts c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...params);
  const excluded = { opted_out: 0, no_consent: 0, country_blocked: 0 };
  const eligible = [];
  for (const ct of contacts) {
    if (ct.consent_status === 'opted_out' || ct.suppressed) excluded.opted_out++;
    else if (c.message_type === 'MKT' && ct.consent_status !== 'opted_in') excluded.no_consent++;
    else if (!countryAllowed(ct.country, s)) excluded.country_blocked++;
    else eligible.push(ct);
  }
  return { eligible, excluded, matched: contacts.length };
}

function renderFor(c, ct) {
  let custom = {};
  try { custom = JSON.parse(ct.custom || '{}'); } catch {}
  return renderTemplate(c.body, { ...custom, ...ct });
}

function preview(c) {
  const { eligible, excluded, matched } = audience(c);
  const byCountry = {};
  let segments = 0, cost = 0, unicode = 0, multi = 0;
  for (const ct of eligible) {
    const msg = renderFor(c, ct);
    const a = analyzeSms(msg);
    const est = estimateCost('sms', ct.country, { segments: a.segments });
    segments += a.segments;
    cost += est;
    if (a.encoding === 'UCS-2') unicode++;
    if (a.segments > 1) multi++;
    const k = ct.country || '??';
    byCountry[k] ??= { country: k, recipients: 0, segments: 0, cost: 0 };
    byCountry[k].recipients++;
    byCountry[k].segments += a.segments;
    byCountry[k].cost += est;
  }
  const s = getSettings();
  const monthSpend = spendSince(new Date().toISOString().slice(0, 7) + '-01');
  return {
    matched, recipients: eligible.length, excluded, segments, cost: round(cost, 2), unicode, multi_segment: multi,
    by_country: Object.values(byCountry).map((x) => ({ ...x, cost: round(x.cost, 2) })).sort((a, b) => b.cost - a.cost),
    samples: eligible.slice(0, 3).map((ct) => ({ phone: ct.phone, message: renderFor(c, ct) })),
    budget: { monthly: Number(s.monthly_budget) || 0, month_spend: round(monthSpend, 2), after: round(monthSpend + cost, 2) },
  };
}

const campaignStats = `
  SELECT c.*,
    (SELECT COUNT(*) FROM campaign_queue q WHERE q.campaign_id = c.id AND q.status = 'pending') AS pending,
    COUNT(t.id) AS sent,
    SUM(CASE WHEN t.status_kind = 'delivered' THEN 1 ELSE 0 END) AS delivered,
    SUM(CASE WHEN t.status_kind = 'failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN t.status_kind = 'blocked' THEN 1 ELSE 0 END) AS blocked,
    COALESCE(SUM(CASE WHEN t.status_kind != 'blocked' THEN t.cost END), 0) AS actual_cost,
    COALESCE(SUM(t.segments), 0) AS segments
  FROM campaigns c LEFT JOIN transactions t ON t.campaign_id = c.id`;

function withReplies(c) {
  if (!c.started_at) return { ...c, replies: 0, optouts: 0 };
  const end = c.completed_at ? new Date(Date.parse(c.completed_at) + 3 * 864e5).toISOString() : now();
  const row = get(`SELECT COUNT(*) AS replies, SUM(is_optout) AS optouts FROM inbound i
    WHERE i.received_at >= ? AND i.received_at <= ? AND i.phone IN (SELECT phone FROM transactions WHERE campaign_id = ?)`, c.started_at, end, c.id);
  return { ...c, actual_cost: round(c.actual_cost, 2), replies: row.replies || 0, optouts: row.optouts || 0 };
}

r.get('/campaigns', (_req, res) => {
  res.json(all(`${campaignStats} GROUP BY c.id ORDER BY COALESCE(c.scheduled_at, c.created_at) DESC`).map(withReplies));
});

r.get('/campaigns/:id', (req, res) => {
  const c = get(`${campaignStats} WHERE c.id = ? GROUP BY c.id`, req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const byCountry = all(`SELECT country, COUNT(*) AS n, SUM(cost) AS cost, SUM(CASE WHEN status_kind='delivered' THEN 1 ELSE 0 END) AS delivered,
    SUM(CASE WHEN status_kind='failed' THEN 1 ELSE 0 END) AS failed FROM transactions WHERE campaign_id = ? GROUP BY country ORDER BY n DESC`, c.id);
  res.json({ ...withReplies(c), by_country: byCountry });
});

const campaignFields = ['name', 'body', 'message_type', 'sender_id', 'audience_tag', 'audience_countries', 'scheduled_at', 'rate_per_minute', 'respect_quiet_hours'];

r.post('/campaigns', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.body) return res.status(400).json({ error: 'Name and message are required' });
  const id = Number(run(`INSERT INTO campaigns(name, body, message_type, sender_id, audience_tag, audience_countries, scheduled_at, rate_per_minute, respect_quiet_hours, created_by, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, b.name, b.body, b.message_type || 'MKT', b.sender_id || null, b.audience_tag || null, b.audience_countries || null,
    b.scheduled_at || null, int(b.rate_per_minute, 60), b.respect_quiet_hours === false ? 0 : 1, req.user.email, now()).lastInsertRowid);
  audit(req.user.email, 'campaign-create', b.name);
  res.json(get('SELECT * FROM campaigns WHERE id = ?', id));
});

r.put('/campaigns/:id', requireAdmin, (req, res) => {
  const c = get('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (!['draft', 'paused'].includes(c.status)) return res.status(409).json({ error: 'Only draft or paused campaigns can be edited' });
  const b = { ...c, ...req.body };
  run(`UPDATE campaigns SET name=?, body=?, message_type=?, sender_id=?, audience_tag=?, audience_countries=?, scheduled_at=?, rate_per_minute=?, respect_quiet_hours=? WHERE id=?`,
    ...campaignFields.map((k) => (k === 'respect_quiet_hours' ? (b[k] === false || b[k] === 0 ? 0 : 1) : k === 'rate_per_minute' ? int(b[k], 60) : b[k] || null)), c.id);
  res.json(get('SELECT * FROM campaigns WHERE id = ?', c.id));
});

r.delete('/campaigns/:id', requireAdmin, (req, res) => {
  const c = get('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  if (c && ['running'].includes(c.status)) return res.status(409).json({ error: 'Pause or cancel the campaign first' });
  run('DELETE FROM campaigns WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

r.post('/campaigns/:id/preview', (req, res) => {
  const c = get('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(preview(c));
});

/** Preview an unsaved campaign (used live by the editor). */
r.post('/campaigns/preview', (req, res) => res.json(preview({ message_type: 'MKT', ...req.body })));

r.post('/campaigns/:id/test', requireAdmin, ah(async (req, res) => {
  const c = get('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const phones = (req.body.phones || []).map(String).filter(Boolean).slice(0, 10);
  if (!phones.length) return res.status(400).json({ error: 'Add at least one test number' });
  const sample = get("SELECT * FROM contacts WHERE consent_status != 'opted_out' LIMIT 1") || {};
  const results = [];
  for (const phone of phones) {
    const message = '[TEST] ' + renderFor(c, { ...sample, phone });
    results.push(await sendSms({ phone, message, messageType: c.message_type, senderId: c.sender_id, source: 'test' }));
  }
  audit(req.user.email, 'campaign-test', `${c.name} -> ${phones.join(', ')}`);
  res.json(results);
}));

r.post('/campaigns/:id/launch', requireAdmin, (req, res) => {
  const c = get('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.status !== 'draft') return res.status(409).json({ error: `Campaign is ${c.status}` });
  const p = preview(c);
  if (!p.recipients) return res.status(400).json({ error: 'No eligible recipients' });
  const when = req.body.scheduled_at || c.scheduled_at || now();
  const { eligible } = audience(c);
  tx(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO campaign_queue(campaign_id, contact_id) VALUES(?, ?)');
    for (const ct of eligible) ins.run(c.id, ct.id);
    run("UPDATE campaigns SET status = 'scheduled', scheduled_at = ?, total = ?, estimated_cost = ? WHERE id = ?", when, eligible.length, p.cost, c.id);
  });
  audit(req.user.email, 'campaign-launch', `${c.name}: ${eligible.length} recipients, est. ${p.cost}`);
  res.json({ ok: true, recipients: eligible.length, scheduled_at: when });
});

const transition = (from, to, action) => (req, res) => {
  const c = get('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (!from.includes(c.status)) return res.status(409).json({ error: `Cannot ${action} a ${c.status} campaign` });
  run('UPDATE campaigns SET status = ?, note = NULL WHERE id = ?', to, c.id);
  if (to === 'cancelled') run("UPDATE campaign_queue SET status = 'cancelled' WHERE campaign_id = ? AND status = 'pending'", c.id);
  audit(req.user.email, `campaign-${action}`, c.name);
  res.json({ ok: true });
};
r.post('/campaigns/:id/pause', requireAdmin, transition(['running', 'scheduled'], 'paused', 'pause'));
r.post('/campaigns/:id/resume', requireAdmin, transition(['paused'], 'running', 'resume'));
r.post('/campaigns/:id/cancel', requireAdmin, transition(['running', 'scheduled', 'paused'], 'cancelled', 'cancel'));

// ---------------- Contacts ----------------
r.get('/contacts', (req, res) => {
  const where = [], params = [];
  if (req.query.q) { where.push('(phone LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR email LIKE ?)'); const l = `%${req.query.q}%`; params.push(l, l, l, l); }
  if (req.query.tag) { where.push("(',' || tags || ',') LIKE ?"); params.push(`%,${req.query.tag},%`); }
  if (req.query.consent) { where.push('consent_status = ?'); params.push(req.query.consent); }
  if (req.query.country) { where.push('country = ?'); params.push(req.query.country.toUpperCase()); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(int(req.query.limit, 50), 500), offset = int(req.query.offset, 0);
  res.json({
    total: get(`SELECT COUNT(*) AS n FROM contacts ${w}`, ...params).n,
    rows: all(`SELECT * FROM contacts ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset),
    summary: get(`SELECT COUNT(*) AS total, SUM(consent_status='opted_in') AS opted_in, SUM(consent_status='opted_out') AS opted_out, SUM(consent_status='unknown') AS unknown FROM contacts`),
  });
});

r.get('/contacts/tags', (_req, res) => {
  const counts = {};
  for (const { tags } of all("SELECT tags FROM contacts WHERE tags != ''")) for (const t of tags.split(',')) if (t) counts[t] = (counts[t] || 0) + 1;
  res.json(Object.entries(counts).map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n));
});

r.get('/contacts/export.csv', (_req, res) => {
  sendCsv(res, 'contacts_consent_records.csv', all('SELECT phone, country, first_name, last_name, email, tags, consent_status, consent_source, consent_at, opted_out_at, created_at FROM contacts ORDER BY created_at'));
});

/** Bulk import: rows already parsed client-side; columns mapped to known fields, everything else goes to `custom`. */
r.post('/contacts/import', requireAdmin, (req, res) => {
  const { rows = [], default_country, consent_status = 'unknown', consent_source = 'import', tags = '', update_existing = true } = req.body || {};
  const known = ['phone', 'first_name', 'last_name', 'email', 'tags', 'consent_status', 'consent_source', 'consent_at'];
  const stats = { inserted: 0, updated: 0, invalid: 0, suppressed: 0, invalid_rows: [] };
  const t = now();
  tx(() => {
    for (const [i, row] of rows.entries()) {
      const p = parsePhone(row.phone, default_country || undefined);
      if (!p) { stats.invalid++; if (stats.invalid_rows.length < 20) stats.invalid_rows.push({ row: i + 2, phone: row.phone }); continue; }
      const custom = Object.fromEntries(Object.entries(row).filter(([k]) => !known.includes(k)));
      const rowTags = [...new Set([...(row.tags || '').split(/[,;|]/), ...String(tags).split(',')].map((x) => x.trim().toLowerCase()).filter(Boolean))].join(',');
      const cs = ['opted_in', 'opted_out', 'unknown'].includes(row.consent_status) ? row.consent_status : consent_status;
      const existing = get('SELECT id FROM contacts WHERE phone = ?', p.e164);
      if (existing) {
        if (!update_existing) continue;
        run(`UPDATE contacts SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), email = COALESCE(?, email), tags = ?, custom = ?,
          consent_status = CASE WHEN consent_status = 'opted_out' THEN consent_status ELSE ? END WHERE id = ?`,
          row.first_name || null, row.last_name || null, row.email || null, rowTags, JSON.stringify(custom), cs, existing.id);
        stats.updated++;
      } else {
        run(`INSERT INTO contacts(phone, country, first_name, last_name, email, tags, custom, consent_status, consent_source, consent_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          p.e164, p.country, row.first_name || null, row.last_name || null, row.email || null, rowTags, JSON.stringify(custom), cs,
          row.consent_source || consent_source, cs === 'opted_in' ? (row.consent_at || t) : null, t);
        stats.inserted++;
      }
      if (cs === 'opted_out') { suppress(p.e164, 'opt-out', 'import'); stats.suppressed++; }
    }
  });
  audit(req.user.email, 'contacts-import', `${stats.inserted} new, ${stats.updated} updated, ${stats.invalid} invalid`);
  res.json(stats);
});

r.put('/contacts/:id', requireAdmin, (req, res) => {
  const c = get('SELECT * FROM contacts WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const b = { ...c, ...req.body };
  const consentChanged = b.consent_status !== c.consent_status;
  run(`UPDATE contacts SET first_name=?, last_name=?, email=?, tags=?, consent_status=?, consent_source=?, consent_at=?, opted_out_at=? WHERE id=?`,
    b.first_name, b.last_name, b.email, b.tags, b.consent_status, consentChanged ? 'manual' : b.consent_source,
    consentChanged && b.consent_status === 'opted_in' ? now() : b.consent_at, b.consent_status === 'opted_out' ? (c.opted_out_at || now()) : null, c.id);
  if (consentChanged && b.consent_status === 'opted_out') suppress(c.phone, 'opt-out', 'manual', `by ${req.user.email}`);
  if (consentChanged && c.consent_status === 'opted_out') unsuppress(c.phone);
  if (consentChanged) audit(req.user.email, 'consent-change', `${c.phone}: ${c.consent_status} -> ${b.consent_status}`);
  res.json(get('SELECT * FROM contacts WHERE id = ?', c.id));
});

r.delete('/contacts/:id', requireAdmin, (req, res) => {
  const c = get('SELECT phone FROM contacts WHERE id = ?', req.params.id);
  run('DELETE FROM contacts WHERE id = ?', req.params.id);
  if (c) audit(req.user.email, 'contact-delete', c.phone);
  res.json({ ok: true });
});

// ---------------- Suppression list ----------------
r.get('/suppression', (req, res) => {
  const q = req.query.q ? `%${req.query.q}%` : '%';
  res.json(all('SELECT * FROM suppression WHERE phone LIKE ? ORDER BY created_at DESC LIMIT 1000', q));
});
r.get('/suppression/export.csv', (_req, res) => sendCsv(res, 'suppression_list.csv', all('SELECT * FROM suppression ORDER BY created_at')));
r.post('/suppression', requireAdmin, (req, res) => {
  const phones = Array.isArray(req.body.phones) ? req.body.phones : [req.body.phone];
  let added = 0, invalid = 0;
  for (const p of phones) suppress(p, req.body.reason || 'manual', 'manual', req.body.note || `by ${req.user.email}`) ? added++ : invalid++;
  audit(req.user.email, 'suppression-add', `${added} numbers`);
  res.json({ added, invalid });
});
r.delete('/suppression/:phone', requireAdmin, (req, res) => {
  unsuppress(req.params.phone);
  audit(req.user.email, 'suppression-remove', req.params.phone);
  res.json({ ok: true });
});

// ---------------- Inbox ----------------
r.get('/inbox', (req, res) => {
  const filter = req.query.filter || 'all';
  const cond = filter === 'unread' ? 'HAVING unread > 0' : filter === 'optout' ? 'HAVING optouts > 0' : '';
  res.json(all(`SELECT i.phone, MAX(i.country) AS country, MAX(i.received_at) AS last_at, COUNT(*) AS n, SUM(1 - i.read) AS unread, SUM(i.is_optout) AS optouts,
      (SELECT body FROM inbound j WHERE j.phone = i.phone ORDER BY received_at DESC LIMIT 1) AS last_body,
      (SELECT first_name || ' ' || COALESCE(last_name, '') FROM contacts c WHERE c.phone = i.phone) AS name,
      (SELECT 1 FROM suppression s WHERE s.phone = i.phone) AS suppressed
    FROM inbound i GROUP BY i.phone ${cond} ORDER BY last_at DESC LIMIT 300`));
});

r.get('/inbox/:phone', (req, res) => {
  const phone = req.params.phone;
  const inbound = all("SELECT 'in' AS dir, body, received_at AS at, is_optout FROM inbound WHERE phone = ?", phone);
  const outbound = all("SELECT 'out' AS dir, message AS body, created_at AS at, status_kind, status_text, cost FROM transactions WHERE phone = ? AND product = 'sms' ORDER BY created_at DESC LIMIT 100", phone);
  run('UPDATE inbound SET read = 1 WHERE phone = ?', phone);
  res.json({
    phone, contact: get('SELECT * FROM contacts WHERE phone = ?', phone) || null,
    suppressed: !!get('SELECT 1 AS x FROM suppression WHERE phone = ?', phone),
    messages: [...inbound, ...outbound].sort((a, b) => a.at.localeCompare(b.at)),
  });
});

r.post('/inbox/:phone/reply', requireAdmin, ah(async (req, res) => {
  if (!req.body.message) return res.status(400).json({ error: 'Message is required' });
  const out = await sendSms({ phone: req.params.phone, message: req.body.message, messageType: 'ARN', source: 'reply' });
  run('UPDATE inbound SET replied = 1 WHERE phone = ?', req.params.phone);
  res.json(out);
}));

export default r;
