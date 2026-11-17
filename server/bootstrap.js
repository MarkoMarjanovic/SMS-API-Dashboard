// Startup provisioning for hosted deployments.
//   ADMIN_EMAIL + ADMIN_PASSWORD  -> create this admin if no users exist (closes the public first-run setup page)
//   SEED_DEMO=1                   -> load demo data when the database has no transactions
//   COMPANY_NAME                  -> initial company name
import { get, now, setSettings, audit } from './db.js';
import { hashPassword } from './auth.js';
import { seedDemo } from './demo.js';

let done;
/** Idempotent; safe to call on every cold start. */
export function bootstrap() {
  done ??= (async () => {
    const { ADMIN_EMAIL, ADMIN_PASSWORD, SEED_DEMO, COMPANY_NAME } = process.env;
    const users = (await get('SELECT COUNT(*) AS n FROM users')).n;
    if (!users && ADMIN_EMAIL && ADMIN_PASSWORD) {
      const created = await get(`INSERT INTO users(email, name, password_hash, role, created_at)
        SELECT ?, 'Administrator', ?, 'admin', ? WHERE NOT EXISTS (SELECT 1 FROM users) RETURNING id`,
        ADMIN_EMAIL.toLowerCase().trim(), hashPassword(ADMIN_PASSWORD), now());
      if (created) {
        await audit('system', 'bootstrap-admin', ADMIN_EMAIL);
        if (COMPANY_NAME) await setSettings({ company_name: COMPANY_NAME });
        console.log(`Created admin user ${ADMIN_EMAIL} from environment`);
      }
    } else if (!users && process.env.NODE_ENV === 'production') {
      console.warn('WARNING: no users exist and ADMIN_EMAIL/ADMIN_PASSWORD are not set. The first visitor can create the admin account.');
    }
    if (SEED_DEMO === '1' && !(await get('SELECT 1 AS x FROM transactions LIMIT 1'))) {
      console.log(`Seeded ${await seedDemo()} demo transactions`);
    }
  })().catch((e) => { done = null; throw e; });
  return done;
}
