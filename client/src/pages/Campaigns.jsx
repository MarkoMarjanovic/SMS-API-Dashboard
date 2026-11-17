import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, Modal, Drawer, Empty, useAction, useAuth, Icon, StatusBadge } from '../components/ui.jsx';
import { money, num, pct, dateTime, countryName, flag } from '../format.js';
import { SmsCounter } from './Calculator.jsx';

const STATUS_STYLE = { draft: '', scheduled: 'lvl-info', running: 'st-pending', paused: 'lvl-warning', completed: 'lvl-good', cancelled: '' };
const toLocalInput = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

function Preview({ p }) {
  if (!p) return <p className="sub">Calculating…</p>;
  const ex = p.excluded;
  const overBudget = p.budget.monthly && p.budget.after > p.budget.monthly;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="grid cols-3">
        <div className="card kpi"><div className="label">Recipients</div><div className="value">{num(p.recipients)}</div><div className="foot">of {num(p.matched)} matching contacts</div></div>
        <div className="card kpi"><div className="label">Estimated cost</div><div className="value">{money(p.cost)}</div><div className="foot">{num(p.segments)} segments</div></div>
        <div className="card kpi"><div className="label">Per recipient</div><div className="value">{money(p.recipients ? p.cost / p.recipients : 0, { precise: true })}</div></div>
      </div>
      {(ex.opted_out + ex.no_consent + ex.country_blocked > 0) && (
        <p className="hint">Excluded automatically: {ex.opted_out} opted out or suppressed · {ex.no_consent} without marketing consent · {ex.country_blocked} in blocked countries</p>
      )}
      {p.unicode > 0 && <div className="banner warning"><span className="icon">⚠️</span><div>{num(p.unicode)} messages will be sent as Unicode (70 characters per segment) after personalisation.</div></div>}
      {p.multi_segment > 0 && <div className="banner warning"><span className="icon">⚠️</span><div>{num(p.multi_segment)} messages are longer than one segment and cost more.</div></div>}
      {overBudget && <div className="banner critical"><span className="icon">⛔</span><div><b>This send would exceed the monthly budget</b><span className="sub">{money(p.budget.month_spend)} spent + {money(p.cost)} = {money(p.budget.after)} vs {money(p.budget.monthly)} budget. With hard stop on, the campaign pauses when the limit is reached.</span></div></div>}
      {p.by_country.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Country</th><th className="num">Recipients</th><th className="num">Segments</th><th className="num">Est. cost</th></tr></thead>
          <tbody>{p.by_country.slice(0, 8).map((c) => <tr key={c.country}><td>{flag(c.country)} {countryName(c.country)}</td><td className="num">{num(c.recipients)}</td><td className="num">{num(c.segments)}</td><td className="num">{money(c.cost)}</td></tr>)}</tbody>
        </table></div>
      )}
      {p.samples.length > 0 && <div className="stack" style={{ gap: 6 }}><span className="sub">Sample messages</span>{p.samples.map((s, i) => <div key={i} className="sms-preview">{s.message}</div>)}</div>}
    </div>
  );
}

