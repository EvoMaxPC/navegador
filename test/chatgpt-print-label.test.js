/**
 * Etiquetas visibles del DOM real de chatgpt.com.
 *
 * Medido en Firefox sobre una conversación de 2 mensajes: el `textContent.trim()`
 * de cada `h4` es «Dijiste:Tú» y «ChatGPT dijo:ChatGPT», no «Dijiste:» a secas,
 * y hay un quinto `h4` («Respuesta más reciente») que no es un mensaje.
 *
 * Estos tests fallan si se revierte el reconocimiento por prefijo: la igualdad
 * exacta sola deja `strategy: 'none'` y cero turnos con ese DOM.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectChatGptMessages } from '../src/core/chatgptAdapter.js';
import { readChatGptConversation } from '../src/core/chatgptConversation.js';

/** Encabezado armado como en el DOM medido: <h4><span>Etiqueta</span><span>Quién</span></h4>. */
function h4(etiqueta, quien, { srOnly = false, hermano } = {}) {
  const nodo = {
    textContent: `${etiqueta}${quien}`,
    nextElementSibling: hermano ?? { innerText: '', querySelector: () => null },
  };
  if (srOnly) nodo.attrs = { class: 'sr-only' };
  return nodo;
}

/** Documento falso con los encabezados y los contenidos ya emparejados. */
function documentoDe(pares) {
  const headers = pares.map(([texto, contenido]) => ({
    textContent: texto,
    nextElementSibling: { innerText: contenido, querySelector: () => null },
  }));
  return { querySelectorAll: (selector) => (selector === 'main h4' ? headers : []) };
}

// Largos medidos en el PC: usuario 13 y 19; respuesta 135 y 358. Se afirman
// abajo para que un cambio de texto no deje el test midiendo otra cosa.
const USUARIO = 'hola, ¿qué tal'.slice(0, 13);
const RESPUESTA = 'x'.repeat(135);
const USUARIO2 = 'segunda pregunta...'.padEnd(19, '.');
const RESPUESTA2 = 'y'.repeat(358);
assert.deepEqual([USUARIO.length, USUARIO2.length, RESPUESTA.length, RESPUESTA2.length], [13, 19, 135, 358]);

test('etiqueta con el nombre pegado: «Dijiste:Tú» reconoce user', () => {
  assert.equal(h4('Dijiste:', 'Tú').textContent, 'Dijiste:Tú');
  const documento = documentoDe([['Dijiste:Tú', USUARIO]]);
  const seleccion = selectChatGptMessages(documento);
  assert.equal(seleccion.strategy, 'print-label');
  assert.deepEqual(seleccion.messages.map((m) => m.role), ['user']);
  assert.deepEqual(readChatGptConversation(documento).map((t) => [t.role, t.content]), [['user', USUARIO]]);
});

test('variante sr-only: el texto oculto también suma al textContent y se reconoce', () => {
  const documento = documentoDe([['Dijiste:Tú', USUARIO]]);
  assert.ok(h4('Dijiste:', 'Tú', { srOnly: true }));
  const turnos = readChatGptConversation(documento);
  assert.deepEqual(turnos.map((t) => [t.role, t.content]), [['user', USUARIO]]);
});

test('etiqueta del asistente con el nombre pegado: «ChatGPT dijo:ChatGPT» reconoce assistant', () => {
  const documento = documentoDe([['ChatGPT dijo:ChatGPT', RESPUESTA]]);
  const seleccion = selectChatGptMessages(documento);
  assert.deepEqual(seleccion.messages.map((m) => m.role), ['assistant']);
  assert.deepEqual(readChatGptConversation(documento).map((t) => [t.role, t.content.length]), [['assistant', 135]]);
});

test('las cuatro claves admiten su nombre pegado, y ninguna otra', () => {
  const casos = [
    ['Dijiste:Tú', 'user'],
    ['ChatGPT dijo:ChatGPT', 'assistant'],
    ['You said:You', 'user'],
    ['ChatGPT said:ChatGPT', 'assistant'],
  ];
  for (const [texto, rol] of casos) {
    assert.deepEqual(selectChatGptMessages(documentoDe([[texto, 'contenido']])).messages.map((m) => m.role), [rol], texto);
  }
});

test('«Respuesta más reciente» se sigue ignorando', () => {
  const documento = documentoDe([
    ['Dijiste:Tú', USUARIO],
    ['ChatGPT dijo:ChatGPT', RESPUESTA],
    ['Respuesta más reciente', 'no es un mensaje'],
  ]);
  const seleccion = selectChatGptMessages(documento);
  assert.deepEqual(seleccion.messages.map((m) => m.role), ['user', 'assistant']);
  assert.deepEqual(readChatGptConversation(documento).map((t) => t.content),
    [USUARIO, RESPUESTA], 'el h4 final no aporta turno');
});

test('la etiqueta exacta se comporta igual que antes', () => {
  const documento = documentoDe([['Dijiste:', USUARIO], ['ChatGPT dijo:', RESPUESTA]]);
  const seleccion = selectChatGptMessages(documento);
  assert.equal(seleccion.strategy, 'print-label');
  assert.deepEqual(readChatGptConversation(documento).map((t) => [t.role, t.content.length]),
    [['user', USUARIO.length], ['assistant', 135]]);
});

test('la clave en medio de la etiqueta no se reconoce: tiene que ser prefijo', () => {
  const documento = documentoDe([
    ['Nota — Dijiste: algo', USUARIO],
    ['Ver ChatGPT dijo: arriba', RESPUESTA],
  ]);
  const seleccion = selectChatGptMessages(documento);
  assert.equal(seleccion.strategy, 'none', 'ninguna de las dos empieza por la clave');
  assert.deepEqual(seleccion.messages, []);
  assert.deepEqual(readChatGptConversation(documento), []);
});

test('DOM medido de 5 h4: se leen 4 turnos con los largos reales', () => {
  const documento = documentoDe([
    ['Dijiste:Tú', USUARIO],
    ['ChatGPT dijo:ChatGPT', RESPUESTA],
    ['Dijiste:Tú', USUARIO2],
    ['ChatGPT dijo:ChatGPT', RESPUESTA2],
    ['Respuesta más reciente', ''],
  ]);
  assert.equal(documento.querySelectorAll('main h4').length, 5);
  const seleccion = selectChatGptMessages(documento);
  assert.equal(seleccion.strategy, 'print-label');
  assert.deepEqual(seleccion.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  const turnos = readChatGptConversation(documento);
  assert.deepEqual(turnos.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(turnos.map((t) => t.content.length), [13, 135, 19, 358]);  // largos medidos
});

test('si la etiqueta no coincide, no se inventa un rol por el contenido', () => {
  const documento = documentoDe([['Respuesta más reciente', RESPUESTA2], ['Algo distinto', USUARIO]]);
  assert.deepEqual(selectChatGptMessages(documento), { strategy: 'none', messages: [] });
});
