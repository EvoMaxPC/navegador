/**
 * Contadores con la observación CDP, que es el camino que funciona aunque la
 * capa de la página no esté activa.
 *
 * Estas pruebas reproducen la conversación real que falló:
 *
 *   usuario: «hola» → ChatGPT: «¡Holaaa! ¿Cómo estás?…»
 *
 * y comprueban lo que tiene que dar: **1 mensaje, 1 respuesta, 1 turno**, con
 * los tokens de cada lado y sin historial ni pedazos contados de más.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { countGptTokens } from '../src/main/tokens.js';

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

/** Pestaña nueva sobre un sitio con perfil, con el depurador adjunto. */
async function abrir(url) {
  const win = journal.windows[0];
  const view = win.attachWebview(url);
  view.navigateTo(url, 'ChatGPT');
  await settle(60);
  return view;
}

const PROMPT = 'hola';
const RESPUESTA = '¡Holaaa! 😊 ¿Cómo estás? ¿En qué te puedo ayudar hoy?';

/** Cuerpo real de un envío de ChatGPT. */
const cuerpoEnvio = JSON.stringify({
  action: 'next',
  conversation_id: 'conv-real-1',
  messages: [
    { id: 'm-1', author: { role: 'system' }, content: { content_type: 'text', parts: ['Sos un asistente.'] } },
    { id: 'm-2', author: { role: 'user' }, content: { content_type: 'text', parts: [PROMPT] } },
  ],
  model: 'auto',
});

/** Eventos de red de una petición completa, como los entrega Chromium. */
async function peticion(view, { requestId, url, method = 'POST', postData = null, body = null }) {
  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId,
    type: 'XHR',
    request: { url, method, postData },
  });
  await settle(20);

  if (body === null) return;
  view.debugger.emitEvent('Network.responseReceived', {
    requestId,
    type: 'XHR',
    response: { url, status: 200, mimeType: 'application/json' },
  });
  view.debugger.bodies.set(requestId, JSON.stringify(body));
  view.debugger.emitEvent('Network.loadingFinished', { requestId });
  await settle(60);
}

/* ------------------------------------------------------------------ */
/* el caso real: sólo CDP ve la conversación                           */
/* ------------------------------------------------------------------ */

test('la conversación real «hola» cuenta 1 mensaje, 1 respuesta y 1 turno', async () => {
  const view = await abrir('https://chatgpt.com/c/conv-real-1');
  const antes = await stats();

  // El envío del usuario.
  await peticion(view, {
    requestId: 'req-hola',
    url: 'https://chatgpt.com/backend-api/f/conversation',
    postData: cuerpoEnvio,
  });

  // La respuesta, que en ChatGPT llega por SSE. Acá se simula el cierre que
  // anuncia la capa de la página para el mismo envío.
  const trasEnvio = await stats();
  assert.equal(trasEnvio.messages, antes.messages + 1, 'el mensaje del usuario se cuenta');
  assert.ok(trasEnvio.inputTokens > antes.inputTokens, 'con sus tokens de entrada');

  await callIpc(
    'nexo:stream-end',
    {
      host: 'chatgpt.com',
      site: 'chatgpt',
      conversationId: 'conv-real-1',
      chars: RESPUESTA.length,
      tokens: 24,
      text: RESPUESTA,
      finished: true,
    },
    view.id,
  );

  const fin = await stats();
  assert.equal(fin.messages, antes.messages + 1, 'un mensaje, no dos');
  assert.equal(fin.responses, antes.responses + 1, 'una respuesta, no cuatro');
  assert.equal(Object.hasOwn(fin, 'turnsCompleted'), false, 'el contador eliminado no se expone');
  assert.equal(fin.outputTokens, antes.outputTokens + countGptTokens(RESPUESTA), 'los tokens de la respuesta visible');
  assert.equal(
    fin.interventions,
    antes.interventions + 2,
    'actividad: el envío y la respuesta suman una cada uno',
  );
  assert.equal(fin.mediatedInterventions, antes.mediatedInterventions, 'Nexo no intervino');
});

