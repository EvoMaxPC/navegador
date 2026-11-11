const contarPalabras = (text) => (String(text || '').match(/[\p{L}\p{N}_]+/gu) || []).length;
/**
 * Tokens de salida: lo que GPT generó, contado una sola vez.
 *
 * El contador de respuestas ya estaba resuelto cuando se escribió esta prueba.
 * Lo que se comprueba acá es que **cada** camino de captura aporte el texto que
 * falta para estimar los tokens, sin sumar una respuesta de más:
 *
 *   · la capa de la página (`stream-end`), con el texto completo;
 *   · CDP, con el cuerpo del SSE y con el canal de actualizaciones;
 *   · CDP cuando Chromium informa el recurso como `Other`;
 *   · la red, que cuenta la respuesta aunque no tenga texto —y no inventa
 *     tokens— y a la que después se le suman los tokens que trae CDP.
 *
 * Se ejecuta el proceso principal de producción contra el Electron falso: lo que
 * se prueba es el cableado real, no una copia paralela.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

// La respuesta contada desde la red espera a que la capa o CDP cuenten primero.
process.env.NEXO_NETRESP_MS = '100';

register('./harness/loader.mjs', import.meta.url);

const { journal } = await import('./harness/electron-stub.mjs');
const { countGptTokens } = await import('../src/main/tokens.js');

await import('../src/main/main.js');

const PARTITION = 'persist:nexo';
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

function callIpc(channel, payload, senderId = 1) {
  const handler = journal.ipcHandlers.get(channel);
  assert.ok(handler, `no hay handler para ${channel}`);
  return handler({ sender: { id: senderId } }, payload);
}

const stats = () => callIpc('nexo:stats');

function progreso(view, messageId, text) {
  const handler = journal.ipcHandlers.get('nexo:stream-progress');
  assert.ok(handler, 'existe el canal de progreso en vivo');
  return handler({
    sender: { id: view.id, getType: () => 'webview' },
  }, {
    messageId,
    site: 'chatgpt',
    host: 'chatgpt.com',
    text,
  });
}

const cuerpoChatGPT = (texto) =>
  JSON.stringify({
    action: 'next',
    model: 'gpt-5',
    messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: [texto] } }],
  });

async function abrir(url) {
  const win = journal.windows[0];
  const view = win.attachWebview(url);
  view.navigateTo(url, 'ChatGPT');
  await settle(60);
  return view;
}

/** El usuario envía: la petición de conversación vista por el proceso principal. */
function enviar(view, texto) {
  const mano = journal.webRequest.before.get(PARTITION);
  assert.ok(mano, 'el vigilante de red está escuchando');
  mano.listener(
    {
      id: `envio-${Math.random().toString(36).slice(2, 8)}`,
      url: 'https://chatgpt.com/backend-api/f/conversation',
      method: 'POST',
      resourceType: 'xhr',
      webContentsId: view.id,
      uploadData: [{ bytes: Buffer.from(cuerpoChatGPT(texto), 'utf8') }],
    },
    () => {},
  );
}

/** El cierre HTTP de la petición, como lo informa Chromium (sin cuerpo leído). */
function completarRed(view, url = 'https://chatgpt.com/backend-api/f/conversation', status = 200) {
  const mano = journal.webRequest.completed.get(PARTITION);
  assert.ok(mano, 'el vigilante mira las peticiones completadas');
  mano.listener({ url, method: 'POST', resourceType: 'xhr', statusCode: status, webContentsId: view.id });
}

/** La capa de la página cierra el stream con el texto completo. */
function capaStreamEnd(view, texto, extra = {}) {
  return callIpc(
    'nexo:stream-end',
    {
      text: texto,
      chars: texto.length,
      tokens: contarPalabras(texto),
      host: 'chatgpt.com',
      site: 'chatgpt',
      url: 'https://chatgpt.com/backend-api/f/conversation',
      ...extra,
    },
    view.id,
  );
}

