import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { register, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseSSE } from '../src/core/sse.js';
import { CdpCapture } from '../src/core/cdp.js';
import { detectSite } from '../src/core/sites.js';
import { createStreamFilter } from '../src/core/streamFilter.js';
import { countGptTokens, countOutputTokens } from '../src/main/tokens.js';
import { estimateTokens } from '../src/core/text.js';

process.env.NEXO_NETRESP_MS = '50';
register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');
const pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = (name) => readFileSync(new URL(`./fixtures/chatgpt-recorded/${name}`, import.meta.url), 'utf8');
const normal = 'Test successful! ✅ I’m here and ready to help.';
const anonymous = 'xxxxx! 😊 xxx xxx xxx xxxxx xxxxx? xxxx xxx x xxxx xxx xxxx?';
const stats = () => journal.ipcHandlers.get('nexo:stats')({ sender: { id: 1 } });
const records = (body, ndjson) => ndjson ? body.trim().split('\n').map(JSON.parse)
  : parseSSE(body).events.flatMap((event) => { try { return [JSON.parse(event.data)]; } catch { return []; } });

// Oráculo independiente para el fixture Thinking: sólo las operaciones del
// mensaje fusionado visible (canal 9), nunca las copias ocultas c=8/10/16.
function visibleChannelText(body, visibleChannel) {
  let channel, pointer = '', operation = 'add', text = '';
  for (const row of records(body)) {
    channel = row.c ?? channel;
    if (channel !== visibleChannel) continue;
    if (row.p !== undefined) pointer = row.p;
    if (row.o !== undefined) operation = row.o;
    if (row.v?.message?.content?.parts) text = row.v.message.content.parts.join('');
    const operations = Array.isArray(row.v) ? row.v : [{ ...row, p: row.p ?? pointer, o: row.o ?? operation }];
    for (const op of operations) {
      if (op.p === '/message/content/parts/0' && typeof op.v === 'string') {
        text = op.o === 'append' ? text + op.v : op.v;
      }
    }
  }
  return text;
}
function thinkingExpected() {
  const text = visibleChannelText(fixture('thinking-reply.sse'), 9);
  assert.ok(text.length > 7000);
  assert.match(text, /\n\n/);
  assert.match(text, /##/);
  return text;
}

// Ejecuta las funciones reales de la shell y su suscripción IPC sobre elementos
// mínimos. Es integración con DOM simulado, NO una prueba visual en Chromium.
const appSource = readFileSync(new URL('../src/ui/shell/app.js', import.meta.url), 'utf8');
const elements = Object.fromEntries(['messages', 'responses', 'turns', 'inTokens', 'outTokens', 'interventions', 'loopsSeen', 'loops', 'capture'].map((key) => [key, { textContent: '0' }]));
let refreshFromIpc;
const ui = vm.createContext({
  nexo: { getStats: stats, on: (_channel, listener) => { refreshFromIpc = listener; } },
  els: { stats: elements },
});
vm.runInContext(appSource.slice(appSource.indexOf('function num(value)'), appSource.indexOf('const MEM =')), ui);
vm.runInContext(appSource.match(/nexo\.on\?\.\('nexo:stats-changed',[\s\S]*?\n\}\);/)[0], ui);
journal.windows[0].webContents.on('sent', ({ channel }) => {
  if (channel === 'nexo:stats-changed') refreshFromIpc();
});

async function openTab() {
  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/output-circuit');
  view.navigateTo('https://chatgpt.com/c/output-circuit', 'ChatGPT');
  await pause(55);
  return view;
}

