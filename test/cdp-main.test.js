/**
 * Capa CDP dentro del navegador: el cableado de verdad.
 *
 * Ejecuta el proceso principal de producción contra el Electron falso y
 * comprueba lo que sólo se ve en conjunto: que el depurador se adjunte a la
 * pestaña correcta, que lo observado llegue al motor y al libro de
 * intervenciones, que no se duplique nada y que el navegador siga funcionando
 * cuando CDP no está disponible.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

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

const TEXTO =
  'Decidimos registrar el turno observado por CDP tal cual llegó: sin cortarlo y sin cambiar una sola letra de lo que se mostró.';

const PARRAFO =
  'El motor separa el enganche de red del adaptador de interfaz para que el navegador siga funcionando cuando el sitio cambia sus selectores.';

/** Pestaña lista para observar, sin historial de pruebas anterior. */
async function abrirPestana(url = 'https://claude.ai/') {
  await settle();
  const win = journal.windows[0];
  const view = win.attachWebview(url);
  view.navigateTo(url, 'Proveedor');
  return view;
}

/** Entrega un turno completo por WebSocket y espera a que el motor lo procese. */
async function observarTurno(view, { requestId, texto = TEXTO, prompt = 'mi pregunta' }) {
  view.debugger.emitEvent('Network.webSocketCreated', { requestId, url: 'wss://claude.ai/ws' });
  if (prompt) {
    view.debugger.emitEvent('Network.webSocketFrameSent', {
      requestId,
      response: { opcode: 1, payloadData: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }) },
    });
  }
  for (let i = 0; i < texto.length; i += 20) {
    view.debugger.emitEvent('Network.webSocketFrameReceived', {
      requestId,
      response: {
        opcode: 1,
        payloadData: JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: texto.slice(i, i + 20) } }),
      },
    });
  }
  view.debugger.emitEvent('Network.webSocketClosed', { requestId });
  await settle();
}

/* ------------------------------------------------------------------ */
/* arranque                                                           */
/* ------------------------------------------------------------------ */

test('el arranque registra el estado de la capa CDP', async () => {
  await settle();
  const { observer } = await callIpc('nexo:cdp:stats', {});
  assert.equal(observer.enabled, true);
  assert.equal(observer.tabs, 0, 'todavía no hay pestañas');
});

test('una pestaña de un proveedor queda observada al adjuntarse', async () => {
  const view = await abrirPestana('https://claude.ai/chat/cdp-1');
  assert.equal(view.debugger.attached, true, 'el depurador debe quedar adjunto');
  assert.ok(view.debugger.commands.some((command) => command.method === 'Network.enable'));

  const { observer } = await callIpc('nexo:cdp:stats', {});
  assert.ok(observer.tabs >= 1);
  assert.ok(observer.attached >= 1);
});

test('una pestaña que no es de un proveedor no se observa', async () => {
  const win = journal.windows[0];
  const view = win.attachWebview('https://example.com/');
  view.navigateTo('https://example.com/', 'Ejemplo');
  await settle();
  assert.equal(view.debugger.attached, false);
  assert.equal(view.debugger.commands.length, 0, 'no se envió ni un comando CDP');
});

/* ------------------------------------------------------------------ */
/* captura                                                            */
/* ------------------------------------------------------------------ */

test('un turno por WebSocket llega al motor y al libro de intervenciones', async () => {
  const view = await abrirPestana('https://claude.ai/chat/cdp-2');
  const antes = (await callIpc('nexo:log', {})).length;

  await observarTurno(view, { requestId: 'ws-cdp-2' });

  const log = await callIpc('nexo:log', {});
  assert.ok(log.length >= antes, 'el libro sigue en pie');
  const stats = await callIpc('nexo:stats', {});
  assert.ok(stats.cdp.captures >= 1, 'el motor contó la captura');
  assert.ok(stats.cdpObserver.frames >= 1, 'el observador vio los frames');

  // El turno quedó en el historial del guard de esa pestaña: EVO MEMORY lo ve.
  const memoria = await callIpc('nexo:memory:recall', { query: 'CDP turno observado' });
  assert.ok(memoria.length >= 1, 'el turno observado se guardó en EVO MEMORY');
  assert.ok(memoria.some((item) => /CDP/.test(item.text) || /CDP/.test(JSON.stringify(item))));
});

