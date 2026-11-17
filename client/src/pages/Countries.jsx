import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useApi, useSort, Drawer, Empty, useAction, useAuth } from '../components/ui.jsx';
import { WorldMap, TimeChart, useChartColors, productColor } from '../components/charts.jsx';
import { DateRangePicker, useRange } from '../components/DateRange.jsx';
import { money, num, pct, countryName, flag, productLabel, downloadUrl } from '../format.js';
import { PRODUCT_KEYS } from '@shared/products.js';

function CountryDrawer({ cc, onClose }) {
  const { range } = useRange();
  const { isAdmin } = useAuth();
  const c = useChartColors();
  const q = qs({ from: range.from, to: range.to, country: cc });
  const detail = useApi(`/analytics/country/${cc}` + qs({ from: range.from, to: range.to }));
  const ts = useApi('/analytics/timeseries' + q);
  const statuses = useApi('/analytics/statuses' + q);
  const controls = useApi('/controls');
  const [run, busy] = useAction();
  const [cap, setCap] = useState('');

  const d = detail.data;
  const series = ts.data ? PRODUCT_KEYS.filter((k) => ts.data.series[k]).map((k) => ({ key: k, label: productLabel(k), color: productColor(c, k), data: ts.data.series[k].cost })) : [];
  const total = d?.products.reduce((a, p) => a + p.cost, 0) || 0;

  const blockCountry = async () => {
    const s = controls.data.settings;
    const blocked = new Set(String(s.blocked_countries || '').split(',').filter(Boolean));
    d.blocked ? blocked.delete(cc) : blocked.add(cc);
    await run(() => api.put('/controls', { blocked_countries: [...blocked].join(',') }), d.blocked ? `${cc} unblocked` : `${cc} blocked: new sends will be refused`);
    detail.reload(); controls.reload();
  };
  const saveCap = async () => {
    const caps = controls.data.caps.filter((x) => x.country !== cc);
    if (Number(cap) > 0) caps.push({ country: cc, monthly_cap: Number(cap) });
    await run(() => api.put('/controls/caps', caps), 'Country cap saved');
    detail.reload(); controls.reload(); setCap('');
  };

  return (
    <Drawer title={`${flag(cc)} ${countryName(cc)}`} onClose={onClose}>
      {!d ? <p className="sub">Loading…</p> : (
        <div className="stack">
          <div className="grid cols-2">
            <div className="card kpi"><div className="label">Spend in period</div><div className="value">{money(total)}</div></div>
            <div className="card kpi"><div className="label">Monthly cap</div><div className="value">{d.cap ? money(d.cap) : 'None'}</div>
              <div className="foot">{d.blocked ? '⛔ Country is blocked' : 'Sending allowed'}</div></div>
          </div>
          <div className="card"><h3 style={{ marginBottom: 10 }}>Spend by product</h3>{ts.data && <TimeChart periods={ts.data.periods} series={series} group={ts.data.group} fmt={(v, axis) => money(v, { precise: !axis && v < 1 })} height="sm" />}</div>
          <div className="card flush">
            <div className="table-wrap"><table>
              <thead><tr><th>Product</th><th className="num">Volume</th><th className="num">Spend</th><th className="num">Delivered</th><th className="num">Your rate</th></tr></thead>
              <tbody>{d.products.map((p) => {
                const r = d.rates.find((x) => x.product === p.product);
                return <tr key={p.product}><td>{productLabel(p.product)}</td><td className="num">{num(p.units)}</td><td className="num">{money(p.cost)}</td>
                  <td className="num">{p.delivered + p.failed ? pct(p.delivered / (p.delivered + p.failed)) : '—'}</td>
                  <td className="num">{r ? money(r.price + r.carrier_fee, { precise: true }) : '—'}</td></tr>;
              })}</tbody>
            </table></div>
          </div>
          <div className="card flush">
            <div className="card-head"><h3>Delivery outcomes</h3></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Code</th><th>Status</th><th className="num">Count</th></tr></thead>
              <tbody>{(statuses.data || []).map((s) => <tr key={s.code} title={s.advice || ''}><td className="mono">{s.code}</td><td>{s.text}{s.advice && <div className="hint">{s.advice}</div>}</td><td className="num">{num(s.n)}</td></tr>)}</tbody>
            </table></div>
          </div>
          {isAdmin && controls.data && (
            <div className="card stack">
              <h3>Controls for {cc}</h3>
              <div className="row">
                <input type="number" min="0" step="1" placeholder={d.cap ? `Current cap ${d.cap}` : 'Monthly cap'} value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Monthly cap" style={{ width: 160 }} />
                <button onClick={saveCap} disabled={busy}>{cap === '' && d.cap ? 'Remove cap' : 'Set cap'}</button>
                <span className="spacer" />
                <button className={d.blocked ? '' : 'danger'} onClick={blockCountry} disabled={busy}>{d.blocked ? 'Unblock country' : 'Block country'}</button>
              </div>
              <p className="hint">Caps and blocks apply to everything sent through this dashboard (campaigns, replies, gateway API).</p>
            </div>
          )}
          <Link to={`/messages?country=${cc}`}>View messages to {countryName(cc)} →</Link>
        </div>
      )}
    </Drawer>
  );
}

