import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/main/engine.js';
import { DEFAULT_SETTINGS } from '../src/core/settings.js';
import { turnOutcome, outcomeFromEvent } from '../src/core/turnOutcome.js';

const fields = ['turnsCompleted', 'turnsCancelled', 'turnsFailed', 'turnsPerformed'];
function engine() {
  const events = [];
  const store = { settings: structuredClone(DEFAULT_SETTINGS), log: [], pushLog(entry) { this.log.push(entry); } };
  return new Engine({ store, onEvent: (event) => events.push(event) });
}
const values = (e) => fields.map((key) => e.stats()[key]);
function send(e, id, tab = 1, extra = {}) {
  e.onUserMessage(tab, { messageId: id, host: 'chatgpt.com', source: 'request', chars: 4, tokens: 2, ...extra });
}
function finish(e, id, extra = {}, tab = 1) {
  return e.onStreamEnd(tab, { messageId: id, host: 'chatgpt.com', site: 'chatgpt', text: 'Respuesta de la IA.', finished: true, ...extra });
}

test('los cuatro contadores nacen en cero y no existen métricas de bucles', () => {
  const e = engine();
  assert.deepEqual(values(e), [0, 0, 0, 0]);
  for (const key of ['turns', 'loops', 'loopsSeen', 'loopsCut']) assert.equal(Object.hasOwn(e.stats(), key), false);
  assert.equal(Object.hasOwn(e.stats().cdp, 'loops'), false);
});

for (const [name, payload, expected] of [
  ['normal', {}, [1, 0, 0, 0]],
  ['Stop confirmado', { stoppedByUser: true, interrupted: true, finished: false }, [0, 1, 0, 0]],
  ['error de generación', { outcome: 'failed' }, [0, 0, 1, 0]],
  ['interrupción ambigua', { interrupted: true, finished: false }, [0, 0, 0, 1]],
  ['corte del centinela, no del usuario', { stopped: true }, [0, 0, 0, 1]],
]) {
  test(`${name}: un único resultado, incluso con cierre y CDP repetidos`, () => {
    const e = engine();
    send(e, 'one');
    finish(e, 'one', payload);
    const before = e.stats();
    finish(e, 'one', payload);
    e.onCdpCapture(1, { messageId: 'one', host: 'chatgpt.com', text: 'Respuesta de la IA.', outcome: turnOutcome({ finished: true, ...payload }) });
    assert.deepEqual(values(e), expected);
    assert.equal(e.stats().responses, 1);
    assert.equal(e.stats().outputTokens, before.outputTokens);
    assert.equal(e.stats().inputTokens, before.inputTokens);
  });
}

test('clasifica señales, no heurísticas del texto ni AbortError como Stop', () => {
  assert.equal(turnOutcome({ interrupted: true, errorName: 'AbortError' }), 'unknown');
  assert.equal(turnOutcome({ stopped: true, finished: true }), 'unknown');
  assert.equal(turnOutcome({ stoppedByUser: true, error: 'AbortError' }), 'cancelled');
  assert.equal(outcomeFromEvent({ type: 'error', error: { message: 'generation failed' } }), 'failed');
  assert.equal(outcomeFromEvent({ type: 'control', detail: { kind: 'terminal-received', terminalKind: 'cancelled' } }), 'cancelled');
  assert.equal(outcomeFromEvent({ type: 'message_stream_complete' }), 'completed');
  assert.equal(outcomeFromEvent({ v: { message: { status: 'finished_successfully', metadata: { is_message_fragment: true } } } }), null);
});

test('red sin cuerpo queda desconocida; la confirmación tardía mueve el mismo turno', () => {
  const e = engine();
  send(e, 'net');
  e.onNetworkResponse(1, { messageId: 'net', host: 'chatgpt.com' });
  assert.deepEqual(values(e), [0, 0, 0, 1]);
  const before = e.stats();
  finish(e, 'net');
  assert.deepEqual(values(e), [1, 0, 0, 0]);
  assert.equal(e.stats().responses, before.responses);
  finish(e, 'net');
  assert.deepEqual(values(e), [1, 0, 0, 0]);
});

test('Stop actualiza el resultado inmediatamente y no modifica tokens ni actividad', () => {
  const e = engine();
  send(e, 'stop');
  const before = e.stats();
  e.onTurnResult(1, { messageId: 'stop', host: 'chatgpt.com', stoppedByUser: true });
  assert.deepEqual(values(e), [0, 1, 0, 0]);
  assert.equal(e.stats().inputTokens, before.inputTokens);
  assert.equal(e.stats().outputTokens, before.outputTokens);
  assert.equal(e.stats().responses, before.responses);
  assert.equal(e.stats().interventions, before.interventions);
  finish(e, 'stop', { interrupted: true, finished: false });
  assert.deepEqual(values(e), [0, 1, 0, 0]);
});

