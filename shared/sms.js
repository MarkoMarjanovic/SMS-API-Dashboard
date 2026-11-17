// SMS segment & encoding calculator (GSM 03.38 vs UCS-2).
// Shared by the server (billing) and the browser (live counters).

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\[~]|€\f';

const basicSet = new Set([...GSM_BASIC]);
const extSet = new Set([...GSM_EXTENDED]);

/** Characters that force UCS-2 encoding (deduplicated, in order of appearance). */
export function nonGsmChars(text = '') {
  const out = [];
  for (const ch of text) {
    if (!basicSet.has(ch) && !extSet.has(ch) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

/**
 * Returns { encoding, length, segments, perSegment, remaining, unicodeChars, extendedChars }.
 * GSM-7: 160 chars single / 153 per part. Extended chars (€ [ ] { } ...) count as 2.
 * UCS-2: 70 chars single / 67 per part. Emoji & other astral chars count as 2 (UTF-16 units).
 */
export function analyzeSms(text = '') {
  const unicodeChars = nonGsmChars(text);
  if (unicodeChars.length === 0) {
    let length = 0;
    const extendedChars = [];
    for (const ch of text) {
      if (extSet.has(ch)) {
        length += 2;
        if (!extendedChars.includes(ch)) extendedChars.push(ch);
      } else length += 1;
    }
    const single = 160, multi = 153;
    const segments = length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multi);
    const perSegment = segments > 1 ? multi : single;
    return { encoding: 'GSM-7', length, segments, perSegment, remaining: segments ? segments * perSegment - length : single, unicodeChars, extendedChars };
  }
  const length = text.length; // UTF-16 code units
  const single = 70, multi = 67;
  const segments = length <= single ? 1 : Math.ceil(length / multi);
  const perSegment = segments > 1 ? multi : single;
  return { encoding: 'UCS-2', length, segments, perSegment, remaining: segments * perSegment - length, unicodeChars, extendedChars: [] };
}

/** Common "smart" characters that silently switch a message to UCS-2, with GSM-safe replacements. */
export const GSM_REPLACEMENTS = {
  '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"', '–': '-', '—': '-', '…': '...',
  ' ': ' ', '•': '-', '´': "'", '`': "'", 'á': 'a', 'í': 'i', 'ó': 'o', 'ú': 'u', 'â': 'a', 'ê': 'e', 'î': 'i', 'ô': 'o', 'û': 'u', 'ç': 'c',
};

export function toGsmSafe(text = '') {
  return [...text].map((ch) => GSM_REPLACEMENTS[ch] ?? ch).join('');
}

/** Render a template like "Hi {first_name}" against a contact object. Missing fields use {field|fallback}. */
export function renderTemplate(body = '', vars = {}) {
  return body.replace(/\{\s*([a-zA-Z0-9_]+)\s*(?:\|([^}]*))?\}/g, (_, key, fallback) => {
    const v = vars[key];
    return v === undefined || v === null || v === '' ? (fallback ?? '') : String(v);
  });
}
