import assert from 'node:assert/strict';
import { test } from 'node:test';

import { settingsForHost } from '../src/core/settings.js';
import { detectSite, isChatRequest, locateUserText, patchUserText } from '../src/core/sites.js';

test('localiza el mensaje en el esquema de ChatGPT', () => {
  const body = {
    action: 'next',
    messages: [
      { author: { role: 'user' }, content: { content_type: 'text', parts: ['hola, primera'] } },
      { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['buenas'] } },
      { author: { role: 'user' }, content: { content_type: 'text', parts: ['mensaje nuevo'] } },
    ],
  };
  const found = locateUserText(body, detectSite('chatgpt.com'));
  assert.equal(found.value, 'mensaje nuevo');
  patchUserText(body, detectSite('chatgpt.com'), 'mensaje mediado');
  assert.equal(body.messages[2].content.parts[0], 'mensaje mediado');
  assert.equal(body.messages[0].content.parts[0], 'hola, primera');
});

test('localiza el mensaje en el esquema de Claude', () => {
  const body = { prompt: 'texto original', timezone: 'America/Argentina/Cordoba' };
  const site = detectSite('claude.ai');
  assert.equal(locateUserText(body, site).value, 'texto original');
  patchUserText(body, site, 'texto mediado');
  assert.equal(body.prompt, 'texto mediado');
  assert.equal(body.timezone, 'America/Argentina/Cordoba');
});

test('localiza el mensaje en el esquema OpenAI con partes', () => {
  const body = {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'sos útil' },
      { role: 'user', content: [{ type: 'text', text: 'la pregunta' }] },
    ],
  };
  const site = { body: { kind: 'openai-messages' } };
  assert.equal(locateUserText(body, site).value, 'la pregunta');
  patchUserText(body, site, 'mediada');
  assert.equal(body.messages[1].content[0].text, 'mediada');
});

test('ignora metadatos al usar la vía genérica', () => {
  const body = { conversationId: 'abc-123', model: 'x', payload: { text: 'hola mundo' } };
  const found = locateUserText(body, { body: { kind: 'generic' } });
  assert.equal(found.value, 'hola mundo');
});

test('respeta el JSON anidado de Gemini', () => {
  const inner = ['prompt', { data: ['mensaje del usuario'] }];
  const body = { f_req: ['rpc-id', JSON.stringify(inner), null] };
  const site = detectSite('gemini.google.com');
  const found = locateUserText(body, site);
  assert.equal(found.value, 'mensaje del usuario');
  patchUserText(body, site, 'mediado');
  assert.ok(body.f_req[1].includes('mediado'));
  assert.deepEqual(JSON.parse(body.f_req[1])[0], 'prompt');
});

test('devuelve null si el cuerpo no tiene texto de usuario', () => {
  assert.equal(locateUserText({ model: 'x' }, { body: { kind: 'generic' } }), null);
  assert.equal(locateUserText({ messages: [] }, detectSite('chatgpt.com')), null);
});

test('los ajustes por sitio se aplican por host y por id', () => {
  const settings = {
    enabled: true,
    sites: { chatgpt: { enabled: false }, claude: { protocolLevel: 'agresivo' }, default: { enabled: true } },
  };
  assert.equal(settingsForHost(settings, 'chatgpt.com').enabled, false);
  assert.equal(settingsForHost(settings, 'chat.openai.com').enabled, false);
  assert.equal(settingsForHost(settings, 'claude.ai').enabled, true);
  assert.equal(settingsForHost(settings, 'claude.ai').protocol.level, 'agresivo');
});

test('desactivar el motor global gana sobre todo', () => {
  const settings = { ...{ enabled: false }, sites: { chatgpt: { enabled: true } } };
  assert.equal(settingsForHost(settings, 'chatgpt.com').enabled, false);
});

test('isChatRequest distingue recursos de la app', () => {
  const chatgpt = detectSite('chatgpt.com');
  assert.equal(isChatRequest(chatgpt, 'https://chatgpt.com/backend-api/conversation'), true);
  assert.equal(isChatRequest(chatgpt, 'https://chatgpt.com/c/abc'), false);
  assert.equal(isChatRequest(chatgpt, 'https://chatgpt.com/ces/v1/t'), false);
});