function Editor({ campaign, onClose, onSaved }) {
  const { settings } = useAuth();
  const tags = useApi('/contacts/tags');
  const templates = useApi('/templates');
  const [f, setF] = useState(() => ({
    name: '', body: '', message_type: 'MKT', audience_tag: '', audience_countries: '', sender_id: '', rate_per_minute: 60, respect_quiet_hours: true,
    ...campaign, scheduled_at: toLocalInput(campaign?.scheduled_at), respect_quiet_hours: campaign ? !!campaign.respect_quiet_hours : true,
  }));
  const [preview, setPreview] = useState(null);
  const [run, busy] = useAction();
  const ta = useRef();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  useEffect(() => {
    const t = setTimeout(() => api.post('/campaigns/preview', { body: f.body, message_type: f.message_type, audience_tag: f.audience_tag, audience_countries: f.audience_countries }).then(setPreview).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [f.body, f.message_type, f.audience_tag, f.audience_countries]);

  const insert = (token) => {
    const el = ta.current;
    const pos = el?.selectionStart ?? f.body.length;
    setF({ ...f, body: f.body.slice(0, pos) + token + f.body.slice(el?.selectionEnd ?? pos) });
    setTimeout(() => { el?.focus(); el?.setSelectionRange(pos + token.length, pos + token.length); });
  };
  const missingOptOut = f.message_type === 'MKT' && !/stop/i.test(f.body);

  const save = async () => {
    const body = { ...f, scheduled_at: f.scheduled_at ? new Date(f.scheduled_at).toISOString() : null };
    const r = await run(() => (campaign?.id ? api.put(`/campaigns/${campaign.id}`, body) : api.post('/campaigns', body)), 'Campaign saved');
    if (r) onSaved();
  };

  return (
    <Modal wide title={campaign?.id ? 'Edit campaign' : 'New campaign'} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={save} disabled={busy || !f.name || !f.body}>Save draft</button></>}>
      <div className="grid cols-2">
        <div className="stack">
          <label className="field">Campaign name<input value={f.name} onChange={set('name')} placeholder="e.g. December newsletter" /></label>
          <div className="form-grid">
            <label className="field">Message type<select value={f.message_type} onChange={set('message_type')}>
              <option value="MKT">Marketing (needs opt-in)</option><option value="ARN">Alerts / notifications</option></select></label>
            <label className="field">Sender ID<input value={f.sender_id || ''} onChange={set('sender_id')} placeholder={settings.default_sender_id || 'Account default'} /></label>
          </div>
          <label className="field">Message
            <div className="row" style={{ gap: 6 }}>
              {templates.data?.length > 0 && <select aria-label="Insert template" value="" onChange={(e) => e.target.value && setF({ ...f, body: templates.data.find((t) => String(t.id) === e.target.value).body })}>
                <option value="">Use template…</option>{templates.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
              {['{first_name}', '{last_name}', '{first_name|there}'].map((t) => <button type="button" key={t} className="sm" onClick={() => insert(t)}>{t}</button>)}
              {settings && <button type="button" className="sm" onClick={() => insert(' Reply STOP to opt out')}>+ opt-out text</button>}
            </div>
            <textarea ref={ta} rows={5} value={f.body} onChange={set('body')} placeholder="Hi {first_name}, …" />
            <SmsCounter text={f.body} />
            <span className="hint">Any column from your contact import can be used as {'{column_name}'}. Use {'{field|fallback}'} for missing values.</span>
          </label>
          {missingOptOut && <div className="banner warning"><span className="icon">⚠️</span><div>Marketing messages should tell people how to opt out (e.g. “Reply STOP to opt out”). In many countries this is a legal requirement.</div></div>}
          <div className="form-grid">
            <label className="field">Audience tag<select value={f.audience_tag || ''} onChange={set('audience_tag')}>
              <option value="">All contacts</option>{(tags.data || []).map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.n})</option>)}</select></label>
            <label className="field">Only these countries<input value={f.audience_countries || ''} onChange={set('audience_countries')} placeholder="e.g. US,CA (empty = all)" /></label>
            <label className="field">Send at<input type="datetime-local" value={f.scheduled_at} onChange={set('scheduled_at')} /><span className="hint">Empty = when you launch</span></label>
            <label className="field">Send rate (messages / minute)<input type="number" min="1" max="6000" value={f.rate_per_minute} onChange={set('rate_per_minute')} /></label>
          </div>
          <label className="check"><input type="checkbox" checked={f.respect_quiet_hours} onChange={set('respect_quiet_hours')} />Hold sending during quiet hours (set in Spending controls)</label>
        </div>
        <div className="stack"><h3>Audience &amp; cost preview</h3><Preview p={preview} /></div>
      </div>
    </Modal>
  );
}

