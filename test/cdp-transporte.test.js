/**
 * Transporte CDP: adjuntar el depurador, leer los eventos del protocolo y
 * entregar cada turno observado al motor.
 *
 * Se usa el depurador falso del arnés (misma API que
 * `webContents.debugger`) y un motor de mentira que sólo anota lo que recibe,
 * para poder comprobar la entrega sin Electron.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CdpObserver } from '../src/main/cdp.js';
import { FakeDebugger } from './harness/electron-stub.mjs';

const TEXTO =
  'La respuesta observada por WebSocket llega completa, sin cortes y sin duplicados, y se registra como observación.';

/** Deja correr las promesas internas (el cuerpo JSON se pide con await). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function fakeTab(id, url) {
  const listeners = new Map();
  const tab = {
    id,
    url,
    debugger: new FakeDebugger(null),
    getURL: () => tab.url,
    isDestroyed: () => false,
  };
  tab.debugger.on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return tab.debugger;
  };
  tab.debugger.emit = (event, ...args) => {
    for (const fn of listeners.get(event) || []) fn({}, ...args);
    return true;
  };
  tab.debugger.emitEvent = (method, params) => {
    for (const fn of listeners.get('message') || []) fn({}, method, params);
    return tab.debugger;
  };
  return tab;
}

function fakeEngine() {
  const engine = {
    captures: [],
    // Pestañas donde la capa de la página está viva (vacío = ninguna).
    layerSeen: new Map(),
    hasRecentLayer(id) {
      const at = engine.layerSeen.get(id);
      return Boolean(at && Date.now() - at < 180_000);
    },
    // Cuándo cerró la capa un stream: es lo que decide si CDP lo relee.
    layerEnded: new Map(),
    layerEndedAfter(id, sinceMs = 0) {
      const at = engine.layerEnded.get(id);
      return Boolean(at && at >= Number(sinceMs || 0));
    },
    onCdpCapture(tabId, capture) {
      this.captures.push({ tabId, capture });
      return { ok: true, duplicate: false };
    },
  };
  return engine;
}

function makeObserver({ engine = fakeEngine(), enabled = true } = {}) {
  const logs = [];
  const diagnostics = [];
  const observer = new CdpObserver({
    engine,
    enabled,
    log: (message) => logs.push(message),
    onDiagnostic: (diagnostico) => diagnostics.push(diagnostico),
  });
  return { observer, engine, logs, diagnostics };
}

/* ------------------------------------------------------------------ */
/* adjuntar                                                           */
/* ------------------------------------------------------------------ */

test('sólo se adjunta a sitios con perfil conocido', () => {
  const { observer } = makeObserver();
  const cualquiera = fakeTab(1, 'https://example.com/');
  assert.equal(observer.attach(cualquiera), false);
  assert.equal(cualquiera.debugger.attached, false, 'no se toca el depurador de otros sitios');

  const claude = fakeTab(2, 'https://claude.ai/chat/1');
  assert.equal(observer.attach(claude), true);
  assert.equal(claude.debugger.attached, true);
  assert.equal(claude.debugger.attachedVersion, '1.3');
  assert.equal(observer.status().tabs, 1);
});

test('al adjuntar se habilita Network con búferes para pedir cuerpos', () => {
  const { observer } = makeObserver();
  const tab = fakeTab(3, 'https://chatgpt.com/');
  observer.attach(tab);
  const enable = tab.debugger.commands.find((command) => command.method === 'Network.enable');
  assert.ok(enable, 'debe habilitarse el dominio Network');
  assert.ok(enable.params.maxResourceBufferSize >= 1_000_000);
  assert.ok(enable.params.maxTotalBufferSize >= enable.params.maxResourceBufferSize);
});

test('adjuntar dos veces no duplica; soltar libera el depurador', () => {
  const { observer } = makeObserver();
  const tab = fakeTab(4, 'https://chatgpt.com/');
  observer.attach(tab);
  assert.equal(observer.attach(tab), true);
  assert.equal(observer.status().attached, 1);

  assert.equal(observer.release(tab), true);
  assert.equal(tab.debugger.attached, false);
  assert.equal(observer.status().tabs, 0);
  assert.equal(observer.release(tab), false, 'soltar dos veces no rompe');
});

test('si el depurador no se puede adjuntar, el navegador sigue igual', () => {
  const { observer, logs } = makeObserver();
  const tab = fakeTab(5, 'https://claude.ai/');
  tab.debugger.failAttach = 'Debugger is already attached to the target';
  assert.equal(observer.attach(tab), false);
  assert.equal(observer.status().failed, 1);
  assert.match(logs.join(' '), /no se pudo adjuntar/i);
});