test('una respuesta JSON sin SSE también se captura y se asocia a la pestaña', async () => {
  const view = await abrirPestana('https://chatgpt.com/c/cdp-3');
  const antes = (await callIpc('nexo:cdp:stats', {})).observer.bodies;

  view.debugger.bodies.set(
    'req-cdp-3',
    JSON.stringify({ message: { author: { role: 'assistant' }, content: { parts: [TEXTO] } } }),
  );
  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-cdp-3',
    type: 'XHR',
    response: { url: 'https://chatgpt.com/backend-api/conversation', status: 200, mimeType: 'application/json' },
  });
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-cdp-3' });
  await settle();

  const { observer } = await callIpc('nexo:cdp:stats', {});
  assert.equal(observer.bodies, antes + 1);
  const stats = await callIpc('nexo:stats', {});
  assert.ok(stats.cdp.captures >= 1);
});

test('el mismo turno no se cuenta dos veces', async () => {
  const view = await abrirPestana('https://claude.ai/chat/cdp-4');
  await observarTurno(view, { requestId: 'ws-cdp-4a', prompt: 'pregunta repetida' });
  const primera = await callIpc('nexo:stats', {});

  // El mismo contenido otra vez (socket reabierto, reintento del sitio).
  await observarTurno(view, { requestId: 'ws-cdp-4b', prompt: 'pregunta repetida' });
  const segunda = await callIpc('nexo:stats', {});

  assert.equal(segunda.cdp.captures, primera.cdp.captures, 'el mismo texto se registra una sola vez');
  assert.equal(segunda.cdp.duplicates, primera.cdp.duplicates + 1, 'el motor marcó el duplicado');
});

test('un bucle observado se registra como observación, no como corte', async () => {
  const view = await abrirPestana('https://claude.ai/chat/cdp-5');
  const repeticion = `${PARRAFO}\n\n${PARRAFO}\n\n${PARRAFO}\n\n${PARRAFO}`;

  await observarTurno(view, { requestId: 'ws-cdp-5', texto: repeticion, prompt: 'explicá el motor' });

  const log = await callIpc('nexo:log', {});
  const entrada = log.find((item) => String(item.code || '').startsWith('cdp-'));
  assert.ok(entrada, 'el bucle tiene que quedar en el libro');
  assert.match(entrada.title, /observado/i);
  assert.match(entrada.title, /no se pudo cortar/i);
  assert.match(entrada.detail, /sin intervención/i);
  assert.equal(entrada.savedChars, 0, 'no se ahorró nada: el texto ya se había mostrado');
  assert.equal(entrada.meta.via, 'cdp');
  assert.equal(entrada.meta.observed, true);
});

test('la capa cuenta el envío pero no cierra el stream: CDP igual lee el SSE', async () => {
  const view = await abrirPestana('https://claude.ai/chat/cdp-6');
  // La capa cuenta un envío (no sólo se anuncia) y después se calla: no informa
  // ningún cierre de stream. Si CDP se retirara por «la capa está viva», la
  // respuesta no la contaría nadie. Contar el envío no prueba nada sobre la
  // contestación.
  journal.ipcListeners.get('nexo:event')(
    { sender: { id: view.id, getType: () => 'webview', getURL: () => 'https://claude.ai/chat/cdp-6' } },
    {
      type: 'outgoing',
      payload: {
        messageId: 'm-capa-6',
        source: 'request',
        host: 'claude.ai',
        site: 'claude',
        chars: 12,
        tokens: 4,
        promptHash: 'h-capa-6',
        textFound: true,
      },
    },
  );
  await settle();

  const antes = await callIpc('nexo:stats', {});
  const RESP = 'La respuesta que la capa no capturó y que CDP tiene que rescatar sin contarla dos veces.';
  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'req-cdp-6',
    type: 'XHR',
    request: { url: 'https://claude.ai/api/organizations/org-1/chat_conversations/conv-1/completion', method: 'POST' },
  });
  view.debugger.bodies.set(
    'req-cdp-6',
    `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: RESP } })}\n\n`,
  );
  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-cdp-6',
    type: 'XHR',
    response: { url: 'https://claude.ai/api/organizations/org-1/chat_conversations/conv-1/completion', status: 200, mimeType: 'text/event-stream' },
  });
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-cdp-6' });
  await settle();

  assert.ok(
    view.debugger.commands.some(
      (command) => command.method === 'Network.getResponseBody' && command.params?.requestId === 'req-cdp-6',
    ),
    'se pide el cuerpo del stream: si la capa no lo cerró, es el único camino',
  );
  const despues = await callIpc('nexo:stats', {});
  assert.equal(despues.responses, antes.responses + 1, 'la respuesta se cuenta una sola vez');
});

