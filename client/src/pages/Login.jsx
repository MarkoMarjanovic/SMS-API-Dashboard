import { useState } from 'react';
import { api } from '../api.js';

export default function Login({ needsSetup, onDone }) {
  const [f, setF] = useState({ email: '', password: '', name: '', company: '', mode: 'demo' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.post(needsSetup ? '/auth/setup' : '/auth/login', f);
      await onDone();
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login stack" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          <div className="brand-mark" aria-hidden="true">T</div>
          <div><div className="brand-name">Telesign Usage Dashboard</div><div className="brand-sub">{needsSetup ? 'First-time setup' : 'Sign in'}</div></div>
        </div>
        {needsSetup && <p className="sub">Create the first administrator account. Everything is stored locally in this installation’s database, under your ownership.</p>}
        {needsSetup && <label className="field">Company name<input value={f.company} onChange={set('company')} placeholder="Acme Inc." /></label>}
        {needsSetup && <label className="field">Your name<input value={f.name} onChange={set('name')} /></label>}
        <label className="field">Email<input type="email" required autoComplete="username" value={f.email} onChange={set('email')} /></label>
        <label className="field">Password<input type="password" required minLength={needsSetup ? 8 : undefined} autoComplete={needsSetup ? 'new-password' : 'current-password'} value={f.password} onChange={set('password')} />
          {needsSetup && <span className="hint">At least 8 characters.</span>}</label>
        {needsSetup && (
          <fieldset className="stack" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, gap: 8 }}>
            <legend className="sub" style={{ padding: '0 4px' }}>How do you want to start?</legend>
            <label className="check"><input type="radio" name="mode" checked={f.mode === 'demo'} onChange={() => setF({ ...f, mode: 'demo' })} />
              <span><b>Explore with demo data</b><br /><span className="hint">6 months of sample traffic. Nothing is sent. Remove it later in Settings.</span></span></label>
            <label className="check"><input type="radio" name="mode" checked={f.mode === 'live'} onChange={() => setF({ ...f, mode: 'live' })} />
              <span><b>Start empty</b><br /><span className="hint">Connect your Telesign account in Settings and add your rate card.</span></span></label>
          </fieldset>
        )}
        {err && <div className="banner critical" role="alert">{err}</div>}
        <button className="primary" disabled={busy} style={{ justifyContent: 'center' }}>{busy ? 'Please wait…' : needsSetup ? 'Create account' : 'Sign in'}</button>
      </form>
    </div>
  );
}
