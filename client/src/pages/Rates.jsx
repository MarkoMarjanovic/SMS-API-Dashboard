import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, Modal, Empty, useAction, useAuth, Icon } from '../components/ui.jsx';
import CsvImport from '../components/CsvImport.jsx';
import { money, countryName, flag, productLabel, allCountries } from '../format.js';
import { PRODUCTS } from '@shared/products.js';
import { fixedMonthly } from './rates-util.js';

function RateCard() {
  const { isAdmin } = useAuth();
  const rates = useApi('/rates');
  const [product, setProduct] = useState('sms');
  const [edits, setEdits] = useState({});
  const [adding, setAdding] = useState({ country: '', price: '', carrier_fee: '' });
  const [importing, setImporting] = useState(false);
  const [reprice, setReprice] = useState(false);
  const [run, busy] = useAction();
  const rows = (rates.data || []).filter((r) => r.product === product);
  const dirty = Object.keys(edits).length > 0;

  const save = async () => {
    const changed = Object.entries(edits).map(([id, e]) => ({ ...rows.find((r) => String(r.id) === id), ...e }));
    if (await run(() => api.put('/rates', changed), 'Rates saved')) { setEdits({}); rates.reload(); }
  };
  const add = async () => {
    if (await run(() => api.put('/rates', [{ product, ...adding }]), 'Rate added')) { setAdding({ country: '', price: '', carrier_fee: '' }); rates.reload(); }
  };
  const edit = (r, k, v) => setEdits({ ...edits, [r.id]: { ...edits[r.id], [k]: v } });
  const val = (r, k) => edits[r.id]?.[k] ?? r[k];

  return (
    <div className="stack">
      <p className="sub">Enter the prices from your Telesign contract. All costs in this dashboard are calculated from these rates unless Telesign reports a price for a transaction. Use the <b>*</b> row as the default for countries without a specific rate.</p>
      <div className="row">
        <div className="segmented">{Object.entries(PRODUCTS).map(([k, p]) => <button key={k} className={product === k ? 'on' : ''} onClick={() => setProduct(k)}>{p.label}</button>)}</div>
        <span className="spacer" />
        {isAdmin && <><button onClick={() => setImporting(true)}><Icon name="upload" />Import rate card</button><button onClick={() => setReprice(true)}>Re-price history…</button></>}
      </div>
      <div className="card flush">
        <div className="card-head"><h2>{productLabel(product)}: price per {PRODUCTS[product].unit}</h2>{isAdmin && dirty && <button className="primary sm" onClick={save} disabled={busy}>Save changes</button>}</div>
        <div className="table-wrap"><table>
          <thead><tr><th>Country</th><th className="num">Telesign price</th><th className="num">Carrier fee</th><th className="num">Total / {PRODUCTS[product].unit}</th><th>Note</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.country === '*' ? '🌐 Default (all other countries)' : `${flag(r.country)} ${countryName(r.country)}`}</td>
                <td className="num"><input type="number" step="0.0001" min="0" style={{ width: 100 }} value={val(r, 'price')} disabled={!isAdmin} aria-label="Price" onChange={(e) => edit(r, 'price', e.target.value)} /></td>
                <td className="num"><input type="number" step="0.0001" min="0" style={{ width: 90 }} value={val(r, 'carrier_fee')} disabled={!isAdmin} aria-label="Carrier fee" onChange={(e) => edit(r, 'carrier_fee', e.target.value)} /></td>
                <td className="num">{money(Number(val(r, 'price')) + Number(val(r, 'carrier_fee')), { precise: true })}</td>
                <td className="sub">{r.note}</td>
                <td>{isAdmin && <button className="ghost sm" aria-label="Delete" onClick={() => run(() => api.del(`/rates/${r.id}`)).then(rates.reload)}><Icon name="trash" /></button>}</td>
              </tr>
            ))}
            {isAdmin && (
              <tr>
                <td><select value={adding.country} aria-label="Country" onChange={(e) => setAdding({ ...adding, country: e.target.value })}>
                  <option value="">Add country…</option><option value="*">Default (*)</option>{allCountries().map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></td>
                <td className="num"><input type="number" step="0.0001" min="0" style={{ width: 100 }} value={adding.price} aria-label="New price" onChange={(e) => setAdding({ ...adding, price: e.target.value })} /></td>
                <td className="num"><input type="number" step="0.0001" min="0" style={{ width: 90 }} value={adding.carrier_fee} aria-label="New carrier fee" onChange={(e) => setAdding({ ...adding, carrier_fee: e.target.value })} /></td>
                <td colSpan={3}><button className="sm" onClick={add} disabled={!adding.country || adding.price === ''}>Add rate</button></td>
              </tr>
            )}
          </tbody>
        </table>{rates.data && !rows.length && <Empty>No rates for this product yet.</Empty>}</div>
      </div>
      {importing && (
        <Modal wide title="Import rate card" onClose={() => setImporting(false)}>
          <CsvImport busy={busy} submitLabel="Import" fields={[
            { key: 'country', label: 'Country (ISO code)', required: true, guess: /country|iso|dest/i, hint: 'ISO code (US) or name (United States); * = default' },
            { key: 'price', label: 'Price', required: true, guess: /price|rate|cost/i },
            { key: 'product', label: 'Product', guess: /product|service|type/i, hint: `If missing, rows are imported as ${productLabel(product)}` },
            { key: 'carrier_fee', label: 'Carrier fee', guess: /carrier|surcharge|fee/i },
          ]} onImport={async (rowsIn) => {
            const r = await run(() => api.put('/rates', rowsIn.map((x) => ({ product, ...x, product: x.product || product }))), (x) => `${x.updated} rates imported${x.skipped ? `, ${x.skipped} skipped` : ''}`);
            if (r) { setImporting(false); rates.reload(); }
            return !!r;
          }} />
        </Modal>
      )}
      {reprice && <Reprice onClose={() => setReprice(false)} />}
    </div>
  );
}

