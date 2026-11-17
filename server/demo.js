// Demo data: ~6 months of realistic traffic so the dashboard is explorable without a Telesign account.
// All prices are ILLUSTRATIVE placeholders, not Telesign list prices — replace them with your contract rate card.
import { getExampleNumber } from 'libphonenumber-js';
import examples from 'libphonenumber-js/mobile/examples';
import { all, get, run, exec, bulkInsert, now, setSettings } from './db.js';
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
const TX_COLS = ['reference_id', 'product', 'phone', 'country', 'contact_id', 'campaign_id', 'message', 'message_type', 'encoding',
  'units', 'segments', 'status_code', 'status_kind', 'status_text', 'cost', 'cost_source', 'verified', 'source', 'created_at', 'updated_at'];

export async function clearOperationalData() {
  await exec('TRUNCATE campaign_queue, campaigns, transactions, inbound, suppression, contacts, alerts, templates, country_caps RESTART IDENTITY CASCADE');
}

export async function seedDemo() {
  seed = 42;
  await clearOperationalData();
  await exec('TRUNCATE rates, fixed_costs RESTART IDENTITY');

  // ---- rate card & fixed fees ----
  const t = now();
  const rates = [];
  for (const [cc, , price, fee] of COUNTRIES) {
    rates.push(['sms', cc, price, fee, 'Sample rate', t]);
    rates.push(['verify_sms', cc, +(price + 0.009).toFixed(4), fee, 'Sample rate (SMS + verification fee)', t]);
    rates.push(['verify_voice', cc, +(price * 1.6 + 0.012).toFixed(4), 0, 'Sample rate per call', t]);
    rates.push(['voice', cc, +(price * 1.3 + 0.006).toFixed(4), 0, 'Sample rate per minute', t]);
    rates.push(['whatsapp', cc, +(price * 0.8 + 0.004).toFixed(4), 0, 'Sample rate per message', t]);
  }
  rates.push(['sms', '*', 0.05, 0, 'Default for countries without a specific rate', t], ['verify_sms', '*', 0.06, 0, 'Default', t],
    ['verify_sms', PUMPING_COUNTRY, 0.142, 0, 'Sample rate (high-cost destination)', t], ['verify_voice', '*', 0.09, 0, 'Default', t],
    ['voice', '*', 0.06, 0, 'Default', t], ['whatsapp', '*', 0.04, 0, 'Default', t],
    ['phoneid', '*', 0.0055, 0, 'Sample flat rate per lookup', t], ['intelligence', '*', 0.0045, 0, 'Sample flat rate per score', t]);
  await bulkInsert('rates', ['product', 'country', 'price', 'carrier_fee', 'note', 'updated_at'], rates);
  const start = new Date(Date.now() - 182 * 864e5).toISOString().slice(0, 10);
  await bulkInsert('fixed_costs', ['name', 'category', 'amount', 'frequency', 'start_date', 'note'], [
    ['US 10DLC brand registration', 'registration', 4.5, 'one-time', start, 'Sample'],
    ['US 10DLC campaign vetting', 'registration', 15, 'one-time', start, 'Sample'],
    ['US 10DLC campaign fee', 'registration', 10, 'monthly', start, 'Sample'],
    ['Dedicated long codes (3 numbers)', 'numbers', 3, 'monthly', start, 'Sample'],
    ['Toll-free number', 'numbers', 2, 'monthly', start, 'Sample'],
    ['UK alphanumeric sender ID registration', 'registration', 60, 'one-time', start, 'Sample'],
    ['Premium support plan', 'support', 600, 'annual', start, 'Sample'],
  ]);
  invalidateRates();
  const priceMap = new Map(rates.map((r) => [`${r[0]}|${r[1]}`, r[2] + r[3]]));
  const cost = (product, cc) => priceMap.get(`${product}|${cc}`) ?? priceMap.get(`${product}|*`) ?? 0;

  let refN = 0;
  const ref = () => 'DEMO' + (++refN).toString(16).toUpperCase().padStart(20, '0');
  const txRows = [];
  function addTx({ product, cc, phone, at, message, messageType, campaignId = null, contactId = null, verified = null, units = 1, forceFail = false }) {
    const country = C[cc];
    const deliveryRate = country ? country[4] : 0.8;
    const info = message ? analyzeSms(message) : { segments: 1, encoding: null };
    let code = 200;
    if (forceFail || rnd() > deliveryRate) code = pick(failCodes);
    else if (rnd() < 0.04) code = 203;
    if (product === 'phoneid' || product === 'intelligence') code = 300;
    const st = describeStatus(code);
    const segs = product === 'sms' || product === 'whatsapp' ? info.segments : product.startsWith('verify') ? 1 : 0;
    const qty = product === 'sms' || product === 'whatsapp' ? segs : units;
    const iso = at.toISOString();
    txRows.push([ref(), product, phone || phoneFor(cc), cc, contactId, campaignId, message || null, messageType || null, info.encoding,
      units, segs, code, st.kind, code === 300 ? 'Completed' : st.text, +(cost(product, cc) * qty).toFixed(5), 'rate_card', verified, 'demo', iso, iso]);
  }

  const DAYS = 182;
  const today = new Date();

  // ---- contacts ----
  const contactRows = [];
  const seen = new Set();
  for (let i = 0; i < 900; i++) {
    const c = weighted();
    const phone = phoneFor(c[0]);
    if (seen.has(phone)) continue;
    seen.add(phone);
    const fn = pick(FIRST), ln = pick(LAST);
    const created = new Date(today.getTime() - rnd() * DAYS * 864e5).toISOString();
    const p = rnd();
    const consent = p < 0.9 ? 'opted_in' : p < 0.95 ? 'unknown' : 'opted_out';
    const tags = [pick(TAGS)].concat(rnd() < 0.4 ? [pick(TAGS)] : []).filter((v, k, a) => a.indexOf(v) === k).join(',');
    contactRows.push([phone, c[0], fn, ln, `${fn}.${ln}${i}@example.com`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''),
      tags, JSON.stringify({ order: String(10000 + i) }), consent, consent === 'unknown' ? null : pick(['checkout', 'web-form', 'in-store', 'import']),
      consent === 'unknown' ? null : created, consent === 'opted_out' ? created : null, created]);
  }
  await bulkInsert('contacts', ['phone', 'country', 'first_name', 'last_name', 'email', 'tags', 'custom', 'consent_status', 'consent_source', 'consent_at', 'opted_out_at', 'created_at'],
    contactRows, 'ON CONFLICT (phone) DO NOTHING');
  await run("INSERT INTO suppression(phone, reason, source, note, created_at) SELECT phone, 'opt-out', 'keyword', 'Replied STOP', opted_out_at FROM contacts WHERE consent_status = 'opted_out' ON CONFLICT DO NOTHING");
  const contacts = await all('SELECT * FROM contacts ORDER BY id');

  // ---- day-by-day traffic ----
  for (let d = DAYS; d >= 0; d--) {
    const day = new Date(today.getTime() - d * 864e5);
    const growth = 0.7 + 0.3 * ((DAYS - d) / DAYS);
    const k = growth * [0.55, 1.05, 1.1, 1.1, 1.05, 1.0, 0.65][day.getDay()];
    const hours = d === 0 ? today.getHours() + today.getMinutes() / 60 : 24;
    const frac = hours / 24;
    const at = () => {
      const x = new Date(day);
      x.setHours(0, 0, 0, 0);
      return new Date(x.getTime() + rnd() * hours * 3600e3);
    };
    const n = (base) => Math.round(base * k * frac * (0.85 + rnd() * 0.3));
    for (let i = n(260); i > 0; i--) {
      addTx({ product: 'sms', cc: weighted()[0], at: at(), message: pick(SMS_BODIES).replace('{first_name}', pick(FIRST)).replace('{order}', String(10000 + Math.floor(rnd() * 900))), messageType: 'ARN' });
    }
    for (let i = n(150); i > 0; i--) { const c = weighted(); addTx({ product: 'verify_sms', cc: c[0], at: at(), verified: rnd() < c[5] ? 1 : 0 }); }
    for (let i = n(14); i > 0; i--) { const c = weighted(); addTx({ product: 'verify_voice', cc: c[0], at: at(), verified: rnd() < c[5] ? 1 : 0 }); }
    for (let i = n(45); i > 0; i--) addTx({ product: 'phoneid', cc: weighted()[0], at: at() });
    for (let i = n(25); i > 0; i--) addTx({ product: 'intelligence', cc: weighted()[0], at: at() });
    for (let i = n(6); i > 0; i--) addTx({ product: 'voice', cc: weighted()[0], at: at(), units: 1 + Math.floor(rnd() * 4) });
    if (d < 75) for (let i = n(30); i > 0; i--) addTx({ product: 'whatsapp', cc: weighted()[0], at: at(), message: pick(SMS_BODIES) });
    // SMS pumping attack during the last ~30 hours
    if (d <= 1) {
      const count = Math.round((d === 1 ? 140 : 260) * frac);
      for (let i = 0; i < count; i++) {
        const x = at();
        if (d === 1 && x.getHours() < 18) continue;
        addTx({ product: 'verify_sms', cc: PUMPING_COUNTRY, at: x, verified: rnd() < 0.06 ? 1 : 0, phone: '+99655' + String(Math.floor(rnd() * 1e7)).padStart(7, '0') });
      }
    }
  }

  // ---- campaigns ----
  const plans = [
    ['Summer sale announcement', 'Hi {first_name}! Our summer sale is live: 20% off everything until Sunday. Shop now: example.com/sale Reply STOP to opt out', null, 150],
    ['VIP early access', '{first_name}, as a VIP you get early access to our new collection today. Reply STOP to opt out', 'vip', 95],
    ['Black Friday preview 🎉', 'Black Friday starts early for you, {first_name} 🎉 Up to 40% off — example.com/bf Reply STOP to opt out', 'newsletter', 30],
    ['Win-back offer', 'We miss you {first_name}! Here is 15% off your next order with code BACK15. Reply STOP to opt out', 'churn-risk', 12],
  ];
  const queueRows = [];
  for (const [name, body, tag, daysAgo] of plans) {
    const day = new Date(today.getTime() - daysAgo * 864e5);
    day.setHours(10, 0, 0, 0);
    const list = contacts.filter((ct) => ct.consent_status !== 'opted_out' && (!tag || `,${ct.tags},`.includes(`,${tag},`)));
    let total = 0;
    const cid = (await get(`INSERT INTO campaigns(name, body, message_type, audience_tag, status, scheduled_at, rate_per_minute, total, estimated_cost, created_by, created_at, started_at, completed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`, name, body, 'MKT', tag, 'completed', day.toISOString(), 120, list.length, 0, 'demo@admin',
      day.toISOString(), day.toISOString(), new Date(day.getTime() + list.length * 500).toISOString())).id;
    list.forEach((ct, i) => {
      const custom = JSON.parse(ct.custom);
      const msg = body.replace(/\{first_name\}/g, ct.first_name).replace(/\{order\}/g, custom.order);
      addTx({ product: 'sms', cc: ct.country, phone: ct.phone, at: new Date(day.getTime() + i * 500), message: msg, messageType: 'MKT', campaignId: cid, contactId: ct.id });
      queueRows.push([cid, ct.id, 'sent']);
      total += cost('sms', ct.country) * analyzeSms(msg).segments;
    });
    await run('UPDATE campaigns SET estimated_cost = ? WHERE id = ?', +total.toFixed(2), cid);
  }
  await bulkInsert('transactions', TX_COLS, txRows);
  await bulkInsert('campaign_queue', ['campaign_id', 'contact_id', 'status'], queueRows, 'ON CONFLICT DO NOTHING');
  await run(`UPDATE campaign_queue q SET transaction_id = t.id FROM transactions t
    WHERE t.campaign_id = q.campaign_id AND t.contact_id = q.contact_id AND q.transaction_id IS NULL`);
  const next = new Date(today.getTime() + 3 * 864e5);
  next.setHours(10, 0, 0, 0);
  await run(`INSERT INTO campaigns(name, body, message_type, audience_tag, status, scheduled_at, rate_per_minute, created_by, created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`, 'Holiday gift guide', 'Hi {first_name}, our holiday gift guide is here: example.com/gifts Reply STOP to opt out',
    'MKT', 'newsletter', 'draft', next.toISOString(), 60, 'demo@admin', now());

  // ---- templates ----
  await bulkInsert('templates', ['name', 'body', 'created_at'], [
    ['Order shipped', 'Hi {first_name}, your order #{order} has shipped. Track it at example.com/t/{order}', now()],
    ['Appointment reminder', 'Reminder: your appointment is tomorrow at {time|10:00}. Reply C to cancel.', now()],
    ['Promo (with opt-out)', 'Hi {first_name|there}! {offer|Enjoy 10% off} this week only. Reply STOP to opt out', now()],
  ]);

  // ---- inbound replies ----
  const replies = ['Thanks!', 'What time do you open on Saturday?', 'Is the sale online only?', 'Great, see you then', 'Can I change my delivery address?', 'C', 'Who is this?', '👍', 'YES'];
  const sample = [...contacts].sort(() => rnd() - 0.5).slice(0, 160);
  const inboundRows = sample.map((ct, i) => {
    if (ct.consent_status === 'opted_out') return [ct.phone, ct.country, 'STOP', ct.id, 1, 0, 1, ct.opted_out_at];
    const body = pick(replies);
    return [ct.phone, ct.country, body, ct.id, 0, body === 'YES' ? 1 : 0, i < 12 ? 0 : 1, new Date(today.getTime() - rnd() * (i < 12 ? 2 : 60) * 864e5).toISOString()];
  });
  await bulkInsert('inbound', ['phone', 'country', 'body', 'contact_id', 'is_optout', 'is_optin', 'read', 'received_at'], inboundRows);

  // Budget defaults sized so the forecast shows a realistic "on track to exceed" situation; daily limit leaves headroom for demo sends.
  const ym = today.toISOString().slice(0, 7);
  const mtd = (await get('SELECT SUM(cost) AS s FROM transactions WHERE created_at >= ?', ym + '-01')).s || 0;
  const todaySpend = (await get('SELECT SUM(cost) AS s FROM transactions WHERE created_at >= ?', today.toISOString().slice(0, 10))).s || 0;
  const dayOfMonth = today.getUTCDate() - 1 + today.getUTCHours() / 24 || 1;
  const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
  const projected = (mtd / dayOfMonth) * daysInMonth;
  const daily = Math.max((mtd / dayOfMonth) * 1.8, todaySpend * 1.6);
  await setSettings({ demo_mode: '1', monthly_budget: Math.ceil((projected * 0.92) / 50) * 50, daily_budget: Math.ceil(daily / 5) * 5, company_name: 'Northwind Retail (demo)' });
  await bulkInsert('country_caps', ['country', 'monthly_cap'], [['NG', 25], ['IN', 40]], 'ON CONFLICT (country) DO UPDATE SET monthly_cap = EXCLUDED.monthly_cap');
  await evaluateAlerts();
  return (await get('SELECT COUNT(*) AS n FROM transactions')).n;
}