/** Un cuerpo SSE con el texto del asistente, como lo entrega ChatGPT. */
const sseDe = (texto) =>
  `data: ${JSON.stringify({ message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: [texto] } } })}\n\ndata: [DONE]\n\n`;

/** CDP lee el cuerpo de la respuesta. `tipo` reproduce lo que informa Chromium. */
async function respuestaPorCDP(view, { requestId, texto, tipo = 'Fetch', cuerpo = null, mimeType = 'text/event-stream', beforeFinish = null, url = 'https://chatgpt.com/backend-api/f/conversation' }) {
  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId,
    type: tipo,
    request: { url, method: 'POST' },
  });
  view.debugger.emitEvent('Network.responseReceived', {
    requestId,
    type: tipo,
    response: { url, status: 200, mimeType },
  });
  view.debugger.bodies.set(requestId, cuerpo ?? sseDe(texto));
  if (beforeFinish) await beforeFinish();
  view.debugger.emitEvent('Network.loadingFinished', { requestId });
  await settle(80);
}

/* ------------------------------------------------------------------ */
/* 1. tokens en una respuesta normal                                   */
/* ------------------------------------------------------------------ */

test('1. una respuesta normal suma sus tokens de salida', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-1');
  const antes = await stats();

  enviar(view, '¿cuánto es dos más dos?');
  await settle(20);
  const texto = 'Dos más dos es cuatro. Es una suma directa y no necesita más pasos.';
  capaStreamEnd(view, texto);
  const despues = await stats();

  assert.equal(despues.responses, antes.responses + 1, 'una respuesta');
  assert.equal(despues.outputTokens, antes.outputTokens + contarPalabras(texto), 'con sus tokens de salida');
  assert.ok(contarPalabras(texto) > 0, 'y la estimación no es cero');
});

/* ------------------------------------------------------------------ */
/* 2 y 3. tokens por CDP, incluido el recurso Other                    */
/* ------------------------------------------------------------------ */

test('2. una respuesta capturada por CDP suma sus tokens de salida', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-2');
  const antes = await stats();
  const texto = 'Respuesta leída del cuerpo del SSE por el depurador.';

  enviar(view, 'pregunta que CDP leerá');
  await settle(20);
  await respuestaPorCDP(view, { requestId: 'req-tk2', texto });

  const despues = await stats();
  assert.equal(despues.responses, antes.responses + 1, 'una respuesta');
  assert.equal(despues.outputTokens, antes.outputTokens + contarPalabras(texto), 'con sus tokens');
});

test('3. una respuesta que Chromium informa como Other también suma tokens', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-3');
  const antes = await stats();
  const texto = 'Respuesta que viaja por un recurso Other, leída igual.';

  enviar(view, 'pregunta desde un worker');
  await settle(20);
  await respuestaPorCDP(view, { requestId: 'req-tk3', texto, tipo: 'Other' });

  const despues = await stats();
  assert.equal(despues.responses, antes.responses + 1, 'una respuesta');
  assert.equal(despues.outputTokens, antes.outputTokens + contarPalabras(texto), 'con sus tokens');
});

test('3b. el canal de actualizaciones en JSON por líneas también aporta tokens', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-3b');
  const antes = await stats();
  const texto = 'Actualización por líneas: el texto llega sin prefijo de evento.';

  enviar(view, 'pregunta por el canal de actualizaciones');
  await settle(20);
  const ndjson = [
    JSON.stringify({ message: { author: { role: 'assistant' }, content: { parts: [texto] } } }),
    JSON.stringify({ message: { author: { role: 'assistant' }, content: { parts: [texto] }, status: 'finished_successfully' } }),
  ].join('\n');

  await respuestaPorCDP(view, {
    requestId: 'req-tk3b',
    tipo: 'Fetch',
    cuerpo: ndjson,
    // El canal de respuestas del cliente sin cuenta: no lleva el prompt, sólo
    // las actualizaciones del texto.
    url: 'https://chatgpt.com/backend-api/unauth-mweb/conversation/updates',
  });

  const despues = await stats();
  assert.equal(despues.responses, antes.responses + 1, 'una respuesta');
  assert.equal(despues.outputTokens, antes.outputTokens + contarPalabras(texto), 'con sus tokens, sin contar dos veces el mismo texto');
});

