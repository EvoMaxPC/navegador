/**
 * `inspectOutgoing`: el respaldo del guardián en la red.
 *
 * Lo que se comprueba es lo delicado: que FRENE cuando hay datos críticos y que
 * NO frene en ningún otro caso. Un falso positivo aquí rompe el navegador para
 * todo el mundo; un falso negativo deja el agujero.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { inspectOutgoing } from '../src/main/egressNet.js';
import { normalizeEgress } from '../src/core/egressConfig.js';

const TARJETA = '4111 1111 1111 1111';
const enforce = normalizeEgress({ mode: 'enforce' });

/** Cuerpo con un solo mensaje de usuario. */
const cuerpo = (texto) => JSON.stringify({
  action: 'next',
  messages: [
    { id: 'm-0', author: { role: 'assistant' }, content: { parts: ['claro, dime'] } },
    { id: 'm-1', author: { role: 'user' }, content: { content_type: 'text', parts: [texto] } },
  ],
});

const inspeccionar = (bodyText, over = {}) =>
  inspectOutgoing({ method: 'POST', bodyText, config: enforce, ...over });

test('tarjeta: cancela', () => {
  const r = inspeccionar(cuerpo(`mi tarjeta es ${TARJETA}`));
  assert.equal(r.cancel, true);
  assert.equal(r.reason, 'critico:card×1');
  assert.deepEqual(r.summary, [{ type: 'card', count: 1 }]);
});

test('[CARD_1] ya redactado: no cancela', () => {
  const r = inspeccionar(cuerpo('mi tarjeta es [CARD_1]'));
  assert.equal(r.cancel, false);
  assert.equal(r.reason, 'sin-criticos');
});

test('email (dato medio): no cancela', () => {
  const r = inspeccionar(cuerpo('escríbeme a ana@ejemplo.com'));
  assert.equal(r.cancel, false);
  assert.equal(r.reason, 'sin-criticos');
  assert.deepEqual(r.summary, []);
});

test('JSON inválido: no cancela', () => {
  const r = inspeccionar('no soy json');
  assert.deepEqual(r, { cancel: false, reason: 'json-invalido', summary: [] });
});

test('cuerpo vacío o que no es texto: no cancela', () => {
  assert.equal(inspeccionar('').reason, 'cuerpo-no-legible');
  assert.equal(inspeccionar(null).reason, 'cuerpo-no-legible');
  assert.equal(inspeccionar(undefined).reason, 'cuerpo-no-legible');
});

test('observe y off: no cancelan', () => {
  const conTarjeta = cuerpo(`mi tarjeta es ${TARJETA}`);
  assert.deepEqual(inspeccionar(conTarjeta, { config: normalizeEgress({ mode: 'observe' }) }),
    { cancel: false, reason: 'modo-observe', summary: [] });
  assert.deepEqual(inspeccionar(conTarjeta, { config: normalizeEgress({ mode: 'off' }) }),
    { cancel: false, reason: 'modo-off', summary: [] });
});

test('allowSendCritical: el usuario pidió enviar igual, no cancela', () => {
  const r = inspeccionar(cuerpo(`mi tarjeta es ${TARJETA}`), {
    config: normalizeEgress({ mode: 'enforce', allowSendCritical: true }),
  });
  assert.equal(r.cancel, false);
  assert.equal(r.reason, 'allowSendCritical');
});

test('GET: no cancela aunque el cuerpo traiga la tarjeta', () => {
  const r = inspeccionar(cuerpo(`mi tarjeta es ${TARJETA}`), { method: 'GET' });
  assert.equal(r.cancel, false);
  assert.equal(r.reason, 'metodo');
});

test('tarjeta sólo en el historial (mensaje user anterior): no cancela', () => {
  const historial = JSON.stringify({
    action: 'next',
    messages: [
      { id: 'm-0', author: { role: 'user' }, content: { parts: [`mi tarjeta es ${TARJETA}`] } },
      { id: 'm-1', author: { role: 'assistant' }, content: { parts: ['anotado'] } },
      { id: 'm-2', author: { role: 'user' }, content: { parts: ['¿y ahora qué?'] } },
    ],
  });
  const r = inspeccionar(historial);
  assert.equal(r.cancel, false, 'sólo mira el último mensaje del usuario');
  assert.equal(r.reason, 'sin-criticos');
});

test('sin mensajes: no cancela', () => {
  assert.equal(inspeccionar(JSON.stringify({ action: 'next' })).reason, 'sin-slots');
  assert.equal(inspeccionar(JSON.stringify({ messages: [] })).reason, 'sin-slots');
});

test('el summary no contiene el número ni el valor', () => {
  const r = inspeccionar(cuerpo(`mi tarjeta es ${TARJETA}`));
  const serializado = JSON.stringify(r);
  assert.equal(serializado.includes('4111'), false, `se filtró el valor: ${serializado}`);
  assert.equal(serializado.includes('1111'), false);
  assert.deepEqual(Object.keys(r.summary[0]).sort(), ['count', 'type']);
});

test('varios datos críticos: el summary los cuenta sin valores', () => {
  const dos = cuerpo(`tarjeta ${TARJETA} y clave -----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----`);
  const r = inspeccionar(dos);
  assert.equal(r.cancel, true);
  assert.equal(r.reason, 'critico:card×1, api_key×1');
  assert.deepEqual(r.summary.map((s) => s.type).sort(), ['api_key', 'card']);
  assert.equal(JSON.stringify(r).includes('4111'), false);
});

test('sólo strings del array de partes: los adjuntos no se inspeccionan', () => {
  const conAdjunto = JSON.stringify({
    action: 'next',
    messages: [{
      id: 'm-1', author: { role: 'user' },
      content: { content_type: 'text', parts: [{ type: 'image', b64: TARJETA }] },
    }],
  });
  const r = inspeccionar(conAdjunto);
  assert.equal(r.cancel, false);
  assert.equal(r.reason, 'sin-slots');
});

test('config ausente: no cancela (falla abierto)', () => {
  assert.equal(inspectOutgoing({ method: 'POST', bodyText: cuerpo(TARJETA) }).reason, 'modo-desconocido');
});
