import { Fragment, useEffect, useState } from 'react';
import { api, qs } from '../api.js';
import { useApi, Modal, Pager, Empty, useAction, useAuth, Icon, Kpi } from '../components/ui.jsx';
import CsvImport from '../components/CsvImport.jsx';
import { num, dateTime, countryName, flag, downloadUrl } from '../format.js';

const LIMIT = 50;
const CONSENT = { opted_in: ['lvl-good', '✓ Opted in'], opted_out: ['lvl-critical', '✕ Opted out'], unknown: ['', '? Unknown'] };

function ImportModal({ onClose, onDone }) {
  const [opts, setOpts] = useState({ default_country: '', consent_status: 'opted_in', consent_source: 'import', tags: '' });
  const [run, busy] = useAction();
  const [result, setResult] = useState(null);
  const fields = [
    { key: 'phone', label: 'Phone number', required: true, guess: /phone|mobile|msisdn|number|cell|tel/i },
    { key: 'first_name', label: 'First name', guess: /first|given|^name$/i },
    { key: 'last_name', label: 'Last name', guess: /last|surname|family/i },
    { key: 'email', label: 'Email', guess: /mail/i },
    { key: 'tags', label: 'Tags', guess: /tag|segment|group|list/i, hint: 'Comma or ; separated' },
    { key: 'consent_status', label: 'Consent status', guess: /consent|opt/i, hint: 'opted_in / opted_out / unknown' },
    { key: 'consent_at', label: 'Consent date', guess: /consent.*(date|time|at)/i },
  ];
  return (
    <Modal wide title="Import contacts" onClose={onClose}>
      {result ? (
        <div className="stack">
          <div className="banner info"><span className="icon">✅</span><div><b>{num(result.inserted)} added, {num(result.updated)} updated</b>
            <span className="sub">{num(result.invalid)} rows had invalid phone numbers{result.suppressed ? ` · ${result.suppressed} opted out (added to suppression list)` : ''}</span></div></div>
          {result.invalid_rows.length > 0 && <p className="hint">Invalid rows (first 20): {result.invalid_rows.map((r) => `row ${r.row}: “${r.phone}”`).join(', ')}</p>}
          <div className="row"><button className="primary" onClick={onDone}>Done</button></div>
        </div>
      ) : (
        <CsvImport fields={fields} keepExtra busy={busy} onImport={async (rows) => {
          const r = await run(() => api.post('/contacts/import', { rows, ...opts }));
          if (r) setResult(r);
          return !!r;
        }}>
          <div className="form-grid">
            <label className="field">Default country<input placeholder="e.g. US" value={opts.default_country} onChange={(e) => setOpts({ ...opts, default_country: e.target.value.toUpperCase() })} />
              <span className="hint">For numbers without a +country code</span></label>
            <label className="field">Consent for rows without a status<select value={opts.consent_status} onChange={(e) => setOpts({ ...opts, consent_status: e.target.value })}>
              <option value="opted_in">Opted in (I have consent records)</option><option value="unknown">Unknown (transactional only)</option></select></label>
            <label className="field">Consent source<input value={opts.consent_source} onChange={(e) => setOpts({ ...opts, consent_source: e.target.value })} placeholder="e.g. checkout, web-form" /></label>
            <label className="field">Add tags<input value={opts.tags} onChange={(e) => setOpts({ ...opts, tags: e.target.value })} placeholder="e.g. customers" /></label>
          </div>
        </CsvImport>
      )}
    </Modal>
  );
}