test('el mensaje contado por la capa y por CDP es uno solo', async () => {
  const view = await abrir('https://chatgpt.com/c/conv-real-2');
  const { fingerprint } = await import('../src/core/text.js');
  const emitir = journal.ipcListeners.get('nexo:event');
  assert.ok(emitir, 'hay canal de eventos de la capa');
  const sender = { id: view.id, getType: () => 'webview', getURL: () => 'https://chatgpt.com/' };

  const antes = await stats();
  const payload = {
    host: 'chatgpt.com',
    site: 'chatgpt',
    conversationId: 'conv-real-2',
    chars: PROMPT.length,
    tokens: 2,
    promptHash: fingerprint(PROMPT),
    textFound: true,
  };

  // La capa avisa del envío y, medio segundo después, CDP ve la misma petición
  // con otro identificador: mismo texto, dos fuentes.
  emitir({ sender }, { type: 'outgoing', payload: { ...payload, messageId: 'm-capa', source: 'request' } });
  await settle(10);
  emitir({ sender }, { type: 'outgoing', payload: { ...payload, messageId: 'm-cdp', source: 'cdp' } });
  await settle(10);

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 1, 'dos avisos del mismo envío, un mensaje');
  assert.equal(despues.inputTokens, antes.inputTokens + 2, 'y los tokens una sola vez');
});

test('dos mensajes iguales seguidos sí son dos mensajes', async () => {
  const view = await abrir('https://chatgpt.com/c/conv-real-2b');
  const { fingerprint } = await import('../src/core/text.js');
  const emitir = journal.ipcListeners.get('nexo:event');
  const sender = { id: view.id, getType: () => 'webview', getURL: () => 'https://chatgpt.com/' };
  const antes = await stats();

  for (const messageId of ['m-1', 'm-2']) {
    emitir(
      { sender },
      {
        type: 'outgoing',
        payload: {
          messageId,
          source: 'request',
          host: 'chatgpt.com',
          site: 'chatgpt',
          chars: PROMPT.length,
          tokens: 2,
          promptHash: fingerprint(PROMPT),
          textFound: true,
        },
      },
    );
    await settle(10);
  }

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 2, 'la misma persona puede escribir «hola» dos veces');
});

/* ------------------------------------------------------------------ */
/* lo que no se debe contar                                            */
/* ------------------------------------------------------------------ */

test('abrir el historial de la conversación no cuenta como respuesta', async () => {
  const view = await abrir('https://chatgpt.com/c/conv-real-3');
  const antes = await stats();

  // Un GET del historial devuelve todos los mensajes anteriores en JSON.
  const historial = {
    title: 'Conversación',
    mapping: {
      a: { message: { author: { role: 'user' }, content: { parts: ['mensaje viejo uno'] } } },
      b: { message: { author: { role: 'assistant' }, content: { parts: ['respuesta vieja bastante más larga que la anterior'] } } },
      c: { message: { author: { role: 'user' }, content: { parts: ['mensaje viejo dos'] } } },
    },
  };
  await peticion(view, {
    requestId: 'req-historial',
    url: 'https://chatgpt.com/backend-api/conversation/conv-real-3',
    method: 'GET',
    body: historial,
  });

  const despues = await stats();
  assert.equal(despues.responses, antes.responses, 'el historial no es una respuesta nueva');
  assert.equal(despues.messages, antes.messages, 'ni un mensaje nuevo');
  assert.equal(despues.outputTokens, antes.outputTokens, 'ni tokens de salida');
});

test('la misma respuesta en pedazos se cuenta una vez y no infla los tokens', async () => {
  const view = await abrir('https://chatgpt.com/c/conv-real-4');
  const antes = await stats();

  const primerTrozo = 'La respuesta va llegando';
  const completa = 'La respuesta va llegando de a poco y al final termina.';

  view.debugger.emitEvent('Network.webSocketCreated', { requestId: 'ws-trozos', url: 'wss://chatgpt.com/backend-api/ws' });
  view.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-trozos',
    response: { opcode: 1, payloadData: JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: primerTrozo }) },
  });
  view.debugger.emitEvent('Network.webSocketClosed', { requestId: 'ws-trozos' });
  await settle(40);
  const trasPrimero = await stats();
  assert.equal(trasPrimero.responses, antes.responses + 1, 'el primer trozo cierra una respuesta observada');

  // La misma respuesta, ahora completa, por otro socket.
  view.debugger.emitEvent('Network.webSocketCreated', { requestId: 'ws-trozos-2', url: 'wss://chatgpt.com/backend-api/ws' });
  view.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-trozos-2',
    response: {
      opcode: 1,
      payloadData: JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: completa.slice(primerTrozo.length) }),
    },
  });
  view.debugger.emitEvent('Network.webSocketClosed', { requestId: 'ws-trozos-2' });
  await settle(40);

  const fin = await stats();
  assert.equal(fin.responses, trasPrimero.responses, 'el texto que crece no es otra respuesta');
  // Lo que se suma es la diferencia de la respuesta completa, no el trozo entero.
  assert.ok(
    fin.outputTokens >= trasPrimero.outputTokens,
    'los tokens reflejan la respuesta completa',
  );
});

