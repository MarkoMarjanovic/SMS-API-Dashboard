// Demo data: ~6 months of realistic traffic so the dashboard is explorable without a Telesign account.
// All prices are ILLUSTRATIVE placeholders, not Telesign list prices — replace them with your contract rate card.
import { getExampleNumber } from 'libphonenumber-js';
import examples from 'libphonenumber-js/mobile/examples';
import { db, run, get, tx, now, setSettings } from './db.js';
import { analyzeSms } from '../shared/sms.js';
import { describeStatus } from '../shared/statusCodes.js';
import { invalidateRates } from './pricing.js';
import { evaluateAlerts } from './spend.js';

// country, traffic weight, SMS price, carrier fee, delivery rate, verify conversion
const COUNTRIES = [
  ['US', 38, 0.0079, 0.0030, 0.965, 0.88], ['CA', 6, 0.0075, 0.0025, 0.96, 0.87], ['GB', 8, 0.0340, 0, 0.97, 0.89],
  ['DE', 5, 0.0720, 0, 0.97, 0.9], ['FR', 4, 0.0640, 0, 0.965, 0.88], ['ES', 3, 0.0610, 0, 0.96, 0.87],
  ['IT', 3, 0.0690, 0, 0.955, 0.86], ['NL', 2, 0.0810, 0, 0.97, 0.9], ['PL', 2, 0.0290, 0, 0.95, 0.85],
  ['RS', 2, 0.0580, 0, 0.94, 0.84], ['MX', 4, 0.0240, 0, 0.92, 0.82], ['BR', 4, 0.0190, 0, 0.91, 0.8],
  ['IN', 5, 0.0042, 0, 0.88, 0.78], ['PH', 2, 0.0210, 0, 0.9, 0.8], ['ID', 2, 0.0340, 0, 0.89, 0.79],
  ['NG', 1.5, 0.0410, 0, 0.84, 0.74], ['ZA', 1, 0.0200, 0, 0.92, 0.82], ['AE', 1, 0.0390, 0, 0.93, 0.83],
  ['AU', 3, 0.0420, 0, 0.97, 0.89], ['JP', 1.5, 0.0710, 0, 0.95, 0.86],
];
const PUMPING_COUNTRY = 'KG'; // sudden fraudulent Verify traffic to a country with no prior history

const FIRST = ['Ana', 'Marko', 'Liam', 'Olivia', 'Noah', 'Emma', 'Lucas', 'Mia', 'Sofia', 'Mateo', 'Aarav', 'Yuki', 'Chloe', 'Ivan', 'Elena', 'Omar', 'Zara', 'Leo', 'Nina', 'Diego', 'Hana', 'Ravi', 'Grace', 'Felix'];
const LAST = ['Smith', 'Jovanović', 'Garcia', 'Müller', 'Rossi', 'Silva', 'Kowalski', 'Nguyen', 'Patel', 'Tanaka', 'Brown', 'Martin', 'Dubois', 'Okafor', 'Santos', 'Novak'];
const TAGS = ['customers', 'newsletter', 'vip', 'trial', 'churn-risk'];
const SMS_BODIES = [
  'Hi {first_name}, your order #{order} has shipped and arrives Thursday.',
  'Your appointment is confirmed for tomorrow at 10:00. Reply C to cancel.',
  'Payment received — thank you! Your receipt is in your account.',
  'Reminder: your subscription renews in 3 days.',
  '{first_name}, your package is out for delivery today.',
];

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const weighted = (() => {
  const total = COUNTRIES.reduce((a, c) => a + c[1], 0);
  return () => {
    let r = rnd() * total;
    for (const c of COUNTRIES) if ((r -= c[1]) <= 0) return c;
    return COUNTRIES[0];
  };
})();
const C = Object.fromEntries(COUNTRIES.map((c) => [c[0], c]));

