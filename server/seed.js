// CLI: npm run seed:demo — (re)generates demo data in the local database.
const { seedDemo } = await import('./demo.js');
const t = Date.now();
const n = seedDemo();
console.log(`Seeded ${n} demo transactions in ${((Date.now() - t) / 1000).toFixed(1)}s`);
