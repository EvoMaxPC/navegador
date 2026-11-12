import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSensitive } from '../src/egress/detect.js';
import { decide } from '../src/egress/policy.js';
import { createVault } from '../src/egress/vault.js';
import { redact, summarize } from '../src/egress/redact.js';

const CARD = '4111 1111 1111 1111';

test('policy: sin hallazgos o solo medios no interrumpe', () => {
  assert.equal(decide([], {}).action, 'pass');
  assert.equal(decide(detectSensitive('a@example.com'), {}).action, 'pass');
  assert.equal(decide(undefined, undefined).action, 'pass');
});

test('policy: crítico pregunta; enviar solo si allowSendCritical es true', () => {
  const fs = detectSensitive(`${CARD} y a@example.com`);
  const d = decide(fs, { allowSendCritical: false });
  assert.equal(d.action, 'ask');
  assert.deepEqual(d.allowed, ['redact', 'cancel']);
  assert.deepEqual(d.redactTypes, ['card']);
  assert.deepEqual(decide(fs, { allowSendCritical: true }).allowed, ['redact', 'cancel', 'send']);
  assert.deepEqual(decide(fs, { allowSendCritical: 'true' }).allowed, ['redact', 'cancel']);
});

test('redact: sustituye por placeholder', () => {
  const t = `pago ${CARD} gracias`;
  assert.equal(redact(t, detectSensitive(t), createVault()), 'pago [CARD_1] gracias');
});

test('redact: mismo email = mismo placeholder; otro email = otro', () => {
  const t = 'a@example.com b@example.com a@example.com';
  assert.equal(redact(t, detectSensitive(t), createVault()), '[EMAIL_1] [EMAIL_2] [EMAIL_1]');
});

test('redact con only: deja intacto lo demás', () => {
  const t = `${CARD} y a@example.com`;
  assert.equal(redact(t, detectSensitive(t), createVault(), { only: ['card'] }), '[CARD_1] y a@example.com');
});

test('vault: restaura el email pero nunca la tarjeta', () => {
  const t = `${CARD} y a@example.com`;
  const v = createVault();
  const red = redact(t, detectSensitive(t), v);
  const back = v.reverse(red);
  assert.ok(back.includes('a@example.com'));
  assert.ok(!back.includes('4111'));
  assert.ok(back.includes('[CARD_1]'));
  v.clear();
  assert.equal(v.size, 0);
  assert.equal(v.reverse('[EMAIL_1]'), '[EMAIL_1]');
});

test('redact: el resultado ya no contiene hallazgos y no muta la entrada', () => {
  const t = `${CARD} y a@example.com y 12345678Z`;
  const fs = Object.freeze(detectSensitive(t).map((f) => Object.freeze({ ...f })));
  const red = redact(t, fs, createVault());
  assert.deepEqual(detectSensitive(red), []);
});

test('summarize: tipos y cantidades, nunca valores', () => {
  const s = summarize(detectSensitive(`${CARD} y a@example.com y b@example.com`));
  assert.deepEqual(s, [
    { type: 'card', severity: 'critical', count: 1 },
    { type: 'email', severity: 'medium', count: 2 },
  ]);
  assert.ok(!JSON.stringify(s).includes('4111'));
});
