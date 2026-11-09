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