/* ------------------------------------------------------------------ */
/* 4. deduplicación entre capa y CDP                                   */
/* ------------------------------------------------------------------ */

test('4. la misma respuesta por la capa y por CDP suma una vez sus tokens', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-4');
  const antes = await stats();
  const texto = 'La misma respuesta vista por dos caminos distintos.';

  enviar(view, 'pregunta que ven los dos caminos');
  await settle(20);
  capaStreamEnd(view, texto);
  await settle(20);
  await respuestaPorCDP(view, { requestId: 'req-tk4', texto });

  const despues = await stats();
  assert.equal(despues.responses, antes.responses + 1, 'una respuesta, no dos');
  assert.equal(despues.outputTokens, antes.outputTokens + contarPalabras(texto), 'y sus tokens, no el doble');
});

/* ------------------------------------------------------------------ */
/* 5. fragmentos acumulativos                                          */
/* ------------------------------------------------------------------ */

test('5. una respuesta que crece corrige los tokens sin duplicarlos', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-5');
  const antes = await stats();
  const parcial = 'Primera parte de la respuesta.';
  const completo = `${parcial} Segunda parte, más larga, que completa la idea.`;

  enviar(view, 'pregunta con respuesta en dos tramos');
  await settle(20);
  await respuestaPorCDP(view, { requestId: 'req-tk5-a', texto: parcial });
  const trasParcial = await stats();
  assert.equal(trasParcial.responses, antes.responses + 1, 'el primer tramo es la respuesta');
  assert.equal(trasParcial.outputTokens, antes.outputTokens + contarPalabras(parcial), 'con lo que hay hasta ahí');

  await respuestaPorCDP(view, { requestId: 'req-tk5-b', texto: completo });
  const fin = await stats();
  assert.equal(fin.responses, trasParcial.responses, 'el tramo que crece no es otra respuesta');
  assert.equal(fin.outputTokens, antes.outputTokens + contarPalabras(completo), 'los tokens quedan en el texto completo');
});

/* ------------------------------------------------------------------ */
/* 6. sin texto recuperable                                            */
/* ------------------------------------------------------------------ */

test('6. una respuesta sin texto se cuenta y no inventa tokens', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-6');
  const antes = await stats();

  enviar(view, 'pregunta cuyo cuerpo nadie podrá leer');
  await settle(20);
  completarRed(view);
  await settle(200);

  const despues = await stats();
  assert.equal(despues.responses, antes.responses + 1, 'la respuesta se cuenta');
  assert.equal(despues.outputTokens, antes.outputTokens, 'sin tokens inventados');
  assert.equal(despues.turnsPerformed, antes.turnsPerformed + 1, 'interrupción sin confirmación: un turno desconocido');
});

test('6b. si el texto aparece después del cierre de red, se suman sus tokens sin contar otra respuesta', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-6b');
  const antes = await stats();
  const texto = 'El texto llegó un instante después del cierre de la petición.';

  enviar(view, 'pregunta con texto tardío');
  await settle(20);
  // La red cuenta la respuesta sin texto (es lo que pasaba en el caso real)...
  completarRed(view);
  await settle(200);
  const sinTexto = await stats();
  assert.equal(sinTexto.responses, antes.responses + 1, 'la respuesta se cuenta');
  assert.equal(sinTexto.outputTokens, antes.outputTokens, 'sin tokens todavía');

  // ...y CDP consigue el cuerpo un momento más tarde.
  await respuestaPorCDP(view, { requestId: 'req-tk6b', texto });
  const fin = await stats();

  assert.equal(fin.responses, sinTexto.responses, 'no se cuenta una segunda respuesta');
  assert.equal(fin.outputTokens, antes.outputTokens + contarPalabras(texto), 'y los tokens sí se suman');

  const log = await callIpc('nexo:log');
  assert.ok(
    log.some((entry) => entry.code === 'tokens-recuperados'),
    'y el registro dice de dónde salieron esos tokens',
  );
});