test('si la capa ya cerró ese stream, CDP no pide su cuerpo', async () => {
  const view = await abrirPestana('https://claude.ai/chat/cdp-7');
  const antes = await callIpc('nexo:stats', {});
  const RESP = 'Respuesta que la capa sí capturó de punta a punta y cerró como stream.';

  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'req-cdp-7',
    type: 'XHR',
    request: { url: 'https://claude.ai/api/organizations/org-1/chat_conversations/conv-1/completion', method: 'POST' },
  });
  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-cdp-7',
    type: 'XHR',
    response: { url: 'https://claude.ai/api/organizations/org-1/chat_conversations/conv-1/completion', status: 200, mimeType: 'text/event-stream' },
  });
  // La capa cierra el stream de esta petición: la respuesta ya está contada.
  await callIpc('nexo:stream-end', {
    site: 'claude',
    host: 'claude.ai',
    stopped: false,
    text: RESP,
    deliveredChars: RESP.length,
    droppedChars: 0,
  }, view.id);
  await settle();

  view.debugger.bodies.set('req-cdp-7', `data: ${JSON.stringify({ delta: { text: RESP } })}\n\n`);
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-cdp-7' });
  await settle();

  assert.ok(
    !view.debugger.commands.some(
      (command) => command.method === 'Network.getResponseBody' && command.params?.requestId === 'req-cdp-7',
    ),
    'no se vuelve a leer un stream que la capa ya cerró',
  );
  const despues = await callIpc('nexo:stats', {});
  assert.equal(despues.responses, antes.responses + 1, 'una respuesta, la de la capa');
});

test('una negativa del modelo queda registrada con su sugerencia', async () => {
  const view = await abrirPestana('https://chatgpt.com/c/cdp-refusal');
  const negativa = 'Lo siento, no puedo ayudar con esa solicitud. Si querés, puedo ayudarte con otro tema.';

  await observarTurno(view, { requestId: 'ws-refusal', texto: negativa, prompt: 'pedido imposible' });

  const log = await callIpc('nexo:log', {});
  const entrada = log.find((item) => item.code === 'cdp-refusal');
  assert.ok(entrada, 'la negativa tiene que quedar en el libro');
  assert.match(entrada.title, /observada/i);
  assert.equal(entrada.meta.via, 'cdp');
  assert.ok(entrada.suggestion, 'se ofrece una reformulación');
});

test('un turno ya contado por el camino HTTP/SSE no se cuenta otra vez por CDP', async () => {
  const view = await abrirPestana('https://claude.ai/chat/cdp-doble');
  const antes = await callIpc('nexo:stats', {});

  // 1) El camino normal: la página terminó un stream y lo informó.
  await callIpc(
    'nexo:stream-end',
    { site: 'claude', host: 'claude.ai', stopped: false, text: TEXTO, deliveredChars: TEXTO.length, droppedChars: 0 },
    view.id,
  );
  await settle();

  // 2) El mismo texto llega además por CDP (cuerpo JSON idéntico).
  view.debugger.bodies.set('req-doble', JSON.stringify({ notification: { content: TEXTO } }));
  view.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-doble',
    type: 'XHR',
    response: { url: 'https://claude.ai/api/organizations/org-1/chat_conversations/conv-1/completion', status: 200, mimeType: 'application/json' },
  });
  view.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-doble' });
  await settle();

  const despues = await callIpc('nexo:stats', {});
  assert.equal(despues.cdp.captures, antes.cdp.captures, 'no se registra de nuevo lo ya contado');
  assert.ok(despues.cdp.duplicates > antes.cdp.duplicates);
});

