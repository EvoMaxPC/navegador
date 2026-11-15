/**
 * `diag-dom-nodos` tiene que poder distinguir «el contenedor no tiene caja» de
 * «hay un camino que no pasa por el filtro».
 *
 * El aviso existente decía cuántos `h4` hay y cuántos nodos con etiqueta. Faltaba
 * el dato del contenedor: `mainConCaja` (`src/core/chatgptAdapter.js`) decide si
 * el filtro del lector se aplica o no, así que un nodo con `rects 0` que aparece
 * en los contadores no se puede atribuir ni a un `main` sin caja (fail-open
 * esperado) ni a una lectura que se saltó la selección.
 *
 * Este archivo ejecuta el script real que el proceso principal manda a la página
 * (`DIAG_DOM_NODOS_SCRIPT`, publicado por `noteDiagDomNodos` en `src/main/main.js`)
 * sobre un documento falso mínimo, y comprueba que el encabezado publica la
 * cantidad de `main`, los rects del primero y su `display`; y que ese `main` es
 * el mismo que decide el filtro del lector.
 *
 * Sólo números, booleanos y un `display` acotado: nada de texto del chat.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

import { selectChatGptMessages } from '../src/core/chatgptAdapter.js';

process.env.NEXO_DIAG = '1';
register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
await settle();

const shell = journal.windows[0].webContents;
shell.url = 'nexo://app/src/ui/shell/index.html';
const shellEvent = { sender: shell, senderFrame: shell.mainFrame };
const invoke = (channel, event, payload) => journal.ipcHandlers.get(channel)(event, payload);
const asSender = (contents) => ({ sender: contents, senderFrame: contents.mainFrame });
const avisos = async () => (await invoke('nexo:log', shellEvent))
  .filter((entry) => entry.code === 'diag-dom-nodos');

/**
 * Documento falso suficiente para el script: uno o varios `main` (cada uno con
 * sus rects), el `display` que devolvería `getComputedStyle`, y los `h4` con su
 * hermano medido o no.
 */
function documentoFalso({ mains = [{ rects: 1, display: 'block' }], rectsNodos = [1, 0] } = {}) {
  const nodoDe = (chars, rects) => {
    const texto = 'x'.repeat(chars);
    return {
      innerText: texto, textContent: texto,
      getAttribute: () => null, hasAttribute: () => false,
      getClientRects: () => new Array(rects).fill({ width: 1, height: 1 }),
      checkVisibility: () => rects > 0,
    };
  };
  const nodos = rectsNodos.map((rects, i) => nodoDe(i === 0 ? 12 : 240, rects));
  const headers = [
    { textContent: 'Dijiste:Tú', nextElementSibling: nodos[0] },
    { textContent: 'ChatGPT dijo:ChatGPT', nextElementSibling: nodos[1] },
  ];
  const elementos = mains.map(({ rects }) => ({
    getClientRects: () => new Array(rects).fill({ width: 800, height: 600 }),
  }));
  return {
    headers, nodos, elementos,
    doc: {
      querySelectorAll: (selector) => (selector === 'main h4' ? headers : selector === 'main' ? elementos : []),
      querySelector: (selector) => (selector === 'main' ? (elementos[0] || null) : null),
      getComputedStyle: () => ({ display: mains[0]?.display ?? 'block' }),
    },
  };
}

/** Una pestaña del arnés cuyo `executeJavaScript` evalúa el script real. */
function pestanaConDocumento(documento) {
  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/7c16l-layout');
  view.navigateTo('https://chatgpt.com/c/7c16l-layout', 'ChatGPT');
  view.llamadas = [];
  view.executeJavaScript = (script) => {
    view.llamadas.push(String(script));
    // El script se evalúa con el documento falso como `document`.
    const evaluar = new Function('document', 'getComputedStyle', `return ${String(script)};`);
    return Promise.resolve(evaluar(documento.doc, documento.doc.getComputedStyle));
  };
  return view;
}

async function avisoDe(documento) {
  const view = pestanaConDocumento(documento);
  const antes = (await avisos()).length;
  await invoke('nexo:repetition:snapshot', asSender(view), {
    href: view.url,
    turns: [{ id: 'u1', role: 'user', content: 'hola' }],
  });
  await settle();
  const todos = await avisos();
  return todos.slice(0, todos.length - antes).find((entry) => entry.meta?.disponible === true);
}

test('el encabezado publica main, sus rects y su display', async () => {
  const aviso = await avisoDe(documentoFalso({ mains: [{ rects: 1, display: 'block' }] }));
  assert.ok(aviso, 'se publica el recuento');
  assert.equal(aviso.meta.mains, 1);
  assert.equal(aviso.meta.rectsMain, 1);
  assert.equal(aviso.meta.displayMain, 'block');
  assert.match(aviso.detail, /^main h4 2 · con etiqueta 2 · main 1 · main rects 1 · display block · mains con caja 1$/m);
});

test('un main sin caja se informa como main rects 0 con su display', async () => {
  const aviso = await avisoDe(documentoFalso({ mains: [{ rects: 0, display: 'contents' }] }));
  assert.ok(aviso, 'se publica el recuento');
  assert.equal(aviso.meta.mains, 1);
  assert.equal(aviso.meta.rectsMain, 0);
  assert.equal(aviso.meta.displayMain, 'contents');
  assert.match(aviso.detail, /^main h4 2 · con etiqueta 2 · main 1 · main rects 0 · display contents · mains con caja 0$/m);
});

test('con varios main informa cuántos hay y mide el primero', async () => {
  const aviso = await avisoDe(documentoFalso({
    mains: [{ rects: 0, display: 'contents' }, { rects: 2, display: 'block' }],
  }));
  assert.ok(aviso, 'se publica el recuento');
  assert.equal(aviso.meta.mains, 2, 'se cuentan todos');
  assert.equal(aviso.meta.rectsMain, 0, 'se miden los del primero, el que mide el lector');
  assert.match(aviso.detail, /^main h4 2 · con etiqueta 2 · main 2 · main rects 0 · display contents · mains con caja 1$/m);
});

test('sin main en el documento se informa main 0, rects 0 y display n.d.', async () => {
  const aviso = await avisoDe(documentoFalso({ mains: [] }));
  assert.ok(aviso, 'se publica el recuento aunque no haya main');
  assert.equal(aviso.meta.mains, 0);
  assert.equal(aviso.meta.rectsMain, 0);
  assert.equal(aviso.meta.displayMain, 'n.d.');
  assert.match(aviso.detail, /^main h4 2 · con etiqueta 2 · main 0 · main rects 0 · display n\.d\. · mains con caja 0$/m);
});

test('el main que informa el aviso es el que decide el filtro del lector', async () => {
  // Con main con caja, el lector descarta los nodos sin caja.
  const conCaja = documentoFalso({ mains: [{ rects: 1, display: 'block' }], rectsNodos: [0, 0] });
  const avisoConCaja = await avisoDe(conCaja);
  assert.equal(avisoConCaja.meta.rectsMain, 1);
  assert.equal(selectChatGptMessages(conCaja.doc).messages.length, 0, 'con caja, ninguno sobrevive');

  // Sin main con caja, el lector no filtra (fail-open) y el aviso lo explica.
  const sinCaja = documentoFalso({ mains: [{ rects: 0, display: 'contents' }], rectsNodos: [0, 0] });
  const avisoSinCaja = await avisoDe(sinCaja);
  assert.equal(avisoSinCaja.meta.rectsMain, 0);
  assert.equal(selectChatGptMessages(sinCaja.doc).messages.length, 2, 'sin caja, sobreviven los dos');
});
