/**
 * `diag-respuesta-contada`: qué hizo el motor, camino por camino.
 *
 * El contador de respuestas y las entradas de Actividad pueden separarse: el
 * camino del DOM sumaba sin avisar, y el cierre del stream no suma cuando el
 * turno ya estaba contado. Este aviso dice las dos cosas juntas —contó sí/no y
 * avisó sí/no— para no tener que comparar números a mano.
 *
 * Un test por proceso (el arnés y `main.js` se importan una sola vez), así que
 * el cuerpo vive acá y lo importan `diag-respuesta-contada-off.test.js` y
 * `diag-respuesta-contada-on.test.js`. Sólo números: ni texto ni URL.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

const DIAG = process.env.NEXO_DIAG === '1';
/** Texto centinela: no debe aparecer en ningún aviso. */
const CENTINELA = 'CENTINELA-7c16f-b-no-debe-salir';
const RESPUESTA = `La respuesta del modelo con ${CENTINELA} dentro.`;

register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
await settle();

const shell = journal.windows[0].webContents;
shell.url = 'nexo://app/src/ui/shell/index.html';
const shellEvent = { sender: shell, senderFrame: shell.mainFrame };
const invoke = (channel, event, payload) => journal.ipcHandlers.get(channel)(event, payload);
const asSender = (contents) => ({ sender: contents, senderFrame: contents.mainFrame });

async function abrirPestana(href) {
  const view = journal.windows[0].attachWebview(href);
  view.navigateTo(href, 'ChatGPT');
  await settle();
  return view;
}

const avisos = async () => (await invoke('nexo:log', shellEvent))
  .filter((entry) => entry.code === 'diag-respuesta-contada');
/** Los del más nuevo al más viejo: lo nuevo está al principio. */
const nuevosDesde = async (antes) => (await avisos()).slice(0, (await avisos()).length - antes);

test('sin la variable no se publica ningún diag-respuesta-contada', {
  skip: DIAG ? 'con NEXO_DIAG=1 este caso no aplica' : false,
}, async () => {
  const href = 'https://chatgpt.com/c/7c16f-b-off';
  const view = await abrirPestana(href);
  const antes = (await avisos()).length;

  await invoke('nexo:repetition:snapshot', asSender(view), {
    href, streaming: false,
    turns: [{ id: 'visible-0', role: 'user', content: 'pregunta' },
      { id: 'visible-1', role: 'assistant', content: RESPUESTA }],
  });
  await invoke('nexo:stream-end', asSender(view), {
    site: 'chatgpt', host: 'chatgpt.com', messageId: 'msg-off',
    outcome: 'completed', finished: true, chars: RESPUESTA.length, text: RESPUESTA,
  });
  await settle();

  assert.equal((await avisos()).length - antes, 0, 'sin NEXO_DIAG=1 no se publica nada');
});

test('con la variable, el camino stream-end deja su aviso con contó y aviso', async () => {
  const href = 'https://chatgpt.com/c/7c16f-b-stream';
  const view = await abrirPestana(href);
  const antes = (await avisos()).length;

  await invoke('nexo:stream-end', asSender(view), {
    site: 'chatgpt', host: 'chatgpt.com', messageId: 'msg-b-stream',
    outcome: 'completed', finished: true, interrupted: false,
    chars: RESPUESTA.length, deliveredChars: RESPUESTA.length,
    text: RESPUESTA, truncated: false, stopped: false,
  });
  await settle();

  if (!DIAG) {
    assert.equal((await avisos()).length - antes, 0, 'sin la variable no hay aviso');
    return;
  }
  const nuevos = await nuevosDesde(antes);
  const entrada = nuevos.find((entry) => entry.meta?.camino === 'stream-end');
  assert.ok(entrada, `el cierre del stream deja su aviso: ${JSON.stringify(nuevos.map((e) => e.meta?.camino))}`);
  assert.equal(entrada.title, 'diag-respuesta-contada: stream-end');
  assert.equal(entrada.meta.conto, true, 'el cierre de un turno nuevo cuenta');
  assert.equal(entrada.meta.aviso, true, 'y además deja `incoming`');
  assert.equal(entrada.meta.chars, RESPUESTA.length);
  assert.equal(entrada.detail, `camino stream-end · contó sí · aviso sí · chars ${RESPUESTA.length}`);
  assert.equal(entrada.kind, 'system');
  assert.equal(entrada.severity, 'info');
  assert.ok(!JSON.stringify(entrada).includes(CENTINELA), 'el texto no viaja');
  assert.ok(!JSON.stringify(entrada).includes('/c/'), 'la ruta del chat no viaja');
});