test('sin API de depurador el observador queda inerte', () => {
  const { observer } = makeObserver();
  const tab = { id: 6, url: 'https://claude.ai/', getURL: () => 'https://claude.ai/', isDestroyed: () => false };
  assert.equal(observer.attach(tab), false);
  assert.equal(observer.status().failed, 1);
});

test('sync adjunta y suelta según la URL de la pestaña', () => {
  const { observer } = makeObserver();
  const tab = fakeTab(7, 'https://claude.ai/chat/1');
  assert.equal(observer.sync(tab), true);
  assert.equal(tab.debugger.attached, true);

  tab.url = 'https://example.com/';
  assert.equal(observer.sync(tab), false);
  assert.equal(tab.debugger.attached, false);

  tab.url = 'https://chatgpt.com/';
  assert.equal(observer.sync(tab), true);
  assert.equal(tab.debugger.attached, true);
});

test('un sitio que el usuario apagó no se observa', () => {
  const observer = new CdpObserver({ contentAllowed: (host) => host !== 'claude.ai' });
  const claude = fakeTab(30, 'https://claude.ai/');
  assert.equal(observer.attach(claude), false);
  assert.equal(claude.debugger.attached, false);

  const chatgpt = fakeTab(31, 'https://chatgpt.com/');
  assert.equal(observer.attach(chatgpt), true);
});

test('con la observación apagada no se adjunta nada', () => {
  const { observer } = makeObserver({ enabled: false });
  const tab = fakeTab(8, 'https://claude.ai/');
  assert.equal(observer.attach(tab), false);
  assert.equal(tab.debugger.attached, false);
});

/* ------------------------------------------------------------------ */
/* frames de WebSocket                                                */
/* ------------------------------------------------------------------ */

test('frames recibidos: el turno se entrega completo y atado a pestaña y conversación', () => {
  const { observer, engine } = makeObserver();
  const tab = fakeTab(10, 'https://chatgpt.com/c/abc');
  observer.attach(tab);

  tab.debugger.emitEvent('Network.webSocketCreated', {
    requestId: 'ws-1',
    url: 'wss://chatgpt.com/backend-api/ws',
  });
  tab.debugger.emitEvent('Network.webSocketFrameSent', {
    requestId: 'ws-1',
    response: {
      opcode: 1,
      payloadData: JSON.stringify({ messages: [{ role: 'user', content: 'mi pregunta' }] }),
    },
  });
  for (let i = 0; i < TEXTO.length; i += 13) {
    tab.debugger.emitEvent('Network.webSocketFrameReceived', {
      requestId: 'ws-1',
      response: { opcode: 1, payloadData: JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: TEXTO.slice(i, i + 13) }) },
    });
  }
  assert.equal(engine.captures.length, 0, 'todavía no cerró el turno');

  tab.debugger.emitEvent('Network.webSocketClosed', { requestId: 'ws-1' });

  assert.equal(engine.captures.length, 1);
  const { tabId, capture } = engine.captures[0];
  assert.equal(tabId, 10, 'la captura queda atada a su pestaña');
  assert.equal(capture.text, TEXTO);
  assert.equal(capture.prompt, 'mi pregunta');
  assert.equal(capture.site, 'chatgpt');
  assert.equal(capture.host, 'chatgpt.com');
  assert.equal(capture.source, 'websocket');
  assert.match(capture.conversationId, /^chatgpt#10#ws-1$/, 'identifica conversación y socket');
  assert.equal(capture.seq, 1);
});

test('un frame de cierre entrega el turno sin esperar a que se cierre el socket', () => {
  const { observer, engine } = makeObserver();
  const tab = fakeTab(11, 'https://claude.ai/');
  observer.attach(tab);
  tab.debugger.emitEvent('Network.webSocketCreated', { requestId: 'ws-2', url: 'wss://claude.ai/ws' });

  tab.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-2',
    response: { opcode: 1, payloadData: JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'uno' } }) },
  });
  tab.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-2',
    response: { opcode: 1, payloadData: JSON.stringify({ type: 'message_stop' }) },
  });

  assert.equal(engine.captures.length, 1);
  assert.equal(engine.captures[0].capture.text, 'uno');

  // El turno siguiente del mismo socket empieza de cero y se numera.
  tab.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-2',
    response: { opcode: 1, payloadData: JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'dos' } }) },
  });
  tab.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-2',
    response: { opcode: 1, payloadData: JSON.stringify({ type: 'message_stop' }) },
  });
  assert.equal(engine.captures.length, 2);
  assert.equal(engine.captures[1].capture.text, 'dos');
  assert.equal(engine.captures[1].capture.seq, 2);
});

