import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildMemoryCard, planBudget, scoreSentence } from '../src/core/compaction.js';
import { LONG_HISTORY } from './fixtures.js';

test('la puntuación detecta decisiones y restricciones', () => {
  const decision = scoreSentence('Decidimos usar pg_dump con el flag --no-owner para la migración.');
  const trivia = scoreSentence('Buenos días.');
  assert.ok(decision.score > trivia.score);
  assert.ok(decision.kinds.includes('decision'));
});

test('la tarjeta agrupa por tipo y conserva lo importante', () => {
  const card = buildMemoryCard(LONG_HISTORY, { maxChars: 900 });
  assert.ok(card.card.includes('Decisiones:'));
  assert.ok(card.card.includes('Pendientes:'));
  assert.ok(/PostgreSQL|--no-owner/.test(card.card));
  assert.ok(card.card.length <= 900);
});

test('la tarjeta deduplica oraciones repetidas', () => {
  const repeated = [
    { role: 'user', content: 'Decidimos usar PostgreSQL 16. Decidimos usar PostgreSQL 16.' },
    { role: 'assistant', content: 'Decidimos usar PostgreSQL 16.' },
  ];
  const card = buildMemoryCard(repeated);
  const count = (card.card.match(/PostgreSQL 16/g) || []).length;
  assert.equal(count, 1);
});

test('planBudget no toca nada si entra en presupuesto', () => {
  const plan = planBudget(LONG_HISTORY.slice(0, 2), { budgetTokens: 8000 });
  assert.equal(plan.fold.length, 0);
  assert.equal(plan.card, null);
});

test('planBudget pliega los turnos antiguos y conserva los recientes', () => {
  const plan = planBudget(LONG_HISTORY, { budgetTokens: 120, keepRecent: 3 });
  assert.ok(plan.fold.length > 0);
  assert.ok(plan.keep.length >= 3);
  assert.equal(plan.fold.length + plan.keep.length, LONG_HISTORY.length);
  assert.ok(plan.tokensAfter < plan.tokensBefore);
  // Los últimos turnos se mantienen literales.
  assert.equal(plan.keep.at(-1).content, LONG_HISTORY.at(-1).content);
});

test('planBudget nunca deja fuera el último turno', () => {
  const plan = planBudget(LONG_HISTORY, { budgetTokens: 10, keepRecent: 1 });
  assert.ok(plan.keep.some((t) => t.content === LONG_HISTORY.at(-1).content));
});
