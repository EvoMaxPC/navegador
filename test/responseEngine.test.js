import assert from 'node:assert/strict';
import { test } from 'node:test';

import { recoverySuggestions, repairResponse } from '../src/core/responseEngine.js';
import { CLEAN_ANSWER, REFUSAL_ANSWER } from './fixtures.js';

test('una respuesta limpia pasa sin cambios ni marcas', () => {
  const res = repairResponse(CLEAN_ANSWER);
  assert.equal(res.text.trim(), CLEAN_ANSWER.trim());
  assert.equal(res.fixes.length, 0);
  assert.equal(res.refusal, false);
});

test('elimina tokens de plantilla filtrados', () => {
  const res = repairResponse('Claro, te explico.\n<|im_end|>');
  assert.ok(!res.text.includes('<|im_end|>'));
  assert.ok(res.fixes.some((f) => f.id === 'leaked-tokens'));
});

test('cierra bloques de código abiertos y marca truncamiento', () => {
  const res = repairResponse('```python\nprint("hola")\n');
  assert.ok(res.text.trimEnd().endsWith('```'));
  assert.ok(res.fixes.some((f) => f.id === 'close-fence'));
  assert.equal(res.truncated, true);
});

test('quita el prefijo "Assistant:"', () => {
  const res = repairResponse('Assistant: La respuesta es 42.');
  assert.ok(res.text.startsWith('La respuesta'));
  assert.ok(res.fixes.some((f) => f.id === 'strip-role-prefix'));
});

test('elimina el párrafo final duplicado', () => {
  const body = 'Primer párrafo con contenido suficiente para contar como bloque real.';
  const res = repairResponse(`${body}\n\n${body}`);
  assert.equal((res.text.match(/Primer párrafo/g) || []).length, 1);
  assert.ok(res.fixes.some((f) => f.id === 'duplicate-tail'));
});

test('detecta negativas del modelo y propone reformular', () => {
  const res = repairResponse(REFUSAL_ANSWER);
  assert.equal(res.refusal, true);
  const tips = recoverySuggestions(res, 'es');
  assert.ok(tips.some((t) => t.action === 'rephrase'));
});

test('una respuesta vacía pide regenerar', () => {
  const res = repairResponse('   ');
  assert.equal(res.empty, true);
  const tips = recoverySuggestions(res, 'es');
  assert.ok(tips.some((t) => t.action === 'regenerate'));
});

test('marca corte a mitad de frase', () => {
  const res = repairResponse('La configuración requiere el host, el puerto y');
  assert.equal(res.truncated, true);
  assert.ok(res.needsContinue);
});

test('normaliza espaciado y líneas en blanco', () => {
  const res = repairResponse('Título\n\n\n\nCuerpo con   espacios   de más   ');
  assert.ok(!/\n{3,}/.test(res.text));
  assert.ok(!/[ \t]+$/m.test(res.text));
});

test('detecta vocabulario degenerado en respuestas largas', () => {
  const repetitive = Array.from({ length: 60 }, () => 'sistema sistema sistema').join(' ');
  const res = repairResponse(repetitive);
  assert.ok(res.fixes.some((f) => f.id === 'low-diversity'));
});
