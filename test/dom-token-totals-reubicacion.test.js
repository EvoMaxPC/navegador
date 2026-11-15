/**
 * Reubicación de claves del acumulador DOM: `visible-N` es una POSICIÓN.
 *
 * Medido en Electron real: al abrir un chat, la lectura trae los turnos ya
 * cargados y, en la siguiente, el historial ha empujado los ids hacia abajo
 * (`visible-6` → `visible-2`, `visible-7` → `visible-3` al retirarse 4 nodos
 * anteriores). Con la clave `${conversación}\0${rol}\0${id}` el mismo texto
 * entraba bajo dos claves distintas y el registro que ocupaba la clave nueva se
 * pisaba: el panel mostraba el doble de la última respuesta y perdía la anterior.
 *
 * `observe` resuelve ahora la clave de cada turno aceptado en tres pasadas
 * (exacta, huella no reclamada, resto con clave de colisión) contra los registros
 * de ESA conversación. Los registros que ningún turno reclama no se borran.
 *
 * Textos sintéticos, un patrón por mensaje; el MISMO texto se repite sólo donde
 * el caso lo exige (el usuario de 106 c en `visible-6`/`visible-2` y el asistente
 * de 3848 c en `visible-7`/`visible-3`). Ningún dato del chat.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DomTokenTotals } from '../src/main/domTokenTotals.js';
import { calculateTokenizer } from '../src/main/tokenizerCalculator.js';

const tok = (texto) => calculateTokenizer({ text: texto, model: 'gpt-4o' }).tokens;
const mk = (ch, n) => ch.repeat(n);

// Un patrón distinto por mensaje, para que las huellas no colisionen por error.
const U58 = mk('a', 58), U127 = mk('b', 127), U106 = mk('c', 106);
const A4419 = mk('d', 4419), A3848 = mk('e', 3848);

const turn = (id, role, content) => ({ id, role, content });
const HREF = 'https://chatgpt.com/c/reubicacion-inventada';
const snapshot = (turns, extra = {}) => ({ projectId: 'p', webContentsId: 7, href: HREF, turns, source: 'isolated', ...extra });
const activa = (ledger) => ledger.stats('p', undefined, { soloActiva: true });

/** R1–R4: la secuencia medida, con textos sintéticos. */
const R1 = [
  turn('visible-2', 'user', U58),
  turn('visible-4', 'user', U127),
  turn('visible-6', 'user', U106),
];
const R2 = [...R1, turn('visible-3', 'assistant', A4419)];
const R3 = [...R2, turn('visible-7', 'assistant', A3848)];
const R4 = [turn('visible-2', 'user', U106), turn('visible-3', 'assistant', A3848)];

test('S1 secuencia medida R1–R4: 5 registros y los totales exactos', () => {
  const ledger = new DomTokenTotals();
  for (const lectura of [R1, R2, R3, R4]) ledger.observe(snapshot(lectura));

  const stats = activa(ledger);
  assert.equal(ledger.records('p'), 5, 'un registro por mensaje: ni perdido ni duplicado');
  assert.equal(stats.inputTokens, tok(U58) + tok(U127) + tok(U106), 'entrada = los tres usuarios');
  assert.equal(stats.outputTokens, tok(A4419) + tok(A3848), 'salida = las dos respuestas');
  assert.equal(stats.userMessages, 3);
  assert.equal(stats.assistantMessages, 2);
  // El texto de 3848 c cuenta una sola vez: si estuviera duplicado, la salida
  // sería tok(A4419) + 2 * tok(A3848) (el defecto medido).
  assert.notEqual(stats.outputTokens, tok(A4419) + 2 * tok(A3848));
  assert.equal(tok(A4419) + 2 * tok(A3848) - stats.outputTokens, tok(A3848), 'sobraba exactamente una copia');
});

test('S1b los registros del texto repetido se reutilizan, no se recrean', () => {
  const ledger = new DomTokenTotals();
  for (const lectura of [R1, R2, R3]) ledger.observe(snapshot(lectura));
  const antes = [...ledger.project('p').records.entries()]
    .map(([clave, record]) => ({ clave, chars: record.text.length }));

  ledger.observe(snapshot(R4));   // los ids se desplazan
  assert.equal(ledger.records('p'), 5, 'la lectura corta no crea ni borra registros');

  const despues = [...ledger.project('p').records.entries()]
    .map(([clave, record]) => ({ clave, chars: record.text.length }));
  assert.deepEqual(despues.map((r) => r.chars).sort(), antes.map((r) => r.chars).sort(),
    'las mismas longitudes: los registros se conservaron');
});

