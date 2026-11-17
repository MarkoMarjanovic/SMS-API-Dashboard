// Telesign products tracked by the dashboard. `unit` is what the rate card price applies to.
// Colors follow a fixed categorical order (validated CVD-safe for adjacent pairs).
export const PRODUCTS = {
  sms:          { label: 'SMS',            unit: 'segment',      color: 1 },
  verify_sms:   { label: 'SMS Verify',     unit: 'verification', color: 2 },
  verify_voice: { label: 'Voice Verify',   unit: 'call',         color: 3 },
  voice:        { label: 'Voice',          unit: 'minute',       color: 4 },
  phoneid:      { label: 'Phone ID',       unit: 'lookup',       color: 5 },
  intelligence: { label: 'Intelligence',   unit: 'score',        color: 6 },
  whatsapp:     { label: 'WhatsApp',       unit: 'message',      color: 7 },
};
export const PRODUCT_KEYS = Object.keys(PRODUCTS);

/** Best-effort mapping of a product name from an imported CSV / invoice line to a product key. */
export function guessProduct(text = '') {
  const t = String(text).toLowerCase();
  if (/whats\s*app/.test(t)) return 'whatsapp';
  if (/verify/.test(t) && /(voice|call)/.test(t)) return 'verify_voice';
  if (/verify|otp|2fa/.test(t)) return 'verify_sms';
  if (/phone\s*id|phoneid|lookup/.test(t)) return 'phoneid';
  if (/score|intelligence|fraud/.test(t)) return 'intelligence';
  if (/voice|call/.test(t)) return 'voice';
  return 'sms';
}
