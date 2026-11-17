import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, LevelBadge, Empty, useAction, useAuth } from '../components/ui.jsx';
import { dateTime, countryName, flag } from '../format.js';

const TYPE = { budget: 'Budget', spike: 'Spend spike', fraud: 'Fraud', geo: 'New country' };

export default function Alerts() {
  const list = useApi('/alerts');
  const { refreshCounts } = useAuth();
  const [run] = useAction();
  const ack = (id) => run(() => api.post(`/alerts/${id}/ack`)).then(() => { list.reload(); refreshCounts(); });
  const ackAll = () => run(() => api.post('/alerts/ack-all'), 'All alerts acknowledged').then(() => { list.reload(); refreshCounts(); });
  const open = (list.data || []).filter((a) => !a.acknowledged);
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Alerts</h1><p>Budget thresholds, spend spikes, possible SMS pumping and first traffic to new countries. Checked every minute.</p></div>
        <div className="toolbar"><Link to="/controls" className="btn">Alert settings</Link>{open.length > 0 && <button onClick={ackAll}>Acknowledge all</button>}</div>
      </div>
      <div className="card flush">
        <div className="table-wrap"><table>
          <thead><tr><th>Level</th><th>Type</th><th>Alert</th><th>Country</th><th>Raised</th><th /></tr></thead>
          <tbody>{(list.data || []).map((a) => (
            <tr key={a.id} style={a.acknowledged ? { opacity: 0.55 } : {}}>
              <td><LevelBadge level={a.level} /></td>
              <td>{TYPE[a.type] || a.type}</td>
              <td><b>{a.title}</b><div className="sub">{a.detail}</div></td>
              <td>{a.country ? <Link to={`/countries?c=${a.country}`}>{flag(a.country)} {countryName(a.country)}</Link> : '—'}</td>
              <td className="sub" style={{ whiteSpace: 'nowrap' }}>{dateTime(a.created_at)}</td>
              <td>{!a.acknowledged ? <button className="sm" onClick={() => ack(a.id)}>Acknowledge</button> : <span className="sub">Acknowledged</span>}</td>
            </tr>
          ))}</tbody>
        </table>{list.data?.length === 0 && <Empty>No alerts. All good.</Empty>}</div>
      </div>
    </div>
  );
}
