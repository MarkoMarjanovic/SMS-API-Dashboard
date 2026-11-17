// Telesign messaging status codes (subset). Check the Telesign docs ("Transaction status codes")
// for the authoritative and complete list; unknown codes fall back to a generic description.
export const STATUS = {
  200: { text: 'Delivered to handset', kind: 'delivered' },
  203: { text: 'Delivered to gateway', kind: 'delivered' },
  207: { text: 'Error delivering SMS to handset (reason unknown)', kind: 'failed' },
  210: { text: 'Temporary phone error', kind: 'failed' },
  211: { text: 'Permanent phone error', kind: 'failed' },
  220: { text: 'Gateway/network cannot route message', kind: 'failed' },
  221: { text: 'Message expired before delivery', kind: 'failed' },
  222: { text: 'SMS not supported on this number', kind: 'failed' },
  229: { text: 'Message blocked (spam/content filter)', kind: 'failed' },
  230: { text: 'Message blocked by carrier', kind: 'failed' },
  231: { text: 'Destination blocked (prefix or country)', kind: 'failed' },
  237: { text: 'Message blocked: sender ID not registered', kind: 'failed' },
  250: { text: 'Final status unknown', kind: 'unknown' },
  290: { text: 'Message in progress', kind: 'pending' },
  300: { text: 'Lookup completed', kind: 'delivered' },
  295: { text: 'Message queued', kind: 'pending' },
  500: { text: 'Transaction not attempted', kind: 'failed' },
  502: { text: 'Carrier rejected the message', kind: 'failed' },
  503: { text: 'Operator not supported', kind: 'failed' },
  // Dashboard-internal codes (never sent by Telesign)
  900: { text: 'Blocked by dashboard: recipient opted out / suppressed', kind: 'blocked' },
  901: { text: 'Blocked by dashboard: spending limit reached', kind: 'blocked' },
  902: { text: 'Blocked by dashboard: country not allowed', kind: 'blocked' },
  903: { text: 'Blocked by dashboard: invalid phone number', kind: 'blocked' },
  904: { text: 'Request to Telesign failed (network/auth error)', kind: 'failed' },
  905: { text: 'Blocked by dashboard: quiet hours / rate limit', kind: 'blocked' },
};

export function describeStatus(code) {
  if (code === null || code === undefined || code === '') return { text: 'No status', kind: 'unknown' };
  return STATUS[code] ?? { text: `Status code ${code}`, kind: 'unknown' };
}

/** Advice shown in the message log for common failures. */
export const STATUS_ADVICE = {
  210: 'Usually transient (phone off / out of coverage). A later retry is reasonable.',
  211: 'Number is likely invalid or disconnected. Consider removing it from your list.',
  220: 'The carrier route is unavailable. Contact Telesign support if this repeats for a country.',
  221: 'The handset was unreachable for the validity period.',
  229: 'Content looked like spam. Avoid URL shorteners and ALL CAPS; register your sender.',
  230: 'Carrier filtering. Check sender registration (10DLC / toll-free / alphanumeric) for that country.',
  237: 'Register your sender ID for this country (many countries require pre-registration).',
  900: 'The recipient opted out. Sending would violate consent rules.',
  901: 'A budget or country cap was hit. Adjust it under Spending controls.',
  902: 'Add the country to the allow list under Spending controls if this traffic is legitimate.',
  903: 'Store numbers in international E.164 format, e.g. +14155550123.',
  904: 'Check your Telesign credentials on the Settings page and your network connection.',
};