test('S2 el mismo texto con dos ids distintos en la misma lectura son dos registros', () => {
  const ledger = new DomTokenTotals();
  ledger.observe(snapshot([turn('x1', 'user', U106), turn('x2', 'user', U106)]));
  const stats = activa(ledger);
  assert.equal(ledger.records('p'), 2, 'dos mensajes distintos con el mismo texto');
  assert.equal(stats.inputTokens, 2 * tok(U106));
  assert.equal(stats.userMessages, 2);
});

test('S2b la misma huella no se toma dos veces: si P1 ya la reclamó, el otro turno es nuevo', () => {
  // El sitio repite el mensaje y además mueve los ids: un turno coincide exacto
  // con la clave que ya existía (P1 lo reclama) y otro, con el MISMO texto,
  // llega con id nuevo. No puede adoptar una clave ya reclamada: es otro
  // mensaje y suma aparte. Es lo que distingue «reubicado» de «repetido».
  const ledger = new DomTokenTotals();
  ledger.observe(snapshot([turn('visible-2', 'user', U106)]));
  ledger.observe(snapshot([turn('visible-2', 'user', U106), turn('visible-9', 'user', U106)]));

  assert.equal(ledger.records('p'), 2, 'dos registros: el reclamado y el nuevo');
  const stats = activa(ledger);
  assert.equal(stats.inputTokens, 2 * tok(U106), 'el mensaje repetido cuenta dos veces, no una');
  assert.equal(stats.userMessages, 2);
});

test('S3 una lectura repetida idéntica no cambia nada', () => {
  const ledger = new DomTokenTotals();
  assert.equal(ledger.observe(snapshot(R3)), true, 'la primera lectura sí cambia');
  const antes = JSON.stringify([...ledger.project('p').records]);
  assert.equal(ledger.observe(snapshot(R3)), false, 'observe devuelve false');
  assert.equal(JSON.stringify([...ledger.project('p').records]), antes, 'los registros no se tocan');
  assert.equal(activa(ledger).outputTokens, tok(A4419) + tok(A3848));
});

test('S4 streaming: el mismo id con texto que crece deja el valor final', () => {
  const ledger = new DomTokenTotals();
  const creciendo = ['e'.repeat(200), 'e'.repeat(900), A3848];
  for (const texto of creciendo) ledger.observe(snapshot([turn('visible-3', 'assistant', texto)]));
  assert.equal(ledger.records('p'), 1, 'un solo registro');
  assert.equal(activa(ledger).outputTokens, tok(A3848), 'el valor final, no la suma de parciales');
  assert.equal(activa(ledger).assistantMessages, 1);
});

test('S5 regenerar: mismo id, texto distinto que no es prefijo → queda el nuevo', () => {
  const ledger = new DomTokenTotals();
  ledger.observe(snapshot([turn('visible-3', 'assistant', A4419)]));
  ledger.observe(snapshot([turn('visible-3', 'assistant', A3848)]));
  assert.equal(ledger.records('p'), 1, 'no se añade un registro huérfano');
  assert.equal(activa(ledger).outputTokens, tok(A3848), 'cuenta el texto nuevo');
});

test('S6 dos mensajes insertados por delante (los ids suben 2): ni duplica ni pierde', () => {
  const ledger = new DomTokenTotals();
  // L1: los dos primeros mensajes, en las posiciones 2 y 3.
  ledger.observe(snapshot([turn('visible-2', 'user', U58), turn('visible-3', 'assistant', A4419)]));
  // L2: se insertan dos por delante; los viejos pasan a 4 y 5 y conservan su texto.
  ledger.observe(snapshot([
    turn('visible-0', 'user', U127),
    turn('visible-1', 'user', U106),
    turn('visible-4', 'user', U58),
    turn('visible-5', 'assistant', A4419),
  ]));

  const stats = activa(ledger);
  assert.equal(ledger.records('p'), 4, 'dos viejos reutilizados + dos nuevos');
  assert.equal(stats.inputTokens, tok(U58) + tok(U127) + tok(U106));
  assert.equal(stats.outputTokens, tok(A4419), 'la respuesta no se duplica');
  assert.equal(stats.userMessages, 3);
  assert.equal(stats.assistantMessages, 1);
});

