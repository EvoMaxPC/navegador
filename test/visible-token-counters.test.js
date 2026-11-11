import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/main/engine.js';
import { DEFAULT_SETTINGS } from '../src/core/settings.js';
import { inputTokenMeasurement } from '../src/main/tokens.js';
import { countGptTokens } from '../src/core/gptTokens.cjs';
import { VisibleOutputTokens } from '../src/main/visibleOutputTokens.js';
import { tokenCounterView } from '../src/ui/shell/tokenCounterView.js';
const official = JSON.parse(readFileSync(new URL('../docs/BPE-OFICIAL-COMPARACION.json', import.meta.url), 'utf8'));
const engine = () => new Engine({ store: { settings: structuredClone(DEFAULT_SETTINGS), pushLog() {} } });
const host = 'chatgpt.com';
const send = (e, id = 'm1', model = 'gpt-5', text = '  Pregunta 👩🏽‍💻\n') => e.onUserMessage(1, {
  messageId: id, submissionId: id, source: 'network', host, tokenText: text, textFound: true,
  ...inputTokenMeasurement(text, model, host),
});
const close = (e, text, id = 'm1', model = 'gpt-5') => e.onStreamEnd(1, { messageId: id, host, site: 'chatgpt', text, model, finished: true });
const href = 'https://chatgpt.com/c/fixture';
const snapshot = (text, streaming = true, id = 'a') => ({ href, streaming, turns: [{ id: 'u', role: 'user', content: 'pregunta' }, ...(text ? [{ id, role: 'assistant', content: text }] : [])] });

for (const row of official.rows) {
  test(`salida BPE contra referencia OpenAI: ${row.model} / ${row.case}`, () => {
    const ledger = new VisibleOutputTokens(), record = {};
    ledger.set(record, row.text, row.model, host);
    assert.equal(record.visibleMeasurement.encoding, row.encoding);
    assert.equal(ledger.totals.outputBpeTokens, row.official);
    assert.equal(ledger.totals.unknownOutputMessages, 0);
  });
}

test('entrada auto se completa con modelo real de SU respuesta sin sumar otro mensaje', () => {
  const e = engine(), text = '  Hola, mundo.  ';
  send(e, 'm1', 'auto', text);
  assert.equal(e.stats().unknownInputMessages, 1);
  close(e, 'Respuesta 😊', 'm1', 'gpt-5');
  assert.equal(e.stats().messages, 1);
  assert.equal(e.stats().unknownInputMessages, 0);
  assert.equal(e.stats().inputTokens, countGptTokens(text, 'gpt-5'));
  assert.equal(e.stats().outputBpeTokens, countGptTokens('Respuesta 😊', 'gpt-5'));
  assert.equal(e.inputRecords.get('1|m1').tokenText, undefined, 'no retiene otra copia después de resolver');
});

test('parciales acumulados se reemplazan: BPE no se suma por fragmento ni por palabra', () => {
  const e = engine(); send(e);
  for (const text of ['  H', '  Hola', '  Hola, mundo.  ', '  👩🏽‍💻\n']) {
    e.onStreamProgress(1, { messageId: 'm1', host, text, cumulative: true });
    assert.equal(e.stats().outputBpeTokens, countGptTokens(text, 'gpt-5'));
    assert.equal(e.stats().responses, 0);
  }
  close(e, '  👩🏽‍💻\n'); close(e, '  👩🏽‍💻\n');
  assert.equal(e.stats().responses, 1);
  assert.equal(e.stats().outputBpeTokens, countGptTokens('  👩🏽‍💻\n', 'gpt-5'));
  assert.equal(e.stats().bpeOutputMessages, 1);
});

test('texto literal de Memoria/DOM sustituye Markdown de red y admite corrección descendente', () => {
  const e = engine(); send(e);
  e.onStreamProgress(1, { messageId: 'm1', host, text: '**Hola** mundo', model: 'gpt-5', cumulative: true });
  e.onRenderedConversation(1, snapshot('Hola mundo'), snapshot(''));
  assert.equal(e.stats().outputBpeTokens, countGptTokens('Hola mundo', 'gpt-5'));
  close(e, '**Hola** mundo');
  e.onRenderedConversation(1, snapshot('Hola', false), snapshot('Hola mundo'));
  assert.equal(e.stats().outputBpeTokens, countGptTokens('Hola', 'gpt-5'));
  assert.equal(e.stats().responses, 1);
  assert.equal(e.stats().bpeOutputMessages, 1);
});

test('abrir historial no cuenta respuestas antiguas; no depende de persistencia EVO', () => {
  const e = engine(); e.store.settings.memory.enabled = false;
  e.onRenderedConversation(1, snapshot('historial'), null);
  assert.equal(e.stats().outputBpeTokens, 0);
  send(e);
  e.onRenderedConversation(1, snapshot('  respuesta\n', false), snapshot(''));
  assert.equal(e.stats().outputBpeTokens, countGptTokens('  respuesta\n', 'gpt-5'));
  assert.equal(e.stats().responses, 1);
});

