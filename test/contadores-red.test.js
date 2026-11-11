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
import { countTokens as countO200k } from 'gpt-tokenizer';
import { countTokens as countCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { estimateTokens, gptModelFromRequest } from '../src/core/text.js';
import { countGptTokens, countTokensForProvider } from '../src/main/tokens.js';

// La respuesta contada desde la red espera a que la capa o CDP cuenten primero.
// En la prueba ese margen se acorta para no esperar segundo y medio por caso.
process.env.NEXO_NETRESP_MS = '100';

register('./harness/loader.mjs', import.meta.url);

const { journal } = await import('./harness/electron-stub.mjs');

// El respaldo de red usa una espera breve para dar prioridad al texto de CDP.
process.env.NEXO_NETRESP_MS = '1';
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
function peticionRed({
  url,
  method = 'POST',
  cuerpo = null,
  webContentsId = 1,
  sinPestana = false,
  requestId = null,
  id = null,
}) {
  const mano = journal.webRequest.before.get(PARTITION);
  assert.ok(mano, 'el vigilante de red está escuchando');
  const detalles = {
    url,
    method,
    resourceType: 'xhr',
    uploadData: cuerpo ? [{ bytes: Buffer.from(cuerpo, 'utf8') }] : undefined,
    ...(requestId ? { id: requestId } : {}),
  };
  if (id !== null) detalles.id = id;
  // Chromium no informa la pestaña cuando la petición sale de un worker.
  if (!sinPestana) detalles.webContentsId = webContentsId;
  let resultado = null;
  mano.listener(detalles, (respuesta) => {
    resultado = respuesta;
  });
  return resultado;
}

/** Simula el cierre HTTP de una petición de conversación en Electron. */
function respuestaRed({ url = 'https://chatgpt.com/backend-api/f/conversation', statusCode = 200, webContentsId = 1, sinPestana = false, method = 'POST', requestId = null } = {}) {
  const mano = journal.webRequest.completed.get(PARTITION);
  assert.ok(mano, 'el observador de respuestas está escuchando');
  const detalles = { url, method, statusCode, resourceType: 'xhr', ...(requestId ? { id: requestId } : {}) };
  if (!sinPestana) detalles.webContentsId = webContentsId;
  mano.listener(detalles);
}

/** El cierre de una petición, como lo informa Chromium. */
function completarRed({ url, webContentsId = 1, statusCode = 200, id = null }) {
  const mano = journal.webRequest.completed.get(PARTITION);
  assert.ok(mano, 'el vigilante mira las peticiones completadas');
  const detalles = { url, method: 'POST', resourceType: 'xhr', statusCode, webContentsId };
  if (id !== null) detalles.id = id;
  mano.listener(detalles);
}

const cuerpoChatGPT = (texto, extra = {}) =>
  JSON.stringify({
    action: 'next',
    model: 'gpt-5',
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
    requestId: 'req-completo',
  });
  await settle(20);

  const respuesta = '¡Hola! ¿En qué te puedo ayudar hoy?';
  const sse = [
    `data: ${JSON.stringify({ message: { id: 'r-1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['¡Hola! '] } } })}`,
    `data: ${JSON.stringify({ message: { id: 'r-1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [respuesta] } } })}`,
    'data: [DONE]\n\n',
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
  // El mismo cierre llega por webRequest: no debe sumar otra respuesta.
  respuestaRed({ requestId: 'req-completo', webContentsId: view.id });
  await settle(80);

  const fin = await stats();
  assert.equal(fin.messages, antes.messages + 1, '1 mensaje del usuario');
  assert.equal(fin.responses, antes.responses + 1, '1 respuesta de la IA');
  assert.equal(Object.hasOwn(fin, 'turnsCompleted'), false, 'el contador eliminado no se expone');

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
  assert.equal(Object.hasOwn(fin, 'turnsCompleted'), false, 'el contador eliminado no se expone');
});

/* ------------------------------------------------------------------ */
/* respaldo de salida HTTP                                             */
/* ------------------------------------------------------------------ */

