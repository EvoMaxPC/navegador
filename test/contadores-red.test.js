/**
 * El contador de mensajes leído desde el proceso principal.
 *
 * Este camino no depende de la capa inyectada ni del depurador: Electron entrega
 * el cuerpo de la petición antes de que salga (`webRequest.onBeforeRequest`), y
 * ahí está el mensaje del usuario. Es la red de seguridad para el caso real:
 * «escribo, pulso enviar y el contador no sube».
 *
 * Se comprueba además el caso completo (§usuario escribe → IA responde) sin que
 * la capa de la página haga nada, que es como se comporta un ChatGPT donde la
 * inyección no corre.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./harness/loader.mjs', import.meta.url);

const { journal } = await import('./harness/electron-stub.mjs');

await import('../src/main/main.js');

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function callIpc(channel, payload, senderId = 1) {
  const handler = journal.ipcHandlers.get(channel);
  assert.ok(handler, `no hay handler para ${channel}`);
  return handler({ sender: { id: senderId } }, payload);
}

const stats = () => callIpc('nexo:stats');

const PARTITION = 'persist:nexo';

/** Lanza una petición por el vigilante de red, como lo hace Chromium. */
function peticionRed({ url, method = 'POST', cuerpo = null, webContentsId = 1, sinPestana = false }) {
  const mano = journal.webRequest.before.get(PARTITION);
  assert.ok(mano, 'el vigilante de red está escuchando');
  const detalles = {
    url,
    method,
    resourceType: 'xhr',
    uploadData: cuerpo ? [{ bytes: Buffer.from(cuerpo, 'utf8') }] : undefined,
  };
  // Chromium no informa la pestaña cuando la petición sale de un worker.
  if (!sinPestana) detalles.webContentsId = webContentsId;
  let resultado = null;
  mano.listener(detalles, (respuesta) => {
    resultado = respuesta;
  });
  return resultado;
}

const cuerpoChatGPT = (texto, extra = {}) =>
  JSON.stringify({
    action: 'next',
    messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: [texto] } }],
    ...extra,
  });

async function abrir(url = 'https://chatgpt.com/c/red-1') {
  const win = journal.windows[0];
  const view = win.attachWebview(url);
  view.navigateTo(url, 'ChatGPT');
  await settle(60);
  return view;
}

/* ------------------------------------------------------------------ */
/* la entrada                                                          */
/* ------------------------------------------------------------------ */

test('el mensaje se cuenta leyendo el cuerpo de la petición, y la petición sigue igual', async () => {
  await abrir('https://chatgpt.com/c/red-1');
  const antes = await stats();

  const respuesta = peticionRed({
    url: 'https://chatgpt.com/backend-api/f/conversation',
    cuerpo: cuerpoChatGPT('hola'),
  });

  const despues = await stats();
  assert.deepEqual(respuesta, {}, 'la petición no se cancela ni se redirige');
  assert.equal(despues.messages, antes.messages + 1, 'un mensaje');
  assert.ok(despues.inputTokens > antes.inputTokens, 'con sus tokens de entrada');

  const log = await callIpc('nexo:log');
  const entrada = log.find((item) => item.code === 'outgoing-network');
  assert.ok(entrada, 'queda en el registro con su origen');
  assert.equal(entrada.meta.source, 'network');
  assert.equal(entrada.meta.chars, 4, 'los caracteres del texto enviado');
});

test('una petición de conversación sin cuerpo legible cuenta el mensaje y deja el motivo', async () => {
  await abrir('https://chatgpt.com/c/red-2');
  const antes = await stats();

  peticionRed({ url: 'https://chatgpt.com/backend-api/f/conversation', cuerpo: null });

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 1, 'el envío existió aunque no se leyera');
  assert.equal(despues.inputTokens, antes.inputTokens, 'sin inventar tokens');

  const log = await callIpc('nexo:log');
  const motivo = log.find((item) => item.code === 'chat-request');
  assert.ok(motivo, 'queda dicho por qué no se pudo leer');
  assert.equal(motivo.kind, 'system', 'y no ensucia el contador de intervenciones');
});

