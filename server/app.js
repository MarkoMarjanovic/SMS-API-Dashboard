// Express application shared by the local/container server (server/index.js) and Vercel (api/index.js).
import express from 'express';
import { ready } from './db.js';
import { bootstrap } from './bootstrap.js';
import { loadUser, requireUser } from './auth.js';
import authRoutes from './routes/auth.js';
import analytics from './routes/analytics.js';
import messaging from './routes/messaging.js';
import admin from './routes/admin.js';
import { gateway, callbacks, cron } from './routes/public.js';
import { tick } from './scheduler.js';

const app = express();
// Behind a hosting proxy (Vercel, Render, nginx) the real client IP is in X-Forwarded-For (login rate limiting).
app.set('trust proxy', process.env.TRUST_PROXY === '1' || process.env.VERCEL ? 1 : 'loopback');
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

// Make sure the schema exists and environment provisioning ran (once per cold start).
app.use('/api', async (_req, _res, next) => {
  try {
    await ready();
    await bootstrap();
    next();
  } catch (e) {
    next(e);
  }
});

app.use('/api/callbacks', callbacks);
app.use('/api/gateway/v1', gateway);
app.use('/api/cron', cron);

app.use('/api', loadUser);
app.use('/api/auth', authRoutes);

/** While someone has the dashboard open it calls this every ~20s, which keeps campaigns, demo delivery and alerts moving on serverless. */
app.post('/api/tick', requireUser, async (_req, res) => res.json(await tick({ budgetMs: 8000 })));

app.use('/api/analytics', requireUser, analytics);
app.use('/api', requireUser, messaging);
app.use('/api', requireUser, admin);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose === false ? 'Server error' : err.message || 'Server error' });
});

export default app;