test('una respuesta HTTP 2xx cierra el turno aunque la pestaña no venga en el evento', async () => {
  const view = await abrir('https://chatgpt.com/c/red-respuesta-red');
  const antes = await stats();  peticionRed({
    url: 'https://chatgpt.com/backend-api/f/conversation',
    cuerpo: cuerpoChatGPT('respuesta por red'),
    webContentsId: view.id,
    requestId: 'req-respuesta-red-correlacionada',
  });
  respuestaRed({ requestId: 'req-respuesta-red-correlacionada', sinPestana: true });
  await settle(30);

  const fin = await stats();
  assert.equal(fin.messages, antes.messages + 1, 'el mensaje de entrada se conserva');
  assert.equal(fin.responses, antes.responses + 1, 'la respuesta HTTP se cuenta');
  assert.equal(fin.turnsPerformed, antes.turnsPerformed + 1, 'interrupción sin confirmación: un turno desconocido');
  assert.equal(fin.outputTokens, antes.outputTokens, 'sin texto no se inventan tokens');
});

test('una respuesta HTTP fallida no se cuenta como respuesta de GPT', async () => {
  const view = await abrir('https://chatgpt.com/c/red-respuesta-fallida');
  const antes = await stats();
  peticionRed({
    url: 'https://chatgpt.com/backend-api/f/conversation',
    cuerpo: cuerpoChatGPT('fallo HTTP'),
    webContentsId: view.id,
  });
  respuestaRed({ webContentsId: view.id, statusCode: 500 });
  await settle(30);
  const fin = await stats();
  assert.equal(fin.responses, antes.responses, 'un 500 no cuenta respuesta');
  assert.equal(Object.hasOwn(fin, 'turnsCompleted'), false, 'el contador eliminado no se expone');
});

test('la telemetría POST no se cuenta como respuesta de GPT', async () => {
  const antes = await stats();
  respuestaRed({
    url: 'https://chatgpt.com/ces/v1/telemetry/intake',
    statusCode: 200,
  });
  await settle(10);
  const fin = await stats();
  assert.equal(fin.responses, antes.responses, 'telemetría no suma respuestas');
  assert.equal(Object.hasOwn(fin, 'turnsCompleted'), false, 'el contador eliminado no se expone');
});

test('CDP lee el texto y los tokens del stream unauth-mweb de ChatGPT', async () => {
  const view = await abrir('https://chatgpt.com/c/red-unauth-mweb-cdp');
  const antes = await stats();

  journal.ipcListeners.get('nexo:event')(
    { sender: { id: view.id, getType: () => 'webview', getURL: () => 'https://chatgpt.com/' } },
    {
      type: 'outgoing',
      payload: {
        messageId: 'm-unauth-mweb-cdp',
        source: 'request',
        host: 'chatgpt.com',
        site: 'chatgpt',
        chars: 4,
        tokens: 1,
        promptHash: 'prompt-unauth-mweb-cdp',
        textFound: true,
      },
    },
  );

  const url = 'https://chatgpt.com/unauth-mweb/conversation/updates';
  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'req-unauth-mweb-cdp',
    type: 'XHR',
    request: { url, method: 'POST', postData: '{}' },
  });
  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-unauth-mweb-cdp',
    type: 'XHR',
    response: { url, status: 200, mimeType: 'text/event-stream' },
  });
  view.debugger.bodies.set(
    'req-unauth-mweb-cdp',
    `data: ${JSON.stringify({ message: { author: { role: 'assistant' }, content: { parts: ['Respuesta GPT capturada por CDP.'] } } })}\n\ndata: [DONE]\n\n`,
  );
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-unauth-mweb-cdp' });
  await settle(80);

  const fin = await stats();
  assert.equal(fin.messages, antes.messages + 1, 'se conserva un único mensaje');
  assert.equal(fin.responses, antes.responses + 1, 'CDP cuenta la respuesta');
  assert.equal(Object.hasOwn(fin, 'turnsCompleted'), false, 'el contador eliminado no se expone');
  assert.ok(fin.outputTokens > antes.outputTokens, 'se calculan tokens a partir del texto real');
});