function phoneFor(country) {
  const ex = getExampleNumber(country, examples);
  const nat = ex.nationalNumber;
  const keep = Math.max(2, nat.length - 5);
  let out = nat.slice(0, keep);
  while (out.length < nat.length) out += Math.floor(rnd() * 10);
  return `+${ex.countryCallingCode}${out}`;
}

const failCodes = [207, 210, 211, 220, 221, 230];

export function clearOperationalData() {
  tx(() => {
    for (const t of ['campaign_queue', 'campaigns', 'transactions', 'inbound', 'suppression', 'contacts', 'alerts', 'templates', 'country_caps'])
      db.exec(`DELETE FROM ${t}`);
  });
}

export function seedDemo() {
  seed = 42;
  clearOperationalData();
  tx(() => {
    db.exec('DELETE FROM rates; DELETE FROM fixed_costs;');
    const rate = db.prepare('INSERT INTO rates(product, country, price, carrier_fee, note, updated_at) VALUES(?,?,?,?,?,?)');
    const t = now();
    for (const [cc, , price, fee] of COUNTRIES) {
      rate.run('sms', cc, price, fee, 'Sample rate', t);
      rate.run('verify_sms', cc, +(price + 0.009).toFixed(4), fee, 'Sample rate (SMS + verification fee)', t);
      rate.run('verify_voice', cc, +(price * 1.6 + 0.012).toFixed(4), 0, 'Sample rate per call', t);
      rate.run('voice', cc, +(price * 1.3 + 0.006).toFixed(4), 0, 'Sample rate per minute', t);
      rate.run('whatsapp', cc, +(price * 0.8 + 0.004).toFixed(4), 0, 'Sample rate per message', t);
    }
    rate.run('sms', '*', 0.05, 0, 'Default for countries without a specific rate', t);
    rate.run('verify_sms', '*', 0.06, 0, 'Default', t);
    rate.run('verify_sms', PUMPING_COUNTRY, 0.142, 0, 'Sample rate (high-cost destination)', t);
    rate.run('verify_voice', '*', 0.09, 0, 'Default', t);
    rate.run('voice', '*', 0.06, 0, 'Default', t);
    rate.run('whatsapp', '*', 0.04, 0, 'Default', t);
    rate.run('phoneid', '*', 0.0055, 0, 'Sample flat rate per lookup', t);
    rate.run('intelligence', '*', 0.0045, 0, 'Sample flat rate per score', t);

    const fc = db.prepare('INSERT INTO fixed_costs(name, category, amount, frequency, start_date, end_date, note) VALUES(?,?,?,?,?,?,?)');
    const start = new Date(Date.now() - 182 * 864e5).toISOString().slice(0, 10);
    fc.run('US 10DLC brand registration', 'registration', 4.5, 'one-time', start, null, 'Sample');
    fc.run('US 10DLC campaign vetting', 'registration', 15, 'one-time', start, null, 'Sample');
    fc.run('US 10DLC campaign fee', 'registration', 10, 'monthly', start, null, 'Sample');
    fc.run('Dedicated long codes (3 numbers)', 'numbers', 3, 'monthly', start, null, 'Sample');
    fc.run('Toll-free number', 'numbers', 2, 'monthly', start, null, 'Sample');
    fc.run('UK alphanumeric sender ID registration', 'registration', 60, 'one-time', start, null, 'Sample');
    fc.run('Premium support plan', 'support', 600, 'annual', start, null, 'Sample');
  });
  invalidateRates();

  const price = (product, cc) => {
    const r = get('SELECT price + carrier_fee AS p FROM rates WHERE product = ? AND country IN (?, \'*\') ORDER BY country = \'*\' LIMIT 1', product, cc);
    return r?.p ?? 0;
  };
  const priceCache = new Map();
  const cost = (product, cc) => {
    const k = product + cc;
    if (!priceCache.has(k)) priceCache.set(k, price(product, cc));
    return priceCache.get(k);
  };

  const insert = db.prepare(
    `INSERT INTO transactions(reference_id, product, direction, phone, country, contact_id, campaign_id, message, message_type, encoding,
      units, segments, status_code, status_kind, status_text, cost, cost_source, verified, source, created_at, updated_at)
     VALUES(?,?, 'out', ?,?,?,?,?,?,?,?,?,?,?,?,?, 'rate_card', ?, 'demo', ?, ?)`);
  let refN = 0;
  const ref = () => 'DEMO' + (++refN).toString(16).toUpperCase().padStart(20, '0');

  function addTx({ product, cc, phone, at, message, messageType, campaignId = null, contactId = null, verified = null, units = 1, forceFail = false }) {
    const country = C[cc];
    const deliveryRate = country ? country[4] : 0.8;
    const info = message ? analyzeSms(message) : { segments: 1, encoding: null };
    let code = 200;
    if (forceFail || rnd() > deliveryRate) code = pick(failCodes);
    else if (rnd() < 0.04) code = 203;
    if (product === 'phoneid' || product === 'intelligence') code = 300;
    const st = describeStatus(code);
    const kind = code === 300 ? 'delivered' : st.kind;
    const text = code === 300 ? 'Completed' : st.text;
    const segs = product === 'sms' || product === 'whatsapp' ? info.segments : product.startsWith('verify') ? 1 : 0;
    const qty = product === 'sms' || product === 'whatsapp' ? segs : units;
    const iso = at.toISOString();
    insert.run(ref(), product, phone || phoneFor(cc), cc, contactId, campaignId, message || null, messageType || null, info.encoding,
      units, segs, code, kind, text, +(cost(product, cc) * qty).toFixed(5), verified, iso, iso);
  }

  const DAYS = 182;
  const today = new Date();
  tx(() => {
    // ---- contacts ----
    const ins = db.prepare(`INSERT OR IGNORE INTO contacts(phone, country, first_name, last_name, email, tags, custom, consent_status, consent_source, consent_at, opted_out_at, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < 900; i++) {
      const c = weighted();
      const fn = pick(FIRST), ln = pick(LAST);
      const created = new Date(today.getTime() - rnd() * DAYS * 864e5).toISOString();
      const p = rnd();
      const consent = p < 0.9 ? 'opted_in' : p < 0.95 ? 'unknown' : 'opted_out';
      const tags = [pick(TAGS)].concat(rnd() < 0.4 ? [pick(TAGS)] : []).filter((v, i, a) => a.indexOf(v) === i).join(',');
      ins.run(phoneFor(c[0]), c[0], fn, ln, `${fn}.${ln}${i}@example.com`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''),
        tags, JSON.stringify({ order: String(10000 + i) }), consent, consent === 'unknown' ? null : pick(['checkout', 'web-form', 'in-store', 'import']),
        consent === 'unknown' ? null : created, consent === 'opted_out' ? created : null, created);
    }
    const supp = db.prepare("INSERT OR IGNORE INTO suppression(phone, reason, source, note, created_at) SELECT phone, 'opt-out', 'keyword', 'Replied STOP', opted_out_at FROM contacts WHERE consent_status = 'opted_out'");
    supp.run();

    // ---- day-by-day traffic ----
    for (let d = DAYS; d >= 0; d--) {
      const day = new Date(today.getTime() - d * 864e5);
      const growth = 0.7 + 0.3 * ((DAYS - d) / DAYS);
      const weekday = [0.55, 1.05, 1.1, 1.1, 1.05, 1.0, 0.65][day.getDay()];
      const k = growth * weekday;
      const hours = d === 0 ? today.getHours() + today.getMinutes() / 60 : 24;
      const frac = hours / 24;
      const at = () => {
        const t = new Date(day);
        t.setHours(0, 0, 0, 0);
        return new Date(t.getTime() + rnd() * hours * 3600e3);
      };
      const n = (base) => Math.round(base * k * frac * (0.85 + rnd() * 0.3));

      for (let i = n(260); i > 0; i--) {
        const c = weighted();
        addTx({ product: 'sms', cc: c[0], at: at(), message: pick(SMS_BODIES).replace('{first_name}', pick(FIRST)).replace('{order}', String(10000 + Math.floor(rnd() * 900))), messageType: 'ARN' });
      }
      for (let i = n(150); i > 0; i--) {
        const c = weighted();
        addTx({ product: 'verify_sms', cc: c[0], at: at(), verified: rnd() < c[5] ? 1 : 0 });
      }
      for (let i = n(14); i > 0; i--) { const c = weighted(); addTx({ product: 'verify_voice', cc: c[0], at: at(), verified: rnd() < c[5] ? 1 : 0 }); }
      for (let i = n(45); i > 0; i--) addTx({ product: 'phoneid', cc: weighted()[0], at: at() });
      for (let i = n(25); i > 0; i--) addTx({ product: 'intelligence', cc: weighted()[0], at: at() });
      for (let i = n(6); i > 0; i--) addTx({ product: 'voice', cc: weighted()[0], at: at(), units: 1 + Math.floor(rnd() * 4) });
      if (d < 75) for (let i = n(30); i > 0; i--) addTx({ product: 'whatsapp', cc: weighted()[0], at: at(), message: pick(SMS_BODIES) });

      // SMS pumping attack during the last ~30 hours
      if (d <= 1) {
        const count = Math.round((d === 1 ? 140 : 260) * frac);
        for (let i = 0; i < count; i++) {
          const t = at();
          if (d === 1 && t.getHours() < 18) continue;
          addTx({ product: 'verify_sms', cc: PUMPING_COUNTRY, at: t, verified: rnd() < 0.06 ? 1 : 0, phone: '+99655' + String(Math.floor(rnd() * 1e7)).padStart(7, '0') });
        }
      }
    }

    // ---- campaigns ----
    const camp = db.prepare(`INSERT INTO campaigns(name, body, message_type, audience_tag, status, scheduled_at, rate_per_minute, total, estimated_cost, created_by, created_at, started_at, completed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const queue = db.prepare('INSERT OR IGNORE INTO campaign_queue(campaign_id, contact_id, status, transaction_id) VALUES(?,?,?,?)');
    const contactsFor = (tag) => db.prepare(`SELECT * FROM contacts WHERE consent_status != 'opted_out' ${tag ? "AND (',' || tags || ',') LIKE ?" : ''}`).all(...(tag ? [`%,${tag},%`] : []));
    const plans = [
      ['Summer sale announcement', 'Hi {first_name}! Our summer sale is live: 20% off everything until Sunday. Shop now: example.com/sale Reply STOP to opt out', null, 150],
      ['VIP early access', '{first_name}, as a VIP you get early access to our new collection today. Reply STOP to opt out', 'vip', 95],
      ['Black Friday preview 🎉', 'Black Friday starts early for you, {first_name} 🎉 Up to 40% off — example.com/bf Reply STOP to opt out', 'newsletter', 30],
      ['Win-back offer', 'We miss you {first_name}! Here is 15% off your next order with code BACK15. Reply STOP to opt out', 'churn-risk', 12],
    ];
    for (const [name, body, tag, daysAgo] of plans) {
      const day = new Date(today.getTime() - daysAgo * 864e5);
      day.setHours(10, 0, 0, 0);
      const list = contactsFor(tag);
      let total = 0;
      const r = camp.run(name, body, 'MKT', tag, 'completed', day.toISOString(), 120, list.length, 0, 'demo@admin', day.toISOString(), day.toISOString(), new Date(day.getTime() + list.length * 500).toISOString());
      const cid = Number(r.lastInsertRowid);
      list.forEach((ct, i) => {
        const custom = JSON.parse(ct.custom);
        const msg = body.replace(/\{first_name\}/g, ct.first_name).replace(/\{order\}/g, custom.order);
        addTx({ product: 'sms', cc: ct.country, phone: ct.phone, at: new Date(day.getTime() + i * 500), message: msg, messageType: 'MKT', campaignId: cid, contactId: ct.id });
        const txId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
        queue.run(cid, ct.id, 'sent', txId);
        total += cost('sms', ct.country) * analyzeSms(msg).segments;
      });
      run('UPDATE campaigns SET estimated_cost = ? WHERE id = ?', +total.toFixed(2), cid);
    }
    const next = new Date(today.getTime() + 3 * 864e5);
    next.setHours(10, 0, 0, 0);
    camp.run('Holiday gift guide', 'Hi {first_name}, our holiday gift guide is here: example.com/gifts Reply STOP to opt out', 'MKT', 'newsletter', 'draft', next.toISOString(), 60, 0, 0, 'demo@admin', now(), null, null);

    // ---- templates ----
    const tpl = db.prepare('INSERT INTO templates(name, body, created_at) VALUES(?,?,?)');
    tpl.run('Order shipped', 'Hi {first_name}, your order #{order} has shipped. Track it at example.com/t/{order}', now());
    tpl.run('Appointment reminder', 'Reminder: your appointment is tomorrow at {time|10:00}. Reply C to cancel.', now());
    tpl.run('Promo (with opt-out)', 'Hi {first_name|there}! {offer|Enjoy 10% off} this week only. Reply STOP to opt out', now());

    // ---- inbound replies ----
    const inb = db.prepare('INSERT INTO inbound(phone, country, body, contact_id, is_optout, is_optin, read, received_at) VALUES(?,?,?,?,?,?,?,?)');
    const replies = ['Thanks!', 'What time do you open on Saturday?', 'Is the sale online only?', 'Great, see you then', 'Can I change my delivery address?', 'C', 'Who is this?', '👍', 'YES'];
    const sample = db.prepare('SELECT id, phone, country, consent_status, opted_out_at FROM contacts ORDER BY RANDOM() LIMIT 160').all();
    sample.forEach((ct, i) => {
      if (ct.consent_status === 'opted_out') inb.run(ct.phone, ct.country, 'STOP', ct.id, 1, 0, 1, ct.opted_out_at);
      else {
        const body = pick(replies);
        const at = new Date(today.getTime() - rnd() * (i < 12 ? 2 : 60) * 864e5).toISOString();
        inb.run(ct.phone, ct.country, body, ct.id, 0, body === 'YES' ? 1 : 0, i < 12 ? 0 : 1, at);
      }
    });
  });

  // Budget defaults sized so the forecast shows a realistic "on track to exceed" situation.
  const ym = today.toISOString().slice(0, 7);
  const mtd = get("SELECT SUM(cost) AS s FROM transactions WHERE created_at >= ?", ym + '-01').s || 0;
  const dayOfMonth = today.getUTCDate() - 1 + today.getUTCHours() / 24 || 1;
  const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
  const projected = (mtd / dayOfMonth) * daysInMonth;
  const todaySpend = get('SELECT SUM(cost) AS s FROM transactions WHERE created_at >= ?', today.toISOString().slice(0, 10)).s || 0;
  // Daily limit leaves headroom above today's (attack-inflated) spend so demo sends still go through.
  const daily = Math.max((mtd / dayOfMonth) * 1.8, todaySpend * 1.6);
  setSettings({ demo_mode: '1', monthly_budget: Math.ceil((projected * 0.92) / 50) * 50, daily_budget: Math.ceil(daily / 5) * 5, company_name: 'Northwind Retail (demo)' });
  run('INSERT OR REPLACE INTO country_caps(country, monthly_cap) VALUES(?, ?)', 'NG', 25);
  run('INSERT OR REPLACE INTO country_caps(country, monthly_cap) VALUES(?, ?)', 'IN', 40);
  evaluateAlerts();
  return get('SELECT COUNT(*) AS n FROM transactions').n;
}
