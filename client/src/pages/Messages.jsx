import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useApi, StatusBadge, Pager, Modal, Empty, useAction, useAuth, Icon } from '../components/ui.jsx';
import { DateRangePicker, useRange } from '../components/DateRange.jsx';
import { money, num, dateTime, countryName, flag, productLabel, downloadUrl } from '../format.js';
import { PRODUCTS } from '@shared/products.js';
import { analyzeSms } from '@shared/sms.js';
import { SmsCounter } from './Calculator.jsx';

const LIMIT = 50;

function QuickSend({ onClose, onSent }) {
  const { settings } = useAuth();
  const [f, setF] = useState({ product: 'sms', phone: '', message: '', message_type: 'ARN' });
  const [run, busy] = useAction();
  const [result, setResult] = useState(null);
  const send = async () => {
    const r = await run(() => api.post('/send', f));
    if (r) { setResult(r); onSent(); }
  };
  return (
    <Modal title="Send a message" onClose={onClose} footer={<><button onClick={onClose}>Close</button><button className="primary" onClick={send} disabled={busy || !f.phone}><Icon name="send" />Send</button></>}>
      <div className="stack">
        {settings.demo_mode === '1' && <div className="banner warning"><span className="icon">🧪</span><div>Demo mode is on: the message is simulated and costed, not delivered.</div></div>}
        <div className="form-grid">
          <label className="field">Product<select value={f.product} onChange={(e) => setF({ ...f, product: e.target.value })}>
            <option value="sms">SMS</option><option value="verify_sms">SMS Verify (one-time code)</option><option value="verify_voice">Voice Verify</option><option value="phoneid">Phone ID lookup</option></select></label>
          <label className="field">Phone number<input placeholder="+14155550123" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /><span className="hint">International format</span></label>
          {f.product === 'sms' && <label className="field">Message type<select value={f.message_type} onChange={(e) => setF({ ...f, message_type: e.target.value })}>
            <option value="ARN">ARN: alerts, reminders, notifications</option><option value="OTP">OTP: one-time passwords</option><option value="MKT">MKT: marketing</option></select></label>}
        </div>
        {f.product === 'sms' && <label className="field">Message<textarea value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /><SmsCounter text={f.message} /></label>}
        {result && (
          <div className="banner info"><div>
            <b><StatusBadge kind={result.status_kind} code={result.status_code} /> {result.status_text}</b>
            <span className="sub">Reference {result.reference_id || '—'} · cost {money(result.cost, { precise: true })}{result.demo_code ? ` · demo code ${result.demo_code}` : ''}</span>
            {result.result && <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>{JSON.stringify(result.result, null, 2)}</pre>}
          </div></div>
        )}
      </div>
    </Modal>
  );
}

function Detail({ m, onClose }) {
  const a = m.message ? analyzeSms(m.message) : null;
  return (
    <Modal title="Message details" onClose={onClose}>
      <div className="stack">
        <dl className="kv">
          <dt>When</dt><dd>{dateTime(m.created_at)}</dd>
          <dt>Product</dt><dd>{productLabel(m.product)}{m.message_type ? ` · ${m.message_type}` : ''}</dd>
          <dt>To</dt><dd className="mono">{m.phone || '—'} {m.country && `${flag(m.country)} ${countryName(m.country)}`}</dd>
          <dt>Status</dt><dd><StatusBadge kind={m.status_kind} code={m.status_code} /> {m.status_text}</dd>
          {m.advice && <><dt>What to do</dt><dd>{m.advice}</dd></>}
          <dt>Cost</dt><dd>{money(m.cost, { precise: true })} <span className="sub">({m.cost_source === 'telesign' ? 'reported by Telesign' : m.cost_source === 'invoice' ? 'from imported invoice' : 'from your rate card'})</span></dd>
          <dt>Segments</dt><dd>{m.segments}{m.encoding ? ` · ${m.encoding}` : ''}</dd>
          {m.verified !== null && <><dt>Verification</dt><dd>{m.verified ? '✓ Code entered' : 'Not completed'}</dd></>}
          {m.campaign_name && <><dt>Campaign</dt><dd>{m.campaign_name}</dd></>}
          <dt>Reference ID</dt><dd className="mono">{m.reference_id || '—'}</dd>
          <dt>Source</dt><dd>{m.source}</dd>
        </dl>
        {m.message && <div><div className="sms-preview">{m.message}</div>
          {a?.unicodeChars.length > 0 && <p className="hint" style={{ marginTop: 6 }}>Sent as UCS-2 because of: {a.unicodeChars.join(' ')}</p>}</div>}
      </div>
    </Modal>
  );
}

