import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cleanPrompt, detectContradictions, enhancePrompt, stripNexoBlocks } from '../src/core/promptEngine.js';
import { LONG_HISTORY, MESSY_PROMPT } from './fixtures.js';

test('limpia espacios y elimina líneas duplicadas', () => {
  const { text, findings } = cleanPrompt(MESSY_PROMPT);
  assert.equal((text.match(/expliques el plan de migración/g) || []).length, 1);
  assert.equal((text.match(/ {3,}/g) || []).length, 0);
  assert.ok(findings.some((f) => f.id === 'dedupe-lines'));
});

test('no deduplica líneas dentro de bloques de código', () => {
  const prompt = [
    'Revisá este código:',
    '```js',
    'if (a) {',
    '  return 1;',
    '}',
    'if (b) {',
    '  return 1;',
    '}',
    '```',
    '¿Está bien?',
  ].join('\n');
  const { text } = cleanPrompt(prompt);
  assert.equal((text.match(/return 1;/g) || []).length, 2);
});

test('detecta instrucciones contradictorias', () => {
  const found = detectContradictions('Quiero una respuesta breve pero muy detallada paso a paso.');
  assert.ok(found.some((f) => f.id === 'contradiction-length'));
});

test('no marca contradicciones donde no las hay', () => {
  assert.deepEqual(detectContradictions('Explica el flujo de autenticación con un ejemplo.'), []);
});

test('inyecta el protocolo antes del texto del usuario', () => {
  const report = enhancePrompt({ prompt: 'Explica cómo funciona un índice invertido.' });
  assert.equal(report.changed, true);
  assert.ok(report.enhanced.includes('[Protocolo de continuidad · Nexo]'));
  assert.ok(report.enhanced.trimEnd().endsWith('Explica cómo funciona un índice invertido.'));
  assert.ok(report.stats.injectedTokens > 0);
});

test('la posición del protocolo se puede cambiar a sufijo', () => {
  const report = enhancePrompt({
    prompt: 'Explica el patrón repository.',
    settings: { protocol: { placement: 'suffix' } },
  });
  assert.ok(report.enhanced.startsWith('Explica el patrón repository.'));
  assert.ok(report.enhanced.includes('[Protocolo de continuidad · Nexo]'));
});

test('el protocolo se puede desactivar por completo', () => {
  const report = enhancePrompt({
    prompt: 'Hola',
    settings: { protocol: { level: 'off' } },
  });
  assert.equal(report.enhanced, 'Hola');
  assert.equal(report.blocks.length, 0);
});

test('detecta referencia sin antecedente y añade aclaración', () => {
  const report = enhancePrompt({ prompt: 'hazlo', history: [] });
  assert.ok(report.findings.some((f) => f.id === 'ambiguity-no-context'));
  assert.ok(report.blocks.some((b) => b.id === 'clarifier'));
});

test('no añade aclaración cuando la referencia sí tiene antecedente claro', () => {
  const report = enhancePrompt({
    prompt: 'continúa con el paso 3',
    history: [
      { role: 'user', content: 'Pasos para migrar la base de datos: 1) dump 2) restaurar 3) validar' },
      { role: 'assistant', content: 'Vamos con el paso 1: ejecutá pg_dump con --no-owner.' },
    ],
  });
  assert.ok(!report.blocks.some((b) => b.id === 'clarifier'));
});

test('pliega el historial largo en una tarjeta de memoria', () => {
  const report = enhancePrompt({
    prompt: '¿Qué falta para terminar?',
    history: LONG_HISTORY,
    settings: { context: { budgetTokens: 120, keepRecentTurns: 3 } },
  });
  assert.ok(report.context, 'debería haber compactado el contexto');
  assert.ok(report.context.foldedTurns > 0);
  assert.ok(report.context.tokensAfter < report.context.tokensBefore);
  assert.ok(report.enhanced.includes('[Memoria de la conversación · Nexo]'));
  assert.ok(/PostgreSQL|pendiente|restricción/i.test(report.context.card));
});

test('no compacta si el historial entra en el presupuesto', () => {
  const report = enhancePrompt({
    prompt: 'Seguimos',
    history: LONG_HISTORY.slice(0, 2),
    settings: { context: { budgetTokens: 20000 } },
  });
  assert.equal(report.context, null);
});

test('etiqueta bloques pegados enormes', () => {
  const huge = 'x'.repeat(2600);
  const report = enhancePrompt({ prompt: `${huge}\n\n¿Qué opinas?` });
  assert.ok(report.enhanced.includes('[Texto pegado por el usuario'));
});

test('stripNexoBlocks recupera el texto del usuario', () => {
  const report = enhancePrompt({ prompt: 'Analiza este diseño de API.' });
  const back = stripNexoBlocks(report.enhanced);
  assert.equal(back.trim(), 'Analiza este diseño de API.');
});

test('respeta la desactivación global', () => {
  const report = enhancePrompt({ prompt: 'Hola', settings: { enabled: false } });
  assert.equal(report.skipped, true);
  assert.equal(report.enhanced, 'Hola');
});
