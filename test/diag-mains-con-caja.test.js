/**
 * `diag-dom-nodos` tiene que decir cuántos `main` autorizan el filtro.
 *
 * El aviso de 7c-16l informaba `main M · main rects R · display D` del **primer**
 * `main`, y en la PC (chat nuevo, `f838fbe`) eso daba `main 2 · main rects 0 ·
 * display flex`: el dato no permitía saber si el segundo `main` tenía caja. Como
 * el lector ahora se activa si **alguno** la tiene, el aviso publica además
 * `mains con caja K`.
 *
 * Ejecuta el script real que `main.js` manda a la página sobre un documento falso
 * que declara `querySelector` y `querySelectorAll` para `main` y `main h4`, y
 * comprueba K con la forma medida (dos `main`, uno con caja) y con ninguno.
 *
 * Sólo números, booleanos y `display`: nada de texto del chat.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

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
 * Documento con dos `main` como el medido: `mains` es la lista de rects de cada
 * uno (`0` = sin caja). El primero, sin caja, lleva los dos nodos con rects 0.
 */
function documentoFalso({ mains = [0, 1], display = 'flex' } = {}) {
  const nodoDe = (chars, rects) => {
    const texto = 'x'.repeat(chars);
    return {
      innerText: texto, textContent: texto,
      getAttribute: () => null, hasAttribute: () => false,
      getClientRects: () => new Array(rects).fill({ width: 1, height: 1 }),
      checkVisibility: () => rects > 0,
    };
  };
  const headers = [
    { textContent: 'Dijiste:Tú', nextElementSibling: nodoDe(9987, 0) },
    { textContent: 'ChatGPT dijo:ChatGPT', nextElementSibling: nodoDe(313, 0) },
  ];
  const elementos = mains.map((rects) => ({
    getClientRects: () => new Array(rects).fill({ width: 800, height: 600 }),
  }));
  return {
    headers, elementos,
    doc: {
      // Los dos métodos, como en el DOM real.
      querySelectorAll: (selector) => (selector === 'main h4' ? headers : selector === 'main' ? elementos : []),
      querySelector: (selector) => (selector === 'main' ? (elementos[0] || null) : null),
      getComputedStyle: () => ({ display }),
    },
  };
}

function pestanaConDocumento(documento) {
  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/7c16m-mains');
  view.navigateTo('https://chatgpt.com/c/7c16m-mains', 'ChatGPT');
  view.executeJavaScript = (script) => {
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

test('T5 con dos main y sólo el segundo con caja, el encabezado informa mains con caja 1', async () => {
  const aviso = await avisoDe(documentoFalso({ mains: [0, 1], display: 'flex' }));
  assert.ok(aviso, 'se publica el recuento');
  assert.equal(aviso.meta.mains, 2, 'se cuentan los dos main');
  assert.equal(aviso.meta.rectsMain, 0, 'el primero sigue informándose aparte');
  assert.equal(aviso.meta.mainsConCaja, 1, 'sólo uno tiene caja');
  assert.match(aviso.detail,
    /^main h4 2 · con etiqueta 2 · main 2 · main rects 0 · display flex · mains con caja 1$/m);
});

test('T5b sin ningún main con caja, informa mains con caja 0', async () => {
  const aviso = await avisoDe(documentoFalso({ mains: [0, 0], display: 'flex' }));
  assert.ok(aviso, 'se publica el recuento');
  assert.equal(aviso.meta.mains, 2);
  assert.equal(aviso.meta.mainsConCaja, 0);
  assert.match(aviso.detail,
    /^main h4 2 · con etiqueta 2 · main 2 · main rects 0 · display flex · mains con caja 0$/m);
});

test('T5c el campo va al final del encabezado y no toca el resto del detalle', async () => {
  const aviso = await avisoDe(documentoFalso({ mains: [0, 1] }));
  assert.ok(aviso);
  const [encabezado, ...filas] = aviso.detail.split('\n');
  assert.ok(encabezado.endsWith('mains con caja 1'), 'el campo nuevo cierra el encabezado');
  assert.equal(filas.length, 2, 'una fila por nodo, sin cambios');
  assert.match(filas[0], /^0 user 9987c vis no oculto no rects 0$/);
  assert.match(filas[1], /^1 assistant 313c vis no oculto no rects 0$/);
});
