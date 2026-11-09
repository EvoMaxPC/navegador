import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/main/memory.js';
import { EvoMemory } from '../src/memory/engine.js';
import { isChatGptMemoryUrl, readChatGptConversation } from '../src/core/chatgptConversation.js';

const node = (id, role, text, markdown = null) => ({
  innerText: text,
  getAttribute: (key) => ({ 'data-message-author-role': role, 'data-message-id': id })[key],
  querySelector: () => markdown === null ? null : { innerText: markdown },
});

test('lector conserva roles, IDs y Markdown; no lee composer ni botones', () => {
  const doc = { querySelectorAll: (selector) => {
    assert.equal(selector, '[data-message-author-role]');
    return [node('u1', 'user', 'Hola'), node('a1', 'assistant', 'respuesta\nCopiar', '**Respuesta**\ncon código.'), node('s1', 'system', 'ignorar')];
  } };
  assert.deepEqual(readChatGptConversation(doc), [
    { id: 'u1', role: 'user', content: 'Hola', clipped: false },
    { id: 'a1', role: 'assistant', content: '**Respuesta**\ncon código.', clipped: false },
  ]);
});

test('lector limita mensajes y longitud y declara el recorte', () => {
  const turns = readChatGptConversation({ querySelectorAll: () => Array.from({ length: 205 }, (_, i) => node(`m${i}`, 'assistant', 'x'.repeat(10001))) });
  assert.equal(turns.length, 200);
  assert.equal(turns[0].id, 'm5');
  assert.equal(turns[0].content.length, 10000);
  assert.equal(turns[0].clipped, true);
});

test('sólo lee ChatGPT HTTPS; excluye chats temporales y otros sitios', () => {
  for (const url of ['https://chatgpt.com/c/abc', 'https://chat.openai.com/c/abc']) assert.equal(isChatGptMemoryUrl(url), true);
  for (const url of ['https://chatgpt.com/?temporary-chat=true', 'https://chatgpt.com.evil.test/c/a', 'http://chatgpt.com', 'https://example.com', 'bad']) assert.equal(isChatGptMemoryUrl(url), false);
});

test('conversación completa y mensajes cortos persisten tras reabrir sin destruir memorias previas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexo-conversation-'));
  try {
    const { memory, file } = createMemory({ dir });
    memory.remember({ role: 'user', content: 'Decidimos mantener la memoria anterior de Mercurio.' });
    const data = { conversationId: '/c/persistencia', url: 'https://chatgpt.com/c/persistencia', turns: [
      { id: 'u', role: 'user', content: 'Hola' },
      { id: 'a', role: 'assistant', content: '¡Hola!\n\nDecidimos usar PostgreSQL para la biblioteca.' },
    ] };
    assert.equal(memory.captureConversation(data).ok, true);
    assert.equal(memory.captureConversation(data).changed, 0);
    assert.equal(memory.listConversations()[0].turns.length, 2);
    const reopened = createMemory({ dir }).memory;
    assert.equal(reopened.listConversations()[0].turns[0].content, 'Hola');
    assert.equal(reopened.listConversations()[0].turns[1].content, data.turns[1].content);
    assert.ok(reopened.list().some((item) => /Mercurio/.test(item.text)));
    assert.ok(reopened.recall('PostgreSQL biblioteca').some((entry) => /PostgreSQL/.test(entry.item.text)));
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).conversations.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parcial, revisión final y repetición actualizan el mismo mensaje sin perder turnos de otra conversación', () => {
  const memory = new EvoMemory();
  const capture = (id, text, streaming) => memory.captureConversation({ conversationId: id, url: 'https://chatgpt.com', streaming,
    turns: [{ id: 'same', role: 'assistant', content: text }] });
  capture('/c/uno', 'Queda pendiente migrar', true);
  assert.equal(memory.list().length, 0, 'el parcial se archiva sin destilar');
  capture('/c/dos', 'Otra conversación', false);
  capture('/c/uno', 'Queda pendiente migrar Aurora a producción.', false);
  const metrics = memory.metrics.turnsIngested;
  assert.equal(capture('/c/uno', 'Queda pendiente migrar Aurora a producción.', false).changed, 0);
  assert.equal(memory.metrics.turnsIngested, metrics);
  const turns = memory.listConversations().find((c) => c.conversationId === '/c/uno').turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].content, 'Queda pendiente migrar Aurora a producción.');
  assert.equal(memory.listConversations().length, 2);
});

test('fallo de escritura es observable y conserva el estado pendiente de guardar', () => {
  const memory = new EvoMemory({ storage: { read: () => null, write() { throw new Error('disco lleno'); } } });
  const result = memory.captureConversation({ conversationId: '/c/error', url: 'https://chatgpt.com', streaming: true,
    turns: [{ id: 'u', role: 'user', content: 'Texto real' }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /disco/);
  assert.equal(memory.store.dirty, true);
});
