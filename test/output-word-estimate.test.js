import assert from 'node:assert/strict';
import test from 'node:test';
import { countOutputTokens, countTokensForProvider } from '../src/main/tokens.js';
import { estimateTokens } from '../src/core/text.js';

for (const [text, expected] of [
  ['', 0], ['  \n\t', 0], ['... ** ✅', 0], [null, 0], [undefined, 0], [42, 0],
  ['Hola', 2], ['Hola mundo', 3], ['Hola mundo otra', 4], ['Hola mundo otra palabra', 6],
  ['uno\n dos\t tres', 4], ['¡Hola,mundo! ¿Cómo estás?', 6],
  ['Árbol café a\u0301rbol 2026', 6], ["don't l’amour", 3],
  ['sol extraordinariamente', 3], ['sol sol', 3],
]) {
  test(`estimación de salida por palabras: ${JSON.stringify(text)} → ${expected}`, () => {
    assert.equal(countOutputTokens(text), expected);
  });
}

test('la estimación por palabras no cambia el presupuesto de entrada de otros sitios', () => {
  const text = 'extraordinariamente largo';
  assert.equal(countTokensForProvider(text, '', 'claude'), estimateTokens(text));
  assert.equal(countOutputTokens(text), 3);
});
