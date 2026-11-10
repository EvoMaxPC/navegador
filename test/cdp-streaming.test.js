import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CdpObserver } from '../src/main/cdp.js';
import { FakeWebContents } from './harness/electron-stub.mjs';

const url = 'https://chatgpt.com/backend-api/f/conversation';
const text = '¡Hola! 😊 Respuesta leída únicamente por streaming, sin duplicaciones.';
const sse = (value = text) => `data: ${JSON.stringify({ message: { id: 'answer-1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [value] }, status: 'finished_successfully' } })}\n\ndata: [DONE]\n\n`;
const b64 = (value) => Buffer.from(value).toString('base64');

function harness({ command, engine = {}, allowed = () => true } = {}) {
  const view = new FakeWebContents('webview', 'https://chatgpt.com/c/streaming-test');
  const captures = [], diagnostics = [];
  const observer = new CdpObserver({ engine: { onCdpCapture(_id, capture) { captures.push(capture); }, ...engine },
    contentAllowed: allowed, onDiagnostic: (entry) => diagnostics.push(entry) });
  const original = view.debugger.sendCommand.bind(view.debugger);
  if (command) view.debugger.sendCommand = async (method, params) => command(method, params, original);
  observer.attach(view);
  const event = (method, params) => observer.handleMessage(view.id, `Network.${method}`, params);
  return { view, captures, diagnostics, observer, event,
    async begin(id = 'stream', target = url, method = 'POST') {
      await event('requestWillBeSent', { requestId: id, type: 'Fetch', request: { url: target, method, postData: JSON.stringify({ action: 'next', messages: [{ author: { role: 'user' }, content: { parts: ['hola'] } }] }) } });
      await event('responseReceived', { requestId: id, type: 'Fetch', response: { url: target, status: 200, mimeType: 'text/event-stream' } });
    },
    data: (data, id = 'stream') => event('dataReceived', { requestId: id, data: b64(data) }),
    finish: (id = 'stream') => event('loadingFinished', { requestId: id }),
  };
}

test('streaming recupera texto sin getResponseBody y recompone UTF-8 partido entre eventos', async () => {
  const h = harness(); const bytes = Buffer.from(sse());
  const boundary = bytes.indexOf(Buffer.from('😊')) + 1;
  h.view.debugger.streamBuffered.set('stream', b64(bytes.subarray(0, boundary)));
  h.view.debugger.rejectBodyFor.add('stream');
  await h.begin();
  await h.data(bytes.subarray(boundary, boundary + 2));
  await h.data(bytes.subarray(boundary + 2)); await h.finish();
  assert.equal(h.captures.length, 1); assert.equal(h.captures[0].text, text);
  assert.equal(h.view.debugger.commands.some((c) => c.method === 'Network.getResponseBody'), false);
  await h.finish(); assert.equal(h.captures.length, 1, 'un cierre repetido no vuelve a entregar');
});

test('conserva fragmentos y cierre recibidos antes de resolver la activación; bufferedData va primero', async () => {
  let activate;
  const h = harness({ command: (method, params, original) => method === 'Network.streamResourceContent'
    ? new Promise((resolve) => { activate = resolve; }) : original(method, params) });
  const body = Buffer.from(sse());
  await h.begin(); await h.data(body.subarray(31));
  const finished = h.finish();
  await Promise.resolve(); assert.equal(h.captures.length, 0);
  activate({ bufferedData: b64(body.subarray(0, 31)) }); await finished;
  assert.equal(h.captures.length, 1); assert.equal(h.captures[0].text, text);
});