function TestSend({ c, onClose }) {
  const [phones, setPhones] = useState('');
  const [results, setResults] = useState(null);
  const [run, busy] = useAction();
  const send = async () => {
    const r = await run(() => api.post(`/campaigns/${c.id}/test`, { phones: phones.split(/[\s,;]+/).filter(Boolean) }));
    if (r) setResults(r);
  };
  return (
    <Modal title={`Test “${c.name}”`} onClose={onClose} footer={<><button onClick={onClose}>Close</button><button className="primary" onClick={send} disabled={busy || !phones}>Send test</button></>}>
      <div className="stack">
        <p className="sub">Send the message to a few internal numbers first to check rendering, sender ID and delivery. Tests are prefixed with [TEST] and logged with source “test”.</p>
        <label className="field">Test numbers (up to 10)<textarea rows={3} value={phones} onChange={(e) => setPhones(e.target.value)} placeholder="+14155550123, +447700900123" /></label>
        {results && results.map((r) => <div key={r.id} className="row"><span className="mono">{r.phone}</span><StatusBadge kind={r.status_kind} code={r.status_code} /><span className="sub">{r.status_text} · {money(r.cost, { precise: true })}</span></div>)}
      </div>
    </Modal>
  );
}

function Launch({ c, onClose, onDone }) {
  const [p, setP] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { api.post(`/campaigns/${c.id}/preview`).then(setP); }, [c.id]);
  const go = async () => {
    const r = await run(() => api.post(`/campaigns/${c.id}/launch`), (x) => `Scheduled for ${num(x.recipients)} recipients`);
    if (r) onDone();
  };
  return (
    <Modal wide title={`Launch “${c.name}”`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={go} disabled={busy || !p?.recipients}><Icon name="play" />{c.scheduled_at && new Date(c.scheduled_at) > new Date() ? `Schedule for ${dateTime(c.scheduled_at)}` : 'Start sending now'}</button></>}>
      <div className="stack">
        <div className="banner info"><span className="icon">✅</span><div><b>Before you launch</b><span className="sub">Did you send a test? Opted-out and suppressed numbers are excluded automatically. Sending respects your budget, country caps and allowed countries, and pauses if a limit is reached.</span></div></div>
        <Preview p={p} />
      </div>
    </Modal>
  );
}

function CampaignDetail({ id, onClose }) {
  const d = useApi(`/campaigns/${id}`);
  const c = d.data;
  return (
    <Drawer title={c?.name || 'Campaign'} onClose={onClose}>
      {c && (
        <div className="stack">
          <div className="sms-preview">{c.body}</div>
          <div className="grid cols-2">
            <div className="card kpi"><div className="label">Sent</div><div className="value">{num(c.sent)}</div><div className="foot">{num(c.pending)} pending · {num(c.blocked)} blocked</div></div>
            <div className="card kpi"><div className="label">Delivered</div><div className="value">{pct(c.sent ? c.delivered / Math.max(1, c.delivered + c.failed) : null)}</div><div className="foot">{num(c.failed)} failed</div></div>
            <div className="card kpi"><div className="label">Cost</div><div className="value">{money(c.actual_cost)}</div><div className="foot">estimated {money(c.estimated_cost)}</div></div>
            <div className="card kpi"><div className="label">Replies</div><div className="value">{num(c.replies)}</div><div className="foot">{num(c.optouts)} opt-outs ({pct(c.sent ? c.optouts / c.sent : null, 2)})</div></div>
          </div>
          <div className="table-wrap"><table>
            <thead><tr><th>Country</th><th className="num">Sent</th><th className="num">Delivered</th><th className="num">Cost</th></tr></thead>
            <tbody>{c.by_country.map((x) => <tr key={x.country}><td>{flag(x.country)} {countryName(x.country)}</td><td className="num">{num(x.n)}</td><td className="num">{pct(x.delivered / Math.max(1, x.delivered + x.failed))}</td><td className="num">{money(x.cost)}</td></tr>)}</tbody>
          </table></div>
          {c.note && <div className="banner warning">{c.note}</div>}
          <Link to={`/messages?campaign=${c.id}`}>Open the message log for this campaign →</Link>
        </div>
      )}
    </Drawer>
  );
}

