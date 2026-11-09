import assert from 'node:assert/strict';
import test from 'node:test';
import { countOutputTokens, countTokensForProvider } from '../src/main/tokens.js';
import { estimateTokens } from '../src/core/text.js';

for (const [text, expected] of [
  ['', 0], ['  \n\t', 0], ['... ** ✅', 0], [null, 0], [undefined, 0], [42, 0],
  ['Hola', 1], ['Hola mundo', 2], ['Hola mundo otra', 3], ['Hola mundo otra palabra', 4],
  ['uno\n dos\t tres', 3], ['¡Hola,mundo! ¿Cómo estás?', 4],
  ['Árbol café a\u0301rbol 2026', 4], ["don't l’amour", 2],
  ['sol extraordinariamente', 2], ['sol sol', 2],
]) {
  test(`estimación de salida por palabras: ${JSON.stringify(text)} → ${expected}`, () => {
    assert.equal(countOutputTokens(text), expected);
  });
}

test('la estimación por palabras no cambia el presupuesto de entrada de otros sitios', () => {
  const text = 'extraordinariamente largo';
  assert.equal(countTokensForProvider(text, '', 'claude'), estimateTokens(text));
  assert.equal(countOutputTokens(text), 2);
});
