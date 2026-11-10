import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readChatGptConversation } from '../src/core/chatgptConversation.js';

function message(role, text, { id = '', markdown = null, userText = null } = {}) {
  return {
    innerText: text,
    textContent: text,
    getAttribute(name) {
      if (name === 'data-message-author-role') return role;
      if (name === 'data-message-id') return id || null;
      return null;
    },
    querySelector(selector) {
      if (selector === '.markdown' && markdown !== null) return { innerText: markdown, textContent: markdown };
      if (selector.includes('.whitespace-pre-wrap') && userText !== null) return { innerText: userText, textContent: userText };
      return null;
    },
    closest() { return null; },
    contains(other) { return other === this; },
  };
}

test('lee mensajes de usuario y asistente por data-message-author-role', () => {
  const nodes = [
    message('user', 'Pregunta', { id: 'u1' }),
    message('assistant', 'Respuesta\nCopiar', { id: 'a1', markdown: 'Respuesta limpia' }),
  ];
  const document = { querySelectorAll: (selector) => selector === '[data-message-author-role]' ? nodes : [] };
  assert.deepEqual(readChatGptConversation(document), [
    { id: 'u1', role: 'user', content: 'Pregunta', clipped: false },
    { id: 'a1', role: 'assistant', content: 'Respuesta limpia', clipped: false },
  ]);
});

test('usa article como respaldo cuando ChatGPT cambia los atributos de rol', () => {
  const nodes = [
    message('', 'Pregunta antigua', { userText: 'Pregunta antigua' }),
    message('', 'Respuesta antigua', { markdown: 'Respuesta antigua' }),
  ];
  const document = {
    querySelectorAll(selector) {
      if (selector === 'article') return nodes;
      return [];
    },
  };
  assert.deepEqual(readChatGptConversation(document).map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Pregunta antigua' },
    { role: 'assistant', content: 'Respuesta antigua' },
  ]);
});

test('usa data-turn cuando no existen nodos con data-message-author-role', () => {
  const nodes = [
    { ...message('', 'Pregunta'), getAttribute: (name) => name === 'data-turn' ? 'user' : null },
    { ...message('', 'Respuesta'), getAttribute: (name) => name === 'data-turn' ? 'assistant' : null },
  ];
  const document = {
    querySelectorAll(selector) {
      if (selector === '[data-turn]') return nodes;
      return [];
    },
  };
  assert.deepEqual(readChatGptConversation(document).map(({ role }) => role), ['user', 'assistant']);
});

test('genera IDs diferentes para mensajes repetidos sin identificador nativo', () => {
  const nodes = [message('user', 'hola'), message('user', 'hola')];
  const document = { querySelectorAll: (selector) => selector === '[data-message-author-role]' ? nodes : [] };
  const turns = readChatGptConversation(document);
  assert.equal(turns.length, 2);
  assert.notEqual(turns[0].id, turns[1].id);
});

test('limita el tamaño por mensaje y marca el contenido recortado', () => {
  const nodes = [message('assistant', 'x'.repeat(10001))];
  const document = { querySelectorAll: (selector) => selector === '[data-message-author-role]' ? nodes : [] };
  const [turn] = readChatGptConversation(document);
  assert.equal(turn.content.length, 10000);
  assert.equal(turn.clipped, true);
});


test('mantiene el ID de respaldo cuando el texto de una respuesta sigue creciendo', () => {
  const first = message('assistant', 'a'.repeat(120) + ' parcial');
  const later = message('assistant', 'a'.repeat(120) + ' respuesta completa');
  const read = (node) => readChatGptConversation({
    querySelectorAll: (selector) => selector === '[data-message-author-role]' ? [node] : [],
  })[0].id;
  assert.equal(read(first), read(later));
});
