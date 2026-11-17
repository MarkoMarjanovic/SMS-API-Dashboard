// Local / container entry point: serves the API + built UI and runs the scheduler every 5 seconds.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { default: express } = await import('express');
const { default: app } = await import('./app.js');
const { startScheduler } = await import('./scheduler.js');
const { ready } = await import('./db.js');
const { bootstrap } = await import('./bootstrap.js');

const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

await ready();
await bootstrap();
const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`Telesign Usage Dashboard on http://localhost:${port} (${process.env.DATABASE_URL ? 'Postgres' : 'embedded PGlite'})`);
  startScheduler();
});