export default function Countries() {
  const { range } = useRange();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [metric, setMetric] = useState('cost');
  const q = qs({ from: range.from, to: range.to });
  const data = useApi('/analytics/countries' + q);
  const rows = (data.data || []).filter((r) => !filter || countryName(r.country).toLowerCase().includes(filter.toLowerCase()) || r.country.toLowerCase() === filter.toLowerCase());
  const [sorted, th] = useSort(rows, 'cost');
  const total = rows.reduce((a, r) => a + r.cost, 0);
  const selected = params.get('c');
  const max = Math.max(...rows.map((r) => r.cost), 0);

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Countries</h1><p>Where your traffic goes and what each destination costs</p></div>
        <div className="toolbar">
          <DateRangePicker />
          <button onClick={() => downloadUrl('/messages/export.csv' + q)}>Export CSV</button>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>{metric === 'cost' ? 'Spend' : 'Volume'} by country</h2>
          <div className="segmented"><button className={metric === 'cost' ? 'on' : ''} onClick={() => setMetric('cost')}>Spend</button><button className={metric === 'units' ? 'on' : ''} onClick={() => setMetric('units')}>Volume</button></div>
        </div>
        {data.data && <WorldMap label={metric === 'cost' ? 'Spend' : 'Volume'} values={Object.fromEntries(data.data.map((x) => [x.country, x[metric]]))}
          fmt={metric === 'cost' ? (v) => money(v) : (v) => num(v)} onSelect={(cc) => setParams({ c: cc })} />}
      </div>
      <div className="card flush">
        <div className="card-head">
          <h2>{rows.length} countries · {money(total)}</h2>
          <input type="search" placeholder="Filter countries…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter countries" />
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr>{th('country', 'Country')}{th('cost', 'Spend', 'num')}<th>Share</th>{th('units', 'Volume', 'num')}{th('segments', 'SMS segments', 'num')}
              {th('delivery_rate', 'Delivered', 'num')}{th('verify_conversion', 'Verify conv.', 'num')}{th('blocked', 'Blocked', 'num')}<th className="num">Avg / unit</th></tr></thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.country} className="clickable" onClick={() => setParams({ c: r.country })}>
                  <td>{flag(r.country)} {countryName(r.country)} <span className="sub mono">{r.country}</span></td>
                  <td className="num">{money(r.cost)}</td>
                  <td><div className="bar-cell"><div className="bar" style={{ width: `${max ? (r.cost / max) * 100 : 0}px` }} /><span className="sub">{pct(total ? r.cost / total : 0, 1)}</span></div></td>
                  <td className="num">{num(r.units)}</td>
                  <td className="num">{num(r.segments)}</td>
                  <td className="num">{pct(r.delivery_rate)}</td>
                  <td className="num" style={r.verify_conversion !== null && r.verify_conversion < 0.5 ? { color: 'var(--critical)', fontWeight: 600 } : {}}>
                    {r.verify_conversion !== null && r.verify_conversion < 0.5 ? '⚠️ ' : ''}{pct(r.verify_conversion, 0)}</td>
                  <td className="num">{r.blocked ? num(r.blocked) : '—'}</td>
                  <td className="num">{money(r.units ? r.cost / r.units : null, { precise: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.data && !rows.length && <Empty>No traffic in this period.</Empty>}
        </div>
      </div>
      {selected && <CountryDrawer cc={selected} onClose={() => setParams({})} />}
    </div>
  );
}