/* ------------------------------------------------------------------ */
/* 7. independencia de los otros contadores                            */
/* ------------------------------------------------------------------ */

test('7. los tokens de salida no mueven la entrada, los mensajes ni las respuestas', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-7');
  const antes = await stats();
  const texto = 'Respuesta que sólo debe mover los tokens de salida.';

  enviar(view, 'pregunta de control');
  await settle(20);
  const trasEnviar = await stats();
  await respuestaPorCDP(view, { requestId: 'req-tk7', texto });
  const fin = await stats();

  assert.equal(trasEnviar.inputTokens > antes.inputTokens, true, 'el envío suma entrada');
  assert.equal(fin.inputTokens, trasEnviar.inputTokens, 'la respuesta no toca la entrada');
  assert.equal(fin.messages, trasEnviar.messages, 'ni los mensajes del usuario');
  assert.equal(fin.outputTokens, trasEnviar.outputTokens + contarPalabras(texto), 'sólo los tokens de salida');
});


test('8. CDP primero e inyección después no duplican tokens ni respuestas', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-8');
  const antes = await stats();
  const texto = 'Texto completo que CDP recupera antes que la inyección.';
  enviar(view, 'control de orden inverso');
  await settle(20);
  await respuestaPorCDP(view, { requestId: 'req-tk8', texto });
  capaStreamEnd(view, texto);
  const fin = await stats();
  assert.equal(fin.responses, antes.responses + 1);
  assert.equal(fin.outputTokens, antes.outputTokens + contarPalabras(texto));
});

test('9. un cierre de la inyección sin texto no impide el respaldo CDP', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-9');
  const antes = await stats();
  const texto = 'El respaldo obtiene el texto que faltaba al cerrar el streaming.';
  enviar(view, 'control de cierre vacío');
  await settle(20);
  await respuestaPorCDP(view, {
    requestId: 'req-tk9', texto,
    beforeFinish: async () => { capaStreamEnd(view, ''); await settle(20); },
  });
  const fin = await stats();
  assert.equal(fin.responses, antes.responses + 1);
  assert.equal(fin.outputTokens, antes.outputTokens + contarPalabras(texto));
  assert.equal(fin.inputTokens, antes.inputTokens + countGptTokens('control de cierre vacío','gpt-5'));
});

test('10. CDP recupera texto plano y NDJSON con MIME JSON sin duplicar acumulados', async () => {
  for (const mimeType of ['text/plain', 'application/json']) {
    const view = await abrir('https://chatgpt.com/c/tk-10');
    const antes = await stats();
    const texto = `Respuesta de control para ${mimeType}, tomada del cuerpo real de la prueba.`;
    const cuerpo = mimeType === 'text/plain' ? texto : [texto.slice(0, 20), texto, texto].map(
      (parte) => JSON.stringify({ message: { author: { role: 'assistant' }, content: { parts: [parte] } } }),
    ).join('\n');
    enviar(view, `control de MIME ${mimeType}`);
    await settle(20);
    await respuestaPorCDP(view, { requestId: `req-tk10-${mimeType}`, texto, cuerpo, mimeType });
    const fin = await stats();
    assert.equal(fin.responses, antes.responses + 1);
    assert.equal(fin.outputTokens, antes.outputTokens + contarPalabras(texto));
  }
});


test('11. eventos SSE de control sin texto no producen tokens ficticios', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-11');
  const antes = await stats();
  enviar(view, 'control de stream sin texto');
  await settle(20);
  completarRed(view);
  await settle(200);
  await respuestaPorCDP(view, { requestId: 'req-tk11', cuerpo: ': heartbeat\n\nevent: ping\n\n' });
  const fin = await stats();
  assert.equal(fin.responses, antes.responses + 1);
  assert.equal(fin.outputTokens, antes.outputTokens);
});