test('S6b colisión: la clave directa ya la reclamó otro turno → clave propia, no se pisa', () => {
  // Un mensaje cambia de texto en su misma clave y, a la vez, su texto viejo
  // reaparece bajo otra id: P2 se lleva la clave `visible-2` para el texto viejo
  // y el texto nuevo necesita otra clave. Sin la clave de colisión, el nuevo se
  // descartaría y se perdería un mensaje.
  const ledger = new DomTokenTotals();
  ledger.observe(snapshot([turn('visible-2', 'user', U106)]));
  ledger.observe(snapshot([turn('visible-2', 'user', U127), turn('visible-7', 'user', U106)]));

  assert.equal(ledger.records('p'), 2, 'el texto viejo y el nuevo conviven');
  const longitudes = [...ledger.project('p').records.values()].map((r) => r.text.length).sort((a, b) => a - b);
  assert.deepEqual(longitudes, [U106.length, U127.length], 'uno de cada, sin perder ninguno');
  const stats = activa(ledger);
  assert.equal(stats.inputTokens, tok(U106) + tok(U127));
  assert.equal(stats.userMessages, 2);
  // La clave de colisión es determinista y visible: `visible-2` y `visible-2~1`.
  const ids = [...ledger.project('p').records.keys()].map((clave) => clave.split('\u0000')[2]).sort();
  assert.deepEqual(ids, ['visible-2', 'visible-2~1']);
});

test('S7 mensaje nuevo al final después de que los ids bajaron 4: resultado real', () => {
  // Límite conocido, documentado a propósito: el turno nuevo recibe un id que
  // una lectura anterior usó para OTRO texto. La huella no coincide (texto
  // distinto), así que la clave directa está ocupada por un registro distinto y
  // el turno cae en la clave de colisión `…~1`. Resultado: se conserva el
  // registro viejo y el nuevo suma aparte, sin pisarlo.
  const ledger = new DomTokenTotals();
  ledger.observe(snapshot([turn('visible-6', 'user', U106), turn('visible-7', 'assistant', A3848)]));
  ledger.observe(snapshot([turn('visible-2', 'user', U106), turn('visible-3', 'assistant', A3848)]));
  const trasBajar = activa(ledger);
  assert.equal(ledger.records('p'), 2, 'los dos registros reutilizados');

  ledger.observe(snapshot([
    turn('visible-2', 'user', U106),
    turn('visible-3', 'assistant', A3848),
    turn('visible-4', 'user', U127),
  ]));
  const stats = activa(ledger);
  assert.equal(ledger.records('p'), 3, 'el mensaje nuevo suma uno, no pisa el viejo');
  assert.equal(stats.outputTokens, trasBajar.outputTokens, 'la respuesta no se pierde');
  assert.equal(stats.inputTokens, tok(U106) + tok(U127), 'entrada: el repetido una vez + el nuevo');
  assert.equal(stats.userMessages, 2, 'el viejo de la clave reutilizada no se duplica');
});

test('S8 dos conversaciones distintas con el mismo texto no se cruzan', () => {
  const ledger = new DomTokenTotals();
  // Pestañas distintas: la segunda no hereda la conversación de la primera.
  ledger.observe({ projectId: 'p', webContentsId: 7, href: 'https://chatgpt.com/c/una', turns: [turn('visible-0', 'user', U106)], source: 'isolated' });
  const una = activa(ledger);
  ledger.observe({ projectId: 'p', webContentsId: 8, href: 'https://chatgpt.com/c/otra', turns: [turn('visible-0', 'user', U106)], source: 'isolated' });

  const otra = activa(ledger);
  assert.equal(ledger.records('p'), 2, 'una clave por conversación');
  assert.equal(una.inputTokens, tok(U106));
  assert.equal(otra.inputTokens, tok(U106), 'la segunda cuenta su propio mensaje, no reutiliza el de la primera');
  assert.equal(otra.userMessages, 1);
});
