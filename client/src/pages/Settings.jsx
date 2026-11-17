import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useAction, useAuth, Modal, Icon, Empty } from '../components/ui.jsx';
import { dateTime } from '../format.js';

function General() {
  const { settings, refreshSettings } = useAuth();
  const [f, setF] = useState(settings);
  const [run, busy] = useAction();
  const [pw, setPw] = useState({ current: '', next: '' });
  return (
    <div className="grid cols-2">
      <div className="card stack">
        <h2>Company</h2>
        <label className="field">Company name<input value={f.company_name} onChange={(e) => setF({ ...f, company_name: e.target.value })} /></label>
        <label className="field">Currency<select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
          {['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'RSD', 'INR', 'BRL', 'JPY'].map((c) => <option key={c}>{c}</option>)}</select>
          <span className="hint">Use the currency your Telesign contract is billed in. Amounts are not converted.</span></label>
        <div><button className="primary" disabled={busy} onClick={() => run(() => api.put('/settings', { company_name: f.company_name, currency: f.currency }), 'Saved').then(refreshSettings)}>Save</button></div>
      </div>
      <div className="card stack">
        <h2>Your password</h2>
        <label className="field">Current password<input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
        <label className="field">New password<input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></label>
        <div><button disabled={busy || !pw.next} onClick={() => run(() => api.post('/auth/password', pw), 'Password changed').then((r) => r && setPw({ current: '', next: '' }))}>Change password</button></div>
      </div>
    </div>
  );
}

function Telesign() {
  const { settings, refreshSettings } = useAuth();
  const [f, setF] = useState({ telesign_customer_id: settings.telesign_customer_id, telesign_api_key: settings.telesign_api_key, default_sender_id: settings.default_sender_id, require_callback_signature: settings.require_callback_signature });
  const [run, busy] = useAction();
  const [test, setTest] = useState(null);
  const demo = settings.demo_mode === '1';
  const save = () => run(() => api.put('/settings', f), 'Telesign settings saved').then(refreshSettings);
  return (
    <div className="stack">
      <div className={`banner ${demo ? 'warning' : 'info'}`}><span className="icon">{demo ? '🧪' : '🔌'}</span><div style={{ flex: 1 }}>
        <b>{demo ? 'Demo mode is on' : settings.has_api_key ? 'Live mode' : 'Not connected'}</b>
        <span className="sub">{demo ? 'Sends are simulated and costed with your rate card. Turn demo mode off to send real messages through Telesign.' : 'Messages are sent through your Telesign account.'}</span></div>
        <button onClick={() => run(() => api.put('/settings', { demo_mode: demo ? '0' : '1' }), demo ? 'Demo mode off: live sending enabled' : 'Demo mode on').then(refreshSettings)}>{demo ? 'Switch to live' : 'Switch to demo'}</button>
      </div>
      <div className="grid cols-2">
        <div className="card stack">
          <h2>API credentials</h2>
          {settings.credentials_from_env && <p className="hint">Credentials are set in the server’s .env file and override the values below.</p>}
          <label className="field">Customer ID<input value={f.telesign_customer_id} onChange={(e) => setF({ ...f, telesign_customer_id: e.target.value })} autoComplete="off" /></label>
          <label className="field">API key<input type="password" value={f.telesign_api_key} onChange={(e) => setF({ ...f, telesign_api_key: e.target.value })} autoComplete="off" placeholder="Paste your API key" />
            <span className="hint">Find both in the Telesign Portal. Stored only in this installation’s database.</span></label>
          <label className="field">Default sender ID<input value={f.default_sender_id} onChange={(e) => setF({ ...f, default_sender_id: e.target.value })} placeholder="Optional, e.g. a registered number or alphanumeric ID" /></label>
          <div className="row"><button className="primary" onClick={save} disabled={busy}>Save</button>
            <button disabled={busy} onClick={async () => { await save(); setTest(await run(() => api.post('/settings/test-connection'))); }}>Save &amp; test connection</button></div>
          {test && <div className={`banner ${test.ok ? 'info' : 'critical'}`}><span className="icon">{test.ok ? '✅' : '⛔'}</span><div>{test.message}</div></div>}
        </div>
        <div className="card stack">
          <h2>Delivery reports &amp; replies</h2>
          <p className="sub">Ask Telesign (Portal or support) to send delivery reports and inbound messages (MO) to this URL. It must be reachable from the internet over HTTPS (set PUBLIC_URL in .env).</p>
          <label className="field">Callback URL<input readOnly value={settings.callback_url} onFocus={(e) => e.target.select()} /></label>
          <label className="check"><input type="checkbox" checked={f.require_callback_signature === '1'} onChange={(e) => setF({ ...f, require_callback_signature: e.target.checked ? '1' : '0' })} />
            Require valid Telesign signature on callbacks (recommended in production)</label>
          <p className="hint">Without callbacks, the dashboard polls Telesign for the status of messages still pending after 2 minutes.</p>
          <div><button onClick={save} disabled={busy}>Save</button></div>
        </div>
      </div>
    </div>
  );
}

function Users() {
  const { user } = useAuth();
  const list = useApi('/users');
  const [add, setAdd] = useState(null);
  const [run, busy] = useAction();
  return (
    <div className="card flush">
      <div className="card-head"><div><h2>Users</h2><p>Admins can send, change settings and manage users. Viewers can see everything but change nothing.</p></div>
        <button className="sm primary" onClick={() => setAdd({ email: '', name: '', password: '', role: 'viewer' })}><Icon name="plus" />Add user</button></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th /></tr></thead>
        <tbody>{(list.data || []).map((u) => (
          <tr key={u.id}><td>{u.name || '—'}</td><td>{u.email}</td>
            <td><select value={u.role} disabled={u.id === user.id} aria-label="Role" onChange={(e) => run(() => api.put(`/users/${u.id}`, { role: e.target.value }), 'Role updated').then(list.reload)}>
              <option value="admin">Admin</option><option value="viewer">Viewer</option></select></td>
            <td className="sub">{dateTime(u.last_login_at)}</td>
            <td>{u.id !== user.id && <div className="row" style={{ gap: 4 }}>
              <button className="sm" onClick={() => { const p = prompt('New password (min 8 characters)'); if (p) run(() => api.put(`/users/${u.id}`, { password: p }), 'Password reset'); }}>Reset password</button>
              <button className="sm danger" onClick={() => confirm(`Remove ${u.email}?`) && run(() => api.del(`/users/${u.id}`), 'User removed').then(list.reload)}>Remove</button></div>}</td></tr>
        ))}</tbody>
      </table></div>
      {add && <Modal title="Add user" onClose={() => setAdd(null)} footer={<><button onClick={() => setAdd(null)}>Cancel</button>
        <button className="primary" disabled={busy} onClick={async () => (await run(() => api.post('/users', add), 'User added')) && (setAdd(null), list.reload())}>Add</button></>}>
        <div className="form-grid">
          <label className="field">Name<input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} /></label>
          <label className="field">Email<input type="email" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} /></label>
          <label className="field">Temporary password<input type="password" autoComplete="new-password" value={add.password} onChange={(e) => setAdd({ ...add, password: e.target.value })} /></label>
          <label className="field">Role<select value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label>
        </div>
      </Modal>}
    </div>
  );
}

