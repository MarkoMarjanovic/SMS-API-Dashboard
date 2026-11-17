// Small helpers shared by route modules.

/** Parse ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive). Defaults to the last 30 days. */
export function dateRange(q = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : new Date(Date.parse(to) - 29 * 864e5).toISOString().slice(0, 10);
  const toExclusive = new Date(Date.parse(to) + 864e5).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(toExclusive) - Date.parse(from)) / 864e5);
  return { from, to, toExclusive, days };
}

/** Build a WHERE clause for transactions from common filters. */
export function txFilters(q = {}, { range = true } = {}) {
  const where = [];
  const params = [];
  if (range) {
    const r = dateRange(q);
    where.push('created_at >= ?', 'created_at < ?');
    params.push(r.from, r.toExclusive);
  }
  const list = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);
  if (q.product) { const l = list(q.product); where.push(`product IN (${l.map(() => '?').join(',')})`); params.push(...l); }
  if (q.country) { const l = list(q.country).map((x) => x.toUpperCase()); where.push(`country IN (${l.map(() => '?').join(',')})`); params.push(...l); }
  if (q.status) { const l = list(q.status); where.push(`status_kind IN (${l.map(() => '?').join(',')})`); params.push(...l); }
  if (q.campaign) { where.push('campaign_id = ?'); params.push(Number(q.campaign)); }
  if (q.source) { where.push('source = ?'); params.push(q.source); }
  if (q.code) { where.push('status_code = ?'); params.push(Number(q.code)); }
  if (q.q) {
    where.push('(phone LIKE ? OR message LIKE ? OR reference_id LIKE ?)');
    const like = `%${q.q}%`;
    params.push(like, like, like);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

export function toCsv(rows, columns) {
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v);
    const s = String(v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

export function sendCsv(res, filename, rows, columns) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + toCsv(rows, columns));
}

/** Wrap async route handlers so errors reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
