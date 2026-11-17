import { Router } from 'express';
import { all, get, getSettings } from '../db.js';
import { dateRange, txFilters } from '../util.js';
import { fixedCostsForMonth, round } from '../pricing.js';
import { describeStatus, STATUS_ADVICE } from '../../shared/statusCodes.js';

const r = Router();
const NOT_BLOCKED = "status_kind IS NOT 'blocked'";

function totals(q) {
  const f = txFilters(q);
  return get(
    `SELECT COALESCE(SUM(CASE WHEN ${NOT_BLOCKED} THEN cost END),0) AS spend,
       COALESCE(SUM(CASE WHEN ${NOT_BLOCKED} THEN units END),0) AS units,
       COALESCE(SUM(CASE WHEN product = 'sms' AND ${NOT_BLOCKED} THEN units END),0) AS sms_messages,
       COALESCE(SUM(CASE WHEN product = 'sms' AND ${NOT_BLOCKED} THEN segments END),0) AS sms_segments,
       COALESCE(SUM(CASE WHEN product = 'sms' AND ${NOT_BLOCKED} THEN cost END),0) AS sms_spend,
       COALESCE(SUM(CASE WHEN status_kind = 'delivered' AND product IN ('sms','verify_sms','whatsapp') THEN units END),0) AS delivered,
       COALESCE(SUM(CASE WHEN status_kind = 'failed' AND product IN ('sms','verify_sms','whatsapp') THEN units END),0) AS failed,
       COALESCE(SUM(CASE WHEN status_kind = 'blocked' THEN units END),0) AS blocked,
       COALESCE(SUM(CASE WHEN product LIKE 'verify_%' AND verified IS NOT NULL THEN 1 END),0) AS verify_n,
       COALESCE(SUM(CASE WHEN product LIKE 'verify_%' AND verified = 1 THEN 1 END),0) AS verify_ok,
       COUNT(DISTINCT country) AS countries
     FROM transactions ${f.sql}`, ...f.params);
}

function derive(t) {
  return {
    ...t,
    spend: round(t.spend, 2),
    delivery_rate: t.delivered + t.failed ? t.delivered / (t.delivered + t.failed) : null,
    verify_conversion: t.verify_n ? t.verify_ok / t.verify_n : null,
    cost_per_sms: t.sms_messages ? t.sms_spend / t.sms_messages : null,
    segments_per_sms: t.sms_messages ? t.sms_segments / t.sms_messages : null,
  };
}

r.get('/overview', (req, res) => {
  const s = getSettings();
  const range = dateRange(req.query);
  const prevTo = new Date(Date.parse(range.from) - 864e5).toISOString().slice(0, 10);
  const prevFrom = new Date(Date.parse(range.from) - range.days * 864e5).toISOString().slice(0, 10);
  const current = derive(totals(req.query));
  const previous = derive(totals({ ...req.query, from: prevFrom, to: prevTo }));

  const nowD = new Date();
  const ym = nowD.toISOString().slice(0, 7);
  const mtd = get(`SELECT COALESCE(SUM(cost),0) AS s FROM transactions WHERE created_at >= ? AND ${NOT_BLOCKED}`, ym + '-01').s;
  const today = get(`SELECT COALESCE(SUM(cost),0) AS s FROM transactions WHERE created_at >= ? AND ${NOT_BLOCKED}`, nowD.toISOString().slice(0, 10)).s;
  const daysInMonth = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsed = Math.max(nowD.getUTCDate() - 1 + (nowD.getUTCHours() * 60 + nowD.getUTCMinutes()) / 1440, 0.5);
  const fixed = fixedCostsForMonth(ym);

  res.json({
    range: { ...range, prevFrom, prevTo },
    current, previous,
    month: {
      month: ym, spend: round(mtd, 2), today: round(today, 2), budget: Number(s.monthly_budget) || 0, daily_budget: Number(s.daily_budget) || 0,
      forecast: round((mtd / elapsed) * daysInMonth, 2), fixed: fixed.total, days_in_month: daysInMonth, elapsed_days: round(elapsed, 2),
    },
    unread_replies: get('SELECT COUNT(*) AS n FROM inbound WHERE read = 0').n,
    open_alerts: get('SELECT COUNT(*) AS n FROM alerts WHERE acknowledged = 0').n,
    currency: s.currency,
  });
});

function grouping(q, days) {
  const g = q.group || (days > 120 ? 'week' : 'day');
  if (g === 'month') return { g, expr: 'substr(created_at, 1, 7)' };
  if (g === 'week') return { g, expr: "date(substr(created_at,1,10), '-' || ((CAST(strftime('%w', substr(created_at,1,10)) AS INTEGER) + 6) % 7) || ' days')" };
  return { g: 'day', expr: 'substr(created_at, 1, 10)' };
}

