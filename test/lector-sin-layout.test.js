/**
 * Un nodo sin layout no es un mensaje.
 *
 * En la PC, en un chat nuevo, `diag-dom-nodos` midió 6 nodos y sólo uno tenía
 * `rects > 0`: los demás (`user` de ~10 010 chars y `assistant` vacíos) estaban
 * sin caja. El lector los contaba igual y el panel sumaba sus tokens.
 *
 * Regla: se descarta el nodo sin caja **sólo** cuando el contenedor del lector
 * (`main`, el mismo de `main h4`) tiene caja. Si `main` no la tiene (pestaña en
 * segundo plano), si el documento no trae `main` o si el nodo no sabe medirse,
 * no se filtra nada: fail-open, como antes de esta etapa.
 *
 * El identificador de reserva sigue siendo la posición en la conversación: los
 * nodos que sobreviven conservan su `visible-N` aunque caigan nodos anteriores.
 *
 * Documentos falsos con `querySelector('main')` y nodos con `getClientRects`;
 * texto sintético, ningún dato real.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectChatGptMessages, chatGptMessageId } from '../src/core/chatgptAdapter.js';
import { readChatGptConversation, watchChatGptConversation } from '../src/core/chatgptConversation.js';

const HREF = 'https://chatgpt.com/c/7c16k-lector';

/** Nodo de contenido: `rects` nulo = no sabe medirse (sin `getClientRects`). */
function nodo(texto, rects) {
  const base = { innerText: texto, textContent: texto, querySelector: () => null, getAttribute: () => null };
  if (rects === null) return base;
  return { ...base, getClientRects: () => new Array(rects).fill({ width: 1, height: 1 }) };
}

/** `main` con caja (1 rect) o sin ella (0 rects), o inexistente. `rects` es mutable. */
function main(rects) {
  if (rects === null) return undefined;
  const estado = { rects };
  return {
    estado,
    getClientRects: () => new Array(estado.rects).fill({ width: 800, height: 600 }),
    querySelectorAll: () => [],
  };
}

/** `main` sin `getClientRects`: no sabe medirse. */
function mainSinMedida() {
  return { querySelectorAll: () => [] };
}

/** `main` cuyo `getClientRects` lanza. */
function mainQueLanza() {
  return { getClientRects: () => { throw new Error('sin layout disponible'); }, querySelectorAll: () => [] };
}

/** Nodo cuyo `getClientRects` lanza: no se puede saber si tiene caja. */
function nodoQueLanza(texto) {
  return {
    innerText: texto, textContent: texto, querySelector: () => null, getAttribute: () => null,
    getClientRects: () => { throw new Error('sin layout disponible'); },
  };
}

/**
 * Igual que `documento()`, pero `main` se sustituye por el que se pase, y los
 * nodos pueden venir medidos, sin `getClientRects` o lanzando.
 */
function documentoConMain(elementoMain, rectsNodos = [0, 0, 0, 0, 0]) {
  const base = documento({ rectsNodos });
  const nodos = [base.u1, base.a1, base.u2, base.a2, base.u3];
  const headers = base.headers.map((header, i) => ({ ...header, nextElementSibling: nodos[i] }));
  return {
    ...base,
    headers,
    doc: {
      querySelectorAll: (selector) => (selector === 'main h4' ? headers
        : selector === 'main' ? (elementoMain ? [elementoMain] : []) : []),
      querySelector: (selector) => (selector === 'main' ? elementoMain : null),
    },
  };
}

/**
 * Documento con 3 `user` (u1 sin caja, u2 con caja, u3 sin caja) y 2
 * `assistant` vacíos. Devuelve también los nodos para poder mirarlos.
 */