test('sockets de otros hosts, frames binarios y JSON roto se ignoran', () => {
  const { observer, engine } = makeObserver();
  const tab = fakeTab(12, 'https://chatgpt.com/');
  observer.attach(tab);

  tab.debugger.emitEvent('Network.webSocketCreated', { requestId: 'ws-x', url: 'wss://ejemplo.com/socket' });
  tab.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-x',
    response: { opcode: 1, payloadData: JSON.stringify({ type: 'content', content: 'no debería verse' }) },
  });
  tab.debugger.emitEvent('Network.webSocketClosed', { requestId: 'ws-x' });
  assert.equal(engine.captures.length, 0, 'un socket ajeno no se registra');

  tab.debugger.emitEvent('Network.webSocketCreated', { requestId: 'ws-3', url: 'wss://chatgpt.com/ws' });
  tab.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-3',
    response: { opcode: 2, payloadData: 'AAECAw==' },
  });
  tab.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-3',
    response: { opcode: 1, payloadData: 'esto no es json' },
  });
  tab.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-3',
    response: { opcode: 1, payloadData: '{"type":"delta","content":"' },
  });
  tab.debugger.emitEvent('Network.webSocketClosed', { requestId: 'ws-3' });
  assert.equal(engine.captures.length, 0);
  assert.ok(observer.status().ignored >= 3);
});

/* ------------------------------------------------------------------ */
/* respuestas JSON                                                    */
/* ------------------------------------------------------------------ */

test('respuesta JSON sin SSE: se pide el cuerpo y se entrega como captura', async () => {
  const { observer, engine } = makeObserver();
  const tab = fakeTab(13, 'https://chatgpt.com/c/1');
  observer.attach(tab);

  tab.debugger.bodies.set(
    'req-1',
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: TEXTO }, finish_reason: 'stop' }] }),
  );
  tab.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-1',
    type: 'XHR',
    response: { url: 'https://chatgpt.com/backend-api/conversation', status: 200, mimeType: 'application/json' },
  });
  tab.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-1' });
  await settle();

  assert.equal(engine.captures.length, 1);
  const { capture } = engine.captures[0];
  assert.equal(capture.text, TEXTO);
  assert.equal(capture.source, 'json');
  assert.equal(capture.conversationId, 'chatgpt#13#req-1');
  assert.ok(
    tab.debugger.commands.some((command) => command.method === 'Network.getResponseBody'),
    'el cuerpo se pide al depurador',
  );
});

test('la capa cuenta el envío pero no cierra el stream: CDP lo lee igual', async () => {
  const { observer, engine } = makeObserver();
  const tab = fakeTab(14, 'https://claude.ai/');
  observer.attach(tab);
  // La capa cuenta un envío y después se calla. Que la capa esté viva no dice
  // nada de la contestación: si CDP se retirara, la respuesta no la contaría
  // nadie.
  engine.layerSeen = new Map([[tab.id, Date.now()]]);

  tab.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'req-2',
    type: 'XHR',
    request: { url: 'https://claude.ai/api/organizations/org-1/chat_conversations/conv-1/completion', method: 'POST' },
  });
  tab.debugger.bodies.set('req-2', 'data: {"type":"content_block_delta"}\n\n');
  tab.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-2',
    type: 'XHR',
    response: { url: 'https://claude.ai/api/organizations/org-1/chat_conversations/conv-1/completion', status: 200, mimeType: 'text/event-stream' },
  });
  tab.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-2' });
  await settle();

  assert.ok(
    tab.debugger.commands.some((command) => command.method === 'Network.getResponseBody'),
    'se pide el cuerpo: la capa no cerró ese stream',
  );
});

test('si la capa ya cerró ese stream, CDP no lo vuelve a leer', async () => {
  const { observer, engine } = makeObserver();
  const tab = fakeTab(16, 'https://claude.ai/');
  observer.attach(tab);

  tab.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'req-capa',
    type: 'XHR',
    request: { url: 'https://claude.ai/api/organizations/org-1/chat_conversations/conv-1/completion', method: 'POST' },
  });
  tab.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-capa',
    type: 'XHR',
    response: { url: 'https://claude.ai/api/organizations/org-1/chat_conversations/conv-1/completion', status: 200, mimeType: 'text/event-stream' },
  });
  // La capa cerró el stream de esta petición: la respuesta ya está contada.
  engine.layerEnded = new Map([[tab.id, Date.now()]]);
  tab.debugger.bodies.set('req-capa', 'data: {"delta":{"text":"ya contada"}}\n\n');
  tab.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-capa' });
  await settle();

  assert.equal(engine.captures.length, 0, 'no se captura dos veces el mismo stream');
  assert.ok(!tab.debugger.commands.some((command) => command.method === 'Network.getResponseBody'));
});