function periods(range, g) {
  const out = [];
  if (g === 'month') {
    let d = new Date(range.from.slice(0, 7) + '-01T00:00:00Z');
    while (d.toISOString().slice(0, 10) <= range.to) {
      out.push(d.toISOString().slice(0, 7));
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    }
    return out;
  }
  let d = new Date(range.from + 'T00:00:00Z');
  if (g === 'week') d = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 864e5);
  while (d.toISOString().slice(0, 10) <= range.to) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + (g === 'week' ? 7 : 1) * 864e5);
  }
  return out;
}

/** Time series by product: { periods, group, series: { product: { cost: [], units: [] } } } */
r.get('/timeseries', (req, res) => {
  const range = dateRange(req.query);
  const { g, expr } = grouping(req.query, range.days);
  const f = txFilters(req.query);
  const by = req.query.by === 'country' ? 'country' : 'product';
  const rows = all(
    `SELECT ${expr} AS period, ${by} AS k, SUM(cost) AS cost, SUM(units) AS units,
       SUM(CASE WHEN status_kind = 'delivered' THEN units ELSE 0 END) AS delivered,
       SUM(CASE WHEN status_kind = 'failed' THEN units ELSE 0 END) AS failed
     FROM transactions ${f.sql} ${f.sql ? 'AND' : 'WHERE'} ${NOT_BLOCKED} GROUP BY period, k`, ...f.params);
  const ps = periods(range, g);
  const idx = new Map(ps.map((p, i) => [p, i]));
  const series = {};
  for (const row of rows) {
    const key = row.k || 'Unknown';
    series[key] ??= { cost: ps.map(() => 0), units: ps.map(() => 0), delivered: ps.map(() => 0), failed: ps.map(() => 0) };
    const i = idx.get(row.period);
    if (i === undefined) continue;
    series[key].cost[i] = round(row.cost, 4);
    series[key].units[i] = row.units;
    series[key].delivered[i] = row.delivered;
    series[key].failed[i] = row.failed;
  }
  res.json({ group: g, periods: ps, series });
});

r.get('/countries', (req, res) => {
  const f = txFilters(req.query);
  const rows = all(
    `SELECT COALESCE(country, '??') AS country,
       SUM(CASE WHEN ${NOT_BLOCKED} THEN units ELSE 0 END) AS units,
       SUM(CASE WHEN product = 'sms' AND ${NOT_BLOCKED} THEN segments ELSE 0 END) AS segments,
       SUM(CASE WHEN ${NOT_BLOCKED} THEN cost ELSE 0 END) AS cost,
       SUM(CASE WHEN status_kind = 'delivered' AND product IN ('sms','verify_sms','whatsapp') THEN units ELSE 0 END) AS delivered,
       SUM(CASE WHEN status_kind = 'failed' AND product IN ('sms','verify_sms','whatsapp') THEN units ELSE 0 END) AS failed,
       SUM(CASE WHEN status_kind = 'blocked' THEN units ELSE 0 END) AS blocked,
       SUM(CASE WHEN product LIKE 'verify_%' AND verified IS NOT NULL THEN 1 ELSE 0 END) AS verify_n,
       SUM(CASE WHEN product LIKE 'verify_%' AND verified = 1 THEN 1 ELSE 0 END) AS verify_ok
     FROM transactions ${f.sql} GROUP BY country ORDER BY cost DESC`, ...f.params);
  const byProduct = all(
    `SELECT COALESCE(country, '??') AS country, product, SUM(cost) AS cost, SUM(units) AS units
     FROM transactions ${f.sql} ${f.sql ? 'AND' : 'WHERE'} ${NOT_BLOCKED} GROUP BY country, product`, ...f.params);
  const map = new Map(rows.map((x) => [x.country, { ...x, products: {} }]));
  for (const b of byProduct) map.get(b.country) && (map.get(b.country).products[b.product] = { cost: round(b.cost, 4), units: b.units });
  res.json([...map.values()].map((x) => ({
    ...x, cost: round(x.cost, 4),
    delivery_rate: x.delivered + x.failed ? x.delivered / (x.delivered + x.failed) : null,
    verify_conversion: x.verify_n ? x.verify_ok / x.verify_n : null,
  })));
});

