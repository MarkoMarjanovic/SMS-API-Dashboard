// Background jobs: campaign sending (rate-limited), demo delivery simulation, status polling, alert evaluation.
import { all, get, run, now, getSettings } from './db.js';
import { renderTemplate } from '../shared/sms.js';
import { sendSms, isLive, client, applyStatus } from './sender.js';
import { evaluateAlerts } from './spend.js';

const TICK_MS = 5000;
const credit = new Map(); // campaignId -> fractional send allowance
let busy = false;

export function inQuietHours(s = getSettings(), date = new Date()) {
  const start = Number(s.quiet_hours_start), end = Number(s.quiet_hours_end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  const h = date.getHours();
  return start > end ? h >= start || h < end : h >= start && h < end;
}

async function runCampaigns() {
  const s = getSettings();
  const t = now();
  for (const c of all("SELECT * FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ?", t))
    run("UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?", t, c.id);

  for (const c of all("SELECT * FROM campaigns WHERE status = 'running'")) {
    if (c.respect_quiet_hours && inQuietHours(s)) continue;
    const allowance = (credit.get(c.id) || 0) + (c.rate_per_minute * TICK_MS) / 60000;
    const n = Math.floor(allowance);
    credit.set(c.id, allowance - n);
    if (n < 1) continue;
    const items = all(
      `SELECT q.id AS qid, ct.* FROM campaign_queue q JOIN contacts ct ON ct.id = q.contact_id
       WHERE q.campaign_id = ? AND q.status = 'pending' ORDER BY q.id LIMIT ?`, c.id, n);
    if (!items.length) {
      run("UPDATE campaigns SET status = 'completed', completed_at = ? WHERE id = ?", now(), c.id);
      credit.delete(c.id);
      continue;
    }
    for (const ct of items) {
      let custom = {};
      try { custom = JSON.parse(ct.custom || '{}'); } catch {}
      const message = renderTemplate(c.body, { ...custom, ...ct });
      const txRow = await sendSms({ phone: ct.phone, message, messageType: c.message_type, senderId: c.sender_id, campaignId: c.id, contactId: ct.id, source: 'campaign' });
      run('UPDATE campaign_queue SET status = ?, transaction_id = ? WHERE id = ?', txRow.status_kind === 'blocked' ? 'skipped' : 'sent', txRow.id, ct.qid);
      if (txRow.status_code === 901) {
        run("UPDATE campaigns SET status = 'paused', note = ? WHERE id = ?", `Auto-paused: ${txRow.status_text}`, c.id);
        // Put the recipient back so a resumed campaign retries it.
        run("UPDATE campaign_queue SET status = 'pending', transaction_id = NULL WHERE id = ?", ct.qid);
        run('DELETE FROM transactions WHERE id = ?', txRow.id);
        break;
      }
    }
  }
}

/** Demo mode: resolve pending demo messages to a final delivery status after a few seconds. */
function simulateDemoDelivery() {
  const cutoff = new Date(Date.now() - 4000).toISOString();
  const rows = all("SELECT id, reference_id, country FROM transactions WHERE status_kind = 'pending' AND reference_id LIKE 'DEMO%' AND created_at < ? LIMIT 500", cutoff);
  const failCodes = [210, 211, 220, 221, 230];
  for (const r of rows) {
    const p = Math.random();
    const code = p < 0.93 ? 200 : p < 0.96 ? 203 : failCodes[Math.floor(Math.random() * failCodes.length)];
    applyStatus(r.reference_id, code);
  }
}

/** Live mode fallback when callbacks are not configured: poll messages still pending after 2 minutes. */
async function pollLiveStatuses() {
  const s = getSettings();
  if (!isLive(s)) return;
  const older = new Date(Date.now() - 120000).toISOString();
  const newer = new Date(Date.now() - 3 * 864e5).toISOString();
  const rows = all(
    `SELECT reference_id FROM transactions WHERE status_kind = 'pending' AND product = 'sms' AND reference_id IS NOT NULL
     AND reference_id NOT LIKE 'DEMO%' AND created_at < ? AND created_at > ? AND (updated_at IS NULL OR updated_at < ?) LIMIT 20`, older, newer, older);
  const c = client(s);
  for (const r of rows) {
    try {
      const resp = await c.smsStatus(r.reference_id);
      if (resp?.status?.code) applyStatus(r.reference_id, resp.status.code, resp.status.description);
      else run('UPDATE transactions SET updated_at = ? WHERE reference_id = ?', now(), r.reference_id);
    } catch (e) {
      run('UPDATE transactions SET updated_at = ? WHERE reference_id = ?', now(), r.reference_id);
    }
  }
}

let lastAlertEval = 0;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    await runCampaigns();
    simulateDemoDelivery();
    await pollLiveStatuses();
    if (Date.now() - lastAlertEval > 60000) {
      lastAlertEval = Date.now();
      evaluateAlerts();
    }
  } catch (e) {
    console.error('Scheduler error:', e);
  } finally {
    busy = false;
  }
}

export function startScheduler() {
  setInterval(tick, TICK_MS).unref?.();
  setTimeout(tick, 1000);
}

