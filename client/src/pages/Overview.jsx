import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { qs } from '../api.js';
import { useApi, Kpi, Delta, LevelBadge, Empty } from '../components/ui.jsx';
import { TimeChart, HBar, WorldMap, useChartColors, productColor } from '../components/charts.jsx';
import { DateRangePicker, useRange } from '../components/DateRange.jsx';
import { money, num, pct, delta, compact, countryName, flag, productLabel, dateShort } from '../format.js';
import { PRODUCT_KEYS } from '@shared/products.js';

export function BudgetCard({ month }) {
  const used = month.budget ? month.spend / month.budget : null;
  const fc = month.budget ? month.forecast / month.budget : null;
  const over = fc !== null && fc > 1;
  return (
    <div className="card">
      <div className="card-head"><h2>This month’s budget</h2><Link to="/controls">Adjust</Link></div>
      <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 26, fontWeight: 600 }} className="num">{money(month.spend)}</span>
        <span className="sub">of {month.budget ? money(month.budget) : 'no budget set'}</span>
      </div>
      {month.budget > 0 && (
        <div className="meter" role="meter" aria-valuenow={Math.round((used || 0) * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Budget used">
          <span style={{ width: `${Math.min(100, (used || 0) * 100)}%`, background: used >= 1 ? 'var(--critical)' : used >= 0.8 ? 'var(--warning)' : 'var(--accent)' }} />
          <i style={{ left: `${Math.min(99.5, (fc || 0) * 100)}%` }} title="Forecast" />
        </div>
      )}
      <dl className="kv" style={{ marginTop: 14 }}>
        <dt>Forecast month-end</dt>
        <dd className={over ? 'delta-down' : ''}>{money(month.forecast)}{over ? ` ⚠️ ${pct(fc - 1, 0)} over budget` : ''}</dd>
        <dt>Today</dt><dd>{money(month.today)}{month.daily_budget ? ` of ${money(month.daily_budget)} daily limit` : ''}</dd>
        <dt>Fixed &amp; recurring fees</dt><dd>{money(month.fixed)} <Link to="/rates?tab=fixed" className="sub">details</Link></dd>
        <dt>Total incl. fees</dt><dd><b>{money(month.spend + month.fixed)}</b></dd>
      </dl>
    </div>
  );
}

