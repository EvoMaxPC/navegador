/**
 * Dos `main` en el DOM: el primero sin caja, el segundo con caja.
 *
 * Medido en la PC (Electron real, `f838fbe`): tras «Nuevo chat» desde un chat
 * antiguo, `diag-dom-nodos` informó «main h4 3 · con etiqueta 2 · main 2 · main
 * rects 0 · display flex» y el snapshot siguiente publicó nodos ocultos. Con el
 * chat cargado informó «main 1 · main rects 1».
 *
 * Lectura de entonces: `mainConCaja` miraba sólo `query(document,'main')`, o sea
 * el primero, y con el primero sin caja apagaba el filtro. Ahora el filtro se
 * activa si **algún** `main` tiene caja; sin ninguno con caja sigue fail-open.
 *
 * Lo que este archivo fija, con documentos falsos que declaran `querySelector` y
 * `querySelectorAll` para `main` y para `main h4` (los dos, como el DOM real):
 *
 *   T1 forma medida (primero sin caja, segundo con caja) → sólo lo visible, con
 *      su id por posición original;
 *   T2 ningún `main` con caja → fail-open, se publican todos;
 *   T3 el primero con caja y el segundo sin caja → filtra como antes;
 *   T4 un `main` que lanza al medirse → fail-open.
 *
 * No se afirma nada sobre el layout real: esto es un documento falso.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectChatGptMessages, chatGptMessageId } from '../src/core/chatgptAdapter.js';
import { readChatGptConversation } from '../src/core/chatgptConversation.js';

/** Nodo medido: `rects` rectángulos. `lanzar` = no sabe medirse. */
function nodo(texto, rects, { lanzar = false } = {}) {
  const base = { innerText: texto, textContent: texto, querySelector: () => null, getAttribute: () => null };
  if (lanzar) {
    return { ...base, getClientRects: () => { throw new Error('sin layout disponible'); } };
  }
  return { ...base, getClientRects: () => new Array(rects).fill({ width: 1, height: 1 }) };
}

/** Un `main` con su propia caja: 1 = con caja, 0 = sin caja, `lanzar` = lanza. */
function main({ rects = 1, lanzar = false } = {}) {
  return {
    getClientRects: lanzar
      ? () => { throw new Error('sin layout disponible'); }
      : () => new Array(rects).fill({ width: 800, height: 600 }),
  };
}

/**
 * Documento con la forma medida: dos `main`. El primero contiene un `user` y un
 * `assistant` ambos con 0 rects; el segundo contiene el mensaje visible. Sólo se
 * usan los `h4` para que el lector encuentre los nodos, como `main h4`.
 */
function documentoDosMain({ firstMains = [main({ rects: 0 })], segundo = main({ rects: 1 }) } = {}) {
  const oculto = nodo('x'.repeat(9987), 0);
  const assistantOculto = nodo('', 0);
  const visible = nodo('la respuesta visible', 1);
  const headers = [
    { textContent: 'Dijiste:Tú', nextElementSibling: oculto },
    { textContent: 'ChatGPT dijo:ChatGPT', nextElementSibling: assistantOculto },
    { textContent: 'ChatGPT dijo:ChatGPT', nextElementSibling: visible },
  ];
  const mains = [...firstMains, segundo];
  return {
    headers, oculto, assistantOculto, visible, mains,
    doc: {
      // Los dos métodos, como en el DOM real: uno para el lector, otro para el filtro.
      querySelectorAll: (selector) => (selector === 'main h4' ? headers : selector === 'main' ? mains : []),
      querySelector: (selector) => (selector === 'main' ? (mains[0] || null) : null),
    },
  };
}

test('T1 forma medida (2 main, el segundo con caja): sólo se publica el visible, con id por posición original', () => {
  const { doc, visible } = documentoDosMain();
  const seleccion = selectChatGptMessages(doc);
  assert.equal(seleccion.messages.length, 1, 'sólo sobrevive el nodo con caja');
  assert.equal(seleccion.messages[0].node, visible);
  // Posición en la lista completa: oculto=0, assistant=1, visible=2.
  assert.equal(chatGptMessageId(visible, 0), 'visible-2', 'el id no se renumera al filtrar');

  const turnos = readChatGptConversation(doc, { selection: seleccion });
  assert.deepEqual(turnos.map((t) => t.id), ['visible-2']);
  assert.equal(turnos[0].content, 'la respuesta visible');
});

test('T2 ningún main con caja: fail-open, se publican todos', () => {
  const { doc } = documentoDosMain({ firstMains: [main({ rects: 0 })], segundo: main({ rects: 0 }) });
  const seleccion = selectChatGptMessages(doc);
  assert.equal(seleccion.messages.length, 3, 'sin ningún main con caja no se descarta nada');
  const turnos = readChatGptConversation(doc, { selection: seleccion });
  // El assistant vacío no arma turno, pero sigue en la selección.
  assert.deepEqual(turnos.map((t) => t.id), ['visible-0', 'visible-2']);
});

test('T3 primer main con caja y segundo sin caja: filtra como antes', () => {
  const { doc, visible } = documentoDosMain({ firstMains: [main({ rects: 1 })], segundo: main({ rects: 0 }) });
  const seleccion = selectChatGptMessages(doc);
  assert.equal(seleccion.messages.length, 1, 'el primero con caja ya activa el filtro');
  assert.equal(seleccion.messages[0].node, visible);
  assert.deepEqual(readChatGptConversation(doc, { selection: seleccion }).map((t) => t.id), ['visible-2']);
});

test('T4 un main que lanza al medirse: fail-open', () => {
  const { doc } = documentoDosMain({ firstMains: [main({ rects: 0 }), main({ lanzar: true })], segundo: main({ rects: 0 }) });
  const seleccion = selectChatGptMessages(doc);
  assert.equal(seleccion.messages.length, 3, 'si la medición lanza, no se filtra nada');
  assert.deepEqual(readChatGptConversation(doc, { selection: seleccion }).map((t) => t.id), ['visible-0', 'visible-2']);
});

test('T4b un main sin getClientRects antes que el que tiene caja: fail-open (límite conocido)', () => {
  // `.some` recorre en orden: si el primero no sabe medirse, lanza y el `catch`
  // del helper devuelve `false`. Es fail-open, nunca filtro indebido, y queda
  // fijado aquí para que un cambio futuro no lo altere en silencio.
  const sinMetodo = { querySelectorAll: () => [] };  // sin getClientRects
  const conCaja = main({ rects: 1 });
  const sinCaja = main({ rects: 0 });
  const oculto = nodo('x'.repeat(9987), 0);
  const visible = nodo('la respuesta visible', 1);
  const headers = [
    { textContent: 'Dijiste:Tú', nextElementSibling: oculto },
    { textContent: 'ChatGPT dijo:ChatGPT', nextElementSibling: visible },
  ];
  const con = (mains) => ({
    querySelectorAll: (selector) => (selector === 'main h4' ? headers : selector === 'main' ? mains : []),
    querySelector: (selector) => (selector === 'main' ? (mains[0] || null) : null),
  });

  // El que no sabe medirse va PRIMERO: lanza y se cae a fail-open.
  assert.equal(selectChatGptMessages(con([sinMetodo, conCaja])).messages.length, 2);
  // El que no sabe medirse va DESPUÉS de uno con caja: `.some` corta antes.
  assert.equal(selectChatGptMessages(con([conCaja, sinMetodo])).messages.length, 1);
  // Dos medibles, el segundo con caja: filtra (el caso de la etapa).
  assert.equal(selectChatGptMessages(con([sinCaja, conCaja])).messages.length, 1);
});
