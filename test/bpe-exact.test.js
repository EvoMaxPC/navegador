import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  countGptTokens,
  encodeGptText,
  encodingForModel,
} from '../src/core/gptTokens.cjs';
import { inputTokenMeasurement } from '../src/main/tokens.js';
import { Engine } from '../src/main/engine.js';
import { DEFAULT_SETTINGS } from '../src/core/settings.js';
import { fingerprint } from '../src/core/text.js';
const reference = JSON.parse(
  readFileSync(
    new URL('../docs/BPE-OFICIAL-COMPARACION.json', import.meta.url),
    'utf8',
  ),
);
for (const row of reference.rows) {
  test(`OpenAI tiktoken ${row.encoding} / ${row.model} / ${row.case}: IDs y longitud exactos`, () => {
    assert.equal(encodingForModel(row.model), row.encoding);
    assert.deepEqual(encodeGptText(row.text, row.model), row.officialIds);
    assert.equal(countGptTokens(row.text, row.model), row.official);
    assert.equal(
      countGptTokens(row.text, row.model),
      encodeGptText(row.text, row.model).length,
    );
  });
}
test('texto original estricto: tipo, cadena vacía, NFC/NFD y modelo desconocido sin fallback', () => {
  for (const value of [null, undefined, 42, {}, ['hola']])
    assert.throws(() => countGptTokens(value, 'gpt-5'), TypeError);
  assert.equal(countGptTokens('', 'gpt-5'), 0);
  for (const model of [
    '',
    'auto',
    'claude-3',
    'auto',
  ]) {
    assert.equal(countGptTokens(' texto ', model), null);
    assert.equal(
      inputTokenMeasurement(' texto ', model, 'chatgpt').tokenExact,
      false,
    );
  }
  for (const [model, expectedModel] of [
    ['gpt-6', 'gpt-5'],
    ['gpt-5-desconocido', 'gpt-5'],
    ['gpt-4.1-inventado', 'gpt-4.1'],
    ['GPT-5', 'gpt-5'],
  ]) {
    const result = inputTokenMeasurement(' texto ', model, 'chatgpt');
    assert.equal(result.tokens, countGptTokens(' texto ', expectedModel));
    assert.equal(result.tokenModel, expectedModel);
    assert.equal(result.tokenMethod, model === 'GPT-5' ? 'bpe-original' : 'bpe-nearest-model');
  }
  assert.notDeepEqual(
    encodeGptText('café', 'gpt-5'),
    encodeGptText('cafe\u0301', 'gpt-5'),
  );
});
const engine = () =>
  new Engine({
    store: { settings: structuredClone(DEFAULT_SETTINGS), pushLog() {} },
  });
const measurement = (text, model = 'gpt-5') =>
  inputTokenMeasurement(text, model, 'chatgpt');
function send(
  e,
  id,
  source,
  submissionId,
  text = '  Mismo texto 👩🏽‍💻\t\n',
  model = 'gpt-5',
) {
  return e.onUserMessage(1, {
    messageId: id,
    source,
    submissionId,
    host: 'chatgpt.com',
    chars: text.length,
    promptHash: fingerprint(text),
    ...measurement(text, model),
  });
}
for (const sources of [
  ['network', 'request', 'cdp'],
  ['cdp', 'network', 'request'],
  ['request', 'network', 'cdp'],
]) {
  test(`tres observadores un envío; orden ${sources.join(' → ')}`, () => {
    const e = engine();
    sources.forEach((source, i) =>
      assert.equal(send(e, `obs-${i}`, source, 'user-1').duplicate, i > 0),
    );
    const stats = e.stats();
    assert.equal(stats.messages, 1);
    assert.equal(
      stats.inputTokens,
      countGptTokens('  Mismo texto 👩🏽‍💻\t\n', 'gpt-5'),
    );
  });
}
test('dos envíos legítimos idénticos con IDs distintos, fuentes alternadas y avisos atrasados', () => {
  const e = engine();
  send(e, 'net-a', 'network', 'user-a');
  send(e, 'page-b', 'request', 'user-b');
  send(e, 'cdp-b', 'cdp', 'user-b');
  send(e, 'cdp-a', 'cdp', 'user-a');
  send(e, 'page-a', 'request', 'user-a');
  send(e, 'net-b', 'network', 'user-b');
  assert.equal(e.stats().messages, 2);
  assert.equal(
    e.stats().inputTokens,
    2 * countGptTokens('  Mismo texto 👩🏽‍💻\t\n', 'gpt-5'),
  );
});
test('misma fuente y texto con IDs de envío distintos nunca se deduplican por el contenido', () => {
  const e = engine();
  for (let i = 0; i < 3; i++) send(e, `net-${i}`, 'network', `user-${i}`);
  assert.equal(e.stats().messages, 3);
});
test('modelo primero desconocido se completa por red sin sumar otro mensaje o duplicar tokens', () => {
  const e = engine();
  send(e, 'gesture', 'composer', '', '  Hola  ', '');
  assert.equal(e.stats().unknownInputMessages, 1);
  assert.equal(e.stats().inputTokens, 0);
  send(e, 'request', 'network', 'user-1', '  Hola  ', 'gpt-5');
  send(e, 'cdp', 'cdp', 'user-1', '  Hola  ', 'gpt-5');
  assert.equal(e.stats().messages, 1);
  assert.equal(e.stats().unknownInputMessages, 0);
  assert.equal(e.stats().inputTokens, countGptTokens('  Hola  ', 'gpt-5'));
});
test('categorías de input no mezclan BPE, estimación, desconocidos ni facturación', () => {
  const e = engine();
  send(e, 'exact', 'network', 'u1', 'Hola');
  e.onUserMessage(2, {
    messageId: 'claude',
    source: 'network',
    ...inputTokenMeasurement('Hola', '', 'claude'),
  });
  send(e, 'unknown', 'network', 'u3', 'Hola', 'auto');
  const s = e.stats();
  assert.equal(s.inputTokens, countGptTokens('Hola', 'gpt-5'));
  assert.ok(s.estimatedInputTokens > 0);
  assert.equal(s.unknownInputMessages, 1);
  assert.equal(s.hiddenContextTokens, null);
  assert.equal(s.providerBilledTokens, null);
});

test('correlación sin ID compartido se declara no verificada, no se promete unicidad', () => {
  const e = engine();
  send(e, 'network-a', 'network', 'u1', 'Hola');
  send(e, 'anonymous-observer', 'cdp', '', 'Hola');
  assert.equal(e.stats().inputCorrelationUnverified, 1);
  const identified = engine();
  send(identified, 'network-a', 'network', 'u1', 'Hola');
  send(identified, 'cdp-a', 'cdp', 'u1', 'Hola');
  assert.equal(identified.stats().inputCorrelationUnverified, 0);
});