test('CDP conserva unauth-mweb/updates cuando Chromium lo clasifica como Other', async () => {
  const view = await abrir('https://chatgpt.com/c/red-unauth-mweb-other');
  const antes = await stats();
  journal.ipcListeners.get('nexo:event')(
    { sender: { id: view.id, getType: () => 'webview', getURL: () => 'https://chatgpt.com/' } },
    {
      type: 'outgoing',
      payload: {
        messageId: 'm-unauth-mweb-other',
        source: 'request',
        host: 'chatgpt.com',
        site: 'chatgpt',
        chars: 4,
        tokens: 1,
        promptHash: 'prompt-unauth-mweb-other',
        textFound: true,
      },
    },
  );

  const url = 'https://chatgpt.com/unauth-mweb/conversation/updates';
  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'req-unauth-mweb-other',
    type: 'Other',
    request: { url, method: 'POST', postData: '{}' },
  });
  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-unauth-mweb-other',
    type: 'Other',
    response: { url, status: 200, mimeType: 'text/event-stream' },
  });
  view.debugger.bodies.set(
    'req-unauth-mweb-other',
    `data: ${JSON.stringify({ message: { author: { role: 'assistant' }, content: { parts: ['Respuesta desde recurso Other.'] } } })}\n\ndata: [DONE]\n\n`,
  );
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-unauth-mweb-other' });
  await settle(80);

  const fin = await stats();
  assert.equal(fin.messages, antes.messages + 1, 'no crea otro mensaje de usuario');
  assert.equal(fin.responses, antes.responses + 1, 'cuenta la respuesta aunque Chromium informe Other');
  assert.equal(Object.hasOwn(fin, 'turnsCompleted'), false, 'el contador eliminado no se expone');
  assert.ok(fin.outputTokens > antes.outputTokens, 'cuenta tokens de la respuesta');
});

test('ChatGPT unauth-mweb conversation/updates cuenta la respuesta sin contar otro mensaje', async () => {
  const view = await abrir('https://chatgpt.com/c/red-unauth-mweb');
  const antes = await stats();

  // El envío ya fue reconocido por la capa. El endpoint /updates transporta
  // la respuesta del modelo, no un segundo mensaje del usuario.
  journal.ipcListeners.get('nexo:event')(
    { sender: { id: view.id, getType: () => 'webview', getURL: () => 'https://chatgpt.com/' } },
    {
      type: 'outgoing',
      payload: {
        messageId: 'm-unauth-mweb',
        source: 'request',
        host: 'chatgpt.com',
        site: 'chatgpt',
        chars: 4,
        tokens: 1,
        promptHash: 'prompt-unauth-mweb',
        textFound: true,
      },
    },
  );

  peticionRed({
    url: 'https://chatgpt.com/unauth-mweb/conversation/updates',
    method: 'POST',
    webContentsId: view.id,
    requestId: 'req-unauth-mweb-updates',
  });
  respuestaRed({
    url: 'https://chatgpt.com/unauth-mweb/conversation/updates',
    method: 'POST',
    webContentsId: view.id,
    requestId: 'req-unauth-mweb-updates',
  });
  await settle(40);

  const fin = await stats();
  assert.equal(fin.messages, antes.messages + 1, 'el endpoint de respuesta no inventa otro mensaje');
  assert.equal(fin.responses, antes.responses + 1, 'la respuesta del endpoint actual se cuenta');
  assert.equal(fin.turnsPerformed, antes.turnsPerformed + 1, 'interrupción sin confirmación: un turno desconocido');
});

/* ------------------------------------------------------------------ */
/* el estado de la captura, tal como lo ve el panel                    */
/* ------------------------------------------------------------------ */

test('las estadísticas dicen qué vio el vigilante de red', async () => {
  await abrir('https://chatgpt.com/c/red-estado');
  const antes = await stats();

  assert.equal(antes.capture.watcher, true, 'el vigilante quedó registrado en la partición');
  assert.ok(antes.capture.requests > 0, 'la navegación ya pasó por el vigilante');

  peticionRed({
    url: 'https://chatgpt.com/backend-api/f/conversation',
    cuerpo: cuerpoChatGPT('estado de la captura'),
  });
  await settle(20);

  const despues = await stats();
  assert.equal(
    despues.capture.chatRequests,
    antes.capture.chatRequests + 1,
    'la petición de conversación se ve aunque el mensaje se deduplique después',
  );
  assert.ok(despues.capture.lastRequestAt > 0, 'queda la marca de la última petición vista');
  // La línea del panel se arma con estos dos bloques y ninguno inventa nada.
  assert.ok(despues.cdpObserver, 'el estado del depurador viaja en la misma respuesta');
  assert.equal(typeof despues.cdpObserver.tabs, 'number', 'con sus pestañas enganchadas');
});