function Reprice({ onClose }) {
  const [f, setF] = useState({ from: new Date().toISOString().slice(0, 8) + '01', to: new Date().toISOString().slice(0, 10) });
  const [run, busy] = useAction();
  return (
    <Modal title="Re-price historical usage" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy} onClick={async () => (await run(() => api.post('/rates/reprice', f), (x) => `${x.repriced} transactions re-priced`)) && onClose()}>Re-price</button></>}>
      <div className="stack">
        <p className="sub">Recalculate the cost of past transactions with the current rate card, for example after you negotiate new prices or fix a wrong rate. Transactions priced by Telesign or from an imported invoice are not changed.</p>
        <div className="form-grid">
          <label className="field">From<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
          <label className="field">To<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        </div>
      </div>
    </Modal>
  );
}

function FixedCosts() {
  const { isAdmin } = useAuth();
  const list = useApi('/fixed-costs');
  const [edit, setEdit] = useState(null);
  const [run, busy] = useAction();
  const monthly = (list.data || []).reduce((a, f) => a + fixedMonthly(f), 0);
  const save = async () => {
    const r = await run(() => (edit.id ? api.put(`/fixed-costs/${edit.id}`, edit) : api.post('/fixed-costs', edit)), 'Saved');
    if (r) { setEdit(null); list.reload(); }
  };
  return (
    <div className="stack">
      <p className="sub">Costs that are not per message: number rental, sender registrations (10DLC, toll-free verification, alphanumeric sender IDs), setup fees and support plans. They are included in reports and the monthly total.</p>
      <div className="card flush">
        <div className="card-head"><h2>Recurring ≈ {money(monthly)} / month</h2>{isAdmin && <button className="sm primary" onClick={() => setEdit({ name: '', category: 'numbers', amount: '', frequency: 'monthly', start_date: new Date().toISOString().slice(0, 10) })}><Icon name="plus" />Add fee</button>}</div>
        <div className="table-wrap"><table>
          <thead><tr><th>Name</th><th>Category</th><th className="num">Amount</th><th>Frequency</th><th>Start</th><th>End</th><th /></tr></thead>
          <tbody>{(list.data || []).map((f) => (
            <tr key={f.id}><td>{f.name}</td><td>{f.category}</td><td className="num">{money(f.amount)}</td><td>{f.frequency}</td><td>{f.start_date}</td><td>{f.end_date || '—'}</td>
              <td>{isAdmin && <div className="row" style={{ gap: 4 }}><button className="sm" onClick={() => setEdit(f)}>Edit</button>
                <button className="ghost sm" aria-label="Delete" onClick={() => confirm('Delete this fee?') && run(() => api.del(`/fixed-costs/${f.id}`)).then(list.reload)}><Icon name="trash" /></button></div>}</td></tr>
          ))}</tbody>
        </table>{list.data?.length === 0 && <Empty>No fixed fees recorded.</Empty>}</div>
      </div>
      {edit && (
        <Modal title={edit.id ? 'Edit fee' : 'Add fee'} onClose={() => setEdit(null)} footer={<><button onClick={() => setEdit(null)}>Cancel</button><button className="primary" onClick={save} disabled={busy || !edit.name || edit.amount === ''}>Save</button></>}>
          <div className="form-grid">
            <label className="field">Name<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. 10DLC campaign fee" /></label>
            <label className="field">Category<select value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>
              {['numbers', 'registration', 'setup', 'support', 'platform', 'other'].map((c) => <option key={c}>{c}</option>)}</select></label>
            <label className="field">Amount<input type="number" min="0" step="0.01" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} /></label>
            <label className="field">Frequency<select value={edit.frequency} onChange={(e) => setEdit({ ...edit, frequency: e.target.value })}>
              <option value="monthly">Monthly</option><option value="annual">Annual</option><option value="one-time">One-time</option></select></label>
            <label className="field">Start date<input type="date" value={edit.start_date} onChange={(e) => setEdit({ ...edit, start_date: e.target.value })} /></label>
            <label className="field">End date<input type="date" value={edit.end_date || ''} onChange={(e) => setEdit({ ...edit, end_date: e.target.value })} /></label>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function Rates() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'rates';
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Rate card &amp; fees</h1><p>Your contracted prices and fixed costs, the basis for every cost figure</p></div></div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'rates'} className={tab === 'rates' ? 'on' : ''} onClick={() => setParams({})}>Rate card</button>
        <button role="tab" aria-selected={tab === 'fixed'} className={tab === 'fixed' ? 'on' : ''} onClick={() => setParams({ tab: 'fixed' })}>Fixed &amp; recurring fees</button>
      </div>
      {tab === 'fixed' ? <FixedCosts /> : <RateCard />}
    </div>
  );
}