test('ChatGPT sigue observado para EVO MEMORY aunque la mediación esté apagada', async () => {
  await callIpc('nexo:settings:set', { sites: { chatgpt: { enabled: false } }, memory: { enabled: true } });
  const win = journal.windows[0];
  const view = win.attachWebview('https://chatgpt.com/c/memory-passive');
  view.navigateTo('https://chatgpt.com/c/memory-passive', 'ChatGPT');
  await settle();

  assert.equal(view.debugger.attached, true, 'EVO MEMORY habilitada permite observación pasiva de ChatGPT');
  const config = await callIpc('nexo:config', { host: 'chatgpt.com' });
  assert.equal(config.enabled, false, 'la mediación sigue apagada');
  assert.equal(config.settings.memory.enabled, true, 'la memoria sigue habilitada');

  await callIpc('nexo:settings:set', { sites: { chatgpt: { enabled: true } }, memory: { enabled: true } });
});

test('un sitio apagado en Ajustes no se observa', async () => {
  await callIpc('nexo:settings:set', { sites: { claude: { enabled: false } } });
  const win = journal.windows[0];
  const view = win.attachWebview('https://claude.ai/chat/apagado');
  view.navigateTo('https://claude.ai/chat/apagado', 'Claude');
  await settle();
  assert.equal(view.debugger.attached, false, 'apagar la mediación apaga la observación');

  // Se vuelve a encender para no afectar a las pruebas siguientes.
  await callIpc('nexo:settings:set', { sites: { claude: { enabled: true } } });
  view.navigateTo('https://claude.ai/chat/encendido', 'Claude');
  await settle();
  assert.equal(view.debugger.attached, true);
});

/* ------------------------------------------------------------------ */
/* ciclo de vida                                                      */
/* ------------------------------------------------------------------ */

test('al cambiar de sitio se suelta el depurador y al volver se retoma', async () => {
  const view = await abrirPestana('https://claude.ai/chat/cdp-7');
  assert.equal(view.debugger.attached, true);

  view.startNavigation('https://example.com/');
  view.url = 'https://example.com/';
  assert.equal(view.debugger.attached, false, 'un sitio sin perfil no se observa');

  view.startNavigation('https://chatgpt.com/');
  view.url = 'https://chatgpt.com/';
  assert.equal(view.debugger.attached, true);
});

test('al cerrar la pestaña se suelta el depurador', async () => {
  const view = await abrirPestana('https://claude.ai/chat/cdp-8');
  assert.equal(view.debugger.attached, true);
  view.destroyed = true;
  view.emit('destroyed');
  await settle();
  assert.equal(view.debugger.attached, false);
});

test('si CDP no se puede adjuntar, la pestaña navega igual', async () => {
  const win = journal.windows[0];
  const view = win.attachWebview('https://claude.ai/chat/cdp-9');
  view.debugger.detach();
  view.debugger.failAttach = 'Debugger is already attached to the target';

  view.navigateTo('https://claude.ai/chat/cdp-9b', 'Claude');
  await settle();

  assert.equal(view.debugger.attached, false);
  const { observer } = await callIpc('nexo:cdp:stats', {});
  assert.ok(observer.failed >= 1);
  // La navegación y el historial siguen su curso.
  const recientes = await callIpc('nexo:history:list', { limit: 5 });
  assert.ok(recientes.some((item) => item.url === 'https://claude.ai/chat/cdp-9b'));
});