export default function Campaigns() {
  const { isAdmin } = useAuth();
  const list = useApi('/campaigns');
  const [edit, setEdit] = useState(null);
  const [test, setTest] = useState(null);
  const [launch, setLaunch] = useState(null);
  const [detail, setDetail] = useState(null);
  const [run] = useAction();
  useEffect(() => {
    if (!(list.data || []).some((c) => ['running', 'scheduled'].includes(c.status))) return;
    const t = setInterval(list.reload, 5000);
    return () => clearInterval(t);
  }, [list.data]);
  const act = (c, a) => run(() => api.post(`/campaigns/${c.id}/${a}`), `Campaign ${a === 'cancel' ? 'cancelled' : a + 'd'}`).then(list.reload);
  const del = (c) => confirm(`Delete “${c.name}”?`) && run(() => api.del(`/campaigns/${c.id}`), 'Deleted').then(list.reload);

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Campaigns</h1><p>Personalised bulk sends with consent checks, cost preview, test sends and scheduling</p></div>
        {isAdmin && <button className="primary" onClick={() => setEdit({})}><Icon name="plus" />New campaign</button>}
      </div>
      <div className="card flush">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Campaign</th><th>Status</th><th>Progress</th><th className="num">Delivered</th><th className="num">Opt-outs</th><th className="num">Cost</th><th>When</th><th /></tr></thead>
            <tbody>
              {(list.data || []).map((c) => {
                const done = c.sent;
                const total = c.total || done + c.pending;
                return (
                  <tr key={c.id}>
                    <td><a href="#" onClick={(e) => { e.preventDefault(); setDetail(c.id); }}><b>{c.name}</b></a><div className="sub truncate">{c.body}</div></td>
                    <td><span className={`badge ${STATUS_STYLE[c.status]}`}>{c.status}</span>{c.note && <div className="hint">{c.note}</div>}</td>
                    <td>{total ? <div className="row" style={{ gap: 8 }}><div className="progress"><span style={{ width: `${(done / total) * 100}%` }} /></div><span className="sub">{num(done)}/{num(total)}</span></div> : <span className="sub">—</span>}</td>
                    <td className="num">{c.sent ? pct(c.delivered / Math.max(1, c.delivered + c.failed)) : '—'}</td>
                    <td className="num">{c.sent ? num(c.optouts) : '—'}</td>
                    <td className="num">{c.sent ? money(c.actual_cost) : c.estimated_cost ? `~${money(c.estimated_cost)}` : '—'}</td>
                    <td className="sub" style={{ whiteSpace: 'nowrap' }}>{dateTime(c.started_at || c.scheduled_at || c.created_at)}</td>
                    <td>{isAdmin && <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                      {c.status === 'draft' && <><button className="sm" onClick={() => setEdit(c)}>Edit</button><button className="sm" onClick={() => setTest(c)}>Test</button><button className="sm primary" onClick={() => setLaunch(c)}>Launch</button><button className="sm ghost danger" onClick={() => del(c)} aria-label="Delete"><Icon name="trash" /></button></>}
                      {['running', 'scheduled'].includes(c.status) && <><button className="sm" onClick={() => act(c, 'pause')}><Icon name="pause" />Pause</button><button className="sm danger" onClick={() => act(c, 'cancel')}>Cancel</button></>}
                      {c.status === 'paused' && <><button className="sm" onClick={() => setEdit(c)}>Edit</button><button className="sm primary" onClick={() => act(c, 'resume')}><Icon name="play" />Resume</button><button className="sm danger" onClick={() => act(c, 'cancel')}>Cancel</button></>}
                    </div>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {list.data?.length === 0 && <Empty>No campaigns yet. Import contacts first, then create a campaign.</Empty>}
        </div>
      </div>
      {edit && <Editor campaign={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
      {test && <TestSend c={test} onClose={() => setTest(null)} />}
      {launch && <Launch c={launch} onClose={() => setLaunch(null)} onDone={() => { setLaunch(null); list.reload(); }} />}
      {detail && <CampaignDetail id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
