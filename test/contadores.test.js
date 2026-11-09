/**
 * Contadores de conversación: mensajes, respuestas, turnos y tokens.
 *
 * Se ejecuta el proceso principal real contra el Electron falso y se habla por
 * los mismos canales que usa la capa inyectada (`nexo:event` con `outgoing` y
 * `nexo:stream-end`), así que lo que se comprueba es el camino de producción y
 * no una versión paralela de la lógica.
 *
 * La regla que se verifica en todas: **cada mensaje y cada respuesta cuentan
 * exactamente una vez, haya o no intervención de Nexo.**
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { countGptTokens } from '../src/main/tokens.js';

process.env.NEXO_CRASH_WINDOW_MS = '600';

register('./harness/loader.mjs', import.meta.url);

const { journal } = await import('./harness/electron-stub.mjs');

await import('../src/main/main.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function callIpc(channel, payload, senderId = 1) {
  const handler = journal.ipcHandlers.get(channel);
  assert.ok(handler, `no hay handler para ${channel}`);
  return handler({ sender: { id: senderId } }, payload);
}

/** Emite un evento de la capa como lo haría el preload de una pestaña. */
function emitir(senderId, message) {
  const listener = journal.ipcListeners.get('nexo:event');
  assert.ok(listener, 'no hay canal de eventos de la capa');
  const sender = { id: senderId, getType: () => 'webview', getURL: () => message?.url || 'https://chatgpt.com/' };
  return listener({ sender }, message);
}

/** Mensaje enviado por el usuario, como lo anuncia la capa. */
function enviar(senderId, { messageId, chars = 24, tokens = 7, mediated = false, conversationId = 'conv-1' }) {
  return emitir(senderId, {
    type: 'outgoing',
    payload: {
      messageId,
      site: 'chatgpt',
      host: 'chatgpt.com',
      conversationId,
      url: 'https://chatgpt.com/backend-api/conversation',
      mediated,
      chars,
      tokens,
    },
  });
}

/** Respuesta cerrada, como la manda el filtro del stream. */
async function responder(senderId, { messageId, text, tokens = 11, stopped = false, truncated = false, host = 'chatgpt.com', site = 'chatgpt' }) {
  return callIpc(
    'nexo:stream-end',
    {
      messageId,
      site,
      host,
      conversationId: 'conv-1',
      finished: true,
      stopped,
      truncated,
      deliveredChars: text.length,
      chars: text.length,
      tokens,
      text,
    },
    senderId,
  );
}

const stats = () => callIpc('nexo:stats');

/* ------------------------------------------------------------------ */
/* 1 y 2. mensajes                                                      */
/* ------------------------------------------------------------------ */

test('1. un mensaje sin mediación cuenta una sola vez y suma actividad', async () => {
  const antes = await stats();
  enviar(201, { messageId: 'a1', mediated: false });
  const despues = await stats();

  assert.equal(despues.messages, antes.messages + 1, 'el mensaje se cuenta');
  // «intervenciones» en el panel es actividad de la conversación: cada envío y
  // cada respuesta suman una. Lo que hizo el mediador va en su propio contador.
  assert.equal(despues.interventions, antes.interventions + 1, 'el envío suma actividad');
  assert.equal(
    despues.mediatedInterventions,
    antes.mediatedInterventions,
    'sin mediación el motor no intervino',
  );
  assert.equal(despues.responses, antes.responses, 'todavía no hay respuesta');
  assert.equal(despues.turns, antes.turns, 'un mensaje suelto no es un turno');
});

test('el mismo mensaje repetido por la capa no se cuenta dos veces', async () => {
  const antes = await stats();
  enviar(202, { messageId: 'a2' });
  enviar(202, { messageId: 'a2' });
  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 1);
});

test('2. un mensaje mediado cuenta como mensaje y como intervención', async () => {
  const antes = await stats();
  enviar(203, { messageId: 'a3', mediated: true });

  // La intervención la cuenta el motor cuando el texto cambia de verdad.
  await callIpc('nexo:prepare', {
    prompt: 'hola, ¿me ayudás con esto?',
    url: 'https://chatgpt.com/backend-api/conversation',
    site: 'chatgpt',
  }, 203);

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 1, 'el mensaje se cuenta');
  assert.equal(despues.interventions, antes.interventions + 1, 'y suma actividad una vez');
  assert.ok(
    despues.mediatedInterventions >= antes.mediatedInterventions + 1,
    'y el mediador cuenta su intervención aparte',
  );
});

/* ------------------------------------------------------------------ */
/* 3, 4 y 5. respuestas                                                 */
/* ------------------------------------------------------------------ */