function ApiTokens() {
  const { settings } = useAuth();
  const list = useApi('/tokens');
  const [created, setCreated] = useState(null);
  const [run, busy] = useAction();
  const create = async () => {
    const name = prompt('Name this token (e.g. “Checkout service”)');
    if (!name) return;
    const r = await run(() => api.post('/tokens', { name }));
    if (r) { setCreated(r.token); list.reload(); }
  };
  const base = settings.gateway_url;
  return (
    <div className="stack">
      <div className="card stack">
        <h2>Gateway API</h2>
        <p className="sub">Point your own applications at the dashboard instead of calling Telesign directly. Every request is logged, costed and checked against your budgets, opt-outs and country rules before it is forwarded to Telesign.</p>
        <pre className="mono" style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 8, overflowX: 'auto', margin: 0 }}>{`# Send an SMS
curl -X POST ${base}/sms \\
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \\
  -d '{"phone_number":"+14155550123","message":"Your order shipped","message_type":"ARN"}'

# Send a verification code (SMS or voice)
curl -X POST ${base}/verify -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" -d '{"phone_number":"+14155550123","channel":"sms"}'

# Check the code the user entered
curl -X POST ${base}/verify/<reference_id>/check -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" -d '{"verify_code":"123456"}'

# Or, if you validate codes yourself, report success (keeps fraud metrics accurate)
curl -X POST ${base}/verify/<reference_id>/complete -H "Authorization: Bearer <token>"

# Phone ID lookup / message status
curl -X POST ${base}/phoneid -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"phone_number":"+14155550123"}'
curl ${base}/messages/<reference_id> -H "Authorization: Bearer <token>"`}</pre>
        <p className="hint">Blocked requests (opt-out, budget, country) return HTTP 422 with a status code 900–905 and an explanation.</p>
      </div>
      <div className="card flush">
        <div className="card-head"><h2>API tokens</h2><button className="sm primary" onClick={create} disabled={busy}><Icon name="plus" />Create token</button></div>
        {created && <div className="banner warning" style={{ margin: '0 18px 12px' }}><span className="icon">🔑</span><div style={{ minWidth: 0 }}><b>Copy this token now. It won’t be shown again.</b><code style={{ wordBreak: 'break-all' }}>{created}</code></div>
          <button className="sm" onClick={() => navigator.clipboard?.writeText(created)}>Copy</button></div>}
        <div className="table-wrap"><table>
          <thead><tr><th>Name</th><th>Token</th><th>Created</th><th>Last used</th><th /></tr></thead>
          <tbody>{(list.data || []).map((t) => (
            <tr key={t.id} style={t.revoked ? { opacity: 0.5 } : {}}><td>{t.name}</td><td className="mono">{t.prefix}…</td><td className="sub">{dateTime(t.created_at)}</td><td className="sub">{dateTime(t.last_used_at)}</td>
              <td>{t.revoked ? <span className="sub">Revoked</span> : <button className="sm danger" onClick={() => confirm('Revoke this token? Apps using it will stop working.') && run(() => api.del(`/tokens/${t.id}`), 'Token revoked').then(list.reload)}>Revoke</button>}</td></tr>
          ))}</tbody>
        </table>{list.data?.length === 0 && <Empty>No tokens yet.</Empty>}</div>
      </div>
    </div>
  );
}

