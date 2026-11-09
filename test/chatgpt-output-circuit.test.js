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
const shellHtml = readFileSync(new URL('../src/ui/shell/index.html', import.meta.url), 'utf8');
const elements = Object.fromEntries(['messages', 'responses', 'turnsCancelled', 'turnsFailed', 'turnsPerformed', 'inTokens', 'outTokens', 'interventions', 'capture'].map((key) => [key, { textContent: '0' }]));
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
function pageFor(view, body, { mime = 'text/event-stream', chunkSize = 37, abort = false, beforeResponse = null, holdOpen = null, fetchError = null, status = 200, bodyText = '', initialBodyText = '', roleNodes = null } = {}) {
  const listeners = [], captures = [];
  let mutate = () => {};
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() { mutate = this.callback; }
    disconnect() { mutate = () => {}; }
  }
  // Simula sólo la notificación DOM, no el extractor ni el contador.

  const bytes = new TextEncoder().encode(body);
  let offset = 0, transportStarted = false;
  const page = {
    location: { href: 'https://chatgpt.com/c/output-circuit', hostname: 'chatgpt.com', pathname: '/c/output-circuit', protocol: 'https:' },
    addEventListener: (name, listener) => { if (name === 'message') listeners.push(listener); },
    postMessage(data) { queueMicrotask(() => { for (const listener of listeners) listener({ source: page, data }); }); },
    fetch: async () => {
      if (beforeResponse) await beforeResponse();
      if (fetchError) throw fetchError;
      transportStarted = true;
      return new Response(new ReadableStream({
      async pull(controller) {
        if (offset < bytes.length) { controller.enqueue(bytes.slice(offset, offset += chunkSize)); return; }
        if (holdOpen) await holdOpen;
        if (abort) controller.error(new DOMException('Detenido por el usuario', 'AbortError'));
        else controller.close();
      },
    }), { status, headers: { 'content-type': mime } });
    },
  };
  const domListeners = new Map();
  const document = { body: { get innerText() { if (!transportStarted) return initialBodyText; return typeof bodyText === 'function' ? bodyText() : bodyText; }, set innerText(value) { bodyText = value; } }, querySelector: () => null, querySelectorAll: (selector) => selector === '[data-message-author-role]' && roleNodes ? roleNodes(transportStarted) : [],
    addEventListener(name, handler) { domListeners.set(name, handler); } };
  page.document = document;
  page.mutate = () => mutate();
  page.stop = (isTrusted = true, attributes = { 'data-testid': 'stop-button' }) => {
    // DOM mínimo: compara atributos reales del botón, sin copiar los selectores
    // de producción. El target puede ser el icono hijo del botón.
    const button = { disabled: false, matches(selector) {
      const match = selector.match(/^(?:button)?\[([\w-]+)(\*?=)"([^"]+)"( i)?\]$/);
      if (!match) return selector === 'button';
      let actual = attributes[match[1]] || '', expected = match[3];
      if (match[4]) { actual = actual.toLowerCase(); expected = expected.toLowerCase(); }
      return match[2] === '*=' ? actual.includes(expected) : actual === expected;
    } };
    domListeners.get('click')?.({ isTrusted, target: {
      closest: (selector) => selector.split(',').some((item) => button.matches(item.trim())) ? button : null,
    } });
  };
  const context = vm.createContext({ window: page, location: page.location, document, console,
    MutationObserver, setTimeout, clearTimeout, TextEncoder, TextDecoder, ReadableStream, WritableStream, TransformStream, Response, Headers, Request, URL, URLSearchParams, FormData });
  const requireBridge = createRequire(new URL('../src/preload/bridge.cjs', import.meta.url));
  const sender = { id: view.id, getURL: () => page.location.href, getType: () => 'webview' };
  const ipcRenderer = {
    on() {},
    sendSync: () => ({ host: 'chatgpt.com', enabled: true, settings: { receiving: { stopOnLoop: false } }, language: 'es' }),
    invoke: async (channel, payload) => {
      if (channel === 'nexo:stream-end') captures.push(payload);
      return journal.ipcHandlers.get(channel)?.({ sender }, payload);
    },
    send: (channel, payload) => journal.ipcListeners.get(channel)?.({ sender }, payload),
  };
  const preload = vm.createContext({ window: page, location: page.location, console,
    __dirname: fileURLToPath(new URL('../src/preload/', import.meta.url)),
    require: (name) => name === 'electron' ? { ipcRenderer, webFrame: {
      executeJavaScript: async (code) => vm.runInContext(code, context),
    } } : requireBridge(name),
  });
  vm.runInContext(readFileSync(new URL('../src/preload/bridge.cjs', import.meta.url), 'utf8'), preload);
  page.captures = captures;
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

