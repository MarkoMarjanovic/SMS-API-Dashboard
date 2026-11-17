import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSms, renderTemplate, toGsmSafe } from '../shared/sms.js';

test('plain GSM-7 fits 160 chars in one segment', () => {
  const r = analyzeSms('a'.repeat(160));
  assert.equal(r.encoding, 'GSM-7');
  assert.equal(r.segments, 1);
});

test('161 GSM chars become 2 segments of 153', () => {
  assert.equal(analyzeSms('a'.repeat(161)).segments, 2);
  assert.equal(analyzeSms('a'.repeat(306)).segments, 2);
  assert.equal(analyzeSms('a'.repeat(307)).segments, 3);
});

test('extended chars count double', () => {
  const r = analyzeSms('€'.repeat(80));
  assert.equal(r.length, 160);
  assert.equal(r.segments, 1);
  assert.equal(analyzeSms('€'.repeat(81)).segments, 2);
});

test('emoji forces UCS-2 (70 / 67)', () => {
  const r = analyzeSms('Hello 🎉');
  assert.equal(r.encoding, 'UCS-2');
  assert.deepEqual(r.unicodeChars, ['🎉']);
  assert.equal(analyzeSms('é'.repeat(70)).encoding, 'GSM-7'); // é is in GSM basic set
  assert.equal(analyzeSms('ž'.repeat(70)).segments, 1);
  assert.equal(analyzeSms('ž'.repeat(71)).segments, 2);
});

test('smart quotes are replaced by GSM-safe chars', () => {
  const s = toGsmSafe('It’s “great” – really…');
  assert.equal(analyzeSms(s).encoding, 'GSM-7');
});

test('template rendering with fallback', () => {
  assert.equal(renderTemplate('Hi {first_name|there}, #{order}', { order: 5 }), 'Hi there, #5');
  assert.equal(renderTemplate('Hi {first_name}', { first_name: 'Ana' }), 'Hi Ana');
});
