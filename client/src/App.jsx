import { useCallback, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation, Navigate } from 'react-router-dom';
import { api } from './api.js';
import { setCurrency } from './format.js';
import { AuthCtx, Icon } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import Countries from './pages/Countries.jsx';
import Messages from './pages/Messages.jsx';
import Fraud from './pages/Fraud.jsx';
import Campaigns from './pages/Campaigns.jsx';
import Contacts from './pages/Contacts.jsx';
import Inbox from './pages/Inbox.jsx';
import Controls from './pages/Controls.jsx';
import Alerts from './pages/Alerts.jsx';
import Rates from './pages/Rates.jsx';
import Calculator from './pages/Calculator.jsx';
import Reports from './pages/Reports.jsx';
import ImportUsage from './pages/ImportUsage.jsx';
import Settings from './pages/Settings.jsx';

const NAV = [
  ['Monitor', [['/', 'Overview', 'home'], ['/countries', 'Countries', 'globe'], ['/messages', 'Message log', 'list'], ['/fraud', 'Verify & fraud', 'shield']]],
  ['Engage', [['/campaigns', 'Campaigns', 'send'], ['/contacts', 'Contacts & consent', 'users'], ['/inbox', 'Inbox', 'inbox']]],
  ['Costs', [['/controls', 'Spending controls', 'gauge'], ['/alerts', 'Alerts', 'bell'], ['/rates', 'Rate card & fees', 'tag'], ['/calculator', 'Cost calculator', 'calc'], ['/reports', 'Reports', 'file'], ['/import', 'Import usage', 'upload']]],
];

function toggleTheme() {
  const root = document.documentElement;
  const current = root.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch {}
}

export default function App() {
  const [state, setState] = useState(null);
  const [settings, setSettings] = useState({});
  const [counts, setCounts] = useState({});
  const [menu, setMenu] = useState(false);
  const loc = useLocation();

  const refresh = useCallback(async () => {
    const s = await api.get('/auth/state');
    setState(s);
    if (s.user) {
      const st = await api.get('/settings');
      setSettings(st);
      setCurrency(st.currency);
    }
  }, []);

  const refreshCounts = useCallback(() => {
    api.get('/analytics/overview').then((o) => setCounts({ alerts: o.open_alerts, inbox: o.unread_replies })).catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const h = () => setState((s) => ({ ...s, user: null }));
    window.addEventListener('auth:expired', h);
    return () => window.removeEventListener('auth:expired', h);
  }, []);
  useEffect(() => {
    if (!state?.user) return;
    refreshCounts();
    const t = setInterval(refreshCounts, 30000);
    return () => clearInterval(t);
  }, [state?.user, loc.pathname, refreshCounts]);
  useEffect(() => setMenu(false), [loc.pathname]);

  if (!state) return null;
  if (!state.user) return <Login needsSetup={state.needsSetup} onDone={refresh} />;

  const logout = async () => { await api.post('/auth/logout'); refresh(); };
  const isAdmin = state.user.role === 'admin';
  const demo = settings.demo_mode === '1';

  return (
    <AuthCtx.Provider value={{ user: state.user, isAdmin, settings, refreshSettings: refresh, refreshCounts }}>
      <div className="mobile-bar">
        <button className="ghost" onClick={() => setMenu(true)} aria-label="Open menu"><Icon name="menu" /></button>
        <b>{settings.company_name}</b>
      </div>
      <div className="shell">
        <nav className={`sidebar ${menu ? 'open' : ''}`} aria-label="Main">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">T</div>
            <div><div className="brand-name">{settings.company_name}</div><div className="brand-sub">Telesign usage dashboard</div></div>
          </div>
          {demo && <div className="demo-ribbon">Demo mode: sample data, no messages are really sent.</div>}
          {NAV.map(([group, items]) => (
            <div className="nav" key={group}>
              <div className="nav-group">{group}</div>
              {items.map(([to, label, icon]) => (
                <NavLink key={to} to={to} end={to === '/'}>
                  <Icon name={icon} />{label}
                  {to === '/alerts' && counts.alerts > 0 && <span className="badge accent">{counts.alerts}</span>}
                  {to === '/inbox' && counts.inbox > 0 && <span className="badge accent">{counts.inbox}</span>}
                </NavLink>
              ))}
            </div>
          ))}
          <div className="nav"><div className="nav-group">Admin</div><NavLink to="/settings"><Icon name="settings" />Settings</NavLink></div>
          <div className="sidebar-foot">
            <div className="sub">{state.user.name || state.user.email}<br />{state.user.role}</div>
            <div className="row" style={{ gap: 6 }}>
              <button className="sm" onClick={toggleTheme} title="Toggle dark mode"><Icon name="moon" />Theme</button>
              <button className="sm" onClick={logout}><Icon name="logout" />Sign out</button>
            </div>
          </div>
        </nav>
        {menu && <div className="overlay" style={{ zIndex: 35, background: 'rgba(0,0,0,.3)' }} onClick={() => setMenu(false)} />}
        <main className="main">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/countries" element={<Countries />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/fraud" element={<Fraud />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/contacts" element={<Contacts />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/controls" element={<Controls />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/rates" element={<Rates />} />
            <Route path="/calculator" element={<Calculator />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/import" element={<ImportUsage />} />
            <Route path="/settings" element={isAdmin ? <Settings /> : <Navigate to="/" />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </AuthCtx.Provider>
  );
}