test('un POST que no es del endpoint de conversación no cuenta', async () => {
  await abrir('https://chatgpt.com/c/red-3');
  const antes = await stats();

  peticionRed({
    url: 'https://chatgpt.com/backend-api/accounts/check/v4',
    cuerpo: JSON.stringify({ accounts: {} }),
  });

  const despues = await stats();
  assert.equal(despues.messages, antes.messages, 'no es un mensaje del usuario');
});

test('regenerar no cuenta un mensaje nuevo', async () => {
  await abrir('https://chatgpt.com/c/red-4');
  const antes = await stats();

  peticionRed({
    url: 'https://chatgpt.com/backend-api/f/conversation',
    cuerpo: cuerpoChatGPT('hola', { action: 'variant' }),
  });

  const despues = await stats();
  assert.equal(despues.messages, antes.messages, 'regenerar no es escribir');
});

test('el mismo envío visto por la red y por la capa es un solo mensaje', async () => {
  const view = await abrir('https://chatgpt.com/c/red-5');
  const { fingerprint } = await import('../src/core/text.js');
  const antes = await stats();

  peticionRed({
    url: 'https://chatgpt.com/backend-api/f/conversation',
    cuerpo: cuerpoChatGPT('¿me ayudás?'),
    webContentsId: view.id,
  });
  await settle(10);

  // La capa de la página avisa del mismo envío con otro identificador.
  journal.ipcListeners.get('nexo:event')(
    { sender: { id: view.id, getType: () => 'webview', getURL: () => 'https://chatgpt.com/' } },
    {
      type: 'outgoing',
      payload: {
        messageId: 'm-capa-red',
        source: 'request',
        host: 'chatgpt.com',
        site: 'chatgpt',
        chars: 12,
        tokens: 4,
        promptHash: fingerprint('¿me ayudás?'),
        textFound: true,
      },
    },
  );
  await settle(10);

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 1, 'un envío, un mensaje');
});

/* ------------------------------------------------------------------ */
/* el caso completo, sin la capa de la página                          */
/* ------------------------------------------------------------------ */

test('escribir, enviar y recibir respuesta cuenta 1 mensaje, 1 respuesta y 1 turno', async () => {
  const view = await abrir('https://chatgpt.com/c/red-completo');
  const antes = await stats();

  const cuerpo = cuerpoChatGPT('hola');
  peticionRed({
    url: 'https://chatgpt.com/backend-api/f/conversation',
    cuerpo,
    webContentsId: view.id,
  });
  await settle(20);

  const respuesta = '¡Hola! ¿En qué te puedo ayudar hoy?';
  const sse = [
    `data: ${JSON.stringify({ message: { id: 'r-1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['¡Hola! '] } } })}`,
    `data: ${JSON.stringify({ message: { id: 'r-1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [respuesta] } } })}`,
    'data: [DONE]',
  ].join('\n\n');

  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'req-completo',
    type: 'XHR',
    request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST', postData: cuerpo },
  });
  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-completo',
    type: 'XHR',
    response: { url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' },
  });
  view.debugger.bodies.set('req-completo', sse);
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-completo' });
  await settle(80);

  const fin = await stats();
  assert.equal(fin.messages, antes.messages + 1, '1 mensaje del usuario');
  assert.equal(fin.responses, antes.responses + 1, '1 respuesta de la IA');
  assert.equal(fin.turns, antes.turns + 1, '1 turno completo');

  const log = await callIpc('nexo:log');
  const respuestaLog = log.find((item) => item.code === 'incoming-cdp');
  assert.ok(respuestaLog, 'la respuesta queda registrada');
  assert.equal(respuestaLog.meta.paired, true, 'asociada al mensaje que la originó');
});