test('lo que no es JSON, no es XHR o no es de un proveedor se descarta', async () => {
  const { observer, engine } = makeObserver();
  const tab = fakeTab(15, 'https://chatgpt.com/');
  observer.attach(tab);

  const casos = [
    { requestId: 'a', type: 'Document', response: { url: 'https://chatgpt.com/', status: 200, mimeType: 'application/json' } },
    { requestId: 'b', type: 'XHR', response: { url: 'https://chatgpt.com/x', status: 200, mimeType: 'text/html' } },
    { requestId: 'c', type: 'XHR', response: { url: 'https://otro-sitio.com/x', status: 200, mimeType: 'application/json' } },
    { requestId: 'd', type: 'XHR', response: { url: 'https://chatgpt.com/x', status: 500, mimeType: 'application/json' } },
  ];
  for (const caso of casos) {
    tab.debugger.bodies.set(caso.requestId, '{"content":"no"}');
    tab.debugger.emitEvent('Network.responseReceived', caso);
    tab.debugger.emitEvent('Network.loadingFinished', { requestId: caso.requestId });
  }
  await settle();
  assert.equal(engine.captures.length, 0);
});

test('si el cuerpo ya no está en el búfer, no se entrega nada ni se rompe', async () => {
  const { observer, engine, logs } = makeObserver();
  const tab = fakeTab(16, 'https://chatgpt.com/');
  observer.attach(tab);

  tab.debugger.rejectBodyFor.add('req-3');
  tab.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-3',
    type: 'Fetch',
    response: { url: 'https://chatgpt.com/backend-api/conversation', status: 200, mimeType: 'application/json' },
  });
  tab.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-3' });
  await settle();

  assert.equal(engine.captures.length, 0);
  assert.match(logs.join(' '), /cuerpo no disponible/i);
});

test('un cuerpo en base64 se decodifica en vez de descartarse', async () => {
  const { observer, engine, diagnostics } = makeObserver();
  const tab = fakeTab(17, 'https://chatgpt.com/');
  observer.attach(tab);
  // Chromium entrega en base64 los cuerpos que no son texto plano; un SSE puede
  // llegar así. Antes se descartaba en silencio y la respuesta no la contaba
  // nadie.
  const sse = 'data: {"message":{"author":{"role":"assistant"},"content":{"parts":["hola desde base64"]}}}\n\n';
  tab.debugger.bodies.set('req-4', { body: Buffer.from(sse).toString('base64'), base64Encoded: true });
  tab.debugger.emitEvent('Network.responseWillBeSent', {});
  tab.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'req-4',
    type: 'XHR',
    request: { url: 'https://chatgpt.com/backend-api/conversation', method: 'POST' },
  });
  tab.debugger.emitEvent('Network.responseReceived', {
    requestId: 'req-4',
    type: 'XHR',
    response: { url: 'https://chatgpt.com/backend-api/conversation', status: 200, mimeType: 'text/event-stream' },
  });
  tab.debugger.emitEvent('Network.loadingFinished', { requestId: 'req-4' });
  await settle();

  assert.equal(engine.captures.length, 1, 'la respuesta se cuenta');
  assert.match(engine.captures[0].capture.text, /hola desde base64/, 'con su texto decodificado');
  assert.ok(
    diagnostics.some((item) => item.code === 'response-base64'),
    'y queda dicho que llegó codificada',
  );
});

/* ------------------------------------------------------------------ */
/* robustez                                                           */
/* ------------------------------------------------------------------ */

test('un motor que falla no tumba la observación', () => {
  const logs = [];
  const observer = new CdpObserver({
    engine: {
      onCdpCapture() {
        throw new Error('motor roto');
      },
    },
    log: (message) => logs.push(message),
  });
  const tab = fakeTab(18, 'https://chatgpt.com/');
  observer.attach(tab);
  tab.debugger.emitEvent('Network.webSocketCreated', { requestId: 'ws-9', url: 'wss://chatgpt.com/ws' });
  tab.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-9',
    response: { opcode: 1, payloadData: JSON.stringify({ type: 'delta', content: 'hola' }) },
  });
  tab.debugger.emitEvent('Network.webSocketClosed', { requestId: 'ws-9' });
  assert.match(logs.join(' '), /al entregar al motor/i);
});

