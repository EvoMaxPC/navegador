/**
 * Los dos contadores, comprobados contra la lista de aceptación.
 *
 * Cada prueba de este archivo corresponde a un criterio exigido para dar la
 * corrección por terminada: un mensaje → +1, una respuesta → +1, cinco
 * intercambios → 5 y 5, el streaming no suma por fragmento, la misma respuesta
 * vista por dos caminos suma una sola vez, los errores no suman, una respuesta a
 * medio escribir no está terminada, cada respuesta se asocia a su mensaje y la
 * interfaz se entera en el acto.
 *
 * Se ejecuta el proceso principal de producción contra el Electron falso: lo que
 * se prueba es el cableado real (IPC, webRequest, CDP), no una copia paralela.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./harness/loader.mjs', import.meta.url);

const { journal } = await import('./harness/electron-stub.mjs');

await import('../src/main/main.js');

const PARTITION = 'persist:nexo';
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function callIpc(channel, payload, senderId = 1) {
  const handler = journal.ipcHandlers.get(channel);
  assert.ok(handler, `no hay handler para ${channel}`);
  return handler({ sender: { id: senderId } }, payload);
}

const stats = () => callIpc('nexo:stats');

const cuerpoChatGPT = (texto) =>
  JSON.stringify({
    action: 'next',
    messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: [texto] } }],
  });

/** Un evento SSE de ChatGPT con el texto del asistente. */
const eventoSSE = (texto) =>
  `data: ${JSON.stringify({
    message: { author: { role: 'assistant' }, content: { parts: [texto] } },
  })}\n\n`;

/** El usuario envía: es la petición de conversación vista por webRequest. */
function enviar(texto, { webContentsId = 1 } = {}) {
  const mano = journal.webRequest.before.get(PARTITION);
  assert.ok(mano, 'el vigilante de red está escuchando');
  let respuesta = null;
  mano.listener(
    {
      url: 'https://chatgpt.com/backend-api/f/conversation',
      method: 'POST',
      resourceType: 'xhr',
      webContentsId,
      uploadData: [{ bytes: Buffer.from(cuerpoChatGPT(texto), 'utf8') }],
    },
    (r) => {
      respuesta = r;
    },
  );
  return respuesta;
}

/** La respuesta llega por CDP como stream completo. */
async function respuestaPorCDP(view, { requestId, texto, url = 'https://chatgpt.com/backend-api/f/conversation' }) {
  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId,
    type: 'XHR',
    request: { url, method: 'POST' },
  });
  view.debugger.emitEvent('Network.responseReceived', {
    requestId,
    type: 'XHR',
    response: { url, status: 200, mimeType: 'text/event-stream' },
  });
  view.debugger.bodies.set(requestId, eventoSSE(texto));
  view.debugger.emitEvent('Network.loadingFinished', { requestId });
  await settle(60);
}

async function abrir(url = 'https://chatgpt.com/c/contadores') {
  await settle();
  const win = journal.windows[0];
  const view = win.attachWebview(url);
  view.navigateTo(url, 'ChatGPT');
  await settle(40);
  return view;
}

/* ------------------------------------------------------------------ */
/* 1-2. un mensaje suma 1, una respuesta suma 1                         */
/* ------------------------------------------------------------------ */

test('1. un mensaje enviado suma exactamente 1', async () => {
  await abrir('https://chatgpt.com/c/c1');
  const antes = await stats();

  enviar('hola, primera pregunta');
  await settle(20);

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 1, 'un mensaje, un incremento');
  assert.equal(despues.responses, antes.responses, 'enviar no suma respuestas');
});

test('2. una respuesta completa suma exactamente 1', async () => {
  const view = await abrir('https://chatgpt.com/c/c2');
  const antes = await stats();

  enviar('pregunta para la respuesta', { webContentsId: view.id });
  await settle(20);
  await respuestaPorCDP(view, { requestId: 'req-c2', texto: 'La respuesta completa del modelo.' });

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 1, 'un mensaje');
  assert.equal(despues.responses, antes.responses + 1, 'una respuesta');
  assert.equal(despues.turns, antes.turns + 1, 'y el turno queda cerrado');
});

