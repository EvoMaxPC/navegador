/**
 * 7c-4a: el acceso de sólo lectura a las claves del acumulador.
 *
 * `records()` y `keysFor()` existen para el diagnóstico. Si tocaran el estado,
 * los contadores cambiarían al encender `NEXO_DIAG=1`, que es justo lo que no
 * puede pasar: la instrumentación no altera lo que mide.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DomTokenTotals } from '../src/main/domTokenTotals.js';

const href = 'https://chatgpt.com/c/claves';
const turns = [
  { id: 'u1', role: 'user', content: 'hola, ¿qué tal' },
  { id: 'a1', role: 'assistant', content: 'respuesta' },
];
const snapshot = (overrides = {}) => ({ webContentsId: 123, href, turns, ...overrides });

test('keysFor no modifica el estado: observe da lo mismo con y sin la consulta', () => {
  const limpio = new DomTokenTotals();
  limpio.observe(snapshot());
  const esperado = limpio.stats();

  const consultado = new DomTokenTotals();
  consultado.keysFor(snapshot());
  consultado.records();
  consultado.keysFor(snapshot());
  consultado.observe(snapshot());
  const obtenido = consultado.stats();

  assert.deepEqual(obtenido, esperado, 'consultar las claves antes de observar no cambia los contadores');
});

test('keysFor devuelve una clave por turno, con el mismo formato que el acumulador', () => {
  const ledger = new DomTokenTotals();
  const claves = ledger.keysFor(snapshot());
  assert.equal(claves.length, 2);
  assert.deepEqual(claves.map((c) => c.role), ['user', 'assistant']);
  assert.deepEqual(claves.map((c) => c.id), ['u1', 'a1']);
  assert.equal(claves[0].chars, 'hola, ¿qué tal'.length);
  // La clave es la que usa observe: `conversation\0role\0id`.
  assert.equal(claves[0].clave, `${href}\u0000user\u0000u1`);
  assert.equal(claves[1].clave, `${href}\u0000assistant\u0000a1`);
});

test('records refleja el acumulador y no lo infla al consultarlo', () => {
  const ledger = new DomTokenTotals();
  assert.equal(ledger.records(), 0);
  ledger.observe(snapshot());
  assert.equal(ledger.records(), 2);
  assert.equal(ledger.records(), 2, 'consultar dos veces no suma');
  // Repetir los mismos turnos no añade claves: el id es el mismo.
  ledger.observe(snapshot());
  assert.equal(ledger.records(), 2);
  // Un id nuevo es una clave nueva.
  ledger.observe(snapshot({ turns: [...turns, { id: 'u2', role: 'user', content: 'otra' }] }));
  assert.equal(ledger.records(), 3);
});

test('keysFor usa la misma conversación anónima que observe (sin escribirla)', () => {
  const ledger = new DomTokenTotals();
  const anonimo = { webContentsId: 7, href: 'https://chatgpt.com/', turns };
  const antes = ledger.keysFor(anonimo)[0].clave;
  // Consultar no puede dejar la pestaña registrada: `tabs` lo escribe `observe`.
  // Si `keysFor` la escribiera, una consulta cambiaría la identidad que usará
  // después la observación real.
  assert.equal(ledger.project().tabs.size, 0, 'keysFor no registra la pestaña');
  const despues = ledger.keysFor(anonimo)[0].clave;
  assert.equal(ledger.project().tabs.size, 0, 'consultar dos veces tampoco');
  assert.equal(antes, despues, 'consultar dos veces no avanza la generación anónima');
  // Y no debe haber dejado la pestaña registrada: eso lo hace `observe`, no una
  // consulta. Si `keysFor` escribiera `tabs`, el siguiente `observe` reutilizaría
  // una identidad que nadie observó.
  assert.equal(ledger.records(), 0, 'consultar no añade registros');
  const trasPrimeraConsulta = ledger.keysFor(anonimo)[0].clave;
  ledger.observe(anonimo);
  assert.equal(ledger.keysFor(anonimo)[0].clave, trasPrimeraConsulta, 'la identidad que usa observe es la que predijo keysFor');
  ledger.observe(anonimo);
  // Tras observar sí se creó la pestaña: la clave que calcula observe es la que
  // `keysFor` predijo, y el contador sólo tiene esos dos turnos.
  assert.equal(ledger.records(), 2);
  assert.match(antes, /#tab-7-1\u0000user\u0000u1$/);
});