for (const unavailable of ['unsupported', 'empty', 'invalid-base64', 'byte-limit', 'fragment-limit']) {
  test(`${unavailable}: conserva fallback getResponseBody sin entregar un prefijo incompleto`, async () => {
    const h = harness();
    if (unavailable === 'unsupported') h.view.debugger.failCommand = { method: 'Network.streamResourceContent' };
    h.view.debugger.bodies.set('stream', sse('Respuesta desde el fallback completo.'));
    await h.begin();
    if (unavailable === 'invalid-base64') await h.event('dataReceived', { requestId: 'stream', data: '%%%%' });
    if (unavailable === 'byte-limit') {
      await h.data(sse('Este prefijo no se debe entregar.'));
      await h.data(Buffer.alloc(2_000_001));
    }
    if (unavailable === 'fragment-limit') for (let i = 0; i < 8193; i++) await h.data(' ');
    if (unavailable !== 'empty' && unavailable !== 'unsupported') await h.data(sse('No usar datos posteriores al descarte.'));
    await h.finish();
    assert.equal(h.captures.length, 1); assert.equal(h.captures[0].text, 'Respuesta desde el fallback completo.');
    assert.ok(h.view.debugger.commands.some((c) => c.method === 'Network.getResponseBody'));
  });
}

test('si la activación no responde, el cierre tiene espera acotada y usa el fallback', { timeout: 5000 }, async () => {
  const h = harness({ command: (method, params, original) => method === 'Network.streamResourceContent' ? new Promise(() => {}) : original(method, params) });
  h.view.debugger.bodies.set('stream', sse());
  await h.begin(); await h.finish();
  assert.equal(h.captures[0].text, text);
});

test('respuestas simultáneas se acumulan por requestId y no mezclan sus cuerpos', async () => {
  const h = harness(); await h.begin('a'); await h.begin('b');
  const a = Buffer.from(sse('Primera respuesta.')), b = Buffer.from(sse('Segunda respuesta.'));
  await h.data(a.subarray(0, 40), 'a'); await h.data(b, 'b'); await h.data(a.subarray(40), 'a');
  await h.finish('b'); await h.finish('a');
  assert.deepEqual(h.captures.map((c) => c.text), ['Segunda respuesta.', 'Primera respuesta.']);
});

test('no entrega de nuevo si la capa ya cerró ese envío con texto', async () => {
  const h = harness({ engine: { layerEndedWithTextAfter: () => true } });
  await h.begin(); await h.data(sse()); await h.finish();
  assert.equal(h.captures.length, 0);
  assert.equal(h.view.debugger.commands.some((c) => c.method === 'Network.getResponseBody'), false);
});

test('historial y sitios no autorizados no activan lectura por streaming', async () => {
  const history = harness(); await history.begin('history', 'https://chatgpt.com/backend-api/conversations', 'GET');
  const disabled = harness({ allowed: () => false }); await disabled.begin();
  for (const h of [history, disabled]) assert.equal(h.view.debugger.commands.some((c) => c.method === 'Network.streamResourceContent'), false);
});

for (const termination of ['release', 'detach', 'loadingFailed']) {
  test(`${termination}: una activación tardía no resucita la captura`, async () => {
    let activate;
    const h = harness({ command: (method, params, original) => method === 'Network.streamResourceContent' ? new Promise((resolve) => { activate = resolve; }) : original(method, params) });
    await h.begin(); await h.data(sse());
    if (termination === 'release') h.observer.release(h.view);
    else if (termination === 'detach') h.view.debugger.detach();
    else await h.event('loadingFailed', { requestId: 'stream', canceled: true, errorText: 'net::ERR_ABORTED' });
    activate({ bufferedData: b64(sse()) }); await h.finish();
    assert.equal(h.captures.length, 0);
  });
}

test('SSE externo grabado se recupera sólo desde dataReceived sin cuerpo conservado', async () => {
  const body = readFileSync(new URL('./fixtures/chatgpt-recorded/normal-reply.sse', import.meta.url));
  const h = harness(); h.view.debugger.rejectBodyFor.add('stream'); await h.begin();
  for (let offset = 0; offset < body.length; offset += 37) await h.data(body.subarray(offset, offset + 37));
  await h.finish();
  assert.equal(h.captures.length, 1); assert.ok(h.captures[0].text.length > 20);
  assert.equal(h.captures[0].text.includes('�'), false);
});