test('con la variable, un cierre duplicado también deja aviso: contó no, aviso no', async () => {
  const href = 'https://chatgpt.com/c/7c16f-b-dup';
  const view = await abrirPestana(href);
  const antes = (await avisos()).length;
  const cierre = {
    site: 'chatgpt', host: 'chatgpt.com', messageId: 'msg-b-dup',
    outcome: 'completed', finished: true, chars: RESPUESTA.length, text: RESPUESTA,
  };
  await invoke('nexo:stream-end', asSender(view), cierre);
  await settle();
  await invoke('nexo:stream-end', asSender(view), cierre);
  await settle();

  if (!DIAG) {
    assert.equal((await avisos()).length - antes, 0);
    return;
  }
  const nuevos = await nuevosDesde(antes);
  const duplicado = nuevos.find((entry) => entry.meta?.conto === false);
  assert.ok(duplicado, 'el cierre que no cuenta también se informa');
  assert.equal(duplicado.meta.aviso, false, 'y avisa que no dejó `incoming`');
  assert.equal(duplicado.meta.camino, 'stream-end');
});

test('con la variable, el camino dom aparece y dice que contó y avisó', async () => {
  const href = 'https://chatgpt.com/c/7c16f-b-dom';
  const view = await abrirPestana(href);
  // Envío previo: sin turno esperando, la lectura no cuenta.
  journal.ipcListeners.get('nexo:event')(asSender(view), {
    type: 'outgoing',
    payload: { site: 'chatgpt', host: 'chatgpt.com', messageId: 'msg-b-dom', chars: 8, text: 'pregunta' },
  });
  await settle();
  const antes = (await avisos()).length;
  await invoke('nexo:repetition:snapshot', asSender(view), {
    href, streaming: true,
    turns: [{ id: 'visible-0', role: 'user', content: 'pregunta' }],
  });
  await settle();
  await invoke('nexo:repetition:snapshot', asSender(view), {
    href, streaming: false,
    turns: [{ id: 'visible-0', role: 'user', content: 'pregunta' },
      { id: 'visible-1', role: 'assistant', content: RESPUESTA }],
  });
  await settle();

  if (!DIAG) {
    assert.equal((await avisos()).length - antes, 0, 'sin la variable no hay aviso');
    return;
  }
  const nuevos = await nuevosDesde(antes);
  const dom = nuevos.find((entry) => entry.meta?.camino === 'dom' && entry.meta?.conto === true);
  assert.ok(dom, `la lectura que cuenta deja su aviso: ${JSON.stringify(nuevos.map((e) => e.meta?.camino))}`);
  assert.equal(dom.meta.aviso, true, 'y con `incoming-dom`');
  assert.equal(dom.meta.chars, RESPUESTA.length);
  assert.equal(dom.detail, `camino dom · contó sí · aviso sí · chars ${RESPUESTA.length}`);
  assert.ok(!JSON.stringify(dom).includes(CENTINELA), 'el texto no viaja');
});

test('los diag-respuesta-contada no llevan texto ni rutas, y no se deduplican', async () => {
  if (!DIAG) {
    assert.equal((await avisos()).length, 0, 'sin la variable no hay ninguno');
    return;
  }
  const volcado = JSON.stringify(await avisos());
  assert.ok(!volcado.includes(CENTINELA), 'el texto del chat no sale');
  assert.ok(!volcado.includes('/c/'), 'la ruta del chat no sale');
  assert.ok(!volcado.includes('https://'), 'ni la URL');
  // El mismo hecho dos veces deja dos avisos: está exento de la deduplicación.
  const href = 'https://chatgpt.com/c/7c16f-b-doble';
  const view = await abrirPestana(href);
  const antes = (await avisos()).length;
  const cierre = { site: 'chatgpt', host: 'chatgpt.com', messageId: 'msg-b-doble',
    outcome: 'completed', finished: true, chars: 10, text: 'una respuesta' };
  await invoke('nexo:stream-end', asSender(view), cierre);
  await invoke('nexo:stream-end', asSender(view), cierre);
  assert.equal((await avisos()).length - antes, 2, 'dos cierres, dos avisos');
});
