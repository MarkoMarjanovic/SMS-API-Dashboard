import { useMemo, useState } from 'react';
import { useApi } from '../components/ui.jsx';
import { money, num, countryName, flag, allCountries, pct } from '../format.js';
import { analyzeSms, toGsmSafe } from '@shared/sms.js';

/** Live segment/encoding counter used by every message editor. */
export function SmsCounter({ text }) {
  const a = analyzeSms(text || '');
  return (
    <div className="counter" aria-live="polite">
      <span>Encoding <b>{a.encoding}</b></span>
      <span>Characters <b>{a.length}</b></span>
      <span>Segments <b style={a.segments > 1 ? { color: 'var(--warning-text)' } : {}}>{a.segments}</b></span>
      <span><b>{a.remaining}</b> left in this segment</span>
      {a.unicodeChars.length > 0 && <span style={{ color: 'var(--warning-text)' }}>⚠️ Unicode because of {a.unicodeChars.slice(0, 8).map((c) => <mark className="uc" key={c}>{c === ' ' ? '␣' : c}</mark>)}</span>}
      {a.extendedChars.length > 0 && <span>Counts as 2: {a.extendedChars.join(' ')}</span>}
    </div>
  );
}

const EXAMPLE = 'Hi Ana, your order #10422 has shipped and arrives Thursday. Track it at example.com/t/10422 – reply STOP to opt out';

export default function Calculator() {
  const rates = useApi('/rates');
  const [text, setText] = useState(EXAMPLE);
  const [recipients, setRecipients] = useState(100000);
  const [target, setTarget] = useState(0.01);
  const [split, setSplit] = useState([{ country: 'US', share: 70 }, { country: 'CA', share: 20 }, { country: 'GB', share: 10 }]);
  const [setup, setSetup] = useState(0);
  const a = analyzeSms(text);
  const safe = toGsmSafe(text);
  const safeA = analyzeSms(safe);

  const priceOf = useMemo(() => {
    const m = new Map((rates.data || []).filter((r) => r.product === 'sms').map((r) => [r.country, r.price + r.carrier_fee]));
    return (cc) => m.get(cc) ?? m.get('*') ?? 0;
  }, [rates.data]);

  const totalShare = split.reduce((x, s) => x + (Number(s.share) || 0), 0);
  const lines = split.map((s) => {
    const n = Math.round((recipients * (Number(s.share) || 0)) / (totalShare || 1));
    const unit = priceOf(s.country);
    return { ...s, n, unit, perMsg: unit * a.segments, cost: n * unit * a.segments };
  });
  const usage = lines.reduce((x, l) => x + l.cost, 0);
  const total = usage + Number(setup || 0);
  const perMessage = recipients ? total / recipients : 0;
  const countries = allCountries();

  return (
    <div className="stack">
      <div className="page-head"><div><h1>Cost calculator</h1><p>See how length and characters change billing, and estimate a send before you launch it</p></div></div>
      <div className="grid cols-2">
        <div className="card stack">
          <h2>Message analyzer</h2>
          <label className="field">Message<textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} /></label>
          <SmsCounter text={text} />
          {a.encoding === 'UCS-2' && safeA.encoding === 'GSM-7' && (
            <div className="banner warning">
              <span className="icon">💡</span>
              <div style={{ flex: 1 }}><b>Replace {a.unicodeChars.length} special character(s) to save {a.segments - safeA.segments > 0 ? `${a.segments - safeA.segments} segment(s) per message` : 'capacity'}</b>
                <span className="sub">GSM-safe version: {safeA.segments} segment(s), {safeA.length} characters.</span></div>
              <button onClick={() => setText(safe)}>Apply</button>
            </div>
          )}
          <div className="card" style={{ background: 'var(--surface-2)', boxShadow: 'none' }}>
            <h3 style={{ marginBottom: 8 }}>How SMS billing works</h3>
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-2)' }} className="stack">
              <li><b>GSM-7</b> (plain Latin letters, digits, basic punctuation): 160 characters fit in one segment. Longer messages are split into 153-character segments.</li>
              <li><b>UCS-2 / Unicode</b> (emoji, smart quotes “ ”, en dashes –, most accented or non-Latin letters): only 70 characters per segment, 67 when split.</li>
              <li>A few GSM characters (€ [ ] {'{ }'} ^ ~ | \) use two character slots.</li>
              <li><b>You pay per segment</b>: a 161-character message costs the same as two messages, and a single emoji can double or triple the cost.</li>
              <li>Carrier pass-through fees (e.g. US 10DLC / toll-free) are added per segment on top of the Telesign rate.</li>
            </ul>
          </div>
        </div>

        <div className="card stack">
          <h2>Campaign cost estimate</h2>
          <div className="form-grid">
            <label className="field">Recipients<input type="number" min="0" value={recipients} onChange={(e) => setRecipients(Number(e.target.value))} /></label>
            <label className="field">Target cost per message<input type="number" min="0" step="0.001" value={target} onChange={(e) => setTarget(Number(e.target.value))} /></label>
            <label className="field">One-off fees (setup, registration)<input type="number" min="0" value={setup} onChange={(e) => setSetup(e.target.value)} /></label>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Country</th><th className="num">Share %</th><th className="num">Messages</th><th className="num">Rate / seg.</th><th className="num">Cost</th><th /></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td><select value={l.country} aria-label="Country" onChange={(e) => setSplit(split.map((s, j) => (j === i ? { ...s, country: e.target.value } : s)))}>
                      {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></td>
                    <td className="num"><input type="number" min="0" style={{ width: 70 }} value={l.share} aria-label="Share" onChange={(e) => setSplit(split.map((s, j) => (j === i ? { ...s, share: e.target.value } : s)))} /></td>
                    <td className="num">{num(l.n)}</td>
                    <td className="num">{money(l.unit, { precise: true })}</td>
                    <td className="num">{money(l.cost)}</td>
                    <td><button className="ghost sm" aria-label="Remove" onClick={() => setSplit(split.filter((_, j) => j !== i))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row"><button className="sm" onClick={() => setSplit([...split, { country: 'DE', share: 0 }])}>+ Add country</button>
            {totalShare !== 100 && <span className="hint">Shares add up to {totalShare}%. They are scaled to 100%.</span>}</div>
          <dl className="kv">
            <dt>Segments per message</dt><dd>{a.segments} ({a.encoding})</dd>
            <dt>Messaging charges</dt><dd>{money(usage)}</dd>
            <dt>One-off fees</dt><dd>{money(Number(setup) || 0)}</dd>
            <dt>Total</dt><dd><b>{money(total)}</b></dd>
            <dt>Effective cost / message</dt>
            <dd><b>{money(perMessage, { precise: true })}</b> {target > 0 && (perMessage <= target
              ? <span className="badge lvl-good">✓ Within {money(target, { precise: true })} target</span>
              : <span className="badge lvl-critical">✕ {pct(perMessage / target - 1, 0)} above target</span>)}</dd>
          </dl>
          {target > 0 && perMessage > target && (
            <p className="hint">Ways to get closer: keep messages to a single GSM-7 segment, shift volume to lower-cost destinations, or negotiate volume tiers with Telesign. Rates come from your <a href="/rates">rate card</a>.</p>
          )}
          <p className="hint">Rates used: {lines.map((l) => `${flag(l.country)} ${countryName(l.country)} ${money(l.unit, { precise: true })}`).join(' · ')}</p>
        </div>
      </div>
    </div>
  );
}