function documento({ rectsMain = 1, rectsNodos = [0, 0, 1, 0, 0] } = {}) {
  const TEXTO = 'x'.repeat(10010);
  const u1 = nodo(TEXTO, rectsNodos[0]);
  const a1 = nodo('', rectsNodos[1]);
  const u2 = nodo('pregunta corta', rectsNodos[2]);
  const a2 = nodo('', rectsNodos[3]);
  const u3 = nodo(TEXTO, rectsNodos[4]);
  const headers = [
    { textContent: 'Dijiste:Tú', nextElementSibling: u1 },
    { textContent: 'ChatGPT dijo:ChatGPT', nextElementSibling: a1 },
    { textContent: 'Dijiste:Tú', nextElementSibling: u2 },
    { textContent: 'ChatGPT dijo:ChatGPT', nextElementSibling: a2 },
    { textContent: 'Dijiste:Tú', nextElementSibling: u3 },
  ];
  const elementoMain = main(rectsMain);
  // `rectsMain` del mismo documento se puede cambiar después (`elementoMain.estado.rects`).
  const doc = {
    querySelectorAll: (selector) => (selector === 'main h4' ? headers
      : selector === 'main' ? (elementoMain ? [elementoMain] : []) : []),
    querySelector: (selector) => (selector === 'main' ? elementoMain : null),
  };
  return { doc, headers, u1, u2, u3, a1, a2, TEXTO, elementoMain };
}

test('1) 2 ocultos + 1 visible, main con caja: un solo turno de usuario', () => {
  const { doc } = documento({ rectsMain: 1 });
  const turnos = readChatGptConversation(doc);
  assert.equal(turnos.length, 1, `se esperaba 1 turno, llegaron ${turnos.length}`);
  assert.equal(turnos[0].role, 'user');
  assert.equal(turnos[0].content, 'pregunta corta');
});

test('2) main sin caja (pestaña en segundo plano): se cuentan los 3 (fail-open)', () => {
  const { doc } = documento({ rectsMain: 0 });
  const turnos = readChatGptConversation(doc);
  assert.equal(turnos.length, 3, 'sin layout del contenedor no se descarta nada');
  assert.deepEqual(turnos.map((t) => t.role), ['user', 'user', 'user']);
});

test('2b) main sin getClientRects, nodos con rects 0: se cuentan los 3 (fail-open)', () => {
  const { doc } = documentoConMain(mainSinMedida());
  const turnos = readChatGptConversation(doc);
  assert.equal(turnos.length, 3, 'un contenedor que no sabe medirse no autoriza el filtro');
  assert.deepEqual(turnos.map((t) => t.role), ['user', 'user', 'user']);
});

test('2c) main cuyo getClientRects lanza: se cuentan los 3 (fail-open)', () => {
  const { doc } = documentoConMain(mainQueLanza());
  const turnos = readChatGptConversation(doc);
  assert.equal(turnos.length, 3, 'si el contenedor lanza al medirse, no se filtra nada');
  assert.equal(selectChatGptMessages(doc).messages.length, 5, 'la selección completa conserva los 5');
});

test('3) main con caja pero nodos sin getClientRects: se cuentan (fail-open)', () => {
  const { doc } = documento({ rectsMain: 1, rectsNodos: [null, null, null, null, null] });
  const turnos = readChatGptConversation(doc);
  assert.equal(turnos.length, 3, 'un nodo que no sabe medirse no se descarta');
});

test('3b) main con caja y nodos cuyo getClientRects lanza: se cuentan (fail-open)', () => {
  const elementoMain = main(1);
  const headers = [
    { textContent: 'Dijiste:Tú', nextElementSibling: nodoQueLanza('pregunta uno') },
    { textContent: 'ChatGPT dijo:ChatGPT', nextElementSibling: nodoQueLanza('') },
    { textContent: 'Dijiste:Tú', nextElementSibling: nodoQueLanza('pregunta dos') },
  ];
  const doc = {
    querySelectorAll: (selector) => (selector === 'main h4' ? headers
      : selector === 'main' ? (elementoMain ? [elementoMain] : []) : []),
    querySelector: (selector) => (selector === 'main' ? elementoMain : null),
  };
  const turnos = readChatGptConversation(doc);
  assert.equal(turnos.length, 2, 'un nodo que lanza al medirse no se descarta');
  assert.deepEqual(turnos.map((t) => t.content), ['pregunta uno', 'pregunta dos']);
  assert.equal(selectChatGptMessages(doc).messages.length, 3, 'la selección completa conserva los 3');
});