test('regenerar no cuenta un mensaje del usuario', async () => {
  const view = await abrir('https://chatgpt.com/c/conv-real-5');
  const antes = await stats();

  await peticion(view, {
    requestId: 'req-variante',
    url: 'https://chatgpt.com/backend-api/f/conversation',
    postData: JSON.stringify({ action: 'variant', conversation_id: 'conv-real-5', messages: [] }),
  });

  const despues = await stats();
  assert.equal(despues.messages, antes.messages, 'regenerar no es un mensaje nuevo');
});

/* ------------------------------------------------------------------ */
/* el stream cuando la capa de la página no está                       */
/* ------------------------------------------------------------------ */

test('si la capa no está activa, CDP lee el SSE completo y cuenta una respuesta', async () => {
  const view = await abrir('https://chatgpt.com/c/conv-sin-capa');
  const antes = await stats();

  const sse = [
    'data: {"message":{"id":"r-1","author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress"}}',
    'data: {"message":{"id":"r-1","author":{"role":"assistant"},"content":{"content_type":"text","parts":["¡Holaaa! "]}},"conversation_id":"conv-sin-capa"}',
    'data: {"message":{"id":"r-1","author":{"role":"assistant"},"content":{"content_type":"text","parts":["¡Holaaa! ¿En qué te ayudo?"]}},"conversation_id":"conv-sin-capa"}',
    'data: [DONE]',
  ].join('\n\n');

  // El envío, que es lo que asocia el turno.
  await peticion(view, {
    requestId: 'req-sse-1',
    url: 'https://chatgpt.com/backend-api/f/conversation',
    postData: cuerpoEnvio,
  });

  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'req-sse-1',
    type: 'XHR',
    request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST', postData: cuerpoEnvio },
  });
  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-sse-1',
    type: 'XHR',
    response: { url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' },
  });
  view.debugger.bodies.set('req-sse-1', sse);
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-sse-1' });
  await settle(80);

  const fin = await stats();
  assert.equal(fin.messages, antes.messages + 1, 'un mensaje');
  assert.equal(fin.responses, antes.responses + 1, 'una respuesta');
  assert.equal(Object.hasOwn(fin, 'turnsCompleted'), false, 'el contador eliminado no se expone');
  assert.ok(fin.outputTokens > antes.outputTokens, 'con tokens de salida');
});

test('con la capa viva pero sin cierre de stream, CDP rescata la respuesta', async () => {
  const view = await abrir('https://chatgpt.com/c/conv-con-capa');
  const emitir = journal.ipcListeners.get('nexo:event');
  const sender = { id: view.id, getType: () => 'webview', getURL: () => 'https://chatgpt.com/' };

  // La capa cuenta un envío: está viva. Pero contar el envío no es capturar la
  // contestación, y en esta prueba la capa no informa ningún cierre de stream.
  // Si CDP se retirara, la respuesta no la contaría nadie.
  emitir(
    { sender },
    {
      type: 'outgoing',
      payload: {
        messageId: 'm-capa-stream',
        source: 'request',
        host: 'chatgpt.com',
        site: 'chatgpt',
        chars: 8,
        tokens: 3,
        promptHash: 'h-capa-stream',
        textFound: true,
      },
    },
  );
  await settle(10);

  const antes = await stats();
  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'req-stream-capado',
    type: 'XHR',
    request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST' },
  });
  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-stream-capado',
    type: 'XHR',
    response: { url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' },
  });
  view.debugger.bodies.set('req-stream-capado', 'data: {"message":{"author":{"role":"assistant"},"content":{"parts":["texto"]}}}\n\n');
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-stream-capado' });
  await settle(50);

  const despues = await stats();
  assert.equal(despues.responses, antes.responses + 1, 'la respuesta se cuenta una sola vez, por CDP');
});

test('si la capa cerró ese stream, CDP no vuelve a contar la misma respuesta', async () => {
  const view = await abrir('https://chatgpt.com/c/conv-capa-cerrada');
  const texto = 'Respuesta que la capa capturó entera y cerró con su stream.';
  const antes = await stats();

  // La capa cierra el stream: la respuesta ya está contada por ella.
  await callIpc('nexo:stream-end', {
    site: 'chatgpt',
    host: 'chatgpt.com',
    stopped: false,
    text: texto,
    deliveredChars: texto.length,
    droppedChars: 0,
  }, view.id);
  await settle(20);

  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'req-stream-doble',
    type: 'XHR',
    request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST' },
  });
  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-stream-doble',
    type: 'XHR',
    response: { url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' },
  });
  view.debugger.bodies.set(
    'req-stream-doble',
    `data: ${JSON.stringify({ message: { author: { role: 'assistant' }, content: { parts: [texto] } } })}\n\n`,
  );
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-stream-doble' });
  await settle(50);

  const despues = await stats();
  assert.equal(despues.responses, antes.responses + 1, 'una respuesta, la de la capa');
});

