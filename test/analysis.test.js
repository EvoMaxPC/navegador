import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  analyzeTail,
  detectTruncation,
  lineLoop,
  prefixFunction,
  repeatingSuffix,
  tokenStutter,
} from '../src/core/analysis.js';
import {
  CLEAN_ANSWER,
  LINE_LOOP_ANSWER,
  LOOPING_ANSWER,
  PARAGRAPH,
  STUTTER_ANSWER,
  TRUNCATED_ANSWER,
} from './fixtures.js';

test('prefixFunction calcula bordes correctamente', () => {
  assert.deepEqual([...prefixFunction('ababaca')], [0, 0, 1, 2, 3, 0, 1]);
  assert.deepEqual([...prefixFunction('aaaa')], [0, 1, 2, 3]);
});

test('repeatingSuffix encuentra el período mínimo de un sufijo repetido', () => {
  const text = `Introducción distinta. ${PARAGRAPH}${PARAGRAPH}`;
  const found = repeatingSuffix(text.toLowerCase(), { minUnit: 40, minRepeats: 2 });
  assert.ok(found, 'debería detectar repetición');
  assert.equal(found.repeats, 2);
  assert.ok(found.unit.length > 100);
});

test('repeatingSuffix no inventa bucles en texto normal', () => {
  assert.equal(repeatingSuffix(CLEAN_ANSWER.toLowerCase(), { minUnit: 40 }), null);
});

test('analyzeTail detecta el párrafo repetido del fixture', () => {
  const result = analyzeTail(LOOPING_ANSWER);
  assert.equal(result.loop, true);
  assert.equal(result.type, 'repeat-unit');
  assert.ok(['medium', 'high'].includes(result.severity));
  assert.ok(result.detail.start > 0, 'el corte debe apuntar al inicio de la repetición');
});

test('analyzeTail no marca una respuesta limpia', () => {
  const result = analyzeTail(CLEAN_ANSWER);
  assert.equal(result.loop, false);
});

test('tokenStutter detecta tartamudeo de una palabra', () => {
  const stutter = tokenStutter(STUTTER_ANSWER.split(/\s+/), { minRepeats: 5 });
  assert.ok(stutter);
  assert.equal(stutter.token, 'la');
  assert.ok(stutter.repeats >= 5);
});

test('analyzeTail clasifica el tartamudeo como bucle de alta severidad', () => {
  const result = analyzeTail(STUTTER_ANSWER);
  assert.equal(result.loop, true);
  assert.equal(result.type, 'stutter');
  assert.equal(result.severity, 'high');
});

test('lineLoop detecta listas que se reescriben', () => {
  const loop = lineLoop(LINE_LOOP_ANSWER);
  assert.ok(loop);
  assert.ok(loop.repeats >= 3);
});

test('detectTruncation detecta bloques de código abiertos', () => {
  const res = detectTruncation('Mira:\n```js\nconst a = 1;\n');
  assert.equal(res.truncated, true);
  assert.equal(res.reason, 'code-fence-open');
});

test('detectTruncation detecta frase cortada', () => {
  const res = detectTruncation(TRUNCATED_ANSWER);
  assert.equal(res.truncated, true);
});

test('detectTruncation no marca texto terminado', () => {
  assert.equal(detectTruncation(CLEAN_ANSWER).truncated, false);
});

test('analyzeTail respeta el umbral de unidad mínima', () => {
  const shortRepeat = 'hola mundo. hola mundo. hola mundo.';
  const res = analyzeTail(shortRepeat, { policy: { minUnit: 48 } });
  assert.equal(res.loop, false, 'una frase corta repetida no debe cortar la generación');
});
