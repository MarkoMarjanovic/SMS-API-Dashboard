import { parsePhoneNumberFromString } from 'libphonenumber-js';
import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import { all } from './db.js';

countries.registerLocale(en);
const EXTRA_NAMES = { 'VIET NAM': 'VN', 'UK': 'GB', 'GREAT BRITAIN': 'GB', 'KOREA': 'KR', 'HOLLAND': 'NL' };

/** Normalise "US", "us", "United States", "USA" … to an ISO alpha-2 code. Keeps "*" (rate card default). */
export function toIsoCountry(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (s === '*') return '*';
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  if (/^[A-Za-z]{3}$/.test(s)) return countries.alpha3ToAlpha2(s.toUpperCase()) || EXTRA_NAMES[s.toUpperCase()] || null;
  return countries.getAlpha2Code(s, 'en') || EXTRA_NAMES[s.toUpperCase()] || null;
}

/** Normalize to E.164 ("+14155550123") and detect the ISO country. Returns null if invalid. */
export function parsePhone(input, defaultCountry) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (/^00\d/.test(s)) s = '+' + s.slice(2);
  // Telesign style numbers are digits with country code but no '+'
  if (/^\d{8,15}$/.test(s) && !defaultCountry) s = '+' + s;
  const p = parsePhoneNumberFromString(s, defaultCountry);
  if (!p || !p.isPossible()) return null;
  // Fictional / unassigned ranges (e.g. UK +44 7700 900xxx) have no single country; fall back to the calling code's main country.
  return { e164: p.number, country: p.country || p.getPossibleCountries?.()[0] || null };
}

let cache = null;
export function invalidateRates() { cache = null; }

function rateMap() {
  if (!cache) {
    cache = new Map();
    for (const r of all('SELECT product, country, price, carrier_fee FROM rates')) cache.set(`${r.product}|${r.country}`, r);
  }
  return cache;
}

/** Price per unit (incl. carrier pass-through fee) for a product/country; falls back to the '*' default row. */
export function unitPrice(product, country) {
  const m = rateMap();
  const r = m.get(`${product}|${country}`) || m.get(`${product}|*`);
  if (!r) return { price: 0, carrierFee: 0, total: 0, found: false };
  return { price: r.price, carrierFee: r.carrier_fee, total: r.price + r.carrier_fee, found: true, isDefault: r.country === '*' };
}

/** Estimated cost: SMS is billed per segment, other products per unit. */
export function estimateCost(product, country, { segments = 1, units = 1 } = {}) {
  const { total } = unitPrice(product, country);
  const qty = product === 'sms' || product === 'whatsapp' ? segments : units;
  return round(total * qty);
}

export const round = (n, d = 5) => Math.round(n * 10 ** d) / 10 ** d;

/** Fixed costs attributable to a calendar month (YYYY-MM). Annual costs are spread over 12 months. */
export function fixedCostsForMonth(ym) {
  const monthStart = `${ym}-01`;
  const [y, m] = ym.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  let total = 0;
  const items = [];
  for (const f of all('SELECT * FROM fixed_costs')) {
    if (f.start_date > monthEnd) continue;
    if (f.end_date && f.end_date < monthStart) continue;
    let amount = 0;
    if (f.frequency === 'monthly') amount = f.amount;
    else if (f.frequency === 'annual') amount = f.amount / 12;
    else if (f.frequency === 'one-time' && f.start_date.slice(0, 7) === ym) amount = f.amount;
    if (amount) {
      total += amount;
      items.push({ ...f, month_amount: round(amount, 2) });
    }
  }
  return { total: round(total, 2), items };
}
