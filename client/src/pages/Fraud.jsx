import { api, qs } from '../api.js';
import { useApi, useSort, Kpi, Empty, useAction, useAuth } from '../components/ui.jsx';
import { TimeChart, useChartColors } from '../components/charts.jsx';
import { DateRangePicker, useRange } from '../components/DateRange.jsx';
import { money, num, pct, countryName, flag } from '../format.js';

const RISK = { high: ['critical', '⛔ High'], medium: ['warning', '⚠️ Watch'], low: ['good', '✓ Normal'] };

export default function Fraud() {
  const { range } = useRange();
  const { isAdmin } = useAuth();
  const c = useChartColors();
  const q = qs({ from: range.from, to: range.to });
  const v = useApi('/analytics/verify' + q);
  const ts = useApi('/analytics/timeseries' + qs({ from: range.from, to: range.to, product: 'verify_sms,verify_voice', by: 'country' }));
  const controls = useApi('/controls');
  const [run, busy] = useAction();
  const rows = v.data?.rows || [];
  const [sorted, th] = useSort(rows, 'n');
  const totals = rows.reduce((a, r) => ({ n: a.n + r.n, ok: a.ok + r.ok, cost: a.cost + r.cost, wasted: a.wasted + r.wasted }), { n: 0, ok: 0, cost: 0, wasted: 0 });
  const high = rows.filter((r) => r.risk === 'high');
  const blocked = new Set(String(controls.data?.settings.blocked_countries || '').split(',').filter(Boolean));

  // Top 6 countries by volume as series, everything else folded into "Other".
  let series = [];
  if (ts.data) {
    const keys = Object.keys(ts.data.series).sort((a, b) => ts.data.series[b].units.reduce((x, y) => x + y, 0) - ts.data.series[a].units.reduce((x, y) => x + y, 0));
    const top = keys.slice(0, 6);
    series = top.map((k, i) => ({ key: k, label: countryName(k), color: c.series[i], data: ts.data.series[k].units }));
    const rest = keys.slice(6);
    if (rest.length) series.push({ key: 'other', label: 'Other', color: c.muted, data: ts.data.periods.map((_, i) => rest.reduce((a, k) => a + ts.data.series[k].units[i], 0)) });
  }

  const toggleBlock = async (cc) => {
    const next = new Set(blocked);
    next.has(cc) ? next.delete(cc) : next.add(cc);
    await run(() => api.put('/controls', { blocked_countries: [...next].join(',') }), next.has(cc) ? `${countryName(cc)} blocked` : `${countryName(cc)} unblocked`);
    controls.reload();
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Verify &amp; fraud</h1><p>Watch verification conversion per country to catch SMS pumping (artificially inflated traffic) early</p></div>
        <div className="toolbar"><DateRangePicker /></div>
      </div>
      {high.length > 0 && (
        <div className="banner critical" role="alert"><span className="icon">⛔</span><div>
          <b>{high.length} {high.length === 1 ? 'country shows' : 'countries show'} signs of SMS pumping: {high.map((h) => `${flag(h.country)} ${countryName(h.country)}`).join(', ')}</b>
          <span className="sub">Many verification codes are requested but almost none are entered. This is the typical pattern of SMS pumping fraud: bots request codes for premium-rate numbers and the attacker earns a share of the termination fee. Block the country, or add rate limits and CAPTCHA to your sign-up flow.</span>
        </div></div>
      )}
      <div className="grid cols-4">
        <Kpi label="Verifications sent" value={num(totals.n)} />
        <Kpi label="Conversion" value={pct(totals.n ? totals.ok / totals.n : null)} foot={`Alert threshold ${v.data?.threshold ?? 50}%`} />
        <Kpi label="Verify spend" value={money(totals.cost)} />
        <Kpi label="Spend on unconverted codes" value={money(totals.wasted)} foot="Codes sent but never entered" />
      </div>
      <div className="card">
        <div className="card-head"><div><h2>Verification volume by country</h2><p>A sudden new colour or tall bar from an unexpected country is the first sign of an attack</p></div></div>
        {ts.data && <TimeChart periods={ts.data.periods} series={series} group={ts.data.group} fmt={(v) => num(v)} />}
      </div>
      <div className="card flush">
        <div className="card-head"><h2>Conversion by country</h2><p>Conversion = codes entered ÷ codes sent. Report completions via the gateway API so this is accurate.</p></div>
        <div className="table-wrap">
          <table>
            <thead><tr>{th('country', 'Country')}{th('risk', 'Risk')}{th('n', 'Sent', 'num')}{th('conversion', 'Conversion', 'num')}{th('n24', 'Last 24h', 'num')}
              {th('conversion24', 'Conv. 24h', 'num')}{th('cost', 'Spend', 'num')}{th('wasted', 'Unconverted spend', 'num')}{isAdmin && <th />}</tr></thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.country}>
                  <td>{flag(r.country)} {countryName(r.country)}</td>
                  <td><span className={`badge lvl-${RISK[r.risk][0]}`}>{RISK[r.risk][1]}</span></td>
                  <td className="num">{num(r.n)}</td>
                  <td className="num">{pct(r.conversion, 0)}</td>
                  <td className="num">{num(r.n24)}</td>
                  <td className="num">{pct(r.conversion24, 0)}</td>
                  <td className="num">{money(r.cost)}</td>
                  <td className="num">{money(r.wasted)}</td>
                  {isAdmin && <td><button className={`sm ${blocked.has(r.country) ? '' : 'danger'}`} disabled={busy} onClick={() => toggleBlock(r.country)}>{blocked.has(r.country) ? 'Unblock' : 'Block'}</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {v.data && !rows.length && <Empty>No verification traffic in this period.</Empty>}
        </div>
      </div>
    </div>
  );
}