test('12. los tokens de salida se actualizan en tiempo real y el cierre no los duplica', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-live');
  const antes = await stats();
  const messageId = 'tk-live-1';
  const parte1 = 'La respuesta empieza en vivo';
  const parte2 = ' y continúa con más contenido hasta terminar correctamente.';

  enviar(view, 'pregunta para captura en vivo');
  await settle(20);

  progreso(view, messageId, parte1);
  const durante1 = await stats();
  assert.equal(durante1.outputTokens, antes.outputTokens + contarPalabras(parte1),
    'el contador suma los tokens mientras llega el primer fragmento');

  progreso(view, messageId, parte2);
  const completo = parte1 + parte2;
  const durante2 = await stats();
  assert.equal(durante2.outputTokens, antes.outputTokens + contarPalabras(completo),
    'el contador se actualiza con el texto acumulado, sin duplicar');

  capaStreamEnd(view, completo, { messageId });
  const final = await stats();
  assert.equal(final.responses, antes.responses + 1, 'el +1 de respuesta se registra al cerrar');
  assert.equal(final.outputTokens, durante2.outputTokens, 'el cierre no vuelve a sumar los tokens ya contados en vivo');
});

test('13. el cierre recortado conserva todo el texto entregado y estima el acumulado entre fragmentos', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-clipped');
  const antes = await stats(), messageId = 'tk-clipped';
  enviar(view, 'prueba de prefijo');
  await settle(20);
  const parts = ['a', 'b', 'c', ' una respuesta completa de control.'];
  let full = '';
  for (const part of parts) {
    full += part;
    progreso(view, messageId, part);
    assert.equal((await stats()).outputTokens, antes.outputTokens + contarPalabras(full));
  }
  capaStreamEnd(view, full.slice(0, 3), { messageId });
  assert.equal((await stats()).outputTokens, antes.outputTokens + contarPalabras(full));
  assert.equal((await stats()).responses, antes.responses + 1);
});

test('14. red primero y texto en vivo después finalizan una sola respuesta', async () => {
  const view = await abrir('https://chatgpt.com/c/tk-network-live');
  const antes = await stats(), messageId = 'tk-network-live';
  enviar(view, 'prueba de orden red');
  await settle(20);
  completarRed(view);
  await settle(200);
  assert.equal((await stats()).responses, antes.responses + 1);
  const text = 'Texto real entregado después de la notificación de red.';
  progreso(view, messageId, text);
  capaStreamEnd(view, text, { messageId });
  const fin = await stats();
  assert.equal(fin.responses, antes.responses + 1);
  assert.equal(fin.outputTokens, antes.outputTokens + contarPalabras(text));
});

test('15. salida aumenta por palabras, no por letras ni por fragmentos, y no se duplica al terminar', async () => {
  const view = await abrir('https://chatgpt.com/c/word-progress');
  const antes = await stats(), messageId = 'word-progress';
  enviar(view, 'prueba de palabras');
  await settle(20);
  const input = (await stats()).inputTokens;
  let text = '';
  for (const [fragment, expected] of [
    ['Ho', 1], ['la', 1], [' ', 1], ['mundo', 2], [' otra', 3], [' palabra', 4],
  ]) {
    text += fragment;
    progreso(view, messageId, fragment);
    const during = await stats();
    assert.equal(during.outputTokens - antes.outputTokens, expected);
    assert.equal(during.inputTokens, input);
    assert.equal(during.responses, antes.responses, 'el progreso no suma respuestas');
  }
  capaStreamEnd(view, text, { messageId });
  assert.equal((await stats()).outputTokens - antes.outputTokens, 4);
  assert.equal((await stats()).responses - antes.responses, 1);
  capaStreamEnd(view, text, { messageId });
  assert.equal((await stats()).outputTokens - antes.outputTokens, 4);
});