export default function Messages() {
  const { range } = useRange();
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState(params.get('q') || '');
  const [send, setSend] = useState(false);
  const [detail, setDetail] = useState(null);
  const filters = { product: params.get('product') || '', country: params.get('country') || '', status: params.get('status') || '', source: params.get('source') || '', campaign: params.get('campaign') || '', q: params.get('q') || '' };
  const query = qs({ from: range.from, to: range.to, ...filters });
  const data = useApi('/messages' + query + `&limit=${LIMIT}&offset=${offset}`);
  useEffect(() => setOffset(0), [query]);
  useEffect(() => {
    const t = setTimeout(() => setFilter('q', search), 350);
    return () => clearTimeout(t);
  }, [search]);
  function setFilter(k, v) {
    const p = new URLSearchParams(params);
    v ? p.set(k, v) : p.delete(k);
    if (p.toString() !== params.toString()) setParams(p);
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Message log</h1><p>Every request sent, imported or blocked, with delivery status and cost</p></div>
        <div className="toolbar">
          <DateRangePicker />
          <button onClick={() => downloadUrl('/messages/export.csv' + query)}><Icon name="download" />Export CSV</button>
          {isAdmin && <button className="primary" onClick={() => setSend(true)}><Icon name="send" />Send message</button>}
        </div>
      </div>
      <div className="card row" style={{ gap: 8 }}>
        <input type="search" placeholder="Search number, text or reference…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: '1 1 240px' }} aria-label="Search" />
        <select value={filters.product} onChange={(e) => setFilter('product', e.target.value)} aria-label="Product"><option value="">All products</option>
          {Object.entries(PRODUCTS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</select>
        <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} aria-label="Status"><option value="">Any status</option>
          {['delivered', 'failed', 'pending', 'blocked', 'unknown', 'imported'].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select>
        <select value={filters.source} onChange={(e) => setFilter('source', e.target.value)} aria-label="Source"><option value="">Any source</option>
          {['campaign', 'gateway', 'app', 'reply', 'test', 'import', 'demo'].map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <input placeholder="Country (e.g. US)" value={filters.country} onChange={(e) => setFilter('country', e.target.value.toUpperCase())} style={{ width: 140 }} aria-label="Country code" />
        {(filters.product || filters.status || filters.country || filters.source || filters.campaign || filters.q) && <button className="ghost" onClick={() => { setSearch(''); setParams({}); }}>Clear filters</button>}
      </div>
      <div className="card flush">
        <div className="card-head"><h2>{data.data ? `${num(data.data.total)} records` : 'Loading…'}</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Product</th><th>To</th><th>Message</th><th>Status</th><th className="num">Seg.</th><th className="num">Cost</th></tr></thead>
            <tbody>
              {(data.data?.rows || []).map((m) => (
                <tr key={m.id} className="clickable" onClick={() => setDetail(m)}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dateTime(m.created_at)}</td>
                  <td>{productLabel(m.product)}</td>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>{flag(m.country)} {m.phone || m.country || '—'}</td>
                  <td className="truncate">{m.campaign_name && <span className="badge" style={{ marginRight: 6 }}>{m.campaign_name}</span>}{m.message || <span className="sub">{m.source === 'import' ? `${num(m.units)} units (imported)` : '—'}</span>}</td>
                  <td><StatusBadge kind={m.status_kind} code={m.status_code} text={m.status_text} /></td>
                  <td className="num">{m.segments || '—'}</td>
                  <td className="num">{money(m.cost, { precise: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.data?.rows.length === 0 && <Empty>No messages match these filters.</Empty>}
        </div>
        {data.data && <Pager total={data.data.total} offset={offset} limit={LIMIT} onChange={setOffset} />}
      </div>
      {send && <QuickSend onClose={() => setSend(false)} onSent={data.reload} />}
      {detail && <Detail m={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
