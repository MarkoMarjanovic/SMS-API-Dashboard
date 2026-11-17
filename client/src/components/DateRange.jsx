import { createContext, useContext, useState } from 'react';

const iso = (d) => d.toISOString().slice(0, 10);
const today = () => new Date();
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);

export const PRESETS = [
  { key: '7d', label: 'Last 7 days', range: () => ({ from: iso(addDays(today(), -6)), to: iso(today()) }) },
  { key: '30d', label: 'Last 30 days', range: () => ({ from: iso(addDays(today(), -29)), to: iso(today()) }) },
  { key: '90d', label: 'Last 90 days', range: () => ({ from: iso(addDays(today(), -89)), to: iso(today()) }) },
  { key: 'mtd', label: 'Month to date', range: () => ({ from: iso(today()).slice(0, 8) + '01', to: iso(today()) }) },
  { key: 'lm', label: 'Last month', range: () => {
    const t = today();
    const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0));
    return { from: iso(first), to: iso(last) };
  } },
  { key: '6m', label: 'Last 6 months', range: () => ({ from: iso(addDays(today(), -182)), to: iso(today()) }) },
  { key: 'ytd', label: 'Year to date', range: () => ({ from: iso(today()).slice(0, 4) + '-01-01', to: iso(today()) }) },
];

const Ctx = createContext(null);

function initial() {
  try {
    const saved = JSON.parse(localStorage.getItem('range') || 'null');
    if (saved?.preset && saved.preset !== 'custom') return { preset: saved.preset, ...PRESETS.find((p) => p.key === saved.preset).range() };
    if (saved?.from) return saved;
  } catch {}
  return { preset: '30d', ...PRESETS[1].range() };
}

export function RangeProvider({ children }) {
  const [range, setRangeState] = useState(initial);
  const setRange = (r) => {
    setRangeState(r);
    try { localStorage.setItem('range', JSON.stringify(r)); } catch {}
  };
  return <Ctx.Provider value={{ range, setRange }}>{children}</Ctx.Provider>;
}

export const useRange = () => useContext(Ctx);

export function DateRangePicker() {
  const { range, setRange } = useRange();
  return (
    <div className="row" style={{ gap: 6 }}>
      <select aria-label="Date range" value={range.preset} onChange={(e) => {
        const p = PRESETS.find((x) => x.key === e.target.value);
        if (p) setRange({ preset: p.key, ...p.range() });
        else setRange({ ...range, preset: 'custom' });
      }}>
        {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        <option value="custom">Custom range</option>
      </select>
      {range.preset === 'custom' && (
        <>
          <input type="date" aria-label="From" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <span className="sub">to</span>
          <input type="date" aria-label="To" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </>
      )}
    </div>
  );
}
