// Spending controls, geo permissions and alerting.
import { get, all, run, now, getSettings, listSetting } from './db.js';

export const NOT_BLOCKED = "status_kind IS DISTINCT FROM 'blocked'";
const monthStart = () => new Date().toISOString().slice(0, 7) + '-01';
const dayStart = () => new Date().toISOString().slice(0, 10);

export async function spendSince(since, country) {
  const row = country
    ? await get(`SELECT COALESCE(SUM(cost),0) AS s FROM transactions WHERE created_at >= ? AND country = ? AND ${NOT_BLOCKED}`, since, country)
    : await get(`SELECT COALESCE(SUM(cost),0) AS s FROM transactions WHERE created_at >= ? AND ${NOT_BLOCKED}`, since);
  return row.s;
}

export function countryAllowed(country, s) {
  const blocked = listSetting(s, 'blocked_countries');
  if (country && blocked.includes(country)) return false;
  if (s.country_policy === 'allowlist') return !!country && listSetting(s, 'allowed_countries').includes(country);
  return true;
}

/**
 * Decide whether a send of `cost` to `country` may proceed.
 * Returns { ok: true } or { ok: false, code, reason }.
 */
export async function checkSend(country, cost) {
  const s = await getSettings();
  if (!countryAllowed(country, s)) return { ok: false, code: 902, reason: `Country ${country || 'unknown'} is not allowed` };
  if (s.hard_stop !== '1') return { ok: true };
  const monthly = Number(s.monthly_budget) || 0;
  const daily = Number(s.daily_budget) || 0;
  if (monthly && (await spendSince(monthStart())) + cost > monthly) return { ok: false, code: 901, reason: 'Monthly budget reached' };
  if (daily && (await spendSince(dayStart())) + cost > daily) return { ok: false, code: 901, reason: 'Daily budget reached' };
  const cap = await get('SELECT monthly_cap FROM country_caps WHERE country = ?', country || '');
  if (cap?.monthly_cap && (await spendSince(monthStart(), country)) + cost > cap.monthly_cap)
    return { ok: false, code: 901, reason: `Monthly cap for ${country} reached` };
  return { ok: true };
}

/** Create an alert once per dedupe key; forwards new alerts to the configured webhook (Slack/Teams compatible). */
export async function raiseAlert({ key, level, type, title, detail = '', country = null }) {
  const res = await run(
    'INSERT INTO alerts(dedupe_key, level, type, title, detail, country, created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT (dedupe_key) DO NOTHING',
    key, level, type, title, detail, country, now());
  if (res.changes) await notifyWebhook(`[${level.toUpperCase()}] ${title}${detail ? ' — ' + detail : ''}`);
  return res.changes > 0;
}

async function notifyWebhook(text) {
  const url = (await getSettings()).alert_webhook_url;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(8000) });
  } catch (e) {
    console.warn('Alert webhook failed:', e.message);
  }
}

/** Evaluation: budget thresholds, spend spikes, Verify conversion (SMS pumping), new destinations. */
export async function evaluateAlerts() {
  const s = await getSettings();
  const ym = new Date().toISOString().slice(0, 7);
  const today = dayStart();
  const money = (n) => `${n.toFixed(2)} ${s.currency}`;

  const monthly = Number(s.monthly_budget) || 0;
  if (monthly) {
    const spent = await spendSince(monthStart());
    for (const pct of [80, 100]) {
      if (spent >= (monthly * pct) / 100)
        await raiseAlert({ key: `budget-m-${pct}-${ym}`, level: pct === 100 ? 'critical' : 'warning', type: 'budget',
          title: `Monthly spend reached ${pct}% of budget`, detail: `${money(spent)} of ${money(monthly)}` });
    }
  }
  const daily = Number(s.daily_budget) || 0;
  if (daily) {
    const spent = await spendSince(today);
    for (const pct of [80, 100]) {
      if (spent >= (daily * pct) / 100)
        await raiseAlert({ key: `budget-d-${pct}-${today}`, level: pct === 100 ? 'critical' : 'warning', type: 'budget',
          title: `Daily spend reached ${pct}% of budget`, detail: `${money(spent)} of ${money(daily)}` });
    }
  }
  for (const cap of await all('SELECT * FROM country_caps WHERE monthly_cap > 0')) {
    const spent = await spendSince(monthStart(), cap.country);
    if (spent >= cap.monthly_cap * 0.8)
      await raiseAlert({ key: `cap-${cap.country}-${spent >= cap.monthly_cap ? 100 : 80}-${ym}`, level: spent >= cap.monthly_cap ? 'critical' : 'warning',
        type: 'budget', country: cap.country, title: `${cap.country} spend at ${Math.round((spent / cap.monthly_cap) * 100)}% of its cap`, detail: `${money(spent)} of ${money(cap.monthly_cap)}` });
  }

  // Spend spike per country: today's spend vs. trailing 7-day daily average.
  const mult = Number(s.spike_multiplier) || 2.5;
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const rows = await all(
    `SELECT country,
       SUM(CASE WHEN created_at >= ? THEN cost ELSE 0 END) AS today,
       SUM(CASE WHEN created_at < ? THEN cost ELSE 0 END) / 7.0 AS avg7
     FROM transactions WHERE created_at >= ? AND country IS NOT NULL AND source != 'import' GROUP BY country`, today, today, weekAgo);
  for (const r of rows) {
    if (r.today > 5 && r.today > r.avg7 * mult)
      await raiseAlert({ key: `spike-${r.country}-${today}`, level: 'warning', type: 'spike', country: r.country,
        title: `Spend spike in ${r.country}`, detail: `${money(r.today)} today vs ${money(r.avg7)} daily average (7 days)` });
  }

  // SMS pumping signal: low Verify conversion with meaningful volume in the last 24h.
  const threshold = Number(s.verify_conversion_alert) || 50;
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const vr = await all(
    `SELECT country, COUNT(*) AS n, SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS ok
     FROM transactions WHERE product = 'verify_sms' AND created_at >= ? AND verified IS NOT NULL GROUP BY country HAVING COUNT(*) >= 20`, dayAgo);
  for (const r of vr) {
    const conv = (r.ok / r.n) * 100;
    if (conv < threshold)
      await raiseAlert({ key: `pumping-${r.country}-${today}`, level: 'critical', type: 'fraud', country: r.country,
        title: `Possible SMS pumping: Verify conversion ${conv.toFixed(0)}% in ${r.country}`,
        detail: `${r.n} verification SMS in 24h, only ${r.ok} completed. Consider blocking the country or adding rate limits.` });
  }

  // First traffic to a never-seen destination country.
  const hasHistory = await get('SELECT 1 AS x FROM transactions WHERE created_at < ? LIMIT 1', dayAgo);
  if (hasHistory) {
    const newC = await all(
      `SELECT DISTINCT t.country FROM transactions t WHERE t.created_at >= ? AND t.country IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM transactions o WHERE o.country = t.country AND o.created_at < ?)`, dayAgo, dayAgo);
    for (const r of newC)
      await raiseAlert({ key: `newcountry-${r.country}`, level: 'info', type: 'geo', country: r.country,
        title: `First traffic to a new country: ${r.country}`, detail: 'Confirm this destination is expected.' });
  }
}