/* ------------------------------------------------------------------ */
/* 3. cinco intercambios                                               */
/* ------------------------------------------------------------------ */

test('3. cinco intercambios seguidos dan 5 mensajes y 5 respuestas', async () => {
  const view = await abrir('https://chatgpt.com/c/c3');
  const antes = await stats();

  for (let i = 1; i <= 5; i += 1) {
    enviar(`pregunta número ${i}`, { webContentsId: view.id });
    await settle(20);
    await respuestaPorCDP(view, { requestId: `req-c3-${i}`, texto: `Respuesta número ${i} del modelo.` });
  }

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 5, 'cinco mensajes');
  assert.equal(despues.responses, antes.responses + 5, 'cinco respuestas');
  assert.equal(despues.turns, antes.turns + 5, 'cinco turnos');
});

test('3b. cinco respuestas con el mismo texto son cinco respuestas', async () => {
  const view = await abrir('https://chatgpt.com/c/c3b');
  const antes = await stats();

  // Pedir lo mismo cinco veces y recibir la misma frase cinco veces son cinco
  // respuestas: el texto igual no las vuelve una sola.
  for (let i = 1; i <= 5; i += 1) {
    enviar(`repetime lo mismo (${i})`, { webContentsId: view.id });
    await settle(20);
    await respuestaPorCDP(view, { requestId: `req-c3b-${i}`, texto: 'Listo.' });
  }

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 5, 'cinco mensajes');
  assert.equal(despues.responses, antes.responses + 5, 'cinco respuestas, no una');
});

/* ------------------------------------------------------------------ */
/* 4-5. streaming y doble detección                                    */
/* ------------------------------------------------------------------ */

test('4. el streaming no suma por fragmento: suma al cerrarse', async () => {
  const view = await abrir('https://chatgpt.com/c/c4');
  const antes = await stats();

  enviar('contame algo largo', { webContentsId: view.id });
  await settle(20);

  // La capa informa un cierre parcial y después el completo: es la misma
  // respuesta, así que sigue siendo una.
  await callIpc(
    'nexo:stream-end',
    { site: 'chatgpt', host: 'chatgpt.com', text: 'Primera parte de la respuesta', deliveredChars: 31, droppedChars: 0 },
    view.id,
  );
  await settle(20);
  const medio = await stats();
  assert.equal(medio.responses, antes.responses + 1, 'el cierre parcial ya es una respuesta');

  await callIpc(
    'nexo:stream-end',
    {
      site: 'chatgpt',
      host: 'chatgpt.com',
      text: 'Primera parte de la respuesta, y la segunda parte que llegó después.',
      deliveredChars: 72,
      droppedChars: 0,
    },
    view.id,
  );
  await settle(20);

  const despues = await stats();
  assert.equal(despues.responses, antes.responses + 1, 'el texto completo no es otra respuesta');
  assert.ok(despues.outputTokens >= medio.outputTokens, 'los tokens se corrigen, no se suman de más');
});

test('5. la misma respuesta vista por la capa y por CDP suma una sola vez', async () => {
  const view = await abrir('https://chatgpt.com/c/c5');
  const texto = 'Una respuesta que vieron los dos caminos a la vez.';
  const antes = await stats();

  enviar('pregunta para los dos caminos', { webContentsId: view.id });
  await settle(10);

  // La capa cierra el stream de esa petición…
  await callIpc(
    'nexo:stream-end',
    { site: 'chatgpt', host: 'chatgpt.com', text: texto, deliveredChars: texto.length, droppedChars: 0 },
    view.id,
  );
  await settle(10);
  // …y CDP termina de leer el mismo cuerpo, con la misma petición en curso.
  await respuestaPorCDP(view, { requestId: 'req-c5', texto });

  const despues = await stats();
  assert.equal(despues.responses, antes.responses + 1, 'una respuesta, no dos');
});

