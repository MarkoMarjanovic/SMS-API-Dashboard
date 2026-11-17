import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, useAction, useAuth } from '../components/ui.jsx';
import { money, pct, countryName, flag, allCountries } from '../format.js';

function CountryChips({ value, onChange, disabled, placeholder }) {
  const list = String(value || '').split(',').filter(Boolean);
  const countries = allCountries();
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="pill-list">
        {list.map((cc) => <span key={cc} className="badge">{flag(cc)} {countryName(cc)}{!disabled && <button aria-label={`Remove ${cc}`} onClick={() => onChange(list.filter((x) => x !== cc).join(','))}>✕</button>}</span>)}
        {!list.length && <span className="hint">{placeholder}</span>}
      </div>
      {!disabled && <select value="" aria-label="Add country" onChange={(e) => e.target.value && onChange([...new Set([...list, e.target.value])].join(','))}>
        <option value="">+ Add country…</option>{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select>}
    </div>
  );
}

export default function Controls() {
  const { isAdmin, settings: app } = useAuth();
  const data = useApi('/controls');
  const [s, setS] = useState(null);
  const [caps, setCaps] = useState([]);
  const [run, busy] = useAction();
  useEffect(() => { if (data.data) { setS(data.data.settings); setCaps(data.data.caps); } }, [data.data]);
  if (!s) return null;
  const d = data.data;
  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === 'checkbox' ? (e.target.checked ? '1' : '0') : e.target.value });
  const save = () => run(() => api.put('/controls', s), 'Spending controls saved').then(data.reload);
  const saveCaps = () => run(() => api.put('/controls/caps', caps), 'Country caps saved').then(data.reload);
  const used = Number(s.monthly_budget) ? d.month_spend / Number(s.monthly_budget) : null;
  const dis = !isAdmin;

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Spending controls</h1><p>Budgets, per-country caps, allowed destinations and alert rules. Enforced on everything sent through this dashboard.</p></div>
        {isAdmin && <button className="primary" onClick={save} disabled={busy}>Save changes</button>}
      </div>
      {app.demo_mode !== '1' && <div className="banner info"><span className="icon">ℹ️</span><div>Limits apply to traffic sent <b>through this dashboard</b> (campaigns, inbox replies and the gateway API). Traffic sent directly to Telesign from other systems is tracked via import but cannot be blocked here, so also set limits in the Telesign Portal.</div></div>}

      <div className="grid cols-2">
        <div className="card stack">
          <h2>Budgets</h2>
          <div className="form-grid">
            <label className="field">Monthly budget ({d.currency})<input type="number" min="0" value={s.monthly_budget} onChange={set('monthly_budget')} disabled={dis} /></label>
            <label className="field">Daily limit ({d.currency})<input type="number" min="0" value={s.daily_budget} onChange={set('daily_budget')} disabled={dis} /></label>
          </div>
          <div>
            <div className="row"><span>This month: <b>{money(d.month_spend)}</b>{used !== null && ` (${pct(used, 0)})`}</span><span className="spacer" /><span className="sub">Today: {money(d.today_spend)}</span></div>
            {used !== null && <div className="meter"><span style={{ width: `${Math.min(100, used * 100)}%`, background: used >= 1 ? 'var(--critical)' : used >= 0.8 ? 'var(--warning)' : 'var(--accent)' }} /></div>}
          </div>
          <label className="check"><input type="checkbox" checked={s.hard_stop === '1'} onChange={set('hard_stop')} disabled={dis} />
            <span><b>Hard stop</b>: block sends that would exceed a budget or cap <span className="hint">(otherwise you only get alerts)</span></span></label>
          <p className="hint">Alerts fire at 80% and 100% of each budget. {d.blocked_month > 0 && `${d.blocked_month} requests were blocked this month.`}</p>
        </div>

        <div className="card stack">
          <h2>Alert rules</h2>
          <div className="form-grid">
            <label className="field">Verify conversion alert below (%)<input type="number" min="0" max="100" value={s.verify_conversion_alert} onChange={set('verify_conversion_alert')} disabled={dis} />
              <span className="hint">SMS pumping detection, checked over the last 24h</span></label>
            <label className="field">Spend spike multiplier<input type="number" min="1" step="0.5" value={s.spike_multiplier} onChange={set('spike_multiplier')} disabled={dis} />
              <span className="hint">Alert when a country’s spend today is this many times its 7-day daily average</span></label>
          </div>
          <label className="field">Alert webhook URL<input type="url" placeholder="https://hooks.slack.com/services/…" value={s.alert_webhook_url} onChange={set('alert_webhook_url')} disabled={dis} />
            <span className="hint">Slack, Microsoft Teams or any endpoint that accepts JSON {'{ "text": "…" }'}</span></label>
        </div>

        <div className="card stack">
          <h2>Allowed destinations</h2>
          <div className="segmented">
            <button className={s.country_policy !== 'allowlist' ? 'on' : ''} onClick={() => !dis && setS({ ...s, country_policy: 'all' })}>All countries except blocked</button>
            <button className={s.country_policy === 'allowlist' ? 'on' : ''} onClick={() => !dis && setS({ ...s, country_policy: 'allowlist' })}>Only allowed countries</button>
          </div>
          {s.country_policy === 'allowlist' && <div><h3 style={{ marginBottom: 8 }}>Allowed</h3>
            <CountryChips value={s.allowed_countries} onChange={(v) => setS({ ...s, allowed_countries: v })} disabled={dis} placeholder="No countries allowed yet, so nothing can be sent." /></div>}
          <div><h3 style={{ marginBottom: 8 }}>Blocked</h3>
            <CountryChips value={s.blocked_countries} onChange={(v) => setS({ ...s, blocked_countries: v })} disabled={dis} placeholder="No blocked countries." /></div>
          <p className="hint">An allow list of only the countries where you have customers is the most effective protection against SMS pumping fraud.</p>
        </div>

        <div className="card stack">
          <div className="card-head" style={{ margin: 0 }}><h2>Monthly caps per country</h2>{isAdmin && <button className="sm" onClick={saveCaps} disabled={busy}>Save caps</button>}</div>
          <div className="table-wrap"><table>
            <thead><tr><th>Country</th><th className="num">Cap</th><th className="num">Spent this month</th><th /></tr></thead>
            <tbody>
              {caps.map((c, i) => (
                <tr key={c.country}>
                  <td>{flag(c.country)} {countryName(c.country)}</td>
                  <td className="num"><input type="number" min="0" style={{ width: 100 }} value={c.monthly_cap} disabled={dis} aria-label="Cap"
                    onChange={(e) => setCaps(caps.map((x, j) => (j === i ? { ...x, monthly_cap: e.target.value } : x)))} /></td>
                  <td className="num">{money(c.spent || 0)} {c.monthly_cap > 0 && <span className="sub">({pct((c.spent || 0) / c.monthly_cap, 0)})</span>}</td>
                  <td>{isAdmin && <button className="ghost sm" aria-label="Remove" onClick={() => setCaps(caps.filter((_, j) => j !== i))}>✕</button>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {isAdmin && <select value="" aria-label="Add cap" onChange={(e) => e.target.value && !caps.some((c) => c.country === e.target.value) && setCaps([...caps, { country: e.target.value, monthly_cap: 50, spent: 0 }])}>
            <option value="">+ Add a country cap…</option>{allCountries().map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select>}
        </div>

        <div className="card stack">
          <h2>Quiet hours</h2>
          <p className="sub">Campaigns marked “hold during quiet hours” pause between these hours (server time) and resume automatically.</p>
          <div className="form-grid">
            <label className="field">From (hour 0–23)<input type="number" min="0" max="23" value={s.quiet_hours_start} onChange={set('quiet_hours_start')} disabled={dis} /></label>
            <label className="field">Until (hour 0–23)<input type="number" min="0" max="23" value={s.quiet_hours_end} onChange={set('quiet_hours_end')} disabled={dis} /></label>
          </div>
        </div>

        <div className="card stack">
          <h2>Opt-out handling</h2>
          <label className="field">Opt-out keywords<input value={s.optout_keywords} onChange={set('optout_keywords')} disabled={dis} /><span className="hint">A reply matching one of these adds the number to the suppression list</span></label>
          <label className="field">Opt-in keywords<input value={s.optin_keywords} onChange={set('optin_keywords')} disabled={dis} /><span className="hint">A reply matching one of these removes the number from the suppression list</span></label>
          <label className="field">Suggested opt-out text<input value={s.optout_footer} onChange={set('optout_footer')} disabled={dis} /></label>
        </div>
      </div>
    </div>
  );
}
