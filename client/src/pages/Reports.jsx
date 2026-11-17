import { useEffect, useState } from 'react';
import { qs } from '../api.js';
import { useApi, Kpi, Delta, Icon } from '../components/ui.jsx';
import { TimeChart, useChartColors, productColor } from '../components/charts.jsx';
import { money, num, pct, countryName, flag, productLabel, dateShort, delta, downloadUrl, dateTime } from '../format.js';
import { PRODUCT_KEYS } from '@shared/products.js';

export default function Reports() {
  const months = useApi('/reports/months');
  const [month, setMonth] = useState('');
  useEffect(() => { if (!month && months.data?.length) setMonth(months.data[0]); }, [months.data]);
  const rep = useApi(month ? `/reports/monthly?month=${month}` : null);
  const c = useChartColors();
  const yearAgo = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11, 1)).toISOString().slice(0, 10);
  const trend = useApi('/analytics/timeseries' + qs({ from: yearAgo, to: new Date().toISOString().slice(0, 10), group: 'month' }));
  const r = rep.data;

  const byCountry = {};
  for (const l of r?.lines || []) {
    byCountry[l.country] ??= { country: l.country, total: 0 };
    byCountry[l.country][l.product] = (byCountry[l.country][l.product] || 0) + l.cost;
    byCountry[l.country].total += l.cost;
  }
  const countryRows = Object.values(byCountry).sort((a, b) => b.total - a.total);
  const products = r ? r.by_product.map((p) => p.product) : [];

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Monthly report</h1><p>Usage and fees per month, by product and destination. Ready for finance or invoice reconciliation.</p></div>
        <div className="toolbar no-print">
          <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">{(months.data || []).map((m) => <option key={m} value={m}>{dateShort(m)}</option>)}</select>
          <button onClick={() => downloadUrl(`/reports/monthly.csv?month=${month}`)}><Icon name="download" />CSV</button>
          <button onClick={() => window.print()}><Icon name="printer" />Print / PDF</button>
        </div>
      </div>
      {r && (
        <>
          <div className="sub">{r.company} · {dateShort(r.month)} · generated {dateTime(r.generated_at)} · amounts in {r.currency}</div>
          <div className="grid cols-4">
            <Kpi label="Usage charges" value={money(r.usage_total)} foot={<Delta value={delta(r.usage_total, r.previous_usage)} goodWhenUp={false} suffix="vs previous month" />} />
            <Kpi label="Fixed & recurring fees" value={money(r.fixed.total)} />
            <Kpi label="Total cost" value={money(r.total)} />
            <Kpi label="Transactions" value={num(r.by_product.reduce((a, p) => a + p.units, 0))} />
          </div>
          <div className="card no-print">
            <div className="card-head"><h2>Last 12 months</h2></div>
            {trend.data && <TimeChart group="month" periods={trend.data.periods} fmt={(v) => money(v)}
              series={PRODUCT_KEYS.filter((k) => trend.data.series[k]).map((k) => ({ key: k, label: productLabel(k), color: productColor(c, k), data: trend.data.series[k].cost }))} />}
          </div>
          <div className="grid cols-2">
            <div className="card flush">
              <div className="card-head"><h2>By product</h2></div>
              <div className="table-wrap"><table>
                <thead><tr><th>Product</th><th className="num">Volume</th><th className="num">Segments</th><th className="num">Cost</th><th className="num">Share</th></tr></thead>
                <tbody>{r.by_product.map((p) => <tr key={p.product}><td>{productLabel(p.product)}</td><td className="num">{num(p.units)}</td><td className="num">{p.product === 'sms' ? num(p.segments) : '—'}</td><td className="num">{money(p.cost)}</td><td className="num">{pct(r.usage_total ? p.cost / r.usage_total : 0)}</td></tr>)}</tbody>
                <tfoot><tr><td><b>Total usage</b></td><td /><td /><td className="num"><b>{money(r.usage_total)}</b></td><td /></tr></tfoot>
              </table></div>
            </div>
            <div className="card flush">
              <div className="card-head"><h2>Fixed &amp; recurring fees</h2></div>
              <div className="table-wrap"><table>
                <thead><tr><th>Fee</th><th>Type</th><th className="num">This month</th></tr></thead>
                <tbody>{r.fixed.items.map((f) => <tr key={f.id}><td>{f.name}</td><td className="sub">{f.frequency}{f.frequency === 'annual' ? ' (÷12)' : ''}</td><td className="num">{money(f.month_amount)}</td></tr>)}</tbody>
                <tfoot><tr><td><b>Total fees</b></td><td /><td className="num"><b>{money(r.fixed.total)}</b></td></tr></tfoot>
              </table></div>
            </div>
          </div>
          <div className="card flush">
            <div className="card-head"><h2>By country and product</h2></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Country</th>{products.map((p) => <th key={p} className="num">{productLabel(p)}</th>)}<th className="num">Total</th></tr></thead>
              <tbody>{countryRows.map((row) => (
                <tr key={row.country}><td>{flag(row.country)} {countryName(row.country)}</td>{products.map((p) => <td key={p} className="num">{row[p] ? money(row[p]) : '—'}</td>)}<td className="num"><b>{money(row.total)}</b></td></tr>
              ))}</tbody>
            </table></div>
          </div>
        </>
      )}
    </div>
  );
}