// Capa de producción + preload real + IPC real del principal, sin copiar su
// extracción/tokenización. Sólo se sustituye el transporte externo por replay.
function pageFor(view, body, { mime = 'text/event-stream', chunkSize = 37, abort = false, beforeResponse = null } = {}) {
  const listeners = [];
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  const page = {
    location: { href: 'https://chatgpt.com/c/output-circuit', hostname: 'chatgpt.com', pathname: '/c/output-circuit', protocol: 'https:' },
    addEventListener: (name, listener) => { if (name === 'message') listeners.push(listener); },
    postMessage(data) { queueMicrotask(() => { for (const listener of listeners) listener({ source: page, data }); }); },
    fetch: async () => {
      if (beforeResponse) await beforeResponse();
      return new Response(new ReadableStream({
      pull(controller) {
        if (offset < bytes.length) { controller.enqueue(bytes.slice(offset, offset += chunkSize)); return; }
        if (abort) controller.error(new DOMException('Detenido por el usuario', 'AbortError'));
        else controller.close();
      },
    }), { headers: { 'content-type': mime } });
    },
  };
  const document = { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const context = vm.createContext({ window: page, location: page.location, document, console,
    setTimeout, clearTimeout, TextEncoder, TextDecoder, ReadableStream, WritableStream, TransformStream, Response, Headers, Request, URL });
  const requireBridge = createRequire(new URL('../src/preload/bridge.cjs', import.meta.url));
  const sender = { id: view.id, getURL: () => page.location.href, getType: () => 'webview' };
  const ipcRenderer = {
    on() {},
    sendSync: () => ({ host: 'chatgpt.com', enabled: true, settings: { receiving: { stopOnLoop: false } }, language: 'es' }),
    invoke: async (channel, payload) => journal.ipcHandlers.get(channel)?.({ sender }, payload),
    send: (channel, payload) => journal.ipcListeners.get(channel)?.({ sender }, payload),
  };
  const preload = vm.createContext({ window: page, location: page.location, console,
    __dirname: fileURLToPath(new URL('../src/preload/', import.meta.url)),
    require: (name) => name === 'electron' ? { ipcRenderer, webFrame: {
      executeJavaScript: async (code) => vm.runInContext(code, context),
    } } : requireBridge(name),
  });
  vm.runInContext(readFileSync(new URL('../src/preload/bridge.cjs', import.meta.url), 'utf8'), preload);
  return page;
}

async function replayPrimary(view, body, options = {}) {
  const page = pageFor(view, body, options);
  const response = await page.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ action: 'next', model: 'gpt-6', messages: [{ author: { role: 'user' }, content: { parts: ['Test'] } }] }) });
  let wire = '';
  try { wire = await response.text(); } catch (error) { if (!options.abort) throw error; }
  await pause(50);
  return wire;
}

async function replayCdp(view, body, mime = 'text/event-stream', type = 'Fetch') {
  const requestId = `replay-${view.id}-${Math.random()}`;
  const url = mime.includes('ndjson') ? 'https://chatgpt.com/unauth-mweb/conversation/updates' : 'https://chatgpt.com/backend-api/f/conversation';
  view.debugger.emitEvent('Network.requestWillBeSent', { requestId, type, request: { url, method: 'POST' } });
  view.debugger.emitEvent('Network.responseReceived', { requestId, type, response: { url, status: 200, mimeType: mime } });
  view.debugger.bodies.set(requestId, body);
  view.debugger.emitEvent('Network.loadingFinished', { requestId });
  await pause(70);
}

for (const [name, expected, options] of [
  ['normal-reply.sse', normal, {}],
  ['regenerate.sse', 'xxxx xxxxxxxxxx! ✅ x’x xxxx xxx xxxxx xx xxxx.', {}],
  ['thinking-reply.sse', thinkingExpected(), {}],
  ['logged-out-reply.ndjson', anonymous, { mime: 'application/x-ndjson', chunkSize: 1 }],
  ['logged-out-reply.ndjson', anonymous, { mime: 'text/plain', chunkSize: 1 }],
]) {
  test(`grabación ${name} (${options.mime || 'SSE'}): inyección → preload → BPE → principal → campo de salida`, async () => {
    const view = await openTab();
    const before = await stats();
    const body = fixture(name);
    const wire = await replayPrimary(view, body, options);
    const after = await stats();
    assert.equal(after.responses, before.responses + 1);
    assert.equal(after.outputTokens, before.outputTokens + countGptTokens(expected));
    assert.equal(elements.outTokens.textContent, after.outputTokens.toLocaleString('es-AR'), 'sin refresco manual');
    assert.equal(after.inputTokens, before.inputTokens + countGptTokens('Test'));
    if (options.mime) assert.equal(wire, body, 'NDJSON conserva sus bytes, incluidos Unicode y saltos');
    else {
      const visible = records(body).find((row) => row.v?.message?.author?.role === 'assistant' &&
        !row.v.message.metadata?.is_message_fragment && row.v.message.content?.content_type === 'text');
      assert.equal(visibleChannelText(wire, visible.c), expected, 'el cliente SSE recibe el texto correcto, no sólo el contador');
    }
    await replayCdp(view, body, options.mime || 'text/event-stream', options.mime ? 'Other' : 'Fetch');
    assert.equal((await stats()).outputTokens, after.outputTokens, 'CDP no duplica la captura principal');
    assert.equal((await stats()).responses, after.responses);
  });
}

