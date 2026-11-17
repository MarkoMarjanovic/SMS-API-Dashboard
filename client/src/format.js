import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json';
import { PRODUCTS } from '@shared/products.js';

countries.registerLocale(en);

let currency = 'USD';
export const setCurrency = (c) => { currency = c || 'USD'; };

export function money(n, { precise = false, cur } = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  const digits = precise ? (abs < 0.1 ? 4 : 3) : abs >= 1000 ? 0 : 2;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

export const num = (n, d = 0) => (n === null || n === undefined ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: d }).format(n));
export const compact = (n) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
export const pct = (n, d = 1) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(d)}%`);

export function delta(cur, prev) {
  if (!prev || cur === null || cur === undefined) return null;
  return (cur - prev) / prev;
}

export const countryName = (cc) => (cc === '??' || !cc ? 'Unknown' : cc === '*' ? 'All other countries' : countries.getName(cc, 'en') || cc);
export const flag = (cc) => (!cc || cc.length !== 2 || cc === '??' ? '🌐' : String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))));
export const alpha2ToNumeric = (cc) => countries.alpha2ToNumeric(cc);
export const numericToAlpha2 = (n) => countries.numericToAlpha2(n);
export const allCountries = () => Object.entries(countries.getNames('en', { select: 'official' })).map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));

export const productLabel = (p) => PRODUCTS[p]?.label || p;

export function dateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function dateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length === 7 ? iso + '-01T00:00:00' : iso.length === 10 ? iso + 'T00:00:00' : iso);
  return iso.length === 7 ? d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function downloadUrl(url) {
  const a = document.createElement('a');
  a.href = '/api' + url;
  a.click();
}
