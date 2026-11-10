import test from 'node:test';
import assert from 'node:assert/strict';
import { selectChatGptMessages, diagnoseChatGptReader, isChatGptStreaming, readChatGptCode } from '../src/core/chatgptAdapter.js';
import { readChatGptConversation, watchChatGptConversation } from '../src/core/chatgptConversation.js';
import { readChatGptDpuAnswer } from '../src/core/chatgptDpu.js';

const selectors = { 'author-role': '[data-message-author-role]', 'data-turn': '[data-turn]',
  'conversation-turn': '[data-testid^="conversation-turn"]', article: 'article' };
function message(role, text, strategy) {
  const attrs = strategy === 'author-role' ? { 'data-message-author-role': role }
    : strategy === 'data-turn' ? { 'data-turn': role, 'data-turn-id': role + '-stable' }
      : { 'data-testid': 'conversation-turn-' + role };
  const body = { innerText: text };
  return { innerText: text, getAttribute: (name) => attrs[name], querySelector: (selector) => {
    if (selector === '.markdown') return role === 'assistant' ? body : null;
    if (selector === '.whitespace-pre-wrap') return role === 'user' ? body : null;
    if (selector.includes('[data-message-author-role="user"]')) return role === 'user' ? body : null;
    if (selector.includes('[data-message-author-role="assistant"]')) return role === 'assistant' ? body : null;
    return null;
  } };
}
function documentFor(strategy, nodes) {
  return { querySelectorAll: (selector) => selector === selectors[strategy] ? nodes : [] };
}

for (const strategy of Object.keys(selectors)) {
  test(`${strategy}: lector de conversación y DPU comparten selección; ambos roles y texto exacto`, () => {
    const userText = '  Usuario: ñ\n\n';
    const answer = '\nINICIO 😊\n  const x = "<script>no ejecutar</script>";\nFIN  \n';
    const nodes = [message('user', userText, strategy), message('assistant', answer, strategy)];
    const document = documentFor(strategy, nodes);
    const selected = selectChatGptMessages(document);
    assert.equal(selected.strategy, strategy);
    assert.deepEqual(selected.messages.map((entry) => entry.role), ['user', 'assistant']);
    const turns = readChatGptConversation(document, { literal: true });
    assert.deepEqual(turns.map((turn) => turn.content), [userText, answer]);
    assert.equal(readChatGptDpuAnswer(document, 'otro prompt para un historial antiguo').text, answer.trim());
    if (strategy === 'data-turn') assert.deepEqual(turns.map((turn) => turn.id), ['user-stable', 'assistant-stable']);
  });
}

test('la estrategia más precisa se prioriza sin volver a añadir los mismos nodos por article', () => {
  const nodes = [message('user', 'hola', 'author-role'), message('assistant', 'respuesta', 'author-role')];
  const document = { querySelectorAll: () => nodes };
  assert.equal(selectChatGptMessages(document).strategy, 'author-role');
  assert.equal(readChatGptConversation(document).length, 2);
});

test('outer elimina contenedores anidados para no duplicar el texto de un mismo mensaje', () => {
  const parent = message('assistant', 'respuesta única', 'author-role');
  const child = message('assistant', 'respuesta única', 'author-role');
  parent.contains = (node) => node === child;
  const document = documentFor('author-role', [parent, child]);
  assert.equal(readChatGptConversation(document).length, 1);
});

test('un selector con elementos de rol desconocido no oculta una estrategia válida posterior', () => {
  const invalid = { getAttribute: () => 'tool', querySelector: () => null };
  const nodes = [message('user', 'hola', 'data-turn'), message('assistant', 'bien', 'data-turn')];
  const document = { querySelectorAll: (selector) => selector === selectors['author-role'] ? [invalid]
    : selector === selectors['data-turn'] ? nodes : [] };
  assert.equal(selectChatGptMessages(document).strategy, 'data-turn');
});

test('no inventa roles por alternancia ni convierte artículos ajenos o mixtos en respuestas', () => {
  const unknown = { innerText: 'Esto no demuestra un rol', getAttribute() {}, querySelector() { return null; } };
  assert.deepEqual(selectChatGptMessages(documentFor('article', [unknown, unknown])), { strategy: 'none', messages: [] });
  const mixed = { getAttribute() {}, querySelector: () => ({}) };
  assert.equal(selectChatGptMessages(documentFor('article', [mixed])).strategy, 'none');
});

