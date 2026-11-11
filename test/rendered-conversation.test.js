import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/main/engine.js';
import { DEFAULT_SETTINGS } from '../src/core/settings.js';
import { createConversationSaveQueue } from '../src/preload/conversationSaveQueue.js';
import { watchChatGptConversation } from '../src/core/chatgptConversation.js';

const href = 'https://chatgpt.com/c/render-test';
const user = { id: 'u', role: 'user', content: 'pregunta' };
const snapshot = (text, streaming = true, id = 'a') => ({ href, streaming, turns: [user, ...(text ? [{ id, role: 'assistant', content: text }] : [])] });
const engine = () => new Engine({ store: { settings: structuredClone(DEFAULT_SETTINGS), pushLog() {} } });
const send = (e, id = 'm1') => e.onUserMessage(1, { messageId: id, source: 'composer', host: 'chatgpt.com', tokens: 7 });
const close = (e, text, id = 'm1') => e.onStreamEnd(1, { messageId: id, text, host: 'chatgpt.com', site: 'chatgpt', finished: true });

test('palabras renderizadas suben durante generación, no al abrir historiales', () => {
  const e = engine();
  e.onRenderedConversation(1, snapshot('historial viejo'), null);
  assert.equal(e.stats().outputTokens, 0);
  send(e);
  let previous = snapshot('');
  for (const [text, expected] of [['Ho', 1], ['Hola', 1], ['Hola mundo', 2], ['Hola mundo otra palabra', 4]]) {
    const next = snapshot(text); e.onRenderedConversation(1, next, previous); previous = next;
    assert.equal(e.stats().outputTokens, expected);
    assert.equal(e.stats().responses, 0);
  }
  const next = snapshot(previous.turns[1].content, false);
  e.onRenderedConversation(1, next, previous);
  assert.equal(e.stats().outputTokens, 4); assert.equal(e.stats().responses, 1);
  close(e, '**Hola** mundo otra palabra');
  assert.equal(e.stats().outputTokens, 4); assert.equal(e.stats().responses, 1);
  assert.equal(e.stats().inputTokens, 0);
  assert.equal(e.stats().estimatedInputTokens, 7);
});

test('SSE y DOM intercalados no concatenan dos copias; DOM es la estimación visible del mismo envío', () => {
  const e = engine(); send(e);
  e.onStreamProgress(1, { messageId: 'm1', text: 'Hola **mundo** ', host: 'chatgpt.com' });
  e.onRenderedConversation(1, snapshot('Hola mundo'), snapshot(''));
  e.onStreamProgress(1, { messageId: 'm1', text: 'más texto' });
  assert.equal(e.stats().outputTokens, 2);
  e.onRenderedConversation(1, snapshot('Hola mundo más texto'), snapshot('Hola mundo'));
  assert.equal(e.stats().outputTokens, 4);
  close(e, 'Hola **mundo** más texto');
  assert.equal(e.stats().outputTokens, 4); assert.equal(e.stats().responses, 1);
  e.onCdpCapture(1, { messageId: 'm1', text: 'Hola **mundo** más texto', host: 'chatgpt.com', site: 'chatgpt' });
  assert.equal(e.stats().outputTokens, 4); assert.equal(e.stats().responses, 1);
});

test('CDP puede cerrar antes del DOM final sin duplicar el provisional; DOM puede corregir a menos palabras', () => {
  const e = engine(); send(e);
  e.onRenderedConversation(1, snapshot('uno dos'), snapshot(''));
  e.onCdpCapture(1, { messageId: 'm1', text: 'uno dos tres cuatro', host: 'chatgpt.com', site: 'chatgpt' });
  assert.equal(e.stats().outputTokens, 2); assert.equal(e.stats().responses, 1);
  e.onRenderedConversation(1, snapshot('uno dos tres cuatro', false), snapshot('uno dos'));
  assert.equal(e.stats().outputTokens, 4); assert.equal(e.stats().responses, 1);
  e.onRenderedConversation(1, snapshot('uno dos', false), snapshot('uno dos tres cuatro', false));
  assert.equal(e.stats().outputTokens, 2);
});

test('red antes de DOM: reconcilia Markdown distinto por identidad, sin sumar otra respuesta', () => {
  const e = engine(); send(e); close(e, 'uno dos tres cuatro');
  e.onRenderedConversation(1, snapshot('uno dos', false), snapshot(''));
  assert.equal(e.stats().outputTokens, 2); assert.equal(e.stats().responses, 1);
  close(e, 'uno dos tres cuatro');
  assert.equal(e.stats().outputTokens, 2); assert.equal(e.stats().responses, 1);
});