export default function Overview() {
  const { range } = useRange();
  const nav = useNavigate();
  const c = useChartColors();
  const [metric, setMetric] = useState('cost');
  const q = qs({ from: range.from, to: range.to });
  const ov = useApi('/analytics/overview' + q);
  const ts = useApi('/analytics/timeseries' + q);
  const products = useApi('/analytics/products' + q);
  const countries = useApi('/analytics/countries' + q);
  const alerts = useApi('/alerts?open=1');

  const o = ov.data;
  const cur = o?.current;
  const prev = o?.previous;
  const critical = (alerts.data || []).filter((a) => a.level !== 'info').slice(0, 3);

  const series = ts.data ? PRODUCT_KEYS.filter((k) => ts.data.series[k]).map((k) => ({
    key: k, label: productLabel(k), color: productColor(c, k), data: ts.data.series[k][metric],
  })) : [];

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Overview</h1><p>Spend and usage across all Telesign products · {dateShort(range.from)} – {dateShort(range.to)}</p></div>
        <div className="toolbar"><DateRangePicker /></div>
      </div>

      {critical.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          {critical.map((a) => (
            <div key={a.id} className={`banner ${a.level}`} role="alert">
              <span className="icon" aria-hidden="true">{a.level === 'critical' ? '⛔' : '⚠️'}</span>
              <div style={{ flex: 1 }}><b>{a.title}</b><span className="sub">{a.detail}</span></div>
              <Link to="/alerts" className="btn sm">Review</Link>
            </div>
          ))}
        </div>
      )}

      {cur && (
        <div className="grid cols-4">
          <Kpi label="Spend" value={money(cur.spend)} foot={<Delta value={delta(cur.spend, prev.spend)} goodWhenUp={false} />} />
          <Kpi label="Billable transactions" value={compact(cur.units)} foot={<Delta value={delta(cur.units, prev.units)} />} title={`${num(cur.units)} across ${cur.countries} countries`} />
          <Kpi label="Delivery rate (SMS)" value={pct(cur.delivery_rate)}
            foot={<><Delta value={cur.delivery_rate && prev.delivery_rate ? cur.delivery_rate - prev.delivery_rate : null} suffix="pts vs previous" /></>} />
          <Kpi label="Avg cost per SMS" value={money(cur.cost_per_sms, { precise: true })}
            foot={<span>{cur.segments_per_sms ? `${cur.segments_per_sms.toFixed(2)} segments / message` : ''}</span>} />
        </div>
      )}

      <div className="grid cols-3">
        <div className="card span-2">
          <div className="card-head">
            <div><h2>{metric === 'cost' ? 'Spend' : 'Volume'} by product</h2><p>{ts.data?.group === 'week' ? 'Weekly' : 'Daily'} · click legend items to hide a product</p></div>
            <div className="segmented" role="group" aria-label="Metric">
              <button className={metric === 'cost' ? 'on' : ''} onClick={() => setMetric('cost')}>Spend</button>
              <button className={metric === 'units' ? 'on' : ''} onClick={() => setMetric('units')}>Volume</button>
            </div>
          </div>
          {ts.data && <TimeChart periods={ts.data.periods} series={series} group={ts.data.group}
            fmt={metric === 'cost' ? (v, axis) => money(v, { precise: !axis && v < 1 }) : (v) => num(v)} />}
        </div>
        {o && <BudgetCard month={o.month} />}
      </div>

      <div className="grid cols-2">
        <div className="card flush">
          <div className="card-head"><h2>Products</h2><span className="sub">{cur ? `Verify conversion ${pct(cur.verify_conversion)}` : ''}</span></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Product</th><th className="num">Volume</th><th className="num">Spend</th><th className="num">Avg / unit</th><th className="num">Delivered</th></tr></thead>
              <tbody>
                {(products.data || []).map((p) => (
                  <tr key={p.product} className="clickable" onClick={() => nav(`/messages?product=${p.product}`)}>
                    <td><span className="row" style={{ gap: 8 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: productColor(c, p.product) }} />{productLabel(p.product)}</span></td>
                    <td className="num">{num(p.units)}</td>
                    <td className="num">{money(p.cost)}</td>
                    <td className="num">{money(p.avg_cost, { precise: true })}</td>
                    <td className="num">{['sms', 'verify_sms', 'whatsapp', 'verify_voice'].includes(p.product) ? pct(p.delivery_rate) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {products.data?.length === 0 && <Empty>No usage in this period.</Empty>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Top countries by spend</h2><Link to="/countries">All countries</Link></div>
          {countries.data && <HBar rows={countries.data.slice(0, 8).map((x) => ({ label: `${flag(x.country)} ${countryName(x.country)}`, value: x.cost }))} fmt={(v, axis) => money(v, { precise: !axis && v < 1 })} height={280} />}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div><h2>Where your money goes</h2><p>Spend by destination country · click a country for details</p></div></div>
        {countries.data && <WorldMap values={Object.fromEntries(countries.data.map((x) => [x.country, x.cost]))} fmt={(v) => money(v)} onSelect={(cc) => nav(`/countries?c=${cc}`)} />}
      </div>

      {alerts.data?.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Recent alerts</h2><Link to="/alerts">All alerts</Link></div>
          <div className="stack" style={{ gap: 8 }}>
            {alerts.data.slice(0, 5).map((a) => <div key={a.id} className="row"><LevelBadge level={a.level} /><span>{a.title}</span><span className="sub">{a.detail}</span></div>)}
          </div>
        </div>
      )}
    </div>
  );
}
