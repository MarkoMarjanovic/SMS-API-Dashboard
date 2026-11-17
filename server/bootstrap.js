// Startup provisioning for hosted deployments.
//   ADMIN_EMAIL + ADMIN_PASSWORD  -> create this admin if no users exist (closes the public first-run setup page)
//   SEED_DEMO=1                   -> load demo data when the database has no transactions (e.g. ephemeral free-tier disks)
import { get, run, now, setSettings, audit } from './db.js';
import { hashPassword } from './auth.js';
import { seedDemo } from './demo.js';

export function bootstrap() {
  const users = get('SELECT COUNT(*) AS n FROM users').n;
  const { ADMIN_EMAIL, ADMIN_PASSWORD, SEED_DEMO, COMPANY_NAME } = process.env;
  if (!users && ADMIN_EMAIL && ADMIN_PASSWORD) {
    run('INSERT INTO users(email, name, password_hash, role, created_at) VALUES(?,?,?,?,?)',
      ADMIN_EMAIL.toLowerCase().trim(), 'Administrator', hashPassword(ADMIN_PASSWORD), 'admin', now());
    audit('system', 'bootstrap-admin', ADMIN_EMAIL);
    console.log(`Created admin user ${ADMIN_EMAIL} from environment`);
  } else if (!users && process.env.NODE_ENV === 'production') {
    console.warn('WARNING: no users exist and ADMIN_EMAIL/ADMIN_PASSWORD are not set. The first visitor can create the admin account.');
  }
  if (SEED_DEMO === '1' && !get('SELECT COUNT(*) AS n FROM transactions').n) {
    const n = seedDemo();
    console.log(`Seeded ${n} demo transactions`);
  }
  if (COMPANY_NAME && !users) setSettings({ company_name: COMPANY_NAME });
}