for (const [name, body, mime, expected] of [
  ['SSE message_stream_complete', fixture('normal-reply.sse').split('data: {"type":"user_signal_metadata"')[0], 'text/event-stream', normal],
  ['SSE DONE', fixture('normal-reply.sse').replace(/data: \{"type":"message_stream_complete"[^\n]*\n\n/, ''), 'text/event-stream', normal],
  ['NDJSON end', fixture('logged-out-reply.ndjson'), 'application/x-ndjson', anonymous],
]) {
  test(`${name}: contabiliza la respuesta y actualiza la UI sin esperar el cierre HTTP`, async () => {
    const view = await openTab();
    let release;
    const holdOpen = new Promise((resolve) => { release = resolve; });
    const before = stats();
    const page = pageFor(view, body, { mime, holdOpen });
    const response = await page.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({
      action: 'next', model: 'gpt-6', messages: [{ author: { role: 'user' }, content: { parts: ['Test'] } }],
    }) });
    let closed = false, wire = '';
    const reading = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of response.body) wire += decoder.decode(chunk, { stream: true });
      wire += decoder.decode();
      closed = true;
    })();
    try {
      await pause(100);
      assert.equal(closed, false, 'la conexión sigue abierta deliberadamente');
      if (mime.includes('ndjson')) assert.equal(wire, body, 'el cliente recibe todos los bytes antes de EOF');
      else {
        const visible = records(body).find((row) => row.v?.message?.author?.role === 'assistant' &&
          !row.v.message.metadata?.is_message_fragment && row.v.message.content?.content_type === 'text');
        assert.equal(visibleChannelText(wire, visible.c), expected, 'el cliente recibe toda la respuesta antes de EOF');
        if (name === 'SSE DONE') assert.match(wire, /data: \[DONE\]/);
      }
      assert.equal(stats().outputTokens - before.outputTokens, countGptTokens(expected, 'gpt-6'));
      assert.equal(stats().responses - before.responses, 1);
      assert.equal(elements.outTokens.textContent, stats().outputTokens.toLocaleString('es-AR'));
    } finally {
      release();
      await reading;
      await pause(50);
    }
    assert.equal(stats().outputTokens - before.outputTokens, countGptTokens(expected, 'gpt-6'), 'EOF no duplica tokens');
    assert.equal(stats().responses - before.responses, 1, 'EOF no duplica respuestas');
    await replayCdp(view, body, mime);
    assert.equal(stats().outputTokens - before.outputTokens, countGptTokens(expected, 'gpt-6'), 'CDP tardío no duplica tokens');
    assert.equal(stats().responses - before.responses, 1, 'CDP tardío no duplica respuestas');
  });
}


const outcomes = ['turnsCancelled', 'turnsFailed', 'turnsPerformed'];
function outcomeDelta(before) { return outcomes.map((key) => stats()[key] - before[key]); }
function assertOutcomeUi() {
  for (const key of outcomes) assert.equal(elements[key].textContent, stats()[key].toLocaleString('es-AR'), key);
}
test('el panel muestra los tres contadores actuales y elimina el contador duplicado', () => {
  assert.match(shellHtml, /id="statTurnsCancelled">0<\/b><span>turnos cancelados<\/span>/);
  assert.match(shellHtml, /id="statTurnsFailed">0<\/b><span>turnos fallidos<\/span>/);
  assert.match(shellHtml, /id="statTurnsPerformed">0<\/b><span>turnos realizados<\/span>/);
  assert.doesNotMatch(shellHtml, /id="statTurnsCompleted"/);
  assert.doesNotMatch(shellHtml, /<span>turnos completos<\/span>/);
});
function requestReply(page) {
  return page.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ action: 'next',
    model: 'gpt-6', messages: [{ author: { role: 'user' }, content: { parts: ['Test'] } }],
  }) });
}