test('CDP recupera NDJSON grabado después del cierre de red y notifica el campo visible', async () => {
  const view = await openTab();
  const sender = { id: view.id, getURL: () => 'https://chatgpt.com/', getType: () => 'webview' };
  journal.ipcListeners.get('nexo:event')({ sender }, { type: 'outgoing', payload: { host: 'chatgpt.com', messageId: 'late-cdp', chars: 4, tokens: 1 } });
  journal.webRequest.completed.get('persist:nexo').listener({ url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST', resourceType: 'xhr', statusCode: 200, webContentsId: view.id });
  await pause(160);
  const before = await stats();
  const count = journal.windows[0].webContents.sent.filter((event) => event.channel === 'nexo:stats-changed').length;
  await replayCdp(view, fixture('logged-out-reply.ndjson'), 'application/x-ndjson', 'Other');
  const after = await stats();
  assert.equal(after.outputTokens, before.outputTokens + countGptTokens(anonymous));
  assert.equal(after.responses, before.responses);
  assert.equal(after.inputTokens, before.inputTokens);
  assert.equal(after.messages, before.messages);
  assert.ok(journal.windows[0].webContents.sent.filter((event) => event.channel === 'nexo:stats-changed').length > count);
  assert.equal(elements.outTokens.textContent, after.outputTokens.toLocaleString('es-AR'));
  await replayCdp(view, fixture('logged-out-reply.ndjson'), 'application/x-ndjson');
  assert.equal((await stats()).outputTokens, after.outputTokens);
});

for (const name of ['aborted.sse', 'logged-out-stopped.ndjson']) {
  test(`grabación interrumpida ${name}: conserva texto, tokens y actualización automática`, async () => {
    const body = fixture(name);
    const ndjson = name.endsWith('ndjson');
    const reference = new CdpCapture({ site: detectSite('chatgpt.com'), host: 'chatgpt.com' });
    for (const row of records(body, ndjson)) reference.add(row);
    const captured = reference.take();
    assert.ok(captured.text.length > 50);
    const view = await openTab();
    const before = await stats();
    await replayPrimary(view, body, { abort: true, mime: ndjson ? 'application/x-ndjson' : 'text/event-stream' });
    const after = await stats();
    assert.equal(after.outputTokens, before.outputTokens + countGptTokens(captured.text));
    assert.equal(after.responses, before.responses + 1);
    assert.equal(elements.outTokens.textContent, after.outputTokens.toLocaleString('es-AR'));
    const log = journal.ipcHandlers.get('nexo:log')({ sender: { id: 1 } });
    assert.equal(log.find((entry) => entry.code === 'incoming').meta.truncated, true);
  });
}

test('SSE sin respuesta no convierte tokens de reanudación ni estados en texto', async () => {
  const view = await openTab();
  const before = await stats();
  const body = 'data: {"type":"resume_conversation_token","token":"NO_ES_TEXTO"}\n\ndata: {"type":"message_stream_complete"}\n\ndata: [DONE]\n\n';
  await replayPrimary(view, body);
  const after = await stats();
  assert.equal(after.outputTokens, before.outputTokens);
  assert.equal(after.responses, before.responses + 1);
});

test('fallo BPE en salida: estima texto real, registra el fallo y no altera la entrada', async () => {
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const load = Module._load;
  const view = await openTab();
  const before = await stats();
  const text = 'Respuesta real con Markdown.\n\n**Conservá el texto aunque falle el BPE.**';
  Module._load = function (id, ...args) {
    if (id === 'gpt-tokenizer') return { countTokens() { throw new Error('fallo BPE inducido'); } };
    return load.call(this, id, ...args);
  };
  try {
    journal.ipcHandlers.get('nexo:stream-end')({ sender: { id: view.id } }, { host: 'chatgpt.com', model: 'gpt-6', text, chars: text.length, tokens: 0 });
  } finally { Module._load = load; }
  await pause();
  const after = await stats();
  assert.equal(after.outputTokens, before.outputTokens + estimateTokens(text));
  assert.equal(after.responses, before.responses + 1);
  assert.equal(after.inputTokens, before.inputTokens);
  assert.equal(elements.outTokens.textContent, after.outputTokens.toLocaleString('es-AR'));
  const log = journal.ipcHandlers.get('nexo:log')({ sender: { id: 1 } });
  assert.ok(log.some((entry) => entry.code === 'output-tokenizer-fallback' && entry.meta.method === 'estimateTokens'));
});

test('cero inválido del tokenizador no anula el texto; un cuerpo vacío sí da cero', () => {
  const require = createRequire(import.meta.url), Module = require('node:module'), load = Module._load;
  const reports = [];
  Module._load = function (id, ...args) { if (id === 'gpt-tokenizer') return { countTokens: () => 0 }; return load.call(this, id, ...args); };
  try {
    assert.equal(countOutputTokens(normal, 'gpt-6', 'chatgpt', (detail) => reports.push(detail)), estimateTokens(normal));
    assert.equal(countOutputTokens('', 'gpt-6', 'chatgpt', (detail) => reports.push(detail)), 0);
  } finally { Module._load = load; }
  assert.equal(reports.length, 1);
});

test('revisiones NDJSON repetidas y replace final no duplican ni pierden contenido', async () => {
  const rows = records(fixture('logged-out-reply.ndjson'), true);
  const content = rows.filter((row) => row.type === 'content');
  const extended = [...rows, content[2], { ...content.at(-1), revision: 5, mode: 'replace', markdown: anonymous }].map(JSON.stringify).join('\n');
  let end;
  await new Response(new Response(extended).body.pipeThrough(createStreamFilter({ adapter: 'chatgpt', format: 'ndjson', onEnd: (info) => { end = info; } }))).text();
  assert.equal(end.text, anonymous);
});


test('tres respuestas grabadas consecutivas suman tokens separados, aun con el mismo texto', async () => {
  const view = await openTab();
  const before = await stats();
  for (let i = 1; i <= 3; i++) {
    await replayPrimary(view, fixture('normal-reply.sse'));
    const after = await stats();
    assert.equal(after.responses, before.responses + i);
    assert.equal(after.outputTokens, before.outputTokens + countGptTokens(normal) * i);
    assert.equal(elements.outTokens.textContent, after.outputTokens.toLocaleString('es-AR'));
  }
});

test('la misma grabación por CDP primero y por inyección después cuenta una sola vez', async () => {
  const view = await openTab();
  const before = await stats();
  const body = fixture('normal-reply.sse');
  await replayPrimary(view, body, { beforeResponse: async () => { await pause(); await replayCdp(view, body); } });
  const after = await stats();
  assert.equal(after.responses, before.responses + 1);
  assert.equal(after.outputTokens, before.outputTokens + countGptTokens(normal));
  assert.equal(elements.outTokens.textContent, after.outputTokens.toLocaleString('es-AR'));
});

test('texto parcial y completo con el mismo ID corrigen BPE sin otra respuesta y conservan modelo', async () => {
  const view = await openTab();
  const before = await stats();
  const end = journal.ipcHandlers.get('nexo:stream-end');
  const partial = 'Primera parte de la respuesta.\n';
  const text = partial + '**Markdown completo.**\n\nSegunda parte de la explicación, sin tokens de entrada nuevos.';
  end({ sender: { id: view.id } }, { host: 'chatgpt.com', messageId: 'same-id', model: 'gpt-4-turbo', text: partial });
  end({ sender: { id: view.id } }, { host: 'chatgpt.com', messageId: 'same-id', text });
  await pause();
  const after = await stats();
  assert.equal(after.responses, before.responses + 1);
  assert.equal(after.outputTokens, before.outputTokens + countGptTokens(text, 'gpt-4-turbo'));
  assert.equal(after.inputTokens, before.inputTokens);
  assert.equal(elements.outTokens.textContent, after.outputTokens.toLocaleString('es-AR'));
});

test('una extensión puede reducir el BPE: ajustar el total exacto, no sólo sumar diferencias positivas', async () => {
  const view = await openTab();
  const before = await stats();
  const end = journal.ipcHandlers.get('nexo:stream-end');
  assert.ok(countGptTokens('functio') > countGptTokens('function'));
  end({ sender: { id: view.id } }, { host: 'chatgpt.com', messageId: 'bpe-shrink', text: 'functio' });
  end({ sender: { id: view.id } }, { host: 'chatgpt.com', messageId: 'bpe-shrink', text: 'function' });
  await pause();
  const after = await stats();
  assert.equal(after.outputTokens, before.outputTokens + countGptTokens('function'));
  assert.equal(after.responses, before.responses + 1);
  assert.equal(after.inputTokens, before.inputTokens);
  assert.equal(elements.outTokens.textContent, after.outputTokens.toLocaleString('es-AR'));
});
