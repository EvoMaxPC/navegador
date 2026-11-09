/**
 * Lectura CDP: de frames de WebSocket y cuerpos JSON a texto de conversación.
 *
 * Estos casos usan las formas reales que se ven en el cable de los proveedores
 * (parches de ChatGPT, `content_block_delta` de Claude, deltas y acumulados
 * estilo OpenAI) y comprueban lo que más fácil se rompe: que el texto no se
 * duplique, que el eco del usuario no se cuente como respuesta y que la captura
 * quede bien atada a su conversación.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CdpCapture,
  MAX_CAPTURE_CHARS,
  hostOf,
  isAiHost,
  isJsonMime,
  isStreamMime,
  promptOf,
  roleOf,
  terminalOf,
} from '../src/core/cdp.js';
import { detectSite } from '../src/core/sites.js';

const TEXTO =
  'La capa CDP observa dos canales que el enganche de fetch no alcanza: frames de WebSocket y respuestas JSON completas. ' +
  'Todo lo que captura ya llegó al sitio, así que se registra como observación y nunca como intervención.';

function chunk(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ */
/* clasificación                                                       */
/* ------------------------------------------------------------------ */

test('hostOf e isAiHost: sólo los sitios con perfil se observan', () => {
  assert.equal(hostOf('https://chatgpt.com/backend-api/conversation'), 'chatgpt.com');
  assert.equal(hostOf('https://www.claude.ai/chat/abc'), 'claude.ai');
  assert.equal(hostOf('no es una url'), '');
  assert.equal(hostOf(''), '');

  assert.equal(isAiHost('chatgpt.com'), true);
  assert.equal(isAiHost('claude.ai'), true);
  assert.equal(isAiHost('example.com'), false);
  assert.equal(isAiHost(''), false);
});

test('isJsonMime e isStreamMime separan JSON completo de stream', () => {
  assert.equal(isJsonMime('application/json'), true);
  assert.equal(isJsonMime('application/json; charset=utf-8'), true);
  assert.equal(isJsonMime('application/vnd.api+json'), true);
  assert.equal(isJsonMime('text/event-stream'), false);
  assert.equal(isJsonMime(''), false);

  // El stream ya lo media la página: si CDP lo tomara también, se contaría dos veces.
  assert.equal(isStreamMime('text/event-stream'), true);
  assert.equal(isStreamMime('application/x-ndjson'), true);
  assert.equal(isStreamMime('application/json'), false);

  // Y un `+json` que en realidad es un stream también se descarta.
  assert.equal(isStreamMime('application/stream+json'), false);
  assert.equal(isJsonMime('application/stream+json'), true);
});

test('terminalOf reconoce los cierres de cada protocolo', () => {
  assert.equal(terminalOf({ type: 'message_stop' }), 'message_stop');
  assert.equal(terminalOf({ status: 'finished_successfully' }), 'finished_successfully');
  assert.equal(terminalOf({ choices: [{ finish_reason: 'stop' }] }), 'stop');
  assert.equal(terminalOf({ type: 'message_delta', delta: { stop_reason: null } }), null);
  assert.equal(terminalOf({ type: 'content_block_delta' }), null);
  assert.equal(terminalOf({}), null);
});

test('roleOf encuentra el rol venga donde venga', () => {
  assert.equal(roleOf({ role: 'assistant' }), 'assistant');
  assert.equal(roleOf({ author: { role: 'user' } }), 'user');
  assert.equal(roleOf({ message: { author: { role: 'assistant' } } }), 'assistant');
  assert.equal(roleOf({ choices: [{ message: { role: 'assistant' } }] }), 'assistant');
  assert.equal(roleOf({ delta: 'hola' }), null);
});

test('promptOf sólo acepta mensajes de usuario inequívocos', () => {
  assert.equal(promptOf({ messages: [{ role: 'user', content: 'mi pregunta' }] }), 'mi pregunta');
  assert.equal(
    promptOf({ messages: [{ author: { role: 'user' }, content: { parts: ['con adjunto', 'texto'] } }] }),
    'texto',
  );
  assert.equal(promptOf({ prompt: 'otra pregunta' }), 'otra pregunta');
  assert.equal(promptOf({ type: 'user_message', content: 'desde el frame' }), 'desde el frame');

  // Lo que no es del usuario no se inventa: un `content` suelto no alcanza.
  assert.equal(promptOf({ content: 'esto es la respuesta del modelo' }), null);
  assert.equal(promptOf({ messages: [{ role: 'assistant', content: 'hola' }] }), null);
  assert.equal(promptOf({ model: 'gpt-4o' }), null);
  assert.equal(promptOf(null), null);
});

/* ------------------------------------------------------------------ */
/* acumulación                                                         */
/* ------------------------------------------------------------------ */