test('el presupuesto por pestaña limita a ocho acumuladores; los demás usan fallback', async () => {
  const h = harness();
  for (let i = 0; i < 9; i++) await h.begin(`parallel-${i}`);
  assert.equal(h.view.debugger.commands.filter((c) => c.method === 'Network.streamResourceContent').length, 8);
  h.view.debugger.bodies.set('parallel-8', sse());
  await h.finish('parallel-8');
  assert.equal(h.captures[0].text, text);
  h.observer.release(h.view);
});

test('el interruptor de privacidad descarta el acumulado antes de leer nuevos datos', async () => {
  let enabled = true;
  const h = harness({ allowed: () => enabled });
  await h.begin(); await h.data(sse()); enabled = false;
  await h.data('más datos');
  const pending = h.observer.tabs.get(h.view.id).pending.get('stream');
  assert.equal(pending.streaming.bytes, 0);
  assert.equal(pending.streaming.chunks.length, 0);
  await h.finish(); assert.equal(h.captures.length, 0);
});

test('timeout con fragmentos recibidos: no confunde una cola SSE válida con el cuerpo íntegro', { timeout: 5000 }, async () => {
  let activate;
  const h = harness({ command: (method, params, original) => method === 'Network.streamResourceContent'
    ? new Promise((resolve) => { activate = resolve; }) : original(method, params) });
  const full = 'Respuesta íntegra recuperada desde getResponseBody.';
  h.view.debugger.bodies.set('stream', sse(full));
  await h.begin();
  await h.data(sse('Sólo un fragmento posterior; falta bufferedData.'));
  const stream = h.observer.tabs.get(h.view.id).pending.get('stream').streaming;
  assert.ok(stream.bytes > 0, 'hay datos antes de resolver la activación');
  await h.finish();
  assert.deepEqual(h.captures.map((capture) => capture.text), [full]);
  assert.ok(h.view.debugger.commands.some((command) => command.method === 'Network.getResponseBody'));
  assert.equal(stream.bytes, 0); assert.equal(stream.state.streamCount, 0);
  activate({ bufferedData: b64(sse('Un búfer inicial que llegó demasiado tarde.')) });
  await stream.ready;
  assert.equal(stream.bytes, 0, 'la resolución tardía no repuebla el acumulador');
  assert.equal(h.captures.length, 1, 'no hay segunda entrega');
});

test('si vence la activación y también falla getResponseBody, no inventa una respuesta con la cola SSE', { timeout: 5000 }, async () => {
  const h = harness({ command: (method, params, original) => method === 'Network.streamResourceContent'
    ? new Promise(() => {}) : original(method, params) });
  h.view.debugger.rejectBodyFor.add('stream');
  await h.begin(); await h.data(sse('Fragmento sin garantía de cuerpo completo.')); await h.finish();
  assert.equal(h.captures.length, 0);
  assert.ok(h.diagnostics.some((entry) => entry.code === 'response-sin-cuerpo'));
});

test('dataReceived sin data antes de activar no vuelve a sumar bytes ya presentes en bufferedData', async () => {
  let activate;
  const h = harness({ command: (method, params, original) => method === 'Network.streamResourceContent'
    ? new Promise((resolve) => { activate = resolve; }) : original(method, params) });
  const bytes = Buffer.from(sse()); const cut = 60;
  await h.begin();
  await h.event('dataReceived', { requestId: 'stream', dataLength: cut, encodedDataLength: cut });
  await h.data(bytes.subarray(cut));
  const finished = h.finish();
  activate({ bufferedData: b64(bytes.subarray(0, cut)) }); await finished;
  assert.equal(h.captures.length, 1); assert.equal(h.captures[0].text, text);
  assert.equal(h.view.debugger.commands.some((command) => command.method === 'Network.getResponseBody'), false);
});