test('un POST al proveedor fuera de la ruta conocida queda anotado con su ruta real', async () => {
  await abrir('https://chatgpt.com/c/red-ruta');
  const antes = await stats();
  const logAntes = (await callIpc('nexo:log')).length;

  // Si ChatGPT mueve el endpoint, el mensaje no se cuenta: sin este aviso el
  // panel sólo mostraría ceros sin decir qué petición se quedó fuera.
  peticionRed({ url: 'https://chatgpt.com/backend-api/f/conversation/prepare', cuerpo: cuerpoChatGPT('hola') });
  await settle(20);

  const despues = await stats();
  assert.equal(despues.messages, antes.messages, 'preparar no es un mensaje');
  assert.equal(despues.capture.posts, antes.capture.posts + 1, 'el POST se vio');
  assert.equal(despues.capture.chatRequests, antes.capture.chatRequests, 'pero no es de conversación');

  const log = await callIpc('nexo:log');
  assert.equal(log.length, logAntes + 1, 'el aviso entra en el registro');
  const aviso = log.find((e) => e.code === 'chat-unmatched');
  assert.ok(aviso, 'con su código propio');
  assert.match(aviso.detail, /conversation\/prepare/, 'con la ruta exacta que llegó');
});

test('con el sitio apagado en Ajustes, el panel dice que llegó y no se contó', async () => {
  await abrir('https://chatgpt.com/c/red-apagado');
  const ajustes = await callIpc('nexo:settings:get');
  await callIpc('nexo:settings:set', {
    ...ajustes,
    sites: { ...(ajustes.sites || {}), chatgpt: { enabled: false } },
  });

  try {
    const antes = await stats();
    peticionRed({
      url: 'https://chatgpt.com/backend-api/f/conversation',
      cuerpo: cuerpoChatGPT('con el sitio apagado'),
    });
    await settle(20);

    const despues = await stats();
    assert.equal(despues.messages, antes.messages, 'apagado no cuenta mensajes');
    assert.equal(despues.capture.chatRequests, antes.capture.chatRequests + 1, 'la petición se vio igual');
    assert.equal(despues.capture.counted, antes.capture.counted, 'pero no se contó');
    assert.equal(despues.capture.blocked, antes.capture.blocked + 1, 'y queda dicho que la frenó el ajuste');

    const log = await callIpc('nexo:log');
    const aviso = log.find((e) => e.code === 'chat-disabled');
    assert.ok(aviso, 'con un aviso en el registro, no un cero mudo');
    assert.match(aviso.title, /chatgpt\.com/);
  } finally {
    await callIpc('nexo:settings:reset');
  }
});

/* ------------------------------------------------------------------ */
/* la ruta cambió: manda el cuerpo, no el endpoint                     */
/* ------------------------------------------------------------------ */

test('una ruta de conversación con otra forma se reconoce y cuenta', async () => {
  const view = await abrir('https://chatgpt.com/c/red-ruta-nueva');
  const antes = await stats();

  // El sitio estrena versión de endpoint: mismo cuerpo, otra ruta.
  peticionRed({
    url: 'https://chatgpt.com/backend-api/v2/conversation',
    cuerpo: cuerpoChatGPT('pregunta en ruta nueva'),
    webContentsId: view.id,
  });
  await settle(20);

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 1, 'el mensaje se cuenta');
  assert.equal(despues.capture.chatRequests, antes.capture.chatRequests + 1, 'y el panel lo ve como conversación');
});

test('si la ruta no se parece a ninguna conocida, el cuerpo delata la conversación', async () => {
  const view = await abrir('https://chatgpt.com/c/red-ruta-rara');
  const antes = await stats();

  // Ningún patrón de ruta: el cuerpo es de ChatGPT y trae el mensaje.
  peticionRed({
    id: 777,
    url: 'https://chatgpt.com/uc/ea1e397-7694/enviar',
    cuerpo: cuerpoChatGPT('pregunta por ruta desconocida'),
    webContentsId: view.id,
  });
  await settle(20);

  const trasEnviar = await stats();
  assert.equal(trasEnviar.messages, antes.messages + 1, 'el mensaje se cuenta');

  // Y su respuesta se cuenta también, por el identificador de la petición.
  completarRed({ id: 777, url: 'https://chatgpt.com/uc/ea1e397-7694/enviar', webContentsId: view.id });
  await settle(200);

  const fin = await stats();
  assert.equal(fin.responses, antes.responses + 1, '+1 respuestas de la IA');
  assert.equal(fin.turnsPerformed, antes.turnsPerformed + 1, 'interrupción sin confirmación: un turno desconocido');

  const log = await callIpc('nexo:log');
  const aviso = log.find((item) => item.code === 'chat-ruta');
  assert.ok(aviso, 'la ruta real queda anotada');
  assert.match(aviso.detail, /\/uc\/ea1e397-7694\/enviar/, 'con la ruta exacta que usó el sitio');
});

