import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isResponseRequest, detectSite } from '../src/core/sites.js';
import { extractChatGptDpuAnswer, isChatGptDpuMime } from '../src/core/chatgptDpu.js';

test('reconoce el MIME DPU del ChatGPT sin iniciar sesión', () => {
  assert.equal(isChatGptDpuMime('text/vnd.openai.web-mobile-partial+html'), true);
  assert.equal(isChatGptDpuMime('text/vnd.openai.web-mobile-partial+html; charset=utf-8'), true);
  assert.equal(isChatGptDpuMime('text/event-stream'), false);
});

test('reconoce el endpoint de respuestas unauth-mweb', () => {
  const chatgpt = detectSite('chatgpt.com');
  assert.equal(
    isResponseRequest(chatgpt, 'https://chatgpt.com/unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=abc', 'POST'),
    true,
  );
  assert.equal(
    isResponseRequest(chatgpt, 'https://chatgpt.com/unauth-mweb/conversation/prepare', 'POST'),
    false,
  );
});

test('extrae la última respuesta y excluye el pie de página', () => {
  const body = [
    'You said:',
    'pregunta anterior',
    'ChatGPT said:',
    'respuesta anterior',
    'You said:',
    'addddddw',
    'ChatGPT said:',
    '¿Querías escribir algo? 😄',
    'ChatGPT is AI and can make mistakes',
    'We use cookies',
  ].join('\n');
  assert.equal(extractChatGptDpuAnswer(body, 'addddddw'), '¿Querías escribir algo? 😄');
});

test('no devuelve una respuesta anterior si el prompt actual todavía no tiene respuesta', () => {
  const body = [
    'You said:',
    'pregunta anterior',
    'ChatGPT said:',
    'respuesta anterior',
    'You said:',
    'pregunta nueva',
  ].join('\n');
  assert.equal(extractChatGptDpuAnswer(body, 'pregunta nueva'), '');
});

test('asocia prompts con saltos de línea y admite el marcador español', () => {
  const body = 'Tú dijiste:\nuna pregunta\ncon dos líneas\nChatGPT dijo:\nrespuesta final';
  assert.equal(extractChatGptDpuAnswer(body, 'una pregunta con dos líneas'), 'respuesta final');
});

test('no inventa texto cuando falta el marcador de respuesta', () => {
  assert.equal(extractChatGptDpuAnswer('You said:\nhola\nCargando...', 'hola'), '');
});

const roleNode = (role, text, markdown = null) => ({
  innerText: text,
  getAttribute: (name) => name === 'data-message-author-role' ? role : null,
  querySelector: (selector) => selector === '.markdown' && markdown !== null ? { innerText: markdown } : null,
});

const { readChatGptDpuAnswer, waitForChatGptDpuAnswer } = await import('../src/core/chatgptDpu.js');

test('DOM por rol: extrae la respuesta actual sin depender de ChatGPT said ni incluir botones', () => {
  const nodes = [roleNode('user', 'Pregunta actual'), roleNode('assistant', 'Respuesta\nCopiar\nCompartir', 'Respuesta\ncon saltos y código.')];
  const doc = { querySelectorAll: () => nodes, body: { innerText: 'interfaz sin encabezados textuales' } };
  assert.equal(readChatGptDpuAnswer(doc, 'Pregunta actual').text, 'Respuesta\ncon saltos y código.');
});

test('DOM por rol: prompt repetido sin respuesta nueva no recupera la anterior', () => {
  const nodes = [roleNode('user', 'hola'), roleNode('assistant', 'anterior'), roleNode('user', 'hola')];
  const doc = { querySelectorAll: () => nodes };
  assert.equal(readChatGptDpuAnswer(doc, 'hola').text, '');
});

test('DOM por rol: no roba la respuesta del siguiente usuario aunque el body tenga marcadores antiguos', () => {
  const doc = { querySelectorAll: () => [roleNode('user', 'otra pregunta'), roleNode('assistant', 'otra respuesta')],
    body: { innerText: 'You said:\npregunta esperada\nChatGPT said:\nanterior' } };
  assert.equal(readChatGptDpuAnswer(doc, 'pregunta esperada').text, '');
});

test('espera DPU: una respuesta anterior sin cambios no cuenta como la nueva', async () => {
  const doc = { querySelectorAll: () => [], body: { innerText: 'You said:\nhola\nChatGPT said:\nanterior' } };
  const before = readChatGptDpuAnswer(doc, 'hola');
  assert.equal(await waitForChatGptDpuAnswer(doc, 'hola', before, { timeout: 40, interval: 5, stableFor: 10 }), '');
});

test('espera DPU: la misma respuesta a un prompt repetido sí cuenta cuando pertenece a nodos nuevos', async () => {
  let nodes = [roleNode('user', 'hola'), roleNode('assistant', 'Igual.')];
  const doc = { querySelectorAll: () => nodes };
  const before = readChatGptDpuAnswer(doc, 'hola');
  nodes = [...nodes, roleNode('user', 'hola'), roleNode('assistant', 'Igual.')];
  assert.equal(await waitForChatGptDpuAnswer(doc, 'hola', before, { timeout: 100, interval: 5, stableFor: 10 }), 'Igual.');
});
