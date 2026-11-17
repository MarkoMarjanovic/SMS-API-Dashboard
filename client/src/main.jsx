import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { ToastProvider } from './components/ui.jsx';
import { RangeProvider } from './components/DateRange.jsx';
import './styles.css';

try {
  const t = localStorage.getItem('theme');
  if (t) document.documentElement.dataset.theme = t;
} catch {}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <RangeProvider>
          <App />
        </RangeProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
