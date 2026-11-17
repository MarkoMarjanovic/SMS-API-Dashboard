// CLI: npm run seed:demo — (re)generates demo data in the configured database (DATABASE_URL or local PGlite).
import './env.js';

const { seedDemo } = await import('./demo.js');
const { closeDb } = await import('./db.js');
const t = Date.now();
const n = await seedDemo();
console.log(`Seeded ${n} demo transactions in ${((Date.now() - t) / 1000).toFixed(1)}s (${process.env.DATABASE_URL ? 'Postgres' : 'PGlite'})`);
await closeDb();