test('los IDs no cambian porque crezca la respuesta, y data-turn-id se conserva', () => {
  const node = message('assistant', 'A', 'data-turn');
  const document = documentFor('data-turn', [node]);
  const first = readChatGptConversation(document, { literal: true })[0];
  node.innerText = 'A más texto';
  assert.equal(readChatGptConversation(document, { literal: true })[0].id, first.id);
});

test('estado streaming distingue Stop/Detener/Parar de voz o dictado', () => {
  const button = (label, testId = '', disabled = false) => ({ disabled, getAttribute: (name) => name === 'aria-label' ? label : name === 'data-testid' ? testId : '' });
  for (const label of ['Stop generating', 'Detener respuesta', 'Parar respuesta']) {
    assert.equal(isChatGptStreaming({ querySelectorAll: () => [button(label)] }), true);
  }
  for (const label of ['Stop dictation', 'Detener dictado', 'Stop voice', 'Parar micrófono', 'Enviar mensaje']) {
    assert.equal(isChatGptStreaming({ querySelectorAll: () => [button(label)] }), false);
  }
  assert.equal(isChatGptStreaming({ querySelectorAll: () => [button('', 'stop-button')] }), true);
  assert.equal(isChatGptStreaming({ querySelectorAll: () => [button('Stop', '', true)] }), false);
});

test('diagnóstico sólo contiene estrategia y conteos, sin conversaciones, IDs, composer o ruta', () => {
  const secret = 'CONTENIDO PRIVADO NO DIAGNOSTICAR';
  const document = documentFor('article', [message('assistant', secret, 'article')]);
  const diagnostic = diagnoseChatGptReader(document);
  assert.equal(diagnostic.estrategia_mensajes, 'article');
  assert.equal(diagnostic.ia, 1);
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  assert.deepEqual(Object.keys(diagnostic).sort(), ['candidatos', 'estrategia_mensajes', 'ia', 'mensajes', 'transmitiendo', 'usuario']);
});

test('bloques pre/code conservan código y lenguaje sin modificar espacios ni Unicode', () => {
  const code = { className: 'language-c++', innerText: '  std::cout << "😊";\n' };
  const pre = { querySelector: () => code };
  assert.deepEqual(readChatGptCode({ querySelectorAll: () => [pre] }), [{ lang: 'c++', code: code.innerText }]);
});

test('el watcher publica estrategia alternativa con memoria apagada y conserva el límite de mensajes', () => {
  const nodes = Array.from({ length: 205 }, (_, index) => message(index % 2 ? 'assistant' : 'user', `mensaje ${index}`, 'data-turn'));
  const document = documentFor('data-turn', nodes);
  const live = [];
  const watcher = watchChatGptConversation({ document, window: { location: { href: 'https://chatgpt.com/c/old' } },
    isEnabled: () => false, publish() { throw Error('No guardar'); }, publishLive: (snapshot) => live.push(snapshot) });
  try {
    watcher.read();
    assert.equal(live[0].strategy, 'data-turn');
    assert.equal(live[0].turns.length, 200);
    assert.equal(live[0].clipped, true);
  } finally { watcher.disconnect(); }
});

test('article sin atributos de rol reconoce burbuja de usuario y Markdown, no usa paridad', () => {
  const user = { innerText: 'pregunta', getAttribute() {}, querySelector: (selector) => selector === '.whitespace-pre-wrap' ? { innerText: 'pregunta' } : null };
  const assistant = { innerText: 'respuesta', getAttribute() {}, querySelector: (selector) => selector === '.markdown' ? { innerText: 'respuesta' } : null };
  const document = documentFor('article', [assistant, user, assistant]);
  assert.deepEqual(selectChatGptMessages(document).messages.map((entry) => entry.role), ['assistant', 'user']);
  // Set elimina la misma referencia repetida; el rol procede del DOM, no del índice.
});

test('outer usa ancestros reales para descartar nodos anidados sin comparar todos los pares', () => {
  const parent = { ...message('assistant', 'una respuesta', 'author-role'), parentElement: null };
  const child = { ...message('assistant', 'una respuesta', 'author-role'), parentElement: parent };
  parent.contains = () => { throw Error('No recorrer todos los pares'); };
  assert.equal(selectChatGptMessages(documentFor('author-role', [parent, child])).messages.length, 1);
});