test('ChatGPT por WebSocket: los parches se leen con el mismo adaptador que el SSE', () => {
  const site = detectSite('chatgpt.com');
  const capture = new CdpCapture({ site, host: 'chatgpt.com', conversationId: 'chatgpt#1#ws' });

  capture.add({ p: '/message', o: 'add', v: { author: { role: 'assistant' }, content: { parts: [''] } } });
  for (const piece of chunk(TEXTO, 17)) {
    capture.add({ p: '/message/content/parts/0', o: 'append', v: piece });
  }
  const status = capture.add({ p: '/message/status', o: 'replace', v: 'finished_successfully' });

  assert.equal(capture.text, TEXTO);
  assert.equal(status.terminal, 'message');

  const turn = capture.take();
  assert.equal(turn.text, TEXTO);
  assert.equal(turn.source, 'websocket');
  assert.equal(turn.site, 'chatgpt');
  assert.equal(turn.seq, 1);
  assert.equal(capture.text, '', 'el acumulador queda limpio para el turno siguiente');
});

test('ChatGPT acumulado: el frame que repite el texto completo no lo duplica', () => {
  const capture = new CdpCapture({ site: detectSite('chatgpt.com'), host: 'chatgpt.com' });
  let acumulado = '';
  for (const piece of chunk(TEXTO, 23)) {
    acumulado += piece;
    capture.add({
      message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: [acumulado] } },
    });
  }
  assert.equal(capture.text, TEXTO);
});

test('Claude por WebSocket: contenido y cierre con el adaptador de Claude', () => {
  const capture = new CdpCapture({ site: detectSite('claude.ai'), host: 'claude.ai' });
  capture.add({ type: 'message_start', message: { role: 'assistant' } });
  for (const piece of chunk(TEXTO, 13)) {
    capture.add({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
  }
  const stop = capture.add({ type: 'message_stop' });
  assert.equal(capture.text, TEXTO);
  assert.ok(stop.terminal, 'message_stop tiene que cerrar el turno');
});

test('Formato OpenAI genérico: deltas, acumulado y cierre', () => {
  const capture = new CdpCapture({ host: 'example.com' });
  for (const piece of chunk(TEXTO, 11)) {
    capture.add({ choices: [{ delta: { content: piece } }] });
  }
  assert.equal(capture.text, TEXTO);
  assert.equal(capture.frames, chunk(TEXTO, 11).length);

  // El mismo turno por el camino acumulado: no se repite nada.
  const acumulado = new CdpCapture({ host: 'example.com' });
  let texto = '';
  for (const piece of chunk(TEXTO, 19)) {
    texto += piece;
    acumulado.add({ choices: [{ message: { role: 'assistant', content: texto } }] });
  }
  assert.equal(acumulado.text, TEXTO);
});

test('Un cuerpo JSON completo (sin SSE) se lee entero y cierra el turno', () => {
  const capture = new CdpCapture({
    site: detectSite('chatgpt.com'),
    host: 'chatgpt.com',
    source: 'json',
    conversationId: 'chatgpt#1#req',
  });
  const { added, terminal } = capture.add({
    choices: [{ message: { role: 'assistant', content: TEXTO }, finish_reason: 'stop' }],
  });
  assert.equal(added, TEXTO);
  assert.equal(terminal, 'stop');
  const turn = capture.take();
  assert.equal(turn.text, TEXTO);
  assert.equal(turn.source, 'json');
});

test('El eco del usuario no se cuenta como respuesta', () => {
  const capture = new CdpCapture({ host: 'chatgpt.com', site: detectSite('chatgpt.com') });
  capture.add({ message: { author: { role: 'user' }, content: { parts: ['mi pregunta'] } } });
  capture.add({ choices: [{ delta: { content: 'respuesta' } }] });
  assert.equal(capture.text, 'respuesta');

  // Y si el frame del usuario trae el prompt, se guarda como prompt, no como texto.
  const otra = new CdpCapture({ host: 'chatgpt.com', site: detectSite('chatgpt.com') });
  otra.prompt(promptOf({ messages: [{ role: 'user', content: 'mi pregunta' }] }));
  otra.add({ choices: [{ delta: { content: 'respuesta' } }] });
  const turn = otra.take();
  assert.equal(turn.text, 'respuesta');
  assert.equal(turn.prompt, 'mi pregunta');
});

test('take() vacía el acumulador, numera los turnos y no inventa capturas vacías', () => {
  const capture = new CdpCapture({ site: detectSite('claude.ai'), host: 'claude.ai' });
  assert.equal(capture.take(), null, 'sin texto no hay turno');

  capture.add({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'uno' } });
  assert.equal(capture.take().seq, 1);
  capture.add({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'dos' } });
  const segundo = capture.take();
  assert.equal(segundo.text, 'dos');
  assert.equal(segundo.seq, 2);

  // El prompt se consume con el turno: no contamina el siguiente.
  capture.prompt('pregunta uno');
  capture.add({ choices: [{ delta: { content: 'a' } }] });
  assert.equal(capture.take().prompt, 'pregunta uno');
  capture.add({ choices: [{ delta: { content: 'b' } }] });
  assert.equal(capture.take().prompt, null);
});

test('Una captura desmedida se descarta en vez de guardar media respuesta', () => {
  const capture = new CdpCapture({ host: 'chatgpt.com' });
  const enorme = 'x'.repeat(MAX_CAPTURE_CHARS + 10);
  const result = capture.add({ choices: [{ delta: { content: enorme } }] });
  assert.equal(result.added, '');
  assert.equal(result.overflow, true);
  assert.equal(capture.text, '');
});