function Data() {
  const { settings, refreshSettings } = useAuth();
  const [run, busy] = useAction();
  return (
    <div className="grid cols-2">
      <div className="card stack">
        <h2>Demo data</h2>
        <p className="sub">Regenerate six months of sample traffic, contacts, campaigns and alerts. This replaces all existing data, including your rate card.</p>
        <div><button disabled={busy} onClick={() => confirm('Replace ALL data with fresh demo data?') && run(() => api.post('/settings/demo/reset'), 'Demo data regenerated').then(() => { refreshSettings(); })}>Reset demo data</button></div>
      </div>
      <div className="card stack">
        <h2>Go live</h2>
        <p className="sub">Remove all demo data (messages, contacts, campaigns, alerts, sample rate card and fees) and switch to live mode. Users, API tokens and Telesign credentials are kept.</p>
        <div><button className="danger" disabled={busy} onClick={() => confirm('Delete all demo data and switch to live mode? This cannot be undone.') && run(() => api.post('/settings/demo/clear'), 'Demo data removed. Add your rate card next.').then(refreshSettings)}>
          Remove demo data &amp; go live</button></div>
        {settings.demo_mode !== '1' && <p className="hint">Live mode is active.</p>}
      </div>
      <div className="card stack">
        <h2>Your data</h2>
        <p className="sub">Everything lives in your Postgres database (Neon in production, or the embedded database in data/pglite when running locally). Exports are available on the Message log, Contacts and Reports pages.</p>
      </div>
    </div>
  );
}

function Audit() {
  const list = useApi('/audit');
  return (
    <div className="card flush"><div className="table-wrap"><table>
      <thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>{(list.data || []).map((a) => <tr key={a.id}><td className="sub" style={{ whiteSpace: 'nowrap' }}>{dateTime(a.created_at)}</td><td>{a.user}</td><td>{a.action}</td><td className="sub truncate" title={a.detail}>{a.detail}</td></tr>)}</tbody>
    </table>{list.data?.length === 0 && <Empty>No activity yet.</Empty>}</div></div>
  );
}

const TABS = [['general', 'General', General], ['telesign', 'Telesign connection', Telesign], ['users', 'Users', Users], ['api', 'Gateway API & tokens', ApiTokens], ['data', 'Data', Data], ['audit', 'Audit log', Audit]];

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'general';
  const { refreshSettings } = useAuth();
  useEffect(() => { refreshSettings(); }, [tab]);
  const Comp = TABS.find((t) => t[0] === tab)?.[2] || General;
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Settings</h1></div></div>
      <div className="tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setParams({ tab: k })}>{l}</button>)}</div>
      <Comp key={tab} />
    </div>
  );
}