test('resultados: SSE y NDJSON normales no recrean el contador de turnos completos', async () => {
  for (const [body, mime] of [[fixture('normal-reply.sse'), 'text/event-stream'],
    [fixture('logged-out-reply.ndjson'), 'application/x-ndjson']]) {
    const view = await openTab(), before = stats();
    await replayPrimary(view, body, { mime });
    assert.deepEqual(outcomeDelta(before), [0, 0, 0]);
    assertOutcomeUi();
    await replayCdp(view, body, mime);
    assert.deepEqual(outcomeDelta(before), [0, 0, 0]);
  }
});

test('resultados: Stop confirmado actualiza UI antes del aborto; no se confunde con el centinela', async () => {
  const view = await openTab(), before = stats();
  let release;
  const holdOpen = new Promise((resolve) => { release = resolve; });
  const page = pageFor(view, fixture('aborted.sse'), { holdOpen, abort: true });
  const response = await requestReply(page);
  const reading = response.text().catch((error) => { assert.equal(error.name, 'AbortError'); });
  try {
    await pause(60);
    const during = stats().outputTokens;
    assert.ok(during > before.outputTokens, 'ya se contabilizó texto real en vivo');
    page.stop(false);
    await pause();
    assert.deepEqual(outcomeDelta(before), [0, 0, 0], 'un clic programático no confirma Stop');
    page.stop();
    await pause();
    assert.deepEqual(outcomeDelta(before), [1, 0, 0]);
    assert.equal(stats().outputTokens, during, 'clasificar Stop no modifica los tokens');
    assertOutcomeUi();
  } finally { release(); await reading; await pause(50); }
  assert.deepEqual(outcomeDelta(before), [1, 0, 0]);
  assert.ok(stats().outputTokens > before.outputTokens, 'el cierre conserva el conteo parcial existente');
  assertOutcomeUi();
});

test('resultados: AbortError sin Stop confirmado queda desconocido y se refresca solo', async () => {
  const view = await openTab(), before = stats();
  await replayPrimary(view, fixture('aborted.sse'), { abort: true });
  assert.deepEqual(outcomeDelta(before), [0, 0, 1]);
  assertOutcomeUi();
});

test('resultados: error de generación en SSE con HTTP 200 no se marca completo', async () => {
  const view = await openTab(), before = stats();
  const body = fixture('normal-reply.sse').split('data: {"type":"message_stream_complete"')[0] +
    'data: {"type":"error","error":{"message":"Generation failed"}}\n\ndata: [DONE]\n\n';
  await replayPrimary(view, body);
  assert.deepEqual(outcomeDelta(before), [0, 1, 0]);
  assert.equal(stats().outputTokens - before.outputTokens, countGptTokens(normal, 'gpt-6'));
  assertOutcomeUi();
});

for (const [name, options, expected] of [
  ['rechazo fetch', { fetchError: new TypeError('Failed to fetch') }, [0, 1, 0]],
  ['aborto antes de cabeceras', { fetchError: new DOMException('Aborted', 'AbortError') }, [0, 0, 1]],
  ['HTTP 500', { status: 500 }, [0, 1, 0]],
]) {
  test(`resultados: ${name} se integra desde inyección/preload hasta UI`, async () => {
    const view = await openTab(), before = stats();
    const page = pageFor(view, '', options);
    try { const response = await requestReply(page); await response.text(); }
    catch (error) { assert.ok(options.fetchError); }
    await pause(50);
    assert.deepEqual(outcomeDelta(before), expected);
    assert.equal(stats().inputTokens, before.inputTokens + countGptTokens('Test', 'gpt-6'));
    assert.equal(stats().outputTokens, before.outputTokens);
    assertOutcomeUi();
  });
}