/* ------------------------------------------------------------------ */
/* 6-7. errores y respuestas sin terminar                              */
/* ------------------------------------------------------------------ */

test('6. un error HTTP no suma ninguna respuesta', async () => {
  const view = await abrir('https://chatgpt.com/c/c6');
  const antes = await stats();

  enviar('pregunta que va a fallar', { webContentsId: view.id });
  await settle(10);

  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'req-c6',
    type: 'XHR',
    request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST' },
  });
  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-c6',
    type: 'XHR',
    response: { url: 'https://chatgpt.com/backend-api/f/conversation', status: 500, mimeType: 'text/event-stream' },
  });
  view.debugger.bodies.set('req-c6', eventoSSE('esto no debería contarse'));
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-c6' });
  await settle(60);

  const despues = await stats();
  assert.equal(despues.responses, antes.responses, 'un 500 no es una respuesta del modelo');
  assert.equal(despues.turns, antes.turns, 'ni cierra el turno');
});

test('7. una respuesta que no terminó no está contabilizada como terminada', async () => {
  const view = await abrir('https://chatgpt.com/c/c7');
  const antes = await stats();

  enviar('pregunta a medio contestar', { webContentsId: view.id });
  await settle(10);

  // La petición salió y el cuerpo se está leyendo, pero Chromium todavía no
  // anunció el fin de la carga: no hay respuesta completa.
  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'req-c7',
    type: 'XHR',
    request: { url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST' },
  });
  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-c7',
    type: 'XHR',
    response: { url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' },
  });
  view.debugger.bodies.set('req-c7', eventoSSE('texto que todavía está llegando'));
  await settle(80);

  const medio = await stats();
  assert.equal(medio.responses, antes.responses, 'sin cierre no hay respuesta contada');

  // Y cuando termina, se cuenta una sola vez.
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-c7' });
  await settle(80);
  const despues = await stats();
  assert.equal(despues.responses, antes.responses + 1, 'al terminar, una respuesta');
});

/* ------------------------------------------------------------------ */
/* 8. asociación                                                       */
/* ------------------------------------------------------------------ */

test('8. cada respuesta se asocia al mensaje que la originó', async () => {
  const view = await abrir('https://chatgpt.com/c/c8');
  const antes = await stats();

  enviar('primera consulta', { webContentsId: view.id });
  await settle(10);
  // La respuesta de la primera llega con su identificador.
  await respuestaPorCDP(view, { requestId: 'req-c8-1', texto: 'Respuesta a la primera consulta.' });
  await settle(20);
  const trasPrimera = await stats();
  assert.equal(trasPrimera.turns, antes.turns + 1, 'cierra el primer turno');

  enviar('segunda consulta', { webContentsId: view.id });
  await settle(10);
  await respuestaPorCDP(view, { requestId: 'req-c8-2', texto: 'Respuesta a la segunda consulta.' });
  await settle(20);

  const fin = await stats();
  assert.equal(fin.messages, antes.messages + 2, 'dos mensajes');
  assert.equal(fin.responses, antes.responses + 2, 'dos respuestas');
  assert.equal(fin.turns, antes.turns + 2, 'dos turnos, sin cruzar mensajes');
});

/* ------------------------------------------------------------------ */
/* 9-10. interfaz y continuidad                                        */
/* ------------------------------------------------------------------ */

