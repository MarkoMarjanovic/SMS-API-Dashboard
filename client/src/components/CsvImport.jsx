import { useState } from 'react';
import Papa from 'papaparse';

/**
 * Generic CSV import with column mapping.
 * fields: [{ key, label, required?, guess: RegExp, hint? }]
 * keepExtra: also pass through unmapped columns (by header name, snake_cased).
 * onImport(rows, fileName) -> Promise
 */
export default function CsvImport({ fields, keepExtra = false, onImport, busy, children, submitLabel = 'Import' }) {
  const [file, setFile] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [map, setMap] = useState({});
  const [error, setError] = useState('');

  const load = (f) => {
    setError('');
    if (!f) return;
    Papa.parse(f, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: (res) => {
        const hs = res.meta.fields || [];
        if (!hs.length) return setError('Could not find a header row in this file.');
        setFile(f);
        setHeaders(hs);
        setRows(res.data);
        const m = {};
        for (const fd of fields) {
          const h = hs.find((x) => fd.guess?.test(x));
          if (h) m[fd.key] = h;
        }
        setMap(m);
      },
      error: (e) => setError(e.message),
    });
  };

  const missing = fields.filter((f) => f.required && !map[f.key]);
  const snake = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const mapped = () => rows.map((r) => {
    const o = {};
    if (keepExtra) {
      const used = new Set(Object.values(map));
      for (const h of headers) if (!used.has(h) && r[h] !== '' && r[h] !== undefined) o[snake(h)] = r[h];
    }
    for (const f of fields) if (map[f.key]) o[f.key] = (r[map[f.key]] ?? '').toString().trim();
    return o;
  });

  const reset = () => { setFile(null); setHeaders([]); setRows([]); setMap({}); };

  return (
    <div className="stack">
      {!file && (
        <label className="card stack" style={{ borderStyle: 'dashed', textAlign: 'center', cursor: 'pointer', boxShadow: 'none' }}>
          <b>Choose a CSV file</b>
          <span className="sub">The first row must contain column names. UTF-8 recommended.</span>
          <input type="file" accept=".csv,text/csv" onChange={(e) => load(e.target.files[0])} style={{ margin: '0 auto' }} />
        </label>
      )}
      {error && <div className="banner critical">{error}</div>}
      {file && (
        <>
          <div className="row"><b>{file.name}</b><span className="sub">{rows.length.toLocaleString()} rows</span><span className="spacer" /><button className="sm" onClick={reset}>Choose another file</button></div>
          <div className="form-grid">
            {fields.map((f) => (
              <label key={f.key} className="field">{f.label}{f.required ? ' *' : ''}
                <select value={map[f.key] || ''} onChange={(e) => setMap({ ...map, [f.key]: e.target.value })}>
                  <option value="">— not in file —</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
                {f.hint && <span className="hint">{f.hint}</span>}
              </label>
            ))}
          </div>
          {children}
          <div className="table-wrap card flush">
            <table>
              <thead><tr>{fields.filter((f) => map[f.key]).map((f) => <th key={f.key}>{f.label}</th>)}</tr></thead>
              <tbody>{mapped().slice(0, 5).map((r, i) => <tr key={i}>{fields.filter((f) => map[f.key]).map((f) => <td key={f.key}>{r[f.key]}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {keepExtra && <p className="hint">Other columns are kept as custom fields and can be used in messages as {'{column_name}'}.</p>}
          <div className="row">
            <button className="primary" disabled={busy || missing.length > 0} onClick={async () => { const ok = await onImport(mapped(), file.name); if (ok) reset(); }}>
              {submitLabel} {rows.length.toLocaleString()} rows
            </button>
            {missing.length > 0 && <span className="hint">Map the required column(s): {missing.map((m) => m.label).join(', ')}</span>}
          </div>
        </>
      )}
    </div>
  );
}