/* ------------------------------------------------------------------ */
/* auditoría: sólo la conversación, asociada y avisada                 */
/* ------------------------------------------------------------------ */

test('un JSON que no es del endpoint de conversación no cuenta como respuesta', async () => {
  const view = await abrir('https://chatgpt.com/c/conv-audit-1');
  const antes = await stats();

  // Mismo dominio, mismo POST, JSON con texto: no es la respuesta del modelo.
  await peticion(view, {
    requestId: 'req-cuentas',
    url: 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27',
    postData: '{"accounts":{}}',
    body: { message: { author: { role: 'assistant' }, content: { parts: ['Esto no es una respuesta del modelo.'] } } },
  });

  const despues = await stats();
  assert.equal(despues.responses, antes.responses, 'no se cuenta');
  assert.equal(Object.hasOwn(despues, 'turnsCompleted'), false, 'el contador eliminado no se expone');
  assert.equal(despues.outputTokens, antes.outputTokens, 'ni suma tokens');
});

test('la respuesta del endpoint de conversación se asocia a su mensaje y cierra el turno', async () => {
  const view = await abrir('https://chatgpt.com/c/conv-audit-2');
  const antes = await stats();

  await peticion(view, {
    requestId: 'req-asociada',
    url: 'https://chatgpt.com/backend-api/f/conversation',
    postData: JSON.stringify({
      action: 'next',
      messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: ['¿cuánto es 2+2?'] } }],
    }),
  });

  await peticion(view, {
    requestId: 'req-asociada',
    url: 'https://chatgpt.com/backend-api/f/conversation',
    postData: JSON.stringify({
      action: 'next',
      messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: ['¿cuánto es 2+2?'] } }],
    }),
    body: { message: { author: { role: 'assistant' }, content: { parts: ['Son 4.'] } } },
  });

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 1, 'un mensaje');
  assert.equal(despues.responses, antes.responses + 1, 'una respuesta');
  assert.equal(Object.hasOwn(despues, 'turnsCompleted'), false, 'el contador eliminado no se expone');

  const log = await callIpc('nexo:log');
  const entrada = log.find((item) => item.code === 'incoming-cdp');
  assert.ok(entrada, 'la respuesta observada queda en el registro');
  assert.equal(entrada.meta.paired, true, 'y dice que quedó asociada a su mensaje');
  assert.ok(entrada.meta.messageId, 'con el identificador del mensaje');
});

test('una respuesta observada actualiza los contadores de la interfaz al instante', async () => {
  const view = await abrir('https://chatgpt.com/c/conv-audit-3');
  const win = journal.windows[0];
  const antesAvisos = win.webContents.sent.filter((m) => m.channel === 'nexo:stats-changed').length;

  await peticion(view, {
    requestId: 'req-aviso',
    url: 'https://chatgpt.com/backend-api/f/conversation',
    postData: JSON.stringify({
      action: 'next',
      messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: ['hola otra vez'] } }],
    }),
  });

  const avisos = win.webContents.sent.filter((m) => m.channel === 'nexo:stats-changed');
  assert.ok(avisos.length > antesAvisos, 'el panel recibe el aviso sin esperar a nada más');
  const ultimo = avisos.at(-1).payload;
  assert.ok(ultimo.messages >= 1, 'y el aviso lleva los contadores');
});

test('una respuesta marcada como dudosa se informa como heurística, no como corte confirmado', async () => {
  const view = await abrir('https://chatgpt.com/c/conv-audit-4');
  await callIpc(
    'nexo:stream-end',
    {
      host: 'chatgpt.com',
      site: 'chatgpt',
      chars: 30,
      tokens: 8,
      text: 'La respuesta termina en un guion',
      finished: true,
      truncated: true,
    },
    view.id,
  );

  const log = await callIpc('nexo:log');
  const entrada = log.find((item) => item.code === 'incoming');
  assert.ok(entrada, 'queda en el registro');
  assert.equal(entrada.title, 'Respuesta recibida en chatgpt.com', 'no se afirma que la interrumpieron');
  assert.match(entrada.detail, /heurística/i, 'se dice que el cierre es una heurística');
});