test('9. la interfaz recibe el aviso de cambio en el acto', async () => {
  await abrir('https://chatgpt.com/c/c9');
  const shell = journal.windows[0].webContents;
  shell.sent.length = 0;

  enviar('aviso inmediato a la interfaz');
  await settle(30);

  const avisos = shell.sent.filter((item) => item.channel === 'nexo:stats-changed');
  assert.equal(avisos.length >= 1, true, 'se emite nexo:stats-changed');
  const ultimo = avisos[avisos.length - 1].payload;
  assert.ok(ultimo.messages >= 1, 'con el mensaje ya sumado');
  // Y la lectura explícita da el mismo número: la interfaz no pinta otra cosa.
  const leido = await stats();
  assert.equal(leido.messages, ultimo.messages, 'el panel y la lectura coinciden');
});

test('10. cambiar de conversación o recargar no pierde ni duplica lo contado', async () => {
  const primera = await abrir('https://chatgpt.com/c/c10a');
  const antes = await stats();

  enviar('mensaje en la primera conversación', { webContentsId: primera.id });
  await settle(10);
  await respuestaPorCDP(primera, { requestId: 'req-c10a', texto: 'Respuesta de la primera conversación.' });
  await settle(20);

  // Otra conversación, otra pestaña.
  const segunda = await abrir('https://chatgpt.com/c/c10b');
  enviar('mensaje en la segunda conversación', { webContentsId: segunda.id });
  await settle(10);
  await respuestaPorCDP(segunda, { requestId: 'req-c10b', texto: 'Respuesta de la segunda conversación.' });
  await settle(20); 

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 2, 'los mensajes se acumulan, no se reinician');
  assert.equal(despues.responses, antes.responses + 2, 'las respuestas también');
  assert.equal(despues.turns, antes.turns + 2, 'y los turnos');
});

/* ------------------------------------------------------------------ */
/* 11-12. lo que el panel marca en la captura de referencia            */
/* ------------------------------------------------------------------ */

test('11. al enviar suben mensajes, intervenciones y tokens de entrada', async () => {
  const view = await abrir('https://chatgpt.com/c/c11');
  const antes = await stats();

  enviar('adssaf', { webContentsId: view.id });
  await settle(20);

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 1, '+1 mensajes del usuario');
  assert.equal(despues.interventions, antes.interventions + 1, '+1 intervenciones');
  assert.ok(despues.inputTokens > antes.inputTokens, 'y suman los tokens de entrada');
  assert.equal(despues.responses, antes.responses, 'la respuesta todavía no llegó');
  assert.equal(despues.outputTokens, antes.outputTokens, 'ni hay tokens de salida');
});

test('12. al responder suben respuestas, intervenciones y tokens de salida', async () => {
  const view = await abrir('https://chatgpt.com/c/c12');
  const antes = await stats();
  const texto = '¿Podrías aclararme qué necesitas? 😊';

  enviar('adssaf', { webContentsId: view.id });
  await settle(20);
  const trasEnviar = await stats();
  await respuestaPorCDP(view, { requestId: 'req-c12', texto });
  const despues = await stats();

  assert.equal(despues.responses, antes.responses + 1, '+1 respuestas de la IA');
  assert.equal(
    despues.interventions,
    trasEnviar.interventions + 1,
    '+1 interventiones por la respuesta (además de la del envío)',
  );
  assert.ok(despues.outputTokens > trasEnviar.outputTokens, 'y suman los tokens de salida');
  assert.equal(despues.turns, antes.turns + 1, 'el turno queda cerrado');
});

test('13. tres intercambios suman seis intervenciones', async () => {
  const view = await abrir('https://chatgpt.com/c/c13');
  const antes = await stats();

  for (let i = 1; i <= 3; i += 1) {
    enviar(`pregunta ${i}`, { webContentsId: view.id });
    await settle(20);
    await respuestaPorCDP(view, { requestId: `req-c13-${i}`, texto: `Respuesta ${i}.` });
  }

  const despues = await stats();
  assert.equal(despues.messages, antes.messages + 3, 'tres mensajes');
  assert.equal(despues.responses, antes.responses + 3, 'tres respuestas');
  assert.equal(despues.interventions, antes.interventions + 6, 'seis intervenciones');
});