test('la ruta de preparación no cuenta un mensaje aunque traiga el cuerpo', async () => {
  await abrir('https://chatgpt.com/c/red-prepare');
  const antes = await stats();

  peticionRed({
    url: 'https://chatgpt.com/backend-api/f/conversation/prepare',
    cuerpo: cuerpoChatGPT('hola'),
  });
  await settle(20);

  const despues = await stats();
  assert.equal(despues.messages, antes.messages, 'preparar no es enviar');
});

test('restablecer los ajustes vuelve a habilitar el sitio que se había apagado', async () => {
  const ajustes = await callIpc('nexo:settings:get');
  await callIpc('nexo:settings:set', {
    ...ajustes,
    sites: { ...(ajustes.sites || {}), chatgpt: { enabled: false } },
  });
  assert.equal((await callIpc('nexo:config', { host: 'chatgpt.com' })).enabled, false, 'queda apagado');

  // Restablecer tiene que reemplazar, no fusionar: fusionando, el sitio seguía
  // apagado y el panel mostraba ceros sin ninguna causa visible.
  await callIpc('nexo:settings:reset');
  assert.equal((await callIpc('nexo:config', { host: 'chatgpt.com' })).enabled, true, 'y queda habilitado');
});


test('el contador GPT usa BPE o200k para modelos actuales y cl100k para GPT-4 clásico', () => {
  const texto = 'Hola, mundo. ¿Cómo estás?';
  assert.equal(countGptTokens(texto, 'gpt-5'), countO200k(texto));
  assert.equal(countGptTokens(texto, 'gpt-4o'), countO200k(texto));
  assert.equal(countGptTokens(texto, 'gpt-4.1'), countO200k(texto));
  assert.equal(countGptTokens(texto, 'gpt-4-turbo'), countCl100k(texto));
  assert.equal(countGptTokens(texto, 'gpt-3.5-turbo'), countCl100k(texto));
  assert.equal(countGptTokens('', 'gpt-5'), 0);
  assert.equal(countTokensForProvider(texto, 'gpt-5', 'chatgpt'), countO200k(texto));
  assert.equal(countTokensForProvider(texto, 'gpt-5', 'claude'), estimateTokens(texto));
});

test('el modelo GPT se obtiene del cuerpo de la solicitud cuando está disponible', () => {
  assert.equal(gptModelFromRequest({ model: 'gpt-4o' }), 'gpt-4o');
  assert.equal(gptModelFromRequest({ metadata: { model_slug: 'gpt-5' } }), 'gpt-5');
  assert.equal(gptModelFromRequest({}), '');
});


test('el contador de salida recalcula en el proceso principal si el preload envía cero', async () => {
  const view = await abrir('https://chatgpt.com/c/red-output-zero');
  const antes = await stats();

  journal.ipcListeners.get('nexo:event')(
    { sender: { id: view.id, getType: () => 'webview', getURL: () => 'https://chatgpt.com/' } },
    {
      type: 'outgoing',
      payload: {
        messageId: 'm-output-zero',
        source: 'request',
        host: 'chatgpt.com',
        site: 'chatgpt',
        chars: 5,
        tokens: 2,
        promptHash: 'prompt-output-zero',
        textFound: true,
      },
    },
  );

  const texto = 'Esta es una respuesta real de la inteligencia artificial.';
  await callIpc('nexo:stream-end', {
    messageId: 'm-output-zero',
    host: 'chatgpt.com',
    site: 'chatgpt',
    model: 'gpt-5',
    text: texto,
    chars: texto.length,
    tokens: 0,
    finished: true,
  });
  const fin = await stats();
  assert.ok(fin.outputTokens > antes.outputTokens, 'el proceso principal calcula tokens aunque el preload informe cero');
});