test('fallos correlacionados de generación se cuentan aunque se repita el diagnóstico', () => {
  const e = engine();
  for (const id of ['error-a', 'error-b']) {
    send(e, id);
    const failure = { messageId: id, host: 'chatgpt.com', url: 'https://chatgpt.com/backend-api/f/conversation', chat: true, kind: 'http', status: 500 };
    e.onCdpFailure(1, failure);
    e.onCdpFailure(1, failure);
  }
  assert.deepEqual(values(e), [0, 0, 2, 0]);
  e.onCdpFailure(1, { host: 'chatgpt.com', url: 'https://chatgpt.com/api/telemetry', kind: 'http', status: 500 });
  assert.deepEqual(values(e), [0, 0, 2, 0]);
});

test('aborto CDP no confirmado y cierre de pestaña suman un solo desconocido', () => {
  const e = engine();
  send(e, 'abort');
  e.onCdpFailure(1, { messageId: 'abort', host: 'chatgpt.com', chat: true, kind: 'net', errorText: 'net::ERR_ABORTED', canceled: true });
  e.onTurnInterrupted(1);
  e.dropTab(1);
  assert.deepEqual(values(e), [0, 0, 0, 1]);
});

test('varios envíos iguales, pestañas y resultados no se mezclan', () => {
  const e = engine();
  send(e, 'same-id', 1);
  send(e, 'same-id', 2);
  finish(e, 'same-id', {}, 2);
  finish(e, 'same-id', { stoppedByUser: true }, 1);
  for (let i = 0; i < 5; i++) {
    send(e, `next-${i}`);
    finish(e, `next-${i}`);
  }
  assert.deepEqual(values(e), [6, 1, 0, 0]);
});

test('un envío nuevo clasifica la interrupción anterior sin confirmar como desconocida', () => {
  const e = engine();
  send(e, 'previous');
  send(e, 'next');
  finish(e, 'next');
  assert.deepEqual(values(e), [1, 0, 0, 1]);
});

test('IDs alternativos del mismo envío no crean resultados paralelos', () => {
  const e = engine();
  send(e, 'page', 1, { promptHash: 'hash', source: 'request' });
  send(e, 'cdp', 1, { promptHash: 'hash', source: 'cdp' });
  finish(e, 'cdp');
  finish(e, 'page');
  assert.deepEqual(values(e), [1, 0, 0, 0]);
});

test('CDP primero y cierre con otro ID después comparten la deduplicación del texto', () => {
  const e = engine();
  send(e, 'cdp-send');
  e.onCdpCapture(1, { messageId: 'cdp-send', host: 'chatgpt.com', text: 'Respuesta de la IA.', outcome: 'completed' });
  finish(e, 'page-stream');
  assert.deepEqual(values(e), [1, 0, 0, 0]);
});

test('otros proveedores no modifican los resultados de ChatGPT', () => {
  const e = engine();
  e.onUserMessage(1, { messageId: 'claude', host: 'claude.ai', chars: 4, tokens: 1 });
  e.onStreamEnd(1, { messageId: 'claude', host: 'claude.ai', finished: true, text: 'Respuesta.' });
  assert.deepEqual(values(e), [0, 0, 0, 0]);
  assert.equal(e.stats().responses, 1);
});

test('envío de worker (-1), CDP en webview y cierre de página no duplican el resultado', () => {
  const e = engine();
  send(e, 'worker', -1);
  e.onCdpCapture(9, { host: 'chatgpt.com', text: 'Respuesta de la IA.', outcome: 'completed' });
  finish(e, 'page-id', {}, 9);
  assert.deepEqual(values(e), [1, 0, 0, 0]);
  assert.equal(e.stats().responses, 1);
});

test('regeneraciones idénticas son turnos distintos, sin otro mensaje de entrada', () => {
  const e = engine();
  send(e, 'original');
  finish(e, 'original');
  const before = e.stats();
  for (const messageId of ['regen-a', 'regen-b']) {
    e.onTurnStarted(1, { site: 'chatgpt', host: 'chatgpt.com', messageId });
    finish(e, messageId);
    finish(e, messageId);
  }
  assert.deepEqual(values(e), [3, 0, 0, 0]);
  assert.equal(e.stats().messages, before.messages);
  assert.equal(e.stats().inputTokens, before.inputTokens);
});

test('cancelación confirmada tardía suma +1 cancelado y mueve el mismo turno, sin duplicados', () => {
  const e = engine();
  send(e, 'late-stop');
  e.onNetworkResponse(1, { messageId: 'late-stop', host: 'chatgpt.com' });
  assert.deepEqual(values(e), [0, 0, 0, 1]);
  const before = e.stats();
  for (let i = 0; i < 3; i++) {
    e.onTurnResult(1, { messageId: 'late-stop', host: 'chatgpt.com', stoppedByUser: true });
  }
  assert.deepEqual(values(e), [0, 1, 0, 0]);
  assert.equal(e.stats().turnsCancelled - before.turnsCancelled, 1);
  assert.equal(e.stats().inputTokens, before.inputTokens);
  assert.equal(e.stats().outputTokens, before.outputTokens);
  assert.equal(Object.hasOwn(e.stats(), 'turnsUnknown'), false, 'el nombre anterior ya no se expone');
  finish(e, 'late-stop', { interrupted: true, finished: false });
  assert.deepEqual(values(e), [0, 1, 0, 0]);
});
