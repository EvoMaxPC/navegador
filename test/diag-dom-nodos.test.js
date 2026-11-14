/**
 * `diag-dom-nodos`: qué nodos ve el lector del lado de la página.
 *
 * Cuando el contador del DOM dice cero con mensajes en pantalla, la pregunta es
 * cuáles de esos nodos el lector reconoce y si están ocultos. El proceso
 * principal no tiene DOM: lo único honesto es preguntarle a la pestaña con
 * `executeJavaScript`, en modo lectura y devolviendo sólo números.
 *
 * El cuerpo corre en dos procesos (ver `diag-dom-nodos-off.test.js` y
 * `diag-dom-nodos-on.test.js`), porque `main.js` se importa una sola vez.
 *
 * El "sender de prueba" es una pestaña del arnés a la que se le añade
 * `executeJavaScript` —igual que hace `test/chatgpt-direct.test.js:17`— para
 * registrar las llamadas y devolver un resultado con la forma real. No se
 * inventa un DOM: se comprueba qué pide el proceso principal y qué publica.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

const DIAG = process.env.NEXO_DIAG === '1';

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
 * Pestaña del arnés con un `executeJavaScript` que registra la llamada.
 * `respuesta` puede ser un objeto (forma real) o una función que lance.
 */
async function pestanaConEjecutor(href, respuesta) {
  const view = journal.windows[0].attachWebview(href);
  view.navigateTo(href, 'ChatGPT');
  view.llamadas = [];
  view.executeJavaScript = (script, gesto) => {
    view.llamadas.push({ script: String(script), gesto });
    if (typeof respuesta === 'function') return respuesta();
    return Promise.resolve(respuesta);
  };
  await settle();
  return view;
}

const FORMA_REAL = {
  h4: 3,
  conEtiqueta: 2,
  nodos: [
    { indice: 0, rol: 'user', chars: 12, visible: true, oculto: false, rects: 3 },
    { indice: 1, rol: 'assistant', chars: 240, visible: false, oculto: true, rects: 0 },
    { indice: 2, rol: 'assistant', chars: 5, visible: null, oculto: false, rects: 1 },
  ],
};

const turns = [
  { id: 'u1', role: 'user', content: 'hola' },
  { id: 'a1', role: 'assistant', content: 'una respuesta' },
];

test('sin NEXO_DIAG=1 no se llama a la página ni se publica nada', async () => {
  const view = await pestanaConEjecutor('https://chatgpt.com/c/7c16f-c-off', FORMA_REAL);
  const antes = (await avisos()).length;

  await invoke('nexo:repetition:snapshot', asSender(view), { href: view.url, turns });
  await settle();

  assert.equal(view.llamadas.length, DIAG ? 1 : 0, DIAG ? 'con la variable sí se llama' : 'sin la variable no se llama a la página');
  assert.equal((await avisos()).length - antes, DIAG ? 1 : 0);
});