test('4) id estable: el visible conserva el id que tenía antes del filtro', () => {
  const { doc } = documento({ rectsMain: 1 });
  const seleccion = selectChatGptMessages(doc);
  assert.equal(seleccion.messages.length, 1, 'sólo sobrevive el que tiene caja');
  assert.equal(seleccion.messages[0].role, 'user');
  // Posición en la lista completa: u1=0, a1=1, u2=2 → `visible-2`, no `visible-0`.
  assert.equal(seleccion.messages[0].node.innerText, 'pregunta corta');
  assert.equal(chatGptMessageId(seleccion.messages[0].node, 0), 'visible-2');
  const turnos = readChatGptConversation(doc, { selection: seleccion });
  assert.deepEqual(turnos.map((t) => t.id), ['visible-2']);
});

test('4b) sin filtro, la lista completa conserva sus ids de siempre', () => {
  const { doc } = documento({ rectsMain: 0 });
  const seleccion = selectChatGptMessages(doc);
  assert.equal(seleccion.messages.length, 5, 'sin layout del contenedor no se descarta nada');
  assert.deepEqual(seleccion.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  // Los vacíos están en la lista (los descarta el armado de turnos, no el filtro).
  assert.deepEqual(seleccion.messages.map((m, i) => chatGptMessageId(m.node, i)),
    ['visible-0', 'visible-1', 'visible-2', 'visible-3', 'visible-4']);
  assert.deepEqual(readChatGptConversation(doc).map((t) => t.id), ['visible-0', 'visible-2', 'visible-4']);
});

test('5) todos ocultos con caja: ningún turno y el vigilante no publica', () => {
  const { doc } = documento({ rectsMain: 1, rectsNodos: [0, 0, 0, 0, 0] });
  assert.deepEqual(readChatGptConversation(doc), [], 'sin nodos con caja no hay lectura');

  /** Ejecuta el vigilante con un documento y devuelve cuántas veces publicó. */
  const publicaciones = (documentoVigilado) => {
    const vistas = { memoria: 0, repeticion: 0 };
    const ventana = {
      location: { href: HREF }, addEventListener() {}, removeEventListener() {},
      requestAnimationFrame: (fn) => { fn(0); return 1; }, cancelAnimationFrame() {},
      MutationObserver: class { observe() {} disconnect() {} },
    };
    const vigilante = watchChatGptConversation({
      document: { ...documentoVigilado, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
      window: ventana,
      publishLive: () => { vistas.repeticion += 1; return { ok: true }; },
      publish: () => { vistas.memoria += 1; return { ok: true }; },
    });
    vigilante.read({ force: true });
    vigilante.disconnect();
    return vistas;
  };

  const sinNodos = publicaciones({ querySelectorAll: () => [], querySelector: () => null });
  const todosOcultos = publicaciones(doc);
  // Con 0 turnos el guardado de memoria no publica nada, y el canal de repetición
  // publica un snapshot vacío: exactamente lo mismo que un documento sin `h4`.
  assert.equal(todosOcultos.memoria, 0, 'con 0 turnos no se publica lectura de memoria');
  assert.deepEqual(todosOcultos, sinNodos, 'mismo desenlace que un documento sin h4');
});

test('6) selectChatGptMessages: devuelve exactamente lo filtrado, con la misma estrategia', () => {
  const { doc, elementoMain, u2 } = documento({ rectsMain: 1 });
  const conCaja = selectChatGptMessages(doc);
  elementoMain.estado.rects = 0;                 // pestaña en segundo plano
  const completa = selectChatGptMessages(doc);
  elementoMain.estado.rects = 1;

  assert.equal(completa.messages.length, 5, 'la selección completa tiene los 5 nodos reconocidos');
  assert.equal(conCaja.messages.length, 1, 'con caja, sólo el que la tiene');
  assert.equal(conCaja.messages[0].node, u2, 'el que sobrevive es el nodo con caja');
  assert.equal(conCaja.strategy, completa.strategy, 'la estrategia no cambia por filtrar');
  assert.equal(conCaja.strategy, 'print-label');
});
