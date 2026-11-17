import { api } from '../api.js';
import { useApi, useAction, useAuth, Empty, Icon } from '../components/ui.jsx';
import CsvImport from '../components/CsvImport.jsx';
import { money, num, dateTime, dateShort } from '../format.js';

const FIELDS = [
  { key: 'date', label: 'Date', required: true, guess: /date|time|day|period/i },
  { key: 'product', label: 'Product / service', guess: /product|service|type|description|item/i, hint: 'Mapped automatically (SMS, Verify, Voice, Phone ID…)' },
  { key: 'country', label: 'Country', guess: /country|dest|iso/i, hint: 'ISO code, e.g. US' },
  { key: 'phone', label: 'Phone number', guess: /phone|msisdn|number|recipient/i, hint: 'Used to detect country if no country column' },
  { key: 'quantity', label: 'Quantity', guess: /qty|quantity|count|volume|messages|units|transactions/i, hint: 'Defaults to 1 per row' },
  { key: 'segments', label: 'Segments', guess: /segment|parts/i },
  { key: 'cost', label: 'Cost', guess: /amount|total|charge|^cost|line.?cost/i, hint: 'If missing, your rate card is used' },
  { key: 'status', label: 'Status code', guess: /status/i },
];

export default function ImportUsage() {
  const { isAdmin } = useAuth();
  const batches = useApi('/import/batches');
  const [run, busy] = useAction();
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Import usage</h1><p>Bring in traffic that did not go through this dashboard, such as Telesign Portal exports, invoices or logs from other systems</p></div></div>
      <div className="banner info"><span className="icon">ℹ️</span><div>
        <b>When to use this</b>
        <span className="sub">Messages sent through this dashboard are tracked automatically. If other systems call Telesign directly, export their usage from the Telesign Portal (or your invoice detail) as CSV and import it here, so spend by product and country stays complete. Rows can be individual transactions or daily/monthly totals with a quantity column. Each import can be undone.</span>
      </div></div>
      {isAdmin && <div className="card"><CsvImport fields={FIELDS} busy={busy} onImport={async (rows, fileName) => {
        const r = await run(() => api.post('/import/usage', { rows, file_name: fileName }), (x) => `Imported ${num(x.imported)} lines (${money(x.cost)})${x.skipped ? `, ${x.skipped} skipped (bad date)` : ''}`);
        if (r) batches.reload();
        return !!r;
      }} /></div>}
      <div className="card flush">
        <div className="card-head"><h2>Previous imports</h2></div>
        <div className="table-wrap"><table>
          <thead><tr><th>File</th><th>Imported</th><th>Period</th><th className="num">Lines</th><th className="num">Units</th><th className="num">Cost</th><th /></tr></thead>
          <tbody>{(batches.data || []).map((b) => (
            <tr key={b.batch}><td>{b.file}</td><td>{dateTime(b.imported_at)}</td><td>{dateShort(b.first)} – {dateShort(b.last)}</td><td className="num">{num(b.lines)}</td><td className="num">{num(b.units)}</td><td className="num">{money(b.cost)}</td>
              <td>{isAdmin && <button className="sm danger" disabled={busy} onClick={() => confirm('Remove all lines from this import?') && run(() => api.del(`/import/batches/${b.batch}`), 'Import removed').then(batches.reload)}><Icon name="trash" />Undo</button>}</td></tr>
          ))}</tbody>
        </table>{batches.data?.length === 0 && <Empty>No imports yet.</Empty>}</div>
      </div>
    </div>
  );
}