test('soltar la pestaña entrega lo pendiente antes de desconectar', () => {
  const { observer, engine } = makeObserver();
  const tab = fakeTab(19, 'https://claude.ai/');
  observer.attach(tab);
  tab.debugger.emitEvent('Network.webSocketCreated', { requestId: 'ws-10', url: 'wss://claude.ai/ws' });
  tab.debugger.emitEvent('Network.webSocketFrameReceived', {
    requestId: 'ws-10',
    response: { opcode: 1, payloadData: JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'sin cerrar' } }) },
  });
  observer.release(tab);
  assert.equal(engine.captures.length, 1);
  assert.equal(engine.captures[0].capture.text, 'sin cerrar');
  assert.equal(engine.captures[0].capture.closedBy, 'release');
  assert.equal(tab.debugger.attached, false);
});

/* ------------------------------------------------------------------ */
/* fallos de red                                                      */
/* ------------------------------------------------------------------ */

function fakeEngineConFallos() {
  const engine = {
    fallos: [],
    captures: [],
    // Pestañas donde la capa de la página está viva (vacío = ninguna).
    layerSeen: new Map(),
    hasRecentLayer(id) {
      const at = engine.layerSeen.get(id);
      return Boolean(at && Date.now() - at < 180_000);
    },
    // Cuándo cerró la capa un stream: es lo que decide si CDP lo relee.
    layerEnded: new Map(),
    layerEndedAfter(id, sinceMs = 0) {
      const at = engine.layerEnded.get(id);
      return Boolean(at && at >= Number(sinceMs || 0));
    },
    onCdpCapture(tabId, capture) {
      engine.captures.push({ tabId, capture });
      return { ok: true, duplicate: false };
    },
    onCdpFailure(_tabId, failure) {
      engine.fallos.push(failure);
    },
  };
  return engine;
}

test('un 403 del proveedor se informa como fallo HTTP, una sola vez', () => {
  const engine = fakeEngineConFallos();
  const { observer } = makeObserver({ engine });
  const tab = fakeTab(40, 'https://chatgpt.com/');
  observer.attach(tab);

  const response = {
    url: 'https://chatgpt.com/backend-api/conversation',
    status: 403,
    mimeType: 'application/json',
  };
  tab.debugger.emitEvent('Network.responseReceived', { requestId: 'r1', type: 'Fetch', response });
  tab.debugger.emitEvent('Network.responseReceived', { requestId: 'r1', type: 'Fetch', response });

  assert.equal(engine.fallos.length, 1, 'el mismo fallo no se repite');
  assert.equal(engine.fallos[0].kind, 'http');
  assert.equal(engine.fallos[0].status, 403);
  assert.equal(engine.fallos[0].host, 'chatgpt.com');
  assert.equal(engine.fallos[0].site, 'chatgpt');
  assert.equal(engine.fallos[0].resourceType, 'Fetch');
  assert.equal(observer.status().failures, 1);
});

test('una carga abortada por el sitio no se informa; un fallo real sí', () => {
  const engine = fakeEngineConFallos();
  const { observer } = makeObserver({ engine });
  const tab = fakeTab(41, 'https://claude.ai/');
  observer.attach(tab);

  tab.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'r2',
    type: 'Fetch',
    request: { url: 'https://claude.ai/api/organizations/abc/chat_conversations/xyz/completion' },
  });
  tab.debugger.emitEvent('Network.loadingFailed', { requestId: 'r2', canceled: true, errorText: 'net::ERR_ABORTED' });
  assert.equal(engine.fallos.length, 0, 'un aborto normal no es un fallo');

  tab.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'r3',
    type: 'Fetch',
    request: { url: 'https://claude.ai/api/organizations/abc/chat_conversations/xyz/completion' },
  });
  tab.debugger.emitEvent('Network.loadingFailed', {
    requestId: 'r3',
    errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    blockedReason: 'inspector',
  });
  assert.equal(engine.fallos.length, 1);
  assert.equal(engine.fallos[0].kind, 'net');
  assert.equal(engine.fallos[0].errorText, 'net::ERR_BLOCKED_BY_CLIENT');
  assert.equal(engine.fallos[0].blockedReason, 'inspector');
});
