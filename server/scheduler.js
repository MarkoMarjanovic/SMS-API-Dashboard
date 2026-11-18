// Background work as short, idempotent "ticks" so it runs both as a local interval and on serverless
// (Vercel Cron / an external pinger / the open dashboard calling /api/tick).
// All state lives in the database: campaign send credit, queue claims (FOR UPDATE SKIP LOCKED), last alert run.
import { all, get, run, now, getSettings, setSettings } from './db.js';
import { renderTemplate } from '../shared/sms.js';
import { sendSms, isLive, client, applyStatus } from './sender.js';
import { evaluateAlerts } from './spend.js';

export function inQuietHours(s, date = new Date()) {
  const start = Number(s.quiet_hours_start), end = Number(s.quiet_hours_end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  const h = date.getHours();
  return start > end ? h >= start || h < end : h >= start && h < end;
}

const MAX_BATCH = 2000; // per campaign per tick (the tick's time budget is the real limit)
// Credit may accumulate for up to this many minutes, so infrequent ticks (e.g. a 15-minute cron that keeps
// a free-tier database within its compute allowance) still achieve the campaign's configured rate.
const MAX_CATCHUP_MINUTES = 15;

async function runCampaigns(deadline) {
  const s = await getSettings();
  const t = now();
  await run("UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, ?), last_tick_at = COALESCE(last_tick_at, ?) WHERE status = 'scheduled' AND scheduled_at <= ?", t, t, t);
  // Recover rows claimed by an instance that died mid-batch.
  const stale = new Date(Date.now() - 5 * 60e3).toISOString();
  await run("UPDATE campaign_queue SET status = 'pending' WHERE status = 'sending' AND campaign_id IN (SELECT id FROM campaigns WHERE last_tick_at < ?)", stale);

  let sent = 0;
  for (const c of await all("SELECT * FROM campaigns WHERE status = 'running'")) {
    if (Date.now() > deadline) break;
    const tickAt = now();
    if (c.respect_quiet_hours && inQuietHours(s)) {
      await run('UPDATE campaigns SET last_tick_at = ?, send_credit = 0 WHERE id = ?', tickAt, c.id);
      continue;
    }
    // Credit accrues with elapsed time at rate_per_minute, capped at MAX_CATCHUP_MINUTES' worth.
    const elapsed = Math.max(0, Date.parse(tickAt) - Date.parse(c.last_tick_at || c.started_at || tickAt));
    const credit = Math.min(c.send_credit + (c.rate_per_minute * elapsed) / 60000, Math.max(c.rate_per_minute * MAX_CATCHUP_MINUTES, 1));
    const n = Math.min(Math.floor(credit), MAX_BATCH);
    // Optimistic lock: only one concurrent tick may advance this campaign.
    const upd = await run('UPDATE campaigns SET last_tick_at = ?, send_credit = ? WHERE id = ? AND last_tick_at IS NOT DISTINCT FROM ?',
      tickAt, credit - n, c.id, c.last_tick_at);
    if (!upd.changes) continue;

    if (n > 0) {
      const claimed = await all(
        `UPDATE campaign_queue SET status = 'sending' WHERE id IN (
           SELECT id FROM campaign_queue WHERE campaign_id = ? AND status = 'pending' ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED)
         RETURNING id, contact_id`, c.id, n);
      for (let i = 0; i < claimed.length; i++) {
        const q = claimed[i];
        if (Date.now() > deadline) {
          await run(`UPDATE campaign_queue SET status = 'pending' WHERE id IN (${claimed.slice(i).map((x) => x.id).join(',')})`);
          break;
        }
        const ct = await get('SELECT * FROM contacts WHERE id = ?', q.contact_id);
        if (!ct) { await run("UPDATE campaign_queue SET status = 'skipped' WHERE id = ?", q.id); continue; }
        let custom = {};
        try { custom = JSON.parse(ct.custom || '{}'); } catch {}
        const message = renderTemplate(c.body, { ...custom, ...ct });
        const txRow = await sendSms({ phone: ct.phone, message, messageType: c.message_type, senderId: c.sender_id, campaignId: c.id, contactId: ct.id, source: 'campaign' });
        if (txRow.status_code === 901) {
          // Budget reached: undo this record, return the rest of the batch to the queue and pause.
          await run('DELETE FROM transactions WHERE id = ?', txRow.id);
          await run(`UPDATE campaign_queue SET status = 'pending' WHERE id IN (${claimed.slice(i).map((x) => x.id).join(',')})`);
          await run("UPDATE campaigns SET status = 'paused', note = ? WHERE id = ?", `Auto-paused: ${txRow.status_text}`, c.id);
          break;
        }
        await run('UPDATE campaign_queue SET status = ?, transaction_id = ? WHERE id = ?', txRow.status_kind === 'blocked' ? 'skipped' : 'sent', txRow.id, q.id);
        sent++;
      }
    }
    const left = await get("SELECT COUNT(*) AS n FROM campaign_queue WHERE campaign_id = ? AND status IN ('pending','sending')", c.id);
    if (!left.n) await run("UPDATE campaigns SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'running'", now(), c.id);
  }
  return sent;
}

/** Demo mode: resolve pending demo messages to a final delivery status after a few seconds. */
async function simulateDemoDelivery() {
  const cutoff = new Date(Date.now() - 4000).toISOString();
  const rows = await all("SELECT reference_id FROM transactions WHERE status_kind = 'pending' AND reference_id LIKE 'DEMO%' AND created_at < ? LIMIT 500", cutoff);
  const failCodes = [210, 211, 220, 221, 230];
  for (const r of rows) {
    const p = Math.random();
    await applyStatus(r.reference_id, p < 0.93 ? 200 : p < 0.96 ? 203 : failCodes[Math.floor(Math.random() * failCodes.length)]);
  }
}

/** Live mode fallback when callbacks are not configured: poll messages still pending after 2 minutes. */
async function pollLiveStatuses(deadline) {
  const s = await getSettings();
  if (!isLive(s)) return;
  const older = new Date(Date.now() - 120000).toISOString();
  const newer = new Date(Date.now() - 3 * 864e5).toISOString();
  const rows = await all(
    `SELECT reference_id FROM transactions WHERE status_kind = 'pending' AND product = 'sms' AND reference_id IS NOT NULL
     AND reference_id NOT LIKE 'DEMO%' AND created_at < ? AND created_at > ? AND (updated_at IS NULL OR updated_at < ?) LIMIT 20`, older, newer, older);
  const c = await client(s);
  for (const r of rows) {
    if (Date.now() > deadline) break;
    try {
      const resp = await c.smsStatus(r.reference_id);
      if (resp?.status?.code) await applyStatus(r.reference_id, resp.status.code, resp.status.description);
      else await run('UPDATE transactions SET updated_at = ? WHERE reference_id = ?', now(), r.reference_id);
    } catch {
      await run('UPDATE transactions SET updated_at = ? WHERE reference_id = ?', now(), r.reference_id);
    }
  }
}

/** One unit of background work. Safe to call concurrently and frequently. */
export async function tick({ budgetMs = 20000 } = {}) {
  const deadline = Date.now() + budgetMs;
  const sent = await runCampaigns(deadline);
  await simulateDemoDelivery();
  await pollLiveStatuses(deadline);
  const s = await getSettings();
  let alerts = false;
  if (!s.last_alert_eval || Date.now() - Date.parse(s.last_alert_eval) > 60000) {
    await setSettings({ last_alert_eval: now() });
    await evaluateAlerts();
    alerts = true;
  }
  return { sent, alerts };
}

/** Local / container mode: tick every 5 seconds. */
export function startScheduler() {
  let busy = false;
  const loop = async () => {
    if (busy) return;
    busy = true;
    try { await tick(); } catch (e) { console.error('Scheduler error:', e); } finally { busy = false; }
  };
  setInterval(loop, 5000).unref?.();
  setTimeout(loop, 1000);
}