r.get('/products', (req, res) => {
  const f = txFilters(req.query);
  const rows = all(
    `SELECT product, SUM(CASE WHEN ${NOT_BLOCKED} THEN units ELSE 0 END) AS units, SUM(CASE WHEN ${NOT_BLOCKED} THEN segments ELSE 0 END) AS segments,
       SUM(CASE WHEN ${NOT_BLOCKED} THEN cost ELSE 0 END) AS cost,
       SUM(CASE WHEN status_kind = 'delivered' THEN units ELSE 0 END) AS delivered,
       SUM(CASE WHEN status_kind = 'failed' THEN units ELSE 0 END) AS failed,
       SUM(CASE WHEN status_kind = 'blocked' THEN units ELSE 0 END) AS blocked,
       COUNT(DISTINCT country) AS countries
     FROM transactions ${f.sql} GROUP BY product ORDER BY cost DESC`, ...f.params);
  res.json(rows.map((x) => ({ ...x, cost: round(x.cost, 4), avg_cost: x.units ? x.cost / x.units : null,
    delivery_rate: x.delivered + x.failed ? x.delivered / (x.delivered + x.failed) : null })));
});

/** Failure / status code breakdown. */
r.get('/statuses', (req, res) => {
  const f = txFilters(req.query);
  const rows = all(
    `SELECT status_code AS code, status_kind AS kind, COUNT(*) AS n, SUM(units) AS units, GROUP_CONCAT(DISTINCT country) AS countries
     FROM transactions ${f.sql} ${f.sql ? 'AND' : 'WHERE'} status_code IS NOT NULL AND source != 'import'
     GROUP BY status_code ORDER BY n DESC`, ...f.params);
  res.json(rows.map((x) => ({ ...x, text: describeStatus(x.code).text, advice: STATUS_ADVICE[x.code] || null,
    countries: (x.countries || '').split(',').filter(Boolean).slice(0, 8) })));
});

/** Verify health per country: conversion over 24h / 7d / range — the main SMS pumping signal. */
r.get('/verify', (req, res) => {
  const f = txFilters({ ...req.query, product: 'verify_sms,verify_voice' });
  const d1 = new Date(Date.now() - 864e5).toISOString();
  const d7 = new Date(Date.now() - 7 * 864e5).toISOString();
  const rows = all(
    `SELECT COALESCE(country,'??') AS country, COUNT(*) AS n, SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS ok, SUM(cost) AS cost,
       SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS n24, SUM(CASE WHEN created_at >= ? AND verified = 1 THEN 1 ELSE 0 END) AS ok24,
       SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS n7, SUM(CASE WHEN created_at >= ? AND verified = 1 THEN 1 ELSE 0 END) AS ok7
     FROM transactions ${f.sql} AND verified IS NOT NULL GROUP BY country ORDER BY n DESC`, d1, d1, d7, d7, ...f.params);
  const threshold = Number(getSettings().verify_conversion_alert) || 50;
  res.json({
    threshold,
    rows: rows.map((x) => {
      const conv = x.n ? x.ok / x.n : null;
      const conv24 = x.n24 ? x.ok24 / x.n24 : null;
      const avgDaily7 = x.n7 / 7;
      const risk = (conv24 !== null && x.n24 >= 20 && conv24 * 100 < threshold) ? 'high'
        : (conv !== null && conv * 100 < threshold + 15) || (x.n24 > avgDaily7 * 3 && x.n24 > 20) ? 'medium' : 'low';
      // Wasted spend = cost of verifications that never completed.
      return { ...x, cost: round(x.cost, 2), conversion: conv, conversion24: conv24, wasted: round(x.cost * (1 - (conv ?? 1)), 2), risk };
    }),
  });
});

r.get('/country/:cc', (req, res) => {
  const cc = req.params.cc.toUpperCase();
  const f = txFilters({ ...req.query, country: cc });
  const products = all(
    `SELECT product, SUM(units) AS units, SUM(segments) AS segments, SUM(cost) AS cost,
       SUM(CASE WHEN status_kind='delivered' THEN units ELSE 0 END) AS delivered, SUM(CASE WHEN status_kind='failed' THEN units ELSE 0 END) AS failed
     FROM transactions ${f.sql} AND ${NOT_BLOCKED} GROUP BY product ORDER BY cost DESC`, ...f.params);
  const rates = all('SELECT product, price, carrier_fee FROM rates WHERE country = ? OR country = \'*\' ORDER BY country = \'*\'', cc);
  const cap = get('SELECT monthly_cap FROM country_caps WHERE country = ?', cc);
  const s = getSettings();
  res.json({ country: cc, products, rates, cap: cap?.monthly_cap ?? null,
    blocked: String(s.blocked_countries).toUpperCase().split(',').map((x) => x.trim()).includes(cc) });
});

export default r;
