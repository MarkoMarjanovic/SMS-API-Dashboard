import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env (simple parser, no dependency)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { default: express } = await import('express');
const { loadUser, requireUser } = await import('./auth.js');
const { default: authRoutes } = await import('./routes/auth.js');
const { default: analytics } = await import('./routes/analytics.js');
const { default: messaging } = await import('./routes/messaging.js');
const { default: admin } = await import('./routes/admin.js');
const { gateway, callbacks } = await import('./routes/public.js');
const { startScheduler } = await import('./scheduler.js');
const { bootstrap } = await import('./bootstrap.js');

bootstrap();

const app = express();
// Behind a hosting proxy (Render, Railway, nginx) set TRUST_PROXY=1 so req.ip is the real client (login rate limiting).
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : 'loopback');
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: false }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/callbacks', callbacks);
app.use('/api/gateway/v1', gateway);

app.use('/api', loadUser);
app.use('/api/auth', authRoutes);
app.use('/api/analytics', requireUser, analytics);
app.use('/api', requireUser, messaging);
app.use('/api', requireUser, admin);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the built frontend in production
const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`Telesign Usage Dashboard API on http://localhost:${port}`);
  startScheduler();
});