test('resultados: error explícito actualiza el contador sin esperar EOF ni DONE', async () => {
  const view = await openTab(), before = stats();
  let release;
  const holdOpen = new Promise((resolve) => { release = resolve; });
  const body = fixture('normal-reply.sse').split('data: {"type":"message_stream_complete"')[0] +
    'event: error\ndata: {"message":"Generation failed"}\n\n';
  const page = pageFor(view, body, { holdOpen });
  const response = await requestReply(page);
  let closed = false;
  const reading = response.text().then(() => { closed = true; });
  try {
    await pause(70);
    assert.equal(closed, false);
    assert.deepEqual(outcomeDelta(before), [0, 1, 0]);
    assertOutcomeUi();
    assert.equal(stats().outputTokens - before.outputTokens, countGptTokens(normal, 'gpt-6'));
  } finally { release(); await reading; await pause(50); }
  assert.deepEqual(outcomeDelta(before), [0, 1, 0]);
});

test('resultados: CDP loadingFailed cancelado no presupone Stop y actualiza UI', async () => {
  const view = await openTab(), before = stats();
  const requestId = `failure-${view.id}`;
  view.debugger.emitEvent('Network.requestWillBeSent', { requestId, type: 'Fetch', request: {
    url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST',
    postData: JSON.stringify({ action: 'next', messages: [{ author: { role: 'user' }, content: { parts: ['Test CDP abort'] } }] }),
  } });
  await pause(30);
  view.debugger.emitEvent('Network.loadingFailed', { requestId, canceled: true, errorText: 'net::ERR_ABORTED' });
  await pause(30);
  assert.deepEqual(outcomeDelta(before), [0, 0, 1]);
  assertOutcomeUi();
});

test('resultados: navegar fuera durante una generación deja un único desconocido visible', async () => {
  const view = await openTab(), before = stats();
  journal.ipcListeners.get('nexo:event')({ sender: { id: view.id, getType: () => 'webview', getURL: () => 'https://chatgpt.com/' } }, {
    type: 'outgoing', payload: { messageId: `navigate-${view.id}`, host: 'chatgpt.com', chars: 4, tokens: 2 },
  });
  view.emit('did-start-navigation', {}, 'https://example.org/', false, true);
  await pause();
  assert.deepEqual(outcomeDelta(before), [0, 0, 1]);
  assertOutcomeUi();
  view.emit('destroyed');
  await pause();
  assert.deepEqual(outcomeDelta(before), [0, 0, 1]);
});

test('resultados: regenerar dos veces el mismo texto cuenta dos turnos, no otros mensajes', async () => {
  const view = await openTab();
  await replayPrimary(view, fixture('normal-reply.sse'));
  const before = stats();
  for (let i = 0; i < 2; i++) {
    const page = pageFor(view, fixture('normal-reply.sse'));
    const response = await page.fetch('/backend-api/f/conversation', { method: 'POST',
      body: JSON.stringify({ action: 'variant', model: 'gpt-6' }),
    });
    await response.text();
    await pause(50);
  }
  assert.deepEqual(outcomeDelta(before), [0, 0, 0]);
  assert.equal(stats().messages, before.messages);
  assert.equal(stats().inputTokens, before.inputTokens);
  assertOutcomeUi();
});

const dpuMime = 'text/vnd.openai.web-mobile-partial+html';
function requestDpu(page) {
  return page.fetch('/unauth-mweb/conversation/updates?operationId=test', {
    method: 'POST', body: new URLSearchParams({ prompt: 'Pregunta DPU' }),
  });
}

