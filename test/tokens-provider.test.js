import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countTokensForProvider, countGptTokens } from '../src/main/tokens.js';

test('el texto de una respuesta ChatGPT nunca queda en cero', () => {
  const text = 'Esta es una respuesta de prueba de ChatGPT con acentos: información, análisis y solución.';
  const tokens = countTokensForProvider(text, 'gpt-5', 'chatgpt.com');
  assert.ok(Number.isFinite(tokens));
  assert.ok(tokens > 0);
});

test('los proveedores GPT se reconocen por modelo aunque falte el host', () => {
  const text = 'The assistant generated this response.';
  assert.equal(
    countTokensForProvider(text, 'gpt-4o', ''),
    countGptTokens(text, 'gpt-4o'),
  );
});

test('el contador mantiene el cero sólo para una respuesta realmente vacía', () => {
  assert.equal(countTokensForProvider('', 'gpt-5', 'chatgpt.com'), 0);
});