test('modelo tardío actualiza salida ya recibida y entrada, sin duplicar respuesta', () => {
  const e = engine(); send(e, 'm1', 'auto');
  close(e, '  Hola, mundo.  ', 'm1', '');
  assert.equal(e.stats().unknownOutputMessages, 1);
  e.onCdpCapture(1, { messageId: 'm1', text: '  Hola, mundo.  ', host, site: 'chatgpt', model: 'gpt-5' });
  assert.equal(e.stats().responses, 1);
  assert.equal(e.stats().unknownOutputMessages, 0);
  assert.equal(e.stats().outputBpeTokens, countGptTokens('  Hola, mundo.  ', 'gpt-5'));
  assert.equal(e.stats().unknownInputMessages, 0);
});

test('red sin texto y recuperación posterior transfieren cobertura sin duplicar', () => {
  const e = engine(); send(e); e.onNetworkResponse(1, { host });
  assert.equal(e.stats().responses, 1); assert.equal(e.stats().unknownOutputMessages, 1);
  close(e, '\ttexto 👩🏽‍💻\r\n');
  assert.equal(e.stats().responses, 1); assert.equal(e.stats().unknownOutputMessages, 0);
  assert.equal(e.stats().bpeOutputMessages, 1);
  assert.equal(e.stats().outputBpeTokens, countGptTokens('\ttexto 👩🏽‍💻\r\n', 'gpt-5'));
});

test('dos respuestas legítimas idénticas mantienen dos aportes BPE', () => {
  const e = engine();
  send(e, 'm1'); close(e, 'igual', 'm1');
  send(e, 'm2'); close(e, 'igual', 'm2');
  assert.equal(e.stats().messages, 2); assert.equal(e.stats().responses, 2);
  assert.equal(e.stats().outputBpeTokens, 2 * countGptTokens('igual', 'gpt-5'));
});

test('modelo desconocido no se disfraza de cero ni se inventa encoding', () => {
  const e = engine(); send(e, 'm1', 'gpt-6'); close(e, 'texto', 'm1', 'gpt-6');
  const stats = e.stats(), view = tokenCounterView(stats);
  assert.equal(stats.inputTokens, 0); assert.equal(stats.outputBpeTokens, 0);
  assert.equal(stats.unknownInputMessages, 1); assert.equal(stats.unknownOutputMessages, 1);
  assert.equal(view.input, '—'); assert.equal(view.output, '—');
});

test('estimaciones de otros proveedores se mantienen separadas del BPE visible', () => {
  const ledger = new VisibleOutputTokens(), record = {};
  ledger.set(record, 'respuesta estimada', 'claude', 'claude.ai');
  assert.equal(ledger.totals.outputBpeTokens, 0);
  assert.ok(ledger.totals.estimatedOutputTokens > 0);
  assert.equal(tokenCounterView(ledger.totals).output, '—');
  const view = tokenCounterView({ inputTokens: 12, messages: 2, unknownInputMessages: 1,
    outputBpeTokens: 8, bpeOutputMessages: 1, unknownOutputMessages: 1 });
  assert.equal(view.input, '12 + ?'); assert.equal(view.output, '8 + ?');
});

test('contrato UI: nombres solicitados y zoom únicamente dentro de Ajustes', () => {
  const html = readFileSync(new URL('../src/ui/shell/index.html', import.meta.url), 'utf8');
  assert.match(html, /Tokens de entrada de usuario/); assert.match(html, /Tokens de respuesta IA/);
  assert.doesNotMatch(html, /tokens BPE · texto usuario|header-zoom|floating-zoom/);
  const settings = html.slice(html.indexOf('id="panel-settings"'));
  assert.match(settings, /class="ui-zoom settings-zoom"/);
  assert.equal((html.match(/data-ui-zoom-value/g) || []).length, 1);
});

test('interrumpir un parcial para enviar otra pregunta conserva el BPE ya visible', () => {
  const e = engine(); send(e, 'm1');
  e.onStreamProgress(1, { messageId: 'm1', host, model: 'gpt-5', text: 'parcial' });
  send(e, 'm2');
  e.onStreamProgress(1, { messageId: 'm2', host, model: 'gpt-5', text: 'nuevo' });
  assert.equal(e.stats().outputBpeTokens, countGptTokens('parcial', 'gpt-5') + countGptTokens('nuevo', 'gpt-5'));
});

test('repetir un cierre viejo tras siete respuestas no vuelve a aportar BPE', () => {
  const e = engine();
  for (let i = 0; i < 8; i++) { send(e, `m${i}`); close(e, `respuesta ${i}`, `m${i}`); }
  const before = e.stats().outputBpeTokens;
  close(e, 'respuesta 0', 'm0');
  assert.equal(e.stats().outputBpeTokens, before);
  assert.equal(e.stats().responses, 8);
});
