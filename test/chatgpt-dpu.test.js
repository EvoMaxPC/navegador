import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isResponseRequest, detectSite } from '../src/core/sites.js';
import { extractChatGptAssistantDomText, extractChatGptDpuAnswer, isChatGptDpuMime } from '../src/core/chatgptDpu.js';

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

test('no reutiliza la respuesta previa cuando el usuario repite el mismo prompt', () => {
  const pending = [
    'You said:',
    'misma pregunta',
    'ChatGPT said:',
    'respuesta anterior',
    'You said:',
    'misma pregunta',
  ].join('\n');
  assert.equal(extractChatGptDpuAnswer(pending, 'misma pregunta'), '');

  const completed = `${pending}\nChatGPT said:\nrespuesta nueva`;
  assert.equal(extractChatGptDpuAnswer(completed, 'misma pregunta'), 'respuesta nueva');
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

const { readChatGptDpuAnswer, waitForChatGptDpuAnswer, extractChatGptVisibleAnswer } = await import('../src/core/chatgptDpu.js');

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

test('lector autenticado comparte la normalización de saltos y espacios del lector DPU', async () => {
  const { extractChatGptAssistantDomText } = await import('../src/core/chatgptDpu.js');
  const nodes = [roleNode('user', 'una pregunta\ncon dos líneas'), roleNode('assistant', 'Respuesta actual.')];
  assert.equal(extractChatGptAssistantDomText({ querySelectorAll: () => nodes }, 'una pregunta con dos líneas'), 'Respuesta actual.');
});

function fakeMessage(text, position) {
  return {
    innerText: text,
    textContent: text,
    compareDocumentPosition(other) {
      return position < other.position ? 4 : 2;
    },
    position,
    querySelector() { return null; },
  };
}

test('recupera la respuesta autenticada visible después del prompt actual', () => {
  const user = fakeMessage('¿Cuánto es 2 + 2?', 1);
  const assistant = fakeMessage('4', 2);
  const doc = {
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role]') {
        user.getAttribute = () => 'user'; assistant.getAttribute = () => 'assistant';
        return [user, assistant].sort((a, b) => a.position - b.position);
      }
      return selector.includes('assistant') ? [assistant] : [user];
    },
  };
  assert.equal(extractChatGptAssistantDomText(doc, '¿Cuánto es 2 + 2?'), '4');
});

test('no reutiliza una respuesta anterior si el usuario ya envió otro prompt', () => {
  const assistant = fakeMessage('respuesta vieja', 1);
  const user = fakeMessage('pregunta nueva', 2);
  const doc = {
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role]') {
        user.getAttribute = () => 'user'; assistant.getAttribute = () => 'assistant';
        return [user, assistant].sort((a, b) => a.position - b.position);
      }
      return selector.includes('assistant') ? [assistant] : [user];
    },
  };
  assert.equal(extractChatGptAssistantDomText(doc, 'pregunta nueva'), '');
});

test('rechaza texto visible que no corresponde al prompt enviado', () => {
  const user = fakeMessage('otra pregunta', 1);
  const assistant = fakeMessage('respuesta', 2);
  const doc = {
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role]') {
        user.getAttribute = () => 'user'; assistant.getAttribute = () => 'assistant';
        return [user, assistant].sort((a, b) => a.position - b.position);
      }
      return selector.includes('assistant') ? [assistant] : [user];
    },
  };
  assert.equal(extractChatGptAssistantDomText(doc, 'prompt esperado'), '');
});

test('captura DPU sin encabezados visibles y se limita al texto posterior al prompt', () => {
  const doc = { body: { innerText: 'Pregunta actual\nRespuesta parcial que está generándose.' }, querySelectorAll: () => [] };
  assert.equal(extractChatGptVisibleAnswer(doc, 'Pregunta actual'), 'Respuesta parcial que está generándose.');
});

test('captura DPU sin encabezados no reutiliza texto previo al prompt actual', () => {
  const doc = { body: { innerText: 'Pregunta anterior\nRespuesta vieja\nPregunta actual' }, querySelectorAll: () => [] };
  assert.equal(extractChatGptVisibleAnswer(doc, 'Pregunta actual'), '');
});