test('integración remota DPU: conserva captura de texto y clasifica un único turno completo', async () => {
  const view = await openTab(), before = stats();
  const answer = 'Respuesta DPU visible.';
  const page = pageFor(view, '<template>DPU</template>', { mime: dpuMime,
    bodyText: `You said:\nPregunta DPU\nChatGPT said:\n${answer}` });
  const response = await requestDpu(page);
  assert.equal(await response.text(), '<template>DPU</template>', 'no se altera el transporte DPU');
  await pause(260);
  assert.deepEqual(outcomeDelta(before), [0, 0, 0]);
  assert.equal(stats().outputTokens - before.outputTokens, countGptTokens(answer));
  assertOutcomeUi();
});

test('integración remota DPU: espera el renderizado tardío del DOM y suma tokens de salida', async () => {
  const view = await openTab(), before = stats();
  const answer = 'Respuesta DPU aplicada tarde al documento.';
  const page = pageFor(view, '<template>DPU</template>', { mime: dpuMime,
    bodyText: 'You said:\nPregunta DPU\nAplicando respuesta...' });
  const response = await requestDpu(page);
  setTimeout(() => {
    page.document.body.innerText = `You said:\nPregunta DPU\nChatGPT said:\n${answer}`;
  }, 350);
  assert.equal(await response.text(), '<template>DPU</template>', 'el transporte original permanece intacto');
  await pause(650);
  assert.equal(stats().responses, before.responses + 1);
  assert.equal(stats().outputTokens, before.outputTokens + countGptTokens(answer));
  assert.equal(elements.outTokens.textContent, stats().outputTokens.toLocaleString('es-AR'));
});

test('integración remota DPU: Stop y cierre posterior no crean otro resultado', async () => {
  const view = await openTab(), before = stats();
  let release;
  const holdOpen = new Promise((resolve) => { release = resolve; });
  const page = pageFor(view, '<template>DPU</template>', { mime: dpuMime, holdOpen,
    bodyText: 'You said:\nPregunta DPU\nChatGPT said:\nRespuesta parcial.' });
  const response = await requestDpu(page);
  const reading = response.text();
  try {
    await pause(40);
    page.stop();
    await pause();
    assert.deepEqual(outcomeDelta(before), [1, 0, 0]);
    assertOutcomeUi();
  } finally { release(); await reading; await pause(260); }
  assert.deepEqual(outcomeDelta(before), [1, 0, 0]);
});

test('integración remota DPU: sin respuesta verificable en DOM queda desconocido, no completo', async () => {
  const view = await openTab(), before = stats();
  const page = pageFor(view, '<template>DPU sin respuesta</template>', { mime: dpuMime });
  const response = await requestDpu(page);
  await response.text();
  await pause(5300);
  assert.deepEqual(outcomeDelta(before), [0, 0, 1]);
  assert.equal(stats().outputTokens, before.outputTokens, 'no inventa tokens si falta la respuesta');
  assertOutcomeUi();
});


for (const attributes of [
  { 'data-testid': 'stop-generating-button' },
  { 'aria-label': 'Stop generating' },
  { 'aria-label': 'Detener generación' },
  { 'aria-label': 'Cancelar generación' },
  { 'aria-label': 'stop streaming' },
]) {
  test(`cancelar con ${JSON.stringify(attributes)} suma exactamente +1 y refresca el panel`, async () => {
    const view = await openTab(), before = stats();
    let release;
    const holdOpen = new Promise((resolve) => { release = resolve; });
    const page = pageFor(view, fixture('aborted.sse'), { holdOpen, abort: true });
    const response = await requestReply(page);
    const reading = response.text().catch((error) => assert.equal(error.name, 'AbortError'));
    try {
      await pause(50);
      const during = stats().outputTokens;
      assert.ok(during > before.outputTokens);
      page.stop(true, attributes);
      page.stop(true, attributes);
      await pause();
      assert.deepEqual(outcomeDelta(before), [1, 0, 0]);
      assertOutcomeUi();
      assert.equal(stats().outputTokens, during, 'el clic no modifica tokens');
    } finally { release(); await reading; await pause(50); }
    assert.deepEqual(outcomeDelta(before), [1, 0, 0], 'el aborto no vuelve a sumar');
    await replayCdp(view, fixture('aborted.sse'));
    assert.deepEqual(outcomeDelta(before), [1, 0, 0], 'CDP no vuelve a sumar');
    assertOutcomeUi();
  });
}