test('3. una respuesta SSE corta cierra el turno', async () => {
  const antes = await stats();
  enviar(204, { messageId: 'a4' });
  await responder(204, { messageId: 'a4', text: 'Respuesta breve.' });

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 1);
  assert.equal(despues.responses, antes.responses + 1);
  assert.equal(despues.turns, antes.turns + 1, 'mensaje y respuesta emparejados');
  assert.equal(despues.loopsCut, antes.loopsCut, 'una respuesta normal no corta nada');
});

test('4. una respuesta de más de 8 000 caracteres se registra entera', async () => {
  const largo = `${'La respuesta larga sigue y sigue sin repetirse. '.repeat(260)}FIN`;
  assert.ok(largo.length > 8000, 'el caso de prueba supera el tope viejo');

  const antes = await stats();
  enviar(205, { messageId: 'a5' });
  const resultado = await responder(205, { messageId: 'a5', text: largo, tokens: 2400 });
  const despues = await stats();

  assert.equal(despues.responses, antes.responses + 1);
  assert.equal(despues.turns, antes.turns + 1);
  assert.equal(despues.outputTokens, antes.outputTokens + countGptTokens(largo), 'cuenta los tokens de toda la respuesta');
  assert.ok(resultado.counted && !resultado.counted.duplicate, 'el cierre informa que contó');

  // El recorte de 8 000 caracteres estaba en la capa de la página. Se comprueba
  // en el motor, que es donde queda el texto que se usará como contexto.
  const { Engine } = await import('../src/main/engine.js');
  const { DEFAULT_SETTINGS } = await import('../src/core/settings.js');
  const entradas = [];
  const engine = new Engine({
    store: { settings: structuredClone(DEFAULT_SETTINGS), pushLog: (entry) => entradas.push(entry), log: entradas },
  });
  // El guardián de la conversación nace al preparar el envío, como en producción.
  engine.prepare(900, { prompt: 'contame algo largo', url: 'https://chatgpt.com/backend-api/conversation' });
  engine.onUserMessage(900, { messageId: 'largo', chars: 10, tokens: 3 });
  engine.onStreamEnd(900, { messageId: 'largo', text: largo, chars: largo.length, tokens: 2400 });
  const guard = engine.guards.get(900);
  const ultimo = guard.history.at(-1);
  assert.equal(ultimo.content.length, largo.length, 'el texto completo llegó al historial');
  assert.ok(ultimo.content.endsWith('FIN'), 'incluido el final');
});

test('5. una respuesta interrumpida se cuenta como respuesta, una sola vez', async () => {
  const antes = await stats();
  enviar(206, { messageId: 'a6' });
  await responder(206, { messageId: 'a6', text: 'Se cortó a mitad de fra', stopped: true, tokens: 40 });
  const despues = await stats();

  assert.equal(despues.responses, antes.responses + 1, 'la respuesta existió aunque se cortara');
  assert.equal(despues.turns, antes.turns + 1, 'el turno quedó asociado');
  assert.equal(despues.loopsCut, antes.loopsCut + 1, 'se contó el corte');

  // El mismo cierre repetido (reintento del sitio) no vuelve a contar.
  await responder(206, { messageId: 'a6', text: 'Se cortó a mitad de fra', stopped: true, tokens: 40 });
  const otra = await stats();
  assert.equal(otra.responses, despues.responses, 'sin duplicados');
  assert.equal(otra.loopsCut, despues.loopsCut, 'ni cortes duplicados');
});

/* ------------------------------------------------------------------ */
/* 6 y 8. varias pestañas y varios mensajes                             */
/* ------------------------------------------------------------------ */

test('6. dos conversaciones simultáneas en pestañas distintas no se mezclan', async () => {
  const antes = await stats();
  enviar(207, { messageId: 'b1', conversationId: 'conv-A' });
  enviar(208, { messageId: 'b2', conversationId: 'conv-B' });

  // Llega primero la respuesta de la segunda pestaña.
  await responder(208, { messageId: 'b2', text: 'Respuesta de la pestaña B.' });
  let medio = await stats();
  assert.equal(medio.messages, antes.messages + 2);
  assert.equal(medio.responses, antes.responses + 1);
  assert.equal(medio.turns, antes.turns + 1, 'cerró el turno de la pestaña que respondió');

  await responder(207, { messageId: 'b1', text: 'Respuesta de la pestaña A.' });
  const fin = await stats();
  assert.equal(fin.turns, antes.turns + 2, 'cada pestaña cerró el suyo');
});

test('8. varios mensajes consecutivos se cuentan todos', async () => {
  const antes = await stats();
  for (let i = 0; i < 3; i += 1) {
    enviar(209, { messageId: `c${i}` });
    await responder(209, { messageId: `c${i}`, text: `Respuesta número ${i}.` });
  }
  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 3);
  assert.equal(despues.responses, antes.responses + 3);
  assert.equal(despues.turns, antes.turns + 3);
});

