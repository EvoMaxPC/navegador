import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatGptConversation, watchChatGptConversation } from '../src/core/chatgptConversation.js';
import { repetitionSnapshot } from '../src/core/conversationRepetition.js';

const node = (id, role, content) => ({ innerText: content, getAttribute: (key) => ({ 'data-message-id': id, 'data-message-author-role': role })[key], querySelector: () => null });

function watcher({ href = 'https://chatgpt.com/c/old-chat', enabled = false } = {}) {
  let nodes = [node('u', 'user', '  Mi pregunta\n\n'), node('a', 'assistant', '\n¡Respuesta! 😊\n  código\n')];
  const live = [], memory = [];
  const window = { location: { href }, addEventListener() {} };
  const document = { querySelectorAll: () => nodes, addEventListener() {} };
  const watch = watchChatGptConversation({ document, window, isEnabled: () => enabled,
    publish: (payload) => memory.push(payload), publishLive: (payload) => live.push(payload) });
  return { live, memory, watch, window, setNodes: (next) => { nodes = next; } };
}

test('lectura literal conserva espacios, saltos, Unicode y código; memoria conserva su contrato anterior', () => {
  const text = '\n  inicio\n\n```js\n  x < 2;\n```\n😊 fin  \n';
  const document = { querySelectorAll: () => [node('a', 'assistant', text)] };
  assert.equal(readChatGptConversation(document, { literal: true })[0].content, text);
  assert.equal(readChatGptConversation(document)[0].content, text.trim());
});

test('chat antiguo: publica usuario y asistente sin enviar un mensaje nuevo ni activar memoria', () => {
  const h = watcher();
  try {
    h.watch.read();
    assert.deepEqual(h.live[0].turns.map((turn) => turn.role), ['user', 'assistant']);
    assert.equal(h.live[0].turns[0].content, '  Mi pregunta\n\n');
    assert.equal(h.live[0].turns[1].content, '\n¡Respuesta! 😊\n  código\n');
    assert.equal(h.memory.length, 0);
  } finally { h.watch.disconnect(); }
});

test('durante la generación actualiza la misma respuesta y no publica snapshots idénticos', () => {
  const h = watcher();
  try {
    h.watch.read(); h.watch.read(); assert.equal(h.live.length, 1);
    h.setNodes([node('u', 'user', 'hola'), node('a', 'assistant', 'Respuesta parcial')]); h.watch.read();
    h.setNodes([node('u', 'user', 'hola'), node('a', 'assistant', 'Respuesta parcial y final.\n')]); h.watch.read();
    assert.equal(h.live.at(-1).turns.length, 2);
    assert.equal(h.live.at(-1).turns[1].id, 'a');
    assert.equal(h.live.at(-1).turns[1].content, 'Respuesta parcial y final.\n');
  } finally { h.watch.disconnect(); }
});

test('cambio SPA de conversación y chat nuevo vacío no arrastran el texto anterior', () => {
  const h = watcher();
  try {
    h.watch.read();
    h.window.location.href = 'https://chatgpt.com/'; h.setNodes([]); h.watch.read();
    assert.equal(h.live.at(-1).href, 'https://chatgpt.com/');
    assert.deepEqual(h.live.at(-1).turns, []);
  } finally { h.watch.disconnect(); }
});

test('no publica chats temporales ni sitios ajenos', () => {
  for (const href of ['https://chatgpt.com/?temporary-chat=true', 'https://example.com/c/x']) {
    const h = watcher({ href });
    try { h.watch.read(); assert.equal(h.live.length, 0); } finally { h.watch.disconnect(); }
  }
});

test('respuestas mayores de 10k se repiten sin el recorte de memoria; límites extremos son explícitos', () => {
  const h = watcher();
  try {
    const long = 'x'.repeat(18000); h.setNodes([node('a', 'assistant', long)]); h.watch.read();
    assert.equal(h.live[0].turns[0].content, long); assert.equal(h.live[0].turns[0].clipped, false);
    h.setNodes([node('a', 'assistant', 'x'.repeat(200001))]); h.watch.read();
    assert.equal(h.live.at(-1).turns[0].clipped, true);
    assert.equal(repetitionSnapshot(h.live.at(-1)).clipped, true);
  } finally { h.watch.disconnect(); }
});

test('el receptor valida roles, longitud y estructura sin interpretar HTML ni modificar texto', () => {
  const content = '<img src=x onerror=alert(1)>\n  no ejecutar 😊';
  assert.equal(repetitionSnapshot({ turns: [{ id: 'a', role: 'assistant', content }] }).turns[0].content, content);
  for (const turns of [[{ id: 'x', role: 'system', content: 'x' }], [{ id: 'a', role: 'assistant', content: 42 }],
    [{ id: 'a', role: 'assistant', content: 'x'.repeat(200001) }], Array(201).fill({ id: 'a', role: 'user', content: 'x' })]) {
    assert.equal(repetitionSnapshot({ turns }), null);
  }
});