test('dos respuestas iguales de envíos distintos cuentan dos veces; stop sobre respuesta anterior no suma', () => {
  const e = engine(); send(e);
  e.onRenderedConversation(1, snapshot('hola', false), snapshot(''));
  send(e, 'm2');
  e.onRenderedConversation(1, snapshot('hola', true), snapshot('hola', false));
  assert.equal(e.stats().outputTokens, 1);
  const prior = { href, streaming: true, turns: [...snapshot('hola', false).turns, { ...user, id: 'u2' }] };
  const next = { ...prior, streaming: false, turns: [...prior.turns, { id: 'a2', role: 'assistant', content: 'hola' }] };
  e.onRenderedConversation(1, next, prior);
  assert.equal(e.stats().outputTokens, 2); assert.equal(e.stats().responses, 2);
});

test('cancelación conserva exactamente un resultado y el DOM parcial no la reclasifica', () => {
  const e = engine(); send(e);
  e.onRenderedConversation(1, snapshot('uno dos'), snapshot(''));
  e.onTurnResult(1, { messageId: 'm1', host: 'chatgpt.com', outcome: 'cancelled' });
  e.onRenderedConversation(1, snapshot('uno dos', false), snapshot('uno dos'));
  assert.equal(e.stats().turnsCancelled, 1); assert.equal(e.stats().outputTokens, 2);
});

test('una ráfaga de mutaciones publica una sola copia en el próximo rAF, sin esperar 500 ms', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let mutation, frame, text = 'Hola'; const live = [];
  const document = { querySelectorAll: selector => selector === '[data-message-author-role]' ? [{ getAttribute: () => 'assistant', get innerText() { return text; } }] : [] };
  const window = { location: { href }, requestAnimationFrame(fn) { frame = fn; return 1; }, cancelAnimationFrame() {},
    MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} disconnect() {} } };
  const w = watchChatGptConversation({ document, window, isEnabled: () => false, publish() {}, publishLive: p => live.push(p) });
  try {
    frame(); live.length = 0;
    for (let i = 0; i < 100; i++) { text = `respuesta ${i}`; mutation(); }
    assert.equal(live.length, 0);
    frame(); assert.equal(live.length, 1); assert.equal(live[0].turns[0].content, 'respuesta 99');
  } finally { w.disconnect(); }
});

test('guardado agrupa revisiones y confirma la última sin 60 escrituras por segundo', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = [];
  const queue = createConversationSaveQueue(p => { saved.push(p); return { ok: true }; });
  const receipts = [];
  for (let i = 0; i < 100; i++) receipts.push(queue.publish(snapshot(`texto ${i}`)));
  assert.equal(saved.length, 0); t.mock.timers.tick(500);
  const results = await Promise.all(receipts);
  assert.equal(saved.length, 1); assert.equal(saved[0].turns[1].content, 'texto 99');
  assert.ok(results.every(result => result.ok)); queue.cancel();
});

test('el cambio de documento y snapshots recortados no inventan palabras históricas', () => {
  const e = engine(); send(e);
  e.onRenderedConversation(1, { ...snapshot('otra conversación'), href: 'https://chatgpt.com/c/otra' }, snapshot(''));
  e.onRenderedConversation(1, { ...snapshot('texto recortado'), clipped: true }, snapshot(''));
  assert.equal(e.stats().outputTokens, 0); assert.equal(e.stats().responses, 0);
});

test('la cancelación de guardado pendiente respeta memoria apagada y no deja una escritura tardía', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = [], queue = createConversationSaveQueue(p => saved.push(p));
  const delivery = queue.publish(snapshot('no escribir')); queue.cancel();
  t.mock.timers.tick(1000); await Promise.resolve();
  assert.equal(saved.length, 0); assert.equal((await delivery).ok, false);
});

test('pagehide puede vaciar la cola sin esperar a la siguiente escritura agrupada', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = [], queue = createConversationSaveQueue(p => { saved.push(p); return { ok: true }; });
  const delivery = queue.publish(snapshot('parcial al salir'));
  queue.flush(); await delivery;
  assert.equal(saved.length, 1); assert.equal(saved[0].turns[1].content, 'parcial al salir');
  queue.cancel();
});


test('alias del mismo envío no reinicia el provisional DOM ni duplica palabras', () => {
  const e = engine(); send(e);
  e.messageAliases.set('1|request-alias', 'm1');
  e.onRenderedConversation(1, snapshot('uno dos'), snapshot(''));
  e.onStreamProgress(1, { messageId: 'request-alias', text: 'uno dos tres', host: 'chatgpt.com' });
  assert.equal(e.stats().outputTokens, 2);
  close(e, 'uno dos tres', 'request-alias');
  assert.equal(e.stats().outputTokens, 2); assert.equal(e.stats().responses, 1);
});

test('red sin texto antes del DOM recupera palabras de la respuesta ya contada', () => {
  const e = engine(); send(e); e.onNetworkResponse(1, { host: 'chatgpt.com' });
  assert.equal(e.stats().responses, 1);
  e.onRenderedConversation(1, snapshot('uno dos', false), snapshot(''));
  assert.equal(e.stats().outputTokens, 2); assert.equal(e.stats().responses, 1);
  close(e, 'uno dos tres cuatro');
  assert.equal(e.stats().outputTokens, 2); assert.equal(e.stats().responses, 1);
});
