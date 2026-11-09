import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractDeltas, parseSSE, serializeSSE } from '../src/core/sse.js';
import { detectSite, isChatRequest, patchOpenAIMessages } from '../src/core/sites.js';

test('parseSSE separa eventos completos y conserva el resto', () => {
  const raw = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"';
  const { events, rest } = parseSSE(raw);
  assert.equal(events.length, 2);
  assert.equal(events[0].data, '{"a":1}');
  assert.equal(rest, 'data: {"c"');
});

test('serializeSSE reconstruye el formato de cable', () => {
  const { events } = parseSSE('event: delta\ndata: hola\n\n');
  assert.equal(serializeSSE(events[0]), 'event: delta\ndata: hola\n\n');
});

test('extractDeltas entiende el formato estilo OpenAI', () => {
  const json = { choices: [{ delta: { content: 'Hola' }, index: 0 }], id: 'x' };
  const { texts } = extractDeltas(json);
  assert.deepEqual(texts.map((t) => t.text), ['Hola']);
});

test('extractDeltas entiende el formato estilo Claude', () => {
  const json = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'mundo' } };
  const { texts } = extractDeltas(json);
  assert.deepEqual(texts.map((t) => t.text), ['mundo']);
});

test('extractDeltas ignora metadatos y roles', () => {
  const json = { type: 'message_start', message: { id: 'abc', role: 'assistant', content: [] } };
  const { texts } = extractDeltas(json);
  assert.equal(texts.length, 0);
});

test('extractDeltas respeta las rutas explícitas del adaptador', () => {
  const json = { message: { content: { parts: ['texto real'] } }, delta: 'ignorado' };
  const { texts } = extractDeltas(json, { hintPaths: ['message.content.parts'] });
  assert.deepEqual(texts.map((t) => t.text), ['texto real']);
});

test('detectSite reconoce los hosts conocidos', () => {
  assert.equal(detectSite('chatgpt.com').id, 'chatgpt');
  assert.equal(detectSite('claude.ai').id, 'claude');
  assert.equal(detectSite('gemini.google.com').id, 'gemini');
  assert.equal(detectSite('www.perplexity.ai').id, 'perplexity');
  assert.equal(detectSite('sitio-inexistente.example').id, 'generic');
});

test('isChatRequest filtra por la URL de la petición', () => {
  const chatgpt = detectSite('chatgpt.com');
  assert.equal(isChatRequest(chatgpt, 'https://chatgpt.com/backend-api/conversation'), true);
  assert.equal(isChatRequest(chatgpt, 'https://chatgpt.com/assets/app.js'), false);
});

test('patchOpenAIMessages sustituye el último mensaje del usuario', () => {
  const body = {
    model: 'x',
    messages: [
      { role: 'system', content: 'sos útil' },
      { role: 'user', content: 'viejo' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: 'nuevo' }] },
    ],
  };
  patchOpenAIMessages(body, 'PROMPT MEDIADO');
  assert.equal(body.messages[3].content[0].text, 'PROMPT MEDIADO');
  assert.equal(body.messages[1].content, 'viejo');
});