for (const [mime, name, expected] of [
  ['application/x-ndjson', 'logged-out-reply.ndjson', anonymous],
  ['text/plain', 'logged-out-reply.ndjson', anonymous],
  ['application/json', 'logged-out-reply.ndjson', anonymous],
  ['text/event-stream', 'normal-reply.sse', normal],
]) {
  test(`updates con ${mime}: texto grabado → BPE → contador, sin depender del DOM`, async () => {
    const view = await openTab(), before = stats();
    const body = fixture(name);
    const page = pageFor(view, body, { mime });
    const response = await page.fetch('/unauth-mweb/conversation/updates?operationId=recorded', {
      method: 'POST', body: new URLSearchParams({ prompt: 'Test' }),
    });
    await response.text();
    await pause(260);
    assert.equal(page.captures.at(-1)?.text, expected, 'el texto grabado llega íntegro al handler real de salida');
    assert.equal(stats().outputTokens - before.outputTokens, countGptTokens(expected), 'tokeniza el texto de esta respuesta');
    assert.equal(stats().responses - before.responses, 1);
    assert.equal(elements.outTokens.textContent, stats().outputTokens.toLocaleString('es-AR'));
  });
}

test('DPU: el render llega después de 180 ms y todavía debe aportar tokens', async () => {
  const view = await openTab(), before = stats();
  let dom = 'You said:\nPregunta DPU';
  const answer = 'Esta respuesta llegó después de que cerrara el transporte.';
  const page = pageFor(view, '<template>DPU</template>', { mime: dpuMime, bodyText: () => dom });
  const response = await requestDpu(page);
  await response.text();
  await pause(350);
  dom += `\nChatGPT said:\n${answer}`;
  await pause(450);
  assert.equal(page.captures.at(-1)?.text, answer, 'el texto visible se entrega al proceso principal');
  assert.equal(stats().outputTokens - before.outputTokens, countGptTokens(answer));
  assert.equal(elements.outTokens.textContent, stats().outputTokens.toLocaleString('es-AR'));
});

test('DPU: un aborto no debe descartar el texto parcial visible de esta respuesta', async () => {
  const view = await openTab(), before = stats();
  const answer = 'Texto parcial recibido antes de detener la generación';
  const page = pageFor(view, '<template>partial</template>', { mime: dpuMime, abort: true,
    bodyText: `You said:\nPregunta DPU\nChatGPT said:\n${answer}` });
  const response = await requestDpu(page);
  await response.text().catch(() => {});
  await pause(300);
  assert.equal(page.captures.at(-1)?.text, answer, 'el texto visible se entrega al proceso principal');
  assert.equal(stats().outputTokens - before.outputTokens, countGptTokens(answer));
  assert.equal(elements.outTokens.textContent, stats().outputTokens.toLocaleString('es-AR'));
});

test('DPU sin etiquetas traducidas: nodos user/assistant → BPE → tokens de salida visibles', async () => {
  const view = await openTab(), before = stats();
  const answer = 'Respuesta visible de GPT, sin etiquetas de accesibilidad en el body.';
  const user = { innerText: 'Pregunta DPU', getAttribute: () => 'user' };
  const assistant = { innerText: answer + '\nCopiar', getAttribute: () => 'assistant',
    querySelector: () => ({ innerText: answer }) };
  const page = pageFor(view, '<template>DPU</template>', { mime: dpuMime, bodyText: 'interfaz sin ChatGPT said:',
    roleNodes: (started) => started ? [user, assistant] : [],
  });
  const response = await requestDpu(page);
  await response.text();
  await pause(260);
  assert.equal(page.captures.at(-1)?.text, answer, 'el texto visible se entrega al proceso principal');
  assert.equal(stats().outputTokens - before.outputTokens, countGptTokens(answer));
  assert.equal(elements.outTokens.textContent, stats().outputTokens.toLocaleString('es-AR'));
});