function ContactModal({ c, onClose, onSaved }) {
  const [f, setF] = useState(c);
  const [run, busy] = useAction();
  const { isAdmin } = useAuth();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  let custom = {};
  try { custom = JSON.parse(c.custom || '{}'); } catch {}
  const save = async () => (await run(() => api.put(`/contacts/${c.id}`, f), 'Contact saved')) && onSaved();
  const del = async () => confirm('Delete this contact? Their suppression entry (if any) is kept.') && (await run(() => api.del(`/contacts/${c.id}`), 'Deleted')) && onSaved();
  return (
    <Modal title={c.phone} onClose={onClose} footer={isAdmin && <><button className="danger" onClick={del}>Delete</button><span className="spacer" /><button onClick={onClose}>Cancel</button><button className="primary" onClick={save} disabled={busy}>Save</button></>}>
      <div className="stack">
        <div className="form-grid">
          <label className="field">First name<input value={f.first_name || ''} onChange={set('first_name')} disabled={!isAdmin} /></label>
          <label className="field">Last name<input value={f.last_name || ''} onChange={set('last_name')} disabled={!isAdmin} /></label>
          <label className="field">Email<input value={f.email || ''} onChange={set('email')} disabled={!isAdmin} /></label>
          <label className="field">Tags<input value={f.tags || ''} onChange={set('tags')} disabled={!isAdmin} /></label>
          <label className="field">Consent<select value={f.consent_status} onChange={set('consent_status')} disabled={!isAdmin}>
            <option value="opted_in">Opted in</option><option value="unknown">Unknown</option><option value="opted_out">Opted out</option></select></label>
        </div>
        <dl className="kv">
          <dt>Country</dt><dd>{flag(c.country)} {countryName(c.country)}</dd>
          <dt>Consent source</dt><dd>{c.consent_source || '—'}</dd>
          <dt>Consent recorded</dt><dd>{dateTime(c.consent_at)}</dd>
          {c.opted_out_at && <><dt>Opted out</dt><dd>{dateTime(c.opted_out_at)}</dd></>}
          <dt>Added</dt><dd>{dateTime(c.created_at)}</dd>
          {Object.entries(custom).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{String(v)}</dd></Fragment>)}
        </dl>
      </div>
    </Modal>
  );
}

function Suppression() {
  const { isAdmin } = useAuth();
  const [q, setQ] = useState('');
  const list = useApi('/suppression' + qs({ q }));
  const [add, setAdd] = useState('');
  const [run, busy] = useAction();
  const addNumbers = async () => {
    const r = await run(() => api.post('/suppression', { phones: add.split(/[\s,;]+/).filter(Boolean), reason: 'manual' }), (x) => `${x.added} added${x.invalid ? `, ${x.invalid} invalid` : ''}`);
    if (r) { setAdd(''); list.reload(); }
  };
  return (
    <div className="stack">
      <p className="sub">Numbers on this list never receive marketing or notification SMS from this dashboard (one-time passcodes are still allowed). People are added automatically when they reply with an opt-out keyword such as STOP.</p>
      {isAdmin && <div className="card row">
        <input style={{ flex: 1 }} placeholder="Add numbers: +14155550123, +447700900123" value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Numbers to suppress" />
        <button onClick={addNumbers} disabled={busy || !add}>Add to suppression list</button>
      </div>}
      <div className="card flush">
        <div className="card-head"><h2>{list.data ? `${num(list.data.length)} suppressed numbers` : '…'}</h2>
          <div className="row"><input type="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
            <button onClick={() => downloadUrl('/suppression/export.csv')}><Icon name="download" />Export</button></div></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Phone</th><th>Reason</th><th>Source</th><th>Note</th><th>Since</th><th /></tr></thead>
          <tbody>{(list.data || []).map((s) => (
            <tr key={s.phone}><td className="mono">{s.phone}</td><td>{s.reason}</td><td>{s.source}</td><td className="sub">{s.note}</td><td>{dateTime(s.created_at)}</td>
              <td>{isAdmin && <button className="sm" onClick={() => confirm(`Remove ${s.phone}? Only do this if the person has opted in again.`) && run(() => api.del(`/suppression/${encodeURIComponent(s.phone)}`), 'Removed').then(list.reload)}>Remove</button>}</td></tr>
          ))}</tbody>
        </table>{list.data?.length === 0 && <Empty>No suppressed numbers.</Empty>}</div>
      </div>
    </div>
  );
}