test('con NEXO_DIAG=1 se pide el recuento y se publica con números', async () => {
  const view = await pestanaConEjecutor('https://chatgpt.com/c/7c16f-c-on', FORMA_REAL);
  const antes = (await avisos()).length;

  await invoke('nexo:repetition:snapshot', asSender(view), { href: view.url, turns });
  await settle();

  if (!DIAG) {
    assert.equal(view.llamadas.length, 0, 'sin la variable no hay llamada');
    assert.equal((await avisos()).length - antes, 0, 'ni aviso');
    return;
  }

  assert.equal(view.llamadas.length, 1, 'una sola llamada para un snapshot');
  assert.equal(view.llamadas[0].gesto, true, 'sin gesto de usuario');
  // El script es de sólo lectura: no escribe, no navega, no toca el composer.
  const script = view.llamadas[0].script;
  for (const prohibido of ['innerHTML', 'appendChild', 'insertBefore', 'click(', 'scrollIntoView',
    'localStorage', 'sessionStorage', 'document.cookie', 'fetch(', 'XMLHttpRequest', 'location.href',
    'dispatchEvent', 'value =']) {
    assert.ok(!script.includes(prohibido), `el script no usa ${prohibido}`);
  }
  assert.ok(script.includes("querySelectorAll('main h4')"), 'replica la selección print-label');
  assert.ok(script.includes('nextElementSibling'), 'y su hermano inmediato');
  assert.ok(script.includes('checkVisibility'), 'consulta la visibilidad real');
  assert.ok(script.includes("getAttribute('aria-hidden')"), 'y los ancestros ocultos');

  const nuevos = (await avisos()).slice(0, (await avisos()).length - antes);
  const aviso = nuevos.find((entry) => entry.meta?.disponible === true);
  assert.ok(aviso, `se publica el recuento: ${JSON.stringify(nuevos.map((e) => e.meta))}`);
  assert.equal(aviso.title, 'diag-dom-nodos: 3 nodos');
  assert.equal(aviso.meta.h4, 3);
  assert.equal(aviso.meta.conEtiqueta, 2);
  assert.equal(aviso.meta.nodos.length, 3);
  assert.deepEqual(aviso.meta.nodos[1], {
    indice: 1, rol: 'assistant', chars: 240, visible: false, oculto: true, rects: 0,
  });
  assert.equal(aviso.meta.nodos[2].visible, null, 'checkVisibility ausente se informa como n.d.');
  assert.match(aviso.detail, /^main h4 3 · con etiqueta 2$/m);
  assert.match(aviso.detail, /^1 assistant 240c vis no oculto sí rects 0$/m);
  assert.match(aviso.detail, /^2 assistant 5c vis n\.d\. oculto no rects 1$/m);
  assert.equal(aviso.kind, 'system');
  assert.equal(aviso.severity, 'info');
});

test('con NEXO_DIAG=1, un fallo de la página no filtra su mensaje', async () => {
  const conTexto = () => {
    const error = new Error('texto privado de la página que no debe salir');
    error.name = 'ErrorDePagina';
    return Promise.reject(error);
  };
  const view = await pestanaConEjecutor('https://chatgpt.com/c/7c16f-c-error', conTexto);
  const antes = (await avisos()).length;

  await invoke('nexo:repetition:snapshot', asSender(view), { href: view.url, turns });
  await settle();

  if (!DIAG) {
    assert.equal((await avisos()).length - antes, 0);
    return;
  }
  const nuevos = (await avisos()).slice(0, (await avisos()).length - antes);
  const aviso = nuevos.find((entry) => entry.meta?.disponible === false);
  assert.ok(aviso, 'el fallo queda publicado');
  assert.equal(aviso.title, 'diag-dom-nodos: no disponible');
  assert.equal(aviso.meta.motivo, 'error-ErrorDePagina', 'sólo el nombre del error');
  assert.ok(!JSON.stringify(aviso).includes('texto privado'), 'el mensaje del error no viaja');
  assert.match(aviso.detail, /motivo error-ErrorDePagina · sin datos de la página/);
});

test('con NEXO_DIAG=1, un resultado con otra forma se informa como no disponible', async () => {
  const view = await pestanaConEjecutor('https://chatgpt.com/c/7c16f-c-forma', { otra: 'cosa' });
  const antes = (await avisos()).length;
  await invoke('nexo:repetition:snapshot', asSender(view), { href: view.url, turns });
  await settle();

  if (!DIAG) {
    assert.equal((await avisos()).length - antes, 0);
    return;
  }
  const nuevos = (await avisos()).slice(0, (await avisos()).length - antes);
  const aviso = nuevos.find((entry) => entry.meta?.disponible === false);
  assert.ok(aviso, 'la forma inesperada se informa');
  assert.equal(aviso.meta.motivo, 'formato');
});

test('como mucho una lectura cada 3 s por pestaña', async () => {
  const view = await pestanaConEjecutor('https://chatgpt.com/c/7c16f-c-rate', FORMA_REAL);
  await invoke('nexo:repetition:snapshot', asSender(view), { href: view.url, turns });
  await settle();
  await invoke('nexo:repetition:snapshot', asSender(view), { href: view.url, turns: [...turns, { id: 'u2', role: 'user', content: 'otra' }] });
  await settle();

  assert.equal(view.llamadas.length, DIAG ? 1 : 0,
    DIAG ? 'la segunda lectura cae dentro del freno de 3 s' : 'sin la variable no se llama');
});
