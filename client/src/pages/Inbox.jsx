import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApi, Empty, useAction, useAuth, StatusBadge, Icon } from '../components/ui.jsx';
import { ago, dateTime, flag, money } from '../format.js';
import { SmsCounter } from './Calculator.jsx';

function Thread({ phone, onChanged }) {
  const { isAdmin } = useAuth();
  const t = useApi(`/inbox/${encodeURIComponent(phone)}`);
  const [msg, setMsg] = useState('');
  const [run, busy] = useAction();
  const end = useRef();
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [t.data]);
  useEffect(() => { if (t.data) onChanged(); }, [t.data?.phone]);
  const d = t.data;
  const send = async () => {
    const r = await run(() => api.post(`/inbox/${encodeURIComponent(phone)}/reply`, { message: msg }), (x) => x.status_kind === 'blocked' ? `Not sent: ${x.status_text}` : 'Reply sent');
    if (r) { setMsg(''); t.reload(); }
  };
  const toggleSuppress = async () => {
    await run(() => (d.suppressed ? api.del(`/suppression/${encodeURIComponent(phone)}`) : api.post('/suppression', { phone, reason: 'manual' })), d.suppressed ? 'Removed from suppression list' : 'Number suppressed');
    t.reload(); onChanged();
  };
  if (!d) return <div className="card"><p className="sub">Loading…</p></div>;
  return (
    <div className="card stack" style={{ minHeight: 480 }}>
      <div className="row">
        <div><h2>{d.contact ? `${d.contact.first_name || ''} ${d.contact.last_name || ''}`.trim() || phone : phone}</h2>
          <span className="sub mono">{phone}</span>{d.contact && <span className="sub"> · consent: {d.contact.consent_status.replace('_', ' ')}</span>}</div>
        <span className="spacer" />
        {d.suppressed && <span className="badge lvl-critical">✕ Opted out</span>}
        {isAdmin && <button className="sm" onClick={toggleSuppress}>{d.suppressed ? 'Re-subscribe' : 'Suppress number'}</button>}
      </div>
      <div className="thread" style={{ flex: 1, overflowY: 'auto', maxHeight: 520 }}>
        {d.messages.map((m, i) => (
          <div key={i} className={m.dir === 'out' ? 'out-wrap' : ''}>
            <div className={`sms-preview ${m.dir === 'out' ? 'out' : ''}`}>{m.body}</div>
            <div className="meta">{dateTime(m.at)}{m.dir === 'out' && <> · <StatusBadge kind={m.status_kind} /> · {money(m.cost, { precise: true })}</>}{m.is_optout ? ' · opt-out keyword' : ''}</div>
          </div>
        ))}
        <div ref={end} />
      </div>
      {isAdmin && (d.suppressed
        ? <p className="hint">This number opted out, so replies are blocked. If they text START, they are re-subscribed automatically.</p>
        : <div className="stack" style={{ gap: 6 }}>
            <textarea rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Write a reply…" aria-label="Reply" />
            <div className="row"><SmsCounter text={msg} /><span className="spacer" /><button className="primary" onClick={send} disabled={busy || !msg}><Icon name="send" />Send reply</button></div>
          </div>)}
    </div>
  );
}

export default function Inbox() {
  const { refreshCounts } = useAuth();
  const [filter, setFilter] = useState('all');
  const list = useApi(`/inbox?filter=${filter}`);
  const [sel, setSel] = useState(null);
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Inbox</h1><p>Replies from your recipients. STOP / START keywords are processed automatically.</p></div>
        <div className="segmented">{[['all', 'All'], ['unread', 'Unread'], ['optout', 'Opt-outs']].map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}</div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(260px, 360px) minmax(0, 1fr)' }}>
        <div className="card flush" style={{ maxHeight: 640, overflowY: 'auto' }}>
          {(list.data || []).map((c) => (
            <div key={c.phone} onClick={() => setSel(c.phone)} className="clickable" role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(c.phone)}
              style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: sel === c.phone ? 'var(--accent-soft)' : undefined, cursor: 'pointer' }}>
              <div className="row" style={{ gap: 6 }}>
                <b style={{ fontWeight: c.unread ? 700 : 500 }}>{flag(c.country)} {c.name?.trim() || c.phone}</b>
                <span className="spacer" />
                {c.unread > 0 && <span className="badge accent">{c.unread}</span>}
                <span className="sub">{ago(c.last_at)}</span>
              </div>
              <div className="sub truncate">{c.suppressed ? '✕ ' : ''}{c.last_body}</div>
            </div>
          ))}
          {list.data?.length === 0 && <Empty>No replies yet. Point your Telesign inbound callback to this dashboard (Settings → Telesign).</Empty>}
        </div>
        {sel ? <Thread key={sel} phone={sel} onChanged={() => { list.reload(); refreshCounts(); }} /> : <div className="card"><Empty>Select a conversation</Empty></div>}
      </div>
    </div>
  );
}