/* ------------------------------------------------------------------ */
/* 7. la misma respuesta por SSE y por CDP                              */
/* ------------------------------------------------------------------ */

test('7. una respuesta vista por SSE y por CDP cuenta una sola vez', async () => {
  const win = journal.windows[0];
  const view = win.attachWebview('https://claude.ai/chat/dup-1');
  view.navigateTo('https://claude.ai/chat/dup-1', 'Proveedor');
  await settle();

  const texto = 'La misma respuesta que el stream ya entregó y que CDP vuelve a ver por el socket.';
  const antes = await stats();

  emitir(view.id, {
    type: 'outgoing',
    payload: {
      messageId: 'd1',
      site: 'claude',
      host: 'claude.ai',
      conversationId: 'dup-1',
      url: 'https://claude.ai/api/organizations/x/chat_conversations/dup-1/completion',
      mediated: false,
      chars: 20,
      tokens: 6,
    },
  });
  await responder(view.id, { messageId: 'd1', text: texto, host: 'claude.ai', site: 'claude' });
  const trasSse = await stats();

  // El mismo texto llega por el canal de observación.
  view.debugger.emitEvent('Network.webSocketCreated', { requestId: 'ws-dup', url: 'wss://claude.ai/ws' });
  view.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-dup',
    response: {
      opcode: 1,
      payloadData: JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: texto } }),
    },
  });
  view.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-dup',
    response: { opcode: 1, payloadData: JSON.stringify({ type: 'message_stop' }) },
  });
  await settle();

  const despues = await stats();
  assert.equal(despues.responses, trasSse.responses, 'CDP no vuelve a contar la misma respuesta');
  assert.equal(despues.turns, trasSse.turns, 'ni cierra un segundo turno');
  assert.equal(despues.messages, antes.messages + 1);
  assert.ok(despues.cdp.duplicates >= 1, 'el motor marcó el duplicado');
});

test('una respuesta que sólo vio CDP también cuenta', async () => {
  const win = journal.windows[0];
  const view = win.attachWebview('https://chatgpt.com/c/solo-cdp');
  view.navigateTo('https://chatgpt.com/c/solo-cdp', 'Proveedor');
  await settle();

  const antes = await stats();
  enviar(view.id, { messageId: 'e1', conversationId: 'solo-cdp' });

  view.debugger.emitEvent('Network.webSocketCreated', { requestId: 'ws-solo', url: 'wss://chatgpt.com/backend-api/ws' });
  view.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-solo',
    response: {
      opcode: 1,
      payloadData: JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: 'Respuesta que sólo vio el depurador.' }),
    },
  });
  view.debugger.emitEvent('Network.webSocketClosed', { requestId: 'ws-solo' });
  await settle();

  const despues = await stats();
  assert.equal(despues.responses, antes.responses + 1, 'la observación cuenta como respuesta');
  assert.equal(despues.turns, antes.turns + 1, 'y cierra el turno pendiente de esa pestaña');
});

/* ------------------------------------------------------------------ */
/* 9 y 10. interfaz                                                     */
/* ------------------------------------------------------------------ */

test('9. cada mensaje y cada respuesta avisan al instante a la interfaz', async () => {
  const win = journal.windows[0];
  const antes = win.webContents.sent.filter((m) => m.channel === 'nexo:stats-changed').length;

  enviar(210, { messageId: 'f1' });
  await responder(210, { messageId: 'f1', text: 'Respuesta para el refresco inmediato.' });

  const avisos = win.webContents.sent.filter((m) => m.channel === 'nexo:stats-changed');
  assert.ok(avisos.length >= antes + 2, 'se avisa al enviar y al recibir');
  const ultimo = avisos.at(-1).payload;
  assert.ok(ultimo.messages >= 1 && ultimo.responses >= 1, 'el aviso lleva los contadores');
});

test('10. los avisos del sistema no son intervenciones del agente', async () => {
  const antes = await stats();

  // Un aviso del sistema (el vigilante de red, un permiso, la carga de una capa).
  const completed = journal.webRequest.completed.get('persist:nexo');
  assert.ok(completed, 'el vigilante de red está escuchando');
  completed.listener({
    url: 'https://chatgpt.com/backend-api/conversation',
    method: 'POST',
    statusCode: 503,
    resourceType: 'xhr',
  });

  const despues = await stats();
  assert.equal(despues.interventions, antes.interventions, 'un aviso no es una intervención');
  assert.equal(despues.messages, antes.messages);
  assert.equal(despues.responses, antes.responses);

  const log = await callIpc('nexo:log');
  const aviso = log.find((entry) => entry.code === 'http-error');
  assert.ok(aviso, 'el aviso sí queda en el registro, con su propio código');
  assert.equal(aviso.kind, 'system', 'y separado de lo conversacional');
});