test('SSE vacío recupera el texto autenticado tardío por el mismo turno, sin otra respuesta', async () => {
  const view = await openTab(), before = stats();
  const answer = 'Texto final que sólo está disponible en el mensaje de GPT.';
  const node = (role, text) => ({ innerText: text, getAttribute: () => role, querySelector: () => null });
  const old = [node('user', 'Test'), node('assistant', 'Respuesta anterior.')];
  const current = node('user', 'Test'), assistant = node('assistant', answer);
  let rendered = false;
  const page = pageFor(view, 'data: [DONE]\n\n', { roleNodes: (started) => !started ? old
    : [...old, current, ...(rendered ? [assistant] : [])] });
  const response = await requestReply(page);
  await response.text();
  await pause(50);
  assert.equal(stats().responses - before.responses, 1, 'el cierre no espera al fallback DOM');
  assert.equal(stats().outputTokens, before.outputTokens, 'no toma el texto anterior');
  rendered = true;
  await pause(300);
  assert.equal(page.captures.at(-1)?.text, answer);
  assert.equal(page.captures.at(-1)?.source, 'dom-recovery');
  assert.equal(page.captures.length, 2, 'cierre y recuperación llevan el mismo ID, no otra respuesta');
  assert.equal(page.captures[0].messageId, page.captures[1].messageId);
  assert.equal(stats().responses - before.responses, 1);
  assert.equal(stats().interventions - before.interventions, 2);
  assert.equal(stats().outputTokens - before.outputTokens, countGptTokens(answer, 'gpt-6'));
  assert.equal(elements.outTokens.textContent, stats().outputTokens.toLocaleString('es-AR'));
});

test('fallback autenticado no tokeniza una respuesta previa al repetir el prompt', async () => {
  const view = await openTab(), before = stats();
  const old = [
    { innerText: 'Test', getAttribute: () => 'user' },
    { innerText: 'No es la respuesta nueva.', getAttribute: () => 'assistant', querySelector: () => null },
  ];
  const page = pageFor(view, 'data: [DONE]\n\n', { roleNodes: () => old });
  const response = await requestReply(page);
  await response.text();
  await pause(5200);
  assert.equal(stats().outputTokens, before.outputTokens);
  assert.equal(stats().responses - before.responses, 1);
  assert.equal(page.captures.length, 1, 'no hay recuperación ficticia');
});

test('DPU en vivo: ignora DOM anterior, actualiza BPE con nodos nuevos y cierra sin duplicar', async () => {
  const view = await openTab(), before = stats();
  const node = (role, text) => ({ innerText: text, getAttribute: () => role, querySelector: () => null });
  const old = [node('user', 'Test'), node('assistant', 'Respuesta vieja.')];
  let nodes = old, release;
  const holdOpen = new Promise((resolve) => { release = resolve; });
  const page = pageFor(view, '<template>render</template>', {
    mime: 'text/vnd.openai.web-mobile-partial+html', roleNodes: () => nodes, holdOpen,
  });
  const response = await requestReply(page);
  const reading = response.text();
  try {
    page.mutate();
    await pause(30);
    assert.equal(stats().outputTokens, before.outputTokens, 'no publica la respuesta antigua');
    const assistant = node('assistant', 'Nueva respuesta');
    nodes = [...old, node('user', 'Test'), assistant];
    page.mutate();
    await pause(30);
    assert.equal(stats().outputTokens - before.outputTokens, countGptTokens(assistant.innerText, 'gpt-6'));
    assistant.innerText += ' completa.';
    page.mutate();
    await pause(30);
    assert.equal(stats().outputTokens - before.outputTokens, countGptTokens(assistant.innerText, 'gpt-6'));
    assert.equal(elements.outTokens.textContent, stats().outputTokens.toLocaleString('es-AR'));
  } finally { release(); await reading; await pause(300); }
  assert.equal(stats().responses - before.responses, 1);
  assert.equal(stats().outputTokens - before.outputTokens, countGptTokens('Nueva respuesta completa.', 'gpt-6'));
});