export default function Contacts() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState('contacts');
  const [filters, setFilters] = useState({ q: '', tag: '', consent: '', country: '' });
  const [offset, setOffset] = useState(0);
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState(null);
  const query = qs(filters);
  const list = useApi(`/contacts${query}${query ? '&' : '?'}limit=${LIMIT}&offset=${offset}`);
  const tags = useApi('/contacts/tags');
  useEffect(() => setOffset(0), [query]);
  const s = list.data?.summary;
  const set = (k) => (e) => setFilters({ ...filters, [k]: k === 'country' ? e.target.value.toUpperCase() : e.target.value });

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Contacts &amp; consent</h1><p>Your audience, consent records and the suppression list</p></div>
        <div className="toolbar">
          <button onClick={() => downloadUrl('/contacts/export.csv')}><Icon name="download" />Export consent records</button>
          {isAdmin && <button className="primary" onClick={() => setImporting(true)}><Icon name="upload" />Import CSV</button>}
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button className={tab === 'contacts' ? 'on' : ''} onClick={() => setTab('contacts')} role="tab" aria-selected={tab === 'contacts'}>Contacts</button>
        <button className={tab === 'suppression' ? 'on' : ''} onClick={() => setTab('suppression')} role="tab" aria-selected={tab === 'suppression'}>Suppression list</button>
      </div>
      {tab === 'suppression' ? <Suppression /> : (
        <>
          {s && <div className="grid cols-4">
            <Kpi label="Contacts" value={num(s.total)} />
            <Kpi label="Opted in" value={num(s.opted_in)} foot="Can receive marketing" />
            <Kpi label="Consent unknown" value={num(s.unknown)} foot="Transactional messages only" />
            <Kpi label="Opted out" value={num(s.opted_out)} foot="Never messaged" />
          </div>}
          <div className="card row" style={{ gap: 8 }}>
            <input type="search" placeholder="Search name, number, email…" value={filters.q} onChange={set('q')} style={{ flex: '1 1 220px' }} aria-label="Search" />
            <select value={filters.tag} onChange={set('tag')} aria-label="Tag"><option value="">All tags</option>{(tags.data || []).map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.n})</option>)}</select>
            <select value={filters.consent} onChange={set('consent')} aria-label="Consent"><option value="">Any consent</option><option value="opted_in">Opted in</option><option value="unknown">Unknown</option><option value="opted_out">Opted out</option></select>
            <input placeholder="Country" value={filters.country} onChange={set('country')} style={{ width: 100 }} aria-label="Country" />
          </div>
          <div className="card flush">
            <div className="table-wrap"><table>
              <thead><tr><th>Name</th><th>Phone</th><th>Country</th><th>Tags</th><th>Consent</th><th>Source</th><th>Added</th></tr></thead>
              <tbody>{(list.data?.rows || []).map((c) => (
                <tr key={c.id} className="clickable" onClick={() => setOpen(c)}>
                  <td>{[c.first_name, c.last_name].filter(Boolean).join(' ') || <span className="sub">—</span>}</td>
                  <td className="mono">{c.phone}</td>
                  <td>{flag(c.country)} {c.country}</td>
                  <td><div className="pill-list">{c.tags.split(',').filter(Boolean).map((t) => <span key={t} className="badge">{t}</span>)}</div></td>
                  <td><span className={`badge ${CONSENT[c.consent_status][0]}`}>{CONSENT[c.consent_status][1]}</span></td>
                  <td className="sub">{c.consent_source || '—'}</td>
                  <td className="sub">{dateTime(c.created_at)}</td>
                </tr>
              ))}</tbody>
            </table>{list.data?.rows.length === 0 && <Empty>No contacts found. Import a CSV to get started.</Empty>}</div>
            {list.data && <Pager total={list.data.total} offset={offset} limit={LIMIT} onChange={setOffset} />}
          </div>
        </>
      )}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={() => { setImporting(false); list.reload(); tags.reload(); }} />}
      {open && <ContactModal c={open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); list.reload(); }} />}
    </div>
  );
}