test('la capa que sólo se anuncia no impide que CDP lea la respuesta', async () => {
  const view = await abrir('https://chatgpt.com/c/red-capa-muda');
  const antes = await stats();

  // La capa dice «estoy instalada» pero nunca cuenta nada: es el caso real de una
  // inyección que corre y no llega a ver las peticiones del sitio.
  journal.ipcListeners.get('nexo:event')(
    { sender: { id: view.id, getType: () => 'webview', getURL: () => 'https://chatgpt.com/' } },
    { type: 'ready', payload: { site: 'chatgpt', host: 'chatgpt.com', version: '0.1.4' } },
  );
  await settle(10);

  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-capa-muda',
    type: 'XHR',
    response: { url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' },
  });
  view.debugger.bodies.set(
    'req-capa-muda',
    `data: ${JSON.stringify({ message: { author: { role: 'assistant' }, content: { parts: ['Respuesta con la capa muda.'] } } })}\n\n`,
  );
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-capa-muda' });
  await settle(80);

  const despues = await stats();
  assert.equal(despues.responses, antes.responses + 1, 'la respuesta se cuenta igual');
});

test('un envío salido de un worker (sin pestaña identificada) igual cierra su turno', async () => {
  const view = await abrir('https://chatgpt.com/c/red-worker');
  const antes = await stats();

  // Chromium no siempre informa la pestaña de una petición que sale de un
  // service worker: llega sin `webContentsId`.
  peticionRed({
    url: 'https://chatgpt.com/backend-api/f/conversation',
    cuerpo: cuerpoChatGPT('consulta desde worker'),
    sinPestana: true,
  });
  await settle(20);

  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-worker',
    type: 'XHR',
    response: { url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' },
  });
  view.debugger.bodies.set(
    'req-worker',
    `data: ${JSON.stringify({ message: { author: { role: 'assistant' }, content: { parts: ['Respuesta desde worker.'] } } })}\n\n`,
  );
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-worker' });
  await settle(80);

  const fin = await stats();
  assert.equal(fin.messages, antes.messages + 1, 'el mensaje se cuenta');
  assert.equal(fin.responses, antes.responses + 1, 'la respuesta se cuenta');
  assert.equal(fin.turns, antes.turns + 1, 'y el turno se cierra igual');
});

test('un envío detectado por la capa no bloquea a CDP si la capa no captura la respuesta', async () => {
  const view = await abrir('https://chatgpt.com/c-red-envio-sin-respuesta');
  const antes = await stats();

  // La capa anuncia el envío: esto no prueba que vaya a capturar el stream.
  journal.ipcListeners.get('nexo:event')(
    { sender: { id: view.id, getType: () => 'webview', getURL: () => 'https://chatgpt.com/' } },
    {
      type: 'outgoing',
      payload: {
        messageId: 'layer-send-sin-respuesta',
        source: 'request',
        host: 'chatgpt.com',
        site: 'chatgpt',
        chars: 4,
        tokens: 1,
        textFound: true,
      },
    },
  );
  await settle(10);

  const cuerpo = cuerpoChatGPT('hola');
  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'req-layer-no-capture',
    type: 'XHR',
    request: {
      url: 'https://chatgpt.com/backend-api/f/conversation',
      method: 'POST',
      postData: cuerpo,
    },
  });
  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-layer-no-capture',
    type: 'XHR',
    response: {
      url: 'https://chatgpt.com/backend-api/f/conversation',
      status: 200,
      mimeType: 'text/event-stream',
    },
  });
  view.debugger.bodies.set(
    'req-layer-no-capture',
    `data: ${JSON.stringify({ message: { author: { role: 'assistant' }, content: { parts: ['Respuesta capturada por CDP.'] } } })}\\n\\n`,
  );
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-layer-no-capture' });
  await settle(80);

  const fin = await stats();
  assert.equal(fin.messages, antes.messages + 1, 'el envío se cuenta una sola vez');
  assert.equal(fin.responses, antes.responses + 1, 'CDP captura la respuesta aunque la capa sólo haya enviado');
  assert.equal(fin.turns, antes.turns + 1, 'el intercambio queda completo');
});

